import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { defaultConfig, loadSecrets, configPath } from './core/config.js'
import { startMeshServer } from './server.js'

/**
 * End-to-end test for the host bridge (M3.2 + M4, route B).
 *
 * A mock stand-in for the `dsh-mesh-host` plugin speaks the exact loopback
 * endpoints the real plugin exposes (/host/ping|self|tools|agents|tools/call|wake),
 * so the mesh-side client, the ACL, the E2E wiring and the failure modes can all be
 * exercised without booting DSH.
 *
 * Usage: node src/e2e-host.js
 */

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const TOKEN = 'h'.repeat(64)
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

/** Mock of the in-DSH plugin. Auth, routing and error shapes mirror the real one. */
function startMockHost({ token = TOKEN } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && url.pathname === '/host/ping') return send(200, { ok: true, plugin: 'mock-0.1.0' })
    const auth = String(req.headers.authorization || '')
    if (auth !== `Bearer ${token}`) return send(401, { ok: false, code: 'E_HOST_AUTH', message: 'bad token' })
    if (req.method === 'GET' && url.pathname === '/host/self') {
      return send(200, {
        ok: true,
        plugin: 'mock-0.1.0',
        node: { hostname: 'mock-host', platform: 'win32', pid: 4242 },
        tools: ['read', 'write', 'shell'],
        agents: [{ id: 'sess-1', status: 'idle', title: 'mock session' }]
      })
    }
    if (req.method === 'GET' && url.pathname === '/host/tools') {
      return send(200, {
        ok: true,
        tools: [
          { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
          { name: 'write', description: 'Write a file', parameters: { type: 'object' } },
          { name: 'shell', description: 'Run a shell command', parameters: { type: 'object' } }
        ]
      })
    }
    if (req.method === 'GET' && url.pathname === '/host/agents') {
      return send(200, {
        ok: true,
        agents: [
          { id: 'sess-1', status: 'idle', title: 'mock session' },
          { id: 'sess-2', status: 'running', title: 'busy session' }
        ]
      })
    }
    if (req.method === 'GET' && url.pathname === '/host/sessions') {
      return send(200, {
        ok: true,
        sessions: [
          { sessionId: 'sess-1', title: 'mock session', state: 'idle', agentAvailable: true, cwd: '/tmp/mock' },
          { sessionId: 'sess-sched', title: '定时-库存同步', state: 'idle', agentAvailable: true, cwd: '/tmp/mock' },
          { sessionId: 'sess-deleg', title: 'delegated task', state: 'idle', agentAvailable: true, cwd: '/tmp/mock' }
        ]
      })
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        return send(400, { ok: false, code: 'E_INVALID_ARG', message: 'body must be JSON' })
      }
      calls.push({ path: url.pathname, payload })
      if (url.pathname === '/host/tools/call') {
        if (payload.tool === 'read') return send(200, { ok: true, value: { path: payload.arguments?.path, text: 'mock file body' }, content: [] })
        if (payload.tool === 'shell') return send(200, { ok: false, code: 'E_DENIED', message: 'host policy denied shell' })
        return send(404, { ok: false, code: 'E_NOT_FOUND', message: `no such tool in this host: ${payload.tool}` })
      }
      if (url.pathname === '/host/wake') {
        if (payload.sessionId !== 'sess-1') return send(404, { ok: false, code: 'E_NOT_FOUND', message: `no such session: ${payload.sessionId}` })
        return send(200, {
          ok: true,
          sessionId: payload.sessionId,
          target: payload.target || 'next-turn',
          messageId: 'mock-message-id',
          statusBefore: 'idle',
          wokeUp: true,
          delivered: true
        })
      }
      return send(404, { ok: false, code: 'E_NOT_FOUND', message: 'unknown endpoint' })
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        reset: () => { calls.length = 0 },
        close: () => new Promise(r => server.close(r))
      })
    })
  })
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

async function connectMesh(url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'mesh-host-e2e', version: '0.0.0' })
  await client.connect(transport)
  return client
}

