/**
 * V0.9 时区同步 —— 探测出口地理时区、缓存结果、决定何时重测。
 *
 * ## 为什么这个功能必须探测，不能本地算
 *
 * 节点换了，出口就换了，时区要跟着换。而「这个节点从哪个国家出去」
 * **内核不告诉我们**：`/proxies` 只有 `type` / `name` / `history`，
 * `/connections` 只有目标地址，`/proxies/{name}/delay` 只回毫秒数。
 * 所以唯一的办法是发一个请求出去，问外面「你看到我是哪儿」。
 *
 * 从节点名推断（`日本JP-01` → Asia/Tokyo）成本为零，但它对
 * 「一国多时区」根本无解：`US-01` 是纽约还是洛杉矶？`RU-01` 是莫斯科
 * 还是海参崴？机场的命名风格也无从约束。与其猜错后让用户以为功能坏了，
 * 不如明确地测一次。
 *
 * ## 这个请求必须走代理
 *
 * 探测的意义在于「代理出口在哪」。若请求从本机直连发出，测到的是
 * 用户自己的时区 —— 功能看起来正常工作，实际什么都没做，而且**更糟**：
 * 它会把「本地时区」当成正确答案注入进页面。
 *
 * global / smart 模式下它天然走代理（探测域名不在直连清单里）。
 * `direct` 模式下我们根本不探测（见 `shouldSync`）——
 * 那种模式下用户要的就是直连，没有"出口"可变。
 *
 * ## 与 mihomo.ts 的分工
 *
 * 这里只做「时区」这件事的取数与判断，不碰代理配置、不碰 UI 状态。
 * 何时调用由 `orchestrator.ts` 决定 —— 与 ADR-20 同一条线：
 * 编排决策不下沉到执行模块。
 */

import {
  STORAGE_KEYS,
  TIMEZONE_HOST_MAX_LENGTH,
  TIMEZONE_PROBE_TIMEOUT_MS,
  TIMEZONE_PROBE_URLS,
  ZONE_CACHE_MAX_ENTRIES,
  ZONE_CACHE_TTL_MS,
} from '../shared/constants'
import { coerceNormalizedError, describeThrown, errors } from '../shared/errors'
import { isValidLocale, localeForCountry } from '../shared/locales'
import type { NormalizedError, ObservedIdentity, TimezoneSnapshot } from '../shared/types'
import { installIdentity, type SpoofProfile } from './inject-timezone'

/** 探测结果。失败时带规范化错误，不抛 —— 与 mihomo.ts 的约定一致。 */
export type ZoneProbeResult =
  | {
      readonly ok: true
      readonly zone: string
      /** 出口国家代码；探测源没给时为 null（不影响时区可用）。 */
      readonly country: string | null
      readonly exitIp: string | null
    }
  | { readonly ok: false; readonly error: NormalizedError }

/**
 * 从探测响应里取国家代码。
 *
 * 两个源的字段名不同（`ipinfo` 用 `country`，`ipapi.co` 用 `country_code`），
 * 这里一并接受。校验只做"两个字母"这一条 —— 再严格的校验（比对 ISO 表）
 * 会把表维护成本带进探测层，而错了的后果只是语言同步不生效，
 * 不是注入一个坏值：`localeForCountry` 查不到就返回 null。
 */
function readCountry(record: Record<string, unknown>): string | null {
  for (const key of ['country', 'country_code']) {
    const value = record[key]
    if (typeof value !== 'string') continue
    const code = value.trim().toUpperCase()
    if (/^[A-Z]{2}$/.test(code)) return code
  }
  return null
}

/**
 * 把任意字符串归一成 `Intl` 认的 IANA 名；认不出返回 null。
 *
 * 返回值取自 `resolvedOptions().timeZone` 而不是原样透传：`Intl` 会
 * 规范化大小写与别名（`asia/tokyo` → `Asia/Tokyo`、`Japan` → `Asia/Tokyo`），
 * 而我们要把这个值注入到页面里、并与它比较。存原样会让「看起来一样、
 * 比较却不相等」成为可能。
 *
 * 🔴 这个函数同时是**注入前最后一道闸**：`Intl.DateTimeFormat` 拿到
 *    无效时区会抛 RangeError，而这个值最终会进到页面脚本里。
 *    在那里抛错会让整段注入失效 —— 页面恢复成真实时区，且毫无提示。
 */
