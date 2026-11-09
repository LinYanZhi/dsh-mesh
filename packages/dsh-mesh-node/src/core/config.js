import { homedir } from 'node:os'
import { join, resolve, sep, isAbsolute } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, statSync, renameSync, copyFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readJsonFile } from './util.js'
import { roleAllow, isRole, inferRole } from './roles.js'

export const MESH_VERSION = '0.17.0'
export const CONFIG_VERSION = 7

/** Defaults for M1 — used only to detect and upgrade an untouched M1 config. */
const M1_DEFAULT_ALLOW = ['mesh_self', 'fs_read', 'git_status']

/** Defaults for M2 — used to upgrade an untouched M2 allow-list to the M3 defaults. */
const M2_DEFAULT_ALLOW = [
  'mesh_self',
  'fs_read',
  'fs_list',
  'fs_stat',
  'fs_grep',
  'git_status',
  'git_log',
  'git_diff',
  'repo_scan',
  'task_submit',
  'task_status',
  'task_list',
  'task_cancel',
  'mesh_audit_tail'
]

/** Defaults for M3.0 — used to upgrade an untouched M3 allow-list to the M4 defaults. */
const M3_DEFAULT_ALLOW = [
  'mesh_self',
  'fs_read',
  'fs_list',
  'fs_stat',
  'fs_grep',
  'git_status',
  'git_log',
  'git_diff',
  'repo_scan',
  'task_submit',
  'task_status',
  'task_list',
  'task_cancel',
  'mesh_audit_tail',
  'channel_targets',
  'channel_sessions',
  'channel_page'
]

/**
 * Read-only tools plus the task queue are allowed out of the box.
 * Anything that can run code (`shell_run`), call arbitrary host tools
 * (`host_call`), or inject a message into a live DSH session
 * (`channel_send` / `channel_wake`) stays denied until a human opts in.
 */
export const DEFAULT_ALLOW = [
  ...M3_DEFAULT_ALLOW,
  'fs_stats',
  'file_read_chunk',
  'file_hash',
  'transfer_usage',
  'find_files',
  'search_text',
  'tool_inventory',
  'file_write_chunk',
  'host_instances',
  'mesh_overview',
  'host_self',
  'host_tools',
  'host_sessions',
  'host_logs',
  'session_history',
  'mesh_alert',
  'channel_agents',
  'cluster_status',
  'delegate',
  'delegate_status',
  'delegate_reply',
  'delegate_list',
  'delegate_candidates',
  'delegate_gc'
]

/** 文件/检索工具（v7.1 加入默认 ACL；老默认列表会自动升级，自定义列表保持不动） */
export const FILE_TRANSFER_TOOLS = [
  'file_read_chunk',
  'file_write_chunk',
  'file_hash',
  'transfer_usage',
  'find_files',
  'search_text',
  'tool_inventory'
]
const PREVIOUS_DEFAULT_ALLOW = DEFAULT_ALLOW.filter((name) => !FILE_TRANSFER_TOOLS.includes(name))

/**
 * Host bridge instances this node knows about. `dsh0`/`dsh1` mirror the
 * two-DSH-per-machine convention (profile `~/.dsh0` / `~/.dsh1` on ports
 * 9100/9101). `tokenFile: ''` means derive it: `dsh0` -> `<home>/host-token`,
 * any other id -> `<home>/host-token-<id>`; the plugin honours
 * `DSH_MESH_HOST_TOKEN_FILE` so each DSH process points at its own file.
 */
/** Directory of the DSH profile that belongs to instance `id` (dsh0/dsh1 convention). */
export function defaultProfileDir(id) {
  const match = /^dsh(\d+)$/.exec(String(id || ''))
  return match ? join(homedir(), `.dsh${match[1]}`, 'profiles', 'web') : ''
}

