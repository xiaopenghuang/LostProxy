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
  decideRoute,
  normalizeProxyError,
  PROXY_PASSTHROUGH,
  WEBRTC_LOCKED_POLICY,
} from '../src/background/platform/firefox'
import { shouldBypassProxy } from '../src/background/pac'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { isSelfHealing } from '../src/shared/errors'
import type { Settings } from '../src/shared/types'
import {
  askFirefoxRouter,
  clearFirefoxRequestListeners,
  ffOnRequestPresent,
  ffPermissionEventsPresent,
  ffPermissionListenerCounts,
  ffRawRouterAnswer,
  emitFirefoxProxyError,
  ffErrorListenerCount,
  ffIncognito,
  ffOnErrorPresent,
  ffPermissions,
  ffProxySetting,
  ffRequestFilter,
  ffRequestListenerCount,
  ffWebRtcSetting,
  grantFirefoxPermission,
  installFirefoxMock,
  removeIncognitoApi,
  revokeFirefoxPermission,
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

  it('🔴 refuses smart routing until the permission is granted', async () => {
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
    ffPermissions.granted = false

    expect(await firefox.supports(smart(['*.edu.cn']))).toBe('routingPermissionRequired')
  })

  it('allows smart routing once the permission is granted', async () => {
    // 权限到手之后分流就是普通可用功能，与 Chromium 行为对齐。
    ffPermissions.granted = true

    expect(await firefox.supports(smart(['*.edu.cn']))).toBeNull()
  })

  it('allows global mode', async () => {
    expect(await firefox.supports({ ...settings, routingMode: 'global' })).toBeNull()
  })

  it('allows direct mode', async () => {
    expect(await firefox.supports({ ...settings, routingMode: 'direct' })).toBeNull()
  })

  it('allows smart mode when there are no usable rules', async () => {
    /*
     * 与 Chromium 的 buildProxyConfig 保持同一个判据（needsRuleBasedRouting）：
     * 空清单或全是非法规则时，行为等价于全局，此时没有任何东西会被丢掉，
     * 所以不该拦。
     *
     * 🔴 这条断言锁的是「两个平台用同一个谓词」。若哪天有人在这里
     *   改写成 `routingMode === 'smart'` 就拦，Firefox 用户开着一个
     *   空规则清单就再也开不了代理了 —— 而 Chromium 用户完全正常。
     */
    expect(await firefox.supports(smart([]))).toBeNull()
    expect(await firefox.supports(smart(["bad'", 'also:bad']))).toBeNull()
  })

  it('🔴 does not touch the incognito API', async () => {
    /*
     * `supports` 与 `preflight` 拆开的意义就在这里：能力判断不牵连授权判断。
     *
     * 混在一起的后果此方踩过：一个没授予隐私窗口权限的 Firefox 用户
     * 会**连端口都改不了** —— 因为保存设置那条路会去查一个
     * 跟改端口毫无关系的权限。
     *
     * 注意 `supports` **确实**会查一个权限（可选主机权限），
     * 但那是"这个功能本身需要的"，与"能不能写设置"是两件事。
     */
    ffPermissions.granted = false
    ffIncognito.calls = 0

    expect(await firefox.supports(smart(['*.edu.cn']))).toBe('routingPermissionRequired')

    expect(ffIncognito.calls).toBe(0)
  })

  it('🔴 does not make network requests', async () => {
    /*
     * `supports` 在保存设置那条路径上被调用，而那里等一次网络是没道理的。
     * `permissions.contains` 是本地查询，不算。
     *
     * 把 fetch 从全局删掉 —— 若哪天有人在这里加了个探活就会炸在这条上。
     */
    const originalFetch = globalThis.fetch
    Reflect.deleteProperty(globalThis, 'fetch')

    try {
      await firefox.supports(smart(['*.edu.cn']))
    } finally {
      globalThis.fetch = originalFetch
    }
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
  it('🔴🔴 报泄漏 —— 在 Firefox 上这个事件就意味着已经直连过了', () => {
    /*
     * 依据是 Bugzilla 1528873，Mozilla 标记 **WONTFIX** 并认定是预期行为：
     *
     *   > if the `proxy.onRequest` listener throws an exception, the fetch
     *   > **proceeds without a proxy** ... Making the listener async; i.e.,
     *   > having it return a rejected promise instead of throw an exception,
     *   > still lets the fetch happen without a proxy, but **does** call the
     *   > `proxy.onError` listener.
     *
     * 我们的 routeListener 是 async 的，正好落在后半句 ——
     * 请求已经裸奔出去了，然后我们收到这个事件。
     *
     * ⚠️ 此方原先断言的是 PROXY_RUNTIME_ERROR，理由写的是"信息不足时
     *    不要滥用那条不可自愈的告警"。那个顾虑本身成立，但**前提是错的**：
     *    此方当时假定 Firefox 在求值失败时会拒绝该请求，而 Mozilla 说相反。
     *
     *    决定性的是文案 —— PROXY_RUNTIME_ERROR 对应的
     *    `error.proxyBlocked` 明写「你的真实 IP **没有泄漏**」。
     *    在这条路径上那句话是假的，而它恰好是全项目唯一绝不能说错的一句。
     */
    expect(normalizeProxyError(new Error('pac failed')).code).toBe('PROXY_LEAK_SUSPECTED')
    expect(normalizeProxyError(new Error('pac failed')).code).not.toBe('PROXY_RUNTIME_ERROR')
  })

  it('🔴 报的这条不自愈 —— 它记录的是已经发生的事实', () => {
    /*
     * 与上一条互为一体：选 PROXY_LEAK_SUSPECTED 的代价就是它不会自动消失
     * （ADR-22），必须由用户显式 Dismiss。这条测试把那个代价钉住 ——
     * 若将来有人为了"少一条挂着的告警"把它改成可自愈，
     * 等于让一次真实泄漏的记录悄悄消失。
     */
    expect(isSelfHealing(normalizeProxyError(new Error('x')).code)).toBe(false)
  })

  it('survives a non-Error payload', () => {
    // 事件的实参形状只有 MDN 一句话作依据（"An Error object"）。
    // 传什么都不该炸 —— 这是个诊断用的监听，不值得让它拖垮扩展。
    expect(normalizeProxyError(undefined).code).toBe('PROXY_LEAK_SUSPECTED')
    expect(normalizeProxyError('a string').code).toBe('PROXY_LEAK_SUSPECTED')
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

    expect(received).toEqual(['PROXY_LEAK_SUSPECTED'])
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
   * 修法是让「保存设置」在**落盘之前**也查一次能力，
   * 而这里锁的是平台契约具备被那样使用的形状。
   */

  it('🔴 判据与 applyProxy 用的是同一个，不会各说各话', async () => {
    /*
     * 若 supports 说"不行"而 applyProxy 照样挂分流，或者反过来，
     * 就会出现「存不进去但其实能用」或「存进去了但没生效」。
     * 两者都必须由同一个 needsRuleBasedRouting 决定 ——
     * platform-boundary.test.ts 从源码层面锁了这一点，
     * 这里从行为层面再验一次。
     */
    ffPermissions.granted = false

    const smart: Settings = { ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] }
    const empty: Settings = { ...settings, routingMode: 'smart', directRules: [] }

    // 有规则且没授权 → 要权限
    expect(await firefox.supports(smart)).toBe('routingPermissionRequired')
    // 无规则 → 压根不需要分流，也就不需要权限
    expect(await firefox.supports(empty)).toBeNull()
    expect(buildProxyConfig(empty).proxyType).toBe('manual')
  })

  it('🔴 没授权时不该动浏览器设置', async () => {
    /*
     * 保存设置被 supports 拦住时，**一次浏览器写入都不该发生** ——
     * 否则就是「报了错但还是写了」，比不报错更糟。
     */
    ffPermissions.granted = false
    ffProxySetting.setCalls = []

    expect(
      await firefox.supports({ ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] }),
    ).toBe('routingPermissionRequired')

    expect(ffProxySetting.setCalls).toHaveLength(0)
  })

  it('🔴 supports 不该顺手弹权限窗', async () => {
    /*
     * 查询与索取必须分开（见 types.ts 里 requestPermissions 的注释）。
     *
     * `supports` 会在保存设置、开启代理、渲染状态等多处被调用，
     * 其中大部分**不是**用户手势 —— 而 Firefox 的 permissions.request()
     * 在无手势时直接拒绝。一个会弹窗的查询函数放在那些地方是灾难：
     * 要么弹不出来白白失败，要么在用户没预期的时候弹。
     */
    ffPermissions.granted = false
    ffPermissions.requestCalls = 0

    await firefox.supports({ ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] })

    expect(ffPermissions.requestCalls).toBe(0)
  })

  it('🔴 权限查询失败时报「要权限」，不放行', async () => {
    /*
     * 与 preflight 那边「探测失败不阻断」的取向**相反**，因为代价方向不同：
     *   - preflight 放行的代价：可能白白试一次写入，然后报个错
     *   - 这里放行的代价：挂上一个没有权限的监听。Firefox 会拒绝它，
     *     而请求会**按无分流处理** —— 用户的直连清单被静默忽略
     *
     * 后者是静默的、且正好发生在用户以为分流已生效的时候。宁可多问一次权限。
     */
    ffPermissions.failNextContains = new Error('permissions API exploded')

    expect(
      await firefox.supports({ ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] }),
    ).toBe('routingPermissionRequired')
  })
})

