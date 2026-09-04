# Changelog

本文件的每个版本小节会被 `.github/workflows/release.yml` 提取，作为 GitHub Release
说明里的「本次变更」部分。**小节标题格式必须是 `## vX.Y.Z`**，否则提取不到。

Each version section below is extracted by `.github/workflows/release.yml` and becomes the
"what changed" part of the GitHub Release notes. **Headings must be `## vX.Y.Z`.**

---

## v0.5.0

节点列表现在标注每个节点的协议。数据本来就在已有的响应里，所以不多发一个请求。
The node list now labels each node's protocol, at no added network cost.

### 新增 / New

- **节点列表标注协议**（`VLESS` / `HY2` / `Trojan` / `SS` …）。机场常给同一地区的节点
  起近乎相同的名字（`…|SAK-1` 一路到 `…|SAK-8`），光看名字分不出协议，
  而协议决定它在受干扰网络下的表现。
  **Each node now shows its protocol.** Providers often name same-region nodes almost
  identically, which left the protocol invisible.

- **不额外发请求。** 协议取自 `/proxies` 响应里每个节点自带的 `type` 字段，而那份响应
  扩展本来就在请求（为了读延迟用的 `history`）。现在同一份响应解析一遍喂给两个抽取
  函数，请求数不变 —— 与 ADR-32「延迟显示不触发测速」同一条理由。
  **Zero added network cost** — `type` comes from the same `/proxies` response already
  fetched for latency.

- 缩写表**不是白名单**：表里没有的协议显示内核原文。内核每加一个协议都会出现一个新
  `type`，当白名单用会让新协议**静默消失** —— 显示一个没缩写的名字比显示空白有用。
  嵌套的策略组与内置出口（`DIRECT` / `REJECT`）不显示徽章，但仍占住那一列，
  否则那一行的延迟会挪到前一列、整列数字失去对齐。
  Unknown protocols fall back to the core's own wording rather than vanishing.

---

## v0.4.2

打包层面的两处修复。**扩展的功能一行没改。**
Two packaging-level fixes. **No functional change.**

> **v0.4.1 请不要用** —— 它的 manifest 里有个错的 `gecko_android` 键，
> 那实际上是在向 AMO **宣称支持 Firefox for Android**，而
> `proxy.settings` 在那上面根本不存在。AMO 拒收了那次提交，
> 所以 **v0.4.1 没有签好的 `.xpi`**。
>
> 对桌面用户它是无害的（`gecko_android` 在桌面被忽略），但它不可签名、
> 且语义是错的。v0.4.2 取代它。
>
> **Skip v0.4.1** — its manifest declared Android compatibility that does not
> work, AMO rejected the submission, and it therefore has no signed `.xpi`.
> Harmless on desktop, but superseded.

### 修复 / Fixed

- 🔴 **设置页显示错的版本号。** `index.html` 里硬编码着 `v0.2.0`，所以从 V0.3 起
  一直显示错的 —— 穿过两次发布都没人发现。改成运行时从 manifest 读，
  而 manifest 是版本号的单一真源（打包脚本有闸门保证它与 `package.json` 一致），
  这样不可能再漂。
  **The settings page showed the wrong version** — hardcoded since V0.3. It now reads
  the manifest at runtime.

- **`strict_min_version` 128 → 140**，清掉 `addons-linter` 关于桌面版的那条警告。
  `data_collection_permissions` 是必需的（Mozilla 自 2025-11-03 起要求），
  而它只在 Firefox 140+ 被支持，低于 140 时会被静默忽略。

  原先定 128 是因为"抬到 140 会丢掉一批用户"，而那个判断已经不成立：
  **ESR 128 于 2025-09-16 停止支持**，当前 ESR 是 140，正式版在 153 以上 ——
  128–139 之间没有任何还在支持的版本。
  Raised to 140, the first version supporting `data_collection_permissions`.
  ESR 128 reached EOL in September 2025, so the range being dropped is empty.

  ⚠️ 关于 Android 的那条警告**留着**，清它只有两条路而两条都不该走：
  声明 `gecko_android` 等于**谎称支持 Android**（`proxy.settings` 在那上面
  不存在），而把下限抬到 142 会排除 **ESR 140** —— 当前 ESR，
  校园网正是 ESR 用户最集中的场景。详见 `DESIGN.md`。
  The Android warning stays: clearing it would mean either claiming Android support
  that does not exist, or dropping ESR 140.

### 内部 / Internals

- 三道新闸门，各自反向验证过：构建目标必须与 manifest 下限对齐（两个文件里的
  同一个数字）、**不得声明 `gecko_android`**（声明它等于宣称支持 Android）、
  `data_collection_permissions` 必须存在且下限支持它。
  外加一条：界面 HTML 里不许出现版本号字面量。
- README 从 389 行瘦到 201 行，论证移进新增的 `DESIGN.md` ——
  原先它读起来像设计报告而不是介绍。
- 新增 `npm run sign:firefox`：提交 AMO 签名并取回可长期安装的 `.xpi`。
  Firefox 的 Release 版一律强制扩展签名，所以 `.zip` 只能临时载入、重启即失效。

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

### Firefox 版与 Chromium 版的行为差异 / Behavioural differences

- **必须授予「在隐私窗口中运行」。** Firefox 规定代理设置对隐私窗口与普通窗口同时生效，
  因此不给这个权限就完全不允许扩展改代理。没给时扩展会告诉你去哪儿开，
  **不会**显示成已开启。反过来说，Chromium 上靠 `scope: 'regular'` 换来的
  「InPrivate 也走代理」在 Firefox 上是默认行为。
  **Private-window access is required** — Firefox refuses proxy changes without it. LostProxy says
  where to enable it instead of showing a false ON.
