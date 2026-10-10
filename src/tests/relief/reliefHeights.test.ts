// WO-2171 - image relief stage 1b: the height math on small known grids and
// the standard's numbers on its fixtures (docs/design/RELIEF-WHAT-GOOD-LOOKS-LIKE.md
// S1-S8). The fixtures are PNGs decoded by the product's own decoder
// (src/relief/picture.ts), so 16-bit stays 16-bit exactly as in the app.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodePng, distinctLevels, type Picture } from '../../relief/picture'
import { adjustPicture, autoParams, classifyPicture, describeAuto, gaussian, levels, median3, percentiles } from '../../relief/adjust'
import {
  bicubicAt, defaultDepth, defaultSettings, faceFrameFromPoints, fitToFace, heightOfValue, poleCount, previewHeightsFromPoles,
  reliefFrame, reliefStats, reliefSurface, sampleReliefGrid, statusLine, uprightAxes, type ReliefSettings,
} from '../../relief/reliefHeights'
import { poleSurfaceHeight } from '../../relief/reliefStep'
import { bytesToDataUrl, dataUrlToBytes, isReliefFeaturePayload, reliefKernelFields } from '../../relief/reliefFeature'

const FIXTURES = path.resolve(__dirname, '../../../docs/design/relief-references/fixtures')
const load = (name: string): Picture => {
  const p = decodePng(new Uint8Array(fs.readFileSync(path.join(FIXTURES, name))))
  if (p === null) throw new Error(`could not decode ${name}`)
  return p
}

const SETTINGS: ReliefSettings = {
  widthMm: 10, heightMm: 10, keepProportions: true, rotationDeg: 0, offsetXMm: 0, offsetYMm: 0,
  depthMm: 2, direction: 'raise', invert: false, zeroPlane: 0, baseMm: 0, auto: true,
}

/** Slope angles (deg) of a height field in mm at a pitch, by central differences (numpy.gradient inside). */
function slopes(h: Float32Array, cols: number, rows: number, pitch: number): Float32Array {
  const out = new Float32Array((cols - 2) * (rows - 2))
  let k = 0
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const gx = (h[r * cols + c + 1] - h[r * cols + c - 1]) / (2 * pitch)
      const gy = (h[(r + 1) * cols + c] - h[(r - 1) * cols + c]) / (2 * pitch)
      out[k++] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI
    }
  }
  return out
}

