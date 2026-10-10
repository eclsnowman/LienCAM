// WO-1845 / ADR-0051 s1.4: the geometric witness that makes a facet-index
// selection safe to replay.
//
// Indices alone are a position. If the mesh under them is not the mesh they
// were taken on, replaying an index selects a DIFFERENT region and the
// operator is edited somewhere he never pointed. The witness is a cheap
// fingerprint of the selection - facet count, summed area, area-weighted
// centroid, summed normal - recomputed on every replay and compared. A
// mismatch stops replay (replay.ts); it never silently skips and never edits
// the other region.

import type { MeshBuffers, Vec3 } from '../types';
import { facetVertices } from './idView';
import type { MeshEditWitness } from './types';

/** Relative tolerance for the witness comparison. The mesh is float32 (a
 *  binary STL stores float32 and our parser keeps it that way, ADR-0051 s4.3),
 *  so an exact compare would fire on arithmetic that changed nothing. 1e-4
 *  relative is far below any real edit and far above float32 noise. */
export const WITNESS_RELATIVE_TOLERANCE = 1e-4;

export function computeWitness(mesh: MeshBuffers, facets: readonly number[]): MeshEditWitness {
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (const facet of facets) {
    const [a, b, c] = facetVertices(mesh, facet);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const crossX = uy * vz - uz * vy;
    const crossY = uz * vx - ux * vz;
    const crossZ = ux * vy - uy * vx;
    const facetArea = Math.hypot(crossX, crossY, crossZ) / 2;
    area += facetArea;
    nx += crossX / 2;
    ny += crossY / 2;
    nz += crossZ / 2;
    cx += facetArea * (a[0] + b[0] + c[0]) / 3;
    cy += facetArea * (a[1] + b[1] + c[1]) / 3;
    cz += facetArea * (a[2] + b[2] + c[2]) / 3;
  }
  const scale = area > 0 ? 1 / area : 0;
  return {
    facetCount: facets.length,
    area,
    centroid: [cx * scale, cy * scale, cz * scale],
    normalSum: [nx, ny, nz],
  };
}

/** Null when the witnesses agree; otherwise the operator-readable reason they
 *  do not, which becomes the console line and the replay stop reason. */
export function witnessMismatch(
  recorded: MeshEditWitness,
  actual: MeshEditWitness,
  tolerance = WITNESS_RELATIVE_TOLERANCE,
): string | null {
  if (recorded.facetCount !== actual.facetCount) {
    return `it selected ${recorded.facetCount} facet(s) and ${actual.facetCount} are there now`;
  }
  const areaScale = Math.max(Math.abs(recorded.area), Math.abs(actual.area), 1e-9);
  if (Math.abs(recorded.area - actual.area) > tolerance * areaScale) {
    return `the selected area is ${actual.area.toFixed(4)} mm2 where the edit was made on ${recorded.area.toFixed(4)} mm2`;
  }
  const span = Math.max(magnitude(recorded.centroid), magnitude(actual.centroid), 1);
  if (distance(recorded.centroid, actual.centroid) > tolerance * span) {
    return `the selected region sits at ${formatPoint(actual.centroid)} where the edit was made at ${formatPoint(recorded.centroid)}`;
  }
  const normalScale = Math.max(magnitude(recorded.normalSum), magnitude(actual.normalSum), 1e-9);
  if (distance(recorded.normalSum, actual.normalSum) > tolerance * normalScale) {
    return 'the selected facets no longer face the way they did when the edit was made';
  }
  return null;
}

function magnitude(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function formatPoint(v: Vec3): string {
  return `(${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)})`;
}
