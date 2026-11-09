import { z } from 'zod'
import { DshWebClient, DshError, assistantText, summarizeRecord } from '../core/ds-web.js'
import { saveSecrets } from '../core/config.js'
import { fail, invalidArg, notFound, ok } from '../core/result.js'

/**
 * M3 channel (route A): talk to a *local* DSH web instance's Remote API so a peer AI
 * can put a message into a running session and read the reply back.
 *
 * Route B (a DSH plugin calling `inbox.append`) needs an installed plugin and is not
 * implemented yet; when it lands these tools keep the same surface.
 */

function meshHome(ctx) {
  return ctx.home
}

function targets(ctx) {
  const config = ctx.getConfig()
  const configured = (config.dsh?.targets || []).filter((t) => t && t.id && t.baseUrl)
  return configured.map((t) => ({ id: t.id, baseUrl: t.baseUrl, note: t.note }))
}

function secretsOf(ctx) {
  try {
    return ctx.getSecrets() || {}
  } catch {
    return {}
  }
}

/** Persist the cookie so a restart of the mesh node does not need a new launch URL. */
function rememberCookie(ctx, { targetId, baseUrl, cookie }) {
  const secrets = secretsOf(ctx)
  secrets.dshWeb = { ...(secrets.dshWeb || {}) }
  secrets.dshWeb[targetId] = { baseUrl, cookie, savedAt: new Date().toISOString() }
  saveSecrets(secrets, meshHome(ctx))
}

function targetInfo(ctx) {
  const secrets = secretsOf(ctx)
  const stored = secrets.dshWeb || {}
  return targets(ctx).map((t) => {
    const saved = stored[t.id]
    return {
      id: t.id,
      baseUrl: t.baseUrl,
      note: t.note,
      hasCookie: Boolean(saved?.cookie),
      savedAt: saved?.savedAt
    }
  })
}

/** Build a client for one configured target, reusing the persisted cookie. */
function clientFor(ctx, targetId) {
  const secrets = secretsOf(ctx)
  const saved = (secrets.dshWeb || {})[targetId]
  const configured = targets(ctx).find((t) => t.id === targetId)
  if (!configured && !saved) {
    return {
      error: notFound(`unknown channel target: ${targetId}`, {
        targets: targetInfo(ctx).map((t) => t.id),
        hint: 'add dsh.targets[] to config.json or call channel_login with a launch URL'
      })
    }
  }
  const baseUrl = configured?.baseUrl || saved?.baseUrl
  const client = new DshWebClient({ baseUrl, cookie: saved?.cookie, log: ctx.log })
  return { client, baseUrl, targetId }
}

function describeError(error) {
  if (error instanceof DshError) {
    return fail(error.code, error.message.replace(/^[A-Z_]+: /, ''), {
      retryable: error.code === 'E_DSH_UNREACHABLE' || error.code === 'E_TIMEOUT',
      ...error.extra
    })
  }
  return fail('E_DSH_UNEXPECTED', String(error?.message || error))
}

function autoTargetId(baseUrl) {
  try {
    const url = new URL(baseUrl)
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return `dsh-${port}`
  } catch {
    return 'dsh-local'
  }
}

