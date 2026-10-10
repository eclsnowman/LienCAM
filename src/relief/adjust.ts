// Image relief - the Auto adjustment and the filters it runs, on the picture's
// own pixels, all in float (docs/design/RELIEF-WHAT-GOOD-LOOKS-LIKE.md
// section 4; the prototype is auto_adjust() in
// relief-references/fixtures/make_fixtures.py, and these follow it step for
// step: scipy's median_filter / gaussian_filter edge rule is 'reflect', the
// gaussian is cut at 4 sigma, numpy's percentile interpolates linearly).

import type { Picture } from './picture'

export type PictureKind = 'artwork' | 'heightmap' | 'photo'

/** What Auto chose for a picture - stored with the feature so a replay filters exactly the same way. */
export interface AutoParams {
  kind: PictureKind
  /** Auto turned Invert image on (dark art on light paper, so the art rises) */
  invert: boolean
  /** levels clip at each end, a fraction (0.005 = 0.5 %) */
  clip: number
  /** 3 x 3 median first (photos) */
  median: boolean
  /** Gaussian smooth: in picture pixels (height maps) or in mm on the part (photos, artwork) */
  smoothPx?: number
  smoothMm?: number
  /** the zero plane Auto set (artwork: the background level, so the background lands on the face) */
  zeroPlane: number
}

/** The adjustment used when Auto is switched off: the picture as it is, with the standard's light manual smooth (section 2: 0.10 mm). */
export const MANUAL_ADJUST: AutoParams = { kind: 'photo', invert: false, clip: -1, median: false, smoothMm: 0.1, zeroPlane: 0 }

/** Above this many values, percentiles count into 65,536 bins instead of sorting (exact for 8- and 16-bit levels). */
const SORT_LIMIT = 200_000
const BINS = 65_536

/** Values at the given fractions of the sorted data (0..1), linearly interpolated like numpy.percentile. */
export function percentiles(a: Float32Array, fractions: number[]): number[] {
  if (a.length > SORT_LIMIT && inUnitRange(a)) return binnedPercentiles(a, fractions)
  const sorted = Float32Array.from(a).sort()
  return fractions.map((f) => {
    const rank = Math.min(Math.max(f, 0), 1) * (sorted.length - 1)
    const lo = Math.floor(rank)
    const hi = Math.min(lo + 1, sorted.length - 1)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
  })
}

function inUnitRange(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (!(a[i] >= 0 && a[i] <= 1)) return false
  return true
}

/** percentiles() for big pictures: the k-th smallest value read from a histogram of values in 0..1. */
function binnedPercentiles(a: Float32Array, fractions: number[]): number[] {
  const count = new Uint32Array(BINS)
  for (let i = 0; i < a.length; i++) count[Math.min(BINS - 1, Math.max(0, Math.round(a[i] * (BINS - 1))))]++
  const kth = (k: number): number => {
    let seen = 0
    for (let b = 0; b < BINS; b++) {
      seen += count[b]
      if (seen > k) return b / (BINS - 1)
    }
    return 1
  }
  return fractions.map((f) => {
    const rank = Math.min(Math.max(f, 0), 1) * (a.length - 1)
    const lo = Math.floor(rank)
    const vlo = kth(lo)
    return vlo + (kth(Math.min(lo + 1, a.length - 1)) - vlo) * (rank - lo)
  })
}

function median(values: Float32Array): number {
  return percentiles(values, [0.5])[0]
}

/** scipy 'reflect': (d c b a | a b c d | d c b a). */
function reflect(i: number, n: number): number {
  if (n === 1) return 0
  const period = 2 * n
  let k = ((i % period) + period) % period
  if (k >= n) k = period - 1 - k
  return k
}

/** 3 x 3 median filter (edges reflect). */
export function median3(a: Float32Array, cols: number, rows: number): Float32Array {
  const out = new Float32Array(a.length)
  const w = new Float32Array(9)
  for (let r = 0; r < rows; r++) {
    const up = reflect(r - 1, rows) * cols, mid = r * cols, down = reflect(r + 1, rows) * cols
    for (let c = 0; c < cols; c++) {
      const l = c === 0 ? reflect(-1, cols) : c - 1
      const rt = c === cols - 1 ? reflect(cols, cols) : c + 1
      w[0] = a[up + l]; w[1] = a[up + c]; w[2] = a[up + rt]
      w[3] = a[mid + l]; w[4] = a[mid + c]; w[5] = a[mid + rt]
      w[6] = a[down + l]; w[7] = a[down + c]; w[8] = a[down + rt]
      // partial selection: the 5th smallest of 9
      for (let i = 0; i < 5; i++) {
        let m = i
        for (let j = i + 1; j < 9; j++) if (w[j] < w[m]) m = j
        const t = w[i]; w[i] = w[m]; w[m] = t
      }
      out[r * cols + c] = w[4]
    }
  }
  return out
}

