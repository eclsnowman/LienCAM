// WO-1848 / ADR-0051 s3: change the radius of a fillet already on the part.
//
// Next's `resizeMeshCylindricalBlend`, on MeshBuffers. The whole edit is one
// scale about the theoretical sharp edge: a cylinder of radius r inscribed in
// the wedge between two planes has its axis at r/sin(half-angle) from the edge
// line and touches each face at r/tan(half-angle) along it, so scaling the
// band about that LINE by rNew/rOld lands every vertex exactly on the rNew
// blend and keeps both tangent lines inside their own faces. No boolean, no
// kernel, no re-tessellation: the same facets, moved.
//
// This file ADDS an operation and registers it; it changes nothing in the
// framework (ADR-0051 s3). The layering note in ./sharpEdgeRestoration.ts
// about importing `../../recognition/edgeBlends` directly applies here too.

import type { MeshBuffers, Vec3 } from '../../types';
import { prepareEdgeBlend, type PreparedEdgeBlend } from '../../recognition/edgeBlends';
import { vertexAt, weldMesh } from '../../recognition/topology';
import { cross, dot, normalize, sub } from '../../recognition/types';
import { inspectCylinder } from '../../recognition/surfaces';
import { facetCount } from '../idView';
import { registerMeshEditOperation } from '../registry';
import type {
  MeshEditApplyInput,
  MeshEditApplyResult,
  MeshEditOperation,
  MeshEditRecord,
} from '../types';
import { rebuildWithMovedVertices } from './sharpEdgeRestoration';
import { resizeWallBlend, wallBlendOf } from './wallBlendEdits';

export const CHANGE_BLEND_RADIUS_KIND = 'change-blend-radius';
export const CHANGE_BLEND_RADIUS_VERSION = 1;

export interface ChangeBlendRadiusParameters {
  /** the radius the fillet is to have, mm */
  radiusMm: number;
  /** what it was, mm - reported in the panel line, never used to cut */
  fromRadiusMm?: number;
}

const PARAMETER_KEYS = new Set(['radiusMm', 'fromRadiusMm']);

/** How much of the band's own chord error the resized band is allowed to
 *  carry against its new cylinder, on top of the tessellation it already had. */
const RESIZE_TOLERANCE_MARGIN = 1.5;

/**
 * Make the fillet under `facets` `radiusMm` instead of what it is.
 *
 * Throws a plain sentence naming what LienCAM could not do. Nothing is changed
 * when it does.
 */
export function changeBlendRadius(
  mesh: MeshBuffers,
  facets: readonly number[],
  radiusMm: number,
): MeshEditApplyResult {
  if (!Number.isFinite(radiusMm) || radiusMm <= 0) {
    throw new Error(`"${String(radiusMm)}" is not a radius LienCAM can put on an edge. Nothing was changed.`);
  }
  let prepared: PreparedEdgeBlend;
  try {
    prepared = prepareEdgeBlend(mesh, facets);
  } catch (err) {
    // WO-2798: a fillet round a wall standing square to its face - a boss
    // foot, a chain round a top, a pocket's floor fillets.
    const wall = wallBlendOf(mesh, facets);
    if (wall === null) throw err;
    return resizeWallBlend(mesh, wall, radiusMm);
  }
  if (prepared.kind !== 'fillet' || prepared.radiusMm === undefined) {
    throw new Error(
      'This is a flat chamfer, not a round, so it has no radius to change. Nothing was changed.',
    );
  }
  const fromRadiusMm = prepared.radiusMm;
  const scale = radiusMm / fromRadiusMm;
  if (Math.abs(radiusMm - fromRadiusMm) <= 1e-9) {
    throw new Error(
      `This fillet is already ${fromRadiusMm.toFixed(3)} mm, so there is nothing to change. Nothing was changed.`,
    );
  }

  const w = prepared.welded;
  const { origin, direction } = prepared.edgeLine;
  const bandVertices = new Set<number>();
  for (const f of prepared.band) for (let c = 0; c < 3; c++) bandVertices.add(w.facets[f * 3 + c]);

  // Room check: the new tangent line has to stay ON the face it sits on. This
  // is a thing LienCAM genuinely cannot do, not a preference - a fillet run
  // past the far edge of its own face folds the surface through itself.
  prepared.supports.forEach((face, index) => {
    const across = normalize(cross(face.normal, direction));
    const wanted = prepared.setbackMm[index] * scale;
    let room = Infinity;
    for (const f of face.facets) {
      for (let c = 0; c < 3; c++) {
        const id = w.facets[f * 3 + c];
        if (bandVertices.has(id)) continue;
        room = Math.min(room, Math.abs(dot(sub(vertexAt(w, id), origin), across)));
      }
    }
    if (Number.isFinite(room) && wanted > room + 1e-6) {
      throw new Error(
        `A ${radiusMm.toFixed(2)} mm fillet would reach ${wanted.toFixed(2)} mm along the face beside ` +
          `it, and that face is only ${room.toFixed(2)} mm wide there. Nothing was changed.`,
      );
    }
  });

  const moved = new Map<number, Vec3>();
  for (const id of bandVertices) moved.set(id, scaleAboutLine(vertexAt(w, id), origin, direction, scale));

  const result = rebuildWithMovedVertices(mesh, w, {
    removedFacets: new Set<number>(),
    moved,
    deleted: new Set<number>(),
    reshapedFacets: new Set(prepared.band),
    planeToleranceMm: prepared.faceFlatnessMm,
  });

  proveResizedBand(result.mesh, prepared, radiusMm, scale);
  return result;
}

