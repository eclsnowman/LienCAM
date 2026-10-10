// Image relief - placement on a flat face and the height numbers
// (docs/design/RELIEF-WHAT-GOOD-LOOKS-LIKE.md section 1 and S1, S2, S5, S12).
// Plain numbers only: the palette, the preview and the kernel request all
// read their heights from here, so what is previewed is what is built (S10).

import { adjustAny, type AutoParams, type PictureAdjust } from './adjust'
import type { Picture } from './picture'
import { heightAt, workingGridSize, type HeightGrid } from './heightGrid'
import { grevilleFraction, poleSurfaceGrid, type ReliefPoles } from './reliefStep'

export interface V3 { x: number; y: number; z: number }

/** A flat face as the relief sees it: its plane, an upright frame on it, and its extent in that frame. */
export interface FaceFrame {
  /** the centre of the face's extent, on its plane */
  centre: V3
  /** in-plane axes: xDir right, yDir up (the picture reads upright), normal out of the part; xDir x yDir = normal */
  xDir: V3
  yDir: V3
  normal: V3
  /** the face's extent along xDir / yDir, mm */
  widthMm: number
  heightMm: number
}

export type ReliefDirection = 'raise' | 'cut'

/** Every stage-1 control's value (section 1's table). */
export interface ReliefSettings {
  /** placed size of the picture, mm */
  widthMm: number
  heightMm: number
  keepProportions: boolean
  /** turn about the face normal, degrees counter-clockwise seen from outside */
  rotationDeg: number
  /** move of the picture's centre from the face's centre, along the face frame, mm */
  offsetXMm: number
  offsetYMm: number
  /** tallest point, mm */
  depthMm: number
  direction: ReliefDirection
  invert: boolean
  /** WO-2216: under 'cut', the subject (whatever invert already reads as high) stays at the face and everything
   *  else cuts down to the depth (Emboss), instead of the subject cutting down to the depth (Engrave, the plain
   *  'cut' - absent or false). Ignored under 'raise'. */
  emboss?: boolean
  /** 0 .. 0.99: everything darker sits on the face */
  zeroPlane: number
  /** plinth under the whole picture, mm */
  baseMm: number
  /** Auto's adjustment is on (it runs on open; one click switches it off) */
  auto: boolean
  /** WO-2174: every picture adjustment's value (Auto's, or the operator's); absent = stage 1's Auto / manual filters */
  adjust?: PictureAdjust
  /** WO-2174: step-downs - the heights snap to flat terraces; absent = off */
  steps?: StepDowns
}

/**
 * WO-2174 step-downs (Operator ruling 2026-09-28: "fixed depth step Downs option for
 * things like lake topography"): the heights snap to flat floors - N levels,
 * or a fixed depth per level - whose edges follow the picture's contours,
 * with vertical walls between them or walls at a chosen angle.
 */
export interface StepDowns {
  mode: 'off' | 'levels' | 'step'
  /** 'levels': how many stepped floors (the face itself not counted); 1 .. 50 */
  levels: number
  /** 'step': the depth of each step, mm */
  stepMm: number
  /** the walls between floors, degrees from the face: 90 = vertical */
  wallDeg: number
}

export const DEFAULT_STEPS: StepDowns = { mode: 'off', levels: 5, stepMm: 1, wallDeg: 90 }

/**
 * The floors of a step-down: floorsMm[0] = 0 is the face (everything at or
 * below the zero plane), floorsMm[k] the k-th floor's height above it; a relief
 * value t (0..1 of its range) stands on floor k when it lies above
 * thresholds[k-1] - so each floor's edge is the picture's contour at that value.
 * WO-2229: thresholds[k-1] is halfway between floors k-1 and k, so a value stands
 * on its NEAREST floor (Levels 1: half grey, the picture's true outline).
 */
export interface StepPlan { thresholds: number[]; floorsMm: number[] }

/**
 * The floors for these settings, or null when step-downs are off. Each value
 * stands on its nearest floor: a level's edge is halfway between the floors on
 * either side of it (WO-2229, Operator ruling 2026-09-29: "level edge at the true
 * outline"), so a soft letter edge no longer counts as a whole level. At or
 * below the zero plane is on the face; on a lake chart the shoreline is where
 * the depth reaches half the first step.
 * - N levels: floor k (1..N) is k / N of the depth deep - the deepest at full
 *   depth - and takes the values above (k - 0.5) / N of the range.
 * - Fixed step: floor k is k steps deep and takes everything deeper than
 *   k - 0.5 steps; the deepest floor is the depth itself (a last part-step when
 *   the depth is not a whole number of steps, its edge halfway to the depth;
 *   the status line lists them).
 */