/** Separable Gaussian, sigma in pixels, cut at 4 sigma, edges reflect (scipy.ndimage.gaussian_filter). */
export function gaussian(a: Float32Array, cols: number, rows: number, sigma: number): Float32Array {
  if (!(sigma > 0)) return a
  const rad = Math.max(1, Math.round(4 * sigma))
  const w = new Float32Array(2 * rad + 1)
  let sum = 0
  for (let i = -rad; i <= rad; i++) { w[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += w[i + rad] }
  for (let i = 0; i < w.length; i++) w[i] /= sum
  const tmp = new Float32Array(a.length)
  const line = new Float32Array(Math.max(cols, rows) + 2 * rad)
  for (let r = 0; r < rows; r++) {
    const base = r * cols
    for (let i = -rad; i < cols + rad; i++) line[i + rad] = a[base + reflect(i, cols)]
    for (let c = 0; c < cols; c++) {
      let s = 0
      for (let k = 0; k < w.length; k++) s += w[k] * line[c + k]
      tmp[base + c] = s
    }
  }
  const out = new Float32Array(a.length)
  for (let c = 0; c < cols; c++) {
    for (let i = -rad; i < rows + rad; i++) line[i + rad] = tmp[reflect(i, rows) * cols + c]
    for (let r = 0; r < rows; r++) {
      let s = 0
      for (let k = 0; k < w.length; k++) s += w[k] * line[r + k]
      out[r * cols + c] = s
    }
  }
  return out
}

/** Stretch so the `clip` fraction at each end saturates: min -> 0 and max -> 1 when clip is 0. */
export function levels(a: Float32Array, clip: number): Float32Array {
  const [lo, hi] = percentiles(a, [clip, 1 - clip])
  const span = Math.max(hi - lo, 1e-6)
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = Math.min(Math.max((a[i] - lo) / span, 0), 1)
  return out
}

function borderValues(a: Float32Array, cols: number, rows: number, band = 4): Float32Array {
  const out: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r < band || r >= rows - band || c < band || c >= cols - band) out.push(a[r * cols + c])
    }
  }
  return Float32Array.from(out)
}

/**
 * What kind of picture this is (section 4 step 2):
 * - artwork: at least 85 % of pixels near black or white after a 0.5 % stretch;
 * - height map: 16-bit, or smooth (median |pixel - 3x3 median| below 0.6 grey levels);
 * - photo: everything else.
 */
export function classifyPicture(p: Picture): PictureKind {
  const [lo, hi] = percentiles(p.grey, [0.005, 0.995])
  const span = Math.max(hi - lo, 1e-6)
  let extreme = 0
  for (let i = 0; i < p.grey.length; i++) {
    const b = Math.min(Math.max((p.grey[i] - lo) / span, 0), 1)
    if (b < 0.15 || b > 0.85) extreme++
  }
  if (extreme / p.grey.length >= 0.85) return 'artwork'
  if (p.bitDepth === 16) return 'heightmap'
  const m = median3(p.grey, p.cols, p.rows)
  const dev = new Float32Array(p.grey.length)
  for (let i = 0; i < dev.length; i++) dev[i] = Math.abs(p.grey[i] - m[i])
  return median(dev) * 255 < 0.6 ? 'heightmap' : 'photo'
}

/** The Auto button's choices for a picture (section 4). Depth, direction and base are not Auto's (step 6 sets them from the size rule). */
export function autoParams(p: Picture): AutoParams {
  const kind = classifyPicture(p)
  if (kind === 'heightmap') return { kind, invert: false, clip: 0, median: false, smoothPx: p.bitDepth === 16 ? 0.5 : 2, zeroPlane: 0 }
  if (kind === 'photo') return { kind, invert: false, clip: 0.005, median: true, smoothMm: 0.2, zeroPlane: 0 }
  // artwork: light border -> invert so the art rises; zero plane = the background after levels
  const invert = median(borderValues(p.grey, p.cols, p.rows)) > 0.5
  const src = invert ? p.grey.map((v) => 1 - v) : p.grey
  const background = median(borderValues(levels(src, 0), p.cols, p.rows))
  const zeroPlane = Math.min(0.99, Math.ceil(Math.max(background, 0) * 100 - 1e-9) / 100)
  return { kind, invert, clip: 0, median: false, smoothMm: 0.15, zeroPlane }
}

