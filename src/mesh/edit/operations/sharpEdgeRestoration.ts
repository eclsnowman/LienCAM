// WO-1848 / ADR-0051 s3: take a fillet or a chamfer off an edge and give the
// part its sharp edge back.
//
// Next's method, and there is no boolean anywhere in it: prove the two flat
// faces the blend runs between, compute the exact line their planes meet along,
// RETARGET the blend's boundary vertex rings onto that line, then drop the
// blend's own facets. The faces beside it stretch to the new edge because they
// already own those vertices - no coordinate is invented, nothing is welded by
// an epsilon, and the part stays closed because no rim is ever opened.
// WO-2083: when an outside chamfer shares a corner with another face, keep
// its boundary vertices and extend the surrounding planes to the sharp line
// instead. Retargeting that corner would drag the other face off its plane.
//
// This file ADDS an operation and registers it; it changes nothing in the
// framework (ADR-0051 s3).
//
// LAYERING, said out loud rather than done quietly (WO-1848 architect audit
// item 2): this imports `../../recognition/edgeBlends` directly instead of
// going through `../../recognition`'s door. That door is a stated contract for
// CONSUMERS asking "what does this part prove?"; an edit applying an explicit
// selection is not that, and it needs the structural preparation
// (`prepareEdgeBlend`) rather than the listed answer. It is the same sideways
// reach `boundaryCap.ts` already documents for `recognition/topology`, and it
// is not a cycle: edgeBlends.ts imports only recognition's own modules,
// mesh/types and `../edit/idView`.
//
// What the record carries and why: `facets` (the framework's) is the selection
// and the ONLY thing the geometry depends on, so replay never re-runs
// recognition. `blend` and `sizeMm` are labels for the panel line and the
// console, supplied by the app from recognition, never typed by the operator.

import type { MeshBuffers, Vec3 } from '../../types';
import {
  prepareEdgeBlend,
  type PreparedEdgeBlend,
  type SharpEdgeLine,
} from '../../recognition/edgeBlends';
import { facetNormal, facetPoints, normalsWithin, vertexAt, type WeldedMesh } from '../../recognition/topology';
import { facetCount, vertexCount } from '../idView';
import { registerMeshEditOperation } from '../registry';
import type {
  MeshEditAncestry,
  MeshEditApplyInput,
  MeshEditApplyResult,
  MeshEditOperation,
  MeshEditRecord,
} from '../types';
import { facetSoup } from './boundaryCap';

export const RESTORE_SHARP_EDGE_KIND = 'restore-sharp-edge';
export const RESTORE_SHARP_EDGE_VERSION = 1;

export interface RestoreSharpEdgeParameters {
  /** which kind of blend came off, for the panel line and the console */
  blend: 'fillet' | 'chamfer';
  /** its radius (fillet) or setback (chamfer) at the time, mm - reported only */
  sizeMm?: number;
}

const PARAMETER_KEYS = new Set(['blend', 'sizeMm']);

/** A facet this small is gone, not tiny: the end faces of a blend collapse
 *  onto its corner and the slivers left behind have exactly two identical
 *  corners. */
const DEGENERATE_AREA_MM2 = 1e-12;

/**
 * Give the edge under `facets` its sharp corner back.
 *
 * Throws a plain sentence naming what LienCAM could not work out; the caller
 * has changed nothing at that point, so replay stops at this edit and keeps
 * every earlier one (replay.ts).
 *
 * `retargetVertices: false` is the NEGATIVE CONTROL: it drops the blend's
 * facets and skips the retarget, which is the one step that puts the two faces
 * onto the theoretical edge line. Without it there is no edge line to land on
 * and the part is left open.
 */
