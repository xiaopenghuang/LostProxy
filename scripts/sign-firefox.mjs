/**
 * 把 Firefox 版提交给 AMO 签名，取回可长期安装的 .xpi。
 *
 * ## 为什么需要这一步
 *
 * Firefox 的 Release 与 Beta **一律强制扩展签名，没有开关**（自 Firefox 48
 * 起那个 preference 被移除）。`about:debugging` 那条路是临时的，重启即失效。
 * 所以要长期装，只有两条路：让 Mozilla 签，或者换用 Developer Edition /
 * Nightly / ESR 并关掉 `xpinstall.signatures.required`。
 *
 * 后者是**整个 profile 全局生效**的 —— 此后任何未签名扩展都能装进去。
 * 对一个以"不静默泄漏"为卖点的代理工具来说，为了装它而把浏览器的扩展
 * 签名防线整个关掉，方向是反的。所以走签名。
 *
 * ## unlisted：签名但不公开上架
 *
 * `--channel unlisted` 拿回一个签好的 .xpi，可在普通 Firefox 上从文件安装，
 * 但**不出现在 AMO 的公开列表里**。适合"自己用 / 小范围用"。
 *
 * ⚠️ 它仍然走 Mozilla 的正式流程：要签 Add-on Distribution Agreement，
 *    代码随时可能被人工复审。这不是"私下签个名"。
 *
 * ## 为什么调 web-ext 而不自己写 AMO 客户端
 *
 * 手写是可行的 —— JWT 是 HS256，用 node 内置 crypto 十几行；上传是 multipart，
 * node 18+ 原生有 FormData。但 AMO 的文档开头明写着：
 *
 *   > These APIs are not frozen and can change at any time without warning.
 *
 * 把发布能力押在一个会随时变的 API 上，坏掉的时机正是你要发版的时候。
 * `web-ext` 是 Mozilla 自己维护、跟着那些变动走的工具。
 *
 * 更决定性的一点：此方**没法测**一个手写的客户端 —— 那需要真的 AMO 凭据。
 * 交出去一份没跑过的网络代码，比多一个工具依赖糟得多。
 *
 * ## 为什么不把 web-ext 写进 devDependencies
 *
 * 它带 324 个传递依赖（含 `@devicefarmer/adbkit` 这种安卓调试桥），
 * 而签名是维护者一年用几次的动作，**CI 从不需要它**。
 * 写进 package.json 会让每次 `npm ci`（包括 CI 的每一次）都多装那 324 个包。
 *
 * 所以用 `npx --yes web-ext@<钉死的版本>` 按需拉取。版本钉在本文件里，
 * 所以仍然是可复现的 —— 而不是 `npx web-ext` 那种"每次拿最新"。
 *
 * ## 凭据
 *
 * 从环境变量读，**绝不落盘、绝不进 git**：
 *   AMO_API_KEY     JWT issuer，形如 user:12345:67
 *   AMO_API_SECRET  JWT secret
 *
 * 到 https://addons.mozilla.org/developers/addon/api/key/ 生成。
 * 放进 `.env`（已在 .gitignore 里）然后 `set -a; . ./.env; set +a`，
 * 或者临时 export。本脚本**不打印**它们的值，出错时也只说"缺哪个"。
 *
 * ## 用法
 *
 *   npm run sign:firefox
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { findStrayRootEntries } from './repo-manifest.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = resolve(ROOT, 'release')
const DIST = resolve(ROOT, 'dist-firefox')

/**
 * 钉死的 web-ext 版本。
 *
 * 刻意不用 `latest`：签名是发布路径，而发布路径上的"每次拿最新"意味着
 * 一次上游变更就能让发版失败，且失败点在别人的代码里。
 * 升级它应当是一次显式的、有人看着的改动。
 */
const WEB_EXT_VERSION = '10.6.0'

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

/* ---------- 前置检查 ---------- */

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

if (!existsSync(resolve(DIST, 'manifest.json'))) {
  fail('dist-firefox/ 里没有 manifest.json —— 先跑 npm run build')
}

const manifest = JSON.parse(readFileSync(resolve(DIST, 'manifest.json'), 'utf8'))

if (manifest.version !== version) {
  fail(`版本号不一致：manifest=${manifest.version} package.json=${version}`)
}

/*
 * add-on ID 是签名的硬前提。
 *
 * 没有它 AMO 无法把这次提交与既有条目关联，而更隐蔽的后果是
 * 后续更新会被当成一个**新扩展**，用户装上的那份永远收不到更新。
 */
