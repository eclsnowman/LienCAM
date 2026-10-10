// WO-2063 - one step's picture: the side view and the top view, drawn from
// the step's own millimetres (probeScene.ts), never a hand-drawn sketch.
//
// THE STANDARD is the Bore reference video Operator locked on 2026-09-27
// (src/tests/evidence/WO-2063/bore-full-run.mp4, drawn by bore-full-run.mjs);
// this file draws what that script draws, from the live plan:
//   - WHERE TO BE (YOU steps): the start zone, dimensioned in both views - its
//     width, and its height ("< 25 mm") when it has one; dimensions only, each
//     where it fits (WO-2179), the words in the sentence under the picture;
//   - BEFORE START: the real probe stays where it is; a see-through (blue)
//     preview probe plays the step's moves; a touch shows as a hollow ring;
//   - RUNNING: the real probe follows the machine;
//   - either way ONE move at a time: a faded outline where it started, ONE
//     path from the probe to where it goes (dashed when it probes), ONE
//     distance that counts down; touches light orange and stay;
//   - a strip over the side view says which: "BEFORE START - preview (nothing
//     moves)" or "RUNNING".
// Readable from a distance: 7 px paths with solid heads, text 19 px and up
// (WO-2181: halfway between the old 24-28 px and the UI's 13 px).
//
// The SVG's units are CSS pixels (its viewBox is the box it is drawn in), so
// every size below is what the operator sees.

import type { ReactNode } from 'react'
import {
  moveLabel,
  moveLength,
  sectionAt,
  slice,
  type HeightLine,
  type P3,
  type ProbeScene,
  type ProbeStep,
  type Shape,
  type StepMove,
} from './probeScene'
import { startSearchMm } from './stepTracker'
import type { WorkProbeAxis } from '../../../lib/machine/probeRoutines'

export interface PictureProgress {
  /** Which of the step's moves the probe is on. */
  move: number
  /** 0..1 along that move. */
  t: number
}

/** Before Start, while the machine runs, or after the run ended. */
export type PictureMode = 'preview' | 'running' | 'after'

export const PREVIEW_CAPTION = 'BEFORE START - preview (nothing moves)'
export const RUNNING_CAPTION = 'RUNNING'

const GAP = 48 // the top view starts this far right of the side view
const MIN_TOP_W = 220
const STEM_MM = 3
const ARROW_W = 7
const HEAD = 26
const TEXT = 20
const DIM_TEXT = 20
/** The top view's zone width and X / Y letters. */
const TOP_TEXT = 19
/** The BEFORE START / RUNNING strip over the side view. */
const CAP_TEXT = 20
/** The room the height-label column keeps, at the size the pictures were
 *  approved with: WO-2181 made the words smaller, never the views. */
const LABEL_COLUMN_TEXT = 28
const LABEL_GAP = 36 // height labels never closer than this (one line each)
const TOP_PROBE_MIN_R = 12
/** WO-2182: Angle's two touch points, marked on its face. */
const ANGLE_POINT_R = 8
const MISS_GAP = 24 // after a miss, the drawn probe stops this far (px) short of the surface it never found
/** The strip over the side view (the caption), and the drawing below it. */
const CAP_H = 46

const C = {
  text: 'var(--text-primary)',
  dim: 'var(--text-secondary)',
  safe: 'var(--hue-plane)',
  depth: 'var(--violet-300)',
  crossing: 'var(--hue-plane)',
  you: 'var(--role-identity-light)',
  move: 'var(--vp-axis-x)',
  touch: 'var(--select-viewport)',
  frame: 'var(--border-strong)',
  preview: 'var(--accent, #3b82f6)',
  running: 'var(--success, #4ade80)',
}

const AXIS_COLOR: Record<'X' | 'Y', string> = {
  X: 'var(--vp-axis-x)',
  Y: 'var(--vp-axis-y)',
}

function moveAxis(m: StepMove): 'X' | 'Y' | 'Z' {
  const dx = Math.abs(m.to.x - m.from.x)
  const dy = Math.abs(m.to.y - m.from.y)
  const dz = Math.abs(m.to.z - m.from.z)
  return dx >= dy && dx >= dz ? 'X' : dy >= dz ? 'Y' : 'Z'
}

const u = (p: P3, axis: WorkProbeAxis) => (axis === 'X' ? p.x : p.y)
const w = (p: P3, axis: WorkProbeAxis) => (axis === 'X' ? p.y : p.x)
const lerp = (a: P3, b: P3, t: number): P3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
/** Text width estimate for the bold UI face (measured in the captures:
 *  "safe +5 · tip clearance" is 300 px at 28 px - about 0.47 em a character;
 *  0.5 keeps a margin). */
const textW = (text: string, size: number) => text.length * size * 0.5

/** A box on the picture (px). */
interface Area { x0: number; x1: number; y0: number; y1: number }
const areaOverlap = (a: Area, b: Area) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
/** Where a label's letters are: its width, the capitals above the baseline, a
 *  little below it, and a margin round them. Numbers run wider than words
 *  ("< 100 mm" is 118 px at 26 px - 0.57 em a character): 0.6 em. */
function textArea(x: number, y: number, anchor: 'start' | 'middle' | 'end', text: string, size: number, pad = 4): Area {
  const tw = text.length * size * 0.6
  const x0 = anchor === 'start' ? x : anchor === 'end' ? x - tw : x - tw / 2
  return { x0: x0 - pad, x1: x0 + tw + pad, y0: y - size * 0.8 - pad, y1: y + size * 0.25 + pad }
}
/** Whether a box touches a circle's outline (a stroke `half` px either side). */
function touchesRing(a: Area, cx: number, cy: number, r: number, half: number): boolean {
  const near = Math.hypot(Math.max(a.x0 - cx, 0, cx - a.x1), Math.max(a.y0 - cy, 0, cy - a.y1))
  const far = Math.hypot(Math.max(Math.abs(a.x0 - cx), Math.abs(a.x1 - cx)), Math.max(Math.abs(a.y0 - cy), Math.abs(a.y1 - cy)))
  return near <= r + half && far >= r - half
}
/** Whether a straight segment (a stroke `half` px either side) crosses a box. */
function segmentHitsArea(a: Area, x0: number, y0: number, x1: number, y1: number, half: number): boolean {
  // The segment clipped to the box grown by the stroke (Liang-Barsky).
  const [bx0, bx1, by0, by1] = [a.x0 - half, a.x1 + half, a.y0 - half, a.y1 + half]
  const dx = x1 - x0
  const dy = y1 - y0
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [[-dx, x0 - bx0], [dx, bx1 - x0], [-dy, y0 - by0], [dy, by1 - y0]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}
/** Whether a point is inside a convex or simple outline (mm). */
function insidePoly(pts: Array<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]
    const b = pts[j]
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
/** Sample points across a box (the part test: is any of it on material). */
function samples(a: Area): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) out.push([a.x0 + ((a.x1 - a.x0) * i) / 8, a.y0 + ((a.y1 - a.y0) * j) / 4])
  return out
}

/** The probe's position at a progress along the step's moves. */
export function probeAt(step: ProbeStep, progress: PictureProgress | null): P3 {
  if (!progress || step.moves.length === 0) return step.moves.length ? step.moves[0].from : step.at
  const i = Math.max(0, Math.min(step.moves.length - 1, progress.move))
  return lerp(step.moves[i].from, step.moves[i].to, Math.max(0, Math.min(1, progress.t)))
}

function Arrow({ x1, y1, x2, y2, color, dashed, testId, beside }: { x1: number; y1: number; x2: number; y2: number; color: string; dashed: boolean; testId?: string; beside?: boolean }) {
  const len = Math.hypot(x2 - x1, y2 - y1)
  if (len < 1) return null
  const ux = (x2 - x1) / len
  const uy = (y2 - y1) / len
  const px = -uy
  const py = ux
  const h = Math.min(HEAD, len)
  const pts = [
    [x2, y2],
    [x2 - ux * h + px * h * 0.55, y2 - uy * h + py * h * 0.55],
    [x2 - ux * h - px * h * 0.55, y2 - uy * h - py * h * 0.55],
  ].map((p) => p.join(',')).join(' ')
  return (
    <g data-testid={testId} data-move-kind={dashed ? 'probe' : 'move'} data-dx={Math.sign(Math.round(x2 - x1))} data-dy={Math.sign(Math.round(y2 - y1))} data-beside={beside ? 'true' : undefined}>
      {len > h * 0.8 && (
        <line
          x1={x1} y1={y1} x2={x2 - ux * h * 0.8} y2={y2 - uy * h * 0.8}
          stroke={color} strokeWidth={ARROW_W} strokeDasharray={dashed ? '16 10' : undefined}
        />
      )}
      <polygon points={pts} fill={color} />
    </g>
  )
}

/** A dimension: a line with end ticks and its words above it. */
function DimH({ xa, xb, y, label, color, testId, size = DIM_TEXT }: { xa: number; xb: number; y: number; label: string; color: string; testId?: string; size?: number }) {
  return (
    <g data-testid={testId}>
      <line x1={xa} y1={y} x2={xb} y2={y} stroke={color} strokeWidth={3} />
      <line x1={xa} y1={y - 12} x2={xa} y2={y + 12} stroke={color} strokeWidth={3} />
      <line x1={xb} y1={y - 12} x2={xb} y2={y + 12} stroke={color} strokeWidth={3} />
      <text x={(xa + xb) / 2} y={y - 14} textAnchor="middle" fontSize={size} fontWeight={700} fill={color}>{label}</text>
    </g>
  )
}

interface Frame { k: number; u0: number; z1: number }

