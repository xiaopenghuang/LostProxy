/**
 * V0.10 请求头伪装 —— 把 `Accept-Language` 改成与出口地区一致。
 *
 * ## 为什么这件事必须在这里做
 *
 * 时区能在页面里改，因为它是 JS 读出来的值。语言不是：`Accept-Language`
 * 是浏览器在**每个请求上自动附加的 HTTP 头**，页面 JS 碰不到它，改它
 * 必须走网络层的拦截。而它恰恰是服务端**不需要执行任何 JS**就能读到的
 * 那一个信号 —— 层级比时区更低，也更常被用来判断"这个人从哪儿来"。
 *
 * Chromium 与 Firefox 都能用 `declarativeNetRequest` 的 `modifyHeaders`
 * 做这件事，所以这里没有平台分支。差异只在 manifest 声明的权限名上。
 *
 * ## 为什么是"对齐"而不是"增删"
 *
 * 规则是浏览器级持久化的：Service Worker 被回收、扩展被禁用再启用、
 * 浏览器重启，规则都还在。如果代码在各条路径上分散地 `addRules` /
 * `removeRuleIds`，那么漏掉任何一条路径的症状都是**用户已经关掉了功能，
 * 请求头还在被改** —— 一个不会自己恢复、也没有任何提示的错误状态。
 *
 * 所以这里的接口是声明式的：调用方每次都描述"现在应该是什么"，
 * 由 `syncHeaderRules` 与浏览器里的实际状态比对后一次性对齐。
 * 无论从哪条路径进入、SW 中间死过几次，结果都收敛到同一个状态。
 *
 * ## 原子性的取舍
 *
 * 返回值表示规则是否真的建立成功。调用方据此决定**要不要注入语言** ——
 * 见 `orchestrator.ts`：请求头改不了时，`locale` 会被置为 null，
 * 页面侧只改时区。理由是不对称的代价：
 *
 *   - 只改页面语言、不改请求头 → 头说中文、JS 说英文，一次请求加一次
 *     JS 执行就能看出矛盾，**比完全不改更糟**；
 *   - 两者都不改 → 回到 V0.9 的状态，用户至少是自洽的。
 */

import { acceptLanguageValue } from '../shared/locales'

/**
 * 规则 id 的起点。
 *
 * 9000 段留给"地理身份"这一组：DNR 的 id 是扩展内全局唯一的整数，
 * 而将来可能还有别的组（比如去掉某个头）。分段是为了让清理逻辑能按
 * 区间识别"哪些是我们的"，而不必依赖一个写死的 id 列表 ——
 * 后者在清单变化时会漏掉上一次留下的规则。
 */
const RULE_ID_BASE = 9100

/** 我们这一组规则的 id 上界（不含）。用于识别并清理旧规则。 */
const RULE_ID_LIMIT = 10000

/** 一条规则的完整形态，测试与比对都用这个结构。 */
export interface HeaderRule {
  readonly id: number
  readonly urlFilter: string
  readonly value: string
}

/**
 * 把域名清单 + 语言描述成目标规则集。
 *
 * 一条规则只能带一个 `urlFilter`，所以 N 个域名就是 N 条规则 ——
 * 这也是为什么 id 要按序号分配而不是固定一个。
 *
 * `urlFilter: '||example.com^'` 是 DNR 的域名锚点语法 + 分隔符：
 *
 *   - `||` 锚定在 host 的起点、**或某个点之后**，所以 `api.example.com`
 *     也命中（这是我们要的：清单里的域名自动覆盖子域）；
 *   - `^` 要求后面紧跟分隔符（`/`、`:`、`?` 等），而 `.` **不是**分隔符。
 *
 * 🔴 末尾那个 `^` 不能省。`||example.com` 会匹配 `example.com.evil.tld` ——
 *    那是一个别人可以自由注册的子域，而我们会给它也加上 `Accept-Language`。
 *    后果不算严重（只是多改了一个请求头），但它违背了「只碰你列出的域名」
 *    这个承诺，而这类越界没有任何地方会报错。
 *
 *    用 `requestDomains` 也能表达同样的语义，但它要求 Chrome 101+ 且
 *    Firefox 的实现不完全一致；`urlFilter` 两边都稳。
 *
 * 不指定 `resourceTypes`：默认匹配所有类型。只列 `main_frame` 是个
 * 很容易犯的错 —— 那样 XHR/fetch 就不改，而 ChatGPT 的大部分请求正是 XHR。
 */
export function describeRules(hosts: readonly string[], locale: string): HeaderRule[] {
  const value = acceptLanguageValue(locale)
  const rules: HeaderRule[] = []

  for (const raw of hosts) {
    const host = raw.trim().toLowerCase()
    if (host.length === 0) continue
    rules.push({ id: RULE_ID_BASE + rules.length, urlFilter: `||${host}^`, value })
  }

  return rules
}

