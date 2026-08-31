/**
 * Vite 配置 —— Firefox，第 2 趟：Background 事件页脚本。
 *
 * 实质内容在 vite.shared.ts。
 *
 * ⚠️ 产物同样叫 background.js，但 manifest.firefox.json 用
 *    `background.scripts: ["background.js"]` 而不是 `service_worker`：
 *    Firefox 不支持扩展 service worker（Firefox bug 1573659），
 *    MV3 下走的是事件页（`persistent` 默认 false，空闲时卸载、
 *    有事件时重建）。
 *
 * 这个差异对本项目的实际影响只有一条，而它已经被满足：
 * 事件监听必须在脚本**顶层同步注册**，否则重建后事件会丢。
 * `background/index.ts` 本来就是这么写的 —— MV3 的 service worker
 * 有完全相同的约束，两个平台在这一点上是同一条规矩。
 */
import { swConfig } from './vite.shared'

export default swConfig('firefox')
