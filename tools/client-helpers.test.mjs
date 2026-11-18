// 2026-11-18 dsh-mesh-ui 客户端纯函数测试（公开仓 CI 可跑，无 DOM/网络依赖）。
// 加载 packages/dsh-mesh-ui/lib/client.js，mock window.__ModuleLoader__ 与 react，拿 exports.__test。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'packages', 'dsh-mesh-ui', 'lib', 'client.js')
const code = readFileSync(bundle, 'utf8')

let factory = null
const react = {
  createElement: function () { return {} },
  useState: function () { return [undefined, function () {}] },
  useEffect: function () {},
  useRef: function () { return {} },
  useCallback: function (fn) { return fn }
}
const window = { __ModuleLoader__: { load: function (meta) { factory = meta && meta.factory ? meta.factory : meta } } }
const sandbox = {
  window: window,
  require: function (id) { if (id === 'react') return react; throw new Error('unexpected require: ' + id) },
  console: console,
  document: { body: null },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: function () { return { unref: function () {} } },
  clearInterval: function () {},
  navigator: {},
  CSS: undefined,
  MutationObserver: undefined
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })
assert.ok(factory, 'client bundle did not register a ModuleLoader factory')

const exported = factory(sandbox.require) || {}
const t = exported.__test
assert.ok(t && t.peerDeviceKey && t.dedupePeers && t.formFactorOf && t.deviceType, 'missing __test helpers')

assert.equal(t.peerDeviceKey('home-exec'), 'home')
assert.equal(t.peerDeviceKey('company2-lan'), 'company2')
assert.equal(t.peerDeviceKey('phone1-exec'), 'phone1')

const merged = t.dedupePeers([{ name: 'home', latencyMs: 300 }, { name: 'home-exec', latencyMs: 50 }])
assert.equal(merged.length, 1)
assert.equal(merged[0].latencyMs, 50)

assert.equal(t.formFactorOf({ platform: 'linux', arch: 'arm64' }), '手机')
assert.equal(t.formFactorOf({ cpuModel: 'Intel(R) Core(TM) i5-8250U CPU' }), '笔记本')
assert.equal(t.formFactorOf({ cpuModel: 'AMD Ryzen 7 7800X3D' }), '主机')
assert.equal(t.formFactorOf(null), '—')
assert.equal(t.deviceType({ platform: 'linux', arch: 'arm64' }), '手机')

console.log('client-helpers: PASS')
