import { textFor } from '../../../i18n'
const probeText = textFor('probing-screens')

// WO-2063 - the Probing screen's steps, built from the routine's own plan.
//
// docs/design/PROBING-SCREEN-V2.md, "One source of truth": the routine's setup
// fields are the ONLY numbers the pictures use, and the pictures are drawn from
// the routine's plan (the real moves, in millimetres), never hand-drawn per
// setting. So this module plans the routine with the production planner
// (planFeatureProbeCycle - the same call the Start probing button runs) and walks
// that plan into the one-step-at-a-time list the screen shows: who acts, the
// sentence, where the probe starts and ends, the move and its distance, the
// touch, the zone the operator puts the probe in.
//
// The picture frame ("feature frame") puts the feature at a known place: the
// face probed at 0 on its axis, a round feature centred on 0,0, and the TOP of
// the feature at Z 0. Z is the probe TIP's height above that top - the same
// point the runner commands (safe = top + clearance, depth = top - depth). The
// operator's start is the middle of the zone the routine asks for; the plan is
// made from that start, so every step after it is the planner's own geometry.
//
// Pure: no React, no store. The panel feeds it the setup and draws the result.

import {
  DEFAULT_TOP_SEARCH_MM,
  planFeatureProbeCycle,
  topSearchMm,
  workZeroEndMachineZ,
  xyTouchSearchMm,
  meshPointSearchMm,
  type ProbeCyclePoint,
  type ProbeFeatureCyclePlan,
  type ProbeFeatureKind,
} from '../../../lib/machine/probeFeatureCycle'
import type { EffectiveProbeConfig } from '../../../lib/machine/toolTable'
import type { WorkProbeAxis, WorkProbeDirection } from '../../../lib/machine/probeRoutines'
import type { MachineEnvelope } from '../../../lib/machine/machineEnvelope'
import { calibrationFeatureKind, type CalibrationReferenceKind } from '../../../lib/machine/probeCalibration'

export type ProbingRoutine =
  | 'workZero'
  | 'edge'
  | 'outsideCorner'
  | 'insideCorner'
  | 'angle'
  | 'bore'
  | 'boss'
  | 'rectPocket'
  | 'rectBoss'
  | 'zSurface'
  | 'toolZ'
  /** WO-2166: the probe's X / Y radius on a known reference - Boss's moves
   *  around an outside one, Bore's inside an inside one. */
  | 'calibrate'

export interface P3 { x: number; y: number; z: number }

export type MoveKind = 'move' | 'probe'

export interface StepMove {
  kind: MoveKind
  from: P3
  to: P3
  /** Probe moves: how far the search may run past `to` before it stops. */
  searchMm?: number
  /** WO-2108: the top touch - its search runs `searchMm` from the start, which
   *  may be any height below that, so its label before the run names the
   *  search ("Z- up to 25 mm"), not the drawn distance. */
  searchLabel?: boolean
  /** This move ends in the step's touch (the first, fast pass). */
  touches?: boolean
  /** A move the picture draws to a schematic length (Tool Z: the setter is
   *  drawn beside the part, not hundreds of mm away): how far the machine
   *  really goes. Live progress and the counting distance use it. */
  machineMm?: number
  /** Its real distance is the last schematic probe's, measured when that
   *  probe touched (Tool Z rises back as far as it came down). */
  machineMmFromTouch?: boolean
}

/** Where the operator puts the probe (YOU steps): a box in the feature frame. */
export interface Zone {
  x0: number
  x1: number
  y0: number
  y1: number
  /** Lowest tip height of the zone; the zone runs up from here. */
  z0: number
  z1: number
  /** The dimension drawn on the zone, and its words. */
  dim: { axis: WorkProbeAxis; from: number; to: number; label: string } | null
  /** Round zones (over the middle of a round feature): drawn as a circle. */
  round?: boolean
  /** Where and how high, in words (two lines each): "More about this step".
   *  WO-2179: the picture draws dimensions only (Operator 09-29, "don't be
   *  verbose"); the words are the sentence's. */
  say: [string, string, string, string]
  /** WO-2179: the zone's height as a dimension beside it ("< 25 mm"); absent
   *  when it runs to any height. */
  height?: string
  /** WO-2108: the highest the start may be above the top - the top search.
   *  Drawn as the zone's top; absent, the zone runs to the top of the view
   *  (any height). */
  zMax?: number
}

/** The feature's own size, drawn on the part (Bore: "Ø 25"). */
export type PartDim = { kind: 'round'; d: number; label: string } | { kind: 'rect'; x: number; y: number; label: string }

export type HeightLineKind = 'safe' | 'top' | 'depth' | 'start' | 'crossing'

export interface HeightLine {
  kind: HeightLineKind
  z: number
  /** One line: "safe +5 · tip clearance". */
  label: string
}

export interface ProbeStep {
  /** 1-based. */
  n: number
  owner: 'you' | 'machine'
  sentence: string
  /** The axis the side view runs along for this step. */
  view: WorkProbeAxis
  /** Where the probe is when the step starts. */
  at: P3
  /** Where the probe is when the step ends. */
  end: P3
  /** 0..2 moves, in the order they run. */
  moves: StepMove[]
  /** The point on the part this step touches (lights when the probe arrives). */
  touch: P3 | null
  /** Which move makes that touch (the step's last probe move); null without one. */
  touchMove: number | null
  zone: Zone | null
  /** Points already found by earlier steps (drawn as touch marks). */
  found: P3[]
  /** The step the Confirm button belongs to - or, where the routine has no
   *  Confirm (Angle, Z0, Tool Z), the step that shows its result. */
  confirm: boolean
  /** "More about this step": short headed sections of short lines. */
  more: Array<{ heading: string; lines: string[] }>
  /** WO-2184, Z surface: the grid point this step is at or goes to (1-based). */
  point?: number
  /** WO-2184, Z surface run: the plan step (1..8) this step shows as - the
   *  run keeps the 8 plan steps and counts the points (Operator 09-29). */
  chip?: number
}

export type Shape =
  | { kind: 'rect'; x0: number; x1: number; y0: number; y1: number; top: number; bottom: number; cut?: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number; top: number; bottom: number; cut?: boolean }
  /** WO-2182: a convex outline (Angle's part, its face drawn at an angle).
   *  Its first edge (pts[0] -> pts[1]) is the face. */
  | { kind: 'poly'; pts: Array<{ x: number; y: number }>; top: number; bottom: number; cut?: boolean }

/** WO-2182 (Operator 09-29: "You should show it angled or it is unclear what we
 *  are actually doing"): Angle draws its face at this tilt - a clearly visible
 *  one, not to scale (a real part is a fraction of a degree out). */
export const ANGLE_DRAWN_DEG = 10

/** WO-2182: what the Angle pictures mark - the two touch points on the angled
 *  face, the square axis the angle is measured from, and the angle. */
export interface AngleMark {
  /** Point 1 and point 2, on the face (the angle's vertex is point 1). */
  points: [P3, P3]
  /** The square axis the angle is measured from. */
  nominalAxis: WorkProbeAxis
  /** After a run, the measured angle (deg, + counter-clockwise); else null. */
  measuredDeg: number | null
}

/** WO-2184: Z surface's grid, drawn whole on every step's top view. */
export interface MeshMark {
  /** Every point, in the order the machine probes them (the snake). */
  points: Array<{ x: number; y: number }>
  pointsX: number
  pointsY: number
  /** The program's cutting area, when the screen has it. */
  cut: { minX: number; minY: number; maxX: number; maxY: number } | null
  /** "5 x 5" */
  count: string
  /** "6 x 4 mm" (one number when both are the same) */
  spacing: string
  /** After a run: each point's measured height above point 1 (mm), in point order. */
  heights: number[] | null
  /** After a run: the lowest, the highest and the range, in words. */
  legend: { low: string; high: string; range: string } | null
}

/** WO-2184: the scene with the heights a run measured, for its dots. */
export function withMeshHeights(scene: ProbeScene, heights: number[] | null, text: (mm: number, signed: boolean) => string): ProbeScene {
  if (!scene.mesh) return scene
  if (!heights || heights.length !== scene.mesh.points.length || heights.some((h) => !Number.isFinite(h))) {
    return scene.mesh.heights === null ? scene : { ...scene, mesh: { ...scene.mesh, heights: null, legend: null } }
  }
  const low = Math.min(...heights)
  const high = Math.max(...heights)
  return { ...scene, mesh: { ...scene.mesh, heights: [...heights], legend: { low: text(low, true), high: text(high, true), range: text(high - low, false) } } }
}

export interface ProbeScene {
  routine: ProbingRoutine
  /** The ball the pictures draw: the probe's real tip radius. */
  tipRadiusMm: number
  /** Material, then cuts through it (a bore, a pocket). */
  shapes: Shape[]
  heights: HeightLine[]
  steps: ProbeStep[]
  /** The step the operator's start is (the first YOU step's probe). */
  start: P3
  /** Why there are no steps (the plan refused). */
  refusal: string | null
  /** The tool (Tool Z) instead of a probe ball. */
  tool: boolean
  /** The feature's size, drawn on the part; null for faces and Z routines. */
  partDim?: PartDim | null
  /** WO-2182: Angle only - its touch points and the angle, marked. */
  angle?: AngleMark
  /** WO-2184: Z surface only - the whole grid. */
  mesh?: MeshMark
}

/** WO-2182: the scene with the angle a run measured, for its result step. */
export function withMeasuredAngle(scene: ProbeScene, measuredDeg: number | null | undefined): ProbeScene {
  if (!scene.angle || measuredDeg === undefined || scene.angle.measuredDeg === measuredDeg) return scene
  return { ...scene, angle: { ...scene.angle, measuredDeg: measuredDeg !== null && Number.isFinite(measuredDeg) ? measuredDeg : null } }
}

