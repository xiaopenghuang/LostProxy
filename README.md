<div align="center">

<img src="src/public/icons/icon-128.png" alt="LostProxy" width="120">

# LostProxy

**只让这一个浏览器走本机代理，系统其余部分保持原样**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Edge%20%7C%20Chromium%20120+-0078D6?logo=microsoftedge&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8%20(Rolldown)-646CFF?logo=vite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-917%20passing-brightgreen)

[![Release](https://img.shields.io/github/v/release/xiaopenghuang/LostProxy?label=download&color=success)](https://github.com/xiaopenghuang/LostProxy/releases/latest)

**中文** · [English](README.en.md)

</div>

---

校园网里常见的两难：挂上代理才能查文献，但一开系统代理，校内的图书馆系统、实验室数据库、
内网打印机全部跟着绕道走。TUN 模式更彻底，连别的软件一起接管。

LostProxy 把代理的作用域收窄到**一个浏览器**。装了它的 Edge 走本机 Mihomo，同一台电脑上的
Chrome、Firefox 和其他所有软件保持原始网络环境不变。

```text
Edge   ──▶ 127.0.0.1:7897 ──▶ Mihomo ──▶ 代理节点 ──▶ 站外资源
Chrome ──▶ DIRECT ─────────────────────▶ 校园网络 ──▶ 校内系统 / 数据库
```

不修改 Windows 系统代理，不写注册表，不开 TUN，不改路由表，不需要管理员权限。协议层
（VLESS / VMess / Trojan / SS / Hysteria2）一个都不实现，全部交给 Mihomo —— 本项目只做作用域控制。

## 功能特性

- **作用域限于本浏览器** — 只写 `chrome.proxy`，不碰任何系统设置。实测同一台机器上两个浏览器
  可以处在不同的网络出口：Edge 出口在 AWS 东京，Chrome 出口仍是本地 ISP，ASN 完全不同。
- **Fail-closed，不静默直连** — 代理不可用时中止请求并报 `ERR_PROXY_CONNECTION_FAILED`，
  而不是退回直连。宁可断网，也不在用户以为「已开代理」时泄漏真实 IP。真机实测
  `onProxyError.fatal === true`（已中止，未泄漏）。
- **WebRTC 一并锁进代理** — 开启代理时设 `disable_non_proxied_udp`（IETF Mode 4）。浏览器默认
  策略**不会**强制 WebRTC 走代理，UDP 会绕过 HTTP 代理直接暴露真实 IP。
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

从 [Releases](https://github.com/xiaopenghuang/LostProxy/releases/latest) 下载
`lostproxy-v<版本>.zip`，**解压**，然后：

1. 打开 `edge://extensions`
2. 打开左下角 **开发人员模式 / Developer mode**
3. 点 **加载解压缩的扩展 / Load unpacked**，选**解压出来的那个文件夹**（里面应该能直接看到 `manifest.json`）

> **为什么不是双击安装**：Chromium 从 URL 下载 `.crx` 会直接拒绝（`CRX_REQUIRED_PROOF_MISSING`），
> 商店之外只有「加载解压缩」这一条路。上架 Edge Add-ons 商店后会有一键安装，那是后面的事。

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

然后在 Edge 里：`edge://extensions` → 打开左下角**开发人员模式** → **加载解压缩的扩展** →
选 **`dist/`**（不是项目根目录）。

改了代码后重新 `npm run build`，再到 `edge://extensions` 点该扩展的**刷新**。

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 完整构建（clean → 页面 → Service Worker，两趟） |
| `npm run watch` | 监听重建 Popup / Options |
| `npm run watch:sw` | 监听重建 Service Worker（**另开一个终端**） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest 单元测试 |
| `npm run verify` | typecheck + test + build 全量自检 |
| `npm run package` | 构建并打出可分发的 zip 到 `release/`（附 SHA-256） |
| `npm run icons` | 从 `src/public/icons/icon.png` 重新降采样出四种尺寸 |

**为什么构建要跑两趟**：MV3 的 Service Worker 必须是自包含单文件（一旦产生 chunk import 就
`Service worker registration failed`），这与页面入口的输出要求互斥。所以 watch 也要开两个终端。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 扩展平台 | Manifest V3（`proxy` + `storage` + `privacy` 权限） |
| 语言 | TypeScript 7（native/Go 编译器） |
| 构建 | Vite 8（Rolldown），手写配置，两趟输出 |
| 测试 | Vitest 4，917 项，含 `chrome.*` 手写 mock |
| 界面 | 原生 HTML/CSS，无 UI 框架；Fluent Design 视觉语言 |
| i18n | 自实现，EN 词典为单一真源，缺翻译是编译期错误 |

## 项目结构

```
src/
  background/   proxy.ts    chrome.proxy 读写与错误归一
                privacy.ts  WebRTC 策略锁
                mihomo.ts   Controller 探活（只读）
                storage.ts  设置校验与持久化
                orchestrator.ts  编排，全部业务决策集中在此
                index.ts    Service Worker 外壳，极薄
  popup/        开关、状态卡片、告警
  options/      设置页、语言切换、Controller 探活
  shared/       types / constants / errors / i18n / messages
tests/          917 项单元测试与 chrome API mock
scripts/        图标降采样与生成
```

Service Worker 会被浏览器随时杀掉重启，因此**模块作用域不存任何可变状态**，每次消息到达都从
storage 重读。业务决策不散落在 `proxy.ts` 里，集中在 `orchestrator.ts`。

## 数据存放

全部在 `chrome.storage.local`，三个键：设置、开关状态、最后一条错误。

**不使用 `chrome.storage.sync`** —— Controller Secret 是本机凭据，同步到云端即为越界。
测试环境里 `storage.sync` 被替换成会抛异常的桩，防止将来有人手滑写进去。

## 测试

```bash
npm run test        # 917 项，约 0.5s
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