export function restoreSharpEdge(
  mesh: MeshBuffers,
  facets: readonly number[],
  options: { retargetVertices?: boolean } = {},
): MeshEditApplyResult {
  const prepared = prepareEdgeBlend(mesh, facets);
  const removed = new Set(prepared.band);
  if (removed.size >= facetCount(mesh)) {
    throw new Error(
      'Removing this would take away every facet of the part, leaving nothing to cut. Nothing was changed.',
    );
  }
  if (options.retargetVertices === false) {
    return rebuildWithMovedVertices(mesh, prepared.welded, {
      removedFacets: removed,
      moved: new Map(),
      deleted: new Set(),
      planeToleranceMm: prepared.faceFlatnessMm,
    });
  }
  const moved = sharpEdgeTargets(prepared);
  // Keep the established retarget route wherever it preserves every face.
  // At a multi-face corner, extend instead of dragging its shared vertices.
  const w = prepared.welded;
  const wouldTiltFace = prepared.kind === 'chamfer' && prepared.shape === 'convex' &&
    Array.from({ length: w.facetCount }, (_, f) => f).some(f => {
      if (removed.has(f)) return false;
      const ids = [w.facets[f * 3], w.facets[f * 3 + 1], w.facets[f * 3 + 2]];
      return ids.some(id => moved.has(id)) && !keepsItsPlane(
        w, f, ids.map(id => moved.get(id) ?? vertexAt(w, id)), prepared.faceFlatnessMm,
      );
    });
  if (wouldTiltFace) {
    return extendChamferFaces(mesh, prepared, moved);
  }
  return rebuildWithMovedVertices(mesh, prepared.welded, {
    removedFacets: removed,
    moved,
    deleted: new Set(prepared.interior),
    onEdge: new Set(moved.keys()),
    edgeLine: prepared.edgeLine,
    planeToleranceMm: prepared.faceFlatnessMm,
  });
}

/** A chamfer endpoint can also belong to another corner face (Platte C).
 * Retargeting it would tilt that face. Instead, keep the boundary in place
 * and fill from each boundary edge to the sharp line, on its neighbor's plane.
 * This adds material at an outside chamfer; concave blends still use retargeting
 * because their removal must trim material from the supporting faces. */
function extendChamferFaces(
  source: MeshBuffers,
  prepared: PreparedEdgeBlend,
  targets: ReadonlyMap<number, Vec3>,
): MeshEditApplyResult {
  const w = prepared.welded;
  const removed = new Set(prepared.band);
  const triangles: Array<[Vec3, Vec3, Vec3]> = [];
  const provenance: Array<[number, number, number]> = [];
  const owner: number[] = [];
  // Negative ids denote new sharp-line vertices, distinct from the retained
  // boundary vertices. They have no source-vertex ancestry.
  const sharpTargets = new Map([...targets].map(([id, point]) => [-id - 1, point]));
  const onEdge = new Set(sharpTargets.keys());
  for (let f = 0; f < w.facetCount; f++) {
    if (removed.has(f)) continue;
    triangles.push(facetPoints(w, f));
    provenance.push([w.facets[f * 3], w.facets[f * 3 + 1], w.facets[f * 3 + 2]]);
    owner.push(f);
  }
  for (const f of prepared.band) {
    for (let k = 0; k < 3; k++) {
      const edge = w.edges[w.facetEdges[f * 3 + k]];
      const outside = edge.facets.find(neighbor => !removed.has(neighbor));
      if (outside === undefined) continue;
      const a = w.facets[f * 3 + k];
      const b = w.facets[f * 3 + (k + 1) % 3];
      const pa = vertexAt(w, a), pb = vertexAt(w, b);
      const ta = targets.get(a)!, tb = targets.get(b)!;
      const patches: Array<{ corners: [Vec3, Vec3, Vec3]; ids: [number, number, number] }> = [
        { corners: [pa, pb, tb], ids: [a, b, -b - 1] },
        { corners: [pa, tb, ta], ids: [a, -b - 1, -a - 1] },
      ];
      for (const patch of patches) {
        if (triangleArea(patch.corners) <= DEGENERATE_AREA_MM2) continue;
        if (!keepsItsPlane(w, outside, patch.corners, prepared.faceFlatnessMm)) {
          throw new Error(
            'Doing this would tilt or move a flat face beside the blend, which would change a part of ' +
              'the shape the operator did not ask about. Nothing was changed.',
          );
        }
        for (const piece of splitAlongEdge(patch.corners, patch.ids, onEdge, sharpTargets, prepared.edgeLine)) {
          if (triangleArea(piece.corners) <= DEGENERATE_AREA_MM2) continue;
          triangles.push(piece.corners);
          provenance.push(piece.ids);
          owner.push(outside);
        }
      }
    }
  }
  return { mesh: facetSoup(triangles), ancestry: ancestryOf(source, w, owner, provenance) };
}

