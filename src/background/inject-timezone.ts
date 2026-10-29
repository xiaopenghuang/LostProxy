/**
 * 页面侧的地理身份注入（V0.10）。
 *
 * ## 这个文件最要紧的一条约束
 *
 * `installIdentity` 会被 `chrome.scripting.executeScript` **序列化**到页面里执行
 * （`func` 走的是 `Function.prototype.toString`，不是闭包）。因此它必须
 * **完全自包含**：
 *
 *   - 不能引用本文件之外的任何标识符（打包后可能被重命名，或根本不在页面上）；
 *   - 不能引用本文件内的其他顶层函数（同样不会一起被序列化）；
 *   - 不能用 import 进来的类型以外的运行时值（类型会在编译时消失，没问题）。
 *
 * 违反的后果不是编译错误，而是运行时 `ReferenceError` —— 注入整体失效，
 * 页面恢复真实时区，而且**没有任何提示**。`tests/identity-inject.test.ts`
 * 用「把函数 toString 出来在干净上下文里跑」来守这条。
 *
 * ⚠️ 这条约束也意味着 `shared/locales.ts` 里的 `languageListFor` 之类
 *    **不能在页面里调用**，同样的逻辑必须在下面重新写一遍。看起来是重复，
 *    但它守的是一条会静默失效的边界。
 *
 * ## 为什么要改这么多方法
 *
 * 时区在 JS 里不是变量，是一堆互相独立的入口。漏掉任何一个，页面就能从
 * 那个口子读回真实时区，而两个入口的答案不一致本身就比"没伪装"更可疑。
 * 需要同时覆盖：
 *
 *   - `getTimezoneOffset` —— 最常被检测的一个
 *   - `getHours` / `getMinutes` / … —— 本地时间 getter，**最容易漏**
 *   - `toString` / `toTimeString` / `toDateString` —— 字符串里带 GMT+0800
 *   - `toLocaleString` 三兄弟 —— 走 Intl，但有自己的默认时区
 *   - `Intl.DateTimeFormat` —— `resolvedOptions().timeZone` 的出口
 *
 * 语言侧同理，而且它和时区**必须一起改**：
 *
 *   - `navigator.language` / `navigator.languages`
 *   - `Intl.DateTimeFormat` 的默认 locale —— 它连带决定了
 *     `toLocaleString()` 是 `2026/10/29` 还是 `10/29/2026`、
 *     是 24 小时制还是 12 小时制。只改 `navigator.language` 不改这里，
 *     页面上的日期格式会依然是中国习惯，那是比不改更明显的破绽。
 *
 * ## 不覆盖的部分（有意）
 *
 *   - `Date.parse` / `new Date("...")` 对**无时区字符串**的解析：规范规定
 *     按本地时区解释，而这一层在引擎里，JS 改不了。影响面很小。
 *   - `setHours` 一类的 setter：页面极少用，且实现它们要处理 DST 边界，
 *     出错的方式比不实现更糟。
 *   - **Worker**：Worker 是独立执行环境，主线程的 patch 不进去。
 *     要覆盖得拦截 `Worker` / `SharedWorker` 构造并改写脚本源码，
 *     那是另一个量级的复杂度，当前版本没有做。
 *   - `Intl.NumberFormat` / `Collator` 的默认 locale：它们与"在哪儿"
 *     关系很弱（货币、排序规则），而改动面更大 —— 页面可能拿
 *     `resolvedOptions().locale` 做字符串比较。当前版本只动时间相关的那个。
 */

/** 注入的目标档案。两个字段来自同一次探测，必须一起生效。 */
export interface SpoofProfile {
  /** IANA 时区名，如 `Asia/Tokyo`。调用方必须已用 `normalizeZone` 校验过。 */
  readonly zone: string
  /**
   * 目标语言，如 `en-US`；null 表示这个出口国家不在映射表里。
   *
   * ⚠️ 为 null 时**只改时区，不动语言**。改一半（比如硬塞一个 `en-US`）
   *    会让「新加坡节点 + 英文」这类组合看起来正常，而「某个冷门国家 +
   *    英文」则是没有真实用户会有的组合。
   */
  readonly locale: string | null
}

