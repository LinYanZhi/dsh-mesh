import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createHostClient, hostInstances } from '../core/host-agent.js'
import { buildSessionProfile, classifySession, sessionBlock } from '../core/session-profile.js'
import { fail, ok } from '../core/result.js'
// 2026-11-06：MCP 委托也要写 delegations.json 台账（此前只有 CLI 写 → 台账漏记，审计失真）
import { instanceName, updateRegistry } from '../../scripts/lib/mesh-delegate/common.mjs'

/**
 * MCP-native delegation (M8.5). These tools run on the machine being delegated
 * TO: a peer AI calls `delegate` with a goal, this node picks a local DSH
 * session, injects a task envelope via the host bridge, and the peer polls
 * `delegate_status` / answers `delegate_reply`. No cookie, no shell.
 *
 * Task files live in `<fsRoot>/.mesh/tasks/<taskId>/` so the peer can also read
 * them with fs_read; the local AI writes status.json / result.json there.
 */

const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Preset the fresh session is composed from when the caller names none.
 *
 * DSH >= 0.2.0 composes an agent from an agent preset, and `standard` is the
 * built-in default the web UI itself sends. Creating a session WITHOUT a preset
 * leaves the composition scope unset, which `@deepseek-ai/dsh-tool-subagent`
 * rejects with "standing `modelSelectionSettings` requires a scoped preset
 * Context" — that is what broke every fresh-session delegation before this
 * default existed (observed on a peer node, mesh 0.17.0).
 */
export const DEFAULT_AGENT_PRESET = 'standard'

function localRoot(config) {
  const root = config?.acl?.fsRoots?.[0]
  if (!root) throw new Error('config.acl.fsRoots[0] is required for delegate tools')
  return root
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function taskAge(status, taskId) {
  const match = /^T-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(String(taskId || ''))
  const idTime = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).getTime()
    : 0
  const statusTime = Date.parse(status?.updatedAt || '') || 0
  const updatedMs = statusTime || idTime || 0
  return {
    updatedMs,
    ageSeconds: updatedMs ? Math.round((Date.now() - updatedMs) / 1000) : null
  }
}

function taskPaths(root, taskId) {
  const dir = join(root, '.mesh', 'tasks', taskId)
  return { dir, request: join(dir, 'request.json'), status: join(dir, 'status.json'), result: join(dir, 'result.json') }
}

/**
 * 2026-11-06：防「长任务被误判失败 → 重复委托 → 重复执行」。
 * 扫本地 .mesh/tasks：同一 goal（trim 后严格相等）、未终态、30 分钟内 → 视为重复，返回已有任务。
 * 发起方在等 10+ 分钟长任务时若重派同一 goal，会在这里被挡住（force:true 可强制新建）。
 */
function findRecentDuplicateTask(root, goalText, withinMs = 30 * 60 * 1000) {
  const dir = join(root, '.mesh', 'tasks')
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const text = String(goalText || '').trim()
  if (!text) return null
  const nowMs = Date.now()
  for (const id of names) {
    const base = join(dir, id)
    const request = readJson(join(base, 'request.json'), null)
    if (!request || String(request.goal || '').trim() !== text) continue
    const status = readJson(join(base, 'status.json'), null)
    const state = status?.state || 'submitted'
    if (TERMINAL.has(state)) continue
    const at = Date.parse(request.requestedAt || '') || 0
    if (at && nowMs - at > withinMs) continue
    return { taskId: request.taskId || id, conversationId: request.conversationId || '', sessionId: request.sessionId || '', state }
  }
  return null
}

