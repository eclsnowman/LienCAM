// Canvas constraint glyphs (WP3.3/3.4): a per-constraint render/hover/select/delete data model.
// This module never touches a canvas or DOM - it produces plain data (anchor point, highlighted
// entity/point ids, state) that a renderer (owned elsewhere) draws, and pure functions for the
// hover/select/delete interactions a renderer wires to pointer events. Deliberately kept out of
// the solve loop: computeConstraintGlyphs() is pure geometry lookup over the already-solved
// document/result, never itself a solve (criterion 6 - glyphs must not enter the hot path).
import { removeConstraint } from './constraintTools'
import { describeConstraint } from './constraintGeometry'
import type { Sketch3dConstraintGlyph, Sketch3dDocument, Sketch3dGlyphState, Sketch3dSolveResult, Sketch3dVec2 } from './types'

export function computeConstraintGlyphs(
  document: Sketch3dDocument,
  result?: Pick<Sketch3dSolveResult, 'conflicting' | 'redundant'>,
): Sketch3dConstraintGlyph[] {
  const conflicting = new Set(result?.conflicting ?? [])
  const redundant = new Set(result?.redundant ?? [])

  return document.constraints
    .map((constraint) => {
      const described = describeConstraint(document, constraint)
      const state: Sketch3dGlyphState = conflicting.has(constraint.id)
        ? 'conflicting'
        : redundant.has(constraint.id)
          ? 'redundant'
          : 'normal'
      return {
        constraintId: constraint.id,
        kind: constraint.kind,
        label: described.label,
        anchor: described.anchor,
        entityIds: described.entityIds,
        pointIds: described.pointIds,
        state,
      }
    })
}

function distance(a: Sketch3dVec2, b: Sketch3dVec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export const SKETCH3D_GLYPH_PICK_RADIUS = 6

export function hitTestGlyph(glyph: Sketch3dConstraintGlyph, point: Sketch3dVec2, pickRadius = SKETCH3D_GLYPH_PICK_RADIUS): boolean {
  return distance(glyph.anchor, point) <= pickRadius
}

// Hover: which glyph (if any) is under the cursor, plus what it should highlight.
export function hoverConstraintGlyph(
  glyphs: Sketch3dConstraintGlyph[],
  point: Sketch3dVec2,
  pickRadius = SKETCH3D_GLYPH_PICK_RADIUS,
): Sketch3dConstraintGlyph | null {
  let best: Sketch3dConstraintGlyph | null = null
  let bestDistance = Infinity
  for (const glyph of glyphs) {
    const d = distance(glyph.anchor, point)
    if (d <= pickRadius && d < bestDistance) {
      best = glyph
      bestDistance = d
    }
  }
  return best
}

// Select shares hit-testing with hover; kept as a distinct name because the UI treats it as a
// separate interaction (click vs pointer-move) that opens the deletability affordance.
export function selectConstraintGlyph(
  glyphs: Sketch3dConstraintGlyph[],
  point: Sketch3dVec2,
  pickRadius = SKETCH3D_GLYPH_PICK_RADIUS,
): Sketch3dConstraintGlyph | null {
  return hoverConstraintGlyph(glyphs, point, pickRadius)
}

export function glyphHighlightIds(glyph: Sketch3dConstraintGlyph): { entityIds: string[]; pointIds: string[] } {
  return { entityIds: glyph.entityIds, pointIds: glyph.pointIds }
}

export function deleteConstraintGlyph(document: Sketch3dDocument, glyph: Sketch3dConstraintGlyph): Sketch3dDocument {
  return removeConstraint(document, glyph.constraintId)
}
