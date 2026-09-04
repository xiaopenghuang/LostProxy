// @vitest-environment happy-dom

/**
 * Popup 节点列表的 DOM 测试（V0.2）。
 *
 * 为什么加这个文件：此方一开始把节点区的验证写成了一份 15 项的手工清单
 * 交给 Master 去点。那份清单长到会让人放弃执行 —— 而放弃执行的验收
 * 等于没有验收，比承认"没验"更糟，因为它看起来像验过了。
 *
 * 这里用**真实的 index.html 与 style.css**（读文件注入，不是测试里手搓
 * 一份近似 DOM），所以能替掉原清单里的大部分条目：
 *   S1  当前节点的标记      S6  Controller 不可达时的降级提示
 *   S7  未选组时的提示      S8  非 Selector 组的类型提示（在 options 那边）
 *   S10 组不存在时的提示    S14 列表滚动封顶
 *   S15 键盘可达性
 *
 * 真机只剩两条必须由人验的：**能不能真的切**、**Clash Verge 里跟着变没有**。
 * 那两条依赖真实内核，任何 mock 都证明不了。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { errors } from '../src/shared/errors'
import type { GroupView, NormalizedError, StatusSnapshot } from '../src/shared/types'

const ROOT = resolve(import.meta.dirname, '..')

function readSrc(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8')
}

/** 记录 Popup 发出的每一条消息，供断言"点了之后发了什么"。 */
let sent: { type: string; node?: string }[] = []

/** 下一次 GET_STATUS / SELECT_NODE 要返回的快照。 */
let nextSnapshot: StatusSnapshot
/** 让 SELECT_NODE 失败时用的错误；null 表示成功。 */
let selectError: NormalizedError | null = null

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    enabled: true,
    settings: {
      proxyHost: DEFAULT_SETTINGS.proxyHost,
      proxyPort: DEFAULT_SETTINGS.proxyPort,
      controllerHost: DEFAULT_SETTINGS.controllerHost,
      controllerPort: DEFAULT_SETTINGS.controllerPort,
      hasSecret: false,
      webRtcLockEnabled: true,
      language: 'en',
      primaryGroup: 'Proxy',
      routingMode: 'global',
      directRules: [],
    },
    coreStatus: 'online',
    coreVersion: 'v1.19.0',
    levelOfControl: 'controlled_by_this_extension',
    proxyActuallySet: true,
    webRtcLocked: true,
    lastError: null,
    group: null,
    groupError: null,
    ...overrides,
  }
}

function group(overrides: Partial<GroupView> = {}): GroupView {
  return {
    name: 'Proxy',
    type: 'Selector',
    now: 'HK-01',
    nodes: ['HK-01', 'JP-02'],
    latency: {},
    protocol: {},
    ...overrides,
  }
}

/**
 * 装载真实的 Popup。
 *
 * 注入真实 style.css 是关键：happy-dom 不会去抓 <link> 引用的外部样式，
 * 不注入的话 getComputedStyle 永远返回默认值，那条「[hidden] 被作者样式
 * 覆盖」的真 bug（ADR-26，真机上出现过一个空的橙色告警框）就测不出来。
 */
async function mountPopup(): Promise<void> {
  const html = readSrc('src/popup/index.html')
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/i, '')
    .replace(/<\/html>\s*$/i, '')
    /*
     * 摘掉 <link rel=stylesheet>：happy-dom 会真的去发一个 HTTP 请求，
     * 失败后往测试输出里打一段连接错误堆栈。样式在下面手动注入了，
     * 这个 link 只剩噪音 —— 而测试输出里的噪音会训练人无视测试输出。
     */
    .replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi, '')

  const style = document.createElement('style')
  style.textContent = readSrc('src/popup/style.css')
  document.head.append(style)

  vi.resetModules()
  await import('../src/popup/popup')
  // 顶层的 refresh() 是异步的，让它跑完再断言。
  await vi.waitFor(() => {
    expect(sent.some((m) => m.type === 'GET_STATUS')).toBe(true)
  })
  await Promise.resolve()
}

function nodeButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.node-item')]
}

/**
 * 切到【节点】标签。
 *
 * V0.4 起 Popup 分了标签页，节点列表默认不可见。渲染逻辑与可见性是两件事 ——
 * 列表内容在渲染时就已生成，切标签只是显示它。测试断言内容时不需要切，
 * 但断言 `hidden` 计算值时需要，否则父面板的 display:none 会让结论失真。
 */
