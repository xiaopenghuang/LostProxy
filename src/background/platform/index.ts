/**
 * 平台实现的唯一出口。
 *
 * 🔴 **这是全项目唯一允许出现「是哪个浏览器」这个问题的地方。**
 *
 * 业务代码一律 `import { platform } from './platform'`，永远不问它是谁。
 * 加平台时改的是这一个文件，**不是**在 proxy.ts / privacy.ts /
 * orchestrator.ts 里撒 `isFirefox()` 分支（architecture.md ADR-36）。
 *
 * 为什么这条规矩值得写死：本项目真机上出过的三个 bug，有两个的成因都是
 * 「测试是绿的，但某条真实路径没被覆盖到」。每加一个运行时分支，
 * 就多一条只在某个浏览器上走到的路径，而那类 bug 最难发现 ——
 * 开发者手上通常只有一个浏览器。把分歧压到一处，才能逐条对照着读完。
 *
 * ## 为什么是构建期选择，不是运行期嗅探
 *
 * `__LOSTPROXY_PLATFORM__` 由 Vite 的 `define` 在编译时替换成字面量，
 * 因此下面这个三元表达式在产物里会被完全消掉 —— dist/ 里只有 Chromium
 * 的代码，dist-firefox/ 里只有 Firefox 的代码。没有死代码，
 * 也没有「另一个平台的实现意外被执行」的可能。
 *
 * 三个理由，按重要性排：
 *
 * 1. **运行期嗅探本身不可靠。** Firefox 同时提供 `chrome.*` 与 `browser.*`，
 *    Edge 的 UA 里有 "Chrome"，而 `navigator.userAgent` 在扩展里可以被
 *    其他扩展改。任何嗅探都是一条会在某个环境上判错的启发式规则 ——
 *    而判错的后果是用错一套 API 语义，也就是本层要防的那件事。
 *
 * 2. **它省不了事。** Firefox 的 MV3 背景脚本用事件页（`background.scripts`）
 *    而非 service worker，manifest 本来就要分两份、出两个产物。
 *    既然已经要两次构建，构建期选择是免费的。
 *
 * 3. **产物可审计。** 「dist-firefox/background.js 里不该出现
 *    `disable_non_proxied_udp`」这种断言只有在构建期分离时才成立，
 *    而它正是 `tests/platform-boundary.test.ts` 用来锁 WebRTC 那条差异的手段。
 */

import { chromium } from './chromium'
import { firefox } from './firefox'
import type { BrowserPlatform, PlatformId } from './types'

/**
 * 构建期注入的平台标识。
 *
 * 声明成 `PlatformId` 而不是 `string`：拼错平台名会变成**编译错误**，
 * 而不是运行期静默落到 else 分支上。
 */
declare const __LOSTPROXY_PLATFORM__: PlatformId

/**
 * 当前平台的实现。
 *
 * ⚠️ 用三元而不是 `Record<PlatformId, BrowserPlatform>` 查表，是为了让
 *    Rolldown 能做 dead code elimination —— 查表写法会让两个实现都被引用，
 *    于是两份代码都进产物，第 3 条理由（产物可审计）就没了。
 *
 * 加第三个平台时这里要改成两层三元，届时 `PlatformId` 的穷尽性由
 * 下面那行 `satisfies` 之外的手段保证：`platform-boundary.test.ts` 有一条
 * 断言核对 `platform.id` 与构建目标一致，漏接一个平台会让它变红。
 */
export const platform: BrowserPlatform =
  __LOSTPROXY_PLATFORM__ === 'firefox' ? firefox : chromium

export type { BrowserPlatform, PlatformBlocker, PlatformId, ProxyInspection, WebRtcInspection } from './types'
