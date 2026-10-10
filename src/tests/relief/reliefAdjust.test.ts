// WO-2174 - image relief stage 2: each picture adjustment against a plain CPU
// reference written here from its definition (docs/design/RELIEF-WHAT-GOOD-
// LOOKS-LIKE.md section 2), on small pictures; the standard's defaults; and
// stage 1's Auto unchanged when it is expressed as adjustment values.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { decodePng, luma, type Picture } from '../../relief/picture'
import {
  adjustPicture, applyAdjust, autoAdjust, autoParams, bilateral, bilateralExact, BILATERAL_GRID_FROM_PX, greyOf, histogram, MANUAL_ADJUST,
  MANUAL_PICTURE_ADJUST, medianFilter, toneCurve, type AutoParams, type PictureAdjust,
} from '../../relief/adjust'
import { adjustedFor, defaultSettings, type ReliefSettings } from '../../relief/reliefHeights'

const FIXTURES = path.resolve(__dirname, '../../../docs/design/relief-references/fixtures')
const load = (name: string): Picture => {
  const p = decodePng(new Uint8Array(fs.readFileSync(path.join(FIXTURES, name))))
  if (p === null) throw new Error(`could not decode ${name}`)
  return p
}

/** A repeatable pseudo-random picture, values 0..1. */
function noise(cols: number, rows: number, seed = 7): Float32Array {
  let s = seed
  const a = new Float32Array(cols * rows)
  for (let i = 0; i < a.length; i++) { s = (s * 1103515245 + 12345) % 2147483648; a[i] = s / 2147483648 }
  return a
}

/** scipy 'reflect' (d c b a | a b c d | d c b a). */
function reflect(i: number, n: number): number {
  const period = 2 * n
  let k = ((i % period) + period) % period
  if (k >= n) k = period - 1 - k
  return k
}

/** Reference median: sort every (2r+1)^2 window. */
function refMedian(a: Float32Array, cols: number, rows: number, r: number): Float32Array {
  const out = new Float32Array(a.length)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const w: number[] = []
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) w.push(a[reflect(y + j, rows) * cols + reflect(x + i, cols)])
      w.sort((p, q) => p - q)
      out[y * cols + x] = w[w.length >> 1]
    }
  }
  return out
}

/** Reference Gaussian: the full 2D sum, cut at 4 sigma, edges reflect. */
function refGaussian(a: Float32Array, cols: number, rows: number, sigma: number): Float32Array {
  const rad = Math.max(1, Math.round(4 * sigma))
  const out = new Float32Array(a.length)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let s = 0, w = 0
      for (let j = -rad; j <= rad; j++) {
        for (let i = -rad; i <= rad; i++) {
          const k = Math.exp(-(i * i) / (2 * sigma * sigma)) * Math.exp(-(j * j) / (2 * sigma * sigma))
          s += k * a[reflect(y + j, rows) * cols + reflect(x + i, cols)]
          w += k
        }
      }
      out[y * cols + x] = s / w
    }
  }
  return out
}

/** Reference bilateral: every neighbour inside the picture within 2 sigma, weighted by distance and by grey difference. */
function refBilateral(a: Float32Array, cols: number, rows: number, sigma: number, range: number): Float32Array {
  const rad = Math.max(1, Math.ceil(2 * sigma))
  const out = new Float32Array(a.length)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = a[y * cols + x]
      let s = 0, w = 0
      for (let j = -rad; j <= rad; j++) {
        for (let i = -rad; i <= rad; i++) {
          if (x + i < 0 || x + i >= cols || y + j < 0 || y + j >= rows) continue
          const q = a[(y + j) * cols + x + i]
          const k = Math.exp(-(i * i + j * j) / (2 * sigma * sigma) - ((q - v) * (q - v)) / (2 * range * range))
          s += k * q
          w += k
        }
      }
      out[y * cols + x] = s / w
    }
  }
  return out
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

function std(a: number[]): number {
  const mean = a.reduce((s, v) => s + v, 0) / a.length
  return Math.sqrt(a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / a.length)
}

