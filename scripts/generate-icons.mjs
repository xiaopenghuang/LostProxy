/**
 * 图标生成器 —— 输出 src/public/icons/icon-{16,32,48,128}.png
 *
 * 为什么要自己写 PNG 编码：Chrome 扩展的 `icons` **不支持 SVG**，必须是位图。
 * 而为了一个图标引入 sharp / canvas 这类原生依赖（几十 MB、需要编译）
 * 不划算。PNG 的最小可用子集其实很小：签名 + IHDR + IDAT + IEND，
 * 压缩用 Node 内置的 zlib，校验用一段 CRC32 表。总共不到 60 行。
 *
 * 图形用 SDF（signed distance field）而不是手摆像素：
 * 这样同一份几何定义能在 16px 到 128px 都得到干净的抗锯齿边缘，
 * 不需要为每个尺寸单独画一遍。
 *
 * 图案与 UI 里的 SVG mark 一致：一条竖线向下分叉成两条——
 * 一个入口、两个出口，正是「这个浏览器走代理，其他走直连」的语义。
 *
 * ⚠️ 本脚本现在是**备用**方案。项目已改用美术稿（src/public/icons/icon.png）
 *    经 scripts/resize-icon.mjs 降采样产出四个尺寸，命令是 `npm run icons`。
 *
 *    本脚本挂在 `npm run icons:generated` 下，**会覆盖**那四个文件。
 *    只有在需要回退到程序生成的图标时才跑它。保留它的理由是：
 *    它不依赖任何美术稿，仓库在任何状态下都能产出一套可用图标。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])

  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))

  return Buffer.concat([length, body, crc])
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 每通道 8 bit
  ihdr[9] = 6 // color type 6 = RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // 默认 filter
  ihdr[12] = 0 // 非隔行

  // 每行前面要加一个 filter 字节（0 = None）。
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// 几何（坐标系为 -0.5..0.5，原点在中心）
// ---------------------------------------------------------------------------

/** 圆角矩形的 signed distance。负值表示在形状内部。 */
function roundedRectSdf(x, y, half, radius) {
  const qx = Math.abs(x) - half + radius
  const qy = Math.abs(y) - half + radius
  return (
    Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
  )
}

/** 点到线段的最短距离。 */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** 分叉图形：一条竖线向下分成两支。 */
const FORK = [
  [0, -0.23, 0, 0.02],
  [0, 0.02, -0.2, 0.23],
  [0, 0.02, 0.2, 0.23],
]

function forkDistance(x, y) {
  let best = Infinity
  for (const [ax, ay, bx, by] of FORK) {
    best = Math.min(best, segmentDistance(x, y, ax, ay, bx, by))
  }
  return best
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** Fluent 2 brand primary —— 与 UI 的 --accent 保持一致。 */
const BG = [15, 108, 189]
const FG = [255, 255, 255]

const SAMPLES = 4

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  // 小尺寸下线条要相对粗一些，否则 16px 时几乎看不见。
  const strokeRadius = size <= 24 ? 0.082 : 0.058
  const cornerRadius = size <= 24 ? 0.16 : 0.22
  // 抗锯齿带宽随分辨率收窄：低分辨率需要更宽的过渡来避免锯齿。
  const feather = 0.9 / size

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgCoverage = 0
      let fgCoverage = 0

      // 超采样：每个像素取 SAMPLES² 个样本再平均。
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) / size - 0.5
          const y = (py + (sy + 0.5) / SAMPLES) / size - 0.5

          bgCoverage += smoothstep(roundedRectSdf(x, y, 0.5, cornerRadius), feather)
          fgCoverage += smoothstep(forkDistance(x, y) - strokeRadius, feather)
        }
      }

      const total = SAMPLES * SAMPLES
      const bgAlpha = bgCoverage / total
      const fgAlpha = fgCoverage / total

      const offset = (py * size + px) * 4
      // 前景叠在背景上，整体透明度取背景覆盖率（形状之外完全透明）。
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[offset + channel] = Math.round(
          BG[channel] * (1 - fgAlpha) + FG[channel] * fgAlpha,
        )
      }
      rgba[offset + 3] = Math.round(255 * Math.max(bgAlpha, fgAlpha * bgAlpha))
    }
  }

  return rgba
}

/** distance <= 0 时返回 1，>= feather 时返回 0，中间线性过渡。 */
function smoothstep(distance, feather) {
  if (distance <= -feather) return 1
  if (distance >= feather) return 0
  return (feather - distance) / (2 * feather)
}

// ---------------------------------------------------------------------------

const OUT_DIR = resolve(import.meta.dirname, '..', 'src', 'public', 'icons')
mkdirSync(OUT_DIR, { recursive: true })

for (const size of [16, 32, 48, 128]) {
  const file = resolve(OUT_DIR, `icon-${size}.png`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodePng(size, render(size)))
  console.log(`  wrote icons/icon-${size}.png`)
}

console.log('icons generated')
