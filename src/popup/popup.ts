/**
 * Popup 入口。
 *
 * 架构约束（技术方案 §29.12）：本文件**只做两件事**——
 * 渲染 StatusSnapshot、把用户意图作为消息发给 Service Worker。
 * 没有任何代理逻辑、探活逻辑或 storage 访问。
 *
 * 一个刻意的交互决策：开启失败时开关必须**回滚**。
 * 用户点了 ON、结果被别的扩展挡住，若开关还亮着，
 * 那就是在骗人（技术方案 §22 Case 3 明确禁止显示假 ON）。
 *
 * i18n：静态文案通过 `data-i18n` 属性声明式绑定，动态文案在渲染时翻译。
 * 语言来自 settings.language（'auto' 时跟随浏览器）——因此必须等
 * 第一次 GET_STATUS 回来才能确定语言，静态文案也在那之后才填充。
 */

import { isLeakSuspected } from '../shared/errors'
import { createTranslator, resolveLocale, type MessageKey } from '../shared/i18n'
import { sendMessage } from '../shared/messages'
import type { NormalizedError, StatusSnapshot } from '../shared/types'

const el = {
  card: document.querySelector<HTMLElement>('#proxy-card'),
  toggle: document.querySelector<HTMLButtonElement>('#toggle'),
  proxyTarget: document.querySelector<HTMLElement>('#proxy-target'),
  alert: document.querySelector<HTMLElement>('#alert'),
  alertText: document.querySelector<HTMLElement>('#alert-text'),
  dismiss: document.querySelector<HTMLButtonElement>('#dismiss'),
  coreDot: document.querySelector<HTMLElement>('#core-dot'),
  coreText: document.querySelector<HTMLElement>('#core-text'),
  coreNote: document.querySelector<HTMLElement>('#core-note'),
  modeText: document.querySelector<HTMLElement>('#mode-text'),
  webrtcText: document.querySelector<HTMLElement>('#webrtc-text'),
  settings: document.querySelector<HTMLButtonElement>('#open-settings'),
  nodes: document.querySelector<HTMLElement>('#nodes'),
  nodesGroup: document.querySelector<HTMLElement>('#nodes-group'),
  nodesHint: document.querySelector<HTMLElement>('#nodes-hint'),
  nodeList: document.querySelector<HTMLElement>('#node-list'),
  nodesScope: document.querySelector<HTMLElement>('#nodes-scope'),
}

/** 当前翻译函数。首次 GET_STATUS 前用浏览器语言兜底，避免面板空白。 */
let t = createTranslator(resolveLocale('auto'))

/** 把所有 [data-i18n] 节点填上当前语言的文案。 */
function applyStaticText(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n
    if (key !== undefined) node.textContent = t(key as MessageKey)
  }
  document.documentElement.lang = resolveLocale('auto')
}

function setBusy(busy: boolean): void {
  if (el.toggle) el.toggle.disabled = busy
}

/**
 * 渲染告警。
 *
 * 两级严重度不是装饰：如果「Core 离线」和「可能已经泄漏了真实 IP」
 * 长得一模一样，用户就无法分辨哪条需要立刻处理，最终会一律无视——
 * 那比没有告警更糟。
 *
 * Dismiss 按钮只给「疑似泄漏」那一级：其他告警反映的是当前状态，
 * 会随状态自行变化或自愈，给个关闭按钮只会让用户把真实问题藏起来。
 */
function showAlert(error: NormalizedError | null): void {
  if (!el.alert || !el.alertText) return

  if (error === null) {
    el.alert.hidden = true
    el.alertText.textContent = ''
    if (el.dismiss) el.dismiss.hidden = true
    return
  }

  const leak = isLeakSuspected(error.code)

  // 先填文字再显示。反过来的话，万一取文案这一步抛异常，
  // 就会留下一个已经可见但空白的告警框——那正是 [hidden] 被
  // display:flex 覆盖时暴露出来的症状，不该再有第二种成因。
  el.alertText.textContent = t(error.key, error.params)
  el.alert.dataset.severity = leak ? 'danger' : 'warn'
  el.alert.hidden = false
  if (el.dismiss) el.dismiss.hidden = !leak
}

