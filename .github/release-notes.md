只让装了它的这一个浏览器走本机代理，系统其余部分保持原样。
Routes only the browser it is installed in through your local proxy, leaving the rest of the machine alone.

---

## ⚠️ 先看这里 / Read this first

**这不是一个双击就能装的安装包。** Chromium 从 URL 下载 `.crx` 会直接拒绝
（`CRX_REQUIRED_PROOF_MISSING`），所以浏览器扩展在商店之外只有「加载解压缩」这一条路。

**This is not a double-click installer.** Chromium rejects `.crx` files downloaded from a URL
(`CRX_REQUIRED_PROOF_MISSING`), so outside the store the only route is "load unpacked".

**另外，装上它本身不会让你能上网。** 本扩展只负责把浏览器的流量交给你**本机已经跑着的**
Mihomo / Clash 内核。没有内核在跑，开启后网页会打不开 —— 这是刻意设计的 fail-closed，
不是 bug。

**Also, installing this alone does not get you connected.** It only hands the browser's traffic
to a Mihomo/Clash core **already running on your machine**. With no core running, pages will fail
to load once enabled — that is deliberate fail-closed behaviour, not a bug.

## 安装 / Install

1. 下载 `lostproxy-v__VERSION__.zip` 并**解压**（解压后 `manifest.json` 应在文件夹根目录）
2. 打开 `edge://extensions`
3. 打开左下角 **开发人员模式 / Developer mode**
4. 点 **加载解压缩的扩展 / Load unpacked**，选**解压出来的那个文件夹**
5. 到 ⚙ Settings 填入你的代理端口 —— **别用默认的 7890**，Clash Verge Rev 实际是 `7897`

> 第 5 步是最容易失败的地方。README 里有一张各客户端实际端口的对照表。
> Step 5 is where most setups fail; the README has a table of what each client actually uses.

## 校验 / Verify

```
SHA-256  __SHA256__
```

```bash
sha256sum lostproxy-v__VERSION__.zip                      # Linux / macOS / Git Bash
certutil -hashfile lostproxy-v__VERSION__.zip SHA256      # Windows cmd
```

这个包由 GitHub Actions 从 commit `__COMMIT__` 构建，并带 Sigstore 签名的来源证明。
可以用 GitHub CLI 验证它确实来自本仓库的这次构建，而不是谁手动传上来的：

Built by GitHub Actions from commit `__COMMIT__`, with a Sigstore-signed build provenance
attestation. Verify that it really came from this repository's build rather than an upload:

```bash
gh attestation verify lostproxy-v__VERSION__.zip --repo xiaopenghuang/LostProxy
```

代理工具值得做这一步。也可以 `npm ci && npm run package` 自己从源码构建。
Worth doing for a proxy tool. You can also build it yourself with `npm ci && npm run package`.

## 这个版本做了什么 / What it does

- **作用域限于本浏览器** — 只写 `chrome.proxy`，不改 Windows 系统代理、不写注册表、不开 TUN、
  不改路由表、不要管理员权限。实测同机两个浏览器可处在不同网络出口，ASN 完全不同。
- **Fail-closed** — 代理不可用时中止请求，而不是静默退回直连泄漏真实 IP。
  真机实测 `onProxyError.fatal === true`（已中止，未泄漏）。
- **WebRTC 一并锁进代理** — 开启时设 `disable_non_proxied_udp`（IETF Mode 4）。
  浏览器默认策略**不会**强制 WebRTC 走代理，UDP 会绕过 HTTP 代理暴露真实 IP。
- **凭据只留本机** — Controller Secret 不进 `chrome.storage.sync`、不打日志、不回显。
- **卸载即完全撤销** — 由浏览器自动清除代理设置，不留下要手工修的坏状态。
- **中英双语即时切换。**

## 要求 / Requirements

- Edge / Chromium **120+**
- 本机运行中的 Mihomo / Clash 内核，且**混合端口或 HTTP 端口**（不能是 SOCKS 端口）
- 内核侧建议 `System Proxy = OFF`、`TUN = OFF` —— 开着的话本扩展就没有存在意义了

## 已知限制 / Known limitations

- Edge 自身的账号同步、搜索建议、Copilot 也会走代理（浏览器级代理的预期行为，可能触发账号风控）
- 不支持 SOCKS 端口，不支持需要用户名密码认证的上游代理
- QUIC / HTTP3 是否绕过代理、InPrivate 窗口的实际出口 IP：**均未实测**
- 企业 / 校园 Policy 控制代理设置时无法开启（扩展优先级低于 Policy，平台规则）

完整说明见 [README](https://github.com/xiaopenghuang/LostProxy#readme) ·
[English](https://github.com/xiaopenghuang/LostProxy/blob/main/README.en.md)
