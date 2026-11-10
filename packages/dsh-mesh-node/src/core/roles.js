// @generated roles：mesh 入向 token 的角色 / 能力包（替代逐工具 ACL）
// [why] 2026-11-09 事故：手机 controller token 被手工收窄成 5 个工具，导致 9181 次
//       E_DENIED、委托链路瘫痪半天，最后要用户手工改 secrets.json 才恢复。
//       角色制：入网时选一次设备角色（observer/controller/node/admin），能力包随代码升级；
//       旧的逐工具 token 可自动推断迁移，用户不再需要逐工具授权。
//
// 原则：
//   - 角色只做“收窄”，永远不会超过节点 ACL（applyPeerAcl 做交集）
//   - controller = 协调者：能看状态 + 能委托 + 能操作桌面，但**不能**跨机写/重启/改配置
//   - node = 继承节点 ACL（现有 PC 节点行为不变）
//   - admin 预留：目前与 node 等价，真正提权仍需改节点 ACL（用户决策）
// 注意：本文件不 import config.js（config.js 会 import 本文件，避免循环依赖）。

export const ROLES_VERSION = 1

const OBSERVER = [
  'mesh_self',
  'mesh_overview',
  'mesh_alert',
  'mesh_audit_tail',
  'cluster_status',
  'fs_read',
  'fs_list',
  'fs_stat',
  'fs_stats',
  'fs_grep',
  'git_status',
  'git_log',
  'git_diff',
  'repo_scan',
  'task_status',
  'task_list',
  'session_history',
  'host_instances',
  'host_self',
  'host_tools',
  'host_sessions',
  'host_logs',
  'host_agents',
  'channel_targets',
  'channel_sessions',
  'channel_page',
  'delegate_list',
  'delegate_status',
  'delegate_candidates',
  'repair_status',
  'file_read_chunk',
  'file_hash',
  'transfer_usage',
  'find_files',
  'search_text',
  'tool_inventory'
]

const CONTROLLER = [
  ...OBSERVER,
  'delegate',
  'delegate_reply',
  'delegate_gc',
  // 2026-11-10: 发起端直接终止自己委托的任务（真 abort 当前轮）属于协调者能力；
  // 节点 ACL 仍需显式放行 delegate_cancel（deny-by-default，角色只做收窄）。
  'delegate_cancel',
  'host_session_create',
  'host_session_prompt',
  'pc_action',
  'pc_app',
  'pc_window',
  'pc_browser'
]

/** @type {Record<string, { allow: string[] | null, description: string }>} */
export const ROLE_PRESETS = {
  observer: { allow: OBSERVER, description: '只读观察：状态 / 文件 / git / 日志 / 委托列表' },
  controller: { allow: CONTROLLER, description: '协调者：观察 + 委托 + 桌面控制（不能跨机写/重启/改配置）' },
  operator: { allow: [...CONTROLLER, 'file_write_chunk'], description: '操作者：controller + 文件写入/传输（危险，需用户显式指定）' },
  node: { allow: null, description: '节点：继承本机 ACL（与旧行为一致）' },
  admin: { allow: null, description: '管理员：预留，当前等同 node（真正提权需改节点 ACL）' }
}

export const ROLE_NAMES = Object.keys(ROLE_PRESETS)

export function isRole(name) {
  return ROLE_NAMES.includes(String(name || ''))
}

/** 角色允许的工具；null 表示“继承节点 ACL”。 */
export function roleAllow(role) {
  const preset = ROLE_PRESETS[role]
  return preset ? preset.allow : null
}

/** 最小覆盖给定工具集合的角色（用于旧 token 自动迁移）。
 *  - observer / controller：显式 allow 是角色能力包子集 → 升级到该角色
 *  - node：显式 allow 恰好等于节点 ACL → node（等价继承）
 *  - 其他（自定义、或比角色包更宽/更窄的奇怪组合）→ null，保留显式 ACL，由用户决定
 * @param {string[] | null | undefined} allowList
 * @param {string[]} [nodeAllow]
 */
export function inferRole(allowList, nodeAllow = null) {
  const allow = Array.isArray(allowList) ? allowList : null
  if (!allow) return 'node'
  const covers = (role) => {
    const preset = ROLE_PRESETS[role]
    if (!preset || !preset.allow) return false
    return allow.every((name) => preset.allow.includes(name))
  }
  if (covers('observer')) return 'observer'
  if (covers('controller')) return 'controller'
  if (Array.isArray(nodeAllow) && nodeAllow.length > 0) {
    const a = new Set(allow)
    const b = new Set(nodeAllow)
    if (a.size === b.size && [...a].every((name) => b.has(name))) return 'node'
  }
  return null // 自定义 / 无法安全推断 → 保留显式 ACL
}

export function describeRole(role) {
  return ROLE_PRESETS[role]?.description || '自定义 ACL'
}
