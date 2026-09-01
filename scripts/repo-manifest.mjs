/**
 * 仓库根目录的白名单，以及据它查出「多余条目」的函数。
 *
 * ## 这个文件为什么存在
 *
 * v0.4.2 发布后发现根目录躺着一个 `image.png` —— 一张误提交的截图，
 * 没有任何文件引用它。它进不了发布产物（`package.mjs` 只从 `dist/` 取文件），
 * 但**进了发给 AMO 审核员的源码包**：那个包由 `git archive HEAD` 生成，
 * 而 `git archive` 装的正是所有已跟踪文件。
 *
 * 根因是一次过宽的 `git add`。这类错误的麻烦之处在于**没有任何环节会报错** ——
 * 构建正常、测试全绿、发布产物干净，唯一的后果是一份寄给外部审核员的
 * 压缩包里多了个不该有的东西。而截图这种东西可能带着窗口标题、
 * 文件路径、节点名，甚至订阅链接。
 *
 * ## 为什么查 `git ls-tree` 而不是解压那个 zip
 *
 * `git archive HEAD` 的内容**定义上**等于 HEAD 里的已跟踪文件。查 tree 因此
 * 与查压缩包等价，却有两个好处：不依赖 `unzip`（Windows 上不一定有），
 * 而且能在**产出任何东西之前**就失败 —— 而不是在源码包已经生成、
 * 甚至已经上传之后。
 *
 * ## 为什么是精确文件名而不是模式匹配
 *
 * 要防的是**无意进来的东西**：截图、随手记、`test.zip`、`.env.local`。
 * 这些不可能穷举其形状，但根目录的**合法**内容是可以穷举的 ——
 * 它一年变不了两次。
 *
 * 代价是加一个正经的根文件时会红一次。这是刻意的：那一次红只要求你确认
 * 「我知道它会进源码包」，而这正是当初没人问过的那个问题。
 */

import { execFileSync } from 'node:child_process'

/**
 * 允许出现在仓库根目录的条目（文件与目录同列）。
 *
 * ⚠️ 往这里加东西之前先想清楚：它会随源码包一起寄给 AMO 审核员。
 *    凭据、私有笔记、截图都不该在这里 —— 它们该进 .gitignore。
 */
export const ALLOWED_ROOT_ENTRIES = Object.freeze([
  '.env.example',
  '.gitattributes',
  '.github',
  '.gitignore',
  'CHANGELOG.md',
  'DESIGN.md',
  'LICENSE',
  'README.en.md',
  'README.md',
  'REVIEWERS.md',
  'package-lock.json',
  'package.json',
  'scripts',
  'src',
  'tests',
  'tools',
  'tsconfig.json',
  'vite.config.firefox.sw.ts',
  'vite.config.firefox.ts',
  'vite.config.sw.ts',
  'vite.config.ts',
  'vite.shared.ts',
  'vitest.config.ts',
])

/**
 * 列出 HEAD 根目录里不在白名单上的条目。
 *
 * @param {string} cwd 仓库路径
 * @returns {string[]} 多余条目，按名字排序；干净时为空数组
 */
export function findStrayRootEntries(cwd) {
  /*
   * `-z` + NUL 分隔，而不是按行切。
   *
   * git 默认会把含特殊字符的路径加引号并转义（`"a\nb"`），于是按 `\n`
   * 切一个带换行的文件名会得到两个假条目。`-z` 让 git 输出原始字节、
   * 不做任何引用 —— 而能藏东西的正是这种畸形名字。
   */
  const raw = execFileSync('git', ['ls-tree', '--name-only', '-z', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  })

  const entries = raw.split('\0').filter((name) => name.length > 0)
  const allowed = new Set(ALLOWED_ROOT_ENTRIES)

  return entries.filter((name) => !allowed.has(name)).sort()
}
