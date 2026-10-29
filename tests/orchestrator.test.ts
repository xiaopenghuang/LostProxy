/**
 * 编排层单元测试。
 *
 * 这是补上的一个真缺口：在此之前，项目最核心的安全语义
 * ——「先写代理，再管别的」的 fail-closed 顺序（ADR-03）——
 * 只有代码注释保护。
 *
 * 本文件锁定该顺序的**两个方向**，它们对应两种相反的退化：
 *
 *   1. 有人加了前置探活「Core 没起来就别开代理了吧」
 *      → 用户以为在走代理、实际直连 → 静默泄漏真实 IP
 *   2. 有人把 setEnabledState(true) 挪到了写代理之前
 *      → 写失败时开关仍亮着 → 显示假 ON（技术方案 §22 Case 3 明令禁止）
 *
 * 两条测试各堵一个方向。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectStatus,
  handleDisable,
  handleDismissError,
  handleEnable,
  handleGetStatus,
  handleListConnections,
  handleMessage,
  handleTabLoading,
  handleSaveSettings,
  handleSelfCheck,
  handleSyncTimezone,
  handleTestCore,
  handleToggle,
  pickError,
  reconcile,
} from '../src/background/orchestrator'
import { checkSupported, inspectProxy, type ProxyInspection } from '../src/background/proxy'
import { needsRuleBasedRouting } from '../src/background/pac'
import { errors } from '../src/shared/errors'
import type { MessageKey } from '../src/shared/i18n'
import {
  getEnabledState,
  getLastError,
  getSettings,
  saveSettings,
  setEnabledState,
  setLastError,
} from '../src/background/storage'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { LevelOfControl, NormalizedError, Settings } from '../src/shared/types'
import {
  failNextExecuteScript,
  proxySetting,
  readDynamicRules,
  readExecuteScriptCalls,
  seedDynamicRules,
  seedMockStore,
  setGrantedOrigins,
  setMockExecuteScriptResult,
  setMockTabs,
  webRtcSetting,
} from './setup'

const SECRET = 'sk-orchestrator-secret-must-not-escape'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 记录 fetch 调用，供断言「有没有发出请求」「发到哪个端点」。 */
let fetchedUrls: string[] = []

/**
 * 默认让探活成功；个别用例再覆盖。
 *
 * ⚠️ 刻意**按 URL 分派**而不是对所有请求返回同一个响应体。
 *   collectStatus 会同时打 `/version` 与 `/group`，一个不分 URL 的桩
 *   会把版本号对象喂给策略组解析器 —— 于是「Core 在线」的测试环境里
 *   组永远是 CORE_BAD_RESPONSE。那样的桩不像真内核，
 *   它会让真 bug 通过测试。
 */
function stubCore(groups: readonly unknown[] = [], proxies: Record<string, unknown> = {}): void {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    fetchedUrls.push(url)
    if (url.endsWith('/version')) return Promise.resolve(json({ meta: true, version: 'v1.19.0' }))
    if (url.endsWith('/group')) return Promise.resolve(json({ proxies: groups }))
    if (url.endsWith('/connections')) return Promise.resolve(json({ connections: [], uploadTotal: 0, downloadTotal: 0 }))
    // GET /proxies —— 延迟与协议同源。靠路径末尾与下面的 PUT 区分。
    if (url.endsWith('/proxies')) return Promise.resolve(json({ proxies }))
    // PUT /proxies/{name}
    return Promise.resolve(new Response(null, { status: 204 }))
  })
}

function stubCoreOnline(): void {
  stubCore()
}

function stubCoreOffline(): void {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
}

/** 端口上有 mihomo，但 secret 错了。 */
function stubCoreAuthFailed(): void {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 401 })))
}

/** 端口上有服务，但不是 mihomo（例如指到了某个网页服务）。 */
function stubCoreWrongService(): void {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html>hi</html>', { status: 200 })))
}

function inspection(
  level: LevelOfControl | 'unknown',
  matchesExpected: boolean,
): ProxyInspection {
  return { levelOfControl: level, mode: matchesExpected ? 'fixed_servers' : null, matchesExpected }
}