export function normalizeZone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  // IANA 名最长的是 "America/Argentina/ComodRivadavia" 一类的 32 字符级别；
  // 64 足够宽松，同时又挡住把整个响应体塞进来的情况。
  if (trimmed.length === 0 || trimmed.length > 64) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/**
 * 探测当前出口 IP 的地理时区 —— 按 `TIMEZONE_PROBE_URLS` 的顺序依次尝试。
 *
 * 降级的触发条件很宽：网络失败、非 2xx（含 429 限流）、响应里没有可识别的
 * 时区 —— 任何一种都换下一个源。理由写在常量那边：免费服务按**请求方 IP**
 * 限流，而我们的出口是共享的节点 IP，撞限额是常态而非意外。
 *
 * 全部失败时返回**最后一个**错误。这不是任意选择：最后一个源通常是最新
 * 尝试、也就最能代表"现在的网络状况"，而后面的错误往往才是根因
 * （第一个源的失败可能只是它自己被限流）。
 */
export async function probeExitZone(): Promise<ZoneProbeResult> {
  let lastError: NormalizedError | null = null

  for (const url of TIMEZONE_PROBE_URLS) {
    const result = await probeOnce(url)
    if (result.ok) return result
    lastError = result.error
  }

  return { ok: false, error: lastError ?? errors.timezoneProbeFailed('no probe source') }
}

/**
 * 向单个源发一次请求。
 *
 * ⚠️ `credentials: 'omit'` 不是可选优化：带上 cookie 就等于把一个
 *    可追踪的标识交给第三方，而这个请求的全部目的只是问一句"我在哪"。
 *
 * ⚠️ `cache: 'no-store'` 同样是必须项：命中缓存会返回上一个节点的结果，
 *    于是换了节点时区却不变 —— 一个只会偶发、且看起来像"同步坏了"的 bug。
 */
async function probeOnce(url: string): Promise<ZoneProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEZONE_PROBE_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    })

    if (!response.ok) {
      return { ok: false, error: errors.timezoneProbeFailed(`HTTP ${response.status}`) }
    }

    const body: unknown = await response.json()
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}

    const zone = normalizeZone(record.timezone)
    if (zone === null) {
      /*
       * 走到这里说明服务通了、但没给出我们认得的时区。
       * 把原值报出来（截断到 40 字符）：这是个不该发生的分支，
       * 一旦发生，那串字符就是唯一的线索。
       */
      const raw = record.timezone
      const shown = typeof raw === 'string' ? raw.slice(0, 40) : '(missing)'
      return { ok: false, error: errors.timezoneInvalidZone(shown) }
    }

    const exitIp = typeof record.ip === 'string' ? record.ip : null
    return { ok: true, zone, country: readCountry(record), exitIp }
  } catch (thrown) {
    /*
     * 超时与网络失败报同一条错误码，但文案不同 —— 用户按 timeout 排查
     * （换节点、代理不通）和按 DNS 失败排查，方向并不一样。
     */
    const reason =
      thrown instanceof Error && thrown.name === 'AbortError'
        ? 'timeout'
        : describeThrown(thrown).slice(0, 80)
    return { ok: false, error: errors.timezoneProbeFailed(reason) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读时区快照。缺失或损坏时返回 null，**永不抛错**。
 *
 * 与 `getLastError` 同一条纪律：storage 里的东西可能来自旧版本或被手工改坏，
 * 它不能让 Service Worker 起不来。
 */
export async function getTimezoneSnapshot(): Promise<TimezoneSnapshot | null> {
  const record = await chrome.storage.local.get(STORAGE_KEYS.timezone)
  const raw = record[STORAGE_KEYS.timezone]
  if (typeof raw !== 'object' || raw === null) return null

  const candidate = raw as Partial<Record<keyof TimezoneSnapshot, unknown>>
  const country =
    typeof candidate.country === 'string' && /^[A-Z]{2}$/.test(candidate.country)
      ? candidate.country
      : null

  /*
   * locale 优先取存下来的值，取不到就用 country 重新推导。
   *
   * 这条兼容分支不是可有可无：V0.9 的快照里根本没有这两个字段，
   * 升级上来的用户如果只能等下一次探测，那么在 TTL 窗口内
   * （最长 10 分钟、或直到换节点）语言同步就是不生效的 ——
   * 而他没有任何办法知道"再等一下就好"。
   */
  const stored = isValidLocale(candidate.locale) ? candidate.locale : null
  const locale = stored ?? localeForCountry(country)

  return {
    // zone 走同一套归一：旧快照里可能存着一个我们后来不再认的值。
    zone: normalizeZone(candidate.zone),
    country,
    locale,
    exitIp: typeof candidate.exitIp === 'string' ? candidate.exitIp : null,
    at: typeof candidate.at === 'number' ? candidate.at : 0,
    node: typeof candidate.node === 'string' ? candidate.node : null,
    error: coerceNormalizedError(candidate.error),
  }
}

/** 写入时区快照。 */
export async function setTimezoneSnapshot(snapshot: TimezoneSnapshot): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.timezone]: snapshot })
}