const DEFAULT_HOSTS = [
  {
    id: 'dsh0',
    label: 'DSH 3080 (.dsh0)',
    enabled: true,
    url: 'http://127.0.0.1:9100',
    tokenFile: '',
    timeoutMs: 120000,
    /** Profile this instance boots from; repair tools may only write here. */
    profileDir: defaultProfileDir('dsh0')
  },
  {
    id: 'dsh1',
    label: 'DSH 3081 (.dsh1)',
    enabled: true,
    url: 'http://127.0.0.1:9101',
    tokenFile: '',
    timeoutMs: 120000,
    profileDir: defaultProfileDir('dsh1')
  }
]

/** Defaults for one host entry, by position (first entry doubles as dsh0). */
export function defaultHostEntry(index = 0) {
  const fallback = DEFAULT_HOSTS[index] || {
    id: `dsh${index}`,
    label: `DSH instance ${index}`,
    enabled: true,
    url: `http://127.0.0.1:${9100 + index}`,
    tokenFile: '',
    timeoutMs: 120000,
    profileDir: defaultProfileDir(`dsh${index}`)
  }
  return { ...fallback }
}

/** Directory holding config + secrets + jobs + audit. Override with DSH_MESH_HOME. */
export function meshHome() {
  return process.env.DSH_MESH_HOME ? resolve(process.env.DSH_MESH_HOME) : join(homedir(), '.dsh-mesh')
}

export function defaultCodeRoot() {
  return join(homedir(), 'Code')
}

/** Default configuration; written on first run so a human can edit it. */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    node: {
      name: 'local',
      bind: '127.0.0.1',
      port: 8124,
      path: '/mcp',
      /** TLS terminated inside the node (Sakura TCP tunnels are not encrypted). */
      tls: { enabled: false, cert: '', key: '' }
    },
    acl: {
      /** Tools a peer may call. Deny-by-default: anything not listed is refused. */
      allow: [...DEFAULT_ALLOW],
      /** fs_* / repo_scan / shell cwd may only touch paths under these roots. */
      fsRoots: [defaultCodeRoot()],
      /** Hard deny wins over allow. */
      deny: []
    },
    shell: {
      /** shell_run is refused while this is false, even if `acl.allow` lists it. */
      enabled: false,
      /** Empty = any command; otherwise argv[0] must be in this list. */
      allowCommands: [],
      /** Extra allowed cwds (fsRoots always apply). */
      cwdRoots: [],
      timeoutMs: 60000
    },
    limits: {
      maxReadBytes: 262144,
      maxLines: 4000,
      gitTimeoutMs: 20000,
      maxListEntries: 500,
      maxGrepFiles: 400,
      maxDiffBytes: 131072,
      jobTtlSec: 604800,
      maxJobs: 500,
      jobTimeoutMs: 300000,
      channelWaitMs: 180000,
      channelPollMs: 800,
      channelMaxMessages: 60
    },
    /** 文件传输限额（公网/内网流量有成本）：单块/单文件/每日总量，字节 */
    transfer: {
      maxChunkBytes: 4194304,
      maxFileBytes: 268435456,
      dailyBytes: 2147483648
    },
    /** One-time pairing codes: a peer redeems a short code for its own bearer token. */
    pairing: {
      enabled: true,
      codeTtlSec: 1800,
      maxAttempts: 5
    },
    /** Local DSH instances this node may talk to (route A of the channel design). */
    dsh: {
      targets: []
    },
    /**
     * Host bridges (route B): each local DSH instance can load the
     * `dsh-mesh-host` plugin, which exposes its in-process agents/tools on a
     * loopback endpoint. One entry per DSH instance (default: dsh0 + dsh1).
     */
    hosts: DEFAULT_HOSTS.map((entry) => ({ ...entry })),
    /**
     * Repair tooling (M7 step 3): write plugin files into a DSH profile and run
     * preset restart scripts. Off by default and doubly gated — the tools are
     * also not in DEFAULT_ALLOW, so a peer needs both an ACL entry and this flag.
     */
    repair: {
      enabled: false,
      maxFiles: 20,
      maxFileBytes: 262144,
      timeoutMs: 120000,
      /** '' -> `<mesh home>/backups` */
      backupDir: '',
      /** name -> command line; service_restart only runs a name from this map. */
      restartScripts: {}
    },
    peers: []
  }
}

