/**
 * 平台抽象层的契约（architecture.md ADR-36）。
 *
 * ## 为什么要有这一层
 *
 * Chromium 与 Firefox 的代理 API **不是同一套 API**。MDN 对 `browser.proxy`
 * 的说明是原话：「the Chrome API is completely different from this API」。
 * 具体差异（每一条都会改变行为，不只是改个字段名）：
 *
 * | | Chromium | Firefox |
 * | --- | --- | --- |
 * | 配置形态 | `fixed_servers` + `singleProxy` | `{proxyType:'manual', http, httpProxyAll}` |
 * | bypass | `bypassList: string[]` + `<local>` 令牌 | `passthrough` 逗号分隔字符串，无 `<local>` |
 * | PAC | 内联 `pacScript.data` | **只支持 `autoConfigUrl`**，没有内联 |
 * | fail-open 兜底 | `mandatory: true` 可关掉 | 无此概念，要用 `proxy.onRequest` |
 * | 写入 scope | `set({value, scope})` | `set({value})`，**没有 scope 参数** |
 * | WebRTC 强制代理 | `disable_non_proxied_udp` | `proxy_only`（见下方 🔴） |
 * | 运行时错误 | `onProxyError`，带 `fatal` | `onError`，**没有 fatal** |
 *
 * 🔴 **WebRTC 那一行是安全相关的，不是命名差异。** 自 Firefox 70 起
 *    （Bugzilla 1452713），`disable_non_proxied_udp` 在 Firefox 里的语义
 *    退化成「有代理时强制走代理，**没有代理时回落到 mode 3**」。
 *    把 Chromium 的值原样抄过去会**静默地**削弱泄漏防护 —— 值被接受、
 *    不报错、行为变弱。Firefox 侧与原始意图等价的值是 `proxy_only`。
 *    正因为存在这种"抄过去也能跑但更不安全"的差异，平台差异必须集中在
 *    一处被逐条对照，而不是散在业务代码里靠 `isFirefox()` 临时判断。
 *
 * ## 这一层怎么划的
 *
 * 划线原则：**平台实现只回答「浏览器 API 怎么调」，不回答「该不该调」。**
 *
 *   - 平台负责：配置对象的形态、API 调用、平台特有的值与事件形状。
 *   - 共享层负责：全部**决策** —— 被别的扩展控制时拒绝写入、查询失败时
 *     降级成 `unknown` 而不是放弃写入、关闭用 `clear()` 而不是写 `direct`、
 *     WebRTC 锁的生命周期绑在代理开关上。
 *
 * 这条线的实际检验标准：本项目的安全语义（ADR-03 fail-closed、ADR-18
 * 释放而非强制、ADR-22 告警自愈）**一条都不该出现在平台实现里**。
 * 若哪天需要在 chromium.ts 里重复一遍这些判断，说明线划错了。
 *
 * ## 为什么用一个对象而不是一组散装 export
 *
 * `const chromium: BrowserPlatform = { ... }` 会让 TypeScript 逐个方法检查
 * 签名与完整性 —— 漏实现一个方法就是**编译错误**。这与项目里用
 * `Record<ErrorCode, boolean>` 强制对每个新错误码表态是同一手法：
 * 让"忘了处理"变成编译期失败，而不是运行期的静默分支。
 */

import type { LevelOfControl, NormalizedError, Settings } from '../../shared/types'

/** 当前支持的平台。加一个值就会在 `platform/index.ts` 处逼出一个选择分支。 */
export type PlatformId = 'chromium' | 'firefox'

/**
 * 浏览器代理设置的巡检结果。
 *
 * 刻意是**平台无关**的形状：两个平台的原生返回结构完全不同，
 * 但编排层需要的信息只有这三项。差异在平台实现里就被吸收掉，
 * 不往上渗。
 */
export interface ProxyInspection {
  /** 设置归属层级。`'unknown'` 表示查询本身失败。 */
  levelOfControl: LevelOfControl | 'unknown'
  /** 浏览器当前的代理模式，仅用于诊断展示，不参与判定。 */
  mode: string | null
  /**
   * 浏览器**实际**是否处于本扩展期望的配置。
   *
   * 与「用户意图 enabled」分开判断，才能发现两者不一致并避免显示假 ON
   * （技术方案 §22 Case 3）。比对逻辑必须由平台实现 ——
   * 配置对象的形状是平台特有的。
   */
  matchesExpected: boolean
}

