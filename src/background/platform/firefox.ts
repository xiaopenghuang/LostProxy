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

import { LOOPBACK_HOSTS } from '../../shared/constants'
import { errors } from '../../shared/errors'
import type { NormalizedError, Settings } from '../../shared/types'
import { needsRuleBasedRouting } from '../pac'
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
   * 两个前置条件，顺序有讲究。
   *
   * 先查「能不能做分流」再查「有没有权限」：前者是**配置问题**
   * （用户改一下模式即可，与浏览器权限无关），后者是**授权问题**。
   * 若顺序颠倒，一个既没授权又开着分流的用户会先被要求去授权，
   * 授完权再被告知分流做不到 —— 两次往返。
   */
  async preflight(settings: Settings): Promise<PlatformBlocker | null> {
    /*
     * 🔴 Firefox 只支持 `autoConfigUrl`，**没有内联 PAC**。
     *
     * 为什么不用 autoConfigUrl 绕过去：那需要把脚本放到一个 URL 上。
     * 用 `data:` / `moz-extension:` URL 都要引入新的失败模式
     * （取不到脚本 → PAC 默认 fail-open → **静默直连**），
     * 而消除这个失败模式正是 ADR-33 当初选择内联 data 的理由。
     * 在一个以"不静默泄漏"为卖点的工具里，把刚堵上的洞重新挖开
     * 换一个功能，方向是反的。
     *
     * 正确的做法是 `proxy.onRequest`（每个请求跑一次我们的 JS，
     * 顺带把 PAC 的字符串注入面整个消掉），那是后续版本的事。
     * 在它落地之前，**拒绝**比静默降级正确。
     */
    if (needsRuleBasedRouting(settings)) {
      return 'ruleBasedRoutingUnsupported'
    }

    /*
     * MDN：「If your extension doesn't have private window permission,
     *        calls to proxy.settings.set() throw an exception.」
     *
     * 探测失败（API 不存在、查询抛错）时返回 null 而不是报 blocker ——
     * 与 `inspectProxy` 把查询失败降级成 'unknown' 同一个道理：
     * 探测不出来不等于写不进去，而放弃写入的代价是泄漏风险（ADR-03）。
     * 让 set() 自己去抛，那条路径有正常的错误处理。
     */
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

  async unlockWebRtcPolicy(): Promise<void> {
    await (
      chrome.privacy.network.webRTCIPHandlingPolicy as unknown as {
        clear(details: Record<string, never>): Promise<void>
      }
    ).clear({})
  },
}