/*
 * 这里曾经有一个 `clearTimezoneSnapshot()`，用于"用户关掉功能时清除快照"。
 * 它从未被任何路径调用，而且**不该**被调用 —— 理由与直觉相反：
 *
 *   关掉再打开是常见操作。如果关闭时把快照清掉，重新打开后的第一次导航
 *   会走慢路径（读节点名 + 一次探测，可能几秒），而这条路径的全部意义
 *   就是赶在页面脚本之前完成注入。慢了，功能就静默失效一次，用户看到的是
 *   "刚打开时不管用，刷新一下就好了"。
 *
 * 留着快照、靠 TTL 与节点变化让它自然过期，才是对的。功能关闭期间
 * 不会读它（`collectStatus` 里有开关判断），所以不存在误用的风险。
 *
 * 注意这与**请求头规则**不同：规则必须清（见 `netrule.ts`），因为它会
 * 真的改写用户的出站请求；而快照只是一份本地缓存。
 */

/**
 * 一个节点的探测结果。
 *
 * 与 `TimezoneSnapshot` 几乎同形，但**不含 node** —— 在这张表里它是 key。
 * 分开定义而不是复用，是因为快照还带着 `error` 这种"这一次怎么样"的
 * 状态，而缓存里只该有"这个节点是什么样"的事实。
 */
export interface ZoneCacheEntry {
  readonly zone: string
  readonly country: string | null
  readonly locale: string | null
  readonly exitIp: string | null
  /** 上次**真正探测**到它的时间。不是"上次用到它"的时间。 */
  readonly at: number
}

/**
 * 读整张节点缓存，宽容解析。
 *
 * 与 `getTimezoneSnapshot` 同一条纪律：这张表可能来自旧版本、也可能被
 * 手工改坏，而它只是加速手段 —— 任何一条读不懂就丢掉，绝不让整个功能
 * 因为缓存坏了而起不来。
 */
