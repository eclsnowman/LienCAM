// Sketch mirror tool (Stage 6 chunk 2, PLAN.md 3.5 MODIFY v1).
//
// Armed tool, two-phase gesture:
//   1. choose WHAT to mirror — either the pre-existing selection (when
//      the tool is armed with a non-empty selection, the very next click
//      is the mirror line) or by clicking entities while armed (each
//      click toggles the entity in/out of the mirror set)
//   2. click the mirror LINE: in selection-seeded mode ANY line works;
//      in click-accumulate mode a CONSTRUCTION line applies immediately
//      (clicking a regular line is ambiguous with adding it to the set,
//      so it toggles — with a notice naming the way out). To mirror
//      about a REGULAR line in accumulate mode, Enter/Confirm CLOSES
//      the set (chain.confirmed) and the next click is the axis pick,
//      any line — the same Enter-closes-the-set gesture as the
//      pattern tools.
//
// The commit creates mirrored COPIES (lines/arcs/circles/points; arc
// winding flipped so the stored CCW convention holds) plus planegcs
// SYMMETRIC constraints binding each mirrored point pair about the axis
// (same operand encoding as constraintActions/gcsMapping 'symmetric').
// Circles additionally get an EQUAL radius constraint (their center pair
// alone does not pin the radius). Result: dragging an original moves its
// mirror parametrically through the solver.
//
// PURE module following the toolMachine pattern: clicks RETURN a commit;
// the store applies it as one undo step.

import type {
  Vec2,
  SketchEntity,
  SketchConstraint,
} from '../types'
import { isInjectedSketchAnchorId } from '../sketchAnchors'
import { nearestPointOnSpline } from '../spline'

const TWO_PI = Math.PI * 2

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ---- Chain state (CHAINING payload) -----------------------------------------

export interface MirrorChainState {
  kind: 'mirror'
  /** Entity ids accumulated for mirroring (click-toggle set). */
  ids: string[]
  /** True when `ids` were consumed from the SELECTION at arm time
   *  (armToolWithSelection) — provenance only. A seeded set is still an
   *  OPEN accumulate set (the user may click to add/remove entities) and
   *  must be CLOSED with Enter (confirmed) before the axis pick, EXACTLY
   *  like the pattern tools. This fixes the tool-first bug where a single
   *  lingering selection seeded the chain straight into axis-pick and the
   *  next click (meant to ADD an entity) was consumed as the axis. */
  seeded?: boolean
  /** True when the SET was closed via Enter / Confirm (confirmToolStep):
   *  the next click is the axis pick and ANY line works. This is the only
   *  axis-pick phase — both pre-selected (seeded) and click-accumulated
   *  sets reach it the same way, by pressing Enter. */
  confirmed?: boolean
}

/** True when the chain is in the AXIS-PICK phase: the next click is the
 *  mirror line and ANY line works. Reached ONLY by closing the set with
 *  Enter (confirmed) — a seeded set is still open until Enter, so seeded
 *  alone no longer skips the accumulate step. */
function axisPickPhase(chain: MirrorChainState | null): boolean {
  return chain !== null && chain.confirmed === true
}

export interface MirrorClickOutcome {
  chain: MirrorChainState | null
  commit: { entities: SketchEntity[]; constraints: SketchConstraint[] } | null
  notice: string | null
}

// ---- Picking ------------------------------------------------------------------

function segDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function arcSweep(startAngle: number, endAngle: number): number {
  const s = norm(endAngle - startAngle)
  return s < 1e-12 ? TWO_PI : s
}

function entityDistance(e: SketchEntity, p: Vec2): number {
  switch (e.kind) {
    case 'point':
      return dist(e.at, p)
    case 'line':
      return segDistance(p, e.start, e.end)
    case 'circle':
      return Math.abs(dist(p, e.center) - e.radius)
    case 'arc': {
      const ang = norm(Math.atan2(p.y - e.center.y, p.x - e.center.x) - e.startAngle)
      if (ang <= arcSweep(e.startAngle, e.endAngle)) {
        return Math.abs(dist(p, e.center) - e.radius)
      }
      const s = {
        x: e.center.x + e.radius * Math.cos(e.startAngle),
        y: e.center.y + e.radius * Math.sin(e.startAngle),
      }
      const en = {
        x: e.center.x + e.radius * Math.cos(e.endAngle),
        y: e.center.y + e.radius * Math.sin(e.endAngle),
      }
      return Math.min(dist(p, s), dist(p, en))
    }
    // WO-1861: a spline mirrors exactly by reflecting its points (both the
    // through-point and the control-point curve are invariant under a
    // reflection), so it is pickable into the set.
    case 'spline':
      return nearestPointOnSpline(e.points, e.closed, p, e.form).dist
    // v1: mirror does not yet handle the solver-inert ellipse/text
    // (their sym/equal bindings have no shape sites). Not pickable -> ignored.
    case 'ellipse':
    case 'elliptical-arc':
    case 'text':
    case 'block':
      return Infinity
  }
}

