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

import {
  CONNS_POLL_MS,
  LATENCY_FAST_MS,
  LATENCY_MEDIUM_MS,
  PROTOCOL_LABELS,
  SPARK_POINTS,
} from '../shared/constants'
import { isLeakSuspected } from '../shared/errors'
import {
  buildSparkline,
  computeRate,
  formatBytes,
  pickFastest,
  sortNodesByLatency,
} from './format'
import { createTranslator, resolveLocale, type MessageKey } from '../shared/i18n'
import { sendMessage, type ResponsePayloads } from '../shared/messages'
import type {
  ConnectionView,
  NormalizedError,
  RoutingMode,
  StatusSnapshot,
} from '../shared/types'

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
  nodeText: document.querySelector<HTMLElement>('#node-text'),
  webrtcText: document.querySelector<HTMLElement>('#webrtc-text'),
  settings: document.querySelector<HTMLButtonElement>('#open-settings'),
  nodesGroup: document.querySelector<HTMLElement>('#nodes-group'),
  nodesHint: document.querySelector<HTMLElement>('#nodes-hint'),
  nodeList: document.querySelector<HTMLElement>('#node-list'),
  nodesScope: document.querySelector<HTMLElement>('#nodes-scope'),
  testLatency: document.querySelector<HTMLButtonElement>('#test-latency'),
  pickFastestBtn: document.querySelector<HTMLButtonElement>('#pick-fastest'),
  modesHint: document.querySelector<HTMLElement>('#modes-hint'),
  traffic: document.querySelector<HTMLElement>('#traffic'),
  trafficDown: document.querySelector<HTMLElement>('#traffic-down'),
  trafficUp: document.querySelector<HTMLElement>('#traffic-up'),
  trafficTotal: document.querySelector<HTMLElement>('#traffic-total'),
  sparkDown: document.querySelector<SVGPolylineElement>('#spark-down'),
  sparkUp: document.querySelector<SVGPolylineElement>('#spark-up'),
  connsCount: document.querySelector<HTMLElement>('#conns-count'),
  connsRefresh: document.querySelector<HTMLButtonElement>('#conns-refresh'),
  connsHint: document.querySelector<HTMLElement>('#conns-hint'),
  connsList: document.querySelector<HTMLElement>('#conns-list'),
  connsScope: document.querySelector<HTMLElement>('#conns-scope'),
}

/** 全部标签按钮与对应面板。 */
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')]
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('.mode-btn')]

/**
 * 切换标签页。
 *
 * 面板用 `hidden` 属性而非 CSS class 控制显隐 —— `[hidden]` 已经有全局
 * `display:none !important` 兜底（ADR-26），再引入第二套机制只会多一处
 * 可能失配的地方。
 */
