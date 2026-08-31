/*
 * 测试夹具：占住 chrome.proxy，用来验证 LostProxy 的冲突检测（DoD #14 / test-plan §5.4）。
 *
 * 为什么需要它：那一条要验的是「代理设置被另一个扩展控制时，LostProxy 必须拒绝开启
 * 并说明原因，且开关不能亮」。制造这个状态需要第二个扩展来抢 chrome.proxy。
 *
 * 为什么不用 SwitchyOmega：它已经停止维护，原版是 Manifest V2，
 * Chrome 138（2025-07-24）移除 MV2 支持后在所有 Chromium 浏览器上都跑不了；
 * 而商店里同名的多为第三方重写，其中一个假 fork 在 2024 年 12 月被用于
 * 供应链攻击（影响约 260 万台设备）。为跑一次五分钟的测试去给一个
 * 未经审计的扩展授予全部流量的访问权，不成比例。
 *
 * 这个夹具刻意做到最小：
 *   - 只申请 `proxy` 一项权限，不要 storage、不要 host_permissions、不要 tabs
 *   - 不发任何网络请求，不读任何数据
 *   - 指向 127.0.0.1:9 —— discard 端口，本机必定无人监听。
 *     它的作用是"占位"而不是"能用"，而指向一个必然连不通的地址
 *     可以确保它不会意外把你的流量送到任何地方。
 *
 * 名字以 ZZ 开头只是为了在 edge://extensions 列表里排到末尾，方便测完找到并删掉。
 */

const CONFIG = {
  mode: 'fixed_servers',
  rules: {
    singleProxy: { scheme: 'http', host: '127.0.0.1', port: 9 },
    bypassList: ['<local>'],
  },
}

let held = false

async function apply() {
  if (held) {
    await chrome.proxy.settings.clear({ scope: 'regular' })
    held = false
  } else {
    await chrome.proxy.settings.set({ value: CONFIG, scope: 'regular' })
    held = true
  }
  await chrome.action.setBadgeText({ text: held ? 'ON' : '' })
  console.log(`[fixture] proxy ${held ? 'seized' : 'released'}`)
}

// 装上即抢占，省掉一步点击。
chrome.runtime.onInstalled.addListener(() => {
  void apply()
})

// Service Worker 被回收后重启时，恢复占用状态。
chrome.runtime.onStartup.addListener(() => {
  held = false
  void apply()
})

// 点图标在「占用 / 释放」之间切换，用来验测试的第二步（停用后 LostProxy 应能正常开启）。
chrome.action.onClicked.addListener(() => {
  void apply()
})
