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

import { handleMessage, handleTabLoading, handleToggle, reconcile } from './orchestrator'
import { registerPlatformListeners, registerProxyErrorListener } from './proxy'
import { getEnabledState, getSettings, setLastError } from './storage'

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

/**
 * 平台自己需要的长期监听（ADR-36）。
 *
 * 目前只有 Firefox 用到：智能分流走 `proxy.onRequest`，一个每请求都要
 * 回答的监听。Chromium 那边是空实现 —— PAC 由浏览器执行，随代理设置存活。
 *
 * 🔴 **必须在这里顶层注册，不能放进 orchestrator 的业务流程。**
 *   Firefox 的 MV3 背景是事件页，空闲约 30 秒就卸载。从"用户点了开启"
 *   那条路挂上的监听会随之消失且没人重挂，于是用户的直连清单
 *   静默失效 —— 页面还能开，只是校内站点开始走代理。
 *   本文件文件头那条铁律说的就是这件事。
 *
 * 注入一个**现读**状态的函数而不是当前状态的快照：事件页重建后
 * 这个闭包会用新的 storage 内容，不会捏着一份过期数据。
 *
 * 同时给开关状态与设置 —— 缺了开关状态会漏掉一个反方向的欺骗：
 * 代理关掉后 routingMode 与规则并不会变，监听于是继续把流量送进代理，
 * 而 UI 显示已关闭。
 */
registerPlatformListeners(async () => ({
  enabled: await getEnabledState(),
  settings: await getSettings(),
}))

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

/*
 * 键盘快捷键切换代理开关（V0.8）。
 *
 * `chrome.commands` 在极少数环境可能缺席（旧内核、被裁剪的构建），用可选链保平安 ——
 * 缺了它只是没有快捷键，不该让整个 SW 启动时抛错。
 *
 * 与其它监听一样必须顶层同步注册：从异步流程里延迟挂上，SW 被唤醒后
 * 按键会在监听器就位之前丢失（文件头那条铁律）。
 */
chrome.commands?.onCommand.addListener((command) => {
  if (command === 'toggle-proxy') void handleToggle()
})

/**
 * 时区注入的触发点（V0.9）。
 *
 * 挂在 `tabs.onUpdated` 的 `loading` 阶段，而不是 `complete`：
 * 注入必须早于页面自己的脚本，`complete` 时一切都已经跑完了 ——
 * 那会在页面上留下一个「看着同步了、实际没同步」的空操作。
 *
 * ⚠️ `loading` 仍然是**导航提交之后**，而 content script 的
 *    `document_start` 更早。所以这里存在一个极小的竞态：极快的
 *    内联脚本可能抢在前面读到真实时区。用 `injectImmediately: true`
 *    把这次注入排到队首，能把窗口压到最小 —— 但压不到零。
 *    改不了的部分是浏览器 API 的边界，不是实现取舍。
 *
 * ⚠️ `tab.url` 在未授予目标站点权限时是 `undefined`，
 *    `handleTabLoading` 会直接返回 —— 这正是未授权时该有的行为。
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return
  void handleTabLoading(tabId, tab.url)
})

console.info('[LostProxy] service worker booted')
