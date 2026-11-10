/**
 * Fast end-to-end test for the CLI half of delegate_cancel (`mesh-delegate.mjs cancel`):
 *   - modern peer with the tool  -> local ledger state=cancelled, via=delegate_cancel
 *   - modern peer, old PLUGIN (E_HOST_NO_CANCEL) -> loud error, NO fallback, no wake call
 *   - old PEER without the tool  -> explicit warning + legacy channel_wake fallback
 *
 * Fake peers are real MCP servers over loopback HTTP (the same wire the CLI uses), so
 * the peer-call, error-code and fallback branches are exercised without booting DSH.
 *
 * Usage: node src/e2e-delegate-cancel-cli.js
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'

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
    console.log(`FAIL ${name} - ${error?.message || error}`)
  }
}

const WAKE_ARGS = z.object({ sessionId: z.string(), text: z.string(), target: z.string().optional(), instance: z.string().optional() })
const CANCEL_ARGS = z.object({ taskId: z.string(), reason: z.string().optional() })

/**
 * One fake peer. A real MCP server is used so "tool not found" is a genuine protocol
 * error, which is exactly what an old mesh node produces.
 */
function startFakePeer(name, { withCancelTool = false, cancelHandler = null } = {}) {
  const calls = []
  const mcpServer = new McpServer({ name: `fake-peer-${name}`, version: '0.0.0' }, {})
  const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
  mcpServer.registerTool('channel_wake', { title: 'wake', description: 'fake wake', inputSchema: WAKE_ARGS }, async (args) => {
    calls.push({ tool: 'channel_wake', args })
    return textResult({ ok: true, delivered: true, wokeUp: true, messageId: 'fake-msg' })
  })
  if (withCancelTool) {
    mcpServer.registerTool('delegate_cancel', { title: 'cancel', description: 'fake cancel', inputSchema: CANCEL_ARGS }, async (args) => {
      calls.push({ tool: 'delegate_cancel', args })
      const result = cancelHandler(args)
      if (result?.isError) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: result.code, message: result.message, retryable: false }) }] }
      }
      return textResult(result)
    })
  }
  const mcpHandler = createMcpHandler(() => mcpServer, {})
  const nodeHandler = toNodeHandler(mcpHandler)
  const http = createServer((req, res) => {
    // The CLI always sends a bearer token; the fake peer only checks that one exists.
    if (!String(req.headers.authorization || '').startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, code: 'E_AUTH', message: 'missing token' }))
      return
    }
    nodeHandler(req, res)
  })
  return new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${http.address().port}`, calls, close: () => new Promise((done) => http.close(done)) })
    })
  })
}

function runCli(home, args) {
  // Async on purpose: the fake peers are MCP servers inside THIS process, so a blocking
  // spawnSync would freeze the event loop and every peer call would time out.
  const cli = join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'mesh-delegate.mjs')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, DSH_MESH_HOME: home },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function writeHome(home, peers) {
  writeFileSync(join(home, 'peers.json'), `${JSON.stringify({ version: 1, items: peers }, null, 2)}\n`, 'utf8')
  const task = (taskId, node, state = 'working') => ({
    taskId,
    conversationId: `C-${taskId}`,
    from: 'tmpPeerB',
    to: node,
    node,
    policy: 'new',
    requestedPolicy: 'new',
    sessionId: `session-${taskId}`,
    instance: 'dsh0',
    workspace: '',
    state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goal: 'drill goal',
    scope: '',
    acceptance: '',
    paths: {}
  })
  writeFileSync(
    join(home, 'delegations.json'),
    `${JSON.stringify(
      {
        version: 1,
        conversations: {
          'C-T-OK': { conversationId: 'C-T-OK', node: 'peer-ok', sessionId: 'session-T-OK', instance: 'dsh0', activeTask: 'T-OK', tasks: ['T-OK'] },
          'C-T-OLDPLUGIN': { conversationId: 'C-T-OLDPLUGIN', node: 'peer-old-plugin', sessionId: 'session-T-OLDPLUGIN', instance: 'dsh0', activeTask: 'T-OLDPLUGIN', tasks: ['T-OLDPLUGIN'] },
          'C-T-OLD': { conversationId: 'C-T-OLD', node: 'peer-old', sessionId: 'session-T-OLD', instance: 'dsh0', activeTask: 'T-OLD', tasks: ['T-OLD'] }
        },
        tasks: {
          'T-OK': task('T-OK', 'peer-ok'),
          'T-OLDPLUGIN': task('T-OLDPLUGIN', 'peer-old-plugin'),
          'T-OLD': task('T-OLD', 'peer-old')
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

function ledger(home, taskId) {
  const data = JSON.parse(readFileSync(join(home, 'delegations.json'), 'utf8'))
  return data.tasks[taskId]
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'mesh-cancel-cli-'))
  let peerOk = null
  let peerOldPlugin = null
  let peerOld = null
  try {
    peerOk = await startFakePeer('ok', {
      withCancelTool: true,
      cancelHandler: (args) => ({
        ok: true,
        taskId: args.taskId,
        sessionId: `session-${args.taskId}`,
        cancelled: true,
        via: 'host/sessions/cancel',
        wasRunning: true,
        cancelledAt: new Date().toISOString(),
        cancelledBy: 'tmpPeerB'
      })
    })
    peerOldPlugin = await startFakePeer('old-plugin', {
      withCancelTool: true,
      cancelHandler: (args) => ({
        isError: true,
        code: 'E_HOST_NO_CANCEL',
        message: `host bridge has no /host/sessions/cancel (${args.taskId})`
      })
    })
    peerOld = await startFakePeer('old', { withCancelTool: false })
    writeHome(home, [
      { id: 'peer-ok', name: 'peer-ok', url: peerOk.url, token: 'a'.repeat(64) },
      { id: 'peer-old-plugin', name: 'peer-old-plugin', url: peerOldPlugin.url, token: 'b'.repeat(64) },
      { id: 'peer-old', name: 'peer-old', url: peerOld.url, token: 'c'.repeat(64) }
    ])

    await check('modern peer: cancel is a real delegate_cancel and the ledger records it', async () => {
      const run = await runCli(home, ['cancel', 'T-OK', '--reason', 'stop drilling'])
      assert(run.code === 0, `expected exit 0, got ${run.code}: ${run.stderr}`)
      const payload = JSON.parse(run.stdout)
      assert(payload.state === 'cancelled', `state=${payload.state}`)
      assert(payload.via === 'delegate_cancel', `via=${payload.via}`)
      assert(typeof payload.ms === 'number', 'ms missing')
      assert(payload.sessionId === 'session-T-OK', `sessionId=${payload.sessionId}`)
      assert(peerOk.calls.some((call) => call.tool === 'delegate_cancel' && call.args.taskId === 'T-OK'), 'delegate_cancel was not called')
      assert(peerOk.calls.some((call) => call.tool === 'delegate_cancel' && call.args.reason === 'stop drilling'), 'reason was not forwarded')
      assert(!peerOk.calls.some((call) => call.tool === 'channel_wake'), 'modern path must not inject a wake message')
      const task = ledger(home, 'T-OK')
      assert(task.state === 'cancelled', `ledger state=${task.state}`)
      assert(task.cancelVia === 'delegate_cancel', `ledger cancelVia=${task.cancelVia}`)
    })

    await check('old peer without the tool: explicit warning + legacy channel_wake fallback', async () => {
      const run = await runCli(home, ['cancel', 'T-OLD'])
      assert(run.code === 0, `fallback should still exit 0, got ${run.code}: ${run.stderr}`)
      assert(/对端版本旧/u.test(run.stderr), `stderr should warn about the old peer: ${run.stderr}`)
      const payload = JSON.parse(run.stdout)
      assert(payload.via === 'channel_wake-legacy', `via=${payload.via}`)
      assert(/不是真中断/u.test(String(payload.warning || '')), `warning missing: ${payload.warning}`)
      const wake = peerOld.calls.find((call) => call.tool === 'channel_wake')
      assert(wake !== undefined, 'legacy fallback did not send channel_wake')
      assert(wake.args.text.includes('[dsh-mesh delegation cancel]'), 'legacy text marker missing')
      const task = ledger(home, 'T-OLD')
      assert(task.state === 'cancelled' && task.cancelVia === 'channel_wake-legacy', `ledger=${JSON.stringify(task)}`)
    })

    await check('old PLUGIN (E_HOST_NO_CANCEL): loud error, no fallback, no wake injection', async () => {
      const run = await runCli(home, ['cancel', 'T-OLDPLUGIN'])
      assert(run.code === 1, `expected exit 1, got ${run.code}`)
      assert(/E_HOST_NO_CANCEL/u.test(run.stderr), `stderr should carry the code: ${run.stderr}`)
      assert(/0\.5\.0/u.test(run.stderr), `stderr should name the required plugin version: ${run.stderr}`)
      assert(!peerOldPlugin.calls.some((call) => call.tool === 'channel_wake'), 'must NOT fall back to channel_wake')
      const task = ledger(home, 'T-OLDPLUGIN')
      assert(task.state === 'working', `ledger must stay non-terminal, got ${task.state}`)
    })
  } finally {
    if (peerOk) await peerOk.close()
    if (peerOldPlugin) await peerOldPlugin.close()
    if (peerOld) await peerOld.close()
    rmSync(home, { recursive: true, force: true })
  }

  const failed = results.filter((row) => !row.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  if (failed.length > 0) {
    for (const row of failed) console.log(`FAILED: ${row.name} - ${row.error}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
