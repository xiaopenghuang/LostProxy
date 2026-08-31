/**
 * 代理**决策层**单元测试。
 *
 * 本文件的价值不在于覆盖率，而在于把 architecture.md 里的**安全决策**
 * 变成可执行断言。以下几条如果退化，项目的核心价值就没了，
 * 而它们全都是「不会报错、只会静默泄漏」的那种退化：
 *
 *   - 被别的扩展 / Policy 控制时**拒绝写入**（不显示假 ON）
 *   - 查询失败（unknown）**不阻断**写入（放弃写入的代价是泄漏）
 *   - 关闭必须用「释放控制权」而非「强制直连」（ADR-18）
 *   - enableProxy 绝不能依赖 Core 可用性（ADR-03 fail-closed）
 *
 * ## 与 platform-chromium.test.ts 的分工
 *
 * 判据只有一条，且是可操作的：
 *
 *   **移植到 Firefox 时这条断言需要改吗？需要 → 那边；不需要 → 这里。**
 *
 * 所以本文件里**没有**任何断言涉及 `fixed_servers` / `singleProxy` /
 * `bypassList` / `scope: 'regular'` / `fatal` 字段 —— 那些形状与值都是
 * Chromium 特有的，住在 `platform-chromium.test.ts`（ADR-36）。
 *
 * 本文件断言的是与浏览器无关的**策略**。接 Firefox 时这些断言应当一条都不用改；
 * 若发现需要改，说明平台边界划错了，那是个该停下来的信号。
 *
 * ⚠️ 测试用的 `chrome.*` mock 本身当然是 Chromium 形状的（`tests/setup.ts`）——
 *    目前只有一个平台实现，没有别的选择。这不削弱上面的分工：
 *    判据看的是**断言**在说什么，不是它经由哪套 mock 到达。
 */

import { describe, expect, it } from 'vitest'
import {
  disableProxy,
  enableProxy,
  inspectProxy,
  isBlockedByControl,
  registerProxyErrorListener,
} from '../src/background/proxy'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { Settings } from '../src/shared/types'
import { proxyErrorListenerCount, proxySetting } from './setup'

const settings: Settings = { ...DEFAULT_SETTINGS, proxyHost: '127.0.0.1', proxyPort: 7890 }

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

  it('reports a mismatch when the port differs', async () => {
    await enableProxy(settings)
    const inspection = await inspectProxy({ ...settings, proxyPort: 1080 })
    expect(inspection.matchesExpected).toBe(false)
  })

  it('degrades to unknown instead of throwing when the query fails', async () => {
    /*
     * 这是共享层的决策：平台方法查询失败时**抛错**，由 inspectProxy 兜成
     * 'unknown'。上层需要「查不到」与「查到了但不匹配」在类型上就分得开 ——
     * 否则一次查询失败会被当成「代理没生效」而触发不必要的重写。
     */
    proxySetting.failNextGet = new Error('boom')
    const inspection = await inspectProxy(settings)
    expect(inspection.levelOfControl).toBe('unknown')
    expect(inspection.matchesExpected).toBe(false)
  })
})

describe('enableProxy', () => {
  it('writes the config exactly once', async () => {
    const result = await enableProxy(settings)

    expect(result.ok).toBe(true)
    expect(proxySetting.setCalls).toHaveLength(1)
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
    /*
     * 平台方法抛错，共享层归一成 NormalizedError。
     * 归一放在共享层是刻意的：挑错误码、写文案是决策，
     * 若每个平台各归一一次，两边的安全提示措辞迟早漂移。
     */
    proxySetting.failNextSet = new Error('set rejected')

    const result = await enableProxy(settings)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('set rejected')
  })

  it('applies the proxy without depending on the core being reachable', async () => {
    // 🔴 ADR-03 fail-closed 的结构保证：代理层刻意不 import mihomo，
    // 不发任何网络请求。这里把 fetch 直接从全局删掉——
    // 若 enableProxy 或其下的平台实现内部偷偷做了探活，就会炸在这条测试上。
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
    // 🔴 ADR-18：写一个显式的 direct 配置会让本扩展继续持有控制权并强制全局直连，
    // 越权覆盖用户可能存在的系统代理或其他扩展。
    // 「关闭 LostProxy」的正确语义是「不再干预」。
    await enableProxy(settings)
    proxySetting.setCalls = []

    const result = await disableProxy()

    expect(result.ok).toBe(true)
    expect(proxySetting.clearCalls).toHaveLength(1)
    expect(proxySetting.setCalls).toHaveLength(0)
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

describe('registerProxyErrorListener', () => {
  it('registers exactly one listener', () => {
    /*
     * 只验「注册了一个」这件事，不验归一结果 —— 后者取决于原始事件的形状
     * （Chromium 的 fatal 字段），住在 platform-chromium.test.ts。
     *
     * ⚠️ MV3 约束：这个注册必须在 Service Worker 顶层同步发生。
     *    延迟注册会让 SW 被唤醒后的事件在监听器挂上之前丢失 ——
     *    而丢掉的可能正是那条 fatal=false（已经直连过）的告警。
     */
    registerProxyErrorListener(() => {})
    expect(proxyErrorListenerCount()).toBe(1)
  })
})
