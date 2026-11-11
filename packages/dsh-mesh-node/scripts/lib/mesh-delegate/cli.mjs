// @generated mesh-delegate/cli: 子命令分发（薄壳）
// 纯搬移自 scripts/mesh-delegate.mjs（2026-10-25 拆分）：入口仍是 scripts/mesh-delegate.mjs，
// 它只 import 本文件的 main()，所以文档/脚本/委托里写的入口路径保持不变。
import { arg } from './common.mjs'
import { delegate } from './delegate.mjs'
import { status, reply, cancel, gc, list } from './tasks.mjs'
import { sessions, history, gcStale, overview } from './inspect.mjs'

const USAGE = [
  'usage: node scripts/mesh-delegate.mjs delegate --to company [--policy new|continue|auto] [--conversation C-...] [--session <id>] [--instance dsh0|dsh1] [--workspace <cwd>] [--title <名称>] [--dedicated] [--force] [--dry-run] --goal-file goal.txt [--wait 120] [--stall-after 300]',
  '       --title <名称> 由发起方 AI 自拟标题（自动加 "[委托] " 前缀并锁定，防止 DSH 自动重命名；不传则用 goal 首行兜底）',
  '       default policy=new → creates a fresh DSH conversation; continue reuses the conversation session; --session pins an exact live session',
  '       node scripts/mesh-delegate.mjs sessions --to company [--instance dsh0|dsh1] [--workspace <path>] [--no-ended] [--limit 50] [--only-safe]   # peer conversations + delegation safety classification',
  '       node scripts/mesh-delegate.mjs overview                     one-screen nodes/instances/tasks overview',
  '       node scripts/mesh-delegate.mjs history --to company --session session-... [--instance dsh0] [--limit 30] [--via session-...] [--wait 180]   # peer AI dumps one session transcript (read-only, no ACL change)',
  '       node scripts/mesh-delegate.mjs gc-stale --to company [--older-than 3600] [--apply]',
  '       node scripts/mesh-delegate.mjs status [T-...] [--wait 120] [--stall-after 300]',
  '       node scripts/mesh-delegate.mjs reply T-... --text-file answer.txt',
  '       node scripts/mesh-delegate.mjs cancel T-... [--reason-file r.txt]   # 直接 abort 目标会话当前轮（对端 mesh/插件需新版；旧版仅注入停止请求）',
  '       node scripts/mesh-delegate.mjs list | gc [--days 7]'
]

export async function main() {
  const command = process.argv[2] || 'list'
  try {
    let code = 0
    if (command === 'delegate') code = await delegate()
    else if (command === 'status') code = await status(process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined, Number(arg('wait', 0)))
    else if (command === 'reply') code = await reply()
    else if (command === 'cancel') code = await cancel()
    else if (command === 'sessions') code = await sessions()
    else if (command === 'history') code = await history()
    else if (command === 'overview') code = await overview()
    else if (command === 'gc-stale') code = await gcStale()
    else if (command === 'list') code = list()
    else if (command === 'gc') code = gc()
    else {
      for (const line of USAGE) console.error(line)
      code = 1
    }
    return code
  } catch (error) {
    console.error(`mesh-delegate: ${error?.message || error}`)
    return 1
  }
}
