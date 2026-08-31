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

import type { Settings, SettingsView, StatusSnapshot, NormalizedError } from './types'

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
