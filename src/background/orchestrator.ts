/**
 * 跨模块编排层。
 *
 * 为什么要从 index.ts 抽出来：
 *   index.ts 作为 Service Worker 入口，import 时会立即执行顶层事件注册，
 *   在单元测试里没法安全导入。而本项目最核心的安全语义
 *   ——「先写代理，再管别的」的 fail-closed 顺序（ADR-03）——
 *   恰恰活在编排逻辑里。让它只有代码注释保护是不够的：
 *   ADR-20 的精神是把架构约束变成会炸的测试，这里也该照办。
 *
 * 抽出后 index.ts 只剩事件绑定，本文件不碰 chrome.runtime 事件，可完整测试。
 *
 * ⚠️ 与 index.ts 同样受 ADR-08 约束：禁止在模块作用域持有可变状态。
 */

import { ALERT_STALE_AFTER_MS, CONTROLLER_PORT_CANDIDATES } from '../shared/constants'
import { errors, isSelfHealing } from '../shared/errors'
import type { Request, Response, ResponsePayloads } from '../shared/messages'
import type {
  CoreStatus,
  GroupView,
  NormalizedError,
  ProxyGroup,
  Settings,
  StatusSnapshot,
} from '../shared/types'
import {
  getGroups,
  getLatencies,
  getProviders,
  getVersion,
  probeControllerPort,
  selectNode,
  testGroupDelay,
  updateProvider,
  type ProbeResult,
} from './mihomo'
import { inspectWebRtcPolicy, syncWebRtcLock } from './privacy'
import { disableProxy, enableProxy, inspectProxy, isBlockedByControl, type ProxyInspection } from './proxy'
import {
  getEnabledState,
  getLastError,
  getSettings,
  saveSettings,
  setEnabledState,
  setLastError,
  toSettingsView,
} from './storage'

// ---------------------------------------------------------------------------
// 状态一致性校准
// ---------------------------------------------------------------------------

/**
 * 校准「用户意图」与「浏览器实际状态」。
 *
 * 为什么需要：扩展被禁用时浏览器会自动清除我们写入的代理设置
 * （ChromeSetting 的生命周期，ADR-06）。重新启用后，storage 里
 * enabled 仍是 true，但浏览器已经直连了——这正是技术方案 §4.1 C
 * 要求「浏览器实际代理状态与 UI 状态一致」所指的情况。
 *
 * 只在 onStartup / onInstalled 时调用，不放进 GET_STATUS：
 * 状态查询应当是只读的，带副作用的查询会让问题极难复现。
 */
export async function reconcile(): Promise<void> {
  const enabled = await getEnabledState()
  if (!enabled) return

  const settings = await getSettings()
  const inspection = await inspectProxy(settings)

  // 已经一致，或者浏览器层面根本不让我们写 —— 两种情况都不该动手。
  if (inspection.matchesExpected || isBlockedByControl(inspection.levelOfControl)) return

  await enableProxy(settings)
  await syncWebRtcLock(true, settings.webRtcLockEnabled)
}

// ---------------------------------------------------------------------------
// 状态采集
// ---------------------------------------------------------------------------

/**
 * 把探活结果映射成三态。
 *
 * 关键区分（ADR-23）：`CORE_OFFLINE` 意味着那个端口上**什么都没有**，
 * 完全可能是用户刻意只用 named pipe；而认证失败或响应不对
 * 意味着端口上**确实有服务**、只是配置填错了——那才是真错误。
 */
function toCoreStatus(probe: ProbeResult): CoreStatus {
  if (probe.ok) return 'online'
  return probe.error.code === 'CORE_OFFLINE' ? 'unreachable' : 'error'
}

/**
 * 挑出「当前最该让用户看到」的那一条错误。
 *
 * 之所以在 background 算好而不是丢给 UI 判断：技术方案 §29.12 要求
 * Popup 只负责渲染。把优先级逻辑放在 UI 层，两个页面就会各自实现一套，
 * 迟早漂移成不一致的提示。
 *
 * 优先级由高到低，依据就是「危害程度」：
 *   1. 持久化的运行时代理错误 —— 可能已经泄漏过真实 IP，最严重
 *   2. 代理被别的扩展 / Policy 控制 —— 用户以为开着，其实没生效
 *   3. 开关是 ON 但浏览器实际没在用我们的配置 —— 同上，状态不一致
 *   4. Controller 配置错误（认证失败 / 端口指向了别的服务）
 *
 * 🔴 刻意**不包含** `CORE_OFFLINE`（ADR-23）：
 *   代理走 mixed-port，与 Controller 完全无关。用户的客户端可能
 *   刻意只开 named pipe 而不开 HTTP controller（这其实更安全，
 *   因为不暴露 TCP 端口）。把这种情况报成错误，会在那些用户那里
 *   产生一条**永久挂着**的告警，而代理明明工作正常。
 *   永久噪音会训练用户无视所有告警 —— 比没有告警更糟。
 */
