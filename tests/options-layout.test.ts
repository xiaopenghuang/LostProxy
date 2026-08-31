// @vitest-environment happy-dom

/**
 * Settings 页布局的结构性测试。
 *
 * 这些不是「样式好不好看」的测试 —— 那个只有人眼能判断。
 * 这里锁的是几条**会导致功能出错**的布局约束，它们在重构 CSS 或
 * 挪动 HTML 时很容易被无意破坏，而破坏之后没有任何东西会红：
 *
 *   - 语言选择器必须在 <form> 外（在里面的话，文本框里按回车会提交表单）
 *   - 保存栏必须 position: fixed（原来它在七张卡片之后，全标签页打开时
 *     在首屏之外，用户看不到"保存"在哪 —— 这是本次重做要修的主要问题）
 *   - 网格窄屏时必须退回单列
 *   - 每个输入框都必须有可访问的名字
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

function read(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8')
}

/** 装载真实的 options 页（含真实样式），不执行它的脚本。 */
function mount(): void {
  const html = read('src/options/index.html')
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/i, '')
    .replace(/<\/html>\s*$/i, '')
    // happy-dom 会真的去请求外部样式表，失败后往输出里打连接错误堆栈。
    .replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi, '')
    // 不执行页面脚本：这里只验静态结构与样式。
    .replace(/<script[\s\S]*?<\/script>/gi, '')

  const style = document.createElement('style')
  style.textContent = read('src/options/options.css')
  document.head.append(style)
}

beforeEach(() => {
  document.documentElement.innerHTML = ''
  mount()
})

describe('🔴 语言选择器的位置', () => {
  it('sits outside the form', () => {
    /*
     * 语言即时生效、不参与保存。放进 <form> 会有两个后果：
     *   1. 在任何文本框里按回车会触发提交
     *   2. 视觉上它和"改完要保存"的字段混在一起，行为却不同
     */
    const select = document.querySelector('#language')
    expect(select).not.toBeNull()
    expect(select?.closest('form')).toBeNull()
  })

  it('is still labelled', () => {
    // 在 form 外不等于可以不要 label。
    const label = document.querySelector('label[for="language"]')
    expect(label).not.toBeNull()
  })
})

describe('🔴 保存栏', () => {
  it('is fixed to the viewport', () => {
    // 本次布局重做要修的主要问题：原来它在七张卡片之后，看不见。
    const bar = document.querySelector<HTMLElement>('#save-bar')
    expect(bar).not.toBeNull()
    expect(getComputedStyle(bar!).position).toBe('fixed')
  })

  it('submits the form from outside it via the form attribute', () => {
    /*
     * 按钮在 <form> 之外，靠 form="form" 关联。若这个属性丢了，
     * 点保存会完全没反应 —— 而"点了没反应"是最难排查的一类失败。
     */
    const save = document.querySelector<HTMLButtonElement>('#save')
    expect(save?.getAttribute('type')).toBe('submit')
    expect(save?.getAttribute('form')).toBe('form')
    expect(document.querySelector('form')?.id).toBe('form')
  })

  it('starts clean, with the unsaved note hidden', () => {
    const bar = document.querySelector<HTMLElement>('#save-bar')
    const note = document.querySelector<HTMLElement>('#save-note')
    expect(bar?.dataset.dirty).toBe('false')
    expect(getComputedStyle(note!).visibility).toBe('hidden')
  })

  it('declares both dirty states explicitly', () => {
    /*
     * ⚠️ 这一条退化成了对 CSS 源码的断言，而不是对计算值的断言。
     *
     * 此方本来写的是「把 data-dirty 改成 true，断言 note 变可见」，
     * 但 happy-dom 在这个具体的选择器组合上不重算样式 ——
     * 单独构造的最小用例（.box[data-x] .inner）能正常重算，
     * 而这里不能，说明是 happy-dom 的局限而非 CSS 的问题：
     * 同一份样式表里 position:fixed 与 [data-dirty='false'] 都生效了。
     *
     * 所以这里只保证两条规则都写着、方向相反。**「切到 dirty 之后
     * 提示真的出现」这一条没有被自动化覆盖**，需要人眼确认。
     */
    const css = read('src/options/options.css')
    expect(css).toMatch(/\[data-dirty='false'\]\s*\.save-note\s*\{[^}]*visibility:\s*hidden/)
    expect(css).toMatch(/\[data-dirty='true'\]\s*\.save-note\s*\{[^}]*visibility:\s*visible/)
  })

  it('leaves room so the last card is not covered', () => {
    // 固定栏会盖住页面底部，.page 必须留出对应的 padding。
    const page = document.querySelector<HTMLElement>('.page')
    const bottom = Number.parseInt(getComputedStyle(page!).paddingBottom, 10)
    expect(bottom).toBeGreaterThanOrEqual(80)
  })
})

