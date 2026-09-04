/**
 * 全项目共享常量。
 *
 * 所有「魔法值」集中在此，禁止在业务代码里内联字面量——
 * 尤其是端口，技术方案 §22 Case 4 明确要求端口可由用户修改、不得硬编码。
 */

import type { Settings } from './types'

/**
 * 默认设置。对应技术方案 §11 的默认值表 + §6 的推荐 Mihomo 配置。
 *
 * webRtcLockEnabled 默认 true：本项目的价值主张是出口 IP 隔离，
 * 而 WebRTC 的默认策略会绕过代理暴露真实 IP（architecture.md ADR-05）。
 * 默认关闭这个锁等于默认留一个泄漏口。
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  proxyHost: '127.0.0.1',
  proxyPort: 7890,
  controllerHost: '127.0.0.1',
  controllerPort: 9090,
  controllerSecret: '',
  webRtcLockEnabled: true,
  // 'auto' = 跟随浏览器语言。首次安装时中文环境自动显示中文。
  language: 'auto',
  /*
   * 空字符串 = 用户还没选主策略组。
   *
   * 🔴 这里**必须**留空，不能猜一个常见组名。技术方案 §16 明令禁止硬编码
   *    代理组名称：不同机场的组名从 "Proxy" 到 "🚀 节点选择" 到 "PROXY" 各式各样，
   *    猜中了省用户一次点击，猜错了就表现为「这功能是坏的」——
   *    而后者远比前者常见，且用户无从判断是自己配错还是插件有 bug。
   */
  primaryGroup: '',
  /*
   * 默认 global —— 与 V0.1 的行为完全一致。
   * 升级到 V0.4 不会改变任何既有用户的实际网络状态，
   * 分流是用户主动选择才启用的东西，不该由一次升级替他决定。
   */
  routingMode: 'global',
  directRules: Object.freeze([]),
})

/**
 * PAC 直连规则的限制。
 *
 * 这两个数字不是随手定的，它们限制的是**会被嵌进 PAC 脚本的用户输入**：
 *   - 单条长度：域名最长 253 字符（RFC 1035 全限定域名上限），留点余量
 *   - 条数：PAC 脚本每次请求都要执行，几百条查表仍然很快，
 *     但上限的意义在于挡住「粘贴了一整个 10 万行规则集」这类输入 ——
 *     那会让每个请求都变慢，而症状是"整个浏览器变卡"，极难归因。
 */
export const RULE_MAX_LENGTH = 260
export const RULE_MAX_COUNT = 500

/**
 * 规则允许的字符白名单（security.md §4.1 / ADR-33）。
 *
 * 🔴 刻意是**白名单**。黑名单漏一个字符就是一个 PAC 注入口，
 *   而注入成功的后果是「一切都直连」—— 语法合法，mandatory 拦不住，
 *   完全无声。
 */
export const RULE_ALLOWED_PATTERN = /^[A-Za-z0-9.*-]+$/

/**
 * 测速超时，毫秒。
 *
 * ⚠️ 上限 32767：内核侧是 `strconv.ParseInt(query.Get("timeout"), 10, 16)`，
 *    **16 位**。传 60000 会得到 400 Bad Request，而不是"超时时间很长"（ADR-32）。
 */
export const LATENCY_TIMEOUT_MS = 5000

/** 测速用的探测 URL。204 无响应体，是这类探活的惯例选择。 */
export const LATENCY_TEST_URL = 'https://www.gstatic.com/generate_204'

/**
 * 延迟分档阈值，毫秒。
 *
 * 分档只用于给数值上色以加速扫视；数值本身始终显示 ——
 * 色觉障碍用户看不出绿/黄/红，但能读数字（ADR 无编号，见 style.css 注释）。
 */
export const LATENCY_FAST_MS = 200
export const LATENCY_MEDIUM_MS = 500

/**
 * 协议名的展示缩写（V0.7）。
 *
 * 数据来自 `/proxies` 里每个节点自带的 `type` 字段 —— 那份响应扩展**本来就在请求**
 * （为了取延迟），所以显示协议不产生任何额外网络行为，理由与 ADR-32 同一条。
 *
 * 键是内核给的原文（Go 侧 `adapter.Type.String()`，首字母大写）；
 * 值取社区通用写法：协议缩写全大写，产品名保留驼峰。
 *
 * ⚠️ **这不是白名单。** 表里没有的 type 显示原文，见 `popup.ts` 的 `protocolBadge`。
 *    内核每加一个协议都会出现一个新 type，当白名单用会让新协议**静默不显示** ——
 *    显示 `Mieru` 比显示空白有用，哪怕没缩写。
 */
export const PROTOCOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  Vless: 'VLESS',
  Vmess: 'VMess',
  Trojan: 'Trojan',
  Shadowsocks: 'SS',
  ShadowsocksR: 'SSR',
  Hysteria: 'HY',
  Hysteria2: 'HY2',
  Tuic: 'TUIC',
  Snell: 'Snell',
  WireGuard: 'WG',
  Socks5: 'SOCKS5',
  Http: 'HTTP',
  Ssh: 'SSH',
  Mieru: 'Mieru',
  AnyTLS: 'AnyTLS',
})

/**
 * 不算协议的 `type` 值 —— 这些成员不显示协议徽章。
 *
 * 两类，都会合法地出现在成员位置上：
 *   - **策略组**（`Selector` / `URLTest` / …）：组可以嵌套。
 *   - **内置出口**（`DIRECT` / `REJECT` / `COMPATIBLE` / …）：内核内建的行为，不是协议。
 *
 * 之所以与 `PROTOCOL_LABELS` 分成两张表而不是只留白名单：两者的兜底方向**相反** ——
 * 未知协议要显示原文，未知组类型要不显示。所以必须是「排除表 + 兜底显示」。
 * 组还有一层更可靠的判据（成员名是否出现在组列表里），见 `orchestrator.ts`；
 * 这张表主要兜的是内置出口，它们不在组列表里。
 */