export function pickError(
  persisted: NormalizedError | null,
  enabled: boolean,
  inspection: ProxyInspection,
  probe: ProbeResult,
): NormalizedError | null {
  if (persisted !== null) return persisted

  if (enabled) {
    if (inspection.levelOfControl === 'not_controllable') return errors.proxyNotControllable()
    if (inspection.levelOfControl === 'controlled_by_other_extensions') {
      return errors.proxyControlledByOther()
    }
    if (!inspection.matchesExpected) {
      return errors.stateMismatch()
    }
  }

  // 只有「连上了但配置不对」才算错误；「连不上」是中性状态。
  if (!probe.ok && probe.error.code !== 'CORE_OFFLINE') return probe.error

  return null
}

/**
 * 从全部组里找出用户选定的那个，投影成 UI 可直接渲染的形态（V0.2）。
 *
 * 三种「读不到」都是**正常分支**而非异常：没选组、组不存在、内核不可达。
 * 因此返回 `[null, error]` 而不是抛 —— 抛异常会诱使调用方
 * 用 try/catch 包住整个状态采集，一次组读取失败就毁掉整个快照。
 */
function resolveGroup(
  settings: Settings,
  groups: readonly ProxyGroup[],
  latency: Readonly<Record<string, number | null>>,
): readonly [GroupView | null, NormalizedError | null] {
  if (settings.primaryGroup.length === 0) return [null, errors.groupNotConfigured()]

  // 逐字节相等匹配。刻意不做大小写无关或 trim 后的模糊匹配：
  // 组名要发回内核，模糊匹配到的名字未必是内核认的那个。
  const found = groups.find((g) => g.name === settings.primaryGroup)
  if (found === undefined) return [null, errors.groupNotFound(settings.primaryGroup)]

  // 只保留该组成员的延迟，不把整个内核的 proxy 字典塞进快照。
  const scoped: Record<string, number | null> = {}
  for (const name of found.all) {
    scoped[name] = latency[name] ?? null
  }

  return [
    { name: found.name, type: found.type, now: found.now, nodes: found.all, latency: scoped },
    null,
  ]
}

/** 采集完整运行时快照。只读，无副作用。 */
export async function collectStatus(): Promise<StatusSnapshot> {
  const settings = await getSettings()
  const enabled = await getEnabledState()

  /*
   * 六项探测互不依赖，并发跑省掉串行等待
   * （探活最坏要等 3 秒超时，串起来会让 Popup 明显卡顿）。
   *
   * `getLatencies` 读的是内核 health-check 已有的 history，
   * **不触发任何测速**（ADR-32）。它失败时返回空字典而非错误 ——
   * 延迟是装饰性信息，取不到应该表现为"没有延迟显示"，
   * 而不该让整个节点列表变成错误页。
   */
  const [inspection, probe, webRtc, persisted, groupsResult, latency] = await Promise.all([
    inspectProxy(settings),
    getVersion(settings),
    inspectWebRtcPolicy(),
    getLastError(),
    getGroups(settings),
    getLatencies(settings),
  ])

  /*
   * 组读取失败不进 pickError，只进 groupError（types.ts 有详述）。
   * 若混进 lastError，一次「组名不存在」就会顶掉一条尚未确认的
   * PROXY_LEAK_SUSPECTED —— 用不重要的信息盖掉最重要的信息。
   */
  const [group, groupError] = groupsResult.ok
    ? resolveGroup(settings, groupsResult.groups, latency)
    : ([null, groupsResult.error] as const)

  return {
    enabled,
    // 投影成视图：Controller Secret 明文不越过这条边界。
    settings: toSettingsView(settings),
    coreStatus: toCoreStatus(probe),
    coreVersion: probe.ok ? probe.version.version : null,
    levelOfControl: inspection.levelOfControl,
    proxyActuallySet: inspection.matchesExpected,
    webRtcLocked: webRtc.locked,
    lastError: pickError(persisted, enabled, inspection, probe),
    group,
    groupError,
  }
}

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

