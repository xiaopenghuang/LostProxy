/**
 * proxy 层单元测试。
 *
 * 本文件的价值不在于覆盖率，而在于把 architecture.md 里的**安全约束**
 * 变成可执行断言。以下几条如果退化，项目的核心价值就没了，
 * 而它们全都是「不会报错、只会静默泄漏」的那种退化：
 *
 *   - 必须用 singleProxy（用 proxyForHttp 会给其他协议留直连口子）
 *   - bypassList 必须含 127.0.0.1 与 [::1]（<local> 不覆盖 IP 字面量）
 *   - scope 必须是 regular（regular_only 会让 InPrivate 窗口漏出去）
 *   - 关闭必须用 clear()（set(direct) 会越权强制全局直连）
 *   - fatal=false 的 proxy error 必须被识别为「已经直连过」
 *   - enableProxy 绝不能依赖 Core 可用性（fail-closed）
 */

import { describe, expect, it } from 'vitest'
import {
  buildProxyConfig,
  disableProxy,
  enableProxy,
  inspectProxy,
  isBlockedByControl,
  normalizeProxyError,
  registerProxyErrorListener,
} from '../src/background/proxy'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { NormalizedError, Settings } from '../src/shared/types'
import { emitProxyError, proxyErrorListenerCount, proxySetting } from './setup'

const settings: Settings = { ...DEFAULT_SETTINGS, proxyHost: '127.0.0.1', proxyPort: 7890 }

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

describe('isBlockedByControl', () => {
  it.each(['not_controllable', 'controlled_by_other_extensions'] as const)(
    'blocks on %s',
    (level) => {
      expect(isBlockedByControl(level)).toBe(true)
    },
  )

  it.each(['controllable_by_this_extension', 'controlled_by_this_extension', 'unknown'] as const)(
    'allows on %s',
    (level) => {
      expect(isBlockedByControl(level)).toBe(false)
    },
  )
})

describe('inspectProxy', () => {
  it('reports no match on a clean browser', async () => {
    const inspection = await inspectProxy(settings)
    expect(inspection.matchesExpected).toBe(false)
    expect(inspection.levelOfControl).toBe('controllable_by_this_extension')
  })

  it('recognises our own configuration', async () => {
    await enableProxy(settings)
    const inspection = await inspectProxy(settings)
    expect(inspection.matchesExpected).toBe(true)
    expect(inspection.mode).toBe('fixed_servers')
  })

  it('reports a mismatch when the port differs', async () => {
    await enableProxy(settings)
    const inspection = await inspectProxy({ ...settings, proxyPort: 1080 })
    expect(inspection.matchesExpected).toBe(false)
  })

  it('reports a mismatch when the browser is in direct mode', async () => {
    proxySetting.value = { mode: 'direct' }
    const inspection = await inspectProxy(settings)
    expect(inspection.matchesExpected).toBe(false)
    expect(inspection.mode).toBe('direct')
  })

  it('degrades to unknown instead of throwing when the query fails', async () => {
    proxySetting.failNextGet = new Error('boom')
    const inspection = await inspectProxy(settings)
    expect(inspection.levelOfControl).toBe('unknown')
    expect(inspection.matchesExpected).toBe(false)
  })
})

describe('enableProxy', () => {
  it('writes the config with regular scope', async () => {
    const result = await enableProxy(settings)

    expect(result.ok).toBe(true)
    expect(proxySetting.setCalls).toHaveLength(1)
    // ADR-07：regular 会被 incognito 继承，所以 InPrivate 窗口也走代理。
    // 若写成 'regular_only'，InPrivate 会漏出真实 IP。
    expect(proxySetting.setCalls[0]?.scope).toBe('regular')
  })

  it('refuses to override another extension', async () => {
    proxySetting.levelOfControl = 'controlled_by_other_extensions'

    const result = await enableProxy(settings)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROXY_CONTROLLED_BY_OTHER')
    // 关键：一次都没写。技术方案 §24.4 要求不强行覆盖。
    expect(proxySetting.setCalls).toHaveLength(0)
  })

  it('refuses when locked down by policy', async () => {
    proxySetting.levelOfControl = 'not_controllable'

    const result = await enableProxy(settings)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROXY_NOT_CONTROLLABLE')
    expect(proxySetting.setCalls).toHaveLength(0)
  })

  it('still attempts the write when the control query fails', async () => {
    // 'unknown' 不阻断：查询失败不代表写入会失败，
    // 而放弃写入的代价是泄漏风险。fail-closed 精神下先尝试保护。
    proxySetting.failNextGet = new Error('query failed')

    const result = await enableProxy(settings)

    expect(result.ok).toBe(true)
    expect(proxySetting.setCalls).toHaveLength(1)
  })

  it('surfaces a write failure as an error instead of throwing', async () => {
    proxySetting.failNextSet = new Error('set rejected')

    const result = await enableProxy(settings)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('set rejected')
  })

  it('applies the proxy without depending on the core being reachable', async () => {
    // 🔴 ADR-03 fail-closed 的结构保证：proxy.ts 刻意不 import mihomo，
    // 不发任何网络请求。这里把 fetch 直接从全局删掉——
    // 若 enableProxy 内部偷偷做了探活，就会炸在这条测试上。
    const originalFetch = globalThis.fetch
    Reflect.deleteProperty(globalThis, 'fetch')

    try {
      const result = await enableProxy(settings)
      expect(result.ok).toBe(true)
      expect(proxySetting.setCalls).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('disableProxy', () => {
  it('clears the setting rather than forcing direct mode', async () => {
    // 🔴 ADR-18：set({mode:'direct'}) 会让本扩展继续持有控制权并强制全局直连，
    // 越权覆盖用户可能存在的系统代理或其他扩展。
    // 「关闭 LostProxy」的正确语义是「不再干预」。
    await enableProxy(settings)
    proxySetting.setCalls = []

    const result = await disableProxy()

    expect(result.ok).toBe(true)
    expect(proxySetting.clearCalls).toHaveLength(1)
    expect(proxySetting.setCalls).toHaveLength(0)
  })

  it('clears with regular scope', async () => {
    await disableProxy()
    expect(proxySetting.clearCalls[0]?.scope).toBe('regular')
  })

  it('releases control back to the lower layers', async () => {
    await enableProxy(settings)
    expect(proxySetting.levelOfControl).toBe('controlled_by_this_extension')

    await disableProxy()
    expect(proxySetting.levelOfControl).toBe('controllable_by_this_extension')
  })

  it('surfaces a clear failure as an error', async () => {
    proxySetting.failNextClear = new Error('clear rejected')

    const result = await disableProxy()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('clear rejected')
  })
})

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
    // 这是自愈策略的地基（ADR-22）：两者的严重程度相反，
    // 因此自愈策略也必须相反。共用一个码就无法区分处理。
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

describe('registerProxyErrorListener', () => {
  it('registers exactly one listener', () => {
    registerProxyErrorListener(() => {})
    expect(proxyErrorListenerCount()).toBe(1)
  })

  it('forwards a normalized error to the handler', () => {
    const received: NormalizedError[] = []
    registerProxyErrorListener((error) => {
      received.push(error)
    })

    emitProxyError({ fatal: false, error: 'net::ERR_PROXY_CONNECTION_FAILED', details: '' })

    expect(received).toHaveLength(1)
    expect(received[0]?.code).toBe('PROXY_LEAK_SUSPECTED')
    expect(received[0]?.message).toMatch(/may have been exposed/i)
  })
})

// ===========================================================================
// V0.4 分流模式
// ===========================================================================

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
