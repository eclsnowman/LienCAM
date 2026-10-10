// WO-1846: fitting a cylinder or a cone to a region, and the conservative
// WHOLE-FACET acceptance test that decides whether the fit is allowed to be
// called true.
//
// Port of Next's meshCylinderInference / meshCylinderSupport / meshConeInference
// / meshConeSupport. The generate-then-prove shape is kept exactly: least
// squares produces a HYPOTHESIS, and then every facet of the region must lie
// inside the tolerance band of that surface across its whole area. Nothing is
// trimmed, no facet is dropped as an outlier, and a single facet outside the
// band refuses the whole region (Next's comment: "no failed facets are
// discarded or relabeled").

import type { Vec3 } from '../types';
import { cross, dot, length, normalize, sub } from './types';
import { facetNormal, facetPoints, vertexAt, type WeldedMesh } from './topology';

export interface CylinderSurface {
  origin: Vec3;
  /** unit axis */
  axis: Vec3;
  radiusMm: number;
  /** which way the facet normals face: into the axis (a bore) or away (a boss) */
  materialSide: 'inward' | 'outward';
}

export interface ConeSurface {
  origin: Vec3;
  axis: Vec3;
  /** station at which `radiusMm` is measured */
  referenceStationMm: number;
  radiusMm: number;
  /** d(radius)/d(station) */
  radialSlope: number;
  materialSide: 'inward' | 'outward';
}

export interface SurfaceInspection {
  fits: boolean;
  /** worst distance from any point of any facet to the fitted surface */
  maxDeviationMm: number;
  /** facets whose body left the tolerance band */
  outOfTolerance: number[];
  /** facets whose normal faces the wrong way, or cannot be decided */
  normalMismatch: number[];
  materialSide: 'inward' | 'outward' | undefined;
}

// ---- an orthonormal frame around an axis -----------------------------------

export function axisFrame(axis: Vec3): { u: Vec3; v: Vec3 } {
  const seed: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(axis, seed));
  const v = cross(axis, u);
  return { u, v };
}

/** Station along the axis and the radial offset vector, for one point. */
export function axialSplit(point: Vec3, origin: Vec3, axis: Vec3): { station: number; radial: Vec3 } {
  const d = sub(point, origin);
  const station = dot(d, axis);
  return { station, radial: [d[0] - station * axis[0], d[1] - station * axis[1], d[2] - station * axis[2]] };
}

// ---- whole-facet radial extent (Next's triangleRadialBounds, float64) ------

/**
 * The smallest and largest distance to the axis reached ANYWHERE on the facet,
 * not just at its three corners. The maximum of a convex function over a
 * triangle is at a vertex; the minimum is not, so it is computed as the true
 * distance from the axis to the projected triangle, interior included. Skipping
 * this is precisely the loosening the WO's negative control reproduces.
 */
export function facetRadialBounds(points: readonly Vec3[], origin: Vec3, axis: Vec3): { min: number; max: number } {
  const { u, v } = axisFrame(axis);
  const flat = points.map((p) => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)] as [number, number];
  });
  const max = Math.max(...flat.map((p) => Math.hypot(p[0], p[1])));

  const [a, b, c] = flat;
  const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (area2 !== 0) {
    const sides = flat.map((p, i) => {
      const q = flat[(i + 1) % 3];
      return Math.sign((q[0] - p[0]) * (0 - p[1]) - (q[1] - p[1]) * (0 - p[0]));
    });
    if (sides.every((s) => s >= 0) || sides.every((s) => s <= 0)) return { min: 0, max };
  }
  let min = Infinity;
  for (let i = 0; i < 3; i++) min = Math.min(min, originToSegment(flat[i], flat[(i + 1) % 3]));
  return { min, max };
}

/**
 * WO-1889: the corners of the 4^levels sub-triangles a facet subdivides into,
 * as sample points for a FIT. Level 0 is the facet's own three corners.
 *
 * Why this exists. On a coarse export every facet is a CHORD: its corners sit
 * on the true surface and its middle sits inside by the sagitta. A least
 * squares fit through corners alone therefore lands on the circumscribed
 * surface, and the whole-facet inspection then measures the full sagitta
 * against it - which is how a countersink an exporter wrote at 8 segments gets
 * refused at a tolerance it would otherwise pass. Sampling the facet's INTERIOR
 * puts the fitted surface where the material actually is (LienCAM-next's
 * meshConeSupport / MESH_SUBDIVIDED_CONES.md measures the same move, 0.0653 mm
 * raw -> 0.0495 mm), and the worst-case deviation falls with it.
 *
 * Nothing here touches ACCEPTANCE: the inspection that follows still runs over
 * the whole area of every original facet, and still refuses the region if one
 * of them leaves the band. Only the hypothesis gets better.
 */
