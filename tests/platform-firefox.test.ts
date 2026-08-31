/**
 * Firefox 平台实现的单元测试。
 *
 * ## 这份文件是 platform-chromium.test.ts 的对照本
 *
 * 那 32 条断言里的每一条都提出了一个问题（Firefox 那边这个值是什么？
 * 这个字段叫什么？这个信号存在吗？），本文件逐一回答。
 * 三条最重要的，各自对应一个「抄过去也能跑但是错的」陷阱：
 *
 *   1. `httpProxyAll: true` 不能省 —— 省了 HTTPS 会直连（省略字段会被
 *      重置为默认值，而它默认 false）
 *   2. WebRTC 锁是 `proxy_only` 而不是 `disable_non_proxied_udp` ——
 *      后者在 Firefox 70+ 上是更弱的策略（Bugzilla 1452713）
 *   3. `set()` 不接受 `scope` —— 照抄 Chromium 的调用形状是错的
 *
 * ## 为什么直接 import firefox 而不经由 platform 出口
 *
 * `platform/index.ts` 的选择由构建期常量决定，而测试跑在 chromium 目标下
 * （见 vitest.config.ts）。切换那个常量会让测试之间产生顺序依赖 ——
 * 一个测试改了全局状态，另一个测试的结果就取决于谁先跑。
 * 直接 import 具体实现没有这个问题，且更诚实：本文件测的就是
 * "Firefox 那个实现"，不是"当前平台"。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildProxyConfig,
  firefox,
  normalizeProxyError,
  PROXY_PASSTHROUGH,
  WEBRTC_LOCKED_POLICY,
} from '../src/background/platform/firefox'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { Settings } from '../src/shared/types'
import {
  emitFirefoxProxyError,
  ffErrorListenerCount,
  ffIncognito,
  ffOnErrorPresent,
  ffProxySetting,
  ffWebRtcSetting,
  installFirefoxMock,
  removeIncognitoApi,
} from './firefox-mock'

const settings: Settings = { ...DEFAULT_SETTINGS, proxyHost: '127.0.0.1', proxyPort: 7890 }

beforeEach(() => {
  installFirefoxMock()
})

// ===========================================================================
// 配置形态
// ===========================================================================

describe('buildProxyConfig', () => {
  it('uses manual proxyType', () => {
    expect(buildProxyConfig(settings).proxyType).toBe('manual')
  })

  it('🔴🔴 always sets httpProxyAll: true', () => {
    /*
     * 这是本文件最重要的一条。
     *
     * MDN 原话：「When setting this object, all properties are optional.
     *   **Any omitted properties are reset to their default value.**」
     * 而 `httpProxyAll` 的默认值是 **false**。
     *
     * 所以只写 `{proxyType:'manual', http:'127.0.0.1:7890'}` 的后果是：
     * HTTP 请求走代理，HTTPS 请求去找 `ssl` 字段 —— 而它是空的 ——
     * 于是 **HTTPS 直连**。今天的网页几乎全是 HTTPS，
     * 也就是说漏掉这一个布尔值等于整个代理基本没生效，
     * 而扩展会显示"已开启"。
     *
     * 这和 ADR-01 拒绝 proxyForHttp/proxyForHttps 是同一个问题
     * （按协议拆分总会留直连口子），区别在于 Chromium 上那是你得主动
     * 选择的错误写法，Firefox 上**它是默认**。
     */
    expect(buildProxyConfig(settings).httpProxyAll).toBe(true)
  })

  it('points http at the configured host and port', () => {
    expect(buildProxyConfig(settings).http).toBe('127.0.0.1:7890')
  })

  it('honours a user-changed port instead of hardcoding 7890', () => {
    // 技术方案 §22 Case 4：端口必须可改。
    expect(buildProxyConfig({ ...settings, proxyPort: 1080 }).http).toBe('127.0.0.1:1080')
  })

  it('🔴 never sets a separate ssl proxy', () => {
    /*
     * 设了 `ssl` 就意味着"HTTP 与 HTTPS 走两个不同的代理"，
     * 而我们要的是"全都走同一个"。`httpProxyAll: true` 已经表达了后者；
     * 再设 ssl 是多一处可能不一致的配置。
     *
     * 更重要的是：如果有人把 httpProxyAll 删掉、改用设置 ssl 来"修"
     * HTTPS 直连的问题，那就只覆盖了 HTTP 与 HTTPS 两种协议，
     * 其余（WebSocket 之外的协议、FTP）又回到直连 ——
     * 正是 ADR-01 那个口子。这条断言让那种"修法"变红。
     */
    expect(buildProxyConfig(settings).ssl).toBeUndefined()
    expect(buildProxyConfig(settings).socks).toBeUndefined()
  })

  it('bypasses loopback in all four forms, comma-separated', () => {
    /*
     * ADR-02 的 Firefox 版：格式是**逗号分隔字符串**而不是数组。
     * `<local>` 两边都认（MDN 明确列出它）。
     *
     * 三个回环地址仍显式写上，尽管 MDN 说它们"never proxied"——
     * 依赖隐式保证没有好处，而漏掉的后果是扩展访问 Controller 的请求
     * 被送进代理形成自环。
     */
    const passthrough = buildProxyConfig(settings).passthrough ?? ''
    const parts = passthrough.split(',')

    expect(parts).toContain('<local>')
    expect(parts).toContain('localhost')
    expect(parts).toContain('127.0.0.1')
    expect(parts).toContain('[::1]')
  })

  it('passthrough is a string, not an array', () => {
    // 类型层面 tsc 已经管了，但这条断言的价值在于说明差异存在 ——
    // 有人照抄 Chromium 的 `[...PROXY_BYPASS_LIST]` 时会立刻变红。
    expect(typeof PROXY_PASSTHROUGH).toBe('string')
    expect(PROXY_PASSTHROUGH).toContain(',')
  })

  it('🔴 never sets autoConfigUrl', () => {
    /*
     * Firefox 只支持 autoConfigUrl（不支持内联 PAC），所以"用它来做分流"
     * 是个自然的念头。但那需要把脚本放到某个 URL 上，从而引入
     * "取不到脚本 → PAC fail-open → **静默直连**"这个失败模式 ——
     * 而消除它正是 ADR-33 当初选择内联 data 的理由。
     *
     * 在一个以"不静默泄漏"为卖点的工具里，把刚堵上的洞重新挖开
     * 换一个功能，方向是反的。分流在 Firefox 上应当用 proxy.onRequest 实现。
     */
    expect(buildProxyConfig(settings).autoConfigUrl).toBeUndefined()
  })
})

