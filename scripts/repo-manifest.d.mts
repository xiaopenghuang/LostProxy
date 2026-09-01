/**
 * `repo-manifest.mjs` 的类型声明。
 *
 * ## 为什么需要这个文件
 *
 * 那份白名单要被两处共用：`sign-firefox.mjs`（Node 直接跑的 `.mjs`）与
 * `tests/repo-hygiene.test.ts`（走 tsc + Vitest 的 `.ts`）。同一份清单
 * 抄成两份就会漂移，而漂移的方向必然是**测试那份更旧** ——
 * 于是 CI 绿着，源码包里却多了东西。
 *
 * 让 `.ts` 能 import 一个 `.mjs`，本项目没开 `allowJs`（开了会把
 * `scripts/` 与所有 vite 配置一并拉进编译范围，为一处便利换一堆
 * 无关的类型错误）。补一个手写声明是标准解法，代价是这里的签名
 * 必须跟着 `.mjs` 手动同步 —— 两个导出、一年动不了一次，划得来。
 */

/** 允许出现在仓库根目录的条目。 */
export declare const ALLOWED_ROOT_ENTRIES: readonly string[]

/** 列出 HEAD 根目录里不在白名单上的条目，按名字排序。 */
export declare function findStrayRootEntries(cwd: string): string[]