describe('🔴🔴 平台层不索取权限', () => {
  const smart: Settings = { ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] }

  /*
   * 这一组测的是一件**不该存在的事**。
   *
   * 此方原先在平台层放了 `requestPermissions(settings)`，由 orchestrator
   * 在处理 SAVE_SETTINGS / ENABLE 时调用，注释里写着"那两条消息都由
   * 用户点击发出，所以手势成立"。那句话是错的：
   *
   *   - MDN User actions 页：「the background page message handler is
   *     **not** considered to be handling a user action」
   *   - 且路径上任何一个 `await` 都会烧掉手势状态（Bugzilla 1398833）
   *
   * 于是 `request()` 抛错、被 catch 吞掉，用户看到一句"要么在弹窗里允许"，
   * 而那个弹窗永远不出现。索权现在只发生在设置页的点击回调里。
   */

  it('🔴🔴 平台对象上没有 requestPermissions', () => {
    /*
     * 断言"不存在"而不是删掉测试：删掉之后，下一个人（包括此方）
     * 完全可能因为"supports 说缺权限，那自然该有个地方去要"
     * 而把它加回来 —— 而它会在真机上静默失败。
     * 留一条会红的测试，比留一句注释可靠。
     */
    expect('requestPermissions' in firefox).toBe(false)
  })

  it('🔴 supports 只查不要 —— 缺权限时不触发任何 request', async () => {
    ffPermissions.granted = false
    ffPermissions.requestCalls = 0

    expect(await firefox.supports(smart)).toBe('routingPermissionRequired')
    // 查询函数弹窗是灾难：它会在保存设置、开启代理、渲染状态等多处被调用。
    expect(ffPermissions.requestCalls).toBe(0)
  })

  it('已授权时 supports 放行', async () => {
    ffPermissions.granted = true
    expect(await firefox.supports(smart)).toBeNull()
  })
})