function pickEntity(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): SketchEntity | null {
  // Injected anchor axes span the whole sketch, so a user line drawn along
  // one ties with it at every point - and the anchors sit first in document
  // order, so a plain nearest-first pick returned the INVISIBLE axis instead
  // of the line the user clicked (RED-D, 2026-07-21). User geometry always
  // outranks injected infrastructure; anchors are pickable only when nothing
  // else is under the cursor.
  let best: { e: SketchEntity; d: number; injected: boolean } | null = null
  for (const e of entities) {
    const d = entityDistance(e, world)
    if (d > tol) continue
    const injected = isInjectedSketchAnchorId(e.id)
    if (!best || (best.injected && !injected) ||
        (best.injected === injected && d < best.d)) {
      best = { e, d, injected }
    }
  }
  return best?.e ?? null
}

/**
 * Pick the mirror REFERENCE role independently from the source-set role.
 * Source entities are deliberately excluded before distance ranking: at a
 * rectangle corner the source side and an axis can both be zero-distance from
 * the click, and the generic entity picker otherwise returns whichever happened
 * to occur first in document order. That made a reference click toggle the
 * source out of the set instead of applying the mirror.
 */
/** Nearest LINE that is already IN the set - the axis-pick fallback when the
 *  click lands on no outside line. Injected anchors never sit in a set. */
function pickSetMemberLine(
  entities: readonly SketchEntity[],
  sourceIds: readonly string[],
  world: Vec2,
  tol: number,
): Extract<SketchEntity, { kind: 'line' }> | null {
  const sources = new Set(sourceIds)
  let best: { e: Extract<SketchEntity, { kind: 'line' }>; d: number } | null = null
  for (const entity of entities) {
    if (entity.kind !== 'line' || !sources.has(entity.id)) continue
    const d = entityDistance(entity, world)
    if (d <= tol && (!best || d < best.d)) best = { e: entity, d }
  }
  return best?.e ?? null
}

function pickMirrorReferenceLine(
  entities: readonly SketchEntity[],
  sourceIds: readonly string[],
  world: Vec2,
  tol: number,
  constructionOnly: boolean,
): Extract<SketchEntity, { kind: 'line' }> | null {
  const sources = new Set(sourceIds)
  let best: { e: Extract<SketchEntity, { kind: 'line' }>; d: number } | null = null
  for (const entity of entities) {
    if (entity.kind !== 'line' || sources.has(entity.id)) continue
    if (constructionOnly && !entity.construction) continue
    const d = entityDistance(entity, world)
    if (d <= tol && (!best || d < best.d)) best = { e: entity, d }
  }
  return best?.e ?? null
}

// ---- Mirror construction ---------------------------------------------------------

/** Reflect a point about the INFINITE line through `a` with direction
 *  `u` (unit). */
function reflectPoint(p: Vec2, a: Vec2, u: Vec2): Vec2 {
  const wx = p.x - a.x, wy = p.y - a.y
  const r00 = 2 * u.x * u.x - 1, r01 = 2 * u.x * u.y
  const r11 = 2 * u.y * u.y - 1
  return { x: a.x + r00 * wx + r01 * wy, y: a.y + r01 * wx + r11 * wy }
}

export interface MirrorResult {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  /** sourceId -> mirrored copy id. */
  idMap: Map<string, string>
}

/**
 * Mirror the entities in `ids` about the line `axisId`. Returns the
 * copies + symmetric constraints, or a rejection string. The axis is
 * never mirrored even when its id is in `ids`.
 */
