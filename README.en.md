<div align="center">

<img src="src/public/icons/icon-128.png" alt="LostProxy" width="120">

# LostProxy

**Route one browser through your local proxy and leave the rest of the machine alone**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Edge%20%7C%20Chrome%20120+%20%7C%20Firefox%20128+-0078D6?logo=microsoftedge&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8%20(Rolldown)-646CFF?logo=vite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-1047%20passing-brightgreen)

[![Release](https://img.shields.io/github/v/release/xiaopenghuang/LostProxy?label=download&color=success)](https://github.com/xiaopenghuang/LostProxy/releases/latest)

[中文](README.md) · **English**

</div>

---

A familiar bind on a campus network: you need a proxy to reach the literature, but the moment you
turn on the system proxy the library catalogue, the lab database and the office printer all get
routed around too. TUN mode goes further still and takes over every other application.

LostProxy narrows the proxy's scope to **one browser**. The browser that has it installed
goes through your local Mihomo; other browsers and everything else on the same machine keep
their original network path.

```text
Edge   ──▶ 127.0.0.1:7897 ──▶ Mihomo ──▶ proxy node ──▶ off-campus resources
Chrome ──▶ DIRECT ─────────────────────▶ campus network ──▶ internal systems / databases
```

There is one build for Edge/Chrome and one for Firefox. They share all business logic and the
entire UI; only the layer that talks to the browser's proxy API differs — and those two APIs are
entirely different, down to which value WebRTC leak protection has to be set to.

No changes to the Windows system proxy, no registry writes, no TUN, no routing-table edits, no
elevation. None of the protocols (VLESS / VMess / Trojan / SS / Hysteria2) are implemented here —
Mihomo does all of that. This project only controls scope.

## Features

- **Scoped to this browser** — writes `chrome.proxy` and nothing else. Measured on one machine:
  two browsers on different egresses at the same time, Edge exiting via AWS Tokyo while Chrome
  still exits via the local ISP, entirely different ASNs.
- **Fail-closed, never a silent DIRECT** — when the proxy is unavailable the request is aborted
  with `ERR_PROXY_CONNECTION_FAILED` rather than falling back to a direct connection. Better no
  network than leaking the real IP while the user believes the proxy is on. Verified on a real
  browser: `onProxyError.fatal === true` (aborted, not leaked).
- **WebRTC locked into the proxy too** — `disable_non_proxied_udp` (IETF Mode 4) on Chromium,
  `proxy_only` on Firefox, while the proxy is on. The browser's default policy does **not** force
  WebRTC through a proxy, so UDP would bypass an HTTP proxy and expose the real IP.

  The two platforms using different values is not a typo: since Firefox 70 the identically-named
  `disable_non_proxied_udp` degraded to "force the proxy *if one is configured*", so copying
  Chromium's value across is **accepted**, raises **no error**, and gives **weaker** protection.
  That class of difference has no compile-time or runtime signal, which is why the code keeps it
  behind a whole abstraction layer and re-checks it on the published zip.
- **Credentials stay local** — the Controller Secret never enters `chrome.storage.sync`, is never
  logged, and is never echoed back (the UI only shows "saved"). A test asserts it appears in no
  serialized object.
- **Observability separated from availability** — failing to reach the Mihomo Controller shows a
  gray dot and raises **no alert**. Most GUIs expose only a named pipe by default, no HTTP
  endpoint; the proxy runs on the mixed port and is perfectly fine. Unreachable ≠ broken.
- **Alerts self-heal** — they clear themselves once things recover, with no need to dismiss
  manually. Only suspected-leak alerts persist for acknowledgement, because the user needs to know
  it happened.
- **Refuses to override conflicts** — when another proxy extension or an enterprise/campus policy
  controls the proxy settings, LostProxy does not seize them, and says who is in control.
- **Uninstall reverts everything** — the browser clears the proxy settings on disable or uninstall,
  leaving no broken state to repair by hand.
- **Instant Chinese/English switching** — hand-rolled i18n rather than `chrome.i18n`, which can
  only read the browser UI language and cannot be switched by the user.

## Install

[Releases](https://github.com/xiaopenghuang/LostProxy/releases/latest) carries two archives.
They are **not interchangeable** — using the wrong one silently fails to proxy anything, with no
error from the browser:

| Browser | Download |
| --- | --- |
| Edge / Chrome | `lostproxy-v<version>.zip` |
| Firefox | `lostproxy-firefox-v<version>.zip` |

### Edge / Chrome

1. Download and **unzip**
2. Open `edge://extensions`
3. Enable **Developer mode** (bottom left)
4. Click **Load unpacked** and select **the unzipped folder** (you should see `manifest.json`
   directly inside it)

> **Why there is no double-click installer**: Chromium rejects `.crx` files downloaded from a URL
> (`CRX_REQUIRED_PROOF_MISSING`), so "load unpacked" is the only route outside the store. One-click
> installation will come with an Edge Add-ons listing; that is for later.

### Firefox

1. Download and **unzip**
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on** and pick `manifest.json` inside the unzipped folder
4. 🔴 Open `about:addons` → click LostProxy → turn **Run in Private Windows** **on**

> **Step 4 is not optional.** Firefox proxy settings apply to private and normal windows alike, so
> without that permission the browser does not let an extension change them at all —
> `proxy.settings.set()` throws. LostProxy tells you where to enable it rather than pretending it
> worked.
>
> Incidentally: what `scope: 'regular'` buys on Chromium ("InPrivate windows are proxied too, no
> leak") is the **default** on Firefox — this prior grant is the price.

> **Temporary add-ons are removed when Firefox closes.** That is a Firefox rule for unsigned
> extensions, not a limitation of this extension. Permanent installation needs AMO signing; later.

A proxy tool is worth checking the hash of — the release page carries a SHA-256. From v0.1.1
onward, artifacts are built by GitHub Actions with a Sigstore-signed provenance attestation, so you
can confirm the file came from a public build of this repository rather than someone's upload:

```bash
gh attestation verify lostproxy-v<version>.zip --repo xiaopenghuang/LostProxy
```

You can also [build from source](#building-from-source).

**Installing it alone does not get you connected** — you also need the prerequisites below.

## Prerequisites

V0.1 neither bundles nor downloads a Mihomo core. You need one already running:

- [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev), another Mihomo GUI, or a
  bare `mihomo.exe`

### Ports — by far the easiest thing to get wrong

| Client / situation | Proxy port | Controller port |
| --- | --- | --- |
| LostProxy defaults | 7890 | 9090 |
| **Clash Verge Rev defaults** | **7897** | **9097** |
| You changed the proxy port | your value | **still 9097** (does not follow) |

Check both in Clash Verge, then fill them into LostProxy's ⚙ Settings:

- `Settings → Port Setting` → **mixed proxy port** → `Proxy Port`
- `Settings → External Controller` → **port** → `Controller Port`, plus `Controller Secret` if set

Three things to keep in mind:

1. **The two ports are independent.** Change the mixed port to 2080 and the Controller is usually
   still on 9097.
2. **The proxy port must be a mixed or HTTP port**, not a SOCKS port — LostProxy connects over HTTP.
3. **Turning off external control does not affect the proxy.** You just get a permanent gray dot;
   the proxy itself keeps working.

### Mihomo-side configuration

```yaml
mixed-port: 7897                      # ← goes into LostProxy's Proxy Port
allow-lan: false                      # not exposed to the LAN
external-controller: 127.0.0.1:9097   # ← optional; never 0.0.0.0
secret: "<mandatory when external-controller is enabled>"
```

> `secret` is **mandatory** once external control is on: Mihomo defaults to
> `external-controller-cors.allow-origins: ['*']`, so without a secret any web page could drive
> your core.

### Then turn these two off in the GUI

```text
System Proxy = OFF     ← leaving it on defeats the point of "only Edge is proxied"
TUN          = OFF     ← leaving it on takes over system-wide traffic
```

These two are exactly what this project replaces; with either enabled, LostProxy has no reason to
exist.

## Building from source

```bash
npm install
npm run build
```

Two outputs: `dist/` (Edge / Chrome) and `dist-firefox/` (Firefox).

Then in Edge: `edge://extensions` → enable **Developer mode** (bottom left) → **Load unpacked** →
select **`dist/`** (not the repository root). Firefox goes through `about:debugging`; pick
`dist-firefox/manifest.json`.

After changing code, run `npm run build` again and hit **Reload** on the extension.

| Command | Purpose |
| --- | --- |
| `npm run build` | Full build, two passes per platform |
| `npm run build:chromium` | Edge / Chrome only (no clean) |
| `npm run build:firefox` | Firefox only (no clean) |
| `npm run watch` | Rebuild popup/options on change |
| `npm run watch:sw` | Rebuild the background script on change (**separate terminal**) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests |
| `npm run verify` | typecheck + test + build |
| `npm run package` | Build and produce both distributable zips in `release/`, each with SHA-256 |
| `npm run icons` | Re-derive the four icon sizes from `src/public/icons/icon.png` |

**Why each platform runs twice**: an MV3 background script must be a self-contained single file —
the moment a chunk import appears you get `Service worker registration failed` — and that
requirement is mutually exclusive with the page entries' output. Hence two passes, and two
terminals for watch mode.

**Why the platforms are separate builds rather than a runtime check**: the platform identifier is
injected at compile time via Vite's `define`, so each bundle contains only one platform's code.
That is not about saving a few KB — it makes "the Firefox bundle must not contain
`disable_non_proxied_udp`" an assertable fact, and that assertion guards precisely the
"copies across fine but is less safe" difference described above. Runtime sniffing cannot give you
that, and it is unreliable anyway (Edge's UA says "Chrome", and Firefox also exposes a `chrome.*`
namespace).

## Tech stack

| Layer | Technology |
| --- | --- |
| Extension platform | Manifest V3 (`proxy` + `storage` + `privacy` permissions) |
| Language | TypeScript 7 (native/Go compiler) |
| Build | Vite 8 (Rolldown), hand-written config, two output passes |
| Tests | Vitest 4, 1047 tests, hand-written `chrome.*` mocks |
| UI | Plain HTML/CSS, no UI framework; Fluent Design visual language |
| i18n | Hand-rolled; the EN dictionary is the single source of truth, so a missing translation is a compile error |

## Project layout

```
src/
  background/   platform/   ← the only place browser differences exist
                  types.ts    the contract + a full difference table
                  chromium.ts every chrome.proxy / chrome.privacy call
                  firefox.ts  every browser.proxy call
                  index.ts    build-time selection; nowhere else asks "which browser"
                proxy.ts    proxy orchestration, zero browser API calls
                privacy.ts  WebRTC lock orchestration, likewise
                pac.ts      PAC generation and rule sanitisation (the one injection surface)
                mihomo.ts   Controller probe (read-only)
                storage.ts  settings validation and persistence
                orchestrator.ts  orchestration; every business decision lives here
                index.ts    background script shell, deliberately thin
  popup/        toggle, status card, alerts
  options/      settings, language switch, controller probe
  shared/       types / constants / errors / i18n / messages
  manifest.json         Chromium (service_worker)
  manifest.firefox.json Firefox (scripts + gecko id)
tests/          1047 unit tests and two sets of chrome API mocks
scripts/        packaging, release notes, icon generation
```

The background script is killed and restarted at the browser's discretion, so **no mutable state is
held at module scope** — every message re-reads from storage. Business decisions are not scattered
through `proxy.ts`; they are concentrated in `orchestrator.ts`.

**Browser differences are confined to `platform/`.** A single `chrome.` call inside `proxy.ts` or
`privacy.ts` turns the test suite red — because that mistake behaves perfectly on Edge and only
breaks on Firefox, and you usually have one browser open while developing. Likewise, neither build
may contain the other platform's code, and that is re-checked **on the published zips**.

## Data location

Everything in `chrome.storage.local` under three keys: settings, enabled state, last error.

**`chrome.storage.sync` is not used** — the Controller Secret is a local credential and syncing it
to the cloud would overstep. In the test environment `storage.sync` is replaced with a stub that
throws, so nobody can quietly start writing to it later.

## Tests

```bash
npm run test        # 1047 tests, ~0.5s
npm run verify      # typecheck + test + build
```

The unit tests lock down **invariants**, not behaviour snapshots: `singleProxy` rather than
`proxyForHttp`, exactly four bypass entries, `scope === 'regular'`, disabling uses `clear()` rather
than `set(direct)`, the write ordering when toggling (checked in both directions), the secret
appearing in no serialized object, and placeholder parity between the two languages.

The most important acceptance check, though, is **not** a unit test — it is the real-machine
two-browser egress isolation test:

```text
Edge   with LostProxy
Chrome without
        ↓
While LostProxy is ON: Edge egress IP ≠ Chrome egress IP
```

No unit test can cover that one — it needs two real browsers, a real core and real traffic leaving
the machine. All **18 / 18 Definition of Done items** verified item by item on a real machine.

The three traps that cost the most time during development, all hit for real:

1. **Forgetting to turn the system proxy off.** Chrome gets proxied too and the isolation test is
   guaranteed to fail. Worse, it makes "Edge can reach the outside world" look like this
   extension's doing when it has nothing to do with it. Check with
   `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable`
   — it must read `0x0`. Some GUIs re-enable it when they exit or reload their config, so check
   again immediately before testing.
2. **Using the default ports.** The reliable move is to look at what the core is actually
   listening on rather than trusting a documented default.
3. **Assuming the Controller port follows the proxy port.** They are two independent ports.

## Known limitations

- Edge's own account sync, search suggestions and Copilot go through the proxy as well. That is
  expected for a browser-level proxy, but it may trip account risk controls.
- HTTP/mixed ports only; connecting straight to a SOCKS port is not supported.
- Upstream proxies requiring username/password authentication are not handled.
- Whether QUIC/HTTP3 bypasses the proxy, and the actual egress IP of InPrivate windows, are both
  **unverified** — known open questions, not known guarantees.
- It cannot be enabled while an enterprise/campus policy controls the proxy settings — extensions
  rank below policy, which is a platform rule.
- When another proxy extension holds the setting, LostProxy refuses to enable and names what is in
  control rather than overriding it. Verified on a real machine using the repo's own
  `tools/conflict-test-extension/` — a thirty-line fixture requesting only `proxy` and making no
  network requests, because the SwitchyOmega this originally pointed at is discontinued and no
  longer runs on current Chromium.

### Differences in the Firefox build

Feature parity with Edge/Chrome — proxy toggle, node switching, latency testing,
smart routing, subscription refresh and the WebRTC lock all work. Four
differences remain, all rooted in the browser APIs themselves:

**1. Smart routing needs one extra permission, asked for only when you use it.**

Firefox's proxy API has no inline PAC support, so routing goes through
`proxy.onRequest` instead: the browser asks the extension about **every request**
whether to proxy it. That means the extension can see every URL you visit — which
is why Firefox insists on asking first.

The prompt appears the first time you switch routing to Smart. Decline and global
proxying keeps working; accept and you can revoke it any time in `about:addons`.

> **Why not request it at install time**: needing only `http://127.0.0.1/*` by
> default is a feature of this project — a small permission surface means a
> compromised extension has little to take. Charging that to people who only want
> global proxying, for an optional feature, is a bad trade.

Incidentally that path is **cleaner than PAC**: rules never become code, so the
entire PAC injection defence in the Chromium build (character allowlist,
`JSON.stringify` serialisation, pure-ASCII check) is simply unnecessary here.

**2. Private-window access must be granted.**

Firefox proxy settings apply to private and normal windows alike, so without that
permission the browser does not let an extension change them at all. LostProxy
says where to enable it rather than pretending it worked.

Conversely, what `scope: 'regular'` buys on Chromium (InPrivate windows are
proxied too, no leak) is the **default** on Firefox — this prior grant is the price.

**3. Weaker runtime error signal.**

Firefox's `proxy.onError` carries no `fatal` field, so unlike Chromium it cannot
distinguish "the request was blocked, no leak" from "it went out direct, possible
leak". The chosen stance is a self-healing alert that promises nothing either way —
rather than always assuming the worst, which would train users to dismiss this class
of alert and take the real leak warnings down with it.

**4. Real-machine isolation testing is not done.**

Two-browser egress ASN separation is verified on Chromium; the Firefox side has
unit-test coverage only (including bundle-level assertions) and **has not been
verified on a real machine** for egress isolation or fail-closed behaviour. A known
open item, not a known guarantee. See `docs/test-plan.md` §6.5.

## Roadmap

- **V0.2 node switching** ✅ shipped. Switch the node of a Mihomo policy group straight from the
  popup, without opening Clash Verge.

  ⚠️ This is the project's **first feature whose effect leaves the browser**: switching a node
  changes the core's global state, so anything else using that core is affected too — unlike the
  proxy toggle, which only affects this browser. The popup says so. The core's *selection* is
  global; the core's *use* is still confined to this browser.
- **V0.3** latency testing
- **V0.4** in-browser rule-based routing (PAC — ⚠️ must set `mandatory: true`. PAC is
  **fail-open** by default: if the script cannot be fetched or fails to evaluate, the browser
  falls back to a direct connection — exactly the opposite of V0.1's fail-closed semantics)
- **V0.6** subscription management
- ~~**V0.5** bundled core~~ — **dropped**, see below

### Why the bundled core was dropped

The original plan was a Native Messaging host that starts and stops `mihomo.exe`, so that
installing the extension would be enough and no separate Clash client would be needed. Dropped
after evaluation:

**It serves an audience that barely exists.** Anyone configuring a proxy for their browser
usually already has a Clash client installed. The feature saves opening that client — and the
client has its own launch-at-login setting.

**The costs, in contrast, are structural:**

- **Port conflicts, with misdirected symptoms.** When two cores want the same port, the second one
  fails to start. If LostProxy's starts first, the casualty is the user's existing client — and
  they will not suspect this extension. Using separate ports avoids that, at the price of two
  resident core processes (50–100 MB each), two node selections and two subscriptions.
- **It breaks "uninstall leaves nothing".** Native Messaging requires a registry key under
  `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`. It touches no proxy setting and needs no
  elevation, but **the browser does not remove it on uninstall** — and the stated reason for
  choosing `chrome.proxy` / `chrome.privacy` in `security.md §1` is precisely that the browser
  restores them automatically, leaving no dirty state. V0.5 would turn this from a browser
  extension into software installed on the system.
- **Shipping the core raises both licensing and trust problems.** mihomo's release binaries are
  built from the `Meta` branch, which is **GPL-3.0** (`main` is MIT — easy to misread), so mixing
  it into this MIT project's distribution needs real care. More importantly: **this is a proxy
  tool**, and users have no reason to trust an 18 MB binary this project dropped into a release
  archive. Downloading from mihomo's official releases at runtime with a hash check would fix the
  trust problem, but by then the remaining benefit — saving one download — is smaller than the
  total cost.

**Conclusion**: V0.5 buys convenience and spends the "uninstall leaves nothing" property. The
current shape — user supplies the core, this extension only governs scope — has clearer
responsibilities and a smaller footprint.

If the barrier to entry does need lowering later, **port auto-detection** is far cheaper: probe
the common ports and fill in whichever answers. It needs no native program and crosses none of
the boundaries above.

## License

[MIT](LICENSE)