export interface SceneSetup {
  routine: ProbingRoutine
  config: EffectiveProbeConfig
  /** The probe ball radius (drawn). */
  tipRadiusMm: number
  /** Plate held against the face (0 when the probe touches the part). */
  plateMm: number
  startDistanceMm: number
  depthMm: number
  /** WO-2108: how far the first Z touch searches down for the top (Edge,
   *  Outside corner, Angle, Boss, Rect boss). Default DEFAULT_TOP_SEARCH_MM. */
  topSearchMm?: number
  /** WO-2266: Boss and Rect boss take their top from work Z0 (Top "Use work
   *  Z0") and touch nothing over the middle. Ignored by every other routine. */
  topFromWorkZero?: boolean
  edgeAxis: WorkProbeAxis
  edgeDirection: WorkProbeDirection
  cornerXDirection: WorkProbeDirection
  cornerYDirection: WorkProbeDirection
  angleNominalAxis: WorkProbeAxis
  angleProbeDirection: WorkProbeDirection
  angleAlongDirection: WorkProbeDirection
  angleSpacingMm: number
  sizeXmm: number
  sizeYmm: number
  /** The work offset a Confirm writes. */
  wcs: string
  /** Boss / Rect boss: the live plan's cross-over lift above the start, when
   *  the screen has one (it depends on the machine's safe Z). */
  bossLiftMm?: number | null
  /** Z0: the plate Z0 subtracts, the clearance it ends at. */
  workZero?: { plateMm: number; clearanceMm: number; retractMm: number; maxTravelMm: number }
  /** Z surface: the grid in work coordinates (WO-2184: its counts and the
   *  program's cutting area, when the screen has them). */
  mesh?: {
    points: Array<{ x: number; y: number }>
    heightChangeMm: number
    pointsX?: number
    pointsY?: number
    cutBounds?: { minX: number; minY: number; maxX: number; maxY: number } | null
  } | null
  /** Z surface: a move, a probe and a rise for EVERY point, so the running
   *  picture follows the machine to the last one. Without it (the preview)
   *  the points after point 2 are one "repeats" sentence. */
  everyPoint?: boolean
  /** Tool Z: the machine's real distances for the rise, the crossing to the
   *  setter and the descent to it (the picture draws them schematic). */
  toolZ?: { tool: number | null; machine?: { riseMm: number; crossMm: number; downMm: number } | null } | null
  units?: (mm: number) => string
  /** WO-2166 Calibrate: the reference touched (its exact diameter is the
   *  size drawn) and the tool Confirm writes to. */
  calibration?: { kind: CalibrationReferenceKind; diameterMm: number; tool: string | null } | null
}

// ---------------------------------------------------------------------------

const ZS = 10 // where the operator leaves the probe: this far above the top (any height)
/** WO-2108: the routines whose first move touches the top where the probe stands. */
const TOP_TOUCH_ROUTINES: ReadonlySet<ProbingRoutine> = new Set<ProbingRoutine>(['edge', 'outsideCorner', 'angle', 'boss', 'rectBoss'])
const r4 = (v: number) => Number(v.toFixed(4))
const fmt1 = (v: number) => Number(v.toFixed(1)).toString()
const sgn = (d: WorkProbeDirection) => (d === '+' ? 1 : -1)
const key = (a: WorkProbeAxis) => (a === 'X' ? 'x' : 'y') as 'x' | 'y'

/** "X+ 10.0 mm" - a move's axis, sign and length. */
export function moveLabel(move: StepMove, mmText: (mm: number) => string = (mm) => `${fmt1(mm)} mm`): string {
  const dx = move.to.x - move.from.x
  const dy = move.to.y - move.from.y
  const dz = move.to.z - move.from.z
  const ax = Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz) ? 'X' : Math.abs(dy) >= Math.abs(dz) ? 'Y' : 'Z'
  const d = ax === 'X' ? dx : ax === 'Y' ? dy : dz
  return `${ax}${d >= 0 ? '+' : '-'} ${mmText(moveLength(move))}`
}

export function moveLength(move: StepMove): number {
  return Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y, move.to.z - move.from.z)
}

/** The face a touch in this direction meets, in words. */
function faceName(axis: WorkProbeAxis, direction: WorkProbeDirection, inside: boolean): string {
  // Moving X+ meets the LEFT face of material (outside) or the RIGHT wall of a hole (inside).
  const plus = axis === 'X' ? (inside ? probeText('probeScene1') : probeText('probeScene2')) : (inside ? probeText('probeScene3') : probeText('probeScene4'))
  const minus = axis === 'X' ? (inside ? probeText('probeScene5') : probeText('probeScene6')) : (inside ? probeText('probeScene7') : probeText('probeScene8'))
  return `${direction === '+' ? plus : minus} ${inside ? probeText('probeScene9') : probeText('probeScene10')}`
}

function cornerName(x: WorkProbeDirection, y: WorkProbeDirection, inside: boolean): string {
  // Outside: X+ touches the left face, Y+ the front. Inside: X- touches the left wall, Y- the front.
  const left = inside ? x === '-' : x === '+'
  const front = inside ? y === '-' : y === '+'
  return `${front ? probeText('probeScene11') : probeText('probeScene12')}-${left ? probeText('probeScene13') : probeText('probeScene14')}`
}

const ROUTINE_NAME: Record<ProbingRoutine, string> = {
  workZero: 'Z0',
  edge: probeText('probeScene15'),
  outsideCorner: probeText('probeScene16'),
  insideCorner: probeText('probeScene17'),
  angle: probeText('probeScene18'),
  bore: probeText('probeScene19'),
  boss: probeText('probeScene20'),
  rectPocket: probeText('probeScene21'),
  rectBoss: probeText('probeScene22'),
  zSurface: probeText('probeScene23'),
  toolZ: probeText('probeScene24'),
  calibrate: probeText('probeScene25'),
}

export function routineName(routine: ProbingRoutine): string {
  return ROUTINE_NAME[routine]
}

/** A synthetic machine frame big enough for any plan: the plan's own numbers
 *  relative to the start are what the pictures use. */
const PLAN_ORIGIN: ProbeCyclePoint = { x: 1000, y: 1000, z: 500 }
const PLAN_ENVELOPE: MachineEnvelope = {
  x: { min: 0, max: 2000 },
  y: { min: 0, max: 2000 },
  z: { min: 0, max: 1000 },
} as MachineEnvelope

type WalkStep = Omit<ProbeStep, 'n' | 'touchMove'> & {
  /** Machine steps with one group number show as one step (Operator, 09-27:
   *  "Group by face"); the phrase is this part's words in that step. */
  group?: number
  phrase?: string
  /** The group's lead-in ("Right face") - set on the touch. */
  lead?: string
}

interface Walk {
  steps: WalkStep[]
  pos: P3
  found: P3[]
  /** The open group, when this routine groups its steps by face. */
  group?: number
}

function you(w: Walk, sentence: string, view: WorkProbeAxis, extra: Partial<WalkStep> = {}): void {
  w.steps.push({
    owner: 'you', sentence, view, at: { ...w.pos }, end: { ...w.pos }, moves: [], touch: null, zone: null,
    found: [...w.found], confirm: false, more: [], ...extra,
  })
}

function machine(w: Walk, sentence: string, view: WorkProbeAxis, moves: StepMove[], extra: Partial<WalkStep> = {}): void {
  const at = moves.length ? { ...moves[0].from } : { ...w.pos }
  const end = moves.length ? { ...moves[moves.length - 1].to } : { ...w.pos }
  w.steps.push({
    owner: 'machine', sentence, view, at, end, moves, touch: null, zone: null,
    found: [...w.found], confirm: false, more: [], group: w.group, ...extra,
  })
  w.pos = { ...end }
}

/** One step per face (or touch): the moves that bring the probe to the
 *  touch, the touch, its back-off and rise, shown as one path. A group of
 *  one keeps its own words. */
function mergeGroups(steps: WalkStep[], sentences?: ReadonlyMap<number, string>): WalkStep[] {
  const out: WalkStep[] = []
  for (let i = 0; i < steps.length;) {
    const g = steps[i].group
    let j = i + 1
    if (g !== undefined && steps[i].owner === 'machine') {
      while (j < steps.length && steps[j].owner === 'machine' && steps[j].group === g) j++
    }
    if (j - i === 1) { out.push(steps[i]); i = j; continue }
    const part = steps.slice(i, j)
    const touchStep = part.find((s) => s.touch) ?? null
    const body = part.map((s) => s.phrase ?? s.sentence.replace(/\.$/, '')).join(', ')
    const lead = touchStep?.lead
    // "More": the touch's own sections; the moves around it lead the first.
    const around = part
      .filter((s) => s !== touchStep && s.phrase)
      .flatMap((s) => s.more.filter((m) => m.heading === 'This move').slice(0, 1).map((m) => `${cap(s.phrase!)}: ${m.lines.at(-1)}`))
    const more = touchStep && touchStep.more.length
      ? [{ heading: touchStep.more[0].heading, lines: [...around, ...touchStep.more[0].lines] }, ...touchStep.more.slice(1)]
      : part.flatMap((s) => s.more)
    out.push({
      owner: 'machine',
      sentence: (g === undefined ? undefined : sentences?.get(g)) ?? (lead ? `${lead}: ${body}.` : `${cap(body)}.`),
      view: touchStep?.view ?? part[part.length - 1].view,
      at: { ...part[0].at },
      end: { ...part[part.length - 1].end },
      moves: part.flatMap((s) => s.moves),
      touch: touchStep?.touch ?? null,
      zone: null,
      found: [...part[0].found],
      confirm: false,
      more,
    })
    i = j
  }
  return out
}

