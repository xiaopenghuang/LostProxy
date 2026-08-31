/**
 * 代理编排层 —— 对应技术方案 §28 Task 02 + Task 07。
 *
 * ## 这个文件里有什么、没有什么
 *
 * **没有**任何浏览器 API 调用。`chrome.proxy` 的读写全在
 * `platform/chromium.ts`，本文件只经由 `platform` 契约与它对话
 * （architecture.md ADR-36）。
 *
 * **有**的是全部**决策**，而且这些决策每一条都是安全语义：
 *
 *   - 被别的扩展 / Policy 控制时**拒绝写入**（不显示假 ON）
 *   - 查询失败（`unknown`）**不阻断**写入（放弃写入的代价是泄漏）
 *   - 关闭用「释放控制权」而不是「强制直连」（ADR-18）
 *   - 写入前**不**探测 Core 是否可用（ADR-03 fail-closed）
 *
 * 把这些留在共享层是刻意的：它们与浏览器无关，而**每复制一份就多一个
 * 会漂移的地方**。将来加 Firefox 时，这些判断一条都不该被重写 ——
 * 若发现需要重写，说明平台边界划错了，那是个该停下来的信号。
 *
 * ⚠️ 模块边界（技术方案 §29.12）：本文件同样不 import mihomo.ts、
 *    不发任何网络请求。`tests/proxy.test.ts` 有一条测试把 `fetch` 从全局
 *    删掉来锁这件事。
 */

import { describeThrown, errors } from '../shared/errors'
import type { ApplyResult, LevelOfControl, NormalizedError, Settings } from '../shared/types'
import { platform } from './platform'
import type { PlatformBlocker, ProxyInspection } from './platform'

/**
 * 巡检结果类型从平台层透传出去。
 *
 * 调用方（orchestrator）一直从 `./proxy` 拿这个类型，没有理由让它改成
 * 从 `./platform` 拿 —— 它关心的是"代理模块的巡检结果"，
 * 而不是"平台抽象的巡检结果"。
 */
export type { ProxyInspection }

/** 判断给定的 levelOfControl 是否明确禁止本扩展写入。 */
export function isBlockedByControl(level: LevelOfControl | 'unknown'): boolean {
  return level === 'not_controllable' || level === 'controlled_by_other_extensions'
}

/**
 * 平台前置检查的结果 → 面向用户的错误。
 *
 * 🔴 声明成 `Record<PlatformBlocker, ...>` 而不是 switch：
 *   给 `PlatformBlocker` 加一个成员时这里会**编译失败**，
 *   逼着新情况被明确表态。若写成 switch + default，
 *   新增的 blocker 会静默落进「未知错误」——
 *   而这类错误恰恰是**用户自己能修好**的那种，
 *   报成"未知"等于把一个可解决的问题变成一堵墙。
 *
 * 与 ADR-20 用 `Record<ErrorCode, boolean>` 强制对每个错误码表态同源。
 */
const BLOCKER_TO_ERROR: Record<PlatformBlocker, () => NormalizedError> = {
  privateBrowsingAccessRequired: () => errors.privateBrowsingAccessRequired(),
  routingPermissionRequired: () => errors.routingPermissionRequired(),
}

/**
 * 当前浏览器**能不能支持**这份配置。
 *
 * 🔴 与「现在能不能写」是两件事，见 `platform/types.ts` 里 `supports` 的注释。
 *
 * 供**保存设置**路径调用：不让用户存下一份这个浏览器做不到的配置。
 * 少了这道闸门，Firefox 用户可以在代理关着时把模式切成「智能」——
 * 保存会成功，然后开关就再也点不动了（真机上踩到的死角）。
 * 那是最糟的一种交互：一个能存下去、却让功能失效的设置。
 *
 * 返回 `null` 表示支持。
 */
export async function checkSupported(settings: Settings): Promise<NormalizedError | null> {
  const blocker = await platform.supports(settings)
  return blocker === null ? null : BLOCKER_TO_ERROR[blocker]()
}

/**
 * 索取这份配置所需的可选权限，然后复查是否已具备。
 *
 * ⚠️ **只能从用户手势的调用栈里调**（Firefox 的 `permissions.request()`
 *    无手势时直接拒绝）。所以它出现在处理「用户点了开关 / 切了模式」
 *    这两条消息的路径上，绝不在 `reconcile()` 之类的后台流程里。
 *
 * 返回 `null` 表示现在可以用了；返回错误表示用户拒绝了授权，
 * 或者这个平台根本做不到。
 *
 * 为什么要在 request 之后**再查一次** `checkSupported`：`request()` 返回
 * true 只说明弹窗被接受，而"能不能用"是由 `supports` 定义的 ——
 * 两者之间可能还有别的条件（将来加了新 blocker 时尤其如此）。
 * 以 `supports` 为准，`request` 只是尝试改变它的答案。
 */
export async function ensureSupported(settings: Settings): Promise<NormalizedError | null> {
  const first = await checkSupported(settings)
  if (first === null) return null

  const granted = await platform.requestPermissions(settings)
  if (!granted) return first

  return checkSupported(settings)
}

/**
 * 巡检浏览器当前代理状态。
 *
 * 查询失败时返回 `'unknown'` 而不是抛错 —— 这是个**决策**，所以在共享层：
 * 上层需要「查不到」和「查到了但不匹配」在类型上就分得开，
 * 否则一次查询失败会被当成「代理没生效」而触发不必要的重写。
 */
