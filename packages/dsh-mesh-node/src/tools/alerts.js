// @generated 2026-10-27 P2：mesh_alert（查看/清除本机「当前告警」指针）
// [why] 告警写进 <mesh home>/ALERT.json 后，只能本机跑 `mesh-health --clear-alert` 清；
//       加一个 mesh 工具就能远程清（例如家里/peer-x 上残留的旧告警），历史 alerts.jsonl 默认保留。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { fail, ok } from '../core/result.js'

function alertPaths(home) {
  return { state: join(home, 'ALERT.json'), history: join(home, 'alerts.jsonl') }
}

function readLatest(state) {
  try {
    const parsed = JSON.parse(readFileSync(state, 'utf8'))
    return parsed && parsed.at ? parsed : null
  } catch {
    return null
  }
}

export function buildAlerts(ctx) {
  return [
    {
      name: 'mesh_alert',
      title: 'Inspect or clear this node active alert',
      description:
        'Read the latest alert (ALERT.json) plus the last 10 entries of alerts.jsonl, or clear the "active alert" pointer so mesh-health stops showing it (history is kept unless keepHistory:false). status is read-only; clear requires confirm:true. Use it after verifying a recovered incident.',
      inputSchema: z.object({
        op: z.enum(['status', 'clear']).describe('status = read; clear = reset the active-alert pointer'),
        confirm: z.boolean().optional().describe('clear requires true'),
        keepHistory: z.boolean().optional().describe('clear: keep alerts.jsonl history (default true; false truncates it)')
      }),
      handler: async ({ op, confirm, keepHistory }) => {
        const { state, history } = alertPaths(ctx.home)
        if (op === 'status') {
          let recent = []
          try {
            recent = readFileSync(history, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .slice(-10)
              .map((line) => {
                try {
                  return JSON.parse(line)
                } catch {
                  return { raw: line.slice(0, 200) }
                }
              })
          } catch {
            /* no history yet */
          }
          return ok({ latest: readLatest(state), recentCount: recent.length, recent, paths: { state, history } })
        }
        if (op === 'clear') {
          if (confirm !== true) return fail('E_INVALID_ARG', 'clear requires confirm:true')
          const previous = readLatest(state)
          try {
            mkdirSync(ctx.home, { recursive: true })
            writeFileSync(state, '{}\n', 'utf8')
          } catch (error) {
            return fail('E_WRITE', `cannot clear active alert: ${error?.message || error}`)
          }
          let historyTruncated = false
          if (keepHistory === false) {
            try {
              writeFileSync(history, '', 'utf8')
              historyTruncated = true
            } catch {
              /* keep history on failure */
            }
          }
          return ok({ cleared: Boolean(previous), previous, keptHistory: !historyTruncated, historyTruncated })
        }
        return fail('E_INVALID_ARG', 'op must be status|clear')
      }
    }
  ]
}
