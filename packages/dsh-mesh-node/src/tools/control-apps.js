import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { z } from 'zod'
import { ok, denied, invalidArg } from '../core/result.js'
import { isProxyTimeout, maybeProxy, proxyTimeoutMessage } from '../core/desktop-proxy.js'

/**
 * pc_app / pc_window / pc_browser：应用、窗口、浏览器操作（白名单 / 结构化参数）。
 *
 * 安全原则：
 * - 启动只接受白名单别名；关闭只接受「进程名」且拒绝系统关键进程，且需 confirm=true；
 * - 窗口操作只接受 PID（整数）或白名单应用名，不接受任意标题/命令；
 * - 浏览器：只允许 http(s) URL；CDP 只连 127.0.0.1:9222（本机回环）；
 * - 不接收任意命令行、不注入按键。
 */
const WINDOWS = process.platform === 'win32'

const APP_ALIASES = {
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
  notepad: 'notepad.exe',
  explorer: 'explorer.exe',
  taskmgr: 'taskmgr.exe',
  code: 'Code.exe',
  wechat: 'WeChat.exe',
  word: 'WINWORD.EXE',
  excel: 'EXCEL.EXE',
  wps: 'wps.exe'
}

const PROTECTED = ['dsh', 'node', 'npm', 'powershell', 'pwsh', 'cmd', 'conhost', 'explorer', 'winlogon', 'csrss', 'services', 'lsass']

function run(command, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { windowsHide: true, timeout: timeoutMs })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error), stdout, stderr, ms: Date.now() - started })
      return
    }
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => resolve({ ok: false, error: String(error?.message || error), stdout, stderr, ms: Date.now() - started }))
    child.on('close', (code) => resolve({ ok: code === 0, code, error: code === 0 ? null : stderr.trim() || `exit ${code}`, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - started }))
  })
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script])
}

const WINDOW_SCRIPT = `
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  public static string ClassOf(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString().Replace("|", "/");
  }
  public static string ProcOf(uint pid) {
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.Replace("|", "/"); } catch { return ""; }
  }
  public static System.Collections.Generic.List<string> List() {
    var list = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(h.ToString() + "|" + pid + "|" + ClassOf(h) + "|" + ProcOf(pid) + "|" + sb.ToString().Replace("|", "/") + "|" + (IsIconic(h) ? "1" : "0"));
      return true;
    }, IntPtr.Zero);
    return list;
  }
}

public class WClose {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  static IntPtr found = IntPtr.Zero;
  public static string Describe(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    var c = new StringBuilder(256); GetClassName(h, c, c.Capacity);
    var t = new StringBuilder(512); GetWindowText(h, t, t.Capacity);
    string pn = "";
    try { pn = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
    return h.ToString() + "|" + pid + "|" + c.ToString().Replace("|", "/") + "|" + pn.Replace("|", "/") + "|" + t.ToString().Replace("|", "/");
  }
  public static string ByHwnd(long hv) {
    var h = new IntPtr(hv);
    if (!IsWindow(h)) return "NOT_FOUND";
    if (!IsWindowVisible(h)) return "NOT_VISIBLE";
    return Describe(h);
  }
  public static string ByPid(uint pid) {
    found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, sb.Capacity);
      if (sb.Length == 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return "NOT_FOUND";
    return Describe(found);
  }
  public static bool Close(IntPtr h) { return PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@
Add-Type -TypeDefinition $sig
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[W]::List() | ForEach-Object { $_ }
`

function parseWindows(text) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.split('|')
    if (parts.length < 6) continue
    rows.push({ hwnd: parts[0], pid: Number(parts[1]), className: parts[2], processName: parts[3], title: parts[4], minimized: parts[5] === '1' })
  }
  return rows
}

const PROTECTED_WINDOW_CLASSES = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'ApplicationFrameWindow']
const PROTECTED_WINDOW_SUFFIXES = ['CoreWindow']

function normalizeHwnd(value) {
  const s = String(value || '').trim()
  if (/^0x[0-9a-fA-F]{1,16}$/.test(s)) return BigInt(s).toString()
  if (/^[0-9]{1,20}$/.test(s)) return s
  return null
}

