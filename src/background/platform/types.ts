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
 * | bypass | `bypassList: string[]` | `passthrough` 逗号分隔字符串（两边都认 `<local>`） |
 * | PAC | 内联 `pacScript.data` | **只支持 `autoConfigUrl`**，没有内联 |
 * | fail-open 兜底 | `mandatory: true` 可关掉 | 无此概念，要用 `proxy.onRequest` |
 * | 写入 scope | `set({value, scope})` | `set({value})`，**没有 scope 参数** |
 * | 省略字段 | 保留原值 | **重置为默认值**（见下方 🔴🔴） |
 * | WebRTC 强制代理 | `disable_non_proxied_udp` | `proxy_only`（见下方 🔴） |
 * | 运行时错误 | `onProxyError`，带 `fatal` | `onError`，**没有 fatal**，且只在 PAC/onRequest 出错时触发 |
 * | 写入前置条件 | 无 | **需要私密窗口访问权**，否则 `set()` 抛异常 |
 *
 * 🔴 **WebRTC 那一行是安全相关的，不是命名差异。** 自 Firefox 70 起
 *    （Bugzilla 1452713），`disable_non_proxied_udp` 在 Firefox 里的语义
 *    退化成「有代理时强制走代理，**没有代理时回落到 mode 3**」。
 *    把 Chromium 的值原样抄过去会**静默地**削弱泄漏防护 —— 值被接受、
 *    不报错、行为变弱。Firefox 侧与原始意图等价的值是 `proxy_only`。
 *
 * 🔴🔴 **「省略字段」那一行同样是安全相关的，而且更隐蔽。** MDN 原话：
 *    「When setting this object, all properties are optional.
 *      **Any omitted properties are reset to their default value.**」
 *    而 `httpProxyAll` 的默认值是 `false`。也就是说在 Firefox 上只写
 *    `{proxyType:'manual', http:'127.0.0.1:7890'}` 会得到「只代理 HTTP，
 *    HTTPS 走 `ssl`（未设）因而**直连**」—— 正是 ADR-01 在 Chromium 上
 *    拒绝 `proxyForHttp` 的那个口子，换了个形状重新出现。
 *    Firefox 侧与 `singleProxy` 等价的写法是显式 `httpProxyAll: true`。
 *
 * ## 这一层怎么划的
 *
 * 划线原则：**平台实现只回答「浏览器 API 怎么调」，不回答「该不该调」。**
 *
 *   - 平台负责：配置对象的形态、API 调用、平台特有的值与事件形状，
 *     以及**探测**自己能不能写（`preflight`）。
 *   - 共享层负责：全部**决策** —— 被别的扩展控制时拒绝写入、查询失败时
 *     降级成 `unknown` 而不是放弃写入、关闭用 `clear()` 而不是写 `direct`、
 *     WebRTC 锁的生命周期绑在代理开关上，以及**探测结果该报成哪条错误**。
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
 * 平台**当前无法写入代理**的原因。
 *
 * ## 为什么要有这个类型
 *
 * 有些「写不进去」既不是被别的扩展抢了、也不是 API 抛错，而是这个平台
 * 在这种配置下**根本做不到**。两个已知的例子：
 *
 *   - Firefox 需要用户授予「在私密窗口中运行」才允许改代理设置；
 *     没授权时 `proxy.settings.set()` 直接抛异常。
 *   - Firefox 不支持内联 PAC，因此在 V0.4 智能分流开着时无法照配置写入。
 *
 * ## 为什么不让平台直接返回一条错误
 *
 * 因为「报成哪条错误、文案怎么写」是**决策**，属于共享层
 * （见下方错误约定）。平台只回答「能不能写、不能的话是哪种情况」，
 * 由 `proxy.ts` 把它映射成 `NormalizedError`。
 *
 * 🔴 这个联合类型加一个成员，共享层的映射表就会编译失败 ——
 *   与 `Record<ErrorCode, boolean>` 是同一手法：逼着新增的情况被表态，
 *   而不是落进一个 `default:` 分支里变成「未知错误」。
 */
