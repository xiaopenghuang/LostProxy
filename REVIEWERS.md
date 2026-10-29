# Build instructions for AMO reviewers

This add-on's `background.js` is bundled and minified by Vite, so
[AMO requires the source code](https://extensionworkshop.com/documentation/publish/source-code-submission/)
alongside the submitted package. This file tells you how to reproduce the
submitted build byte-for-byte.

Everything needed is in this archive. There are no private repositories, no
vendored frameworks, and no commercial or web-based tools in the build path.

## Environment

| | |
| --- | --- |
| Node.js | 22 LTS (built and tested on 22.17.1) |
| npm | ships with Node 22 |
| OS | Any. Developed on Windows 10, built on `ubuntu-latest` in CI |

No other tools are required. Every build tool is an open-source npm package
pinned by `package-lock.json`, which is included in this archive — please use
`npm ci` rather than `npm install` so you get exactly those versions.

## Reproducing the submitted package

```bash
npm ci
npm run build:firefox
cp LICENSE dist-firefox/
```

`@biomejs/biome` is a lint-only dev dependency: `npm ci` installs it, but neither
`build:firefox` nor `package` invokes it, and skipping `npm run lint` has no effect
on the output. It is listed so that `npm ci` reproduces our CI exactly.

`dist-firefox/` now holds exactly the contents of the submitted archive.

`LICENSE` is copied in by the release script rather than produced by the
build — the add-on is MIT-licensed and the license accompanies the package.
That is the only file in the package that the build does not generate.

## Verifying it matches

```bash
mkdir /tmp/submitted && unzip -q <the-submitted-file>.xpi -d /tmp/submitted
diff -r dist-firefox /tmp/submitted
```

This should report no differences.

If you prefer to check against a released artifact instead, every release
publishes a SHA-256 next to the archive, and the build is reproducible:
`npm run package` on a clean checkout of the matching tag yields the same hash.
Release archives are also attested with Sigstore via GitHub's build
provenance, so `gh attestation verify` works on them.

## What the build does

| Command | Effect |
| --- | --- |
| `npm run build:firefox` | Two Vite passes into `dist-firefox/` — extension pages, then the background script |
| `npm run package` | The above for both browsers, then zips each with a SHA-256 |
| `npm run verify` | Typecheck, unit tests, both builds |

Two passes are needed because the MV3 background script must be a single
self-contained file (`format: 'iife'`), which is incompatible with the
multi-entry build the popup and options pages use.

The Firefox and Chromium builds share all source. Platform differences live in
`src/background/platform/`, selected by a **build-time** constant
(`__LOSTPROXY_PLATFORM__` in `vite.shared.ts`) rather than runtime detection, so
each bundle contains only its own platform's code. `tests/platform-boundary.test.ts`
asserts this against the built bundles.

## About the `proxy` permission

This add-on's entire purpose is to route **only this browser** through a proxy
server the user already runs locally — typically a Mihomo/Clash core on
`127.0.0.1`. It exists so a user can put one browser behind a proxy without
touching the operating system's proxy settings.

Points that may be relevant to your review:

- **`strict_min_version` is `140.0`**, well above the `91.1` floor that
  [Securing the proxy API](https://blog.mozilla.org/security/2021/10/25/securing-the-proxy-api-for-firefox-add-ons/)
  asks for. Firefox's own proxy-failover behaviour therefore applies. 140 is also
  the first version supporting `data_collection_permissions`, so the built-in
  consent experience works rather than being silently ignored.
- **`gecko_android` is deliberately absent.** `proxy.settings` is not implemented
  on Firefox for Android
  ([Bugzilla 1725981](https://bugzilla.mozilla.org/show_bug.cgi?id=1725981),
  still open), and every proxy write in this extension goes through it. Per
  Extension Workshop, including *any* `gecko_android` object — even an empty one —
  signals Android compatibility, so omitting the key is the only correct way to say
  "desktop only". Note the flip side: no manifest key can actually *prevent*
  installation on Android. If someone installs it there, the proxy toggle reports
  `proxy.settings is not supported on android.` rather than failing silently.
- **The proxy target is the user's own machine.** The install-time host permissions
  are `http://127.0.0.1/*` (the local proxy/controller) and `https://ipinfo.io/*`
  (used only by the optional timezone feature below). The add-on never contacts a
  server of ours; there is no telemetry and no analytics.
- **`<all_urls>` is optional, not required.** It is requested in a click handler on
  the add-on's own settings page, for two features: rule-based routing
  (`proxy.onRequest` requires the filter to be a subset of host permissions), and
  timezone sync (which must inject a script into the sites the user lists). The
  runtime request asks for the specific origins involved, never for `<all_urls>`
  itself. Users who only want a single global proxy never grant it.
- **Routing rules never become code.** On Firefox the direct-connect list is
  evaluated in `proxy.onRequest` as data. (The Chromium build generates a PAC
  script; that path serialises rules with `JSON.stringify` behind a character
  allowlist and is not used here.)
- **Failures are visible, not silent.** If the local proxy is unreachable the
  request fails rather than falling back to a direct connection — see the
  trailing `null` in the `proxy.onRequest` return value, which is deliberate
  (`src/background/platform/firefox.ts`). The add-on's stated purpose is that
  traffic never leaves unproxied without the user knowing.
- **The add-on does not modify system state.** No changes to Windows proxy
  settings, WinHTTP, the registry, routing tables, DNS, or any virtual network
  interface. It calls `proxy.settings`, `privacy.network`, `storage.local`, and —
  only for the geo-identity feature described below — `scripting.executeScript`
  and `declarativeNetRequest.updateDynamicRules`.

### Timezone and language sync (v0.7.0, extended in v0.8.0)

**Off by default.** When the user enables it and grants a site, the add-on:

1. sends one request through the proxy to `https://ipinfo.io/json` (falling back to
   `https://ipapi.co/json/`), and keeps only the `timezone`, `country` and `ip`
   fields of the response;
2. injects a small self-contained function into that site's main world at
   navigation start, overriding the timezone surface of `Date` (offset, local-time
   getters, string forms), `Intl.DateTimeFormat`, and `navigator.language(s)`;
3. **only if the user also ticks "Match the exit language too"** (a separate
   switch, off by default), installs a `declarativeNetRequest` rule that sets
   `Accept-Language` on requests to those sites to match the exit country.

**Why step 3 needs its own permission.** `Accept-Language` is a request header the
browser attaches automatically; page script cannot reach it, and it is the signal
servers read without executing any JS. The rule set is deliberately narrow:

- every rule carries the `||<domain>` URL filter for **a domain the user listed and
  granted**, so nothing outside that list is touched;
- rules live in the id range 9100–9999 only, so the extension can recognise and
  remove exactly its own rules and nothing else;
- rules are **cleared on every path that turns the feature off** — disabling the
  proxy, turning off the setting, emptying the site list, or failing to resolve a
  country — plus once at browser startup. Rules persist across restarts, so leaving
  one behind would keep rewriting headers with no visible trace.

If the rule cannot be installed, the extension skips the language part entirely and
only changes the timezone. That is intentional: a page whose header says `zh-CN`
while its JS says `en-US` is more distinctive than one that changes neither.

Why `data_collection_permissions` says `optional: ["locationInfo"]`:

- The probe reveals the user's exit IP to ipinfo.io, which is location information.
- It is **optional rather than required** because the feature ships off. A user who
  never enables it never sends anything, so making it a condition of installation
  would be inaccurate.
- Consent for that category is requested in the same click that grants site access
  (`permissions.request({ origins, data_collection })`), and can be revoked in
  about:addons. Nothing is stored anywhere except `storage.local` on the user's
  machine.

What this feature deliberately does **not** do: it does not change the user's IP
address, it does not cover Workers, and it makes no claim to defeat fingerprinting
— no canvas, WebGL or font manipulation of any kind. Its only purpose is to stop
the exit location from contradicting the timezone and language the browser reports.

## Where to start reading

| File | What it does |
| --- | --- |
| `src/background/platform/firefox.ts` | Every Firefox proxy API call, plus the routing listener |
| `src/background/proxy.ts` | Decisions only — no browser API calls |
| `src/background/orchestrator.ts` | Message handling |
| `src/background/timezone.ts` | The exit-IP probe and when it is re-run |
| `src/background/inject-timezone.ts` | The function injected into pages; self-contained by necessity |
| `src/background/netrule.ts` | The `Accept-Language` rule set and its teardown paths |
| `src/shared/locales.ts` | Country → locale table and `Accept-Language` formatting |
| `src/options/options.ts` | Settings page, including both optional-permission requests |
| `src/manifest.firefox.json` | The submitted manifest |

Comments in those files are in Chinese, as that is the maintainer's working
language. The identifiers, commit messages, and this file are in English. If any
comment matters to your review and is unclear, please ask and it will be
translated.
