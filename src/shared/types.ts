/**
 * 全项目共享的类型定义。
 *
 * 分层原则：本文件只放类型，不放任何运行时代码或常量
 * （常量在 constants.ts，消息协议在 messages.ts，文案在 i18n.ts）。
 *
 * 与技术方案 §11 的差异：§11 建议用单个 `ProxyState` 统一状态。
 * 这里刻意拆成三层，因为它们的**生命周期完全不同**：
 *   - Settings        → 用户配置，持久化
 *   - enabled         → 开关，持久化（独立于配置，对应 §28 Task 03 的四个 API）
 *   - StatusSnapshot  → 运行时快照，**不持久化**，每次由 Service Worker 现算
 * 混在一起会诱使代码把运行时状态写回 storage，
 * 而那正是 MV3 下「UI 状态与浏览器实际状态不一致」的根源（见 architecture.md ADR-08）。
 */

import type { Language, MessageKey, MessageParams } from './i18n'

/** 用户可配置项。持久化在 chrome.storage.local（**绝不用 sync**，见 security.md §2.1）。 */
export interface Settings {
  /** Mihomo mixed-port 所在主机。默认 127.0.0.1。 */
  proxyHost: string
  /** Mihomo mixed-port。默认 7890。允许用户修改，不得硬编码（技术方案 §22 Case 4）。 */
  proxyPort: number
  /** Mihomo external-controller 主机。默认 127.0.0.1。 */
  controllerHost: string
  /** Mihomo external-controller 端口。默认 9090。 */
  controllerPort: number
  /**
   * Controller API Secret。
   * 空字符串表示用户未配置——此时请求**不发送** Authorization 头
   * （Mihomo 未配置 secret 时可正常连接）。
   */
  controllerSecret: string
  /**
   * 是否锁定 WebRTC IP 处理策略为 disable_non_proxied_udp。
   * 默认开启。关闭会重新暴露真实 IP 泄漏面，见 architecture.md ADR-05。
   */
  webRtcLockEnabled: boolean
  /** 界面语言偏好。'auto' 表示跟随浏览器。 */
  language: Language
}

/**
 * 浏览器代理设置的归属层级。
 *
 * 四个字面量取自 chrome.types.LevelOfControl 的官方定义。
 * 刻意自行声明而不引用 @types/chrome 的类型别名，以免类型包
 * 版本变动导致编译失败——这四个值本身由 API 文档确证，是稳定契约。
 *
 * 优先级（由低到高）：系统设置 < 命令行参数 < 扩展 < Policy。
 * 扩展之间：最近安装的优先。
 */
export type LevelOfControl =
  | 'not_controllable'
  | 'controlled_by_other_extensions'
  | 'controllable_by_this_extension'
  | 'controlled_by_this_extension'

/** 规范化错误码。对应技术方案 §22 需要处理的各个 case。 */
export type ErrorCode =
  /** §22 Case 1：Mihomo 没启动 / Controller 不可达 */
  | 'CORE_OFFLINE'
  /** §22 Case 2：Controller API 认证失败（secret 错误或缺失） */
  | 'CORE_AUTH_FAILED'
  /** Controller 返回了非预期的响应体 */
  | 'CORE_BAD_RESPONSE'
  /** §22 Case 3 / §24：代理设置被其他扩展控制 */
  | 'PROXY_CONTROLLED_BY_OTHER'
  /** §22 Case 3：代理设置完全不可控（通常意味着企业/校园 Policy） */
  | 'PROXY_NOT_CONTROLLABLE'
  /**
   * onProxyError 且 `fatal: true` —— 请求被**阻止**，真实 IP 未泄漏。
   * 属于瞬时故障：状态恢复后应当自动消失（architecture.md ADR-22）。
   */
  | 'PROXY_RUNTIME_ERROR'
  /**
   * 🔴 onProxyError 且 `fatal: false` —— 浏览器**已经用直连发出了请求**，
   * 真实 IP 可能已暴露。
   *
   * 与 PROXY_RUNTIME_ERROR 刻意分成两个码，因为两者的严重程度**相反**，
   * 因而自愈策略也必须相反：本码**绝不自动消失**，必须由用户显式确认
   * （architecture.md ADR-22）。
   */
  | 'PROXY_LEAK_SUSPECTED'
  /** 用户输入的设置不合法 */
  | 'INVALID_SETTINGS'
  | 'UNKNOWN'