export function configPath(home = meshHome()) {
  return join(home, 'config.json')
}
export function secretsPath(home = meshHome()) {
  return join(home, 'secrets.json')
}
export function pairingPath(home = meshHome()) {
  return join(home, 'pairing.json')
}
export function peersPath(home = meshHome()) {
  return join(home, 'peers.json')
}

export function ensureHome(home = meshHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return home
}

/**
 * Normalise the host-bridge list: a raw `hosts` array wins; a legacy single
 * `host` object (config v5) is folded into the first entry so an upgrade never
 * silently loses a custom url/token file.
 */
function mergeHosts(raw) {
  const list = Array.isArray(raw?.hosts) ? raw.hosts : null
  if (list && list.length > 0) {
    return list.map((entry, index) => ({ ...defaultHostEntry(index), ...(entry || {}) }))
  }
  if (raw?.host && typeof raw.host === 'object') {
    return [{ ...defaultHostEntry(0), ...raw.host, id: raw.host.id || 'dsh0' }]
  }
  return DEFAULT_HOSTS.map((entry) => ({ ...entry }))
}

function mergeConfig(raw) {
  const base = defaultConfig()
  const merged = {
    ...base,
    ...raw,
    node: {
      ...base.node,
      ...(raw.node || {}),
      tls: { ...base.node.tls, ...((raw.node || {}).tls || {}) }
    },
    acl: {
      ...base.acl,
      ...(raw.acl || {}),
      allow: Array.isArray(raw.acl?.allow) ? raw.acl.allow : base.acl.allow,
      deny: Array.isArray(raw.acl?.deny) ? raw.acl.deny : [],
      fsRoots: Array.isArray(raw.acl?.fsRoots) ? raw.acl.fsRoots : base.acl.fsRoots
    },
    shell: { ...base.shell, ...(raw.shell || {}) },
    repair: { ...base.repair, ...(raw.repair || {}) },
    pairing: { ...base.pairing, ...(raw.pairing || {}) },
    limits: { ...base.limits, ...(raw.limits || {}) },
    dsh: {
      ...base.dsh,
      ...(raw.dsh || {}),
      targets: Array.isArray(raw.dsh?.targets) ? raw.dsh.targets : []
    },
    hosts: mergeHosts(raw),
    peers: Array.isArray(raw.peers) ? raw.peers : []
  }
  // `host` was the v5 single-bridge key; keep it out of the in-memory shape.
  delete merged.host
  return merged
}

/**
 * Upgrade an old config in memory. Only an *untouched* allow-list is rewritten:
 * a list the user already customised is preserved verbatim.
 */
