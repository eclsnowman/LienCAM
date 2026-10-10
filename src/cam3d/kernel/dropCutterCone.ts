// cam3d L2: exact drop-cutter contact math for a V-BIT (cone) cutter.
//
// Same contract and conventions as dropCutter.ts (flat/ball) and
// dropCutterBull.ts: per triangle, run vertex / facet / edge contact tests
// in f64 and take the max tip z; the BVH layer only culls. Units mm, Z-up,
// cutter tip at (x, y, zTip).
//
// The shape: a V-bit of outer radius R, half-angle a from the tool axis and
// an optional tip flat of radius Rt (0 = sharp point). With k = cot(a) (the
// flank rise per mm of radius), its underside height above the tip at xy
// distance d from the axis is
//   h(d) = 0                  for d <= Rt
//   h(d) = k * (d - Rt)       for Rt < d <= R,
// and above the full-radius height the body is a cylinder of radius R that
// can touch nothing the flank rim has not already met. So a surface point q
// at axis distance d supports the tip at
//   tip(q) = q.z - h(d) = q.z + phi(d - Rt),   phi(u) = -k * max(0, u).
// phi is concave and non-increasing, and d is convex in q's xy, so tip(q)
// is CONCAVE over any triangle clipped to the footprint disk -- the same one
// fact dropCutterBull.ts rests on, and it makes every test below exact: the
// facet max is the plane's unconstrained max when it lies inside the
// triangle, and the max along an edge is the clamp of the edge LINE's
// maximizer into the edge segment.

import { NO_CONTACT, pointInTriangleXY } from './dropCutter';

/** See dropCutter.ts: xy-degenerate edges carry no interior information. */
const EPS_XY_LEN2 = 1e-18;
/** See dropCutter.ts: facets with |n.z| below this are treated as vertical. */
const EPS_VERTICAL_NZ = 1e-9;

/** Tip lift of a surface point at xy distance `d` from the axis: phi(d - Rt), <= 0. */
function coneLift(d: number, tipR: number, k: number): number {
  const u = d - tipR;
  return u > 0 ? -k * u : 0;
}

/**
 * Drop a V-BIT (outer radius `radius`, flank rise `slopeK` = cot(half-angle
 * from the axis), tip flat radius `tipRadius`, 0 <= tipRadius < radius) onto
 * one triangle. Returns the candidate tip z, or NO_CONTACT.
 */
export function dropTriangleCone(
  radius: number,
  slopeK: number,
  tipRadius: number,
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
  return dropTriangleConeCore(radius, slopeK, tipRadius, x, y, ax, ay, az, bx, by, bz, cx, cy, cz);
}

/**
 * dropTriangleCone WITHOUT the AABB fast-path reject; see
 * dropTriangleFlatCore for the contract.
 */
export function dropTriangleConeCore(
  radius: number,
  slopeK: number,
  tipRadius: number,
  x: number,
  y: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const r2 = radius * radius;
  let best = NO_CONTACT;

  // Vertex tests: the vertex supports the tip at vz + phi(d - Rt).
  {
    const dxa = ax - x, dya = ay - y;
    const d2a = dxa * dxa + dya * dya;
    if (d2a <= r2) {
      const z = az + coneLift(Math.sqrt(d2a), tipRadius, slopeK);
      if (z > best) best = z;
    }
    const dxb = bx - x, dyb = by - y;
    const d2b = dxb * dxb + dyb * dyb;
    if (d2b <= r2) {
      const z = bz + coneLift(Math.sqrt(d2b), tipRadius, slopeK);
      if (z > best) best = z;
    }
    const dxc = cx - x, dyc = cy - y;
    const d2c = dxc * dxc + dyc * dyc;
    if (d2c <= r2) {
      const z = cz + coneLift(Math.sqrt(d2c), tipRadius, slopeK);
      if (z > best) best = z;
    }
  }

  // Facet test: along the plane's uphill direction from the axis, at
  // distance s, tip(s) = planeZ(axis) + g*s + phi(s - Rt) with g the plane's
  // gradient magnitude (= nh/nz). That rises at g up to the tip flat's rim,
  // then at g - k on the flank: a facet SHALLOWER than the flank (g < k) is
  // met by the tip flat's uphill rim (s = Rt; the tip point itself for a
  // sharp bit), a STEEPER one (g > k) by the cone's uphill rim (s = R). At
  // g = k the whole flank ties, and a horizontal facet ties the whole flat;
  // either chosen point is exact, and when it falls outside the triangle the
  // convex tie set crosses an edge, which the edge tests own.
  {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nz > nlen * EPS_VERTICAL_NZ && nlen > 0) {
      nx /= nlen; ny /= nlen; nz /= nlen;
      const nh = Math.sqrt(nx * nx + ny * ny);
      let px: number, py: number;
      if (nh < EPS_VERTICAL_NZ) {
        px = x; py = y; // horizontal facet: plane z is constant
      } else {
        const s = nh > slopeK * nz ? radius : tipRadius;
        px = x - (s * nx) / nh;
        py = y - (s * ny) / nh;
      }
      if (pointInTriangleXY(px, py, ax, ay, bx, by, cx, cy)) {
        const dx = px - x, dy = py - y;
        const z = az + (nx * (ax - px) + ny * (ay - py)) / nz + coneLift(Math.sqrt(dx * dx + dy * dy), tipRadius, slopeK);
        if (z > best) best = z;
      }
    }
  }

  best = coneEdge(best, r2, slopeK, tipRadius, x, y, ax, ay, az, bx, by, bz);
  best = coneEdge(best, r2, slopeK, tipRadius, x, y, bx, by, bz, cx, cy, cz);
  best = coneEdge(best, r2, slopeK, tipRadius, x, y, cx, cy, cz, ax, ay, az);
  return best;
}

