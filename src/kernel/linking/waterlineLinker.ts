// WO-3026 (alpha.3 A3-12): the waterline linker, copied from
// src/cam3d/strategies/waterline/link.ts (read-only, not edited). Changes: this header,
// the imports (the pass shape is declared here; the traverse standoff comes through the
// kernel 3D finishing linker, i.e. the standoff table). Parity `link.finish_linker_3d`
// keeps waterline's own linker and 10 deg ramp; one 3D finishing linker is MD-66.
//
// cam3d L4 (waterline): links level passes into one IR move program.
//
// Lifting to clearance after every level and hopping between pockets adds
// unnecessary travel. This linker uses a bounded stay-down distance and a
// profile ramp with the numbers the operation already has:
//
//   STAY DOWN between consecutive passes when the next pass starts within
//   min(stepdown, cutter radius) of where the last one ended and is at the
//   same height or lower. The connector is then a short feed at the current
//   height ('stepover') followed by a descent ALONG THE NEXT PASS at the ramp
//   angle ('lead_in') -- a profile ramp. A closed pass takes as many
//   laps as the drop needs (a helical profile ramp). The limit is the same
//   proof pathbuild.ts uses for its raster links (WO-266 P1): a connector no
//   longer than min(stepdown, r) cannot walk the cutter further out of the
//   corridor the previous pass just swept than the pass itself bites.
//
//   RETRACT otherwise: straight up to the traverse plane, over, down to the
//   Feed plane, then the same profile ramp from Feed down to the level.
//
// WHY THE DESCENT ALONG A LOWER LOOP CANNOT GOUGE THE PART. The slicer's loop
// at height z bounds the region the cutter may occupy at z without touching
// material at or above z (WO-284 section 4: the loop is the outline of
// everything ABOVE z, the cap of a mushroom included). That free region can
// only GROW with height -- material above z' > z is a subset of material
// above z -- so every point of the loop at z is free at every height above
// z. A vertical or ramped descent onto a lower loop therefore meets nothing
// of the PART. What it may meet is in-process stock nobody has proved absent;
// that is exactly what the stay-down bound above and the traverse plane
// floored on the proven material top (pathbuild's TRAVERSE_STANDOFF_MM)
// answer, the same way they do for the raster finish.
//
// Roles (ir/types.ts): rapid, plunge (degenerate vertical entry on a pass too
// short to ramp), lead_in (the profile ramp), cut, stepover (stay-down feed).
// Pure and deterministic: fixed iteration order, no RNG.

import type { IrMove } from './ir';
import { TRAVERSE_STANDOFF_MM, type PathBuildHeights } from './finishLinker3d';

/** One waterline pass (src/cam3d/strategies/waterline/loops.ts WaterlinePass, structurally). */
export interface WaterlinePass {
  xy: Float64Array;
  z: number;
  closed: boolean;
  /** Index into the level ladder (0 = highest). */
  level: number;
  /** Material inside the loop (boss / island) or outside (pocket wall). */
  materialInside: boolean;
  /** Assigned by regionise(); -1 until then. */
  region: number;
}

export interface WaterlineLinkPolicy {
  /** Level spacing, mm (> 0). */
  stepdown: number;
  /** Cutter radius, mm (> 0): the other half of the stay-down bound. */
  cutterRadiusMm: number;
  /** Profile-ramp descent angle from horizontal, degrees in (0, 90). Default 10. */
  rampAngleDeg?: number;
}

const DEFAULT_RAMP_ANGLE_DEG = 10;
const Z_EPS = 1e-9;

function fail(msg: string): never {
  throw new Error(`waterline link: ${msg}`);
}

/** Cumulative xy arc length along a pass (closed: one full lap incl. the seam). */
function perimeter(pass: WaterlinePass): number {
  const n = pass.xy.length / 2;
  let len = 0;
  for (let i = 1; i < n; i++) {
    len += Math.hypot(pass.xy[2 * i] - pass.xy[2 * i - 2], pass.xy[2 * i + 1] - pass.xy[2 * i - 1]);
  }
  if (pass.closed && n > 1) len += Math.hypot(pass.xy[0] - pass.xy[2 * n - 2], pass.xy[1] - pass.xy[2 * n - 1]);
  return len;
}

/**
 * The point of a closed pass nearest to (x, y): which edge, where along it,
 * and how far away. The stay-down reach is measured to THIS point, and the
 * pass is then started there, so a level-to-level link on a vertical wall
 * has zero reach wherever the previous lap happened to touch down.
 */
