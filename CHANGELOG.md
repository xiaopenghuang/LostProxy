# Changelog

本文件的每个版本小节会被 `.github/workflows/release.yml` 提取，作为 GitHub Release
说明里的「本次变更」部分。**小节标题格式必须是 `## vX.Y.Z`**，否则提取不到。

Each version section below is extracted by `.github/workflows/release.yml` and becomes the
"what changed" part of the GitHub Release notes. **Headings must be `## vX.Y.Z`.**

---

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
