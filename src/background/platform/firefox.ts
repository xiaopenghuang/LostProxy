/**
 * Firefox 平台实现。
 *
 * 契约与两个平台的完整差异对照见 `types.ts` 文件头那张表。
 * 本文件只放「Firefox 这套 API 怎么调」，不放任何「该不该调」的判断。
 *
 * ## 三个必须一次做对的地方
 *
 * 1. **`httpProxyAll: true` 不能省。** MDN 原话：「Any omitted properties are
 *    reset to their default value」，而 `httpProxyAll` 默认 `false`。
 *    只写 `{proxyType:'manual', http}` 会得到「HTTPS 走未设置的 `ssl` 因而
 *    直连」—— 正是 ADR-01 在 Chromium 上拒绝 `proxyForHttp` 的那个口子，
 *    换了个形状重新出现，而且这次是**默认行为**。
 *
 * 2. **WebRTC 锁必须用 `proxy_only`，不是 `disable_non_proxied_udp`。**
 *    后者在 Firefox 70+ 的语义是「有代理时强制走代理，**没代理时回落
 *    mode 3**」（Bugzilla 1452713）。抄过来会被接受、不报错、防护更弱。
 *
 * 3. **写入前必须确认隐私窗口访问权。** 没有它 `proxy.settings.set()` 直接抛，
 *    而抛出的英文对用户毫无指导意义 —— 尽管这是他两步就能修好的问题。
 *
 * ## 为什么用 `chrome.*` 而不是 `browser.*`
 *
 * Firefox 同时提供 `browser`（Promise）与 `chrome`（历史上是回调）两个命名空间。
 * 但在 **MV3** 下 Firefox 的 `chrome.*` 同样返回 Promise，
 * 而 `@types/chrome` 的类型定义可以直接复用。
 *
 * 例外是 Firefox 独有的 API（`extension.isAllowedIncognitoAccess`），
 * 那些走本文件底部的窄接口声明 —— 只声明用到的那几个方法，
 * 不引 `@types/firefox-webext-browser` 再多一个依赖。
 */

import { DEFAULT_SETTINGS, LOOPBACK_HOSTS } from '../../shared/constants'
import { errors } from '../../shared/errors'
import type { NormalizedError, Settings } from '../../shared/types'
import { needsRuleBasedRouting, sanitizeRules, shouldBypassProxy } from '../pac'
import type { BrowserPlatform, PlatformBlocker, ProxyInspection, WebRtcInspection } from './types'

// ---------------------------------------------------------------------------
// Firefox 特有的常量
// ---------------------------------------------------------------------------

/**
 * `passthrough` —— 不走代理的主机清单。
 *
 * ⚠️ 与 Chromium 的差异是**格式**而不是内容：这里是一个逗号分隔的字符串，
 *    而 Chromium 要的是 `string[]`。`<local>` 两边都认（MDN 明确列出它，
 *    语义同样是「不含点的主机名」）。
 *
 * 三个回环地址仍然显式写上，尽管 MDN 说「Hosts localhost, 127.0.0.1, and
 * [::1] are never proxied」—— 依赖那句隐式保证没有好处：
 * 它是文档承诺而非我们能验证的行为，而漏掉的后果是扩展访问 Controller
 * 的请求被送进代理形成自环（ADR-02）。显式写上的成本是零。
 */
export const PROXY_PASSTHROUGH = ['<local>', ...LOOPBACK_HOSTS].join(',')

/**
 * WebRTC 加锁时使用的策略值。
 *
 * 🔴 **是 `proxy_only`，不是 Chromium 的 `disable_non_proxied_udp`。**
 *
 * MDN 把可选值按「从最不私密到最私密」排列，`proxy_only` 是最后一个，
 * 说明是「only connections using TURN on a TCP connection through a proxy
 * are allowed」—— 这才等价于我们在 Chromium 上要的 Mode 4「Force proxy」。
 *
 * 而同名的 `disable_non_proxied_udp` 自 Firefox 70 起（Bugzilla 1452713）
 * 变成了「有代理才强制，没代理回落 mode 3」。它**会被接受、不报错**，
 * 只是防护更弱 —— 这类差异没有任何编译期或运行期信号，
 * 只会在某个真实用户的某次通话里泄漏一次真实 IP。
 *
 * 这一行就是整个平台抽象层（ADR-36）存在的直接理由。
 */
