/**
 * Chromium 平台实现的单元测试。
 *
 * ## 这个文件与 proxy.test.ts / privacy.test.ts 的分工
 *
 * 判据只有一条，且是可操作的：
 *
 *   **移植到 Firefox 时这条断言需要改吗？需要 → 放这里；不需要 → 放那边。**
 *
 * 按这条判据，凡是断言了下列东西的测试都住在本文件：
 *   - 配置对象的**形状**（`fixed_servers` / `singleProxy` / `bypassList` / `pacScript`）
 *   - Chromium 特有的**参数**（`scope: 'regular'` —— Firefox 的 set() 没有 scope）
 *   - Chromium 特有的**值**（`disable_non_proxied_udp` —— Firefox 的等价物是 `proxy_only`）
 *   - Chromium 特有的**事件形状**（`onProxyError` 的 `fatal` 字段 —— Firefox 没有）
 *
 * 而「被别的扩展控制时拒绝写入」「查询失败降级但不阻断写入」「关闭用 clear 而非
 * 写 direct」这些**决策**留在 proxy.test.ts / privacy.test.ts ——
 * 它们与浏览器无关，接 Firefox 时一条都不该改。若发现需要改，
 * 说明平台边界划错了（architecture.md ADR-36）。
 *
 * ## 为什么值得单独一个文件
 *
 * 这份清单同时也是**移植清单**：将来写 `platform/firefox.ts` 时，
 * 本文件里每一条断言都对应一个必须回答的问题（Firefox 那边这个值是什么？
 * 这个字段叫什么？这个信号存在吗？）。混在一起的话，
 * "哪些是平台相关的"就得靠人重新判断一遍 —— 而漏判一条的后果，
 * 在 WebRTC 那一项上是**静默削弱防护**。
 */

import { describe, expect, it } from 'vitest'
import {
  buildProxyConfig,
  chromium,
  normalizeProxyError,
  PROXY_BYPASS_LIST,
  WEBRTC_LOCKED_POLICY,
} from '../src/background/platform/chromium'
import { inspectWebRtcPolicy, lockWebRtc } from '../src/background/privacy'
import { disableProxy, enableProxy, inspectProxy } from '../src/background/proxy'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { NormalizedError, Settings } from '../src/shared/types'
import { emitProxyError, proxySetting, webRtcSetting } from './setup'

const settings: Settings = { ...DEFAULT_SETTINGS, proxyHost: '127.0.0.1', proxyPort: 7890 }

// ===========================================================================
// 配置对象的形状
// ===========================================================================

describe('buildProxyConfig', () => {
  it('uses fixed_servers mode', () => {
    expect(buildProxyConfig(settings).mode).toBe('fixed_servers')
  })

  it('routes through singleProxy, never the per-protocol fields', () => {
    // ADR-01：proxyForHttp/Https 会让「非 HTTP/HTTPS/FTP 的流量直接发送而不经过代理」。
    const rules = buildProxyConfig(settings).rules
    expect(rules?.singleProxy).toBeDefined()
    expect(rules?.proxyForHttp).toBeUndefined()
    expect(rules?.proxyForHttps).toBeUndefined()
    expect(rules?.proxyForFtp).toBeUndefined()
    expect(rules?.fallbackProxy).toBeUndefined()
  })

  it('points singleProxy at the configured host and port over http', () => {
    const server = buildProxyConfig(settings).rules?.singleProxy
    expect(server).toEqual({ scheme: 'http', host: '127.0.0.1', port: 7890 })
  })

  it('honours a user-changed port instead of hardcoding 7890', () => {
    // 技术方案 §22 Case 4：端口必须可改。
    const custom = buildProxyConfig({ ...settings, proxyPort: 1080 })
    expect(custom.rules?.singleProxy?.port).toBe(1080)
  })

  it('bypasses localhost in all four forms', () => {
    // ADR-02：<local> 只匹配「不含点且不是 IP 字面量」的简单主机名，
    // 所以 127.0.0.1 与 [::1] 必须显式列出，否则扩展访问 Controller(9090)
    // 的请求会被再次送进代理(7890) 形成自环。
    const bypass = buildProxyConfig(settings).rules?.bypassList
    expect(bypass).toContain('<local>')
    expect(bypass).toContain('localhost')
    expect(bypass).toContain('127.0.0.1')
    expect(bypass).toContain('[::1]')
  })

  it('produces a mutable bypassList array', () => {
    // 常量是 readonly，chrome API 要的是 string[]。若忘了展开会编译失败，
    // 这条测试保证展开出来的是独立数组，改它不会污染全局常量。
    const first = buildProxyConfig(settings).rules?.bypassList
    first?.push('example.com')
    const second = buildProxyConfig(settings).rules?.bypassList
    expect(second).not.toContain('example.com')
  })
})

