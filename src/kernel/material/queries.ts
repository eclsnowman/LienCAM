// WO-3032 (alpha.3 A3-10b, parity): the material queries on a snapshot.
//   topHeight(region)                     today's highestMaterialOver (WO-1609)
//   remainingWithin(region, min thickness) today's uncut-area count (carveCoverage)
//   airAlong(moves)                        today's air read along a path (collectAlpha3)
// Read-only on the snapshot (airAlong carves its own moves into a clone) and
// deterministic: j outer, i inner, fixed order. Queries are never refused.
import type { ToolpathMove } from '../../types'
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'
import type { RemovedDefinition, SweepShape } from './contracts'
import type { DexelField } from './dexel'
import { moveIntrusion } from './removed'
import { moveSweeps, PARITY_REPLAY } from './replay'
import { sweepMove } from './sweep'

/** A plan-view rectangle in the snapshot's frame. */
export interface RegionXY {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/** The read-only part of a snapshot a query needs. */
export interface MaterialView {
  readonly field: DexelField
}

/** Inclusive column range a rectangle touches (every touched column counts), or undefined off the block. */
function touched(field: DexelField, region: RegionXY): [number, number, number, number] | undefined {
  const values = [region.minX, region.minY, region.maxX, region.maxY]
  if (values.some(value => !Number.isFinite(value))) return undefined
  if (region.maxX < region.minX || region.maxY < region.minY) return undefined
  const cell = field.cell
  const i0 = Math.max(0, Math.floor((region.minX - field.originX) / cell))
  const i1 = Math.min(field.nx - 1, Math.ceil((region.maxX - field.originX) / cell) - 1)
  const j0 = Math.max(0, Math.floor((region.minY - field.originY) / cell))
  const j1 = Math.min(field.ny - 1, Math.ceil((region.maxY - field.originY) / cell) - 1)
  // A zero-width region still names the column it sits in.
  const iHi = Math.max(i0, i1)
  const jHi = Math.max(j0, j1)
  if (i0 >= field.nx || j0 >= field.ny || iHi < 0 || jHi < 0) return undefined
  return [i0, Math.min(iHi, field.nx - 1), j0, Math.min(jHi, field.ny - 1)]
}

/**
 * The highest material still standing anywhere over `region`: every column the
 * rectangle touches counts, so the answer can be too high (cutting some air),
 * never too low. A column cut through reads as the stock bottom. Undefined when
 * the region lies wholly outside the stock.
 */
export function topHeight(view: MaterialView, region: RegionXY): number | undefined {
  const { field } = view
  const range = touched(field, region)
  if (!range) return undefined
  const [i0, i1, j0, j1] = range
  let highest = field.bottom[0]
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const top = field.top[j * field.nx + i]
      if (top > highest) highest = top
    }
  }
  return highest
}

export interface RemainingWithinQuery {
  /** The floor material is measured from: one height, or one per column (index j * nx + i); non-finite = outside. */
  readonly floorZ: number | ArrayLike<number>
  /** Material thinner than this above the floor is not counted (today's UNCUT_TOLERANCE_MM is 0.2). */
  readonly minThicknessMm: number
  /** Columns the rectangle touches; absent: the whole field. */
  readonly region?: RegionXY
}

export interface RemainingWithin {
  /** Columns holding more than the minimum thickness above their floor. */
  readonly columns: number
  readonly areaMm2: number
}

/** Where material more than `minThicknessMm` thick still stands above the floor. */
export function remainingWithin(view: MaterialView, query: RemainingWithinQuery): RemainingWithin {
  const { field } = view
  const all: [number, number, number, number] = [0, field.nx - 1, 0, field.ny - 1]
  const range = query.region ? touched(field, query.region) : all
  if (!range) return { columns: 0, areaMm2: 0 }
  const [i0, i1, j0, j1] = range
  const floor = query.floorZ
  let columns = 0
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * field.nx + i
      const z = typeof floor === 'number' ? floor : floor[c]
      if (Number.isFinite(z) && field.top[c] > z + query.minThicknessMm) columns++
    }
  }
  return { columns, areaMm2: columns * (field.cell * field.cell) }
}

