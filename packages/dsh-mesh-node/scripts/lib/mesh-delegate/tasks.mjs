// @generated mesh-delegate/tasks: 任务侧子命令（status / reply / cancel / gc / list）
// 纯搬移自 scripts/mesh-delegate.mjs（2026-10-25 拆分），行为不变。
import { join } from 'node:path'
import {
  arg,
  sleep,
  now,
  textArg,
  registry,
  saveRegistry,
  peerByName,
  peerCall,
  peerToolCall,
  peerContext,
  readRemoteJson,
  updateRegistry,
  remoteJoin,
  TERMINAL
} from './common.mjs'

export async function status(taskIdArg, waitSec = 0) {
  const registryData = registry()
  const taskId = taskIdArg || arg('task') || Object.keys(registryData.tasks).sort().pop()
  if (!taskId) throw new Error('no taskId (none recorded)')
  const task = registryData.tasks[taskId]
  if (!task) throw new Error(`unknown taskId ${taskId}`)
  const peer = peerByName(task.node)
  const peerRoot = (await peerContext(peer)).fsRoot
  const statusPath = remoteJoin(peerRoot, '.mesh', 'tasks', task.taskId, 'status.json')
  const resultPath = remoteJoin(peerRoot, '.mesh', 'tasks', task.taskId, 'result.json')
  const deadline = Date.now() + Math.max(Number(waitSec), 0) * 1000
  // 2026-11-06：默认 300s → 900s。复杂委托常需 10+ 分钟，300s 会被误判 stalled 而触发重复委托。
  const stallAfter = Math.max(Number(arg('stall-after', 900)), 30) * 1000
  const persist = () =>
    updateRegistry((data) => {
      data.tasks[taskId] = { ...(data.tasks[taskId] || {}), ...task }
      if (TERMINAL.has(task.state) && data.conversations[task.conversationId]) data.conversations[task.conversationId].activeTask = null
      return data
    })
  let last = null
  let lastChangeAt = Date.now()
  let sessionState = null
  const readAgents = async () => {
    try {
      const out = await peerCall(peer, 'channel_agents', task.instance ? { instance: task.instance } : {})
      sessionState = (out.agents || []).find((agent) => agent.id === task.sessionId)?.status || null
    } catch {
      sessionState = null
    }
  }
  for (;;) {
    const state = (await readRemoteJson(peer, statusPath)) || null
    if (state) {
      if (JSON.stringify(state) !== JSON.stringify(last)) lastChangeAt = Date.now()
      last = state
      const nextState = state.state || task.state
      if (!task.startedAt && nextState === 'working') task.startedAt = now()
      task.state = nextState
      task.lastSeenAt = now()
      if (TERMINAL.has(task.state) && !task.finishedAt) task.finishedAt = now()
      registryData.tasks[taskId] = task
      persist()
      if (TERMINAL.has(state.state)) break
      if (state.state === 'question') break
    }
    if (Date.now() >= deadline) {
      await readAgents()
      break
    }
    await sleep(2000)
  }
  if (!last || (!TERMINAL.has(last.state) && last.state !== 'question')) {
    await readAgents()
    let stalledReason = ''
    // 2026-11-06：判定分两档——会话还 running 只是没写心跳，不算 stalled（长任务常态）；
    // 只有会话已经不在了、或长时间连状态都没写，才标 stalled，且 stalled ≠ failed。
    if (sessionState === null) stalledReason = 'target session no longer alive'
    else if (sessionState !== 'running' && Date.now() - lastChangeAt > stallAfter) {
      stalledReason = `no status update for ${Math.round((Date.now() - lastChangeAt) / 1000)}s (stall-after=${stallAfter / 1000}s)`
    }
    if (stalledReason) {
      task.state = 'stalled'
      task.stalledReason = stalledReason
      persist()
    } else if (sessionState === 'running') {
      task.state = 'working'
      task.stalledReason = ''
      persist()
    }
  }
  const result = await readRemoteJson(peer, resultPath)
  const payload = {
    taskId,
    state: task.state,
    question: last?.question || '',
    error: last?.error || '',
    summary: last?.summary || '',
    stalledReason: task.stalledReason || '',
    staleSeconds: Math.round((Date.now() - lastChangeAt) / 1000),
    sessionId: task.sessionId,
    sessionState,
    result
  }
  if (['submitted', 'accepted', 'working', 'stalled', 'unknown'].includes(task.state)) {
    payload.notFailed = true
    payload.advice = 'still running — do NOT re-delegate the same goal; poll this taskId again later (or use --wait with a longer value). 「stalled」只表示心跳停了，不代表失败。'
  }
  if (last?.state === 'question') payload.next = `node scripts/mesh-delegate.mjs reply ${taskId} --text-file <utf8 answer file>`
  console.log(JSON.stringify(payload, null, 2))
  if (task.state === 'done') return 0
  // stalled 归入「仍在跑/不确定」→ exit 3（调用方据此继续轮询）；只有 failed/cancelled 才是 1
  if (['failed', 'cancelled'].includes(task.state)) return 1
  return 3
}