export function stepPlan(s: Pick<ReliefSettings, 'depthMm' | 'steps'>): StepPlan | null {
  const st = s.steps
  if (st === undefined || st.mode === 'off') return null
  if (st.mode === 'levels') {
    const n = Math.min(Math.max(Math.round(st.levels), 1), 50)
    return {
      thresholds: Array.from({ length: n }, (_, k) => (k + 0.5) / n),
      floorsMm: Array.from({ length: n + 1 }, (_, k) => (s.depthMm * k) / n),
    }
  }
  const step = Math.max(st.stepMm, 1e-3)
  const count = Math.max(1, Math.ceil(s.depthMm / step - 1e-9))
  const floorsMm = Array.from({ length: count + 1 }, (_, k) => Math.min(k * step, s.depthMm))
  return {
    thresholds: Array.from({ length: count }, (_, k) => (floorsMm[k] + floorsMm[k + 1]) / 2 / s.depthMm),
    floorsMm,
  }
}

/** The floor (mm above the face) of a relief value t (0..1) under a step plan. */
function floorOf(plan: StepPlan, t: number): number {
  const th = plan.thresholds
  // how many thresholds t lies above (a value on a contour, within rounding, stays on the lower floor)
  let lo = 0, hi = th.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t > th[mid] + 1e-9) lo = mid + 1
    else hi = mid
  }
  return plan.floorsMm[lo]
}

/** The walls between floors are drafted (not vertical). */
export function draftedSteps(s: Pick<ReliefSettings, 'depthMm' | 'steps'>): boolean {
  return stepPlan(s) !== null && s.steps!.wallDeg < 89.95
}

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const unit = (a: V3): V3 => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l } }
const add = (a: V3, b: V3, s = 1): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s })

/**
 * The upright frame on a face with outward normal `n`: on a side face "up" is
 * +Z; on a top or bottom face the picture's X runs along +X.
 */
export function uprightAxes(normal: V3): { xDir: V3; yDir: V3; normal: V3 } {
  const n = unit(normal)
  if (Math.abs(n.z) < 0.9) {
    const yDir = unit(add({ x: 0, y: 0, z: 1 }, n, -n.z))
    return { xDir: cross(yDir, n), yDir, normal: n }
  }
  const xDir = unit(add({ x: 1, y: 0, z: 0 }, n, -n.x))
  return { xDir, yDir: cross(n, xDir), normal: n }
}

/** The face frame of a flat face from its outward normal and points on it (its display vertices). */
export function faceFrameFromPoints(normal: V3, points: ArrayLike<number>): FaceFrame {
  const axes = uprightAxes(normal)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sumN = 0
  const count = Math.floor(points.length / 3)
  for (let i = 0; i < count; i++) {
    const p = { x: points[i * 3], y: points[i * 3 + 1], z: points[i * 3 + 2] }
    const u = dot(p, axes.xDir), v = dot(p, axes.yDir)
    minX = Math.min(minX, u); maxX = Math.max(maxX, u); minY = Math.min(minY, v); maxY = Math.max(maxY, v)
    sumN += dot(p, axes.normal)
  }
  const planeD = sumN / Math.max(count, 1)
  const cu = (minX + maxX) / 2, cv = (minY + maxY) / 2
  const centre = add(add(add({ x: 0, y: 0, z: 0 }, axes.xDir, cu), axes.yDir, cv), axes.normal, planeD)
  return { centre, ...axes, widthMm: maxX - minX, heightMm: maxY - minY }
}

