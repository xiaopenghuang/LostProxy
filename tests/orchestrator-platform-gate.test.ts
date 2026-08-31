/**
 * 「保存设置」路径上的平台能力闸门 —— 真机死角的回归测试。
 *
 * ## 为什么单独一个文件
 *
 * 本文件用 `vi.mock` 把 `platform` 换成一个**拒绝规则分流**的假平台。
 * `vi.mock` 作用于整个文件的模块图，混进 `orchestrator.test.ts` 会让
 * 那里所有测试都跑在假平台上 —— 而那些测试要的是真实的 chromium 行为。
 *
 * 独立文件没有这个问题，也不会引入测试间的顺序依赖
 * （`platform` 是构建期常量，在测试里切换它会让结果取决于谁先跑）。
 *
 * ## 守的是什么
 *
 * 真机上（Firefox）踩到的死角：
 *
 *   1. 代理**关着**，用户在 Popup 上把模式切成「智能」
 *   2. 保存成功 —— 因为代理关着，压根不走"重新写入"那条路
 *   3. 然后开关就再也点不动了：`handleEnable` 每次被能力检查拦住
 *
 * **一个能存下去、却让功能失效的设置**是最糟的交互形态：用户看不出
 * 自己做错了什么，只知道开关坏了，而且不会想到是几分钟前那次点击造成的。
 *
 * 修法是让能力校验发生在**落盘之前**，且与代理当前开着还是关着无关。
 *
 * 之所以值得单独一个文件加一套 mock：`orchestrator.test.ts` 里那条同名断言
 * 只能验到 `checkSupported` 的 merge 语义，**验不到闸门本身** ——
 * 因为那个文件跑在 chromium 平台上，`supports` 恒为 null，
 * 把闸门整段删掉它也全绿（此方实测确认过）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPlatform, PlatformBlocker } from '../src/background/platform/types'
import { needsRuleBasedRouting } from '../src/background/pac'
import type { Settings } from '../src/shared/types'

/**
 * 假平台：除了「不支持规则分流」之外，行为与 chromium 一致。
 *
 * 刻意**复用真实的 chromium 实现**做底座，只覆盖 `supports` ——
 * 手搓一个全套假平台会让这条测试变成"测我自己写的 mock"，
 * 而真正要验的是编排层在遇到一个说"不支持"的平台时怎么反应。
 */
vi.mock('../src/background/platform', async () => {
  const { chromium } = await import('../src/background/platform/chromium')

  const refusing: BrowserPlatform = {
    ...chromium,
    id: 'firefox',
    supports(settings: Settings): PlatformBlocker | null {
      return needsRuleBasedRouting(settings) ? 'ruleBasedRoutingUnsupported' : null
    },
  }

  return { platform: refusing }
})

const { handleEnable, handleSaveSettings } = await import('../src/background/orchestrator')
const { getEnabledState, getSettings, saveSettings } = await import('../src/background/storage')
const { DEFAULT_SETTINGS } = await import('../src/shared/constants')
const { proxySetting } = await import('./setup')

beforeEach(async () => {
  // setup.ts 的 beforeEach 已经清了 storage 与 setting mock。
  // 这里只补本文件需要的初始状态。
  await saveSettings({ directRules: ['*.edu.cn'] })
})

