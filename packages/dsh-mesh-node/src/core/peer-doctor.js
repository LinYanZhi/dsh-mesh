/**
 * Diagnose one paired peer end to end: can this machine reach it, does a DSH
 * profile mount it, and do the running DSH instances actually expose its tools?
 *
 * Every check corresponds to a failure mode observed in the field:
 * - missing certificate pin / token -> refused handshake or 401;
 * - https peer without NODE_EXTRA_CA_CERTS in the DSH process -> silent
 *   "mcp-client(home): server is disconnected" and zero tools;
 * - overlay mounted but zero tools -> the in-DSH client failed to start
 *   (DSH hot-reloads cordis.patch.yml, so a restart is the last resort, not
 *   the first fix);
 * - ACL/upgrade drift -> tools exist but calls return E_DENIED on the peer.
 *
 * The command is read-only: it never starts, stops, or reconfigures anything.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadConfig, peersPath } from './config.js'
import { loadPeers } from './pairing.js'
import { createHostClient, hostInstances } from './host-agent.js'
import { connectPeer } from './peer-client.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

/** DSH state directories worth scanning, most specific first. */
export function dshHomeCandidates(env = process.env) {
  const homes = []
  const push = (value) => {
    if (value && !homes.includes(value)) homes.push(value)
  }
  push(env.DSH_HOME)
  for (const suffix of ['.dsh0', '.dsh1', '.dsh2', '.dsh3', '.dsh']) push(join(homedir(), suffix))
  return homes
}

