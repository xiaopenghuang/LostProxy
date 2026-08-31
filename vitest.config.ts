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
  /*
   * 测试跑在 Chromium 平台上（ADR-36）。
   *
   * 🔴 为什么默认是 chromium 而不是随机挑一个：`tests/setup.ts` 里的
   *   chrome.* mock 是**按 Chromium 的形状**写的（ChromeSetting 带 scope、
   *   onProxyError 带 fatal）。让共享层的测试跑在 Chromium 平台上，
   *   意味着那些断言验的是「决策 + 一个真实存在的平台实现」的组合，
   *   而不是一个人造的假平台 —— 后者能过测试但证明不了任何事。
   *
   *   Firefox 侧的实现由 `tests/platform-firefox.test.ts` 覆盖，
   *   它自己注入 Firefox 形状的 mock 并**直接 import `firefox`**，
   *   不经由这里的 `platform` 出口。这样两个平台的实现都被测到，
   *   且不需要在测试里切换全局构建常量（那会让测试之间产生顺序依赖）。
   */
  define: {
    __LOSTPROXY_PLATFORM__: JSON.stringify('chromium'),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
