/**
 * Vite 配置 —— 第 2 趟：Background Service Worker
 *
 * MV3 硬约束：service worker 必须是自包含的单个文件。
 * 若产物中出现 `import(...)` 去拉取另一个 chunk，Chrome 会把它当作远程代码加载，
 * 报 "Service worker registration failed" 并拒绝注册整个扩展。
 *
 * 因此这一趟：
 *   - 单入口，独立成一趟 build
 *   - format: 'iife'（自执行、无顶层 import；'es' + lib 模式是常见陷阱，
 *     它产出的单文件仍带顶层 import 语句，会被 Chrome 拒绝）
 *
 * ⚠️ Vite 8 / Rolldown 与 Rollup 时代的差异（实测确认）：
 *   社区教程普遍写 `output.inlineDynamicImports: true` 来强制单文件，
 *   但 Vite 8 在 format:'iife' 下会自动设 `codeSplitting: false`，
 *   此时 inlineDynamicImports 被忽略并产生 WARN。
 *   已实测产物为纯 IIFE 单文件、零 import 语句，故不再声明该选项。
 *
 * 对应 manifest.json 里的 `background.service_worker: "background.js"`，
 * 且刻意 **不** 声明 `"type": "module"` —— 产物是纯 IIFE，不需要 module 上下文。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const ROOT = import.meta.dirname
const SRC = resolve(ROOT, 'src')
const DIST = resolve(ROOT, 'dist')

export default defineConfig({
  root: SRC,
  // 第 1 趟已经把 src/public/ 复制过去了，这一趟不必再做一遍。
  publicDir: false,
  build: {
    outDir: DIST,
    // 不清空：第 1 趟（Popup/Options）的产物在同一个目录里。
    emptyOutDir: false,
    target: 'chrome120',
    sourcemap: false,
    rolldownOptions: {
      input: resolve(SRC, 'background/index.ts'),
      output: {
        format: 'iife',
        entryFileNames: 'background.js',
      },
    },
  },
})