const addonId = manifest.browser_specific_settings?.gecko?.id
if (typeof addonId !== 'string' || addonId.length === 0) {
  fail('manifest.firefox.json 缺 browser_specific_settings.gecko.id，AMO 签名必须有它')
}

/*
 * `proxy` 权限的最低版本要求（Mozilla 2021 年那次 proxy API 滥用事件之后加的）。
 *
 * addons-linter 会因为这一条直接拒收，而它的报错文本
 * （"requires strict_min_version to be set to 91.1.0 or above"）
 * 在提交前就该被拦住 —— 上传一次再被拒是白等一轮。
 */
const minVersion = manifest.browser_specific_settings?.gecko?.strict_min_version
if (manifest.permissions?.includes('proxy') === true) {
  const major = Number.parseFloat(minVersion ?? '0')
  if (!Number.isFinite(major) || major < 91.1) {
    fail(`用了 proxy 权限，strict_min_version 必须 ≥ 91.1，当前是 ${minVersion ?? '（未设置）'}`)
  }
}

const apiKey = process.env.AMO_API_KEY
const apiSecret = process.env.AMO_API_SECRET

const missing = [
  apiKey ? null : 'AMO_API_KEY',
  apiSecret ? null : 'AMO_API_SECRET',
].filter((v) => v !== null)

if (missing.length > 0) {
  // 只说缺哪个，不回显任何已有值。
  fail(
    `缺环境变量：${missing.join(', ')}\n\n` +
      '  到 https://addons.mozilla.org/developers/addon/api/key/ 生成，然后：\n' +
      '    set -a; . ./.env; set +a\n' +
      '  （.env 已在 .gitignore 里。别把它提交上去，也别贴给任何人。）',
  )
}

/* ---------- 源码包 ---------- */

/**
 * 生成给审核员的源码包。
 *
 * 🔴 **这一步不是可选的。** Mozilla 明文要求：用了 bundler 或 minifier
 *    就必须附源码，而审核员会**重跑你的构建并逐字节 diff**
 *    ——「There must be no differences」。我们的 background.js 是 Vite
 *    打包压缩的，正好落在这条里。
 *
 * 用 `git archive` 而不是自己遍历目录，理由有三：
 *
 *   1. 它**只含已跟踪文件**，所以 `docs/`（维护者的私有设计笔记）与
 *      `.env`（凭据）被 .gitignore 自动排除 —— 不依赖此方在这里
 *      手写一份排除清单，而漏一项的后果是把凭据寄给 Mozilla。
 *   2. 产物精确对应一个 git ref，"提交的源码"与"仓库状态"之间没有缝。
 *   3. 顺带拦住"拿未提交的改动去签名"—— 那样审核员 diff 出来必然不一致。
 *
 * ⚠️ 因此**未提交的改动不会进源码包**。这是刻意的，见第 3 条。
 */
function buildSourceArchive() {
  const name = `lostproxy-source-v${version}.zip`
  const outPath = resolve(OUT_DIR, name)

  mkdirSync(OUT_DIR, { recursive: true })

  let dirty = ''
  try {
    dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    fail('这里不像一个 git 仓库 —— 源码包靠 git archive 生成')
  }

  if (dirty.length > 0) {
    fail(
      '工作区有未提交的改动，源码包会漏掉它们，而审核员 diff 时必然报不一致。\n\n' +
        '  先提交（或 stash），再签名。当前改动：\n' +
        dirty
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
    )
  }

  if (!existsSync(resolve(ROOT, 'REVIEWERS.md'))) {
    fail('缺 REVIEWERS.md —— 那是给审核员的构建说明，没有它这次提交会被退回补材料')
  }

  /*
   * 🔴 根目录白名单 —— 在生成压缩包**之前**查。
   *
   * v0.4.2 的源码包里带了一张误提交的截图（根目录的 `image.png`）。
   * 没有任何环节报错：构建正常、测试全绿、下载到的 zip 干净 ——
   * 因为 `package.mjs` 只从 `dist/` 取文件，而源码包取的是全部已跟踪文件。
   *
   * 截图这种东西可能带着窗口标题、文件路径、节点名甚至订阅链接，
   * 而它的收件人是外部审核员。这道检查在此，而不是只在 CI 的
   * `repo-hygiene.test.ts` 里，是因为**签名是真正会把东西寄出去的那一步** ——
   * 拦在这里意味着即便有人跳过了测试也漏不出去。
   */
  const stray = findStrayRootEntries(ROOT)
  if (stray.length > 0) {
    fail(
      '仓库根目录有不在白名单上的条目，它们会随源码包一起寄给 AMO 审核员：\n' +
        stray.map((n) => `    ${n}`).join('\n') +
        '\n\n  该删就 git rm，是正经的项目文件就加进 scripts/repo-manifest.mjs。',
    )
  }

  execFileSync('git', ['archive', '--format=zip', '-o', outPath, 'HEAD'], { cwd: ROOT })

  const sha = createHash('sha256').update(readFileSync(outPath)).digest('hex')
  return { name, outPath, sha, size: statSync(outPath).size }
}

