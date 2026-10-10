// Sketch linear + circular pattern tools (interaction framework rework:
// set - Confirm - place - confirm overlay).
//
// Flow (both tools):
//   1. SET: clicks toggle entities in/out of the pattern set (a
//      pre-selection seeds it at arm time); the set highlights in the
//      viewport. Confirm (Enter / prompt-bar button) closes the set —
//      clicks NEVER silently leave this phase, so a click that happens
//      to land on geometry can no longer hijack the placement.
//   2. PLACE (snap-enabled point clicks):
//      - linear: anchor click, then the step-vector end click — ghost
//        instances preview live from the anchor toward the cursor
//      - circular: ONE click places the rotation center — a live ghost
//        ring follows the cursor before the click
//      Clicking again re-places (change your mind without Esc).
//   3. CONFIRM OVERLAY: count (and per-step angle for circular) editable
//      with the ghosts live-updating; OK commits as one undo step.
//
// CONSTRAINTS (honest v1 scope): copies carry NO inter-instance
// constraints (a pattern constraint binding copies to the seed
// is out of scope) — but each copy is internally constraint-complete:
// every constraint whose operands ALL live inside the pattern set
// (coincident, tangent, parallel, ... ) is duplicated per copy with the
// entity ids remapped to that copy. 'fix' is NOT duplicated (grounding
// is positional, not internal shape) and dimensions are not duplicated
// (v1). Dragging a copy keeps the copy's own shape but does not move
// its siblings.
//
// PURE module following the toolMachine pattern: clicks RETURN chain
// transitions; the overlay apply (store) commits as one undo step.

import type {
  Vec2,
  PointRef,
  SketchEntity,
  SketchConstraint,
  SketchSplineEntity,
  SketchEllipticalArcEntity,
} from '../types'
import {
  nearestPointOnEllipse, distanceToEllipticalArc,
  ellipsePointAt, ellipseDerivativeAt, ellipticalArcSweep, ellipseSegmentCount,
} from '../ellipse'
import { nearestPointOnSpline, splinePointAt, splineDerivativeAt, type SplineForm } from '../spline'
import { distanceToText } from '../text'
import { isInjectedSketchAnchorId } from '../sketchAnchors'
import { chainContaining, type ChainStep } from '../bake'
import { centroidOfEntities } from '../blocks'

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ---- Chain states (CHAINING payloads) -----------------------------------------

export interface LinearPatternChainState {
  kind: 'linpat'
  ids: string[]
  /** Set closed by Confirm (Enter): clicks now PLACE the step vector.
   *  Clicks never flip this — the phase advance is always explicit. */
  confirmed: boolean
  /** Step-vector anchor (first placement click). */
  anchor: Vec2 | null
  /** Locked step vector (second placement click) — overlay phase. */
  vector: Vec2 | null
  /** True when `ids` were consumed from the SELECTION at arm time
   *  (armToolWithSelection); the prompt names the seed. */
  seeded?: boolean
}

export interface CircularPatternChainState {
  kind: 'circpat'
  ids: string[]
  /** Set closed by Confirm (Enter): clicks now PLACE the center. */
  confirmed: boolean
  /** Locked rotation center — overlay phase. */
  center: Vec2 | null
  /** Arm-time selection seed (see LinearPatternChainState.seeded). */
  seeded?: boolean
}

export interface PatternClickOutcome<C> {
  chain: C | null
  notice: string | null
}

// ---- Picking (same metric as the mirror tool) -----------------------------------

const TWO_PI = Math.PI * 2

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

function segDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
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
      const sweep = norm(e.endAngle - e.startAngle) || TWO_PI
      const ang = norm(Math.atan2(p.y - e.center.y, p.x - e.center.x) - e.startAngle)
      if (ang <= sweep) return Math.abs(dist(p, e.center) - e.radius)
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
    case 'ellipse':
      return nearestPointOnEllipse(e, p).dist
    case 'elliptical-arc':
      return distanceToEllipticalArc(e, e.startParam, e.endParam, p)
    case 'spline':
      return nearestPointOnSpline(e.points, e.closed, p, e.form).dist
    case 'text':
      return distanceToText(e.text, e.height, e.at, e.rotation ?? 0, p,
        { mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm })
    case 'block':
      // A block is not patternable as a primitive in v1 (never picked).
      return Infinity
  }
}

