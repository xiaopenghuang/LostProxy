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
import type { ProxyInspection } from './platform'

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
