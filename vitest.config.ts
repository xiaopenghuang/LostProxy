/**
 * Vitest 配置。
 *
 * 刻意与 vite.config.ts 分开：后者把 `root` 指向 src/ 以获得干净的产物结构，
 * 而测试需要以仓库根为基准去 include tests/。
 *
 * 环境用 node 而非 jsdom —— V0.1 的被测对象是 background 层的纯逻辑
 * （storage / proxy / mihomo），依赖的是 chrome.* API 而非 DOM。
 * chrome API 由 tests/setup.ts 提供 mock。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
