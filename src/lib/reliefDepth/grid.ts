// WO-2173: the float-grid helpers the depth pipeline needs - resampling, blur, percentiles.
// Plain loops over Float32Array so they run the same in a worker, in Node tests and in any browser.

export interface Grid {
  width: number
  height: number
  data: Float32Array
}

export function grid(width: number, height: number, data?: Float32Array): Grid {
  return { width, height, data: data ?? new Float32Array(width * height) }
}

/** Catmull-Rom (a = -0.5), the bicubic PIL and the DPT image processor use. */
function cubic(x: number): number {
  const a = -0.5
  x = Math.abs(x)
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1
  if (x < 2) return ((a * x - 5 * a) * x + 8 * a) * x - 4 * a
  return 0
}

interface Taps { start: Int32Array; count: Int32Array; weights: Float32Array; stride: number }

/** Per-output-pixel taps for one axis. When shrinking, the kernel widens by the scale so every input pixel
 *  contributes (no aliasing) - the same rule PIL's resize uses. */
function taps(inSize: number, outSize: number): Taps {
  const scale = inSize / outSize
  const support = 2 * Math.max(scale, 1)
  const stride = Math.ceil(support) * 2 + 1
  const start = new Int32Array(outSize)
  const count = new Int32Array(outSize)
  const weights = new Float32Array(outSize * stride)
  const fscale = Math.max(scale, 1)
  for (let i = 0; i < outSize; i++) {
    const centre = (i + 0.5) * scale
    const lo = Math.max(0, Math.floor(centre - support))
    const hi = Math.min(inSize, Math.ceil(centre + support))
    let sum = 0
    const n = Math.min(hi - lo, stride)
    for (let k = 0; k < n; k++) {
      const w = cubic((lo + k + 0.5 - centre) / fscale)
      weights[i * stride + k] = w
      sum += w
    }
    if (sum !== 0) for (let k = 0; k < n; k++) weights[i * stride + k] /= sum
    start[i] = lo
    count[i] = n
  }
  return { start, count, weights, stride }
}

/** Separable bicubic resize of `channels` interleaved planes (1 for a grid, 3 for RGB). */
export function resizeInterleaved(src: Float32Array, w: number, h: number, channels: number, ow: number, oh: number): Float32Array {
  if (w === ow && h === oh) return src.slice()
  const tx = taps(w, ow)
  const ty = taps(h, oh)
  const mid = new Float32Array(ow * h * channels)
  for (let y = 0; y < h; y++) {
    const row = y * w * channels
    for (let x = 0; x < ow; x++) {
      const s = tx.start[x], n = tx.count[x], wo = x * tx.stride
      for (let c = 0; c < channels; c++) {
        let acc = 0
        for (let k = 0; k < n; k++) acc += tx.weights[wo + k] * src[row + (s + k) * channels + c]
        mid[(y * ow + x) * channels + c] = acc
      }
    }
  }
  const out = new Float32Array(ow * oh * channels)
  for (let y = 0; y < oh; y++) {
    const s = ty.start[y], n = ty.count[y], wo = y * ty.stride
    for (let x = 0; x < ow; x++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0
        for (let k = 0; k < n; k++) acc += ty.weights[wo + k] * mid[((s + k) * ow + x) * channels + c]
        out[(y * ow + x) * channels + c] = acc
      }
    }
  }
  return out
}

export function resize(g: Grid, ow: number, oh: number): Grid {
  return grid(ow, oh, resizeInterleaved(g.data, g.width, g.height, 1, ow, oh))
}

/** One box-blur pass of radius r along x then y, edges clamped. O(n) whatever the radius. */
function boxPass(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const span = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / span
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / span
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

/** Gaussian blur approximated by three box passes (Wells 1986 / Kovesi). Small sigmas use an exact kernel,
 *  where three integer boxes are too coarse. */
export function gaussianBlur(g: Grid, sigma: number): Grid {
  const { width: w, height: h } = g
  if (sigma <= 0) return grid(w, h, g.data.slice())
  if (sigma < 2) return grid(w, h, exactGaussian(g.data, w, h, sigma))
  const n = 3
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1)
  let wl = Math.floor(wIdeal)
  if (wl % 2 === 0) wl--
  const wu = wl + 2
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4))
  let data = g.data
  for (let i = 0; i < n; i++) data = boxPass(data, w, h, ((i < m ? wl : wu) - 1) / 2)
  return grid(w, h, data)
}

function exactGaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0
    for (let i = -r; i <= r; i++) acc += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))]
    tmp[y * w + x] = acc
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0
    for (let i = -r; i <= r; i++) acc += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]
    out[y * w + x] = acc
  }
  return out
}

/** Low and high percentiles (0..100) of a grid, from a sorted copy. */
export function percentiles(data: Float32Array, lo: number, hi: number): [number, number] {
  const sorted = Float32Array.from(data).sort()
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]
  return [at(lo), at(hi)]
}
