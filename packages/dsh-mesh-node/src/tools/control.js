import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { z } from 'zod'
import { ok, denied, invalidArg } from '../core/result.js'
import { isProxyTimeout, maybeProxy, proxyTimeoutMessage } from '../core/desktop-proxy.js'

/**
 * pc_action：确定性电脑操作（白名单枚举，不是远程 shell / 远程键盘）。
 *
 * 设计要点：
 * - 只接受枚举动作，未知动作直接拒绝；
 * - Windows 用系统自带命令/PowerShell COM/虚拟按键实现；Linux/macOS 提供有限实现；
 * - shutdown/restart 必须 confirm=true；sleep 也建议 confirm；
 * - 按 tokenId 限频（默认 60 次/分钟），防脚本风暴；
 * - 不接收任意程序路径、任意按键串、任意命令行。
 */
const ACTIONS = [
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

const CONFIRM_REQUIRED = new Set(['sleep', 'shutdown', 'restart'])

const WINDOWS = process.platform === 'win32'
const DARWIN = process.platform === 'darwin'
const LINUX = process.platform === 'linux'

const VK = {
  mute: 0xad,
  volumeDown: 0xae,
  volumeUp: 0xaf,
  mediaNext: 0xb0,
  mediaPrev: 0xb1,
  mediaPlayPause: 0xb3
}

function run(command, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { windowsHide: true, timeout: timeoutMs })
    } catch (error) {
      resolve({ ok: false, code: null, error: String(error?.message || error), stdout, stderr, ms: Date.now() - started })
      return
    }
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      resolve({ ok: false, code: null, error: String(error?.message || error), stdout, stderr, ms: Date.now() - started })
    })
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, error: code === 0 ? null : stderr.trim() || `exit ${code}`, stdout: stdout.trim().slice(0, 4000), stderr: stderr.trim().slice(0, 4000), ms: Date.now() - started })
    })
  })
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script])
}

function keybdEvent(vk) {
  const script = `Add-Type -Namespace Win32 -Name Keyboard -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'; [Win32.Keyboard]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [Win32.Keyboard]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)`
  return powershell(script)
}

async function executeWindows(action) {
  switch (action) {
    case 'lock':
      return run('rundll32.exe', ['user32.dll,LockWorkStation'])
    case 'show-desktop':
      return powershell('(New-Object -ComObject Shell.Application).ToggleDesktop()')
    case 'task-manager': {
      try {
        const child = spawn('taskmgr.exe', [], { detached: true, stdio: 'ignore', windowsHide: false })
        child.unref()
        return { ok: true, code: 0, detail: 'taskmgr.exe launched', ms: 0, stdout: '', stderr: '' }
      } catch (error) {
        return { ok: false, error: String(error?.message || error), ms: 0 }
      }
    }
    case 'mute':
      return keybdEvent(VK.mute)
    case 'volume-up':
      return keybdEvent(VK.volumeUp)
    case 'volume-down':
      return keybdEvent(VK.volumeDown)
    case 'media-play-pause':
      return keybdEvent(VK.mediaPlayPause)
    case 'media-next':
      return keybdEvent(VK.mediaNext)
    case 'media-prev':
      return keybdEvent(VK.mediaPrev)
    case 'sleep':
      return run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])
    case 'cancel-shutdown':
      return run('shutdown.exe', ['/a'])
    case 'shutdown':
      return run('shutdown.exe', ['/s', '/t', '15'])
    case 'restart':
      return run('shutdown.exe', ['/r', '/t', '15'])
    default:
      return null
  }
}

async function executeLinux(action) {
  switch (action) {
    case 'lock':
      return run('loginctl', ['lock-session'])
    case 'show-desktop': {
      // 优先 xdotool（未装则失败，不安装任何东西）
      return run('xdotool', ['key', 'super+d'])
    }
    case 'sleep':
      return run('systemctl', ['suspend'])
    case 'shutdown':
      return run('shutdown', ['-h', '+1'])
    case 'restart':
      return run('shutdown', ['-r', '+1'])
    case 'info':
      return { ok: true, code: 0, detail: 'linux', ms: 0 }
    default:
      return null
  }
}

async function executeDarwin(action) {
  switch (action) {
    case 'lock':
      return run('pmset', ['displaysleepnow'])
    case 'sleep':
      return run('pmset', ['sleepnow'])
    case 'shutdown':
      return run('shutdown', ['-h', '+1'])
    case 'restart':
      return run('shutdown', ['-r', '+1'])
    default:
      return null
  }
}

export function buildControl(ctx) {
  const rate = new Map()
  const RATE_WINDOW_MS = 60_000
  const RATE_MAX = 60

  function rateLimited(peerId) {
    const now = Date.now()
    const key = String(peerId || 'local')
    const list = (rate.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS)
    if (list.length >= RATE_MAX) return true
    list.push(now)
    rate.set(key, list)
    return false
  }

  return [
    {
      name: 'pc_action',
      title: 'Run a whitelisted desktop action on the peer machine',
      description:
        'Deterministic desktop actions on the peer machine (NOT a remote shell/keyboard). Whitelisted actions: ' +
        ACTIONS.join(', ') +
        '. shutdown/restart/sleep require confirm=true. Actions needing an interactive logged-in desktop (show-desktop/media keys/volume) may fail while the machine is locked.',
      inputSchema: z.object({
        action: z.enum(ACTIONS),
        confirm: z.boolean().optional()
      }),
      handler: async ({ action, confirm }, { peerId } = {}) => {
        const config = ctx.getConfig()
        if (config?.pcControl?.enabled !== true) {
          return denied('pc_action is disabled on this node (config.pcControl.enabled=false)')
        }
        if (rateLimited(peerId)) {
          return denied('rate limit exceeded (60 actions/minute per peer token)')
        }
        if (CONFIRM_REQUIRED.has(action) && confirm !== true) {
          return invalidArg(`${action} requires confirm=true`)
        }
        if (action !== 'info') {
          const proxied = await maybeProxy('pc_action', { action, confirm })
          if (isProxyTimeout(proxied)) return invalidArg(proxyTimeoutMessage('pc_action', proxied))
          if (proxied) return proxied
        }
        const started = Date.now()
        if (action === 'info') {
          return ok({
            action,
            host: hostname(),
            platform: process.platform,
            arch: process.arch,
            uptimeSec: Math.floor(process.uptime()),
            actions: ACTIONS,
            confirmRequired: [...CONFIRM_REQUIRED],
            ms: Date.now() - started
          })
        }
        const result = WINDOWS ? await executeWindows(action) : DARWIN ? await executeDarwin(action) : LINUX ? await executeLinux(action) : null
        if (!result) {
          return denied(`action ${action} is not supported on ${process.platform}`)
        }
        if (!result.ok) {
          return invalidArg(`action ${action} failed: ${result.error || result.stderr || 'unknown error'}`)
        }
        return ok({
          action,
          host: hostname(),
          platform: process.platform,
          exitCode: result.code,
          detail: result.detail || result.stdout || '',
          stderr: result.stderr || '',
          ms: Date.now() - started
        })
      }
    }
  ]
}