/** Nearest entity within `tol` (shared by the transform tools' set phase). */
export function pickEntity(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): SketchEntity | null {
  // Same injected-anchor demotion as mirrorTool.pickEntity (RED-D): user
  // geometry always outranks the invisible anchor axes, which otherwise win
  // document-order ties along y=0 / x=0 and get patterned by mistake.
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

// ---- Pattern construction ---------------------------------------------------------

/** Rigid transform applied to one copy: a point map plus the rotation
 *  delta it applies to arc angles (0 for translations). */
export interface CopyTransform {
  map: (p: Vec2) => Vec2
  dTheta: number
}

function transformEntity(e: SketchEntity, t: CopyTransform, id: string): SketchEntity {
  switch (e.kind) {
    case 'point':
      return { id, kind: 'point', construction: e.construction, at: t.map(e.at) }
    case 'line':
      return {
        id, kind: 'line', construction: e.construction,
        start: t.map(e.start), end: t.map(e.end),
      }
    case 'circle':
      return {
        id, kind: 'circle', construction: e.construction,
        center: t.map(e.center), radius: e.radius,
      }
    case 'arc':
      return {
        id, kind: 'arc', construction: e.construction,
        center: t.map(e.center), radius: e.radius,
        startAngle: norm(e.startAngle + t.dTheta),
        endAngle: norm(e.endAngle + t.dTheta),
      }
    // Ellipse params live in the ellipse's own frame, so a rigid copy only
    // maps the center and adds the rotation delta; radii/params are kept.
    case 'ellipse':
      return {
        id, kind: 'ellipse', construction: e.construction,
        center: t.map(e.center), majorRadius: e.majorRadius,
        minorRadius: e.minorRadius, rotation: e.rotation + t.dTheta,
      }
    case 'elliptical-arc':
      return {
        id, kind: 'elliptical-arc', construction: e.construction,
        center: t.map(e.center), majorRadius: e.majorRadius,
        minorRadius: e.minorRadius, rotation: e.rotation + t.dTheta,
        startParam: e.startParam, endParam: e.endParam,
      }
    // Solver-inert spline: a rigid copy maps every through-point (the point
    // map already carries the pattern's translation + rotation).
    case 'spline':
      return {
        id, kind: 'spline', construction: e.construction,
        points: e.points.map((pt) => t.map(pt)), closed: e.closed,
        // A control polygon maps to the control polygon of the mapped curve
        // (B-splines are affine-invariant), so the copy keeps its form. A
        // bezier chain likewise, joints included (WO-1862), and a conic arc
        // (WO-1863: the shoulder maps with the rest, so rho is kept).
        ...(e.form === 'control' || e.form === 'bezier' || e.form === 'conic' ? { form: e.form } : {}),
        ...(e.smooth ? { smooth: [...e.smooth] } : {}),
      }
    // Solver-inert text: a rigid copy maps the anchor and adds the copy's
    // rotation to the baseline (string + height carried verbatim).
    case 'text':
      return {
        id, kind: 'text', construction: e.construction,
        at: t.map(e.at), text: e.text, height: e.height,
        rotation: (e.rotation ?? 0) + t.dTheta, fontStyle: e.fontStyle,
        fontFamily: e.fontFamily, mirrored: e.mirrored,
        letterSpacingMm: e.letterSpacingMm,
      }
    // A block copy rigidly maps its origin + rotation; members are carried
    // verbatim (they already live in the block's own local frame). Patterning a
    // block is out of scope v1 (pickEntity never returns one -- entityDistance is
    // Infinity), so this is defensive completeness, not a shipped path.
    case 'block':
      return {
        id, kind: 'block', construction: e.construction,
        origin: t.map(e.origin), rotation: e.rotation + t.dTheta, scale: e.scale,
        name: e.name, members: e.members,
      }
  }
}

const HALF_PI = Math.PI / 2
// Float roundoff on k * stepAngle, not a tolerance for "close enough to an
// axis" -- a real 89.9deg step must still fail this and drop its H/V.
const AXIS_SNAP_EPS = 1e-6

/** horizontal/vertical pin a line to the WORLD x/y axes, which is only a
 *  valid constraint on a copy rotated by a multiple of 90deg -- the copy's
 *  frame still coincides with an axis there (swapped at 90/270). At any
 *  other rotation there is no frame-appropriate expression (the constraint
 *  model has no relative-angle kind), so the constraint is dropped for that
 *  copy rather than left to solve the rigid shape back toward world axes
 *  (WO-1467 / BUG-495). */
export function axisConstraintKindAt(
  kind: 'horizontal' | 'vertical', dTheta: number,
): 'horizontal' | 'vertical' | null {
  const n = norm(dTheta)
  const k = Math.round(n / HALF_PI)
  if (Math.abs(n - k * HALF_PI) > AXIS_SNAP_EPS) return null
  const swap = ((k % 4) + 4) % 4 % 2 === 1
  return swap ? (kind === 'horizontal' ? 'vertical' : 'horizontal') : kind
}

/** Remap a constraint onto one copy's ids. Returns null when any operand
 *  lives OUTSIDE the pattern set (not internal), the kind is excluded from
 *  duplication ('fix' — grounding is positional, not shape), or (horizontal
 *  /vertical only) the copy's rotation has no valid frame-appropriate
 *  expression of a world-axis constraint (see axisConstraintKindAt).
 *  `dTheta` is the copy's rotation delta (0 for a linear-pattern copy). */
export function remapConstraint(
  c: SketchConstraint, m: Map<string, string>, newId: () => string, dTheta: number,
): SketchConstraint | null {
  const id = (src: string): string | null => m.get(src) ?? null
  const ref = (r: PointRef): PointRef | null => {
    const e = id(r.entityId)
    return e ? { entityId: e, site: r.site } : null
  }
  switch (c.kind) {
    case 'coincident':
    case 'continuity_g1':
    case 'continuity_g2': {
      const a = ref(c.a), b = ref(c.b)
      return a && b ? { id: newId(), kind: c.kind, a, b } : null
    }
    case 'concentric':
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'tangent':
    case 'equal': {
      const a = id(c.a), b = id(c.b)
      return a && b ? { id: newId(), kind: c.kind, a, b } : null
    }
    case 'horizontal':
    case 'vertical': {
      const kind = axisConstraintKindAt(c.kind, dTheta)
      if (!kind) return null
      if (c.line) {
        const l = id(c.line)
        return l ? { id: newId(), kind, line: l } : null
      }
      if (c.points) {
        const a = ref(c.points[0]), b = ref(c.points[1])
        return a && b ? { id: newId(), kind, points: [a, b] } : null
      }
      return null
    }
    case 'midpoint': {
      const p = ref(c.point), l = id(c.line)
      return p && l ? { id: newId(), kind: c.kind, point: p, line: l } : null
    }
    case 'symmetric': {
      const a = ref(c.a), b = ref(c.b), axis = id(c.axis)
      return a && b && axis ? { id: newId(), kind: c.kind, a, b, axis } : null
    }
    case 'point_on_object': {
      const p = ref(c.point), o = id(c.object)
      return p && o ? { id: newId(), kind: c.kind, point: p, object: o } : null
    }
    case 'fix':
    case 'pierce':
      return null
  }
}

export interface PatternResult {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
}

/**
 * Create copies 1..count-1 of the entities in `ids` under `transformAt(k)`,
 * duplicating each copy's INTERNAL constraint set with remapped ids.
 * Construction entities and unknown ids are dropped from the set.
 */
export function patternEntities(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  ids: readonly string[],
  count: number,
  transformAt: (k: number) => CopyTransform,
  newId: () => string = () => crypto.randomUUID(),
): PatternResult | string {
  if (!(Number.isInteger(count)) || count < 2) {
    return 'Pattern: count must be a whole number >= 2'
  }
  const sources = ids
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is SketchEntity => e !== undefined && !e.construction)
  if (sources.length === 0) return 'Pattern: nothing to pattern'
  const sourceIds = new Set(sources.map((e) => e.id))
  const internal = constraints.filter((c) => remappable(c, sourceIds))

  const outEntities: SketchEntity[] = []
  const outConstraints: SketchConstraint[] = []
  for (let k = 1; k < count; k++) {
    const t = transformAt(k)
    const m = new Map<string, string>()
    for (const e of sources) {
      const id = newId()
      m.set(e.id, id)
      outEntities.push(transformEntity(e, t, id))
    }
    for (const c of internal) {
      const rc = remapConstraint(c, m, newId, t.dTheta)
      if (rc) outConstraints.push(rc)
    }
  }
  return { entities: outEntities, constraints: outConstraints }
}

