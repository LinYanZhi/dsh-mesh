// @generated 2026-10-27 P1：session_history（远程只读导出某条 DSH 会话正文）
// [why] 以前只有两条路：① 委托对端 AI 导出（起会话、花 token、慢）；② 人跑到对端机器上用
//       my-skills 的 dsh-sessions.mjs。现在 mesh server 在目标机本地跑 scripts/session-history.mjs
//       解 zstd 会话日志 → 跨机一条命令看正文。
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { fail, ok } from '../core/result.js'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'session-history.mjs')

function homeOf(instance) {
  const id = String(instance || 'dsh0').trim()
  const match = /^dsh(\d+)$/.exec(id)
  return join(homedir(), `.dsh${match ? Number(match[1]) : 0}`)
}

export function buildSessionHistory() {
  return [
    {
      name: 'session_history',
      title: 'Read one DSH session transcript (read-only)',
      description:
        'Read the last N messages of one session log on THIS machine (decompresses the append-only zstd session log, no model round-trip). Use peer-inspect/host_sessions to find the sessionId first. Read-only; returns role/text/time/seq + title. Requires the node ACL to allow `session_history`.',
      inputSchema: z.object({
        sessionId: z.string().describe('DSH session id, e.g. session-abf88d8c-8798-43c7-a7d7-f6266bac075a'),
        instance: z.string().optional().describe('Local DSH instance whose session store to read (default dsh0 → ~/.dsh0).'),
        limit: z.number().int().min(1).max(200).optional().describe('How many trailing messages (default 40).')
      }),
      handler: async ({ sessionId, instance, limit }) => {
        const id = String(sessionId || '').trim()
        if (!/^[A-Za-z0-9._-]{8,120}$/.test(id)) return fail('E_INVALID_ARG', 'sessionId looks invalid', { sessionId: id })
        const home = homeOf(instance)
        const lines = Math.min(Math.max(Number(limit) || 40, 1), 200)
        const run = spawnSync(process.execPath, [SCRIPT, '--home', home, '--session', id, '--limit', String(lines)], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 60000
        })
        const stdout = (run.stdout || '').trim()
        if (!stdout) {
          return fail('E_HISTORY', `session-history.mjs produced no output (exit ${run.status})`, {
            stderr: (run.stderr || '').slice(-400),
            sessionId: id,
            home
          })
        }
        try {
          const parsed = JSON.parse(stdout)
          if (parsed.ok !== true) return fail(parsed.code || 'E_HISTORY', parsed.message || 'session history failed', parsed)
          return ok(parsed)
        } catch (error) {
          return fail('E_HISTORY', `cannot parse session-history output: ${error?.message || error}`, { sample: stdout.slice(0, 300) })
        }
      }
    }
  ]
}
