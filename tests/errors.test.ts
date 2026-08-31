/**
 * 错误分类单元测试。
 *
 * 这里锁定的是 ADR-22 的地基：**哪些告警允许自动消失**。
 *
 * 这个判断一旦错到「不该消失的消失了」那一侧，后果是用户永远不知道
 * 自己的真实 IP 曾经泄漏过 —— 而那是本项目唯一真正需要告知用户的事。
 * 所以这组测试值得写得比它看起来的分量更重。
 */

import { describe, expect, it } from 'vitest'
import { errors, isLeakSuspected, isSelfHealing, makeError } from '../src/shared/errors'
import type { ErrorCode } from '../src/shared/types'

/**
 * 每个错误码是否允许自愈的期望表。
 *
 * ⚠️ 刻意用 `Record<ErrorCode, boolean>` 而不是数组：
 *   新增一个 ErrorCode 时如果忘了在这里表态，**tsc 会直接编译失败**。
 *   用数组的话漏掉一个码不会有任何提示，而漏掉的那个码
 *   会静默继承默认行为——在安全告警上这是不可接受的。
 */
const EXPECTED_SELF_HEALING: Record<ErrorCode, boolean> = {
  CORE_OFFLINE: false,
  CORE_AUTH_FAILED: false,
  CORE_BAD_RESPONSE: false,
  PROXY_CONTROLLED_BY_OTHER: false,
  PROXY_NOT_CONTROLLABLE: false,
  // 唯一可自愈的：fatal=true，请求被拦住了、没有泄漏，
  // 所以问题解决后这条记录就没有保留价值。
  PROXY_RUNTIME_ERROR: true,
  PROXY_LEAK_SUSPECTED: false,
  INVALID_SETTINGS: false,
  UNKNOWN: false,
}

const ALL_CODES = Object.keys(EXPECTED_SELF_HEALING) as ErrorCode[]

describe('isSelfHealing', () => {
  it.each(ALL_CODES)('classifies %s correctly', (code) => {
    expect(isSelfHealing(code)).toBe(EXPECTED_SELF_HEALING[code])
  })

  it('🔴 never lets a suspected leak self-heal', () => {
    // 单独拎出来写一遍，因为这是整个分类里唯一不能错的一格。
    expect(isSelfHealing('PROXY_LEAK_SUSPECTED')).toBe(false)
  })

  it('allows exactly one code to self-heal', () => {
    // 白名单必须保持极窄。若将来有人图省事改成黑名单，
    // 这条会在新增码时暴露出来。
    const healing = ALL_CODES.filter(isSelfHealing)
    expect(healing).toEqual(['PROXY_RUNTIME_ERROR'])
  })
})

describe('isLeakSuspected', () => {
  it.each(ALL_CODES)('classifies %s correctly', (code) => {
    expect(isLeakSuspected(code)).toBe(code === 'PROXY_LEAK_SUSPECTED')
  })

  it('is mutually exclusive with self-healing', () => {
    // 一个错误不可能既「可以悄悄消失」又「疑似已经泄漏」。
    for (const code of ALL_CODES) {
      expect(isSelfHealing(code) && isLeakSuspected(code)).toBe(false)
    }
  })
})

describe('makeError', () => {
  it('stamps a timestamp', () => {
    const before = Date.now()
    expect(makeError('UNKNOWN', 'error.unknown', { reason: 'x' }).at).toBeGreaterThanOrEqual(before)
  })

  it('generates an English fallback message from the key', () => {
    // message 是日志兜底，由 key 自动生成 —— 因此永远与英文字典一致，
    // 不会出现「改了字典忘了改兜底」的漂移。
    const error = makeError('UNKNOWN', 'error.unknown', { reason: 'boom' })
    expect(error.message).toBe('Something went wrong: boom')
  })

  it('keeps the key and params for the UI to translate', () => {
    const error = makeError('CORE_OFFLINE', 'error.coreOffline', { host: '127.0.0.1', port: 9097 })
    expect(error.key).toBe('error.coreOffline')
    expect(error.params).toEqual({ host: '127.0.0.1', port: 9097 })
  })
})

describe('standard messages', () => {
  it('gives the blocked case a reassuring, actionable message', () => {
    const message = errors.proxyBlocked().message
    expect(message).toMatch(/not exposed/i)
    expect(message).toMatch(/mihomo/i)
  })

  it('gives the leak case a message with no reassurance at all', () => {
    const message = errors.proxyLeakSuspected().message
    expect(message).toMatch(/may have been exposed/i)
    expect(message).not.toMatch(/not exposed/i)
  })

  it('points the core-offline message at the right port to check', () => {
    // 用户改过端口时，不说明探的是哪个地址他无从判断是不是自己填错了。
    // 而 Controller 端口是独立的一项，极易被误解为跟代理端口一起变。
    const message = errors.coreOffline('127.0.0.1', 9097).message
    expect(message).toContain('127.0.0.1:9097')
    expect(message).toMatch(/external-controller/i)
    expect(message).toMatch(/separate port/i)
  })

  it('keeps raw Chromium error codes out of every standard message', () => {
    const messages = [
      errors.proxyBlocked().message,
      errors.proxyLeakSuspected().message,
      errors.coreOffline('127.0.0.1', 9090).message,
      errors.coreAuthFailed().message,
      errors.coreBadResponse().message,
      errors.proxyControlledByOther().message,
      errors.proxyNotControllable().message,
    ]

    for (const message of messages) {
      expect(message).not.toContain('net::')
      expect(message).not.toContain('ERR_')
    }
  })

  it('matches the wording required by the spec for auth failure', () => {
    // 技术方案 §22 Case 2 对这条文案有明确要求。
    expect(errors.coreAuthFailed().message).toContain('Controller Secret')
  })
})