function mv(from: P3, to: Partial<P3>, kind: MoveKind = 'move'): StepMove {
  return { kind, from: { ...from }, to: { ...from, ...to } }
}

/** Where a probe moving along `axis` in `direction` from `from` meets the
 *  face at `faceAt` on that axis: the ball centre one sensed radius short. */
function contactCentre(from: P3, axis: WorkProbeAxis, direction: WorkProbeDirection, faceAt: number, senseR: number): P3 {
  const k = key(axis)
  return { ...from, [k]: r4(faceAt - sgn(direction) * senseR) }
}

// ---------------------------------------------------------------------------

export function buildProbeScene(setup: SceneSetup): ProbeScene {
  // WO-2166: Calibrate is Boss (outside) or Bore (inside) on the reference's
  // exact diameter - the same plan, the same pictures - in its own words.
  if (setup.routine === 'calibrate') {
    const calibration = setup.calibration ?? { kind: 'outside' as const, diameterMm: setup.sizeXmm, tool: null }
    const inner = buildProbeScene({
      ...setup,
      routine: calibrationFeatureKind(calibration.kind),
      sizeXmm: calibration.diameterMm,
      sizeYmm: calibration.diameterMm,
      calibration,
    })
    return { ...inner, routine: 'calibrate' }
  }
  const cfg = setup.config
  const R = setup.tipRadiusMm
  const senseR = r4(R + setup.plateMm)
  const mm = setup.units ?? ((v: number) => `${fmt1(v)} mm`)
  const name = setup.calibration ? ROUTINE_NAME.calibrate : ROUTINE_NAME[setup.routine]
  const sensedBy = setup.plateMm > 0
    ? probeText('probeScene26', { value1: String(mm(setup.plateMm)) })
    : probeText('probeScene27')
  const searchSection = (what: string) => ({
    heading: probeText('probeScene28'),
    lines: [
      probeText('probeScene29', { value1: String(fmt1(cfg.fastFeed)) }),
      probeText('probeScene30', { value1: String(mm(cfg.retract)) }),
      probeText('probeScene31', { value1: String(fmt1(cfg.slowFeed)) }),
      ...(what ? [what] : []),
    ],
  })
  const missSection = (overMm: number, what: string) => ({
    heading: probeText('probeScene32'),
    lines: [probeText('probeScene33', { value1: String(mm(overMm)), value2: String(what) }), probeText('probeScene34')],
  })
  const senseSection = (result: string) => ({
    heading: setup.plateMm > 0 ? probeText('probeScene35') : probeText('probeScene36'),
    lines: [sensedBy, result],
  })

  // ---- Z0 ---------------------------------------------------------------
  if (setup.routine === 'workZero') {
    const wz = setup.workZero ?? { plateMm: 0, clearanceMm: cfg.surfaceClearance, retractMm: cfg.retract, maxTravelMm: cfg.maxTravel }
    // Top of the stock at 0; with a plate on it the tip touches the plate's top.
    const contactZ = wz.plateMm
    const endZ = r4(workZeroEndMachineZ({
      contactMachineZ: contactZ, padThicknessMm: wz.plateMm, surfaceClearanceMm: wz.clearanceMm, retractMm: wz.retractMm,
    }))
    const w: Walk = { steps: [], pos: { x: 0, y: 0, z: ZS }, found: [] }
    const zone: Zone = {
      x0: -12, x1: 12, y0: -12, y1: 12, z0: Math.max(contactZ, 1), z1: Math.min(wz.maxTravelMm, 30) + contactZ,
      dim: null,
      say: [probeText('probeScene37'), '', probeText('probeScene38', { value1: String(mm(wz.maxTravelMm)) }), probeText('probeScene39')],
      height: `< ${mm(wz.maxTravelMm)}`,
    }
    you(w, probeText('probeScene40', { value1: String(mm(wz.maxTravelMm)) }), 'X', { zone })
    you(w, probeText('probeScene41', { value1: String(name) }), 'X')
    machine(w, probeText('probeScene42'), 'X', [{ ...mv(w.pos, { z: contactZ }, 'probe'), searchMm: wz.maxTravelMm }], {
      touch: { x: 0, y: 0, z: contactZ },
      more: [searchSection(''), missSection(wz.maxTravelMm, probeText('probeScene43')), senseSection(wz.plateMm > 0 ? probeText('probeScene44', { value1: String(mm(wz.plateMm)) }) : probeText('probeScene45'))],
    })
    const up = mv(w.pos, { z: contactZ + wz.retractMm })
    const down = mv(up.to, { z: contactZ }, 'probe')
    machine(w, probeText('probeScene46', { value1: String(mm(wz.retractMm)) }), 'X', [up, down], {
      touch: { x: 0, y: 0, z: contactZ },
    })
    w.found = [{ x: 0, y: 0, z: 0 }]
    // WO-2123: Z0 writes at once (no Confirm); its last step shows the Z0 it set.
    machine(w, probeText('probeScene47', { value1: String(fmt1(wz.clearanceMm)) }), 'X', [mv(w.pos, { z: endZ })], { confirm: true })
    return finish(setup, w, [{ kind: 'rect', x0: -200, x1: 200, y0: -200, y1: 200, top: 0, bottom: -30 }], [
      { kind: 'safe', z: endZ, label: probeText('probeScene48', { value1: String(fmt1(endZ)) }) },
      { kind: 'top', z: 0, label: probeText('probeScene49') },
    ], { x: 0, y: 0, z: ZS })
  }

  // ---- Z surface ----------------------------------------------------------
  if (setup.routine === 'zSurface') {
    const pts = setup.mesh?.points ?? []
    if (pts.length < 2) {
      return emptyScene(setup, probeText('probeScene50'))
    }
    const p1 = pts[0]
    const p2 = pts[1]
    const view: WorkProbeAxis = Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y) ? 'X' : 'Y'
    const clear = cfg.surfaceClearance
    const searchMm = meshPointSearchMm(cfg, setup.mesh?.heightChangeMm)
    const w: Walk = { steps: [], pos: { x: p1.x, y: p1.y, z: ZS }, found: [] }
    // WO-2114: the runner moves over point 1 itself, at the height the probe
    // starts at, and searches point 1 down from there - so the operator picks
    // only a safe start height, never a place over point 1.
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    // WO-2184: the whole grid, for every step's top view - its counts, its
    // spacing, the area it covers, and the order the machine takes it in.
    const distinct = (vs: number[]) => new Set(vs.map((v) => v.toFixed(4))).size
    const nx = setup.mesh?.pointsX ?? distinct(xs)
    const ny = setup.mesh?.pointsY ?? distinct(ys)
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const gapX = nx > 1 ? (maxX - minX) / (nx - 1) : 0
    const gapY = ny > 1 ? (maxY - minY) / (ny - 1) : 0
    const spacing = mm(gapX) === mm(gapY) ? mm(gapX) : `${mm(gapX).replace(/ (mm|in)$/, '')} x ${mm(gapY)}`
    const mesh: MeshMark = {
      points: pts.map((p) => ({ x: p.x, y: p.y })),
      pointsX: nx,
      pointsY: ny,
      cut: setup.mesh?.cutBounds ?? null,
      count: `${nx} x ${ny}`,
      spacing,
      heights: null,
      legend: null,
    }
    // WO-2184 (Operator 09-29): the run keeps the 8 plan steps and counts the
    // points - each of its steps says which plan step it shows as.
    const every = setup.everyPoint === true
    const at = (point: number | undefined, chip: number): Partial<WalkStep> => (every ? { point, chip } : point === undefined ? {} : { point })
    you(w, probeText('probeScene51', { value1: String(mm(cfg.maxTravel)) }), view, {
      zone: {
        x0: minX, x1: maxX, y0: minY, y1: maxY, z0: clear, z1: Math.max(clear, Math.min(26, cfg.maxTravel)), zMax: cfg.maxTravel,
        dim: null, say: [probeText('probeScene52'), probeText('probeScene53'), probeText('probeScene54', { value1: String(mm(cfg.maxTravel)) }), probeText('probeScene55')], height: `< ${mm(cfg.maxTravel)}`,
      },
      more: [{
        heading: probeText('probeScene56'),
        lines: [
          probeText('probeScene57', { value1: String(mesh.count), value2: String(pts.length), value3: String(spacing) }),
          probeText('probeScene58', { value1: String(mm(minX)), value2: String(mm(maxX)), value3: String(mm(minY)), value4: String(mm(maxY)) }),
          probeText('probeScene59'),
          ...(mesh.cut ? [probeText('probeScene60')] : []),
        ],
      }],
      ...at(undefined, 1),
    })
    you(w, probeText('probeScene61', { value1: String(name) }), view, at(undefined, 2))
    machine(w, probeText('probeScene62'), view, [{ ...mv(w.pos, { z: 0 }, 'probe'), searchMm: cfg.maxTravel }], {
      touch: { x: p1.x, y: p1.y, z: 0 },
      more: [searchSection(''), missSection(cfg.maxTravel, probeText('probeScene63'))],
      ...at(1, 3),
    })
    w.found = [{ x: p1.x, y: p1.y, z: 0 }]
    machine(w, probeText('probeScene64', { value1: String(fmt1(clear)) }), view, [mv(w.pos, { z: clear })], at(1, 4))
    // The preview shows point 2 and says the rest repeat; a run follows the
    // machine through every point (the tracker can only follow moves it has).
    for (const [i, p] of (every ? pts.slice(1) : [p2]).entries()) {
      const k = i + 2
      machine(w, every ? probeText('probeScene65', { value1: String(k), value2: String(pts.length) }) : probeText('probeScene66'), view, [mv(w.pos, { x: p.x, y: p.y })], at(k, 5))
      machine(w, probeText('probeScene69', { value1: String(every ? probeText('probeScene67', { value1: String(k) }) : probeText('probeScene68')), value2: String(mm(searchMm)) }), view, [{ ...mv(w.pos, { z: 0 }, 'probe'), searchMm }], {
        touch: { x: p.x, y: p.y, z: 0 },
        more: [searchSection(''), missSection(searchMm - clear, probeText('probeScene70'))],
        ...at(k, 6),
      })
      w.found = [...w.found, { x: p.x, y: p.y, z: 0 }]
      if (!every) {
        machine(w, probeText('probeScene71', { value1: String(fmt1(clear)), value2: String(pts.length) }), view, [mv(w.pos, { z: clear })], at(k, 7))
      } else if (k < pts.length) {
        machine(w, probeText('probeScene72', { value1: String(fmt1(clear)) }), view, [mv(w.pos, { z: clear })], at(k, 7))
      }
    }
    if (every) {
      machine(w, probeText('probeScene73', { value1: String(fmt1(clear)) }), view, [mv(w.pos, { z: clear })], at(pts.length, 8))
    } else {
      w.found = pts.map((p) => ({ x: p.x, y: p.y, z: 0 }))
      const last = pts[pts.length - 1]
      w.pos = { x: last.x, y: last.y, z: clear }
      machine(w, probeText('probeScene74', { value1: String(fmt1(clear)) }), view, [], at(pts.length, 8))
    }
    const margin = 15
    const scene = finish(setup, w, [{
      kind: 'rect', x0: minX - margin, x1: maxX + margin, y0: minY - margin, y1: maxY + margin, top: 0, bottom: -30,
    }], [
      { kind: 'safe', z: clear, label: probeText('probeScene75', { value1: String(fmt1(clear)) }) },
      { kind: 'top', z: 0, label: probeText('probeScene76') },
    ], { x: p1.x, y: p1.y, z: ZS })
    scene.mesh = mesh
    return scene
  }

  // ---- Tool Z -------------------------------------------------------------
  if (setup.routine === 'toolZ') {
    // The setter sits beside the part; the tool starts over the part. The
    // setter plan's XY and crossing Z are machine facts the pictures show as
    // words; the drawing places them to scale beside each other.
    const setterX = 60
    const crossing = 18
    const setterTop = -18
    const w: Walk = { steps: [], pos: { x: 0, y: 0, z: 2 }, found: [] }
    const real = setup.toolZ?.machine ?? null
    const scaled = (m: StepMove, mm: number | undefined): StepMove => (mm !== undefined && Number.isFinite(mm) && mm > 0 ? { ...m, machineMm: mm } : m)
    // WO-2180 (Operator 09-29: "it says no jogging. So does it assume you already
    // set wcs zero...? how does the user know"): it uses the setter's saved
    // machine position and never the part's work Z0 - said once, briefly.
    you(w, probeText('probeScene77'), 'X')
    machine(w, probeText('probeScene78'), 'X', [scaled(mv(w.pos, { z: crossing }), real?.riseMm)])
    machine(w, probeText('probeScene79'), 'X', [scaled(mv(w.pos, { x: setterX }), real?.crossMm)])
    machine(w, probeText('probeScene80'), 'X', [scaled({ ...mv(w.pos, { z: setterTop }, 'probe'), searchMm: cfg.maxTravel }, real?.downMm)], {
      touch: { x: setterX, y: 0, z: setterTop },
      more: [searchSection(''), missSection(cfg.maxTravel, probeText('probeScene81'))],
    })
    const up = mv(w.pos, { z: setterTop + cfg.retract })
    const down = mv(up.to, { z: setterTop }, 'probe')
    machine(w, probeText('probeScene82', { value1: String(mm(cfg.retract)) }), 'X', [up, down], {
      touch: { x: setterX, y: 0, z: setterTop },
    })
    w.found = [{ x: setterX, y: 0, z: setterTop }]
    // WO-2123: Tool Z stores at once (no Confirm); its last step shows what it stored.
    machine(w, probeText('probeScene83'), 'X', [{ ...scaled(mv(w.pos, { z: crossing }), real?.downMm), ...(real ? { machineMmFromTouch: true } : {}) }], { confirm: true })
    return finish(setup, w, [
      { kind: 'rect', x0: -200, x1: 30, y0: -200, y1: 200, top: -8, bottom: -30 },
      // WO-2180: the setter is round (Operator 09-29: "Round is more common").
      { kind: 'circle', cx: setterX, cy: 0, r: 8, top: setterTop, bottom: -30 },
    ], [
      { kind: 'crossing', z: crossing, label: probeText('probeScene84') },
      { kind: 'top', z: -8, label: probeText('probeScene85') },
    ], { x: 0, y: 0, z: 2 }, true)
  }

  // ---- feature routines: the production planner -------------------------
  const kind = setup.routine as ProbeFeatureKind
  const inside = setup.routine === 'insideCorner' || setup.routine === 'bore' || setup.routine === 'rectPocket'
  const round = setup.routine === 'bore' || setup.routine === 'boss' || setup.routine === 'rectPocket' || setup.routine === 'rectBoss'
  const boss = setup.routine === 'boss' || setup.routine === 'rectBoss'
  const explainBossClearance = boss && !setup.calibration
  const bossFromWorkZero = boss && setup.topFromWorkZero === true
  const clear = cfg.surfaceClearance
  const depth = setup.depthMm
  const sd = setup.startDistanceMm
  // WO-2108: the routines that touch the top first search this far down for
  // it (the planner's own rule), so the drawn start sits below that distance.
  const topSearch = TOP_TOUCH_ROUTINES.has(setup.routine) && !bossFromWorkZero
    ? topSearchMm(cfg, setup.topSearchMm ?? DEFAULT_TOP_SEARCH_MM)
    : null
  const startZ = topSearch === null ? ZS : Math.min(ZS, r4(topSearch * 0.6))

  // The operator's nominal start in the feature frame, and the part.
  let start: P3
  let shapes: Shape[]
  const BIG = 200
  const PART_BOTTOM = -30
  // WO-2182: Angle's face on the probe axis, at a distance along the nominal
  // axis from point 1 - receding from the probe on point 2's side.
  const angleTilt = sgn(setup.angleProbeDirection) * sgn(setup.angleAlongDirection) * Math.tan((ANGLE_DRAWN_DEG * Math.PI) / 180)
  const angleFace = (along: number) => r4(angleTilt * along)
  if (setup.routine === 'edge') {
    const s = sgn(setup.edgeDirection)
    start = setup.edgeAxis === 'X' ? { x: s * sd / 2, y: 0, z: startZ } : { x: 0, y: s * sd / 2, z: startZ }
    shapes = [setup.edgeAxis === 'X'
      ? { kind: 'rect', x0: s > 0 ? 0 : -BIG, x1: s > 0 ? BIG : 0, y0: -BIG, y1: BIG, top: 0, bottom: PART_BOTTOM }
      : { kind: 'rect', x0: -BIG, x1: BIG, y0: s > 0 ? 0 : -BIG, y1: s > 0 ? BIG : 0, top: 0, bottom: PART_BOTTOM }]
  } else if (setup.routine === 'outsideCorner') {
    const sx = sgn(setup.cornerXDirection)
    const sy = sgn(setup.cornerYDirection)
    start = { x: sx * sd / 2, y: sy * sd / 2, z: startZ }
    shapes = [{ kind: 'rect', x0: sx > 0 ? 0 : -BIG, x1: sx > 0 ? BIG : 0, y0: sy > 0 ? 0 : -BIG, y1: sy > 0 ? BIG : 0, top: 0, bottom: PART_BOTTOM }]
  } else if (setup.routine === 'angle') {
    const s = sgn(setup.angleProbeDirection)
    const probeAxis: WorkProbeAxis = setup.angleNominalAxis === 'X' ? 'Y' : 'X'
    start = probeAxis === 'Y' ? { x: 0, y: s * sd / 2, z: startZ } : { x: s * sd / 2, y: 0, z: startZ }
    // WO-2182: the face at an angle, through point 1 (where the operator
    // starts), turned so it runs away from the probe toward point 2 - the
    // probe then comes down clear of it there, as it would on the part.
    const pt = (along: number, across: number) => (probeAxis === 'Y' ? { x: along, y: across } : { x: across, y: along })
    shapes = [{
      kind: 'poly',
      pts: [pt(-BIG, angleFace(-BIG)), pt(BIG, angleFace(BIG)), pt(BIG, angleFace(BIG) + s * BIG), pt(-BIG, angleFace(-BIG) + s * BIG)],
      top: 0,
      bottom: PART_BOTTOM,
    }]
  } else if (setup.routine === 'insideCorner') {
    // The probe stands over the corner of the pocket, clear of both walls by
    // half the stand-off, at any height above the top: the plan descends from
    // there to probing depth (WO-2057).
    const sx = sgn(setup.cornerXDirection)
    const sy = sgn(setup.cornerYDirection)
    const inset = clear / 2 + senseR
    start = { x: -sx * inset, y: -sy * inset, z: startZ }
    shapes = [
      { kind: 'rect', x0: -BIG, x1: BIG, y0: -BIG, y1: BIG, top: 0, bottom: PART_BOTTOM },
      { kind: 'rect', x0: sx > 0 ? -BIG : 0, x1: sx > 0 ? 0 : BIG, y0: sy > 0 ? -BIG : 0, y1: sy > 0 ? 0 : BIG, top: 0, bottom: -(depth + 10), cut: true },
    ]
  } else {
    const hx = setup.sizeXmm / 2
    const hy = setup.sizeYmm / 2
    const rect = setup.routine === 'rectPocket' || setup.routine === 'rectBoss'
    // Over the middle, any height above the top: the hole (WO-2057) or the
    // boss (WO-2058).
    start = { x: 0, y: 0, z: startZ }
    if (inside) {
      // The hole is in a block that runs past both views (the Bore video:
      // stock to the edges, the hole cut in it).
      shapes = [
        { kind: 'rect', x0: -BIG, x1: BIG, y0: -BIG, y1: BIG, top: 0, bottom: PART_BOTTOM },
        rect
          ? { kind: 'rect', x0: -hx, x1: hx, y0: -hy, y1: hy, top: 0, bottom: -(depth + 10), cut: true }
          : { kind: 'circle', cx: 0, cy: 0, r: hx, top: 0, bottom: -(depth + 10), cut: true },
      ]
    } else {
      const height = depth + 10
      shapes = [rect
        ? { kind: 'rect', x0: -hx, x1: hx, y0: -hy, y1: hy, top: 0, bottom: -height }
        : { kind: 'circle', cx: 0, cy: 0, r: hx, top: 0, bottom: -height }]
    }
  }
  void round

  const toMachine = (p: P3): ProbeCyclePoint => ({ x: PLAN_ORIGIN.x + p.x - start.x, y: PLAN_ORIGIN.y + p.y - start.y, z: PLAN_ORIGIN.z + p.z - start.z })
  const fromMachine = (p: ProbeCyclePoint): P3 => ({ x: r4(p.x - PLAN_ORIGIN.x + start.x), y: r4(p.y - PLAN_ORIGIN.y + start.y), z: r4(p.z - PLAN_ORIGIN.z + start.z) })
  const planned = planFeatureProbeCycle({
    kind,
    start: toMachine(start),
    envelope: PLAN_ENVELOPE,
    config: cfg,
    tipRadiusMm: senseR,
    nominalSizeXmm: setup.sizeXmm,
    nominalSizeYmm: setup.sizeYmm,
    edgeAxis: setup.edgeAxis,
    edgeDirection: setup.edgeDirection,
    cornerXDirection: setup.cornerXDirection,
    cornerYDirection: setup.cornerYDirection,
    angleNominalAxis: setup.angleNominalAxis,
    angleProbeDirection: setup.angleProbeDirection,
    angleAlongDirection: setup.angleAlongDirection,
    angleSpacingMm: setup.angleSpacingMm,
    startDistanceMm: sd,
    depthBelowTopMm: depth,
    topSearchMm: topSearch ?? undefined,
    ...(bossFromWorkZero ? { topFromWorkZero: true } : {}),
    // Boss: a cross-over the live plan lifts by this much above the start.
    safeZMachineMm: setup.bossLiftMm != null ? toMachine(start).z + setup.bossLiftMm : toMachine(start).z + cfg.crossOverLift,
  })
  if (!planned.ok) return emptyScene(setup, planned.reason, shapes, start)
  const plan: ProbeFeatureCyclePlan = planned.plan

  const w: Walk = { steps: [], pos: { ...start }, found: [] }
  const firstAxis: WorkProbeAxis = plan.review.touchOrder[0]?.axis ?? 'X'
  // Operator, 09-27 (card Q-BOSS-PROBING-22-STEPS-OR-GROUP-T): "Group by face".
  // The long routines show one MACHINE step per face or touch, as the
  // approved Bore video (bore-full-run.mp4) does: the moves that bring the
  // probe to the face, the touch (fast, then slow), its back-off and the way
  // back. A hole's descent and its final rise are steps of their own. Edge
  // (the approved reference, 9 steps) and Inside corner (already one step per
  // touch) keep their steps.
  const grouped = setup.routine !== 'edge' && setup.routine !== 'insideCorner'
  let groupCount = 0
  let groupHasTouch = false
  const openGroup = () => { if (grouped) { w.group = ++groupCount; groupHasTouch = false } }

  // ---- YOU: where to be ----
  const topMm = plan.fromTop?.topTouch?.travelMm ?? null
  const zone = startZone(setup, senseR, clear, mm, topMm)
  const where = whereSentence(setup, sd, clear, mm, topMm, plan.fromTop?.knownTop?.source === 'workZero')
  you(w, where, firstAxis, {
    zone,
    more: [{ heading: probeText('probeScene86'), lines: [[zone.say[0], zone.say[1]].filter(Boolean).join(' ') + ', ' + zone.say[2] + ' ' + zone.say[3], probeText('probeScene87'), probeText('probeScene88')] }],
  })
  you(w, probeText('probeScene89', { value1: String(name) }), firstAxis)
  openGroup()

  const fromTop = plan.fromTop ?? null
  const safeZ = fromTop ? fromTop.clearanceMm : null
  const depthZ = fromTop ? -fromTop.depthMm : null
  if (fromTop?.topTouch) {
    // The same two passes as every touch: fast to the top, back off, slowly again.
    // WO-2108: the search runs the operator's "Search down for the top"
    // distance and no farther; its arrow is labelled with that distance.
    const top = fromTop.topTouch.travelMm
    const topFast: StepMove = { ...mv(w.pos, { z: 0 }, 'probe'), searchMm: top, searchLabel: true, touches: true }
    const topBack = mv(topFast.to, { z: cfg.retract })
    const topSlow: StepMove = { ...mv(topBack.to, { z: 0 }, 'probe'), searchMm: 2 * cfg.retract }
    machine(w, probeText('probeScene90', { value1: String(mm(top)) }), firstAxis, [topFast, topBack, topSlow], {
      touch: { x: w.pos.x, y: w.pos.y, z: 0 },
      more: [searchSection(probeText('probeScene91', { value1: String(mm(top)) })), {
        heading: probeText('probeScene92'),
        lines: [probeText('probeScene93', { value1: String(mm(top)), value2: String(mm(top)) }), probeText('probeScene94')],
      }],
      phrase: probeText('probeScene95', { value1: String(mm(top)) }),
    })
    groupHasTouch = true
    machine(w, probeText('probeScene96', { value1: String(fmt1(fromTop.clearanceMm)) }), firstAxis, [mv(w.pos, { z: fromTop.clearanceMm })], {
      phrase: probeText('probeScene97', { value1: String(fmt1(fromTop.clearanceMm)) }),
    })
  }

  const touchCount = plan.steps.filter((s) => s.kind === 'touch').length
  let touchIndex = 0
  const faceAt = (axis: WorkProbeAxis, direction: WorkProbeDirection, from: P3): number => {
    // Where the face this touch meets is, on its axis, in the feature frame.
    // WO-2182: Angle's is at an angle - where it is along the nominal axis.
    if (setup.routine === 'angle') return angleFace(from[key(setup.angleNominalAxis)])
    if (!round) return 0
    const hx = setup.sizeXmm / 2
    const hy = setup.sizeYmm / 2
    const h = axis === 'X' ? hx : hy
    if (setup.routine === 'bore' && axis === 'X' && from.y !== 0) return sgn(direction) * Math.sqrt(Math.max(0, hx * hx - from.y * from.y))
    if (setup.routine === 'bore' && axis === 'Y' && from.x !== 0) return sgn(direction) * Math.sqrt(Math.max(0, hy * hy - from.x * from.x))
    return inside ? sgn(direction) * h : -sgn(direction) * h
  }
  // The way back from a touch stays in that touch's step; a move toward the
  // next face starts the next one.
  const wayBack = (label: string) => /Return toward start|back over the stock|back around|^Lift clear/i.test(label)
  const bossFaceSentences = new Map<number, string>()
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]
    if ((step.kind === 'descend' || step.kind === 'rise') && safeZ !== null && depthZ !== null) {
      // WO-2057: a hole routine's way down and back up, from its known top
      // (work Z0) - the runner rises to safe height only when below it. Each
      // is a step of its own (the Bore video's steps 3 and 8).
      openGroup()
      const view: WorkProbeAxis = w.steps.at(-1)?.view ?? firstAxis
      if (w.pos.z < safeZ - 1e-6) machine(w, probeText('probeScene98', { value1: String(fmt1(safeZ)) }), view, [mv(w.pos, { z: safeZ })], { phrase: probeText('probeScene99', { value1: String(fmt1(safeZ)) }) })
      if (step.kind === 'rise') continue
      const target = fromMachine(step.target)
      const over = mv(w.pos, { x: target.x, y: target.y })
      if (moveLength(over) > 1e-6) machine(w, probeText('probeScene100', { value1: String(moveLabel(over, mm)) }), view, [over], { phrase: probeText('probeScene101', { value1: String(moveLabel(over, mm)) }) })
      machine(w, probeText('probeScene102', { value1: String(fmt1(-depthZ)) }), view, [{ ...mv(w.pos, { z: depthZ }, 'probe'), searchMm: w.pos.z - depthZ }], {
        more: [{ heading: probeText('probeScene103'), lines: [probeText('probeScene104'), probeText('probeScene105', { value1: String(fmt1(cfg.fastFeed)) }), probeText('probeScene106')] }, {
          heading: probeText('probeScene107'), lines: [probeText('probeScene108')],
        }],
        phrase: probeText('probeScene109'),
      })
      openGroup()
      continue
    }
    if (step.kind === 'descend' || step.kind === 'rise') continue
    if (step.kind === 'position') {
      const target = fromMachine(step.target)
      const to: Partial<P3> = {}
      for (const a of step.axes) to[a.toLowerCase() as 'x' | 'y' | 'z'] = target[a.toLowerCase() as 'x' | 'y' | 'z']
      const m = mv(w.pos, to)
      if (moveLength(m) < 1e-6) continue
      const dz = m.to.z - m.from.z
      const horizontalAxis: WorkProbeAxis = Math.abs(m.to.x - m.from.x) >= Math.abs(m.to.y - m.from.y) ? 'X' : 'Y'
      const view: WorkProbeAxis = Math.abs(dz) > 1e-6 && Math.abs(m.to.x - m.from.x) + Math.abs(m.to.y - m.from.y) < 1e-6
        ? (w.steps.at(-1)?.view ?? firstAxis)
        : horizontalAxis
      // The finish over the middle (Boss) is a step of its own; a move toward
      // the next face starts that face's step.
      if (/^Finish above/i.test(step.label) || (groupHasTouch && !wayBack(step.label))) openGroup()
      machine(w, positionSentence(setup, step.label, m, i === plan.steps.length - 1, touchIndex === touchCount), view, [m], {
        more: [{ heading: probeText('probeScene110'), lines: [probeText('probeScene111', { value1: String(fmt1(cfg.positioningFeed)) }), probeText('probeScene112')] }],
        phrase: positionPhrase(step.label, m, mm),
      })
      continue
    }
    // A touch.
    if (groupHasTouch) openGroup()
    touchIndex++
    const k = key(step.axis)
    const expected = fromMachine(step.expectedStart)
    if (step.descendFromTop && safeZ !== null && depthZ !== null) {
      // Rise (already at safe after the top touch or the last rise), step out, descend.
      // WO-2266: a top it did not touch (Boss on work Z0) - from above safe
      // height it steps out where it stands and descends the whole way (the
      // runner's rule, as a hole routine's way down).
      const fromAbove = !fromTop?.topTouch && w.pos.z > safeZ + 1e-6
      if (!fromAbove && Math.abs(w.pos.z - safeZ) > 1e-6) machine(w, probeText('probeScene113', { value1: String(fmt1(safeZ)) }), step.axis, [mv(w.pos, { z: safeZ })], { phrase: probeText('probeScene114') })
      const out = mv(w.pos, { x: expected.x, y: expected.y })
      if (moveLength(out) > 1e-6) {
        const face = faceName(step.axis, step.direction, inside)
        const lead = setup.routine === 'outsideCorner'
          ? (touchIndex === 1 ? probeText('probeScene115', { value1: String(cap(face)) }) : probeText('probeScene116', { value1: String(cap(face)) }))
          : 'Steps'
        machine(w, probeText('probeScene118', { value1: String(lead === 'Steps' ? probeText('sceneStepsLead') : lead), value2: String(lead === 'Steps' ? face : probeText('probeScene117')), value3: String(moveLabel(out, mm)) }), step.axis, [out], {
          more: [{ heading: probeText('probeScene119'), lines: [probeText('probeScene122', { value1: String(fromAbove ? probeText('probeScene120') : probeText('probeScene121', { value1: String(fmt1(safeZ)) })), value2: String(fmt1(cfg.positioningFeed)) }), boss
            ? probeText('probeScene123', { value1: String(step.axis), value2: String(mm((step.axis === 'X' ? setup.sizeXmm : setup.sizeYmm) / 2)), value3: String(mm(senseR)), value4: String(mm(clear)) })
            : probeText('probeScene124', { value1: String(mm(sd)), value2: String(mm(senseR)), value3: String(mm(clear)) })] }],
          phrase: probeText('probeScene125', { value1: String(moveLabel(out, mm)) }),
        })
      }
      // Calibrate borrows the Boss plan but keeps its approved words (WO-2166).
      // Measure from the plan's descent point, rather than the move length:
      // later faces start at the previous face, not at the nominal centre.
      const outsideMm = explainBossClearance
        ? r4(Math.abs(expected[k]) - (step.axis === 'X' ? setup.sizeXmm : setup.sizeYmm) / 2)
        : null
      if (outsideMm !== null && w.group !== undefined) {
        // Keep the sentence within its existing row at 1440x900. The picture
        // and More sections still show the complete touch/back-off/rise path.
        const plate = setup.plateMm > 0 ? probeText('probeScene126', { value1: String(mm(setup.plateMm)) }) : ''
        bossFaceSentences.set(w.group,
          probeText('probeScene129', { value1: String(cap(faceName(step.axis, step.direction, inside))), value2: String(moveLabel(out, mm)), value3: String(mm(outsideMm)), value4: String(mm(R)), value5: String(plate), value6: String(mm(clear)) }))
      }
      machine(w, probeText('probeScene130', { value1: String(fmt1(-depthZ)) }), step.axis, [{ ...mv(w.pos, { z: depthZ }, 'probe'), searchMm: (fromAbove ? w.pos.z : safeZ) - depthZ }], {
        more: [{ heading: probeText('probeScene131'), lines: [probeText('probeScene132'), probeText('probeScene133', { value1: String(fmt1(cfg.fastFeed)) }), ...(fromTop?.knownTop?.source === 'workZero' ? [probeText('probeScene134')] : [])] }, {
          heading: probeText('probeScene135'), lines: [probeText('probeScene138', { value1: String(boss ? probeText('probeScene136') : probeText('probeScene137')) })],
        }],
        phrase: probeText('probeScene139'),
      })
    }
    const face = faceAt(step.axis, step.direction, w.pos)
    const contact = contactCentre(w.pos, step.axis, step.direction, face, senseR)
    // The runner's two passes (machineSession: the search, the retract between
    // passes, the fine pass): the probe reaches the face fast, backs off and
    // touches it again slowly - that slow touch is the one recorded.
    const fast: StepMove = { ...mv(w.pos, { [k]: contact[k] } as Partial<P3>, 'probe'), searchMm: step.travelMm, touches: true }
    const retract = mv(fast.to, { [k]: r4(contact[k] - sgn(step.direction) * cfg.retract) } as Partial<P3>)
    const slow: StepMove = { ...mv(retract.to, { [k]: contact[k] } as Partial<P3>, 'probe'), searchMm: 2 * cfg.retract }
    const touchPoint: P3 = { ...contact, [k]: face }
    const faceWords = faceName(step.axis, step.direction, inside)
    const resultLine = round
      ? probeText('probeScene140', { value1: String(step.axis), value2: String(mm(senseR)) })
      : probeText('probeScene141', { value1: String(step.axis), value2: String(step.direction === '+' ? '+' : '-'), value3: String(mm(senseR)) })
    // The search's reach past the face is the plan's (WO-2182: from Angle's
    // square face - the drawn angle is not to scale).
    const planContact = setup.routine === 'angle' ? contactCentre(w.pos, step.axis, step.direction, 0, senseR) : contact
    const over = step.travelMm - Math.abs(planContact[k] - w.pos[k])
    const probeSentence = setup.routine === 'angle'
      ? probeText('probeScene142', { value1: String(step.axis), value2: String(step.direction), value3: String(touchIndex) })
      : setup.routine === 'edge'
        ? probeText('probeScene143', { value1: String(step.axis), value2: String(step.direction) })
        : probeText('probeScene144', { value1: String(step.axis), value2: String(step.direction), value3: String(faceWords) })
    const touchMore = [
      searchSection(''),
      missSection(Math.max(0, over), inside ? probeText('probeScene145') : probeText('probeScene146')),
      senseSection(resultLine),
    ]
    const lead = setup.routine === 'angle' ? probeText('probeScene147', { value1: String(touchIndex) }) : cap(faceWords)
    const probePhrase = probeText('probeScene148', { value1: String(step.axis), value2: String(step.direction) })
    if (step.descendFromTop && safeZ !== null) {
      machine(w, probeText('probeScene149', { value1: String(probeSentence) }), step.axis, [fast, retract, slow], { touch: touchPoint, more: touchMore, lead, phrase: probePhrase })
      w.found = [...w.found, touchPoint]
      const back = mv(w.pos, { [k]: r4(w.pos[k] - sgn(step.direction) * cfg.retract) } as Partial<P3>)
      const rise = mv(back.to, { z: safeZ })
      // Boss (WO-2058) still moves back over the middle after its last touch:
      // that move says what it found, not this one.
      const last = touchIndex === touchCount && !plan.steps.slice(i + 1).some((s) => s.kind === 'position')
      machine(w, probeText('probeScene150', { value1: String(mm(cfg.retract)), value2: String(last && !grouped ? finalShow(setup) : '') }), step.axis, [back, rise], {
        phrase: probeText('probeScene151'),
      })
    } else {
      // Beside-the-face touches: the two passes, then the runner's own back-off.
      const back = mv(slow.to, { [k]: r4(slow.to[k] - sgn(step.direction) * cfg.retract) } as Partial<P3>)
      machine(w, probeText('probeScene152', { value1: String(probeSentence), value2: String(mm(cfg.retract)) }), step.axis, [fast, retract, slow, back], {
        touch: touchPoint, more: touchMore, lead, phrase: probeText('probeScene153', { value1: String(probePhrase) }),
      })
      w.found = [...w.found, touchPoint]
    }
    groupHasTouch = true
  }
  if (grouped) w.steps = mergeGroups(w.steps, bossFaceSentences)
  const lastMachine = w.steps.at(-1)
  if (lastMachine && lastMachine.owner === 'machine' && !/Shows /.test(lastMachine.sentence)) {
    lastMachine.sentence = `${lastMachine.sentence}${finalShow(setup)}`
    lastMachine.found = [...w.found]
  }
  if (setup.routine !== 'angle') {
    you(w, confirmSentence(setup), w.steps.at(-1)?.view ?? firstAxis, { confirm: true })
  } else if (lastMachine) {
    // WO-2112: Angle writes nothing, so it has no Confirm step - its last
    // step ("Shows the angle ...") carries the result beside its sentence.
    // Until 2026-09-28 no step did, and the measured angle was never drawn.
    lastMachine.confirm = true
  }
  // One side view for the whole routine, as the Bore video: X-Z whenever the
  // routine touches an X face. A Y move then shows no sideways arrow there -
  // the probe stays at its X, its distance beside it, its arrow in the top
  // view. Only a routine that touches Y faces alone (Edge on a Y face, Angle
  // along Y) looks along Y.
  const sideAxis: WorkProbeAxis = plan.steps.some((s) => s.kind === 'touch' && s.axis === 'X') ? 'X' : 'Y'
  for (const s of w.steps) s.view = sideAxis
  // Architect, on Operator's delegation (09-27, "Boss shows the probe going into
  // the part on the vertical"): a step that probes a face from outside the
  // part, where that one view would draw the probe inside the material, turns
  // to look the other way for that step - the probe comes down beside the
  // face and moves toward it (WO-2127: the "Right view"). Bore and Rect
  // pocket keep their one view: their Y walls are in the open hole.
  const turn = w.steps.filter((s) => s.owner === 'machine' && drawnInsideMaterial({ steps: w.steps, shapes }, s))
  for (const s of turn) s.view = sideAxis === 'X' ? 'Y' : 'X'

  const heights: HeightLine[] = []
  if (fromTop) {
    heights.push({ kind: 'safe', z: fromTop.clearanceMm, label: probeText('probeScene154', { value1: String(fmt1(fromTop.clearanceMm)) }) })
    heights.push({ kind: 'top', z: 0, label: probeText('probeScene155') })
    heights.push({ kind: 'depth', z: -fromTop.depthMm, label: probeText('probeScene156', { value1: String(fmt1(fromTop.depthMm)) }) })
  } else {
    heights.push({ kind: 'top', z: 0, label: probeText('probeScene157') })
    heights.push({ kind: 'start', z: start.z, label: probeText('probeScene158') })
    if (setup.routine === 'boss' || setup.routine === 'rectBoss') {
      const cross = plan.review.clearMotion.kind === 'boss-cross-over' ? plan.review.clearMotion.liftMm : cfg.crossOverLift
      heights.unshift({ kind: 'crossing', z: r4(start.z + cross), label: probeText('probeScene159', { value1: String(fmt1(cross)) }) })
    }
  }
  const scene = finish(setup, w, shapes, heights, start)
  // WO-2182: Angle marks its two touches on the face and the angle between
  // the line through them and the square axis.
  if (setup.routine === 'angle' && w.found.length === 2) {
    scene.angle = { points: [{ ...w.found[0] }, { ...w.found[1] }], nominalAxis: setup.angleNominalAxis, measuredDeg: null }
  }
  return scene
}

