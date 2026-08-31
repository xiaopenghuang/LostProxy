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

import {
  CORE_PROBE_TIMEOUT_MS,
  LATENCY_TEST_URL,
  LATENCY_TIMEOUT_MS,
  PORT_PROBE_TIMEOUT_MS,
} from '../shared/constants'
import { errors } from '../shared/errors'
import type {
  ApplyResult,
  GroupsResult,
  MihomoVersion,
  NormalizedError,
  ProviderView,
  ProxyGroup,
  Settings,
} from '../shared/types'

/** `GET /providers/proxies` 的归一化结果。 */
export type ProvidersResult =
  | { readonly ok: true; readonly providers: readonly ProviderView[] }
  | { readonly ok: false; readonly error: NormalizedError }

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
 * 从 `/proxies` 响应里抽取每个节点的最近延迟（V0.3）。
 *
 * 数据来自内核自己的 health-check 产生的 `history`，**读它不产生任何额外网络行为**
 * （ADR-32）。这就是「Popup 打开时显示延迟」能做到零额外请求的原因。
 *
 * `history` 是按时间升序的数组，取最后一条即最近一次。
 * `delay === 0` 在内核语义里表示**测试失败**，不是"0 毫秒"，
 * 所以映射成 null 而不是 0 —— 渲染成 "0ms" 会被读作极快。
 */
