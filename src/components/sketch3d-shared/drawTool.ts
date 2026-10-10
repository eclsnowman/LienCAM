// WO SKC-8 (criterion 3, share-do-not-fork): the ONE draw-tool state machine consumed by both
// the sketch3d lab and the SolidsWorkbenchPage editing session -- POINTS_NEEDED is defined here
// and ONLY here (grep-able single source), so a click sequence resolves to the same entity
// construction regardless of which page is driving it.
import { makeArcEntity, makeCircleEntity, makeLineEntity } from './draftEntities'
import type { Sketch3dEntity, Sketch3dVec2 } from '../../sketch3d'

export type Sketch3dDrawToolKind = 'line' | 'circle' | 'arc'

/** How many click points each draw tool needs before it commits an entity. Defined ONCE (WO
 *  SKC-8 criterion 3) -- both pages import this instead of keeping their own local copy. */
export const SKETCH3D_DRAW_POINTS_NEEDED: Record<Sketch3dDrawToolKind, number> = { line: 2, circle: 2, arc: 3 }

export function isSketch3dDrawTool(tool: string): tool is Sketch3dDrawToolKind {
  return tool === 'line' || tool === 'circle' || tool === 'arc'
}

function buildDrawEntity(tool: Sketch3dDrawToolKind, id: string, points: Sketch3dVec2[]): Sketch3dEntity {
  switch (tool) {
    case 'line':
      return makeLineEntity(id, points[0], points[1])
    case 'circle':
      return makeCircleEntity(id, points[0], points[1])
    case 'arc':
      // A2 (Operator's rejection rider): input order is start, end, through-point.
      return makeArcEntity(id, points[0], points[1], points[2])
  }
}

export interface Sketch3dDrawStep {
  /** The draft points to keep showing as a preview -- empty once an entity commits. */
  draftPoints: Sketch3dVec2[]
  /** Set only on the click that completes the tool's point count. */
  entity?: Sketch3dEntity
}

/** Appends `point` to `draftPoints` and, once the tool's POINTS_NEEDED count is reached, builds
 *  and returns the finished entity (clearing draftPoints back to empty). `nextId` is supplied by
 *  the caller (each page owns its own id-counter/namespacing scheme) and is called AT MOST ONCE,
 *  only on the click that actually completes the entity -- never on an intermediate draft click
 *  (a caller-side impure counter, e.g. this repo's own nextId(prefix), must not burn an id on a
 *  click that never produces an entity). Pure otherwise -- no React, no solver, no document
 *  mutation; the caller commits the returned entity into its own document and drives a solve. */
export function stepDrawTool(tool: Sketch3dDrawToolKind, draftPoints: Sketch3dVec2[], point: Sketch3dVec2, nextId: () => string): Sketch3dDrawStep {
  const points = [...draftPoints, point]
  if (points.length < SKETCH3D_DRAW_POINTS_NEEDED[tool]) {
    return { draftPoints: points }
  }
  return { draftPoints: [], entity: buildDrawEntity(tool, nextId(), points) }
}