export function buildChannel(ctx) {
  const limits = ctx.getConfig().limits || {}
  const defaultWaitMs = limits.channelWaitMs ?? 180000
  const defaultPollMs = limits.channelPollMs ?? 800
  const defaultMessages = limits.channelMaxMessages ?? 60

  return [
    {
      name: 'channel_targets',
      title: 'List DSH channel targets',
      description:
        'List the local DSH instances this mesh node can talk to (config.dsh.targets plus targets saved by channel_login), and whether a session cookie is already stored. Read-only.',
      inputSchema: z.object({}),
      handler: async () => ok({ targets: targetInfo(ctx), hint: 'channel_login <launchUrl> to (re)authenticate' })
    },
    {
      name: 'channel_login',
      title: 'Log in to a local DSH instance',
      description:
        'Exchange a `dsh web` launch URL (the one printed on startup, containing ?token=) for a session cookie, then persist it in secrets.json. The launch token is single-use; the cookie survives DSH restarts. Returns the target id and how many sessions exist.',
      inputSchema: z.object({
        launchUrl: z.string().describe('Full launch URL, e.g. http://127.0.0.1:3080/?token=...'),
        target: z.string().optional().describe('Target id to store under (defaults to dsh-<port>)')
      }),
      handler: async (args) => {
        try {
          const client = new DshWebClient({ log: ctx.log })
          const { baseUrl } = await client.login(args.launchUrl)
          const targetId = args.target || autoTargetId(baseUrl)
          const list = await client.listSessions()
          rememberCookie(ctx, { targetId, baseUrl, cookie: client.cookie })
          return ok({
            target: targetId,
            baseUrl,
            sessions: (list?.items || []).length,
            stored: '~/.dsh-mesh/secrets.json (0600, never in git)',
            next: `channel_send({ target: "${targetId}", text: "..." })`
          })
        } catch (error) {
          return describeError(error)
        }
      }
    },
    {
      name: 'channel_sessions',
      title: 'List sessions on a DSH target',
      description:
        'List sessions of one local DSH instance: sessionId, title, state (working|idle|ended), running, agentAvailable, cwd (workspace) and updatedAt. Requires a channel_login cookie for that target; host_sessions is the cookie-free alternative. Use this before channel_send to find the session you want to talk to, or omit sessionId there to open a new one.',
      inputSchema: z.object({
        target: z.string().describe('Target id from channel_targets'),
        limit: z.number().int().min(1).max(200).optional()
      }),
      handler: async (args) => {
        const built = clientFor(ctx, args.target)
        if (built.error) return built.error
        try {
          const value = await built.client.listSessions()
          const items = (value?.items || []).slice(0, args.limit ?? 50).map((item) => ({
            sessionId: item.sessionId || item.id,
            title: item.title || item.projections?.values?.title || '',
            state: item.running ? 'working' : item.agentAvailable ? 'idle' : 'ended',
            status: item.status,
            running: item.running === true,
            agentAvailable: item.agentAvailable === true,
            cwd: item.cwd || '',
            updatedAt: item.updatedAt || item.modifiedAt || item.createdAt
          }))
          return ok({ target: args.target, baseUrl: built.baseUrl, count: items.length, sessions: items })
        } catch (error) {
          return describeError(error)
        }
      }
    },
    {
      name: 'channel_page',
      title: 'Read recent events of a DSH session',
      description:
        'Read the last N events of one session (user messages, assistant messages, turn boundaries) as a compact list. Useful to catch up on a conversation without waiting for a turn.',
      inputSchema: z.object({
        target: z.string().describe('Target id from channel_targets'),
        sessionId: z.string(),
        maxMessages: z.number().int().min(1).max(200).optional()
      }),
      handler: async (args) => {
        const built = clientFor(ctx, args.target)
        if (built.error) return built.error
        try {
          const page = await built.client.page({
            sessionId: args.sessionId,
            maxMessages: args.maxMessages ?? defaultMessages
          })
          return ok({
            target: args.target,
            sessionId: args.sessionId,
            hasMore: page.hasMore,
            events: page.records.map(summarizeRecord),
            assistantText: assistantText(page.records).slice(-4000)
          })
        } catch (error) {
          return describeError(error)
        }
      }
    },
    {
      name: 'channel_send',
      title: 'Send a message to a DSH session and wait for the reply',
      description:
        'Put a text message into a local DSH session (creating a fresh session when sessionId is omitted) and wait until that turn ends, then return the assistant reply. This is how a peer AI wakes the other side up instead of only reading files. Opt-in tool: enable it in acl.allow.',
      inputSchema: z.object({
        target: z.string().describe('Target id from channel_targets'),
        text: z.string().min(1).describe('Message to send, as if typed by the user'),
        sessionId: z.string().optional().describe('Existing session; omit to open a new one'),
        mode: z.enum(['queue', 'steer']).optional().describe('queue = after current turn, steer = interrupt'),
        waitMs: z.number().int().min(1000).max(1800000).optional()
      }),
      handler: async (args, { signal } = {}) => {
        const built = clientFor(ctx, args.target)
        if (built.error) return built.error
        try {
          const sessionId = args.sessionId || (await built.client.createSession())
          if (signal?.aborted) throw new DshError('E_ABORTED', 'caller aborted before prompt')
          const result = await built.client.sendAndWait({
            sessionId,
            text: args.text,
            mode: args.mode || 'queue',
            waitMs: args.waitMs ?? defaultWaitMs,
            pollMs: defaultPollMs
          })
          return ok({
            target: args.target,
            created: !args.sessionId,
            sessionId: result.sessionId,
            requestId: result.requestId,
            turnEnd: result.turnEnd,
            reply: result.reply,
            events: result.events,
            ms: result.ms
          })
        } catch (error) {
          return describeError(error)
        }
      }
    },
    {
      name: 'channel_cancel',
      title: 'Cancel the running turn of a DSH session',
      description: 'Ask one session to abort its current turn. Opt-in tool: enable it in acl.allow.',
      inputSchema: z.object({ target: z.string(), sessionId: z.string() }),
      handler: async (args) => {
        const built = clientFor(ctx, args.target)
        if (built.error) return built.error
        try {
          await built.client.cancel({ sessionId: args.sessionId })
          return ok({ target: args.target, sessionId: args.sessionId, cancelled: true })
        } catch (error) {
          return describeError(error)
        }
      }
    }
  ]
}