async function windowAction(scriptFooter) {
  const r = await powershell(WINDOW_SCRIPT + '\n' + scriptFooter)
  return r
}


// ── 浏览器用户配置（Chrome/Edge 自带的多 profile）────────────────────────────────
// 用户做自动化时常在浏览器里建多个「用户配置」，这里让手机能列出并按指定 profile 打开。
const BROWSER_PROFILE_SOURCES = {
  chrome: {
    userData: () => join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data'),
    exe: () =>
      [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
      ].find((p) => existsSync(p)) || null
  },
  edge: {
    userData: () => join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/User Data'),
    exe: () =>
      [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe')
      ].find((p) => existsSync(p)) || null
  }
}

/** 读某个浏览器的 profile 清单：优先 Local State 的 profile.info_cache（含显示名），退化到扫目录名。 */
export function readBrowserProfiles(userDataDir) {
  const rows = []
  if (!userDataDir) return rows
  try {
    const localState = JSON.parse(readFileSync(join(userDataDir, 'Local State'), 'utf8'))
    const cache = localState?.profile?.info_cache || {}
    for (const [dir, info] of Object.entries(cache)) {
      if (!/^[A-Za-z0-9 _.-]{1,60}$/.test(dir)) continue
      rows.push({
        dir,
        name: String(info?.name || dir).slice(0, 80),
        isDefault: dir === 'Default',
        avatarIndex: typeof info?.avatar_index === 'number' ? info.avatar_index : null
      })
    }
  } catch {
    /* Local State 缺失/损坏 → 退化到目录扫描 */
  }
  if (!rows.length) {
    try {
      for (const name of readdirSync(userDataDir)) {
        if (name === 'Default' || /^Profile \d+$/.test(name)) rows.push({ dir: name, name, isDefault: name === 'Default', avatarIndex: null })
      }
    } catch {
      /* 目录也不存在 → 空清单 */
    }
  }
  return rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.dir.localeCompare(b.dir, 'en', { numeric: true }))
}

/** 把用户给的 profile（目录名或显示名）解析成真实目录名；未知则返回 null。 */
function resolveBrowserProfile(profiles, wanted) {
  const raw = String(wanted || '').trim()
  if (!raw) return null
  const byDir = profiles.find((p) => p.dir.toLowerCase() === raw.toLowerCase())
  if (byDir) return byDir.dir
  const byName = profiles.find((p) => p.name.toLowerCase() === raw.toLowerCase())
  return byName ? byName.dir : null
}