function selectTab(id: string): void {
  for (const tab of tabs) {
    const active = tab.id === id
    tab.setAttribute('aria-selected', String(active))
    const paneId = tab.getAttribute('aria-controls')
    if (paneId === null) continue
    const pane = document.getElementById(paneId)
    if (pane !== null) pane.hidden = !active
  }
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
  const { nodesGroup, nodesHint, nodeList, nodesScope, testLatency, pickFastestBtn } = el
  if (!nodesGroup || !nodesHint || !nodeList || !nodesScope) return

  nodeList.replaceChildren()

  const showHint = (text: string): void => {
    nodesHint.textContent = text
    nodesHint.hidden = false
    nodesGroup.textContent = ''
    // 没有可点的东西时不显示边界说明 —— 那句话只在能切换时才有意义。
    nodesScope.hidden = true
    // 同理，没有节点可测速 / 选最快。
    if (testLatency) testLatency.hidden = true
    if (pickFastestBtn) pickFastestBtn.hidden = true
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

  for (const name of sortNodesByLatency(snapshot.group.nodes, snapshot.group.latency)) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'node-item'
    button.dataset.node = name

    /*
     * 名字、协议、延迟各占一个 span。
     * textContent 而非 innerHTML：节点名来自订阅，是不可信输入。
     */
    const label = document.createElement('span')
    label.className = 'node-name'
    label.textContent = name
    button.append(
      label,
      protocolBadge(snapshot.group.protocol[name] ?? ''),
      latencyBadge(snapshot.group.latency[name] ?? null),
    )

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
  if (testLatency) testLatency.hidden = false
  // 「选最快」只有在成员多于一个时才有意义。
  if (pickFastestBtn) pickFastestBtn.hidden = snapshot.group.nodes.length < 2
}

/**
 * 渲染协议徽章（V0.7）。
 *
 * 缩写表里没有的 type **显示原文**而不是留空 —— 内核每加一个协议都会出现一个
 * 新 type，当白名单用会让新协议静默消失。显示 `Mieru` 比显示空白有用。
 *
 * 没有协议时（嵌套的策略组、内核内置出口）返回的仍是一个 span，只是内容为空，
 * **不是** null：grid 的列宽按整列最宽项算，少一个元素会让那一行的延迟徽章
 * 挪到前一列，于是整列数字失去对齐。空 span 宽度为 0，但把列位占住了。
 */
function protocolBadge(protocol: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'protocol'
  span.textContent = protocol.length === 0 ? '' : (PROTOCOL_LABELS[protocol] ?? protocol)
  return span
}

/**
 * 渲染延迟徽章（V0.3）。
 *
 * 分档只给数值上色以加速扫视，**数值本身始终显示** ——
 * 色觉障碍用户看不出绿/黄/红，但能读数字。
 * 没有数据时显示 `—`，超时显示文字而非 0ms（0 会被读成"极快"）。
 */
function latencyBadge(delay: number | null): HTMLElement {
  const span = document.createElement('span')
  span.className = 'latency'

  if (delay === null) {
    span.dataset.tier = 'unknown'
    span.textContent = t('popup.latencyUntested')
    return span
  }

  span.dataset.tier =
    delay <= LATENCY_FAST_MS ? 'fast' : delay <= LATENCY_MEDIUM_MS ? 'medium' : 'slow'
  span.textContent = `${delay} ms`
  return span
}

/**
 * 渲染分流模式（V0.4）。
 *
 * smart 但没有任何规则时**按 global 高亮**，因为 `buildProxyConfig` 在那种
 * 情况下确实退回了 fixed_servers（proxy.ts 有注释）。UI 必须显示浏览器的
 * 实际行为，而不是用户存的偏好 —— 显示"智能"却在走全局就是骗人。
 */
function renderModes(snapshot: StatusSnapshot): void {
  const stored = snapshot.settings.routingMode
  const hasRules = snapshot.settings.directRules.length > 0
  const effective = stored === 'smart' && !hasRules ? 'global' : stored

  for (const button of modeButtons) {
    button.setAttribute('aria-checked', String(button.dataset.mode === effective))
  }

  if (el.modesHint) {
    if (stored === 'smart' && !hasRules) {
      el.modesHint.textContent = t('popup.routingNeedsRules')
    } else if (effective === 'global') {
      el.modesHint.textContent = t('popup.routingHintGlobal')
    } else if (effective === 'smart') {
      el.modesHint.textContent = t('popup.routingHintSmart')
    } else {
      el.modesHint.textContent = t('popup.routingHintDirect')
    }
  }
}

/**
 * 渲染实时连接列表（V0.8）。
 *
 * 只负责「连接」标签的列表本身；吞吐速率/累计/曲线在「状态」标签，由 renderTraffic 管。
 * 与 `renderNodes` 同构：核心不可达 / 无连接都是**正常分支**，用提示替代列表，
 * 不当错误。host / chain / rule 全是不可信输入，一律 textContent。
 */
function renderConnections(data: ResponsePayloads['LIST_CONNECTIONS'] | null): void {
  const { connsList, connsHint, connsCount, connsRefresh, connsScope } = el
  if (!connsList || !connsHint || !connsScope) return

  connsList.replaceChildren()

  const showHint = (text: string): void => {
    connsHint.textContent = text
    connsHint.hidden = false
    if (connsCount) connsCount.textContent = ''
    connsScope.hidden = true
    if (connsRefresh) connsRefresh.hidden = true
  }

  // null 表示上一次拉取失败（核心不可达 / 未开外部控制）。
  if (data === null) {
    showHint(t('popup.connsNeedsController'))
    return
  }

  if (connsRefresh) connsRefresh.hidden = false

  if (data.connections.length === 0) {
    showHint(t('popup.connsEmpty'))
    return
  }

  if (connsCount) connsCount.textContent = t('popup.connsCount', { n: data.connections.length })
  connsHint.hidden = true

  for (const conn of data.connections) {
    connsList.append(connectionRow(conn))
  }

  connsScope.hidden = false
}

/**
 * 速率历史环形缓冲（V0.8），供状态标签的迷你曲线用。
 * 只留最近 SPARK_POINTS 个点 —— 曲线是「最近一小段趋势」，不是完整历史。
 */
const spark = { up: [] as number[], down: [] as number[] }

/**
 * 渲染状态标签的实时吞吐组件（V0.8）：当前上/下行速率 + 迷你曲线 + 累计。
 *
 * data 为 null（核心不可达）时整块隐藏 —— 状态标签本就有 Core 状态行解释原因，
 * 这里再报一次错只是噪音。rate 为 null（首次采样）时速率显示 `—`，但曲线与累计照常。
 */
function renderTraffic(
  data: ResponsePayloads['LIST_CONNECTIONS'] | null,
  rate: { up: number; down: number } | null,
): void {
  const { traffic, trafficDown, trafficUp, trafficTotal, sparkDown, sparkUp } = el
  if (!traffic) return

  if (data === null) {
    traffic.hidden = true
    spark.up = []
    spark.down = []
    return
  }
  traffic.hidden = false

  if (trafficDown) trafficDown.textContent = rate ? `${formatBytes(rate.down)}/s` : '—'
  if (trafficUp) trafficUp.textContent = rate ? `${formatBytes(rate.up)}/s` : '—'
  if (trafficTotal) {
    trafficTotal.textContent = t('popup.connsTotal', {
      up: formatBytes(data.uploadTotal),
      down: formatBytes(data.downloadTotal),
    })
  }

  // 把这一拍的速率推进曲线缓冲（首次没有 rate 就推 0，保持时间轴连续）。
  spark.up.push(rate ? rate.up : 0)
  spark.down.push(rate ? rate.down : 0)
  if (spark.up.length > SPARK_POINTS) spark.up.shift()
  if (spark.down.length > SPARK_POINTS) spark.down.shift()

  // 两条线共用一个最大值才能横向比较 —— 通常下行远大于上行。
  const max = Math.max(1, ...spark.up, ...spark.down)
  sparkDown?.setAttribute('points', buildSparkline(spark.down, max, 100, 32))
  sparkUp?.setAttribute('points', buildSparkline(spark.up, max, 100, 32))
}

/** 构造一条连接的 DOM 行。抽出来是因为它有若干条 textContent 赋值，内联进循环会很挤。 */
function connectionRow(conn: ConnectionView): HTMLElement {
  const item = document.createElement('li')
  item.className = 'conn-item'

  const host = document.createElement('span')
  host.className = 'conn-host'
  host.textContent = conn.host

  // 出口：直连显示 DIRECT 徽章，否则显示出口链的第一跳（实际出口节点）。
  const via = document.createElement('span')
  via.className = 'conn-via'
  via.dataset.direct = String(conn.isDirect)
  via.textContent = conn.isDirect ? t('popup.connsDirect') : (conn.chain[0] ?? '—')

  const meta = document.createElement('span')
  meta.className = 'conn-meta'
  // rule 可能为空（内核偶尔不带），空就只显示流量。
  const traffic = `↑${formatBytes(conn.upload)} ↓${formatBytes(conn.download)}`
  meta.textContent = conn.rule.length > 0 ? `${conn.rule} · ${traffic}` : traffic

  item.append(host, via, meta)
  return item
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
  // 状态页直接显示当前出口节点，省得为看一眼选中项还要切到「节点」标签往下翻。
  // group 为空（未配置 / 核心不可达 / 组不存在）或 now 为空（LoadBalance 组）都落到 '—'。
  if (el.nodeText) el.nodeText.textContent = snapshot.group?.now ?? '—'

  renderModes(snapshot)
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
    /*
     * 先拉真实状态把开关回滚到事实上的位置，再显示失败原因。
     *
     * 这个顺序原本是反的。它当时能工作，但靠的是巧合 ——
     * handleEnable / handleDisable 恰好会把错误写进 lastError，
     * 于是 refresh 重新读到并显示了它。也就是说 UI 层默默依赖了
     * 「background 会持久化这个错误」这一点。哪天那个决定变了，
     * 这里就会变成"错误闪一下就消失"，而且没有任何测试会红。
     * 与 SELECT_NODE 统一成同一个顺序，去掉这个隐式耦合。
     */
    await refresh()
    showAlert(response.error)
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
    return
  }

  /*
   * 🔴 顺序不能反：先 refresh 回到事实，**再**把失败原因盖上去。
   *
   * 反过来写（先 showAlert 再 refresh）会让这条消息立刻消失 ——
   * 因为切换失败刻意不写入 lastError（不能顶掉尚未确认的泄漏告警），
   * 于是 refresh 拿到的快照里 lastError 是 null，
   * render() 内部的 showAlert(null) 正好把刚显示的错误擦掉。
   * 症状是"错误闪一下就没了，点击像是没反应"。
   * 此方第一版就是反的，被 tests/popup-nodes.test.ts 抓出来了。
   */
  await refresh()
  showAlert(response.error)
})

