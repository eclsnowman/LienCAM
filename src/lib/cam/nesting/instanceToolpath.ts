/* Instanced toolpath transform (ADR 0024 sections 2-3).
 *
 * PURE helpers, no store / DOM / worker imports. P6 Item 2.
 *
 * A nest seed op computes its toolpath ONCE, expressed in the seed's LOCAL 2D
 * frame (P6 Item 1). These helpers map those local moves into nest-world per
 * placement, using the instance transform
 *
 *     M(p) = translate(p.x, p.y) . rotate(p.rotationDeg)
 *
 * then offset by the nest's world origin:
 *
 *     world = origin + M(p) . local
 *
 * Per ADR 0024 section 2 the transform is applied to the move endpoint (x, y)
 * AND the absolute arc center (cx, cy) when present. `z`, `feed`, `role`,
 * `engagement`, and the move `type` (including arc direction arc_cw / arc_ccw)
 * are UNTOUCHED: a pure rotation + translation preserves arc handedness and
 * feedrate-by-role; no mirror is used.
 *
 * P7 (the postprocessor) consumes these helpers to replicate the seed's moves
 * per placement, innermost-first (section 3). The inter-copy travel/link
 * sequence (retract -> rapid -> plunge) between placement groups is P7's job
 * and needs the op's height data this pure helper does not own, so it is NOT
 * inserted here.
 */

import type { ImportedGeometry, ToolpathMove, Vec2 } from '../../../types/index'
import { effectiveZRotationDeg } from '../../../store/dispatchGeo'
import type { Placement } from './types'

/** Apply M(placement) = translate(x,y) . rotate(rotationDeg) to a local point,
 *  then add the nest world origin. Pure: returns a new {x,y}. */
