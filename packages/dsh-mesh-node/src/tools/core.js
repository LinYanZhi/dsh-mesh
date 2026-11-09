import { hostname, platform, arch, release, uptime, type } from 'node:os'
import { basename } from 'node:path'
import { z } from 'zod'
import { MESH_VERSION, configPath } from '../core/config.js'
import { describeCert } from '../core/tls.js'
import { hardwareInfo } from '../core/hardware.js'
import { auditPath, auditSummary } from '../core/audit.js'
import { ok } from '../core/result.js'

/** Self-description — the first call a peer AI should make. */
export function buildCore(ctx) {
  return [
    {
      name: 'mesh_self',
      title: 'Describe this mesh node',
      description:
        'Return identity and capability information about the peer machine you are connected to: node name, mesh version, host/OS facts, every tool this node exposes with whether your token may call it, ACL summary, shell policy, job queue stats and configured peers. Call this first to learn what the remote side can do.',
      inputSchema: z.object({}),
      handler: async () => {
        const config = ctx.getConfig()
        const names = ctx.toolNames()
        const acl = config.acl || {}
        const shell = config.shell || {}
        return ok({
          protocol: 'mcp/streamable-http',
          mesh: {
            name: config.node?.name || 'local',
            version: MESH_VERSION,
            home: ctx.home,
            repo: process.cwd(),
            configPath: configPath(ctx.home),
            auditPath: auditPath(ctx.home)
          },
          hardware: hardwareInfo(),
          host: {
            hostname: hostname(),
            platform: platform(),
            type: type(),
            release: release(),
            arch: arch(),
            node: process.version,
            pid: process.pid,
            /**
             * Parent pid. Whether this node hangs under a Task Scheduler
             * (svchost -s Schedule, logon autostart) or under a DSH/shell
             * process (will die with a tree-kill) cannot be told from pid alone.
             */
            ppid: process.ppid,
            /** Seconds since THIS node process started (process.uptime). */
            processUptimeSec: Math.round(process.uptime()),
            /**
             * Seconds since the OS booted (node:os.uptime) — NOT process age.
             * Kept for backward compatibility; use processUptimeSec for liveness.
             */
            uptimeSec: Math.round(uptime())
          },
          tools: names.map((name) => ({ name, allowed: ctx.isAllowed(config, name) })),
          acl: {
            allow: acl.allow || [],
            deny: acl.deny || [],
            fsRoots: (acl.fsRoots || []).map((r) => ({ path: r, basename: basename(r) })),
            defaultPolicy: 'deny',
            /** The token you used: its id and any narrowing that applies to you only. */
            you: { tokenId: ctx.peerId || null, narrowing: ctx.peerAcl || null }
          },
          shell: {
            enabled: shell.enabled === true,
            allowCommands: shell.allowCommands || [],
            timeoutMs: shell.timeoutMs ?? 60000
          },
          limits: config.limits || {},
          tls: describeCert(ctx.home),
          jobs: ctx.jobs.stats(),
          audit: auditSummary(ctx.home),
          peers: (config.peers || []).map((p) => ({ id: p.id, url: p.url, direction: p.direction || 'outbound' })),
          now: new Date().toISOString()
        })
      }
    }
  ]
}
