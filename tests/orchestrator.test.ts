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
  handleMessage,
  handleSaveSettings,
  handleTestCore,
  pickError,
  reconcile,
} from '../src/background/orchestrator'
import type { ProxyInspection } from '../src/background/proxy'
import { errors } from '../src/shared/errors'
import {
  getEnabledState,
  getLastError,
  saveSettings,
  setEnabledState,
  setLastError,
} from '../src/background/storage'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { LevelOfControl, NormalizedError } from '../src/shared/types'
import { proxySetting, webRtcSetting } from './setup'

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
function stubCore(groups: readonly unknown[] = []): void {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    fetchedUrls.push(url)
    if (url.endsWith('/version')) return Promise.resolve(json({ meta: true, version: 'v1.19.0' }))
    if (url.endsWith('/group')) return Promise.resolve(json({ proxies: groups }))
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
