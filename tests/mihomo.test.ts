/**
 * Mihomo Controller 客户端单元测试。
 *
 * 覆盖重点：
 *   - Secret 只出现在 Authorization 头里，绝不进 URL、绝不进错误文案
 *   - 未配置 secret 时**不发** Authorization 头（技术方案 §15）
 *   - §22 要求的三类错误各自归一化正确
 *   - 探活带超时（Controller 端口被哑服务占用时 UI 不能无限等）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildHeaders,
  controllerBaseUrl,
  extractProtocols,
  getGroups,
  getNodeMeta,
  getProviders,
  getVersion,
  probeControllerPort,
  selectNode,
  updateProvider,
} from '../src/background/mihomo'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { Settings } from '../src/shared/types'

const SECRET = 'sk-mihomo-secret-must-never-leak'

const settings: Settings = { ...DEFAULT_SETTINGS }
const withSecret: Settings = { ...DEFAULT_SETTINGS, controllerSecret: SECRET }

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

let calls: FetchCall[] = []

/** 装一个可控的 fetch，记录调用并返回预设响应。 */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('controllerBaseUrl', () => {
  it('builds a plain http URL', () => {
    expect(controllerBaseUrl(settings)).toBe('http://127.0.0.1:9090')
  })

  it('honours a user-changed host and port', () => {
    expect(
      controllerBaseUrl({ ...settings, controllerHost: '192.168.1.5', controllerPort: 9091 }),
    ).toBe('http://192.168.1.5:9091')
  })

  it('brackets a bare IPv6 literal', () => {
    // 不加方括号的话冒号会被当成端口分隔符解析。
    expect(controllerBaseUrl({ ...settings, controllerHost: '::1' })).toBe('http://[::1]:9090')
  })

  it('does not double-bracket an already bracketed literal', () => {
    expect(controllerBaseUrl({ ...settings, controllerHost: '[::1]' })).toBe('http://[::1]:9090')
  })

  it('never embeds the secret in the URL', () => {
    expect(controllerBaseUrl(withSecret)).not.toContain(SECRET)
  })
})

describe('buildHeaders', () => {
  it('omits Authorization when no secret is configured', () => {
    // 技术方案 §15：Mihomo 未配置 secret 时，
    // 发一个空的 Bearer 头反而可能被判为认证失败。
    expect(buildHeaders('')).toEqual({})
  })

  it('sends a Bearer token when a secret is configured', () => {
    expect(buildHeaders(SECRET)).toEqual({ Authorization: `Bearer ${SECRET}` })
  })
})