/**
 * 吞吐轮询句柄（V0.8）。
 *
 * 速率与曲线在「状态」标签（默认可见），所以轮询在 Popup 打开期间**一直跑**，
 * 不再由标签切换控制 —— 一拍同时喂给状态标签的吞吐组件和连接标签的列表。
 * Popup 关闭时上下文整个销毁，timer 随之消失，无需手动清理。
 *
 * 用自排队的 setTimeout 而非 setInterval：`/connections` 探活最坏等
 * CORE_PROBE_TIMEOUT_MS(3s)，比轮询间隔(2s)长，setInterval 会让请求叠着发。
 * 每次拉完再排下一拍，天然不重叠。
 */
let connsTimer: ReturnType<typeof setTimeout> | null = null

/** 轮询是否已被主动停止。停止后即便有在途的 tick 也不再排下一拍。 */
let pollingStopped = false

/** 上一次流量采样，用来算瞬时速率。 */
let lastSample: { up: number; down: number; at: number } | null = null

/** 拉一次连接：更新状态标签的吞吐组件与连接标签的列表。失败时两者都进降级分支。 */
async function pollConnections(): Promise<void> {
  const response = await sendMessage({ type: 'LIST_CONNECTIONS' })
  if (!response.ok) {
    lastSample = null // 失败后重置，下次成功不拿旧样本算差值
    renderTraffic(null, null)
    renderConnections(null)
    return
  }
  const now = { up: response.data.uploadTotal, down: response.data.downloadTotal, at: Date.now() }
  const rate = computeRate(lastSample, now)
  lastSample = now
  renderTraffic(response.data, rate)
  renderConnections(response.data)
}

