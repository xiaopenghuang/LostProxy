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

/**
 * `browser.permissions` 的可控状态（可选主机权限）。
 *
 * 分成 `granted` 与 `willGrant` 两个旋钮，因为它们对应两件不同的事：
 *   - `granted`   → `contains()` 的答案，也就是"现在有没有"
 *   - `willGrant` → `request()` 弹窗时用户会不会点同意
 *
 * 合成一个的话就没法测「弹窗后用户同意，于是从没有变成有」这条路径 ——
 * 而那正是最常见的真实流程。
 */
export const ffPermissions = {
  /** `contains()` 返回什么。 */
  granted: false,
  /** `request()` 弹窗的结果。 */
  willGrant: true,
  /** 置入 Error 让下一次 contains() 抛错。 */
  failNextContains: null as Error | null,
  /** 置入 Error 让下一次 request() 抛错（模拟无用户手势）。 */
  failNextRequest: null as Error | null,
  containsCalls: 0,
  requestCalls: 0,
}

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

/** `proxy.onRequest` 的监听签名。 */
export type RequestListener = (details: { url: string }) => unknown

let requestListeners: Array<{ listener: RequestListener; filter: { urls: string[] } }> = []

/** 已注册的 onRequest 监听数量。 */
export function ffRequestListenerCount(): number {
  return requestListeners.length
}

/** 最近注册的那个监听所用的过滤器 —— 用于断言它是 `<all_urls>`。 */
export function ffRequestFilter(): { urls: string[] } | null {
  return requestListeners.at(-1)?.filter ?? null
}

/**
 * 清空浏览器侧的监听列表，**不通知扩展**。
 *
 * 用于模拟「事件页被卸载重建、监听没了，而模块里的缓存还留着」——
 * 那种不一致会让一个信任缓存的实现静默失去分流能力。
 */
export function clearFirefoxRequestListeners(): void {
  requestListeners = []
}

/** 设为 false 模拟 `proxy.onRequest` 不可用（没拿到 `<all_urls>`）。 */
export const ffOnRequestPresent = { value: true }

/** `permissions.onAdded` / `onRemoved` 上挂着的监听。 */
const permissionListeners: { added: Array<() => void>; removed: Array<() => void> } = {
  added: [],
  removed: [],
}

/**
 * 模拟用户在设置页或 about:addons 里**授予**了权限。
 *
 * 同时改 `granted` 与触发事件 —— 真机上这两件事是一起发生的，
 * 拆开会让测试能通过一个现实中不存在的状态组合。
 */
export function grantFirefoxPermission(): void {
  ffPermissions.granted = true
  for (const listener of permissionListeners.added) listener()
}

/** 模拟用户**撤销**了权限（about:addons 的权限页）。 */
export function revokeFirefoxPermission(): void {
  ffPermissions.granted = false
  for (const listener of permissionListeners.removed) listener()
}

/** 有没有挂上权限变更监听。用于验「授权后会重挂分流监听」这条路存在。 */
export function ffPermissionListenerCounts(): { added: number; removed: number } {
  return { added: permissionListeners.added.length, removed: permissionListeners.removed.length }
}

/** 模拟这两个事件 API 不存在（旧版 Firefox / 权限没声明）。 */
export const ffPermissionEventsPresent = { value: true }

/**
 * 模拟浏览器对一个 URL 询问「走代理还是直连」。
 *
 * 返回**第一个非空**答案，照 Firefox 对多个 onRequest 监听的语义
 * （"第一个返回非空的赢"）。这样"同时挂了两个监听"这种 bug
 * 在测试里会以"用了旧配置"的形式暴露出来。
 *
 * 全都不表态时返回 null —— 对应"浏览器按 proxy.settings 处理"。
 *
 * ⚠️ 是 async：监听可以返回 Promise（MDN 明确允许），
 *    而本项目的 Firefox 监听确实返回 Promise，因为它要现读 storage。
 */
export async function askFirefoxRouter(url: string): Promise<unknown> {
  for (const { listener } of requestListeners) {
    const answer = await listener({ url })
    if (answer !== undefined && answer !== null) return answer
  }
  return null
}

/**
 * 取第一个监听的**原始**返回值，不做 null 归一。
 *
 * 用来区分 `undefined`（不表态，让浏览器自己的设置生效）与
 * `{type:'direct'}`（强制直连）—— 两者在 `askFirefoxRouter` 眼里都是"空"，
 * 但语义完全不同：后者会越权覆盖用户自己配的系统代理（ADR-18）。
 */