/** S1: fit inside the face, keep proportions, centred, 5 % margin on each side (at least 1 mm). */
export function fitToFace(pictureCols: number, pictureRows: number, faceWidthMm: number, faceHeightMm: number): { widthMm: number; heightMm: number } {
  const w = Math.max(faceWidthMm - 2 * Math.max(0.05 * faceWidthMm, 1), 0.1)
  const h = Math.max(faceHeightMm - 2 * Math.max(0.05 * faceHeightMm, 1), 0.1)
  const s = Math.min(w / pictureCols, h / pictureRows)
  return { widthMm: round3(pictureCols * s), heightMm: round3(pictureRows * s) }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

/** S2: 4 % of the shorter placed side, 0.5 .. 10 mm, rounded to 0.25 mm (to 0.05 mm below 1 mm). */
export function defaultDepth(widthMm: number, heightMm: number): number {
  const d = Math.min(Math.max(0.04 * Math.min(widthMm, heightMm), 0.5), 10)
  return d >= 1 ? Math.round(d * 4) / 4 : Math.round(d * 20) / 20
}

/** What a freshly opened picture gets with no other click (section 1 defaults + Auto). */
export function defaultSettings(picture: Picture, face: FaceFrame, auto: AutoParams | null): ReliefSettings {
  const size = fitToFace(picture.cols, picture.rows, face.widthMm, face.heightMm)
  return {
    ...size,
    keepProportions: true,
    rotationDeg: 0,
    offsetXMm: 0,
    offsetYMm: 0,
    depthMm: defaultDepth(size.widthMm, size.heightMm),
    direction: 'raise',
    invert: auto?.invert ?? false,
    zeroPlane: auto?.zeroPlane ?? 0,
    baseMm: 0,
    auto: auto !== null,
  }
}

/** The relief rectangle on the face: its low corner and its (turned) axes. */
export interface ReliefFrame { origin: V3; xDir: V3; yDir: V3; normal: V3; widthMm: number; heightMm: number }

export function reliefFrame(face: FaceFrame, s: ReliefSettings): ReliefFrame {
  const a = (s.rotationDeg * Math.PI) / 180
  const c = Math.cos(a), sn = Math.sin(a)
  const xDir = unit(add({ x: face.xDir.x * c, y: face.xDir.y * c, z: face.xDir.z * c }, face.yDir, sn))
  const yDir = unit(add({ x: face.yDir.x * c, y: face.yDir.y * c, z: face.yDir.z * c }, face.xDir, -sn))
  const centre = add(add(face.centre, face.xDir, s.offsetXMm), face.yDir, s.offsetYMm)
  const origin = add(add(centre, xDir, -s.widthMm / 2), yDir, -s.heightMm / 2)
  return { origin, xDir, yDir, normal: face.normal, widthMm: s.widthMm, heightMm: s.heightMm }
}

/** The height (mm, signed: + stands proud, - sinks in) of an adjusted picture value 0..1 (step-downs: its floor). */
export function heightOfValue(s: ReliefSettings): (v: number) => number {
  const sign = s.direction === 'cut' ? -1 : 1
  // draftGrid samples a forced-'raise' pass to dilate before signing (S9's drafted walls), so this stays keyed on
  // emboss alone: a 'raise' settings object never carries emboss=true except through that pass.
  const emboss = s.emboss === true
  const zp = Math.min(Math.max(s.zeroPlane, 0), 0.99)
  const span = 1 - zp
  const plan = stepPlan(s)
  return (v) => {
    const w = s.invert ? 1 - v : v
    const t = Math.min(Math.max((w - zp) / span, 0), 1)
    // WO-2216 Emboss: the subject (high t) lands at the face, everything else at the depth - the mirror of Engrave
    const tt = emboss ? 1 - t : t
    return sign * (s.baseMm + (plan === null ? s.depthMm * tt : floorOf(plan, tt)))
  }
}

/** WO-2216: the three Height buttons - Raise (today's Raise), Emboss (new), Engrave (today's Cut in, renamed). */
export type ReliefStyle = 'raise' | 'emboss' | 'engrave'

/** Which button matches these stored direction + emboss (ADR-0040: derived, never migrated - a project saved
 *  before this WO never has `emboss`, so it always reads back as Engrave, exactly the old Cut in it was). */
export function reliefStyleOf(s: Pick<ReliefSettings, 'direction' | 'emboss'>): ReliefStyle {
  if (s.direction === 'raise') return 'raise'
  return s.emboss === true ? 'emboss' : 'engrave'
}

/** direction + emboss to set for a style button click. Invert is untouched - it keeps meaning "which pixels are
 *  the subject" for whichever style is active, so it stays subject-relative whichever button the operator picks. */
export function reliefStyleSettings(style: ReliefStyle): Pick<ReliefSettings, 'direction' | 'emboss'> {
  if (style === 'raise') return { direction: 'raise', emboss: false }
  if (style === 'engrave') return { direction: 'cut', emboss: false }
  return { direction: 'cut', emboss: true }
}

/** Keys' cubic convolution weight (a = -0.5): bicubic, never nearest (S5). */
function keys(x: number): number {
  const t = Math.abs(x)
  if (t <= 1) return 1.5 * t * t * t - 2.5 * t * t + 1
  if (t < 2) return -0.5 * t * t * t + 2.5 * t * t - 4 * t + 2
  return 0
}

/**
 * Bicubic sample of a picture-sized float image at picture coordinates (u, v)
 * in pixels (pixel centres at integer + 0.5 from the top-left corner; edges clamp).
 */
export function bicubicAt(a: Float32Array, cols: number, rows: number, u: number, v: number): number {
  const x = u - 0.5, y = v - 0.5
  const x0 = Math.floor(x), y0 = Math.floor(y)
  let sum = 0, wsum = 0
  for (let j = -1; j <= 2; j++) {
    const yy = Math.min(Math.max(y0 + j, 0), rows - 1)
    const wy = keys(y - (y0 + j))
    if (wy === 0) continue
    for (let i = -1; i <= 2; i++) {
      const xx = Math.min(Math.max(x0 + i, 0), cols - 1)
      const w = wy * keys(x - (x0 + i))
      sum += w * a[yy * cols + xx]
      wsum += w
    }
  }
  return wsum !== 0 ? sum / wsum : 0
}

/**
 * The adjusted picture sampled onto a grid over the placed rectangle
 * (row 0 at the rectangle's low-Y edge, so the picture reads upright), as
 * signed heights in mm. Values between pixels are bicubic (S5).
 */
export function sampleReliefGrid(adjusted: Float32Array, picCols: number, picRows: number, s: ReliefSettings, cols: number, rows: number): HeightGrid {
  const grid: HeightGrid = { cols, rows, widthMm: s.widthMm, depthMm: s.heightMm, heights: new Float32Array(cols * rows) }
  sampleReliefRows(adjusted, picCols, picRows, s, grid, 0, rows)
  return grid
}

/** Rows r0 .. r1-1 of sampleReliefGrid, into `grid` (the page samples a big grid a slice at a time, S9). */
export function sampleReliefRows(adjusted: Float32Array, picCols: number, picRows: number, s: ReliefSettings, grid: HeightGrid, r0: number, r1: number): void {
  const at = reliefSampler(adjusted, picCols, picRows, s)
  const { cols, rows, heights } = grid
  for (let r = r0; r < r1; r++) {
    const fy = r / (rows - 1)
    for (let c = 0; c < cols; c++) heights[r * cols + c] = at(c / (cols - 1), fy)
  }
}

/**
 * The relief's height (mm, signed) at a point of the placed rectangle given as
 * fractions (fx right, fy up from the low-Y edge): the adjusted picture
 * sampled bicubic (S5) through the height controls. Drafted step-down walls
 * need each floor's neighbourhood, so they are read from the draft grid.
 */
export function reliefSampler(adjusted: Float32Array, picCols: number, picRows: number, s: ReliefSettings): (fx: number, fy: number) => number {
  if (draftedSteps(s)) {
    const g = draftGrid(adjusted, picCols, picRows, s)
    return (fx, fy) => heightAt(g, fx * g.widthMm, fy * g.depthMm)
  }
  const h = heightOfValue(s)
  return (fx, fy) => h(Math.min(Math.max(bicubicAt(adjusted, picCols, picRows, fx * picCols, (1 - fy) * picRows), 0), 1))
}

/** The draft grid's long side at most (a sloped wall reads smoothly from it; 0.1 mm up to a 102 mm relief). */
export const DRAFT_GRID_CAP = 1024

const draftCache = new WeakMap<Float32Array, { key: string; grid: HeightGrid }>()

/**
 * Step-downs with drafted walls, as a grid over the rectangle: the vertical-
 * wall floors sampled at the working pitch (capped at DRAFT_GRID_CAP), then
 * every floor's wall sloped at the chosen angle. Each floor keeps its whole
 * contour; its wall stands outside it, over the next floor out, dropping
 * tan(angle) mm per mm - a max-plus dilation of the floors by a cone, in two
 * chamfer passes over a 5 x 5 neighbourhood with exact local distances. A cut
 * is dilated as signed heights, so each floor keeps its contour at its top
 * edge and its wall slopes down into the cut (WO-2226).
 */
export function draftGrid(adjusted: Float32Array, picCols: number, picRows: number, s: ReliefSettings): HeightGrid {
  const key = JSON.stringify([picCols, picRows, s.widthMm, s.heightMm, s.depthMm, s.baseMm, s.zeroPlane, s.invert, s.direction, s.emboss, s.steps])
  const hit = draftCache.get(adjusted)
  if (hit !== undefined && hit.key === key) return hit.grid
  const { cols, rows } = workingGridSize(s.widthMm, s.heightMm, undefined, DRAFT_GRID_CAP)
  const vertical: ReliefSettings = { ...s, direction: 'raise', steps: { ...s.steps!, wallDeg: 90 } }
  const grid = sampleReliefGrid(adjusted, picCols, picRows, vertical, cols, rows)
  // WO-2226: a cut is negated BEFORE the dilation, so its depth is eroded - each floor keeps its contour at its top
  // edge (one level: the subject's outline at the face) and the wall slopes into the cut, never outward at the face
  if (s.direction === 'cut') for (let i = 0; i < grid.heights.length; i++) grid.heights[i] = -grid.heights[i]
  dilateByCone(grid, Math.tan((Math.max(s.steps!.wallDeg, 1) * Math.PI) / 180))
  draftCache.set(adjusted, { key, grid })
  return grid
}

/** h(p) = max over q of h(q) - slope * |p - q| (chamfer distances over a 5 x 5 neighbourhood), in place. */
export function dilateByCone(g: HeightGrid, slope: number): void {
  const { cols, rows, heights: h } = g
  const dx = g.widthMm / (cols - 1), dy = g.depthMm / (rows - 1)
  // the forward half of the 5 x 5 chamfer mask: the cell to the left, and the rows above
  const mask = ([[-1, 0], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1], [-1, -2], [1, -2]] as const)
    .map(([i, j]) => ({ i, j, drop: slope * Math.hypot(i * dx, j * dy) }))
  for (let pass = 0; pass < 2; pass++) {
    const sgn = pass === 0 ? 1 : -1
    for (let k = 0; k < rows; k++) {
      const r = pass === 0 ? k : rows - 1 - k
      for (let m = 0; m < cols; m++) {
        const c = pass === 0 ? m : cols - 1 - m
        let best = h[r * cols + c]
        for (const o of mask) {
          const cc = c + sgn * o.i, rr = r + sgn * o.j
          if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue
          const v = h[rr * cols + cc] - o.drop
          if (v > best) best = v
        }
        h[r * cols + c] = best
      }
    }
  }
}

