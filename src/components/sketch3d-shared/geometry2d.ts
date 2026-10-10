// WO SKC-8: relocated verbatim from src/components/sketch3dlab/geometry2d.ts (WO INT-2) -- this
// is now the SINGLE shared copy consumed by both the sketch3d lab and the SolidsWorkbenchPage
// editing session's draw/pick tools (see this directory's README-equivalent header in index.ts).
// sketch3dlab/geometry2d.ts is a thin re-export shim over this file so every pre-existing lab
// import path (and test) keeps working unmodified.
//
// World<->screen transform + pure distance helpers used by both the canvas renderer and the
// picking module. Kept independent of the canvas element's own size (fixed origin/scale) so the
// same math runs identically in a real browser and in a jsdom test (whose canvas has a zero-size
// bounding rect) - a click is always resolved from `clientX/clientY - rect.left/top`, never from a
// width/height-relative NDC conversion.
import type { Sketch3dArcEntity, Sketch3dVec2 } from '../../sketch3d'
import { tessellateArc } from '../../lib/sketch/tools/arcTools'

export interface Sketch3dLabView {
  originX: number
  originY: number
  scale: number
}

// Fits the M2 bracket demo fixture (x in [0,45], y in [-2,26]) inside an ~760x620 canvas with
// margin, y flipped so +y is "up" on screen like a conventional sketch view.
export const SKETCH3DLAB_VIEW: Sketch3dLabView = { originX: 60, originY: 560, scale: 12 }

export function worldToScreen(p: Sketch3dVec2, view: Sketch3dLabView = SKETCH3DLAB_VIEW): Sketch3dVec2 {
  return { x: view.originX + p.x * view.scale, y: view.originY - p.y * view.scale }
}

export function screenToWorld(p: Sketch3dVec2, view: Sketch3dLabView = SKETCH3DLAB_VIEW): Sketch3dVec2 {
  return { x: (p.x - view.originX) / view.scale, y: (view.originY - p.y) / view.scale }
}

export function distance(a: Sketch3dVec2, b: Sketch3dVec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function distanceToSegment(p: Sketch3dVec2, a: Sketch3dVec2, b: Sketch3dVec2): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lengthSq = abx * abx + aby * aby
  if (lengthSq === 0) return distance(p, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq))
  return distance(p, { x: a.x + t * abx, y: a.y + t * aby })
}

export function distanceToRing(p: Sketch3dVec2, center: Sketch3dVec2, radius: number): number {
  return Math.abs(distance(p, center) - radius)
}

// Pick tolerance for an arc treats it as a full ring (ignores start/end sweep) - adequate for a
// mouse-pick tolerance and avoids needing sweep-angle-normalization edge cases here.
export function distanceToArcRing(p: Sketch3dVec2, arc: Pick<Sketch3dArcEntity, 'center' | 'radius'>): number {
  return distanceToRing(p, arc.center, arc.radius)
}

/** WO SKC-14 (BK-88, DECISIONS 2026-07-10): sketch3d no longer tessellates arcs. It DELEGATES to
 *  CAM's tessellateArc (src/lib/sketch/tools/arcTools.ts), which is now the only arc tessellator
 *  the workbench and the CAM sketcher both reach -- the walk itself lives once, in
 *  sketcher/geometry/arcTessellation.ts.
 *
 *  This closes the major SKC-12's audit HELD: the two implementations previously agreed on the
 *  canonical-CCW ANGLE ENCODING everywhere but on POINT IDENTITY only for 60-300deg sweeps,
 *  because their minimum-segment policies diverged (CAM max(8,..) vs sketch3d max(2,..)). One
 *  tessellator makes that band the whole range, and src/tests/sketch3d-shared/arcCanonical.test.ts
 *  now asserts full-range agreement with no sweep filter.
 *
 *  `firstPointSite: 'start'` is the correct travel order here: sketch3d has no reversal concept --
 *  it always walks its own startAngle -> endAngle. Callers that render a full circle as
 *  `{startAngle: 0, endAngle: 2*PI}` (SolidsWorkbenchPage) stay correct because the shared sweep
 *  normalizer maps a zero-modulo sweep to a full turn rather than to nothing. */
export function sampleArcPoints(
  arc: Pick<Sketch3dArcEntity, 'center' | 'radius' | 'startAngle' | 'endAngle'>,
): Sketch3dVec2[] {
  return tessellateArc({ ...arc, firstPointSite: 'start' })
}
