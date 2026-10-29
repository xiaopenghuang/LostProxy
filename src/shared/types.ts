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
  /**
   * 分流模式（V0.4）。
   *
   * - `global` → 全部走代理（等价于 V0.1 的 fixed_servers 行为）
   * - `smart`  → 直连清单绕过代理，其余走代理（PAC）
   * - `direct` → 浏览器直连，但保留代理配置
   *
   * 默认 `global`：它与 V0.1 的行为完全一致，升级不改变任何既有用户的实际状态。
   */
  routingMode: RoutingMode
  /**
   * 智能分流的直连域名清单（V0.4）。
   *
   * 🔴 这些字符串会被嵌入 PAC 脚本，属于**注入面**。
   *    必须经 `validateSettings` 的白名单校验，且在生成脚本时用
   *    `JSON.stringify` 序列化成数据而非拼接进代码（security.md §4.1 / ADR-33）。
   */
  directRules: readonly string[]
  /**
   * 主策略组名称（V0.2）。空字符串表示用户还没选。
   *
   * 技术方案 §16 明令「禁止硬编码某个代理组名称」——不同机场的组名各不相同，
   * 猜一个默认值（"Proxy"、"🚀 节点选择"…）只会在猜错时表现为「功能坏了」。
   * 所以默认为空，由用户在 Settings 里从内核实际返回的组里选。
   *
   * ⚠️ 这是**完全由用户数据决定**的字符串，含空格 / `|` / `/` / emoji 都属正常，
   *    拼进 URL 前必须 encodeURIComponent（architecture.md ADR-30）。
   */
  primaryGroup: string
  /**
   * 是否启用时区同步（V0.9）。
   *
   * 🔴 **默认关闭，且必须如此。** 这是本项目第一个**主动向外发请求**的功能：
   *    探测出口 IP 要访问第三方地理服务，注入时区要在目标站点执行脚本。
   *    两者都超出「只写 chrome.proxy」的原始边界，不能被一次升级默认开启。
   *
   * 关闭时，扩展的行为与 V0.8 完全一致：不探测、不注入、不多一个请求。
   */
  timezoneSyncEnabled: boolean
  /**
   * 是否同时把语言改成与出口地区一致（V0.8.0）。
   *
   * 🔴 **默认关闭，比时区更严格。** 两者的收益结构不同：
   *
   *   - 时区修的是一个**真实存在的不一致**（出口在洛杉矶、浏览器报上海），
   *     关掉它就等于把矛盾留着；
   *   - 语言是把一项**本来没有矛盾**的信号改成另一个值。浏览器报中文、
   *     出口在洛杉矶，这个组合在真实用户里大量存在（洛杉矶的华人），
   *     它本身不是破绽。
   *
   * 换句话说：时区是修 bug，语言是改身份。后者的收益不确定（没有任何证据
   * 表明语言影响服务端的判断），代价却看得见 —— 它可能让目标站点切换
   * 界面语言。
   *
   * 需要 `timezoneSyncEnabled` 同时开着才有意义：语言依附于同一次探测，
   * 没有出口就没有"应该用哪种语言"的答案。
   */
  localeSyncEnabled: boolean
  /**
   * 时区注入的域名清单（V0.9）。
   *
   * 存**裸主机名**（`chatgpt.com`），不带 scheme、不带路径，与 `directRules`
   * 的书写习惯一致。转成匹配模式在 `timezone.ts` 里统一做。
   *
   * 为什么是用户可配而不是写死：需要时区一致的站点因人而异（ChatGPT / Claude /
   * 某个只有自己用的内部系统），写死任何一个都只能服务一部分人。
   * 而全量注入要 `<all_urls>`，与「默认权限面只有一个回环地址」直接冲突。
   */
  timezoneHosts: readonly string[]
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
/**
 * 分流模式（V0.4）。
 *
 * `global` 与 `direct` 用 `fixed_servers` / `clear()` 实现，
 * `smart` 用 `pac_script` + `mandatory: true` 实现。
 * 三者的失败语义必须一致地 fail-closed —— 而 PAC 默认是 fail-open，
 * 这是本项目最需要小心的一处（security.md §4）。
 */