describe('getVersion', () => {
  it('returns the version on success', async () => {
    stubFetch(() => jsonResponse({ meta: true, version: 'v1.19.0' }))

    const result = await getVersion(settings)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.version.version).toBe('v1.19.0')
      expect(result.version.meta).toBe(true)
    }
  })

  it('requests GET /version on the configured controller', async () => {
    stubFetch(() => jsonResponse({ meta: true, version: 'v1' }))

    await getVersion(settings)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:9090/version')
    expect(calls[0]?.init?.method).toBe('GET')
  })

  it('attaches an abort signal so a dumb service cannot hang the UI', async () => {
    stubFetch(() => jsonResponse({ meta: true, version: 'v1' }))

    await getVersion(settings)

    expect(calls[0]?.init?.signal).toBeDefined()
  })

  it('tolerates a missing meta field', async () => {
    stubFetch(() => jsonResponse({ version: 'v1.18.0' }))

    const result = await getVersion(settings)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.version.meta).toBe(false)
  })

  it('maps a network failure to CORE_OFFLINE', async () => {
    // 技术方案 §22 Case 1。
    stubFetch(() => Promise.reject(new Error('fetch failed')))

    const result = await getVersion(settings)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CORE_OFFLINE')
      // 文案要带上探测地址：用户改过端口时，不说明探的是哪个地址他无从判断。
      expect(result.error.message).toContain('127.0.0.1:9090')
    }
  })

  it.each([401, 403])('maps HTTP %i to CORE_AUTH_FAILED', async (status) => {
    // 技术方案 §22 Case 2，文案照方案要求。
    stubFetch(() => jsonResponse({ message: 'unauthorized' }, status))

    const result = await getVersion(withSecret)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CORE_AUTH_FAILED')
      expect(result.error.message).toContain('Controller Secret')
    }
  })

  it.each([404, 500, 502])('maps HTTP %i to CORE_BAD_RESPONSE', async (status) => {
    stubFetch(() => new Response('nope', { status }))

    const result = await getVersion(settings)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CORE_BAD_RESPONSE')
  })

  it('maps a 200 non-JSON body to CORE_BAD_RESPONSE', async () => {
    // 端口大概指向了某个网页服务，而不是 external-controller。
    stubFetch(() => new Response('<html>hello</html>', { status: 200 }))

    const result = await getVersion(settings)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CORE_BAD_RESPONSE')
  })

  it.each([{}, { version: 42 }, { version: '' }, null, 'string'])(
    'maps an unexpected payload %o to CORE_BAD_RESPONSE',
    async (payload) => {
      stubFetch(() => jsonResponse(payload))

      const result = await getVersion(settings)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CORE_BAD_RESPONSE')
    },
  )

  describe('secret handling', () => {
    it('sends the secret only in the Authorization header', async () => {
      stubFetch(() => jsonResponse({ meta: true, version: 'v1' }))

      await getVersion(withSecret)

      const call = calls[0]
      expect(call?.url).not.toContain(SECRET)
      expect((call?.init?.headers as Record<string, string>)?.Authorization).toBe(
        `Bearer ${SECRET}`,
      )
    })

    it.each([
      ['network failure', () => Promise.reject(new Error(`connect to ${SECRET} failed`))],
      ['auth failure', () => jsonResponse({ message: SECRET }, 401)],
      ['bad response', () => new Response(SECRET, { status: 500 })],
      ['dirty payload', () => jsonResponse({ leaked: SECRET })],
    ])('never leaks the secret through a %s', async (_label, handler) => {
      // 🔴 security.md §2.3：错误信息会展示给用户并可能进入日志。
      // 注意第一个 case 刻意把 secret 塞进了 Error.message ——
      // 若实现把捕获到的异常直接拼进文案，这条就会炸。
      stubFetch(handler)

      const result = await getVersion(withSecret)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).not.toContain(SECRET)
    })
  })
})

// ===========================================================================
// V0.2 策略组
// ===========================================================================

/** 构造一个 `GET /group` 形状的响应体。 */
function groupsBody(groups: readonly unknown[]): unknown {
  return { proxies: groups }
}

const hkGroup = {
  name: '🇭🇰 香港 | 专线',
  type: 'Selector',
  now: 'HK-01',
  all: ['HK-01', 'HK-02'],
}

