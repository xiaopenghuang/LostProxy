/**
 * i18n 单元测试。
 *
 * 编译期已经保证两份字典的**键集合**一致
 * （`ZH: Record<keyof typeof EN, string>`，漏翻就编译失败）。
 * 本文件负责编译期查不到的那些一致性：
 *
 *   - 插值占位符是否两边对齐（英文有 {host} 而中文漏了 → 用户看到缺地址的文案）
 *   - 是否有空文案（占位翻译忘了填）
 *   - 中文里是否残留了整段未翻译的英文
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_MESSAGE_KEYS,
  createTranslator,
  languageLabel,
  LANGUAGE_OPTIONS,
  resolveLocale,
  translate,
} from '../src/shared/i18n'

/** 抽出一段文案里的所有 {name} 占位符。 */
function placeholders(text: string): Set<string> {
  return new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ''))
}

describe('dictionary consistency', () => {
  it('covers a non-trivial number of keys', () => {
    // 防止某次重构把字典清空了却没人发现。
    expect(ALL_MESSAGE_KEYS.length).toBeGreaterThan(50)
  })

  it.each(ALL_MESSAGE_KEYS)('%s is non-empty in both locales', (key) => {
    expect(translate('en', key).trim().length).toBeGreaterThan(0)
    expect(translate('zh', key).trim().length).toBeGreaterThan(0)
  })

  it.each(ALL_MESSAGE_KEYS)('%s uses the same placeholders in both locales', (key) => {
    // 🔴 这是编译期抓不到的一类错误：类型只要求中文是 string，
    // 不管它有没有保留 {host} / {port} / {reason} 这些插值点。
    // 漏掉的话用户会看到一句缺了关键信息的提示。
    expect(placeholders(translate('zh', key))).toEqual(placeholders(translate('en', key)))
  })

  it.each(ALL_MESSAGE_KEYS)('%s is actually translated into Chinese', (key) => {
    const en = translate('en', key)
    const zh = translate('zh', key)

    // 允许相同的情况：品牌名、技术标识符、纯符号占位符本就不该翻译。
    const intentionallyIdentical = new Set([
      'common.brand',
      'popup.webrtcLabel',
      'popup.tun',
      'options.secretPlaceholderSaved',
    ])
    if (intentionallyIdentical.has(key)) return

    expect(zh).not.toBe(en)
  })
})

describe('translate', () => {
  it('interpolates named params', () => {
    expect(translate('en', 'error.coreOffline', { host: '10.0.0.1', port: 9097 })).toContain(
      '10.0.0.1:9097',
    )
  })

  it('interpolates the same params in Chinese', () => {
    expect(translate('zh', 'error.coreOffline', { host: '10.0.0.1', port: 9097 })).toContain(
      '10.0.0.1:9097',
    )
  })

  it('leaves an unknown placeholder visible instead of printing undefined', () => {
    // 原样保留比渲染出 "undefined" 好：前者一眼能看出是文案漏了参数。
    expect(translate('en', 'error.unknown', {})).toContain('{reason}')
  })

  it('accepts numeric params', () => {
    expect(translate('en', 'validation.proxyPort', { min: 1, max: 65535 })).toContain('65535')
  })

  it('falls back to the key instead of throwing on an unknown key', () => {
    // 正常情况不可达（MessageKey 由字典推导），但持久化的旧数据可能带来野 key。
    // 抛错会中断整段渲染并留下半成品界面 —— 已经因此产生过一个
    // 「空告警框」的 bug，所以这里必须是软降级。
    const rogue = 'error.doesNotExist' as never
    expect(() => translate('en', rogue)).not.toThrow()
    expect(translate('en', rogue)).toBe('error.doesNotExist')
  })

  it('falls back safely even when params are supplied', () => {
    // 这才是真正会炸的组合：template 为 undefined 时调用 .replace() 会抛 TypeError。
    const rogue = 'error.doesNotExist' as never
    expect(() => translate('zh', rogue, { reason: 'x' })).not.toThrow()
  })
})

describe('resolveLocale', () => {
  it.each(['zh', 'en'] as const)('passes through an explicit %s', (language) => {
    expect(resolveLocale(language)).toBe(language)
  })

  it('never throws when navigator is unavailable', () => {
    // Service Worker 里 navigator 存在，但 node 测试环境未必有 language。
    // 拿不到语言不能让整个 UI 崩掉。
    expect(() => resolveLocale('auto')).not.toThrow()
    expect(['zh', 'en']).toContain(resolveLocale('auto'))
  })
})

describe('createTranslator', () => {
  it('binds a locale', () => {
    const zh = createTranslator('zh')
    const en = createTranslator('en')
    expect(zh('common.settings')).not.toBe(en('common.settings'))
  })
})

describe('languageLabel', () => {
  it('labels each language in its own script, regardless of UI locale', () => {
    // 语言名用母语标注是通行做法：正在找中文的用户能认出「中文」，
    // 哪怕当前界面还是英文。
    expect(languageLabel('zh', 'en')).toBe('中文')
    expect(languageLabel('en', 'zh')).toBe('English')
  })

  it('translates the auto option', () => {
    expect(languageLabel('auto', 'zh')).not.toBe(languageLabel('auto', 'en'))
  })

  it('offers auto plus both languages', () => {
    expect(LANGUAGE_OPTIONS).toEqual(['auto', 'zh', 'en'])
  })
})

describe('🔴 ADR-28 边界披露的文案内容', () => {
  /*
   * 光有一个 i18n key 不够 —— 内容被改成一句空泛的「可能有影响」也算有 key。
   * 这条测试要求两种语言都真的点明「其他程序 / anything else」，
   * 因为用户要能据此判断自己是否受影响，而含糊的警告只会被无视。
   */
  it('names the actual consequence in both languages', () => {
    expect(translate('en', 'popup.nodeScopeNotice')).toMatch(/anything else using this core/i)
    expect(translate('zh', 'popup.nodeScopeNotice')).toContain('在用这个内核的程序')
  })

  it('contrasts against the browser-only proxy toggle', () => {
    // 关键在于对比：说清「这个操作」与「上面那个开关」的作用域不同，
    // 否则用户无法理解为什么同一个面板里两件事的范围不一样。
    expect(translate('en', 'popup.nodeScopeNotice')).toMatch(/only affects this browser/i)
    expect(translate('zh', 'popup.nodeScopeNotice')).toContain('只影响本浏览器')
  })
})