/** Length of a persisted move, arcs along the arc (today's benchmark moveLength). */
export function pathLength(from: { x: number; y: number; z: number }, move: ToolpathMove): number {
  if ((move.type !== 'arc_cw' && move.type !== 'arc_ccw') || typeof move.cx !== 'number' || typeof move.cy !== 'number') {
    return Math.hypot(move.x - from.x, move.y - from.y, move.z - from.z)
  }
  const radius = Math.hypot(from.x - move.cx, from.y - move.cy)
  const a0 = Math.atan2(from.y - move.cy, from.x - move.cx)
  let a1 = Math.atan2(move.y - move.cy, move.x - move.cx)
  if (move.type === 'arc_cw') {
    while (a1 > a0) a1 -= 2 * Math.PI
  } else {
    while (a1 < a0) a1 += 2 * Math.PI
  }
  const sweep = Math.abs(a1 - a0)
  return Math.hypot(radius * (sweep < 1e-12 ? 2 * Math.PI : sweep), move.z - from.z)
}

/** Detection tolerance of the air rule, mm (alpha3-17 A.2 M-AIR-1, as today). */
export const AIR_DETECTION_TOLERANCE_MM = 1e-3

export interface AirAlongOptions {
  readonly removed?: RemovedDefinition
  readonly padMm?: number
}

export interface AirAlong {
  /** Per move (index 0 is the start point): deepest intrusion into standing material, -Infinity when none. */
  readonly intrusionMm: Float64Array
  /** Per move: a fed move (not a rapid) of positive length whose sweep meets no material beyond the tolerance. */
  readonly air: Uint8Array
  /** Per move: its length (arcs along the arc). */
  readonly lengthMm: Float64Array
  /** Deepest intrusion of a non-cutting move into standing material (0 when none). */
  readonly nonCuttingIntrusionMm: number
  /** Total length of the air moves. */
  readonly airLengthMm: number
  /** The material after this path, on a clone of the snapshot's field. */
  readonly after: DexelField
}

/**
 * Walk a path over the snapshot the way the machine meets it: per move, read
 * how deep its swept cutter runs into the material standing at that instant,
 * then take out what a cutting move removes. The A.5 collector's read
 * (collectAlpha3): arcs as chords at a quarter cell, intrusion before removal,
 * today's centre rule with no pad under the parity policy.
 */
export function airAlong(view: MaterialView, moves: readonly ToolpathMove[], shape: SweepShape,
  options: AirAlongOptions = {}): AirAlong {
  const removed = options.removed ?? 'centre'
  const pad = options.padMm ?? 0
  const field = view.field.clone()
  const n = moves.length
  const intrusionMm = new Float64Array(n).fill(Number.NEGATIVE_INFINITY)
  const air = new Uint8Array(n)
  const lengthMm = new Float64Array(n)
  let nonCutting = 0
  let airLength = 0
  const sagitta = field.cell * PARITY_REPLAY.sagittaCells
  for (let i = 1; i < n; i++) {
    const m = moves[i]
    const from = moves[i - 1]
    const cuts = isStockCuttingRole(effectiveMoveRole(m))
    const length = pathLength(from, m)
    lengthMm[i] = length
    let worst = Number.NEGATIVE_INFINITY
    moveSweeps(from, m, sagitta, sweep => {
      const hit = moveIntrusion(field, sweep, shape, removed, pad).intrusionMm
      if (hit > worst) worst = hit
      if (cuts) sweepMove(field, sweep, shape, removed)
    })
    intrusionMm[i] = worst
    if (!cuts) nonCutting = Math.max(nonCutting, worst)
    if (m.type !== 'rapid' && length > 0 && worst <= AIR_DETECTION_TOLERANCE_MM) {
      air[i] = 1
      airLength += length
    }
  }
  return { intrusionMm, air, lengthMm, nonCuttingIntrusionMm: Math.max(0, nonCutting), airLengthMm: airLength, after: field }
}
