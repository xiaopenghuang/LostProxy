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
