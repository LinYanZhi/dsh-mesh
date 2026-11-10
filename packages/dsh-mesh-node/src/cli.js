#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname as dirnameOf, join as joinPath, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  meshHome,
  loadConfig,
  loadSecrets,
  saveSecrets,
  configPath,
  secretsPath,
  peersPath,
  MESH_VERSION,
  defaultConfig,
  saveConfig
} from './core/config.js'
import { auditPath, tailAudit } from './core/audit.js'
import { describeAcl, resolveAclUpdate } from './core/acl.js'
import { TASK_NAME, autostartCommand, autostartInstall, autostartRemove, autostartStatus } from './core/autostart.js'
import { startMeshServer } from './server.js'
import { runSelftest } from './selftest.js'
import { buildAll, isAllowed } from './tools/index.js'
import { postJson } from './core/peer-http.js'
import { DshWebClient } from './core/ds-web.js'
import { LAN_DISCOVERY_PORT, startLanResponder, discoverLan } from './core/lan-discovery.js'

const HELP = `dsh-mesh v${MESH_VERSION} — expose this machine to a peer DSH over MCP

Usage:
  node src/cli.js serve [--port N] [--bind ADDR]      start the mesh endpoint (config hot-reloads)
  node src/cli.js discover [--timeout-ms N] [--json]  find dsh-mesh nodes on the local network (UDP)
  node src/cli.js group [show|set <name> [--key SECRET]|clear]  LAN discovery group isolation
  node src/cli.js pair [--host H] [--port N]          print the connection snippet + token for the peer
  node src/cli.js pair --code [--ttl N]                mint a one-time pairing code (default 30 min, max 24 h)
  node src/cli.js peer [list]                          peers this machine can reach (client-side)
node src/cli.js peer import --file <name>.yml        import a mesh-peer overlay token (for cluster exec)
  node src/cli.js peer add --url URL --code CODE [--name NAME] [--ca cert.pem | --fingerprint SHA256]
                                                      redeem a pairing code and store the peer + overlay
  node src/cli.js peer remove <id>                     forget a paired peer (client side only)
  node src/cli.js peer patch [id] [--transport streamable-http|stdio]
                                                      rewrite the DSH overlay for a paired peer
  node src/cli.js peer tools [--to NAME]               list the tools a paired peer exposes (pinned TLS)
  node src/cli.js peer call <tool> [--to NAME] [--args JSON | --args-file PATH]
                                                      call one tool on a paired peer and print its result
  node src/cli.js peer doctor [--to NAME]              diagnose pin/token/overlay/live-DSH-tools in one report
  node src/cli.js peer bridge --to NAME                stdio MCP bridge (spawned by DSH; pins TLS in-process)
  node src/cli.js token list                          list inbound tokens (id / note / per-token ACL)
  node src/cli.js token add [--id ID] [--allow a,b] [--fs-roots "C:\\a;C:\\b"] [--note TEXT] [--yes]
                                                      add a narrow inbound token (prints the token once; --yes required)
  node src/cli.js revoke <token-id>                    delete an inbound token (peer loses access now)
  node src/cli.js patch [--out FILE] [--url URL]      write a DSH mcp-client overlay yaml
  node src/cli.js tls init [--san A,B] [--days N]     generate a self-signed cert (enables https)
  node src/cli.js tls info                            show the current certificate
  node src/cli.js rotate [--id ID]                     rotate an inbound token (old one stops working)
  node src/cli.js channel [targets]                   list local DSH channel targets + cookie state
  node src/cli.js channel login <launchUrl> [--target ID]
                                                      store a cookie from a "dsh web" launch URL
  node src/cli.js channel sessions [target]           list sessions of one target
  node src/cli.js channel send <text> --target ID [--session ID] [--mode queue|steer] [--wait-ms N]
                                                      type into a DSH session and print its reply (admin path: bypasses MCP ACL)
  node src/cli.js host status [--instance ID]         ping every bridge (or one) and show its DSH instance
  node src/cli.js host tools [--search TEXT] [--instance ID]
                                                      list tools registered inside that DSH instance
  node src/cli.js host agents [--instance ID]         list live sessions of that DSH instance
  node src/cli.js host acl <instance> [--allow id1,id2 | --clear]  restrict which peer token may use this instance
  node src/cli.js host call <tool> [--args JSON | --args-file PATH] [--session ID] [--instance ID]
                                                      call a tool inside that DSH instance (PowerShell drops
                                                      embedded quotes from native args: prefer --args-file there)
  node src/cli.js host wake <sessionId> <text> [--instance ID] [--target next-step|next-turn]
                                                      inject a message into a live session (in-process inbox)
  node src/cli.js host install --profile DIR [--instance ID]
                                                      install dsh-mesh-host into a profile (ID picks port/token; default first hosts entry)
  node src/cli.js cluster status [--no-peers] [--probe-self] [--timeout-ms N]
                                                      one snapshot: local DSH instances + paired peers + verdict
                                                      (--probe-self also checks this node's own serve endpoint)
  node src/cli.js autostart status [--name N]         is the endpoint registered to run at logon? (read-only)
  node src/cli.js autostart install [--name N] --yes  register a logon task running "serve" (user-level change)
  node src/cli.js autostart remove [--name N] --yes   delete that logon task
  node src/cli.js selftest                            run the built-in verification suite
  node src/cli.js acl show                            current allow/deny + per-tool flags
  node src/cli.js acl allow <tool...>                 allow tools (upgrades do NOT widen an edited ACL)
  node src/cli.js acl deny <tool...>                  deny tools
  node src/cli.js acl reset                           reset allow to DEFAULT_ALLOW
  node src/cli.js status                              effective config / secrets / health
  node src/cli.js tools [--all]                       list tools and whether the ACL allows them
  node src/cli.js audit [--limit N] [--tool NAME]     tail the audit log
  node src/cli.js init [--force]                      write a default config.json

Environment:
  DSH_MESH_HOME   override the state directory (default ~/.dsh-mesh)
`

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag)
  if (i === -1) return fallback
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? fallback : v
}

/** http or https, following config.node.tls.enabled. */
function schemeOf(config) {
  return config.node?.tls?.enabled === true ? 'https' : 'http'
}

