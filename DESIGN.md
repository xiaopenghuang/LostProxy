# 设计说明

README 讲怎么用，这里讲**为什么这么做**。都是实际遇到过的取舍，
不是事后补的论证 —— 其中好几条是真机上踩到之后才改的。

---

## Fail-closed

代理连不上时，扩展**中止请求**（浏览器报 `ERR_PROXY_CONNECTION_FAILED`），
而不是退回直连。

理由是两种失败的可见性完全不同：

| | 用户看到什么 | 后果 |
| --- | --- | --- |
| 中止请求 | 网页打不开 | 一眼就知道出问题了 |
| 退回直连 | 网页正常打开 | **真实 IP 已经发出去了，而他以为在走代理** |

后者是这个扩展最不能发生的事 —— 它的全部价值就是"你知道自己的流量走哪儿"。
宁可断网。

这条不只是意图，是实测过的：真机上代理不可达时 `onProxyError` 报
`fatal: true`（请求已中止、未泄漏），**没有**发生静默直连。Firefox 上也单独验过
（内核停掉后页面打不开）—— 而那是第二个独立结论，不是同一件事的复测，
因为 Chromium 靠 `mandatory: true` 兜的那一层在 Firefox 上没有对应物。

由此还牵出一条实现约束：Chromium 的 PAC 脚本**不写 `; DIRECT` 兜底**。
写了就等于把 fail-closed 作废 —— 代理连不上时会静默直连。
而 Firefox 的 `proxy.onRequest` 恰好**相反**，返回值必须以 `null` 结尾才安全：

| | 安全写法 |
| --- | --- |
| PAC | **不写** `; DIRECT`（写了才 fail-open） |
| `onRequest` | **必须写** `null` 结尾（不写就 fail-open） |

两个 API 的默认方向相反，照着一边的直觉写另一边一定会错。

---

## WebRTC 要单独锁

浏览器的默认策略**不会**强制 WebRTC 走代理 —— 页面可以通过 ICE 拿到真实
公网 / 内网 IP，完全绕过 HTTP 代理。不锁的话这个扩展的卖点自带一个缺口。

两个平台写的值不一样，而这**不是笔误**：

| | 值 |
| --- | --- |
| Chromium | `disable_non_proxied_udp` |
| Firefox | `proxy_only` |

自 Firefox 70 起（Bugzilla 1452713），同名的 `disable_non_proxied_udp`
在 Firefox 上退化成"有代理时才强制、没代理回落"。把 Chromium 的值抄过去会被
**接受**、**不报错**、而防护**更弱**。

这类差异没有任何编译期或运行期信号 —— 它只会在某个真实用户的某次通话里
泄漏一次真实 IP。这一行就是下面那整层抽象存在的直接理由。

锁的生命周期绑在代理开关上：只在代理开启时加锁。代理关着时锁 WebRTC 没有
保护意义（本来就是直连），却会实实在在降低通话质量（强制走 TCP）。

---

## 两个平台的代码必须分开

浏览器差异全部关在 `src/background/platform/` 里，由 Vite 的 `define` 在
**编译期**选择实现，所以每个产物里只有一个平台的代码。

**为什么不做运行期判断**：它不可靠 —— Edge 的 UA 里有 "Chrome"，
Firefox 也提供 `chrome.*` 命名空间。但更重要的是编译期分离带来一条
可断言的事实：**"Firefox 包里不该出现 `disable_non_proxied_udp`"**。
那条断言守的正是上面那处"抄过去也能跑但更不安全"的差异，而且它在
**已解压的发布 zip 上**也验一次 —— 因为发布出去的是 zip 里的东西。

同理，`proxy.ts` 与 `privacy.ts` 里出现一次 `chrome.` 调用就会让测试变红。
这类错误在 Edge 上完全正常、只在 Firefox 上炸，而开发时手边通常只有一个浏览器。

### Firefox 侧几个非显然的地方

**`httpProxyAll: true` 不能省。** MDN 原话是"Any omitted properties are reset to
their default value"，而 `httpProxyAll` 默认 `false`。只写 `{proxyType:'manual', http}`
会得到"HTTPS 去找未设置的 `ssl`，因而直连" —— 一个只影响 HTTPS 的静默泄漏。

**分流监听必须顶层注册。** Firefox 的 MV3 背景是**事件页**，空闲约 30 秒就卸载。
从业务流程里挂的监听会随之消失且没人重挂 —— 后果不是断网，而是用户的
直连清单**静默失效**：校内站点开始走代理，页面还能开，只是进不去校内资源。
在他眼里就是"这功能坏了"，且看不出与刚才闲置半分钟有任何关系。

**监听必须知道开关状态。** 它只看分流模式和规则，而那两样在用户关掉代理后
**并不会变**。漏了这一条会得到**反方向的欺骗**：UI 显示已关闭，而流量还在走代理。
比"以为开了其实没开"更隐蔽，因为不会有任何症状。