function applyPlacement(
  lx: number,
  ly: number,
  placement: Placement,
  origin: Vec2,
): { x: number; y: number } {
  const rad = (placement.rotationDeg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  // rotate local point about its own origin, then translate by the placement
  // pose, then offset by the nest world origin.
  const rx = lx * c - ly * s
  const ry = lx * s + ly * c
  return {
    x: origin.x + placement.x + rx,
    y: origin.y + placement.y + ry,
  }
}

/** Map ONE seed-local move into nest-world for a placement. Returns a NEW move;
 *  the input is not mutated. Endpoint (x,y) and absolute arc center (cx,cy) are
 *  both transformed; z / feed / role / engagement / type are copied unchanged
 *  (ADR 0024 section 2). */
export function instanceMove(
  move: ToolpathMove,
  placement: Placement,
  origin: Vec2,
): ToolpathMove {
  const end = applyPlacement(move.x, move.y, placement, origin)
  const out: ToolpathMove = {
    type: move.type,
    x: end.x,
    y: end.y,
    z: move.z,
  }
  if (move.feed !== undefined) out.feed = move.feed
  if (move.role !== undefined) out.role = move.role
  if (move.engagement !== undefined) out.engagement = move.engagement
  if (move.cx !== undefined && move.cy !== undefined) {
    const ctr = applyPlacement(move.cx, move.cy, placement, origin)
    out.cx = ctr.x
    out.cy = ctr.y
  }
  return out
}

/** Map an array of seed-local moves into nest-world for one placement. Pure:
 *  returns a new array of new moves. */
export function instanceMoves(
  localMoves: ToolpathMove[],
  placement: Placement,
  origin: Vec2,
): ToolpathMove[] {
  return localMoves.map((m) => instanceMove(m, placement, origin))
}

/** Offset a SEED op's local moves onto the seed's slot pose for VIEWPORT
 *  rendering (P6 Item 3a). A nest seed op computes its toolpath ONCE in the
 *  seed's LOCAL 2D frame (geometry pose NOT baked); the owned-seed geometry's
 *  `position` (x, y) + effective Z rotation ARE its slot world pose (written by
 *  applyNestResult, tracked live by translateBoundNest). So the render offset is
 *  exactly that pose applied to each local move.
 *
 *  Reuses the same rotate+translate as instanceMove by synthesizing a Placement
 *  from the pose with a zero nest origin: the rotation is the geometry's
 *  EFFECTIVE Z angle (effectiveZRotationDeg — robust to the gizmo quaternion ->
 *  Euler round-trip, matching transformLoopPoints used to render the seed loops,
 *  src/store/dispatchGeo.ts), and the translation is position.x / position.y.
 *  Endpoint (x, y) and absolute arc center (cx, cy) are transformed;
 *  z / feed / role / engagement / type are untouched. Pure: a NEW array of NEW
 *  moves, the input is not mutated. An identity pose (pos 0, rot 0) returns
 *  geometrically unchanged moves. This is a RENDER-ONLY transform — the stored
 *  op.toolpathMoves stay in the local frame; the post (P7) replicates per
 *  placement instead. */
export function seedSlotMoves(
  localMoves: ToolpathMove[],
  geometry: ImportedGeometry,
): ToolpathMove[] {
  const placement: Placement = {
    partId: geometry.id,
    instanceId: geometry.id,
    x: geometry.position.x,
    y: geometry.position.y,
    rotationDeg: effectiveZRotationDeg(geometry.rotation),
    depth: 0,
  }
  return instanceMoves(localMoves, placement, { x: 0, y: 0 })
}

/** Render-time gate shared by the toolpath viewport AND the simulation panel.
 *  A nest seed op stores its toolpathMoves in the seed's LOCAL 2D frame (P6
 *  Item 1); drawn raw they sit at the world origin, detached from the seed's
 *  slot. When the op's bound geometry is an owned seed (ownerNestId set), offset
 *  the local moves onto the slot pose via seedSlotMoves so they land ON the seed.
 *  A non-seed geo (no ownerNestId), or no geo at all, returns the SAME array
 *  reference unchanged — non-seed render paths stay byte-identical. Pure. */
export function renderMovesForGeo(
  localMoves: ToolpathMove[],
  geometry: ImportedGeometry | undefined,
): ToolpathMove[] {
  if (!geometry || geometry.ownerNestId === undefined) return localMoves
  return seedSlotMoves(localMoves, geometry)
}

/** Render-rebuild-key fragment for a bound geometry's SEED POSE. Moving a bound
 *  stock translates/rotates the owned seed geometry (translateBoundNest), which
 *  changes where renderMovesForGeo / seedSlotMoves places the path. The render
 *  effects key off move COUNTS, which do not change on a pose move, so the effect
 *  would not re-fire. Folding this fragment into that key makes a pose change
 *  re-trigger the rebuild. Returns "" for a non-seed geo (no ownerNestId) or no
 *  geo, so non-seed keys stay byte-identical to today. Pure. */
export function seedPoseKeyForGeo(geometry: ImportedGeometry | undefined): string {
  if (!geometry || geometry.ownerNestId === undefined) return ''
  const p = geometry.position
  return `${p.x},${p.y},${effectiveZRotationDeg(geometry.rotation)}`
}

/** Innermost-first cut order (ADR 0024 section 3): depth DESCENDING, so every
 *  windowed child (depth 1) is emitted before any depth-0 host. Stable,
 *  deterministic tie-break WITHIN a depth tier by instanceId ascending. Pure:
 *  returns a NEW array, does not sort in place. */
export function orderPlacementsInnermostFirst(
  placements: Placement[],
): Placement[] {
  return [...placements].sort((a, b) => {
    if (a.depth !== b.depth) return b.depth - a.depth // depth descending
    // deterministic tie-break within a depth tier
    if (a.instanceId < b.instanceId) return -1
    if (a.instanceId > b.instanceId) return 1
    return 0
  })
}

/** Expand the seed's local move stream across all placements, innermost-first.
 *  Returns the per-placement groups (each placement paired with its instanced
 *  moves) in cut order.
 *
 *  P7 (the post) will insert the inter-copy TRAVEL/link sequence (retract to
 *  clearance -> rapid to the next copy's entry -> plunge) BETWEEN these groups
 *  using the op's height data. That travel is deliberately NOT inserted here:
 *  this pure helper does not own height information. */
export function expandSourceMoves(
  localMoves: ToolpathMove[],
  placements: Placement[],
  origin: Vec2,
): { placement: Placement; moves: ToolpathMove[] }[] {
  return orderPlacementsInnermostFirst(placements).map((placement) => ({
    placement,
    moves: instanceMoves(localMoves, placement, origin),
  }))
}

/* ---------------------------------------------------------------------------
 * P7 NEST EXPANDER (ADR 0024 Amendment 1).
 *
 * The full, pure, nest-level expander. It turns a nest's seed-local op
 * toolpaths into the complete multi-copy ToolpathMove[] stream that the
 * Toolpath view, the Simulation, the cut-time estimate, and the post all
 * consume identically. Inter-copy TRAVEL (retract -> rapid -> plunge) and the
 * machining ORDER are generated HERE, in software, as real moves so the
 * operator sees and simulates them (clamp/workholding crash risk) — the post
 * only formats the result. The seed op toolpaths stay stored seed-local
 * (option (b)); this expander is re-derived on demand from them.
 *
 * Heights are resolved by the CALLER (resolveHeights) and handed in per op via
 * SeedOpExpansionInput, so this stays pure (no store / stock / wcs access) and
 * the travel Z always matches the op's own planes. No new Z vocabulary
 * (ADR 0002): only clearanceZ / retractZ / feedZ.
 * ------------------------------------------------------------------------- */

/** One seed op's expansion input. The caller resolves the absolute Z planes
 *  (resolveHeights) and supplies the seed-local move stream (P6 storage). */
export interface SeedOpExpansionInput {
  opId: string
  toolId: string
  /** op.params.geometryId — matched against Placement.partId. */
  sourceGeometryId: string
  localMoves: ToolpathMove[]
  clearanceZ: number
  retractZ: number
  feedZ: number
  retractMode?: 'clearance' | 'retract'
}

/* ---------------------------------------------------------------------------
 * WO-1827 COMMON-EDGE EMISSION.
 *
 * With common-edge nesting on (solver.ts applyCommonEdges) two adjacent copies
 * are pulled together until their facing profiles land on ONE line. That line
 * belongs to BOTH parts, and cutting it twice is the defect: the second pass
 * runs a cutter down a slot that is already open, which is wasted time on a
 * router and a wrecked edge on a laser or plasma.
 *
 * The expander therefore emits each shared line exactly ONCE PER OP. The first
 * copy of an op to trace the line (in emission order) cuts it; every later copy
 * of that SAME op that traces it retracts, rapids across the span at safe Z and
 * plunges back in on the far side, so its remaining contour is untouched. The
 * bookkeeping is per (line, op) and NOT per line, because two different ops over
 * one profile - a rough and a finish, or two Z passes of the same op - are not
 * redundant with each other. Two copies of one op are.
 *
 * MATCHING IS GEOMETRIC, NOT DECLARATIVE. A line is only skipped where the move
 * stream actually contains a straight cut from one of its endpoints to the
 * other. A wrong ownership claim - a line named between two copies that do not
 * really meet along it - therefore removes NOTHING: it shows up as a missing or
 * one-sided SharedCutRecord (and in `unmatchedSharedCutLines`), never as a part
 * that silently lost a cut it needed.
 *
 * FRAME: `sharedCutLines` arrive in the SAME frame as `placements` (the nest
 * sheet frame, i.e. solver output), and the expander offsets them by `origin`
 * itself - so a solver result can be handed straight through.
 * ------------------------------------------------------------------------- */

/** A cut line owned by exactly two placed copies (solver.ts SharedCutEdge).
 *  Coordinates are in the nest SHEET frame - the same frame as Placement.x/y. */
export interface SharedCutLine {
  a: Vec2
  b: Vec2
  /** the two owning placement instanceIds */
  owners: [string, string]
}

/** Endpoint match tolerance (mm) for "this move IS that shared line". One
 *  micron, matching solver.ts DEFAULT_COMMON_EDGE_TOLERANCE (see that constant
 *  for why a 1e-6 tolerance refused physically identical edges): the two must
 *  agree, or a line the solver accepted as shared would fail to match here and
 *  be cut twice anyway. */
export const DEFAULT_SHARED_CUT_TOLERANCE = 1e-3

/** Who actually cut one shared line, for one op. This is the ownership record
 *  the tree and tool assignment read: the line is ONE path, cut by
 *  `cutByInstanceId` under `opId` / `toolId`, and relied on by every copy in
 *  `sharedWithInstanceIds`. */
export interface SharedCutRecord {
  /** index into the `sharedCutLines` argument */
  lineIndex: number
  opId: string
  toolId: string
  /** the line in NEST-WORLD coordinates (sheet frame + origin) */
  a: Vec2
  b: Vec2
  /** the copy whose pass physically cuts the line */
  cutByInstanceId: string
  /** owning copies that rely on the line without re-cutting it */
  sharedWithInstanceIds: string[]
  /** redundant cutting spans removed across all skipping owners (a multi-pass
   *  op contributes one per Z level) */
  skippedSpanCount: number
}

/** One emitted nest section. Maps 1:1 to a post section (its op's tool /
 *  spindle / coolant). In by-operation mode a section spans all copies of one
 *  op; in by-part mode a section is a single (copy, op) pair. `moves` is the
 *  nest-world stream INCLUDING any leading inter-copy travel into this section. */
export interface ExpandedNestSection {
  opId: string
  toolId: string
  sourceGeometryId: string
  copyCount: number
  moves: ToolpathMove[]
}

/** The full expansion. `moves` === sections.flatMap(s => s.moves) - the
 *  contiguous multi-copy stream consumed by render / sim / estimate.
 *
 *  `sharedCuts` (WO-1827) names every shared line that was really emitted, and
 *  by whom; `unmatchedSharedCutLines` lists the indices of claimed lines no copy
 *  ever traced - an empty array on a healthy nest, and the tell for a wrong
 *  share. Both are [] when no shared lines are supplied, so every pre-WO-1827
 *  caller sees the same expansion it always did. */
export interface NestExpansion {
  sections: ExpandedNestSection[]
  moves: ToolpathMove[]
  sharedCuts: SharedCutRecord[]
  unmatchedSharedCutLines: number[]
}

/** The safe inter-copy retract Z for an op: clearanceZ unless the op opts into
 *  the lower retract plane (retractMode === 'retract'). Default (no retractMode)
 *  is clearanceZ, the safest. */
function interRetractZ(op: SeedOpExpansionInput): number {
  return op.retractMode === 'retract' ? op.retractZ : op.clearanceZ
}

/** Deterministic nearest-neighbor tour of one depth tier. The tier arrives
 *  pre-sorted by instanceId ascending (from orderPlacementsInnermostFirst);
 *  the tour starts at that smallest-instanceId placement and greedily appends
 *  the nearest unvisited placement by squared (x,y) distance, breaking exact
 *  ties by smallest instanceId. Pure, byte-stable. */
function nearestNeighborTour(tier: Placement[]): Placement[] {
  if (tier.length <= 2) return [...tier] // already optimal + deterministic
  const remaining = [...tier]
  const tour: Placement[] = []
  let current = remaining.shift() as Placement // smallest instanceId
  tour.push(current)
  while (remaining.length > 0) {
    let bestIdx = 0
    let bestD = Infinity
    for (let k = 0; k < remaining.length; k++) {
      const dx = remaining[k].x - current.x
      const dy = remaining[k].y - current.y
      const d = dx * dx + dy * dy
      if (
        d < bestD ||
        (d === bestD && remaining[k].instanceId < remaining[bestIdx].instanceId)
      ) {
        bestIdx = k
        bestD = d
      }
    }
    current = remaining.splice(bestIdx, 1)[0]
    tour.push(current)
  }
  return tour
}

/** Copy visit order for a nest: innermost-first (depth DESCENDING — windowed
 *  children before hosts, the ADR 0024 section-3 safety invariant) THEN a
 *  deterministic nearest-neighbor pass WITHIN each depth tier to minimize
 *  rapids. The nearest-neighbor pass never reorders across tiers, so the safety
 *  ordering is preserved. Pure, byte-stable. */
export function orderCopies(placements: Placement[]): Placement[] {
  const tiered = orderPlacementsInnermostFirst(placements)
  const result: Placement[] = []
  let i = 0
  while (i < tiered.length) {
    let j = i
    while (j < tiered.length && tiered[j].depth === tiered[i].depth) j++
    result.push(...nearestNeighborTour(tiered.slice(i, j)))
    i = j
  }
  return result
}

/** Build the inter-copy travel seam (retract -> rapid) between the end of one
 *  copy and the entry of the next. Lifts to the max of both ops' safe retract
 *  heights (so it clears both the part just left and the part being approached),
 *  then rapids in XY to the next entry at that height. The next copy's own move
 *  stream supplies the plunge. All moves are role 'rapid'. */
function travelSeam(
  prevLast: ToolpathMove,
  nextFirst: ToolpathMove,
  prevOp: SeedOpExpansionInput,
  nextOp: SeedOpExpansionInput,
): ToolpathMove[] {
  const safeZ = Math.max(interRetractZ(prevOp), interRetractZ(nextOp))
  const seam: ToolpathMove[] = []
  if (prevLast.z < safeZ) {
    seam.push({ type: 'rapid', x: prevLast.x, y: prevLast.y, z: safeZ, role: 'rapid' })
  }
  seam.push({ type: 'rapid', x: nextFirst.x, y: nextFirst.y, z: safeZ, role: 'rapid' })
  return seam
}

/** Indices of every move in `moves` that cuts exactly the segment a..b (either
 *  direction). Straight cuts only: an arc is never a shared straight line, and a
 *  rapid is not a cut. A multi-pass op yields one index per Z level. */
function sharedSpanIndices(
  moves: ToolpathMove[],
  a: Vec2,
  b: Vec2,
  tolerance: number,
): number[] {
  const near = (m: ToolpathMove, p: Vec2): boolean =>
    Math.hypot(m.x - p.x, m.y - p.y) <= tolerance
  const hits: number[] = []
  for (let k = 1; k < moves.length; k++) {
    const move = moves[k]
    if (move.type !== 'feed') continue
    const prev = moves[k - 1]
    if ((near(prev, a) && near(move, b)) || (near(prev, b) && near(move, a))) hits.push(k)
  }
  return hits
}

/** Replace each skipped cutting span with a retract -> rapid -> plunge seam, so
 *  the tool arrives at the far end of an ALREADY-CUT line without cutting it
 *  again. Every move that is not skipped is passed through by REFERENCE, so the
 *  remaining contour is byte-identical to the unshared emission. */
function skipSharedSpans(
  moves: ToolpathMove[],
  skipIndices: ReadonlySet<number>,
  op: SeedOpExpansionInput,
): ToolpathMove[] {
  if (skipIndices.size === 0) return moves
  const safeZ = interRetractZ(op)
  const out: ToolpathMove[] = []
  for (let k = 0; k < moves.length; k++) {
    const move = moves[k]
    if (!skipIndices.has(k)) {
      out.push(move)
      continue
    }
    // physical position entering this span is always moves[k-1]'s endpoint: a
    // preceding skip ends its own seam by plunging back to exactly that point.
    const prev = moves[k - 1]
    if (prev.z < safeZ) {
      out.push({ type: 'rapid', x: prev.x, y: prev.y, z: safeZ, role: 'rapid' })
    }
    out.push({ type: 'rapid', x: move.x, y: move.y, z: safeZ, role: 'rapid' })
    if (move.z < safeZ) {
      const plunge: ToolpathMove = {
        type: 'feed',
        x: move.x,
        y: move.y,
        z: move.z,
        role: 'plunge',
      }
      if (move.feed !== undefined) plunge.feed = move.feed
      out.push(plunge)
    }
  }
  return out
}

interface ExpansionUnit {
  op: SeedOpExpansionInput
  placement: Placement
  moves: ToolpathMove[] // instanced into nest-world (no seam)
}

/** Expand a nest into its full multi-copy toolpath stream (ADR 0024 Amd 1).
 *
 *  - ops: each seed op of the nest, with resolved heights, in op array order.
 *  - placements: every placed copy on the sheet (NestRecord.placements).
 *  - origin: the nest world origin (NestRecord.origin; default {x:0,y:0}).
 *  - machiningOrder:
 *      'by-operation' (DEFAULT) — each op runs across ALL its copies before the
 *        next op (all internal features on every part before any cutoff; fewer
 *        tool changes). One section per op. WO-1523: the ops themselves are
 *        first sorted by the deepest placement depth they carry (descending,
 *        stable) — a window-child part's op runs before its host part's op —
 *        so the section 3 safety invariant holds ACROSS parts too, not just
 *        within one op's own copies.
 *      'by-part' — all ops finish one copy before the next copy (frees parts as
 *        you go). One section per (copy, op) pair so the post can tool-change.
 *        Already cross-part safe: orderCopies sorts the full placement list by
 *        depth before ops are ever consulted.
 *
 *  Copies within an op (by-operation) and the part visit order (by-part) both
 *  use orderCopies (innermost-first then nearest-neighbor). Inter-copy travel
 *  is inserted between every consecutive unit (a unit = one op for one copy);
 *  the very first unit has no leading seam. Pure + deterministic + byte-stable.
 */
export function expandNest(
  ops: SeedOpExpansionInput[],
  placements: Placement[],
  origin: Vec2,
  machiningOrder: 'by-operation' | 'by-part',
  sharedCutLines: readonly SharedCutLine[] = [],
  sharedCutTolerance: number = DEFAULT_SHARED_CUT_TOLERANCE,
): NestExpansion {
  const active = ops.filter((op) => op.localMoves.length > 0)

  // 1. Build the ordered execution units (op + instanced moves for one copy).
  const units: ExpansionUnit[] = []
  if (machiningOrder === 'by-part') {
    for (const placement of orderCopies(placements)) {
      for (const op of active) {
        if (op.sourceGeometryId !== placement.partId) continue
        units.push({ op, placement, moves: instanceMoves(op.localMoves, placement, origin) })
      }
    }
  } else {
    // Deepest-first, stable: an op whose part is ever nested inside a window
    // (depth 1) runs before an op whose part only sits at depth 0 - equal-depth
    // ops (the common no-window case) keep the given array order untouched.
    const maxDepth = (op: SeedOpExpansionInput): number => {
      let max = 0
      for (const p of placements) {
        if (p.partId === op.sourceGeometryId && p.depth > max) max = p.depth
      }
      return max
    }
    const orderedOps = [...active].sort((a, b) => maxDepth(b) - maxDepth(a))
    for (const op of orderedOps) {
      const copies = orderCopies(
        placements.filter((p) => p.partId === op.sourceGeometryId),
      )
      for (const placement of copies) {
        units.push({ op, placement, moves: instanceMoves(op.localMoves, placement, origin) })
      }
    }
  }

  // 1b. WO-1827: emit each shared cut line ONCE PER OP. Walking the units in
  //     emission order, the first copy of an op that actually traces a line
  //     keeps it; every later copy of that same op skips it (retract -> rapid
  //     -> plunge) and is recorded as sharing rather than re-cutting. Matching
  //     is geometric, so a line no copy traces removes nothing and is reported
  //     in `unmatchedSharedCutLines` instead.
  const worldLines = sharedCutLines.map((line) => ({
    owners: line.owners,
    a: { x: line.a.x + origin.x, y: line.a.y + origin.y },
    b: { x: line.b.x + origin.x, y: line.b.y + origin.y },
  }))
  const sharedCuts: SharedCutRecord[] = []
  const matchedLines = new Set<number>()
  if (worldLines.length > 0) {
    // record index per (lineIndex, opId) - two copies of ONE op are redundant;
    // two different ops over the same profile are not.
    const recordByKey = new Map<string, number>()
    units.forEach((unit, idx) => {
      const skips = new Set<number>()
      worldLines.forEach((line, lineIndex) => {
        if (!line.owners.includes(unit.placement.instanceId)) return
        const hits = sharedSpanIndices(unit.moves, line.a, line.b, sharedCutTolerance)
        if (hits.length === 0) return
        matchedLines.add(lineIndex)
        const key = `${lineIndex}|${unit.op.opId}`
        const existing = recordByKey.get(key)
        if (existing === undefined) {
          recordByKey.set(key, sharedCuts.length)
          sharedCuts.push({
            lineIndex,
            opId: unit.op.opId,
            toolId: unit.op.toolId,
            a: line.a,
            b: line.b,
            cutByInstanceId: unit.placement.instanceId,
            sharedWithInstanceIds: [],
            skippedSpanCount: 0,
          })
          return // this copy CUTS the line
        }
        const record = sharedCuts[existing]
        if (!record.sharedWithInstanceIds.includes(unit.placement.instanceId)) {
          record.sharedWithInstanceIds.push(unit.placement.instanceId)
        }
        record.skippedSpanCount += hits.length
        for (const hit of hits) skips.add(hit)
      })
      if (skips.size > 0) units[idx] = { ...unit, moves: skipSharedSpans(unit.moves, skips, unit.op) }
    })
  }
  const unmatchedSharedCutLines = worldLines
    .map((_, index) => index)
    .filter((index) => !matchedLines.has(index))

  // 2. Compute each unit's moves WITH its leading inter-copy seam (none on the
  //    first unit). The seam connects the previous unit's last move to this
  //    unit's first move at the max safe retract height.
  const unitStreams: ToolpathMove[][] = units.map((unit, idx) => {
    if (idx === 0) return unit.moves
    const prev = units[idx - 1]
    const seam = travelSeam(
      prev.moves[prev.moves.length - 1],
      unit.moves[0],
      prev.op,
      unit.op,
    )
    return [...seam, ...unit.moves]
  })

  // 3. Group units into post sections. by-operation: one section per op
  //    (consecutive same-op units); by-part: one section per unit. flatten over
  //    the same ordered unitStreams either way, so moves stays contiguous.
  const sections: ExpandedNestSection[] = []
  if (machiningOrder === 'by-part') {
    units.forEach((unit, idx) => {
      sections.push({
        opId: unit.op.opId,
        toolId: unit.op.toolId,
        sourceGeometryId: unit.op.sourceGeometryId,
        copyCount: 1,
        moves: unitStreams[idx],
      })
    })
  } else {
    let i = 0
    while (i < units.length) {
      const opId = units[i].op.opId
      let j = i
      const moves: ToolpathMove[] = []
      while (j < units.length && units[j].op.opId === opId) {
        moves.push(...unitStreams[j])
        j++
      }
      sections.push({
        opId,
        toolId: units[i].op.toolId,
        sourceGeometryId: units[i].op.sourceGeometryId,
        copyCount: j - i,
        moves,
      })
      i = j
    }
  }

  return {
    sections,
    moves: sections.flatMap((s) => s.moves),
    sharedCuts,
    unmatchedSharedCutLines,
  }
}
