// @generated 2026-10-27 repair 重启命令的**运行期**白名单（不只是编辑期校验）
// [why] 2026-10-27 P2 安全收紧：`repair.restartScripts` 是「配置即白名单」，但配置可以被手改/被别的工具写。
//       如果只在写配置时校验，手改 config 仍能塞任意命令。所以 service_restart **执行前**也过同一套规则：
//       只允许调用 mesh 自己的重启脚本 / 看护脚本 / autostart 的 start-dshN.vbs|cmd，且禁止 shell 元字符。
// 归宿：reusable（dsh-mesh/src/core/）
export const RESTART_TARGET_RE = /\b(restart-dsh-instance\.mjs|instance-watchdog\.mjs|start-dsh\d*\.(vbs|cmd))\b/
export const MAX_RESTART_COMMAND_LEN = 600
/** Shell metacharacters that would let a "restart" command become arbitrary code. */
const FORBIDDEN_META_RE = /[|&;<>`$(){}]/

export function validateRestartCommand(command) {
  const text = String(command || '').trim()
  if (!text) return { ok: false, reason: 'command is empty' }
  if (text.length > MAX_RESTART_COMMAND_LEN) return { ok: false, reason: `command longer than ${MAX_RESTART_COMMAND_LEN} chars` }
  const meta = FORBIDDEN_META_RE.exec(text)
  if (meta) return { ok: false, reason: `command contains shell metacharacter "${meta[0]}" — only plain quoted paths/args are allowed` }
  if (!RESTART_TARGET_RE.test(text)) {
    return { ok: false, reason: 'command must reference restart-dsh-instance.mjs / instance-watchdog.mjs / start-dsh<N>.vbs|cmd' }
  }
  return { ok: true }
}
