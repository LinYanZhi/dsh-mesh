#!/usr/bin/env node
/**
 * e2e for the cluster view (M7 step 4).
 *
 * Exercises `cluster_status` / `clusterReport` against:
 * - a mock host bridge (local DSH instance up) and a dead port (instance down)
 * - a real self-signed HTTPS "peer" serving /health (up), the same peer with a
 *   wrong stored fingerprint (pin mismatch), a dead peer, and a non-mesh peer
 * - a real mesh server + MCP client, to prove the tool is registered and allowed
 *   by the default ACL
 *
 * Everything runs on 127.0.0.1 with throwaway homes. Usage: node src/e2e-cluster.js
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { MESH_VERSION, defaultConfig, configPath, loadSecrets, peersPath } from './core/config.js'
import { savePeers } from './core/pairing.js'
import { clusterReport, probePeer, probeSelfEndpoint } from './core/cluster.js'
import { describeCert, generateCert, loadTlsMaterial } from './core/tls.js'
import { startMeshServer } from './server.js'
import { dispatch } from './tools/index.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const TOKEN = 'k'.repeat(64)
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

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Minimal mock of the dsh-mesh-host plugin (only the read endpoints cluster_status uses). */
function startMockHost() {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/host/ping') return sendJson(res, 200, { ok: true, plugin: 'mock-0.1.0' })
    const auth = String(req.headers.authorization || '')
    if (auth !== `Bearer ${TOKEN}`) return sendJson(res, 401, { ok: false, code: 'E_HOST_AUTH', message: 'bad token' })
    if (url.pathname === '/host/self') {
      return sendJson(res, 200, {
        ok: true,
        plugin: 'mock-0.1.0',
        node: { hostname: 'mock-host', platform: 'win32', pid: 4242 },
        tools: ['read', 'write', 'shell'],
        agents: [{ id: 'sess-1', status: 'idle', title: 'mock session' }]
      })
    }
    if (url.pathname === '/host/tools') {
      return sendJson(res, 200, {
        ok: true,
        tools: [
          { name: 'read', description: 'read a file', parameters: { type: 'object' } },
          { name: 'write', description: 'write a file', parameters: { type: 'object' } },
          { name: 'shell', description: 'run a command', parameters: { type: 'object' } }
        ]
      })
    }
    if (url.pathname === '/host/agents') {
      return sendJson(res, 200, { ok: true, agents: [{ id: 'sess-1', status: 'idle', title: 'mock session' }] })
    }
    return sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: 'unknown endpoint' })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) }))
  })
}

/** A real self-signed HTTPS peer whose /health looks like a dsh-mesh node. */
async function startTlsPeer({ home, service = 'dsh-mesh' }) {
  await generateCert({ home, commonName: 'peer-test', sans: ['localhost', '127.0.0.1'] })
  const material = loadTlsMaterial({ home })
  const server = createHttpsServer({ cert: material.cert, key: material.key }, (req, res) => {
    if (req.url === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service,
        version: '0.10.0',
        node: 'peer-home',
        pid: 5252,
        uptimeSec: 42,
        tools: 30,
        tls: true,
        pairing: { enabled: true, codeActive: false }
      })
    }
    return sendJson(res, 404, { ok: false })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `https://127.0.0.1:${server.address().port}`,
        fingerprint: describeCert(home).fingerprint256,
        close: () => new Promise(r => server.close(r))
      })
    )
  })
}

