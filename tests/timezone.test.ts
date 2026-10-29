/**
 * 时区模块的测试 —— 探测、匹配、缓存、权限。
 *
 * 注入函数本身的行为在 `timezone-inject.test.ts` 里测（它必须跑在独立
 * 上下文里，见那份文件的说明）。这里测的是**注入之前**的全部判断：
 * 拿到的是什么值、给谁注入、什么时候值得再探测。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTimezoneSnapshot,
  hasInjectionPermission,
  isSnapshotStale,
  isValidHostPattern,
  matchesHost,
  normalizeZone,
  probeExitZone,
  lookupCachedZone,
  reinjectOpenTabs,
  rememberZone,
  setTimezoneSnapshot,
  toOriginPatterns,
} from '../src/background/timezone'
import {
  TIMEZONE_PROBE_HOSTS,
  TIMEZONE_PROBE_URLS,
  TIMEZONE_SNAPSHOT_TTL_MS,
} from '../src/shared/constants'
import type { TimezoneSnapshot } from '../src/shared/types'
import { readExecuteScriptCalls, seedMockStore, setGrantedOrigins, setMockTabs } from './setup'

/** 造一个 fetch 返回值。用最小对象而不是 Response —— 被测代码只用到这四项。 */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function stubFetch(impl: () => Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeZone', () => {
  it('accepts and canonicalises an IANA name', () => {
    expect(normalizeZone('Asia/Tokyo')).toBe('Asia/Tokyo')
    // 大小写不规范时 Intl 会规范化，我们取规范化后的值 ——
    // 否则存下来的值会与内核/页面拿到的值"看起来一样、比较不相等"。
    expect(normalizeZone('asia/tokyo')).toBe('Asia/Tokyo')
  })

  it('rejects anything Intl will not accept', () => {
    expect(normalizeZone('Mars/Olympus')).toBeNull()
    expect(normalizeZone('')).toBeNull()
    expect(normalizeZone('   ')).toBeNull()
    expect(normalizeZone(42)).toBeNull()
    expect(normalizeZone(null)).toBeNull()
    expect(normalizeZone('x'.repeat(65))).toBeNull()
  })

  it('trims before validating', () => {
    expect(normalizeZone('  Asia/Tokyo  ')).toBe('Asia/Tokyo')
  })
})

describe('isValidHostPattern', () => {
  it('accepts plain domains', () => {
    expect(isValidHostPattern('chatgpt.com')).toBe(true)
    expect(isValidHostPattern('chat.openai.com')).toBe(true)
    expect(isValidHostPattern('a-b.example.co.uk')).toBe(true)
  })

  it('rejects wildcards, schemes, ports and paths', () => {
    // 这些都会被送进 permissions.request 的 origins —— 一个宽松的校验
    // 会变成一个用户看不懂的授权弹窗，或者在注入时静默失败。
    expect(isValidHostPattern('*.chatgpt.com')).toBe(false)
    expect(isValidHostPattern('https://chatgpt.com')).toBe(false)
    expect(isValidHostPattern('chatgpt.com:443')).toBe(false)
    expect(isValidHostPattern('chatgpt.com/path')).toBe(false)
    expect(isValidHostPattern('')).toBe(false)
    expect(isValidHostPattern('localhost')).toBe(false)
    expect(isValidHostPattern(123)).toBe(false)
  })
})

describe('matchesHost', () => {
  const hosts = ['chatgpt.com', 'openai.com']

  it('matches the bare domain and its subdomains', () => {
    expect(matchesHost('https://chatgpt.com/', hosts)).toBe(true)
    expect(matchesHost('https://www.chatgpt.com/c/123', hosts)).toBe(true)
    expect(matchesHost('https://chat.openai.com/', hosts)).toBe(true)
  })

  it('does not match a domain that merely ends with the same letters', () => {
    /*
     * 🔴 这条是这里最要紧的一条。用 `includes()` 或 `endsWith(target)`
     *    实现的话，`evilchatgpt.com` 和 `chatgpt.com.evil.com` 都会被判为
     *    匹配 —— 于是我们把时区注入到了用户没列出的站点上。
     */
    expect(matchesHost('https://evilchatgpt.com/', hosts)).toBe(false)
    expect(matchesHost('https://chatgpt.com.evil.com/', hosts)).toBe(false)
    expect(matchesHost('https://notopenai.com/', hosts)).toBe(false)
  })

  it('ignores non-http schemes', () => {
    // chrome:// 与 about: 不能被 executeScript 注入，也不该尝试。
    expect(matchesHost('chrome://settings', hosts)).toBe(false)
    expect(matchesHost('about:blank', hosts)).toBe(false)
    expect(matchesHost('not a url', hosts)).toBe(false)
  })

  it('returns false for an empty list', () => {
    expect(matchesHost('https://chatgpt.com/', [])).toBe(false)
  })
})