/** True when every operand of `c` is inside the set (cheap pre-filter —
 *  the real remap re-checks; this only keeps the per-copy loop tight).
 *  Probed at dTheta=0 (always axis-valid) since this check is about
 *  operand membership, not any one copy's rotation. */
function remappable(c: SketchConstraint, set: ReadonlySet<string>): boolean {
  const probe = remapConstraint(
    c, new Map([...set].map((id) => [id, id])), () => 'probe', 0,
  )
  return probe !== null
}

/** Linear pattern: copies translate by k * step. */
export function linearPattern(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  ids: readonly string[],
  count: number,
  step: Vec2,
  newId?: () => string,
): PatternResult | string {
  if (Math.hypot(step.x, step.y) < 1e-9) {
    return 'Linear pattern: the step vector is zero - click two different points'
  }
  return patternEntities(entities, constraints, ids, count, (k) => ({
    map: (p) => ({ x: p.x + k * step.x, y: p.y + k * step.y }),
    dTheta: 0,
  }), newId)
}

/** Circular pattern: copies rotate by k * stepAngle about `center`. */
export function circularPattern(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  ids: readonly string[],
  count: number,
  center: Vec2,
  stepAngle: number,
  newId?: () => string,
): PatternResult | string {
  if (!(Math.abs(stepAngle) > 1e-9)) {
    return 'Circular pattern: the per-step angle is zero'
  }
  return patternEntities(entities, constraints, ids, count, (k) => {
    const a = k * stepAngle
    const cos = Math.cos(a), sin = Math.sin(a)
    return {
      map: (p) => ({
        x: center.x + (p.x - center.x) * cos - (p.y - center.y) * sin,
        y: center.y + (p.x - center.x) * sin + (p.y - center.y) * cos,
      }),
      dTheta: a,
    }
  }, newId)
}

// ---- Ghost previews -----------------------------------------------------------------

/** Ghost copies 1..count-1 of the entities in `ids` under
 *  `transformAt(k)` — geometry only (throwaway ids, no constraints).
 *  The SAME transformEntity the commit uses, so ghost == committed. */
