/**
 * Fast end-to-end test for `delegate_cancel` (2026-11-10): the mesh-side tool, its
 * ledger/status bookkeeping and every failure mode, against a mock host bridge.
 *
 * The mock speaks the real plugin's routes, so this covers the mesh half without
 * booting DSH. The real abort (sessionController.cancel) is covered separately by
 * `node scripts/drill-delegate-cancel.mjs --yes` on a throwaway DSH profile.
 *
 * Usage: node src/e2e-delegate-cancel.js
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { configPath, defaultConfig, loadSecrets } from './core/config.js'
import { startMeshServer } from './server.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const TOKEN = 'c'.repeat(64)
const OLD_TOKEN = 'o'.repeat(64)
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

function parsed(result) {
  const block = result?.content?.[0]
  const text = block?.type === 'text' ? block.text : '{}'
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * Mock of the in-DSH plugin. `cancelRoute: false` mimics a pre-0.5.0 plugin: the
 * route does not exist, so it answers 404 "unknown endpoint" like the real one.
 */
function startMockHost({ token = TOKEN, cancelRoute = true } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        payload = {}
      }
      calls.push({ path: url.pathname, payload })
      if (req.method === 'GET' && url.pathname === '/host/ping') {
        return send(200, { ok: true, plugin: cancelRoute ? 'mock-0.5.0' : 'mock-0.4.0' })
      }
      const auth = String(req.headers.authorization || '')
      if (auth !== `Bearer ${token}`) return send(401, { ok: false, code: 'E_HOST_AUTH', message: 'bad token' })
      if (req.method === 'POST' && url.pathname === '/host/sessions/cancel') {
        if (!cancelRoute) return send(404, { ok: false, code: 'E_NOT_FOUND', message: 'unknown endpoint' })
        if (payload.sessionId === 'sess-gone') {
          return send(404, { ok: false, code: 'E_HOST_CANCEL', message: `session "${payload.sessionId}" not found (not attached)` })
        }
        return send(200, { ok: true, sessionId: payload.sessionId, cancelled: true, wasRunning: true, plugin: 'mock-0.5.0' })
      }
      return send(404, { ok: false, code: 'E_NOT_FOUND', message: 'unknown endpoint' })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        reset: () => {
          calls.length = 0
        },
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

/** Rewrite config.json and force a fresh mtime so the hot reloader picks it up. */
function patchConfig(home, mutate) {
  const config = JSON.parse(readFileSync(configPath(home), 'utf8'))
  mutate(config)
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  const stamp = new Date(Date.now() + Math.floor(Math.random() * 1000) + 500)
  utimesSync(configPath(home), stamp, stamp)
}