function openNodesTab(): void {
  document.querySelector<HTMLButtonElement>('#tab-nodes')?.click()
}

/** 各节点的名字。按钮里还有协议与延迟徽章，所以要取 .node-name。 */
function nodeNames(): (string | null)[] {
  return [...document.querySelectorAll<HTMLElement>('.node-item .node-name')].map(
    (n) => n.textContent,
  )
}

function hintText(): string {
  const hint = document.querySelector<HTMLElement>('#nodes-hint')
  return hint?.hidden ? '' : (hint?.textContent ?? '')
}

beforeEach(() => {
  sent = []
  selectError = null
  nextSnapshot = snapshot()

  const runtime = {
    lastError: undefined,
    openOptionsPage: vi.fn(),
    sendMessage: (message: { type: string; node?: string }) => {
      sent.push(message)
      if (message.type === 'SELECT_NODE' && selectError !== null) {
        return Promise.resolve({ ok: false, error: selectError })
      }
      return Promise.resolve({ ok: true, data: nextSnapshot })
    },
  }
  ;(globalThis.chrome as unknown as { runtime: unknown }).runtime = runtime
})

afterEach(() => {
  document.documentElement.innerHTML = ''
  vi.restoreAllMocks()
})

describe('节点列表渲染（替代手工 S1）', () => {
  it('renders one button per node', async () => {
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()

    // 取 .node-name 而不是整个按钮的 textContent —— V0.3 起按钮里还有延迟徽章。
    expect(nodeNames()).toEqual(['HK-01', 'JP-02'])
  })

  it('marks the current node and disables it', async () => {
    // 当前节点点了也是同一个，禁用掉省一次无意义的往返。
    nextSnapshot = snapshot({ group: group({ now: 'JP-02' }) })
    await mountPopup()

    const [hk, jp] = nodeButtons()
    expect(jp?.getAttribute('aria-current')).toBe('true')
    expect(jp?.disabled).toBe(true)
    expect(hk?.getAttribute('aria-current')).toBeNull()
    expect(hk?.disabled).toBe(false)
  })

  it('shows the group name', async () => {
    nextSnapshot = snapshot({ group: group({ name: '🇭🇰 香港 | 专线' }) })
    await mountPopup()

    expect(document.querySelector('#nodes-group')?.textContent).toBe('🇭🇰 香港 | 专线')
  })

  it('🔴 treats node names as text, never as markup', async () => {
    // 节点名来自订阅，是不可信输入。用 innerHTML 渲染就是一个 XSS。
    nextSnapshot = snapshot({
      group: group({ nodes: ['<img src=x onerror=alert(1)>'], now: 'other' }),
    })
    await mountPopup()

    expect(document.querySelector('#node-list img')).toBeNull()
    expect(nodeNames()[0]).toBe('<img src=x onerror=alert(1)>')
  })

  it('uses real buttons so keyboard access comes for free (replaces S15)', async () => {
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()

    // 自己用 div + tabindex + keydown 复刻必然漏掉某些行为。
    for (const b of nodeButtons()) expect(b.tagName).toBe('BUTTON')
  })
})

describe('降级提示（替代手工 S6 / S7 / S10）', () => {
  it('asks the user to enable the external controller when it is unreachable', async () => {
    nextSnapshot = snapshot({
      coreStatus: 'unreachable',
      groupError: errors.coreOffline('127.0.0.1', 9097),
    })
    await mountPopup()

    expect(hintText()).toContain('external controller')
    expect(nodeButtons()).toHaveLength(0)
  })

  it('points at Settings when no group has been picked', async () => {
    nextSnapshot = snapshot({ groupError: errors.groupNotConfigured() })
    await mountPopup()

    expect(hintText()).toContain('Settings')
  })

  it('explains a vanished group and names it', async () => {
    nextSnapshot = snapshot({ groupError: errors.groupNotFound('Old Group') })
    await mountPopup()

    expect(hintText()).toContain('Old Group')
    // 说明订阅变更是最常见成因，否则用户不知道为什么会这样。
    expect(hintText()).toContain('subscription')
  })

  it('handles an empty group without rendering an empty list', async () => {
    nextSnapshot = snapshot({ group: group({ nodes: [], now: null }) })
    await mountPopup()

    expect(nodeButtons()).toHaveLength(0)
    expect(hintText()).toContain('no members')
  })

  it('🔴 never shows a degraded hint as an alert', async () => {
    /*
     * ADR-23 的同一条原则：读不到不等于坏了。把「没开外部控制」渲染成
     * 橙色告警会在 named pipe 模式的用户那里产生永久噪音，
     * 而永久噪音会训练用户无视所有告警。
     */
    nextSnapshot = snapshot({
      coreStatus: 'unreachable',
      groupError: errors.coreOffline('127.0.0.1', 9097),
    })
    await mountPopup()

    expect(document.querySelector<HTMLElement>('#alert')?.hidden).toBe(true)
  })
})