/** DNR 的规则对象。只声明用到的字段。 */
function toBrowserRule(rule: HeaderRule): chrome.declarativeNetRequest.Rule {
  return {
    id: rule.id,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: 'accept-language',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: rule.value,
        },
      ],
    },
    condition: { urlFilter: rule.urlFilter },
  }
}

/**
 * 从浏览器里的规则还原出可比对的形态。
 *
 * 读回来再比对，而不是"猜它应该没变"：`getDynamicRules` 的顺序不保证，
 * 而且别的代码路径可能已经改过。比对内容而不是比对数量，才能发现
 * "条数一样但指向变了"这类变化。
 */
function fromBrowserRule(rule: chrome.declarativeNetRequest.Rule): HeaderRule | null {
  const filter = rule.condition?.urlFilter
  const header = rule.action?.requestHeaders?.[0]
  if (typeof filter !== 'string' || header === undefined) return null
  if (header.header.toLowerCase() !== 'accept-language') return null
  return { id: rule.id, urlFilter: filter, value: header.value ?? '' }
}

function signature(rules: readonly HeaderRule[]): string {
  return rules
    .map((rule) => `${rule.id}|${rule.urlFilter}|${rule.value}`)
    .sort()
    .join('\n')
}

/**
 * 把浏览器里的规则对齐到目标状态。
 *
 * @param target `null` 表示"现在不该有任何规则"（功能关闭、代理关闭、
 *   清单为空、或没有可用的 locale）。这是最关键的一条路径：调用方只要
 *   在开关变化时传 null，`clearTimezoneSnapshot` 那个"定义了却没人调"
 *   的历史问题就不会在请求头这里重演。
 *
 * @returns 规则是否处于预期状态。`false` 时调用方应当**放弃语言注入**，
 *   退回纯时区模式。
 */
let queue: Promise<unknown> = Promise.resolve()

export function syncHeaderRules(
  target: { readonly hosts: readonly string[]; readonly locale: string } | null,
): Promise<boolean> {
  /*
   * 串行化。
   *
   * 这个函数是「读现有规则 → 算差量 → 写回」三步，两个并发调用会读到
   * 同一份旧状态，然后各自写回 —— 后写的覆盖先写的，其中一次的目标状态
   * 被静默丢掉，而两次调用都返回 true。
   *
   * 并发是真实存在的：多个标签页几乎同时开始导航时，每个都会触发一次
   * 后台刷新（见 `refreshTimezoneInBackground`）。不是高频，但发生时
   * 没有任何痕迹 —— 用户只会看到某个站点的语言没跟上。
   *
   * 用一条 promise 链而不是标志位：调用方按调用顺序排队，不需要重试。
   */
  const next = queue.then(() => applyTarget(target))
  queue = next.catch(() => undefined)
  return next
}

async function applyTarget(
  target: { readonly hosts: readonly string[]; readonly locale: string } | null,
): Promise<boolean> {
  const api = chrome.declarativeNetRequest
  if (api === undefined) {
    /*
     * 权限没给（旧版 manifest、或用户拒绝）时这里会是 undefined。
     * 返回 false 让调用方退回纯时区模式，而不是抛错 ——
     * 语言同步是增强项，它不该让时区同步一起失败。
     */
    return target === null
  }

  const desired =
    target === null || target.hosts.length === 0
      ? []
      : describeRules(target.hosts, target.locale)

  let existing: chrome.declarativeNetRequest.Rule[]
  try {
    existing = await api.getDynamicRules()
  } catch {
    return false
  }

  const current: HeaderRule[] = []
  for (const rule of existing) {
    if (rule.id < RULE_ID_BASE || rule.id >= RULE_ID_LIMIT) continue
    const normalized = fromBrowserRule(rule)
    if (normalized !== null) current.push(normalized)
  }

  if (signature(current) === signature(desired)) return true

  try {
    await api.updateDynamicRules({
      // 先全部删掉再写：id 是按序号分配的，清单缩短时后面那些规则
      // 不会被新规则覆盖，必须先清。`removeRuleIds` 里不存在的 id
      // 会被忽略，所以多列几个是安全的。
      removeRuleIds: existing
        .filter((rule) => rule.id >= RULE_ID_BASE && rule.id < RULE_ID_LIMIT)
        .map((rule) => rule.id),
      addRules: desired.map(toBrowserRule),
    })
    return true
  } catch {
    return false
  }
}

/**
 * 清除所有由本扩展添加的规则。
 *
 * 与 `syncHeaderRules(null)` 等价，但语义更直白 —— 用在"用户关掉了这个
 * 功能"这类地方，读代码的人不必去推断 null 是什么意思。
 */
export async function clearHeaderRules(): Promise<void> {
  await syncHeaderRules(null)
}
