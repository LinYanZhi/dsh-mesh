#!/usr/bin/env node
// @generated pc-desktop-helper：用户交互会话内的桌面操作代理（127.0.0.1:19556）
//
// 为什么需要：部分机器的 mesh server 跑在 session 0（S4U/计划任务），EnumWindows/媒体键/显示桌面等
// 只能看见/作用于 session 0 的桌面，看不到用户真实窗口。本 helper 由「登录时触发」的计划任务在
// 用户交互 session 启动，mesh（session 0）通过本机回环把 pc_* 调用转发过来执行。
//
// 启动方式：计划任务 dsh-mesh-desktop-helper（scripts/install-desktop-helper-task.mjs 安装）
// 手动启动：node scripts/pc-desktop-helper.mjs
// 健康检查：curl -s http://127.0.0.1:19556/health
import { createServer } from 'node:http'

process.env.DSH_PC_DESKTOP_DIRECT = '1'
const PORT = Number(process.env.DSH_PC_DESKTOP_HELPER_PORT || 19556)

const ctx = {
  getConfig: () => ({ pcControl: { enabled: true }, acl: { allow: [] } }),
  audit: async () => {},
  peerId: 'desktop-helper',
  home: process.env.DSH_MESH_HOME || '',
  log: () => {}
}

const { buildControl } = await import(new URL('../src/tools/control.js', import.meta.url))
const { buildControlApps } = await import(new URL('../src/tools/control-apps.js', import.meta.url))
const tools = new Map()
for (const spec of [...buildControl(ctx), ...buildControlApps(ctx)]) tools.set(spec.name, spec)

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 256 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, pid: process.pid, tools: [...tools.keys()], session: (await import('node:process')).default.pid })
    }
    if (req.method !== 'POST' || !req.url.startsWith('/call')) return send(404, { ok: false, error: 'not found' })
    const body = JSON.parse((await readBody(req)) || '{}')
    const spec = tools.get(String(body.tool || ''))
    if (!spec) return send(404, { ok: false, error: 'unknown tool: ' + body.tool })
    const result = await spec.handler(body.args || {}, { peerId: 'desktop-helper' })
    return send(200, { ok: true, result })
  } catch (error) {
    return send(500, { ok: false, error: String(error?.message || error) })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`pc-desktop-helper listening on 127.0.0.1:${PORT}`))
