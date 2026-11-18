// @generated 2026-11-18 公开镜像构建不变量检查（CI 用，跨平台、零依赖）。
// 目的：把过去踩过的坑变成 CI 断言，避免“语法通过但发布物坏了”。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = process.cwd()
const failures = []
const checks = []
function ok(name) { checks.push(name) }
function fail(name, detail) { failures.push(`${name}: ${detail}`) }
function readJson(rel) {
  const file = join(ROOT, rel)
  if (!existsSync(file)) { fail(rel, 'missing'); return null }
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) { fail(rel, 'invalid JSON: ' + error.message); return null }
}
function requireFile(rel, name) {
  const file = join(ROOT, rel)
  if (!existsSync(file) || statSync(file).size === 0) fail(name, `${rel} missing or empty`)
  else ok(name)
}
function requireContains(rel, needle, name) {
  const file = join(ROOT, rel)
  if (!existsSync(file)) return fail(name, `${rel} missing`)
  const text = readFileSync(file, 'utf8')
  if (!text.includes(needle)) return fail(name, `${rel} does not contain ${JSON.stringify(needle)}`)
  ok(name)
}

const dirs = ['packages/dsh-mesh-node', 'packages/dsh-mesh-ui', 'packages/dsh-mesh-host', 'packages/dsh-mesh-autostart', 'packages/dsh-brand-color', 'packages/dsh-mesh']
const manifests = {}
for (const dir of dirs) {
  const pkg = readJson(`${dir}/package.json`)
  if (!pkg) continue
  manifests[pkg.name] = pkg
  if (!pkg.name || !pkg.version) fail(`${dir}/package.json`, 'missing name/version')
  else ok(`${pkg.name} manifest`)
  const main = String(pkg.main || '')
  if (!main) fail(`${dir}/package.json`, 'missing main')
  else requireFile(`${dir}/${main.replace(/^\.\//, '')}`, `${pkg.name} main`)
  if (!pkg.exports || !pkg.exports['./package.json']) fail(`${pkg.name} exports`, 'missing "./package.json"')
  else ok(`${pkg.name} exports ./package.json`)
}

// 本地依赖版本必须和同目录包一致（防止 meta 指向不存在的版本）
for (const [name, pkg] of Object.entries(manifests)) {
  for (const [dep, range] of Object.entries(pkg.dependencies || {})) {
    if (!manifests[dep]) continue
    if (manifests[dep].version !== range) fail(`${name} depends on ${dep}`, `range ${range} != local ${manifests[dep].version}`)
    else ok(`${name} -> ${dep}@${range}`)
  }
}

// 根 package.json 必须与 meta 包一致（dsh plugin add github: 的入口）
const root = readJson('package.json')
const meta = manifests['@linyanzhi/dsh-mesh']
if (root && meta) {
  if (root.name !== meta.name) fail('root package', `name ${root.name} != ${meta.name}`)
  if (root.version !== meta.version) fail('root package', `version ${root.version} != ${meta.version}`)
  for (const [dep, range] of Object.entries(meta.dependencies || {})) {
    if (root.dependencies?.[dep] !== range) fail('root package deps', `${dep} ${root.dependencies?.[dep]} != ${range}`)
  }
  requireFile('packages/dsh-mesh/cordis.patch.yml', 'meta cordis.patch.yml')
  ok('root package matches meta')
}

// 历史回归：session-history 脚本必须随包发布
requireFile('packages/dsh-mesh-node/scripts/session-history.mjs', 'session-history script shipped')

// 历史回归：公开脱敏后 deviceType 必须有定义（PR #10 白屏）
for (const bundle of ['packages/dsh-mesh-ui/lib/client.js', 'packages/dsh-mesh/lib/client.js']) {
  requireContains(bundle, 'function deviceType(', `${bundle} has deviceType`)
  requireContains(bundle, 'function formFactorOf(', `${bundle} has formFactorOf`)
  const text = readFileSync(join(ROOT, bundle), 'utf8')
  if (text.includes('DEVICE_TYPES')) fail(`${bundle} sanitize`, 'still contains hardcoded DEVICE_TYPES')
  else ok(`${bundle} has no DEVICE_TYPES`)
  if (text.includes('C:\\Users\\Administrator')) fail(`${bundle} sanitize`, 'contains personal Windows path')
}

if (failures.length) {
  console.error(`check-public-build: ${failures.length} failure(s)`)
  for (const line of failures) console.error('  FAIL ' + line)
  process.exit(1)
}
console.log(`check-public-build: PASS (${checks.length} checks)`)