export function patternPreviewEntities(
  entities: readonly SketchEntity[],
  ids: readonly string[],
  count: number,
  transformAt: (k: number) => CopyTransform,
): SketchEntity[] {
  const sources = ids
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is SketchEntity => e !== undefined && !e.construction)
  const out: SketchEntity[] = []
  for (let k = 1; k < count; k++) {
    const t = transformAt(k)
    sources.forEach((e, i) => out.push(transformEntity(e, t, `__pat${k}_${i}__`)))
  }
  return out
}

/** Linear ghost instances: step = locked vector, else anchor->cursor.
 *  Null while there is nothing to show. */
export function linearPatternPreview(
  chain: LinearPatternChainState,
  entities: readonly SketchEntity[],
  cursor: Vec2,
  count: number,
): SketchEntity[] | null {
  if (!chain.confirmed || !chain.anchor || chain.ids.length === 0) return null
  const step = chain.vector ?? {
    x: cursor.x - chain.anchor.x, y: cursor.y - chain.anchor.y,
  }
  if (Math.hypot(step.x, step.y) < 1e-9 || count < 2) return null
  return patternPreviewEntities(entities, chain.ids, count, (k) => ({
    map: (p) => ({ x: p.x + k * step.x, y: p.y + k * step.y }),
    dTheta: 0,
  }))
}

/** Circular ghost instances about the locked center — or the CURSOR
 *  while the center is still being chosen (live ghost ring). */
export function circularPatternPreview(
  chain: CircularPatternChainState,
  entities: readonly SketchEntity[],
  cursor: Vec2,
  count: number,
  stepAngle: number,
): SketchEntity[] | null {
  if (!chain.confirmed || chain.ids.length === 0) return null
  if (!(Math.abs(stepAngle) > 1e-9) || count < 2) return null
  const center = chain.center ?? cursor
  return patternPreviewEntities(entities, chain.ids, count, (k) => {
    const a = k * stepAngle
    const cos = Math.cos(a), sin = Math.sin(a)
    return {
      map: (p) => ({
        x: center.x + (p.x - center.x) * cos - (p.y - center.y) * sin,
        y: center.y + (p.x - center.x) * sin + (p.y - center.y) * cos,
      }),
      dTheta: a,
    }
  })
}

// ---- Apply (confirm overlay OK) -------------------------------------------------------

/** Commit for a vector-locked linear pattern at the live count. */
export function linearPatternApply(
  chain: LinearPatternChainState,
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  count: number,
  newId?: () => string,
): PatternResult | string {
  if (!chain.vector) return 'Linear pattern: place the step vector first'
  return linearPattern(entities, constraints, chain.ids, count, chain.vector, newId)
}

/** Commit for a center-locked circular pattern at the live count/angle. */
export function circularPatternApply(
  chain: CircularPatternChainState,
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  count: number,
  stepAngle: number,
  newId?: () => string,
): PatternResult | string {
  if (!chain.center) return 'Circular pattern: click the rotation center first'
  return circularPattern(
    entities, constraints, chain.ids, count, chain.center, stepAngle, newId)
}

// ---- Click behavior ----------------------------------------------------------------

/** SET-phase click: toggle a hit entity in/out of the set. Misses and
 *  construction hits explain themselves — clicks never silently advance
 *  the phase (Confirm does that, explicitly). */
function setPhaseClick(
  ids: readonly string[],
  entities: readonly SketchEntity[],
  world: Vec2,
  tol: number,
): { ids: string[]; notice: string | null } {
  const hit = pickEntity(entities, world, tol)
  if (!hit) {
    return {
      ids: [...ids],
      notice: ids.length === 0
        ? 'Pattern: click entities to add them to the set'
        : 'Pattern: press Confirm (Enter) to close the set - or click more entities',
    }
  }
  if (hit.construction) {
    return { ids: [...ids], notice: 'Pattern: construction geometry is excluded' }
  }
  return {
    ids: ids.includes(hit.id) ? ids.filter((id) => id !== hit.id) : [...ids, hit.id],
    notice: null,
  }
}

/**
 * CLICK(p) for the armed linear-pattern tool (flow in the header):
 * set-toggle until Confirm, then anchor click, then the vector-end
 * click (re-clicks re-place it); the overlay's OK commits.
 */
export function linearPatternClick(
  chain: LinearPatternChainState | null,
  entities: readonly SketchEntity[],
  world: Vec2,
  tol: number,
): PatternClickOutcome<LinearPatternChainState> {
  // Placement phase: anchor, then the vector end (re-click re-places).
  if (chain?.confirmed) {
    if (!chain.anchor) {
      return {
        chain: { ...chain, anchor: { x: world.x, y: world.y } },
        notice: null,
      }
    }
    const vector = { x: world.x - chain.anchor.x, y: world.y - chain.anchor.y }
    if (Math.hypot(vector.x, vector.y) < 1e-9) {
      return {
        chain,
        notice: 'Linear pattern: the step vector is zero - click a different point',
      }
    }
    return { chain: { ...chain, vector }, notice: null }
  }

  // Set phase (idle empty click stays quiet).
  const ids = chain?.ids ?? []
  if (!chain && !pickEntity(entities, world, tol)) {
    return { chain: null, notice: null }
  }
  const t = setPhaseClick(ids, entities, world, tol)
  return {
    chain: {
      kind: 'linpat', ids: t.ids, confirmed: false, anchor: null, vector: null,
      ...(chain?.seeded ? { seeded: true } : {}),
    },
    notice: t.notice,
  }
}