/** Which transport the entry around `lineIndex` declares (search a small window). */
function transportFor(lines, lineIndex) {
  for (let index = lineIndex; index >= 0 && index >= lineIndex - 25; index -= 1) {
    const match = lines[index].match(/transport:\s*['"]?([A-Za-z-]+)/)
    if (match) return match[1]
    if (index < lineIndex && /^\s*-\s+insert:/.test(lines[index])) break
  }
  return 'unknown'
}

/** Resolve a path for comparison even when it does not exist yet (junction-aware). */
function canonicalPath(value) {
  try {
    return realpathSync(value)
  } catch {
    return resolve(value)
  }
}

/**
 * True when an overlay's patch file lives in exactly this DSH profile directory.
 * An overlay found through another instance's home (or through a `~/.dsh`
 * junction pointing at `~/.dsh0`) must never be credited to another instance.
 */
export function overlayMatchesProfile(overlay, profileDir) {
  if (!overlay?.patchPath || !profileDir) return false
  const overlayDir = canonicalPath(dirname(overlay.patchPath))
  const wanted = canonicalPath(profileDir)
  return process.platform === 'win32' ? overlayDir.toLowerCase() === wanted.toLowerCase() : overlayDir === wanted
}

/**
 * Find DSH profile overlays that mount this peer (matched by serverName).
 * Pure filesystem read; returns one row per matching overlay.
 */
export function findPeerOverlays(peer, { env = process.env, dshHomes = null } = {}) {
  const names = new Set([peer?.name, peer?.id, `${peer?.name}-mesh`, `${peer?.id}-mesh`].filter(Boolean))
  const matches = []
  const seen = new Set()
  for (const dshHome of dshHomes ?? dshHomeCandidates(env)) {
    const profilesDir = join(dshHome, 'profiles')
    if (!existsSync(profilesDir)) continue
    let profiles
    try {
      profiles = readdirSync(profilesDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const profile of profiles) {
      if (!profile.isDirectory()) continue
      const patchPath = join(profilesDir, profile.name, 'cordis.patch.yml')
      if (!existsSync(patchPath)) continue
      let text
      try {
        text = readFileSync(patchPath, 'utf8')
      } catch {
        continue
      }
      if (!text.includes('dsh-mcp-client')) continue
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^\s*serverName:\s*['"]?([^'"\s]+)['"]?\s*$/)
        if (!match || !names.has(match[1])) continue
        const key = `${canonicalPath(patchPath)}::${match[1]}`
        if (seen.has(key)) continue
        seen.add(key)
        matches.push({
          dshHome,
          profile: profile.name,
          patchPath,
          serverName: match[1],
          transport: transportFor(lines, index)
        })
      }
    }
  }
  return matches
}

function hintForConnectFailure(code) {
  if (code === 'E_PEER_PIN_MISMATCH') {
    return 'the peer certificate changed or the stored pin is wrong: re-pair with `peer add` and the fingerprint printed by `pair --code`'
  }
  if (code === 'E_PEER_NO_PIN') {
    return 'https peer without a fingerprint: `peer import --file <name>.yml --fingerprint <sha256>`'
  }
  if (code === 'E_PEER_AUTH') {
    return 'token rejected: re-pair (`peer add`), or the peer revoked the token (`revoke` on that node)'
  }
  if (code === 'E_PEER_TIMEOUT') {
    return 'no answer in time: check the peer is up (`node src/cli.js cluster status`), the frp tunnel, and that `serve` runs there'
  }
  return 'check the peer node: `node src/cli.js cluster status` and the peer’s own mesh serve log'
}

/**
 * Run all checks and return {verdict, checks, nextSteps}. `verdict` is `fail`
 * only when a hard requirement (peer record, pin, handshake) fails; mount and
 * environment findings are `warn` unless they would make in-session tools
 * silently absent without any explanation.
 */
export async function runPeerDoctor({ home, target = null, timeoutMs = 8000, env = process.env, dshHomes = null } = {}) {
  const checks = []
  const add = (id, status, detail, fix) => checks.push({ id, status, detail, ...(fix ? { fix } : {}) })
  const peers = loadPeers(home)
  const items = peers.items ?? []
  add(
    'peers-file',
    items.length > 0 ? 'pass' : 'fail',
    `${peersPath(home)}: ${items.length} peer record(s)`,
    items.length > 0 ? undefined : 'node src/cli.js peer import --file <name>.yml'
  )

  const peer = target
    ? items.find((item) => item.name === target || item.id === target)
    : items.length === 1
      ? items[0]
      : null
  if (!peer) {
    add(
      'peer-selection',
      'fail',
      target
        ? `peer "${target}" is not in ${peersPath(home)}`
        : `several peers are paired (${items.map((item) => item.name).join(', ')}); pass --to <name>`,
      'node src/cli.js peer list'
    )
    return { verdict: 'fail', checks, nextSteps: ['pick a peer with --to <name>'] }
  }
  add('peer-selection', 'pass', `peer "${peer.name}" -> ${peer.url}`)

  const secure = /^https:/i.test(peer.url)
  if (secure) {
    add(
      'certificate-pin',
      peer.certFingerprint ? 'pass' : 'fail',
      peer.certFingerprint
        ? `pinned ${String(peer.certFingerprint).slice(0, 23)}…`
        : 'https peer has no stored fingerprint; the pinned fetch refuses to connect',
      peer.certFingerprint
        ? undefined
        : 'node src/cli.js peer import --file <name>.yml --fingerprint <sha256 from `pair --code`>'
    )
  } else {
    add('certificate-pin', 'pass', 'plain http peer — no TLS trust needed (not recommended across machines)')
  }

  const overlays = findPeerOverlays(peer, { env, dshHomes })
  const httpOverlay = overlays.find((entry) => entry.transport !== 'stdio')
  const overlayDetail = overlays.map((entry) => `${entry.dshHome}/profiles/${entry.profile} (${entry.transport})`).join('; ')
  const caEnv = env.NODE_EXTRA_CA_CERTS || ''
  if (secure && httpOverlay && !caEnv) {
    add(
      'dsh-ca-env',
      'warn',
      'NODE_EXTRA_CA_CERTS unset in this process and an overlay uses streamable-http: the in-DSH client cannot verify the self-signed peer and stays disconnected',
      `switch it to the stdio bridge: node src/cli.js peer patch --transport stdio --to ${peer.name}`
    )
  } else if (secure) {
    add(
      'dsh-ca-env',
      'pass',
      caEnv ? `NODE_EXTRA_CA_CERTS=${caEnv}` : 'not needed: the stdio bridge pins the peer certificate itself'
    )
  }

  if (overlays.length === 0) {
    add(
      'dsh-overlay',
      'warn',
      'no DSH profile overlay mounts this peer, so only CLI calls work',
      `node src/cli.js peer patch --transport stdio --to ${peer.name}`
    )
  } else {
    add('dsh-overlay', 'pass', overlayDetail)
  }

  // Did the RUNNING instances actually register the peer tools? This is the only
  // check that distinguishes "overlay is valid" from "overlay is live".
  try {
    const config = loadConfig(home)
    const instances = hostInstances(config)
    if (instances.length === 0) {
      add('dsh-live-tools', 'warn', 'no host bridge configured, so loaded tools cannot be verified', 'node src/cli.js host install --profile <DSH profile>')
    }
    for (const entry of instances) {
      const client = createHostClient({ config, home, log: quiet, instance: entry.id })
      const alive = await client.ping().catch(() => false)
      if (!alive) {
        add(`dsh-${entry.id}`, 'warn', 'host bridge not reachable — its loaded tools cannot be verified')
        continue
      }
      const { tools } = await client.tools().catch(() => ({ tools: [] }))
      const names = (tools ?? []).map((tool) => tool.name)
      const mounted = names.filter((name) => name.startsWith(`mcp__${peer.name}__`) || name.startsWith(`mcp__${peer.name}-mesh__`))
      const ownOverlays = entry.profileDir
        ? overlays.filter((overlay) => overlayMatchesProfile(overlay, entry.profileDir))
        : overlays
      if (mounted.length > 0) {
        add(`dsh-${entry.id}`, 'pass', `${mounted.length} peer tool(s) registered (e.g. ${mounted[0]})`)
      } else if (ownOverlays.length > 0) {
        add(
          `dsh-${entry.id}`,
          'warn',
          `overlay is mounted in ${entry.profileDir} but this running instance exposes 0 "${peer.name}" tools (${names.length} total)`,
          'DSH hot-reloads cordis.patch.yml (HMR) within seconds; if the tools stay missing, check the mcp-client startup error in the DSH log — restart only as a last resort'
        )
      } else {
        add(
          `dsh-${entry.id}`,
          'warn',
          `no overlay in this instance's profile (${entry.profileDir || 'unknown'}), so it can never expose peer tools (${names.length} tools total)`,
          entry.profileDir
            ? `add the peer insert block to ${join(entry.profileDir, 'cordis.patch.yml')} (HMR picks it up, no restart)`
            : undefined
        )
      }
    }
  } catch (error) {
    add('dsh-live-tools', 'warn', `could not inspect running instances: ${error?.message || error}`)
  }

  let connection
  const started = Date.now()
  try {
    connection = await connectPeer(peer, { timeoutMs })
    const listed = await connection.client.listTools()
    add('mcp-handshake', 'pass', `initialized and listed ${(listed.tools ?? []).length} tools in ${Date.now() - started} ms`)
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : null
    add('mcp-handshake', 'fail', `${code ? `[${code}] ` : ''}${error?.message || error}`, hintForConnectFailure(code))
  } finally {
    if (connection) await connection.close()
  }

  const verdict = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'ok'
  const nextSteps = []
  const caMissing = secure && !caEnv
  if (httpOverlay && caMissing) {
    nextSteps.push(`switch the overlay to the stdio bridge: node src/cli.js peer patch --transport stdio --to ${peer.name}`)
  }
  if (overlays.length === 0) {
    nextSteps.push(`mount the peer in DSH: node src/cli.js peer patch --transport stdio --to ${peer.name}`)
  }
  const staleLive = checks.filter(
    (check) => check.id.startsWith('dsh-') && check.status === 'warn' && /overlay is mounted in/.test(check.detail)
  )
  if (staleLive.length > 0) {
    nextSteps.push(
      'DSH hot-reloads cordis.patch.yml (HMR): re-run this doctor after ~10 s; restart the instance only if the tools stay missing (read its mcp-client startup error first)'
    )
  }
  return { verdict, peer: { name: peer.name, url: peer.url, secure }, checks, nextSteps }
}