describe('getGroups', () => {
  it('parses groups and keeps member order', async () => {
    stubFetch(() => jsonResponse(groupsBody([hkGroup])))

    const result = await getGroups(settings)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]?.name).toBe('🇭🇰 香港 | 专线')
    expect(result.groups[0]?.now).toBe('HK-01')
    // 顺序是内核给的语义顺序，不得重排——用户在 GUI 里看到的就是这个顺序。
    expect(result.groups[0]?.all).toEqual(['HK-01', 'HK-02'])
  })

  it('hits /group rather than /proxies', async () => {
    // /proxies 会返回全部节点（大订阅数百条），/group 只返回策略组。
    stubFetch(() => jsonResponse(groupsBody([])))

    await getGroups(settings)

    expect(calls[0]?.url).toBe('http://127.0.0.1:9090/group')
  })

  it('treats a LoadBalance group without `now` as null rather than failing', async () => {
    // LoadBalance 按连接分摊，没有"当前选中"这个概念。
    stubFetch(() =>
      jsonResponse(groupsBody([{ name: 'LB', type: 'LoadBalance', all: ['A', 'B'] }])),
    )

    const result = await getGroups(settings)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups[0]?.now).toBeNull()
  })

  it('skips malformed entries instead of failing the whole read', async () => {
    // 一个组的字段异常不该让用户连其他正常的组都选不了。
    stubFetch(() =>
      jsonResponse(
        groupsBody([
          hkGroup,
          null,
          { name: 'no-all', type: 'Selector' },
          { type: 'Selector', all: [] },
          { name: 'bad-members', type: 'Selector', all: ['ok', 42] },
        ]),
      ),
    )

    const result = await getGroups(settings)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups.map((g) => g.name)).toEqual(['🇭🇰 香港 | 专线'])
  })

  it('defaults an absent type to Unknown rather than dropping the group', async () => {
    // type 只用于展示，缺了不影响能否切换（判定权在内核，ADR-29）。
    stubFetch(() => jsonResponse(groupsBody([{ name: 'G', all: [] }])))

    const result = await getGroups(settings)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups[0]?.type).toBe('Unknown')
  })

  it.each([
    ['401', 401, 'CORE_AUTH_FAILED'],
    ['403', 403, 'CORE_AUTH_FAILED'],
    ['500', 500, 'CORE_BAD_RESPONSE'],
  ])('maps HTTP %s to %s', async (_label, status, code) => {
    stubFetch(() => jsonResponse({}, status))

    const result = await getGroups(settings)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(code)
  })

  it('maps an unreachable controller to CORE_OFFLINE, not an error state', async () => {
    // ADR-23：连不上是中性状态（named pipe 模式很常见），不是配置错误。
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')))

    const result = await getGroups(settings)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CORE_OFFLINE')
  })

  it.each([
    ['payload is not an object', () => jsonResponse([1, 2, 3])],
    ['proxies is missing', () => jsonResponse({ other: [] })],
    ['proxies is not an array', () => jsonResponse({ proxies: { a: 1 } })],
    ['body is not JSON', () => new Response('<html>nginx</html>', { status: 200 })],
  ])('maps a dirty response (%s) to CORE_BAD_RESPONSE', async (_label, handler) => {
    stubFetch(handler)

    const result = await getGroups(settings)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CORE_BAD_RESPONSE')
  })

  it('sends the secret in the Authorization header only', async () => {
    stubFetch(() => jsonResponse(groupsBody([])))

    await getGroups(withSecret)

    expect(calls[0]?.url).not.toContain(SECRET)
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${SECRET}`)
  })
})

describe('selectNode', () => {
  it('PUTs the node name as JSON', async () => {
    stubFetch(() => new Response(null, { status: 204 }))

    const result = await selectNode(settings, 'Proxy', 'HK-01')

    expect(result.ok).toBe(true)
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(calls[0]?.init?.body).toBe('{"name":"HK-01"}')
  })

  it('accepts 204 No Content as success', async () => {
    // 内核用 render.NoContent 回应，没有响应体。若实现试图 .json() 会炸。
    stubFetch(() => new Response(null, { status: 204 }))

    expect((await selectNode(settings, 'Proxy', 'HK-01')).ok).toBe(true)
  })

  /*
   * 🔴 ADR-30：组名是完全由用户订阅决定的不可信输入，必须 URL 编码。
   *   这四条各锁一类字符。若有人把实现改回模板拼接，这里会立刻炸。
   */
  it.each([
    ['a space', 'My Group', 'My%20Group'],
    ['a pipe', 'HK | Direct', 'HK%20%7C%20Direct'],
    ['emoji', '🇭🇰 香港', '%F0%9F%87%AD%F0%9F%87%B0%20%E9%A6%99%E6%B8%AF'],
    // 最危险的一类：未编码的 `/` 会把一个组名劈成两段路径，命中错误的路由。
    ['a slash', 'a/b', 'a%2Fb'],
  ])('URL-encodes %s in the group name', async (_label, group, encoded) => {
    stubFetch(() => new Response(null, { status: 204 }))

    await selectNode(settings, group, 'node')

    expect(calls[0]?.url).toBe(`http://127.0.0.1:9090/proxies/${encoded}`)
  })

  it('does not encode the node name into the URL at all', async () => {
    // 节点名走 body，不走路径——放进 URL 会重新引入同一类注入面。
    stubFetch(() => new Response(null, { status: 204 }))

    await selectNode(settings, 'Proxy', 'a/b c')

    expect(calls[0]?.url).toBe('http://127.0.0.1:9090/proxies/Proxy')
  })

  it('maps 404 to GROUP_NOT_FOUND and names the group', async () => {
    stubFetch(() => jsonResponse({ message: 'Proxy not found' }, 404))

    const result = await selectNode(settings, 'Gone', 'node')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('GROUP_NOT_FOUND')
    // 不带组名的话，用户不知道我们在找哪个。
    expect(result.error.message).toContain('Gone')
  })

  it('maps 400 Must be a Selector to GROUP_NOT_SELECTABLE', async () => {
    // 判定权在内核（ADR-29）：客户端不预先过滤组类型。
    stubFetch(() => jsonResponse({ message: 'Must be a Selector' }, 400))

    const result = await selectNode(settings, 'Auto', 'node')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('GROUP_NOT_SELECTABLE')
  })

  it('does not put the core error text into the user-facing message', async () => {
    // 内核文本是英文、面向开发者，且我们无法保证它将来不含 URL 之类的内容。
    stubFetch(() => jsonResponse({ message: 'internal detail at http://127.0.0.1:9090' }, 400))

    const result = await selectNode(settings, 'Auto', 'node')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).not.toContain('internal detail')
  })

  it.each([
    ['401', 401, 'CORE_AUTH_FAILED'],
    ['403', 403, 'CORE_AUTH_FAILED'],
    ['500', 500, 'SELECT_FAILED'],
  ])('maps HTTP %s to %s', async (_label, status, code) => {
    stubFetch(() => jsonResponse({}, status))

    const result = await selectNode(settings, 'Proxy', 'HK-01')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(code)
  })

  it('maps an unreachable controller to CORE_OFFLINE', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')))

    const result = await selectNode(settings, 'Proxy', 'HK-01')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CORE_OFFLINE')
  })

  it('never leaks the secret through the URL, the body or an error', async () => {
    stubFetch(() => Promise.reject(new Error(`failed talking to ${SECRET}`)))

    const result = await selectNode(withSecret, 'Proxy', 'HK-01')

    expect(calls[0]?.url).not.toContain(SECRET)
    expect(String(calls[0]?.init?.body)).not.toContain(SECRET)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(JSON.stringify(result.error)).not.toContain(SECRET)
  })

  it('sets Content-Type alongside the Authorization header', async () => {
    stubFetch(() => new Response(null, { status: 204 }))

    await selectNode(withSecret, 'Proxy', 'HK-01')

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Authorization']).toBe(`Bearer ${SECRET}`)
  })
})

