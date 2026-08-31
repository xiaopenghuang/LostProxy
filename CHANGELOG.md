# Changelog

本文件的每个版本小节会被 `.github/workflows/release.yml` 提取，作为 GitHub Release
说明里的「本次变更」部分。**小节标题格式必须是 `## vX.Y.Z`**，否则提取不到。

Each version section below is extracted by `.github/workflows/release.yml` and becomes the
"what changed" part of the GitHub Release notes. **Headings must be `## vX.Y.Z`.**

---

## v0.4.0

Firefox 支持。业务逻辑与界面完全共享，浏览器差异关在一层抽象里。
Firefox support. All business logic and UI shared; browser differences confined to one layer.

### 新增 / New

- **Firefox 版**（`lostproxy-firefox-v0.4.0.zip`，Firefox 128+）。代理开关、节点切换、
  延迟测试、订阅刷新、WebRTC 锁全部可用。安装方式与 Chromium 版不同，见 README。
  **Firefox build** with the proxy toggle, node switching, latency testing, subscription refresh
  and the WebRTC lock. Installation differs from the Chromium build — see the README.
- 两个包**不能混用**。Firefox 与 Chromium 的代理 API 完全不同，装错的表现是
  「装上了但代理压根没生效」而浏览器不报错。Release 页面按浏览器标注了下载。
  The two archives are **not interchangeable**; the wrong one silently proxies nothing.

### Firefox 版与 Chromium 版的三处行为差异 / Three behavioural differences

- **必须授予「在隐私窗口中运行」。** Firefox 规定代理设置对隐私窗口与普通窗口同时生效，
  因此不给这个权限就完全不允许扩展改代理。没给时扩展会告诉你去哪儿开，
  **不会**显示成已开启。反过来说，Chromium 上靠 `scope: 'regular'` 换来的
  「InPrivate 也走代理」在 Firefox 上是默认行为。
  **Private-window access is required** — Firefox refuses proxy changes without it. LostProxy says
  where to enable it instead of showing a false ON.
- **不支持智能分流。** Firefox 的 `proxy.settings` 只支持 `autoConfigUrl`，没有内联 PAC。
  用 URL 投递脚本会重新引入「取不到脚本就静默直连」，与本项目的 fail-closed 取向相反。
  所以开着分流模式时**拒绝开启并说明**，而不是悄悄按全局代理处理 ——
  后者会让你配的直连清单被无声忽略。把这些规则写进 Mihomo 配置反而更好。
  **No rule-based routing**: refused with an explanation rather than silently downgraded to global.
- **运行时错误信号更弱。** Firefox 的 `proxy.onError` 不带 `fatal` 字段，
  无法区分「请求被拦住了（没泄漏）」与「已经直连出去了（可能泄漏）」。
  此时报一条可自愈的告警、不对是否泄漏做任何承诺 —— 而不是一律按最坏情况报警，
  因为那会训练用户点掉这类告警，连真正的泄漏警告一起点掉。
  **Weaker runtime error signal**: no `fatal` field, so the alert promises nothing either way.

### 内部 / Internals

- 浏览器差异集中到 `src/background/platform/`，由**构建期**常量选择实现，不做运行期嗅探。
  产物里只有一个平台的代码 —— 这让「Firefox 包里不该出现 `disable_non_proxied_udp`」
  成为一条可断言的事实，而它守的是本项目最危险的一处差异：自 Firefox 70 起
  该值在 Firefox 上退化成「有代理才强制」，抄过去会被**接受**、**不报错**、防护**更弱**。
  这条断言在单元测试与**已解压的发布 zip** 上各验一次。
- `proxy.ts` / `privacy.ts` 现在零浏览器 API 调用，只剩决策。
  出现一次 `chrome.` 调用会让测试变红 —— 因为这类错误在 Edge 上完全正常、
  只在 Firefox 上炸，而开发时手边通常只有一个浏览器。
- 单元测试 917 → 994 项。新增 Firefox 平台测试 50 项（用**独立的 Firefox 形状 mock**，
  复用 Chromium 的会把要防的差异抹平）与产物级断言。
  四个「抄过去也能跑但是错的」陷阱各做过反向验证。

### 尚未完成 / Not yet done

- **Firefox 真机隔离测试。** 目前只有单元测试覆盖，`docs/test-plan.md` §6.5 列了 10 项
  只有真机能验的检查，其中出口 IP 隔离与 fail-closed 两项决定这个移植是否真的成立。
  Chromium 侧的 18/18 验收不自动适用于 Firefox。
  **Real-machine egress isolation on Firefox is unverified** — a known open item, not a guarantee.

