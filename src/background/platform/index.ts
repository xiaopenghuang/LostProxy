/**
 * 平台实现的唯一出口。
 *
 * 🔴 **这是全项目唯一允许出现「是哪个浏览器」这个问题的地方。**
 *
 * 业务代码一律 `import { platform } from './platform'`，永远不问它是谁。
 * 加 Firefox 支持时改的是这一个文件，**不是**在 proxy.ts / privacy.ts /
 * orchestrator.ts 里撒 `isFirefox()` 分支（architecture.md ADR-36）。
 *
 * 为什么这条规矩值得写死：本项目真机上出过的三个 bug，有两个的成因都是
 * 「测试是绿的，但某条真实路径没被覆盖到」。每加一个运行时分支，
 * 就多一条只在某个浏览器上走到的路径，而那类 bug 恰恰是最难发现的 ——
 * 开发者手上只有一个浏览器。把分歧压到一处，才能逐条对照着读完。
 *
 * ## 目前只有一个实现
 *
 * V0.3 之前只支持 Chromium / Edge，所以这里是一行静态 re-export。
 * 接 Firefox 时会变成构建期选择（`import.meta.env` + define，产物里只留一个），
 * 而**不是**运行期嗅探 —— 理由是 Firefox 的 MV3 背景脚本用的是事件页
 * （`background.scripts`）而非 service worker，manifest 本来就必须分开两份，
 * 既然已经要出两个产物，构建期选择就是免费的。
 */

export { chromium as platform } from './chromium'
export type { BrowserPlatform, PlatformId, ProxyInspection, WebRtcInspection } from './types'