describe('网格布局', () => {
  it('uses auto-fit so it collapses to one column on narrow windows', () => {
    /*
     * 用 auto-fit + minmax 而不是 media query：不存在"断点选得不对"的问题。
     * 这里断言的是手法本身，因为 happy-dom 不做实际的网格布局计算。
     */
    const css = read('src/options/options.css')
    expect(css).toMatch(/\.grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/)
  })

  it('groups the cards under section headings', () => {
    // 七张平级卡片竖排时，用户得逐张读标题才知道"这一堆是干什么的"。
    const titles = [...document.querySelectorAll('.group-title')]
    expect(titles.length).toBeGreaterThanOrEqual(3)
    for (const title of titles) expect(title.getAttribute('data-i18n')).toBeTruthy()
  })

  it('every card lives inside a grid', () => {
    // 漏在网格外的卡片会独占一整行，破坏两列节奏。
    for (const card of document.querySelectorAll('.card')) {
      expect(card.closest('.grid')).not.toBeNull()
    }
  })
})

describe('无障碍', () => {
  it('every form control has an accessible name', () => {
    /*
     * 逐个查而不是抽查：新增字段时忘了加 label 是最常见的无障碍退化，
     * 而它在视觉上完全看不出来（标题往往已经说明了字段是什么）。
     */
    const controls = [
      ...document.querySelectorAll<HTMLElement>('input:not([type=checkbox]), select, textarea'),
    ]
    expect(controls.length).toBeGreaterThan(0)

    for (const control of controls) {
      const id = control.id
      const labelled =
        (id !== '' && document.querySelector(`label[for="${id}"]`) !== null) ||
        control.getAttribute('aria-label') !== null ||
        control.closest('label') !== null
      expect(labelled, `${control.tagName}#${id || '(no id)'} has no label`).toBe(true)
    }
  })

  it('the checkbox is wrapped in its own label', () => {
    const checkbox = document.querySelector<HTMLElement>('#webrtc-lock')
    expect(checkbox?.closest('label')).not.toBeNull()
  })

  it('the visually-hidden label stays in the accessibility tree', () => {
    // 用 clip-path 而非 display:none —— 后者会让元素从无障碍树消失，
    // 那就失去了加这个 label 的意义。
    const css = read('src/options/options.css')
    expect(css).toMatch(/\.sr-only\s*\{[^}]*clip-path:/)
    expect(css).not.toMatch(/\.sr-only\s*\{[^}]*display:\s*none/)
  })
})

describe('保存语义的可见性', () => {
  it('marks the sections that do not need saving', () => {
    /*
     * 订阅栏的操作是即时的（点更新就更新了），不标出来用户会以为
     * 改完还得点保存，或者反过来以为点了保存才生效。
     */
    const tag = document.querySelector('#subs-list')?.closest('.card')?.querySelector('.tag')
    expect(tag).not.toBeNull()
    expect(tag?.getAttribute('data-i18n')).toBe('options.tagNoSave')
  })

  it('gives the leak-protection card a visual accent', () => {
    // 安全相关的开关在一片同质卡片里应该能被一眼找到。
    const card = document.querySelector<HTMLElement>('#webrtc-lock')?.closest('.card')
    expect(card?.classList.contains('card--accent')).toBe(true)
  })
})
