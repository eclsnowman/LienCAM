// WO SKC-8: relocated from src/components/sketch3dlab/picking.ts (WO INT-2) and now the SINGLE
// shared copy consumed by both the sketch3d lab and the SolidsWorkbenchPage editing session.
// sketch3dlab/picking.ts is a thin re-export shim over this file.
//
// World-space hit-testing for the select/drag tools. Point picks take priority over entity-body
// picks at the call site (a point ref is more specific); both are pure so they're testable without
// a canvas or a React render.
import { sketch3dPointSamples } from '../../sketch3d'
import type { Sketch3dDocument, Sketch3dEntity, Sketch3dPointRef, Sketch3dPointSite, Sketch3dVec2 } from '../../sketch3d'
import { distance, distanceToArcRing, distanceToRing, distanceToSegment } from './geometry2d'

export const SKETCH3DLAB_POINT_PICK_TOLERANCE = 0.6
export const SKETCH3DLAB_ENTITY_PICK_TOLERANCE = 0.6

export function pickPoint(
  document: Sketch3dDocument,
  worldPoint: Sketch3dVec2,
  tolerance = SKETCH3DLAB_POINT_PICK_TOLERANCE,
): Sketch3dPointRef | null {
  let best: Sketch3dPointRef | null = null
  let bestDistance = Infinity
  for (const sample of sketch3dPointSamples(document)) {
    const d = distance(sample.at, worldPoint)
    if (d <= tolerance && d < bestDistance) {
      best = sample.ref
      bestDistance = d
    }
  }
  return best
}

export function pickEntity(
  document: Sketch3dDocument,
  worldPoint: Sketch3dVec2,
  tolerance = SKETCH3DLAB_ENTITY_PICK_TOLERANCE,
): string | null {
  let best: string | null = null
  let bestDistance = Infinity
  for (const entity of document.entities) {
    let d: number
    switch (entity.kind) {
      case 'point':
        d = distance(entity.at, worldPoint)
        break
      case 'line':
        d = distanceToSegment(worldPoint, entity.start, entity.end)
        break
      case 'circle':
        d = distanceToRing(worldPoint, entity.center, entity.radius)
        break
      case 'arc':
        d = distanceToArcRing(worldPoint, entity)
        break
    }
    if (d <= tolerance && d < bestDistance) {
      best = entity.id
      bestDistance = d
    }
  }
  return best
}

/** WO SKC-8 (A1/A3, Operator's "grab-anywhere" bar -- the CAM sketcher's startSketchDrag model,
 *  src/store/index.ts ~6392-6527): a single grab-site resolver shared by hover-affordance,
 *  select-click, and drag-start, so all three always agree on "what would this click/hover grab".
 *
 *  - A precise point hit (line endpoint, circle/arc center) wins first, exactly like pickPoint.
 *  - A circle/arc's RING is a body-drag by definition here: its only addressable/draggable point
 *    IS its center (pointSamples.ts has no circle/arc 'ring' site), so translating the center via
 *    the existing single-point Sketch3dDragSession already rigidly translates the whole entity --
 *    grabbing the ring is reported as a 'point' target on that entity's center, not a distinct
 *    'body' kind. This is also the concrete fix for Operator's "drag did not work for me at all":
 *    the OLD lab 'drag' tool only ever called pickPoint, whose center sample sits at the
 *    (usually invisible) middle of the circle, never on the visible ring the user actually
 *    clicks -- pickGrabTarget checks the ring via pickEntity too, so clicking the visible curve
 *    now resolves to the same center-drag.
 *  - A line has TWO independent points -- grabbing its body (away from both endpoints) cannot
 *    collapse to a single point pin, so it is reported as a genuine 'body' target for the caller's
 *    rigid two-point drag controller (dragController.ts) to handle. */
export type Sketch3dGrabTarget =
  | { kind: 'point'; ref: Sketch3dPointRef; entityId: string }
  | { kind: 'body'; entityId: string }

function entityKindOf(document: Sketch3dDocument, entityId: string): Sketch3dEntity['kind'] | undefined {
  return document.entities.find((e) => e.id === entityId)?.kind
}

export function pickGrabTarget(
  document: Sketch3dDocument,
  worldPoint: Sketch3dVec2,
  pointTolerance = SKETCH3DLAB_POINT_PICK_TOLERANCE,
  entityTolerance = SKETCH3DLAB_ENTITY_PICK_TOLERANCE,
): Sketch3dGrabTarget | null {
  const point = pickPoint(document, worldPoint, pointTolerance)
  if (point) return { kind: 'point', ref: point, entityId: point.entityId }

  const entityId = pickEntity(document, worldPoint, entityTolerance)
  if (entityId === null) return null
  const kind = entityKindOf(document, entityId)
  if (kind === 'circle' || kind === 'arc') {
    return { kind: 'point', ref: { entityId, site: 'center' }, entityId }
  }
  if (kind === 'point') {
    return { kind: 'point', ref: { entityId, site: 'self' }, entityId }
  }
  // line (and any future multi-point kind): true rigid body drag.
  return { kind: 'body', entityId }
}

/** Hover affordance (A3): is there anything grabbable under this world point right now? Pure
 *  boolean wrapper over pickGrabTarget so callers driving cursor/highlight state don't need to
 *  care which specific target kind resolved. */
export function isGrabbable(
  document: Sketch3dDocument,
  worldPoint: Sketch3dVec2,
  pointTolerance = SKETCH3DLAB_POINT_PICK_TOLERANCE,
  entityTolerance = SKETCH3DLAB_ENTITY_PICK_TOLERANCE,
): boolean {
  return pickGrabTarget(document, worldPoint, pointTolerance, entityTolerance) !== null
}

/** WO SKC-8-R1 (Blocker 2, share-do-not-fork): the CURRENT world position of `entity`'s
 *  addressable `site` point -- the SHARED offset-preserving-drag primitive both surfaces must use
 *  for every point-kind grab target pickGrabTarget can resolve to, not just circle/arc ring hits.
 *  pickGrabTarget's own header explains why this matters: a circle/arc RING click resolves to a
 *  'point' target on that entity's 'center' site, which usually sits `radius` away from the actual
 *  click -- and even a direct point/endpoint pick can land up to a full pick-tolerance away from
 *  the point itself. Every caller must therefore derive its drag delta from THIS point's own
 *  position (captured once, at grab time), never assume the initial click coincides with it, or
 *  the very first frame of the drag snaps the point onto the raw cursor instead of translating it
 *  rigidly by the gesture's own delta (the exact defect: "circle/arc ring grabs lose the grab
 *  offset and snap the center to the ring cursor"). */
export function pointPositionOf(entity: Sketch3dEntity, site: Sketch3dPointSite): Sketch3dVec2 {
  switch (entity.kind) {
    case 'point':
      return entity.at
    case 'line':
      return site === 'start' ? entity.start : entity.end
    case 'circle':
      return entity.center
    case 'arc': {
      if (site === 'center') return entity.center
      const angle = site === 'start' ? entity.startAngle : entity.endAngle
      return { x: entity.center.x + entity.radius * Math.cos(angle), y: entity.center.y + entity.radius * Math.sin(angle) }
    }
  }
}

/** Small vector-add helper shared by every offset-preserving drag call site (workbench endpoint/
 *  body preview math, lab's point-kind drag-session cursor correction below). */
export function addVec2(p: Sketch3dVec2, dx: number, dy: number): Sketch3dVec2 {
  return { x: p.x + dx, y: p.y + dy }
}
