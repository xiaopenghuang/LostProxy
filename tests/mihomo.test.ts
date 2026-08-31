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
import { buildHeaders, controllerBaseUrl, getVersion } from '../src/background/mihomo'
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