/** Health probe that trusts the mesh's own self-signed cert when TLS is on. */
async function probeHealth(config, home, port) {
  const tlsCfg = config.node?.tls
  const bind = config.node?.bind || '127.0.0.1'
  if (tlsCfg?.enabled !== true) {
    const res = await fetch(`http://${bind}:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return { status: res.status, body: await res.json() }
  }
  const { get } = await import('node:https')
  const { readFileSync } = await import('node:fs')
  const { certPath } = await import('./core/tls.js')
  const ca = readFileSync(tlsCfg.cert || certPath(home))
  return await new Promise((resolvePromise, rejectPromise) => {
    const req = get({ host: bind, port, path: '/health', ca, timeout: 1500 }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        try {
          resolvePromise({ status: res.statusCode, body: JSON.parse(text) })
        } catch {
          resolvePromise({ status: res.statusCode, body: text })
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', rejectPromise)
  })
}

/** Single-quote a YAML scalar (the only escaping YAML needs for these values). */
function quoteYaml(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * Write a DSH mcp-client overlay for one paired peer (0600: it contains a token).
 *
 * `transport: 'stdio'` spawns `peer bridge` as a child process. The bridge does
 * the pinned TLS handshake itself, so the DSH process needs no CA trust env and
 * a later change of peer/token is picked up by restarting the bridge instead of
 * the whole DSH instance.
 */
function writePeerPatch({ home, peer, serverName, transport = 'streamable-http' }) {
  const out = joinPath(home, 'patches', `${peer.id}.yml`)
  const header = `# generated by dsh-mesh for peer "${peer.id}" — contains a bearer token, keep out of git
`
  const config = transport === 'stdio'
    ? `        transport: stdio
        serverName: ${serverName}
        command: ${quoteYaml(process.execPath)}
        args:
${[
    joinPath(dirnameOf(fileURLToPath(import.meta.url)), 'cli.js'),
    'peer',
    'bridge',
    '--to',
    String(peer.name)
  ].map((arg) => `          - ${quoteYaml(arg)}`).join('\n')}
        env:
          DSH_MESH_HOME: ${quoteYaml(home)}
        toolCallTimeoutMs: 120000
        failOnStartupError: false
`
    : `        transport: streamable-http
        serverName: ${serverName}
        url: ${peer.url}/mcp
        headers:
          Authorization: "Bearer ${peer.token}"
        failOnStartupError: true
`
  const yml = `${header}- insert:
    - id: ${serverName}
      name: "@deepseek-ai/dsh-mcp-client"
      config:
${config}`
  mkdirSync(dirnameOf(resolvePath(out)), { recursive: true })
  writeFileSync(resolvePath(out), yml, { encoding: 'utf8', mode: 0o600 })
  return resolvePath(out)
}

/** Print a peer failure with its machine-readable code plus the one command that explains it. */
function printPeerError(error, peer) {
  const code = typeof error?.code === 'string' ? error.code : null
  console.error(`peer "${peer?.name || '?'}" failed: ${code ? `[${code}] ` : ''}${error?.message || error}`)
  console.error(`run \`node src/cli.js peer doctor${peer?.name ? ` --to ${peer.name}` : ''}\` for a full diagnosis`)
}

/** Minimal ctx for listing tools outside a running server. */
function offlineCtx(config, home) {
  const ctx = {
    home,
    getConfig: () => config,
    isAllowed,
    toolNames: () => buildAll(ctx).map((s) => s.name),
    secrets: { inbound: [] },
    log: console,
    audit: async () => {},
    jobs: null,
    dispatch: async () => {
      throw new Error('offline ctx cannot dispatch')
    }
  }
  return ctx
}

async function main(argv) {
  const cmd = argv[0] || 'help'
  const home = meshHome()

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return 0
  }

  if (cmd === 'init') {
    const force = argv.includes('--force')
    loadConfig(home)
    if (force) {
      saveConfig(defaultConfig(), home)
      console.log(`wrote default config: ${configPath(home)}`)
    } else {
      console.log(`config ready: ${configPath(home)}`)
    }
    console.log(`secrets: ${secretsPath(home)}`)
    console.log(`jobs dir: ${home}/jobs`)
    console.log(`audit  : ${auditPath(home)}`)
    return 0
  }

  if (cmd === 'tls') {
    const sub = argv[1] || 'info'
    const { generateCert, describeCert, hasCert } = await import('./core/tls.js')
    if (sub === 'init') {
      const sans = String(argValue(argv, '--san', '')).split(',').map((s) => s.trim()).filter(Boolean)
      const days = Number(argValue(argv, '--days', '825'))
      const force = argv.includes('--force')
      const result = await generateCert({ home, sans, days, force })
      console.log(
        result.reused
          ? 'certificate already present (it is now the trust anchor for the peer; use --force to regenerate)'
          : 'generated self-signed certificate (CA-and-leaf, SAN includes localhost/127.0.0.1/hostname + --san)'
      )
      console.log(JSON.stringify(describeCert(home), null, 2))
      console.log('\nnext steps:')
      console.log('  1) set node.tls.enabled = true in ' + configPath(home) + ', then restart `serve`')
      console.log('  2) on the PEER side (the DSH process that connects) set:')
      console.log('       NODE_EXTRA_CA_CERTS=' + result.certPath)
      console.log('  3) peer url becomes https://<host>:<port>/mcp')
      return 0
    }
    console.log(JSON.stringify(describeCert(home), null, 2))
    if (!hasCert(home)) console.log('(no certificate yet — run `node src/cli.js tls init`)')
    return 0
  }

  if (cmd === 'rotate') {
    const { rotateToken, secretsPath: spath } = await import('./core/config.js')
    const id = argValue(argv, '--id', 'default')
    const note = argValue(argv, '--note', undefined)
    const rotated = rotateToken({ home, id, note })
    console.log(`rotated inbound token "${rotated.id}" in ${spath(home)} (0600)`)
    console.log(`new token: ${rotated.token}`)
    console.log('if the server is running it picks this up automatically; otherwise restart `serve`.')
    console.log('re-run `node src/cli.js patch --out ...` to refresh the peer overlay.')
    return 0
  }

  if (cmd === 'peer') {
    const sub = argv[1]
    const { loadPeers, savePeers } = await import('./core/pairing.js')
    const peers = loadPeers(home)

    if (sub === undefined || sub === 'list') {
      console.log(
        JSON.stringify(
          {
            peers: peers.items.map((p) => ({
              id: p.id,
              name: p.name,
              url: p.url,
              certFingerprint: p.certFingerprint,
              disabled: Boolean(p.disabled),
              addedAt: p.addedAt
            })),
            file: peersPath(home)
          },
          null,
          2
        )
      )
      return 0
    }

    if (sub === 'add') {
      const url = argValue(argv, '--url', undefined)
      const code = argValue(argv, '--code', undefined)
      const name = argValue(argv, '--name', undefined) || 'peer'
      const caPath = argValue(argv, '--ca', undefined)
      const pin = argValue(argv, '--fingerprint', undefined)
      if (!url || !code) {
        console.error('usage: node src/cli.js peer add --url <https://host:port> --code XXXX-XXXX [--name NAME] [--ca cert.pem | --fingerprint SHA256]')
        return 1
      }
      const base = url.replace(/\/+$/, '')
      let res
      try {
        res = await postJson(`${base}/pair`, { code, peerName: name }, { caPath, fingerprint: pin })
      } catch (error) {
        console.error(`pairing request failed: ${error?.code ? `[${error.code}] ` : ''}${error?.message || error}`)
        if (error?.code === 'E_PIN_MISMATCH') {
          console.error('证书指纹与 --fingerprint 不一致：可能证书已轮换（重新 tls init 过）或被中间人替换。')
          console.error('先在被访问端跑 `node src/cli.js pair --code` 看它打印的 certFingerprint，核对后再配。')
        } else if (String(base).startsWith('https:')) {
          console.error('self-signed cert: pass --ca <the node cert.pem>, or pin with --fingerprint <sha256 from `pair --code`>')
        }
        return 1
      }
      if (res.status !== 200 || !res.body?.ok) {
        console.error(`pairing rejected: ${res.status} ${JSON.stringify(res.body)}`)
        return res.status === 401 ? 2 : 1
      }
      const entry = {
        id: res.body.tokenId,
        name,
        url: base,
        token: res.body.token,
        // 记「实际连到的证书指纹」优先于服务端自报值，两者都给时交叉核对
        certFingerprint: res.fingerprint || res.body.certFingerprint || null,
        version: res.body.version,
        addedAt: new Date().toISOString()
      }
      if (res.fingerprint && res.body.certFingerprint) {
        const { assertFingerprint } = await import('./core/tls.js')
        assertFingerprint(res.body.certFingerprint, res.fingerprint)
      }
      peers.items = [...peers.items.filter((p) => p.id !== entry.id), entry]
      savePeers(peers, home)
      const patchFile = writePeerPatch({ home, peer: entry, serverName: `${name}-mesh` })
      console.log(
        JSON.stringify(
          {
            paired: entry.id,
            url: entry.url,
            certFingerprint: entry.certFingerprint,
            peersFile: peersPath(home),
            patchFile,
            next: `dsh --profile headless --patch "${patchFile}" "call mcp__${name}-mesh__mesh_self"`
          },
          null,
          2
        )
      )
      return 0
    }

    if (sub === 'import') {
      const file = argValue(argv, '--file', argv[2])
      if (!file) {
        console.error('usage: node src/cli.js peer import --file <name>.yml [--name NAME] [--url URL] [--meta <name>.json] [--fingerprint SHA256]')
        return 1
      }
      const { readFileSync: readFileSyncFn } = await import('node:fs')
      const { parsePeerOverlay } = await import('./core/peer-client.js')
      let imported
      try {
        const overlayText = readFileSyncFn(resolvePath(file), 'utf8')
        const metaFile = argValue(argv, '--meta', undefined)
        const meta = metaFile ? JSON.parse(readFileSyncFn(resolvePath(metaFile), 'utf8')) : null
        imported = parsePeerOverlay(overlayText, { meta })
      } catch (error) {
        console.error(`peer import failed: ${error?.message || error}`)
        return 1
      }
      const name = argValue(argv, '--name', imported.suggestedName)
      const entry = {
        id: `peer-${name}`,
        name,
        url: argValue(argv, '--url', imported.url),
        token: imported.token,
        certFingerprint: argValue(argv, '--fingerprint', imported.certFingerprint) || null,
        tokenId: imported.tokenId,
        source: 'import',
        addedAt: new Date().toISOString()
      }
      peers.items = [...peers.items.filter((item) => item.id !== entry.id && item.name !== name), entry]
      savePeers(peers, home)
      console.log(
        JSON.stringify(
          {
            imported: name,
            url: entry.url,
            tokenId: entry.tokenId,
            hasToken: true,
            certFingerprint: entry.certFingerprint,
            peersFile: peersPath(home)
          },
          null,
          2
        )
      )
      return 0
    }

    if (sub === 'remove') {
      const id = argv[2]
      if (!id) {
        console.error('usage: node src/cli.js peer remove <id>')
        return 1
      }
      const before = peers.items.length
      peers.items = peers.items.filter((p) => p.id !== id)
      savePeers(peers, home)
      console.log(`removed ${before - peers.items.length} peer(s) from ${peersPath(home)}`)
      console.log('note: this only forgets the client-side record; revoke the token on the node with `revoke <id>`')
      return 0
    }

    if (sub === 'disable' || sub === 'enable') {
      const id = argv[2]
      if (!id) {
        console.error('usage: node src/cli.js peer disable|enable <id>')
        return 1
      }
      const target = peers.items.find((p) => p.id === id || p.name === id)
      if (!target) {
        console.error('unknown peer "' + id + '" — run `node src/cli.js peer list`')
        return 1
      }
      target.disabled = sub === 'disable'
      savePeers(peers, home)
      console.log((sub === 'disable' ? 'disabled' : 'enabled') + ' peer "' + target.name + '" (' + target.id + ')')
      return 0
    }

    if (sub === 'patch') {
      const idArg = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined
      const wanted = argValue(argv, '--to', argValue(argv, '--peer', idArg))
      const peer = wanted ? peers.items.find((p) => p.id === wanted || p.name === wanted) : peers.items[0]
      if (!peer) {
        console.error(wanted ? `no paired peer "${wanted}"` : 'no peers yet; run `peer add` first')
        return 1
      }
      if (peer.disabled) { console.error(`peer "${peer.name}" is disabled`); return 1 }
      const transport = argValue(argv, '--transport', 'streamable-http')
      if (transport !== 'streamable-http' && transport !== 'stdio') {
        console.error(`unknown --transport "${transport}" (streamable-http | stdio)`)
        return 1
      }
      const out = writePeerPatch({
        home,
        peer,
        serverName: argValue(argv, '--server-name', `${peer.name}-mesh`),
        transport
      })
      console.log(`wrote ${out} (transport: ${transport})`)
      if (transport === 'stdio') {
        console.log('DSH hot-reloads profile patches (HMR): the instance that mounts this path picks it up within seconds; restart only if it does not')
      }
      return 0
    }

    if (sub === 'tools' || sub === 'call' || sub === 'bridge' || sub === 'doctor') {
      if (sub === 'doctor') {
        const { runPeerDoctor } = await import('./core/peer-doctor.js')
        const report = await runPeerDoctor({
          home,
          target: argValue(argv, '--to', argValue(argv, '--peer', undefined)),
          timeoutMs: Number(argValue(argv, '--timeout-ms', 8000)) || 8000,
          env: process.env
        })
        console.log(JSON.stringify(report, null, 2))
        return report.verdict === 'fail' ? 1 : 0
      }

      const { callPeerTool, listPeerTools } = await import('./core/peer-client.js')
      const target = argValue(argv, '--to', argValue(argv, '--peer', undefined))
      const peer = target
        ? peers.items.find((p) => p.name === target || p.id === target)
        : peers.items.length === 1
          ? peers.items[0]
          : null
      if (!peer) {
        const available = peers.items.map((p) => p.name).join(', ') || 'none'
        console.error(target ? `unknown peer "${target}" — paired: ${available}` : `several peers are paired (${available}); pass --to <name>`)
        return 1
      }
      if (peer.disabled) {
        console.error(`peer "${peer.name}" is disabled; run \`node src/cli.js peer enable ${peer.name}\` first`)
        return 1
      }
      const timeoutMs = Number(argValue(argv, '--timeout-ms', 30000)) || 30000

      if (sub === 'bridge') {
        const { runPeerBridge } = await import('./peer-bridge.js')
        // Resolves once the stdio server is serving; the process stays alive on the pipe.
        await runPeerBridge(peer, {
          serverName: argValue(argv, '--server-name', peer.name),
          timeoutMs,
          log: console
        })
        return null
      }

      if (sub === 'tools') {
        try {
          const listed = await listPeerTools(peer, { timeoutMs })
          console.log(JSON.stringify(listed, null, 2))
          return 0
        } catch (error) {
          printPeerError(error, peer)
          return 1
        }
      }

      const tool = argv[2]
      if (!tool || tool.startsWith('--')) {
        console.error('usage: node src/cli.js peer call <tool> [--to NAME] [--args JSON | --args-file PATH] [--timeout-ms N]')
        return 1
      }
      let args = {}
      try {
        const argsFile = argValue(argv, '--args-file', undefined)
        const argsJson = argValue(argv, '--args', undefined)
        if (argsFile) args = JSON.parse(readFileSync(resolvePath(argsFile), 'utf8'))
        else if (argsJson) args = JSON.parse(argsJson)
      } catch (error) {
        console.error(`invalid --args/--args-file JSON: ${error?.message || error}`)
        return 1
      }
      try {
        const result = await callPeerTool(peer, { tool, args, timeoutMs })
        console.log(JSON.stringify({ peer: peer.name, tool, ok: result.ok, ms: result.ms, result: result.result }, null, 2))
        return result.ok ? 0 : 1
      } catch (error) {
        printPeerError(error, peer)
        return 1
      }
    }

    console.error('usage: node src/cli.js peer [list | add --url URL --code CODE [--name NAME] [--ca cert.pem] | import --file <name>.yml [--meta <name>.json] | remove <id> | disable|enable <id> | patch [id] [--transport streamable-http|stdio] | tools [--to NAME] | call <tool> [--to NAME] [--args JSON] | doctor [--to NAME] | bridge --to NAME]')
    return 1
  }

  if (cmd === 'token') {
    const sub = argv[1] || 'list'
    const { addInboundToken, loadSecrets, setTokenRole, migrateTokensToRoles } = await import('./core/config.js')
    const { ROLE_NAMES, isRole, describeRole } = await import('./core/roles.js')
    if (sub === 'list') {
      const secrets = loadSecrets(home)
      const rows = (secrets.inbound || []).map((entry) => ({
        id: entry.id,
        note: entry.note || '',
        role: entry.role || null,
        roleHint: entry.role ? describeRole(entry.role) : (entry.acl ? '显式 ACL（legacy）' : '继承节点 ACL'),
        acl: entry.acl || null
      }))
      console.log(JSON.stringify(rows, null, 2))
      return 0
    }
    if (sub === 'set-role') {
      const id = argv[2]
      const role = argValue(argv, '--role', '')
      const yes = argv.includes('--yes')
      if (!id || !isRole(role)) {
        console.error(`usage: node src/cli.js token set-role <id> --role <${ROLE_NAMES.join('|')}> [--yes]`)
        return 1
      }
      if (!yes) {
        console.log(JSON.stringify({ dryRun: true, id, role, description: describeRole(role) }, null, 2))
        console.log('加 --yes 才写入 secrets.json（热重载，无需重启）')
        return 0
      }
      const r = setTokenRole({ home, id, role })
      console.log(JSON.stringify({ ...r, description: describeRole(role) }, null, 2))
      return 0
    }
    if (sub === 'migrate-roles') {
      const yes = argv.includes('--yes')
      const r = migrateTokensToRoles({ home, dryRun: !yes })
      console.log(JSON.stringify(r, null, 2))
      if (!yes) console.log('加 --yes 才真正迁移（迁移前自动备份 secrets.json）')
      return 0
    }
    if (sub === 'add') {
      const id = argValue(argv, '--id', undefined)
      const note = argValue(argv, '--note', 'narrow token')
      const allowRaw = argValue(argv, '--allow', '')
      const fsRootsRaw = argValue(argv, '--fs-roots', '')
      const roleRaw = argValue(argv, '--role', '')
      const yes = argv.includes('--yes')
      if (roleRaw && !isRole(roleRaw)) {
        console.error(`unknown role: ${roleRaw}（可选：${ROLE_NAMES.join(', ')}）`)
        return 1
      }
      const acl = {}
      if (!roleRaw && allowRaw) acl.allow = allowRaw.split(',').map((s) => s.trim()).filter(Boolean)
      if (roleRaw && allowRaw) console.error('⚠️ 同时给了 --role 和 --allow：以角色能力包为准，--allow 被忽略')
      if (fsRootsRaw) acl.fsRoots = fsRootsRaw.split(';').map((s) => s.trim()).filter(Boolean)
      const plan = {
        id: id || '(auto: token-<random>)',
        note,
        role: roleRaw || null,
        roleDescription: roleRaw ? describeRole(roleRaw) : undefined,
        acl: Object.keys(acl).length ? acl : '(inherit node ACL)'
      }
      if (!yes) {
        console.log('（dry-run）将新增 inbound token：')
        console.log(JSON.stringify(plan, null, 2))
        console.log('加 --yes 才写入 secrets.json（热重载，无需重启）')
        return 0
      }
      const finalId = id || `token-${Math.random().toString(16).slice(2, 10)}`
      const created = addInboundToken({ home, id: finalId, note, role: roleRaw || undefined, acl: Object.keys(acl).length ? acl : undefined })
      console.log(JSON.stringify({ id: created.id, role: created.role, token: created.token, acl: plan.acl, note }, null, 2))
      console.log('⚠️ token 只显示这一次；只给对端配置用，禁止写进 git / 群聊 / 会分享的文档')
      return 0
    }
    console.error('usage: node src/cli.js token list | token add [--role observer|controller|node|admin] [--allow a,b] [--fs-roots "C:\\a;C:\\b"] [--note TEXT] [--yes] | token set-role <id> --role <role> [--yes] | token migrate-roles [--yes]')
    return 1
  }

  if (cmd === 'revoke') {
    const { removeInboundToken } = await import('./core/config.js')
    const id = argv[1]
    if (!id) {
      console.error('usage: node src/cli.js revoke <token-id>   (ids: see `node src/cli.js status`, secrets.json)')
      return 1
    }
    const { removed } = removeInboundToken({ home, id })
    console.log(`revoked ${removed} inbound token(s) with id "${id}"; live server picks it up immediately`)
    return removed > 0 ? 0 : 1
  }

  if (cmd === 'discover') {
    const timeoutMs = Number(argValue(argv, '--timeout-ms', '1800'))
    const port = Number(argValue(argv, '--port', String(LAN_DISCOVERY_PORT)))
    const cfg = loadConfig(home)
    const nodes = await discoverLan({ timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 1800, port, group: cfg.lan?.group || '', groupKey: cfg.lan?.groupKey || '' })
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ ok: true, port, nodes }, null, 2))
    } else if (!nodes.length) {
      console.log('no dsh-mesh node found on LAN (check node.bind=0.0.0.0 + firewall for udp/' + port + ')')
    } else {
      for (const node of nodes) console.log(`${node.node}\t${node.url}\t${node.version || ''}\t${node.address}`)
    }
    return 0
  }

  if (cmd === 'group') {
    const sub = argv[1] || 'show'
    const config = loadConfig(home)
    if (sub === 'show') {
      console.log(JSON.stringify({ group: config.lan?.group || '', hasKey: Boolean(config.lan?.groupKey), configPath: configPath(home) }, null, 2))
      return 0
    }
    if (sub === 'set' || sub === 'clear') {
      const group = sub === 'clear' ? '' : String(argv[2] || '').trim()
      const key = sub === 'clear' ? '' : String(argValue(argv, '--key', '')).trim()
      if (sub === 'set' && !group) { console.error('usage: node src/cli.js group set <name> [--key SECRET]'); return 1 }
      const bak = configPath(home) + '.bak-group-' + Date.now()
      try { (await import('node:fs')).copyFileSync(configPath(home), bak) } catch { /* first run */ }
      config.lan = { ...(config.lan || {}), group, groupKey: key }
      saveConfig(config, home)
      console.log(JSON.stringify({ ok: true, group, hasKey: Boolean(key), backup: bak }, null, 2))
      return 0
    }
    console.error('usage: node src/cli.js group [show | set <name> [--key SECRET] | clear]')
    return 1
  }

  if (cmd === 'serve') {
    // 注意：这里**故意不传 secrets** —— 传了 startMeshServer 会把它当固定值，
    // 配对/轮换/吊销就要重启才生效。让 server 自己用 createSecretsLoader 按 mtime 热重载。
    const port = argValue(argv, '--port', undefined)
    const bind = argValue(argv, '--bind', undefined)
    const srv = await startMeshServer({
      home,
      port: port ? Number(port) : undefined,
      bind: bind || undefined,
      log: {
        info: (m) => console.error(m),
        warn: (m) => console.error(m),
        debug: (m) => process.env.DSH_MESH_DEBUG && console.error(m),
        error: (m) => console.error(m)
      }
    })
    const config = loadConfig(home)
    const lanResponder = argv.includes('--no-lan-discovery')
      ? { close: () => {} }
      : startLanResponder({
      home,
      config,
      port: LAN_DISCOVERY_PORT,
        log: { info: (m) => console.error(m), warn: (m) => console.error(m) }
      })
    console.log(`dsh-mesh listening on ${srv.url}`)
    console.log(`  node   : ${config.node?.name || 'local'}`)
    if (!argv.includes('--no-lan-discovery')) console.log(`  lan    : udp/${LAN_DISCOVERY_PORT} (discovery)`)
    console.log(`  config : ${configPath(home)} (hot-reloaded on save)`)
    console.log(`  secrets: ${secretsPath(home)}`)
    console.log(`  audit  : ${auditPath(home)}`)
    console.log(`  health : ${schemeOf(config)}://${config.node.bind || '127.0.0.1'}:${srv.port}/health`)
    const shutdown = async (signal) => {
      console.error(`\n[dsh-mesh] ${signal} received, shutting down`)
      lanResponder.close()
      await srv.close()
      process.exit(0)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    // Self-restart hook: the supervisor (scripts/mesh-supervisor.mjs) owns the
    // process tree. Writing `~/.dsh-mesh/restart.flag` makes THIS process exit
    // gracefully; the supervisor immediately starts the new code. No kill from
    // an AI session, and no parent/child dependency on DSH.
    const restartFlag = joinPath(home, 'restart.flag')
    const restartWatcher = setInterval(() => {
      if (!existsSync(restartFlag)) return
      try {
        rmSync(restartFlag, { force: true })
      } catch {
        /* flag removal is best-effort */
      }
      console.error('[dsh-mesh] restart.flag detected — exiting for supervisor')
      shutdown('restart-flag')
    }, 1000)
    restartWatcher.unref?.()
    return null // keep the process alive
  }

  if (cmd === 'pair') {
    const config = loadConfig(home)
    const secrets = loadSecrets(home)
    const scheme = schemeOf(config)
    const host = argValue(argv, '--host', `${config.node.bind || '127.0.0.1'}:${config.node.port || 8124}`)
    const port = argValue(argv, '--port', String(config.node.port || 8124))
    const endpoint = host.includes(':')
      ? `${scheme}://${host}${config.node.path || '/mcp'}`
      : `${scheme}://${host}:${port}${config.node.path || '/mcp'}`
    if (argv.includes('--code')) {
      const { createPairingCode } = await import('./core/pairing.js')
      const { isRole, ROLE_NAMES } = await import('./core/roles.js')
      const { describeCert } = await import('./core/tls.js')
      const rawTtl = Number(argValue(argv, '--ttl', String(config.pairing?.codeTtlSec || 1800)))
      const ttlSec = Number.isFinite(rawTtl) ? Math.min(86400, Math.max(60, Math.round(rawTtl))) : 1800
      const role = argValue(argv, '--role', 'node')
      if (!isRole(role)) {
        console.error(`unknown role: ${role}（可选：${ROLE_NAMES.join(', ')}）`)
        return 1
      }
      const created = createPairingCode({ home, ttlSec, role })
      const cert = scheme === 'https' ? describeCert(home) : null
      console.log(
        JSON.stringify(
          {
            pairingCode: created.code,
            role: created.role,
            expiresAt: created.expiresAt,
            ttlSec,
            ttlHint: `码 ${Math.round(ttlSec / 60)} 分钟内有效、一次性；想留更久用 --ttl 86400（最长 24 h）`,
            node: config.node.name,
            endpoint,
            certFingerprint: cert?.fingerprint256 ?? null,
            nextSteps: [
              `on the peer machine: node src/cli.js peer add --url ${endpoint.replace(/\/mcp$/, '')} --code ${created.code} --name ${config.node.name}`,
              `role: ${created.role}（对端兑换后获得这个角色；不用再逐工具授权）`,
              scheme === 'https'
                ? `pass --fingerprint ${describeCert(home).fingerprint256} (or --ca <this node cert.pem>)`
                : undefined
            ].filter(Boolean)
          },
          null,
          2
        )
      )
      return 0
    }
    const token = secrets.inbound[0]?.token
    console.log(
      JSON.stringify(
        {
          node: config.node.name,
          endpoint,
          tls: scheme === 'https',
          headers: { Authorization: `Bearer ${token}` },
          mcpServers: {
            [`${config.node.name}-mesh`]: { url: endpoint, headers: { Authorization: `Bearer ${token}` } }
          },
          healthCheck: `curl -s -o /dev/null -w "%{http_code}" ${endpoint.replace(/\/mcp$/, '')}/health`,
          peerEnv: scheme === 'https' ? { NODE_EXTRA_CA_CERTS: '~/.dsh-mesh/tls/cert.pem (copy from this node)' } : undefined
        },
        null,
        2
      )
    )
    return 0
  }

  if (cmd === 'patch') {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname, resolve: resolvePath } = await import('node:path')
    const config = loadConfig(home)
    const secrets = loadSecrets(home)
    const out = argValue(argv, '--out', `${home}/patches/peer-${config.node.name || 'local'}.yml`)
    const serverName = argValue(argv, '--server-name', `${config.node.name || 'local'}-mesh`)
    const scheme = schemeOf(config)
    const url = argValue(
      argv,
      '--url',
      `${scheme}://${config.node.bind || '127.0.0.1'}:${config.node.port || 8124}${config.node.path || '/mcp'}`
    )
    const token = secrets.inbound[0]?.token
    const yml = `# generated by dsh-mesh — contains a bearer token, keep out of git
- insert:
    - id: ${serverName}
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: streamable-http
        serverName: ${serverName}
        url: ${url}
        headers:
          Authorization: "Bearer ${token}"
        failOnStartupError: true
`
    mkdirSync(dirname(resolvePath(out)), { recursive: true })
    writeFileSync(resolvePath(out), yml, { encoding: 'utf8', mode: 0o600 })
    console.log(`wrote DSH patch overlay: ${resolvePath(out)}`)
    console.log(`boot with: dsh --profile <name> --patch "${resolvePath(out)}"`)
    if (scheme === 'https') {
      console.log('TLS is on: the connecting DSH process needs the peer certificate as a trust anchor, e.g.')
      console.log(`  $env:NODE_EXTRA_CA_CERTS = "<path to the server's cert.pem>"`)
    }
    return 0
  }

  if (cmd === 'host') {
    const sub = argv[1] || 'status'
    const config = loadConfig(home)
    const { createHostClient, hostInstances, hostTokenPath } = await import('./core/host-agent.js')
    const instanceArg = argValue(argv, '--instance')
    const pickEntry = () => {
      const list = hostInstances(config)
      const entry = instanceArg ? list.find((item) => item.id === instanceArg) : list[0]
      if (!entry) {
        throw new Error(
          instanceArg
            ? `unknown host instance "${instanceArg}" — configured: ${list.map((item) => item.id).join(', ')}`
            : 'no host bridge configured (config.hosts is empty)'
        )
      }
      return entry
    }

    if (sub === 'acl') {
      const id = argv[2] || instanceArg
      if (!id) { console.error('usage: node src/cli.js host acl <instance> [--allow peerId1,peerId2 | --clear]'); return 1 }
      const entry = (config.hosts || []).find((item) => item.id === id)
      if (!entry) { console.error('unknown host instance "' + id + '"'); return 1 }
      const allow = argValue(argv, '--allow', undefined)
      if (allow === undefined && !argv.includes('--clear')) { console.error('usage: node src/cli.js host acl <instance> [--allow peerId1,peerId2 | --clear]'); return 1 }
      const bak = configPath(home) + '.bak-hostacl-' + Date.now()
      try { copyFileSync(configPath(home), bak) } catch { /* first run */ }
      entry.allowedPeers = argv.includes('--clear') ? [] : String(allow).split(',').map((s) => s.trim()).filter(Boolean)
      saveConfig(config, home)
      console.log(JSON.stringify({ ok: true, instance: id, allowedPeers: entry.allowedPeers, backup: bak }, null, 2))
      return 0
    }

    if (sub === 'install') {
      const profile = argValue(argv, '--profile')
      if (!profile) {
        console.error('usage: node src/cli.js host install --profile <DSH profile dir> [--instance <id>]')
        console.error('  e.g. node src/cli.js host install --profile "%USERPROFILE%\\.dsh0\\profiles\\headless"')
        return 1
      }
      const profileDir = resolvePath(profile)
      if (!existsSync(joinPath(profileDir, 'package.json'))) {
        console.error(`not a DSH profile (no package.json): ${profileDir}`)
        return 1
      }
      const pluginSrc = resolvePath(joinPath(dirnameOf(fileURLToPath(import.meta.url)), '..', 'plugin'))
      if (!existsSync(joinPath(pluginSrc, 'lib', 'index.js'))) {
        console.error(`plugin source missing: ${pluginSrc}`)
        return 1
      }
      const pluginDst = joinPath(profileDir, 'node_modules', 'dsh-mesh-host')
      mkdirSync(joinPath(pluginDst, 'lib'), { recursive: true })
      copyFileSync(joinPath(pluginSrc, 'package.json'), joinPath(pluginDst, 'package.json'))
      copyFileSync(joinPath(pluginSrc, 'lib', 'index.js'), joinPath(pluginDst, 'lib', 'index.js'))
      const patchPath = joinPath(profileDir, 'cordis.patch.yml')
      const current = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
      if (current.includes('dsh-mesh-host')) {
        console.log(`plugin already wired in ${patchPath}`)
      } else {
        const trimmed = current.trim()
        if (trimmed && trimmed !== '[]') {
          const backup = `${patchPath}.bak-mesh-${Date.now()}`
          writeFileSync(backup, current, 'utf8')
          console.log(`existing patch entries kept; backed up to ${backup}`)
        }
        const header = trimmed && trimmed !== '[]' ? `${current.trimEnd()}\n` : ''
        const block = '- insert:\n    - id: mesh-host\n      name: dsh-mesh-host\n'
        writeFileSync(patchPath, header + block, 'utf8')
        console.log(`wired plugin into ${patchPath}`)
      }
      const entry = pickEntry()
      console.log(`installed: ${pluginDst}`)
      console.log(`instance: ${entry.id} -> ${entry.url}`)
      console.log('restart that DSH instance to load it. If this is NOT dsh0, start it with:')
      console.log(`  $env:DSH_MESH_HOST_PORT="${new URL(entry.url).port || '9100'}"`)
      console.log(`  $env:DSH_MESH_HOST_TOKEN_FILE="${hostTokenPath(config, home, entry.id)}"`)
      console.log('(the plugin creates the token file on first load, 0600)')
      return 0
    }

    if (sub === 'status' && !instanceArg) {
      const rows = []
      for (const entry of hostInstances(config)) {
        const client = createHostClient({ config, home, log: console, instance: entry.id })
        const alive = await client.ping().catch(() => false)
        if (!alive) {
          rows.push({ id: entry.id, label: entry.label || entry.id, url: entry.url, alive: false })
          continue
        }
        try {
          const self = await client.self()
          rows.push({
            id: entry.id,
            label: entry.label || entry.id,
            url: entry.url,
            alive: true,
            plugin: self.plugin,
            node: self.node,
            tools: self.tools.length,
            agents: self.agents
          })
        } catch (error) {
          rows.push({ id: entry.id, url: entry.url, alive: true, error: error?.message || String(error) })
        }
      }
      console.log(JSON.stringify({ instances: rows }, null, 2))
      return rows.some((row) => row.alive) ? 0 : 1
    }

    const client = createHostClient({ config, home, log: console, instance: instanceArg })
    if (sub === 'status') {
      const alive = await client.ping()
      if (!alive) {
        console.log(JSON.stringify({ instance: client.id, bridge: client.url, alive: false, hint: 'start a DSH instance with dsh-mesh-host installed (node src/cli.js host install --profile <profile> --instance ' + client.id + ')' }, null, 2))
        return 1
      }
      const self = await client.self()
      console.log(JSON.stringify({ instance: client.id, bridge: client.url, alive: true, plugin: self.plugin, node: self.node, tools: self.tools.length, agents: self.agents }, null, 2))
      return 0
    }
    if (sub === 'tools') {
      const { tools } = await client.tools()
      const search = (argValue(argv, '--search') || '').toLowerCase()
      const rows = (tools || []).filter(
        (t) => !search || String(t.name).toLowerCase().includes(search) || String(t.description || '').toLowerCase().includes(search)
      )
      console.log(JSON.stringify({ instance: client.id, count: rows.length, tools: rows }, null, 2))
      return 0
    }
    if (sub === 'agents') {
      const { agents } = await client.agents()
      console.log(JSON.stringify({ instance: client.id, count: agents.length, agents }, null, 2))
      return 0
    }
    if (sub === 'sessions') {
      const { sessions } = await client.sessions({ limit: Number(argValue(argv, '--limit')) || 50 })
      console.log(JSON.stringify({ instance: client.id, count: sessions.length, sessions }, null, 2))
      return 0
    }
    if (sub === 'call') {
      const tool = argv[2]
      if (!tool) {
        console.error('usage: node src/cli.js host call <tool> [--args JSON | --args-file PATH] [--session ID] [--instance ID]')
        return 1
      }
      let args = {}
      try {
        const argsFile = argValue(argv, '--args-file')
        args = JSON.parse((argsFile ? readFileSync(resolvePath(argsFile), 'utf8') : argValue(argv, '--args', '{}')) || '{}')
      } catch (error) {
        console.error(`--args must be JSON: ${error?.message || error}`)
        return 1
      }
      const result = await client.callTool({ tool, args, sessionId: argValue(argv, '--session') })
      console.log(JSON.stringify({ instance: client.id, result }, null, 2))
      return 0
    }
    if (sub === 'wake') {
      const sessionId = argv[2]
      const text = argv.slice(3).filter((a) => !a.startsWith('--')).join(' ')
      if (!sessionId || !text) {
        console.error('usage: node src/cli.js host wake <sessionId> <text...> [--instance ID] [--target next-step|next-turn]')
        return 1
      }
      console.log(JSON.stringify({ instance: client.id, result: await client.wake({ sessionId, text, target: argValue(argv, '--target') }) }, null, 2))
      return 0
    }
    console.error(`unknown host subcommand: ${sub} (status|tools|agents|sessions|call|wake|install)`)
    return 1
  }

  if (cmd === 'cluster') {
    const sub = argv[1] || 'status'
    const { loadPeers } = await import('./core/pairing.js')
    const { clusterReport } = await import('./core/cluster.js')
    if (sub === 'status') {
      try {
        const config = loadConfig(home)
        const peers = argv.includes('--no-peers') ? [] : loadPeers(home).items || []
        const report = await clusterReport({
          config,
          home,
          log: console,
          peers: peers.map((peer) => ({
            id: peer.id,
            name: peer.name,
            url: peer.url,
            certFingerprint: peer.certFingerprint,
            token: peer.token
          })),
          timeoutMs: Number(argValue(argv, '--timeout-ms', 4000)),
          // Run from outside the server, so "my own endpoint is dead" is a real
          // failure mode that the host-bridge probes cannot see (2026-10-23).
          probeSelf: argv.includes('--probe-self')
        })
        console.log(JSON.stringify(report, null, 2))
        return 0
      } catch (error) {
        console.error(`cluster status failed: ${error?.message || error}`)
        return 1
      }
    }
    if (sub === 'exec') {
      const peerName = argValue(argv, '--peer', undefined)
      const tool = argValue(argv, '--tool', undefined)
      if (!peerName || !tool) {
        console.error('usage: node src/cli.js cluster exec --peer NAME --tool TOOL [--args JSON | --args-file FILE] [--timeout-ms N]')
        return 1
      }
      const entry = loadPeers(home).items.find((item) => item.name === peerName || item.id === peerName)
      if (!entry) {
        console.error(`unknown peer "${peerName}" — run \`node src/cli.js peer list\``)
        return 1
      }
      if (entry.disabled) { console.error(`peer "${peerName}" is disabled`); return 1 }
      const { probePeer } = await import('./core/cluster.js')
      const { callPeerTool } = await import('./core/peer-client.js')
      const timeoutMs = Number(argValue(argv, '--timeout-ms', 30000))
      const probe = await probePeer(
        { id: entry.id, name: entry.name, url: entry.url, certFingerprint: entry.certFingerprint },
        { timeoutMs: Math.min(timeoutMs, 8000) }
      )
      if (probe.up !== true || probe.fingerprintMatch !== true) {
        console.error(`peer unreachable or pin mismatch: ${JSON.stringify(probe.error || { fingerprintMatch: probe.fingerprintMatch })}`)
        return 1
      }
      const argsFile = argValue(argv, '--args-file', undefined)
      let args = {}
      try {
        args = JSON.parse((argsFile ? readFileSync(resolvePath(argsFile), 'utf8') : argValue(argv, '--args', '{}')) || '{}')
      } catch (error) {
        console.error(`--args must be JSON: ${error.message}`)
        return 1
      }
      try {
        const out = await callPeerTool(entry, { tool, args, timeoutMs })
        console.log(JSON.stringify({ peer: peerName, node: probe.node, version: probe.version, tool, ok: out.ok, ms: out.ms, result: out.result }, null, 2))
        return out.ok ? 0 : 1
      } catch (error) {
        console.error(`cluster exec failed: ${error?.code ? `[${error.code}] ` : ''}${error?.message || error}`)
        return 1
      }
    }
    console.error('usage: node src/cli.js cluster status [--no-peers] [--probe-self] [--timeout-ms N]')
    console.error('       node src/cli.js cluster exec --peer NAME --tool TOOL [--args JSON | --args-file FILE] [--timeout-ms N]')
    return 1
  }

  if (cmd === 'autostart') {
    const sub = argv[1] || 'status'
    const name = argValue(argv, '--name', TASK_NAME)
    const yes = argv.includes('--yes')
    try {
      if (sub === 'status') {
        const config = loadConfig(home)
        console.log(JSON.stringify({
          task: await autostartStatus(name),
          suggestedCommand: autostartCommand(name, config.node?.port),
          configPath: configPath(home)
        }, null, 2))
        return 0
      }
      if (sub === 'install') {
        const config = loadConfig(home)
        const command = autostartCommand(name, config.node?.port)
        if (!yes) {
          console.error('dry run — nothing changed. Would run:')
          console.error(`  schtasks /Create /TN ${name} /SC ONLOGON /RL LIMITED /TR ${command} /F`)
          console.error('pass --yes to register this logon task (user-level change)')
          return 1
        }
        console.log(JSON.stringify(await autostartInstall({ name, command, yes }), null, 2))
        return 0
      }
      if (sub === 'remove') {
        console.log(JSON.stringify(await autostartRemove({ name, yes }), null, 2))
        return 0
      }
      console.error(`unknown autostart subcommand: ${sub} (status|install|remove)`)
      return 1
    } catch (err) {
      console.error(`autostart ${sub} failed: ${err.message}`)
      return 1
    }
  }

  if (cmd === 'channel') {
    const sub = argv[1]
    const config = loadConfig(home)
    const secrets = loadSecrets(home)
    const configured = (config.dsh?.targets || []).filter((t) => t?.id && t?.baseUrl)
    const saved = secrets.dshWeb || {}

    if (sub === undefined || sub === 'targets') {
      const rows = configured.map((t) => ({
        id: t.id,
        baseUrl: t.baseUrl,
        note: t.note,
        hasCookie: Boolean(saved[t.id]?.cookie),
        savedAt: saved[t.id]?.savedAt
      }))
      for (const id of Object.keys(saved)) {
        if (!rows.some((r) => r.id === id)) {
          rows.push({ id, baseUrl: saved[id].baseUrl, note: '(saved by channel login)', hasCookie: true, savedAt: saved[id].savedAt })
        }
      }
      console.log(JSON.stringify({ targets: rows, configPath: configPath(home), secretsPath: secretsPath(home) }, null, 2))
      return 0
    }

    if (sub === 'login') {
      const launchUrl = argv[2]
      if (!launchUrl) {
        console.error('usage: node src/cli.js channel login <launchUrl> [--target ID]')
        return 1
      }
      const client = new DshWebClient({ log: console })
      const { baseUrl } = await client.login(launchUrl)
      const targetId = argValue(argv, '--target') || `dsh-${new URL(baseUrl).port || '80'}`
      secrets.dshWeb = { ...saved, [targetId]: { baseUrl, cookie: client.cookie, savedAt: new Date().toISOString() } }
      saveSecrets(secrets, home)
      const list = await client.listSessions().catch(() => ({ items: [] }))
      console.log(
        JSON.stringify(
          {
            target: targetId,
            baseUrl,
            sessions: (list.items || []).length,
            savedTo: secretsPath(home),
            note: 'cookie is signed by the DSH instance key and survives restarts of `dsh web`'
          },
          null,
          2
        )
      )
      return 0
    }

    if (sub === 'sessions') {
      const targetId = argv[2]
      const target = configured.find((t) => t.id === targetId) || (targetId ? undefined : configured[0])
      if (!target) {
        console.error('unknown target; run `node src/cli.js channel` to see configured targets')
        return 1
      }
      const client = new DshWebClient({ baseUrl: target.baseUrl, cookie: saved[target.id]?.cookie })
      const value = await client.listSessions()
      console.log(JSON.stringify({ target: target.id, sessions: value?.items || [] }, null, 2))
      return 0
    }

    if (sub === 'send') {
      const text = argv[2]
      if (!text || text.startsWith('--')) {
        console.error('usage: node src/cli.js channel send <text> --target ID [--session ID] [--mode queue|steer] [--wait-ms N]')
        return 1
      }
      const targetId = argValue(argv, '--target')
      const target = configured.find((t) => t.id === targetId)
      const id = targetId || target?.id || Object.keys(saved)[0]
      const entry = id ? saved[id] : undefined
      if (!id || (!target && !entry)) {
        console.error('unknown target; run `node src/cli.js channel targets` to see configured targets and saved cookies')
        return 1
      }
      const baseUrl = target?.baseUrl || entry?.baseUrl
      if (!baseUrl) {
        console.error(`target ${id} has no baseUrl; run \`node src/cli.js channel login <launchUrl> --target ${id}\``)
        return 1
      }
      const mode = argValue(argv, '--mode', 'queue')
      if (mode !== 'queue' && mode !== 'steer') {
        console.error(`unknown --mode: ${mode} (queue|steer)`)
        return 1
      }
      const existing = argValue(argv, '--session')
      const waitMs = Number(argValue(argv, '--wait-ms', String(config.limits?.channelWaitMs ?? 180000)))
      const client = new DshWebClient({ baseUrl, cookie: entry?.cookie, log: console })
      try {
        const sessionId = existing || (await client.createSession())
        const result = await client.sendAndWait({
          sessionId,
          text,
          mode,
          waitMs,
          pollMs: config.limits?.channelPollMs ?? 800
        })
        console.log(
          JSON.stringify(
            {
              target: id,
              created: !existing,
              sessionId: result.sessionId,
              requestId: result.requestId,
              turnEnd: result.turnEnd,
              reply: result.reply,
              events: result.events,
              ms: result.ms
            },
            null,
            2
          )
        )
        return 0
      } catch (error) {
        console.error(`channel send failed: ${error.message}`)
        return 1
      }
    }

    console.error('usage: node src/cli.js channel [targets|login <launchUrl> [--target ID]|sessions [target]|send <text> --target ID [--session ID] [--mode queue|steer] [--wait-ms N]]')
    return 1
  }

  if (cmd === 'acl') {
    const sub = argv[1] || 'show'
    const config = loadConfig(home)
    const known = buildAll(offlineCtx(config, home)).map((s) => s.name)
    if (sub === 'show') {
      console.log(JSON.stringify({ acl: describeAcl(config, known), config: configPath(home) }, null, 2))
      return 0
    }
    if (sub === 'allow' || sub === 'deny' || sub === 'reset') {
      const names = argv.slice(2).filter((a) => !a.startsWith('--'))
      if (sub !== 'reset' && names.length === 0) {
        console.error(`usage: node src/cli.js acl ${sub} <tool...>`)
        return 1
      }
      const change = sub === 'reset' ? { reset: true } : sub === 'allow' ? { allow: names } : { deny: names }
      let next
      try {
        next = resolveAclUpdate(config.acl, { ...change, known })
      } catch (error) {
        console.error(`acl ${sub} failed: ${error.message}`)
        return 1
      }
      if (!next.changed) {
        console.log('acl unchanged')
        return 0
      }
      saveConfig({ ...config, acl: { ...(config.acl || {}), allow: next.allow, deny: next.deny } }, home)
      console.log(JSON.stringify({
        ok: true,
        changes: next.notes,
        allow: next.allow,
        deny: next.deny,
        note: 'server hot-reloads config; no restart needed'
      }, null, 2))
      return 0
    }
    console.error(`unknown acl subcommand: ${sub} (show|allow|deny|reset)`)
    return 1
  }

  if (cmd === 'tools') {
    const config = loadConfig(home)
    const ctx = offlineCtx(config, home)
    const specs = buildAll(ctx)
    const showAll = argv.includes('--all')
    console.log(`${specs.length} tools on node "${config.node?.name || 'local'}"`)
    for (const spec of specs) {
      const allowed = isAllowed(config, spec.name)
      if (!allowed && !showAll) continue
      console.log(`  ${allowed ? 'ALLOW' : 'deny '}  ${spec.name.padEnd(16)} ${spec.title}`)
    }
    if (!showAll && specs.some((s) => !isAllowed(config, s.name))) {
      console.log('  (run with --all to list denied tools too)')
    }
    return 0
  }

  if (cmd === 'audit') {
    const limit = Number(argValue(argv, '--limit', '20'))
    const tool = argValue(argv, '--tool', undefined)
    const tail = tailAudit(home, { limit, tool })
    console.log(`audit: ${tail.path}`)
    for (const entry of tail.entries) {
      const parts = [entry.ts, entry.ok ? 'OK  ' : 'FAIL', String(entry.tool || '').padEnd(16), String(entry.ms ?? '') + 'ms']
      if (entry.code) parts.push(entry.code)
      if (entry.jobId) parts.push(`job=${entry.jobId}`)
      console.log('  ' + parts.join(' '))
    }
    if (tail.entries.length === 0) console.log('  (no entries yet)')
    return 0
  }

  if (cmd === 'status') {
    const config = loadConfig(home)
    const secrets = loadSecrets(home)
    const port = config.node.port || 8124
    let health = null
    try {
      health = await probeHealth(config, home, port)
    } catch (error) {
      health = { status: 'unreachable', error: error?.message || String(error) }
    }
    const { describeCert } = await import('./core/tls.js')
    const { readPairingState } = await import('./core/pairing.js')
    const ctx = offlineCtx(config, home)
    const allowed = buildAll(ctx)
      .map((s) => s.name)
      .filter((n) => isAllowed(config, n))
    console.log(
      JSON.stringify(
        {
          version: MESH_VERSION,
          home,
          config: configPath(home),
          secrets: secretsPath(home),
          audit: auditPath(home),
          pairing: { ...(config.pairing || {}), state: readPairingState(home) },
          node: config.node,
          tls: describeCert(home),
          acl: { ...config.acl, allowedTools: allowed },
          shell: config.shell,
          limits: config.limits,
          inboundTokens: (secrets.inbound || []).map((t) => ({
            id: t.id,
            tokenPreview: `${String(t.token).slice(0, 6)}…${String(t.token).slice(-4)}`
          })),
          peers: config.peers || [],
          health
        },
        null,
        2
      )
    )
    return 0
  }

  if (cmd === 'selftest') {
    return runSelftest()
  }

  console.error(`unknown command: ${cmd}\n`)
  console.log(HELP)
  return 2
}

main(process.argv.slice(2))
  .then((code) => {
    if (typeof code === 'number') process.exit(code)
  })
  .catch((error) => {
    console.error(error?.stack || error)
    process.exit(1)
  })
