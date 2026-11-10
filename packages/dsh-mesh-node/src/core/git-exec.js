// @generated 共享的「git 可执行文件解析 + 执行」，供 src/tools/git.js 与 src/tools/cluster.js 共用
// [why] 2026-11-10：mesh server 由计划任务/启动脚本拉起，PATH 里可能没有 git（peer-node 实测：git 在
//   C:\Users\<user>\tools\git\cmd，只有 DSH 的 start-dsh0.cmd 把它写进 PATH）。git.js 已有
//   「DSH_MESH_GIT → PATH → 常见安装目录」回退；cluster.js 的 gitInfo() 却仍直接 execFileSync('git')，
//   于是 mesh_overview 的本机 repo 摘要在干净 PATH 下失效且只报空。抽成共用模块，两处行为一致。
import { join } from 'node:path'
import { run } from './util.js'

/** 找不到 git 时给用户的可诊断提示。 */
const SPAWN_HINT =
  'the mesh server process cannot find git on its PATH. Add the git directory to PATH in the mesh server start script, or set DSH_MESH_GIT to the git executable, then restart mesh (no DSH restart needed).'

/**
 * git 可执行文件候选，按优先级：DSH_MESH_GIT 覆盖 → PATH 里的 git → 平台常见安装位置。
 * @returns {string[]} 去重后的候选列表
 */
export function gitCandidates() {
  const env = process.env
  const list = []
  if (env.DSH_MESH_GIT) list.push(env.DSH_MESH_GIT)
  list.push('git')
  if (process.platform === 'win32') {
    for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean)) {
      list.push(join(root, 'Git', 'cmd', 'git.exe'))
    }
    if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'))
    if (env.USERPROFILE) list.push(join(env.USERPROFILE, 'tools', 'git', 'cmd', 'git.exe'))
  } else {
    list.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git')
  }
  return [...new Set(list)]
}

/** 解析一次并缓存（`git --version` 成功才算命中）。 */
let gitProbe = null
/**
 * @returns {Promise<{bin: string, tried: string[]} | {error: {code: string, message: string}, tried: string[]}>}
 */
export function gitBinary() {
  if (!gitProbe) {
    gitProbe = (async () => {
      const tried = []
      for (const candidate of gitCandidates()) {
        tried.push(candidate)
        const out = await run(candidate, ['--version'], { timeout: 5000 })
        if (!out.error && /\bgit version\b/i.test(out.stdout)) return { bin: candidate, tried }
      }
      return { error: { code: 'ENOENT', message: `git not found; probed: ${tried.join(', ')}` }, tried }
    })()
  }
  return gitProbe
}

/**
 * 用解析到的 git 跑命令；解析失败时返回与 run() 同形的 error 结果，调用方不必各自处理。
 * @param {string[]} args git 参数
 * @param {{timeout?: number, cwd?: string, signal?: AbortSignal, maxBuffer?: number}} [options] 透传给 run()
 * @returns {Promise<{error: unknown, stdout: string, stderr: string, code: number, killed: boolean, timedOut: boolean}>}
 */
export async function runGit(args, options) {
  const found = await gitBinary()
  if (found.error) return { error: found.error, stdout: '', stderr: '', code: 0, killed: false, timedOut: false }
  return run(found.bin, args, options)
}

/**
 * 诊断信息：spawn 失败时附加到工具错误里，避免把「找不到 git」误报成「不是仓库」。
 * @returns {{hint: string, gitCandidates: string[], pathEnv: string, nodePid: number}}
 */
export function gitSpawnDiagnostics() {
  return {
    hint: SPAWN_HINT,
    gitCandidates: gitCandidates(),
    pathEnv: String(process.env.PATH || process.env.Path || ''),
    nodePid: process.pid
  }
}
