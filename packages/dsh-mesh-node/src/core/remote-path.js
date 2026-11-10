// @generated 平台无关的「对端路径」拼接 / 取父目录（src 与 scripts 共用）
// [why] 2026-11-10：peer-inspect.mjs 用本机 `node:path.dirname` 推导对端用户目录。调用方可能是 Linux
//   （手机 proot 里的 node），对端路径却是 Windows（`C:\Users\<user>\.dsh-mesh`）——
//   posix dirname 把整串当成一个文件名，返回 `.`，于是拼出相对路径 `.dsh0/storages/workspace.json`，
//   被对端按 mesh server 的 cwd 解析成 `...\Code\dsh-mesh\.dsh0\storages\workspace.json` → E_NOT_FOUND。
//   对端路径的分隔符由**对端平台**决定，不能交给本机 path 模块；这里只用字符串处理，`/` 和 `\` 都支持。
//   2026-11-10 batch2（B5）：从 scripts/lib/remote-path.mjs 提升到 src/core，供 src/tools/cluster.js 等共用；
//   scripts/lib/remote-path.mjs 只做 re-export，保持既有 import 不变。

/** 探测一串路径使用的分隔符：出现反斜杠按 Windows 处理，否则按 POSIX。 */
function sepOf(p) {
  return String(p ?? '').includes('\\') ? '\\' : '/'
}

/**
 * 平台无关的取父目录。
 * `C:\Users\<user>\.dsh-mesh` → `C:\Users\<user>`
 * `/root/.dsh-mesh` → `/root`；`C:\` → `C:\`；`/` → `/`
 * 没有分隔符的单段（相对名）原样返回——调用方只应对绝对路径使用它。
 * @param {string} p 路径（对端风格，`/` 或 `\` 均可）
 * @returns {string} 父目录
 */
export function parentDir(p) {
  const s = String(p ?? '')
  if (!s) return ''
  const trimmed = s.replace(/[\\/]+$/, '')
  if (!trimmed) return s[0]
  const m = /^(.*)[\\/][^\\/]*$/.exec(trimmed)
  if (!m) {
    // 单段：盘符（C:）要补回分隔符，相对名原样返回
    return /^[A-Za-z]:$/.test(trimmed) ? trimmed + sepOf(s) : trimmed
  }
  if (/^[A-Za-z]:$/.test(m[1])) return m[1] + sepOf(s)
  return m[1] || sepOf(s)
}

/**
 * 平台无关拼接：分隔符跟随 base（base 含反斜杠就用 `\`），避免在本机用错分隔符拼出相对路径。
 * `joinRemote('C:\\Users\\Administrator', '.dsh0', 'storages')` → `C:\Users\<user>\.dsh0\storages`
 * @param {string} base 基准目录
 * @param {...string} parts 追加的路径段
 * @returns {string} 拼接结果
 */
export function joinRemote(base, ...parts) {
  const sep = sepOf(base)
  let out = String(base ?? '').replace(/[\\/]+$/, '')
  for (const part of parts) {
    const p = String(part ?? '').replace(/^[\\/]+|[\\/]+$/g, '')
    if (!p) continue
    out = out ? `${out}${sep}${p}` : p
  }
  return out || sep
}
