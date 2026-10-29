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
  /*
   * 默认关闭（V0.9）。理由不是保守，是这个功能的代价与其余功能不同类：
   * 它会向第三方发请求、并在目标页面里执行脚本。默认开启等于替用户
   * 接受了这两件事，而安装时用户看到的那句「只访问 127.0.0.1」就不再成立。
   */
  timezoneSyncEnabled: false,
  localeSyncEnabled: false,
  /*
   * 语言同步默认关，与时区不同的待遇 —— 理由写在 `Settings` 的字段注释里：
   * 时区修的是一个真实的矛盾，语言是把一项本来不矛盾的东西改掉。
   *
   * 预填 chatgpt.com 而不是留空：这个功能的需求就来自「代理到海外节点后
   * ChatGPT 那边对不上」，留空会让每个新用户第一次打开都看到一个空清单
   * 和一句不知道填什么的提示。留一个能直接用的值，不想要的人删掉即可。
   */
  timezoneHosts: Object.freeze(['chatgpt.com']),
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
  /**
   * 时区快照（V0.9）。
   *
   * 与 lastError 同样需要持久化，但理由不同：这一个是**省钱**而不是防丢。
   * 一次探测要经代理走一个真实请求，而 Service Worker 空闲几十秒就会被回收；
   * 不落盘的话，每次唤醒后的第一次导航都要重新探测一遍。
   */
  timezone: 'lostproxy.timezone',
  /**
   * 节点名 → 曾经探测到的地理信息（V0.8.0）。
   *
   * 换回一个用过的节点时直接复用上次的结果，一次请求都不发。
   * 顺带缓解限流：免费地理服务按请求方 IP 计数，而我们的出口是共享的
   * 节点 IP —— 撞日限额是必然，不是概率。
   */
  zoneCache: 'lostproxy.zoneCache',
})

/**
 * 时区探测的目标服务（V0.9），**按顺序降级**。
 *
 * 选这两个的理由：
 *   - 响应里**直接给 IANA 时区名**（`"timezone": "Asia/Tokyo"`），
 *     不需要我们拿经纬度去反查时区表 —— 那需要打包一份 tz 数据库；
 *   - 免注册、无 key，响应体小；
 *   - `https://`，不额外泄漏到明文链路。
 *
 * 🔴 **为什么要两个而不是一个。** 这类免费服务按**请求方 IP** 限流，
 *    而我们的请求是从代理节点出去的 —— 节点 IP 由所有用户共享。
 *    在热门节点上撞到日限额不是小概率事件，是**一定**会发生的。
 *    只有一个源时，撞上的表现是「时区同步突然不动了」，且没有任何自愈路径。
 *
 * ⚠️ 两个请求**都必须经代理发出**，否则测到的是本机出口、得到的是用户
 *    真实时区 —— 那等于这个功能什么都没做，而且**更糟**：它会把本机时区
 *    当成正确答案注入页面，覆盖掉本来还对的旧值。`direct` 模式下我们
 *    根本不探测。
 *
 * ⚠️ 代价必须让用户知道：这两个域名会看到你的出口 IP。README 与设置页
 *    都写明，且该功能默认关闭。
 */
export const TIMEZONE_PROBE_URLS: readonly string[] = Object.freeze([
  'https://ipinfo.io/json',
  // 备用源。字段同为 timezone，响应体略大但格式稳定。
  'https://ipapi.co/json/',
])

/**
 * 探测域名，用于**强制它们走代理**。
 *
 * 🔴 为什么需要这一条：直连清单是用户自己填的，而"让这个域名直连"是一个
 *    完全合理的诉求（有人会把 `*.io` 加进去，或者单独放行 `ipinfo.io`）。
 *    一旦命中，探测就从本机发出 —— 测到的是用户自己的时区，而功能看起来
 *    一切正常。这是本项目最坏的失败形态：静默、且结果看起来是正确的。
 *
 *    Firefox 那边同理：`proxy.onRequest` 里 `shouldBypassProxy` 命中就会
 *    返回 `{ type: 'direct' }`。
 *
 *    所以两个平台的路由判断都要在**用户规则之前**先看一眼这张表。
 *
 * ⚠️ 与 `TIMEZONE_PROBE_URLS` 的一致性由 `tests/timezone.test.ts` 的一条
 *    断言守着 —— 两处分开写是为了让这份清单可以出现在 PAC 脚本里，
 *    而那里只能放纯数据。
 */