function sideFrame(scene: ProbeScene, width: number, height: number): Record<WorkProbeAxis, Frame> {
  // One scale for the routine (the picture never jumps between steps), zoomed
  // to what its steps show: every probe position, move, touch and zone, the
  // height lines, and a little material under the lowest of them.
  const R = scene.tipRadiusMm
  const ranges: Record<WorkProbeAxis, [number, number]> = { X: [Infinity, -Infinity], Y: [Infinity, -Infinity] }
  let zLo = Infinity
  let zHi = -Infinity
  const addU = (axis: WorkProbeAxis, v: number) => {
    ranges[axis][0] = Math.min(ranges[axis][0], v)
    ranges[axis][1] = Math.max(ranges[axis][1], v)
  }
  const addZ = (z: number) => { zLo = Math.min(zLo, z); zHi = Math.max(zHi, z) }
  for (const step of scene.steps) {
    const pts: P3[] = [step.at, step.end, ...step.moves.flatMap((m) => [m.from, m.to])]
    if (step.touch) pts.push(step.touch)
    for (const p of pts) {
      addU(step.view, u(p, step.view) - R)
      addU(step.view, u(p, step.view) + R)
      addZ(p.z)
      addZ(p.z + 2 * R)
    }
    if (step.zone) {
      const a = step.view === 'X' ? [step.zone.x0, step.zone.x1] : [step.zone.y0, step.zone.y1]
      addU(step.view, a[0])
      addU(step.view, a[1])
    }
  }
  // A round feature shows its whole width (the Bore video: the bore and a
  // wall each side).
  if (scene.partDim) {
    const hx = scene.partDim.kind === 'round' ? scene.partDim.d / 2 : scene.partDim.x / 2
    const hy = scene.partDim.kind === 'round' ? scene.partDim.d / 2 : scene.partDim.y / 2
    addU('X', -hx - 8); addU('X', hx + 8)
    addU('Y', -hy - 8); addU('Y', hy + 8)
  }
  for (const h of scene.heights) addZ(h.z)
  if (!Number.isFinite(zLo)) { zLo = -10; zHi = 20 }
  for (const axis of ['X', 'Y'] as const) {
    if (!Number.isFinite(ranges[axis][0])) ranges[axis] = ranges[axis === 'X' ? 'Y' : 'X']
    if (!Number.isFinite(ranges[axis][0])) ranges[axis] = [-20, 20]
  }
  const padU = 6
  const zBottom = zLo - 6
  const zTop = zHi + 4
  const spans = (['X', 'Y'] as const).map((a) => ranges[a][1] - ranges[a][0] + 2 * padU)
  const k = Math.max(2, Math.min(width / Math.max(...spans), height / (zTop - zBottom)))
  const make = (axis: WorkProbeAxis): Frame => {
    const mid = (ranges[axis][0] + ranges[axis][1]) / 2
    const zMid = (zTop + zBottom) / 2
    return { k, u0: mid - width / (2 * k), z1: zMid + height / (2 * k) }
  }
  return { X: make('X'), Y: make('Y') }
}

interface TopFrame { k: number; x0: number; y1: number }

/** WO-2184: Z surface's top view room (px) - the X/Y marker on the left, the
 *  grid's count and spacing along the top. */
const MESH_PAD = { left: 104, right: 28, top: 58, bottom: 28 }
/** WO-2184: the grid's dots - the approved reference's r 6, smaller where the
 *  points are close, so they never merge. */
const MESH_DOT_R = 6
/** WO-2184: height colours, low -> high: the Main mesh viewer's own three
 *  (MeshViewerModal: --blue-500, --cyan-400, --amber-400). */
const MESH_LOW = [0x4a, 0x90, 0xd9]
const MESH_MID = [0x00, 0xe5, 0xff]
const MESH_HIGH = [0xff, 0xaa, 0x00]

