/**
 * LostProxy — Background Service Worker 入口
 *
 * 本文件刻意保持极薄：**只做事件绑定**，所有逻辑都在 orchestrator.ts。
 *
 * 为什么这么切：Service Worker 入口一被 import 就会执行顶层注册代码，
 * 因此它天然不可单元测试。把编排逻辑留在这里，等于让项目最核心的
 * fail-closed 语义（ADR-03）永远只有代码注释保护。
 * 抽走之后 orchestrator.ts 可以被完整测试，本文件则薄到无需测试。
 *
 * ⚠️ MV3 生命周期铁律（ADR-08）：
 *   Service Worker 会被浏览器随时终止并按需重新拉起。
 *   本文件**禁止在模块作用域持有可变状态**——
 *   所有状态一律从 chrome.storage.local 读取，每次唤醒重新构建。
 *
 * ⚠️ 事件监听器必须在顶层**同步**注册。
 *   若放进某个 async 流程里延迟注册，SW 被唤醒后事件会在监听器挂上之前丢失。
 */

import { handleMessage, reconcile } from './orchestrator'
import { registerProxyErrorListener } from './proxy'
import { setLastError } from './storage'

/**
 * 代理运行时错误 → 落盘。
 *
 * 必须持久化：本事件可能在 SW 被终止之前触发，只留内存就丢了。
 * 而 fatal=false 的 proxy error 意味着**已经发生过一次直连**，
 * 是全项目最不能丢的一条信息（ADR-04）。
 */
registerProxyErrorListener(async (error) => {
  await setLastError(error)
})

chrome.runtime.onInstalled.addListener((details) => {
  console.info('[LostProxy] onInstalled:', details.reason)
  void reconcile()
})

chrome.runtime.onStartup.addListener(() => {
  void reconcile()
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  // 返回 true 保持消息通道开启，否则 MV3 下异步 sendResponse 会失效。
  void handleMessage(message).then(sendResponse)
  return true
})

console.info('[LostProxy] service worker booted')
