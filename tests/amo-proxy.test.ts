import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

interface AmoProxy {
  proxyFromEnv(): string | null
  undiciAvailable(): boolean
  install(): string | null
}

const amoProxy = require('../scripts/amo-proxy.cjs') as AmoProxy

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('代理地址的读取', () => {
  /**
   * 这一层只做一件事：决定 web-ext 那次上传走哪条路。
   *
   * 读错的后果不是报错，而是**看起来像别的问题** —— 签名死在
   * `fetch failed`，人会去怀疑凭据、怀疑 AMO 挂了、怀疑版本号，
   * 而真正的原因只是代理变量没被认出来。
   */
  it('读 HTTPS_PROXY', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:2080')
    expect(amoProxy.proxyFromEnv()).toBe('http://127.0.0.1:2080')
  })

  it('小写也认', () => {
    // shell 脚本与 CI 里小写更常见，而 Windows 上习惯写大写 —— 两种都得活。
    vi.stubEnv('HTTPS_PROXY', '')
    vi.stubEnv('https_proxy', 'http://127.0.0.1:2080')
    expect(amoProxy.proxyFromEnv()).toBe('http://127.0.0.1:2080')
  })

  it('🔴 空值当成没设', () => {
    /*
     * `HTTPS_PROXY=` 是常见的清除方式。把它当成有效值会让请求发往一个
     * 空地址，报错文本与"完全没配代理"完全不同 —— 排查方向直接跑偏。
     */
    vi.stubEnv('HTTPS_PROXY', '')
    vi.stubEnv('https_proxy', '')
    vi.stubEnv('HTTP_PROXY', '')
    vi.stubEnv('http_proxy', '')
    expect(amoProxy.proxyFromEnv()).toBeNull()
  })

  it('https 变量优先于 http', () => {
    // AMO 全程 HTTPS，而 http 变量更可能是给普通 HTTP 请求用的。
    vi.stubEnv('HTTPS_PROXY', 'http://secure-proxy:1')
    vi.stubEnv('HTTP_PROXY', 'http://plain-proxy:1')
    expect(amoProxy.proxyFromEnv()).toBe('http://secure-proxy:1')
  })

  it('一个都没有时返回 null', () => {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      vi.stubEnv(key, '')
    }
    expect(amoProxy.proxyFromEnv()).toBeNull()
  })
})

describe('undici 与安装', () => {
  it('devDependencies 里有 undici', () => {
    /*
     * 没有它，代理这条路会**静默退化成直连** —— 那正是这个改动要消灭的
     * 状态。它必须是声明过的依赖而不是"某次 npm i --no-save 留下的"，
     * 否则 `npm ci` 之后换一台机器发版就又会卡在 fetch failed。
     */
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'))
    expect(pkg.devDependencies?.undici).toBeTypeOf('string')
  })

  it('装了就能用', () => {
    expect(amoProxy.undiciAvailable()).toBe(true)
  })

  it('没设代理时 install() 什么都不做', () => {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      vi.stubEnv(key, '')
    }
    // 返回值就是"有没有接管"，null 表示保持 Node 原样。
    expect(amoProxy.install()).toBeNull()
  })
})