export function meshHeightColor(t: number): string {
  const c = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5))
  const [a, b, k] = c < 0.5 ? [MESH_LOW, MESH_MID, c * 2] : [MESH_MID, MESH_HIGH, (c - 0.5) * 2]
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * k).toString(16).padStart(2, '0')).join('')}`
}

function meshTopFrame(mesh: NonNullable<ProbeScene['mesh']>, width: number, height: number): TopFrame {
  const xs = [...mesh.points.map((p) => p.x), ...(mesh.cut ? [mesh.cut.minX, mesh.cut.maxX] : [])]
  const ys = [...mesh.points.map((p) => p.y), ...(mesh.cut ? [mesh.cut.minY, mesh.cut.maxY] : [])]
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const innerW = Math.max(40, width - MESH_PAD.left - MESH_PAD.right)
  const innerH = Math.max(40, height - MESH_PAD.top - MESH_PAD.bottom)
  const xr = Math.max(x1 - x0, 1e-6)
  const yr = Math.max(y1 - y0, 1e-6)
  const k = Math.min(innerW / xr, innerH / yr)
  return { k, x0: x0 - (MESH_PAD.left + (innerW - xr * k) / 2) / k, y1: y1 + (MESH_PAD.top + (innerH - yr * k) / 2) / k }
}

function topFrame(scene: ProbeScene, width: number, height: number): TopFrame {
  if (scene.mesh && scene.mesh.points.length) return meshTopFrame(scene.mesh, width, height)
  const R = Math.max(scene.tipRadiusMm, 1)
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  for (const step of scene.steps) {
    for (const p of [step.at, step.end, ...step.moves.flatMap((m) => [m.from, m.to]), ...(step.touch ? [step.touch] : [])]) {
      add(p.x - R, p.y - R)
      add(p.x + R, p.y + R)
    }
    if (step.zone && step.zone.x1 - step.zone.x0 < 60 && step.zone.y1 - step.zone.y0 < 60) { add(step.zone.x0, step.zone.y0); add(step.zone.x1, step.zone.y1) }
  }
  for (const s of scene.shapes) {
    if (s.kind === 'circle') { add(s.cx - s.r, s.cy - s.r); add(s.cx + s.r, s.cy + s.r) }
    if (s.kind === 'rect' && s.x1 - s.x0 < 100 && s.y1 - s.y0 < 100) { add(s.x0, s.y0); add(s.x1, s.y1) }
  }
  if (!Number.isFinite(x0)) { x0 = -20; x1 = 20; y0 = -20; y1 = 20 }
  const pad = 6
  const xr = x1 - x0 + 2 * pad
  const yr = y1 - y0 + 2 * pad
  const k = Math.max(1, Math.min(width / xr, height / yr))
  const xm = (x0 + x1) / 2
  const ym = (y0 + y1) / 2
  return { k, x0: xm - width / (2 * k), y1: ym + height / (2 * k) }
}

function insideMaterial(shapes: Shape[], x: number, y: number): boolean {
  let solid = false
  for (const s of shapes) {
    const inShape = s.kind === 'rect'
      ? x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1
      : s.kind === 'poly'
        ? insidePoly(s.pts, x, y)
        : Math.hypot(x - s.cx, y - s.cy) <= s.r
    if (!inShape) continue
    solid = !s.cut
  }
  return solid
}

export { sectionAt }

/** The layout both the card and the picture use: side view width, top view box. */
export function pictureLayout(scene: ProbeScene, width: number, height: number) {
  const W = Math.max(400, Math.round(width))
  const H = Math.max(260, Math.round(height))
  // The height labels sit one line each right of the side view: leave them
  // their width.
  const labelW = Math.max(0, ...scene.heights.map((h) => textW(h.label, LABEL_COLUMN_TEXT))) + 24
  const sideW = Math.round(Math.min(H * 1.18, W - GAP - Math.max(MIN_TOP_W, labelW)))
  const topX = sideW + GAP
  const topW = W - topX
  const topH = Math.round(Math.min(H * 0.41, topW * 0.78))
  return { W, H, sideW, topX, topW, topH }
}

export function ProbeStepPicture({
  scene,
  step,
  width,
  height,
  progress,
  touched,
  mode = 'preview',
  real,
  reportedTip = null,
  missed = null,
  previewPhase = 'still',
}: {
  scene: ProbeScene
  step: ProbeStep
  width: number
  height: number
  /** Where along the step the moving probe is (null = the step's start). */
  progress: PictureProgress | null
  /** The step's touch has happened (preview: a hollow ring; running: lit). */
  touched: boolean
  mode?: PictureMode
  /** Where the real probe is (the machine), in the picture's frame. Running:
   *  the probe on the step's move; otherwise where it stands. */
  real?: P3
  /** WO-2587: depth-only readback, used only inside both drawn feature views. */
  reportedTip?: P3 | null
  /** WO-2152: after a stop, the untouched probe move the run ended on (a
   *  miss: no top found within the search), else null. */
  missed?: StepMove | null
  /** For captures: where the preview loop is ('start' holds before the move). */
  previewPhase?: 'still' | 'start' | 'playing' | 'live'
}) {
  const { W, H, sideW, topX, topW, topH } = pictureLayout(scene, width, height)
  const sideH = H
  const R = scene.tipRadiusMm
  // The caption strip's lines (two on a narrow side view), reserved on every
  // step so the drawing never jumps when the strip comes or goes.
  const capLines = textW(PREVIEW_CAPTION, CAP_TEXT) * 0.95 > sideW - 32 ? 2 : 1
  const CAP_BAND = CAP_H + (capLines - 1) * 32 + 10
  const frames = sideFrame(scene, sideW, sideH - CAP_BAND)
  const F = frames[step.view]
  const sx = (v: number) => (v - F.u0) * F.k
  const sz = (z: number) => CAP_BAND + (F.z1 - z) * F.k
  const TF = topFrame(scene, topW, topH)
  const tx = (x: number) => topX + (x - TF.x0) * TF.k
  const ty = (y: number) => (TF.y1 - y) * TF.k
  const topR = Math.max(R * TF.k, TOP_PROBE_MIN_R)
  const ballR = Math.max(R * F.k, 12)
  const stemW = Math.max((scene.tool ? 6 : STEM_MM) * F.k, 14)

  const moves = step.moves
  const moving = moves.length > 0 && (mode === 'running' || (mode === 'preview' && step.owner === 'machine'))
  const current = moving ? Math.max(0, Math.min(moves.length - 1, progress?.move ?? 0)) : -1
  // Before Start, the pause after a move (at a touch, between moves, before
  // the loop starts again) shows no move: no path, no "0 mm" - the Bore
  // video's holds. Running keeps the move until the machine starts the next.
  // (The last frames of an eased move, under 0.05 mm to go, read "0 mm": held too.)
  const holding = mode === 'preview' && progress !== null && current >= 0
    && (progress.t >= 1 || moveLength(moves[current]) * (1 - progress.t) < 0.05)
  const m = current >= 0 && !holding ? moves[current] : null
  // A move too short for an arrow on its own path (a 2 mm back-off, the slow
  // pass) still shows one before Start: full size, beside its true path
  // (Operator 09-27, the readable-from-a-distance rules) - never a distance
  // with no arrow.
  const besideShort = mode === 'preview'
  const MIN_ARROW = 2 * HEAD + 12
  // The probe on the move: the preview probe before Start, the machine running.
  // Running, the probe is where the machine reports it (`real`, glided
  // between reports by the card); the plan's progress only picks the move.
  const pos = moving ? (mode === 'running' && real ? real : probeAt(step, progress ?? { move: 0, t: 0 })) : null
  const realAt: P3 = mode === 'running' && pos ? pos : real ?? scene.start
  // WO-2113: after a stop the probe is drawn where the machine went - a miss
  // runs past the drawn top or face - kept inside each view if it ran past
  // what the picture shows.
  const keepIn = (v: number, lo: number, hi: number) => (lo > hi ? v : Math.min(hi, Math.max(lo, v)))
  // WO-2152: a search down that found nothing ended ABOVE the real top - the
  // drawn top is only where the plan expected it - so the drawn probe stops a
  // clear gap short of the drawn surface, never sunk into the part.
  // `data-real` keeps where the machine really went.
  const missedDown = mode === 'after' && missed && missed.kind === 'probe' && missed.to.z < missed.from.z - 1e-9 ? missed : null
  const aboveMiss = (z: number) => (missedDown
    ? Math.max(z, missedDown.to.z + (scene.tool ? MISS_GAP / F.k : (ballR + MISS_GAP) / F.k - R))
    : z)
  const realSide: P3 = (() => {
    if (mode !== 'after') return realAt
    const along = keepIn(u(realAt, step.view), F.u0 + ballR / F.k, F.u0 + (sideW - ballR) / F.k)
    const z = keepIn(aboveMiss(realAt.z), F.z1 - (sideH - CAP_BAND) / F.k, F.z1 - R - (ballR + 10) / F.k)
    return step.view === 'X' ? { ...realAt, x: along, z } : { ...realAt, y: along, z }
  })()
  const realTop: P3 = mode === 'after'
    ? { ...realAt, x: keepIn(realAt.x, TF.x0 + topR / TF.k, TF.x0 + (topW - topR) / TF.k), y: keepIn(realAt.y, TF.y1 - (topH - topR) / TF.k, TF.y1 - topR / TF.k) }
    : realAt
  // WO-2587 / reverted WO-2558: never put an off-picture machine into the
  // corner. The existing frames include the feature and its drawn margin.
  // Check all three tip coordinates, then change only the solid probe's Z;
  // plan progress, arrows, counter, outline, preview and sideways stay as approved.
  // Before Start, including the animated preview, always keep the start zone.
  const atPart = mode !== 'preview' && reportedTip !== null && !scene.tool
    && [reportedTip.x, reportedTip.y, reportedTip.z].every(Number.isFinite)
    && tx(reportedTip.x) >= topX && tx(reportedTip.x) <= topX + topW
    && ty(reportedTip.y) >= 0 && ty(reportedTip.y) <= topH
    && sx(u(reportedTip, step.view)) >= 0 && sx(u(reportedTip, step.view)) <= sideW
    && sz(reportedTip.z) >= CAP_BAND && sz(reportedTip.z) <= sideH
  const drawnAt = atPart ? { ...realAt, z: reportedTip.z } : realAt
  // A known tip inside the frame wins over the stopped-miss schematic gap.
  // Outside it, WO-2113/WO-2152's clamping and visible missed-top gap stay intact.
  const drawnSide = atPart ? { ...realSide, z: reportedTip.z } : realSide
  const ghostAt: P3 | null = mode === 'preview' && pos ? pos : null
  // Touches: found by earlier steps (lit, running and after); this step's -
  // lit when running, a hollow ring in the preview.
  const lit: P3[] = mode === 'preview' ? [] : [...step.found, ...(touched && step.touch ? [step.touch] : [])]
  const rings: P3[] = mode === 'preview' && touched && step.touch ? [step.touch] : []
  const caption = mode === 'preview' ? PREVIEW_CAPTION : mode === 'running' ? RUNNING_CAPTION : null

  const other = sectionAt(scene, step)
  const pieces = slice(scene.shapes, step.view, other)

  const clipId = `pbn-top-clip-${scene.routine}`
  const side: ReactNode[] = []
  const heightMarks: ReactNode[] = []
  const sideDrawing: ReactNode[] = []
  const tc: ReactNode[] = []

  // ---- side view: ground, material, height lines -------------------------
  sideDrawing.push(<rect key="bg" x={0} y={0} width={sideW} height={sideH} className="pbn-bg" />)
  pieces.filter((p) => !p.cut).forEach((p, i) => {
    sideDrawing.push(
      <rect key={`m${i}`} x={sx(p.a)} y={sz(p.top)} width={(p.b - p.a) * F.k} height={Math.max(0, (p.top - p.bottom) * F.k)}
        className={scene.tool && i === 1 ? 'pbn-setter' : 'control-probe-diagram-stock'} />,
    )
  })
  pieces.filter((p) => p.cut).forEach((p, i) => {
    sideDrawing.push(<rect key={`c${i}`} x={sx(p.a)} y={sz(p.top) - 2} width={(p.b - p.a) * F.k} height={Math.max(0, (p.top - p.bottom) * F.k) + 2} className="pbn-bg pbn-cut" />)
  })

  // Height lines run from the drawing's left edge into the label column,
  // where each one's words sit at its right end, one line each. A label that
  // would touch the one above steps down with a short leader.
  const labelX = sideW + 14
  const topViewBottom = topH + 24
  const lines = [...scene.heights].sort((a, b) => b.z - a.z)
  let lastY = -Infinity
  const lineColor = (h: HeightLine) => (h.kind === 'safe' ? C.safe : h.kind === 'depth' ? C.depth : h.kind === 'crossing' ? C.crossing : h.kind === 'start' ? C.you : C.text)
  const lineDash = (h: HeightLine) => (h.kind === 'safe' || h.kind === 'crossing' ? '14 9' : h.kind === 'depth' ? '3 7' : h.kind === 'start' ? '8 8' : undefined)
  const heightYs: number[] = []
  for (const h of lines) {
    const y = sz(h.z)
    if (y < CAP_BAND || y > sideH) continue
    heightYs.push(y)
    const color = lineColor(h)
    heightMarks.push(<line key={`h${h.kind}`} x1={0} y1={y} x2={sideW + 6} y2={y} stroke={color} strokeWidth={3} strokeDasharray={lineDash(h)} />)
    let ly = Math.max(y, lastY + LABEL_GAP, topViewBottom)
    if (ly > sideH - 6) ly = sideH - 6
    if (Math.abs(ly - y) > 1) {
      heightMarks.push(<polyline key={`hl${h.kind}`} points={`${sideW + 6},${y} ${labelX - 4},${ly}`} fill="none" stroke={color} strokeWidth={2} />)
    }
    heightMarks.push(
      <text key={`ht${h.kind}`} x={labelX} y={ly + 9} fontSize={TEXT} fontWeight={700} fill={color} data-testid="probe-height-label">{h.label}</text>,
    )
    lastY = ly
  }

  // ---- side view: the zone (where to be) -----------------------------------
  const zone = step.owner === 'you' ? step.zone : null
  if (zone) {
    const [a, b] = step.view === 'X' ? [zone.x0, zone.x1] : [zone.y0, zone.y1]
    const x0 = Math.max(0, Math.min(sx(a), sx(b)))
    const x1 = Math.min(sideW, Math.max(sx(a), sx(b)))
    // WO-2108: a zone with a ceiling (the top search) stops there.
    const yTop = zone.zMax === undefined ? CAP_BAND + 12 : Math.max(CAP_BAND + 12, sz(zone.zMax))
    const yBot = sz(zone.z0)
    side.push(
      <rect key="zone" x={x0} y={yTop} width={x1 - x0} height={Math.max(8, yBot - yTop)} className="pbn-zone" data-testid="probe-zone" />,
    )
    // The zone's width, between the safe line (or the zone's middle) and its
    // bottom, its words to the right of it.
    const safe = scene.heights.find((h) => h.kind === 'safe' || h.kind === 'crossing')
    const dy = safe && sz(safe.z) < yBot - 40 ? (sz(safe.z) + yBot) / 2 + 2 : (yTop + yBot) / 2
    // WO-2179 (Operator 09-29: "they are fine if they fit, but don't be verbose"):
    // the zone carries dimensions only - its width on its dimension line, its
    // height ("< 25 mm") beside it - each where it touches nothing: not the
    // zone, the probe, the part, a height line or another label. A dimension
    // that fits nowhere is not drawn; the sentence under the picture says it.
    const px = sx(u(realSide, step.view))
    const pw = Math.max(stemW / 2, ballR)
    const keep: Area[] = [
      { x0, x1, y0: yTop, y1: yBot },
      { x0: px - pw, x1: px + pw, y0: 0, y1: scene.tool ? sz(realSide.z) : sz(realSide.z + R) + ballR },
      ...heightYs.map((y) => ({ x0: -1e6, x1: 1e6, y0: y - 3, y1: y + 3 })),
    ]
    // The feature's own size, across it near the bottom of the view.
    let partDim: { half: number; label: string; y: number } | null = null
    if (scene.partDim) {
      const half = (scene.partDim.kind === 'round' ? scene.partDim.d : step.view === 'X' ? scene.partDim.x : scene.partDim.y) / 2
      const label = scene.partDim.kind === 'round' ? scene.partDim.label : `${Number((2 * half).toFixed(1))} mm`
      const deepest = Math.min(...scene.heights.map((h) => h.z))
      const y = Math.min(sideH - 30, sz(deepest) + 60)
      partDim = { half, label, y }
      keep.push(textArea((sx(-half) + sx(half)) / 2, y - 14, 'middle', label, DIM_TEXT, 0), { x0: sx(-half), x1: sx(half), y0: y - 12, y1: y + 12 })
    }
    // On material: the last piece holding the point wins (a hole after the stock).
    const onPart = (a: Area) => samples(a).some(([X, Y]) => {
      const along = F.u0 + X / F.k
      const z = F.z1 - (Y - CAP_BAND) / F.k
      let solid = false
      for (const p of pieces) if (along > p.a && along < p.b && z < p.top && z > p.bottom) solid = !p.cut
      return solid
    })
    const fits = (a: Area) => a.x0 >= 4 && a.x1 <= sideW - 4 && a.y0 >= CAP_BAND + 4 && a.y1 <= sideH - 4
      && keep.every((k) => areaOverlap(a, k) === 0) && !onPart(a)
    if (zone.dim && zone.dim.axis === step.view) {
      const da = sx(zone.dim.from)
      const db = sx(zone.dim.to)
      const label = zone.dim.label
      const right = { x: Math.max(da, db) + 16, anchor: 'start' as const }
      const left = { x: Math.min(da, db) - 16, anchor: 'end' as const }
      const sides = sideW - Math.max(da, db) - 16 >= textW(label, DIM_TEXT) ? [right, left] : [left, right]
      const at = sides.find((s) => fits(textArea(s.x, dy + 9, s.anchor, label, DIM_TEXT)))
      side.push(
        <g key="zdim" data-testid="probe-zone-dim">
          <line x1={da} y1={dy} x2={db} y2={dy} stroke={C.you} strokeWidth={3} />
          <line x1={da} y1={dy - 10} x2={da} y2={dy + 10} stroke={C.you} strokeWidth={3} />
          <line x1={db} y1={dy - 10} x2={db} y2={dy + 10} stroke={C.you} strokeWidth={3} />
          {at && <text x={at.x} y={dy + 9} textAnchor={at.anchor === 'end' ? 'end' : undefined} fontSize={DIM_TEXT} fontWeight={700} fill={C.you}>{label}</text>}
        </g>,
      )
      keep.push({ x0: Math.min(da, db) - 2, x1: Math.max(da, db) + 2, y0: dy - 12, y1: dy + 12 })
      if (at) keep.push(textArea(at.x, dy + 9, at.anchor, label, DIM_TEXT, 0))
    }
    // The height beside the zone, as near its top as it fits.
    if (zone.height) {
      const text = zone.height
      let at: { x: number; y: number; anchor: 'start' | 'end' } | null = null
      for (let y = yTop + DIM_TEXT * 0.8 + 8; y <= yBot + 8 && !at; y += 8) {
        for (const s of [{ x: x1 + 18, anchor: 'start' as const }, { x: x0 - 18, anchor: 'end' as const }]) {
          if (fits(textArea(s.x, y, s.anchor, text, DIM_TEXT))) { at = { ...s, y }; break }
        }
      }
      if (at) {
        side.push(
          <g key="zsay" data-testid="probe-zone-words">
            <text x={at.x} y={at.y} textAnchor={at.anchor} fontSize={DIM_TEXT} fontWeight={700} fill={C.you}>{text}</text>
          </g>,
        )
      }
    }
    if (partDim) {
      side.push(<DimH key="pdim" xa={sx(-partDim.half)} xb={sx(partDim.half)} y={partDim.y} label={partDim.label} color={C.dim} testId="probe-part-dim" />)
    }
  }

  // ---- side view: the probes, the one current move --------------------------
  const ballY = (z: number) => sz(z + R)
  const probeSide = (p: P3, kind: 'real' | 'outline' | 'preview', keyName: string) => {
    const x = sx(u(p, step.view))
    const by = ballY(p.z)
    const tipY = sz(p.z)
    const top = CAP_BAND - 10
    if (kind === 'preview') {
      side.push(
        <g key={keyName} data-testid="probe-side-preview">
          <rect x={x - stemW / 2} y={top} width={stemW} height={Math.max(0, (scene.tool ? tipY : by) - top)} fill={C.preview} fillOpacity={0.18} stroke={C.preview} strokeWidth={3} />
          {!scene.tool && <circle cx={x} cy={by} r={ballR} fill={C.preview} fillOpacity={0.28} stroke={C.preview} strokeWidth={4} />}
        </g>,
      )
      return
    }
    const ghost = kind === 'outline'
    side.push(
      <g key={keyName} data-testid={ghost ? 'probe-side-ghost' : 'probe-side-probe'} opacity={ghost ? 0.7 : 1}>
        {scene.tool
          ? <rect x={x - stemW / 2} y={top} width={stemW} height={Math.max(0, tipY - top)} className={ghost ? 'pbn-ghost' : 'pbn-tool'} />
          : <>
              <rect x={x - stemW / 2} y={top} width={stemW} height={Math.max(0, by - top)} className={ghost ? 'pbn-ghost' : 'pbn-stem'} />
              <circle cx={x} cy={by} r={ballR} className={ghost ? 'pbn-ghost' : 'pbn-ball'} />
            </>}
      </g>,
    )
  }
  // WO-2182: what the top view draws, for the Angle label to keep off.
  const topCircles: Array<{ x: number; y: number; r: number }> = []
  const topSegs: Array<[number, number, number, number]> = []
  const probeTop = (p: P3, kind: 'real' | 'outline' | 'preview', keyName: string) => {
    topCircles.push({ x: tx(p.x), y: ty(p.y), r: topR + 2 })
    if (kind === 'preview') {
      tc.push(<circle key={keyName} cx={tx(p.x)} cy={ty(p.y)} r={topR} fill={C.preview} fillOpacity={0.28} stroke={C.preview} strokeWidth={4} data-testid="probe-top-preview" />)
      return
    }
    tc.push(<circle key={keyName} cx={tx(p.x)} cy={ty(p.y)} r={topR} className={kind === 'outline' ? 'pbn-ghost' : 'pbn-ball'} data-testid={kind === 'outline' ? 'probe-top-ghost' : 'probe-top-probe'} />)
  }

  const sideMoves = m !== null && (Math.abs(u(m.to, step.view) - u(m.from, step.view)) > 1e-6 || Math.abs(m.to.z - m.from.z) > 1e-6)
  const topMoves = m !== null && (Math.abs(m.to.x - m.from.x) > 1e-6 || Math.abs(m.to.y - m.from.y) > 1e-6)
  const verticalMove = m !== null && Math.abs(m.to.z - m.from.z) > 1e-6

  // The faded outline where the current move started - running, where the
  // STEP started: it stays put for the whole step (Operator 09-27, Edge: the
  // outline swapped sides at every back-off).
  const outlineAt: P3 | null = m ? (mode === 'running' ? moves[0].from : m.from) : null
  const outlineShaftHidden = outlineAt !== null && pos !== null && Math.abs(sx(u(pos, step.view)) - sx(u(outlineAt, step.view))) < ballR
  if (mode === 'running') {
    if (outlineAt && pos && Math.hypot(sx(u(pos, step.view)) - sx(u(outlineAt, step.view)), sz(pos.z) - sz(outlineAt.z)) > 2) probeSide(outlineAt, 'outline', 'ghost')
  } else if (m && sideMoves && (!verticalMove || scene.tool)) probeSide(m.from, 'outline', 'ghost')
  // Where a beside arrow sits (the distance words keep off it).
  const arrowBoxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = []
  if (m && pos && sideMoves) {
    const a = { x: sx(u(pos, step.view)), y: ballY(pos.z) }
    const b = { x: sx(u(m.to, step.view)), y: ballY(m.to.z) }
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len > 1e-6) {
      const ux = (b.x - a.x) / len
      const uy = (b.y - a.y) / len
      // From the ball's edge to the target centre.
      const x1 = a.x + ux * (ballR + 6)
      const y1 = a.y + uy * (ballR + 6)
      if (Math.hypot(b.x - x1, b.y - y1) > 10 && (b.x - x1) * ux + (b.y - y1) * uy > 0) {
        side.push(<Arrow key="path" x1={x1} y1={y1} x2={b.x} y2={b.y} color={C.move} dashed={m.kind === 'probe'} testId="probe-move-side" />)
      } else if (besideShort) {
        // Centred on the true path, one probe's width off it: under a
        // sideways move (over it at the view's foot), right of a vertical one
        // (left at the view's edge).
        const L = Math.max(MIN_ARROW, len)
        const off = Math.max(ballR, stemW / 2) + 20
        const across = Math.abs(ux) >= Math.abs(uy)
        const cx = (a.x + b.x) / 2 + (across ? 0 : (a.x + off + HEAD > sideW ? -off : off))
        const cy = (a.y + b.y) / 2 + (across ? (a.y + off + HEAD > sideH ? -off : off) : 0)
        const ax1 = cx - (ux * L) / 2
        const ay1 = cy - (uy * L) / 2
        const ax2 = cx + (ux * L) / 2
        const ay2 = cy + (uy * L) / 2
        side.push(<Arrow key="path" x1={ax1} y1={ay1} x2={ax2} y2={ay2} color={C.move} dashed={m.kind === 'probe'} testId="probe-move-side" beside />)
        arrowBoxes.push({ x0: Math.min(ax1, ax2) - HEAD, x1: Math.max(ax1, ax2) + HEAD, y0: Math.min(ay1, ay2) - HEAD, y1: Math.max(ay1, ay2) + HEAD })
      }
    }
  }
  if (ghostAt) {
    probeSide(drawnAt, 'real', 'probe-real')
    probeSide(ghostAt, 'preview', 'probe-preview')
  } else {
    probeSide(drawnSide, 'real', 'probe-real')
  }
  // A vertical move's start outline goes on top, so the shaft does not hide it.
  if (outlineAt && !scene.tool && (mode === 'running' ? outlineShaftHidden && pos !== null && Math.abs(pos.z - outlineAt.z) * F.k > 2 : verticalMove)) {
    side.push(
      <circle key="ghost-v" cx={sx(u(outlineAt, step.view))} cy={ballY(outlineAt.z)} r={ballR} fill="var(--surface-1)" fillOpacity={0.55}
        stroke={C.text} strokeWidth={3} strokeDasharray="6 5" opacity={0.85} data-testid="probe-side-ghost" />,
    )
  }
  // In the preview the REAL probe is drawn last: it is where the machine is,
  // and it has not moved.
  if (ghostAt) {
    const x = sx(u(realAt, step.view))
    const by = ballY(drawnAt.z)
    if (!scene.tool) side.push(<circle key="probe-real-top" cx={x} cy={by} r={ballR} className="pbn-ball" />)
  }

  // Touches: lit (found) and, in the preview, hollow rings.
  const touchY = (p: P3) => (Math.abs(p.z) < 1e-6 && step.moves.some((mm) => mm.touches && moveAxis(mm) === 'Z') ? sz(0) : ballY(p.z))
  for (const [i, f] of lit.entries()) {
    if (Math.abs(w(f, step.view) - other) > 0.5) continue
    side.push(<circle key={`lit${i}`} cx={sx(u(f, step.view))} cy={f.z === 0 ? sz(0) : touchY(f)} r={11} fill={C.touch} data-testid={f === step.touch ? 'probe-touch-lit' : 'probe-found-side'} />)
  }
  for (const [i, f] of rings.entries()) {
    // A touch off the cut (a Y wall in an X-Z view) shows in the top view only.
    if (Math.abs(w(f, step.view) - other) > 0.5) continue
    side.push(<circle key={`ring${i}`} cx={sx(u(f, step.view))} cy={f.z === 0 ? sz(0) : touchY(f)} r={11} fill="none" stroke={C.touch} strokeWidth={3} data-testid="probe-touch-ring" />)
  }

  // The ONE distance, in clear air beside its path; it counts down.
  if (m && pos) {
    // A move drawn to a schematic length (Tool Z's setter trip) counts the
    // machine's real distance down.
    // WO-2115: a search from the operator's start is drawn over its whole
    // search while it runs; it counts down the search left ("Z- up to 12 mm").
    const startSearch = mode === 'running' ? startSearchMm(scene, m) : null
    const realMm = m.machineMm ?? startSearch ?? undefined
    const rem = realMm !== undefined
      ? realMm * (moveLength(m) > 1e-9 ? moveLength({ ...m, from: pos }) / moveLength(m) : 0)
      : moveLength({ ...m, from: pos })
    // The move's own axis and sign; the distance still to go (near the end the
    // remainder alone has no direction to read an axis from).
    // WO-2108: before the run the top search is labelled with how far it may
    // search ("Z- up to 25 mm") - the start is any height below that.
    const searchMm = m.searchLabel && mode !== 'running' ? m.searchMm : undefined
    const txt = searchMm !== undefined
      ? moveLabel(m, () => `up to ${Number(searchMm.toFixed(1))} mm`)
      : startSearch !== null
        ? moveLabel(m, () => `up to ${Number(rem.toFixed(1))} mm`)
        : moveLabel(m, () => `${Number(rem.toFixed(1))} mm`)
    const tw = textW(txt, TEXT)
    const px = sx(u(pos, step.view))
    const py = ballY(pos.z)
    // What the words keep off: the height lines, each probe drawn (its shaft
    // and its ball), and the edges of the side view. The nearest clear place
    // beside the path wins.
    type Box = { x0: number; x1: number; y0: number; y1: number }
    const keepOff: Box[] = []
    for (const p of [realAt, ...(ghostAt ? [ghostAt] : [])]) {
      const x = sx(u(p, step.view))
      const by = ballY(p.z)
      keepOff.push({ x0: x - Math.max(stemW / 2, ballR) - 6, x1: x + Math.max(stemW / 2, ballR) + 6, y0: 0, y1: by + ballR + 4 })
    }
    for (const h of heightYs) keepOff.push({ x0: -1e6, x1: 1e6, y0: h - 3, y1: h + 3 })
    keepOff.push(...arrowBoxes)
    // The part itself: its material, less the open air of a hole in it.
    const partBox = (p: { a: number; b: number; bottom: number; top: number }): Box => ({ x0: sx(p.a), x1: sx(p.b), y0: sz(p.top), y1: sz(p.bottom) })
    const solid = pieces.filter((p) => !p.cut).map(partBox)
    const open = pieces.filter((p) => p.cut).map(partBox)
    const overlap = (bx: Box, k: Box) => Math.max(0, Math.min(bx.x1, k.x1) - Math.max(bx.x0, k.x0)) * Math.max(0, Math.min(bx.y1, k.y1) - Math.max(bx.y0, k.y0))
    const hits = (bx: Box) => keepOff.reduce((c, k) => c + overlap(bx, k), 0)
      + Math.max(0, solid.reduce((c, k) => c + overlap(bx, k), 0) - open.reduce((c, k) => c + overlap(bx, k), 0))
      + (Math.max(0, -bx.x0) + Math.max(0, bx.x1 - sideW) + Math.max(0, CAP_BAND - bx.y0) + Math.max(0, bx.y1 - sideH)) * 400
    const boxOf = (x: number, y: number, a: 'start' | 'middle' | 'end'): Box => {
      const x0 = a === 'start' ? x : a === 'end' ? x - tw : x - tw / 2
      return { x0: x0 - 6, x1: x0 + tw + 6, y0: y - TEXT + 2, y1: y + 10 }
    }
    const tries: Array<{ x: number; y: number; a: 'start' | 'middle' | 'end' }> = []
    if (verticalMove) {
      // Beside the path, level with its middle, then up and down from there.
      const mid = (py + ballY(m.to.z)) / 2 + 10
      for (const d of [0, 24, -24, 48, -48, 72, -72, 96, -96, 130, -130]) {
        tries.push({ x: px + ballR + 18, y: mid + d, a: 'start' })
        tries.push({ x: px - ballR - 18, y: mid + d, a: 'end' })
      }
    } else {
      // Under the path, else over it; along it from its middle toward its end.
      const end = sideMoves ? sx(u(m.to, step.view)) : px
      const mid = (px + end) / 2
      const row = TEXT + 12
      const dir = end >= px ? 1 : -1
      const clampX = (x: number) => Math.max(tw / 2 + 10, Math.min(sideW - tw / 2 - 10, x))
      const alongRow = (y: number) => {
        for (const x of [mid, end, (mid + end) / 2 + (end - px) * 0.25, px + dir * (tw / 2 + ballR + 12)]) tries.push({ x: clampX(x), y, a: 'middle' })
      }
      alongRow(py + ballR + 38)
      alongRow(py - ballR - 18)
      // Level with the path: past its head, else behind the probe.
      tries.push({ x: clampX(end + dir * (tw / 2 + 24)), y: py + 10, a: 'middle' })
      tries.push({ x: clampX(px - dir * (tw / 2 + ballR + 18)), y: py + 10, a: 'middle' })
      for (const y of [py + ballR + 38 + row, py - ballR - 18 - row, py + ballR + 38 + 2 * row, py - ballR - 18 - 2 * row]) alongRow(y)
    }
    let spot = tries[0]
    let best = Infinity
    for (const t of tries) {
      const c = hits(boxOf(t.x, t.y, t.a))
      if (c < best - 1e-6) { best = c; spot = t }
      if (c === 0) break
    }
    const lx = spot.x
    const ly = spot.y
    const anchor = spot.a
    const bx = anchor === 'start' ? lx : anchor === 'end' ? lx - tw : lx - tw / 2
    side.push(
      <g key="dist" data-testid="probe-move-distance" data-remaining={rem.toFixed(3)}>
        <rect x={bx - 6} y={ly - TEXT + 2} width={tw + 12} height={TEXT + 8} rx={5} className="pbn-bg" opacity={0.9} />
        <text x={lx} y={ly} textAnchor={anchor} fontSize={TEXT} fontWeight={700} fill={C.text} data-testid="probe-move-label">{txt}</text>
      </g>,
    )
  }

  // The strip across the top of the side view: which it is. On a narrow
  // side view (1440 x 900) it breaks after "BEFORE START".
  if (caption) {
    const color = mode === 'preview' ? C.you : C.running
    const parts = capLines > 1 && caption.includes(' - ') ? caption.split(' - ') : [caption]
    const capH = CAP_H + (parts.length - 1) * 32
    side.push(
      <g key="caption" data-testid="probe-caption">
        <rect x={0} y={0} width={sideW} height={capH} className="pbn-bg" opacity={0.92} />
        <line x1={0} y1={capH} x2={sideW} y2={capH} stroke={color} strokeWidth={3} />
        {parts.map((t, i) => <text key={t} x={16} y={33 + i * 32} fontSize={CAP_TEXT} fontWeight={700} fill={color}>{t}</text>)}
      </g>,
    )
  }

  // ---- top view --------------------------------------------------------------
  const topFrameRect = <rect key="tbg" x={topX} y={0} width={topW} height={topH} rx={6} className="pbn-bg" stroke={C.frame} strokeWidth={2} />
  scene.shapes.forEach((s, i) => {
    const cls = s.cut ? 'pbn-bg pbn-cut' : 'control-probe-diagram-stock'
    if (scene.tool && i === 1 && s.kind === 'circle') {
      // WO-2180: Tool Z's setter - round, in the gold of a round feature's rim
      // (the Bore / Boss ring), as its front-view profile is.
      tc.push(<circle key={`ts${i}`} cx={tx(s.cx)} cy={ty(s.cy)} r={s.r * TF.k} className="pbn-setter" stroke={C.touch} strokeWidth={6} data-testid="probe-top-setter" />)
    } else if (s.kind === 'rect') {
      tc.push(<rect key={`ts${i}`} x={tx(s.x0)} y={ty(s.y1)} width={(s.x1 - s.x0) * TF.k} height={(s.y1 - s.y0) * TF.k} className={cls} />)
    } else if (s.kind === 'poly') {
      tc.push(<polygon key={`ts${i}`} points={s.pts.map((p) => `${tx(p.x)},${ty(p.y)}`).join(' ')} className={cls} data-testid="probe-top-part" />)
    } else {
      tc.push(<circle key={`ts${i}`} cx={tx(s.cx)} cy={ty(s.cy)} r={s.r * TF.k} className={cls} />)
    }
  })
  // The faces the routine touches, in the touch colour: a round feature's
  // whole rim (the Bore video); a straight face, this step's (every face the
  // routine touches, on a YOU step). A Z touch (the top, a setter) lights none.
  const sideTouch = (s: ProbeStep) => s.touch !== null && s.moves.some((mm) => mm.kind === 'probe' && moveAxis(mm) !== 'Z')
  const roundShape = scene.shapes.find((s) => s.kind === 'circle')
  // A rectangular feature (Rect pocket, Rect boss): its own outline, as the
  // bore's rim - never lines across the whole view.
  const rectShape = scene.partDim?.kind === 'rect' ? scene.shapes.find((s) => s.kind === 'rect' && (s.cut || scene.shapes.length === 1)) : undefined
  // WO-2182 (Operator 09-29: "You should show it angled or it is unclear what we
  // are actually doing"): what Angle marks from above, as his UCCNC reference
  // does - its part is drawn with the face at an angle; here, in px, the two
  // touch points on it, the line through them, the square axis from point 1
  // and the arc between the two.
  const angle = scene.angle ? (() => {
    const [p1, p2] = scene.angle!.points
    const a = { x: tx(p1.x), y: ty(p1.y) }
    const b = { x: tx(p2.x), y: ty(p2.y) }
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1) return null
    const along = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
    const sq = scene.angle!.nominalAxis === 'X' ? { x: Math.sign(b.x - a.x) || 1, y: 0 } : { x: 0, y: Math.sign(b.y - a.y) || -1 }
    const cos = along.x * sq.x + along.y * sq.y
    const before = Math.max(12, len * 0.1)
    const after = Math.max(24, len * 0.2)
    const reach = (len + after) * cos
    const r = Math.max(40, Math.min(240, len * 0.8))
    // The open air beside the square line: away from the part.
    const foot = { x: a.x + sq.x * len * cos, y: a.y + sq.y * len * cos }
    const gap = Math.hypot(b.x - foot.x, b.y - foot.y)
    return {
      a, b, len, sq, r,
      face: [a.x - along.x * before, a.y - along.y * before, b.x + along.x * after, b.y + along.y * after] as [number, number, number, number],
      square: [a.x - sq.x * before, a.y - sq.y * before, a.x + sq.x * reach, a.y + sq.y * reach] as [number, number, number, number],
      cross: sq.x * along.y - sq.y * along.x,
      arcFrom: { x: a.x + sq.x * r, y: a.y + sq.y * r },
      arcTo: { x: a.x + along.x * r, y: a.y + along.y * r },
      air: gap > 1e-6 ? { x: (foot.x - b.x) / gap, y: (foot.y - b.y) / gap } : { x: -sq.y, y: sq.x },
    }
  })() : null
  // What the zone's dimension keeps off in this view (WO-2179): the faces drawn.
  const faceHits: Array<(a: Area) => boolean> = []
  const thin = (x0: number, y0: number, x1: number, y1: number) => { const b = { x0: x0 - 3, x1: x1 + 3, y0: y0 - 3, y1: y1 + 3 }; faceHits.push((a) => areaOverlap(a, b) > 0) }
  if (roundShape && roundShape.kind === 'circle' && scene.steps.some(sideTouch)) {
    tc.push(<circle key="lit-rim" cx={tx(roundShape.cx)} cy={ty(roundShape.cy)} r={roundShape.r * TF.k} fill="none" stroke={C.touch} strokeWidth={6} data-testid="probe-top-face" />)
    faceHits.push((a) => touchesRing(a, tx(roundShape.cx), ty(roundShape.cy), roundShape.r * TF.k, 3))
  } else if (rectShape && rectShape.kind === 'rect') {
    tc.push(<rect key="lit-rect" x={tx(rectShape.x0)} y={ty(rectShape.y1)} width={(rectShape.x1 - rectShape.x0) * TF.k} height={(rectShape.y1 - rectShape.y0) * TF.k} fill="none" stroke={C.touch} strokeWidth={6} data-testid="probe-top-face" />)
    const [l, r, t, b] = [tx(rectShape.x0), tx(rectShape.x1), ty(rectShape.y1), ty(rectShape.y0)]
    thin(l, t, r, t); thin(l, b, r, b); thin(l, t, l, b); thin(r, t, r, b)
  } else if (angle) {
    // WO-2182: every Angle step - the square axis dashed from point 1, the
    // line through the two touch points (the face, in the touch colour), the
    // angle between them and both points.
    const sweep = angle.cross > 0 ? 1 : 0
    tc.push(
      <g key="angle" data-testid="probe-top-angle">
        <line x1={angle.square[0]} y1={angle.square[1]} x2={angle.square[2]} y2={angle.square[3]} stroke={C.text} strokeWidth={3} strokeDasharray="12 9" data-testid="probe-top-angle-square" />
        <line x1={angle.face[0]} y1={angle.face[1]} x2={angle.face[2]} y2={angle.face[3]} stroke={C.touch} strokeWidth={6} data-testid="probe-top-face" />
        <path d={`M ${angle.arcFrom.x} ${angle.arcFrom.y} A ${angle.r} ${angle.r} 0 0 ${sweep} ${angle.arcTo.x} ${angle.arcTo.y}`} fill="none" stroke={C.text} strokeWidth={3} data-testid="probe-top-angle-arc" />
        {[angle.a, angle.b].map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={ANGLE_POINT_R} className="pbn-bg" stroke={C.touch} strokeWidth={3} data-testid="probe-top-angle-point" />
        ))}
      </g>,
    )
    const [f0, f1, f2, f3] = angle.face
    const [s0, s1, s2, s3] = angle.square
    thin(Math.min(f0, f2), Math.min(f1, f3), Math.max(f0, f2), Math.max(f1, f3))
    thin(Math.min(s0, s2), Math.min(s1, s3), Math.max(s0, s2), Math.max(s1, s3))
    thin(Math.min(angle.arcFrom.x, angle.arcTo.x), Math.min(angle.arcFrom.y, angle.arcTo.y), Math.max(angle.arcFrom.x, angle.arcTo.x), Math.max(angle.arcFrom.y, angle.arcTo.y))
    for (const p of [angle.a, angle.b]) {
      const c = { x0: p.x - ANGLE_POINT_R - 2, x1: p.x + ANGLE_POINT_R + 2, y0: p.y - ANGLE_POINT_R - 2, y1: p.y + ANGLE_POINT_R + 2 }
      faceHits.push((a) => areaOverlap(a, c) > 0)
    }
  } else {
    const faces = step.touch ? (sideTouch(step) ? [step] : []) : step.owner === 'you' ? scene.steps.filter(sideTouch) : []
    faces.forEach((s, i) => {
      const p = s.touch!
      const probeMove = s.moves.find((mm) => mm.kind === 'probe' && moveAxis(mm) !== 'Z')
      const faceAxis = probeMove ? moveAxis(probeMove) : 'X'
      if (faceAxis === 'X') tc.push(<line key={`lit${i}`} x1={tx(p.x)} y1={0} x2={tx(p.x)} y2={topH} stroke={C.touch} strokeWidth={6} data-testid="probe-top-face" />)
      else tc.push(<line key={`lit${i}`} x1={topX} y1={ty(p.y)} x2={topX + topW} y2={ty(p.y)} stroke={C.touch} strokeWidth={6} data-testid="probe-top-face" />)
      if (faceAxis === 'X') thin(tx(p.x), 0, tx(p.x), topH)
      else thin(topX, ty(p.y), topX + topW, ty(p.y))
    })
  }
  const topWords: ReactNode[] = []
  if (scene.partDim) {
    topWords.push(<text key="tpdim" x={topX + topW - 12} y={34} textAnchor="end" fontSize={DIM_TEXT} fontWeight={700} fill={C.text} data-testid="probe-top-part-dim">{scene.partDim.label}</text>)
  }
  if (zone) {
    if (zone.round) {
      const r = (zone.x1 - zone.x0) / 2
      tc.push(<circle key="tzone" cx={tx((zone.x0 + zone.x1) / 2)} cy={ty((zone.y0 + zone.y1) / 2)} r={r * TF.k} className="pbn-zone" data-testid="probe-top-zone" />)
    } else {
      tc.push(<rect key="tzone" x={tx(zone.x0)} y={ty(zone.y1)} width={(zone.x1 - zone.x0) * TF.k} height={(zone.y1 - zone.y0) * TF.k} className="pbn-zone" data-testid="probe-top-zone" />)
    }
  }
  const mesh = scene.mesh && scene.mesh.points.length ? scene.mesh : null
  if (mesh) {
    // WO-2184 (Operator 09-29): Z surface draws its whole grid on every step - the
    // program's cutting area, the area measured, the route the machine takes
    // (row by row, each row back), and every point: waiting (grey), touched
    // (lit), or after a run its measured height (the Main viewer's colours).
    // The point this step is at is ringed.
    const pts = mesh.points
    const gap = (a: number[]) => {
      const s = [...new Set(a.map((v) => Number(v.toFixed(4))))].sort((p, q) => p - q)
      let g = Infinity
      for (let i = 1; i < s.length; i++) g = Math.min(g, s[i] - s[i - 1])
      return g
    }
    const pitch = Math.min(gap(pts.map((p) => p.x)), gap(pts.map((p) => p.y))) * TF.k
    const r = Math.max(2.5, Math.min(MESH_DOT_R, Number.isFinite(pitch) ? pitch * 0.3 : MESH_DOT_R))
    const key = (p: { x: number; y: number }) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`
    const touchedKeys = new Set([...step.found, ...(touched && step.touch ? [step.touch] : [])].map(key))
    const heights = mode !== 'running' ? mesh.heights : null
    const lo = heights ? Math.min(...heights) : 0
    const hi = heights ? Math.max(...heights) : 0
    if (mesh.cut) {
      const c = mesh.cut
      tc.push(<rect key="tmcut" x={tx(c.minX)} y={ty(c.maxY)} width={(c.maxX - c.minX) * TF.k} height={(c.maxY - c.minY) * TF.k} fill="none" stroke={C.text} strokeOpacity={0.55} strokeWidth={2} data-testid="probe-top-mesh-cut" />)
    }
    const [ax, bx, ay, by] = [Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y))]
    const around = r + 5
    // The start zone (step 1) is the same area: drawn once.
    if (!zone) tc.push(<rect key="tmarea" x={tx(ax) - around} y={ty(by) - around} width={(bx - ax) * TF.k + 2 * around} height={(by - ay) * TF.k + 2 * around} rx={4} fill="none" stroke={C.dim} strokeWidth={2} strokeDasharray="8 6" data-testid="probe-top-mesh-area" />)
    tc.push(<polyline key="tmroute" points={pts.map((p) => `${tx(p.x)},${ty(p.y)}`).join(' ')} fill="none" stroke={C.dim} strokeOpacity={0.6} strokeWidth={2} data-testid="probe-top-mesh-route" />)
    pts.forEach((p, i) => {
      const state = heights ? 'height' : touchedKeys.has(key(p)) ? 'touched' : 'waiting'
      const fill = heights ? meshHeightColor(hi - lo > 1e-9 ? (heights[i] - lo) / (hi - lo) : 0.5) : state === 'touched' ? C.touch : C.dim
      tc.push(
        <circle key={`tm${i}`} cx={tx(p.x)} cy={ty(p.y)} r={r} fill={fill} fillOpacity={state === 'waiting' ? 0.8 : 1}
          data-testid="probe-top-mesh-point" data-order={i + 1} data-state={state} data-height={heights ? heights[i].toFixed(4) : undefined} />,
      )
    })
    const cur = mode !== 'after' && step.point !== undefined ? pts[step.point - 1] : undefined
    if (cur) {
      tc.push(<circle key="tmcur" cx={tx(cur.x)} cy={ty(cur.y)} r={r + 6} fill="none" stroke={C.text} strokeWidth={3} strokeDasharray="5 4" data-testid="probe-top-mesh-current" data-order={step.point} />)
    }
  } else {
    for (const [i, f] of rings.entries()) tc.push(<circle key={`tring${i}`} cx={tx(f.x)} cy={ty(f.y)} r={10} fill="none" stroke={C.touch} strokeWidth={3} data-testid="probe-top-ring" />)
    for (const [i, f] of lit.entries()) tc.push(<circle key={`tf${i}`} cx={tx(f.x)} cy={ty(f.y)} r={10} fill={C.touch} data-testid="probe-found-top" />)
    for (const f of [...rings, ...lit]) topCircles.push({ x: tx(f.x), y: ty(f.y), r: 12 })
  }
  // Running, the step's start outline stays put from above too.
  if (mode === 'running' && outlineAt && pos && Math.hypot(pos.x - outlineAt.x, pos.y - outlineAt.y) * TF.k > 2) probeTop(outlineAt, 'outline', 'tghost')
  // The one current move, seen from above.
  if (m && pos && topMoves) {
    if (mode !== 'running') probeTop(m.from, 'outline', 'tghost')
    const dx = m.to.x - pos.x
    const dy = m.to.y - pos.y
    const len = Math.hypot(dx, dy)
    if (len > 1e-6) {
      const ux = dx / len
      const uy = dy / len
      const x1 = tx(pos.x) + ux * (topR + 5)
      const y1 = ty(pos.y) - uy * (topR + 5)
      if ((tx(m.to.x) - x1) * ux - (ty(m.to.y) - y1) * uy > 4) {
        tc.push(<Arrow key="tpath" x1={x1} y1={y1} x2={tx(m.to.x)} y2={ty(m.to.y)} color={C.move} dashed={m.kind === 'probe'} testId="probe-move-top" />)
        topSegs.push([x1, y1, tx(m.to.x), ty(m.to.y)])
      } else if (besideShort) {
        // Too short for the probe's own path: full size, beside it (under a
        // sideways move, right of a Y move; the other side at the view's edge).
        const L = Math.max(MIN_ARROW, len * TF.k)
        const off = topR + 18
        const across = Math.abs(ux) >= Math.abs(uy)
        const mx = (tx(pos.x) + tx(m.to.x)) / 2
        const my = (ty(pos.y) + ty(m.to.y)) / 2
        const cx = mx + (across ? 0 : (mx + off + HEAD > topX + topW ? -off : off))
        const cy = my + (across ? (my + off + HEAD > topH ? -off : off) : 0)
        tc.push(<Arrow key="tpath" x1={cx - (ux * L) / 2} y1={cy + (uy * L) / 2} x2={cx + (ux * L) / 2} y2={cy - (uy * L) / 2} color={C.move} dashed={m.kind === 'probe'} testId="probe-move-top" beside />)
        topSegs.push([cx - (ux * L) / 2, cy + (uy * L) / 2, cx + (ux * L) / 2, cy - (uy * L) / 2])
      }
    }
  }
  probeTop(realTop, 'real', 'tprobe')
  if (ghostAt) {
    probeTop(ghostAt, 'preview', 'tpreview')
  }

  // The X/Y marker: in a corner clear of the part and of the probe.
  const corners = [
    { x: topX + 22, y: topH - 16 },
    { x: topX + topW - 90, y: topH - 16 },
    { x: topX + 22, y: 74 },
    { x: topX + topW - 90, y: 74 },
  ]
  const toMm = (px: number, py: number) => ({ x: (px - topX) / TF.k + TF.x0, y: TF.y1 - py / TF.k })
  const probes = [realAt, ...(ghostAt ? [ghostAt] : []), ...(moves.length ? [moves[0].from, moves.at(-1)!.to] : [])]
  // WO-2184: Z surface keeps its left band for the marker (the grid is drawn clear of it).
  const clearCorner = mesh ? corners[0] : corners.find((c) => {
    for (const [dx, dy] of [[10, -10], [40, -10], [10, -40], [40, -40], [25, -25]]) {
      const mm = toMm(c.x + dx, c.y + dy)
      if (insideMaterial(scene.shapes, mm.x, mm.y)) return false
      for (const p of probes) if (Math.hypot(tx(p.x) - (c.x + dx), ty(p.y) - (c.y + dy)) < topR + 12) return false
    }
    return true
  }) ?? corners[0]
  const ax0 = clearCorner.x
  const ay0 = clearCorner.y
  const axisMark = (
    <g key="axes" data-testid="probe-top-axes">
      <Arrow x1={ax0} y1={ay0} x2={ax0 + 44} y2={ay0} color={AXIS_COLOR.X} dashed={false} />
      <text x={ax0 + 50} y={ay0 + 9} fontSize={TOP_TEXT} fontWeight={700} fill={AXIS_COLOR.X}>X</text>
      <Arrow x1={ax0} y1={ay0} x2={ax0} y2={ay0 - 44} color={AXIS_COLOR.Y} dashed={false} />
      <text x={ax0 + 10} y={ay0 - 34} fontSize={TOP_TEXT} fontWeight={700} fill={AXIS_COLOR.Y}>Y</text>
    </g>
  )

  // The zone's width from above (WO-2179): where it always was when that
  // touches nothing - not the zone, the probe, the part's edges or its faces,
  // the X/Y marker or the feature's size; else level with its line, beside
  // it, as near as it fits, the line running on to the number. Every width
  // main drew is still drawn (architect 09-29: make them fit, never drop).
  // WO-2182: where the zone's width went (the Angle label keeps off it).
  const zoneMarks: Area[] = []
  if (zone?.dim) {
    const d = zone.dim
    const SIZE = TOP_TEXT
    const zr = ((zone.x1 - zone.x0) / 2) * TF.k
    const zoneBox: Area = zone.round
      ? { x0: tx((zone.x0 + zone.x1) / 2) - zr, x1: tx((zone.x0 + zone.x1) / 2) + zr, y0: ty((zone.y0 + zone.y1) / 2) - zr, y1: ty((zone.y0 + zone.y1) / 2) + zr }
      : { x0: tx(zone.x0), x1: tx(zone.x1), y0: ty(zone.y1), y1: ty(zone.y0) }
    const keepTop: Area[] = [
      zoneBox,
      { x0: tx(realTop.x) - topR, x1: tx(realTop.x) + topR, y0: ty(realTop.y) - topR, y1: ty(realTop.y) + topR },
      { x0: ax0 - 16, x1: ax0 + 68, y0: ay0 - 58, y1: ay0 + 16 },
    ]
    if (scene.partDim) keepTop.push(textArea(topX + topW - 12, 34, 'end', scene.partDim.label, DIM_TEXT, 0))
    // The stock's flat face is background here (as the "Ø 25" in the corner);
    // only the part's edges are kept clear.
    const onEdge = (a: Area) => scene.shapes.some((s) => {
      if (s.kind === 'circle') return touchesRing(a, tx(s.cx), ty(s.cy), s.r * TF.k, 3)
      if (s.kind === 'poly') return s.pts.some((p, i) => { const q = s.pts[(i + 1) % s.pts.length]; return segmentHitsArea(a, tx(p.x), ty(p.y), tx(q.x), ty(q.y), 3) })
      const [l, r, t, b] = [tx(s.x0), tx(s.x1), ty(s.y1), ty(s.y0)]
      return [[l, t, r, t], [l, b, r, b], [l, t, l, b], [r, t, r, b]].some(([x0, y0, x1, y1]) => areaOverlap(a, { x0: x0 - 3, x1: x1 + 3, y0: y0 - 3, y1: y1 + 3 }) > 0)
    })
    const fitsTop = (a: Area) => a.x0 >= topX + 4 && a.x1 <= topX + topW - 4 && a.y0 >= 4 && a.y1 <= topH - 4
      && keepTop.every((k) => areaOverlap(a, k) === 0) && !faceHits.some((hit) => hit(a)) && !onEdge(a)
    const word = (x: number, y: number, anchor: 'start' | 'middle' | 'end') => (
      <text x={x} y={y} textAnchor={anchor} fontSize={SIZE} fontWeight={700} fill={C.you}>{d.label}</text>
    )
    /** The first place the number fits, nearest first. */
    const firstFit = <T extends { x: number; y: number; anchor: 'start' | 'middle' | 'end' }>(tries: T[]) =>
      tries.find((s) => fitsTop(textArea(s.x, s.y, s.anchor, d.label, SIZE))) ?? null
    const STEPS = Array.from({ length: 60 }, (_, k) => k * 8)
    if (d.axis === 'X') {
      // Above the zone when there is room, else inside its top edge.
      const above = ty(zone.y1) - 12
      const y = above - 14 - DIM_TEXT >= 0 ? above : Math.max(ty(zone.y1), 0) + 44
      const xa = tx(d.from)
      const xb = tx(d.to)
      if (fitsTop(textArea((xa + xb) / 2, y - 14, 'middle', d.label, SIZE))) {
        topWords.push(<DimH key="tzdim" xa={xa} xb={xb} y={y} label={d.label} color={C.you} testId="probe-top-zone-dim" size={SIZE} />)
        zoneMarks.push(textArea((xa + xb) / 2, y - 14, 'middle', d.label, SIZE, 0), { x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: y - 12, y1: y + 12 })
      } else {
        // Level with the line, beside it: on that row, across the zone's
        // middle, or under the zone.
        const lo = Math.min(xa, xb)
        const hi = Math.max(xa, xb)
        const rows = [y, ty((zone.y0 + zone.y1) / 2), ty(Math.min(zone.y0, zone.y1)) + 12]
        const at = firstFit(STEPS.flatMap((s) => rows.flatMap((row) => [
          { x: hi + 16 + s, y: row + 8, anchor: 'start' as const, row },
          { x: lo - 16 - s, y: row + 8, anchor: 'end' as const, row },
        ])))
        if (at) {
          const reach = at.anchor === 'start' ? at.x - 8 : at.x + 8
          topWords.push(
            <g key="tzdim" data-testid="probe-top-zone-dim">
              <line x1={Math.min(lo, reach)} y1={at.row} x2={Math.max(hi, reach)} y2={at.row} stroke={C.you} strokeWidth={3} />
              <line x1={xa} y1={at.row - 12} x2={xa} y2={at.row + 12} stroke={C.you} strokeWidth={3} />
              <line x1={xb} y1={at.row - 12} x2={xb} y2={at.row + 12} stroke={C.you} strokeWidth={3} />
              {word(at.x, at.y, at.anchor)}
            </g>,
          )
          zoneMarks.push(textArea(at.x, at.y, at.anchor, d.label, SIZE, 0), { x0: Math.min(lo, reach), x1: Math.max(hi, reach), y0: at.row - 12, y1: at.row + 12 })
        }
      }
    } else {
      const x = Math.min(tx(zone.x1), topX + topW) - 34
      const ya = ty(d.from)
      const yb = ty(d.to)
      const mid = (ya + yb) / 2 + 9
      // Left of the line (where it always was), right of it, else past either
      // end of it, the line running on to the number.
      const at = firstFit(STEPS.flatMap((s) => [
        { x: x - 16 - s, y: mid, anchor: 'end' as const, lead: s > 0 ? x - 8 - s : null, end: null },
        { x: x + 16 + s, y: mid, anchor: 'start' as const, lead: x + 8 + s, end: null },
        { x, y: Math.max(ya, yb) + 26 + s, anchor: 'middle' as const, lead: null, end: s > 0 ? Math.max(ya, yb) + 5 + s : null },
        { x, y: Math.min(ya, yb) - 10 - s, anchor: 'middle' as const, lead: null, end: s > 0 ? Math.min(ya, yb) - 4 - s : null },
      ]))
      if (at) {
        topWords.push(
          <g key="tzdim" data-testid="probe-top-zone-dim">
            <line x1={x} y1={ya} x2={x} y2={yb} stroke={C.you} strokeWidth={3} />
            <line x1={x - 10} y1={ya} x2={x + 10} y2={ya} stroke={C.you} strokeWidth={3} />
            <line x1={x - 10} y1={yb} x2={x + 10} y2={yb} stroke={C.you} strokeWidth={3} />
            {at.lead !== null && <line x1={x} y1={mid - 9} x2={at.lead} y2={mid - 9} stroke={C.you} strokeWidth={3} />}
            {at.end !== null && <line x1={x} y1={at.end < ya && at.end < yb ? Math.min(ya, yb) : Math.max(ya, yb)} x2={x} y2={at.end} stroke={C.you} strokeWidth={3} />}
            {word(at.x, at.y, at.anchor)}
          </g>,
        )
        zoneMarks.push(textArea(at.x, at.y, at.anchor, d.label, SIZE, 0), { x0: x - 10, x1: x + 10, y0: Math.min(ya, yb, at.end ?? ya), y1: Math.max(ya, yb, at.end ?? yb) })
        if (at.lead !== null) zoneMarks.push({ x0: Math.min(x, at.lead), x1: Math.max(x, at.lead), y0: mid - 11, y1: mid - 7 })
      }
    }
  }

  // WO-2184: the grid's count ("5 x 5") and spacing ("6 x 4 mm") along the
  // top, each only where it touches nothing (Operator: simple dimensions that
  // fit; the longer words are the sentence's and "More about this step").
  if (mesh) {
    const placed: Area[] = [{ x0: ax0 - 16, x1: ax0 + 68, y0: ay0 - 58, y1: ay0 + 16 }]
    const clear = (a: Area) => a.x0 >= topX + 4 && a.x1 <= topX + topW - 4 && a.y0 >= 2 && a.y1 <= topH - 4
      && placed.every((k) => areaOverlap(a, k) === 0)
      && !topCircles.some((c) => areaOverlap(a, { x0: c.x - c.r, x1: c.x + c.r, y0: c.y - c.r, y1: c.y + c.r }) > 0)
      && !topSegs.some((sg) => segmentHitsArea(a, ...sg, HEAD * 0.6))
    for (const [text, x, anchor, id] of [
      [mesh.count, topX + 14, 'start', 'probe-top-mesh-count'],
      [mesh.spacing, topX + topW - 14, 'end', 'probe-top-mesh-spacing'],
    ] as const) {
      const a = textArea(x, 34, anchor, text, TOP_TEXT, 2)
      if (!clear(a)) continue
      placed.push(a)
      topWords.push(<text key={id} x={x} y={34} textAnchor={anchor} fontSize={TOP_TEXT} fontWeight={700} fill={C.text} data-testid={id}>{text}</text>)
    }
  }

  // WO-2182: the angle, named beside its arc where it touches nothing -
  // "angle" before a run, the angle measured after it ("0.73 deg"). A short
  // label (WO-2179, Operator 09-29: "don't be verbose"); the words are the
  // sentence's. In the open air first, else on the part's flat face.
  if (angle && scene.angle) {
    const v = scene.angle.measuredDeg
    const text = v === null ? 'angle' : `${Math.abs(v) < 0.005 ? '0.00' : v.toFixed(2)} deg`
    const SIZE = TOP_TEXT
    const keep: Area[] = [
      { x0: ax0 - 16, x1: ax0 + 68, y0: ay0 - 58, y1: ay0 + 16 },
      ...zoneMarks,
      ...topCircles.map((c) => ({ x0: c.x - c.r, x1: c.x + c.r, y0: c.y - c.r, y1: c.y + c.r })),
      ...[angle.a, angle.b].map((p) => ({ x0: p.x - ANGLE_POINT_R - 2, x1: p.x + ANGLE_POINT_R + 2, y0: p.y - ANGLE_POINT_R - 2, y1: p.y + ANGLE_POINT_R + 2 })),
    ]
    if (zone) keep.push({ x0: tx(zone.x0), x1: tx(zone.x1), y0: ty(zone.y1), y1: ty(zone.y0) })
    const t0 = Math.atan2(angle.arcFrom.y - angle.a.y, angle.arcFrom.x - angle.a.x)
    let dt = Math.atan2(angle.arcTo.y - angle.a.y, angle.arcTo.x - angle.a.x) - t0
    if (dt > Math.PI) dt -= 2 * Math.PI
    if (dt < -Math.PI) dt += 2 * Math.PI
    const arc = Array.from({ length: 13 }, (_, i) => ({ x: angle.a.x + angle.r * Math.cos(t0 + (dt * i) / 12), y: angle.a.y + angle.r * Math.sin(t0 + (dt * i) / 12) }))
    const edges = scene.shapes.flatMap((s) => (s.kind === 'poly' ? s.pts.map((p, i) => {
      const q = s.pts[(i + 1) % s.pts.length]
      return [tx(p.x), ty(p.y), tx(q.x), ty(q.y)] as [number, number, number, number]
    }) : []))
    const fits = (ar: Area, onPart: boolean) => ar.x0 >= topX + 4 && ar.x1 <= topX + topW - 4 && ar.y0 >= 4 && ar.y1 <= topH - 4
      && keep.every((k) => areaOverlap(ar, k) === 0)
      && !segmentHitsArea(ar, ...angle.face, 4) && !segmentHitsArea(ar, ...angle.square, 3)
      && !arc.slice(1).some((p, i) => segmentHitsArea(ar, arc[i].x, arc[i].y, p.x, p.y, 3))
      && !topSegs.some((sg) => segmentHitsArea(ar, ...sg, HEAD * 0.6))
      && !edges.some((e) => segmentHitsArea(ar, ...e, 3))
      && (onPart || !samples(ar).some(([X, Y]) => { const mm = toMm(X, Y); return insideMaterial(scene.shapes, mm.x, mm.y) }))
    const horizontal = Math.abs(angle.sq.x) > 0.5
    let at: { x: number; y: number; anchor: 'start' | 'middle' | 'end' } | null = null
    for (const side of [1, -1]) {
      const nx = angle.air.x * side
      const ny = angle.air.y * side
      for (const t of [angle.r, angle.r * 0.7, angle.r * 1.3, angle.len * 0.5, angle.len, angle.r * 0.4, angle.len * 1.15]) {
        for (const d of [12, 20, 30, 42, 56, 72, 90, 110]) {
          const px = angle.a.x + angle.sq.x * t + nx * d
          const py = angle.a.y + angle.sq.y * t + ny * d
          const spot = horizontal
            ? { x: px, y: ny > 0 ? py + SIZE * 0.8 : py - SIZE * 0.25, anchor: 'middle' as const }
            : { x: px, y: py + SIZE * 0.3, anchor: nx > 0 ? ('start' as const) : ('end' as const) }
          if (fits(textArea(spot.x, spot.y, spot.anchor, text, SIZE), side < 0)) { at = spot; break }
        }
        if (at) break
      }
      if (at) break
    }
    if (at) {
      topWords.push(
        <text key="tangle" x={at.x} y={at.y} textAnchor={at.anchor} fontSize={SIZE} fontWeight={700} fill={C.text} data-testid="probe-top-angle-label">{text}</text>,
      )
    }
  }

  return (
    <svg
      className="pbn-picture"
      data-testid="probe-picture"
      data-step={step.n}
      data-view={step.view}
      data-mode={mode}
      data-preview={previewPhase}
      data-move={current >= 0 ? current : undefined}
      data-moves={moves.length}
      data-real={`${realAt.x.toFixed(3)},${realAt.y.toFixed(3)},${realAt.z.toFixed(3)}`}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      xmlns="http://www.w3.org/2000/svg"
    >
      <clipPath id={`${clipId}-side`}><rect x={0} y={0} width={sideW} height={sideH} /></clipPath>
      <g data-testid="probe-side-view">
        <g clipPath={`url(#${clipId}-side)`}>{sideDrawing}</g>
        {heightMarks}
        <g clipPath={`url(#${clipId}-side)`}>{side}</g>
      </g>
      <g data-testid="probe-top-view">
        {topFrameRect}
        <clipPath id={clipId}><rect x={topX + 2} y={2} width={topW - 4} height={topH - 4} rx={5} /></clipPath>
        <g clipPath={`url(#${clipId})`}>{tc}</g>
        {topWords}
        {axisMark}
      </g>
    </svg>
  )
}

/** The distance still to go on the step's current move (mm). */
export function remainingMm(step: ProbeStep, progress: PictureProgress | null): number {
  if (!step.moves.length) return 0
  const i = progress ? Math.max(0, Math.min(step.moves.length - 1, progress.move)) : 0
  const t = progress ? Math.max(0, Math.min(1, progress.t)) : 0
  return moveLength(step.moves[i]) * (1 - t)
}
