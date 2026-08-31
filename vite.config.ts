/**
 * Vite 配置 —— 第 1 趟：扩展页面（Popup + Options）
 *
 * 为什么是「两趟 build」而不是一个多入口 config？
 *   Manifest V3 的 service worker 禁止依赖动态 import 去加载独立 chunk
 *   （Chrome 视为远程代码加载，直接拒绝注册 SW）。要保证 SW 是单文件，
 *   必须用 `output.inlineDynamicImports: true`，而该选项与多入口互斥。
 *   因此：本文件负责 Popup/Options（HTML 入口，扩展页面允许 ES module 与 chunk），
 *   vite.config.sw.ts 负责 service worker（单入口 + IIFE + 内联）。
 *
 * 为什么 `emptyOutDir: false`？
 *   两趟 build 写入同一个 dist/。若任一趟清空目录，就会把另一趟的产物删掉
 *   （watch 模式下尤其致命）。清理统一交给 `npm run clean`。
 *
 * Vite 8 起底层 bundler 是 Rolldown（不再是 Rollup + esbuild），
 * 配置键为 `build.rolldownOptions`（`rollupOptions` 仅作已弃用的兼容别名）。
 */
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const ROOT = import.meta.dirname
const SRC = resolve(ROOT, 'src')
const DIST = resolve(ROOT, 'dist')

/**
 * 把 src/manifest.json 原样复制到 dist/ 根目录，
 * 并清掉 publicDir 带进来的图标源图。
 *
 * 手写插件而不是引入 vite-plugin-static-copy，是为了保持零额外依赖。
 */
function copyManifest(): Plugin {
  return {
    name: 'lostproxy:copy-manifest',
    apply: 'build',
    async closeBundle() {
      await mkdir(DIST, { recursive: true })
      await copyFile(resolve(SRC, 'manifest.json'), resolve(DIST, 'manifest.json'))

      // icon.png 是美术源图（约 1 MB），只用于本地降采样，
      // 不该进产物。publicDir 会无差别复制整个目录，所以在这里剔掉。
      await rm(resolve(DIST, 'icons', 'icon.png'), { force: true })
    },
  }
}

export default defineConfig({
  root: SRC,
  plugins: [copyManifest()],
  build: {
    outDir: DIST,
    emptyOutDir: false,
    // Edge/Chromium 下限与 manifest.json 的 minimum_chrome_version 保持一致。
    target: 'chrome120',
    // 生产产物不带 source map。需要调试时临时改为 'inline'。
    sourcemap: false,
    // 关掉 modulepreload polyfill：Edge 120+ 原生支持，
    // 对扩展只是凭空多出一个 chunk 文件。
    modulePreload: false,
    rolldownOptions: {
      input: {
        popup: resolve(SRC, 'popup/index.html'),
        options: resolve(SRC, 'options/index.html'),
      },
      output: {
        // 固定文件名（无 hash），便于 manifest.json 稳定引用。
        entryFileNames: '[name].js',
        // 共享代码产生的 chunk 放子目录，避免与 entry 撞名。
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
