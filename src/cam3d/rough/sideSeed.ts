// cam3d rough: OUTSIDE-IN ("side entry") seed builder.
//
// The 2D adaptive engine (processFeature) accepts an OPT-IN `clearedSeed`: a
// pre-cleared region in the SAME absolute mm frame as the feature. For outside-in
// entry uses the `getEngagePoint` strategy: it places the tool CENTRE out in
// that pre-cleared air just past the material edge and grazes in by a load-sized
// protrusion, emitting entries[0].mode === 'side'. On no bounded engage point it falls
// back to the interior helix (ADR-0003 named fallback).
//
// HONEST recipe (no fiction): the seed is the OPEN STOCK EXTERIOR ONLY --
//   clearedSeed = (bigBox MINUS footprint)
// where bigBox is the footprint AABB expanded by 4*toolRadius. There is NO notch:
// getEngagePoint needs only the open exterior abutting the material edge; the tool
// rolls in from the air, so the seed models exactly what is physically already clear
// (the air around the stock) and nothing that is not. (The earlier notch tab -- a
// fictional solid poking into the ring to satisfy the OLD abut-probe -- is gone: it
// made the engine believe uncut material was cleared and drove ~84%/108% engagement.)
//
// WINDING: the engine does NO winding normalization on clearedSeed. Outer loops
// MUST be CCW (positive signed area), holes CW (negative). geom2d's boolean
// already returns that convention; we still verify+enforce by nesting depth so a
// wrong-sign loop can never slip through (a CW outer would read as a hole and
// silently drop the exterior seed). Verified with a shoelace.
//
// PURE + DETERMINISTIC (D-006): no globals, no async, no RNG, no time; identical
// inputs give byte-identical output. FAIL LOUD (ADR-0003): no positive-area outer,
// or an empty seed, THROWS rather than returning a silent empty seed.

import { boolean, area, type Ring } from '../geom2d';
import { ringsToLoops, type Loop } from './convert';

/** Engine seed shape: an array of {x,y} loops (== engine `Loops`). */
export type Loops = Loop[];

interface Vec {
  x: number;
  y: number;
}

/** Even-odd point-in-ring (ray cast) on a flat geom2d Ring. */
function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i];
    const yi = ring[2 * i + 1];
    const xj = ring[2 * j];
    const yj = ring[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Reverse a flat Ring's vertex order in place-free (returns a new Ring). */
function reverseRing(ring: Ring): Ring {
  const n = ring.length / 2;
  const out = new Float64Array(ring.length);
  for (let i = 0; i < n; i++) {
    const src = n - 1 - i;
    out[2 * i] = ring[2 * src];
    out[2 * i + 1] = ring[2 * src + 1];
  }
  return out;
}

/** A point STRICTLY inside a simple ring: midpoint of its longest edge nudged
 *  inward by a tiny epsilon along the local inward normal. Robust for the
 *  simple (bigBox / footprint-hole / notch-modified) rings this module produces. */
function interiorPoint(ring: Ring): [number, number] {
  const n = ring.length / 2;
  // Longest edge = most room, most stable normal.
  let bestLen = -1;
  let bi = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring[2 * j] - ring[2 * i];
    const dy = ring[2 * j + 1] - ring[2 * i + 1];
    const len = dx * dx + dy * dy;
    if (len > bestLen) {
      bestLen = len;
      bi = i;
    }
  }
  const j = (bi + 1) % n;
  const ax = ring[2 * bi];
  const ay = ring[2 * bi + 1];
  const bx = ring[2 * j];
  const by = ring[2 * j + 1];
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const tx = (bx - ax) / len;
  const ty = (by - ay) / len;
  const eps = Math.min(len * 0.25, 1e-3 * (Math.abs(bestLen) > 0 ? len : 1)) || 1e-6;
  // Left normal (-ty, tx); flip if it does not land inside.
  let nx = -ty;
  let ny = tx;
  if (!pointInRing(ring, mx + eps * nx, my + eps * ny)) {
    nx = -nx;
    ny = -ny;
  }
  return [mx + eps * nx, my + eps * ny];
}

/**
 * Enforce the engine's winding convention on a boolean-derived ring set: an
 * even nesting depth (outermost, islands) must be CCW (positive area); an odd
 * depth (holes) must be CW (negative). Reverses any ring whose sign is wrong.
 */
