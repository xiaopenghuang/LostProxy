/**
 * 把一张大图降采样成扩展需要的 16/32/48/128 四个尺寸。
 *
 * 为什么不直接让浏览器缩：Chrome 确实会自动缩放，但它在 128→16 这种
 * 大幅缩小时用的是简单算法，细节容易糊成一团。本地用面积平均
 * （area-average / box filter）能得到明显更干净的结果 ——
 * 对于 78 倍这种大比例缩小，面积平均本身就是正确做法，
 * 且不会像 Lanczos 那样引入振铃（ringing）。
 *
 * 顺带处理一个坑：AI 生成的图往往是 RGB 无 alpha，
 * 圆角外面是白色或纯色。直接用的话在深色工具栏上会出现一个白色方块边框。
 * 本脚本会检测四角颜色，必要时按圆角裁出透明区域。
 *
 * 用法：
 *   node scripts/resize-icon.mjs                    # 自动找 icon.png
 *   node scripts/resize-icon.mjs path/to/source.png
 *   node scripts/resize-icon.mjs --no-round         # 保留原始方形，不裁圆角
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// PNG 解码
// ---------------------------------------------------------------------------

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** 解码 PNG，返回 { width, height, rgba }。只支持 8bit 非隔行（最常见形态）。 */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')

  let offset = 8
  let meta = null
  let palette = null
  let paletteAlpha = null
  const idat = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      meta = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      paletteAlpha = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length
  }

  if (!meta) throw new Error('缺少 IHDR')
  if (meta.depth !== 8) throw new Error(`不支持 ${meta.depth}bit 位深，请导出 8bit PNG`)
  if (meta.interlace !== 0) throw new Error('不支持隔行（Adam7）PNG，请重新导出为非隔行')

  const channels = CHANNELS[meta.colorType]
  if (channels === undefined) throw new Error(`未知 color type ${meta.colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = meta.width * channels
  const pixels = Buffer.alloc(stride * meta.height)

  // 逐行反滤波。
  for (let y = 0; y < meta.height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let value = line[i]

      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) value += paeth(a, b, c)

      out[i] = value & 0xff
    }
  }

  // 统一转成 RGBA。
  const rgba = Buffer.alloc(meta.width * meta.height * 4)
  for (let i = 0; i < meta.width * meta.height; i += 1) {
    const src = i * channels
    const dst = i * 4
    let r
    let g
    let b
    let a = 255

    if (meta.colorType === 0) {
      r = g = b = pixels[src]
    } else if (meta.colorType === 2) {
      ;[r, g, b] = [pixels[src], pixels[src + 1], pixels[src + 2]]
    } else if (meta.colorType === 3) {
      const index = pixels[src]
      r = palette[index * 3]
      g = palette[index * 3 + 1]
      b = palette[index * 3 + 2]
      if (paletteAlpha && index < paletteAlpha.length) a = paletteAlpha[index]
    } else if (meta.colorType === 4) {
      r = g = b = pixels[src]
      a = pixels[src + 1]
    } else {
      ;[r, g, b, a] = [pixels[src], pixels[src + 1], pixels[src + 2], pixels[src + 3]]
    }

    rgba[dst] = r
    rgba[dst + 1] = g
    rgba[dst + 2] = b
    rgba[dst + 3] = a
  }

  return { width: meta.width, height: meta.height, rgba, colorType: meta.colorType }
}

// ---------------------------------------------------------------------------
// PNG 编码（与 generate-icons.mjs 同一份实现）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
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
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// 降采样
// ---------------------------------------------------------------------------

/**
 * 面积平均降采样。
 *
 * 对每个目标像素，取它在源图上覆盖的**矩形区域**内所有像素的加权平均
 * （边缘像素按被覆盖的比例计权）。这等价于正确的预滤波，
 * 是大比例缩小的标准做法；不会像 nearest neighbor 那样丢失细节，
 * 也不会像 Lanczos 那样在高对比边缘产生振铃。
 *
 * alpha 做预乘处理：否则透明像素的 RGB（通常是黑或白）会污染边缘颜色，
 * 表现为图形周围一圈脏边。
 */
function downscale(source, target) {
  const { width, height, rgba } = source
  const out = Buffer.alloc(target * target * 4)
  const scaleX = width / target
  const scaleY = height / target

  for (let ty = 0; ty < target; ty += 1) {
    const y0 = ty * scaleY
    const y1 = (ty + 1) * scaleY

    for (let tx = 0; tx < target; tx += 1) {
      const x0 = tx * scaleX
      const x1 = (tx + 1) * scaleX

      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumA = 0
      let weightTotal = 0

      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const coverY = Math.min(sy + 1, y1) - Math.max(sy, y0)
        if (coverY <= 0) continue

        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const coverX = Math.min(sx + 1, x1) - Math.max(sx, x0)
          if (coverX <= 0) continue

          const weight = coverX * coverY
          const offset = (sy * width + sx) * 4
          const alpha = rgba[offset + 3] / 255

          // 预乘：用 alpha 加权 RGB，避免透明区域的颜色渗进边缘。
          sumR += rgba[offset] * alpha * weight
          sumG += rgba[offset + 1] * alpha * weight
          sumB += rgba[offset + 2] * alpha * weight
          sumA += rgba[offset + 3] * weight
          weightTotal += weight
        }
      }

      const dst = (ty * target + tx) * 4
      const avgA = sumA / weightTotal
      const alpha = avgA / 255

      // 反预乘回普通 RGBA。
      if (alpha > 0.0001) {
        out[dst] = Math.round(Math.min(255, sumR / weightTotal / alpha))
        out[dst + 1] = Math.round(Math.min(255, sumG / weightTotal / alpha))
        out[dst + 2] = Math.round(Math.min(255, sumB / weightTotal / alpha))
      }
      out[dst + 3] = Math.round(avgA)
    }
  }

  return out
}

/**
 * 小尺寸下增强笔画对比度。
 *
 * 为什么需要：面积平均是大比例缩小的正确算法，但它很"温和" ——
 * 一条 1254px 图上 20px 宽的白线，缩到 16px 只剩 0.25px，
 * 平均下来变成一个半透明的浅蓝像素。数值上正确，视觉上发灰、糊。
 *
 * 这里对亮度做一次 S 曲线拉伸：把偏亮的像素推向纯白、偏暗的推向纯底色，
 * 让笔画在极小尺寸下重新"立"起来。只在 16/32 上做 ——
 * 48 以上像素够多，原始抗锯齿本身就是需要的细节。
 */
function boostContrast(size, rgba, strength) {
  for (let i = 0; i < size * size; i += 1) {
    const o = i * 4
    if (rgba[o + 3] < 8) continue

    const lum = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000 / 255
    // 以 0.5 为轴心做幂律拉伸：亮的更亮，暗的更暗。
    const boosted =
      lum < 0.5
        ? 0.5 * Math.pow(lum / 0.5, 1 + strength)
        : 1 - 0.5 * Math.pow((1 - lum) / 0.5, 1 + strength)

    // 按亮度变化比例缩放 RGB，保持色相不漂移。
    const ratio = lum > 0.01 ? boosted / lum : 0
    for (let c = 0; c < 3; c += 1) {
      rgba[o + c] = Math.max(0, Math.min(255, Math.round(rgba[o + c] * ratio)))
    }
  }
}

/**
 * 按圆角矩形裁出透明区域。
 *
 * AI 生成的图常常是 RGB 无 alpha、圆角外围是白色。直接用会在深色工具栏上
 * 出现一个白色方块。这里把圆角外的像素改成透明，边缘做抗锯齿过渡。
 *
 * feather 刻意不随尺寸线性缩小：16px 下若用 size/48 会得到 0.33px 的过渡带，
 * 结果是四角只被"减淡"而没到透明 —— 白方块依旧存在。固定下限保证裁得干净。
 */
function applyRoundedCorners(size, rgba, radiusRatio) {
  const radius = size * radiusRatio
  const feather = Math.min(1.2, Math.max(0.5, size / 64))

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 到圆角矩形边界的 signed distance。
      const dx = Math.abs(x + 0.5 - size / 2) - (size / 2 - radius)
      const dy = Math.abs(y + 0.5 - size / 2) - (size / 2 - radius)
      const distance =
        Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - radius

      let coverage = 1
      if (distance > feather) coverage = 0
      else if (distance > -feather) coverage = (feather - distance) / (2 * feather)

      if (coverage < 1) {
        const offset = (y * size + x) * 4
        rgba[offset + 3] = Math.round(rgba[offset + 3] * coverage)
      }
    }
  }
}

/**
 * 找出图形（非底色部分）的实际包围盒。
 *
 * 判据是"与四角底色的差异"：底色可能是白也可能是蓝，
 * 所以不写死颜色，而是采样四角作为参考色。
 */
function findGlyphBounds(source, tolerance = 42) {
  const { width, height, rgba } = source

  // 以四角平均色作为底色参考。
  const cornerOffsets = [
    0,
    (width - 1) * 4,
    (height - 1) * width * 4,
    ((height - 1) * width + width - 1) * 4,
  ]
  const base = [0, 1, 2].map(
    (c) => cornerOffsets.reduce((sum, o) => sum + rgba[o + c], 0) / cornerOffsets.length,
  )

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4
      if (rgba[o + 3] < 40) continue

      const diff =
        Math.abs(rgba[o] - base[0]) + Math.abs(rgba[o + 1] - base[1]) + Math.abs(rgba[o + 2] - base[2])
      if (diff > tolerance) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < 0) return null
  return { minX, minY, maxX, maxY }
}

/**
 * 按包围盒把图形重新居中，并统一留白比例。
 *
 * 为什么需要：AI 生成的图形常常不在画布正中（本项目遇到的原图就偏上），
 * 也常常留白过多或过少。图标在工具栏里是并排显示的，
 * 留白不一致会让它看起来比邻居大一圈或小一圈。
 *
 * 这里输出一张正方形画布，图形按最长边缩放到 targetRatio，然后精确居中。
 */
function recenter(source, bounds, targetRatio) {
  const glyphW = bounds.maxX - bounds.minX + 1
  const glyphH = bounds.maxY - bounds.minY + 1
  const glyphSize = Math.max(glyphW, glyphH)

  // 画布边长 = 图形长边 / 目标占比。
  const canvas = Math.round(glyphSize / targetRatio)
  const out = Buffer.alloc(canvas * canvas * 4)

  // 底色取四角平均，填满画布（后续裁圆角时会处理边缘）。
  const cornerOffsets = [
    0,
    (source.width - 1) * 4,
    (source.height - 1) * source.width * 4,
    ((source.height - 1) * source.width + source.width - 1) * 4,
  ]
  const base = [0, 1, 2].map(
    (c) =>
      Math.round(
        cornerOffsets.reduce((sum, o) => sum + source.rgba[o + c], 0) / cornerOffsets.length,
      ),
  )
  for (let i = 0; i < canvas * canvas; i += 1) {
    out[i * 4] = base[0]
    out[i * 4 + 1] = base[1]
    out[i * 4 + 2] = base[2]
    out[i * 4 + 3] = 255
  }

  // 把图形区域贴到画布正中。
  const offsetX = Math.round((canvas - glyphW) / 2)
  const offsetY = Math.round((canvas - glyphH) / 2)

  for (let y = 0; y < glyphH; y += 1) {
    for (let x = 0; x < glyphW; x += 1) {
      const src = ((bounds.minY + y) * source.width + bounds.minX + x) * 4
      const dst = ((offsetY + y) * canvas + offsetX + x) * 4
      if (dst < 0 || dst + 3 >= out.length) continue
      source.rgba.copy(out, dst, src, src + 4)
    }
  }

  return { width: canvas, height: canvas, rgba: out, colorType: 6 }
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const noRound = args.includes('--no-round')
const noCenter = args.includes('--no-center')
const explicit = args.find((a) => !a.startsWith('--'))

const ICON_DIR = resolve(import.meta.dirname, '..', 'src', 'public', 'icons')
const candidates = explicit
  ? [resolve(process.cwd(), explicit)]
  : [
      resolve(ICON_DIR, 'icon.png'),
      resolve(ICON_DIR, 'source.png'),
      resolve(import.meta.dirname, '..', 'icon-source.png'),
    ]

const sourcePath = candidates.find((p) => existsSync(p))
if (!sourcePath) {
  console.error('找不到源图。请把大图放到 src/public/icons/icon.png，或作为参数传入路径。')
  process.exit(1)
}

let source = decodePng(readFileSync(sourcePath))
console.log(`源图: ${sourcePath}`)
console.log(`      ${source.width}x${source.height}  colorType=${source.colorType}`)

if (source.width !== source.height) {
  console.warn(`⚠ 非正方形（${source.width}x${source.height}），缩放后会变形。建议先裁成正方形。`)
}

/*
 * 关于「自动居中」：此方试过，然后撤掉了。
 *
 * 包围盒检测以四角为底色参考。而典型的图标源图是「白底 + 蓝色圆角矩形 + 白色图形」，
 * 于是整个蓝色矩形都被判定为"图形"，包围盒等于全图 ——
 * 再按 58% 占比重排，就得到一个被白边框吃掉一半面积的图标（实测发生过）。
 *
 * 要正确处理，得先识别「圆角矩形底板」这一层再往里找图形，
 * 那已经是图像分割的活儿，对一个图标脚本来说完全不成比例。
 *
 * 现实是：AI 生成的图标源图基本都是居中的（本项目这张留白上下左右全为 0）。
 * 所以正确的做法是**不做**这件事，需要调整时用图像编辑器裁一下更快更准。
 * 保留 findGlyphBounds/recenter 两个函数仅作诊断参考，默认不调用。
 */

// 诊断四角：若不透明且接近白色，说明圆角外是白底，需要裁掉。
const corners = [
  0,
  (source.width - 1) * 4,
  (source.height - 1) * source.width * 4,
  ((source.height - 1) * source.width + source.width - 1) * 4,
]
const cornerInfo = corners.map((o) => ({
  rgb: [source.rgba[o], source.rgba[o + 1], source.rgba[o + 2]],
  a: source.rgba[o + 3],
}))
const opaqueLightCorners = cornerInfo.filter(
  (c) => c.a > 200 && c.rgb[0] > 225 && c.rgb[1] > 225 && c.rgb[2] > 225,
).length

console.log(
  `四角: ${cornerInfo.map((c) => `rgba(${c.rgb.join(',')},${c.a})`).join('  ')}`,
)

const shouldRound = !noRound && opaqueLightCorners >= 3
if (shouldRound) {
  console.log('      -> 四角为不透明浅色，判定为白底圆角图，将裁出透明圆角')
} else if (noRound) {
  console.log('      -> --no-round，保留原样')
} else {
  console.log('      -> 四角无需处理，保留原样')
}

console.log('')
for (const size of [16, 32, 48, 128]) {
  const scaled = downscale(source, size)

  // 只在小尺寸补对比度：48 以上像素足够，原始抗锯齿是需要的细节。
  if (size <= 32) boostContrast(size, scaled, size <= 16 ? 0.9 : 0.45)

  // 小尺寸圆角比例略大，视觉上才协调（Fluent 的做法）。
  if (shouldRound) applyRoundedCorners(size, scaled, size <= 24 ? 0.16 : 0.22)

  const file = resolve(ICON_DIR, `icon-${size}.png`)
  writeFileSync(file, encodePng(size, scaled))
  console.log(`  wrote icon-${size}.png`)
}

console.log('')
console.log('完成。运行 npm run build，然后在 edge://extensions 点刷新。')