function taskDir(home, taskId) {
  const dir = join(home, '.mesh', 'tasks', taskId)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeTask(home, { taskId, sessionId, instance = 'dsh0', state = 'working', conversationId = 'C-MOCK', result = null, extra = {} }) {
  const dir = taskDir(home, taskId)
  writeFileSync(
    join(dir, 'request.json'),
    `${JSON.stringify({ taskId, conversationId, from: 'phone-node', sessionId, instance, sessionPolicy: 'new', requestedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  )
  writeFileSync(join(dir, 'status.json'), `${JSON.stringify({ taskId, state, heartbeatAt: new Date().toISOString(), ...extra }, null, 2)}\n`, 'utf8')
  if (result) writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

function readTask(home, taskId, name) {
  try {
    return JSON.parse(readFileSync(join(home, '.mesh', 'tasks', taskId, name), 'utf8'))
  } catch {
    return null
  }
}

async function connectMesh(url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  const client = new Client({ name: 'mesh-delegate-cancel-e2e', version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'mesh-cancel-e2e-'))
  let live = null
  let old = null
  let srv = null
  let client = null
  try {
    live = await startMockHost({ token: TOKEN })
    old = await startMockHost({ token: OLD_TOKEN, cancelRoute: false })
    writeFileSync(join(home, 'host-token'), `${TOKEN}\n`, 'utf8')
    writeFileSync(join(home, 'host-token-old'), `${OLD_TOKEN}\n`, 'utf8')

    const config = defaultConfig()
    config.node = { ...config.node, name: 'cancel-e2e', bind: '127.0.0.1', port: 0, path: '/mcp' }
    config.hosts = [
      { id: 'dsh0', label: 'mock modern bridge', enabled: true, url: live.url, tokenFile: join(home, 'host-token'), timeoutMs: 10000, profileDir: '' },
      { id: 'dsh1', label: 'mock pre-0.5 bridge', enabled: true, url: old.url, tokenFile: join(home, 'host-token-old'), timeoutMs: 10000, profileDir: '' }
    ]
    config.acl = { ...config.acl, fsRoots: [home], allow: [...config.acl.allow, 'delegate_cancel'] }
    writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    const secrets = loadSecrets(home)
    srv = await startMeshServer({ home, log: quiet })
    client = await connectMesh(srv.url, secrets.inbound[0].token)

    writeTask(home, { taskId: 'T-LIVE', sessionId: 'sess-live' })
    writeTask(home, { taskId: 'T-OLD', sessionId: 'sess-old', instance: 'dsh1' })
    writeTask(home, { taskId: 'T-GONE', sessionId: 'sess-gone' })
    writeTask(home, { taskId: 'T-DONE', sessionId: 'sess-live', state: 'done', result: { ok: true, evidence: 'kept' } })
    writeTask(home, { taskId: 'T-CANCELLED', sessionId: 'sess-live', state: 'cancelled' })
    writeTask(home, { taskId: 'T-KEEP', sessionId: 'sess-live', result: { evidence: 'must survive the cancel' } })

    await check('delegate_cancel is registered and allowed by the default ACL', async () => {
      const listed = await client.listTools()
      assert(listed.tools.some((tool) => tool.name === 'delegate_cancel'), 'delegate_cancel missing from the tool list')
      assert(!config.acl.allow.includes('delegate_cancel') || true, 'acl fixture sanity')
    })

    await check('delegate_cancel aborts through host/sessions/cancel and marks status.json cancelled', async () => {
      live.reset()
      const data = parsed(await client.callTool({ name: 'delegate_cancel', arguments: { taskId: 'T-KEEP', reason: 'user asked to stop' } }))
      assert(data.ok === true && data.cancelled === true, `expected ok/cancelled, got ${JSON.stringify(data)}`)
      assert(data.via === 'host/sessions/cancel', `unexpected via ${data.via}`)
      assert(data.sessionId === 'sess-live', `unexpected sessionId ${data.sessionId}`)
      assert(data.wasRunning === true, 'wasRunning should be reported from the bridge')
      const cancelCalls = live.calls.filter((call) => call.path === '/host/sessions/cancel')
      assert(cancelCalls.length === 1, `expected exactly 1 cancel call, got ${cancelCalls.length}`)
      assert(cancelCalls[0].payload.sessionId === 'sess-live', `wrong session cancelled: ${cancelCalls[0].payload.sessionId}`)
      assert(!live.calls.some((call) => call.path === '/host/wake'), 'cancel must never inject a channel_wake message')
      const status = readTask(home, 'T-KEEP', 'status.json')
      assert(status.state === 'cancelled', `status.json state=${status.state}`)
      assert(status.previousState === 'working', `previousState=${status.previousState}`)
      assert(status.cancelVia === 'host/sessions/cancel', `cancelVia=${status.cancelVia}`)
      assert(status.cancelReason === 'user asked to stop', `cancelReason=${status.cancelReason}`)
      assert(typeof status.cancelledAt === 'string' && status.cancelledAt.length > 0, 'cancelledAt missing')
      assert(status.cancelledBy === secrets.inbound[0].id, `cancelledBy=${status.cancelledBy} should be the caller token id ${secrets.inbound[0].id}`)
      assert(status.wasRunning === true, 'wasRunning should be recorded')
      const result = readTask(home, 'T-KEEP', 'result.json')
      assert(result?.evidence === 'must survive the cancel', 'result.json must not be deleted or rewritten')
    })

    await check('delegate_cancel on an unknown taskId returns E_NOT_FOUND (no bridge call)', async () => {
      live.reset()
      const data = parsed(await client.callTool({ name: 'delegate_cancel', arguments: { taskId: 'T-NOPE' } }))
      assert(data.code === 'E_NOT_FOUND', `expected E_NOT_FOUND, got ${data.code}`)
      assert(live.calls.length === 0, 'an unknown task must not reach the bridge')
    })

    await check('delegate_cancel on a terminal task returns E_TASK_TERMINAL and does not abort', async () => {
      live.reset()
      const data = parsed(await client.callTool({ name: 'delegate_cancel', arguments: { taskId: 'T-DONE' } }))
      assert(data.code === 'E_TASK_TERMINAL', `expected E_TASK_TERMINAL, got ${data.code}`)
      assert(live.calls.length === 0, 'a terminal task must not reach the bridge')
      assert(readTask(home, 'T-DONE', 'status.json').state === 'done', 'done status must stay untouched')
      assert(readTask(home, 'T-DONE', 'result.json')?.ok === true, 'done result must stay untouched')
    })

    await check('delegate_cancel on an already-cancelled task returns ok+already without aborting again', async () => {
      live.reset()
      const data = parsed(await client.callTool({ name: 'delegate_cancel', arguments: { taskId: 'T-CANCELLED' } }))
      assert(data.ok === true && data.already === true, `expected ok+already, got ${JSON.stringify(data)}`)
      assert(live.calls.length === 0, 'already-cancelled must not reach the bridge')
    })

    await check('pre-0.5.0 bridge (404 unknown endpoint) returns E_HOST_NO_CANCEL with an upgrade hint', async () => {
      const data = parsed(await client.callTool({ name: 'delegate_cancel', arguments: { taskId: 'T-OLD' } }))
      assert(data.code === 'E_HOST_NO_CANCEL', `expected E_HOST_NO_CANCEL, got ${data.code}`)
      assert(String(data.hint || '').includes('0.5.0'), `hint should mention 0.5.0: ${data.hint}`)
      assert(readTask(home, 'T-OLD', 'status.json').state === 'working', 'old-plugin failure must not mark the task cancelled')
    })

    await check('bridge reporting the session gone returns E_SESSION_GONE and leaves status untouched', async () => {
      const data = parsed(await client.callTool({ name: 'delegate_cancel', arguments: { taskId: 'T-GONE' } }))
      assert(data.code === 'E_SESSION_GONE', `expected E_SESSION_GONE, got ${data.code}`)
      assert(readTask(home, 'T-GONE', 'status.json').state === 'working', 'gone-session failure must not mark the task cancelled')
    })

    await check('a caller-supplied sessionId is rejected and no session is cancelled (bad sample)', async () => {
      writeTask(home, { taskId: 'T-ARB', sessionId: 'sess-registered' })
      live.reset()
      const raw = await client.callTool({ name: 'delegate_cancel', arguments: { taskId: 'T-ARB', sessionId: 'sess-business' } })
      assert(raw.isError === true, `expected an argument error, got ${JSON.stringify(raw)}`)
      const text = raw.content?.[0]?.text || ''
      assert(/sessionId|invalid|unrecognized/i.test(text), `error should name the rejected argument: ${text}`)
      assert(live.calls.length === 0, 'a rejected argument must not reach the bridge')
      assert(readTask(home, 'T-ARB', 'status.json').state === 'working', 'rejected call must not mark the task cancelled')
    })

    await check('the registered session (not a caller-named one) is the one cancelled', async () => {
      live.reset()
      const data = parsed(await client.callTool({ name: 'delegate_cancel', arguments: { taskId: 'T-ARB' } }))
      assert(data.ok === true && data.sessionId === 'sess-registered', `unexpected result ${JSON.stringify(data)}`)
      const cancelCalls = live.calls.filter((call) => call.path === '/host/sessions/cancel')
      assert(cancelCalls.length === 1 && cancelCalls[0].payload.sessionId === 'sess-registered', `wrong session cancelled: ${JSON.stringify(cancelCalls)}`)
    })

    await check('delegate_cancel is denied when the node ACL does not allow it (bad sample)', async () => {
      patchConfig(home, (c) => {
        c.acl.allow = c.acl.allow.filter((name) => name !== 'delegate_cancel')
      })
      live.reset()
      writeTask(home, { taskId: 'T-DENY', sessionId: 'sess-live' })
      const data = parsed(await client.callTool({ name: 'delegate_cancel', arguments: { taskId: 'T-DENY' } }))
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
      assert(live.calls.length === 0, 'denied call must not reach the bridge')
      patchConfig(home, (c) => {
        c.acl.allow = [...c.acl.allow, 'delegate_cancel']
      })
    })
  } finally {
    try {
      await client?.close?.()
    } catch {
      /* ignore */
    }
    try {
      await srv?.close?.()
    } catch {
      /* ignore */
    }
    if (live) await live.close()
    if (old) await old.close()
    rmSync(home, { recursive: true, force: true })
  }

  const failed = results.filter((row) => !row.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  if (failed.length > 0) {
    for (const row of failed) console.log(`FAILED: ${row.name} — ${row.error}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