export function extractLatency(payload: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  if (typeof payload !== 'object' || payload === null) return out

  const proxies = (payload as Record<string, unknown>)['proxies']
  if (typeof proxies !== 'object' || proxies === null) return out

  for (const [name, raw] of Object.entries(proxies as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const history = (raw as Record<string, unknown>)['history']
    if (!Array.isArray(history) || history.length === 0) continue

    const last = history[history.length - 1]
    if (typeof last !== 'object' || last === null) continue

    const delay = (last as Record<string, unknown>)['delay']
    out[name] = typeof delay === 'number' && delay > 0 ? delay : null
  }

  return out
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

/**
 * `GET /proxies` —— 只为取 history 里的延迟（V0.3）。
 *
 * 为什么不复用 `/group`：组对象的 `all` 只有成员**名字**，没有各成员的 history。
 * 延迟数据在 `/proxies` 里（那是全部 proxy 的字典）。两个端点各取所需：
 * `/group` 拿结构，`/proxies` 拿延迟。
 *
 * 失败时返回空字典而非错误 —— 延迟是**装饰性信息**，取不到应该表现为
 * "没有延迟显示"，不该让整个节点列表变成一个错误页。
 */
export async function getLatencies(settings: Settings): Promise<Record<string, number | null>> {
  try {
    const response = await fetch(`${controllerBaseUrl(settings)}/proxies`, {
      method: 'GET',
      headers: buildHeaders(settings.controllerSecret),
      signal: AbortSignal.timeout(CORE_PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return {}
    return extractLatency(await response.json())
  } catch {
    return {}
  }
}

/**
 * `GET /group/{name}/delay` —— 对整个策略组测速（V0.3）。
 *
 * 用组测速而不是逐个节点发请求：内核会并发处理并一次性返回
 * `{"节点A": 120, "节点B": 350}`，比我们自己发 N 个请求快得多，
 * 也少 N-1 次往返。
 *
 * ⚠️ `timeout` 上限 32767 —— 内核侧是 16 位解析，传更大的值会得到 400（ADR-32）。
 */
export async function testGroupDelay(
  settings: Settings,
  group: string,
): Promise<Record<string, number | null>> {
  const params = new URLSearchParams({
    url: LATENCY_TEST_URL,
    timeout: String(LATENCY_TIMEOUT_MS),
  })
  const url = `${controllerBaseUrl(settings)}/group/${encodeGroupName(group)}/delay?${params}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(settings.controllerSecret),
      // 测速本身要等最慢的节点，超时必须比单次测速上限更宽裕。
      signal: AbortSignal.timeout(LATENCY_TIMEOUT_MS + CORE_PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return {}

    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null) return {}

    const out: Record<string, number | null> = {}
    for (const [name, delay] of Object.entries(payload as Record<string, unknown>)) {
      // 内核对失败的节点返回 0 或干脆不列出。0 映射成 null（见 extractLatency）。
      out[name] = typeof delay === 'number' && delay > 0 ? delay : null
    }
    return out
  } catch {
    return {}
  }
}

/**
 * `GET /providers/proxies` —— 列出订阅（V0.6）。
 *
 * 🔴 响应里**没有订阅 URL**，内核不提供。这正是本项目乐于接受的限制：
 *    不经手就不会泄漏（ADR-34）。若将来内核加了这个字段，
 *    我们也不该读取它。
 */
export async function getProviders(settings: Settings): Promise<ProvidersResult> {
  const url = `${controllerBaseUrl(settings)}/providers/proxies`

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
  if (!response.ok) return { ok: false, error: errors.coreBadResponse() }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, error: errors.coreBadResponse() }
  }

  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: errors.coreBadResponse() }
  }
  const raw = (payload as Record<string, unknown>)['providers']
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: errors.coreBadResponse() }
  }

  const providers: ProviderView[] = []
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>

    /*
     * 全部列出，用 `updatable` 标注哪些能更新（types.ts 有详述）。
     *
     * 只有 HTTP 类型有远端可拉。但**不过滤掉其余的** —— 用 Clash Verge 的用户
     * 通常一个 HTTP provider 都没有（Verge 在外部把订阅拉好、展平成 `proxies:`
     * 再交给内核），过滤后他会看到"没有任何订阅"，而他明明有订阅。
     * 那句话技术上正确但实际误导。
     *
     * ⚠️ 这里也是不读 `url` / `subscriptionInfo` 的地方。内核确实在
     *    `providerForApi` 里带了 `subscriptionInfo`，但那是流量/到期信息，
     *    与订阅地址同属敏感面，本项目一律不经手（ADR-34）。
     */
    const type = typeof e['vehicleType'] === 'string' ? e['vehicleType'] : 'Unknown'
    const proxies = e['proxies']

    providers.push({
      name,
      nodeCount: Array.isArray(proxies) ? proxies.length : 0,
      updatedAt: typeof e['updatedAt'] === 'string' ? e['updatedAt'] : null,
      type,
      updatable: type === 'HTTP',
    })
  }

  // 可更新的排前面 —— 那才是用户到这一栏来想做的事。
  providers.sort((a, b) => {
    if (a.updatable !== b.updatable) return a.updatable ? -1 : 1
    return a.name < b.name ? -1 : 1
  })
  return { ok: true, providers }
}

/**
 * `PUT /providers/proxies/{name}` —— 触发订阅更新（V0.6）。
 *
 * 这是 V0.6 唯一的写操作。添加与删除订阅需要写 config.yaml，
 * 而内核刻意不通过 API 开放文件写入（ADR-34）。
 */
export async function updateProvider(settings: Settings, name: string): Promise<ApplyResult> {
  const url = `${controllerBaseUrl(settings)}/providers/proxies/${encodeGroupName(name)}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: buildHeaders(settings.controllerSecret),
      // 订阅更新要从机场拉配置，比本机操作慢得多，给足时间。
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    return { ok: false, error: errors.coreOffline(settings.controllerHost, settings.controllerPort) }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: errors.coreAuthFailed() }
  }
  if (!response.ok) {
    // 最常见的失败是订阅地址访问不通（机场挂了 / 本机没网 / 订阅过期）。
    return { ok: false, error: errors.subsUpdateFailed(name) }
  }

  return { ok: true }
}

/**
 * 探测本机在监听哪个 Controller 端口。
 *
 * 为什么需要这个：本项目默认 9090，而 Clash Verge Rev 实际是 9097，用户改过
 * 混合端口后 Controller 通常仍在 9097。「端口填错」是开发期间实测的头号失败原因
 * （test-plan §0.2），而它的症状（灰点 / 网页打不开）完全不指向真实原因。
 *
 * 手段是逐个试候选端口的 `/version`。**不做端口扫描** —— 只试一个短的、
 * 由已知客户端默认值构成的白名单，且只连 127.0.0.1。
 * 这与「扫描用户机器」是两件事：我们不枚举范围，只验证几个公开的默认值。
 *
 * 401/403 也算命中：那说明端口上确实是 mihomo，只是需要密钥 ——
 * 对「帮用户找到端口」这个目的来说，这就是成功。
 */
export async function probeControllerPort(
  settings: Settings,
  candidates: readonly number[],
): Promise<number | null> {
  for (const port of candidates) {
    const probe = { ...settings, controllerPort: port }
    try {
      const response = await fetch(`${controllerBaseUrl(probe)}/version`, {
        method: 'GET',
        headers: buildHeaders(settings.controllerSecret),
        // 逐个试，超时必须短 —— 候选有五六个，每个等 3 秒会让用户以为卡死。
        signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS),
      })

      // 有 mihomo 在这个端口上（哪怕需要密钥）。
      if (response.status === 401 || response.status === 403) return port
      if (!response.ok) continue

      const payload: unknown = await response.json()
      if (parseVersion(payload) !== null) return port
    } catch {
      // 连不上就是下一个，不算错误。
      continue
    }
  }
  return null
}
