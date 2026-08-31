/**
 * 全项目共享常量。
 *
 * 所有「魔法值」集中在此，禁止在业务代码里内联字面量——
 * 尤其是端口，技术方案 §22 Case 4 明确要求端口可由用户修改、不得硬编码。
 */

import type { Settings } from './types'

/**
 * 默认设置。对应技术方案 §11 的默认值表 + §6 的推荐 Mihomo 配置。
 *
 * webRtcLockEnabled 默认 true：本项目的价值主张是出口 IP 隔离，
 * 而 WebRTC 的默认策略会绕过代理暴露真实 IP（architecture.md ADR-05）。
 * 默认关闭这个锁等于默认留一个泄漏口。
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  proxyHost: '127.0.0.1',
  proxyPort: 7890,
  controllerHost: '127.0.0.1',
  controllerPort: 9090,
  controllerSecret: '',
  webRtcLockEnabled: true,
  // 'auto' = 跟随浏览器语言。首次安装时中文环境自动显示中文。
  language: 'auto',
  /*
   * 空字符串 = 用户还没选主策略组。
   *
   * 🔴 这里**必须**留空，不能猜一个常见组名。技术方案 §16 明令禁止硬编码
   *    代理组名称：不同机场的组名从 "Proxy" 到 "🚀 节点选择" 到 "PROXY" 各式各样，
   *    猜中了省用户一次点击，猜错了就表现为「这功能是坏的」——
   *    而后者远比前者常见，且用户无从判断是自己配错还是插件有 bug。
   */
  primaryGroup: '',
})

/**
 * chrome.storage.local 的键名。
 *
 * 加 `lostproxy.` 前缀是为了在同一 profile 里与其他扩展/未来字段隔离。
 * enabled 与 settings 分开存储，对应 §28 Task 03 的四个独立 API。
 *
 * lastError 必须持久化：chrome.proxy.onProxyError 可能在 Service Worker
 * 被终止前触发，若只留在内存里，Popup 下次打开就读不到那次告警了——
 * 而 fatal=false 的 proxy error 恰恰意味着「已经发生过一次直连」，
 * 是最不能丢的信息（architecture.md ADR-04）。
 */
export const STORAGE_KEYS = Object.freeze({
  settings: 'lostproxy.settings',
  enabled: 'lostproxy.enabled',
  lastError: 'lostproxy.lastError',
})

/**
 * 代理 bypass 列表 —— **四项都必须存在**。
 *
 * `<local>` 的官方语义是「匹配简单主机名」，而简单主机名的定义是
 * 「不含点且不是 IP 字面量」。因此：
 *   - `localhost`  → 被 <local> 覆盖
 *   - `127.0.0.1`  → **不被覆盖**（是 IP 字面量）
 *   - `[::1]`      → **不被覆盖**（是 IP 字面量）
 *
 * 少写任何一项都会导致「扩展访问 Controller 的请求被再次送进代理链」，
 * 且不会报错，只会诡异地卡住。详见 architecture.md ADR-02。
 */
export const PROXY_BYPASS_LIST: readonly string[] = Object.freeze([
  '<local>',
  'localhost',
  '127.0.0.1',
  '[::1]',
])

/**
 * 代理服务器的 scheme。
 *
 * 'http' 而非 'socks5'：Mihomo 的 mixed-port 同时支持 HTTP 与 SOCKS，
 * 而走 HTTP 代理时 Chromium 会把域名交给代理去解析（CONNECT 用域名），
 * 因此不会产生本地 DNS 泄漏。
 */
export const PROXY_SCHEME = 'http' as const

/** Controller 探活超时。3 秒足够本机回环，再长只是让 UI 干等。 */
export const CORE_PROBE_TIMEOUT_MS = 3000

/**
 * 瞬时告警在自愈前必须"静默"多久。
 *
 * 用于 Controller 不可观测（例如客户端只开 named pipe）的场景：
 * 此时拿不到"Mihomo 在跑"的强证据，只能退化为时间判据。
 *
 * 之所以这个弱判据是安全的：若代理仍然坏着，这段时间内用户
 * 任何一次页面加载都会产生新的 onProxyError 并刷新时间戳，
 * 告警不会消失。也就是说时间窗口衡量的是"最近有没有真的在失败"。
 */
export const ALERT_STALE_AFTER_MS = 30_000

/**
 * WebRTC 加锁时使用的 IP 处理策略。
 *
 * 对应 IETF draft-ietf-rtcweb-ip-handling 的 Mode 4「Force proxy」：
 * 强制 WebRTC 媒体走代理；由于 HTTP 代理与多数 SOCKS 代理不支持 UDP，
 * 实际效果是禁用 UDP、退回 TCP。
 *
 * 该设置的浏览器默认值是 'default'，**不强制走代理**——
 * 也就是说不主动加锁就存在真实 IP 泄漏面（architecture.md ADR-05）。
 */
export const WEBRTC_LOCKED_POLICY = 'disable_non_proxied_udp' as const

/**
 * 写入浏览器设置时使用的 scope。
 *
 * 'regular' 会被 incognito 窗口继承（除非被更高优先级的 scope 覆盖），
 * 因此 InPrivate 窗口同样走代理，不构成泄漏缺口（architecture.md ADR-07）。
 * 刻意不使用 'regular_only'——那会让 InPrivate 窗口漏出去。
 */
export const SETTING_SCOPE = 'regular' as const

/** 端口合法区间。 */
export const PORT_MIN = 1
export const PORT_MAX = 65535
