/**
 * Chromium / Edge 平台实现。
 *
 * 本文件是**全项目唯一**触碰 `chrome.proxy` 与 `chrome.privacy` 的地方。
 * 契约与划线理由见 `types.ts`；这里只放「Chromium 这套 API 怎么调」，
 * 不放任何「该不该调」的判断 —— 后者全部在 `../proxy.ts` / `../privacy.ts`。
 *
 * ⚠️ 模块边界（技术方案 §29.12）：
 *    本文件**刻意不知道 Mihomo 的存在**，不 import mihomo.ts、不发任何网络请求。
 *    这不是洁癖，而是 fail-closed 语义的结构保证 —— 见 `applyProxy` 的注释。
 *    `tests/proxy.test.ts` 里有一条测试直接把 `fetch` 从全局删掉来锁这件事。
 */

import { errors } from '../../shared/errors'
import { LOOPBACK_HOSTS } from '../../shared/constants'
import type { NormalizedError, Settings } from '../../shared/types'
import { buildPacScript, sanitizeRules } from '../pac'
import type { BrowserPlatform, ProxyInspection, WebRtcInspection } from './types'

// ---------------------------------------------------------------------------
// Chromium 特有的常量
//
// 这四个值原先在 shared/constants.ts。搬到这里是因为它们**每一个的值都是
// Chromium 特有的**：Firefox 的 bypass 是逗号分隔字符串且没有 `<local>` 令牌、
// set() 根本没有 scope 参数、WebRTC 的等价值是 proxy_only。
// 留在 shared/ 会让人以为它们是跨平台事实 —— 而"以为是共享的平台特有值"
// 正是抄错的起点。
// ---------------------------------------------------------------------------

/**
 * 代理 bypass 列表 —— **四项都必须存在**。
 *
 * `<local>` 的官方语义是「匹配简单主机名」，而简单主机名的定义是
 * 「不含点且不是 IP 字面量」。因此：
 *   - `localhost`  → 被 `<local>` 覆盖
 *   - `127.0.0.1`  → **不被覆盖**（是 IP 字面量）
 *   - `[::1]`      → **不被覆盖**（是 IP 字面量）
 *
 * 少写任何一项都会导致「扩展访问 Controller 的请求被再次送进代理链」，
 * 且不会报错，只会诡异地卡住。详见 architecture.md ADR-02。
 *
 * `<local>` 是 Chromium 的令牌，Firefox 不认；回环地址本身则是跨平台事实，
 * 所以后者留在 `shared/constants.ts` 的 `LOOPBACK_HOSTS`，由这里拼上前者。
 */
export const PROXY_BYPASS_LIST: readonly string[] = Object.freeze([
  '<local>',
  ...LOOPBACK_HOSTS,
])

/**
 * 代理服务器的 scheme。
 *
 * `'http'` 而非 `'socks5'`：Mihomo 的 mixed-port 同时支持 HTTP 与 SOCKS，
 * 而走 HTTP 代理时 Chromium 会把域名交给代理去解析（CONNECT 用域名），
 * 因此不会产生本地 DNS 泄漏。
 */
export const PROXY_SCHEME = 'http' as const

/**
 * 写入浏览器设置时使用的 scope。
 *
 * `'regular'` 会被 incognito 窗口继承（除非被更高优先级的 scope 覆盖），
 * 因此 InPrivate 窗口同样走代理，不构成泄漏缺口（architecture.md ADR-07）。
 * 刻意不使用 `'regular_only'` —— 那会让 InPrivate 窗口漏出去。
 *
 * ⚠️ Firefox 的 `BrowserSetting.set()` **没有** scope 参数，
 *    所以这个常量在那边不存在对应物（要用 `browsingData` / 私密窗口授权处理）。
 */
export const SETTING_SCOPE = 'regular' as const

/**
 * WebRTC 加锁时使用的 IP 处理策略。
 *
 * 对应 IETF draft-ietf-rtcweb-ip-handling 的 Mode 4「Force proxy」：
 * 强制 WebRTC 媒体走代理；由于 HTTP 代理与多数 SOCKS 代理不支持 UDP，
 * 实际效果是禁用 UDP、退回 TCP。
 *
 * 该设置的浏览器默认值是 `'default'`，**不强制走代理** ——
 * 也就是说不主动加锁就存在真实 IP 泄漏面（architecture.md ADR-05）。
 *
 * 🔴 **这个值不能照抄到 Firefox。** 自 Firefox 70 起（Bugzilla 1452713）
 *    同名值的语义退化为「有代理时强制走代理，没代理时回落 mode 3」，
 *    抄过去会被接受、不报错、防护更弱。Firefox 侧应当用 `proxy_only`。
 */
export const WEBRTC_LOCKED_POLICY = 'disable_non_proxied_udp' as const

// ---------------------------------------------------------------------------
// 代理配置构造
// ---------------------------------------------------------------------------