export function buildControlApps(ctx) {
  return [
    {
      name: 'pc_app',
      title: 'Application control (whitelisted) on the peer machine',
      description:
        'Whitelisted application control: list(list running GUI apps) / start(alias: ' +
        Object.keys(APP_ALIASES).join(', ') +
        ') / close(process name, graceful, confirm=true). System/DSh processes are protected.',
      inputSchema: z.object({
        action: z.enum(['list', 'start', 'close']),
        app: z.string().max(40).optional(),
        path: z.string().max(20).optional(),
        confirm: z.boolean().optional()
      }),
      handler: async ({ action, app, path, confirm }) => {
        const cfg = ctx.getConfig()
        if (cfg?.pcControl?.enabled !== true) return denied('pc_app is disabled on this node')
        if (!WINDOWS) return denied('pc_app is only implemented on Windows')
        const proxiedApp = await maybeProxy('pc_app', { action, app, path, confirm })
        if (isProxyTimeout(proxiedApp)) return invalidArg(proxyTimeoutMessage('pc_app', proxiedApp))
        if (proxiedApp) return proxiedApp
        if (action === 'list') {
          const r = await powershell(`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() -ne '' } | Select-Object -First 40 ProcessName,Id,MainWindowTitle | ConvertTo-Json -Compress`)
          if (!r.ok) return invalidArg('list failed: ' + r.error)
          let list = []
          try { list = JSON.parse(r.stdout || '[]') } catch {}
          return ok({ action, host: hostname(), apps: list, ms: r.ms })
        }
        if (action === 'start') {
          const key = String(app || '').toLowerCase()
          const exe = APP_ALIASES[key]
          if (!exe) return invalidArg('unknown app alias: ' + app + ' (allowed: ' + Object.keys(APP_ALIASES).join(', ') + ')')
          const args = []
          if (key === 'explorer' && path) {
            if (!/^[A-Za-z]:[\\/]?$/.test(path)) return invalidArg('path for explorer must be a drive root like D: or D:\\')
            args.push(path.replace(/\/$/, '\\'))
          }
          const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
          child.unref()
          return ok({ action, app: key, exe, path: path || null, started: true, host: hostname() })
        }
        if (action === 'close') {
          if (confirm !== true) return invalidArg('close requires confirm=true')
          const name = String(app || '').replace(/\.exe$/i, '')
          if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name)) return invalidArg('invalid process name')
          if (PROTECTED.includes(name.toLowerCase())) return denied('protected process: ' + name)
          const r = await powershell(`$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }; if (-not $p) { '0' } else { $n = 0; foreach ($x in $p) { if ($x.CloseMainWindow()) { $n++ } }; $n }`)
          if (!r.ok) return invalidArg('close failed: ' + r.error)
          return ok({ action, app: name, closedWindows: Number(r.stdout || 0), host: hostname(), ms: r.ms })
        }
        return invalidArg('unknown action')
      }
    },
    {
      name: 'pc_window',
      title: 'Window control (list / focus / minimize / close)',
      description:
        'Window control on the peer machine: list(visible windows: hwnd, pid, className, processName, title, minimized) / focus(pid) / minimize(pid) / close(hwnd or pid, confirm=true, graceful WM_CLOSE). System/desktop windows (Progman/WorkerW/Shell_TrayWnd/CoreWindow/ApplicationFrameWindow) are refused; close only posts WM_CLOSE to the window, never kills a process.',
      inputSchema: z.object({
        action: z.enum(['list', 'focus', 'minimize', 'close']),
        pid: z.number().int().positive().optional(),
        hwnd: z.string().max(20).optional(),
        app: z.string().max(40).optional(),
        confirm: z.boolean().optional()
      }),
      handler: async ({ action, pid, hwnd, app, confirm }) => {
        const cfg = ctx.getConfig()
        if (cfg?.pcControl?.enabled !== true) return denied('pc_window is disabled on this node')
        if (!WINDOWS) return denied('pc_window is only implemented on Windows')
        const proxiedWindow = await maybeProxy('pc_window', { action, pid, hwnd, app, confirm })
        if (isProxyTimeout(proxiedWindow)) return invalidArg(proxyTimeoutMessage('pc_window', proxiedWindow))
        if (proxiedWindow) return proxiedWindow
        if (action === 'list') {
          const r = await windowAction('')
          if (!r.ok) return invalidArg('list failed: ' + r.error)
          const rows = parseWindows(r.stdout)
          return ok({ action, host: hostname(), count: rows.length, windows: rows.slice(0, 60), ms: r.ms })
        }
        if (action === 'close') {
          if (confirm !== true) return invalidArg('close requires confirm=true')
          const targetHwnd = normalizeHwnd(hwnd)
          const targetPid = Number(pid || 0)
          if (!targetHwnd && !targetPid) return invalidArg(hwnd ? 'E_WINDOW_NOT_FOUND: invalid hwnd (expected 0xHEX or decimal)' : 'E_WINDOW_NOT_FOUND: hwnd or pid is required')
          const finder = targetHwnd
            ? '$info = [WClose]::ByHwnd([long]' + targetHwnd + ')'
            : '$info = [WClose]::ByPid([uint32]' + targetPid + ')'
          const footer = finder + '\n' +
            "if ($info -eq 'NOT_FOUND') { 'NOT_FOUND' }\n" +
            "elseif ($info -eq 'NOT_VISIBLE') { 'NOT_VISIBLE' }\n" +
            'else {\n' +
            "  $parts = $info -split '\\|'\n" +
            '  $cls = $parts[2]\n' +
            "  $protected = @('Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd','ApplicationFrameWindow')\n" +
            "  if (($protected -contains $cls) -or ($cls -like '*CoreWindow*')) { 'PROTECTED|' + $info }\n" +
            "  else { $closed = [WClose]::Close([IntPtr]::new([long]$parts[0])); 'CLOSED|' + $closed + '|' + $info }\n" +
            '}'
          const r = await windowAction(footer)
          if (!r.ok) return invalidArg('close failed: ' + r.error)
          const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          const line = lines[lines.length - 1] || ''
          if (line === 'NOT_FOUND') return invalidArg('E_WINDOW_NOT_FOUND: window not found (hwnd=' + (targetHwnd || '-') + ', pid=' + (targetPid || '-') + ')')
          if (line === 'NOT_VISIBLE') return invalidArg('E_WINDOW_NOT_FOUND: window exists but is not visible')
          const kind = line.split('|')[0]
          const rest = line.slice(kind.length + 1).split('|')
          const protectedInfo = { hwnd: rest[0], pid: Number(rest[1]), className: rest[2], processName: rest[3], title: rest[4] }
          if (kind === 'PROTECTED') return denied('refusing to close protected system/desktop window (className=' + protectedInfo.className + ', title=' + protectedInfo.title + ')')
          if (kind !== 'CLOSED') return invalidArg('unexpected close result: ' + line.slice(0, 200))
          const info = { hwnd: rest[1], pid: Number(rest[2]), className: rest[3], processName: rest[4], title: rest[5] }
          return ok({ action: 'close', host: hostname(), closed: rest[0] === 'True' || rest[0] === 'true', ...info, ms: r.ms })
        }
        const targetPid = Number(pid || 0)
        if (!targetPid) return invalidArg('pid is required')
        const where = `Where-Object { $_.pid -eq ${targetPid} }`
        const script = action === 'focus'
          ? `[W]::List() | ForEach-Object { $p = $_ -split '\\|'; if ([int]$p[1] -eq ${targetPid}) { [W]::SetForegroundWindow([IntPtr]::new([long]$p[0])) } }`
          : `[W]::List() | ForEach-Object { $p = $_ -split '\\|'; if ([int]$p[1] -eq ${targetPid}) { [W]::ShowWindow([IntPtr]::new([long]$p[0]), 6) } }`
        const r = await windowAction(script)
        if (!r.ok) return invalidArg(action + ' failed: ' + r.error)
        return ok({ action, pid: targetPid, host: hostname(), ms: r.ms })
      }
    },
    {
      name: 'pc_browser',
      title: 'Browser control (open URL / list browsers / CDP tabs on 127.0.0.1:9222)',
      description:
        'Browser control on the peer machine. actions: browsers(list installed Chrome/Edge) / profiles(list browser user profiles of Chrome/Edge) / ' +
        'open-url(http(s) URL; browser=default|chrome|edge; profile=<profile dir or display name> opens with that browser user profile) / ' +
        'debug-launch(launch a dedicated automation browser with CDP on 127.0.0.1:9222) / cdp-list / cdp-open(url) / cdp-close(id). CDP only connects to loopback.',
      inputSchema: z.object({
        action: z.enum(['browsers', 'profiles', 'open-url', 'debug-launch', 'cdp-list', 'cdp-open', 'cdp-close']),
        url: z.string().max(2000).optional(),
        browser: z.enum(['default', 'chrome', 'edge']).optional(),
        profile: z.string().max(80).optional(),
        newWindow: z.boolean().optional(),
        id: z.string().max(100).optional()
      }),
      handler: async ({ action, url, browser = 'default', profile, newWindow, id }) => {
        const cfg = ctx.getConfig()
        if (cfg?.pcControl?.enabled !== true) return denied('pc_browser is disabled on this node')
        if (!WINDOWS) return denied('pc_browser is only implemented on Windows')
        const proxiedBrowser = await maybeProxy('pc_browser', { action, url, browser, profile, newWindow, id })
        if (isProxyTimeout(proxiedBrowser)) return invalidArg(proxyTimeoutMessage('pc_browser', proxiedBrowser))
        if (proxiedBrowser) return proxiedBrowser
        const chromePaths = [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
        ]
        const edgePaths = [
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
        ]
        const findBrowser = (list) => list.find((p) => existsSync(p)) || null
        const isHttp = (u) => /^https?:\/\//i.test(String(u || ''))
        if (action === 'browsers') {
          const out = { chrome: findBrowser(chromePaths), edge: findBrowser(edgePaths) }
          return ok({ action, host: hostname(), browsers: out })
        }
        if (action === 'profiles') {
          const wanted = browser === 'default' ? ['chrome', 'edge'] : [browser]
          const out = {}
          for (const name of wanted) {
            const src = BROWSER_PROFILE_SOURCES[name]
            const userDataDir = src?.userData() || null
            out[name] = { installed: Boolean(src?.exe()), userDataDir, profiles: readBrowserProfiles(userDataDir) }
          }
          return ok({ action, host: hostname(), browsers: out })
        }
        if (action === 'open-url') {
          if (!isHttp(url)) return invalidArg('url must start with http:// or https://')
          const exe = browser === 'chrome' ? findBrowser(chromePaths) : browser === 'edge' ? findBrowser(edgePaths) : null
          if (profile) {
            // 指定浏览器用户配置时，必须明确是 chrome 还是 edge（default 无从判断）
            const targetName = browser === 'default' ? 'chrome' : browser
            const targetExe = targetName === 'chrome' ? findBrowser(chromePaths) : findBrowser(edgePaths)
            if (!targetExe) return invalidArg('browser not installed: ' + targetName)
            const src = BROWSER_PROFILE_SOURCES[targetName]
            const profiles = readBrowserProfiles(src?.userData() || '')
            if (!profiles.length) return invalidArg('no browser user profiles found under ' + (src?.userData() || '?') + '（浏览器是否装过/启动过？）')
            const dir = resolveBrowserProfile(profiles, profile)
            if (!dir) {
              return invalidArg('unknown browser profile: ' + profile + '；可用: ' + profiles.map((p) => p.dir + '(' + p.name + ')').join(', '))
            }
            const args = ['--profile-directory=' + dir]
            if (newWindow === true) args.push('--new-window')
            args.push(url)
            const child = spawn(targetExe, args, { detached: true, stdio: 'ignore', windowsHide: false })
            child.unref()
            return ok({ action, browser: targetName, profile: dir, profileName: (profiles.find((p) => p.dir === dir) || {}).name || dir, url, host: hostname() })
          }
          if (exe) {
            const child = spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: false })
            child.unref()
            return ok({ action, browser, url, host: hostname() })
          }
          const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
          child.unref()
          return ok({ action, browser: 'default', url, host: hostname() })
        }
        if (action === 'debug-launch') {
          const exe = browser === 'chrome' ? findBrowser(chromePaths) : findBrowser(edgePaths)
          if (!exe) return invalidArg('browser not installed: ' + browser)
          const profile = join(homedir(), '.dsh-mesh', 'browser-profile')
          const child = spawn(exe, ['--remote-debugging-port=9222', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore', windowsHide: false })
          child.unref()
          return ok({ action, browser, exe, cdp: 'http://127.0.0.1:9222', profile, host: hostname(), note: '等待 2~3 秒后再 cdp-list' })
        }
        const base = 'http://127.0.0.1:9222'
        const fetchJson = async (path, method = 'GET') => {
          const res = await fetch(base + path, { method, signal: AbortSignal.timeout(5000) })
          const text = await res.text()
          try { return JSON.parse(text) } catch { return text }
        }
        try {
          if (action === 'cdp-list') {
            const list = await fetchJson('/json/list')
            const tabs = Array.isArray(list) ? list.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url })) : list
            return ok({ action, host: hostname(), tabs })
          }
          if (action === 'cdp-open') {
            if (!isHttp(url)) return invalidArg('url must start with http:// or https://')
            const tab = await fetchJson('/json/new?' + encodeURIComponent(url), 'PUT')
            return ok({ action, host: hostname(), tab: { id: tab.id, title: tab.title, url: tab.url } })
          }
          if (action === 'cdp-close') {
            if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(id || ''))) return invalidArg('invalid tab id')
            const r = await fetchJson('/json/close/' + id)
            return ok({ action, host: hostname(), result: r })
          }
        } catch (error) {
          return invalidArg('CDP not available (open debug browser first via debug-launch): ' + String(error?.message || error))
        }
        return invalidArg('unknown action')
      }
    }
  ]
}