/** 启动持续轮询。重复调用是安全的：已在跑就不再排第二条链。 */
function startTrafficPolling(): void {
  if (connsTimer !== null) return
  pollingStopped = false
  const tick = async (): Promise<void> => {
    await pollConnections()
    if (pollingStopped) return
    connsTimer = setTimeout(() => void tick(), CONNS_POLL_MS)
  }
  void tick()
}

/**
 * 停止轮询。
 *
 * 生产环境用不到（Popup 关闭即销毁上下文），**存在只为测试可拆卸** ——
 * 否则每个 import 起的 setTimeout 链会跨用例乱窜、把消息塞进别的用例的断言里。
 */
export function stopTrafficPolling(): void {
  pollingStopped = true
  if (connsTimer !== null) {
    clearTimeout(connsTimer)
    connsTimer = null
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    selectTab(tab.id)
  })
}

el.connsRefresh?.addEventListener('click', () => {
  void pollConnections()
})

/*
 * 分流模式切换（V0.4）。
 *
 * 选 smart 但一条规则都没有时不静默照做 —— 那会让浏览器实际走全局，
 * 而 UI 显示"智能"。改成提示去 Settings 加规则，并把用户带过去。
 */
for (const button of modeButtons) {
  button.addEventListener('click', async () => {
    const mode = button.dataset.mode as RoutingMode | undefined
    if (mode === undefined) return
    if (button.getAttribute('aria-checked') === 'true') return

    for (const b of modeButtons) b.disabled = true

    const response = await sendMessage({ type: 'SAVE_SETTINGS', patch: { routingMode: mode } })

    for (const b of modeButtons) b.disabled = false

    if (!response.ok) {
      showAlert(response.error)
      return
    }
    // 保存后重新采集：改分流模式会重写 chrome.proxy，
    // 必须让 UI 反映浏览器的实际状态而不是我们刚发出的意图。
    await refresh()
  })
}