export type RoutingMode = 'global' | 'smart' | 'direct'

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
   * Firefox：用户还没授予「在隐私窗口中运行」，`proxy.settings.set()` 会抛。
   *
   * 与 PROXY_NOT_CONTROLLABLE 刻意分开：那一条是**没救**（Policy 锁死，
   * 用户无能为力），这一条是**用户自己勾一下就好**。
   * 报成同一个码会让一个两步可解的问题读起来像一堵墙。
   */
  | 'PROXY_PRIVATE_BROWSING_REQUIRED'
  /**
   * 规则分流需要一个用户还没授予的可选权限（Firefox 的 `<all_urls>`）。
   *
   * 🔴 必须**拒绝开启**而不是退回全局代理。退回全局在网络上"能用"，
   *   但会静默丢掉用户配的直连清单 —— 他本该直连的校内站点全部走了代理，
   *   而 UI 显示一切正常。这不是"没保护"，是"保护成了另一种样子"。
   *
   * ⚠️ 出现这个码时我们**没有**、也**不可能**弹过窗。
   *    `permissions.request()` 只能从用户手势的调用栈里调用，而背景脚本
   *    处理 popup 消息不算手势（详见 `platform/types.ts` 里那段说明）。
   *
   *    所以文案必须**告诉用户去哪里授权**（设置页那个按钮），
   *    而不能写成"在弹窗里允许" —— 此方第一版就是那么写的，
   *    结果是一句指向了不存在的弹窗的提示。
   *    一个说明了修法却无法执行的错误，比不给提示更糟。
   */
  | 'ROUTING_PERMISSION_REQUIRED'
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
  /** V0.2：用户配置的主策略组在内核里不存在（改了订阅、组名变了） */
  | 'GROUP_NOT_FOUND'
  /**
   * V0.2：内核拒绝手动切换该组（`400 Must be a Selector`）。
   * 判定权在内核而不在我们，见 architecture.md ADR-29。
   */
  | 'GROUP_NOT_SELECTABLE'
  /** V0.2：切换请求失败，且不属于上面任何一类 */
  | 'SELECT_FAILED'
  /** V0.2：还没选主策略组 —— 这不是错误，是「需要配置」 */
  | 'GROUP_NOT_CONFIGURED'
  /** V0.3：单个节点测速失败或超时 */
  | 'LATENCY_TEST_FAILED'
  /** V0.6：订阅更新失败（订阅地址访问不通等） */
  | 'SUBS_UPDATE_FAILED'
  /**
   * V0.9：探测出口时区失败。
   *
   * 与代理层告警刻意分开：探测失败**不影响代理是否可用**，
   * 它只是「时区没同步上」。也因此在 UI 上不该用红色告警 ——
   * 用户的网络是好的，出问题的只是一个附加功能。
   */
  | 'TZ_PROBE_FAILED'
  /**
   * V0.9：服务返回的时区串无法被 `Intl` 接受。
   *
   * 这**不该发生**（ipinfo 返回的是标准 IANA 名），但一旦发生，
   * 说明我们拿到的东西不能直接塞进 `Intl.DateTimeFormat` ——
   * 那边的失败方式是抛 RangeError，而它会在页面注入时炸掉整段脚本。
   * 所以宁可在这里拒绝，也不能把一个无效时区拿去注入。
   */
  | 'TZ_INVALID_ZONE'
  /**
   * V0.9：缺少向目标站点注入脚本的权限。
   *
   * 与 ROUTING_PERMISSION_REQUIRED 同属「用户可自行修复」的一类，
   * 但修法不同：那条要引导用户去 about:addons 勾选，这条可以在设置页
   * 一次点击重新请求。
   */
  | 'TZ_PERMISSION_REQUIRED'
  /**
   * V0.9：代理没开时试图探测，或关掉代理后时区不再有意义。
   *
   * 单独一个码而不是复用 TZ_PROBE_FAILED：这不是"探测失败"，是
   * **没有可探测的东西**。文案要指向"先打开代理"，而前者的文案
   * 会引导用户去查网络 —— 两件事的排查方向相反。
   */
  | 'TZ_PROXY_OFF'
  /**
   * V0.9：站点清单为空。
   *
   * 这**不是故障**，是「还需要配置一次」—— 与 GROUP_NOT_CONFIGURED 同一个
   * 取向：文案要指路（去填一个域名），而不是报警。
   *
   * 🔴 必须把这条堵在 background 而不是只靠 UI 禁用按钮。
   *    「清单为空」时探测会照常成功、快照会照常写入，而 `reinjectOpenTabs([])`
   *    一个站点都不碰 —— 用户看到「已同步」，刷新页面却毫无变化。
   *    把判定放在唯一的消息入口上，任何调用方都绕不过去。
   */
  | 'TZ_NO_HOSTS'
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
  /** 分流模式。Popup 的三档切换需要它。非敏感。 */
  routingMode: RoutingMode
  /** 直连清单。Settings 的文本框需要它回显。非敏感（是用户自己填的域名）。 */
  directRules: readonly string[]
  /**
   * 主策略组名称。**不是敏感信息**，UI 需要它来渲染当前选中的组。
   *
   * 这个字段是显式声明制度的一次实际检验：加它的时候必须回答
   * 「这个要不要给 UI」。答案是要（UI 得显示用户选了哪个组），
   * 但这个决定是**做出来的**，不是被 `Omit` 自动带过来的。
   */
  primaryGroup: string
  /** V0.9：时区同步开关。UI 要渲染它。 */
  timezoneSyncEnabled: boolean
  /** V0.8.0：语言同步开关。UI 要渲染它，且在时区关闭时表现为不可用。 */
  localeSyncEnabled: boolean
  /**
   * V0.9：时区注入域名清单。UI 的回显与授权按钮都需要它。
   *
   * 非敏感 —— 是用户自己填的域名，且它们本来就以明文存在 storage 里。
   * 但**注意**：这份清单会决定向浏览器索取哪些 host permission，
   * 所以 UI 在保存前必须让用户看见它具体是什么。
   */
  timezoneHosts: readonly string[]
}

