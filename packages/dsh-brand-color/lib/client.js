// dsh-brand-color — 浏览器半（client plugin bundle）
//
// 只改「品牌 logo 颜色」：用 CSS 变量 `--dsh-brand-color`（harness ui-sidebar 官方支持），
// **不换图标、不改文字**。设置窗口新增「品牌颜色」：16 个预设色块 + 自定义取色器 + hex 输入；
// 点选后立刻改页面变量（即时生效），同时 POST 保存到 $DSH_HOME/dsh-brand-color.json。
//
// 归宿：reusable（dsh-mesh/plugin/dsh-brand-color/lib/）

window.__ModuleLoader__.load({
  id: 'dsh-brand-color',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var API_CONFIG = '/api/dsh-brand-color/config'
    var API_APPLY = '/api/dsh-brand-color/apply'
    var STYLE_ID = 'dsh-brand-color-style'

    // 官方鲸鱼 logo 的矢量路径（来自 @deepseek-ai/dsh-client-ui-primitives FishLogo.tsx）
    // 用于在色卡里直接预览「这个颜色下 logo 长什么样」，而不是只显示一个色点。
    var FISH_LOGO_VIEWBOX = { width: 23.16, height: 17.04 }
    var FISH_LOGO_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

    /** 预览用的 logo（fill 由调用方给颜色）。 */
    function LogoPreview(props) {
      var size = props.size || 34
      return h('svg', {
        width: size,
        height: (size * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width,
        viewBox: '0 0 ' + FISH_LOGO_VIEWBOX.width + ' ' + FISH_LOGO_VIEWBOX.height,
        fill: 'none',
        'aria-hidden': 'true'
      }, h('path', { d: FISH_LOGO_PATH, fill: props.color || 'currentColor' }))
    }

    var PRESETS = [
      { label: '跟随主题', value: 'currentColor' },
      { label: '墨黑', value: '#1a1a1a' },
      { label: '石墨', value: '#4b5563' },
      { label: '官方蓝', value: '#4a7dd6' },
      { label: '天蓝', value: '#38bdf8' },
      { label: '青绿', value: '#39c5cf' },
      { label: '翠绿', value: '#2e9e4f' },
      { label: '草绿', value: '#84cc16' },
      { label: '琥珀', value: '#d29922' },
      { label: '暖黄', value: '#f5c542' },
      { label: '柠檬黄', value: '#eab308' },
      { label: '金黄', value: '#ffd700' },
      { label: '橙', value: '#fb8500' },
      { label: '红', value: '#f85149' },
      { label: '玫红', value: '#db61a2' },
      { label: '紫', value: '#a371f7' },
      { label: '靛蓝', value: '#6366f1' },
      { label: '棕', value: '#8b5e3c' },
      { label: '白', value: '#ffffff' }
    ]

    /** 生成「该颜色下的鲸鱼 logo」favicon data URL。 */
    function faviconUrl(color) {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 23.16 17.04"><path d="' + FISH_LOGO_PATH + '" fill="' + color + '"/></svg>'
      return 'data:image/svg+xml,' + encodeURIComponent(svg)
    }

    /** 把颜色写进页面 CSS 变量 + 同步 favicon（即时生效，无需刷新）。 */
    function paint(color) {
      if (!document.head) {
        setTimeout(function () { paint(color) }, 200)
        return
      }
      var style = document.getElementById(STYLE_ID)
      if (!style) {
        style = document.createElement('style')
        style.id = STYLE_ID
        document.head.appendChild(style)
      }
      var isTheme = !color || color === 'currentColor'
      // DSH 0.2.0 用 --dsh-brand-color；0.2.2 的品牌位改成 sidebar.brand.mark/name
      // 插槽（hashed class），不再读这个变量，所以同时用作用域选择器给新品牌位 SVG 上色。
      // 选择器只命中品牌容器，不会影响侧栏其他图标。
      var css = ''
      if (!isTheme) {
        css += ':root, html, body { --dsh-brand-color: ' + color + ' !important; }\n'
        // 只给「logo 图标」上色：brandMark 里的 SVG；不要碰 brandName/brandIdentity，
        // 它们包含品牌名文字，改 color/fill 会把文字也染色。
        css += '[class*="brandMark"] svg, [class*="brandMark"] svg *, [class*="brandLogo"] svg, [class*="brandLogo"] svg *, [class*="logoMark"] svg, [class*="logoMark"] svg * { color: ' + color + ' !important; fill: ' + color + ' !important; }\n'
      }
      style.textContent = css
      // favicon：同时兼容 DSH 0.2.0 的 #brand-favicon-* 和 0.2.2 的普通 link[rel=icon]。
      var href = isTheme ? null : faviconUrl(color)
      var links = document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]')
      for (var i = 0; i < links.length; i++) {
        var link = links[i]
        if (!link.dataset.dmBcOriginal) link.dataset.dmBcOriginal = link.getAttribute('href') || ''
        link.setAttribute('href', href || link.dataset.dmBcOriginal)
      }
      ;['brand-favicon-dark', 'brand-favicon-light'].forEach(function (id) {
        var el = document.getElementById(id)
        if (el) el.href = href || el.dataset.dmBcOriginal || ''
      })
      window.__dmBcLastColor = color
    }

    var CSS = `
.dm-bc-root { display:flex; flex-direction:column; gap:12px; font-size:13px; }
.dm-bc-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dm-bc-title { font-weight:650; font-size:14px; }
.dm-bc-sub { font-size:11.5px; opacity:.55; }
.dm-bc-pill { font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid rgba(128,128,128,.3); }
.dm-bc-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(74px, 1fr)); gap:8px; }
.dm-bc-swatch { display:flex; flex-direction:column; align-items:center; gap:5px; padding:8px 6px; border-radius:10px; border:1px solid rgba(128,128,128,.25); background:transparent; cursor:pointer; color:inherit; }
.dm-bc-swatch:hover { background:rgba(128,128,128,.10); }
.dm-bc-swatch.active { border-color:rgba(88,166,255,.85); box-shadow:0 0 0 2px rgba(88,166,255,.28); }
.dm-bc-preview { display:flex; align-items:center; justify-content:center; width:100%; height:30px; color:inherit; }
.dm-bc-preview svg { display:block; }
.dm-bc-preview-lg { width:auto; height:auto; margin-left:4px; }
.dm-bc-swatch { min-height:64px; }
.dm-bc-label { font-size:10.5px; opacity:.72; white-space:nowrap; }
.dm-bc-custom { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dm-bc-custom input[type=color] { width:44px; height:30px; padding:0; border:1px solid rgba(128,128,128,.35); border-radius:8px; background:transparent; }
.dm-bc-hex { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; padding:5px 8px; width:110px; border-radius:8px; border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; }
.dm-bc-btn { font-size:12px; padding:5px 12px; border-radius:8px; border:1px solid rgba(128,128,128,.38); background:transparent; color:inherit; cursor:pointer; }
.dm-bc-btn.primary { border-color:rgba(88,166,255,.55); color:#3b82d6; }
.dm-bc-note { font-size:11px; opacity:.55; line-height:1.5; }
.dm-bc-err { color:#c9362c; font-size:12px; }
.dm-bc-ok { color:#2e9e4f; font-size:12px; }
@media (prefers-color-scheme: dark) {
  .dm-bc-btn.primary { color:#79b8ff; }
  .dm-bc-err { color:#ff7b72; }
  .dm-bc-ok { color:#3fb950; }
}
`

    function BrandColorSection() {
      var s0 = useState('currentColor'); var selected = s0[0]; var setSelected = s0[1]
      var s1 = useState(''); var custom = s1[0]; var setCustom = s1[1]
      var s2 = useState(''); var msg = s2[0]; var setMsg = s2[1]
      var s3 = useState(false); var saving = s3[0]; var setSaving = s3[1]
      var s4 = useState(''); var error = s4[0]; var setError = s4[1]
      var s5 = useState(''); var configPath = s5[0]; var setConfigPath = s5[1]

      useEffect(function () {
        fetch(API_CONFIG, { headers: { accept: 'application/json' } })
          .then(function (res) { return res.json() })
          .then(function (json) {
            if (!json || !json.ok) return
            var color = json.color || 'currentColor'
            setSelected(color)
            setConfigPath(json.configPath || '')
            if (color.charAt(0) === '#') setCustom(color)
            paint(color)
          })
          .catch(function (err) { setError(String((err && err.message) || err)) })
      }, [])

      function save(color) {
        if (!color) return
        setSaving(true)
        setError('')
        paint(color) // 即时生效（先上色，再落盘）
        fetch(API_APPLY, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ color: color })
        })
          .then(function (res) { return res.json() })
          .then(function (json) {
            if (!json.ok) throw new Error(json.error || 'save failed')
            setSelected(color)
            setMsg('已应用 ✔（已保存，刷新页面后仍保持）')
            setTimeout(function () { setMsg('') }, 2500)
          })
          .catch(function (err) { setError(String((err && err.message) || err)) })
          .finally(function () { setSaving(false) })
      }

      return h('div', { className: 'dm-bc-root' },
        h('style', null, CSS),
        h('div', { className: 'dm-bc-head' },
          h('span', { className: 'dm-bc-title' }, '品牌颜色'),
          h('span', { className: 'dm-bc-pill' }, '当前：' + (selected || '—')),
          h('span', { style: { flex: 1 } }),
          h('span', { className: 'dm-bc-sub' }, configPath || '')
        ),
        h('div', { className: 'dm-bc-sub' }, '只改侧边栏/欢迎屏品牌 logo 的颜色，不动图标形状与文字；点击色块即时生效并保存。'),
        h('div', { className: 'dm-bc-grid' },
          PRESETS.map(function (preset) {
            var isCurrent = String(preset.value).toLowerCase() === String(selected || '').toLowerCase()
            return h('button', {
              key: preset.value,
              type: 'button',
              className: 'dm-bc-swatch' + (isCurrent ? ' active' : ''),
              title: preset.label + ' ' + preset.value,
              disabled: saving,
              onClick: function () {
                setCustom(preset.value.charAt(0) === '#' ? preset.value : '')
                save(preset.value)
              }
            },
              h('span', { className: 'dm-bc-preview' }, h(LogoPreview, { color: preset.value === 'currentColor' ? 'currentColor' : preset.value, size: 34 })),
              h('span', { className: 'dm-bc-label' }, preset.label)
            )
          })
        ),
        h('div', { className: 'dm-bc-custom' },
          h('span', { className: 'dm-bc-sub' }, '自定义颜色：'),
          h('input', { type: 'color', value: custom || '#4a7dd6', onChange: function (event) { setCustom(event.target.value) } }),
          h('input', {
            type: 'text',
            className: 'dm-bc-hex',
            placeholder: '#4a7dd6',
            value: custom,
            onChange: function (event) { setCustom(event.target.value.trim()) },
            onKeyDown: function (event) { if (event.key === 'Enter') save(custom) }
          }),
          h('span', { className: 'dm-bc-preview dm-bc-preview-lg' }, h(LogoPreview, { color: custom || 'currentColor', size: 52 })),
          h('button', { type: 'button', className: 'dm-bc-btn primary', disabled: saving || !custom, onClick: function () { save(custom) } }, saving ? '保存中…' : '应用自定义色')
        ),
        error ? h('div', { className: 'dm-bc-err' }, error) : null,
        msg ? h('div', { className: 'dm-bc-ok' }, msg) : null,
        h('div', { className: 'dm-bc-note' },
          '实现方式：设置 CSS 变量 --dsh-brand-color（官方品牌位读取它），因此不会替换图标。',
          '形状/大小/文字如需改，用 dsh-custom-brand 的配置文件（它现在处于禁用状态）。'
        )
      )
    }

    var SECTION = { name: 'settings.section', id: 'brand-color', order: 91, label: 'logo 颜色' }
    var inject = ['slots']

    // ---- 2026-11-07：设置左侧导航里本项的图标，从壳的默认齿轮换成 DeepSeek 鲸鱼 ----
    // 这个版本壳的 navIcon(id) 只认识官方几个 section id，其余一律齿轮；
    // 插件 API 不暴露图标，所以在 DOM 层把本项按钮里的 svg 换成鲸鱼（不依赖源码改动）。
    var NAV_LABELS = ['logo 颜色', '品牌颜色']
    function whaleNavSvg(referenceClass) {
      var NS = 'http://www.w3.org/2000/svg'
      var svg = document.createElementNS(NS, 'svg')
      if (referenceClass) svg.setAttribute('class', referenceClass)
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 ' + FISH_LOGO_VIEWBOX.width + ' ' + FISH_LOGO_VIEWBOX.height)
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('data-dsh-brand-whale', '1')
      // 跟随「logo 颜色」选择的主题色（--dsh-brand-color 由本插件设置）
      svg.style.color = 'var(--dsh-brand-color, currentColor)'
      var path = document.createElementNS(NS, 'path')
      path.setAttribute('d', FISH_LOGO_PATH)
      path.setAttribute('fill', 'currentColor')
      svg.appendChild(path)
      return svg
    }
    function decorateNav() {
      try {
        var buttons = document.querySelectorAll('[role="dialog"] nav button')
        for (var i = 0; i < buttons.length; i++) {
          var button = buttons[i]
          var text = (button.textContent || '').trim()
          if (NAV_LABELS.indexOf(text) < 0) continue
          // 0.2.2 的按钮结构默认图标可能包在 span 里。保留默认图标的父容器
          // （间距/对齐由它决定），只替换其中的 SVG；同时清掉所有旧 SVG，避免双图标。
          var existingWhale = button.querySelector('svg[data-dsh-brand-whale]')
          var old = []
          var all = button.querySelectorAll('svg')
          for (var j = 0; j < all.length; j++) if (all[j] !== existingWhale) old.push(all[j])
          var reference = old[0] || null
          var parent = reference ? reference.parentNode : button
          var className = reference ? reference.getAttribute('class') || '' : ''
          if (!existingWhale) {
            var whale = whaleNavSvg(className)
            if (reference) parent.insertBefore(whale, reference)
            else if (button.firstChild) button.insertBefore(whale, button.firstChild)
            else button.appendChild(whale)
          }
          for (var k = 0; k < old.length; k++) if (old[k].parentNode) old[k].parentNode.removeChild(old[k])
        }
      } catch (error) {
        /* ignore */
      }
    }

    /** 读取已保存颜色并在页面加载时应用（失败重试 3 次；这是刷新后保持颜色的关键）。 */
    function applySavedColor(attempt) {
      fetch(API_CONFIG, { headers: { accept: 'application/json' } })
        .then(function (res) { return res.json() })
        .then(function (json) {
          if (json && json.ok) paint(json.color || 'currentColor')
        })
        .catch(function () {
          if (attempt < 3) setTimeout(function () { applySavedColor(attempt + 1) }, 1000)
        })
    }

    function apply(ctx) {
      applySavedColor(0) // 2026-11-07 修复：刷新后恢复已保存颜色（之前只在设置面板打开时才上色）
      var disposers = []
      try {
        disposers.push(ctx.slots.inject('settings.section', function () { return ctx.slots.register(SECTION, BrandColorSection) }))
      } catch (error) {
        console.warn('[dsh-brand-color] settings section registration failed:', error)
      }
      var navObserver = null
      var navTimer = null
      try {
        if (typeof MutationObserver !== 'undefined' && document.body) {
          navObserver = new MutationObserver(function () { decorateNav() })
          navObserver.observe(document.body, { childList: true, subtree: true })
        }
        navTimer = setInterval(decorateNav, 1500)
      } catch (error) {
        /* ignore */
      }
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i++) { try { disposers[i]() } catch (_) { /* ignore */ } }
          try { if (navObserver) navObserver.disconnect() } catch (_) { /* ignore */ }
          try { if (navTimer) clearInterval(navTimer) } catch (_) { /* ignore */ }
          var style = document.getElementById(STYLE_ID)
          if (style) style.remove()
        }
      }, 'dsh-brand-color: settings section + nav icon')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
