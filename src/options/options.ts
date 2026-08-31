/**
 * Settings 页入口。
 *
 * 与 Popup 同样的约束：只渲染、只发消息（技术方案 §29.12）。
 *
 * 🔴 Secret 处理是本文件的核心难点（security.md §2.1 / 技术方案 §21.4）：
 *
 *   - 输入框是 type=password；
 *   - **从不回显已保存的值** —— background 甚至不会把明文发过来
 *     （StatusSnapshot 携带的是 SettingsView，只有 hasSecret 布尔值）；
 *   - 输入框留空 = 「保持原值不变」，而不是「清空 secret」。
 *     这两者必须分开，否则用户改个端口就会把 secret 洗掉；
 *   - 想清空得显式点 Clear。
 *
 * 语言切换刻意做成**即时生效**，不需要点保存：切语言是为了看懂界面，
 * 让用户先看懂"保存"两个字才能保存语言，是本末倒置。
 */

import { createTranslator, languageLabel, LANGUAGE_OPTIONS, resolveLocale } from '../shared/i18n'
import type { Language, Locale, MessageKey } from '../shared/i18n'
import { sendMessage } from '../shared/messages'
import type { Settings, SettingsView } from '../shared/types'

const el = {
  form: document.querySelector<HTMLFormElement>('#form'),
  language: document.querySelector<HTMLSelectElement>('#language'),
  proxyHost: document.querySelector<HTMLInputElement>('#proxy-host'),
  proxyPort: document.querySelector<HTMLInputElement>('#proxy-port'),
  controllerHost: document.querySelector<HTMLInputElement>('#controller-host'),
  controllerPort: document.querySelector<HTMLInputElement>('#controller-port'),
  secret: document.querySelector<HTMLInputElement>('#controller-secret'),
  secretHint: document.querySelector<HTMLElement>('#secret-hint'),
  clearSecret: document.querySelector<HTMLButtonElement>('#clear-secret'),
  webrtcLock: document.querySelector<HTMLInputElement>('#webrtc-lock'),
  testCore: document.querySelector<HTMLButtonElement>('#test-core'),
  testResult: document.querySelector<HTMLElement>('#test-result'),
  save: document.querySelector<HTMLButtonElement>('#save'),
  saveResult: document.querySelector<HTMLElement>('#save-result'),
}

let locale: Locale = resolveLocale('auto')
let t = createTranslator(locale)

/** 最近一次从 background 拿到的视图，用于检测未保存改动。 */
let loaded: SettingsView | null = null

function applyStaticText(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n
    if (key !== undefined) node.textContent = t(key as MessageKey)
  }
  document.documentElement.lang = locale
  document.title = t('options.title')
}

/** 语言下拉框的选项文案随界面语言变化，所以每次切换都要重建。 */
function renderLanguageOptions(current: Language): void {
  if (!el.language) return
  el.language.replaceChildren(
    ...LANGUAGE_OPTIONS.map((language) => {
      const option = document.createElement('option')
      option.value = language
      option.textContent = languageLabel(language, locale)
      option.selected = language === current
      return option
    }),
  )
}

function setResult(target: HTMLElement | null, message: string, state: '' | 'ok' | 'error'): void {
  if (!target) return
  target.textContent = message
  target.dataset.state = state
}

function renderSettings(view: SettingsView): void {
  loaded = view

  locale = resolveLocale(view.language)
  t = createTranslator(locale)
  applyStaticText()
  renderLanguageOptions(view.language)

  if (el.proxyHost) el.proxyHost.value = view.proxyHost
  if (el.proxyPort) el.proxyPort.value = String(view.proxyPort)
  if (el.controllerHost) el.controllerHost.value = view.controllerHost
  if (el.controllerPort) el.controllerPort.value = String(view.controllerPort)
  if (el.webrtcLock) el.webrtcLock.checked = view.webRtcLockEnabled

  if (el.secret) {
    // 永远留空，永远不回显。
    el.secret.value = ''
    el.secret.placeholder = view.hasSecret
      ? t('options.secretPlaceholderSaved')
      : t('options.secretPlaceholderNone')
  }
  if (el.clearSecret) el.clearSecret.hidden = !view.hasSecret
  if (el.secretHint) {
    el.secretHint.textContent = view.hasSecret ? t('options.secretSaved') : t('options.secretNone')
  }
}

