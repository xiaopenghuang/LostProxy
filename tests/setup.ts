/**
 * Vitest 全局 setup —— 提供 chrome.* API 的内存 mock。
 *
 * 设计要点：
 *
 * 1. `chrome.storage.local` 与 ChromeSetting（proxy / privacy）都是**真实工作的
 *    内存实现**，而不是 vi.fn() 断言调用次数。
 *    后者测的是「代码怎么写的」，前者测的是「代码做对了没有」。
 *
 * 2. `chrome.storage.sync` 被刻意做成**一碰就抛错**。
 *    security.md §2.1 规定 Controller Secret 绝不能进 sync storage（会同步到云端）。
 *    这道护栏让「不小心用了 sync」在测试阶段就炸掉，
 *    而不是等到用户凭据已经上云才发现。
 *
 * 3. ChromeSetting mock 保留 setCalls / clearCalls 的完整轨迹。
 *    这让「关闭代理必须用 clear() 而不是 set(direct)」这类**语义**约束
 *    （architecture.md ADR-18）能被断言，而不只是靠代码审查。
 *
 * 4. 每个测试前自动重置全部状态。
 */

import { beforeEach } from 'vitest'
import type { LevelOfControl } from '../src/shared/types'

// ---------------------------------------------------------------------------
// storage.local
// ---------------------------------------------------------------------------

type Store = Record<string, unknown>

let store: Store = {}

/** 读出 mock storage 的当前内容（副本），供断言使用。 */
export function readMockStore(): Store {
  return { ...store }
}

/** 预置 mock storage 内容，用于构造「已有旧数据」的场景。 */
export function seedMockStore(data: Store): void {
  store = { ...data }
}

/** 复刻 chrome.storage.local.get() 的多形态参数语义。 */
function pick(keys?: string | string[] | Store | null): Store {
  if (keys === null || keys === undefined) return { ...store }

  if (typeof keys === 'string') {
    return keys in store ? { [keys]: store[keys] } : {}
  }

  if (Array.isArray(keys)) {
    const out: Store = {}
    for (const key of keys) {
      if (key in store) out[key] = store[key]
    }
    return out
  }

  // object 形态：键为字段名，值为该字段缺失时的默认值。
  const out: Store = {}
  for (const [key, fallback] of Object.entries(keys)) {
    out[key] = key in store ? store[key] : fallback
  }
  return out
}

const localArea = {
  get: async (keys?: string | string[] | Store | null): Promise<Store> => pick(keys),
  set: async (items: Store): Promise<void> => {
    Object.assign(store, items)
  },
  remove: async (keys: string | string[]): Promise<void> => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete store[key]
    }
  },
  clear: async (): Promise<void> => {
    store = {}
  },
}

const FORBIDDEN_SYNC =
  'chrome.storage.sync is forbidden in LostProxy: Controller Secret must never be synced to the cloud (security.md §2.1)'

const syncArea = {
  get: async (): Promise<never> => {
    throw new Error(FORBIDDEN_SYNC)
  },
  set: async (): Promise<never> => {
    throw new Error(FORBIDDEN_SYNC)
  },
  remove: async (): Promise<never> => {
    throw new Error(FORBIDDEN_SYNC)
  },
  clear: async (): Promise<never> => {
    throw new Error(FORBIDDEN_SYNC)
  },
}

// ---------------------------------------------------------------------------
// ChromeSetting（chrome.proxy.settings / chrome.privacy.network.*）
// ---------------------------------------------------------------------------

type Scope = chrome.types.ChromeSettingScope | undefined

/** 一个 ChromeSetting 的可观测 mock 状态。 */
export interface SettingMock<T> {
  value: T | undefined
  levelOfControl: LevelOfControl
  /** 每次 set() 的完整参数轨迹。 */
  setCalls: Array<{ value: T; scope: Scope }>
  /** 每次 clear() 的完整参数轨迹。 */
  clearCalls: Array<{ scope: Scope }>
  /** 置入一个 Error 让下一次 get() 抛错，用于测「查询失败」分支。 */
  failNextGet: Error | null
  /** 置入一个 Error 让下一次 set() 抛错。 */
  failNextSet: Error | null
  /** 置入一个 Error 让下一次 clear() 抛错。 */
  failNextClear: Error | null
}