/** The smoothing sigma in picture pixels, for a picture placed at `pitchMm` mm per pixel. */
export function smoothSigmaPx(params: AutoParams, pitchMm: number): number {
  if (params.smoothPx !== undefined) return params.smoothPx
  return (params.smoothMm ?? 0) / Math.max(pitchMm, 1e-9)
}

/**
 * The adjusted picture, 0..1, float: median (photos), levels, smooth. Invert
 * and the zero plane are NOT applied here - they are live height controls
 * (reliefHeights.ts), and both commute with these filters.
 */
export function adjustPicture(p: Picture, params: AutoParams, pitchMm: number): Float32Array {
  let a = p.grey
  if (params.median) a = median3(a, p.cols, p.rows)
  if (params.clip >= 0) a = levels(a, params.clip)
  return gaussian(a, p.cols, p.rows, smoothSigmaPx(params, pitchMm))
}

/** One console line saying what Auto did (section 4 step 7), e.g. "Auto: artwork, inverted, background -> face, smooth 0.15 mm". */
export function describeAuto(params: AutoParams, pitchMm: number): string {
  const smooth = params.smoothPx !== undefined
    ? `smooth ${params.smoothPx} px (${(params.smoothPx * pitchMm).toFixed(2)} mm)`
    : `smooth ${(params.smoothMm ?? 0).toFixed(2)} mm`
  if (params.kind === 'artwork') return `Auto: artwork${params.invert ? ', inverted' : ''}, background -> face, ${smooth}`
  if (params.kind === 'heightmap') return `Auto: height map, levels stretched (no clip), ${smooth}`
  return `Auto: photo, 3 x 3 median, levels clipped 0.5 %, ${smooth}`
}

// ---------------------------------------------------------------------------
// WO-2174 (image relief stage 2): the picture adjustments the palette shows,
// each with the standard's default (RELIEF-WHAT-GOOD-LOOKS-LIKE.md section 2).
// Plain float filters on the picture's own pixels, run in the relief worker
// like stage 1's (S4: heights stay float, a 16-bit picture keeps its levels).
// Order: greyscale channel -> denoise (median) -> levels (black / midtones /
// white) -> contrast / brightness -> smooth (Gaussian) -> edge-keeping smooth.

/** How colour becomes grey (section 2: Luma, R, G, B, Max). */
export type GreyChannel = 'luma' | 'red' | 'green' | 'blue' | 'max'

export const GREY_CHANNELS: ReadonlyArray<readonly [GreyChannel, string]> = [['luma', 'Luma'], ['red', 'R'], ['green', 'G'], ['blue', 'B'], ['max', 'Max']]

/** Every stage-2 adjustment's value: saved with the relief feature, so a replay filters exactly the same way. */
export interface PictureAdjust {
  channel: GreyChannel
  /** levels black / white points as fractions of the grey range, 0..1 (the palette shows 0..255); black < white */
  black: number
  white: number
  /** midtones (gamma) 0.30 .. 3.00: above 1 fattens the middle heights, below 1 sharpens the peaks */
  midtones: number
  /** -100 .. +100, 0 = neutral */
  contrast: number
  brightness: number
  /** median radius in picture px, 0 .. 5 (1 = 3 x 3); 0 = off */
  denoisePx: number
  /** Gaussian sigma in mm on the part, 0 .. 5 */
  smoothMm: number
  /** Gaussian sigma in picture px instead (Auto's height-map choice); set only by Auto, cleared when the operator sets mm */
  smoothPx?: number
  /** edge-keeping (bilateral) smooth: spatial sigma in mm, 0 .. 3; 0 = off */
  edgeSmoothMm: number
  /** its range sigma as a fraction of the grey range, 0 .. 0.30 */
  edgeRange: number
}