function requestText(task, root) {
  return `[dsh-mesh delegation]
taskId=${task.taskId}
conversationId=${task.conversationId}
from=${task.from || 'peer'}
policy=${task.policy}

请求内容：
${JSON.stringify(
    { taskId: task.taskId, conversationId: task.conversationId, from: task.from || 'peer', workspace: task.workspace || '', goal: task.goal, scope: task.scope, acceptance: task.acceptance },
    null,
    2
  )}

1) 可选：读请求原文（只读）：${task.paths.request}
2) 按 goal / scope / acceptance 执行。
3) 状态写到：${task.paths.status}
   形如 {"taskId":"${task.taskId}","state":"accepted|working|question|done|failed","question":"...","error":"...","summary":"...","heartbeatAt":"ISO"}
   完成时再写 ${task.paths.result}（JSON，含证据/产物路径）。
4) 长任务每 30~60 秒更新一次 status.json（至少 heartbeatAt）。
5) 需要澄清：写 state=question + question 字段后停止；协调者会 reply 并唤醒本会话继续。
6) 不要 kill 进程、不要 push、不要改无关文件。`
}

function sessionSeq(agents, sessionId) {
  const row = (agents || []).find((agent) => agent.id === sessionId)
  return row ? { seq: row.seq ?? 0, status: row.status || 'unknown' } : null
}

/**
 * A prompt is only *admitted* into the agent inbox. If the instance's runtime or
 * model is unhealthy the agent can accept the prompt and never start a turn,
 * leaving the coordinator polling "submitted" forever. Watch seq/status briefly
 * and surface a warning instead of silently reporting success.
 */