/** 描述当前模式。三种状态刻意分开表述，尤其是「不一致」不能被含糊过去。 */
function modeKey(snapshot: StatusSnapshot): MessageKey {
  if (!snapshot.enabled) return 'popup.modeDirect'
  if (!snapshot.proxyActuallySet) return 'popup.modeInconsistent'
  return 'popup.modeBrowserOnly'
}

function webRtcKey(snapshot: StatusSnapshot): MessageKey {
  if (!snapshot.settings.webRtcLockEnabled) return 'popup.webrtcOff'
  return snapshot.webRtcLocked ? 'popup.webrtcLocked' : 'popup.webrtcUnlocked'
}

/**
 * 渲染 Core 状态行。
 *
 * 三态的视觉分级是 ADR-23 的核心：`unreachable` **不是错误**。
 * 用户的客户端可能刻意只开 named pipe 而不开 HTTP controller
 * （那其实更安全，不暴露 TCP 端口）。这种情况下代理走 mixed-port
 * 完全正常工作，只是我们读不到版本号而已。
 */
function renderCore(snapshot: StatusSnapshot): void {
  if (!el.coreDot || !el.coreText) return

  if (snapshot.coreStatus === 'online') {
    el.coreDot.dataset.state = 'online'
    el.coreText.textContent = snapshot.coreVersion
      ? `${t('popup.coreOnline')} · ${snapshot.coreVersion}`
      : t('popup.coreOnline')
  } else if (snapshot.coreStatus === 'error') {
    el.coreDot.dataset.state = 'offline'
    el.coreText.textContent = t('popup.coreMisconfigured')
  } else {
    // unreachable：中性，不是故障。
    el.coreDot.dataset.state = 'unknown'
    el.coreText.textContent = t('popup.coreUnavailable')
  }

  if (el.coreNote) el.coreNote.hidden = snapshot.coreStatus !== 'unreachable'
}

/**
 * 渲染节点列表（V0.2）。
 *
 * 三种「没有列表可显示」的情况都不是错误，各给一句可操作的说明：
 *   - Controller 不可达  → 去客户端里开外部控制（named pipe 模式很常见，ADR-23）
 *   - 还没选主策略组      → 去 Settings 选一个（默认必须为空，§16 禁止硬编码组名）
 *   - 组不存在           → 换了订阅，去 Settings 重新选
 *
 * ⚠️ 用 <button> 而不是可点击的 <li>：键盘可达性与语义都靠原生元素拿到，
 *    自己用 div + tabindex + keydown 复刻一遍必然漏掉某些行为。
 */
function renderNodes(snapshot: StatusSnapshot): void {
  const { nodes, nodesGroup, nodesHint, nodeList, nodesScope } = el
  if (!nodes || !nodesGroup || !nodesHint || !nodeList || !nodesScope) return

  nodes.hidden = false
  nodeList.replaceChildren()

  const showHint = (text: string): void => {
    nodesHint.textContent = text
    nodesHint.hidden = false
    nodesGroup.textContent = ''
    // 没有可点的东西时不显示边界说明 —— 那句话只在能切换时才有意义。
    nodesScope.hidden = true
  }

  if (snapshot.group === null) {
    const code = snapshot.groupError?.code
    if (code === 'CORE_OFFLINE' || snapshot.coreStatus !== 'online') {
      showHint(t('popup.nodeNeedsController'))
    } else if (code === 'GROUP_NOT_CONFIGURED') {
      showHint(t('popup.nodeNeedsGroup'))
    } else if (snapshot.groupError) {
      // 组不存在等：用错误自带的文案，它已经指明了下一步。
      showHint(t(snapshot.groupError.key, snapshot.groupError.params))
    } else {
      showHint(t('popup.nodeNeedsGroup'))
    }
    return
  }

  nodesHint.hidden = true
  nodesGroup.textContent = snapshot.group.name

  if (snapshot.group.nodes.length === 0) {
    showHint(t('popup.nodeEmpty'))
    return
  }

  for (const name of snapshot.group.nodes) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'node-item'
    // textContent 而非 innerHTML：节点名来自订阅，是不可信输入。
    button.textContent = name
    button.dataset.node = name
    if (name === snapshot.group.now) {
      button.setAttribute('aria-current', 'true')
      // 当前节点点了也是同一个，禁用掉省一次无意义的往返。
      button.disabled = true
      button.title = t('popup.nodeCurrent')
    }
    item.append(button)
    nodeList.append(item)
  }

  // ADR-28：能切换时必须显示边界说明。
  nodesScope.hidden = false
}