export const NON_PROTOCOL_TYPES: ReadonlySet<string> = new Set([
  'Selector',
  'URLTest',
  'Fallback',
  'LoadBalance',
  'Relay',
  'Direct',
  'Reject',
  'RejectDrop',
  'Compatible',
  'Pass',
  'PassRule',
  'Dns',
])

/**
 * Controller 端口探测的候选列表。
 *
 * 🔴 这是一个**白名单**，不是一个扫描范围。
 *   逐个试已知客户端的公开默认值，与「枚举用户机器上的端口」是两件事：
 *   我们不遍历区间，只验证下面这几个具体数字，且只连 127.0.0.1。
 *
 * 排序按命中概率：Clash Verge Rev 的默认值在最前，因为它是最常见的客户端，
 * 而它恰好**不用**本项目的历史默认值 9090 —— 这个落差正是「端口填错」
 * 成为头号失败原因的直接成因（test-plan §0.2）。
 */
export const CONTROLLER_PORT_CANDIDATES: readonly number[] = Object.freeze([
  9097, // Clash Verge Rev 默认
  9090, // mihomo / Clash 传统默认，也是本项目的默认值
  9091, // 常见的手动改法
  9099,
  59090, // 部分 GUI 的随机高位端口习惯
])

/**
 * 单次端口探测的超时，毫秒。
 *
 * 刻意远小于 CORE_PROBE_TIMEOUT_MS：候选有五六个，每个等 3 秒
 * 会让用户以为界面卡死。而本机回环上「有服务在听」的判定是毫秒级的 ——
 * 连不上时 TCP 会立刻拒绝，根本不会走到超时。
 */
export const PORT_PROBE_TIMEOUT_MS = 600

/**
 * chrome.storage.local 的键名。
 *
 * 加 `lostproxy.` 前缀是为了在同一 profile 里与其他扩展/未来字段隔离。
 * enabled 与 settings 分开存储，对应 §28 Task 03 的四个独立 API。
 *
 * lastError 必须持久化：chrome.proxy.onProxyError 可能在 Service Worker
 * 被终止前触发，若只留在内存里，Popup 下次打开就读不到那次告警了——
 * 而 fatal=false 的 proxy error 恰恰意味着「已经发生过一次直连」，
 * 是最不能丢的信息（architecture.md ADR-04）。
 */
export const STORAGE_KEYS = Object.freeze({
  settings: 'lostproxy.settings',
  enabled: 'lostproxy.enabled',
  lastError: 'lostproxy.lastError',
})

/**
 * 必须绕过代理的本机地址。
 *
 * 这三个是**与浏览器无关的事实**：`127.0.0.1` 与 `[::1]` 是 IP 字面量，
 * 任何"简单主机名"类的通配都覆盖不到它们（Chromium 的 `<local>` 令牌就是
 * 这样定义的：「不含点且不是 IP 字面量」）。少绕过任何一项都会导致
 * 「扩展访问 Controller 的请求被再次送进代理链」，形成自环 ——
 * 且不会报错，只会诡异地卡住。详见 architecture.md ADR-02。
 *
 * ⚠️ 这里刻意**不含** `<local>`：那是 Chromium bypassList 的语法令牌，
 *    Firefox 的 `passthrough` 不认它。平台特有的令牌由平台自己拼上
 *    （见 `background/platform/chromium.ts` 的 `PROXY_BYPASS_LIST`），
 *    本常量只陈述"哪些地址是本机"这个跨平台事实。
 *
 * PAC 脚本也直接用这份清单 —— 它需要的正是不带令牌的纯地址表。
 */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze([
  'localhost',
  '127.0.0.1',
  '[::1]',
])

/** Controller 探活超时。3 秒足够本机回环，再长只是让 UI 干等。 */
export const CORE_PROBE_TIMEOUT_MS = 3000


/**
 * 瞬时告警在自愈前必须"静默"多久。
 *
 * 用于 Controller 不可观测（例如客户端只开 named pipe）的场景：
 * 此时拿不到"Mihomo 在跑"的强证据，只能退化为时间判据。
 *
 * 之所以这个弱判据是安全的：若代理仍然坏着，这段时间内用户
 * 任何一次页面加载都会产生新的 onProxyError 并刷新时间戳，
 * 告警不会消失。也就是说时间窗口衡量的是"最近有没有真的在失败"。
 */
export const ALERT_STALE_AFTER_MS = 30_000

/*
 * 以下两个常量曾经在这里，现已搬到 `background/platform/chromium.ts`：
 *
 *   - WEBRTC_LOCKED_POLICY ('disable_non_proxied_udp')
 *   - SETTING_SCOPE        ('regular')
 *
 * 搬走的理由不是整理代码，而是**它们的值本身就是 Chromium 特有的**：
 *   - Firefox 里同名的 WebRTC 策略值语义更弱（Bugzilla 1452713），
 *     等价物是 `proxy_only` —— 抄过去会被接受、不报错、防护更弱；
 *   - Firefox 的 `BrowserSetting.set()` **根本没有** scope 参数。
 *
 * 留在 shared/ 会让人以为它们是跨平台契约，而"以为是共享的平台特有值"
 * 正是抄错的起点（architecture.md ADR-36）。
 */

/** 端口合法区间。 */
export const PORT_MIN = 1
export const PORT_MAX = 65535
