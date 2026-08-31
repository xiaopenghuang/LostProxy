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
import type { ProviderView, ProxyGroup, Settings, SettingsView } from '../shared/types'

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
  primaryGroup: document.querySelector<HTMLSelectElement>('#primary-group'),
  loadGroups: document.querySelector<HTMLButtonElement>('#load-groups'),
  groupsResult: document.querySelector<HTMLElement>('#groups-result'),
  groupTypeNote: document.querySelector<HTMLElement>('#group-type-note'),
  directRules: document.querySelector<HTMLTextAreaElement>('#direct-rules'),
  rulesResult: document.querySelector<HTMLElement>('#rules-result'),
  subsList: document.querySelector<HTMLElement>('#subs-list'),
  loadSubs: document.querySelector<HTMLButtonElement>('#load-subs'),
  subsResult: document.querySelector<HTMLElement>('#subs-result'),
  probePort: document.querySelector<HTMLButtonElement>('#probe-port'),
  saveBar: document.querySelector<HTMLElement>('#save-bar'),
}

/**
 * 更新「有未保存改动」的标记。
 *
 * 与 `hasUnsavedControllerChange()` 不同：那个只关心 Controller 三项（因为
 * 探活和读取策略组用的是已保存的值），这个关心**全部**需要保存的字段。
 *
 * 判断方式是拿当前表单值与最近一次加载的视图逐项比较，而不是维护一个
 * "用户碰过输入框"的布尔量 —— 后者会把"改了又改回去"误判成有改动。
 */
function refreshDirtyState(): void {
  const bar = el.saveBar
  if (!bar || loaded === null) return

  const patch = collectPatch()
  const dirty =
    patch.proxyHost !== loaded.proxyHost ||
    patch.proxyPort !== loaded.proxyPort ||
    patch.controllerHost !== loaded.controllerHost ||
    patch.controllerPort !== loaded.controllerPort ||
    patch.webRtcLockEnabled !== loaded.webRtcLockEnabled ||
    patch.primaryGroup !== loaded.primaryGroup ||
    // secret 只要输入框非空就算有改动（留空 = 保持原值，不是清空）
    patch.controllerSecret !== undefined ||
    (patch.directRules ?? []).join('\n') !== loaded.directRules.join('\n')

  bar.dataset.dirty = String(dirty)
}

let locale: Locale = resolveLocale('auto')
let t = createTranslator(locale)

/** 最近一次从 background 拿到的视图，用于检测未保存改动。 */
let loaded: SettingsView | null = null

/**
 * 最近一次读到的策略组列表。
 *
 * 保留 type 是为了在用户选中某个组时提示「这类组不能手动切换」——
 * 在他点保存、回到 Popup、点节点、报错之前就告诉他。
 */
let groups: readonly ProxyGroup[] = []

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

  renderGroupOptions(view.primaryGroup)

  if (el.directRules) {
    el.directRules.value = view.directRules.join('\n')
    el.directRules.placeholder = t('options.rulesPlaceholder')
  }
  if (el.rulesResult) {
    el.rulesResult.textContent =
      view.directRules.length > 0
        ? t('options.rulesCount', { count: view.directRules.length })
        : t('options.rulesNeedRules')
  }

  // 刚加载完（或刚保存完）必然是干净状态。
  refreshDirtyState()
}

/**
 * 渲染订阅列表（V0.6）。
 *
 * 每项只有一个「更新」按钮 —— 添加与删除做不到（ADR-34），
 * 而放一个点了会报错的按钮比不放更糟。
 */