/**
 * CLICK(p) for the armed circular-pattern tool: set-toggle until
 * Confirm, then the center click (re-clicks re-place it); the
 * overlay's OK commits.
 */
export function circularPatternClick(
  chain: CircularPatternChainState | null,
  entities: readonly SketchEntity[],
  world: Vec2,
  tol: number,
): PatternClickOutcome<CircularPatternChainState> {
  // Placement phase: the click is the center (re-click re-places).
  if (chain?.confirmed) {
    return {
      chain: { ...chain, center: { x: world.x, y: world.y } },
      notice: null,
    }
  }

  const ids = chain?.ids ?? []
  if (!chain && !pickEntity(entities, world, tol)) {
    return { chain: null, notice: null }
  }
  const t = setPhaseClick(ids, entities, world, tol)
  return {
    chain: {
      kind: 'circpat', ids: t.ids, confirmed: false, center: null,
      ...(chain?.seeded ? { seeded: true } : {}),
    },
    notice: t.notice,
  }
}

// ---- Path pattern (WO-1569: pattern along a curve) --------------------------------
//
// A third pattern tool: SET - Confirm - PATH PICK - confirm overlay (Count,
// Spacing mode, Orientation). Unlike linear/circular (whose source stays
// exactly where drawn and only count-1 NEW copies are added around it), a
// path pattern's whole point is to walk `count` instances ALONG the curve —
// so every instance (including the first) is a freshly transformed copy, and
// the source set stays wherever it was originally drawn (same "leave the
// source, append new copies" doc.append architecture every other pattern
// uses — nothing here mutates or removes the source). The FIRST new copy
// (k=0) lands with the set's centroid exactly AT the path start (rule 2 of
// WO-1569); later copies (k=1..count-1) walk further by arc length, never by
// curve parameter, so spacing reads even on a spline.
//
// PATH SHAPES (WO-1569 scope, matching the offsetTool precedent that ellipse
// arcs/splines never enter a CHAIN with line/arc edges — WO-1569 result notes
// this explicitly): a line/arc or a connected chain of them (chainContaining,
// exactly the bake's own chain walk — includes construction curves too, since
// a path is a guide, not baked geometry), OR a standalone spline, OR a
// standalone elliptical arc. A full circle/ellipse is not a supported path
// shape (not listed in the WO; chainContaining already never returns one).
//
// DECIDE-AND-LOG (rule 3): Count/Spacing mode/Orientation live ON THE CHAIN
// (PathPatternChainState), not a new toolStore scalar — WO-1569's owned
// paths do not include tools/sketcher/toolStore.ts (the grant-gap the
// pre-grant commit caught for the TEST files missed this one). This mirrors
// the exact precedent chamferTool/SketchConfirmOverlay.tsx already set for
// WO-1570 (mode/d2/angle staged on the chain, not the store) — see the
// comment on editChamferChain in SketchConfirmOverlay.tsx.

export type PatternPathSource =
  | { kind: 'chain'; steps: ChainStep[]; closed: boolean }
  | { kind: 'spline'; entity: SketchSplineEntity }
  | { kind: 'elliptical-arc'; entity: SketchEllipticalArcEntity }

export type PathPatternSpacingMode = 'equal' | 'fixed'

export interface PathPatternChainState {
  kind: 'pathpat'
  ids: string[]
  /** Set closed by Confirm (Enter): clicks now PICK the path. */
  confirmed: boolean
  /** Path locked by the path-pick click (re-click re-picks it); null while
   *  still choosing — overlay phase starts once this is set. */
  path: PatternPathSource | null
  /** Confirm-overlay fields (decide-and-log above: carried on the chain). */
  count: number
  spacingMode: PathPatternSpacingMode
  /** Spacing mode 'fixed' only: arc-length step in mm. */
  fixedSpacing: number
  /** Orientation: rotate each copy to follow the path tangent. */
  followTangent: boolean
  /** Arm-time selection seed (see LinearPatternChainState.seeded). */
  seeded?: boolean
}

export interface PatternPathPoint {
  at: Vec2
  /** Unit tangent in the path's traversal direction. */
  tangent: Vec2
}

function stepLength(step: ChainStep): number {
  const e = step.entity
  if (e.kind === 'line') return dist(e.start, e.end)
  const sweep = norm(e.endAngle - e.startAngle) || TWO_PI
  return e.radius * sweep
}

function chainPathLength(steps: readonly ChainStep[]): number {
  return steps.reduce((sum, s) => sum + stepLength(s), 0)
}

