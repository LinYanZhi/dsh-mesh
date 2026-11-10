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
    var REFRESH_MS = 5000
    var SUPPORTS_ZOOM = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('zoom', '1.5')

    // 2026-11-07 用户要求：卡片标题只用固定中文叫法，不显示电脑设备名
    var NODE_LABELS = {}
    // 2026-11-09 用户要求：名称后显示设备类型。类型依据设备快照（CPU 形态）判断，可直接改这张表：
    var DEVICE_TYPES = {}
    function deviceType(name) {
      var raw = String(name || '').toLowerCase()
      var key = peerDeviceKey(raw)
      return DEVICE_TYPES[key] || DEVICE_TYPES[raw] || ''
    }
    function nodeDisplay(name) {
      var label = nodeLabel(name)
      var type = deviceType(name)
      return type ? label + ' · ' + type : label
    }
      // 同一台设备可能有多个 peer 记录（不同 token/入口：peer-node / peer-node-lan / peer-node-exec）。
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
    // [layout-helpers-begin] 2026-11-09 拓扑自定义布局：节点 key 顺序 + localStorage 持久化 + clamp
    var LAYOUT_STORE_KEY = 'dsh-mesh-ui.topology.layout.v1'
    function topologyNodeKeys(data) {
      var d = data || {}
      var peers = filterSelfPeers(dedupePeers(d.peers || []), d.nodeName)
      return ['local'].concat(peers.map(function (peer) { return 'peer:' + peer.name }))
    }
    // 2026-11-10：设备显示顺序（左→右 / 逆时针）——拓扑渲染与拖拽位置表必须共用同一顺序
    var FAN_ORDER = []
    function fanRankOfNodeKey(key, data) {
      var dev = key === 'local' ? peerDeviceKey(data && data.nodeName) : peerDeviceKey(String(key || '').replace(/^peer:/, ''))
      var idx = FAN_ORDER.indexOf(dev)
      return idx < 0 ? 99 : idx
    }
    function orderedNodeKeys(data) {
      var keys = topologyNodeKeys(data).slice()
      keys.sort(function (a, b) {
        var d = fanRankOfNodeKey(a, data) - fanRankOfNodeKey(b, data)
        return d !== 0 ? d : String(a).localeCompare(String(b))
      })
      return keys
    }
    // 2026-11-10：用户手工调整后认可的默认布局（世界坐标，10000×6000 画布内）
    // 设备按设备名（home/peer-node/company/peer-node/peer-node）映射，各机通用；服务器两张卡单独一张表
    var DEFAULT_DEVICE_POS = {}
    var DEFAULT_INFRA_POS = {
      aliyun: [4887.59, 2856.78],
      sakura: [5177.39, 2858.40]
    }
    function devKeyOfNodeKey(key, data) {
      return key === 'local' ? peerDeviceKey(data && data.nodeName) : peerDeviceKey(String(key || '').replace(/^peer:/, ''))
    }
    function loadMovedLayout() {
      try {
        var raw = window.localStorage.getItem(LAYOUT_STORE_KEY)
        if (!raw) return {}
        var obj = JSON.parse(raw)
        return obj && typeof obj === 'object' ? obj : {}
      } catch (_) { return {} }
    }
    function saveMovedLayout(obj) {
      try { window.localStorage.setItem(LAYOUT_STORE_KEY, JSON.stringify(obj || {})) } catch (_) { /* ignore */ }
    }
    function clampNum(v, min, max) { return Math.max(min, Math.min(max, v)) }
    // [layout-helpers-end]
    // [relay-helpers-begin] 2026-11-09 架构层：识别公网中转站(frps)与通信方式（纯函数，可单测）
    // 2026-11-10 隐私：默认不展示公网 IP/域名；局域网/回环地址保留。
    // 用户在页头打开「显示公网地址」后，maskHost/maskText 直接返回原值。
    var showPublicAddresses = false
    function isPrivateNetworkHost(raw) {
      var h = String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
      h = h.replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '')
      if (!h) return true
      if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '127.0.0.1') return true
      if (/(\.local|\.lan|\.home|\.internal)$/.test(h)) return true
      var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
      if (m) {
        var a = Number(m[1]); var b = Number(m[2])
        return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      }
      return false
    }
    function maskHost(raw) {
      var s = String(raw || '').trim()
      if (showPublicAddresses) return s || '—'
      if (!s) return '—'
      var port = ''
      var m = /^(.*):(\d+)$/.exec(s)
      if (m && m[1].indexOf(']') < 0) { s = m[1]; port = ':' + m[2] }
      return (isPrivateNetworkHost(s) ? s : '公网地址已隐藏') + port
    }
    function maskText(value) {
      if (showPublicAddresses) return value
      if (typeof value !== 'string') return value
      return value
        .replace(/https?:\/\/[^\s"'<>]+/gi, function (u) {
          try { var x = new URL(u); return isPrivateNetworkHost(x.hostname) ? u : (x.protocol + '//公网地址已隐藏' + (x.port ? ':' + x.port : '')) } catch (e) { return u }
        })
        .replace(/\b(?!10\.|192\.168\.|127\.|172\.(?:1[6-9]|2\d|3[01])\.)(?:\d{1,3}\.){3}\d{1,3}\b/g, '公网地址已隐藏')
        .replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|cn|top|xyz|me|cc|app|cloud)(?::\d+)?\b/gi, '公网地址已隐藏')
    }
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
      if (relay) return { text: (relay.kind === 'frp' ? '域名穿透' : '自建 frps 中转') + ' · ' + maskHost(relay.host) + port, short: '中转' + (t.port ? ' ' + t.port : '') }
      if (t.kind === 'loopback') return { text: '本机回环', short: '本机' }
      if (t.kind === 'lan') return { text: '局域网直连 · ' + maskHost(t.host) + port, short: 'LAN' }
      if (t.kind === 'frp') return { text: '公网穿透 · ' + maskHost(t.host) + port, short: '穿透' }
      if (t.kind === 'wan') return { text: '公网直连 · ' + maskHost(t.host) + port, short: '公网' }
      return { text: (t.label || t.kind || '未知') + ' · ' + maskHost(t.host) + port, short: t.label || '未知' }
    }
    // [relay-helpers-end]
    var W = 560
    var H = 400
    var MIN_SCALE = 0.18
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
.dm-viewport.resizing { cursor:ns-resize; }
/* 2026-11-09：画布高度可拖拽调整 */
.dm-resize { position:absolute; left:50%; bottom:0; transform:translateX(-50%); width:64px; height:12px; z-index:6; cursor:ns-resize; display:flex; align-items:center; justify-content:center; border-radius:6px 6px 0 0; background:rgba(128,128,128,.18); color:rgba(128,128,128,.9); font-size:12px; line-height:1; user-select:none; }
.dm-resize:hover { background:rgba(88,166,255,.28); color:#7fb4ff; }
/* 2026-11-09：悬浮节点高亮 + 连线上显示完整地址 */
.dm-edge-label { paint-order: stroke; stroke: rgba(15,17,21,.9); stroke-width: 3px; font-family: ui-monospace,Consolas,monospace; pointer-events: none; }
body.light .dm-edge-label { stroke: rgba(255,255,255,.92); }
.dm-card-node.hovered { border-color: rgba(88,166,255,.95) !important; box-shadow: 0 0 0 2px rgba(88,166,255,.35), 0 10px 26px rgba(0,0,0,.25); z-index: 5; }
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
.dm-n-name span.dm-ell { overflow:visible; text-overflow:clip; white-space:nowrap; }
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
.dm-card-domain { margin-top:6px; font-size:10px; opacity:.72; overflow:visible; text-overflow:clip; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.dm-card-dsh { margin-top:6px; }
/* 2026-11-09-v6：详情卡列数自适应（宽屏 3 列），不再固定 2 列 */
.dm-devices { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:10px; align-items:start; }
/* 2026-11-09：三通道筛选浮层（画布内左上） */
.dm-topo-wrap { display:flex; flex-direction:column; gap:6px; }
.dm-topbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dm-topbar-info { font-size:10.5px; opacity:.55; margin-left:auto; white-space:nowrap; }
.dm-filters { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dm-flt { display:flex; align-items:center; gap:5px; font-size:11.5px; opacity:.55; border:1px solid rgba(128,128,128,.3); border-radius:999px; padding:1px 7px; cursor:pointer; user-select:none; }
.dm-flt.on { opacity:1; border-color:var(--c); }
.dm-flt input { margin:0; accent-color:var(--c); }
.dm-card-node.server { border-radius:12px; background:rgba(128,128,128,.06); }
        .dm-chip.type { border-color:rgba(88,166,255,.5); color:#7fb4ff; }
/* 2026-11-09：三通道虚线流动动画（位移量必须是 dash 周期 11px 的整数倍，否则循环会抽搐） */
@keyframes dm-dashflow { to { stroke-dashoffset: -22; } }
.dm-lines path.dm-edge-frp { animation: dm-dashflow 1.15s linear infinite; stroke-linecap: butt; }
@media (prefers-reduced-motion: reduce) { .dm-lines path.dm-edge-frp { animation: none; } }
.dm-infra-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:10px; margin-top:10px; }
.dm-infra-card { border:1px solid rgba(128,128,128,.3); border-radius:11px; padding:9px 11px; background:rgba(128,128,128,.05); }
.dm-infra-head { display:flex; align-items:center; gap:7px; font-weight:650; font-size:12.5px; margin-bottom:5px; }
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
.dm-zoom button { width:22px; height:22px; border-radius:6px; border:1px solid rgba(128,128,128,.3); background:transparent; color:inherit; cursor:pointer; font-size:13px; line-height:1; padding:0; display:flex; align-items:center; justify-content:center; }
.dm-zoom button:hover { background:rgba(128,128,128,.16); }
.dm-zoom .pct { font-size:10.5px; opacity:.6; align-self:center; padding:0 2px; font-variant-numeric:tabular-nums; }
.dm-hint { font-size:10.5px; opacity:.45; padding:0 2px; }

/* 折叠面板 */
.dm-details { border:1px solid rgba(128,128,128,.22); border-radius:11px; background:rgba(128,128,128,.035); }
.dm-details > summary { cursor:pointer; padding:9px 12px; font-weight:600; font-size:12.5px; list-style:none; display:flex; align-items:center; gap:8px; }
.dm-details > summary::-webkit-details-marker { display:none; }
.dm-details > summary::before { content:'▸'; font-size:10px; opacity:.5; transition:transform .12s; }
.dm-details[open] > summary::before { transform:rotate(90deg); }
.dm-details > .dm-details-body { padding:0 12px 11px; }
.dm-table { width:100%; border-collapse:collapse; }
.dm-table th { text-align:left; font-weight:600; font-size:11px; opacity:.5; padding:2px 8px 5px 0; border-bottom:1px solid rgba(128,128,128,.2); white-space:nowrap; }
.dm-table td { padding:5px 8px 5px 0; border-bottom:1px solid rgba(128,128,128,.1); font-size:12px; }
.dm-table tr:last-child td { border-bottom:none; }
/* 2026-11-10：委托台账表改为固定列宽 + 单行省略；非固定布局下 5 列会把「节点/任务」压到
   每行一个字，就是用户看到的竖排。完整内容看 title 悬浮提示。 */
.dm-details .dm-table { table-layout:fixed; min-width:420px; }
.dm-table-wrap { overflow-x:auto; }
.dm-details .dm-table th, .dm-details .dm-table td { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dm-details .dm-table th:nth-child(1), .dm-details .dm-table td:nth-child(1) { width:16%; }
.dm-details .dm-table th:nth-child(2), .dm-details .dm-table td:nth-child(2) { width:18%; }
.dm-details .dm-table th:nth-child(3), .dm-details .dm-table td:nth-child(3) { width:22%; }
.dm-details .dm-table th:nth-child(4), .dm-details .dm-table td:nth-child(4) { width:10%; }
/* 目标列不写死百分比：让它吃掉剩余空间（单元格右内边距不参与百分比，写死 34% 会溢出 1 条横向滚动条） */
.dm-trunc { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:inline-block; vertical-align:bottom; }
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
/* 2026-11-09 拓扑自定义布局：卡片可拖拽 */
.dm-card-node.draggable { cursor:grab; touch-action:none; }
.dm-card-node.draggable:active { cursor:grabbing; }
.dm-card-node.dragging { z-index:20; border-color:rgba(88,166,255,.85) !important; box-shadow:0 12px 34px rgba(0,0,0,.30) !important; }
.dm-layout-btn.active { border-color:rgba(88,166,255,.6); color:#3b82d6; }
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
    // 2026-11-10：当前筛选下可见的服务器数量（0/1/2），用于拓扑布局
    function visibleServerCount(data, show) {
      var s = show || { lan: true, public: true, sakura: true }
      var d = data || {}
      var peers = filterSelfPeers(dedupePeers(d.peers || []), d.nodeName)
      var hasPublic = Boolean(publicEntryFor(d.localTunnel || {})) || peers.some(function (p) { var pt = p.tunnel || {}; return !isLanPeer(p) && Boolean(pt.host) && (pt.kind === 'frp' || pt.kind === 'wan') })
      var acc = sakuraAccountOf(d)
      var hasSakura = Boolean(acc && (acc.tunnels || []).length)
      return (s.public && hasPublic ? 1 : 0) + (s.sakura && hasSakura ? 1 : 0)
    }

    function Viewport(props) {
      var layout = props.layout
      // 2026-11-10：按当前筛选的可见服务器数量决定布局（0/1/2）
      var currentFilters = (function () { try { var s = JSON.parse(window.localStorage.getItem('dsh-mesh-ui.filters.v1') || '{}') || {}; return { lan: s.lan !== false, public: s.public !== false, sakura: s.sakura !== false } } catch (_) { return { lan: true, public: true, sakura: true } } })()
      var serverCount = visibleServerCount(props.data, currentFilters)
      // 2026-11-09-v5：卡片宽度自适应 —— 子组件测量真实卡片宽高后回传，按实际尺寸重算多边形布局
      var sizeState = useState(null)
      var measuredSize = sizeState[0]
      var setMeasuredSize = sizeState[1]
      if (measuredSize && measuredSize.w > 0 && measuredSize.h > 0) {
        layout = computeLayout(layout.count, { cardW: measuredSize.w, cardH: measuredSize.h, serverCount: serverCount })
      } else {
        layout = computeLayout(layout.count, { serverCount: serverCount })
      }
      var infraBoundsRef = useRef([])
      // 2026-11-09：重置拓扑时同时通知 Topology 复位服务器卡片
      var resetNonceState = useState(0)
      var resetNonce = resetNonceState[0]
      var bumpResetNonce = resetNonceState[1]
      function onInfraBounds(boxes) { infraBoundsRef.current = boxes || [] }
      function onCardSize(w, h) {
        setMeasuredSize(function (prev) {
          if (prev && prev.w === w && prev.h === h) return prev
          return { w: w, h: h }
        })
      }
      // 2026-11-09 自定义布局：moved[key] = [x,y]（绝对世界坐标；localStorage 持久化，重置清空）
      // 2026-11-09-v2：用户反馈「拖不远」→ 世界画布固定放大（可拖很开），自适应按实际内容 bbox 缩放，
      // 而不是按初始画布尺寸；卡片只能在世界边界内移动（防止拖丢），但世界足够大。
      var WORLD_MIN_W = 10000
      var WORLD_MIN_H = 6000
      var WORLD_PAD = 16
      var nodeKeys = orderedNodeKeys(props.data)
      var layoutState = useState(loadMovedLayout)
      var movedLayout = layoutState[0]
      var setMovedLayout = layoutState[1]
      var worldW = Math.max(layout.W, WORLD_MIN_W)
      var worldH = Math.max(layout.H, WORLD_MIN_H)
      var baseOffsetX = (worldW - layout.W) / 2
      var baseOffsetY = (worldH - layout.H) / 2
      var positions = layout.positions.map(function (p, idx) {
        var m = movedLayout[nodeKeys[idx]]
        if (m && m.length === 2) return [Number(m[0]), Number(m[1])]
        var devKey = devKeyOfNodeKey(nodeKeys[idx], props.data)
        var def = layout.mode === 'servers-top' ? DEFAULT_DEVICE_POS[devKey] : null
        if (def) return [def[0], def[1]]
        return [p[0] + baseOffsetX, p[1] + baseOffsetY]
      })
      var effLayout = Object.assign({}, layout, { W: worldW, H: worldH, positions: positions, baseOffsetX: baseOffsetX, baseOffsetY: baseOffsetY, contentW: layout.W, contentH: layout.H })
      function moveNode(key, pos) {
        setMovedLayout(function (prev) {
          var next = Object.assign({}, prev)
          next[key] = pos
          saveMovedLayout(next)
          return next
        })
      }
      function resetLayout() {
        setMovedLayout({})
        saveMovedLayout({})
        // 2026-11-10：重置只恢复拓扑结构，保留用户手动拖拽的画布高度
        interactedRef.current = false
        bumpResetNonce(function (x) { return x + 1 })
        setTimeout(fit, 120)
      }
      // 2026-11-09-v3：拖卡片到画布边缘时自动平移视角（不用手动挪画面就能拖很远）
      function autoPanAt(clientX, clientY) {
        var el = viewRef.current
        if (!el) return
        var rect = el.getBoundingClientRect()
        var MARGIN = 60
        var SPEED = 16
        var dx = 0
        var dy = 0
        if (clientX < rect.left + MARGIN) dx = SPEED * Math.min(1, (rect.left + MARGIN - clientX) / MARGIN)
        else if (clientX > rect.right - MARGIN) dx = -SPEED * Math.min(1, (clientX - (rect.right - MARGIN)) / MARGIN)
        if (clientY < rect.top + MARGIN) dy = SPEED * Math.min(1, (rect.top + MARGIN - clientY) / MARGIN)
        else if (clientY > rect.bottom - MARGIN) dy = -SPEED * Math.min(1, (clientY - (rect.bottom - MARGIN)) / MARGIN)
        if (!dx && !dy) return
        interactedRef.current = true
        setView(function (prev) { return { scale: prev.scale, x: prev.x + dx, y: prev.y + dy } })
      }
      var viewRef = useRef(null)
      // 2026-11-09：画布高度可上下拖拽调整（持久化；双击恢复默认）
      var heightState = useState(function () { try { var v = Number(window.localStorage.getItem('dsh-mesh-ui.viewportH.v1') || 0); return v > 0 ? v : 0 } catch (e) { return 0 } })
      var customHeight = heightState[0]
      var setCustomHeight = heightState[1]
      // 2026-11-10：画布默认高度自动跟随内容（避免固定 34vh 导致"拓扑区域又高又空"）；手动拖过则以手动为准
      var autoHState = useState(0)
      var autoH = autoHState[0]
      var setAutoH = autoHState[1]
      var customHeightRef = useRef(0)
      var resizeRef = useRef(null)
      var resizingState = useState(false); var resizing = resizingState[0]; var setResizing = resizingState[1]
      function onResizeDown(e) {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        var el = viewRef.current
        if (!el) return
        resizeRef.current = { sy: e.clientY, h: el.getBoundingClientRect().height }
        interactedRef.current = true
        setResizing(true)
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) { /* ignore */ }
      }
      function onResizeMove(e) {
        var r = resizeRef.current
        if (!r) return
        e.stopPropagation()
        var h2 = Math.max(240, Math.min(1600, Math.round(r.h + (e.clientY - r.sy))))
        setCustomHeight(h2)
        try { window.localStorage.setItem('dsh-mesh-ui.viewportH.v1', String(h2)) } catch (_) { /* ignore */ }
      }
      function onResizeUp(e) {
        if (!resizeRef.current) return
        e.stopPropagation()
        resizeRef.current = null
        setResizing(false)
        interactedRef.current = false
        setTimeout(fit, 0)
      }
      function resetHeight() {
        setCustomHeight(0)
        try { window.localStorage.removeItem('dsh-mesh-ui.viewportH.v1') } catch (_) { /* ignore */ }
        setTimeout(fit, 0)
      }
      var dragRef = useRef(null)
      var interactedRef = useRef(false)
      var s0 = useState({ scale: 1, x: 0, y: 0 }); var view = s0[0]; var setView = s0[1]
      var s1 = useState(false); var dragging = s1[0]; var setDragging = s1[1]
      // 2026-11-09：三通道筛选（局域网/公网/樱花）
      // 2026-11-10：筛选状态持久化；刷新/切页面后不再丢。
      var FILTER_STORE_KEY = 'dsh-mesh-ui.filters.v1'
      var filterState = useState(function () {
        try {
          var saved = JSON.parse(window.localStorage.getItem(FILTER_STORE_KEY) || '{}') || {}
          return { lan: saved.lan !== false, public: saved.public !== false, sakura: saved.sakura !== false }
        } catch (_) { return { lan: true, public: true, sakura: true } }
      })
      var showFilters = filterState[0]
      var setShowFilters = filterState[1]
      function toggleFilter(k) {
        setShowFilters(function (prev) {
          var n = Object.assign({}, prev)
          n[k] = !n[k]
          try { window.localStorage.setItem(FILTER_STORE_KEY, JSON.stringify(n)) } catch (_) { /* ignore */ }
          return n
        })
      }
      // fit 用最新布局的 ref（拖拽中不重算视角；只有初始化 / 窗口变化 / ⟲ 重置 / ⤢ 自适应才重算）
      var effRef = useRef(effLayout)
      effRef.current = effLayout

      var fit = useCallback(function () {
        var el = viewRef.current
        if (!el) return
        var rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        var cur = effRef.current || layout
        var halfW = cur.cardW / 2
        var halfH = cur.cardH / 2
        var xs = []
        var ys = []
        ;(cur.positions || []).forEach(function (p) { xs.push(p[0]); ys.push(p[1]) })
        if (!xs.length) { xs = [cur.W / 2]; ys = [cur.H / 2] }
        var minX = Math.min.apply(null, xs) - halfW - WORLD_PAD
        var maxX = Math.max.apply(null, xs) + halfW + WORLD_PAD
        var minY = Math.min.apply(null, ys) - halfH - WORLD_PAD
        var maxY = Math.max.apply(null, ys) + halfH + WORLD_PAD
        // 2026-11-09：中转服务器卡片（阿里云/樱花）位置由 Topology 维护，按真实包围盒纳入自适应
        ;(infraBoundsRef.current || []).forEach(function (b) {
          if (!b) return
          minX = Math.min(minX, b.x - b.w / 2 - WORLD_PAD)
          maxX = Math.max(maxX, b.x + b.w / 2 + WORLD_PAD)
          minY = Math.min(minY, b.y - b.h / 2 - WORLD_PAD)
          maxY = Math.max(maxY, b.y + b.h / 2 + WORLD_PAD)
        })
        var bw = Math.max(1, maxX - minX)
        var bh = Math.max(1, maxY - minY)
        var scale = Math.min(rect.width / bw, rect.height / bh) * 0.94
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
        setView({ scale: scale, x: (rect.width - bw * scale) / 2 - minX * scale, y: (rect.height - bh * scale) / 2 - minY * scale })
        // 画布默认高度 = 内容渲染高度 + 余量（仅当用户没手动调过高度）
        if (!customHeightRef.current) {
          var wantH = Math.max(150, Math.min(380, Math.round(bh * scale + 64)))
          setAutoH(function (prev) { return Math.abs(prev - wantH) >= 10 ? wantH : prev })
        }
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

      // 2026-11-10：筛选变化后按可见内容重新 fit；去掉的服务器不应继续占布局/留白
      useEffect(function () {
        interactedRef.current = false
        setTimeout(fit, 30)
      }, [showFilters.lan, showFilters.public, showFilters.sakura])

      // 2026-11-10：布局变化（节点数/卡片尺寸）后自动 fit（用户未手动缩放/平移时），避免停留在旧的缩放比例
      useEffect(function () {
        if (!interactedRef.current) setTimeout(fit, 40)
      }, [layout.count, layout.cardW, layout.cardH, layout.mode])

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
        if (event.target && event.target.closest && event.target.closest('button,a,summary,.dm-filters,.dm-zoom,.dm-resize')) return
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

      customHeightRef.current = customHeight
      customHeightRef.current = customHeight
      // 2026-11-10：画布内的文字/勾选项全部移到画布外（上方工具栏 = 勾选 + 链路信息；下方 = 缩放/说明）
      return h('div', { className: 'dm-topo-wrap' },
        h('div', { className: 'dm-topbar' },
          h('div', { className: 'dm-filters' },
            [['lan', '局域网'], ['public', '公网中继'], ['sakura', '第三方穿透']].map(function (it) {
              var tr = TRANSPORTS[it[0]]
              return h('label', { key: it[0], className: 'dm-flt' + (showFilters[it[0]] ? ' on' : ''), style: { '--c': tr.color } },
                h('input', { type: 'checkbox', checked: showFilters[it[0]], onChange: function () { toggleFilter(it[0]) } }),
                h('span', null, it[1])
              )
            })
          ),
          h('span', { className: 'dm-topbar-info' }, effLayout.count + ' 节点 · ' + effLayout.edges.length + ' 条链路 · 拖拽卡片自定义布局')
        ),
        h('div', { className: 'dm-viewport' + (dragging ? ' dragging' : '') + (resizing ? ' resizing' : ''), ref: viewRef,
          style: (customHeight || autoH) ? { height: (customHeight || autoH) + 'px' } : undefined,
          onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onPointerLeave: endDrag,
          onDoubleClick: function () { interactedRef.current = false; fit() } },
          // 2026-11-07：缩放改用 CSS zoom（重新布局、文字矢量重绘 → 放大不糊）；
          // 平移用外层 transform（不参与光栅缓存）。不再使用 will-change，避免整块被缓存成位图后放大发虚。
          h('div', { className: 'dm-world-outer', style: { transform: 'translate(' + view.x + 'px,' + view.y + 'px)' } },
            h('div', { className: 'dm-world', style: Object.assign({ width: effLayout.W + 'px', height: effLayout.H + 'px' },
              SUPPORTS_ZOOM ? { zoom: view.scale } : { transform: 'scale(' + view.scale + ')' }) },
              h(Topology, { data: props.data, layout: effLayout, selectedKey: props.selectedKey, onSelect: props.onSelect, scale: view.scale, onNodeMove: moveNode, onDragEdge: autoPanAt, onCardSize: onCardSize, show: showFilters, federated: props.federated, onInfraBounds: onInfraBounds, resetNonce: resetNonce })
            )
          ),
          h('div', { className: 'dm-zoom' },
            h('button', { title: '放大', onClick: function () { zoomBy(1.22) } }, '+'),
            h('button', { title: '缩小', onClick: function () { zoomBy(1 / 1.22) } }, '−'),
            h('button', { title: '自适应', onClick: function () { interactedRef.current = false; fit() } }, '⤢'),
            h('button', { className: 'dm-layout-btn', title: '重置为默认拓扑布局', onClick: resetLayout }, '↺'),
            h('span', { className: 'pct' }, Math.round(view.scale * 100) + '%')
          ),
          h('div', { className: 'dm-resize', title: '上下拖拽调整画布高度（双击恢复默认）',
            onPointerDown: onResizeDown, onPointerMove: onResizeMove, onPointerUp: onResizeUp, onPointerCancel: onResizeUp,
            onDoubleClick: resetHeight },
            h('span', null, '⋯')
          )
        ),
        h('div', { className: 'dm-hint' }, '拓扑 v23 · 内容 ' + Math.round(layout.W) + '×' + Math.round(layout.H) + 'px · 卡 ' + Math.round(layout.cardW) + '×' + Math.round(layout.cardH) + ' · 缩放 ' + Math.round(view.scale * 100) + '% · 滚轮缩放 / 拖拽平移')
      )
    }

    // ---------- 布局计算 ----------
    // 用户偏好（2026-11-07 明确）：
    //   4 节点 = 菱形（上/右/下/左）；5 节点 = 顶点朝上的五边形；6 = 六边形；n 节点 = 顶点朝上的正 n 边形。
    //   相邻节点的「轴对齐包围盒」必须留出 GAP，否则菱形斜向两张卡会贴住/重叠。
    // 2026-11-09-v6：默认布局 = 顶部「阿里云 / 樱花」服务器一排 + 设备沿下方弧线扇形展开（用户指定）

    // 2026-11-10：按可见服务器数量布局
    // 0 个服务器：仅节点，圆环居中；1 个服务器：服务器居中，节点在下方扇形展开；2 个：顶部服务器 + 下方弧线（原布局）
    function polygonEdges(count) {
      var edges = []
      for (var m = 0; m < count; m++) for (var n = m + 1; n < count; n++) edges.push([m, n])
      return edges
    }
    function layoutNodesOnly(count, cardW, cardH, GAP, PAD) {
      var n = Math.max(1, count)
      var radius = 0
      if (n > 1) radius = Math.max((cardW + GAP) / (2 * Math.sin(Math.PI / n)), cardH * 1.2)
      var raw = []
      for (var i = 0; i < n; i++) {
        var a = -Math.PI / 2 + (i * 2 * Math.PI) / n
        raw.push([radius * Math.cos(a), radius * Math.sin(a)])
      }
      var minX = Math.min(-cardW / 2, ...raw.map(function (p) { return p[0] - cardW / 2 }))
      var maxX = Math.max(cardW / 2, ...raw.map(function (p) { return p[0] + cardW / 2 }))
      var minY = Math.min(-cardH / 2, ...raw.map(function (p) { return p[1] - cardH / 2 }))
      var maxY = Math.max(cardH / 2, ...raw.map(function (p) { return p[1] + cardH / 2 }))
      var ox = -minX + PAD
      var oy = -minY + PAD
      var positions = raw.map(function (p) { return [Math.round(p[0] + ox), Math.round(p[1] + oy)] })
      var W = Math.ceil(maxX - minX + PAD * 2)
      var H = Math.ceil(maxY - minY + PAD * 2)
      var topDeviceY = positions.length ? Math.min.apply(null, positions.map(function (p) { return p[1] })) : 0
      return { count: n, cardW: cardW, cardH: cardH, gap: GAP, W: W, H: H, positions: positions, edges: polygonEdges(n), topDeviceY: topDeviceY, mode: 'nodes-only', serverCenter: null }
    }
    function layoutServerCenter(count, cardW, cardH, GAP, PAD) {
      var n = Math.max(1, count)
      var span = (2 * Math.PI) / 3
      var step = n > 1 ? span / (n - 1) : 0
      var radius = Math.max(cardH * 2.1, cardW * 1.25, step > 0 ? (cardW + GAP) / (2 * Math.sin(step / 2)) : 0)
      var raw = []
      for (var i = 0; i < n; i++) {
        var a = Math.PI / 6 + i * step
        raw.push([radius * Math.cos(a), radius * Math.sin(a)])
      }
      var minX = Math.min(-cardW / 2, ...raw.map(function (p) { return p[0] - cardW / 2 }))
      var maxX = Math.max(cardW / 2, ...raw.map(function (p) { return p[0] + cardW / 2 }))
      var minY = Math.min(-cardH / 2, ...raw.map(function (p) { return p[1] - cardH / 2 }))
      var maxY = Math.max(cardH / 2, ...raw.map(function (p) { return p[1] + cardH / 2 }))
      var ox = -minX + PAD
      var oy = -minY + PAD
      var positions = raw.map(function (p) { return [Math.round(p[0] + ox), Math.round(p[1] + oy)] })
      var W = Math.ceil(maxX - minX + PAD * 2)
      var H = Math.ceil(maxY - minY + PAD * 2)
      var topDeviceY = positions.length ? Math.min.apply(null, positions.map(function (p) { return p[1] })) : 0
      return { count: n, cardW: cardW, cardH: cardH, gap: GAP, W: W, H: H, positions: positions, edges: polygonEdges(n), topDeviceY: topDeviceY, mode: 'server-center', serverCenter: [Math.round(ox), Math.round(oy)] }
    }

    function computeLayout(count, override) {
      var GAP = 30
      var cardW = count <= 4 ? 210 : count <= 6 ? 196 : 176
      var cardH = count <= 4 ? 112 : count <= 6 ? 104 : 96
      if (override && override.cardW > 0) cardW = Math.ceil(override.cardW)
      if (override && override.cardH > 0) cardH = Math.ceil(override.cardH)
      var PAD = 16
      var serverCount = override && Number.isInteger(override.serverCount) ? override.serverCount : 2
      if (serverCount === 0) return layoutNodesOnly(count, cardW, cardH, GAP, PAD)
      if (serverCount === 1) return layoutServerCenter(count, cardW, cardH, GAP, PAD)
      var topTierH = Math.round(cardH * 1.1)
      var W, H, positions
      if (count <= 1) {
        W = cardW + PAD * 2
        H = topTierH + cardH + PAD * 2
        positions = [[W / 2, topTierH + cardH / 2 + PAD]]
      } else if (count === 2) {
        W = cardW * 2 + GAP + PAD * 2
        H = topTierH + cardH + PAD * 2
        positions = [[PAD + cardW / 2, topTierH + cardH / 2 + PAD], [PAD + cardW * 1.5 + GAP, topTierH + cardH / 2 + PAD]]
      } else {
        // 2026-11-09-v7：浅扁椭圆弧扇形（横向铺开、纵向贴近顶部服务器，压缩中间空白）
        var START = 150 * Math.PI / 180
        var END = 30 * Math.PI / 180
        var stepA = (START - END) / (count - 1)
        var MARGIN = 22
        var A = (cardW + MARGIN) / (2 * Math.sin(stepA / 2))
        for (var step = 0; step < 400; step++) {
          var ok = true
          for (var i = 0; i < count - 1 && ok; i++) {
            var a1 = START - i * stepA
            var a2 = START - (i + 1) * stepA
            var dx = Math.abs(A * Math.cos(a1) - A * Math.cos(a2))
            var dy = Math.abs(0.35 * A * Math.sin(a1) - 0.35 * A * Math.sin(a2))
            if (dx < cardW + MARGIN * 0.5 && dy < cardH + MARGIN * 0.5) ok = false
          }
          if (ok) break
          A += 4
        }
        var B = A * 0.35
        var halfW = A * Math.cos(END) + cardW / 2
        W = Math.ceil(2 * halfW + PAD * 2)
        var cx = W / 2
        var cy = topTierH + PAD
        H = Math.ceil(cy + B + cardH / 2 + PAD)
        positions = []
        for (var j = 0; j < count; j++) {
          var aj = START - j * stepA
          positions.push([cx + A * Math.cos(aj), cy + B * Math.sin(aj)])
        }
      }
      var edges = []
      for (var m = 0; m < count; m++) for (var n = m + 1; n < count; n++) edges.push([m, n])
      var topDeviceY = positions.length ? Math.min.apply(null, positions.map(function (p) { return p[1] })) : 0
      return { count: count, cardW: cardW, cardH: cardH, gap: GAP, W: W, H: H, positions: positions, edges: edges, topDeviceY: topDeviceY, mode: 'servers-top', serverCenter: null }
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
      // 2026-11-09：樱花账号隧道（PC 端 API 采集，跨设备含手机）
      var sakuraAccount = sakuraAccountOf(data)
      if (!groups.length && !direct.length && !sakuraAccount) return null
      return h('div', { className: 'dm-relay' },
        h('div', { className: 'dm-relay-head' },
          h('span', { className: 'dm-relay-title' }, '架构层 · 公网中转站'),
          h('span', { className: 'dm-sub' }, groups.length ? '虚线 = 经中转；实线/标签 = 直连。端口是各节点在中转站上的隧道入口' : '当前没有共享公网中转的 peer，全部为直连')
        ),
        groups.map(function (g, gi) {
          var ports = Object.keys(g.ports).sort()
          return h('div', { className: 'dm-relay-row', key: 'g' + gi },
            h('div', { className: 'dm-relay-end' },
              h('div', { className: 'dm-relay-name' }, nodeDisplay(data.nodeName) + '（本机）'),
              h('div', { className: 'dm-relay-sub' }, 'DSH ' + localUp + '/' + instances.length + ' 在线')
            ),
            h('div', { className: 'dm-relay-link' }, h('span', { className: 'dm-relay-line' }), h('span', { className: 'dm-relay-dirlabel' }, '出站')),
            h('div', { className: 'dm-relay-hub' },
              h('div', { className: 'dm-relay-name' }, '公网中转站 · frps'),
              h('div', { className: 'dm-relay-sub dm-mono' }, maskHost(g.host)),
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
                h('span', { className: 'dm-relay-peer-name' }, nodeDisplay(peerDeviceKey(peer.name))),
                h('span', { className: 'dm-relay-peer-meta' }, (t.port ? ':' + t.port : '') + (peer.up && peer.latencyMs != null ? ' · ' + peer.latencyMs + 'ms' : ' · 离线'))
              )
            }))
          )
        }),
        sakuraAccount && sakuraAccount.available ? h('div', { className: 'dm-relay-direct' },
          h('span', { className: 'dm-k' }, '樱花隧道：'),
          h('span', { className: 'dm-chip ' + (sakuraAccount.online === sakuraAccount.total ? 'run' : 'bad') }, sakuraAccount.online + '/' + sakuraAccount.total + ' 在线'),
          (sakuraAccount.tunnels || []).map(function (t) {
            return h('span', { className: 'dm-chip ' + (t.online ? 'run' : 'bad'), key: 'st' + t.id, title: (t.nodeName || '') + ' ' + maskText(t.addr) + (t.online ? '' : '（离线）') },
              (t.deviceKey || t.name) + ' ' + maskText(t.addr))
          })
        ) : null,
        direct.length ? h('div', { className: 'dm-relay-direct' },
          h('span', { className: 'dm-k' }, '直连：'),
          direct.map(function (peer) {
            var c = commLabel(peer, relayHosts)
            return h('span', { className: 'dm-chip ' + (peer.up ? 'run' : 'bad'), key: peer.name, title: c.text }, nodeDisplay(peerDeviceKey(peer.name)) + ' · ' + c.text)
          })
        ) : null
      )
    }

    // ===== 2026-11-09 传输层封装：局域网 / 阿里云(公网) / 樱花穿透 三通道 =====
var TRANSPORTS = {
  lan:    { label: '局域网直连',   short: 'LAN', color: '#2e9e4f', dash: false },
  public: { label: '公网服务器',   short: 'PUB', color: '#4d9bff', dash: true },
  sakura: { label: '樱花穿透',     short: 'SAK', color: '#a371f7', dash: true }
}
var DOWN_COLOR = "rgba(209,75,65,.7)"
// LAN peer 判定：-lan 后缀 / 内网 IP / kind=lan（实际数据里 peer-node-lan 的 kind 是 frp）
function isLanPeer(peer) {
  var t = (peer && peer.tunnel) || {}
  var name = String((peer && peer.name) || '')
  var host = String(t.host || '')
  if (/-lan$/i.test(name)) return true
  if (t.kind === 'lan' || t.kind === 'loopback') return true
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)) return true
  return false
}
// publicEntry 可能来自机器级 frpc；只有它映射的 localPort 与当前 mesh server 端口一致才属于本节点。
function publicEntryFor(localTunnel) {
  var lt = localTunnel || {}
  var entry = lt.publicEntry || lt.selfHosted
  if (!entry || !entry.host) return null
  var nodePort = Number(lt.port)
  if (nodePort && entry.localPort != null && Number(entry.localPort) !== nodePort) return null
  return entry
}
function tunnelMatchesNode(port) {
  var nodePort = Number(port)
  return function (tunnel) {
    if (!nodePort || tunnel.localPort == null) return true
    return Number(tunnel.localPort) === nodePort
  }
}
function sakuraAccountOf(data) {
  var acc = data && data.tunnels && data.tunnels.sakuraAccount
  if (!acc || acc.available !== true) return null
  var port = Number(data && data.localTunnel && data.localTunnel.port)
  if (!port) return acc
  return Object.assign({}, acc, { tunnels: (acc.tunnels || []).filter(function (x) { return x.localPort == null || Number(x.localPort) === port }) })
}
function sakuraTunnelOf(data, devKey) {
  var acc = sakuraAccountOf(data)
  if (!acc) return null
  var k = peerDeviceKey(devKey)
  for (var i = 0; i < (acc.tunnels || []).length; i++) if (acc.tunnels[i].deviceKey === k) return acc.tunnels[i]
  return null
}
// 设备状态 = 任一链路存活（全断才离线/红）
function deviceLinkState(data, peer, lanMap) {
  var dk = peerDeviceKey(peer.name)
  var t = peer.tunnel || {}
  // 2026-11-10：蓝线状态以隧道端口 TCP 探测为准（HTTP /health 对高延迟节点会误判断连）
  var probe = t.probe && typeof t.probe.up === "boolean" ? t.probe : null
  var publicUp = (probe ? probe.up === true : false) || Boolean(peer.up)
  var lan = lanMap ? lanMap[dk] : (t.kind === 'lan' ? { up: Boolean(peer.up), host: t.host, port: t.port, ip: t.ip || '' } : null)
  var lanUp = Boolean(lan && (lan.probe && lan.probe.up === true ? true : lan.up))
  var st = sakuraTunnelOf(data, dk)
  var sakuraUp = st ? st.online === true : null
  var anyUp = publicUp || sakuraUp === true || lanUp
  return { devKey: dk, publicUp: publicUp, lanUp: lanUp, lanTunnel: lan, sakuraUp: sakuraUp, sakuraTunnel: st, anyUp: anyUp }
}

    // ---------- 2026-11-09 画布下方：中转服务器情况（阿里云 / 樱花） ----------
    function InfraPanels(props) {
      var data = props.data || {}
      var acc = sakuraAccountOf(data)
      var peers = filterSelfPeers(dedupePeers(data.peers || []), data.nodeName)
      // 2026-11-10：本机自身也有一条阿里云入口（publicEntry/selfHosted 的 7012），之前漏掉了
      var lt = data.localTunnel || {}
      var selfHost = lt.selfHosted || {}
      var localPublic = publicEntryFor(lt)
      if (!localPublic) return null
      var entry = localPublic
      var localPort = entry.port || null
      var localHost = entry.host || ''
      var localKey = peerDeviceKey(data.nodeName)
      var devs = [{ devKey: localKey, name: nodeDisplay(data.nodeName) + "（本机）", up: true, port: localPort, host: localHost }].concat(peers.filter(function (p) { return !isLanPeer(p) }).map(function (p) {
        var tu = p.tunnel || {}
        return { devKey: peerDeviceKey(p.name), name: nodeDisplay(peerDeviceKey(p.name)), up: (tu.probe ? Boolean(tu.probe.up) : Boolean(p.up)), port: tu.port || null, host: tu.host || '' }
      }))
      var aliyunRows = devs.filter(function (d) { return d.port }).map(function (d) {
        return h('div', { key: d.devKey, className: 'dm-device-row' },
          h('span', { className: 'dm-device-k' }, d.name),
          h('span', { className: 'dm-device-v' }, (d.up ? '✅ ' : '❌ ') + maskHost(d.host) + ':' + d.port)
        )
      })
      var tunnelRows = acc ? (acc.tunnels || []).filter(tunnelMatchesNode(lt.port)).map(function (x, i) {
        return h('div', { key: 'st' + i, className: 'dm-device-row' },
          h('span', { className: 'dm-device-k' }, (x.deviceKey ? nodeDisplay(peerDeviceKey(x.deviceKey)) : (x.name || '未归类'))),
          h('span', { className: 'dm-device-v' }, (x.online ? '✅ ' : '❌ ') + maskText(x.addr || ''))
        )
      }) : null
      if (!aliyunRows.length && !tunnelRows) return null
      return h('div', { className: 'dm-infra-grid' },
        h('div', { className: 'dm-infra-card' },
          h('div', { className: 'dm-infra-head' },
            h('span', { className: 'dm-dot ok', style: { background: TRANSPORTS.public.color } }),
            h('span', null, '公网中转'),
            h('span', { className: 'dm-sub', style: { marginLeft: 'auto' } }, '自建 frps')
          ),
          h('div', { className: 'dm-sub dm-mono', style: { marginBottom: 4 } }, '隧道 ' + (devs.filter(function (d) { return d.port }).map(function (d) { return d.port }).sort().join(' / ') || '—')),
          aliyunRows
        ),
        acc ? h('div', { className: 'dm-infra-card' },
          h('div', { className: 'dm-infra-head' },
            h('span', { className: 'dm-dot', style: { background: TRANSPORTS.sakura.color } }),
            h('span', null, '第三方 frps 穿透'),
            h('span', { className: 'dm-sub', style: { marginLeft: 'auto' } }, acc.online + '/' + acc.total + ' 在线')
          ),
          h('div', { className: 'dm-sub dm-mono', style: { marginBottom: 4 } }, acc && acc.tunnels && acc.tunnels[0] ? maskText(acc.tunnels[0].addr || '') : '未配置'),
          tunnelRows
        ) : null
      )
    }

// ---------- 拓扑：极简卡片（名称 / 穿透域名 / DSH 数）+ 点击选中 ----------
    function Topology(props) {
      var data = props.data
      var layout = props.layout
      var show = props.show || { lan: true, public: true, sakura: true }
      // 2026-11-09-v5：卡片宽度自适应 —— 每次渲染后测量真实尺寸，回传父组件重算布局；
      // 同时把每张卡的实际尺寸给连线用（不同卡片宽窄不同，连线端点贴各自边缘）。
      var cardRefs = useRef({})
      var cardSizeState = useState({})
      var cardSizes = cardSizeState[0]
      var setCardSizes = cardSizeState[1]
      useEffect(function () {
        var next = {}
        var maxW = 0
        var maxH = 0
        var changed = false
        Object.keys(cardRefs.current).forEach(function (key) {
          var el = cardRefs.current[key]
          if (!el) return
          var w = el.offsetWidth
          var h = el.offsetHeight
          if (!w || !h) return
          next[key] = { w: w, h: h }
          if (w > maxW) maxW = w
          if (h > maxH) maxH = h
          var old = cardSizes[key]
          if (!old || Math.abs(old.w - w) > 1 || Math.abs(old.h - h) > 1) changed = true
        })
        if (!maxW) return
        if (changed) setCardSizes(next)
        if (props.onCardSize) props.onCardSize(maxW, maxH)
      })
      // 2026-11-09 卡片拖拽：在世界坐标里移动；连线由 layout.positions 派生，移动即自动跟随。
      var dragState = useState(null)
      var dragKey = dragState[0]
      var setDragKey = dragState[1]
      var dragRef = useRef(null)
      function cardPointerDown(node, pos, event) {
        if (event.button !== 0) return
        event.stopPropagation()
        dragRef.current = { key: node.key, sx: event.clientX, sy: event.clientY, ox: pos[0], oy: pos[1], moved: false }
        setDragKey(node.key)
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch (_) { /* ignore */ }
      }
      function cardPointerMove(node, event) {
        var drag = dragRef.current
        if (!drag || drag.key !== node.key) return
        event.stopPropagation()
        var scale = props.scale || 1
        var dx = (event.clientX - drag.sx) / scale
        var dy = (event.clientY - drag.sy) / scale
        if (!drag.moved && (Math.abs(dx) + Math.abs(dy)) > 3) drag.moved = true
        if (!drag.moved) return
        if (String(node.key).indexOf('server-') === 0) { infraMove(node.key, [drag.ox + dx, drag.oy + dy]); return }
        // 2026-11-09-v3：不再限制在画布边界内（用户反馈左侧有「空气墙」）；
        // 坐标允许任意值，.dm-world/.dm-lines 均 overflow:visible，配合拖到边缘自动平移可无限拖。
        var nx = drag.ox + dx
        var ny = drag.oy + dy
        if (props.onNodeMove) props.onNodeMove(node.key, [nx, ny])
        if (props.onDragEdge) props.onDragEdge(event.clientX, event.clientY)
      }
      function cardPointerUp(node, event) {
        var drag = dragRef.current
        if (!drag || drag.key !== node.key) return
        event.stopPropagation()
        var wasDrag = drag.moved
        dragRef.current = null
        setDragKey(null)
        if (!wasDrag && props.onSelect) props.onSelect(node.key)
      }
      function cardPointerCancel() { dragRef.current = null; setDragKey(null) }
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
        var src = localTunnel.mainSource || (entry && entry.source === 'self-hosted-frps' ? 'self-hosted' : '')
        if (entry && entry.host) {
          var tag = src === 'self-hosted' ? '（自建 frps）' : (src === 'sakura' ? '（Sakura 备用）' : '')
          return maskHost(entry.host) + ':' + entry.port + tag
        }
        if (localTunnel.frpRunning) return 'SakuraFrp 已开 · ' + (localTunnel.bind || '?') + ':' + localTunnel.port
        if (localTunnel.port) return '未开穿透 · ' + (localTunnel.bind || '?') + ':' + localTunnel.port
        return '未配置'
      }
      function peerDomain(peer) {
        var t = peer.tunnel || {}
        if (!t.host) return '—'
        return maskHost(t.host) + (t.port ? ':' + t.port : '') + (t.kind === 'lan' ? '（内网）' : '')
      }

      // LAN peer 单独收集（dedupe 后可能被更快的 frp 记录覆盖，但 LAN 线仍要画）
  var lanMap = {}
  filterSelfPeers(data.peers || [], data.nodeName).forEach(function (p) {
    var t = p.tunnel || {}
    if (isLanPeer(p)) lanMap[peerDeviceKey(p.name)] = { up: Boolean(p.up), host: t.host, port: t.port, ip: t.ip || '', probe: t.probe || null }
  })
  var nodes = [{
    key: 'local',
    local: true,
    devKey: peerDeviceKey(data.nodeName),
    up: true,
    name: nodeDisplay(data.nodeName),
    dsh: localUp + '/' + instances.length,
    ports: instances.map(function (inst) { return { port: inst.port, up: inst.up, error: inst.error || '' } }),
    extra: ''
  }].concat(peers.map(function (peer) {
    var ls = deviceLinkState(data, peer, lanMap)
    return {
      key: 'peer:' + peer.name,
      local: false,
      devKey: ls.devKey,
      up: ls.anyUp,
      publicUp: ls.publicUp,
      sakuraUp: ls.sakuraUp,
      sakuraTunnel: ls.sakuraTunnel,
      lanUp: ls.lanUp,
      lanTunnel: ls.lanTunnel,
      name: nodeDisplay(ls.devKey),
      dsh: String(peer.instancesCount || 0),
      ports: peer.instancesList || [],
      latencyMs: peer.latencyMs,
      tunnel: peer.tunnel || {},
      error: peer.error || ''
    }
  }))
  // 2026-11-10：按共用顺序排序（与 Viewport 拖拽位置表一致，修复"拖 A 动 B"的 bug）
  var orderKeys = orderedNodeKeys(data)
  nodes.sort(function (a, b) { return orderKeys.indexOf(a.key) - orderKeys.indexOf(b.key) })
  // 基础设施节点（中转服务器）：阿里云 / 樱花
  var localPub = publicEntryFor(localTunnel)
  var hasPublic = Boolean(localPub) || peers.some(function (p) { var pt = p.tunnel || {}; return !isLanPeer(p) && Boolean(pt.host) && (pt.kind === 'frp' || pt.kind === 'wan') })
  var publicVisible = show.public && hasPublic
  var sakuraRaw = sakuraAccountOf(data)
  var sakuraAcc = sakuraRaw ? Object.assign({}, sakuraRaw, { tunnels: (sakuraRaw.tunnels || []).filter(tunnelMatchesNode(localTunnel.port)) }) : null
  var sakuraVisible = show.sakura && Boolean(sakuraAcc && (sakuraAcc.tunnels || []).length)
  var aliyunPorts = peers.map(function (p) { return isLanPeer(p) ? null : (p.tunnel || {}).port }).filter(Boolean)
  var infra = [
    { key: 'server-aliyun', transport: 'public', name: '公网中转', host: localPub ? maskHost(localPub.host) : '未配置', color: TRANSPORTS.public.color, detail: '隧道 ' + (aliyunPorts.length ? aliyunPorts.sort().join('/') : '—'), up: Boolean(localPub) || hasPublic },
    { key: 'server-sakura', transport: 'sakura', name: '第三方 frps 穿透', host: sakuraAcc && sakuraAcc.tunnels && sakuraAcc.tunnels[0] ? maskText(sakuraAcc.tunnels[0].addr || '') : '未配置', color: TRANSPORTS.sakura.color, detail: sakuraAcc ? (sakuraAcc.online + '/' + sakuraAcc.total + ' 在线') : '未采集', up: Boolean(sakuraAcc) },
  ]
  // 2026-11-09-v8：服务器默认位置贴住扇形最高一排设备（用户要求缩小服务器↔设备的垂直间隔）
  function infraDefaultPos(idx) {
    var dx = layout.cardW * 1.08
    var ox = layout.baseOffsetX || 0
    var oy = layout.baseOffsetY || 0
    var cx = ox + (layout.contentW || layout.W) / 2
    var topYAbs = oy + (layout.topDeviceY || 0)
    return [Math.round(cx + (idx === 0 ? -dx : dx)), Math.round(topYAbs - layout.cardH * 1.05)]
  }
  var infraState = useState(function () { try { return JSON.parse(window.localStorage.getItem('dsh-mesh-ui.infra.v2') || '{}') || {} } catch (e) { return {} } })
  var infraPos = infraState[0]
  var setInfraPos = infraState[1]
  function infraPosition(idx) {
    var k = infra[idx].key
    var v = infraPos[k]
    if (v && v.length === 2) return v
    if (layout.mode === 'server-center') return layout.serverCenter || infraDefaultPos(idx)
    var def = layout.mode === 'servers-top' ? DEFAULT_INFRA_POS[infra[idx].transport === 'public' ? 'aliyun' : 'sakura'] : null
    if (def) return [def[0], def[1]]
    return infraDefaultPos(idx)
  }
  useEffect(function () {
    if (!props.resetNonce) return
    try { window.localStorage.removeItem('dsh-mesh-ui.infra.v2') } catch (e) { /* ignore */ }
    setInfraPos({})
  }, [props.resetNonce])
  function infraMove(key, pos) { setInfraPos(function (prev) { var next = Object.assign({}, prev); next[key] = pos; try { window.localStorage.setItem('dsh-mesh-ui.infra.v2', JSON.stringify(next)) } catch (e) { /* ignore */ } return next }) }

  var GAP_EDGE = 6
      function edgePoint(from, to, hw, hh) {
        var dx = to[0] - from[0]
        var dy = to[1] - from[1]
        var len = Math.sqrt(dx * dx + dy * dy) || 1
        var ux = dx / len
        var uy = dy / len
        var tx = ux === 0 ? Infinity : (hw + GAP_EDGE) / Math.abs(ux)
        var ty = uy === 0 ? Infinity : (hh + GAP_EDGE) / Math.abs(uy)
        var t = Math.min(tx, ty)
        return [from[0] + ux * t, from[1] + uy * t]
      }

      // 2026-11-09：三通道连线（设备→阿里云 / 设备→樱花 / 局域网直连）+ 中转服务器卡片 + 筛选
  // 2026-11-09：悬浮节点 → 只高亮它的连线并显示完整地址（其它线变淡）
  var hoverState = useState(null)
  var hoverKey = hoverState[0]
  var setHoverKey = hoverState[1]
  function edgeRelated(aKey, bKey) { return hoverKey ? (hoverKey === aKey || hoverKey === bKey) : true }
  var infraRefs = useRef({})
  var infraSizeState = useState({})
  var infraSizes = infraSizeState[0]
  var setInfraSizes = infraSizeState[1]
  useEffect(function () {
    var next = {}
    var changed = false
    Object.keys(infraRefs.current).forEach(function (key) {
      var el = infraRefs.current[key]
      if (!el) return
      var w = el.offsetWidth
      var h2 = el.offsetHeight
      if (!w || !h2) return
      next[key] = { w: w, h: h2 }
      var old = infraSizes[key]
      if (!old || Math.abs(old.w - w) > 1 || Math.abs(old.h - h2) > 1) changed = true
    })
    if (!Object.keys(next).length) return
    if (changed) setInfraSizes(next)
  })
  function sizeOf(key) { return cardSizes[key] || infraSizes[key] || { w: layout.cardW, h: layout.cardH } }
  function curve(key, from, to, up, transport, label, fromSize, toSize, highlight) {
    var a = edgePoint(from, to, fromSize.w / 2, fromSize.h / 2)
    var b = edgePoint(to, from, toSize.w / 2, toSize.h / 2)
    var mx = (a[0] + b[0]) / 2
    var my = (a[1] + b[1]) / 2
    var dx = b[0] - a[0]
    var dy = b[1] - a[1]
    var len = Math.sqrt(dx * dx + dy * dy) || 1
    var bow = Math.min(12, len * 0.07)
    var color = up ? transport.color : DOWN_COLOR
    var dash = up ? (transport.dash ? '6 5' : 'none') : '6 5'
    var related = highlight !== false
    var els = [h('path', {
      key: key,
      d: 'M ' + a[0] + ' ' + a[1] + ' Q ' + (mx + (-dy / len) * bow) + ' ' + (my + (dx / len) * bow) + ' ' + b[0] + ' ' + b[1],
      fill: 'none', stroke: color, strokeWidth: 1.8, strokeDasharray: dash,
      className: up ? (transport.dash ? 'dm-edge-frp' : 'dm-edge-solid') : 'dm-edge-down',
      opacity: related ? 1 : 0.12
    })]
    if (label) {
      els.push(h('text', { key: key + '-t', className: 'dm-edge-label', x: mx + (-dy / len) * bow, y: my + (dx / len) * bow - 4, fill: color, fontSize: 9, textAnchor: 'middle', style: { display: (hoverKey && related) ? 'block' : 'none' } }, label))
    }
    return els
  }
  var svgEls = []
  var aliyunPos = infraPosition(0)
  var sakuraPos = infraPosition(1)
  var aliyunSize = infraSizes['server-aliyun'] || { w: 300, h: 90 }
  var sakuraSize = infraSizes['server-sakura'] || { w: 300, h: 90 }
  var infraBoxes = []
  if (publicVisible) infraBoxes.push({ x: aliyunPos[0], y: aliyunPos[1], w: aliyunSize.w, h: aliyunSize.h })
  if (sakuraVisible) infraBoxes.push({ x: sakuraPos[0], y: sakuraPos[1], w: sakuraSize.w, h: sakuraSize.h })
  if (props.onInfraBounds) props.onInfraBounds(infraBoxes)
  var localKey = peerDeviceKey(data.nodeName)
  var localSak = sakuraTunnelOf(data, localKey)
  // 2026-11-10：LAN 线必须从本机节点出发（排序后 local 可能不在 index 0，之前误连到peer-x）
  var localNodeIdx = 0
  nodes.forEach(function (n, ii) { if (n.local) localNodeIdx = ii })
  nodes.forEach(function (n, i) {
    var pa = layout.positions[i]
    if (n.local) {
      // 主机自己的两条上级链路：自建 frps（阿里云） + 本机樱花隧道
      if (publicVisible && localPub) svgEls = svgEls.concat(curve('pub-local', pa, aliyunPos, true, TRANSPORTS.public, maskHost(localPub.host) + ':' + localPub.port, sizeOf('local'), aliyunSize, edgeRelated('local', 'server-aliyun')))
      if (sakuraVisible && localSak) svgEls = svgEls.concat(curve('sak-local', pa, sakuraPos, localSak.online === true, TRANSPORTS.sakura, maskText(localSak.addr || ''), sizeOf('local'), sakuraSize, edgeRelated('local', 'server-sakura')))
      return
    }
    var sizeN = sizeOf(n.key)
    if (publicVisible && n.tunnel && n.tunnel.host && !isLanPeer(n) && (n.tunnel.kind === 'frp' || n.tunnel.kind === 'wan')) svgEls = svgEls.concat(curve('pub' + i, pa, aliyunPos, n.publicUp, TRANSPORTS.public, maskHost(n.tunnel.host) + ((n.tunnel.port) ? ':' + n.tunnel.port : ''), sizeN, aliyunSize, edgeRelated(n.key, 'server-aliyun')))
    if (sakuraVisible && n.sakuraTunnel) svgEls = svgEls.concat(curve('sak' + i, pa, sakuraPos, n.sakuraUp === true, TRANSPORTS.sakura, maskText(n.sakuraTunnel.addr || ''), sizeN, sakuraSize, edgeRelated(n.key, 'server-sakura')))
    if (show.lan && n.lanUp) { var lt = n.lanTunnel || {}; var lanAddr = (lt.ip || lt.host || 'LAN') + (lt.port ? ':' + lt.port : ''); svgEls = svgEls.concat(curve('lan' + i, layout.positions[localNodeIdx], pa, n.lanUp, TRANSPORTS.lan, lanAddr, sizeOf('local'), sizeN, edgeRelated('local', n.key))) }
  })
  var fedItems = []
  try {
    var directKeys = {}
    nodes.forEach(function (n) { directKeys[peerDeviceKey(n.devKey)] = true; directKeys[peerDeviceKey(n.name)] = true })
    var seenFed = {}
    var fedRaw = (props.federated && props.federated.nodes) || []
    fedRaw.forEach(function (item) {
      var dn = peerDeviceKey(item.name)
      if (!dn || directKeys[dn] || seenFed[dn] || dn === peerDeviceKey(data.nodeName)) return
      seenFed[dn] = true
      var gi = -1
      for (var ni = 0; ni < nodes.length; ni++) if (peerDeviceKey(nodes[ni].devKey) === peerDeviceKey(item.via)) { gi = ni; break }
      if (gi < 0) return
      var gp = layout.positions[gi]
      var idx = fedItems.length
      fedItems.push({ item: item, x: gp[0] + (idx % 3 - 1) * 170, y: gp[1] + 150 + Math.floor(idx / 3) * 92, gx: gp[0], gy: gp[1] })
    })
  } catch (error) { fedItems = [] }
  fedItems.forEach(function (fed) {
    svgEls.push(h('line', { key: 'fed-edge-' + fed.item.name + '-' + fed.item.via, x1: fed.gx, y1: fed.gy, x2: fed.x, y2: fed.y, className: 'dm-edge-indirect', strokeDasharray: '4 4' }))
  })
  return h('div', null,
    h('svg', { className: 'dm-lines', width: layout.W, height: layout.H, viewBox: '0 0 ' + layout.W + ' ' + layout.H }, svgEls),
    nodes.map(function (node, i) {
      var pos = layout.positions[i]
      var selected = props.selectedKey === node.key
      return h('div', {
        key: node.key,
        className: 'dm-card-node compact draggable' + (node.local ? ' local' : '') + (node.up ? '' : ' down') + (selected ? ' selected' : '') + (hoverKey === node.key ? ' hovered' : '') + (dragKey === node.key ? ' dragging' : ''),
        onMouseEnter: function () { setHoverKey(node.key) },
        onMouseLeave: function () { setHoverKey(null) },
        style: { left: pos[0] + 'px', top: pos[1] + 'px', maxWidth: '380px', transform: 'translate(-50%,-50%)' },
        ref: function (el) { if (el) cardRefs.current[node.key] = el; else delete cardRefs.current[node.key] },
        onPointerDown: function (event) { cardPointerDown(node, pos, event) },
        onPointerMove: function (event) { cardPointerMove(node, event) },
        onPointerUp: function (event) { cardPointerUp(node, event) },
        onPointerCancel: cardPointerCancel,
        title: '拖拽调整位置 · 单击查看 ' + node.name + ' 的详情'
      },
        h('div', { className: 'dm-n-head' },
          h('div', { className: 'dm-n-name' }, h('span', { className: 'dm-dot ' + (node.up ? 'ok' : 'bad') }), h('span', { className: 'dm-ell' }, node.name)),
          node.local ? h('span', { className: 'dm-chip ok' }, '本机')
            : (node.up ? h('span', { className: 'dm-extra' }, node.latencyMs == null ? '' : node.latencyMs + 'ms') : h('span', { className: 'dm-chip bad' }, '离线'))
        ),
        node.up ? null : h('div', { className: 'dm-offline-row' }, '全部链路不可用' + (node.error ? ' · ' + node.error : '')),
        h('div', { className: 'dm-card-dsh' },
          (node.ports || []).map(function (item, pi) {
            var portUp = item.up == null ? node.up : Boolean(item.up)
            var bridgeUnknown = !portUp && node.up && !node.local
            return h('span', { key: pi, className: 'dm-chip type' + (portUp ? ' run' : (bridgeUnknown ? ' warn' : ' bad')), title: (portUp ? '实例在线' : (bridgeUnknown ? '节点在线，但 host bridge 未连接，实例状态未知' : (item.error ? 'host bridge 不可达：' + item.error : '实例离线 / host bridge 未连接'))) + ' · DSH 端口 ' + item.port }, String(item.port))
          })
        )
      )
    }),
    fedItems.map(function (fed) {
      var item = fed.item
      return h('div', { key: 'fed:' + item.via + ':' + item.name, className: 'dm-card-node indirect', style: { left: fed.x + 'px', top: fed.y + 'px', width: '172px', transform: 'translate(-50%,-50%)' }, title: '间接可达：经 ' + item.via },
        h('div', { className: 'dm-n-head' },
          h('div', { className: 'dm-n-name' }, h('span', { className: 'dm-dot ' + (item.up === true ? 'ok' : (item.up === false ? 'bad' : 'muted')), style: item.up == null ? { opacity: .45 } : undefined }), h('span', { className: 'dm-ell' }, item.name)),
          h('span', { className: 'dm-fed-badge' }, '经 ' + item.via)
        ),
        h('div', { className: 'dm-card-dsh' },
          h('span', { className: 'dm-chip' }, item.up === true ? (item.latencyMs != null ? item.latencyMs + 'ms' : '可达') : (item.up === false ? '不可达' : '间接 · 只读'))
        )
      )
    }),
    (publicVisible ? h('div', {
      key: 'server-aliyun',
      className: 'dm-card-node server' + (infra[0].up ? '' : ' down') + (hoverKey === 'server-aliyun' ? ' hovered' : ''),
      onMouseEnter: function () { setHoverKey('server-aliyun') },
      onMouseLeave: function () { setHoverKey(null) },
      style: { left: aliyunPos[0] + 'px', top: aliyunPos[1] + 'px', maxWidth: '360px', transform: 'translate(-50%,-50%)', borderColor: TRANSPORTS.public.color },
      ref: function (el) { if (el) infraRefs.current['server-aliyun'] = el; else delete infraRefs.current['server-aliyun'] },
      onPointerDown: function (event) { cardPointerDown({ key: 'server-aliyun' }, aliyunPos, event) },
      onPointerMove: function (event) { cardPointerMove({ key: 'server-aliyun' }, event) },
      onPointerUp: function (event) { cardPointerUp({ key: 'server-aliyun' }, event) },
      onPointerCancel: cardPointerCancel
    },
      h('div', { className: 'dm-n-head' }, h('div', { className: 'dm-n-name' }, h('span', { className: 'dm-dot ok' }), h('span', {}, infra[0].name))),
      h('div', { className: 'dm-card-domain' }, infra[0].host),
      h('div', { className: 'dm-card-dsh' }, h('span', { className: 'dm-chip', style: { borderColor: TRANSPORTS.public.color, color: TRANSPORTS.public.color } }, 'frps'), h('span', { className: 'dm-chip' }, infra[0].detail))
    ) : null),
    (sakuraVisible ? h('div', {
      key: 'server-sakura',
      className: 'dm-card-node server' + (infra[1].up ? '' : ' down') + (hoverKey === 'server-sakura' ? ' hovered' : ''),
      onMouseEnter: function () { setHoverKey('server-sakura') },
      onMouseLeave: function () { setHoverKey(null) },
      style: { left: sakuraPos[0] + 'px', top: sakuraPos[1] + 'px', maxWidth: '360px', transform: 'translate(-50%,-50%)', borderColor: TRANSPORTS.sakura.color },
      ref: function (el) { if (el) infraRefs.current['server-sakura'] = el; else delete infraRefs.current['server-sakura'] },
      onPointerDown: function (event) { cardPointerDown({ key: 'server-sakura' }, sakuraPos, event) },
      onPointerMove: function (event) { cardPointerMove({ key: 'server-sakura' }, event) },
      onPointerUp: function (event) { cardPointerUp({ key: 'server-sakura' }, event) },
      onPointerCancel: cardPointerCancel
    },
      h('div', { className: 'dm-n-head' }, h('div', { className: 'dm-n-name' }, h('span', { className: 'dm-dot ' + (infra[1].up ? 'ok' : 'bad') }), h('span', {}, infra[1].name))),
      h('div', { className: 'dm-card-domain' }, infra[1].host),
      h('div', { className: 'dm-card-dsh' }, h('span', { className: 'dm-chip', style: { borderColor: TRANSPORTS.sakura.color, color: TRANSPORTS.sakura.color } }, 'Sakura'), h('span', { className: 'dm-chip' }, infra[1].detail))
    ) : null)
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
      var tunnels = (localTunnel.tunnels || []).filter(tunnelMatchesNode(localTunnel.port))
      var entry = publicEntryFor(localTunnel) || null
      var tunnelNames = tunnels.map(function (x) { return x.name + '→' + maskHost(x.host) + ':' + x.port }).join(' / ')
      var mainSrc = entry ? (localTunnel.mainSource || (entry.source === 'self-hosted-frps' ? 'self-hosted' : (entry.source === 'sakura' ? 'sakura' : 'none'))) : 'none'
      var entryText = entry && entry.host
        ? maskHost(entry.host) + ':' + entry.port + (mainSrc === 'self-hosted' ? '（自建 frps · 主用）' : (mainSrc === 'sakura' ? '（Sakura · 备用）' : ''))
        : '未配置'
      var localTunnelRows = [
        ['入口', entryText],
        ['监听 / frpc', (localTunnel.bind || '?') + ':' + (localTunnel.port || '?') + (localTunnel.tls ? ' (TLS)' : '') + ' · ' + (localTunnel.frpRunning ? 'frpc ×' + (localTunnel.frpcCount || 1) : 'frpc 未运行')]
      ]
      if (tunnels.length) localTunnelRows.push(['Sakura 备用', tunnels.map(function (x) { return maskHost(x.host) + ':' + x.port }).join(' / ')])
      if (mainSrc === 'self-hosted' && localTunnel.selfHosted && localTunnel.selfHosted.configPath) localTunnelRows.push(['frpc 配置', localTunnel.selfHosted.configPath])
      var localTunnelAll = tunnelNames
      var memText = hw.memTotalGB ? ((hw.memFreeGB != null ? hw.memFreeGB : '?') + ' / ' + hw.memTotalGB + ' GB') : '—'
      var cpuText = hw.cpuModel ? hw.cpuModel + ' · ' + (hw.cpuCores || '?') + ' 线程' : '—'
      function diskText(d) {
        if (!d || d.totalGB == null) return '—'
        var p = String(d.path || '').replace(/[\\/]+$/, '')
        return (d.freeGB != null ? d.freeGB : '?') + ' / ' + d.totalGB + ' GB' + (p ? ' (' + p + ')' : '')
      }
      // 设备类型：按平台/CPU 形态泛化推断（不依赖任何个人设备表）
      function formFactorOf(h) {
        if (!h) return '—'
        if (h.platform === 'linux' && String(h.arch || '').indexOf('arm') === 0) return '手机'
        var cpu = String(h.cpuModel || '')
        return cpu ? '主机' : '—'
      }
      function memTextOf(h) {
        return h && h.memTotalGB ? ((h.memFreeGB != null ? h.memFreeGB : '?') + ' / ' + h.memTotalGB + ' GB') : '—'
      }
      function cpuTextOf(h) {
        return h && h.cpuModel ? h.cpuModel + ' · ' + (h.cpuCores || '?') + ' 线程' : '—'
      }
      function ipKindOf(peer) {
        var t = peer.tunnel || {}
        if (t.kind === 'loopback') return '本机回环'
        if (t.kind === 'lan') return '局域网直连'
        if (t.kind === 'frp') return '公网穿透（域名）'
        if (t.kind === 'wan') return relayHosts[String(t.host || '').toLowerCase()] ? '公网（共享中转）' : '公网 IP 直连'
        return '—'
      }
      function relayKindOf(peer) {
        var t = peer.tunnel || {}
        if (t.kind === 'loopback') return '无（本机回环）'
        if (t.kind === 'lan') return '无（局域网直连）'
        if (t.kind === 'frp') return 'Sakura / 第三方 frp 穿透'
        if (t.kind === 'wan') return relayHosts[String(t.host || '').toLowerCase()] ? '自建公网中继（frps）' : '公网 IP 直连'
        return '—'
      }
      function dshVerOf(peer) {
        var v = peer.version ? 'v' + peer.version : '—'
        if (peer.plugin) v += ' · 插件 ' + peer.plugin
        return v
      }

      // 2026-11-10：设备状态与拓扑同口径 —— 任一链路可达即算在线（HTTP 探测偶发超时不再误判红点）
      var lanUpByDev = {}
      ;(data.peers || []).forEach(function (p) {
        if (!isLanPeer(p)) return
        var tu = p.tunnel || {}
        lanUpByDev[peerDeviceKey(p.name)] = tu.probe ? tu.probe.up === true : Boolean(p.up)
      })
      function peerLinkState(peer) {
        var t = peer.tunnel || {}
        var httpUp = Boolean(peer.up)
        var tcpUp = t.probe ? t.probe.up === true : false
        var sk = sakuraTunnelOf(data, peerDeviceKey(peer.name))
        var sakuraUp = sk ? sk.online === true : null
        var lanUp = lanUpByDev[peerDeviceKey(peer.name)] === true
        return {
          httpUp: httpUp, tcpUp: tcpUp, sakuraUp: sakuraUp, lanUp: lanUp,
          up: httpUp || tcpUp || sakuraUp === true || lanUp
        }
      }
      function linkStateText(ls) {
        return "公网 " + ((ls.httpUp || ls.tcpUp) ? "✅" : "❌")
          + " / 樱花 " + (ls.sakuraUp == null ? "—" : (ls.sakuraUp ? "✅" : "❌"))
          + (ls.lanUp ? " / LAN ✅" : "")
          + (ls.httpUp ? "" : "（HTTP 超时，隧道" + (ls.tcpUp ? "通" : "断") + "）")
      }

      var devices = [{
        key: 'local',
        name: nodeDisplay(data.nodeName) + '（本机）',
        up: Boolean(endpoint.up),
        rows: [
          ['设备类型', formFactorOf(hw)],
          ['操作系统', hw.os || '—'],
          ['内存', memTextOf(hw)],
          ['磁盘', diskText(hw.disk)],
          ['CPU', cpuTextOf(hw)],
          ['DSH 版本', data.meshVersion ? 'v' + data.meshVersion : '—'],
          ['IP 类型', '本机回环'],
          ['端口号', localTunnel.port != null ? String(localTunnel.port) : '—'],
          ['公网穿透类型', mainSrc === 'self-hosted' ? '自建 frps 中继（主用）' : (mainSrc === 'sakura' ? 'Sakura 穿透（备用）' : '无（仅局域网）')]
        ]
      }].concat(peers.map(function (peer) {
        var t = peer.tunnel || {}
        var ls = peerLinkState(peer)
        var hwp = peer.hardware || {}
        return {
          key: 'peer:' + peer.name,
          name: nodeDisplay(peerDeviceKey(peer.name)),
          up: ls.up,
          rows: [
            ['设备类型', formFactorOf(hwp)],
            ['操作系统', hwp.os || peer.os || '—'],
            ['内存', memTextOf(hwp)],
            ['磁盘', diskText(hwp.disk)],
            ['CPU', cpuTextOf(hwp)],
            ['DSH 版本', dshVerOf(peer)],
            ['IP 类型', ipKindOf(peer)],
            ['端口号', t.port ? String(t.port) : '—'],
            ['公网穿透类型', relayKindOf(peer)],
            ['链路状态', linkStateText(ls)]
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
      var storeKey = 'dsh-mesh-ui.details.' + encodeURIComponent(String(props.title || ''))
      var sOpen = useState(function () {
        try {
          var saved = window.localStorage.getItem(storeKey)
          return saved == null ? Boolean(props.open) : saved === '1'
        } catch (_) { return Boolean(props.open) }
      })
      var open = sOpen[0]; var setOpen = sOpen[1]
      function onToggle(event) {
        var next = Boolean(event.currentTarget.open)
        setOpen(next)
        try { window.localStorage.setItem(storeKey, next ? '1' : '0') } catch (_) { /* ignore */ }
      }
      return h('details', { className: 'dm-details', open: open, onToggle: onToggle },
        h('summary', null, props.title, props.badge != null ? h('span', { className: 'dm-pill muted' }, String(props.badge)) : null),
        // 2026-11-10：折叠面板正文用独立容器整栏铺满；原先借用 .dm-body（62% 双栏 grid）
        // 会把「委托台账」这类单列表格压到 300px，中文被逐字折成竖排。
        h('div', { className: 'dm-details-body' }, props.children)
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
        // 2026-11-10：外层给横向滚动兜底——栏窄到连固定列宽都放不下时滚动，而不是压缩成竖排。
        h('div', { className: 'dm-table-wrap' },
          h('table', { className: 'dm-table' },
            h('thead', null, h('tr', null, h('th', null, '状态'), h('th', null, '节点'), h('th', null, '任务'), h('th', null, '耗时'), h('th', null, '目标'))),
            h('tbody', null, list.map(function (task) {
              return h('tr', { key: task.taskId },
                h('td', null, stateChip(task.state)),
                h('td', { title: nodeLabel(task.node) }, nodeLabel(task.node)),
                h('td', { className: 'dm-mono', style: { fontSize: 11 }, title: String(task.taskId || '') }, String(task.taskId || '').replace(/^T-\d{8}-/, 'T-…')),
                h('td', { className: 'dm-mono' }, dur(task.durationSec)),
                h('td', null, h('span', { className: 'dm-trunc', title: task.goal }, task.goal || ''))
              )
            }))
          )
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

    function jsonFetch(url, options) {
      return fetch(url, options).then(function (r) { return r.text() }).then(function (text) { try { return JSON.parse(text) } catch (error) { return { ok: false, error: text.slice(0, 120) } } })
    }

    // 2026-11-10：节点管理（从本机移除 peer / 吊销入站 token）。
    function NodeManager(props) {
      var sp = useState(null); var peers = sp[0]; var setPeers = sp[1]
      var st = useState(null); var tokens = st[0]; var setTokens = st[1]
      var sb = useState(false); var busy = sb[0]; var setBusy = sb[1]
      var sm = useState(''); var msg = sm[0]; var setMsg = sm[1]
      function refresh() {
        setBusy(true)
        Promise.all([jsonFetch('/api/dsh-mesh/peers'), jsonFetch('/api/dsh-mesh/tokens')]).then(function (r) {
          if (r[0].ok) setPeers(r[0].peers || []); else setMsg(r[0].error || '读取节点失败')
          if (r[1].ok) setTokens(r[1].tokens || [])
        }).finally(function () { setBusy(false) })
      }
      useEffect(function () { refresh() }, [])
      function togglePeer(peer) {
        setBusy(true); setMsg('')
        fetch('/api/dsh-mesh/peers/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: peer.id, disabled: !peer.disabled }) })
          .then(function (r) { return r.text() }).then(function (text) { try { var j = JSON.parse(text); setMsg(j.ok ? ((peer.disabled ? '已启用 ' : '已禁用 ') + peer.name) : ('操作失败：' + (j.stderr || j.error || '').slice(0, 200))) } catch (e) { setMsg(text.slice(0, 120)) } refresh(); if (props.onChanged) props.onChanged() })
          .finally(function () { setBusy(false) })
      }
      function removePeer(peer) {
        if (!window.confirm('从本机移除节点「' + peer.name + '」？\n这会删除本机到它的连接；对方的入站 token 需在下方吊销。')) return
        setBusy(true); setMsg('')
        jsonFetch('/api/dsh-mesh/peers/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: peer.id }) })
          .then(function (j) { setMsg(j.ok ? '已移除 ' + peer.name : ('移除失败：' + (j.stderr || j.error || '').slice(0, 200))); refresh(); if (props.onChanged) props.onChanged() })
          .finally(function () { setBusy(false) })
      }
      function revokeToken(tok) {
        if (!window.confirm('吊销入站 token「' + (tok.note || tok.id) + '」？\n该凭据对应的对端会立即失去访问。')) return
        setBusy(true); setMsg('')
        jsonFetch('/api/dsh-mesh/tokens/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: tok.id }) })
          .then(function (j) { setMsg(j.ok ? '已吊销 ' + tok.id : ('吊销失败：' + (j.stderr || j.error || '').slice(0, 200))); refresh(); if (props.onChanged) props.onChanged() })
          .finally(function () { setBusy(false) })
      }
      return h('div', { className: 'dm-nodes' },
        h('div', { className: 'dm-lan-row' },
          h('button', { className: 'dm-btn', disabled: busy, onClick: refresh }, '刷新节点'),
          h('span', { className: 'dm-sub' }, '移除只影响本机；要让对方也失去访问，请吊销对应入站 token')
        ),
        msg ? h('div', { className: 'dm-sub', style: { marginTop: 6 } }, msg) : null,
        peers === null ? h('div', { className: 'dm-sub' }, '加载中…') :
          peers.length ? peers.map(function (peer) {
            return h('div', { className: 'dm-node-row', key: peer.id },
              h('span', { className: 'dm-dot ' + (peer.disabled ? 'muted' : 'ok'), style: peer.disabled ? { opacity: .4 } : undefined }),
              h('span', { className: 'dm-node-name' }, peer.name + (peer.disabled ? '（已禁用）' : '')),
              h('span', { className: 'dm-node-url' }, maskText(peer.url || '')),
              h('button', { className: 'dm-btn', disabled: busy, onClick: function () { togglePeer(peer) } }, peer.disabled ? '启用' : '禁用'),
              h('button', { className: 'dm-btn bad', disabled: busy, onClick: function () { removePeer(peer) } }, '移除')
            )
          }) : h('div', { className: 'dm-sub' }, '没有直接配对的节点'),
        tokens && tokens.length ? h('details', { className: 'dm-details', style: { marginTop: 8 } },
          h('summary', null, '入站 token（' + tokens.length + '）'),
          tokens.map(function (tok) {
            return h('div', { className: 'dm-node-row', key: tok.id },
              h('span', { className: 'dm-node-name' }, tok.id),
              h('span', { className: 'dm-node-url' }, (tok.note || '') + (tok.role ? ' · ' + tok.role : '')),
              h('button', { className: 'dm-btn bad', disabled: busy, onClick: function () { revokeToken(tok) } }, '吊销')
            )
          })
        ) : null
      )
    }

    // 2026-11-10：局域网首次接入（扫描 / 生成配对码 / 配对）。
    function LanOnboarding() {
      var sNodes = useState(null); var nodes = sNodes[0]; var setNodes = sNodes[1]
      var sBusy = useState(false); var busy = sBusy[0]; var setBusy = sBusy[1]
      var sMsg = useState(''); var msg = sMsg[0]; var setMsg = sMsg[1]
      var sCode = useState(''); var code = sCode[0]; var setCode = sCode[1]
      var sMine = useState(null); var mine = sMine[0]; var setMine = sMine[1]

      function lanJson(url, options) {
        return fetch(url, options).then(function (res) {
          return res.text().then(function (text) {
            try { return JSON.parse(text) } catch (error) { return { ok: false, error: '此实例的 dsh-mesh-ui 服务端还是旧版（重启 DSH 后可用）：' + text.slice(0, 120) } }
          })
        })
      }
      function scan() {
        setBusy(true); setMsg('')
        lanJson('/api/dsh-mesh/lan/scan').then(function (j) {
          if (!j.ok) { setMsg(j.error || '扫描失败'); return }
          setNodes(j.nodes || [])
          setMsg((j.nodes || []).length ? '发现 ' + j.nodes.length + ' 个节点' : '没有发现局域网节点（对方需 bind 0.0.0.0 并放行 8124）')
        }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      function myCode() {
        setBusy(true); setMine(null); setMsg('')
        lanJson('/api/dsh-mesh/lan/code').then(function (j) {
          if (!j.ok) { setMsg(j.error || '生成配对码失败'); return }
          setMine(j)
        }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      function checkNode(node) {
        setBusy(true); setMsg('')
        lanJson('/api/dsh-mesh/lan/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: String(node.url || '') }) })
          .then(function (j) {
            if (!j.ok) { setMsg('链路不可达：' + (j.error || 'unknown')); return }
            setMsg('链路可达：' + j.host + ':' + j.port + ' · TCP ok · ' + j.latencyMs + 'ms' + (j.tls && j.tls.ok ? ' · TLS ok' : ''))
          }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      function pairWith(node) {
        var c = String(code || '').trim()
        if (!c) { setMsg('先填入对方显示的配对码'); return }
        setBusy(true); setMsg('')
        lanJson('/api/dsh-mesh/lan/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: String(node.url || '').replace(/\/mcp$/, ''), code: c, name: (node.node || 'lan') + '-lan', fingerprint: node.certFingerprint || '' }) })
          .then(function (j) {
            setMsg(j.ok ? '配对成功：' + (node.node || '') + '，稍后刷新网络' : ('配对失败：' + (j.stderr || j.error || j.stdout || '').slice(0, 300)))
          }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      return h('div', null,
        h('div', { className: 'dm-lan-row' },
          h('button', { className: 'dm-btn', disabled: busy, onClick: scan }, busy ? '处理中…' : '扫描局域网'),
          h('button', { className: 'dm-btn', disabled: busy, onClick: myCode }, '生成我的配对码'),
          h('span', { className: 'dm-sub' }, '扫描只发现节点，不会自动连接；配对必须输入对方生成的一次性配对码')
        ),
        msg ? h('div', { className: 'dm-sub', style: { marginTop: 6 } }, msg) : null,
        mine ? h('div', { className: 'dm-lan-code', style: { marginTop: 8 } }, '配对码 ' + mine.pairingCode + ' · ' + (mine.endpoint || '') + (mine.certFingerprint ? ' · 指纹 ' + mine.certFingerprint : '')) : null,
        nodes && nodes.length ? h('div', { style: { marginTop: 8 } },
          nodes.map(function (node, i) {
            return h('div', { className: 'dm-lan-node', key: i },
              h('span', { className: 'dm-dot ok' }),
              h('span', null, (node.node || '?') + ' · ' + (node.url || '').replace('/mcp', '')),
              h('button', { className: 'dm-btn', disabled: busy, onClick: function () { checkNode(node) } }, '检查链路'),
              h('button', { className: 'dm-btn primary', disabled: busy || !String(code || '').trim(), onClick: function () { pairWith(node) } }, '用此节点配对')
            )
          })
        ) : null,
        nodes && nodes.length ? h('div', { className: 'dm-lan-row' },
          h('input', { placeholder: '对方显示的配对码，如 H5K4-9RXV', value: code, onChange: function (e) { setCode(e.target.value) } })
        ) : null
      )
    }

    function MeshStatusSection() {
      var s0 = useState(null); var data = s0[0]; var setData = s0[1]
      var s1 = useState(true); var loading = s1[0]; var setLoading = s1[1]
      var sFed = useState(null); var federated = sFed[0]; var setFederated = sFed[1]
      var federatedRef = useRef({ at: 0 })
      var s2 = useState(''); var error = s2[0]; var setError = s2[1]
      var s3 = useState(0); var tick = s3[0]; var setTick = s3[1]
      var s4 = useState(''); var copied = s4[0]; var setCopied = s4[1]
      // 2026-11-10：真刷新 —— 点击后等待后台采集完成再渲染；本地冷却 + 忙锁防止连点刷爆请求
      var s6 = useState(""); var refreshHint = s6[0]; var setRefreshHint = s6[1]
      var forceRef = useRef({ at: 0, busy: false })
      // 2026-11-10：verdict 防抖 —— 单次探测失败（远端忙/超时）只显示 degraded，连续 2 次才显示 down
      var verdictState = useState(''); var verdictShown = verdictState[0]; var setVerdictShown = verdictState[1]
      var verdictRef = useRef({ raw: '', streak: 0 })
      var s5 = useState('local'); var selectedKey = s5[0]; var setSelectedKey = s5[1]
      var sPublic = useState(function () {
        try { return window.localStorage.getItem('dsh-mesh.show-public-addresses') === '1' } catch (error) { return false }
      })
      var showPublic = sPublic[0]; var setShowPublic = sPublic[1]
      showPublicAddresses = showPublic
      function toggleShowPublic(event) {
        var next = Boolean(event && event.target && event.target.checked)
        setShowPublic(next)
        showPublicAddresses = next
        try { window.localStorage.setItem('dsh-mesh.show-public-addresses', next ? '1' : '0') } catch (error) { /* ignore */ }
      }
      // 双栏宽度：拖动分隔条调整并记忆，窄屏由 CSS 媒体查询自动堆叠。
      var dragState = useState(function () {
        try { var saved = Number(window.localStorage.getItem('dsh-mesh-split-w')); return Number.isFinite(saved) && saved > 0 ? saved : 0 } catch (error) { return 0 }
      })
      var splitW = dragState[0]; var setSplitW = dragState[1]

      function startSplit(event) {
        event.preventDefault()
        var body = event.currentTarget.parentElement
        if (!body) return
        var rect = body.getBoundingClientRect()
        var startW = splitW > 0 ? splitW : Math.round(rect.width * 0.62)
        var currentW = startW
        function onMove(moveEvent) {
          var width = Math.max(300, Math.min(moveEvent.clientX - rect.left, Math.max(300, rect.width - 360)))
          currentW = width
          setSplitW(width)
        }
        function onUp() {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          try { window.localStorage.setItem('dsh-mesh-split-w', String(currentW)) } catch (error) { /* ignore */ }
        }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      function load(force) {
        if (!force) {
          setLoading(true)
          fetchStatus(false)
            .then(function (json) {
              setData(json)
              setError(json && json.ok === false && !json.warming ? json.error || "mesh-health error" : "")
            })
            .catch(function (err) { setError(String((err && err.message) || err)) })
            .finally(function () { setLoading(false) })
          return
        }
        var st = forceRef.current
        var now = Date.now()
        if (st.busy) return
        if (now - st.at < 8000) {
          var waitSec = Math.ceil((8000 - (now - st.at)) / 1000)
          setRefreshHint("刚采集过，" + waitSec + "s 后可再刷新")
          setTimeout(function () { setRefreshHint("") }, 2200)
          return
        }
        st.busy = true
        st.at = now
        setLoading(true)
        setRefreshHint("采集中…")
        var prevAt = data && data.at
        var attempts = 0
        function poll() {
          attempts++
          fetchStatus(false).then(function (json) {
            var fresh = json && json.refreshing === false && json.at && json.at !== prevAt
            if (fresh || attempts >= 15) {
              setData(json)
              setError(json && json.ok === false && !json.warming ? json.error || "mesh-health error" : "")
              setLoading(false)
              st.busy = false
              setRefreshHint(fresh ? "已刷新" : "无新数据（采集超时）")
              setTimeout(function () { setRefreshHint("") }, 2000)
              return
            }
            setTimeout(poll, 800)
          }).catch(function () {
            st.busy = false
            setLoading(false)
            setRefreshHint("刷新失败")
            setTimeout(function () { setRefreshHint("") }, 2500)
          })
        }
        fetchStatus(true)
          .catch(function () { /* continue polling */ })
          .then(function () { setTimeout(poll, 500) })
      }

      useEffect(function () {
        load(false)
        var timer = setInterval(function () { setTick(function (n) { return n + 1 }) }, REFRESH_MS)
        return function () { clearInterval(timer) }
      }, [])

      useEffect(function () { if (tick > 0 && !forceRef.current.busy) load(false) }, [tick])
      useEffect(function () {
        if (!data) return
        var now = Date.now()
        if (now - federatedRef.current.at < 60000) return
        federatedRef.current.at = now
        fetch('/api/dsh-mesh/federated').then(function (r) { return r.text() }).then(function (text) { try { setFederated(JSON.parse(text)) } catch (error) {} }).catch(function () {})
      }, [data])
      useEffect(function () {
        var raw = String((data && data.verdict) || '')
        if (!raw) return
        var st = verdictRef.current
        var at = String((data && data.at) || '')
        var fresh = Boolean(at) && at !== st.lastAt
        if (raw === 'down') {
          if (fresh && !st.downAt) st.downAt = Date.now()
          st.lastAt = at
          var persisted = Boolean(st.downAt) && Date.now() - st.downAt >= 15000
          setVerdictShown(persisted ? 'down' : 'degraded')
        } else {
          st.downAt = 0
          st.lastAt = at
          setVerdictShown(raw)
        }
        st.raw = raw
      }, [data])

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
          h('span', {
            className: 'dm-pill ' + (data.warming ? 'muted' : tone(verdictShown || data.verdict)),
            title: data.warming ? '' : (verdictShown === 'degraded' ? '探测波动：需持续 ≥15s 且新快照仍 down 才显示 down' : ''),
            style: verdictShown === 'degraded' ? { opacity: 0.75 } : undefined
          }, data.warming ? '预热中' : (verdictShown || data.verdict || '?')),
          h('span', { className: 'dm-sub' }, (data.meshVersion ? 'mesh ' + data.meshVersion + ' · ' : '') + (data.at ? ago(data.at) : '')),
          h('span', { style: { flex: 1 } }),
          h('label', { className: 'dm-toggle', title: '默认隐藏公网 IP/域名；勾选后显示真实地址并记住选择' },
            h('input', { type: 'checkbox', checked: Boolean(showPublic), onChange: toggleShowPublic }),
            h('span', null, '显示公网地址')
          ),
          h('a', { className: 'dm-btn', href: API, target: '_blank', rel: 'noreferrer', style: { textDecoration: 'none' } }, '原始 JSON'),
          h('button', { className: 'dm-btn', onClick: copyJson }, copied || '复制诊断'),
          h('button', { className: 'dm-btn primary', onClick: function () { load(true) }, title: '立即采集一次并等待新快照（8s 冷却）' }, loading ? '采集中…' : '刷新'),
          refreshHint ? h('span', { className: 'dm-sub' }, refreshHint) : null
        ),
        error ? h('div', { className: 'dm-err' }, error) : null,

        h('details', { className: 'dm-details dm-lan' },
          h('summary', null, '局域网发现 / 配对（首次使用）'),
          h(LanOnboarding)
        ),
        h(Details, { title: '节点管理', badge: '移除 / 吊销' },
          h(NodeManager, { onChanged: function () { load(true) } })
        ),

        h('div', { className: 'dm-body', style: splitW > 0 ? { '--dm-main-w': splitW + 'px' } : undefined },
          h('div', { className: 'dm-pane' },
            h(Viewport, { data: data, federated: federated, layout: computeLayout(1 + filterSelfPeers(dedupePeers(data.peers || []), data.nodeName).length), selectedKey: selectedKey, onSelect: setSelectedKey }),
            h(InfraPanels, { data: data }),
            h(DeviceDetails, { data: data, selectedKey: selectedKey })
          ),
          h('div', { className: 'dm-divider', onPointerDown: startSplit, title: '↔ 拖拽调整左右宽度（双击恢复默认）', onDoubleClick: function () { setSplitW(0); try { window.localStorage.removeItem('dsh-mesh-split-w') } catch (error) { /* ignore */ } } }),
          h('div', { className: 'dm-pane' },
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
                issues.slice(0, 6).map(function (issue, i) { return h('div', { key: 'i' + i, className: 'dm-err', style: { marginTop: 3 } }, '· ' + maskText(issue)) }),
                hints.slice(0, 6).map(function (hint, i) { return h('div', { key: 'h' + i, className: 'dm-sub', style: { marginTop: 3 } }, '· ' + maskText(hint)) })
              )
            ) : null
          )
        ),
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

    /** 左侧栏「AI 网络」专用图标：中心节点 + 四向设备，和「委托」区分开。 */
    function networkPanelIcon(props) {
      var size = (props && props.size) || 16
      return h('svg', {
        'data-dsh-panel-entry': 'mesh-network', viewBox: '0 0 16 16', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', 'aria-hidden': 'true',
        style: { color: 'var(--dsh-brand-color, currentColor)' }
      },
        h('path', { d: 'M8 8 L8 2.6 M8 8 L13.4 8 M8 8 L8 13.4 M8 8 L2.6 8', opacity: '.55' }),
        h('circle', { cx: 8, cy: 8, r: 2.1, fill: 'none', strokeWidth: '1.4' }),
        h('circle', { cx: 8, cy: 2.6, r: 1.25, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 13.4, cy: 8, r: 1.25, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 8, cy: 13.4, r: 1.25, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 2.6, cy: 8, r: 1.25, fill: 'currentColor', stroke: 'none' })
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
        // 2026-11-10：本机任务（local）没有对端会话，不要发 peer call
        if (/^(local|self|localhost)$/i.test(String(selected.node || ''))) {
          flash('bad', '本机任务（local）没有对端会话；请在 DSH 侧栏查看本机会话')
          return
        }
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
        selected && selected.staleActive ? h('div', { className: 'dm-dg-notice warn' }, '该任务已超过 ' + Math.round(selected.staleAfterSec / 60) + ' 分钟没有更新，可能已失联；可点「刷新状态」再查对端，或重新发起委托。') : null,
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
                  title: task.staleActive ? '超过 ' + Math.round(task.staleAfterSec / 60) + ' 分钟无更新（疑似失联，可点刷新状态）' : (task.goal || '')
                },
                  h('div', { className: 'dm-dg-row-top' },
                    task.activeFresh ? h(LoadingSpinner, { size: 12 }) : null,
                    h('span', { className: 'dm-dg-route' },
                      h('span', { className: 'dm-dg-from' }, task.fromLabel || task.from || '?'),
                      (task.fromIsLocal || (localNode && task.from === localNode)) ? h('span', { className: 'dm-dg-me' }, task.fromInstance ? '本机·' + task.fromInstance : '本机') : null,
                      h('span', { className: 'dm-dg-arrow' }, '→'),
                      h('span', { className: 'dm-dg-to' }, (task.nodeLabel || task.node || '?') + (task.instance ? ' · ' + task.instance : ''))
                    ),
                    dgChip(task.displayState || task.state),
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
                          dgChip(selected.displayState || selected.state)
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
                      h('button', { type: 'button', className: 'dm-dg-btn primary', onClick: loadSession, disabled: sessionLoading || !selected.sessionId || /^(local|self|localhost)$/i.test(String(selected.node || '')) },
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

    // 2026-11-10：AI 网络现在是左侧栏主页面，不再受设置面板的窄容器约束。
    // 2026-11-10（二次）：内边距从 .dm-page 挪到滚动容器上——滚动条属于滚动容器，只有在滚动容器
    // 铺满整页时才会像 DSH 对话区那样贴到最右边；内容留白靠滚动容器自己的 padding 提供。
    var PAGE_CSS = `
.dm-page { box-sizing:border-box; width:100%; height:100%; overflow:hidden; padding:0; --dm-pad-x:clamp(18px, 2.6vw, 42px); --dm-pad-y:clamp(16px, 2.2vw, 30px); --dm-scroll-inset:2px; }
.dm-content-shell { width:100%; height:100%; position:relative; --dm-content-w:920px; }
/* 纵向滚动条：对齐 DSH 对话区 wSkVaW_scrollBody 的观感——滚动容器 margin-right:2px
   （滚动条离面板边 2px，不贴死），滑块 track 留 2px（滑块上下不顶到边）。
   滚动条只占右侧会把内容挤得偏左，所以左侧补等宽内边距（--dm-sb-pad）。 */
/* border-box 必须加：height:100% + 上下 padding 否则把滚动容器撑出面板高度，
   底部 padding 和页脚会被 .dm-page 的 overflow:hidden 裁掉（2026-11-10 实测 1051 > 985）。 */
.dm-content-scroll { box-sizing:border-box; height:100%; overflow:auto; scrollbar-gutter:stable; margin-right:var(--dm-scroll-inset); padding:var(--dm-pad-y) var(--dm-pad-x) 36px; padding-left:calc(var(--dm-pad-x) + var(--dm-sb-pad, 0px) + var(--dm-scroll-inset)); }
.dm-content-scroll::-webkit-scrollbar-track { margin:2px; }
.dm-content { width:min(100%, var(--dm-content-w)); max-width:100%; margin:0 auto; box-sizing:border-box; container-type:inline-size; container-name:dm-content; }
.dm-content > .dm-root { width:100%; max-width:100%; margin:0 auto; }
/* 宽度手柄：位置由 JS 实测的「内容边距 + 页面留白」算出高亮线中心点，写进 --dm-bar-l / --dm-bar-r。
   高亮线在 10px 手柄内偏内侧 5px（::after 4px + 2px 线宽的一半），所以手柄 = 中心点 ∓ 5px。
   这样留白窄时（拖到最大）高亮线自动居中在「内容边 ↔ 页面边」中间，留白宽时保持 24px 间隙。 */
.dm-width-handle { z-index:1; position:absolute; top:0; bottom:0; cursor:col-resize; width:10px; }
.dm-width-handle[data-side="left"] { left:calc(var(--dm-bar-l, -100px) - 5px); }
.dm-width-handle[data-side="right"] { right:calc(var(--dm-bar-r, -100px) - 5px); }
.dm-width-handle::after { content:''; pointer-events:none; opacity:0; position:absolute; top:0; bottom:0; width:2px; border-radius:2px; background:linear-gradient(to bottom, transparent calc(var(--dm-width-handle-pointer-y, 50%) - 36px), var(--dsw-alias-scrollbar-bg-l1, rgba(128,128,128,.55)) calc(var(--dm-width-handle-pointer-y, 50%) - 8px), var(--dsw-alias-scrollbar-bg-l1, rgba(128,128,128,.55)) calc(var(--dm-width-handle-pointer-y, 50%) + 8px), transparent calc(var(--dm-width-handle-pointer-y, 50%) + 36px)); }
.dm-width-handle[data-side="left"]::after { right:4px; }
.dm-width-handle[data-side="right"]::after { left:4px; }
.dm-width-handle[data-dragging]::after { opacity:1; }
@media (hover:hover) { .dm-width-handle:hover::after { opacity:1; } }
@media (max-width: 1000px) { .dm-width-handle { display:none; } }
.dm-body { display:grid; grid-template-columns:minmax(300px, var(--dm-main-w, 62%)) 8px minmax(0,1fr); gap:10px; align-items:start; }
.dm-lan { border:1px solid rgba(128,128,128,.25); border-radius:12px; padding:10px 12px; background:rgba(128,128,128,.035); }
.dm-lan-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
.dm-lan input { font:inherit; font-size:12px; padding:5px 8px; border:1px solid rgba(128,128,128,.35); border-radius:7px; background:transparent; color:inherit; min-width:180px; }
.dm-lan-node { display:flex; gap:8px; align-items:center; border-top:1px solid rgba(128,128,128,.16); padding:7px 0; font-size:12px; }
.dm-lan-node:first-child { border-top:none; }
.dm-lan-code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; padding:6px 8px; border-radius:8px; background:rgba(88,166,255,.1); border:1px solid rgba(88,166,255,.35); word-break:break-all; }
.dm-toggle { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; opacity:.8; cursor:pointer; user-select:none; white-space:nowrap; }
.dm-toggle input { margin:0; }
.dm-nodes { display:flex; flex-direction:column; gap:4px; }
.dm-node-row { display:flex; align-items:center; gap:8px; padding:6px 0; border-top:1px solid rgba(128,128,128,.14); font-size:12px; }
.dm-node-row:first-child { border-top:none; }
.dm-node-name { font-weight:600; min-width:80px; }
.dm-node-url { opacity:.6; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dm-btn.bad { border-color:rgba(209,75,65,.55); color:#d14b41; }

.dm-card-node.indirect { opacity:.62; border-style:dashed; border-color:rgba(128,128,128,.45); background:rgba(128,128,128,.03); }
.dm-fed-badge { font-size:10px; opacity:.6; padding:1px 5px; border:1px dashed rgba(128,128,128,.5); border-radius:999px; white-space:nowrap; }
.dm-edge-indirect { stroke:rgba(128,128,128,.5); stroke-width:1.1; fill:none; }

.dm-pane { min-width:0; display:flex; flex-direction:column; gap:12px; }
.dm-divider { cursor:col-resize; align-self:stretch; min-height:120px; border-radius:4px; position:relative; }
.dm-divider::before { content:''; position:absolute; top:0; bottom:0; left:3px; width:1px; background:rgba(128,128,128,.28); }
.dm-divider:hover::before, .dm-divider:active::before { background:rgba(88,166,255,.7); width:2px; left:2.5px; }
@container dm-content (max-width: 860px) { .dm-body { grid-template-columns:1fr; } .dm-divider { display:none; } }
`
    function MeshNetworkPage() {
      // 宽度偏好：与 DSH 对话区相同语义——空 = 默认宽度，数字 = 用户拖拽固定值。
      var prefState = useState(function () {
        try { var saved = Number(window.localStorage.getItem('dsh-mesh.contentWidth')); return Number.isFinite(saved) && saved > 0 ? saved : 0 } catch (error) { return 0 }
      })
      var pref = prefState[0]; var setPref = prefState[1]
      var shellState = useState(0); var containerW = shellState[0]; var setContainerW = shellState[1]
      // 滚动条实际占位宽度（px）：左侧补等宽内边距，让内容在 shell 上真正居中。
      var sbState = useState(0); var sbPad = sbState[0]; var setSbPad = sbState[1]
      // 手柄几何：内容元素到 shell 左右边的实测 px（null = 还没量到）。
      var geoState = useState(null); var geo = geoState[0]; var setGeo = geoState[1]
      var shellRef = useRef(null)

      // 2026-11-10：宽度基准 =「内容可用宽度」= 滚动容器内容盒宽（clientWidth - 左右 padding）；
      // 滚动条贴页面右边，其占位由 CSS 在左侧补等宽 padding 抵消（--dm-sb-pad）。
      useEffect(function () {
        var el = shellRef.current
        if (!el) return
        function measure() {
          var scroller = el.querySelector('.dm-content-scroll')
          if (!scroller) { setContainerW(el.clientWidth || 0); return }
          var sb = Math.max(0, (scroller.offsetWidth || 0) - (scroller.clientWidth || 0))
          var scs = getComputedStyle(scroller)
          var padL = parseFloat(scs.paddingLeft) || 0
          var padR = parseFloat(scs.paddingRight) || 0
          // 内容盒宽 = clientWidth - 实际左右 padding（左侧含滚动条补偿与 2px 滚动条外留白）
          var avail = Math.max(0, (scroller.clientWidth || 0) - padL - padR)
          setContainerW(avail)
          setSbPad(function (prev) { return Math.abs(prev - sb) >= 0.5 ? sb : prev })
        }
        measure()
        if (typeof ResizeObserver !== 'undefined') {
          var observer = new ResizeObserver(measure)
          observer.observe(el)
          return function () { observer.disconnect() }
        }
        window.addEventListener('resize', measure)
        return function () { window.removeEventListener('resize', measure) }
      }, [sbPad])

      // 手柄定位：高亮线在「内容边 ↔ 页面边」的留白里自动居中（留白宽时退回 24px 间隙）。
      // 滚动容器已铺满整页，所以内容到 shell 左右边的距离就是完整留白（右侧含滚动条）。 */
      useEffect(function () {
        var el = shellRef.current
        if (!el) return
        var raf = 0
        function sync() {
          var content = el.querySelector('.dm-content')
          if (!content) return
          var sr = el.getBoundingClientRect()
          var cr = content.getBoundingClientRect()
          // 留白量到 shell（页面）边：滚动条外那 2px 也算留白，高亮线才居中在视觉留白里
          var offL = cr.left - sr.left
          var offR = sr.right - cr.right
          // 高亮线中心到内容边的距离：留白的一半，但夹在 [12, 29]（29 = 24px 间隙 + 5px 线中心偏移）
          var gapL = Math.max(12, Math.min(29, offL / 2))
          var gapR = Math.max(12, Math.min(29, offR / 2))
          var bl = Math.round((offL - gapL) * 10) / 10
          var br = Math.round((offR - gapR) * 10) / 10
          setGeo(function (prev) {
            if (prev && Math.abs(prev.l - bl) < 0.5 && Math.abs(prev.r - br) < 0.5) return prev
            return { l: bl, r: br }
          })
        }
        sync()
        raf = window.requestAnimationFrame(sync)
        if (typeof ResizeObserver !== 'undefined') {
          var observer = new ResizeObserver(sync)
          var content = el.querySelector('.dm-content')
          if (content) observer.observe(content)
          observer.observe(el)
          return function () { window.cancelAnimationFrame(raf); observer.disconnect() }
        }
        return function () { window.cancelAnimationFrame(raf) }
      }, [contentW, sbPad])

      // 默认宽度 = 内容可用宽度 x DEFAULT_W_RATIO；拖拽限制在 [640, 可用宽度]，
      // 双击手柄清掉偏好后回到默认。想留一点内边距就把 DEFAULT_W_RATIO 调到 0.98/0.96。
      var DEFAULT_W_RATIO = 1
      var widthNow = containerW || 920
      var maxW = Math.max(640, widthNow)
      var contentW = pref > 0 ? Math.min(Math.max(pref, 640), maxW) : Math.round(widthNow * DEFAULT_W_RATIO)

      function beginWidthDrag(side, event) {
        event.preventDefault()
        var handle = event.currentTarget
        var shell = handle.closest ? handle.closest('.dm-content-shell') : (handle.parentElement && handle.parentElement.parentElement)
        if (!shell) return
        var scroller = shell.querySelector('.dm-content-scroll')
        var max = 920
        if (scroller) {
          var scs2 = getComputedStyle(scroller)
          var padL2 = parseFloat(scs2.paddingLeft) || 0
          var padR2 = parseFloat(scs2.paddingRight) || 0
          max = Math.max(0, (scroller.clientWidth || 0) - padL2 - padR2)
        } else if (shell.clientWidth) {
          max = shell.clientWidth
        }
        max = Math.max(640, max || 920)
        var base = contentW
        var originX = event.clientX
        var latest = contentW
        var firstBox = handle.getBoundingClientRect()
        handle.style.setProperty('--dm-width-handle-pointer-y', (event.clientY - firstBox.top) + 'px')
        handle.toggleAttribute('data-dragging', true)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        function onMove(moveEvent) {
          var dx = moveEvent.clientX - originX
          var outward = side === 'right' ? dx : -dx
          // 只有拖拽时才更新高亮位置（与 DSH 一致）；hover 时保持手柄高度的 50%。
          var box = handle.getBoundingClientRect()
          handle.style.setProperty('--dm-width-handle-pointer-y', (moveEvent.clientY - box.top) + 'px')
          // 两侧同时外扩/内收，所以内容宽度变化是手柄位移的 2 倍（与 DSH 一致）。
          latest = Math.min(Math.max(base + outward * 2, 640), max)
          setPref(latest)
        }
        function onUp() {
          handle.toggleAttribute('data-dragging', false)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          try { window.localStorage.setItem('dsh-mesh.contentWidth', String(latest)) } catch (error) { /* ignore */ }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }
      function resetContentWidth() {
        setPref(0)
        try { window.localStorage.removeItem('dsh-mesh.contentWidth') } catch (error) { /* ignore */ }
      }

      return h('div', { className: 'dm-page' },
        h('style', null, PAGE_CSS),
        h('div', {
          className: 'dm-content-shell',
          ref: shellRef,
          style: {
            '--dm-content-w': contentW + 'px',
            '--dm-sb-pad': sbPad + 'px',
            '--dm-bar-l': (geo ? geo.l : -100) + 'px',
            '--dm-bar-r': (geo ? geo.r : -100) + 'px'
          }
        },
          h('div', { className: 'dm-width-handle', 'data-side': 'left', title: '拖拽调整内容宽度（双击恢复默认）', onPointerDown: function (event) { beginWidthDrag('left', event) }, onDoubleClick: resetContentWidth }),
          h('div', { className: 'dm-width-handle', 'data-side': 'right', title: '拖拽调整内容宽度（双击恢复默认）', onPointerDown: function (event) { beginWidthDrag('right', event) }, onDoubleClick: resetContentWidth }),
          h('div', { className: 'dm-content-scroll' },
            h('div', { className: 'dm-content', style: { width: 'min(100%, ' + contentW + 'px)' } }, h(MeshStatusSection))
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
          // 0.2.2 的默认图标可能包在 span 里；在默认图标的父容器里原地替换，
          // 保留间距/对齐，并清掉所有旧 SVG，避免齿轮 + 自绘图标双图标。
          var existingIcon = button.querySelector('svg[data-dsh-mesh-nav-icon]')
          var old = []
          var all = button.querySelectorAll('svg')
          for (var j = 0; j < all.length; j++) if (all[j] !== existingIcon) old.push(all[j])
          var reference = old[0] || null
          var parent = reference ? reference.parentNode : button
          var className = reference ? reference.getAttribute('class') || '' : ''
          if (!existingIcon) {
            var icon = navMeshIconDom(className)
            if (reference) parent.insertBefore(icon, reference)
            else if (button.firstChild) button.insertBefore(icon, button.firstChild)
            else button.appendChild(icon)
          }
          for (var k = 0; k < old.length; k++) if (old[k].parentNode) old[k].parentNode.removeChild(old[k])
        }
      } catch (error) {
        /* ignore */
      }
    }

    function apply(ctx) {
      var disposers = []
      // 2026-11-10：AI 网络从「设置」迁到左侧栏独立页面，使用更大的主区域。
      try {
        disposers.push(ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({ name: 'sidebar.panellist', id: 'mesh-network', order: 54, label: function () { return 'AI 网络' } }, networkPanelIcon)
        }))
        disposers.push(ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'mesh-network', inject: function () { return {} } }, MeshNetworkPage)
        }))
      } catch (error) {
        console.warn('[dsh-mesh-ui] sidebar network page registration failed:', error)
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
