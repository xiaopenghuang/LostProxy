/**
 * 平台抽象边界测试（architecture.md ADR-36）。
 *
 * ## 这个文件为什么存在
 *
 * `platform/` 这层抽象的全部价值在于一句话：**平台差异只存在于
 * `platform/` 目录里**。这句话成立，加 Firefox 就是加一个文件；
 * 这句话破了一次，就变成了维护两个会慢慢漂移的项目 ——
 * 而漂移的地方恰好是安全语义（fail-closed 顺序、告警不自愈、
 * WebRTC 锁的等价值），也就是最不能悄悄不一致的部分。
 *
 * 问题在于：**破掉它不会让任何现有测试变红。** 在 `proxy.ts` 里直接写一行
 * `chrome.proxy.settings.set(...)` 完全能跑、能过 890 项测试、在 Edge 上
 * 行为也完全正确 —— 只有在 Firefox 上才炸，而开发者手边通常没有 Firefox。
 * 这正是 ADR-20 说的那种约束：只靠注释保护等于没有保护。
 *
 * ## 断言的形式
 *
 * 对**源码文本**做断言，与 `styles.test.ts` 用正则查 CSS 源码是同一手法。
 * 这种测试有明确的局限（它验的是"写着"，不是"跑对了"），所以刻意只用来锁
 * 那些**跑起来看不出差别**的结构约束。行为正确性仍由 `proxy.test.ts` /
 * `privacy.test.ts` 负责。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { platform } from '../src/background/platform'
import { PROXY_BYPASS_LIST } from '../src/background/platform/chromium'
import { LOOPBACK_HOSTS } from '../src/shared/constants'

const SRC = resolve(import.meta.dirname, '..', 'src')

/**
 * 读取源码并**剥掉注释**。
 *
 * 不剥的话这些断言全部会被自己的说明文字绊倒 —— 本项目的注释里
 * 到处都在讨论 `chrome.proxy`，那是解释，不是调用。
 *
 * 用的是最朴素的两条替换而不是正经的 parser：这里只需要区分
 * 「代码里写了」与「注释里提到了」，而项目里不存在含 `//` 的字符串字面量
 * （URL 常量都在 constants.ts，本文件不读它）。真需要更严的判断时
 * 该换的是断言方式，不是补一个半成品 parser。
 */