describe('toOriginPatterns', () => {
  it('covers the bare domain and subdomains with one pattern', () => {
    // Chromium 的 `*.` 语义包含裸域，所以一条就够。
    expect(toOriginPatterns(['chatgpt.com'])).toEqual(['*://*.chatgpt.com/*'])
  })

  it('normalises case', () => {
    expect(toOriginPatterns(['ChatGPT.com'])).toEqual(['*://*.chatgpt.com/*'])
  })
})

describe('isSnapshotStale', () => {
  const fresh: TimezoneSnapshot = {
    zone: 'Asia/Tokyo',
    country: 'JP',
    locale: 'ja-JP',
    exitIp: '1.2.3.4',
    at: Date.now(),
    node: 'JP-01',
    error: null,
  }

  it('treats a missing snapshot as stale', () => {
    expect(isSnapshotStale(null, TIMEZONE_SNAPSHOT_TTL_MS)).toBe(true)
  })

  it('treats a snapshot without a zone as stale', () => {
    // 上次探测失败留下的空壳：那正是用户点「立即探测」想解决的状态。
    expect(isSnapshotStale({ ...fresh, zone: null }, TIMEZONE_SNAPSHOT_TTL_MS)).toBe(true)
  })

  it('treats at = 0 as stale', () => {
    expect(isSnapshotStale({ ...fresh, at: 0 }, TIMEZONE_SNAPSHOT_TTL_MS)).toBe(true)
  })

  it('keeps a recent snapshot', () => {
    expect(isSnapshotStale(fresh, TIMEZONE_SNAPSHOT_TTL_MS)).toBe(false)
  })

  it('expires after the TTL', () => {
    const old: TimezoneSnapshot = { ...fresh, at: Date.now() - TIMEZONE_SNAPSHOT_TTL_MS - 1000 }
    expect(isSnapshotStale(old, TIMEZONE_SNAPSHOT_TTL_MS)).toBe(true)
  })
})

describe('probeExitZone', () => {
  it('returns zone, country and exit IP on success', async () => {
    const fetchMock = stubFetch(async () =>
      fakeResponse(200, { ip: '103.1.2.3', timezone: 'Asia/Tokyo', country: 'JP' }),
    )

    const result = await probeExitZone()

    // country 与时区分开断言：后者决定时钟，前者决定语言，两者都缺不得。
    expect(result).toEqual({
      ok: true,
      zone: 'Asia/Tokyo',
      country: 'JP',
      exitIp: '103.1.2.3',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the request without credentials and without cache', async () => {
    /*
     * 两条都不是优化而是正确性：
     *   - credentials: 'omit' —— 带 cookie 等于把一个可追踪标识交给第三方；
     *   - cache: 'no-store'   —— 命中缓存会返回上一个节点的结果，
     *     表现是"换了节点时区不变"，一个只会偶发、看起来像功能坏了的 bug。
     */
    const fetchMock = stubFetch(async () => fakeResponse(200, { timezone: 'Asia/Tokyo' }))
    await probeExitZone()

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.credentials).toBe('omit')
    expect(init.cache).toBe('no-store')
  })

  it('reports an unreachable service without throwing', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })

    const result = await probeExitZone()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TZ_PROBE_FAILED')
  })

  it('reports a non-2xx response', async () => {
    stubFetch(async () => fakeResponse(429, {}))

    const result = await probeExitZone()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.params?.reason).toBe('HTTP 429')
  })

  it('distinguishes a timeout from a network failure', async () => {
    // 用户按 "timeout" 排查（换节点、代理不通）和按 DNS 失败排查，
    // 方向并不一样，所以文案必须能分开。
    stubFetch(async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })

    const result = await probeExitZone()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.params?.reason).toBe('timeout')
  })

  it('rejects a zone this browser does not recognise', async () => {
    // 不能把无效时区带去注入：Intl 在页面里抛 RangeError 会让整段注入失效，
    // 而页面会静默退回真实时区。
    stubFetch(async () => fakeResponse(200, { timezone: 'Mars/Olympus' }))

    const result = await probeExitZone()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TZ_INVALID_ZONE')
  })

  it('reports a missing timezone field', async () => {
    stubFetch(async () => fakeResponse(200, { ip: '1.2.3.4' }))

    const result = await probeExitZone()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TZ_INVALID_ZONE')
  })
})