/**
 * 判断「问题看起来已经解决了」。
 *
 * ⚠️ 这里刻意**不**把 `coreStatus === 'online'` 当作必要条件。
 *   那是此方最初的写法，但它复刻了 ADR-23 要修的同一个错误：
 *   把「Core 可观测」当成「代理可用」。在只开 named pipe 的客户端上
 *   coreStatus 永远是 unreachable，自愈就永远不会触发——
 *   等于这个功能对那些用户完全无效。
 *
 * 改成两级证据：
 *   - **强证据**：Controller 可达 ⇒ Mihomo 确实在跑，可以立即自愈。
 *   - **弱证据**：Controller 不可观测时退化为时间判据。若代理仍然坏着，
 *     这段时间内任何一次页面加载都会产生**新的** onProxyError 并刷新
 *     时间戳，告警不会消失。所以时间窗口衡量的是「最近有没有真的在失败」。
 *
 * 两者都要求 `proxyActuallySet` —— 连配置都没正确写进浏览器，
 * 问题显然没解决。
 */
function looksRecovered(snapshot: StatusSnapshot, error: NormalizedError): boolean {
  if (!snapshot.proxyActuallySet) return false
  if (snapshot.coreStatus === 'online') return true
  return Date.now() - error.at >= ALERT_STALE_AFTER_MS
}

/**
 * 若持有的告警已经不再成立，就清掉它。
 *
 * 🔴 为什么需要自愈（architecture.md ADR-22）：
 *   `setLastError(null)` 只在 toggle 开关时执行。真机上踩到的后果是：
 *   端口填错导致一串 proxy error，用户改对端口、代理完全正常后，
 *   那条红色告警**仍永久挂着**，而且因为它在 `pickError()` 里优先级最高，
 *   会盖住其他所有状态显示——用户看到「Mihomo Online + 红色报错」的矛盾画面。
 *
 * 🔴 为什么不能一律自愈：
 *   `PROXY_LEAK_SUSPECTED`（fatal=false）记录的是「已经发生过直连」这个**事实**，
 *   不是一个当前状态。悄悄清掉等于替用户决定「这事不重要」，
 *   而这恰恰是本项目唯一真正需要用户知道的事。它必须由用户显式 Dismiss。
 *
 * ⚠️ 刻意接收已采集好的快照而不是自己去探测：collectStatus 里的探活
 * 最坏要等 3 秒超时，重复一次会让 Popup 打开需要 6 秒。
 */
export async function healIfRecovered(snapshot: StatusSnapshot): Promise<StatusSnapshot> {
  const error = snapshot.lastError
  if (error === null || !isSelfHealing(error.code)) return snapshot

  if (!looksRecovered(snapshot, error)) return snapshot

  await setLastError(null)
  return { ...snapshot, lastError: null }
}

/** 采集状态并顺带自愈过期告警。GET_STATUS 的处理入口。 */
export async function handleGetStatus(): Promise<Response<StatusSnapshot>> {
  const snapshot = await collectStatus()
  return { ok: true, data: await healIfRecovered(snapshot) }
}

/**
 * 用户显式确认并清除告警。
 *
 * 这是 `PROXY_LEAK_SUSPECTED` 唯一的退出路径——它不自愈，
 * 所以必须有一条用户能主动关掉它的通道，否则告警就成了永久噪音，
 * 用户最终会学会无视所有告警，那比没有告警更糟。
 */
export async function handleDismissError(): Promise<Response<StatusSnapshot>> {
  await setLastError(null)
  return { ok: true, data: await collectStatus() }
}

/**
 * 开启代理。
 *
 * 🔴 顺序至关重要（fail-closed，ADR-03）：
 *   **先写代理，再管别的。** 不做任何前置探活。
 *
 *   Core 没起来不是拒绝开启的理由——那只会让用户以为在走代理、
 *   实际直连，泄漏真实 IP。写进去之后 Edge 会报
 *   ERR_PROXY_CONNECTION_FAILED（网页打不开），这是可见故障，远优于静默泄漏。
 *
 *   唯一会拒绝的情况是浏览器层面不允许写入——那时候写了也不生效，
 *   把开关点亮成 ON 才是真正的欺骗。
 */
