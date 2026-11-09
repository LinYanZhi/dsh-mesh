/**
 * dsh-mesh supervisor (M8.4).
 *
 * Launched by Task Scheduler / Startup, **not by DSH** — that is the point:
 * the server is a child of this supervisor, the supervisor is a child of the OS
 * autostart, so restarting the mesh server never depends on a DSH session tree.
 *
 * Restart protocol (no one kills anything):
 *   1. `node scripts/mesh-restart.mjs` writes `~/.dsh-mesh/restart.flag`;
 *   2. `src/cli.js serve` sees the flag and exits gracefully (server.close());
 *   3. this supervisor sees the child exit and starts it again with the new code.
 *
 * Stop protocol: write `~/.dsh-mesh/stop.flag` then trigger a restart; the
 * supervisor exits instead of respawning.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const HOME = process.env.DSH_MESH_HOME || join(homedir(), '.dsh-mesh')
const CLI = join(REPO, 'src', 'cli.js')
const LOG = join(HOME, 'supervisor.log')
const STOP_FLAG = join(HOME, 'stop.flag')

let child = null
let stopping = false
let restarts = 0

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  try {
    appendFileSync(LOG, `${line}\n`)
  } catch {
    /* best effort */
  }
}

function start() {
  const args = ['serve']
  if (process.env.DSH_MESH_PORT) args.push('--port', process.env.DSH_MESH_PORT)
  child = spawn(process.execPath, [CLI, ...args], { stdio: 'inherit', cwd: REPO, windowsHide: true })
  child.on('error', (error) => {
    log(`spawn error: ${error.message}`)
    setTimeout(start, 3000)
  })
  child.on('exit', (code, signal) => {
    log(`server exited code=${code} signal=${signal || ''}`)
    child = null
    if (stopping || existsSync(STOP_FLAG)) {
      log('stop flag present — supervisor exiting')
      process.exit(0)
    }
    restarts += 1
    log(`restarting in 1s (restart #${restarts})`)
    setTimeout(start, 1000)
  })
}

process.on('SIGTERM', () => {
  stopping = true
  if (child) child.kill('SIGTERM')
})
process.on('SIGINT', () => {
  stopping = true
  if (child) child.kill('SIGINT')
})

log('supervisor starting')
start()