/**
 * 时区同步的运行时快照（V0.9）。
 *
 * 与 `StatusSnapshot` 的其余部分不同，这一份**要持久化** ——
 * 它记录的是「上一次探测出了什么」，而重测需要一次真实网络往返。
 * 若只留在内存里，Service Worker 每次被回收（几十秒无操作就会发生）
 * 都要重新探测一次，那是拿用户的流量换一个不会变的值。
 *
 * ⚠️ 也因此它必须能被 `coerceTimezone` 宽容解析：旧版本没有这个键，
 *    损坏的 JSON 也不能让 SW 起不来。
 */
export interface TimezoneSnapshot {
  /** IANA 时区名，如 `Asia/Tokyo`。null 表示从未探测成功。 */
  zone: string | null
  /**
   * 探测到的出口国家代码（ISO 3166-1 alpha-2，大写），如 `US`、`JP`。
   *
   * 存它而不是直接存 locale，是因为两份信息用途不同：
   *   - `country` 是**事实**，来自探测响应，UI 上可以显示给用户核对；
   *   - `locale` 是**推导**，来自 `COUNTRY_LOCALE` 表，这张表会随版本变化。
   *
   * 分开存，将来改表时旧快照里的 country 仍然是对的，重新推导一次就能
   * 得到新的 locale；只存 locale 的话，那次改动会连带改掉"当时到底探测到了
   * 什么"这个事实。
   */
  country: string | null
  /**
   * 由 `country` 推导出的目标语言，如 `en-US`。
   *
   * null 有两种可能，**在 UI 上都表现为"语言不同步"**：
   *   - 国家查不到（表刻意不求全，见 `shared/locales.ts`）；
   *   - 探测源没给国家代码。
   *
   * ⚠️ 它为 null 时**不阻断时区同步**。两者是同一组地理信号，但时区
   *    几乎总能拿到，语言常常拿不到 —— 因为缺语言而整个功能不生效，
   *    等于用一项的不完整否掉另一项的确定结果。
   */
  locale: string | null
  /**
   * 探测时的出口 IP。
   *
   * 存它是为了**可核对**：用户看到「Asia/Tokyo / 103.x.x.x」能自己判断
   * 这次探测是不是走对了路径。只给时区名的话，一个来自直连出口的错误时区
   * 看起来和正确结果毫无区别。
   */
  exitIp: string | null
  /** 探测完成时间（Date.now()）。用于 TTL 判定。 */
  at: number
  /**
   * 探测时内核选中的节点名。
   *
   * 这是「要不要重测」的主判据：节点换了，出口国家就可能换了，
   * 而节点名是我们唯一能顺手拿到的变化信号 —— 出口 IP 本身要探测才知道。
   * null 表示当时读不到（Controller 不可达）。
   */
  node: string | null
  /**
   * 最近一次探测失败的原因；成功时为 null。
   *
   * 🔴 为什么失败要留在快照里，而不是只回给发起那次操作的 UI：
   *    页面加载时的探测是**静默**的（见 `handleTabLoading`）—— 失败不报错、
   *    不弹提示，因为一次探测失败不该让正在打开的页面冒出一条无关告警。
   *    于是如果这里不留痕，用户会看到一个「未同步」和一个无从下手的状态：
   *    功能开了、授权给了、代理也开着了，它就是不动，而没有任何地方说得清
   *    为什么。这一格是那条静默路径唯一的出口。
   *
   * ⚠️ 失败时 `at` 仍然会被刷新（见 `failedSnapshot`）。这不是笔误：
   *    不刷新的话快照会一直"过期"，每次页面加载都重试一次 ——
   *    撞上 429 时那等于自己把自己限流得更狠。
   */
  error: NormalizedError | null
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
  /**
   * 主策略组快照（V0.2）。null 表示读不到，具体原因见 `groupError`。
   *
   * `coreStatus !== 'online'` 时必然为 null —— 切节点依赖 Controller，
   * 而 Controller 不可达在本项目里**不是错误**（ADR-23，named pipe 模式很常见）。
   * 因此这种情况下 UI 应显示「需要开启外部控制」而非报错。
   */
  group: GroupView | null
  /**
   * 读取策略组时的问题。
   *
   * 🔴 刻意与 `lastError` 分开两个字段，而不是复用后者。
   *    `lastError` 承载的是代理层告警，其中 `PROXY_LEAK_SUSPECTED` 必须由用户
   *    显式确认才消失（ADR-22）。若把「组名不存在」也写进 lastError，
   *    一次组读取失败就会**顶掉一条尚未确认的泄漏告警** ——
   *    用不重要的信息覆盖掉最重要的信息，是此方最不想造出的那种 bug。
   */
  groupError: NormalizedError | null
  /**
   * V0.9：时区同步的当前状态。
   *
   * 🔴 `null` 表示**功能未启用**，与「启用了但还没探测成功」是两件事：
   *    前者 UI 什么都不该显示，后者要显示「尚未同步」和一个可点的按钮。
   *    合成一个字段会让未启用的用户看到一条永远同步不上的提示。
   */
  timezone: TimezoneSnapshot | null
}