- **智能分流需要一次额外授权，入口在设置页。** Firefox 的 `proxy.settings`
  只支持 `autoConfigUrl`、没有内联 PAC，所以分流走 `proxy.onRequest` ——
  浏览器对**每个请求**问扩展一次「走代理还是直连」。这意味着扩展能看到你访问的
  每一个网址，所以 Firefox 必须先征得同意。到**设置页 → 直连规则 → 「允许逐请求判断」**
  授权，不给就继续用全局代理，给了之后随时能在 `about:addons` 里收回。

  授权按钮放在设置页而不是"切到智能时弹窗"，是因为 Firefox 只允许
  `permissions.request()` 从真正的用户输入回调里调用（背景脚本处理消息明确不算，
  手势也活不过一次 `await`），而从 popup 请求会撞上一个仍未修复的 Firefox bug ——
  授权弹窗出现在 popup **背后**且点不到（Bugzilla 1798454）。

  刻意**不**在安装时一次要掉：默认只要 `http://127.0.0.1/*` 本身是这个项目的
  一项卖点 —— 权限面小意味着即便扩展被攻破，能拿到的东西也有限。
  让只用全局代理的人替一个可选功能付这个代价是亏的。

  顺带一提，这条路**比 PAC 更干净**：规则从来不变成代码，所以 Chromium 版里
  那整套 PAC 注入防御（字符白名单、`JSON.stringify` 序列化、纯 ASCII 校验）
  在 Firefox 上根本不需要。
  Smart routing asks for one permission the first time you enable it, because
  Firefox has no inline PAC and must consult the extension per request.
- **运行时错误的含义相反，所以告警更重。** Firefox 的 `proxy.onError` 不带
  `fatal` 字段，但那不是"信息更少" —— 按 Bugzilla 1528873（Mozilla 标记 WONTFIX、
  认定是预期行为），`proxy.onRequest` 出错时请求会**照常直连出去**，
  只是会触发 `onError`。所以在 Firefox 上收到这个事件**就意味着已经漏过一次**，
  报的是那条不会自动消失、需要你手动确认的泄漏告警。
  **Runtime errors mean the opposite here**: per Bugzilla 1528873 an `onRequest`
  failure lets the request go direct, so `onError` firing means a leak already
  happened — LostProxy raises the non-self-healing leak alert.

### 内部 / Internals

- 浏览器差异集中到 `src/background/platform/`，由**构建期**常量选择实现，不做运行期嗅探。
  产物里只有一个平台的代码 —— 这让「Firefox 包里不该出现 `disable_non_proxied_udp`」
  成为一条可断言的事实，而它守的是本项目最危险的一处差异：自 Firefox 70 起
  该值在 Firefox 上退化成「有代理才强制」，抄过去会被**接受**、**不报错**、防护**更弱**。
  这条断言在单元测试与**已解压的发布 zip** 上各验一次。
- `proxy.ts` / `privacy.ts` 现在零浏览器 API 调用，只剩决策。
  出现一次 `chrome.` 调用会让测试变红 —— 因为这类错误在 Edge 上完全正常、
  只在 Firefox 上炸，而开发时手边通常只有一个浏览器。
- 单元测试 917 → 1076 项。新增 Firefox 平台测试（用**独立的 Firefox 形状 mock**，
  复用 Chromium 的会把要防的差异抹平）与产物级断言。
  每个「抄过去也能跑但是错的」陷阱都做过反向验证：先把错误改回去，
  确认测试真的会红，再恢复。
- **索取可选权限整个移出了平台契约**（`BrowserPlatform` 里刻意没有
  `requestPermissions`）。它只能发生在设置页的点击回调里，
  而且回调内在 `request()` 之前不能有任何 `await` —— 这两条约束都由
  产物级断言守着：两个背景产物里都不许出现 `permissions.request`。
  详见 ADR-39。

### 尚未完成 / Not yet done

- ✅ **Firefox 真机隔离测试已通过**（2026-08-31）。`docs/test-plan.md` §6.5 全部通过，
  其中决定移植成立与否的两项：X0b（装了的走代理、没装的不走）与
  X3（停掉内核后页面打不开、不静默直连）。后者尤其值得记 ——
  Chromium 靠 `mandatory: true` 兜的那一层在 Firefox 上没有对应物，
  所以这不是同一个结论的复测，而是第二个独立结论。
  **Real-machine egress isolation and fail-closed both verified on Firefox.**

- 🔴 **Firefox for Android 上装得上，但必然全废 —— 下个版本必须修。**
  `proxy.settings` 在 Android 上**根本没实现**（Bugzilla 1725981 至今开着，
  实报 `proxy.settings is not supported on android.`），而我们的
  `applyProxy` / `releaseProxy` / `readProxyState` 全走它。

  manifest 没拦住：只声明了 `gecko.strict_min_version`，没有 `gecko_android`，
  于是 Android 继承同一个下限、被标成兼容。用户装上得到一个开关点不动的扩展。

  修法是声明 `gecko_android.strict_min_version` 为一个不可能满足的版本。
  本版不修的原因纯粹是流程：改 manifest 就得重签，而 `0.4.0` 在 AMO 上
  是一次性的，得 bump 版本再走一轮审核。
  **Firefox for Android is silently broken** — `proxy.settings` does not exist
  there, and nothing in the manifest prevents installation. Fix pending in the
  next release.

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
