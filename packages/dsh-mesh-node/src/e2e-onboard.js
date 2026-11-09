#!/usr/bin/env node
/**
 * e2e-onboard：模拟「一台全新的对端机器」走完公司机接入手册，全程真实网络/真实 DSH。
 *
 * 它验证的是**给公司机的那份手册本身**（不是 mock）：
 *   1) mesh-peer check        —— 公网链路 + TLS 指纹固定 + 无 token 必须 401
 *   2) mesh-peer pair         —— 一次性配对码换 peer 专属 token，落盘 overlay
 *   3) 真 DSH 挂该 overlay    —— headless 实例经公网隧道调 mcp__<name>-mesh__mesh_self
 *   4) 再调一个数据工具       —— mcp__<name>-mesh__git_status（证明 ACL + 真实数据面）
 *   5) 清理                   —— revoke 刚发的 token（必须从 secrets 里消失）
 *
 * 用法：
 *   node src/e2e-onboard.js [--url https://relay.example.com:35724] [--keep] [--skip-dsh]
 *
 * 退出码：0 全通过 / 1 有失败
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { meshHome, loadConfig, loadSecrets, removeInboundToken } from './core/config.js'
import { createPairingCode } from './core/pairing.js'
import { certPath, describeCert } from './core/tls.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PEER_CLI = join(ROOT, 'client', 'mesh-peer.mjs')

const argv = process.argv.slice(2)
function opt(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const HOME = meshHome()
const URL_BASE = opt('url', process.env.MESH_PUBLIC_URL || 'https://relay.example.com:35724')
const NAME = `drill${Date.now().toString(36).slice(-5)}`
const KEEP = flag('keep')
const SKIP_DSH = flag('skip-dsh')

let pass = 0
let fail = 0
const results = []

function check(ok, label, detail = '') {
  if (ok) {
    pass += 1
    results.push(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    results.push(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
  return ok
}

function run(cmd, args, { env = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err), ms: Date.now() - started, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut })
    })
  })
}

function firstValue(text, key) {
  const m = new RegExp(`${key}\\s*[=:]\\s*\\S+`, 'i').exec(text)
  return m ? m[0] : ''
}

async function main() {
  console.log(`[onboard] home=${HOME}`)
  console.log(`[onboard] public url=${URL_BASE}`)

  const config = loadConfig(HOME, { log: () => {} })
  if (!check(config.node?.tls?.enabled === true, 'mesh 配置里 TLS 已开启（否则不该走公网）')) {
    return finish()
  }

  const tls = describeCert(HOME)
  if (!check(!!tls?.fingerprint256, '读到本机证书指纹（mesh_self / tls init 的产物）')) return finish()
  const fingerprint = tls.fingerprint256
  console.log(`[onboard] cert fingerprint=${fingerprint.slice(0, 23)}…`)

  const stage = mkdtempSync(join(tmpdir(), 'mesh-onboard-'))
  const certCopy = join(stage, 'cert.pem')
  copyFileSync(certPath(HOME), certCopy)
  console.log(`[onboard] stage=${stage}`)

  // ── 1) check ───────────────────────────────────────────────────────────────
  const checkRun = await run(process.execPath, [PEER_CLI, 'check', '--url', URL_BASE, '--fingerprint', fingerprint], {
    timeoutMs: 60000,
  })
  check(checkRun.code === 0, 'mesh-peer check 退出码 0', `code=${checkRun.code} ms=${checkRun.ms}`)
  check(/5\/5\s+passed/i.test(checkRun.stdout + checkRun.stderr), 'check 5/5 全通过', firstValue(checkRun.stdout, 'server'))
  check(/401/.test(checkRun.stdout + checkRun.stderr), 'check 覆盖了「无 token 必须 401」这条坏样本')

  // ── 2) pair ────────────────────────────────────────────────────────────────
  const pairing = createPairingCode({ home: HOME, ttlSec: 300, note: `e2e-onboard ${NAME}` })
  console.log(`[onboard] pairing code=${pairing.code} expiresAt=${pairing.expiresAt}`)

  const pairRun = await run(
    process.execPath,
    [PEER_CLI, 'pair', '--url', URL_BASE, '--code', pairing.code, '--name', NAME, '--out-dir', stage, '--fingerprint', fingerprint],
    { timeoutMs: 60000 },
  )
  check(pairRun.code === 0, 'mesh-peer pair 退出码 0', `code=${pairRun.code} ms=${pairRun.ms}`)
  const overlayPath = join(stage, `${NAME}.yml`)
  const metaPath = join(stage, `${NAME}.json`)
  const overlayExists = existsSync(overlayPath)
  check(overlayExists, '生成了 DSH overlay（<name>.yml）')
  check(existsSync(metaPath), '生成了 peer 元信息（<name>.json）')

  let tokenId = null
  let overlayText = ''
  let overlayToken = ''
  if (overlayExists) {
    overlayText = readFileSync(overlayPath, 'utf8')
    const tokenMatch = /Bearer\s+(['"]?)([A-Fa-f0-9]{32,})\1/.exec(overlayText)
    overlayToken = tokenMatch ? tokenMatch[2] : ''
    check(
      /streamable-http/.test(overlayText) && !!overlayToken,
      'overlay 是 streamable-http + Bearer token',
    )
    const mode = statSync(overlayPath).mode & 0o777
    check(process.platform === 'win32' || mode === 0o600, 'overlay 权限 0600（仅属主可读）', `mode=${mode.toString(8)}`)
    const metaText = existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : ''
    check(!!overlayToken && !metaText.includes(overlayToken), '元信息 json 不含 token 明文（只放 tokenId）')
  }
  if (existsSync(metaPath)) {
    try {
      tokenId = JSON.parse(readFileSync(metaPath, 'utf8')).tokenId || null
    } catch {
      tokenId = null
    }
  }
  check(!!tokenId, 'pair 返回了 tokenId（可用于精确 revoke）', tokenId || '')
  const minted = loadSecrets(HOME).inbound.find((t) => t.id === tokenId)
  check(!!minted, 'mesh 侧 secrets 里确实多了这个 token')
  check(minted?.acl == null, '未申请收窄时 peer token 继承服务端默认 ACL（acl=null，不是全放行）')

  // ── 3) + 4) 真 DSH 挂 overlay 跑两次工具调用 ───────────────────────────────
  if (!SKIP_DSH && overlayExists) {
    const env = { NODE_EXTRA_CA_CERTS: certCopy }
    const comspec = process.env.ComSpec || 'cmd.exe'

    const selfPrompt = `调用 MCP 工具 mcp__${NAME}-mesh__mesh_self（参数为 {}），然后严格只输出一行：VER=<mesh.version> NAME=<mesh.name>`
    const selfRun = await run(comspec, ['/c', 'dsh', '--profile', 'headless', '--patch', overlayPath, selfPrompt], {
      env,
      timeoutMs: 240000,
    })
    const selfOut = selfRun.stdout + selfRun.stderr
    check(selfRun.code === 0, '真 DSH 挂 overlay 启动并完成（exit 0）', `code=${selfRun.code} ms=${selfRun.ms}`)
    check(/VER=\d+\.\d+\.\d+/.test(selfOut), '经公网隧道读到 mesh_self 的版本号', firstValue(selfOut, 'VER'))
    check(/NAME=home/.test(selfOut), '读到节点名 home', firstValue(selfOut, 'NAME'))

    const repoPath = ROOT.replace(/[\\/]+$/, '')
    const gitPrompt = `调用 MCP 工具 mcp__${NAME}-mesh__git_status（参数 {"path":"${repoPath.replace(/\\/g, '\\\\')}"}），然后严格只输出一行：BRANCH=<branch>`
    const gitRun = await run(comspec, ['/c', 'dsh', '--profile', 'headless', '--patch', overlayPath, gitPrompt], {
      env,
      timeoutMs: 240000,
    })
    const gitOut = gitRun.stdout + gitRun.stderr
    check(gitRun.code === 0, '第二次调用（数据工具 git_status）完成', `code=${gitRun.code} ms=${gitRun.ms}`)
    check(/BRANCH=main/.test(gitOut), '经公网读到本仓真实 git 分支', firstValue(gitOut, 'BRANCH'))

    // 坏样本：默认 deny 的工具必须仍然是 deny（配对不会把 ACL 放宽）
    const denyPrompt = `调用 MCP 工具 mcp__${NAME}-mesh__host_call（参数 {"tool":"read","arguments":{"file_path":"${repoPath.replace(/\\/g, '\\\\')}\\\\package.json"}}），然后严格只输出一行：ERR=<错误码>`
    const denyRun = await run(comspec, ['/c', 'dsh', '--profile', 'headless', '--patch', overlayPath, denyPrompt], {
      env,
      timeoutMs: 240000,
    })
    const denyOut = denyRun.stdout + denyRun.stderr
    check(denyRun.code === 0, '第三次调用（被默认拒绝的 host_call）完成', `code=${denyRun.code} ms=${denyRun.ms}`)
    check(/E_DENIED/.test(denyOut), 'host_call 对配对 token 仍然是 E_DENIED（默认 deny 未被绕过）', firstValue(denyOut, 'ERR'))
  } else if (SKIP_DSH) {
    console.log('[onboard] --skip-dsh：跳过真 DSH 两步')
  }

  // ── 5) 清理 ────────────────────────────────────────────────────────────────
  if (tokenId) {
    removeInboundToken({ home: HOME, id: tokenId })
    const after = loadSecrets(HOME).inbound.find((t) => t.id === tokenId)
    check(!after, 'revoke 后该 token 从 secrets 消失')
  }
  if (!KEEP) {
    rmSync(stage, { recursive: true, force: true })
    check(!existsSync(stage), '清理临时目录')
  } else {
    console.log(`[onboard] --keep：保留 ${stage}`)
  }

  return finish()
}

function finish() {
  console.log('')
  for (const line of results) console.log(line)
  console.log(`\ne2e-onboard: ${pass}/${pass + fail} passed`)
  process.exitCode = fail === 0 ? 0 : 1
  return fail === 0
}

main().catch((err) => {
  console.error('[onboard] fatal:', err)
  process.exitCode = 1
})