/** Rewrite config.json and force a fresh mtime so the hot reloader picks it up. */
function patchConfig(home, mutate) {
  const config = JSON.parse(await_read(configPath(home)))
  mutate(config)
  writeFileSync(configPath(home), JSON.stringify(config, null, 2) + '\n', 'utf8')
  const stamp = new Date(Date.now() + Math.floor(Math.random() * 1000) + 500)
  utimesSync(configPath(home), stamp, stamp)
}

// tiny sync reader helper (kept local so the file has one import style)
import { readFileSync } from 'node:fs'
function await_read(path) {
  return readFileSync(path, 'utf8')
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'mesh-host-e2e-'))
  let mock = null
  let srv = null
  let client = null
  try {
    mock = await startMockHost()
    writeFileSync(join(home, 'host-token'), `${TOKEN}\n`, 'utf8')

    const config = defaultConfig()
    config.node = { ...config.node, name: 'host-e2e', bind: '127.0.0.1', port: 0, path: '/mcp' }
    // Delegation-safety fixtures: a fake DSH home with one scheduled session and
    // one session created by an earlier delegation.
    const dshHome = join(home, 'dsh0home')
    mkdirSync(join(dshHome, 'storages'), { recursive: true })
    writeFileSync(
      join(dshHome, 'storages', 'schedule.json'),
      JSON.stringify(
        {
          unit: { name: 'schedule', version: 1 },
          tables: {
            tasks: {
              'schedule-mock': {
                sessionId: 'sess-sched',
                status: 'active',
                record: { id: 'schedule-mock', kind: 'every', title: '定时-库存同步' }
              }
            }
          }
        },
        null,
        2
      ),
      'utf8'
    )
    mkdirSync(join(home, '.mesh', 'tasks', 'T-MOCK'), { recursive: true })
    writeFileSync(
      join(home, '.mesh', 'tasks', 'T-MOCK', 'request.json'),
      JSON.stringify(
        {
          taskId: 'T-MOCK',
          conversationId: 'C-MOCK',
          from: 'peer',
          sessionId: 'sess-deleg',
          instance: 'dsh0',
          sessionPolicy: 'new',
          requestedAt: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    )
    config.hosts = [
      {
        id: 'dsh0',
        label: 'mock host',
        enabled: true,
        url: mock.url,
        tokenFile: join(home, 'host-token'),
        timeoutMs: 10000,
        profileDir: join(dshHome, 'profiles', 'web')
      }
    ]
    config.acl = { ...config.acl, fsRoots: [home] }
    writeFileSync(configPath(home), JSON.stringify(config, null, 2) + '\n', 'utf8')
    const secrets = loadSecrets(home)
    srv = await startMeshServer({ home, log: quiet })
    client = await connectMesh(srv.url, secrets.inbound[0].token)

    await check('host_instances lists configured bridges and pings each', async () => {
      const data = parsed(await client.callTool({ name: 'host_instances', arguments: {} }))
      assert(data.count === 1, `expected 1 instance, got ${data.count}`)
      const row = data.instances[0]
      assert(row.id === 'dsh0', `unexpected id ${row.id}`)
      assert(row.alive === true, 'mock bridge should be alive')
      assert(String(row.tokenFile).endsWith('host-token'), `unexpected tokenFile ${row.tokenFile}`)
    })

    await check('unknown host instance fails loud with E_HOST_UNKNOWN', async () => {
      const data = parsed(await client.callTool({ name: 'host_self', arguments: { instance: 'dsh9' } }))
      assert(data.code === 'E_HOST_UNKNOWN', `expected E_HOST_UNKNOWN, got ${data.code}`)
    })

    await check('host_call is denied by default ACL (write-capable tool)', async () => {
      const data = parsed(await client.callTool({ name: 'host_call', arguments: { tool: 'read', arguments: {} } }))
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })

    await check('channel_wake is denied by default ACL (injects into a live session)', async () => {
      const data = parsed(
        await client.callTool({ name: 'channel_wake', arguments: { sessionId: 'sess-1', text: 'hi' } })
      )
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })

    await check('host_self reports the bridge instance, tool count and agents', async () => {
      const data = parsed(await client.callTool({ name: 'host_self', arguments: {} }))
      assert(data.ok === true, 'host_self failed')
      assert(data.node.hostname === 'mock-host', `unexpected hostname ${data.node?.hostname}`)
      assert(data.tools.length === 3, `expected 3 tools, got ${data.tools.length}`)
      assert(data.agents[0].status === 'idle', 'agent status missing')
    })

    await check('host_tools lists name/description/parameters and filters by search', async () => {
      const all = parsed(await client.callTool({ name: 'host_tools', arguments: {} }))
      assert(all.count === 3, `expected 3 tools, got ${all.count}`)
      assert(all.tools.every(t => 'name' in t && 'description' in t), 'tool fields missing')
      const filtered = parsed(await client.callTool({ name: 'host_tools', arguments: { search: 'sh' } }))
      assert(filtered.count === 1 && filtered.tools[0].name === 'shell', `unexpected filter result ${JSON.stringify(filtered)}`)
    })

    await check('channel_agents lists live sessions and filters by sessionId', async () => {
      const all = parsed(await client.callTool({ name: 'channel_agents', arguments: {} }))
      assert(all.count === 2, `expected 2 agents, got ${all.count}`)
      const one = parsed(await client.callTool({ name: 'channel_agents', arguments: { sessionId: 'sess-2' } }))
      assert(one.count === 1 && one.agents[0].status === 'running', 'session filter failed')
    })

    // opt in to the write-capable tools, exactly as a human would in config.json
    patchConfig(home, c => {
      c.acl.allow = [...c.acl.allow, 'host_call', 'channel_wake']
    })

    await check('host_call runs a host tool after explicit ACL opt-in', async () => {
      const data = parsed(
        await client.callTool({ name: 'host_call', arguments: { tool: 'read', arguments: { path: 'C:/tmp/a.txt' } } })
      )
      assert(data.ok === true, `host_call failed: ${JSON.stringify(data)}`)
      assert(data.value.text === 'mock file body', `unexpected value ${JSON.stringify(data.value)}`)
      assert(mock.calls.some(c => c.path === '/host/tools/call'), 'bridge was not called')
    })

    await check('host_call surfaces a host-side failure code (bad sample)', async () => {
      const data = parsed(await client.callTool({ name: 'host_call', arguments: { tool: 'shell', arguments: {} } }))
      assert(data.code === 'E_DENIED', `expected host E_DENIED, got ${data.code}`)
    })

    await check('host_call unknown tool returns E_NOT_FOUND without running it', async () => {
      const data = parsed(await client.callTool({ name: 'host_call', arguments: { tool: 'nope', arguments: {} } }))
      assert(data.code === 'E_NOT_FOUND', `expected E_NOT_FOUND, got ${data.code}`)
    })

    await check('channel_wake injects into an idle session and reports wokeUp', async () => {
      const data = parsed(
        await client.callTool({ name: 'channel_wake', arguments: { sessionId: 'sess-1', text: 'MESH-WAKE-OK' } })
      )
      assert(data.ok === true, `channel_wake failed: ${JSON.stringify(data)}`)
      assert(data.wokeUp === true, 'wake should report the idle session as woken')
      assert(data.messageId === 'mock-message-id', 'messageId missing')
      const sent = mock.calls.find(c => c.path === '/host/wake')
      assert(sent.payload.text === 'MESH-WAKE-OK', 'text was not forwarded')
    })

    await check('channel_wake on an unknown session returns E_NOT_FOUND (bad sample)', async () => {
      const data = parsed(await client.callTool({ name: 'channel_wake', arguments: { sessionId: 'ghost', text: 'x' } }))
      assert(data.code === 'E_NOT_FOUND', `expected E_NOT_FOUND, got ${data.code}`)
    })

    await check('host_sessions marks a scheduled session protected (business-scheduled)', async () => {
      const data = parsed(await client.callTool({ name: 'host_sessions', arguments: { includeEnded: true } }))
      const rows = data.sessions || []
      const sched = rows.find((row) => row.sessionId === 'sess-sched')
      const deleg = rows.find((row) => row.sessionId === 'sess-deleg')
      assert(sched?.protected === true, `expected protected sess-sched, got ${JSON.stringify(sched)}`)
      assert(sched.kind === 'business-scheduled', `expected business-scheduled, got ${sched.kind}`)
      assert(String(sched.reason).includes('scheduled'), 'reason should explain the schedule')
      assert(deleg?.kind === 'delegation', `expected delegation kind, got ${deleg?.kind}`)
      assert(deleg.protected === false, 'a delegation session is not protected')
      assert(data.protectedCount === 1, `expected protectedCount=1, got ${data.protectedCount}`)
    })

    await check('channel_wake refuses a session that owns scheduled tasks (bad sample)', async () => {
      const data = parsed(await client.callTool({ name: 'channel_wake', arguments: { sessionId: 'sess-sched', text: 'x' } }))
      assert(data.code === 'E_SESSION_PROTECTED', `expected E_SESSION_PROTECTED, got ${data.code}`)
      assert(Array.isArray(data.schedules) && data.schedules.length === 1, 'refusal must list schedule evidence')
      assert(String(data.hint || '').includes('FRESH conversation'), 'refusal should suggest a fresh conversation')
    })

    await check('channel_wake force:true bypasses the scheduled-session guard', async () => {
      mock.reset()
      const data = parsed(await client.callTool({ name: 'channel_wake', arguments: { sessionId: 'sess-sched', text: 'x', force: true } }))
      assert(data.code !== 'E_SESSION_PROTECTED', `force should bypass the guard, got ${data.code}`)
      assert(
        mock.calls.some((call) => call.path === '/host/wake' && call.payload.sessionId === 'sess-sched'),
        'force should reach the bridge'
      )
    })

    await check('delegate refuses to continue a scheduled session (bad sample)', async () => {
      const data = parsed(await client.callTool({ name: 'delegate', arguments: { goal: 'check state', sessionId: 'sess-sched' } }))
      assert(data.code === 'E_SESSION_PROTECTED', `expected E_SESSION_PROTECTED, got ${data.code}`)
    })

    await check('delegate_candidates exposes delegation vs business-scheduled kinds', async () => {
      const data = parsed(await client.callTool({ name: 'delegate_candidates', arguments: { includeEnded: true, limit: 50 } }))
      const rows = data.sessions || []
      const sched = rows.find((row) => row.sessionId === 'sess-sched')
      const deleg = rows.find((row) => row.sessionId === 'sess-deleg')
      assert(sched?.protected === true, 'candidates must mark protected sessions')
      assert(sched.delegatable === false, 'a protected session must not be delegatable')
      assert(deleg?.kind === 'delegation', `expected delegation kind, got ${deleg?.kind}`)
      assert(deleg.recommended === true, 'an idle safe session should be recommended')
    })

    await check('missing host token surfaces E_HOST_NO_TOKEN with a fix hint', async () => {
      renameSync(join(home, 'host-token'), join(home, 'host-token.off'))
      const data = parsed(await client.callTool({ name: 'host_self', arguments: {} }))
      assert(data.code === 'E_HOST_NO_TOKEN', `expected E_HOST_NO_TOKEN, got ${data.code}`)
      assert(String(data.message || '').includes('host-token'), 'hint should name the token file')
      renameSync(join(home, 'host-token.off'), join(home, 'host-token'))
    })

    await check('bridge down surfaces E_HOST_OFFLINE and marks it retryable', async () => {
      await mock.close()
      mock = null
      const data = parsed(await client.callTool({ name: 'host_self', arguments: {} }))
      assert(data.code === 'E_HOST_OFFLINE', `expected E_HOST_OFFLINE, got ${data.code}`)
      assert(data.retryable === true, 'offline should be retryable')
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
    if (mock) await mock.close()
    rmSync(home, { recursive: true, force: true })
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`FAILED: ${f.name} — ${f.error}`)
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
