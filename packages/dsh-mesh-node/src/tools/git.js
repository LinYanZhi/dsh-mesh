import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { isInsideRoots } from '../core/config.js'
import { clip, run } from '../core/util.js'
import { denied, invalidArg, notFound, ok } from '../core/result.js'

function guard(path, config) {
  const abs = resolve(path)
  if (!isInsideRoots(abs, config.acl?.fsRoots)) {
    return { error: denied(`path is outside the allowed fsRoots: ${abs}`, { fsRoots: config.acl?.fsRoots }) }
  }
  if (!existsSync(abs)) return { error: notFound(`path not found: ${abs}`) }
  return { abs }
}

async function repoRootOf(abs, { timeout, signal } = {}) {
  const top = await run('git', ['-C', abs, 'rev-parse', '--show-toplevel'], { timeout, signal })
  if (top.error || !top.stdout.trim()) return { error: top }
  const root = top.stdout.trim()
  try {
    return { root: realpathSync(root) }
  } catch {
    return { root }
  }
}

function countDirty(entries) {
  const counts = { staged: 0, modified: 0, untracked: 0, unmerged: 0 }
  for (const e of entries) {
    const x = e[0]
    const y = e[1]
    if (x === '?' && y === '?') counts.untracked += 1
    else if ('UAD'.includes(x) || 'UAD'.includes(y)) counts.unmerged += 1
    else if (x === ' ' && y !== ' ') counts.modified += 1
    else if (x !== ' ' && y === ' ') counts.staged += 1
    else if (x !== ' ' && y !== ' ') {
      counts.staged += 1
      counts.modified += 1
    }
  }
  return counts
}

async function repoSummary(abs, { timeout, signal, entries = 200 } = {}) {
  const found = await repoRootOf(abs, { timeout, signal })
  if (found.error) return null
  const root = found.root
  const [branch, head, upstream, status] = await Promise.all([
    run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout, signal }),
    run('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout, signal }),
    run('git', ['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeout, signal }),
    run('git', ['-C', root, 'status', '--porcelain=v1', '-b', '--untracked-files=normal'], { timeout, signal })
  ])
  let ahead = null
  let behind = null
  if (!upstream.error) {
    const counts = await run('git', ['-C', root, 'rev-list', '--left-right', '--count', '@{u}...HEAD'], {
      timeout,
      signal
    })
    if (!counts.error) {
      const [b, a] = counts.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10))
      behind = Number.isFinite(b) ? b : null
      ahead = Number.isFinite(a) ? a : null
    }
  }
  const lines = status.stdout.split(/\r?\n/).filter(Boolean)
  const branchLine = lines.find((l) => l.startsWith('## ')) || ''
  const statusEntries = lines.filter((l) => !l.startsWith('## '))
  return {
    root,
    name: basename(root),
    branch: branch.error ? null : branch.stdout.trim(),
    head: head.error ? null : head.stdout.trim(),
    upstream: upstream.error ? null : upstream.stdout.trim(),
    ahead,
    behind,
    statusBranchLine: branchLine,
    dirty: countDirty(statusEntries),
    entries: statusEntries.slice(0, entries),
    truncatedEntries: Math.max(0, statusEntries.length - entries)
  }
}

/** Discover git repositories under a directory (bounded depth). */
function findRepos(root, { depth = 2, maxRepos = 60 } = {}) {
  const found = []
  const stack = [{ dir: root, level: 0 }]
  while (stack.length > 0 && found.length < maxRepos) {
    const { dir, level } = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const names = new Set(entries.map((e) => e.name))
    if (names.has('.git')) {
      found.push(dir)
      continue
    }
    if (level >= depth) continue
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      stack.push({ dir: join(dir, entry.name), level: level + 1 })
    }
  }
  return found
}

