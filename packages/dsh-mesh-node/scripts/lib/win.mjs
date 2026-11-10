// @generated 2026-10-27 Windows 工具定位（PATH 不可靠：计划任务/受限会话里可能找不到 powershell）
// [why] 2026-10-27 家里 AI 报告：某些会话的 PATH 里没有 powershell/pwsh，导致 mesh-health 把
//       已安装的 watchdog 误报成「未安装」；如果 watchdog 自己也遇到同样情况，会误判实例全 down 反复拉起。
//       统一改成「先绝对路径探测，找不到才退回名字」。
// 归宿：reusable（dsh-mesh/scripts/lib/）
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Absolute path to Windows PowerShell, falling back to the bare name. */
export function powershellExe() {
  const explicit = process.env.DSH_POWERSHELL
  if (explicit && existsSync(explicit)) return explicit
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const candidates = [
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return 'powershell'
}