/**
 * 构造 Chromium 代理配置。
 *
 * 两个决定命门的细节：
 *
 * 1. **用 `singleProxy`，不用 `proxyForHttp` / `proxyForHttps`。**
 *    官方文档对后者的定义是：「若流量使用的协议不是 HTTP/HTTPS/FTP，
 *    则使用 fallbackProxy；若未指定 fallbackProxy，**流量将直接发送而不经过代理**」。
 *    拆开写会给非 HTTP/HTTPS/FTP 的请求留下直连口子。
 *    `singleProxy` 在 Chromium 内部走 PROXY_LIST 类型，覆盖所有 per-URL 请求。
 *
 * 2. **bypassList 四项都不能少。** 理由见 `PROXY_BYPASS_LIST` 的注释。
 *
 * 详见 architecture.md ADR-01 / ADR-02。
 */
export function buildProxyConfig(settings: Settings): chrome.proxy.ProxyConfig {
  /*
   * V0.4：smart 模式改用 PAC。
   *
   * 🔴 `mandatory: true` 不可省（security.md §4）。PAC 默认 fail-open ——
   *    脚本无效时浏览器会**静默退回直连**，与 fixed_servers 的失败语义正好相反。
   *    设了它，失败会变成 ERR_MANDATORY_PROXY_CONFIGURATION_FAILED（可见故障）。
   *
   * smart 但一条规则都没有时**退回 global**，而不是生成一个"全部走代理"的
   * PAC 脚本。两者网络行为一致，但 fixed_servers 是更简单、更可预测的那条路径，
   * 且不必让每个请求都执行一次 JS。
   */
  if (settings.routingMode === 'smart' && sanitizeRules(settings.directRules).length > 0) {
    return {
      mode: 'pac_script',
      pacScript: {
        data: buildPacScript(settings.proxyHost, settings.proxyPort, settings.directRules),
        mandatory: true,
      },
    }
  }

  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme: PROXY_SCHEME,
        host: settings.proxyHost,
        port: settings.proxyPort,
      },
      // 常量声明为 readonly，而 chrome API 要的是可变 string[]，故展开成新数组。
      bypassList: [...PROXY_BYPASS_LIST],
    },
  }
}

/** 比较浏览器实际配置是否就是我们期望写入的那一份。 */
function configMatches(config: chrome.proxy.ProxyConfig | undefined, expected: Settings): boolean {
  if (!config) return false

  /*
   * 🔴 先判「我们期望的是哪种 mode」，再拿它与实际 mode 比对。
   *
   * 此方最初写成 `if (expected.routingMode === 'smart' && config.mode === 'pac_script')`，
   * 那是个真 bug：smart 且有规则时我们期望 pac_script，但若浏览器实际停在
   * fixed_servers（写入被别的东西覆盖、或写入根本没发生），
   * 这个条件不成立，于是**穿透到下面的 fixed_servers 比较**并因为
   * host/port 恰好相同而返回 true。
   *
   * 后果正是本项目最不能出的那种：`proxyActuallySet` 报 true，
   * UI 显示"智能分流已生效、状态一致"，而浏览器其实在把**所有**流量
   * 送进代理 —— 包括本该直连的校内站点。用户看不出任何异常。
   *
   * 现在改成 mode 必须相符：期望 pac_script 却拿到别的，就是不一致。
   */
  const expectedConfig = buildProxyConfig(expected)

  if (config.mode !== expectedConfig.mode) return false

  if (expectedConfig.mode === 'pac_script') {
    // 只比对「脚本里确实出现了我们的代理地址」，不做全文比较 ——
    // 浏览器 get() 回来的字符串可能被规范化（空白、换行），
    // 全文相等会产生误判，而误判的后果是 UI 显示"状态不一致"的假警报。
    const data = config.pacScript?.data ?? ''
    return data.includes(`${expected.proxyHost}:${expected.proxyPort}`)
  }

  const server = config.rules?.singleProxy
  if (!server) return false

  // 只比 host 与 port，不比 scheme：官方明确说明 get() 返回的对象
  // 与 set() 传入的对象并不完全相同（会补全字段），
  // 拿 scheme 做严格比较容易因规范化差异产生误判。
  return server.host === expected.proxyHost && server.port === expected.proxyPort
}

// ---------------------------------------------------------------------------
// 运行时错误归一
// ---------------------------------------------------------------------------

