// @generated 2026-10-27 P1：mesh_config_patch（受限的「远程改本机 mesh 配置」）
// [why] 2026-10-27 事故暴露的鸡生蛋：实例全死时想远程救，必须先在本机开 repair/加 ACL，而那头没人。
//       本工具只允许**白名单字段**的**增量**修改（不删、不碰 token/shell/端口），带备份 + 原子写 + JSON 校验 + 默认 dry-run，
//       把「远程改配置」从「开放 fs_write」降级为「受限补丁」。
// 门禁：ACL 必须显式 allow `mesh_config_patch`（默认不给）；写操作要 confirm:true。
//   - op=repair.set 允许在 repair.enabled=false 时执行（用于远程开启修复通道，bootstrap）
//   - 其它 op 要求 repair.enabled=true
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { z } from 'zod'
import { configPath, isAbsolutePath } from '../core/config.js'
import { validateRestartCommand } from '../core/restart-policy.js'
import { fail, ok } from '../core/result.js'

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/
const SCRIPT_NAME_RE = /^[A-Za-z0-9._-]{1,40}$/
const NEVER_APPEND = new Set(['shell_run'])
const MAX_FSROOTS_PER_CALL = 10

const opSchema = z.enum(['acl.allow.append', 'acl.fsRoots.append', 'repair.set', 'restartScript.set'])

function readConfigFile(home) {
  const file = configPath(home)
  const text = readFileSync(file, 'utf8')
  return { file, text, config: JSON.parse(text) }
}

function diffSummary(before, after) {
  const flat = (value, prefix = '') => {
    const out = {}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) Object.assign(out, flat(v, prefix ? `${prefix}.${k}` : k))
    } else {
      out[prefix] = value
    }
    return out
  }
  const a = flat(before)
  const b = flat(after)
  const added = []
  const changed = []
  for (const key of Object.keys(b)) {
    if (!(key in a)) added.push(key)
    else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changed.push(key)
  }
  const removed = Object.keys(a).filter((key) => !(key in b))
  return { added, changed, removed }
}

/** Apply one whitelisted op in place on `config`; throws on invalid input. */
function applyOp(config, op, value) {
  config.acl = config.acl || {}
  config.repair = config.repair || {}
  if (op === 'acl.allow.append') {
    const list = Array.isArray(value) ? value : [value]
    if (list.length === 0 || list.length > 40) throw new Error('value must be 1..40 tool names')
    config.acl.allow = Array.isArray(config.acl.allow) ? config.acl.allow : []
    let appended = 0
    for (const raw of list) {
      const name = String(raw || '').trim()
      if (!TOOL_NAME_RE.test(name)) throw new Error(`invalid tool name: ${name}`)
      if (NEVER_APPEND.has(name)) throw new Error(`refusing to auto-widen ${name} (enable it by hand on that machine)`)
      if (!config.acl.allow.includes(name)) {
        config.acl.allow.push(name)
        appended += 1
      }
    }
    return { appended, total: config.acl.allow.length }
  }
  if (op === 'acl.fsRoots.append') {
    const list = Array.isArray(value) ? value : [value]
    if (list.length === 0 || list.length > MAX_FSROOTS_PER_CALL) throw new Error(`value must be 1..${MAX_FSROOTS_PER_CALL} paths`)
    config.acl.fsRoots = Array.isArray(config.acl.fsRoots) ? config.acl.fsRoots : []
    let appended = 0
    for (const raw of list) {
      const path = String(raw || '').trim()
      if (!isAbsolutePath(path)) throw new Error(`fsRoot must be an absolute path: ${path}`)
      if (path.length > 260) throw new Error('fsRoot too long')
      if (!config.acl.fsRoots.includes(path)) {
        config.acl.fsRoots.push(path)
        appended += 1
      }
    }
    return { appended, total: config.acl.fsRoots.length }
  }
  if (op === 'repair.set') {
    const patch = value && typeof value === 'object' ? value : {}
    const keys = Object.keys(patch)
    if (keys.length === 0 || keys.some((k) => !['enabled', 'timeoutMs'].includes(k))) throw new Error('repair.set only accepts {enabled?, timeoutMs?}')
    if ('enabled' in patch) {
      if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be boolean')
      config.repair.enabled = patch.enabled
    }
    if ('timeoutMs' in patch) {
      const ms = Number(patch.timeoutMs)
      if (!Number.isFinite(ms) || ms < 5000 || ms > 600000) throw new Error('timeoutMs must be 5000..600000')
      config.repair.timeoutMs = ms
    }
    return { enabled: config.repair.enabled, timeoutMs: config.repair.timeoutMs }
  }
  if (op === 'restartScript.set') {
    const patch = value && typeof value === 'object' ? value : {}
    const name = String(patch.name || '').trim()
    const command = String(patch.command || '').trim()
    if (!SCRIPT_NAME_RE.test(name)) throw new Error('name must match [A-Za-z0-9._-]{1,40}')
    if (!command || command.length > 500) throw new Error('command must be 1..500 chars')
    const policy = validateRestartCommand(command)
    if (!policy.ok) throw new Error(policy.reason)
    config.repair.restartScripts = config.repair.restartScripts || {}
    config.repair.restartScripts[name] = command
    return { name, scripts: Object.keys(config.repair.restartScripts) }
  }
  throw new Error(`unknown op: ${op}`)
}

