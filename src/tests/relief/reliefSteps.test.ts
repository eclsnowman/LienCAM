// WO-2174 - step-downs (Operator ruling 2026-09-28: "fixed depth step Downs option for
// things like lake topography"): on a known ramp and a known contour picture
// the heights are exactly the floors, the walls stand where the picture's
// contours are, and a chosen wall angle slopes each wall at that angle.
// WO-2229 (Operator 2026-09-29, "level edge at the true outline"): a value stands
// on its NEAREST floor - each wall is the contour halfway between the floors
// on either side of it. At or below the zero plane is on the face.

import { describe, expect, it } from 'vitest'
import type { Picture } from '../../relief/picture'
import {
  DEFAULT_STEPS, heightOfValue, levelsLine, polesFromPicture, reliefDetailGrid, reliefSampler, sampleReliefGrid, stepPlan, type ReliefSettings, type StepDowns,
} from '../../relief/reliefHeights'
import { workingGridSize } from '../../relief/heightGrid'
import { reliefKernelFields } from '../../relief/reliefFeature'
import { autoParams, MANUAL_PICTURE_ADJUST } from '../../relief/adjust'

const BASE: ReliefSettings = {
  widthMm: 100, heightMm: 5, keepProportions: false, rotationDeg: 0, offsetXMm: 0, offsetYMm: 0,
  depthMm: 4, direction: 'raise', invert: false, zeroPlane: 0, baseMm: 0, auto: false,
}
const steps = (patch: Partial<StepDowns>): StepDowns => ({ ...DEFAULT_STEPS, ...patch })

/** A left-to-right ramp, 0 at the left pixel centre to 1 at the right one. */
function ramp(cols = 201, rows = 5): Picture {
  const grey = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) grey[r * cols + c] = c / (cols - 1)
  return { cols, rows, grey, bitDepth: 16 }
}

/** The ramp's value at x mm (pixel centres at i + 0.5; the bicubic reproduces a straight ramp exactly away from the ends). */
const rampT = (p: Picture, s: ReliefSettings, xMm: number) => ((xMm / s.widthMm) * p.cols - 0.5) / (p.cols - 1)
/** Where the ramp reaches value t, mm. */
const rampX = (p: Picture, s: ReliefSettings, t: number) => ((t * (p.cols - 1) + 0.5) / p.cols) * s.widthMm

const sorted = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b)

describe('WO-2174 step plans', () => {
  it('N levels: equal floors, the deepest at full depth, each edge halfway between two floors', () => {
    expect(stepPlan({ depthMm: 4, steps: steps({ mode: 'levels', levels: 4 }) })).toEqual({ thresholds: [0.125, 0.375, 0.625, 0.875], floorsMm: [0, 1, 2, 3, 4] })
    expect(stepPlan({ depthMm: 4, steps: steps({ mode: 'off' }) })).toBeNull()
    expect(stepPlan({ depthMm: 4, steps: undefined })).toBeNull()
  })

  it('fixed step: floor k is k steps deep and takes everything deeper than k - 0.5 steps; the deepest is the depth', () => {
    const plan = stepPlan({ depthMm: 9, steps: steps({ mode: 'step', stepMm: 3 }) })!
    expect(plan.floorsMm).toEqual([0, 3, 6, 9])
    plan.thresholds.forEach((t, i) => expect(t * 9).toBeCloseTo([1.5, 4.5, 7.5][i], 9))
    // 10 mm in 3 mm steps: 3, 6, 9 and the last part-step to 10, its edge halfway to it (9.5)
    const part = stepPlan({ depthMm: 10, steps: steps({ mode: 'step', stepMm: 3 }) })!
    expect(part.floorsMm).toEqual([0, 3, 6, 9, 10])
    part.thresholds.forEach((t, i) => expect(t * 10).toBeCloseTo([1.5, 4.5, 7.5, 9.5][i], 9))
  })

  it('the zero plane: at or below it on the face; above it each value on its nearest floor (the shoreline at half the first step)', () => {
    const h = heightOfValue({ ...BASE, zeroPlane: 0.3, steps: steps({ mode: 'levels', levels: 4 }) })
    // 0.3 + 0.7 x 0.125 = 0.3875: halfway to the first floor
    expect(h(0.1)).toBe(0)
    expect(h(0.3)).toBe(0)
    expect(h(0.31)).toBe(0)
    expect(h(0.38)).toBe(0)
    expect(h(0.395)).toBe(1)
    expect(h(1)).toBe(4)
  })

  it('the status line lists the levels and their depths', () => {
    expect(levelsLine({ ...BASE, depthMm: 3, steps: steps({ mode: 'levels', levels: 4 }) })).toBe('4 levels 0.75 / 1.50 / 2.25 / 3.00 mm high, vertical walls')
    expect(levelsLine({ ...BASE, depthMm: 9, direction: 'cut', steps: steps({ mode: 'step', stepMm: 3, wallDeg: 60 }) })).toBe('3 levels 3.00 / 6.00 / 9.00 mm deep, walls at 60 deg')
    expect(levelsLine(BASE)).toBeNull()
  })
})

