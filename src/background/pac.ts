/**
 * PAC 脚本生成（V0.4）。
 *
 * 🔴 本文件是整个项目**唯一**把用户输入变成可执行代码的地方，
 *    因此也是唯一的代码注入面。security.md §4.1 / architecture.md ADR-33
 *    记录了完整推理，这里只重复三条不可动摇的规则：
 *
 *    1. 规则列表用 `JSON.stringify` 序列化成**数据**（数组字面量），
 *       脚本内部用查表逻辑判断。**禁止**把规则拼进脚本的控制流。
 *    2. 每条规则必须先过 `RULE_ALLOWED_PATTERN` 白名单。
 *       调用方（storage 的 validateSettings）负责拦，本文件再兜一次底 ——
 *       两道都要，因为这里是最后一关。
 *    3. 写入 chrome.proxy 时必须 `mandatory: true`。
 *
 *    为什么这么谨慎：注入成功的后果是生成一个「一切都直连」的脚本，
 *    它**语法完全合法**，`mandatory` 拦不住，浏览器不会报任何错，
 *    而用户以为自己配了分流。这是本项目所有失败模式里最坏的一种 ——
 *    静默、且正好发生在用户以为受保护的时候。
 *
 * ## 为什么这个文件没有搬进 platform/
 *
 * `buildPacScript` 确实只有 Chromium 用得上 —— Firefox 的 `proxy.settings`
 * **只支持 `autoConfigUrl`，不支持内联 PAC**，那边要用 `proxy.onRequest`
 * 直接拿规则做判断（顺带把这里的注入面整个消掉）。
 *
 * 但 `sanitizeRule` / `sanitizeRules` 是**跨平台**的：它们校验的是用户输入，
 * `storage.ts` 的 `validateSettings` 也在用，而 Firefox 那条路同样需要
 * 先把规则洗干净再用。把整个文件搬进 `platform/chromium.ts` 会让共享的
 * 校验逻辑被锁在一个平台目录里，将来只能靠跨平台 import 绕回来 ——
 * 那比留在这里更难读。
 */

import { RULE_ALLOWED_PATTERN, LOOPBACK_HOSTS } from '../shared/constants'

/**
 * 把一条规则转成 PAC 里可比较的形式。
 *
 * 返回 null 表示该规则不合法，调用方应当丢弃它而不是原样传下去。
 */
export function sanitizeRule(rule: string): string | null {
  const trimmed = rule.trim().toLowerCase()
  if (trimmed.length === 0) return null

  const ascii = toPunycode(trimmed)
  if (ascii === null) return null

  // 🔴 白名单**作用在转换结果上**，而不是原始输入上。
  //    这样 IDN 支持没有放松最后这道闸门：任何绕过 toPunycode 的东西
  //    仍然要过这条严格的 ASCII 白名单。
  if (!RULE_ALLOWED_PATTERN.test(ascii)) return null
  return ascii
}

/**
 * 是否含非 ASCII 字符。
 *
 * 用码位判断而不是正则的「非 ASCII」字符类。后者写起来要嵌一个码位区间，
 * 而那种写法经过多层转义之后很容易塌成一个字面控制字符 ——
 * 此方刚踩过一次，结果整个文件对 git 而言变成了二进制。
 */
function hasNonAscii(text: string): boolean {
  return [...text].some((c) => c.charCodeAt(0) > 127)
}

/**
 * 把含非 ASCII 的域名转成 Punycode。
 *
 * 为什么需要：Chromium 拒绝非 ASCII 的 `pacScript.data`，错误文本明确要求
 * "encode URLs in Punycode format"。让用户自己去找一个 Punycode 转换器
 * 是把我们的实现约束推给用户 —— 而浏览器自带的 `URL` 就能做这件事。
 *
 * 例：`*.清华.edu.cn` → `*.xn--xkrp53d.edu.cn`
 *
 * 已是 ASCII 的输入原样返回（绝大多数情况），不白走一次 URL 解析。
 *
 * ⚠️ 这个函数**不承担安全职责**。它可能对敌意输入产出百分号编码之类的东西，
 *    拦截它们的是调用方紧接着的白名单检查。此方刻意把「转换」与「校验」
 *    分成两步，而不是让 URL 解析兼任过滤器 —— 依赖一个通用解析器做安全过滤
 *    是典型的错位。
 */
