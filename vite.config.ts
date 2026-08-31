/**
 * Vite 配置 —— Chromium / Edge，第 1 趟：扩展页面（Popup + Options）。
 *
 * 实质内容在 vite.shared.ts。四份配置（2 平台 × 2 趟）都是三行调用，
 * 那里有为什么这样拆的完整理由。
 *
 * 保持这个文件名不变是刻意的：`vite build` 默认读 vite.config.ts，
 * 而 Chromium 是主目标。改名会让最常用的命令需要多打一个 --config。
 */
import { pagesConfig } from './vite.shared'

export default pagesConfig('chromium')
