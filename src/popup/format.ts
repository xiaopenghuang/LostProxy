/**
 * Popup 的纯展示辅助函数。
 *
 * 单独成模块的唯一原因是**可测**：`popup.ts` 一被 import 就会执行顶层副作用
 * （首次 GET_STATUS、启动吞吐轮询），单元测试里没法干净地只取几个纯函数。
 * 把这些无副作用的纯函数拎出来，测它们不必假装是在跑一个 Popup。
 *
 * 这里只放**纯函数**：给定输入返回输出，不碰 DOM、不发消息、不读时钟。
 */

/**
 * 按延迟给节点排序（V0.8）。
 *
 * 有延迟的按升序在前，未测的（null）保持原始相对顺序垫底。**稳定排序** ——
 * 测速前所有节点延迟都是 null，于是原样保持订阅顺序，不打乱用户熟悉的排列；
 * 测速后最快的自然冒顶。这个「测速前不动、测速后才排」的性质是刻意的。
 */
export function sortNodesByLatency(
  nodes: readonly string[],
  latency: Readonly<Record<string, number | null>>,
): string[] {
  return nodes
    .map((name, index) => ({ name, index, delay: latency[name] ?? null }))
    .sort((a, b) => {
      if (a.delay === null && b.delay === null) return a.index - b.index
      if (a.delay === null) return 1
      if (b.delay === null) return -1
      if (a.delay !== b.delay) return a.delay - b.delay
      return a.index - b.index // 延迟相等时保持原序
    })
    .map((x) => x.name)
}

/**
 * 挑出延迟最低的节点（V0.8）。
 *
 * 全部未测（没有任何数值延迟）时返回 null —— 此时「最快」无从谈起，调用方应先测速。
 * `delay <= 0` 在内核语义里表示测试失败，不算候选。
 */
export function pickFastest(
  nodes: readonly string[],
  latency: Readonly<Record<string, number | null>>,
): string | null {
  let best: string | null = null
  let bestDelay = Infinity
  for (const name of nodes) {
    const d = latency[name]
    if (typeof d === 'number' && d > 0 && d < bestDelay) {
      best = name
      bestDelay = d
    }
  }
  return best
}

/**
 * 由两次累计流量采样算出瞬时速率（字节/秒）（V0.8）。
 *
 * 没有上一次采样时返回 null —— 无从谈「速率」，UI 应隐藏而非显示 0。
 * 差值为负说明内核重启、累计计数器归零了，钳到 0 而非显示负速率或巨大跳变。
 */
export function computeRate(
  prev: { up: number; down: number; at: number } | null,
  cur: { up: number; down: number; at: number },
): { up: number; down: number } | null {
  if (prev === null) return null
  const elapsed = (cur.at - prev.at) / 1000
  if (elapsed <= 0) return null
  const up = cur.up - prev.up
  const down = cur.down - prev.down
  return { up: up > 0 ? up / elapsed : 0, down: down > 0 ? down / elapsed : 0 }
}

/**
 * 把字节数格式化成人类可读的量（V0.8）。
 *
 * 用 1024 进制（KiB/MiB）而非 1000 —— 内核报的是原始字节，网络流量惯用二进制单位。
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  // 个位数保留一位小数，其余取整 —— 「1.5 MiB」有用，「734.8 B」是噪音。
  const shown = i === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0)
  return `${shown} ${units[i]}`
}

/**
 * 由一串数值构造 SVG polyline 的 `points`（V0.8）。
 *
 * 按传入的**共同最大值** `max` 缩放到 [0, height]，x 均分整个宽度。少于 2 个点
 * 返回空串（画不出线）。共用最大值而非各自最大 —— 上/下行两条线要能横向比较。
 */
export function buildSparkline(
  values: readonly number[],
  max: number,
  width: number,
  height: number,
): string {
  if (values.length < 2) return ''
  const span = max > 0 ? max : 1
  const step = width / (values.length - 1)
  return values
    .map((v, i) => {
      const x = i * step
      // 值越大线越高 → y 越小；钳进 [0, height] 防越界。
      const y = height - Math.min(Math.max(v / span, 0), 1) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