describe('probeExitZone · 源降级', () => {
  /*
   * 免费地理服务按**请求方 IP** 限流，而我们的出口是共享的节点 IP ——
   * 在热门节点上撞日限额是常态。只有一个源时，撞上的表现是
   * 「时区同步突然不动了」，且没有任何自愈路径。
   */

  it('🔴 第一个源被限流时换下一个', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(429, {}))
      .mockResolvedValueOnce(fakeResponse(200, { timezone: 'Asia/Tokyo', ip: '1.2.3.4' }))
    vi.stubGlobal('fetch', mock)

    const result = await probeExitZone()

    expect(result).toEqual({
      ok: true,
      zone: 'Asia/Tokyo',
      country: null,
      exitIp: '1.2.3.4',
    })
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('第一个源返回无法识别的时区时也降级', async () => {
    // 服务通了但内容不对，同样不该卡在这一源上 —— 下一个源可能给对的。
    const mock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(200, { timezone: 'Mars/Olympus' }))
      .mockResolvedValueOnce(fakeResponse(200, { timezone: 'Asia/Tokyo' }))
    vi.stubGlobal('fetch', mock)

    expect((await probeExitZone()).ok).toBe(true)
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('网络失败时也降级', async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(fakeResponse(200, { timezone: 'Asia/Tokyo' }))
    vi.stubGlobal('fetch', mock)

    expect((await probeExitZone()).ok).toBe(true)
  })

  it('全部失败时返回错误，且每个源都试过', async () => {
    const mock = vi.fn(async () => fakeResponse(500, {}))
    vi.stubGlobal('fetch', mock)

    const result = await probeExitZone()

    expect(result.ok).toBe(false)
    // 只试一个就等于没有降级 —— 这条断言锁的是"真的遍历了"。
    expect(mock).toHaveBeenCalledTimes(TIMEZONE_PROBE_URLS.length)
  })

  it('第一个源成功时不再碰后面的', async () => {
    // 降级不能变成"每次都把所有源试一遍"，那会把请求数乘以源数。
    const mock = vi.fn(async () => fakeResponse(200, { timezone: 'Asia/Tokyo' }))
    vi.stubGlobal('fetch', mock)

    await probeExitZone()

    expect(mock).toHaveBeenCalledTimes(1)
  })
})

describe('snapshot storage', () => {
  it('returns null when nothing is stored', async () => {
    seedMockStore({})
    expect(await getTimezoneSnapshot()).toBeNull()
  })

  it('round-trips a snapshot', async () => {
    const snapshot: TimezoneSnapshot = {
      zone: 'Asia/Tokyo',
      country: 'JP',
      locale: 'ja-JP',
      exitIp: '103.1.2.3',
      at: 1_700_000_000_000,
      node: 'JP-01',
      error: null,
    }
    await setTimezoneSnapshot(snapshot)

    expect(await getTimezoneSnapshot()).toEqual(snapshot)
  })

  it('survives a corrupted record', async () => {
    // storage 里的东西可能来自旧版本或被手工改坏，它不能让 SW 起不来。
    seedMockStore({ 'lostproxy.timezone': 'not an object' })
    expect(await getTimezoneSnapshot()).toBeNull()
  })

  it('drops a zone that is no longer valid instead of passing it on', async () => {
    seedMockStore({
      'lostproxy.timezone': { zone: 'Mars/Olympus', exitIp: null, at: 1, node: null },
    })

    const snapshot = await getTimezoneSnapshot()

    // zone 归一失败 → null，于是 isSnapshotStale 判为过期 → 下次导航重测。
    expect(snapshot?.zone).toBeNull()
  })
})