/*
 * 测速（V0.3）。手动触发是刻意的：一次全量测速会让内核同时向几十个节点
 * 建连，绑在"打开 Popup"上等于每看一眼状态就触发一次（§17 / ADR-32）。
 */
el.testLatency?.addEventListener('click', async () => {
  const button = el.testLatency
  if (!button) return

  const original = button.textContent
  button.disabled = true
  button.textContent = t('popup.latencyTesting')

  const response = await sendMessage({ type: 'TEST_LATENCY' })

  button.disabled = false
  button.textContent = original

  if (response.ok) {
    render(response.data)
  } else {
    await refresh()
    showAlert(response.error)
  }
})

el.settings?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

/*
 * 「选最快」（V0.8）。先测速拿到最新延迟，再选出最低的那个切过去。
 *
 * 刻意先测速而非直接用现有 latency：现有值可能是很久以前测的、甚至没有。
 * 与切节点同属「逸出浏览器」的操作（改的是内核选中项，ADR-28）。
 * 已经是最快就不再发 SELECT_NODE —— 白切一次没意义。
 */
el.pickFastestBtn?.addEventListener('click', async () => {
  const button = el.pickFastestBtn
  if (!button) return

  button.disabled = true
  const original = button.textContent
  button.textContent = t('popup.latencyTesting')

  const tested = await sendMessage({ type: 'TEST_LATENCY' })
  if (!tested.ok) {
    button.disabled = false
    button.textContent = original
    await refresh()
    showAlert(tested.error)
    return
  }
  render(tested.data)

  const group = tested.data.group
  const fastest = group === null ? null : pickFastest(group.nodes, group.latency)

  if (fastest !== null && group !== null && fastest !== group.now) {
    const selected = await sendMessage({ type: 'SELECT_NODE', node: fastest })
    if (selected.ok) render(selected.data)
    else {
      await refresh()
      showAlert(selected.error)
    }
  }

  button.disabled = false
  button.textContent = original
})

// 先用浏览器语言把静态文案填上，避免面板在探活的这几秒里一片空白。
applyStaticText()

// 首次打开时拉状态。探活最坏要等 3 秒超时，
// 所以 HTML 里预置了 "正在检查 Mihomo…" 而不是空白，避免看起来像卡死。
void refresh().finally(() => {
  setBusy(false)
})

// 吞吐组件在默认可见的「状态」标签，所以轮询随 Popup 打开就启动、一直跑到关闭。
startTrafficPolling()