/** Point + unit tangent at arc-length `d` along ONE step, traversed per
 *  `step.forward` (mirrors offsetTool's stepEndpoints/stepTangent, which are
 *  module-private there). */
function stepPointAt(step: ChainStep, d: number): PatternPathPoint {
  const e = step.entity
  if (e.kind === 'line') {
    const from = step.forward ? e.start : e.end
    const to = step.forward ? e.end : e.start
    const len = dist(from, to) || 1
    const t = Math.max(0, Math.min(1, d / len))
    return {
      at: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
      tangent: { x: (to.x - from.x) / len, y: (to.y - from.y) / len },
    }
  }
  const angle = step.forward ? e.startAngle + d / e.radius : e.endAngle - d / e.radius
  const at = { x: e.center.x + e.radius * Math.cos(angle), y: e.center.y + e.radius * Math.sin(angle) }
  const tangent = step.forward
    ? { x: -Math.sin(angle), y: Math.cos(angle) }
    : { x: Math.sin(angle), y: -Math.cos(angle) }
  return { at, tangent }
}

function chainPathPointAt(steps: readonly ChainStep[], closed: boolean, s: number): PatternPathPoint {
  const L = chainPathLength(steps)
  if (!(L > 1e-9)) return stepPointAt(steps[0], 0)
  let rem = closed ? ((s % L) + L) % L : Math.max(0, Math.min(L, s))
  for (let i = 0; i < steps.length; i++) {
    const len = stepLength(steps[i])
    if (rem <= len + 1e-9 || i === steps.length - 1) {
      return stepPointAt(steps[i], Math.max(0, Math.min(len, rem)))
    }
    rem -= len
  }
  return stepPointAt(steps[steps.length - 1], 0)
}

/** Samples of a curve keyed by arc length, each carrying the NATIVE curve
 *  parameter at that sample — the arc-length table only ever picks WHICH
 *  native parameter to evaluate; the returned point/tangent always come from
 *  the exact native evaluator (splinePointAt/ellipsePointAt), never a
 *  chord-interpolated approximation. */
interface ParamSample { param: number; cum: number }

function sampleByArcLength(
  paramAt: (i: number, n: number) => number,
  pointAt: (param: number) => Vec2,
  n: number,
): { samples: ParamSample[]; total: number } {
  const samples: ParamSample[] = [{ param: paramAt(0, n), cum: 0 }]
  let prev = pointAt(samples[0].param)
  let cum = 0
  for (let i = 1; i <= n; i++) {
    const param = paramAt(i, n)
    const pt = pointAt(param)
    cum += dist(prev, pt)
    samples.push({ param, cum })
    prev = pt
  }
  return { samples, total: cum }
}

/** Native parameter at arc length `s` along a sampled table (binary search
 *  the bracketing samples, then interpolate the PARAMETER — never the point
 *  — so the caller's exact evaluator gives the final point/tangent). */
function paramAtArcLength(samples: readonly ParamSample[], total: number, s: number, closed: boolean): number {
  if (!(total > 1e-9)) return samples[0].param
  const rem = closed ? ((s % total) + total) % total : Math.max(0, Math.min(total, s))
  let lo = 0, hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].cum <= rem) lo = mid; else hi = mid
  }
  const a = samples[lo], b = samples[hi]
  const span = b.cum - a.cum
  const frac = span > 1e-12 ? (rem - a.cum) / span : 0
  return a.param + (b.param - a.param) * frac
}

const SPLINE_ARC_SAMPLES_PER_SEGMENT = 200

function splinePathLength(points: readonly Vec2[], closed: boolean, form?: SplineForm): number {
  if (points.length < 2) return 0
  const segCount = closed ? points.length : points.length - 1
  const n = segCount * SPLINE_ARC_SAMPLES_PER_SEGMENT
  const { total } = sampleByArcLength(
    (i, N) => (segCount * i) / N,
    (q) => splinePointAt(points, closed, q, form),
    n,
  )
  return total
}

function splinePathPointAt(
  points: readonly Vec2[], closed: boolean, s: number, form?: SplineForm,
): PatternPathPoint {
  if (points.length < 2) return { at: { ...points[0] }, tangent: { x: 1, y: 0 } }
  const segCount = closed ? points.length : points.length - 1
  const n = segCount * SPLINE_ARC_SAMPLES_PER_SEGMENT
  const { samples, total } = sampleByArcLength(
    (i, N) => (segCount * i) / N,
    (q) => splinePointAt(points, closed, q, form),
    n,
  )
  const q = paramAtArcLength(samples, total, s, closed)
  const d = splineDerivativeAt(points, closed, q, form)
  const len = Math.hypot(d.x, d.y) || 1
  return { at: splinePointAt(points, closed, q, form), tangent: { x: d.x / len, y: d.y / len } }
}

function ellipticalArcPathLength(e: SketchEllipticalArcEntity): number {
  const sweep = ellipticalArcSweep(e.startParam, e.endParam)
  const n = Math.max(200, ellipseSegmentCount(e, sweep) * 4)
  const { total } = sampleByArcLength(
    (i, N) => e.startParam + (sweep * i) / N,
    (t) => ellipsePointAt(e, t),
    n,
  )
  return total
}