async function confirmFreshSessionStarted(client, sessionId, baselineSeq, { timeoutMs = 3000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = sessionSeq((await client.agents())?.agents, sessionId)
    } catch {
      /* transient host bridge hiccup — keep polling */
    }
    if (last && (last.seq > baselineSeq || last.status === 'running')) {
      return { started: true, seq: last.seq, status: last.status }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { started: false, seq: last?.seq ?? baselineSeq, status: last?.status || 'unknown', timeoutMs }
}

async function listAgents(ctx) {
  const config = ctx.getConfig()
  const rows = []
  for (const entry of hostInstances(config)) {
    if (entry.enabled === false) continue
    try {
      const client = createHostClient({ config, home: ctx.home, log: ctx.log, instance: entry.id })
      try {
        const listed = await client.sessions({ limit: 200, includeEnded: false })
        for (const session of listed.sessions || []) {
          if (session.agentAvailable !== true) continue
          rows.push({
            instance: entry.id,
            id: session.sessionId,
            status: session.state === 'working' ? 'running' : 'idle',
            title: session.title || '',
            cwd: session.cwd || '',
            seq: 0,
            updatedAt: session.updatedAt || 0
          })
        }
        continue
      } catch {
        /* old fork or session service unavailable: fall back to live agents */
      }
      const { agents } = await client.agents()
      for (const agent of agents || []) rows.push({ instance: entry.id, id: agent.id, status: agent.status, title: agent.title || '', cwd: agent.cwd || '', seq: agent.seq || 0, updatedAt: 0 })
    } catch {
      /* instance offline: keep looking */
    }
  }
  return rows
}

async function listSessionRows(ctx, { includeEnded = true, workspace = '' } = {}) {
  const config = ctx.getConfig()
  const rows = []
  for (const entry of hostInstances(config)) {
    if (entry.enabled === false) continue
    try {
      const client = createHostClient({ config, home: ctx.home, log: ctx.log, instance: entry.id })
      const listed = await client.sessions({ limit: 200, includeEnded, workspace })
      for (const session of listed.sessions || []) rows.push({ instance: entry.id, ...session })
    } catch (error) {
      rows.push({ instance: entry.id, error: String(error?.message || error) })
    }
  }
  return rows
}

async function pickSession(ctx, sessionId, workspace) {
  const agents = await listAgents(ctx)
  const norm = (value) => String(value || '').toLowerCase().replace(/\\/g, '/')
  const pool = workspace ? agents.filter((agent) => norm(agent.cwd).includes(norm(workspace))) : agents
  if (workspace && pool.length === 0) {
    throw new Error(`no live session with workspace ${workspace} on this node — available: ${agents.map((agent) => agent.cwd || '?').join(', ') || '(none)'}`)
  }
  if (sessionId) {
    const found = pool.find((agent) => agent.id === sessionId)
    if (!found) throw new Error(`session not alive on this node: ${sessionId}`)
    return found
  }
  const idle = pool.find((agent) => agent.status === 'idle') || pool[0]
  if (!idle) throw new Error('no idle DSH session on this node — start one first')
  return idle
}

function hostError(error) {
  return fail('E_DELEGATE', error?.message || String(error), { retryable: false })
}

export function buildDelegate(ctx) {
  return [
    {
      name: 'delegate',
      title: 'Hand a task to this machine\u2019s AI',
      description:
        'Create a delegation task on this machine and deliver it to a DSH conversation. Default: creates a FRESH DSH session (clean context, same as opening a new chat) on the chosen instance and prompts it there. Pass sessionId (returned by a previous delegate) to CONTINUE that exact conversation instead — use that for long tasks that must keep their context. Returns taskId / conversationId / sessionId immediately; poll with delegate_status and answer questions with delegate_reply. Duplicate guard (2026-11-06): if the SAME goal already has a non-terminal task on this node within 30 min, returns { deduped: true, taskId } instead of starting a second copy — use force:true only when you really want two parallel runs. No DSH cookie, no shell, no cross-machine write.',
      inputSchema: z.object({
        goal: z.string().min(1).max(8000).describe('What the local AI should do.'),
        scope: z.string().max(4000).optional().describe('Files/repos/actions allowed (optional).'),
        acceptance: z.string().max(4000).optional().describe('How to verify the result (optional).'),
        conversationId: z.string().max(120).optional().describe('Reuse a conversation id; defaults to a new one.'),
        sessionId: z.string().optional().describe('Continue THIS live DSH session (from an earlier delegate response or delegate_candidates). Omit to start a fresh conversation.'),
        force: z
          .boolean()
          .optional()
          .describe('Allow continuing a session that owns scheduled tasks (default false: those are refused because a delegation would pollute the scheduled conversation).'),
        instance: z.string().optional().describe('Local DSH instance id for a fresh conversation (default: first enabled instance).'),
        workspace: z.string().max(1000).optional().describe('For a fresh conversation: cwd/workspace of the new session (repo path). For a continuation: unused.'),
        agentPreset: z
          .string()
          .max(200)
          .optional()
          .describe(`Agent preset id the fresh session is composed from (default: ${DEFAULT_AGENT_PRESET}). Ignored for a continuation.`)
      }),
      handler: async ({ goal, scope, acceptance, conversationId, sessionId, instance, workspace, force, agentPreset }) => {
        try {
          const config = ctx.getConfig()
          const root = localRoot(config)
          // 2026-11-06：同一 goal 已有未终态任务 → 直接复用，避免长任务被误判失败后重复投递
          if (force !== true) {
            const duplicate = findRecentDuplicateTask(root, goal)
            if (duplicate) {
              return ok({
                deduped: true,
                taskId: duplicate.taskId,
                conversationId: duplicate.conversationId,
                sessionId: duplicate.sessionId,
                state: duplicate.state,
                note: '同一 goal 已有未终态任务（可能只是长任务还没写 status.json）。请用 delegate_status 轮询这个 taskId，不要重复委托；确实要并行另开一份才传 force:true'
              })
            }
          }
          const instances = hostInstances(config).filter((entry) => entry.enabled !== false)
          if (instances.length === 0) throw new Error('no host bridge configured (config.hosts is empty)')
          const norm = (value) => String(value || '').toLowerCase().replace(/\\/g, '/')
          let chosen
          let created = false
          let createdBaselineSeq = 0
          if (sessionId) {
            const blocked = sessionBlock(buildSessionProfile(config), sessionId)
            if (blocked && force !== true) return fail('E_SESSION_PROTECTED', blocked.reason, blocked)
            const agents = await listAgents(ctx)
            const found = agents.find((agent) => agent.id === sessionId)
            if (!found) {
              throw new Error(`session not alive on this node: ${sessionId} — a continuation needs a live session; check delegate_candidates (pass sessionId exactly as returned by delegate)`)
            }
            chosen = found
          } else {
            const wanted = instance
              ? instances.find((entry) => entry.id === instance)
              : instances[0]
            if (!wanted) {
              throw new Error(`unknown DSH instance "${instance}" — configured: ${instances.map((entry) => entry.id).join(', ')}`)
            }
            const client = createHostClient({ config, home: ctx.home, log: ctx.log, instance: wanted.id })
            const cwd = workspace ? workspace : undefined
            const preset = agentPreset || DEFAULT_AGENT_PRESET
            const createdSession = await client.createSession({ cwd, agentPreset: preset })
            if (!createdSession?.sessionId) {
              throw new Error(`host bridge did not return a sessionId (plugin too old? need dsh-mesh-host >= 0.2.0): ${JSON.stringify(createdSession)}`)
            }
            createdBaselineSeq = 0
            try {
              createdBaselineSeq = sessionSeq((await client.agents())?.agents, createdSession.sessionId)?.seq ?? 0
            } catch {
              /* baseline is advisory */
            }
            chosen = {
              id: createdSession.sessionId,
              instance: wanted.id,
              status: 'idle',
              cwd: workspace || ''
            }
            created = true
          }
          const taskId = `T-${stamp()}-${randomUUID().slice(0, 4)}`
          const convId = conversationId || `C-${stamp()}-${randomUUID().slice(0, 4)}`
          const task = {
            taskId,
            conversationId: convId,
            from: ctx.peerId || 'peer',
            policy: created ? 'new' : 'continue',
            // 2026-11-06：MCP 无 policy 参数 —— 传 sessionId 即"发起方请求 continue"，否则 new
            requestedPolicy: sessionId ? 'continue' : 'new',
            policySource: sessionId ? 'session' : 'default',
            node: (config?.node?.name) || 'local',
            sessionId: chosen.id,
            instance: chosen.instance,
            workspace: chosen.cwd || '',
            state: 'submitted',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: 'mcp',
            goal,
            scope: scope || '',
            acceptance: acceptance || '',
            paths: {}
          }
          task.paths = taskPaths(root, taskId)
          writeJson(task.paths.request, {
            taskId,
            conversationId: convId,
            from: task.from,
            workspace: task.workspace,
            goal,
            scope: task.scope,
            acceptance: task.acceptance,
            sessionId: chosen.id,
            instance: chosen.instance,
            sessionPolicy: task.policy,
            createdSession: created,
            seqBaseline: createdBaselineSeq,
            requestedAt: new Date().toISOString()
          })
          // 2026-11-06：补写 delegations.json 台账（与 CLI 同一份文件，锁 + 原子写；失败不影响投递）
          try {
            updateRegistry((data) => {
              data.tasks = data.tasks || {}
              data.conversations = data.conversations || {}
              const existing = data.conversations[convId]
              data.tasks[taskId] = task
              data.conversations[convId] = {
                conversationId: convId,
                node: task.node,
                dedicated: false,
                sessionId: chosen.id,
                instance: chosen.instance,
                activeTask: taskId,
                createdAt: existing?.createdAt || task.createdAt,
                lastActiveAt: task.createdAt,
                tasks: [...(existing?.tasks || []), taskId]
              }
              return data
            }, ctx.home)
          } catch (error) {
            try {
              ctx.log?.warn?.(`delegate registry write failed (task continues): ${error?.message || error}`)
            } catch {
              /* logging must not break delivery */
            }
          }
          const client = createHostClient({ config, home: ctx.home, log: ctx.log, instance: chosen.instance })
          const text = requestText(task, root)
          // A brand-new session has an agent but no running turn: wake() only drops a
          // message into the inbox, which a dormant agent never reads. prompt() drives
          // the first turn. Live sessions keep using wake().
          const delivery = created
            ? { kind: 'prompt', ...(await client.prompt({ sessionId: chosen.id, text, mode: 'queue' })) }
            : { kind: 'wake', ...(await client.wake({ sessionId: chosen.id, text, target: 'next-turn' })) }
          let verification
          if (created) {
            verification = await confirmFreshSessionStarted(client, chosen.id, createdBaselineSeq)
            if (!verification.started) {
              delivery.warning = `prompt accepted, but the agent did not start a turn within ${verification.timeoutMs}ms (status=${verification.status}, seq=${verification.seq}). Check this instance's runtime/model health (e.g. provider error) — the session exists and can be continued later.`
            }
          }
          return ok({
            taskId,
            conversationId: convId,
            sessionId: chosen.id,
            instance: chosen.instance,
            createdSession: created,
            workspace: chosen.cwd || '',
            requestPath: task.paths.request,
            delivery,
            ...(verification ? { verification } : {}),
            ...(created ? { prompt: delivery } : { wake: delivery })
          })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'delegate_candidates',
      title: 'List sessions eligible for delegation on this machine',
      description:
        'Read-only candidate list before delegating: every live/stored DSH session with instance, title, cwd (workspace), state (working|idle|ended), running, agentAvailable, delegatable and recommended flags. Each row also carries kind (delegation | business-scheduled | business | unknown), protected (owns scheduled tasks — never delegate here), reason and schedules/delegation evidence, so a peer can tell its own delegation sessions apart from the local business ones. Ended sessions are visible but not delegatable; use workspace to narrow by repo.',
      inputSchema: z.object({
        instance: z.string().optional().describe('Local DSH instance id (default: all).'),
        workspace: z.string().max(500).optional().describe('Only sessions whose cwd contains this path.'),
        includeEnded: z.boolean().optional().describe('Include stored sessions with no live agent (default true).'),
        limit: z.number().int().min(1).max(200).optional()
      }),
      handler: async ({ instance, workspace = '', includeEnded = true, limit = 50 }) => {
        try {
          const rows = await listSessionRows(ctx, { includeEnded, workspace })
          const profile = buildSessionProfile(ctx.getConfig())
          const filtered = instance ? rows.filter((row) => row.instance === instance) : rows
          const sessions = filtered.slice(0, limit).map((session) => {
            if (session.error) {
              return { ...session, kind: 'unknown', protected: false, delegatable: false, recommended: false, reason: String(session.error), schedules: [], delegation: null }
            }
            return { ...session, ...classifySession(profile, session) }
          })
          return ok({ count: sessions.length, protectedCount: sessions.filter((row) => row.protected === true).length, sessions })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'delegate_status',
      title: 'Poll a delegation task on this machine',
      description:
        'Read status.json / result.json of a local delegation task. `waitSec` (0-60) polls until the task is done/failed or a question appears. Returns notFailed/advice — a long task may take 10+ minutes and “stalled” only means status.json has not been updated recently; it is NOT a failure, so do not re-delegate the same goal. Read-only.',
      inputSchema: z.object({
        taskId: z.string().describe('Task id returned by delegate.'),
        waitSec: z.number().int().min(0).max(60).optional().describe('Seconds to poll (default 0).')
      }),
      handler: async ({ taskId, waitSec = 0 }) => {
        try {
          const root = localRoot(ctx.getConfig())
          const paths = taskPaths(root, taskId)
          if (!existsSync(paths.request)) return fail('E_NOT_FOUND', `unknown taskId: ${taskId}`)
          const deadline = Date.now() + waitSec * 1000
          const request = readJson(paths.request, null)
          let state = readJson(paths.status, null)
          while (!state && Date.now() < deadline) {
            await sleep(1000)
            state = readJson(paths.status, null)
          }
          while (state && !TERMINAL.has(state.state) && state.state !== 'question' && Date.now() < deadline) {
            await sleep(1000)
            state = readJson(paths.status, null) || state
          }
          // Some agents finish the turn without writing status.json (e.g. a reply-only
          // goal). Derive what really happened from the live agent instead of
          // reporting "submitted" forever.
          let derived = null
          if (!state && request?.sessionId) {
            try {
              // Query only the task's own instance: aggregating every instance can
              // stall on an unrelated bridge and turn a cheap status poll into a timeout.
              const config = ctx.getConfig()
              const targetInstance = request.instance || hostInstances(config)[0]?.id
              const client = createHostClient({ config, home: ctx.home, log: ctx.log, instance: targetInstance })
              const agents = (await client.agents())?.agents || []
              const found = agents.find((agent) => agent.id === request.sessionId)
              const baseline = Number(request.seqBaseline) || 0
              if (!found) {
                derived = { state: 'unknown', note: 'the delegated session is no longer live on this node' }
              } else if (found.status === 'running') {
                derived = { state: 'working', note: 'the delegated agent is running; it has not written status.json yet' }
              } else if ((found.seq ?? 0) > baseline) {
                derived = {
                  state: 'unreported',
                  note: 'the delegated agent finished its turn but wrote no status.json — read the reply in that session (sessionId above); ask it to write status.json/result.json for structured reporting'
                }
              }
            } catch {
              /* fall back to submitted */
            }
          }
          // 2026-11-06：长任务（10+ 分钟）常见"status.json 很久没更新"，这里显式给出
          // ageSeconds / stalled / notFailed / advice，避免发起方把它当失败而重复委托。
          let ageSeconds = null
          try {
            ageSeconds = Math.round((Date.now() - statSync(paths.status).mtimeMs) / 1000)
          } catch {
            ageSeconds = null
          }
          const effectiveState = state?.state || derived?.state || 'submitted'
          const runningLike = ['submitted', 'accepted', 'working', 'stalled', 'unknown', 'unreported'].includes(effectiveState)
          const stalled = Boolean(runningLike && ageSeconds !== null && ageSeconds > 900)
          return ok({
            taskId,
            state: effectiveState,
            question: state?.question || '',
            error: state?.error || '',
            summary: state?.summary || '',
            note: state?.note || derived?.note || '',
            ageSeconds,
            stalled,
            notFailed: runningLike,
            advice: runningLike
              ? 'still running — do NOT re-delegate the same goal; poll this taskId again later. “stalled”只表示 status.json 很久没更新（可能正在长步骤），不代表失败。'
              : '',
            result: readJson(paths.result, null)
          })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'delegate_reply',
      title: 'Answer a delegation question',
      description:
        'Send an answer to a task that reported state=question; wakes the same local session so it can continue. The task metadata is read from <fsRoot>/.mesh/tasks/<taskId>/request.json.',
      inputSchema: z.object({
        taskId: z.string().describe('Task id returned by delegate.'),
        text: z.string().min(1).max(8000).describe('Answer / clarification for the local AI.')
      }),
      handler: async ({ taskId, text }) => {
        try {
          const root = localRoot(ctx.getConfig())
          const paths = taskPaths(root, taskId)
          const request = readJson(paths.request, null)
          if (!request) return fail('E_NOT_FOUND', `unknown taskId: ${taskId}`)
          const config = ctx.getConfig()
          const agents = await listAgents(ctx)
          const found = agents.find((agent) => agent.id === request.sessionId)
          if (!found) return fail('E_SESSION_GONE', `session no longer alive: ${request.sessionId}`)
          const client = createHostClient({ config, home: ctx.home, log: ctx.log, instance: found.instance })
          const wake = await client.wake({ sessionId: found.id, text: `[dsh-mesh delegation answer]\ntaskId=${taskId}\nconversationId=${request.conversationId}\n${text}`, target: 'next-turn' })
          return ok({ taskId, sessionId: found.id, wake })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'delegate_cancel',
      title: 'Abort the running turn of a delegation task on this machine',
      description:
        'Immediately ABORT the current turn of the DSH session that owns a delegation task — no injected message, no waiting for the turn to finish. Only tasks registered on THIS node (a request.json under <fsRoot>/.mesh/tasks/<taskId>/) can be cancelled; an arbitrary sessionId is not accepted, so ordinary/business conversations cannot be stopped through this route. Marks status.json state=cancelled (result.json is kept untouched). Requires dsh-mesh-host >= 0.5.0 on this node: an older bridge answers 404 unknown endpoint and the call fails with E_HOST_NO_CANCEL — there is no silent fallback to archive/channel_wake.',
      inputSchema: z
        .object({
          taskId: z.string().min(1).describe('Task id of a delegation task registered on this node (returned by delegate).'),
          reason: z.string().max(2000).optional().describe('Why it is cancelled; recorded in status.json.')
        })
        // Reject an attempt to name a session instead of a task outright: only the
        // request.json registration may select the session to abort.
        .strict(),
      handler: async ({ taskId, reason = '' }) => {
        try {
          const config = ctx.getConfig()
          const root = localRoot(config)
          const paths = taskPaths(root, taskId)
          if (!existsSync(paths.request)) {
            return fail('E_NOT_FOUND', `unknown taskId: ${taskId} — no request.json under ${join(root, '.mesh', 'tasks')}; only delegation tasks registered on this node can be cancelled here`)
          }
          const request = readJson(paths.request, null)
          if (!request) return fail('E_NOT_FOUND', `request.json is unreadable: ${paths.request}`)
          const status = readJson(paths.status, null) || {}
          const state = status.state || 'submitted'
          if (state === 'cancelled') {
            return ok({
              ok: true,
              taskId,
              sessionId: String(request.sessionId || ''),
              cancelled: true,
              already: true,
              state,
              via: 'host/sessions/cancel',
              note: 'status.json already says cancelled — nothing was aborted again'
            })
          }
          if (TERMINAL.has(state)) {
            return fail('E_TASK_TERMINAL', `task ${taskId} is already ${state} (terminal) — it cannot be cancelled`, { state })
          }
          const sessionId = String(request.sessionId || '')
          if (!sessionId) return fail('E_TASK_NO_SESSION', `task ${taskId} carries no sessionId in request.json — there is no session to abort`)
          const client = createHostClient({ config, home: ctx.home, log: ctx.log, instance: request.instance || undefined })
          let cancelResult
          try {
            cancelResult = await client.cancelSession({ sessionId })
          } catch (error) {
            const code = String(error?.code || '')
            const message = String(error?.message || error)
            // Old bridge = route absent: 404 + "unknown endpoint". Surface an upgrade
            // error; a channel_wake fallback would only queue text behind the turn.
            if (code === 'E_NOT_FOUND' && /unknown endpoint/i.test(message)) {
              return fail('E_HOST_NO_CANCEL', `host bridge has no /host/sessions/cancel (${message})`, {
                hint: '对端 dsh-mesh-host < 0.5.0 需升级：在目标节点执行 node scripts/self-update.mjs apply-local --instance <id>，等插件热更新后重试'
              })
            }
            if (code === 'E_HOST_CANCEL') {
              return fail('E_SESSION_GONE', `the delegated session is no longer live on this node: ${sessionId}`, {
                sessionId,
                hint: '实例重启或会话已结束：任务状态未改，请用 delegate_status 确认实际状态'
              })
            }
            return fail(code || 'E_HOST_CANCEL', `host bridge cancel failed: ${message}`, { sessionId })
          }
          const cancelledAt = new Date().toISOString()
          const cancelledBy = ctx.peerId || 'local'
          const wasRunning = cancelResult?.wasRunning === true
          writeJson(paths.status, {
            ...status,
            state: 'cancelled',
            previousState: state,
            cancelledAt,
            cancelledBy,
            cancelVia: 'host/sessions/cancel',
            cancelReason: String(reason || ''),
            wasRunning,
            summary: `[cancel] 委托会话当前轮已直接中止（by ${cancelledBy}）`,
            updatedAt: cancelledAt
          })
          // Keep the local ledger in step with status.json, exactly like delegate() does
          // on creation. A ledger hiccup must not undo a cancellation that already happened.
          try {
            updateRegistry((data) => {
              const existing = data.tasks?.[taskId]
              if (!existing) return data
              data.tasks[taskId] = { ...existing, state: 'cancelled', updatedAt: cancelledAt }
              const conversation = data.conversations?.[existing.conversationId]
              if (conversation) conversation.activeTask = null
              return data
            }, ctx.home)
          } catch (error) {
            try {
              ctx.log?.warn?.(`delegate_cancel registry write failed (status.json already written): ${error?.message || error}`)
            } catch {
              /* logging must not fail the cancel */
            }
          }
          return ok({
            ok: true,
            taskId,
            sessionId,
            cancelled: true,
            via: 'host/sessions/cancel',
            wasRunning,
            cancelledAt,
            cancelledBy,
            ...(wasRunning ? {} : { note: '该会话当时没有在跑的轮次（已空闲或刚结束）；任务已标记 cancelled，但没有发生真正的中断' })
          })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'delegate_list',
      title: 'List delegation tasks on this machine',
      description: 'List recent delegation task files under <fsRoot>/.mesh/tasks/ with state, workspace, sessionId, summary and stale flag. Read-only.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        state: z.string().optional().describe('Only tasks in this state (working/accepted/question/done/failed/cancelled).'),
        activeOnly: z.boolean().optional().describe('Only non-terminal tasks.')
      }),
      handler: async ({ limit = 20, state, activeOnly = false }) => {
        try {
          const root = localRoot(ctx.getConfig())
          const dir = join(root, '.mesh', 'tasks')
          if (!existsSync(dir)) return ok({ count: 0, activeCount: 0, tasks: [] })
          let tasks = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
              const paths = taskPaths(root, entry.name)
              const status = readJson(paths.status, null)
              const request = readJson(paths.request, null)
              const age = taskAge(status, entry.name)
              return {
                taskId: entry.name,
                state: status?.state || 'submitted',
                workspace: request?.workspace || '',
                sessionId: request?.sessionId || '',
                conversationId: request?.conversationId || '',
                summary: status?.summary || '',
                ageSeconds: age.ageSeconds,
                stale: (status?.staleSeconds || 0) > 300 || (age.ageSeconds !== null && age.ageSeconds > 3600),
                updatedAt: status?.updatedAt || ''
              }
            })
          if (state) tasks = tasks.filter((task) => task.state === state)
          if (activeOnly) tasks = tasks.filter((task) => !TERMINAL.has(task.state))
          tasks.sort((a, b) => {
            const rank = (task) => (TERMINAL.has(task.state) ? 2 : task.stale ? 1 : 0)
            const rankDelta = rank(a) - rank(b)
            return rankDelta !== 0 ? rankDelta : b.taskId.localeCompare(a.taskId)
          })
          const activeCount = tasks.filter((task) => !TERMINAL.has(task.state)).length
          const staleActiveCount = tasks.filter((task) => !TERMINAL.has(task.state) && task.stale).length
          return ok({ count: Math.min(tasks.length, limit), activeCount, staleActiveCount, tasks: tasks.slice(0, limit) })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'delegate_gc',
      title: 'Close stale delegation tasks on this machine',
      description:
        'Find non-terminal delegation tasks older than olderThanSeconds and optionally close them as state=cancelled with a gc summary. Default is a dry run; pass apply=true to write status.json. Read/write only under <fsRoot>/.mesh/tasks; no code, no process changes.',
      inputSchema: z.object({
        olderThanSeconds: z.number().int().min(60).max(30 * 24 * 3600).optional(),
        apply: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional()
      }),
      handler: async ({ olderThanSeconds = 3600, apply = false, limit = 50 }) => {
        try {
          const root = localRoot(ctx.getConfig())
          const dir = join(root, '.mesh', 'tasks')
          if (!existsSync(dir)) return ok({ applied: apply, count: 0, tasks: [] })
          const targets = []
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const paths = taskPaths(root, entry.name)
            const status = readJson(paths.status, null)
            const state = status?.state || 'submitted'
            if (TERMINAL.has(state)) continue
            const age = taskAge(status, entry.name)
            if (age.ageSeconds === null || age.ageSeconds < olderThanSeconds) continue
            targets.push({ taskId: entry.name, state, ageSeconds: age.ageSeconds })
          }
          const closed = []
          if (apply) {
            for (const target of targets) {
              const paths = taskPaths(root, target.taskId)
              const status = readJson(paths.status, {}) || {}
              const next = {
                ...status,
                state: 'cancelled',
                previousSummary: status.summary || '',
                summary: `[gc] closed stale task after ${target.ageSeconds}s by ${ctx.peerId || 'peer'}`,
                staleSeconds: target.ageSeconds,
                updatedAt: new Date().toISOString()
              }
              writeJson(paths.status, next)
              closed.push(target.taskId)
            }
          }
          return ok({ applied: apply, thresholdSeconds: olderThanSeconds, count: targets.length, closed, tasks: targets.slice(0, limit) })
        } catch (error) {
          return hostError(error)
        }
      }
    }
  ]
}
