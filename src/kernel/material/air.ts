// WO-3032 (alpha.3 A3-10b, parity): today's two air answers, asked of a
// material snapshot, with today's compensations read from the parity table
// (PARITY_COMPENSATIONS) rather than written into the code:
//
// - 2D rest air (WO-1888, src/lib/cam/restAir2d.ts): the cutter's bounding
//   square grown by the ONE-CELL PAD, air when z + 1e-3 >= the highest top under
//   it; whole passes dropped, air feed links demoted, arcs never judged air.
//   restAir2dPlan returns the decisions skipAirOnlyPasses makes (which blocks
//   drop, which links run at rapid, the counts it reports); emitting the moves
//   (the lift, the floor hop) stays the engine's.
//
// - 3D finish air feeds (WO-1641 / WO-2835, src/cam3d/integration/
//   airFeedOverRemovedStock.ts): a fed cutting move is demoted to rapid when the
//   sampled square clears the material by the HALF-CELL WIDENING in Z, and the
//   continuous proof from the earlier operations' own sweeps (widened by the
//   same half cell in XY and Z) certifies the cutter and the shank clear.
//   finishAirFeeds returns which moves are demoted; the floor hop is emission.
//
// Nothing here is a new rule: MD-50's single air rule is a policy value, OFF.
import type { Tool, ToolpathMove } from '../../types'
import { effectiveMoveMotion, effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'
import type { DropCutterSpec } from './contracts'
import { PARITY_COMPENSATIONS, type Compensation } from './policy'
import { topHeight, type MaterialView } from './queries'

function compensation(table: readonly Compensation[], name: Compensation['name']): Compensation {
  const entry = table.find(c => c.name === name)
  if (!entry) throw new Error(`material policy: the parity table has no "${name}" entry.`)
  return entry
}

// ── 2D rest air ───────────────────────────────────────────────────────────────

/** The cutter footprint radius the 2D rest air judges, or undefined for a tool it leaves alone. */
export function restAirRadius(tool: Tool): number | undefined {
  if (!(tool.diameter > 0) || !Number.isFinite(tool.diameter)) return undefined
  switch (tool.type) {
    case 'flat_end_mill':
    case 'face_mill':
    case 'ball_end_mill':
    case 'bull_nose':
      return tool.diameter / 2
    default:
      return undefined
  }
}

interface Point3 { readonly x: number; readonly y: number; readonly z: number }

/** The 2D rest-air point test: nothing under the padded square reaches z. */
export function restAirClears(view: MaterialView, x: number, y: number, z: number, radius: number,
  table: readonly Compensation[] = PARITY_COMPENSATIONS): boolean {
  const pad = compensation(table, 'one-cell pad')
  const reach = radius + pad.xyCells * view.field.cell
  const top = topHeight(view, { minX: x - reach, minY: y - reach, maxX: x + reach, maxY: y + reach })
  if (top === undefined) return true
  return z + (pad.zToleranceMm ?? 0) >= top
}

function segmentClears(view: MaterialView, start: Point3, end: Point3, radius: number, step: number,
  table: readonly Compensation[]): boolean {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z
  const length = Math.hypot(dx, dy, dz)
  const samples = Math.max(1, Math.ceil(length / step))
  for (let sample = 0; sample <= samples; sample++) {
    const t = sample / samples
    if (!restAirClears(view, start.x + dx * t, start.y + dy * t, start.z + dz * t, radius, table)) return false
  }
  return true
}

/** A rapid is proved at the lower of its two ends along its whole XY line. */
function traverseClears(view: MaterialView, from: Point3, to: Point3, radius: number, step: number,
  table: readonly Compensation[]): boolean {
  const z = Math.min(from.z, to.z)
  return segmentClears(view, { x: from.x, y: from.y, z }, { x: to.x, y: to.y, z }, radius, step, table)
}

const isPass = (move: ToolpathMove) => effectiveMoveMotion(move) === 'pass'

export interface RestAir2dPlan {
  /** Programmed passes in the input path. */
  readonly passes: number
  /** Of those, the ones the remaining material proved air end to end. */
  readonly skippedPasses: number
  /** Feed-rate links demoted to rapid. */
  readonly rapidedLinks: number
  /** Cutting distance the skip removes, mm. */
  readonly cutLengthRemovedMm: number
  /** Dropped blocks, inclusive move indices. */
  readonly droppedBlocks: readonly (readonly [number, number])[]
  /** Indices of the feed links that run at rapid. */
  readonly airLinks: readonly number[]
}

/**
 * The 2D rest-air decisions for a finished path over a snapshot: today's
 * skipAirOnlyPasses, decision for decision. Unchanged (no drops, no links) for
 * a tool the square footprint does not describe.
 */
export function restAir2dPlan(view: MaterialView, moves: readonly ToolpathMove[], tool: Tool, retractZ: number,
  table: readonly Compensation[] = PARITY_COMPENSATIONS): RestAir2dPlan {
  const none: RestAir2dPlan = { passes: 0, skippedPasses: 0, rapidedLinks: 0, cutLengthRemovedMm: 0, droppedBlocks: [], airLinks: [] }
  const radius = restAirRadius(tool)
  if (radius === undefined || moves.length === 0) return none
  const step = Math.max(view.field.cell / 2, 1e-3)

  let passes = 0
  for (let index = 0; index < moves.length; index++) {
    if (isPass(moves[index]) && (index === 0 || !isPass(moves[index - 1]))) passes++
  }

  const air = new Array<boolean>(moves.length).fill(false)
  const cuts = new Array<boolean>(moves.length).fill(false)
  for (let index = 1; index < moves.length; index++) {
    const move = moves[index]
    cuts[index] = isStockCuttingRole(effectiveMoveRole(move))
    if (!cuts[index] || move.type !== 'feed') continue
    air[index] = segmentClears(view, moves[index - 1], move, radius, step, table)
  }

  const liftZFor = (from: Point3) => Number.isFinite(retractZ) && from.z < retractZ - 1e-9 ? retractZ : undefined
  const dropped: [number, number][] = []
  let skippedPasses = 0
  let cutLengthRemovedMm = 0
  let blockStart = -1
  for (let index = 1; index <= moves.length; index++) {
    const droppable = index < moves.length && cuts[index] && air[index]
    if (droppable) {
      if (blockStart < 0) blockStart = index
      continue
    }
    if (blockStart < 0) continue
    const first = blockStart
    const last = index - 1
    blockStart = -1
    let blockPasses = 0
    for (let at = first; at <= last; at++) {
      if (isPass(moves[at]) && (at === first || !isPass(moves[at - 1]))) blockPasses++
    }
    if (blockPasses === 0) continue
    if (isPass(moves[first]) && isPass(moves[first - 1])) continue
    if (last < moves.length - 1 && moves[last + 1].type !== 'rapid') continue
    if (last < moves.length - 1) {
      const from = moves[first - 1]
      const startZ = liftZFor(from) ?? from.z
      if (!traverseClears(view, { x: from.x, y: from.y, z: startZ }, moves[last + 1], radius, step, table)) continue
    }
    dropped.push([first, last])
    skippedPasses += blockPasses
    for (let at = first; at <= last; at++) {
      const from = moves[at - 1]
      const to = moves[at]
      cutLengthRemovedMm += Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
    }
  }

  const airLinkAt = (index: number): boolean => {
    const move = moves[index]
    if (!air[index] || move.type !== 'feed' || effectiveMoveMotion(move) !== 'link') return false
    return traverseClears(view, moves[index - 1], move, radius, step, table)
  }
  const starts = new Map(dropped.map(([first, last]) => [first, last]))
  const airLinks: number[] = []
  let hasAirLink = false
  for (let index = 1; index < moves.length; index++) if (airLinkAt(index)) { hasAirLink = true; break }
  if (skippedPasses > 0 || hasAirLink) {
    let index = 0
    while (index < moves.length) {
      const end = starts.get(index)
      if (end !== undefined) { index = end + 1; continue }
      if (airLinkAt(index)) airLinks.push(index)
      index++
    }
  }
  return { passes, skippedPasses, rapidedLinks: airLinks.length, cutLengthRemovedMm, droppedBlocks: dropped, airLinks }
}

// ── 3D finish air feeds ───────────────────────────────────────────────────────

type RadialCutter = Exclude<DropCutterSpec, { kind: 'vbit' }>
interface Rect { minX: number; minY: number; maxX: number; maxY: number }
interface Sweep { a: Point3; b: Point3; cutter: RadialCutter; deviation: number }
const ROUND_OFF_MM = 1e-9

/** One earlier operation as the continuous proof reads it: its own moves and its drop-cutter spec. */
export interface FinishAirPreceding {
  readonly enabled: boolean
  readonly status: string
  readonly moves: readonly ToolpathMove[] | undefined
  /** dropCutterSpec from the one tool-shape source; undefined where today's toolToCutterSpec throws. */
  readonly cutter: DropCutterSpec | undefined
  readonly fluteLength: number | undefined
}

export interface FinishAirInput {
  /** The finish's moves, in the snapshot's frame. */
  readonly moves: readonly ToolpathMove[]
  /** The finish tool's drop-cutter spec (dropCutterSpec). */
  readonly cutter: DropCutterSpec
  readonly fluteLength: number
  readonly shankDiameter: number
  readonly preceding?: readonly FinishAirPreceding[]
}

export interface FinishAirFeeds {
  /** Fed cutting moves considered. */
  readonly candidates: number
  /** Indices demoted to rapid, endpoints unchanged. */
  readonly demoted: readonly number[]
}

function radialProfile(cutter: RadialCutter, distance: number): number {
  const r = cutter.diameter / 2
  if (distance > r) return Infinity
  if (cutter.kind === 'flat') return 0
  const corner = cutter.kind === 'ball' ? r : cutter.cornerRadius
  const d = Math.max(0, distance - (r - corner))
  return corner - Math.sqrt(Math.max(0, corner * corner - d * d))
}

function distanceToLine(x: number, y: number, a: Point3, b: Point3): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy)
}