export function buildConfigPatch(ctx) {
  return [
    {
      name: 'mesh_config_patch',
      title: 'Patch this node mesh config (whitelisted, incremental only)',
      description:
        'Remote-editable subset of THIS machine\'s mesh config.json: append ACL entries (acl.allow / acl.fsRoots), toggle repair.enabled/timeoutMs, set one repair.restartScripts entry. Incremental only — never removes entries, never touches tokens/shell/ports. Backup + atomic write + JSON re-parse + diff returned. Default is dry-run: pass confirm:true to write. ACL must explicitly allow mesh_config_patch; every op except repair.set also requires repair.enabled=true.',
      inputSchema: z.object({
        op: opSchema.describe(
          'acl.allow.append (value: string|string[]) | acl.fsRoots.append (value: string|string[]) | repair.set (value: {enabled?,timeoutMs?}) | restartScript.set (value: {name,command})'
        ),
        value: z.any().describe('Op-specific value (see op description).'),
        confirm: z.boolean().optional().describe('true = actually write; otherwise dry-run.'),
        note: z.string().max(200).optional().describe('Free-text reason recorded in the result/audit.')
      }),
      handler: async ({ op, value, confirm, note }) => {
        const config = ctx.getConfig()
        const enabled = Boolean(config.repair?.enabled)
        if (op !== 'repair.set' && !enabled) {
          return fail('E_REPAIR_DISABLED', 'repair.enabled=false on this node: only repair.set can run remotely', { op })
        }
        let before
        try {
          const loaded = readConfigFile(ctx.home)
          before = loaded.config
        } catch (error) {
          return fail('E_CONFIG_READ', `cannot read config.json: ${error?.message || error}`)
        }
        const after = JSON.parse(JSON.stringify(before))
        let summary
        try {
          summary = applyOp(after, op, value)
        } catch (error) {
          return fail('E_INVALID_ARG', error?.message || String(error), { op })
        }
        const diff = diffSummary(before, after)
        const base = { op, note: note || '', dryRun: confirm !== true, summary, diff }
        if (confirm !== true) return ok({ ...base, applied: false, hint: 'pass confirm:true to write' })
        if (diff.removed.length > 0) return fail('E_GUARD', 'patch would remove keys (refused)', { diff })

        const file = configPath(ctx.home)
        const backup = `${file}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
        try {
          copyFileSync(file, backup)
          const next = JSON.stringify(after, null, 2) + '\n'
          writeFileSync(file, next, 'utf8')
          const verify = JSON.parse(readFileSync(file, 'utf8'))
          if (JSON.stringify(verify) !== JSON.stringify(after)) throw new Error('re-read mismatch')
        } catch (error) {
          try {
            copyFileSync(backup, file)
          } catch {
            /* keep the original error */
          }
          return fail('E_CONFIG_WRITE', `patch failed and was rolled back: ${error?.message || error}`, { backup })
        }
        return ok({
          ...base,
          applied: true,
          backup: basename(backup),
          configPath: file,
          hotReload: 'mesh server reads config on every call (mtime) — ACL/repair changes take effect immediately; new TOOLS need `node scripts/mesh-restart.mjs`'
        })
      }
    }
  ]
}
