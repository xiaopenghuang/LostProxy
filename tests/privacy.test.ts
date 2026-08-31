/**
 * privacy 层单元测试（WebRTC IP 处理策略）。
 *
 * 核心断言两件事：
 *   1. 加锁写入的值必须是 disable_non_proxied_udp（Mode 4「Force proxy」），
 *      而不是任何看起来"更安全"的其它值；
 *   2. 锁的生命周期绑定在代理开关上——代理关闭时必须解锁，
 *      因为那时候锁 WebRTC 没有保护意义，只会白白降低通话质量。
 */

import { describe, expect, it } from 'vitest'
import {
  inspectWebRtcPolicy,
  lockWebRtc,
  syncWebRtcLock,
  unlockWebRtc,
} from '../src/background/privacy'
import { WEBRTC_LOCKED_POLICY } from '../src/shared/constants'
import { webRtcSetting } from './setup'

describe('lockWebRtc', () => {
  it('writes disable_non_proxied_udp with regular scope', () => {
    // 该值对应 IETF draft-ietf-rtcweb-ip-handling 的 Mode 4「Force proxy」。
    expect(WEBRTC_LOCKED_POLICY).toBe('disable_non_proxied_udp')
  })

  it('applies the lock', async () => {
    const result = await lockWebRtc()

    expect(result.ok).toBe(true)
    expect(webRtcSetting.setCalls).toHaveLength(1)
    expect(webRtcSetting.setCalls[0]?.value).toBe('disable_non_proxied_udp')
    expect(webRtcSetting.setCalls[0]?.scope).toBe('regular')
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
  it('clears the setting rather than writing "default"', async () => {
    // ADR-18：显式写 'default' 会让本扩展继续持有控制权，
    // 并覆盖用户或其他扩展可能设置的更严格策略。
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
    await lockWebRtc()
    const inspection = await inspectWebRtcPolicy()
    expect(inspection.locked).toBe(true)
    expect(inspection.policy).toBe('disable_non_proxied_udp')
  })

  it('does not treat a weaker policy as locked', async () => {
    webRtcSetting.value = 'default_public_interface_only'
    const inspection = await inspectWebRtcPolicy()
    expect(inspection.locked).toBe(false)
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