async function readZoneCache(): Promise<Record<string, ZoneCacheEntry>> {
  let raw: unknown
  try {
    const record = await chrome.storage.local.get(STORAGE_KEYS.zoneCache)
    raw = record[STORAGE_KEYS.zoneCache]
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null) return {}

  const entries: Record<string, ZoneCacheEntry> = {}
  for (const [node, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const candidate = value as Record<string, unknown>

    // zone 走同一套归一：缓存里可能存着一个我们后来不再认的值。
    const zone = normalizeZone(candidate.zone)
    if (zone === null) continue

    entries[node] = {
      zone,
      country: typeof candidate.country === 'string' ? candidate.country : null,
      locale: isValidLocale(candidate.locale) ? candidate.locale : null,
      exitIp: typeof candidate.exitIp === 'string' ? candidate.exitIp : null,
      at: typeof candidate.at === 'number' ? candidate.at : 0,
    }
  }
  return entries
}

/**
 * 查一个节点的缓存。没有、太旧、或读不懂时返回 null。
 *
 * 🔴 过期判据是**探测时间**而不是使用时间 —— 一个节点被反复切换时，
 *    若按"上次用到"续期，缓存可以永远不过期。而这个 TTL 存在的理由正是
 *    "同一个节点名不代表同一个落地 IP"，与用了多少次无关。
 */
export async function lookupCachedZone(node: string): Promise<ZoneCacheEntry | null> {
  if (node.length === 0) return null

  const cache = await readZoneCache()
  const entry = cache[node]
  if (entry === undefined) return null
  if (entry.at <= 0) return null
  if (Date.now() - entry.at > ZONE_CACHE_TTL_MS) return null
  return entry
}

/**
 * 记住一个节点的探测结果，并顺手淘汰。
 *
 * 淘汰规则很简单：先扔掉超龄的，再按探测时间保留最新的若干条。
 * 缓存是加速手段，不是数据 —— 为它设计复杂的 LRU 不划算，而"按时间"
 * 已经足够：常用节点自然会被反复刷新，冷门节点被挤掉也无所谓。
 *
 * 写失败**不抛**：缓存丢掉只意味着下次多一次请求。
 */
export async function rememberZone(
  node: string | null,
  entry: Omit<ZoneCacheEntry, 'at'>,
): Promise<void> {
  if (node === null || node.length === 0) return

  try {
    const cache = await readZoneCache()
    const now = Date.now()
    cache[node] = { ...entry, at: now }

    const kept = Object.entries(cache)
      .filter(([, value]) => now - value.at <= ZONE_CACHE_TTL_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, ZONE_CACHE_MAX_ENTRIES)

    await chrome.storage.local.set({ [STORAGE_KEYS.zoneCache]: Object.fromEntries(kept) })
  } catch {
    // 见上。
  }
}

/**
 * 记录一次失败。
 *
 * 三件事同时发生，每一件都有理由：
 *
 * 1. **保留旧时区。** 同一条链路上一次临时失败（节点抖动、DNS 抖动）
 *    不代表旧的时区已经错了。清空它只会让下一次导航重新走慢路径，
 *    而结果很可能还是一样。
 *
 * 2. **刷新 `at`。** 这是刻意的"退避"：不刷新的话快照会永远处于过期状态，
 *    于是每一次页面加载都重试一次探测 —— 撞上 429 时，那等于自己把
 *    限流撞得更狠，越失败越失败。
 *
 * 3. **记下原因。** 页面加载路径上的探测是静默的，不留痕的话用户只能看到
 *    一个「未同步」，没有任何地方说得清为什么。
 */
export function failedSnapshot(
  previous: TimezoneSnapshot | null,
  error: NormalizedError,
  node: string | null,
): TimezoneSnapshot {
  return {
    zone: previous?.zone ?? null,
    // country/locale 与 zone 同等对待：一次失败不代表上次认定的出口国也错了，
    // 保留它们才能让"旧的伪装档案继续生效"，而不是退化成半个（只改时区）。
    country: previous?.country ?? null,
    locale: previous?.locale ?? null,
    exitIp: previous?.exitIp ?? null,
    at: Date.now(),
    node: previous?.node ?? node,
    error,
  }
}

/**
 * 快照是否已过期，需要重新探测。
 *
 * 判据是**时间**而不是节点名。这一条是刻意的取舍，理由在页面加载这条
 * 路径上：`handleTabLoading` 必须在页面脚本跑起来之前完成注入，而
 * 「读节点名」要打一次 Controller 请求 —— 客户端没开 HTTP 控制器时
 * 那是一次 3 秒超时（ADR-23 里那种 named pipe 用法很常见）。
 * 让每次导航都付这个代价，等于把注入推迟到页面脚本之后，功能静默失效。
 *
 * 代价是「在外部客户端里换了节点」我们收不到通知，最坏等一个 TTL。
 * 期间用户可以点设置页的「立即探测」立刻纠正。
 */
export function isSnapshotStale(
  snapshot: TimezoneSnapshot | null,
  ttlMs: number,
): boolean {
  if (snapshot === null || snapshot.zone === null) return true
  if (snapshot.at <= 0) return true
  return Date.now() - snapshot.at > ttlMs
}

/**
 * 某个 URL 是否需要注入时区。
 *
 * 匹配规则：填 `chatgpt.com` 同时覆盖 `chatgpt.com` 与 `www.chatgpt.com`。
 * 与 `directRules` 的书写习惯保持一致 —— 用户不需要为了覆盖子域
 * 额外写一条 `*.`。
 */
export function matchesHost(url: string, hosts: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false

  const host = parsed.hostname.toLowerCase()
  return hosts.some((candidate) => {
    const target = candidate.trim().toLowerCase()
    if (target.length === 0) return false
    return host === target || host.endsWith(`.${target}`)
  })
}

/** 域名清单能否被浏览器接受为注入目标。 */
export function isValidHostPattern(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const host = value.trim()
  if (host.length === 0 || host.length > TIMEZONE_HOST_MAX_LENGTH) return false
  /*
   * 只接受普通域名，不接受通配、路径、端口、协议头。
   *
   * 这里刻意比 `directRules` 更严：直连规则只会被拼进 PAC 的字符串比较，
   * 而这份清单会变成 `chrome.permissions.request` 的 origins 与
   * `executeScript` 的目标 —— 一个写错的条目会表现为「授权弹窗里出现
   * 一个奇怪的来源」，或者在用户看不懂的情况下请求了过宽的权限。
   */
  if (host.includes('*') || host.includes('/') || host.includes(':') || host.includes(' ')) {
    return false
  }
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)
}