export async function handleEnable(): Promise<Response<StatusSnapshot>> {
  const settings = await getSettings()

  const applied = await enableProxy(settings)
  if (!applied.ok) {
    // 关键：不把 enabled 置为 true，避免显示一个不存在的 ON。
    await setLastError(applied.error)
    return { ok: false, error: applied.error }
  }

  await setEnabledState(true)
  await syncWebRtcLock(true, settings.webRtcLockEnabled)
  // 新的一次开启 —— 上一轮的运行时告警不再相关。
  await setLastError(null)

  return { ok: true, data: await collectStatus() }
}

/** 关闭代理，释放控制权并解除 WebRTC 锁。 */
export async function handleDisable(): Promise<Response<StatusSnapshot>> {
  const applied = await disableProxy()
  if (!applied.ok) {
    await setLastError(applied.error)
    return { ok: false, error: applied.error }
  }

  await setEnabledState(false)
  const settings = await getSettings()
  await syncWebRtcLock(false, settings.webRtcLockEnabled)
  await setLastError(null)

  return { ok: true, data: await collectStatus() }
}

/**
 * 保存设置。
 *
 * ⚠️ 极易漏掉的一步：代理正开着时改了 host/port，必须**用新设置重新写入**，
 * 否则浏览器还指向旧端口，而 UI 显示的是新端口——一个隐蔽的状态撕裂。
 */
export async function handleSaveSettings(
  patch: Partial<Settings>,
): Promise<Response<ResponsePayloads['SAVE_SETTINGS']>> {
  const result = await saveSettings(patch)
  if (!result.ok) {
    return { ok: false, error: errors.invalidSettings(result.errors) }
  }

  const enabled = await getEnabledState()
  if (enabled) {
    await enableProxy(result.value)
  }
  await syncWebRtcLock(enabled, result.value.webRtcLockEnabled)

  return { ok: true, data: toSettingsView(result.value) }
}

/** V0.2：拉取全部策略组，供 Settings 页选主策略组。 */
export async function handleListGroups(): Promise<Response<ResponsePayloads['LIST_GROUPS']>> {
  const settings = await getSettings()
  const result = await getGroups(settings)

  return result.ok ? { ok: true, data: { groups: result.groups } } : { ok: false, error: result.error }
}

/**
 * V0.2：切换主策略组的选中节点。
 *
 * ⚠️ 这个操作改动的是**内核的全局状态**，效果不限于本浏览器（ADR-28）。
 *
 * 刻意**不**校验 node 是否在组的成员列表里：列表本身就是内核给的，
 * 而两次请求之间订阅可能已经更新。真正的权威判定在内核那边 ——
 * 它对不认识的成员名回 400，我们照实报错（ADR-29 的同一条思路）。
 */
export async function handleSelectNode(node: string): Promise<Response<StatusSnapshot>> {
  const settings = await getSettings()

  if (settings.primaryGroup.length === 0) {
    return { ok: false, error: errors.groupNotConfigured() }
  }

  const applied = await selectNode(settings, settings.primaryGroup, node)
  if (!applied.ok) {
    /*
     * 🔴 刻意**不** setLastError。
     *   切节点失败是一次操作的失败，不是代理层的安全事件。写进 lastError
     *   会让它挤进 pickError 的最高优先级，从而盖住真正的代理告警 ——
     *   而 lastError 里那条可能是尚未确认的泄漏警告。
     *   失败信息通过响应信封直接回给发起这次点击的 UI 就够了。
     */
    return { ok: false, error: applied.error }
  }

  return { ok: true, data: await collectStatus() }
}

/**
 * V0.3：对主策略组测速。
 *
 * 只在用户显式点「测速」时才会走到这里（§17 / ADR-32）。测完不单独返回延迟，
 * 而是返回完整快照 —— 内核在测速后更新了自己的 history，
 * 重新采集一次能保证 UI 显示的与内核记录的一致，而不是两份可能分叉的数据。
 */