describe('hasInjectionPermission', () => {
  it('is false for an empty list', async () => {
    expect(await hasInjectionPermission([])).toBe(false)
  })

  it('is false until the origins are granted', async () => {
    expect(await hasInjectionPermission(['chatgpt.com'])).toBe(false)
  })

  it('is true once every origin is granted', async () => {
    setGrantedOrigins(['*://*.chatgpt.com/*'])
    expect(await hasInjectionPermission(['chatgpt.com'])).toBe(true)
  })

  it('is false when only part of the list is granted', async () => {
    // 部分授权时不注入：装进去一半会让用户以为功能好了，而另一半站点
    // 仍在用真实时区 —— 一个从界面上看不出来的不一致。
    setGrantedOrigins(['*://*.chatgpt.com/*'])
    expect(await hasInjectionPermission(['chatgpt.com', 'claude.ai'])).toBe(false)
  })
})

describe('reinjectOpenTabs', () => {
  it('injects only the tabs whose host is listed', async () => {
    setMockTabs([
      { id: 1, url: 'https://chatgpt.com/c/1' },
      { id: 2, url: 'https://example.com/' },
      { id: 3, url: 'https://www.chatgpt.com/' },
      { id: 4 },
    ])

    const count = await reinjectOpenTabs(['chatgpt.com'], { zone: 'Asia/Tokyo', locale: 'ja-JP' })

    expect(count).toBe(2)
    const calls = readExecuteScriptCalls()
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => (call.target as { tabId: number }).tabId)).toEqual([1, 3])
  })

  it('passes the whole profile as the sole argument to the injected function', async () => {
    setMockTabs([{ id: 7, url: 'https://chatgpt.com/' }])
    await reinjectOpenTabs(['chatgpt.com'], { zone: 'Asia/Tokyo', locale: 'ja-JP' })

    const call = readExecuteScriptCalls()[0]
    expect(call?.args).toEqual([{ zone: 'Asia/Tokyo', locale: 'ja-JP' }])
    // 必须注入到页面自己的执行环境 —— 在隔离环境里改 Date 不会影响页面。
    expect(call?.world).toBe('MAIN')
    expect(call?.injectImmediately).toBe(true)
  })

  it('does nothing for an empty host list', async () => {
    setMockTabs([{ id: 1, url: 'https://chatgpt.com/' }])
    expect(await reinjectOpenTabs([], { zone: 'Asia/Tokyo', locale: 'ja-JP' })).toBe(0)
    expect(readExecuteScriptCalls()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// manifest 与配置声明
// ---------------------------------------------------------------------------

interface ManifestShape {
  version: string
  permissions?: string[]
  host_permissions?: string[]
  optional_host_permissions?: string[]
  browser_specific_settings?: {
    gecko?: {
      data_collection_permissions?: {
        required?: string[]
        optional?: string[]
      }
    }
  }
}

function readJson(relative: string): ManifestShape {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '..', relative), 'utf8')) as ManifestShape
}