/* ---------- 主流程 ---------- */

/**
 * 准备待签目录 —— `dist-firefox/` 的副本，加上 LICENSE。
 *
 * 🔴 **不能直接签 `dist-firefox/`。** 此方第一版就是那么干的，
 *    往构建产物里 `copyFileSync` 了一个 LICENSE，结果制造了两个 bug：
 *
 *    1. `package.mjs` 遍历 dist 时找到那个 LICENSE，**又额外 push 一次**
 *       （MIT 要求许可证随副本分发，它一直是显式加的）——
 *       于是发布的 zip 里 `LICENSE` 出现**两次**。一个畸形压缩包，
 *       不同解压工具的处理方式并不一致。
 *
 *    2. web-ext 会在 `--source-dir` 里留一个 `.amo-upload-uuid`
 *       状态文件，它随后被打进发布 zip —— 产物多了个陌生文件，
 *       hash 也跟着变（3f107e8c… → a9d77b2a…），可复现性直接没了。
 *
 *    两个 bug 的根因是同一个：**签名步骤写了构建产物**。
 *    构建产物应当只由构建产生，任何别的东西往里写都会以某种形式漏出去。
 *
 * ⚠️ 这个目录**刻意不清空**。web-ext 用 `.amo-upload-uuid` 记住上一次上传，
 *    好在审核超时后重跑时**接着上次的**而不是新建一个版本 ——
 *    而重复创建同一个版本会撞"版本已存在"。清掉它等于把那条恢复路径砍了。
 *
 * 放在 `release/` 下面，因为那整个目录已经在 .gitignore 里。
 */
