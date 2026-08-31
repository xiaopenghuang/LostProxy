/**
 * Vite 配置 —— Chromium / Edge，第 2 趟：Background Service Worker。
 *
 * 实质内容在 vite.shared.ts —— 包括 MV3 为什么要求单文件、
 * 为什么用 IIFE、以及 Vite 8 下那个不该再写的 inlineDynamicImports。
 *
 * 对应 manifest.json 里的 `background.service_worker: "background.js"`，
 * 且刻意 **不** 声明 `"type": "module"` —— 产物是纯 IIFE，不需要 module 上下文。
 */
import { swConfig } from './vite.shared'

export default swConfig('chromium')