/** A PNG file of RGB(A) 8-bit pixels (filter 0 on every line). */
function pngOf(cols: number, rows: number, px: number[][], alpha: boolean): Uint8Array {
  const ch = alpha ? 4 : 3
  const raw = new Uint8Array(rows * (cols * ch + 1))
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) for (let c = 0; c < ch; c++) raw[y * (cols * ch + 1) + 1 + x * ch + c] = px[y * cols + x][c]
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const chunk = (type: string, data: Uint8Array): number[] => {
    const body = [...type].map((c) => c.charCodeAt(0)).concat([...data])
    let crc = 0xffffffff
    for (const b of body) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8)
    crc = (crc ^ 0xffffffff) >>> 0
    const len = data.length
    return [len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]
  }
  const ihdr = new Uint8Array([0, 0, 0, cols, 0, 0, 0, rows, 8, alpha ? 6 : 2, 0, 0, 0])
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...chunk('IDAT', zlibSync(raw)), ...chunk('IEND', new Uint8Array(0))])
}

const ADJ = (patch: Partial<PictureAdjust>): PictureAdjust => ({ ...MANUAL_PICTURE_ADJUST, smoothMm: 0, ...patch })

describe('WO-2174 greyscale channel', () => {
  // a red rose on green leaves: luma cannot tell them apart well, the red channel can
  const px = [[220, 30, 40], [40, 160, 50], [255, 255, 255], [0, 0, 0], [10, 20, 250], [128, 64, 32]]
  const pic = decodePng(pngOf(3, 2, px, false))!

  it('a colour PNG keeps its channels; luma is Rec. 709 of them', () => {
    expect(pic.rgb).toBeDefined()
    px.forEach(([r, g, b], i) => {
      expect(greyOf(pic, 'red')[i]).toBeCloseTo(r / 255, 6)
      expect(greyOf(pic, 'green')[i]).toBeCloseTo(g / 255, 6)
      expect(greyOf(pic, 'blue')[i]).toBeCloseTo(b / 255, 6)
      expect(greyOf(pic, 'luma')[i]).toBeCloseTo(0.2126 * r / 255 + 0.7152 * g / 255 + 0.0722 * b / 255, 6)
      expect(greyOf(pic, 'max')[i]).toBeCloseTo(Math.max(r, g, b) / 255, 6)
    })
    for (const ch of ['red', 'green', 'blue', 'max'] as const) expect(Array.from(applyAdjust(pic, ADJ({ channel: ch }), 1))).toEqual(Array.from(greyOf(pic, ch)))
    // 16 bits a channel, interleaved: 6 bytes a pixel beside grey's 4
    expect(pic.rgb).toBeInstanceOf(Uint16Array)
    expect(pic.rgb!.length).toBe(3 * pic.grey.length)
  })

  it('transparent pixels lie over white in every channel, as in grey', () => {
    const t = decodePng(pngOf(2, 1, [[255, 0, 0, 0], [255, 0, 0, 128]], true))!
    const [r, g, b] = (['red', 'green', 'blue'] as const).map((c) => greyOf(t, c))
    expect(g[0]).toBeCloseTo(1, 4)
    expect(g[1]).toBeCloseTo(1 - 128 / 255, 4)
    expect(t.grey[1]).toBeCloseTo(luma(r[1], g[1], b[1]), 4)
  })

  it('a grey picture has no channels; every channel reads its grey', () => {
    const g = load('fixture-05b-dome-rings-8bit.png')
    expect(g.rgb).toBeUndefined()
    expect(greyOf(g, 'red')).toBe(g.grey)
  })
})

