#!/usr/bin/env node
// session-history.mjs — 读取一条 DSH 会话的正文（只读）。
//
// 调用方：src/tools/session-history.js 通过 spawn 执行
//   node scripts/session-history.mjs --home <DSH home> --session <id> --limit <N>
// 该文件此前未随包发布，导致 session_history 恒定报
//   E_HISTORY: session-history.mjs produced no output (exit 1)
// 这里按调用侧约定补齐：解 zstd 会话日志 → 输出一份 JSON 到 stdout。
//
// 日志格式：<home>/sessions/<sessionId>/session.v4.jsonl.zstd
//   append-only 追加写，每次 flush 一个独立 zstd 帧拼接而成；
//   node:zlib 的 zstdDecompress 只解第一帧，所以要按帧魔数切片逐帧解。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return fallback
}

function fail(code, message) {
  process.stdout.write(JSON.stringify({ ok: false, code, message }) + '\n')
  process.exit(0)
}

function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max})` : s
}

/** 把追加写的多帧 zstd 文件解成整段文本。 */
function decompressLog(buf) {
  const parts = []
  const offsets = []
  let cursor = 0
  while (cursor < buf.length) {
    const hit = buf.indexOf(ZSTD_MAGIC, cursor)
    if (hit < 0) break
    offsets.push(hit)
    cursor = hit + ZSTD_MAGIC.length
  }
  if (offsets.length === 0) {
    // 也许没有压缩（纯 ndjson）
    return buf.toString('utf8')
  }
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      /* 单帧损坏就跳过，不整条失败 */
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 会话目录有两种布局：sessions/<id>/ 或 sessions/<工作区slug>/<id>/。 */
function locateSessionDir(home, sessionId) {
  const base = join(home, 'sessions')
  const direct = join(base, sessionId)
  if (existsSync(direct)) return direct
  let entries = []
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = join(base, entry.name, sessionId)
    if (existsSync(nested)) return nested
  }
  return ''
}

function findLogFile(home, sessionId) {
  const dir = locateSessionDir(home, sessionId)
  if (!dir) return { error: `session directory not found under ${join(home, 'sessions')} for ${sessionId}` }
  let names = []
  try {
    names = readdirSync(dir)
  } catch (error) {
    return { error: `cannot list ${dir}: ${error?.message || error}` }
  }
  const candidates = names
    .filter((name) => /\.jsonl(\.zstd|\.zst)?$/.test(name) || name.endsWith('.zstd'))
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    })
  if (candidates.length === 0) return { error: `no session log in ${dir}` }
  candidates.sort((a, b) => b.length - a.length)
  return { path: candidates[0], files: names }
}

function textOf(content, { includeReasoning = false, includeToolCalls = true } = {}) {
  const out = []
  for (const part of content || []) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') out.push(part.text)
    else if (part.type === 'reasoning' && includeReasoning && typeof part.text === 'string') out.push(`[reasoning] ${part.text}`)
    else if (part.type === 'tool-call' && includeToolCalls) out.push(`[tool→${part.name}] ${clip(part.arguments, 240)}`)
  }
  return out.join('\n').trim()
}

const home = arg('home', join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh0'))
const sessionId = arg('session')
const limit = Math.min(Math.max(Number(arg('limit', '40')) || 40, 1), 200)
const includeReasoning = process.argv.includes('--reasoning')
const includeTools = !process.argv.includes('--no-tools')

if (!sessionId) fail('E_INVALID_ARG', 'missing --session <sessionId>')

const found = findLogFile(home, sessionId)
if (found.error) fail('E_NOT_FOUND', found.error)

let raw
try {
  raw = readFileSync(found.path)
} catch (error) {
  fail('E_NOT_FOUND', `cannot read ${found.path}: ${error?.message || error}`)
}

const text = decompressLog(raw)
const lines = text.split('\n').filter((line) => line.trim())

let title = ''
let cwd = ''
let createdAt = null
const all = []

for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  const data = event?.data || {}
  if (event.type === 'session') {
    cwd = event.cwd || data.cwd || cwd
    createdAt = event.createdAt ?? data.createdAt ?? createdAt
    continue
  }
  if (event.type === 'session/title') {
    if (data.title) title = String(data.title)
    continue
  }
  if (event.type === 'user/message') {
    const body = textOf(data.content, { includeReasoning: false, includeToolCalls: false })
    if (!body) continue
    all.push({
      seq: event.seq ?? null,
      time: event.time ?? null,
      role: 'user',
      system: body.startsWith('<system-reminder>') || data.source?.kind === 'system',
      text: clip(body, 8000)
    })
    continue
  }
  if (event.type === 'assistant/message') {
    const content = data.message?.content
    const body = textOf(content, { includeReasoning, includeToolCalls: includeTools })
    if (!body) continue
    all.push({
      seq: event.seq ?? null,
      time: event.time ?? null,
      role: 'assistant',
      turn: data.turn ?? null,
      step: data.step ?? null,
      text: clip(body, 8000)
    })
    continue
  }
  if (event.type === 'tool/result' && includeTools) {
    const message = data.message || {}
    const result = data.result ?? message
    let body = ''
    if (Array.isArray(result?.content)) body = result.content.map((item) => item?.text ?? `[${item?.type}]`).join('\n')
    else if (typeof result === 'string') body = result
    else if (result?.text) body = String(result.text)
    if (!body) continue
    all.push({
      seq: event.seq ?? null,
      time: event.time ?? null,
      role: 'tool',
      tool: data.name || message.toolName || message.toolCallId || data.callId || null,
      text: clip(body, 600)
    })
  }
}

const visible = all.filter((item) => !item.system)
const messages = visible.slice(-limit).map((item, index) => ({
  index: visible.length - Math.min(limit, visible.length) + index + 1,
  ...item
}))

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      sessionId,
      title: title || '',
      cwd: cwd || '',
      createdAt,
      logFile: found.path,
      totalEvents: lines.length,
      totalMessages: visible.length,
      returned: messages.length,
      messages
    },
    null,
    1
  ) + '\n'
)