describe('WO-2174 step-downs on a known ramp', () => {
  const pic = ramp()

  it.each([
    ['4 levels', steps({ mode: 'levels', levels: 4 }), [1, 2, 3, 4]],
    ['fixed 1.5 mm steps', steps({ mode: 'step', stepMm: 1.5 }), [1.5, 3, 4]],
  ] as const)('%s: every height is a floor, exactly, and each wall is at its contour', (_, st, floors) => {
    const s: ReliefSettings = { ...BASE, steps: st }
    const plan = stepPlan(s)!
    const { cols, rows } = workingGridSize(s.widthMm, s.heightMm)
    const g = sampleReliefGrid(pic.grey, pic.cols, pic.rows, s, cols, rows)
    // every sample is a floor (the ramp's very first pixel may sit on the face)
    const seen = sorted(g.heights)
    expect(seen.filter((h) => h !== 0)).toEqual([...floors])
    const r = Math.floor(rows / 2)
    let checked = 0
    for (let c = 0; c < cols; c++) {
      const t = rampT(pic, s, (c / (cols - 1)) * s.widthMm)
      if (t < 0.01 || t > 0.99) continue // the ends clamp
      if (plan.thresholds.some((th) => Math.abs(th - t) < 1e-5)) continue // on a contour
      checked++
      expect(g.heights[r * cols + c]).toBe(plan.floorsMm[plan.thresholds.filter((th) => t > th).length])
    }
    expect(checked).toBeGreaterThan(900)
  })

  it('Cut in: the same floors below the face; base lifts them all', () => {
    const s: ReliefSettings = { ...BASE, direction: 'cut', baseMm: 0.5, steps: steps({ mode: 'levels', levels: 2 }) }
    const g = sampleReliefGrid(pic.grey, pic.cols, pic.rows, s, 101, 3)
    expect(sorted(g.heights).filter((h) => h !== -0.5)).toEqual([-4.5, -2.5])
  })

  it('a 45 deg wall: each floor keeps its whole contour, the wall slopes 1 mm per mm outside it', () => {
    const s: ReliefSettings = { ...BASE, steps: steps({ mode: 'levels', levels: 4, wallDeg: 45 }) }
    const at = reliefSampler(pic.grey, pic.cols, pic.rows, s)
    const h = (x: number) => at(x / s.widthMm, 0.5)
    // the contours along the ramp between floors k and k + 1: t = 0.375, 0.625, 0.875 (halfway between them)
    ;[0.375, 0.625, 0.875].forEach((t, i) => {
      const cx = rampX(pic, s, t), lower = i + 1
      // inside the contour: the upper floor
      expect(h(cx + 0.15)).toBeCloseTo(lower + 1, 6)
      // the wall: 1 mm wide (1 mm drop at 45 deg), sloping 1 mm per mm
      const slope = (h(cx - 0.2) - h(cx - 0.8)) / 0.6
      expect(slope).toBeGreaterThan(0.97)
      expect(slope).toBeLessThan(1.03)
      // beyond the wall: the lower floor, flat
      expect(h(cx - 1.25)).toBeCloseTo(lower, 6)
    })
  })

  it('a 60 deg wall slopes tan(60 deg) in any direction on a picture of rings (chamfer distances within 5 %)', () => {
    const n = 161
    const grey = new Float32Array(n * n)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grey[j * n + i] = Math.max(0, 1 - Math.hypot(i + 0.5 - n / 2, j + 0.5 - n / 2) / (n / 2))
    const s: ReliefSettings = { ...BASE, widthMm: 80, heightMm: 80, depthMm: 3, steps: steps({ mode: 'levels', levels: 4, wallDeg: 60 }) }
    const at = reliefSampler(grey, n, n, s)
    // the top floor's contour: t = 0.875 (halfway between floors 3 and 4) -> radius (1 - 0.875) * 40 mm = 5 mm from the centre
    for (const deg of [0, 22.5, 45, 67.5, 90, 150, 225]) {
      const a = (deg * Math.PI) / 180
      const h = (rad: number) => at(0.5 + (rad * Math.cos(a)) / 80, 0.5 + (rad * Math.sin(a)) / 80)
      expect(h(4.8)).toBeCloseTo(3, 6)
      // the wall drops 0.75 mm over 0.75 / tan(60 deg) = 0.43 mm
      const slope = (h(5.12) - h(5.32)) / 0.2
      console.log(`WO-2174 60 deg wall at ${deg} deg: slope / tan(60) = ${(slope / Math.tan(Math.PI / 3)).toFixed(3)}`)
      expect(slope / Math.tan(Math.PI / 3)).toBeGreaterThan(0.95)
      expect(slope / Math.tan(Math.PI / 3)).toBeLessThan(1.05)
    }
  })
})

