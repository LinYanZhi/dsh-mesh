import { z } from 'zod'
import { hardwareInfo } from '../core/hardware.js'
import { createHostClient, hostInstances, hostTokenPath, HostError } from '../core/host-agent.js'
import { buildSessionProfile, classifySession, sessionBlock } from '../core/session-profile.js'
import { fail, ok } from '../core/result.js'

const instanceSchema = z
  .string()
  .optional()
  .describe(
    'Local DSH instance id from host_instances (default: the first enabled instance, usually dsh0).'
  )

function hostClient(ctx, instance) {
  return createHostClient({ config: ctx.getConfig(), home: ctx.home, log: ctx.log, instance })
}

/**
 * Refuse to inject into a session that owns scheduled tasks (delegation
 * pollution guard, 2026-10-25). Returns null when the target is safe.
 */
function guardScheduleSession(ctx, sessionId, force) {
  if (!sessionId || force === true) return null
  const block = sessionBlock(buildSessionProfile(ctx.getConfig()), sessionId)
  return block ? fail('E_SESSION_PROTECTED', block.reason, block) : null
}

function hostError(error) {
  if (error instanceof HostError) {
    const retryable = error.code === 'E_HOST_OFFLINE' || error.code === 'E_HOST_TIMEOUT'
    return fail(error.code, error.message, { retryable, host: true })
  }
  return fail('E_HOST_ERROR', error?.message || String(error), { host: true })
}

/**
 * Route B of the channel design: the `dsh-mesh-host` plugin inside a DSH
 * instance exposes that instance's live agents and registered tools on a
 * loopback endpoint. These tools let a remote peer use them without the
 * instance's web cookie (route A) and without a model round-trip.
 *
 * A machine can run several DSH instances (the two-DSH insurance convention),
 * so every tool takes `instance`; `host_instances` lists them and pings each.
 */
