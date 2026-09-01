<div align="center">

<img src="src/public/icons/icon-128.png" alt="LostProxy" width="120">

# LostProxy

**只让这一个浏览器走代理，电脑上其他软件保持原样**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/Edge%20%7C%20Chrome%20120+%20%7C%20Firefox%20128+-0078D6?logo=microsoftedge&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
[![Release](https://img.shields.io/github/v/release/xiaopenghuang/LostProxy?label=download&color=success)](https://github.com/xiaopenghuang/LostProxy/releases/latest)

**中文** · [English](README.en.md)

</div>

---

校园网里常见的两难：挂上代理才能查文献，但一开系统代理，校内的图书馆系统、
实验室数据库、内网打印机全部跟着绕道走。TUN 模式更彻底，连别的软件一起接管。

LostProxy 把代理的作用域收窄到**一个浏览器**：

```text
装了它的 Edge  ──▶ 本机 Mihomo ──▶ 节点 ──▶ 站外资源
没装的 Chrome  ──▶ 直连 ─────────────────▶ 校内系统 / 数据库
```

不改 Windows 系统代理，不写注册表，不开 TUN，不改路由表，不要管理员权限。
协议（VLESS / VMess / Trojan / SS / Hysteria2）一个都不实现 —— 那些交给 Mihomo，
本扩展只管"谁走代理"。

## 能做什么

- **一键开关**，作用域只限本浏览器
- **切节点 / 测延迟**，不用打开 Clash 客户端
- **智能分流** —— 列一份直连清单，校内站点不走代理
- **刷新订阅**
- **WebRTC 一并锁进代理**，否则 UDP 会绕过 HTTP 代理暴露真实 IP
- 代理连不上时**宁可断网也不偷偷直连**（[为什么](DESIGN.md#fail-closed)）
- 中英双语，即时切换

## 安装

[Releases](https://github.com/xiaopenghuang/LostProxy/releases/latest) 里按浏览器选，
**两个包不能混用** —— 装错的表现是"装上了但代理没生效"，而浏览器不报错。

### Edge / Chrome

下载 `lostproxy-v<版本>.zip` 并**解压**，然后：

1. 打开 `edge://extensions`（Chrome 是 `chrome://extensions`）
2. 打开左下角**开发人员模式**
3. 点**加载解压缩的扩展**，选解压出来的**文件夹**

> 商店之外只有这一条路：Chromium 会拒绝从 URL 下载的 `.crx`
> （`CRX_REQUIRED_PROOF_MISSING`）。上架商店是后面的事。

### Firefox

下载 **`lostproxy-firefox-v<版本>.xpi`**（Mozilla 签过名的那个），然后：

1. `about:addons` → 右上齿轮 → **从文件安装附加组件**
2. 🔴 点开 LostProxy → 打开**在隐私窗口中运行**

第 2 步不是可选的。Firefox 规定代理设置对隐私窗口与普通窗口同时生效，
不给这个权限就**完全不允许**扩展改代理。没开的话扩展会告诉你去哪儿开，
不会假装已经开好了。

> **`.zip` 那个也能用，但只能临时载入**（`about:debugging` → 临时载入附加组件），
> 关掉 Firefox 就没了。`.xpi` 是签过名的，重启不掉。
>
> ⚠️ `.xpi` **不会自动更新** —— 它走自分发渠道，AMO 上搜不到，
> 所以 Firefox 找不到更新源。想升级得回来手动下。

### 校验（可选）

代理工具值得核对哈希，Release 页面附了 SHA-256。`.zip` 由 GitHub Actions 构建
并带 Sigstore 来源证明：

```bash
gh attestation verify lostproxy-v<版本>.zip --repo xiaopenghuang/LostProxy
```

`.xpi` 由 Mozilla 签名、但在本机构建，所以没有那份来源证明。
它的内容与 `.zip` 逐个文件一致（只差 AMO 重新格式化过的 `manifest.json`），
想核对可以两个都下来解开比一比。

## 配置

**装上它本身不会让你能上网** —— 需要本机已经跑着一个 Mihomo 内核，
比如 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)。

### 端口 —— 唯一最容易踩的坑

| | 代理端口 | Controller 端口 |
| --- | --- | --- |
| LostProxy 默认值 | 7890 | 9090 |
| **Clash Verge Rev 默认** | **7897** | **9097** |
| 你改过代理端口 | 你设的值 | **仍是 9097**（不跟着变） |

去 Clash Verge 核对两处，填进 LostProxy 的 ⚙ 设置：

- `设置 → 端口设置` → **混合代理端口** → 填「代理端口」
- `设置 → 外部控制` → **端口** → 填「Controller 端口」；有密钥就一并填上

三条提醒：

1. **两个端口互相独立。** 把混合端口改成 2080，Controller 通常还在 9097。
2. **代理端口要填混合端口或 HTTP 端口**，不能填 SOCKS 端口。
3. **不开外部控制也能用。** 只是核心状态显示灰点，代理本身照常工作 ——
   设置页有个「探测端口」按钮可以帮你找。

### 然后在客户端里关掉这两项

```text
系统代理  = 关    ← 开着就失去「只有这个浏览器走代理」的意义
TUN      = 关    ← 开着会接管全系统流量
```

这两项正是本扩展要替代的东西，开着它就没有存在价值了。

⚠️ 某些客户端退出或改配置时会把系统代理**自动开回来**，验证前再查一遍：

```bash
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable
```

必须是 `0x0`。

## 验证它真的生效了

装 LostProxy 的浏览器和**没装的另一个浏览器**，同时打开
<https://ipinfo.io/ip>：

```text
LostProxy 关 → 两个 IP 相同
LostProxy 开 → 两个 IP 不同   ← 这才说明作用域隔离成立
```

别拿固定 IP 对号，机场节点会变，只看两个数字是否不同。

## 从源码构建

```bash
npm install
npm run build      # 产出 dist/（Edge / Chrome）与 dist-firefox/
```

然后按上面的安装步骤，选 `dist/` 或 `dist-firefox/`（不是项目根目录）。
改了代码重新构建，再到扩展页点**刷新**。

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 两个平台完整构建 |
| `npm run watch` | 监听重建界面 |
| `npm run watch:sw` | 监听重建背景脚本（**另开一个终端**） |
| `npm run test` | 单元测试 |
| `npm run verify` | typecheck + test + build |
| `npm run package` | 打出两个可分发 zip 到 `release/` |
| `npm run sign:firefox` | 提交 AMO 签名，取回可长期安装的 `.xpi` |

技术栈：TypeScript + Vite 8（Rolldown）+ Vitest，原生 HTML/CSS 无 UI 框架，
零运行时依赖。每个平台要跑两趟构建、以及别的一些非显然之处，见
[DESIGN.md](DESIGN.md#构建)。

## 已知限制

- 浏览器自身的账号同步、搜索建议、Copilot 也会走代理。这是浏览器级代理的
  预期行为，但可能触发账号风控。
- 只支持 HTTP / 混合端口，不支持直连 SOCKS 端口。
- 上游代理需要用户名密码认证的情形未实现。
- 企业 / 校园 Policy 控制代理设置时无法开启 —— 扩展优先级低于 Policy。
- 与其他代理扩展冲突时**拒绝开启**并说明是谁在控制，不强行覆盖。
- **Firefox for Android 装得上但用不了** —— `proxy.settings` 在那上面
  根本没实现（Bugzilla 1725981）。下个版本会在 manifest 里明确排除。
- QUIC / HTTP3 是否绕过代理、InPrivate 窗口的实际出口 IP，**均未实测** ——
  是已知的待验项，不是已知的保证。

### Firefox 与 Edge / Chrome 的差异

功能**完全一致**。但有两处操作上的不同，都源自浏览器 API 本身：

1. **必须授予「在隐私窗口中运行」**（见上面安装第 2 步）。
2. **智能分流要额外授权一次。** Firefox 不支持内联 PAC，分流只能由扩展
   逐个请求判断 —— 也就是浏览器会把每个网址问一遍，这需要「访问所有网站」权限。
   入口在**设置页 → 直连规则 → 「允许逐请求判断」**。不给就继续用全局代理，
   给了随时能在 `about:addons` 里收回。

   默认只要 `http://127.0.0.1/*`，所以只用全局代理的人不必为一个可选功能
   交出这个权限（[为什么这样取舍](DESIGN.md#firefox-的可选权限)）。

## 设计说明

为什么 fail-closed、为什么两个平台的代码必须分开、为什么放弃了「内置 Core」——
这些取舍连同踩过的坑都在 [DESIGN.md](DESIGN.md)。

## 许可

[MIT](LICENSE)