export async function reply() {
  const taskId = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : arg('task')
  const text = textArg('text')
  if (!taskId || !text) throw new Error('usage: mesh-delegate.mjs reply <taskId> --text-file <utf8 file>')
  const registryData = registry()
  const task = registryData.tasks[taskId]
  if (!task) throw new Error(`unknown taskId ${taskId}`)
  const peer = peerByName(task.node)
  const payload = `[dsh-mesh delegation answer]\ntaskId=${taskId}\nconversationId=${task.conversationId}\n${text}`
  const wake = await peerCall(peer, 'channel_wake', { sessionId: task.sessionId, text: payload, target: 'next-turn', ...(task.instance ? { instance: task.instance } : {}) })
  updateRegistry((data) => {
    if (data.tasks[taskId]) {
      data.tasks[taskId].state = 'answered'
      data.tasks[taskId].updatedAt = now()
      if (!data.tasks[taskId].finishedAt) data.tasks[taskId].finishedAt = now()
    }
    return data
  })
  console.log(JSON.stringify({ taskId, conversationId: task.conversationId, delivered: wake.delivered === true, wokeUp: wake.wokeUp === true }, null, 2))
  return 0
}

/**
 * 旧版 mesh 的 cancel：往对端会话注入一条「请停止」，要等当前轮结束才送达
 * （target=next-turn）。2026-11-10 起只在「对端 mesh 没有 delegate_cancel 工具」
 * 时用它，并且必须显式告警——否则调用方会误以为任务已被真中断。
 */
async function legacyWakeCancel(peer, task, startedAt, reasonText) {
  console.error('[warn] 对端版本旧，仅发送停止请求（等当前轮结束才生效）；升级对端 mesh 后 cancel 会直接中断当前轮')
  const wake = await peerCall(peer, 'channel_wake', {
    sessionId: task.sessionId,
    text: `[dsh-mesh delegation cancel]\ntaskId=${task.taskId}\n${reasonText ? `${reasonText}\n` : ''}请停止该任务，不要再写新的结果；如果已经完成到一半，保留已有产物并停止。`,
    target: 'next-turn',
    ...(task.instance ? { instance: task.instance } : {})
  })
  const updatedAt = now()
  updateRegistry((data) => {
    if (data.tasks[task.taskId]) {
      data.tasks[task.taskId].state = 'cancelled'
      data.tasks[task.taskId].cancelVia = 'channel_wake-legacy'
      data.tasks[task.taskId].updatedAt = updatedAt
      data.tasks[task.taskId].finishedAt = updatedAt
    }
    if (data.conversations[task.conversationId]) data.conversations[task.conversationId].activeTask = null
    return data
  })
  console.log(
    JSON.stringify(
      {
        taskId: task.taskId,
        state: 'cancelled',
        via: 'channel_wake-legacy',
        delivered: wake.delivered === true,
        ms: Date.now() - startedAt,
        warning: '对端 mesh 没有 delegate_cancel（旧版），只是发送了停止请求：要等当前轮结束才生效，不是真中断'
      },
      null,
      2
    )
  )
  return 0
}

