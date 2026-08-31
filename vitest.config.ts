/**
 * Vitest 配置。
 *
 * 刻意与 vite.config.ts 分开：后者把 `root` 指向 src/ 以获得干净的产物结构，
 * 而测试需要以仓库根为基准去 include tests/。
 *
 * 默认环境是 node：background 层（storage / proxy / mihomo / orchestrator）
 * 依赖的是 chrome.* API 而非 DOM，chrome API 由 tests/setup.ts 提供 mock。
 *
 * 但 V0.2 起 UI 层有了真正的渲染逻辑（Popup 的节点列表：三种降级提示、
 * 当前项标记、滚动封顶）。这些原先只能靠人在真机上肉眼过一遍 ——
 * 而那份手工清单长到会让人放弃执行，等于没有验证。
 * 所以给 UI 测试单独指定 happy-dom 环境，用的是**真实的 index.html
 * 与 style.css**，而不是测试里手搓的一份近似 DOM。
 *
 * 用 per-file 的 `// @vitest-environment` 注解而不是全局换成 happy-dom：
 * background 测试不需要 DOM，全局挂一个 DOM 会拖慢每个文件的启动，
 * 也会让「background 不该碰 DOM」这条分层约束失去一层保护。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
