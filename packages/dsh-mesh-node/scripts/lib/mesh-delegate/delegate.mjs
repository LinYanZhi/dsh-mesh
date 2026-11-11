// @generated mesh-delegate/delegate: 发起委托（选会话 → 安全校验 → 投递 → 可选等待）
// 纯搬移自 scripts/mesh-delegate.mjs（2026-10-25 拆分），行为不变。
import {
  arg,
  has,
  registry,
  saveRegistry,
  updateRegistry,
  peerByName,
  peerCall,
  peerContext,
  shortId,
  textArg,
  localNodeName,
    instanceName,
  taskPaths,
  writeJson,
  now,
  wakeText,
  TERMINAL,
  findActiveDuplicate
} from './common.mjs'
import { status } from './tasks.mjs'
import { delegationTitle } from '../../../src/core/delegation-title.js'

export async function chooseSession(peer, policy, conversation, forcedSession, workspace, instance, options = {}) {
  const ctx = await peerContext(peer)
  const agents = ctx.agents || []
  if (forcedSession) {
    const forced = agents.find((agent) => agent.id === forcedSession)
    if (!forced) throw new Error(`--session not alive on ${peer.name}: ${forcedSession} — a continuation needs the exact live session returned by a previous delegate`)
    return { sessionId: forced.id, status: forced.status, ctx, created: false, pinned: true, cwd: forced.cwd || '', instance: forced.instance }
  }
  const matching = conversation?.sessionId ? agents.find((agent) => agent.id === conversation.sessionId) : null
  if (policy === 'auto' && matching) {
    return { sessionId: matching.id, status: matching.status, ctx, created: false, cwd: matching.cwd || '', instance: matching.instance }
  }
  if (policy === 'continue') {
    if (!matching) throw new Error(`conversation ${conversation?.conversationId} session not alive on ${peer.name} — run with --policy new to start a fresh conversation`)
    return { sessionId: matching.id, status: matching.status, ctx, created: false, cwd: matching.cwd || '', instance: matching.instance }
  }
  // policy new (default): create a FRESH DSH conversation on the target instance.
  const listed = await peerCall(peer, 'host_instances')
  const alive = (listed.instances || []).filter((host) => host.alive && host.enabled !== false)
  if (alive.length === 0) throw new Error(`no alive host bridge on ${peer.name}`)
  const target = instance ? alive.find((host) => host.id === instance) : alive[0]
  if (!target) throw new Error(`unknown or dead DSH instance "${instance}" on ${peer.name} — alive: ${alive.map((host) => host.id).join(', ')}`)
  // --dry-run must not leave a stray session on the peer (2026-10-25: a dry-run used to
  // create a real conversation that then needed manual archiving).
  if (options.dryRun === true) {
    return { sessionId: null, status: 'planned', ctx, created: false, planned: true, cwd: workspace || '', instance: target.id }
  }
  // DSH >= 0.2.0 refuses a session created without an agent preset ("standing
  // `modelSelectionSettings` requires a scoped preset Context"), so name the web
  // UI's default explicitly; --preset overrides it for custom presets.
  const created = await peerCall(peer, 'host_session_create', {
    instance: target.id,
    ...(workspace ? { cwd: workspace } : {}),
    agentPreset: arg('preset', 'standard'),
    title: delegationTitle(textArg('goal'), arg('title'))
  }, 60000)
  if (!created.sessionId) throw new Error(`host_session_create returned no sessionId on ${peer.name}: ${JSON.stringify(created)}`)
  return { sessionId: created.sessionId, status: 'idle', ctx, created: true, cwd: workspace || '', instance: target.id }
}