describe('WO-2174 levels, midtones, contrast, brightness', () => {
  it('match the definitions: black / white stretch, gamma on the midtones, contrast about mid-grey, brightness a lift', () => {
    const levels = toneCurve({ black: 0.2, white: 0.6, midtones: 1, contrast: 0, brightness: 0 })
    expect(levels(0.1)).toBe(0)
    expect(levels(0.4)).toBeCloseTo(0.5, 9)
    expect(levels(0.7)).toBe(1)
    // gamma 2 fattens the middle: 0.5 -> 0.5^(1/2)
    expect(toneCurve({ black: 0.2, white: 0.6, midtones: 2, contrast: 0, brightness: 0 })(0.4)).toBeCloseTo(Math.SQRT1_2, 9)
    expect(toneCurve({ black: 0, white: 1, midtones: 0.5, contrast: 0, brightness: 0 })(0.5)).toBeCloseTo(0.25, 9)
    // contrast +50: slope tan(67.5 deg) about mid-grey
    expect(toneCurve({ black: 0, white: 1, midtones: 1, contrast: 50, brightness: 0 })(0.6)).toBeCloseTo(0.5 + 0.1 * Math.tan((67.5 * Math.PI) / 180), 9)
    expect(toneCurve({ black: 0, white: 1, midtones: 1, contrast: -100, brightness: 0 })(0.9)).toBeCloseTo(0.5, 9)
    expect(toneCurve({ black: 0, white: 1, midtones: 1, contrast: 0, brightness: 20 })(0.3)).toBeCloseTo(0.5, 9)
    expect(toneCurve({ black: 0, white: 1, midtones: 1, contrast: 0, brightness: 20 })(0.9)).toBe(1)
  })

  it('applyAdjust runs the curve on every pixel (a CPU reference per pixel)', () => {
    const cols = 17, rows = 11
    const pic: Picture = { cols, rows, grey: noise(cols, rows), bitDepth: 8 }
    const a = ADJ({ black: 0.1, white: 0.8, midtones: 1.4, contrast: 25, brightness: -10 })
    const out = applyAdjust(pic, a, 1)
    for (let i = 0; i < out.length; i++) {
      let t = Math.min(Math.max((pic.grey[i] - 0.1) / 0.7, 0), 1) ** (1 / 1.4)
      t = Math.min(Math.max((t - 0.5) * Math.tan(((0.25 + 1) * Math.PI) / 4) + 0.5 - 0.1, 0), 1)
      expect(out[i]).toBeCloseTo(t, 6)
    }
  })

  it('the histogram counts every pixel into its bin', () => {
    const h = histogram(Float32Array.from([0, 0.1, 0.5, 0.99, 1]), 10)
    expect(Array.from(h)).toEqual([1, 1, 0, 0, 0, 1, 0, 0, 0, 2])
  })
})

describe('WO-2174 denoise (median)', () => {
  it.each([1, 2, 3])('radius %i equals sorting every window (edges reflect)', (r) => {
    const cols = 23, rows = 19
    const a = noise(cols, rows, 11 + r)
    expect(maxDiff(medianFilter(a, cols, rows, r), refMedian(a, cols, rows, r))).toBe(0)
  })

  it('removes a speckle and keeps an edge', () => {
    const cols = 20, rows = 20
    const a = new Float32Array(cols * rows)
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) a[y * cols + x] = x < 10 ? 0 : 1
    a[5 * cols + 4] = 1 // a white speckle on the black side
    const out = applyAdjust({ cols, rows, grey: a, bitDepth: 8 }, ADJ({ denoisePx: 2 }), 1)
    expect(out[5 * cols + 4]).toBe(0)
    for (let y = 0; y < rows; y++) { expect(out[y * cols + 9]).toBe(0); expect(out[y * cols + 10]).toBe(1) }
  })
})

describe('WO-2174 smooth (Gaussian)', () => {
  it('the separable filter equals the full 2D sum; sigma is set in mm on the part', () => {
    const cols = 31, rows = 24
    const pic: Picture = { cols, rows, grey: noise(cols, rows, 3), bitDepth: 8 }
    // 0.3 mm at 0.2 mm per pixel = 1.5 px
    const out = applyAdjust(pic, ADJ({ smoothMm: 0.3 }), 0.2)
    expect(maxDiff(out, refGaussian(pic.grey, cols, rows, 1.5))).toBeLessThan(1e-5)
    // Auto's height-map sigma is in px, whatever the placement
    expect(maxDiff(applyAdjust(pic, ADJ({ smoothMm: 0.3, smoothPx: 2 }), 0.2), refGaussian(pic.grey, cols, rows, 2))).toBeLessThan(1e-5)
  })
})