**`proxy.onError` 触发就意味着已经漏了。** Bugzilla 1528873（Mozilla 标记
WONTFIX、认定是预期行为）：`onRequest` 出错时请求会**照常直连出去**。
所以在 Firefox 上收到这个事件必须报"疑似泄漏"，而不是"请求已被阻止" ——
后者那句"你的真实 IP 没有泄漏"在这条路径上是**假的**。

---

<a id="firefoxs-optional-permission"></a>

## Firefox 的可选权限

智能分流需要 `<all_urls>`，因为 `proxy.onRequest` 要求过滤器是主机权限的子集。
它声明成 `optional_host_permissions`，只在用户真的要用分流时才索取。

**为什么不在安装时一次要掉**：默认只要 `http://127.0.0.1/*` 本身是这个项目的
一项卖点 —— 权限面小意味着即便扩展被攻破，能拿到的东西也有限。
让只用全局代理的人替一个可选功能付这个代价是亏的。

**为什么授权按钮在设置页，而不是切到「智能」时弹窗**：Firefox 有两道独立的限制。

1. `permissions.request()` 只能从**真正的用户输入回调**里调用，而 MDN 明确说
   背景脚本处理消息**不算**用户操作。
2. 即便在对的地方，"if a user input handler waits on a promise, then its status
   as a user input handler is **lost**"（Bugzilla 1398833，Mozilla 表示不打算像
   Chromium 那样跨 `await` 传递手势标记）。

第一版把索权放在背景层，同时撞上这两条 —— 症状是用户看到一句"要么在弹窗里允许"，
**而那个弹窗永远不会出现**。一个说明了修法却无法执行的错误提示，比不给提示更糟。

而从 popup 里请求会撞上第三个坑：授权弹窗出现在 popup **背后**且点不到
（Bugzilla 1798454，至今未修）。设置页是普通标签页，弹窗正常锚定。

顺带一提，`onRequest` 那条路**比 PAC 更干净**：规则从来不变成代码，
所以 Chromium 版里那整套 PAC 注入防御（字符白名单、`JSON.stringify` 序列化、
纯 ASCII 校验）在 Firefox 上根本不需要。

---

## 凭据与数据

全部存在 `chrome.storage.local`，三个键：设置、开关状态、最后一条错误。

**不用 `chrome.storage.sync`** —— Controller Secret 是本机凭据，同步到云端即为越界。
测试环境里 `storage.sync` 被替换成会抛异常的桩，防止将来有人手滑写进去。

Secret 不打日志、不回显（界面只显示"已保存"），有测试断言它不出现在任何
序列化过的对象里。

⚠️ 反过来提醒一句：Mihomo 默认 `external-controller-cors.allow-origins: ['*']`，
所以开了外部控制却**不设 secret**，任意网页都能用 JS 控制你的内核。
这与本扩展无关，但值得知道。

---

## 可观测性不等于可用性

Mihomo Controller 探不通只显示灰点，**不报警**。

多数 GUI 默认只开 named pipe 不开 HTTP 接口，此时代理走的是混合端口、
完全正常 —— 探不通不等于代理坏了。把这种情况报成错误，会在那些用户那里
产生一条**永久挂着**的告警，而代理明明在工作。

永久噪音会训练用户无视所有告警，比没有告警更糟。同理，告警会自愈：
恢复后自动清除，不需要手动点掉。只有"疑似泄漏"那一类保留人工确认 ——
因为它记录的是**已经发生过的事实**，悄悄清掉等于替用户决定这事不重要。

---

## 版本下限与 Android 排除

`manifest.firefox.json` 里两个值需要解释，而 JSON 写不了注释：

```json
"gecko":         { "strict_min_version": "140.0" }
"gecko_android": { "strict_min_version": "999.0" }
```

### 为什么桌面是 140

`data_collection_permissions` 是**必需的** —— Mozilla 自 2025-11-03 起要求所有
新提交的扩展声明它 —— 而它只在 **Firefox 140+**（Android 142+）才被支持。
下限低于 140 时 addons-linter 会各报一条警告。

原先定的是 128，因为那是 MDN 说的"仍能收到更新的最低版本"（根证书 2025-03 过期，
更早的 Firefox 认不出扩展签名）。当时判断是"抬到 140 会丢掉 128–139 一批用户"。

**那个判断在 2026-08 已经不成立**：ESR 128 于 **2025-09-16 停止支持**，
当前 ESR 是 140，正式版在 153 以上。128–139 之间**没有任何还在支持的版本** ——
留在那个区间的只有关掉了自动更新的人。代价从"丢一批用户"变成了几乎零，
而收益是内置的数据同意界面真的生效、而不是被静默忽略。

### 为什么 Android 是 999

**这是个哨兵值，用来排除 Android，不是真的目标版本。**

`proxy.settings` 在 Firefox for Android 上**根本没实现**
（Bugzilla 1725981 至今开着，实报 `proxy.settings is not supported on android.`），
而本扩展的 `applyProxy` / `releaseProxy` / `readProxyState` 全走它。