/** The manual defaults (section 2's DEFAULT column): the picture as it is, with the standard's light 0.10 mm smooth. */
export const MANUAL_PICTURE_ADJUST: PictureAdjust = {
  channel: 'luma', black: 0, white: 1, midtones: 1, contrast: 0, brightness: 0, denoisePx: 0, smoothMm: 0.1, edgeSmoothMm: 0, edgeRange: 0.1,
}

/** The edge-keeping smooth's values when it is switched on (section 2 gives only its range: spatial 0-3 mm, range 0-30 %). */
export const EDGE_SMOOTH_ON = { edgeSmoothMm: 0.5, edgeRange: 0.1 } as const

/**
 * Auto's choices (section 4) as adjustment values, so the palette shows what
 * Auto set and every control starts from it: the 3 x 3 median for photos, the
 * levels points Auto's clip lands on (measured after the median, as Auto's
 * filter chain runs), its smoothing. applyAdjust(p, autoAdjust(p, a)) equals
 * adjustPicture(p, a) - stage 1's Auto, unchanged.
 */
export function autoAdjust(p: Picture, auto: AutoParams): PictureAdjust {
  let black = 0, white = 1
  if (auto.clip >= 0) {
    const src = auto.median ? median3(p.grey, p.cols, p.rows) : p.grey
    const [lo, hi] = percentiles(src, [auto.clip, 1 - auto.clip])
    black = lo
    white = lo + Math.max(hi - lo, 1e-6)
  }
  return {
    channel: 'luma', black, white, midtones: 1, contrast: 0, brightness: 0,
    denoisePx: auto.median ? 1 : 0,
    smoothMm: auto.smoothMm ?? 0,
    ...(auto.smoothPx !== undefined ? { smoothPx: auto.smoothPx } : {}),
    edgeSmoothMm: 0, edgeRange: MANUAL_PICTURE_ADJUST.edgeRange,
  }
}

/** The picture's grey by one channel: luma (Rec. 709, the picture's own grey), a colour channel, or the brightest of the three. */
export function greyOf(p: Picture, channel: GreyChannel): Float32Array {
  if (channel === 'luma' || p.rgb === undefined) return p.grey
  const rgb = p.rgb
  const out = new Float32Array(p.grey.length)
  const k = channel === 'red' ? 0 : channel === 'green' ? 1 : channel === 'blue' ? 2 : -1
  for (let i = 0; i < out.length; i++) out[i] = (k >= 0 ? rgb[i * 3 + k] : Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])) / 65535
  return out
}

/** Contrast's slope: 0 -> 1, -100 -> flat, +100 -> a hard threshold (capped just short of it). */
function contrastSlope(contrast: number): number {
  const c = Math.min(Math.max(contrast, -100), 99)
  return Math.tan(((c / 100 + 1) * Math.PI) / 4)
}

/** Levels (black / midtones / white), then contrast and brightness about mid-grey: one value in, one out, 0..1. */
export function toneCurve(a: Pick<PictureAdjust, 'black' | 'white' | 'midtones' | 'contrast' | 'brightness'>): (v: number) => number {
  const span = Math.max(a.white - a.black, 1e-6)
  const inv = 1 / Math.min(Math.max(a.midtones, 0.3), 3)
  const k = contrastSlope(a.contrast)
  const lift = Math.min(Math.max(a.brightness, -100), 100) / 100
  const bend = a.midtones !== 1, tone = a.contrast !== 0 || a.brightness !== 0
  return (v) => {
    let t = Math.min(Math.max((v - a.black) / span, 0), 1)
    if (bend) t = Math.pow(t, inv)
    if (tone) t = Math.min(Math.max((t - 0.5) * k + 0.5 + lift, 0), 1)
    return t
  }
}

function isNeutralTone(a: PictureAdjust): boolean {
  return a.black === 0 && a.white === 1 && a.midtones === 1 && a.contrast === 0 && a.brightness === 0
}

