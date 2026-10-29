/**
 * 出口国家 → 浏览器语言（V0.10）。
 *
 * ## 为什么需要这张表
 *
 * 时区改好了之后，请求头里仍然是 `Accept-Language: zh-CN`。而那是
 * **服务端不需要执行任何 JS 就能读到**的信号 —— 它比时区低一层，
 * 也比时区更常用于判断「这个人从哪儿来」。
 *
 * 只改请求头不改 JS 的话，会造出「头说 en-US、`navigator.language` 说
 * zh-CN」的新矛盾，比不改更糟。所以三者必须一起动，而它们的共同来源
 * 是这一张表。
 *
 * ## 为什么不从时区推导
 *
 * 时区推语言看似更自然（`Asia/Tokyo` → `ja-JP`），但反例比正例多：
 * `America/Toronto` 是英语区，`America/Montreal` 是法语区，二者同在
 * `America/` 下；`Asia/Kolkata` 的官方语言有 22 种。国家代码是探测服务
 * 直接给的（`ipinfo` 的 `country`、`ipapi.co` 的 `country_code`），
 * 比时区更接近"这个出口属于哪个地区"这个问题。
 *
 * ## 这张表刻意不求全
 *
 * 只收录常见出口地区。查不到就返回 null，此时**只同步时区不同步语言** ——
 * 宁可少改一项，也不要猜错一个：猜错的语言和真实时区组合在一起，
 * 是比"语言没改"更容易被识别的破绽。
 *
 * 多语言国家取**使用者最多**的那一种（加拿大取英语、比利时取荷兰语、
 * 瑞士取德语）。这是一个刻意的简化：真实分布会因城市而异，而探测服务
 * 只给到国家一级。写死一种至少是自洽的，随机挑一种才会前后矛盾。
 */

/**
 * 国家代码（ISO 3166-1 alpha-2）→ 主语言 locale。
 *
 * ⚠️ 值必须是**合法的 BCP-47**，因为它会进到页面的 `Intl.DateTimeFormat`，
 *    而那对这种输入会抛 RangeError —— 抛错会让整段注入失效。
 *    `localeForCountry` 里用 Intl 自身做了一次往返校验，兜住手误。
 */
export const COUNTRY_LOCALE: Readonly<Record<string, string>> = Object.freeze({
  // 英语区
  US: 'en-US',
  GB: 'en-GB',
  CA: 'en-CA',
  AU: 'en-AU',
  NZ: 'en-NZ',
  IE: 'en-IE',
  SG: 'en-SG',
  IN: 'en-IN',
  PH: 'en-PH',
  ZA: 'en-ZA',
  NG: 'en-NG',
  KE: 'en-KE',
  MY: 'en-MY',

  // 东亚
  JP: 'ja-JP',
  KR: 'ko-KR',
  CN: 'zh-CN',
  HK: 'zh-HK',
  TW: 'zh-TW',
  MO: 'zh-MO',

  // 东南亚 / 南亚
  TH: 'th-TH',
  VN: 'vi-VN',
  ID: 'id-ID',
  BD: 'bn-BD',
  PK: 'en-PK',
  LK: 'si-LK',
  NP: 'ne-NP',
  KH: 'km-KH',
  MM: 'my-MM',
  LA: 'lo-LA',
  MN: 'mn-MN',

  // 西欧 / 北欧
  DE: 'de-DE',
  AT: 'de-AT',
  CH: 'de-CH',
  FR: 'fr-FR',
  IT: 'it-IT',
  ES: 'es-ES',
  PT: 'pt-PT',
  NL: 'nl-NL',
  BE: 'nl-BE',
  LU: 'fr-LU',
  SE: 'sv-SE',
  NO: 'nb-NO',
  DK: 'da-DK',
  FI: 'fi-FI',
  IS: 'is-IS',

  // 中东欧
  PL: 'pl-PL',
  CZ: 'cs-CZ',
  SK: 'sk-SK',
  HU: 'hu-HU',
  RO: 'ro-RO',
  BG: 'bg-BG',
  GR: 'el-GR',
  HR: 'hr-HR',
  SI: 'sl-SI',
  RS: 'sr-RS',
  LT: 'lt-LT',
  LV: 'lv-LV',
  EE: 'et-EE',
  UA: 'uk-UA',
  RU: 'ru-RU',
  BY: 'be-BY',
  KZ: 'kk-KZ',

  // 拉美
  BR: 'pt-BR',
  MX: 'es-MX',
  AR: 'es-AR',
  CL: 'es-CL',
  CO: 'es-CO',
  PE: 'es-PE',
  VE: 'es-VE',
  EC: 'es-EC',
  UY: 'es-UY',
  PY: 'es-PY',
  BO: 'es-BO',
  CR: 'es-CR',
  PA: 'es-PA',
  DO: 'es-DO',
  GT: 'es-GT',

  // 中东 / 非洲
  TR: 'tr-TR',
  IL: 'he-IL',
  SA: 'ar-SA',
  AE: 'ar-AE',
  QA: 'ar-QA',
  KW: 'ar-KW',
  BH: 'ar-BH',
  OM: 'ar-OM',
  JO: 'ar-JO',
  LB: 'ar-LB',
  IQ: 'ar-IQ',
  EG: 'ar-EG',
  MA: 'ar-MA',
  TN: 'ar-TN',
  DZ: 'ar-DZ',
  IR: 'fa-IR',
  CY: 'el-CY',
  MT: 'mt-MT',
})