function migrateConfig(raw) {
  const version = Number.isFinite(raw?.version) ? raw.version : 1
  const notes = []
  if (version < 2) {
    const allow = Array.isArray(raw?.acl?.allow) ? raw.acl.allow : []
    const sameAsM1 =
      allow.length === M1_DEFAULT_ALLOW.length && M1_DEFAULT_ALLOW.every((n) => allow.includes(n))
    if (sameAsM1) {
      raw.acl = { ...(raw.acl || {}), allow: [...M2_DEFAULT_ALLOW] }
      notes.push('acl.allow: M1 defaults -> M2 defaults (read-only tools + task queue)')
    }
    raw.version = 2
    notes.push('config version 1 -> 2')
  }
  if (Number(raw.version) < 3) {
    const allow = Array.isArray(raw?.acl?.allow) ? raw.acl.allow : []
    const sameAsM2 =
      allow.length === M2_DEFAULT_ALLOW.length && M2_DEFAULT_ALLOW.every((n) => allow.includes(n))
    if (sameAsM2) {
      raw.acl = { ...(raw.acl || {}), allow: [...DEFAULT_ALLOW] }
      notes.push('acl.allow: M2 defaults -> M3 defaults (+ read-only channel tools)')
    }
    if (raw.dsh === undefined) raw.dsh = { targets: [] }
    raw.version = 3
    notes.push('config version 2 -> 3 (dsh.targets)')
  }
  if (Number(raw.version) < 4) {
    if (raw.pairing === undefined) raw.pairing = { enabled: true, codeTtlSec: 1800, maxAttempts: 5 }
    raw.version = 4
    notes.push('config version 3 -> 4 (pairing)')
  }
  if (Number(raw.version) < 5) {
    const allow = Array.isArray(raw?.acl?.allow) ? raw.acl.allow : []
    const sameAsM3 =
      allow.length === M3_DEFAULT_ALLOW.length && M3_DEFAULT_ALLOW.every((n) => allow.includes(n))
    if (sameAsM3) {
      raw.acl = { ...(raw.acl || {}), allow: [...DEFAULT_ALLOW] }
      notes.push('acl.allow: M3 defaults -> M4 defaults (+ read-only host bridge tools)')
    }
    if (raw.host === undefined) {
      raw.host = { enabled: true, url: 'http://127.0.0.1:9100', tokenFile: '', timeoutMs: 120000 }
    }
    raw.version = 5
    notes.push('config version 4 -> 5 (host bridge)')
  }
  if (Number(raw.version) < 6) {
    if (raw.hosts === undefined) {
      if (raw.host !== undefined) {
        raw.hosts = [{ ...(raw.host || {}), id: raw.host?.id || 'dsh0' }]
        // The two-DSH insurance convention is the default from v6 on: keep the
        // upgraded bridge as dsh0 and add the second instance entry as dsh1.
        if (!raw.hosts.some((entry) => entry.id === 'dsh1')) {
          raw.hosts.push({ ...DEFAULT_HOSTS[1] })
        }
        delete raw.host
        notes.push('host -> hosts[] (kept the existing bridge as dsh0, added dsh1)')
      } else {
        raw.hosts = defaultConfig().hosts
        notes.push('hosts[]: dsh0 + dsh1 (one entry per local DSH instance)')
      }
    }
    raw.version = 6
    notes.push('config version 5 -> 6 (host bridge per instance)')
  }
  if (Number(raw.version) < 7) {
    if (raw.repair === undefined) {
      raw.repair = { ...defaultConfig().repair }
      notes.push('repair: disabled by default (plugin_install / service_restart, M7)')
    }
    const hosts = Array.isArray(raw.hosts) ? raw.hosts : []
    let addedProfiles = 0
    for (const entry of hosts) {
      if (!entry || typeof entry !== 'object') continue
      if (entry.profileDir === undefined) {
        const derived = defaultProfileDir(entry.id)
        if (derived) {
          entry.profileDir = derived
          addedProfiles += 1
        } else {
          entry.profileDir = ''
        }
      }
    }
    if (addedProfiles > 0) notes.push(`hosts[].profileDir: derived for ${addedProfiles} instance(s)`)
    raw.version = 7
    notes.push('config version 6 -> 7 (repair tooling)')
  }
  // v7.1: 文件/检索工具加入默认 ACL。老默认列表自动补齐；即便 ACL 被小幅自定义过，
  // 只要仍是正常节点 ACL（含 mesh_self + fs_read），也补上这 7 个工具——否则跨机传文件/
  // 检索会一直 E_DENIED，用户又得手工改 ACL（2026-11-09 教训）。
  const allowNow = Array.isArray(raw?.acl?.allow) ? raw.acl.allow : []
  if (allowNow.includes('mesh_self') && allowNow.includes('fs_read')) {
    const next = new Set(allowNow)
    let added = 0
    for (const name of FILE_TRANSFER_TOOLS) {
      if (!next.has(name)) {
        next.add(name)
        added += 1
      }
    }
    if (added > 0) {
      raw.acl = { ...(raw.acl || {}), allow: [...next] }
      notes.push(`acl.allow: + ${added} file/search tool(s) (default allow-list upgrade)`)
    }
  }
  return notes
}

