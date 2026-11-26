#!/usr/bin/env node
// @generated 2026-11-26: portable repo hooks (pre-commit / commit-msg / pre-push / post-merge).
// Logic only; .githooks/* are thin sh entrypoints. No absolute paths, no silent skips.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const mode = process.argv[2]
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).trim()
process.chdir(root)

if (process.env.REPO_HOOKS_SKIP === '1') {
  console.warn('⚠️ REPO_HOOKS_SKIP=1：跳过仓库 hooks')
  process.exit(0)
}

function readConfig() {
  try { return JSON.parse(readFileSync(join(root, '.repo-hooks.json'), 'utf8')) } catch { return {} }
}
function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true, input, maxBuffer: 64 * 1024 * 1024 })
}
function staged() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split(/\r?\n/).filter(Boolean)
}
function stagedSize(file) {
  try { return Number(git(['cat-file', '-s', `:${file}`]).trim()) } catch { return 0 }
}
function show(file) {
  try { return git(['show', `:${file}`]) } catch { return '' }
}
function isBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
  return false
}
function fail(msg) {
  console.error(msg)
  process.exit(1)
}
function runCommand(command, label) {
  const r = spawnSync(command, { shell: true, cwd: root, stdio: 'inherit', windowsHide: true })
  if (r.status !== 0) fail(`✗ ${label}: exit ${r.status}`)
}

const config = readConfig()
const LARGE_MB = Number(config.largeFileMb || 5)
const SECRET_PATTERNS = [
  /-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /(?:DEEPSEEK|OPENAI|ANTHROPIC|VOLCENGINE|GITHUB)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/,
]

function checkPreCommit() {
  const files = staged()
  if (files.length === 0) return
  const problems = []
  for (const file of files) {
    if (file === '.repo-hooks.json' || file.startsWith('.githooks/')) continue
    const size = stagedSize(file)
    if (size > LARGE_MB * 1024 * 1024) problems.push(`${file}: ${Math.round(size / 1024 / 1024)}MB > ${LARGE_MB}MB`)
    const content = show(file)
    if (!content) continue
    const buf = Buffer.from(content)
    if (isBinary(buf)) continue
    const text = buf.toString('utf8')
    if (/^(?:\/\/|#|\/\*)?\s*(?:<<<<<<<|=======|>>>>>>>)\s/m.test(text)) {
      problems.push(`${file}: conflict marker`)
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) { problems.push(`${file}: suspected secret/token`); break }
    }
    const ext = extname(file).toLowerCase()
    if (['.mjs', '.js', '.cjs'].includes(ext)) {
      const dir = mkdtempSync(join(tmpdir(), 'repo-hook-'))
      const tmp = join(dir, `check${ext}`)
      try {
        writeFileSync(tmp, text)
        const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', windowsHide: true })
        if (r.status !== 0) problems.push(`${file}: node --check failed\n${(r.stderr || '').slice(0, 300)}`)
      } finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
    }
    if (ext === '.json') {
      try { JSON.parse(text) } catch (e) { problems.push(`${file}: invalid JSON (${e.message})`) }
    }
  }
  if (problems.length) fail('✗ pre-commit 失败：\n' + problems.map((p) => `  - ${p}`).join('\n'))
  if (config.formatCommand) {
    const cmd = `${config.formatCommand} ${files.filter((f) => !isBinary(Buffer.from(show(f)))).map((f) => JSON.stringify(f)).join(' ')}`
    runCommand(cmd, 'format')
    for (const f of files) { try { git(['add', '--', f]) } catch {} }
  }
  console.error(`✓ pre-commit: ${files.length} 个文件通过`)
}

function checkCommitMsg(file) {
  if (!file || !existsSync(file)) fail('commit-msg: missing message file')
  const msg = readFileSync(file, 'utf8')
  if (!/^\[why\]:/m.test(msg)) fail('✗ commit-msg 缺少 [why]: 行')
  if (/^\s*(fix|bug|revert)(\(|:|!)/mi.test(msg)) {
    const required = ['现象:', '根因:', '影响范围:', '沉淀位置:', '防再犯:', '同类历史教训:']
    if (!required.every((x) => msg.includes(x))) fail('✗ 事故型 commit 缺少 postmortem 6 行（现象/根因/影响范围/沉淀位置/防再犯/同类历史教训）')
  }
  console.error('✓ commit-msg 通过')
}

function checkPrePush() {
  const full = process.env.PREPUSH_FULL === '1'
  const cmds = full ? (config.prePushFull || []) : (config.prePushFast || [])
  for (const cmd of cmds) {
    console.error(`→ pre-push ${full ? 'full' : 'fast'}: ${cmd}`)
    runCommand(cmd, 'pre-push')
  }
  if (!cmds.length) console.error('⚠️ pre-push: 未配置命令，仅依赖 pre-commit')
}

function postMerge() {
  const script = join(root, 'scripts', 'generate-session-handoff.mjs')
  if (existsSync(script)) {
    const r = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit', windowsHide: true })
    if (r.status !== 0) console.error(`⚠️ post-merge handoff exit ${r.status}`)
  }
}

switch (mode) {
  case 'pre-commit': checkPreCommit(); break
  case 'commit-msg': checkCommitMsg(process.argv[3]); break
  case 'pre-push': checkPrePush(); break
  case 'post-merge': postMerge(); break
  default: fail(`unknown hook mode: ${mode}`)
}
