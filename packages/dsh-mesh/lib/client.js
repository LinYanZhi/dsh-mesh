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
  id: '@linyanzhi/dsh-mesh',
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

    // 2026-11-17：设备类型改为按 hardware 快照泛化推断，不再依赖个人设备表。
    // 原因：公开镜像的脱敏构建会删掉含个人设备名的表；硬编码表被删后 deviceType 未定义，
    // 整个「AI 网络」页面会被宿主 SlotErrorBoundary 吞成白屏（community PR #10）。
    var DEVICE_HW = {}
    function formFactorOf(h) {
      if (!h) return '—'
      if (h.platform === 'linux' && String(h.arch || '').indexOf('arm') === 0) return '手机'
      var cpu = String(h.cpuModel || '')
      if (/\b(i[3579]-\d{4,5}(U|H|P|HS)|Ryzen \d+ \d+(U|H|HS))\b/i.test(cpu)) return '笔记本'
      return cpu ? '主机' : '—'
    }
    // nodeDisplay() 只拿得到节点名，所以在页面渲染时先把 hardware 登记到缓存，供按名字反查。
    function rememberDeviceHardware(name, hw) {
      if (!hw || typeof hw !== 'object') return
      var key = peerDeviceKey(name)
      if (key) DEVICE_HW[key] = hw
      var raw = String(name || '').trim().toLowerCase()
      if (raw) DEVICE_HW[raw] = hw
    }
    function rememberDeviceHardwareOf(data) {
      if (!data) return
      rememberDeviceHardware(data.nodeName, data.hardware)
      var list = data.peers || []
      for (var i = 0; i < list.length; i++) {
        var peer = list[i]
        if (peer && peer.hardware) rememberDeviceHardware(peer.name, peer.hardware)
      }
    }
    function deviceType(nameOrHw) {
      if (nameOrHw && typeof nameOrHw === 'object') return formFactorOf(nameOrHw)
      var key = String(nameOrHw || '').trim().toLowerCase()
      if (!key) return ''
      var hw = DEVICE_HW[peerDeviceKey(key)] || DEVICE_HW[key]
      return hw ? formFactorOf(hw) : ''
    }
    // 2026-11-07 用户要求：卡片标题只用固定中文叫法，不显示电脑设备名
    var NODE_LABELS = {}
    function rememberDeviceHardwareOf(data) {
      if (!data) return
      rememberDeviceHardware(data.nodeName, data.hardware)
      var list = data.peers || []
      for (var i = 0; i < list.length; i++) {
        var peer = list[i]
        if (peer && peer.hardware) rememberDeviceHardware(peer.name, peer.hardware)
      }
    }
    function deviceType(nameOrHw) {
      if (nameOrHw && typeof nameOrHw === 'object') return formFactorOf(nameOrHw)
      var key = String(nameOrHw || '').trim().toLowerCase()
      if (!key) return ''
      var hw = DEVICE_HW[peerDeviceKey(key)] || DEVICE_HW[key]
      return hw ? formFactorOf(hw) : ''
    }
    // 2026-11-11：设备类型图标（笔记本 / 主机 / 手机），内联 SVG、无外部依赖、跟随文字颜色。
    // 主机 = 大屏幕 + 小底座（台式机显示器），与笔记本（屏幕+全宽底座线）区分。
    // 2026-11-11：用户明确不要擅自上色 —— 全部使用 currentColor，单色。
    function deviceTypeIcon(type) {
      var base = {
        className: 'dm-dev-icon',
        width: 24,
        height: 24,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true'
      }
      if (type === '手机') {
        return h('svg', base,
          h('rect', { x: 6, y: 2, width: 12, height: 20, rx: 2.5 }),
          h('path', { d: 'M11 18h2' })
        )
      }
      if (type === '笔记本') {
        return h('svg', base,
          h('rect', { x: 4, y: 5, width: 16, height: 10, rx: 1.6 }),
          h('path', { d: 'M2 19h20' })
        )
      }
      // 默认 = 主机：大屏幕 + 小底座（台式机显示器）
      return h('svg', base,
        h('rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }),
        h('path', { d: 'M8 21h8' }),
        h('path', { d: 'M12 17v4' })
      )
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
    var DISABLED_PEERS_KEY = 'dsh-mesh-ui.disabledPeers.v1'
    function disabledPeerNames() {
      try { var list = JSON.parse(window.localStorage.getItem(DISABLED_PEERS_KEY) || '[]'); return Array.isArray(list) ? list : [] } catch (e) { return [] }
    }
    function setDisabledPeerNames(list) {
      try { if (list && list.length) window.localStorage.setItem(DISABLED_PEERS_KEY, JSON.stringify(list)); else window.localStorage.removeItem(DISABLED_PEERS_KEY) } catch (e) { /* ignore */ }
    }
function filterSelfPeers(list, nodeName) {
    var selfKey = peerDeviceKey(nodeName)
    var disabled = disabledPeerNames().map(function (x) { return String(x).toLowerCase() })
    return (list || []).filter(function (peer) {
      if (selfKey && peerDeviceKey(peer.name) === selfKey) return false
      var name = String(peer.name || '').toLowerCase()
      var id = String(peer.id || '').toLowerCase()
      return disabled.indexOf(name) < 0 && disabled.indexOf(id) < 0
    })
  }
function nodeLabel(name) { return NODE_LABELS[String(name || '').toLowerCase()] || String(name || '未知节点') }
    // [layout-helpers-begin] 2026-11-09 拓扑自定义布局：节点 key 顺序 + localStorage 持久化 + clamp
    var LAYOUT_STORE_KEY = 'dsh-mesh-ui.topology.layout.v1'
    function topologyNodeKeys(data) {
      var d = data || {}
      var peers = filterSelfPeers(dedupePeers(d.peers || []), d.nodeName)
      var cands = visibleSakuraCandidates().map(function (c) { return 'candidate:' + c.key })
      return ['local'].concat(peers.map(function (peer) { return 'peer:' + peer.name })).concat(cands)
    }
    // 2026-11-10：设备显示顺序（左→右 / 逆时针）——拓扑渲染与拖拽位置表必须共用同一顺序
    var FAN_ORDER = []
    function keyServerAffinity(key, data) {
      if (key === 'local') return 0.5
      if (String(key).indexOf('candidate:') === 0) return 1
      var d = data || {}
      var peers = filterSelfPeers(dedupePeers(d.peers || []), d.nodeName)
      var name = String(key || '').replace(/^peer:/, '')
      var found = peers.filter(function (p) { return String(p.name) === name })[0]
      if (!found) return 0.5
      if (sakuraTunnelOf(d, peerDeviceKey(found.name), found)) return 1
      var t = found.tunnel || {}
      if (t.kind === 'frp' || t.kind === 'wan') return 0
      return 0.5
    }
    function fanRankOfNodeKey(key, data) {
      var dev = key === 'local' ? peerDeviceKey(data && data.nodeName) : peerDeviceKey(String(key || '').replace(/^peer:/, ''))
      var idx = FAN_ORDER.indexOf(dev)
      return idx < 0 ? 99 : idx
    }
    function orderedNodeKeys(data) {
      var keys = topologyNodeKeys(data).slice()
      keys.sort(function (a, b) {
        var s = keyServerAffinity(a, data) - keyServerAffinity(b, data)
        if (s !== 0) return s
        var d = fanRankOfNodeKey(a, data) - fanRankOfNodeKey(b, data)
        return d !== 0 ? d : String(a).localeCompare(String(b))
      })
      return keys
    }
    // 2026-11-11：「AI 网络2」设备-only 拓扑（画板无服务器/隧道）的默认顺序规则：
    //   本机在中心，其余设备按固定设备顺序（FAN_ORDER）环绕；不再按“服务器亲和度”左右分栏。
    function deviceOnlyNodeKeys(data) {
      var d = data || {}
      var peers = filterSelfPeers(dedupePeers(d.peers || []), d.nodeName)
      var keys = peers.map(function (peer) { return 'peer:' + peer.name })
      keys.sort(function (a, b) {
        var r = fanRankOfNodeKey(a, d) - fanRankOfNodeKey(b, d)
        return r !== 0 ? r : String(a).localeCompare(String(b))
      })
      return ['local'].concat(keys)
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
    function loadMovedLayout(storeKey) {
      try {
        var raw = window.localStorage.getItem(storeKey || LAYOUT_STORE_KEY)
        if (!raw) return {}
        var obj = JSON.parse(raw)
        return obj && typeof obj === 'object' ? obj : {}
      } catch (_) { return {} }
    }
    function saveMovedLayout(obj, storeKey) {
      try { window.localStorage.setItem(storeKey || LAYOUT_STORE_KEY, JSON.stringify(obj || {})) } catch (_) { /* ignore */ }
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
      if (h.indexOf('.') < 0) return true // 主机名（DESKTOP-xxx / home2）
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
      if (t.kind === 'lan') return { text: '局域网直连 · ' + lanAddrLabel(t), short: '局域网' }
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
/* 2026-11-11：多通道地址信息卡（悬浮设备时出现，堆叠显示，避免线上文字叠在一起） */
.dm-chan-tip { position:absolute; z-index:4; transform:translateX(-50%); background:rgba(13,17,23,.96); border:1px solid rgba(128,128,128,.35); border-radius:8px; padding:6px 10px; box-shadow:0 8px 24px rgba(0,0,0,.28); font-size:12px; line-height:1.55; white-space:nowrap; pointer-events:none; }
body.light .dm-chan-tip { background:rgba(255,255,255,.97); }
.dm-chan-tip-h { font-weight:650; font-size:12.5px; margin-bottom:3px; }
/* 2026-11-11：画布左上角连线类型图例（线段样例 + 类型说明） */
/* 2026-11-12：连线类型图例改为横向、无背景板（节省空间、视觉更轻） */
.dm-topo-legend { position:absolute; left:10px; top:8px; z-index:3; pointer-events:none; display:flex; flex-direction:row; align-items:center; flex-wrap:wrap; gap:4px 12px; font-size:11.5px; line-height:1.4; text-shadow:0 0 3px rgba(0,0,0,.35); }
body.light .dm-topo-legend { text-shadow:0 0 3px rgba(255,255,255,.8); }
.dm-topo-legend-h { font-size:11px; opacity:.55; margin:0; }
.dm-topo-legend-row { display:flex; align-items:center; gap:4px; white-space:nowrap; }
.dm-topo-legend-row svg { flex:0 0 auto; }
.dm-chan-row { display:flex; align-items:center; gap:7px; }
.dm-chan-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.dm-chan-kind { opacity:.75; min-width:52px; }
.dm-chan-addr { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
/* 2026-11-12：悬浮卡里断开通道的红色样式（圆点红 + 地址红 + 「离线」角标） */
.dm-chan-row.down .dm-chan-addr { color:#e5534b; }
.dm-chan-row.down .dm-chan-kind { color:#e5534b; opacity:.65; }
.dm-chan-down { color:#e5534b; font-size:10.5px; opacity:.92; margin-left:2px; }
.dm-card-node.hovered { border-color: rgba(88,166,255,.95) !important; box-shadow: 0 0 0 2px rgba(88,166,255,.35), 0 10px 26px rgba(0,0,0,.25); z-index: 5; }
.dm-world-outer { position:absolute; left:0; top:0; }
.dm-world { position:absolute; left:0; top:0; transform-origin:0 0; }
.dm-lines { position:absolute; left:0; top:0; overflow:visible; pointer-events:none; z-index:0; }
.dm-world-label { position:absolute; left:10px; top:8px; font-size:11px; opacity:.5; font-variant-numeric:tabular-nums; }

/* 节点卡片（世界坐标里） */
.dm-card-node { position:absolute; z-index:1; box-sizing:border-box; overflow:visible; border-radius:12px; padding:10px 12px;
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
.dm-dev-icon { flex:0 0 auto; opacity:1; }
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
.dm-card-node.candidate { opacity:.55; border-style:dashed; border-color:rgba(163,113,247,.6); }
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
.dm-chip.link { border-color:rgba(163,113,247,.45); color:#8b5cf6; opacity:1; }

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
/* 2026-11-12：右侧面板统一数据表格（固定列宽 table-layout:fixed，列对齐、行行一致，超长省略） */
.dm-data-table { width:100%; table-layout:fixed; border-collapse:collapse; }
.dm-data-table th { text-align:left; font-weight:600; font-size:11px; opacity:.5; padding:4px 8px 5px 0; border-bottom:1px solid rgba(128,128,128,.2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dm-data-table td { padding:5px 8px 5px 0; border-bottom:1px solid rgba(128,128,128,.1); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; vertical-align:middle; }
.dm-data-table tr:last-child td { border-bottom:none; }
.dm-data-table .dm-cell-actions { display:flex; gap:6px; justify-content:flex-end; }
.dm-data-table .dm-cell-actions .dm-btn { padding:2px 8px; }
/* 2026-11-10：委托台账表改为固定列宽 + 单行省略；非固定布局下 5 列会把「节点/任务」压到
   每行一个字，就是用户看到的竖排。完整内容看 title 悬浮提示。 */
.dm-details .dm-table { table-layout:auto; width:100%; min-width:0; }
.dm-table-wrap { overflow-x:auto; }
.dm-details .dm-table th, .dm-details .dm-table td { overflow:visible; text-overflow:clip; white-space:nowrap; vertical-align:top; }
.dm-details .dm-table th, .dm-details .dm-table td { padding-right:12px; }
.dm-details .dm-table td:nth-child(5) { white-space:normal; overflow-wrap:anywhere; min-width:120px; }
/* 目标列不写死百分比：让它吃掉剩余空间（单元格右内边距不参与百分比，写死 34% 会溢出 1 条横向滚动条） */
.dm-trunc { max-width:100%; overflow:visible; text-overflow:clip; white-space:normal; overflow-wrap:anywhere; display:block; vertical-align:top; }
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
    var SELECTED_SAKURA_KEY = 'dsh-mesh-ui.sakuraServer.v1'
    var SELECTED_PUBLIC_KEY = 'dsh-mesh-ui.publicServer.v1'
    var SELECTED_SAKURA_SERVERS_KEY = 'dsh-mesh-ui.sakuraServers.v2'
    var SAKURA_CANDIDATES_KEY = 'dsh-mesh-ui.sakuraCandidates.v1'
    function sakuraCandidates() {
      try {
        var list = JSON.parse(window.localStorage.getItem(SAKURA_CANDIDATES_KEY) || '[]')
        return Array.isArray(list) ? list : []
      } catch (e) { return [] }
    }
    function setSakuraCandidates(list) {
      try {
        if (list && list.length) window.localStorage.setItem(SAKURA_CANDIDATES_KEY, JSON.stringify(list))
        else window.localStorage.removeItem(SAKURA_CANDIDATES_KEY)
      } catch (e) { /* ignore */ }
    }
    function sakuraUiEnabled() {
      try {
        var f = JSON.parse(window.localStorage.getItem('dsh-mesh-ui.filters.v1') || '{}') || {}
        return f.sakura !== false
      } catch (e) { return true }
    }
    function visibleSakuraCandidates() { return sakuraUiEnabled() ? sakuraCandidates() : [] }
    function peerTunnelAddrs(data) {
      var out = {}
      ;((data && data.peers) || []).forEach(function (p) {
        var t = p.tunnel || {}
        if (t.host && t.port) out[String(t.host) + ':' + String(t.port)] = true
        var m = /^[a-z]+:\/\/([^/:]+):(\d+)/i.exec(String(p.url || ''))
        if (m) out[m[1] + ':' + m[2]] = true
      })
      return out
    }
    function reconcileMeshUiState(data) {
      var selected = selectedSakuraServers()
      var cands = sakuraCandidates()
      if (!selected.length) {
        if (cands.length) setSakuraCandidates([])
        return
      }
      var allowed = {}
      selected.forEach(function (s) {
        (s.mesh || []).forEach(function (t) {
          var port = t.remotePort || t.port
          if (t.host && port) allowed[String(t.host) + ':' + String(port)] = true
        })
      })
      var peers = peerTunnelAddrs(data)
      var next = cands.filter(function (c) { return allowed[c.key] && !peers[c.key] })
      if (next.length !== cands.length) setSakuraCandidates(next)
    }
    function readSelectedServer(key) {
      try { return JSON.parse(window.localStorage.getItem(key) || 'null') } catch (e) { return null }
    }
    function writeSelectedServer(key, value) {
      try {
        if (value) window.localStorage.setItem(key, JSON.stringify(value))
        else window.localStorage.removeItem(key)
      } catch (e) { /* ignore */ }
    }
    function selectedSakuraServer() { return readSelectedServer(SELECTED_SAKURA_KEY) }
    function setSelectedSakuraServer(value) { writeSelectedServer(SELECTED_SAKURA_KEY, value) }
    function selectedPublicServer() { return readSelectedServer(SELECTED_PUBLIC_KEY) }
    function setSelectedPublicServer(value) { writeSelectedServer(SELECTED_PUBLIC_KEY, value) }
    function selectedSakuraServers() {
      try {
        var list = JSON.parse(window.localStorage.getItem(SELECTED_SAKURA_SERVERS_KEY) || '[]')
        return Array.isArray(list) ? list.slice(0, 1) : []
      } catch (e) { return [] }
    }
    function setSelectedSakuraServers(list) {
      try {
        if (list && list.length) window.localStorage.setItem(SELECTED_SAKURA_SERVERS_KEY, JSON.stringify(list))
        else window.localStorage.removeItem(SELECTED_SAKURA_SERVERS_KEY)
      } catch (e) { /* ignore */ }
    }
    function sakuraServerGroups(account) {
      var tunnels = (account && account.tunnels) || []
      if (!tunnels.length) return []
      var g = { key: 'sakura', nodeId: null, name: 'Sakura 穿透', host: '', mesh: [], other: [] }
      var hosts = []
      tunnels.forEach(function (t) {
        if (t.host && hosts.indexOf(t.host) < 0) hosts.push(t.host)
        var lp = Number(t.localPort) || null
        var mesh = lp === 8124 || lp === 8126 || /(dsh|mesh)/i.test(String(t.name || '') + ' ' + String(t.note || ''))
        ;(mesh ? g.mesh : g.other).push(t)
      })
      g.host = hosts.join(' / ')
      g.online = g.mesh.some(function (t) { return t.online !== false }) || g.other.some(function (t) { return t.online === true })
      g.meshCount = g.mesh.length
      g.otherCount = g.other.length
      return [g]
    }

    function visibleServerCount(data, show) {
      var s = show || { lan: true, public: true, sakura: true }
      // 2026-11-11 用户语义：服务器节点 = 用户显式“加入拓扑”的视图，
      // 不从 peer 隧道 / 本机公网入口自动推导（否则“移出公网拓扑”后仍显示公网）
      var hasPublic = Boolean(selectedPublicServer())
      // 只有用户明确加入的 Sakura 服务器才进入拓扑；账号里有隧道不等于用户同意展示
      var hasSakura = selectedSakuraServers().length > 0
      return (s.public && hasPublic ? 1 : 0) + (s.sakura && hasSakura ? 1 : 0)
    }

    function Viewport(props) {
      var layout = props.layout
      // 2026-11-11：「AI 网络2」沙箱变体 = 画板只保留设备节点（不渲染服务器/隧道节点）
      var devicesOnly = props.variant === 'v2'
      // 2026-11-10：按当前筛选的可见服务器数量决定布局（0/1/2）
      var currentFilters = (function () { try { var s = JSON.parse(window.localStorage.getItem('dsh-mesh-ui.filters.v1') || '{}') || {}; return { lan: s.lan !== false, public: s.public !== false, sakura: s.sakura !== false } } catch (_) { return { lan: true, public: true, sakura: true } } })()
      // 2026-11-10：布局服务器数使用快照；筛选切换只隐藏服务器，不触发重排。
      var layoutServerState = useState(function () { return devicesOnly ? 0 : visibleServerCount(props.data, currentFilters) })
      var layoutServerCount = layoutServerState[0]
      var setLayoutServerCount = layoutServerState[1]
      // 2026-11-09-v5：卡片宽度自适应 —— 子组件测量真实卡片宽高后回传，按实际尺寸重算多边形布局
      var sizeState = useState(null)
      var measuredSize = sizeState[0]
      var setMeasuredSize = sizeState[1]
      if (measuredSize && measuredSize.w > 0 && measuredSize.h > 0) {
        layout = computeLayout(layout.count, { cardW: measuredSize.w, cardH: measuredSize.h, serverCount: layoutServerCount, devicesOnly: devicesOnly })
      } else {
        layout = computeLayout(layout.count, { serverCount: layoutServerCount, devicesOnly: devicesOnly })
      }
      var infraBoundsRef = useRef([])
      // 2026-11-09：重置拓扑时同时通知 Topology 复位服务器卡片
      var resetNonceState = useState(0)
      var resetNonce = resetNonceState[0]
      var bumpResetNonce = resetNonceState[1]
      function onInfraBounds(boxes) { infraBoundsRef.current = boxes || [] }
      // 服务器加入/移出拓扑后，刷新布局里的 serverCount，否则新 server 卡片不会出现
      useEffect(function () {
        setLayoutServerCount(devicesOnly ? 0 : visibleServerCount(props.data, currentFilters))
      }, [props.data, props.topoNonce])
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
      // 沙箱变体用独立的拖拽位置存储，避免继承默认页（含服务器布局）里拖过的坐标
      var movedStoreKey = devicesOnly ? 'dsh-mesh-ui.topology.layout.v2.v1' : 'dsh-mesh-ui.topology.layout.v1'
      var nodeKeys = devicesOnly ? deviceOnlyNodeKeys(props.data) : orderedNodeKeys(props.data)
      var layoutState = useState(function () { return loadMovedLayout(movedStoreKey) })
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
        var def = (layout.mode === 'servers-top' || layout.mode === 'servers-top-single') ? DEFAULT_DEVICE_POS[devKey] : null
        if (def) return [def[0], def[1]]
        return [p[0] + baseOffsetX, p[1] + baseOffsetY]
      })
      // 2026-11-10：node positions 会被平移到世界画布中心；服务器中心也必须加同一偏移，否则单服务器布局会隔半个画布
      var worldServerCenter = layout.serverCenter ? [layout.serverCenter[0] + baseOffsetX, layout.serverCenter[1] + baseOffsetY] : null
      var effLayout = Object.assign({}, layout, { W: worldW, H: worldH, positions: positions, baseOffsetX: baseOffsetX, baseOffsetY: baseOffsetY, contentW: layout.W, contentH: layout.H, serverCenter: worldServerCenter })
      function moveNode(key, pos) {
        setMovedLayout(function (prev) {
          var next = Object.assign({}, prev)
          next[key] = pos
          saveMovedLayout(next, movedStoreKey)
          return next
        })
      }
      function resetLayout() {
        setMovedLayout({})
        saveMovedLayout({}, movedStoreKey)
        // 只有点重置时才读取当前勾选服务器并重排；筛选本身不重绘
        setLayoutServerCount(devicesOnly ? 0 : visibleServerCount(props.data, currentFilters))
        // 2026-11-10：重置只恢复拓扑结构，保留用户手动拖拽的画布高度
        interactedRef.current = false
        bumpResetNonce(function (x) { return x + 1 })
        setTimeout(fit, 160)
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
          devicesOnly ? null : h('div', { className: 'dm-filters' },
            [['lan', '局域网'], ['public', '公网中继'], ['sakura', '第三方穿透']].map(function (it) {
              var tr = TRANSPORTS[it[0]]
              return h('label', { key: it[0], className: 'dm-flt' + (showFilters[it[0]] ? ' on' : ''), style: { '--c': tr.color } },
                h('input', { type: 'checkbox', checked: showFilters[it[0]], onChange: function () { toggleFilter(it[0]) } }),
                h('span', null, it[1])
              )
            })
          ),
          h('span', { className: 'dm-topbar-info' }, devicesOnly
            ? (effLayout.count + ' 个设备节点 · 每通道一条连线（同向并排）')
            : (effLayout.count + ' 节点 · ' + effLayout.edges.length + ' 条链路 · 拖拽卡片自定义布局'))
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
              h(Topology, { data: props.data, layout: effLayout, selectedKey: props.selectedKey, onSelect: props.onSelect, scale: view.scale, onNodeMove: moveNode, onDragEdge: autoPanAt, onCardSize: onCardSize, show: showFilters, federated: props.federated, onInfraBounds: onInfraBounds, resetNonce: resetNonce, movedLayout: movedLayout, lanNodes: props.lanNodes, variant: props.variant })
            )
          ),
          // 2026-11-11：画布左上角线段图例 + 连线类型说明（仅沙箱 AI 网络2）
          devicesOnly ? h('div', { className: 'dm-topo-legend' },
            h('div', { className: 'dm-topo-legend-h' }, '连线类型'),
            [['lan', '局域网', false], ['sakura', '内网穿透 · 樱花', true], ['public', '公网', true]].map(function (it) {
              var tr = TRANSPORTS[it[0]]
              return h('div', { className: 'dm-topo-legend-row', key: it[0] },
                h('svg', { width: 20, height: 8 }, h('line', { x1: 0, y1: 4, x2: 20, y2: 4, stroke: tr.color, strokeWidth: 2, strokeDasharray: tr.dash ? '6 5' : 'none' })),
                h('span', null, it[1])
              )
            }),
            // 2026-11-12：离线通道（线变红、悬浮卡地址变红）
            h('div', { className: 'dm-topo-legend-row', key: 'offline' },
              h('svg', { width: 20, height: 8 }, h('line', { x1: 0, y1: 4, x2: 20, y2: 4, stroke: '#e5534b', strokeWidth: 2 })),
              h('span', null, '离线')
            )
          ) : null,
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
    // 2026-11-10：按矩形碰撞检测扩大半径，保证默认布局卡片不重叠
    function fanHasOverlap(points, cardW, cardH, GAP, hasServer) {
      var halfW = cardW / 2
      var halfH = cardH / 2
      for (var i = 0; i < points.length; i++) {
        for (var j = i + 1; j < points.length; j++) {
          if (Math.abs(points[i][0] - points[j][0]) < cardW + GAP && Math.abs(points[i][1] - points[j][1]) < cardH + GAP) return true
        }
        if (hasServer) {
          var serverW = Math.max(cardW * 1.35, 280)
          var serverH = Math.max(cardH, 96)
          if (Math.abs(points[i][0]) < (cardW + serverW) / 2 + GAP && Math.abs(points[i][1]) < (cardH + serverH) / 2 + GAP) return true
        }
      }
      return false
    }

    function layoutNodesOnly(count, cardW, cardH, GAP, PAD) {
      var n = Math.max(1, count)
      var radius = n > 1 ? Math.max((cardW + GAP) / (2 * Math.sin(Math.PI / n)), cardH * 1.2) : 0
      function nodePoints(r) {
        var pts = []
        for (var i = 0; i < n; i++) {
          var a = -Math.PI / 2 + (i * 2 * Math.PI) / n
          pts.push([r * Math.cos(a), r * Math.sin(a)])
        }
        return pts
      }
      var raw = nodePoints(radius)
      for (var tries = 0; tries < 240 && n > 1 && fanHasOverlap(raw, cardW, cardH, GAP, false); tries++) {
        radius += 8
        raw = nodePoints(radius)
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
    // 2026-11-11：设备-only 拓扑布局（AI 网络2）：
    //   本机（主机）居中，其余设备在其下方呈扇形（120° 弧）展开；半径按卡片不重叠自动放大。
    function ringHasOverlap(points, cardW, cardH, GAP) {
      for (var i = 0; i < points.length; i++) {
        if (Math.abs(points[i][0]) < cardW + GAP && Math.abs(points[i][1]) < cardH + GAP) return true
        for (var j = i + 1; j < points.length; j++) {
          if (Math.abs(points[i][0] - points[j][0]) < cardW + GAP && Math.abs(points[i][1] - points[j][1]) < cardH + GAP) return true
        }
      }
      return false
    }
    function layoutDevicesOnly(count, cardW, cardH, GAP, PAD) {
      var n = Math.max(1, count)
      var devices = n - 1
      var START = Math.PI * 5 / 6 // 150°
      var SPREAD = Math.PI * 2 / 3 // 120°，从 150° 扫到 30°
      var RATIO = 0.35 // 纵向压扁，呈扁扇形
      var A = Math.max(cardW * 1.1, 220)
      function fanPoints(a) {
        var pts = []
        if (!devices) return pts
        for (var i = 0; i < devices; i++) {
          var angle = devices === 1 ? Math.PI / 2 : (START - (i / (devices - 1)) * SPREAD)
          pts.push([a * Math.cos(angle), RATIO * a * Math.sin(angle)])
        }
        return pts
      }
      var fan = fanPoints(A)
      for (var tries = 0; tries < 400 && devices > 0 && ringHasOverlap(fan, cardW, cardH, GAP); tries++) {
        A += 12
        fan = fanPoints(A)
      }
      var pts = [[0, 0]].concat(fan)
      var xs = pts.map(function (p) { return p[0] })
      var ys = pts.map(function (p) { return p[1] })
      var minX = Math.min.apply(null, xs) - cardW / 2
      var maxX = Math.max.apply(null, xs) + cardW / 2
      var minY = Math.min.apply(null, ys) - cardH / 2
      var maxY = Math.max.apply(null, ys) + cardH / 2
      var ox = -minX + PAD
      var oy = -minY + PAD
      var positions = pts.map(function (p) { return [Math.round(p[0] + ox), Math.round(p[1] + oy)] })
      var W = Math.ceil(maxX - minX + PAD * 2)
      var H = Math.ceil(maxY - minY + PAD * 2)
      return { count: n, cardW: cardW, cardH: cardH, gap: GAP, W: W, H: H, positions: positions, edges: [], topDeviceY: positions.length ? positions[0][1] : 0, mode: 'devices-only', serverCenter: null }
    }
    // 2026-11-10：一个服务器时用紧凑两排扇形，不再靠扩大半径防重叠
    // 服务器在上方居中；设备分两排（上排少、下排多），列距/行距按卡片尺寸，整体宽度接近双服务器布局。
    function layoutServerCenter(count, cardW, cardH, GAP, PAD) {
      var n = Math.max(1, count)
      var topN = Math.floor(n / 2)
      var botN = n - topN
      var serverH = Math.max(cardH, 96)
      var stepX = cardW + GAP
      var upperY = serverH / 2 + GAP + cardH / 2
      var lowerY = upperY + cardH + GAP
      var raw = []
      function rowXs(k) {
        var xs = []
        for (var i = 0; i < k; i++) xs.push((i - (k - 1) / 2) * stepX)
        return xs
      }
      var ux = rowXs(topN)
      for (var i = 0; i < topN; i++) raw.push([ux[i], upperY])
      var bx = rowXs(botN)
      var by = topN > 0 ? lowerY : upperY
      for (var j = 0; j < botN; j++) raw.push([bx[j], by])
      var minX = Math.min(-cardW / 2, ...raw.map(function (p) { return p[0] - cardW / 2 }))
      var maxX = Math.max(cardW / 2, ...raw.map(function (p) { return p[0] + cardW / 2 }))
      var minY = -serverH / 2
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
      // 2026-11-11：设备-only 拓扑（AI 网络2）用独立布局规则：本机居中 + 设备环绕，不留服务器位
      if (override && override.devicesOnly) return layoutDevicesOnly(count, cardW, cardH, GAP, PAD)
      if (serverCount === 0) return layoutNodesOnly(count, cardW, cardH, GAP, PAD)
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
      return { count: count, cardW: cardW, cardH: cardH, gap: GAP, W: W, H: H, positions: positions, edges: edges, topDeviceY: topDeviceY, mode: serverCount === 1 ? 'servers-top-single' : 'servers-top', serverCenter: null }
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
  var local = (data && data.tunnels && data.tunnels.sakura && data.tunnels.sakura.tunnels) || []
  if (!acc && !local.length) return null
  var localMapped = local.map(function (t) {
    return {
      id: t.name + ':' + t.host + ':' + t.port,
      name: t.name,
      host: t.host,
      remotePort: t.port,
      localPort: t.localPort == null ? null : Number(t.localPort),
      online: t.probe ? t.probe.up === true : t.online === true,
      deviceKey: peerDeviceKey(t.name),
      addr: (t.host || '') + ':' + (t.port || '')
    }
  })
  var list = (acc && acc.tunnels && acc.tunnels.length) ? acc.tunnels : localMapped
  if (!acc && !list.length) return null
  var base = acc ? Object.assign({}, acc) : { available: false, error: '账号 API 暂不可用', total: list.length, online: list.filter(function (x) { return x.online }).length, tunnels: list }
  if (localMapped.length && (!acc || acc.available !== true || !(acc.tunnels || []).length)) {
    base.available = true
    base.source = 'local-log'
    base.error = null
    base.total = list.length
    base.online = list.filter(function (x) { return x.online }).length
    base.tunnels = list
  }
  return Object.assign({}, base, { tunnels: list, total: list.length, online: list.filter(function (x) { return x.online }).length })
}
// 2026-11-19：只把「localPort 指向当前 mesh server」的 Sakura 隧道算作设备通道。
// 同一账号里还有音乐站等其它隧道（8787/8790），不能画成 AI 网络链路（用户看到peer-x 5 条线的根因）。
function meshLocalPort(data) {
  var lt = (data && data.localTunnel) || {}
  var p = Number(lt.port || (data && data.local && data.local.port) || 8124)
  return Number.isFinite(p) && p > 0 ? p : 8124
}
function isMeshSakuraTunnel(data, t) {
  if (!t) return false
  if (t.localPort == null) return true
  return Number(t.localPort) === meshLocalPort(data)
}
function sakuraTunnelOf(data, devKey, peer) {
  var acc = sakuraAccountOf(data)
  if (!acc) return null
  var k = peerDeviceKey(devKey)
  for (var i = 0; i < (acc.tunnels || []).length; i++) if (acc.tunnels[i].deviceKey === k && isMeshSakuraTunnel(data, acc.tunnels[i])) return acc.tunnels[i]
  // 配对后的 peer 名字不一定等于 Sakura 隧道名；优先用 URL host:port 反查
  var t = (peer && peer.tunnel) || {}
  var ph = String(t.host || '')
  var pp = String(t.port || '')
  var url = String((peer && peer.url) || '')
  for (var j = 0; j < (acc.tunnels || []).length; j++) {
    var x = acc.tunnels[j]
    if (!isMeshSakuraTunnel(data, x)) continue
    if (ph && pp && String(x.host) === ph && String(x.remotePort) === pp) return x
    if (url && x.addr && url.indexOf(x.addr) >= 0) return x
  }
  return null
}
// 2026-11-11：某台设备在 Sakura 账号里有哪些隧道（deviceKey / name / note 归一匹配），
// 用于「一个设备有几条通道就画几条线」。
function sakuraTunnelsForDevice(data, devKey) {
  var acc = sakuraAccountOf(data)
  if (!acc) return []
  var key = peerDeviceKey(devKey)
  var out = []
  for (var i = 0; i < (acc.tunnels || []).length; i++) {
    var t = acc.tunnels[i]
    if (peerDeviceKey(t.deviceKey || '') === key) out.push(t)
  }
  return out
}
// 设备当前实际走哪条通道（按 peer 端点判定），用于把「当前使用」那条加粗。
function deviceActiveKind(data, node) {
  var t = (node && node.tunnel) || {}
  var host = String(t.host || '')
  if (isLanPeer(node) || /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)) return 'lan'
  var list = sakuraTunnelsForDevice(data, node && node.devKey)
  for (var i = 0; i < list.length; i++) {
    var x = list[i]
    var rp = String(x.remotePort == null ? x.port || '' : x.remotePort)
    if (String(x.host || '') === host && rp === String(t.port || '')) return 'sakura'
  }
  if (t.kind === 'frp' || t.kind === 'wan') return 'public'
  return 'unknown'
}
// 2026-11-12（用户多次强调，规则已落盘 plugin/README.md）：局域网通道的悬浮地址/连线地址
// 必须显示「局域网 IP:端口」，禁止用设备名/主机名（设备号:端口号）。IP 缺失时退化为「局域网:端口」。
function lanAddrLabel(lt) {
  lt = lt || {}
  var host = String(lt.host || '')
  var ip = String(lt.ip || '')
  if (!ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) ip = host
  var port = lt.port ? ':' + lt.port : ''
  return ip ? ip + port : '局域网' + port
}
function deviceLinkState(data, peer, lanMap) {
  var dk = peerDeviceKey(peer.name)
  var t = peer.tunnel || {}
  // 2026-11-10：蓝线状态以隧道端口 TCP 探测为准（HTTP /health 对高延迟节点会误判断连）
  var probe = t.probe && typeof t.probe.up === "boolean" ? t.probe : null
  var publicUp = (probe ? probe.up === true : false) || Boolean(peer.up)
  var lan = lanMap ? lanMap[dk] : (t.kind === 'lan' ? { up: Boolean(peer.up), host: t.host, port: t.port, ip: t.ip || '' } : null)
  var lanUp = Boolean(lan && (lan.probe && lan.probe.up === true ? true : lan.up))
  var st = sakuraTunnelOf(data, dk, peer)
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
      var lanNodes = props.lanNodes || []
      var show = props.show || { lan: true, public: true, sakura: true }
      // 2026-11-11：「AI 网络2」沙箱变体 = 画板只保留设备节点（服务器/隧道节点与候选全部不渲染）
      var devicesOnly = props.variant === 'v2'
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
      rememberDeviceHardwareOf(data)
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
        if (t.kind === 'lan') return lanAddrLabel(t) + '（内网）'
        return maskHost(t.host) + (t.port ? ':' + t.port : '')
      }

      // LAN peer 单独收集（dedupe 后可能被更快的 frp 记录覆盖，但 LAN 线仍要画）
  var lanMap = {}
  filterSelfPeers(data.peers || [], data.nodeName).forEach(function (p) {
    var t = p.tunnel || {}
    if (isLanPeer(p)) lanMap[peerDeviceKey(p.name)] = { up: Boolean(p.up), host: t.host, port: t.port, ip: t.ip || '', probe: t.probe || null }
  })
  // LAN 扫描发现的节点优先于公网/Sakura 归类（同机房的 peer 实际有局域网路径）
  var lanByKey = {}
  lanNodes.forEach(function (n) {
    if (!n || n.service !== 'dsh-mesh') return
    var k = peerDeviceKey(n.node || n.hostname || '')
    if (k) lanByKey[k] = n
  })
  filterSelfPeers(data.peers || [], data.nodeName).forEach(function (p) {
    var pk = peerDeviceKey(p.name)
    if (lanMap[pk]) return
    var hostKey = peerDeviceKey(p.hostname || '')
    var cand = lanByKey[pk] || lanByKey[hostKey]
    function lanAliasMatch(x, k) {
      return x === k || (x.indexOf(k) === 0 && /^\d+$/.test(x.slice(k.length)))
    }
    if (!cand) {
      Object.keys(lanByKey).some(function (k) {
        if (lanAliasMatch(pk, k) || lanAliasMatch(hostKey, k)) { cand = lanByKey[k]; return true }
        return false
      })
    }
    if (cand) lanMap[pk] = { up: true, host: cand.address || cand.hostname, port: cand.port, ip: cand.address || cand.hostname, probe: { up: true } }
  })
  // 2026-11-12：端口 chip = 「连过的 DSH 端口」并集（localStorage 历史 ∪ 当前报告）。
  // 这样某台机某个实例掉线后端口仍占位显示红色，一眼看出「某端口掉了」。
  var PORTS_STORE_KEY = 'dsh-mesh-ui.ports.v1'
  function knownDevPorts(devKey, current) {
    var key = String(devKey || '')
    var store = {}
    try { store = JSON.parse(localStorage.getItem(PORTS_STORE_KEY) || '{}') || {} } catch (e) { store = {} }
    var curMap = {}
    ;(current || []).forEach(function (p) { if (p && p.port) curMap[String(p.port)] = p })
    var prev = Array.isArray(store[key]) ? store[key] : []
    var all = {}
    prev.forEach(function (p) { all[String(p)] = true })
    Object.keys(curMap).forEach(function (p) { all[p] = true })
    var list = Object.keys(all).map(Number).filter(function (p) { return p > 0 }).sort(function (a, b) { return a - b }).slice(0, 12)
    try { store[key] = list; localStorage.setItem(PORTS_STORE_KEY, JSON.stringify(store)) } catch (e) { /* ignore */ }
    return list.map(function (p) {
      var c = curMap[String(p)]
      return c ? { port: p, up: c.up, error: c.error || '' } : { port: p, up: false, error: '未探测到' }
    })
  }
  var peerLinks = peers.map(function (peer) { return deviceLinkState(data, peer, lanMap) })
  var portsByDev = {}
  peers.forEach(function (peer, pi) {
    var k = peerLinks[pi] && peerLinks[pi].devKey
    if (!k) return
    var list = portsByDev[k] || (portsByDev[k] = [])
    ;(peer.instancesList || []).forEach(function (p) { list.push(p) })
  })
  var nodes = [{
    key: 'local',
    local: true,
    devKey: peerDeviceKey(data.nodeName),
    up: true,
    name: nodeDisplay(data.nodeName),
    dsh: localUp + '/' + instances.length,
    ports: knownDevPorts(peerDeviceKey(data.nodeName), instances.map(function (inst) { return { port: inst.port, up: inst.up, error: inst.error || '' } })),
    extra: ''
  }].concat(peers.map(function (peer, pi) {
    var ls = peerLinks[pi]
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
      ports: knownDevPorts(ls.devKey, portsByDev[ls.devKey] || []),
      latencyMs: peer.latencyMs,
      tunnel: peer.tunnel || {},
      error: peer.error || ''
    }
  })).concat(devicesOnly ? [] : visibleSakuraCandidates().map(function (c) {
    return {
      key: 'candidate:' + c.key,
      candidate: true,
      local: false,
      up: false,
      name: c.name || c.host,
      dsh: '待验证',
      ports: [],
      tunnel: { kind: 'sakura', host: c.host, port: c.port, addr: c.addr || (c.host + ':' + c.port) },
      candidateHost: c.host,
      candidatePort: c.port,
      error: '待授权'
    }
  }))
  // 默认布局的交叉削减：按邻接服务器做 barycenter 排序，左侧公网 / 右侧 Sakura，本机放中间
  var orderKeys = devicesOnly ? deviceOnlyNodeKeys(data) : orderedNodeKeys(data)
  nodes.sort(function (a, b) { return orderKeys.indexOf(a.key) - orderKeys.indexOf(b.key) })
  // 基础设施节点（中转服务器）：阿里云 / 樱花
  var localPub = publicEntryFor(localTunnel)
  var selectedPublic = selectedPublicServer()
  if (selectedPublic) localPub = selectedPublic
  // 2026-11-11 用户语义：公网服务器节点只有用户“加入拓扑”后才显示，不从 peer 隧道自动推导
  var hasPublic = Boolean(selectedPublic)
  var publicVisible = show.public && hasPublic
  var sakuraRaw = sakuraAccountOf(data)
  var selectedSakuraList = selectedSakuraServers()
  var selectedMeshTotal = selectedSakuraList.reduce(function (n, s) { return n + ((s.mesh || []).length) }, 0)
  var selectedSakura = selectedSakuraList.length ? {
    name: 'Sakura 穿透',
    host: selectedSakuraList[0].host || '',
    note: selectedMeshTotal + ' 条 mesh 隧道',
    up: selectedSakuraList.some(function (s) { return s.online !== false })
  } : null
  var sakuraAcc = sakuraRaw ? Object.assign({}, sakuraRaw, { tunnels: (sakuraRaw.tunnels || []).filter(tunnelMatchesNode(localTunnel.port)) }) : null
  // 用户没加入 Sakura 服务器时，拓扑里不显示 Sakura server 回退卡片
  var sakuraVisible = show.sakura && Boolean(selectedSakura)
  var aliyunPorts = peers.map(function (p) { return isLanPeer(p) ? null : (p.tunnel || {}).port }).filter(Boolean)
  var infra = [
    selectedPublic
      ? { key: 'server-aliyun', transport: 'public', name: selectedPublic.name || '公网服务器', host: maskHost(selectedPublic.host || '') + (selectedPublic.port ? ':' + selectedPublic.port : ''), color: TRANSPORTS.public.color, detail: selectedPublic.note || '已加入拓扑', up: selectedPublic.up !== false }
      : { key: 'server-aliyun', transport: 'public', name: '公网中转', host: localPub ? maskHost(localPub.host) : '未配置', color: TRANSPORTS.public.color, detail: '隧道 ' + (aliyunPorts.length ? aliyunPorts.sort().join('/') : '—'), up: Boolean(localPub) || hasPublic },
    selectedSakura
      ? { key: 'server-sakura', transport: 'sakura', name: selectedSakura.name || 'Sakura 服务器', host: maskHost(selectedSakura.host || '') + (selectedSakura.port ? ':' + selectedSakura.port : ''), color: TRANSPORTS.sakura.color, detail: (selectedSakura.note || '已加入拓扑'), up: selectedSakura.up !== false }
      : { key: 'server-sakura', transport: 'sakura', name: '第三方 frps 穿透', host: sakuraAcc && sakuraAcc.tunnels && sakuraAcc.tunnels[0] ? maskText(sakuraAcc.tunnels[0].addr || '') : (sakuraAcc && sakuraAcc.error ? '状态不可用' : '未配置'), color: TRANSPORTS.sakura.color, detail: sakuraAcc ? (sakuraAcc.available === false ? ('Sakura 限流/未就绪：' + (sakuraAcc.error || 'unknown')) : (sakuraAcc.online + '/' + sakuraAcc.total + ' 在线')) : '未采集', up: Boolean(sakuraAcc && Number(sakuraAcc.online || 0) > 0) },
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
    if (layout.mode === 'servers-top-single') return [Math.round((DEFAULT_INFRA_POS.aliyun[0] + DEFAULT_INFRA_POS.sakura[0]) / 2), Math.round((DEFAULT_INFRA_POS.aliyun[1] + DEFAULT_INFRA_POS.sakura[1]) / 2)]
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
  function curve(key, from, to, up, transport, label, fromSize, toSize, highlight, offset, width, opacity) {
    var a = edgePoint(from, to, fromSize.w / 2, fromSize.h / 2)
    var b = edgePoint(to, from, toSize.w / 2, toSize.h / 2)
    // 多通道并排：沿垂直方向平移线段（正数向行进方向左侧），让同一设备的几条通道并在一起但不重叠
    var off = Number(offset) || 0
    if (off) {
      var odx = b[0] - a[0]
      var ody = b[1] - a[1]
      var olen = Math.sqrt(odx * odx + ody * ody) || 1
      var onx = -ody / olen
      var ony = odx / olen
      a = [a[0] + onx * off, a[1] + ony * off]
      b = [b[0] + onx * off, b[1] + ony * off]
    }
    var mx = (a[0] + b[0]) / 2
    var my = (a[1] + b[1]) / 2
    var dx = b[0] - a[0]
    var dy = b[1] - a[1]
    var len = Math.sqrt(dx * dx + dy * dy) || 1
    var bow = Math.min(12, len * 0.07)
    var color = up ? transport.color : DOWN_COLOR
    var dash = up ? (transport.dash ? '6 5' : 'none') : '6 5'
    var related = highlight !== false
    var strokeW = width == null ? 1.8 : width
    var baseOpacity = opacity == null ? 1 : opacity
    var els = [h('path', {
      key: key,
      d: 'M ' + a[0] + ' ' + a[1] + ' Q ' + (mx + (-dy / len) * bow) + ' ' + (my + (dx / len) * bow) + ' ' + b[0] + ' ' + b[1],
      fill: 'none', stroke: color, strokeWidth: strokeW, strokeDasharray: dash,
      className: up ? (transport.dash ? 'dm-edge-frp' : 'dm-edge-solid') : 'dm-edge-down',
      opacity: (related ? 1 : 0.12) * baseOpacity
    })]
    if (label) {
      els.push(h('text', { key: key + '-t', className: 'dm-edge-label', x: mx + (-dy / len) * (bow + off * 0.2), y: my + (dx / len) * (bow + off * 0.2) - 6, fill: color, fontSize: 12, textAnchor: 'middle', style: { display: (hoverKey && related) ? 'block' : 'none' } }, label))
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
  if (props.onInfraBounds) props.onInfraBounds(devicesOnly ? [] : infraBoxes)
  var localKey = peerDeviceKey(data.nodeName)
  var firstMeshTunnel = selectedSakuraList.length && selectedSakuraList[0].mesh && selectedSakuraList[0].mesh[0] ? selectedSakuraList[0].mesh[0] : null
  var localSak = selectedSakura
    ? { addr: firstMeshTunnel ? (firstMeshTunnel.host + ':' + firstMeshTunnel.remotePort) : (selectedSakura.host || 'Sakura'), online: selectedSakura.up !== false, name: selectedSakura.name }
    : sakuraTunnelOf(data, localKey)
  // 2026-11-10：LAN 线必须从本机节点出发（排序后 local 可能不在 index 0，之前误连到peer-x）
  var localNodeIdx = 0
  nodes.forEach(function (n, ii) { if (n.local) localNodeIdx = ii })
  // 2026-11-11：多通道信息不在线上写文字（会和并排线叠在一起），改成悬浮设备时的堆叠信息卡
  var deviceChannels = {}
  nodes.forEach(function (n, i) {
    var pa = layout.positions[i]
    if (n.local) {
      // 主机自己的两条上级链路：自建 frps（阿里云） + 本机樱花隧道（沙箱变体不画）
      if (!devicesOnly && publicVisible && localPub) svgEls = svgEls.concat(curve('pub-local', pa, aliyunPos, true, TRANSPORTS.public, maskHost(localPub.host) + ':' + localPub.port, sizeOf('local'), aliyunSize, edgeRelated('local', 'server-aliyun')))
      if (!devicesOnly && sakuraVisible && localSak) svgEls = svgEls.concat(curve('sak-local', pa, sakuraPos, localSak.online === true, TRANSPORTS.sakura, maskText(localSak.addr || ''), sizeOf('local'), sakuraSize, edgeRelated('local', 'server-sakura')))
      return
    }
    var sizeN = sizeOf(n.key)
    if (devicesOnly) {
      // 2026-11-11：一个设备有几条通道就画几条线（公网 / 内网穿透-Sakura / 局域网），
      // 同方向并排捆在一起；当前使用的通道加粗，可用但未启用的通道细且半透明。
      var ltDev = n.lanTunnel || {}
      // 2026-11-12：按设备聚合「所有 peer 记录」来判定通道——同一设备可能同时有公网 + 局域网 peer，
      // 只取去重后的单条记录会把公网线弄丢（用户反馈peer-x公网连接消失）。
      var chanDevKey = peerDeviceKey(n.devKey || n.name)
      var recWan = null
      var recLan = null
      ;((data && data.peers) || []).forEach(function (p) {
        if (peerDeviceKey(p.name) !== chanDevKey) return
        var t = p.tunnel || {}
        if (t.kind === 'frp' || t.kind === 'wan') { if (!recWan || (p.up && !recWan.up)) recWan = p }
        if (t.kind === 'lan' || /\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(String(p.url || ''))) { if (!recLan || (p.up && !recLan.up)) recLan = p }
      })
      var activeKind = deviceActiveKind(data, n)
      var sakuraList = sakuraTunnelsForDevice(data, n.devKey)
      var channels = []
      if (n.lanUp || recLan) {
        var ltLan = (recLan && recLan.tunnel) || ltDev
        var lanChanUp = recLan ? Boolean(recLan.up || (ltLan.probe && ltLan.probe.up === true)) : (ltDev.probe ? ltDev.probe.up === true : true)
        channels.push({ kind: 'lan', transport: TRANSPORTS.lan, label: lanAddrLabel(ltLan), up: lanChanUp, active: activeKind === 'lan' })
      }
      sakuraList.forEach(function (tun) {
        var rp = String(tun.remotePort == null ? tun.port || '' : tun.remotePort)
        channels.push({
          kind: 'sakura',
          transport: TRANSPORTS.sakura,
          label: maskHost(String(tun.host || '')) + (rp ? ':' + rp : ''),
          up: tun.online === true,
          active: activeKind === 'sakura' && String(tun.host || '') === String((n.tunnel || {}).host || '') && rp === String((n.tunnel || {}).port || '')
        })
      })
      var pubRec = recWan
      if (!pubRec && n.tunnel && (n.tunnel.kind === 'frp' || n.tunnel.kind === 'wan')) pubRec = { tunnel: n.tunnel, up: n.publicUp !== false }
      if (pubRec && activeKind !== 'sakura') {
        var wt = pubRec.tunnel || {}
        var pubUp = pubRec.up !== false && !(wt.probe && wt.probe.up === false)
        channels.push({ kind: 'public', transport: TRANSPORTS.public, label: maskHost(wt.host || '') + (wt.port ? ':' + wt.port : ''), up: pubUp, active: activeKind === 'public' })
      }
      if (!channels.length) channels.push({ kind: 'public', transport: TRANSPORTS.public, label: '', up: n.up, active: true })
      deviceChannels[n.key] = channels
      var spacing = 7
      channels.forEach(function (ch, ci) {
        var off = (ci - (channels.length - 1) / 2) * spacing
        // 线上不再写地址文字（并排会叠字），地址在悬浮信息卡里显示
        svgEls = svgEls.concat(curve('dev' + i + '-' + ch.kind, layout.positions[localNodeIdx], pa, ch.up, ch.transport, '', sizeOf('local'), sizeN, edgeRelated('local', n.key), off, 2, ch.active ? 1 : 0.7))
      })
      return
    }
    var tunnelKind = (n.tunnel || {}).kind
    var peerIsPublic = tunnelKind === 'frp' || tunnelKind === 'wan'
    // 2026-11-11 用户语义：链路类型只按“已加入拓扑的服务器视图”显示；
    // LAN 优先；Sakura/公网服务器未加入时不猜测传输方式，画中性“未显示”边避免节点悬空。
    var hasVisibleKind = Boolean(n.lanUp) || Boolean(sakuraVisible && n.sakuraTunnel) || Boolean(publicVisible && peerIsPublic && !n.sakuraTunnel)
    if (!hasVisibleKind && !n.candidate) {
      svgEls = svgEls.concat(curve('link' + i, layout.positions[localNodeIdx], pa, n.up, TRANSPORTS.public, '', sizeOf('local'), sizeN, edgeRelated('local', n.key)))
    }
    if (publicVisible && !n.lanUp && !n.sakuraTunnel && n.tunnel && n.tunnel.host && !isLanPeer(n) && peerIsPublic) svgEls = svgEls.concat(curve('pub' + i, pa, aliyunPos, n.publicUp, TRANSPORTS.public, maskHost(n.tunnel.host) + ((n.tunnel.port) ? ':' + n.tunnel.port : ''), sizeN, aliyunSize, edgeRelated(n.key, 'server-aliyun')))
    if (sakuraVisible && !n.lanUp && n.sakuraTunnel) svgEls = svgEls.concat(curve('sak' + i, pa, sakuraPos, n.sakuraUp === true, TRANSPORTS.sakura, maskText(n.sakuraTunnel.addr || ''), sizeN, sakuraSize, edgeRelated(n.key, 'server-sakura')))
    if (sakuraVisible && n.candidate) svgEls = svgEls.concat(curve('cand' + i, pa, sakuraPos, false, TRANSPORTS.sakura, maskText(n.tunnel.addr || ''), sizeN, sakuraSize, edgeRelated(n.key, 'server-sakura')))
    if (show.lan && n.lanUp) { var lt = n.lanTunnel || {}; var lanAddr = lanAddrLabel(lt); svgEls = svgEls.concat(curve('lan' + i, layout.positions[localNodeIdx], pa, n.lanUp, TRANSPORTS.lan, lanAddr, sizeOf('local'), sizeN, edgeRelated('local', n.key))) }
  })
  return h('div', null,
    h('svg', { className: 'dm-lines', width: layout.W, height: layout.H, viewBox: '0 0 ' + layout.W + ' ' + layout.H }, svgEls),
    nodes.map(function (node, i) {
      var pos = layout.positions[i]
      var selected = props.selectedKey === node.key
      var linkKinds = []
      if (!node.local && !node.candidate) {
        // 沙箱只删服务器/隧道节点，链路类型的显示口径与默认页保持一致
        if (node.lanUp) linkKinds.push({ kind: 'lan', label: '局域网' })
        else if (node.sakuraTunnel) linkKinds.push({ kind: 'public', label: '公网' })
        else {
          var lt = node.tunnel || {}
          if (publicVisible && (lt.kind === 'frp' || lt.kind === 'wan')) linkKinds.push({ kind: 'public', label: '公网' })
        }
        if (!linkKinds.length) linkKinds.push({ kind: 'public', label: '公网' })
      }
      return h('div', {
        key: node.key,
        className: 'dm-card-node compact draggable' + (node.local ? ' local' : '') + (node.candidate ? ' candidate' : '') + (node.up ? '' : ' down') + (selected ? ' selected' : '') + (hoverKey === node.key ? ' hovered' : '') + (dragKey === node.key ? ' dragging' : ''),
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
          h('div', { className: 'dm-n-name' },
            h('span', { className: 'dm-dot ' + (node.up ? 'ok' : 'bad') }),
            devicesOnly ? deviceTypeIcon(deviceType(node.devKey)) : null,
            h('span', { className: 'dm-ell' }, devicesOnly ? nodeLabel(node.devKey) : node.name)
          ),
          node.local ? h('span', { className: 'dm-chip ok' }, '本机')
            : (node.up ? h('span', { className: 'dm-extra' }, node.latencyMs == null ? '' : node.latencyMs + 'ms') : h('span', { className: 'dm-chip bad' }, '离线'))
        ),
        node.up ? null : h('div', { className: 'dm-offline-row' }, '全部链路不可用' + (node.error ? ' · ' + node.error : '')),
        h('div', { className: 'dm-card-dsh' },
          linkKinds.map(function (k, ki) {
            // 2026-11-12 用户要求：公网 tag 蓝色、局域网 tag 紫色
            return h('span', { key: ki, className: 'dm-chip link ' + (k.kind === 'lan' ? 'lan' : 'public'), style: { color: k.kind === 'lan' ? '#a371f7' : '#4d9bff', borderColor: k.kind === 'lan' ? 'rgba(163,113,247,.55)' : 'rgba(77,155,255,.55)' } }, k.label)
          }),
          (node.ports || []).map(function (item, pi) {
            var portUp = item.up == null ? node.up : Boolean(item.up)
            return h('span', { key: pi, className: 'dm-chip type' + (portUp ? ' run' : ' bad'), title: (portUp ? '端口在线' : (item.error ? '端口不可达：' + item.error : '端口离线')) + ' · DSH 端口 ' + item.port }, String(item.port))
          })
        )
      )
    }),
    (devicesOnly && hoverKey ? (function () {
      var hoveredNode = null
      for (var ni = 0; ni < nodes.length; ni++) if (nodes[ni].key === hoverKey) hoveredNode = nodes[ni]
      if (!hoveredNode) return null
      var chanLabels = { lan: '局域网', sakura: '公网', public: '公网', unknown: '公网' }
      function chanRow(ch, key) {
        // 2026-11-12：通道不可用（up === false）时，圆点与地址文字变红 + 标「离线」，
        // 方便悬浮时一眼看出是哪一条通道断了（线本身也会变红）。
        var down = ch.up === false
        return h('div', { className: 'dm-chan-row' + (down ? ' down' : ''), key: key },
          h('span', { className: 'dm-chan-dot', style: { background: down ? '#e5534b' : ch.transport.color } }),
          h('span', { className: 'dm-chan-kind' }, chanLabels[ch.kind] || ch.kind),
          h('span', { className: 'dm-chan-addr' }, ch.label || '—'),
          down ? h('span', { className: 'dm-chan-down' }, '离线') : null
        )
      }
      // 2026-11-11：悬浮本机（主机）时，其它几台设备“同时”各自弹出自己的信息卡，本机本身不变；
      // 悬浮某台设备时，只弹它自己的。
      var targets = []
      for (var ti = 0; ti < nodes.length; ti++) {
        var node = nodes[ti]
        if (node.local || node.candidate || !deviceChannels[node.key]) continue
        if (hoveredNode.local || node.key === hoveredNode.key) targets.push(node)
      }
      var tips = []
      for (var ki = 0; ki < targets.length; ki++) {
        var target = targets[ki]
        var idx = -1
        for (var pi = 0; pi < nodes.length; pi++) if (nodes[pi].key === target.key) idx = pi
        if (idx < 0) continue
        var pos = layout.positions[idx]
        tips.push(h('div', {
          className: 'dm-chan-tip',
          key: 'chan-tip-' + target.key,
          style: { left: pos[0] + 'px', top: Math.round(pos[1] + sizeOf(target.key).h / 2 + 12) + 'px' }
        },
          h('div', { className: 'dm-chan-tip-h' }, target.name),
          deviceChannels[target.key].map(function (ch, ci) { return chanRow(ch, 'ch' + ci) })
        ))
      }
      return tips.length ? tips : null
    })() : null),
    (!devicesOnly && publicVisible ? h('div', {
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
    (!devicesOnly && sakuraVisible ? h('div', {
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
      rememberDeviceHardwareOf(data)
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

      // 2026-11-11：首次进入不自动滚动；只有用户点击设备后才滚到对应卡片
      var selectedDeviceRef = useRef(null)
      var firstSelectedRef = useRef(true)
      useEffect(function () {
        if (firstSelectedRef.current) { firstSelectedRef.current = false; return }
        if (!props.selectedKey || !selectedDeviceRef.current) return
        var timer = setTimeout(function () {
          try { selectedDeviceRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (error) { selectedDeviceRef.current.scrollIntoView() }
        }, 40)
        return function () { clearTimeout(timer) }
      }, [props.selectedKey])

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
          return h('div', { key: device.key, ref: props.selectedKey === device.key ? function (el) { selectedDeviceRef.current = el } : null, className: 'dm-device' + (props.selectedKey === device.key ? ' selected' : '') },
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
      return h('div', { className: 'dm-table-wrap' }, h('table', { className: 'dm-data-table' },
        h('colgroup', null,
          h('col', { style: { width: '110px' } }),
          h('col', null),
          h('col', { style: { width: '70px' } }),
          h('col', { style: { width: '60px' } }),
          h('col', { style: { width: '60px' } }),
          h('col', { style: { width: '60px' } })
        ),
        h('thead', null, h('tr', null,
          h('th', null, '实例'), h('th', null, '模型'), h('th', null, 'pid'), h('th', null, 'tools'), h('th', null, '会话'), h('th', null, '运行')
        )),
        h('tbody', null, instances.map(function (inst) {
          var model = inst.model ? (inst.model.provider || '') + ' / ' + (inst.model.model || '') : '—'
          return h('tr', { key: inst.id },
            h('td', null, h('span', { className: 'dm-dot ' + (inst.up ? 'ok' : 'bad') }), ' ', inst.id),
            h('td', { className: 'dm-sub', title: model }, model),
            h('td', { className: 'dm-mono' }, inst.pid == null ? '—' : String(inst.pid)),
            h('td', null, inst.tools == null ? '—' : String(inst.tools)),
            h('td', null, String(inst.sessions || 0)),
            h('td', null, String(inst.running || 0))
          )
        }))
      ))
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
          h('table', { className: 'dm-data-table' },
            h('colgroup', null,
              h('col', { style: { width: '64px' } }),
              h('col', { style: { width: '96px' } }),
              h('col', { style: { width: '120px' } }),
              h('col', { style: { width: '72px' } }),
              h('col', null)
            ),
            h('thead', null, h('tr', null, h('th', null, '状态'), h('th', null, '节点'), h('th', null, '任务'), h('th', null, '耗时'), h('th', null, '目标'))),
            h('tbody', null, list.map(function (task) {
              return h('tr', { key: task.taskId },
                h('td', null, stateChip(task.state)),
                h('td', { title: nodeLabel(task.node) }, nodeLabel(task.node)),
                h('td', { className: 'dm-mono', style: { fontSize: 11 }, title: String(task.taskId || '') }, String(task.taskId || '').replace(/^T-\d{8}-/, 'T-…')),
                h('td', { className: 'dm-mono' }, dur(task.durationSec)),
                h('td', { title: task.goal }, task.goal || '')
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
      var rows = []
      if (latest) rows.push({ kind: latest.kind || 'alert', at: latest.at || '', summary: latest.summary || '', extra: latest.consecutiveBad ? ' · 连续 ' + latest.consecutiveBad + ' 次' : '', current: true })
      history.slice(0, 6).forEach(function (item) { rows.push({ kind: item.kind || '?', at: item.at || '', summary: item.summary || '', extra: '', current: false }) })
      return h('div', { className: 'dm-table-wrap' }, h('table', { className: 'dm-data-table' },
        h('colgroup', null,
          h('col', { style: { width: '64px' } }),
          h('col', { style: { width: '150px' } }),
          h('col', { style: { width: '96px' } }),
          h('col', null)
        ),
        h('thead', null, h('tr', null, h('th', null, '状态'), h('th', null, '时间'), h('th', null, '类型'), h('th', null, '内容'))),
        h('tbody', null, rows.map(function (row, i) {
          return h('tr', { key: i, style: row.current ? undefined : { opacity: 0.75 } },
            h('td', null, h('span', { className: 'dm-chip ' + (row.current ? 'bad' : 'muted') }, row.current ? '当前' : '历史')),
            h('td', { className: 'dm-mono', title: row.at }, row.at ? clockText(row.at) : '—'),
            h('td', { title: row.kind }, row.kind),
            h('td', { title: row.summary + row.extra }, row.summary + row.extra)
          )
        }))
      ))
    }

    function jsonFetch(url, options) {
      return fetch(url, options).then(function (r) { return r.text() }).then(function (text) { try { return JSON.parse(text) } catch (error) { return { ok: false, error: text.slice(0, 120) } } })
    }

    // 2026-11-10：节点管理（从本机移除 peer / 吊销入站 token）。
    // 2026-11-11：节点管理（只列设备；移除仅本机生效，跨设备同步待定）
    // 2026-11-12（用户多次强调，规则见 plugin/README.md）：节点管理/表格的地址列一律显示「IP:端口」，
    // 禁止主机名/设备名。优先用服务端解析好的 peer.ip；URL 本身就是 IP 时直接用；都拿不到显示「IP 未解析」。
    function peerAddrText(peer) {
      var ip = String((peer && peer.ip) || '')
      var port = String((peer && peer.port) || '')
      if (!ip) {
        try {
          var u = new URL(String((peer && peer.url) || ''))
          var host = u.hostname
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) { ip = host; port = port || u.port }
        } catch (e) { /* ignore */ }
      }
      if (!ip) return 'IP 未解析'
      return maskHost(ip) + (port ? ':' + port : '')
    }
    // 2026-11-12（用户强调）：局域网扫描表格的地址列也显示「IP:端口」，不显示 URL/主机名。
    function lanScanAddr(node) {
      var ip = String((node && node.address) || '')
      var port = ''
      try {
        var u = new URL(String((node && node.url) || ''))
        port = u.port || ''
        if (!ip) {
          var host = u.hostname
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) ip = host
        }
      } catch (e) { /* ignore */ }
      if (!ip) return 'IP 未解析'
      return ip + (port ? ':' + port : '')
    }
    function NodeManager(props) {
      var sp = useState(null); var peers = sp[0]; var setPeers = sp[1]
      var sb = useState(false); var busy = sb[0]; var setBusy = sb[1]
      var sm = useState(''); var msg = sm[0]; var setMsg = sm[1]
      function refresh() {
        setBusy(true)
        jsonFetch('/api/dsh-mesh/peers').then(function (r) {
          if (r.ok) {
            setPeers(r.peers || [])
            setDisabledPeerNames((r.peers || []).filter(function (p) { return p.disabled === true }).map(function (p) { return p.name || p.id }))
          } else setMsg(r.error || '读取节点失败')
        }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      useEffect(function () { refresh() }, [])
      // 2026-11-12：同一台设备可能有多条连接记录（home / home-exec、company / company-exec …），
      // 节点管理按「设备」归并，数量和拓扑图（同样按设备去重）保持一致，名称用固定中文设备名。
      function deviceGroups() {
        var map = {}
        var order = []
        ;(peers || []).forEach(function (peer) {
          var key = peerDeviceKey(peer.name)
          if (!map[key]) { map[key] = { key: key, name: nodeDisplay(key), ids: [], urls: [], records: 0, disabled: true }; order.push(key) }
          var group = map[key]
          group.ids.push(peer.id)
          group.records += 1
          var url = peerAddrText(peer)
          if (url && group.urls.indexOf(url) < 0) group.urls.push(url)
          if (!peer.disabled) group.disabled = false
        })
        return order.map(function (k) { return map[k] })
      }
      function runSequential(ids, fn) {
        return ids.reduce(function (p, id) { return p.then(function () { return fn(id) }) }, Promise.resolve())
      }
      function toggleDevice(group) {
        var nextDisabled = !group.disabled
        setBusy(true); setMsg('')
        runSequential(group.ids, function (id) {
          return jsonFetch('/api/dsh-mesh/peers/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, disabled: nextDisabled }) })
        }).then(function () {
          setMsg((nextDisabled ? '已禁用 ' : '已启用 ') + group.name + '（' + group.records + ' 条连接记录）')
          refresh(); if (props.onChanged) props.onChanged()
        }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      function removeDevice(group) {
        if (!window.confirm('从本机移除设备「' + group.name + '」（共 ' + group.records + ' 条连接记录）？\n\n注意：目前只移除本机与它的连接，不会同步通知其他设备；多设备同步待实现。')) return
        setBusy(true); setMsg('')
        runSequential(group.ids, function (id) {
          return jsonFetch('/api/dsh-mesh/peers/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
        }).then(function () {
          setMsg('已从本机移除 ' + group.name)
          refresh(); if (props.onChanged) props.onChanged()
        }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      var groups = peers === null ? null : deviceGroups()
      var totalRecords = (peers || []).length
      return h('div', { className: 'dm-nodes' },
        h('div', { className: 'dm-lan-row' },
          h('button', { className: 'dm-btn', disabled: busy, onClick: refresh }, '刷新设备'),
          h('span', { className: 'dm-sub' }, '共 ' + (groups ? groups.length : '—') + ' 台设备 · ' + totalRecords + ' 条连接记录（同一设备的多个入口已合并；本机不在列表内）；移除只影响本机。')
        ),
        msg ? h('div', { className: 'dm-sub', style: { marginTop: 6 } }, msg) : null,
        groups === null ? h('div', { className: 'dm-sub' }, '加载中…') :
          groups.length ? h('div', { className: 'dm-table-wrap' }, h('table', { className: 'dm-data-table' },
            h('colgroup', null,
              h('col', { style: { width: '34px' } }),
              h('col', { style: { width: '30%' } }),
              h('col', { style: { width: '96px' } }),
              h('col', null),
              h('col', { style: { width: '176px' } })
            ),
            h('thead', null, h('tr', null, h('th', null, ''), h('th', null, '设备'), h('th', null, '连接记录'), h('th', null, '地址'), h('th', null, '操作'))),
            h('tbody', null, groups.map(function (group) {
              var displayName = group.name + (group.disabled ? '（已禁用）' : '')
              var urlText = group.urls.join(' · ')
              return h('tr', { key: group.key },
                h('td', null, h('span', { className: 'dm-dot ' + (group.disabled ? 'muted' : 'ok'), style: group.disabled ? { opacity: .4 } : undefined })),
                h('td', { title: displayName }, displayName),
                h('td', { className: 'dm-mono' }, group.records + ' 条'),
                h('td', { className: 'dm-mono', title: urlText }, urlText),
                h('td', null, h('div', { className: 'dm-cell-actions' },
                  h('button', { className: 'dm-btn', disabled: busy, onClick: function () { toggleDevice(group) } }, group.disabled ? '启用' : '禁用'),
                  h('button', { className: 'dm-btn bad', disabled: busy, onClick: function () { removeDevice(group) } }, '移出网络')
                ))
              )
            }))
          )) : h('div', { className: 'dm-sub' }, '没有直接配对的设备节点')
      )
    }

    function PublicProbe(props) {
      var saved = {}
      try { saved = JSON.parse(window.localStorage.getItem('dsh-mesh-ui.publicProbe.v1') || '{}') || {} } catch (_) { saved = {} }
      var hs = useState(saved.host || ''); var host = hs[0]; var setHost = hs[1]
      var ps = useState(saved.port || 8124); var port = ps[0]; var setPort = ps[1]
      var ss = useState(saved.sakura === true); var sakura = ss[0]; var setSakura = ss[1]
      var rs = useState(null); var result = rs[0]; var setResult = rs[1]
      var bs = useState(false); var busy = bs[0]; var setBusy = bs[1]
      var ms = useState(''); var msg = ms[0]; var setMsg = ms[1]

      var tunnels = (props.data && props.data.tunnels) || {}
      var endpoints = []
      function addEndpoint(kind, name, h, p, up) {
        h = String(h || ''); p = String(p || '')
        if (!h || !p) return
        if (endpoints.some(function (x) { return x.host === h && x.port === p })) return
        endpoints.push({ kind: kind, name: name || kind, host: h, port: p, up: up === true })
      }
      if (tunnels.selfHosted) addEndpoint('自建', tunnels.selfHosted.name || '自建 frps', tunnels.selfHosted.host, tunnels.selfHosted.port, tunnels.selfHosted.probe && tunnels.selfHosted.probe.up)
      ;(tunnels.sakura && tunnels.sakura.tunnels || []).forEach(function (t) { addEndpoint('樱花', t.name || '樱花隧道', t.host, t.port, t.probe && t.probe.up) })
      ;(tunnels.sakuraAccount && tunnels.sakuraAccount.tunnels || []).forEach(function (t) {
        if (t.host && t.port) addEndpoint('樱花', t.name || '樱花隧道', t.host, t.port, t.online === true)
        else if (t.addr) { var m = /^([^:]+):(\d+)$/.exec(String(t.addr)); if (m) addEndpoint('樱花', t.name || '樱花隧道', m[1], m[2], t.online === true) }
      })

      function remember(nextHost, nextPort, nextSakura) {
        try { window.localStorage.setItem('dsh-mesh-ui.publicProbe.v1', JSON.stringify({ host: nextHost, port: nextPort, sakura: nextSakura })) } catch (_) {}
      }
      function probe() {
        var h = String(host || '').trim()
        var p = Number(port)
        if (!h) { setMsg('请输入公网 IP 或域名'); return }
        if (!Number.isInteger(p) || p < 1 || p > 65535) { setMsg('端口必须是 1-65535'); return }
        remember(h, p, sakura)
        setBusy(true); setMsg(''); setResult(null)
        jsonFetch('/api/dsh-mesh/public/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: h, port: p, sakura: sakura }) })
          .then(function (j) { setResult(j); if (!j.ok && j.error) setMsg(String(j.error)) })
          .catch(function (e) { setMsg(String(e.message || e)) })
          .finally(function () { setBusy(false) })
      }
      function row(k, v, tone) {
        if (v == null || v === '') return null
        return h('div', { className: 'dm-public-row' },
          h('span', { className: 'dm-public-k' }, k),
          h('span', { className: 'dm-public-v ' + (tone || '') }, String(v))
        )
      }
      var proto = result && result.protocol
      var sak = result && result.sakura
      // 公网直连：列出当前已有的公网入口（本机 + 已配对 peer），而不是只让用户盲填
      var directEndpoints = []
      function addDirect(source, h, p, up, kind) {
        h = String(h || ''); p = String(p || '')
        if (!h || !p) return
        if (directEndpoints.some(function (x) { return x.host === h && x.port === p })) return
        directEndpoints.push({ source: source || '入口', host: h, port: p, up: up === true, kind: kind || '' })
      }
      var lt = (props.data && props.data.localTunnel) || {}
      // 2026-11-12：localTunnel 里公网入口在 selfHosted（host/port），顶层 host/port 可能不存在，
      // 否则「本机」这一条公网入口会从列表里消失（用户反馈peer-x公网连接没了）。
      var selfT = lt.selfHosted || {}
      var selfEntry = (lt.host && lt.port)
        ? { host: lt.host, port: lt.port, up: Boolean(lt.probe && lt.probe.up) || Boolean(lt.host) }
        : (selfT.host && selfT.port ? { host: selfT.host, port: selfT.port, up: Boolean(selfT.probe && selfT.probe.up) || Boolean(selfT.host) } : null)
      if (selfEntry) addDirect('本机', selfEntry.host, selfEntry.port, selfEntry.up, selfT.kind || lt.kind || '')
      ;((props.data && props.data.peers) || []).forEach(function (p) {
        if (isLanPeer(p)) return
        var t = p.tunnel || {}
        if (!t.host || !t.port) return
        if (t.kind !== 'frp' && t.kind !== 'wan') return
        addDirect(nodeDisplay(peerDeviceKey(p.name)), t.host, t.port, Boolean(p.up || (t.probe && t.probe.up)), t.kind)
      })
      return h('div', { className: 'dm-public' },
        h('div', { className: 'dm-sub' }, '输入公网服务器 IP/域名，检测 TCP、TLS 和 dsh-mesh 协议；勾选后会同时匹配本机樱花/自建隧道入口。'),
        h('div', { className: 'dm-public-form' },
          h('input', { type: 'text', value: host, placeholder: '公网 IP 或域名', spellCheck: false, onChange: function (e) { setHost(e.target.value) } }),
          h('input', { type: 'number', min: 1, max: 65535, value: port, placeholder: '端口', onChange: function (e) { setPort(e.target.value) } }),
          h('label', { className: 'dm-public-check' },
            h('input', { type: 'checkbox', checked: sakura, onChange: function (e) { setSakura(e.target.checked) } }),
            h('span', null, '检测樱花穿透隧道')
          ),
          h('button', { className: 'dm-btn primary', disabled: busy, onClick: probe }, busy ? '检测中…' : '检测')
        ),
        endpoints.length ? h('div', { className: 'dm-public-suggest' },
          h('span', { className: 'dm-sub' }, '本机入口：'),
          endpoints.map(function (it, i) {
            return h('button', { className: 'dm-btn', key: i, title: it.host + ':' + it.port, onClick: function () { setHost(it.host); setPort(it.port) } },
              (it.kind === '樱花' ? '樱花 · ' : '') + it.name + ' :' + it.port)
          })
        ) : null,
        msg ? h('div', { className: 'dm-sub dm-public-msg' }, msg) : null,
        result && result.host ? h('div', { className: 'dm-public-res' },
          h('div', { className: 'dm-public-summary' },
            h('span', { className: 'dm-chip ' + (result.compatible ? 'ok' : 'bad') }, result.compatible ? '协议兼容' : '协议不匹配'),
            h('span', { className: 'dm-sub dm-mono' }, result.host + ':' + result.port)
          ),
          row('TCP', result.tcp && result.tcp.ok ? '可达 · ' + (result.tcp.latencyMs || 0) + 'ms' : (result.tcp && result.tcp.error || '不可达'), result.tcp && result.tcp.ok ? 'good' : 'bad'),
          row('TLS', result.tls && result.tls.ok ? '证书可读 · ' + (result.tls.fingerprint256 ? result.tls.fingerprint256.slice(0, 23) + '…' : '') : '未建立 TLS', result.tls && result.tls.ok ? 'good' : 'muted'),
          row('协议', proto && proto.ok ? ('dsh-mesh · v' + (proto.version || '?') + ' · ' + (proto.node || '?')) : (proto && proto.error || '未验证'), proto && proto.ok ? 'good' : 'bad'),
          proto && proto.ok ? row('通道', (proto.channel || '') + (proto.tls ? ' · TLS' : '') + (proto.pairing && proto.pairing.enabled ? ' · 允许配对' : '')) : null,
          sak ? h('div', { className: 'dm-public-sakura' },
            h('div', { className: 'dm-sub' }, sak.available ? ('樱花账号：' + sak.online + '/' + sak.total + ' 在线') : ('樱花账号不可用：' + (sak.error || '未知'))),
            sak.matches && sak.matches.length ? sak.matches.map(function (m, i) {
              return h('div', { className: 'dm-public-row', key: i }, h('span', { className: 'dm-public-k' }, '匹配'), h('span', { className: 'dm-public-v good' }, m.name + ' · ' + m.host + ':' + m.port + (m.up ? ' · 在线' : ' · 离线')))
            }) : h('div', { className: 'dm-sub' }, '没有匹配到本机樱花隧道入口；仍可按 IP/端口直连检测。')
          ) : null
        ) : null
      )
    }

    // 2026-11-11：公网连接（直连手填 / 樱花自动检测）——旧 PublicProbe 保留但不再挂载
    function PublicConnection(props) {
      // 2026-11-11：支持固定模式 —— 「公网连接」与「内网穿透（樱花穿透）」拆成两个栏目后，
      // 每个栏目只渲染自己那一半内容，不再用页签切换。
      var fixedMode = props && (props.mode === 'sakura' || props.mode === 'direct') ? props.mode : ''
      // 2026-11-11：AI 网络2 里拓扑会自动展示所有已发现通道，不再用“加入/移出拓扑”的手动视图开关
      var v2 = props && props.variant === 'v2'
      // 2026-11-12：拆分栏目后不能再共用一份本地缓存 —— 否则「内网穿透（樱花穿透）」里点检测
      // 保存的樱花地址会被「公网连接」读到并预填（用户明确不要默认值）。按栏目分 key，沙箱不预填。
      var savedKey = fixedMode ? ('dsh-mesh-ui.publicConnection.v2.' + fixedMode) : 'dsh-mesh-ui.publicConnection.v2'
      var saved = {}
      try { saved = JSON.parse(window.localStorage.getItem(savedKey) || '{}') || {} } catch (_) { saved = {} }
      var ms = useState(fixedMode || (saved.mode === 'sakura' ? 'sakura' : 'direct')); var mode = ms[0]; var setMode = ms[1]
      var hs = useState(fixedMode ? '' : (saved.host || '')); var host = hs[0]; var setHost = hs[1]
      var ps = useState(fixedMode ? '' : (saved.port || 8124)); var port = ps[0]; var setPort = ps[1]
      var rs = useState(null); var result = rs[0]; var setResult = rs[1]
      var bs = useState(false); var busy = bs[0]; var setBusy = bs[1]
      var msgs = useState(''); var msg = msgs[0]; var setMsg = msgs[1]
      var ss = useState(selectedSakuraServer()); var selectedServer = ss[0]; var setSelectedServer = ss[1]
      var pss = useState(selectedPublicServer()); var selectedPublic = pss[0]; var setSelectedPublic = pss[1]
      var sgs = useState(selectedSakuraServers()); var selectedGroups = sgs[0]; var setSelectedGroups = sgs[1]
      var vts = useState(null); var verifyTarget = vts[0]; var setVerifyTarget = vts[1]
      var vcs = useState(''); var verifyCode = vcs[0]; var setVerifyCode = vcs[1]

      useEffect(function () {
        if (!selectedGroups || !selectedGroups.length) return
        var group = sakuraServerGroups(tunnels.sakuraAccount)[0]
        if (group) discoverCandidates(group)
      }, [])

      var tunnels = (props.data && props.data.tunnels) || {}
      var meshPort = Number((props.data && props.data.endpoint && props.data.endpoint.port) || (props.data && props.data.localTunnel && props.data.localTunnel.port) || 8124)
      var sakuraEndpoints = []
      function addEndpoint(name, h, p, up, note, localPort) {
        h = String(h || ''); p = String(p || '')
        if (!h || !p) return
        var lp = Number(localPort) || null
        var meshName = /(dsh|mesh)/i.test(String(name || '') + ' ' + String(note || ''))
        var isMesh = lp ? (lp === meshPort || lp === 8124 || lp === 8126 || meshName) : meshName
        var found = sakuraEndpoints.filter(function (x) { return x.host === h && x.port === p })[0]
        if (found) {
          if (note && !found.note) found.note = note
          if (lp && !found.localPort) { found.localPort = lp; found.mesh = isMesh }
          return
        }
        sakuraEndpoints.push({ name: name || '樱花隧道', host: h, port: p, up: up === true, note: note || '', localPort: lp, mesh: isMesh })
      }
      // 优先读账号 API（含 note 备注、localPort 类型），再合并本机日志里的隧道
      ;(tunnels.sakuraAccount && tunnels.sakuraAccount.tunnels || []).forEach(function (t) {
        if (t.host && t.port) addEndpoint(t.name, t.host, t.port, t.online === true, t.note, t.localPort)
        else if (t.addr) { var m = /^([^:]+):(\d+)$/.exec(String(t.addr)); if (m) addEndpoint(t.name, m[1], m[2], t.online === true, t.note, t.localPort) }
      })
      ;(tunnels.sakura && tunnels.sakura.tunnels || []).forEach(function (t) { addEndpoint(t.name, t.host, t.port, t.probe && t.probe.up, t.note, t.localPort) })
      var sakuraServers = sakuraServerGroups(tunnels.sakuraAccount)
      function isGroupSelected(group) { return (selectedGroups || []).some(function (g) { return String(g.key) === String(group.key) }) }
      function discoverCandidates(group) {
        var mesh = (group && group.mesh) || []
        if (!mesh.length) { setSakuraCandidates([]); if (props.onChanged) props.onChanged(); return }
        var seed = mesh.filter(function (t) { return !isTunnelVerified(t) }).map(function (t) {
          var addr = tunnelAddr(t)
          return { key: addr, addr: addr, host: t.host, port: t.remotePort || t.port, name: t.note || t.name || addr, note: t.note || '', version: '', tunnel: t.name || '', probed: false }
        })
        setSakuraCandidates(seed)
        if (props.onChanged) props.onChanged()
        setBusy(true); setMsg('正在探测隧道另一端的 mesh 节点…')
        Promise.all(mesh.map(function (t) {
          return jsonFetch('/api/dsh-mesh/public/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: t.host, port: t.remotePort || t.port, sakura: true }) })
            .then(function (j) {
              if (!j || !j.compatible || !j.protocol || j.protocol.service !== 'dsh-mesh') return null
              var addr = tunnelAddr(t)
              return { key: addr, addr: addr, host: t.host, port: t.remotePort || t.port, name: j.protocol.node || t.note || t.name || addr, note: t.note || '', version: j.protocol.version || '', tunnel: t.name || '', probed: true }
            }).catch(function () { return null })
        })).then(function (rows) {
          var byKey = {}
          seed.forEach(function (c) { byKey[c.key] = c })
          rows.filter(Boolean).forEach(function (c) { byKey[c.key] = c })
          var list = Object.keys(byKey).map(function (k) { return byKey[k] })
          setSakuraCandidates(list)
          var pending = list.filter(function (c) { return !c.probed }).length
          setMsg(list.length ? ('已加入 ' + list.length + ' 个候选节点' + (pending ? '，' + pending + ' 个待探测' : '，待验证')) : '没有未验证的 mesh 候选节点')
          if (props.onChanged) props.onChanged()
        }).finally(function () { setBusy(false) })
      }
      function toggleGroup(group) {
        var was = isGroupSelected(group)
        var next = (selectedGroups || []).filter(function (g) { return String(g.key) !== String(group.key) })
        if (!was) next = next.concat([{ key: group.key, name: group.name, host: group.host, online: group.online, mesh: group.mesh, other: group.other, meshCount: group.meshCount, otherCount: group.otherCount }])
        setSelectedGroups(next)
        setSelectedSakuraServers(next)
        setMsg(was ? '已从拓扑移出服务器：' + group.name : '已加入拓扑服务器：' + group.name + '（' + group.meshCount + ' 条 mesh 隧道）')
        if (was) setSakuraCandidates([])
        if (!was) discoverCandidates(group)
        if (props.onChanged) props.onChanged()
      }
      function tunnelAddr(t) { return String(t.host || '') + ':' + String(t.remotePort || t.port || '') }
      function isTunnelVerified(t) {
        var addr = tunnelAddr(t)
        return ((props.data && props.data.peers) || []).some(function (p) {
          var u = String(p.url || '')
          var m = /^[a-z]+:\/\/([^/:]+):(\d+)/i.exec(u)
          if (m && (m[1] + ':' + m[2]) === addr) return true
          var pt = p.tunnel || {}
          return pt.host === t.host && String(pt.port) === String(t.remotePort || t.port || '')
        })
      }
      function startVerify(t) { setVerifyTarget(t); setVerifyCode(''); setMsg('') }
      function confirmVerify() {
        var t = verifyTarget
        var code = String(verifyCode || '').trim()
        if (!t) return
        if (!code) { setMsg('请输入对方生成的配对码'); return }
        setBusy(true); setMsg('正在读取对端证书指纹…')
        jsonFetch('/api/dsh-mesh/public/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: t.host, port: t.remotePort || t.port, sakura: true }) })
          .then(function (probe) {
            if (!probe || !probe.tls || !probe.tls.ok || !probe.tls.fingerprint256) {
              throw new Error('无法读取对端 TLS 证书指纹：' + String((probe && probe.tls && probe.tls.error) || (probe && probe.error) || 'TLS 未建立'))
            }
            setMsg('证书指纹已获取，正在配对…')
            return jsonFetch('/api/dsh-mesh/lan/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://' + tunnelAddr(t), code: code, name: t.note || t.name || t.host, fingerprint: probe.tls.fingerprint256 }) })
          })
          .then(function (j) {
            if (j && j.ok) {
              setMsg('已验证并加入节点：' + (t.name || tunnelAddr(t)))
              var addr = tunnelAddr(t)
              setSakuraCandidates(sakuraCandidates().filter(function (c) { return c.key !== addr }))
              setVerifyTarget(null); setVerifyCode('')
              if (props.onChanged) props.onChanged()
            } else if (j) setMsg(String(j.stderr || j.error || j.stdout || '验证失败').slice(0, 300))
          }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }

      function persist(nextMode, nextHost, nextPort) {
        try { window.localStorage.setItem(savedKey, JSON.stringify({ mode: nextMode, host: nextHost, port: nextPort })) } catch (_) {}
      }
      function runProbe(nextHost, nextPort, nextSakura) {
        var h = String(nextHost || '').trim(); var p = Number(nextPort)
        if (!h) { setMsg('请输入公网 IP 或域名'); return }
        if (!Number.isInteger(p) || p < 1 || p > 65535) { setMsg('端口必须是 1-65535'); return }
        setBusy(true); setMsg(''); setResult(null)
        jsonFetch('/api/dsh-mesh/public/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: h, port: p, sakura: nextSakura === true }) })
          .then(function (j) {
            // 校验/网络错误没有 host/port/tcp 结果，不能当成检测结果渲染
            if (!j || !j.host || !j.port) {
              setResult(null)
              setMsg(String((j && j.error) || '检测失败'))
              return
            }
            setResult(j)
            if (!j.ok && j.error) setMsg(String(j.error))
          })
          .catch(function (e) { setResult(null); setMsg(String(e.message || e)) })
          .finally(function () { setBusy(false) })
      }
      function switchMode(next) {
        setMode(next); setResult(null); setMsg(''); persist(next, host, port)
      }
      function autoSakura() {
        var online = sakuraEndpoints.filter(function (x) { return x.mesh !== false && x.up })[0] ||
          sakuraEndpoints.filter(function (x) { return x.mesh !== false })[0]
        if (!online) { setMsg('没有检测到 dsh-mesh 类型的樱花隧道（MC/其他服务不会被自动加入）'); return }
        setHost(online.host); setPort(online.port); persist(mode, online.host, online.port)
        runProbe(online.host, online.port, true)
      }
      function serverKey(it) { return String(it.host || '') + ':' + String(it.port || '') }      function isServerSelected(it) { return Boolean(selectedServer && serverKey(selectedServer) === serverKey(it)) }
      function isPublicSelected(it) { return Boolean(selectedPublic && serverKey(selectedPublic) === serverKey(it)) }
      function togglePublicServer(it) {
        if (!it || !it.host || !it.port) return
        var next = isPublicSelected(it) ? null : { name: it.name || it.host, note: it.note || '', host: it.host, port: it.port, up: it.up !== false }
        setSelectedPublic(next)
        setSelectedPublicServer(next)
        setMsg(next ? '已加入公网服务器：' + (next.note || next.name) : '已从拓扑移出公网服务器')
        if (props.onChanged) props.onChanged()
      }
      function toggleServer(it) {
        if (!it || !it.host || !it.port) return
        var next = isServerSelected(it) ? null : { name: it.name || it.host, note: it.note || '', host: it.host, port: it.port, up: it.up !== false }
        setSelectedServer(next)
        setSelectedSakuraServer(next)
        setMsg(next ? '已加入拓扑服务器：' + (next.note || next.name) : '已从拓扑移出服务器')
        if (props.onChanged) props.onChanged()
      }
      function resultSakuraGroup() {
        if (!result) return null
        var addr = String(result.host || '') + ':' + String(result.port || '')
        for (var i = 0; i < sakuraServers.length; i++) {
          var g = sakuraServers[i]
          for (var j = 0; j < (g.mesh || []).length; j++) {
            var t = g.mesh[j]
            if (String(t.addr || (t.host + ':' + t.remotePort)) === addr) return g
          }
        }
        return null
      }
      function isResultServerSelected() {
        if (mode === 'sakura') { var g = resultSakuraGroup(); return Boolean(g && isGroupSelected(g)) }
        return isPublicSelected(result)
      }
      function toggleResultServer() {
        if (!result || !result.compatible || !result.host) { setMsg('协议检测通过后才能加入拓扑'); return }
        if (mode === 'sakura') {
          var g = resultSakuraGroup()
          if (!g) { setMsg('这条隧道没有匹配到 Sakura 服务器分组'); return }
          toggleGroup(g)
          return
        }
        togglePublicServer({ name: (proto && proto.node) || result.host, note: result.sakura && result.sakura.matches && result.sakura.matches[0] ? (result.sakura.matches[0].note || result.sakura.matches[0].name) : '', host: result.host, port: result.port, up: true })
      }
      function row(k, v, tone) {
        if (v == null || v === '') return null
        return h('div', { className: 'dm-public-row' }, h('span', { className: 'dm-public-k' }, k), h('span', { className: 'dm-public-v ' + (tone || '') }, String(v)))
      }
      var proto = result && result.protocol
      var sak = result && result.sakura
      // 公网直连：列出当前已有的公网入口（本机 + 已配对 peer），而不是只让用户盲填
      var directEndpoints = []
      function addDirect(source, h, p, up, kind) {
        h = String(h || ''); p = String(p || '')
        if (!h || !p) return
        if (directEndpoints.some(function (x) { return x.host === h && x.port === p })) return
        directEndpoints.push({ source: source || '入口', host: h, port: p, up: up === true, kind: kind || '' })
      }
      var lt = (props.data && props.data.localTunnel) || {}
      // 2026-11-12：localTunnel 里公网入口在 selfHosted（host/port），顶层 host/port 可能不存在，
      // 否则「本机」这一条公网入口会从列表里消失（用户反馈peer-x公网连接没了）。
      var selfT = lt.selfHosted || {}
      var selfEntry = (lt.host && lt.port)
        ? { host: lt.host, port: lt.port, up: Boolean(lt.probe && lt.probe.up) || Boolean(lt.host) }
        : (selfT.host && selfT.port ? { host: selfT.host, port: selfT.port, up: Boolean(selfT.probe && selfT.probe.up) || Boolean(selfT.host) } : null)
      if (selfEntry) addDirect('本机', selfEntry.host, selfEntry.port, selfEntry.up, selfT.kind || lt.kind || '')
      ;((props.data && props.data.peers) || []).forEach(function (p) {
        if (isLanPeer(p)) return
        var t = p.tunnel || {}
        if (!t.host || !t.port) return
        if (t.kind !== 'frp' && t.kind !== 'wan') return
        addDirect(nodeDisplay(peerDeviceKey(p.name)), t.host, t.port, Boolean(p.up || (t.probe && t.probe.up)), t.kind)
      })
      return h('div', { className: 'dm-public' },
        fixedMode ? null : h('div', { className: 'dm-pub-tabs' },
          h('button', { className: 'dm-pub-tab' + (mode === 'direct' ? ' active' : ''), onClick: function () { switchMode('direct') } }, '公网直连'),
          h('button', { className: 'dm-pub-tab' + (mode === 'sakura' ? ' active' : ''), onClick: function () { switchMode('sakura') } }, '樱花穿透')
        ),
        mode === 'direct'
          ? h('div', null,
            h('div', { className: 'dm-sub' }, '当前已存在的公网入口。可直接检测已有地址，也可以在下面手动输入新的 IP/端口。'),
            directEndpoints.length ? h('table', { className: 'dm-lan-table' },
              h('thead', null, h('tr', null, h('th', null, '来源'), h('th', null, '公网地址'), h('th', null, '状态'), h('th', null, '操作'))),
              h('tbody', null, directEndpoints.map(function (it, i) {
                return h('tr', { key: i },
                  h('td', { title: it.source }, it.source),
                  h('td', { className: 'dm-mono' }, it.host + ':' + it.port),
                  h('td', null, h('span', { className: 'dm-chip ' + (it.up ? 'ok' : 'muted') }, it.up ? '在线' : '未探测')),
                  h('td', { className: 'dm-lan-actions' },
                    h('button', { className: 'dm-btn', disabled: busy, onClick: function () { setHost(it.host); setPort(it.port); persist(mode, it.host, it.port); runProbe(it.host, it.port, false) } }, '检测'),
                    v2 ? null : h('button', { className: 'dm-btn' + (isPublicSelected(it) ? ' bad' : ''), disabled: busy, onClick: function () { togglePublicServer(it) } }, isPublicSelected(it) ? '移出拓扑' : '加入拓扑')
                  )
                )
              }))
            ) : h('div', { className: 'dm-empty' }, '当前没有已配对的公网入口，可在下面手动输入。'),
            v2 ? h('div', { className: 'dm-sub', style: { marginTop: 6 } }, '拓扑图会自动显示所有已发现的公网通道（设备卡片下方的信息卡可看地址）；这里只做检测，不需要手动加入/移出。') : null,
            h('div', { className: 'dm-sub', style: { marginTop: 8 } }, '手动输入公网地址：'),
            h('div', { className: 'dm-public-form' },
              h('input', { type: 'text', value: host, placeholder: '公网 IP 或域名', spellCheck: false, onChange: function (e) { setHost(e.target.value) } }),
              h('input', { type: 'number', min: 1, max: 65535, value: port, placeholder: '端口', onChange: function (e) { setPort(e.target.value) } }),
              h('button', { className: 'dm-btn primary', disabled: busy, onClick: function () { persist(mode, host, port); runProbe(host, port, false) } }, busy ? '检测中…' : '检测')
            )
          )
          : h('div', null,
            h('div', { className: 'dm-sub' }, 'Sakura 是软件，下面是它提供的公网服务器；只有本地端口指向 mesh 的隧道才会进入网络，其他隧道只做详情。'),
            sakuraServers.length ? h('div', { className: 'dm-sakura-server-bar' },
              h('span', { className: 'dm-dot ' + (sakuraServers[0].online ? 'ok' : 'muted') }),
              h('span', { className: 'dm-sakura-server-name' }, sakuraServers[0].name),
              h('span', { className: 'dm-sub dm-mono' }, sakuraServers[0].host || '—'),
              h('span', { className: 'dm-sub' }, sakuraServers[0].meshCount + ' mesh / ' + sakuraServers[0].otherCount + ' 其他'),
              v2 ? null : h('button', { className: 'dm-btn' + (isGroupSelected(sakuraServers[0]) ? ' bad' : ''), disabled: busy, onClick: function () { toggleGroup(sakuraServers[0]) } }, isGroupSelected(sakuraServers[0]) ? '移出拓扑' : '加入拓扑')
            ) : h('div', { className: 'dm-empty' }, '未读取到 Sakura 服务器。'),
            v2 ? h('div', { className: 'dm-sub', style: { marginTop: 6 } }, '拓扑图会自动显示所有已发现的樱花通道；这里只做检测/验证，不需要手动加入/移出。') : null,
            sakuraEndpoints.length ? h('table', { className: 'dm-lan-table dm-sakura-table' },
              h('thead', null, h('tr', null, h('th', null, '隧道'), h('th', null, '备注'), h('th', null, '地址'), h('th', null, '本地端口'), h('th', null, '状态'), h('th', null, '操作'))),
              h('tbody', null, sakuraEndpoints.map(function (it, i) {
                var target = { host: it.host, port: it.port, remotePort: it.port, name: it.name, note: it.note, localPort: it.localPort, mesh: it.mesh }
                var verified = isTunnelVerified(target)
                return h('tr', { key: i },
                  h('td', { title: it.name }, it.name),
                  h('td', { className: 'dm-sakura-note', title: it.note || '' }, it.note || '—'),
                  h('td', { className: 'dm-mono' }, it.host + ':' + it.port),
                  h('td', { className: 'dm-mono' }, it.localPort || '—'),
                  h('td', null, h('span', { className: 'dm-chip ' + (it.up ? 'ok' : 'muted') }, it.up ? '在线' : '未探测'), it.mesh === false ? h('span', { className: 'dm-chip bad', style: { marginLeft: 4 } }, '非 mesh') : null),
                  h('td', { className: 'dm-lan-actions' },
                    h('button', { className: 'dm-btn', disabled: busy, onClick: function () { setHost(it.host); setPort(it.port); persist(mode, it.host, it.port); runProbe(it.host, it.port, true) } }, '检测'),
                    it.mesh === false ? null : (verified ? h('span', { className: 'dm-chip ok' }, '已验证') : h('button', { className: 'dm-btn', disabled: busy, onClick: function () { startVerify(target) } }, '验证'))
                  )
                )
              }))
            ) : h('div', { className: 'dm-empty' }, '本机没有配置樱花隧道。'),
            verifyTarget ? h('div', { className: 'dm-verify-form' },
              h('div', { className: 'dm-sub' }, '验证节点：' + (verifyTarget.name || tunnelAddr(verifyTarget)) + ' · 输入对方生成的一次性配对码'),
              h('div', { className: 'dm-public-form' },
                h('input', { type: 'text', value: verifyCode, placeholder: '一次性配对码', onChange: function (e) { setVerifyCode(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') confirmVerify() } }),
                h('button', { className: 'dm-btn primary', disabled: busy, onClick: confirmVerify }, '验证并加入'),
                h('button', { className: 'dm-btn', disabled: busy, onClick: function () { setVerifyTarget(null); setVerifyCode('') } }, '取消')
              )
            ) : null,
          ),
        msg ? h('div', { className: 'dm-sub dm-public-msg' }, msg) : null,
        result && result.host ? h('div', { className: 'dm-public-res' },
          h('div', { className: 'dm-public-summary' },
            h('span', { className: 'dm-chip ' + (result.compatible ? 'ok' : 'bad') }, result.compatible ? '协议兼容' : '协议不匹配'),
            h('span', { className: 'dm-sub dm-mono' }, result.host + ':' + result.port)
          ),
          row('TCP', result.tcp && result.tcp.ok ? '可达 · ' + (result.tcp.latencyMs || 0) + 'ms' : (result.tcp && result.tcp.error || '不可达'), result.tcp && result.tcp.ok ? 'good' : 'bad'),
          row('TLS', result.tls && result.tls.ok ? '证书可读 · ' + (result.tls.fingerprint256 ? result.tls.fingerprint256.slice(0, 23) + '…' : '') : '未建立 TLS', result.tls && result.tls.ok ? 'good' : 'muted'),
          row('协议', proto && proto.ok ? ('dsh-mesh · v' + (proto.version || '?') + ' · ' + (proto.node || '?')) : (proto && proto.error || '未验证'), proto && proto.ok ? 'good' : 'bad'),
          proto && proto.ok ? row('通道', (proto.channel || '') + (proto.tls ? ' · TLS' : '') + (proto.pairing && proto.pairing.enabled ? ' · 允许配对' : '')) : null,
          sak ? h('div', { className: 'dm-public-sakura' },
            h('div', { className: 'dm-sub' }, sak.available ? ('樱花账号：' + sak.online + '/' + sak.total + ' 在线') : ('樱花账号不可用：' + (sak.error || '未知'))),
            sak.matches && sak.matches.length ? sak.matches.map(function (m, i) {
              return h('div', { className: 'dm-public-row', key: i }, h('span', { className: 'dm-public-k' }, '匹配'), h('span', { className: 'dm-public-v good' }, m.name + ' · ' + m.host + ':' + m.port + (m.up ? ' · 在线' : ' · 离线')))
            }) : null
          , (result.compatible && !v2) ? h('div', { className: 'dm-join' },
            h('div', { className: 'dm-sub' }, '检测通过。这是服务器入口，不是新设备；加入拓扑不需要配对码。'),
            h('div', { className: 'dm-public-form' },
              h('button', { className: 'dm-btn primary', disabled: busy, onClick: toggleResultServer },
                isResultServerSelected() ? '移出拓扑' : '加入拓扑服务器')
            )
          ) : null
          ) : null
        ) : null
      )
    }

    // 2026-11-11：权限设置（节点 ACL；允许/禁止对端调用本机工具）
    function PermissionsPanel(props) {
      var ts = useState(null); var tools = ts[0]; var setTools = ts[1]
      var bs = useState(false); var busy = bs[0]; var setBusy = bs[1]
      var ms = useState(''); var msg = ms[0]; var setMsg = ms[1]
      var qs = useState(''); var query = qs[0]; var setQuery = qs[1]
      function load() {
        setBusy(true); setMsg('')
        jsonFetch('/api/dsh-mesh/permissions').then(function (j) {
          if (j.ok) setTools(j.tools || [])
          else {
            setTools([])
            setMsg(String(j.error || '读取权限失败') === 'not found'
              ? '当前 DSH 实例的服务端插件还是旧版，没有权限接口；重启该实例后可用。'
              : (j.error || '读取权限失败'))
          }
        }).catch(function (e) { setTools([]); setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      useEffect(function () { load() }, [])
      function toggle(tool) {
        var next = !tool.allowed
        setBusy(true); setMsg('')
        jsonFetch('/api/dsh-mesh/permissions/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: tool.name, allowed: next }) })
          .then(function (j) {
            if (j.ok) { setTools(function (prev) { return (prev || []).map(function (x) { return x.name === tool.name ? Object.assign({}, x, { allowed: next }) : x }) }); setMsg((next ? '已允许 ' : '已禁止 ') + tool.name) }
            else setMsg(String(j.error || j.stderr || '更新失败').slice(0, 300))
          }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      var filtered = (tools || []).filter(function (t) { return !query || (t.name + ' ' + (t.descriptionZh || '') + ' ' + t.description).toLowerCase().indexOf(query.toLowerCase()) >= 0 })
      return h('div', { className: 'dm-perm' },
        h('div', { className: 'dm-sub' }, '控制对端可以通过 AI 网络调用本机的哪些工具。禁止后对端立即失去权限；这只改本机 ACL，不会同步到其他设备。'),
        h('div', { className: 'dm-lan-row' },
          h('button', { className: 'dm-btn', disabled: busy, onClick: load }, busy ? '读取中…' : '刷新'),
          h('input', { className: 'dm-perm-search', type: 'text', placeholder: '搜索工具名/说明', value: query, onChange: function (e) { setQuery(e.target.value) } }),
          h('span', { className: 'dm-sub' }, (tools || []).length + ' 个工具')
        ),
        msg ? h('div', { className: 'dm-sub dm-public-msg' }, msg) : null,
        tools === null ? h('div', { className: 'dm-sub' }, '加载中…') : h('div', { className: 'dm-table-wrap' }, h('table', { className: 'dm-data-table' },
          h('colgroup', null,
            h('col', { style: { width: '44px' } }),
            h('col', { style: { width: '190px' } }),
            h('col', null),
            h('col', { style: { width: '64px' } })
          ),
          h('thead', null, h('tr', null, h('th', null, '启用'), h('th', null, '工具名'), h('th', null, '说明'), h('th', null, '状态'))),
          h('tbody', null, filtered.map(function (t) {
            return h('tr', { key: t.name },
              h('td', null, h('input', { type: 'checkbox', checked: t.allowed, disabled: busy, onChange: function () { toggle(t) } })),
              h('td', { className: 'dm-mono', title: t.name }, t.name),
              h('td', { className: 'dm-sub', title: t.description }, t.descriptionZh || t.description),
              h('td', null, h('span', { className: 'dm-chip ' + (t.allowed ? 'ok' : 'muted') }, t.allowed ? '允许' : '禁止'))
            )
          }))
        ))
      )
    }

    // 2026-11-11：面板管理（用户决定右侧显示哪些面板）
    function PanelManager(props) {
      return h('div', { className: 'dm-panels' },
        h('div', { className: 'dm-sub' }, '勾选要显示的面板；设置会保存在本机。'),
        props.items.map(function (item) {
          return h('label', { className: 'dm-panel-toggle', key: item.id },
            h('input', { type: 'checkbox', checked: !props.hidden[item.id], onChange: function () { props.onToggle(item.id) } }),
            h('span', null, item.label)
          )
        })
      )
    }

    // 2026-11-11：AI 网络使用说明（用户视角，纯文本）
    function UsageHelpV2(props) {
      return h('div', { className: 'dm-usage' },
        h('p', null, '这个页面显示当前 AI 网络里有哪些设备、它们是否在线，以及各条链路的状态。'),
        h('p', null, '局域网连接：先扫描，确认对方是你认识的设备，再输入对方生成的一次性配对码。扫描本身不会自动连接。'),
        h('p', null, '公网连接：如果对方有公网 IP 或端口映射，直接填地址和端口检测；如果走樱花穿透，在隧道表格里逐条点“检测”。'),
        h('p', null, '节点管理和权限设置只影响本机；多设备同步目前还没有做，移除节点后不会自动通知其他设备。'),
        h('p', null, '拓扑图和设备卡片用来查看状态；右侧面板可以按需展开或隐藏，不影响真实链路。')
      )
    }

    // 2026-11-11：AI 网络使用说明 / 可复制提示词
    function UsageHelp(props) {
      return h('div', { className: 'dm-usage' },
        h('div', { className: 'dm-sub' }, '这里主要看网络状态；具体操作可以直接让 AI 执行，不需要手动记命令。'),
        h('div', { className: 'dm-usage-row' }, h('span', { className: 'dm-dot ok' }), h('span', null, '绿色：在线；黄色：节点在线但 host bridge 未连接；红色：离线')),
        h('div', { className: 'dm-usage-row' }, h('span', { className: 'dm-dot warn' }), h('span', null, '局域网配对仍需对方的一次性配对码，不会自动连接')),
        h('button', { className: 'dm-btn primary', style: { marginTop: 6 }, onClick: props.onOpen }, '查看可以让 AI 做什么')
      )
    }

    function HelpSheet(props) {
      var cp = useState(''); var copied = cp[0]; var setCopied = cp[1]
      var prompts = [
        ['检查网络', '检查当前 AI 网络状态，列出离线节点、host bridge 未连接原因和可执行的修复建议。'],
        ['委托任务', '委托peer-x检查当前定时任务和日志，汇总异常后汇报，不要重启 3081。'],
        ['传文件', '把本机文件传到peer-x指定目录，分块传输，传完用 sha256 校验并告诉我结果。'],
        ['局域网', '扫描局域网节点，自动检查链路；如果我要配对，先让我生成/输入一次性配对码。'],
        ['更新节点', '把peer-x的 dsh-mesh 插件更新到最新版本，更新前备份，完成后验证三实例和定时任务。']
      ]
      function copy(text) {
        try { navigator.clipboard && navigator.clipboard.writeText(text) } catch (_) {}
        setCopied(text); setTimeout(function () { setCopied('') }, 1500)
      }
      return h('div', { className: 'dm-help-overlay', onClick: props.onClose },
        h('div', { className: 'dm-help-card', onClick: function (e) { e.stopPropagation() } },
          h('div', { className: 'dm-help-head' },
            h('span', { className: 'dm-help-title' }, 'AI 网络 · 使用说明'),
            h('button', { className: 'dm-btn', onClick: props.onClose }, '关闭')
          ),
          h('div', { className: 'dm-help-section' },
            h('div', { className: 'dm-help-h' }, '可以直接让 AI 做的事'),
            h('div', { className: 'dm-sub' }, '下面只是示例；实际直接把目标/路径/节点说清楚即可。')
          ),
          prompts.map(function (p, i) {
            return h('div', { className: 'dm-help-prompt', key: i },
              h('div', { className: 'dm-help-prompt-head' }, h('b', null, p[0]), h('button', { className: 'dm-btn', onClick: function () { copy(p[1]) } }, copied === p[1] ? '已复制' : '复制')),
              h('div', { className: 'dm-sub' }, p[1])
            )
          }),
          h('div', { className: 'dm-help-section' },
            h('div', { className: 'dm-help-h' }, '边界'),
            h('div', { className: 'dm-sub' }, '跨机写入默认受限；文件写入需要目标节点 ACL 允许。配对码不要发给不可信节点；关闭公网地址只影响显示，不改变实际链路。')
          )
        )
      )
    }

    function TransferHistory() {
      var s = useState(null); var items = s[0]; var setItems = s[1]
      var b = useState(false); var busy = b[0]; var setBusy = b[1]
      var m = useState(''); var msg = m[0]; var setMsg = m[1]
      var sc = useState('local'); var scope = sc[0]; var setScope = sc[1]
      var nd = useState([]); var nodesInfo = nd[0]; var setNodesInfo = nd[1]
      var mt = useState(null); var meta = mt[0]; var setMeta = mt[1]
      function refresh(nextScope) {
        var target = nextScope || scope
        setBusy(true); setMsg('')
        jsonFetch('/api/dsh-mesh/transfers' + (target === 'all' ? '?scope=all' : '')).then(function (j) {
          if (j.ok) {
            setItems(j.items || []); setNodesInfo(j.nodes || [])
            setMeta({ at: j.generatedAt || null, cached: Boolean(j.cached), stale: Boolean(j.stale), cacheAgeMs: Number(j.cacheAgeMs) || 0 })
          } else setMsg(j.error || '读取传输历史失败')
        }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      useEffect(function () { refresh(scope) }, [scope])
      function fmtBytes(n) { n = Number(n) || 0; if (n < 1024) return n + ' B'; if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'; if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'; return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB' }
      function deviceLabel(raw) {
        var v = String(raw || '').trim()
        if (!v) return ''
        // 记录里的 node 可能是 peer 名（如 home-lan、peer-node-fvn3）：逐段截断映射回设备名
        var parts = v.split('-')
        for (var i = parts.length; i >= 1; i--) {
          var key = parts.slice(0, i).join('-').toLowerCase()
          var disp = nodeDisplay(peerDeviceKey(key))
          if (disp && String(disp).toLowerCase() !== key) return disp
        }
        return v
      }
      // read = 该记录所在节点把文件发出去（被对端读取）；write = 该节点接收（对端写入）。
      // 记录里的 peer 字段是 mesh 侧对端标识（可能是带随机后缀的 peer 名），统一显示「对端」并在 title 里保留原始值。
      function parties(it) {
        var selfName = it.node && it.node !== '本机' ? deviceLabel(it.node) : '本机'
        if (it.direction === 'write') return { from: '对端', to: selfName, fromRaw: it.peer || '', toRaw: '' }
        return { from: selfName, to: '对端', fromRaw: '', toRaw: it.peer || '' }
      }
      var shown = items || []
      return h('div', { className: 'dm-transfers' },
        h('div', { className: 'dm-lan-row' },
          h('button', { className: 'dm-btn' + (scope === 'local' ? ' primary' : ''), disabled: busy, onClick: function () { setScope('local') } }, '本机记录'),
          h('button', { className: 'dm-btn' + (scope === 'all' ? ' primary' : ''), disabled: busy, onClick: function () { setScope('all') } }, '全网记录'),
          h('button', { className: 'dm-btn', disabled: busy, onClick: function () { refresh() } }, busy ? '读取中…' : '刷新')
        ),
        h('div', { className: 'dm-sub', style: { marginTop: 4 } }, scope === 'all'
          ? '汇总各节点的本机记录（按节点存储；12s 内重复切换走缓存，结果自动落盘 ~/.dsh-mesh/transfers-aggregate.json）'
          : '只统计本机经 file_read_chunk / file_write_chunk 完成的传输；跨机传输记录在对方节点，可切「全网记录」查看'),
        nodesInfo && nodesInfo.length ? h('div', { className: 'dm-mini', style: { marginTop: 6 } },
          nodesInfo.map(function (n, i) {
            var label = n.node === '本机' ? '本机' : deviceLabel(n.node)
            return h('span', { key: i, className: 'dm-chip ' + (n.ok ? 'muted' : 'bad'), title: n.error || '' }, label + ' · ' + (n.ok ? n.count + ' 条' : '未获取'))
          })
        ) : null,
        meta ? h('div', { className: 'dm-sub', style: { marginTop: 4 } },
          (meta.cached ? '缓存' + (meta.cacheAgeMs ? '（' + Math.round(meta.cacheAgeMs / 1000) + 's 前）' : '') : '实时读取')
          + (meta.at ? ' · 数据时间 ' + new Date(meta.at).toLocaleTimeString() : '')
          + (meta.stale ? ' · 对端不可达，显示上次落盘快照' : '')) : null,
        msg ? h('div', { className: 'dm-sub', style: { marginTop: 6 } }, msg) : null,
        items === null ? h('div', { className: 'dm-sub' }, '加载中…') :
          shown.length ? h('div', { className: 'dm-table-wrap' }, h('table', { className: 'dm-data-table' },
            h('colgroup', null,
              scope === 'all' ? h('col', { style: { width: '96px' } }) : null,
              h('col', { style: { width: '58px' } }),
              h('col', { style: { width: '104px' } }),
              h('col', { style: { width: '104px' } }),
              h('col', { style: { width: '15%' } }),
              h('col', null),
              h('col', { style: { width: '86px' } }),
              h('col', { style: { width: '92px' } })
            ),
            h('thead', null, h('tr', null,
              scope === 'all' ? h('th', null, '节点') : null,
              h('th', null, '方向'), h('th', null, '发出方'), h('th', null, '接收方'), h('th', null, '文件'), h('th', null, '路径'), h('th', null, '大小'), h('th', null, '时间')
            )),
            h('tbody', null, shown.map(function (it, i) {
              var fileName = String(it.path || '').split(/[\\/]/).pop() || '?'
              var p = parties(it)
              var dirLabel = it.direction === 'write' ? '接收' : '发出'
              return h('tr', { key: i },
                scope === 'all' ? h('td', { title: String(it.node || '') }, it.node === '本机' ? '本机' : deviceLabel(it.node)) : null,
                h('td', null, h('span', { className: 'dm-chip ' + (it.direction === 'write' ? 'run' : 'muted') }, dirLabel)),
                h('td', { title: p.fromRaw || p.from }, p.from),
                h('td', { title: p.toRaw || p.to }, p.to),
                h('td', { title: fileName }, fileName),
                h('td', { className: 'dm-mono', title: it.path || '' }, it.path || '—'),
                h('td', null, fmtBytes(it.bytes) + (it.totalBytes && it.totalBytes !== it.bytes ? ' / ' + fmtBytes(it.totalBytes) : '')),
                h('td', { className: 'dm-mono', title: it.at || '' }, it.at ? new Date(it.at).toLocaleString() : '')
              )
            }))
          )) : h('div', { className: 'dm-sub' }, scope === 'all'
            ? '全网暂无可显示的传输记录（各节点本机记录为空，或离线未获取）'
            : '本机还没有传输记录。传输历史按节点记录——从对端拉取文件时，读取记录写在「对方节点」，可切到「全网记录」查看。')
      )
    }

    // 2026-11-10：局域网首次接入（扫描 / 生成配对码 / 配对）。
    function LanOnboarding(props) {
      var sNodes = useState(null); var nodes = sNodes[0]; var setNodes = sNodes[1]
      var sBusy = useState(false); var busy = sBusy[0]; var setBusy = sBusy[1]
      var sMsg = useState(''); var msg = sMsg[0]; var setMsg = sMsg[1]
      var sCode = useState(''); var code = sCode[0]; var setCode = sCode[1]
      var sMine = useState(null); var mine = sMine[0]; var setMine = sMine[1]
      var sStatus = useState({}); var statuses = sStatus[0]; var setStatuses = sStatus[1]
      // 2026-11-11：扫描结果里标清楚哪些节点是「本机」（地址 = 本机局域网地址）
      var sAddr = useState(''); var localAddr = sAddr[0]; var setLocalAddr = sAddr[1]

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
          setLocalAddr(j.localAddress || '')
          setStatuses({})
          setMsg((j.nodes || []).length ? '发现 ' + j.nodes.length + ' 个节点，正在自动检查链路…' : '没有发现局域网节点（对方需 bind 0.0.0.0 并放行 8124）')
          ;(j.nodes || []).forEach(function (node, idx) {
            lanJson('/api/dsh-mesh/lan/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: String(node.url || '') }) })
              .then(function (r) { setStatuses(function (prev) { var n = Object.assign({}, prev); n[idx] = r.ok ? 'ok' : 'bad'; return n }); if (r.ok) setMsg('发现 ' + (j.nodes || []).length + ' 个节点 · 链路正常 ' + (node.node || '')) })
              .catch(function () { setStatuses(function (prev) { var n = Object.assign({}, prev); n[idx] = 'bad'; return n }) })
          })
        }).catch(function (e) { setMsg(String(e.message || e)) }).finally(function () { setBusy(false) })
      }
      useEffect(function () { scan() }, [])
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
            setMsg(j.ok ? '配对成功：' + (node.node || '') + '，正在复查链路…' : ('配对失败：' + (j.stderr || j.error || j.stdout || '').slice(0, 300)))
            if (j.ok) setTimeout(function () { checkNode(node); scan(); if (props.onChanged) props.onChanged() }, 900)
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
        nodes && nodes.length ? h('table', { className: 'dm-lan-table' },
          h('thead', null, h('tr', null, h('th', null, '状态'), h('th', null, '节点'), h('th', null, '地址'), h('th', null, '操作'))),
          h('tbody', null, nodes.map(function (node, i) {
            var isLocalNode = Boolean(localAddr) && String(node.address || node.hostname || '') === String(localAddr)
            return h('tr', { key: i },
              h('td', null, h('span', { className: 'dm-dot ' + (statuses[i] === 'ok' ? 'ok' : statuses[i] === 'bad' ? 'bad' : 'muted'), title: statuses[i] === 'ok' ? '链路可达' : statuses[i] === 'bad' ? '链路不可达' : '检查中' })),
              h('td', { title: String(node.node || '?') },
                h('span', null, node.node || '?'),
                isLocalNode ? h('span', { className: 'dm-chip ok', style: { marginLeft: 6 } }, '本机') : null
              ),
              h('td', { className: 'dm-mono', title: String(node.url || '') }, lanScanAddr(node)),
              h('td', { className: 'dm-lan-actions' },
                h('button', { className: 'dm-btn', disabled: busy, onClick: function () { checkNode(node) } }, '检查链路'),
                h('button', { className: 'dm-btn primary', disabled: busy || !String(code || '').trim() || isLocalNode, title: isLocalNode ? '这是本机节点，不需要配对' : '', onClick: function () { pairWith(node) } }, isLocalNode ? '本机无需配对' : '用此节点配对')
              )
            )
          }))
        ) : null,
        nodes && nodes.length ? h('div', { className: 'dm-lan-row' },
          h('input', { placeholder: '输入对方显示的配对码', value: code, style: { flex: '1 1 320px', minWidth: '260px', maxWidth: '520px' }, onChange: function (e) { setCode(e.target.value) } })
        ) : null
      )
    }

    function MeshStatusSection(props) {
      // 2026-11-11：页面变体。'legacy' = 默认「AI 网络」（保持原样）；'v2' = 独立沙箱「AI 网络2」。
      var variant = (props && props.variant) || 'legacy'
      void variant
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
      var s5 = useState('local'); var selectedKey = s5[0]; var setSelectedKey = s5[1]
      var topoState = useState(0); var topoNonce = topoState[0]; var setTopoNonce = topoState[1]
      // 2026-11-11：局域网扫描结果做本地缓存，并在页面挂载时立刻扫描（不等 status 快照），
      // 避免「局域网那条线慢半拍」——首屏直接用上次缓存画 LAN 通道，后台扫描刷新。
      var LAN_CACHE_KEY = 'dsh-mesh-ui.lanScan.v1'
      var lanState = useState(function () {
        try {
          var saved = JSON.parse(window.localStorage.getItem(LAN_CACHE_KEY) || 'null')
          return saved && Array.isArray(saved.nodes) ? saved.nodes : []
        } catch (e) { return [] }
      })
      var lanNodes = lanState[0]
      var setLanNodes = lanState[1]
      var lanAtRef = useRef(0)
      function topologyChanged() {
        setTopoNonce(function (n) { return n + 1 })
        load(false)
      }
      useEffect(function () { reconcileMeshUiState(data) }, [data])
      useEffect(function () {
        if (!data || !data.at) return
        jsonFetch('/api/dsh-mesh/peers').then(function (r) {
          if (!r || !r.ok) return
          setDisabledPeerNames((r.peers || []).filter(function (p) { return p.disabled === true }).map(function (p) { return p.name || p.id }))
          setTopoNonce(function (n) { return n + 1 })
        }).catch(function () { /* best effort */ })
      }, [data && data.at])
      function scanLanNodes() {
        var now = Date.now()
        if (now - lanAtRef.current < 15000) return
        lanAtRef.current = now
        jsonFetch('/api/dsh-mesh/lan/scan').then(function (r) {
          if (r && r.ok) {
            setLanNodes(r.nodes || [])
            setTopoNonce(function (n) { return n + 1 })
            try { window.localStorage.setItem(LAN_CACHE_KEY, JSON.stringify({ at: Date.now(), nodes: r.nodes || [] })) } catch (e) { /* ignore */ }
          }
        }).catch(function () { /* best effort */ })
      }
      // 挂载即扫描：不依赖 status 快照，配合本地缓存让 LAN 线第一帧就在
      useEffect(function () { scanLanNodes() }, [])
      useEffect(function () {
        if (!data || !data.at) return
        scanLanNodes()
      }, [data && data.at])
      var panelState = useState(function () {
        try { return JSON.parse(window.localStorage.getItem('dsh-mesh-ui.panels.v1') || '{}') || {} } catch (error) { return {} }
      })
      var hiddenPanels = panelState[0]; var setHiddenPanels = panelState[1]
      var PANEL_ITEMS = [
        { id: 'usage', label: '使用说明' }, { id: 'lan', label: '局域网连接' }, { id: 'public', label: '公网连接' },
        { id: 'nodes', label: '节点管理' }, { id: 'permissions', label: '权限设置' }, { id: 'transfers', label: '文件传输' },
        { id: 'instances', label: '本机实例' }, { id: 'versions', label: '版本一致性' }, { id: 'delegations', label: '委托台账' },
        { id: 'alerts', label: '告警历史' }, { id: 'diagnostics', label: '诊断建议' }
      ]
      // 2026-11-11（沙箱 AI 网络2）：把「公网连接」和「内网穿透（樱花穿透）」拆成两个栏目
      if (variant === 'v2') {
        PANEL_ITEMS = PANEL_ITEMS.slice(0, 3)
          .concat([{ id: 'sakuraTunnel', label: '内网穿透（樱花穿透）' }])
          .concat(PANEL_ITEMS.slice(3))
      }
      function togglePanel(id) {
        setHiddenPanels(function (prev) {
          var next = Object.assign({}, prev);
          next[id] = !next[id];
          try { window.localStorage.setItem('dsh-mesh-ui.panels.v1', JSON.stringify(next)) } catch (error) { /* ignore */ }
          return next
        })
      }
      var sHelp = useState(false); var helpOpen = sHelp[0]; var setHelpOpen = sHelp[1]
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
        st.busy = true
        st.at = now
        setLoading(true)
        // 2026-11-12：采集中只由按钮文案提示，别再往 refreshHint 也写「采集中…」，否则会同时出现两个采集中
        setRefreshHint("")
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
        return function () { clearInterval(timer) }      }, [])

      useEffect(function () { if (tick > 0 && !forceRef.current.busy) load(false) }, [tick])
      useEffect(function () {
        if (!data) return
        var now = Date.now()
        if (now - federatedRef.current.at < 60000) return
        federatedRef.current.at = now
        fetch('/api/dsh-mesh/federated').then(function (r) { return r.text() }).then(function (text) { try { setFederated(JSON.parse(text)) } catch (error) {} }).catch(function () {})
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

        h('div', { className: 'dm-body', style: splitW > 0 ? { '--dm-main-w': splitW + 'px' } : undefined },
          h('div', { className: 'dm-pane' },
            h(Viewport, { data: data, federated: federated, topoNonce: topoNonce, lanNodes: lanNodes, variant: variant, layout: computeLayout(1 + filterSelfPeers(dedupePeers(data.peers || []), data.nodeName).length + (variant === 'v2' ? 0 : visibleSakuraCandidates().length)), selectedKey: selectedKey, onSelect: setSelectedKey }),
            h(DeviceDetails, { data: data, selectedKey: selectedKey })
          ),
          h('div', { className: 'dm-divider', onPointerDown: startSplit, title: '↔ 拖拽调整左右宽度（双击恢复默认）', onDoubleClick: function () { setSplitW(0); try { window.localStorage.removeItem('dsh-mesh-split-w') } catch (error) { /* ignore */ } } }),
          h('div', { className: 'dm-pane' },
            h(Details, { title: '面板管理', badge: '显示 / 隐藏' }, h(PanelManager, { items: PANEL_ITEMS, hidden: hiddenPanels, onToggle: togglePanel })),
            !hiddenPanels.usage ? h(Details, { title: '使用说明' }, h(UsageHelpV2)) : null,
            !hiddenPanels.lan ? h(Details, { title: '局域网连接', badge: '扫描 / 配对' }, h(LanOnboarding, { variant: variant, onChanged: topologyChanged })) : null,
            !hiddenPanels.public ? h(Details, { title: '公网连接', badge: variant === 'v2' ? '直连' : '直连 / 樱花' }, h(PublicConnection, { data: data, mode: variant === 'v2' ? 'direct' : '', variant: variant, onChanged: topologyChanged })) : null,
            variant === 'v2' && !hiddenPanels.sakuraTunnel ? h(Details, { title: '内网穿透（樱花穿透）', badge: '樱花' }, h(PublicConnection, { data: data, mode: 'sakura', variant: variant, onChanged: topologyChanged })) : null,
            !hiddenPanels.nodes ? h(Details, { title: '节点管理', badge: '仅本机生效' }, h(NodeManager, { onChanged: topologyChanged })) : null,
            !hiddenPanels.permissions ? h(Details, { title: '权限设置', badge: '本机 ACL' }, h(PermissionsPanel)) : null,
            !hiddenPanels.transfers ? h(Details, { title: '文件传输', badge: '本机记录' }, h(TransferHistory)) : null,
            !hiddenPanels.instances ? h(Details, { title: '本机实例', badge: ((data.local && data.local.instances) || []).length }, h(InstanceList, { data: data })) : null,
            !hiddenPanels.versions ? h(Details, { title: '版本一致性', badge: versions.length ? versions.length + ' 处升级' : '一致' },
              versions.length
                ? versions.map(function (item, i) { return h('div', { key: i, className: 'dm-sub', style: { marginTop: 4 } }, '· ' + (typeof item === 'string' ? item : JSON.stringify(item))) })
                : h('div', { className: 'dm-empty' }, '所有节点/实例版本一致')
            ) : null,
            !hiddenPanels.delegations ? h(Details, { title: '委托台账', badge: (data.delegations && data.delegations.total) || 0 }, h(DelegationTable, { data: data })) : null,
            !hiddenPanels.alerts ? h(Details, { title: '告警历史', badge: ((data.alerts && data.alerts.history) || []).length }, h(AlertList, { data: data })) : null,
            !hiddenPanels.diagnostics && (issues.length || hints.length) ? h(Details, { title: '诊断建议', badge: issues.length + hints.length },
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

/* 会话 header 的委托计数入口：样式跟随 DSH 顶栏，不写死背景色 */
.dm-dg-top { position:relative; display:inline-flex; align-items:center; }
.dm-dg-top-btn { display:inline-flex; align-items:center; gap:6px; border:1px solid transparent; border-radius:8px; background:transparent; color:inherit; font:inherit; font-size:12px; line-height:20px; padding:2px 7px; cursor:pointer; white-space:nowrap; }
.dm-dg-top-btn:hover { background:var(--dsw-alias-fill-l1, rgba(128,128,128,.12)); }
.dm-dg-top-btn:focus-visible { outline:2px solid var(--dsw-alias-state-focus, rgba(88,166,255,.65)); outline-offset:1px; }
.dm-dg-top-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--dsw-alias-label-tertiary, rgba(128,128,128,.7)); }
.dm-dg-top-dot.run { background:#3b82d6; }
.dm-dg-top-dot.warn { background:#d29922; }
.dm-dg-top-caret { font-size:9px; opacity:.55; transform:translateY(-1px); }
.dm-dg-top-caret.open { transform:translateY(-1px) rotate(180deg); }
.dm-dg-topmenu { position:fixed; z-index:10000; width:min(390px, 92vw); max-height:min(460px, 70vh); overflow:auto; box-sizing:border-box; padding:7px; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35)); border-radius:11px; background:var(--dsw-specific-menu, var(--dsw-alias-fill-l1, #fff)); color:inherit; box-shadow:0 12px 34px rgba(0,0,0,.22); }
.dm-dg-topmenu-head { display:flex; align-items:baseline; gap:8px; padding:4px 7px 7px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); font-size:12px; }
.dm-dg-topmenu-head .dm-dg-sub { margin-left:auto; }
.dm-dg-topmenu-list { display:flex; flex-direction:column; }
.dm-dg-topmenu-row { display:flex; flex-direction:column; gap:4px; padding:8px 7px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14)); }
.dm-dg-topmenu-row:last-child { border-bottom:none; }
.dm-dg-topmenu-line { display:flex; align-items:center; gap:7px; min-width:0; }
.dm-dg-topmenu-to { font-size:11.5px; font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dm-dg-topmenu-time { margin-left:auto; font-size:10.5px; opacity:.5; white-space:nowrap; font-variant-numeric:tabular-nums; }
.dm-dg-topmenu-goal { font-size:11px; opacity:.72; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dm-dg-topmenu-foot { padding:7px 7px 3px; font-size:10.5px; opacity:.45; border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18)); }
.dm-dg-topmenu-err { margin:5px 7px; padding:6px 8px; border:1px solid rgba(248,81,73,.4); border-radius:7px; color:#c9362c; font-size:11px; }
body[data-ds-dark-theme] .dm-dg-topmenu { background:#24262b; border-color:rgba(255,255,255,.16); box-shadow:0 12px 34px rgba(0,0,0,.55); }
body[data-ds-dark-theme] .dm-dg-topmenu-err { color:#ff7b72; }
@media (prefers-color-scheme: dark) {
  .dm-dg-topmenu { background:#24262b; border-color:rgba(255,255,255,.16); box-shadow:0 12px 34px rgba(0,0,0,.55); }
  .dm-dg-topmenu-err { color:#ff7b72; }
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
.dm-public-form { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:8px; }
.dm-public-form input[type=text], .dm-public-form input[type=number] { min-width:0; padding:5px 8px; border-radius:7px; border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.08); color:inherit; font-size:12px; outline:none; }
.dm-public-form input[type=text] { width:170px; }
.dm-public-form input[type=number] { width:76px; }
.dm-public-form input:focus { border-color:#4d9bff; }
.dm-public-check { display:flex; gap:4px; align-items:center; font-size:11.5px; opacity:.85; cursor:pointer; }
.dm-public-suggest { display:flex; gap:5px; align-items:center; flex-wrap:wrap; margin-top:6px; }
.dm-public-suggest .dm-btn { font-size:11px; padding:3px 7px; }
.dm-public-res { margin-top:9px; padding-top:8px; border-top:1px dashed rgba(128,128,128,.28); }
.dm-public-summary { display:flex; gap:7px; align-items:center; margin-bottom:3px; }
.dm-public-row { display:flex; gap:6px; align-items:baseline; margin-top:3px; font-size:11.5px; line-height:1.35; }
.dm-public-k { width:34px; flex:0 0 auto; opacity:.55; }
.dm-public-v { min-width:0; word-break:break-all; }
.dm-public-v.good { color:#2e9e4f; }
.dm-public-v.bad { color:#c9362c; }
.dm-public-v.muted { opacity:.6; }
.dm-public-msg { margin-top:6px; color:#c9362c; }
.dm-public-sakura { margin-top:7px; padding-top:6px; border-top:1px dashed rgba(128,128,128,.2); }
.dm-join { margin-top:8px; padding-top:8px; border-top:1px dashed rgba(128,128,128,.28); }
.dm-sakura-servers { display:flex; flex-direction:column; gap:7px; margin-top:7px; }
.dm-sakura-server { border:1px solid rgba(128,128,128,.25); border-radius:9px; padding:7px 9px; background:rgba(128,128,128,.04); }
.dm-sakura-server.selected { border-color:rgba(163,113,247,.55); background:rgba(163,113,247,.08); }
.dm-sakura-server-head { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:12px; }
.dm-sakura-server-name { font-weight:650; }
.dm-sakura-server-mesh { margin-top:5px; padding-top:5px; border-top:1px dashed rgba(128,128,128,.2); display:flex; flex-direction:column; gap:4px; }
.dm-sakura-tunnel { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11px; }
.dm-sakura-tunnel.pending { opacity:.55; }
.dm-sakura-tunnel-name { font-weight:600; }
.dm-sakura-other { margin-top:5px; font-size:11px; }
.dm-sakura-other > summary { cursor:pointer; opacity:.6; }
.dm-sakura-server-bar { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-top:7px; padding:6px 8px; border:1px solid rgba(163,113,247,.35); border-radius:8px; background:rgba(163,113,247,.06); font-size:12px; }
.dm-verify-form { margin-top:7px; padding:7px 8px; border:1px solid rgba(88,166,255,.4); border-radius:8px; background:rgba(88,166,255,.07); }
.dm-content, .dm-content > .dm-root { height:100%; min-height:0; }
.dm-root { display:flex; flex-direction:column; min-height:0; }
.dm-head, .dm-foot { flex:none; }
.dm-body { flex:1; min-height:0; align-items:stretch; }
.dm-content-scroll { overflow:hidden; }
.dm-pane { min-height:0; overflow:auto; padding-right:4px; }
/* 拖窄到单列时：容器查询改不了容器外的 scroll，必须由页面级类切换 */
.dm-page.dm-narrow .dm-content-shell .dm-content-scroll { overflow:auto; }
.dm-page.dm-narrow .dm-content { height:auto; }
.dm-page.dm-narrow .dm-content > .dm-root { height:auto; }
.dm-page.dm-narrow .dm-body { display:block; flex:none; }
.dm-page.dm-narrow .dm-pane { overflow:visible; padding-right:0; }
.dm-pub-tabs { display:flex; gap:5px; margin-bottom:7px; }
.dm-pub-tab { font-size:11.5px; padding:4px 11px; border-radius:7px; border:1px solid rgba(128,128,128,.32); background:transparent; color:inherit; cursor:pointer; }
.dm-pub-tab.active { border-color:rgba(88,166,255,.65); color:#3b82d6; background:rgba(88,166,255,.1); }
.dm-lan-table { width:100%; table-layout:auto; border-collapse:collapse; font-size:11.5px; margin-top:6px; }
.dm-lan-table th { text-align:left; font-weight:600; font-size:10.5px; opacity:.55; padding:4px 6px; border-bottom:1px solid rgba(128,128,128,.22); white-space:nowrap; }
.dm-lan-table td { padding:5px 6px; border-bottom:1px solid rgba(128,128,128,.12); vertical-align:middle; overflow:visible; text-overflow:clip; white-space:nowrap; }
.dm-lan-table td:nth-child(3) { white-space:normal; overflow-wrap:anywhere; }
.dm-lan-table td.dm-sakura-note { white-space:normal; overflow-wrap:anywhere; opacity:.8; }
.dm-lan-table td:last-child, .dm-lan-table th:last-child { text-align:right; white-space:nowrap; }
.dm-lan-actions { display:flex; gap:5px; justify-content:flex-end; align-items:center; }
.dm-lan-actions .dm-btn { padding:3px 7px; font-size:10.5px; }
.dm-perm-search { min-width:140px; flex:1; padding:5px 8px; border-radius:7px; border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.08); color:inherit; font-size:12px; outline:none; }
.dm-perm-list { margin-top:7px; border-top:1px solid rgba(128,128,128,.18); }
.dm-perm-row { display:grid; grid-template-columns:18px max-content minmax(0,1fr) auto; gap:7px; align-items:start; padding:5px 2px; border-bottom:1px solid rgba(128,128,128,.12); font-size:11.5px; cursor:pointer; }
.dm-perm-row:hover { background:rgba(128,128,128,.08); }
.dm-perm-name { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; white-space:nowrap; }
.dm-perm-desc { opacity:.65; white-space:normal; overflow-wrap:anywhere; line-height:1.35; }
.dm-panels { display:flex; flex-direction:column; gap:4px; }
.dm-panel-toggle { display:flex; gap:6px; align-items:center; font-size:12px; padding:3px 0; cursor:pointer; }
@container dm-content (max-width: 860px) {
  .dm-content-scroll { overflow:auto; }
  .dm-content, .dm-content > .dm-root { height:auto; }
  .dm-body { display:block; flex:none; }
  .dm-pane { overflow:visible; padding-right:0; }
}
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
.dm-usage { display:flex; flex-direction:column; gap:5px; font-size:12px; }
.dm-usage-row { display:flex; align-items:center; gap:7px; }
.dm-help-overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:9999; display:flex; align-items:center; justify-content:center; padding:24px; }
.dm-help-card { width:min(760px,100%); max-height:86vh; overflow:auto; background:#161a20; color:#d8dee9; border:1px solid rgba(128,128,128,.3); border-radius:14px; padding:16px 18px; box-shadow:0 24px 80px rgba(0,0,0,.55); }
.dm-help-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
.dm-help-title { font-weight:700; font-size:15px; }
.dm-help-section { margin-top:12px; }
.dm-help-h { font-weight:650; font-size:12.5px; margin-bottom:4px; }
.dm-help-prompt { border-top:1px solid rgba(128,128,128,.16); padding:9px 0; }
.dm-help-prompt-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:3px; }
.dm-btn.bad { border-color:rgba(209,75,65,.55); color:#d14b41; }

.dm-card-node.indirect { z-index:2; border-style:dashed; border-color:rgba(128,128,128,.45); background:rgba(255,255,255,.97); }
@media (prefers-color-scheme: dark) { .dm-card-node.indirect { background:#1d2025; } }
.dm-fed-badge { font-size:10px; opacity:.6; padding:1px 5px; border:1px dashed rgba(128,128,128,.5); border-radius:999px; white-space:nowrap; }
.dm-edge-indirect { stroke:rgba(128,128,128,.5); stroke-width:1.1; fill:none; }

.dm-pane { min-width:0; display:flex; flex-direction:column; gap:12px; }
.dm-divider { cursor:col-resize; align-self:stretch; min-height:120px; border-radius:4px; position:relative; }
.dm-divider::before { content:''; position:absolute; top:0; bottom:0; left:3px; width:1px; background:rgba(128,128,128,.28); }
.dm-divider:hover::before, .dm-divider:active::before { background:rgba(88,166,255,.7); width:2px; left:2.5px; }
@container dm-content (max-width: 860px) { .dm-body { grid-template-columns:1fr; } .dm-divider { display:none; } }
/* 2026-11-11 布局：宽屏左右各自滚动；窄屏恢复整页单列滚动 */
.dm-content-shell .dm-content-scroll { overflow:hidden; }
.dm-content > .dm-root { height:100%; min-height:0; }
.dm-root { display:flex; flex-direction:column; min-height:0; }
.dm-head, .dm-foot { flex:none; }
.dm-body { flex:1; min-height:0; align-items:stretch; }
.dm-pane { min-height:0; overflow:auto; padding-right:4px; }
@container dm-content (max-width: 860px) {
  .dm-content-shell .dm-content-scroll { overflow:auto; }
  .dm-content > .dm-root { height:auto; }
  .dm-body { display:block; flex:none; }
  .dm-pane { overflow:visible; padding-right:0; }
}
`
// ================= 顶栏：委托任务计数（只读卡片） =================
// 2026-11-23：跨设备委托以前只能进「委托」面板看；这里对齐后台任务入口，
// 在会话 header 加一个「N 个委托任务」，点开就是进行中/待处理的卡片。
// 只读：数据来自 /api/dsh-mesh/delegations，不创建/不取消任务。
var DG_TOP_ACTIVE = { accepted: 1, submitted: 1, working: 1, running: 1, provisioning: 1, question: 1, stalled: 1 }
var DG_TOP_ATTENTION = { question: 1, stalled: 1, failed: 1 }

function dgTopIsActive(task) {
  var state = String((task && (task.displayState || task.state)) || '')
  return (task && task.isActive === true) || DG_TOP_ACTIVE[state] === 1
}
function dgTopNeedsAttention(task) {
  var state = String((task && (task.displayState || task.state)) || '')
  return DG_TOP_ATTENTION[state] === 1
}
function dgTopLabel(active, attention) {
  if (active > 0) return active + ' 个委托任务'
  if (attention > 0) return attention + ' 个委托待处理'
  return ''
}

function DelegationHeaderAction() {
  var sTasks = useState([]); var tasks = sTasks[0]; var setTasks = sTasks[1]
  var sOpen = useState(false); var open = sOpen[0]; var setOpen = sOpen[1]
  var sPos = useState(null); var pos = sPos[0]; var setPos = sPos[1]
  var sErr = useState(''); var error = sErr[0]; var setError = sErr[1]
  var rootRef = useRef(null)
  var aliveRef = useRef(true)

  useEffect(function () {
    aliveRef.current = true
    function load() {
      dgFetch('/api/dsh-mesh/delegations?limit=50').then(function (json) {
        if (!aliveRef.current) return
        if (json && json.ok) { setTasks(Array.isArray(json.tasks) ? json.tasks : []); setError('') }
        else setError((json && (json.error || json.code)) || '委托接口不可用')
      }).catch(function (err) {
        if (aliveRef.current) setError(dgFriendly(err))
      })
    }
    load()
    var timer = setInterval(load, 5000)
    return function () { aliveRef.current = false; clearInterval(timer) }
  }, [])

  useEffect(function () {
    if (!open) return undefined
    function onDoc(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    function onKey(event) { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return function () { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  var active = tasks.filter(dgTopIsActive)
  var attention = tasks.filter(dgTopNeedsAttention)
  var label = dgTopLabel(active.length, attention.length)
  if (!label && !error) return null
  var rows = active.concat(attention.filter(function (task) { return active.indexOf(task) < 0 })).slice(0, 8)

  function toggle() {
    if (!open && rootRef.current) {
      var rect = rootRef.current.getBoundingClientRect()
      setPos({ top: Math.round(rect.bottom + 6), right: Math.max(8, Math.round(window.innerWidth - rect.right)) })
    }
    setOpen(!open)
  }

  return h('span', { ref: rootRef, className: 'dm-dg-top' },
    h('button', {
      type: 'button',
      className: 'dm-dg-top-btn' + (attention.length ? ' attention' : ''),
      'aria-expanded': open,
      'aria-label': label || '委托任务',
      title: error || label,
      onClick: toggle
    },
      h('span', { className: 'dm-dg-top-dot' + (active.length ? ' run' : attention.length ? ' warn' : '') }),
      h('span', null, label || '委托异常'),
      h('span', { className: 'dm-dg-top-caret' + (open ? ' open' : '') }, '▾')
    ),
    open ? h('div', { className: 'dm-dg-topmenu', style: pos ? { top: pos.top + 'px', right: pos.right + 'px' } : undefined },
      h('div', { className: 'dm-dg-topmenu-head' },
        h('strong', null, '委托任务'),
        h('span', { className: 'dm-dg-sub' }, active.length + ' 个进行中' + (attention.length ? ' · ' + attention.length + ' 个待处理' : ''))
      ),
      error ? h('div', { className: 'dm-dg-topmenu-err' }, error) : null,
      rows.length ? h('div', { className: 'dm-dg-topmenu-list' }, rows.map(function (task) {
        return h('div', { className: 'dm-dg-topmenu-row', key: task.taskId || task.conversationId },
          h('div', { className: 'dm-dg-topmenu-line' },
            dgChip(task.displayState || task.state || 'unknown'),
            h('span', { className: 'dm-dg-topmenu-to' }, (task.nodeLabel || task.node || '?') + (task.instance ? ' · ' + task.instance : '')),
            h('span', { className: 'dm-dg-topmenu-time' }, dgClock(task.displayAt || task.updatedAt))
          ),
          h('div', { className: 'dm-dg-topmenu-goal', title: task.goal || '' }, task.goal || '(无目标)')
        )
      })) : h('div', { className: 'dm-dg-empty' }, '没有进行中的委托'),
      h('div', { className: 'dm-dg-topmenu-foot' }, '详情见左侧「委托」面板')
    ) : null
  )
}
    function MeshNetworkPage(props) {
      var variant = (props && props.variant) || 'legacy'
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

      return h('div', { className: 'dm-page' + (contentW > 0 && contentW < 860 ? ' dm-narrow' : '') },
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
            h('div', { className: 'dm-content', style: { width: 'min(100%, ' + contentW + 'px)' } }, h(MeshStatusSection, { variant: variant }))
          )
        )
      )
    }

    // 2026-11-12：用户确认「AI 网络2」方案更好 —— 原沙箱页「AI 网络2」晋升为唯一的「AI 网络」页面；
    // 旧版独立入口下线（legacy 分支代码保留在 MeshNetworkPage 里，必要时可回滚）。
    function MeshNetworkPageV2() { return h(MeshNetworkPage, { variant: 'v2' }) }

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
      // 2026-11-12：用户确认 v2（原 AI 网络2）更好 —— 唯一入口「AI 网络」现在渲染 v2 页面。
      try {
        disposers.push(ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({ name: 'sidebar.panellist', id: 'mesh-network', order: 54, label: function () { return 'AI 网络' } }, networkPanelIcon)
        }))
        disposers.push(ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'mesh-network', inject: function () { return {} } }, MeshNetworkPageV2)
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
      // 2026-11-23：会话 header 加「N 个委托任务」，对齐后台任务入口；只读。
      try {
        disposers.push(ctx.slots.inject('conversation.session.header.actions', function () {
          return ctx.slots.register({ name: 'conversation.session.header.actions', id: 'mesh-delegations', order: 21 }, DelegationHeaderAction)
        }))
      } catch (error) {
        console.warn('[dsh-mesh-ui] delegation header action registration failed:', error)
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
    // 2026-11-18：暴露纯函数给测试（DSH 只读 apply/inject，额外字段无副作用）。
    exports.__test = {
      peerDeviceKey: peerDeviceKey,
      dedupePeers: dedupePeers,
      formFactorOf: formFactorOf,
      deviceType: deviceType
    }
    return module.exports
  }
})
