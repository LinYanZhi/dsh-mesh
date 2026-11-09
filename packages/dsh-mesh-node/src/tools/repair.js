import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { hostInstances, resolveHostInstance } from '../core/host-agent.js'
import {
  applyPatchInsert,
  assertInside,
  normalizePluginFiles,
  PLUGIN_NAME_RE,
  pluginRoot,
  repairError
} from '../core/repair.js'
import { fail, ok } from '../core/result.js'
import { validateRestartCommand } from '../core/restart-policy.js'

const confirmSchema = z
  .boolean()
  .optional()
  .describe('Must be true. Repair operations rewrite a DSH profile on this machine.')

const instanceSchema = z
  .string()
  .optional()
  .describe('Host instance id whose profile is targeted (default: first enabled instance).')

/**
 * M7 step 3: the "repair another DSH" toolkit.
 *
 * These tools run on the machine that owns the DSH instance — a peer calls them
 * over MCP, so a live instance on the other machine can fix this one. Double
 * gate: `config.repair.enabled === true` AND an explicit ACL allow entry (none
 * of these tools is in DEFAULT_ALLOW). Every write leaves a backup and is
 * audited by the dispatcher.
 */

export function repairGate(config) {
  if (config?.repair?.enabled === true) return null
  return fail(
    'E_DENIED',
    'repair tools are disabled on this node (config.repair.enabled=true is required, and the tool must also be allowed in acl.allow)'
  )
}

