/**
 * Mihomo Controller API 客户端 —— 对应技术方案 §28 Task 04 / §15。
 *
 * V0.1 只实现 `GET /version`（探活）。/proxies、/group、delay 等留给 V0.2+，
 * 提前实现属于超出范围（§5 / §29.2）。
 *
 * 🔴 安全约束（security.md §2.1 / §2.3）：
 *   Controller Secret 只出现在 Authorization 请求头里。
 *   它**绝不**进入：错误信息、console 输出、URL query、异常堆栈。
 *   本文件里凡是构造字符串的地方都要按这条自查。
 */

import { CORE_PROBE_TIMEOUT_MS } from '../shared/constants'
import { errors } from '../shared/errors'
import type { MihomoVersion, NormalizedError, Settings } from '../shared/types'

/** 探活结果。 */
export type ProbeResult =
  | { readonly ok: true; readonly version: MihomoVersion }
  | { readonly ok: false; readonly error: NormalizedError }

/**
 * 把 host 格式化为可安全嵌入 URL 的形式。
 *
 * IPv6 字面量在 URL 里必须用方括号包裹（`::1` → `[::1]`），
 * 否则冒号会被当作端口分隔符解析。用户在 Settings 里填 `::1` 是合理输入，
 * 不该因为我们没处理而失败。
 */
function formatHost(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}

/** 构造 Controller 的 base URL。 */
export function controllerBaseUrl(settings: Settings): string {
  return `http://${formatHost(settings.controllerHost)}:${settings.controllerPort}`
}

/**
 * 构造请求头。
 *
 * 技术方案 §15：用户没有配置 secret 时**不发送** Authorization 头。
 * 这不只是"省一个头"——Mihomo 在未配置 secret 时，
 * 收到一个空的 Bearer 头可能反而被判为认证失败。
 */
export function buildHeaders(secret: string): Record<string, string> {
  if (secret.length === 0) return {}
  return { Authorization: `Bearer ${secret}` }
}

/** 判断响应体是否是 Mihomo 的版本信息。 */
function parseVersion(payload: unknown): MihomoVersion | null {
  if (typeof payload !== 'object' || payload === null) return null

  const candidate = payload as Partial<MihomoVersion>
  if (typeof candidate.version !== 'string' || candidate.version.length === 0) return null

  // meta 字段在部分内核/版本上可能缺失，宽容处理——
  // 探活的目的是"能不能连上"，不是"是不是 Meta 分支"。
  return { meta: candidate.meta === true, version: candidate.version }
}

/**
 * `GET /version` —— Controller 探活。
 *
 * 错误归一化对应技术方案 §22：
 *   - 连不上 / 超时       → CORE_OFFLINE     （Case 1）
 *   - 401 / 403          → CORE_AUTH_FAILED （Case 2）
 *   - 其他非 2xx / 脏响应 → CORE_BAD_RESPONSE（端口很可能指向了别的服务）
 *
 * 超时用 AbortSignal.timeout()：本机回环 3 秒足够，
 * 没有超时的话 Controller 端口被某个不响应的服务占用时 UI 会无限期干等。
 */
export async function getVersion(settings: Settings): Promise<ProbeResult> {
  const url = `${controllerBaseUrl(settings)}/version`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(settings.controllerSecret),
      signal: AbortSignal.timeout(CORE_PROBE_TIMEOUT_MS),
    })
  } catch {
    // 网络不可达、超时、DNS 失败等一律归为"Core 没起来"。
    // 刻意不把捕获到的异常信息拼进文案——它可能包含完整 URL，
    // 而 URL 虽不含 secret，也没有必要暴露给用户看。
    return { ok: false, error: errors.coreOffline(settings.controllerHost, settings.controllerPort) }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: errors.coreAuthFailed() }
  }

  if (!response.ok) {
    return { ok: false, error: errors.coreBadResponse() }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    // 200 但不是 JSON —— 端口大概指向了某个网页服务而不是 external-controller。
    return { ok: false, error: errors.coreBadResponse() }
  }

  const version = parseVersion(payload)
  if (version === null) {
    return { ok: false, error: errors.coreBadResponse() }
  }

  return { ok: true, version }
}
