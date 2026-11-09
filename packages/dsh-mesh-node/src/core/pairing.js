import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { meshHome, pairingPath, peersPath, ensureHome } from './config.js'

/**
 * One-time pairing codes.
 *
 * Flow:
 *   1. On the node being reached: `dsh-mesh pair --code` → "7KQ2-M9XD" (TTL 5 min, one use).
 *   2. The human tells the code to the peer machine.
 *   3. The peer runs `dsh-mesh peer add --url <url> --code 7KQ2-M9XD` → POST /pair.
 *   4. The node verifies the code and hands back a *unique* bearer token for that peer.
 *
 * Only the sha256 of the code is stored, so a leaked pairing.json cannot be replayed.
 */

/** Crockford-ish alphabet: no 0/O/1/I/L to keep it readable when typed by a human. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LEN = 8

export function normalizeCode(raw) {
  const compact = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  return compact
}

export function hashCode(code) {
  return createHash('sha256').update(`dsh-mesh-pair:${normalizeCode(code)}`).digest('hex')
}

export function formatCode(compact) {
  const s = normalizeCode(compact)
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

function randomCode() {
  let out = ''
  for (let i = 0; i < CODE_LEN; i += 1) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

function writeJson0600(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Create (and persist) a one-time code. Only one code is valid at a time:
 * creating a new one invalidates the previous one.
 */
export function createPairingCode({ home = meshHome(), ttlSec = 300, note } = {}) {
  ensureHome(home)
  const compact = randomCode()
  const now = Date.now()
  const record = {
    version: 1,
    codeHash: hashCode(compact),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(30, ttlSec) * 1000).toISOString(),
    attempts: 0,
    used: false,
    note: note || undefined
  }
  writeJson0600(pairingPath(home), record)
  return { code: formatCode(compact), expiresAt: record.expiresAt, ttlSec }
}

export function readPairingState(home = meshHome()) {
  const record = readJsonSafe(pairingPath(home))
  if (!record) return null
  return {
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    attempts: record.attempts || 0,
    used: record.used === true,
    expired: new Date(record.expiresAt).getTime() <= Date.now(),
    note: record.note
  }
}

function sameHash(a, b) {
  const ab = Buffer.from(String(a), 'hex')
  const bb = Buffer.from(String(b), 'hex')
  if (ab.length !== bb.length || ab.length === 0) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify a presented code and consume it.
 * Returns { ok:true } once; every failure carries a stable code so the server can
 * answer 401 without leaking whether the code exists (all failures look the same
 * except E_MAX_ATTEMPTS, which is only reachable by someone who keeps guessing).
 */
export function claimPairingCode({ home = meshHome(), code, maxAttempts = 5 } = {}) {
  const record = readJsonSafe(pairingPath(home))
  if (!record) return { ok: false, reason: 'E_NO_CODE' }
  if (record.used) return { ok: false, reason: 'E_CODE_USED' }
  if (new Date(record.expiresAt).getTime() <= Date.now()) return { ok: false, reason: 'E_CODE_EXPIRED' }
  if ((record.attempts || 0) >= maxAttempts) return { ok: false, reason: 'E_MAX_ATTEMPTS' }

  if (!sameHash(hashCode(code), record.codeHash)) {
    record.attempts = (record.attempts || 0) + 1
    if (record.attempts >= maxAttempts) {
      record.used = true // burn it: no more guesses
      writeJson0600(pairingPath(home), record)
      return { ok: false, reason: 'E_MAX_ATTEMPTS', attemptsLeft: 0 }
    }
    writeJson0600(pairingPath(home), record)
    return { ok: false, reason: 'E_BAD_CODE', attemptsLeft: Math.max(0, maxAttempts - record.attempts) }
  }

  record.used = true
  record.usedAt = new Date().toISOString()
  writeJson0600(pairingPath(home), record)
  return { ok: true }
}

/** Peer bookkeeping on the *client* side: who we can talk to, and with which token. */
export function loadPeers(home = meshHome()) {
  const raw = readJsonSafe(peersPath(home))
  return raw && Array.isArray(raw.items) ? raw : { version: 1, items: [] }
}

export function savePeers(peers, home = meshHome()) {
  ensureHome(home)
  const file = peersPath(home)
  writeJson0600(file, peers)
  return file
}
