#!/usr/bin/env node
// @generated phone-updater：手机端自更新循环（git pull --ff-only + restart.flag）
//
// 由 dsh-mesh-autostart 插件在引擎启动时拉起；也可手动运行一次：
//   node /root/dsh-mesh-kit/phone-updater.mjs --once
//
// 逻辑：每 5 分钟（DSH_UPDATE_INTERVAL_MS 可调）git fetch，若落后 origin/main 则 pull --ff-only，
// 并写 ~/.dsh-mesh/restart.flag；插件检测到 flag 后重启 serve（自动加载新代码）。
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const repo = process.env.DSH_MESH_REPO || '/root/dsh-mesh-kit/mesh'
const home = process.env.DSH_MESH_HOME || join(homedir(), '.dsh-mesh')
const flag = join(home, 'restart.flag')
const interval = Number(process.env.DSH_UPDATE_INTERVAL_MS || 5 * 60_000)
const once = process.argv.includes('--once')

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(join(home, 'phone-updater.log'), line) } catch {}
  try { console.log(line.trim()) } catch {}
}

function tick() {
  try {
    if (!existsSync(join(repo, '.git'))) { log('skip: no git repo at ' + repo); return }
    execFileSync('git', ['-C', repo, 'fetch', '--quiet', 'origin'], { timeout: 60_000, stdio: 'ignore' })
    const behind = Number(execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD..origin/main'], { encoding: 'utf8', timeout: 20_000 }).trim() || 0)
    if (behind > 0) {
      execFileSync('git', ['-C', repo, 'pull', '--ff-only', '--quiet'], { timeout: 120_000, stdio: 'ignore' })
      writeFileSync(flag, new Date().toISOString() + '\n', 'utf8')
      log(`updated: ${behind} commit(s) behind -> restart.flag written`)
    } else {
      log('up-to-date')
    }
  } catch (error) {
    log('update failed: ' + String(error?.message || error).slice(0, 300))
  }
}

tick()
if (!once) setInterval(tick, interval)
