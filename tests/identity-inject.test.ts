/**
 * 时区注入函数的测试。
 *
 * ## 为什么这些用例全部跑在 `vm` 的独立上下文里
 *
 * `chrome.scripting.executeScript({ func })` 不是把函数传过去，而是
 * **取它的 `toString()`**、在页面的 globalThis 里重新求值。也就是说：
 *
 *   - 闭包不传递；
 *   - 模块作用域里的一切（包括同文件的其它顶层函数）都不存在；
 *   - 打包时被重命名的标识符也不存在。
 *
 * 违反任何一条，注入在真实页面上就是一个 `ReferenceError` —— 整段脚本
 * 失效、页面恢复真实时区、浏览器不报错、我们也不知道。
 *
 * 那种错误在单元测试里**不会**出现，因为测试和源码共享模块作用域。
 * 所以这里必须换一个上下文：`vm.createContext({})` 给了一个全新的
 * globalThis，函数源码在里面重新求值，一旦它偷偷引用了外部东西，
 * 这里就会红。这跟 `platform-boundary.test.ts` 在解压后的 zip 上
 * 再验一次是同一个思路 —— 守的必须是**产物形态**上的事实。
 */

import { createContext, runInContext, type Context } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { installIdentity } from '../src/background/inject-timezone'

/** 注入档案的裸形状。不用 `SpoofProfile`：测试要验的是**序列化后**的形态。 */
type Profile = { zone: string; locale: string | null }

/**
 * 在独立上下文里装上时区，返回该上下文。
 *
 * 注意是 `runInContext('(' + source + ')')` 而不是直接调用 `installIdentity`：
 * 前者会让函数在**新的 globalThis** 里被重新创建，后者用的是模块的。
 */
function installed(zone: string, locale: string | null = null): Context {
  const context = createContext({})
  const source = installIdentity.toString()
  const factory = runInContext(`(${source})`, context) as (profile: Profile) => void
  factory({ zone, locale })
  return context
}

function evalIn(context: Context, code: string): unknown {
  return runInContext(code, context)
}

describe('installIdentity — 自包含性', () => {
  it('runs from its own source alone, with no access to module scope', () => {
    // 这条用例真正的断言是「没有抛 ReferenceError」。
    // 函数体里若引用任何外部标识符，这里就红了。
    const context = installed('Asia/Tokyo')
    expect(evalIn(context, 'new Date(0).getTimezoneOffset()')).toBe(-540)
  })

  it('survives being installed twice without stacking', () => {
    const context = installed('Asia/Tokyo')
    const factory = runInContext(`(${installIdentity.toString()})`, context) as (
      profile: Profile,
    ) => void
    factory({ zone: 'Asia/Tokyo', locale: null })

    // 装两次若各自包了一层，toString 会被套两次，偏移也会算错。
    expect(evalIn(context, 'new Date(0).getTimezoneOffset()')).toBe(-540)
    expect(String(evalIn(context, 'new Date(0).toString()'))).toContain('GMT+0900')
  })

  it('switches target zone when re-installed with a different one', () => {
    const context = installed('Asia/Tokyo')
    const factory = runInContext(`(${installIdentity.toString()})`, context) as (
      profile: Profile,
    ) => void
    factory({ zone: 'Europe/London', locale: null })

    // 1 月伦敦是 GMT+0。
    expect(evalIn(context, 'new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset()')).toBe(0)
  })
})

describe('installIdentity — 偏移', () => {
  it('reports the offset with getTimezoneOffset sign convention', () => {
    // 东京恒为 UTC+9，getTimezoneOffset 的约定是 UTC − local，所以是 -540。
    expect(evalIn(installed('Asia/Tokyo'), 'new Date(0).getTimezoneOffset()')).toBe(-540)
  })

  it('handles a negative-offset zone', () => {
    // 纽约 1 月：UTC−5 → +300。
    expect(
      evalIn(installed('America/New_York'), 'new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()'),
    ).toBe(300)
  })

  it('follows DST instead of caching one offset', () => {
    /*
     * 🔴 这是整个实现里最容易写错的一处：把偏移算一次存下来，
     *    在有 DST 的时区上会有半年是错的。纽约 1 月是 −5、7 月是 −4。
     */
    const context = installed('America/New_York')
    expect(evalIn(context, 'new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()')).toBe(300)
    expect(evalIn(context, 'new Date(Date.UTC(2026, 6, 15)).getTimezoneOffset()')).toBe(240)
  })
})

