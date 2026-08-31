/**
 * chrome.storage.local 封装 —— 对应技术方案 §28 Task 03。
 *
 * 三条约束：
 *
 * 1. **只用 local，绝不用 sync**（security.md §2.1）。
 *    Controller Secret 属于本机凭据，同步到微软账号云端是不可接受的。
 *    tests/setup.ts 里把 chrome.storage.sync 做成一碰就抛错，作为编译期之外的护栏。
 *
 * 2. **无缓存**（architecture.md ADR-08）。
 *    MV3 的 Service Worker 会被随时终止，模块作用域的缓存不可信。
 *    每次调用都实打实读 storage。
 *
 * 3. **读宽容、写严格**。
 *    读取（coerceSettings）永不抛错：storage 里的数据可能来自旧版本、
 *    也可能被用户手工改坏，SW 不能因此起不来。
 *    写入（validateSettings）严格校验：用户输入的错误必须让他知道，
 *    而不是被静默纠正成默认值——那会让人以为端口改成功了。
 */

import { DEFAULT_SETTINGS, PORT_MAX, PORT_MIN, STORAGE_KEYS } from '../shared/constants'
import type { Language, MessageKey, MessageParams } from '../shared/i18n'
import type {
  NormalizedError,
  Settings,
  SettingsView,
  ValidationIssue,
} from '../shared/types'

/** 设置校验结果。失败时给出的是 i18n key，翻译交给 UI。 */
export type ValidationResult =
  | { readonly ok: true; readonly value: Settings }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] }

/** 主机名是否可用作代理/Controller 的 host。 */
function isValidHost(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const host = value.trim()
  if (host.length === 0) return false
  // 不允许内含空白，也不允许把 scheme 一起粘进来（"http://127.0.0.1" 是常见误填）。
  if (/\s/.test(host)) return false
  if (host.includes('://')) return false
  return true
}

/** 端口是否落在合法区间。刻意不排除任何具体端口——用户改端口是被允许的（§22 Case 4）。 */
function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX
  )
}

/** 语言偏好是否合法。 */
function isValidLanguage(value: unknown): value is Language {
  return value === 'auto' || value === 'zh' || value === 'en'
}

/**
 * 宽容解析：把任意来源的 raw 值强制成合法 Settings。
 *
 * 非法或缺失的字段逐个回退到默认值，**永不抛错**。
 * 用于从 storage 读取——那里的数据不受我们控制。
 */
export function coerceSettings(raw: unknown): Settings {
  const input = (
    typeof raw === 'object' && raw !== null ? raw : {}
  ) as Partial<Record<keyof Settings, unknown>>

  return {
    proxyHost: isValidHost(input.proxyHost) ? input.proxyHost.trim() : DEFAULT_SETTINGS.proxyHost,
    proxyPort: isValidPort(input.proxyPort) ? input.proxyPort : DEFAULT_SETTINGS.proxyPort,
    controllerHost: isValidHost(input.controllerHost)
      ? input.controllerHost.trim()
      : DEFAULT_SETTINGS.controllerHost,
    controllerPort: isValidPort(input.controllerPort)
      ? input.controllerPort
      : DEFAULT_SETTINGS.controllerPort,
    // secret 刻意不 trim：它是凭据，我们无权擅自修改用户输入的内容。
    controllerSecret:
      typeof input.controllerSecret === 'string'
        ? input.controllerSecret
        : DEFAULT_SETTINGS.controllerSecret,
    webRtcLockEnabled:
      typeof input.webRtcLockEnabled === 'boolean'
        ? input.webRtcLockEnabled
        : DEFAULT_SETTINGS.webRtcLockEnabled,
    language: isValidLanguage(input.language) ? input.language : DEFAULT_SETTINGS.language,
  }
}

/**
 * 严格校验：把 patch 叠到 base 上并逐字段检查。
 *
 * ⚠️ 返回的是 i18n key，**不是**成品文案 —— 翻译在 UI 层做。
 *    且错误信息里**禁止**回显 controllerSecret 的内容（security.md §2.3）。
 */
