// WO SKC-49 (Operator Q-35): origin + X/Y axis reserved, session-only dimension pick targets.
// ONE convention shared by BOTH sketch hosts (workbench, CAM) -- the injected-entity design the WO
// binds to: the origin was already a fixed construction POINT injected at the session boundary
// (workbenchOriginAnchor.ts's original, workbench-only module); this file generalizes that pattern
// into a host-neutral core so CAM's own injection seam (src/store/index.ts) and the workbench's
// (workbenchOriginAnchor.ts, now a thin frame-projecting wrapper around this file) share IDENTICAL
// ids, geometry and strip semantics. That is what lets an angle/distancePL dimension against an axis
// flow through dimTool.ts's EXISTING planDimension branches with zero new dimension kind, zero
// gcsMapping change and zero new operand type in EITHER host.
//
// Each host supplies its own LOCAL origin (workbench: the world origin projected onto the sketch's
// PlaneFrame; CAM: always (0,0) -- CNCViewport's sketch plane IS world XY, see CNCViewport.ts's own
// "CAM's sketch plane is world XY" comment) -- everything else (ids, axis geometry, strip) is shared
// here so the two hosts cannot silently diverge.

import type { Sketch, Vec2 } from './types'

/** Stable session-only ids. Persisted dimensions/constraints may reference them, so they must be
 *  identical every time the same document is reopened. None of the three reserved entities is ever
 *  serialized in payload.sketch / activeSketch's stored form -- both hosts strip before persist. */
export const SKETCH_ORIGIN_ENTITY_ID = '__workbench_origin_anchor__'
export const SKETCH_ORIGIN_FIX_ID = '__workbench_origin_anchor_fix__'
export const SKETCH_AXIS_X_ENTITY_ID = '__sketch_axis_x__'
export const SKETCH_AXIS_X_FIX_ID = '__sketch_axis_x_fix__'
export const SKETCH_AXIS_Y_ENTITY_ID = '__sketch_axis_y__'
export const SKETCH_AXIS_Y_FIX_ID = '__sketch_axis_y_fix__'

// The origin id/fix-id keep their ORIGINAL literal strings (pre-SKC-49): they are already load-bearing
// in persisted test fixtures and any project saved between the origin-anchor WO and this one carried
// dimensions/constraints referencing '__workbench_origin_anchor__' via the strip-on-save guarantee
// (never actually persisted, but worth keeping the id stable regardless -- zero reason to churn it).

export const SKETCH_INJECTED_ENTITY_IDS: ReadonlySet<string> = new Set([
  SKETCH_ORIGIN_ENTITY_ID, SKETCH_AXIS_X_ENTITY_ID, SKETCH_AXIS_Y_ENTITY_ID,
])
export const SKETCH_INJECTED_CONSTRAINT_IDS: ReadonlySet<string> = new Set([
  SKETCH_ORIGIN_FIX_ID, SKETCH_AXIS_X_FIX_ID, SKETCH_AXIS_Y_FIX_ID,
])

/** True for the origin point OR either axis line. WO SKC-49-R1 (audit finding [2]): the single-id
 *  delete guard in both hosts (store/index.ts deleteSketchItems, workbenchSketchDocumentPort.ts
 *  deleteSelection) calls this rather than re-deriving `SKETCH_INJECTED_ENTITY_IDS.has(id)` inline.
 *  Marquee exclusion (sketchLayer.ts) and paint dimming test the Set directly (they already hold a
 *  Set, not a lone id) -- this predicate exists for the per-id call sites only. */
export function isInjectedSketchAnchorId(id: string): boolean {
  return SKETCH_INJECTED_ENTITY_IDS.has(id)
}

/** Half-length (mm) of each injected axis line. Large enough that no realistic sketch geometry ever
 *  reaches an endpoint -- dimTool.ts's pickDimOperand measures a line body with segDistance, which
 *  stops at the two finite endpoints (dimTool.ts:784), so PICK EXTENT === PAINT EXTENT by construction
 *  (sketchLayer.ts paints the exact same e.start/e.end this module assigns) as long as both stay well
 *  outside any real workpiece. 100 m is ~1000x a large CNC sheet and still an ordinary finite number
 *  (never Infinity -- an actually-infinite line has no segDistance-representable pick target and no
 *  finite bounding geometry, which would break the WO's own "pick extent === paint extent" bind). */
