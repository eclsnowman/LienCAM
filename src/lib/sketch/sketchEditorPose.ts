import type { ImportedGeometry } from '../../types'
import type { SketchOffset } from './sketcher/sketchLayer'

/**
 * WO-2854: the pose the sketch editor draws an open document at - the OWNING
 * part's own placement, the same position + Z rotation the CAM view gives that
 * part's 2D group (CNCViewport.add2DGeometry / setPartTransform). A layer
 * opened for editing therefore sits exactly where it lives, on top of the
 * part's other layers, and Finish bakes the unchanged local entities back to
 * the same place.
 *
 * Replaces the 2026-07-22 rule (src/lib/viewport/sketchEditorOffset.ts) that
 * posed only nest seeds and drew every other owner at the workspace origin.
 * The operator, 2026-10-15, on Full Suite's Leadscrew_Stepper_Mount (placed at
 * x = -79.9): "It moves part of that sketch to the right, not where it
 * currently lives." The origin pose was that shift.
 *
 * Owner resolution matches openSketchForLayer: the stamped ownerGeometryId
 * first (DXF/SVG layer ids collide across re-imports), first match by layer id
 * only when no owner was recorded. Undefined when no owner holds the layer
 * (callers draw at the identity pose).
 */
export function resolveSketchEditorPose(
  geometry: readonly ImportedGeometry[],
  sketch: { layerId: string; ownerGeometryId?: string },
): SketchOffset | undefined {
  const holdsLayer = (g: ImportedGeometry) => g.layers2d?.some((l) => l.id === sketch.layerId) ?? false
  const owner = (sketch.ownerGeometryId
    ? geometry.find((g) => g.id === sketch.ownerGeometryId && holdsLayer(g))
    : undefined) ?? geometry.find(holdsLayer)
  if (!owner) return undefined
  return { x: owner.position.x, y: owner.position.y, rotationDeg: owner.rotation.z }
}
