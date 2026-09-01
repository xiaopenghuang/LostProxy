<div align="center">

<img src="src/public/icons/icon-128.png" alt="LostProxy" width="120">

# LostProxy

**只让这一个浏览器走代理，电脑上其他软件保持原样**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/Edge%20%7C%20Chrome%20120+%20%7C%20Firefox%20140+-0078D6?logo=microsoftedge&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
[![Release](https://img.shields.io/github/v/release/xiaopenghuang/LostProxy?label=download&color=success)](https://github.com/xiaopenghuang/LostProxy/releases/latest)

**中文** · [English](README.en.md)

</div>

---

## 概述

开启系统代理会让全部流量绕道，包括本该直连的内网资源：图书馆系统、实验室
数据库、内网打印机。TUN 模式的影响范围更大，连其他应用一并接管。

LostProxy 把代理的作用域限定在**单个浏览器**：

```text
装了它的 Edge  ──▶ 本机 Mihomo ──▶ 节点 ──▶ 站外资源
没装的 Chrome  ──▶ 直连 ─────────────────▶ 校内系统 / 数据库
```

不修改 Windows 系统代理，不写注册表，不启用 TUN，不改动路由表，不需要
管理员权限。扩展本身不实现任何代理协议（VLESS / VMess / Trojan / SS /
Hysteria2），协议由 Mihomo 负责，扩展只决定哪些流量走代理。

## 功能

- 代理开关，作用域限定当前浏览器
- 节点切换与延迟测试，无需打开 Clash 客户端
- 规则分流，可配置直连主机清单
- 订阅刷新
- 同步锁定 WebRTC，避免 UDP 绕过 HTTP 代理暴露真实 IP
- 代理不可用时中断连接，不回退直连（[设计依据](DESIGN.md#fail-closed)）
- 中英双语，即时切换

## 安装

在 [Releases](https://github.com/xiaopenghuang/LostProxy/releases/latest)
页面按浏览器选择。**两个安装包不可混用**：装错的表现是代理不生效，且浏览器
不会报错。

### Edge / Chrome

下载 `lostproxy-v<版本>.zip` 并解压，然后：

1. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）
2. 启用左下角的**开发人员模式**
3. 点击**加载解压缩的扩展**，选择解压出的**文件夹**

> 商店之外只有这一种方式。Chromium 会拒绝从 URL 下载的 `.crx`
> （`CRX_REQUIRED_PROOF_MISSING`）。商店上架为后续计划。

### Firefox

下载 **`lostproxy-firefox-v<版本>.xpi`**（Mozilla 已签名），然后：

1. 打开 `about:addons` → 右上齿轮 → **从文件安装附加组件**
2. 点开 LostProxy → 启用**在隐私窗口中运行**

**第 2 步为必需项。** Firefox 规定代理设置对隐私窗口与普通窗口同时生效，
未获得该权限时完全不允许扩展修改代理。权限缺失时扩展会提示启用位置，
不会静默失败。

> **`.zip` 同样可用，但只能临时载入**（`about:debugging` → 临时载入附加
> 组件），关闭 Firefox 后失效。`.xpi` 已签名，重启后保留。
>
> `.xpi` **不会自动更新**。它通过自分发渠道发布，AMO 上不可检索，
> Firefox 无更新源可查询。升级需手动下载。

### 完整性校验

每个 Release 附带 SHA-256。`.zip` 由 GitHub Actions 构建并带 Sigstore
来源证明：

```bash
gh attestation verify lostproxy-v<版本>.zip --repo xiaopenghuang/LostProxy
```

`.xpi` 由 Mozilla 签名但在本机构建，因此没有来源证明。它与 `.zip` 的内容
逐个文件一致，仅 `manifest.json` 因 AMO 重新格式化而不同，可下载两者解压对比。

## 配置

**扩展本身不提供代理能力**，需要本机已运行 Mihomo 内核，例如
[Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)。

### 端口

| | 代理端口 | Controller 端口 |
| --- | --- | --- |
| LostProxy 默认值 | 7890 | 9090 |
| **Clash Verge Rev 默认值** | **7897** | **9097** |
| 修改过代理端口后 | 自定义值 | **仍为 9097**（不跟随变化） |

在 Clash Verge 中核对两处，填入 LostProxy 的 ⚙ 设置页：

- `设置 → 端口设置` → **混合代理端口** → 对应「代理端口」
- `设置 → 外部控制` → **端口** → 对应「Controller 端口」，如设有密钥一并填入

三点说明：

1. **两个端口相互独立。** 混合端口改为 2080 后，Controller 通常仍在 9097。
2. **代理端口须填混合端口或 HTTP 端口**，不可填 SOCKS 端口。
3. **外部控制非必需。** 未启用时内核状态显示为灰点，代理功能不受影响。
   设置页提供「探测端口」按钮辅助定位。

### 客户端设置

```text
系统代理  = 关闭    ← 启用后失去单浏览器作用域的意义
TUN      = 关闭    ← 启用后接管全系统流量
```

这两项正是本扩展的替代目标，任一启用时扩展无实际作用。

部分客户端在退出或重载配置时会**自动恢复系统代理**，验证前建议复查：

```bash
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable
```

结果应为 `0x0`。

## 验证

在安装了 LostProxy 的浏览器与**未安装的另一个浏览器**中同时打开
<https://ipinfo.io/ip>：

```text
LostProxy 关闭 → 两个 IP 相同
LostProxy 启用 → 两个 IP 不同   ← 作用域隔离成立
```

不要与固定 IP 比对，机场节点会变化，只需确认两个结果是否不同。

## 从源码构建

```bash
npm install
npm run build      # 产出 dist/（Edge / Chrome）与 dist-firefox/
```

随后按上文安装步骤，选择 `dist/` 或 `dist-firefox/`（不是项目根目录）。
修改代码后重新构建，并在扩展管理页点击**刷新**。

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 两个平台的完整构建 |
| `npm run watch` | 监听重建界面 |
| `npm run watch:sw` | 监听重建背景脚本（需另开终端） |
| `npm run test` | 单元测试 |
| `npm run verify` | typecheck + test + build |
| `npm run package` | 打出两个可分发 zip 至 `release/` |
| `npm run sign:firefox` | 提交 AMO 签名，取回可长期安装的 `.xpi` |

技术栈为 TypeScript + Vite 8（Rolldown）+ Vitest，界面使用原生 HTML/CSS，
无 UI 框架，无运行时依赖。每个平台需两趟构建的原因及其他非显然之处见
[DESIGN.md](DESIGN.md#构建)。

## 已知限制

- 浏览器自身的账号同步、搜索建议、Copilot 同样走代理。这是浏览器级代理的
  预期行为，但可能触发账号风控。
- 仅支持 HTTP 与混合端口，不支持直接使用 SOCKS 端口。
- 未实现上游代理的用户名密码认证。
- 企业或校园 Policy 控制代理设置时无法启用，扩展优先级低于 Policy。
- 与其他代理扩展冲突时拒绝启用并提示占用方，不强制覆盖。
- **不支持 Firefox for Android。** `proxy.settings` 在该平台未实现
  （Bugzilla 1725981），而扩展的所有代理写入均依赖它。AMO 未将其标记为
  Android 兼容，但**没有任何 manifest 键能阻止在 Android 上安装**，
  强行安装后开关会报 `proxy.settings is not supported on android`
  （[详细说明](DESIGN.md#版本下限与-android)）。
- QUIC / HTTP3 是否绕过代理、隐私窗口的实际出口 IP，**均未实测**，
  属于待验项而非已验证保证。

### 平台差异

功能完全一致。两处操作差异均源自浏览器 API 本身：

1. **需授予「在隐私窗口中运行」**（见安装第 2 步）。
2. **规则分流需额外授权一次。** Firefox 不支持内联 PAC，分流只能由扩展
   逐请求判断，即浏览器将每个网址交给扩展评估，这需要「访问所有网站」权限。
   入口位于**设置页 → 直连规则 → 「允许逐请求判断」**。拒绝则继续使用
   全局代理，授予后可随时在 `about:addons` 中收回。

   默认仅申请 `http://127.0.0.1/*`，因此仅使用全局代理的用户无需为一项
   可选功能交出该权限（[取舍依据](DESIGN.md#firefox-的可选权限)）。

## 设计文档

fail-closed 的取舍、两个平台的代码为何必须分开、「内置 Core」方案为何放弃，
连同实现过程中的具体问题，均记录在 [DESIGN.md](DESIGN.md)。

## 许可协议

[MIT](LICENSE)