export const SKETCH_AXIS_HALF_LENGTH_MM = 100_000

/** Remove only the three reserved session objects. User dimensions/constraints that reference their
 *  stable ids intentionally survive (strip-on-save contract, unchanged from the origin-only design),
 *  ready to re-resolve when the anchors are re-injected on the next session entry. */
export function stripSketchAnchors(sketch: Sketch): Sketch {
  return {
    ...sketch,
    entities: sketch.entities.filter((entity) => !SKETCH_INJECTED_ENTITY_IDS.has(entity.id)),
    constraints: sketch.constraints.filter((constraint) => !SKETCH_INJECTED_CONSTRAINT_IDS.has(constraint.id)),
  }
}

/** WO SKC-49-R1 policy (audit finding [0]; ADR-0003 "never silently discard user work"): axis-only
 *  dimensions/constraints ARE content. A sketch whose only surviving material after
 *  `stripSketchAnchors` is one or more user-authored dimensions or constraints -- e.g. a lone
 *  distance dim pinned to an injected axis, with zero user ENTITIES -- is NON-EMPTY and must persist
 *  on Finish, not be classified as an aborted/empty entry. `stripped.constraints` already excludes
 *  the three injected fix constraints (see `stripSketchAnchors` above), and `dimensions` never
 *  carries an injected member (nothing here is ever auto-dimensioned) -- so every constraint/
 *  dimension surviving the strip is, by construction, user-authored. This is the ONE non-empty test
 *  every gate that used to read raw/stripped `entities.length` for emptiness must use instead.
 *  Takes an ALREADY-STRIPPED sketch (callers that already hold one, e.g. bakeActiveSketch, pass it
 *  straight through with no second strip pass); `sketchHasUserContent` below strips for callers that
 *  only have the raw, live document. */
export function strippedSketchHasUserContent(stripped: Sketch): boolean {
  return stripped.entities.length > 0 || stripped.dimensions.length > 0 || stripped.constraints.length > 0
}

/** Convenience wrapper over `strippedSketchHasUserContent` for callers holding the raw (unstripped)
 *  live sketch, not already-stripped output. */
export function sketchHasUserContent(sketch: Sketch): boolean {
  return strippedSketchHasUserContent(stripSketchAnchors(sketch))
}

/** Canonicalize the live session to exactly one fixed construction point at `originLocal` plus two
 *  fixed construction axis lines through it (local +/-X, local +/-Y). Filtering first makes create,
 *  finish/re-enter, undo/redo and repeated injection idempotent -- the same guarantee the original
 *  origin-only `injectWorkbenchOrigin` made. A whole-entity 'fix' on each axis line grounds BOTH its
 *  endpoints (gcsMapping.ts entityPoints/collectFixedPointIds: a line owns :start and :end) --
 *  exactly the same mechanism the origin's point-site fix already used, so no new constraint kind. */
export function injectSketchAnchors(sketch: Sketch, originLocal: Vec2): Sketch {
  if (!Number.isFinite(originLocal.x) || !Number.isFinite(originLocal.y)) {
    throw new Error('Sketch anchor injection origin is not finite')
  }
  const base = stripSketchAnchors(sketch)
  const L = SKETCH_AXIS_HALF_LENGTH_MM
  const { x, y } = originLocal
  return {
    ...base,
    entities: [
      ...base.entities,
      { id: SKETCH_ORIGIN_ENTITY_ID, kind: 'point', construction: true, at: { x, y } },
      {
        id: SKETCH_AXIS_X_ENTITY_ID, kind: 'line', construction: true,
        start: { x: x - L, y }, end: { x: x + L, y },
      },
      {
        id: SKETCH_AXIS_Y_ENTITY_ID, kind: 'line', construction: true,
        start: { x, y: y - L }, end: { x, y: y + L },
      },
    ],
    constraints: [
      ...base.constraints,
      {
        id: SKETCH_ORIGIN_FIX_ID, kind: 'fix',
        point: { entityId: SKETCH_ORIGIN_ENTITY_ID, site: 'self' },
      },
      { id: SKETCH_AXIS_X_FIX_ID, kind: 'fix', entityId: SKETCH_AXIS_X_ENTITY_ID },
      { id: SKETCH_AXIS_Y_FIX_ID, kind: 'fix', entityId: SKETCH_AXIS_Y_ENTITY_ID },
    ],
  }
}