describe('WO-2171 relief height math on small grids', () => {
  it('S1: a 1200 x 1200 picture on a 100 x 70 face fits inside with a 5 % margin: 63 x 63 mm, centred', () => {
    expect(fitToFace(1200, 1200, 100, 70)).toEqual({ widthMm: 63, heightMm: 63 })
    // the margin is at least 1 mm on a small face: 10 x 10 -> 8 x 8
    expect(fitToFace(100, 100, 10, 10)).toEqual({ widthMm: 8, heightMm: 8 })
    // proportions kept on a wide picture: 1600 x 800 on 100 x 70 -> 90 x 45
    expect(fitToFace(1600, 800, 100, 70)).toEqual({ widthMm: 90, heightMm: 45 })
  })

  it('S2: depth = 4 % of the shorter placed side, clamped 0.5-10 mm, rounded to 0.25 mm', () => {
    expect(defaultDepth(63, 63)).toBe(2.5)
    expect(defaultDepth(100, 50)).toBe(2)
    expect(defaultDepth(30, 30)).toBe(1.25)
    expect(defaultDepth(5, 5)).toBe(0.5)
    expect(defaultDepth(600, 400)).toBe(10)
    expect(defaultDepth(20, 20)).toBe(0.8)
  })

  it('defaults on open: fit, 4 % depth, Raise, zero plane and base 0, centred, unturned', () => {
    const face = faceFrameFromPoints({ x: 0, y: 0, z: 1 }, [0, 0, 15, 100, 0, 15, 100, 70, 15, 0, 70, 15])
    expect(face.widthMm).toBeCloseTo(100)
    expect(face.heightMm).toBeCloseTo(70)
    expect(face.centre).toEqual({ x: 50, y: 35, z: 15 })
    const pic: Picture = { cols: 1200, rows: 1200, grey: new Float32Array(1200 * 1200), bitDepth: 8 }
    const s = defaultSettings(pic, face, null)
    expect(s).toMatchObject({ widthMm: 63, heightMm: 63, depthMm: 2.5, direction: 'raise', invert: false, zeroPlane: 0, baseMm: 0, rotationDeg: 0, offsetXMm: 0, offsetYMm: 0 })
    const fr = reliefFrame(face, s)
    expect(fr.origin.x).toBeCloseTo(18.5)
    expect(fr.origin.y).toBeCloseTo(3.5)
    expect(fr.origin.z).toBeCloseTo(15)
  })

  it('the upright frame: top face X right / Y up; a front face reads upright (Y up = +Z); xDir x yDir = normal', () => {
    const top = uprightAxes({ x: 0, y: 0, z: 1 })
    expect(top.xDir).toEqual({ x: 1, y: 0, z: 0 })
    expect(top.yDir).toEqual({ x: 0, y: 1, z: 0 })
    const front = uprightAxes({ x: 0, y: -1, z: 0 })
    expect(front.yDir.z).toBeCloseTo(1)
    expect(front.xDir.x).toBeCloseTo(1)
    for (const a of [top, front, uprightAxes({ x: 0.6, y: 0, z: 0.8 }), uprightAxes({ x: 1, y: 1, z: 0 })]) {
      const c = { x: a.xDir.y * a.yDir.z - a.xDir.z * a.yDir.y, y: a.xDir.z * a.yDir.x - a.xDir.x * a.yDir.z, z: a.xDir.x * a.yDir.y - a.xDir.y * a.yDir.x }
      expect(c.x).toBeCloseTo(a.normal.x)
      expect(c.y).toBeCloseTo(a.normal.y)
      expect(c.z).toBeCloseTo(a.normal.z)
    }
  })

  it('rotate and move turn and shift the rectangle on the face', () => {
    const face = faceFrameFromPoints({ x: 0, y: 0, z: 1 }, [0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0])
    const fr = reliefFrame(face, { ...SETTINGS, widthMm: 20, heightMm: 10, rotationDeg: 90, offsetXMm: 5, offsetYMm: -3 })
    expect(fr.xDir.x).toBeCloseTo(0)
    expect(fr.xDir.y).toBeCloseTo(1)
    expect(fr.yDir.x).toBeCloseTo(-1)
    // centre (55, 47) -> low corner = centre - 10 xDir - 5 yDir
    expect(fr.origin.x).toBeCloseTo(60)
    expect(fr.origin.y).toBeCloseTo(37)
  })

  it('height of a value: depth, zero plane, invert, base, Raise / Cut in', () => {
    const h = heightOfValue(SETTINGS)
    expect(h(0)).toBe(0)
    expect(h(1)).toBe(2)
    expect(h(0.5)).toBe(1)
    const zp = heightOfValue({ ...SETTINGS, zeroPlane: 0.5 })
    expect(zp(0.25)).toBe(0) // darker than the zero plane sits on the face
    expect(zp(0.75)).toBeCloseTo(1) // the rest is stretched over the full depth
    expect(zp(1)).toBeCloseTo(2)
    const inv = heightOfValue({ ...SETTINGS, invert: true })
    expect(inv(0)).toBe(2)
    expect(inv(1)).toBe(0)
    const base = heightOfValue({ ...SETTINGS, baseMm: 0.5 })
    expect(base(0)).toBe(0.5)
    expect(base(1)).toBe(2.5)
    const cut = heightOfValue({ ...SETTINGS, direction: 'cut' })
    expect(cut(1)).toBe(-2)
    expect(cut(0)).toBe(-0)
  })

  it('a known 2 x 2 picture onto a grid: upright (top row of the picture at high Y), light = high', () => {
    // top row white, bottom row black
    const adjusted = Float32Array.from([1, 1, 0, 0])
    const g = sampleReliefGrid(adjusted, 2, 2, SETTINGS, 5, 5)
    expect(g.heights[0]).toBeCloseTo(0) // row 0 = low Y = bottom of the picture = black
    expect(g.heights[4 * 5]).toBeCloseTo(2) // last row = top of the picture = white
    expect(g.heights[2 * 5 + 2]).toBeCloseTo(1) // the middle
  })

  it('S5: a small picture is resampled bicubic, never in flat blocks', () => {
    // a 3 x 1 ramp: nearest would give 3 flat steps; bicubic passes through every pixel centre and ramps between
    const a = Float32Array.from([0, 0.5, 1])
    const between = bicubicAt(a, 3, 1, 1.0, 0.5) // halfway between pixel 0 and 1 centres
    expect(between).toBeGreaterThan(0.2)
    expect(between).toBeLessThan(0.3)
    expect(bicubicAt(a, 3, 1, 1.5, 0.5)).toBeCloseTo(0.5)
    // a 300 x 300 logo on a 100 mm face: grid 1001 samples; consecutive samples inside one picture pixel differ (no 0.33 mm squares)
    const n = 300
    const logo = new Float32Array(n * n)
    for (let i = 0; i < logo.length; i++) logo[i] = ((i % n) / n + Math.floor(i / n) / n) / 2
    const g = sampleReliefGrid(logo, n, n, { ...SETTINGS, widthMm: 100, heightMm: 100 }, 1001, 1001)
    let flat = 0
    for (let c = 500; c < 520; c++) if (g.heights[500 * 1001 + c + 1] === g.heights[500 * 1001 + c]) flat++
    expect(flat).toBe(0)
  })

  it('poles: the exact face never gets more than 256 control points per side; a small relief gets its working grid', () => {
    expect(poleCount({ cols: 631, rows: 631 })).toBe(256)
    expect(poleCount({ cols: 201, rows: 101 })).toBe(201)
    expect(poleCount({ cols: 2, rows: 2 })).toBe(4)
  })

  it('S10 by construction: the settled preview IS the applied surface (the pole surface) at its vertices', () => {
    const adjusted = new Float32Array(64 * 64)
    for (let r = 0; r < 64; r++) for (let c = 0; c < 64; c++) adjusted[r * 64 + c] = 0.5 + 0.5 * Math.sin(c / 5) * Math.cos(r / 7)
    const pic: Picture = { cols: 64, rows: 64, grey: adjusted, bitDepth: 8 }
    const s = { ...SETTINGS, widthMm: 20, heightMm: 20 }
    const { grid, poles } = reliefSurface(adjusted, pic, s)
    const n = 64
    const prev = previewHeightsFromPoles(poles, n)
    for (const [r, c] of [[0, 0], [10, 20], [32, 32], [63, 5], [64, 64]]) {
      expect(prev[r * (n + 1) + c]).toBeCloseTo(poleSurfaceHeight(poles, (c / n) * 20, (r / n) * 20), 6)
    }
    const st = reliefStats(grid, poles)
    expect(st.gridCols).toBe(201)
    expect(st.poles).toBe(201)
    expect(st.peakMm).toBeLessThanOrEqual(2 + 1e-9)
    expect(st.steepestDeg).toBeGreaterThan(0)
    expect(statusLine(st, 'raise')).toMatch(/^20\.0 x 20\.0 mm, highest [\d.]+ mm, steepest wall \d+ deg, grid 201 x 201 @ 0\.10 mm; exact face 201 x 201 control points$/)
  })

  it('the payload round-trips the picture bytes through its data URL and names what it holds', () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255, 7])
    const url = bytesToDataUrl(bytes, 'image/png')
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    const back = dataUrlToBytes(url)
    expect(back.mime).toBe('image/png')
    expect(Array.from(back.bytes)).toEqual(Array.from(bytes))
    expect(isReliefFeaturePayload({ opType: 'relief' })).toBe(false)
  })

  it('filters match scipy on a tiny case: median 3 x 3 removes a speck; gaussian keeps the sum; levels stretch min -> 0, max -> 1', () => {
    const a = new Float32Array(25).fill(0.2)
    a[12] = 1
    expect(median3(a, 5, 5)[12]).toBeCloseTo(0.2)
    const g = gaussian(a, 5, 5, 1)
    expect(g.reduce((x, y) => x + y, 0)).toBeCloseTo(a.reduce((x, y) => x + y, 0), 4)
    const l = levels(Float32Array.from([0.25, 0.5, 0.75]), 0)
    expect(Array.from(l)).toEqual([0, 0.5, 1])
    expect(percentiles(Float32Array.from([0, 1, 2, 3, 4]), [0.5, 0.25])).toEqual([2, 1])
  })
})

