/**
 * WebRTC 泄漏防护编排 —— WebRTC IP 处理策略的加锁/解锁。
 *
 * 存在理由见 architecture.md ADR-05 与 security.md §3：
 *   本项目的唯一价值主张是「浏览器出口 IP 隔离」，
 *   而 WebRTC IP 处理策略的浏览器默认值**不强制 WebRTC 走代理** ——
 *   页面可通过 ICE 枚举拿到真实公网/内网 IP，完全绕过 HTTP 代理。
 *   不加锁等于卖点自带缺口。
 *
 * ⚠️ 与 proxy.ts 同理：本文件**没有**任何浏览器 API 调用，
 *    `chrome.privacy` 的读写在 `platform/chromium.ts`。
 *    这里只有决策 —— 尤其是「锁的生命周期绑在代理开关上」那一条。
 *
 * 🔴 加锁写入的**值**是平台特有的，而且是"抄过去也能跑但更不安全"的那种差异
 *    （Chromium 用 `disable_non_proxied_udp`，Firefox 的等价物是 `proxy_only`）。
 *    所以本文件刻意**不知道**那个值是什么，只问平台「锁上了吗」。
 *    详见 `platform/types.ts` 文件头那张对照表。
 */

import { describeThrown, errors } from '../shared/errors'
import type { ApplyResult } from '../shared/types'
import { platform } from './platform'
import type { WebRtcInspection } from './platform'

export type { WebRtcInspection }

/** 巡检当前 WebRTC IP 处理策略。查询失败返回 'unknown' 而不抛错。 */
export async function inspectWebRtcPolicy(): Promise<WebRtcInspection> {
  try {
    return await platform.readWebRtcState()
  } catch {
    return { policy: null, levelOfControl: 'unknown', locked: false }
  }
}

/**
 * 加锁：强制 WebRTC 媒体走代理。
 *
 * 与 enableProxy 保持一致的处理：被其他扩展或 Policy 控制时不强行覆盖，
 * 但 'unknown'（查询失败）不阻断写入 —— 保护优先。
 *
 * 这两条判断与 enableProxy 里的那两条是**同一个策略**，刻意在共享层各写一遍
 * 而不抽成公共函数：它们守的是两个不同的浏览器设置，将来完全可能因为
 * 某个平台的差异而分道扬镳（例如 Firefox 的私密窗口授权只影响其中之一）。
 * 现在长得一样，不代表它们是一件事。
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
    await platform.lockWebRtcPolicy()
    return { ok: true }
  } catch (thrown) {
    return { ok: false, error: errors.privacyWriteFailed(describeThrown(thrown)) }
  }
}

/**
 * 解锁：释放对 WebRTC 策略的控制。
 *
 * 平台层用 `clear()` 而不是写一个显式的宽松值，理由与 disableProxy 相同
 * （ADR-18）：显式写值会让本扩展继续持有控制权，并覆盖用户或其他扩展
 * 可能设置的**更严格**策略。「LostProxy 不再加锁」不等于
 * 「强制 WebRTC 回到最宽松模式」。
 */
export async function unlockWebRtc(): Promise<ApplyResult> {
  try {
    await platform.unlockWebRtcPolicy()
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
