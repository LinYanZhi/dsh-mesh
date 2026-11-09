import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { loadSecrets, defaultConfig, configPath, loadConfig, DEFAULT_ALLOW, aclDrift, peerAclForToken } from './core/config.js'
import { describeAcl, resolveAclUpdate } from './core/acl.js'
import { roleAllow, inferRole } from './core/roles.js'
import { applyPatchInsert, assertInside, normalizePluginFiles, patchHasPlugin, pluginRoot } from './core/repair.js'
import { hostTokenPath, resolveHostInstance } from './core/host-agent.js'
import { buildAll, isAllowed } from './tools/index.js'
import { run } from './core/util.js'
import { startMeshServer } from './server.js'

const results = []
function check(name, fn) {
  return (async () => {
    try {
      await fn()
      results.push({ name, ok: true })
      console.log(`PASS ${name}`)
    } catch (error) {
      results.push({ name, ok: false, error: error?.message || String(error) })
      console.log(`FAIL ${name} — ${error?.message || error}`)
    }
  })()
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

/** Silent logger for servers started during the suite. */
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

/** JSON GET over https, with an optional trust anchor. */
function httpsGetJson(port, path, { ca } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = get({ host: '127.0.0.1', port, path, ca, timeout: 3000 }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(text))
        } catch {
          rejectPromise(new Error(`non-JSON response (${res.statusCode}): ${text.slice(0, 80)}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', rejectPromise)
  })
}

function parseToolResult(result) {
  const text = result?.content?.find?.((c) => c.type === 'text')?.text
  assert(typeof text === 'string', 'tool result has no text content')
  return JSON.parse(text)
}

async function connect(url, token, name) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name, version: '0.0.1' })
  await client.connect(transport)
  return { client, transport }
}

async function writeConfigFile(home, config) {
  const p = configPath(home)
  writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf8')
  // Force a distinct mtime so the hot-reload watcher definitely notices the change.
  const stamp = new Date(Date.now() + 5000)
  utimesSync(p, stamp, stamp)
}

export async function runSelftest({ log = console } = {}) {
  const repoRoot = process.cwd()
  const home = mkdtempSync(join(tmpdir(), 'dsh-mesh-selftest-'))
  mkdirSync(join(home, 'greppable'), { recursive: true })
  writeFileSync(join(home, 'greppable', 'a.txt'), 'alpha\nTODO: fix me\ngamma\n')
  writeFileSync(join(home, 'greppable', 'b.txt'), 'nothing here\n')
  const gitRepo = join(home, 'tmp-repo')
  mkdirSync(gitRepo, { recursive: true })
  writeFileSync(join(gitRepo, 'file.txt'), 'v1\n')
  await run('git', ['init', '-q', '-b', 'main', gitRepo])
  await run('git', ['-C', gitRepo, 'add', '.'])
  await run('git', ['-C', gitRepo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first commit'])
  writeFileSync(join(gitRepo, 'file.txt'), 'v2 changed\n')
  writeFileSync(join(gitRepo, 'new.txt'), 'untracked\n')

  const config = defaultConfig()
  config.node = { ...config.node, name: 'selftest', bind: '127.0.0.1', port: 0, path: '/mcp' }
  config.acl.fsRoots = [repoRoot, home]
  writeConfigFile(home, config)

  const secrets = loadSecrets(home)
  const token = secrets.inbound[0].token
  // Earlier checks rotate the inbound token, so peer checks must re-read it instead of reusing `token`.
  const liveToken = () => loadSecrets(home).inbound[0].token
  const srv = await startMeshServer({ home, log: quiet })
  const health = await fetch(`http://127.0.0.1:${srv.port}/health`).then((r) => r.json())

  let client
  try {
    await check('health endpoint answers without auth', () => {
      assert(health?.ok === true, 'health not ok')
      assert(health?.service === 'dsh-mesh', 'wrong service name')
      assert(health?.tools >= 14, `expected >=14 tools, got ${health?.tools}`)
      assert(health?.node === 'selftest', `unexpected node ${health?.node}`)
    })

    await check('unauthenticated /mcp is rejected with 401', async () => {
      const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
      assert(res.status === 401, `expected 401, got ${res.status}`)
    })

    await check('wrong bearer token cannot connect (bad sample)', async () => {
      let failed = false
      try {
        const bad = await connect(srv.url, 'wrong-token', 'dsh-mesh-wrong-token')
        await bad.client.listTools()
      } catch {
        failed = true
      }
      assert(failed, 'wrong token was accepted')
    })

    const conn = await connect(srv.url, token, 'dsh-mesh-selftest')
    client = conn.client

    await check('tools/list exposes the M2 tool set', async () => {
      const list = await client.listTools()
      const names = list.tools.map((t) => t.name).sort()
      for (const expected of [
        'mesh_self',
        'fs_read',
        'fs_list',
        'fs_stat',
        'fs_grep',
        'fs_stats',
        'git_status',
        'git_log',
        'git_diff',
        'repo_scan',
        'shell_run',
        'task_submit',
        'task_status',
        'task_list',
        'task_cancel',
        'mesh_audit_tail'
      ]) {
        assert(names.includes(expected), `missing ${expected}`)
      }
    })

    await check('mesh_self returns host facts and tool ACL flags', async () => {
      const data = parseToolResult(await client.callTool({ name: 'mesh_self', arguments: {} }))
      assert(data.mesh?.name === 'selftest', `unexpected node name ${data.mesh?.name}`)
      assert(typeof data.host?.hostname === 'string' && data.host.hostname.length > 0, 'missing hostname')
      assert(Number.isInteger(data.host?.ppid) && data.host.ppid > 0, 'missing parent pid')
      assert(Number.isInteger(data.host?.processUptimeSec) && data.host.processUptimeSec >= 0, 'missing process uptime')
      assert(Array.isArray(data.tools) && data.tools.length >= 14, 'unexpected tool list')
      const shell = data.tools.find((t) => t.name === 'shell_run')
      assert(shell && shell.allowed === false, 'shell_run should be listed but denied')
    })

    await check('fs_read reads a file inside fsRoots', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'fs_read', arguments: { path: join(repoRoot, 'README.md'), maxBytes: 65536 } })
      )
      assert(data.path.endsWith('README.md'), 'wrong path')
      assert(typeof data.sha256 === 'string' && data.sha256.length === 64, 'missing sha256')
      assert(data.content.includes('dsh-mesh'), 'README content not returned')
    })

    await check('fs_read honours a line range', async () => {
      const data = parseToolResult(
        await client.callTool({
          name: 'fs_read',
          arguments: { path: join(repoRoot, 'README.md'), startLine: 1, endLine: 1 }
        })
      )
      assert(data.range?.startLine === 1 && data.range?.endLine === 1, 'range not applied')
      assert(!data.content.includes('\n'), 'range returned more than one line')
    })

    await check('fs_read outside fsRoots is denied (bad sample)', async () => {
      const data = parseToolResult(await client.callTool({ name: 'fs_read', arguments: { path: 'C:\\Windows\\win.ini' } }))
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })

    await check('fs_read on a missing file returns E_NOT_FOUND', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'fs_read', arguments: { path: join(repoRoot, '__does_not_exist__.md') } })
      )
      assert(data.code === 'E_NOT_FOUND', `expected E_NOT_FOUND, got ${data.code}`)
    })

    await check('fs_list lists a directory dirs-first', async () => {
      const data = parseToolResult(await client.callTool({ name: 'fs_list', arguments: { path: repoRoot } }))
      assert(Array.isArray(data.entries) && data.entries.length > 0, 'no entries')
      const firstFile = data.entries.findIndex((e) => e.type !== 'dir')
      const lastDir = data.entries.reduce((acc, e, i) => (e.type === 'dir' ? i : acc), -1)
      assert(firstFile === -1 || lastDir < firstFile, 'entries are not directories-first')
    })

    await check('fs_list outside fsRoots is denied (bad sample)', async () => {
      const data = parseToolResult(await client.callTool({ name: 'fs_list', arguments: { path: 'C:\\Windows' } }))
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })

    await check('fs_stat returns sha256 for a small file', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'fs_stat', arguments: { path: join(home, 'greppable', 'a.txt') } })
      )
      assert(data.type === 'file', `unexpected type ${data.type}`)
      assert(data.sizeBytes > 0, 'missing size')
      assert(typeof data.sha256 === 'string' && data.sha256.length === 64, 'missing sha256')
    })

    await check('fs_grep finds a regex match', async () => {
      const data = parseToolResult(
        await client.callTool({
          name: 'fs_grep',
          arguments: { root: join(home, 'greppable'), pattern: 'TODO' }
        })
      )
      assert(data.matches === 1, `expected 1 match, got ${data.matches}`)
      assert(data.results[0].line === 2, `wrong line ${data.results[0].line}`)
      assert(data.results[0].path.endsWith('a.txt'), 'wrong file')
    })

    await check('fs_grep rejects an invalid regex', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'fs_grep', arguments: { root: join(home, 'greppable'), pattern: '([' } })
      )
      assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
    })

    await check('fs_stats aggregates a tree without streaming entries', async () => {
      const dir = join(home, 'stats')
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'a.txt'), '12345')
      writeFileSync(join(dir, 'sub', 'b.log'), '1234567890')
      const data = parseToolResult(await client.callTool({ name: 'fs_stats', arguments: { path: dir } }))
      assert(data.totals?.files === 2, `expected 2 files, got ${data.totals?.files}`)
      assert(data.totals?.bytes === 15, `expected 15 bytes, got ${data.totals?.bytes}`)
      assert(data.topLevel?.length === 2, `expected 2 top-level entries, got ${data.topLevel?.length}`)
      const sub = data.topLevel.find((e) => e.name === 'sub')
      assert(sub && sub.sizeBytes === 10 && sub.fileCount === 1, 'subdirectory recursive size is wrong')
      assert(data.topFiles[0]?.sizeBytes === 10, 'largest file is wrong')
      const exts = data.extStats.top.map((e) => e.ext)
      assert(exts.includes('.txt') && exts.includes('.log'), 'extension histogram is missing entries')
    })

    await check('fs_stats outside fsRoots is denied (bad sample)', async () => {
      const data = parseToolResult(await client.callTool({ name: 'fs_stats', arguments: { path: 'C:\\Windows' } }))
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })

    await check('git_status inspects this repository', async () => {
      const data = parseToolResult(await client.callTool({ name: 'git_status', arguments: { path: repoRoot } }))
      assert(typeof data.root === 'string' && data.root.length > 0, 'missing root')
      assert(typeof data.head === 'string' && /^[0-9a-f]{40}$/.test(data.head), `bad head ${data.head}`)
      assert(data.dirty && typeof data.dirty === 'object', 'missing dirty counts')
    })

    await check('git_status on a non-repo path returns E_INVALID_ARG', async () => {
      const nonRepo = join(home, 'greppable')
      const data = parseToolResult(await client.callTool({ name: 'git_status', arguments: { path: nonRepo } }))
      assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
    })

    await check('git_log returns commits of the temp repo', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'git_log', arguments: { path: gitRepo, limit: 5, format: 'detail' } })
      )
      assert(data.count >= 1, `expected commits, got ${data.count}`)
      assert(data.commits[0].subject === 'first commit', `unexpected subject ${data.commits[0].subject}`)
      assert(/^[0-9a-f]{40}$/.test(data.commits[0].sha), 'missing full sha')
    })

    await check('git_diff shows the working tree change', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'git_diff', arguments: { path: gitRepo, file: 'file.txt' } })
      )
      assert(data.diff.includes('+v2 changed'), 'diff does not contain the change')
      assert(data.stat.includes('file.txt'), 'stat summary missing file')
    })

    await check('repo_scan finds the temp repo and its dirty state', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'repo_scan', arguments: { roots: [home], depth: 2 } })
      )
      assert(data.repos >= 1, `expected >=1 repo, got ${data.repos}`)
      const item = data.items.find((r) => r.root.endsWith('tmp-repo'))
      assert(item, 'tmp-repo not found')
      assert(item.dirty.modified >= 1 && item.dirty.untracked >= 1, `unexpected dirty ${JSON.stringify(item.dirty)}`)
    })

    await check('shell_run is denied while disabled (bad sample)', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'shell_run', arguments: { command: 'node', args: ['--version'] } })
      )
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })

    await check('task_submit runs a job and task_status reports success', async () => {
      const sub = parseToolResult(
        await client.callTool({
          name: 'task_submit',
          arguments: { tool: 'git_log', arguments: { path: gitRepo, limit: 1 }, idem: 'selftest-job-1' }
        })
      )
      assert(typeof sub.jobId === 'string' && sub.jobId.length > 0, 'missing jobId')
      const final = await waitForJob(client, sub.jobId)
      assert(final.state === 'succeeded', `expected succeeded, got ${final.state} (${JSON.stringify(final.error)})`)
      const inner = JSON.parse(final.result.content[0].text)
      assert(inner.count === 1, `unexpected inner result count ${inner.count}`)
    })

    await check('task_submit with the same idem key reuses the job', async () => {
      const again = parseToolResult(
        await client.callTool({
          name: 'task_submit',
          arguments: { tool: 'git_log', arguments: { path: gitRepo, limit: 1 }, idem: 'selftest-job-1' }
        })
      )
      assert(again.idempotent === true, 'second submit was not deduplicated')
      assert(again.jobId.length > 0, 'missing jobId')
    })

    await check('task_cancel on a finished job returns E_INVALID_ARG', async () => {
      const list = parseToolResult(await client.callTool({ name: 'task_list', arguments: { limit: 5 } }))
      const done = list.jobs.find((j) => j.state === 'succeeded')
      assert(done, 'no finished job to cancel')
      const data = parseToolResult(await client.callTool({ name: 'task_cancel', arguments: { jobId: done.id } }))
      assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
    })

    await check('task_submit refuses to queue task tools', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'task_submit', arguments: { tool: 'task_submit', arguments: {} } })
      )
      assert(data.code === 'E_INVALID_ARG', `expected E_INVALID_ARG, got ${data.code}`)
    })

    await check('mesh_audit_tail returns the calls made so far', async () => {
      const data = parseToolResult(await client.callTool({ name: 'mesh_audit_tail', arguments: { limit: 100 } }))
      assert(Array.isArray(data.entries) && data.entries.length > 5, 'expected audit entries')
      const tools = new Set(data.entries.map((e) => e.tool))
      assert(tools.has('fs_read') && tools.has('git_status'), 'expected tools missing from audit')
      const deniedEntry = data.entries.find((e) => e.code === 'E_DENIED')
      assert(deniedEntry, 'denied call was not audited')
    })

    await check('ACL hot-reloads from config.json (revoke fs_read)', async () => {
      const before = loadConfig(home)
      const next = { ...before, acl: { ...before.acl, allow: before.acl.allow.filter((n) => n !== 'fs_read') } }
      await writeConfigFile(home, next)
      const data = parseToolResult(
        await client.callTool({ name: 'fs_read', arguments: { path: join(repoRoot, 'README.md') } })
      )
      assert(data.code === 'E_DENIED', `expected E_DENIED after revoke, got ${data.code}`)
    })

    await check('shell_run works once a human enables it (hot-reload)', async () => {
      const before = loadConfig(home)
      const next = {
        ...before,
        acl: { ...before.acl, allow: [...before.acl.allow, 'shell_run'] },
        shell: { ...before.shell, enabled: true, allowCommands: ['node'] }
      }
      await writeConfigFile(home, next)
      const data = parseToolResult(
        await client.callTool({ name: 'shell_run', arguments: { command: 'node', args: ['--version'], timeoutMs: 30000 } })
      )
      assert(data.exitCode === 0, `expected exit 0, got ${data.exitCode} (${data.stderr})`)
      assert(/^v\d+\./.test(data.stdout.trim()), `unexpected node version output: ${data.stdout}`)
    })

    await check('shell_run refuses a command outside allowCommands (bad sample)', async () => {
      const data = parseToolResult(
        await client.callTool({ name: 'shell_run', arguments: { command: 'git', args: ['--version'] } })
      )
      assert(data.code === 'E_DENIED', `expected E_DENIED, got ${data.code}`)
    })
    await check('token rotation takes effect without a restart (hot-reload)', async () => {
      const { rotateToken } = await import('./core/config.js')
      const rotated = rotateToken({ home, note: 'selftest rotation' })
      let oldRejected = false
      try {
        const stale = await connect(srv.url, token, 'dsh-mesh-stale-token')
        await stale.client.listTools()
      } catch {
        oldRejected = true
      }
      assert(oldRejected, 'old token was still accepted after rotation')
      const fresh = await connect(srv.url, rotated.token, 'dsh-mesh-fresh-token')
      const list = await fresh.client.listTools()
      assert(list.tools.length >= 14, 'rotated token could not list tools')
      await fresh.client.close()
    })

    await check('TLS: https /health works with the generated cert and fails without trust (bad sample)', async () => {
      const { generateCert, certPath } = await import('./core/tls.js')
      const { readFileSync } = await import('node:fs')
      await generateCert({ home })
      const before = loadConfig(home)
      await writeConfigFile(home, { ...before, node: { ...before.node, tls: { enabled: true } } })
      const tlsSrv = await startMeshServer({ home, secrets, log: quiet })
      try {
        const ca = readFileSync(certPath(home))
        const health = await httpsGetJson(tlsSrv.port, '/health', { ca })
        assert(health.ok === true, 'https health not ok')
        assert(health.tls === true, 'https health did not report tls:true')
        assert(String(tlsSrv.url).startsWith('https://'), `unexpected url ${tlsSrv.url}`)
        let refused = false
        try {
          await httpsGetJson(tlsSrv.port, '/health', {})
        } catch {
          refused = true
        }
        assert(refused, 'self-signed cert was accepted without an explicit trust anchor')
      } finally {
        await tlsSrv.close()
        await writeConfigFile(home, { ...before, node: { ...before.node, tls: { enabled: false } } })
      }
    })
    await check('peer client: tools/list + tools/call over the pinned transport', async () => {
      const { listPeerTools, callPeerTool } = await import('./core/peer-client.js')
      const peer = { name: 'selftest-peer', url: srv.url, token: liveToken(), certFingerprint: null }
      const listed = await listPeerTools(peer)
      assert(listed.count >= 14, `expected >=14 peer tools, got ${listed.count}`)
      assert(listed.tools.some((tool) => tool.name === 'mesh_self'), 'mesh_self missing from the peer tool list')
      const called = await callPeerTool(peer, { tool: 'mesh_self', args: {} })
      assert(called.ok === true, 'callPeerTool reported isError for mesh_self')
      const data = parseToolResult(called.result)
      assert(data.mesh?.name === 'selftest', `unexpected peer node name ${data.mesh?.name}`)
    })

    await check('peer client: peer-side denial keeps E_DENIED and a wrong token fails (bad sample)', async () => {
      const { listPeerTools, callPeerTool } = await import('./core/peer-client.js')
      const peer = { name: 'selftest-peer', url: srv.url, token: liveToken(), certFingerprint: null }
      const denied = await callPeerTool(peer, { tool: 'shell_run', args: { command: 'not-in-any-allowlist' } })
      assert(denied.ok === false, 'shell_run should be denied by the peer ACL')
      assert(parseToolResult(denied.result).code === 'E_DENIED', 'denied result should carry code E_DENIED')
      let failed = false
      try {
        await listPeerTools({ ...peer, token: 'wrong-token' })
      } catch {
        failed = true
      }
      assert(failed, 'wrong token was accepted by the peer client')
    })

    await check('peer bridge serves the peer tool surface over stdio', async () => {
      const { savePeers } = await import('./core/pairing.js')
      const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
      const bridgeHome = mkdtempSync(join(tmpdir(), 'dsh-mesh-bridge-'))
      const bridgeClient = new Client({ name: 'dsh-mesh-bridge-selftest', version: '0.0.1' })
      try {
        savePeers(
          {
            version: 1,
            items: [{ id: 'selftest-peer', name: 'selftest-peer', url: srv.url, token: liveToken(), certFingerprint: null }]
          },
          bridgeHome
        )
        const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
        await bridgeClient.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, 'src', 'cli.js'), 'peer', 'bridge', '--to', 'selftest-peer'],
            cwd: repoRoot,
            env: { ...cleanEnv, DSH_MESH_HOME: bridgeHome },
            stderr: 'ignore'
          })
        )
        const listed = await bridgeClient.listTools()
        assert(listed.tools.length >= 14, `bridge exposed only ${listed.tools.length} tools`)
        const result = await bridgeClient.callTool({ name: 'mesh_self', arguments: {} })
        assert(result.isError !== true, 'call through the bridge failed')
        assert(parseToolResult(result).mesh?.name === 'selftest', 'bridge proxied the wrong peer')
      } finally {
        await bridgeClient.close().catch(() => {})
        rmSync(bridgeHome, { recursive: true, force: true })
      }
    })

    await check('peer doctor: fails without a peer, warns on a reachable one (bad sample)', async () => {
      const { runPeerDoctor } = await import('./core/peer-doctor.js')
      const { savePeers } = await import('./core/pairing.js')
      const doctorHome = mkdtempSync(join(tmpdir(), 'dsh-mesh-doctor-'))
      try {
        writeConfigFile(doctorHome, { ...defaultConfig(), hosts: [] })
        const empty = await runPeerDoctor({ home: doctorHome, dshHomes: [], timeoutMs: 5000 })
        assert(empty.verdict === 'fail', 'doctor must fail when no peer is paired')
        assert(
          empty.checks.some((check) => check.id === 'peers-file' && check.status === 'fail'),
          'expected a peers-file failure'
        )
        savePeers(
          {
            version: 1,
            items: [{ id: 'selftest-peer', name: 'selftest-peer', url: srv.url, token: liveToken(), certFingerprint: null }]
          },
          doctorHome
        )
        const report = await runPeerDoctor({ home: doctorHome, dshHomes: [], timeoutMs: 5000 })
        assert(report.verdict === 'warn', `expected warn without overlay/hosts, got ${report.verdict}`)
        assert(report.checks.find((check) => check.id === 'mcp-handshake')?.status === 'pass', 'handshake check should pass')
        assert(report.checks.find((check) => check.id === 'dsh-overlay')?.status === 'warn', 'missing overlay should warn')
        assert(report.nextSteps.length > 0, 'doctor should suggest next steps')
      } finally {
        rmSync(doctorHome, { recursive: true, force: true })
      }
    })

    await check('peer doctor: an overlay is attributed only to the profile that mounts it (bad sample)', async () => {
      const { findPeerOverlays, overlayMatchesProfile } = await import('./core/peer-doctor.js')
      const fakeDsh = mkdtempSync(join(tmpdir(), 'dsh-mesh-dshhome-'))
      try {
        const profileDir = join(fakeDsh, 'profiles', 'web')
        mkdirSync(profileDir, { recursive: true })
        writeFileSync(
          join(profileDir, 'cordis.patch.yml'),
          [
            '- insert:',
            '    - id: home',
            '      name: "@deepseek-ai/dsh-mcp-client"',
            '      config:',
            '        transport: stdio',
            '        serverName: home',
            '        command: node.exe',
            '        args: [src/cli.js, peer, bridge, --to, home]',
            ''
          ].join('\n')
        )
        const peer = { id: 'peer-home', name: 'home', url: 'https://peer.invalid:1' }
        // The same directory twice simulates `~/.dsh` being a junction onto `~/.dsh0`.
        const overlays = findPeerOverlays(peer, { dshHomes: [fakeDsh, fakeDsh] })
        assert(overlays.length === 1, `expected one deduped overlay, got ${overlays.length}`)
        assert(overlays[0].transport === 'stdio', `expected stdio transport, got ${overlays[0].transport}`)
        assert(overlayMatchesProfile(overlays[0], profileDir), 'overlay should match its own profile')
        assert(
          !overlayMatchesProfile(overlays[0], join(fakeDsh, 'profiles', 'web2')),
          'overlay must not be credited to another profile'
        )
      } finally {
        rmSync(fakeDsh, { recursive: true, force: true })
      }
    })

    await check('delegate: fresh session by default, explicit sessionId continues it (bad sample: no idle-session hijack)', async () => {
      const { createServer } = await import('node:http')
      const { buildDelegate } = await import('./tools/delegate.js')
      const delegateHome = mkdtempSync(join(tmpdir(), 'dsh-mesh-delegate-'))
      const workdir = join(delegateHome, 'workspace')
      mkdirSync(workdir, { recursive: true })
      const token = 'selftest-host-token'
      const calls = []
      const sessions = [
        { sessionId: 'session-existing', state: 'idle', agentAvailable: true, live: true, cwd: workdir, updatedAt: 1, title: 'existing' }
      ]
      const fake = createServer((req, res) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          let body = {}
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {
            /* bad JSON → empty body */
          }
          const send = (payload) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(payload))
          }
          const pathname = req.url.split('?')[0]
          if (pathname === '/host/ping') return send({ ok: true, plugin: '0.2.0-selftest' })
          if (pathname === '/host/agents') {
            return send({ ok: true, agents: [{ id: 'session-existing', status: 'idle', title: 'existing', cwd: workdir }] })
          }
          if (pathname === '/host/sessions') return send({ ok: true, source: 'agents', count: sessions.length, sessions })
          if (pathname === '/host/sessions/create') {
            calls.push({ path: pathname, body })
            const sessionId = 'session-created-1'
            sessions.push({
              sessionId,
              state: 'idle',
              agentAvailable: true,
              live: true,
              cwd: body.cwd || '',
              updatedAt: Date.now(),
              title: 'fresh'
            })
            return send({ ok: true, sessionId, plugin: '0.2.0-selftest' })
          }
          if (pathname === '/host/prompt') {
            calls.push({ path: pathname, body })
            return send({ ok: true, sessionId: body.sessionId, mode: body.mode || 'queue', accepted: true, plugin: '0.2.1-selftest' })
          }
          if (pathname === '/host/wake') {
            calls.push({ path: pathname, body })
            return send({ ok: true, sessionId: body.sessionId, delivered: true, wokeUp: true })
          }
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, code: 'E_NOT_FOUND' }))
        })
      })
      await new Promise((resolvePromise) => fake.listen(0, '127.0.0.1', resolvePromise))
      const port = fake.address().port
      try {
        writeFileSync(join(delegateHome, 'host-token'), `${token}\n`)
        const base = defaultConfig()
        const cfg = {
          ...base,
          hosts: [{ id: 'dsh0', url: `http://127.0.0.1:${port}`, enabled: true }],
          acl: { ...base.acl, fsRoots: [delegateHome] }
        }
        const ctx = { getConfig: () => cfg, home: delegateHome, peerId: 'selftest', log: quiet }
        const tool = buildDelegate(ctx).find((entry) => entry.name === 'delegate')
        const first = await tool.handler({ goal: 'do a thing', workspace: workdir })
        assert(first.isError !== true, `fresh delegate failed: ${first.content?.[0]?.text}`)
        const firstData = parseToolResult(first)
        assert(firstData.createdSession === true, 'delegate must create a fresh session by default')
        assert(firstData.sessionId === 'session-created-1', `unexpected created session ${firstData.sessionId}`)
        assert(
          calls.some((call) => call.path === '/host/sessions/create' && call.body.cwd === workdir),
          'session creation must pass the requested workspace cwd'
        )
        assert(
          calls.some((call) => call.path === '/host/prompt' && call.body.sessionId === 'session-created-1'),
          'a fresh delegate must drive the first turn with host_session_prompt (wake would sit in a dormant inbox)'
        )
        assert(
          !calls.some((call) => call.path === '/host/wake' && call.body.sessionId === 'session-existing'),
          'a fresh delegate must not wake an unrelated idle session'
        )
        const second = await tool.handler({ goal: 'keep going', sessionId: 'session-created-1' })
        assert(second.isError !== true, `continuation failed: ${second.content?.[0]?.text}`)
        const secondData = parseToolResult(second)
        assert(secondData.createdSession === false, 'continuation must not create another session')
        assert(secondData.sessionId === 'session-created-1', 'continuation must use the requested session')
        assert(
          calls.some((call) => call.path === '/host/wake' && call.body.sessionId === 'session-created-1'),
          'a continuation must wake the live session, not prompt a fresh one'
        )
        const dead = await tool.handler({ goal: 'nope', sessionId: 'session-gone' })
        assert(dead.isError === true, 'continuing a dead session must fail loud')
        assert(
          String(dead.content[0].text).includes('session not alive'),
          'dead-session failure must explain that the session is gone'
        )
      } finally {
        await new Promise((resolvePromise) => fake.close(resolvePromise))
        rmSync(delegateHome, { recursive: true, force: true })
      }
    })
  } finally {
    try {
      await client?.close?.()
    } catch {
      /* ignore */
    }
    await srv.close()
    rmSync(home, { recursive: true, force: true })
  }

  await check('acl reset restores DEFAULT_ALLOW', () => {
    const next = resolveAclUpdate({ allow: ['mesh_self', 'shell_run'], deny: ['fs_read'] }, { reset: true })
    assert(next.changed, 'reset should report a change')
    assert(next.allow.length === DEFAULT_ALLOW.length, `expected ${DEFAULT_ALLOW.length} allowed, got ${next.allow.length}`)
    assert(next.deny.length === 0, 'reset should clear deny list')
  })

  await check('acl allow/deny keep allow and deny disjoint', () => {
    const added = resolveAclUpdate({ allow: ['mesh_self'], deny: [] }, { allow: ['fs_read'] })
    assert(added.allow.includes('fs_read'), 'allow did not add fs_read')
    const fromDeny = resolveAclUpdate({ allow: [], deny: ['fs_read'] }, { allow: ['fs_read'] })
    assert(!fromDeny.deny.includes('fs_read'), 'allow did not clear the deny entry')
    const denied = resolveAclUpdate({ allow: ['fs_read'], deny: [] }, { deny: ['fs_read'] })
    assert(!denied.allow.includes('fs_read'), 'deny did not remove from allow')
    assert(denied.deny.includes('fs_read'), 'deny did not add fs_read')
  })

  await check('acl rejects unknown tool names (bad sample)', () => {
    let error
    try {
      resolveAclUpdate({ allow: [], deny: [] }, { allow: ['nope_tool'], known: ['mesh_self'] })
    } catch (err) {
      error = err
    }
    assert(error?.code === 'E_INVALID_ARG', 'unknown tool should be rejected with E_INVALID_ARG')
  })

  await check('acl no-op reports changed:false', () => {
    const same = resolveAclUpdate({ allow: ['mesh_self'], deny: [] }, { allow: ['mesh_self'] })
    assert(same.changed === false, 'no-op update should not report a change')
  })

  await check('describeAcl: deny wins over allow', () => {
    const view = describeAcl({ acl: { allow: ['a', 'b'], deny: ['b'] } }, ['a', 'b', 'c'])
    assert(view.tools.find((t) => t.name === 'a').allowed === true, 'a should be allowed')
    assert(view.tools.find((t) => t.name === 'b').allowed === false, 'deny must win over allow')
    assert(view.tools.find((t) => t.name === 'c').allowed === false, 'unlisted tool should be denied')
  })

  await check('acl drift reports missing and extra tools', () => {
    const drift = aclDrift({ acl: { allow: ['mesh_self', 'channel_send'] } })
    assert(drift.missing.includes('fs_read'), 'fs_read should be reported missing')
    assert(drift.missing.includes('host_self'), 'host_self should be reported missing')
    assert(drift.extra.includes('channel_send'), 'channel_send should be reported extra')
    assert(!drift.extra.includes('mesh_self'), 'default tool should not be reported extra')
  })

  await check('config v5 -> v6 folds the single host bridge into hosts[] and adds dsh1', () => {
    const tmpPeerB = mkdtempSync(join(tmpdir(), 'mesh-cfg-v6-'))
    try {
      writeFileSync(
        configPath(tmpPeerB),
        JSON.stringify(
          {
            version: 5,
            host: { enabled: true, url: 'http://127.0.0.1:9111', tokenFile: '', timeoutMs: 4321 }
          },
          null,
          2
        ),
        'utf8'
      )
      const cfg = loadConfig(tmpPeerB, { log: quiet })
      assert(cfg.version === 7, `expected version 7 after full migration, got ${cfg.version}`)
      assert(Array.isArray(cfg.hosts) && cfg.hosts.length === 2, 'expected two host entries')
      assert(
        cfg.hosts[0].id === 'dsh0' && cfg.hosts[0].url === 'http://127.0.0.1:9111',
        'the custom bridge should survive as dsh0'
      )
      assert(cfg.hosts[0].timeoutMs === 4321, 'custom timeout should survive')
      assert(cfg.hosts[1].id === 'dsh1', 'dsh1 default should be appended')
      assert(cfg.host === undefined, 'legacy host key should be gone from the merged config')
    } finally {
      rmSync(tmpPeerB, { recursive: true, force: true })
    }
  })

  await check('host instances resolve by id and derive per-instance token files', () => {
    const tmpPeerB = mkdtempSync(join(tmpdir(), 'mesh-host-resolve-'))
    try {
      const cfg = defaultConfig()
      assert(hostTokenPath(cfg, tmpPeerB, 'dsh0') === join(tmpPeerB, 'host-token'), 'dsh0 keeps the historical token file')
      assert(
        hostTokenPath(cfg, tmpPeerB, 'dsh1') === join(tmpPeerB, 'host-token-dsh1'),
        'other ids get their own token file'
      )
      assert(resolveHostInstance(cfg, 'dsh1').id === 'dsh1', 'resolve dsh1 by id')
      assert(resolveHostInstance(cfg, undefined).id === 'dsh0', 'default instance is the first enabled one')
      let threw = null
      try {
        resolveHostInstance(cfg, 'dsh9')
      } catch (error) {
        threw = error
      }
      assert(threw && threw.code === 'E_HOST_UNKNOWN', `expected E_HOST_UNKNOWN, got ${threw?.code}`)
    } finally {
      rmSync(tmpPeerB, { recursive: true, force: true })
    }
  })

  await check('config v6 -> v7 adds repair defaults and derives hosts[].profileDir', () => {
    const tmpPeerB = mkdtempSync(join(tmpdir(), 'mesh-cfg-v7-'))
    try {
      writeFileSync(
        configPath(tmpPeerB),
        JSON.stringify(
          {
            version: 6,
            hosts: [{ id: 'dsh0', label: 'custom', enabled: true, url: 'http://127.0.0.1:9112', tokenFile: '', timeoutMs: 5000 }]
          },
          null,
          2
        ),
        'utf8'
      )
      const cfg = loadConfig(tmpPeerB, { log: quiet })
      assert(cfg.version === 7, `expected version 7, got ${cfg.version}`)
      assert(cfg.repair && cfg.repair.enabled === false, 'repair must default to disabled')
      assert(Array.isArray(cfg.repair.restartScripts) === false && typeof cfg.repair.restartScripts === 'object', 'restartScripts map')
      assert(cfg.hosts[0].url === 'http://127.0.0.1:9112', 'custom bridge should survive')
      assert(
        String(cfg.hosts[0].profileDir).endsWith(join('profiles', 'web')) && String(cfg.hosts[0].profileDir).includes('.dsh0'),
        `profileDir should be derived for dsh0, got ${cfg.hosts[0].profileDir}`
      )
    } finally {
      rmSync(tmpPeerB, { recursive: true, force: true })
    }
  })

  await check('repair payload validation + patch wiring are strict and idempotent', () => {
    const files = normalizePluginFiles([
      { path: 'package.json', content: '{}' },
      { path: 'lib/index.js', content: 'export function apply() {}' }
    ])
    assert(files.length === 2 && files[1].rel === 'lib/index.js', 'files normalise to relative paths')
    for (const bad of [
      [{ path: '../evil.js', content: 'x' }],
      [{ path: 'C:/evil.js', content: 'x' }],
      [{ path: 'a/b.txt', content: 'x' }, { path: 'A/B.txt', content: 'y' }],
      [{ path: 'big.js', content: 'x'.repeat(2048) }]
    ]) {
      let threw = null
      try {
        normalizePluginFiles(bad, { maxFileBytes: 1024 })
      } catch (error) {
        threw = error
      }
      assert(threw && threw.code === 'E_INVALID_ARG', `expected E_INVALID_ARG for ${JSON.stringify(bad[0])}`)
    }
    const first = applyPatchInsert('', 'dsh-mesh-host')
    assert(first.changed === true && patchHasPlugin(first.text, 'dsh-mesh-host'), 'empty patch gets wired')
    const second = applyPatchInsert(first.text, 'dsh-mesh-host')
    assert(second.changed === false, 'wiring twice is a no-op')
    const kept = applyPatchInsert('- insert:\n    - id: other\n      name: other-plugin\n', 'dsh-mesh-host')
    assert(kept.changed === true && kept.backup === true, 'existing entries are preserved and flagged for backup')
    assert(kept.text.includes('other-plugin') && kept.text.includes('dsh-mesh-host'), 'both plugins present')
    let escaped = null
    try {
      assertInside(join(tmpdir(), 'root'), pluginRoot(join(tmpdir(), 'root'), 'x').replace('root', 'escape'))
    } catch (error) {
      escaped = error
    }
    assert(escaped && escaped.code === 'E_INVALID_ARG', 'assertInside must reject paths outside the root')
  })

  await check('tools: host_session_archive is exposed but denied by default', async () => {
    const config = defaultConfig()
    const tools = buildAll({ getConfig: () => config, home: join(tmpdir(), 'selftest-tools'), peerId: 'selftest', log: quiet })
    const archive = tools.find((tool) => tool.name === 'host_session_archive')
    assert(archive, 'host_session_archive missing from the tool manifest')
    assert(archive.handler instanceof Function, 'host_session_archive has no handler')
    assert(!isAllowed(config, 'host_session_archive'), 'host_session_archive must be denied by default')
  })

  await check('roles: controller can delegate but not cross-machine writes/restarts', () => {
    const allow = roleAllow('controller')
    assert(allow.includes('delegate') && allow.includes('delegate_status'), 'controller must be able to delegate')
    assert(allow.includes('pc_action') && allow.includes('fs_read'), 'controller must keep pc_* + read tools')
    assert(allow.includes('host_session_create') && allow.includes('host_session_prompt'), 'controller must allow the CLI delegation path (session create/prompt)')
    for (const dangerous of ['host_call', 'service_restart', 'mesh_config_patch', 'fs_write', 'shell_run']) {
      assert(!allow.includes(dangerous), `controller must not include ${dangerous}`)
    }
  })

  await check('roles: observer is read-only and cannot delegate or control', () => {
    const allow = roleAllow('observer')
    assert(allow.includes('fs_read') && allow.includes('cluster_status'), 'observer should read')
    for (const notAllowed of ['delegate', 'pc_action', 'host_call', 'service_restart']) {
      assert(!allow.includes(notAllowed), `observer must not include ${notAllowed}`)
    }
  })

  await check('roles: inferRole maps legacy allow-lists safely', () => {
    assert(inferRole(['mesh_self', 'fs_read']) === 'observer', 'read-only allow → observer')
    assert(inferRole(['mesh_self', 'pc_action', 'delegate']) === 'controller', 'pc_*+delegate allow → controller')
    assert(inferRole(DEFAULT_ALLOW, DEFAULT_ALLOW) === 'node', 'exact node ACL → node')
    assert(inferRole(['mesh_self', 'shell_run'], DEFAULT_ALLOW) === null, 'unmappable custom ACL stays explicit')
  })

  await check('roles: peerAclForToken narrows by role and inherits for node', () => {
    const controller = peerAclForToken({ inbound: [{ id: 'c', role: 'controller' }] }, 'c')
    assert(controller && controller.role === 'controller', 'role should be reported')
    assert(controller.allow.includes('delegate') && !controller.allow.includes('host_call'), 'controller allow-list applied')
    const node = peerAclForToken({ inbound: [{ id: 'n', role: 'node' }] }, 'n')
    assert(node && node.allow === undefined, 'node role inherits the node ACL')
    const legacy = peerAclForToken({ inbound: [{ id: 'l', acl: { allow: ['mesh_self'] } }] }, 'l')
    assert(legacy.allow.length === 1 && legacy.allow[0] === 'mesh_self', 'legacy explicit ACL untouched')
  })

  const failed = results.filter((r) => !r.ok)
  console.log(`\nselftest: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.error}`)
    return 1
  }
  return 0
}

async function waitForJob(client, jobId, { attempts = 40 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const job = parseToolResult(await client.callTool({ name: 'task_status', arguments: { jobId } }))
    if (job.done) return job
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`job ${jobId} did not finish in time`)
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('selftest.js')) {
  runSelftest().then((code) => process.exit(code))
}
