/**
 * 轻量 i18n。
 *
 * 为什么不用官方的 `chrome.i18n` + `_locales/`：
 *   `chrome.i18n.getMessage()` 读的是**浏览器 UI 语言**，用户无法在扩展内切换。
 *   而需求是让用户手动选中文/英文，所以必须自己实现。
 *
 * 设计要点：
 *
 * 1. **英文字典是唯一真源**，`MessageKey` 从它推导。
 *    中文字典声明为 `Record<keyof typeof EN, string>`，
 *    因此**漏翻任何一条都会编译失败** —— 不需要靠人工核对两份字典。
 *
 * 2. **错误信息只在 UI 层翻译**。background 产出的是 `key` + `params`
 *    （见 shared/errors.ts），它不需要知道用户选了什么语言。
 *    这一点很关键：`lastError` 会被持久化，若存的是已翻译的字符串，
 *    用户切换语言后旧告警就会停留在旧语言里。
 *
 * 3. 插值用 `{name}` 占位符，不引模板引擎。
 */

/** 用户的语言偏好。'auto' 表示跟随浏览器。 */
export type Language = 'auto' | 'zh' | 'en'

/** 实际使用的语言（'auto' 解析后的结果）。 */
export type Locale = 'zh' | 'en'

/**
 * 英文文案 —— 字典的唯一真源。
 *
 * 命名约定：`区域.用途`。保持扁平，不做嵌套——
 * 嵌套在类型推导上更麻烦，而这个项目的文案量远不到需要分层的程度。
 */