/** How far this machine's allow-list sits from the defaults shipped by this version. */
export function aclDrift(config) {
  const allow = Array.isArray(config?.acl?.allow) ? config.acl.allow : []
  return {
    missing: DEFAULT_ALLOW.filter((name) => !allow.includes(name)),
    extra: allow.filter((name) => !DEFAULT_ALLOW.includes(name))
  }
}

/** Atomic save so a crash mid-write cannot leave a truncated config. */
export function saveConfig(config, home = meshHome()) {
  ensureHome(home)
  const p = configPath(home)
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
  return p
}

/** Load config, creating a default one on first run and migrating old versions. */
export function loadConfig(home = meshHome(), { log = console } = {}) {
  ensureHome(home)
  const p = configPath(home)
  if (!existsSync(p)) {
    writeFileSync(p, JSON.stringify(defaultConfig(), null, 2) + '\n', 'utf8')
  }
  const raw = readJsonFile(p)
  const notes = migrateConfig(raw)
  const merged = mergeConfig(raw)
  if (notes.length > 0 && merged.version === CONFIG_VERSION) {
    try {
      saveConfig(merged, home)
      log?.info?.(`[dsh-mesh] config migrated: ${notes.join('; ')}`)
    } catch (error) {
      log?.warn?.(`[dsh-mesh] could not persist migrated config: ${error?.message || error}`)
    }
  }
  if (notes.length > 0) {
    const drift = aclDrift(merged)
    if (drift.missing.length > 0 || drift.extra.length > 0) {
      const parts = []
      if (drift.missing.length > 0) parts.push(`missing [${drift.missing.join(', ')}]`)
      if (drift.extra.length > 0) parts.push(`extra [${drift.extra.join(', ')}]`)
      log?.warn?.(
        `[dsh-mesh] acl.allow differs from this version's defaults (${parts.join('; ')}) — ` +
          'upgrades never widen an edited ACL; run `node src/cli.js acl reset` (or `acl allow <tool>`) to align, see DESIGN §29'
      )
    }
  }
  return merged
}

/**
 * Hot-reloading config accessor: re-reads `config.json` whenever its mtime changes,
 * so editing ACL on disk takes effect without restarting the node.
 */
export function createConfigLoader({ home = meshHome(), log = console } = {}) {
  let cached = null
  let lastMtime = -1
  return function getConfig() {
    let mtime = -1
    try {
      mtime = statSync(configPath(home)).mtimeMs
    } catch {
      mtime = -1
    }
    if (cached && mtime === lastMtime) return cached
    try {
      cached = loadConfig(home, { log })
      lastMtime = mtime
    } catch (error) {
      if (!cached) throw error
      log?.warn?.(`[dsh-mesh] config reload failed, keeping previous config: ${error?.message || error}`)
    }
    return cached
  }
}

export function newToken() {
  return randomBytes(32).toString('hex')
}

/**
 * Inbound tokens live in secrets.json (never in config.json, never in git).
 * shape: { version, inbound: [{ id, token, note }] }
 */
