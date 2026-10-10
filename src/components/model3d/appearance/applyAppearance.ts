// WO UI-4 acceptance #5: paint per-body/per-face custom colors onto a
// CachedBody's vertex-color attribute -- composes with viewport3d/
// highlight.ts rather than duplicating it: call this AFTER
// applyFaceHighlights/applyEdgeHighlights each repaint, so hover/selected
// faces keep showing pick feedback (Operator's Q-1 feedback-bar ruling) and only
// 'none'-state faces get repainted with their custom appearance color. Same
// per-vertex color-attribute technique as highlight.ts, same
// attachHighlightAttributes() precondition.

import * as THREE from 'three'
import type { CachedBody } from '../../../viewport3d'
import type { SelectionState } from '../../../viewport3d'
import type { StableId } from '../../../geom/geom-service'
import { srgbUnitRgbToLinearRgb } from '../../../lib/viewport/lighting/bodyVisualStyle'
import type { AppearanceStore, BodyId, RGB } from './appearanceStore'

const DEFAULT_BASE: RGB = [0.8, 0.8, 0.82]

function requireColorAttribute(geometry: THREE.BufferGeometry, what: string): THREE.BufferAttribute {
  const attr = geometry.getAttribute('color')
  if (attr === undefined) {
    throw new Error(`appearance: ${what} has no 'color' attribute -- call attachHighlightAttributes() first`)
  }
  return attr as THREE.BufferAttribute
}

/** Repaint every 'none'-highlighted triangle with its face's custom
 *  appearance color, falling back to the body's own custom color, falling
 *  back to `defaultBase` -- must run after applyFaceHighlights() in the
 *  same repaint pass. */
export function applyFaceAppearance(
  body: CachedBody,
  bodyId: BodyId,
  selection: SelectionState,
  appearance: AppearanceStore,
  defaultBase: RGB = DEFAULT_BASE,
): void {
  const colorAttr = requireColorAttribute(body.geometry, 'body.geometry')
  const index = body.geometry.getIndex()
  if (index === null) throw new Error('appearance: body.geometry has no index buffer')

  const bodyColor = appearance.bodyColor(bodyId)
  const seenFaces = new Set<StableId>()
  for (let t = 0; t < body.triFace.length; t++) {
    const faceIndex = body.triFace[t]
    const faceId = body.faceIds[faceIndex]
    seenFaces.add(faceId)
    if (selection.highlightFor(faceId) !== 'none') continue
    const assignedColor = appearance.faceColor(faceId) ?? bodyColor
    const [r, g, b] = assignedColor === undefined
      ? defaultBase
      : srgbUnitRgbToLinearRgb(assignedColor)
    for (let k = 0; k < 3; k++) {
      const vi = index.getX(t * 3 + k)
      colorAttr.setXYZ(vi, r, g, b)
    }
  }
  colorAttr.needsUpdate = true
}