const EN = {
  // ---- 通用 ----
  'common.brand': 'LostProxy',
  'common.settings': 'Settings',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.saved': 'Saved.',
  'common.clear': 'Clear',
  'common.dismiss': 'Dismiss',
  'common.notModified': 'Not Modified',

  // ---- Popup ----
  'popup.scopeBadge': 'Browser Only',
  'popup.proxyLabel': 'Browser Proxy',
  'popup.coreChecking': 'Checking Mihomo…',
  'popup.coreOnline': 'Mihomo Online',
  'popup.coreUnavailable': 'Core status unavailable',
  'popup.coreMisconfigured': 'Mihomo controller misconfigured',
  'popup.coreNote':
    "Your client isn't exposing an HTTP controller. The proxy still works — this only hides the version and node info.",
  'popup.modeLabel': 'Current Mode',
  'popup.modeDirect': 'Direct',
  'popup.modeBrowserOnly': 'Browser Only',
  'popup.modeInconsistent': 'Inconsistent',
  'popup.webrtcLabel': 'WebRTC',
  'popup.webrtcLocked': 'Locked',
  'popup.webrtcUnlocked': 'Unlocked',
  'popup.webrtcOff': 'Lock disabled',
  'popup.systemProxy': 'System Proxy',
  'popup.tun': 'TUN',

  // ---- V0.2 节点切换 ----
  'popup.nodeSectionLabel': 'Node',
  'popup.nodeLoading': 'Loading nodes…',
  'popup.nodeSwitching': 'Switching…',
  'popup.nodeCurrent': 'Current',
  'popup.nodeGroupPrefix': 'Group',
  'popup.nodeNeedsController':
    'Node switching needs the Mihomo external controller. Enable it in your Mihomo client, then set the controller port in Settings.',
  'popup.nodeNeedsGroup': 'Pick your primary proxy group in Settings to switch nodes here.',
  'popup.nodeOpenSettings': 'Open Settings',
  'popup.nodeEmpty': 'This group has no members.',
  'popup.nodeRetry': 'Retry',
  /*
   * ADR-28 要求的边界披露。措辞刻意具体到「用同一个内核的其他程序」而非
   * 含糊的「可能有影响」—— 用户要能据此判断自己是否受影响，
   * 而含糊的警告只会被无视。
   */
  'popup.nodeScopeNotice':
    'Switching a node changes the core itself, so anything else using this core is affected too — unlike the proxy toggle above, which only affects this browser.',

  // ---- Options ----
  'options.title': 'LostProxy Settings',
  'options.lede':
    'Browser-scoped proxy. Only this browser is affected — Windows system proxy, TUN and the routing table are never modified.',
  'options.groupProxy': 'Local Proxy',
  'options.proxyHint': "Mihomo's mixed-port. This browser sends its web traffic here.",
  'options.proxyHost': 'Proxy Host',
  'options.proxyPort': 'Proxy Port',
  'options.groupController': 'Mihomo Controller',
  'options.controllerHint':
    "Mihomo's external-controller. Used only to read status — never to route traffic. This is a separate port from the proxy port.",
  'options.controllerHost': 'Controller Host',
  'options.controllerPort': 'Controller Port',
  'options.controllerSecret': 'Controller Secret',
  'options.secretSaved':
    'A secret is saved. Type a new one to replace it, or leave blank to keep it.',
  'options.secretNone':
    'No secret configured. Leave blank if your Mihomo config has no secret field.',
  'options.secretPlaceholderSaved': '••••••••',
  'options.secretPlaceholderNone': 'Leave empty if Mihomo has no secret',
  'options.secretCleared': 'Secret cleared.',
  'options.testCore': 'Test Mihomo',
  'options.testing': 'Testing…',
  'options.testOnline': 'Online · {version}',
  'options.testSaveFirst': 'Save first — this tests the saved configuration.',
  'options.groupLeak': 'Leak Protection',
  'options.webrtcLockLabel': 'Lock WebRTC while the proxy is on',
  'options.webrtcLockHint':
    'Forces WebRTC media through the proxy. Without this, a web page can discover your real IP through WebRTC even while the proxy is on. Since HTTP proxies do not carry UDP, this effectively disables UDP for WebRTC — video calls may lose quality. The lock is only applied while the proxy is switched on.',
  'options.groupLanguage': 'Language',
  'options.languageLabel': 'Interface language',
  'options.langAuto': 'Automatic (follow browser)',

  // ---- 错误 ----
  'error.proxyControlledByOther':
    'Proxy settings are controlled by another extension. LostProxy will not override it. Disable the other proxy extension and try again.',
  'error.proxyNotControllable':
    'Proxy settings are controlled by policy and cannot be changed by any extension.',
  'error.proxyWriteFailed': 'Failed to apply proxy settings: {reason}',
  'error.privacyWriteFailed': 'Failed to apply WebRTC policy: {reason}',
  'error.privacyControlledByOther':
    'WebRTC policy is controlled by another extension. LostProxy will not override it.',
  'error.privacyNotControllable':
    'WebRTC policy is controlled by policy and cannot be changed by any extension.',
  'error.proxyBlocked':
    'Cannot reach the local proxy. Your real IP was not exposed — the request was blocked. Check that Mihomo is running and that its mixed-port matches the proxy address shown above.',
  'error.proxyLeakSuspected':
    'The proxy failed and the browser used a DIRECT connection instead. Your real IP may have been exposed to the sites that were loading.',
  'error.coreOffline':
    'Core Offline — cannot reach the Mihomo controller at {host}:{port}. Check that Mihomo is running, and that this port matches its external-controller. It is a separate port from the proxy port.',
  'error.coreAuthFailed': 'Mihomo API authentication failed. Please check Controller Secret.',
  'error.coreBadResponse':
    'Mihomo controller responded with an unexpected payload. Is the port pointing at the external-controller?',
  'error.stateMismatch':
    'Proxy is switched ON but the browser is not using LostProxy settings. Toggle it off and on again.',
  'error.groupNotConfigured':
    'No proxy group selected yet. Open Settings and pick your primary proxy group.',
  'error.groupNotFound':
    'Proxy group "{group}" no longer exists in the core. This usually means the subscription changed. Pick a group again in Settings.',
  'error.groupNotSelectable':
    'The core will not let "{group}" be switched manually — groups of this kind pick a node automatically. Choose a Selector group in Settings instead.',
  'error.selectFailed': 'Could not switch to "{node}". The core rejected the request.',
  'error.malformedMessage': 'Malformed message.',
  'error.unsupportedMessage': 'Unsupported message type.',
  'error.unknown': 'Something went wrong: {reason}',

  // ---- 设置校验 ----
  'validation.proxyHost': 'Proxy Host is invalid. Enter a hostname or IP without scheme, e.g. 127.0.0.1',
  'validation.proxyPort': 'Proxy Port must be an integer between {min} and {max}.',
  'validation.controllerHost':
    'Controller Host is invalid. Enter a hostname or IP without scheme, e.g. 127.0.0.1',
  'validation.controllerPort': 'Controller Port must be an integer between {min} and {max}.',
  'validation.controllerSecret': 'Controller Secret must be a string.',
  'validation.webRtcLock': 'WebRTC lock must be a boolean.',
  'validation.language': 'Language must be auto, zh or en.',
  'validation.primaryGroup': 'Primary proxy group must be a string.',

  // ---- V0.2 Settings：主策略组 ----
  'options.groupSectionTitle': 'Proxy Group',
  'options.groupSectionHint':
    'Which policy group LostProxy switches nodes in. Group names differ between providers, so this is never guessed — load the list and pick yours.',
  'options.primaryGroupLabel': 'Primary Proxy Group',
  'options.groupLoadButton': 'Load groups from core',
  'options.groupLoading': 'Loading…',
  'options.groupNonePlaceholder': 'Not selected',
  'options.groupLoadedCount': 'Loaded {count} group(s).',
  'options.groupNeedsController':
    'Cannot reach the controller. Save the controller host, port and secret above first, then load groups.',
  /*
   * 非 Selector 组仍然列出来（ADR-29：判定权归内核），但标注类型，
   * 让用户在点了才报错之前就有机会自己看出来。
   */
  'options.groupTypeNote': '{type} — picks nodes automatically, cannot be switched by hand',
  'options.groupTypeSelector': 'Selector — switchable',
} as const

