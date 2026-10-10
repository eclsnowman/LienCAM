// Rectangle tools (Stage 3 chunk 2): corner rectangle + center rectangle.
//
// Same pure-machine contract as toolMachine.ts: a click either advances
// the in-progress chain or returns a ToolCommit; the document is never
// touched here. Both tools are TWO-click:
//
//   rect-corner: click corner A -> rubber-band rectangle preview ->
//                click opposite corner B -> commit
//   rect-center: click CENTER  -> preview grows symmetrically ->
//                click any corner B -> commit (A = mirrored corner)
//
// Output (auto-constraints, REAL document constraints):
// four line entities chained corner-to-corner with coincident
// constraints, horizontal on top/bottom, vertical on the sides. Lines
// own their endpoints (types.ts doctrine) — the corners are joined by
// constraints, not shared vertices.

import type { Vec2, SketchEntity, SketchConstraint } from '../types'
import type { ToolCommit } from './toolMachine'
import { definingRectCenter } from './definingGeometry'

/** In-progress rectangle (chain payload after the first click).
 *
 *  ROTATED (angled) mode (item G): a Tab toggle drops the H/V lock so the
 *  box can be drawn at any angle. It is a THREE-click flow:
 *    click1 = first corner (anchor)
 *    click2 = the opposite end of the FIRST EDGE (sets angle + length) -> edgeEnd
 *    click3 = the WIDTH (signed perpendicular offset of the cursor) -> commit
 *  In rotated mode the committed rectangle drops horizontal/vertical and
 *  instead carries parallel + parallel + perpendicular (rigid but free-angle;
 *  rotation stays under-defined, no auto angle dimension). */
export interface RectChainState {
  kind: 'rect'
  /** 'corner' anchors corner A; 'center' anchors the rectangle center. */
  mode: 'corner' | 'center'
  /** Angled (free-rotation) mode flag. Mirrors the dimension Tab force-mode. */
  rotated?: boolean
  /** First corner / center. Undefined ONLY in the pre-click1 rotated staging
   *  state (Tab pressed while the tool is freshly armed). */
  anchor?: Vec2
  /** Rotated mode click 2: the opposite end of the first edge (angle+length).
   *  Undefined until that click; never set in axis-aligned mode. */
  edgeEnd?: Vec2
}

/** Opposite corners (a, b) for the current anchor + cursor; both modes
 *  reduce to the same corner pair, which is why they share one builder.
 *  Axis-aligned mode only — anchor is always set on these paths. */
export function rectCorners(chain: RectChainState, cursor: Vec2): { a: Vec2; b: Vec2 } {
  const anchor = chain.anchor!
  if (chain.mode === 'center') {
    return {
      a: { x: 2 * anchor.x - cursor.x, y: 2 * anchor.y - cursor.y },
      b: { x: cursor.x, y: cursor.y },
    }
  }
  return { a: { x: anchor.x, y: anchor.y }, b: { x: cursor.x, y: cursor.y } }
}

/** The four corners of a rotated rectangle from the first edge (p1->p2) and a
 *  width point. n = unit perpendicular of (p2-p1); w = signed perpendicular
 *  distance of widthPoint from the p1->p2 line. Winding c0->c1->c2->c3 keeps
 *  the same corner-coincident loop the axis-aligned builder relies on. */
export function rotatedRectCorners(
  p1: Vec2, p2: Vec2, widthPoint: Vec2,
): [Vec2, Vec2, Vec2, Vec2] {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy)
  const nx = len > 0 ? -dy / len : 0
  const ny = len > 0 ? dx / len : 0
  const w = (widthPoint.x - p1.x) * nx + (widthPoint.y - p1.y) * ny
  return [
    { x: p1.x, y: p1.y },
    { x: p2.x, y: p2.y },
    { x: p2.x + w * nx, y: p2.y + w * ny },
    { x: p1.x + w * nx, y: p1.y + w * ny },
  ]
}

/**
 * The four lines + eight auto-constraints of an axis-aligned rectangle
 * with opposite corners a and b. Winding: a -> (b.x,a.y) -> b -> (a.x,b.y)
 * -> a, so lines 0/2 are the horizontals and 1/3 the verticals in any
 * drag quadrant.
 *
 * SQUARE (V6): when `forceSquare` is true (the user committed with Shift held,
 * so ortho-lock snapped the drag to a 45deg diagonal = a visual square) ONE
 * extra `equal` constraint ties a horizontal leg to a vertical leg
 * (equal(ids[0], ids[1])). With the four coincident corners + H/V that is
 * sufficient to KEEP it square under solving: a closed axis-aligned quad with
 * H top/bottom and V sides already forces opposite sides equal, so equating a
 * horizontal to a vertical leg equates width to height. Only emitted in the
 * square case; a normal rectangle stays byte-identical to before.
 */