function ellipticalArcPathPointAt(e: SketchEllipticalArcEntity, s: number): PatternPathPoint {
  const sweep = ellipticalArcSweep(e.startParam, e.endParam)
  const n = Math.max(200, ellipseSegmentCount(e, sweep) * 4)
  const { samples, total } = sampleByArcLength(
    (i, N) => e.startParam + (sweep * i) / N,
    (t) => ellipsePointAt(e, t),
    n,
  )
  const t = paramAtArcLength(samples, total, s, false)
  const d = ellipseDerivativeAt(e, t)
  const len = Math.hypot(d.x, d.y) || 1
  return { at: ellipsePointAt(e, t), tangent: { x: d.x / len, y: d.y / len } }
}

/** Total arc length of the path. */
export function patternPathLength(source: PatternPathSource): number {
  switch (source.kind) {
    case 'chain': return chainPathLength(source.steps)
    case 'spline': return splinePathLength(source.entity.points, source.entity.closed, source.entity.form)
    case 'elliptical-arc': return ellipticalArcPathLength(source.entity)
  }
}

/** True when the path is a closed loop (a closed chain or a closed spline —
 *  an elliptical arc is a partial curve, never closed). */
export function patternPathClosed(source: PatternPathSource): boolean {
  if (source.kind === 'chain') return source.closed
  if (source.kind === 'spline') return source.entity.closed
  return false
}

/** Point + unit tangent at arc length `s` along the path (clamped to
 *  [0, length] on an open path; wrapped modulo length on a closed one). */
export function patternPathPointAt(source: PatternPathSource, s: number): PatternPathPoint {
  switch (source.kind) {
    case 'chain': return chainPathPointAt(source.steps, source.closed, s)
    case 'spline': return splinePathPointAt(source.entity.points, source.entity.closed, s, source.entity.form)
    case 'elliptical-arc': return ellipticalArcPathPointAt(source.entity, s)
  }
}

function angleOf(v: Vec2): number {
  return Math.atan2(v.y, v.x)
}

/** a - b normalized into (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = a - b
  while (d <= -Math.PI) d += TWO_PI
  while (d > Math.PI) d -= TWO_PI
  return d
}

/**
 * Per-copy transform for a path pattern: copy `k`'s instance of `reference`
 * (the pattern set's centroid) lands EXACTLY on the path point at that
 * copy's arc-length position — k=0 at the path start (rule 2), k=1.. spaced
 * by arc length (rule 2/4: closed paths divide by `count` so the last copy
 * never stacks on the first; open paths divide by `count-1` so the last
 * copy lands exactly at the path end). `followTangent` rotates the copy
 * about the reference to match the LOCAL tangent, relative to the tangent
 * at k=0 (so a copy already drawn parallel to the path's start direction
 * stays parallel to the tangent at every later copy too).
 */
export function pathPatternTransformAt(
  source: PatternPathSource,
  reference: Vec2,
  count: number,
  spacingMode: PathPatternSpacingMode,
  fixedSpacing: number,
  followTangent: boolean,
): (k: number) => CopyTransform {
  const L = patternPathLength(source)
  const closed = patternPathClosed(source)
  const tangent0Angle = angleOf(patternPathPointAt(source, 0).tangent)
  return (k: number) => {
    const s = spacingMode === 'fixed'
      ? k * fixedSpacing
      : closed ? (k * L) / count : count > 1 ? (k * L) / (count - 1) : 0
    const pt = patternPathPointAt(source, s)
    const dTheta = followTangent ? angleDelta(angleOf(pt.tangent), tangent0Angle) : 0
    const cos = Math.cos(dTheta), sin = Math.sin(dTheta)
    return {
      dTheta,
      map: (p: Vec2) => ({
        x: pt.at.x + (p.x - reference.x) * cos - (p.y - reference.y) * sin,
        y: pt.at.y + (p.x - reference.x) * sin + (p.y - reference.y) * cos,
      }),
    }
  }
}

/**
 * Build `count` copies (k=0..count-1, NOT count-1 like linearPattern/
 * circularPattern — a path pattern has no "leave copy 0 untouched" instance;
 * every displayed position is a fresh transformed copy, per the header).
 */
export function pathPatternEntities(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  ids: readonly string[],
  count: number,
  transformAt: (k: number) => CopyTransform,
  newId: () => string = () => crypto.randomUUID(),
): PatternResult | string {
  if (!(Number.isInteger(count)) || count < 2) {
    return 'Path pattern: count must be a whole number >= 2'
  }
  const sources = ids
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is SketchEntity => e !== undefined && !e.construction)
  if (sources.length === 0) return 'Path pattern: nothing to pattern'
  const sourceIds = new Set(sources.map((e) => e.id))
  const internal = constraints.filter((c) => remappable(c, sourceIds))

  const outEntities: SketchEntity[] = []
  const outConstraints: SketchConstraint[] = []
  for (let k = 0; k < count; k++) {
    const t = transformAt(k)
    const m = new Map<string, string>()
    for (const e of sources) {
      const id = newId()
      m.set(e.id, id)
      outEntities.push(transformEntity(e, t, id))
    }
    for (const c of internal) {
      const rc = remapConstraint(c, m, newId, t.dTheta)
      if (rc) outConstraints.push(rc)
    }
  }
  return { entities: outEntities, constraints: outConstraints }
}

