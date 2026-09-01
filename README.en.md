<div align="center">

<img src="src/public/icons/icon-128.png" alt="LostProxy" width="120">

# LostProxy

**Proxy this one browser. Leave the rest of the machine alone.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/Edge%20%7C%20Chrome%20120+%20%7C%20Firefox%20128+-0078D6?logo=microsoftedge&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
[![Release](https://img.shields.io/github/v/release/xiaopenghuang/LostProxy?label=download&color=success)](https://github.com/xiaopenghuang/LostProxy/releases/latest)

[中文](README.md) · **English**

</div>

---

The usual bind on a campus network: you need a proxy to reach the literature,
but turning on the system proxy sends the library catalogue, the lab database,
and the intranet printer through it too. TUN mode goes further and takes over
every other application as well.

LostProxy narrows the proxy down to **one browser**:

```text
Edge, with it installed  ──▶ local Mihomo ──▶ node ──▶ sites abroad
Chrome, without          ──▶ direct ────────────────▶ campus systems
```

No Windows proxy settings, no registry writes, no TUN, no route table changes,
no administrator rights. It implements no protocols at all
(VLESS / VMess / Trojan / SS / Hysteria2) — Mihomo handles those. This extension
only decides *what goes through the proxy*.

## What it does

- **One toggle**, scoped to this browser only
- **Switch nodes and test latency** without opening your Clash client
- **Rule-based routing** — list the hosts that should stay direct
- **Refresh subscriptions**
- **Locks WebRTC into the proxy** as well, since UDP otherwise bypasses an HTTP
  proxy and exposes your real IP
- When the proxy is unreachable it **breaks rather than quietly going direct**
  ([why](DESIGN.md#fail-closed))
- English and Chinese, switchable on the spot

## Install

Pick by browser on the
[Releases](https://github.com/xiaopenghuang/LostProxy/releases/latest) page.
**The two archives are not interchangeable** — installing the wrong one proxies
nothing, and the browser reports no error.

### Edge / Chrome

Download `lostproxy-v<version>.zip` and **unzip it**, then:

1. Open `edge://extensions` (`chrome://extensions` on Chrome)
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the **unzipped folder**

> Outside the store this is the only route: Chromium rejects a `.crx` downloaded
> from a URL (`CRX_REQUIRED_PROOF_MISSING`). Store listing is a later job.

### Firefox

Download **`lostproxy-firefox-v<version>.xpi`** — the one Mozilla signed — then:

1. `about:addons` → gear icon → **Install Add-on From File**
2. 🔴 Open LostProxy → turn on **Run in Private Windows**

Step 2 is not optional. Firefox applies proxy settings to private and normal
windows alike, so without that permission it refuses to let the extension change
the proxy at all. If it is off, the extension tells you where to enable it rather
than pretending to be on.

> **The `.zip` also works, but only as a temporary load**
> (`about:debugging` → Load Temporary Add-on) and it disappears when Firefox
> closes. The `.xpi` is signed and survives restarts.
>
> ⚠️ The `.xpi` **does not auto-update**. It is self-distributed and not listed
> on AMO, so Firefox has no update source to check. Come back and download
> manually to upgrade.

### Verifying (optional)

A proxy tool is worth checking. Each release publishes a SHA-256, and the `.zip`
files are built by GitHub Actions with Sigstore build provenance:

```bash
gh attestation verify lostproxy-v<version>.zip --repo xiaopenghuang/LostProxy
```

The `.xpi` is signed by Mozilla but built locally, so it carries no such
attestation. Its contents match the `.zip` file for file — apart from a
`manifest.json` that AMO reformats — so you can download both and compare.

## Setup

**Installing it does not by itself get you online.** You need a Mihomo core
already running locally, for example
[Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev).

### Ports — the one thing people get wrong

| | Proxy port | Controller port |
| --- | --- | --- |
| LostProxy default | 7890 | 9090 |
| **Clash Verge Rev default** | **7897** | **9097** |
| You changed the proxy port | your value | **still 9097** (it does not follow) |

Check both in Clash Verge and enter them in LostProxy's ⚙ settings:

- `Settings → Port Settings` → **Mixed Port** → "Proxy Port"
- `Settings → External Controller` → **Port** → "Controller Port", plus the
  secret if you set one

Three things worth knowing:

1. **The two ports are independent.** Change the mixed port to 2080 and the
   controller is usually still on 9097.
2. **Use the mixed or HTTP port**, not a SOCKS port.
3. **It works without the external controller.** You just get a grey dot for
   core status; the proxy itself is fine. The settings page has a
   **Detect port** button that can find it for you.

### Then turn these two off in your client

```text
System Proxy = OFF    ← leaving it on defeats the whole point
TUN          = OFF    ← takes over the entire system
```

Those two are what this extension replaces; with either on it has no reason to
exist.

⚠️ Some clients turn the system proxy **back on** when they exit or reload their
config. Check again before testing:

```bash
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable
```

It must read `0x0`.

## Confirming it works

Open <https://ipinfo.io/ip> in the browser with LostProxy **and in another
browser without it**:

```text
LostProxy off → the two IPs match
LostProxy on  → the two IPs differ   ← this is what proves the scoping works
```

Do not check against a fixed IP — nodes change. Only whether the two differ.

## Building from source

```bash
npm install
npm run build      # produces dist/ (Edge / Chrome) and dist-firefox/
```

Then follow the install steps above, selecting `dist/` or `dist-firefox/` —
not the project root. Rebuild after changing code, then hit **Reload** on the
extensions page.

| Command | What it does |
| --- | --- |
| `npm run build` | Full build, both platforms |
| `npm run watch` | Rebuild the UI on change |
| `npm run watch:sw` | Rebuild the background script (**separate terminal**) |
| `npm run test` | Unit tests |
| `npm run verify` | typecheck + test + build |
| `npm run package` | Zip both distributables into `release/` |
| `npm run sign:firefox` | Submit to AMO and fetch a permanently installable `.xpi` |

Built with TypeScript, Vite 8 (Rolldown) and Vitest. Plain HTML and CSS, no UI
framework, no runtime dependencies. Why each platform needs two build passes,
and other non-obvious parts, are in [DESIGN.md](DESIGN.md#building).

## Known limitations

- The browser's own account sync, search suggestions and Copilot go through the
  proxy too. That is what a browser-level proxy means, but it can trip account
  risk checks.
- HTTP and mixed ports only; a SOCKS port is not supported directly.
- Upstream proxies requiring username/password auth are not implemented.
- It cannot be enabled when enterprise or campus policy controls proxy settings —
  extensions rank below policy.
- When another proxy extension holds the setting it **refuses to start** and says
  which one, rather than taking over.
- **Firefox for Android installs but cannot work** — `proxy.settings` does not
  exist there (Bugzilla 1725981). The next release will exclude it in the
  manifest.
- Whether QUIC / HTTP3 bypasses the proxy, and the real egress IP of private
  windows, are **untested** — known open questions, not known guarantees.

### How Firefox differs from Edge / Chrome

Feature parity is complete. Two operational differences remain, both rooted in
the browser APIs:

1. **You must grant "Run in Private Windows"** (install step 2 above).
2. **Rule-based routing needs one more grant.** Firefox has no inline PAC, so
   routing can only work by asking the extension per request — meaning the
   browser hands it every URL, which requires the "access all websites"
   permission. The button is under **Settings → Direct-connect Rules → "Allow
   per-request routing"**. Decline and global proxying keeps working; accept and
   you can revoke it any time in `about:addons`.

   Only `http://127.0.0.1/*` is required by default, so people who just want a
   global proxy never hand over that permission for a feature they do not use
   ([the reasoning](DESIGN.md#firefoxs-optional-permission)).

## Design notes

Why fail-closed, why the two platforms cannot share code, why the bundled-core
plan was dropped — those trade-offs, and the mistakes behind them, are in
[DESIGN.md](DESIGN.md).

## License

[MIT](LICENSE)