/** WebRTC IP 处理策略的巡检结果。同样是平台无关形状。 */
export interface WebRtcInspection {
  /** 当前生效的策略值（原样透传，用于诊断）。查询失败时为 null。 */
  policy: string | null
  levelOfControl: LevelOfControl | 'unknown'
  /**
   * 是否已处于「强制走代理」状态。
   *
   * 由平台判定而不是由上层比对字符串 —— 因为达到这个状态的**值本身**
   * 两个平台不同（见文件头 🔴）。上层只该问"锁上了吗"，
   * 不该知道锁是什么牌子的。
   */
  locked: boolean
}

/**
 * 一个平台实现必须提供的全部能力。
 *
 * ## 错误约定（重要）
 *
 * 本接口的所有方法**失败时一律抛异常**，不返回 `ApplyResult`。
 *
 * 理由：把 throw 归一成 `NormalizedError` 是一个**决策**（用哪个错误码、
 * 文案怎么写、要不要带上原始信息），而决策属于共享层。若让每个平台
 * 各自归一，两个平台就会各写一份文案，且迟早漂移 ——
 * 而漂移的正是面向用户的安全提示。
 *
 * 唯一的例外是 `onProxyError`：它是事件回调，那里的归一必须由平台做，
 * 因为**原始事件的形状本身**就不同（Chromium 有 `fatal`，Firefox 没有）。
 */
export interface BrowserPlatform {
  readonly id: PlatformId

  /**
   * 读取浏览器当前的代理状态并与期望配置比对。
   *
   * 查询失败时**抛错**。降级成 `levelOfControl: 'unknown'` 是共享层的决策
   * （见 `proxy.ts` 的 `inspectProxy`），不在这里做。
   */
  readProxyState(expected: Settings): Promise<ProxyInspection>

  /**
   * 把代理配置写入浏览器。
   *
   * ⚠️ 本方法**不检查**是否被其他扩展控制 —— 那道闸门在共享层
   *    （`enableProxy`），因为「不强行覆盖」是一条策略而非一次 API 调用。
   *    平台实现只管写。
   *
   * ⚠️ 本方法**不得**探测本机代理是否可用。ADR-03 的 fail-closed 语义
   *    要求「内核没起来也照样写」，因为写了的后果是网页打不开（可见故障），
   *    不写的后果是用户以为在走代理而实际直连（不可见的 IP 泄漏）。
   */
  applyProxy(settings: Settings): Promise<void>

  /**
   * 释放对代理设置的控制权。
   *
   * 🔴 语义是「本扩展不再干预」，**不是**「强制全世界直连」（ADR-18）。
   *    平台实现必须用各自的 `clear()`，不得写一个显式的 direct 配置 ——
   *    后者会让本扩展继续持有控制权并覆盖用户其他合法配置。
   */
  releaseProxy(): Promise<void>

  /**
   * 注册代理运行时错误监听，并把原始事件归一成 `NormalizedError`。
   *
   * ⚠️ MV3 约束：调用方必须在 Service Worker / 事件页的**顶层同步调用**。
   *    延迟注册会丢事件。
   *
   * 归一在这里做（而非共享层）的理由见接口注释：Chromium 的 `fatal` 字段
   * 决定了「请求被拦住了」还是「已经直连出去了」，而 Firefox 的
   * `proxy.onError` 根本没有这个字段 —— 两边能得出的结论强度不同，
   * 硬塞进一个共享函数只能靠 `if (platform)`，那正是要避免的东西。
   */
  onProxyError(handler: (error: NormalizedError) => void | Promise<void>): void

  /** 读取 WebRTC IP 处理策略。查询失败时抛错，降级由共享层决定。 */
  readWebRtcState(): Promise<WebRtcInspection>

  /**
   * 加锁：强制 WebRTC 媒体走代理。
   *
   * 🔴 具体写入哪个值由平台决定，见文件头那张表 ——
   *    两个平台的等价值不同，且抄错不会报错，只会更不安全。
   */
  lockWebRtcPolicy(): Promise<void>

  /** 解锁：释放控制权（同样是 `clear()` 语义，不是写 `'default'`）。 */
  unlockWebRtcPolicy(): Promise<void>
}
