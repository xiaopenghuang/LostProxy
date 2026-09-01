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
- **`gecko_android.strict_min_version` is `999.0`, which excludes Android on
  purpose.** `proxy.settings` is not implemented on Firefox for Android
  ([Bugzilla 1725981](https://bugzilla.mozilla.org/show_bug.cgi?id=1725981),
  still open), and every proxy write in this extension goes through it. Without
  that key Android inherits the desktop floor and the add-on installs into a
  browser where its only function throws. 999 is the highest major the manifest
  schema accepts (`^[0-9]{1,3}(\.[a-z0-9]+)+$`); it is a sentinel, not a real
  target.
- **The proxy target is the user's own machine.** The default and only
  install-time host permission is `http://127.0.0.1/*`. The add-on never
  contacts a remote server of ours; there is no telemetry and no analytics
  (`data_collection_permissions.required` is `["none"]`).
- **`<all_urls>` is optional, not required.** It is only requested when the user
  turns on rule-based routing, which needs `proxy.onRequest` — and
  `proxy.onRequest` requires the filter to be a subset of host permissions. The
  request happens in a click handler on the add-on's own settings page. Users
  who only want a single global proxy never grant it.
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
  interface. It only calls `proxy.settings`, `privacy.network`, and
  `storage.local`.

## Where to start reading

| File | What it does |
| --- | --- |
| `src/background/platform/firefox.ts` | Every Firefox proxy API call, plus the routing listener |
| `src/background/proxy.ts` | Decisions only — no browser API calls |
| `src/background/orchestrator.ts` | Message handling |
| `src/options/options.ts` | Settings page, including the optional-permission request |
| `src/manifest.firefox.json` | The submitted manifest |

Comments in those files are in Chinese, as that is the maintainer's working
language. The identifiers, commit messages, and this file are in English. If any
comment matters to your review and is unclear, please ask and it will be
translated.
