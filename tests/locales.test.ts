/**
 * 国家 → 语言的映射与 `Accept-Language` 值生成。
 *
 * 这里没有 mock 任何东西：整份逻辑是纯函数，输入输出都是字符串。
 * 真正需要小心的是**表本身**——一个手误（`ja-JP` 写成 `ja_JP`）在
 * 类型上完全合法，只有到页面里 `new Intl.DateTimeFormat` 抛 RangeError
 * 时才会暴露，而那时整段注入已经失效了。所以下面有一条专门遍历全表。
 */

import { describe, expect, it } from 'vitest'
import {
  acceptLanguageValue,
  COUNTRY_LOCALE,
  isValidLocale,
  languageListFor,
  localeForCountry,
  primarySubtag,
} from '../src/shared/locales'

describe('localeForCountry', () => {
  it('maps common exit countries', () => {
    expect(localeForCountry('US')).toBe('en-US')
    expect(localeForCountry('JP')).toBe('ja-JP')
    expect(localeForCountry('HK')).toBe('zh-HK')
    expect(localeForCountry('DE')).toBe('de-DE')
    expect(localeForCountry('BR')).toBe('pt-BR')
  })

  it('is case-insensitive and trims', () => {
    // 探测源的响应格式并不统一，两个源一个给大写一个给小写都见过。
    expect(localeForCountry('us')).toBe('en-US')
    expect(localeForCountry(' Jp ')).toBe('ja-JP')
  })

  it('returns null for anything unrecognised', () => {
    /*
     * 「查不到」必须是 null 而不是某个兜底值。兜底成 en-US 会让
     * 「一个冷门国家 + 英文浏览器」成为可能 —— 那是不存在于真实用户
     * 身上的组合，比不写语言更容易被识别。
     */
    expect(localeForCountry('ZZ')).toBeNull()
    expect(localeForCountry('')).toBeNull()
    expect(localeForCountry(null)).toBeNull()
    expect(localeForCountry(42)).toBeNull()
    expect(localeForCountry('USA')).toBeNull()
  })

  it('🔴 表里每个值都是 Intl 能接受的 locale', () => {
    /*
     * 这条守的是手误。`ja_JP`（下划线）、`en US`（空格）、`zh-Hant-TW` 里
     * 打错一个字符，类型检查一律放行 —— 而它的运行时后果是页面上的
     * `Intl.DateTimeFormat` 抛 RangeError，整段注入失效，页面恢复成
     * 真实时区与语言，且没有任何提示。
     */
    const bad: string[] = []
    for (const [country, locale] of Object.entries(COUNTRY_LOCALE)) {
      if (!isValidLocale(locale)) bad.push(`${country}=${locale}`)
    }
    expect(bad, `这些 locale 是不合法的 BCP-47：${bad.join(', ')}`).toEqual([])
  })

  it('表里的 locale 与国家的首字母没有明显错位', () => {
    /*
     * 不是严格规则（`CH` → `de-CH` 就符合），但能挡住最粗心的那一类
     * 复制粘贴错误：把 `IT` 写成 `fr-FR`。
     *
     * 只检查"两种语言区不该出现同一个值"这种结构性错误，不检查具体映射 ——
     * 具体映射靠人看，机器只能挡明显的手滑。
     */
    const values = Object.values(COUNTRY_LOCALE)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('isValidLocale', () => {
  it('accepts canonical tags', () => {
    expect(isValidLocale('en-US')).toBe(true)
    expect(isValidLocale('zh-Hant-TW')).toBe(true)
    expect(isValidLocale('ja')).toBe(true)
  })

  it('rejects malformed input', () => {
    expect(isValidLocale('')).toBe(false)
    expect(isValidLocale('en US')).toBe(false)
    expect(isValidLocale('en_US')).toBe(false)
    expect(isValidLocale(null)).toBe(false)
    expect(isValidLocale(0)).toBe(false)
    expect(isValidLocale('x'.repeat(40))).toBe(false)
  })

  it('rejects a tag that is valid but non-canonical', () => {
    /*
     * `Intl.getCanonicalLocales` 会把 `EN-us` 规范化成 `en-US`，两者
     * 不相等，所以这里判 false。理由：这个值会进到页面的
     * `resolvedOptions().locale`，而那里返回的一定是规范形式 ——
     * 存一个非规范值，会让「显示的语言」和「实际生效的语言」不一致。
     */
    expect(isValidLocale('EN-us')).toBe(false)
  })
})

describe('acceptLanguageValue', () => {
  it('matches the shape a real browser sends', () => {
    /*
     * 照抄 Chrome 在「只设了一种语言」时的实际输出。这个格式值得较真：
     * 只写 `en-US` 的头与真实浏览器不同，而请求头内容的差异本身就是
     * 一条可采集的特征。
     */
    expect(acceptLanguageValue('en-US')).toBe('en-US,en;q=0.9')
    expect(acceptLanguageValue('zh-HK')).toBe('zh-HK,zh;q=0.9')
    expect(acceptLanguageValue('ja-JP')).toBe('ja-JP,ja;q=0.9')
  })

  it('does not repeat the tag when there is no region', () => {
    // `eo,eo;q=0.9` 在真实浏览器里不存在。
    expect(acceptLanguageValue('eo')).toBe('eo')
  })
})

describe('primarySubtag', () => {
  it('takes the part before the first dash', () => {
    expect(primarySubtag('en-US')).toBe('en')
    expect(primarySubtag('zh-Hant-TW')).toBe('zh')
    expect(primarySubtag('ja')).toBe('ja')
  })
})

describe('languageListFor', () => {
  it('returns the tag plus its primary subtag', () => {
    expect(languageListFor('en-US')).toEqual(['en-US', 'en'])
  })

  it('🔴 returns a fresh array every time', () => {
    /*
     * 页面拿到 `navigator.languages` 之后完全可能 `push` 或 `sort`。
     * 共享同一个实例会让那次修改沉淀下来、并泄漏到后续每一次读取 ——
     * 表现为「页面改过一次，之后所有代码都读到被改过的值」。
     * 原生 getter 每次也给新数组，这里必须一致。
     */
    const first = languageListFor('en-US')
    first.push('fr')
    expect(languageListFor('en-US')).toEqual(['en-US', 'en'])
  })
})