export function mirrorEntities(
  entities: readonly SketchEntity[],
  ids: readonly string[],
  axisId: string,
  newId: () => string = () => crypto.randomUUID(),
): MirrorResult | string {
  const axis = entities.find((e) => e.id === axisId)
  if (!axis || axis.kind !== 'line') return 'Mirror: the axis must be a line'
  const len = dist(axis.start, axis.end)
  if (len < 1e-9) return 'Mirror: the axis line is zero-length'
  const u = { x: (axis.end.x - axis.start.x) / len, y: (axis.end.y - axis.start.y) / len }
  const a0 = axis.start
  const phi = Math.atan2(u.y, u.x)

  const targets = ids
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is SketchEntity => e !== undefined && e.id !== axisId)
  if (targets.length === 0) return 'Mirror: nothing to mirror'

  const out: SketchEntity[] = []
  const constraints: SketchConstraint[] = []
  const idMap = new Map<string, string>()
  const R = (p: Vec2) => reflectPoint(p, a0, u)
  const sym = (
    src: string, srcSite: 'self' | 'start' | 'end' | 'center',
    mir: string, mirSite: 'self' | 'start' | 'end' | 'center',
  ): SketchConstraint => ({
    id: newId(), kind: 'symmetric',
    a: { entityId: src, site: srcSite },
    b: { entityId: mir, site: mirSite },
    axis: axisId,
  })

  for (const e of targets) {
    const mid = newId()
    idMap.set(e.id, mid)
    switch (e.kind) {
      case 'point':
        out.push({ id: mid, kind: 'point', construction: e.construction, at: R(e.at) })
        constraints.push(sym(e.id, 'self', mid, 'self'))
        break
      case 'line':
        out.push({
          id: mid, kind: 'line', construction: e.construction,
          start: R(e.start), end: R(e.end),
        })
        constraints.push(sym(e.id, 'start', mid, 'start'))
        constraints.push(sym(e.id, 'end', mid, 'end'))
        break
      case 'circle':
        out.push({
          id: mid, kind: 'circle', construction: e.construction,
          center: R(e.center), radius: e.radius,
        })
        constraints.push(sym(e.id, 'center', mid, 'center'))
        // The center pair does not pin the radius — equal does.
        constraints.push({ id: newId(), kind: 'equal', a: e.id, b: mid })
        break
      case 'arc': {
        // Reflection maps angle t to 2*phi - t and flips winding: the
        // mirrored arc sweeps CCW from the reflected END to the
        // reflected START, so the stored-CCW convention holds and the
        // source START point reflects to the mirrored END point.
        out.push({
          id: mid, kind: 'arc', construction: e.construction,
          center: R(e.center), radius: e.radius,
          startAngle: norm(2 * phi - e.endAngle),
          endAngle: norm(2 * phi - e.startAngle),
        })
        constraints.push(sym(e.id, 'start', mid, 'end'))
        constraints.push(sym(e.id, 'end', mid, 'start'))
        constraints.push(sym(e.id, 'center', mid, 'center'))
        break
      }
      case 'spline':
        // WO-1861: reflected points in the same order and the same form -- a
        // reflection maps a spline (through-point or control-point) onto the
        // mirrored curve exactly. Solver-inert: the anchors are the one
        // symmetric pair, so moving the original rigidly carries the copy.
        // WO-1862: a bezier chain reflects the same way (a reflection keeps
        // every handle collinear with its anchor), so it keeps its joints too.
        // WO-1863: a conic arc too -- a reflection is affine, so the mirrored
        // start/apex/shoulder/end are the mirrored conic at the same rho.
        out.push({
          id: mid, kind: 'spline', construction: e.construction,
          points: e.points.map(R), closed: e.closed,
          ...(e.form === 'control' || e.form === 'bezier' || e.form === 'conic' ? { form: e.form } : {}),
          ...(e.smooth ? { smooth: [...e.smooth] } : {}),
        })
        constraints.push(sym(e.id, 'start', mid, 'start'))
        break
    }
  }

  return { entities: out, constraints, idMap }
}

// ---- Axis hover candidate -----------------------------------------------------------

/** The axis line a CLICK at `cursor` would mirror about, plus the set it
 *  would mirror — the SAME resolution rules as mirrorClick, so the hover
 *  ghost (toolOverlay) always previews exactly what the click commits:
 *    - axis-pick phase (arm-time seeded chain, or set closed via
 *      Enter): any line under the cursor
 *    - selection-seeded mode (no chain, non-empty selection): any line
 *    - click-accumulate mode: a CONSTRUCTION line not in the set
 *  Null when hovering would not commit. */
export function mirrorAxisCandidate(
  chain: MirrorChainState | null,
  entities: readonly SketchEntity[],
  _selectedIds: readonly string[],
  cursor: Vec2,
  tol: number,
): { axisId: string; ids: string[] } | null {
  if (chain === null || chain.ids.length === 0) return null
  // Set closed via Enter (confirmed): any non-source line previews the
  // mirror. The source remains amber while this reference role drives the
  // ghost, including when both touch at a shared endpoint.
  if (axisPickPhase(chain)) {
    const axis = pickMirrorReferenceLine(entities, chain.ids, cursor, tol, false)
    return axis ? { axisId: axis.id, ids: chain.ids } : null
  }
  // Open set (seeded or click-accumulated): a construction reference applies
  // immediately. Resolve it before source toggles for the same shared-endpoint
  // reason as the confirmed path above.
  const axis = pickMirrorReferenceLine(entities, chain.ids, cursor, tol, true)
  return axis ? { axisId: axis.id, ids: chain.ids } : null
}