export function subdividedSamples(points: readonly Vec3[], levels: number): Vec3[] {
  const m = 2 ** Math.max(0, Math.floor(levels));
  const [a, b, c] = points;
  const out: Vec3[] = [];
  for (let i = 0; i <= m; i++) {
    for (let j = 0; i + j <= m; j++) {
      const l1 = i / m;
      const l2 = j / m;
      out.push([
        a[0] + l1 * (b[0] - a[0]) + l2 * (c[0] - a[0]),
        a[1] + l1 * (b[1] - a[1]) + l2 * (c[1] - a[1]),
        a[2] + l1 * (b[2] - a[2]) + l2 * (c[2] - a[2]),
      ]);
    }
  }
  return out;
}

function originToSegment(p: [number, number], q: [number, number]): number {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0], p[1]);
  let t = -(p[0] * dx + p[1] * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] + t * dx, p[1] + t * dy);
}

/** Strict radial-normal side everywhere on a facet (Next's
 *  triangleRadialNormalSide): the same strict sign at all three vertices, or
 *  undefined. Undefined never invents a material side. */
export function facetRadialSide(
  points: readonly Vec3[],
  normal: Vec3,
  origin: Vec3,
  axis: Vec3,
): 'inward' | 'outward' | undefined {
  const signs = points.map((p) => Math.sign(dot(normal, axialSplit(p, origin, axis).radial)));
  if (signs.every((s) => s > 0)) return 'outward';
  if (signs.every((s) => s < 0)) return 'inward';
  return undefined;
}

// ---- cylinder inference ----------------------------------------------------

/** 3x3 symmetric eigenvectors by cyclic Jacobi. Returns columns sorted by
 *  ascending eigenvalue: [0] is the least-variance direction. */
function symmetricEigen(m: number[]): { values: number[]; vectors: Vec3[] } {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as Array<[number, number]>) off += a[p * 3 + q] * a[p * 3 + q];
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as Array<[number, number]>) {
      const apq = a[p * 3 + q];
      if (apq === 0) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p];
        const akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k];
        const aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
        const vkp = v[k * 3 + p];
        const vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((x, y) => a[x * 3 + x] - a[y * 3 + y]);
  return {
    values: order.map((i) => a[i * 3 + i]),
    vectors: order.map((i) => normalize([v[i], v[3 + i], v[6 + i]] as Vec3)),
  };
}

/** Canonical sign so the same wall always reports the same axis direction. */
function canonicalAxis(axis: Vec3): Vec3 {
  let biggest = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(axis[i]) > Math.abs(axis[biggest])) biggest = i;
  return axis[biggest] < 0 ? [-axis[0], -axis[1], -axis[2]] : axis;
}

export type CylinderRefusal =
  | 'insufficient-normal-spread'
  | 'ill-conditioned-circle'
  | 'candidate-outside-bounds'
  | 'surface-mismatch';

export type CylinderInference =
  | { status: 'candidate'; surface: CylinderSurface; inspection: SurfaceInspection }
  | { status: 'unrecognized'; reason: CylinderRefusal; inspection?: SurfaceInspection };

/**
 * One bounded hypothesis for one connected wall region. The axis is the
 * least-variance direction of the region's area-weighted facet normals (a
 * cylinder's normals all lie in the plane perpendicular to its axis); the
 * centre and radius come from a least-squares circle through the region's
 * vertices projected into that plane. Every facet must then pass inspection.
 *
 * WO-1889: if that hypothesis is refused ONLY because facets left the tolerance
 * band, the same region is re-fitted against progressively subdivided facet
 * samples (`subdivisionLevels` levels) and re-inspected. A coarse tessellation
 * is the one thing that makes a genuinely round bore miss by chord error alone,
 * and the fallback answers exactly that - it never relaxes the inspection, and
 * it never runs on a region whose normals face the wrong way, because
 * subdividing a facet cannot change its normal.
 */