describe('installIdentity — 本地时间 getter', () => {
  it('shifts getHours across the day boundary', () => {
    const context = installed('Asia/Tokyo')
    // UTC 03:00 → 东京 12:00
    expect(evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 3, 0, 0)).getHours()')).toBe(12)
    // UTC 20:00 → 东京次日 05:00
    expect(evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 20, 0, 0)).getHours()')).toBe(5)
  })

  it('shifts getDate when the target zone is already on the next day', () => {
    const context = installed('Asia/Tokyo')
    // UTC 10-29 20:00 在东京是 10-30 05:00
    expect(evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 20, 0, 0)).getDate()')).toBe(30)
    expect(evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 20, 0, 0)).getMonth()')).toBe(9)
    expect(evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 20, 0, 0)).getFullYear()')).toBe(2026)
  })

  it('keeps getDay consistent with the shifted date', () => {
    const context = installed('Asia/Tokyo')
    // 2026-10-30 是周五（5）。用 UTC 10-29（周四=4）会差一天。
    expect(evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 20, 0, 0)).getDay()')).toBe(5)
  })

  it('returns NaN for an invalid date rather than throwing', () => {
    const context = installed('Asia/Tokyo')
    expect(evalIn(context, 'new Date(NaN).getHours()')).toBeNaN()
    expect(evalIn(context, 'new Date(NaN).getTimezoneOffset()')).toBeNaN()
    expect(evalIn(context, 'String(new Date(NaN).toString())')).toBe('Invalid Date')
  })
})

describe('installIdentity — 字符串形式', () => {
  it('reports the spoofed zone in toString', () => {
    const context = installed('Asia/Tokyo')
    const text = String(evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 3, 0, 0)).toString()'))

    expect(text).toContain('GMT+0900')
    expect(text).toContain('12:00:00')
    expect(text).toContain('Oct')
    expect(text).toContain('2026')
    // 不含真实时区（宿主是 +08:00 时这条才有意义，但断言方向恒成立）。
    expect(text).not.toContain('GMT+0800')
  })

  it('reports the spoofed zone in toTimeString and toDateString', () => {
    const context = installed('Asia/Tokyo')
    const time = String(evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 3, 0, 0)).toTimeString()'))
    const date = String(evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 3, 0, 0)).toDateString()'))

    expect(time).toContain('12:00:00')
    expect(time).toContain('GMT+0900')
    expect(date).toBe('Thu Oct 29 2026')
  })

  it('reports the spoofed zone in toLocaleString', () => {
    /*
     * 不传 options —— 只有这样才会走我们补的那套默认字段（日期 + 时间）。
     * 传了 options 就完全以它为准（原生语义如此），那时时间字段在不在
     * 取决于调用方写了什么，测不出我们对默认字段的处理对不对。
     */
    const context = installed('Asia/Tokyo')
    const text = String(
      evalIn(context, 'new Date(Date.UTC(2026, 9, 29, 3, 0, 0)).toLocaleString("en-US")'),
    )
    expect(text).toContain('12:00:00')
    expect(text).toContain('10/29/2026')
  })
})

