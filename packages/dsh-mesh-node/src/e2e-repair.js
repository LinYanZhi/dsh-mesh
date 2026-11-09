import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from './core/config.js'
import { dispatch } from './tools/index.js'

/**
 * End-to-end test for the repair toolkit (M7 step 3): plugin_install /
 * service_restart / repair_status. Everything runs against a throwaway mesh home
 * and a throwaway "DSH profile", so no real DSH is touched.
 *
 * Usage: node src/e2e-repair.js
 */

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const results = []
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error?.message || String(error) })
    console.log(`FAIL ${name} — ${error?.message || error}`)
  }
}

function body(result) {
  const text = result?.content?.[0]?.text || ''
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

const home = mkdtempSync(join(tmpdir(), 'dsh-mesh-repair-'))
const profileDir = join(home, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-mock' }), 'utf8')

const config = defaultConfig()
config.repair = {
  ...config.repair,
  enabled: true,
  maxFiles: 5,
  maxFileBytes: 4096,
  timeoutMs: 30000,
  backupDir: join(home, 'backups'),
  restartScripts: {
    ok: 'node -e "console.log(\'RESTART-OK\')"',
    fail: 'node -e "process.exit(3)"'
  }
}
config.hosts = [
  {
    id: 'dsh0',
    label: 'mock instance',
    enabled: true,
    url: 'http://127.0.0.1:1',
    tokenFile: '',
    timeoutMs: 1000,
    profileDir
  }
]
config.acl.allow = [...new Set([...config.acl.allow, 'repair_status', 'plugin_install', 'service_restart', 'fs_write'])]

const ctx = {
  home,
  getConfig: () => config,
  log: quiet,
  audit: async () => {},
  peerId: 'e2e-repair'
}

const pluginFiles = [
  { path: 'package.json', content: JSON.stringify({ name: 'dsh-demo-plugin', version: '1.0.0', main: 'lib/index.js' }) },
  { path: 'lib/index.js', content: 'export const name = "dsh-demo-plugin"\nexport function apply() {}\n' }
]

async function run() {
  await check('repair_status: enabled + instance profileDir visible', async () => {
    const data = body(await dispatch(ctx, 'repair_status', {}))
    assert(data.enabled === true, 'enabled should be true')
    assert(data.instances?.[0]?.profileDir === profileDir, `profileDir mismatch: ${data.instances?.[0]?.profileDir}`)
    assert(Array.isArray(data.restartScripts) && data.restartScripts.includes('ok'), 'restart scripts listed')
  })

  await check('plugin_install: confirm is required', async () => {
    const data = body(await dispatch(ctx, 'plugin_install', { name: 'dsh-demo-plugin', files: pluginFiles }))
    assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
  })

  await check('plugin_install: writes files and wires cordis.patch.yml', async () => {
    const data = body(await dispatch(ctx, 'plugin_install', { name: 'dsh-demo-plugin', files: pluginFiles, confirm: true }))
    assert(data.packageDir, `missing packageDir: ${JSON.stringify(data)}`)
    assert(existsSync(join(profileDir, 'node_modules', 'dsh-demo-plugin', 'lib', 'index.js')), 'lib/index.js not written')
    assert(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').includes('dsh-demo-plugin'), 'patch not wired')
    assert(data.patch?.changed === true, 'patch.changed should be true on first install')
  })

  await check('plugin_install: idempotent patch + backups an existing copy', async () => {
    const data = body(await dispatch(ctx, 'plugin_install', { name: 'dsh-demo-plugin', files: pluginFiles, confirm: true }))
    assert(data.patch?.changed === false, 'patch.changed should be false on second install')
    assert(Array.isArray(data.backups) && data.backups.length > 0, 'existing plugin dir should be backed up')
    assert(existsSync(data.backups[0]), `backup missing: ${data.backups[0]}`)
  })

  await check('plugin_install: rejects path traversal', async () => {
    const data = body(
      await dispatch(ctx, 'plugin_install', {
        name: 'dsh-evil',
        files: [{ path: '../escape.js', content: 'x' }],
        confirm: true
      })
    )
    assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
  })

  await check('plugin_install: rejects absolute path', async () => {
    const data = body(
      await dispatch(ctx, 'plugin_install', {
        name: 'dsh-evil',
        files: [{ path: 'C:/Windows/evil.js', content: 'x' }],
        confirm: true
      })
    )
    assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
  })

  await check('plugin_install: rejects oversized payload', async () => {
    const data = body(
      await dispatch(ctx, 'plugin_install', {
        name: 'dsh-big',
        files: [{ path: 'index.js', content: 'x'.repeat(5000) }],
        confirm: true
      })
    )
    assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
  })

  await check('plugin_install: rejects unknown instance', async () => {
    const data = body(
      await dispatch(ctx, 'plugin_install', { name: 'dsh-demo-plugin', files: pluginFiles, instance: 'nope', confirm: true })
    )
    assert(data.code === 'E_HOST_UNKNOWN', `expected E_HOST_UNKNOWN, got ${data.code}`)
  })

  await check('plugin_install: refuses profileDir outside config', async () => {
    const data = body(
      await dispatch(ctx, 'plugin_install', {
        name: 'dsh-demo-plugin',
        files: pluginFiles,
        profileDir: join(home, 'elsewhere'),
        confirm: true
      })
    )
    assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
  })

  await check('plugin_install: refuses a non-profile directory', async () => {
    const notProfile = join(home, 'not-a-profile')
    mkdirSync(notProfile, { recursive: true })
    config.hosts.push({ ...config.hosts[0], id: 'dsh9', profileDir: notProfile })
    const data = body(
      await dispatch(ctx, 'plugin_install', { name: 'dsh-demo-plugin', files: pluginFiles, instance: 'dsh9', confirm: true })
    )
    config.hosts.pop()
    assert(data.code === 'E_PROFILE_NOT_FOUND', `expected E_PROFILE_NOT_FOUND, got ${data.code}`)
  })

  await check('fs_write: confirm is required', async () => {
    const data = body(await dispatch(ctx, 'fs_write', { path: 'AGENTS.md', content: 'x' }))
    assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
  })

  await check('fs_write: creates a new file and verifies sha256', async () => {
    const data = body(await dispatch(ctx, 'fs_write', { path: 'config/extra.json', content: '{"ok":true}\n', confirm: true }))
    assert(data.created === true, `created should be true: ${JSON.stringify(data)}`)
    assert(data.verified === true, 'verified should be true')
    assert(existsSync(join(profileDir, 'config', 'extra.json')), 'file not written')
    assert(readFileSync(join(profileDir, 'config', 'extra.json'), 'utf8') === '{"ok":true}\n', 'content mismatch')
    assert(data.sha256 && data.sha256.length === 64, `sha256 missing: ${data.sha256}`)
    assert(data.backup === null, `no backup expected for a new file, got ${data.backup}`)
  })

  await check('fs_write: backups the old content before overwriting', async () => {
    const data = body(await dispatch(ctx, 'fs_write', { path: 'config/extra.json', content: '{"ok":false}\n', confirm: true }))
    assert(data.created === false, 'created should be false on overwrite')
    assert(data.backup && existsSync(data.backup), `backup missing: ${data.backup}`)
    assert(readFileSync(data.backup, 'utf8') === '{"ok":true}\n', 'backup should hold the previous content')
    assert(readFileSync(join(profileDir, 'config', 'extra.json'), 'utf8') === '{"ok":false}\n', 'new content not written')
  })

  await check('fs_write: accepts an absolute path inside the profile', async () => {
    const target = join(profileDir, 'patch-view.yml')
    const data = body(await dispatch(ctx, 'fs_write', { path: target, content: '- insert: []\n', confirm: true }))
    assert(data.path === target, `path mismatch: ${data.path}`)
    assert(readFileSync(target, 'utf8') === '- insert: []\n', 'absolute write failed')
  })

  await check('fs_write: rejects path traversal', async () => {
    const data = body(await dispatch(ctx, 'fs_write', { path: '../escape.txt', content: 'x', confirm: true }))
    assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
    assert(!existsSync(join(tmpdir(), 'escape.txt')) && !existsSync(join(home, 'escape.txt')), 'escape file must not exist')
  })

  await check('fs_write: rejects an absolute path outside the profile', async () => {
    const data = body(await dispatch(ctx, 'fs_write', { path: join(home, 'outside.txt'), content: 'x', confirm: true }))
    assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
    assert(!existsSync(join(home, 'outside.txt')), 'outside file must not exist')
  })

  await check('fs_write: rejects oversized content', async () => {
    const data = body(await dispatch(ctx, 'fs_write', { path: 'big.txt', content: 'x'.repeat(5000), confirm: true }))
    assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
  })

  await check('fs_write: ACL deny after removing the allow entry', async () => {
    config.acl.allow = config.acl.allow.filter((name) => name !== 'fs_write')
    const result = await dispatch(ctx, 'fs_write', { path: 'nope.txt', content: 'x', confirm: true })
    assert(result.isError === true, 'expected an error result')
    assert(body(result).code === 'E_DENIED', `expected E_DENIED, got ${body(result).code}`)
    config.acl.allow = [...config.acl.allow, 'fs_write']
  })

  await check('plugin_install: rolls the package dir back when the patch write fails', async () => {
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const savedPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : null
    rmSync(patchPath, { force: true })
    mkdirSync(patchPath, { recursive: true }) // a directory where the patch file must go -> write fails
    try {
      const data = body(
        await dispatch(ctx, 'plugin_install', {
          name: 'dsh-rollback-demo',
          files: [{ path: 'index.js', content: 'export const name = "dsh-rollback-demo"\n' }],
          confirm: true
        })
      )
      assert(data.code === 'E_WRITE_FAILED', `expected E_WRITE_FAILED, got ${data.code}`)
      assert(!existsSync(join(profileDir, 'node_modules', 'dsh-rollback-demo')), 'package dir must be rolled back')
    } finally {
      rmSync(patchPath, { recursive: true, force: true })
      if (savedPatch !== null) writeFileSync(patchPath, savedPatch, 'utf8')
    }
  })

  await check('service_restart: unknown script refused', async () => {
    const data = body(await dispatch(ctx, 'service_restart', { script: 'nope', confirm: true }))
    assert(data.code === 'E_NOT_FOUND', `expected E_NOT_FOUND, got ${data.code}`)
  })

  await check('service_restart: allowlisted script runs and returns output', async () => {
    const data = body(await dispatch(ctx, 'service_restart', { script: 'ok', confirm: true }))
    assert(data.code === 0, `expected exit 0, got ${data.code}`)
    assert(String(data.stdout).includes('RESTART-OK'), `stdout missing marker: ${data.stdout}`)
  })

  await check('service_restart: failing script surfaces exit code', async () => {
    const data = body(await dispatch(ctx, 'service_restart', { script: 'fail', confirm: true }))
    assert(data.code === 'E_SCRIPT_FAILED', `expected E_SCRIPT_FAILED, got ${data.code}`)
    assert(data.exitCode === 3, `expected exitCode 3, got ${data.exitCode}`)
    assert(String(data.message).includes('exited with'), `unexpected message: ${data.message}`)
  })

  await check('ACL: repair tools are denied after removing the allow entry', async () => {
    config.acl.allow = config.acl.allow.filter((name) => name !== 'plugin_install')
    const result = await dispatch(ctx, 'plugin_install', { name: 'dsh-demo-plugin', files: pluginFiles, confirm: true })
    assert(result.isError === true, 'expected an error result')
    assert(body(result).code === 'E_DENIED', `expected E_DENIED, got ${body(result).code}`)
  })

  await check('repair disabled: gate rejects even when ACL allows', async () => {
    config.acl.allow = [...config.acl.allow, 'plugin_install']
    config.repair.enabled = false
    const data = body(await dispatch(ctx, 'plugin_install', { name: 'dsh-demo-plugin', files: pluginFiles, confirm: true }))
    assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    config.repair.enabled = true
  })
}

try {
  await run()
} finally {
  rmSync(home, { recursive: true, force: true })
}

const passed = results.filter((row) => row.ok).length
const failed = results.length - passed
console.log(`\ne2e-repair: ${passed}/${results.length} passed`)
if (failed > 0) {
  for (const row of results.filter((item) => !item.ok)) console.log(`  FAILED ${row.name}: ${row.error}`)
  process.exitCode = 1
}