/** 所有可用文案键。由英文字典自动推导，无需手工维护联合类型。 */
export type MessageKey = keyof typeof EN

/**
 * 全部文案键的运行时列表。
 *
 * 供测试遍历用——编译期已经保证两份字典的键集合一致，
 * 但**插值占位符是否一致**编译期查不出来（英文有 {host} 而中文漏了，
 * 用户就会看到一句缺了地址的文案）。那条只能靠运行时测试兜住。
 */
export const ALL_MESSAGE_KEYS = Object.keys(EN) as readonly MessageKey[]

/**
 * 中文文案。
 *
 * ⚠️ 类型声明为 `Record<MessageKey, string>` —— 漏翻任何一条都会编译失败。
 * 这比"记得去核对两份字典"可靠得多。
 */
const ZH: Record<MessageKey, string> = {
  // ---- 通用 ----
  'common.brand': 'LostProxy',
  'common.settings': '设置',
  'common.save': '保存',
  'common.saving': '保存中…',
  'common.saved': '已保存',
  'common.clear': '清除',
  'common.dismiss': '知道了',
  'common.notModified': '未修改',

  // ---- Popup ----
  'popup.scopeBadge': '仅本浏览器',
  'popup.proxyLabel': '浏览器代理',
  'popup.coreChecking': '正在检查 Mihomo…',
  'popup.coreOnline': 'Mihomo 已连接',
  'popup.coreUnavailable': '核心状态不可读',
  'popup.coreMisconfigured': 'Mihomo 控制端配置有误',
  'popup.coreNote':
    '你的客户端没有开放 HTTP 控制端。代理仍在正常工作 —— 只是读不到版本和节点信息。',
  'popup.modeLabel': '当前模式',
  'popup.modeDirect': '直连',
  'popup.modeBrowserOnly': '仅本浏览器',
  'popup.modeInconsistent': '状态不一致',
  'popup.webrtcLabel': 'WebRTC',
  'popup.webrtcLocked': '已锁定',
  'popup.webrtcUnlocked': '未锁定',
  'popup.webrtcOff': '锁定已关闭',
  'popup.systemProxy': '系统代理',
  'popup.tun': 'TUN',

  // ---- V0.2 节点切换 ----
  'popup.nodeSectionLabel': '节点',
  'popup.nodeLoading': '正在读取节点…',
  'popup.nodeSwitching': '正在切换…',
  'popup.nodeCurrent': '当前',
  'popup.nodeGroupPrefix': '策略组',
  'popup.nodeNeedsController':
    '切换节点需要 Mihomo 的外部控制。请在 Mihomo 客户端里开启它，然后在设置里填好 Controller 端口。',
  'popup.nodeNeedsGroup': '到设置里选一个主策略组，就能在这里切节点了。',
  'popup.nodeOpenSettings': '打开设置',
  'popup.nodeEmpty': '这个组里没有成员。',
  'popup.nodeRetry': '重试',
  'popup.nodeScopeNotice':
    '切换节点改的是内核本身，所有在用这个内核的程序都会跟着变 —— 与上面那个只影响本浏览器的代理开关不同。',

  // ---- Options ----
  'options.title': 'LostProxy 设置',
  'options.lede':
    '浏览器级代理。只影响当前浏览器 —— 不会修改 Windows 系统代理、TUN 或路由表。',
  'options.groupProxy': '本机代理',
  'options.proxyHint': 'Mihomo 的混合端口（mixed-port）。本浏览器的网页流量发往这里。',
  'options.proxyHost': '代理地址',
  'options.proxyPort': '代理端口',
  'options.groupController': 'Mihomo 控制端',
  'options.controllerHint':
    'Mihomo 的 external-controller，仅用于读取状态，不承载任何流量。它与代理端口是两个互相独立的端口。',
  'options.controllerHost': '控制端地址',
  'options.controllerPort': '控制端端口',
  'options.controllerSecret': '控制端密钥',
  'options.secretSaved': '已保存一个密钥。输入新值可替换，留空则保持不变。',
  'options.secretNone': '未配置密钥。如果你的 Mihomo 配置里没有 secret 字段，留空即可。',
  'options.secretPlaceholderSaved': '••••••••',
  'options.secretPlaceholderNone': 'Mihomo 无密钥时留空',
  'options.secretCleared': '密钥已清除',
  'options.testCore': '测试连接',
  'options.testing': '测试中…',
  'options.testOnline': '已连接 · {version}',
  'options.testSaveFirst': '请先保存 —— 测试使用的是已保存的配置。',
  'options.groupLeak': '泄漏防护',
  'options.webrtcLockLabel': '代理开启时锁定 WebRTC',
  'options.webrtcLockHint':
    '强制 WebRTC 媒体流走代理。不开启的话，网页可以通过 WebRTC 拿到你的真实 IP —— 即使代理正开着。由于 HTTP 代理不承载 UDP，实际效果是为 WebRTC 禁用 UDP，视频通话质量可能下降。该锁只在代理开启期间生效。',
  'options.groupLanguage': '界面语言',
  'options.languageLabel': '语言',
  'options.langAuto': '自动（跟随浏览器）',

  // ---- 错误 ----
  'error.proxyControlledByOther':
    '代理设置正被另一个扩展控制，LostProxy 不会强行覆盖。请先停用那个代理扩展再试。',
  'error.proxyNotControllable': '代理设置被策略（Policy）锁定，任何扩展都无法修改。',
  'error.proxyWriteFailed': '写入代理设置失败：{reason}',
  'error.privacyWriteFailed': '写入 WebRTC 策略失败：{reason}',
  'error.privacyControlledByOther': 'WebRTC 策略正被另一个扩展控制，LostProxy 不会强行覆盖。',
  'error.privacyNotControllable': 'WebRTC 策略被策略（Policy）锁定，任何扩展都无法修改。',
  'error.proxyBlocked':
    '连不上本机代理。你的真实 IP 没有泄漏 —— 该请求已被阻止。请确认 Mihomo 正在运行，且它的混合端口与上面显示的代理地址一致。',
  'error.proxyLeakSuspected':
    '代理失败，浏览器改用了直连。你的真实 IP 可能已经暴露给当时正在加载的站点。',
  'error.coreOffline':
    '核心离线 —— 连不上 {host}:{port} 上的 Mihomo 控制端。请确认 Mihomo 正在运行，且这个端口与它的 external-controller 一致。它与代理端口是两个独立的端口。',
  'error.coreAuthFailed': 'Mihomo API 认证失败，请检查控制端密钥。',
  'error.coreBadResponse':
    'Mihomo 控制端返回了预期之外的内容。这个端口指向的确实是 external-controller 吗？',
  'error.stateMismatch': '开关是开启状态，但浏览器并没有在使用 LostProxy 的设置。请关掉再重新开启。',
  'error.groupNotConfigured': '还没选主策略组。到设置里选一个，就能在这里切节点了。',
  'error.groupNotFound':
    '策略组「{group}」在内核里已经不存在了。通常是订阅变更导致的组名改变，请到设置里重新选一个组。',
  'error.groupNotSelectable':
    '内核不允许手动切换「{group}」—— 这类组会自动挑选节点。请到设置里改选一个 Selector 类型的组。',
  'error.selectFailed': '切换到「{node}」失败，内核拒绝了这次请求。',
  'error.malformedMessage': '消息格式不正确。',
  'error.unsupportedMessage': '不支持的消息类型。',
  'error.unknown': '出错了：{reason}',

  // ---- 设置校验 ----
  'validation.proxyHost': '代理地址无效。请填主机名或 IP，不要带协议前缀，例如 127.0.0.1',
  'validation.proxyPort': '代理端口必须是 {min} 到 {max} 之间的整数。',
  'validation.controllerHost': '控制端地址无效。请填主机名或 IP，不要带协议前缀，例如 127.0.0.1',
  'validation.controllerPort': '控制端端口必须是 {min} 到 {max} 之间的整数。',
  'validation.controllerSecret': '控制端密钥必须是字符串。',
  'validation.webRtcLock': 'WebRTC 锁必须是布尔值。',
  'validation.language': '语言必须是 auto、zh 或 en。',
  'validation.primaryGroup': '主策略组必须是字符串。',

  // ---- V0.2 设置：主策略组 ----
  'options.groupSectionTitle': '策略组',
  'options.groupSectionHint':
    'LostProxy 在哪个策略组里切节点。不同机场的组名各不相同，所以此处不做任何猜测 —— 点下面的按钮把列表拉下来，自己选。',
  'options.primaryGroupLabel': '主策略组',
  'options.groupLoadButton': '从内核读取策略组',
  'options.groupLoading': '读取中…',
  'options.groupNonePlaceholder': '尚未选择',
  'options.groupLoadedCount': '读到 {count} 个策略组。',
  'options.groupNeedsController':
    '连不上控制端。请先保存上面的控制端地址、端口和密钥，再读取策略组。',
  'options.groupTypeNote': '{type} —— 自动挑节点，不能手动切换',
  'options.groupTypeSelector': 'Selector —— 可手动切换',
}

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en: EN, zh: ZH }