/**
 * 把地理身份装进当前页面。
 *
 * 幂等：同一份档案重复调用直接返回；档案变了则更新已有状态而不重复包装
 * （重复包装会让 `Intl.DateTimeFormat` 被套多层 Proxy，`toString` 也会
 * 逐层退化）。
 *
 * @param profile 时区与语言。两者由调用方从同一次探测结果推导出来。
 */
export function installIdentity(profile: SpoofProfile): void {
  const root = globalThis as unknown as Record<string, unknown>
  /*
   * 键名沿用 V0.9 的 `__lostproxyTimezoneState`：它只在同一个页面内
   * 用来判断"装过没有"。换名字会让升级后已打开的页面被重新包装一次，
   * 而重装会把已经被 Proxy 包过的 `Intl.DateTimeFormat` 再包一层。
   */
  const KEY = '__lostproxyTimezoneState'

  const installed = root[KEY] as { zone: string; locale: string | null } | undefined
  if (installed !== undefined) {
    /*
     * 已经装过：只更新档案，patch 内部都通过 `state` 读值，所以立刻生效。
     *
     * ⚠️ 如果是 V0.9 注入过、页面还没刷新的情况，这里会把 `locale` 补进
     *    状态对象，但**旧 patch 并不读它** —— 语言要等下一次导航才生效。
     *    这是刻意接受的边界：唯一的替代是清掉状态重新包装，而那会让
     *    `Intl.DateTimeFormat` 套上第二层 Proxy。
     */
    installed.zone = profile.zone
    installed.locale = profile.locale
    return
  }

  const state = { zone: profile.zone, locale: profile.locale }
  root[KEY] = state

  const NativeDate = Date
  const NativeDTF = Intl.DateTimeFormat

  /*
   * 月份短名 → 索引。
   *
   * formatter 固定用 'en-US'，所以这里只需要英文缩写；换成跟随页面语言的话
   * 一张表装不下（阿拉伯语、日语都不同），而表格一旦不全就会把月份算错。
   */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  function monthIndex(name: string): number {
    const i = MONTHS.indexOf(name.slice(0, 3))
    return i === -1 ? 0 : i
  }

  function pad(value: number, width: number): string {
    let text = String(Math.abs(value))
    while (text.length < width) text = '0' + text
    return text
  }

  /*
   * formatter 实例复用：`new Intl.DateTimeFormat` 是这里最贵的一步，
   * 而页面可能在一个循环里对上千个日期调 getHours()。zone 变了才重建。
   */
  let formatter: Intl.DateTimeFormat | null = null
  let formatterZone = ''

  let cachedSecond = NaN
  let cachedParts: Record<string, string> | null = null

  /**
   * 目标时区在某一秒的日期分量。
   *
   * 按秒缓存：同一秒内的多次 getter 调用只会真正格式化一次，
   * 而秒级粒度不会跨过任何 DST 边界（DST 以小时为单位跳变）。
   */
  function partsAt(time: number): Record<string, string> | null {
    /*
     * 用 `Number.isFinite` 而不是全局 `isFinite`：后者会先做类型转换，
     * 对 `null`、`''` 这类值返回 true。这里 `time` 声明为 number，
     * 但注入函数是**被序列化后在页面里重建**的，签名约束不跟着走 ——
     * 页面代码完全可能绕过 TS 传进来别的类型。
     */
    if (!Number.isFinite(time)) return null

    const second = Math.floor(time / 1000)
    if (second === cachedSecond && cachedParts !== null) return cachedParts

    if (formatter === null || formatterZone !== state.zone) {
      formatter = new NativeDTF('en-US', {
        timeZone: state.zone,
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'long',
      })
      formatterZone = state.zone
    }

    const raw = formatter.formatToParts(new NativeDate(second * 1000))
    const map: Record<string, string> = {}
    for (let i = 0; i < raw.length; i++) {
      const part = raw[i]
      if (part !== undefined && part.type !== 'literal') map[part.type] = part.value
    }

    cachedSecond = second
    cachedParts = map
    return map
  }

  /**
   * 目标时区的 UTC 偏移（分钟），符号与 `getTimezoneOffset()` 一致。
   *
   * 算法：把"目标时区的本地日期时间"当成 UTC 解一次，再与真实时间戳相减。
   * 差值就是偏移，取负得到 `getTimezoneOffset` 的约定（UTC − local）。
   *
   * 🔴 必须逐时刻计算而不是算一次存下来：有 DST 的时区一年里会有两个
   *    不同的偏移，固定值在切换后的那半年全是错的。
   */
  function offsetAt(time: number): number {
    const parts = partsAt(time)
    if (parts === null) return NaN

    const second = Math.floor(time / 1000) * 1000
    const asUTC = NativeDate.UTC(
      Number(parts.year),
      monthIndex(parts.month),
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )
    const offset = -Math.round((asUTC - second) / 60000)
    /*
     * 归一负零：偏移为 0 的时区（UTC、伦敦冬令时）会算出 `-0`，
     * 而 `Object.is(-0, 0)` 是 `false`。原生 `getTimezoneOffset()` 给的是
     * 正零，所以留着负零等于留了一个「这个值被算过」的指纹 ——
     * 一个只靠一次比较就能区分真实与伪造的破绽。
     */
    return offset === 0 ? 0 : offset
  }

  /** `GMT+0900` 这一段。 */
  function gmtLabel(time: number): string {
    const offset = offsetAt(time)
    const sign = offset <= 0 ? '+' : '-'
    const abs = Math.abs(offset)
    return 'GMT' + sign + pad(Math.floor(abs / 60), 2) + pad(abs % 60, 2)
  }

  // -------------------------------------------------------------------------
  // navigator：语言
  // -------------------------------------------------------------------------

  /*
   * 语言不是"顺便一起改"的第二项，它和时区是同一件事的两面：
   * 服务端从 `Accept-Language` 头看到的语言，必须和页面里读到的语言一致，
   * 否则我们只是把矛盾从一个地方挪到了另一个地方 —— 而后一种更好识别，
   * 因为对照起来只需要一次请求加一次 JS 执行。
   *
   * 这里只改主线程的 `navigator`。`Accept-Language` 由 background 侧用
   * DNR 规则改，JS 碰不到请求头。
   */
  const hasNavigator = typeof navigator !== 'undefined'
  const nativeLanguage = hasNavigator ? navigator.language : 'en-US'
  const nativeLanguages = hasNavigator ? navigator.languages.slice() : ['en-US']

  /**
   * `navigator.languages` 的目标值。
   *
   * 每次返回**新数组**：页面拿到它之后完全可能 `push` 或 `sort`，
   * 共享同一个实例会让那次修改沉淀下来、并泄漏到后续的每次读取里。
   * 原生 getter 每次也给新数组，这里必须一致。
   */
  function targetLanguages(): string[] {
    const locale = state.locale
    if (locale === null) return nativeLanguages.slice()
    const dash = locale.indexOf('-')
    if (dash <= 0) return [locale]
    const primary = locale.slice(0, dash)
    return primary === locale ? [locale] : [locale, primary]
  }

  if (hasNavigator) {
    /*
     * 改原型而不是实例：页面可以绕过实例直接读
     * `Object.getOwnPropertyDescriptor(Navigator.prototype, 'language').get`，
     * 只改实例会留下这个口子。
     */
    const proto = Object.getPrototypeOf(navigator) as object
    try {
      Object.defineProperty(proto, 'language', {
        configurable: true,
        enumerable: true,
        get(): string {
          return state.locale === null ? nativeLanguage : state.locale
        },
      })
      Object.defineProperty(proto, 'languages', {
        configurable: true,
        enumerable: true,
        get(): string[] {
          return targetLanguages()
        },
      })
    } catch {
      /*
       * 原型被冻结、或属性已被别人定义成不可配置时（另一个扩展可能
       * 干过同样的事），跳过语言、让时区继续生效。
       *
       * 因为语言装不上就整体失效是更差的结果：时区是用户明确开启的那一项，
       * 语言是配套的。
       */
    }
  }

  // -------------------------------------------------------------------------
  // Date：偏移与本地时间 getter
  // -------------------------------------------------------------------------

  NativeDate.prototype.getTimezoneOffset = function (this: Date): number {
    return offsetAt(this.getTime())
  }

  NativeDate.prototype.getFullYear = function (this: Date): number {
    const parts = partsAt(this.getTime())
    return parts === null ? NaN : Number(parts.year)
  }

  NativeDate.prototype.getMonth = function (this: Date): number {
    const parts = partsAt(this.getTime())
    return parts === null ? NaN : monthIndex(parts.month)
  }

  NativeDate.prototype.getDate = function (this: Date): number {
    const parts = partsAt(this.getTime())
    return parts === null ? NaN : Number(parts.day)
  }

  NativeDate.prototype.getHours = function (this: Date): number {
    const parts = partsAt(this.getTime())
    return parts === null ? NaN : Number(parts.hour)
  }

  NativeDate.prototype.getMinutes = function (this: Date): number {
    const parts = partsAt(this.getTime())
    return parts === null ? NaN : Number(parts.minute)
  }

  NativeDate.prototype.getSeconds = function (this: Date): number {
    const parts = partsAt(this.getTime())
    return parts === null ? NaN : Number(parts.second)
  }

  NativeDate.prototype.getDay = function (this: Date): number {
    const parts = partsAt(this.getTime())
    if (parts === null) return NaN
    const midnight = NativeDate.UTC(Number(parts.year), monthIndex(parts.month), Number(parts.day))
    return new NativeDate(midnight).getUTCDay()
  }

  // -------------------------------------------------------------------------
  // Date：字符串形式
  // -------------------------------------------------------------------------

  NativeDate.prototype.toString = function (this: Date): string {
    const time = this.getTime()
    const parts = partsAt(time)
    if (parts === null) return 'Invalid Date'
    return (
      parts.weekday +
      ' ' +
      parts.month +
      ' ' +
      parts.day +
      ' ' +
      parts.year +
      ' ' +
      parts.hour +
      ':' +
      parts.minute +
      ':' +
      parts.second +
      ' ' +
      gmtLabel(time) +
      ' (' +
      (parts.timeZoneName !== undefined ? parts.timeZoneName : state.zone) +
      ')'
    )
  }

  NativeDate.prototype.toTimeString = function (this: Date): string {
    const time = this.getTime()
    const parts = partsAt(time)
    if (parts === null) return 'Invalid Date'
    return (
      parts.hour +
      ':' +
      parts.minute +
      ':' +
      parts.second +
      ' ' +
      gmtLabel(time) +
      ' (' +
      (parts.timeZoneName !== undefined ? parts.timeZoneName : state.zone) +
      ')'
    )
  }

  NativeDate.prototype.toDateString = function (this: Date): string {
    const parts = partsAt(this.getTime())
    if (parts === null) return 'Invalid Date'
    return parts.weekday + ' ' + parts.month + ' ' + parts.day + ' ' + parts.year
  }

  /*
   * toLocale* 三兄弟：原生实现走自己的 Intl 路径，不受我们对
   * `Intl.DateTimeFormat` 的替换影响，必须显式补上 timeZone。
   *
   * 🔴 `defaults` 不能省。`new Intl.DateTimeFormat(locales, {timeZone})`
   *    只给日期 —— 因为没有任何字段被请求。而 `toLocaleString()` 的原生
   *    语义是「日期 + 时间」，缺了默认字段会让它退化成 `toLocaleDateString`，
   *    时间部分凭空消失。三兄弟的默认字段集各不相同，所以必须各传一份。
   *
   * 用户显式传了 timeZone 就尊重他 —— 那是页面在问"东京现在几点"，
   * 与"页面以为自己在哪"是两件事。
   */
  function localeOptions(
    defaults: Intl.DateTimeFormatOptions,
    options?: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormatOptions {
    if (options !== undefined && options.timeZone !== undefined) return options

    const source =
      options !== undefined
        ? (options as Record<string, unknown>)
        : (defaults as Record<string, unknown>)

    const merged: Record<string, unknown> = {}
    for (const key in source) {
      merged[key] = source[key]
    }
    merged.timeZone = state.zone
    return merged as Intl.DateTimeFormatOptions
  }

  /**
   * 决定这次格式化用什么语言。
   *
   * 页面显式传了就尊重 —— 那可能是它在问"用英文格式给我看"，与
   * "页面以为自己在哪"是两件事。这与 timeZone 的处理是同一条原则：
   * 用户的显式意图优先于我们的伪装。
   */
  function pickLocales(locales?: string | string[]): string | string[] | undefined {
    if (locales !== undefined) return locales
    return state.locale === null ? undefined : state.locale
  }

  NativeDate.prototype.toLocaleString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ): string {
    return new NativeDTF(
      pickLocales(locales),
      localeOptions(
        {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        },
        options,
      ),
    ).format(this)
  }

  NativeDate.prototype.toLocaleDateString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ): string {
    return new NativeDTF(
      pickLocales(locales),
      localeOptions({ year: 'numeric', month: 'numeric', day: 'numeric' }, options),
    ).format(this)
  }

  NativeDate.prototype.toLocaleTimeString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ): string {
    return new NativeDTF(
      pickLocales(locales),
      localeOptions({ hour: 'numeric', minute: 'numeric', second: 'numeric' }, options),
    ).format(this)
  }

  // -------------------------------------------------------------------------
  // Intl.DateTimeFormat
  // -------------------------------------------------------------------------

  /**
   * 给 `Intl.DateTimeFormat` 补上 timeZone。
   *
   * 这里传**空默认字段集**：构造函数的原生语义就是「你不说，我就只给日期」，
   * 加任何默认字段都会改变页面的输出。
   */
  function withZone(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
    return localeOptions({}, options)
  }

  /*
   * 用 Proxy 而不是包一层函数：Proxy 会把 `prototype`、`supportedLocalesOf`
   * 等属性一并转发，所以 `instanceof`、`Intl.DateTimeFormat.prototype.format.call`
   * 这些页面里真实存在的用法都还能工作。手写的包装函数做不到这一点，
   * 而且 `Function.prototype.toString` 会暴露出我们的包装源码。
   *
   * 两个参数都接管：timeZone 决定"几点"，locale 决定"怎么写法"。
   * 后者同样是指纹 —— 一个洛杉矶用户的日期不会写成 `2026/10/29`。
   */
  const PatchedDateTimeFormat = new Proxy(NativeDTF, {
    construct(target, args: unknown[]) {
      return Reflect.construct(target, [
        pickLocales(args[0] as string | string[] | undefined),
        withZone(args[1] as Intl.DateTimeFormatOptions),
      ])
    },
    apply(target, thisArg, args: unknown[]) {
      return Reflect.apply(target, thisArg, [
        pickLocales(args[0] as string | string[] | undefined),
        withZone(args[1] as Intl.DateTimeFormatOptions),
      ])
    },
  })

  Intl.DateTimeFormat = PatchedDateTimeFormat
}
