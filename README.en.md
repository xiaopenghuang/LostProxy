<div align="center">

<img src="src/public/icons/icon-128.png" alt="LostProxy" width="120">

# LostProxy

**Proxy this one browser. Leave the rest of the machine alone.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/Edge%20%7C%20Chrome%20120+%20%7C%20Firefox%20140+-0078D6?logo=microsoftedge&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
[![Release](https://img.shields.io/github/v/release/xiaopenghuang/LostProxy?label=download&color=success)](https://github.com/xiaopenghuang/LostProxy/releases/latest)

[中文](README.md) · **English**

</div>

---

## Overview

Enabling a system proxy routes all traffic through it, including resources
that should stay direct: the library catalogue, the lab database, the
intranet printer. TUN mode reaches further still, taking over every other
application as well.

LostProxy scopes the proxy to a **single browser**:

```text
Edge, with it installed  ──▶ local Mihomo ──▶ node ──▶ sites abroad
Chrome, without          ──▶ direct ────────────────▶ campus systems
```

No Windows proxy settings, no registry writes, no TUN, no route table
changes, no administrator rights. The extension implements no proxy
protocols itself (VLESS / VMess / Trojan / SS / Hysteria2) — Mihomo handles
those, and the extension only decides which traffic goes through the proxy.

## Features

- Proxy toggle, scoped to the current browser
- Node switching and latency testing without opening a Clash client
- Rule-based routing with a configurable direct-connect host list
- Subscription refresh
- Locks WebRTC in step, so UDP cannot bypass the HTTP proxy and expose the
  real IP
- Breaks the connection when the proxy is unreachable rather than falling
  back to direct ([reasoning](DESIGN.md#fail-closed))
- English and Chinese, switchable on the spot

## Installation

Pick by browser on the
[Releases](https://github.com/xiaopenghuang/LostProxy/releases/latest) page.
**The two archives are not interchangeable**: installing the wrong one
proxies nothing, and the browser reports no error.

### Edge / Chrome

Download `lostproxy-v<version>.zip` and unzip it, then:

1. Open `edge://extensions` (`chrome://extensions` on Chrome)
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the **unzipped folder**

> Outside the store this is the only route. Chromium rejects a `.crx`
> downloaded from a URL (`CRX_REQUIRED_PROOF_MISSING`). A store listing is
> a later job.

### Firefox

Download **`lostproxy-firefox-v<version>.xpi`**, the one Mozilla signed,
then:

1. Open `about:addons` → gear icon → **Install Add-on From File**
2. Open LostProxy → turn on **Run in Private Windows**

**Step 2 is required.** Firefox applies proxy settings to private and normal
windows alike, so without that permission it does not allow the extension to
change the proxy at all. When the permission is missing the extension says
where to enable it rather than failing silently.

> **The `.zip` also works, but only as a temporary load**
> (`about:debugging` → Load Temporary Add-on), and it is gone once Firefox
> closes. The `.xpi` is signed and survives restarts.
>
> The `.xpi` **does not auto-update**. It is self-distributed and not
> listed on AMO, so Firefox has no update source to check. Upgrading means
> downloading it again.

### Verifying integrity

Every release publishes a SHA-256. The `.zip` files are built by GitHub
Actions with Sigstore build provenance:

```bash
gh attestation verify lostproxy-v<version>.zip --repo xiaopenghuang/LostProxy
```

The `.xpi` is signed by Mozilla but built locally, so it carries no
attestation. Its contents match the `.zip` file for file, apart from a
`manifest.json` that AMO reformats, so you can download both and compare.

## Configuration

**The extension provides no proxying on its own.** It needs a Mihomo core
already running locally, for example
[Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev).

### Ports

| | Proxy port | Controller port |
| --- | --- | --- |
| LostProxy default | 7890 | 9090 |
| **Clash Verge Rev default** | **7897** | **9097** |
| After changing the proxy port | your value | **still 9097** (does not follow) |

Check both in Clash Verge and enter them in LostProxy's ⚙ settings:

- `Settings → Port Settings` → **Mixed Port** → the "Proxy Port" field
- `Settings → External Controller` → **Port** → the "Controller Port" field,
  plus the secret if one is set

Three notes:

1. **The two ports are independent.** Change the mixed port to 2080 and the
   controller is usually still on 9097.
2. **The proxy port must be a mixed or HTTP port**, not a SOCKS port.
3. **The external controller is optional.** Without it, core status shows a
   grey dot and proxying is unaffected. The settings page has a **Detect
   port** button to help locate it.

### Client settings

```text
System Proxy = OFF    ← leaving it on defeats single-browser scoping
TUN          = OFF    ← takes over all system traffic
```

Those two are what this extension replaces; with either on it serves no
purpose.

Some clients **restore the system proxy automatically** when they exit or
reload their config. Worth re-checking before you verify:

```bash
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable
```

It must read `0x0`.

### A different exit per browser

Routing Edge and Chrome through different exit nodes needs no change to the
extension, only Mihomo-side configuration. The mechanism is Mihomo's
[`listeners`](https://wiki.metacubex.one/en/config/inbound/listeners/):
additional inbound ports beside the main one, each able to name its own exit
through the `proxy` field.

It takes two blocks, and **they go in two different places**. In Clash Verge Rev
both live in the subscription card's context menu, not the global one. See
"Switching subscriptions" below for why.

First, under **Edit Proxy Groups**, append two groups of your own:

```yaml
append:
  - name: EXIT-A
    type: select
    include-all: true
    filter: "(?i)香港|hk"
    empty-fallback: REJECT         # leak guard, not optional
    default-selected: 香港HK-A     # optional; must name a node that exists
  - name: EXIT-B
    type: select
    include-all: true
    filter: "(?i)日本|jp"
    empty-fallback: REJECT
    default-selected: 日本JP-A
```

🔴 **Do not put `proxy-groups` in the extend config.** There the smallest unit of
an override is a key-value pair and a list counts as one value, so writing
`proxy-groups:` **replaces every proxy group** the subscription defines — the
provider's own selector, ChatGPT, Netflix and the rest all vanish. The Edit Proxy
Groups entry takes `prepend` / `append` / `delete` and appends instead.

Second, under **Edit Extend Config**, pin one inbound port to each group:

```yaml
listeners:
  - name: browser-a
    type: mixed
    port: 7801
    listen: 127.0.0.1
    proxy: EXIT-A
  - name: browser-b
    type: mixed
    port: 7802
    listen: 127.0.0.1
    proxy: EXIT-B
```

Then, in each browser's LostProxy settings page:

```text
Edge   →  proxy port 7801  +  primary group EXIT-A
Chrome →  proxy port 7802  +  primary group EXIT-B
```

Keep the controller port the same on both. Extension settings are stored per
browser profile, so the two configurations do not interfere, and node switching
and latency tests stay independent.

🔴 **`listen` must be `127.0.0.1`.** The official example uses `0.0.0.0`, which
exposes the proxy to the local network for anyone on the same segment to use.

🔴 **`empty-fallback: REJECT` is not optional.** An empty proxy group falls back
by **default** to
[`COMPATIBLE`](https://wiki.metacubex.one/en/config/proxies/built-in/), which is
**equivalent to `DIRECT`** — traffic leaves unproxied. A group goes empty when
`filter` matches nothing after a subscription update, or when the core restarts
before the proxy-provider has finished downloading
([mihomo #2499](https://github.com/MetaCubeX/mihomo/issues/2499)). The leak
happens inside Mihomo: the browser-side connection is established normally, so
LostProxy's fail-closed never sees it. Set to `REJECT`, an empty group refuses
the connection instead of going direct — verified on mihomo v1.19.30: pointing
`filter` at a keyword that matches nothing collapsed the group to `[REJECT]`, and
the corresponding port refused connections rather than exposing the real IP.

⚠️ **Do not use `proxies: [REJECT]` for this instead.** That makes `REJECT` an
ordinary member — selectable and cacheable — which introduces two new problems. A
`select` group with no prior choice picks its **first member**, and entries in
`proxies` sort ahead of what `include-all` pulls in, so everything is rejected by
default. Worse, once `REJECT` is in the selection cache a **reload will not clear
it** and you have to switch by hand (`store-selected` outranks `default-selected`;
verified). `empty-fallback` only applies when the group is genuinely empty and
never joins the member list.

`default-selected` is optional — it just puts the default on a faster node instead
of the alphabetically first one. Both fields need core **v1.19.28+**, and older
cores **ignore them silently while config validation still passes**, so only the
`/proxies` API distinguishes "written" from "in effect".

**Why your own group names rather than the provider's.** The name `proxy` points
at must be valid or the core errors out. Providers rename and remove groups on
subscription updates, which breaks a config that hard-codes their names. A name
like `EXIT-A` lives in your own config layer, and `include-all` plus `filter`
pulls in whatever the current subscription offers, so changing nodes does not
break the reference.

**Do not pin to a single node.** Pointing `proxy` at a node fixes the exit and
leaves that browser's node switcher visible but inert, which looks like a fault
and is not one.

Two more things:

1. **Both browsers share one controller**, so both can see every proxy group.
   The isolation rests on the primary group being set differently; point both at
   the same group and switching in one affects the other.
2. **`proxy` makes that listener bypass Mihomo's `rules` entirely.** This does
   not affect the direct-connect list, since LostProxy routes at the browser
   level via PAC and returns DIRECT before traffic reaches Mihomo. To keep
   core-side rules, use `rule: <sub-rule name>` instead of `proxy`.

### Switching subscriptions

Both blocks above go in the **per-subscription** entries, so they apply to that
subscription only. That is deliberate: `filter` and `default-selected` depend on
how a particular provider names its nodes, and pointing `proxy` at a name that
does not exist stops the core from starting. Put them in the global entries and
switching to another subscription takes the core down, because those group names
are not there.

Both **survive subscription updates**. Verge stores each subscription's merge /
script / rules / proxies / groups as separate files, and an update only rewrites
the downloaded one.

What they **reference** can still change: if the provider renames its nodes or
retires a whole region, `filter` matches nothing and the group falls to its
`empty-fallback`. That browser then loses connectivity rather than **going
direct** — which is what the 🔴 note above buys you.

To use this with several subscriptions, write a copy into each subscription's
extend config, adjusting `filter` to that provider's node naming. If you need
two subscriptions live at the **same time** rather than switching between them,
run two Mihomo instances with separate controllers and configs. The cost is two
processes, and Verge manages only one of them.

## Verifying the scope

Open <https://ipinfo.io/ip> in the browser with LostProxy installed **and in
another browser without it**:

```text
LostProxy off → the two IPs match
LostProxy on  → the two IPs differ   ← scoping is working
```

Do not compare against a fixed IP, since nodes change. Only whether the two
results differ matters.

## Building from source

```bash
npm install
npm run build      # produces dist/ (Edge / Chrome) and dist-firefox/
```

Then follow the installation steps above, selecting `dist/` or
`dist-firefox/` rather than the project root. Rebuild after changing code,
then hit **Reload** on the extensions page.

| Command | What it does |
| --- | --- |
| `npm run build` | Full build, both platforms |
| `npm run watch` | Rebuild the UI on change |
| `npm run watch:sw` | Rebuild the background script (separate terminal) |
| `npm run test` | Unit tests |
| `npm run verify` | typecheck + test + build |
| `npm run package` | Zip both distributables into `release/` |
| `npm run sign:firefox` | Submit to AMO and fetch an installable `.xpi` |

Built with TypeScript, Vite 8 (Rolldown) and Vitest. Plain HTML and CSS, no
UI framework, no runtime dependencies. Why each platform needs two build
passes, along with other non-obvious parts, is covered in
[DESIGN.md](DESIGN.md#构建) (Chinese).

## Known limitations

- The browser's own account sync, search suggestions and Copilot go through
  the proxy too. That is what a browser-level proxy means, but it can trip
  account risk checks.
- HTTP and mixed ports only; a SOCKS port cannot be used directly.
- Upstream proxies requiring username/password auth are not implemented.
- It cannot be enabled while enterprise or campus policy controls proxy
  settings, since extensions rank below policy.
- When another proxy extension holds the setting it refuses to start and
  names the holder rather than taking over.
- **Firefox for Android is not supported.** `proxy.settings` does not exist
  there (Bugzilla 1725981) and every proxy write depends on it. AMO does not
  list the extension as Android-compatible, but **no manifest key can
  prevent installation on Android**; if you force it, the toggle reports
  `proxy.settings is not supported on android`
  ([details](DESIGN.md#版本下限与-android), Chinese).
- Whether QUIC / HTTP3 bypasses the proxy, and the real egress IP of private
  windows, are **untested** — open questions rather than verified guarantees.

### Platform differences

Feature parity is complete. Two operational differences remain, both rooted
in the browser APIs:

1. **You must grant "Run in Private Windows"** (installation step 2).
2. **Rule-based routing needs one more grant.** Firefox has no inline PAC,
   so routing can only work by asking the extension per request, meaning the
   browser hands it every URL. That requires the "access all websites"
   permission. The button is under **Settings → Direct-connect Rules →
   "Allow per-request routing"**. Decline and global proxying keeps working;
   grant it and you can revoke it any time in `about:addons`.

   Only `http://127.0.0.1/*` is requested by default, so anyone using just
   the global proxy never hands over that permission for a feature they do
   not use ([the trade-off](DESIGN.md#firefox-的可选权限), Chinese).

## Design notes

The fail-closed trade-off, why the two platforms cannot share code, and why
the bundled-core plan was dropped are recorded in [DESIGN.md](DESIGN.md),
along with the concrete problems hit along the way. It is written in Chinese.

## License

[MIT](LICENSE)