function readCode(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('🔴 共享层不得直接触碰浏览器 API', () => {
  /*
   * 这是整层抽象的地基。
   *
   * 一旦 proxy.ts 里出现一次 `chrome.` 调用，那行代码在 Firefox 上就是
   * 一个运行期 undefined 或一个语义不同的调用 —— 而 Edge 上一切正常，
   * 所以它能一路通过评审与全部现有测试。
   */
  it.each(['background/proxy.ts', 'background/privacy.ts'])(
    '%s 的代码里没有 chrome.* 调用',
    (file) => {
      expect(readCode(file)).not.toContain('chrome.')
    },
  )

  it('orchestrator 不得绕过 proxy/privacy 直接拿平台实现', () => {
    /*
     * 编排层是全部业务决策的所在地，也是最容易图省事的地方 ——
     * 「就读一下 levelOfControl 而已」这种想法会让平台细节顺着一条
     * import 爬进业务代码。它该问的是 proxy.ts，不是平台。
     */
    const code = readCode('background/orchestrator.ts')
    expect(code).not.toContain('chrome.')
    expect(code).not.toMatch(/from\s+'\.\/platform/)
  })
})

describe('🔴 平台实现的选择只允许发生在一处', () => {
  it('业务代码不得直接 import 某个具体平台', () => {
    /*
     * 只准 import './platform'（走 index.ts 那个唯一出口），
     * 不准 import './platform/chromium'。
     *
     * 直接指名一个平台等于把选择权从 index.ts 偷走一份 ——
     * 将来切 Firefox 时，index.ts 改对了，这条偷来的引用还指着 Chromium，
     * 而它**不会报错**：Firefox 里 `chrome.*` 命名空间是存在的（别名），
     * 只是行为不对。这类 bug 没有任何编译期或运行期信号。
     */
    for (const file of [
      'background/proxy.ts',
      'background/privacy.ts',
      'background/orchestrator.ts',
      'background/index.ts',
      'background/storage.ts',
      'background/mihomo.ts',
      'background/pac.ts',
    ]) {
      expect(readCode(file), file).not.toMatch(/platform\/(chromium|firefox)/)
    }
  })

  it('platform/index.ts 是唯一点名具体平台的模块', () => {
    expect(readCode('background/platform/index.ts')).toContain('chromium')
  })
})

describe('🔴 决策不得漏进平台实现', () => {
  const code = readCode('background/platform/chromium.ts')

  it('平台层不构造 ApplyResult', () => {
    /*
     * 平台方法一律**抛异常**，归一成 NormalizedError 是共享层的事
     * （platform/types.ts 的错误约定）。
     *
     * 理由不是洁癖：归一意味着挑错误码、写文案。若每个平台各归一一次，
     * 两边迟早各写一份文案 —— 而那正是面向用户的安全提示，
     * 「Firefox 上的措辞更弱一点」是绝不能发生的漂移。
     */
    expect(code).not.toContain('ApplyResult')
    expect(code).not.toContain('describeThrown')
  })

  it.each([
    'proxyNotControllable',
    'proxyControlledByOther',
    'privacyNotControllable',
    'privacyControlledByOther',
  ])('「不强行覆盖」的判断不在平台层：%s', (guard) => {
    /*
     * 「被别的扩展控制时拒绝写入」是一条**策略**，与浏览器无关。
     * 它必须只在共享层出现一次；平台层只管写，不管该不该写。
     */
    expect(code).not.toContain(guard)
  })

  it('平台层不得自行探测内核可用性', () => {
    /*
     * ADR-03 fail-closed 的结构保证：写代理这件事不得依赖「内核在不在」。
     * proxy.test.ts 里有一条把全局 fetch 删掉的行为测试守着运行期，
     * 这里守的是源码 —— 两者防的是不同方向（一个防"偷偷探活"，
     * 一个防"import 了 mihomo 但还没调用"）。
     */
    expect(code).not.toContain('mihomo')
    expect(code).not.toMatch(/\bfetch\s*\(/)
  })
})

describe('🔴 平台特有的值不得回流到 shared/', () => {
  const code = readCode('shared/constants.ts')

  it.each([
    ['WEBRTC_LOCKED_POLICY', 'Firefox 里同名值语义更弱（Bugzilla 1452713），等价物是 proxy_only'],
    ['SETTING_SCOPE', 'Firefox 的 BrowserSetting.set() 没有 scope 参数'],
    ['PROXY_SCHEME', 'Firefox 用 proxyType/http 字段，没有 scheme 这个概念'],
    ['PROXY_BYPASS_LIST', 'Firefox 的 passthrough 是逗号串且不认 <local> 令牌'],
  ])('%s 不在 shared/constants 里（%s）', (name) => {
    /*
     * 这四个曾经都在 shared/constants.ts。它们看起来像"通用配置"，
     * 但每一个的值都是 Chromium 特有的 —— 而其中 WEBRTC_LOCKED_POLICY
     * 是最坏的一种：抄到 Firefox 会被**接受**、不报错、防护变弱。
     *
     * 放在 shared/ 的东西会被当成跨平台契约来读，
     * 而"以为是共享的平台特有值"正是抄错的起点。
     */
    expect(code).not.toContain(`export const ${name}`)
  })

  it('LOOPBACK_HOSTS 只含跨平台事实，不含 Chromium 的 <local> 令牌', () => {
    /*
     * `<local>` 是 Chromium bypassList 的语法令牌，由 platform/chromium.ts
     * 拼在前面。若有人把它塞进 LOOPBACK_HOSTS：
     *   - bypassList 会重复一项（无害）
     *   - **PAC 脚本的 LOCAL 数组里会多一个永远匹配不上的字符串**
     * 后者是静默的死代码，读起来还像"已经处理了本机地址"。
     */
    expect(LOOPBACK_HOSTS).not.toContain('<local>')
    expect(LOOPBACK_HOSTS).toContain('127.0.0.1')
    expect(LOOPBACK_HOSTS).toContain('[::1]')

    // 拼装的结果仍须是 ADR-02 要求的完整四项。
    expect(PROXY_BYPASS_LIST).toEqual(['<local>', ...LOOPBACK_HOSTS])
    expect(PROXY_BYPASS_LIST).toHaveLength(4)
  })
})

describe('platform 契约的运行期完整性', () => {
  /*
   * 接口完整性主要靠 `const chromium: BrowserPlatform = {...}` 的编译期检查。
   * 这里再做一次运行期核对，防的是「注解和方法被一起删掉」这种情形 ——
   * 那种改动编译得过，而症状是运行时 `platform.applyProxy is not a function`。
   */
  it.each([
    'readProxyState',
    'applyProxy',
    'releaseProxy',
    'onProxyError',
    'readWebRtcState',
    'lockWebRtcPolicy',
    'unlockWebRtcPolicy',
  ])('platform.%s 是一个函数', (method) => {
    expect(typeof platform[method as keyof typeof platform]).toBe('function')
  })

  it('platform 报出自己的身份', () => {
    expect(platform.id).toBe('chromium')
  })
})