/** Mihomo `GET /version` 的响应体。 */
export interface MihomoVersion {
  /** 是否为 Meta（mihomo）版本。 */
  meta: boolean
  version: string
}

/**
 * 一个策略组（V0.2）。
 *
 * 只取本项目用得到的字段。Mihomo 的组对象还带 `history`、`extra`、`testUrl`、
 * `icon`、`expectedStatus` 等，V0.2 一个都不用 —— 少读一个字段就少一处将来
 * 因内核改动而失配的地方。延迟数据留给 V0.3。
 */
export interface ProxyGroup {
  name: string
  /**
   * 组类型：`Selector` / `URLTest` / `Fallback` / `LoadBalance` 等。
   *
   * ⚠️ 刻意声明为 `string` 而不是联合字面量：内核可能新增类型，
   *    而我们**不用**这个字段做能否切换的判定（ADR-29 把判定权交给内核），
   *    它只用于展示与排序提示。收紧成联合类型只会在内核加新类型时炸编译。
   */
  type: string
  /**
   * 当前选中的节点名。
   *
   * `LoadBalance` 组**没有**这个字段（它按连接分摊，不存在"当前选中"），
   * 所以类型是可空的，不是「理论上不会缺」。
   */
  now: string | null
  /** 组内所有成员名（可能是节点，也可能是嵌套的组）。 */
  all: readonly string[]
}