export async function handleTestLatency(): Promise<Response<StatusSnapshot>> {
  const settings = await getSettings()

  if (settings.primaryGroup.length === 0) {
    return { ok: false, error: errors.groupNotConfigured() }
  }

  /*
   * 刻意忽略测速返回值：内核已经把结果写进各节点的 history，
   * 紧接着的 collectStatus 会读到。用返回值直接构造快照反而会引入
   * 「测速结果」与「内核记录」两个可能不一致的来源。
   */
  await testGroupDelay(settings, settings.primaryGroup)

  return { ok: true, data: await collectStatus() }
}

/** V0.6：列出订阅。 */
export async function handleListProviders(): Promise<Response<ResponsePayloads['LIST_PROVIDERS']>> {
  const settings = await getSettings()
  const result = await getProviders(settings)

  return result.ok
    ? { ok: true, data: { providers: result.providers } }
    : { ok: false, error: result.error }
}

/**
 * V0.6：更新指定订阅，然后重新列出。
 *
 * 更新后重新拉列表而不是原样返回：订阅更新的**结果**就是节点数与更新时间变了，
 * 不重新读的话 UI 显示的还是旧数字，用户无法确认更新是否真的生效。
 */
export async function handleUpdateProvider(
  name: string,
): Promise<Response<ResponsePayloads['UPDATE_PROVIDER']>> {
  const settings = await getSettings()

  const applied = await updateProvider(settings, name)
  if (!applied.ok) {
    // 与 SELECT_NODE 同理：这是一次操作的失败，不是代理层安全事件，
    // 不写 lastError，免得盖住可能存在的泄漏告警。
    return { ok: false, error: applied.error }
  }

  const result = await getProviders(settings)
  return result.ok
    ? { ok: true, data: { providers: result.providers } }
    : { ok: false, error: result.error }
}

/**
 * 探测 Controller 端口。
 *
 * 🔴 刻意**不自动保存**探到的端口，只把结果回给 UI 让用户确认。
 *   自动写入意味着一次点击就改了用户的配置，而探测可能命中一个
 *   他并不想用的内核实例（例如同时跑着两个客户端）。
 *   端口是这个插件唯一必须填对的东西，替用户决定它不合适。
 */
export async function handleProbePort(): Promise<Response<ResponsePayloads['PROBE_PORT']>> {
  const settings = await getSettings()
  const port = await probeControllerPort(settings, CONTROLLER_PORT_CANDIDATES)
  return { ok: true, data: { port } }
}

/** 单次探活，不改动任何设置。用于 Settings 页的 [Test Mihomo]。 */
export async function handleTestCore(): Promise<Response<ResponsePayloads['TEST_CORE']>> {
  const settings = await getSettings()
  const probe = await getVersion(settings)

  return probe.ok
    ? { ok: true, data: { online: true, version: probe.version.version } }
    : { ok: false, error: probe.error }
}

/** 消息路由。未知消息一律拒绝，不静默忽略。 */
export async function handleMessage(message: unknown): Promise<Response<unknown>> {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return { ok: false, error: errors.malformedMessage() }
  }

  const request = message as Request

  try {
    switch (request.type) {
      case 'GET_STATUS':
        return await handleGetStatus()
      case 'ENABLE_PROXY':
        return await handleEnable()
      case 'DISABLE_PROXY':
        return await handleDisable()
      case 'TEST_CORE':
        return await handleTestCore()
      case 'DISMISS_ERROR':
        return await handleDismissError()
      case 'SAVE_SETTINGS':
        return await handleSaveSettings(request.patch)
      case 'LIST_GROUPS':
        return await handleListGroups()
      case 'SELECT_NODE':
        return await handleSelectNode(request.node)
      case 'TEST_LATENCY':
        return await handleTestLatency()
      case 'LIST_PROVIDERS':
        return await handleListProviders()
      case 'UPDATE_PROVIDER':
        return await handleUpdateProvider(request.name)
      case 'PROBE_PORT':
        return await handleProbePort()
      default: {
        // 穷举检查：新增消息类型时忘了处理，这里会编译失败。
        const exhaustive: never = request
        void exhaustive
        return { ok: false, error: errors.unsupportedMessage() }
      }
    }
  } catch (thrown) {
    // 兜底：任何未预期的异常都转成信封返回，
    // 否则 sendResponse 拿到 undefined，Popup 只会看到"没反应"。
    const reason = thrown instanceof Error ? thrown.message : 'unexpected failure'
    return { ok: false, error: errors.unknown(reason) }
  }
}
