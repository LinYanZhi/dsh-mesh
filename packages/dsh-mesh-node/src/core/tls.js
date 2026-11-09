/**
 * TLS：自签证书生成与校验信息读取。
 *
 * 为什么需要：樱花穿透的 TCP 隧道默认不加密（只有「访问认证」，没有传输加密），
 * Bearer token 与所有 MCP 报文都会明文过公网。跨网阶段必须自带 TLS。
 *
 * 设计取舍：
 * - 自签「CA-and-leaf」证书（basicConstraints CA:true + serverAuth EKU），这样对端
 *   把 cert.pem 当作信任锚（NODE_EXTRA_CA_CERTS）就能通过校验，不需要额外 CA 基础设施。
 * - SAN 里默认包含 localhost / 127.0.0.1 / 本机 hostname；樱花隧道建好后用
 *   `--san <节点域名>` 重新生成（或首次生成时一次给全）。
 * - 私钥 0600 落 `~/.dsh-mesh/tls/key.pem`，不进 git、不进任何快照。
 */

import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import selfsigned from 'selfsigned'

/** TLS 文件目录。 */
export function tlsDir(home) {
  return join(home, 'tls')
}

/** 证书路径（可在 config.tls.cert 覆盖）。 */
export function certPath(home) {
  return join(tlsDir(home), 'cert.pem')
}

/** 私钥路径（可在 config.tls.key 覆盖）。 */
export function keyPath(home) {
  return join(tlsDir(home), 'key.pem')
}

/** 是否已生成证书。 */
export function hasCert(home) {
  return existsSync(certPath(home)) && existsSync(keyPath(home))
}

/** 判断字符串是不是 IPv4/IPv6 字面量。 */
function isIp(value) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || /^[0-9a-f:]+$/i.test(value) && value.includes(':')
}

/** 构造 SAN 列表：总是包含本机可用的默认项，再合并调用方给的。 */
export function buildAltNames(extra = []) {
  const names = new Set(['localhost', '127.0.0.1', osHostname()])
  for (const item of extra) {
    const value = String(item).trim()
    if (value.length > 0) names.add(value)
  }
  return [...names].map(value => (isIp(value) ? { type: 7, ip: value } : { type: 2, value }))
}

/**
 * 生成自签证书。
 * @returns {{certPath: string, keyPath: string, info: object}}
 */
export async function generateCert({ home, sans = [], days = 825, keySize = 2048, commonName, force = false }) {
  const dir = tlsDir(home)
  mkdirSync(dir, { recursive: true })
  if (!force && hasCert(home)) {
    return { certPath: certPath(home), keyPath: keyPath(home), info: describeCert(home), reused: true }
  }
  const altNames = buildAltNames(sans)
  const attrs = [{ name: 'commonName', value: commonName ?? `dsh-mesh-${osHostname()}` }]
  const pems = await selfsigned.generate(attrs, {
    days,
    keySize,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  })
  writeFileSync(certPath(home), pems.cert, { mode: 0o644 })
  writeFileSync(keyPath(home), pems.private, { mode: 0o600 })
  return { certPath: certPath(home), keyPath: keyPath(home), info: describeCert(home), reused: false, sans: altNames }
}

/** 读取证书的人类可读信息（也用于 `tls info`）。 */
export function describeCert(home) {
  if (!hasCert(home)) return { present: false }
  const cert = new X509Certificate(readFileSync(certPath(home)))
  return {
    present: true,
    certPath: certPath(home),
    keyPath: keyPath(home),
    subject: cert.subject.replace(/\n/g, ', '),
    issuer: cert.issuer.replace(/\n/g, ', '),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    validToDate: new Date(cert.validTo).toISOString(),
    fingerprint256: cert.fingerprint256,
    serialNumber: cert.serialNumber,
    subjectAltName: cert.subjectAltName,
    selfSigned: cert.subject === cert.issuer,
  }
}

/** 供 https.createServer 使用的证书对。路径缺失时抛结构化错误。 */
export function loadTlsMaterial({ home, cert, key }) {
  const certFile = cert || certPath(home)
  const keyFile = key || keyPath(home)
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    const error = new Error(`TLS 已启用但缺少证书：${certFile} / ${keyFile}，先跑 \`node src/cli.js tls init\``)
    error.code = 'E_TLS_MISSING'
    throw error
  }
  return { cert: readFileSync(certFile), key: readFileSync(keyFile), certFile, keyFile }
}

/**
 * 证书指纹规范化：大小写无关、去掉冒号/空格，统一成 64 位大写 hex。
 *
 * 为什么需要它：`mesh_self` / `tls info` / `pair --code` 打印的是
 * `AA:BB:...` 形式（X509Certificate.fingerprint256），而 socket 拿到的也是这种，
 * 但人手工粘贴时常带上小写或漏冒号 —— 直接字符串比较会假失败。
 */
export function normalizeFingerprint(value) {
  const compact = String(value || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase()
  if (compact.length !== 64) {
    const error = new Error(`证书指纹应为 64 位 hex（SHA-256），收到 ${compact.length} 位`)
    error.code = 'E_BAD_FINGERPRINT'
    throw error
  }
  return compact
}

/** 从 TLS socket 上取对端证书指纹，返回规范化的 64 位 hex。 */
export function fingerprintOfSocket(socket) {
  const cert = socket?.getPeerCertificate?.()
  if (!cert || !cert.fingerprint256) {
    const error = new Error('对端没有提供证书，无法核对指纹')
    error.code = 'E_NO_PEER_CERT'
    throw error
  }
  return normalizeFingerprint(cert.fingerprint256)
}

/** 固定指纹校验：expected / actual 都规范化后比较，失败抛 E_PIN_MISMATCH。 */
export function assertFingerprint(expected, actual) {
  const want = normalizeFingerprint(expected)
  const got = normalizeFingerprint(actual)
  if (want !== got) {
    const error = new Error(
      `证书指纹不匹配（可能被中间人替换或证书已轮换）\n  期望 ${want}\n  实际 ${got}`
    )
    error.code = 'E_PIN_MISMATCH'
    error.expected = want
    error.actual = got
    throw error
  }
  return got
}