// ===========================================================================
// 端口自动探测
// ===========================================================================

describe('probeControllerPort', () => {
  const version = { meta: true, version: 'v1.19.0' }

  it('returns the first port that answers with a mihomo version', async () => {
    stubFetch((url) => (url.includes(':9097') ? jsonResponse(version) : jsonResponse({}, 500)))

    expect(await probeControllerPort(settings, [9090, 9097, 9091])).toBe(9097)
  })

  it('treats 401 as a hit — the port has mihomo, it just needs a secret', async () => {
    /*
     * 对「帮用户找到端口」这个目的来说，需要密钥就是成功：
     * 端口上确实是 mihomo。要求它同时通过认证会让没填密钥的用户
     * 探不到自己明明开着的端口。
     */
    stubFetch((url) => (url.includes(':9097') ? jsonResponse({}, 401) : jsonResponse({}, 500)))

    expect(await probeControllerPort(settings, [9090, 9097])).toBe(9097)
  })

  it('returns null when nothing answers', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')))

    expect(await probeControllerPort(settings, [9090, 9097])).toBeNull()
  })

  it('skips a port serving something that is not mihomo', async () => {
    // 200 但不是 mihomo —— 那个端口上是别的服务，不该被当成命中。
    stubFetch((url) =>
      url.includes(':9090') ? jsonResponse({ hello: 'nginx' }) : jsonResponse(version),
    )

    expect(await probeControllerPort(settings, [9090, 9097])).toBe(9097)
  })

  it('stops at the first hit rather than probing everything', async () => {
    stubFetch(() => jsonResponse(version))

    await probeControllerPort(settings, [9090, 9097, 9091, 9099])

    expect(calls).toHaveLength(1)
  })

  it('only ever talks to the configured host', async () => {
    // 这是"试白名单"而非"扫描机器"的关键区别之一：不改 host。
    stubFetch(() => jsonResponse(version, 500))

    await probeControllerPort(settings, [9090, 9097])

    for (const call of calls) expect(call.url).toContain('127.0.0.1')
  })

  it('never puts the secret in the probe URL', async () => {
    stubFetch(() => jsonResponse({}, 500))

    await probeControllerPort(withSecret, [9090, 9097])

    for (const call of calls) expect(call.url).not.toContain(SECRET)
  })
})

