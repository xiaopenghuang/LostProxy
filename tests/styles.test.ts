/**
 * 样式层不变量测试。
 *
 * 单元测试通常不碰 CSS，但这里有一条**已经咬过一次**的规则值得钉死。
 *
 * 症状：Popup 里出现一个空的橙色告警框，只有一个孤零零的感叹号，
 * 而且怎么都不消失。
 *
 * 根因：HTML 的 `hidden` 属性依赖浏览器默认样式表里的
 * `[hidden] { display: none }`，那条规则的优先级低于**任何**作者样式。
 * 而 `.alert` 声明了 `display: flex`，于是 `element.hidden = true`
 * 完全失效 —— 属性设上了，元素照样显示。
 *
 * 这类 bug 的恶劣之处在于：JS 侧的逻辑完全正确，测试也全绿，
 * 只有真机上肉眼能看出来。所以用一条静态断言把兜底规则钉在这儿。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLESHEETS = ['src/popup/style.css', 'src/options/options.css']

function read(relativePath: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', relativePath), 'utf8')
}

describe('hidden attribute safety net', () => {
  it.each(STYLESHEETS)('%s neutralises author display rules for [hidden]', (sheet) => {
    const css = read(sheet)
    // 允许格式差异（空格、换行），只要求这条规则确实存在且带 !important。
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/)
  })

  it('popup declares display:flex on .alert — which is exactly why the rule is needed', () => {
    // 这条断言的作用是解释上一条为什么必要：
    // 一旦有人把 .alert 的 display 去掉，也不该顺手删掉兜底规则，
    // 因为 popup 里还有别的元素在用 hidden（#core-note、#dismiss）。
    expect(read('src/popup/style.css')).toMatch(/\.alert\s*\{[^}]*display:\s*flex/)
  })
})

describe('V0.2 节点列表', () => {
  it('caps the node list height and lets it scroll', () => {
    /*
     * Popup 只有 312px 宽，高度也有限，而一个策略组可能有上百个节点。
     * 不封顶的话 Popup 会被撑成一条长溜，底部的 footer 与承诺文案
     * （技术方案 §13 要求始终可见）会被推出视口。
     */
    const css = read('src/popup/style.css')
    expect(css).toMatch(/\.node-list\s*\{[^}]*max-height:/)
    expect(css).toMatch(/\.node-list\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('marks the current node with more than colour alone', () => {
    // 只靠颜色区分当前项对色觉障碍用户无效。这里额外有一条左侧指示条。
    expect(read('src/popup/style.css')).toMatch(/\.node-item\[aria-current='true'\]::before/)
  })
})

describe('🔴 ADR-28 边界披露', () => {
  /*
   * 切换节点改的是内核的全局状态，效果不限于本浏览器 —— 这是本项目
   * 第一个逸出「只影响这一个浏览器」承诺的功能。ADR-28 要求在 UI 上明示。
   *
   * 这三条测试守的是一个**产品承诺**而不是一个函数行为：没有它们，
   * 后来的人重构 Popup 时把这段小字当成冗余说明删掉，不会有任何东西变红。
   */
  it('popup markup carries the scope notice bound to the right message', () => {
    const html = read('src/popup/index.html')
    expect(html).toContain('id="nodes-scope"')
    expect(html).toContain('data-i18n="popup.nodeScopeNotice"')
  })

  it('the notice is not styled as ignorable fine print', () => {
    // 用 --fg-secondary 而不是 --fg-tertiary：这段话解释的是唯一一个
    // 效果逸出浏览器的操作，弱化它等于变相隐瞒。
    const css = read('src/popup/style.css')
    expect(css).toMatch(/\.nodes-scope\s*\{[^}]*color:\s*var\(--fg-secondary\)/)
  })
})
