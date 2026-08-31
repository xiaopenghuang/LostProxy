/**
 * chrome.proxy 封装 —— 对应技术方案 §28 Task 02 + Task 07。
 *
 * 这是全项目唯一被允许触碰浏览器代理设置的模块。
 *
 * ⚠️ 模块边界（技术方案 §29.12）：
 *   本文件**刻意不知道 Mihomo 的存在**，不 import mihomo.ts、不发任何网络请求。
 *   理由见下面 enableProxy 的注释——这不是洁癖，而是 fail-closed 语义的结构保证。
 */

import { PROXY_BYPASS_LIST, PROXY_SCHEME, SETTING_SCOPE } from '../shared/constants'
import { describeThrown, errors } from '../shared/errors'
import type { ApplyResult, LevelOfControl, NormalizedError, Settings } from '../shared/types'
import { buildPacScript, sanitizeRules } from './pac'

/** 浏览器代理设置的巡检结果。 */
export interface ProxyInspection {
  /** 设置归属层级。'unknown' 表示查询本身失败。 */
  levelOfControl: LevelOfControl | 'unknown'
  /** 浏览器当前的代理 mode，用于诊断展示。 */
  mode: string | null
  /**
   * 浏览器**实际**是否处于本扩展期望的配置。
   * 与「用户意图 enabled」分开判断，才能发现两者不一致
   * 并避免显示假 ON（技术方案 §22 Case 3）。
   */
  matchesExpected: boolean
}

/**
 * 构造 fixed_servers 代理配置。
 *
 * 两个决定命门的细节：
 *
 * 1. **用 `singleProxy`，不用 `proxyForHttp` / `proxyForHttps`。**
 *    官方文档对后者的定义是：「若流量使用的协议不是 HTTP/HTTPS/FTP，
 *    则使用 fallbackProxy；若未指定 fallbackProxy，**流量将直接发送而不经过代理**」。
 *    拆开写会给非 HTTP/HTTPS/FTP 的请求留下直连口子。
 *    `singleProxy` 在 Chromium 内部走 PROXY_LIST 类型，覆盖所有 per-URL 请求。
 *
 * 2. **bypassList 四项都不能少。**
 *    `<local>` 只匹配「简单主机名」——官方定义为「不含点且不是 IP 字面量」。
 *    因此 `localhost` 被覆盖，而 `127.0.0.1`、`[::1]` **不被覆盖**。
 *    少写会导致扩展访问 Controller(9090) 的请求被再次送进代理(7890)，
 *    形成自环，且不报错、只是诡异地卡住。
 *
 * 详见 architecture.md ADR-01 / ADR-02。
 */
export function buildProxyConfig(settings: Settings): chrome.proxy.ProxyConfig {
  /*
   * V0.4：smart 模式改用 PAC。
   *
   * 🔴 `mandatory: true` 不可省（security.md §4）。PAC 默认 fail-open ——
   *    脚本无效时浏览器会**静默退回直连**，与 fixed_servers 的失败语义正好相反。
   *    设了它，失败会变成 ERR_MANDATORY_PROXY_CONFIGURATION_FAILED（可见故障）。
   *
   * smart 但一条规则都没有时**退回 global**，而不是生成一个"全部走代理"的
   * PAC 脚本。两者网络行为一致，但 fixed_servers 是更简单、更可预测的那条路径，
   * 且不必让每个请求都执行一次 JS。
   */
  if (settings.routingMode === 'smart' && sanitizeRules(settings.directRules).length > 0) {
    return {
      mode: 'pac_script',
      pacScript: {
        data: buildPacScript(settings.proxyHost, settings.proxyPort, settings.directRules),
        mandatory: true,
      },
    }
  }

  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme: PROXY_SCHEME,
        host: settings.proxyHost,
        port: settings.proxyPort,
      },
      // 常量声明为 readonly，而 chrome API 要的是可变 string[]，故展开成新数组。
      bypassList: [...PROXY_BYPASS_LIST],
    },
  }
}

