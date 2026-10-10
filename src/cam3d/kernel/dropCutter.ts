// cam3d L2: exact drop-cutter contact math for flat and ball cutters.
//
// WHY exact contact: the Phase 0 spike (docs/3d/OCL-CAPABILITIES.md section 3)
// proved raster-max drop is structurally WRONG for flat cutters -- 0.44mm
// gouge-side error at h=0.25mm that does NOT converge, because footprint-rim
// samples enter/leave the disk and count at full height. So the production
// kernel computes the drop the way OCL does: per candidate triangle, run
// vertex / facet / edge contact tests in f64 and take the max tip z.
//
// This module is deliberately pure math with NO three-mesh-bvh import, so
// every formula is directly unit-testable against analytic ground truth and
// brute-force raster references. The BVH layer (bvhKernel.ts) only CULLS
// candidate triangles and calls into here.
//
// Conventions: units mm, Z-up. Cutter tip at (x, y, zTip); the cutter is
// dropped from above, so each test answers "what is the highest zTip at
// which this triangle still touches the cutter?" and the caller maxes over
// all candidates, clamped to the zSeed floor.

export type DropCutterKind = 'flat' | 'ball';

/**
 * Squared-length guard for xy-degenerate edges (mm^2). An edge whose xy
 * projection is shorter than 1e-9 mm carries no interior contact information
 * beyond its endpoints (which the vertex tests already cover), and dividing
 * by its squared length would amplify noise.
 */
const EPS_XY_LEN2 = 1e-18;

/**
 * A facet whose unit normal has |n.z| below this is treated as vertical.
 * A vertical facet's supremum of support z always lies on its boundary, so
 * the edge/vertex tests cover it exactly; the facet formula itself would
 * divide by n.z and blow up.
 */
const EPS_VERTICAL_NZ = 1e-9;

/** Returned when a triangle cannot support the cutter at (x, y) at all. */
export const NO_CONTACT = -Infinity;

/**
 * Drop a FLAT cutter (horizontal disk of radius `radius` at the tip) onto
 * one triangle. Returns the candidate tip z, or NO_CONTACT.
 *
 * Key fact that shapes the flat tests: the underside is a horizontal disk,
 * so the exact drop is simply the SUPREMUM of surface z over the part of
 * the triangle whose xy lies inside the closed disk. That supremum is
 * attained either at a vertex inside the disk, at the uphill rim point on
 * the facet interior, or on an edge segment clipped to the disk -- the
 * three tests below.
 */
export function dropTriangleFlat(
  radius: number,
  x: number,
  y: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  // Culling contract: a triangle whose xy AABB misses the footprint AABB
  // can never touch the cutter. Callers may pre-cull; the check is cheap
  // enough to keep the function safe standalone.
  if (Math.min(ax, bx, cx) > x + radius) return NO_CONTACT;
  if (Math.max(ax, bx, cx) < x - radius) return NO_CONTACT;
  if (Math.min(ay, by, cy) > y + radius) return NO_CONTACT;
  if (Math.max(ay, by, cy) < y - radius) return NO_CONTACT;
  return dropTriangleFlatCore(radius, x, y, ax, ay, az, bx, by, bz, cx, cy, cz);
}

/**
 * dropTriangleFlat WITHOUT the AABB fast-path reject, for callers (the
 * kernel walk) that already ran a strictly tighter circle-vs-AABB gate.
 * Identical results in all cases: every individual test below validates
 * its own containment, so the AABB check is purely a fast path.
 */
export function dropTriangleFlatCore(
  radius: number,
  x: number,
  y: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const r2 = radius * radius;
  let best = NO_CONTACT;

  // Vertex tests: a vertex inside the closed disk supports the tip at its
  // own z (flat bottom touches the point directly).
  {
    const dxa = ax - x, dya = ay - y;
    if (dxa * dxa + dya * dya <= r2 && az > best) best = az;
    const dxb = bx - x, dyb = by - y;
    if (dxb * dxb + dyb * dyb <= r2 && bz > best) best = bz;
    const dxc = cx - x, dyc = cy - y;
    if (dxc * dxc + dyc * dyc <= r2 && cz > best) best = cz;
  }

  // Facet test: on a tilted plane the highest point under the disk is the
  // rim point in the uphill direction; on a horizontal plane every point
  // ties, so the axis point (x, y) serves. Valid only when that point lies
  // inside the triangle -- otherwise the facet supremum sits on an edge and
  // the edge tests own it.
  {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; } // upward normal
    // sqrt(sum of squares), not Math.hypot: hypot's overflow guarding costs
    // several times more per call and mm-scale coordinates cannot overflow.
    const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nz > nlen * EPS_VERTICAL_NZ && nlen > 0) {
      nx /= nlen; ny /= nlen; nz /= nlen;
      const nh = Math.sqrt(nx * nx + ny * ny);
      let px: number, py: number;
      if (nh < EPS_VERTICAL_NZ) {
        px = x; py = y; // horizontal facet: plane z is constant
      } else {
        // uphill = (-n.x, -n.y)/nh for an upward normal: plane z gradient is
        // (-n.x/n.z, -n.y/n.z), so the rim point at +radius uphill is max.
        px = x - (radius * nx) / nh;
        py = y - (radius * ny) / nh;
      }
      if (pointInTriangleXY(px, py, ax, ay, bx, by, cx, cy)) {
        const z = az + (nx * (ax - px) + ny * (ay - py)) / nz;
        if (z > best) best = z;
      }
    }
  }

  // Edge tests: clip each edge (in xy) against the closed disk; z is linear
  // along the edge so the max over the clipped sub-segment is at one of its
  // two clip endpoints.
  best = flatEdge(best, r2, x, y, ax, ay, az, bx, by, bz);
  best = flatEdge(best, r2, x, y, bx, by, bz, cx, cy, cz);
  best = flatEdge(best, r2, x, y, cx, cy, cz, ax, ay, az);
  return best;
}