function prepareStaging() {
  const staging = resolve(OUT_DIR, 'firefox-unsigned')
  mkdirSync(staging, { recursive: true })

  for (const entry of readdirSync(DIST, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const rel = join(entry.parentPath ?? entry.path, entry.name).slice(DIST.length + 1)
    const target = resolve(staging, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(resolve(DIST, rel), target)
  }

  /*
   * LICENSE 与发布 zip 保持一致（`package.mjs` 也是显式加的）。
   *
   * 两份产物内容不一致本身就是隐患：它让"发布的 zip"与"签名的 xpi"
   * 不再能互相印证，而 REVIEWERS.md 给审核员的复现步骤也会对不上。
   */
  copyFileSync(resolve(ROOT, 'LICENSE'), resolve(staging, 'LICENSE'))

  return staging
}

const STAGING = prepareStaging()

const source = buildSourceArchive()

const distFiles = readdirSync(STAGING, { recursive: true, withFileTypes: true }).filter((e) =>
  e.isFile(),
)

console.log(`\nLostProxy v${version} → AMO（unlisted）`)
console.log(`  add-on id        ${addonId}`)
console.log(`  strict_min       ${minVersion}`)
console.log(`  待签目录          dist-firefox/  (${distFiles.length} 个文件)`)
console.log(`  源码包            ${source.name}  ${source.size} bytes`)
console.log(`  源码包 sha256     ${source.sha}`)
console.log('\n把源码包一并上传 —— background.js 是打包压缩过的，AMO 要求附源码。\n')

/*
 * 交给 web-ext。
 *
 * ⚠️ 凭据经**环境变量**传给子进程，不进命令行参数。
 *    命令行是全局可见的（ps / 任务管理器 / shell history），
 *    而这两个值等于"能以你的身份向 AMO 提交任何东西"。
 *    web-ext 认 WEB_EXT_API_KEY / WEB_EXT_API_SECRET 这两个环境变量。
 */
const args = [
  '--yes',
  `web-ext@${WEB_EXT_VERSION}`,
  'sign',
  // 🔴 签暂存目录，**不是** dist-firefox —— 见 prepareStaging() 的注释。
  '--source-dir',
  STAGING,
  '--artifacts-dir',
  OUT_DIR,
  '--channel',
  'unlisted',
  '--upload-source-code',
  source.outPath,
]

/**
 * 找出怎么调 npx。返回 `[可执行文件, 前置参数]`。
 *
 * 🔴 Windows 上这件事有两层坑，此方两层都踩了：
 *
 *   1. `npx` 是 `npx.cmd`（batch shim），不是可执行文件。
 *      `execFileSync('npx', ...)` 直接 **ENOENT**。
 *
 *   2. 换成 `'npx.cmd'` 之后变成 **EINVAL** —— Node 为 CVE-2024-27980
 *      加了防护：自 18.20.2 / 20.12.2 / 21.7.3 起，不带 `shell: true`
 *      就不允许 spawn `.cmd` / `.bat`。
 *
 * ⚠️ 刻意**不用** `shell: true` 来绕第 2 层。那会让参数被拼进一条 shell
 *    命令行重新解析，于是路径里的空格与特殊字符得自己转义 ——
 *    而本项目的开发路径带非 ASCII（`I:\开发\LostProxy`），
 *    正是最容易在这一层出问题的形状。更别提那正是 CVE-2024-27980 本身
 *    要防的东西：为了绕过一个安全修复而重新引入它防的问题。
 *
 * 解法是**绕过 shim**：`npx` 本质是 `node <npm>/bin/npx-cli.js`，
 * 直接用当前的 node 去跑那个 JS 入口。参数保持 argv 数组语义 ——
 * 逐个原样传给子进程，不经过任何 shell 解析。
 */
function resolveNpx() {
  const nodeDir = dirname(process.execPath)
  const candidates = [
    resolve(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    // Linux / macOS 的常见布局：node 在 bin/，npm 在 lib/node_modules/。
    resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ]

  for (const cli of candidates) {
    if (existsSync(cli)) return [process.execPath, [cli]]
  }

  /*
   * 找不到 npx-cli.js 就退回直接调 `npx`。
   *
   * 在 Linux / macOS 上那本来就能用（npx 是个真 shim 脚本，不是 .cmd）。
   * 在 Windows 上它会失败 —— 但失败得**清楚**（ENOENT/EINVAL，下面的
   * catch 会说明什么都没提交），而这比此方在这里编一条猜测的路径要好。
   */
  return ['npx', []]
}

const [npxBin, npxPrefix] = resolveNpx()

try {
  execFileSync(npxBin, [...npxPrefix, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      WEB_EXT_API_KEY: apiKey,
      WEB_EXT_API_SECRET: apiSecret,
    },
  })
} catch (thrown) {
  /*
   * 🔴 分清"web-ext 压根没起来"与"它跑了但失败"。
   *
   * 两者该说的话完全相反：前者**什么都没提交**，版本号还是干净的，
   * 直接重跑就行；后者提交可能已经在 AMO 那边，重传会撞
   * "版本已存在"，得去开发者面板看状态。
   *
   * 此方第一版把两者合成一条提示，于是在 web-ext 根本没启动的情况下
   * 告诉 Master"提交可能已在 AMO 那边" —— 一个会让人不敢重跑、
   * 甚至去手动改版本号的误导。
   */
  if (thrown?.code === 'ENOENT' || thrown?.code === 'EINVAL') {
    fail(
      `启动 npx 失败（${thrown.code}，用的是 ${npxBin}）。\n` +
        '  web-ext **没有启动，什么都没提交**，版本号仍然干净 —— 修好后直接重跑。\n\n' +
        '  确认 node 与 npm 都在（node -v / npm -v）。\n' +
        '  EINVAL 通常意味着退回到了直接调 npx.cmd，而 Node 不允许那样做\n' +
        '  （CVE-2024-27980 的防护）—— 说明上面 resolveNpx() 没找到 npx-cli.js。',
    )
  }

  /*
   * 到这里说明 web-ext 真的跑过了，它自己已经把 AMO 的原始报错打在上面
   * （addons-linter 的校验结果、审核状态等）。这里不复述 ——
   * 复述只会把那些有用的原文推到屏幕外。
   */
  fail(
    '签名未完成，具体原因见上面 web-ext 的输出。\n\n' +
      '  校验失败      → 按它列出的项改，然后重跑\n' +
      '  等待审核超时  → 提交已经在 AMO 那边了，**别重传**（会撞版本已存在）。\n' +
      '                  去 https://addons.mozilla.org/developers/ 看状态并下载',
  )
}

console.log(`\n✓ 签好的 .xpi 在 release/ 里。`)
console.log('  安装：Firefox → about:addons → 齿轮 → 从文件安装附加组件')
console.log('  这份是签过名的，普通 Firefox 也能长期装，重启不会掉。\n')
