/**
 * Mihomo Controller API 客户端 —— 对应技术方案 §28 Task 04 / §15。
 *
 * V0.1 实现 `GET /version`（探活）；V0.2 增加 `GET /group` 与
 * `PUT /proxies/{name}`（切换节点）。delay 测速留给 V0.3。
 *
 * 🔴 安全约束（security.md §2.1 / §2.3）：
 *   Controller Secret 只出现在 Authorization 请求头里。
 *   它**绝不**进入：错误信息、console 输出、URL query、异常堆栈。
 *   本文件里凡是构造字符串的地方都要按这条自查。
 */

import { CORE_PROBE_TIMEOUT_MS } from '../shared/constants'
import { errors } from '../shared/errors'
import type {
  ApplyResult,
  GroupsResult,
  MihomoVersion,
  NormalizedError,
  ProxyGroup,
  Settings,
} from '../shared/types'

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

/* ==================== V0.2 节点切换 ==================== */

/**
 * 把策略组名编码进 URL 路径。
 *
 * 🔴 必须用 encodeURIComponent，见 architecture.md ADR-30。
 *    组名是**完全由用户订阅决定的**不可信输入，机场普遍用
 *    `🇭🇰 香港 | 专线` 这类名字。不编码的话：
 *      - 名字里的 `/` 会把一条路径劈成两段，命中错误的路由
 *      - 空格与非 ASCII 构造出非法 URL
 *      - `?` `#` 会让后半截被当成 query / fragment 丢掉
 *
 * ⚠️ 别"优化"成模板字符串直接拼。单元测试对空格 / `|` / emoji / `/`
 *    各锁了一条断言，就是为了拦住这种改动。
 */
function encodeGroupName(name: string): string {
  return encodeURIComponent(name)
}

/** 把一个未知形状的对象解析成 ProxyGroup，形状不对就返回 null。 */
function parseGroup(raw: unknown): ProxyGroup | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>

  const name = candidate['name']
  if (typeof name !== 'string' || name.length === 0) return null

  const all = candidate['all']
  if (!Array.isArray(all)) return null
  // 成员列表里混入非字符串就整条丢掉——宁可当这个组读不到，
  // 也不要让 UI 渲染出一个点了会失败的条目。
  if (!all.every((m): m is string => typeof m === 'string')) return null

  const type = candidate['type']
  const now = candidate['now']

  return {
    name,
    type: typeof type === 'string' ? type : 'Unknown',
    // LoadBalance 组没有 now 字段，这是正常的而非异常（types.ts 有说明）。
    now: typeof now === 'string' && now.length > 0 ? now : null,
    all,
  }
}

/**
 * `GET /group` —— 拉取全部策略组。
 *
 * 用 `/group` 而不是 `/proxies`：后者返回**所有** proxy（含每一个节点），
 * 一份大订阅能有几百条，其中绝大多数我们不需要。`/group` 只返回策略组，
 * 而策略组对象里已经带了 `all`（成员名列表），正好是渲染节点列表要的东西。
 *
 * 错误归一化复用 §22 的同一套映射（连不上 / 认证失败 / 脏响应），
 * 保证「Controller 有问题」在插件里始终是同一种表述。
 */
export async function getGroups(settings: Settings): Promise<GroupsResult> {
  const url = `${controllerBaseUrl(settings)}/group`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(settings.controllerSecret),
      signal: AbortSignal.timeout(CORE_PROBE_TIMEOUT_MS),
    })
  } catch {
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
    return { ok: false, error: errors.coreBadResponse() }
  }

  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: errors.coreBadResponse() }
  }
  const rawGroups = (payload as Record<string, unknown>)['proxies']
  if (!Array.isArray(rawGroups)) {
    return { ok: false, error: errors.coreBadResponse() }
  }

  // 逐条解析，脏条目跳过而不是整体失败——一个组的字段异常
  // 不该让用户连其他正常的组都选不了。
  const groups = rawGroups
    .map(parseGroup)
    .filter((g): g is ProxyGroup => g !== null)

  return { ok: true, groups }
}

/**
 * `PUT /proxies/{group}` —— 切换某个策略组的选中节点。
 *
 * **刻意不预先检查组类型**（architecture.md ADR-29）：能否手动切换由内核判定，
 * 它的规则随版本变化。我们把请求发出去，`400` 时如实翻译内核的拒绝。
 *
 * 状态码映射：
 *   - 204 → 成功（内核用 NoContent 回应，没有响应体）
 *   - 404 → 组不存在（订阅换了、组名改了）
 *   - 400 → 该组不支持手动切换（`Must be a Selector`）
 *
 * ⚠️ 不把内核返回的错误文本拼进用户文案：那段文本是英文的、面向开发者的，
 *    而且我们无法保证它将来不包含 URL 之类的内容。改成按状态码映射到
 *    我们自己的 i18n 文案（security.md §2.3 的同一条纪律）。
 */
export async function selectNode(
  settings: Settings,
  group: string,
  node: string,
): Promise<ApplyResult> {
  const url = `${controllerBaseUrl(settings)}/proxies/${encodeGroupName(group)}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: { ...buildHeaders(settings.controllerSecret), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: node }),
      signal: AbortSignal.timeout(CORE_PROBE_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: errors.coreOffline(settings.controllerHost, settings.controllerPort) }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: errors.coreAuthFailed() }
  }
  if (response.status === 404) {
    return { ok: false, error: errors.groupNotFound(group) }
  }
  if (response.status === 400) {
    // 内核对「不是 Selector」和「成员名不存在」都回 400。后者在正常流程里
    // 不该发生（列表就是内核给的），所以归到更可能的那个原因上。
    return { ok: false, error: errors.groupNotSelectable(group) }
  }
  if (!response.ok) {
    return { ok: false, error: errors.selectFailed(node) }
  }

  return { ok: true }
}