describe('数据声明（V0.9）', () => {
  it('🔴 Firefox 声明「默认不传输」，把位置信息放进可选', () => {
    /*
     * 时区同步要经代理请求 ipinfo.io，对方会看到出口 IP —— 那属于
     * locationInfo。但功能**默认关闭**，所以它不能进 required：
     * 那等于让一个永远不用这功能的人在安装时被迫同意传输。
     *
     * `required: ["none"]` + `optional: ["locationInfo"]` 正是 Mozilla
     * 为这种形状准备的两条清单 —— required 表态"不开启就什么都不传"，
     * optional 表态"开启后可能传什么，且用户随时能关"。
     */
    const declaration = readJson('src/manifest.firefox.json').browser_specific_settings?.gecko
      ?.data_collection_permissions

    expect(declaration?.required).toEqual(['none'])
    expect(declaration?.optional).toContain('locationInfo')
  })

  it('Chromium manifest 不带 data_collection_permissions', () => {
    // 那是 Gecko 特有键。写进去不会报错，但它在描述一件 Chromium 不存在的事。
    expect(readJson('src/manifest.json').browser_specific_settings).toBeUndefined()
  })

  it('两个 manifest 都有注入与探测所需的权限', () => {
    for (const path of ['src/manifest.json', 'src/manifest.firefox.json']) {
      const manifest = readJson(path)
      expect(manifest.permissions, path).toContain('scripting')
      // 两个探测源都要有对应权限，否则降级那一条在运行时就是一句空话 ——
      // 第二个源会因为缺权限直接抛错，与"它自己挂了"看起来一模一样。
      expect(manifest.host_permissions, path).toContain('https://ipinfo.io/*')
      expect(manifest.host_permissions, path).toContain('https://ipapi.co/*')
    }
  })

  it('🔴 两个 manifest 都用对了各自平台的 DNR 权限名', () => {
    /*
     * 名称在两个平台不同：Chromium 用 `declarativeNetRequestWithHostAccess`
     * （语义是"只在已有 host 权限时生效"，正是我们要的形状），
     * Firefox 只认 `declarativeNetRequest`。
     *
     * 写错的那个不会报错、不会在 manifest 校验里显形 —— 只是
     * `chrome.declarativeNetRequest` 为 undefined。而 `syncHeaderRules`
     * 把那种情况当成"API 不可用"降级处理，于是功能看起来一切正常，
     * 语言却永远不同步，且没有任何提示。
     */
    expect(readJson('src/manifest.json').permissions).toContain(
      'declarativeNetRequestWithHostAccess',
    )
    expect(readJson('src/manifest.firefox.json').permissions).toContain('declarativeNetRequest')
    // 反过来也该成立：Chromium 那个名字在 Firefox 里并不存在。
    expect(readJson('src/manifest.firefox.json').permissions).not.toContain(
      'declarativeNetRequestWithHostAccess',
    )
  })

  it('🔴 两个 manifest 都把全站注入声明成可选而非必需', () => {
    /*
     * 站点清单可配，所以 manifest 只能说"可能会请求任何站点"。
     * 但它必须落在 optional_host_permissions 里 —— 一旦挪进
     * host_permissions，安装时就会直接索取全站访问权，
     * 而用户可能只想用代理开关、根本不碰时区同步。
     */
    for (const path of ['src/manifest.json', 'src/manifest.firefox.json']) {
      const manifest = readJson(path)
      expect(manifest.host_permissions, path).not.toContain('<all_urls>')
      expect(manifest.optional_host_permissions, path).toContain('<all_urls>')
    }
  })

  it('🔴 Firefox 索权时一并请求数据同意', () => {
    /*
     * 只声明 optional 却不请求，那句声明就是空话：about:addons 里的开关
     * 永远不会亮，用户也没有任何地方能表达同意。Mozilla 的设计是扩展在
     * 安装后通过 permissions.request({ data_collection }) 征得同意 ——
     * 而这是全项目唯一有用户手势的地方。
     */
    const source = readFileSync(resolve(import.meta.dirname, '..', 'src/options/options.ts'), 'utf8')
    expect(source).toContain('data_collection')
    expect(source).toContain("'locationInfo'")
  })

  it('package.json 与两个 manifest 的版本号一致', () => {
    /*
     * `scripts/package.mjs` 在打包时有闸门，但那要等到打 tag。
     * 这条在每次 push 就拦下 —— 三个数字不一致的症状是
     * "发布出来的版本号和应用内显示的版本号对不上"。
     */
    const version = readJson('package.json').version
    expect(readJson('src/manifest.json').version).toBe(version)
    expect(readJson('src/manifest.firefox.json').version).toBe(version)
  })
})