export function buildHost(ctx) {
  return [
    {
      name: 'host_instances',
      title: 'List local DSH instances behind host bridges',
      description:
        'List every configured host bridge on this machine (id, label, url, enabled) and ping each one. Use an id as the `instance` argument of host_self / host_tools / host_call / channel_agents / channel_wake. A node normally exposes two: dsh0 (3080/.dsh0) and dsh1 (3081/.dsh1).',
      inputSchema: z.object({}),
      handler: async () => {
        try {
          const config = ctx.getConfig()
          const list = hostInstances(config)
          const instances = await Promise.all(
            list.map(async (entry) => {
              let alive = false
              try {
                alive = await hostClient(ctx, entry.id).ping()
              } catch {
                /* keep the row with alive:false */
              }
              let tokenFile = entry.tokenFile || ''
              try {
                tokenFile = hostTokenPath(config, ctx.home, entry.id)
              } catch {
                /* keep empty tokenFile */
              }
              return {
                id: entry.id,
                label: entry.label || entry.id,
                url: entry.url,
                enabled: entry.enabled !== false,
                alive,
                tokenFile
              }
            })
          )
          return ok({ count: instances.length, instances })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'host_self',
      title: 'Describe the DSH instance behind a host bridge',
      description:
        'Report which DSH instance is reachable through a local host bridge (hostname, pid, plugin version), how many tools it has registered, and which agent sessions are live plus their status. Start here to discover what the peer machine exposes in-process.',
      inputSchema: z.object({ instance: instanceSchema }),
      handler: async ({ instance }) => {
        try {
          const data = await hostClient(ctx, instance).self()
          return ok({ ...data, hardware: hardwareInfo() })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'host_logs',
      title: 'Tail a DSH/mesh log file on this machine',
      description:
        'Read the last N lines of one allow-listed log file on this machine: `<mesh home>/<name>.log` or `<mesh home>/logs/<name>.log`, plain *.log names only. Secrets (web token URLs / API keys / Bearer) are redacted by the bridge before they leave the process. Use it to explain WHY an instance died or restarted — e.g. dsh0-console.log, dsh1-console.log, dsh0-autostart.log, watchdog.log, supervisor.log. Requires dsh-mesh-host >= 0.4.0.',
      inputSchema: z.object({
        instance: instanceSchema,
        name: z
          .string()
          .describe('Plain log file name, e.g. dsh0-console.log / dsh1-autostart.log / watchdog.log (no path separators).'),
        lines: z.number().int().min(1).max(500).optional().describe('How many trailing lines (default 100).')
      }),
      handler: async ({ instance, name, lines }) => {
        try {
          const data = await hostClient(ctx, instance).logs({ name, lines: lines ?? 100 })
          return ok(data)
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'host_tools',
      title: 'List tools registered inside a DSH instance',
      description:
        'List every tool a DSH instance has registered (name, description, JSON parameter schema). This is the in-process capability surface, unlike mesh-native tools: it includes DSH built-ins such as file/edit/shell tools and any plugin tools.',
      inputSchema: z.object({
        search: z.string().optional().describe('Case-insensitive substring filter on tool name or description.'),
        instance: instanceSchema
      }),
      handler: async ({ search, instance }) => {
        try {
          const { tools } = await hostClient(ctx, instance).tools()
          const needle = (search || '').toLowerCase()
          const list = (tools || []).filter(
            tool =>
              !needle ||
              String(tool.name || '').toLowerCase().includes(needle) ||
              String(tool.description || '').toLowerCase().includes(needle)
          )
          return ok({ count: list.length, tools: list })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'host_call',
      title: 'Call a tool registered inside a DSH instance',
      description:
        'Execute one tool by name inside a DSH instance and return its result. Use host_tools first to discover names/schemas. This is powerful: some host tools write files or run commands, and the host instance applies its own permission policy. Denied by default — the node ACL must allow host_call.',
      inputSchema: z.object({
        tool: z.string().describe('Host tool name, as returned by host_tools.'),
        arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments object for that tool.'),
        sessionId: z
          .string()
          .optional()
          .describe('Run on behalf of this live session (needed by session-scoped tools).'),
        timeoutMs: z.number().int().min(1000).max(600000).optional(),
        force: z
          .boolean()
          .optional()
          .describe('Bypass the scheduled-session guard (default false) for write-capable tools such as schedule_create.'),
        instance: instanceSchema
      }),
      handler: async ({ tool, arguments: args, sessionId, timeoutMs, force, instance }) => {
        try {
          const WRITE_TOOL = /^(schedule_(create|update|delete)|host_session_prompt|channel_wake|session_)/i
          if (sessionId && WRITE_TOOL.test(String(tool))) {
            const blocked = guardScheduleSession(ctx, sessionId, force)
            if (blocked) return blocked
          }
          return ok(await hostClient(ctx, instance).callTool({ tool, args: args ?? {}, sessionId, timeoutMs }))
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'channel_agents',
      title: 'List live DSH sessions via a host bridge',
      description:
        'List the agent sessions that are live inside a DSH instance (sessionId, status idle|running, title) through the host bridge. Works for headless/TUI instances, where the web-cookie route is unavailable.',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('Return only this session when given.'),
        instance: instanceSchema
      }),
      handler: async ({ sessionId, instance }) => {
        try {
          const { agents } = await hostClient(ctx, instance).agents()
          const list = sessionId ? (agents || []).filter(agent => agent.id === sessionId) : agents || []
          return ok({ count: list.length, agents: list })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'host_sessions',
      title: 'List persistent DSH sessions via a host bridge',
      description:
        'List both live and stored sessions of one local DSH instance through the host bridge: sessionId, title when available, cwd (workspace), state (working|idle|ended), running, agentAvailable, live, persisted and timestamps. Unlike channel_sessions this needs no DSH web cookie/token. Read-only.',
      inputSchema: z.object({
        instance: instanceSchema,
        limit: z.number().int().min(1).max(200).optional(),
        includeEnded: z.boolean().optional().describe('Include stored sessions with no live agent (default true).'),
        workspace: z.string().max(500).optional().describe('Only sessions whose cwd contains this path.')
      }),
      handler: async ({ instance, limit, includeEnded, workspace }) => {
        try {
          const data = await hostClient(ctx, instance).sessions({ limit, includeEnded, workspace })
          const profile = buildSessionProfile(ctx.getConfig())
          const sessions = (data.sessions || []).map((session) => ({ ...session, ...classifySession(profile, session) }))
          return ok({ ...data, sessions, protectedCount: sessions.filter((session) => session.protected).length })
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'host_session_create',
      title: 'Create a fresh DSH session on this machine',
      description:
        'Create a new DSH conversation inside one local instance through the host bridge (same path as the web UI: agent preset composition, cwd validation, default model). Returns its sessionId; use host_session_prompt or channel_wake to send the first message. Requires dsh-mesh-host >= 0.2.0. Denied by default — the node ACL must allow host_session_create.',
      inputSchema: z.object({
        cwd: z.string().max(1000).optional().describe('Workspace/cwd for the new session (default: the instance default).'),
        agentPreset: z.string().max(200).optional().describe('Agent preset id to compose (default: instance default).'),
        title: z.string().max(120).optional().describe('User-owned session title to pin immediately (stops DSH auto-titling), e.g. [委托]修复登录页.'),
        sessionId: z.string().optional().describe('Adopt this exact session id instead of generating one (rarely needed).'),
        workspaceId: z.string().optional().describe('Attach to a registered workspace id instead of a raw cwd.'),
        instance: instanceSchema
      }),
      handler: async ({ cwd, agentPreset, title, sessionId, workspaceId, instance }) => {
        try {
          return ok(await hostClient(ctx, instance).createSession({ cwd, agentPreset, sessionId, workspaceId, title }))
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'host_session_prompt',
      title: 'Prompt a DSH session without a web cookie',
      description:
        'Deliver one user message into a DSH session through the in-process sessionController (no web login, no cookie). Use host_session_create first for a fresh conversation, or host_sessions / channel_agents to find an existing one. Returns accepted=true once the agent inbox took it. Denied by default — the node ACL must allow host_session_prompt.',
      inputSchema: z.object({
        sessionId: z.string().describe('Target DSH session id.'),
        text: z.string().min(1).describe('Prompt text.'),
        mode: z.enum(['queue', 'steer']).optional().describe('queue (default) waits for the current turn; steer lands between steps.'),
        force: z.boolean().optional().describe('Inject even when the target session owns scheduled tasks (default false).'),
        instance: instanceSchema
      }),
      handler: async ({ sessionId, text, mode, force, instance }) => {
        try {
          const blocked = guardScheduleSession(ctx, sessionId, force)
          if (blocked) return blocked
          return ok(await hostClient(ctx, instance).prompt({ sessionId, text, mode }))
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'host_session_archive',
      title: 'Archive a DSH session (cleanup)',
      description:
        'Drop a session from the DSH sidebar via the in-process workspaceRegistry (DSH archive is restorable; there is no public hard-delete). Use it to clean up sessions created by delegations or probes. An archived session stays on disk and can be restored from the UI\'s archived filter. Denied by default — the node ACL must allow host_session_archive.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session id to archive (host_sessions / channel_agents / delegate status).'),
        stopActivity: z.boolean().optional().describe('Stop the session\'s running work before archiving (default: refuse if it is busy).'),
        instance: instanceSchema
      }),
      handler: async ({ sessionId, stopActivity, instance }) => {
        try {
          return ok(await hostClient(ctx, instance).archiveSession({ sessionId, stopActivity }))
        } catch (error) {
          return hostError(error)
        }
      }
    },
    {
      name: 'channel_wake',
      title: 'Inject a message into a live DSH session and wake it',
      description:
        'Deliver a user message into a live DSH session through the in-process inbox and wake the agent if it is idle (target next-turn | next-step). Returns the messageId and whether the agent was woken. Unlike channel_send this does not require a web cookie and it does not wait for the reply; pair it with channel_page or the reply arrives in the session itself. Denied by default.',
      inputSchema: z.object({
        sessionId: z.string().describe('Target live session id, from channel_agents.'),
        text: z.string().min(1).describe('Message text to deliver.'),
        target: z
          .enum(['next-turn', 'next-step'])
          .optional()
          .describe('Inbox boundary: next-turn waits for the current turn, next-step lands between steps.'),
        force: z.boolean().optional().describe('Inject even when the target session owns scheduled tasks (default false).'),
        instance: instanceSchema
      }),
      handler: async ({ sessionId, text, target, force, instance }) => {
        try {
          const blocked = guardScheduleSession(ctx, sessionId, force)
          if (blocked) return blocked
          return ok(await hostClient(ctx, instance).wake({ sessionId, text, target }))
        } catch (error) {
          return hostError(error)
        }
      }
    }
  ]
}