function render(snapshot: StatusSnapshot): void {
  // 语言可能刚被用户改过，每次渲染都重建翻译器并刷新静态文案。
  t = createTranslator(resolveLocale(snapshot.settings.language))
  applyStaticText()

  el.toggle?.setAttribute('aria-checked', String(snapshot.enabled))
  if (el.card) {
    el.card.dataset.on = String(snapshot.enabled)
    // 状态已知，撤掉"未知"呈现。
    el.card.dataset.loading = 'false'
  }

  if (el.proxyTarget) {
    el.proxyTarget.textContent = `${snapshot.settings.proxyHost}:${snapshot.settings.proxyPort}`
  }

  renderCore(snapshot)

  if (el.modeText) el.modeText.textContent = t(modeKey(snapshot))
  if (el.webrtcText) el.webrtcText.textContent = t(webRtcKey(snapshot))

  renderNodes(snapshot)
  showAlert(snapshot.lastError)
}

/** 重新拉取真实状态。任何操作失败后都必须调用它，让 UI 回到事实。 */
async function refresh(): Promise<void> {
  const response = await sendMessage({ type: 'GET_STATUS' })
  if (response.ok) {
    render(response.data)
  } else {
    showAlert(response.error)
  }
}

el.toggle?.addEventListener('click', async () => {
  // 以当前 aria-checked 为准判断意图，而不是维护一份本地状态——
  // 本地状态会和 background 漂移。
  const currentlyOn = el.toggle?.getAttribute('aria-checked') === 'true'

  setBusy(true)
  showAlert(null)

  const response = currentlyOn
    ? await sendMessage({ type: 'DISABLE_PROXY' })
    : await sendMessage({ type: 'ENABLE_PROXY' })

  if (response.ok) {
    render(response.data)
  } else {
    // 失败：先显示原因，再拉一次真实状态把开关回滚到事实上的位置。
    showAlert(response.error)
    await refresh()
  }

  setBusy(false)
})

el.dismiss?.addEventListener('click', async () => {
  // 只在「疑似泄漏」告警上可见。用户点它表示已经知悉这件事发生过——
  // 这是该告警唯一的退出路径，因为它刻意不自愈（ADR-22）。
  const response = await sendMessage({ type: 'DISMISS_ERROR' })
  if (response.ok) {
    render(response.data)
  } else {
    showAlert(response.error)
  }
})

/*
 * 节点点击 —— 事件委托挂在列表上，而不是给每个按钮各挂一个监听器。
 * 列表每次渲染都整体重建，逐个挂会随重绘次数累积。
 */
el.nodeList?.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.node-item')
  const node = target?.dataset.node
  if (target === null || target === undefined || node === undefined) return

  // 切换中把整个列表禁掉：连点两个节点会产生两个竞争的 PUT，
  // 最后生效哪个取决于内核处理顺序，而 UI 会显示后返回的那个。
  const buttons = [...(el.nodeList?.querySelectorAll<HTMLButtonElement>('.node-item') ?? [])]
  const previouslyEnabled = buttons.filter((b) => !b.disabled)
  for (const b of previouslyEnabled) b.disabled = true
  target.textContent = t('popup.nodeSwitching')

  const response = await sendMessage({ type: 'SELECT_NODE', node })

  if (response.ok) {
    render(response.data)
  } else {
    showAlert(response.error)
    // 失败后拉一次真实状态：内核可能已经部分生效，UI 必须回到事实。
    await refresh()
  }
})

el.settings?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

// 先用浏览器语言把静态文案填上，避免面板在探活的这几秒里一片空白。
applyStaticText()

// 首次打开时拉状态。探活最坏要等 3 秒超时，
// 所以 HTML 里预置了 "正在检查 Mihomo…" 而不是空白，避免看起来像卡死。
void refresh().finally(() => {
  setBusy(false)
})
