/**
 * Minimal HTTP(S) JSON POST used for peer pairing.
 *
 * 两个安全选项：
 * - `caPath`：信任一张自签证书（标准信任链校验）。
 * - `fingerprint`：TOFU 固定指纹 —— 先不判信任链（自签必然不过），抓 socket 上的
 *   对端证书算 SHA-256，再和人工核对过的指纹比对；不一致直接 `E_PIN_MISMATCH`。
 *
 * 抽成独立文件是为了让 e2e 能直接测（cli.js 有 main 副作用，不适合被 import）。
 */
import { fingerprintOfSocket, assertFingerprint } from './tls.js'

export async function postJson(urlString, body, { caPath, fingerprint } = {}) {
  const isHttps = String(urlString).startsWith('https:')
  const { request } = await import(isHttps ? 'node:https' : 'node:http')
  const { readFileSync } = await import('node:fs')
  const options = { method: 'POST', headers: { 'content-type': 'application/json' } }
  if (isHttps && caPath) options.ca = readFileSync(caPath)
  // 固定指纹时先不判信任链（自签必然不过），拿到 socket 证书后自己比对指纹。
  // 这是 TOFU 的标准做法：信任来自「配对码那条可信信道」里带出来的指纹，而不是 CA。
  if (isHttps && fingerprint) {
    options.rejectUnauthorized = false
    // 关键：不能复用 keep-alive 连接 —— 复用时会话已建立，secureConnect 不会再触发，
    // 指纹校验就会被跳过。每次固定指纹请求都开新连接。
    options.agent = false
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const req = request(urlString, options, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
      })
      res.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = { raw: text }
        }
        resolvePromise({ status: res.statusCode, body: parsed, fingerprint: req.__meshFingerprint })
      })
    })
    if (isHttps && fingerprint) {
      req.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          try {
            const got = fingerprintOfSocket(socket)
            assertFingerprint(fingerprint, got)
            req.__meshFingerprint = got
          } catch (error) {
            req.destroy(error)
          }
        })
      })
    }
    req.setTimeout(20000, () => req.destroy(new Error('timeout')))
    req.on('error', rejectPromise)
    req.end(JSON.stringify(body ?? {}))
  })
}