export function validateSettings(patch: Partial<Settings>, base: Settings): ValidationResult {
  const issues: ValidationIssue[] = []
  const merged: Settings = { ...base, ...patch }
  const portRange: MessageParams = { min: PORT_MIN, max: PORT_MAX }

  const add = (key: MessageKey, params?: MessageParams): void => {
    issues.push(params === undefined ? { key } : { key, params })
  }

  if (patch.proxyHost !== undefined && !isValidHost(patch.proxyHost)) {
    add('validation.proxyHost')
  }
  if (patch.proxyPort !== undefined && !isValidPort(patch.proxyPort)) {
    add('validation.proxyPort', portRange)
  }
  if (patch.controllerHost !== undefined && !isValidHost(patch.controllerHost)) {
    add('validation.controllerHost')
  }
  if (patch.controllerPort !== undefined && !isValidPort(patch.controllerPort)) {
    add('validation.controllerPort', portRange)
  }
  if (patch.controllerSecret !== undefined && typeof patch.controllerSecret !== 'string') {
    // 注意：只报类型问题，绝不把值本身拼进消息。
    add('validation.controllerSecret')
  }
  if (patch.webRtcLockEnabled !== undefined && typeof patch.webRtcLockEnabled !== 'boolean') {
    add('validation.webRtcLock')
  }
  if (patch.language !== undefined && !isValidLanguage(patch.language)) {
    add('validation.language')
  }

  if (issues.length > 0) {
    return { ok: false, errors: issues }
  }

  return {
    ok: true,
    value: {
      ...merged,
      proxyHost: merged.proxyHost.trim(),
      controllerHost: merged.controllerHost.trim(),
    },
  }
}

/** 读取当前设置。storage 为空或数据损坏时返回默认值。 */
export async function getSettings(): Promise<Settings> {
  const record = await chrome.storage.local.get(STORAGE_KEYS.settings)
  return coerceSettings(record[STORAGE_KEYS.settings])
}

/**
 * 保存设置（部分更新）。
 *
 * 校验失败时**不写入任何内容**，storage 保持原样——
 * 半保存的配置比拒绝保存更危险（可能得到「host 变了但 port 没变」的组合）。
 */
export async function saveSettings(patch: Partial<Settings>): Promise<ValidationResult> {
  const current = await getSettings()
  const result = validateSettings(patch, current)
  if (!result.ok) return result

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: result.value })
  return result
}

/**
 * 读取开关状态。
 *
 * 默认 false：首次安装时不应该擅自开启代理。
 * 注意这只是**用户意图**，浏览器的实际代理状态必须另外用
 * chrome.proxy.settings.get() 查（architecture.md ADR-08）。
 */
export async function getEnabledState(): Promise<boolean> {
  const record = await chrome.storage.local.get(STORAGE_KEYS.enabled)
  return record[STORAGE_KEYS.enabled] === true
}

/** 写入开关状态。 */
export async function setEnabledState(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.enabled]: enabled })
}

/**
 * 读取最近一次错误。
 *
 * 为什么要持久化错误：chrome.proxy.onProxyError 可能在 Service Worker
 * 被终止之前触发。若只留在内存里，Popup 下次打开就读不到那次告警了——
 * 而 `fatal: false` 的 proxy error 恰恰意味着**已经发生过一次直连**，
 * 是全项目最不能丢的一条信息（architecture.md ADR-04）。
 *
 * 宽容解析：脏数据不能让 SW 起不来。缺 `key` 的旧格式记录会被丢弃——
 * 没有 key 就无法翻译，留着也没法展示。
 */
export async function getLastError(): Promise<NormalizedError | null> {
  const record = await chrome.storage.local.get(STORAGE_KEYS.lastError)
  const raw = record[STORAGE_KEYS.lastError]

  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Partial<NormalizedError>
  if (typeof candidate.code !== 'string' || typeof candidate.key !== 'string') return null

  const restored: NormalizedError = {
    code: candidate.code,
    key: candidate.key,
    message: typeof candidate.message === 'string' ? candidate.message : '',
    at: typeof candidate.at === 'number' ? candidate.at : 0,
  }
  if (candidate.params !== undefined) {
    return { ...restored, params: candidate.params }
  }
  return restored
}

/** 写入最近一次错误；传 null 表示清除。 */
export async function setLastError(error: NormalizedError | null): Promise<void> {
  if (error === null) {
    await chrome.storage.local.remove(STORAGE_KEYS.lastError)
    return
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.lastError]: error })
}

/**
 * 把 Settings 投影成给 UI 的视图 —— **剥掉 Controller Secret 明文**。
 *
 * 这是 secret 能到达的最外边界。UI 只拿到 hasSecret 布尔值，
 * 因此即便将来 Popup 出现 XSS 或误把状态打进 console，也漏不出凭据。
 *
 * ⚠️ 新增 Settings 字段时，必须回到这里显式决定要不要暴露给 UI。
 */
export function toSettingsView(settings: Settings): SettingsView {
  return {
    proxyHost: settings.proxyHost,
    proxyPort: settings.proxyPort,
    controllerHost: settings.controllerHost,
    controllerPort: settings.controllerPort,
    hasSecret: settings.controllerSecret.length > 0,
    webRtcLockEnabled: settings.webRtcLockEnabled,
    language: settings.language,
  }
}