describe('installIdentity — Intl', () => {
  it('reports the spoofed zone from resolvedOptions', () => {
    const context = installed('Asia/Tokyo')
    expect(evalIn(context, 'new Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe(
      'Asia/Tokyo',
    )
  })

  it('formats with the spoofed zone by default', () => {
    const context = installed('Asia/Tokyo')
    const text = String(
      evalIn(
        context,
        'new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(Date.UTC(2026, 9, 29, 3, 0, 0)))',
      ),
    )
    expect(text).toContain('12:00')
  })

  it('still honours an explicit timeZone', () => {
    // 页面问「洛杉矶现在几点」时不该被我们改掉 —— 那是另一个问题。
    const context = installed('Asia/Tokyo')
    const text = String(
      evalIn(
        context,
        'new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Los_Angeles" }).format(new Date(Date.UTC(2026, 9, 29, 3, 0, 0)))',
      ),
    )
    expect(text).toContain('20:00')
  })

  it('keeps existing usages working after the replacement', () => {
    // Proxy 必须转发静态方法与 prototype，否则页面的 `instanceof`
    // 和 `Intl.DateTimeFormat.prototype.format.call` 都会坏。
    const context = installed('Asia/Tokyo')
    expect(evalIn(context, 'typeof Intl.DateTimeFormat.supportedLocalesOf')).toBe('function')
    expect(evalIn(context, 'new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat')).toBe(true)
    expect(evalIn(context, 'typeof Intl.DateTimeFormat.prototype.formatToParts')).toBe('function')
    // 实例上的 format 是访问器返回的绑定函数，仍要能正常格式化。
    expect(
      evalIn(
        context,
        'new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 29)))',
      ),
    ).toBe('2026')
  })
})

// ---------------------------------------------------------------------------
// V0.10：语言
// ---------------------------------------------------------------------------

/**
 * 造一个与真实结构一致的 `navigator`。
 *
 * `language` / `languages` 必须在**原型**上，实例自身没有这两个属性 ——
 * 原生就是这样（NavigatorLanguage mixin）。如果直接在实例上放数据属性，
 * 注入的 `defineProperty`（写在原型上）会被实例遮蔽，测试会假通过：
 * 读到的仍是注入前塞进去的值，而什么都没验证。
 */
function withNavigator(native: { language: string; languages: string[] }): Context {
  const context = createContext({})
  runInContext(
    `(function () {
      function Proto() {}
      Object.defineProperty(Proto.prototype, 'language', {
        configurable: true,
        enumerable: true,
        get: function () { return ${JSON.stringify(native.language)} },
      })
      Object.defineProperty(Proto.prototype, 'languages', {
        configurable: true,
        enumerable: true,
        get: function () { return ${JSON.stringify(native.languages)} },
      })
      globalThis.navigator = new Proto()
    })()`,
    context,
  )
  return context
}

function installIn(context: Context, profile: Profile): void {
  const factory = runInContext(`(${installIdentity.toString()})`, context) as (
    p: Profile,
  ) => void
  factory(profile)
}

const ZH = { language: 'zh-CN', languages: ['zh-CN', 'zh'] }

describe('installIdentity — 语言', () => {
  it('replaces navigator.language', () => {
    const context = withNavigator(ZH)
    installIn(context, { zone: 'America/Los_Angeles', locale: 'en-US' })

    expect(evalIn(context, 'navigator.language')).toBe('en-US')
  })

  it('gives a language list shaped like a real browser', () => {
    const context = withNavigator(ZH)
    installIn(context, { zone: 'America/Los_Angeles', locale: 'en-US' })

    expect(evalIn(context, 'navigator.languages')).toEqual(['en-US', 'en'])
  })

  it('🔴 leaves navigator alone when there is no locale', () => {
    /*
     * 国家查不到时只改时区。硬塞一个 `en-US` 会让「冷门国家 + 英文浏览器」
     * 成为页面呈现的组合 —— 那是真实用户身上不会出现的搭配，
     * 比语言保持原样更容易被识别。
     */
    const context = withNavigator(ZH)
    installIn(context, { zone: 'Asia/Shanghai', locale: null })

    expect(evalIn(context, 'navigator.language')).toBe('zh-CN')
    expect(evalIn(context, 'navigator.languages')).toEqual(['zh-CN', 'zh'])
  })

  it('reports the spoofed locale through resolvedOptions()', () => {
    /*
     * 这一条比 navigator 更重要：不少页面用 `resolvedOptions().locale`
     * 而不是 `navigator.language` 来判断语言，两个答案不一致本身
     * 就是一条可采集的特征。
     */
    const context = withNavigator(ZH)
    installIn(context, { zone: 'America/Los_Angeles', locale: 'en-US' })

    expect(evalIn(context, 'new Intl.DateTimeFormat().resolvedOptions().locale')).toBe('en-US')
    expect(evalIn(context, 'new Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe(
      'America/Los_Angeles',
    )
  })

  it('still honours an explicitly requested locale', () => {
    // 页面问「用日语给我格式化」时不该被改成英文 —— 那是它的明确意图。
    const context = withNavigator(ZH)
    installIn(context, { zone: 'America/Los_Angeles', locale: 'en-US' })

    expect(evalIn(context, "new Intl.DateTimeFormat('ja-JP').resolvedOptions().locale")).toBe(
      'ja-JP',
    )
  })

  it('switches language on re-install without re-wrapping', () => {
    const context = withNavigator(ZH)
    installIn(context, { zone: 'Asia/Tokyo', locale: 'ja-JP' })
    installIn(context, { zone: 'America/Los_Angeles', locale: 'en-US' })

    expect(evalIn(context, 'navigator.language')).toBe('en-US')
    expect(evalIn(context, 'new Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe(
      'America/Los_Angeles',
    )
  })

  it('returns a fresh languages array on every read', () => {
    // 页面 push 一下之后，后续读取不该看见那次修改。
    const context = withNavigator(ZH)
    installIn(context, { zone: 'America/Los_Angeles', locale: 'en-US' })

    expect(
      evalIn(
        context,
        '(function () { navigator.languages.push("fr"); return navigator.languages.length })()',
      ),
    ).toBe(2)
  })
})