/**
 * Cone-vs-segment drop. Parametrize the edge's xy LINE by signed arc length
 * sigma from the foot of the perpendicular from the axis (perpendicular
 * distance p), so d(sigma) = sqrt(p^2 + sigma^2) and the edge z is linear
 * with slope m per xy mm. F(sigma) = z(sigma) + phi(d(sigma) - Rt) is
 * concave on |sigma| <= L = sqrt(R^2 - p^2), so the max over the segment is
 * F at the clamp of the line's maximizer into the segment's interval.
 *
 * The maximizer, closed form: m = 0 -> 0 by symmetry. Otherwise with
 * tau = sign(m)*sigma >= 0, F'(tau) = |m| inside the tip flat and
 * |m| - k * tau/d on the flank; tau/d rises monotonically toward 1, so
 *   c = |m|/k >= 1: F only rises -> tau* = L (the cone's rim);
 *   c < 1: the flank root tau/d = c, i.e. tau = c*p/sqrt(1 - c^2), unless
 *          that lies inside the tip flat, where F' = |m| > 0 still -> the
 *          flat's rim tau = sqrt(Rt^2 - p^2). tau* is the larger of the two.
 */
function coneEdge(
  best: number,
  r2: number,
  k: number,
  tipR: number,
  x: number,
  y: number,
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number,
): number {
  const ex = qx - px, ey = qy - py;
  const e2 = ex * ex + ey * ey;
  // xy-degenerate (vertical) edge: its top endpoint is the only candidate,
  // which the vertex tests cover exactly (tip(q) rises with q.z at fixed d).
  if (e2 < EPS_XY_LEN2) return best;
  const elen = Math.sqrt(e2);
  const tx = ex / elen, ty = ey / elen;
  const m = (qz - pz) / elen;
  const wx = px - x, wy = py - y;
  const cross = wx * ty - wy * tx;
  const p2 = cross * cross;
  if (p2 > r2) return best;
  const halfChord = Math.sqrt(r2 - p2);
  const sP = wx * tx + wy * ty;
  const lo = sP > -halfChord ? sP : -halfChord;
  const hi = sP + elen < halfChord ? sP + elen : halfChord;
  if (lo > hi) return best;

  let sStar = 0;
  if (m !== 0) {
    const am = m < 0 ? -m : m;
    let tau: number;
    if (am >= k) {
      tau = halfChord;
    } else {
      const c = am / k;
      const tauFlank = (c * Math.sqrt(p2)) / Math.sqrt(1 - c * c);
      const tipR2 = tipR * tipR;
      const tauFlat = tipR2 > p2 ? Math.sqrt(tipR2 - p2) : 0;
      tau = tauFlank > tauFlat ? tauFlank : tauFlat;
      if (tau > halfChord) tau = halfChord;
    }
    sStar = m < 0 ? -tau : tau;
  }
  const s = sStar < lo ? lo : sStar > hi ? hi : sStar;
  const d = Math.sqrt(p2 + s * s);
  const z = pz + m * (s - sP) + coneLift(d, tipR, k);
  return z > best ? z : best;
}

/**
 * Brute-force reference: V-bit drop against EVERY triangle, no culling --
 * for tests and cross-checks only; the kernel must agree with this exactly.
 */
export function dropPointOverTrianglesCone(
  radius: number,
  slopeK: number,
  tipRadius: number,
  x: number,
  y: number,
  zSeed: number,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): number {
  let best = zSeed;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = (indices[t] as number) * 3;
    const ib = (indices[t + 1] as number) * 3;
    const ic = (indices[t + 2] as number) * 3;
    const z = dropTriangleCone(
      radius, slopeK, tipRadius, x, y,
      positions[ia] as number, positions[ia + 1] as number, positions[ia + 2] as number,
      positions[ib] as number, positions[ib + 1] as number, positions[ib + 2] as number,
      positions[ic] as number, positions[ic + 1] as number, positions[ic + 2] as number,
    );
    if (z > best) best = z;
  }
  return best;
}

/** Flank rise per mm of radius for a half-angle measured from the tool axis. */
export function coneSlopeK(angleFromAxisDeg: number): number {
  return 1 / Math.tan((angleFromAxisDeg * Math.PI) / 180);
}
