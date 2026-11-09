import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

/**
 * Client for the DSH web host's local Remote API (route A of the channel design).
 *
 * Two facts from the harness source that shape this file:
 *  - The only way in is the one-time launch URL printed by `dsh web`
 *    (`http://127.0.0.1:<port>/?token=<43 chars>`): GET it with `redirect: 'manual'`
 *    and you get `303 + Set-Cookie`. There is no static token on disk.
 *    (apps/web/tests/smoke-real.e2e.ts:50-66, apps/cli/tests/web-auth.e2e.ts:173-183)
 *  - Every unary call is `POST /api/<method>` with
 *    `{type:'client-request', rpcId, method, payload:{args}}` and answers
 *    `{result:{ok:true,value}}` — HTTP can be 200 while `result.ok` is false, so
 *    never trust the status code alone. (smoke-real.e2e.ts:91-109)
 */

export class DshError extends Error {
  constructor(code, message, extra = {}) {
    super(`${code}: ${message}`)
    this.name = 'DshError'
    this.code = code
    this.extra = extra
  }
}

/** Strip a trailing slash and any path so we always talk to the origin. */
function originOf(url) {
  return new URL(url).origin
}

export class DshWebClient {
  constructor({ baseUrl, cookie, log = console } = {}) {
    this.baseUrl = baseUrl ? originOf(baseUrl) : null
    this.cookie = cookie || null
    this.log = log
  }

  get authenticated() {
    return Boolean(this.cookie)
  }

  /**
   * Exchange a launch URL for the session cookie. The launch token is single-use;
   * the resulting cookie survives `dsh web` restarts (it is signed by the key that
   * lives in the DSH home), so it is worth persisting.
   */
  async login(launchUrl, { timeoutMs = 15000 } = {}) {
    if (!launchUrl) throw new DshError('E_INVALID_ARG', 'launchUrl is required')
    const started = Date.now()
    const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    const setCookie = response.headers.get('set-cookie')
    if (response.status !== 303 || !setCookie) {
      throw new DshError('E_DSH_AUTH', `launch URL rejected (HTTP ${response.status}, set-cookie=${setCookie ? 'yes' : 'no'})`, {
        status: response.status
      })
    }
    this.cookie = setCookie.split(';', 1)[0]
    this.baseUrl = originOf(launchUrl)
    this.log?.debug?.(`[dsh-mesh] channel login ok in ${Date.now() - started}ms`)
    return { baseUrl: this.baseUrl, cookie: this.cookie }
  }