---

## v0.3.0

延迟显示、智能分流、订阅刷新、端口自动探测，以及两个界面的重排。
Latency display, rule-based routing, subscription refresh, port detection, and a rebuild of both UIs.

### 新功能 / New

- **节点延迟**：节点列表直接显示延迟，打开 Popup 时**不产生任何额外请求** ——
  数据来自内核自己健康检查产生的记录。测速只在你点「测速」时才发，
  且用组测速让内核并发处理。
  **Node latency** shown in the list at no extra request — the data comes from the core's own
  health checks. Explicit testing happens only on demand.
- **智能分流**：全局 / 智能 / 直连三档。智能模式下直连清单里的域名绕过代理，
  其余走代理。清单支持通配符（`*.edu.cn`）与中文域名（自动转 Punycode）。
  **Rule-based routing**: global / smart / direct. In smart mode the hosts you list bypass the
  proxy. Wildcards and internationalised domains are both supported.
- **订阅刷新**：列出内核里的订阅并一键更新。增删做不到 ——
  内核刻意不通过 API 开放配置文件写入，请在客户端里操作。
  **Subscription refresh**: list and refresh. Adding and removing are not possible; the core
  deliberately does not expose config writes over its API.
- **端口自动探测**：Settings 里一键探测 Controller 端口。「端口填错」是实测最常见的
  失败原因，而它的症状完全不指向真实原因。只试已知客户端的公开默认值，
  探到了只填进输入框、不自动保存。
  **Port detection** for the controller, since a wrong port was the most common real failure and
  its symptoms point nowhere near the cause. It fills the field rather than saving.

### 界面 / UI

- Popup 加宽到 380px 并分「状态 / 节点」两个标签。**开关、告警、
  「系统代理未修改」那两行承诺留在标签容器之外** —— 切标签不该让你
  看不到代理开没开，也不该把安全告警藏进未选中的标签。
  The popup gains tabs; the toggle, alerts and the untouched-system promises stay outside them.
- Settings 加宽到 920px、卡片两列、加了分组标题，保存栏固定在底部并提示
  「有改动尚未保存」。原来保存按钮在七张卡片之后，全标签页打开时在首屏之外。
  Settings gets a two-column grid and a fixed save bar; previously Save sat off-screen below
  seven cards with nothing indicating unsaved changes.
- 视觉设计由 Master 完成。此方只补了 `prefers-reduced-motion` ——
  唯一带动画的元素是告警框，而它可能显示「疑似已泄漏真实 IP」，
  对开启该设置的用户，动画期间那句话是读不清的。
  Visual design is Master's. Added `prefers-reduced-motion`: the one animated element is the
  alert, which may carry a leak warning.

### 修复 / Fixed

三个 bug 全部由真机测试发现，自动化测试当时是绿的：

- 🔴 **假 ON**：智能模式期望 PAC 但浏览器实际停在 `fixed_servers` 时，
  状态比对会穿透并误报"一致"—— UI 显示分流已生效，实际全部流量走代理。
  A false "consistent" report let smart mode look active while everything went through the proxy.
- 🔴 生成的 PAC 脚本含中文注释，被 Chromium 以「只接受 ASCII」拒绝整个写入。
  The generated PAC carried non-ASCII comments, so Chromium rejected the write outright.
- 🔴 `new URL()` 静默丢弃路径，使带路径的规则被当成整域直连 ——
  比用户要求的更多流量绕过代理。
  Paths were silently dropped, widening a rule's scope beyond what was asked for.

## v0.2.0

在插件里直接切换 Mihomo 节点，不用打开 Clash Verge。
Switch Mihomo nodes straight from the extension, without opening Clash Verge.

真机验收通过（`docs/test-plan.md` §5.5）：切换生效，且 Clash Verge 里的选中项跟着变 ——
后者同时确证了组名的 URL 编码正确，以及下面那条作用域披露属实。
Verified on a real machine: the switch lands, and Clash Verge's selection follows — which also
confirms group-name URL encoding works and that the scope disclosure below is factual.

- 在 Popup 里直接查看和切换 Mihomo 策略组的节点，不用打开 Clash Verge。
  View and switch the nodes of a Mihomo policy group directly in the popup.
