import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DshWebClient, DshError } from './core/ds-web.js'
import { defaultConfig, loadSecrets, configPath } from './core/config.js'
import { startMeshServer } from './server.js'

/**
 * Protocol-level end-to-end test for the M3 channel (route A).
 *
 * A mock stand-in for `dsh web` speaks the exact wire shapes from
 * apps/web/tests/smoke-real.e2e.ts (launch URL -> 303 + cookie, POST /api/<method>,
 * session/list|create|prompt|page|cancel) so the client and the channel tools can be
 * exercised without booting a real model instance.
 *
 * Usage: node src/e2e-channel.js
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

const LAUNCH_TOKEN = 'A'.repeat(43)
const COOKIE = 'dsh-auth-mock=v1.mock-signature'

/** Minimal DSH web host: one session, scripted turn emitted in three delayed steps. */
function startMockDsh() {
  const events = []
  let seq = 0
  let sessions = []
  const followers = new Set()
  const push = (type, data = {}) => {
    seq += 1
    const event = { type, seq, data }
    events.push(event)
    for (const follower of followers) {
      try {
        follower.send(
          JSON.stringify({ type: 'item', streamId: follower.streamId, value: { type: 'event', event } })
        )
      } catch {
        /* follower already gone */
      }
    }
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET') {
      if (url.pathname === '/') {
        if (url.searchParams.get('token') === LAUNCH_TOKEN) {
          res.writeHead(303, { location: '/', 'set-cookie': `${COOKIE}; HttpOnly; SameSite=Strict; Path=/` })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('dsh web (mock)')
        return
      }
      return send(404, { code: 'E_NOT_FOUND' })
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(404, { code: 'E_NOT_FOUND' })
    if (!String(req.headers.cookie || '').includes(COOKIE)) {
      return send(401, { code: 'gateway/unauthorized', message: 'no session cookie' })
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const args = envelope?.payload?.args || {}
      const value = (v) => send(200, { result: { ok: true, value: v } })
      switch (envelope.method) {
        case 'session/list':
          return value({ items: sessions.map((s) => ({ sessionId: s, title: `title ${s}`, status: 'idle' })) })
        case 'session/create': {
          const sessionId = `mock-${sessions.length + 1}`
          sessions = [...sessions, sessionId]
          return value({ sessionId })
        }
        case 'session/prompt': {
          const { sessionId, requestId, content } = args?.request || {}
          if (!sessions.includes(sessionId)) return send(200, { result: { ok: false, error: { code: 'gateway/not-found', message: 'no such session' } } })
          const text = content?.[0]?.text ?? ''
          push('user/message', { message: { content: [{ type: 'text', text }] }, requestId })
          setTimeout(() => push('turn/start', { turn: 1 }), 200)
          setTimeout(() => push('assistant/message', { message: { content: [{ type: 'text', text: `echo: ${text}` }, { type: 'text', text: 'MESH-CHANNEL-OK' }] } }), 600)
          setTimeout(() => push('turn/end', { reason: { kind: 'completed' } }), 900)
          return value({ accepted: true })
        }
        case 'session/page': {
          const request = args?.request || {}
          const through = Number.isInteger(request.throughSeq) ? request.throughSeq : -1
          const max = request.maxMessages ?? 40
          const visible = events.filter((event) => through === -1 || event.seq <= through)
          const records = visible.slice(-max).map((event) => ({ type: 'event', event }))
          return value({ records, hasMore: visible.length > records.length })
        }
        case 'session/cancel':
          return value({ cancelled: true })
        default:
          return send(200, { result: { ok: false, error: { code: 'gateway/bad-request', message: `unknown method ${envelope.method}` } } })
      }
    })
  })
  // ---- session/follow carrier (`/api/remote.mux`) ---------------------------
  // Wire shapes mirror packages/api/gateway/src/stream-protocol.ts: {type:'open',
  // streamId, endpoint, payload} in, `{type:'item', streamId, value}` out.
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/api/remote.mux' || !String(req.headers.cookie || '').includes(COOKIE)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        let frame
        try {
          frame = JSON.parse(raw.toString('utf8'))
        } catch {
          return
        }
        if (frame?.type === 'open' && frame.endpoint === 'session/follow') {
          const maxMessages = frame.payload?.args?.request?.maxMessages ?? 40
          ws.streamId = frame.streamId
          followers.add(ws)
          const records = events.slice(-maxMessages).map((event) => ({ type: 'event', event }))
          ws.send(
            JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: { type: 'snapshot', cursor: seq, records, hasMore: false, header: {}, projections: {} }
            })
          )
          return
        }
        if (frame?.type === 'cancel' || frame?.type === 'end') {
          followers.delete(ws)
          ws.close()
        }
      })
      ws.on('close', () => followers.delete(ws))
    })
  })

  return {
    server,
    dial() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
      })
    },
    close() {
      for (const ws of followers) {
        try {
          ws.close()
        } catch {
          /* already closed */
        }
      }
      return new Promise((resolve) => {
        wss.close(() => server.close(() => resolve()))
      })
    },
    reset() {
      events.length = 0
      seq = 0
      sessions = []
    },
    launchUrl(base) {
      return `${base}/?token=${LAUNCH_TOKEN}`
    }
  }
}