function freshSettingMock<T>(): SettingMock<T> {
  return {
    value: undefined,
    // 默认「本扩展可以控制」——即干净的初始环境。
    levelOfControl: 'controllable_by_this_extension',
    setCalls: [],
    clearCalls: [],
    failNextGet: null,
    failNextSet: null,
    failNextClear: null,
  }
}

function resetSettingMock<T>(mock: SettingMock<T>): void {
  Object.assign(mock, freshSettingMock<T>())
}

function makeSettingApi<T>(mock: SettingMock<T>) {
  return {
    get: async (_details: chrome.types.ChromeSettingGetDetails) => {
      if (mock.failNextGet) {
        const error = mock.failNextGet
        mock.failNextGet = null
        throw error
      }
      return { value: mock.value as T, levelOfControl: mock.levelOfControl }
    },

    set: async (details: { value: T; scope?: chrome.types.ChromeSettingScope }) => {
      if (mock.failNextSet) {
        const error = mock.failNextSet
        mock.failNextSet = null
        throw error
      }
      mock.setCalls.push({ value: details.value, scope: details.scope })
      mock.value = details.value
      // 真实行为：写入成功后本扩展即成为控制方。
      mock.levelOfControl = 'controlled_by_this_extension'
    },

    clear: async (details: chrome.types.ChromeSettingClearDetails) => {
      if (mock.failNextClear) {
        const error = mock.failNextClear
        mock.failNextClear = null
        throw error
      }
      mock.clearCalls.push({ scope: details.scope })
      mock.value = undefined
      // 真实行为：清除后回到「可控但未控制」。
      mock.levelOfControl = 'controllable_by_this_extension'
    },

    onChange: {
      addListener: (): void => {},
      removeListener: (): void => {},
      hasListener: (): boolean => false,
    },
  }
}

/** chrome.proxy.settings 的 mock 状态。 */
export const proxySetting: SettingMock<chrome.proxy.ProxyConfig> =
  freshSettingMock<chrome.proxy.ProxyConfig>()

/** chrome.privacy.network.webRTCIPHandlingPolicy 的 mock 状态。 */
export const webRtcSetting: SettingMock<string> = freshSettingMock<string>()

// ---------------------------------------------------------------------------
// chrome.proxy.onProxyError
// ---------------------------------------------------------------------------

type ProxyErrorListener = (details: chrome.proxy.ErrorDetails) => void

let proxyErrorListeners: ProxyErrorListener[] = []

/** 已注册的 onProxyError 监听器数量，用于断言注册发生过。 */
export function proxyErrorListenerCount(): number {
  return proxyErrorListeners.length
}

/** 模拟浏览器抛出一次代理错误事件。 */
export function emitProxyError(details: chrome.proxy.ErrorDetails): void {
  for (const listener of proxyErrorListeners) {
    listener(details)
  }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

const chromeMock = {
  storage: {
    local: localArea,
    sync: syncArea,
  },
  proxy: {
    settings: makeSettingApi(proxySetting),
    onProxyError: {
      addListener: (listener: ProxyErrorListener): void => {
        proxyErrorListeners.push(listener)
      },
      removeListener: (listener: ProxyErrorListener): void => {
        proxyErrorListeners = proxyErrorListeners.filter((item) => item !== listener)
      },
      hasListener: (listener: ProxyErrorListener): boolean =>
        proxyErrorListeners.includes(listener),
    },
  },
  privacy: {
    network: {
      webRTCIPHandlingPolicy: makeSettingApi(webRtcSetting),
    },
  },
  runtime: {
    lastError: undefined as { message?: string } | undefined,
  },
}

// @types/chrome 的 typeof chrome 覆盖面远大于测试所需，
// 这里只实现被测代码实际用到的部分，故走一次显式断言。
globalThis.chrome = chromeMock as unknown as typeof chrome

beforeEach(() => {
  store = {}
  resetSettingMock(proxySetting)
  resetSettingMock(webRtcSetting)
  proxyErrorListeners = []
})