function flatEdge(
  best: number,
  r2: number,
  x: number,
  y: number,
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number,
): number {
  const ex = qx - px, ey = qy - py, ez = qz - pz;
  const wx = px - x, wy = py - y;
  const e2 = ex * ex + ey * ey;
  const w2 = wx * wx + wy * wy;
  if (e2 < EPS_XY_LEN2) {
    // xy-degenerate (vertical) edge: the whole edge shares one xy spot, so
    // it is inside/outside the disk as a unit and its top endpoint wins.
    if (w2 <= r2) {
      const z = pz > qz ? pz : qz;
      if (z > best) return z;
    }
    return best;
  }
  // |w + s*e|^2 <= r2  ->  e2*s^2 + 2*g*s + (w2 - r2) <= 0 for s in [0, 1].
  const g = wx * ex + wy * ey;
  const disc = g * g - e2 * (w2 - r2);
  if (disc < 0) return best;
  const sq = Math.sqrt(disc);
  const s0 = Math.max(0, (-g - sq) / e2);
  const s1 = Math.min(1, (-g + sq) / e2);
  if (s0 > s1) return best;
  const z = pz + ez * (ez >= 0 ? s1 : s0);
  return z > best ? z : best;
}

/**
 * Drop a BALL cutter (sphere of radius `radius`, center at (x, y, zTip +
 * radius)) onto one triangle. Returns the candidate tip z, or NO_CONTACT.
 */
export function dropTriangleBall(
  radius: number,
  x: number,
  y: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  if (Math.min(ax, bx, cx) > x + radius) return NO_CONTACT;
  if (Math.max(ax, bx, cx) < x - radius) return NO_CONTACT;
  if (Math.min(ay, by, cy) > y + radius) return NO_CONTACT;
  if (Math.max(ay, by, cy) < y - radius) return NO_CONTACT;
  return dropTriangleBallCore(radius, x, y, ax, ay, az, bx, by, bz, cx, cy, cz);
}

/**
 * dropTriangleBall WITHOUT the AABB fast-path reject; see
 * dropTriangleFlatCore for the contract.
 */
export function dropTriangleBallCore(
  radius: number,
  x: number,
  y: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const r2 = radius * radius;
  let best = NO_CONTACT;

  // Vertex tests: the sphere rests on the vertex; center z solves
  // dist(center, v) = radius on the vertical line through (x, y).
  {
    const dxa = ax - x, dya = ay - y;
    const d2a = dxa * dxa + dya * dya;
    if (d2a <= r2) {
      const z = az + Math.sqrt(r2 - d2a) - radius;
      if (z > best) best = z;
    }
    const dxb = bx - x, dyb = by - y;
    const d2b = dxb * dxb + dyb * dyb;
    if (d2b <= r2) {
      const z = bz + Math.sqrt(r2 - d2b) - radius;
      if (z > best) best = z;
    }
    const dxc = cx - x, dyc = cy - y;
    const d2c = dxc * dxc + dyc * dyc;
    if (d2c <= r2) {
      const z = cz + Math.sqrt(r2 - d2c) - radius;
      if (z > best) best = z;
    }
  }

  // Facet test: offset the plane by radius along its upward unit normal;
  // the sphere center on the vertical line through (x, y) sits on that
  // offset plane, and the contact point center - radius*n must lie inside
  // the triangle (else an edge or vertex owns the contact).
  {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    // sqrt(sum of squares), not Math.hypot -- see dropTriangleFlat.
    const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nz > nlen * EPS_VERTICAL_NZ && nlen > 0) {
      nx /= nlen; ny /= nlen; nz /= nlen;
      const zCenter = az + (radius - nx * (x - ax) - ny * (y - ay)) / nz;
      const ccx = x - radius * nx;
      const ccy = y - radius * ny;
      if (pointInTriangleXY(ccx, ccy, ax, ay, bx, by, cx, cy)) {
        const z = zCenter - radius;
        if (z > best) best = z;
      }
    }
  }

  best = ballEdge(best, radius, r2, x, y, ax, ay, az, bx, by, bz);
  best = ballEdge(best, radius, r2, x, y, bx, by, bz, cx, cy, cz);
  best = ballEdge(best, radius, r2, x, y, cx, cy, cz, ax, ay, az);
  return best;
}

