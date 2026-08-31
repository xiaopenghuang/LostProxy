/**
 * WebRTC 锁的**决策层**单元测试。
 *
 * 核心断言的是一条与浏览器无关的策略：
 *
 *   **锁的生命周期绑定在代理开关上** —— 代理关闭时必须解锁，
 *   因为那时候锁 WebRTC 没有保护意义（本来就是直连），
 *   却会实实在在地降低通话质量（强制走 TCP）。
 *
 * 加上「被别的扩展控制时不强行覆盖」「查询失败不阻断写入」
 * 「解锁用释放而非写一个宽松值」这三条 —— 全部与平台无关。
 *
 * ## 那个具体的策略值不在这里
 *
 * 🔴 `disable_non_proxied_udp` 这个**值**是 Chromium 特有的，断言它的测试
 *    住在 `platform-chromium.test.ts`。原因不是分类洁癖：自 Firefox 70 起
 *    （Bugzilla 1452713）同名值的语义退化成「有代理才强制」，
 *    抄过去会被**接受**、**不报错**、而防护**更弱**，等价物是 `proxy_only`。
 *
 *    把值的断言留在这里会让它读起来像"全平台都该是这个值"——
 *    而那正是抄错的起点（architecture.md ADR-36）。
 */

import { describe, expect, it } from 'vitest'
import {
  inspectWebRtcPolicy,
  lockWebRtc,
  syncWebRtcLock,
  unlockWebRtc,
} from '../src/background/privacy'
import { webRtcSetting } from './setup'

describe('lockWebRtc', () => {
  it('applies the lock exactly once', async () => {
    const result = await lockWebRtc()

    expect(result.ok).toBe(true)
    expect(webRtcSetting.setCalls).toHaveLength(1)
  })

  it('refuses to override another extension', async () => {
    webRtcSetting.levelOfControl = 'controlled_by_other_extensions'

    const result = await lockWebRtc()

    expect(result.ok).toBe(false)
    expect(webRtcSetting.setCalls).toHaveLength(0)
  })

  it('refuses when locked down by policy', async () => {
    webRtcSetting.levelOfControl = 'not_controllable'

    const result = await lockWebRtc()

    expect(result.ok).toBe(false)
    expect(webRtcSetting.setCalls).toHaveLength(0)
  })

  it('still attempts the write when the control query fails', async () => {
    webRtcSetting.failNextGet = new Error('query failed')

    const result = await lockWebRtc()

    expect(result.ok).toBe(true)
    expect(webRtcSetting.setCalls).toHaveLength(1)
  })

  it('surfaces a write failure as an error', async () => {
    webRtcSetting.failNextSet = new Error('set rejected')

    const result = await lockWebRtc()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('set rejected')
  })
})

describe('unlockWebRtc', () => {
  it('clears the setting rather than writing a permissive value', async () => {
    // ADR-18：显式写一个值（如 'default'）会让本扩展继续持有控制权，
    // 并覆盖用户或其他扩展可能设置的**更严格**策略。
    await lockWebRtc()
    webRtcSetting.setCalls = []

    const result = await unlockWebRtc()

    expect(result.ok).toBe(true)
    expect(webRtcSetting.clearCalls).toHaveLength(1)
    expect(webRtcSetting.setCalls).toHaveLength(0)
  })

  it('surfaces a clear failure as an error', async () => {
    webRtcSetting.failNextClear = new Error('clear rejected')

    const result = await unlockWebRtc()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('clear rejected')
  })
})

describe('inspectWebRtcPolicy', () => {
  it('reports unlocked on a clean browser', async () => {
    const inspection = await inspectWebRtcPolicy()
    expect(inspection.locked).toBe(false)
    expect(inspection.levelOfControl).toBe('controllable_by_this_extension')
  })

  it('reports locked after applying the lock', async () => {
    // 只验「加锁后 locked 为 true」这个因果，不验具体值 ——
    // 判定 locked 的**值**由平台决定（见文件头 🔴）。
    await lockWebRtc()
    expect((await inspectWebRtcPolicy()).locked).toBe(true)
  })

  it('degrades to unknown instead of throwing when the query fails', async () => {
    webRtcSetting.failNextGet = new Error('boom')
    const inspection = await inspectWebRtcPolicy()
    expect(inspection.levelOfControl).toBe('unknown')
    expect(inspection.locked).toBe(false)
  })
})

describe('syncWebRtcLock', () => {
  it('locks when the proxy is on and the user opted in', async () => {
    await syncWebRtcLock(true, true)
    expect(webRtcSetting.setCalls).toHaveLength(1)
    expect(webRtcSetting.clearCalls).toHaveLength(0)
  })

  it('unlocks when the user opted out', async () => {
    await syncWebRtcLock(true, false)
    expect(webRtcSetting.setCalls).toHaveLength(0)
    expect(webRtcSetting.clearCalls).toHaveLength(1)
  })

  it('unlocks when the proxy is off even if the user opted in', async () => {
    // 语义决策：代理关闭时锁 WebRTC 没有保护意义（本来就是直连），
    // 却会实实在在降低 WebRTC 通话质量。锁的生命周期绑在代理开关上。
    await syncWebRtcLock(false, true)
    expect(webRtcSetting.setCalls).toHaveLength(0)
    expect(webRtcSetting.clearCalls).toHaveLength(1)
  })

  it('unlocks when both are off', async () => {
    await syncWebRtcLock(false, false)
    expect(webRtcSetting.clearCalls).toHaveLength(1)
  })
})