function toPunycode(host: string): string | null {
  // 已是纯 ASCII 就原样返回（绝大多数情况），不白走一次 URL 解析。
  if (!hasNonAscii(host)) return host

  /*
   * 🔴 先拒结构性字符，再交给 URL 解析。
   *
   * `new URL()` 会**静默丢弃**路径、端口、查询串：
   *   `http://清华.edu.cn/path` → hostname `xn--xkrp53d.edu.cn`
   * 于是 `清华.edu.cn/path` 会被当成"整个域名直连"接受，
   * 而纯 ASCII 的 `example.com/path` 早就被白名单拒了 ——
   * IDN 输入走了一条更松的路，两者不一致。
   *
   * 这不构成注入（结果是个干净的主机名），但它是**静默的作用域扩大**：
   * 用户写的是一个路径，我们给他配了整个域名直连。对直连清单来说，
   * 作用域变大意味着比他要求的更多流量绕过了代理 —— 那是隐私相关的意外，
   * 不是体验瑕疵。所以宁可拒绝，让他自己改成域名。
   */
  if (/[/:?#@\\[\]]/.test(host)) return null

  // 通配符前缀不是域名的一部分，得摘下来再转。
  const wildcard = host.startsWith('*.')
  const bare = wildcard ? host.slice(2) : host

  try {
    const converted = new URL(`http://${bare}`).hostname
    if (converted.length === 0) return null
    return wildcard ? `*.${converted}` : converted
  } catch {
    // 不是一个能解析的主机名 —— 交给调用方按"非法规则"处理。
    return null
  }
}

/** 过滤出全部合法规则，去重并保持原顺序。 */
export function sanitizeRules(rules: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const rule of rules) {
    const clean = sanitizeRule(rule)
    if (clean === null || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/**
 * 一个主机名该直连还是走代理。
 *
 * 🔴 **这是分流判定的唯一真源**，两个平台共用：
 *
 *   - Chromium：`buildPacScript` 把它的逻辑**复刻**进生成的 PAC 脚本
 *     （PAC 在浏览器的独立 JS 环境里跑，没法直接调我们的函数）
 *   - Firefox：`platform/firefox.ts` 的 `proxy.onRequest` 监听**直接调它**
 *
 * 「复刻」是个真实的风险 —— 两份实现可能漂移，而漂移的后果是同一条规则
 * 在两个浏览器上行为不同。所以 `tests/pac.test.ts` 里有一组测试
 * 拿同一批 host 同时喂给**本函数**和**执行生成脚本**的结果，
 * 逐个比对两者是否一致。那组测试是这个复刻关系的安全带。
 *
 * 匹配语义（只有这两种）：
 *   - `*.edu.cn`    → 后缀匹配（`a.edu.cn` 与 `edu.cn` 都算命中）
 *   - `lib.foo.edu` → 精确匹配
 *
 * 更复杂的（正则、IP 段、端口）留给内核的规则系统去做，它本来就比我们擅长。
 *
 * @param host 主机名。调用方无需预先小写化，本函数自己处理。
 * @param rules **已清洗过**的规则（`sanitizeRules` 的输出）。
 *   刻意收清洗后的而不是原始清单：这个函数会被每个请求调用一次，
 *   把清洗放进来意味着每次请求都重跑一遍白名单与 Punycode 转换。
 */
export function shouldBypassProxy(host: string, rules: readonly string[]): boolean {
  const lower = host.toLowerCase()

  // 本机与无点主机名直连 —— 与 bypass 清单保持一致（ADR-02）。
  // 否则扩展访问 Controller 的请求会被送进代理形成自环。
  if (lower === 'localhost' || !lower.includes('.')) return true
  for (const local of LOOPBACK_HOSTS) {
    if (lower === local) return true
  }

  for (const rule of rules) {
    if (rule.startsWith('*.')) {
      // `*.edu.cn` → 后缀 `.edu.cn`，同时命中裸域 `edu.cn`。
      const suffix = rule.slice(1)
      if (lower.length >= suffix.length && lower.endsWith(suffix)) return true
      if (lower === suffix.slice(1)) return true
    } else if (lower === rule) {
      return true
    }
  }

  return false
}

/**
 * 这份配置是否真的需要「浏览器内规则分流」。
 *
 * 🔴 **单一真源。** 这个谓词有两个调用方，它们必须永远给出同一个答案：
 *
 *   1. `platform/chromium.ts` 的 `buildProxyConfig` —— 决定生成 PAC 还是
 *      `fixed_servers`；
 *   2. `proxy.ts` 的 `enableProxy`（经由平台的 `preflight`）—— 决定在不支持
 *      分流的平台上是否拒绝开启。
 *
 * 若两处各写一遍 `routingMode === 'smart' && rules.length > 0`，就存在一种
 * 恶性的不一致：一方认为「需要分流」而另一方认为「不需要」。落到 Firefox 上
 * 的表现是**静默按全局代理写入**，用户配的直连规则被无声忽略 ——
 * 而那意味着他本该直连的校内站点全部走了代理，正是本项目要解决的问题反过来发生。
 *
 * 注意判据是**清洗后**的规则数而不是原始清单长度：全是非法规则的清单
 * 等价于空清单（`sanitizeRules` 会全部丢掉），此时退回全局是正确的。
 */
export function needsRuleBasedRouting(settings: {
  readonly routingMode: string
  readonly directRules: readonly string[]
}): boolean {
  return settings.routingMode === 'smart' && sanitizeRules(settings.directRules).length > 0
}

/**
 * 生成 PAC 脚本。
 *
 * 脚本逻辑刻意写得极简 —— 它对**每个请求**都要执行一次，
 * 复杂逻辑在这里的代价会被放大到浏览器的每一次网络访问上。
 *
 * 匹配语义：
 *   - `*.edu.cn` → 后缀匹配（`a.edu.cn` 与 `edu.cn` 都算命中）
 *   - `lib.foo.edu` → 精确匹配
 * 只支持这两种。更复杂的（正则、IP 段、端口）留给内核的规则系统去做，
 * 它本来就比我们擅长这件事。
 */
export function buildPacScript(proxyHost: string, proxyPort: number, rules: readonly string[]): string {
  const clean = sanitizeRules(rules)

  /*
   * 🔴 这三处 JSON.stringify 是本文件的全部安全性所在。
   *
   * 规则以数组字面量的形式进入脚本，永远作为 `DIRECT_SUFFIX` / `DIRECT_EXACT`
   * 的数据元素被查表，不参与任何代码构造。即便某条规则侥幸绕过了白名单，
   * JSON.stringify 也会把引号转义掉，它最多变成一个匹配不上的字符串，
   * 而不会变成一段可执行代码。
   */
  const suffixes = clean.filter((r) => r.startsWith('*.')).map((r) => r.slice(1))
  const exacts = clean.filter((r) => !r.startsWith('*.'))
  const proxy = `PROXY ${proxyHost}:${proxyPort}`

  /*
   * 🔴 生成的脚本必须是**纯 ASCII**。
   *
   * Chromium 对 `pacScript.data` 的限制：
   *   'pacScript.data' supports only ASCII code (encode URLs in Punycode format).
   *
   * 此方最初在这段脚本里写了中文注释，于是真机上 96 个非 ASCII 字符
   * 让整个写入被拒 —— 症状是「写入代理设置失败」，而错误文本里的
   * "encode URLs in Punycode" 会把人往"域名编码"的方向误导，
   * 实际问题出在注释上。
   *
   * 所以脚本内**一律不写中文注释**。解释性内容留在本文件的源码注释里，
   * 那里才是维护者会读的地方；脚本是每个请求都要执行一次的运行时代码，
   * 注释在那里对任何人都没有价值。
   *
   * 下面 `assertAscii` 会兜住这条约束，测试也各锁一条。
   *
   * 脚本逻辑说明（对应下面各段）：
   *   1. 本机与无点主机名直连 —— 与 fixed_servers 的 bypassList 保持一致
   *      （ADR-02）。否则 Controller 探活会被送进代理形成自环。
   *   2. 精确匹配命中即直连。
   *   3. 后缀匹配：`.edu.cn` 命中 `a.edu.cn`（后缀）与 `edu.cn`（去掉前导点后全等）。
   *   4. 只返回代理，**不附带 "; DIRECT" 兜底**（security.md §4）——
   *      加了兜底等于把 fail-closed 语义作废：代理连不上时会静默直连。
   */
  const script = `function FindProxyForURL(url, host) {
  var PROXY_STR = ${JSON.stringify(proxy)};
  var DIRECT_SUFFIX = ${JSON.stringify(suffixes)};
  var DIRECT_EXACT = ${JSON.stringify(exacts)};
  var LOCAL = ${JSON.stringify(LOOPBACK_HOSTS)};

  host = ('' + host).toLowerCase();

  if (host === 'localhost' || host.indexOf('.') === -1) return 'DIRECT';
  for (var i = 0; i < LOCAL.length; i++) {
    if (host === LOCAL[i]) return 'DIRECT';
  }

  for (var j = 0; j < DIRECT_EXACT.length; j++) {
    if (host === DIRECT_EXACT[j]) return 'DIRECT';
  }
  for (var k = 0; k < DIRECT_SUFFIX.length; k++) {
    var s = DIRECT_SUFFIX[k];
    if (host.length >= s.length && host.slice(-s.length) === s) return 'DIRECT';
    if (host === s.slice(1)) return 'DIRECT';
  }

  return PROXY_STR;
}`

  return assertAscii(script)
}

/**
 * 确保脚本是纯 ASCII，否则 Chromium 会拒绝整个写入。
 *
 * 为什么是抛异常而不是静默过滤：能走到这里的非 ASCII 只有两种来源 ——
 * 我们自己写进模板的字符（那是 bug，必须立刻暴露），
 * 或者绕过了 `RULE_ALLOWED_PATTERN` 白名单的规则（那是防线漏了，更该暴露）。
 * 静默剥掉它们会让一个本该修的问题变成"某条规则莫名不生效"。
 */
function assertAscii(script: string): string {
  // eslint-disable-next-line no-control-regex
  const offenders = [...script].filter((c) => c.charCodeAt(0) > 127)
  if (offenders.length > 0) {
    const unique = [...new Set(offenders)].slice(0, 20).join('')
    throw new Error(
      `PAC script must be pure ASCII (Chromium rejects pacScript.data otherwise); ` +
        `found ${offenders.length} non-ASCII character(s): ${unique}`,
    )
  }
  return script
}