/** 文案插值参数。 */
export type MessageParams = Readonly<Record<string, string | number>>

/** 把 `{name}` 占位符替换成实际值。找不到的占位符原样保留，便于定位问题。 */
function interpolate(template: string, params?: MessageParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * 把语言偏好解析成实际使用的语言。
 *
 * 'auto' 时读 `navigator.language`。在 Service Worker 里它是可用的；
 * 在测试的 node 环境里可能缺失，所以做了兜底 —— 不能因为拿不到语言就崩。
 */
export function resolveLocale(preference: Language): Locale {
  if (preference === 'zh' || preference === 'en') return preference

  const browserLanguage = globalThis.navigator?.language ?? 'en'
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 取一条文案。 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = DICTIONARIES[locale][key]

  // 未知 key 时返回 key 本身，而不是抛错。
  //
  // 理由：一条显示成 "error.somethingNew" 的告警仍然可诊断，
  // 而抛错会中断整段渲染、把界面卡在半成品状态。
  // 已经因为一个类似的中断留下过一个"空告警框"的 bug，不能再有第二次。
  // 正常情况下这条分支不可达 —— MessageKey 是从字典推导的，
  // 只有持久化的旧数据带来野 key 时才可能命中。
  if (typeof template !== 'string') return key

  return interpolate(template, params)
}

/** 绑定语言的翻译函数，供 UI 直接调用。 */
export function createTranslator(locale: Locale) {
  return (key: MessageKey, params?: MessageParams): string => translate(locale, key, params)
}

/** 语言选项列表，供 Settings 渲染下拉框。 */
export const LANGUAGE_OPTIONS: readonly Language[] = ['auto', 'zh', 'en']

/** 语言在下拉框里的显示名。刻意用各自的母语标注，不随界面语言变化。 */
export function languageLabel(language: Language, locale: Locale): string {
  if (language === 'auto') return translate(locale, 'options.langAuto')
  return language === 'zh' ? '中文' : 'English'
}
