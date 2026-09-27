/**
 * Popup 纯展示函数的单元测试（V0.8）。
 *
 * 这些函数放在 `src/popup/format.ts` 而非 `popup.ts` 里，就是为了能这样直接测 ——
 * 不触发 `popup.ts` 的顶层副作用（首次 GET_STATUS、启动轮询）。
 */

import { describe, expect, it } from 'vitest'
import {
  buildSparkline,
  computeRate,
  formatBytes,
  pickFastest,
  sortNodesByLatency,
} from '../src/popup/format'

describe('sortNodesByLatency', () => {
  it('puts measured nodes ascending, untested last', () => {
    expect(sortNodesByLatency(['a', 'b', 'c'], { a: 300, b: null, c: 100 })).toEqual([
      'c',
      'a',
      'b',
    ])
  })

  it('is stable — equal latencies and all-null keep original order', () => {
    // 全 null：原样保持（测速前不打乱订阅顺序）。
    expect(sortNodesByLatency(['x', 'y', 'z'], {})).toEqual(['x', 'y', 'z'])
    // 相等延迟：保持原序。
    expect(sortNodesByLatency(['x', 'y'], { x: 50, y: 50 })).toEqual(['x', 'y'])
  })
})

describe('pickFastest', () => {
  it('returns the lowest-latency node', () => {
    expect(pickFastest(['a', 'b', 'c'], { a: 300, b: 90, c: 150 })).toBe('b')
  })

  it('returns null when nothing has a usable latency', () => {
    expect(pickFastest(['a', 'b'], {})).toBeNull()
    // 0 与负数在内核语义里是失败，不算「最快」。
    expect(pickFastest(['a', 'b'], { a: 0, b: 220 })).toBe('b')
    expect(pickFastest(['a'], { a: 0 })).toBeNull()
  })
})

describe('computeRate', () => {
  it('returns null with no prior sample', () => {
    // UI 靠这个 null 决定「藏起速率」而非显示 0。
    expect(computeRate(null, { up: 0, down: 0, at: 1000 })).toBeNull()
  })

  it('divides the byte delta by the elapsed seconds', () => {
    expect(computeRate({ up: 0, down: 0, at: 1000 }, { up: 100, down: 2048, at: 2000 })).toEqual({
      up: 100,
      down: 2048,
    })
  })

  it('🔴 clamps a counter reset to 0 instead of a negative rate', () => {
    // 内核重启后累计归零，差值为负 —— 钳到 0，别显示负速率或巨大跳变。
    expect(computeRate({ up: 999, down: 999, at: 1000 }, { up: 0, down: 0, at: 2000 })).toEqual({
      up: 0,
      down: 0,
    })
  })

  it('returns null for a zero or negative interval', () => {
    expect(computeRate({ up: 0, down: 0, at: 2000 }, { up: 5, down: 5, at: 2000 })).toBeNull()
  })
})

describe('formatBytes', () => {
  it('uses binary units with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
  })

  it('treats non-positive and non-finite input as 0 B', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('buildSparkline', () => {
  it('maps values to points scaled against the shared max', () => {
    // 两个点，max=100：v=0 → y=height(32)；v=100 → y=0。x 均分 [0,100]。
    expect(buildSparkline([0, 100], 100, 100, 32)).toBe('0.0,32.0 100.0,0.0')
  })

  it('returns an empty string for fewer than two points', () => {
    // 一个点画不出线。
    expect(buildSparkline([5], 10, 100, 32)).toBe('')
    expect(buildSparkline([], 10, 100, 32)).toBe('')
  })

  it('🔴 does not divide by zero when the max is 0 (all idle)', () => {
    // 全零速率时 max=0，不能除爆 —— 落在基线（y=height）。
    expect(buildSparkline([0, 0, 0], 0, 100, 32)).toBe('0.0,32.0 50.0,32.0 100.0,32.0')
  })
})
