// WO-2226 - a drafted wall on a CUT relief (Emboss, Engrave) keeps the subject's
// outline at the face and slopes INTO the cut (Operator 2026-09-29, card
// Q-RELIEF-DRAFT-PICTURES-AT-45-DEG: "Make Emboss + Engrave keep the letter
// outline at the face"). Before it, the cut was the negated Raise dilation: the
// deepest floor kept its contour and the walls leaned outward to the face, so
// Engrave's letters grew at the face and Emboss's letter tops shrank. Raise is
// unchanged: each floor keeps its contour at its foot, the wall outside it.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEPS, DRAFT_GRID_CAP, dilateByCone, draftGrid, reliefSampler, sampleReliefGrid, type ReliefSettings, type StepDowns,
} from '../../relief/reliefHeights'
import { workingGridSize } from '../../relief/heightGrid'

const steps = (patch: Partial<StepDowns>): StepDowns => ({ ...DEFAULT_STEPS, ...patch })

// a filled square: 500 x 500 px over 50 x 50 mm (0.1 mm a pixel), the square pixels 125 .. 374 -> 12.5 .. 37.5 mm
const N = 500
const square = new Float32Array(N * N)
for (let j = 125; j < 375; j++) for (let i = 125; i < 375; i++) square[j * N + i] = 1

const SQUARE: ReliefSettings = {
  widthMm: 50, heightMm: 50, keepProportions: true, rotationDeg: 0, offsetXMm: 0, offsetYMm: 0,
  depthMm: 2, direction: 'cut', invert: false, zeroPlane: 0, baseMm: 0, auto: false,
  steps: steps({ mode: 'levels', levels: 1, wallDeg: 45 }),
}
const vertical = (s: ReliefSettings): ReliefSettings => ({ ...s, steps: { ...s.steps!, wallDeg: 90 } })

/** Depth (mm, positive into the part) along the square's middle row at x mm. */
const depthAlong = (s: ReliefSettings) => {
  const at = reliefSampler(square, N, N, s)
  return (xMm: number) => -at(xMm / s.widthMm, 0.5)
}

/** The x (mm) along the middle row of the first draft-grid cell, scanning from the left (or the right), that is
 *  cut below the face by more than 1 um (subjectCut) or that is on the face (!subjectCut). */
function faceEdge(s: ReliefSettings, subjectCut: boolean, fromRight = false): number {
  const g = draftGrid(square, N, N, s)
  const r = (g.rows - 1) >> 1
  for (let k = 0; k < g.cols; k++) {
    const c = fromRight ? g.cols - 1 - k : k
    const cut = -g.heights[r * g.cols + c] > 1e-3
    if (cut === subjectCut) return (c / (g.cols - 1)) * g.widthMm
  }
  return NaN
}

