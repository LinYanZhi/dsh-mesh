#!/usr/bin/env node
// @generated 2026-11-12 只读安全体检：检查本机 dsh-mesh 的暴露面 / TLS / ACL / fsRoots / 对端 / 隧道。
// 不修改任何配置、不发起网络请求（只读本机文件 + 本机监听信息），不打印 token/私钥。
//
// 用法：node scripts/security-audit.mjs [--json] [--strict]
//   --json    输出 JSON（供自动化/其它 AI 解析）
//   --strict  存在 P0 时 exit 2（默认始终 exit 0）
//
// 检查项（全部只读）：
//   1) node.bind / TLS 是否开启、证书文件是否存在
//   2) 监听地址（是否是 0.0.0.0 暴露公网）
//   3) ACL allow 中是否含危险工具（shell_run / host_call / channel_* / repair_* / pc_*）
//   4) fsRoots 是否覆盖用户主目录/敏感目录（凭据目录不应给全权 peer）
//   5) peers.json 的对端：公网地址是否 https、是否缺指纹
//   6) secrets.json / host-token 是否存在（只报存在与大小，不读内容）
//   7) frpc 配置：隧道是否把 8124 映射到公网端口（token 行脱敏）
import { readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const wantJson = args.includes('--json')
const strict = args.includes('--strict')

const HOME = process.env.DSH_MESH_HOME || join(homedir(), '.dsh-mesh')
const REPO = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const CONFIG = join(HOME, 'config.json')
const PEERS = join(HOME, 'peers.json')
const SECRETS = join(HOME, 'secrets.json')
const HOST_TOKEN = join(HOME, 'host-token')
const FRPC = join(REPO, '.runtime', 'frpc', 'frpc.toml')

const findings = []
function add(level, id, title, detail, action) {
  findings.push({ level, id, title, detail, action })
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function isPrivateHost(h) {
  const host = String(h || '').toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  return false
}
function urlHost(u) {
  try { return new URL(u).hostname } catch { return '' }
}
function underRoot(p, root) {
  const a = resolve(p).toLowerCase()
  const b = resolve(root).toLowerCase()
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

const cfg = readJson(CONFIG)
const peersDoc = readJson(PEERS)
const secrets = readJson(SECRETS)

// ---------- 1. bind / TLS ----------
const node = (cfg && cfg.node) || {}
const bind = String(node.bind || '(未配置，默认 127.0.0.1)')
const tls = (node.tls || {})
const tlsEnabled = tls.enabled === true
if (!cfg) {
  add('P0', 'config-missing', '没有找到 ~/.dsh-mesh/config.json', `期望路径：${CONFIG}`, '先启动一次 mesh 服务生成配置，再跑本体检')
}
if (/^0\.0\.0\.0$/.test(bind) || /^::$/.test(bind)) {
  add('P1', 'bind-public', 'mesh 监听所有网卡（0.0.0.0）', `node.bind=${bind}`, '仅在你确知需要局域网/公网直连时这样配；否则改回 127.0.0.1 + 隧道')
} else if (cfg && !/^(127\.0\.0\.1|localhost|::1)$/.test(bind)) {
  add('P2', 'bind-nonloopback', 'mesh 绑定在非 loopback 地址', `node.bind=${bind}`, '确认这是预期暴露面')
}
if (!tlsEnabled) {
  add('P0', 'tls-disabled', 'TLS 未开启（跨公网时流量明文）', 'node.tls.enabled=false', '跨网络使用必须开启 TLS：node.tls.enabled=true，并配置 cert/key；对端用指纹 pin')
} else {
  // 默认路径：~/.dsh-mesh/tls/cert.pem / key.pem（config 里留空即用默认）
  const cert = String(tls.cert || '') || join(HOME, 'tls', 'cert.pem')
  const key = String(tls.key || '') || join(HOME, 'tls', 'key.pem')
  if (!existsSync(cert)) add('P1', 'tls-cert-missing', 'TLS 已开启但证书文件不存在', `cert=${cert}`, '运行 dsh-mesh tls init 或修正路径')
  if (!existsSync(key)) add('P1', 'tls-key-missing', 'TLS 已开启但私钥文件不存在', `key=${key}`, '检查 key 路径与权限（不要提交到 git）')
}

// ---------- 2. 监听地址 ----------
let listeners = []
try {
  const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-NetTCPConnection -State Listen -LocalPort ${Number(node.port) || 8124} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const raw = (ps.stdout || '').trim()
  if (raw) {
    const j = JSON.parse(raw)
    listeners = (Array.isArray(j) ? j : [j]).map((x) => ({ addr: x.LocalAddress, port: x.LocalPort, pid: x.OwningProcess }))
  }
} catch { /* 非 Windows 或查询失败，忽略 */ }
if (listeners.some((l) => l.addr === '0.0.0.0' || l.addr === '::')) {
  add('P2', 'listener-all', 'mesh 端口正在所有网卡监听', JSON.stringify(listeners), '确认防火墙/安全组只放行可信来源')
}

// ---------- 3. ACL ----------
const acl = (cfg && cfg.acl) || {}
const allow = Array.isArray(acl.allow) ? acl.allow : []
const deny = Array.isArray(acl.deny) ? acl.deny : []
const fsRoots = Array.isArray(acl.fsRoots) ? acl.fsRoots : []
const dangerous = ['shell_run', 'host_call', 'channel_send', 'channel_wake', 'channel_login', 'plugin_install', 'service_restart', 'fs_write', 'mesh_config_patch', 'pc_action', 'pc_app', 'pc_window', 'pc_browser']
const enabledDangerous = dangerous.filter((t) => allow.includes(t) && !deny.includes(t))
if (enabledDangerous.length) {
  add('P1', 'acl-dangerous', 'ACL 放行了高风险工具', enabledDangerous.join(', '), '只为真正可信的 peer 打开；桌面控制 pc_* 尤其谨慎')
}
const shellOn = Boolean(cfg && cfg.shell && cfg.shell.enabled)
const repairOn = Boolean(cfg && cfg.repair && cfg.repair.enabled)
if (shellOn) add('P1', 'shell-enabled', 'shell_run 已启用（可跑任意命令）', 'shell.enabled=true', '确认允许的命令白名单；不在白名单时等于全权 shell')
if (repairOn) add('P1', 'repair-enabled', '修复工具已启用（可写插件/重启服务）', 'repair.enabled=true', '只对可信 peer 开放；确认重启脚本白名单')

// ---------- 4. fsRoots ----------
const home = homedir()
const sensitiveDirs = [join(home, '.ssh'), join(home, '.dsh-mesh'), join(home, '.git-credentials'), join(home, '.aws')]
for (const r of fsRoots) {
  if (resolve(r).toLowerCase() === resolve(home).toLowerCase()) {
    add('P0', 'fsroot-home', 'fsRoots 直接包含用户主目录', r, '全权 peer 不应读写主目录；至少排除凭据目录（.ssh/.dsh*/.dsh-mesh/.git-credentials）')
  }
  for (const s of sensitiveDirs) if (underRoot(s, r)) add('P0', 'fsroot-sensitive', 'fsRoots 覆盖了敏感凭据目录', `${s} ⊂ ${r}`, '把凭据目录移到 fsRoots 之外，或改用独立受限用户运行')
  if (resolve(r).toLowerCase() === resolve(home.split(sep)[0] + sep).toLowerCase()) add('P1', 'fsroot-drive', 'fsRoots 是整盘根目录', r, '缩小到工作区目录')
  for (const d of (cfg && cfg.dsh && cfg.dsh.targets) || []) void d
}

// ---------- 5. peers ----------
const items = (peersDoc && (peersDoc.items || peersDoc.peers)) || []
if (!Array.isArray(items) || items.length === 0) {
  add('P2', 'no-peers', '还没有配对的对端', `peers.json: ${PEERS}`, '正常；配对后回来复查')
} else {
  for (const p of items) {
    const name = String(p.name || p.id || '?')
    const url = String(p.url || '')
    const host = urlHost(url)
    const scheme = url.split(':')[0]
    const isPublic = host && !isPrivateHost(host)
    const hasFp = Boolean(p.certFingerprint || p.fingerprint)
    if (isPublic && scheme !== 'https') add('P0', 'peer-plaintext-public', `公网 peer「${name}」不是 https`, url, '公网链路必须 https；否则 token/内容明文可被嗅探')
    if (isPublic && !hasFp) add('P1', 'peer-no-fingerprint', `公网 peer「${name}」没有证书指纹`, url, '配对时带 --fingerprint 固定证书，防中间人')
    if (String(p.disabled) === 'true') continue
  }
  const publicCount = items.filter((p) => { const h = urlHost(p.url); return h && !isPrivateHost(h) }).length
  if (publicCount) add('P2', 'peer-public-count', `${publicCount} 个对端走公网地址`, '确认每个公网 peer 都使用 https + 指纹', '不需要的公网 peer 可 peer remove')
}

// ---------- 6. secrets / tokens ----------
for (const f of [SECRETS, HOST_TOKEN]) {
  if (existsSync(f)) {
    const st = statSync(f)
    add('P2', 'secret-file', `存在敏感文件：${f}`, `size=${st.size}B`, '确认不在 git/备份/共享目录；定期轮换')
  }
}
const tokenFiles = ['host-token', 'host-token-dsh1', 'host-token-dsh2'].map((n) => join(HOME, n)).filter((f) => existsSync(f))
if (tokenFiles.length) add('P2', 'host-tokens', `宿主桥 token 文件 ${tokenFiles.length} 个`, tokenFiles.join(', '), '不要提交到 git；限制文件权限')

// ---------- 7. frpc ----------
if (existsSync(FRPC)) {
  const toml = readFileSync(FRPC, 'utf8')
  const serverAddr = (toml.match(/^\s*serverAddr\s*=\s*"([^"]+)"/m) || [])[1] || ''
  const remotePorts = [...toml.matchAll(/^\s*remotePort\s*=\s*(\d+)/gm)].map((m) => m[1])
  const localPorts = [...toml.matchAll(/^\s*localPort\s*=\s*(\d+)/gm)].map((m) => m[1])
  if (serverAddr) {
    const publicServer = !isPrivateHost(serverAddr)
    add(publicServer ? 'P2' : 'P2', 'frpc', `frpc 指向 ${serverAddr}${publicServer ? '（公网）' : ''}`, `remotePorts=${remotePorts.join(',') || '无'} localPorts=${localPorts.join(',') || '无'}`, '确认 frps token 长度足够；云安全组尽量限制来源 IP，不要用默认端口')
    if (localPorts.some((p) => p === String(node.port || 8124))) add('P2', 'frpc-mesh-port', 'frpc 正在映射 mesh 端口', `8124 -> ${remotePorts.join(',')}`, '这是预期；只要 frps 端有强 token + 来源限制即可')
  }
} else {
  add('P2', 'no-frpc', '没有找到本地 frpc 配置', FRPC, '只用局域网时可以忽略；跨公网时确认隧道在别处配置')
}

// ---------- 输出 ----------
const summary = {
  at: new Date().toISOString(),
  meshHome: HOME,
  bind,
  tlsEnabled,
  peers: Array.isArray(items) ? items.length : 0,
  fsRoots,
  allowCount: allow.length,
  findings
}
if (wantJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`dsh-mesh 安全体检 · ${new Date().toLocaleString()}`)
  console.log(`配置: ${CONFIG}`)
  console.log(`bind=${bind}  tls=${tlsEnabled ? 'on' : 'off'}  peers=${summary.peers}  fsRoots=${fsRoots.length}  allow=${allow.length}`)
  console.log('')
  if (!findings.length) {
    console.log('没有发现问题（基于本机配置的只读检查）。')
  } else {
    const order = { P0: 0, P1: 1, P2: 2 }
    findings.sort((a, b) => order[a.level] - order[b.level])
    for (const f of findings) {
      console.log(`[${f.level}] ${f.title}`)
      console.log(`     现状: ${f.detail}`)
      console.log(`     建议: ${f.action}`)
      console.log('')
    }
    const counts = findings.reduce((m, f) => (m[f.level] = (m[f.level] || 0) + 1, m), {})
    console.log(`合计: P0=${counts.P0 || 0} P1=${counts.P1 || 0} P2=${counts.P2 || 0}`)
  }
  console.log('')
  console.log('说明：本脚本只读本机文件与本机监听状态，不发网络请求、不改配置、不打印 token/私钥。')
}
const hasP0 = findings.some((f) => f.level === 'P0')
process.exit(strict && hasP0 ? 2 : 0)
