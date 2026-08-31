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
 */

import { RULE_ALLOWED_PATTERN, PROXY_BYPASS_LIST } from '../shared/constants'

/**
 * 把一条规则转成 PAC 里可比较的形式。
 *
 * 返回 null 表示该规则不合法，调用方应当丢弃它而不是原样传下去。
 */
export function sanitizeRule(rule: string): string | null {
  const trimmed = rule.trim().toLowerCase()
  if (trimmed.length === 0) return null
  if (!RULE_ALLOWED_PATTERN.test(trimmed)) return null
  return trimmed
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

  return `function FindProxyForURL(url, host) {
  var PROXY_STR = ${JSON.stringify(proxy)};
  var DIRECT_SUFFIX = ${JSON.stringify(suffixes)};
  var DIRECT_EXACT = ${JSON.stringify(exacts)};
  var LOCAL = ${JSON.stringify(PROXY_BYPASS_LIST.filter((e) => e !== '<local>'))};

  host = ('' + host).toLowerCase();

  // 本机永远直连。与 fixed_servers 的 bypassList 保持一致（ADR-02）——
  // 否则 Controller 探活会被送进代理形成自环。
  if (host === 'localhost' || host.indexOf('.') === -1) return 'DIRECT';
  for (var i = 0; i < LOCAL.length; i++) {
    if (host === LOCAL[i]) return 'DIRECT';
  }

  for (var j = 0; j < DIRECT_EXACT.length; j++) {
    if (host === DIRECT_EXACT[j]) return 'DIRECT';
  }
  for (var k = 0; k < DIRECT_SUFFIX.length; k++) {
    var s = DIRECT_SUFFIX[k];
    // 命中 ".edu.cn" 的两种情形：a.edu.cn（后缀）与 edu.cn（去掉前导点后全等）
    if (host.length >= s.length && host.slice(-s.length) === s) return 'DIRECT';
    if (host === s.slice(1)) return 'DIRECT';
  }

  // 🔴 只返回代理，**不附带 "; DIRECT" 兜底**（security.md §4）。
  // 加了兜底就等于把 fail-closed 语义作废：代理连不上时会静默直连。
  return PROXY_STR;
}`
}