/** 判断给定的 levelOfControl 是否明确禁止本扩展写入。 */
export function isBlockedByControl(level: LevelOfControl | 'unknown'): boolean {
  return level === 'not_controllable' || level === 'controlled_by_other_extensions'
}

/** 比较浏览器实际配置是否就是我们期望写入的那一份。 */
function configMatches(config: chrome.proxy.ProxyConfig | undefined, expected: Settings): boolean {
  if (!config) return false

  /*
   * V0.4：smart 模式下浏览器处于 pac_script。
   *
   * 只比对 mode 与「脚本里确实出现了我们的代理地址」，不做全文比较 ——
   * 浏览器 get() 回来的字符串可能被规范化（空白、换行），
   * 全文相等会产生误判，而误判的后果是 UI 显示"状态不一致"的假警报。
   */
  /*
   * 🔴 先判「我们期望的是哪种 mode」，再拿它与实际 mode 比对。
   *
   * 此方最初写成 `if (expected.routingMode === 'smart' && config.mode === 'pac_script')`，
   * 那是个真 bug：smart 且有规则时我们期望 pac_script，但若浏览器实际停在
   * fixed_servers（写入被别的东西覆盖、或写入根本没发生），
   * 这个条件不成立，于是**穿透到下面的 fixed_servers 比较**并因为
   * host/port 恰好相同而返回 true。
   *
   * 后果正是本项目最不能出的那种：`proxyActuallySet` 报 true，
   * UI 显示"智能分流已生效、状态一致"，而浏览器其实在把**所有**流量
   * 送进代理 —— 包括本该直连的校内站点。用户看不出任何异常。
   *
   * 现在改成 mode 必须相符：期望 pac_script 却拿到别的，就是不一致。
   */
  const expectedConfig = buildProxyConfig(expected)

  if (config.mode !== expectedConfig.mode) return false

  if (expectedConfig.mode === 'pac_script') {
    // 只比对「脚本里确实出现了我们的代理地址」，不做全文比较 ——
    // 浏览器 get() 回来的字符串可能被规范化（空白、换行），
    // 全文相等会产生误判，而误判的后果是 UI 显示"状态不一致"的假警报。
    const data = config.pacScript?.data ?? ''
    return data.includes(`${expected.proxyHost}:${expected.proxyPort}`)
  }

  const server = config.rules?.singleProxy
  if (!server) return false

  // 只比 host 与 port，不比 scheme：官方明确说明 get() 返回的对象
  // 与 set() 传入的对象并不完全相同（会补全字段），
  // 拿 scheme 做严格比较容易因规范化差异产生误判。
  return server.host === expected.proxyHost && server.port === expected.proxyPort
}

/** 巡检浏览器当前代理状态。查询失败时返回 'unknown' 而不是抛错。 */
export async function inspectProxy(expected: Settings): Promise<ProxyInspection> {
  try {
    const result = await chrome.proxy.settings.get({})
    return {
      levelOfControl: result.levelOfControl,
      mode: result.value?.mode ?? null,
      matchesExpected: configMatches(result.value, expected),
    }
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
 * 这是刻意设计，不是遗漏：
 *
 *   Chromium 官方 net 文档确认，单代理且无 fallback 配置下，
 *   代理不可达时所有请求会失败并报 ERR_PROXY_CONNECTION_FAILED，
 *   **不会**静默回落到 DIRECT（要回落必须显式写成 "proxy,direct://"）。
 *
 *   因此「Core 没起来就照样开代理」的结果是网页打不开——一个可见故障。
 *   而「Core 没起来就不开代理」的结果是用户以为在走代理、实际直连——
 *   一个不可见的真实 IP 泄漏。前者远优于后者。
 *
 * Core 探活是**另一件事**，由 Service Worker 在调用本函数之后单独进行，
 * 并把 CORE_OFFLINE 作为告警附在状态快照上。代理该开的还是开着。
 *
 * 唯一会导致「不写入」的情况是浏览器层面根本不允许我们写
 * （被别的扩展或 Policy 控制）——那时候写了也不会生效，
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
    await chrome.proxy.settings.set({
      value: buildProxyConfig(settings),
      scope: SETTING_SCOPE,
    })
    return { ok: true }
  } catch (thrown) {
    return { ok: false, error: errors.proxyWriteFailed(describeThrown(thrown)) }
  }
}

