/**
 * 规范化错误的构造与标准文案。
 *
 * 文案本身住在 shared/i18n.ts。本文件只负责把「什么情况」映射到
 * 「哪个文案 key + 哪些参数」，不产出成品字符串。
 *
 * 为什么这样分工：
 *   1. 错误会被持久化（`lastError` 进 chrome.storage.local）。存 key 而不是
 *      成品文案，用户切换语言后旧告警才会跟着变，而不是卡在旧语言里；
 *   2. background 因此**不需要知道用户选了什么语言**，翻译全在 UI 层；
 *   3. 「文案里绝不出现 Controller Secret」这条约束（security.md §2.3）
 *      有一个可单点审计的位置。
 *
 * ⚠️ 新增错误时必须自问：params 里会不会带进 secret 或订阅 URL？
 */

import { translate, type MessageKey, type MessageParams } from './i18n'
import type { ErrorCode, NormalizedError, ValidationIssue } from './types'

/**
 * 构造一条带时间戳的规范化错误。
 *
 * `message` 由 key 生成英文文案作为日志兜底 —— 这样它永远与英文字典一致，
 * 不会出现「改了字典忘了改兜底」的漂移。
 */
export function makeError(
  code: ErrorCode,
  key: MessageKey,
  params?: MessageParams,
): NormalizedError {
  return { code, key, params, message: translate('en', key, params), at: Date.now() }
}

export const errors = {
  /**
   * 技术方案 §22 Case 3 / §24：代理设置被优先级更高的扩展控制。
   * 明确告知「不会强行覆盖」，因为强行覆盖需要重装本扩展来抢优先级，
   * 那是不该由程序替用户做的决定。
   */
  proxyControlledByOther: (): NormalizedError =>
    makeError('PROXY_CONTROLLED_BY_OTHER', 'error.proxyControlledByOther'),

  /**
   * 技术方案 §22 Case 3：完全不可控。
   * 在校园/企业管理的机器上，这通常意味着存在组策略（Policy）——
   * Policy 的优先级高于所有扩展。
   */
  proxyNotControllable: (): NormalizedError =>
    makeError('PROXY_NOT_CONTROLLABLE', 'error.proxyNotControllable'),

  /**
   * Firefox：缺少隐私窗口访问权，代理写入必然失败。
   *
   * 文案取向是**可操作**：这是用户两步就能自己修好的问题
   * （about:addons → 勾一个框），所以必须把那两步说出来，
   * 而不是只报「写入失败」。同时说明 Firefox 为什么要问 ——
   * 代理设置对隐私窗口和普通窗口同时生效，
   * 用户理解了原因才不会觉得这是插件在乱要权限。
   */
  privateBrowsingAccessRequired: (): NormalizedError =>
    makeError('PROXY_PRIVATE_BROWSING_REQUIRED', 'error.privateBrowsingAccessRequired'),

  /**
   * 规则分流需要一个用户拒绝了的可选权限。
   *
   * 🔴 这条错误的存在本身就是一个安全决策：宁可**拒绝开启**并报错，
   *   也不静默退回全局代理。后者在网络上"能用"，却会让用户配的直连清单
   *   被无声忽略 —— 而他完全看不出来。
   *
   * 文案取向是**尊重用户的选择**：走到这里说明他看过弹窗并拒绝了，
   * 所以不该再劝一遍"你必须给"，而是说清为什么要这个权限、
   * 以及不给的话有哪两条路可走。其中「写进内核配置」那条其实更好 ——
   * 内核的规则系统比浏览器强得多。
   */
  routingPermissionRequired: (): NormalizedError =>
    makeError('ROUTING_PERMISSION_REQUIRED', 'error.routingPermissionRequired'),

  /** 写入 chrome.proxy 设置时 API 本身失败。 */
  proxyWriteFailed: (reason: string): NormalizedError =>
    makeError('UNKNOWN', 'error.proxyWriteFailed', { reason }),

  /** 写入 chrome.privacy 设置时 API 本身失败。 */
  privacyWriteFailed: (reason: string): NormalizedError =>
    makeError('UNKNOWN', 'error.privacyWriteFailed', { reason }),

  /** WebRTC 策略被别的扩展占着。 */
  privacyControlledByOther: (): NormalizedError =>
    makeError('UNKNOWN', 'error.privacyControlledByOther'),

  /** WebRTC 策略被 Policy 锁死。 */
  privacyNotControllable: (): NormalizedError =>
    makeError('UNKNOWN', 'error.privacyNotControllable'),

  /**
   * onProxyError 且 `fatal: true` —— 请求被阻止，**没有泄漏**。
   *
   * 文案取向是**安抚 + 可操作**：用户看到红色告警的第一反应是慌，
   * 不告诉他"没漏"是失职；只说"出错了"而不给排查方向同样没有价值。
   */
  proxyBlocked: (): NormalizedError => makeError('PROXY_RUNTIME_ERROR', 'error.proxyBlocked'),

  /**
   * 🔴 onProxyError 且 `fatal: false` —— 浏览器已经直连出去了。
   *
   * 文案取向与上一条**完全相反**：这里绝不能有任何安抚措辞。
   * 用户需要知道自己的真实 IP 可能已经被访问过的站点看到了。
   */
  proxyLeakSuspected: (): NormalizedError =>
    makeError('PROXY_LEAK_SUSPECTED', 'error.proxyLeakSuspected'),

  /**
   * 技术方案 §22 Case 1：Controller 不可达。
   *
   * 文案里带上 host:port —— 用户改过端口时，
   * 不告诉他探测的是哪个地址，他无从判断是不是自己填错了。
   * 并且明确指出 Controller 端口是**独立**的一项，极易被误解。
   */
  coreOffline: (host: string, port: number): NormalizedError =>
    makeError('CORE_OFFLINE', 'error.coreOffline', { host, port }),

  /** 技术方案 §22 Case 2：认证失败。 */
  coreAuthFailed: (): NormalizedError => makeError('CORE_AUTH_FAILED', 'error.coreAuthFailed'),

  /** Controller 响应了，但响应体不是预期的形状。 */
  coreBadResponse: (): NormalizedError => makeError('CORE_BAD_RESPONSE', 'error.coreBadResponse'),

  /** 开关是 ON 但浏览器没在用我们的配置。 */
  stateMismatch: (): NormalizedError => makeError('UNKNOWN', 'error.stateMismatch'),

  /**
   * V0.2：还没选主策略组。
   *
   * 这**不是故障**，是「需要配置一次」。文案取向因此是指路而非报错 ——
   * 默认值必须为空（§16 禁止硬编码组名），所以每个新用户都会经过这个状态，
   * 用红色告警迎接他是错的。
   */
  groupNotConfigured: (): NormalizedError =>
    makeError('GROUP_NOT_CONFIGURED', 'error.groupNotConfigured'),

  /**
   * V0.2：配置的组在内核里找不到。
   *
   * 最常见成因是换了订阅、机场改了组名 —— 用户侧完全无感，
   * 所以文案必须点明「去 Settings 重新选一个组」，而不是只说"not found"。
   * 带上组名，否则用户不知道我们在找哪个。
   */
  groupNotFound: (group: string): NormalizedError =>
    makeError('GROUP_NOT_FOUND', 'error.groupNotFound', { group }),

  /**
   * V0.2：内核拒绝手动切换该组（400 Must be a Selector）。
   *
   * 判定来自内核而非我们的推断（ADR-29）。文案解释「这类组由内核自动选节点」，
   * 因为用户看到"不支持"会以为是插件的缺陷，而实际上 URLTest / Fallback
   * 本来就该自动选。
   */
  groupNotSelectable: (group: string): NormalizedError =>
    makeError('GROUP_NOT_SELECTABLE', 'error.groupNotSelectable', { group }),

  /** V0.2：切换失败，且不属于上面任何一类。 */
  selectFailed: (node: string): NormalizedError =>
    makeError('SELECT_FAILED', 'error.selectFailed', { node }),

  /**
   * V0.6：订阅更新失败。
   *
   * 文案点明「可能是订阅地址访问不通」—— 这是最常见的成因（机场挂了、
   * 本机没网、订阅到期），而单说"失败"会让用户以为是插件的问题。
   */
  subsUpdateFailed: (name: string): NormalizedError =>
    makeError('SUBS_UPDATE_FAILED', 'error.subsUpdateFailed', { name }),

  /**
   * 设置校验失败。
   *
   * 只报**第一条**问题：NormalizedError 只能携带一个 key，
   * 而让用户一条一条修比一次抛出五条更容易处理。
   */
  invalidSettings: (issues: readonly ValidationIssue[]): NormalizedError => {
    const first = issues[0]
    if (first === undefined) return makeError('INVALID_SETTINGS', 'error.unknown', { reason: '' })
    return makeError('INVALID_SETTINGS', first.key, first.params)
  },

  malformedMessage: (): NormalizedError => makeError('UNKNOWN', 'error.malformedMessage'),

  unsupportedMessage: (): NormalizedError => makeError('UNKNOWN', 'error.unsupportedMessage'),

  unknown: (reason: string): NormalizedError => makeError('UNKNOWN', 'error.unknown', { reason }),
} as const

