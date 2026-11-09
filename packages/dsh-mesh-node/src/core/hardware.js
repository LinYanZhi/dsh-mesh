// @generated hardware：本机硬件概况（CPU / 内存 / 磁盘 / OS），供 mesh_self、host_self 与 UI 使用
// [why] 2026-11-09 用户反馈 AI 网络面板很多设备没有内存/系统版本/磁盘信息：
//       之前只有 survey 快照采集过本机硬件，远端节点协议里没有这些字段。
//       现在统一由各节点 mesh server 在 host_self / mesh_self 里上报，UI 即可展示全部设备。
import { arch, cpus, freemem, hostname, platform, release, totalmem, uptime } from 'node:os'
import { statfsSync } from 'node:fs'

const GiB = 1024 ** 3
const round1 = (n) => Math.round(Number(n) / GiB * 10) / 10

function osLabel() {
  const p = platform()
  const r = String(release() || '')
  if (p === 'win32') {
    const build = Number(String(r).split('.')[2] || 0)
    const name = build >= 22000 ? 'Windows 11' : 'Windows 10'
    return `${name} (${r})`
  }
  if (p === 'darwin') return 'macOS ' + r
  if (p === 'linux') return 'Linux ' + r
  return `${p} ${r}`.trim()
}

/** 系统盘 / 根分区容量（Windows 取 SystemDrive，其他取 /）。失败时 disk=null。 */
function diskInfo() {
  const path = process.platform === 'win32' ? `${process.env.SystemDrive || 'C:'}\\` : '/'
  try {
    const st = statfsSync(path)
    const blockSize = Number(st.bsize || 4096)
    return {
      path,
      totalGB: round1(Number(st.blocks) * blockSize),
      freeGB: round1(Number(st.bavail) * blockSize)
    }
  } catch {
    return null
  }
}

/** 稳定、跨平台的硬件概况（纯只读，不含任何个人/凭据数据）。 */
export function hardwareInfo() {
  const list = cpus()
  const first = list[0] || {}
  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    arch: arch(),
    os: osLabel(),
    cpuModel: String(first.model || '').trim(),
    cpuCores: list.length,
    memTotalGB: round1(totalmem()),
    memFreeGB: round1(freemem()),
    disk: diskInfo(),
    uptimeSec: Math.round(uptime())
  }
}