export type PlatformBlocker =
  /** 用户还没授予隐私窗口访问权（Firefox）。**这是用户可自行修复的**。 */
  | 'privateBrowsingAccessRequired'
  /**
   * 规则分流需要一个用户还没授予的可选权限（Firefox 的 `<all_urls>`）。
   *
   * 🔴 与 `privateBrowsingAccessRequired` 分开，因为**修复方式不同**：
   *   那一条要用户自己去 about:addons 点，我们只能给指引；
   *   这一条我们可以**主动弹出授权请求**（`permissions.request()`），
   *   用户点一下就好。报成同一条会白白让用户多走一趟。
   *
   * 之所以是可选权限而不是必需：见 `firefox.ts` 里 `ALL_URLS` 的注释 ——
   * 默认权限面小对一个代理工具本身就是卖点，
   * 不该让只用全局代理的人替一个可选功能付这个代价。
   */
  | 'routingPermissionRequired'

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
   * 这个平台**能不能支持这份配置**。返回 `null` 表示能。
   *
   * 🔴 与 `preflight` 刻意分成两个方法，因为它们回答的是不同的问题：
   *
   *   - `supports`  → 「这份配置在这个浏览器上**能用吗**」（跟着配置走）
   *   - `preflight` → 「**现在**允许我写吗」（跟着浏览器授权走）
   *
   * 此方最初把两者混成一个 `preflight(settings)`，那是个真 bug：
   * 保存设置时若也调它，一个没授予隐私窗口权限的 Firefox 用户会
   * **连端口都改不了** —— 因为授权缺失被当成了"这份配置不合法"。
   * 反过来，只在开启代理时才检查能力，用户就能存下一个
   * 让开关永远点不动的设置（真机上踩到的死角）。
   *
   * 拆开之后各归各位：
   *   - 保存设置时只查 `supports` —— 不让用户存下一份这个浏览器用不了的配置
   *   - 开启代理时查两者
   *
   * ⚠️ 是 **async**，因为在 Firefox 上它要查一个可选权限授没授
   *    （`permissions.contains`）。此方最初把它设计成同步的纯能力判断，
   *    那在只考虑「内联 PAC 支不支持」时够用；引入可选权限之后就不够了 ——
   *    「能不能用」现在同时取决于平台能力**和**用户给没给权限。
   *
   *    实现里不许在这条路上发**网络**请求：它在保存设置时会被调用，
   *    而那条路径上等一次网络是没道理的。`permissions.contains`
   *    是本地查询，不算。
   */
  supports(settings: Settings): Promise<PlatformBlocker | null>

  /**
   * 尝试获得这份配置所需的可选权限。返回是否已具备。
   *
   * 🔴 **必须由用户手势触发**（点击事件的调用栈里）。
   *   Firefox 的 `permissions.request()` 在没有用户手势时直接拒绝 ——
   *   所以这个方法只能从「用户点了开关/切了模式」这条路径上调，
   *   不能放进 `reconcile()` 之类的后台流程里。
   *
   * 与 `supports` 分开而不是让它自己去要权限：`supports` 会在
   * 保存设置、开启代理、渲染状态等多处被调用，其中大部分**不是**用户手势，
   * 而一个会弹窗的查询函数在那些地方是灾难。查询与索取必须分开。
   *
   * 没有可选权限概念的平台（Chromium）直接返回 true。
   */
  requestPermissions(settings: Settings): Promise<boolean>

  /**
   * **现在**能不能写。返回 `null` 表示能。
   *
   * 只管授权类的前置条件，不重复 `supports` 的能力判断。
   *
   * ⚠️ 这里只做**探测**，不做判断该报什么错 —— 那是共享层的事
   *    （见 `PlatformBlocker` 的注释）。
   *
   * ⚠️ 也**不**检查是否被别的扩展控制。那道闸门在共享层，
   *    因为「不强行覆盖」是一条与浏览器无关的策略。
   *
   * 为什么需要这个钩子而不是让 `applyProxy` 直接抛：Firefox 缺私密窗口
   * 访问权时 `set()` 抛出的是一句面向开发者的英文，塞进 UI 对用户毫无
   * 指导意义 —— 而这恰恰是**用户自己一勾就能修好**的问题。
   * 提前探测才能给出「去哪儿勾哪个框」的具体指引。
   */
  preflight(): Promise<PlatformBlocker | null>

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

  /**
   * 注册平台需要在**顶层同步**挂上的长期监听。
   *
   * ⚠️ 调用方必须在背景脚本的顶层同步调用，与 `onProxyError` 同理。
   *
   * ## 为什么这个钩子存在
   *
   * Firefox 的智能分流走 `proxy.onRequest` —— 一个每请求都要回答的监听。
   * 它**必须**顶层注册：Firefox 的 MV3 背景是事件页，空闲约 30 秒就卸载，
   * 而从业务流程（比如"用户点了开启"）里挂上的监听会随之消失，
   * 且没人重挂 —— 用户的直连清单于是静默失效。
   *
   * 此方最初把它挂在 `applyProxy` 里，正是这个错。`index.ts` 自己的文件头
   * 就写着这条铁律，而此方违反了它。
   *
   * Chromium 不需要这个（PAC 由浏览器自己执行），实现为空。
   *
   * @param stateReader 现读「开关状态 + 当前设置」。由调用方注入，
   *   因为平台层不该依赖 storage（模块边界）。
   *
   *   开关状态**必须**给：只给 settings 会漏掉一个反方向的欺骗 ——
   *   代理关掉后 `routingMode` 与规则并不会变，监听于是继续把流量
   *   送进代理，而 UI 显示已关闭。
   */
  registerListeners(
    stateReader: () => Promise<{ enabled: boolean; settings: Settings }>,
  ): void
}
