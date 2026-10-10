// cam3d L2: exact drop-cutter contact math for a BULL-NOSE (torus) cutter.
//
// Same contract and conventions as dropCutter.ts (flat/ball): per triangle,
// run vertex / facet / edge contact tests in f64 and take the max tip z;
// the BVH layer only culls. Units mm, Z-up, cutter tip at (x, y, zTip).
//
// The shape: a bull-nose end mill of radius R with corner radius rc is the
// Minkowski sum of a horizontal DISK of radius Rf = R - rc (the flat core)
// and a BALL of radius rc, with the disk at zTip + rc. Its underside height
// above the tip at xy distance d from the axis is
//   h(d) = 0                                 for d <= Rf
//   h(d) = rc - sqrt(rc^2 - (d - Rf)^2)      for Rf < d <= R,
// so a surface point q at axis distance d supports the tip at
//   tip(q) = q.z - h(d) = q.z + phi(d - Rf),
//   phi(u) = u <= 0 ? 0 : sqrt(rc^2 - u^2) - rc.
// phi is concave and non-increasing, and d is convex in q's xy, so tip(q)
// is CONCAVE over any triangle clipped to the footprint disk. That one fact
// makes every test below exact: the facet max is the plane's unconstrained
// max when it lies inside the triangle, and the max along an edge is the
// clamp of the edge LINE's maximizer into the edge segment.
//
// Limits: rc = 0 is the flat cutter (h = 0 on the whole disk), rc = R is
// the ball (Rf = 0). Both are handled by the same formulas below, with no
// special-casing beyond a guarded divide.

import { NO_CONTACT, pointInTriangleXY } from './dropCutter';

/** See dropCutter.ts: xy-degenerate edges carry no interior information. */
const EPS_XY_LEN2 = 1e-18;
/** See dropCutter.ts: facets with |n.z| below this are treated as vertical. */
const EPS_VERTICAL_NZ = 1e-9;
/** Newton iteration cap for the edge maximizer (converges in ~5-10). */
const EDGE_MAX_ITER = 100;

/**
 * Tip lift of a surface point at xy distance `d` from the cutter axis:
 * phi(d - Rf), <= 0. Clamped at the rim so a rounding excursion just past
 * d = R still reads as the rim value -rc rather than NaN.
 */
function bullLift(d: number, flatR: number, corner: number): number {
  const u = d - flatR;
  if (u <= 0) return 0;
  const w2 = corner * corner - u * u;
  return (w2 > 0 ? Math.sqrt(w2) : 0) - corner;
}

/**
 * Drop a BULL-NOSE cutter (outer radius `radius`, corner radius
 * `cornerRadius`, 0 <= cornerRadius <= radius) onto one triangle. Returns
 * the candidate tip z, or NO_CONTACT.
 */
export function dropTriangleBull(
  radius: number,
  cornerRadius: number,
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
  return dropTriangleBullCore(radius, cornerRadius, x, y, ax, ay, az, bx, by, bz, cx, cy, cz);
}

/**
 * dropTriangleBull WITHOUT the AABB fast-path reject; see
 * dropTriangleFlatCore for the contract.
 */
export function dropTriangleBullCore(
  radius: number,
  cornerRadius: number,
  x: number,
  y: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const r2 = radius * radius;
  const flatR = radius - cornerRadius > 0 ? radius - cornerRadius : 0;
  let best = NO_CONTACT;

  // Vertex tests: the vertex supports the tip at vz + phi(d - Rf).
  {
    const dxa = ax - x, dya = ay - y;
    const d2a = dxa * dxa + dya * dya;
    if (d2a <= r2) {
      const z = az + bullLift(Math.sqrt(d2a), flatR, cornerRadius);
      if (z > best) best = z;
    }
    const dxb = bx - x, dyb = by - y;
    const d2b = dxb * dxb + dyb * dyb;
    if (d2b <= r2) {
      const z = bz + bullLift(Math.sqrt(d2b), flatR, cornerRadius);
      if (z > best) best = z;
    }
    const dxc = cx - x, dyc = cy - y;
    const d2c = dxc * dxc + dyc * dyc;
    if (d2c <= r2) {
      const z = cz + bullLift(Math.sqrt(d2c), flatR, cornerRadius);
      if (z > best) best = z;
    }
  }

  // Facet test: offset the plane by rc along its upward unit normal; the
  // flat core disk (radius Rf, at zTip + rc) rests on that offset plane at
  // its uphill rim point p (any disk point on a horizontal plane -- the axis
  // serves), and the true contact is p - rc*n. Valid only when that contact
  // lies inside the triangle; otherwise the concave max over the triangle
  // sits on its boundary and the edge/vertex tests own it.
  //   tip = planeZ(p) + rc/n.z - rc
  // rc = 0 is the flat rim formula; Rf = 0 is the ball offset-plane formula.
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
        px = x; py = y;
      } else {
        px = x - (flatR * nx) / nh;
        py = y - (flatR * ny) / nh;
      }
      const ccx = px - cornerRadius * nx;
      const ccy = py - cornerRadius * ny;
      if (pointInTriangleXY(ccx, ccy, ax, ay, bx, by, cx, cy)) {
        const z = az + (nx * (ax - px) + ny * (ay - py)) / nz + cornerRadius / nz - cornerRadius;
        if (z > best) best = z;
      }
    }
  }

  best = bullEdge(best, radius, r2, flatR, cornerRadius, x, y, ax, ay, az, bx, by, bz);
  best = bullEdge(best, radius, r2, flatR, cornerRadius, x, y, bx, by, bz, cx, cy, cz);
  best = bullEdge(best, radius, r2, flatR, cornerRadius, x, y, cx, cy, cz, ax, ay, az);
  return best;
}

