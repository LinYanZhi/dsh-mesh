// dsh-mesh-ui — 浏览器半（client plugin bundle）v3
//
// 手写成 DSH 期望的形状：window.__ModuleLoader__.load({ id, factory(require) })，react 由平台提供。
// 设置窗口 settings.section（契约：id 必填 + label）→「AI 网络」：
//
//   ┌ 头部：标题 / verdict / 版本 / 时间 / 刷新 / 复制诊断 / 原始 JSON
//   ├ 画布（viewport）：滚轮缩放（以鼠标为中心）、拖拽平移、双击复位、缩放按钮、自适应 fit
//   │    画布内 = 世界坐标（1080×680）：本机居中 + peer 卡片 + 曲线连线 + 延迟标签
//   └ 折叠面板：本机实例 / 委托台账 / 告警历史 / 诊断建议（默认收起，省垂直空间）
//
// 2026-11-06 v3 重做（用户反馈：v2 卡片/连线糟糕、设置面板窄导致内容看不见、缺缩放拖拽）。
//
// 归宿：reusable（dsh-mesh/plugin/dsh-mesh-ui/lib/）

window.__ModuleLoader__.load({
  id: 'dsh-mesh-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    var API = '/api/dsh-mesh/status'
    var REFRESH_MS = 10000
    var SUPPORTS_ZOOM = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('zoom', '1.5')

    // 2026-11-07 用户要求：卡片标题只用固定中文叫法，不显示电脑设备名
    var NODE_LABELS = {}
      // 同一台设备可能有多个 peer 记录（不同 token/入口：phone-node / phone-node-lan / phone-node-exec）。
  // AI 网络拓扑按「设备」展示：去掉后缀归并，取可达且延迟最优的那条。
  var PEER_SUFFIX = /-(lan|wan|exec|exe|import|local|ctl)$/i
  function peerDeviceKey(name) {
    var n = String(name || '').trim().toLowerCase()
    return n.replace(PEER_SUFFIX, '')
  }
  function dedupePeers(list) {
    var byKey = {}
    var order = []
    ;(list || []).forEach(function (peer) {
      var key = peerDeviceKey(peer.name)
      if (!byKey[key]) { byKey[key] = peer; order.push(key); return }
      var cur = byKey[key]
      var better = false
      if (!cur.up && peer.up) better = true
      else if (Boolean(cur.up) === Boolean(peer.up)) {
        var a = cur.latencyMs == null ? 1e9 : cur.latencyMs
        var b = peer.latencyMs == null ? 1e9 : peer.latencyMs
        if (b < a) better = true
        else if (b === a && (peer.instancesCount || 0) > (cur.instancesCount || 0)) better = true
      }
      if (better) byKey[key] = peer
    })
    return order.map(function (k) { return byKey[k] })
  }
function filterSelfPeers(list, nodeName) {
    var selfKey = peerDeviceKey(nodeName)
    return (list || []).filter(function (peer) { return !selfKey || peerDeviceKey(peer.name) !== selfKey })
  }
function nodeLabel(name) { return NODE_LABELS[String(name || '').toLowerCase()] || String(name || '未知节点') }
    // [relay-helpers-begin] 2026-11-09 架构层：识别公网中转站(frps)与通信方式（纯函数，可单测）
    // 判定：同一公网 host 被 >=2 个 peer 使用 → 视为共享中转站；LAN/loopback 不算。
    var RELAY_PUBLIC_KINDS = { wan: 1, frp: 1 }
    function relayGroups(peers) {
      var groups = {}
      var order = []
      ;(peers || []).forEach(function (peer) {
        var t = peer.tunnel || {}
        var host = String(t.host || '').trim().toLowerCase()
        if (!host || !RELAY_PUBLIC_KINDS[t.kind]) return
        var g = groups[host]
        if (!g) { g = groups[host] = { host: t.host || host, hostKey: host, kind: t.kind, peers: [], ports: {}, up: 0 }; order.push(host) }
        g.peers.push(peer)
        if (t.port) g.ports[String(t.port)] = (g.ports[String(t.port)] || 0) + 1
        if (peer.up) g.up++
      })
      return order.map(function (k) { return groups[k] })
        .filter(function (g) { return g.peers.length >= 2 })
        .sort(function (a, b) { return b.peers.length - a.peers.length })
    }
    function relayHostSet(peers) {
      var set = {}
      relayGroups(peers).forEach(function (g) { set[g.hostKey] = g })
      return set
    }
    function commLabel(peer, relayHosts) {
      var t = peer.tunnel || {}
      var host = String(t.host || '').toLowerCase()
      if (!host) return { text: '—', short: '—' }
      var relay = relayHosts && relayHosts[host]
      var port = t.port ? ':' + t.port : ''
      if (relay) return { text: (relay.kind === 'frp' ? '域名穿透' : '自建 frps 中转') + ' · ' + relay.host + port, short: '中转' + (t.port ? ' ' + t.port : '') }
      if (t.kind === 'loopback') return { text: '本机回环', short: '本机' }
      if (t.kind === 'lan') return { text: '局域网直连 · ' + t.host + port, short: 'LAN' }
      if (t.kind === 'frp') return { text: '公网穿透 · ' + t.host + port, short: '穿透' }
      if (t.kind === 'wan') return { text: '公网直连 · ' + t.host + port, short: '公网' }
      return { text: (t.label || t.kind || '未知') + ' · ' + t.host + port, short: t.label || '未知' }
    }
    // [relay-helpers-end]
    var W = 560
    var H = 400
    var MIN_SCALE = 0.35
    var MAX_SCALE = 2.6

    var CSS = `
.dm-root { display:flex; flex-direction:column; gap:12px; font-size:13px; line-height:1.5; color:inherit; }
.dm-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dm-title { font-size:15.5px; font-weight:650; letter-spacing:.2px; }
.dm-sub { font-size:11.5px; opacity:.55; }
.dm-pill { padding:1px 9px; border-radius:999px; font-size:11.5px; font-weight:600; border:1px solid transparent; }
.dm-pill.ok { background:rgba(63,185,80,.14); color:#2e9e4f; border-color:rgba(63,185,80,.35); }
.dm-pill.bad { background:rgba(248,81,73,.14); color:#c9362c; border-color:rgba(248,81,73,.35); }
.dm-pill.warn { background:rgba(210,153,34,.16); color:#9a6c12; border-color:rgba(210,153,34,.4); }
.dm-pill.muted { background:rgba(128,128,128,.12); color:inherit; border-color:rgba(128,128,128,.28); opacity:.8; }
.dm-btn { font-size:11.5px; padding:3px 10px; border-radius:7px; border:1px solid rgba(128,128,128,.38); background:transparent; color:inherit; cursor:pointer; white-space:nowrap; }
.dm-btn:hover { background:rgba(128,128,128,.12); }
.dm-btn.primary { border-color:rgba(88,166,255,.55); color:#3b82d6; }

/* 画布视口 */
.dm-viewport { position:relative; width:100%; height:clamp(240px, 34vh, 380px); min-height:220px; overflow:hidden; border-radius:12px;
  border:1px solid rgba(128,128,128,.22); background:
  radial-gradient(ellipse at 50% 45%, rgba(88,166,255,.07), transparent 60%),
  linear-gradient(rgba(128,128,128,.05) 1px, transparent 1px) 0 0/26px 26px,
  linear-gradient(90deg, rgba(128,128,128,.05) 1px, transparent 1px) 0 0/26px 26px;
  cursor:grab; touch-action:none; user-select:none; }
.dm-viewport.dragging { cursor:grabbing; }
.dm-world-outer { position:absolute; left:0; top:0; }
.dm-world { position:absolute; left:0; top:0; transform-origin:0 0; }
.dm-lines { position:absolute; left:0; top:0; overflow:visible; pointer-events:none; }
.dm-world-label { position:absolute; left:10px; top:8px; font-size:11px; opacity:.5; font-variant-numeric:tabular-nums; }

/* 节点卡片（世界坐标里） */
.dm-card-node { position:absolute; box-sizing:border-box; overflow:visible; border-radius:12px; padding:10px 12px;
    border:1px solid rgba(128,128,128,.3); background:rgba(128,128,128,.06); color:inherit; box-shadow:0 6px 22px rgba(0,0,0,.10); }
  .dm-card-node.local { border-width:1.6px; border-color:rgba(88,166,255,.55); background:rgba(88,166,255,.10); }
  .dm-card-node.down { border-style:dashed; border-color:rgba(248,81,73,.6); background:rgba(248,81,73,.07); }
  .dm-card-node.down .dm-n-name { opacity:1; }
  .dm-card-node.down .dm-card-domain, .dm-card-node.down .dm-card-dsh { opacity:.62; }
  .dm-card-node.down .dm-v, .dm-card-node.down .dm-big, .dm-card-node.down .dm-extra { opacity:.6; }
  .dm-card-node.down .dm-chip { opacity:.72; }
  .dm-offline-row { margin-top:5px; font-size:10.5px; color:#c9362c; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dm-n-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.dm-n-name { font-weight:650; font-size:13px; display:flex; align-items:center; gap:7px; min-width:0; }
.dm-n-name span.dm-ell { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dm-dot { width:9px; height:9px; border-radius:50%; display:inline-block; background:#8b949e; flex:none; }
.dm-dot.ok { background:#2e9e4f; box-shadow:0 0 0 3px rgba(63,185,80,.18); }
.dm-dot.bad { background:#d14b41; box-shadow:0 0 0 3px rgba(248,81,73,.18); }
.dm-big { font-size:17px; font-weight:650; font-variant-numeric:tabular-nums; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.dm-unit { font-size:11px; opacity:.55; margin-left:2px; }
.dm-row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:5px; font-size:11.5px; }
.dm-k { opacity:.58; font-size:11px; }
.dm-v { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px; font-variant-numeric:tabular-nums; }
.dm-mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.dm-mini { display:flex; gap:4px; flex-wrap:wrap; margin-top:6px; }
.dm-extra { font-size:11px; opacity:.6; font-variant-numeric:tabular-nums; }
.dm-card-node.compact { padding:9px 11px; cursor:pointer; transition:border-color .12s, box-shadow .12s; }
.dm-card-node.selected { border-color:rgba(88,166,255,.85) !important; box-shadow:0 0 0 2px rgba(88,166,255,.35), 0 6px 18px rgba(0,0,0,.12) !important; }
.dm-card-domain { margin-top:6px; font-size:10px; opacity:.72; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.dm-card-dsh { margin-top:6px; }
.dm-devices { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; align-items:start; }
.dm-device { border:1px solid rgba(128,128,128,.22); border-radius:11px; padding:9px 11px; background:rgba(128,128,128,.035); min-width:0; overflow:hidden; }
.dm-device.selected { border-color:rgba(88,166,255,.6); background:rgba(88,166,255,.07); }
.dm-device-head { display:flex; align-items:center; gap:7px; font-weight:650; font-size:12.5px; margin-bottom:6px; }
.dm-device-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dm-device-body { display:flex; flex-direction:column; gap:3px; }
.dm-device-row { display:flex; align-items:baseline; justify-content:space-between; gap:10px; font-size:11px; min-width:0; }
.dm-device-k { opacity:.55; flex:0 0 auto; }
.dm-device-v { flex:1 1 auto; min-width:0; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; }
@media (max-width:720px) { .dm-devices { grid-template-columns:1fr; } }
.dm-fields { display:grid; grid-template-columns:1fr 1fr; gap:4px 10px; margin-top:6px; }
.dm-field { min-width:0; }
.dm-field-k { font-size:9.5px; opacity:.5; line-height:1.2; }
.dm-field-v { font-size:11px; line-height:1.35; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric:tabular-nums; }
.dm-tunnel { margin-top:6px; font-size:10px; opacity:.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dm-chip { font-size:9.5px; padding:0 6px; border-radius:999px; border:1px solid rgba(128,128,128,.3); opacity:.85; white-space:nowrap; }
.dm-chip.run { border-color:rgba(63,185,80,.45); color:#2e9e4f; opacity:1; }
.dm-chip.warn { border-color:rgba(210,153,34,.5); color:#9a6c12; opacity:1; }
.dm-chip.bad { border-color:rgba(248,81,73,.5); color:#c9362c; opacity:1; }
.dm-chip.ok { border-color:rgba(63,185,80,.4); color:#2e9e4f; opacity:1; }

/* 画布浮层控件 */
.dm-zoom { position:absolute; right:8px; bottom:8px; display:flex; gap:5px; padding:4px; border-radius:9px;
  background:rgba(128,128,128,.12); backdrop-filter:blur(4px); z-index:5; }
.dm-zoom button { width:22px; height:22px; border-radius:6px; border:1px solid rgba(128,128,128,.3); background:transparent; color:inherit; cursor:pointer; font-size:14px; line-height:1; }
.dm-zoom button:hover { background:rgba(128,128,128,.16); }
.dm-zoom .pct { font-size:10.5px; opacity:.6; align-self:center; padding:0 2px; font-variant-numeric:tabular-nums; }
.dm-hint { position:absolute; left:8px; bottom:8px; font-size:10.5px; opacity:.45; pointer-events:none; z-index:5; }

/* 折叠面板 */
.dm-details { border:1px solid rgba(128,128,128,.22); border-radius:11px; background:rgba(128,128,128,.035); }
.dm-details > summary { cursor:pointer; padding:9px 12px; font-weight:600; font-size:12.5px; list-style:none; display:flex; align-items:center; gap:8px; }
.dm-details > summary::-webkit-details-marker { display:none; }
.dm-details > summary::before { content:'▸'; font-size:10px; opacity:.5; transition:transform .12s; }
.dm-details[open] > summary::before { transform:rotate(90deg); }
.dm-details > .dm-body { padding:0 12px 11px; }
.dm-table { width:100%; border-collapse:collapse; }
.dm-table th { text-align:left; font-weight:600; font-size:11px; opacity:.5; padding:2px 8px 5px 0; border-bottom:1px solid rgba(128,128,128,.2); white-space:nowrap; }
.dm-table td { padding:5px 8px 5px 0; border-bottom:1px solid rgba(128,128,128,.1); font-size:12px; }
.dm-table tr:last-child td { border-bottom:none; }
.dm-trunc { max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:inline-block; vertical-align:bottom; }
.dm-instrow { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid rgba(128,128,128,.1); }
.dm-instrow:last-child { border-bottom:none; }
.dm-alertrow { display:flex; gap:8px; align-items:baseline; padding:5px 0; border-bottom:1px dashed rgba(128,128,128,.16); font-size:12px; }
.dm-alertrow:last-child { border-bottom:none; }
.dm-empty { opacity:.55; font-size:12px; padding:4px 0; }
.dm-err { color:#c9362c; font-size:12px; }
.dm-foot { font-size:11px; opacity:.45; }
@media (prefers-color-scheme: dark) {
  .dm-pill.ok { color:#3fb950; } .dm-pill.bad { color:#ff7b72; } .dm-pill.warn { color:#d29922; }
  .dm-btn.primary { color:#79b8ff; }
  .dm-card-node { background:#1d2025; box-shadow:0 8px 26px rgba(0,0,0,.45); }
  .dm-card-node.local { background:#19222e; }
    .dm-card-node.down { background:rgba(90,32,32,.45); border-color:rgba(248,81,73,.65); }
    .dm-offline-row { color:#ff7b72; }
  .dm-dot.ok { background:#3fb950; } .dm-dot.bad { background:#ff7b72; }
  .dm-chip.run, .dm-chip.ok { color:#3fb950; } .dm-chip.warn { color:#d29922; } .dm-chip.bad { color:#ff7b72; }
  .dm-err { color:#ff7b72; }
  .dm-details { background:rgba(255,255,255,.025); }
}
/* 2026-11-09 架构层：公网中转站（frps） */
.dm-relay { border:1px solid rgba(128,128,128,.22); border-radius:12px; padding:10px 12px; background:rgba(128,128,128,.035); display:flex; flex-direction:column; gap:10px; }
.dm-relay-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.dm-relay-title { font-size:12.5px; font-weight:650; }
.dm-relay-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px; border:1px dashed rgba(128,128,128,.26); border-radius:10px; }
.dm-relay-end { min-width:120px; display:flex; flex-direction:column; gap:2px; }
.dm-relay-name { font-size:12px; font-weight:650; }
.dm-relay-sub { font-size:10.5px; opacity:.55; }
.dm-relay-hub { min-width:190px; display:flex; flex-direction:column; gap:4px; padding:8px 10px; border:1.4px solid rgba(210,153,34,.55); border-radius:10px; background:rgba(210,153,34,.10); }
.dm-relay-chips { display:flex; gap:5px; flex-wrap:wrap; }
.dm-relay-link { display:flex; align-items:center; gap:5px; min-width:56px; color:rgba(128,128,128,.75); }
.dm-relay-line { flex:1 1 auto; height:0; border-top:1.6px dashed rgba(63,185,80,.55); }
.dm-relay-dirlabel { font-size:10px; opacity:.6; white-space:nowrap; }
.dm-relay-peers { display:flex; flex-direction:column; gap:4px; min-width:150px; flex:1 1 auto; }
.dm-relay-peer { display:flex; align-items:center; gap:6px; font-size:11.5px; }
.dm-relay-peer.down { opacity:.55; }
.dm-relay-peer-name { font-weight:600; }
.dm-relay-peer-meta { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:10.5px; opacity:.7; }
.dm-relay-direct { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11px; }
.dm-relay-tag { margin-top:5px; font-size:10px; opacity:.75; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
`

    function fetchStatus(force) {
      return fetch(force ? API + '?force=1' : API, { headers: { accept: 'application/json' } }).then(function (res) { return res.json() })
    }
    function tone(verdict) {
      if (verdict === 'ok') return 'ok'
      if (verdict === 'down') return 'bad'
      if (verdict === 'degraded') return 'warn'
      return 'muted'
    }
    function ago(iso) {
      if (!iso) return '—'
      var diff = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
      if (diff < 60) return diff + ' 秒前'
      if (diff < 3600) return Math.round(diff / 60) + ' 分钟前'
      if (diff < 86400) return Math.round(diff / 3600) + ' 小时前'
      return Math.round(diff / 86400) + ' 天前'
    }
    function clockText(iso) {
      if (!iso) return '—'
      var d = new Date(iso)
      if (isNaN(d.getTime())) return '—'
      function p2(n) { return (n < 10 ? '0' : '') + n }
      return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
    }
    function uptimeText(sec) {
      if (sec == null) return '—'
      var s = Math.max(0, Number(sec))
      var days = Math.floor(s / 86400)
      var hours = Math.floor((s % 86400) / 3600)
      var mins = Math.floor((s % 3600) / 60)
      if (days > 0) return days + '天' + hours + '小时'
      if (hours > 0) return hours + '小时' + mins + '分'
      return mins + '分'
    }
    function dur(sec) {
      if (sec == null) return '—'
      if (sec < 60) return sec + 's'
      if (sec < 3600) return Math.floor(sec / 60) + 'm' + (sec % 60) + 's'
      return Math.floor(sec / 3600) + 'h' + Math.floor((sec % 3600) / 60) + 'm'
    }
    function stateChip(state) {
      // 设置页表格里的状态也统一中文
      var map = { done: 'ok', failed: 'bad', cancelled: 'muted', stalled: 'warn', working: 'run', question: 'warn', submitted: 'muted', accepted: 'muted' }
      return h('span', { className: 'dm-chip ' + (map[state] || 'muted') }, DG_STATE_LABELS[state] || state || '未知')
    }

    function Spark(props) {
      var values = props.values || []
      var pts = values.filter(function (v) { return v != null })
      if (pts.length < 2) return h('span', { className: 'dm-sub' }, '—')
      var min = Math.min.apply(null, pts)
      var max = Math.max.apply(null, pts)
      var span = max - min || 1
      var SW = 54
      var SH = 15
      var d = []
      var open = false
      values.forEach(function (v, i) {
        if (v == null) { open = false; return }
        var x = (i / Math.max(1, values.length - 1)) * SW
        var y = SH - ((v - min) / span) * (SH - 4) - 2
        d.push((open ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1))
        open = true
      })
      return h('svg', { width: SW, height: SH, viewBox: '0 0 ' + SW + ' ' + SH, style: { overflow: 'visible' } },
        h('path', { d: d.join(' '), fill: 'none', stroke: props.up ? '#2e9e4f' : '#d14b41', strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round' })
      )
    }

    // ---------- 画布：缩放 / 平移 ----------
    function Viewport(props) {
      var layout = props.layout
      var viewRef = useRef(null)
      var dragRef = useRef(null)
      var interactedRef = useRef(false)
      var s0 = useState({ scale: 1, x: 0, y: 0 }); var view = s0[0]; var setView = s0[1]
      var s1 = useState(false); var dragging = s1[0]; var setDragging = s1[1]

      var fit = useCallback(function () {
        var el = viewRef.current
        if (!el) return
        var rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        var scale = Math.min(rect.width / layout.W, rect.height / layout.H) * 0.94
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
        setView({ scale: scale, x: (rect.width - layout.W * scale) / 2, y: (rect.height - layout.H * scale) / 2 })
      }, [layout.W, layout.H])

      useEffect(function () {
        fit()
        var el = viewRef.current
        if (!el || typeof ResizeObserver === 'undefined') return
        var ro = new ResizeObserver(function () {
          if (!interactedRef.current) fit()
        })
        ro.observe(el)
        return function () { try { ro.disconnect() } catch (_) { /* ignore */ } }
      }, [fit])

      useEffect(function () {
        var el = viewRef.current
        if (!el) return
        function onWheel(event) {
          event.preventDefault()
          var rect = el.getBoundingClientRect()
          var px = event.clientX - rect.left
          var py = event.clientY - rect.top
          var factor = Math.pow(1.0015, -event.deltaY)
          interactedRef.current = true
          setView(function (prev) {
            var next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * factor))
            var k = next / prev.scale
            return { scale: next, x: px - (px - prev.x) * k, y: py - (py - prev.y) * k }
          })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return function () { el.removeEventListener('wheel', onWheel) }
      }, [])

      function onPointerDown(event) {
        if (event.button !== 0) return
        if (event.target && event.target.closest && event.target.closest('button,a,summary')) return
        dragRef.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }
        setDragging(true)
        event.currentTarget.setPointerCapture && event.currentTarget.setPointerCapture(event.pointerId)
      }
      function onPointerMove(event) {
        var drag = dragRef.current
        if (!drag) return
        interactedRef.current = true
        setView(function (prev) { return { scale: prev.scale, x: drag.vx + (event.clientX - drag.x), y: drag.vy + (event.clientY - drag.y) } })
      }
      function endDrag() { dragRef.current = null; setDragging(false) }

      function zoomBy(multiplier) {
        var el = viewRef.current
        if (!el) return
        var rect = el.getBoundingClientRect()
        var px = rect.width / 2
        var py = rect.height / 2
        interactedRef.current = true
        setView(function (prev) {
          var next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * multiplier))
          var k = next / prev.scale
          return { scale: next, x: px - (px - prev.x) * k, y: py - (py - prev.y) * k }
        })
      }

      return h('div', { className: 'dm-viewport' + (dragging ? ' dragging' : ''), ref: viewRef,
        onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onPointerLeave: endDrag,
        onDoubleClick: function () { interactedRef.current = false; fit() } },
        // 2026-11-07：缩放改用 CSS zoom（重新布局、文字矢量重绘 → 放大不糊）；
        // 平移用外层 transform（不参与光栅缓存）。不再使用 will-change，避免整块被缓存成位图后放大发虚。
        h('div', { className: 'dm-world-outer', style: { transform: 'translate(' + view.x + 'px,' + view.y + 'px)' } },
          h('div', { className: 'dm-world', style: Object.assign({ width: layout.W + 'px', height: layout.H + 'px' },
            SUPPORTS_ZOOM ? { zoom: view.scale } : { transform: 'scale(' + view.scale + ')' }) },
            h(Topology, { data: props.data, layout: layout, selectedKey: props.selectedKey, onSelect: props.onSelect })
          )
        ),
        h('div', { className: 'dm-zoom' },
          h('button', { title: '放大', onClick: function () { zoomBy(1.22) } }, '+'),
          h('button', { title: '缩小', onClick: function () { zoomBy(1 / 1.22) } }, '−'),
          h('button', { title: '自适应', onClick: function () { interactedRef.current = false; fit() } }, '⤢'),
          h('span', { className: 'pct' }, Math.round(view.scale * 100) + '%')
        ),
        h('div', { className: 'dm-hint' }, '滚轮缩放 · 拖拽平移 · 双击复位')
      )
    }

    // ---------- 布局计算 ----------
    // 用户偏好（2026-11-07 明确）：
    //   4 节点 = 菱形（上/右/下/左）；5 节点 = 顶点朝上的五边形；6 = 六边形；n 节点 = 顶点朝上的正 n 边形。
    //   相邻节点的「轴对齐包围盒」必须留出 GAP，否则菱形斜向两张卡会贴住/重叠。
    function computeLayout(count) {
      var GAP = 30
      var cardW = count <= 4 ? 176 : count <= 6 ? 152 : 136
      var cardH = count <= 4 ? 104 : count <= 6 ? 96 : 88
      var PAD = 16
      var W
      var H
      var positions
      if (count <= 1) {
        W = cardW + PAD * 2
        H = cardH + PAD * 2
        positions = [[W / 2, H / 2]]
      } else if (count === 2) {
        W = cardW * 2 + GAP + PAD * 2
        H = cardH + PAD * 2
        positions = [[PAD + cardW / 2, H / 2], [PAD + cardW + GAP + cardW / 2, H / 2]]
      } else if (count === 4) {
        // 菱形：rx - cardW = ry - cardH = GAP → 水平/垂直相邻间隙都正好 GAP
        var rx4 = cardW + GAP
        var ry4 = cardH + GAP
        W = Math.ceil(2 * (rx4 + cardW / 2) + PAD * 2)
        H = Math.ceil(2 * (ry4 + cardH / 2) + PAD * 2)
        positions = []
        for (var i4 = 0; i4 < 4; i4++) {
          var a4 = (-90 + i4 * 90) * Math.PI / 180 // -90, 0, 90, 180 → 上 右 下 左
          positions.push([W / 2 + rx4 * Math.cos(a4), H / 2 + ry4 * Math.sin(a4)])
        }
      } else {
        // 正多边形：半径从弦长下限开始递增，直到任意两节点包围盒都分离
        var MARGIN = 16
        var R = (Math.max(cardW, cardH) + GAP) / (2 * Math.sin(Math.PI / count))
        for (var step = 0; step < 500; step++) {
          var pts = []
          for (var p = 0; p < count; p++) {
            var ap = (-90 + p * (360 / count)) * Math.PI / 180
            pts.push([R * Math.cos(ap), R * Math.sin(ap)])
          }
          var ok = true
          for (var x = 0; x < count && ok; x++) {
            for (var y = x + 1; y < count; y++) {
              var dx = Math.abs(pts[x][0] - pts[y][0])
              var dy = Math.abs(pts[x][1] - pts[y][1])
              if (dx < cardW + MARGIN && dy < cardH + MARGIN) { ok = false; break }
            }
          }
          if (ok) break
          R += 2
        }
        W = Math.ceil(2 * (R + cardW / 2) + PAD * 2)
        H = Math.ceil(2 * (R + cardH / 2) + PAD * 2)
        positions = []
        for (var j = 0; j < count; j++) {
          var aj = (-90 + j * (360 / count)) * Math.PI / 180
          positions.push([W / 2 + R * Math.cos(aj), H / 2 + R * Math.sin(aj)])
        }
      }
      var edges = []
      for (var m = 0; m < count; m++) for (var n = m + 1; n < count; n++) edges.push([m, n])
      return { count: count, cardW: cardW, cardH: cardH, gap: GAP, W: W, H: H, positions: positions, edges: edges }
    }
    // ---------- 架构层：公网中转站（frps）与各节点通信关系（2026-11-09） ----------
    function RelayLayer(props) {
      var data = props.data || {}
      var peers = filterSelfPeers(dedupePeers(data.peers || []), data.nodeName)
      var groups = relayGroups(peers)
      var relayHosts = relayHostSet(peers)
      var direct = peers.filter(function (p) { var t = p.tunnel || {}; return t.kind === 'lan' || t.kind === 'loopback' })
      var instances = (data.local && data.local.instances) || []
      var localUp = instances.filter(function (x) { return x.up }).length
      if (!groups.length && !direct.length) return null
      return h('div', { className: 'dm-relay' },
        h('div', { className: 'dm-relay-head' },
          h('span', { className: 'dm-relay-title' }, '架构层 · 公网中转站'),
          h('span', { className: 'dm-sub' }, groups.length ? '虚线 = 经中转；实线/标签 = 直连。端口是各节点在中转站上的隧道入口' : '当前没有共享公网中转的 peer，全部为直连')
        ),
        groups.map(function (g, gi) {
          var ports = Object.keys(g.ports).sort()
          return h('div', { className: 'dm-relay-row', key: 'g' + gi },
            h('div', { className: 'dm-relay-end' },
              h('div', { className: 'dm-relay-name' }, nodeLabel(data.nodeName) + '（本机）'),
              h('div', { className: 'dm-relay-sub' }, 'DSH ' + localUp + '/' + instances.length + ' 在线')
            ),
            h('div', { className: 'dm-relay-link' }, h('span', { className: 'dm-relay-line' }), h('span', { className: 'dm-relay-dirlabel' }, '出站')),
            h('div', { className: 'dm-relay-hub' },
              h('div', { className: 'dm-relay-name' }, '公网中转站 · frps'),
              h('div', { className: 'dm-relay-sub dm-mono' }, g.host),
              h('div', { className: 'dm-relay-chips' },
                ports.map(function (p) { return h('span', { className: 'dm-chip', key: p, title: '隧道入口 :' + p }, ':' + p + ' ×' + g.ports[p]) }),
                h('span', { className: 'dm-chip ' + (g.up === g.peers.length ? 'run' : 'bad') }, '在线 ' + g.up + '/' + g.peers.length)
              )
            ),
            h('div', { className: 'dm-relay-link' }, h('span', { className: 'dm-relay-line' }), h('span', { className: 'dm-relay-dirlabel' }, '中转')),
            h('div', { className: 'dm-relay-peers' }, g.peers.map(function (peer) {
              var t = peer.tunnel || {}
              return h('div', { className: 'dm-relay-peer' + (peer.up ? '' : ' down'), key: peer.name },
                h('span', { className: 'dm-dot ' + (peer.up ? 'ok' : 'bad') }),
                h('span', { className: 'dm-relay-peer-name' }, nodeLabel(peerDeviceKey(peer.name))),
                h('span', { className: 'dm-relay-peer-meta' }, (t.port ? ':' + t.port : '') + (peer.up && peer.latencyMs != null ? ' · ' + peer.latencyMs + 'ms' : ' · 离线'))
              )
            }))
          )
        }),
        direct.length ? h('div', { className: 'dm-relay-direct' },
          h('span', { className: 'dm-k' }, '直连：'),
          direct.map(function (peer) {
            var c = commLabel(peer, relayHosts)
            return h('span', { className: 'dm-chip ' + (peer.up ? 'run' : 'bad'), key: peer.name, title: c.text }, nodeLabel(peerDeviceKey(peer.name)) + ' · ' + c.text)
          })
        ) : null
      )
    }

    // ---------- 拓扑：极简卡片（名称 / 穿透域名 / DSH 数）+ 点击选中 ----------
    function Topology(props) {
      var data = props.data
      var layout = props.layout
      var peers = filterSelfPeers(dedupePeers(data.peers || []), data.nodeName)
      var relayHosts = relayHostSet(peers)
      var endpoint = data.endpoint || {}
      var instances = (data.local && data.local.instances) || []
      var hw = data.hardware || {}
      var localTunnel = data.localTunnel || {}
      var localUp = instances.filter(function (x) { return x.up }).length
      var localTunnelText = localTunnel.port
        ? (localTunnel.frpRunning ? (localTunnel.frpCount ? localTunnel.frpCount : '') : '') || ''
        : ''

      function localDomain() {
        var entry = localTunnel.publicEntry
        if (entry && entry.host) return entry.host + ':' + entry.port
        if (localTunnel.frpRunning) return 'SakuraFrp 已开 · ' + (localTunnel.bind || '?') + ':' + localTunnel.port
        if (localTunnel.port) return '未开穿透 · ' + (localTunnel.bind || '?') + ':' + localTunnel.port
        return '未配置'
      }
      function peerDomain(peer) {
        var t = peer.tunnel || {}
        if (!t.host) return '—'
        return t.host + (t.port ? ':' + t.port : '') + (t.kind === 'lan' ? '（内网）' : '')
      }

      var nodes = [{
        key: 'local',
        local: true,
        up: Boolean(endpoint.up),
        name: nodeLabel(data.nodeName) + '（本机）',
        domain: localDomain(),
        dsh: localUp + '/' + instances.length,
        ports: instances.map(function (inst) { return { port: inst.port, up: inst.up } }),
        extra: ''
      }].concat(peers.map(function (peer) {
        var t = peer.tunnel || {}
        var tunnelText = peer.tunnelText || ''
        return {
          key: 'peer:' + peer.name,
          local: false,
          up: Boolean(peer.up),
          name: nodeLabel(peerDeviceKey(peer.name)),
          domain: peerDomain(peer),
          comm: commLabel(peer, relayHosts).short,
          dsh: String(peer.instancesCount || 0),
          ports: peer.instancesList || [],
          extra: peer.up ? (peer.latencyMs == null ? '' : peer.latencyMs + 'ms') : '离线',
          error: peer.error || '',           detectedAt: peer.detectedAt || ''
        }
      }))

      var halfW = layout.cardW / 2
      var halfH = layout.cardH / 2
      var GAP_EDGE = 6
      function edgePoint(from, to) {
        var dx = to[0] - from[0]
        var dy = to[1] - from[1]
        var len = Math.sqrt(dx * dx + dy * dy) || 1
        var ux = dx / len
        var uy = dy / len
        var tx = ux === 0 ? Infinity : (halfW + GAP_EDGE) / Math.abs(ux)
        var ty = uy === 0 ? Infinity : (halfH + GAP_EDGE) / Math.abs(uy)
        var t = Math.min(tx, ty)
        return [from[0] + ux * t, from[1] + uy * t]
      }

      return h('div', null,
        h('svg', { className: 'dm-lines', width: layout.W, height: layout.H, viewBox: '0 0 ' + layout.W + ' ' + layout.H },
          layout.edges.map(function (edge, k) {
            var a = nodes[edge[0]]
            var b = nodes[edge[1]]
            var pa = layout.positions[edge[0]]
            var pb = layout.positions[edge[1]]
            var bothUp = a && b && a.up && b.up
            var sa = edgePoint(pa, pb)
            var sb = edgePoint(pb, pa)
            var mx = (sa[0] + sb[0]) / 2
            var my = (sa[1] + sb[1]) / 2
            var dx = sb[0] - sa[0]
            var dy = sb[1] - sa[1]
            var len = Math.sqrt(dx * dx + dy * dy) || 1
            var bow = Math.min(12, len * 0.06)
            return h('path', {
              key: 'e' + k,
              d: 'M ' + sa[0] + ' ' + sa[1] + ' Q ' + (mx + (-dy / len) * bow) + ' ' + (my + (dx / len) * bow) + ' ' + sb[0] + ' ' + sb[1],
              fill: 'none',
              stroke: bothUp ? 'rgba(63,185,80,.42)' : 'rgba(248,81,73,.55)',
              strokeWidth: 1.8,
              strokeDasharray: bothUp ? 'none' : '6 5'
            })
          })
        ),
        h('div', { className: 'dm-world-label' }, layout.count + ' 节点 · ' + layout.edges.length + ' 条链路 · 点击节点看详情'),
        nodes.map(function (node, i) {
          var pos = layout.positions[i]
          var selected = props.selectedKey === node.key
          return h('div', {
            key: node.key,
            className: 'dm-card-node compact' + (node.local ? ' local' : '') + (node.up ? '' : ' down') + (selected ? ' selected' : ''),
            style: { left: pos[0] + 'px', top: pos[1] + 'px', width: layout.cardW + 'px', minHeight: layout.cardH + 'px', transform: 'translate(-50%,-50%)' },
            onClick: function () { if (props.onSelect) props.onSelect(node.key) },
            title: '点击查看 ' + node.name + ' 的详情'
          },
            h('div', { className: 'dm-n-head' },
              h('div', { className: 'dm-n-name' }, h('span', { className: 'dm-dot ' + (node.up ? 'ok' : 'bad') }), h('span', { className: 'dm-ell' }, node.name)),
              node.local
                ? h('span', { className: 'dm-chip ok' }, '本机')                 : (node.up ? h('span', { className: 'dm-extra' }, node.extra || '') : h('span', { className: 'dm-chip bad' }, '离线'))
            ),
            h('div', { className: 'dm-card-domain', title: node.domain }, node.domain),
            node.comm ? h('div', { className: 'dm-relay-tag' }, node.comm) : null,
            node.up ? null : h('div', { className: 'dm-offline-row', title: (node.error || '') }, '离线' + (node.error ? ' · ' + node.error : ' · 无法连接') + (node.detectedAt ? ' · 最后探测 ' + new Date(node.detectedAt).toLocaleTimeString() : '')),
            h('div', { className: 'dm-card-dsh' },
              h('span', { className: 'dm-chip' }, 'DSH ' + node.dsh + (node.local ? ' 在线' : ' 个')),
              (node.ports || []).map(function (item, pi) {
                return h('span', { key: pi, className: 'dm-chip' + (item.up ? ' run' : ' bad'), title: (item.up ? '在线' : '离线') }, String(item.port))
              })
            )
          )
        })
      )
    }

    // ---------- 画布下方：设备详情（默认全展示，点卡片高亮对应项） ----------
    function DeviceDetails(props) {
      var data = props.data
      var peers = filterSelfPeers(dedupePeers(data.peers || []), data.nodeName)
      var relayHosts = relayHostSet(peers)
      var hw = data.hardware || {}
      var instances = (data.local && data.local.instances) || []
      var endpoint = data.endpoint || {}
      var localTunnel = data.localTunnel || {}
      var localUp = instances.filter(function (x) { return x.up }).length
      var sessions = instances.reduce(function (n, x) { return n + (x.sessions || 0) }, 0)
      var running = instances.reduce(function (n, x) { return n + (x.running || 0) }, 0)
      var model = instances.length && instances[0].model ? (instances[0].model.provider || '') + ' / ' + (instances[0].model.model || '') : '—'
      var localTunnelText = null
      var tunnels = localTunnel.tunnels || []
      var entry = localTunnel.publicEntry || null
      var tunnelNames = tunnels.map(function (x) { return x.name + '→' + x.host + ':' + x.port }).join(' / ')
      var localTunnelRows = [
        ['公网入口', entry && entry.host ? entry.host + ':' + entry.port : '未配置'],
        ['本地监听', (localTunnel.bind || '?') + ':' + (localTunnel.port || '?') + (localTunnel.tls ? ' (TLS)' : '')],
        ['frp 状态', localTunnel.frpRunning ? '运行中 ×' + (localTunnel.frpcCount || 1) : '未运行']
      ]
      if (tunnels.length) localTunnelRows.push(['隧道', tunnels.map(function (x) { return x.name }).join(' / ')])
      var localTunnelAll = tunnelNames
      var memText = hw.memTotalGB ? ((hw.memFreeGB != null ? hw.memFreeGB : '?') + ' / ' + hw.memTotalGB + ' GB') : '—'
      var cpuText = hw.cpuModel ? hw.cpuModel + ' · ' + (hw.cpuCores || '?') + ' 线程' : '—'

      var devices = [{
        key: 'local',
        name: nodeLabel(data.nodeName) + '（本机）',
        up: Boolean(endpoint.up),
        rows: [
          ['操作系统', hw.os || '—'],
          ['CPU', cpuText],
          ['内存', memText],
          ['DSH 实例', localUp + '/' + instances.length + ' 在线'],
          ['会话 / 运行', sessions + ' / ' + running],
          ['模型', model],
          ...localTunnelRows,
          ['端点', (endpoint.pid != null ? 'pid ' + endpoint.pid : '—') + ' · tools ' + (endpoint.tools != null ? endpoint.tools : '—') + ' · mesh ' + (data.meshVersion || '?')],
          ['检测时间', clockText(data.at)]
        ]
      }].concat(peers.map(function (peer) {
        var t = peer.tunnel || {}
        return {
          key: 'peer:' + peer.name,
          name: nodeLabel(peerDeviceKey(peer.name)),
          up: Boolean(peer.up),
          rows: [
            ['操作系统', peer.os || '—'],
            ['运行时长', uptimeText(peer.uptimeSec)],
            ['节点 pid / tools', (peer.nodePid == null ? '—' : peer.nodePid) + ' / ' + (peer.nodeTools == null ? '—' : peer.nodeTools)],
            ['DSH 实例', (peer.instancesCount || 0) + ' 个（' + ((peer.instancesList || []).map(function (x) { return x.port + (x.up ? '✓' : '✗') }).join(' ') || '—') + '）'],
            ['会话 / 运行', (peer.sessions || 0) + ' / ' + (peer.running || 0)],
            ['任务（进行中）', peer.tasksActive == null ? '—' : String(peer.tasksActive)],
            ['公网入口', t.host ? t.host + (t.port ? ':' + t.port : '') : '—'],
            ['链路类型', commLabel(peer, relayHosts).text],
            ['链路', (peer.up ? (peer.latencyMs == null ? '—' : peer.latencyMs + 'ms') : '离线') + ' · ' + (peer.tls ? 'TLS ✓' : 'TLS ✗') + ' · v' + (peer.version || '?')],
            ['CPU / 内存', '对端未暴露，无法直读'],
            ['检测时间', clockText(peer.detectedAt || data.at)]
          ]
        }
      }))

      return h('div', { className: 'dm-devices' },
        devices.map(function (device) {
          return h('div', { key: device.key, className: 'dm-device' + (props.selectedKey === device.key ? ' selected' : '') },
            h('div', { className: 'dm-device-head' },
              h('span', { className: 'dm-dot ' + (device.up ? 'ok' : 'bad') }),
              h('span', { className: 'dm-device-name' }, device.name),
              device.key === 'local' ? h('span', { className: 'dm-chip ok' }, '本机') : null
            ),
            h('div', { className: 'dm-device-body' }, device.rows.map(function (row, i) {
              return h('div', { className: 'dm-device-row', key: i },
                h('span', { className: 'dm-device-k' }, row[0]),
                h('span', { className: 'dm-device-v', title: String(row[1]) }, String(row[1]))
              )
            }))
          )
        })
      )
    }

    function Details(props) {
      return h('details', { className: 'dm-details', open: Boolean(props.open) },
        h('summary', null, props.title, props.badge != null ? h('span', { className: 'dm-pill muted' }, String(props.badge)) : null),
        h('div', { className: 'dm-body' }, props.children)
      )
    }

    function InstanceList(props) {
      var instances = (props.data.local && props.data.local.instances) || []
      if (!instances.length) return h('div', { className: 'dm-empty' }, '无本机实例数据')
      return h('div', null, instances.map(function (inst) {
        var model = inst.model ? (inst.model.provider || '') + ' / ' + (inst.model.model || '') : '—'
        return h('div', { className: 'dm-instrow', key: inst.id },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 } }, h('span', { className: 'dm-dot ' + (inst.up ? 'ok' : 'bad') }), inst.id),
            h('div', { className: 'dm-sub', style: { marginTop: 1 } }, model)
          ),
          h('div', { className: 'dm-mini', style: { marginTop: 0 } },
            h('span', { className: 'dm-chip' }, 'pid ' + (inst.pid == null ? '—' : inst.pid)),
            h('span', { className: 'dm-chip' }, 'tools ' + (inst.tools == null ? '—' : inst.tools)),
            h('span', { className: 'dm-chip' }, '会话 ' + (inst.sessions || 0)),
            h('span', { className: 'dm-chip' + (inst.running ? ' run' : '') }, '运行 ' + (inst.running || 0))
          )
        )
      }))
    }

    function DelegationTable(props) {
      var d = props.data.delegations || {}
      var list = (d.recent || []).slice(0, 6)
      var stats = d.byState || {}
      if (!list.length) return h('div', { className: 'dm-empty' }, '暂无委托记录')
      return h('div', null,
        h('div', { className: 'dm-sub', style: { marginBottom: 5 } }, '共 ' + (d.total || 0) + ' 条 · ' + Object.keys(stats).map(function (k) { return k + ' ' + stats[k] }).join(' · ')),
        h('table', { className: 'dm-table' },
          h('thead', null, h('tr', null, h('th', null, '状态'), h('th', null, '节点'), h('th', null, '任务'), h('th', null, '耗时'), h('th', null, '目标'))),
          h('tbody', null, list.map(function (task) {
            return h('tr', { key: task.taskId },
              h('td', null, stateChip(task.state)),
              h('td', null, nodeLabel(task.node)),
              h('td', { className: 'dm-mono', style: { fontSize: 11 } }, String(task.taskId || '').replace(/^T-\d{8}-/, 'T-…')),
              h('td', { className: 'dm-mono' }, dur(task.durationSec)),
              h('td', null, h('span', { className: 'dm-trunc', title: task.goal }, task.goal || ''))
            )
          }))
        )
      )
    }

    function AlertList(props) {
      var alerts = props.data.alerts || {}
      var latest = alerts.latest
      var history = (alerts.history || []).filter(function (item) { return !latest || item.at !== latest.at }).slice().reverse()
      if (!latest && !history.length) return h('div', { className: 'dm-empty' }, '没有告警记录')
      return h('div', null,
        latest ? h('div', { className: 'dm-alertrow' },
          h('span', { className: 'dm-chip bad' }, latest.kind || 'alert'),
          h('span', null, h('span', { className: 'dm-mono' }, latest.at), ' · ', latest.summary || '', latest.consecutiveBad ? ' · 连续 ' + latest.consecutiveBad + ' 次' : '')
        ) : null,
        history.slice(0, 6).map(function (item, i) {
          return h('div', { className: 'dm-alertrow', key: i, style: { opacity: 0.75 } },
            h('span', { className: 'dm-chip' }, item.kind || '?'),
            h('span', null, h('span', { className: 'dm-mono' }, item.at || ''), ' · ', item.summary || '')
          )
        })
      )
    }

    function MeshStatusSection() {
      var s0 = useState(null); var data = s0[0]; var setData = s0[1]
      var s1 = useState(true); var loading = s1[0]; var setLoading = s1[1]
      var s2 = useState(''); var error = s2[0]; var setError = s2[1]
      var s3 = useState(0); var tick = s3[0]; var setTick = s3[1]
      var s4 = useState(''); var copied = s4[0]; var setCopied = s4[1]
      var s5 = useState('local'); var selectedKey = s5[0]; var setSelectedKey = s5[1]

      function load(force) {
        setLoading(true)
        fetchStatus(Boolean(force))
          .then(function (json) {
            setData(json)
            setError(json && json.ok === false && !json.warming ? json.error || 'mesh-health error' : '')
          })
          .catch(function (err) { setError(String((err && err.message) || err)) })
          .finally(function () { setLoading(false) })
      }

      useEffect(function () {
        load(false)
        var timer = setInterval(function () { setTick(function (n) { return n + 1 }) }, REFRESH_MS)
        return function () { clearInterval(timer) }
      }, [])

      useEffect(function () { if (tick > 0) load(false) }, [tick])

      function copyJson() {
        var text = JSON.stringify(data || {}, null, 2)
        var done = function () { setCopied('已复制'); setTimeout(function () { setCopied('') }, 1600) }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done)
          else done()
        } catch (_) { done() }
      }

      if (!data) {
        return h('div', { className: 'dm-root' },
          h('div', { className: 'dm-head' }, h('span', { className: 'dm-title' }, 'AI 网络'), h('span', { className: 'dm-pill muted' }, loading ? '加载中…' : '无数据')),
          error ? h('div', { className: 'dm-err' }, error) : null
        )
      }

      var versions = data.versionMismatch || []
      var issues = data.issues || []
      var hints = data.hints || []

      return h('div', { className: 'dm-root' },
        h('style', null, CSS),
        h('div', { className: 'dm-head' },
          h('span', { className: 'dm-title' }, 'AI 网络 · dsh-mesh'),
          h('span', { className: 'dm-pill ' + (data.warming ? 'muted' : tone(data.verdict)) }, data.warming ? '预热中' : (data.verdict || '?')),
          h('span', { className: 'dm-sub' }, (data.meshVersion ? 'mesh ' + data.meshVersion + ' · ' : '') + (data.at ? ago(data.at) : '')),
          h('span', { style: { flex: 1 } }),
          h('a', { className: 'dm-btn', href: API, target: '_blank', rel: 'noreferrer', style: { textDecoration: 'none' } }, '原始 JSON'),
          h('button', { className: 'dm-btn', onClick: copyJson }, copied || '复制诊断'),
          h('button', { className: 'dm-btn primary', onClick: function () { load(true) } }, loading ? '刷新中…' : '刷新')
        ),
        error ? h('div', { className: 'dm-err' }, error) : null,
        h(RelayLayer, { data: data }),
        h(Viewport, { data: data, layout: computeLayout(1 + filterSelfPeers(dedupePeers(data.peers || []), data.nodeName).length), selectedKey: selectedKey, onSelect: setSelectedKey }),
        h(DeviceDetails, { data: data, selectedKey: selectedKey }),
        h(Details, { title: '本机实例', badge: ((data.local && data.local.instances) || []).length, open: true }, h(InstanceList, { data: data })),
        h(Details, { title: '版本一致性', badge: versions.length ? versions.length + ' 处升级' : '一致' },
          versions.length
            ? versions.map(function (item, i) { return h('div', { key: i, className: 'dm-sub', style: { marginTop: 4 } }, '· ' + (typeof item === 'string' ? item : JSON.stringify(item))) })
            : h('div', { className: 'dm-empty' }, '所有节点/实例版本一致')
        ),
        h(Details, { title: '委托台账', badge: (data.delegations && data.delegations.total) || 0 }, h(DelegationTable, { data: data })),
        h(Details, { title: '告警历史', badge: ((data.alerts && data.alerts.history) || []).length }, h(AlertList, { data: data })),
        (issues.length || hints.length) ? h(Details, { title: '诊断建议', badge: issues.length + hints.length },
          h('div', null,
            issues.slice(0, 6).map(function (issue, i) { return h('div', { key: 'i' + i, className: 'dm-err', style: { marginTop: 3 } }, '· ' + issue) }),
            hints.slice(0, 6).map(function (hint, i) { return h('div', { key: 'h' + i, className: 'dm-sub', style: { marginTop: 3 } }, '· ' + hint) })
          )
        ) : null,
        h('div', { className: 'dm-foot' }, '数据源：mesh-health / host status / peer host_self / 委托台账 / 告警历史 · ' + (data.repo || '') + ' · node ' + (data.nodeVersion || '') + ' · ' + REFRESH_MS / 1000 + 's 自动刷新（只读）')
      )
    }

    // ================= 委托面板（只读，方案 A / v2 视觉重做） =================
    var DG_API_LIST = '/api/dsh-mesh/delegations'
    var DG_API_TASK = '/api/dsh-mesh/task'
    var DG_API_SESSION = '/api/dsh-mesh/session'

    var DG_STATE_TONE = {
      done: 'ok', working: 'run', accepted: 'run', submitted: 'run',
      question: 'warn', stalled: 'warn', failed: 'bad', cancelled: 'muted'
    }

    var DG_CSS = `
.dm-dg-root { display:flex; flex-direction:column; gap:12px; height:100%; min-height:0; padding:16px; box-sizing:border-box; font-size:13px; color:inherit; }
.dm-dg-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dm-dg-title { font-size:16px; font-weight:650; letter-spacing:.2px; }
.dm-dg-sub { font-size:11.5px; opacity:.55; }
.dm-dg-pill { font-size:10.5px; padding:1px 8px; border-radius:999px; border:1px solid rgba(128,128,128,.32); opacity:.85; }
.dm-dg-pill.readonly { border-color:rgba(88,166,255,.5); color:#3b82d6; opacity:1; }
.dm-dg-stats { display:flex; gap:6px; flex-wrap:wrap; }
.dm-dg-stat { font-size:10.5px; padding:1px 8px; border-radius:999px; border:1px solid rgba(128,128,128,.28); display:flex; gap:5px; align-items:center; }
.dm-dg-stat b { font-weight:650; }
.dm-dg-spacer { flex:1; }
.dm-dg-btn { font-size:11.5px; padding:4px 11px; border-radius:8px; border:1px solid rgba(128,128,128,.4); background:transparent; color:inherit; cursor:pointer; white-space:nowrap; display:inline-flex; align-items:center; gap:5px; }
.dm-dg-btn:hover:not(:disabled) { background:rgba(128,128,128,.12); }
.dm-dg-btn:disabled { opacity:.45; cursor:default; }
.dm-dg-btn.primary { border-color:rgba(88,166,255,.6); color:#3b82d6; }
.dm-dg-notice { font-size:11.5px; padding:7px 10px; border-radius:8px; border:1px solid transparent; display:flex; gap:8px; align-items:center; }
.dm-dg-notice.info { background:rgba(88,166,255,.1); border-color:rgba(88,166,255,.35); }
.dm-dg-notice.ok { background:rgba(63,185,80,.12); border-color:rgba(63,185,80,.4); color:#2e9e4f; }
.dm-dg-notice.bad { background:rgba(248,81,73,.12); border-color:rgba(248,81,73,.4); color:#c9362c; }
.dm-dg-body { display:grid; grid-template-columns:var(--dm-dg-list-w, 360px) 7px minmax(0,1fr); gap:10px; min-height:0; flex:1; }
@media (max-width: 960px) { .dm-dg-body { grid-template-columns:1fr; } .dm-dg-divider { display:none; } }
.dm-dg-pane { display:flex; flex-direction:column; min-height:0; border:1px solid rgba(128,128,128,.25); border-radius:12px; background:rgba(128,128,128,.035); overflow:hidden; }
.dm-dg-pane-head { flex:none; display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid rgba(128,128,128,.2); background:rgba(128,128,128,.05); font-weight:650; font-size:12px; }
.dm-dg-pane-head .dm-dg-sub { font-weight:400; }
.dm-dg-scroll { flex:1; min-height:0; overflow:auto; }
.dm-dg-row { position:relative; display:flex; flex-direction:column; gap:5px; padding:10px 12px 10px 15px; border-bottom:1px solid rgba(128,128,128,.14); cursor:pointer; }
.dm-dg-row:last-child { border-bottom:none; }
.dm-dg-row::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:transparent; }
.dm-dg-row.ok::before { background:#2e9e4f; }
.dm-dg-row.run::before { background:#3b82d6; }
.dm-dg-row.warn::before { background:#d29922; }
.dm-dg-row.bad::before { background:#d14b41; }
.dm-dg-row:hover { background:rgba(128,128,128,.09); }
.dm-dg-row.active { background:rgba(88,166,255,.13); }
.dm-dg-divider { position:relative; cursor:col-resize; min-height:0; border-radius:4px; }
.dm-dg-divider::before { content:''; position:absolute; top:0; bottom:0; left:3px; width:1px; background:rgba(128,128,128,.28); }
.dm-dg-divider:hover::before, .dm-dg-divider:active::before { background:rgba(88,166,255,.7); width:2px; left:2.5px; }
.dm-dg-spinner { flex:none; color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.85)); }
.dm-dg-spinner-motion { transform-origin:center; animation:dm-dg-spin 1.5s linear infinite; }
.dm-dg-spinner-track, .dm-dg-spinner-arc { fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; }
.dm-dg-spinner-track { opacity:.25; }
.dm-dg-spinner-arc { stroke-dasharray:12 150; animation:dm-dg-dash 1.5s ease-in-out infinite; }
@keyframes dm-dg-spin { to { transform:rotate(360deg); } }
@keyframes dm-dg-dash {
  0% { stroke-dasharray:12 150; stroke-dashoffset:0; }
  50% { stroke-dasharray:24 150; stroke-dashoffset:-6; }
  100% { stroke-dasharray:12 150; stroke-dashoffset:0; }
}
@media (prefers-reduced-motion: reduce) {
  .dm-dg-spinner-motion, .dm-dg-spinner-arc { animation:none; }
  .dm-dg-spinner-arc { stroke-dasharray:18 150; stroke-dashoffset:-3; }
}
.dm-dg-row-top { display:flex; align-items:center; gap:8px; min-width:0; }
.dm-dg-row-node { font-weight:650; white-space:nowrap; }
.dm-dg-route { display:inline-flex; align-items:center; gap:6px; min-width:0; }
.dm-dg-from, .dm-dg-to { font-weight:650; font-size:12.5px; white-space:nowrap; }
.dm-dg-from { color:inherit; opacity:.85; }
.dm-dg-to { color:#3b82d6; }
.dm-dg-arrow { opacity:.5; font-size:11px; }
.dm-dg-me { font-size:9.5px; padding:0 5px; border-radius:999px; border:1px solid rgba(63,185,80,.55); color:#2e9e4f; line-height:15px; }
.dm-dg-filters { position:relative; z-index:5; display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:7px 10px; border-bottom:1px solid rgba(128,128,128,.16); background:rgba(128,128,128,.03); }
.dm-dg-fgroup { display:flex; align-items:center; gap:5px; flex-wrap:wrap; font-size:10px; opacity:.8; }
.dm-dg-fs { position:relative; display:inline-flex; align-items:center; gap:4px; }
.dm-dg-fs-label { font-size:10px; opacity:.6; }
.dm-dg-fs-btn { display:inline-flex; align-items:center; gap:6px; font-size:10.5px; padding:2px 8px; border-radius:6px; border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.08); color:inherit; cursor:pointer; }
.dm-dg-fs-btn:hover { background:rgba(128,128,128,.16); }
.dm-dg-fs-caret { font-size:8px; opacity:.55; }
.dm-dg-fs-menu { position:absolute; top:calc(100% + 4px); left:0; min-width:132px; padding:4px; border-radius:8px; border:1px solid rgba(128,128,128,.3); background:#ffffff; color:#1a1a1a; box-shadow:0 8px 24px rgba(0,0,0,.18); z-index:90; display:flex; flex-direction:column; gap:2px; }
.dm-dg-fs-item { text-align:left; font-size:11px; padding:4px 9px; border-radius:5px; border:none; background:transparent; color:inherit; cursor:pointer; white-space:nowrap; }
.dm-dg-fs-item:hover { background:rgba(128,128,128,.18); }
.dm-dg-fs-item.active { background:rgba(88,166,255,.2); color:#2b6fc4; }
body[data-ds-dark-theme] .dm-dg-fs-menu { background:#24262b; color:#e6e6e6; border-color:rgba(255,255,255,.16); box-shadow:0 8px 24px rgba(0,0,0,.55); }
body[data-ds-dark-theme] .dm-dg-fs-item:hover { background:rgba(255,255,255,.1); }
body[data-ds-dark-theme] .dm-dg-fs-item.active { background:rgba(88,166,255,.28); color:#79b8ff; }
.dm-dg-fbtn { font-size:10px; padding:2px 8px; border-radius:6px; border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; cursor:pointer; }
.dm-dg-fhint { font-size:9.5px; opacity:.45; }
.dm-dg-fchip { font-size:10px; padding:0 8px; line-height:16px; border-radius:999px; border:1px solid rgba(128,128,128,.3); background:transparent; color:inherit; cursor:pointer; }
.dm-dg-fchip.active { border-color:rgba(88,166,255,.7); color:#3b82d6; background:rgba(88,166,255,.12); }
.dm-dg-badge { padding:0 6px; border-radius:5px; border:1px solid rgba(128,128,128,.32); font-size:10px; opacity:.8; }
.dm-dg-row-time { margin-left:auto; font-size:10.5px; opacity:.5; font-variant-numeric:tabular-nums; white-space:nowrap; }
.dm-dg-chip { font-size:10px; padding:0 8px; border-radius:999px; border:1px solid rgba(128,128,128,.32); white-space:nowrap; line-height:17px; display:inline-block; }
.dm-dg-chip.ok { border-color:rgba(63,185,80,.55); color:#2e9e4f; }
.dm-dg-chip.bad { border-color:rgba(248,81,73,.55); color:#c9362c; }
.dm-dg-chip.run { border-color:rgba(88,166,255,.55); color:#3b82d6; }
.dm-dg-chip.warn { border-color:rgba(210,153,34,.6); color:#9a6c12; }
.dm-dg-chip.muted { opacity:.7; }
.dm-dg-goal { font-size:11.5px; opacity:.8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dm-dg-meta { display:flex; gap:8px; flex-wrap:wrap; font-size:10px; opacity:.5; font-variant-numeric:tabular-nums; }
.dm-dg-empty { padding:22px 14px; text-align:center; opacity:.55; font-size:12px; line-height:1.7; }
.dm-dg-skel { padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
.dm-dg-skel i { display:block; height:10px; border-radius:6px; background:rgba(128,128,128,.18); animation:dm-dg-pulse 1.2s ease-in-out infinite; }
.dm-dg-skel i:nth-child(2) { width:70%; } .dm-dg-skel i:nth-child(3) { width:45%; }
@keyframes dm-dg-pulse { 0%,100% { opacity:.45 } 50% { opacity:.9 } }
.dm-dg-detail { display:flex; flex-direction:column; gap:12px; padding:12px; }
.dm-dg-sec { border:1px solid rgba(128,128,128,.22); border-radius:10px; overflow:hidden; }
.dm-dg-sec-head { display:flex; align-items:center; gap:8px; padding:7px 11px; border-bottom:1px solid rgba(128,128,128,.18); background:rgba(128,128,128,.05); font-weight:650; font-size:11.5px; }
.dm-dg-sec-body { padding:10px 11px; display:flex; flex-direction:column; gap:7px; }
.dm-dg-kv { display:grid; grid-template-columns:92px minmax(0,1fr); gap:6px 10px; align-items:baseline; font-size:11.5px; }
.dm-dg-k { opacity:.55; }
.dm-dg-v { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; display:flex; gap:6px; align-items:center; }
.dm-dg-copy { font-size:10px; padding:0 6px; border-radius:6px; border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; cursor:pointer; opacity:.6; flex:none; }
.dm-dg-copy:hover { opacity:1; }
.dm-dg-pre { white-space:pre-wrap; word-break:break-word; font-size:11px; line-height:1.55; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; max-height:220px; overflow:auto; border:1px dashed rgba(128,128,128,.25); border-radius:8px; padding:8px; background:rgba(128,128,128,.04); }
.dm-dg-msgs { display:flex; flex-direction:column; gap:8px; max-height:380px; overflow:auto; padding-right:2px; }
.dm-dg-msg { border:1px solid rgba(128,128,128,.18); border-radius:9px; padding:8px 10px; background:rgba(128,128,128,.03); }
.dm-dg-msg.user { border-left:3px solid rgba(63,185,80,.6); }
.dm-dg-msg.assistant { border-left:3px solid rgba(88,166,255,.6); }
.dm-dg-msg-head { display:flex; gap:8px; align-items:baseline; margin-bottom:5px; font-size:10px; opacity:.6; text-transform:uppercase; letter-spacing:.4px; }
.dm-dg-msg-text { white-space:pre-wrap; word-break:break-word; font-size:11.5px; line-height:1.55; }
.dm-dg-loading { display:inline-flex; gap:6px; align-items:center; font-size:11.5px; opacity:.7; }
.dm-dg-spin { width:11px; height:11px; border:2px solid rgba(128,128,128,.35); border-top-color:currentColor; border-radius:50%; animation:dm-dg-rot .8s linear infinite; }
@keyframes dm-dg-rot { to { transform:rotate(360deg) } }
@media (prefers-color-scheme: dark) {
  .dm-dg-pill.readonly { color:#79b8ff; }
  .dm-dg-btn.primary { color:#79b8ff; }
  .dm-dg-notice.ok { color:#3fb950; } .dm-dg-notice.bad { color:#ff7b72; }
  .dm-dg-chip.ok { color:#3fb950; } .dm-dg-to { color:#79b8ff; } .dm-dg-chip.run { color:#79b8ff; } .dm-dg-chip.warn { color:#d29922; } .dm-dg-chip.bad { color:#ff7b72; }
}
`

    // 仿 DSH StateDot 的 ongoing 转圈环（1.5s 转 + 弧线呼吸）
    function LoadingSpinner(props) {
      var size = (props && props.size) || 14
      return h('svg', {
        className: 'dm-dg-spinner',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        'data-state': 'ongoing'
      },
        h('g', { className: 'dm-dg-spinner-motion' },
          h('circle', { className: 'dm-dg-spinner-track', cx: 12, cy: 12, r: 9.5 }),
          h('circle', { className: 'dm-dg-spinner-arc', cx: 12, cy: 12, r: 9.5 })
        )
      )
    }

    function dgFetch(path) {
      return fetch(path, { headers: { accept: 'application/json' } })
        .then(function (res) {
          return res.text().then(function (text) {
            var type = res.headers.get('content-type') || ''
            if (res.status === 404 || !/json/i.test(type)) {
              var routeError = new Error('route unavailable (HTTP ' + res.status + ')')
              routeError.code = 'E_NO_ROUTE'
              routeError.body = String(text || '').slice(0, 80)
              throw routeError
            }
            try {
              return JSON.parse(text)
            } catch (error) {
              var parseError = new Error('服务端返回的不是 JSON（可能需要重启该 DSH 实例）')
              parseError.code = 'E_PARSE'
              parseError.body = String(text || '').slice(0, 80)
              throw parseError
            }
          })
        })
    }
    function dgFriendly(err) {
      if (err && (err.code === 'E_NO_ROUTE' || err.code === 'E_PARSE')) return '当前 DSH 实例的服务端还是旧版本（缺接口），重启该实例后可用'
      return String((err && err.message) || err)
    }
    function dgDur(sec) {
      if (sec == null) return '—'
      if (sec < 60) return sec + 's'
      if (sec < 3600) return Math.floor(sec / 60) + 'm' + (sec % 60) + 's'
      return Math.floor(sec / 3600) + 'h' + Math.floor((sec % 3600) / 60) + 'm'
    }
    function dgClock(iso) {
      if (!iso) return '—'
      var d = new Date(iso)
      if (isNaN(d.getTime())) return '—'
      function p2(n) { return (n < 10 ? '0' : '') + n }
      return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
    }
    function dgTone(state) { return DG_STATE_TONE[state] || 'muted' }
    // 状态/策略展示统一中文（内部值保持英文，避免影响筛选与接口）
    var DG_STATE_LABELS = {
      done: '已完成', working: '执行中', submitted: '已提交', accepted: '已受理',
      question: '待回复', stalled: '疑似卡住', failed: '失败', cancelled: '已取消',
      timeout: '超时', running: '运行中', provisioning: '准备中', inactive: '空闲', unknown: '未知'
    }
    var DG_POLICY_LABELS = { new: '新会话', continue: '续会话', auto: '自动', session: '指定会话' }
    function dgStateLabel(state) { return DG_STATE_LABELS[String(state || '')] || String(state || '未知') }
    function dgPolicyLabel(policy) { return DG_POLICY_LABELS[String(policy || '')] || String(policy || '—') }
    function dgChip(state) { return h('span', { className: 'dm-dg-chip ' + dgTone(state) }, dgStateLabel(state)) }

    // 必须是 React 组件（返回元素），不能返回 DOM 节点
    function meshPanelIcon(props) {
      var size = (props && props.size) || 16
      return h('svg', {
        'data-dsh-panel-entry': 'mesh-delegations', viewBox: '0 0 16 16', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', 'aria-hidden': 'true',
        style: { color: 'var(--dsh-brand-color, currentColor)' }
      },
        h('path', { d: 'M8 3.2 L3.2 8 M8 3.2 L12.8 8 M3.2 8 L12.8 8', opacity: '.7' }),
        h('circle', { cx: 8, cy: 3.2, r: 1.6, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 3.2, cy: 8, r: 1.6, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 12.8, cy: 8, r: 1.6, fill: 'currentColor', stroke: 'none' })
      )
    }

    function MeshDelegationPanel() {
      var s0 = useState(null); var list = s0[0]; var setList = s0[1]
      var s1 = useState(true); var loading = s1[0]; var setLoading = s1[1]
      var s2 = useState(null); var notice = s2[0]; var setNotice = s2[1]
      var s3 = useState(null); var selectedId = s3[0]; var setSelectedId = s3[1]
      var s4 = useState(null); var detail = s4[0]; var setDetail = s4[1]
      var s5 = useState(false); var taskLoading = s5[0]; var setTaskLoading = s5[1]
      var s6 = useState(null); var session = s6[0]; var setSession = s6[1]
      var s7 = useState(false); var sessionLoading = s7[0]; var setSessionLoading = s7[1]
      var s8 = useState(''); var copied = s8[0]; var setCopied = s8[1]
      var s10 = useState(null); var artifacts = s10[0]; var setArtifacts = s10[1]
      var s11 = useState(''); var localNode = s11[0]; var setLocalNode = s11[1]
      var s12 = useState(''); var lastListAt = s12[0]; var setLastListAt = s12[1]
      var s13 = useState(''); var lastTaskAt = s13[0]; var setLastTaskAt = s13[1]
      var s14 = useState(''); var filterFrom = s14[0]; var setFilterFrom = s14[1]
      var s15 = useState(''); var filterTo = s15[0]; var setFilterTo = s15[1]
      var s16 = useState(''); var filterFromNode = s16[0]; var setFilterFromNode = s16[1]
      var s17 = useState(''); var filterToNode = s17[0]; var setFilterToNode = s17[1]
      var s19 = useState(null); var rich = s19[0]; var setRich = s19[1]
      var s18 = useState(function () {
        try {
          var saved = window.localStorage.getItem('dsh-mesh-list-width')
          var value = saved ? Number(saved) : NaN
          if (Number.isFinite(value)) return Math.max(260, Math.min(640, value))
        } catch (error) { /* ignore */ }
        return 360
      })
      var listWidth = s18[0]; var setListWidth = s18[1]
      function startResize(event) {
        event.preventDefault()
        var startX = event.clientX
        var startW = listWidth
        var currentW = startW
        function onMove(moveEvent) {
          currentW = Math.max(260, Math.min(640, startW + (moveEvent.clientX - startX)))
          setListWidth(currentW)
        }
        function onUp() {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          try { window.localStorage.setItem('dsh-mesh-list-width', String(currentW)) } catch (error) { /* ignore */ }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }
      function resetResize() {
        setListWidth(360)
        try { window.localStorage.setItem('dsh-mesh-list-width', '360') } catch (error) { /* ignore */ }
      }

      // 只保留「错误」提示（持久显示，下一次成功操作/切换任务时清除）；成功不再弹自动消失的提示
      function flash(type, text) {
        if (type === 'bad') setNotice({ type: 'bad', text: text })
        else setNotice(null)
      }
      function clearNotice() { setNotice(null) }

      function loadList(silent) {
        if (!silent) setLoading(true)
        dgFetch(DG_API_LIST + '?limit=100')
          .then(function (json) {
            if (!json || !json.ok) throw new Error((json && json.error) || 'load failed')
            setList(Object.assign({}, json, { degraded: false }))
            if (json.localNode) setLocalNode(json.localNode)
            setLastListAt(new Date().toISOString())
          })
          .catch(function (err) {
            // 2026-11-07 兼容：旧实例没有 /delegations 路由 → 用 /status 里的 delegations.recent 降级
            if (err && (err.code === 'E_NO_ROUTE' || err.code === 'E_PARSE')) {
              return dgFetch('/api/dsh-mesh/status')
                .then(function (st) {
                  var recent = (st && st.delegations && st.delegations.recent) || []
                  var tasks = recent.map(function (item) {
                    return {
                      taskId: item.taskId,
                      conversationId: item.conversationId || '',
                      sessionId: item.sessionId || '',
                      from: '',
                      fromLabel: '',
                      node: item.node,
                      nodeLabel: nodeLabel(item.node),
                      instance: '',
                      state: item.state,
                      policy: item.policy || '',
                      goal: item.goal || '',
                      createdAt: item.createdAt || '',
                      updatedAt: item.updatedAt || '',
                      durationSec: item.durationSec == null ? null : (item.durationSec > 43200 ? null : item.durationSec)
                    }
                  })
                  if (st && st.nodeName) setLocalNode(st.nodeName)
                  setList({
                    total: (st && st.delegations && st.delegations.total) || tasks.length,
                    byState: (st && st.delegations && st.delegations.byState) || {},
                    tasks: tasks,
                    degraded: true
                  })
                  flash('bad', '当前实例服务端未重启：已降级显示最近 ' + tasks.length + ' 条（重启后显示完整列表/详情）')
                })
                .catch(function () { throw err })
            }
            throw err
          })
          .catch(function (err) { flash('bad', '列表加载失败：' + dgFriendly(err)) })
          .finally(function () { setLoading(false) })
      }

      useEffect(function () {
        loadList(true)
        var timer = setInterval(function () { loadList(true) }, 20000)
        return function () { clearInterval(timer) }
      }, [])

      var tasks = (list && list.tasks) || []
      var selected = null
      for (var i = 0; i < tasks.length; i++) { if (tasks[i].taskId === selectedId) { selected = tasks[i]; break } }

      function selectTask(task) {
        setSelectedId(task.taskId)
        clearNotice()
        setDetail(null)
        setArtifacts(null)
        setRich(null)
        setSession(null)
        setTaskLoading(true)
        dgFetch(DG_API_TASK + '?taskId=' + encodeURIComponent(task.taskId))
          .then(function (json) {
            if (!json || !json.ok) throw new Error((json && json.error) || 'task status failed')
            setDetail(json.status || null)
            setArtifacts(json.artifacts || null)
            setRich(json.detail || null)
            setLastTaskAt(new Date().toISOString())
            clearNotice()
          })
          .catch(function (err) { flash('bad', '查询任务状态失败：' + dgFriendly(err)) })
          .finally(function () { setTaskLoading(false) })
      }

      function loadSession() {
        if (!selected || !selected.sessionId) return
        setSessionLoading(true)
        dgFetch(DG_API_SESSION + '?node=' + encodeURIComponent(selected.node) + '&sessionId=' + encodeURIComponent(selected.sessionId) + '&limit=60')
          .then(function (json) {
            if (!json || !json.ok) throw new Error((json && json.error) || 'session history failed')
            setSession(json.payload || null)
            clearNotice()
          })
          .catch(function (err) { flash('bad', '加载对端会话失败：' + dgFriendly(err)) })
          .finally(function () { setSessionLoading(false) })
      }

      function copyText(key, text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { setCopied(key) }, function () { flash('bad', '复制失败') })
          else { setCopied(key) }
        } catch (_) { flash('bad', '复制失败') }
        setTimeout(function () { setCopied('') }, 1500)
      }

      var byState = (list && list.byState) || {}
      // 2026-11-07：节点筛选（委托方/接收方）+ 实例筛选（源实例仅新委托记录；旧数据为空 → 未记录）
      var fromNodeOptions = []
      var toNodeOptions = []
      var fromOptions = []
      var toOptions = []
      for (var ti = 0; ti < tasks.length; ti++) {
        var task0 = tasks[ti]
        if (fromNodeOptions.indexOf(task0.from || '') < 0) fromNodeOptions.push(task0.from || '')
        if (toNodeOptions.indexOf(task0.node || '') < 0) toNodeOptions.push(task0.node || '')
        var fi = task0.fromInstance || ''
        if (fromOptions.indexOf(fi) < 0) fromOptions.push(fi)
        var ii = task0.instance || ''
        if (toOptions.indexOf(ii) < 0) toOptions.push(ii)
      }
      fromNodeOptions.sort()
      toNodeOptions.sort()
      fromOptions.sort()
      toOptions.sort()
      function nodeOptionLabel(value, isFrom) {
        if (!value) return '未知节点'
        for (var k = 0; k < tasks.length; k++) {
          var item = tasks[k]
          if (isFrom && (item.from || '') === value) return item.fromLabel || value
          if (!isFrom && (item.node || '') === value) return (item.nodeLabel || value) + (item.fromIsLocal !== undefined ? '' : '')
        }
        return value
      }
      var visibleTasks = tasks.filter(function (task) {
        if (filterFromNode && (task.from || '') !== filterFromNode) return false
        if (filterToNode && (task.node || '') !== filterToNode) return false
        if (filterFrom && (task.fromInstance || '') !== filterFrom) return false
        if (filterTo && (task.instance || '') !== filterTo) return false
        return true
      })
      function resetFilters() { setFilterFromNode(''); setFilterToNode(''); setFilterFrom(''); setFilterTo('') }
      // 自绘下拉：不用原生 select（暗色主题下原生弹层会保持白底）
      function FilterSelect(props) {
        var fs = useState(false)
        var open = fs[0]
        var setOpen = fs[1]
        useEffect(function () {
          if (!open) return
          function close() { setOpen(false) }
          document.addEventListener('mousedown', close)
          return function () { document.removeEventListener('mousedown', close) }
        }, [open])
        return h('div', { className: 'dm-dg-fs' },
          h('span', { className: 'dm-dg-fs-label' }, props.label),
          h('button', {
            type: 'button',
            className: 'dm-dg-fs-btn',
            'aria-expanded': open ? 'true' : 'false',
            onClick: function (event) { event.stopPropagation(); setOpen(!open) }
          },
            h('span', { className: 'dm-dg-fs-val' }, props.renderLabel(props.value)),
            h('span', { className: 'dm-dg-fs-caret' }, '▾')
          ),
          open ? h('div', { className: 'dm-dg-fs-menu', onMouseDown: function (event) { event.stopPropagation() } },
            props.options.map(function (opt) {
              return h('button', {
                key: opt,
                type: 'button',
                className: 'dm-dg-fs-item' + (opt === props.value ? ' active' : ''),
                onClick: function (event) { event.stopPropagation(); props.onChange(opt); setOpen(false) }
              }, props.renderLabel(opt))
            })
          ) : null
        )
      }
      var stats = ['done', 'working', 'submitted', 'question', 'stalled', 'failed'].filter(function (key) { return byState[key] })
      var selectedTone = selected ? dgTone(selected.state) : 'muted'
      var sessionMessages = (session && session.messages) || []
      var st = detail || {}

      function copyBtn(key, text) {
        if (!text) return null
        return h('button', { type: 'button', className: 'dm-dg-copy', title: '复制 ' + key, onClick: function (e) { e.stopPropagation(); copyText(key, text) } }, copied === key ? '已复制' : '复制')
      }
      function kv(label, value, copyKey) {
        return h('div', { className: 'dm-dg-kv' },
          h('span', { className: 'dm-dg-k' }, label),
          h('span', { className: 'dm-dg-v', title: String(value == null ? '' : value) }, String(value == null || value === '' ? '—' : value), copyKey ? copyBtn(copyKey, String(value || '')) : null)
        )
      }

      return h('div', { className: 'dm-dg-root' },
        h('style', null, DG_CSS),
        h('div', { className: 'dm-dg-head' },
          h('span', { className: 'dm-dg-title' }, '委托'),
          h('span', { className: 'dm-dg-pill readonly' }, '只读'),
          h('div', { className: 'dm-dg-stats' },
            h('span', { className: 'dm-dg-stat' }, '共 ', h('b', null, String((list && list.total) || tasks.length || 0)), ' 条'),
            stats.map(function (key) { return h('span', { key: key, className: 'dm-dg-stat' }, h('b', null, String(byState[key])), ' ', dgStateLabel(key)) })
          ),
          h('span', { className: 'dm-dg-spacer' }),
          h('span', { className: 'dm-dg-sub' }, '20s 自动刷新 · 数据来自本地台账' + (lastListAt ? ' · 上次 ' + dgClock(lastListAt) : '')),
          h('button', { type: 'button', className: 'dm-dg-btn', onClick: function () { loadList(false) }, disabled: loading },
            loading ? h('span', { className: 'dm-dg-loading' }, h('span', { className: 'dm-dg-spin' }), '刷新中') : '刷新')
        ),
        notice ? h('div', { className: 'dm-dg-notice ' + notice.type }, notice.text) : null,
        h('div', { className: 'dm-dg-body', style: { '--dm-dg-list-w': listWidth + 'px' } },
          h('section', { className: 'dm-dg-pane' },
            h('div', { className: 'dm-dg-pane-head' }, '委托列表', h('span', { className: 'dm-dg-sub' }, '(' + visibleTasks.length + (visibleTasks.length !== tasks.length ? '/' + tasks.length : '') + ')')),
            h('div', { className: 'dm-dg-filters' },
              h(FilterSelect, { label: '委托方', value: filterFromNode, options: [''].concat(fromNodeOptions), onChange: setFilterFromNode, renderLabel: function (opt) { return opt === '' ? '全部节点' : nodeOptionLabel(opt, true) } }),
              h(FilterSelect, { label: '接收方', value: filterToNode, options: [''].concat(toNodeOptions), onChange: setFilterToNode, renderLabel: function (opt) { return opt === '' ? '全部节点' : nodeOptionLabel(opt, false) } }),
              h(FilterSelect, { label: '源实例', value: filterFrom, options: [''].concat(fromOptions), onChange: setFilterFrom, renderLabel: function (opt) { return opt === '' ? '全部' : (opt || '未记录') } }),
              h(FilterSelect, { label: '目标实例', value: filterTo, options: [''].concat(toOptions), onChange: setFilterTo, renderLabel: function (opt) { return opt === '' ? '全部' : (opt || '未记录') } }),
              h('button', { type: 'button', className: 'dm-dg-fbtn', onClick: resetFilters }, '重置筛选'),
              h('span', { className: 'dm-dg-fhint' }, '源实例仅对 2026-11-07 之后新发的委托有效，历史记录显示未记录')
            ),
            h('div', { className: 'dm-dg-scroll' },
              loading && tasks.length === 0 ? h('div', { className: 'dm-dg-skel' }, h('i'), h('i'), h('i'), h('i')) : null,
              !loading && tasks.length === 0 ? h('div', { className: 'dm-dg-empty' }, '暂无委托记录', h('br'), '有委托后这里会自动出现') : null,
              !loading && tasks.length > 0 && visibleTasks.length === 0 ? h('div', { className: 'dm-dg-empty' }, '当前筛选无匹配委托') : null,
              visibleTasks.map(function (task) {
                var tone = dgTone(task.state)
                return h('div', {
                  key: task.taskId,
                  className: 'dm-dg-row ' + tone + (task.taskId === selectedId ? ' active' : ''),
                  onClick: function () { if (task.taskId !== selectedId) selectTask(task) },
                  title: task.goal || ''
                },
                  h('div', { className: 'dm-dg-row-top' },
                    task.activeFresh ? h(LoadingSpinner, { size: 12 }) : null,
                    h('span', { className: 'dm-dg-route' },
                      h('span', { className: 'dm-dg-from' }, task.fromLabel || task.from || '?'),
                      (task.fromIsLocal || (localNode && task.from === localNode)) ? h('span', { className: 'dm-dg-me' }, task.fromInstance ? '本机·' + task.fromInstance : '本机') : null,
                      h('span', { className: 'dm-dg-arrow' }, '→'),
                      h('span', { className: 'dm-dg-to' }, (task.nodeLabel || task.node || '?') + (task.instance ? ' · ' + task.instance : ''))
                    ),
                    dgChip(task.state),
                    h('span', { className: 'dm-dg-row-time' }, (task.isActive ? '更新 ' : '完成 ') + dgClock(task.displayAt || task.updatedAt))
                  ),
                  h('div', { className: 'dm-dg-goal' }, task.goal || '(无目标)'),
                  h('div', { className: 'dm-dg-meta' },
                    task.instance ? h('span', { className: 'dm-dg-badge' }, task.instance) : null,
                    h('span', null, '历时 ' + dgDur(task.durationSec)),
                    h('span', null, task.taskId),
                    task.policy ? h('span', null, dgPolicyLabel(task.policy)) : null
                  )
                )
              })
            )
          ),
          h('div', { className: 'dm-dg-divider', title: '拖动调整列表宽度，双击复位', onPointerDown: startResize, onDoubleClick: resetResize }),
          h('section', { className: 'dm-dg-pane' },
            h('div', { className: 'dm-dg-pane-head' },
              '任务详情',
              h('span', { className: 'dm-dg-sub' }, selected ? selected.taskId + (lastTaskAt ? ' · 状态更新于 ' + dgClock(lastTaskAt) : '') : '未选择'),
              h('span', { className: 'dm-dg-spacer' }),
              selected ? h('button', { type: 'button', className: 'dm-dg-btn', onClick: function () { selectTask(selected) }, disabled: taskLoading },
                taskLoading ? h('span', { className: 'dm-dg-loading' }, h('span', { className: 'dm-dg-spin' }), '查询中') : '刷新状态') : null
            ),
            h('div', { className: 'dm-dg-scroll' },
              selected === null
                ? h('div', { className: 'dm-dg-empty' }, '在左侧选择一条委托', h('br'), '可查看任务详情与对端会话（只读）')
                : h('div', { className: 'dm-dg-detail' },
                  h('div', { className: 'dm-dg-sec' },
                    h('div', { className: 'dm-dg-sec-head' }, '概要'),
                    h('div', { className: 'dm-dg-sec-body' },
                      h('div', { className: 'dm-dg-kv' },
                        h('span', { className: 'dm-dg-k' }, '状态'),
                        h('span', { className: 'dm-dg-v' },
                          selected.activeFresh ? h(LoadingSpinner, { size: 13 }) : null,
                          dgChip(selected.state)
                        )
                      ),
                      kv('委托方', (selected.fromLabel || selected.from || '—') + ((selected.fromIsLocal || (localNode && selected.from === localNode)) ? '（本机）' : '')),
                      kv('接收方', (selected.nodeLabel || selected.node || '—') + (selected.instance ? ' · ' + selected.instance : '')),
                      kv('目标实例', selected.instance || '—'),
                      kv('策略', dgPolicyLabel(selected.policy)),
                      kv('历时' + (artifacts && artifacts.durationSec != null ? '（实测）' : ''), artifacts && artifacts.durationSec != null ? dgDur(artifacts.durationSec) : dgDur(selected.durationSec)),
                      kv('开始时间', artifacts && artifacts.requestedAt ? dgClock(artifacts.requestedAt) : dgClock(selected.createdAt)),
                      kv('结束时间', artifacts && artifacts.finishedAt ? dgClock(artifacts.finishedAt) : '—'),
                      kv('台账更新', dgClock(selected.updatedAt))
                    )
                  ),
                  h('div', { className: 'dm-dg-sec' },
                    h('div', { className: 'dm-dg-sec-head' }, '标识'),
                    h('div', { className: 'dm-dg-sec-body' },
                      kv('taskId', selected.taskId, 'taskId'),
                      kv('conversation', selected.conversationId, 'conversationId'),
                      kv('sessionId', selected.sessionId, 'sessionId')
                    )
                  ),
                  h('div', { className: 'dm-dg-sec' },
                    h('div', { className: 'dm-dg-sec-head' }, '目标'),
                    h('div', { className: 'dm-dg-sec-body' }, h('div', { className: 'dm-dg-pre' }, selected.goal || '(无目标)'))
                  ),
                  rich ? h('div', { className: 'dm-dg-sec' },
                    h('div', { className: 'dm-dg-sec-head' }, '时间线'),
                    h('div', { className: 'dm-dg-sec-body' },
                      kv('委托发出', rich.timeline ? dgClock(rich.timeline.requestedAt) : '—'),
                      kv('对端心跳', rich.timeline ? dgClock(rich.timeline.heartbeatAt) : '—'),
                      kv('结束时间', rich.timeline ? dgClock(rich.timeline.finishedAt) : '—'),
                      kv('响应耗时', rich.timeline && rich.timeline.responseSec != null ? dgDur(rich.timeline.responseSec) : '—'),
                      kv('执行耗时', rich.timeline && rich.timeline.execSec != null ? dgDur(rich.timeline.execSec) : '—'),
                      kv('总耗时', rich.timeline && rich.timeline.totalSec != null ? dgDur(rich.timeline.totalSec) : dgDur(selected.durationSec))
                    )
                  ) : null,
                  rich && (rich.operations && (rich.operations.commandsRun.length > 0 || rich.operations.evidence.length > 0 || rich.operations.notes)) ? h('div', { className: 'dm-dg-sec' },
                    h('div', { className: 'dm-dg-sec-head' }, '对端操作',
                      rich.operations.readonly ? h('span', { className: 'dm-dg-chip ok' }, '只读') : null
                    ),
                    h('div', { className: 'dm-dg-sec-body' },
                      rich.operations.notes ? h('div', { className: 'dm-dg-pre' }, rich.operations.notes) : null,
                      rich.operations.commandsRun.length > 0 ? h('div', null,
                        h('div', { className: 'dm-dg-sub' }, '执行过的命令（对端回报）'),
                        h('div', { className: 'dm-dg-pre' }, rich.operations.commandsRun.map(function (item) { return '· ' + item }).join('\n'))
                      ) : null,
                      rich.operations.evidence.length > 0 ? h('div', null,
                        h('div', { className: 'dm-dg-sub' }, '产物/证据'),
                        h('div', { className: 'dm-dg-pre' }, rich.operations.evidence.map(function (item) { return '· ' + item }).join('\n'))
                      ) : null
                    )
                  ) : null,
                  rich && (rich.operations && (rich.operations.scope || rich.operations.acceptance || rich.operations.sessionPolicy)) ? h('div', { className: 'dm-dg-sec' },
                    h('div', { className: 'dm-dg-sec-head' }, '权限 / 范围'),
                    h('div', { className: 'dm-dg-sec-body' },
                      kv('会话策略', rich.operations.sessionPolicy ? dgPolicyLabel(rich.operations.sessionPolicy) : '—'),
                      kv('目标实例', rich.operations.targetInstance || '—'),
                      kv('工作区', rich.operations.workspace || '—'),
                      kv('授权范围', rich.operations.scope || '（未声明）'),
                      kv('验收标准', rich.operations.acceptance || '（未声明）')
                    )
                  ) : null,
                  h('div', { className: 'dm-dg-sec' },
                    h('div', { className: 'dm-dg-sec-head' }, '对端状态',
                      h('span', { className: 'dm-dg-sub' }, taskLoading ? '查询中…' : detail ? '已取到 status.json' : '未查询')),
                    h('div', { className: 'dm-dg-sec-body' },
                      st.degraded ? h('div', { className: 'dm-dg-notice bad' }, '对端查询失败，已降级显示本地台账：' + String(st.error || '')) : null,
                      kv('状态', st.state ? dgStateLabel(st.state) : '—'),
                      kv('会话状态', st.sessionState ? dgStateLabel(st.sessionState) : '—'),
                      kv('心跳延迟', st.staleSeconds == null ? '—' : String(st.staleSeconds) + ' 秒'),
                      kv('error', st.error || '—'),
                      st.result ? h('div', { className: 'dm-dg-pre' }, JSON.stringify(st.result, null, 2)) : null
                    )
                  ),
                  h('div', { className: 'dm-dg-sec' },
                    h('div', { className: 'dm-dg-sec-head' },
                      '对端会话',
                      h('span', { className: 'dm-dg-sub' }, session ? ('轮次 ' + (session.totalMessages || sessionMessages.length) + ' · 帧 ' + (session.frameCount || '—') + ' · ' + Math.round((session.bytes || 0) / 1024) + ' KB') : '只读'),
                      h('span', { className: 'dm-dg-spacer' }),
                      h('button', { type: 'button', className: 'dm-dg-btn primary', onClick: loadSession, disabled: sessionLoading || !selected.sessionId },
                        sessionLoading ? h('span', { className: 'dm-dg-loading' }, h('span', { className: 'dm-dg-spin' }), '加载中') : (session ? '重新加载' : '加载会话'))
                    ),
                    h('div', { className: 'dm-dg-sec-body' },
                      session ? (session.title ? h('div', { className: 'dm-dg-sub' }, '标题：' + session.title) : null) : null,
                      session
                        ? h('div', { className: 'dm-dg-msgs' },
                            sessionMessages.length === 0 ? h('div', { className: 'dm-dg-empty' }, '无消息') : null,
                            sessionMessages.map(function (msg, idx) {
                              return h('div', { key: idx, className: 'dm-dg-msg ' + (msg.role || '') },
                                h('div', { className: 'dm-dg-msg-head' }, h('span', null, msg.role || '?'), msg.time ? h('span', null, msg.time) : null),
                                h('div', { className: 'dm-dg-msg-text' }, String(msg.text || ''))
                              )
                            })
                          )
                        : h('div', { className: 'dm-dg-empty' }, selected.sessionId ? '点击右上「加载会话」查看对端会话正文' : '该委托没有 sessionId')
                    )
                  )
                )
            )
          )
        )
      )
    }

    var SECTION = { name: 'settings.section', id: 'dsh-mesh', order: 90, label: 'AI 网络' }
    var inject = ['slots']

    // 2026-11-07：设置左侧导航里「AI 网络」这一项，把壳的默认齿轮换成三节点图标，颜色跟随 --dsh-brand-color
    function navMeshIconDom(referenceClass) {
      var NS = 'http://www.w3.org/2000/svg'
      var svg = document.createElementNS(NS, 'svg')
      if (referenceClass) svg.setAttribute('class', referenceClass)
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.4')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('data-dsh-mesh-nav-icon', '1')
      svg.style.color = 'var(--dsh-brand-color, currentColor)'
      var line = document.createElementNS(NS, 'path')
      line.setAttribute('d', 'M8 3.2 L3.2 8 M8 3.2 L12.8 8 M3.2 8 L12.8 8')
      line.setAttribute('opacity', '.7')
      svg.appendChild(line)
      var dots = [[8, 3.2], [3.2, 8], [12.8, 8]]
      for (var i = 0; i < dots.length; i++) {
        var circle = document.createElementNS(NS, 'circle')
        circle.setAttribute('cx', dots[i][0])
        circle.setAttribute('cy', dots[i][1])
        circle.setAttribute('r', '1.6')
        circle.setAttribute('fill', 'currentColor')
        circle.setAttribute('stroke', 'none')
        svg.appendChild(circle)
      }
      return svg
    }
    function decorateMeshNav() {
      try {
        var buttons = document.querySelectorAll('[role="dialog"] nav button')
        for (var i = 0; i < buttons.length; i++) {
          var button = buttons[i]
          var text = (button.textContent || '').trim()
          if (text !== 'AI 网络' && text !== 'AI 网络（dsh-mesh）') continue
          if (button.querySelector('svg[data-dsh-mesh-nav-icon]')) continue
          var gear = button.querySelector('svg')
          var className = gear ? gear.getAttribute('class') || '' : ''
          var icon = navMeshIconDom(className)
          if (gear && gear.parentNode === button) button.replaceChild(icon, gear)
          else button.insertBefore(icon, button.firstChild)
        }
      } catch (error) {
        /* ignore */
      }
    }

    function apply(ctx) {
      var disposers = []
      try {
        disposers.push(ctx.slots.inject('settings.section', function () { return ctx.slots.register(SECTION, MeshStatusSection) }))
      } catch (error) {
        console.warn('[dsh-mesh-ui] settings section registration failed:', error)
      }
      // 2026-11-07 方案 A：左侧栏「委托」面板（sidebar.panellist + main）
      try {
        disposers.push(ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({ name: 'sidebar.panellist', id: 'mesh-delegations', order: 55, label: function () { return '委托' } }, meshPanelIcon)
        }))
        disposers.push(ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'mesh-delegations', inject: function () { return {} } }, MeshDelegationPanel)
        }))
      } catch (error) {
        console.warn('[dsh-mesh-ui] delegation panel registration failed:', error)
      }
      var navObserver = null
      var navTimer = null
      try {
        if (typeof MutationObserver !== 'undefined' && document.body) {
          navObserver = new MutationObserver(function () { decorateMeshNav() })
          navObserver.observe(document.body, { childList: true, subtree: true })
        }
        navTimer = setInterval(decorateMeshNav, 1500)
        if (navTimer && typeof navTimer.unref === 'function') navTimer.unref()
      } catch (error) {
        /* ignore */
      }
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i++) { try { disposers[i]() } catch (_) { /* ignore */ } }
          try { if (navObserver) navObserver.disconnect() } catch (_) { /* ignore */ }
          try { if (navTimer) clearInterval(navTimer) } catch (_) { /* ignore */ }
        }
      }, 'dsh-mesh-ui: settings section + nav icon')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