describe('切换交互', () => {
  it('sends SELECT_NODE with the clicked node name', async () => {
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()

    nodeButtons()[1]?.click()
    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === 'SELECT_NODE')).toBe(true)
    })

    expect(sent.find((m) => m.type === 'SELECT_NODE')?.node).toBe('JP-02')
  })

  it('disables the whole list while switching', async () => {
    // 连点两个节点会产生两个竞争的 PUT，最后生效哪个取决于内核处理顺序。
    nextSnapshot = snapshot({ group: group({ nodes: ['A', 'B', 'C'], now: 'A' }) })
    await mountPopup()

    nodeButtons()[1]?.click()

    expect(nodeButtons().every((b) => b.disabled)).toBe(true)
  })

  it('surfaces a switch failure as an alert and re-reads real state', async () => {
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()
    selectError = errors.groupNotSelectable('Auto')
    const before = sent.filter((m) => m.type === 'GET_STATUS').length

    nodeButtons()[1]?.click()
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('#alert')?.hidden).toBe(false)
    })

    expect(document.querySelector('#alert-text')?.textContent).toContain('Auto')
    // 失败后必须拉一次真实状态：内核可能已经部分生效，UI 要回到事实。
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'GET_STATUS').length).toBeGreaterThan(before)
    })
  })
})

describe('🔴 ADR-28 边界披露在真实 DOM 里的可见性', () => {
  it('shows the scope notice when nodes are switchable', async () => {
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()

    const notice = document.querySelector<HTMLElement>('#nodes-scope')
    expect(notice?.hidden).toBe(false)
    expect(notice?.textContent).toContain('anything else using this core')
  })

  it('hides it when there is nothing to switch', async () => {
    // 没有可点的东西时那句话没有意义，显示它只是噪音。
    nextSnapshot = snapshot({ groupError: errors.groupNotConfigured() })
    await mountPopup()

    expect(document.querySelector<HTMLElement>('#nodes-scope')?.hidden).toBe(true)
  })
})

describe('🔴 [hidden] 在真实样式下确实生效（ADR-26 的症状级验证）', () => {
  /*
   * styles.test.ts 里那条是对 CSS 源码做正则匹配 —— 它能确认规则写着，
   * 但确认不了规则**赢了**。这里注入真实样式表后查计算值，
   * 验的是当初真机上出现的那个症状本身：
   * 一个已经 hidden 但依然显示的空告警框。
   */
  it.each(['#alert', '#nodes-hint', '#nodes-scope', '#core-note', '#dismiss'])(
    '%s computes to display:none while hidden',
    async (selector) => {
      nextSnapshot = snapshot({ group: group() })
      await mountPopup()

      const node = document.querySelector<HTMLElement>(selector)
      expect(node).not.toBeNull()
      if (node === null) return
      node.hidden = true

      expect(getComputedStyle(node).display).toBe('none')
    },
  )

  it('the node list itself is visible when populated', async () => {
    // 反向哨兵：如果上面那组测试因为"什么都不显示"而通过，这条会炸。
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()

    const list = document.querySelector<HTMLElement>('#node-list')
    expect(list).not.toBeNull()
    if (list === null) return
    expect(getComputedStyle(list).display).toBe('flex')
  })
})

