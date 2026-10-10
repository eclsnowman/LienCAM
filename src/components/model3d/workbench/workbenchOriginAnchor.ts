import type { Sketch, Vec2 } from '../../../lib/sketch/sketcher'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import { worldToLocal } from '../../../sketch3d/planeMath'
import {
  SKETCH_ORIGIN_ENTITY_ID,
  SKETCH_ORIGIN_FIX_ID,
  SKETCH_AXIS_X_ENTITY_ID,
  SKETCH_AXIS_X_FIX_ID,
  SKETCH_AXIS_Y_ENTITY_ID,
  SKETCH_AXIS_Y_FIX_ID,
  SKETCH_INJECTED_ENTITY_IDS,
  SKETCH_INJECTED_CONSTRAINT_IDS,
  injectSketchAnchors,
  stripSketchAnchors,
  isInjectedSketchAnchorId,
} from '../../../lib/sketch/sketchAnchors'

// WO SKC-49: this module is now a thin, workbench-flavored wrapper over the host-neutral
// sketchAnchors.ts core (frame projection is the ONLY thing genuinely workbench-specific --
// CAM's own injection seam, src/store/index.ts, calls the same core with its always-(0,0) local
// origin). Every existing export below keeps its ORIGINAL name so the three pre-existing call
// sites (sketchSessionStore.ts, workbenchSketchDocumentPort.ts x3) need zero changes; the ids are
// now re-exports of the shared constants so both hosts can never diverge on what an "origin" or
// "axis" id even is. The two axis ids are exported fresh here (no prior workbench-only name to
// preserve) for the guard/paint call sites this WO adds in workbenchSketchDocumentPort.ts.
export const WORKBENCH_ORIGIN_ENTITY_ID = SKETCH_ORIGIN_ENTITY_ID
export const WORKBENCH_ORIGIN_FIX_ID = SKETCH_ORIGIN_FIX_ID
export const WORKBENCH_AXIS_X_ENTITY_ID = SKETCH_AXIS_X_ENTITY_ID
export const WORKBENCH_AXIS_X_FIX_ID = SKETCH_AXIS_X_FIX_ID
export const WORKBENCH_AXIS_Y_ENTITY_ID = SKETCH_AXIS_Y_ENTITY_ID
export const WORKBENCH_AXIS_Y_FIX_ID = SKETCH_AXIS_Y_FIX_ID
/** Every reserved entity id this module injects (origin + both axes). Marquee exclusion
 *  (sketchLayer.ts) still tests membership against this Set directly; the single-id delete guard
 *  below uses `isInjectedSketchAnchorId` (WO SKC-49-R1: one predicate, actually wired to every
 *  per-id guard, not just documented as such). */
export const WORKBENCH_INJECTED_ENTITY_IDS = SKETCH_INJECTED_ENTITY_IDS
export const WORKBENCH_INJECTED_CONSTRAINT_IDS = SKETCH_INJECTED_CONSTRAINT_IDS
/** Re-exported so call sites needing a per-id predicate (not a Set) never re-derive one. */
export { isInjectedSketchAnchorId }

const WORLD_ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 })

/** World origin projected onto `frame`, expressed in the frame's local coordinates. The normal
 * component is deliberately discarded by worldToLocal, which is exactly orthogonal projection onto
 * the sketch plane. Refuse non-finite output at this accept point rather than letting NaN pass every
 * downstream tolerance comparison. */
export function workbenchOriginAnchorLocal(frame: PlaneFrame): Vec2 {
  const at = worldToLocal(frame, WORLD_ORIGIN)
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
    throw new Error('Workbench origin anchor projection is not finite')
  }
  return at
}

/** Remove the three reserved session objects (origin point + both axis lines, plus their fix
 * constraints). User dimensions and constraints that reference their stable ids intentionally
 * survive, ready to re-resolve when the anchors are re-injected on the next session entry. */
export function stripWorkbenchOrigin(sketch: Sketch): Sketch {
  return stripSketchAnchors(sketch)
}

/** Canonicalize the live session to exactly one fixed construction point at the projected world
 * origin, plus two fixed construction axis lines through it (local +/-X, local +/-Y -- WO SKC-49).
 * Filtering first (inside injectSketchAnchors) makes create, finish/re-enter, undo/redo, and
 * repeated injection idempotent, exactly as the origin-only version did. */
export function injectWorkbenchOrigin(sketch: Sketch, frame: PlaneFrame): Sketch {
  const at = workbenchOriginAnchorLocal(frame)
  return injectSketchAnchors(sketch, at)
}
