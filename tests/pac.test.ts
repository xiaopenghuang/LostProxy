/**
 * PAC 脚本生成测试（V0.4）。
 *
 * 🔴 本文件守的是整个项目**唯一的代码注入面**。
 *
 * 注入成功的后果不是崩溃，而是生成一个「一切都直连」的脚本 ——
 * 语法完全合法，`mandatory: true` 拦不住，浏览器不报任何错，
 * 而用户以为自己配了分流。这是本项目所有失败模式里最坏的一种：
 * 静默，且恰好发生在用户以为受保护的时候。
 *
 * 因此这里的断言方式与别处不同：不只验「输出对不对」，
 * 而是**把生成的脚本真的执行一遍**，然后断言它的判定结果。
 * 只检查字符串里有没有引号，挡不住此方没预料到的构造方式。
 */

import { describe, expect, it } from 'vitest'
import { buildPacScript, sanitizeRule, sanitizeRules } from '../src/background/pac'

/**
 * 把生成的脚本当成真的 PAC 来跑，返回 FindProxyForURL 的结果。
 *
 * 这是本文件的核心手法：断言「脚本对某个 host 判成什么」而不是
 * 「脚本文本长什么样」。前者才是浏览器实际关心的东西。
 */
function evaluatePac(script: string, host: string): string {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${script}; return FindProxyForURL;`) as () => (
    url: string,
    host: string,
  ) => string
  return factory()(`https://${host}/`, host)
}

const PROXY = 'PROXY 127.0.0.1:7890'

describe('sanitizeRule', () => {
  it.each([
    ['*.edu.cn', '*.edu.cn'],
    ['  *.edu.cn  ', '*.edu.cn'],
    ['EDU.CN', 'edu.cn'],
    ['lib-1.example.edu', 'lib-1.example.edu'],
  ])('accepts %s', (input, expected) => {
    expect(sanitizeRule(input)).toBe(expected)
  })

  /*
   * 🔴 白名单拒绝的每一类字符都各锁一条。
   *
   * 这些不是假想的输入 —— 前三条是标准的 JS 字符串逃逸手法，
   * 第四条是注释闭合，第五条是换行注入。
   */
  it.each([
    ["单引号", "*.edu.cn'; return 'DIRECT"],
    ['双引号', '*.edu.cn"; return "DIRECT'],
    ['分号', 'edu.cn; return'],
    ['注释闭合', 'edu.cn*/'],
    ['换行', 'edu.cn\nreturn "DIRECT"'],
    ['反斜杠', 'edu.cn\\'],
    ['括号', 'edu.cn()'],
    ['反引号', 'edu.cn`'],
    ['花括号', 'edu.cn{}'],
    ['空格分隔的两段', 'edu.cn foo.com'],
    ['冒号端口', 'edu.cn:8080'],
    ['斜杠路径', 'edu.cn/path'],
    ['协议', 'https://edu.cn'],
    ['空串', '   '],
  ])('rejects %s', (_label, input) => {
    expect(sanitizeRule(input)).toBeNull()
  })
})

describe('sanitizeRules', () => {
  it('drops invalid entries but keeps the valid ones', () => {
    // 一条脏规则不该让整份清单失效——用户改一条就要重填全部是不合理的。
    expect(sanitizeRules(['*.edu.cn', "bad'", 'ok.com'])).toEqual(['*.edu.cn', 'ok.com'])
  })

  it('de-duplicates case-insensitively while keeping order', () => {
    expect(sanitizeRules(['A.com', 'b.com', 'a.COM'])).toEqual(['a.com', 'b.com'])
  })
})