describe('WO-2171 relief standard on the fixtures (RELIEF-WHAT-GOOD-LOOKS-LIKE.md S3-S7)', () => {
  it('Auto classifies the four PNG fixtures as the prototype did (terrain, text inverted, hammered, dome)', () => {
    expect(classifyPicture(load('fixture-02-terrain-heightmap.png'))).toBe('heightmap')
    const text = autoParams(load('fixture-03-text-sign.png'))
    expect(text.kind).toBe('artwork')
    expect(text.invert).toBe(true)
    expect(text.smoothMm).toBe(0.15)
    expect(autoParams(load('fixture-04-hammered-texture-16bit.png'))).toMatchObject({ kind: 'heightmap', smoothPx: 0.5 })
    expect(autoParams(load('fixture-05b-dome-rings-8bit.png'))).toMatchObject({ kind: 'heightmap', smoothPx: 2, invert: false })
    expect(describeAuto(text, 0.0625)).toBe('Auto: artwork, inverted, background -> face, smooth 0.15 mm')
  })

  it('S3: the 8-bit dome at 100 mm, 3 mm deep, with defaults stays within 1 deg of the 16-bit truth (99th percentile)', () => {
    const d8 = load('fixture-05b-dome-rings-8bit.png')
    const d16 = load('fixture-05-dome-rings-16bit.png')
    expect(d8.bitDepth).toBe(8)
    expect(d16.bitDepth).toBe(16)
    const pitch = 100 / d8.cols
    const a8 = adjustPicture(d8, autoParams(d8), pitch)
    const truth = levels(d16.grey, 0)
    const raw8 = levels(d8.grey, 0)
    const s8 = slopes(a8.map((v) => v * 3), d8.cols, d8.rows, pitch)
    const sTruth = slopes(truth.map((v) => v * 3), d16.cols, d16.rows, pitch)
    const sRaw = slopes(raw8.map((v) => v * 3), d8.cols, d8.rows, pitch)
    const err = (s: Float32Array) => percentiles(s.map((v, i) => Math.abs(v - sTruth[i])), [0.99])[0]
    const withDefaults = err(s8)
    const noSmooth = err(sRaw)
    console.log(`S3: 8-bit dome slope error p99 ${withDefaults.toFixed(2)} deg with the 2 px default (no smooth: ${noSmooth.toFixed(2)} deg)`)
    expect(withDefaults).toBeLessThan(1)
    expect(noSmooth).toBeGreaterThan(1) // the terraces are real without the smooth
  })

  it('S4: the 16-bit dome keeps at least 30,000 distinct height levels after the whole chain', () => {
    const d16 = load('fixture-05-dome-rings-16bit.png')
    const s: ReliefSettings = { ...SETTINGS, widthMm: 60, heightMm: 60, depthMm: 2.5 }
    const adjusted = adjustPicture(d16, autoParams(d16), 60 / d16.cols)
    const grid = sampleReliefGrid(adjusted, d16.cols, d16.rows, s, d16.cols, d16.rows)
    const n = distinctLevels(grid.heights)
    console.log(`S4: 16-bit dome, ${n} distinct height levels after the chain`)
    expect(n).toBeGreaterThanOrEqual(30000)
  })

  it('S6: the text sign with Auto: letters rise, the background lands exactly on the face, letter tops flat at full depth', () => {
    const text = load('fixture-03-text-sign.png')
    const auto = autoParams(text)
    const face = faceFrameFromPoints({ x: 0, y: 0, z: 1 }, [0, 0, 0, 111.2, 0, 0, 111.2, 55.6, 0, 0, 55.6, 0])
    const s = defaultSettings(text, face, auto)
    expect(s.widthMm).toBeCloseTo(100, 0)
    expect(s.heightMm).toBeCloseTo(50, 0)
    expect(s.depthMm).toBe(2)
    expect(s.invert).toBe(true)
    const adjusted = adjustPicture(text, auto, s.widthMm / text.cols)
    const grid = sampleReliefGrid(adjusted, text.cols, text.rows, s, 1001, 501)
    // background: 8 mm in, between the border frame (2.5-4 mm) and the lettering
    const bg = grid.heights[250 * 1001 + 80]
    expect(bg).toBe(0)
    let zeros = 0, full = 0
    for (const h of grid.heights) { if (h === 0) zeros++; if (h > 1.99) full++ }
    console.log(`S6: text sign, ${(100 * zeros / grid.heights.length).toFixed(1)} % of samples exactly on the face, ${(100 * full / grid.heights.length).toFixed(1)} % at full depth`)
    expect(zeros / grid.heights.length).toBeGreaterThan(0.5)
    expect(full / grid.heights.length).toBeGreaterThan(0.05)
  })

  it('S7: Auto never flattens a true height map: no more than 0.01 % of the terrain sits at the top height', () => {
    const t = load('fixture-02-terrain-heightmap.png')
    const auto = autoParams(t)
    expect(auto.clip).toBe(0)
    const a = adjustPicture(t, auto, 100 / t.cols)
    let max = 0
    for (const v of a) max = Math.max(max, v)
    let top = 0
    for (const v of a) if (v >= max - 1e-6) top++
    const share = (100 * top) / a.length
    console.log(`S7: terrain, ${share.toFixed(4)} % of samples at the top height`)
    expect(share).toBeLessThanOrEqual(0.01)
  })

  it('the kernel fields of a payload: frame on the face, poles from the same chain as the palette', () => {
    const d16 = load('fixture-05-dome-rings-16bit.png')
    const auto = autoParams(d16)
    const face = faceFrameFromPoints({ x: 0, y: 0, z: 1 }, [0, 0, 10, 100, 0, 10, 100, 70, 10, 0, 70, 10])
    const settings = defaultSettings(d16, face, auto)
    const f = reliefKernelFields(d16, { face, settings, autoParams: auto })
    expect(f.poles.n).toBe(256)
    expect(f.frame.origin.z).toBeCloseTo(10)
    let peak = 0
    for (const h of f.poles.heights) peak = Math.max(peak, h)
    expect(peak).toBeLessThanOrEqual(settings.depthMm + 1e-9)
    expect(peak).toBeGreaterThan(0.9 * settings.depthMm)
  })
})