/** mm on the part per picture pixel at this placement. */
export function picturePitchMm(picture: Picture, s: ReliefSettings): number {
  return Math.max(s.widthMm / picture.cols, s.heightMm / picture.rows)
}

/** The adjusted picture for these settings: their stage-2 adjustment values, else stage 1's Auto filters or the manual light smooth. */
export function adjustedFor(picture: Picture, auto: AutoParams, manual: AutoParams, s: ReliefSettings): Float32Array {
  return adjustAny(picture, adjustParamsFor(auto, manual, s), picturePitchMm(picture, s))
}

/** What the picture is filtered with for these settings (the relief worker is sent this). */
export function adjustParamsFor(auto: AutoParams, manual: AutoParams, s: ReliefSettings): AutoParams | PictureAdjust {
  return s.adjust ?? (s.auto ? auto : manual)
}

/** WO-2170 (IMAGE-RELIEF-PLAN.md 3a): an exact relief face is never built with more control points per side than this. */
export const EXACT_POLE_CAP = 256

/** The control points per side the applied face gets: the working grid's long side, capped at EXACT_POLE_CAP. */
export function poleCount(grid: { cols: number; rows: number }): number {
  return Math.max(4, Math.min(EXACT_POLE_CAP, Math.max(grid.cols, grid.rows)))
}