describe('WO-2174 step-downs on a known contour picture', () => {
  it('rings: the floor boundaries are the picture contours (circles) halfway between the floors', () => {
    const n = 121
    const R = n / 2
    const grey = new Float32Array(n * n)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grey[j * n + i] = Math.max(0, 1 - Math.hypot(i + 0.5 - R, j + 0.5 - R) / R)
    const s: ReliefSettings = { ...BASE, widthMm: 60, heightMm: 60, depthMm: 5, zeroPlane: 0.1, steps: steps({ mode: 'levels', levels: 5 }) }
    const { cols, rows } = workingGridSize(s.widthMm, s.heightMm)
    const g = sampleReliefGrid(grey, n, n, s, cols, rows)
    // the contours: value 0.1 (the zero plane) + 0.9 x (k - 0.5) / 5 -> radius 30 x (1 - value)
    const contours = [0.1, 0.3, 0.5, 0.7, 0.9].map((k) => 30 * (1 - (0.1 + 0.9 * k)))
    let checked = 0, wrong = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const rad = Math.hypot((c / (cols - 1)) * 60 - 30, (r / (rows - 1)) * 60 - 30)
        // a sample more than half a picture pixel (0.25 mm) from a contour is on the floor of the exact cone
        if (contours.some((cr) => Math.abs(cr - rad) < 0.25) || rad < 1) continue
        checked++
        const floor = contours.filter((cr) => rad < cr).length
        if (g.heights[r * cols + c] !== floor) wrong++
      }
    }
    console.log(`WO-2174 rings: ${checked} samples off the contours, ${wrong} on the wrong floor`)
    expect(checked).toBeGreaterThan(300_000)
    expect(wrong).toBe(0)
  })
})

describe('WO-2174 step-downs reach what Apply builds', () => {
  it('the exact face poles and the mesh relief detail grid carry the floors', () => {
    const pic = ramp(201, 60)
    const face = { centre: { x: 0, y: 0, z: 0 }, xDir: { x: 1, y: 0, z: 0 }, yDir: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 }, widthMm: 120, heightMm: 40 }
    const settings: ReliefSettings = { ...BASE, heightMm: 30, auto: false, adjust: { ...MANUAL_PICTURE_ADJUST, smoothMm: 0 }, steps: steps({ mode: 'levels', levels: 4 }) }
    const f = reliefKernelFields(pic, { face, settings, autoParams: autoParams(pic) })
    expect(f.detail).toBeDefined()
    // the detail grid (inside its edge ring, which lies on the face) is floors only
    const d = f.detail!
    const inner: number[] = []
    for (let r = 1; r < d.rows - 1; r++) for (let c = 1; c < d.cols - 1; c++) inner.push(d.heights[r * d.cols + c])
    expect(sorted(inner).filter((h) => h !== 0)).toEqual([1, 2, 3, 4])
    const poles = polesFromPicture(pic.grey, pic.cols, pic.rows, settings, 64)
    expect(sorted(Array.from(poles.heights).map((h) => Math.round(h * 1e6) / 1e6))).toEqual([0, 1, 2, 3, 4])
    // and the settled preview's detail grid is the same numbers
    expect(Array.from(reliefDetailGrid(pic.grey, pic, settings).heights)).toEqual(Array.from(d.heights))
  })
})