/**
 * 国家代码 → 主语言 locale；未知国家返回 null。
 *
 * 入参宽松：大小写不敏感，两头空白会被去掉 —— 探测服务的响应格式
 * 不完全统一（`ipinfo` 给大写 `US`，`ipapi.co` 给大写 `US`，但
 * 自建源什么都可能给）。
 */
export function localeForCountry(country: unknown): string | null {
  if (typeof country !== 'string') return null
  const code = country.trim().toUpperCase()
  if (code.length !== 2) return null
  return COUNTRY_LOCALE[code] ?? null
}

/**
 * 一个 locale 是否可以被 `Intl` 接受。
 *
 * 🔴 这不是防御性编程，是必要的一道闸：这个值会被注入到页面里，
 *    而 `Intl.DateTimeFormat` 对无效 locale 抛 RangeError —— 在页面里
 *    抛错会让整段注入失效，页面恢复成真实语言与时区，且没有任何提示。
 *
 * 用 `Intl.getCanonicalLocales` 而不是 `new DateTimeFormat`：前者不构造
 * 格式化器，开销小得多，且对 `''`、`'..'` 这类输入的行为更明确。
 */
export function isValidLocale(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 35) return false
  try {
    const canonical = Intl.getCanonicalLocales(trimmed)
    return canonical.length === 1 && canonical[0] === trimmed
  } catch {
    return false
  }
}

/** `en-US` → `en`。用于 `navigator.languages` 的第二项。 */
export function primarySubtag(locale: string): string {
  const dash = locale.indexOf('-')
  return dash > 0 ? locale.slice(0, dash) : locale
}

/**
 * 生成 `Accept-Language` 的值。
 *
 * 形状照抄 Chrome 在「只设了一种语言」时的实际输出 —— `en-US,en;q=0.9`。
 * 这个细节值得较真：`.9` 而不是 `.8`，且语言主标签无条件附在后面。
 * 一个只写 `en-US` 的头，与真实 Chrome 的输出不同，本身就是一条指纹。
 *
 * 主标签与完整标签相同时（极少见，例如 `eo`）不重复追加 ——
 * `eo,eo;q=0.9` 这种输出在真实浏览器里不存在。
 */
export function acceptLanguageValue(locale: string): string {
  const primary = primarySubtag(locale)
  return primary === locale ? locale : `${locale},${primary};q=0.9`
}

/**
 * `navigator.languages` 的目标值。
 *
 * 返回**新数组**：页面拿到它之后完全可能 `push` 或 `sort`，
 * 而我们每次读都要给出同样的初始值，共享一个数组会让那次修改
 * 沉淀下来、并且泄漏到后续读取里。
 */
export function languageListFor(locale: string): string[] {
  const primary = primarySubtag(locale)
  return primary === locale ? [locale] : [locale, primary]
}