/**
 * WO-2200: a MESH relief - its working grid needs more control points per side
 * than an exact face may have (WO-2170's rule: exact up to 256, mesh above,
 * never exact above 256). Its relief face is meshed from the working grid at
 * full detail (Model screen, CAM, STL); STEP keeps the exact face.
 */
export function isMeshRelief(grid: { cols: number; rows: number }): boolean {
  return Math.max(grid.cols, grid.rows) > EXACT_POLE_CAP
}

/** The grid's outer ring set to 0: the relief's edge lies on the face, as the exact face's does. */
function zeroRing(g: HeightGrid): HeightGrid {
  const { cols, rows, heights } = g
  for (let c = 0; c < cols; c++) { heights[c] = 0; heights[(rows - 1) * cols + c] = 0 }
  for (let r = 0; r < rows; r++) { heights[r * cols] = 0; heights[r * cols + cols - 1] = 0 }
  return g
}

/** WO-2200: a mesh relief's working grid (10 / mm, 2048 cap), sampled as sampleReliefGrid samples it, its edge on the face. */
export function reliefDetailGrid(adjusted: Float32Array, picture: Picture, s: ReliefSettings): HeightGrid {
  const { cols, rows } = workingGridSize(s.widthMm, s.heightMm)
  return zeroRing(sampleReliefGrid(adjusted, picture.cols, picture.rows, s, cols, rows))
}