function normalizeWinding(rings: Ring[]): Ring[] {
  const reps = rings.map((r) => interiorPoint(r));
  return rings.map((r, i) => {
    // Nesting depth = number of OTHER rings containing this ring's interior point.
    let depth = 0;
    for (let k = 0; k < rings.length; k++) {
      if (k === i) continue;
      if (pointInRing(rings[k], reps[i][0], reps[i][1])) depth++;
    }
    const wantPositive = depth % 2 === 0; // even -> outer (CCW/+); odd -> hole (CW/-)
    const a = area(r);
    if (wantPositive && a < 0) return reverseRing(r);
    if (!wantPositive && a > 0) return reverseRing(r);
    return r;
  });
}

/** Ring [x0,y0,...] from a list of {x,y} corners. */
function ringFromPts(pts: Vec[]): Ring {
  const r = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    r[2 * i] = pts[i].x;
    r[2 * i + 1] = pts[i].y;
  }
  return r;
}

/**
 * Build the outside-in seed for one stock footprint at the current z: the HONEST
 * open exterior only = (bigBox MINUS footprint), where bigBox is the footprint AABB
 * expanded by 4*toolRadius. No notch, no fiction -- getEngagePoint rolls the tool in
 * from this air. The tool never treats any solid stock as pre-cleared.
 *
 * @param footprint  stock cross-section as geom2d Ring[] (outers CCW +area,
 *                   holes CW -area). Its LARGEST positive-area ring is the outer,
 *                   used only for the AABB.
 * @param toolRadius mm; sets the bigBox pad (4*toolRadius).
 * @param retained   optional part section (same frame) the seed must never call air.
 *                   WO-2145: a part that touches the stock edge (a part in its own box
 *                   stock) stands, with its safety margin, a little past the footprint;
 *                   united with the planner's region, air claimed there erased that
 *                   margin and the wall pass rode exactly one tool radius off the part.
 *                   Subtracted only where it overlaps the exterior (otherwise unchanged).
 * @returns engine `Loops` ({x,y}[][]) in the SAME absolute mm frame as footprint.
 */
export function buildSideEntrySeed(
  footprint: readonly Ring[],
  toolRadius: number,
  retained?: readonly Ring[],
): Loops {
  if (!(toolRadius > 0) || !Number.isFinite(toolRadius)) {
    throw new Error(`buildSideEntrySeed: toolRadius must be finite and > 0, got ${toolRadius}.`);
  }
  if (footprint.length === 0) {
    throw new Error('buildSideEntrySeed: empty footprint (no rings).');
  }

  // --- pick the OUTER ring = largest positive-area ring (for the AABB) ----
  let outer: Ring | null = null;
  let outerArea = 0;
  for (const r of footprint) {
    const a = area(r);
    if (a > outerArea) {
      outerArea = a;
      outer = r;
    }
  }
  if (outer === null) {
    throw new Error('buildSideEntrySeed: footprint has no positive-area outer ring.');
  }
  const n = outer.length / 2;
  const r = toolRadius;

  // --- bigBox: AABB of the outer expanded by 4r on every side (CCW) -------
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = outer[2 * i];
    const y = outer[2 * i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = 4 * r;
  const bigBox = ringFromPts([
    { x: minX - pad, y: minY - pad },
    { x: maxX + pad, y: minY - pad },
    { x: maxX + pad, y: maxY + pad },
    { x: minX - pad, y: maxY + pad },
  ]);

  // --- seed = (bigBox - footprint) : the honest open exterior -------------
  // WO-2145: the OUTSIDE only. A footprint's holes are material an earlier rough
  // already took (a rest start's cleared pocket chambers). Called exterior air, they
  // made the seed touch an interior pocket and, united with it, wrap it (the WO-1178
  // trap): no entry was ever found there and the rest rough produced nothing. Without
  // holes (every first rough) this is the same seed as before.
  const hasHoles = footprint.some((ring) => area(ring) < 0);
  let exterior = boolean([bigBox],
    hasHoles ? footprint.filter((ring) => area(ring) > 0) as Ring[] : footprint as Ring[], 'difference');
  if (retained !== undefined && retained.length > 0 && exterior.length > 0) {
    const overlap = boolean(exterior, retained as Ring[], 'intersect');
    if (overlap.some((ring) => Math.abs(area(ring)) > 1e-12)) {
      exterior = boolean(exterior, retained as Ring[], 'difference');
    }
  }
  if (exterior.length === 0) {
    throw new Error('buildSideEntrySeed: exterior (bigBox - footprint) came out empty.');
  }

  // --- verify+enforce winding, then convert to engine Loops ---------------
  const normalized = normalizeWinding(exterior);
  return ringsToLoops(normalized);
}
