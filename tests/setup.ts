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
// chrome.scripting / tabs / permissions（V0.9 时区同步）
// ---------------------------------------------------------------------------

/** 一次 executeScript 的完整参数轨迹 —— 与 setCalls 同样的思路：记语义，不只记次数。 */
export interface ExecuteScriptCall {
  target: unknown
  world?: string
  injectImmediately?: boolean
  func?: unknown
  args?: unknown[]
}

let executeScriptCalls: ExecuteScriptCall[] = []
let executeScriptError: Error | null = null
/**
 * 下一次 executeScript 的返回值。
 *
 * 自检会读页面的实际值（时区/语言），而"读到什么"必须由测试决定 ——
 * 否则只能验"有没有调用"，验不了"拿到结果之后怎么判断"。
 * 默认不设置时仍然返回空数组，与旧行为一致。
 */
let executeScriptResult: unknown = undefined
let hasExecuteScriptResult = false
let mockTabs: chrome.tabs.Tab[] = []
let grantedOrigins: string[] = []

/**
 * DNR 动态规则的模拟存储（V0.10 请求头同步）。
 *
 * 存取都走一次 JSON 深拷贝，模仿真实 API 的**结构化克隆**语义：
 * 若直接把同一个可变对象交出去，被测代码对返回值的任何就地修改都会
 * 悄悄改掉"浏览器里"的规则 —— 而那恰好会掩盖我们最想测的一类 bug
 * （对齐逻辑建立在"读回来的是一份独立副本"这个前提上）。
 */
let dynamicRules: chrome.declarativeNetRequest.Rule[] = []

/** 浏览器里当前生效的动态规则，供断言规则是否被正确建立与清除。 */
export function readDynamicRules(): readonly chrome.declarativeNetRequest.Rule[] {
  return dynamicRules
}

/** 手动塞入规则，模拟"上一次运行留下的残留"。 */
export function seedDynamicRules(rules: chrome.declarativeNetRequest.Rule[]): void {
  dynamicRules = JSON.parse(JSON.stringify(rules)) as chrome.declarativeNetRequest.Rule[]
}

/** 已发生的 executeScript 调用，供断言注入目标与时区参数。 */
export function readExecuteScriptCalls(): readonly ExecuteScriptCall[] {
  return executeScriptCalls
}

/** 置入一个 Error 让下一次 executeScript 抛错（模拟缺权限）。 */
export function failNextExecuteScript(error: Error | null): void {
  executeScriptError = error
}

/** 置入 executeScript 的返回值（`results[0].result`）。 */
export function setMockExecuteScriptResult(value: unknown): void {
  executeScriptResult = value
  hasExecuteScriptResult = true
}

/**
 * 预置 chrome.tabs.query 的返回。
 *
 * 参数放宽成 `Partial<Tab>`：被测代码只读 `id` 与 `url`，让每个用例去补
 * 十几个与该用例无关的必填字段，只会把断言想表达的东西埋掉。
 */
export function setMockTabs(tabs: Array<Partial<chrome.tabs.Tab>>): void {
  mockTabs = tabs as chrome.tabs.Tab[]
}

/**
 * 预置已授予的 origin 列表。
 *
 * 与真实 API 一致地做**全包含**判断：`contains({origins})` 只有在
 * 每一个 origin 都已被授予时才返回 true。
 */
export function setGrantedOrigins(origins: string[]): void {
  grantedOrigins = [...origins]
}

/** 当前已授予的 origin（供断言 request() 是否真的登记了权限）。 */
export function readGrantedOrigins(): readonly string[] {
  return grantedOrigins
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
  scripting: {
    executeScript: async (details: ExecuteScriptCall): Promise<unknown[]> => {
      if (executeScriptError !== null) {
        const error = executeScriptError
        executeScriptError = null
        throw error
      }
      executeScriptCalls.push(details)
      return hasExecuteScriptResult ? [{ result: executeScriptResult }] : []
    },
  },
  tabs: {
    query: async (): Promise<chrome.tabs.Tab[]> => mockTabs,
  },
  permissions: {
    contains: async (details: { origins?: string[] }): Promise<boolean> => {
      const origins = details.origins ?? []
      return origins.every((origin) => grantedOrigins.includes(origin))
    },
    request: async (details: { origins?: string[] }): Promise<boolean> => {
      const origins = details.origins ?? []
      grantedOrigins = [...new Set([...grantedOrigins, ...origins])]
      return true
    },
  },
  declarativeNetRequest: {
    getDynamicRules: async (): Promise<chrome.declarativeNetRequest.Rule[]> =>
      JSON.parse(JSON.stringify(dynamicRules)) as chrome.declarativeNetRequest.Rule[],
    updateDynamicRules: async (options: {
      removeRuleIds?: number[]
      addRules?: chrome.declarativeNetRequest.Rule[]
    }): Promise<void> => {
      const remove = new Set(options.removeRuleIds ?? [])
      const kept = dynamicRules.filter((rule) => !remove.has(rule.id))
      const added = (options.addRules ?? []).map(
        (rule) => JSON.parse(JSON.stringify(rule)) as chrome.declarativeNetRequest.Rule,
      )
      dynamicRules = [...kept, ...added]
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
  executeScriptCalls = []
  executeScriptError = null
  executeScriptResult = undefined
  hasExecuteScriptResult = false
  mockTabs = []
  grantedOrigins = []
  dynamicRules = []
})
