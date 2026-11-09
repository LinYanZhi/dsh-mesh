import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { nowIso, readJsonFile, short } from './util.js'

export const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled']

export function jobsDir(home) {
  const dir = join(home, 'jobs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function jobPath(home, id) {
  return join(jobsDir(home), `${id}.json`)
}

export function newJobId() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function writeJob(home, job) {
  writeFileSync(jobPath(home, job.id), JSON.stringify(job, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

function readJob(home, id) {
  const p = jobPath(home, id)
  if (!existsSync(p)) return null
  try {
    return readJsonFile(p)
  } catch {
    return null
  }
}

function allJobs(home) {
  const dir = jobsDir(home)
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(readJsonFile(join(dir, name)))
    } catch {
      /* skip corrupt job file */
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/** Trim old jobs so the jobs dir cannot grow without bound. */
export function pruneJobs(home, { ttlSec = 7 * 24 * 3600, maxJobs = 500 } = {}) {
  const jobs = allJobs(home)
  const cutoff = Date.now() - ttlSec * 1000
  const keep = []
  for (const job of jobs) {
    const created = Date.parse(job.createdAt || 0)
    const terminal = TERMINAL_STATES.includes(job.state)
    if (terminal && Number.isFinite(created) && created < cutoff) {
      try {
        rmSync(jobPath(home, job.id), { force: true })
      } catch {
        /* ignore */
      }
      continue
    }
    keep.push(job)
  }
  for (const job of keep.slice(maxJobs)) {
    if (!TERMINAL_STATES.includes(job.state)) continue
    try {
      rmSync(jobPath(home, job.id), { force: true })
    } catch {
      /* ignore */
    }
  }
  return { scanned: jobs.length, kept: Math.min(keep.length, maxJobs) }
}

/**
 * Async job runner: `task_submit` persists a job, runs it in-process and lets the caller
 * poll `task_status`. Jobs survive a server restart as records (running ones are marked
 * interrupted on load, so a client never waits forever).
 *
 * Idempotency: `task_submit` with the same `idem` key returns the original job instead of
 * creating a second one — that is what makes retries after a dropped connection safe.
 */
export class JobRunner {
  constructor({ home, exec, audit, log = console, limits = {} }) {
    this.home = home
    this.exec = exec
    this.audit = audit
    this.log = log
    this.limits = limits
    this.running = new Map()
    this.recoverInterrupted()
  }

  recoverInterrupted() {
    let recovered = 0
    for (const job of allJobs(this.home)) {
      if (job.state === 'running' || job.state === 'queued') {
        job.state = 'failed'
        job.error = { code: 'E_INTERRUPTED', message: 'node restarted while the job was running', retryable: true }
        job.finishedAt = nowIso()
        try {
          writeJob(this.home, job)
          recovered += 1
        } catch {
          /* ignore */
        }
      }
    }
    if (recovered > 0) this.log?.info?.(`[dsh-mesh] marked ${recovered} interrupted job(s) as failed`)
    return recovered
  }

  findByIdem(idem) {
    if (!idem) return null
    return allJobs(this.home).find((j) => j.idem === idem) || null
  }

  submit({ tool, arguments: args = {}, idem, peer, timeoutMs }) {
    if (idem) {
      const existing = this.findByIdem(idem)
      if (existing) return { job: existing, idempotent: true }
    }
    const job = {
      id: newJobId(),
      idem: idem || null,
      tool,
      arguments: args,
      state: 'queued',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      peer: peer || null,
      result: null,
      error: null
    }
    writeJob(this.home, job)
    this.#start(job, timeoutMs)
    return { job: this.#public(job), idempotent: false }
  }

  #start(job, timeoutMs) {
    const controller = new AbortController()
    const timer = timeoutMs
      ? setTimeout(() => controller.abort(new Error(`job timed out after ${timeoutMs}ms`)), timeoutMs)
      : null
    timer?.unref?.()
    this.running.set(job.id, { controller, job })

    setImmediate(async () => {
      job.state = 'running'
      job.startedAt = nowIso()
      try {
        writeJob(this.home, job)
      } catch {
        /* ignore */
      }
      try {
        const result = await this.exec(job.tool, job.arguments, { signal: controller.signal, jobId: job.id })
        job.result = result
        if (result?.isError) {
          job.state = controller.signal.aborted ? 'cancelled' : 'failed'
          try {
            job.error = JSON.parse(result.content?.[0]?.text || '{}')
          } catch {
            job.error = { code: 'E_INTERNAL', message: 'tool returned an error' }
          }
        } else {
          job.state = controller.signal.aborted ? 'cancelled' : 'succeeded'
        }
      } catch (error) {
        job.state = controller.signal.aborted ? 'cancelled' : 'failed'
        job.error = { code: controller.signal.aborted ? 'E_CANCELLED' : 'E_INTERNAL', message: short(error?.message || error) }
      } finally {
        if (timer) clearTimeout(timer)
        job.finishedAt = nowIso()
        this.running.delete(job.id)
        try {
          writeJob(this.home, job)
        } catch {
          /* ignore */
        }
        this.audit?.({
          peer: job.peer,
          tool: job.tool,
          jobId: job.id,
          ok: job.state === 'succeeded',
          state: job.state,
          args: Object.keys(job.arguments || {})
        })
      }
    })
  }

  get(id) {
    const job = readJob(this.home, id)
    return job ? this.#public(job) : null
  }

  list({ state, limit = 20 } = {}) {
    let jobs = allJobs(this.home)
    if (state) jobs = jobs.filter((j) => j.state === state)
    return jobs.slice(0, Math.min(Math.max(1, limit), 100)).map((j) => this.#public(j))
  }

  cancel(id) {
    const job = readJob(this.home, id)
    if (!job) return { ok: false, code: 'E_NOT_FOUND', message: `no such job: ${id}` }
    if (TERMINAL_STATES.includes(job.state)) {
      return { ok: false, code: 'E_INVALID_ARG', message: `job already ${job.state}` }
    }
    const live = this.running.get(id)
    if (live) {
      live.controller.abort(new Error('cancelled by client'))
      return { ok: true, job: this.#public({ ...job, cancelRequested: true }) }
    }
    job.state = 'cancelled'
    job.finishedAt = nowIso()
    writeJob(this.home, job)
    return { ok: true, job: this.#public(job) }
  }

  stats() {
    const jobs = allJobs(this.home)
    const byState = {}
    for (const job of jobs) byState[job.state] = (byState[job.state] || 0) + 1
    return { total: jobs.length, byState, running: this.running.size, dir: jobsDir(this.home) }
  }

  #public(job) {
    return {
      id: job.id,
      idem: job.idem || null,
      tool: job.tool,
      arguments: job.arguments,
      state: job.state,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs:
        job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : null,
      cancelRequested: Boolean(job.cancelRequested),
      error: job.error,
      result: job.result,
      resultBytes: job.result ? Buffer.byteLength(JSON.stringify(job.result), 'utf8') : 0
    }
  }
}
