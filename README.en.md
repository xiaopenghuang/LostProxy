<div align="center">

<img src="src/public/icons/icon-128.png" alt="LostProxy" width="120">

# LostProxy

**Route one browser through your local proxy and leave the rest of the machine alone**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Edge%20%7C%20Chromium%20120+-0078D6?logo=microsoftedge&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8%20(Rolldown)-646CFF?logo=vite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-464%20passing-brightgreen)

[![Release](https://img.shields.io/github/v/release/xiaopenghuang/LostProxy?label=download&color=success)](https://github.com/xiaopenghuang/LostProxy/releases/latest)

[中文](README.md) · **English**

</div>

---

A familiar bind on a campus network: you need a proxy to reach the literature, but the moment you
turn on the system proxy the library catalogue, the lab database and the office printer all get
routed around too. TUN mode goes further still and takes over every other application.

LostProxy narrows the proxy's scope to **one browser**. The Edge instance that has it installed
goes through your local Mihomo; Chrome, Firefox and everything else on the same machine keep
their original network path.

```text
Edge   ──▶ 127.0.0.1:7897 ──▶ Mihomo ──▶ proxy node ──▶ off-campus resources
Chrome ──▶ DIRECT ─────────────────────▶ campus network ──▶ internal systems / databases
```

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
- **WebRTC locked into the proxy too** — sets `disable_non_proxied_udp` (IETF Mode 4) while the
  proxy is on. The browser's default policy does **not** force WebRTC through a proxy, so UDP
  would bypass an HTTP proxy and expose the real IP.
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

Download `lostproxy-v<version>.zip` from
[Releases](https://github.com/xiaopenghuang/LostProxy/releases/latest), **unzip it**, then:

1. Open `edge://extensions`
2. Enable **Developer mode** (bottom left)
3. Click **Load unpacked** and select **the unzipped folder** (you should see `manifest.json`
   directly inside it)

> **Why there is no double-click installer**: Chromium rejects `.crx` files downloaded from a URL
> (`CRX_REQUIRED_PROOF_MISSING`), so "load unpacked" is the only route outside the store. One-click
> installation will come with an Edge Add-ons listing; that is for later.

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

Then in Edge: `edge://extensions` → enable **Developer mode** (bottom left) → **Load unpacked** →
select **`dist/`** (not the repository root).

After changing code, run `npm run build` again and hit **Reload** on the extension in
`edge://extensions`.

| Command | Purpose |
| --- | --- |
| `npm run build` | Full build (clean → pages → service worker, two passes) |
| `npm run watch` | Rebuild popup/options on change |
| `npm run watch:sw` | Rebuild the service worker on change (**separate terminal**) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests |
| `npm run verify` | typecheck + test + build |
| `npm run package` | Build and produce a distributable zip in `release/`, with SHA-256 |
| `npm run icons` | Re-derive the four icon sizes from `src/public/icons/icon.png` |

**Why the build runs twice**: an MV3 service worker must be a self-contained single file — the
moment a chunk import appears you get `Service worker registration failed` — and that requirement
is mutually exclusive with the page entries' output. Hence two passes, and two terminals for watch
mode.

## Tech stack

| Layer | Technology |
| --- | --- |
| Extension platform | Manifest V3 (`proxy` + `storage` + `privacy` permissions) |
| Language | TypeScript 7 (native/Go compiler) |
| Build | Vite 8 (Rolldown), hand-written config, two output passes |
| Tests | Vitest 4, 464 tests, hand-written `chrome.*` mocks |
| UI | Plain HTML/CSS, no UI framework; Fluent Design visual language |
| i18n | Hand-rolled; the EN dictionary is the single source of truth, so a missing translation is a compile error |

## Project layout

```
src/
  background/   proxy.ts    chrome.proxy reads/writes, error normalization
                privacy.ts  WebRTC policy lock
                mihomo.ts   Controller probe (read-only)
                storage.ts  settings validation and persistence
                orchestrator.ts  orchestration; every business decision lives here
                index.ts    service worker shell, deliberately thin
  popup/        toggle, status card, alerts
  options/      settings, language switch, controller probe
  shared/       types / constants / errors / i18n / messages
tests/          464 unit tests and chrome API mocks
scripts/        icon downscaling and generation
```

The service worker is killed and restarted at the browser's discretion, so **no mutable state is
held at module scope** — every message re-reads from storage. Business decisions are not scattered
through `proxy.ts`; they are concentrated in `orchestrator.ts`.

## Data location

Everything in `chrome.storage.local` under three keys: settings, enabled state, last error.

**`chrome.storage.sync` is not used** — the Controller Secret is a local credential and syncing it
to the cloud would overstep. In the test environment `storage.sync` is replaced with a stub that
throws, so nobody can quietly start writing to it later.

## Tests

```bash
npm run test        # 464 tests, ~0.5s
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
the machine. Currently **Definition of Done 17 / 18** verified item by item on a real machine.

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
- The one remaining DoD item (the prompt shown when another proxy extension conflicts) needs a
  SwitchyOmega-style extension installed to manufacture the conflict. The logic is pinned by unit
  tests and fails conservatively: getting it wrong can only refuse an enable that should have
  succeeded, never produce a false ON.

## Roadmap

- **V0.2 node switching** — code complete, **pending real-machine acceptance** (unreleased).
  Switch the node of a Mihomo policy group straight from the popup, without opening Clash Verge.

  ⚠️ This is the project's **first feature whose effect leaves the browser**: switching a node
  changes the core's global state, so anything else using that core is affected too — unlike the
  proxy toggle, which only affects this browser. The popup says so. The core's *selection* is
  global; the core's *use* is still confined to this browser.
- **V0.3** latency testing
- **V0.4** in-browser rule-based routing (PAC — ⚠️ must set `mandatory: true`. PAC is
  **fail-open** by default: if the script cannot be fetched or fails to evaluate, the browser
  falls back to a direct connection — exactly the opposite of V0.1's fail-closed semantics)
- **V0.5** bundled core · **V0.6** subscription management

## License

[MIT](LICENSE)