/** `GET /group` 的归一化结果。 */
export type GroupsResult =
  | { readonly ok: true; readonly groups: readonly ProxyGroup[] }
  | { readonly ok: false; readonly error: NormalizedError }

/**
 * 主策略组的当前状态快照，供 Popup 渲染节点列表。
 *
 * 与 `ProxyGroup` 分开，因为 Popup 需要的是「已解析好、可直接渲染」的形态：
 * 组不存在 / 未配置 / 内核不可达都是**正常分支**而非异常，
 * 用 `null` + `StatusSnapshot.groupError` 表达，不抛。
 */
export interface GroupView {
  name: string
  type: string
  now: string | null
  nodes: readonly string[]
  /**
   * 各节点的最近延迟，毫秒（V0.3）。
   *
   * 来自 `/group` 响应里自带的 `history`，**不需要额外请求**（ADR-32）。
   * 值为 `null` 表示内核没有该节点的历史记录（从未测过或最近一次失败）。
   * 用 `null` 而不是 `0`：`0` 会被渲染成"0ms"，看起来像极快。
   */
  latency: Readonly<Record<string, number | null>>
  /**
   * 各节点的协议原文（V0.7）：`Vless` / `Hysteria2` / `Trojan` …
   *
   * 与 `latency` 同源 —— 都出自 `/proxies` 的同一份响应，不额外发请求。
   * 这里存内核原文，缩写（`Vless` → `VLESS`）留给展示层。
   *
   * 空字符串表示**明确不该显示徽章**：该成员是嵌套的策略组或内核内置出口，
   * 两者都没有"协议"可言。用 `''` 而不是省掉这个键 —— 省掉的键无法与
   * 「读不到」区分，而这两种情形的正确渲染不同（前者留空位，后者也留空位，
   * 但将来若要区分就没有余地了）。
   */
  protocol: Readonly<Record<string, string>>
}

/**
 * `GET /proxies` 里本项目用得到的部分（V0.7）。
 *
 * 一次请求两用：延迟取自 `history`，协议取自 `type`。分成两个字段而不是
 * 两次请求 —— 那份响应是全部 proxy 的字典，一份大订阅几百条，
 * 为了两个字段拉两遍毫无必要。
 */
export interface NodeMeta {
  latency: Readonly<Record<string, number | null>>
  protocol: Readonly<Record<string, string>>
}

/**
 * 一个订阅（proxy provider）（V0.6）。
 *
 * 刻意**不含订阅 URL** —— 内核的 `/providers/proxies` 响应里本来也没有，
 * 而这正是本项目乐于接受的限制：不经手就不会泄漏（ADR-34）。
 */
