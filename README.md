<div align="center">

<img src="src/public/icons/icon-128.png" alt="LostProxy" width="120">

# LostProxy

**只让这一个浏览器走本机代理，系统其余部分保持原样**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Edge%20%7C%20Chrome%20120+%20%7C%20Firefox%20128+-0078D6?logo=microsoftedge&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8%20(Rolldown)-646CFF?logo=vite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-1076%20passing-brightgreen)

[![Release](https://img.shields.io/github/v/release/xiaopenghuang/LostProxy?label=download&color=success)](https://github.com/xiaopenghuang/LostProxy/releases/latest)

**中文** · [English](README.en.md)

</div>

---

校园网里常见的两难：挂上代理才能查文献，但一开系统代理，校内的图书馆系统、实验室数据库、
内网打印机全部跟着绕道走。TUN 模式更彻底，连别的软件一起接管。

LostProxy 把代理的作用域收窄到**一个浏览器**。装了它的那个浏览器走本机 Mihomo，同一台电脑上
其他浏览器与所有软件保持原始网络环境不变。

```text
Edge   ──▶ 127.0.0.1:7897 ──▶ Mihomo ──▶ 代理节点 ──▶ 站外资源
Chrome ──▶ DIRECT ─────────────────────▶ 校园网络 ──▶ 校内系统 / 数据库
```

Edge / Chrome 与 Firefox 各有一个产物。两者共享全部业务逻辑与界面，
只有「怎么调浏览器的代理 API」那一层不同 —— 而那两套 API 完全不同，
连 WebRTC 泄漏防护该写什么值都不一样。

不修改 Windows 系统代理，不写注册表，不开 TUN，不改路由表，不需要管理员权限。协议层
（VLESS / VMess / Trojan / SS / Hysteria2）一个都不实现，全部交给 Mihomo —— 本项目只做作用域控制。

## 功能特性

- **作用域限于本浏览器** — 只写 `chrome.proxy`，不碰任何系统设置。实测同一台机器上两个浏览器
  可以处在不同的网络出口：Edge 出口在 AWS 东京，Chrome 出口仍是本地 ISP，ASN 完全不同。
- **Fail-closed，不静默直连** — 代理不可用时中止请求并报 `ERR_PROXY_CONNECTION_FAILED`，
  而不是退回直连。宁可断网，也不在用户以为「已开代理」时泄漏真实 IP。真机实测
  `onProxyError.fatal === true`（已中止，未泄漏）。
- **WebRTC 一并锁进代理** — Chromium 上设 `disable_non_proxied_udp`（IETF Mode 4），
  Firefox 上设 `proxy_only`。浏览器默认策略**不会**强制 WebRTC 走代理，
  UDP 会绕过 HTTP 代理直接暴露真实 IP。

  两个平台用不同的值不是笔误：自 Firefox 70 起，同名的 `disable_non_proxied_udp`
  在 Firefox 上退化成「有代理时才强制」，抄过去会被**接受**、**不报错**、
  而防护**更弱**。这类差异没有任何编译期或运行期信号，所以代码里用一整层
  抽象把它关起来，并在发布的 zip 上再验一次。
- **凭据只留在本机** — Controller Secret 不进 `chrome.storage.sync`、不打日志、不回显（界面只显示
  「已保存」）。测试用例断言它不出现在任何序列化过的对象里。
- **可观测性与可用性分开** — Mihomo Controller 探不通只显示灰点，**不报警**。多数 GUI 默认只开
  named pipe 不开 HTTP 接口，此时代理走的是混合端口，完全正常 —— 探不通不等于代理坏了。
- **告警会自愈** — 恢复后自动清除，不需要手动点掉；只有疑似泄漏类告警保留人工确认，
  因为它需要用户知道曾经发生过什么。
- **冲突时拒绝覆盖** — 检测到其他代理扩展或企业 / 校园 Policy 正在控制代理设置时不强行抢占，
  并说明是谁在控制。
- **卸载即完全撤销** — 停用或卸载扩展时由浏览器自动清除代理设置，不留下需要手工修的坏状态。
- **中英双语即时切换** — 自实现 i18n，不依赖 `chrome.i18n`（后者只能读浏览器界面语言，用户无法切换）。

## 安装

[Releases](https://github.com/xiaopenghuang/LostProxy/releases/latest) 里有两个包，
**不能混用** —— 装错的表现是「装上了但代理压根没生效」，而浏览器不报错：

| 浏览器 | 下载 |
| --- | --- |
| Edge / Chrome | `lostproxy-v<版本>.zip` |
| Firefox | `lostproxy-firefox-v<版本>.zip` |

### Edge / Chrome

1. 下载并**解压**
2. 打开 `edge://extensions`
3. 打开左下角 **开发人员模式 / Developer mode**
4. 点 **加载解压缩的扩展 / Load unpacked**，选**解压出来的那个文件夹**（里面应该能直接看到 `manifest.json`）

> **为什么不是双击安装**：Chromium 从 URL 下载 `.crx` 会直接拒绝（`CRX_REQUIRED_PROOF_MISSING`），
> 商店之外只有「加载解压缩」这一条路。上架 Edge Add-ons 商店后会有一键安装，那是后面的事。

### Firefox

1. 下载并**解压**
2. 打开 `about:debugging#/runtime/this-firefox`
3. 点 **临时载入附加组件**，选解压出来文件夹里的 `manifest.json`
4. 🔴 打开 `about:addons` → 点开 LostProxy → 把 **在隐私窗口中运行** 打开

> **第 4 步不是可选的。** Firefox 规定代理设置对隐私窗口与普通窗口同时生效，
> 因此不给这个权限就**完全不允许**扩展改代理 —— `proxy.settings.set()` 会直接抛异常。
> 没开的话扩展会明确告诉你去哪儿开，不会假装已经开好了。
>
> 顺带一提：Chromium 上靠 `scope: 'regular'` 换来的「InPrivate 窗口也走代理、不泄漏」，
> 在 Firefox 上是**默认行为** —— 代价就是这个前置授权。

> **临时载入的扩展在关闭 Firefox 后会消失。** 这是 Firefox 对未签名扩展的规定，
> 不是本扩展的限制。永久安装需要走 AMO 签名，那是后面的事。

代理工具值得核对哈希，Release 页面附了 SHA-256。从 v0.1.1 起，产物由 GitHub Actions 构建并带
Sigstore 签名的来源证明，可以验证它确实来自本仓库的某次公开构建，而不是谁手动传上来的：

```bash
gh attestation verify lostproxy-v<版本>.zip --repo xiaopenghuang/LostProxy
```

也可以直接[从源码构建](#从源码构建)。

**装上它本身不会让你能上网** —— 还需要下面这些前置条件。

## 前置条件

V0.1 **不内置也不下载** Mihomo Core，需要本机已经跑着一个：

- [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) 或其他 Mihomo GUI，或裸 `mihomo.exe`

### 端口 —— 唯一最容易踩的坑

| 客户端 / 情形 | 代理端口 | Controller 端口 |
| --- | --- | --- |
| LostProxy 默认值 | 7890 | 9090 |
| **Clash Verge Rev 默认** | **7897** | **9097** |
| 你自己改过代理端口 | 你设的值 | **仍是 9097**（不跟着变） |

去 Clash Verge 核对两处，填进 LostProxy 的 ⚙ Settings：

- `设置 → 端口设置` → **混合代理端口** → 填 `Proxy Port`
- `设置 → 外部控制` → **端口** → 填 `Controller Port`；有密钥就一并填 `Controller Secret`

三条提醒：

1. **两个端口互相独立。** 把混合端口改成 2080，Controller 通常还在 9097。
2. **代理端口必须是混合端口或 HTTP 端口**，不能填 SOCKS 端口 —— LostProxy 以 HTTP 方式连接。
3. **关掉外部控制不影响代理。** 只会一直显示灰点「核心状态不可读」，代理本身照常工作。

### Mihomo 侧配置

```yaml
mixed-port: 7897                      # ← 填进 LostProxy 的 Proxy Port
allow-lan: false                      # 不对局域网开放
external-controller: 127.0.0.1:9097   # ← 可选；禁止 0.0.0.0
secret: "<启用 external-controller 时必设>"
```

> `secret` 在启用外部控制时是**必须的**：Mihomo 默认 `external-controller-cors.allow-origins: ['*']`，
> 没有密钥的话任意网页都能控制你的内核。

### 然后在 GUI 里关掉这两项

```text
System Proxy = OFF     ← 开着就失去「只有 Edge 走代理」的意义
TUN          = OFF     ← 开着会接管全系统流量
```

这两项正是本项目要替代的方案，开着 LostProxy 就没有存在价值了。

## 从源码构建

```bash
npm install
npm run build
```

产物有两个：`dist/`（Edge / Chrome）与 `dist-firefox/`（Firefox）。

然后在 Edge 里：`edge://extensions` → 打开左下角**开发人员模式** → **加载解压缩的扩展** →
选 **`dist/`**（不是项目根目录）。Firefox 走 `about:debugging`，选 `dist-firefox/manifest.json`。

改了代码后重新 `npm run build`，再到扩展页点该扩展的**刷新**。

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 完整构建，两个平台各两趟 |
| `npm run build:chromium` | 只构建 Edge / Chrome 版（不 clean） |
| `npm run build:firefox` | 只构建 Firefox 版（不 clean） |
| `npm run watch` | 监听重建 Popup / Options |
| `npm run watch:sw` | 监听重建背景脚本（**另开一个终端**） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest 单元测试 |
| `npm run verify` | typecheck + test + build 全量自检 |
| `npm run package` | 构建并打出两个可分发 zip 到 `release/`（各附 SHA-256） |
| `npm run icons` | 从 `src/public/icons/icon.png` 重新降采样出四种尺寸 |

**为什么每个平台要跑两趟**：MV3 的背景脚本必须是自包含单文件（一旦产生 chunk import 就
`Service worker registration failed`），这与页面入口的输出要求互斥。所以 watch 也要开两个终端。

**为什么两个平台分开构建而不是运行期判断**：平台标识由 Vite 的 `define` 在编译期注入，
因此产物里只有一个平台的代码。这不只是省几 KB —— 它让「Firefox 包里不该出现
`disable_non_proxied_udp`」成为一条可断言的事实，而那条断言守的正是上面提到的
那处「抄过去也能跑但更不安全」的差异。运行期嗅探做不到这一点，
而且它本身也不可靠（Edge 的 UA 里有 "Chrome"，Firefox 也提供 `chrome.*` 命名空间）。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 扩展平台 | Manifest V3（`proxy` + `storage` + `privacy` 权限） |
| 语言 | TypeScript 7（native/Go 编译器） |
| 构建 | Vite 8（Rolldown），手写配置，两趟输出 |
| 测试 | Vitest 4，1076 项，含 `chrome.*` 手写 mock |
| 界面 | 原生 HTML/CSS，无 UI 框架；Fluent Design 视觉语言 |
| i18n | 自实现，EN 词典为单一真源，缺翻译是编译期错误 |

## 项目结构

```
src/
  background/   platform/   ← 唯一存在浏览器差异的地方
                  types.ts    契约 + 两个平台的完整差异对照表
                  chromium.ts chrome.proxy / chrome.privacy 的全部调用
                  firefox.ts  browser.proxy 的全部调用
                  index.ts    构建期选择，别处一律不问"是哪个浏览器"
                proxy.ts    代理编排，零浏览器 API 调用
                privacy.ts  WebRTC 锁编排，同上
                pac.ts      PAC 生成与规则清洗（唯一的注入面）
                mihomo.ts   Controller 探活（只读）
                storage.ts  设置校验与持久化
                orchestrator.ts  编排，全部业务决策集中在此
                index.ts    背景脚本外壳，极薄
  popup/        开关、状态卡片、告警
  options/      设置页、语言切换、Controller 探活
  shared/       types / constants / errors / i18n / messages
  manifest.json         Chromium（service_worker）
  manifest.firefox.json Firefox（scripts + gecko id）
tests/          1076 项单元测试与两套 chrome API mock
scripts/        打包、发布说明、图标生成
```

背景脚本会被浏览器随时杀掉重启，因此**模块作用域不存任何可变状态**，每次消息到达都从
storage 重读。业务决策不散落在 `proxy.ts` 里，集中在 `orchestrator.ts`。

**浏览器差异全部关在 `platform/` 里。** `proxy.ts` 与 `privacy.ts` 的代码中
出现一次 `chrome.` 调用就会让测试变红 —— 因为这类错误在 Edge 上完全正常，
只在 Firefox 上炸，而开发时手边通常只有一个浏览器。同理，两个产物之间
不得混入对方的代码，这一条在**发布的 zip 上**也再验一次。

## 数据存放

全部在 `chrome.storage.local`，三个键：设置、开关状态、最后一条错误。

**不使用 `chrome.storage.sync`** —— Controller Secret 是本机凭据，同步到云端即为越界。
测试环境里 `storage.sync` 被替换成会抛异常的桩，防止将来有人手滑写进去。

## 测试

```bash
npm run test        # 1076 项，约 0.5s
npm run verify      # typecheck + test + build
```

单元测试锁的是**不变量**，不是行为快照：`singleProxy` 而非 `proxyForHttp`、bypass 列表恰好四项、
`scope === 'regular'`、关代理用 `clear()` 而非 `set(direct)`、开关代理时的写入顺序（两个方向都验）、
secret 不出现在任何序列化对象中、i18n 占位符两语言一致。

但本项目最重要的验收**不是**单元测试，而是双浏览器出口隔离的真机测试：

```text
Edge   装 LostProxy
Chrome 不装
        ↓
LostProxy ON 时必须满足： Edge 出口 IP ≠ Chrome 出口 IP
```

单元测试无法覆盖这一项 —— 它需要两个真实浏览器、一个真实内核和一次真实的出网。当前
**Definition of Done 18 / 18** 已在真机上逐条验证通过。

真机验收时最容易踩的三个坑，都是开发期间实际踩到的：

1. **系统代理忘了关。** Chrome 也会走代理，隔离测试必然失败。更阴险的是它让「Edge 能上外网」
   看起来像本插件的功劳，其实与本插件无关。核验：
   `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable`
   必须是 `0x0`。某些 GUI 退出或改配置时会把它自动开回来，验之前再查一遍。
2. **端口填了默认值。** 最可靠的办法是直接看内核在监听什么，而不是相信文档里的默认值。
3. **以为 Controller 端口跟着代理端口一起变。** 它们是两个互相独立的端口。

## 已知限制

- Edge 自身的账号同步、搜索建议、Copilot 也会走代理。这是浏览器级代理的预期行为，
  但可能触发账号风控。
- 只支持 HTTP / 混合端口，不支持直连 SOCKS 端口。
- 上游代理需要用户名密码认证的情形未实现。
- QUIC / HTTP3 是否绕过代理、InPrivate 窗口的实际出口 IP，均**未实测** —— 已知的待验项，
  不是已知的安全保证。
- 企业 / 校园 Policy 控制代理设置时无法开启 —— 扩展优先级低于 Policy，这是平台规则。
- 与其他代理扩展冲突时会拒绝开启并说明是谁在控制，不强行覆盖。这一项用仓库自带的
  `tools/conflict-test-extension/` 真机验过 —— 一个只申请 `proxy` 权限、不发任何网络请求的
  三十行夹具，因为原先推荐的 SwitchyOmega 已停止维护、且在现在的 Chromium 上无法运行。

### Firefox 版的差异

功能与 Edge / Chrome 版**一致** —— 代理开关、节点切换、延迟测试、智能分流、
订阅刷新、WebRTC 锁全部可用。但有三处行为差异，都源自浏览器 API 本身：

**1. 智能分流需要一个额外权限，且只在你要用时才问。**

Firefox 的代理 API 不支持内联 PAC 脚本，所以分流走的是另一条路
（`proxy.onRequest`）：浏览器对**每个请求**问扩展一次「走代理还是直连」。
这意味着扩展能看到你访问的每一个网址 —— 所以 Firefox 必须先征得你同意。

授权入口在**设置页 → 直连规则 → 「允许逐请求判断」**。不给就继续用全局代理，
给了之后随时能在 `about:addons` 里收回。

> **为什么是设置页上一个按钮，而不是切到「智能」时弹窗**：Firefox 只允许
> `permissions.request()` 从真正的用户输入回调里调用，而背景脚本处理消息
> 明确不算，手势也活不过一次 `await`。从 popup 里请求则会撞上另一个仍未修复的
> Firefox bug —— 授权弹窗会出现在 popup **背后**且点不到（Bugzilla 1798454）。
> 设置页是普通标签页，弹窗会正常出现在你预期的位置。

> **为什么不在安装时一次要掉**：默认只要 `http://127.0.0.1/*` 本身是这个项目的
> 一项卖点 —— 权限面小意味着即便扩展被攻破，能拿到的东西也有限。
> 让只用全局代理的人替一个可选功能付这个代价是亏的。

顺带一提，那条路**比 PAC 更干净**：规则从来不变成代码，所以 Chromium 版里那整套
PAC 注入防御（字符白名单、`JSON.stringify` 序列化、纯 ASCII 校验）在 Firefox 上
根本不需要。

**2. 需要授予「在隐私窗口中运行」。**

Firefox 规定代理设置对隐私窗口与普通窗口同时生效，因此不给这个权限就
**完全不允许**扩展改代理。没给时扩展会明确告诉你去哪儿开，不会假装已经开好了。

反过来说，Chromium 上靠 `scope: 'regular'` 换来的「InPrivate 窗口也走代理、
不泄漏」在 Firefox 上是**默认行为** —— 代价就是这个前置授权。

**3. 运行时错误信号更弱。**

Firefox 的 `proxy.onError` 不带 `fatal` 字段，因此无法像 Chromium 那样区分
「请求被拦住了（没泄漏）」与「已经直连出去了（可能泄漏）」。此时的取向是
报一条可自愈的告警、不对是否泄漏做任何承诺 —— 而不是一律按最坏情况报警，
因为那会训练用户去点掉这类告警，连真正的泄漏警告一起点掉。

**4. 真机隔离测试尚未完成。**

Chromium 侧已实测两个浏览器不同出口 ASN；Firefox 侧目前只有单元测试覆盖
（含产物级断言），**尚未在真机上验证出口隔离与 fail-closed**。
这是已知的待验项，不是已知的保证。`docs/test-plan.md` §6.5 列了要验什么。

## 路线图

- **V0.2 节点切换** ✅ 已发布。在 Popup 里直接切 Mihomo 策略组的节点，不用打开 Clash Verge。

  ⚠️ 这是本项目**第一个效果逸出浏览器的功能**：切换节点改的是内核的全局状态，
  所有在用这个内核的程序都会跟着变 —— 与只影响本浏览器的代理开关不同。
  Popup 里对此有明示。内核的**选择**是全局的，但内核的**使用**仍然只限于本浏览器。
- **V0.3** 延迟测试
- **V0.4** 浏览器内智能分流（PAC —— ⚠️ 必须设 `mandatory: true`。PAC 默认是 **fail-open**：
  脚本取不到或解析失败时浏览器会退回直连，正好与 V0.1 的 fail-closed 语义相反）
- **V0.6** 订阅管理
- ~~**V0.5** 内置 Core~~ —— **已决定不做**，理由见下

### 为什么不做「内置 Core」

原方案 §19 计划用 Native Messaging 装一个本机 Host 来启停 `mihomo.exe`，
目标是「装上插件就能用，不必另装 Clash 客户端」。评估后放弃：

**它服务的人群基本不存在。** 会给浏览器配代理的人，机器上通常已经有 Clash 客户端了。
这个功能省掉的是「开一下客户端」，而客户端自己就有开机自启。

**代价却是结构性的：**

- **端口冲突，且症状会甩锅。** 两个内核撞同一端口时，后启动的起不来。若 LostProxy 先起，
  受害者是用户原有的客户端 —— 而用户不会想到是这个插件干的。
  改用独立端口可以规避，但那意味着机器上常驻两个内核进程（各 50–100 MB）、
  两套节点选择、两份订阅。
- **打破「卸载即干净」。** Native Messaging 要在
  `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\` 注册一个键。它不碰任何代理相关
  设置、不需要管理员，但**扩展卸载后不会自动清除**。而 `security.md §1` 里选择
  `chrome.proxy` / `chrome.privacy` 的**关键理由**正是「浏览器会自动恢复，不留脏状态」。
  V0.5 会让这个项目从「纯浏览器扩展」变成「装在系统上的软件」。
- **随包分发内核有许可证与信任两重问题。** mihomo 发布二进制取自 `Meta` 分支，
  许可证是 **GPL-3.0**（`main` 分支是 MIT，容易看错），与本项目的 MIT 混合分发需要认真处理；
  而更要紧的是：**这是个代理工具**，用户没有理由信任本项目塞进发布包里的 18 MB 二进制。
  改成运行时从 mihomo 官方 Release 下载 + 校验哈希可以解决信任问题，
  但那样「省掉一次下载」的收益已经小于全部代价。

**结论**：V0.5 换来的是便利，付出的是「卸载即干净」这个性质。当前形态
（用户自备内核 + 本扩展只管作用域）职责更清晰，负担也更小。

若将来真要降低上手门槛，成本低得多的方向是**端口自动探测** ——
挨个试常见端口，探到通的就填上。它不需要任何本机程序，也不动上面任何一条边界。

## 许可

[MIT](LICENSE)
