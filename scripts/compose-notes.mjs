/*
 * 生成 GitHub Release 说明：模板 + CHANGELOG 的对应小节。
 *
 * 为什么不在 workflow 里用 sed：
 * sed 替换不了多行块，而 CHANGELOG 小节天然是多行的。硬凑会得到一个
 * 「看起来发布成功了，但说明页是坏的」的结果 —— 这类失败只有用户能看见。
 *
 * 用法：
 *   node scripts/compose-notes.mjs <version> <sha256> <commit> [> out.md]
 *
 * CHANGELOG 里找不到对应小节就退出非零 —— 宁可不发，也不发一个说明写着
 * 「__CHANGES__」的 Release。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const [version, sha256, commit] = process.argv.slice(2)

if (!version || !sha256 || !commit) {
  console.error('用法: node scripts/compose-notes.mjs <version> <sha256> <commit>')
  process.exit(1)
}

const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8')

/*
 * 提取 `## vX.Y.Z` 到下一个 `## ` 之间的内容。
 * 末尾可能跟着一条 `---` 分隔线，一并去掉，否则 Release 页面会多一条横线。
 */
function extractSection(tag) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === `## ${tag}`)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## /.test(l))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n')
  return body.replace(/\n+---\s*$/, '').trim()
}

const tag = `v${version}`
const section = extractSection(tag)

if (!section) {
  console.error(
    `CHANGELOG.md 里找不到 "## ${tag}" 小节。\n` +
      `    发布前请先在 CHANGELOG.md 顶部加上这一版的变更说明。`,
  )
  process.exit(1)
}

const notes = readFileSync(resolve(ROOT, '.github/release-notes.md'), 'utf8')
  .replaceAll('__CHANGES__', section)
  .replaceAll('__VERSION__', version)
  .replaceAll('__SHA256__', sha256)
  .replaceAll('__COMMIT__', commit)

const leftover = notes.match(/__[A-Z0-9_]+__/g)
if (leftover) {
  console.error(`模板里有未替换的占位符：${[...new Set(leftover)].join(', ')}`)
  process.exit(1)
}

process.stdout.write(notes)
