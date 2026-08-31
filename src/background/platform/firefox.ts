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

/**
 * `browser.permissions` 的窄声明。
 *
 * 🔴 `onAdded` / `onRemoved` **不是可选的补充**，它们是本平台正确性的一部分。
 *    MDN 在 `optional_host_permissions` 页明确写着：
 *      > listen for `permissions.onAdded` and `permissions.onRemoved`
 *      > to know when a user grants or revokes permissions
 *    详见 `registerRouter` 里为什么必须挂它们。
 *
 * ⚠️ 刻意**不**声明 `request()` —— 它不能从背景脚本调用，见 `requestPermissions`。
 */
interface FirefoxPermissionsApi {
  contains(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>
  onAdded?: { addListener(listener: () => void): void }
  onRemoved?: { addListener(listener: () => void): void }
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
 * 🔴🔴 **整个函数体必须在一个 try 里。抛出去 = 静默直连。**
 *
 * Bugzilla 1528873（Mozilla 标记 **WONTFIX**，认定是预期行为）实测：
 *   > if the `proxy.onRequest` listener throws an exception, the fetch
 *   > **proceeds without a proxy** ... Making the listener async ... still
 *   > lets the fetch happen without a proxy, but **does** call `onError`
 *
 * 也就是说这个监听里的任何一次意外抛出，代价都不是"这个请求失败"，
 * 而是**这个请求裸奔出去**。而末尾那个 `null` 防不住它 ——
 * `null` 只管"代理地址连不上"，管不了"我们压根没给出答案"。
 *
 * 此方最初只把 `readState()` 包进 try，把 `needsRuleBasedRouting` /
 * `sanitizeRules` / `decideRoute` 留在外面。那三个现在不抛，
 * 但「现在不抛」不是一个能长期依赖的性质：将来给规则加一种新语法、
 * 或 `decideRoute` 多一个分支，都可能引入一次抛出 ——
 * 而它的症状是一次不可见的泄漏，没有任何测试会自然地覆盖到。
 *
 * 所以边界画在函数最外层，与"平台层方法可以抛、由共享层归一"那条约定
 * 在这里刻意不一致：那条约定的前提是调用方能接住，而这里的调用方是
 * **浏览器**，它接住的方式是放行。
 *
 * 🔴 **三条 fail-closed 分支，方向都是"拿不准就走代理"：**
 *
 *   1. 还没注入设置读取器（理论上不该发生）→ 走代理
 *   2. 读设置失败、或任何一步意外抛出 → 走代理
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
  try {
    return await decideForRequest(details)
  } catch {
    /*
     * 兜住一切。见函数头注释 —— 让异常穿出去的后果是这个请求直连，
     * 而不是失败。返回代理是唯一安全的兜底。
     */
    return FALLBACK_PROXIED
  }
}

/** 真正的决策逻辑。允许抛，由 `routeListener` 兜成 fail-closed。 */
async function decideForRequest(
  details: FirefoxRequestDetails,
): Promise<FirefoxProxyInfo[] | FirefoxProxyInfo | undefined> {
  if (readState === null) return FALLBACK_PROXIED

  const state: { enabled: boolean; settings: Settings } = await readState()

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

  attachRouter()

  /*
   * 🔴🔴 **授权之后必须重挂 —— Firefox 不会为此重启扩展。**
   *
   * 此方原先在这里写「用户授权之后 Firefox 会重启扩展，届时重新注册」。
   * 那是错的。MDN 在 `optional_host_permissions` 页说的是：
   *   > listen for `permissions.onAdded` and `permissions.onRemoved`
   *   > to know when a user grants or revokes permissions
   *
   * 按错的假设走会得到这样一条路径：
   *   1. 扩展启动，还没有 `<all_urls>` → `addListener` 失败（下面接住）
   *   2. 用户在设置页或 about:addons 授权
   *   3. 扩展**继续跑着**，监听始终没挂上
   *   4. 而 `supports()` 现在返回 null，于是代理照常以智能模式开启
   *   5. **用户的直连清单被静默忽略** —— 全部走代理，页面能开，看不出问题
   *
   * 第 5 步正是整个分流设计要防的那件事，从授权这条路漏了进来。
   *
   * ⚠️ 它靠事件页空闲卸载、下次唤醒重跑顶层代码**碰巧**会自愈。
   *    但那是巧合而非设计：用户如果一直在用浏览器（事件页反复被唤醒
   *    但从不空闲到卸载），或者授权后立刻访问站点，就撞在窗口里。
   *    依赖巧合的安全性等于没有安全性。
   *
   * `onRemoved` 一并挂上：权限被撤销后 `attachRouter` 会摘掉监听，
   * 免得留一个注册着却收不到请求的空壳 —— 而 `supports()` 届时会
   * 重新拦住智能模式，两边一致。
   */
  const perms = permissionsApi()
  perms.onAdded?.addListener(attachRouter)
  perms.onRemoved?.addListener(attachRouter)
}

/**
 * 挂上（或重挂）分流监听。可安全重复调用。
 *
 * 先 `removeListener` 再 `addListener`：`onAdded` 可能在监听已经挂着时触发
 * （用户授了另一个不相关的权限），重复 add 同一个函数引用在
 * WebExtension 事件里是幂等的，但**过滤器不会因此更新**。
 * 先摘再挂让"权限变了 → 过滤器按新权限重新生效"成为确定行为，
 * 而不是依赖浏览器对重复注册的处理细节。
 */
function attachRouter(): void {
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
    proxyApi().onRequest?.removeListener(routeListener)
  } catch {
    // 没挂过就摘不掉，那是正常的初次调用路径。
  }