  async rpc(endpoint, args = {}, { timeoutMs = 60000, rpcId } = {}) {
    if (!this.baseUrl) throw new DshError('E_DSH_NO_TARGET', 'no baseUrl: log in first')
    if (!this.cookie) throw new DshError('E_DSH_NO_COOKIE', 'no session cookie: log in first')
    const body = {
      type: 'client-request',
      rpcId: rpcId || `mesh-${endpoint.replace(/\//g, '-')}-${randomUUID()}`,
      method: endpoint,
      payload: { args }
    }
    let response
    try {
      response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: this.cookie },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new DshError('E_TIMEOUT', `${endpoint} timed out after ${timeoutMs}ms`)
      throw new DshError('E_DSH_UNREACHABLE', `${endpoint} failed: ${error?.message || error}`)
    }
    const text = await response.text()
    if (!response.ok) {
      throw new DshError('E_DSH_HTTP', `${endpoint} HTTP ${response.status}: ${text.slice(0, 400)}`, {
        status: response.status
      })
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new DshError('E_DSH_BAD_BODY', `${endpoint} returned non-JSON: ${text.slice(0, 200)}`)
    }
    const result = parsed?.result
    if (!result || result.ok !== true) {
      const error = result?.error || {}
      throw new DshError(error.code || 'E_DSH_RPC', `${endpoint}: ${error.message || 'unknown RPC failure'}`, {
        endpoint
      })
    }
    return result.value
  }

  /** `{ items: [{ sessionId, ... }] }` — see smoke-real.e2e.ts:759-771. */
  async listSessions({ timeoutMs = 30000 } = {}) {
    return this.rpc('session/list', { _request: {} }, { timeoutMs })
  }

  /** `{ sessionId }` — smoke-real.e2e.ts:456. */
  async createSession({ request = {}, timeoutMs = 30000 } = {}) {
    const value = await this.rpc('session/create', { request }, { timeoutMs })
    const sessionId = value?.sessionId || value?.request?.sessionId
    if (!sessionId) throw new DshError('E_DSH_BAD_BODY', 'session/create returned no sessionId')
    return sessionId
  }

  /** `{ accepted: true }` — smoke-real.e2e.ts:457-462. */
  async prompt({ sessionId, text, mode = 'queue', timeoutMs = 60000 } = {}) {
    if (!sessionId) throw new DshError('E_INVALID_ARG', 'sessionId is required')
    if (typeof text !== 'string' || text.trim() === '') throw new DshError('E_INVALID_ARG', 'text is required')
    const requestId = randomUUID()
    const value = await this.rpc(
      'session/prompt',
      { request: { requestId, sessionId, mode, content: [{ type: 'text', text }] } },
      { timeoutMs }
    )
    return { requestId, accepted: value?.accepted !== false, value }
  }

  /**
   * Read the latest history window over one short-lived follow stream.
   *
   * `session/page` requires a `throughSeq` cut that only a follow opening frame
   * provides (`packages/api/session-controller/src/types.ts:471-476`), and the
   * `throughSeq:-1` sentinel paginates to an empty window
   * (`packages/api/session-controller/src/history.ts:392-426`). So: open, keep the
   * snapshot, close.
   */
  async page({ sessionId, maxMessages = 40, timeoutMs = 30000 } = {}) {
    const follow = await this.openFollow({ sessionId, maxMessages, timeoutMs })
    try {
      return {
        records: follow.snapshot.records,
        hasMore: follow.snapshot.hasMore,
        cursor: follow.snapshot.cursor
      }
    } finally {
      follow.close()
    }
  }

  /**
   * Open `session/follow` on the host's WebSocket mux
   * (`/api/remote.mux`, `packages/api/gateway/src/stream-protocol.ts:7`) and resolve
   * once the opening snapshot arrives. Live durable events after that are delivered
   * to `follow.onEvent`.
   */
  openFollow({ sessionId, maxMessages = 40, timeoutMs = 15000 } = {}) {
    if (!this.baseUrl) throw new DshError('E_DSH_NO_TARGET', 'no baseUrl: log in first')
    if (!this.cookie) throw new DshError('E_DSH_NO_COOKIE', 'no session cookie: log in first')
    if (!sessionId) throw new DshError('E_INVALID_ARG', 'sessionId is required')
    const streamId = `mesh-follow-${randomUUID()}`
    const url = `${this.baseUrl.replace(/^http/u, 'ws')}/api/remote.mux`
    const socket = new WebSocket(url, { headers: { cookie: this.cookie } })
    const follow = {
      socket,
      streamId,
      snapshot: null,
      /** @type {((event: any) => void) | null} */
      onEvent: null,
      /** @type {((error: Error) => void) | null} */
      onError: null,
      closed: false,
      close() {
        if (follow.closed) return
        follow.closed = true
        try {
          socket.close()
        } catch {
          /* already gone */
        }
      }
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          follow.close()
          reject(error)
        } else {
          resolve(follow)
        }
      }
      const timer = setTimeout(
        () => finish(new DshError('E_TIMEOUT', `session/follow did not open within ${timeoutMs}ms`)),
        timeoutMs
      )
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            type: 'open',
            streamId,
            endpoint: 'session/follow',
            payload: {
              args: { request: { address: { kind: 'session', sessionId }, maxMessages } }
            }
          })
        )
      })
      socket.on('message', (data) => {
        let frame
        try {
          frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
        } catch {
          return
        }
        if (!frame || frame.streamId !== streamId) return
        if (frame.type === 'error') {
          const error = new DshError(
            frame.error?.code || 'E_DSH_STREAM',
            `session/follow failed: ${frame.error?.message || 'unknown error'}`
          )
          if (!settled) finish(error)
          else follow.onError?.(error)
          return
        }
        if (frame.type === 'end') {
          follow.close()
          if (!settled) finish(new DshError('E_DSH_STREAM', 'session/follow ended before its opening snapshot'))
          return
        }
        if (frame.type !== 'item') return
        const value = frame.value
        if (!value) return
        if (value.type === 'snapshot') {
          follow.snapshot = {
            cursor: value.cursor,
            records: Array.isArray(value.records) ? value.records : [],
            hasMore: value.hasMore === true
          }
          finish()
          return
        }
        if (value.type === 'event' && value.event) follow.onEvent?.(value.event)
      })
      socket.on('error', (error) => {
        const wrapped = new DshError('E_DSH_UNREACHABLE', `session/follow carrier failed: ${error?.message || error}`)
        if (!settled) finish(wrapped)
        else follow.onError?.(wrapped)
      })
      socket.on('close', () => {
        follow.closed = true
        if (!settled) finish(new DshError('E_DSH_STREAM', 'session/follow carrier closed before its opening snapshot'))
      })
    })
  }

  async cancel({ sessionId, timeoutMs = 30000 } = {}) {
    if (!sessionId) throw new DshError('E_INVALID_ARG', 'sessionId is required')
    return this.rpc('session/cancel', { request: { sessionId } }, { timeoutMs })
  }

  /**
   * Send a prompt and wait for the turn that carries it to end.
   *
   * The follow stream is opened *before* the prompt, so no event can be missed; the
   * snapshot gives us the baseline turn counter. A `queue` prompt can land after a
   * turn that was already running, so we only accept a `turn/end` that follows a
   * `turn/start` we saw live (or, for `steer`, the very next `turn/end`).
   */
  async sendAndWait({ sessionId, text, mode = 'queue', waitMs = 180000 } = {}) {
    const started = Date.now()
    const follow = await this.openFollow({ sessionId, maxMessages: 40 })
    const baselineTurn = lastTurnOf(follow.snapshot.records)
    const fresh = []
    let sawTurnStart = false
    const outcome = new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), waitMs)
      follow.onEvent = (event) => {
        fresh.push({ type: 'event', event })
        if (event?.type === 'turn/start') sawTurnStart = true
        if (event?.type !== 'turn/end') return
        const turn = event?.data?.turn
        const accepted =
          mode === 'steer' || sawTurnStart || (Number.isFinite(turn) && turn > baselineTurn)
        if (!accepted) return
        clearTimeout(timer)
        resolve({ timedOut: false, turnEnd: normalizeTurnEnd(event) })
      }
      follow.onError = (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })
    try {
      const { requestId } = await this.prompt({ sessionId, text, mode })
      const result = await outcome
      if (result.timedOut) {
        throw new DshError('E_TIMEOUT', `turn did not finish within ${waitMs}ms`, {
          sessionId,
          requestId,
          mode,
          reply: assistantText(fresh).slice(-4000)
        })
      }
      return {
        sessionId,
        requestId,
        reply: assistantText(fresh).slice(-4000),
        turnEnd: result.turnEnd,
        events: fresh.length,
        ms: Date.now() - started
      }
    } finally {
      follow.close()
    }
  }
}