export const TIMEZONE_PROBE_HOSTS: readonly string[] = Object.freeze([
  'ipinfo.io',
  'ipapi.co',
])

/**
 * 单个探测源的超时，毫秒。
 *
 * 比单源时代收紧（原 5000）：现在最坏要等 `源数 × 超时`，而这条路径在
 * 快照过期时会被页面加载撞上。7 秒已经是"这次注入多半赶不上"的时长，
 * 再长只是让页面等一个注定迟到的结果。
 */
export const TIMEZONE_PROBE_TIMEOUT_MS = 3500

/**
 * 时区快照的保鲜期，毫秒。
 *
 * 10 分钟的取舍：这个值同时决定两件事 ——
 *
 *   1. **多久会重新探测一次**。节点在外部客户端里被切换时，我们收不到
 *      任何通知，只能等它过期；太长会让「换了节点、时区没跟上」持续很久。
 *   2. **页面加载要等多久**。快照有效时注入走的是零请求的快路径；
 *      过期则要读一次 Controller 再发一次探测，那一段会推迟注入
 *      （见 `handleTabLoading` 的说明）。太短会让每次导航都变慢。
 *
 * 10 分钟是个折中：一天里普通用户最多多出几十次探测，而换节点后
 * 最坏等 10 分钟 —— 期间点一下设置页的「立即探测」即可立即纠正。
 */
/**
 * 节点缓存的条数上限。
 *
 * 24 条大致覆盖"常去的几个地区 × 几个节点"。超过就按探测时间淘汰最旧的 ——
 * 缓存是**加速手段**，不是数据，没有理由为它做复杂的淘汰策略。
 */
export const ZONE_CACHE_MAX_ENTRIES = 24

/**
 * 缓存条的保鲜期，24 小时。
 *
 * 为什么需要它：同一个节点名不代表同一个落地 IP —— 机场可能换机器、
 * 换线路，而节点名照旧。一天之后重新测一次是"宁可多一次请求"的选择；
 * 而在这之内复用，省下的正是限流风险最高的那部分请求。
 */
export const ZONE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export const TIMEZONE_SNAPSHOT_TTL_MS = 10 * 60 * 1000

/**
 * 注入域名清单的条数上限。
 *
 * 与 RULE_MAX_COUNT 相比刻意小得多：每一条都会变成一次
 * `chrome.permissions.request` 里的 origin，并向浏览器登记一个
 * host permission。几百条不是"慢"，是让授权弹窗本身不可读。
 */
export const TIMEZONE_HOST_MAX = 20

/** 单个注入域名的长度上限（RFC 1035 全限定域名上限 + 余量）。 */
export const TIMEZONE_HOST_MAX_LENGTH = 260

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
 * 「连接」标签打开时的轮询间隔（V0.8）。
 *
 * 2 秒：连接列表要够「实时」才有观察价值，但 `/connections` 是本机回环上的
 * 快照请求，2 秒一次的开销可忽略。只在该标签可见时轮询（见 popup.ts），
 * 不在后台常跑。
 */
export const CONNS_POLL_MS = 2000

/**
 * 状态标签里迷你速率曲线保留的采样点数（V0.8）。
 *
 * 30 点 × 2 秒 ≈ 最近一分钟的趋势。曲线是「刚才网速大致怎么走的」的即时观感，
 * 不是完整历史，所以固定窗口、旧点丢弃就够了。
 */
export const SPARK_POINTS = 30


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