describe('标签页（V0.4 布局重做）', () => {
  it('starts on the status tab with the nodes pane hidden', async () => {
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()

    expect(document.querySelector('#tab-status')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector<HTMLElement>('#pane-nodes')?.hidden).toBe(true)
    expect(getComputedStyle(document.querySelector<HTMLElement>('#pane-nodes')!).display).toBe(
      'none',
    )
  })

  it('reveals the nodes pane when its tab is clicked', async () => {
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()

    openNodesTab()

    expect(document.querySelector<HTMLElement>('#pane-nodes')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('#pane-status')?.hidden).toBe(true)
    // 内容在渲染时就已生成，切标签只是显示它。
    expect(nodeNames()).toEqual(['HK-01', 'JP-02'])
  })

  it('🔴 keeps the toggle and the promises visible on both tabs', async () => {
    /*
     * 技术方案 §13 要求承诺文案（系统代理/TUN 未修改）任何时候都不消失，
     * 而开关是本插件的主体功能。两者都必须在标签容器**之外**（ADR-35）——
     * 否则切到"节点"标签就看不到自己开没开代理。
     */
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()
    openNodesTab()

    expect(getComputedStyle(document.querySelector<HTMLElement>('#toggle')!).display).not.toBe(
      'none',
    )
    expect(getComputedStyle(document.querySelector<HTMLElement>('.promises')!).display).not.toBe(
      'none',
    )
  })

  it('🔴 keeps a leak alert visible on both tabs', async () => {
    // 安全告警不该被藏在某个未选中的标签里。
    nextSnapshot = snapshot({ group: group(), lastError: errors.proxyLeakSuspected() })
    await mountPopup()
    openNodesTab()

    const alert = document.querySelector<HTMLElement>('#alert')
    expect(alert?.hidden).toBe(false)
    expect(getComputedStyle(alert!).display).not.toBe('none')
  })
})

describe('V0.3 延迟徽章', () => {
  it('shows the measured delay next to each node', async () => {
    nextSnapshot = snapshot({
      group: group({ latency: { 'HK-01': 42, 'JP-02': 310 } }),
    })
    await mountPopup()

    const badges = [...document.querySelectorAll<HTMLElement>('.latency')]
    expect(badges.map((b) => b.textContent)).toEqual(['42 ms', '310 ms'])
  })

  it('tiers the badges so they can be scanned by colour', async () => {
    nextSnapshot = snapshot({
      group: group({ nodes: ['a', 'b', 'c'], now: 'x', latency: { a: 80, b: 350, c: 900 } }),
    })
    await mountPopup()

    const tiers = [...document.querySelectorAll<HTMLElement>('.latency')].map(
      (b) => b.dataset.tier,
    )
    expect(tiers).toEqual(['fast', 'medium', 'slow'])
  })

  it('🔴 shows a dash rather than 0 ms when there is no measurement', async () => {
    // 内核用 delay===0 表示测试失败。渲染成 "0 ms" 会被读作"极快"。
    nextSnapshot = snapshot({ group: group({ latency: { 'HK-01': null, 'JP-02': null } }) })
    await mountPopup()

    const badges = [...document.querySelectorAll<HTMLElement>('.latency')]
    expect(badges.every((b) => b.textContent === '—')).toBe(true)
    expect(badges.some((b) => b.textContent?.includes('0'))).toBe(false)
  })

  it('the test button is hidden when there are no nodes to measure', async () => {
    nextSnapshot = snapshot({ groupError: errors.groupNotConfigured() })
    await mountPopup()

    expect(document.querySelector<HTMLElement>('#test-latency')?.hidden).toBe(true)
  })

  it('🔴 never tests latency just because the popup opened', async () => {
    /*
     * 技术方案 §17 / ADR-32：一次全量测速会让内核同时向几十个节点建连。
     * 绑在"打开 Popup"这个高频动作上等于每看一眼状态就触发一次。
     */
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()

    expect(sent.some((m) => m.type === 'TEST_LATENCY')).toBe(false)
  })

  it('tests only when the user asks', async () => {
    nextSnapshot = snapshot({ group: group() })
    await mountPopup()
    openNodesTab()

    document.querySelector<HTMLButtonElement>('#test-latency')?.click()
    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === 'TEST_LATENCY')).toBe(true)
    })
  })
})

