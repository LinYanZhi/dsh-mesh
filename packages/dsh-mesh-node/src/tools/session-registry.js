// @generated 2026-11-23 P1：直读会话/定时任务工具（只读）
// [why] 跨机委托前，发起方 dsh 需要能直接回答：目标机哪些会话在跑、最近活跃、
//       哪些被定时任务管理；不应为了看一眼元数据就新建对端会话。工具只调用
//       host bridge + schedule.json，不创建/注入/修改任何会话。
import { z } from 'zod'
import { collectScheduleLinks, collectSchedules, collectSessions } from '../core/session-registry.js'
import { fail, ok } from '../core/result.js'

const instanceSchema = z
  .string()
  .max(40)
  .optional()
  .describe('Local DSH instance id (dsh0 / dsh1 / …), or "all" for every enabled instance. Default: all.')

function registryError(error) {
  if (error?.code === 'E_UNKNOWN_INSTANCE' || error?.code === 'E_INVALID_ARG') {
    return fail(error.code, error.message)
  }
  return fail('E_SESSION_REGISTRY', error?.message || String(error))
}

export function buildSessionRegistry(ctx) {
  return [
    {
      name: 'sessions_list',
      title: 'List DSH sessions with freshness and schedule links (read-only)',
      description:
        'Read session metadata directly on THIS machine: sessionId, title, cwd, state, running, lastActivityAt, and whether the session owns scheduled tasks. Sort is always freshness (newest first). Filters: running (a turn is executing), scheduled/protected (owned by at least one scheduled task). Read-only; no session creation, prompt injection or writes. ACL: sessions_list.',
      inputSchema: z.object({
        instance: instanceSchema,
        filter: z.enum(['all', 'running', 'scheduled', 'protected']).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum sessions after filtering (default 50).'),
        includeEnded: z.boolean().optional().describe('Include stored sessions with no live agent (default true).'),
        workspace: z.string().max(500).optional().describe('Only sessions whose cwd contains this path.')
      }),
      handler: async (args = {}) => {
        try {
          const data = await collectSessions(ctx, {
            instance: args.instance,
            filter: args.filter || 'all',
            limit: args.limit,
            includeEnded: args.includeEnded !== false,
            workspace: args.workspace || ''
          })
          return ok({ ...data, filter: args.filter || 'all', readOnly: true })
        } catch (error) {
          return registryError(error)
        }
      }
    },
    {
      name: 'sessions_running',
      title: 'List currently running DSH sessions (read-only)',
      description:
        'Shortcut for sessions_list with filter=running: sessions whose agent turn is executing right now. Read-only; ACL: sessions_running.',
      inputSchema: z.object({
        instance: instanceSchema,
        limit: z.number().int().min(1).max(200).optional()
      }),
      handler: async (args = {}) => {
        try {
          const data = await collectSessions(ctx, {
            instance: args.instance,
            filter: 'running',
            limit: args.limit,
            includeEnded: false
          })
          return ok({ ...data, filter: 'running', readOnly: true })
        } catch (error) {
          return registryError(error)
        }
      }
    },
    {
      name: 'schedules_list',
      title: 'List DSH scheduled tasks and their session bindings (read-only)',
      description:
        'Read schedule metadata from THIS machine: taskId, title, kind, status, nextRunAt, lastRunAt and the sessionIds it manages. Prompts and delivery history are intentionally omitted. Read-only. ACL: schedules_list.',
      inputSchema: z.object({ instance: instanceSchema }),
      handler: async (args = {}) => {
        try {
          const data = collectSchedules(ctx.getConfig(), { instance: args.instance })
          return ok({ ...data, readOnly: true })
        } catch (error) {
          return registryError(error)
        }
      }
    },
    {
      name: 'session_schedule_links',
      title: 'Map DSH sessions to scheduled tasks (read-only)',
      description:
        'Return sessionId -> scheduled task metadata links for this machine. Useful before delegating: a protected session owns a schedule and must not be injected into without explicit intent. Read-only. ACL: session_schedule_links.',
      inputSchema: z.object({ instance: instanceSchema }),
      handler: async (args = {}) => {
        try {
          const data = collectScheduleLinks(ctx.getConfig(), { instance: args.instance })
          return ok({ ...data, readOnly: true })
        } catch (error) {
          return registryError(error)
        }
      }
    }
  ]
}
