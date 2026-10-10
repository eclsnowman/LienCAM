// CAM-BINDING Stage 2: resolveModelReferenceFrame - the ONE named seam every
// world-position resolution of model-backed geometry (op compute, stock,
// setup origin, boundary - current and future) must flow through, per the
// program's coordinator MANDATE (coordination/work-orders/CAM-BINDING.md,
// "COORDINATOR DECISION 2026-07-22").
//
// Stage 1 disclosed (docs/planning/POST-MERGE-WORKPLAN.md, "HONEST GAP") that
// it did not introduce this function: Stage 1 creates no ModelReference and
// resolves no world position, so a placeholder with no caller would have been
// hollow scaffolding. Stage 2's derive step is the first real caller - it
// needs a modeled body's world pose to bake into the Loop2D it derives from
// the body's LOCAL-space tessellation, so this is where the seam becomes real.
//
// It is a THIN composition, not a new algorithm: it exists because four call
// sites (Viewport.tsx draw, restoreScene.ts scene-restore draw,
// PropertiesPanel.tsx x2 for read/write) each independently inlined the same
// two-step "build the placement registry from the project's records, then
// resolve" pattern. Repo convention (the shared-resolver rule) is that a
// composition used by more than one consumer gets ONE named function, not N
// inlined copies with N chances to drift - this is that function, and this
// commit also points the four pre-existing call sites through it so it is
// genuinely the one seam, not a fifth parallel implementation.
import { placementRegistry, resolveModelItemPlacement } from './modelItemPlacement'
import type { ModelItemPlacementRegistryEntry, RigidTransform } from './modelItemPlacement'

export type { RigidTransform }

/**
 * Resolve a modeled body's world-space rigid transform (position + Euler
 * rotation, degrees), composing through INT-17C's resolveModelItemPlacement.
 *
 * `placementRecords` is the project's `modelItemPlacements` array (or a
 * caller's live-store equivalent) - passed explicitly, not read from a hidden
 * store, mirroring modelItemPlacement.ts's own purity contract (no kernel
 * call, no store dependency, no side effect).
 *
 * Fails loud (ADR-0003): throws `ModelItemPlacementResolutionError` when no
 * Placement record exists for `modelItemId`(+`bodyId`) - never silently
 * substitutes identity. Callers that want a defensive display-only fallback
 * (e.g. a properties-panel readout before any record exists) catch it
 * themselves, same as every existing call site already does.
 */
export function resolveModelReferenceFrame(
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
  modelItemId: string,
  bodyId?: string,
): RigidTransform {
  return resolveModelItemPlacement(placementRegistry(placementRecords), modelItemId, bodyId)
}

const FRAME_FINGERPRINT_SCALE = 100_000

function quantizedFrameComponent(value: number): string {
  return Math.round(value * FRAME_FINGERPRINT_SCALE).toString()
}

/**
 * WO-1400: stable fingerprint of a resolved world-space frame's position +
 * rotation, for staleness checks (e.g. a tracked model section) that must
 * notice a Placement move/rotate independent of any content-only fingerprint.
 * Quantized to 0.00001 mm/deg, mirroring modelBodyGeometryFingerprint's own
 * tolerance for harmless serialization noise.
 */
export function modelReferenceFrameFingerprint(frame: RigidTransform): string {
  return [
    'v1',
    quantizedFrameComponent(frame.position.x),
    quantizedFrameComponent(frame.position.y),
    quantizedFrameComponent(frame.position.z),
    quantizedFrameComponent(frame.rotation.x),
    quantizedFrameComponent(frame.rotation.y),
    quantizedFrameComponent(frame.rotation.z),
  ].join(',')
}