// ===========================================================================
// 前置条件
// ===========================================================================

describe('preflight · 隐私窗口访问权（授权）', () => {
  it('passes when the user has granted private browsing access', async () => {
    ffIncognito.allowed = true
    expect(await firefox.preflight()).toBeNull()
  })

  it('🔴 reports a blocker when access has not been granted', async () => {
    /*
     * MDN：「If your extension doesn't have private window permission,
     *   calls to proxy.settings.set() throw an exception.」
     *
     * 提前探测而不是等 set() 抛，是因为 set() 抛出的是一句面向开发者的
     * 英文，塞进 UI 对用户毫无指导意义 —— 而这**恰恰是用户两步就能
     * 自己修好**的问题（about:addons → 勾一个框）。
     */
    ffIncognito.allowed = false
    expect(await firefox.preflight()).toBe('privateBrowsingAccessRequired')
  })

  it('🔴 does not block when the probe itself fails', async () => {
    /*
     * 探测失败 ≠ 写不进去。这与 inspectProxy 把查询失败降级成 'unknown'
     * 是同一个决策方向（ADR-03）：放弃写入的代价是泄漏风险，
     * 所以先尝试保护，让 set() 自己去抛 —— 那条路径有正常的错误处理。
     */
    ffIncognito.failNext = new Error('probe exploded')
    expect(await firefox.preflight()).toBeNull()
  })

  it('does not block when the API does not exist at all', async () => {
    // 同上：API 缺失是我们对环境的认知不足，不是"已知写不进去"。
    removeIncognitoApi()
    expect(await firefox.preflight()).toBeNull()
  })

  it('🔴 does not depend on the settings at all', async () => {
    /*
     * `preflight` 现在**不收参数**，这是刻意的。
     *
     * 此方最初把「能不能做分流」和「有没有授权」塞进同一个
     * `preflight(settings)`，那导致两个方向的 bug：
     *   - 保存设置时若调它，没授权的用户**连端口都改不了**
     *     —— 而改端口跟隐私窗口权限毫无关系；
     *   - 只在开启时查能力，用户就能存下一个让开关点不动的设置。
     *
     * 签名上没有 settings 参数，就没法再把两件事混起来。
     */
    expect(firefox.preflight.length).toBe(0)
  })
})