/**
 * The sentence this removal would refuse with, or null when it would go
 * through. The panel asks BEFORE it records, so a refusal never lands in the
 * journal as an edit that cannot replay.
 */
export function sharpEdgeRestorationRefusal(
  mesh: MeshBuffers,
  facets: readonly number[],
): string | null {
  try {
    restoreSharpEdge(mesh, facets);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Where every vertex of the blend goes.
 *
 * A vertex on one of the two END faces is pulled to that end's corner - the
 * single point where both faces and that end face meet. Every other vertex on
 * a rail is pulled straight onto the sharp edge at its own station along it.
 * (Next interpolates the rail linearly between the two corners to keep its
 * bigint arithmetic exact; projecting each vertex at its own station is the
 * same answer when the ends run across the edge squarely and the more faithful
 * one when they do not, so that is what this does.)
 * Everything else is interior to the blend and goes away with it.
 */
function sharpEdgeTargets(prepared: PreparedEdgeBlend): Map<number, Vec3> {
  const { origin, direction, ends } = prepared.edgeLine;
  const w = prepared.welded;
  const moved = new Map<number, Vec3>();
  prepared.endRing.forEach((ring, index) => {
    for (const id of ring) moved.set(id, ends[index]);
  });
  for (const rail of prepared.rail) {
    for (const id of rail) {
      if (moved.has(id)) continue;
      const p = vertexAt(w, id);
      const station =
        (p[0] - origin[0]) * direction[0] + (p[1] - origin[1]) * direction[1] + (p[2] - origin[2]) * direction[2];
      moved.set(id, [
        origin[0] + station * direction[0],
        origin[1] + station * direction[1],
        origin[2] + station * direction[2],
      ]);
    }
  }
  return moved;
}

// ------------------------------------------------------- the shared rebuild

export interface VertexMoveOptions {
  /** facets that go away entirely */
  removedFacets: ReadonlySet<number>;
  /** welded vertex id -> where it lands */
  moved: ReadonlyMap<number, Vec3>;
  /** welded vertex ids that go away with the removed facets. A surviving facet
   *  that still uses one of these is a refusal, not a repair. */
  deleted: ReadonlySet<number>;
  /** welded vertex ids whose new positions lie on one straight line - the
   *  restored sharp edge. Given with `edgeLine`, the rebuild splits any
   *  surviving facet edge that would run past one of them (a T-junction). */
  onEdge?: ReadonlySet<number>;
  edgeLine?: SharpEdgeLine;
  /** facets that are MEANT to change shape - the blend's own, when the edit
   *  reshapes it instead of removing it. Every other facet has to stay on its
   *  own plane, and that is what makes "nothing else moved" a proof. */
  reshapedFacets?: ReadonlySet<number>;
  /** how far a surviving facet may move off its own plane, mm */
  planeToleranceMm: number;
}

/**
 * Rebuild the mesh with some facets gone and some vertices somewhere else.
 *
 * Shared by both of this order's edits, because both are the same operation
 * underneath: move the blend's vertices, then keep what is left. It REFUSES,
 * by name, when a facet that is meant to survive would be dragged off its own
 * plane - that is the check that makes "the faces beside the blend are
 * unchanged" a proof rather than a hope.
 */
export function rebuildWithMovedVertices(
  source: MeshBuffers,
  w: WeldedMesh,
  options: VertexMoveOptions,
): MeshEditApplyResult {
  const total = facetCount(source);
  const triangles: Array<[Vec3, Vec3, Vec3]> = [];
  const provenance: Array<[number, number, number]> = [];
  const owner: number[] = [];

  for (let f = 0; f < total; f++) {
    if (options.removedFacets.has(f)) continue;
    const ids: [number, number, number] = [w.facets[f * 3], w.facets[f * 3 + 1], w.facets[f * 3 + 2]];
    if (ids.some((id) => options.deleted.has(id))) {
      throw new Error(
        'Taking this blend off would leave the facet beside it with a corner that is no longer ' +
          'there, so LienCAM cannot rebuild that part of the surface. Nothing was changed.',
      );
    }
    const corners = ids.map((id) => options.moved.get(id) ?? vertexAt(w, id)) as [Vec3, Vec3, Vec3];
    const changed = !options.reshapedFacets?.has(f) && ids.some((id) => options.moved.has(id));
    if (changed && !keepsItsPlane(w, f, corners, options.planeToleranceMm)) {
      throw new Error(
        'Doing this would tilt or move a flat face beside the blend, which would change a part of ' +
          'the shape the operator did not ask about. Nothing was changed.',
      );
    }
    if (triangleArea(corners) <= DEGENERATE_AREA_MM2) continue;
    const pieces =
      options.onEdge && options.edgeLine
        ? splitAlongEdge(corners, ids, options.onEdge, options.moved, options.edgeLine)
        : [{ corners, ids }];
    for (const piece of pieces) {
      if (triangleArea(piece.corners) <= DEGENERATE_AREA_MM2) continue;
      triangles.push(piece.corners);
      provenance.push(piece.ids);
      owner.push(f);
    }
  }

  return { mesh: facetSoup(triangles), ancestry: ancestryOf(source, w, owner, provenance) };
}

function triangleArea(corners: readonly Vec3[]): number {
  const [a, b, c] = corners;
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
}

/** A surviving facet may stretch along its own plane; it may not leave it. */
function keepsItsPlane(w: WeldedMesh, facet: number, corners: readonly Vec3[], toleranceMm: number): boolean {
  const normal = facetNormal(w, facet);
  const anchor = facetPoints(w, facet)[0];
  const offset = normal[0] * anchor[0] + normal[1] * anchor[1] + normal[2] * anchor[2];
  for (const p of corners) {
    if (Math.abs(normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] - offset) > toleranceMm) return false;
  }
  const [a, b, c] = corners;
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const raw: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(raw[0], raw[1], raw[2]);
  if (l === 0) return true; // collapsed; it is dropped, not kept off-plane
  return normalsWithin(normal, [raw[0] / l, raw[1] / l, raw[2] / l], 1e-3);
}

/**
 * Close the T-junctions the retarget can leave.
 *
 * Both rails land on the same line. When one rail is divided more finely than
 * the other, a facet from the coarse side now runs straight past a corner the
 * fine side put on that line, and the two surfaces would touch without sharing
 * an edge. Splitting the coarse facet at those corners is the whole repair: no
 * vertex moves and none is invented - every split point is already a corner of
 * the part.
 */
function splitAlongEdge(
  corners: [Vec3, Vec3, Vec3],
  ids: [number, number, number],
  onEdge: ReadonlySet<number>,
  moved: ReadonlyMap<number, Vec3>,
  line: SharpEdgeLine,
): Array<{ corners: [Vec3, Vec3, Vec3]; ids: [number, number, number] }> {
  const whole = [{ corners, ids }];
  const stations = new Map<number, number>();
  for (const id of onEdge) {
    const p = moved.get(id);
    if (p) stations.set(id, stationOf(p, line));
  }
  for (let k = 0; k < 3; k++) {
    const a = ids[k];
    const b = ids[(k + 1) % 3];
    if (!onEdge.has(a) || !onEdge.has(b)) continue;
    const sa = stations.get(a) as number;
    const sb = stations.get(b) as number;
    if (!(Math.abs(sb - sa) > 0)) continue;
    const low = Math.min(sa, sb);
    const high = Math.max(sa, sb);
    const between = [...new Set([...stations.values()].filter((s) => s > low + 1e-9 && s < high - 1e-9))]
      .sort((x, y) => x - y);
    if (between.length === 0) continue;
    if (sa > sb) between.reverse();
    const far = corners[(k + 2) % 3];
    const farId = ids[(k + 2) % 3];
    const chain: Vec3[] = [corners[k], ...between.map((s) => pointAt(s, line)), corners[(k + 1) % 3]];
    const out: Array<{ corners: [Vec3, Vec3, Vec3]; ids: [number, number, number] }> = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      out.push({
        corners: [chain[i], chain[i + 1], far],
        ids: [i === 0 ? a : -1, i + 2 === chain.length ? b : -1, farId],
      });
    }
    return out;
  }
  return whole;
}

