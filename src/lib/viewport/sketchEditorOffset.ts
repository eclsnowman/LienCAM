import type { ImportedGeometry } from '../../types'
import type { SketchOffset } from '../sketch/sketcher/sketchLayer'

/**
 * Resolve the sketch-editor DISPLAY offset for the layer being edited.
 *
 * OWNER RULE (Operator ruling 2026-07-22, final): a sketch edits at the conventional
 * workspace origin unless it belongs to a genuine NEST seed. Nest seeds are
 * deliberately posed at their placement slot (nest pack, store/index.ts,
 * ADR 0024) so the seed's sketch document can be edited AT its visible slot
 * -- that offset is intentional and must be preserved. Every OTHER owner --
 * the shared ad hoc "New Sketch" container (SKETCH_CONTAINER_ID, every
 * New-Sketch layer lives on it) and any plain/imported geometry the user has
 * dragged elsewhere in the workspace -- must NOT let its position/rotation
 * leak into the sketch editor: dragging/moving geometry stays fully allowed,
 * but it must never displace where a non-nest sketch opens for editing.
 * (Prior bug: the offset was applied unconditionally for ANY owner, so
 * moving the shared container -- or any plain geometry -- via the
 * Properties panel or the move gizmo silently relocated every sketch editor
 * that lived on it.)
 *
 * The genuine-nest-seed marker is `ImportedGeometry.ownerNestId` (set only
 * on a nest's deep-copied seed geometry -- see ADR 0025 Sec.2 and the
 * `ownerNestId` field doc in src/types/index.ts). Any owner without it --
 * including the ad hoc container, which is never nest-owned -- resolves to
 * the identity offset.
 *
 * Accepted consequence (owner-informed): editing a sketch whose geometry was
 * moved shows the content near the origin WHILE editing, then the geometry's
 * real position is re-applied on finish -- a mode-to-mode jump, not a bug.
 *
 * Returns undefined when no owner geometry is found for the layer (callers
 * fall back to the identity offset, matching prior behavior).
 */
export function resolveSketchEditorOffset(
  geometry: readonly ImportedGeometry[],
  layerId: string,
): SketchOffset | undefined {
  const owner = geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))
  if (!owner) return undefined
  if (owner.ownerNestId === undefined) {
    // Ad hoc container or any other non-nest-owned geometry: identity,
    // regardless of where the owner has been dragged in the workspace.
    return { x: 0, y: 0, rotationDeg: 0 }
  }
  // Genuine nest seed: preserve the deliberate slot-pose display offset.
  return { x: owner.position.x, y: owner.position.y, rotationDeg: owner.rotation.z }
}
