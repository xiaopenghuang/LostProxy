/*
 * 把 dist/ 打成可分发的 zip —— 本地和 CI 走同一条代码路径。
 *
 * 为什么不在 workflow 的 YAML 里直接写 zip 命令：
 * 那样 CI 的打包逻辑和「此方在本机手动打的那一版」是两份实现，会悄悄漂移。
 * 抽成脚本之后，`npm run package` 在哪跑都是同一个结果，Release 说明里写的
 * 安装步骤也就一直有效。
 *
 * 为什么自己写 ZIP 而不调 `zip` 命令：
 * `zip` 在 ubuntu runner 和 git-bash 里有，在裸 Windows 上没有。自己写掉的是
 * 一个环境依赖，代价约 70 行，且本仓库已有先例（resize-icon.mjs 里手写了
 * PNG 编解码）。zlib 是 Node 内置的，deflate 不用装东西。
 *
 * 这个脚本同时是一道发布闸门，任一条不满足就退出非零：
 *   - git tag / manifest.json / package.json 三处版本号必须一致
 *   - manifest 引用的每个文件都必须真的在包里
 *   - dist/ 必须存在且含 manifest.json
 */

import { deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, join, relative, posix, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = resolve(ROOT, 'dist')
const OUT_DIR = resolve(ROOT, 'release')

/* ---------- CRC32（ZIP 每个条目都要，与 PNG 用的是同一个多项式） ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ---------- ZIP 写入 ---------- */

/*
 * 时间戳固定，默认 2026-01-01 00:00:00。
 * 理由：同一份 dist 反复打包应该得到同一个文件，否则「哈希对不上」会变成
 * 日常噪音，真出问题时反而没人当回事。可用 SOURCE_DATE_EPOCH 覆盖。
 *
 * 注意别过度承诺：这不等于跨环境 bit-for-bit 可复现 —— 不同 Node / zlib 版本
 * 的 deflate 输出可能有差异。真正的来源保证由 CI 的 attestation 提供，
 * 时间戳固定只是消除最吵的那个变量。
 */
function dosDateTime() {
  const epoch = process.env.SOURCE_DATE_EPOCH
  const d = epoch ? new Date(Number(epoch) * 1000) : new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()
  return { time, date }
}

function buildZip(entries) {
  const { time, date } = dosDateTime()
  const locals = []
  const centrals = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const deflated = deflateRawSync(data, { level: 9 })
    // 只有压缩确实更小才用 deflate，否则存原文（method 0）
    const useDeflate = deflated.length < data.length
    const payload = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: bit 11 = UTF-8 filename
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    locals.push(local, nameBuf, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0o644 << 16, 38) // external attrs: unix 0644
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuf, end])
}

/* ---------- 收集文件 ---------- */

function walk(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join(posix.sep))
  }
  return out
}

/* ---------- 闸门 ---------- */

const problems = []

function gate(ok, message) {
  if (!ok) problems.push(message)
  return ok
}

/* ---------- 主流程 ---------- */

if (!existsSync(resolve(DIST, 'manifest.json'))) {
  console.error('dist/manifest.json 不存在 —— 先跑 npm run build')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(resolve(DIST, 'manifest.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const version = manifest.version

gate(
  manifest.version === pkg.version,
  `版本号不一致：manifest.json=${manifest.version} package.json=${pkg.version}`,
)

// CI 里由 tag 触发时校验第三处。GITHUB_REF_NAME 形如 "v0.1.0"。
const refName = process.env.GITHUB_REF_NAME ?? ''
if (process.env.GITHUB_REF_TYPE === 'tag') {
  gate(
    refName === `v${version}`,
    `git tag 与 manifest 版本不一致：tag=${refName} manifest=v${version}\n` +
      `    改 src/manifest.json 与 package.json 的 version，或重新打正确的 tag。`,
  )
}

const files = walk(DIST)
const entries = files.map((name) => ({ name, data: readFileSync(resolve(DIST, name)) }))

// MIT 要求许可证随「所有副本」分发，所以 LICENSE 一并进包。
entries.push({ name: 'LICENSE', data: readFileSync(resolve(ROOT, 'LICENSE')) })
entries.sort((a, b) => (a.name < b.name ? -1 : 1))

// manifest 引用的每个文件都必须在包里。少一个图标就是「装上去图标是空白」，
// 少 background.js 就是「装上去直接报错」，都属于下载完才发现的那类失败。
const present = new Set(entries.map((e) => e.name))
const refs = new Set()
const collect = (v) => {
  if (typeof v === 'string' && /\.(js|html|png|css|json)$/.test(v)) refs.add(v)
  else if (v && typeof v === 'object') Object.values(v).forEach(collect)
}
collect(manifest)
for (const r of [...refs].sort()) {
  gate(present.has(r), `manifest 引用了包里不存在的文件：${r}`)
}

if (problems.length > 0) {
  console.error('打包中止：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'))
  process.exit(1)
}

const zip = buildZip(entries)
const name = `lostproxy-v${version}.zip`
const outPath = resolve(OUT_DIR, name)
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(outPath, zip)

const sha = createHash('sha256').update(zip).digest('hex')
writeFileSync(resolve(OUT_DIR, `${name}.sha256`), `${sha}  ${name}\n`)

console.log(`${name}  ${zip.length} bytes  ${entries.length} entries`)
console.log(`sha256  ${sha}`)
console.log(`manifest 引用的 ${refs.size} 个文件全部在包内`)

// 供 workflow 后续步骤使用
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\nname=${name}\npath=${outPath}\nsha256=${sha}\n`,
    { flag: 'a' },
  )
}