describe('WO-2226 a drafted cut keeps the outline at the face', () => {
  it('Engrave, one level, Walls 45: the face outline is the square, 1 mm inside it the cut is 1 mm deep, full depth only 2 mm in', () => {
    const d = depthAlong(SQUARE)
    const cell = SQUARE.widthMm / (workingGridSize(SQUARE.widthMm, SQUARE.heightMm, undefined, DRAFT_GRID_CAP).cols - 1)
    // the face outline: the vertical-wall cut's edge (the picture's contour) within one grid cell
    const edge90 = faceEdge(vertical(SQUARE), true), edge45 = faceEdge(SQUARE, true)
    console.log(`WO-2226 engrave: face edge at walls 90 ${edge90.toFixed(3)} mm, at walls 45 ${edge45.toFixed(3)} mm (cell ${cell.toFixed(3)} mm)`)
    expect(Math.abs(edge45 - edge90)).toBeLessThanOrEqual(cell + 1e-9)
    expect(Math.abs(edge45 - 12.5)).toBeLessThanOrEqual(cell + 1e-9)
    // outside the outline: the face, untouched
    expect(d(12.2)).toBeCloseTo(0, 6)
    expect(d(5)).toBeCloseTo(0, 6)
    // the contour lies between the last face cell and the first cut cell; depth is measured from the face's end
    const face = edge45 - cell
    // into the cut: 0.5 mm in -> 0.5 mm deep, 1 mm in -> 1 mm deep (+-5 %), full depth only from 2 mm in
    expect(d(face + 0.5)).toBeGreaterThan(0.475)
    expect(d(face + 0.5)).toBeLessThan(0.525)
    expect(d(face + 1)).toBeGreaterThan(0.95)
    expect(d(face + 1)).toBeLessThan(1.05)
    expect(d(face + 1.8)).toBeLessThan(1.9)
    expect(d(face + 2.1)).toBeCloseTo(2, 6)
    expect(d(25)).toBeCloseTo(2, 6)
    // the right-hand wall is the mirror
    expect(d(37.8)).toBeCloseTo(0, 6)
    const right = faceEdge(SQUARE, true, true) + cell
    expect(Math.abs(right - 37.5)).toBeLessThanOrEqual(cell + 1e-9)
    expect(d(right - 1)).toBeGreaterThan(0.95)
    expect(d(right - 1)).toBeLessThan(1.05)
  })

  it('Emboss, one level, Walls 45: the letter top is the square at the face, the wall flares outward into the cut', () => {
    const s: ReliefSettings = { ...SQUARE, emboss: true }
    const d = depthAlong(s)
    const cell = s.widthMm / (workingGridSize(s.widthMm, s.heightMm, undefined, DRAFT_GRID_CAP).cols - 1)
    // the subject's top: face cells from the square's edge (vertical-wall edge within one cell)
    const edge90 = faceEdge(vertical(s), false), edge45 = faceEdge(s, false)
    console.log(`WO-2226 emboss: top edge at walls 90 ${edge90.toFixed(3)} mm, at walls 45 ${edge45.toFixed(3)} mm (cell ${cell.toFixed(3)} mm)`)
    expect(Math.abs(edge45 - edge90)).toBeLessThanOrEqual(cell + 1e-9)
    expect(d(25)).toBeCloseTo(0, 6)
    expect(d(12.9)).toBeCloseTo(0, 6)
    // 1 mm outside the top edge the background is 1 mm down; full depth from 2 mm out
    expect(d(edge45 - 1)).toBeGreaterThan(0.95)
    expect(d(edge45 - 1)).toBeLessThan(1.05)
    expect(d(edge45 - 2.1)).toBeCloseTo(2, 6)
  })

  it('a base under the cut stays under the whole relief and the draft slopes from it', () => {
    const s: ReliefSettings = { ...SQUARE, baseMm: 0.5 }
    const d = depthAlong(s)
    const cell = s.widthMm / (workingGridSize(s.widthMm, s.heightMm, undefined, DRAFT_GRID_CAP).cols - 1)
    // with a base every cell is below the face; the subject's cut starts where it passes the base
    const g = draftGrid(square, N, N, s)
    const r = (g.rows - 1) >> 1
    let first = 0
    while (-g.heights[r * g.cols + first] < 0.5 + 1e-3) first++
    const face = ((first - 1) / (g.cols - 1)) * g.widthMm
    expect(Math.abs(face + cell - faceEdge(SQUARE, true))).toBeLessThanOrEqual(1e-9)
    expect(Math.abs(face + cell - 12.5)).toBeLessThanOrEqual(cell + 1e-9)
    expect(d(5)).toBeCloseTo(0.5, 6)
    expect(d(face + 1)).toBeGreaterThan(1.45)
    expect(d(face + 1)).toBeLessThan(1.55)
    expect(d(25)).toBeCloseTo(2.5, 6)
  })

  it('multi-level Engrave at Walls 60 on rings: each floor keeps its contour at its top, the wall slopes tan(60 deg) into the cut', () => {
    const n = 161
    // the rings' centre sits 0.3 px off the pixel grid, so no contour radius lands exactly on a draft-grid cell (a
    // cell exactly on a contour ties the threshold in float and jags that contour by one cell - true of Raise too)
    const cp = n / 2 + 0.3
    const grey = new Float32Array(n * n)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grey[j * n + i] = Math.max(0, 1 - Math.hypot(i + 0.5 - cp, j + 0.5 - cp) / (n / 2))
    const s: ReliefSettings = { ...SQUARE, widthMm: 80, heightMm: 80, depthMm: 3, steps: steps({ mode: 'levels', levels: 4, wallDeg: 60 }) }
    const cut = reliefSampler(grey, n, n, s), raise = reliefSampler(grey, n, n, { ...s, direction: 'raise' })
    const cx = cp / n, cy = 1 - cp / n
    const tan60 = Math.tan(Math.PI / 3)
    const rays = Array.from({ length: 36 }, (_, i) => (i * 10 + 3) * (Math.PI / 180))
    // floor k (0.75 k mm) is everything above t = (k - 0.5) / 4 (WO-2229: halfway between floors) -> its contour at
    // radius 40 (1 - (k - 0.5) / 4); floor 1 is the face outline itself, floor 4 (radius 5 mm) too tight a curve for the 0.1 mm grid
    for (const [k, rc] of [[1, 35], [2, 25], [3, 15]] as const) {
      const upper = 0.75 * (k - 1), lower = 0.75 * k
      const slopes = { cut: [] as number[], raise: [] as number[] }
      for (const a of rays) {
        const along = (f: (fx: number, fy: number) => number) => (rad: number) => f(cx + (rad * Math.cos(a)) / 80, cy + (rad * Math.sin(a)) / 80)
        const d = (rad: number) => -along(cut)(rad)
        // just outside the contour: the floor above, flat (the old outward wall stood here); past the wall, this floor
        expect(d(rc + 0.2)).toBeCloseTo(upper, 6)
        expect(d(rc - 0.65)).toBeCloseTo(lower, 6)
        // the cut wall starts at the contour (within a grid cell) and runs INSIDE it, 0.75 mm down over 0.433 mm
        let start = NaN, end = NaN
        for (let r = rc + 0.3; r > rc - 0.8; r -= 0.005) {
          if (Number.isNaN(start) && d(r) > upper + 1e-4) start = r
          if (Number.isNaN(end) && d(r) > lower - 1e-4) end = r
        }
        expect(Math.abs(start - rc)).toBeLessThan(0.15)
        expect(start - end).toBeGreaterThan(0.75 / tan60 - 0.05)
        expect(start - end).toBeLessThan(0.75 / tan60 + 0.2)
        // its slope over 0.2 mm about the wall's middle; Raise's wall (outside the contour) measured the same way
        const mid = (start + end) / 2
        slopes.cut.push((d(mid - 0.1) - d(mid + 0.1)) / 0.2 / tan60)
        const h = along(raise)
        slopes.raise.push((h(rc + 0.217 - 0.1) - h(rc + 0.217 + 0.1)) / 0.2 / tan60)
      }
      const stat = (xs: number[]) => ({ mean: xs.reduce((p, x) => p + x, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) })
      const c = stat(slopes.cut), r = stat(slopes.raise)
      console.log(`WO-2226 60 deg walls, floor ${k}, 36 rays, slope / tan(60): cut mean ${c.mean.toFixed(3)} (${c.min.toFixed(3)} .. ${c.max.toFixed(3)}), raise mean ${r.mean.toFixed(3)} (${r.min.toFixed(3)} .. ${r.max.toFixed(3)})`)
      // the slope is tan(60 deg) within 5 %; a single 0.2 mm reading wanders with the 0.1 mm grid's staircase contour
      expect(Math.abs(c.mean - 1)).toBeLessThan(0.05)
      expect(c.min).toBeGreaterThan(0.85)
      expect(c.max).toBeLessThan(1.15)
    }
  })

  it('Raise is unchanged: the draft grid is the vertical raise dilated by the cone, cell for cell', () => {
    for (const s of [{ ...SQUARE, direction: 'raise' as const }, { ...SQUARE, direction: 'raise' as const, baseMm: 0.5, steps: steps({ mode: 'levels', levels: 3, wallDeg: 60 }) }]) {
      const { cols, rows } = workingGridSize(s.widthMm, s.heightMm, undefined, DRAFT_GRID_CAP)
      const old = sampleReliefGrid(square, N, N, vertical(s), cols, rows)
      dilateByCone(old, Math.tan((s.steps!.wallDeg * Math.PI) / 180))
      const g = draftGrid(square, N, N, s)
      expect(g.cols).toBe(cols)
      expect(g.rows).toBe(rows)
      let diff = 0
      for (let i = 0; i < g.heights.length; i++) if (g.heights[i] !== old.heights[i]) diff++
      expect(diff).toBe(0)
    }
  })

  it('vertical walls cut exactly as before: Walls 90 is not drafted, the cut is the negated vertical raise', () => {
    const s = vertical(SQUARE)
    const { cols, rows } = workingGridSize(s.widthMm, s.heightMm)
    const cut = sampleReliefGrid(square, N, N, s, cols, rows)
    const raise = sampleReliefGrid(square, N, N, { ...s, direction: 'raise' }, cols, rows)
    let diff = 0
    for (let i = 0; i < cut.heights.length; i++) if (cut.heights[i] !== -raise.heights[i]) diff++
    expect(diff).toBe(0)
  })
})