/**
 * The band, as it now stands in the OUTPUT mesh, has to lie on a cylinder of
 * the requested radius tangent to both faces. This is re-measured from the
 * rebuilt mesh rather than trusted from the transform, which is the difference
 * between a proof and an intention.
 */
function proveResizedBand(
  mesh: MeshBuffers,
  prepared: PreparedEdgeBlend,
  radiusMm: number,
  scale: number,
): void {
  // The band is named by facet index, so the check below only means anything
  // while the rebuild keeps every facet where it was. It does; this guards a
  // later change to it that starts dropping one.
  if (facetCount(mesh) !== prepared.welded.facetCount) {
    throw new Error(
      'Changing this radius did not leave the part with the facets it started with. Nothing was changed.',
    );
  }
  const after = weldMesh(mesh);
  const surface = {
    ...(prepared.cylinder as NonNullable<PreparedEdgeBlend['cylinder']>),
    origin: scaleAboutLine(
      (prepared.cylinder as NonNullable<PreparedEdgeBlend['cylinder']>).origin,
      prepared.edgeLine.origin,
      prepared.edgeLine.direction,
      scale,
    ),
    radiusMm,
  };
  const tolerance = Math.max(prepared.maxDeviationMm * Math.max(1, scale) * RESIZE_TOLERANCE_MARGIN, 1e-4);
  const inspection = inspectCylinder(after, prepared.band, surface, tolerance);
  if (!inspection.fits) {
    throw new Error(
      `The facets of this fillet do not sit on a ${radiusMm.toFixed(2)} mm round after the change - ` +
        `the worst of them is ${inspection.maxDeviationMm.toFixed(4)} mm off it. Nothing was changed.`,
    );
  }
  for (const face of prepared.supports) {
    const distance = Math.abs(dot(face.normal, surface.origin) - face.offsetMm);
    if (Math.abs(distance - radiusMm) > tolerance) {
      throw new Error(
        `A ${radiusMm.toFixed(2)} mm round here would not touch the face beside it - it would miss ` +
          `it by ${Math.abs(distance - radiusMm).toFixed(4)} mm. Nothing was changed.`,
      );
    }
  }
}

/** Move `p` towards or away from the line by `factor`, along the line's own
 *  perpendicular. A point ON the line does not move. */
function scaleAboutLine(p: Vec3, origin: Vec3, direction: Vec3, factor: number): Vec3 {
  const d = sub(p, origin);
  const station = dot(d, direction);
  const foot: Vec3 = [
    origin[0] + station * direction[0],
    origin[1] + station * direction[1],
    origin[2] + station * direction[2],
  ];
  return [
    foot[0] + (p[0] - foot[0]) * factor,
    foot[1] + (p[1] - foot[1]) * factor,
    foot[2] + (p[2] - foot[2]) * factor,
  ];
}

/**
 * The sentence this radius change would refuse with, or null when it would go
 * through. The panel asks BEFORE it records.
 */
export function blendRadiusChangeRefusal(
  mesh: MeshBuffers,
  facets: readonly number[],
  radiusMm: number,
): string | null {
  try {
    changeBlendRadius(mesh, facets, radiusMm);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export const changeBlendRadiusOperation: MeshEditOperation<ChangeBlendRadiusParameters> = {
  kind: CHANGE_BLEND_RADIUS_KIND,
  version: CHANGE_BLEND_RADIUS_VERSION,
  label: 'Change fillet radius',

  describe(record: MeshEditRecord): string {
    const parameters = (record.parameters ?? {}) as Partial<ChangeBlendRadiusParameters>;
    const to = typeof parameters.radiusMm === 'number' ? parameters.radiusMm.toFixed(2) : '?';
    return typeof parameters.fromRadiusMm === 'number'
      ? `Changed the fillet from ${parameters.fromRadiusMm.toFixed(2)} mm to ${to} mm radius`
      : `Set the fillet radius to ${to} mm`;
  },

  validate(parameters: Record<string, unknown>): ChangeBlendRadiusParameters {
    const given = parameters ?? {};
    const extra = Object.keys(given).filter((key) => !PARAMETER_KEYS.has(key));
    if (extra.length > 0) {
      throw new Error(`"${CHANGE_BLEND_RADIUS_KIND}" does not take ${extra.join(', ')}.`);
    }
    const radiusMm = given.radiusMm;
    if (typeof radiusMm !== 'number' || !Number.isFinite(radiusMm) || radiusMm <= 0) {
      throw new Error(
        `"${CHANGE_BLEND_RADIUS_KIND}" was given a radius of "${String(radiusMm)}", which is not a measurement.`,
      );
    }
    const fromRadiusMm = given.fromRadiusMm;
    if (fromRadiusMm !== undefined) {
      if (typeof fromRadiusMm !== 'number' || !Number.isFinite(fromRadiusMm) || fromRadiusMm <= 0) {
        throw new Error(
          `"${CHANGE_BLEND_RADIUS_KIND}" was given a previous radius of "${String(fromRadiusMm)}", ` +
            'which is not a measurement.',
        );
      }
      return { radiusMm, fromRadiusMm };
    }
    return { radiusMm };
  },

  apply({
    mesh,
    facets,
    parameters,
  }: MeshEditApplyInput<ChangeBlendRadiusParameters>): MeshEditApplyResult {
    return changeBlendRadius(mesh, facets, parameters.radiusMm);
  },
};

registerMeshEditOperation(changeBlendRadiusOperation);