const stationOf = (p: Vec3, line: SharpEdgeLine): number =>
  (p[0] - line.origin[0]) * line.direction[0] +
  (p[1] - line.origin[1]) * line.direction[1] +
  (p[2] - line.origin[2]) * line.direction[2];

const pointAt = (station: number, line: SharpEdgeLine): Vec3 => [
  line.origin[0] + station * line.direction[0],
  line.origin[1] + station * line.direction[1],
  line.origin[2] + station * line.direction[2],
];

/**
 * Who became what (ADR-0051 s4.4 / WO-1845's `MeshEditAncestry`). A surviving
 * facet maps to the output facet(s) it produced - more than one when a
 * T-junction split it. A facet that went with the blend maps to nothing, and a
 * corner that is a fresh split point is claimed by no input vertex, which is
 * how `composeSourceFacetIds` would mark it added by this edit.
 */
function ancestryOf(
  source: MeshBuffers,
  w: WeldedMesh,
  owner: readonly number[],
  provenance: ReadonlyArray<[number, number, number]>,
): MeshEditAncestry {
  const triangles: number[][] = Array.from({ length: facetCount(source) }, () => []);
  const vertices: number[][] = Array.from({ length: vertexCount(source) }, () => []);
  const unwelded = new Map<number, number>();
  for (let f = 0; f < facetCount(source); f++) {
    for (let c = 0; c < 3; c++) {
      const welded = w.facets[f * 3 + c];
      if (!unwelded.has(welded)) unwelded.set(welded, source.indices[f * 3 + c]);
    }
  }
  for (let out = 0; out < owner.length; out++) {
    triangles[owner[out]].push(out);
    for (let c = 0; c < 3; c++) {
      const welded = provenance[out][c];
      if (welded < 0) continue;
      const vertex = unwelded.get(welded);
      if (vertex !== undefined) vertices[vertex].push(out * 3 + c);
    }
  }
  return { triangles, vertices };
}

