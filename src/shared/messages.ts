/**
 * Popup / Options ↔ Service Worker 的消息协议。
 *
 * 架构铁律（技术方案 §29.12 / Task 05）：
 *   Service Worker 是**唯一控制入口**。
 *   Popup 与 Options 不直接调用 chrome.proxy / chrome.privacy / fetch，
 *   只能通过本文件定义的消息表达意图。
 *
 * 用 discriminated union 而不是字符串常量 + any payload，
 * 是为了让「消息类型」与「所需参数」在编译期绑定——
 * 加一种消息时忘了处理，tsc 会直接报错。
 */

import type {
  NormalizedError,
  ProviderView,
  ProxyGroup,
  Settings,
  SettingsView,
  StatusSnapshot,
} from './types'

/** 从 UI 发往 Service Worker 的请求。 */
export type Request =
  /** 采集完整运行时快照（含实时探活与 levelOfControl 查询）。 */
  | { readonly type: 'GET_STATUS' }
  /**
   * 开启代理。
   * 注意：即使 Core 不可达也会照常写入代理设置（fail-closed，见 ADR-03），
   * 此时响应里带 CORE_OFFLINE 错误，但代理**确实是开着的**。
   */
  | { readonly type: 'ENABLE_PROXY' }
  /** 关闭代理，恢复浏览器直连。 */
  | { readonly type: 'DISABLE_PROXY' }
  /** 只做一次 Controller 探活，不改动任何设置。用于 Settings 页的 [Test Mihomo]。 */
  | { readonly type: 'TEST_CORE' }
  /**
   * 用户显式确认并清除当前告警。
   *
   * 存在的理由只有一个：`PROXY_LEAK_SUSPECTED` 记录的是「已经发生过直连」
   * 这个事实，不能自动消失（architecture.md ADR-22）。
   * 既然不能自动消失，就必须给用户一条把它关掉的路——
   * 否则告警会成为永久噪音，而用户最终会学会无视所有告警。
   */
  | { readonly type: 'DISMISS_ERROR' }
  /** 保存设置。部分字段更新，未提供的字段保持原值。 */
  | { readonly type: 'SAVE_SETTINGS'; readonly patch: Partial<Settings> }
  /**
   * V0.2：拉取全部策略组，供 Settings 页选主策略组。
   *
   * 与 GET_STATUS 里顺带返回的 `group` 分开：那个只返回**已选中的那一个**组，
   * 而这里要的是**全部**组的列表。让 GET_STATUS 每次都拉全量会给每次开 Popup
   * 都加一次不必要的请求，而选组是一次性动作。
   */
  | { readonly type: 'LIST_GROUPS' }
  /**
   * V0.2：切换主策略组的选中节点。
   *
   * ⚠️ 这个操作会改动**内核的全局状态**，效果不限于本浏览器
   *    （architecture.md ADR-28）。它是本项目第一个逸出浏览器边界的操作，
   *    UI 必须对此有明示。
   */
  | { readonly type: 'SELECT_NODE'; readonly node: string }
  /**
   * V0.3：对主策略组测速。
   *
   * 刻意是显式消息而非 GET_STATUS 的一部分：一次全量测速会让内核同时向
   * 几十个节点建连，绝不能绑在"打开 Popup"这个高频动作上（§17 / ADR-32）。
   */
  | { readonly type: 'TEST_LATENCY' }
  /** V0.6：列出订阅。 */
  | { readonly type: 'LIST_PROVIDERS' }
  /** V0.6：更新指定订阅。这是 V0.6 唯一的写操作。 */
  | { readonly type: 'UPDATE_PROVIDER'; readonly name: string }
  /**
   * 探测 Controller 端口。
   *
   * 「端口填错」是开发期间实测的头号失败原因，而它的症状完全不指向真实原因。
   * 逐个试一个由已知客户端默认值构成的**白名单**（不是扫描范围）。
   */
  | { readonly type: 'PROBE_PORT' }

/** 消息类型字面量，便于运行时穷举校验。 */
export type RequestType = Request['type']

/**
 * Service Worker 的响应。
 *
 * 统一 ok/error 信封而不是抛异常：chrome.runtime.sendMessage 无法跨边界传递
 * Error 对象，异常会退化成 `undefined` 响应，反而更难排查。
 */
export type Response<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: NormalizedError }

/** 各消息对应的成功返回类型。 */
export interface ResponsePayloads {
  GET_STATUS: StatusSnapshot
  ENABLE_PROXY: StatusSnapshot
  DISABLE_PROXY: StatusSnapshot
  TEST_CORE: { online: boolean; version: string | null }
  DISMISS_ERROR: StatusSnapshot
  /** 返回视图而非 Settings —— 响应里同样不带 secret 明文。 */
  SAVE_SETTINGS: SettingsView
  LIST_GROUPS: { groups: readonly ProxyGroup[] }
  /** 切换后返回新快照，UI 直接用它重绘，不必再发一次 GET_STATUS。 */
  SELECT_NODE: StatusSnapshot
  /** 测速后返回新快照，其中 group.latency 已是最新值。 */
  TEST_LATENCY: StatusSnapshot
  LIST_PROVIDERS: { providers: readonly ProviderView[] }
  /** 更新完返回刷新后的列表，UI 直接用它重绘（节点数可能变了）。 */
  UPDATE_PROVIDER: { providers: readonly ProviderView[] }
  /** 探到的端口；null 表示候选全部试过都没有。 */
  PROBE_PORT: { port: number | null }
}

/** 给定请求类型，推导出其响应类型。 */
export type ResponseFor<K extends RequestType> = Response<ResponsePayloads[K]>

/**
 * 类型安全的消息发送封装，供 Popup / Options 使用。
 *
 * 之所以放在 shared/ 而不是 popup/：Options 页也要用同一套调用方式，
 * 复制两份必然会漂移。
 */
export async function sendMessage<K extends RequestType>(
  request: Extract<Request, { type: K }>,
): Promise<ResponseFor<K>> {
  return (await chrome.runtime.sendMessage(request)) as ResponseFor<K>
}
