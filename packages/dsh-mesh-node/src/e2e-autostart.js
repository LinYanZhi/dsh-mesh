// e2e: autostart helper (Windows only). Read-only: never registers/removes a task.
// Proves (a) status is safe on a clean machine, (b) both mutating paths refuse without --yes,
// (c) the generated logon command points at this checkout's cli.js.
import assert from 'node:assert/strict'
import {
  TASK_NAME,
  autostartCommand,
  autostartInstall,
  autostartRemove,
  autostartStatus
} from './core/autostart.js'

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

check('Windows guard / status shape', async () => {
  if (process.platform !== 'win32') return 'skipped: not win32'
  const st = await autostartStatus()
  assert.equal(typeof st.installed, 'boolean')
  assert.equal(st.name, TASK_NAME)
  if (st.installed) {
    assert.ok(st.taskToRun, 'installed task must report taskToRun')
  } else {
    assert.ok(typeof st.detail === 'string')
  }
  return `installed=${st.installed}`
})

check('command quotes node + cli.js + port', () => {
  const cmd = autostartCommand(TASK_NAME, 8124)
  assert.match(cmd, /^".*node(\.exe)?"/)
  assert.ok(cmd.includes('cli.js'), 'command must point at the CLI')
  assert.match(cmd, /serve --port 8124$/)
  return cmd
})

check('install refuses without --yes', async () => {
  await assert.rejects(() => autostartInstall({ yes: false }), /--yes/)
})

check('remove refuses without --yes', async () => {
  await assert.rejects(() => autostartRemove({ yes: false }), /--yes/)
})

let failed = 0
for (const c of checks) {
  try {
    const detail = await c.fn()
    console.log(`PASS  ${c.name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    failed += 1
    console.error(`FAIL  ${c.name}\n      ${err.message}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed === 0 ? 0 : 1)