- Settings 新增「主策略组」，列表从内核实际返回的组里选。**不猜组名** ——
  不同机场组名各异，猜错会表现为「功能是坏的」（技术方案 §16 禁止硬编码）。
  Settings gains a primary proxy group picker, populated from the core. Group names are never
  guessed: they differ between providers and a wrong guess looks like a broken feature.
- 🔴 **作用域披露**：切换节点改的是**内核的全局状态**，所有在用这个内核的程序都会跟着变 ——
  与只影响本浏览器的代理开关不同。Popup 里对此有明示，理由见 `architecture.md` ADR-28。
  **Scope disclosure**: switching a node changes the core itself, so anything else using that core
  is affected too — unlike the proxy toggle, which only affects this browser. The popup says so.
- 不预先过滤策略组类型，能否手动切换由内核判定（ADR-29）：URLTest / Fallback 这类组
  在新内核上可能可切，客户端复刻判定规则必然过时，且过滤失败是无声的。
  Group switchability is decided by the core, not pre-filtered client-side (ADR-29).
- 组读取失败与代理告警是两个独立字段：一次「组名不存在」**不会**顶掉尚未确认的泄漏告警。
  Group failures never displace an unacknowledged leak warning.
- 新增 Popup 的 DOM 测试：在 happy-dom 里加载**真实的** `index.html` 与 `style.css`，
  把原本 15 项手工检查里的 13 项自动化掉，人工只剩「能不能真的切」与
  「Clash Verge 里跟着变没有」两条。落地当场抓到一个真 bug ——
  切换失败时错误提示会闪一下就被下一次渲染擦掉。
  Adds DOM tests for the popup against the real HTML and CSS, replacing 13 of 15 manual checks.
  They immediately caught a real bug: a failed switch flashed its error and lost it.

## v0.1.1

**扩展代码与 v0.1.0 完全相同（`src/` 逐字节一致）。已经装了 v0.1.0 的话不需要重装。**

**The extension code is identical to v0.1.0 (`src/` is byte-for-byte the same). If you already
have v0.1.0 installed, there is nothing to reinstall.**

这一版改的是分发方式，不是功能 / This release changes how it is distributed, not what it does:

- 产物改由 GitHub Actions 从 tag 构建，并带 Sigstore 签名的 SLSA 来源证明。可以用
  `gh attestation verify` 确认 zip 出自本仓库的公开构建，而不是谁手动传上来的。
  Artifacts are now built by GitHub Actions from the tag, with a Sigstore-signed SLSA provenance
  attestation. `gh attestation verify` confirms the zip came from a public build of this
  repository rather than someone's upload.
- 新增 `npm run package`：本地和 CI 用同一条代码路径打包，产物一致。
  Added `npm run package`, so a local build and CI produce the artifact by the same code path.
- 打包时强制校验 git tag / `manifest.json` / `package.json` 三处版本号一致，以及
  `manifest.json` 引用的每个文件都在包内。
  Packaging now refuses to proceed when the git tag, `manifest.json` and `package.json` disagree
  on the version, or when `manifest.json` references a file the archive lacks.
- README 补上从 Release 安装的步骤，并说明为什么没有双击安装包。
  README documents installing from a release, and why there is no double-click installer.

v0.1.0 的资产保持原样，其说明里记录的 SHA-256 对那个文件依然正确。
v0.1.0's asset is left as published; the SHA-256 in its notes remains correct for that file.

---

## v0.1.0

首个版本。把代理的作用域收窄到一个浏览器。
First release. Narrows the proxy's scope to a single browser.

- 只写 `chrome.proxy`：不改 Windows 系统代理、不写注册表、不开 TUN、不改路由表、不要管理员权限。
  Writes `chrome.proxy` only: no system proxy, registry, TUN, routing table or elevation.
- Fail-closed：代理不可用时中止请求，而不是静默退回直连泄漏真实 IP。
  Fail-closed: aborts rather than silently falling back to DIRECT and leaking the real IP.
- 开启代理时把 WebRTC 锁进代理（`disable_non_proxied_udp`，IETF Mode 4）。
  Locks WebRTC into the proxy while enabled (`disable_non_proxied_udp`, IETF Mode 4).
- Mihomo Controller 三态显示；探不通只是灰点，不是告警。
  Tri-state Mihomo Controller display; unreachable is a gray dot, not an alert.
- Controller Secret 只存 `chrome.storage.local`，不同步、不打日志、不回显。
  Controller Secret stays in `chrome.storage.local`: never synced, logged or echoed.
- 中英双语即时切换。464 项单元测试。
  Instant Chinese/English switching. 464 unit tests.
