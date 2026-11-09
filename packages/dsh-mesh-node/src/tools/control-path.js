import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import { hostname } from 'node:os'
import { z } from 'zod'
import { ok, denied, invalidArg } from '../core/result.js'

/**
 * pc_path：只读「路径探查」（存在性 / 目录清单 / 大小时间）。
 *
 * 为什么单独一个工具：手机经常需要在电脑上确认「D:\xxx 这个目录在不在」「某路径下有没有这些子目录」，
 * 用 fs_list/fs_stat 会被 fsRoots 限制在 Code / .dsh 存储里，看不到业务盘；
 * 委托对端 AI 又慢又费 token。这些是纯确定性的只读查询，应该直连。
 *
 * 安全边界（刻意收窄）：
 * - 只读：不写、不改、不删、不执行；不返回文件内容，只返回名字/类型/大小/时间；
 * - 只接受绝对路径，拒绝 `..` 段；
 * - 敏感段黑名单（.ssh / .gnupg / .aws / 凭据文件等）与系统敏感目录直接 E_DENIED；
 * - names 只接受单层名字（不含分隔符），相当于「查这些子项在不在」，不能拿它做递归遍历。
 */
const DENY_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.azure', '.netrc', '.npmrc', '.credentials'])
const DENY_BASENAMES = new Set(['id_rsa', 'id_ed25519', 'id_ecdsa', '.netrc'])
const DENY_BASENAME_PREFIXES = ['credentials', 'secrets', '.credentials', '.secrets']

function deniedName(name) {
  const lower = String(name || '').toLowerCase()
  if (DENY_SEGMENTS.has(lower)) return true
  if (DENY_BASENAMES.has(lower)) return true
  return DENY_BASENAME_PREFIXES.some((prefix) => lower.startsWith(prefix))
}
const DENY_PATH_PREFIXES_WIN = ['c:\\windows\\system32\\config', 'c:\\windows\\system32\\drivers\\etc']

function kindOf(st) {
  if (!st) return null
  if (st.isDirectory()) return 'dir'
  if (st.isSymbolicLink()) return 'link'
  if (st.isFile()) return 'file'
  return 'other'
}

function normalizeInput(raw) {
  const s = String(raw || '').trim()
  if (!s) return { error: 'path is required' }
  if (s.includes('\0')) return { error: 'invalid path' }
  if (!isAbsolute(s)) return { error: 'path must be absolute (e.g. D:\\work or C:/work)' }
  // 先按原始字符串拦 `..`（resolve 会把 .. 折叠掉，折叠后就检查不到了）
  if (s.split(/[\\/]+/).some((seg) => seg === '..')) return { error: 'path must not contain ".."' }
  const normalized = resolvePath(s)
  const segments = normalized.split(/[\\/]+/).filter(Boolean)
  if (segments.some((seg) => seg === '..')) return { error: 'path must not contain ".."' }
  const lower = segments.map((seg) => seg.toLowerCase())
  if (lower.some((seg) => DENY_SEGMENTS.has(seg))) return { error: 'DENIED_SENSITIVE', denied: true }
  if (deniedName(segments[segments.length - 1])) return { error: 'DENIED_SENSITIVE', denied: true }
  if (process.platform === 'win32') {
    const flat = normalized.toLowerCase().replace(/\//g, '\\')
    if (DENY_PATH_PREFIXES_WIN.some((p) => flat === p || flat.startsWith(p + '\\'))) return { error: 'DENIED_SENSITIVE', denied: true }
  }
  return { path: normalized, segments }
}

async function describe(target) {
  try {
    const st = await lstat(target)
    return { exists: true, kind: kindOf(st), size: kindOf(st) === 'file' ? st.size : null, mtime: st.mtime?.toISOString() || null }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { exists: false, kind: null, size: null, mtime: null }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return { exists: null, kind: null, size: null, mtime: null, error: 'EACCES' }
    return { exists: null, kind: null, size: null, mtime: null, error: String(error?.code || error?.message || error) }
  }
}

function retarget(input) {
  const parsed = normalizeInput(input)
  if (parsed.error) return parsed
  return parsed
}

export function buildControlPath() {
  return [
    {
      name: 'pc_path',
      title: 'Read-only path probe (exists / list / stat)',
      description:
        'Read-only path inspection on the peer machine (NOT a file reader, NOT a shell): exists(path, names?) → does the path exist and do these child names exist; ' +
        'list(path, limit?) → child names with dir/file kinds; stat(path) → kind/size/mtime. ' +
        'Absolute paths only, ".." rejected, sensitive segments (.ssh/.gnupg/credentials…) and Windows config dirs denied. Never returns file contents, never writes.',
      inputSchema: z.object({
        action: z.enum(['exists', 'list', 'stat']),
        path: z.string().max(1000),
        names: z.array(z.string().max(120)).max(50).optional(),
        limit: z.number().int().min(1).max(200).optional()
      }),
      handler: async ({ action, path, names, limit }) => {
        const target = retarget(path)
        if (target.error) {
          return target.denied ? denied(`path denied: ${path}`) : invalidArg(target.error)
        }
        const base = target.path
        const started = Date.now()

        if (action === 'exists') {
          const info = await describe(base)
          const payload = { action, host: hostname(), path: base, ...info, ms: Date.now() - started }
          if (Array.isArray(names) && names.length) {
            if (!info.exists) return ok({ ...payload, checks: {} })
            const checks = {}
            for (const rawName of names) {
              const name = String(rawName || '').trim()
              if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
                checks[rawName] = { exists: null, kind: null, error: 'invalid name' }
                continue
              }
              if (deniedName(name)) {
                checks[rawName] = { exists: null, kind: null, error: 'denied' }
                continue
              }
              const child = await describe(base.endsWith(sep) ? base + name : join(base, name))
              checks[rawName] = { exists: child.exists, kind: child.kind, ...(child.error ? { error: child.error } : {}) }
            }
            payload.checks = checks
          }
          return ok(payload)
        }

        if (action === 'stat') {
          const info = await describe(base)
          if (info.error === 'EACCES') return denied('E_PERMISSION: access denied: ' + base)
          return ok({ action, host: hostname(), path: base, ...info, ms: Date.now() - started })
        }

        const max = Number(limit || 100)
        try {
          const entries = await readdir(base, { withFileTypes: true })
          const rows = entries
            .map((e) => ({
              name: e.name,
              kind: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : e.isFile() ? 'file' : 'other'
            }))
            .filter((row) => !deniedName(row.name))
            .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
          return ok({
            action,
            host: hostname(),
            path: base,
            exists: true,
            total: rows.length,
            truncated: rows.length > max,
            entries: rows.slice(0, max),
            ms: Date.now() - started
          })
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            return ok({ action, host: hostname(), path: base, exists: false, total: 0, entries: [], ms: Date.now() - started })
          }
          if (error?.code === 'EACCES' || error?.code === 'EPERM') return denied('E_PERMISSION: access denied: ' + base)
          return invalidArg('list failed: ' + String(error?.code || error?.message || error))
        }
      }
    }
  ]
}