/**
 * 把 `chrome.proxy.onProxyError` 的原始事件转成规范化错误。
 *
 * 🔴 `fatal` 字段是这里唯一重要的东西。官方定义：
 *
 *   > If true, the error was fatal and the network transaction was aborted.
 *   > **Otherwise, a direct connection is used instead.**
 *
 * 也就是说 `fatal: false` 意味着**这个请求已经直连出去了**，真实 IP 可能已暴露。
 * 这是运行时唯一能观测到「发生了静默直连」的信号，必须当作高危告警处理，
 * 不能和普通错误混在一起（architecture.md ADR-04）。
 *
 * 两种文案的取向是**相反**的，因为两种情况的严重程度是相反的：
 *   - fatal=true  → 请求被拦住了，没泄漏。要**安抚**用户，并给出可操作的排查方向。
 *     用户看到红色告警的第一反应是慌，不告诉他"没泄漏"是失职。
 *   - fatal=false → 已经漏出去了。要**警告**用户，不能有任何安抚措辞。
 *
 * 刻意不把 `details.error`（如 net::ERR_PROXY_CONNECTION_FAILED）当作主文案：
 * 那是给开发者看的错误码，对用户毫无意义。也不取 `details.details` ——
 * 它可能包含很长的 PAC 运行时信息，塞进面向用户的文案里既无用又扩大意外泄漏面。
 *
 * ⚠️ 这个函数**没有 Firefox 对应物**。Firefox 的 `proxy.onError` 传的是一个
 *    普通 Error，不带 `fatal` —— 那边根本无法区分「被拦住」与「已直连」，
 *    只能一律按更坏的情况处理。正因为两边能得出的结论强度不同，
 *    归一必须留在平台实现里。
 */
export function normalizeProxyError(details: chrome.proxy.ErrorDetails): NormalizedError {
  return details.fatal ? errors.proxyBlocked() : errors.proxyLeakSuspected()
}

// ---------------------------------------------------------------------------
// 平台实现
// ---------------------------------------------------------------------------

/**
 * Chromium 平台实现。
 *
 * 显式标注 `: BrowserPlatform` 是为了让漏实现/签名不符变成**编译错误**
 * 而不是运行期的静默分支 —— 见 `types.ts` 文件末尾的说明。
 */
export const chromium: BrowserPlatform = {
  id: 'chromium',

  async readProxyState(expected: Settings): Promise<ProxyInspection> {
    // 失败时**抛错**，由共享层决定降级成 'unknown'（见 types.ts 的错误约定）。
    const result = await chrome.proxy.settings.get({})
    return {
      levelOfControl: result.levelOfControl,
      mode: result.value?.mode ?? null,
      matchesExpected: configMatches(result.value, expected),
    }
  },

  /**
   * 写入代理配置。
   *
   * 🔴 **Fail-closed 语义（architecture.md ADR-03）**
   *
   * 本方法**不检查 Mihomo 是否在运行**，也不会因为 Core 离线而放弃写入。
   * 这是刻意设计，不是遗漏：
   *
   *   Chromium 官方 net 文档确认，单代理且无 fallback 配置下，
   *   代理不可达时所有请求会失败并报 ERR_PROXY_CONNECTION_FAILED，
   *   **不会**静默回落到 DIRECT（要回落必须显式写成 "proxy,direct://"）。
   *
   *   因此「Core 没起来就照样开代理」的结果是网页打不开 —— 一个可见故障。
   *   而「Core 没起来就不开代理」的结果是用户以为在走代理、实际直连 ——
   *   一个不可见的真实 IP 泄漏。前者远优于后者。
   */
  async applyProxy(settings: Settings): Promise<void> {
    await chrome.proxy.settings.set({
      value: buildProxyConfig(settings),
      scope: SETTING_SCOPE,
    })
  },

  /**
   * 释放代理控制权。
   *
   * **用 `clear()` 而不是 `set({ mode: 'direct' })`**（architecture.md ADR-18）：
   * 后者会让本扩展继续持有控制权并**强制**浏览器直连，越权覆盖用户可能存在的
   * 其他合法配置。「关闭 LostProxy」的正确语义是「LostProxy 不再干预」。
   */
  async releaseProxy(): Promise<void> {
    await chrome.proxy.settings.clear({ scope: SETTING_SCOPE })
  },

  onProxyError(handler: (error: NormalizedError) => void | Promise<void>): void {
    chrome.proxy.onProxyError.addListener((details) => {
      void handler(normalizeProxyError(details))
    })
  },

  async readWebRtcState(): Promise<WebRtcInspection> {
    const result = await chrome.privacy.network.webRTCIPHandlingPolicy.get({})
    return {
      policy: result.value ?? null,
      levelOfControl: result.levelOfControl,
      // 由平台判定 locked，因为达到该状态的**值**两个平台不同。
      locked: result.value === WEBRTC_LOCKED_POLICY,
    }
  },

  async lockWebRtcPolicy(): Promise<void> {
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({
      value: WEBRTC_LOCKED_POLICY,
      scope: SETTING_SCOPE,
    })
  },

  /**
   * 解锁：释放对 WebRTC 策略的控制。
   *
   * 用 `clear()` 而不是 `set({ value: 'default' })`，理由与 `releaseProxy` 相同
   * （ADR-18）：显式写 `'default'` 会让本扩展继续持有控制权，
   * 并覆盖用户或其他扩展可能设置的**更严格**策略。
   * 「LostProxy 不再加锁」不等于「强制 WebRTC 回到最宽松模式」。
   */
  async unlockWebRtcPolicy(): Promise<void> {
    await chrome.privacy.network.webRTCIPHandlingPolicy.clear({ scope: SETTING_SCOPE })
  },
}