/** The continuous certificate from the earlier operations' own sweeps (today's physicalRemovalProof). */
function physicalProof(view: MaterialView & { readonly stock: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } },
  input: FinishAirInput, widen: Compensation): (a: Point3, b: Point3) => boolean {
  const bounds = view.stock
  const binMm = 8, cellMm = 0.5
  const bins = new Map<string, Sweep[]>()
  const cache = new Map<string, number>()
  const key = (i: number, j: number): string => `${i},${j}`
  const add = (sweep: Sweep): void => {
    const r = sweep.cutter.diameter / 2
    const x0 = Math.max(bounds.minX, Math.min(sweep.a.x, sweep.b.x) - r)
    const x1 = Math.min(bounds.maxX, Math.max(sweep.a.x, sweep.b.x) + r)
    const y0 = Math.max(bounds.minY, Math.min(sweep.a.y, sweep.b.y) - r)
    const y1 = Math.min(bounds.maxY, Math.max(sweep.a.y, sweep.b.y) + r)
    for (let j = Math.floor(y0 / binMm); j <= Math.floor(y1 / binMm); j++) {
      for (let i = Math.floor(x0 / binMm); i <= Math.floor(x1 / binMm); i++) {
        const k = key(i, j)
        const bucket = bins.get(k)
        if (bucket) bucket.push(sweep)
        else bins.set(k, [sweep])
      }
    }
  }
  for (const operation of input.preceding ?? []) {
    if (!operation.enabled || operation.status !== 'ready' || !operation.cutter || !operation.moves) continue
    const cutter = operation.cutter
    const flute = operation.fluteLength
    if (cutter.kind === 'vbit' || flute === undefined || !Number.isFinite(flute) || flute <= 0) continue
    const moves = operation.moves
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], b = moves[i]
      if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) continue
      if (b.type === 'rapid') continue
      if (Math.min(a.z, b.z) + flute < bounds.maxZ + ROUND_OFF_MM) continue
      if (b.type === 'feed') { add({ a, b, cutter, deviation: ROUND_OFF_MM }); continue }
      if (!Number.isFinite(b.cx) || !Number.isFinite(b.cy)) continue
      const cx = b.cx!, cy = b.cy!, r = Math.hypot(a.x - cx, a.y - cy)
      if (!(r > 0) || Math.abs(r - Math.hypot(b.x - cx, b.y - cy)) > ROUND_OFF_MM) continue
      const sign = b.type === 'arc_ccw' ? 1 : -1
      const angle = Math.atan2(a.y - cy, a.x - cx)
      let sweep = sign * (Math.atan2(b.y - cy, b.x - cx) - angle)
      while (sweep <= 0) sweep += 2 * Math.PI
      const count = Math.max(1, Math.ceil(sweep / (Math.PI / 16)), Math.ceil(r * sweep / cellMm))
      if (count > 4096) continue
      const deviation = r * (1 - Math.cos(sweep / count / 2)) + 2 * ROUND_OFF_MM
      let from: Point3 = a
      for (let n = 1; n <= count; n++) {
        const t = n / count, theta = angle + sign * sweep * t
        const to: Point3 = n === count ? b : { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta), z: a.z + (b.z - a.z) * t }
        add({ a: from, b: to, cutter, deviation })
        from = to
      }
    }
  }
  const topOver = (rect: Rect): number => {
    const k = `${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`
    const cached = cache.get(k)
    if (cached !== undefined) return cached
    let top = bounds.maxZ
    const list = bins.get(key(Math.floor((rect.minX + rect.maxX) / 2 / binMm), Math.floor((rect.minY + rect.maxY) / 2 / binMm))) ?? []
    for (const s of list) {
      const d = Math.max(
        distanceToLine(rect.minX, rect.minY, s.a, s.b), distanceToLine(rect.maxX, rect.minY, s.a, s.b),
        distanceToLine(rect.minX, rect.maxY, s.a, s.b), distanceToLine(rect.maxX, rect.maxY, s.a, s.b),
      ) + s.deviation
      top = Math.min(top, Math.max(s.a.z, s.b.z) + radialProfile(s.cutter, d) + ROUND_OFF_MM)
    }
    top = Math.max(bounds.minZ, top)
    cache.set(k, top)
    return top
  }
  const cutter = input.cutter
  if (cutter.kind === 'vbit' || !Number.isFinite(input.fluteLength) || input.fluteLength <= 0
    || !Number.isFinite(input.shankDiameter) || input.shankDiameter <= 0) return () => false
  const bandXY = view.field.cell * widen.xyCells
  const bandZ = view.field.cell * (widen.zCells ?? 0)
  const clears = (a: Point3, b: Point3, shape: RadialCutter, offset: number): boolean => {
    const r = shape.diameter / 2 + bandXY
    const low = Math.min(a.z, b.z) + offset - bandZ
    if (low > bounds.maxZ + ROUND_OFF_MM) return true
    const visit = (rect: Rect, depth: number): boolean => {
      const x = (rect.minX + rect.maxX) / 2, y = (rect.minY + rect.maxY) / 2
      const half = Math.hypot(rect.maxX - rect.minX, rect.maxY - rect.minY) / 2
      const near = Math.max(0, distanceToLine(x, y, a, b) - half - bandXY - ROUND_OFF_MM)
      if (near > shape.diameter / 2) return true
      const top = topOver(rect)
      if (top <= bounds.minZ || low + radialProfile(shape, near) > top + ROUND_OFF_MM) return true
      if (depth === 4) return false
      return visit({ ...rect, maxX: x, maxY: y }, depth + 1)
        && visit({ ...rect, minX: x, maxY: y }, depth + 1)
        && visit({ ...rect, maxX: x, minY: y }, depth + 1)
        && visit({ ...rect, minX: x, minY: y }, depth + 1)
    }
    const minX = Math.max(bounds.minX, Math.min(a.x, b.x) - r)
    const maxX = Math.min(bounds.maxX, Math.max(a.x, b.x) + r)
    const minY = Math.max(bounds.minY, Math.min(a.y, b.y) - r)
    const maxY = Math.min(bounds.maxY, Math.max(a.y, b.y) + r)
    for (let y = Math.floor(minY / cellMm) * cellMm; y < maxY; y += cellMm) {
      for (let x = Math.floor(minX / cellMm) * cellMm; x < maxX; x += cellMm) {
        if (!visit({ minX: Math.max(x, bounds.minX), minY: Math.max(y, bounds.minY),
          maxX: Math.min(x + cellMm, bounds.maxX), maxY: Math.min(y + cellMm, bounds.maxY) }, 0)) return false
      }
    }
    return true
  }
  return (a, b) => clears(a, b, cutter, 0) && clears(a, b, { kind: 'flat', diameter: input.shankDiameter }, input.fluteLength)
}

