/**
 * Firefox 形状的 `chrome.*` mock。
 *
 * ## 为什么不复用 tests/setup.ts
 *
 * `setup.ts` 的 ChromeSetting mock 是按 **Chromium** 的形状写的：
 * `set()` 收 `{value, scope}`、`clear()` 收 `{scope}`、事件叫 `onProxyError`
 * 且带 `fatal`。Firefox 的对应物一个都不长这样。
 *
 * 用同一个 mock 测两个平台，会让**平台差异在测试里被抹平** ——
 * 而抹平差异恰好是这一层要防的那件事。举个具体的：若 Firefox 实现
 * 误传了 `scope` 参数，Chromium 形状的 mock 会照单全收、测试全绿，
 * 而真实的 Firefox 会忽略它（或在将来的版本里报错）。
 *
 * 所以这里独立一份，且**刻意只实现 Firefox 真有的东西**：
 * 没有 `scope`、没有 `onProxyError`、`set()` 的参数对象里多一个字段就说明写错了。
 *
 * ## 记录的是「Firefox 会看到什么」
 *
 * 每次 `set()` 的完整参数都被存下来，包括我们**不该**传的字段。
 * 这样「不许传 scope」才能被断言，而不是靠读代码确认。
 */

import type { LevelOfControl } from '../src/shared/types'

/** Firefox `proxy.settings` 的值对象（只列本项目会碰到的字段）。 */
export interface FirefoxProxyValue {
  proxyType?: string
  http?: string
  httpProxyAll?: boolean
  ssl?: string
  socks?: string
  passthrough?: string
  autoConfigUrl?: string
}

/** 一次 set() 调用的完整实参 —— 含我们不该传的字段，以便断言"没传"。 */
export interface SetCall<T> {
  value: T
  /**
   * Firefox 的 `set()` **没有** scope 参数。
   *
   * 这里仍然记录它，是为了让「Firefox 实现误传了 scope」能被断言出来 ——
   * 若这个字段不为 undefined，说明实现照抄了 Chromium 的调用形状。
   */
  scope: unknown
  /** 除 value 之外的全部键，用于断言没有多余字段。 */
  extraKeys: string[]
}

export interface FirefoxSettingMock<T> {
  value: T | undefined
  levelOfControl: LevelOfControl
  setCalls: Array<SetCall<T>>
  clearCalls: Array<{ extraKeys: string[] }>
  failNextGet: Error | null
  failNextSet: Error | null
  failNextClear: Error | null
}

function freshMock<T>(): FirefoxSettingMock<T> {
  return {
    value: undefined,
    levelOfControl: 'controllable_by_this_extension',
    setCalls: [],
    clearCalls: [],
    failNextGet: null,
    failNextSet: null,
    failNextClear: null,
  }
}

function makeSettingApi<T>(mock: FirefoxSettingMock<T>) {
  return {
    get: async () => {
      if (mock.failNextGet) {
        const error = mock.failNextGet
        mock.failNextGet = null
        throw error
      }
      return { value: mock.value as T, levelOfControl: mock.levelOfControl }
    },

    set: async (details: Record<string, unknown>) => {
      if (mock.failNextSet) {
        const error = mock.failNextSet
        mock.failNextSet = null
        throw error
      }
      mock.setCalls.push({
        value: details.value as T,
        scope: details.scope,
        extraKeys: Object.keys(details).filter((k) => k !== 'value'),
      })
      mock.value = details.value as T
      mock.levelOfControl = 'controlled_by_this_extension'
    },

    clear: async (details: Record<string, unknown>) => {
      if (mock.failNextClear) {
        const error = mock.failNextClear
        mock.failNextClear = null
        throw error
      }
      mock.clearCalls.push({ extraKeys: Object.keys(details) })
      mock.value = undefined
      mock.levelOfControl = 'controllable_by_this_extension'
    },
  }
}

/** Firefox `proxy.settings` 的 mock 状态。 */
export const ffProxySetting: FirefoxSettingMock<FirefoxProxyValue> =
  freshMock<FirefoxProxyValue>()

/** Firefox `privacy.network.webRTCIPHandlingPolicy` 的 mock 状态。 */
export const ffWebRtcSetting: FirefoxSettingMock<string> = freshMock<string>()

/** `extension.isAllowedIncognitoAccess()` 的可控返回。 */
export const ffIncognito = {
  /** 用户是否已授予隐私窗口访问权。 */
  allowed: true,
  /** 置入 Error 让下一次查询抛错，用于测「探测失败」分支。 */
  failNext: null as Error | null,
  /** 设为 true 模拟「这个 API 根本不存在」。 */
  missing: false,
  calls: 0,
}

type ErrorListener = (error: unknown) => void

let errorListeners: ErrorListener[] = []

/** 已注册的 proxy.onError 监听器数量。 */
export function ffErrorListenerCount(): number {
  return errorListeners.length
}

/** 模拟 Firefox 抛出一次 proxy.onError。注意它**没有 fatal 字段**。 */
export function emitFirefoxProxyError(error: unknown): void {
  for (const listener of errorListeners) listener(error)
}

/** 设为 false 模拟 manifest 漏了 proxy 权限（onError 不存在）。 */
export const ffOnErrorPresent = { value: true }

/**
 * 装上 Firefox 形状的全局 `chrome`。
 *
 * 由调用方在 `beforeEach` 里显式调用 —— 不做成全局 setup，
 * 因为它会覆盖 `tests/setup.ts` 装的 Chromium mock，
 * 而其余 12 个测试文件全都依赖后者。
 */
export function installFirefoxMock(): void {
  errorListeners = []
  Object.assign(ffProxySetting, freshMock<FirefoxProxyValue>())
  Object.assign(ffWebRtcSetting, freshMock<string>())
  ffIncognito.allowed = true
  ffIncognito.failNext = null
  ffIncognito.missing = false
  ffIncognito.calls = 0
  ffOnErrorPresent.value = true

  const proxyApi: Record<string, unknown> = {
    settings: makeSettingApi(ffProxySetting),
  }

  /*
   * onError 用 getter 而不是固定值，这样测试可以在装好 mock 之后
   * 再决定"这个事件存不存在" —— 对应 manifest 漏权限的场景。
   */
  Object.defineProperty(proxyApi, 'onError', {
    get: () =>
      ffOnErrorPresent.value
        ? {
            addListener: (listener: ErrorListener): void => {
              errorListeners.push(listener)
            },
          }
        : undefined,
    configurable: true,
  })

  const firefoxChrome = {
    proxy: proxyApi,
    privacy: {
      network: {
        webRTCIPHandlingPolicy: makeSettingApi(ffWebRtcSetting),
      },
    },
    extension: {
      isAllowedIncognitoAccess: async (): Promise<boolean> => {
        ffIncognito.calls += 1
        if (ffIncognito.failNext) {
          const error = ffIncognito.failNext
          ffIncognito.failNext = null
          throw error
        }
        return ffIncognito.allowed
      },
    },
  }

  if (ffIncognito.missing) {
    Reflect.deleteProperty(firefoxChrome, 'extension')
  }

  globalThis.chrome = firefoxChrome as unknown as typeof chrome
}

/**
 * 让 `extension` 命名空间整个消失，模拟 API 不存在。
 *
 * 单独一个函数而不是 `installFirefoxMock` 的参数：这是个罕见分支，
 * 做成参数会让每个调用点都要传一个几乎总是 false 的布尔值。
 */
export function removeIncognitoApi(): void {
  Reflect.deleteProperty(globalThis.chrome as unknown as Record<string, unknown>, 'extension')
}