/** WO-2200: a mesh relief's surface on an (n+1) x (n+1) vertex grid over the rectangle - what the settled 3D preview draws (S10). */
export function previewHeightsFromPicture(adjusted: Float32Array, picture: Picture, s: ReliefSettings, n: number): Float32Array {
  return zeroRing(sampleReliefGrid(adjusted, picture.cols, picture.rows, s, n + 1, n + 1)).heights
}

/** The working grid's size (10 / mm, 2048 cap) over the placed rectangle. */
export interface WorkingGrid { cols: number; rows: number; widthMm: number; depthMm: number }

/**
 * The working grid (10 / mm, 2048 cap) and the exact face's poles for these
 * settings. The poles are the picture's heights at their Greville points,
 * sampled bicubic straight from the adjusted picture exactly as the working
 * grid samples it (sampleReliefGrid) - the same numbers the WO-2170 route
 * read off the grid, without building a million-sample grid first (S9).
 */
export function reliefSurface(adjusted: Float32Array, picture: Picture, s: ReliefSettings): { grid: WorkingGrid; poles: ReliefPoles } {
  const { cols, rows } = workingGridSize(s.widthMm, s.heightMm)
  const grid: WorkingGrid = { cols, rows, widthMm: s.widthMm, depthMm: s.heightMm }
  return { grid, poles: polesFromPicture(adjusted, picture.cols, picture.rows, s, poleCount(grid)) }
}

/** n x n poles of the relief, sampled from the adjusted picture at their Greville points; the border ring is 0 (the face's edge lies in the plane). */
export function polesFromPicture(adjusted: Float32Array, picCols: number, picRows: number, s: ReliefSettings, n: number): ReliefPoles {
  const at = reliefSampler(adjusted, picCols, picRows, s)
  const heights = new Float64Array(n * n)
  const fs = Array.from({ length: n }, (_, i) => grevilleFraction(i, n))
  for (let iy = 1; iy < n - 1; iy++) {
    for (let ix = 1; ix < n - 1; ix++) heights[iy * n + ix] = at(fs[ix], fs[iy])
  }
  return { n, widthMm: s.widthMm, depthMm: s.heightMm, heights }
}

/** The applied surface's heights on an (n+1) x (n+1) vertex grid over the rectangle - what the settled 3D preview draws (S10). */
export function previewHeightsFromPoles(poles: ReliefPoles, n: number): Float32Array {
  return poleSurfaceGrid(poles, n, n)
}

/** S12's numbers: size, highest point, steepest wall, working grid - information only. */
export interface ReliefStats {
  widthMm: number
  heightMm: number
  /** the highest point above the face (or the deepest below it for Cut in), mm */
  peakMm: number
  /** steepest wall of the applied surface, degrees from the face */
  steepestDeg: number
  gridCols: number
  gridRows: number
  gridPitchMm: number
  poles: number
  polePitchMm: number
  /** WO-2200: a mesh relief (isMeshRelief) */
  mesh: boolean
}