describe('V0.7 协议徽章', () => {
  it('shows the abbreviated protocol next to each node', async () => {
    nextSnapshot = snapshot({
      group: group({ protocol: { 'HK-01': 'Vless', 'JP-02': 'Hysteria2' } }),
    })
    await mountPopup()

    const badges = [...document.querySelectorAll<HTMLElement>('.protocol')]
    expect(badges.map((b) => b.textContent)).toEqual(['VLESS', 'HY2'])
  })

  it('🔴 falls back to the core’s own wording for a protocol it does not know', async () => {
    /*
     * 内核每加一个协议都会出现一个新 type。把缩写表当白名单用会让新协议
     * **静默消失** —— 显示 `Brand-New` 比显示空白有用，哪怕没缩写。
     */
    nextSnapshot = snapshot({
      group: group({ protocol: { 'HK-01': 'Mieru', 'JP-02': 'Brand-New' } }),
    })
    await mountPopup()

    const badges = [...document.querySelectorAll<HTMLElement>('.protocol')]
    expect(badges.map((b) => b.textContent)).toEqual(['Mieru', 'Brand-New'])
  })

  it('🔴 keeps the column occupied when a member has no protocol', async () => {
    /*
     * 嵌套的策略组与内置出口没有协议。少渲染一个元素会让那一行的延迟徽章
     * 挪到 grid 的前一列，于是整列数字失去对齐 —— 所以空徽章也必须存在。
     */
    nextSnapshot = snapshot({
      group: group({
        protocol: { 'HK-01': 'Vless', 'JP-02': '' },
        latency: { 'HK-01': 42, 'JP-02': 88 },
      }),
    })
    await mountPopup()

    const badges = [...document.querySelectorAll<HTMLElement>('.protocol')]
    expect(badges).toHaveLength(2)
    expect(badges[1]?.textContent).toBe('')
    // 空徽章不能被 display:none 掉，否则占不住列位。
    openNodesTab()
    expect(getComputedStyle(badges[1]!).display).not.toBe('none')
  })

  it('renders an empty badge rather than crashing when the map has no entry', async () => {
    // 内核不可达时协议字典是空的，节点列表本身仍要正常渲染。
    nextSnapshot = snapshot({ group: group({ protocol: {} }) })
    await mountPopup()

    const badges = [...document.querySelectorAll<HTMLElement>('.protocol')]
    expect(badges.map((b) => b.textContent)).toEqual(['', ''])
    expect(nodeNames()).toEqual(['HK-01', 'JP-02'])
  })

  it('treats the protocol as text, never as markup', async () => {
    // 内核响应同样按不可信输入处理（脏响应的同一条纪律）。
    nextSnapshot = snapshot({
      group: group({ protocol: { 'HK-01': '<img src=x onerror=alert(1)>' } }),
    })
    await mountPopup()

    expect(document.querySelector('#node-list img')).toBeNull()
  })
})

describe('V0.4 分流模式', () => {
  it('highlights the stored mode', async () => {
    nextSnapshot = snapshot({
      settings: { ...snapshot().settings, routingMode: 'direct' },
    })
    await mountPopup()

    const checked = [...document.querySelectorAll<HTMLElement>('.mode-btn')]
      .filter((b) => b.getAttribute('aria-checked') === 'true')
      .map((b) => b.dataset.mode)
    expect(checked).toEqual(['direct'])
  })

  it('🔴 shows global when smart is stored but no rules exist', async () => {
    /*
     * buildProxyConfig 在没有规则时确实退回了 fixed_servers（proxy.ts）。
     * UI 必须显示浏览器的**实际行为**，显示"智能"却在走全局就是骗人。
     */
    nextSnapshot = snapshot({
      settings: { ...snapshot().settings, routingMode: 'smart', directRules: [] },
    })
    await mountPopup()

    const checked = [...document.querySelectorAll<HTMLElement>('.mode-btn')]
      .filter((b) => b.getAttribute('aria-checked') === 'true')
      .map((b) => b.dataset.mode)
    expect(checked).toEqual(['global'])
    expect(document.querySelector('#modes-hint')?.textContent).toContain('Settings')
  })

  it('highlights smart once rules exist', async () => {
    nextSnapshot = snapshot({
      settings: { ...snapshot().settings, routingMode: 'smart', directRules: ['*.edu.cn'] },
    })
    await mountPopup()

    const checked = [...document.querySelectorAll<HTMLElement>('.mode-btn')]
      .filter((b) => b.getAttribute('aria-checked') === 'true')
      .map((b) => b.dataset.mode)
    expect(checked).toEqual(['smart'])
  })

  it('saves the mode when a different one is clicked', async () => {
    nextSnapshot = snapshot()
    await mountPopup()

    document.querySelector<HTMLButtonElement>('.mode-btn[data-mode="direct"]')?.click()
    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === 'SAVE_SETTINGS')).toBe(true)
    })
  })

  it('does not re-save the mode that is already active', async () => {
    // 点当前项是无操作，发一次写请求只会白重写一遍 chrome.proxy。
    nextSnapshot = snapshot()
    await mountPopup()

    document.querySelector<HTMLButtonElement>('.mode-btn[data-mode="global"]')?.click()
    await Promise.resolve()

    expect(sent.some((m) => m.type === 'SAVE_SETTINGS')).toBe(false)
  })
})