beforeEach(() => {
  fetchedUrls = []
  stubCoreOnline()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

describe('pickError', () => {
  // 用真实的 errors 工厂而不是手写字面量：既保证与生产代码同构，
  // 又让 NormalizedError 将来加字段时不用再回来改一遍测试。
  const persisted = errors.proxyBlocked()
  const okProbe = { ok: true as const, version: { meta: true, version: 'v1' } }
  /** 端口上什么都没有 —— 可能是客户端只开 named pipe，不是错误。 */
  const offlineProbe = { ok: false as const, error: errors.coreOffline('127.0.0.1', 9090) }
  /** 端口上有 mihomo，但 secret 错了 —— 真错误。 */
  const authProbe = { ok: false as const, error: errors.coreAuthFailed() }
  /** 端口上有东西，但不是 mihomo —— 真错误。 */
  const badPayloadProbe = { ok: false as const, error: errors.coreBadResponse() }
  const healthy = inspection('controlled_by_this_extension', true)

  it('gives a persisted runtime error the highest priority', () => {
    // 它意味着可能已经泄漏过真实 IP —— 比任何其他状态都严重。
    const result = pickError(persisted, true, inspection('not_controllable', false), offlineProbe)
    expect(result?.code).toBe('PROXY_RUNTIME_ERROR')
  })

  it('reports a policy lockdown', () => {
    const result = pickError(null, true, inspection('not_controllable', false), okProbe)
    expect(result?.code).toBe('PROXY_NOT_CONTROLLABLE')
  })

  it('reports another extension', () => {
    const result = pickError(
      null,
      true,
      inspection('controlled_by_other_extensions', false),
      okProbe,
    )
    expect(result?.code).toBe('PROXY_CONTROLLED_BY_OTHER')
  })

  it('reports a state mismatch when enabled but the browser disagrees', () => {
    const result = pickError(null, true, inspection('controllable_by_this_extension', false), okProbe)
    expect(result?.message).toMatch(/not using LostProxy settings/i)
  })

  /*
   * 🔴 枚举矩阵（V0.9 补）。
   *
   * `levelOfControl` 有五个取值（`LevelOfControl` 四个 + 查询失败时的
   * 'unknown'），而 `pickError` 是一串 if —— **漏掉一个既不会编译失败，
   * 也不会有任何提示**。三档分流里 `direct` 曾经就是这样漏了六个版本。
   *
   * 这张表把「每个取值 × 是否一致」的结论钉死。它的真正价值不在今天这几行，
   * 而在于将来往 `LevelOfControl` 加一个值时：新值必然出现在类型里，
   * 而这张表会立刻显示出一格没被覆盖的空缺。
   *
   * 断言用 `key` 而不是 `code`：`stateMismatch` 用的是通用码 `UNKNOWN`，
   * 只看 code 会把「状态不一致」和「其它未知错误」混为一谈。
   */
  const LEVEL_MATRIX: ReadonlyArray<{
    readonly level: LevelOfControl | 'unknown'
    readonly matches: boolean
    readonly key: MessageKey | null
  }> = [
    // 这两条是「浏览器不让写」，无论当前配置对不对都该报 —— 用户以为开着、
    // 实际没生效，是这个项目最不能让它静默发生的事。
    { level: 'not_controllable', matches: true, key: 'error.proxyNotControllable' },
    { level: 'not_controllable', matches: false, key: 'error.proxyNotControllable' },
    {
      level: 'controlled_by_other_extensions',
      matches: true,
      key: 'error.proxyControlledByOther',
    },
    {
      level: 'controlled_by_other_extensions',
      matches: false,
      key: 'error.proxyControlledByOther',
    },
    // 能控、且已经一致：没有可报的。
    { level: 'controllable_by_this_extension', matches: true, key: null },
    { level: 'controlled_by_this_extension', matches: true, key: null },
    // 能控但不一致：这正是「显示开了其实没写进去」。
    { level: 'controllable_by_this_extension', matches: false, key: 'error.stateMismatch' },
    { level: 'controlled_by_this_extension', matches: false, key: 'error.stateMismatch' },
    /*
     * 查询失败（'unknown'）且比对认为不一致 —— 报。
     * 注意与写入路径的区别：那边「查询失败」**不阻断写入**（宁可试试）；
     * 这边是"已经写完了在巡检"，不一致就得说。
     */
    { level: 'unknown', matches: false, key: 'error.stateMismatch' },
    // 查询失败但比对认为一致 —— 没理由报错。
    { level: 'unknown', matches: true, key: null },
  ]

  it.each(LEVEL_MATRIX)(
    '$level（matches=$matches）→ $key',
    ({ level, matches, key }) => {
      const result = pickError(null, true, inspection(level, matches), okProbe)
      expect(result?.key ?? null).toBe(key)
    },
  )

  it('🔴 does not report a mere core outage as an error', () => {
    // ADR-23：端口上什么都没有，很可能是客户端刻意只开 named pipe
    // （那其实更安全）。代理走 mixed-port，与 Controller 无关。
    // 把这个报成错误会在那些用户那里产生一条永久挂着的告警。
    const result = pickError(null, true, healthy, offlineProbe)
    expect(result).toBeNull()
  })

  it('does report a controller misconfiguration (auth failed)', () => {
    // 认证失败证明端口上**确实有** mihomo，只是 secret 错了 —— 可修复的真错误。
    const result = pickError(null, true, healthy, authProbe)
    expect(result?.code).toBe('CORE_AUTH_FAILED')
  })

  it('does report a controller misconfiguration (wrong service on the port)', () => {
    const result = pickError(null, true, healthy, badPayloadProbe)
    expect(result?.code).toBe('CORE_BAD_RESPONSE')
  })

  it('prioritises proxy-side problems over controller problems', () => {
    // 代理不生效比读不到状态严重得多。
    const result = pickError(null, true, inspection('not_controllable', false), authProbe)
    expect(result?.code).toBe('PROXY_NOT_CONTROLLABLE')
  })

  it('does not report proxy-side problems while switched off', () => {
    // 开关是 OFF 时，「浏览器没在用我们的配置」是正确状态，不是错误。
    const result = pickError(
      null,
      false,
      inspection('controllable_by_this_extension', false),
      okProbe,
    )
    expect(result).toBeNull()
  })

  it('returns null when everything is fine', () => {
    expect(pickError(null, true, healthy, okProbe)).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('handleEnable — fail-closed', () => {
  it('🔴 applies the proxy even when the core is offline', async () => {
    // 方向 1：堵住「Core 没起来就别开代理了吧」这类看似体贴、实则制造泄漏的改动。
    stubCoreOffline()

    const response = await handleEnable()

    expect(response.ok).toBe(true)
    expect(proxySetting.setCalls).toHaveLength(1)
    await expect(getEnabledState()).resolves.toBe(true)

    // 代理是开着的，Core 不可观测被如实报告为 unreachable ——
    // 但它**不是错误**（ADR-23）：代理走 mixed-port，与 Controller 无关。
    if (response.ok) {
      expect(response.data.coreStatus).toBe('unreachable')
      expect(response.data.lastError).toBeNull()
    }
  })

  it('🔴 does not mark the proxy enabled when the write is refused', async () => {
    // 方向 2：堵住「先置 enabled 再写代理」导致的假 ON。
    proxySetting.levelOfControl = 'controlled_by_other_extensions'

    const response = await handleEnable()

    expect(response.ok).toBe(false)
    await expect(getEnabledState()).resolves.toBe(false)
    expect(proxySetting.setCalls).toHaveLength(0)
  })

  it('does not mark the proxy enabled when the write throws', async () => {
    proxySetting.failNextSet = new Error('set rejected')

    const response = await handleEnable()

    expect(response.ok).toBe(false)
    await expect(getEnabledState()).resolves.toBe(false)
  })

  it('records the failure so the popup can show it after a worker restart', async () => {
    proxySetting.levelOfControl = 'not_controllable'
    await handleEnable()

    // 重新采集（模拟 SW 重启后 Popup 再次查询）——错误必须还在。
    const snapshot = await collectStatus()
    expect(snapshot.lastError?.code).toBe('PROXY_NOT_CONTROLLABLE')
  })

  it('locks WebRTC when enabling with the lock preference on', async () => {
    await handleEnable()
    expect(webRtcSetting.setCalls).toHaveLength(1)
    expect(webRtcSetting.setCalls[0]?.value).toBe('disable_non_proxied_udp')
  })

  it('does not lock WebRTC when the user opted out', async () => {
    await saveSettings({ webRtcLockEnabled: false })
    webRtcSetting.clearCalls = []

    await handleEnable()

    expect(webRtcSetting.setCalls).toHaveLength(0)
  })

  it('clears a stale runtime warning on a fresh enable', async () => {
    await setLastError(errors.proxyBlocked())

    const response = await handleEnable()

    expect(response.ok).toBe(true)
    if (response.ok) expect(response.data.lastError).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('handleDisable', () => {
  it('clears the proxy and records the intent', async () => {
    await handleEnable()

    const response = await handleDisable()

    expect(response.ok).toBe(true)
    expect(proxySetting.clearCalls).toHaveLength(1)
    await expect(getEnabledState()).resolves.toBe(false)
  })

  it('unlocks WebRTC', async () => {
    await handleEnable()
    webRtcSetting.clearCalls = []

    await handleDisable()

    expect(webRtcSetting.clearCalls).toHaveLength(1)
  })

  it('keeps the intent unchanged when the clear fails', async () => {
    await handleEnable()
    proxySetting.failNextClear = new Error('clear rejected')

    const response = await handleDisable()

    expect(response.ok).toBe(false)
    // 清除失败 ⇒ 代理可能还开着 ⇒ 意图不能改成 false，否则又是状态撕裂。
    await expect(getEnabledState()).resolves.toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('handleSaveSettings', () => {
  it('re-applies the proxy when settings change while enabled', async () => {
    // ⚠️ 极易漏掉的一步：改了端口不重新写入，浏览器还指向旧端口，
    // 而 UI 显示新端口 —— 一个隐蔽的状态撕裂。
    await handleEnable()
    proxySetting.setCalls = []

    const response = await handleSaveSettings({ proxyPort: 1080 })

    expect(response.ok).toBe(true)
    expect(proxySetting.setCalls).toHaveLength(1)
    expect(proxySetting.setCalls[0]?.value.rules?.singleProxy?.port).toBe(1080)
  })

  it('does not touch the proxy when saving while disabled', async () => {
    const response = await handleSaveSettings({ proxyPort: 1080 })

    expect(response.ok).toBe(true)
    expect(proxySetting.setCalls).toHaveLength(0)
  })

  it('rejects invalid settings without writing anything', async () => {
    const response = await handleSaveSettings({ proxyPort: 999999 })

    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('INVALID_SETTINGS')
    expect(proxySetting.setCalls).toHaveLength(0)
  })

  it('returns a view without the secret', async () => {
    const response = await handleSaveSettings({ controllerSecret: SECRET })

    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.data.hasSecret).toBe(true)
      expect(JSON.stringify(response.data)).not.toContain(SECRET)
    }
  })

  it('syncs the WebRTC lock to the new preference', async () => {
    await handleEnable()
    webRtcSetting.clearCalls = []

    await handleSaveSettings({ webRtcLockEnabled: false })

    // 代理还开着，但用户关掉了锁 ⇒ 必须解锁。
    expect(webRtcSetting.clearCalls).toHaveLength(1)
  })

  it('applies a partial patch without dropping the untouched fields', async () => {
    // Settings 页留空 secret 就是走这条路径 —— 改端口不该把 secret 洗掉。
    await saveSettings({ proxyPort: 7891, controllerPort: 9091, controllerSecret: SECRET })

    const response = await handleSaveSettings({ proxyHost: '10.0.0.1' })

    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.data.proxyHost).toBe('10.0.0.1')
      expect(response.data.proxyPort).toBe(7891)
      expect(response.data.controllerPort).toBe(9091)
      // 关键：没提 secret，所以 secret 必须还在。
      expect(response.data.hasSecret).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 🔴 保存设置时的重新写入失败 —— Firefox 真机测试发现的 bug
// ---------------------------------------------------------------------------

describe('🔴 handleSaveSettings · 重新写入失败必须上报并回滚', () => {
  /*
   * ## 这个 bug 长什么样
   *
   * 原实现是 `await enableProxy(result.value)` —— **丢掉了返回值**。
   * 于是代理开着时保存一份"写不进去"的设置会走成这样：
   *
   *   1. saveSettings 成功，新设置已落盘
   *   2. enableProxy 失败（Firefox 上是 preflight 拦住了 smart 模式）
   *   3. 那个 false 被丢掉，响应仍是 ok:true
   *   4. UI 高亮新模式、开关还亮着 —— 而浏览器里是**旧配置**
   *
   * 三方撕裂：storage 说 smart，浏览器在跑 global，UI 显示 smart。
   * 用户以为直连清单生效了，实际一条都没起作用 ——
   * 正是 ADR-37 拒绝静默降级要避免的东西，从另一条路漏进来。
   *
   * ## 为什么 Chromium 上一直没暴露
   *
   * 那边 `preflight` 永远返回 null，而 enableProxy 的其余失败分支
   * （被别的扩展控制）在"保存设置"这个动作里极少发生。
   * 所以它在 Edge 上跑过整个 V0.4 都没被发现 ——
   * 是 Firefox 的平台差异把一个一直存在的疏漏顶到了表面。
   *
   * ## 这里用什么模拟失败
   *
   * 测试跑在 chromium 平台上，`preflight` 恒为 null，没法从那条路造失败。
   * 所以用 `failNextSet` 让浏览器写入本身失败 —— 它触发的是
   * enableProxy 里同一个 `return { ok: false }`，
   * 也就是同一条被丢掉的返回值。守住的是同一个疏漏。
   */

  it('🔴 reports the failure instead of returning ok', async () => {
    await handleEnable()
    proxySetting.failNextSet = new Error('write rejected')

    const response = await handleSaveSettings({ proxyPort: 1080 })

    // 原实现在这里返回 ok:true —— UI 于是显示"保存成功"。
    expect(response.ok).toBe(false)
  })

  it('🔴 rolls the settings back so storage matches the browser', async () => {
    /*
     * 只报错还不够。若新设置留在 storage 里，用户就处在
     * 「存的是新的、浏览器在跑旧的」这个状态里 —— 而它会**持久存在**：
     * 关掉代理再想开就必须先手动改回去，
     * 这正是真机上观察到的「一关代理就再也开不起来」。
     */
    await handleEnable()
    proxySetting.failNextSet = new Error('write rejected')

    await handleSaveSettings({ proxyPort: 1080 })

    // storage 必须还是原来那份，而不是 1080。
    expect((await getSettings()).proxyPort).toBe(DEFAULT_SETTINGS.proxyPort)
  })

  it('🔴 leaves the browser on the configuration that actually works', async () => {
    // 回滚不该把浏览器也弄坏：那份旧配置本来就在跑着，
    // 回滚后浏览器仍应处于「与 storage 一致」的状态。
    await handleEnable()
    proxySetting.failNextSet = new Error('write rejected')

    await handleSaveSettings({ proxyPort: 1080 })

    const inspection = await inspectProxy(await getSettings())
    expect(inspection.matchesExpected).toBe(true)
  })

  it('does not roll back when the proxy is off', async () => {
    /*
     * 代理关着时不重新写入，所以不存在"写失败"，也就没有可回滚的东西。
     * 这条防的是修复过度 —— 把回滚做成无条件的话，
     * 关着代理改端口会莫名其妙地改不动。
     */
    const response = await handleSaveSettings({ proxyPort: 1080 })

    expect(response.ok).toBe(true)
    expect((await getSettings()).proxyPort).toBe(1080)
  })

  it('checkSupported is consulted with the merged settings, not just the patch', async () => {
    /*
     * 这条锁的是真机上那个死角修复的一个关键细节。
     *
     * 死角本身：Firefox 用户在代理**关着**时把模式切成「智能」，
     * 保存成功，然后开关就再也点不动了 —— 一个能存下去、
     * 却让功能失效的设置。修法是在**落盘之前**查一次平台能力。
     *
     * 而查的必须是 **merge 之后**的完整设置，不是 patch 本身：
     * 用户在 Popup 上点「智能」时，patch 里只有 `{routingMode:'smart'}`，
     * 规则清单在**已存的设置**里。只看 patch 会得出"没有规则、
     * 等价于全局、放行"，于是死角原封不动地复发。
     *
     * ⚠️ 覆盖缺口，如实记录：测试跑在 chromium 平台上，`supports` 恒为 null，
     *    所以这条**不能**从 handleSaveSettings 的返回值上验出来 ——
     *    那条分支在 chromium 上永远不命中。这里直接验 checkSupported
     *    在 merge 语义下的行为；Firefox 侧的能力断言在
     *    platform-firefox.test.ts，两边合起来才覆盖完整。
     *
     *    要在 orchestrator 层面真正端到端验这条，需要让测试能切换平台，
     *    而那会引入测试间的顺序依赖（platform 是构建期常量）。
     *    此方选择留这个缺口并写明，而不是加一个脆弱的 spy。
     */
    const stored: Settings = {
      ...DEFAULT_SETTINGS,
      directRules: ['*.edu.cn'],
      routingMode: 'global',
    }

    // 只有 patch：看不出需要分流。
    expect(await checkSupported({ ...DEFAULT_SETTINGS, routingMode: 'smart' })).toBeNull()

    // merge 之后：规则来自已存设置，这才是真正要判的那份配置。
    const merged: Settings = { ...stored, routingMode: 'smart' }
    // chromium 支持一切，所以这里是 null —— 断言的是它**收到了**完整配置，
    // 由 needsRuleBasedRouting 判定为"需要分流"。
    expect(needsRuleBasedRouting(merged)).toBe(true)
    expect(needsRuleBasedRouting({ ...DEFAULT_SETTINGS, routingMode: 'smart' })).toBe(false)
  })

  it('keeps the secret intact across a rollback', async () => {
    /*
     * 回滚走的是 saveSettings(before)，而 `before` 带着 secret 明文。
     * 若哪天有人把回滚改成只回滚"用户刚改的那几个字段"，
     * secret 可能被洗成空串 —— 而那是用户得重新输入一次的东西，
     * 且他完全不知道为什么。
     */
    await saveSettings({ controllerSecret: SECRET })
    await handleEnable()
    proxySetting.failNextSet = new Error('write rejected')

    await handleSaveSettings({ proxyPort: 1080 })

    expect((await getSettings()).controllerSecret).toBe(SECRET)
  })
})

// ---------------------------------------------------------------------------

describe('handleTestCore', () => {
  it('reports the version when the core answers', async () => {
    const response = await handleTestCore()

    expect(response.ok).toBe(true)
    if (response.ok) expect(response.data.version).toBe('v1.19.0')
  })

  it('reports an outage without changing any setting', async () => {
    stubCoreOffline()

    const response = await handleTestCore()

    expect(response.ok).toBe(false)
    // [Test Mihomo] 是纯查询，绝不能有副作用。
    expect(proxySetting.setCalls).toHaveLength(0)
    expect(proxySetting.clearCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('collectStatus', () => {
  it('assembles a coherent snapshot', async () => {
    await handleEnable()

    const snapshot = await collectStatus()

    expect(snapshot.enabled).toBe(true)
    expect(snapshot.proxyActuallySet).toBe(true)
    expect(snapshot.coreStatus).toBe('online')
    expect(snapshot.coreVersion).toBe('v1.19.0')
    expect(snapshot.webRtcLocked).toBe(true)
    expect(snapshot.levelOfControl).toBe('controlled_by_this_extension')
  })

  it.each([
    ['online', stubCoreOnline, 'online'],
    ['unreachable', stubCoreOffline, 'unreachable'],
    ['auth failure', stubCoreAuthFailed, 'error'],
    ['wrong service', stubCoreWrongService, 'error'],
  ] as const)('maps a %s probe to coreStatus=%s', async (_label, stub, expected) => {
    stub()
    const snapshot = await collectStatus()
    expect(snapshot.coreStatus).toBe(expected)
  })

  it('reports no version unless the core is online', async () => {
    stubCoreOffline()
    const snapshot = await collectStatus()
    expect(snapshot.coreVersion).toBeNull()
  })

  it('🔴 never carries the Controller Secret', async () => {
    // 比检查字段名更强：能抓住「secret 被拼进某个别的字段」这类错误。
    await saveSettings({ controllerSecret: SECRET })

    const snapshot = await collectStatus()

    expect(JSON.stringify(snapshot)).not.toContain(SECRET)
    expect(snapshot.settings.hasSecret).toBe(true)
  })

  it('has no side effects', async () => {
    await collectStatus()
    expect(proxySetting.setCalls).toHaveLength(0)
    expect(proxySetting.clearCalls).toHaveLength(0)
    expect(webRtcSetting.setCalls).toHaveLength(0)
  })

  it('surfaces a mismatch between intent and reality', async () => {
    // 模拟「扩展被禁用后重新启用」：意图仍是 ON，但浏览器已被清空。
    await setEnabledState(true)

    const snapshot = await collectStatus()

    expect(snapshot.enabled).toBe(true)
    expect(snapshot.proxyActuallySet).toBe(false)
    expect(snapshot.lastError?.message).toMatch(/not using LostProxy settings/i)
  })
})

// ---------------------------------------------------------------------------

describe('reconcile', () => {
  it('does nothing while switched off', async () => {
    await reconcile()
    expect(proxySetting.setCalls).toHaveLength(0)
  })

  it('re-applies the proxy when the browser lost our config', async () => {
    // 正是「扩展被禁用 → 浏览器自动清除设置 → 重新启用」的场景（ADR-06）。
    await setEnabledState(true)

    await reconcile()

    expect(proxySetting.setCalls).toHaveLength(1)
    expect(webRtcSetting.setCalls).toHaveLength(1)
  })

  it('does not rewrite an already consistent config', async () => {
    await handleEnable()
    proxySetting.setCalls = []

    await reconcile()

    expect(proxySetting.setCalls).toHaveLength(0)
  })

  it('does not fight a policy lockdown', async () => {
    await setEnabledState(true)
    proxySetting.levelOfControl = 'not_controllable'

    await reconcile()

    expect(proxySetting.setCalls).toHaveLength(0)
  })

  it('does not fight another extension', async () => {
    await setEnabledState(true)
    proxySetting.levelOfControl = 'controlled_by_other_extensions'

    await reconcile()

    expect(proxySetting.setCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('self-healing alerts', () => {
  /** 造一条「请求被阻止」告警，ageMs 控制它有多旧。 */
  function blocked(ageMs = 0): NormalizedError {
    return { ...errors.proxyBlocked(), at: Date.now() - ageMs }
  }

  function leak(ageMs = 0): NormalizedError {
    return { ...errors.proxyLeakSuspected(), at: Date.now() - ageMs }
  }

  /** 把环境搞成「代理配置已正确写入」。 */
  async function proxyApplied(): Promise<void> {
    await handleEnable()
  }

  it('🟢 clears a transient alert immediately when the controller confirms recovery', async () => {
    // 强证据路径：Controller 可达 ⇒ Mihomo 确实在跑，不必等时间窗口。
    await proxyApplied()
    await setLastError(blocked())

    const response = await handleGetStatus()

    expect(response.ok).toBe(true)
    if (response.ok) expect(response.data.lastError).toBeNull()
    // 必须真的落盘清除，而不只是从这一次的响应里抹掉。
    await expect(getLastError()).resolves.toBeNull()
  })

  it('🟢 clears a stale alert even when the controller is unobservable', async () => {
    // 🔴 这是 Master 真机环境的路径：客户端只开 named pipe，
    // coreStatus 永远是 unreachable。若把「Controller 可达」当作
    // 自愈的必要条件，自愈对这类用户就完全无效——
    // 那会复刻 ADR-23 要修的同一个错误。
    await proxyApplied()
    stubCoreOffline()
    await setLastError(blocked(60_000))

    const response = await handleGetStatus()

    if (response.ok) expect(response.data.lastError).toBeNull()
    await expect(getLastError()).resolves.toBeNull()
  })

  it('keeps a fresh alert while the controller is unobservable', async () => {
    // 弱证据路径下必须先静默一段时间。若代理仍然坏着，
    // 这期间任何一次页面加载都会产生新的 onProxyError 刷新时间戳。
    await proxyApplied()
    stubCoreOffline()
    await setLastError(blocked(0))

    const response = await handleGetStatus()

    if (response.ok) expect(response.data.lastError?.code).toBe('PROXY_RUNTIME_ERROR')
  })

  it('keeps the alert while the browser is not using our config', async () => {
    // 意图是 ON 但浏览器没在用我们的配置 —— 问题显然没解决，
    // 无论告警多旧都不该清。
    await setEnabledState(true)
    await setLastError(blocked(60_000))

    const response = await handleGetStatus()

    if (response.ok) expect(response.data.lastError?.code).toBe('PROXY_RUNTIME_ERROR')
  })

  it('🔴 never clears a suspected leak, even when fully recovered', async () => {
    // PROXY_LEAK_SUSPECTED 记录的是「已经发生过直连」这个事实，
    // 不是当前状态。悄悄清掉等于替用户决定「这事不重要」。
    await proxyApplied()
    await setLastError(leak())

    const response = await handleGetStatus()

    if (response.ok) expect(response.data.lastError?.code).toBe('PROXY_LEAK_SUSPECTED')
    await expect(getLastError()).resolves.not.toBeNull()
  })

  it('🔴 never clears a suspected leak no matter how old it is', async () => {
    // 时间判据只适用于瞬时故障。泄漏事实不会因为「过了很久」就不重要。
    await proxyApplied()
    await setLastError(leak(365 * 24 * 3600_000))

    const response = await handleGetStatus()

    if (response.ok) expect(response.data.lastError?.code).toBe('PROXY_LEAK_SUSPECTED')
  })

  it('does not heal on plain collectStatus (which must stay read-only)', async () => {
    await proxyApplied()
    await setLastError(blocked())

    await collectStatus()

    // collectStatus 是只读的；自愈是 handleGetStatus 的显式行为。
    await expect(getLastError()).resolves.not.toBeNull()
  })

  it('lets a new failure re-raise the alert after healing', async () => {
    // 自愈的语义是「反映最近是否真的在失败」，不是「曾经失败过」。
    // 清掉之后若再次失败，新事件必须能重新写入。
    await proxyApplied()
    await setLastError(blocked())
    await handleGetStatus()
    await expect(getLastError()).resolves.toBeNull()

    await setLastError(blocked())
    await expect(getLastError()).resolves.not.toBeNull()
  })
})

describe('handleDismissError', () => {
  it('clears a suspected leak on explicit user confirmation', async () => {
    await handleEnable()
    await setLastError(errors.proxyLeakSuspected())

    const response = await handleDismissError()

    expect(response.ok).toBe(true)
    if (response.ok) expect(response.data.lastError).toBeNull()
    await expect(getLastError()).resolves.toBeNull()
  })

  it('does not touch any proxy or privacy setting', async () => {
    await setLastError(errors.proxyLeakSuspected())
    proxySetting.setCalls = []
    proxySetting.clearCalls = []
    webRtcSetting.setCalls = []
    webRtcSetting.clearCalls = []

    await handleDismissError()

    // Dismiss 只是「我知道了」，绝不能顺手改动网络设置。
    expect(proxySetting.setCalls).toHaveLength(0)
    expect(proxySetting.clearCalls).toHaveLength(0)
    expect(webRtcSetting.setCalls).toHaveLength(0)
    expect(webRtcSetting.clearCalls).toHaveLength(0)
  })

  it('is routed through handleMessage', async () => {
    const response = await handleMessage({ type: 'DISMISS_ERROR' })
    expect(response.ok).toBe(true)
  })
})

describe('handleMessage', () => {
  it.each([undefined, null, 42, 'GET_STATUS', {}, { notType: 1 }])(
    'rejects a malformed message %o',
    async (message) => {
      const response = await handleMessage(message)
      expect(response.ok).toBe(false)
    },
  )

  it('rejects an unsupported type instead of silently ignoring it', async () => {
    const response = await handleMessage({ type: 'DROP_TABLES' })
    expect(response.ok).toBe(false)
  })

  it('routes GET_STATUS', async () => {
    const response = await handleMessage({ type: 'GET_STATUS' })
    expect(response.ok).toBe(true)
  })

  it('routes ENABLE_PROXY and DISABLE_PROXY', async () => {
    expect((await handleMessage({ type: 'ENABLE_PROXY' })).ok).toBe(true)
    expect(proxySetting.setCalls).toHaveLength(1)

    expect((await handleMessage({ type: 'DISABLE_PROXY' })).ok).toBe(true)
    expect(proxySetting.clearCalls).toHaveLength(1)
  })

  it('routes TEST_CORE', async () => {
    const response = await handleMessage({ type: 'TEST_CORE' })
    expect(response.ok).toBe(true)
  })

  it('routes SAVE_SETTINGS', async () => {
    const response = await handleMessage({ type: 'SAVE_SETTINGS', patch: { proxyPort: 1080 } })
    expect(response.ok).toBe(true)
  })

  it('converts an unexpected throw into an error envelope', async () => {
    // 若让异常逃出去，sendResponse 会拿到 undefined，Popup 只看到"没反应"。
    proxySetting.failNextGet = new Error('boom')
    proxySetting.failNextSet = new Error('boom')

    const response = await handleMessage({ type: 'ENABLE_PROXY' })

    expect(response.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('defaults', () => {
  it('starts from the documented defaults', async () => {
    const snapshot = await collectStatus()

    expect(snapshot.enabled).toBe(false)
    expect(snapshot.settings.proxyHost).toBe(DEFAULT_SETTINGS.proxyHost)
    expect(snapshot.settings.proxyPort).toBe(DEFAULT_SETTINGS.proxyPort)
    expect(snapshot.settings.controllerPort).toBe(DEFAULT_SETTINGS.controllerPort)
    expect(snapshot.settings.hasSecret).toBe(false)
    expect(snapshot.settings.webRtcLockEnabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// V0.2 节点切换
// ---------------------------------------------------------------------------

const GROUP = '🇭🇰 香港 | 专线'

const selectorGroup = { name: GROUP, type: 'Selector', now: 'HK-01', all: ['HK-01', 'HK-02'] }

async function withGroupConfigured(): Promise<void> {
  await saveSettings({ primaryGroup: GROUP })
}

describe('collectStatus · 策略组', () => {
  it('resolves the configured group into a renderable view', async () => {
    stubCore([selectorGroup])
    await withGroupConfigured()

    const snapshot = await collectStatus()

    expect(snapshot.groupError).toBeNull()
    expect(snapshot.group).toEqual({
      name: GROUP,
      type: 'Selector',
      now: 'HK-01',
      nodes: ['HK-01', 'HK-02'],
      // V0.3：延迟从 /proxies 的 history 读取。这个桩没提供 history，
      // 所以两个节点都是 null —— null 而非 0，因为 0 会被渲染成"0ms"。
      latency: { 'HK-01': null, 'HK-02': null },
      // V0.7：协议从同一份 /proxies 响应的 type 读取。桩里没有 type，
      // 于是两个都是空串 = 不显示徽章，而非缺键。
      protocol: { 'HK-01': '', 'HK-02': '' },
    })
  })

  it('carries each member’s protocol into the view（V0.7）', async () => {
    stubCore([selectorGroup], {
      'HK-01': { type: 'Vless', history: [{ delay: 52 }] },
      'HK-02': { type: 'Hysteria2' },
    })
    await withGroupConfigured()

    const snapshot = await collectStatus()

    expect(snapshot.group?.protocol).toEqual({ 'HK-01': 'Vless', 'HK-02': 'Hysteria2' })
    // 同一份 /proxies 响应同时给出了延迟 —— 这就是"零额外请求"的含义。
    expect(snapshot.group?.latency['HK-01']).toBe(52)
  })

  it('scopes the protocol map to this group’s members', async () => {
    // 不把整个内核的 proxy 字典塞进快照 —— 一份大订阅有几百条。
    stubCore([selectorGroup], {
      'HK-01': { type: 'Vless' },
      'HK-02': { type: 'Vless' },
      '别的组的节点': { type: 'Trojan' },
    })
    await withGroupConfigured()

    const snapshot = await collectStatus()

    expect(Object.keys(snapshot.group?.protocol ?? {})).toEqual(['HK-01', 'HK-02'])
  })

  it('🔴 leaves nested groups and built-in outbounds without a protocol', async () => {
    /*
     * 成员位置上出现策略组是正常的（组可嵌套），DIRECT / REJECT 也一样。
     * 两者都没有"协议"可言，给它们标上 URLTest / Direct 是错的。
     *
     * `新组` 那一项是两条判据的分界：它的 type 不在 NON_PROTOCOL_TYPES 里，
     * 只能靠"成员名出现在组列表里"认出来 —— 内核将来新增组类型时正是这条兜住。
     */
    stubCore(
      [
        {
          name: GROUP,
          type: 'Selector',
          now: 'HK-01',
          all: ['HK-01', '自动选择', 'DIRECT', '新组'],
        },
        { name: '自动选择', type: 'URLTest', now: 'HK-01', all: ['HK-01'] },
        { name: '新组', type: 'BrandNewGroupKind', now: 'HK-01', all: ['HK-01'] },
      ],
      {
        'HK-01': { type: 'Vless' },
        '自动选择': { type: 'URLTest' },
        DIRECT: { type: 'Direct' },
        '新组': { type: 'BrandNewGroupKind' },
      },
    )
    await withGroupConfigured()

    const snapshot = await collectStatus()

    expect(snapshot.group?.protocol).toEqual({
      'HK-01': 'Vless',
      '自动选择': '',
      DIRECT: '',
      '新组': '',
    })
  })

  it('reports GROUP_NOT_CONFIGURED before the user has picked one', async () => {
    // 默认值必须为空（§16 禁止硬编码组名），所以每个新用户都会经过这个状态。
    stubCore([selectorGroup])

    const snapshot = await collectStatus()

    expect(snapshot.group).toBeNull()
    expect(snapshot.groupError?.code).toBe('GROUP_NOT_CONFIGURED')
  })

  it('reports GROUP_NOT_FOUND when the subscription no longer has that group', async () => {
    stubCore([{ name: 'Something Else', type: 'Selector', now: 'A', all: ['A'] }])
    await withGroupConfigured()

    const snapshot = await collectStatus()

    expect(snapshot.group).toBeNull()
    expect(snapshot.groupError?.code).toBe('GROUP_NOT_FOUND')
  })

  /*
   * 组名要发回内核，模糊匹配到的名字未必是内核认的那个。
   *
   * ⚠️ 用拉丁字母做大小写用例：`'香港'.toUpperCase()` 是恒等变换，
   *    拿 CJK 测大小写敏感会得到一条"通过了但什么都没验"的测试
   *    （此方第一版就是这么写的，它确实通过了 —— 因为字符串根本没变）。
   */
  it.each([
    ['different case', 'proxy', 'Proxy'],
    ['a trailing space', 'Proxy ', 'Proxy'],
    ['a leading space', ' Proxy', 'Proxy'],
  ])('does not match a group name differing only by %s', async (_label, configured, actual) => {
    stubCore([{ ...selectorGroup, name: actual }])
    await saveSettings({ primaryGroup: configured })

    expect((await collectStatus()).groupError?.code).toBe('GROUP_NOT_FOUND')
  })

  it('surfaces an unreachable controller as CORE_OFFLINE in groupError', async () => {
    stubCoreOffline()
    await withGroupConfigured()

    const snapshot = await collectStatus()

    expect(snapshot.group).toBeNull()
    expect(snapshot.groupError?.code).toBe('CORE_OFFLINE')
  })

  /*
   * 🔴 本轮最重要的一条不变量。
   *
   * groupError 与 lastError 是两个独立字段。若把组错误也写进 lastError，
   * 一次「组名不存在」就会顶掉一条尚未确认的 PROXY_LEAK_SUSPECTED ——
   * 用最不重要的信息盖掉最重要的信息。
   */
  it('🔴 never lets a group failure displace an unacknowledged leak warning', async () => {
    stubCore([]) // 组一个都没有 → 必然 GROUP_NOT_FOUND
    await withGroupConfigured()
    const leak = errors.proxyLeakSuspected()
    await setLastError(leak)

    const snapshot = await collectStatus()

    expect(snapshot.groupError?.code).toBe('GROUP_NOT_FOUND')
    // 泄漏告警必须原样留着
    expect(snapshot.lastError?.code).toBe('PROXY_LEAK_SUSPECTED')
  })

  it('🔴 keeps a group failure out of persisted storage entirely', async () => {
    // 组错误是瞬时的读取结果，不该跨 Service Worker 重启存活。
    stubCore([])
    await withGroupConfigured()

    await collectStatus()

    expect(await getLastError()).toBeNull()
  })
})

describe('handleSelectNode', () => {
  it('switches the node and returns a fresh snapshot', async () => {
    stubCore([selectorGroup])
    await withGroupConfigured()

    const result = await handleMessage({ type: 'SELECT_NODE', node: 'HK-02' })

    expect(result.ok).toBe(true)
    // PUT 打到了编码后的组路径上
    expect(fetchedUrls.some((u) => u.includes(`/proxies/${encodeURIComponent(GROUP)}`))).toBe(true)
  })

  it('refuses when no group is configured, without touching the core', async () => {
    stubCore([selectorGroup])

    const result = await handleMessage({ type: 'SELECT_NODE', node: 'HK-02' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('GROUP_NOT_CONFIGURED')
    // 没配组就不该发出任何 PUT —— 我们连要改哪个组都不知道。
    expect(fetchedUrls.some((u) => u.includes('/proxies/'))).toBe(false)
  })

  it('🔴 does not persist a switch failure into lastError', async () => {
    /*
     * 切节点失败是一次操作的失败，不是代理层的安全事件。
     * 写进 lastError 会让它挤进 pickError 的最高优先级，
     * 盖住真正的代理告警 —— 而那条可能是尚未确认的泄漏警告。
     */
    await withGroupConfigured()
    const leak = errors.proxyLeakSuspected()
    await setLastError(leak)
    // 让 PUT 失败：内核拒绝手动切换
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/version')) return Promise.resolve(json({ meta: true, version: 'v1' }))
      if (url.endsWith('/group')) return Promise.resolve(json({ proxies: [selectorGroup] }))
      return Promise.resolve(json({ message: 'Must be a Selector' }, 400))
    })

    const result = await handleMessage({ type: 'SELECT_NODE', node: 'HK-02' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('GROUP_NOT_SELECTABLE')
    // 泄漏告警没有被这次失败覆盖
    expect((await getLastError())?.code).toBe('PROXY_LEAK_SUSPECTED')
  })

  it('does not require the proxy toggle to be ON', async () => {
    /*
     * 切节点走 Controller，与代理开关无关。要求先开代理是没有依据的限制 ——
     * 用户完全可能想先选好节点再开代理。
     */
    stubCore([selectorGroup])
    await withGroupConfigured()
    await setEnabledState(false)

    expect((await handleMessage({ type: 'SELECT_NODE', node: 'HK-02' })).ok).toBe(true)
  })
})

describe('handleListGroups', () => {
  it('returns every group, including ones the core will not switch', async () => {
    /*
     * ADR-29：不预先过滤组类型。过滤掉 URLTest 的代价是在新内核上
     * 藏掉本来能用的功能，而且这种失败完全无声。
     */
    stubCore([selectorGroup, { name: 'Auto', type: 'URLTest', now: 'A', all: ['A', 'B'] }])

    const result = await handleMessage({ type: 'LIST_GROUPS' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as { groups: readonly { name: string; type: string }[] }
    expect(data.groups.map((g) => g.type)).toEqual(['Selector', 'URLTest'])
  })

  it('propagates a controller failure instead of returning an empty list', async () => {
    // 空列表会被 UI 渲染成「你没有任何策略组」，那是错误的结论。
    stubCoreOffline()

    const result = await handleMessage({ type: 'LIST_GROUPS' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CORE_OFFLINE')
  })

  it('never exposes the secret in the response', async () => {
    await saveSettings({ controllerSecret: SECRET })
    stubCore([selectorGroup])

    const result = await handleMessage({ type: 'LIST_GROUPS' })

    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})

// ---------------------------------------------------------------------------
// V0.8 实时连接
// ---------------------------------------------------------------------------

describe('handleListConnections（V0.8）', () => {
  it('returns normalized connections and totals from the core', async () => {
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/connections')) {
        return Promise.resolve(
          json({
            connections: [
              { id: 'a', metadata: { host: 'a.com' }, chains: ['N', 'G'], rule: 'Match', upload: 3, download: 4 },
            ],
            uploadTotal: 30,
            downloadTotal: 40,
          }),
        )
      }
      return Promise.resolve(json({}))
    })

    const res = await handleListConnections()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.connections).toHaveLength(1)
    expect(res.data.connections[0]?.host).toBe('a.com')
    expect(res.data.uploadTotal).toBe(30)
    expect(res.data.downloadTotal).toBe(40)
  })

  it('passes the core error through when the controller is unreachable', async () => {
    stubCoreOffline()
    const res = await handleListConnections()
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('CORE_OFFLINE')
  })

  it('🔴 does not persist a read failure into lastError', async () => {
    // 读连接失败是一次查询的失败，不是代理层安全事件；写进 lastError 会盖住
    // 可能存在的泄漏告警（与 SELECT_NODE 同一条纪律）。
    stubCoreOffline()
    await handleListConnections()
    expect(await getLastError()).toBeNull()
  })
})

describe('handleToggle（V0.8）', () => {
  it('enables when currently disabled', async () => {
    stubCoreOnline()
    await setEnabledState(false)

    const res = await handleToggle()

    expect(res.ok).toBe(true)
    expect(await getEnabledState()).toBe(true)
  })

  it('disables when currently enabled', async () => {
    stubCoreOnline()
    await setEnabledState(true)

    const res = await handleToggle()

    expect(res.ok).toBe(true)
    expect(await getEnabledState()).toBe(false)
  })

  it('routes through the same message handler', async () => {
    stubCoreOnline()
    await setEnabledState(false)
    // handleToggle 不是消息类型，但走的是 handleEnable —— 确认它真的翻转了状态。
    await handleToggle()
    expect(await getEnabledState()).toBe(true)
  })
})

describe('V0.9 时区同步的入口守卫', () => {
  it('代理没开时拒绝探测', async () => {
    // 关着代理探测测到的是本机时区，注入进去等于"同步了但同步错了"。
    seedMockStore({
      'lostproxy.settings': { ...DEFAULT_SETTINGS, timezoneSyncEnabled: true },
      'lostproxy.enabled': false,
    })

    const response = await handleMessage({ type: 'SYNC_TIMEZONE' })

    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('TZ_PROXY_OFF')
  })

  it('🔴 清单为空时拒绝探测，且一个请求都不发', async () => {
    /*
     * 这条是补一个真实缺口：原先清单为空时探测照常成功、快照照常写入，
     * 而 `reinjectOpenTabs([])` 一个站点都没碰。用户看到「已同步」，
     * 刷新页面却毫无变化 —— 而"功能正常"与"什么都没做"在他的观察里一样。
     *
     * 断言 fetch 没被调用，比只断言返回码更强：它锁住了"连探测都不该发生"，
     * 而不只是"返回了错误"。
     */
    seedMockStore({
      'lostproxy.settings': { ...DEFAULT_SETTINGS, timezoneSyncEnabled: true, timezoneHosts: [] },
      'lostproxy.enabled': true,
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await handleMessage({ type: 'SYNC_TIMEZONE' })

    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('TZ_NO_HOSTS')
    expect(fetchMock).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('清单为空时不会写入任何时区快照', async () => {
    // 连"留个半成品状态"都不该发生：否则 popup 上会出现一个不成立的时区名。
    seedMockStore({
      'lostproxy.settings': { ...DEFAULT_SETTINGS, timezoneSyncEnabled: true, timezoneHosts: [] },
      'lostproxy.enabled': true,
    })
    vi.stubGlobal('fetch', vi.fn())

    await handleMessage({ type: 'SYNC_TIMEZONE' })

    const stored = await getSettings()
    expect(stored.timezoneHosts).toEqual([])
    const snapshot = await chrome.storage.local.get('lostproxy.timezone')
    expect(snapshot['lostproxy.timezone']).toBeUndefined()

    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// V0.9 页面加载路径
// ---------------------------------------------------------------------------

describe('V0.9 handleTabLoading', () => {
  /*
   * 这是整个时区功能**唯一真正生效**的路径 —— 前面那些测试测的都是零件，
   * 只有这里把零件串起来。它有四个前置条件和两种快慢路径，每一格都可能写错，
   * 而写错的表现是「功能静默不生效」或「每次导航都多一个请求」，
   * 两者都不会有任何报错。
   */

  /** 功能打开、代理开着、清单里有 chatgpt.com 的基线状态。 */
  const READY = {
    'lostproxy.settings': {
      ...DEFAULT_SETTINGS,
      timezoneSyncEnabled: true,
      localeSyncEnabled: true,
      timezoneHosts: ['chatgpt.com'],
    },
    'lostproxy.enabled': true,
  }

  const freshSnapshot = {
    zone: 'Asia/Tokyo',
    country: 'JP',
    locale: 'ja-JP',
    exitIp: '103.1.2.3',
    at: Date.now(),
    node: 'JP-01',
  }

  /** 造一个成功的探测响应，并返回 fetch mock 供断言调用次数。 */
  function stubProbe(body: unknown = { timezone: 'Asia/Tokyo', ip: '103.1.2.3' }) {
    const mock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    }))
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('url 缺失时什么都不做', async () => {
    // tab.url 在未授予目标站点权限时就是 undefined，这正是未授权该有的样子。
    seedMockStore(READY)
    const fetchMock = stubProbe()

    await handleTabLoading(1, undefined)

    expect(readExecuteScriptCalls()).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('功能未启用时不注入、也不探测', async () => {
    seedMockStore({
      ...READY,
      'lostproxy.settings': { ...DEFAULT_SETTINGS, timezoneSyncEnabled: false },
    })
    const fetchMock = stubProbe()

    await handleTabLoading(1, 'https://chatgpt.com/')

    expect(readExecuteScriptCalls()).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('域名不在清单里时不动', async () => {
    seedMockStore(READY)
    const fetchMock = stubProbe()

    await handleTabLoading(1, 'https://example.com/')

    expect(readExecuteScriptCalls()).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('代理关着时不注入', async () => {
    // 关着代理时页面本来就从真实位置出去，改时区只会制造新的矛盾。
    seedMockStore({ ...READY, 'lostproxy.enabled': false })
    const fetchMock = stubProbe()

    await handleTabLoading(1, 'https://chatgpt.com/')

    expect(readExecuteScriptCalls()).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('🔴 快照新鲜时直接注入，一个请求都不发', async () => {
    /*
     * 这条是快路径的全部价值：绝大多数导航应当零额外网络请求。
     * 少了这个分支，用户每开一个页面都会被计一次 ipinfo 调用 ——
     * 而那正是限流风险的来源。
     */
    seedMockStore({ ...READY, 'lostproxy.timezone': freshSnapshot })
    const fetchMock = stubProbe()

    await handleTabLoading(7, 'https://chatgpt.com/')

    expect(fetchMock).not.toHaveBeenCalled()
    const calls = readExecuteScriptCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([{ zone: 'Asia/Tokyo', locale: 'ja-JP' }])
    // 用 toMatchObject 而不是 `calls[0]?.target as ...`：
    // 后者在 calls 为空时会从 undefined 上取属性并抛 TypeError，
    // 于是失败信息变成一句无关的崩溃，而不是"没注入到预期的标签页"。
    expect(calls[0]?.target).toMatchObject({ tabId: 7 })
  })

  it('🔴 快照过期时先注入旧值，刷新放到后台', async () => {
    /*
     * 顺序是这次改动的核心：**注入在前，探测在后**。
     *
     * 探测最长 7 秒（两个源各 3.5 秒），而这条路径存在的意义就是赶在页面
     * 脚本之前写完。等探测回来，页面早就跑完了 —— 那时注入只是一个没人
     * 读的值。旧实现在这里先探测再注入，等于每过一个 TTL 就有一次注入
     * 注定失败，而用户看到的是"换节点之后时区就不好使了"。
     */
    seedMockStore({
      ...READY,
      'lostproxy.timezone': {
        zone: 'Asia/Shanghai',
        country: 'CN',
        locale: 'zh-CN',
        exitIp: '1.1.1.1',
        at: 0,
        node: 'CN-01',
        error: null,
      },
    })
    const fetchMock = stubProbe({ timezone: 'Asia/Tokyo', ip: '103.1.2.3', country: 'JP' })

    await handleTabLoading(7, 'https://chatgpt.com/')

    // 注入发生在这条路径结束之前，用的是快照里那份旧值。
    expect(readExecuteScriptCalls()[0]?.args).toEqual([
      { zone: 'Asia/Shanghai', locale: 'zh-CN' },
    ])

    // 刷新是后台的，但要真的发生。
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('🔴 探测卡住也不阻塞注入', async () => {
    /*
     * 把"不 await"这条约束钉死。若有人把 `void` 改成 `await`，这条会超时 ——
     * 而真实世界里的表现是：一个响应很慢的探测源让每次页面加载都卡住几秒，
     * 注入全部迟到，功能整体失效，但没有任何报错。
     */
    seedMockStore({
      ...READY,
      'lostproxy.timezone': {
        zone: 'Asia/Shanghai',
        country: 'CN',
        locale: 'zh-CN',
        exitIp: null,
        at: 0,
        node: null,
        error: null,
      },
    })
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))

    await handleTabLoading(9, 'https://chatgpt.com/')

    expect(readExecuteScriptCalls()).toHaveLength(1)
    expect(readExecuteScriptCalls()[0]?.args).toEqual([
      { zone: 'Asia/Shanghai', locale: 'zh-CN' },
    ])
  })

  it('探测失败时不注入，也不抛', async () => {
    // 页面加载路径上不该因为一次探测失败冒出与当前动作无关的错误。
    seedMockStore(READY)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(handleTabLoading(7, 'https://chatgpt.com/')).resolves.toBeUndefined()
    expect(readExecuteScriptCalls()).toHaveLength(0)
  })

  it('注入失败（缺权限）时也不抛', async () => {
    seedMockStore({ ...READY, 'lostproxy.timezone': freshSnapshot })
    failNextExecuteScript(new Error('Cannot access contents of the page'))

    await expect(handleTabLoading(7, 'https://chatgpt.com/')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// V0.10 请求头规则的生命周期
// ---------------------------------------------------------------------------

describe('V0.10 请求头规则', () => {
  /**
   * 这些用例守的是同一个东西：**规则只该存在于它该存在的时候**。
   *
   * 规则是浏览器级持久化的，寿命比 Service Worker、比页面、甚至比
   * 用户的这次会话都长。所以每一条"该清掉"的路径都必须有测试 ——
   * 漏掉任何一条，症状都是「功能已经关了，请求头还在被改」，
   * 而它不会报错、不会出现在任何界面上。
   */

  const SYNC_READY = {
    'lostproxy.settings': {
      ...DEFAULT_SETTINGS,
      timezoneSyncEnabled: true,
      localeSyncEnabled: true,
      timezoneHosts: ['chatgpt.com', 'openai.com'],
    },
    'lostproxy.enabled': true,
  }

  function stubProbeWith(body: unknown) {
    const mock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }))
    vi.stubGlobal('fetch', mock)
    return mock
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('探测成功后为清单里的每个域名建立规则', async () => {
    seedMockStore(SYNC_READY)
    stubProbeWith({ timezone: 'America/Los_Angeles', ip: '1.2.3.4', country: 'US' })

    const response = await handleSyncTimezone()

    expect(response.ok).toBe(true)
    expect(readDynamicRules()).toHaveLength(2)
    expect(readDynamicRules().map((rule) => rule.condition?.urlFilter)).toEqual([
      '||chatgpt.com^',
      '||openai.com^',
    ])
    expect(readDynamicRules()[0]?.action?.requestHeaders?.[0]?.value).toBe('en-US,en;q=0.9')
  })

  it('🔴 关闭代理时清掉规则', async () => {
    /*
     * 页面侧已经不再注入（`handleTabLoading` 查了 enabled），规则若留着，
     * 就会得到一个「时区是本地的、`Accept-Language` 却是英文」的页面。
     * 那个组合比原样不动更显眼，而且没有任何地方能看出它是我们造成的。
     */
    seedMockStore(SYNC_READY)
    stubProbeWith({ timezone: 'America/Los_Angeles', ip: '1.2.3.4', country: 'US' })
    await handleSyncTimezone()
    expect(readDynamicRules()).toHaveLength(2)

    await handleDisable()

    expect(readDynamicRules()).toHaveLength(0)
  })

  it('🔴 关掉「跟随代理出口」时清掉规则', async () => {
    seedMockStore(SYNC_READY)
    stubProbeWith({ timezone: 'America/Los_Angeles', ip: '1.2.3.4', country: 'US' })
    await handleSyncTimezone()
    expect(readDynamicRules()).toHaveLength(2)

    const response = await handleSaveSettings({ timezoneSyncEnabled: false })

    expect(response.ok).toBe(true)
    expect(readDynamicRules()).toHaveLength(0)
  })

  it('🔴 国家查不到时不留规则，也不注入语言', async () => {
    /*
     * 只改页面语言、不改请求头会造出「头说中文、JS 说英文」的组合 ——
     * 一次请求加一次 JS 执行就能看出来，比两边都不改更糟。
     * 所以模型的推导失败必须让整条语言链路一起退场，而不是降级。
     */
    seedMockStore({
      ...SYNC_READY,
      'lostproxy.settings': {
        ...DEFAULT_SETTINGS,
        timezoneSyncEnabled: true,
        localeSyncEnabled: true,
        timezoneHosts: ['chatgpt.com'],
      },
    })
    stubProbeWith({ timezone: 'Asia/Tokyo', ip: '1.2.3.4' })
    setMockTabs([{ id: 5, url: 'https://chatgpt.com/' }])

    await handleSyncTimezone()

    expect(readDynamicRules()).toHaveLength(0)
    const call = readExecuteScriptCalls()[0]
    expect(call?.args).toEqual([{ zone: 'Asia/Tokyo', locale: null }])
  })

  it('🔴 语言开关关着时只改时区', async () => {
    /*
     * 这是 v0.8.1 把语言拆成独立开关之后的核心行为。
     *
     * 默认就是关的 —— 因为「时区」修的是一个真实的矛盾（出口在洛杉矶、
     * 浏览器报上海），而「语言」是把一项本来不矛盾的东西改掉：中文浏览器
     * 配洛杉矶出口在真实用户里大量存在，本身不算破绽。
     *
     * 关着的时候必须完全不碰请求头：规则一条不留，注入的 locale 为 null。
     * 留一条规则就等于"用户以为关掉了，出站请求还在被改"。
     */
    seedMockStore({
      ...SYNC_READY,
      'lostproxy.settings': {
        ...DEFAULT_SETTINGS,
        timezoneSyncEnabled: true,
        localeSyncEnabled: false,
        timezoneHosts: ['chatgpt.com'],
      },
    })
    stubProbeWith({ timezone: 'America/Los_Angeles', ip: '1.2.3.4', country: 'US' })
    setMockTabs([{ id: 3, url: 'https://chatgpt.com/' }])

    const response = await handleSyncTimezone()

    expect(response.ok).toBe(true)
    expect(readDynamicRules()).toHaveLength(0)
    expect(readExecuteScriptCalls()[0]?.args).toEqual([
      { zone: 'America/Los_Angeles', locale: null },
    ])
  })

  it('🔴 关掉语言开关会撤掉已建立的规则', async () => {
    // 「先开着用了一阵，然后关掉」是最常见的路径，也是残留最容易发生的地方。
    seedMockStore(SYNC_READY)
    stubProbeWith({ timezone: 'America/Los_Angeles', ip: '1.2.3.4', country: 'US' })
    await handleSyncTimezone()
    expect(readDynamicRules()).toHaveLength(2)

    const response = await handleSaveSettings({ localeSyncEnabled: false })

    expect(response.ok).toBe(true)
    expect(readDynamicRules()).toHaveLength(0)
  })

  it('🔴 reconcile 在代理关着时也清理残留规则', async () => {
    /*
     * 残留是真实可能出现的：上一次运行写入了规则，用户随后关掉代理，
     * 而那次清理恰好在 Service Worker 被回收时没跑完。启动时这一步
     * 是唯一的自愈机会 —— 它不能躲在 `if (!enabled) return` 后面。
     */
    seedDynamicRules([
      {
        id: 9100,
        priority: 1,
        action: {
          type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [
            {
              header: 'accept-language',
              operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
              value: 'en-US,en;q=0.9',
            },
          ],
        },
        condition: { urlFilter: '||chatgpt.com' },
      },
    ])
    seedMockStore({
      ...SYNC_READY,
      'lostproxy.enabled': false,
    })

    await reconcile()

    expect(readDynamicRules()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// V0.8.0 自检
// ---------------------------------------------------------------------------

describe('V0.8.0 自检', () => {
  /**
   * 自检要回答的是「为什么没生效」，所以每一条用例都在验同一个问题：
   * **哪一步会先断，报出来的又是哪一句。**
   *
   * 它存在的理由是这个功能的失败全是静默的 —— 不报错、不弹窗，
   * 页面照常打开，只是时区没变。所以这里断言的是 `key`（语义）
   * 而不是拼好的句子：后者会随语言变，前者才是被测对象。
   */

  const READY = {
    'lostproxy.settings': {
      ...DEFAULT_SETTINGS,
      timezoneSyncEnabled: true,
      timezoneHosts: ['chatgpt.com'],
    },
    'lostproxy.enabled': true,
    'lostproxy.timezone': {
      zone: 'Asia/Tokyo',
      country: 'JP',
      locale: 'ja-JP',
      exitIp: '103.1.2.3',
      at: Date.now(),
      node: 'JP-01',
      error: null,
    },
  }

  const keysOf = (steps: readonly { key: string; ok: boolean }[]): string[] =>
    steps.map((step) => step.key)

  it('功能关着时第一步就报出来', async () => {
    seedMockStore({
      'lostproxy.settings': { ...DEFAULT_SETTINGS, timezoneSyncEnabled: false },
    })

    const response = await handleSelfCheck()

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.steps[0]).toMatchObject({ key: 'check.featureOff', ok: false })
  })

  it('清单为空时第二步报出来', async () => {
    seedMockStore({
      'lostproxy.settings': {
        ...DEFAULT_SETTINGS,
        timezoneSyncEnabled: true,
        timezoneHosts: [],
      },
    })

    const response = await handleSelfCheck()

    if (!response.ok) return
    expect(response.data.steps[1]).toMatchObject({ key: 'check.hostsEmpty', ok: false })
  })

  it('🔴 清单里的站点一个都没打开时明说', async () => {
    /*
     * 这一格是自检最容易被写错的地方：直觉上"检查活动标签页"，而用户点
     * 按钮时活动的正是设置页自己 —— 那样永远查不出东西，还会给出一句
     * "这个页面不在清单里"的假结论。
     */
    seedMockStore(READY)
    setMockTabs([{ id: 1, url: 'https://example.com/' }])

    const response = await handleSelfCheck()

    if (!response.ok) return
    expect(response.data.url).toBeNull()
    expect(keysOf(response.data.steps)).toContain('check.noTarget')
  })

  it('全部正常时最后一条是「页面已生效」', async () => {
    seedMockStore(READY)
    setMockTabs([{ id: 7, url: 'https://chatgpt.com/c/1' }])
    setGrantedOrigins(['*://*.chatgpt.com/*'])
    setMockExecuteScriptResult({ timezone: 'Asia/Tokyo', locale: 'ja-JP', language: 'ja' })

    const response = await handleSelfCheck()

    if (!response.ok) return
    const last = response.data.steps.at(-1)
    expect(last).toMatchObject({ key: 'check.applied', ok: true })
    expect(response.data.observed).toMatchObject({ timezone: 'Asia/Tokyo' })
  })

  it('🔴 页面还是老时区时，给出两边的值', async () => {
    /*
     * 这是最常见的一种"没生效"：配置全对，只是改完设置没刷新页面。
     * 只说"没生效"用户不知道该做什么；带上 actual 与 expected，
     * 他立刻知道该刷新。
     */
    seedMockStore(READY)
    setMockTabs([{ id: 7, url: 'https://chatgpt.com/' }])
    setGrantedOrigins(['*://*.chatgpt.com/*'])
    setMockExecuteScriptResult({ timezone: 'Asia/Shanghai', locale: 'zh-CN', language: 'zh-CN' })

    const response = await handleSelfCheck()

    if (!response.ok) return
    const last = response.data.steps.at(-1)
    expect(last).toMatchObject({
      key: 'check.needsReload',
      ok: false,
      params: { actual: 'Asia/Shanghai', expected: 'Asia/Tokyo' },
    })
  })

  it('🔴 没有权限时不去读页面', async () => {
    /*
     * 没权限还去 executeScript 只会得到一个被 catch 掉的异常，
     * 而"读不到"会被误报成一条独立的问题 —— 真正的原因是权限。
     */
    seedMockStore(READY)
    setMockTabs([{ id: 7, url: 'https://chatgpt.com/' }])

    const response = await handleSelfCheck()

    if (!response.ok) return
    expect(keysOf(response.data.steps)).toContain('check.notPermitted')
    expect(response.data.observed).toBeNull()
    expect(readExecuteScriptCalls()).toHaveLength(0)
  })
})
