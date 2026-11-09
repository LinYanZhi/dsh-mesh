#!/usr/bin/env node
// @generated install-desktop-helper-task：安装「登录时触发」的桌面操作 helper 计划任务
//
// 作用：mesh server 在 session 0（S4U）时，pc_window/pc_app/pc_action 会转发到本 helper；
//       helper 由当前用户登录时在交互 session 启动（隐藏窗口，wscript 调 VBS）。
//
// 用法（在目标机器上执行）：
//   node scripts/install-desktop-helper-task.mjs            # 安装 + 立即启动 + 健康检查
//   node scripts/install-desktop-helper-task.mjs --dry-run  # 只打印将执行的命令
//   node scripts/install-desktop-helper-task.mjs --uninstall
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const uninstall = process.argv.includes('--uninstall')
const taskName = 'dsh-mesh-desktop-helper'
const runtime = join(repo, '.runtime')
const vbsPath = join(runtime, 'desktop-helper.vbs')
const helperPath = join(repo, 'scripts', 'pc-desktop-helper.mjs')
const nodeExe = process.execPath
const log = (msg) => console.log('[install-desktop-helper-task] ' + msg)

function run(cmd, args) {
  if (dryRun) {
    log('DRY-RUN: ' + cmd + ' ' + args.map((a) => (/[ "]/.test(a) ? JSON.stringify(a) : a)).join(' '))
    return { ok: true, dryRun: true }
  }
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, windowsHide: true })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  return { ok: r.status === 0, status: r.status, out }
}

if (process.platform !== 'win32') {
  console.log(JSON.stringify({ ok: false, error: 'windows only' }))
  process.exit(1)
}
if (!existsSync(helperPath)) {
  console.log(JSON.stringify({ ok: false, error: 'helper not found: ' + helperPath }))
  process.exit(1)
}

if (uninstall) {
  const del = run('schtasks', ['/Delete', '/F', '/TN', taskName])
  const stop = run('powershell.exe', ['-NoProfile', '-Command', 'Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*pc-desktop-helper*" } | Stop-Process -Force'])
  console.log(JSON.stringify({ ok: del.ok, uninstall: true, del: del.out, stop: stop.out }))
  process.exit(del.ok ? 0 : 1)
}

// 1) 写隐藏启动用的 VBS（wscript 启动 → 无黑窗）
if (!dryRun) {
  mkdirSync(runtime, { recursive: true })
  const vbs = 'Set WshShell = CreateObject("WScript.Shell")\r\n' +
    'WshShell.Run """' + nodeExe + '"" ""' + helperPath + '""", 0, False\r\n'
  writeFileSync(vbsPath, vbs, 'utf8')
  log('vbs written: ' + vbsPath)
}

// 2) 创建/覆盖任务：登录触发 + 当前用户 + 普通权限（交互 session）
const create = run('schtasks', ['/Create', '/F', '/TN', taskName, '/SC', 'ONLOGON', '/TR', 'wscript.exe "' + vbsPath + '"', '/RL', 'LIMITED'])
log('create: ' + (create.out || create.status))
if (!create.ok) {
  console.log(JSON.stringify({ ok: false, create: create.out }))
  process.exit(1)
}

// 3) 立即运行（若 helper 已在监听则跳过重复启动）
const healthBefore = run('powershell.exe', ['-NoProfile', '-Command', "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:19556/health).StatusCode } catch { 'down' }"])
const already = /200/.test(healthBefore.out || '')
if (!already) run('schtasks', ['/Run', '/TN', taskName])

// 4) 等待并健康检查
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
for (let i = 0; i < 15; i++) {
  wait(1000)
  const h = run('powershell.exe', ['-NoProfile', '-Command', "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:19556/health).Content } catch { 'down' }"])
  if (/\"ok\":true/.test(h.out || '')) {
    console.log(JSON.stringify({ ok: true, task: taskName, vbs: vbsPath, helper: helperPath, health: h.out.trim(), alreadyRunning: already }))
    process.exit(0)
  }
}
console.log(JSON.stringify({ ok: false, task: taskName, error: 'helper health not ok after 15s', vbs: vbsPath }))
process.exit(1)