/** k-th smallest of w[0..n-1] (quickselect; w is reordered). */
function select(w: Float32Array, n: number, k: number): number {
  let lo = 0, hi = n - 1
  while (lo < hi) {
    const pivot = w[(lo + hi) >> 1]
    let i = lo, j = hi
    while (i <= j) {
      while (w[i] < pivot) i++
      while (w[j] > pivot) j--
      if (i <= j) { const t = w[i]; w[i] = w[j]; w[j] = t; i++; j-- }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return w[k]
  }
  return w[k]
}

/** Median over a (2r+1) x (2r+1) square, edges reflect (scipy's median_filter); r = 1 is median3. */
export function medianFilter(a: Float32Array, cols: number, rows: number, radius: number): Float32Array {
  const r = Math.round(radius)
  if (r < 1) return a
  if (r === 1) return median3(a, cols, rows)
  const size = 2 * r + 1, n = size * size, mid = n >> 1
  const w = new Float32Array(n)
  const xs = new Int32Array(cols + 2 * r)
  for (let i = -r; i < cols + r; i++) xs[i + r] = reflect(i, cols)
  const ys = new Int32Array(size)
  const out = new Float32Array(a.length)
  for (let y = 0; y < rows; y++) {
    for (let j = 0; j < size; j++) ys[j] = reflect(y - r + j, rows) * cols
    for (let x = 0; x < cols; x++) {
      let k = 0
      for (let j = 0; j < size; j++) {
        const row = ys[j]
        for (let i = 0; i < size; i++) w[k++] = a[row + xs[x + i]]
      }
      out[y * cols + x] = select(w, n, mid)
    }
  }
  return out
}

/** Below this spatial sigma (px) the edge-keeping smooth is computed exactly; at and above it, on a bilateral grid. */
export const BILATERAL_GRID_FROM_PX = 3

/**
 * Edge-keeping (bilateral) smooth: each pixel becomes the average of its
 * neighbours weighted by distance (Gaussian, sigma `sigmaPx`) AND by how close
 * their grey is to its own (Gaussian, sigma `range`), so skin smooths and an
 * eyelid's edge stays. Small radii are computed exactly (neighbours inside
 * the picture, out to 2 sigma); big ones on a bilateral grid (Paris and
 * Durand 2006), which keeps a 3 mm radius on a 2048-pixel picture fast.
 */
export function bilateral(a: Float32Array, cols: number, rows: number, sigmaPx: number, range: number): Float32Array {
  if (!(sigmaPx > 0) || !(range > 0)) return a
  return sigmaPx < BILATERAL_GRID_FROM_PX ? bilateralExact(a, cols, rows, sigmaPx, range) : bilateralGrid(a, cols, rows, sigmaPx, range)
}

export function bilateralExact(a: Float32Array, cols: number, rows: number, sigmaPx: number, range: number): Float32Array {
  const rad = Math.max(1, Math.ceil(2 * sigmaPx))
  const size = 2 * rad + 1
  const spatial = new Float32Array(size * size)
  for (let j = -rad; j <= rad; j++) for (let i = -rad; i <= rad; i++) spatial[(j + rad) * size + i + rad] = Math.exp(-(i * i + j * j) / (2 * sigmaPx * sigmaPx))
  const k = -1 / (2 * range * range)
  const out = new Float32Array(a.length)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = a[y * cols + x]
      let sum = 0, wsum = 0
      for (let j = Math.max(-rad, -y); j <= Math.min(rad, rows - 1 - y); j++) {
        const row = (y + j) * cols
        for (let i = Math.max(-rad, -x); i <= Math.min(rad, cols - 1 - x); i++) {
          const q = a[row + x + i]
          const d = q - v
          const wgt = spatial[(j + rad) * size + i + rad] * Math.exp(k * d * d)
          sum += wgt * q
          wsum += wgt
        }
      }
      out[y * cols + x] = sum / wsum
    }
  }
  return out
}

