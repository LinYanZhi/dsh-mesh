import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** Run a command without a shell; resolves (never rejects) with stdout/stderr/error. */
export function run(cmd, args, { timeout = 20000, cwd, signal, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, signal, encoding: 'utf8', windowsHide: true, maxBuffer },
      (error, stdout, stderr) => {
        resolvePromise({
          error,
          stdout: stdout || '',
          stderr: stderr || '',
          code: typeof error?.code === 'number' ? error.code : 0,
          killed: Boolean(error?.killed),
          timedOut: Boolean(error?.killed && error?.signal === 'SIGTERM')
        })
      }
    )
  })
}

/** Trim a string to a byte budget without splitting a UTF-8 code point badly. */
export function clip(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return { text, truncated: false, bytes: buf.length }
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true, bytes: buf.length }
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function short(text, n = 500) {
  const s = String(text ?? '')
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/** ISO timestamp helper. */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Strip a UTF-8 BOM. Windows editors (and PowerShell's Set-Content) love adding one,
 * and `JSON.parse` chokes on it — a BOM'd config.json used to kill the node at boot.
 */
export function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '')
}

/** Read a JSON file, tolerating a BOM. */
export function readJsonFile(path) {
  return JSON.parse(stripBom(readFileSync(path, 'utf8')))
}

/** Wrap a promise with a hard timeout so a stuck tool cannot hang a request forever. */
export function withTimeout(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout || new Error(`timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