function nearestPointOnPass(pass: WaterlinePass, x: number, y: number): { edge: number; t: number; x: number; y: number; dist: number } {
  const n = pass.xy.length / 2;
  let best = { edge: 0, t: 0, x: pass.xy[0], y: pass.xy[1], dist: Infinity };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pass.xy[2 * i];
    const ay = pass.xy[2 * i + 1];
    const bx = pass.xy[2 * j];
    const by = pass.xy[2 * j + 1];
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    let t = lenSq > 0 ? ((x - ax) * vx + (y - ay) * vy) / lenSq : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const qx = ax + vx * t;
    const qy = ay + vy * t;
    const d = Math.hypot(qx - x, qy - y);
    if (d < best.dist - Z_EPS) best = { edge: i, t, x: qx, y: qy, dist: d };
  }
  return best;
}

/**
 * A closed pass re-started at an arbitrary point on edge `edge`: the point
 * first, then the vertices after that edge around the loop. Vertices that
 * coincide with the start point are not repeated.
 */
function startedAt(pass: WaterlinePass, at: { edge: number; t: number; x: number; y: number }): Float64Array {
  const n = pass.xy.length / 2;
  const out: number[] = [at.x, at.y];
  for (let k = 1; k <= n; k++) {
    const idx = (at.edge + k) % n;
    const vx = pass.xy[2 * idx];
    const vy = pass.xy[2 * idx + 1];
    if (vx === at.x && vy === at.y) continue;
    out.push(vx, vy);
  }
  return new Float64Array(out);
}

/**
 * Build the linked program. Passes arrive ALREADY ORDERED (see index.ts);
 * this function only decides how to get from one to the next.
 */