// ---- Click behavior ----------------------------------------------------------------

/**
 * CLICK(p) for the armed mirror tool (gesture in the header):
 *   - axis-pick phase (the set was CLOSED with Enter, confirmed): this
 *     click is the mirror line — any line works
 *   - otherwise (open set, seeded or not) clicks toggle entities in/out
 *     of the mirror set; a CONSTRUCTION line click executes immediately
 *   - everything that cannot proceed explains itself via notice
 *
 * `selectedIds` is no longer consumed at click time: pre-selection is
 * seeded into the chain at ARM time (armToolWithSelection) as an OPEN
 * set, so a stale selection can never hijack a click into an instant
 * axis pick (the tool-first bug).
 */
export function mirrorClick(
  chain: MirrorChainState | null,
  entities: readonly SketchEntity[],
  _selectedIds: readonly string[],
  world: Vec2,
  tol: number,
  newId: () => string = () => crypto.randomUUID(),
): MirrorClickOutcome {
  // AXIS-PICK phase (the set was closed via Enter/Confirm): this click is
  // the axis pick — any line. A miss keeps the chain (the operands
  // persist for the retry).
  if (axisPickPhase(chain)) {
    // Prefer a line OUTSIDE the set (SKC-71 corner-tie protection), but a
    // click that lands only on a SET MEMBER uses it as the axis - the set
    // may deliberately contain the axis line, and mirrorEntities excludes
    // the axis from its own targets (RED-D, 2026-07-21).
    const axis = pickMirrorReferenceLine(entities, chain!.ids, world, tol, false)
      ?? pickSetMemberLine(entities, chain!.ids, world, tol)
    if (!axis) {
      return {
        chain, commit: null,
        notice: 'Mirror: click a LINE other than a source to mirror the set about',
      }
    }
    const r = mirrorEntities(entities, chain!.ids, axis.id, newId)
    if (typeof r === 'string') return { chain, commit: null, notice: r }
    return {
      chain: null,
      commit: { entities: r.entities, constraints: r.constraints },
      notice: null,
    }
  }

  // Click-accumulate mode (open set: freshly armed, or pre-selection
  // seeded as an open set). Clicks toggle entities; Enter closes the set.
  const ids = chain?.ids ?? []
  const hit = pickEntity(entities, world, tol)
  if (!hit) {
    if (ids.length === 0) return { chain, commit: null, notice: null } // quiet idle click
    return {
      chain, commit: null,
      notice: 'Mirror: click the mirror line (construction), or Esc to cancel',
    }
  }

  // Construction LINE = the axis (executes); see header for why a regular
  // line cannot be the axis in accumulate mode. The role scan stays (SKC-71:
  // a USER construction reference sharing a corner with a source must still
  // win the tie), but an INJECTED anchor axis may only take the axis role
  // when it is what the user actually clicked - otherwise it intercepted
  // accumulate clicks on any line drawn along y=0 (RED-D, 2026-07-21).
  const scanned = pickMirrorReferenceLine(entities, ids, world, tol, true)
  const constructionAxis =
    scanned && (!isInjectedSketchAnchorId(scanned.id) || scanned.id === hit.id)
      ? scanned
      : null
  if (constructionAxis) {
    if (ids.length === 0) {
      return { chain, commit: null, notice: 'Mirror: select entities to mirror first' }
    }
    const r = mirrorEntities(entities, ids, constructionAxis.id, newId)
    if (typeof r === 'string') return { chain, commit: null, notice: r }
    return { chain: null, commit: { entities: r.entities, constraints: r.constraints }, notice: null }
  }

  // Toggle the entity in/out of the mirror set. Adding a REGULAR line
  // to an already-populated set is the classic "I clicked my axis and
  // nothing happened" moment (the axis here must be construction) —
  // explain the Enter gesture instead of staying silent.
  const next = ids.includes(hit.id) ? ids.filter((id) => id !== hit.id) : [...ids, hit.id]
  const notice =
    !ids.includes(hit.id) && hit.kind === 'line' && !hit.construction &&
    ids.length > 0
      ? 'Mirror: line added to the set - to use a line as the AXIS, ' +
        'press Enter to close the set, then click it ' +
        '(a construction line applies immediately)'
      : null
  return { chain: { kind: 'mirror', ids: next }, commit: null, notice }
}