/** Ghost copies for the live confirm overlay — the SAME transformAt the
 *  commit uses, so ghost == committed (preview-equals-commit invariant). */
export function pathPatternPreview(
  chain: PathPatternChainState,
  entities: readonly SketchEntity[],
): SketchEntity[] | null {
  if (!chain.path || chain.ids.length === 0) return null
  const sources = chain.ids
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is SketchEntity => e !== undefined && !e.construction)
  if (sources.length === 0) return null
  const reference = centroidOfEntities(sources)
  const transformAt = pathPatternTransformAt(
    chain.path, reference, chain.count, chain.spacingMode, chain.fixedSpacing, chain.followTangent,
  )
  const out: SketchEntity[] = []
  for (let k = 0; k < chain.count; k++) {
    const t = transformAt(k)
    sources.forEach((e, i) => out.push(transformEntity(e, t, `__patp${k}_${i}__`)))
  }
  return out
}

/** Commit for a path-locked path pattern at the chain's live count/spacing/
 *  orientation — the confirm overlay's OK. */
export function pathPatternApply(
  chain: PathPatternChainState,
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  newId?: () => string,
): PatternResult | string {
  if (!chain.path) return 'Path pattern: click the path first'
  const sources = chain.ids
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is SketchEntity => e !== undefined && !e.construction)
  if (sources.length === 0) return 'Path pattern: nothing to pattern'
  const reference = centroidOfEntities(sources)
  const transformAt = pathPatternTransformAt(
    chain.path, reference, chain.count, chain.spacingMode, chain.fixedSpacing, chain.followTangent,
  )
  return pathPatternEntities(entities, constraints, chain.ids, chain.count, transformAt, newId)
}

// ---- Path pattern click behavior --------------------------------------------------

/** Nearest patternable PATH entity (line/arc/spline/elliptical-arc; NOT
 *  circle/ellipse/point/text/block — matches the WO's listed path shapes),
 *  excluding the pattern set's own ids (self-reference guard). Construction
 *  curves are allowed (a path is a guide curve, never baked). */
type PathPickable = Extract<SketchEntity, { kind: 'line' | 'arc' | 'spline' | 'elliptical-arc' }>

function pickPatternPath(
  entities: readonly SketchEntity[],
  world: Vec2,
  tol: number,
  excludeIds: ReadonlySet<string>,
): PathPickable | null {
  let best: { e: PathPickable; d: number } | null = null
  for (const e of entities) {
    if (excludeIds.has(e.id)) continue
    if (e.kind !== 'line' && e.kind !== 'arc' && e.kind !== 'spline' && e.kind !== 'elliptical-arc') continue
    const d = entityDistance(e, world)
    if (d <= tol && (!best || d < best.d)) best = { e, d }
  }
  return best?.e ?? null
}

function pathSourceFor(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  e: PathPickable,
): PatternPathSource {
  if (e.kind === 'spline') return { kind: 'spline', entity: e }
  if (e.kind === 'elliptical-arc') return { kind: 'elliptical-arc', entity: e }
  // line / arc: construction geometry never chains (chainContaining excludes
  // it, matching the bake) — a construction path is its own single-step
  // standalone chain.
  const ch = e.construction ? null : chainContaining(entities, constraints, e.id)
  return ch
    ? { kind: 'chain', steps: ch.steps, closed: ch.closed }
    : { kind: 'chain', steps: [{ entity: e, forward: true }], closed: false }
}

/**
 * CLICK(p) for the armed path-pattern tool: set-toggle until Confirm, then
 * the path-pick click (re-clicks re-pick it); the overlay's OK commits.
 */
export function pathPatternClick(
  chain: PathPatternChainState | null,
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  world: Vec2,
  tol: number,
): PatternClickOutcome<PathPatternChainState> {
  if (chain?.confirmed) {
    const hit = pickPatternPath(entities, world, tol, new Set(chain.ids))
    if (!hit) {
      return {
        chain,
        notice: 'Path pattern: click a line, arc, spline, elliptical arc, or chain to use as the path',
      }
    }
    return { chain: { ...chain, path: pathSourceFor(entities, constraints, hit) }, notice: null }
  }

  const ids = chain?.ids ?? []
  if (!chain && !pickEntity(entities, world, tol)) {
    return { chain: null, notice: null }
  }
  const t = setPhaseClick(ids, entities, world, tol)
  return {
    chain: {
      kind: 'pathpat', ids: t.ids, confirmed: false, path: null,
      count: 5, spacingMode: 'equal', fixedSpacing: 10, followTangent: false,
      ...(chain?.seeded ? { seeded: true } : {}),
    },
    notice: t.notice,
  }
}