export function inferCylinder(
  w: WeldedMesh,
  facets: readonly number[],
  toleranceMm: number,
  subdivisionLevels = 0,
): CylinderInference {
  const cov = new Array<number>(9).fill(0);
  for (const f of facets) {
    const n = facetNormal(w, f);
    const weight = w.areas[f];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] += weight * n[i] * n[j];
  }
  const totalArea = facets.reduce((a, f) => a + w.areas[f], 0);
  if (totalArea <= 0) return { status: 'unrecognized', reason: 'insufficient-normal-spread' };
  for (let i = 0; i < 9; i++) cov[i] /= totalArea;
  const eigen = symmetricEigen(cov);
  // A cylinder's normals sweep a great circle: the two in-plane eigenvalues
  // must both carry real variance. A plane (all normals equal) or a shallow
  // fillet fails here rather than being fitted a nonsense axis.
  if (eigen.values[1] < 0.02) return { status: 'unrecognized', reason: 'insufficient-normal-spread' };
  const axis = canonicalAxis(eigen.vectors[0]);

  const vertexIds = [...new Set(facets.flatMap((f) => [w.facets[f * 3], w.facets[f * 3 + 1], w.facets[f * 3 + 2]]))];
  const anchor: Vec3 = [w.positions[vertexIds[0] * 3], w.positions[vertexIds[0] * 3 + 1], w.positions[vertexIds[0] * 3 + 2]];
  const { u, v } = axisFrame(axis);
  const flatten = (p: Vec3): [number, number] => {
    const d = sub(p, anchor);
    return [dot(d, u), dot(d, v)];
  };

  let refusal: CylinderInference | undefined;
  for (let level = 0; level <= Math.max(0, subdivisionLevels); level++) {
    const samples = level === 0
      ? vertexIds.map((id) => vertexAt(w, id))
      : facets.flatMap((f) => subdividedSamples(facetPoints(w, f), level));
    const circle = fitCircle(samples.map(flatten));
    if (!circle) return refusal ?? { status: 'unrecognized', reason: 'ill-conditioned-circle' };
    const origin: Vec3 = [
      anchor[0] + circle.cx * u[0] + circle.cy * v[0],
      anchor[1] + circle.cx * u[1] + circle.cy * v[1],
      anchor[2] + circle.cx * u[2] + circle.cy * v[2],
    ];
    if (!(circle.r > 1e-6 && circle.r < 1e6) || origin.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e6)) {
      return refusal ?? { status: 'unrecognized', reason: 'candidate-outside-bounds' };
    }

    const proposal: CylinderSurface = { origin, axis, radiusMm: circle.r, materialSide: 'inward' };
    const inspection = inspectCylinder(w, facets, proposal, toleranceMm);
    if (inspection.fits && inspection.materialSide) {
      return {
        status: 'candidate',
        surface: { ...proposal, materialSide: inspection.materialSide },
        inspection,
      };
    }
    // The FIRST refusal is the one reported: it is the one measured against the
    // hypothesis the region's own vertices asked for.
    refusal ??= { status: 'unrecognized', reason: 'surface-mismatch', inspection };
    if (!inspection.materialSide || inspection.normalMismatch.length) return refusal;
  }
  return refusal as CylinderInference;
}

/** Kasa algebraic circle fit, then three geometric (Gauss-Newton) refinements
 *  so the reported radius is the fitted surface, not an area-biased one. */