/** The material the side view's line crosses: [u0, u1, bottom, top, cut]. */
export function slice(shapes: Shape[], axis: WorkProbeAxis, at: number): Array<{ a: number; b: number; bottom: number; top: number; cut: boolean }> {
  const out: Array<{ a: number; b: number; bottom: number; top: number; cut: boolean }> = []
  for (const s of shapes) {
    if (s.kind === 'rect') {
      const [lo, hi] = axis === 'X' ? [s.y0, s.y1] : [s.x0, s.x1]
      if (at < lo || at > hi) continue
      const [a, b] = axis === 'X' ? [s.x0, s.x1] : [s.y0, s.y1]
      out.push({ a, b, bottom: s.bottom, top: s.top, cut: Boolean(s.cut) })
    } else if (s.kind === 'poly') {
      // WO-2182: where the section line crosses the outline, first to last.
      const hits: number[] = []
      for (let i = 0; i < s.pts.length; i++) {
        const p = s.pts[i]
        const q = s.pts[(i + 1) % s.pts.length]
        const [pc, qc] = axis === 'X' ? [p.y, q.y] : [p.x, q.x]
        const [pu, qu] = axis === 'X' ? [p.x, q.x] : [p.y, q.y]
        if (at < Math.min(pc, qc) || at > Math.max(pc, qc)) continue
        if (Math.abs(qc - pc) < 1e-12) hits.push(pu, qu)
        else hits.push(pu + ((qu - pu) * (at - pc)) / (qc - pc))
      }
      if (hits.length >= 2) out.push({ a: r4(Math.min(...hits)), b: r4(Math.max(...hits)), bottom: s.bottom, top: s.top, cut: Boolean(s.cut) })
    } else {
      const c = axis === 'X' ? s.cy : s.cx
      const d = Math.abs(at - c)
      if (d >= s.r) continue
      const half = Math.sqrt(s.r * s.r - d * d)
      const m = axis === 'X' ? s.cx : s.cy
      out.push({ a: m - half, b: m + half, bottom: s.bottom, top: s.top, cut: Boolean(s.cut) })
    }
  }
  return out
}

