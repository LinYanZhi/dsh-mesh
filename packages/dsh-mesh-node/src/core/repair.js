import { isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Pure helpers for the repair toolkit (M7 step 3). Keeping the path/validation
 * logic here means the MCP tool, the CLI and the selftest all agree on what a
 * legal plugin payload is — writing into a DSH profile is the one operation that
 * can brick an instance, so it gets validated in exactly one place.
 */

export const PLUGIN_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,63}$/i

export function repairError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** Directory a plugin package occupies inside a profile's node_modules. */
export function pluginRoot(profileDir, name) {
  return join(profileDir, 'node_modules', ...String(name).split('/'))
}

/**
 * Validate and normalise a plugin file payload.
 * `path` is always a forward-slash relative path inside the package directory.
 */
export function normalizePluginFiles(files, { maxFiles = 20, maxFileBytes = 262144 } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw repairError('E_INVALID_ARG', 'files must be a non-empty array of {path, content}')
  }
  if (files.length > maxFiles) {
    throw repairError('E_INVALID_ARG', `too many files: ${files.length} > ${maxFiles}`)
  }
  const seen = new Set()
  return files.map((file, index) => {
    const raw = typeof file?.path === 'string' ? file.path : ''
    const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!rel) throw repairError('E_INVALID_ARG', `files[${index}].path is required`)
    if (isAbsolute(rel) || /^[a-z]:/i.test(rel)) {
      throw repairError('E_INVALID_ARG', `files[${index}].path must be relative: ${raw}`)
    }
    const parts = rel.split('/').filter((part) => part.length > 0)
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
      throw repairError('E_INVALID_ARG', `files[${index}].path escapes the package root: ${raw}`)
    }
    const content = typeof file?.content === 'string' ? file.content : null
    if (content === null) throw repairError('E_INVALID_ARG', `files[${index}].content must be a string`)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > maxFileBytes) {
      throw repairError('E_INVALID_ARG', `files[${index}] is ${bytes} bytes > limit ${maxFileBytes}`)
    }
    const key = parts.join('/').toLowerCase()
    if (seen.has(key)) throw repairError('E_INVALID_ARG', `duplicate file path: ${rel}`)
    seen.add(key)
    return { rel: parts.join('/'), abs: parts.join(sep), content, bytes }
  })
}

/** True when the profile patch already wires a plugin by name or id. */
export function patchHasPlugin(patchText, name) {
  const text = String(patchText || '')
  if (!text) return false
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[\\s-])(name|id):\\s*['"]?${escaped}['"]?\\s*$`, 'm').test(text)
}

export function buildPatchBlock(name) {
  return `- insert:\n    - id: ${name}\n      name: ${name}\n`
}

/**
 * Append a `- insert:` block unless the plugin is already wired.
 * A non-empty, non-`[]` patch is preserved and flagged for backup by the caller.
 */
export function applyPatchInsert(patchText, name) {
  const current = String(patchText ?? '')
  if (patchHasPlugin(current, name)) return { text: current, changed: false, backup: false }
  const trimmed = current.trim()
  const needsBackup = Boolean(trimmed && trimmed !== '[]')
  const header = needsBackup ? `${current.replace(/\s+$/, '')}\n` : ''
  return { text: header + buildPatchBlock(name), changed: true, backup: needsBackup }
}

/** Resolve `candidate` and assert it stays inside `root` (profile confinement). */
export function assertInside(root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  if (target !== base && !target.startsWith(base + sep)) {
    throw repairError('E_INVALID_ARG', `path escapes the allowed root: ${target}`)
  }
  return target
}
