/**
 * 请求头规则的描述与对齐。
 *
 * 这个文件测的是**状态收敛**，不是单次调用。规则是持久化的：
 * 写进去的东西在 Service Worker 被回收、浏览器重启之后依然存在。
 * 所以每一条用例问的都是同一个问题 —— 从任意一个起点出发，
 * 重复调用之后浏览器里的状态是不是同一个。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeRules, syncHeaderRules } from '../src/background/netrule'
import { readDynamicRules, seedDynamicRules } from './setup'

/** 读回自己那一组规则的简化形态，便于比较内容而不被字段顺序干扰。 */
function currentRules(): Array<{ id: number; filter: string; value: string }> {
  return readDynamicRules()
    .map((rule) => ({
      id: rule.id,
      filter: rule.condition?.urlFilter ?? '',
      value: rule.action?.requestHeaders?.[0]?.value ?? '',
    }))
    .sort((a, b) => a.id - b.id)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('describeRules', () => {
  it('anchors each domain with the DNR domain boundary', () => {
    /*
     * `||example.com` 匹配该域名与任何子域，但**不**匹配
     * `example.com.evil.tld` —— 锚点要求域名之后是 `/` 或 `:`。
     * 裸写 `example.com` 会连 `notexample.com` 一起匹配。
     */
    expect(describeRules(['chatgpt.com'], 'en-US')).toEqual([
      { id: 9100, urlFilter: '||chatgpt.com^', value: 'en-US,en;q=0.9' },
    ])
  })

  it('assigns a distinct id per domain', () => {
    // 一条规则只能带一个 urlFilter，所以 N 个域名必须是 N 条规则。
    const rules = describeRules(['chatgpt.com', 'openai.com', 'claude.ai'], 'ja-JP')
    expect(rules.map((rule) => rule.id)).toEqual([9100, 9101, 9102])
    expect(rules.map((rule) => rule.urlFilter)).toEqual([
      '||chatgpt.com^',
      '||openai.com^',
      '||claude.ai^',
    ])
  })

  it('normalises case and skips empty entries', () => {
    const rules = describeRules(['  ChatGPT.com ', '', '   '], 'en-US')
    expect(rules).toHaveLength(1)
    expect(rules[0]?.urlFilter).toBe('||chatgpt.com^')
  })

  it('🔴 锚点以分隔符收尾，不误伤同前缀的第三方域名', () => {
    /*
     * `^` 要求后面紧跟分隔符（`/`、`:`、`?`），而 `.` 不是分隔符 ——
     * 所以 `chatgpt.com.evil.tld` 不再命中，`api.chatgpt.com/` 仍然命中。
     *
     * 少了这个 `^`，别人注册的 `chatgpt.com.evil.tld` 也会被我们加上
     * `Accept-Language`。后果不严重，但违背了「只碰你列出的域名」这个承诺，
     * 而且没有任何地方会报错。
     */
    const [rule] = describeRules(['chatgpt.com'], 'en-US')
    expect(rule?.urlFilter).toBe('||chatgpt.com^')
    expect(rule?.urlFilter.endsWith('^')).toBe(true)
  })

  it('produces nothing for an empty list', () => {
    expect(describeRules([], 'en-US')).toEqual([])
  })
})

describe('syncHeaderRules', () => {
  it('writes one modifyHeaders rule per domain', async () => {
    const ok = await syncHeaderRules({ hosts: ['chatgpt.com', 'openai.com'], locale: 'en-US' })

    expect(ok).toBe(true)
    const rules = readDynamicRules()
    expect(rules).toHaveLength(2)
    expect(rules[0]?.action?.type).toBe('modifyHeaders')
    expect(rules[0]?.action?.requestHeaders?.[0]).toMatchObject({
      header: 'accept-language',
      operation: 'set',
      value: 'en-US,en;q=0.9',
    })
  })

  it('🔴 clears every rule when the target is null', async () => {
    /*
     * 这是整个模块存在的理由。关掉功能、关掉代理、清空清单、国家查不到 ——
     * 四种情况都要落到这里。少了这一步，用户关掉功能之后请求头仍在被改，
     * 而且不会自己恢复：规则存在浏览器里，只有代码主动清才会消失。
     */
    await syncHeaderRules({ hosts: ['chatgpt.com'], locale: 'en-US' })
    expect(readDynamicRules()).toHaveLength(1)

    expect(await syncHeaderRules(null)).toBe(true)
    expect(readDynamicRules()).toHaveLength(0)
  })

  it('🔴 removes stale rules when the list shrinks', async () => {
    /*
     * id 是按序号分配的：三条规则是 9100/9101/9102，清单缩到一条时，
     * 新规则只覆盖 9100，而 9101、9102 还留在浏览器里继续改那两个站点的
     * 请求头。这类残留不会报错、不会出现在 UI 上，只会让用户发现
     * "我明明删了那个域名，它还是英文的"。
     */
    await syncHeaderRules({
      hosts: ['chatgpt.com', 'openai.com', 'claude.ai'],
      locale: 'en-US',
    })
    expect(readDynamicRules()).toHaveLength(3)

    await syncHeaderRules({ hosts: ['chatgpt.com'], locale: 'en-US' })

    expect(currentRules()).toEqual([
      { id: 9100, filter: '||chatgpt.com^', value: 'en-US,en;q=0.9' },
    ])
  })

  it('replaces the value when the locale changes', async () => {
    await syncHeaderRules({ hosts: ['chatgpt.com'], locale: 'en-US' })
    await syncHeaderRules({ hosts: ['chatgpt.com'], locale: 'ja-JP' })

    expect(currentRules()).toEqual([
      { id: 9100, filter: '||chatgpt.com^', value: 'ja-JP,ja;q=0.9' },
    ])
  })

  it('is idempotent — repeated calls leave the same rules', async () => {
    // 每次导航都可能走到这里，重复写入会让 DNR 的内部状态反复重建。
    await syncHeaderRules({ hosts: ['chatgpt.com'], locale: 'en-US' })
    const first = currentRules()

    await syncHeaderRules({ hosts: ['chatgpt.com'], locale: 'en-US' })
    await syncHeaderRules({ hosts: ['chatgpt.com'], locale: 'en-US' })

    expect(currentRules()).toEqual(first)
  })

  it('leaves rules outside its own id range alone', async () => {
    /*
     * 别的代码路径（或扩展自己的另一组规则）可能用别的 id 段。
     * 一次清理把整张表扫掉，会让那些功能静默失效 —— 而受影响的
     * 那部分代码不会收到任何通知。
     */
    seedDynamicRules([
      {
        id: 1,
        priority: 1,
        action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
        condition: { urlFilter: '||ads.example' },
      },
    ])

    await syncHeaderRules({ hosts: ['chatgpt.com'], locale: 'en-US' })
    await syncHeaderRules(null)

    expect(readDynamicRules()).toHaveLength(1)
    expect(readDynamicRules()[0]?.id).toBe(1)
  })

  it('🔴 reports failure when the API is unavailable', async () => {
    /*
     * 返回值决定调用方要不要注入语言。返回 true 而实际上没写进去，
     * 会得到一个「页面说英文、请求头说中文」的页面 —— 比两边都不改更糟。
     * 所以这条分支必须如实报 false，让调用方退回纯时区模式。
     */
    vi.stubGlobal('chrome', { ...chrome, declarativeNetRequest: undefined })

    expect(await syncHeaderRules({ hosts: ['chatgpt.com'], locale: 'en-US' })).toBe(false)
    // 但「本来就不该有规则」这个目标，在 API 不可用时是**已经达成**的。
    expect(await syncHeaderRules(null)).toBe(true)
  })
})

describe('并发', () => {
  it('🔴 同时调用两次，最终状态是后一次的目标', async () => {
    /*
     * 这个函数是「读 → 算 → 写」三步。没有串行化时，两个并发调用读到同一份
     * 旧状态，然后各自写回 —— 后写的覆盖先写的，而两次调用都返回 true。
     *
     * 并发是真实存在的：多个标签页几乎同时开始导航时，每个都会触发一次
     * 后台刷新。不是高频，但发生时没有任何痕迹。
     */
    await Promise.all([
      syncHeaderRules({ hosts: ['a.example'], locale: 'en-US' }),
      syncHeaderRules({ hosts: ['a.example', 'b.example'], locale: 'ja-JP' }),
    ])

    expect(currentRules()).toEqual([
      { id: 9100, filter: '||a.example^', value: 'ja-JP,ja;q=0.9' },
      { id: 9101, filter: '||b.example^', value: 'ja-JP,ja;q=0.9' },
    ])
  })
})