export async function ffRawRouterAnswer(url: string): Promise<unknown> {
  const first = requestListeners[0]
  if (first === undefined) return null
  return first.listener({ url })
}

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
  requestListeners = []
  permissionListeners.added = []
  permissionListeners.removed = []
  ffPermissionEventsPresent.value = true
  Object.assign(ffProxySetting, freshMock<FirefoxProxyValue>())
  Object.assign(ffWebRtcSetting, freshMock<string>())
  ffIncognito.allowed = true
  ffIncognito.failNext = null
  ffIncognito.missing = false
  ffIncognito.calls = 0
  ffOnErrorPresent.value = true
  ffOnRequestPresent.value = true
  /*
   * 默认**已授权**。
   *
   * 与 `ffIncognito.allowed = true` 同一个考虑：默认值该是"一切正常"，
   * 让每条测试只需要设置它关心的那个偏离项。若默认是未授权，
   * 每条测跟权限无关的测试都得先加一行授权，那种噪音会掩盖真正的意图。
   */
  ffPermissions.granted = true
  ffPermissions.willGrant = true
  ffPermissions.failNextContains = null
  ffPermissions.failNextRequest = null
  ffPermissions.containsCalls = 0
  ffPermissions.requestCalls = 0

  const proxyApi: Record<string, unknown> = {
    settings: makeSettingApi(ffProxySetting),
  }

  /*
   * onRequest 与 onError 都用 getter，这样测试可以在装好 mock 之后再决定
   * 「这个 API 存不存在」—— 对应没拿到可选权限、或 manifest 漏权限的场景。
   */
  Object.defineProperty(proxyApi, 'onRequest', {
    get: () =>
      ffOnRequestPresent.value
        ? {
            addListener: (listener: RequestListener, filter: { urls: string[] }): void => {
              requestListeners.push({ listener, filter })
            },
            removeListener: (listener: RequestListener): void => {
              requestListeners = requestListeners.filter((r) => r.listener !== listener)
            },
          }
        : undefined,
    configurable: true,
  })

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
    permissions: {
      contains: async (): Promise<boolean> => {
        ffPermissions.containsCalls += 1
        if (ffPermissions.failNextContains) {
          const error = ffPermissions.failNextContains
          ffPermissions.failNextContains = null
          throw error
        }
        return ffPermissions.granted
      },
      /*
       * ⚠️ 刻意保留 `request`，尽管平台层已经不该调它了。
       *
       * 留着它才能验「平台层**没有**调用 request」这条断言 ——
       * 若 mock 里根本没这个方法，那条断言会因为"方法不存在"
       * 而非"没被调用"通过，等于没测。`requestCalls` 是那条测试的判据。
       *
       * 真机上这个调用在背景脚本里会抛
       * "may only be called from a user input handler"，
       * 而 mock 无法模拟手势，所以这里的实现只是让计数器动起来。
       */
      request: async (): Promise<boolean> => {
        ffPermissions.requestCalls += 1
        if (ffPermissions.failNextRequest) {
          const error = ffPermissions.failNextRequest
          ffPermissions.failNextRequest = null
          throw error
        }
        // 真实行为：用户同意后权限就真的有了。
        if (ffPermissions.willGrant) ffPermissions.granted = true
        return ffPermissions.willGrant
      },
      /*
       * 🔴 `onAdded` / `onRemoved` —— 用户授权/撤销时 Firefox 通知扩展的唯一途径。
       *
       * MDN（optional_host_permissions 页）：
       *   > listen for `permissions.onAdded` and `permissions.onRemoved`
       *   > to know when a user grants or revokes permissions
       *
       * 建模它们是必需的，因为没有它们就测不出此方犯过的那个错：
       * 原先的代码假定"授权后 Firefox 会重启扩展"，于是授权之后
       * 分流监听永远挂不上，而用户的直连清单被静默忽略。
       */
      get onAdded() {
        return ffPermissionEventsPresent.value
          ? {
              addListener: (listener: () => void): void => {
                permissionListeners.added.push(listener)
              },
            }
          : undefined
      },
      get onRemoved() {
        return ffPermissionEventsPresent.value
          ? {
              addListener: (listener: () => void): void => {
                permissionListeners.removed.push(listener)
              },
            }
          : undefined
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