/** 表单里的端口字符串 → number。非法输入交给 background 的校验去拒绝。 */
function toPort(value: string | undefined): number {
  return Number.parseInt(value ?? '', 10)
}

function collectPatch(): Partial<Settings> {
  const patch: Partial<Settings> = {
    proxyHost: el.proxyHost?.value.trim() ?? '',
    proxyPort: toPort(el.proxyPort?.value),
    controllerHost: el.controllerHost?.value.trim() ?? '',
    controllerPort: toPort(el.controllerPort?.value),
    webRtcLockEnabled: el.webrtcLock?.checked ?? true,
  }

  const typed = el.secret?.value ?? ''
  if (typed.length > 0) {
    patch.controllerSecret = typed
  }
  // 留空则**不带** controllerSecret 字段 —— background 的部分更新会保留原值。

  return patch
}

/** Controller 地址是否被改过但还没保存。 */
function hasUnsavedControllerChange(): boolean {
  if (loaded === null) return false
  return (
    el.controllerHost?.value.trim() !== loaded.controllerHost ||
    toPort(el.controllerPort?.value) !== loaded.controllerPort ||
    (el.secret?.value ?? '').length > 0
  )
}

async function load(): Promise<void> {
  const response = await sendMessage({ type: 'GET_STATUS' })
  if (response.ok) {
    renderSettings(response.data.settings)
  } else {
    setResult(el.saveResult, t(response.error.key, response.error.params), 'error')
  }
}

/** 语言即时生效：不要求用户先看懂"保存"才能改语言。 */
el.language?.addEventListener('change', async () => {
  const chosen = el.language?.value as Language | undefined
  if (chosen === undefined) return

  const response = await sendMessage({ type: 'SAVE_SETTINGS', patch: { language: chosen } })
  if (response.ok) {
    renderSettings(response.data)
    setResult(el.saveResult, '', '')
  } else {
    setResult(el.saveResult, t(response.error.key, response.error.params), 'error')
  }
})

el.form?.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (el.save) el.save.disabled = true
  setResult(el.saveResult, t('common.saving'), '')

  const response = await sendMessage({ type: 'SAVE_SETTINGS', patch: collectPatch() })

  if (response.ok) {
    renderSettings(response.data)
    setResult(el.saveResult, t('common.saved'), 'ok')
    // 地址可能变了，旧的探测结果不再有意义。
    setResult(el.testResult, '', '')
  } else {
    setResult(el.saveResult, t(response.error.key, response.error.params), 'error')
  }

  if (el.save) el.save.disabled = false
})

el.clearSecret?.addEventListener('click', async () => {
  // 显式清空是唯一能删掉 secret 的路径。
  const response = await sendMessage({ type: 'SAVE_SETTINGS', patch: { controllerSecret: '' } })

  if (response.ok) {
    renderSettings(response.data)
    setResult(el.saveResult, t('options.secretCleared'), 'ok')
  } else {
    setResult(el.saveResult, t(response.error.key, response.error.params), 'error')
  }
})

el.testCore?.addEventListener('click', async () => {
  // 探活用的是**已保存**的配置，不是表单里的当前值。
  // 不提示这一点，用户改完端口直接点 Test 会得到一个误导性的结果。
  if (hasUnsavedControllerChange()) {
    setResult(el.testResult, t('options.testSaveFirst'), 'error')
    return
  }

  if (el.testCore) el.testCore.disabled = true
  setResult(el.testResult, t('options.testing'), '')

  const response = await sendMessage({ type: 'TEST_CORE' })

  if (response.ok) {
    setResult(el.testResult, t('options.testOnline', { version: response.data.version ?? '?' }), 'ok')
  } else {
    setResult(el.testResult, t(response.error.key, response.error.params), 'error')
  }

  if (el.testCore) el.testCore.disabled = false
})

// 先用浏览器语言把静态文案填上，避免加载期间一片空白。
applyStaticText()
renderLanguageOptions('auto')
void load()
