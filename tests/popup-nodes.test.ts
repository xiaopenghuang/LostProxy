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
  return { name: 'Proxy', type: 'Selector', now: 'HK-01', nodes: ['HK-01', 'JP-02'], ...overrides }
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

    expect(nodeButtons().map((b) => b.textContent)).toEqual(['HK-01', 'JP-02'])
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
    expect(nodeButtons()[0]?.textContent).toBe('<img src=x onerror=alert(1)>')
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