describe('buildProxyConfig · 分流模式', () => {
  const smart = (rules: readonly string[]) =>
    buildProxyConfig({ ...DEFAULT_SETTINGS, routingMode: 'smart', directRules: rules })

  it('uses fixed_servers for global mode', () => {
    const config = buildProxyConfig({ ...DEFAULT_SETTINGS, routingMode: 'global' })
    expect(config.mode).toBe('fixed_servers')
  })

  it('uses pac_script for smart mode with rules', () => {
    expect(smart(['*.edu.cn']).mode).toBe('pac_script')
  })

  it('🔴 always sets mandatory: true on the PAC script', () => {
    /*
     * security.md §4：PAC 默认 fail-open —— 脚本无效时浏览器**静默退回直连**，
     * 与 fixed_servers 的失败语义正好相反。漏掉这个字段就等于把 V0.1
     * 辛苦建立的 fail-closed 语义作废，且完全无声。
     *
     * 这是整个 V0.4 里最不能错的一格。
     *
     * ⚠️ 移植提示：Firefox **没有** mandatory 这个概念，且不支持内联 PAC。
     *    那边要用 proxy.onRequest，fail-closed 由返回值直接决定。
     */
    expect(smart(['*.edu.cn']).pacScript?.mandatory).toBe(true)
  })

  it('🔴 falls back to fixed_servers when smart has no usable rules', () => {
    /*
     * 空清单时生成 PAC 没有意义（行为等同全局），而 fixed_servers 更简单、
     * 更可预测，且不必让每个请求都执行一次 JS。
     * 更重要的是：这样就不存在"空规则的 PAC 脚本"这种边界形态。
     */
    expect(smart([]).mode).toBe('fixed_servers')
    // 全部规则都非法时同理 —— 不能因为清单非空就生成脚本。
    expect(smart(["bad'", 'also:bad']).mode).toBe('fixed_servers')
  })

  it('uses inline data rather than a remote URL', () => {
    /*
     * 用 url 会引入"取不到脚本"这个额外的失败模式（也是 fail-open 的触发点之一）。
     * 内联 data 从根上消除它（ADR-33）。
     */
    const config = smart(['*.edu.cn'])
    expect(config.pacScript?.data).toBeTruthy()
    expect(config.pacScript?.url).toBeUndefined()
  })

  it('🔴 the generated script never contains a DIRECT fallback after PROXY', () => {
    // "PROXY x; DIRECT" 会让代理连不上时静默直连。
    const data = smart(['*.edu.cn']).pacScript?.data ?? ''
    expect(data).not.toMatch(/PROXY[^"']*;\s*DIRECT/)
  })
})

// ===========================================================================
// 配置比对：期望的 mode 与实际 mode 必须相符
// ===========================================================================

describe('🔴 inspectProxy · 期望的 mode 与实际 mode 必须相符', () => {
  const smartSettings = {
    ...DEFAULT_SETTINGS,
    routingMode: 'smart' as const,
    directRules: ['*.edu.cn'],
  }

  it('🔴 does not report a match when smart expects PAC but the browser is on fixed_servers', async () => {
    /*
     * 这是此方写错过的那个 bug，也是本项目最不能出的失败形态。
     *
     * 原实现的条件是 `expected.routingMode === 'smart' && config.mode === 'pac_script'`。
     * 浏览器停在 fixed_servers 时该条件不成立，于是穿透到下面的
     * fixed_servers 比较，并因为 host/port 恰好相同而返回 true ——
     * `proxyActuallySet` 报 true，UI 显示"智能分流已生效、状态一致"，
     * 而浏览器其实在把所有流量送进代理，包括本该直连的校内站点。
     *
     * 关键在于：出这个 bug 时，原有的全部测试都是绿的。
     */
    proxySetting.value = {
      mode: 'fixed_servers',
      rules: {
        singleProxy: { scheme: 'http', host: DEFAULT_SETTINGS.proxyHost, port: DEFAULT_SETTINGS.proxyPort },
        bypassList: [...PROXY_BYPASS_LIST],
      },
    }

    const inspection = await inspectProxy(smartSettings)

    expect(inspection.matchesExpected).toBe(false)
  })

  it('reports a match when smart is actually on PAC with our address', async () => {
    proxySetting.value = buildProxyConfig(smartSettings)

    expect((await inspectProxy(smartSettings)).matchesExpected).toBe(true)
  })

  it('🔴 does not report a match when global expects fixed_servers but the browser is on PAC', async () => {
    // 反方向同样要堵：切回全局后若 PAC 还挂着，那也是状态不一致。
    proxySetting.value = buildProxyConfig(smartSettings)

    const inspection = await inspectProxy({ ...DEFAULT_SETTINGS, routingMode: 'global' })

    expect(inspection.matchesExpected).toBe(false)
  })

  it('still matches fixed_servers when smart has no usable rules', async () => {
    /*
     * smart 且无规则时 buildProxyConfig 退回 fixed_servers，
     * 所以此时浏览器在 fixed_servers 才是**正确**的 —— 不能误报不一致。
     */
    const noRules = { ...DEFAULT_SETTINGS, routingMode: 'smart' as const, directRules: [] }
    proxySetting.value = buildProxyConfig(noRules)

    expect((await inspectProxy(noRules)).matchesExpected).toBe(true)
  })

  it('recognises our own configuration and reports the Chromium mode string', async () => {
    // `mode` 是原样透传给 UI 做诊断展示的字符串，值是 Chromium 特有的。
    await enableProxy(settings)
    const inspection = await inspectProxy(settings)
    expect(inspection.matchesExpected).toBe(true)
    expect(inspection.mode).toBe('fixed_servers')
  })

  it('reports a mismatch when the browser is in Chromium direct mode', async () => {
    proxySetting.value = { mode: 'direct' }
    const inspection = await inspectProxy(settings)
    expect(inspection.matchesExpected).toBe(false)
    expect(inspection.mode).toBe('direct')
  })
})

// ===========================================================================
// Chromium 特有的写入参数
// ===========================================================================

describe('🔴 scope 必须是 regular', () => {
  /*
   * ADR-07：'regular' 会被 incognito 继承，所以 InPrivate 窗口也走代理。
   * 若写成 'regular_only'，InPrivate 会漏出真实 IP —— 而这个错误
   * **在普通窗口里完全看不出来**。
   *
   * ⚠️ 移植提示：Firefox 的 BrowserSetting.set() **根本没有 scope 参数**。
   *    私密窗口的代理行为由「是否授予私密窗口访问权」决定，
   *    而那个开关只有用户能给。所以这两条断言在 Firefox 侧没有对应物，
   *    取而代之的是一条完全不同的检查（proxy.settings.set 会不会抛）。
   */
  it('enableProxy writes with regular scope', async () => {
    await enableProxy(settings)
    expect(proxySetting.setCalls[0]?.scope).toBe('regular')
  })

  it('disableProxy clears with regular scope', async () => {
    await disableProxy()
    expect(proxySetting.clearCalls[0]?.scope).toBe('regular')
  })
})

// ===========================================================================
// 运行时错误：fatal 字段
// ===========================================================================

describe('normalizeProxyError', () => {
  const FATAL = { fatal: true, error: 'net::ERR_PROXY_CONNECTION_FAILED', details: '' }
  const NON_FATAL = { fatal: false, error: 'net::ERR_PROXY_CONNECTION_FAILED', details: '' }

  it('reassures the user when the request was blocked', () => {
    const error = normalizeProxyError(FATAL)

    expect(error.code).toBe('PROXY_RUNTIME_ERROR')
    // fatal=true 意味着请求被拦住了 —— 没有泄漏。必须说出来：
    // 用户看到红色告警的第一反应是慌，不告诉他"没漏"是失职。
    expect(error.message).toMatch(/not exposed/i)
    expect(error.message).not.toMatch(/may have been exposed/i)
  })

  it('warns about IP exposure when the browser fell back to DIRECT', () => {
    // 🔴 ADR-04：官方定义 fatal=false 为「a direct connection is used instead」——
    // 请求已经直连出去了。这是运行时唯一能观测到静默直连的信号。
    const error = normalizeProxyError(NON_FATAL)

    expect(error.code).toBe('PROXY_LEAK_SUSPECTED')
    expect(error.message).toMatch(/DIRECT/)
    expect(error.message).toMatch(/may have been exposed/i)
    // 关键：高危场景下绝不能出现任何安抚措辞。
    expect(error.message).not.toMatch(/not exposed/i)
  })

  it('🔴 uses two distinct codes for the two fatal cases', () => {
    /*
     * 这是自愈策略的地基（ADR-22）：两者的严重程度相反，
     * 因此自愈策略也必须相反。共用一个码就无法区分处理。
     *
     * ⚠️ 移植提示：Firefox 的 proxy.onError 传的是一个普通 Error，**没有 fatal**。
     *    那边根本无法区分「被拦住」与「已直连」，只能一律按更坏的情况处理。
     *    正因为两边能得出的结论强度不同，归一必须留在平台实现里而不能共享。
     */
    expect(normalizeProxyError(FATAL).code).toBe('PROXY_RUNTIME_ERROR')
    expect(normalizeProxyError(NON_FATAL).code).toBe('PROXY_LEAK_SUSPECTED')
  })

  it('keeps the two messages semantically opposite', () => {
    // 这两种情况的严重程度是相反的，文案取向也必须相反。
    // 若有人把它们合并成一句"通用"文案，这条会炸。
    expect(normalizeProxyError(FATAL).message).not.toBe(normalizeProxyError(NON_FATAL).message)
  })

  it('keeps raw Chromium error codes out of the user-facing message', () => {
    // net::ERR_* 是给开发者看的错误码，对用户毫无意义。
    // 而 details 可能是很长的 PAC 运行时 dump，塞进文案既无用又扩大意外泄漏面。
    const noise = 'a-very-long-pac-runtime-dump-that-should-not-surface'

    for (const fatal of [true, false]) {
      const error = normalizeProxyError({ fatal, error: 'net::ERR_FAILED', details: noise })
      expect(error.message).not.toContain('net::')
      expect(error.message).not.toContain(noise)
    }
  })

  it('points at an actionable next step', () => {
    // 只说"出错了"没有价值。fatal 分支必须指向可操作的排查方向。
    expect(normalizeProxyError(FATAL).message).toMatch(/mihomo/i)
  })

  it('stamps a timestamp', () => {
    const before = Date.now()
    expect(normalizeProxyError(FATAL).at).toBeGreaterThanOrEqual(before)
  })
})

describe('chromium.onProxyError', () => {
  it('forwards a normalized error to the handler', () => {
    // 验的是「原始事件 → NormalizedError」这一步由平台完成。
    // 事件的形状（fatal 字段）是 Chromium 特有的，所以这条断言住在这里。
    const received: NormalizedError[] = []
    chromium.onProxyError((error) => {
      received.push(error)
    })

    emitProxyError({ fatal: false, error: 'net::ERR_PROXY_CONNECTION_FAILED', details: '' })

    expect(received).toHaveLength(1)
    expect(received[0]?.code).toBe('PROXY_LEAK_SUSPECTED')
    expect(received[0]?.message).toMatch(/may have been exposed/i)
  })
})

// ===========================================================================
// WebRTC 策略：值本身是平台特有的
// ===========================================================================

describe('🔴 Chromium 的 WebRTC 锁值', () => {
  it('是 disable_non_proxied_udp（IETF Mode 4「Force proxy」）', () => {
    /*
     * 🔴 这个值**不能照抄到 Firefox**。
     *
     * 自 Firefox 70 起（Bugzilla 1452713），同名值的语义退化成
     * 「有代理时强制走代理，**没有代理时回落 mode 3**」——
     * 抄过去会被**接受**、**不报错**、而防护**更弱**。
     * Firefox 侧与原始意图等价的值是 `proxy_only`。
     *
     * 这是本项目在跨平台上最危险的一条差异，也是把平台差异集中到
     * 一个目录里（ADR-36）的直接动机：这类错误没有任何编译期或
     * 运行期信号，只会在某个真实用户的某次通话里泄漏一次真实 IP。
     */
    expect(WEBRTC_LOCKED_POLICY).toBe('disable_non_proxied_udp')
  })

  it('加锁时写入的正是那个值，且带 regular scope', async () => {
    await lockWebRtc()

    expect(webRtcSetting.setCalls[0]?.value).toBe('disable_non_proxied_udp')
    expect(webRtcSetting.setCalls[0]?.scope).toBe('regular')
  })

  it('巡检时把该值识别为已加锁', async () => {
    await lockWebRtc()
    const inspection = await inspectWebRtcPolicy()

    expect(inspection.locked).toBe(true)
    expect(inspection.policy).toBe('disable_non_proxied_udp')
  })

  it('不把更弱的策略当成已加锁', async () => {
    // 'default_public_interface_only' 是 Chromium 的枚举值之一，
    // 它**不**强制 WebRTC 走代理 —— 认成"锁上了"等于谎报安全状态。
    webRtcSetting.value = 'default_public_interface_only'

    expect((await inspectWebRtcPolicy()).locked).toBe(false)
  })
})