  try {
    proxyApi().onRequest?.addListener(routeListener, { urls: [ALL_URLS] })
  } catch {
    /*
     * 注册失败（通常是还没拿到 `<all_urls>`）**不能让扩展起不来**。
     * 这是在事件页顶层执行的代码，抛出去会让整个背景脚本挂掉 ——
     * 连本来能正常工作的代理开关一起没了。
     *
     * 失败的代价只是分流不生效，而那条路上 `supports` 会拦住用户
     * 并说明要给权限。授权之后上面那个 `onAdded` 会把它重挂上。
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
 * 🔴🔴 **在 Firefox 上，这个事件触发 ⟺ 已经有一次直连发生了。**
 *
 * 所以归一成 `proxyLeakSuspected`，而不是 Chromium 那种按 `fatal` 分流。
 * 依据是 Bugzilla 1528873，Mozilla 标记 **WONTFIX** 并明确认定这是预期行为：
 *
 *   > if the `proxy.onRequest` listener throws an exception, the fetch
 *   > **proceeds without a proxy**, and without calling the `proxy.onError`
 *   > listener ... Making the listener async; i.e., having it return a
 *   > rejected promise instead of throw an exception, still lets the fetch
 *   > happen without a proxy, but **does** call the `proxy.onError` listener.
 *
 * 我们的 `routeListener` 是 async 的，正好落在后半句：
 * **请求已经裸奔出去了，然后我们收到这个事件。**
 * 返回非法 ProxyInfo（端口越界、缺 host）也走同一条路 ——
 * 同 bug 里逐个实测过，每种都是 `onError` + 照常直连。
 *
 * ⚠️ 此方最初写的是 `proxyBlocked`，理由是「信息不足时不要滥用那条
 *    不可自愈的告警」。那个顾虑本身成立，但**前提是错的** ——
 *    此方当时假定「Firefox 在 PAC 出错时会拒绝该请求」，
 *    而 Mozilla 在上面那条 bug 里说的恰好相反。
 *
 *    更要紧的是文案：`error.proxyBlocked` 明写「你的真实 IP **没有泄漏**
 *    —— 该请求已被阻止」。在这条路径上那句话是**假的**，
 *    而它恰好是全项目唯一绝不能说错的一句。宁可让用户多确认一次告警，
 *    也不能替浏览器承诺一个它没做到的保证。
 *
 * 因此这里付出的代价是明知的：`PROXY_LEAK_SUSPECTED` 不自愈（ADR-22），
 * 必须由用户显式 Dismiss。那正是"已经发生过的事实"该有的形态。
 *
 * ⚠️ 与 Chromium 的差异不只是取值，而是**能得出的结论强度**：
 *    那边 `fatal` 字段真能区分「拦住了」与「漏了」，这边不能 ——
 *    因为这边只有一种情况会触发，而它就是漏了。
 */
export function normalizeProxyError(_error: unknown): NormalizedError {
  return errors.proxyLeakSuspected()
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

  /*
   * ⚠️ 这里没有 `requestPermissions` —— 见 `types.ts` 里那段说明。
   *    `permissions.request()` 无法从背景脚本调用，索权只能发生在
   *    设置页的点击回调里（`options/options.ts`）。
   */

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
