#!/usr/bin/env node
// @generated phone-pc：手机侧电脑控制快捷封装（部署到 /root/dsh-mesh-kit/pc.mjs）
// [why] 2026-11-10：手机上「显示桌面」被写成 `pc.mjs home show-desktop` 时只报「未知分组」，
//   必须知道还有一层 action 才行；「数桌面文件」这类只读查询也不该逼人写 `cli peer call`。
//   所以：① 第二个参数直接是动作名时自动当 action 组（旧写法兼容）；② 新增 path / fs 两个只读分组；
//   ③ 未知分组 / 缺参数时把全部组 + 示例打出来，别让人去翻源码。
//
// 用法（手机 proot 内）：
//   node /root/dsh-mesh-kit/pc.mjs <peer> action <动作> [confirm]
//   node /root/dsh-mesh-kit/pc.mjs <peer> <动作> [confirm]        # 旧写法：等价于上一行
//   node /root/dsh-mesh-kit/pc.mjs <peer> app list | start <alias> [path] | close <进程名> [confirm]
//   node /root/dsh-mesh-kit/pc.mjs <peer> window list | focus <pid> | minimize <pid> | close <hwnd|pid=123>
//   node /root/dsh-mesh-kit/pc.mjs <peer> browser browsers | open-url <url> | debug-launch [edge|chrome] | cdp-list | cdp-open <url> | cdp-close <id>
//   node /root/dsh-mesh-kit/pc.mjs <peer> path exists|list|stat <绝对路径>   # 只读路径探查（不受 fsRoots 限制）
//   node /root/dsh-mesh-kit/pc.mjs <peer> fs list <路径> | fs stat <路径>   # 受对端 fsRoots 限制的只读检索
//
// 优先走本机常驻 daemon（127.0.0.1:19555，延迟低）；daemon 不可用时回退到 CLI。
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const cli = process.env.DSH_MESH_CLI || '/root/dsh-mesh-kit/mesh/src/cli.js'
const daemon = process.env.DSH_PC_DAEMON_URL || 'http://127.0.0.1:19555/call'

/** pc_action 允许的动作（与对端 src/tools/control.js 的 ACTIONS 保持一致）。 */
const ACTION_NAMES = [
  'info',
  'lock',
  'show-desktop',
  'task-manager',
  'mute',
  'volume-up',
  'volume-down',
  'media-play-pause',
  'media-next',
  'media-prev',
  'sleep',
  'cancel-shutdown',
  'shutdown',
  'restart'
]

function printUsage() {
  console.error(`可用分组（第二个参数直接写动作名 = action 组，旧写法兼容）:

  action   <peer> action <动作> [confirm]
           例: action show-desktop  ·  action lock  ·  action volume-up  ·  action shutdown confirm
           动作: ${ACTION_NAMES.join(' / ')}
  app      <peer> app list | app start <alias> [path] | app close <进程名> [confirm]
           例: app list  ·  app start edge  ·  app close msedge confirm
  window   <peer> window list | window focus <pid> | window minimize <pid> | window close <hwnd|pid=123>
           例: window list  ·  window focus 1234  ·  window close pid=1234
  browser  <peer> browser browsers | open-url <url> | debug-launch [edge|chrome] | cdp-list | cdp-open <url> | cdp-close <id>
           例: browser browsers  ·  browser open-url https://example.com  ·  browser debug-launch edge
  path     <peer> path exists|list|stat <绝对路径>
           只读路径探查（服务端 pc_path，不受 fsRoots 限制；绝对路径、拒绝 .. 与敏感目录）
           例: path exists D:\\\\work  ·  path list D:/work  ·  path stat C:/Users/Administrator/Desktop
           例: path exists C:/Users/Administrator/Desktop desktop.ini,*.lnk   （第 3 参数=逗号分隔的名字清单）
  fs       <peer> fs list <路径> | fs stat <路径>
           只读文件检索（服务端 fs_list / fs_stat，路径必须在**对端 fsRoots** 之内）
           例: fs list C:/Users/Administrator/Desktop  ·  fs stat C:/Users/Administrator/Code

例（旧写法，自动当 action 组）:
  node pc.mjs home show-desktop    ==    node pc.mjs home action show-desktop
`)
}

function badUsage(message) {
  return { error: message }
}