/**
 * Which fed cutting moves of a 3D finish run at rapid over the snapshot:
 * today's rapidAirFeedsOverRemovedStock decision, move for move. A V-bit is
 * left alone (its flank is not a square around its tip), as today.
 */
export function finishAirFeeds(view: MaterialView & { readonly stock: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } },
  input: FinishAirInput, table: readonly Compensation[] = PARITY_COMPENSATIONS): FinishAirFeeds {
  const { moves, cutter } = input
  if (cutter.kind === 'vbit') return { candidates: 0, demoted: [] }
  const widen = compensation(table, 'half-cell widening')
  const radius = cutter.diameter / 2
  const margin = view.field.cell * (widen.zCells ?? 0)
  const step = Math.max(view.field.cell / 2, 1e-3)
  const physical = physicalProof(view, input, widen)
  const clearsAt = (x: number, y: number, z: number): boolean => {
    const top = topHeight(view, { minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius })
    if (top === undefined) return true
    return z >= top + margin
  }
  let candidates = 0
  const demoted: number[] = []
  let previous: ToolpathMove | undefined
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index]
    const start = previous
    previous = move
    if (move.type !== 'feed') continue
    if (!isStockCuttingRole(effectiveMoveRole({ type: 'feed', role: move.role }))) continue
    candidates++
    if (!start) continue
    const dx = move.x - start.x, dy = move.y - start.y, dz = move.z - start.z
    const length = Math.hypot(dx, dy, dz)
    const samples = Math.max(1, Math.ceil(length / step))
    let clear = true
    for (let sample = 0; sample <= samples && clear; sample++) {
      const t = sample / samples
      clear = clearsAt(start.x + dx * t, start.y + dy * t, start.z + dz * t)
    }
    if (!clear || !physical(start, move)) continue
    demoted.push(index)
  }
  return { candidates, demoted }
}
