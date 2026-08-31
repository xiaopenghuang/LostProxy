/**
 * storage 层单元测试。
 *
 * 覆盖重点不只是「读写能通」，还有三条容易被忽略的行为契约：
 *   - 读损坏数据必须回退默认值而不是抛错（SW 不能因为脏数据起不来）
 *   - 校验失败必须**完全不写**，不能留下半保存的配置
 *   - 校验错误信息里绝不能出现 Controller Secret 的内容
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  coerceSettings,
  getEnabledState,
  getLastError,
  getSettings,
  saveSettings,
  setEnabledState,
  setLastError,
  toSettingsView,
  validateSettings,
} from '../src/background/storage'
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../src/shared/constants'
import { errors } from '../src/shared/errors'
import type { Settings } from '../src/shared/types'
import { readMockStore, seedMockStore } from './setup'

describe('coerceSettings', () => {
  it('returns defaults for empty input', () => {
    expect(coerceSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it.each([null, undefined, 'not-an-object', 42, []])(
    'returns defaults for non-object input: %o',
    (input) => {
      expect(coerceSettings(input)).toEqual(DEFAULT_SETTINGS)
    },
  )

  it('keeps valid fields and falls back only on the invalid ones', () => {
    const result = coerceSettings({
      proxyHost: '192.168.1.10',
      proxyPort: 'not-a-number',
      controllerPort: 9999,
    })

    expect(result.proxyHost).toBe('192.168.1.10')
    expect(result.proxyPort).toBe(DEFAULT_SETTINGS.proxyPort)
    expect(result.controllerPort).toBe(9999)
  })

  it('trims whitespace around hosts', () => {
    expect(coerceSettings({ proxyHost: '  127.0.0.1  ' }).proxyHost).toBe('127.0.0.1')
  })

  it('rejects a host that includes a scheme', () => {
    // "http://127.0.0.1" 是极常见的误填，静默接受会让 chrome.proxy 配置变成无效值。
    expect(coerceSettings({ proxyHost: 'http://127.0.0.1' }).proxyHost).toBe(
      DEFAULT_SETTINGS.proxyHost,
    )
  })

  it.each([0, -1, 65536, 1.5, Number.NaN])('rejects out-of-range port: %o', (port) => {
    expect(coerceSettings({ proxyPort: port }).proxyPort).toBe(DEFAULT_SETTINGS.proxyPort)
  })

  it('accepts boundary ports', () => {
    expect(coerceSettings({ proxyPort: 1 }).proxyPort).toBe(1)
    expect(coerceSettings({ proxyPort: 65535 }).proxyPort).toBe(65535)
  })

  it('does not trim the secret', () => {
    // Secret 是凭据，我们无权擅自修改用户输入的内容。
    expect(coerceSettings({ controllerSecret: '  padded  ' }).controllerSecret).toBe('  padded  ')
  })
})

describe('validateSettings', () => {
  it('accepts an empty patch and echoes the base', () => {
    const result = validateSettings({}, DEFAULT_SETTINGS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(DEFAULT_SETTINGS)
  })

  it('merges a partial patch onto the base', () => {
    const result = validateSettings({ proxyPort: 1080 }, DEFAULT_SETTINGS)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.proxyPort).toBe(1080)
      expect(result.value.controllerPort).toBe(DEFAULT_SETTINGS.controllerPort)
    }
  })

  it('rejects an out-of-range port with a translatable issue', () => {
    const result = validateSettings({ proxyPort: 70000 }, DEFAULT_SETTINGS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      // 返回的是 i18n key + 插值参数，而不是成品文案 —— 翻译在 UI 层做。
      expect(result.errors[0]?.key).toBe('validation.proxyPort')
      expect(result.errors[0]?.params).toEqual({ min: 1, max: 65535 })
    }
  })

  it('rejects an invalid language', () => {
    const result = validateSettings({ language: 'klingon' as never }, DEFAULT_SETTINGS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.key).toBe('validation.language')
  })

  it.each(['auto', 'zh', 'en'] as const)('accepts language %s', (language) => {
    const result = validateSettings({ language }, DEFAULT_SETTINGS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.language).toBe(language)
  })

  it('rejects an empty host', () => {
    const result = validateSettings({ controllerHost: '   ' }, DEFAULT_SETTINGS)
    expect(result.ok).toBe(false)
  })

  it('reports every invalid field at once', () => {
    const result = validateSettings(
      { proxyHost: '', proxyPort: -5, controllerHost: 'has space', controllerPort: 0 },
      DEFAULT_SETTINGS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toHaveLength(4)
  })

  it('never leaks the Controller Secret into validation issues', () => {
    // security.md §2.3：校验结果会被翻译后展示给用户，并可能进入日志。
    //
    // ⚠️ 用 JSON.stringify 而不是 join()：issues 现在是对象数组，
    // join() 会得到 "[object Object]" —— 那样断言会永远"通过"却什么都没测。
    // 序列化能同时覆盖 key、params 以及将来可能新增的字段。
    const secret = 'sk-super-secret-token-must-not-leak'
    const result = validateSettings({ controllerSecret: secret, proxyPort: -1 }, DEFAULT_SETTINGS)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(JSON.stringify(result.errors)).not.toContain(secret)
    }
  })
})

describe('getSettings / saveSettings', () => {
  it('returns defaults when storage is empty', async () => {
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips a saved patch', async () => {
    const saved = await saveSettings({ proxyPort: 7891, controllerSecret: 'token' })
    expect(saved.ok).toBe(true)

    const loaded = await getSettings()
    expect(loaded.proxyPort).toBe(7891)
    expect(loaded.controllerSecret).toBe('token')
    // 未提及的字段保持默认值。
    expect(loaded.controllerPort).toBe(DEFAULT_SETTINGS.controllerPort)
  })

  it('persists the secret in local storage only', async () => {
    // tests/setup.ts 让 chrome.storage.sync 一碰就抛错，
    // 因此这个用例能通过本身就证明整条路径没有触碰 sync。
    await saveSettings({ controllerSecret: 'local-only' })

    const raw = readMockStore()
    expect(Object.keys(raw)).toContain(STORAGE_KEYS.settings)
    expect((raw[STORAGE_KEYS.settings] as Settings).controllerSecret).toBe('local-only')
  })

  it('writes nothing when validation fails', async () => {
    await saveSettings({ proxyPort: 7891 })

    const result = await saveSettings({ proxyPort: 999999 })
    expect(result.ok).toBe(false)

    // 关键：storage 必须保持上一次的合法值，不能出现半保存状态。
    const loaded = await getSettings()
    expect(loaded.proxyPort).toBe(7891)
  })

  it('recovers from corrupted stored data', async () => {
    seedMockStore({
      [STORAGE_KEYS.settings]: { proxyHost: 42, proxyPort: 'seven-thousand', junk: true },
    })

    const loaded = await getSettings()
    expect(loaded).toEqual(DEFAULT_SETTINGS)
  })

  it('applies successive patches cumulatively', async () => {
    await saveSettings({ proxyPort: 7891 })
    await saveSettings({ controllerPort: 9091 })

    const loaded = await getSettings()
    expect(loaded.proxyPort).toBe(7891)
    expect(loaded.controllerPort).toBe(9091)
  })
})

describe('getEnabledState / setEnabledState', () => {
  it('defaults to false on a fresh install', async () => {
    // 首次安装不应擅自开启代理。
    await expect(getEnabledState()).resolves.toBe(false)
  })

  it('round-trips true and false', async () => {
    await setEnabledState(true)
    await expect(getEnabledState()).resolves.toBe(true)

    await setEnabledState(false)
    await expect(getEnabledState()).resolves.toBe(false)
  })

  it.each(['true', 1, {}, null])('treats non-boolean stored value %o as false', async (value) => {
    seedMockStore({ [STORAGE_KEYS.enabled]: value })
    await expect(getEnabledState()).resolves.toBe(false)
  })
})

describe('getLastError / setLastError', () => {
  const sample = errors.proxyBlocked()

  it('returns null when nothing has been recorded', async () => {
    await expect(getLastError()).resolves.toBeNull()
  })

  it('round-trips an error', async () => {
    await setLastError(sample)
    await expect(getLastError()).resolves.toEqual(sample)
  })

  it('round-trips the interpolation params', async () => {
    // params 必须存活下来，否则 UI 翻译出的文案会缺掉 host/port。
    const withParams = errors.coreOffline('10.0.0.1', 9097)
    await setLastError(withParams)

    const loaded = await getLastError()
    expect(loaded?.params).toEqual({ host: '10.0.0.1', port: 9097 })
  })

  it('clears the record when given null', async () => {
    await setLastError(sample)
    await setLastError(null)

    await expect(getLastError()).resolves.toBeNull()
    // 清除必须真的把键删掉，而不是留一个 null 值占位。
    expect(Object.keys(readMockStore())).not.toContain(STORAGE_KEYS.lastError)
  })

  it.each(['a string', 42, { code: 'X' }, { message: 'no code' }])(
    'returns null for malformed stored value %o',
    async (value) => {
      // 脏数据不能让 Service Worker 起不来。
      seedMockStore({ [STORAGE_KEYS.lastError]: value })
      await expect(getLastError()).resolves.toBeNull()
    },
  )

  it('discards a pre-i18n record that has no key', async () => {
    // 旧格式只有成品英文文案、没有 i18n key。留着也无法翻译，
    // 不如丢掉——用户下次真的出错时会写入新格式的记录。
    seedMockStore({
      [STORAGE_KEYS.lastError]: { code: 'CORE_OFFLINE', message: 'Core Offline', at: 1 },
    })
    await expect(getLastError()).resolves.toBeNull()
  })

  it('tolerates a missing timestamp', async () => {
    seedMockStore({
      [STORAGE_KEYS.lastError]: { code: 'CORE_OFFLINE', key: 'error.coreOffline' },
    })

    const loaded = await getLastError()
    expect(loaded?.code).toBe('CORE_OFFLINE')
    expect(loaded?.at).toBe(0)
  })
})

describe('toSettingsView', () => {
  const SECRET = 'sk-secret-that-must-not-cross-the-boundary'

  it('reports hasSecret=false when no secret is configured', () => {
    expect(toSettingsView({ ...DEFAULT_SETTINGS, controllerSecret: '' }).hasSecret).toBe(false)
  })

  it('reports hasSecret=true when a secret is configured', () => {
    expect(toSettingsView({ ...DEFAULT_SETTINGS, controllerSecret: SECRET }).hasSecret).toBe(true)
  })

  it('does not carry a controllerSecret key at all', () => {
    // 🔴 security.md §2.1：明文不该越过 background 边界。
    const view = toSettingsView({ ...DEFAULT_SETTINGS, controllerSecret: SECRET })
    expect(Object.keys(view)).not.toContain('controllerSecret')
  })

  it('never leaks the secret even when serialised', () => {
    // 这条比检查键名更强：它能抓住「secret 被拼进某个别的字段」这类错误。
    const view = toSettingsView({ ...DEFAULT_SETTINGS, controllerSecret: SECRET })
    expect(JSON.stringify(view)).not.toContain(SECRET)
  })

  it('passes the non-sensitive fields through unchanged', () => {
    const view = toSettingsView({
      proxyHost: '10.0.0.5',
      proxyPort: 1080,
      controllerHost: '10.0.0.6',
      controllerPort: 9091,
      controllerSecret: SECRET,
      webRtcLockEnabled: false,
      language: 'zh',
    })

    expect(view).toEqual({
      proxyHost: '10.0.0.5',
      proxyPort: 1080,
      controllerHost: '10.0.0.6',
      controllerPort: 9091,
      hasSecret: true,
      webRtcLockEnabled: false,
      language: 'zh',
    })
  })
})

describe('mock guard', () => {
  beforeEach(() => {
    seedMockStore({})
  })

  it('fails loudly if anything touches chrome.storage.sync', async () => {
    // 这条用例锁定护栏本身有效——否则 §2.1 的约束就只是文档里的一句话。
    await expect(chrome.storage.sync.set({ anything: 1 })).rejects.toThrow(/forbidden/)
  })
})
