// @generated files：文件传输 + 快速检索 + 工具清单（封装 Everything/rg/fd/7za 等 AI 友好 CLI）
// [why] 2026-11-10 用户要求：① 跨设备直接传文件（但要限额限速，公网/内网流量有成本）；
//       ② 把 Everything 这类毫秒级检索工具提供给 AI 用。这里用 MCP 分块读写（不占额外端口），
//       读写都受 fsRoots / 单块上限 / 单文件上限 / 每日配额约束；检索优先用 es.exe→fd→Node 回退。
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { isInsideRoots } from '../core/config.js'
import { denied, internal, invalidArg, notFound, ok } from '../core/result.js'

const TOOLS_DIR = join(homedir(), '.dsh-mesh', 'tools')
const DEFAULT_TRANSFER = {
  maxChunkBytes: 4 * 1024 * 1024, // 单块 4 MB（MCP base64 安全余量）
  maxFileBytes: 256 * 1024 * 1024, // 单文件 256 MB
  dailyBytes: 2 * 1024 * 1024 * 1024 // 每日 2 GB
}

function limitsOf(ctx) {
  return { ...DEFAULT_TRANSFER, ...(ctx.getConfig()?.transfer || {}) }
}
function transfersPath(home) { return join(home, 'transfers.json') }
function appendTransfer(ctx, record) {
  try {
    const file = transfersPath(ctx.home)
    let list = []
    try { list = JSON.parse(readFileSync(file, 'utf8')) } catch { list = [] }
    if (!Array.isArray(list)) list = []
    list.push(Object.assign({ at: new Date().toISOString(), peer: ctx.peerId || '' }, record))
    if (list.length > 200) list = list.slice(-200)
    writeFileSync(file, JSON.stringify(list, null, 2) + '\n', 'utf8')
  } catch { /* history is best-effort; never fail a transfer */ }
}

function usagePath(home) {
  return join(home, 'transfer-usage.json')
}
function readUsage(home) {
  try {
    return JSON.parse(readFileSync(usagePath(home), 'utf8'))
  } catch {
    return {}
  }
}
function dayKey() {
  return new Date().toISOString().slice(0, 10)
}
function usedToday(home) {
  const u = readUsage(home)
  return u.day === dayKey() ? Number(u.bytes || 0) : 0
}
function addUsage(home, bytes) {
  const u = readUsage(home)
  if (u.day !== dayKey()) {
    u.day = dayKey()
    u.bytes = 0
  }
  u.bytes = Number(u.bytes || 0) + bytes
  try {
    mkdirSync(dirname(usagePath(home)), { recursive: true })
    writeFileSync(usagePath(home), JSON.stringify(u, null, 2) + '\n', 'utf8')
  } catch {
    /* 用量记录失败不阻塞传输 */
  }
  return u.bytes
}
function quotaError(ctx, size) {
  const lim = limitsOf(ctx)
  const used = usedToday(ctx.home)
  if (size > lim.maxChunkBytes) return invalidArg(`chunk too large: ${size} > ${lim.maxChunkBytes} bytes`)
  if (used + size > lim.dailyBytes) {
    return denied(`daily transfer quota exceeded: ${used + size} > ${lim.dailyBytes} bytes`, { limits: lim, usedToday: used })
  }
  return null
}
function resolveGuarded(raw, config) {
  const abs = resolve(String(raw || ''))
  const allowed = config?.acl?.fsRoots || []
  if (!isInsideRoots(abs, allowed)) return { error: denied(`path is outside the allowed fsRoots: ${abs}`, { fsRoots: allowed }) }
  return { abs }
}

