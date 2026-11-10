// dsh-brand-color — 服务端半（host 进程）
//
// 只做一件事：保存用户选的品牌 logo 颜色，供前端用 CSS 变量 `--dsh-brand-color` 上色。
// **不改任何图标/文字**（不碰 dsh-custom-brand，不覆盖品牌插槽）。
//
//   GET  /api/dsh-brand-color/config → 读当前颜色
//   POST /api/dsh-brand-color/apply  → 写颜色（$DSH_HOME/dsh-brand-color.json，带备份）
//
// 背景：harness 源码 ui-sidebar 里品牌位是
//   <span style={{ color: 'var(--dsh-brand-color, currentColor)' }}>…</span>
// 所以只要设置这个 CSS 变量就能给鲸鱼 logo 上色，且不影响形状/文字。
//
// 归宿：reusable（dsh-mesh/plugin/dsh-brand-color/lib/）

import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['webServer']

export const name = 'dsh-brand-color'

const CONFIG_NAME = 'dsh-brand-color.json'

// hex / rgb(a) / hsl(a) / 常见颜色名 / currentColor
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9., %]+\)|hsla?\([0-9., %]+\)|currentColor|[a-zA-Z]{3,20})$/

function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

function configPath() {
  return join(dshHome(), CONFIG_NAME)
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  try {
    if (existsSync(file)) {
      const bak = `${file}.bak-brandcolor`
      if (!existsSync(bak)) copyFileSync(file, bak)
    }
  } catch {
    /* ignore */
  }
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, readFileSync(tmp))
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

function isLoopback(req) {
  const raw = req?.socket?.remoteAddress || ''
  const addr = String(raw).replace(/^::ffff:/, '')
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || addr.startsWith('127.')
}

function writeJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body, null, 2))
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

export function apply(ctx) {
  const current = () => {
    const cfg = readJson(configPath(), {})
    const color = typeof cfg.color === 'string' && COLOR_RE.test(cfg.color) ? cfg.color : 'currentColor'
    return { color, configPath: configPath(), exists: existsSync(configPath()) }
  }

  const routes = [
    {
      kind: 'exact',
      path: '/api/dsh-brand-color/config',
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        if ((req.method || 'GET').toUpperCase() !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return writeJson(res, 200, { ok: true, ...current() })
      }
    },
    {
      kind: 'exact',
      path: '/api/dsh-brand-color/apply',
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readBody(req)
        if (!body || typeof body.color !== 'string') return writeJson(res, 400, { ok: false, error: 'body.color required' })
        const color = body.color.trim()
        if (!COLOR_RE.test(color)) return writeJson(res, 400, { ok: false, error: 'invalid color: ' + color })
        writeJsonAtomic(configPath(), { ...readJson(configPath(), {}), color })
        return writeJson(res, 200, { ok: true, color, configPath: configPath() })
      }
    }
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }, 'dsh-brand-color: color config + apply routes')
}