function axisOf(m: StepMove): 'X' | 'Y' | 'Z' {
  const dx = Math.abs(m.to.x - m.from.x)
  const dy = Math.abs(m.to.y - m.from.y)
  const dz = Math.abs(m.to.z - m.from.z)
  return dx >= dy && dx >= dz ? 'X' : dy >= dz ? 'Y' : 'Z'
}

/** The axis a step touches along (its first sideways probe move), if any. */
type ViewStep = Pick<ProbeStep, 'view' | 'touch' | 'moves' | 'at'>

function touchAxis(step: ViewStep): 'X' | 'Y' | 'Z' | null {
  if (!step.touch) return null
  const pm = step.moves.find((mm) => mm.kind === 'probe' && axisOf(mm) !== 'Z')
  return pm ? axisOf(pm) : null
}

/** Where the side view cuts the part for a step. A step touching along the
 *  view cuts where it touches; every other step keeps the cut of the nearest
 *  such touch seen the same way (the one before it, else the one after), so
 *  the part never jumps between steps - the Bore video cuts through the
 *  middle for every step, its Y walls too. With no such touch, where the
 *  step's probe is. */
export function sectionAt<S extends ViewStep>(scene: { steps: S[] }, step: S): number {
  const across = (p: P3, view: WorkProbeAxis) => (view === 'X' ? p.y : p.x)
  const along = (s: S) => touchAxis(s) === s.view && s.view === step.view
  if (along(step)) return across(step.touch!, step.view)
  const i = scene.steps.indexOf(step)
  const near = scene.steps.slice(0, Math.max(0, i)).reverse().find(along) ?? scene.steps.slice(i + 1).find(along)
  if (near) return across(near.touch!, step.view)
  return across(step.touch ?? (step.moves.length ? step.moves[0].from : step.at), step.view)
}