function fitCircle(points: ReadonlyArray<[number, number]>): { cx: number; cy: number; r: number } | undefined {
  const n = points.length;
  if (n < 3) return undefined;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of points) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const a11 = 2 * (sxx - (sx * sx) / n);
  const a12 = 2 * (sxy - (sx * sy) / n);
  const a22 = 2 * (syy - (sy * sy) / n);
  const b1 = sxz - (sx * sz) / n;
  const b2 = syz - (sy * sz) / n;
  const det = a11 * a22 - a12 * a12;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return undefined;
  let cx = (b1 * a22 - b2 * a12) / det;
  let cy = (a11 * b2 - a12 * b1) / det;
  let r = Math.sqrt(Math.max(0, sz / n - 2 * (cx * sx + cy * sy) / n + cx * cx + cy * cy));

  // Landau/Spaeth fixed point for the GEOMETRIC circle fit: the algebraic fit
  // above is biased by how the samples are distributed round the arc, and the
  // radius is a number Operator reads off the panel.
  const meanX = sx / n;
  const meanY = sy / n;
  for (let iteration = 0; iteration < 8; iteration++) {
    const distances = points.map(([x, y]) => Math.hypot(x - cx, y - cy));
    const mr = distances.reduce((a, d) => a + d, 0) / n;
    let ux = 0;
    let uy = 0;
    for (let i = 0; i < n; i++) {
      const d = distances[i];
      if (d === 0) continue;
      ux += (points[i][0] - cx) / d / n;
      uy += (points[i][1] - cy) / d / n;
    }
    cx = meanX - mr * ux;
    cy = meanY - mr * uy;
    r = mr;
  }
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return undefined;
  return { cx, cy, r };
}

/** Every facet of the region against a proposed infinite cylinder, whole-facet. */
export function inspectCylinder(
  w: WeldedMesh,
  facets: readonly number[],
  surface: CylinderSurface,
  toleranceMm: number,
): SurfaceInspection {
  const outOfTolerance: number[] = [];
  const normalMismatch: number[] = [];
  const sides = new Set<'inward' | 'outward'>();
  let maxDeviationMm = 0;
  for (const f of facets) {
    const points = facetPoints(w, f);
    const bounds = facetRadialBounds(points, surface.origin, surface.axis);
    const deviation = Math.max(Math.abs(bounds.max - surface.radiusMm), Math.abs(surface.radiusMm - bounds.min));
    if (deviation > maxDeviationMm) maxDeviationMm = deviation;
    if (deviation > toleranceMm) outOfTolerance.push(f);
    const side = facetRadialSide(points, facetNormal(w, f), surface.origin, surface.axis);
    if (!side) normalMismatch.push(f);
    else sides.add(side);
  }
  const materialSide = sides.size === 1 ? [...sides][0] : undefined;
  return {
    fits: outOfTolerance.length === 0 && normalMismatch.length === 0 && materialSide !== undefined,
    maxDeviationMm,
    outOfTolerance,
    normalMismatch,
    materialSide,
  };
}

// ---- cone inference --------------------------------------------------------

export type ConeInference =
  | { status: 'candidate'; surface: ConeSurface; inspection: SurfaceInspection }
  | { status: 'unrecognized'; reason: 'insufficient-radius-change' | 'insufficient-axial-spread' | 'surface-mismatch' };

/**
 * A COAXIAL cone: the axis is supplied by the cylinder this chamfer belongs
 * to, never fitted freely (Next's inferMeshCoaxialCone). Least squares gives
 * the radial profile; every facet then has to pass whole-facet inspection.
 *
 * WO-1889: as for the cylinder, a fit refused only on tolerance is retried
 * against subdivided facet samples. A coarse countersink is where this pays:
 * its chords are widest at the big end, which is exactly where the corner-only
 * profile is furthest from the material.
 */
export function inferCoaxialCone(
  w: WeldedMesh,
  facets: readonly number[],
  origin: Vec3,
  axis: Vec3,
  materialSide: 'inward' | 'outward',
  toleranceMm: number,
  subdivisionLevels = 0,
): ConeInference {
  const vertexIds = [...new Set(facets.flatMap((f) => [w.facets[f * 3], w.facets[f * 3 + 1], w.facets[f * 3 + 2]]))];
  const profile = (points: readonly Vec3[]) =>
    points.map((p) => {
      const split = axialSplit(p, origin, axis);
      return { station: split.station, radius: length(split.radial) };
    });

  let refusal: ConeInference | undefined;
  for (let level = 0; level <= Math.max(0, subdivisionLevels); level++) {
    const samples = profile(
      level === 0
        ? vertexIds.map((id) => vertexAt(w, id))
        : facets.flatMap((f) => subdividedSamples(facetPoints(w, f), level)),
    );
    const n = samples.length;
    const meanStation = samples.reduce((a, s) => a + s.station, 0) / n;
    const meanRadius = samples.reduce((a, s) => a + s.radius, 0) / n;
    const variance = samples.reduce((a, s) => a + (s.station - meanStation) ** 2, 0);
    if (!(variance > 0)) return refusal ?? { status: 'unrecognized', reason: 'insufficient-axial-spread' };
    const covariance = samples.reduce((a, s) => a + (s.station - meanStation) * (s.radius - meanRadius), 0);
    const radialSlope = covariance / variance;
    const low = Math.min(...samples.map((s) => s.station));
    const high = Math.max(...samples.map((s) => s.station));
    if (Math.abs(radialSlope) * (high - low) <= 2 * toleranceMm) {
      return refusal ?? { status: 'unrecognized', reason: 'insufficient-radius-change' };
    }
    const surface: ConeSurface = {
      origin,
      axis,
      referenceStationMm: meanStation,
      radiusMm: meanRadius,
      radialSlope,
      materialSide,
    };
    const inspection = inspectCone(w, facets, surface, toleranceMm);
    if (inspection.fits) return { status: 'candidate', surface, inspection };
    refusal ??= { status: 'unrecognized', reason: 'surface-mismatch' };
    // As for the cylinder: a facet leaning the wrong way is not a fit
    // subdivision can rescue, because subdivision never moves a normal.
    if (inspection.normalMismatch.length) return refusal;
  }
  return refusal as ConeInference;
}