function needPath(op, p) {
  if (!p) return badUsage(`${op} 需要 <绝对路径>（例：path ${op} C:/Users/Administrator/Desktop）`)
  return null
}

function buildArgs(group, a1, a2, a3) {
  if (group === 'action') {
    if (!a1) return badUsage('action 缺动作名（例：action show-desktop / action lock）')
    const args = { action: a1 }
    if (a2 === 'confirm') args.confirm = true
    return ['pc_action', args]
  }
  if (group === 'app') {
    if (!a1) return badUsage('app 缺子命令（list|start|close）')
    const args = { action: a1 }
    if (a1 === 'start' || a1 === 'close') args.app = a2
    if (a1 === 'start' && a3) args.path = a3
    if (a3 === 'confirm' || a3 === 'force') args.confirm = true
    return ['pc_app', args]
  }
  if (group === 'window') {
    if (!a1) return badUsage('window 缺子命令（list|focus|minimize|close）')
    const args = { action: a1 }
    if (a1 === 'close') {
      if (!a2) return badUsage('用法: window close <hwnd(0x..)|pid=123>')
      if (a2.startsWith('pid=')) args.pid = Number(a2.slice(4))
      else args.hwnd = a2
      args.confirm = true
      return ['pc_window', args]
    }
    if (a2) args.pid = Number(a2)
    return ['pc_window', args]
  }
  if (group === 'browser') {
    if (!a1) return badUsage('browser 缺子命令（browsers|open-url|debug-launch|cdp-list|cdp-open|cdp-close）')
    const args = { action: a1 }
    if (a1 === 'open-url' || a1 === 'cdp-open') args.url = a2
    if (a1 === 'debug-launch' && (a2 === 'edge' || a2 === 'chrome')) args.browser = a2
    if (a1 === 'cdp-close') args.id = a2
    return ['pc_browser', args]
  }
  // path：只读路径探查，映射服务端 pc_path（exists / list / stat）
  if (group === 'path') {
    const op = a1
    if (!['exists', 'list', 'stat'].includes(op)) {
      return badUsage(`path 缺动作或动作不对：path exists|list|stat <绝对路径>（例子见下）`)
    }
    const missing = needPath(op, a2)
    if (missing) return missing
    const args = { action: op, path: a2 }
    if (op === 'exists' && a3) args.names = a3.split(',').map((s) => s.trim()).filter(Boolean)
    if (op === 'list' && a3 && Number.isFinite(Number(a3))) args.limit = Number(a3)
    return ['pc_path', args]
  }
  // fs：受对端 fsRoots 限制的只读检索（fs_list / fs_stat）
  if (group === 'fs') {
    const op = a1
    if (op === 'list') {
      const missing = needPath(op, a2)
      if (missing) return missing
      return ['fs_list', { path: a2 }]
    }
    if (op === 'stat') {
      const missing = needPath(op, a2)
      if (missing) return missing
      return ['fs_stat', { path: a2 }]
    }
    return badUsage('fs 缺子命令：fs list <路径> | fs stat <路径>')
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

const [peer, rawGroup, rawA1, rawA2, rawA3] = argv
if (!peer || !rawGroup) {
  console.error('用法: node pc.mjs <peer> action|app|window|browser|path|fs ...')
  console.error('提示：动作名可直接当第二个参数，例如 node pc.mjs home show-desktop')
  process.exit(2)
}
// 旧写法兼容：第二个参数是动作名（show-desktop / lock / mute / volume-up …）时自动当 action 组
const legacyAction = ACTION_NAMES.includes(rawGroup)
const group = legacyAction ? 'action' : rawGroup
const spec = buildArgs(group, legacyAction ? rawGroup : rawA1, legacyAction ? rawA1 : rawA2, legacyAction ? rawA2 : rawA3)
if (spec && spec.error) {
  console.error('参数不对: ' + spec.error)
  printUsage()
  process.exit(2)
}
if (!spec) {
  console.error('未知分组: ' + rawGroup)
  printUsage()
  process.exit(2)
}
const [tool, argsObj] = spec
let result = await viaDaemon(peer, tool, argsObj)
if (!result) {
  console.error('daemon 不可用，回退 CLI（较慢）')
  result = viaCli(peer, tool, argsObj)
}
console.log(JSON.stringify(result))
process.exit(result && result.ok ? 0 : 1)