function renderProviders(providers: readonly ProviderView[]): void {
  const list = el.subsList
  if (!list) return

  list.replaceChildren()

  if (providers.length === 0) {
    setResult(el.subsResult, t('options.subsEmpty'), '')
    return
  }

  for (const provider of providers) {
    const item = document.createElement('li')
    item.className = 'subs-item'
    if (!provider.updatable) item.dataset.updatable = 'false'

    const meta = document.createElement('div')
    meta.className = 'subs-meta'

    const name = document.createElement('span')
    name.className = 'subs-name'
    // textContent：订阅名来自内核配置，视作不可信输入。
    name.textContent = provider.name

    const detail = document.createElement('span')
    detail.className = 'subs-detail'
    detail.textContent = provider.updatable
      ? [
          t('options.subsNodeCount', { count: provider.nodeCount }),
          provider.updatedAt === null
            ? t('options.subsNever')
            : t('options.subsUpdatedAt', { time: formatTime(provider.updatedAt) }),
        ].join(' · ')
      : [
          t('options.subsNodeCount', { count: provider.nodeCount }),
          // 说明为什么这一项没有更新按钮，而不是让用户自己猜。
          t('options.subsNotUpdatable', { type: provider.type }),
        ].join(' · ')

    meta.append(name, detail)
    item.append(meta)

    /*
     * 只给可更新的项加按钮。放一个点了必定失败的按钮比不放更糟 ——
     * 内核对非 HTTP provider 的更新请求会返回成功但什么都不做，
     * 那种"点了没反应"最难排查。
     */
    if (provider.updatable) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'btn'
      button.textContent = t('options.subsUpdate')
      button.dataset.provider = provider.name
      item.append(button)
    }

    list.append(item)
  }

  // 混合情形（有可更新的也有不可更新的）时补一句总说明。
  if (providers.some((p) => !p.updatable) && providers.some((p) => p.updatable)) {
    setResult(el.subsResult, t('options.subsFlattenedNote'), '')
  }
}

/**
 * 把 ISO 时间格式化成本地可读形式。
 *
 * 内核给的是 UTC ISO 串。直接显示会让用户对不上自己的时钟，
 * 而「更新于什么时候」正是这一栏唯一的用途。
 */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 渲染主策略组下拉框（V0.2）。
 *
 * 关键取舍：即便还没读过列表，也要把**已保存的组名**作为一个选项放进去。
 * 否则打开 Settings 时下拉框是空的，用户会以为自己的配置丢了 ——
 * 而实际上只是还没连内核。
 */
function renderGroupOptions(current: string): void {
  const select = el.primaryGroup
  if (!select) return

  select.replaceChildren()

  const none = document.createElement('option')
  none.value = ''
  none.textContent = t('options.groupNonePlaceholder')
  select.append(none)

  const names = groups.map((g) => g.name)
  // 已保存的组不在最新列表里（换了订阅），仍然列出来，
  // 免得保存时把用户原本的选择静默清成空。
  if (current.length > 0 && !names.includes(current)) names.push(current)

  for (const name of names) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    select.append(option)
  }

  select.value = current
  renderGroupTypeNote()
}

/**
 * 提示当前选中的组是什么类型、能不能手动切换。
 *
 * 在用户保存之前就说，而不是等他回 Popup 点了节点才报 400 ——
 * 判定权归内核（ADR-29）不代表我们要让用户去撞那个错误。
 */