export function buildRectCommit(
  a: Vec2,
  b: Vec2,
  construction: boolean,
  newId: () => string,
  forceSquare = false,
): ToolCommit {
  const corners: Vec2[] = [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ]
  const entities: SketchEntity[] = []
  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    const id = newId()
    ids.push(id)
    const s = corners[i]
    const e = corners[(i + 1) % 4]
    entities.push({
      id,
      kind: 'line',
      construction,
      start: { x: s.x, y: s.y },
      end: { x: e.x, y: e.y },
    })
  }

  const constraints: SketchConstraint[] = []
  // Corners: each line's end meets the next line's start.
  for (let i = 0; i < 4; i++) {
    constraints.push({
      id: newId(),
      kind: 'coincident',
      a: { entityId: ids[i], site: 'end' },
      b: { entityId: ids[(i + 1) % 4], site: 'start' },
    })
  }
  // Sides: 0/2 horizontal (bottom/top), 1/3 vertical (right/left).
  constraints.push({ id: newId(), kind: 'horizontal', line: ids[0] })
  constraints.push({ id: newId(), kind: 'vertical',   line: ids[1] })
  constraints.push({ id: newId(), kind: 'horizontal', line: ids[2] })
  constraints.push({ id: newId(), kind: 'vertical',   line: ids[3] })

  // V6 square lock: equate one horizontal leg to one vertical leg. One equal
  // is enough (H/V + closed corners already make opposite sides equal), so
  // width==height persists when the solver later moves a corner or a side.
  if (forceSquare) {
    constraints.push({ id: newId(), kind: 'equal', a: ids[0], b: ids[1] })
  }

  // C2/D1: a persistent construction CENTER point tied to the rectangle via a
  // construction diagonal between opposite corners (corners[0]=ids[0]:start and
  // corners[2]=ids[2]:start), appended AFTER the cut sides so existing
  // index-based consumers of the four lines are unaffected. The center now
  // TRACKS corner edits (midpoint of the diagonal).
  const def = definingRectCenter(
    { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    { at: corners[0], ref: { entityId: ids[0], site: 'start' } },
    { at: corners[2], ref: { entityId: ids[2], site: 'start' } },
    newId,
  )
  return { entities: [...entities, ...def.entities], constraints: [...constraints, ...def.constraints] }
}

/**
 * The four lines + constraints of a ROTATED (angled) rectangle. Same four
 * corner-coincident constraints and construction CENTER marker as the
 * axis-aligned builder, but instead of the H/V pair it emits:
 *   parallel(line0, line2)      opposite edges parallel
 *   parallel(line1, line3)      opposite edges parallel
 *   perpendicular(line0, line1) adjacent edges square
 * That is a rigid rectangle whose ROTATION stays free (under-defined) — no
 * angle dimension is added, matching standard 3-point-rect behavior.
 */
export function buildRotatedRectCommit(
  p1: Vec2,
  p2: Vec2,
  widthPoint: Vec2,
  construction: boolean,
  newId: () => string,
): ToolCommit {
  const corners = rotatedRectCorners(p1, p2, widthPoint)
  const entities: SketchEntity[] = []
  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    const id = newId()
    ids.push(id)
    const s = corners[i]
    const e = corners[(i + 1) % 4]
    entities.push({
      id,
      kind: 'line',
      construction,
      start: { x: s.x, y: s.y },
      end: { x: e.x, y: e.y },
    })
  }

  const constraints: SketchConstraint[] = []
  for (let i = 0; i < 4; i++) {
    constraints.push({
      id: newId(),
      kind: 'coincident',
      a: { entityId: ids[i], site: 'end' },
      b: { entityId: ids[(i + 1) % 4], site: 'start' },
    })
  }
  // Free-angle rigidity: parallel opposite edges + one square corner. NO
  // horizontal/vertical (that is exactly the lock the rotated mode drops).
  constraints.push({ id: newId(), kind: 'parallel', a: ids[0], b: ids[2] })
  constraints.push({ id: newId(), kind: 'parallel', a: ids[1], b: ids[3] })
  constraints.push({ id: newId(), kind: 'perpendicular', a: ids[0], b: ids[1] })

  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4
  // C2/D1: center tied via a construction diagonal between opposite rotated
  // corners (corners[0]=ids[0]:start and corners[2]=ids[2]:start). The midpoint
  // of that diagonal is the center for any rotation, so it tracks corner edits.
  const def = definingRectCenter(
    { x: cx, y: cy },
    { at: corners[0], ref: { entityId: ids[0], site: 'start' } },
    { at: corners[2], ref: { entityId: ids[2], site: 'start' } },
    newId,
  )
  return { entities: [...entities, ...def.entities], constraints: [...constraints, ...def.constraints] }
}