export async function inspectProxy(expected: Settings): Promise<ProxyInspection> {
  try {
    return await platform.readProxyState(expected)
  } catch {
    return { levelOfControl: 'unknown', mode: null, matchesExpected: false }
  }
}

/**
 * 开启代理。
 *
 * 🔴 **Fail-closed 语义（architecture.md ADR-03）**
 *
 * 本函数**不检查 Mihomo 是否在运行**，也不会因为 Core 离线而放弃写入。
 * 这是刻意设计，不是遗漏：代理写了但内核没起来的结果是网页打不开
 * （一个**可见**故障）；不写的结果是用户以为在走代理而实际直连
 * （一个**不可见**的真实 IP 泄漏）。前者远优于后者。
 *
 * Core 探活是**另一件事**，由 orchestrator 在调用本函数之后单独进行，
 * 并把 CORE_OFFLINE 作为告警附在状态快照上。代理该开的还是开着。
 *
 * 唯一会导致「不写入」的情况是浏览器层面根本不允许我们写
 * （被别的扩展或 Policy 控制）—— 那时候写了也不会生效，
 * 显示一个假 ON 才是真正的危险。
 */
export async function enableProxy(settings: Settings): Promise<ApplyResult> {
  const inspection = await inspectProxy(settings)

  if (inspection.levelOfControl === 'not_controllable') {
    return { ok: false, error: errors.proxyNotControllable() }
  }
  if (inspection.levelOfControl === 'controlled_by_other_extensions') {
    return { ok: false, error: errors.proxyControlledByOther() }
  }
  // 注意 'unknown'（get 查询失败）**不阻断**写入：
  // 查询失败不代表写入会失败，而放弃写入的代价是泄漏风险。
  // 依照 fail-closed 精神，先尝试保护，写失败了再报错。

  /*
   * 平台级前置条件，两道。
   *
   * 顺序上放在 levelOfControl 之后是刻意的：那两条是「浏览器不让我们写」，
   * 而这两条是平台自身的限制。前者更根本 —— 被 Policy 锁死时，
   * 谈论"要不要授予隐私窗口权限"没有意义。
   *
   * 🔴 这里**不能**沿用「unknown 不阻断」那条豁免。两者的性质相反：
   *   查询失败时我们不知道写入会不会成功，试一下的代价只是可能报错；
   *   而 blocker 是**已知**写不进去（Firefox 无隐私窗口权限时 set() 必抛）
   *   或**已知**写下去是错的（不支持内联 PAC 时按全局写会静默丢掉用户的
   *   直连规则）。后者尤其危险：它不是"没保护"，而是"保护成了另一种样子"，
   *   且用户看不出来。
   *
   * 先能力后授权：能力问题用户改个设置就好，授权问题要去浏览器里点。
   * 顺序颠倒的话，一个既没授权又开着分流的用户会先被要求去授权，
   * 授完权再被告知分流做不到 —— 两次往返。
   */
  const unsupported = await ensureSupported(settings)
  if (unsupported !== null) {
    return { ok: false, error: unsupported }
  }

  const blocker = await platform.preflight()
  if (blocker !== null) {
    return { ok: false, error: BLOCKER_TO_ERROR[blocker]() }
  }

  try {
    await platform.applyProxy(settings)
    return { ok: true }
  } catch (thrown) {
    return { ok: false, error: errors.proxyWriteFailed(describeThrown(thrown)) }
  }
}

/**
 * 关闭代理。
 *
 * 语义是「LostProxy 不再干预」，而不是「强制全世界直连」（ADR-18）。
 * 平台层用各自的 `clear()` 实现这一点；这里只负责把失败归一成
 * 面向用户的错误 —— 归一放在共享层，两个平台的文案才不会漂移。
 */
export async function disableProxy(): Promise<ApplyResult> {
  try {
    await platform.releaseProxy()
    return { ok: true }
  } catch (thrown) {
    return { ok: false, error: errors.proxyWriteFailed(describeThrown(thrown)) }
  }
}

/**
 * 注册代理错误监听。
 *
 * ⚠️ MV3 约束：本函数必须在 Service Worker 脚本的**顶层同步调用**。
 * 若放在某个 async 流程里延迟注册，SW 被唤醒后事件会在监听器挂上之前丢失。
 *
 * 原始事件 → `NormalizedError` 的归一由平台层做，因为**事件形状本身**
 * 是平台特有的（Chromium 的 `fatal` 字段决定了「被拦住」与「已直连」，
 * Firefox 的 `proxy.onError` 没有这个字段）。
 *
 * 处理器本身不做持久化 —— 那需要 storage，而代理层不该依赖 storage
 * （模块边界）。调用方负责把错误落盘。
 */
export function registerProxyErrorListener(
  handler: (error: NormalizedError) => void | Promise<void>,
): void {
  platform.onProxyError(handler)
}

/**
 * 注册平台自己需要的长期监听。
 *
 * ⚠️ 必须在背景脚本**顶层同步**调用，与 registerProxyErrorListener 同理。
 *    理由见 platform/types.ts 里 registerListeners 的注释 ——
 *    Firefox 的事件页会被卸载，从业务流程里挂的监听不会被重挂。
 *
 * 这层封装存在的意义与 registerProxyErrorListener 一样：让 index.ts
 * 只 import 一个模块（./proxy），不必知道 platform 这层的存在。
 */
export function registerPlatformListeners(
  stateReader: () => Promise<{ enabled: boolean; settings: Settings }>,
): void {
  platform.registerListeners(stateReader)
}