function renderGroupTypeNote(): void {
  const note = el.groupTypeNote
  if (!note) return

  const selected = el.primaryGroup?.value ?? ''
  const group = groups.find((g) => g.name === selected)

  if (selected.length === 0 || group === undefined) {
    note.textContent = ''
    return
  }

  note.textContent =
    group.type === 'Selector'
      ? t('options.groupTypeSelector')
      : t('options.groupTypeNote', { type: group.type })
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
    // 不 trim：组名必须与内核返回的字符串逐字节相等才能匹配（ADR-30）。
    primaryGroup: el.primaryGroup?.value ?? '',
    /*
     * 一行一条，丢掉空行。
     * 这里**不做**字符校验 —— 校验在 background 做（storage.ts），
     * 前端只负责把文本切成数组。理由与端口一样：前端校验是便利，
     * 不是防线；防线必须在唯一的写入路径上。
     */
    directRules: (el.directRules?.value ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
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

el.loadGroups?.addEventListener('click', async () => {
  /*
   * 与 Test Mihomo 同一条纪律：读取用的是**已保存**的 Controller 配置，
   * 不是表单里的当前值。改了端口没保存就点读取，会拿旧端口去连，
   * 然后用户得到一个与他眼前看到的配置无关的错误。
   */
  if (hasUnsavedControllerChange()) {
    setResult(el.groupsResult, t('options.groupNeedsController'), 'error')
    return
  }

  if (el.loadGroups) el.loadGroups.disabled = true
  setResult(el.groupsResult, t('options.groupLoading'), '')

  const response = await sendMessage({ type: 'LIST_GROUPS' })

  if (response.ok) {
    groups = response.data.groups
    // 保住用户当前的选择：重建下拉框不该把已选中的组重置掉。
    renderGroupOptions(el.primaryGroup?.value ?? loaded?.primaryGroup ?? '')
    setResult(el.groupsResult, t('options.groupLoadedCount', { count: groups.length }), 'ok')
  } else {
    setResult(el.groupsResult, t(response.error.key, response.error.params), 'error')
  }

  if (el.loadGroups) el.loadGroups.disabled = false
})

// 选中项变了就更新类型提示，不等保存。
el.primaryGroup?.addEventListener('change', () => {
  renderGroupTypeNote()
})

el.probePort?.addEventListener('click', async () => {
  if (el.probePort) el.probePort.disabled = true
  setResult(el.testResult, t('options.probing'), '')

  const response = await sendMessage({ type: 'PROBE_PORT' })

  if (el.probePort) el.probePort.disabled = false

  if (!response.ok) {
    setResult(el.testResult, t(response.error.key, response.error.params), 'error')
    return
  }

  const { port } = response.data
  if (port === null) {
    setResult(el.testResult, t('options.probeNotFound'), 'error')
    return
  }

  /*
   * 只填进输入框，**不自动保存**（orchestrator.handleProbePort 有说明）：
   * 探测可能命中一个用户并不想用的内核实例。端口是这个插件唯一必须填对的
   * 东西，替用户决定它不合适。
   */
  if (el.controllerPort) el.controllerPort.value = String(port)
  setResult(el.testResult, t('options.probeFound', { port }), 'ok')
})

el.loadSubs?.addEventListener('click', async () => {
  // 与读取策略组同一条纪律：用的是已保存的 Controller 配置。
  if (hasUnsavedControllerChange()) {
    setResult(el.subsResult, t('options.subsNeedsController'), 'error')
    return
  }

  if (el.loadSubs) el.loadSubs.disabled = true
  setResult(el.subsResult, t('options.subsLoading'), '')

  const response = await sendMessage({ type: 'LIST_PROVIDERS' })

  if (response.ok) {
    renderProviders(response.data.providers)
    if (response.data.providers.length > 0) setResult(el.subsResult, '', '')
  } else {
    setResult(el.subsResult, t(response.error.key, response.error.params), 'error')
  }

  if (el.loadSubs) el.loadSubs.disabled = false
})

/*
 * 更新订阅用事件委托：列表每次都整体重建，逐个挂监听器会随重绘累积。
 */
el.subsList?.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-provider]')
  const name = button?.dataset.provider
  if (!button || name === undefined) return

  const original = button.textContent
  button.disabled = true
  button.textContent = t('options.subsUpdating')

  const response = await sendMessage({ type: 'UPDATE_PROVIDER', name })

  if (response.ok) {
    // 重绘整个列表：更新的**结果**就是节点数与时间变了，
    // 不重绘用户无法确认更新是否真的生效。
    renderProviders(response.data.providers)
    setResult(el.subsResult, t('options.subsUpdated', { name }), 'ok')
  } else {
    button.disabled = false
    button.textContent = original
    setResult(el.subsResult, t(response.error.key, response.error.params), 'error')
  }
})

/*
 * 任何需要保存的字段一变就重算 dirty。
 *
 * 用事件委托挂在 form 上而不是逐个输入框挂：新增字段时不必记得回来补一行，
 * 漏掉的后果是"改了但保存栏没提示"，属于安静失效。
 */
el.form?.addEventListener('input', refreshDirtyState)
el.form?.addEventListener('change', refreshDirtyState)

// 先用浏览器语言把静态文案填上，避免加载期间一片空白。
applyStaticText()
renderLanguageOptions('auto')
void load()