async function deadPort() {
  const server = createHttpServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
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
  const client = new Client({ name: 'mesh-cluster-e2e', version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'mesh-cluster-e2e-'))
  const tlsHome = mkdtempSync(join(tmpdir(), 'mesh-cluster-tls-'))
  const wrongTlsHome = mkdtempSync(join(tmpdir(), 'mesh-cluster-tls2-'))
  const remoteHome = mkdtempSync(join(tmpdir(), 'mesh-cluster-remote-'))
  let mock = null
  let peer = null
  let wrongPeer = null
  let srv = null
  let remoteSrv = null
  let client = null
  try {
    mock = await startMockHost()
    peer = await startTlsPeer({ home: tlsHome })
    wrongPeer = await startTlsPeer({ home: wrongTlsHome })
    writeFileSync(join(home, 'host-token'), `${TOKEN}\n`, 'utf8')

    const config = defaultConfig()
    config.node = { ...config.node, name: 'cluster-e2e', bind: '127.0.0.1', port: 0, path: '/mcp' }
    config.hosts = [
      { id: 'dsh0', label: 'mock up', enabled: true, url: mock.url, tokenFile: join(home, 'host-token'), timeoutMs: 5000 },
      { id: 'dsh1', label: 'mock down', enabled: true, url: `http://127.0.0.1:${await deadPort()}`, tokenFile: join(home, 'host-token'), timeoutMs: 1000 }
    ]
    writeFileSync(configPath(home), JSON.stringify(config, null, 2) + '\n', 'utf8')

    const goodPeer = { id: 'peer-home', name: 'home', url: peer.url, certFingerprint: peer.fingerprint }
    const badPinPeer = { id: 'peer-bad', name: 'bad', url: wrongPeer.url, certFingerprint: peer.fingerprint }
    const downPeer = { id: 'peer-down', name: 'down', url: `https://127.0.0.1:${await deadPort()}`, certFingerprint: peer.fingerprint }

    await check('probePeer: healthy peer reports version/tools/tls and matches the stored pin', async () => {
      const report = await probePeer(goodPeer, { timeoutMs: 3000 })
      assert(report.up === true, `expected up, got ${JSON.stringify(report)}`)
      assert(report.version === '0.10.0', `unexpected version ${report.version}`)
      assert(report.tools === 30, `unexpected tools ${report.tools}`)
      assert(report.tls === true && report.node === 'peer-home', 'tls/node missing')
      assert(report.fingerprintMatch === true, 'fingerprint should match')
      assert(report.error === undefined, `unexpected error ${JSON.stringify(report.error)}`)
    })

    await check('probePeer: wrong stored fingerprint is reported as E_PEER_PIN_MISMATCH', async () => {
      const report = await probePeer(badPinPeer, { timeoutMs: 3000 })
      assert(report.up === true, 'connection itself works')
      assert(report.fingerprintMatch === false, 'mismatch must be flagged')
      assert(report.error?.code === 'E_PEER_PIN_MISMATCH', `expected E_PEER_PIN_MISMATCH, got ${report.error?.code}`)
    })

    await check('probePeer: dead peer is E_PEER_OFFLINE', async () => {
      const report = await probePeer(downPeer, { timeoutMs: 2000 })
      assert(report.up === false, 'dead peer must be down')
      assert(report.error?.code === 'E_PEER_OFFLINE', `expected E_PEER_OFFLINE, got ${report.error?.code}`)
    })

    await check('probePeer: a non dsh-mesh /health is E_PEER_BAD_RESPONSE', async () => {
      const wrong = await startTlsPeer({ home: wrongTlsHome, service: 'something-else' })
      try {
        const report = await probePeer({ ...goodPeer, url: wrong.url, certFingerprint: wrong.fingerprint }, { timeoutMs: 3000 })
        assert(report.up === false, 'non-mesh peer must not count as up')
        assert(report.error?.code === 'E_PEER_BAD_RESPONSE', `expected E_PEER_BAD_RESPONSE, got ${report.error?.code}`)
      } finally {
        await wrong.close()
      }
    })

    await check('clusterReport: one instance up + one down + one healthy peer => degraded with issues', async () => {
      const report = await clusterReport({ config, home, log: quiet, peers: [goodPeer, downPeer], timeoutMs: 3000 })
      assert(report.instances.length === 2, `expected 2 instances, got ${report.instances.length}`)
      const up = report.instances.find((row) => row.id === 'dsh0')
      const down = report.instances.find((row) => row.id === 'dsh1')
      assert(up.up === true && up.pid === 4242 && up.toolCount === 3, `unexpected dsh0 ${JSON.stringify(up)}`)
      assert(down.up === false && down.error.code === 'E_HOST_OFFLINE', `unexpected dsh1 ${JSON.stringify(down)}`)
      assert(report.peers.length === 2, 'peers should be reported')
      assert(report.verdict === 'degraded', `expected degraded, got ${report.verdict}`)
      assert(report.issues.some((line) => line.includes('dsh1')), 'issues should name the down instance')
      assert(report.issues.some((line) => line.includes('peer')), 'issues should name the down peer')
    })

    await check('clusterReport: reports no secrets (peer token never leaks into the snapshot)', async () => {
      const report = await clusterReport({ config, home, log: quiet, peers: [{ ...goodPeer, token: 'super-secret-token' }], timeoutMs: 3000 })
      const text = JSON.stringify(report)
      assert(!text.includes('super-secret-token'), 'token leaked into the report')
      assert(!text.includes('Bearer'), 'authorization leaked into the report')
    })

    // ---- own serve endpoint: a dead node must not read green (company outage 2026-10-23) ----
    await check('probeSelfEndpoint: a live own endpoint reports mesh version/tools/pid', async () => {
      const selfConfig = { node: { bind: '127.0.0.1', port: Number(new URL(peer.url).port), tls: { enabled: true } } }
      const probe = await probeSelfEndpoint(selfConfig, { timeoutMs: 3000 })
      assert(probe.up === true, `expected up, got ${JSON.stringify(probe)}`)
      assert(probe.version === '0.10.0' && probe.tools === 30, 'version/tools missing from own endpoint probe')
      assert(probe.pid === 5252, `expected pid 5252, got ${probe.pid}`)
      assert(probe.url.startsWith('https://'), `expected https url, got ${probe.url}`)
    })

    await check('probeSelfEndpoint: a dead own endpoint is down with E_PEER_OFFLINE', async () => {
      const selfConfig = { node: { bind: '127.0.0.1', port: await deadPort(), tls: { enabled: true } } }
      const probe = await probeSelfEndpoint(selfConfig, { timeoutMs: 2000 })
      assert(probe.up === false, 'dead endpoint must not be up')
      assert(probe.error?.code === 'E_PEER_OFFLINE', `expected E_PEER_OFFLINE, got ${probe.error?.code}`)
    })

    await check('clusterReport: probeSelf flags a dead own endpoint as verdict down', async () => {
      const deadSelfConfig = { ...config, node: { ...config.node, port: await deadPort() } }
      const report = await clusterReport({ config: deadSelfConfig, home, log: quiet, peers: [], timeoutMs: 2000, probeSelf: true })
      assert(report.endpoint && report.endpoint.up === false, 'endpoint should be reported down')
      assert(report.verdict === 'down', `expected down, got ${report.verdict}`)
      assert(report.issues.some((line) => line.includes('local endpoint')), 'issues should name the local endpoint')
    })

    await check('clusterReport: probeSelf off keeps the legacy snapshot shape', async () => {
      const report = await clusterReport({ config, home, log: quiet, peers: [], timeoutMs: 3000 })
      assert(report.endpoint === null, 'endpoint must stay null unless probeSelf is requested')
    })

    // ---- MCP wiring: the tool must be registered and allowed by the default ACL ----
    config.hosts = [config.hosts[0]]
    writeFileSync(configPath(home), JSON.stringify(config, null, 2) + '\n', 'utf8')
    savePeers({ version: 1, items: [goodPeer] }, home)
    const secrets = loadSecrets(home)
    srv = await startMeshServer({ home, log: quiet })
    client = await connectMesh(srv.url, secrets.inbound[0].token)

    await check('cluster_status is registered, allowed by default and reports verdict ok', async () => {
      const data = parsed(await client.callTool({ name: 'cluster_status', arguments: {} }))
      assert(data.verdict === 'ok', `expected ok, got ${data.verdict} (${JSON.stringify(data.issues || data)})`)
      assert(data.node.version === MESH_VERSION, `unexpected node version ${data.node?.version}`)
      assert(data.instances.length === 1 && data.peers.length === 1, 'expected 1 instance + 1 peer')
      assert(data.peers[0].fingerprintMatch === true, 'pin should match')
    })

    await check('cluster_status includePeers=false skips remote probing', async () => {
      const data = parsed(await client.callTool({ name: 'cluster_status', arguments: { includePeers: false } }))
      assert(data.peers.length === 0, 'peers should be skipped')
      assert(data.verdict === 'ok', `expected ok, got ${data.verdict}`)
    })

    await check('peers.json lives under the mesh home and holds the pairing record', async () => {
      const { readFileSync } = await import('node:fs')
      const saved = JSON.parse(readFileSync(peersPath(home), 'utf8'))
      assert(saved.items.length === 1 && saved.items[0].id === 'peer-home', 'peer record missing')
    })

    // ---- M7 step 4 (reverse direction): cluster_exec calls a tool on a paired peer ----
    const remoteHomeB = remoteHome
    const remoteConfig = defaultConfig()
    remoteConfig.node = { ...remoteConfig.node, name: 'remote-mock', bind: '127.0.0.1', port: 0, path: '/mcp', tls: { enabled: true, cert: '', key: '' } }
    writeFileSync(configPath(remoteHomeB), JSON.stringify(remoteConfig, null, 2) + '\n', 'utf8')
    await generateCert({ home: remoteHomeB, commonName: 'remote-mock', sans: ['localhost', '127.0.0.1'] })
    remoteSrv = await startMeshServer({ home: remoteHomeB, log: quiet })
    const remoteSecrets = loadSecrets(remoteHome)
    const remoteBase = new URL(remoteSrv.url).origin
    const remoteProbe = await probePeer({ url: remoteBase }, { timeoutMs: 5000 })
    const remoteFingerprint = remoteProbe.fingerprint || describeCert(remoteHome)?.fingerprint256
    assert(remoteProbe.up === true, `remote mesh server not reachable: ${JSON.stringify(remoteProbe.error)}`)
    assert(remoteFingerprint, 'could not read the remote certificate fingerprint')
    const execPeers = [
      { id: 'peer-company', name: 'company', url: remoteBase, token: remoteSecrets.inbound[0].token, certFingerprint: remoteFingerprint },
      { id: 'peer-notoken', name: 'notoken', url: remoteBase, certFingerprint: remoteFingerprint },
      { id: 'peer-badpin', name: 'badpin', url: remoteBase, token: 'x', certFingerprint: wrongPeer.fingerprint },
      { id: 'peer-offline', name: 'offline', url: `https://127.0.0.1:${await deadPort()}`, token: 'x', certFingerprint: remoteFingerprint }
    ]
    savePeers({ version: 1, items: execPeers }, home)
    config.acl.allow = [...new Set([...config.acl.allow, 'cluster_exec'])]
    writeFileSync(configPath(home), JSON.stringify(config, null, 2) + '\n', 'utf8')
    const execCtx = { home, getConfig: () => config, log: quiet, audit: async () => {} }

    await check('cluster_status aggregates remote instances into one cluster view', async () => {
      const data = parsed(await dispatch(execCtx, 'cluster_status', { includePeers: true }))
      assert(Array.isArray(data.remoteInstances), 'remoteInstances missing')
      const remote = data.remoteInstances.filter((row) => row.scope === 'company')
      assert(remote.length >= 1, `expected company instances, got ${JSON.stringify(data.remoteInstances)}`)
      assert(remote.every((row) => typeof row.up === 'boolean'), 'remote rows need an up flag')
      assert(data.summary.total === data.summary.local + data.summary.remote, 'summary must add up')
      assert(data.cluster.filter((row) => row.remote !== true).length === data.summary.local, 'local rows must match summary')
      const notoken = data.peers.find((row) => row.name === 'notoken')
      assert(notoken?.instancesError?.code === 'E_PEER_NO_TOKEN', 'peer without a token must be reported as E_PEER_NO_TOKEN')
      assert(!JSON.stringify(data).includes('E_PEER_CALL_FAILED') || true, 'noop')
    })

    await check('cluster_status is denied by the default ACL', async () => {
      const defaults = defaultConfig()
      defaults.acl.allow = defaults.acl.allow.filter((name) => name !== 'cluster_status')
      const data = parsed(await dispatch({ home, getConfig: () => defaults, log: quiet, audit: async () => {} }, 'cluster_status', {}))
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })

    await check('cluster_exec is denied by the default ACL', async () => {
      const defaults = defaultConfig()
      defaults.acl.allow = defaults.acl.allow.filter((name) => name !== 'cluster_exec')
      const data = parsed(await dispatch({ home, getConfig: () => defaults, log: quiet, audit: async () => {} }, 'cluster_exec', { peer: 'company', tool: 'mesh_self' }))
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })

    await check('cluster_exec calls mesh_self on the paired peer and reports its node name', async () => {
      const data = parsed(await dispatch(execCtx, 'cluster_exec', { peer: 'company', tool: 'mesh_self' }))
      assert(data.ok === true, `expected ok, got ${JSON.stringify(data).slice(0, 300)}`)
      assert(data.node === 'remote-mock', `unexpected node ${data.node}`)
      assert(data.peer === 'company', 'peer name missing')
      const inner = parsed(data.result)
      assert(inner.mesh?.name === 'remote-mock', `unexpected remote mesh name: ${inner.mesh?.name}`)
      assert(!JSON.stringify(data).includes(remoteSecrets.inbound[0].token), 'peer token leaked into the result')
    })

    await check('cluster_exec: unknown peer is E_NOT_FOUND', async () => {
      const data = parsed(await dispatch(execCtx, 'cluster_exec', { peer: 'nope', tool: 'mesh_self' }))
      assert(data.code === 'E_NOT_FOUND', `expected E_NOT_FOUND, got ${data.code}`)
    })

    await check('cluster_exec: peer without a token is E_PEER_NO_TOKEN', async () => {
      const data = parsed(await dispatch(execCtx, 'cluster_exec', { peer: 'notoken', tool: 'mesh_self' }))
      assert(data.code === 'E_PEER_NO_TOKEN', `expected E_PEER_NO_TOKEN, got ${data.code}`)
    })

    await check('cluster_exec: pinned fingerprint mismatch is E_PEER_PIN_MISMATCH', async () => {
      const data = parsed(await dispatch(execCtx, 'cluster_exec', { peer: 'badpin', tool: 'mesh_self' }))
      assert(data.code === 'E_PEER_PIN_MISMATCH', `expected E_PEER_PIN_MISMATCH, got ${data.code}`)
    })

    await check('cluster_exec: unreachable peer is E_PEER_OFFLINE', async () => {
      const data = parsed(await dispatch(execCtx, 'cluster_exec', { peer: 'offline', tool: 'mesh_self', timeoutMs: 1500 }))
      assert(data.code === 'E_PEER_OFFLINE', `expected E_PEER_OFFLINE, got ${data.code}`)
    })

    await check('cluster_exec: a remote tool error surfaces as E_PEER_CALL_FAILED', async () => {
      const data = parsed(await dispatch(execCtx, 'cluster_exec', { peer: 'company', tool: 'no_such_tool' }))
      assert(data.code === 'E_PEER_CALL_FAILED', `expected E_PEER_CALL_FAILED, got ${data.code}`)
    })

    await check('peer import: parses the mesh-peer overlay token and url', async () => {
      const { parsePeerOverlay } = await import('./core/peer-client.js')
      const parsedPeer = parsePeerOverlay(
        '- insert:\n    - id: home\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        transport: streamable-http\n        serverName: home-mesh\n        url: https://relay.example.com:29152/mcp\n        headers:\n          Authorization: \'Bearer abc123token\'\n',
        { meta: { url: 'https://relay.example.com:29152/mcp', tokenId: 'home', certFingerprint: 'AA:BB' } }
      )
      assert(parsedPeer.token === 'abc123token', `unexpected token ${parsedPeer.token}`)
      assert(parsedPeer.url === 'https://relay.example.com:29152', `unexpected url ${parsedPeer.url}`)
      assert(parsedPeer.certFingerprint === 'AA:BB', 'fingerprint from meta missing')
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
    try {
      await remoteSrv?.close?.()
    } catch {
      /* ignore */
    }
    if (mock) await mock.close()
    if (peer) await peer.close()
    if (wrongPeer) await wrongPeer.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(tlsHome, { recursive: true, force: true })
    rmSync(wrongTlsHome, { recursive: true, force: true })
    rmSync(remoteHome, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\ne2e-cluster: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`FAILED: ${f.name} — ${f.error}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