export function loadSecrets(home = meshHome()) {
  ensureHome(home)
  const p = secretsPath(home)
  if (existsSync(p)) {
    const raw = readJsonFile(p)
    const inbound = Array.isArray(raw.inbound) ? raw.inbound : []
    if (inbound.length > 0) return raw
    raw.inbound = [{ id: 'default', token: newToken(), note: 'auto-generated' }]
    writeFileSync(p, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    return raw
  }
  const secrets = {
    version: 1,
    inbound: [{ id: 'default', token: newToken(), note: 'auto-generated on first run' }]
  }
  writeFileSync(p, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return secrets
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Persist secrets.json (0600, UTF-8 no BOM). */
export function saveSecrets(secrets, home = meshHome()) {
  ensureHome(home)
  const p = secretsPath(home)
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, p)
  return p
}

/**
 * Replace (or create) an inbound token. Returns the new token so the caller can
 * print it once; the old token stops working as soon as the server reloads secrets.
 */
export function rotateToken({ home = meshHome(), id = 'default', note } = {}) {
  const secrets = loadSecrets(home)
  const token = newToken()
  const existing = (secrets.inbound || []).find((entry) => entry.id === id)
  if (existing) {
    existing.token = token
    if (note) existing.note = note
  } else {
    secrets.inbound = [...(secrets.inbound || []), { id, token, note: note || 'rotated' }]
  }
  saveSecrets(secrets, home)
  return { id, token }
}

/** Per-token ACL；`null` 表示“继承节点 ACL”。
 *  - token 带 role：允许集合由角色能力包决定（node/admin 继承节点 ACL）
 *  - token 不带 role：沿用旧的显式 acl.allow（向后兼容）
 */
export function peerAclForToken(secrets, tokenId) {
  const entry = (secrets?.inbound || []).find((item) => item?.id === tokenId)
  const acl = entry?.acl
  if (entry?.role && isRole(entry.role)) {
    const allowed = roleAllow(entry.role)
    return {
      role: entry.role,
      allow: allowed || undefined,
      deny: Array.isArray(acl?.deny) ? acl.deny : [],
      fsRoots: Array.isArray(acl?.fsRoots) ? acl.fsRoots : undefined
    }
  }
  if (!acl || typeof acl !== 'object') return null
  return {
    allow: Array.isArray(acl.allow) ? acl.allow : undefined,
    deny: Array.isArray(acl.deny) ? acl.deny : [],
    fsRoots: Array.isArray(acl.fsRoots) ? acl.fsRoots : undefined
  }
}

/**
 * Add an inbound token (used by pairing and by `peer` bookkeeping).
 * `role` 是推荐方式（observer/controller/node/admin）；`acl` 保留给旧的显式写法。
 * 带 role 时 acl.allow 被忽略（角色决定允许集合），只保留 deny / fsRoots。
 */
export function addInboundToken({ home = meshHome(), id, note, acl, role, token } = {}) {
  if (!id) throw new Error('addInboundToken requires an id')
  if (role !== undefined && role !== null && !isRole(role)) throw new Error(`unknown role: ${role}`)
  const secrets = loadSecrets(home)
  const existing = (secrets.inbound || []).find((entry) => entry.id === id)
  if (existing) throw new Error(`token id already exists: ${id}`)
  const entry = { id, token: token || newToken(), note: note || 'paired' }
  if (role) entry.role = role
  if (acl && typeof acl === 'object') {
    if (role) {
      const narrowed = { ...acl }
      delete narrowed.allow
      if (Object.keys(narrowed).length > 0) entry.acl = narrowed
    } else {
      entry.acl = acl
    }
  }
  secrets.inbound = [...(secrets.inbound || []), entry]
  saveSecrets(secrets, home)
  return { id: entry.id, token: entry.token, role: entry.role || null }
}

/** 改一个入向 token 的角色（用户/管理员决策；会移除旧的显式 allow，保留 deny/fsRoots）。 */
export function setTokenRole({ home = meshHome(), id, role } = {}) {
  if (!id) throw new Error('setTokenRole requires an id')
  if (!isRole(role)) throw new Error(`unknown role: ${role}`)
  const secrets = loadSecrets(home)
  const entry = (secrets.inbound || []).find((item) => item?.id === id)
  if (!entry) throw new Error(`token id not found: ${id}`)
  const before = entry.role || null
  entry.role = role
  if (entry.acl && typeof entry.acl === 'object') {
    const narrowed = { ...entry.acl }
    delete narrowed.allow
    if (Object.keys(narrowed).length > 0) entry.acl = narrowed
    else delete entry.acl
  }
  saveSecrets(secrets, home)
  return { id, before, role }
}

/**
 * 旧 token 自动迁移到角色（用户无需逐工具操作）。
 * 规则：observer/controller 子集 → 对应角色；显式 ACL 恰好等于节点 ACL → node；
 * 其余自定义/奇怪组合保留显式 ACL 并报告（不擅自扩权）。
 */
export function migrateTokensToRoles({ home = meshHome(), dryRun = false } = {}) {
  const secrets = loadSecrets(home)
  const nodeAllow = (loadConfig(home).acl?.allow || [])
  const changes = []
  let mutated = false
  for (const entry of secrets.inbound || []) {
    if (entry.role && isRole(entry.role)) continue
    const allow = Array.isArray(entry.acl?.allow) ? entry.acl.allow : null
    const role = inferRole(allow, nodeAllow)
    if (!role) {
      changes.push({ id: entry.id, role: null, skipped: true, fromTools: allow?.length ?? null })
      continue
    }
    changes.push({ id: entry.id, role, fromTools: allow?.length ?? null })
    if (!dryRun) {
      entry.role = role
      if (entry.acl && typeof entry.acl === 'object') {
        const narrowed = { ...entry.acl }
        delete narrowed.allow
        if (Object.keys(narrowed).length > 0) entry.acl = narrowed
        else delete entry.acl
      }
      mutated = true
    }
  }
  let backup = null
  if (!dryRun && mutated) {
    backup = `${secretsPath(home)}.bak-roles-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(secretsPath(home), backup)
    saveSecrets(secrets, home)
  }
  return { dryRun, backup, changes }
}

/** Delete an inbound token; the holder's next request fails with 401. */
export function removeInboundToken({ home = meshHome(), id } = {}) {
  const secrets = loadSecrets(home)
  const before = (secrets.inbound || []).length
  secrets.inbound = (secrets.inbound || []).filter((entry) => entry.id !== id)
  saveSecrets(secrets, home)
  return { removed: before - secrets.inbound.length }
}

/** Secrets loader that notices on-disk changes (so a rotation takes effect without a restart). */
export function createSecretsLoader({ home = meshHome(), log = console } = {}) {
  const file = secretsPath(home)
  let cached = null
  let mtimeMs = -1
  return function getSecrets() {
    try {
      const stat = statSyncSafe(file)
      if (cached && stat && stat.mtimeMs === mtimeMs) return cached
      const next = loadSecrets(home)
      cached = next
      mtimeMs = stat ? stat.mtimeMs : -1
      log?.debug?.(`[dsh-mesh] secrets reloaded (${(next.inbound || []).length} inbound token(s))`)
      return next
    } catch (error) {
      if (cached) {
        log?.warn?.(`[dsh-mesh] secrets reload failed, keeping previous: ${error?.message || error}`)
        return cached
      }
      throw error
    }
  }
}

function statSyncSafe(file) {
  try {
    return statSync(file)
  } catch {
    return null
  }
}

/** Verify a Bearer token against secrets.inbound. Returns the matching token id or null. */
export function verifyBearer(req, secrets) {
  const header = req?.headers?.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim())
  if (!m) return null
  const presented = m[1].trim()
  for (const entry of secrets?.inbound || []) {
    if (entry?.token && safeEqual(presented, entry.token)) return entry.id || 'default'
  }
  return null
}

function canonical(p) {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** True when `p` resolves inside one of `roots`. */
export function isInsideRoots(p, roots) {
  const abs = canonical(p)
  const cand = process.platform === 'win32' ? abs.toLowerCase() : abs
  for (const root of roots || []) {
    const r = canonical(root)
    const rr = process.platform === 'win32' ? r.toLowerCase() : r
    if (cand === rr) return true
    if (cand.startsWith(rr.endsWith(sep) ? rr : rr + sep)) return true
  }
  return false
}

export function isAbsolutePath(p) {
  return isAbsolute(p)
}
