import { z } from 'zod'
import { tailAudit } from '../core/audit.js'
import { TERMINAL_STATES } from '../core/jobs.js'
import { denied, invalidArg, notFound, ok } from '../core/result.js'

const BLOCKED_JOB_TARGETS = /^(task_|mesh_)/

/**
 * Async task queue. A long tool call submitted here returns a job id immediately;
 * the caller polls `task_status`. Jobs are persisted, so a dropped connection or a
 * client timeout never loses the work — and `idem` makes retries safe.
 */
export function buildTasks(ctx) {
  return [
    {
      name: 'task_submit',
      title: 'Run a long tool call asynchronously on the peer machine',
      description:
        'Submit any ACL-allowed tool (except task_* / mesh_*) as a background job and return a jobId immediately. Use this for slow operations (repo_scan, fs_grep on a big tree, shell_run) so the MCP call does not time out. Pass the same `idem` key when retrying to avoid duplicate work.',
      inputSchema: z.object({
        tool: z.string().describe('Name of the tool to run, e.g. "repo_scan".'),
        arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments for that tool.'),
        idem: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Idempotency key: submitting twice with the same key returns the original job.'),
        timeoutMs: z.number().int().min(1000).max(3600000).optional().describe('Abort the job after this long.')
      }),
      handler: async ({ tool, arguments: args, idem, timeoutMs }, meta = {}) => {
        if (!tool || typeof tool !== 'string') return invalidArg('tool is required')
        if (BLOCKED_JOB_TARGETS.test(tool)) {
          return invalidArg(`refusing to queue a job that targets "${tool}" (job/self tools are not queueable)`)
        }
        const config = ctx.getConfig()
        const known = ctx.toolNames().includes(tool)
        if (!known) return notFound(`unknown tool: ${tool}`)
        const allowed = ctx.isAllowed(config, tool)
        if (!allowed) return denied(`${tool} is not allowed by local ACL`)
        const limit = Math.min(timeoutMs ?? config.limits?.jobTimeoutMs ?? 300000, 3600000)
        const { job, idempotent } = ctx.jobs.submit({
          tool,
          arguments: args ?? {},
          idem,
          peer: meta?.peerId,
          timeoutMs: limit
        })
        return ok({
          jobId: job.id,
          state: job.state,
          idempotent,
          poll: 'task_status',
          tool,
          timeoutMs: limit
        })
      }
    },
    {
      name: 'task_status',
      title: 'Poll a background job',
      description:
        'Return one job record: state (queued|running|succeeded|failed|cancelled), timings, error and the tool result once finished. Poll this instead of re-running the tool.',
      inputSchema: z.object({ jobId: z.string().describe('Job id returned by task_submit.') }),
      handler: async ({ jobId }) => {
        const job = ctx.jobs.get(jobId)
        if (!job) return notFound(`no such job: ${jobId}`)
        const done = TERMINAL_STATES.includes(job.state)
        return ok({ ...job, done })
      }
    },
    {
      name: 'task_list',
      title: 'List background jobs',
      description: 'List recent background jobs on the peer machine, newest first, optionally filtered by state.',
      inputSchema: z.object({
        state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
        limit: z.number().int().min(1).max(100).optional()
      }),
      handler: async ({ state, limit }) => {
        const jobs = ctx.jobs.list({ state, limit: limit ?? 20 })
        return ok({ count: jobs.length, stats: ctx.jobs.stats(), jobs })
      }
    },
    {
      name: 'task_cancel',
      title: 'Cancel a background job',
      description:
        'Abort a queued or running job. Running jobs receive an abort signal (long subprocesses are killed); finished jobs cannot be cancelled.',
      inputSchema: z.object({ jobId: z.string().describe('Job id to cancel.') }),
      handler: async ({ jobId }) => {
        const result = ctx.jobs.cancel(jobId)
        if (!result.ok) {
          return result.code === 'E_NOT_FOUND'
            ? notFound(result.message)
            : invalidArg(result.message)
        }
        return ok({ cancelled: true, job: result.job })
      }
    },
    {
      name: 'mesh_audit_tail',
      title: 'Read this node audit log',
      description:
        'Return the most recent audit entries of this node (who called which tool, whether it succeeded, how long it took). Argument values are never logged, only their key names.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(400).optional(),
        tool: z.string().optional(),
        ok: z.boolean().optional()
      }),
      handler: async ({ limit, tool, ok: okFilter }) => {
        const tail = tailAudit(ctx.home, { limit: limit ?? 50, tool, ok: okFilter })
        return ok({ ...tail, jobs: ctx.jobs.stats() })
      }
    }
  ]
}