async function connectMesh(url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'dsh-mesh-channel-e2e', version: '0.0.1' })
  await client.connect(transport)
  return client
}

function parsed(result) {
  const text = result?.content?.find?.((c) => c.type === 'text')?.text
  return JSON.parse(text)
}

export async function runE2eChannel() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mesh-channel-'))
  const mock = startMockDsh()
  const mockBase = await mock.dial()
  const launchUrl = mock.launchUrl(mockBase)
  let meshClient
  let srv

  try {
    // ---- client level -------------------------------------------------------
    await check('client.login exchanges the launch URL for a cookie', async () => {
      const client = new DshWebClient({ log: quiet })
      const { baseUrl } = await client.login(launchUrl)
      assert(baseUrl === mockBase, `unexpected origin ${baseUrl}`)
      assert(client.cookie === COOKIE, `unexpected cookie ${client.cookie}`)
    })

    await check('bad launch token is rejected (bad sample)', async () => {
      const client = new DshWebClient({ log: quiet })
      let failed = false
      try {
        await client.login(`${mockBase}/?token=${'B'.repeat(43)}`)
      } catch (error) {
        failed = error instanceof DshError && error.code === 'E_DSH_AUTH'
      }
      assert(failed, 'invalid launch token was accepted')
    })

    await check('rpc without a cookie fails fast (bad sample)', async () => {
      const client = new DshWebClient({ baseUrl: mockBase, log: quiet })
      let code = ''
      try {
        await client.listSessions()
      } catch (error) {
        code = error.code
      }
      assert(code === 'E_DSH_NO_COOKIE', `expected E_DSH_NO_COOKIE, got ${code}`)
    })

    await check('session/create -> prompt -> page returns the assistant reply', async () => {
      const client = new DshWebClient({ log: quiet })
      await client.login(launchUrl)
      const sessionId = await client.createSession()
      const result = await client.sendAndWait({ sessionId, text: 'ping', waitMs: 20000, pollMs: 200 })
      assert(result.turnEnd.kind === 'completed', `unexpected turn end ${JSON.stringify(result.turnEnd)}`)
      assert(result.reply.includes('echo: ping'), `reply missing echo: ${result.reply}`)
      assert(result.reply.includes('MESH-CHANNEL-OK'), `reply missing marker: ${result.reply}`)
    })

    await check('HTTP 401 from the host surfaces as E_DSH_HTTP (bad sample)', async () => {
      const client = new DshWebClient({ baseUrl: mockBase, cookie: 'stale=1', log: quiet })
      let code = ''
      try {
        await client.listSessions()
      } catch (error) {
        code = error.code
      }
      assert(code === 'E_DSH_HTTP', `expected E_DSH_HTTP, got ${code}`)
    })

    // ---- mesh tools level ---------------------------------------------------
    mock.reset()
    const config = defaultConfig()
    config.node = { ...config.node, name: 'channel-e2e', bind: '127.0.0.1', port: 0, path: '/mcp' }
    config.acl.allow = [...config.acl.allow, 'channel_login', 'channel_send', 'channel_cancel']
    config.dsh.targets = [{ id: 'mock-dsh', baseUrl: mockBase }]
    writeFileSync(configPath(home), JSON.stringify(config, null, 2) + '\n', 'utf8')
    const stamp = new Date(Date.now() + 5000)
    utimesSync(configPath(home), stamp, stamp)
    const secrets = loadSecrets(home)
    srv = await startMeshServer({ home, log: quiet })
    meshClient = await connectMesh(srv.url, secrets.inbound[0].token)

    await check('channel_targets lists the configured target without a cookie', async () => {
      const data = parsed(await meshClient.callTool({ name: 'channel_targets', arguments: {} }))
      const target = data.targets.find((t) => t.id === 'mock-dsh')
      assert(target, 'configured target not listed')
      assert(target.hasCookie === false, 'cookie should not exist yet')
    })

    await check('channel_send before login returns E_DSH_NO_COOKIE', async () => {
      const data = parsed(
        await meshClient.callTool({ name: 'channel_send', arguments: { target: 'mock-dsh', text: 'hi' } })
      )
      assert(data.code === 'E_DSH_NO_COOKIE', `expected E_DSH_NO_COOKIE, got ${data.code}`)
    })

    await check('channel_login stores the cookie in secrets.json (0600, gitignored)', async () => {
      const data = parsed(
        await meshClient.callTool({ name: 'channel_login', arguments: { launchUrl, target: 'mock-dsh' } })
      )
      assert(data.target === 'mock-dsh', `unexpected target ${data.target}`)
      assert(data.baseUrl === mockBase, `unexpected baseUrl ${data.baseUrl}`)
      const raw = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(home, 'secrets.json'), 'utf8')))
      assert(raw.dshWeb?.['mock-dsh']?.cookie === COOKIE, 'cookie was not persisted')
    })

    await check('channel_login without a target derives dsh-<port>', async () => {
      const data = parsed(await meshClient.callTool({ name: 'channel_login', arguments: { launchUrl } }))
      const port = new URL(mockBase).port
      assert(data.target === `dsh-${port}`, `unexpected derived target ${data.target}`)
    })

    await check('channel_sessions lists the mock session after create', async () => {
      const created = parsed(
        await meshClient.callTool({ name: 'channel_send', arguments: { target: 'mock-dsh', text: 'wake up' } })
      )
      assert(created.reply.includes('MESH-CHANNEL-OK'), `unexpected reply ${created.reply}`)
      const data = parsed(await meshClient.callTool({ name: 'channel_sessions', arguments: { target: 'mock-dsh' } }))
      assert(data.count >= 1, 'no sessions listed')
      assert(data.sessions[0].sessionId.length > 0, 'session id missing')
    })

    await check('channel_page returns a compact event list', async () => {
      const sessions = parsed(await meshClient.callTool({ name: 'channel_sessions', arguments: { target: 'mock-dsh' } }))
      const sessionId = sessions.sessions[0].sessionId
      const data = parsed(await meshClient.callTool({ name: 'channel_page', arguments: { target: 'mock-dsh', sessionId } }))
      const types = data.events.map((e) => e.type)
      assert(types.includes('user/message'), 'missing user/message')
      assert(types.includes('assistant/message'), 'missing assistant/message')
      assert(types.includes('turn/end'), 'missing turn/end')
    })

    await check('channel_send to an unknown target returns E_NOT_FOUND (bad sample)', async () => {
      const data = parsed(
        await meshClient.callTool({ name: 'channel_send', arguments: { target: 'nope', text: 'x' } })
      )
      assert(data.code === 'E_NOT_FOUND', `expected E_NOT_FOUND, got ${data.code}`)
    })

    await check('channel_send is denied by ACL until a human allows it (bad sample)', async () => {
      const before = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(configPath(home), 'utf8')))
      const next = {
        ...before,
        acl: { ...before.acl, allow: before.acl.allow.filter((n) => n !== 'channel_send') }
      }
      writeFileSync(configPath(home), JSON.stringify(next, null, 2) + '\n', 'utf8')
      const bump = new Date(Date.now() + 8000)
      utimesSync(configPath(home), bump, bump)
      // wait for the mtime-based reload
      await new Promise((r) => setTimeout(r, 300))
      const data = parsed(
        await meshClient.callTool({ name: 'channel_send', arguments: { target: 'mock-dsh', text: 'blocked' } })
      )
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })

    await check('channel calls land in the audit log', async () => {
      const data = parsed(
        await meshClient.callTool({ name: 'mesh_audit_tail', arguments: { limit: 200, tool: 'channel_send' } })
      )
      assert(data.entries.some((e) => e.tool === 'channel_send' && e.code === 'E_DENIED'), 'denied channel call not audited')
    })
  } finally {
    try {
      await meshClient?.close?.()
    } catch {
      /* ignore */
    }
    if (srv) await srv.close()
    await mock.close()
    rmSync(home, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\ne2e-channel: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.error}`)
    return 1
  }
  return 0
}

if (process.argv[1]?.endsWith('e2e-channel.js')) {
  runE2eChannel().then((code) => process.exit(code))
}
