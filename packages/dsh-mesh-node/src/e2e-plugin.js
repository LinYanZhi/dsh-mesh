// e2e: the in-process host bridge plugin (plugin/lib/index.js), exercised with a mock ctx.
// The plugin normally runs inside DSH; here we inject fake `tools` + `agents` services so every
// endpoint, auth path and error mapping is covered without a real DSH process.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, PLUGIN_VERSION } from '../plugin/lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-mesh-plugin-'))
const port = 19000 + Math.floor(Math.random() * 800)
const base = `http://127.0.0.1:${port}`
process.env.DSH_MESH_HOME = home
process.env.DSH_MESH_HOST_PORT = String(port)
process.env.DSH_MESH_HOST_TOKEN_FILE = join(home, 'host-token')

// ---------- mock host services ----------
const executed = []
const sent = []
const toolMap = new Map([
  ['echo', { name: 'echo' }],
  ['deny', { name: 'deny' }],
  ['boom', { name: 'boom' }],
  ['slow', { name: 'slow' }]
])
const tools = {
  schemas: () => [...toolMap.values()].map(t => ({ name: t.name, description: `${t.name} tool`, parameters: null })),
  get: name => toolMap.get(name),
  execute: async input => {
    executed.push(input)
    if (input.name === 'echo') return { isError: false, value: { echoed: input.arguments }, content: [] }
    if (input.name === 'deny') return { isError: true, error: { code: 'E_DENIED', message: 'denied by ACL' }, content: [] }
    if (input.name === 'slow') return { isError: false, value: { waited: true }, content: [] }
    throw Object.assign(new Error('exploded'), { code: 'E_BOOM' })
  }
}

function makeAgent(id, status, opts = {}) {
  const agent = {
    id,
    status,
    session: { title: opts.title ?? `title-${id}`, seq: opts.seq ?? 1 }
  }
  if (opts.sendless !== true) {
    agent.send = (message, target, wakeup) => sent.push({ kind: 'send', id, message, target, wakeup })
  } else {
    agent.followup = message => sent.push({ kind: 'followup', id, message })
  }
  return agent
}

const agentMap = new Map([
  ['sess-running', makeAgent('sess-running', 'running', { seq: 7 })],
  ['sess-idle', makeAgent('sess-idle', 'idle')],
  ['sess-followup', makeAgent('sess-followup', 'running', { sendless: true })]
])
const agents = { get: id => agentMap.get(id), list: () => [...agentMap.values()] }

// sessionController is the path the web UI's "new chat" uses; the plugin only
// reaches it through ctx.get (optional service, so old profiles still load).
const sessionCalls = []
const sessionController = {
  create: async request => {
    sessionCalls.push({ kind: 'create', request })
    return { sessionId: request?.sessionId || 'sess-created', agentPreset: request?.agentPreset || 'default' }
  },
  prompt: async (request, signal) => {
    sessionCalls.push({ kind: 'prompt', request, signal })
    return { accepted: true }
  }
}

let dispose
const ctx = {
  tools,
  agents,
  get: name => (name === 'sessionController' ? sessionController : undefined),
  effect: factory => {
    dispose = factory()
  }
}
apply(ctx)

// ---------- helpers ----------
const auth = () => ({ authorization: `Bearer ${readFileSync(join(home, 'host-token'), 'utf8').trim()}` })