export function linkWaterlinePasses(
  passes: readonly WaterlinePass[],
  heights: PathBuildHeights,
  policy: WaterlineLinkPolicy,
): IrMove[] {
  if (passes.length === 0) fail('no passes; linking nothing is an upstream bug');
  if (!(policy.stepdown > 0) || !Number.isFinite(policy.stepdown)) fail(`invalid stepdown ${policy.stepdown}`);
  if (!(policy.cutterRadiusMm > 0) || !Number.isFinite(policy.cutterRadiusMm)) {
    fail(`invalid cutterRadiusMm ${policy.cutterRadiusMm}`);
  }
  const rampDeg = policy.rampAngleDeg ?? DEFAULT_RAMP_ANGLE_DEG;
  if (!(rampDeg > 0) || !(rampDeg < 90)) fail(`rampAngleDeg ${rampDeg} outside (0, 90)`);
  const { clearanceZ, retractZ, feedZ } = heights;
  if (![clearanceZ, retractZ, feedZ].every(Number.isFinite)) {
    fail(`non-finite heights clearanceZ=${clearanceZ} retractZ=${retractZ} feedZ=${feedZ}`);
  }
  if (clearanceZ < retractZ || retractZ < feedZ) {
    fail(`heights must satisfy clearanceZ >= retractZ >= feedZ; got ${clearanceZ}, ${retractZ}, ${feedZ}`);
  }
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    if (p.xy.length < 4 || p.xy.length % 2 !== 0) fail(`pass ${i} has ${p.xy.length / 2} points; a pass needs >= 2`);
    if (!Number.isFinite(p.z)) fail(`pass ${i} has non-finite z`);
    if (p.z > feedZ + Z_EPS) fail(`pass ${i} at z=${p.z} is above feedZ=${feedZ}; the feed transition is below the cut`);
    for (let k = 0; k < p.xy.length; k++) if (!Number.isFinite(p.xy[k])) fail(`pass ${i} has a non-finite coordinate`);
  }

  const traverseZ = heights.materialTopZ === undefined
    ? clearanceZ
    : Math.max(clearanceZ, heights.materialTopZ + TRAVERSE_STANDOFF_MM);
  const stayDownReach = Math.min(policy.stepdown, policy.cutterRadiusMm);
  const rampTan = Math.tan((rampDeg * Math.PI) / 180);
  const minRampPerimeter = 2 * policy.cutterRadiusMm; // shorter loops plunge

  const moves: IrMove[] = [];
  let px = NaN;
  let py = NaN;
  let pz = NaN;
  const push = (t: 'rapid' | 'feed', x: number, y: number, z: number, role: IrMove['role']): void => {
    if (px === x && py === y && pz === z) return;
    moves.push({ t, x, y, z, role });
    px = x;
    py = y;
    pz = z;
  };

  /**
   * Descend from the current height to `pass.z` and cut the whole pass. A
   * closed pass ramps along itself (lapping when it is smaller than the ramp)
   * and the cut runs one full loop from the touchdown point back to it; an
   * open pass, and a closed one smaller than the cutter, plunges at its
   * first vertex and is cut from there.
   */
  const rampAndCut = (xy: Float64Array, closed: boolean, z: number): void => {
    const n = xy.length / 2;
    let drop = pz - z;
    const per = closed ? perimeter({ xy, z, closed, level: 0, materialInside: false, region: 0 }) : 0;
    if (drop <= Z_EPS) {
      // Already at the level (a stay-down onto the same height): cut from vertex 0.
      for (let i = 1; i < n; i++) push('feed', xy[2 * i], xy[2 * i + 1], z, 'cut');
      if (closed) push('feed', xy[0], xy[1], z, 'cut');
      return;
    }
    // A ramp only ever earns its keep on a CLOSED pass, where the lap after
    // touchdown cuts the stretch the ramp descended over. An OPEN pass has no
    // lap: its first `drop / tan(ramp)` mm would be descended once and never
    // cut at the level (audit finding 1). It plunges at its start instead --
    // gouge-free by the descent invariant above -- and is cut from vertex 0.
    // A closed pass whose perimeter is under one cutter diameter plunges too.
    const canRamp = closed && per >= minRampPerimeter;
    if (!canRamp) {
      push('feed', xy[0], xy[1], z, 'plunge');
      for (let i = 1; i < n; i++) push('feed', xy[2 * i], xy[2 * i + 1], z, 'cut');
      if (closed) push('feed', xy[0], xy[1], z, 'cut');
      return;
    }
    // The ramp descends at most one stepdown along the loop. A retract entry
    // arrives from the Feed plane, which on a deep level is many stepdowns up;
    // ramping all of it would lap a small loop dozens of times (audit finding
    // 3: 23 laps for one entry). The descent to one stepdown above the level
    // is a straight plunge at the loop's start, on ground the descent
    // invariant proves free of the part.
    if (drop > policy.stepdown + Z_EPS) {
      push('feed', xy[0], xy[1], z + policy.stepdown, 'plunge');
      drop = policy.stepdown;
    }
    const rampLen = drop / rampTan;
    // Walk the pass (cyclically when closed) emitting lead_in vertices until
    // the ramp line reaches z; the touchdown point is interpolated exactly.
    const zStart = pz;
    let walked = 0;
    let i = 0; // index of the vertex we are standing on
    let touchX = xy[0];
    let touchY = xy[1];
    let touchIndex = 0; // vertex index the touchdown edge ends on
    for (let guard = 0; guard < n * 1000; guard++) {
      const j = (i + 1) % n; // closed passes only reach this loop
      const ax = xy[2 * i];
      const ay = xy[2 * i + 1];
      const bx = xy[2 * j];
      const by = xy[2 * j + 1];
      const edge = Math.hypot(bx - ax, by - ay);
      if (walked + edge >= rampLen - Z_EPS) {
        const t = edge > 0 ? (rampLen - walked) / edge : 1;
        touchX = ax + (bx - ax) * t;
        touchY = ay + (by - ay) * t;
        touchIndex = j;
        push('feed', touchX, touchY, z, 'lead_in');
        break;
      }
      walked += edge;
      push('feed', bx, by, zStart - rampTan * walked, 'lead_in');
      i = j;
    }
    // The cut: from the touchdown point around the pass and back to it.
    if (closed) {
      for (let k = 0; k < n; k++) {
        const idx = (touchIndex + k) % n;
        push('feed', xy[2 * idx], xy[2 * idx + 1], z, 'cut');
      }
      push('feed', touchX, touchY, z, 'cut');
    } else {
      for (let k = touchIndex; k < n; k++) push('feed', xy[2 * k], xy[2 * k + 1], z, 'cut');
    }
  };

  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];
    const hasPosition = Number.isFinite(pz);
    const xy = hasPosition && pass.closed ? startedAt(pass, nearestPointOnPass(pass, px, py)) : pass.xy;
    const sx = xy[0];
    const sy = xy[1];
    const reach = hasPosition ? Math.hypot(sx - px, sy - py) : Infinity;
    const sameOrLower = hasPosition && pass.z <= pz + Z_EPS;
    if (hasPosition && sameOrLower && reach <= stayDownReach + Z_EPS) {
      // Stay down: slide at the current height onto the next pass's start,
      // then profile-ramp down to its level.
      push('feed', sx, sy, pz, 'stepover');
      rampAndCut(xy, pass.closed, pass.z);
      continue;
    }
    // Retract entry.
    if (hasPosition) push('rapid', px, py, traverseZ, 'rapid');
    push('rapid', sx, sy, traverseZ, 'rapid');
    if (feedZ < pass.z - Z_EPS) fail(`feedZ ${feedZ} below pass z ${pass.z}; the entry would gouge`);
    push('rapid', sx, sy, feedZ, 'rapid');
    rampAndCut(xy, pass.closed, pass.z);
  }
  push('rapid', px, py, traverseZ, 'rapid');
  return moves;
}