function bilateralGrid(a: Float32Array, cols: number, rows: number, sigmaPx: number, range: number): Float32Array {
  const P = 2
  const gx = Math.ceil((cols - 1) / sigmaPx) + 1 + 2 * P
  const gy = Math.ceil((rows - 1) / sigmaPx) + 1 + 2 * P
  const gz = Math.ceil(1 / range) + 1 + 2 * P
  const cells = gx * gy * gz
  let val: Float32Array = new Float32Array(cells), wt: Float32Array = new Float32Array(cells)
  const at = (x: number, y: number, z: number) => (z * gy + y) * gx + x
  // splat: each pixel into its nearest cell
  for (let y = 0; y < rows; y++) {
    const cy = Math.round(y / sigmaPx) + P
    for (let x = 0; x < cols; x++) {
      const v = Math.min(Math.max(a[y * cols + x], 0), 1)
      const i = at(Math.round(x / sigmaPx) + P, cy, Math.round(v / range) + P)
      val[i] += v
      wt[i] += 1
    }
  }
  // blur: [1 4 6 4 1] / 16 (a unit-sigma Gaussian in grid cells) along each axis
  const blur = (src: Float32Array, stride: number, n: number, axisOf: (i: number) => number): Float32Array => {
    const out = new Float32Array(cells)
    for (let i = 0; i < cells; i++) {
      const p = axisOf(i)
      let s = 6 * src[i]
      if (p >= 1) s += 4 * src[i - stride]
      if (p >= 2) s += src[i - 2 * stride]
      if (p + 1 < n) s += 4 * src[i + stride]
      if (p + 2 < n) s += src[i + 2 * stride]
      out[i] = s / 16
    }
    return out
  }
  const axes: Array<[number, number, (i: number) => number]> = [
    [1, gx, (i) => i % gx],
    [gx, gy, (i) => Math.floor(i / gx) % gy],
    [gx * gy, gz, (i) => Math.floor(i / (gx * gy))],
  ]
  for (const [stride, n, axisOf] of axes) {
    val = blur(val, stride, n, axisOf)
    wt = blur(wt, stride, n, axisOf)
  }
  // slice: trilinear at each pixel's own place and grey
  const out = new Float32Array(a.length)
  for (let y = 0; y < rows; y++) {
    const fy = y / sigmaPx + P
    const y0 = Math.floor(fy), ty = fy - y0
    for (let x = 0; x < cols; x++) {
      const v = Math.min(Math.max(a[y * cols + x], 0), 1)
      const fx = x / sigmaPx + P, fz = v / range + P
      const x0 = Math.floor(fx), z0 = Math.floor(fz)
      const tx = fx - x0, tz = fz - z0
      let s = 0, w = 0
      for (let dz = 0; dz <= 1; dz++) {
        const wz = dz === 0 ? 1 - tz : tz
        for (let dy = 0; dy <= 1; dy++) {
          const wy = dy === 0 ? 1 - ty : ty
          for (let dx = 0; dx <= 1; dx++) {
            const wxyz = wz * wy * (dx === 0 ? 1 - tx : tx)
            const i = at(x0 + dx, y0 + dy, z0 + dz)
            s += wxyz * val[i]
            w += wxyz * wt[i]
          }
        }
      }
      out[y * cols + x] = w > 1e-12 ? s / w : a[y * cols + x]
    }
  }
  return out
}

/** The Gaussian smooth's sigma in picture px for a picture placed at `pitchMm` mm per pixel. */
export function adjustSmoothPx(a: PictureAdjust, pitchMm: number): number {
  return a.smoothPx !== undefined ? a.smoothPx : a.smoothMm / Math.max(pitchMm, 1e-9)
}

/** The adjusted picture, 0..1, float, through every stage-2 adjustment (invert and the zero plane stay live height controls). */
export function applyAdjust(p: Picture, a: PictureAdjust, pitchMm: number): Float32Array {
  let x: Float32Array = greyOf(p, a.channel)
  if (a.denoisePx >= 1) x = medianFilter(x, p.cols, p.rows, a.denoisePx)
  if (!isNeutralTone(a)) {
    const f = toneCurve(a)
    const y = new Float32Array(x.length)
    for (let i = 0; i < y.length; i++) y[i] = f(x[i])
    x = y
  }
  x = gaussian(x, p.cols, p.rows, adjustSmoothPx(a, pitchMm))
  if (a.edgeSmoothMm > 0 && a.edgeRange > 0) x = bilateral(x, p.cols, p.rows, a.edgeSmoothMm / Math.max(pitchMm, 1e-9), a.edgeRange)
  return x
}

/** Stage 1's Auto parameters or stage 2's adjustment values: the adjusted picture either way. */
export function adjustAny(p: Picture, params: AutoParams | PictureAdjust, pitchMm: number): Float32Array {
  return 'channel' in params ? applyAdjust(p, params, pitchMm) : adjustPicture(p, params, pitchMm)
}

/** A histogram of grey values 0..1 into `bins` bins (the levels control draws it). */
export function histogram(a: Float32Array, bins = 128): Uint32Array {
  const h = new Uint32Array(bins)
  for (let i = 0; i < a.length; i++) h[Math.min(bins - 1, Math.max(0, Math.floor(a[i] * bins)))]++
  return h
}
