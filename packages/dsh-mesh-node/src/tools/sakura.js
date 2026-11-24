// @generated 2026-11-23 P1：Sakura 隧道只读工具（状态 / 账号隧道 / 日志）
// [why] 之前只在 mesh-health 与 UI 里读 Sakura；DSH 本身没有工具可查。
//       这三个工具只读，token 永不返回，日志统一脱敏。
import { z } from 'zod'
import { collectTunnels } from '../core/tunnels.js'
import { readSakuraLogs } from '../core/sakura-api.js'
import { fail, ok } from '../core/result.js'

function publicSource(source) {
  const text = String(source || '')
  if (!text) return ''
  if (text.startsWith('env:')) return 'env:SAKURA_TOKEN'
  if (text === 'arg') return 'arg'
  return 'launcher-config'
}

function accountSummary(account) {
  const a = account || {}
  return {
    available: a.available === true,
    total: Number(a.total) || 0,
    online: Number(a.online) || 0,
    error: a.error || null,
    stale: a.stale === true,
    generatedAt: a.generatedAt || '',
    sourceKind: publicSource(a.source)
  }
}

function publicTunnel(t) {
  return {
    id: t.id,
    name: t.name,
    note: t.note || '',
    type: t.type,
    nodeId: t.nodeId,
    nodeName: t.nodeName || '',
    host: t.host || '',
    remotePort: t.remotePort || '',
    localIp: t.localIp || '',
    localPort: t.localPort == null ? null : Number(t.localPort),
    online: t.online === true,
    status: t.status == null ? null : Number(t.status),
    statusReason: t.statusReason || '',
    deviceKey: t.deviceKey || null,
    addr: t.addr || ''
  }
}

export function buildSakura(ctx) {
  return [
    {
      name: 'sakura_status',
      title: 'Sakura tunnel status (read-only)',
      description:
        'Read-only summary of SakuraFrp on this peer: whether the launcher/frpc process is running, whether a Launcher account token is available, and how many account tunnels are online. Never returns the token. Use sakura_tunnels for the full list and sakura_logs for diagnostics.',
      inputSchema: z.object({}),
      handler: async () => {
        try {
          const tunnels = await collectTunnels({ repo: process.cwd(), home: ctx.home, timeoutMs: 1500 })
          const account = accountSummary(tunnels.sakuraAccount)
          return ok({
            launcherRunning: tunnels.sakura?.launcherRunning === true,
            account,
            local: {
              tunnels: (tunnels.sakura?.tunnels || []).map((t) => ({ host: t.host || '', port: t.port || null, probe: t.probe || null }))
            },
            selfHosted: tunnels.selfHosted
              ? {
                  name: tunnels.selfHosted.name || '',
                  host: tunnels.selfHosted.host || '',
                  port: tunnels.selfHosted.port || null,
                  serverPort: tunnels.selfHosted.serverPort || null,
                  localPort: tunnels.selfHosted.localPort || null,
                  probe: tunnels.selfHosted.probe || null
                }
              : null,
            generatedAt: tunnels.generatedAt || new Date().toISOString()
          })
        } catch (error) {
          return fail('E_SAKURA_STATUS', error?.message || String(error))
        }
      }
    },
    {
      name: 'sakura_tunnels',
      title: 'List Sakura account tunnels (read-only)',
      description:
        'List the tunnels visible to the local SakuraLauncher account (name, node, host, remote port, online status, device hint). Read-only; token is never returned. Pass includeLocal:false to skip local launcher/log endpoint probes.',
      inputSchema: z.object({
        includeLocal: z.boolean().optional().describe('Include local Sakura log endpoint probes (default true).'),
        onlineOnly: z.boolean().optional().describe('Only return online tunnels (default false).'),
        limit: z.number().int().min(1).max(100).optional().describe('Max tunnels to return (default 100).')
      }),
      handler: async ({ includeLocal = true, onlineOnly = false, limit = 100 }) => {
        try {
          const data = await collectTunnels({
            repo: process.cwd(),
            home: ctx.home,
            timeoutMs: includeLocal === false ? 500 : 1500
          })
          const max = Math.max(1, Math.min(Number(limit) || 100, 100))
          let list = (data.sakuraAccount?.tunnels || []).map(publicTunnel)
          if (onlineOnly) list = list.filter((t) => t.online)
          return ok({
            account: accountSummary(data.sakuraAccount),
            total: list.length,
            online: list.filter((t) => t.online).length,
            tunnels: list.slice(0, max),
            local: includeLocal === false
              ? null
              : {
                  launcherRunning: data.sakura?.launcherRunning === true,
                  tunnels: (data.sakura?.tunnels || []).map((t) => ({ host: t.host || '', port: t.port || null, probe: t.probe || null }))
                },
            generatedAt: data.generatedAt || new Date().toISOString()
          })
        } catch (error) {
          return fail('E_SAKURA_TUNNELS', error?.message || String(error))
        }
      }
    },
    {
      name: 'sakura_logs',
      title: 'Read Sakura launcher logs (read-only)',
      description:
        'Tail the newest local SakuraLauncher log file. Read-only and bounded; tokens/authorization headers are redacted before returning. Use this to explain tunnel offline/auth errors.',
      inputSchema: z.object({
        lines: z.number().int().min(1).max(200).optional().describe('Tail line count (default 80, max 200).')
      }),
      handler: async ({ lines = 80 }) => {
        try {
          return ok(readSakuraLogs({ lines }))
        } catch (error) {
          return fail('E_SAKURA_LOGS', error?.message || String(error))
        }
      }
    }
  ]
}
