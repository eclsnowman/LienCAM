// Legacy reattach only: converts an old auto-projected face boundary into CAM `Sketch` geometry.
// Fresh face entry is blank, and explicit Project / Use does not call this compatibility converter.
//
// WHY THIS FILE EXISTS AT ALL.
//
// Legacy saved face sketches may carry the old deterministic `.extN` projection and nonempty
// `externalRefs`. During explicit datum reattach, `projectFaceBoundaryToSketch` rebuilds that legacy
// boundary in the sketch3d model (`Sketch3dLineEntity` + `Sketch3dFixedConstraint`) and this converter
// maps it ONE WAY into the CAM `Sketch` model. Fresh face sketches are blank; explicit Project / Use
// copies use the shared UUID-backed project path and do not pass through this compatibility seam.
//
// THE MAPPING IS TOTAL, NOT PARTIAL. `projectFaceBoundaryToSketch` emits `Sketch3dLineEntity[]` and
// `Sketch3dFixedConstraint[]` and nothing else (planeSketch.ts:44-55 -- it walks a world loop and
// pushes one line per segment). Both have exact CAM counterparts:
//
//     Sketch3dLineEntity {id, kind:'line', start, end}  ->  SketchLineEntity {id, construction, ...}
//     Sketch3dFixedConstraint {id, kind:'fixed', entityId} -> FixConstraint {id, kind:'fix', entityId}
//
// so this converter can be TOTAL over its real input. It is nonetheless written to REFUSE BY NAME
// rather than to silently drop anything it does not recognise: if a future projector learns to emit
// an arc, dropping it here would silently shrink the reference boundary and the extruded body would
// come out the wrong shape with nothing red anywhere. `seedRefusal` is that name.
//
// NOT CONSTRUCTION, AND WHY -- the one decision in this file worth arguing about.
//
// `construction: true` was the obvious choice and it is WRONG here. `extractSketchProfile` filters
// construction geometry out of the profile, and SKC-5's shipped behaviour -- asserted by
// src/tests/model3d/SolidsWorkbenchPage.sketchOnFace.test.tsx, which extrudes a face sketch 5mm and
// measures a 4000mm^3 body -- is that sketching on a face and immediately extruding gives you a
// prism of THAT FACE. Marking the boundary construction turns that into a `no-geometry` refusal.
// It also uses the shared profile rule, where projected ("Use") geometry is real profile geometry, not
// construction. The sketch3d model this replaces made the same call: plain `Sketch3dLineEntity`s
// carrying a `fixed` constraint, never a construction flag.
//
// FIXED, AND WHY. `kind: 'fix'` on the whole entity grounds every coordinate it owns. The document
// port's `dragBegin` refuses a grounded entity BY NAME, so the projected boundary cannot be dragged
// off the face it was projected from -- byte-for-byte the guarantee `Sketch3dFixedConstraint` gave.
// Reference geometry that cannot move, and that still bounds a profile: that is the whole contract.

import type { SketchConstraint, SketchEntity } from '../../../lib/sketch/sketcher'
import type { Sketch3dConstraint, Sketch3dEntity } from '../../../sketch3d'

/** A named refusal, so a projector that grows a shape this converter cannot carry fails LOUD. */
export interface FaceSketchSeedRefusal {
  code: 'unsupported-projected-entity' | 'unsupported-projected-constraint' | 'non-finite-coordinate'
  message: string
  /** The offending id, so the console message names the thing rather than the category. */
  id: string
}

export interface FaceSketchSeed {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
}

export type FaceSketchSeedResult =
  | { ok: true; seed: FaceSketchSeed }
  | { ok: false; refusal: FaceSketchSeedRefusal }

function finite(...values: number[]): boolean {
  return values.every((v) => Number.isFinite(v))
}

/**
 * Convert a `projectFaceBoundaryToSketch` result into CAM sketch geometry.
 *
 * Charter item 3 (validate DATA at every accept point): every coordinate is checked finite HERE,
 * at the boundary between the two models. A NaN that slipped through would compare false against
 * every `> tol` guard downstream in BOTH directions and would reach the kernel as a silent
 * degenerate loop.
 */
export function projectedBoundaryToCamSeed(
  entities: readonly Sketch3dEntity[],
  constraints: readonly Sketch3dConstraint[],
): FaceSketchSeedResult {
  const outEntities: SketchEntity[] = []
  for (const e of entities) {
    if (e.kind !== 'line') {
      return {
        ok: false,
        refusal: {
          code: 'unsupported-projected-entity',
          id: e.id,
          message: `The projected face boundary contains a '${e.kind}' entity, which the face-sketch seed cannot carry.`,
        },
      }
    }
    if (!finite(e.start.x, e.start.y, e.end.x, e.end.y)) {
      return {
        ok: false,
        refusal: {
          code: 'non-finite-coordinate',
          id: e.id,
          message: `The projected face boundary segment '${e.id}' has a non-finite coordinate.`,
        },
      }
    }
    outEntities.push({
      id: e.id,
      kind: 'line',
      // NOT construction: a restored legacy boundary remains usable as profile geometry.
      construction: false,
      start: { x: e.start.x, y: e.start.y },
      end: { x: e.end.x, y: e.end.y },
    })
  }

  const outConstraints: SketchConstraint[] = []
  for (const c of constraints) {
    if (c.kind !== 'fixed' || c.entityId === undefined) {
      return {
        ok: false,
        refusal: {
          code: 'unsupported-projected-constraint',
          id: c.id,
          message: `The projected face boundary carries a '${c.kind}' constraint, which the face-sketch seed cannot carry.`,
        },
      }
    }
    outConstraints.push({ id: c.id, kind: 'fix', entityId: c.entityId })
  }

  return { ok: true, seed: { entities: outEntities, constraints: outConstraints } }
}