function findOnDisk(name) {
  const win = process.platform === 'win32'
  const exe = win ? `${name}.exe` : name
  const dirs = [
    TOOLS_DIR,
    join(TOOLS_DIR, 'rg', 'ripgrep-14.1.1-x86_64-pc-windows-msvc'),
    join(TOOLS_DIR, 'fd', 'fd-v10.2.0-x86_64-pc-windows-msvc'),
    join(TOOLS_DIR, 'node_modules', '7zip-bin', 'win', 'x64'),
    'C:/Program Files/Everything',
    'C:/Program Files/7-Zip',
    'C:/Program Files (x86)/7-Zip'
  ]
  for (const dir of dirs) {
    const p = join(dir, exe)
    if (existsSync(p)) return p
  }
  const which = spawnSync(win ? 'where.exe' : 'which', [exe], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  const line = String(which.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
  return line || null
}

const TOOL_CACHE = new Map()
function toolInfo(name) {
  if (TOOL_CACHE.has(name)) return TOOL_CACHE.get(name)
  const path = findOnDisk(name)
  let version = null
  if (path) {
    const flag = name === 'es' ? '-version' : name === '7za' ? '' : '--version'
    if (flag) {
      const r = spawnSync(path, [flag], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
      version = String((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null
    }
  }
  const info = { path, version }
  TOOL_CACHE.set(name, info)
  return info
}

function isoMs(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** 遍历回退（无 Everything/fd 时）；限制文件数，避免卡死。 */
function walkMatch(root, match, limit) {
  const out = []
  const stack = [root]
  while (stack.length && out.length < limit) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= limit) break
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      if (match(entry.name, abs)) {
        try {
          const st = statSync(abs)
          out.push({ path: abs, name: entry.name, type: st.isDirectory() ? 'dir' : 'file', sizeBytes: st.isDirectory() ? null : st.size, mtimeMs: Math.round(st.mtimeMs) })
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out
}

async function findFiles(ctx, { query, root, limit = 100, exts = null, minSizeBytes = null, modifiedAfter = null }) {
  const cfg = ctx.getConfig()
  const guarded = resolveGuarded(root || (cfg.acl?.fsRoots?.[0]?.path ?? cfg.acl?.fsRoots?.[0] ?? homedir()), cfg)
  if (guarded.error) return guarded.error
  const absRoot = guarded.abs
  if (!existsSync(absRoot)) return notFound(`root not found: ${absRoot}`)
  const es = toolInfo('es')
  if (es.path && process.env.DSH_MESH_FORCE_HTTP !== '1') {
    // 2026-11-10：两个实测坑 —— ① ES 输出是系统 ANSI(GBK)，按 UTF-8 解会中文乱码 → buffer + UTF-8 严格→GBK 回退；
    // ② 多词合成单个 argv 会被 ES 当「字面短语」→ 0 结果，必须拆成多个 argv（ext 过滤也单独一个 argv）
    const args = ['-n', String(Math.min(limit, 500)), '-path', absRoot]
    const terms = String(query || '').split(/\s+/).map((s) => s.trim()).filter(Boolean)
    if (exts?.length) terms.push('ext:' + exts.map((e) => String(e).replace(/^\\./, '')).join(';'))
    if (terms.length) args.push(...terms)
    const r = spawnSync(es.path, args, { encoding: "buffer", windowsHide: true, timeout: 15000 })
    if (r.status === 0) {
      let text = ""
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(r.stdout) } catch { try { text = new TextDecoder("gbk").decode(r.stdout) } catch { text = Buffer.from(r.stdout || []).toString("utf8") } }
      const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 500)
      const entries = lines.map((p) => {
        try {
          const st = statSync(p)
          return { path: p, name: basename(p), type: st.isDirectory() ? 'dir' : 'file', sizeBytes: st.isDirectory() ? null : st.size, mtimeMs: Math.round(st.mtimeMs) }
        } catch {
          return { path: p, name: basename(p), type: 'file', sizeBytes: null, mtimeMs: null }
        }
      })
      return ok({ tool: 'everything', count: entries.length, entries })
    }
  }

  // 2026-11-10：Everything HTTP 回退（方案 A）。DSH/mesh 跑在 session 0 的非交互 window station 时，
  // es.exe 的 IPC 找不到 Everything 窗口（Error 8）；但 Everything 的 HTTP 服务（用户会话 GUI 里开启）
  // 监听 127.0.0.1，跨会话 TCP 可达。端口：env EVERYTHING_HTTP_PORT > config.tools.everythingHttpPort > 12812。
  const httpPort = Number(process.env.EVERYTHING_HTTP_PORT || (cfg.tools && cfg.tools.everythingHttpPort) || 0) || 12812
  if (process.env.DSH_MESH_NO_HTTP !== '1') {
    try {
      const tokens = String(query || '').split(/\s+/).map((s) => s.trim()).filter(Boolean)
      if (exts && exts.length) tokens.push('ext:' + exts.map((e) => String(e).replace(/^\./, '')).join(';'))
      // Everything HTTP：path:<root> 限定目录，其余 token 按文件名匹配
      const params = new URLSearchParams({
        search: 'path:' + absRoot + ' ' + tokens.join(' '),
        json: '1',
        count: String(Math.min(limit, 500)),
        path: '1',
        path_column: '1',
        size_column: '1',
        date_modified_column: '1'
      })
      const res = await fetch('http://127.0.0.1:' + httpPort + '/?' + params.toString(), {
        signal: AbortSignal.timeout(4000)
      })
      if (res.ok) {
        const payload = await res.json()
        const rows = Array.isArray(payload && payload.results) ? payload.results : []
        const rootLower = absRoot.toLowerCase().replace(/\//g, '\\')
        const entries = []
        for (const row of rows) {
          // HTTP JSON 的 path 是「父目录」，name 才是文件名/文件夹名 → 拼成完整路径
          const rowPath = String(row.path || '')
          const rowName = String(row.name || '')
          const p = rowPath && rowName ? rowPath.replace(/[\\/]+$/, '') + '\\' + rowName : (rowPath || rowName)
          if (!p) continue
          const pLower = p.toLowerCase().replace(/\//g, '\\')
          if (pLower !== rootLower && !pLower.startsWith(rootLower + '\\')) continue
          const isDir = String(row.type || '').toLowerCase() === 'folder'
          const sizeRaw = String(row.size == null ? '' : row.size).replace(/[^\d]/g, '')
          const ticks = Number(row.date_modified)
          entries.push({
            path: p,
            name: String(row.name || basename(p)),
            type: isDir ? 'dir' : 'file',
            sizeBytes: !isDir && sizeRaw ? Number(sizeRaw) : null,
            mtimeMs: Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10000 - 11644473600000) : null
          })
          if (entries.length >= Math.min(limit, 500)) break
        }
        if (entries.length || rows.length) return ok({ tool: 'everything-http', count: entries.length, entries })
      }
    } catch {
      /* HTTP 不可用（未启用/端口不对）则继续 fd/walk 回退 */
    }
  }

  const fd = toolInfo('fd')
  if (fd.path) {
    const args = ['--hidden', '--max-results', String(Math.min(limit, 500)), '--absolute-path']
    if (exts?.length) for (const e of exts) args.push('-e', String(e).replace(/^\\./, ''))
    if (query) args.push(String(query))
    args.push(absRoot)
    const r = spawnSync(fd.path, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    const entries = String(r.stdout || '').split(/\r?\n/).filter(Boolean).slice(0, 500).map((p) => {
      try {
        const st = statSync(p)
        return { path: p, name: basename(p), type: st.isDirectory() ? 'dir' : 'file', sizeBytes: st.isDirectory() ? null : st.size, mtimeMs: Math.round(st.mtimeMs) }
      } catch {
        return { path: p, name: basename(p), type: 'file', sizeBytes: null, mtimeMs: null }
      }
    })
    return ok({ tool: 'fd', count: entries.length, entries })
  }
  const lowered = String(query || '').toLowerCase()
  const entries = walkMatch(absRoot, (name) => !lowered || name.toLowerCase().includes(lowered), Math.min(limit, 500))
  return ok({ tool: 'walk', count: entries.length, entries })
}

function searchText(ctx, { pattern, root, glob = null, maxResults = 100, contextLines = 0 }) {
  const cfg = ctx.getConfig()
  const guarded = resolveGuarded(root || (cfg.acl?.fsRoots?.[0]?.path ?? cfg.acl?.fsRoots?.[0] ?? homedir()), cfg)
  if (guarded.error) return guarded.error
  const absRoot = guarded.abs
  if (!existsSync(absRoot)) return notFound(`root not found: ${absRoot}`)
  const limit = Math.min(Math.max(Number(maxResults) || 100, 1), 200)
  const rg = toolInfo('rg')
  if (rg.path) {
    const args = ['--no-heading', '--line-number', '--color', 'never', '--max-count', String(limit), ...(glob ? ['-g', String(glob)] : []), ...(Number(contextLines) > 0 ? ['-C', String(Math.min(Number(contextLines), 5))] : []), String(pattern), absRoot]
    const r = spawnSync(rg.path, args, { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 })
    const matches = String(r.stdout || '').split(/\r?\n/).filter(Boolean).slice(0, limit)
    return ok({ tool: 'ripgrep', count: matches.length, matches })
  }
  const re = new RegExp(String(pattern), 'i')
  const hits = []
  const stack = [absRoot]
  while (stack.length && hits.length < limit) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (hits.length >= limit) break
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(abs)
        continue
      }
      try {
        if (statSync(abs).size > 2 * 1024 * 1024) continue
        const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
        lines.forEach((line, idx) => {
          if (hits.length < limit && re.test(line)) hits.push(`${abs}:${idx + 1}:${line.slice(0, 300)}`)
        })
      } catch {
        /* skip binary/unreadable */
      }
    }
  }
  return ok({ tool: 'walk', count: hits.length, matches: hits })
}

export function buildFiles(ctx) {
  return [
    {
      name: 'file_read_chunk',
      title: 'Read a file chunk as base64 (file transfer)',
      description:
        'Read up to transfer.maxChunkBytes (default 4 MB) of a file as base64 for cross-device transfer. Path must be inside fsRoots. Use offset to continue; eof=true on last chunk. Counts against the daily transfer quota.',
      inputSchema: z.object({
        path: z.string().describe('Absolute file path inside an allowed fsRoot'),
        offset: z.number().int().min(0).optional().describe('Byte offset (default 0)'),
        length: z.number().int().min(1).optional().describe('Bytes to read (default/max = transfer.maxChunkBytes)')
      }),
      handler: async ({ path, offset = 0, length }) => {
        const lim = limitsOf(ctx)
        const cfg = ctx.getConfig()
        const guarded = resolveGuarded(path, cfg)
        if (guarded.error) return guarded.error
        if (!existsSync(guarded.abs)) return notFound(`file not found: ${guarded.abs}`)
        const st = statSync(guarded.abs)
        if (!st.isFile()) return invalidArg('path is not a regular file')
        const size = st.size
        if (size > lim.maxFileBytes) return denied(`file too large: ${size} > ${lim.maxFileBytes} bytes`, { limits: lim })
        const want = Math.min(Number(length) || lim.maxChunkBytes, lim.maxChunkBytes)
        const quota = quotaError(ctx, want)
        if (quota) return quota
        const buf = Buffer.alloc(Math.min(want, Math.max(0, size - offset)))
        const fd = openSync(guarded.abs, 'r')
        try {
          const read = readSync(fd, buf, 0, buf.length, offset)
          addUsage(ctx.home, read)
          appendTransfer(ctx, { direction: 'read', path: guarded.abs, offset, bytes: read, totalBytes: size })
          return ok({
            path: guarded.abs,
            sizeBytes: size,
            offset,
            length: read,
            eof: offset + read >= size,
            base64: buf.subarray(0, read).toString('base64')
          })
        } finally {
          closeSync(fd)
        }
      }
    },
    {
      name: 'file_write_chunk',
      title: 'Write a base64 chunk at an offset (file transfer)',
      description:
        'Write up to transfer.maxChunkBytes (default 4 MB) decoded from base64 into a file inside fsRoots. offset=0 with truncate=true creates/overwrites; later chunks continue at offset. Counts against the daily transfer quota.',
      inputSchema: z.object({
        path: z.string().describe('Absolute file path inside an allowed fsRoot'),
        offset: z.number().int().min(0).optional().describe('Byte offset (default 0)'),
        base64: z.string().describe('Base64 payload (max transfer.maxChunkBytes decoded)'),
        truncate: z.boolean().optional().describe('When offset=0, truncate the file first (default false)')
      }),
      handler: async ({ path, offset = 0, base64, truncate = false }) => {
        const lim = limitsOf(ctx)
        const cfg = ctx.getConfig()
        const guarded = resolveGuarded(path, cfg)
        if (guarded.error) return guarded.error
        let buf
        try {
          buf = Buffer.from(String(base64 || ''), 'base64')
        } catch {
          return invalidArg('base64 payload is invalid')
        }
        if (buf.length === 0) return invalidArg('empty payload')
        if (buf.length > lim.maxChunkBytes) return invalidArg(`chunk too large: ${buf.length} > ${lim.maxChunkBytes}`)
        const quota = quotaError(ctx, buf.length)
        if (quota) return quota
        try {
          mkdirSync(dirname(guarded.abs), { recursive: true })
          const flags = offset === 0 && truncate ? 'w' : existsSync(guarded.abs) ? 'r+' : 'w'
          const fd = openSync(guarded.abs, flags)
          try {
            writeSync(fd, buf, 0, buf.length, offset)
          } finally {
            closeSync(fd)
          }
          addUsage(ctx.home, buf.length)
          appendTransfer(ctx, { direction: 'write', path: guarded.abs, offset, bytes: buf.length, totalBytes: statSync(guarded.abs).size })
          return ok({ path: guarded.abs, offset, written: buf.length, sizeBytes: statSync(guarded.abs).size })
        } catch (error) {
          return internal(`write failed: ${error?.message || error}`)
        }
      }
    },
    {
      name: 'file_hash',
      title: 'SHA-256 of a file or range',
      description: 'Compute SHA-256 for a file (or a byte range) so transfers can be verified end-to-end.',
      inputSchema: z.object({
        path: z.string().describe('Absolute file path inside an allowed fsRoot'),
        offset: z.number().int().min(0).optional(),
        length: z.number().int().min(1).optional()
      }),
      handler: async ({ path, offset = 0, length }) => {
        const cfg = ctx.getConfig()
        const guarded = resolveGuarded(path, cfg)
        if (guarded.error) return guarded.error
        if (!existsSync(guarded.abs)) return notFound(`file not found: ${guarded.abs}`)
        const st = statSync(guarded.abs)
        if (!st.isFile()) return invalidArg('path is not a regular file')
        const start = Math.min(Number(offset) || 0, st.size)
        const want = Number(length) || st.size - start
        const fd = openSync(guarded.abs, 'r')
        try {
          const hash = createHash('sha256')
          const chunk = Buffer.alloc(Math.min(want, 1024 * 1024))
          let pos = start
          let remaining = Math.min(want, st.size - start)
          while (remaining > 0) {
            const read = readSync(fd, chunk, 0, Math.min(chunk.length, remaining), pos)
            if (read <= 0) break
            hash.update(chunk.subarray(0, read))
            pos += read
            remaining -= read
          }
          return ok({ path: guarded.abs, sizeBytes: st.size, algorithm: 'sha256', digest: hash.digest('hex') })
        } finally {
          closeSync(fd)
        }
      }
    },
    {
      name: 'transfer_usage',
      title: 'File-transfer quota and usage',
      description: 'Show transfer limits (chunk/file/daily) and how many bytes this node has moved today.',
      inputSchema: z.object({}),
      handler: async () => ok({ limits: limitsOf(ctx), usedToday: usedToday(ctx.home), day: dayKey(), usageFile: usagePath(ctx.home) })
    },
    {
      name: 'find_files',
      title: 'Fast file search (Everything / fd)',
      description:
        'Find files by name under a root: uses Everything es.exe (millisecond index) when available, else fd, else a bounded walk. Returns up to 500 entries with size/mtime. Read-only.',
      inputSchema: z.object({
        query: z.string().describe('Substring / Everything query to match in file names'),
        root: z.string().optional().describe('Root directory (default: first fsRoot)'),
        limit: z.number().int().min(1).max(500).optional(),
        exts: z.array(z.string()).optional().describe('Only these extensions, e.g. ["md","ts"]'),
        minSizeBytes: z.number().int().min(0).optional(),
        modifiedAfter: z.string().optional().describe('ISO time lower bound on mtime')
      }),
      handler: async (args) => findFiles(ctx, args)
    },
    {
      name: 'search_text',
      title: 'Fast text search (ripgrep)',
      description: 'Search file contents with ripgrep when available (regex supported), else bounded walk. Returns "path:line:text" strings. Read-only.',
      inputSchema: z.object({
        pattern: z.string().describe('Regex / plain pattern'),
        root: z.string().optional().describe('Root directory (default: first fsRoot)'),
        glob: z.string().optional().describe('ripgrep glob filter, e.g. "*.md"'),
        maxResults: z.number().int().min(1).max(200).optional(),
        contextLines: z.number().int().min(0).max(5).optional()
      }),
      handler: async (args) => searchText(ctx, args)
    },
    {
      name: 'tool_inventory',
      title: 'Available AI/terminal tools on this node',
      description: 'Report which high-value CLI tools are installed (Everything es.exe, ripgrep, fd, jq, 7za) with paths and versions. Use before asking this node for fast search/archive work.',
      inputSchema: z.object({}),
      handler: async () =>
        ok({
          platform: process.platform,
          tools: Object.fromEntries(['es', 'rg', 'fd', 'jq', '7za'].map((name) => [name, toolInfo(name)]))
        })
    }
  ]
}