export async function cancel() {
  const taskId = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : arg('task')
  if (!taskId) throw new Error('usage: mesh-delegate.mjs cancel <taskId>')
  const registryData = registry()
  const task = registryData.tasks[taskId]
  if (!task) throw new Error(`unknown taskId ${taskId}`)
  if (TERMINAL.has(task.state)) throw new Error(`task already ${task.state}`)
  const peer = peerByName(task.node)
  const reasonText = textArg('reason')
  const startedAt = Date.now()
  let out
  try {
    out = await peerToolCall(peer, 'delegate_cancel', reasonText ? { taskId, reason: reasonText } : { taskId }, 30000)
  } catch (error) {
    // 旧版 mesh 的工具清单里没有 delegate_cancel：MCP 层直接拒绝（不是工具返回的错误）。
    const message = String(error?.message || error)
    if (/delegate_cancel/u.test(message) && /not found|unknown tool|method not found/iu.test(message)) {
      return legacyWakeCancel(peer, task, startedAt, reasonText)
    }
    throw error
  }
  if (out.ok) {
    const cancelledAt = out.data?.cancelledAt || now()
    updateRegistry((data) => {
      if (data.tasks[taskId]) {
        data.tasks[taskId].state = 'cancelled'
        data.tasks[taskId].cancelVia = 'delegate_cancel'
        data.tasks[taskId].cancelledAt = cancelledAt
        data.tasks[taskId].updatedAt = cancelledAt
        data.tasks[taskId].finishedAt = cancelledAt
        if (typeof out.data?.wasRunning === 'boolean') data.tasks[taskId].wasRunning = out.data.wasRunning
      }
      if (data.conversations[task.conversationId]) data.conversations[task.conversationId].activeTask = null
      return data
    })
    console.log(
      JSON.stringify(
        {
          taskId,
          state: 'cancelled',
          via: 'delegate_cancel',
          ms: Date.now() - startedAt,
          sessionId: out.data?.sessionId || task.sessionId,
          ...(typeof out.data?.wasRunning === 'boolean' ? { wasRunning: out.data.wasRunning } : {}),
          ...(out.data?.already === true ? { already: true } : {})
        },
        null,
        2
      )
    )
    return 0
  }
  // 有工具但没成功：按错误码原样报错，绝不静默降级（channel_wake 只会排队，archive 会丢状态）。
  if (out.code === 'E_NOT_FOUND' && /unknown tool/iu.test(out.message)) {
    return legacyWakeCancel(peer, task, startedAt, reasonText)
  }
  const hints = {
    E_HOST_NO_CANCEL: `对端 dsh-mesh-host < 0.5.0，需升级插件：在目标节点执行 node scripts/self-update.mjs apply-local --instance <id> 后等热更新（对端节点=${peer.name}）`,
    E_HOST_NO_CONTROLLER: `对端 DSH profile 没挂 sessionController（headless/tui 实例不支持真中断，只有 web 实例支持）；对端=${peer.name}`,
    E_DENIED: `对端 ACL 未放行 delegate_cancel：在目标节点 ~/.dsh-mesh/config.json 的 acl.allow 和调用方 token 的 acl.allow 里加 delegate_cancel`,
    E_NOT_FOUND: `对端没有这个委托任务的登记（.mesh/tasks/${taskId}/request.json）：旧 CLI 委托路径不会在对端写 request.json，只有 MCP delegate 创建的委托才能这样中断；请改用 MCP delegate 重新委托`,
    E_SESSION_GONE: '对端会话已不在（实例重启或会话已结束）；用 status 确认真实状态'
  }
  throw new Error(`delegate_cancel failed on ${peer.name}: [${out.code || 'E_UNKNOWN'}] ${out.message}${hints[out.code] ? `\n  hint: ${hints[out.code]}` : ''}`)
}

export function gc() {
  const days = Number(arg('days', 7))
  const staleMinutes = Number(arg('stale-minutes', 60))
  const cutoff = Date.now() - Math.max(days, 1) * 86400000
  const staleCutoff = Date.now() - Math.max(staleMinutes, 5) * 60000
  let removed = 0
  let stalled = 0
  let selftestRemoved = 0
  updateRegistry((data) => {
    for (const [id, task] of Object.entries(data.tasks)) {
      // selftest 曾把测试任务写进真实台账（已修根因：delegate 用 ctx.home）。历史污染直接清掉。
      if (task.from === 'selftest') {
        delete data.tasks[id]
        selftestRemoved++
        continue
      }
      if (TERMINAL.has(task.state) && new Date(task.updatedAt).getTime() < cutoff) {
        delete data.tasks[id]
        removed++
        continue
      }
      // 非终态但长时间没有心跳 → 标 stalled（UI 不再无限 loading）
      if (!TERMINAL.has(task.state) && new Date(task.updatedAt || task.createdAt || 0).getTime() < staleCutoff) {
        task.state = 'stalled'
        task.stalledReason = `auto: no update for >${staleMinutes}m`
        task.updatedAt = new Date().toISOString()
        stalled++
      }
    }
    for (const conversation of Object.values(data.conversations)) {
      conversation.tasks = (conversation.tasks || []).filter((id) => data.tasks[id])
    }
    return data
  })
  console.log(JSON.stringify({ removed, stalled, selftestRemoved, olderThanDays: days, staleMinutes }, null, 2))
  return 0
}

export function list() {
  const registryData = registry()
  const conversations = Object.values(registryData.conversations).map((conversation) => ({
    conversationId: conversation.conversationId,
    node: conversation.node,
    sessionId: conversation.sessionId,
    activeTask: conversation.activeTask || null,
    tasks: conversation.tasks?.length || 0,
    lastActiveAt: conversation.lastActiveAt
  }))
  const tasks = Object.values(registryData.tasks).map((task) => ({ taskId: task.taskId, conversationId: task.conversationId, state: task.state, goal: task.goal.slice(0, 50), updatedAt: task.updatedAt }))
  console.log(JSON.stringify({ conversations, tasks }, null, 2))
  return 0
}