/** Event records are `{ type:'event', event:{ seq, type, data } }`. */
function seqOf(record) {
  const seq = record?.event?.seq ?? record?.seq
  return Number.isFinite(seq) ? seq : null
}

function lastSeqOf(records) {
  let last = -1
  for (const record of records || []) {
    const seq = seqOf(record)
    if (seq !== null && seq > last) last = seq
  }
  return last
}

/** Highest turn counter present in a history window (0 when there is no turn yet). */
function lastTurnOf(records) {
  let last = 0
  let seen = 0
  for (const record of records || []) {
    const event = record?.event
    if (event?.type !== 'turn/start') continue
    seen += 1
    const turn = event?.data?.turn ?? event?.data?.turnId
    if (Number.isFinite(turn)) last = Math.max(last, turn)
    else last = Math.max(last, seen)
  }
  return last
}

/** Concatenate every assistant text block in order. */
export function assistantText(records) {
  const parts = []
  for (const record of records || []) {
    const event = record?.event
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

function normalizeTurnEnd(event) {
  const reason = event?.data?.reason || {}
  return { kind: reason.kind || 'unknown', message: reason.message, seq: event?.seq }
}

/** Compact a history record for MCP output (never dump the whole event stream). */
export function summarizeRecord(record) {
  const event = record?.event
  if (!event) return { type: record?.type || 'unknown' }
  const summary = { seq: event.seq, type: event.type }
  if (event.type === 'user/message') {
    const content = event?.data?.message?.content
    summary.text = Array.isArray(content)
      ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').slice(0, 500)
      : undefined
  } else if (event.type === 'assistant/message') {
    summary.text = assistantText([record]).slice(0, 4000)
  } else if (event.type === 'turn/end') {
    summary.reason = normalizeTurnEnd(event)
  } else if (event.type === 'turn/start') {
    summary.turn = event?.data?.turn ?? event?.data?.turnId
  }
  return summary
}
