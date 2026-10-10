// WO SKC-5 (Q3): turns a world-space closed boundary loop (from
// components/model3d/workbench/faceBoundary.ts's face-outer-boundary
// extraction) into FIXED sketch3d line entities in the plane's LOCAL 2D
// coordinates. The helper now exists for legacy saved-sketch reattach and
// focused conversion tests; fresh face sketches are blank and explicit Project / Use uses the
// shared static-copy path. Pure, THREE-free, kernel-free: this
// file only ever sees plain Vec3 points and a PlaneFrame.
//
// Faceted, not curve-fit: a curved edge on the boundary arrives here already
// tessellated into short line segments (faceBoundary.ts's edgeWorldPoints
// output) -- V1 projects it as a faceted polyline of FIXED lines rather than
// fitting arcs back out of the tessellation. Honest for the recon's own
// scope (planar face only, Q2) since a planar face's straight edges tessellate
// to their exact two endpoints (isStraightEdge in measureLogic.ts confirms
// this codebase's own convention); a curved silhouette on a planar face's
// boundary (impossible for a true planar face, only reachable via a
// degenerate/self-intersecting profile) is out of scope either way.

import type { Sketch3dConstraint, Sketch3dEntity, Sketch3dFixedConstraint, Sketch3dLineEntity } from './types'
import { worldToLocal } from './planeMath'
import type { PlaneFrame } from './planeMath'
import type { Vec3 } from '../geom/geom-service'
import type { Sketch3dExternalRef } from './regen'

export interface ProjectedBoundary {
  entities: Sketch3dLineEntity[]
  /** AC #7: "solver treats as fixed" -- one whole-entity `fixed` constraint
   *  per projected line, which solveBridge.ts's mapping grounds BOTH the
   *  line's start and end points (see its own 'fixed' case comment). Never a
   *  point-level `fixed` flag: Sketch3dLineEntity stores raw start/end
   *  coordinates directly (no separate point entities to flag), so a
   *  whole-entity constraint is the only mapping this document model has. */
  constraints: Sketch3dFixedConstraint[]
  externalRef: Sketch3dExternalRef
}

/** `worldLoop` is closed (does not repeat its first point). */
export function projectFaceBoundaryToSketch(
  frame: PlaneFrame,
  worldLoop: Vec3[],
  opts: { sketchId: string; sourceFaceId: string; idPrefix?: string },
): ProjectedBoundary {
  const prefix = opts.idPrefix ?? 'ext'
  const local = worldLoop.map((p) => worldToLocal(frame, p))
  const entities: Sketch3dLineEntity[] = []
  const constraints: Sketch3dFixedConstraint[] = []
  const entityIds: string[] = []
  for (let i = 0; i < local.length; i++) {
    const a = local[i]
    const b = local[(i + 1) % local.length]
    const id = `${opts.sketchId}.${prefix}${i}`
    entities.push({ id, kind: 'line', start: a, end: b })
    constraints.push({ id: `${id}.fix`, kind: 'fixed', entityId: id })
    entityIds.push(id)
  }
  return { entities, constraints, externalRef: { sourceFaceId: opts.sourceFaceId, entityIds } }
}

/** Legacy reattach helper: replace entities recorded by PRIOR externalRefs while leaving user
 *  geometry alone. Fresh and explicitly projected sketches carry no such refs. */
export function replaceProjectedEntities(
  entities: Sketch3dEntity[],
  priorExternalRefs: Sketch3dExternalRef[],
  projected: ProjectedBoundary,
): Sketch3dEntity[] {
  const staleIds = new Set(priorExternalRefs.flatMap((r) => r.entityIds))
  return [...entities.filter((e) => !staleIds.has(e.id)), ...projected.entities]
}

/** Sibling of replaceProjectedEntities for the constraint array -- drops the
 *  prior projection's own `fixed` constraints (named `${entityId}.fix`,
 *  never collides with a user-authored constraint id) and appends the fresh
 *  ones. */
export function replaceProjectedConstraints(
  constraints: Sketch3dConstraint[],
  priorExternalRefs: Sketch3dExternalRef[],
  projected: ProjectedBoundary,
): Sketch3dConstraint[] {
  const staleIds = new Set(priorExternalRefs.flatMap((r) => r.entityIds.map((id) => `${id}.fix`)))
  return [...constraints.filter((c) => !staleIds.has(c.id)), ...projected.constraints]
}
