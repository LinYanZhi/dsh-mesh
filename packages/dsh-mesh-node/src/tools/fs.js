import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { isInsideRoots } from '../core/config.js'
import { clip, sha256 } from '../core/util.js'
import { denied, invalidArg, internal, notFound, ok } from '../core/result.js'

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  'target',
  '.idea',
  '.vscode'
])

function resolveGuarded(rawPath, config) {
  const abs = resolve(rawPath)
  const allowed = config.acl?.fsRoots || []
  if (!isInsideRoots(abs, allowed)) {
    return { error: denied(`path is outside the allowed fsRoots: ${abs}`, { fsRoots: allowed }) }
  }
  if (!existsSync(abs)) return { error: notFound(`path not found: ${abs}`) }
  return { abs }
}

function statEntry(abs, name) {
  const st = lstatSync(abs)
  return {
    name,
    type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file',
    sizeBytes: st.isDirectory() ? null : st.size,
    mtimeMs: Math.round(st.mtimeMs)
  }
}

function walkFiles(root, { maxFiles = 400, maxDepth = 8 } = {}) {
  const out = []
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length > 0 && out.length < maxFiles) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (depth + 1 > maxDepth) continue
        stack.push({ dir: full, depth: depth + 1 })
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  return out
}

function extKey(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : '(none)'
}

/**
 * Recursive aggregation over a tree. Returns only numbers, so a 40k-file tree
 * costs a few KB on the wire instead of a few hundred thousand tokens.
 * Never follows symlinks/junctions: a link is counted as one entry.
 */