/**
 * 把域名清单转成 `match pattern`，用于 `permissions.request` 与注入。
 *
 * `*://*.example.com/*` 在 Chromium 的语义里**同时覆盖裸域与子域**，
 * 所以一条就够，不需要为 `example.com` 和 `*.example.com` 各写一个。
 */
export function toOriginPatterns(hosts: readonly string[]): string[] {
  return hosts.map((host) => `*://*.${host.trim().toLowerCase()}/*`)
}

/**
 * 是否具备向这些域名注入的权限。
 *
 * ⚠️ 必须在**注入前**查，而不是等 `executeScript` 抛错：
 *    后者抛出的是一句面向开发者的英文（"Cannot access contents of the page"），
 *    塞进 UI 对用户毫无指导意义，而这个问题他点一下按钮就能修好。
 */
export async function hasInjectionPermission(hosts: readonly string[]): Promise<boolean> {
  if (hosts.length === 0) return false
  try {
    return await chrome.permissions.contains({ origins: toOriginPatterns(hosts) })
  } catch {
    // 权限 API 在某些环境下不可用；当作没有，让调用方走"去授权"那条路。
    return false
  }
}

/**
 * 把地理身份装进指定标签页的所有 frame。
 *
 * 🔴 这里传的是**函数引用**而不是代码字符串。`executeScript` 会把这个
 *    函数 `toString()` 之后序列化到页面里执行，因此 `installIdentity`
 *    必须完全自包含 —— 它内部不能引用任何模块作用域的东西（打包之后
 *    那些引用要么被重命名、要么根本不在页面上）。这条约束由
 *    `tests/identity-inject.test.ts` 用「序列化后单独执行」守着。
 *
 * 参数传对象而不是两个位置参数：`zone` 与 `locale` 来自同一次探测，
 * 必须一起生效。分两次注入会留出一个"时区已经改了、语言还是旧的"窗口，
 * 而这个窗口里的组合恰好是最容易被识别的。
 *
 * 返回值表示是否成功注入，不用于区分失败原因 —— 原因由调用方在
 * 注入前用 `hasInjectionPermission` 判定过了。
 */