describe('🔴 保存设置：不许存下一份让开关点不动的配置', () => {
  it('🔴 rejects switching to smart while the proxy is OFF', async () => {
    /*
     * 这是死角的**入口**。原实现在这里返回 ok:true 并落盘，
     * 于是用户带着一份存好的、开不起来的配置离开。
     */
    const response = await handleSaveSettings({ routingMode: 'smart' })

    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('ROUTING_MODE_UNSUPPORTED')
  })

  it('🔴 does not persist the unsupported mode', async () => {
    /*
     * 这一条才是死角真正的成因：**设置落盘了**。
     * 只报错不落盘的话，用户点一下、看到一句解释、什么也没变 ——
     * 一次干净的失败。落了盘就变成一个持久的坏状态。
     */
    await handleSaveSettings({ routingMode: 'smart' })

    expect((await getSettings()).routingMode).toBe(DEFAULT_SETTINGS.routingMode)
  })

  it('🔴 leaves the toggle usable afterwards', async () => {
    /*
     * 死角的**症状**：开关点不动。
     *
     * 这条断言直接验用户实际遇到的那件事 —— 被拒绝之后，
     * 开关必须仍然能正常打开。原实现下这里会失败，
     * 因为 storage 里已经是 smart 了。
     */
    await handleSaveSettings({ routingMode: 'smart' })

    const response = await handleEnable()

    expect(response.ok).toBe(true)
    expect(await getEnabledState()).toBe(true)
  })

  it('🔴 rejects switching to smart while the proxy is ON, too', async () => {
    // 代理开着那条路径此前由 handleSaveSettings 的重新写入分支兜住，
    // 现在被更早的能力闸门拦下 —— 两条路径都不该放过。
    await handleEnable()
    proxySetting.setCalls = []

    const response = await handleSaveSettings({ routingMode: 'smart' })

    expect(response.ok).toBe(false)
    // 关键：一次浏览器写入都没发生。报了错还写了，比不报错更糟。
    expect(proxySetting.setCalls).toHaveLength(0)
    expect((await getSettings()).routingMode).toBe(DEFAULT_SETTINGS.routingMode)
  })

  it('🔴 refuses to enable when the stored config is already unsupported', async () => {
    /*
     * 兜底：万一 storage 里已经躺着一份 smart（旧版本存下的、
     * 或者手改的），开启必须**拒绝**而不是静默按全局开。
     *
     * 这一条守的是 ADR-37 的核心 —— 静默降级会让用户配的直连清单
     * 被无声忽略，他本该直连的校内站点全都走了代理，而 UI 一切正常。
     *
     * 绕过 handleSaveSettings 直接写 storage，模拟"已经存在的坏状态"。
     */
    await saveSettings({ routingMode: 'smart', directRules: ['*.edu.cn'] })

    const response = await handleEnable()

    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('ROUTING_MODE_UNSUPPORTED')
    // 没写入，也没把开关置为 ON —— 不能显示一个不存在的 ON。
    expect(proxySetting.setCalls).toHaveLength(0)
    expect(await getEnabledState()).toBe(false)
  })
})

describe('闸门不该拦住无关的改动', () => {
  it('allows changing the port', async () => {
    /*
     * 防修复过度。此方最初把「能不能分流」和「有没有隐私窗口授权」
     * 混在一个 preflight 里，那会让一个没授权的 Firefox 用户
     * **连端口都改不了** —— 而改端口跟那个权限毫无关系。
     */
    const response = await handleSaveSettings({ proxyPort: 2080 })

    expect(response.ok).toBe(true)
    expect((await getSettings()).proxyPort).toBe(2080)
  })

  it('allows global and direct modes', async () => {
    expect((await handleSaveSettings({ routingMode: 'global' })).ok).toBe(true)
    expect((await handleSaveSettings({ routingMode: 'direct' })).ok).toBe(true)
  })

  it('allows smart mode when the rule list is empty', async () => {
    /*
     * 空清单时行为等价于全局，没有任何东西会被丢掉，所以不该拦。
     * 判据是共享的 needsRuleBasedRouting —— 若有人在平台层改写成
     * 「只要是 smart 就拦」，用户开着一个空清单就再也开不了代理。
     */
    await saveSettings({ directRules: [] })

    const response = await handleSaveSettings({ routingMode: 'smart' })

    expect(response.ok).toBe(true)
  })

  it('🔴 evaluates the merged settings, not just the patch', async () => {
    /*
     * 用户在 Popup 上点「智能」时，patch 里只有 `{routingMode:'smart'}`，
     * 规则清单在**已存的设置**里。若闸门只看 patch，会得出
     * "没有规则、等价于全局、放行"，于是死角原封不动地复发。
     *
     * 上一条（空清单放行）与这一条（有存量规则则拦）合起来，
     * 才锁住"看的是 merge 之后那份"。
     */
    await saveSettings({ directRules: ['*.edu.cn'] })

    expect((await handleSaveSettings({ routingMode: 'smart' })).ok).toBe(false)
  })
})