async function call(method, path, { body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status: res.status, body: json }
}

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/host/ping`)
      if (res.ok) return
    } catch {
      /* not listening yet */
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('plugin listener never came up')
}

// ---------- checks ----------
const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('ping needs no token', async () => {
  await waitReady()
  const { status, body } = await call('GET', '/host/ping')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.plugin, PLUGIN_VERSION)
})

check('token file auto-created 0600', () => {
  const path = join(home, 'host-token')
  const token = readFileSync(path, 'utf8').trim()
  assert.match(token, /^[a-f0-9]{64}$/)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  return `${token.length} hex chars`
})

check('missing token → 401 E_AUTH', async () => {
  const { status, body } = await call('GET', '/host/self')
  assert.equal(status, 401)
  assert.equal(body.code, 'E_AUTH')
})

check('wrong token → 401', async () => {
  const { status } = await call('GET', '/host/self', { headers: { authorization: 'Bearer nope' } })
  assert.equal(status, 401)
})

check('self reports tools + agents + node', async () => {
  const { status, body } = await call('GET', '/host/self', { headers: auth() })
  assert.equal(status, 200)
  assert.deepEqual(body.tools.sort(), ['boom', 'deny', 'echo', 'slow'])
  assert.equal(body.agents.length, 3)
  assert.equal(body.node.pid, process.pid)
  assert.ok(body.now)
})

check('host/tools returns schemas', async () => {
  const { body } = await call('GET', '/host/tools', { headers: auth() })
  assert.equal(body.tools.length, 4)
  assert.deepEqual(Object.keys(body.tools[0]).sort(), ['description', 'name', 'parameters'])
})

check('host/agents exposes status/title/seq', async () => {
  const { body } = await call('GET', '/host/agents', { headers: auth() })
  const running = body.agents.find(a => a.id === 'sess-running')
  assert.equal(running.status, 'running')
  assert.equal(running.title, 'title-sess-running')
  assert.equal(running.seq, 7)
})

check('tools/call happy path → value', async () => {
  const { status, body } = await call('POST', '/host/tools/call', {
    headers: auth(),
    body: { tool: 'echo', arguments: { hi: 1 } }
  })
  assert.equal(status, 200)
  assert.deepEqual(body, { ok: true, value: { echoed: { hi: 1 } }, content: [] })
  const last = executed.at(-1)
  assert.equal(last.name, 'echo')
  assert.match(last.callId, /^[0-9a-f-]{36}$/)
  assert.ok(last.signal instanceof AbortSignal)
})

check('tools/call unknown tool → 404 E_NOT_FOUND', async () => {
  const { status, body } = await call('POST', '/host/tools/call', { headers: auth(), body: { tool: 'nope' } })
  assert.equal(status, 404)
  assert.equal(body.code, 'E_NOT_FOUND')
})

check('tools/call maps isError → ok:false + code', async () => {
  const { status, body } = await call('POST', '/host/tools/call', { headers: auth(), body: { tool: 'deny' } })
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'E_DENIED')
  assert.equal(body.message, 'denied by ACL')
})

check('tools/call thrown error → ok:false E_BOOM', async () => {
  const { body } = await call('POST', '/host/tools/call', { headers: auth(), body: { tool: 'boom' } })
  assert.equal(body.ok, false)
  assert.equal(body.code, 'E_BOOM')
})

check('tools/call bad JSON → 400 E_INVALID_ARG', async () => {
  const { status, body } = await call('POST', '/host/tools/call', { headers: auth(), raw: '{oops' })
  assert.equal(status, 400)
  assert.equal(body.code, 'E_INVALID_ARG')
})

check('tools/call missing tool → 400', async () => {
  const { status, body } = await call('POST', '/host/tools/call', { headers: auth(), body: {} })
  assert.equal(status, 400)
  assert.equal(body.code, 'E_INVALID_ARG')
})

check('tools/call unknown sessionId → 404', async () => {
  const { status, body } = await call('POST', '/host/tools/call', {
    headers: auth(),
    body: { tool: 'echo', sessionId: 'ghost' }
  })
  assert.equal(status, 404)
  assert.equal(body.code, 'E_NOT_FOUND')
})

check('tools/call passes the live agent through', async () => {
  const { body } = await call('POST', '/host/tools/call', {
    headers: auth(),
    body: { tool: 'slow', sessionId: 'sess-running' }
  })
  assert.equal(body.ok, true)
  assert.equal(executed.at(-1).agent.id, 'sess-running')
})

check('sessions/create calls sessionController.create with cwd + preset', async () => {
  const { status, body } = await call('POST', '/host/sessions/create', {
    headers: auth(),
    body: { cwd: 'C:/work/repo', agentPreset: 'code' }
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'sess-created')
  assert.equal(body.agentPreset, 'code')
  const last = sessionCalls.at(-1)
  assert.equal(last.kind, 'create')
  assert.deepEqual(last.request, { cwd: 'C:/work/repo', agentPreset: 'code' })
})

check('sessions/create requires the host token', async () => {
  const { status, body } = await call('POST', '/host/sessions/create', { body: {} })
  assert.equal(status, 401)
  assert.equal(body.code, 'E_AUTH')
})

check('prompt calls sessionController.prompt with mode + text content', async () => {
  const { status, body } = await call('POST', '/host/prompt', {
    headers: auth(),
    body: { sessionId: 'sess-idle', text: 'do the thing', mode: 'steer', requestId: 'req-fixed-1' }
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'sess-idle')
  assert.equal(body.requestId, 'req-fixed-1')
  assert.equal(body.mode, 'steer')
  assert.equal(body.accepted, true)
  const last = sessionCalls.at(-1)
  assert.equal(last.kind, 'prompt')
  assert.deepEqual(last.request, {
    requestId: 'req-fixed-1',
    sessionId: 'sess-idle',
    mode: 'steer',
    content: [{ type: 'text', text: 'do the thing' }]
  })
})

check('prompt rejects empty text / missing session (bad sample)', async () => {
  const noText = await call('POST', '/host/prompt', { headers: auth(), body: { sessionId: 'sess-idle', text: '  ' } })
  assert.equal(noText.status, 400)
  const noSession = await call('POST', '/host/prompt', { headers: auth(), body: { text: 'hi' } })
  assert.equal(noSession.body.code, 'E_INVALID_ARG')
})

check('sessions/create + prompt fail loud without a sessionController (bad sample)', async () => {
  const saved = {
    home: process.env.DSH_MESH_HOME,
    port: process.env.DSH_MESH_HOST_PORT,
    token: process.env.DSH_MESH_HOST_TOKEN_FILE
  }
  const tmpPeerB = mkdtempSync(join(tmpdir(), 'dsh-mesh-plugin-noc-'))
  const port2 = port + 1
  const base2 = `http://127.0.0.1:${port2}`
  process.env.DSH_MESH_HOME = tmpPeerB
  process.env.DSH_MESH_HOST_PORT = String(port2)
  process.env.DSH_MESH_HOST_TOKEN_FILE = join(tmpPeerB, 'host-token')
  let dispose2
  apply({ tools, agents, effect: factory => { dispose2 = factory() } })
  try {
    for (let i = 0; i < 100; i += 1) {
      try {
        if ((await fetch(`${base2}/host/ping`)).ok) break
      } catch {
        /* not listening yet */
      }
      await new Promise(r => setTimeout(r, 50))
    }
    const token = readFileSync(join(tmpPeerB, 'host-token'), 'utf8').trim()
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
    const created = await fetch(`${base2}/host/sessions/create`, { method: 'POST', headers, body: '{}' })
    const createdBody = await created.json()
    assert.equal(created.status, 501)
    assert.equal(createdBody.code, 'E_HOST_NO_CONTROLLER')
    const prompted = await fetch(`${base2}/host/prompt`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's', text: 'x' }) })
    const promptedBody = await prompted.json()
    assert.equal(prompted.status, 501)
    assert.equal(promptedBody.code, 'E_HOST_NO_CONTROLLER')
  } finally {
    dispose2()
    process.env.DSH_MESH_HOME = saved.home
    process.env.DSH_MESH_HOST_PORT = saved.port
    process.env.DSH_MESH_HOST_TOKEN_FILE = saved.token
    rmSync(tmpPeerB, { recursive: true, force: true })
  }
})