/** Pre-flight check: refuse to continue a session that owns scheduled tasks. */
export async function protectedOnPeer(peer, chosen) {
  try {
    const data = await peerCall(peer, 'host_sessions', { instance: chosen.instance, limit: 200, includeEnded: true }, 30000)
    const row = (data.sessions || []).find((session) => session.sessionId === chosen.sessionId)
    if (!row) return { classified: true, blocked: null }
    // Peers older than 0.17.0 do not classify sessions at all: we then cannot prove
    // that this session is safe, so the caller must decide explicitly (--force).
    const classified = typeof row.kind === 'string' && typeof row.protected === 'boolean'
    if (!classified) return { classified: false, blocked: null }
    if (row.protected !== true) return { classified: true, blocked: null }
    const titles = (row.schedules || []).map((schedule) => schedule.title || schedule.id).join(' / ')
    return { classified: true, blocked: `session ${chosen.sessionId} owns scheduled task(s): ${titles || '(unknown)'}` }
  } catch (error) {
    return { classified: false, blocked: null, error: String(error?.message || error) }
  }
}

export async function delegate() {
  const peer = peerByName(arg('to', 'company'))
  const registryData = registry()
  const dedicated = has('dedicated')
  const conversationIdArg = arg('conversation') || (dedicated ? `C-DELEGATION-${peer.name}` : undefined)
  const policy = arg('policy', 'new')
  if (policy === 'continue' && !conversationIdArg) throw new Error('--policy continue requires --conversation <id>')
  const conversation = conversationIdArg ? registryData.conversations[conversationIdArg] : null
  if (policy === 'continue' && !conversation) throw new Error(`unknown conversation ${conversationIdArg}`)
  if (conversation?.activeTask) {
    const active = registryData.tasks[conversation.activeTask]
    if (active && !TERMINAL.has(active.state)) {
      throw new Error(`conversation ${conversation.conversationId} is busy with ${active.taskId} (${active.state}) — wait for it or use --policy new`)
    }
  }
  const dryRun = has('dry-run')
  // 2026-11-06：同一 goal 已有未终态任务 → 直接复用，防止「长任务被误判失败 → 重派 → 重复执行」。
  // --force 可强制新建（人工确认要并行跑两份时）。
  const dup = findActiveDuplicate(registryData, { node: peer.name, goal: textArg('goal') })
  if (dup && !has('force')) {
    console.log(
      JSON.stringify(
        {
          deduped: true,
          taskId: dup.taskId,
          conversationId: dup.conversationId,
          sessionId: dup.sessionId,
          state: dup.state,
          createdAt: dup.createdAt,
          note: '同一 goal 已有未终态任务在跑（可能只是长任务还没写完 status.json）。请用 status 轮询这个 taskId，不要重复委托；确实要并行另开一份才用 --force'
        },
        null,
        2
      )
    )
    return 0
  }
  const chosen = await chooseSession(peer, policy, conversation, arg('session'), arg('workspace'), arg('instance'), { dryRun })
  if (chosen.created !== true && chosen.planned !== true && !has('force')) {
    const guard = await protectedOnPeer(peer, chosen)
    if (guard.blocked) {
      throw new Error(
        `${guard.blocked} on ${peer.name} — delegating into a scheduled/business conversation would pollute it; use --policy new (fresh conversation), or --force if you really mean it`
      )
    }
    if (!guard.classified) {
      throw new Error(
        `cannot verify delegation safety on ${peer.name}: its mesh did not return session classification (peer mesh < 0.17.0, or host_sessions unavailable${guard.error ? `: ${guard.error}` : ''}). ` +
          `Upgrade the peer (git pull + scripts/mesh-restart.mjs) so scheduled sessions are marked protected, or pass --force after checking the session yourself`
      )
    }
  }
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          node: peer.name,
          policy,
          planned: chosen.planned === true,
          created: chosen.created,
          sessionId: chosen.sessionId,
          sessionStatus: chosen.status,
          instance: chosen.instance,
          workspace: chosen.cwd || '',
          ...(chosen.planned ? { note: 'would CREATE a fresh conversation on dispatch (no session created during dry-run)' } : {})
        },
        null,
        2
      )
    )
    return 0
  }
  const conversationId = conversationIdArg || conversation?.conversationId || shortId('C')
  const taskId = shortId('T')
  const task = {
    taskId,
    conversationId,
    from: localNodeName(),
      // 2026-11-07: record the local DSH instance that started this delegation
      fromInstance: instanceName(),
    dedicated,
    policy: chosen.created ? 'new' : 'continue',
    // 2026-11-06：记录「发起方请求的策略」——policy 是归一化后的 effective 值（auto 会被吃掉），审计要看这个
    requestedPolicy: policy,
    policySource: has('session') ? 'session' : has('conversation') ? 'conversation' : 'default',
    node: peer.name,
    sessionId: chosen.sessionId,
    instance: chosen.instance,
    workspace: chosen.cwd || '',
    state: 'submitted',
    createdAt: now(),
    updatedAt: now(),
    goal: textArg('goal'),
    ...(chosen.created ? { title: delegationTitle(textArg('goal'), arg('title')) } : {}),
    scope: textArg('scope'),
    acceptance: textArg('accept'),
    paths: {}
  }
  if (!task.goal) throw new Error('--goal is required')
  task.paths = taskPaths(task, chosen.ctx.fsRoot)
  writeJson(task.paths.requestLocal, {
    taskId,
    conversationId,
    from: task.from,
    to: peer.name,
    dedicated: task.dedicated === true,
    workspace: task.workspace || '',
    goal: task.goal,
    scope: task.scope,
    acceptance: task.acceptance,
    sessionId: chosen.sessionId,
    sessionPinned: chosen.pinned === true,
    sessionPolicy: task.policy,
    createdSession: chosen.created === true,
    instance: chosen.instance,
    requestedAt: now(),
    reply: 'write status.json / result.json under your own .mesh/tasks/<taskId>/'
  })
  updateRegistry((data) => {
    const existing = data.conversations[conversationId]
    data.tasks[taskId] = task
    data.conversations[conversationId] = {
      conversationId,
      node: peer.name,
      dedicated: task.dedicated === true,
      sessionId: chosen.sessionId,
      instance: chosen.instance,
      activeTask: taskId,
      createdAt: existing?.createdAt || now(),
      lastActiveAt: now(),
      tasks: [...(existing?.tasks || []), taskId]
    }
    return data
  })

  // Fresh sessions have no running turn: wake() only queues into a dormant inbox.
  // prompt() drives the first turn; live sessions keep using channel_wake.
  const seqOf = async () => {
    try {
      const listed = await peerCall(peer, 'channel_agents', { instance: chosen.instance })
      const row = (listed?.agents || []).find((agent) => agent.id === chosen.sessionId)
      return row?.seq ?? 0
    } catch {
      return 0
    }
  }
  const baselineSeq = chosen.created ? await seqOf() : 0
  const payloadText = wakeText(task, chosen.ctx.fsRoot)
  const forceFlag = has('force') ? { force: true } : {}
  const delivery = chosen.created
    ? await peerCall(peer, 'host_session_prompt', { sessionId: chosen.sessionId, text: payloadText, mode: 'queue', instance: chosen.instance, ...forceFlag })
    : await peerCall(peer, 'channel_wake', { sessionId: chosen.sessionId, text: payloadText, target: 'next-turn', instance: chosen.instance, ...forceFlag })
  let verification
  if (chosen.created) {
    // prompt admission != a running turn; watch seq briefly so a broken model/runtime
    // shows up as a warning instead of eternal "submitted".
    let started = false
    let seq = baselineSeq
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      seq = await seqOf()
      if (seq > baselineSeq) {
        started = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    verification = { started, baselineSeq, seq }
  }
  const delivered = chosen.created ? delivery.accepted === true : delivery.delivered === true
  const wokeUp = chosen.created ? delivery.accepted === true : delivery.wokeUp === true
  const result = { taskId, conversationId, policy: task.policy, node: peer.name, sessionId: chosen.sessionId, instance: chosen.instance, createdSession: chosen.created === true, workspace: chosen.cwd || '', sessionStatusBefore: chosen.status, dispatchedBy: chosen.created ? 'host_session_prompt' : 'channel_wake', delivered, wokeUp, ...(verification ? { verification } : {}) }
  if (verification && !verification.started) {
    result.warning = 'prompt accepted, but the session seq did not advance within 3000ms — check that instance\'s runtime/model health; the session can still be continued later via --session-id.'
  }
  console.log(JSON.stringify({ ...result, request: task.paths.requestLocal }, null, 2))
  const waitSec = Number(arg('wait', 0))
  if (waitSec > 0) return status(taskId, waitSec)
  return 0
}
