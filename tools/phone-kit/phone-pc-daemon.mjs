#!/usr/bin/env node
// @generated phone-pc-daemon：手机本地常驻直控代理（127.0.0.1:19555）
//
// 为什么：每次 `node cli.js peer call` 都要新起 Node 进程（proot 里约 1.3s），
// 常驻本代理后复用进程内的 peer 连接逻辑，手机直控延迟可降到网络 RTT 级别。
//
// 接口（仅本机回环）：POST http://127.0.0.1:19555/call
//   body: {"peer":"home","tool":"pc_action","args":{"action":"info"}}
//   resp: {"ok":true,...} 或 {"ok":false,"error":"..."}
//
// 由 dsh-mesh-autostart 插件在引擎启动时拉起；也可手动：node phone-pc-daemon.mjs
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
const REPO = process.env.DSH_MESH_REPO || '/root/dsh-mesh-kit/mesh'
const { loadPeers } = await import(REPO + '/src/core/pairing.js')
const { callPeerTool } = await import(REPO + '/src/core/peer-client.js')

const MESH_HOME = process.env.DSH_MESH_HOME || join(homedir(), '.dsh-mesh')
const PORT = Number(process.env.DSH_PC_DAEMON_PORT || 19555)

function peersNow() {
  try {
    const loaded = loadPeers(MESH_HOME)
    return Array.isArray(loaded) ? loaded : loaded.items || []
  } catch { return [] }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 256 * 1024) { reject(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, pid: process.pid, peers: peersNow().map((p) => p.name) })
    if (req.method !== 'POST' || !req.url.startsWith('/call')) return send(404, { ok: false, error: 'not found' })
    const body = JSON.parse(await readBody(req) || '{}')
    const peer = peersNow().find((p) => p.name === body.peer)
    if (!peer) return send(404, { ok: false, error: 'unknown peer: ' + body.peer })
    if (typeof body.tool !== 'string' || !/^[A-Za-z0-9_]{1,60}$/.test(body.tool)) return send(400, { ok: false, error: 'invalid tool' })
    const out = await callPeerTool(peer, { tool: body.tool, args: body.args || {}, timeoutMs: Number(body.timeoutMs) || 30000 })
    return send(200, out)
  } catch (error) {
    return send(500, { ok: false, error: String(error?.message || error) })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`pc-daemon listening on 127.0.0.1:${PORT}`))