describe('WO-2174 edge-keeping smooth (bilateral)', () => {
  /** a noisy step: 0.3 | 0.7 with +-0.03 grain */
  function noisyStep(cols: number, rows: number): Float32Array {
    const n = noise(cols, rows, 5)
    const a = new Float32Array(cols * rows)
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) a[y * cols + x] = (x < cols / 2 ? 0.3 : 0.7) + (n[y * cols + x] - 0.5) * 0.06
    return a
  }

  it('small radius: equals the reference sum exactly', () => {
    const cols = 24, rows = 18
    const a = noisyStep(cols, rows)
    expect(maxDiff(bilateralExact(a, cols, rows, 1.5, 0.1), refBilateral(a, cols, rows, 1.5, 0.1))).toBeLessThan(1e-5)
    expect(maxDiff(bilateral(a, cols, rows, 1.5, 0.1), refBilateral(a, cols, rows, 1.5, 0.1))).toBeLessThan(1e-5)
  })

  it('big radius (the bilateral grid): close to the reference, grain gone, the edge kept', () => {
    const cols = 64, rows = 48
    const a = noisyStep(cols, rows)
    const sigma = BILATERAL_GRID_FROM_PX + 1
    const fast = bilateral(a, cols, rows, sigma, 0.1)
    const ref = refBilateral(a, cols, rows, sigma, 0.1)
    let sum = 0
    for (let i = 0; i < a.length; i++) sum += Math.abs(fast[i] - ref[i])
    const mean = sum / a.length
    console.log(`WO-2174 bilateral grid vs reference: mean |diff| ${mean.toFixed(4)}, max ${maxDiff(fast, ref).toFixed(4)}`)
    expect(mean).toBeLessThan(0.01)
    const left = (img: Float32Array) => Array.from({ length: rows - 8 }, (_, k) => img[(k + 4) * cols + 10])
    expect(std(left(fast))).toBeLessThan(0.5 * std(left(a)))
    // the step stays a step: the two pixels either side of it still differ by nearly the full 0.4
    for (let y = 4; y < rows - 4; y++) expect(fast[y * cols + cols / 2] - fast[y * cols + cols / 2 - 1]).toBeGreaterThan(0.33)
  })

  it('set in mm on the part; off by default', () => {
    const cols = 24, rows = 18
    const pic: Picture = { cols, rows, grey: noisyStep(cols, rows), bitDepth: 8 }
    expect(maxDiff(applyAdjust(pic, ADJ({ edgeSmoothMm: 0.3, edgeRange: 0.1 }), 0.2), refBilateral(pic.grey, cols, rows, 1.5, 0.1))).toBeLessThan(1e-5)
    expect(MANUAL_PICTURE_ADJUST.edgeSmoothMm).toBe(0)
  })
})

describe('WO-2174 the standard defaults and Auto', () => {
  it('manual defaults are section 2 DEFAULT column', () => {
    expect(MANUAL_PICTURE_ADJUST).toEqual({
      channel: 'luma', black: 0, white: 1, midtones: 1, contrast: 0, brightness: 0, denoisePx: 0, smoothMm: 0.1, edgeSmoothMm: 0, edgeRange: 0.1,
    })
    // and they filter exactly as stage 1's manual adjustment did
    const p = load('fixture-05b-dome-rings-8bit.png')
    expect(maxDiff(applyAdjust(p, MANUAL_PICTURE_ADJUST, 0.05), adjustPicture(p, MANUAL_ADJUST, 0.05))).toBeLessThan(1e-6)
  })

  const PHOTO: AutoParams = { kind: 'photo', invert: false, clip: 0.005, median: true, smoothMm: 0.2, zeroPlane: 0 }
  it.each([
    ['fixture-03-text-sign.png', null],
    ['fixture-05b-dome-rings-8bit.png', null],
    ['fixture-02-terrain-heightmap.png', null],
    ['fixture-02-terrain-heightmap.png', PHOTO],
  ] as const)('%s: Auto as adjustment values filters exactly as stage 1 Auto (%s)', (name, forced) => {
    const p = load(name)
    const auto = forced ?? autoParams(p)
    const a = autoAdjust(p, auto)
    // Auto never bends midtones or touches contrast / brightness (section 4)
    expect(a).toMatchObject({ channel: 'luma', midtones: 1, contrast: 0, brightness: 0, edgeSmoothMm: 0, denoisePx: auto.median ? 1 : 0 })
    const pitch = 90 / p.cols
    expect(maxDiff(applyAdjust(p, a, pitch), adjustPicture(p, auto, pitch))).toBeLessThan(1e-5)
    // and through the settings the app saves
    const face = { centre: { x: 0, y: 0, z: 0 }, xDir: { x: 1, y: 0, z: 0 }, yDir: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 }, widthMm: 100, heightMm: 100 }
    const s: ReliefSettings = defaultSettings(p, face, auto)
    expect(maxDiff(adjustedFor(p, auto, MANUAL_ADJUST, { ...s, adjust: a }), adjustedFor(p, auto, MANUAL_ADJUST, s))).toBeLessThan(1e-5)
  })
})