不写 `gecko_android` 的话，Android **继承桌面的下限**（MDN 明说"If not provided,
defaults to the version determined by `gecko.strict_min_version`"），
于是 AMO 把它标成 Android 兼容 —— 用户装上得到一个开关点不动的扩展。

**让一个平台装不上，比让它装上后必然失败要诚实。**

999 是 manifest schema 允许的最大主版本号（模式是 `^[0-9]{1,3}(\.[a-z0-9]+)+$`，
所以 `9999` 会被拒）。按现在每年约 11 个版本的节奏，Firefox 要 77 年才到那儿。

⚠️ 理论上能靠 `proxy.onRequest`（Android **支持**它）单独实现 Android 路径，
但那要把全局代理也改成逐请求判断，且 `<all_urls>` 要从可选变成**必需**权限
—— 与上面那节的取舍方向相反。真要做是一个独立特性，不是一处修补。

### 构建目标跟着一起改

`vite.shared.ts` 里的 `target` 与这个下限对齐（`firefox140`）。
写错的后果是产物里出现目标浏览器不认的语法，而症状是"装上去白屏" ——
一个不会在开发机上出现的故障。

---

<a id="building"></a>

## 构建

每个平台跑两趟：

1. 扩展页面（多入口 + HTML）
2. 背景脚本（单入口 + `format: 'iife'`）

**为什么必须分开**：MV3 的背景脚本必须是自包含单文件 —— 一旦产物里出现
`import(...)` 去拉另一个 chunk，Chrome 会当作远程代码加载并拒绝注册整个扩展
（`Service worker registration failed`）。这与页面入口的输出要求互斥。
所以 `watch` 也要开两个终端。

两个平台的产物都叫 `background.js`，但装载方式不同：Chromium 用
`background.service_worker`，Firefox 用 `background.scripts`
（Firefox 不支持扩展 service worker，见 Firefox bug 1573659）。
IIFE 单文件恰好同时满足两者。

**背景脚本会被随时杀掉重启**，所以模块作用域**不存任何可变状态**，
每次消息到达都从 storage 重读。业务决策不散落在各处，集中在 `orchestrator.ts`。

### Firefox 的长期安装

Release 与 Beta 版 Firefox **一律强制扩展签名，没有开关**（那个 preference
在 Firefox 48 就移除了）。所以 `.zip` 只能 `about:debugging` 临时载入，重启即失效。

`npm run sign:firefox` 走 AMO 的 unlisted 渠道拿回签好的 `.xpi`。
几个必须一次做对的地方都写在 `scripts/sign-firefox.mjs` 的注释里，
其中最容易漏的是：**AMO 会重建你的源码并与提交的包逐字节 diff**
（"There must be no differences"），所以行尾符必须在仓库里钉死
—— 否则开发机的 `core.autocrlf` 会让 `git archive` 导出 CRLF、
而工作区构建出 LF，提交被退回且报错完全不提行尾符这回事。

CI 每次都验一遍这条：解出源码包、照 `REVIEWERS.md` 重建、diff。

---

## 为什么不做「内置 Core」

原计划用 Native Messaging 装一个本机 Host 来启停 `mihomo.exe`，
目标是"装上插件就能用，不必另装 Clash 客户端"。评估后放弃。

**它服务的人群基本不存在。** 会给浏览器配代理的人，机器上通常已经有
Clash 客户端了。这个功能省掉的是"开一下客户端"，而客户端自己就有开机自启。

**代价却是结构性的：**

- **端口冲突，且症状会甩锅。** 两个内核撞同一端口时后启动的起不来。
  若 LostProxy 先起，受害者是用户原有的客户端 —— 而他不会想到是这个插件干的。
  用独立端口可以规避，但那意味着常驻两个内核进程（各 50–100 MB）、
  两套节点选择、两份订阅。
- **打破「卸载即干净」。** Native Messaging 要在注册表写一个键，
  而它**扩展卸载后不会自动清除**。选 `chrome.proxy` / `chrome.privacy`
  的关键理由正是"浏览器会自动恢复，不留脏状态"。这个功能会让项目
  从"纯浏览器扩展"变成"装在系统上的软件"。
- **随包分发内核有许可证与信任两重问题。** mihomo 的发布二进制取自 `Meta` 分支，
  许可证是 **GPL-3.0**（`main` 分支是 MIT，容易看错），与本项目的 MIT
  混合分发需要认真处理。更要紧的是：**这是个代理工具**，用户没有理由信任
  本项目塞进发布包里的 18 MB 二进制。

**结论**：换来的是便利，付出的是"卸载即干净"这个性质。当前形态
（用户自备内核 + 本扩展只管作用域）职责更清晰。

降低上手门槛的低成本方向是**端口自动探测** —— 挨个试常见端口，
探到通的就填上。它不需要任何本机程序，也不动上面任何一条边界。已经做了。

---

## 一个效果逸出浏览器的功能

切节点改的是**内核的全局状态**，所有在用这个内核的程序都会跟着变 ——
与只影响本浏览器的代理开关不同。Popup 里对此有明示。

内核的**选择**是全局的，但内核的**使用**仍然只限于本浏览器。
