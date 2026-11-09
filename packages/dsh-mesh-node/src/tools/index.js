import { buildCore } from './core.js'
import { buildFs } from './fs.js'
import { buildFiles } from './files.js'
import { buildGit } from './git.js'
import { buildShell } from './shell.js'
import { buildTasks } from './tasks.js'
import { buildChannel } from './channel.js'
import { buildHost } from './host.js'
import { buildRepair } from './repair.js'
import { buildRepairFs } from './repair-fs.js'
import { buildCluster } from './cluster.js'
import { buildDelegate } from './delegate.js'
import { buildSessionHistory } from './session-history.js'
import { buildConfigPatch } from './config-patch.js'
import { buildAlerts } from './alerts.js'
import { buildControl } from './control.js'
import { buildControlApps } from './control-apps.js'
import { buildControlPath } from './control-path.js'
import { denied, internal, notFound } from '../core/result.js'
import { short } from '../core/util.js'

/** Every tool spec for this node, built against the current context. */
export function buildAll(ctx) {
  return [
    ...buildCore(ctx),
    ...buildFs(ctx),
    ...buildFiles(ctx),
    ...buildGit(ctx),
    ...buildShell(ctx),
    ...buildTasks(ctx),
    ...buildChannel(ctx),
    ...buildHost(ctx),
    ...buildRepair(ctx),
    ...buildRepairFs(ctx),
    ...buildCluster(ctx),
    ...buildDelegate(ctx),
    ...buildSessionHistory(ctx),
    ...buildConfigPatch(ctx),
    ...buildAlerts(ctx),
    ...buildControl(ctx),
    ...buildControlApps(ctx),
    ...buildControlPath()
  ]
}

export function toolNames(ctx) {
  return buildAll(ctx).map((spec) => spec.name)
}

/** Deny-by-default ACL: `deny` wins over `allow`. */
export function isAllowed(config, name) {
  const acl = config?.acl || {}
  if ((acl.deny || []).includes(name)) return false
  return (acl.allow || []).includes(name)
}

/**
 * Narrow the node-wide config by a per-token ACL (from secrets.json).
 * `allow` = intersection with the node-wide list (a peer can never gain a tool);
 * `deny` = union (a peer-specific denial always wins); `fsRoots` may only narrow.
 */
export function applyPeerAcl(config, peerAcl) {
  if (!peerAcl) return config
  const base = config?.acl || {}
  const baseAllow = base.allow || []
  const peerAllow = Array.isArray(peerAcl.allow) ? peerAcl.allow : null
  const allow = peerAllow ? baseAllow.filter((name) => peerAllow.includes(name)) : baseAllow
  const deny = [...new Set([...(base.deny || []), ...((peerAcl.deny || []))])]
  const fsRoots = Array.isArray(peerAcl.fsRoots) && peerAcl.fsRoots.length > 0 ? peerAcl.fsRoots : base.fsRoots
  return { ...config, acl: { ...base, allow, deny, fsRoots } }
}

/**
 * The single execution path for every tool call, whether it comes from a peer over MCP
 * or from the local job queue. Applies ACL, audits the attempt, and converts thrown
 * errors into structured E_INTERNAL results so a peer always gets an answer.
 */
export async function dispatch(ctx, name, args = {}, { signal, jobId } = {}) {
  const specs = buildAll(ctx)
  const spec = specs.find((s) => s.name === name)
  if (!spec) return notFound(`unknown tool: ${name}`)
  const config = ctx.getConfig()
  if (!isAllowed(config, name)) {
    await ctx.audit({ peer: ctx.peerId, tool: name, ok: false, code: 'E_DENIED', jobId, args: Object.keys(args || {}) })
    return denied(`${name} is not allowed by local ACL`, { allow: config.acl?.allow || [] })
  }
  const started = Date.now()
  try {
    const result = await spec.handler(args, { signal, jobId, peerId: ctx.peerId })
    await ctx.audit({
      peer: ctx.peerId,
      tool: name,
      ok: !result?.isError,
      code: result?.isError ? 'E_TOOL' : undefined,
      ms: Date.now() - started,
      jobId,
      args: Object.keys(args || {})
    })
    return result
  } catch (error) {
    await ctx.audit({
      peer: ctx.peerId,
      tool: name,
      ok: false,
      code: 'E_INTERNAL',
      ms: Date.now() - started,
      jobId,
      message: short(error?.message || error)
    })
    return internal(`${name} failed: ${short(error?.message || error)}`)
  }
}

/** Register every tool on an McpServer; each callback funnels through dispatch(). */
export function registerTools(server, ctx) {
  for (const spec of buildAll(ctx)) {
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema: spec.inputSchema },
      async (args, extra) => dispatch(ctx, spec.name, args, { signal: extra?.signal })
    )
  }
  return server
}