/**
 * Ball-vs-segment drop. The sphere center descends the vertical line
 * through (x, y); its resting height against the segment is
 *   f(s) = z(s) + sqrt(r2 - d2(s)),  d2(s) = |w + s*exy|^2 (xy distance),
 * maximized over s in [0, 1] where d2 <= r2. f is concave on its domain
 * (linear plus sqrt of a concave quantity), so the max is either at an
 * interior stationary point -- solved in closed form below -- or at s=0/1,
 * which the VERTEX tests already cover (identical formula). The domain
 * boundaries d2 = r2 can never be maxima: f' diverges toward them.
 *
 * Stationary point: f'(s) = 0  ->  dz*sqrt(r2 - d2(s)) = g + e2*s.
 * Squaring gives A*s^2 + B*s + C = 0 with
 *   k = e2 + dz^2, A = e2*k, B = 2*g*k, C = g^2 + dz^2*(w2 - r2),
 * and the squaring-induced spurious root is rejected by requiring
 * sign(g + e2*s) == sign(dz).
 */
function ballEdge(
  best: number,
  radius: number,
  r2: number,
  x: number,
  y: number,
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number,
): number {
  const ex = qx - px, ey = qy - py;
  const dz = qz - pz;
  const e2 = ex * ex + ey * ey;
  // xy-degenerate edge: the sphere can only rest on its top endpoint,
  // which the vertex test covers exactly.
  if (e2 < EPS_XY_LEN2) return best;
  const wx = px - x, wy = py - y;
  const w2 = wx * wx + wy * wy;
  const g = wx * ex + wy * ey;
  const k = e2 + dz * dz;
  const a = e2 * k;
  const b = 2 * g * k;
  const c = g * g + dz * dz * (w2 - r2);
  let disc = b * b - 4 * a * c;
  if (disc < 0) {
    // Tolerate rounding on a true double root (horizontal edges hit this).
    if (disc < -1e-9 * (b * b + Math.abs(4 * a * c) + 1)) return best;
    disc = 0;
  }
  const sq = Math.sqrt(disc);
  const inv2a = 1 / (2 * a); // a > 0 always: e2 > 0 and k >= e2
  best = ballEdgeRoot(best, radius, r2, (-b - sq) * inv2a, pz, dz, e2, g, w2);
  best = ballEdgeRoot(best, radius, r2, (-b + sq) * inv2a, pz, dz, e2, g, w2);
  return best;
}

function ballEdgeRoot(
  best: number,
  radius: number,
  r2: number,
  s: number,
  pz: number,
  dz: number,
  e2: number,
  g: number,
  w2: number,
): number {
  if (!(s >= 0 && s <= 1)) return best; // endpoints belong to vertex tests
  if (dz * (g + e2 * s) < 0) return best; // spurious squaring root
  const rad2 = r2 - (w2 + 2 * g * s + e2 * s * s);
  if (rad2 < 0) return best;
  const z = pz + s * dz + Math.sqrt(rad2) - radius;
  return z > best ? z : best;
}

/**
 * Inclusive point-in-triangle in the xy projection. Edge-inclusive on
 * purpose: boundary contacts are also found by the edge tests, so double
 * counting is harmless while excluding them could drop a facet contact
 * that rounds exactly onto an edge.
 */
export function pointInTriangleXY(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Dispatch by cutter kind; hot loops should bind the concrete function. */
export function dropTriangle(
  kind: DropCutterKind,
  radius: number,
  x: number,
  y: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  return kind === 'flat'
    ? dropTriangleFlat(radius, x, y, ax, ay, az, bx, by, bz, cx, cy, cz)
    : dropTriangleBall(radius, x, y, ax, ay, az, bx, by, bz, cx, cy, cz);
}

/**
 * Brute-force reference: drop against EVERY triangle, no culling. O(tris)
 * per query -- for tests and cross-checks only; the kernel uses the BVH to
 * cull and must agree with this exactly.
 */
export function dropPointOverTriangles(
  kind: DropCutterKind,
  radius: number,
  x: number,
  y: number,
  zSeed: number,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): number {
  const drop = kind === 'flat' ? dropTriangleFlat : dropTriangleBall;
  let best = zSeed;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = (indices[t] as number) * 3;
    const ib = (indices[t + 1] as number) * 3;
    const ic = (indices[t + 2] as number) * 3;
    const z = drop(
      radius, x, y,
      positions[ia] as number, positions[ia + 1] as number, positions[ia + 2] as number,
      positions[ib] as number, positions[ib + 1] as number, positions[ib + 2] as number,
      positions[ic] as number, positions[ic + 1] as number, positions[ic + 2] as number,
    );
    if (z > best) best = z;
  }
  return best;
}