// ===========================================================================
// 🔴🔴 智能分流：proxy.onRequest
// ===========================================================================

describe('🔴🔴 decideRoute · fail-closed 靠末尾那个 null', () => {
  const rules = ['*.edu.cn', 'lib.example.org']
  const route = (url: string) => decideRoute(settings, rules, url)

  it('🔴🔴 proxied answers end with null', () => {
    /*
     * **这是整个 Firefox 分流实现里最不能错的一格。**
     *
     * MDN proxy.onRequest 原话：
     *   > By default, the request **fails over to any browser-defined proxy**
     *   > unless a null object or an array ending in a null object is returned.
     *
     * 也就是说只返回 `{type:'http',...}` 是 **fail-open** ——
     * 我们的代理连不上时，浏览器会自己找别的出路（包括直连），
     * 而那正是本项目最不能发生的事：用户以为在走代理，实际直连。
     *
     * 与 PAC 那边是**镜像**关系，值得一起记住：
     *   - PAC：不写 `; DIRECT` 才安全（写了才 fail-open）
     *   - onRequest：**必须**写 null 才安全（不写就 fail-open）
     * 两个 API 的默认方向相反，照着一边的直觉写另一边一定会错。
     */
    const answer = route('https://www.google.com/')

    expect(Array.isArray(answer)).toBe(true)
    const list = answer as unknown[]
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ type: 'http', host: '127.0.0.1', port: 7890 })
    // 🔴 末尾必须是 null —— 「用这个代理，没有下一个」。
    expect(list[1]).toBeNull()
  })

  it('routes a matching suffix rule direct', () => {
    expect(route('https://lib.swpu.edu.cn/paper')).toEqual({ type: 'direct' })
  })

  it('routes the bare domain of a suffix rule direct', () => {
    // `*.edu.cn` 同时命中裸域 `edu.cn` —— 与 PAC 那边语义一致。
    expect(route('https://edu.cn/')).toEqual({ type: 'direct' })
  })

  it('routes an exact rule direct', () => {
    expect(route('https://lib.example.org/x')).toEqual({ type: 'direct' })
  })

  it('does not let an exact rule match a subdomain', () => {
    // 精确匹配就是精确 —— `lib.example.org` 不该命中 `a.lib.example.org`。
    expect(Array.isArray(route('https://a.lib.example.org/'))).toBe(true)
  })

  it('routes loopback direct so the controller probe cannot self-loop', () => {
    /*
     * ADR-02 的 onRequest 版：扩展访问 Controller 的请求若被送进代理，
     * 会形成自环 —— 不报错，只是诡异地卡住。
     */
    for (const url of ['http://127.0.0.1:9097/version', 'http://localhost:9097/', 'http://[::1]/']) {
      expect(route(url), url).toEqual({ type: 'direct' })
    }
  })

  it('routes dotless hosts direct', () => {
    // 内网主机名（`router`、`nas`）—— 与 bypass 清单的 `<local>` 对应。
    expect(route('http://nas/')).toEqual({ type: 'direct' })
  })

  it('🔴 proxies an unparseable URL instead of sending it direct', () => {
    /*
     * fail-closed 的同一条精神：拿不准时选更保守的那个。
     * 一个我们看不懂的 URL 直连出去，可能正是那个会暴露真实 IP 的请求。
     */
    const answer = route('not a url at all')

    expect(Array.isArray(answer)).toBe(true)
    expect((answer as unknown[])[1]).toBeNull()
  })

  it('is case-insensitive on the host', () => {
    expect(route('https://LIB.SWPU.EDU.CN/')).toEqual({ type: 'direct' })
  })

  it('honours a user-changed proxy port', () => {
    const list = decideRoute(
      { ...settings, proxyPort: 2080 },
      rules,
      'https://www.google.com/',
    ) as unknown[]

    expect(list[0]).toEqual({ type: 'http', host: '127.0.0.1', port: 2080 })
  })

  it('🔴 agrees with the PAC implementation on the same hosts', () => {
    /*
     * 🔴 这条守的是一个**复刻关系**。
     *
     * 分流判定有两份实现：`shouldBypassProxy`（本函数用的）与
     * `buildPacScript` 生成的脚本（Chromium 用的）。后者必须复刻前者的逻辑，
     * 因为 PAC 在浏览器的独立 JS 环境里跑，没法调我们的函数。
     *
     * 复刻会漂移，而漂移的后果是**同一条规则在两个浏览器上行为不同** ——
     * 用户在 Edge 上配好的直连清单，换到 Firefox 上某几条突然不生效。
     * 那种 bug 极难归因，因为两边的配置字面上完全一样。
     */
    const hosts = [
      'lib.swpu.edu.cn',
      'edu.cn',
      'lib.example.org',
      'a.lib.example.org',
      'www.google.com',
      '127.0.0.1',
      'localhost',
      'nas',
      'notedu.cn',
    ]

    for (const host of hosts) {
      const answer = route(`https://${host}/`)
      const saysDirect = !Array.isArray(answer)

      expect(saysDirect, host).toBe(shouldBypassProxy(host, rules))
    }
  })
})