/** Read-only git tools: git_status / git_log / git_diff / repo_scan. */
export function buildGit(ctx) {
  return [
    {
      name: 'git_status',
      title: 'Git status of a repository on the peer machine',
      description:
        'Run read-only git inspection on a repository on the peer machine: toplevel, current branch, HEAD sha, upstream, ahead/behind counts and porcelain status entries. Never mutates the repository.',
      inputSchema: z.object({ path: z.string().describe('Path inside the repository.') }),
      handler: async ({ path }, { signal } = {}) => {
        const config = ctx.getConfig()
        const g = guard(path, config)
        if (g.error) return g.error
        const timeout = config.limits?.gitTimeoutMs ?? 20000
        const summary = await repoSummary(g.abs, { timeout, signal })
        if (!summary) return invalidArg(`not a git repository: ${g.abs}`)
        return ok(summary)
      }
    },
    {
      name: 'git_log',
      title: 'Recent commits of a repository on the peer machine',
      description:
        'Return the most recent commits of a repository on the peer machine (sha, author, ISO date, subject). Read-only.',
      inputSchema: z.object({
        path: z.string().describe('Path inside the repository.'),
        limit: z.number().int().min(1).max(200).optional().describe('How many commits (default 20).'),
        ref: z.string().optional().describe('Optional revision range, e.g. "origin/main..HEAD".'),
        format: z.enum(['oneline', 'detail']).optional()
      }),
      handler: async ({ path, limit, ref, format }, { signal } = {}) => {
        const config = ctx.getConfig()
        const g = guard(path, config)
        if (g.error) return g.error
        const timeout = config.limits?.gitTimeoutMs ?? 20000
        const found = await repoRootOf(g.abs, { timeout, signal })
        if (found.error) return invalidArg(`not a git repository: ${g.abs}`)
        const n = Math.min(limit ?? 20, 200)
        const args = ['-C', found.root, 'log', `-n${n}`]
        if (format === 'detail') args.push('--date=iso-strict', '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s')
        else args.push('--date=short', '--pretty=format:%h%x09%ad%x09%s')
        if (ref) args.push(ref, '--')
        const out = await run('git', args, { timeout, signal })
        if (out.error) return invalidArg(`git log failed: ${out.stderr.trim().slice(0, 500)}`)
        const commits = out.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const parts = line.split('\t')
            return format === 'detail'
              ? { sha: parts[0], short: parts[1], author: parts[2], date: parts[3], subject: parts.slice(4).join('\t') }
              : { short: parts[0], date: parts[1], subject: parts.slice(2).join('\t') }
          })
        return ok({ root: found.root, ref: ref || null, count: commits.length, commits })
      }
    },
    {
      name: 'git_diff',
      title: 'Diff of a repository on the peer machine',
      description:
        'Return the current diff of a repository on the peer machine (working tree or staged), plus --stat summary. Read-only; optionally limit to one path and/or a revision.',
      inputSchema: z.object({
        path: z.string().describe('Path inside the repository.'),
        staged: z.boolean().optional().describe('Diff the index instead of the working tree.'),
        ref: z.string().optional().describe('Optional revision, e.g. HEAD or origin/main.'),
        file: z.string().optional().describe('Limit the diff to one path.'),
        maxBytes: z.number().int().min(1).optional()
      }),
      handler: async ({ path, staged, ref, file, maxBytes }, { signal } = {}) => {
        const config = ctx.getConfig()
        const g = guard(path, config)
        if (g.error) return g.error
        const timeout = config.limits?.gitTimeoutMs ?? 20000
        const found = await repoRootOf(g.abs, { timeout, signal })
        if (found.error) return invalidArg(`not a git repository: ${g.abs}`)
        const base = ['-C', found.root, 'diff']
        if (staged) base.push('--staged')
        if (ref) base.push(ref)
        const pathspec = file ? ['--', file] : []
        const statOut = await run('git', [...base, '--stat', ...pathspec], { timeout, signal })
        const diffOut = await run('git', [...base, ...pathspec], { timeout, signal })
        if (diffOut.error && diffOut.code !== 1) {
          return invalidArg(`git diff failed: ${diffOut.stderr.trim().slice(0, 500)}`)
        }
        const budget = maxBytes ?? config.limits?.maxDiffBytes ?? 131072
        const capped = clip(diffOut.stdout, budget)
        return ok({
          root: found.root,
          staged: Boolean(staged),
          ref: ref || null,
          file: file || null,
          stat: statOut.stdout.trim(),
          bytes: capped.bytes,
          truncated: capped.truncated,
          diff: capped.text
        })
      }
    },
    {
      name: 'repo_scan',
      title: 'Scan a directory tree for git repositories',
      description:
        'Find git repositories under a directory on the peer machine (bounded depth) and report each one: branch, HEAD, upstream, ahead/behind and dirty counts. Use this to answer "what is uncommitted / unpushed over here" in one call.',
      inputSchema: z.object({
        roots: z.array(z.string()).min(1).describe('Directories to scan (must be under fsRoots).'),
        depth: z.number().int().min(1).max(4).optional().describe('Directory depth to descend (default 2).'),
        maxRepos: z.number().int().min(1).max(200).optional().describe('Cap on repositories (default 60).'),
        dirtyOnly: z.boolean().optional().describe('Only return repositories with uncommitted changes or ahead>0.')
      }),
      handler: async ({ roots, depth, maxRepos, dirtyOnly }, { signal } = {}) => {
        const config = ctx.getConfig()
        const timeout = config.limits?.gitTimeoutMs ?? 20000
        const cap = Math.min(maxRepos ?? 60, 200)
        const targets = []
        for (const root of roots) {
          const abs = resolve(root)
          if (!isInsideRoots(abs, config.acl?.fsRoots)) {
            return denied(`root is outside the allowed fsRoots: ${abs}`, { fsRoots: config.acl?.fsRoots })
          }
          if (!existsSync(abs)) continue
          targets.push(...findRepos(abs, { depth: depth ?? 2, maxRepos: cap - targets.length }))
        }
        const repos = []
        let index = 0
        const worker = async () => {
          while (index < targets.length) {
            const dir = targets[index]
            index += 1
            const summary = await repoSummary(dir, { timeout, signal, entries: 20 })
            if (!summary) continue
            const dirtyCount =
              summary.dirty.staged + summary.dirty.modified + summary.dirty.untracked + summary.dirty.unmerged
            if (dirtyOnly && dirtyCount === 0 && !(summary.ahead > 0)) continue
            repos.push(summary)
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
        repos.sort((a, b) => a.root.localeCompare(b.root))
        const dirty = repos.filter(
          (r) => r.dirty.staged + r.dirty.modified + r.dirty.untracked + r.dirty.unmerged > 0 || r.ahead > 0
        )
        return ok({
          roots: roots.map((r) => resolve(r)),
          depth: depth ?? 2,
          scanned: targets.length,
          repos: repos.length,
          dirtyRepos: dirty.length,
          dirtyOnly: Boolean(dirtyOnly),
          items: repos
        })
      }
    }
  ]
}