// ===========================================================================
// V0.6 订阅
// ===========================================================================

describe('getProviders', () => {
  const httpProvider = {
    vehicleType: 'HTTP',
    proxies: [{ name: 'a' }, { name: 'b' }],
    updatedAt: '2026-08-31T10:00:00Z',
  }

  it('lists HTTP providers with node counts', async () => {
    stubFetch(() => jsonResponse({ providers: { Airport: httpProvider } }))

    const result = await getProviders(settings)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.providers).toEqual([
      {
        name: 'Airport',
        nodeCount: 2,
        updatedAt: '2026-08-31T10:00:00Z',
        type: 'HTTP',
        updatable: true,
      },
    ])
  })

  it('🔴 lists non-HTTP providers too, flagged as not updatable', async () => {
    /*
     * 早前此方把非 HTTP 的 provider 过滤掉了，结果 Master 在真机上看到
     * 「内核报告没有任何订阅」—— 而他明明有订阅。
     *
     * 根因：Clash Verge 这类客户端会自己把订阅拉下来、展平成 `proxies:`
     * 再交给内核，于是内核里一个 HTTP provider 都没有，只有一个
     * `Compatible` 类型的隐式 provider。过滤之后那句提示技术上正确
     * 但实际误导，读起来像"这功能坏了"。
     *
     * 现在全部列出并标 `updatable`，让 UI 能说清"有这个东西，但不能从这里刷新"。
     */
    stubFetch(() =>
      jsonResponse({
        providers: {
          Remote: httpProvider,
          // 这就是 Verge 用户实际会看到的那一项。
          default: { vehicleType: 'Compatible', proxies: [{ name: 'x' }, { name: 'y' }] },
          Local: { vehicleType: 'File', proxies: [{ name: 'z' }] },
        },
      }),
    )

    const result = await getProviders(settings)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 可更新的排前面 —— 那才是用户到这一栏来想做的事。
    expect(result.providers.map((p) => [p.name, p.updatable])).toEqual([
      ['Remote', true],
      ['Local', false],
      ['default', false],
    ])
  })

  it('🔴 a Verge-style config yields a listed-but-not-updatable entry, not an empty list', async () => {
    // 回归测试：Master 真机报告的那个场景。
    stubFetch(() =>
      jsonResponse({
        providers: { default: { vehicleType: 'Compatible', proxies: [{ name: 'a' }] } },
      }),
    )

    const result = await getProviders(settings)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0]?.updatable).toBe(false)
  })

  it('🔴 never surfaces a subscription URL even if the core starts sending one', async () => {
    /*
     * 内核目前不返回订阅 URL，而「不经手就不会泄漏」正是 ADR-34 乐于接受的
     * 那个限制。这条测试锁住的是：即便将来内核加了这个字段，我们也不读取它。
     */
    stubFetch(() =>
      jsonResponse({
        providers: {
          Airport: { ...httpProvider, subscriptionInfo: 'x', url: 'https://secret.example/sub?t=1' },
        },
      }),
    )

    const result = await getProviders(settings)

    expect(JSON.stringify(result)).not.toContain('secret.example')
  })

  it('tolerates a missing updatedAt', async () => {
    stubFetch(() => jsonResponse({ providers: { A: { vehicleType: 'HTTP', proxies: [] } } }))

    const result = await getProviders(settings)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.providers[0]?.updatedAt).toBeNull()
  })

  it.each([
    ['401', 401, 'CORE_AUTH_FAILED'],
    ['500', 500, 'CORE_BAD_RESPONSE'],
  ])('maps HTTP %s to %s', async (_label, status, code) => {
    stubFetch(() => jsonResponse({}, status))

    const result = await getProviders(settings)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(code)
  })
})