describe('探测域名清单', () => {
  it('🔴 TIMEZONE_PROBE_HOSTS 覆盖了每一个探测 URL', () => {
    /*
     * 两份清单分开写（一处给请求用、一处给路由判断用），所以存在漂移的
     * 可能：加了一个新的探测源却忘了把它的域名加进强制走代理的清单里。
     *
     * 后果是静默的：新源会遵循用户的直连规则，命中时测到本机时区，
     * 而功能会把它当成"出口所在地"注入页面。
     */
    const hosts = new Set(TIMEZONE_PROBE_HOSTS)
    const missing = TIMEZONE_PROBE_URLS.map((url) => new URL(url).hostname).filter(
      (host) => !hosts.has(host),
    )

    expect(missing, `这些探测域名没有进强制走代理的清单：${missing.join(', ')}`).toEqual([])
  })

  it('清单里没有多余项', () => {
    // 反向：删了一个探测源却把域名留着，会让那个域名无条件走代理 ——
    // 用户配了它直连却发现不生效，而且找不到原因。
    const used = new Set(TIMEZONE_PROBE_URLS.map((url) => new URL(url).hostname))
    const extra = TIMEZONE_PROBE_HOSTS.filter((host) => !used.has(host))

    expect(extra, `这些域名已经不再被探测：${extra.join(', ')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 节点缓存（V0.8.0）
// ---------------------------------------------------------------------------

describe('节点缓存', () => {
  const ENTRY = {
    zone: 'Asia/Tokyo',
    country: 'JP',
    locale: 'ja-JP',
    exitIp: '103.1.2.3',
  }

  it('记住之后能查回来', async () => {
    await rememberZone('JP-01', ENTRY)

    const cached = await lookupCachedZone('JP-01')
    expect(cached).toMatchObject(ENTRY)
  })

  it('没记过的节点查不到', async () => {
    expect(await lookupCachedZone('US-99')).toBeNull()
  })

  it('空节点名不写也不查', async () => {
    /*
     * 节点名读不到（Controller 不可达）是常态 —— ADR-23 里那种只用
     * named pipe 的客户端就是这样。这时不能把 `null` 当成一个 key 写进去，
     * 否则所有"读不到节点名"的情况会共用一条缓存，互相覆盖。
     */
    await rememberZone(null, ENTRY)
    await rememberZone('', ENTRY)

    expect(await lookupCachedZone('')).toBeNull()
    const stored = await chrome.storage.local.get('lostproxy.zoneCache')
    expect(stored['lostproxy.zoneCache']).toBeUndefined()
  })

  it('🔴 超过 24 小时就重新探测', async () => {
    /*
     * TTL 存在的理由只有一个：同一个节点名不代表同一个落地 IP。
     * 机场换机器、换线路时名字照旧，而缓存会让旧时区一直生效。
     *
     * 判据是**探测时间**而不是使用时间 —— 按使用时间续期的话，一个
     * 反复切换的节点可以永远不过期。
     */
    seedMockStore({
      'lostproxy.zoneCache': {
        'JP-01': { ...ENTRY, at: Date.now() - 25 * 60 * 60 * 1000 },
      },
    })

    expect(await lookupCachedZone('JP-01')).toBeNull()
  })

  it('24 小时之内仍然命中', async () => {
    seedMockStore({
      'lostproxy.zoneCache': {
        'JP-01': { ...ENTRY, at: Date.now() - 20 * 60 * 60 * 1000 },
      },
    })

    expect(await lookupCachedZone('JP-01')).not.toBeNull()
  })

  it('🔴 读不懂的条目直接丢掉', async () => {
    /*
     * 缓存来自旧版本、也可能被手工改坏。它只是加速手段 ——
     * 一条读不懂就该被忽略，而不是让整个功能起不来。
     */
    seedMockStore({
      'lostproxy.zoneCache': {
        good: { zone: 'Asia/Tokyo', country: 'JP', locale: 'ja-JP', exitIp: null, at: Date.now() },
        badZone: { zone: 'Not/AZone', at: Date.now() },
        noZone: { country: 'JP', at: Date.now() },
        notObject: 'oops',
        nullValue: null,
      },
    })

    expect(await lookupCachedZone('good')).not.toBeNull()
    expect(await lookupCachedZone('badZone')).toBeNull()
    expect(await lookupCachedZone('noZone')).toBeNull()
    expect(await lookupCachedZone('notObject')).toBeNull()
  })

  it('🔴 超过条数上限时淘汰最旧的', async () => {
    const now = Date.now()
    const seed: Record<string, unknown> = {}
    for (let i = 0; i < 30; i++) {
      seed[`N-${i}`] = { ...ENTRY, at: now - i * 60_000 }
    }
    seedMockStore({ 'lostproxy.zoneCache': seed })

    await rememberZone('FRESH', ENTRY)

    const stored = (await chrome.storage.local.get('lostproxy.zoneCache'))['lostproxy.zoneCache'] as
      | Record<string, unknown>
      | undefined
    expect(Object.keys(stored ?? {})).toHaveLength(24)
    // 最新写入的一定在。
    expect(stored?.FRESH).toBeDefined()
    // 最旧的那几条被挤掉了。
    expect(stored?.['N-29']).toBeUndefined()
  })
})
