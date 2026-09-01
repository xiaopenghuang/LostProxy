/**
 * 仓库卫生测试：根目录不得出现计划外的文件。
 *
 * ## 这个文件为什么存在
 *
 * v0.4.2 发过之后才发现根目录躺着一个 `image.png` —— 一张误提交的截图。
 * 它进不了发布产物（`package.mjs` 只从 `dist/` 取文件），但**进了发给 AMO
 * 审核员的源码包**：那个包由 `git archive HEAD` 生成，装的正是全部已跟踪文件。
 *
 * 这类错误没有任何环节会报错：构建正常、1082 项测试全绿、下载到的 zip 干净。
 * 唯一的后果是一份寄给外部审核员的压缩包里多了个不该有的东西 ——
 * 而截图可能带着窗口标题、文件路径、节点名甚至订阅链接。
 *
 * 所以把它变成一条会变红的断言。放在测试里而不是只放在签名脚本里，
 * 是因为签名一年跑几次，而测试每次 push 都跑 —— 差别是「上传前拦下」
 * 与「进仓库前拦下」。
 *
 * ## 局限
 *
 * 只管**根目录**。子目录里的散文件（比如 `src/tmp.png`）这里查不出来。
 * 刻意如此：根目录的合法内容可以穷举且一年变不了两次，子目录不行 ——
 * 而一份守不住的白名单只会被人用 `--no-verify` 绕过。
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALLOWED_ROOT_ENTRIES, findStrayRootEntries } from '../scripts/repo-manifest.mjs'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * HEAD 根目录的实际条目。
 *
 * ⚠️ 用 `-z`：git 默认会给含特殊字符的路径加引号并转义，按 `\n` 切一个
 *    带换行的文件名会得到两个假条目 —— 而能藏东西的正是这种畸形名字。
 *
 * CI 的 checkout 可能是浅克隆，但 `ls-tree HEAD` 只需要 HEAD 那棵 tree，
 * 浅克隆里它是完整的。
 */
function rootEntries(): string[] {
  return execFileSync('git', ['ls-tree', '--name-only', '-z', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((name) => name.length > 0)
}

describe('🔴 仓库根目录不得有计划外的文件', () => {
  it('HEAD 根目录的每一项都在白名单上', () => {
    /*
     * 失败时把多余条目列出来，并说清后果 —— 「有个文件不在清单里」
     * 本身不足以让人判断该删它还是该把它加进清单。
     */
    const stray = findStrayRootEntries(ROOT)

    expect(
      stray,
      stray.length === 0
        ? ''
        : `这些条目会随 git archive 一起进发给 AMO 审核员的源码包：\n` +
            stray.map((n) => `    ${n}`).join('\n') +
            `\n\n  该删就 git rm，是正经的项目文件就加进 scripts/repo-manifest.mjs。`,
    ).toEqual([])
  })

  it('白名单里没有已经不存在的条目', () => {
    /*
     * 反向校验，防清单腐烂。
     *
     * 删了一个根文件却忘了从清单里摘掉，清单就开始描述一个不存在的仓库；
     * 几次之后没人再信它，于是往里加东西也不再需要理由 ——
     * 白名单失效通常不是因为被绕过，而是因为烂掉。
     */
    const actual = new Set(rootEntries())
    const stale = ALLOWED_ROOT_ENTRIES.filter((name) => !actual.has(name))

    expect(stale, `白名单里这些条目在 HEAD 里已经没有了：${stale.join(', ')}`).toEqual([])
  })

  it('白名单本身没有重复项', () => {
    // 重复项不会造成错误行为，但它是"两次编辑撞在一起"的痕迹 ——
    // 说明有人加过一遍没发现已经有了，那么清单也就没被读过。
    const seen = new Set(ALLOWED_ROOT_ENTRIES)
    expect(seen.size).toBe(ALLOWED_ROOT_ENTRIES.length)
  })
})