describe('🔴 supports · 规则分流不被支持（能力）', () => {
  const smart = (rules: readonly string[]): Settings => ({
    ...settings,
    routingMode: 'smart',
    directRules: rules,
  })

  it('🔴 refuses smart routing with usable rules', () => {
    /*
     * 这是本文件第二重要的一条。
     *
     * 必须**拒绝**而不是静默退回全局代理。退回全局在网络上"能用"，
     * 但会让用户配的直连清单被无声忽略 —— 他本该直连的校内站点
     * 全部走了代理，而 UI 显示一切正常。
     *
     * 这不是"没保护"，是"保护成了另一种样子"，且用户看不出来 ——
     * 正是本项目所有失败模式里最坏的那一类。
     */
    expect(firefox.supports(smart(['*.edu.cn']))).toBe('ruleBasedRoutingUnsupported')
  })

  it('allows global mode', () => {
    expect(firefox.supports({ ...settings, routingMode: 'global' })).toBeNull()
  })

  it('allows direct mode', () => {
    expect(firefox.supports({ ...settings, routingMode: 'direct' })).toBeNull()
  })

  it('allows smart mode when there are no usable rules', () => {
    /*
     * 与 Chromium 的 buildProxyConfig 保持同一个判据（needsRuleBasedRouting）：
     * 空清单或全是非法规则时，行为等价于全局，此时没有任何东西会被丢掉，
     * 所以不该拦。
     *
     * 🔴 这条断言锁的是「两个平台用同一个谓词」。若哪天有人在这里
     *   改写成 `routingMode === 'smart'` 就拦，Firefox 用户开着一个
     *   空规则清单就再也开不了代理了 —— 而 Chromium 用户完全正常。
     */
    expect(firefox.supports(smart([]))).toBeNull()
    expect(firefox.supports(smart(["bad'", 'also:bad']))).toBeNull()
  })

  it('🔴 is synchronous and does not touch the incognito API', () => {
    /*
     * 能力判断是纯函数，不该有 IO。做成 async 会诱使将来有人在这里
     * 发请求，而「保存设置」这条路径上多一次网络等待是没道理的。
     *
     * 顺带断言它**没有**去查授权：两者拆开的意义就在这里。
     */
    ffIncognito.calls = 0

    const result = firefox.supports(smart(['*.edu.cn']))

    expect(result).toBe('ruleBasedRoutingUnsupported')
    // 同步返回，不是 Promise。
    expect(result).not.toBeInstanceOf(Promise)
    expect(ffIncognito.calls).toBe(0)
  })
})

// ===========================================================================
// 写入与释放
// ===========================================================================