/**
 * 规范化错误。
 *
 * 🔴 持久化的是 **i18n key + params**，而不是已翻译好的字符串。
 *   `lastError` 会写进 chrome.storage.local 并跨 Service Worker 重启存活；
 *   若存的是成品文案，用户切换语言后旧告警会永远停留在旧语言里。
 *   翻译只在 UI 层发生（shared/i18n.ts）。
 *
 * ⚠️ `message` 是**英文兜底文案**，由 key 自动生成，仅用于日志与调试。
 *    它保证与英文字典一致，不会漂移。
 *    面向用户展示时请用 key 翻译，不要直接用它。
 *
 * ⚠️ 无论 message 还是 params，都**禁止**携带 Controller Secret
 *    或订阅 URL（security.md §2.3）。
 */
export interface NormalizedError {
  code: ErrorCode
  /** i18n 键。UI 用它翻译。 */
  key: MessageKey
  /** 插值参数。禁止放入任何凭据。 */
  params?: MessageParams
  /** 英文兜底文案，由 key 生成。用于日志，不用于展示。 */
  message: string
  /** 发生时间（Date.now()）。 */
  at: number
}

/** 单条设置校验问题。同样只带 key，翻译交给 UI。 */
export interface ValidationIssue {
  key: MessageKey
  params?: MessageParams
}

/**
 * 传给 UI 的设置视图 —— **刻意不含 Controller Secret 明文**。
 *
 * UI 需要知道的只是「有没有配 secret」（决定输入框显示占位符还是提示语），
 * 从来不需要那个值本身。按最小暴露原则，明文就不该越过 background 边界，
 * 哪怕 chrome.runtime 消息并不出扩展（security.md §2.1）。
 *
 * ⚠️ 字段刻意逐个显式声明，而不是用 `Omit<Settings, 'controllerSecret'>`。
 *    用 Omit 的话，将来给 Settings 加一个新的敏感字段会**自动**暴露给 UI；
 *    显式声明强制每次新增都做一次「这个要不要给 UI」的决定。
 */
export interface SettingsView {
  proxyHost: string
  proxyPort: number
  controllerHost: string
  controllerPort: number
  /** 是否已配置 Controller Secret。只有布尔值，没有明文。 */
  hasSecret: boolean
  webRtcLockEnabled: boolean
  /** 语言偏好。UI 需要它来渲染下拉框的当前选中项。 */
  language: Language
}

/**
 * Mihomo Controller 的可观测状态。
 *
 * 刻意做成三态而不是 `coreOnline: boolean`，因为「连不上」和
 * 「连上了但配置不对」是性质完全不同的两件事（architecture.md ADR-23）：
 *
 *   - `online`      → Controller 可达，能读到版本号
 *   - `unreachable` → 那个端口上**什么都没有**。很可能是用户的客户端
 *                     刻意只用 named pipe 而不开 HTTP controller
 *                     （Clash Verge Rev 的 enable_external_controller: false）。
 *                     这**不是错误**：代理走 mixed-port，与 Controller 无关。
 *   - `error`       → 端口上**有服务**，但认证失败或响应不是 mihomo。
 *                     这证明配置确实填错了，是真正需要告警的情况。
 *
 * 把 unreachable 当成错误会在 named pipe 模式下产生永久噪音，
 * 而永久噪音会训练用户无视所有告警 —— 比没有告警更糟。
 */
export type CoreStatus = 'online' | 'unreachable' | 'error'

/**
 * 运行时状态快照 —— Popup 渲染所需的全部信息。
 *
 * **不持久化**。每次 GET_STATUS 时由 Service Worker 现场采集：
 * enabled 与 settings 读自 storage，其余全部实时探测。
 */
export interface StatusSnapshot {
  /** 用户意图：开关是否为 ON。 */
  enabled: boolean
  settings: SettingsView
  /** Controller 的可观测状态。注意它**不代表代理能不能用**。 */
  coreStatus: CoreStatus
  /** Mihomo 版本号；非 online 时为 null。 */
  coreVersion: string | null
  /** 浏览器代理设置的归属。'unknown' 表示查询失败。 */
  levelOfControl: LevelOfControl | 'unknown'
  /**
   * 浏览器**实际**是否处于本扩展设置的代理模式。
   * 与 `enabled` 分开存在，是为了能检测出两者不一致的情况——
   * 不一致时 UI 必须如实呈现，不能显示假 ON（技术方案 §22 Case 3）。
   */
  proxyActuallySet: boolean
  /** WebRTC 是否处于加锁状态。 */
  webRtcLocked: boolean
  lastError: NormalizedError | null
}

/** Mihomo `GET /version` 的响应体。 */
export interface MihomoVersion {
  /** 是否为 Meta（mihomo）版本。 */
  meta: boolean
  version: string
}

/**
 * 「尝试改动浏览器设置」类操作的统一返回。
 *
 * 用信封而不是抛异常：这类操作的失败（被别的扩展控制、被 Policy 锁死）
 * 是**预期内的正常分支**，不是异常。用异常表达会诱使调用方忘记处理。
 */
export type ApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: NormalizedError }