export interface ProviderView {
  name: string
  /** 该订阅提供的节点数。 */
  nodeCount: number
  /** 最近一次更新时间（ISO 字符串）；内核没给就是 null。 */
  updatedAt: string | null
  /**
   * `vehicleType`：`HTTP` / `File` / `Compatible` / `Inline`（取自内核源码的枚举）。
   *
   * - `HTTP`       → 远端订阅，可更新
   * - `Compatible` → 内核给配置里 `proxies:` 数组套的隐式 provider
   * - `File`       → 从本机文件读
   * - `Inline`     → 配置里内联的 payload
   */
  type: string
  /**
   * 能否从这里触发更新。只有 `HTTP` 类型可以 —— 其余没有远端可拉。
   *
   * 🔴 刻意保留不可更新的项**并标注**，而不是过滤掉。
   *   过滤掉的话，用户（比如用 Clash Verge 的人，它会把订阅在外部拉好、
   *   展平成 `proxies:` 再交给内核）会看到"没有任何订阅"——
   *   而他明明有订阅。那句话**技术上正确但实际误导**，
   *   读起来像"这功能坏了"。列出来并说明为什么不能更新，
   *   才是如实告知。
   */
  updatable: boolean
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

/**
 * 一条活动连接的归一化视图（V0.8）。
 *
 * 只取渲染「此刻什么在走代理」所需的字段。内核的 `/connections` 每条还带
 * `id`、`start`、`metadata` 里的一堆网络细节，UI 一概不用 —— 少读一个字段
 * 就少一处将来因内核改动而失配的地方（与 `ProxyGroup` 同一条纪律）。
 *
 * 🔴 `host` / `chain` / `rule` 全部来自内核、间接来自访问的站点，是**不可信输入**，
 *    渲染时只能用 textContent。
 */
export interface ConnectionView {
  /** 稳定标识，用作列表 key；来自内核的连接 id。 */
  id: string
  /** 目标主机；内核没给 host 时回退到 `destinationIP`。 */
  host: string
  /**
   * 出口链：从**实际出口**到策略组，例如 `["🇯🇵JP-1", "EXIT-B"]`。
   * 空数组表示内核没给（脏条目已在解析层跳过，正常不会空）。
   */
  chain: readonly string[]
  /** 命中的规则类型，如 `DOMAIN-SUFFIX` / `ProcessName` / `Match`。 */
  rule: string
  /** 这条连接的累计上/下行字节数。 */
  upload: number
  download: number
  /**
   * 是否直连出网。
   *
   * 判据是出口链里含 `DIRECT` —— 直连也会作为一条连接出现在 `/connections` 里，
   * 而对一个「防泄漏」工具来说，让用户一眼看出**哪些流量没走代理**正是重点。
   */
  isDirect: boolean
}

/**
 * `GET /connections` 的归一化结果（V0.8）。
 *
 * `uploadTotal` / `downloadTotal` 是内核自启动以来的累计值，直接透传 ——
 * 它是内核维度而非本浏览器维度（与切节点同属「效果逸出浏览器」，ADR-28），
 * UI 对此要有明示。
 */
export type ConnectionsResult =
  | {
      readonly ok: true
      readonly connections: readonly ConnectionView[]
      readonly uploadTotal: number
      readonly downloadTotal: number
    }
  | { readonly ok: false; readonly error: NormalizedError }


/**
 * 自检的一项结论（V0.8.0）。
 *
 * `key` 存的是**文案 key** 而不是人话：判断发生在 background，翻译发生在
 * UI，两者之间只传中间的语义。这样同一个结论在不同语言下自然正确，
 * 也让"哪一步没过"变成可以测试的东西 —— 而拼好的句子不行。
 *
 * 类型写成 string 而不是 `MessageKey`：`i18n.ts` 引用 `types.ts`，
 * 反过来引会成环。代价是 UI 那边要断言一次，收益是这张依赖图保持单向。
 */
export interface SelfCheckStep {
  readonly key: string
  readonly ok: boolean
  readonly params?: Readonly<Record<string, string | number>>
}

/**
 * 在页面上实测到的身份（V0.8.0）。
 *
 * 这是自检里唯一**不能靠推断得出**的部分：前面几项问的是"配置对不对"，
 * 它问的是"页面里现在到底是什么"。两者可能不一致 —— 而那正是用户
 * 最需要知道的事（"我全配好了，为什么它还是北京时间"）。
 */
export interface ObservedIdentity {
  readonly timezone: string
  readonly locale: string
  readonly language: string
}

/**
 * 自检报告（V0.8.0）。
 *
 * 存在的理由：这个功能的每一种失败都是**静默**的 —— 不报错、不弹窗，
 * 页面照常打开，只是时区没变。在此之前，想知道"到底卡在哪一步"只有
 * 一个办法：打开目标页面的控制台手敲几行代码。
 */
export interface SelfCheckReport {
  /** 被检查的页面地址；清单里的站点一个都没打开时为 null。 */
  readonly url: string | null
  /** 按执行顺序记录每一步的结论。 */
  readonly steps: readonly SelfCheckStep[]
  /** 页面里实测到的值；读不到（没权限、页面已关闭）时为 null。 */
  readonly observed: ObservedIdentity | null
}