/**
 * 关闭代理。
 *
 * **用 `clear()` 而不是 `set({ mode: 'direct' })`**（architecture.md ADR-18）。
 *
 * 技术方案 §9.2 提到两种做法都要测。选 clear() 的理由是语义正确：
 *
 *   - `set({ mode: 'direct' })` 会让本扩展**继续持有**代理控制权，
 *     并**强制**浏览器直连。这越权了——它会覆盖用户可能存在的
 *     其他合法配置（系统代理、优先级更低的其他扩展）。
 *   - `clear()` 释放控制权，让浏览器回落到下层设置。
 *
 * 「关闭 LostProxy」的正确语义是「LostProxy 不再干预」，
 * 而不是「强制全世界直连」。在任务书假定的环境里（无系统代理）
 * 两者结果相同，都会回到校园网直连；但在有其他配置时，
 * 只有 clear() 是不越权的那个。
 */
export async function disableProxy(): Promise<ApplyResult> {
  try {
    await chrome.proxy.settings.clear({ scope: SETTING_SCOPE })
    return { ok: true }
  } catch (thrown) {
    return { ok: false, error: errors.proxyWriteFailed(describeThrown(thrown)) }
  }
}

/**
 * 把 chrome.proxy.onProxyError 的原始事件转成规范化错误。
 *
 * 🔴 `fatal` 字段是这里唯一重要的东西。官方定义：
 *
 *   > If true, the error was fatal and the network transaction was aborted.
 *   > **Otherwise, a direct connection is used instead.**
 *
 * 也就是说 `fatal: false` 意味着**这个请求已经直连出去了**，真实 IP 可能已暴露。
 * 这是运行时唯一能观测到「发生了静默直连」的信号，必须当作高危告警处理，
 * 不能和普通错误混在一起（architecture.md ADR-04）。
 *
 * 两种文案的取向是**相反**的，因为两种情况的严重程度是相反的：
 *   - fatal=true  → 请求被拦住了，没泄漏。要**安抚**用户，并给出可操作的排查方向。
 *     用户看到红色告警的第一反应是慌，不告诉他"没泄漏"是失职。
 *   - fatal=false → 已经漏出去了。要**警告**用户，不能有任何安抚措辞。
 *
 * 刻意不把 `details.error`（如 net::ERR_PROXY_CONNECTION_FAILED）当作主文案：
 * 那是给开发者看的错误码，对用户毫无意义。也不取 `details.details`——
 * 它可能包含很长的 PAC 运行时信息，塞进面向用户的文案里既无用又扩大意外泄漏面。
 */
export function normalizeProxyError(details: chrome.proxy.ErrorDetails): NormalizedError {
  return details.fatal ? errors.proxyBlocked() : errors.proxyLeakSuspected()
}

/**
 * 注册代理错误监听。
 *
 * ⚠️ MV3 约束：本函数必须在 Service Worker 脚本的**顶层同步调用**。
 * 若放在某个 async 流程里延迟注册，SW 被唤醒后事件会在监听器挂上之前丢失。
 *
 * 处理器本身不做持久化——那需要 storage，而 proxy.ts 不该依赖 storage
 * （模块边界）。调用方负责把错误落盘。
 */
export function registerProxyErrorListener(
  handler: (error: NormalizedError) => void | Promise<void>,
): void {
  chrome.proxy.onProxyError.addListener((details) => {
    void handler(normalizeProxyError(details))
  })
}
