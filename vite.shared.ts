/**
 * 两个平台、两趟构建 —— 共四份配置的共同工厂。
 *
 * ## 为什么是四份配置而不是一份带条件
 *
 * 两个正交的维度乘在一起：
 *
 *   - **平台**：Chromium（`dist/`）与 Firefox（`dist-firefox/`）
 *   - **趟次**：扩展页面（多入口 + HTML）与背景脚本（单入口 + IIFE）
 *
 * 趟次必须分开的原因是 MV3 的硬约束：背景脚本必须是自包含单文件，
 * 而这要求 `format: 'iife'`，与多入口互斥（详见 `swConfig` 的注释）。
 *
 * ## 为什么不用环境变量选平台
 *
 * `LOSTPROXY_PLATFORM=firefox vite build` 在 Windows 上跑不起来 ——
 * npm 在 Windows 下用 `cmd.exe` 执行 script，那个语法只有 POSIX shell 认。
 * 本项目的主开发机就是 Windows，加一个 `cross-env` 依赖去解决一个
 * 用函数参数就能解决的问题不值得（尤其在这是个代理工具、
 * 每个依赖都是供应链面的前提下）。
 *
 * 所以平台由**函数参数**传入，四份配置文件各自调用一次。
 * 代价是多两个三行文件，换来的是零依赖与显式。
 */

import { copyFile, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin, type UserConfig } from 'vite'

const ROOT = import.meta.dirname
const SRC = resolve(ROOT, 'src')

/** 与 `background/platform/types.ts` 的 `PlatformId` 保持一致。 */
export type PlatformId = 'chromium' | 'firefox'

/** 每个平台的产物目录与 manifest 源文件。 */
const TARGETS = {
  chromium: { outDir: 'dist', manifest: 'manifest.json' },
  firefox: { outDir: 'dist-firefox', manifest: 'manifest.firefox.json' },
} as const satisfies Record<PlatformId, { outDir: string; manifest: string }>

/**
 * 构建期注入的平台标识。
 *
 * 🔴 这一行是整个跨平台方案的枢纽。`platform/index.ts` 里那个三元表达式
 *   靠它在编译期被消掉，于是 `dist/background.js` 里只有 Chromium 的代码、
 *   `dist-firefox/background.js` 里只有 Firefox 的代码。
 *
 *   这不只是省几 KB：它让「产物里不该出现另一个平台的 WebRTC 策略值」
 *   成为一条可断言的事实（`tests/platform-boundary.test.ts`），
 *   而那条断言守的正是本项目最危险的一处跨平台差异
 *   —— Firefox 上 `disable_non_proxied_udp` 会被接受但防护更弱。
 */
function platformDefine(platform: PlatformId): Record<string, string> {
  return { __LOSTPROXY_PLATFORM__: JSON.stringify(platform) }
}

/**
 * 把对应平台的 manifest 复制到产物根目录，并清掉 publicDir 带进来的图标源图。
 *
 * 手写插件而不是引入 vite-plugin-static-copy，是为了保持零额外依赖。
 */
function copyManifest(platform: PlatformId, dist: string): Plugin {
  return {
    name: `lostproxy:copy-manifest:${platform}`,
    apply: 'build',
    async closeBundle() {
      await mkdir(dist, { recursive: true })
      // 两个平台的产物里文件名都叫 manifest.json —— 浏览器只认这个名字。
      // 源文件名不同（manifest.json / manifest.firefox.json），复制时归一。
      await copyFile(resolve(SRC, TARGETS[platform].manifest), resolve(dist, 'manifest.json'))

      // icon.png 是美术源图（约 1 MB），只用于本地降采样，不该进产物。
      // publicDir 会无差别复制整个目录，所以在这里剔掉。
      await rm(resolve(dist, 'icons', 'icon.png'), { force: true })
    },
  }
}

/**
 * 第 1 趟：扩展页面（Popup + Options）。
 *
 * 扩展页面允许 ES module 与独立 chunk，所以这一趟可以多入口、可以共享 chunk。
 */
export function pagesConfig(platform: PlatformId): UserConfig {
  const dist = resolve(ROOT, TARGETS[platform].outDir)

  return defineConfig({
    root: SRC,
    define: platformDefine(platform),
    plugins: [copyManifest(platform, dist)],
    build: {
      outDir: dist,
      // 不清空：第 2 趟的产物写进同一个目录。清理交给 `npm run clean`。
      emptyOutDir: false,
      /*
       * 两个平台的编译目标不同，这不是凑数：
       *   - chrome120 与 manifest.json 的 minimum_chrome_version 对齐
       *   - firefox128 与 manifest.firefox.json 的 strict_min_version 对齐
       * 写错的后果是产物里出现目标浏览器不认的语法，而症状是
       * 「装上去白屏」——一个不会在开发机上出现的故障。
       */
      target: platform === 'firefox' ? 'firefox128' : 'chrome120',
      sourcemap: false,
      // 关掉 modulepreload polyfill：两个平台的目标版本都原生支持，
      // 对扩展只是凭空多出一个 chunk 文件。
      modulePreload: false,
      rolldownOptions: {
        input: {
          popup: resolve(SRC, 'popup/index.html'),
          options: resolve(SRC, 'options/index.html'),
        },
        output: {
          // 固定文件名（无 hash），便于 manifest 稳定引用。
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
  })
}

/**
 * 第 2 趟：背景脚本。
 *
 * MV3 硬约束：背景脚本必须是自包含的单个文件。若产物中出现 `import(...)`
 * 去拉取另一个 chunk，Chrome 会把它当作远程代码加载，
 * 报 "Service worker registration failed" 并拒绝注册整个扩展。
 *
 * 因此这一趟单入口、`format: 'iife'`（自执行、无顶层 import；
 * `'es'` + lib 模式是常见陷阱，它产出的单文件仍带顶层 import 语句）。
 *
 * ⚠️ Vite 8 / Rolldown 与 Rollup 时代的差异（实测确认）：社区教程普遍写
 *    `output.inlineDynamicImports: true` 来强制单文件，但 Vite 8 在
 *    `format:'iife'` 下会自动设 `codeSplitting: false`，
 *    此时该选项被忽略并产生 WARN。故不声明它。
 *
 * ⚠️ 两个平台的产物**都叫 background.js**，但装载方式不同：
 *    Chromium 是 `background.service_worker`，Firefox 是 `background.scripts`
 *    （Firefox 不支持扩展 service worker，见 Firefox bug 1573659）。
 *    IIFE 单文件恰好同时满足两者 —— 这是这个格式选择的意外红利，
 *    事件页对单文件没有硬要求，但也完全接受。
 */
export function swConfig(platform: PlatformId): UserConfig {
  const dist = resolve(ROOT, TARGETS[platform].outDir)

  return defineConfig({
    root: SRC,
    define: platformDefine(platform),
    // 第 1 趟已经把 src/public/ 复制过去了，这一趟不必再做一遍。
    publicDir: false,
    build: {
      outDir: dist,
      emptyOutDir: false,
      target: platform === 'firefox' ? 'firefox128' : 'chrome120',
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
}