export const WEBRTC_LOCKED_POLICY = 'proxy_only' as const

// ---------------------------------------------------------------------------
// Firefox 独有 API 的窄类型声明
// ---------------------------------------------------------------------------

/**
 * 只声明本文件真正用到的 Firefox API。
 *
 * 刻意不引 `@types/firefox-webext-browser`：那个包会引入一整套与
 * `@types/chrome` 冲突的全局声明（两者都想定义 `chrome` 命名空间），
 * 而我们需要的只有一个方法。多一个依赖换一个方法的类型，不划算 ——
 * 尤其在这是个代理工具、每个依赖都是供应链面的前提下。
 */
interface FirefoxExtensionApi {
  isAllowedIncognitoAccess(): Promise<boolean>
}

/** `proxy.onRequest` 监听收到的请求详情（只列本项目用得到的字段）。 */
interface FirefoxRequestDetails {
  url: string
}

/**
 * `proxy.ProxyInfo` —— 监听的返回值。
 *
 * `type: 'direct'` 时其余字段被忽略。
 */
interface FirefoxProxyInfo {
  type: 'direct' | 'http' | 'https' | 'socks' | 'socks4'
  host?: string
  port?: number
}

/** `browser.permissions` 的窄声明。 */
interface FirefoxPermissionsApi {
  contains(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>
  request(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>
}

interface FirefoxProxySettingsValue {
  proxyType?: string
  http?: string
  httpProxyAll?: boolean
  ssl?: string
  socks?: string
  socksVersion?: number
  passthrough?: string
  autoConfigUrl?: string
  proxyDNS?: boolean
}

/**
 * 取 Firefox 的 `extension` 命名空间。
 *
 * 走一次断言而不是扩展全局 `chrome` 的类型：`isAllowedIncognitoAccess`
 * 在 Chromium 上也存在但是回调式的，硬塞进共享的类型声明会让
 * Chromium 那边的代码看起来也能用它 —— 而它在那边根本没有意义
 * （incognito 由 `scope: 'regular'` 覆盖）。
 */
function extensionApi(): FirefoxExtensionApi {
  return (chrome as unknown as { extension: FirefoxExtensionApi }).extension
}

/**
 * 智能分流需要的可选主机权限。
 *
 * 🔴 **为什么是可选的，而不是写进 `host_permissions`。**
 *
 * `proxy.onRequest` 要求过滤器的匹配模式是扩展主机权限的**子集**，
 * 所以要拦截全部请求就得有 `<all_urls>`。若把它写成必需权限，
 * 每个装 Firefox 版的人在安装时都会看到「访问您在所有网站上的数据」——
 * 包括那些只想用全局代理、压根不碰分流的人。
 *
 * 对一个代理工具来说，「默认只要 `http://127.0.0.1/*`」本身是一项卖点：
 * 权限面小意味着即便扩展被攻破，能拿到的东西也有限。
 * 拿它去换一个可选功能是亏的。
 *
 * 用 `optional_host_permissions`（Firefox 128+，正好是我们的最低版本）
 * 之后，这个取舍变成**用户自己的、可撤销的决定**：
 * 他第一次开智能分流时才弹权限请求，不想给就继续用全局，
 * 给了之后随时能在 about:addons 里收回。
 */
const ALL_URLS = '<all_urls>'

function permissionsApi(): FirefoxPermissionsApi {
  return (chrome as unknown as { permissions: FirefoxPermissionsApi }).permissions
}

function proxyApi(): {
  onRequest?: {
    addListener(
      listener: (details: FirefoxRequestDetails) => unknown,
      filter: { urls: string[] },
    ): void
    removeListener(listener: (details: FirefoxRequestDetails) => unknown): void
  }
  onError?: { addListener(listener: (error: unknown) => void): void }
} {
  return chrome.proxy as never
}

/** Firefox 的 proxy.settings，形状与 Chromium 的同名对象不同。 */
function proxySettings() {
  return chrome.proxy.settings as unknown as {
    get(details: Record<string, never>): Promise<{
      value: FirefoxProxySettingsValue
      levelOfControl: chrome.types.LevelOfControl
    }>
    set(details: { value: FirefoxProxySettingsValue }): Promise<void>
    clear(details: Record<string, never>): Promise<void>
  }
}

// ---------------------------------------------------------------------------
// 代理配置构造
// ---------------------------------------------------------------------------

/**
 * 构造 Firefox 代理配置。
 *
 * 🔴 **`httpProxyAll: true` 是这个函数的全部要点。**
 *
 * Firefox 把「HTTP 代理」与「HTTPS(ssl) 代理」当成两个独立字段，
 * 而省略的字段会被**重置为默认值**（MDN 原话）。`httpProxyAll` 默认 `false`，
 * 于是只写 `http` 的配置意味着「HTTPS 请求去找 `ssl`，而 `ssl` 是空的」——
 * 结果是 HTTPS **直连**。
 *
 * 这与 ADR-01 拒绝 `proxyForHttp` / `proxyForHttps` 是同一个问题：
 * 按协议拆分代理配置总会给某些流量留下直连口子。区别在于 Chromium 上
 * 那是一个你得主动选择的错误写法，而 Firefox 上**它是默认**。
 *
 * ⚠️ 本函数刻意不设 `socks`：Mihomo 的 mixed-port 同时支持 HTTP 与 SOCKS，
 *    而走 HTTP 代理时域名交由代理解析（CONNECT 用域名），不产生本地 DNS
 *    泄漏。同时设两个只会多一处配置不一致的可能。
 */
export function buildProxyConfig(settings: Settings): FirefoxProxySettingsValue {
  return {
    proxyType: 'manual',
    http: `${settings.proxyHost}:${settings.proxyPort}`,
    // 🔴 不可省。见上方注释 —— 省了会让 HTTPS 直连。
    httpProxyAll: true,
    passthrough: PROXY_PASSTHROUGH,
  }
}

// ---------------------------------------------------------------------------
// 智能分流：proxy.onRequest
// ---------------------------------------------------------------------------

/**
 * 分流监听的运行时依赖 —— 由 `background/index.ts` 在**顶层**注入。
 *
 * ## 为什么必须顶层注册
 *
 * 此方最初把 `addListener` 放在 `applyProxy` 里，那违反了 `index.ts`
 * 自己写着的那条铁律：「事件监听器必须在顶层同步注册，
 * 若放进某个 async 流程里延迟注册，被唤醒后事件会在监听器挂上之前丢失」。
 *
 * Firefox 的 MV3 背景是**事件页**，空闲约 30 秒就被卸载。卸载时
 * 从 `applyProxy` 挂上的监听一起消失，而重建时没人重挂它 ——
 * 因为重挂只发生在"用户开代理/改设置"的时候。
 *
 * 后果不是泄漏（`proxy.settings` 里的全局代理还在，所以流量仍走代理），
 * 而是**用户的直连清单静默失效**：他配的校内站点开始走代理，
 * 页面还能开，只是慢或者进不去校内资源 —— 而这在他眼里就是"这功能坏了"，
 * 且看不出与"刚才闲置了半分钟"有任何关系。
 *
 * 现在改成：`index.ts` 顶层注册一个**永久**监听，它每次被问到时
 * 现读设置。`proxy.onRequest` 允许监听返回 Promise（MDN 明确列出
 * 「a Promise that resolves to a ProxyInfo object」），所以"现读"是可行的。
 *
 * ## 为什么这样反而更简单
 *
 * 没有生命周期要管了：不用摘、不用挂、不用判断配置变没变，
 * 也不存在"模块缓存与浏览器真实监听列表不一致"这种状态。
 * 唯一的模块级变量是下面这个 settings 读取器，而它在顶层注入一次后不再变 ——
 * 不是可变状态，是依赖注入。
 */
let readState: (() => Promise<{ enabled: boolean; settings: Settings }>) | null = null

/**
 * 造一个分流决策函数。
 *
 * 🔴🔴 **返回值末尾那个 `null` 是整段代码的全部安全性所在。**
 *
 * MDN `proxy.onRequest` 原话：
 *   > By default, the request **fails over to any browser-defined proxy**
 *   > unless a null object or an array ending in a null object is returned.
 *
 * 也就是说只返回 `{type:'http', host, port}` 是 **fail-open** ——
 * 我们的代理连不上时，浏览器会自己找一个别的出路（包括直连），
 * 而那正是本项目最不能发生的事。
 *
 * 加上 `null` 结尾之后语义变成「用这个代理，**没有下一个**」，
 * 代理不可达时请求直接失败 —— 一个可见故障。
 *
 * 这与 PAC 那边的坑是**镜像**关系，值得一起记住：
 *   - PAC：不写 `; DIRECT` 才安全（写了才 fail-open）
 *   - onRequest：**必须**写 `null` 才安全（不写就 fail-open）
 * 两个 API 的默认方向相反，照着一边的直觉写另一边一定会错。
 *
 * ⚠️ `type: 'direct'` 那条分支**不加** null 结尾 —— 它本身就是终态，
 *    没有"回落"的概念。而且 MDN 明确说了 direct「doesn't override any
 *    proxy set by the user」，也就是用户自己配的系统代理仍然生效 ——
 *    这正是我们想要的：直连清单的语义是「不经过我们的代理」，
 *    而不是「强制裸奔」。
 */
export function decideRoute(
  settings: Settings,
  rules: readonly string[],
  url: string,
): FirefoxProxyInfo[] | FirefoxProxyInfo {
  const proxied: FirefoxProxyInfo[] = [
    { type: 'http', host: settings.proxyHost, port: settings.proxyPort },
    // 🔴 不可省。见上方注释 —— 省了就是 fail-open。
    null as unknown as FirefoxProxyInfo,
  ]

  /*
   * 从 URL 取主机名。
   *
   * 解析失败时**走代理**而不是直连 —— fail-closed 的同一条精神：
   * 拿不准的时候选更保守的那个。一个我们看不懂的 URL 直连出去，
   * 可能正是那个会暴露真实 IP 的请求。
   */
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return proxied
  }

  return shouldBypassProxy(host, rules) ? { type: 'direct' } : proxied
}

/**
 * 分流监听本体 —— 每个请求被调用一次。
 *
 * 🔴 **三条 fail-closed 分支，方向都是"拿不准就走代理"：**
 *
 *   1. 还没注入设置读取器（理论上不该发生）→ 走代理
 *   2. 读设置失败 → 走代理
 *   3. 当前配置不需要分流 → 返回 undefined，交给 `proxy.settings` 的全局代理
 *
 * 第 3 条值得说明：返回 `undefined` 意味着"这个监听不表态"，
 * 于是浏览器按 `proxy.settings` 处理 —— 而那里写的是我们的全局代理。
 * 刻意**不**返回 `{type:'direct'}`：那会让全局模式下的所有流量直连，
 * 也就是把代理整个关掉，而用户以为它开着。
 *
 * 前两条返回代理而不是"不表态"，因为"不表态"依赖
 * `proxy.settings` 已经写好 —— 在开关刚被点开、settings 还没落地的
 * 那个瞬间它可能还没写。走代理是无条件安全的那一边。
 */
async function routeListener(
  details: FirefoxRequestDetails,
): Promise<FirefoxProxyInfo[] | FirefoxProxyInfo | undefined> {
  if (readState === null) return FALLBACK_PROXIED

  let state: { enabled: boolean; settings: Settings }
  try {
    state = await readState()
  } catch {
    return FALLBACK_PROXIED
  }

  /*
   * 🔴 **开关是关的就完全不表态。**
   *
   * 这一条是此方在写 `releaseProxy` 的注释时发现的漏洞：监听是顶层注册的、
   * 永久存在，它只看 `routingMode` 与规则清单 —— 而那两样在用户
   * **关掉代理之后并不会变**。所以关掉代理后它仍会返回"走 127.0.0.1:7890"，
   * 流量继续进代理。
   *
   * 那是**反方向的欺骗**：用户点了关闭、UI 显示已关闭，而浏览器还在走代理。
   * 比"以为开了其实没开"更隐蔽，因为不会有任何症状 —— 网页照常打开，
   * 只是出口还是节点 IP。一个想临时切回校园网查资料的人会完全被误导。
   *
   * 返回 `undefined`（不表态）而不是 `{type:'direct'}`：后者会**强制**直连，
   * 越权覆盖用户自己可能配的系统代理 —— 与 ADR-18 拒绝写 `direct` 同一个道理。
   * 不表态则让浏览器按自己的设置办，而 `releaseProxy` 已经把我们的清掉了。
   */
  if (!state.enabled) return undefined

  // 不需要分流 → 同样不表态，让 `proxy.settings` 里的全局代理生效。
  if (!needsRuleBasedRouting(state.settings)) return undefined

  return decideRoute(state.settings, sanitizeRules(state.settings.directRules), details.url)
}

/**
 * 读不到设置时的兜底答案。
 *
 * 用 `127.0.0.1` 与本项目的默认端口 —— 这是一个**猜测**，而猜测在这里
 * 是可接受的：这条路径只在"设置读取失败"时走到，而那本身已经是异常。
 * 猜错的后果是请求失败（可见故障）；不猜（返回 direct）的后果是
 * 真实 IP 泄漏。前者远优于后者。
 */
const FALLBACK_PROXIED: FirefoxProxyInfo[] = [
  { type: 'http', host: DEFAULT_SETTINGS.proxyHost, port: DEFAULT_SETTINGS.proxyPort },
  null as unknown as FirefoxProxyInfo,
]

/**
 * 在顶层注册分流监听。**必须由 `background/index.ts` 同步调用一次。**
 *
 * @param stateReader 现读「开关状态 + 当前设置」。由调用方注入而不是本文件
 *   直接 import storage —— 平台层不该依赖 storage（模块边界，与 proxy.ts 同理）。
 *
 *   🔴 **必须同时给开关状态。** 只给 settings 会漏掉一个反方向的欺骗：
 *   代理关掉之后 routingMode 与规则清单并不会变，监听于是继续把流量
 *   送进代理 —— 用户以为关了，实际还在走。见 `routeListener` 的注释。
 */
export function registerRouter(
  stateReader: () => Promise<{ enabled: boolean; settings: Settings }>,
): void {
  readState = stateReader

  /*
   * 过滤器必须是主机权限的子集（MDN）。这里用 `<all_urls>`，而它是
   * **可选**权限 —— 用户没授予时 Firefox 会拒绝这次注册（或让监听收不到
   * 任何请求）。那是可接受的：没授权时 `supports` 会拦住分流模式，
   * 所以监听本来也无事可做，全局代理照常工作。
   *
   * 刻意**不**按 requestType 过滤：任何请求都可能暴露 IP，
   * 少拦一类就是留一个口子 —— 与 ADR-01 拒绝 `proxyForHttp` 同一个道理。
   */
  try {
    proxyApi().onRequest?.addListener(routeListener, { urls: [ALL_URLS] })
  } catch {
    /*
     * 注册失败（通常是还没拿到 `<all_urls>`）**不能让扩展起不来**。
     * 这是在事件页顶层执行的代码，抛出去会让整个背景脚本挂掉 ——
     * 连本来能正常工作的代理开关一起没了。
     *
     * 失败的代价只是分流不生效，而那条路上 `supports` 会拦住用户
     * 并说明要给权限。用户授权之后 Firefox 会重启扩展，届时重新注册。
     */
  }
}

/** 比较浏览器实际配置是否就是我们期望写入的那一份。 */
function configMatches(
  config: FirefoxProxySettingsValue | undefined,
  expected: Settings,
): boolean {
  if (!config) return false
  if (config.proxyType !== 'manual') return false

  /*
   * 🔴 `httpProxyAll` 必须一并核对，不能只看 `http` 对不对。
   *
   * 若某个东西把它改成了 false（或我们的写入只成功了一半），
   * 浏览器会处于「HTTP 走代理、HTTPS 直连」的状态 —— 而 `http` 字段
   * 看起来完全正确。只比地址就会报「状态一致」，
   * 那正是本项目最不能出的假 ON（技术方案 §22 Case 3）。
   */
  if (config.httpProxyAll !== true) return false

  return config.http === `${expected.proxyHost}:${expected.proxyPort}`
}

// ---------------------------------------------------------------------------
// 运行时错误归一
// ---------------------------------------------------------------------------

/**
 * 把 `proxy.onError` 的原始事件转成规范化错误。
 *
 * 🔴 **Firefox 这个事件的信息量比 Chromium 少得多，而且性质不同。**
 *
 * MDN：「Fired when there is an error evaluating the PAC file or the
 * onRequest listener.」两点后果：
 *
 *   1. **没有 `fatal` 字段。** 无法区分「请求被拦住了」与「已经直连出去了」。
 *   2. 它**只覆盖 PAC / onRequest 的求值错误**，而不是「代理连不上」。
 *      V0.3 的 Firefox 版走 `proxyType: 'manual'`，既无 PAC 也无 onRequest，
 *      因此这个事件在正常路径上**根本不会触发**。
 *
 * 归一成哪一条：选 `proxyBlocked`（fatal=true 的那条，语义是"请求被拦住、
 * 没有泄漏"）而**不是** `proxyLeakSuspected`。
 *
 * 此方在这里犹豫过，因为直觉是「信息不足时报更严重的那个」。但那个直觉在
 * 这里是错的，理由具体：`PROXY_LEAK_SUSPECTED` 的设计是**绝不自动消失、
 * 必须由用户显式确认**（ADR-22），因为它记录的是一个已经发生的事实。
 * 用它来表达一个我们**并不知道有没有发生**的泄漏，会训练用户去点掉
 * 这类告警 —— 而一旦养成这个习惯，真正的泄漏告警也会被顺手点掉。
 * 那比这条报得轻要糟得多。
 *
 * 所以取向是：报一条可自愈、可操作的告警，并在文案上不做任何"没有泄漏"的
 * 承诺（`error.proxyBlocked` 的现有文案说的是"该请求已被阻止"——
 * 对 PAC 求值失败而言这是准确的，Firefox 在 PAC 出错时的行为是拒绝该请求）。
 */
export function normalizeProxyError(_error: unknown): NormalizedError {
  return errors.proxyBlocked()
}

// ---------------------------------------------------------------------------
// 平台实现
// ---------------------------------------------------------------------------

export const firefox: BrowserPlatform = {
  id: 'firefox',

  /**
   * 规则分流可用，但需要一个可选权限。
   *
   * Firefox 的 `proxy.settings` 只支持 `autoConfigUrl`、**没有内联 PAC**，
   * 所以分流走的是另一条路：`proxy.onRequest` —— 浏览器对每个请求
   * 问扩展一次「走代理还是直连」。
   *
   * 那条路**比 PAC 更好**：没有字符串拼接，`pac.ts` 里那整套注入防御
   * （白名单、`JSON.stringify`、`assertAscii`）在这里都不需要，
   * 因为规则从来不变成代码。fail-closed 也由返回值直接表达。
   *
   * 刻意**不**用 `autoConfigUrl` 绕：那需要把脚本放到一个 URL 上
   * （`data:` / `moz-extension:`），从而引入「取不到脚本 → PAC 默认
   * fail-open → **静默直连**」这个失败模式 —— 而消除它正是 ADR-33
   * 选择内联 data 的理由。在一个以"不静默泄漏"为卖点的工具里，
   * 把刚堵上的洞重新挖开换一个功能，方向是反的。
   *
   * 代价是权限：`onRequest` 的过滤器必须是主机权限的子集，
   * 要拦全部请求就得有 `<all_urls>`。它是**可选**权限，
   * 只在用户真的要用分流时才索取（见 `ALL_URLS` 的注释）。
   *
   * 查询失败时**报需要权限**而不是放行 —— 与 `preflight` 那边
   * 「探测失败不阻断」的取向相反，因为两者的代价方向不同：
   * 那边放行的代价只是可能报个错，这边放行的代价是挂上一个
   * 没有权限的监听 —— Firefox 会拒绝它，而请求会**按无分流处理**，
   * 也就是用户的直连清单被静默忽略。宁可多问一次权限。
   */
  async supports(settings: Settings): Promise<PlatformBlocker | null> {
    if (!needsRuleBasedRouting(settings)) return null

    try {
      const granted = await permissionsApi().contains({ origins: [ALL_URLS] })
      return granted ? null : 'routingPermissionRequired'
    } catch {
      return 'routingPermissionRequired'
    }
  },

  /**
   * 索取分流所需的可选权限。
   *
   * ⚠️ 必须在用户手势的调用栈里 —— Firefox 无手势时直接拒绝。
   *    调用点在 `orchestrator` 处理 SAVE_SETTINGS / ENABLE 消息时，
   *    而那两条消息都由用户点击发出，所以手势成立。
   *
   * 不需要分流的配置直接返回 true：不该为了一个用不到的功能弹窗。
   */
  async requestPermissions(settings: Settings): Promise<boolean> {
    if (!needsRuleBasedRouting(settings)) return true

    try {
      return await permissionsApi().request({ origins: [ALL_URLS] })
    } catch {
      // 弹窗被拒、或 API 不存在 —— 两种都当作"没拿到"。
      return false
    }
  },

  /**
   * 隐私窗口访问权。
   *
   * MDN：「If your extension doesn't have private window permission,
   *        calls to proxy.settings.set() throw an exception.」
   *
   * 探测失败（API 不存在、查询抛错）时返回 null 而不是报 blocker ——
   * 与 `inspectProxy` 把查询失败降级成 'unknown' 同一个道理：
   * 探测不出来不等于写不进去，而放弃写入的代价是泄漏风险（ADR-03）。
   * 让 set() 自己去抛，那条路径有正常的错误处理。
   */
  async preflight(): Promise<PlatformBlocker | null> {
    try {
      const allowed = await extensionApi().isAllowedIncognitoAccess()
      return allowed ? null : 'privateBrowsingAccessRequired'
    } catch {
      return null
    }
  },

  async readProxyState(expected: Settings): Promise<ProxyInspection> {
    const result = await proxySettings().get({})
    return {
      levelOfControl: result.levelOfControl,
      // Firefox 用 proxyType 表达"当前是什么模式"，与 Chromium 的 mode 同位。
      mode: result.value?.proxyType ?? null,
      matchesExpected: configMatches(result.value, expected),
    }
  },

  /**
   * 写入代理配置。
   *
   * ⚠️ `set({ value })` —— **没有 scope 参数**。Firefox 的代理设置天然
   *    同时作用于普通窗口与隐私窗口，这也正是它要求隐私窗口访问权的原因。
   *    换句话说，Chromium 上靠 `scope: 'regular'` 换来的「InPrivate 不泄漏」
   *    （ADR-07）在 Firefox 上是默认行为，代价是那个前置授权。
   *
   * 与 Chromium 实现一样：**不检查内核是否在运行**（ADR-03 fail-closed）。
   */
  async applyProxy(settings: Settings): Promise<void> {
    /*
     * 只写 settings。分流监听由 `registerRouter` 在**顶层**注册一次，
     * 它每次被问到时现读设置，所以这里**不需要**做任何"重挂监听"的事。
     *
     * 那是刻意的：从这里挂监听会在事件页被卸载后失效（Firefox 的 MV3
     * 背景是事件页，空闲约 30 秒就卸载），而重挂只发生在
     * "用户开代理 / 改设置"的时候 —— 中间那段时间用户的直连清单
     * **静默失效**：他配的校内站点开始走代理，页面还能开，只是进不去
     * 校内资源。在他眼里就是"这功能坏了"，且看不出与刚才闲置半分钟
     * 有任何关系。见 `readSettings` 的注释。
     */
    await proxySettings().set({ value: buildProxyConfig(settings) })
  },

  /**
   * 释放代理控制权。
   *
   * 用 `clear()` 而不是写 `{ proxyType: 'none' }`（ADR-18）：后者会让本扩展
   * 继续持有控制权并强制直连，越权覆盖用户可能设置的系统代理。
   * `clear()` 让设置回落到 Firefox 自己的 `proxyType: 'system'` 默认值。
   */
  async releaseProxy(): Promise<void> {
    /*
     * 只清 settings，监听留着不摘。
     *
     * 它每次被问到时现读设置，而代理关掉之后 `needsRuleBasedRouting`
     * 仍可能为真（用户的模式设置没变），此时它会返回一份指向我们代理的
     * 答案 —— 但那不构成问题：`proxy.settings` 已经 clear 了，
     * 而 onRequest 的答案只对**它自己表态的那些请求**生效，
     * 而它表态的正是"该走代理"的那些。
     *
     * 🔴 此方核对过这一点：代理关闭后若监听仍把流量送进
     *    127.0.0.1:7890，用户会以为关掉了代理而实际还在走 ——
     *    那是反方向的欺骗。所以 `handleDisable` 之后 orchestrator 会
     *    重新采集状态，而 `enabled` 为 false 时 UI 显示关闭。
     *    真正兜住这件事的是下面这条：监听读的是 settings，
     *    而 `needsRuleBasedRouting` 只看 routingMode 与规则 ——
     *    它不知道开关状态。
     *
     *    见 `routeListener` 里对此的处理：它**额外读一次开关**。
     */
    await proxySettings().clear({})
  },

  onProxyError(handler: (error: NormalizedError) => void | Promise<void>): void {
    /*
     * ⚠️ 事件名是 `onError`，不是 Chromium 的 `onProxyError`。
     *    这也是为什么归一必须留在平台层：连事件的挂载点都不同名。
     */
    const proxyApi = chrome.proxy as unknown as {
      onError?: { addListener(listener: (error: unknown) => void): void }
    }

    /*
     * 用可选链而不是假定它存在：`proxy.onError` 需要 `proxy` 权限，
     * 而 manifest 写错时这里会是 undefined。直接调用会在
     * 事件页顶层抛错 —— 那会让**整个扩展**起不来，
     * 包括本来还能正常工作的代理开关。一个诊断用的监听不值得这个代价。
     */
    proxyApi.onError?.addListener((error) => {
      void handler(normalizeProxyError(error))
    })
  },

  async readWebRtcState(): Promise<WebRtcInspection> {
    /*
     * ⚠️ 走一次断言，因为 `@types/chrome` 把该设置的值声明成一个**联合字面量**，
     *    而 `proxy_only` 不在里面 —— 它是 Firefox 独有的取值。
     *    直接比较会被 tsc 判成「两个类型无交集」而编译失败。
     *
     *    这个编译错误本身是有价值的信号：它证明了 `proxy_only` 确实不是
     *    Chromium 的合法值，也就是说这两个平台在这里**必须**分开实现 ——
     *    共用一份代码连类型都过不了，更不用说语义。
     */
    const setting = chrome.privacy.network.webRTCIPHandlingPolicy as unknown as {
      get(details: Record<string, never>): Promise<{
        value?: string
        levelOfControl: chrome.types.LevelOfControl
      }>
    }
    const result = await setting.get({})
    return {
      policy: result.value ?? null,
      levelOfControl: result.levelOfControl,
      /*
       * 🔴 只把 `proxy_only` 认作已加锁。
       *
       * 刻意**不**把 `disable_non_proxied_udp` 也算进来，尽管它名字看起来
       * 更"专业"、且在 Chromium 上正是我们要的值。在 Firefox 上它是
       * 一个更弱的策略（Bugzilla 1452713），认它作"锁上了"等于谎报安全状态 ——
       * 而 UI 会据此显示一个绿色的"WebRTC 已锁定"。
       */
      locked: result.value === WEBRTC_LOCKED_POLICY,
    }
  },

  async lockWebRtcPolicy(): Promise<void> {
    // 同样没有 scope 参数。
    await (
      chrome.privacy.network.webRTCIPHandlingPolicy as unknown as {
        set(details: { value: string }): Promise<void>
      }
    ).set({ value: WEBRTC_LOCKED_POLICY })
  },

  registerListeners(
    stateReader: () => Promise<{ enabled: boolean; settings: Settings }>,
  ): void {
    registerRouter(stateReader)
  },

  async unlockWebRtcPolicy(): Promise<void> {
    await (
      chrome.privacy.network.webRTCIPHandlingPolicy as unknown as {
        clear(details: Record<string, never>): Promise<void>
      }
    ).clear({})
  },
}
