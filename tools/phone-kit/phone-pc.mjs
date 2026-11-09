#!/usr/bin/env node
// @generated phone-pc：手机侧电脑控制快捷封装（部署到 /root/dsh-mesh-kit/pc.mjs）
//
// 用法（手机 proot 内）：
//   node /root/dsh-mesh-kit/pc.mjs <peer> action <action> [confirm]
//   node /root/dsh-mesh-kit/pc.mjs <peer> app list | start <alias> [path] | close <进程名> [confirm]
//   node /root/dsh-mesh-kit/pc.mjs <peer> window list | focus <pid> | minimize <pid>
//   node /root/dsh-mesh-kit/pc.mjs <peer> browser browsers | open-url <url> | debug-launch [edge|chrome] | cdp-list | cdp-open <url> | cdp-close <id>
//
// 优先走本机常驻 daemon（127.0.0.1:19555，延迟低）；daemon 不可用时回退到 CLI。
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const cli = process.env.DSH_MESH_CLI || '/root/dsh-mesh-kit/mesh/src/cli.js'
const daemon = process.env.DSH_PC_DAEMON_URL || 'http://127.0.0.1:19555/call'

function buildArgs(group, a1, a2, a3) {
  if (group === 'action') {
    const args = { action: a1 }
    if (a2 === 'confirm') args.confirm = true
    return ['pc_action', args]
  }
  if (group === 'app') {
    const args = { action: a1 }
    if (a1 === 'start' || a1 === 'close') args.app = a2
    if (a1 === 'start' && a3) args.path = a3
    if (a3 === 'confirm' || a3 === 'force') args.confirm = true
    return ['pc_app', args]
  }
  if (group === 'window') {
    const args = { action: a1 }
    if (a1 === 'close') {
      if (!a2) { console.error('用法: window close <hwnd(0x..)|pid=123>'); process.exit(2) }
      if (a2.startsWith('pid=')) args.pid = Number(a2.slice(4))
      else args.hwnd = a2
      args.confirm = true
      return ['pc_window', args]
    }
    if (a2) args.pid = Number(a2)
    return ['pc_window', args]
  }
  if (group === 'browser') {
    const args = { action: a1 }
    if (a1 === 'open-url' || a1 === 'cdp-open') args.url = a2
    if (a1 === 'debug-launch' && (a2 === 'edge' || a2 === 'chrome')) args.browser = a2
    if (a1 === 'cdp-close') args.id = a2
    return ['pc_browser', args]
  }
  return null
}

async function viaDaemon(peer, tool, args) {
  try {
    const res = await fetch(daemon, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer, tool, args }),
      signal: AbortSignal.timeout(60_000)
    })
    const j = await res.json()
    return j
  } catch {
    return null
  }
}

function viaCli(peer, tool, args) {
  const r = spawnSync(process.execPath, [cli, 'peer', 'call', tool, '--to', peer, '--args', JSON.stringify(args)], { encoding: 'utf8', timeout: 120000 })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  try { return JSON.parse(out) } catch { return { ok: false, error: out.slice(0, 500) } }
}

const [peer, group, a1, a2, a3] = argv
if (!peer || !group) {
  console.error('用法: node pc.mjs <peer> action|app|window|browser ...')
  process.exit(2)
}
const spec = buildArgs(group, a1, a2, a3)
if (!spec) { console.error('未知分组: ' + group + '（可用: action / app / window / browser）'); process.exit(2) }
const [tool, argsObj] = spec
let result = await viaDaemon(peer, tool, argsObj)
if (!result) {
  console.error('daemon 不可用，回退 CLI（较慢）')
  result = viaCli(peer, tool, argsObj)
}
console.log(JSON.stringify(result))
process.exit(result && result.ok ? 0 : 1)