export async function injectIdentityInto(tabId: number, profile: SpoofProfile): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      injectImmediately: true,
      func: installIdentity,
      args: [profile],
    })
    return true
  } catch {
    return false
  }
}

/**
 * 从快照里取出可注入的档案。
 *
 * 没有时区时返回 null —— 单有语言不值得注入：一个只改了语言、时区仍是
 * 本地的页面，比原样不动更容易被识别，因为它同时暴露了"这个人改了东西"
 * 和"他不知道自己在哪"。
 *
 * @param includeLocale 语言同步开关是否打开。关着时返回的档案 `locale`
 *   一律为 null，页面侧就只改时区 —— 这条判断必须在**取档案时**做，
 *   而不是让调用方自己改返回值：少写一次就是"用户关了开关，语言照改"。
 */
export function profileFrom(
  snapshot: TimezoneSnapshot | null,
  includeLocale: boolean,
): SpoofProfile | null {
  if (snapshot === null || snapshot.zone === null) return null
  return { zone: snapshot.zone, locale: includeLocale ? snapshot.locale : null }
}

/**
 * 把所有已打开、且域名列在清单里的标签页重新注入一遍。
 *
 * 用途只有一个：用户刚点了「立即探测」或刚换了节点，此时那些页面
 * 已经加载完了，不会再有 `tabs.onUpdated` 事件。不补这一下，
 * 用户会得到一个「时区已同步」的提示和一个仍然是旧时区的页面 ——
 * 而两者之间没有任何可见的因果关系。
 *
 * ⚠️ 仍然改不了已经跑起来的页面里的既有状态（例如已创建的 Date 对象、
 *    已经缓存的 Intl 实例）。所以 UI 上还有一句「已打开的标签页要刷新」。
 *
 * 返回成功注入的标签页数，供调用方决定是否提示用户刷新。
 */
export async function reinjectOpenTabs(
  hosts: readonly string[],
  profile: SpoofProfile,
): Promise<number> {
  if (hosts.length === 0) return 0

  let tabs: readonly chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return 0
  }

  let injected = 0
  for (const tab of tabs) {
    if (tab.id === undefined || tab.url === undefined) continue
    if (!matchesHost(tab.url, hosts)) continue
    if (await injectIdentityInto(tab.id, profile)) injected++
  }
  return injected
}


/**
 * 找清单里第一个**已经打开**的标签页。
 *
 * 为什么不提供"取活动标签页"这个更直觉的接口：设置页点自检时，活动的
 * 那个正是设置页自己。直觉上的"检查我现在看的页面"在这个功能里必然指错。
 */
export async function findOpenTab(hosts: readonly string[]): Promise<chrome.tabs.Tab | null> {
  if (hosts.length === 0) return null

  let tabs: readonly chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return null
  }

  for (const tab of tabs) {
    if (tab.url === undefined) continue
    if (matchesHost(tab.url, hosts)) return tab
  }
  return null
}

/**
 * 在目标页面的主 world 里实测一次身份。
 *
 * 这是自检里唯一**不能靠推断得出**的部分：其它几项问的是"配置对不对"，
 * 它问的是"页面里现在到底是什么"。配置全对而页面没生效是最常见的情况
 * （改完设置没刷新），只看配置的自检会给出一句"一切正常" —— 那比不查更糟。
 *
 * ⚠️ 读不到时返回 null 而不是抛：缺权限、页面刚关闭、站点禁止注入，
 *    都会走到这里，而"读不到"本身就是一个需要报告的结论。
 */
export async function readPageIdentity(tabId: number): Promise<ObservedIdentity | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => ({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        language: navigator.language,
      }),
    })

    const result = results[0]?.result as ObservedIdentity | undefined
    if (result === undefined) return null
    if (typeof result.timezone !== 'string') return null
    return result
  } catch {
    return null
  }
}