export interface RectClickResult {
  chain: RectChainState | null
  commit: ToolCommit | null
}

/**
 * Click behavior shared by both rectangle tools. First click anchors;
 * second click commits unless the rectangle is degenerate (either side
 * shorter than the click tolerance), which is ignored — a sliver rect
 * would solve but is never what the click meant.
 */
export function rectClick(
  chain: RectChainState | null,
  mode: 'corner' | 'center',
  world: Vec2,
  closeTol: number,
  construction: boolean,
  newId: () => string,
  forceSquare = false,
): RectClickResult {
  const rotated = chain?.rotated ?? false

  // Click 1: anchor not set yet (fresh chain, or a Tab-staged rotated chain
  // that carries the flag but no anchor). Set the first corner; keep mode +
  // rotated so the staged choice survives the click.
  if (!chain || !chain.anchor) {
    return {
      // Only carry `rotated` when true so the axis-aligned chain shape stays
      // byte-identical to the pre-feature `{ kind, mode, anchor }`.
      chain: {
        kind: 'rect', mode, anchor: { x: world.x, y: world.y },
        ...(rotated ? { rotated: true } : {}),
      },
      commit: null,
    }
  }

  if (rotated) {
    // Click 2: the opposite end of the first edge (angle + length).
    if (!chain.edgeEnd) {
      if (Math.hypot(world.x - chain.anchor.x, world.y - chain.anchor.y) <= closeTol) {
        return { chain, commit: null } // degenerate (zero-length) edge: ignore
      }
      return { chain: { ...chain, edgeEnd: { x: world.x, y: world.y } }, commit: null }
    }
    // Click 3: the WIDTH (signed perpendicular offset) -> commit.
    const p1 = chain.anchor
    const p2 = chain.edgeEnd
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const len = Math.hypot(dx, dy)
    const nx = len > 0 ? -dy / len : 0
    const ny = len > 0 ? dx / len : 0
    const w = (world.x - p1.x) * nx + (world.y - p1.y) * ny
    if (Math.abs(w) <= closeTol) {
      return { chain, commit: null } // degenerate (zero-width) rect: ignore
    }
    return { chain: null, commit: buildRotatedRectCommit(p1, p2, world, construction, newId) }
  }

  const { a, b } = rectCorners(chain, world)
  if (Math.abs(b.x - a.x) <= closeTol || Math.abs(b.y - a.y) <= closeTol) {
    return { chain, commit: null }
  }
  // forceSquare rides the committing click's Shift state (the ortho-lock that
  // made the drag a visual square). Only the axis-aligned path honors it; the
  // rotated 3-click path is free-angle by design.
  return { chain: null, commit: buildRectCommit(a, b, construction, newId, forceSquare) }
}

/** Closed 5-point outline for the rubber-band preview (anchor + cursor).
 *  Built from the same rectCorners the commit uses, so the preview IS the
 *  committed rectangle. */
export function rectPreview(chain: RectChainState, cursor: Vec2): Vec2[] | null {
  if (chain.rotated) {
    if (!chain.anchor) return null // pre-click1: nothing to rubber-band yet
    if (!chain.edgeEnd) {
      // After click1: a single rubber-band line from the first corner along
      // the first edge to the cursor.
      return [{ x: chain.anchor.x, y: chain.anchor.y }, { x: cursor.x, y: cursor.y }]
    }
    // After click2: the full rotated rectangle following the width cursor.
    const c = rotatedRectCorners(chain.anchor, chain.edgeEnd, cursor)
    return [c[0], c[1], c[2], c[3], c[0]]
  }
  const { a, b } = rectCorners(chain, cursor)
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
    { x: a.x, y: a.y },
  ]
}
