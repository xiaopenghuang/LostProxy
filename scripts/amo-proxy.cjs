/**
 * 让 Node 认 `HTTPS_PROXY` —— 签名脚本专用。
 *
 * ## 为什么需要它
 *
 * `scripts/sign-firefox.mjs` 把上传交给 `web-ext`（一个 Node 子进程），
 * 而 **Node 的内置 `fetch` 默认不读代理环境变量**。`NODE_USE_ENV_PROXY`
 * 是 Node 24 才有的开关，本项目要求 22.9，用不了。
 *
 * 后果很具体：环境里明明有 `HTTPS_PROXY`，签名却死在 `fetch failed`，
 * 而失败信息里没有任何东西指向"没走代理"这件事。此方第一版就是这么
 * 卡住的，最后靠 `NODE_OPTIONS=--require=...` 手工注入才通 ——
 * 那种一次性的解法不该让人每次发版都重新想起来。
 *
 * ## 为什么是 CJS
 *
 * 它要靠 `NODE_OPTIONS=--require=<本文件>` 注入到子进程，而 `--require`
 * 只接受 CommonJS。主脚本自己也 `require` 它来取 `proxyFromEnv()`，
 * 好让"读哪个变量"只有一处定义 —— 两份拷贝迟早会漂。
 *
 * ## 它不是扩展的一部分
 *
 * 只跑在签名那台机器上，不进任何构建产物。扩展本身从不访问网络，
 * 除了它自己那次经代理发出的出口探测。
 */

'use strict'

/**
 * 从环境变量取代理地址。没有就返回 null。
 *
 * 大小写两种都认：Windows 下项目习惯写 `HTTPS_PROXY`，而 shell 脚本
 * 与 CI 常写小写。空字符串按"没设"处理 —— `HTTPS_PROXY=` 是常见的
 * 清除方式，把它当成有效值会让请求发往一个空地址。
 *
 * 优先 https 变量：http 变量更可能是指给普通 HTTP 的，而 AMO 全程 HTTPS。
 */
function proxyFromEnv() {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/**
 * `undici` 装没装。
 *
 * 它在 devDependencies 里，所以正常 `npm ci` 之后一定有。单独判一次是
 * 为了给出**能照着做**的提示，而不是让签名以一条 `Cannot find module`
 * 结束 —— 那时用户看到的是一句和代理无关的报错。
 */
function undiciAvailable() {
  try {
    require.resolve('undici')
    return true
  } catch {
    return false
  }
}

/**
 * 装上全局 dispatcher。返回实际使用的代理地址（没装成则 null）。
 *
 * ⚠️ 只在**本进程**生效。子进程靠 `NODE_OPTIONS=--require=<本文件>`
 *    把同一段逻辑再跑一遍 —— 见主脚本里拼 NODE_OPTIONS 的地方。
 */
function install() {
  const proxy = proxyFromEnv()
  if (proxy === null) return null
  if (!undiciAvailable()) return null

  const { ProxyAgent, setGlobalDispatcher } = require('undici')
  setGlobalDispatcher(new ProxyAgent(proxy))
  return proxy
}

/*
 * 被 `--require` 注入时，这行就是全部效果。
 * 被主脚本 `require` 时也跑一次 —— 幂等，且主脚本本来就不发请求，
 * 装上与否只影响它可能有的调试输出。
 */
install()

module.exports = { proxyFromEnv, undiciAvailable, install }