/** Whether the side view would draw the step's probe inside the part: a tip
 *  on its moves inside the material of the step's cut (Boss's front face seen
 *  through the middle - the probe would come down through the boss). */
export function drawnInsideMaterial<S extends ViewStep>(scene: { steps: S[]; shapes: Shape[] }, step: S): boolean {
  const pieces = slice(scene.shapes, step.view, sectionAt(scene, step))
  const eps = 0.01
  for (const m of step.moves) {
    for (let k = 0; k <= 20; k++) {
      const t = k / 20
      const u = (step.view === 'X' ? m.from.x + (m.to.x - m.from.x) * t : m.from.y + (m.to.y - m.from.y) * t)
      const z = m.from.z + (m.to.z - m.from.z) * t
      // The last piece holding the point wins: a cut (a hole) after the stock.
      let solid = false
      for (const q of pieces) {
        if (u > q.a + eps && u < q.b - eps && z < q.top - eps && z > q.bottom) solid = !q.cut
      }
      if (solid) return true
    }
  }
  return false
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function finalShow(setup: SceneSetup): string {
  if (setup.calibration) return probeText('probeScene160')
  switch (setup.routine) {
    case 'edge': return probeText('probeScene161', { value1: String(setup.edgeAxis) })
    case 'outsideCorner':
    case 'insideCorner': return probeText('probeScene162')
    case 'angle': return probeText('probeScene163')
    case 'bore':
    case 'boss': return probeText('probeScene164')
    case 'rectPocket':
    case 'rectBoss': return probeText('probeScene165')
    default: return ''
  }
}

function confirmSentence(setup: SceneSetup): string {
  if (setup.calibration) return probeText('probeScene167', { value1: String(setup.calibration.tool ?? probeText('probeScene166')) })
  switch (setup.routine) {
    case 'edge': return probeText('probeScene168', { value1: String(setup.edgeAxis), value2: String(setup.wcs) })
    case 'outsideCorner':
    case 'insideCorner': return probeText('probeScene169', { value1: String(setup.wcs) })
    default: return probeText('probeScene170', { value1: String(setup.wcs) })
  }
}

function whereSentence(setup: SceneSetup, sd: number, clear: number, mm: (v: number) => string, topMm: number | null = null, fromWorkZero = false): string {
  // WO-2108: the top touch searches only so far down.
  const above = topMm === null ? probeText('probeScene171') : probeText('probeScene172', { value1: String(mm(topMm)) })
  // WO-2114: a hole routine touches no top - it descends from this part's
  // work Z0, so that must be set on this part before it runs.
  const jog = fromWorkZero ? probeText('probeScene173', { value1: String(setup.wcs) }) : probeText('probeScene174')
  switch (setup.routine) {
    case 'edge': return probeText('probeScene175', { value1: String(mm(sd)), value2: String(faceName(setup.edgeAxis, setup.edgeDirection, false)), value3: String(above) })
    case 'outsideCorner': return probeText('probeScene176', { value1: String(cornerName(setup.cornerXDirection, setup.cornerYDirection, false)), value2: String(mm(sd)), value3: String(topMm === null ? '' : `, ${above}`) })
    case 'angle': {
      const probeAxis: WorkProbeAxis = setup.angleNominalAxis === 'X' ? 'Y' : 'X'
      return probeText('probeScene177', { value1: String(mm(sd)), value2: String(faceName(probeAxis, setup.angleProbeDirection, false)), value3: String(topMm === null ? '' : `, ${above}`) })
    }
    case 'insideCorner': return probeText('probeScene178', { value1: String(jog), value2: String(cornerName(setup.cornerXDirection, setup.cornerYDirection, true)), value3: String(mm(clear)) })
    case 'bore': return probeText('probeScene181', { value1: String(jog), value2: String(setup.calibration ? probeText('probeScene179') : probeText('probeScene180')) })
    case 'rectPocket': return probeText('probeScene182', { value1: String(jog) })
    case 'boss':
    case 'rectBoss': return probeText('probeScene185', { value1: String(jog), value2: String(setup.calibration ? probeText('probeScene183') : probeText('probeScene184')), value3: String(above) })
    default: return probeText('probeScene186')
  }
}

/** A positioning move's words inside a face's step. */
function positionPhrase(label: string, m: StepMove, mm: (v: number) => string): string {
  if (/back over the stock/i.test(label)) return probeText('probeScene187')
  if (/along face/i.test(label)) return probeText('probeScene188', { value1: String(moveLabel(m, mm)) })
  if (/around beside/i.test(label)) return probeText('probeScene189', { value1: String(moveLabel(m, mm)) })
  if (/back around/i.test(label)) return probeText('probeScene190')
  if (/^Position inside/i.test(label)) return probeText('probeScene191', { value1: String(moveLabel(m, mm)) })
  if (/Return toward start/i.test(label)) return probeText('probeScene192')
  if (/^Finish above/i.test(label)) return probeText('probeScene193')
  return probeText('probeScene194', { value1: String(moveLabel(m, mm)) })
}

function positionSentence(setup: SceneSetup, label: string, m: StepMove, lastStep: boolean, allTouched: boolean): string {
  const dz = m.to.z - m.from.z
  const horiz = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  if (/back over the stock/i.test(label)) return probeText('probeScene195')
  if (/along face/i.test(label)) return probeText('probeScene196', { value1: String(moveLabel(m)) })
  if (/around beside/i.test(label)) return probeText('probeScene197', { value1: String(moveLabel(m)) })
  if (/back around/i.test(label)) return probeText('probeScene198')
  if (/^Position inside/i.test(label)) return probeText('probeScene199', { value1: String(moveLabel(m)) })
  if (/Return toward start/i.test(label)) return allTouched && lastStep ? probeText('probeScene200') : probeText('probeScene201')
  if (/^Lift clear/i.test(label)) return probeText('probeScene204', { value1: String(moveLabel(m)), value2: String(setup.routine === 'rectBoss' ? probeText('probeScene202') : probeText('probeScene203')) })
  if (/^Cross above/i.test(label)) return probeText('probeScene205', { value1: String(moveLabel(m)) })
  if (/^Lower outside/i.test(label)) return probeText('probeScene206', { value1: String(moveLabel(m)) })
  if (/^Finish above/i.test(label)) return probeText('probeScene207')
  if (Math.abs(dz) > 1e-6 && horiz < 1e-6) return `${dz > 0 ? probeText('probeScene208') : probeText('probeScene209')} ${moveLabel(m)}.`
  return probeText('probeScene210', { value1: String(moveLabel(m)) })
}

function startZone(setup: SceneSetup, senseR: number, clear: number, mm: (v: number) => string, topMm: number | null = null): Zone {
  const zone = startZoneAnyHeight(setup, senseR, clear, mm)
  if (topMm === null) return zone
  // WO-2108: less than the top search above the top, never any height.
  return { ...zone, z1: Math.min(zone.z1, topMm), zMax: topMm, say: [zone.say[0], zone.say[1], probeText('probeScene211', { value1: String(mm(topMm)) }), probeText('probeScene212')], height: `< ${mm(topMm)}` }
}

function startZoneAnyHeight(setup: SceneSetup, senseR: number, clear: number, mm: (v: number) => string): Zone {
  const sd = setup.startDistanceMm
  const band = (_axis: WorkProbeAxis, direction: WorkProbeDirection) => {
    // The band over the material within `sd` of the face at 0.
    const s = sgn(direction)
    return s > 0 ? [0, sd] : [-sd, 0]
  }
  const across = 40
  switch (setup.routine) {
    case 'edge': {
      const [a0, a1] = band(setup.edgeAxis, setup.edgeDirection)
      const box = setup.edgeAxis === 'X'
        ? { x0: a0, x1: a1, y0: -across, y1: across }
        : { x0: -across, x1: across, y0: a0, y1: a1 }
      return { ...box, z0: 2, z1: 22, dim: { axis: setup.edgeAxis, from: a0, to: a1, label: mm(sd) }, say: [probeText('probeScene213', { value1: String(mm(sd)) }), probeText('probeScene214'), probeText('probeScene215'), probeText('probeScene216')] }
    }
    case 'outsideCorner': {
      const [x0, x1] = band('X', setup.cornerXDirection)
      const [y0, y1] = band('Y', setup.cornerYDirection)
      return { x0, x1, y0, y1, z0: 2, z1: 22, dim: { axis: 'X', from: x0, to: x1, label: mm(sd) }, say: [probeText('probeScene217', { value1: String(mm(sd)) }), probeText('probeScene218'), probeText('probeScene219'), probeText('probeScene220')] }
    }
    case 'angle': {
      const probeAxis: WorkProbeAxis = setup.angleNominalAxis === 'X' ? 'Y' : 'X'
      const [a0, a1] = band(probeAxis, setup.angleProbeDirection)
      const box = probeAxis === 'Y' ? { x0: -6, x1: 6, y0: a0, y1: a1 } : { x0: a0, x1: a1, y0: -6, y1: 6 }
      return { ...box, z0: 2, z1: 22, dim: { axis: probeAxis, from: a0, to: a1, label: mm(sd) }, say: [probeText('probeScene221', { value1: String(mm(sd)) }), probeText('probeScene222'), probeText('probeScene223'), probeText('probeScene224')] }
    }
    case 'insideCorner': {
      const sx = sgn(setup.cornerXDirection)
      const sy = sgn(setup.cornerYDirection)
      const x0 = sx > 0 ? -clear - senseR : 0
      const y0 = sy > 0 ? -clear - senseR : 0
      return {
        x0: sx > 0 ? x0 : senseR, x1: sx > 0 ? -senseR : clear + senseR, y0: sy > 0 ? y0 : senseR, y1: sy > 0 ? -senseR : clear + senseR,
        z0: 2, z1: 22,
        dim: { axis: 'X', from: sx > 0 ? -clear - senseR : senseR, to: sx > 0 ? -senseR : clear + senseR, label: mm(clear) },
        say: [probeText('probeScene225', { value1: String(mm(clear)) }), probeText('probeScene226'), probeText('probeScene227'), probeText('probeScene228')],
      }
    }
    default: {
      // Bore, Rect pocket, Boss, Rect boss: over the middle, within the
      // search's overtravel of it - every face then stays inside its search
      // (the Bore video: "within 5 mm of the centre"). No farther than the
      // clearance either: the move toward a wall stops that far short of it.
      const round = setup.routine === 'bore' || setup.routine === 'boss'
      const r = r4(Math.min(setup.config.overtravel, clear, Math.min(setup.sizeXmm, setup.sizeYmm) / 2))
      return {
        x0: -r, x1: r, y0: -r, y1: r, z0: 2, z1: 22, round,
        dim: { axis: 'X', from: -r, to: r, label: round ? `Ø ${fmt1(2 * r)}` : mm(2 * r) },
        say: [probeText('probeScene229', { value1: String(mm(r)) }), probeText('probeScene230'), probeText('probeScene231'), probeText('probeScene232')],
      }
    }
  }
}

function emptyScene(setup: SceneSetup, refusal: string, shapes: Shape[] = [], start: P3 = { x: 0, y: 0, z: ZS }): ProbeScene {
  return { routine: setup.routine, tipRadiusMm: setup.tipRadiusMm, shapes, heights: [], steps: [], start, refusal, tool: false }
}

function partDim(setup: SceneSetup): PartDim | null {
  switch (setup.routine) {
    case 'bore':
    case 'boss': return { kind: 'round', d: setup.sizeXmm, label: `Ø ${fmt1(setup.sizeXmm)}` }
    case 'rectPocket':
    case 'rectBoss': return { kind: 'rect', x: setup.sizeXmm, y: setup.sizeYmm, label: `${fmt1(setup.sizeXmm)} x ${fmt1(setup.sizeYmm)}` }
    default: return null
  }
}

function finish(setup: SceneSetup, w: Walk, shapes: Shape[], heights: HeightLine[], start: P3, tool = false): ProbeScene {
  return {
    partDim: partDim(setup),
    routine: setup.routine,
    tipRadiusMm: setup.tipRadiusMm,
    shapes,
    heights,
    steps: w.steps.map(({ group: _g, phrase: _p, lead: _l, ...s }, i) => {
      void _g; void _p; void _l
      // The touch lights where the move that first reaches it ends (the fast
      // pass); a step without such a mark lights at its last probe move.
      let touchMove: number | null = null
      if (s.touch) {
        const first = s.moves.findIndex((m) => m.touches)
        if (first >= 0) touchMove = first
        else s.moves.forEach((m, mi) => { if (m.kind === 'probe') touchMove = mi })
      }
      return { ...s, n: i + 1, touchMove }
    }),
    start,
    refusal: null,
    tool,
  }
}

/** Every searched touch's reach, for "More": the planner's own rule. */
export function sideSearchMm(cfg: EffectiveProbeConfig): number {
  return xyTouchSearchMm(cfg)
}