// --------------------------------------------------------------- the operation

export const restoreSharpEdgeOperation: MeshEditOperation<RestoreSharpEdgeParameters> = {
  kind: RESTORE_SHARP_EDGE_KIND,
  version: RESTORE_SHARP_EDGE_VERSION,
  label: 'Remove edge blend',

  describe(record: MeshEditRecord): string {
    const parameters = (record.parameters ?? {}) as Partial<RestoreSharpEdgeParameters>;
    if (parameters.blend !== 'fillet' && parameters.blend !== 'chamfer') {
      return `Made ${record.facets.length} facet(s) into a sharp edge`;
    }
    const size =
      typeof parameters.sizeMm === 'number' && Number.isFinite(parameters.sizeMm)
        ? `${parameters.sizeMm.toFixed(2)} mm `
        : '';
    return `Removed the ${size}${parameters.blend}; the edge is sharp again`;
  },

  validate(parameters: Record<string, unknown>): RestoreSharpEdgeParameters {
    const given = parameters ?? {};
    const extra = Object.keys(given).filter((key) => !PARAMETER_KEYS.has(key));
    if (extra.length > 0) {
      throw new Error(`"${RESTORE_SHARP_EDGE_KIND}" does not take ${extra.join(', ')}.`);
    }
    const blend = given.blend;
    if (blend !== 'fillet' && blend !== 'chamfer') {
      throw new Error(
        `"${RESTORE_SHARP_EDGE_KIND}" needs to know whether it took off a fillet or a chamfer; ` +
          `"${String(blend)}" is neither.`,
      );
    }
    const sizeMm = given.sizeMm;
    if (sizeMm !== undefined) {
      if (typeof sizeMm !== 'number' || !Number.isFinite(sizeMm) || sizeMm <= 0) {
        throw new Error(
          `"${RESTORE_SHARP_EDGE_KIND}" was given a size of "${String(sizeMm)}", which is not a measurement.`,
        );
      }
      return { blend, sizeMm };
    }
    return { blend };
  },

  apply({ mesh, facets }: MeshEditApplyInput<RestoreSharpEdgeParameters>): MeshEditApplyResult {
    return restoreSharpEdge(mesh, facets);
  },
};

registerMeshEditOperation(restoreSharpEdgeOperation);
