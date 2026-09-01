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

## 下载哪一个 / Which download

| 浏览器 / Browser | 文件 / File | |
| --- | --- | --- |
| Edge / Chrome | `lostproxy-v__VERSION__.zip` | 解压后「加载解压缩的扩展」 |
| **Firefox** | **`lostproxy-firefox-v__VERSION__.xpi`** | **签过名，直接装，重启不掉** |
| Firefox（临时） | `lostproxy-firefox-v__VERSION__.zip` | 只能 `about:debugging` 临时载入 |

Chromium 与 Firefox 的包**不能混用** —— 两者的代理 API 完全不同，
装错的表现是「装上了但代理压根没生效」而浏览器不报错。
The Chromium and Firefox builds are **not interchangeable** — the proxy APIs differ entirely,
and the wrong one silently proxies nothing.

**Firefox 用户请下 `.xpi`。** 它由 Mozilla 签名，可以从 `about:addons` 直接安装并长期使用。
那个 `.zip` 只能临时载入、关掉浏览器就消失 —— 它留在这里是因为它由 CI 构建、带 Sigstore
来源证明，想核对可复现性的人用得上。

⚠️ `.xpi` **不会自动更新**：它走自分发渠道、在 AMO 上搜不到，因此 Firefox 没有更新源可查。
升级需要回来手动下载。

**Firefox users want the `.xpi`** — Mozilla-signed, installs from `about:addons`, survives
restarts. The `.zip` can only be loaded temporarily and vanishes when Firefox closes; it stays
here because it is the CI-built artifact carrying Sigstore provenance, for anyone verifying
reproducibility. Note the `.xpi` **does not auto-update**: it is self-distributed and unlisted,
so Firefox has no update source to check.

## 安装：Edge / Chrome

1. 下载 `lostproxy-v__VERSION__.zip` 并**解压**（解压后 `manifest.json` 应在文件夹根目录）
2. 打开 `edge://extensions`
3. 打开左下角 **开发人员模式 / Developer mode**
4. 点 **加载解压缩的扩展 / Load unpacked**，选**解压出来的那个文件夹**
5. 到 ⚙ Settings 填入你的代理端口 —— **别用默认的 7890**，Clash Verge Rev 实际是 `7897`

> 第 5 步是最容易失败的地方。README 里有一张各客户端实际端口的对照表。
> Step 5 is where most setups fail; the README has a table of what each client actually uses.

## 安装：Firefox

1. 下载 `lostproxy-firefox-v__VERSION__.xpi`（**不用解压**）
2. 打开 `about:addons` → 右上**齿轮图标** → **从文件安装附加组件 / Install Add-on From File**
3. 🔴 点开 LostProxy → 把 **在隐私窗口中运行 / Run in Private Windows** **打开**
4. 到 ⚙ Settings 填代理端口（同上）
5. 想用智能分流的话：设置页 → 直连规则 → 点 **允许逐请求判断**

> 第 5 步只有用分流才需要。Firefox 不支持内联 PAC，分流只能由扩展逐个请求判断 ——
> 也就是浏览器会把每个网址问一遍，所以要这个权限。不给就继续用全局代理，
> 给了随时能在 `about:addons` 里收回。
>
> Step 5 is only needed for rule-based routing. Firefox has no inline PAC, so routing works by
> asking the extension per request — hence the permission. Decline and global proxying still works.

> **第 4 步不是可选的。** Firefox 规定：代理设置对隐私窗口与普通窗口同时生效，
> 因此不给这个权限就**完全不允许**扩展改代理。没开的话扩展会明确告诉你，
> 不会假装已经开好了。
>
> **Step 4 is not optional.** Firefox refuses proxy changes without private-window access,
> because proxy settings affect both window types. LostProxy will tell you instead of
> pretending it worked.

> **临时载入的扩展在关闭 Firefox 后会消失。** 这是 Firefox 对未签名扩展的规定，
> 不是本扩展的限制。要永久安装需要走 AMO 签名。
> Temporary add-ons are removed when Firefox closes — a Firefox rule for unsigned extensions.

## 校验 / Verify

```
Edge / Chrome  .zip   __SHA256__
Firefox        .zip   __FIREFOX_SHA256__
```

`.xpi` 的哈希在资产列表里的 `lostproxy-firefox-v__VERSION__.xpi.sha256`。
它不在上面这份清单里，是因为签名是**发布之后**的手动步骤（要等 AMO 审核），
生成这段说明时它还不存在。
The `.xpi` hash is in its own `.sha256` asset — signing happens after the release is created,
since it waits on AMO, so it is not in the list above.

```bash
sha256sum lostproxy-v__VERSION__.zip                      # Linux / macOS / Git Bash
certutil -hashfile lostproxy-v__VERSION__.zip SHA256      # Windows cmd
```

**两个 `.zip`** 由 GitHub Actions 从 commit `__COMMIT__` 构建，并带 Sigstore 签名的来源证明 ——
可以验证它们确实来自本仓库的这次构建，而不是谁手动传上来的：