/**
 * Bull-vs-segment drop. Parametrize the edge's xy LINE by signed arc length
 * sigma from the foot of the perpendicular from the axis (perpendicular
 * distance p), so d(sigma) = sqrt(p^2 + sigma^2) and the edge z is linear
 * with slope m per xy mm. The support function along the line,
 *   F(sigma) = z(sigma) + phi(d(sigma) - Rf),
 * is concave on its domain |sigma| <= L = sqrt(R^2 - p^2) (see header), so
 * the max over the edge segment is F at the clamp of the line's maximizer
 * sigma* into the segment's sigma interval -- exact, and it covers the
 * endpoints too.
 *
 * sigma*: m = 0 -> 0 by symmetry. Otherwise, with tau = sign(m)*sigma >= 0,
 *   F'(tau) = |m| - (u / w) * (tau / d),  u = d - Rf, w = sqrt(rc^2 - u^2),
 * is strictly decreasing, equals |m| > 0 wherever d <= Rf, and diverges to
 * -Infinity at the rim when rc > 0; its root is found by Newton safeguarded
 * by bisection (F'' is closed-form and negative). rc = 0 (flat) has no
 * interior root: the max is at the rim, tau* = L.
 */
function bullEdge(
  best: number,
  radius: number,
  r2: number,
  flatR: number,
  corner: number,
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
    if (!(corner > 0)) {
      tau = halfChord;
    } else {
      const fr2 = flatR * flatR;
      let a = fr2 > p2 ? Math.sqrt(fr2 - p2) : 0;
      let b = halfChord;
      // Start from the p = 0 closed form: the contact where the corner arc's
      // slope equals |m|, i.e. u = rc*|m|/sqrt(1+m^2).
      const d0 = flatR + (corner * am) / Math.sqrt(1 + am * am);
      tau = d0 * d0 > p2 ? Math.sqrt(d0 * d0 - p2) : a;
      if (!(tau > a && tau < b)) tau = 0.5 * (a + b);
      for (let it = 0; it < EDGE_MAX_ITER && b > a; it++) {
        const d = Math.sqrt(p2 + tau * tau);
        let u = d - flatR;
        if (u < 0) u = 0;
        const w2 = corner * corner - u * u;
        if (!(w2 > 0)) { b = tau; tau = 0.5 * (a + b); continue; } // at/past the rim
        const w = Math.sqrt(w2);
        const ratio = d > 0 ? tau / d : 0;
        const f1 = am - (u / w) * ratio;
        if (f1 > 0) a = tau;
        else if (f1 < 0) b = tau;
        else break;
        const f2 = -((corner * corner) / (w2 * w)) * ratio * ratio - (d > 0 ? (u / w) * (p2 / (d * d * d)) : 0);
        let next = f2 < 0 ? tau - f1 / f2 : NaN;
        if (!(next > a && next < b)) next = 0.5 * (a + b);
        const step = next - tau;
        tau = next;
        if ((step < 0 ? -step : step) <= 1e-15 * (1 + radius)) break;
      }
    }
    sStar = m < 0 ? -tau : tau;
  }
  const s = sStar < lo ? lo : sStar > hi ? hi : sStar;
  const d = Math.sqrt(p2 + s * s);
  const z = pz + m * (s - sP) + bullLift(d, flatR, corner);
  return z > best ? z : best;
}

/**
 * Brute-force reference: bull drop against EVERY triangle, no culling --
 * for tests and cross-checks only; the kernel must agree with this exactly.
 */
export function dropPointOverTrianglesBull(
  radius: number,
  cornerRadius: number,
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
    const z = dropTriangleBull(
      radius, cornerRadius, x, y,
      positions[ia] as number, positions[ia + 1] as number, positions[ia + 2] as number,
      positions[ib] as number, positions[ib + 1] as number, positions[ib + 2] as number,
      positions[ic] as number, positions[ic + 1] as number, positions[ic + 2] as number,
    );
    if (z > best) best = z;
  }
  return best;
}
