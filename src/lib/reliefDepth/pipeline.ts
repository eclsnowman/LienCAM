// WO-2173: picture -> depth grid, around any model that maps a normalised RGB tensor to relative depth.
//
// What the research measured (src/tests/evidence/WO-2173/RESEARCH.md): one pass at the model's 518 px
// melts a coin's scales and leaves into mush; a single larger pass (1036 px) recovers them but stripes the
// surface (the model is out of its training size). Native-resolution tiles, each least-squares aligned to
// the whole-picture pass and feathered together, keep the whole-picture FORM and add the tiles' DETAIL with
// neither fault. A small band-pass of the picture's own brightness then adds engraving-fine texture (letters,
// hair lines) the model does not resolve - the makerforums "high-pass layer" trick, measured, opt-down.
import { gaussianBlur, grid, percentiles, resize, resizeInterleaved, type Grid } from './grid'
import type { DepthImage, DepthProgress, DepthTuning } from './types'

/** Runs the model once. `tensor` is [1, 3, h, w] ImageNet-normalised RGB; returns h x w relative depth
 *  (larger = nearer the camera = higher on the relief). */
export type RunModel = (tensor: Float32Array, width: number, height: number) => Promise<Float32Array>

export const DEFAULT_TUNING: DepthTuning = { modelSide: 518, maxWorkingSide: 1536, tileOverlap: 1 / 3 }
export const DEFAULT_FINE_DETAIL = 0.08

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

export interface PipelineRequest {
  image: DepthImage
  detail: 'high' | 'fast'
  fineDetail: number
  tuning: DepthTuning
  onProgress?: (p: DepthProgress) => void
}

export interface PipelineOutput {
  width: number
  height: number
  heights: Uint16Array
  passes: number
  inferenceMs: number
  postMs: number
}

const multipleOf = (v: number, m: number) => Math.max(m, Math.round(v / m) * m)

/** RGBA bytes -> interleaved RGB 0..1 floats. */
function toRgb(image: DepthImage): Float32Array {
  const n = image.width * image.height
  const rgb = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = image.data[i * 4] / 255
    rgb[i * 3 + 1] = image.data[i * 4 + 1] / 255
    rgb[i * 3 + 2] = image.data[i * 4 + 2] / 255
  }
  return rgb
}

function luminance(rgb: Float32Array, w: number, h: number): Grid {
  const g = grid(w, h)
  for (let i = 0; i < w * h; i++) g.data[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]
  return g
}

function crop(rgb: Float32Array, w: number, x0: number, y0: number, cw: number, ch: number): Float32Array {
  const out = new Float32Array(cw * ch * 3)
  for (let y = 0; y < ch; y++) out.set(rgb.subarray(((y0 + y) * w + x0) * 3, ((y0 + y) * w + x0 + cw) * 3), y * cw * 3)
  return out
}

/** Interleaved RGB -> planar, normalised [1,3,h,w] tensor at the model's size (multiples of 14). */
export function toTensor(rgb: Float32Array, w: number, h: number, tw: number, th: number): Float32Array {
  const scaled = resizeInterleaved(rgb, w, h, 3, tw, th)
  const plane = tw * th
  const t = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, scaled[i * 3 + c]))
      t[c * plane + i] = (v - MEAN[c]) / STD[c]
    }
  }
  return t
}

/** The model's input size for a picture region: the short side at `side` (the DPT processor's rule), both
 *  sides multiples of 14, the long side capped at 3 x `side` so a banner cannot run away. */
export function modelSize(w: number, h: number, side: number): [number, number] {
  let s = side / Math.min(w, h)
  if (Math.max(w, h) * s > 3 * side) s = (3 * side) / Math.max(w, h)
  return [multipleOf(w * s, 14), multipleOf(h * s, 14)]
}

/** Tile origins along one axis: `tile` wide, overlapping, the last one flush with the far edge. */
export function tileOrigins(size: number, tile: number, overlap: number): number[] {
  if (size <= tile) return [0]
  const step = Math.max(1, Math.round(tile * (1 - overlap)))
  const out: number[] = []
  for (let p = 0; p + tile < size; p += step) out.push(p)
  out.push(size - tile)
  return out
}

async function pass(run: RunModel, rgb: Float32Array, w: number, h: number, side: number): Promise<Grid> {
  const [tw, th] = modelSize(w, h, side)
  const depth = await run(toTensor(rgb, w, h, tw, th), tw, th)
  return resize(grid(tw, th, depth), w, h)
}

/** Feather weights along one axis of a tile. The model's view goes wrong in its outer rows and columns, and
 *  a tile whose own depth range is small gets scaled up hard by its fit - so even a tiny weight there draws
 *  a line (the first evidence run's dome showed exactly that at every tile edge). The outer `margin`
 *  therefore counts for nothing, unless that side is the picture's own edge, and the weight rises smoothly
 *  across the rest of the overlap. Neighbouring tiles overlap by more than two margins, so every pixel
 *  keeps a positive total weight. */
export function featherWeights(n: number, origin: number, size: number, margin: number, ramp: number): Float32Array {
  const wts = new Float32Array(n)
  const openLo = origin > 0, openHi = origin + n < size
  for (let i = 0; i < n; i++) {
    const d = Math.min(openLo ? i - margin : Infinity, openHi ? n - 1 - i - margin : Infinity)
    wts[i] = d < 0 ? 0 : d >= ramp ? 1 : Math.sin((Math.PI / 2) * ((d + 1) / (ramp + 1))) ** 2
  }
  return wts
}

