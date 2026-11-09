#!/usr/bin/env node
/**
 * e2e for pairing (one-time code -> per-peer token) and per-token ACL.
 *
 * Everything runs against a real dsh-mesh server on 127.0.0.1 with a throwaway
 * DSH_MESH_HOME, so no real peer or model is involved. Bad samples are first-class:
 * wrong code, reused code, exhausted attempts, expired code, disabled pairing,
 * narrowed ACL, revoked token.
 *
 * Usage: node src/e2e-pair.js
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startMeshServer } from './server.js'
import {
  defaultConfig,
  addInboundToken,
  removeInboundToken,
  loadSecrets,
  pairingPath,
  saveConfig
} from './core/config.js'
import { createPairingCode, readPairingState } from './core/pairing.js'
import { generateCert, describeCert } from './core/tls.js'
import { postJson } from './core/peer-http.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const POSIX = process.platform !== 'win32'
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

function freshConfig() {
  const config = defaultConfig()
  config.node.name = 'pair-test'
  config.node.port = 0
  config.node.tls = { enabled: false, cert: '', key: '' }
  config.pairing = { enabled: true, codeTtlSec: 300, maxAttempts: 5 }
  config.acl.fsRoots = [tmpdir()]
  return config
}

async function pairRequest(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  let parsed
  try {
    parsed = await res.json()
  } catch {
    parsed = {}
  }
  return { status: res.status, body: parsed }
}

async function connectMesh(port, token) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'dsh-mesh-pair-e2e', version: '0.0.1' })
  await client.connect(transport)
  return client
}

function parsedToolResult(result) {
  const text = result?.content?.find?.((c) => c.type === 'text')?.text
  return JSON.parse(text)
}

export async function runE2ePair() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mesh-pair-'))
  const tmpPeerB = mkdtempSync(join(tmpdir(), 'dsh-mesh-pair-tls-'))
  const config = freshConfig()
  saveConfig(config, home)
  let srv
  let srv2
  const clients = []

  try {
    srv = await startMeshServer({ home, log: quiet, port: 0 })
    const port = srv.port

    await check('health advertises pairing without exposing a code (bad sample: no code leak)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      const body = await res.json()
      assert(body.pairing?.enabled === true, 'pairing.enabled missing from /health')
      assert(body.pairing?.codeActive === false, 'a code should not be active yet')
      assert(!JSON.stringify(body).match(/[A-Z0-9]{4}-[A-Z0-9]{4}/), 'health leaked something code-shaped')
    })

    await check('pairing code has the human-friendly shape XXXX-XXXX', async () => {
      const created = createPairingCode({ home, ttlSec: 300 })
      assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(created.code), `unexpected code ${created.code}`)
      assert(new Date(created.expiresAt).getTime() > Date.now(), 'code already expired')
      globalThis.__pairCode = created.code
    })

    await check('wrong pairing code is rejected without saying why (bad sample)', async () => {
      const res = await pairRequest(port, { code: 'ZZZZ-ZZZZ', peerName: 'intruder' })
      assert(res.status === 401, `expected 401, got ${res.status}`)
      assert(res.body.code === 'E_AUTH', `expected E_AUTH, got ${res.body.code}`)
      assert(!('token' in res.body), 'a token leaked on a failed pairing')
    })

    await check('the right code is redeemed for a per-peer token', async () => {
      const res = await pairRequest(port, { code: globalThis.__pairCode, peerName: 'company' })
      assert(res.status === 200, `expected 200, got ${res.status} ${JSON.stringify(res.body)}`)
      assert(res.body.ok === true, 'ok flag missing')
      assert(typeof res.body.token === 'string' && res.body.token.length === 64, 'token is not 32 bytes hex')
      assert(res.body.tokenId === 'company', `unexpected tokenId ${res.body.tokenId}`)
      assert(res.body.url.endsWith('/mcp'), `unexpected url ${res.body.url}`)
      assert(res.body.certFingerprint === null, 'plain http must not report a fingerprint')
      globalThis.__pairedToken = res.body.token
    })

    await check('the paired token really connects over MCP', async () => {
      const client = await connectMesh(port, globalThis.__pairedToken)
      clients.push(client)
      const listed = await client.listTools()
      assert(Array.isArray(listed.tools) && listed.tools.length >= 20, `only ${listed.tools?.length} tools listed`)
      globalThis.__pairedClient = client
    })

    await check('the same code cannot be redeemed twice (bad sample)', async () => {
      const res = await pairRequest(port, { code: globalThis.__pairCode, peerName: 'copycat' })
      assert(res.status === 401, `expected 401 on replay, got ${res.status}`)
      assert(res.body.code === 'E_AUTH', `expected E_AUTH, got ${res.body.code}`)
    })

    await check('missing code is rejected (bad sample)', async () => {
      const res = await pairRequest(port, { peerName: 'nocode' })
      assert(res.status === 401, `expected 401, got ${res.status}`)
    })

    await check('guessing burns the code after maxAttempts (bad sample)', async () => {
      const created = createPairingCode({ home, ttlSec: 300 })
      let lastStatus = 0
      let lastCode = ''
      for (let i = 0; i < 5; i += 1) {
        const bad = await pairRequest(port, { code: 'AAAA-AAAA', peerName: 'brute' })
        lastStatus = bad.status
        lastCode = bad.body.code
      }
      assert(lastStatus === 401, `expected 401 after guesses, got ${lastStatus}`)
      assert(lastCode === 'E_MAX_ATTEMPTS', `expected E_MAX_ATTEMPTS, got ${lastCode}`)
      const correct = await pairRequest(port, { code: created.code, peerName: 'brute' })
      assert(correct.status === 401, 'a burnt code was still accepted')
    })

    await check('an expired code is rejected (bad sample)', async () => {
      const created = createPairingCode({ home, ttlSec: 300 })
      const file = pairingPath(home)
      const record = JSON.parse(readFileSync(file, 'utf8'))
      record.expiresAt = new Date(Date.now() - 1000).toISOString()
      writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      const res = await pairRequest(port, { code: created.code, peerName: 'late' })
      assert(res.status === 401, `expected 401 on expired code, got ${res.status}`)
    })

    await check('pairing.json stores only a hash, never the code (bad sample: leak)', async () => {
      const created = createPairingCode({ home, ttlSec: 300 })
      const text = readFileSync(pairingPath(home), 'utf8')
      assert(!text.includes(created.code.replace('-', '')), 'the raw code is on disk')
      assert(!text.includes(created.code), 'the formatted code is on disk')
      // Node on Windows reports 0o666 for every file: chmod is advisory there, so the
      // mode assertion only means something on POSIX.
      if (POSIX) {
        const mode = statSync(pairingPath(home)).mode & 0o777
        assert((mode & 0o077) === 0, `pairing.json is too permissive: ${mode.toString(8)}`)
      }
    })

    await check('pairing can be switched off (bad sample: disabled node)', async () => {
      const offConfig = { ...config, pairing: { ...config.pairing, enabled: false } }
      saveConfig(offConfig, home)
      await new Promise((r) => setTimeout(r, 30)) // let the mtime-based reload notice
      const created = createPairingCode({ home, ttlSec: 300 })
      const res = await pairRequest(port, { code: created.code, peerName: 'nope' })
      assert(res.status === 403, `expected 403 when pairing is off, got ${res.status}`)
      saveConfig(config, home)
      await new Promise((r) => setTimeout(r, 30))
    })

    await check('per-token ACL narrows what a peer can call', async () => {
      const created = addInboundToken({ home, id: 'narrow', note: 'e2e', acl: { allow: ['mesh_self'] } })
      const client = await connectMesh(port, created.token)
      clients.push(client)
      const denied = await client.callTool({ name: 'fs_read', arguments: { path: join(home, 'config.json') } })
      const deniedBody = parsedToolResult(denied)
      assert(denied.isError === true, 'fs_read should have been denied for the narrowed token')
      assert(deniedBody.code === 'E_DENIED', `expected E_DENIED, got ${deniedBody.code}`)
      const me = parsedToolResult(await client.callTool({ name: 'mesh_self', arguments: {} }))
      assert(me.acl.you.tokenId === 'narrow', `mesh_self reported token ${me.acl.you.tokenId}`)
      assert(me.acl.allow.length === 1 && me.acl.allow[0] === 'mesh_self', `narrowed allow leaked: ${me.acl.allow}`)
    })

    await check('a peer-specific deny wins even when the node allows the tool', async () => {
      const created = addInboundToken({ home, id: 'denied-peer', note: 'e2e', acl: { deny: ['git_status'] } })
      const client = await connectMesh(port, created.token)
      clients.push(client)
      const body = parsedToolResult(await client.callTool({ name: 'git_status', arguments: { path: home } }))
      assert(body.code === 'E_DENIED', `expected E_DENIED, got ${body.code}`)
    })

    await check('revoking a token cuts access immediately (bad sample)', async () => {
      const created = addInboundToken({ home, id: 'temp', note: 'e2e' })
      const client = await connectMesh(port, created.token)
      clients.push(client)
      await client.listTools() // works before
      removeInboundToken({ home, id: 'temp' })
      let failed = false
      try {
        await client.listTools()
      } catch {
        failed = true
      }
      assert(failed, 'a revoked token still worked')
    })

    await check('TLS pairing: pinned fingerprint accepts a self-signed peer', async () => {
      const config2 = defaultConfig()
      config2.node.name = 'pair-tls'
      config2.node.port = 0
      config2.node.tls = { enabled: true, cert: '', key: '' }
      config2.pairing = { enabled: true, codeTtlSec: 300, maxAttempts: 5 }
      config2.acl.fsRoots = [tmpdir()]
      await generateCert({ home: tmpPeerB, sans: ['127.0.0.1', 'localhost'], force: true })
      saveConfig(config2, tmpPeerB)
      srv2 = await startMeshServer({ home: tmpPeerB, log: quiet, port: 0 })
      const fingerprint = describeCert(tmpPeerB).fingerprint256
      const created = createPairingCode({ home: tmpPeerB, ttlSec: 120 })
      const res = await postJson(
        `https://127.0.0.1:${srv2.port}/pair`,
        { code: created.code, peerName: 'pinned' },
        { fingerprint }
      )
      assert(res.status === 200 && res.body.ok === true, `pinned pairing failed: ${res.status} ${JSON.stringify(res.body)}`)
      assert(
        res.fingerprint && res.fingerprint.replace(/:/g, '') === fingerprint.replace(/:/g, ''),
        'the socket fingerprint does not match describeCert()'
      )
    })

    await check('TLS pairing: a wrong pin aborts before the code is used (bad sample)', async () => {
      const created = createPairingCode({ home: tmpPeerB, ttlSec: 120 })
      let code = ''
      try {
        await postJson(
          `https://127.0.0.1:${srv2.port}/pair`,
          { code: created.code, peerName: 'mitm' },
          { fingerprint: '11'.repeat(32) }
        )
      } catch (error) {
        code = error?.code || error?.message || ''
      }
      assert(code === 'E_PIN_MISMATCH', `expected E_PIN_MISMATCH, got ${code}`)
      const state = readPairingState(tmpPeerB)
      assert(state && state.used === false && state.attempts === 0, 'the code was consumed even though the pin failed')
    })

    await check('advertising the peer token does not leak into audit values', async () => {      const auditText = readFileSync(join(home, 'audit.jsonl'), 'utf8')
      assert(auditText.includes('"tool":"pair"'), 'pairing was not audited')
      assert(!auditText.includes(globalThis.__pairedToken), 'the token was written into the audit log')
    })

    await check('secrets.json holds the paired token with 0600', async () => {
      const secrets = loadSecrets(home)
      assert(secrets.inbound.some((e) => e.id === 'company'), 'paired token missing from secrets.json')
      if (POSIX) {
        const mode = statSync(join(home, 'secrets.json')).mode & 0o777
        assert((mode & 0o077) === 0, `secrets.json is too permissive: ${mode.toString(8)}`)
      }
      const files = readdirSync(home)
      assert(files.includes('pairing.json'), 'pairing.json missing')
    })
  } finally {
    for (const client of clients) {
      try {
        await client.close?.()
      } catch {
        /* ignore */
      }
    }
    if (srv) await srv.close()
    if (srv2) await srv2.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(tmpPeerB, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\ne2e-pair: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.error}`)
    return 1
  }
  return 0
}

if (process.argv[1]?.endsWith('e2e-pair.js')) {
  runE2ePair().then((code) => process.exit(code))
}