describe('applyProxy', () => {
  it('writes the manual config', async () => {
    await firefox.applyProxy(settings)

    expect(ffProxySetting.setCalls).toHaveLength(1)
    expect(ffProxySetting.setCalls[0]?.value).toEqual({
      proxyType: 'manual',
      http: '127.0.0.1:7890',
      httpProxyAll: true,
      passthrough: PROXY_PASSTHROUGH,
    })
  })

  it('🔴 does not pass a scope parameter', async () => {
    /*
     * Firefox 的 BrowserSetting.set() **没有** scope。
     *
     * 传了不会报错（多余的键被忽略），所以这个错误完全静默 ——
     * 而它是照抄 Chromium 调用形状的直接证据。若有人把
     * chromium.ts 的 applyProxy 复制过来改几个字，这条会变红。
     *
     * 顺带说明一件相关的事：Chromium 上靠 `scope: 'regular'` 换来的
     * 「InPrivate 窗口也走代理、不泄漏」（ADR-07），在 Firefox 上是
     * **默认行为** —— 代理设置天然同时作用于两种窗口，
     * 这也正是它要求隐私窗口访问权的原因。
     */
    await firefox.applyProxy(settings)

    expect(ffProxySetting.setCalls[0]?.scope).toBeUndefined()
    expect(ffProxySetting.setCalls[0]?.extraKeys).toEqual([])
  })

  it('🔴 does not probe whether the core is reachable', async () => {
    // ADR-03 fail-closed：内核没起来也照样写。写了的后果是网页打不开
    // （可见故障），不写的后果是用户以为在走代理而实际直连（不可见泄漏）。
    const originalFetch = globalThis.fetch
    Reflect.deleteProperty(globalThis, 'fetch')

    try {
      await firefox.applyProxy(settings)
      expect(ffProxySetting.setCalls).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('lets a write failure propagate', async () => {
    // 平台方法一律抛，归一成 NormalizedError 是共享层的事
    // （platform/types.ts 的错误约定）。
    ffProxySetting.failNextSet = new Error('set rejected')

    await expect(firefox.applyProxy(settings)).rejects.toThrow('set rejected')
  })
})

describe('releaseProxy', () => {
  it('🔴 clears instead of writing proxyType: none', async () => {
    /*
     * ADR-18：写 `{proxyType:'none'}` 会让本扩展继续持有控制权并强制直连，
     * 越权覆盖用户可能设置的系统代理。clear() 让设置回落到 Firefox 自己的
     * `proxyType: 'system'` 默认值。
     *
     * 「关闭 LostProxy」的正确语义是「LostProxy 不再干预」。
     */
    await firefox.applyProxy(settings)
    ffProxySetting.setCalls = []

    await firefox.releaseProxy()

    expect(ffProxySetting.clearCalls).toHaveLength(1)
    expect(ffProxySetting.setCalls).toHaveLength(0)
  })

  it('does not pass a scope parameter', async () => {
    await firefox.releaseProxy()
    expect(ffProxySetting.clearCalls[0]?.extraKeys).toEqual([])
  })
})

// ===========================================================================
// 状态比对
// ===========================================================================

describe('readProxyState', () => {
  it('recognises our own configuration', async () => {
    await firefox.applyProxy(settings)
    const inspection = await firefox.readProxyState(settings)

    expect(inspection.matchesExpected).toBe(true)
    // Firefox 用 proxyType 表达"当前是什么模式"，与 Chromium 的 mode 同位。
    expect(inspection.mode).toBe('manual')
  })

  it('reports no match on a clean browser', async () => {
    const inspection = await firefox.readProxyState(settings)
    expect(inspection.matchesExpected).toBe(false)
  })

  it('reports a mismatch when the port differs', async () => {
    await firefox.applyProxy(settings)
    expect((await firefox.readProxyState({ ...settings, proxyPort: 1080 })).matchesExpected).toBe(
      false,
    )
  })

  it('reports a mismatch when the browser is on system proxy', async () => {
    ffProxySetting.value = { proxyType: 'system' }
    const inspection = await firefox.readProxyState(settings)

    expect(inspection.matchesExpected).toBe(false)
    expect(inspection.mode).toBe('system')
  })

  it('🔴 reports a mismatch when httpProxyAll got turned off', async () => {
    /*
     * 这是 Chromium 那个「假 ON」bug 的 Firefox 等价物。
     *
     * 若某个东西把 httpProxyAll 改成 false（或我们的写入只成功了一半），
     * 浏览器处于「HTTP 走代理、HTTPS 直连」的状态 —— 而 `http` 字段
     * 看起来完全正确。只比地址就会报"状态一致"，
     * UI 显示绿灯，而今天几乎所有流量都是 HTTPS，也就是几乎全在直连。
     *
     * 这就是为什么 configMatches 必须一并核对这个布尔值。
     */
    ffProxySetting.value = {
      proxyType: 'manual',
      http: '127.0.0.1:7890',
      httpProxyAll: false,
      passthrough: PROXY_PASSTHROUGH,
    }

    expect((await firefox.readProxyState(settings)).matchesExpected).toBe(false)
  })

  it('lets a query failure propagate', async () => {
    // 降级成 'unknown' 是共享层的决策（proxy.ts 的 inspectProxy），不在平台层。
    ffProxySetting.failNextGet = new Error('boom')
    await expect(firefox.readProxyState(settings)).rejects.toThrow('boom')
  })
})

// ===========================================================================
// 运行时错误
// ===========================================================================

describe('normalizeProxyError', () => {
  it('🔴 does not claim a leak, because Firefox cannot tell', () => {
    /*
     * Firefox 的 proxy.onError 传的是一个普通 Error，**没有 fatal 字段**，
     * 所以无法区分「请求被拦住了」与「已经直连出去了」。
     *
     * 此方在这里犹豫过，因为直觉是"信息不足时报更严重的那个"。
     * 但那个直觉在这里是错的，理由具体：PROXY_LEAK_SUSPECTED 的设计是
     * **绝不自动消失、必须由用户显式确认**（ADR-22），因为它记录的是
     * 一个已经发生的事实。用它表达一个我们并不知道有没有发生的泄漏，
     * 会训练用户去点掉这类告警 —— 而一旦养成这个习惯，
     * 真正的泄漏告警也会被顺手点掉。那比报得轻要糟得多。
     */
    expect(normalizeProxyError(new Error('pac failed')).code).toBe('PROXY_RUNTIME_ERROR')
    expect(normalizeProxyError(new Error('pac failed')).code).not.toBe('PROXY_LEAK_SUSPECTED')
  })

  it('survives a non-Error payload', () => {
    // 事件的实参形状只有 MDN 一句话作依据（"An Error object"）。
    // 传什么都不该炸 —— 这是个诊断用的监听，不值得让它拖垮扩展。
    expect(normalizeProxyError(undefined).code).toBe('PROXY_RUNTIME_ERROR')
    expect(normalizeProxyError('a string').code).toBe('PROXY_RUNTIME_ERROR')
  })

  it('stamps a timestamp', () => {
    const before = Date.now()
    expect(normalizeProxyError(new Error('x')).at).toBeGreaterThanOrEqual(before)
  })
})

describe('onProxyError', () => {
  it('registers on onError, not onProxyError', () => {
    // 连事件名都不同 —— 这也是为什么归一必须留在平台层。
    firefox.onProxyError(() => {})
    expect(ffErrorListenerCount()).toBe(1)
  })

  it('forwards a normalized error', () => {
    const received: string[] = []
    firefox.onProxyError((error) => {
      received.push(error.code)
    })

    emitFirefoxProxyError(new Error('pac eval failed'))

    expect(received).toEqual(['PROXY_RUNTIME_ERROR'])
  })

  it('🔴 does not throw when proxy.onError is unavailable', () => {
    /*
     * `proxy.onError` 需要 `proxy` 权限；manifest 写错时它是 undefined。
     * 直接调用会在事件页**顶层**抛错 —— 那会让整个扩展起不来，
     * 包括本来还能正常工作的代理开关。
     *
     * 一个诊断用的监听不值得这个代价，所以用可选链。
     */
    ffOnErrorPresent.value = false

    expect(() => firefox.onProxyError(() => {})).not.toThrow()
    expect(ffErrorListenerCount()).toBe(0)
  })
})

// ===========================================================================
// WebRTC 策略
// ===========================================================================

describe('🔴🔴 Firefox 的 WebRTC 锁值', () => {
  it('🔴🔴 is proxy_only, NOT disable_non_proxied_udp', () => {
    /*
     * 这是整个跨平台移植里最危险的一格，也是平台抽象层（ADR-36）
     * 存在的直接理由。
     *
     * 自 Firefox 70 起（Bugzilla 1452713），`disable_non_proxied_udp`
     * 的语义退化成「有代理时强制走代理，**没有代理时回落 mode 3**」。
     * 把 Chromium 的值原样抄过来会：
     *   - 被接受
     *   - 不报错
     *   - 防护更弱
     *
     * 没有任何编译期或运行期信号。它只会在某个真实用户的某次
     * WebRTC 通话里泄漏一次真实 IP。
     *
     * MDN 把可选值按"从最不私密到最私密"排列，proxy_only 是最后一个，
     * 说明是「only connections using TURN on a TCP connection through
     * a proxy are allowed」—— 这才等价于 Chromium 上的 Mode 4「Force proxy」。
     */
    expect(WEBRTC_LOCKED_POLICY).toBe('proxy_only')
    expect(WEBRTC_LOCKED_POLICY).not.toBe('disable_non_proxied_udp')
  })

  it('writes proxy_only when locking', async () => {
    await firefox.lockWebRtcPolicy()

    expect(ffWebRtcSetting.setCalls).toHaveLength(1)
    expect(ffWebRtcSetting.setCalls[0]?.value).toBe('proxy_only')
  })

  it('does not pass a scope parameter', async () => {
    await firefox.lockWebRtcPolicy()
    expect(ffWebRtcSetting.setCalls[0]?.extraKeys).toEqual([])
  })

  it('recognises proxy_only as locked', async () => {
    await firefox.lockWebRtcPolicy()
    const inspection = await firefox.readWebRtcState()

    expect(inspection.locked).toBe(true)
    expect(inspection.policy).toBe('proxy_only')
  })

  it('🔴🔴 does not treat disable_non_proxied_udp as locked', async () => {
    /*
     * 刻意**不**把它算作已加锁，尽管它名字看起来更"专业"、
     * 且在 Chromium 上正是我们要的值。
     *
     * 在 Firefox 上它是一个更弱的策略，认它作"锁上了"等于谎报安全状态 ——
     * 而 UI 会据此显示一个绿色的"WebRTC 已锁定"。
     * 用户看到绿灯就不会再管这件事了。
     */
    ffWebRtcSetting.value = 'disable_non_proxied_udp'
    expect((await firefox.readWebRtcState()).locked).toBe(false)
  })

  it('does not treat a weaker policy as locked', async () => {
    ffWebRtcSetting.value = 'default_public_interface_only'
    expect((await firefox.readWebRtcState()).locked).toBe(false)
  })

  it('🔴 clears instead of writing a permissive value when unlocking', async () => {
    // ADR-18：显式写 'default' 会让本扩展继续持有控制权，
    // 并覆盖用户或其他扩展可能设置的**更严格**策略。
    await firefox.lockWebRtcPolicy()
    ffWebRtcSetting.setCalls = []

    await firefox.unlockWebRtcPolicy()

    expect(ffWebRtcSetting.clearCalls).toHaveLength(1)
    expect(ffWebRtcSetting.setCalls).toHaveLength(0)
  })
})

// ===========================================================================
// 🔴 死角：不许存下一份让开关点不动的设置
// ===========================================================================

describe('🔴 supports 必须能在「保存设置」路径上单独使用', () => {
  /*
   * ## 真机上踩到的死角
   *
   * Firefox 用户在代理**关着**时把模式切成「智能」：
   *   - 保存成功（代理关着，不走重新写入那条路）
   *   - 然后开关就再也点不动了 —— handleEnable 每次被能力检查拦住
   *
   * 一个**能存下去、却让功能失效**的设置是最糟的交互形态：
   * 用户看不出自己做错了什么，只知道开关坏了。
   *
   * 修法是让「保存设置」在**落盘之前**也查一次能力。
   * 而那要求 `supports` 满足两个条件，下面各锁一条：
   *
   *   1. 不需要 await（保存路径上不该多一次网络等待）
   *   2. 不牵连授权（改端口跟隐私窗口权限毫无关系）
   *
   * orchestrator.test.ts 里有对应的行为测试；这里锁的是平台契约本身
   * 具备被那样使用的形状。
   */

  it('🔴 判据与 applyProxy 用的是同一个，不会各说各话', () => {
    /*
     * 若 supports 说"不支持"而 applyProxy 照样能写，或者反过来，
     * 就会出现「存不进去但其实能用」或「存进去了但写不了」。
     * 两者都必须由同一个 needsRuleBasedRouting 决定 ——
     * platform-boundary.test.ts 从源码层面锁了这一点，
     * 这里从行为层面再验一次。
     */
    const smart: Settings = { ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] }
    const empty: Settings = { ...settings, routingMode: 'smart', directRules: [] }

    // 有规则 → 不支持
    expect(firefox.supports(smart)).toBe('ruleBasedRoutingUnsupported')
    // 无规则 → 支持，且此时 buildProxyConfig 产出的就是普通全局配置
    expect(firefox.supports(empty)).toBeNull()
    expect(buildProxyConfig(empty).proxyType).toBe('manual')
  })

  it('🔴 不支持的配置下 supports 先拦，用不着碰浏览器', () => {
    /*
     * 保存设置被 supports 拦住时，**一次浏览器写入都不该发生** ——
     * 否则就是「报了错但还是写了」，比不报错更糟。
     */
    ffProxySetting.setCalls = []

    expect(firefox.supports({ ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] })).toBe(
      'ruleBasedRoutingUnsupported',
    )

    expect(ffProxySetting.setCalls).toHaveLength(0)
  })
})

// ===========================================================================
// 契约完整性
// ===========================================================================

describe('契约', () => {
  it('reports its own identity', () => {
    expect(firefox.id).toBe('firefox')
  })

  it.each([
    'supports',
    'preflight',
    'readProxyState',
    'applyProxy',
    'releaseProxy',
    'onProxyError',
    'readWebRtcState',
    'lockWebRtcPolicy',
    'unlockWebRtcPolicy',
  ])('implements %s', (method) => {
    expect(typeof firefox[method as keyof typeof firefox]).toBe('function')
  })
})