/**
 * The numbers the status line shows, measured on the applied surface: the
 * pole surface sampled at `samples` per side, or for a mesh relief the
 * working-grid surface given as `meshSurface` ((n+1)^2 heights).
 */
export function reliefStats(grid: WorkingGrid, poles: ReliefPoles, samples = 400, meshSurface?: { heights: Float32Array; n: number }): ReliefStats {
  const mesh = meshSurface !== undefined && isMeshRelief(grid)
  let peak = 0
  const peakOf = mesh ? meshSurface.heights : poles.heights
  for (let i = 0; i < peakOf.length; i++) if (Math.abs(peakOf[i]) > Math.abs(peak)) peak = peakOf[i]
  const n = mesh ? meshSurface.n : Math.max(8, samples)
  const dx = poles.widthMm / n, dy = poles.depthMm / n
  const h = mesh ? meshSurface.heights : previewHeightsFromPoles(poles, n)
  let steep = 0
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * (n + 1) + c
      const gx = (h[i + 1] - h[i]) / dx
      const gy = (h[i + n + 1] - h[i]) / dy
      steep = Math.max(steep, Math.hypot(gx, gy))
    }
  }
  return {
    widthMm: grid.widthMm,
    heightMm: grid.depthMm,
    peakMm: peak,
    steepestDeg: (Math.atan(steep) * 180) / Math.PI,
    gridCols: grid.cols,
    gridRows: grid.rows,
    gridPitchMm: grid.widthMm / (grid.cols - 1),
    poles: poles.n,
    polePitchMm: Math.max(poles.widthMm, poles.depthMm) / (poles.n - 1),
    mesh,
  }
}

/**
 * The status line (S12), e.g. "63.0 x 63.0 mm, highest 2.50 mm, steepest wall 71 deg, grid 631 x 631 @ 0.10 mm;
 * mesh relief at the grid's full detail (STL export); STEP export keeps the exact face, 256 x 256 control points (0.25 mm)".
 */
export function statusLine(st: ReliefStats, direction: ReliefDirection, s?: ReliefSettings): string {
  const peak = direction === 'cut' ? `deepest ${Math.abs(st.peakMm).toFixed(2)} mm` : `highest ${st.peakMm.toFixed(2)} mm`
  const fine = st.mesh
    ? `; mesh relief at the grid's full detail (STL export); STEP export keeps the exact face, ${st.poles} x ${st.poles} control points (${st.polePitchMm.toFixed(2)} mm)`
    : st.poles < Math.max(st.gridCols, st.gridRows)
      ? `; exact face ${st.poles} x ${st.poles} control points (${st.polePitchMm.toFixed(2)} mm): detail finer than that is smoothed`
      : `; exact face ${st.poles} x ${st.poles} control points`
  const levels = s === undefined ? null : levelsLine(s)
  return `${st.widthMm.toFixed(1)} x ${st.heightMm.toFixed(1)} mm, ${peak}, steepest wall ${Math.round(st.steepestDeg)} deg, grid ${st.gridCols} x ${st.gridRows} @ ${st.gridPitchMm.toFixed(2)} mm${fine}${levels === null ? '' : `; ${levels}`}`
}

/** Floors the status line lists before it skips to the last. */
const LISTED_LEVELS = 12

/**
 * WO-2174: the step-down levels and their depths, e.g. "4 levels 0.75 / 1.50 /
 * 2.25 / 3.00 mm deep, vertical walls" - null when step-downs are off.
 */
export function levelsLine(s: ReliefSettings): string | null {
  const plan = stepPlan(s)
  if (plan === null) return null
  // the stepped floors (the face, or the base, below the zero plane is not a level)
  const floors = plan.floorsMm.slice(1).map((f) => (s.baseMm + f).toFixed(2))
  const listed = floors.length > LISTED_LEVELS ? `${floors.slice(0, LISTED_LEVELS - 1).join(' / ')} / ... / ${floors[floors.length - 1]}` : floors.join(' / ')
  const walls = draftedSteps(s) ? `walls at ${Math.round(s.steps!.wallDeg * 10) / 10} deg` : 'vertical walls'
  return `${floors.length} levels ${listed} mm ${s.direction === 'cut' ? 'deep' : 'high'}, ${walls}`
}