describe('updateProvider', () => {
  it('PUTs to the encoded provider path', async () => {
    stubFetch(() => new Response(null, { status: 204 }))

    const result = await updateProvider(settings, 'My Airport | 主力')

    expect(result.ok).toBe(true)
    expect(calls[0]?.init?.method).toBe('PUT')
    // 订阅名与组名一样是用户数据，同样必须编码（ADR-30）。
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:9090/providers/proxies/${encodeURIComponent('My Airport | 主力')}`,
    )
  })

  it('maps a failure to SUBS_UPDATE_FAILED and names the subscription', async () => {
    stubFetch(() => jsonResponse({}, 500))

    const result = await updateProvider(settings, 'Airport')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('SUBS_UPDATE_FAILED')
    expect(result.error.message).toContain('Airport')
  })
})

describe('extractProtocols（V0.7）', () => {
  it('reads the type of every proxy', () => {
    const out = extractProtocols({
      proxies: {
        'JP-01': { type: 'Vless' },
        'HK-02': { type: 'Hysteria2' },
      },
    })

    expect(out).toEqual({ 'JP-01': 'Vless', 'HK-02': 'Hysteria2' })
  })

  it('🔴 keeps the core wording verbatim instead of abbreviating here', () => {
    /*
     * 缩写是展示偏好（PROTOCOL_LABELS，popup 用）。在这一层缩写会让
     * 「内核说了什么」与「我们决定怎么显示」混成一件事，
     * 将来想在别处按原始 type 判断就没有依据了。
     */
    const out = extractProtocols({ proxies: { A: { type: 'Shadowsocks' } } })

    expect(out['A']).toBe('Shadowsocks')
  })

  it('passes group types through — filtering them needs the group list', () => {
    // 判断某个成员是不是嵌套的组要知道全部组名，那是 orchestrator 的信息。
    const out = extractProtocols({ proxies: { 节点选择: { type: 'Selector' } } })

    expect(out['节点选择']).toBe('Selector')
  })

  it('skips dirty entries rather than failing the whole map', () => {
    const out = extractProtocols({
      proxies: {
        ok: { type: 'Trojan' },
        missing: {},
        wrongType: { type: 42 },
        empty: { type: '' },
        notAnObject: 'nope',
        nulled: null,
      },
    })

    expect(out).toEqual({ ok: 'Trojan' })
  })

  it.each([null, undefined, 42, 'text', {}, { proxies: null }, { proxies: 'x' }])(
    'returns an empty map for a malformed payload (%s)',
    (payload) => {
      expect(extractProtocols(payload)).toEqual({})
    },
  )
})

describe('getNodeMeta（V0.7）', () => {
  it('🔴 gets latency and protocol out of a single request', async () => {
    /*
     * 两者同源。为两个字段拉两遍那份几百条的字典毫无必要 ——
     * 这条断言就是"零额外网络开销"这个说法的凭据（ADR-32）。
     */
    stubFetch(() =>
      jsonResponse({
        proxies: {
          'JP-01': { type: 'Vless', history: [{ delay: 88 }] },
          'HK-02': { type: 'Hysteria2', history: [] },
        },
      }),
    )

    const meta = await getNodeMeta(settings)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:9090/proxies')
    expect(meta.latency).toEqual({ 'JP-01': 88 })
    expect(meta.protocol).toEqual({ 'JP-01': 'Vless', 'HK-02': 'Hysteria2' })
  })

  it('degrades to empty maps instead of throwing when the core is unreachable', async () => {
    // 延迟与协议都是装饰性信息，取不到不该让整个节点列表变成错误页。
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')))

    await expect(getNodeMeta(settings)).resolves.toEqual({ latency: {}, protocol: {} })
  })

  it('degrades to empty maps on a non-OK response', async () => {
    stubFetch(() => jsonResponse({}, 401))

    await expect(getNodeMeta(settings)).resolves.toEqual({ latency: {}, protocol: {} })
  })

  it('🔴 sends the secret in a header, never in the URL', async () => {
    stubFetch(() => jsonResponse({ proxies: {} }))

    await getNodeMeta(withSecret)

    expect(calls[0]?.url).not.toContain(SECRET)
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.['Authorization']).toBe(`Bearer ${SECRET}`)
  })
})