describe('🔴 registerListeners · 顶层注册的分流监听', () => {
  const smart: Settings = { ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] }

  /** 装一个"现读状态"的读取器，模拟 index.ts 注入的那个闭包。 */
  function inject(state: { enabled: boolean; settings: Settings }) {
    const box = { ...state }
    firefox.registerListeners(async () => box)
    return box
  }

  it('registers exactly one listener, on <all_urls>', () => {
    inject({ enabled: true, settings: smart })

    expect(ffRequestListenerCount()).toBe(1)
    /*
     * 刻意不按 requestType 过滤：任何请求都可能暴露 IP，
     * 少拦一类就是留一个口子 —— 与 ADR-01 拒绝 `proxyForHttp` 同一个道理。
     */
    expect(ffRequestFilter()?.urls).toEqual(['<all_urls>'])
  })

  it('proxies a non-matching host', async () => {
    inject({ enabled: true, settings: smart })

    const list = (await askFirefoxRouter('https://www.google.com/')) as unknown[]

    expect(list[0]).toEqual({ type: 'http', host: '127.0.0.1', port: 7890 })
    expect(list[1]).toBeNull()
  })

  it('sends a matching host direct', async () => {
    inject({ enabled: true, settings: smart })

    expect(await askFirefoxRouter('https://lib.swpu.edu.cn/')).toEqual({ type: 'direct' })
  })

  it('🔴🔴 stays silent when the proxy is switched OFF', async () => {
    /*
     * 🔴 此方在写 releaseProxy 的注释时发现的漏洞。
     *
     * 监听是顶层注册的、永久存在，而它只看 routingMode 与规则清单 ——
     * 那两样在用户**关掉代理之后并不会变**。所以关掉代理后它仍会返回
     * "走 127.0.0.1:7890"，流量继续进代理。
     *
     * 那是**反方向的欺骗**：用户点了关闭、UI 显示已关闭，而浏览器还在走代理。
     * 比"以为开了其实没开"更隐蔽，因为不会有任何症状 —— 网页照常打开，
     * 只是出口还是节点 IP。一个想临时切回校园网查资料的人会完全被误导，
     * 而且会得出"这插件的开关是假的"这个结论 —— 那比功能缺失严重得多。
     */
    inject({ enabled: false, settings: smart })

    expect(await askFirefoxRouter('https://www.google.com/')).toBeNull()
  })

  it('🔴 does not force DIRECT when off, it abstains', async () => {
    /*
     * 关闭时返回 undefined（不表态）而不是 `{type:'direct'}`。
     *
     * 后者会**强制**直连，越权覆盖用户自己可能配的系统代理 ——
     * 与 ADR-18 拒绝写 direct 是同一个道理：「关闭 LostProxy」的语义是
     * 「LostProxy 不再干预」，不是「强制全世界直连」。
     *
     * askFirefoxRouter 把 undefined 与 null 都归成 null（照 Firefox 的
     * "第一个返回非空的赢"语义），所以这里额外直接检查监听的原始返回。
     */
    inject({ enabled: false, settings: smart })

    const raw = await ffRawRouterAnswer('https://www.google.com/')

    expect(raw).toBeUndefined()
  })

  it('abstains in global mode so proxy.settings decides', async () => {
    /*
     * 全局模式下不表态 —— 让 `proxy.settings` 里那份全局代理生效。
     *
     * 刻意**不**返回 direct：那会把全局模式下的所有流量直连，
     * 也就是把代理整个关掉，而用户以为它开着。
     */
    inject({ enabled: true, settings: { ...settings, routingMode: 'global' } })

    expect(await ffRawRouterAnswer('https://www.google.com/')).toBeUndefined()
  })

  it('abstains when smart mode has no usable rules', async () => {
    // 等价于全局，同上。
    inject({ enabled: true, settings: { ...smart, directRules: [] } })

    expect(await ffRawRouterAnswer('https://www.google.com/')).toBeUndefined()
  })

  it('🔴 re-reads state on every request instead of capturing it', async () => {
    /*
     * 监听必须**现读**状态，不能捏着注册时的那份快照。
     *
     * 事件页被卸载重建后，这个闭包会重新执行 —— 但在同一次存活期内，
     * 用户完全可能改规则或关开关。捏快照的表现是"改了设置没反应"，
     * 而更糟的是关掉开关之后流量还在走代理。
     */
    const box = inject({ enabled: true, settings: smart })

    expect(Array.isArray(await askFirefoxRouter('https://www.google.com/'))).toBe(true)

    // 用户关掉了开关。
    box.enabled = false

    expect(await askFirefoxRouter('https://www.google.com/')).toBeNull()
  })

  it('🔴 proxies when the state read throws', async () => {
    /*
     * fail-closed：读不到状态时走代理，而不是直连。
     *
     * 用默认端口做兜底是个**猜测**，而这里可以接受：这条路只在
     * "读 storage 失败"时走到，那本身已经是异常。猜错的后果是请求失败
     * （可见故障）；不猜（直连）的后果是真实 IP 泄漏。
     */
    firefox.registerListeners(async () => {
      throw new Error('storage exploded')
    })

    const list = (await askFirefoxRouter('https://www.google.com/')) as unknown[]

    expect(Array.isArray(list)).toBe(true)
    expect(list[1]).toBeNull()
  })

  it('🔴 does not throw when proxy.onRequest is unavailable', () => {
    /*
     * `onRequest` 需要 `<all_urls>`，而它是**可选**权限 ——
     * 用户没给时这个 API 可能不可用。
     *
     * 这段代码在事件页**顶层**执行，抛出去会让整个背景脚本挂掉 ——
     * 连本来能正常工作的代理开关一起没了。一个可选功能不值得这个代价。
     */
    ffOnRequestPresent.value = false

    expect(() => firefox.registerListeners(async () => ({ enabled: true, settings: smart }))).not.toThrow()
  })

  it('🔴 applyProxy does not attach its own listener', async () => {
    /*
     * 此方最初把监听挂在 applyProxy 里，那违反了 index.ts 自己写着的铁律
     * （事件监听必须顶层同步注册）。Firefox 的事件页空闲约 30 秒就卸载，
     * 从业务流程挂的监听随之消失且没人重挂 ——
     * 用户的直连清单于是静默失效：校内站点开始走代理，页面还能开，
     * 只是进不去校内资源。在他眼里就是"这功能坏了"。
     *
     * 这条断言锁住那个错误不再复现。
     */
    await firefox.applyProxy(smart)

    expect(ffRequestListenerCount()).toBe(0)
  })

  it('releaseProxy does not need to detach anything', async () => {
    // 监听现读状态，所以关闭代理时不需要摘它 —— 不存在
    // "该摘的时候没摘"或"摘了又没重挂"这类状态。
    inject({ enabled: true, settings: smart })

    await firefox.releaseProxy()

    expect(ffRequestListenerCount()).toBe(1)
    expect(ffProxySetting.clearCalls).toHaveLength(1)
  })
})

