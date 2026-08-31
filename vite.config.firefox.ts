/**
 * Vite 配置 —— Firefox，第 1 趟：扩展页面（Popup + Options）。
 *
 * 实质内容在 vite.shared.ts。产物进 dist-firefox/，
 * 编译目标 firefox128（与 manifest.firefox.json 的 strict_min_version 对齐）。
 *
 * UI 层完全共享 —— Popup 与 Options 的代码只经由 chrome.runtime 消息
 * 与 background 对话，从不直接碰 chrome.proxy / chrome.privacy，
 * 因此不存在平台差异（architecture.md ADR-36）。
 */
import { pagesConfig } from './vite.shared'

export default pagesConfig('firefox')