export function backupRoot(config, home) {
  const configured = config?.repair?.backupDir
  return configured ? resolve(configured) : join(home, 'backups')
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

/**
 * Resolve the profile a repair tool may touch: an explicit `profileDir` must be
 * one of the configured `hosts[].profileDir` values, otherwise the instance id
 * picks the profile. This is the single place the "which profile" decision is
 * made, shared by plugin_install and fs_write.
 */
export function resolveProfileTarget(config, args) {
  const allowedProfiles = hostInstances(config)
    .map((entry) => entry.profileDir)
    .filter(Boolean)
    .map((dir) => resolve(dir))
  if (args?.profileDir) {
    const profileDir = resolve(String(args.profileDir))
    if (!allowedProfiles.includes(profileDir)) {
      throw repairError(
        'E_INVALID_ARG',
        `profileDir is not one of the configured hosts[].profileDir values: configured=${allowedProfiles.join(', ') || '(none)'}`
      )
    }
    return { profileDir, instanceId: '' }
  }
  const entry = resolveHostInstance(config, args?.instance)
  if (!entry.profileDir) {
    throw repairError('E_INVALID_ARG', `host instance "${entry.id}" has no profileDir configured`)
  }
  return { profileDir: resolve(entry.profileDir), instanceId: entry.id }
}

/** sha256 of a string or buffer, used to verify a write actually landed. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function requireProfile(profileDir) {
  if (!existsSync(join(profileDir, 'package.json'))) {
    throw repairError('E_PROFILE_NOT_FOUND', `not a DSH profile (no package.json): ${profileDir}`)
  }
}

function tail(text, limit = 8000) {
  const value = String(text || '')
  return value.length > limit ? `…${value.slice(-limit)}` : value
}

function runCommand(command, { timeoutMs, cwd }) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    execFile(
      command,
      { shell: true, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, cwd },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0
        resolvePromise({
          code: exitCode,
          signal: error?.signal || null,
          stdout: tail(stdout),
          stderr: tail(stderr),
          error: error ? String(error.message || error) : null,
          ms: Date.now() - started
        })
      }
    )
  })
}

export function buildRepair(ctx) {
  return [
    {
      name: 'repair_status',
      title: 'Show repair toolkit state on this node',
      description:
        'Read-only: whether repair tools are enabled, the file/size limits, which restart scripts are configured, and which DSH profile each host instance maps to. Everything the remote repairer needs before touching anything.',
      inputSchema: z.object({}),
      handler: async () => {
        const config = ctx.getConfig()
        const repair = config.repair || {}
        return ok({
          enabled: repair.enabled === true,
          maxFiles: repair.maxFiles,
          maxFileBytes: repair.maxFileBytes,
          timeoutMs: repair.timeoutMs,
          backupDir: backupRoot(config, ctx.home),
          restartScripts: Object.keys(repair.restartScripts || {}),
          instances: hostInstances(config).map((entry) => ({
            id: entry.id,
            label: entry.label || entry.id,
            profileDir: entry.profileDir || ''
          }))
        })
      }
    },
    {
      name: 'plugin_install',
      title: 'Install a DSH plugin into a profile (also patches cordis.patch.yml)',
      description:
        'Writes plugin files into `<profileDir>/node_modules/<name>/`, backs up any existing copy and the profile patch, then adds a `- insert:` block when the plugin is not wired yet. Use it to repair or extend a DSH instance that is otherwise unreachable — no npm, no git, no shell needed. Requires config.repair.enabled=true and confirm:true.',
      inputSchema: z.object({
        name: z.string().describe('Plugin package name, e.g. dsh-mesh-host'),
        files: z
          .array(
            z.object({
              path: z.string().describe('Relative path inside the package, forward slashes, e.g. lib/index.js'),
              content: z.string().describe('Full file text (UTF-8)')
            })
          )
          .describe('Every file of the plugin package'),
        instance: instanceSchema,
        profileDir: z
          .string()
          .optional()
          .describe('Override profile dir; must equal one of the configured hosts[].profileDir values'),
        patch: z.boolean().optional().describe('Set false to skip wiring cordis.patch.yml (default true)'),
        confirm: confirmSchema
      }),
      handler: async (args) => {
        const config = ctx.getConfig()
        const gate = repairGate(config)
        if (gate) return gate
        if (args?.confirm !== true) {
          return fail('E_INVALID_ARG', 'pass confirm:true to rewrite a DSH profile')
        }
        const name = String(args?.name || '')
        if (!PLUGIN_NAME_RE.test(name)) {
          return fail('E_INVALID_ARG', `invalid plugin name: ${name || '(empty)'}`)
        }
        const repair = config.repair || {}
        let files
        try {
          files = normalizePluginFiles(args?.files, {
            maxFiles: repair.maxFiles ?? 20,
            maxFileBytes: repair.maxFileBytes ?? 262144
          })
        } catch (error) {
          return fail(error.code || 'E_INVALID_ARG', error.message)
        }

        let profileDir
        let instanceId = ''
        try {
          const target = resolveProfileTarget(config, args)
          profileDir = target.profileDir
          instanceId = target.instanceId
          requireProfile(profileDir)
        } catch (error) {
          return fail(error.code || 'E_INVALID_ARG', error.message)
        }

        let packageDir
        try {
          packageDir = assertInside(profileDir, pluginRoot(profileDir, name))
        } catch (error) {
          return fail(error.code || 'E_INVALID_ARG', error.message)
        }

        const backups = []
        const backupDir = backupRoot(config, ctx.home)
        let packageBackup = null
        if (existsSync(packageDir)) {
          packageBackup = join(backupDir, `plugin-${name.replace(/[@/]/g, '_')}-${timestamp()}`)
          cpSync(packageDir, packageBackup, { recursive: true })
          backups.push(packageBackup)
        }
        let patchBackup = null
        let patchPath = null
        let patchCurrent = ''
        try {
          for (const file of files) {
            const absolute = join(packageDir, file.abs)
            mkdirSync(dirname(absolute), { recursive: true })
            writeFileSync(absolute, file.content, 'utf8')
          }

          let patchInfo = null
          if (args?.patch !== false) {
            patchPath = join(profileDir, 'cordis.patch.yml')
            patchCurrent = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
            const applied = applyPatchInsert(patchCurrent, name)
            if (applied.changed) {
              if (applied.backup) {
                patchBackup = `${patchPath}.bak-mesh-${timestamp()}`
                writeFileSync(patchBackup, patchCurrent, 'utf8')
                backups.push(patchBackup)
              }
              writeFileSync(patchPath, applied.text, 'utf8')
            }
            patchInfo = { path: patchPath, changed: applied.changed }
          }

          return ok({
            name,
            instance: instanceId || undefined,
            profileDir,
            packageDir,
            files: files.map((file) => ({ path: file.rel, bytes: file.bytes })),
            patch: patchInfo,
            backups,
            restartHint: 'restart that DSH instance to load the plugin'
          })
        } catch (error) {
          // rollback: a half-written plugin is worse than no plugin
          if (packageBackup) {
            rmSync(packageDir, { recursive: true, force: true })
            cpSync(packageBackup, packageDir, { recursive: true })
          } else {
            rmSync(packageDir, { recursive: true, force: true })
          }
          if (patchPath && patchBackup) writeFileSync(patchPath, patchCurrent, 'utf8')
          return fail('E_WRITE_FAILED', `plugin_install failed and was rolled back: ${error.message}`, { backups })
        }
      }
    },
    {
      name: 'service_restart',
      title: 'Run a preset restart script for a DSH instance',
      description:
        'Runs one command from config.repair.restartScripts by name (the map is the allowlist — arbitrary commands are refused). Use it only after a verified change, and only when a restart is really required. Returns exit code, stdout/stderr tails and duration. Requires config.repair.enabled=true and confirm:true.',
      inputSchema: z.object({
        script: z.string().describe('Name of the script from config.repair.restartScripts'),
        confirm: confirmSchema
      }),
      handler: async (args) => {
        const config = ctx.getConfig()
        const gate = repairGate(config)
        if (gate) return gate
        if (args?.confirm !== true) {
          return fail('E_INVALID_ARG', 'pass confirm:true to run a restart script')
        }
        const scripts = config.repair?.restartScripts || {}
        const names = Object.keys(scripts)
        const script = String(args?.script || '')
        if (!script || !Object.prototype.hasOwnProperty.call(scripts, script)) {
          return fail('E_NOT_FOUND', `unknown restart script "${script}"; configured: ${names.join(', ') || '(none)'}`, {
            scripts: names
          })
        }
        const command = String(scripts[script])
        if (!command.trim()) return fail('E_INVALID_ARG', `restart script "${script}" is empty`)
        // P2 运行期白名单：手改 config 也塞不进任意命令
        const policy = validateRestartCommand(command)
        if (!policy.ok) {
          return fail('E_DENIED', `restart script "${script}" refused by runtime allowlist: ${policy.reason}`, { script, command: command.slice(0, 160) })
        }
        const run = await runCommand(command, {
          timeoutMs: config.repair?.timeoutMs ?? 120000,
          cwd: config.repair?.cwd || undefined
        })
        if (run.code !== 0) {
          return fail('E_SCRIPT_FAILED', `restart script "${script}" exited with ${run.code ?? run.signal}`, {
            retryable: false,
            script,
            command,
            exitCode: run.code,
            signal: run.signal,
            stdout: run.stdout,
            stderr: run.stderr,
            ms: run.ms
          })
        }
        return ok({ script, command, code: run.code, stdout: run.stdout, stderr: run.stderr, ms: run.ms })
      }
    },
  ]
}