/** 把任意 catch 到的值转成安全的字符串描述，绝不泄漏对象内部结构。 */
export function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  if (typeof thrown === 'string') return thrown
  return 'unknown error'
}

/**
 * 可自愈的错误码白名单 —— 状态恢复后允许自动清除告警。
 *
 * ⚠️ 刻意用**白名单**而不是「除了 X 都能自愈」的黑名单。
 *   两种写法的失败方向不同：
 *     - 白名单漏了一个瞬时错误码 → 那条告警会一直挂着（烦，但安全）
 *     - 黑名单漏了一个严重错误码 → 它会被自动清掉（用户永远不知道出过事）
 *   在安全告警这件事上，「烦」远优于「悄悄消失」。
 */
const SELF_HEALING_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['PROXY_RUNTIME_ERROR'])

/**
 * 该错误是否属于「瞬时故障」——可在状态恢复后自动消失。
 *
 * 判据不是「严重程度」而是「是否已经造成后果」：
 * PROXY_RUNTIME_ERROR 对应 fatal=true，请求被拦住了、没有泄漏，
 * 所以问题解决后这条记录就没有保留价值了。
 */
export function isSelfHealing(code: ErrorCode): boolean {
  return SELF_HEALING_CODES.has(code)
}

/**
 * 该错误是否代表「疑似已经泄漏过真实 IP」。
 *
 * 这类告警**必须由用户显式确认**才能消失：它记录的是一个已经发生的事实，
 * 而不是一个当前状态。悄悄清掉等于替用户决定「这事不重要」——
 * 而这恰恰是本项目唯一真正需要用户知道的事。
 */
export function isLeakSuspected(code: ErrorCode): boolean {
  return code === 'PROXY_LEAK_SUSPECTED'
}