// ===========================================================================
// 🔴🔴 授权之后必须重挂监听
// ===========================================================================

describe('🔴🔴 permissions.onAdded · 授权后重挂分流监听', () => {
  const smart: Settings = { ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] }

  beforeEach(() => {
    clearFirefoxRequestListeners()
  })

  it('🔴🔴 未授权时启动、随后授权 —— 监听必须挂上', async () => {
    /*
     * 此方原先在 registerRouter 里写着「用户授权之后 Firefox 会重启扩展，
     * 届时重新注册」。**那是错的。** MDN 说的是要监听 onAdded/onRemoved。
     *
     * 按错的假设走会得到这条路径：
     *   1. 扩展启动，还没有 `<all_urls>` → addListener 失败
     *   2. 用户在设置页授权
     *   3. 扩展继续跑着，监听始终没挂上
     *   4. 而 supports() 现在返回 null，代理照常以智能模式开启
     *   5. **直连清单被静默忽略** —— 全走代理，页面能开，看不出问题
     *
     * 第 5 步正是整个分流设计要防的事，从授权这条路漏了进来。
     *
     * ⚠️ 它靠事件页空闲卸载、下次唤醒重跑顶层代码**碰巧**会自愈。
     *    但那是巧合：用户如果一直在用浏览器，或授权后立刻访问站点，
     *    就撞在窗口里。依赖巧合的安全性等于没有安全性。
     */
    ffPermissions.granted = false
    ffOnRequestPresent.value = false // 模拟"没权限所以挂不上"

    firefox.registerListeners(async () => ({ enabled: true, settings: smart }))
    expect(ffRequestListenerCount()).toBe(0)

    // 用户在设置页点了授权按钮。
    ffOnRequestPresent.value = true
    grantFirefoxPermission()

    expect(ffRequestListenerCount()).toBe(1)

    // 而且它真的能答题 —— 挂上了但不工作等于没挂。
    expect(Array.isArray(await askFirefoxRouter('https://www.google.com/'))).toBe(true)
    expect(await askFirefoxRouter('https://x.edu.cn/')).toEqual({ type: 'direct' })
  })

  it('🔴 注册时就挂上了 onAdded 与 onRemoved', () => {
    firefox.registerListeners(async () => ({ enabled: true, settings: smart }))

    const counts = ffPermissionListenerCounts()
    expect(counts.added).toBe(1)
    expect(counts.removed).toBe(1)
  })

  it('🔴 重挂不会累积成两个监听', async () => {
    /*
     * onAdded 可能在监听已经挂着时触发（用户授了另一个不相关的权限）。
     * 若不先摘就挂，会累积出多个监听 —— 而 `askFirefoxRouter` 取第一个
     * 非空答案，所以症状不是"答错"而是"每个请求被问 N 次"，
     * 一个只在性能上表现出来、极难归因的问题。
     */
    firefox.registerListeners(async () => ({ enabled: true, settings: smart }))
    expect(ffRequestListenerCount()).toBe(1)

    grantFirefoxPermission()
    grantFirefoxPermission()

    expect(ffRequestListenerCount()).toBe(1)
  })

  it('权限被撤销后重挂一次 —— 与 supports 保持一致', () => {
    firefox.registerListeners(async () => ({ enabled: true, settings: smart }))

    revokeFirefoxPermission()

    // 撤销后 supports 会重新拦住智能模式，两边说的是同一件事。
    expect(ffRequestListenerCount()).toBe(1)
  })

  it('🔴 事件 API 不存在时不抛 —— 顶层抛错会让整个扩展起不来', () => {
    ffPermissionEventsPresent.value = false

    expect(() =>
      firefox.registerListeners(async () => ({ enabled: true, settings: smart })),
    ).not.toThrow()
  })
})