describe('🔴 注入防护：执行生成的脚本并断言判定结果', () => {
  it('the canonical injection payload cannot make everything DIRECT', () => {
    /*
     * 这是 ADR-33 里记录的那个样本。若实现改成朴素字符串拼接，
     * 生成的脚本会对**任何** host 返回 DIRECT，这条就会炸。
     */
    const script = buildPacScript('127.0.0.1', 7890, ["*.edu.cn'; return 'DIRECT"])

    expect(evaluatePac(script, 'example.com')).toBe(PROXY)
    expect(evaluatePac(script, 'anything.org')).toBe(PROXY)
  })

  it.each([
    ['string escape', "*.edu.cn'; return 'DIRECT"],
    ['array close + escape', 'x.com"]; return "DIRECT'],
    ['comment close', 'x.com*/; return "DIRECT"; /*'],
    // 尾随反斜杠：朴素拼接时它会吃掉后面的引号，让脚本结构错位。
    ['trailing backslash', 'x.com\\'],
  ])('a payload using %s still proxies unrelated hosts', (_label, payload) => {
    const script = buildPacScript('127.0.0.1', 7890, [payload])
    expect(evaluatePac(script, 'unrelated.example')).toBe(PROXY)
  })

  it('remains syntactically valid with hostile input', () => {
    // 脚本语法错误会触发 mandatory 的失败路径（网页全打不开）。
    // 那比泄漏好，但仍是故障——不该因为用户填了奇怪的东西就发生。
    const script = buildPacScript('127.0.0.1', 7890, [
      "'; while(true){}; '",
      '"+"',
      '${x}',
      // NUL 字符：用转义写法而非字面量，否则整个文件对 git 而言变成二进制
      '\0',
    ])
    expect(() => evaluatePac(script, 'example.com')).not.toThrow()
  })
})

describe('匹配语义', () => {
  const script = buildPacScript('127.0.0.1', 7890, ['*.edu.cn', 'lib.example.org'])

  it.each([
    ['a.edu.cn', 'DIRECT'],
    ['deep.sub.edu.cn', 'DIRECT'],
    // 通配符规则也该覆盖裸域名本身，否则 *.edu.cn 配了却漏掉 edu.cn。
    ['edu.cn', 'DIRECT'],
    ['lib.example.org', 'DIRECT'],
  ])('%s → %s', (host, expected) => {
    expect(evaluatePac(script, host)).toBe(expected)
  })

  it.each([
    // 🔴 最重要的一组反例：后缀匹配不能退化成"包含"。
    ['edu.cn.evil.com', PROXY],
    ['notedu.cn', PROXY],
    ['example.org', PROXY],
    ['other.example.org', PROXY],
    ['example.com', PROXY],
  ])('%s → proxied', (host, expected) => {
    expect(evaluatePac(script, host)).toBe(expected)
  })

  it('🔴 never appends a DIRECT fallback to the proxy result', () => {
    /*
     * security.md §4：返回 "PROXY x; DIRECT" 会让代理连不上时静默直连，
     * 把 fail-closed 语义整个作废。返回值必须是单一的 PROXY。
     */
    expect(evaluatePac(script, 'example.com')).toBe(PROXY)
    expect(evaluatePac(script, 'example.com')).not.toContain('DIRECT')
  })
})

describe('本机地址始终直连', () => {
  const script = buildPacScript('127.0.0.1', 7890, [])

  it.each(['localhost', '127.0.0.1', 'router', 'nas'])('%s → DIRECT', (host) => {
    /*
     * 与 fixed_servers 的 bypassList 保持一致（ADR-02）。
     * 若 127.0.0.1 不直连，Controller 探活的请求会被送进代理形成自环。
     * 'router' / 'nas' 这类无点主机名同理——它们是局域网设备。
     */
    expect(evaluatePac(script, host)).toBe('DIRECT')
  })

  it('an empty rule list still proxies everything else', () => {
    // 空清单不该意外变成"全部直连"。
    expect(evaluatePac(script, 'example.com')).toBe(PROXY)
  })
})

describe('脚本内容的结构性保证', () => {
  it('embeds rules as JSON data, not as concatenated code', () => {
    // 这条是对实现手法的直接约束：规则必须以数组字面量出现。
    const script = buildPacScript('127.0.0.1', 7890, ['*.edu.cn'])
    expect(script).toContain('var DIRECT_SUFFIX = [".edu.cn"]')
  })

  it('carries the configured host and port', () => {
    const script = buildPacScript('10.0.0.5', 1080, [])
    expect(evaluatePac(script, 'example.com')).toBe('PROXY 10.0.0.5:1080')
  })
})
