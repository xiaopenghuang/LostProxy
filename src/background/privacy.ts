/**
 * chrome.privacy 封装 —— WebRTC IP 处理策略。
 *
 * 存在理由见 architecture.md ADR-05 与 security.md §3：
 *   本项目的唯一价值主张是「浏览器出口 IP 隔离」，
 *   而 webRTCIPHandlingPolicy 的浏览器默认值是 'default'，
 *   **不强制 WebRTC 走代理**——页面可通过 ICE 枚举拿到真实公网/内网 IP，
 *   完全绕过 HTTP 代理。不加锁等于卖点自带缺口。
 *
 * ⚠️ 模块边界：与 proxy.ts 同理，本文件只管 chrome.privacy 这一件事，
 *    「什么时候该加锁」的编排交给 Service Worker。
 */

import { SETTING_SCOPE, WEBRTC_LOCKED_POLICY } from '../shared/constants'
import { describeThrown, errors } from '../shared/errors'
import type { ApplyResult, LevelOfControl } from '../shared/types'

/** WebRTC 策略巡检结果。 */
export interface WebRtcInspection {
  /** 当前生效的策略值。查询失败时为 null。 */
  policy: string | null
  levelOfControl: LevelOfControl | 'unknown'
  /** 是否已处于加锁状态。 */
  locked: boolean
}

/** 巡检当前 WebRTC IP 处理策略。查询失败返回 'unknown' 而不抛错。 */
export async function inspectWebRtcPolicy(): Promise<WebRtcInspection> {
  try {
    const result = await chrome.privacy.network.webRTCIPHandlingPolicy.get({})
    return {
      policy: result.value ?? null,
      levelOfControl: result.levelOfControl,
      locked: result.value === WEBRTC_LOCKED_POLICY,
    }
  } catch {
    return { policy: null, levelOfControl: 'unknown', locked: false }
  }
}

/**
 * 加锁：强制 WebRTC 媒体走代理。
 *
 * 与 enableProxy 保持一致的处理：被其他扩展或 Policy 控制时不强行覆盖，
 * 但 'unknown'（查询失败）不阻断写入——保护优先。
 */
export async function lockWebRtc(): Promise<ApplyResult> {
  const inspection = await inspectWebRtcPolicy()

  if (inspection.levelOfControl === 'not_controllable') {
    return { ok: false, error: errors.privacyNotControllable() }
  }
  if (inspection.levelOfControl === 'controlled_by_other_extensions') {
    return { ok: false, error: errors.privacyControlledByOther() }
  }

  try {
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({
      value: WEBRTC_LOCKED_POLICY,
      scope: SETTING_SCOPE,
    })
    return { ok: true }
  } catch (thrown) {
    return { ok: false, error: errors.privacyWriteFailed(describeThrown(thrown)) }
  }
}

/**
 * 解锁：释放对 WebRTC 策略的控制。
 *
 * 用 `clear()` 而不是 `set({ value: 'default' })`，理由与 disableProxy 相同
 * （architecture.md ADR-18）：显式写 'default' 会让本扩展继续持有控制权，
 * 并覆盖用户或其他扩展可能设置的更严格策略。
 * 「LostProxy 不再加锁」不等于「强制 WebRTC 回到最宽松模式」。
 */
export async function unlockWebRtc(): Promise<ApplyResult> {
  try {
    await chrome.privacy.network.webRTCIPHandlingPolicy.clear({ scope: SETTING_SCOPE })
    return { ok: true }
  } catch (thrown) {
    return { ok: false, error: errors.privacyWriteFailed(describeThrown(thrown)) }
  }
}

/**
 * 按用户设置与代理开关状态，把 WebRTC 锁调整到应有的样子。
 *
 * 语义决策：**只在代理开启时加锁**。
 *   代理关闭时锁 WebRTC 没有保护意义（本来就是直连），
 *   却会实实在在地降低 WebRTC 通话质量（强制走 TCP）。
 *   把锁的生命周期绑定在代理开关上，是收益/代价比最优的选择。
 *
 * @param proxyEnabled 代理开关的当前状态
 * @param lockPreference 用户是否启用了 WebRTC 锁（Settings 项）
 */
export async function syncWebRtcLock(
  proxyEnabled: boolean,
  lockPreference: boolean,
): Promise<ApplyResult> {
  return proxyEnabled && lockPreference ? lockWebRtc() : unlockWebRtc()
}