function collectStats(root, { maxFiles, maxDepth, topDirs, topFiles, topExts, skipVendor }) {
  const started = Date.now()
  const dirBytes = new Map()
  const dirFileCount = new Map()
  const allDirs = new Set()
  const rootFiles = []
  const ext = new Map()
  const largest = []
  let files = 0
  let dirs = 0
  let symlinks = 0
  let bytes = 0
  let symlinkBytes = 0
  let truncated = false

  const pushLargest = (item, limit) => {
    if (limit <= 0) return
    if (largest.length >= limit && item.sizeBytes <= largest[largest.length - 1].sizeBytes) return
    if (largest.length < limit) largest.push(item)
    else largest[largest.length - 1] = item
    largest.sort((a, b) => b.sizeBytes - a.sizeBytes)
  }

  const addToAncestors = (rel, size) => {
    let cut = rel.lastIndexOf('/')
    while (cut > 0) {
      const dir = rel.slice(0, cut)
      dirBytes.set(dir, (dirBytes.get(dir) || 0) + size)
      dirFileCount.set(dir, (dirFileCount.get(dir) || 0) + 1)
      cut = dir.lastIndexOf('/')
    }
  }

  const stack = [{ abs: root, rel: '', depth: 0 }]
  while (stack.length > 0) {
    const { abs, rel, depth } = stack.pop()
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(abs, entry.name)
      if (entry.isDirectory()) {
        if (skipVendor && SKIP_DIRS.has(entry.name)) continue
        dirs += 1
        allDirs.add(childRel)
        if (depth + 1 <= maxDepth) stack.push({ abs: full, rel: childRel, depth: depth + 1 })
        continue
      }
      if (entry.isSymbolicLink()) {
        symlinks += 1
        try {
          symlinkBytes += lstatSync(full).size
        } catch {
          /* broken link */
        }
        continue
      }
      if (!entry.isFile()) continue
      if (files >= maxFiles) {
        truncated = true
        break
      }
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      files += 1
      bytes += st.size
      addToAncestors(childRel, st.size)
      const key = extKey(entry.name)
      const bucket = ext.get(key) || { ext: key, files: 0, bytes: 0 }
      bucket.files += 1
      bucket.bytes += st.size
      ext.set(key, bucket)
      if (!childRel.includes('/')) rootFiles.push({ name: childRel, sizeBytes: st.size })
      pushLargest({ path: childRel, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) }, topFiles)
    }
    if (truncated) break
  }

  const emptyDirs = [...allDirs].filter((rel) => !dirFileCount.has(rel))
  const topLevel = [
    ...[...allDirs]
      .filter((rel) => !rel.includes('/'))
      .map((rel) => ({ name: rel, type: 'dir', sizeBytes: dirBytes.get(rel) || 0, fileCount: dirFileCount.get(rel) || 0 })),
    ...rootFiles.map((f) => ({ name: f.name, type: 'file', sizeBytes: f.sizeBytes, fileCount: 1 }))
  ].sort((a, b) => (a.type === b.type ? b.sizeBytes - a.sizeBytes : a.type === 'dir' ? -1 : 1))

  return {
    path: root,
    totals: {
      files,
      dirs,
      symlinks,
      bytes,
      symlinkBytes,
      emptyDirs: emptyDirs.length,
      maxFiles,
      maxDepth,
      truncated
    },
    topLevel,
    topDirs: [...allDirs]
      .map((rel) => ({ path: rel, sizeBytes: dirBytes.get(rel) || 0, fileCount: dirFileCount.get(rel) || 0 }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, topDirs),
    topFiles: largest.slice(0, topFiles),
    extStats: {
      distinct: ext.size,
      top: [...ext.values()].sort((a, b) => b.bytes - a.bytes).slice(0, topExts)
    },
    emptyDirs: { count: emptyDirs.length, sample: emptyDirs.slice(0, 20) },
    skippedVendor: skipVendor,
    elapsedMs: Date.now() - started
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
  return false
}

/** Read-only filesystem tools: fs_read / fs_list / fs_stat / fs_grep. */
export function buildFs(ctx) {
  return [
    {
      name: 'fs_read',
      title: 'Read a text file on the peer machine',
      description:
        'Read a UTF-8 text file on the peer machine. Only paths under the configured fsRoots are readable. Returns absolute path, size, sha256, total line count and content (optionally a 1-based line range). Use this instead of guessing file contents.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path on the peer machine.'),
        startLine: z.number().int().min(1).optional().describe('1-based first line to return (inclusive).'),
        endLine: z.number().int().min(1).optional().describe('1-based last line to return (inclusive).'),
        maxBytes: z.number().int().min(1).optional().describe('Byte budget for the returned content.')
      }),
      handler: async ({ path, startLine, endLine, maxBytes }, { signal } = {}) => {
        const config = ctx.getConfig()
        const g = resolveGuarded(path, config)
        if (g.error) return g.error
        const st = statSync(g.abs)
        if (!st.isFile()) return invalidArg(`not a regular file: ${g.abs}`)
        const budget = maxBytes ?? config.limits?.maxReadBytes ?? 262144
        const text = readFileSync(g.abs, 'utf8')
        const allLines = text.split(/\r?\n/)
        let selected = text
        let range = null
        if (startLine || endLine) {
          const from = Math.max(1, startLine ?? 1)
          const to = Math.max(from, Math.min(endLine ?? allLines.length, from + (config.limits?.maxLines ?? 4000)))
          selected = allLines.slice(from - 1, to).join('\n')
          range = { startLine: from, endLine: to }
        }
        const capped = clip(selected, budget)
        if (signal?.aborted) return denied('request cancelled')
        return ok({
          path: g.abs,
          sizeBytes: st.size,
          sha256: sha256(text),
          totalLines: allLines.length,
          range,
          returnedBytes: capped.bytes,
          truncated: capped.truncated,
          content: capped.text
        })
      }
    },
    {
      name: 'fs_list',
      title: 'List a directory on the peer machine',
      description:
        'List one directory on the peer machine (non-recursive by default). Returns entries with type/size/mtime, sorted directories first. Paths outside fsRoots are refused.',
      inputSchema: z.object({
        path: z.string().describe('Directory path on the peer machine.'),
        maxEntries: z.number().int().min(1).optional().describe('Cap on returned entries (default 500).'),
        includeHidden: z.boolean().optional().describe('Include dotfiles (default false).'),
        recursive: z.boolean().optional().describe('Walk subdirectories (bounded, skips node_modules/.git).')
      }),
      handler: async ({ path, maxEntries, includeHidden, recursive }) => {
        const config = ctx.getConfig()
        const g = resolveGuarded(path, config)
        if (g.error) return g.error
        const st = statSync(g.abs)
        if (!st.isDirectory()) return invalidArg(`not a directory: ${g.abs}`)
        const cap = Math.min(maxEntries ?? config.limits?.maxListEntries ?? 500, 5000)
        let entries = []
        if (recursive) {
          const files = walkFiles(g.abs, { maxFiles: cap })
          entries = files.map((f) => {
            const s = lstatSync(f)
            return {
              name: relative(g.abs, f).split(sep).join('/'),
              type: 'file',
              sizeBytes: s.size,
              mtimeMs: Math.round(s.mtimeMs)
            }
          })
          entries.sort((a, b) => a.name.localeCompare(b.name))
        } else {
          entries = readdirSync(g.abs, { withFileTypes: true })
            .filter((e) => includeHidden || !e.name.startsWith('.'))
            .map((e) => statEntry(join(g.abs, e.name), e.name))
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
        }
        return ok({
          path: g.abs,
          count: entries.length,
          truncated: entries.length >= cap,
          entries: entries.slice(0, cap)
        })
      }
    },
    {
      name: 'fs_stat',
      title: 'Stat a path on the peer machine',
      description:
        'Return metadata for a single path on the peer machine: type, size, timestamps, realpath and sha256 for small regular files.',
      inputSchema: z.object({ path: z.string().describe('Path on the peer machine.') }),
      handler: async ({ path }) => {
        const config = ctx.getConfig()
        const abs = resolve(path)
        const g = resolveGuarded(abs, config)
        if (g.error) return g.error
        const st = lstatSync(g.abs)
        let real = g.abs
        try {
          real = realpathSync(g.abs)
        } catch {
          /* keep abs */
        }
        let digest = null
        if (st.isFile() && st.size <= (config.limits?.maxReadBytes ?? 262144)) {
          digest = sha256(readFileSync(g.abs, 'utf8'))
        }
        return ok({
          path: g.abs,
          realpath: real,
          type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file',
          sizeBytes: st.size,
          mtimeMs: Math.round(st.mtimeMs),
          ctimeMs: Math.round(st.ctimeMs),
          isSymlink: st.isSymbolicLink(),
          basename: basename(g.abs),
          parent: dirname(g.abs),
          sha256: digest
        })
      }
    },
    {
      name: 'fs_stats',
      title: 'Aggregate directory sizes on the peer machine',
      description:
        'Walk a directory tree on the peer machine and return aggregated numbers only: totals, immediate children with recursive sizes, largest subdirectories, largest files and an extension histogram. Read-only and bounded. Use this for "how big is X / what is taking space" instead of recursive fs_list, which streams every file entry.',
      inputSchema: z.object({
        path: z.string().describe('Directory path on the peer machine (must be under fsRoots).'),
        maxFiles: z.number().int().min(1).optional().describe('Stop after this many files (default 200000, hard cap 1000000).'),
        maxDepth: z.number().int().min(1).max(64).optional().describe('Maximum directory depth to descend (default 24).'),
        topDirs: z.number().int().min(0).max(200).optional().describe('How many subdirectories by recursive size to return (default 15).'),
        topFiles: z.number().int().min(0).max(200).optional().describe('How many largest files to return (default 15).'),
        topExts: z.number().int().min(0).max(200).optional().describe('How many file extensions to return (default 15).'),
        skipVendor: z.boolean().optional().describe('Skip .git/node_modules/dist/build-style directories (default false).')
      }),
      handler: async ({ path, maxFiles, maxDepth, topDirs, topFiles, topExts, skipVendor }) => {
        const config = ctx.getConfig()
        const g = resolveGuarded(path, config)
        if (g.error) return g.error
        const st = lstatSync(g.abs)
        if (!st.isDirectory()) return invalidArg(`not a directory: ${g.abs}`)
        return ok(
          collectStats(g.abs, {
            maxFiles: Math.min(maxFiles ?? 200000, 1000000),
            maxDepth: maxDepth ?? 24,
            topDirs: Math.min(topDirs ?? 15, 200),
            topFiles: Math.min(topFiles ?? 15, 200),
            topExts: Math.min(topExts ?? 15, 200),
            skipVendor: Boolean(skipVendor)
          })
        )
      }
    },
    {
      name: 'fs_grep',
      title: 'Search file contents on the peer machine',
      description:
        'Search text files under a directory on the peer machine for a regular expression. Skips binary files and node_modules/.git/dist/build by default. Returns matching path, 1-based line number and the line text.',
      inputSchema: z.object({
        root: z.string().describe('Directory to search (must be under fsRoots).'),
        pattern: z.string().describe('JavaScript regular expression source, e.g. "TODO|FIXME".'),
        ignoreCase: z.boolean().optional(),
        include: z
          .string()
          .optional()
          .describe('Only search files whose path contains this substring, e.g. ".ts" or "docs/".'),
        maxFiles: z.number().int().min(1).optional().describe('Cap on scanned files (default 400).'),
        maxResults: z.number().int().min(1).optional().describe('Cap on returned matches (default 100).')
      }),
      handler: async ({ root, pattern, ignoreCase, include, maxFiles, maxResults }) => {
        const config = ctx.getConfig()
        const g = resolveGuarded(root, config)
        if (g.error) return g.error
        let re
        try {
          re = new RegExp(pattern, ignoreCase ? 'i' : '')
        } catch (error) {
          return invalidArg(`invalid regular expression: ${error.message}`)
        }
        const fileCap = Math.min(maxFiles ?? config.limits?.maxGrepFiles ?? 400, 5000)
        const resultCap = Math.min(maxResults ?? 100, 1000)
        const files = walkFiles(g.abs, { maxFiles: fileCap })
        const matches = []
        let scanned = 0
        for (const file of files) {
          if (matches.length >= resultCap) break
          if (include && !file.includes(include)) continue
          let buf
          try {
            buf = readFileSync(file)
          } catch {
            continue
          }
          scanned += 1
          if (looksBinary(buf)) continue
          const lines = buf.toString('utf8').split(/\r?\n/)
          for (let i = 0; i < lines.length && matches.length < resultCap; i += 1) {
            if (re.test(lines[i])) {
              matches.push({ path: file, line: i + 1, text: lines[i].slice(0, 500) })
            }
          }
        }
        return ok({
          root: g.abs,
          pattern,
          scannedFiles: scanned,
          scannedLimit: fileCap,
          matches: matches.length,
          truncated: matches.length >= resultCap,
          results: matches
        })
      }
    }
  ]
}