export async function runPipeline(run: RunModel, req: PipelineRequest): Promise<PipelineOutput> {
  const { image, tuning } = req
  const W = image.width, H = image.height
  if (!(W > 0 && H > 0) || image.data.length < W * H * 4) throw new Error(`reliefDepth: picture must be RGBA, got ${W} x ${H} with ${image.data.length} bytes`)
  const side = tuning.modelSide
  const fullRgb = toRgb(image)

  // Working picture: never upscaled, long side capped.
  const k = Math.min(1, tuning.maxWorkingSide / Math.max(W, H))
  const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k))
  const rgb = k < 1 ? resizeInterleaved(fullRgb, W, H, 3, w, h) : fullRgb

  const tile = side
  const xs = tileOrigins(w, tile, tuning.tileOverlap)
  const ys = tileOrigins(h, tile, tuning.tileOverlap)
  // Tiles only add anything when the working picture is clearly bigger than one model view.
  const tiled = req.detail === 'high' && Math.min(w, h) > tile * 1.2
  const total = 1 + (tiled ? xs.length * ys.length : 0)
  let done = 0, inferenceMs = 0
  const timedRun: RunModel = async (t, tw, th) => {
    const t0 = performance.now()
    const out = await run(t, tw, th)
    inferenceMs += performance.now() - t0
    req.onProgress?.({ stage: 'infer', done: ++done, total })
    return out
  }
  req.onProgress?.({ stage: 'infer', done: 0, total })

  // 1) The whole picture at the model's own size: the overall FORM.
  const base = await pass(timedRun, rgb, w, h, side)
  let work = base

  // 2) Native-resolution tiles for DETAIL, each fitted to the base (a*d + b) and feathered in.
  if (tiled) {
    const acc = new Float32Array(w * h), wsum = new Float32Array(w * h)
    const margin = Math.max(2, Math.round(tile * 0.06))
    const ramp = Math.max(1, tile - Math.round(tile * (1 - tuning.tileOverlap)) - 2 * margin)
    for (const y0 of ys) for (const x0 of xs) {
      const cw = Math.min(tile, w - x0), ch = Math.min(tile, h - y0)
      const d = await pass(timedRun, crop(rgb, w, x0, y0, cw, ch), cw, ch, side)
      const wx = featherWeights(cw, x0, w, margin, ramp), wy = featherWeights(ch, y0, h, margin, ramp)
      // Weighted least squares over the same weights, so the unreliable border does not skew the fit.
      let sw = 0, sd = 0, sr = 0, sdd = 0, sdr = 0
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const wt = wy[y] * wx[x]
        if (wt === 0) continue
        const dv = d.data[y * cw + x], rv = base.data[(y0 + y) * w + x0 + x]
        sw += wt; sd += wt * dv; sr += wt * rv; sdd += wt * dv * dv; sdr += wt * dv * rv
      }
      if (sw === 0) continue
      const varD = sdd - (sd * sd) / sw
      // A featureless tile (flat background) has nothing to fit; it takes the base as it is.
      const a = varD > 1e-9 * sw ? Math.max(0, (sdr - (sd * sr) / sw) / varD) : 0
      const b = (sr - a * sd) / sw
      for (let y = 0; y < ch; y++) {
        if (wy[y] === 0) continue
        for (let x = 0; x < cw; x++) {
          const wt = wy[y] * wx[x]
          if (wt === 0) continue
          const i = (y0 + y) * w + x0 + x
          acc[i] += (a * d.data[y * cw + x] + b) * wt
          wsum[i] += wt
        }
      }
    }
    for (let i = 0; i < acc.length; i++) acc[i] = wsum[i] > 0 ? acc[i] / wsum[i] : base.data[i]
    const merged = grid(w, h, acc)
    // Low frequencies from the whole-picture pass, high frequencies from the tiles.
    const sigma = tile / 8
    const baseLow = gaussianBlur(base, sigma), mergedLow = gaussianBlur(merged, sigma)
    const out = grid(w, h)
    for (let i = 0; i < out.data.length; i++) out.data[i] = baseLow.data[i] + merged.data[i] - mergedLow.data[i]
    work = out
  }

  const t0 = performance.now()
  // 3) Back to the picture's own size, then the brightness band-pass on top.
  let full = w === W && h === H ? work : resize(work, W, H)
  const [lo, hi] = percentiles(full.data, 0.1, 99.9)
  const range = Math.max(hi - lo, 1e-12)
  if (req.fineDetail > 0) {
    const scale = Math.max(1, Math.max(W, H) / 1400)
    const lum = luminance(fullRgb, W, H)
    const fine = gaussianBlur(lum, 0.7 * scale), coarse = gaussianBlur(lum, 3 * scale)
    const withDetail = grid(W, H)
    for (let i = 0; i < withDetail.data.length; i++) withDetail.data[i] = full.data[i] + req.fineDetail * range * (fine.data[i] - coarse.data[i])
    full = withDetail
  }

  // 4) 16-bit, 0.1 / 99.9 percentile stretch so a stray pixel cannot flatten the rest.
  const [qlo, qhi] = percentiles(full.data, 0.1, 99.9)
  const span = Math.max(qhi - qlo, 1e-12)
  const heights = new Uint16Array(W * H)
  for (let i = 0; i < heights.length; i++) heights[i] = Math.round(Math.min(1, Math.max(0, (full.data[i] - qlo) / span)) * 65535)
  return { width: W, height: H, heights, passes: total, inferenceMs, postMs: performance.now() - t0 }
}