```bash
gh attestation verify lostproxy-v__VERSION__.zip         --repo xiaopenghuang/LostProxy
gh attestation verify lostproxy-firefox-v__VERSION__.zip --repo xiaopenghuang/LostProxy
```

**`.xpi` 的来源不同，说明一下。** 它由 Mozilla 签名（这是它能长期安装的原因），
但**在维护者本机构建**，所以**没有**上面那份 CI 来源证明。它的内容与
`lostproxy-firefox-v__VERSION__.zip` 逐个文件一致 —— 只差一个被 AMO 重新格式化过的
`manifest.json` —— 所以想核对的话把两个都下来解开比一比即可：

```bash
mkdir a b && unzip -q lostproxy-firefox-v__VERSION__.zip -d a && unzip -q lostproxy-firefox-v__VERSION__.xpi -d b
diff -r a b --exclude=META-INF     # 只应看到 manifest.json 的格式差异
```

`META-INF/` 是 Mozilla 的签名，只在 `.xpi` 里有。

The two `.zip` files are built by GitHub Actions from commit `__COMMIT__` with Sigstore-signed
provenance. The `.xpi` is signed by Mozilla — which is what makes it permanently installable —
but built on the maintainer's machine, so it carries **no** CI attestation. Its contents match the
Firefox `.zip` file for file apart from a `manifest.json` that AMO reformats, so you can diff the
two as above. `META-INF/` is Mozilla's signature and exists only in the `.xpi`.

代理工具值得做这一步。也可以 `npm ci && npm run package` 自己从源码构建。
Worth doing for a proxy tool. You can also build it yourself with `npm ci && npm run package`.

## 本次变更 / What changed

__CHANGES__

## 这个版本做了什么 / What it does

- **作用域限于本浏览器** — 只写 `chrome.proxy`，不改 Windows 系统代理、不写注册表、不开 TUN、
  不改路由表、不要管理员权限。实测同机两个浏览器可处在不同网络出口，ASN 完全不同。
- **Fail-closed** — 代理不可用时中止请求，而不是静默退回直连泄漏真实 IP。
  真机实测 `onProxyError.fatal === true`（已中止，未泄漏）。
- **WebRTC 一并锁进代理** — Chromium 上设 `disable_non_proxied_udp`（IETF Mode 4），
  Firefox 上设 `proxy_only`。浏览器默认策略**不会**强制 WebRTC 走代理，
  UDP 会绕过 HTTP 代理暴露真实 IP。
  两个平台用不同的值不是笔误：自 Firefox 70 起 `disable_non_proxied_udp` 在那边
  退化成「有代理才强制」，抄过去会被接受、不报错、防护更弱。
- **凭据只留本机** — Controller Secret 不进 `chrome.storage.sync`、不打日志、不回显。
- **卸载即完全撤销** — 由浏览器自动清除代理设置，不留下要手工修的坏状态。
- **中英双语即时切换。**

## 要求 / Requirements

- Edge / Chromium **120+**，或 Firefox **128+**
- 本机运行中的 Mihomo / Clash 内核，且**混合端口或 HTTP 端口**（不能是 SOCKS 端口）
- 内核侧建议 `System Proxy = OFF`、`TUN = OFF` —— 开着的话本扩展就没有存在意义了

## 已知限制 / Known limitations

- Edge 自身的账号同步、搜索建议、Copilot 也会走代理（浏览器级代理的预期行为，可能触发账号风控）
- 不支持 SOCKS 端口，不支持需要用户名密码认证的上游代理
- **Firefox 版的智能分流需要一次额外授权。** Firefox 不支持内联 PAC，分流走
  `proxy.onRequest` —— 浏览器对每个请求问扩展一次，因此扩展能看到你访问的每个网址，
  Firefox 必须先征得同意。第一次切到「智能」时弹一次，不给就继续用全局，
  给了随时能在 `about:addons` 收回。刻意**不**在安装时一次要掉：默认只要
  `http://127.0.0.1/*` 本身是这个项目的卖点，不该让只用全局代理的人替一个
  可选功能付这个代价。
  Smart routing on Firefox asks for one permission the first time you enable it,
  because that browser has no inline PAC and must consult the extension per request.
- **Firefox 版的运行时错误信号更弱**：`proxy.onError` 不带 `fatal` 字段，
  因此无法像 Chromium 那样区分「请求被拦住了」与「已经直连出去了」。
- Firefox 真机隔离测试**尚未完成** —— Chromium 侧已实测双浏览器不同出口 ASN，
  Firefox 侧目前只有单元测试覆盖。
- QUIC / HTTP3 是否绕过代理、InPrivate 窗口的实际出口 IP：**均未实测**
- 企业 / 校园 Policy 控制代理设置时无法开启（扩展优先级低于 Policy，平台规则）
- 与其他代理扩展冲突时会拒绝开启并说明是谁在控制，不强行覆盖（已真机验证）。
  When another proxy extension holds the setting, LostProxy refuses to enable and names what is
  in control rather than overriding it (verified on a real machine).

完整说明见 [README](https://github.com/xiaopenghuang/LostProxy#readme) ·
[English](https://github.com/xiaopenghuang/LostProxy/blob/main/README.en.md)
