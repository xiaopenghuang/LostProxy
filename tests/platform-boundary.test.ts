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

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { platform } from '../src/background/platform'
import { PROXY_BYPASS_LIST } from '../src/background/platform/chromium'
import { PROXY_PASSTHROUGH } from '../src/background/platform/firefox'
import { LOOPBACK_HOSTS } from '../src/shared/constants'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = resolve(ROOT, 'src')

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

  it('platform/index.ts 点名了全部已知平台', () => {
    /*
     * 断言"两个都提到了"而不只是"提到了 chromium"：
     * 漏接一个平台的表现是那个平台**静默回落到另一个实现**，
     * 而 chrome.* 命名空间在 Firefox 里是存在的（别名），
     * 所以不会有任何报错 —— 只是行为全错。
     */
    const code = readCode('background/platform/index.ts')
    expect(code).toContain('chromium')
    expect(code).toContain('firefox')
  })
})

describe('🔴 决策不得漏进平台实现', () => {
  /*
   * 两个平台实现都要过同一组检查。用 describe.each 而不是只查 chromium：
   * 「决策别漏进平台层」这条规矩对新加的平台同样成立，
   * 而新平台恰恰是最可能图省事把判断抄进去的地方。
   */
  describe.each(['chromium', 'firefox'] as const)('%s', (name) => {
    const code = readCode(`background/platform/${name}.ts`)

    it('不构造 ApplyResult', () => {
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

    it('不得自行探测内核可用性', () => {
      /*
       * ADR-03 fail-closed 的结构保证：写代理这件事不得依赖「内核在不在」。
       * 两份平台测试里各有一条把全局 fetch 删掉的行为测试守着运行期，
       * 这里守的是源码 —— 两者防的是不同方向（一个防"偷偷探活"，
       * 一个防"import 了 mihomo 但还没调用"）。
       */
      expect(code).not.toContain('mihomo')
      expect(code).not.toMatch(/\bfetch\s*\(/)
    })

    it('不自行决定 blocker 该报成哪条错误', () => {
      /*
       * `preflight` 返回的是一个 PlatformBlocker（"是哪种情况"），
       * 映射成 NormalizedError 由 proxy.ts 的 BLOCKER_TO_ERROR 完成。
       *
       * 若平台层直接构造那两条错误，映射表就形同虚设 ——
       * 而那张表的价值在于它是 `Record<PlatformBlocker, ...>`：
       * 新增一种 blocker 会编译失败，逼着新情况被表态。
       * 绕过它就等于放弃这个保证。
       */
      expect(code).not.toContain('privateBrowsingAccessRequired:')
      expect(code).not.toContain('errors.privateBrowsingAccessRequired')
      expect(code).not.toContain('errors.ruleBasedRoutingUnsupported')
    })
  })
})

describe('🔴 两个平台必须用同一个「需要分流吗」的判据', () => {
  it.each(['chromium', 'firefox'] as const)('%s 调用 needsRuleBasedRouting', (name) => {
    /*
     * 🔴 这是此方在实现 Firefox 时发现的一个陷阱。
     *
     * 「这份配置需不需要规则分流」有两个消费者：
     *   - chromium 的 buildProxyConfig（决定生成 PAC 还是 fixed_servers）
     *   - firefox 的 preflight（决定拒绝开启还是放行）
     *
     * 若两处各写一遍 `routingMode === 'smart' && rules.length > 0`，
     * 就存在一种恶性的不一致：一方认为"需要分流"而另一方认为"不需要"。
     * 落到 Firefox 上的表现是**静默按全局代理写入** ——
     * 用户配的直连清单被无声忽略，他本该直连的校内站点全都走了代理，
     * 而 UI 显示一切正常。
     *
     * 所以判据必须是同一个函数。这条断言锁的是"都在调它"，
     * 而 platform-firefox.test.ts 里那条「空规则不该被拦」锁的是行为一致。
     */
    const code = readCode(`background/platform/${name}.ts`)
    expect(code).toContain('needsRuleBasedRouting')
    // 不许在平台层重新拼一遍那个条件。
    expect(code).not.toMatch(/routingMode\s*===\s*'smart'/)
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

  it('LOOPBACK_HOSTS 只含跨平台事实，不含语法令牌', () => {
    /*
     * `<local>` 是 bypass 清单的**语法令牌**（两个平台都认它，
     * 语义都是"不含点的主机名"），由各自的平台文件拼在前面。
     *
     * 若有人把它塞进 LOOPBACK_HOSTS：
     *   - bypass 清单会重复一项（无害）
     *   - **PAC 脚本的 LOCAL 数组里会多一个永远匹配不上的字符串**
     * 后者是静默的死代码，读起来还像"已经处理了本机地址"。
     */
    expect(LOOPBACK_HOSTS).not.toContain('<local>')
    expect(LOOPBACK_HOSTS).toContain('127.0.0.1')
    expect(LOOPBACK_HOSTS).toContain('[::1]')
  })

  it('🔴 两个平台的 bypass 清单覆盖同一组地址，只是格式不同', () => {
    /*
     * ADR-02 的内容在两个平台上必须一致 —— 少绕过任何一项都会导致
     * 扩展访问 Controller 的请求被送进代理形成自环。
     * 不一致的表现是"只在某一个浏览器上诡异地卡住"。
     *
     * 格式差异是真实的（Chromium 要数组，Firefox 要逗号串），
     * 所以这条断言比较的是**内容**：拆开之后必须是同一组。
     */
    expect(PROXY_BYPASS_LIST).toEqual(['<local>', ...LOOPBACK_HOSTS])
    expect(PROXY_BYPASS_LIST).toHaveLength(4)

    expect(PROXY_PASSTHROUGH.split(',')).toEqual([...PROXY_BYPASS_LIST])
  })
})

describe('🔴🔴 构建产物里不得混入另一个平台的代码', () => {
  /*
   * ## 为什么这组断言值得存在
   *
   * 这是构建期选择（而非运行期嗅探）唯一买得到的保证，也是本项目
   * 最危险的一处跨平台差异的最后一道防线：
   *
   *   Firefox 上 `disable_non_proxied_udp` 会被**接受**、**不报错**，
   *   但防护比 `proxy_only` 弱（Bugzilla 1452713）。
   *
   * 若 `platform/index.ts` 的三元没有被 dead-code-eliminate 掉，
   * 两个实现都会进产物。那本身不会立刻出错 —— 只有一个会被执行 ——
   * 但它意味着 define 没生效，而 define 没生效时 `__LOSTPROXY_PLATFORM__`
   * 是 undefined，三元会走 else 分支，**Firefox 产物里跑的是 Chromium 实现**。
   *
   * 那种情况下 Firefox 上会发生什么：`chrome.proxy.settings.set()` 带着
   * `mode: 'fixed_servers'` 和一个 `scope` 参数被调用。Firefox 认识
   * `chrome.proxy.settings`，于是不会抛"API 不存在"，而是收下一个
   * 它不认识的值对象 —— 按 MDN 的规则，**所有省略的属性重置为默认值**，
   * 也就是 proxyType 回到 'system'。结果是代理压根没开，而扩展显示已开启。
   *
   * ## 为什么用 skip 而不是让它失败
   *
   * 产物需要先 `npm run build`。在没构建过的干净 checkout 上让这组测试红，
   * 会训练人无视红色 —— 那比少一组断言更糟。
   * `npm run verify` 里 build 在 test 之后，所以本地跑 verify 时这组会 skip；
   * CI 里 build 也在测试之后，同理。它真正生效的时机是**改完代码重跑测试**，
   * 那时 dist/ 里是上一次的产物 —— 而这恰好是最需要它的时机：
   * 有人动了 vite 配置或 platform/index.ts 之后。
   */
  const chromiumBundle = resolve(ROOT, 'dist', 'background.js')
  const firefoxBundle = resolve(ROOT, 'dist-firefox', 'background.js')
  const built = existsSync(chromiumBundle) && existsSync(firefoxBundle)

  const read = (path: string): string => readFileSync(path, 'utf8')

  it.skipIf(!built)('🔴🔴 Chromium 产物里没有 proxy_only', () => {
    expect(read(chromiumBundle)).not.toContain('proxy_only')
  })

  it.skipIf(!built)('🔴🔴 Firefox 产物里没有 disable_non_proxied_udp', () => {
    /*
     * 这一条是整组里最重要的。它同时排除两种失败：
     *   - define 没生效（两个实现都在，Chromium 的值也在）
     *   - 有人在 firefox.ts 里"顺手"加了那个值当兼容
     */
    expect(read(firefoxBundle)).not.toContain('disable_non_proxied_udp')
  })

  it.skipIf(!built)('Chromium 产物里没有 Firefox 特有的 API 与字段', () => {
    const code = read(chromiumBundle)
    expect(code).not.toContain('isAllowedIncognitoAccess')
    expect(code).not.toContain('httpProxyAll')
    expect(code).not.toContain('passthrough')
  })

  it.skipIf(!built)('Firefox 产物里没有 Chromium 特有的配置形态', () => {
    const code = read(firefoxBundle)
    expect(code).not.toContain('fixed_servers')
    expect(code).not.toContain('singleProxy')
    // 内联 PAC 在 Firefox 上根本没有对应物，生成器整个不该进包。
    expect(code).not.toContain('FindProxyForURL')
  })

  it.skipIf(!built)('两个产物都仍是零 import 的单文件（MV3 约束）', () => {
    /*
     * Chromium 那边这是硬约束：出现 import 会让 service worker 注册失败，
     * 整个扩展装不上。Firefox 用事件页，对单文件没有硬要求 ——
     * 但这里一并断言，因为两边共用同一份 vite 配置工厂，
     * 若哪天有人给 Firefox 那趟开了 code splitting，
     * Chromium 那趟很可能被一起改坏。
     */
    for (const path of [chromiumBundle, firefoxBundle]) {
      expect(read(path), path).not.toMatch(/^import[\s{'"]/m)
    }
  })

  it.skipIf(!built)('两个产物的 manifest 装载方式各自正确', () => {
    /*
     * Firefox 不支持扩展 service worker（Firefox bug 1573659），
     * 必须用 background.scripts。写错的症状是"装上去毫无反应"——
     * 而 Firefox 对着一个只有 service_worker 的 MV3 manifest
     * 不会给出明显的错误提示。
     */
    const chromiumManifest = JSON.parse(read(resolve(ROOT, 'dist', 'manifest.json')))
    const firefoxManifest = JSON.parse(read(resolve(ROOT, 'dist-firefox', 'manifest.json')))

    expect(chromiumManifest.background.service_worker).toBe('background.js')
    expect(chromiumManifest.background.scripts).toBeUndefined()

    expect(firefoxManifest.background.scripts).toEqual(['background.js'])
    expect(firefoxManifest.background.service_worker).toBeUndefined()

    // Firefox 的 MV3 签名要求扩展 ID，缺了就无法上传 AMO 也无法自分发。
    expect(firefoxManifest.browser_specific_settings?.gecko?.id).toBeTruthy()
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