// ===========================================================================
// 🔴🔴 监听内部抛出 = 静默直连
// ===========================================================================

describe('🔴🔴 routeListener 兜住一切异常', () => {
  const smart: Settings = { ...settings, routingMode: 'smart', directRules: ['*.edu.cn'] }

  beforeEach(() => {
    clearFirefoxRequestListeners()
  })

  it('🔴🔴 状态对象畸形时走代理，不让异常穿出去', async () => {
    /*
     * Bugzilla 1528873（Mozilla 标记 **WONTFIX**，认定是预期行为）：
     *   > if the `proxy.onRequest` listener throws an exception, the fetch
     *   > **proceeds without a proxy**
     * async 监听返回 rejected promise 也一样 —— 请求照样裸奔出去。
     *
     * 所以这个监听里任何一次意外抛出，代价都不是"这个请求失败"，
     * 而是"这个请求直连"。末尾那个 `null` 防不住它：
     * `null` 只管"代理地址连不上"，管不了"我们压根没给出答案"。
     *
     * 此方最初只把 `readState()` 包进 try，把 needsRuleBasedRouting /
     * sanitizeRules / decideRoute 留在外面。这条测试模拟其中一步抛出。
     */
    firefox.registerListeners(async () => {
      // 一个能通过 await、但会让后续读字段炸掉的返回值。
      return { enabled: true, settings: null } as unknown as {
        enabled: boolean
        settings: Settings
      }
    })

    const answer = (await askFirefoxRouter('https://www.google.com/')) as unknown[]

    expect(Array.isArray(answer)).toBe(true)
    expect(answer[1]).toBeNull() // fail-closed 的末尾 null 仍在
  })

  it('🔴 URL 畸形时走代理', async () => {
    /*
     * 解析不出主机名的 URL 走代理而不是直连 —— 同一条精神：
     * 拿不准的时候选更保守的那个。一个我们看不懂的 URL 直连出去，
     * 可能正是那个会暴露真实 IP 的请求。
     */
    firefox.registerListeners(async () => ({ enabled: true, settings: smart }))

    const answer = (await askFirefoxRouter('not-a-url')) as unknown[]

    expect(Array.isArray(answer)).toBe(true)
    expect(answer[1]).toBeNull()
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