check('wake running session: delivered, not wokeUp', async () => {
  const { body } = await call('POST', '/host/wake', {
    headers: auth(),
    body: { sessionId: 'sess-running', text: 'hello', target: 'next-step' }
  })
  assert.equal(body.ok, true)
  assert.equal(body.delivered, true)
  assert.equal(body.wokeUp, false)
  assert.equal(body.statusBefore, 'running')
  assert.equal(body.target, 'next-step')
  const evt = sent.at(-1)
  assert.equal(evt.kind, 'send')
  assert.equal(evt.wakeup, true)
  assert.equal(evt.target, 'next-step')
  assert.equal(evt.message.role, 'user')
  assert.deepEqual(evt.message.content, [{ type: 'text', text: 'hello' }])
  assert.ok(Object.isFrozen(evt.message), 'message must be deep-frozen like createUserMessage')
  assert.equal(evt.message.id, body.messageId)
})

check('wake idle session: wokeUp true + default target next-turn', async () => {
  const { body } = await call('POST', '/host/wake', {
    headers: auth(),
    body: { sessionId: 'sess-idle', text: 'wake up' }
  })
  assert.equal(body.wokeUp, true)
  assert.equal(body.target, 'next-turn')
  assert.equal(sent.at(-1).target, 'next-turn')
})

check('wake falls back to followup when no send()', async () => {
  const { body } = await call('POST', '/host/wake', {
    headers: auth(),
    body: { sessionId: 'sess-followup', text: 'fallback' }
  })
  assert.equal(body.ok, true)
  assert.equal(sent.at(-1).kind, 'followup')
})

check('wake missing text / unknown session → 4xx', async () => {
  const missing = await call('POST', '/host/wake', { headers: auth(), body: { sessionId: 'sess-idle' } })
  assert.equal(missing.status, 400)
  const ghost = await call('POST', '/host/wake', { headers: auth(), body: { sessionId: 'ghost', text: 'x' } })
  assert.equal(ghost.status, 404)
})

check('unknown endpoint → 404', async () => {
  const { status, body } = await call('GET', '/host/nope', { headers: auth() })
  assert.equal(status, 404)
  assert.equal(body.code, 'E_NOT_FOUND')
})

check('dispose closes the listener', async () => {
  assert.equal(typeof dispose, 'function')
  dispose()
  await new Promise(r => setTimeout(r, 100))
  await assert.rejects(() => fetch(`${base}/host/ping`))
})

// ---------- run ----------
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
rmSync(home, { recursive: true, force: true })
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed === 0 ? 0 : 1)