/** The signed perpendicular distance from a point to the cone surface. */
function coneResidual(point: Vec3, surface: ConeSurface): number {
  const split = axialSplit(point, surface.origin, surface.axis);
  const expected = surface.radiusMm + surface.radialSlope * (split.station - surface.referenceStationMm);
  return (length(split.radial) - expected) / Math.hypot(1, surface.radialSlope);
}

/**
 * Whole-facet cone inspection.
 *
 * The residual above is CONVEX over a facet (a norm minus an affine function),
 * so its maximum is at a vertex - but its minimum is in the interior, which is
 * exactly where a flat chord sits deepest inside the cone. Barycentric
 * coordinates map the facet affinely onto a convex domain, so the residual is
 * jointly convex there and a nested ternary search (the inner partial minimum
 * of a jointly convex function is itself convex) reaches the true minimum.
 * 40 iterations each side leave <1e-7 of the facet's own size.
 */
export function inspectCone(
  w: WeldedMesh,
  facets: readonly number[],
  surface: ConeSurface,
  toleranceMm: number,
): SurfaceInspection {
  const outOfTolerance: number[] = [];
  const normalMismatch: number[] = [];
  let maxDeviationMm = 0;
  for (const f of facets) {
    const points = facetPoints(w, f);
    const at = (l1: number, l2: number): Vec3 => [
      points[0][0] + l1 * (points[1][0] - points[0][0]) + l2 * (points[2][0] - points[0][0]),
      points[0][1] + l1 * (points[1][1] - points[0][1]) + l2 * (points[2][1] - points[0][1]),
      points[0][2] + l1 * (points[1][2] - points[0][2]) + l2 * (points[2][2] - points[0][2]),
    ];
    const upper = Math.max(...points.map((p) => coneResidual(p, surface)));
    const lower = minimiseOverTriangle((l1, l2) => coneResidual(at(l1, l2), surface));
    const deviation = Math.max(Math.abs(upper), Math.abs(lower));
    if (deviation > maxDeviationMm) maxDeviationMm = deviation;
    if (deviation > toleranceMm) outOfTolerance.push(f);
    // A cone's facet normal must lean the material side the parent cylinder
    // does; the radial component alone decides it, as for the cylinder.
    const side = facetRadialSide(points, facetNormal(w, f), surface.origin, surface.axis);
    if (side !== surface.materialSide) normalMismatch.push(f);
  }
  return {
    fits: outOfTolerance.length === 0 && normalMismatch.length === 0,
    maxDeviationMm,
    outOfTolerance,
    normalMismatch,
    materialSide: surface.materialSide,
  };
}

function minimiseOverTriangle(f: (l1: number, l2: number) => number): number {
  const inner = (l1: number): number => {
    let lo = 0;
    let hi = 1 - l1;
    for (let i = 0; i < 40; i++) {
      const a = lo + (hi - lo) / 3;
      const b = hi - (hi - lo) / 3;
      if (f(l1, a) <= f(l1, b)) hi = b;
      else lo = a;
    }
    return f(l1, (lo + hi) / 2);
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (inner(a) <= inner(b)) hi = b;
    else lo = a;
  }
  return inner((lo + hi) / 2);
}
