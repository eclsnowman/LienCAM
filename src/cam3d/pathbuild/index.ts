// cam3d L5: path builder -- links pre-sampled surface passes into one IR
// move program (rapids, plunges, ramp lead-ins, cuts, stay-down links).
//
// Layering: this module is PURE -- no kernel, no clipper, no three imports.
// Cut geometry arrives fully sampled (dense polylines already ON the drop
// surface) and is NEVER resampled here; the only surface queries the builder
// needs (stay-down connector feasibility + link z values) go through an
// injected async sampler callback, so unit tests drive it with synthetic
// surfaces and the strategy layer wires it to GeometryKernel.dropPoints.
//
// Determinism (D-006): fixed iteration order, no RNG, no time dependence.
// Identical passes + heights + policy + a deterministic sampler give a
// byte-identical move list. Browser headroom (D-014): scratch is per-pass
// typed arrays; the output is one object per emitted IR move, which is the
// IR's own shape (ir/types.ts) -- no per-point garbage beyond it.
//
// Role vocabulary: the EXISTING IrMoveRole values suffice -- no extension
// was needed. Mapping from the linking vocabulary to ir/types.ts roles:
//   rapid -> 'rapid'      positioning on the traverse plane (see traverseZ)
//   plunge -> 'plunge'    cutting descent below feedZ, and the degenerate vertical
//                         entry when a pass is too short to ramp (the
//                         'plunge' role on the surface-touching feed move IS
//                         the degenerate-entry flag)
//   lead  -> 'lead_in'    ramp descent along the pass line onto its start
//   cut   -> 'cut'        on-surface pass geometry
//   link  -> 'stepover'   stay-down cross-link between adjacent passes

import type { IrMove } from '../ir/types';

/**
 * Z vocabulary per the repo convention (ADR-0002 local-alias rule: drop
 * "Height", append "Z"). Units mm, Z-up, Z=0 at table surface.
 */
export type PathBuildHeights = {
  /** Authored safe traverse level; the traverse plane is never BELOW this. */
  clearanceZ: number;
  /** Safe retract/link plane above Feed Height. */
  retractZ: number;
  /**
   * Lowest legal rapid-descent endpoint when no material top is proven; all
   * cutting entry starts here or, on a proven top, lower (WO-2210).
   */
  feedZ: number;
  /**
   * Top of the highest material the tool can meet -- the IN-PROCESS STOCK top,
   * NOT the part top (WO-127; Operator, WO-096: "Just because it is above the part
   * does not mean it is above uncleared stock"). When present, every traverse
   * rapid is
   * emitted at `max(clearanceZ, materialTopZ + TRAVERSE_STANDOFF_MM)`, so a
   * clearance plane authored level with -- or below -- the stock cannot put a
   * positioning move inside material.
   *
   * UNDEFINED MEANS UNPROVEN, not "no material". The builder then has nothing
   * to floor the traverse plane against and leaves it at the authored
   * clearanceZ, which is only as safe as the caller's number. Callers that
   * cannot prove a material top must SAY SO rather than pass the part top --
   * substituting the part top is the defect this field exists to close, and
   * `computeParallel3dMoves` warns loudly when it has to fall back.
   */
  materialTopZ?: number;
};

/**
 * A rapid must clear proven material by at least this much, mm. Operator's rule
 * from WO-096: the clearance plane "must sit strictly ABOVE the highest
 * material - never level with it", because his own project resolved clearance
 * to EXACTLY the stock top (z=15.000) and that is not a clearance plane.
 *
 * DECIDE AND LOG (LIENCAM rule 3): 1 mm is the standoff chosen here. It is the
 * smallest gap that still reads as air on a machine whose stock top is itself
 * only known to setup accuracy; it is not tuned to any fixture. Operator can
 * reverse it -- nothing else in the builder depends on the value, only on it
 * being > 0.
 */
export const TRAVERSE_STANDOFF_MM = 1;

/**
 * Samples the drop surface at arbitrary (x, y) pairs (x0,y0,x1,y1,...),
 * returning one z per point in input order. MUST be deterministic --
 * identical inputs must give identical outputs -- or builder determinism
 * breaks. The strategy layer wires this to GeometryKernel.dropPoints; tests
 * wire synthetic surfaces.
 */
export type ConnectorSampler = (xy: Float64Array) => Promise<Float64Array>;

export type LinkPolicy = {
  /** Pass spacing (mm); the stay-down rule keys off it. */
  stepover: number;
  /**
   * Contact radius of the cutter driving these passes (mm, = diameter / 2).
   * REQUIRED, and deliberately not defaulted: it is the only in-engine PROOF
   * that a stay-down link crosses cleared territory (WO-127 fix round, finding
   * 2). Cutting a pass sweeps the tool body through a corridor of this radius
   * about the pass, so a connector that stays inside that corridor runs over
   * ground the tool itself just cut; one that leaves it runs over ground
   * NOTHING has touched, where in-process stock may still stand full height.
   * The proof is on the WHOLE CUTTER, not its centreline -- see P1 and
   * `corridorEscapeMm` for what "stays inside" is actually measured as.
   *
   * A default here would be a guess about the machine, which is the exact
   * failure mode this WO exists to close, so the type forces every caller to
   * state it.
   */
  cutterContactRadiusMm: number;
  /**
   * Ramp lead-in descent angle from horizontal, degrees, in (0, 90).
   * Default 10.
   */
  rampAngleDeg?: number;
  /**
   * Stay-down gate: max |sampled surface z - straight chord z| along the
   * connector (mm). A larger deviation means a ridge or valley between the
   * passes -- retract over it instead of feeding across. Default = stepover.
   */
  maxStayDownDeviationZ?: number;
  /** Connector surface sampling step (mm). Default = stepover / 2. */
  connectorSampleStep?: number;
  /** Alternate pass direction (odd-index passes reversed). Default true. */
  zigzag?: boolean;
};

const DEFAULT_RAMP_ANGLE_DEG = 10;
const Z_EPS = 1e-9;

function fail(msg: string): never {
  throw new Error(`pathbuild: ${msg}`);
}

function validateInputs(
  passes: readonly Float64Array[],
  heights: PathBuildHeights,
  policy: LinkPolicy,
): void {
  if (passes.length === 0) fail('no passes; linking nothing is an upstream bug');
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    if (p.length % 3 !== 0) fail(`pass ${i} length ${p.length} is not xyz triples`);
    if (p.length < 6) fail(`pass ${i} has ${p.length / 3} points; a pass needs >= 2`);
    for (let k = 0; k < p.length; k++) {
      if (!Number.isFinite(p[k])) fail(`pass ${i} has non-finite coordinate at index ${k}`);
    }
  }
  if (!Number.isFinite(heights.clearanceZ) || !Number.isFinite(heights.retractZ) ||
      !Number.isFinite(heights.feedZ)) {
    fail(`non-finite heights clearanceZ=${heights.clearanceZ} retractZ=${heights.retractZ} feedZ=${heights.feedZ}`);
  }
  if (heights.clearanceZ < heights.retractZ || heights.retractZ < heights.feedZ) {
    fail(`heights must satisfy clearanceZ >= retractZ >= feedZ; got ${heights.clearanceZ}, ${heights.retractZ}, ${heights.feedZ}`);
  }
  if (heights.materialTopZ !== undefined && !Number.isFinite(heights.materialTopZ)) {
    fail(`non-finite materialTopZ ${heights.materialTopZ}`);
  }
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    for (let k = 2; k < p.length; k += 3) {
      if (p[k] > heights.clearanceZ + Z_EPS) {
        fail(`pass ${i} reaches z=${p[k]} above clearanceZ=${heights.clearanceZ}; rapids would gouge`);
      }
      if (p[k] > heights.feedZ + Z_EPS) {
        fail(`pass ${i} reaches z=${p[k]} above feedZ=${heights.feedZ}; feed transition is below the cut`);
      }
    }
  }
  if (!(policy.stepover > 0) || !Number.isFinite(policy.stepover)) {
    fail(`invalid stepover ${policy.stepover}`);
  }
  if (!(policy.cutterContactRadiusMm > 0) || !Number.isFinite(policy.cutterContactRadiusMm)) {
    fail(`invalid cutterContactRadiusMm ${policy.cutterContactRadiusMm}`);
  }
  const ramp = policy.rampAngleDeg ?? DEFAULT_RAMP_ANGLE_DEG;
  if (!(ramp > 0) || !(ramp < 90)) fail(`rampAngleDeg ${ramp} outside (0, 90)`);
  const dev = policy.maxStayDownDeviationZ ?? policy.stepover;
  if (!(dev >= 0) || !Number.isFinite(dev)) fail(`invalid maxStayDownDeviationZ ${dev}`);
  const step = policy.connectorSampleStep ?? policy.stepover / 2;
  if (!(step > 0) || !Number.isFinite(step)) fail(`invalid connectorSampleStep ${step}`);
}

/** xy distance from (px, py) to the segment (ax, ay)-(bx, by). */
function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  let t = 0;
  if (lenSq > 0) {
    t = ((px - ax) * vx + (py - ay) * vy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * How far the WHOLE CUTTER walks out of the corridor the previous pass swept,
 * in mm -- the quantity WO-266 exists to measure, and the one the WO-260
 * reproduction prints as "unproved intrusion".
 *
 * The previous pass swept a corridor of radius r about its centreline, so the
 * ground it PROVED clear reaches r sideways. A connector point c carries the
 * cutter's far edge out to `dist(c, previousPass) + r`. Subtract the proven
 * reach and the excess is exactly `dist(c, previousPass)`: the escape is the
 * connector's own distance from the swept centreline, and the cutter radius
 * cancels. That is why LENGTH is the wrong question and DIRECTION is the right
 * one -- a connector running ALONG the corridor escapes by 0 however long it
 * is, while one running ACROSS it escapes by its full length.
 *
 * Returns an upper bound, computed without sampling: `dist(P(t), segment)` is
 * convex in t, so over the connector the distance to ONE segment peaks at an
 * end. Taking the cheapest segment gives `min_j max_t g_j(t)`, which is >=
 * `max_t min_j g_j(t)`. Erring high can only refuse a link, never accept one.
 * It is EXACT whenever a single segment is nearest at both ends, which is every
 * link between straight passes -- the whole raster regime.
 *
 * The slack costs nothing where it matters. A connector lying ALONG a densely
 * sampled pass is truly contained (escape 0) but scores at most `len / 2` here,
 * because the segment straddling its midpoint sits within `len / 2` of both
 * ends. Connectors are already gated at `len <= 2 * stepover`, so that bound is
 * at most `stepover` -- inside the allowance P1 grants. An along-corridor link
 * is therefore never refused by the approximation, only by the outer gate.
 */
function corridorEscapeMm(
  previousPass: Float64Array,
  ex: number,
  ey: number,
  sx: number,
  sy: number,
): number {
  let escape = Infinity;
  const n = previousPass.length / 3;
  for (let i = 1; i < n; i++) {
    const ax = previousPass[(i - 1) * 3];
    const ay = previousPass[(i - 1) * 3 + 1];
    const bx = previousPass[i * 3];
    const by = previousPass[i * 3 + 1];
    const atStart = pointSegmentDistance(ex, ey, ax, ay, bx, by);
    const atEnd = pointSegmentDistance(sx, sy, ax, ay, bx, by);
    const worst = atStart > atEnd ? atStart : atEnd;
    if (worst < escape) {
      escape = worst;
      if (escape <= Z_EPS) break; // fully contained; nothing can beat it
    }
  }
  return escape;
}

/** Reversed copy of an xyz-triple polyline (never mutates the input). */
function reversedPass(p: Float64Array): Float64Array {
  const n = p.length / 3;
  const out = new Float64Array(p.length);
  for (let j = 0; j < n; j++) {
    const src = (n - 1 - j) * 3;
    out[j * 3] = p[src];
    out[j * 3 + 1] = p[src + 1];
    out[j * 3 + 2] = p[src + 2];
  }
  return out;
}

/**
 * Build a linked IR move program from ordered, pre-sampled surface passes.
 *
 * Link policy: between consecutive passes the builder stays down and feeds
 * along the SAMPLED SURFACE (role 'stepover') only when ALL THREE hold --
 *   1. the connector is SHORT: xy length <= 2 * stepover;
 *   2. the sampled surface stays within maxStayDownDeviationZ of the straight
 *      endpoint-to-endpoint chord (no ridge or valley between the passes); and
 *   3. the territory is PROVEN CLEARED -- see the proof rules P1/P2 on
 *      tryStayDown (WO-127).
 * Otherwise it retracts to the TRAVERSE PLANE (or, on a proven material top,
 * only to that top + standoff -- WO-2210), rapids over, descends to the entry height
 * and ramp-leads into the next pass.
 *
 * Traverse plane (WO-127): `max(clearanceZ, materialTopZ + standoff)` when the
 * caller proved a material top, else the authored clearanceZ. Lateral rapids
 * run at that plane; the only downward rapid stops at feedZ, or at
 * min(feedZ, materialTopZ + standoff) when a top is proven (WO-2210).
 *
 * Stay-down links are NOT lifted wholesale -- that is the overcorrection Operator
 * ruled out twice in WO-096. They are gated instead: a link the engine can
 * prove crosses cleared ground is kept exactly as it was (a FEED move at
 * cutting feedrate on the cutter-location surface), and only an UNPROVABLE one
 * is routed over the traverse plane by the ordinary retract path. At the
 * stepovers finishing actually uses, a raster connector crosses the swept
 * corridor by exactly one stepover and proof P1 holds for it, so the feature is
 * untouched; what P1 now refuses is the connector that walks the cutter FURTHER
 * out than the operation's own bite (WO-266).
 *
 * Lead-in (WO-2209): descends from the entry height at rampAngleDeg along the pass
 * polyline and ENDS on the pass's first sample (role 'lead_in'), so every
 * pass is cut from its first sample to its last -- see enterViaRetract. If
 * the pass is too short for any ramp, the entry degenerates to a vertical
 * plunge (flagged by role 'plunge' on the surface-touching feed move).
 */
export async function buildLinkedPath(
  passes: readonly Float64Array[],
  heights: PathBuildHeights,
  policy: LinkPolicy,
  sampleSurface: ConnectorSampler,
): Promise<IrMove[]> {
  validateInputs(passes, heights, policy);
  const { clearanceZ, feedZ } = heights;
  // The lateral traverse plane, floored on PROVEN MATERIAL rather than the
  // part. Links between passes and entry rapids stop lower only on a proven material
  // top (WO-2210, see enterViaRetract).
  const traverseZ =
    heights.materialTopZ === undefined
      ? clearanceZ
      : Math.max(clearanceZ, heights.materialTopZ + TRAVERSE_STANDOFF_MM);
  const stepover = policy.stepover;
  const cutterR = policy.cutterContactRadiusMm;
  /**
   * The furthest a stay-down link may walk the cutter out of proven-cleared
   * ground (mm). See proof P1 on tryStayDown for why it is these two terms.
   */
  const maxUnprovenBiteMm = Math.min(stepover, cutterR);
  const materialTopZ = heights.materialTopZ;
  /**
   * WO-2210: the low re-entry plane -- the proven material top plus the
   * traverse standoff. Undefined when no material top is proven; every link
   * then goes over `traverseZ` exactly as before. See enterViaRetract.
   */
  const lowLinkZ = materialTopZ === undefined ? undefined : materialTopZ + TRAVERSE_STANDOFF_MM;
  const rampTan = Math.tan(((policy.rampAngleDeg ?? DEFAULT_RAMP_ANGLE_DEG) * Math.PI) / 180);
  const maxDev = policy.maxStayDownDeviationZ ?? stepover;
  const sampleStep = policy.connectorSampleStep ?? stepover / 2;
  const zigzag = policy.zigzag ?? true;
  /**
   * WO-2405: the lowest z any pass cuts. A stay-down link never feeds below it.
   * A strategy with a finish-depth floor clips its passes AT that floor
   * (`clipParallelPassesAtMinZ`), so where the surface lies below the floor the
   * pass points sit exactly on it -- but the link between two clipped pieces is
   * sampled on the raw surface and used to dip under it (WO-2378: Z 4.985 vs a
   * resolved bottom of 5.114), which the saved-toolpath height check rightly
   * calls outdated and Post will not write. Every pass point is at or above the
   * operation's floor, so this is too.
   *
   * DECIDE AND LOG (LIENCAM rule 3, WO-2405): CLAMP, not retract. A link point
   * raised to this z is above the drop surface there (the clamp only raises),
   * so it touches nothing; the stay-down / retract decision is still made on
   * the raw surface exactly as before, so no link that stayed down now retracts
   * and none that retracted now stays down. Without a floor the clamp rarely
   * acts: on the wave gate fixture it raised three overrun-band link points by
   * 0.0026 mm and left every other move, and every pencil/scallop pin, as it was.
   */
  let linkFloorZ = Infinity;
  for (const p of passes) {
    for (let k = 2; k < p.length; k += 3) if (p[k] < linkFloorZ) linkFloorZ = p[k];
  }

  const oriented: Float64Array[] = new Array<Float64Array>(passes.length);
  for (let i = 0; i < passes.length; i++) {
    oriented[i] = zigzag && i % 2 === 1 ? reversedPass(passes[i]) : passes[i];
  }

  const moves: IrMove[] = [];
  // Current position; NaN until the first move (NaN === x is false, so the
  // duplicate-move suppression never swallows the first move).
  let px = NaN;
  let py = NaN;
  let pz = NaN;
  const push = (t: 'rapid' | 'feed', x: number, y: number, z: number, role: IrMove['role']): void => {
    if (px === x && py === y && pz === z) return; // zero-length: skip
    moves.push({ t, x, y, z, role });
    px = x;
    py = y;
    pz = z;
  };

  const emitCuts = (pass: Float64Array, fromIndex: number): void => {
    const n = pass.length / 3;
    for (let j = fromIndex; j < n; j++) {
      push('feed', pass[j * 3], pass[j * 3 + 1], pass[j * 3 + 2], 'cut');
    }
  };

  /**
   * Retract entry: lift, rapid over, rapid to the entry height (Feed Height, or
   * lower on a proven material top -- WO-2210 below), lead in, then cut
   * the WHOLE pass from its first sample to its last (WO-2209).
   *
   * WO-2206 measured the defect this closes: the ramp used to start over the
   * pass start and descend FORWARD along the pass, and the samples under it
   * were replaced by ramp vertices riding above the surface -- cutting began
   * only after touchdown. On the portrait relief 53.5 % of the pass length was
   * never cut, and after a rough that stretch kept the rough's stock-to-leave.
   *
   * Every lead-in below now ENDS on pass sample 0, at its surface z, before the
   * first cut move, so `emitCuts(pass, 1)` always cuts the whole pass:
   *   - reverse ramp (normal case): the rapid descent lands over the pass at
   *     the arc length where the ramp line from the start reaches the entry height,
   *     and the ramp descends BACK along the pass onto the start;
   *   - ramp and return (pass shorter than the reverse ramp, but the forward
   *     ramp line still meets a rising surface): the old forward ramp, then
   *     feed back along the pass surface to the start;
   *   - vertical plunge at the start (neither fits), exactly as before.
   * DECIDE AND LOG (LIENCAM rule 3, WO-2209): the reverse ramp is chosen over
   * ramp-and-return everywhere it fits because it rides the stretch once, not
   * three times; the fallback exists so no pass that used to ramp now plunges.
   *
   * Gouge and bite: every lead-in vertex sits on the pass's own xy polyline at
   * a z no lower than the pass sample there, and the top point sits at Feed
   * Height (>= every pass z). Lead-in z and the pass chord are both linear per
   * segment, so a segment at or above the surface at both ends is at or above
   * it throughout -- the same rule the passes obey. Running on the pass's own
   * line at or above its surface, the lead-in meets only material the pass
   * itself is about to cut: it takes no bite the operation does not already
   * take, which is the argument the forward ramp always rested on.
   *
   * Low re-entry (WO-2210). WO-2206 measured 219 s of a 483 s portrait finish
   * in these entries: each link climbed to the traverse plane and each ramp
   * started at Feed Height, 5 mm above a stock top the builder had already
   * PROVEN. When `materialTopZ` is proven, a link between passes lifts only to
   * `lowLinkZ` (that top + TRAVERSE_STANDOFF_MM), and the entry rapid stops at
   * `entryZ = min(feedZ, lowLinkZ)`; the ramp above starts there instead of at
   * Feed Height. Nothing of the stock stands above the proven top, so the
   * lateral leg and the rapid descent meet only air, with the standoff under
   * them -- the same proof the traverse plane itself rests on. The plane is
   * never raised (lowLinkZ <= traverseZ) and never under the proof. It is used
   * only where it stands at or above both the previous pass end and every sample
   * of the pass being entered, so the lift is a lift and the ramp's top point is
   * above the whole pass, which is all the gouge argument above needs. Otherwise,
   * and whenever no top is proven, the entry is exactly the traverse-plane one.
   * An authored Feed Height already below `lowLinkZ` is kept: this only lowers.
   * The first approach and the final retract stay on the traverse plane.
   * Workholding is not this module's to see: the tool-reach seam every 3D path
   * leaves through raises any non-cutting move over it (WO-1577).
   */
  const enterViaRetract = (pass: Float64Array): void => {
    const x0 = pass[0];
    const y0 = pass[1];
    const z0 = pass[2];
    if (feedZ < z0 - Z_EPS) {
      fail(`feedZ ${feedZ} below pass entry z ${z0}; the entry would gouge`);
    }
    let passTopZ = -Infinity;
    for (let k = 2; k < pass.length; k += 3) if (pass[k] > passTopZ) passTopZ = pass[k];
    const low =
      lowLinkZ !== undefined && lowLinkZ >= passTopZ - Z_EPS && (!Number.isFinite(pz) || lowLinkZ >= pz - Z_EPS);
    const liftZ = low ? (lowLinkZ as number) : traverseZ;
    const entryZ = low ? Math.min(feedZ, lowLinkZ as number) : feedZ;
    /**
     * Straight up, over, and down to the entry height at (x, y): over `liftZ`
     * from the previous pass, over the traverse plane on the first approach.
     */
    const descendAt = (x: number, y: number): void => {
      if (Number.isFinite(pz)) {
        push('rapid', px, py, liftZ, 'rapid');
        push('rapid', x, y, liftZ, 'rapid');
      } else {
        push('rapid', x, y, traverseZ, 'rapid');
      }
      push('rapid', x, y, entryZ, 'rapid');
    };
    if (entryZ <= z0 + Z_EPS) {
      // Entry height already at (or within eps of) the surface: nothing to ramp.
      descendAt(x0, y0);
      emitCuts(pass, 1);
      return;
    }

    const n = pass.length / 3;
    // Cumulative xy arc length to each vertex, for the ramp lines.
    const cum = new Float64Array(n);
    for (let j = 1; j < n; j++) {
      const dx = pass[j * 3] - pass[(j - 1) * 3];
      const dy = pass[j * 3 + 1] - pass[(j - 1) * 3 + 1];
      cum[j] = cum[j - 1] + Math.sqrt(dx * dx + dy * dy);
    }

    // Reverse ramp: rampZ(d) = z0 + tan(angle) * d reaches the entry height at
    // d = rampRun. Its top point T lies on the pass at that arc length.
    const rampRun = (entryZ - z0) / rampTan;
    if (cum[n - 1] >= rampRun - Z_EPS) {
      let k = 1;
      while (k < n - 1 && cum[k] < rampRun) k++;
      const segLen = cum[k] - cum[k - 1];
      const t = segLen > 0 ? Math.min(1, (rampRun - cum[k - 1]) / segLen) : 1;
      const tx = pass[(k - 1) * 3] + (pass[k * 3] - pass[(k - 1) * 3]) * t;
      const ty = pass[(k - 1) * 3 + 1] + (pass[k * 3 + 1] - pass[(k - 1) * 3 + 1]) * t;
      descendAt(tx, ty);
      // Back down the pass: on the ramp line, or ON the surface wherever the
      // surface stands above it, ending exactly on sample 0.
      for (let j = k - 1; j >= 1; j--) {
        const surfaceZ = pass[j * 3 + 2];
        push('feed', pass[j * 3], pass[j * 3 + 1], Math.max(z0 + rampTan * cum[j], surfaceZ), 'lead_in');
      }
      push('feed', x0, y0, z0, 'lead_in');
      emitCuts(pass, 1);
      return;
    }

    // Forward ramp: touchdown = first vertex where rampZ(d) = entryZ - tan * d
    // has reached the surface.
    let touch = -1;
    for (let j = 1; j < n; j++) {
      if (entryZ - rampTan * cum[j] <= pass[j * 3 + 2] + Z_EPS) {
        touch = j;
        break;
      }
    }
    descendAt(x0, y0);
    if (touch < 0) {
      // Pass shorter than the ramp needs: degenerate vertical plunge to the
      // entry point (flagged by the 'plunge' role), then cut the whole pass.
      push('feed', x0, y0, z0, 'plunge');
      emitCuts(pass, 1);
      return;
    }
    // Ramp vertices strictly before touchdown ride the ramp line (above the
    // surface there -- the loop above did not fire); touchdown lands ON the
    // pass sample. Then feed back along the surface to sample 0 so the cut
    // starts at the pass start.
    for (let j = 1; j < touch; j++) {
      push('feed', pass[j * 3], pass[j * 3 + 1], entryZ - rampTan * cum[j], 'lead_in');
    }
    for (let j = touch; j >= 0; j--) {
      push('feed', pass[j * 3], pass[j * 3 + 1], pass[j * 3 + 2], 'lead_in');
    }
    emitCuts(pass, 1);
  };

  /**
   * Try a stay-down link from the current position (= previous pass end) to
   * the start of `pass`. Emits the link moves and returns true on success;
   * emits nothing and returns false when the policy says retract -- and a
   * retract routes over `traverseZ`, which is floored on proven material.
   *
   * CLEARED-TERRITORY PROOF (WO-127 fix round, finding 2). Operator's rule binds
   * low LINKS as well as rapids: "A low link is legal only where the engine
   * KNOWS the territory is cleared", and "the check is against IN-PROCESS
   * STOCK, not against the part". Being a feed move is not that proof --
   * feeding into full-height uncleared stock at finishing feedrate is a
   * machining-load failure even though it cannot gouge the part. This builder
   * has exactly two things it can actually PROVE, and a link needs one of them:
   *
   *   (P1) THE CUTTER'S OWN SWEPT CORRIDOR, MEASURED ON THE WHOLE CUTTER
   *        (WO-266). Cutting the previous pass drove the tool body through a
   *        corridor of radius `cutterContactRadiusMm` about it. The test used
   *        to be `len <= cutterContactRadiusMm`, which proves only that the
   *        connector's CENTRELINE stays inside that corridor -- and the tool is
   *        not its centreline. `corridorEscapeMm` measures the real quantity:
   *        how far the cutter's far edge reaches past the ground the previous
   *        pass proved clear. It is 0 along the corridor and `len` across it,
   *        so DIRECTION now decides, which is the defect this proof closes:
   *        a 3 mm-radius cutter on a 2.5 mm perpendicular link used to pass
   *        (2.5 <= 3) while cutting 2.5 mm into ground nothing proved empty.
   *
   *        A zero escape is FULL containment and needs no further argument.
   *        A nonzero escape is allowed only up to `min(stepover, r)`:
   *          - `stepover`, because that escape is the depth of cut the link
   *            takes into unproven ground, and the operation is already taking
   *            exactly that bite on every pass. A link may not cut deeper than
   *            the pass it is linking to. (What it cuts is also ground the very
   *            next pass is about to sweep, so it removes nothing extra.)
   *          - `r`, because at an escape of r the cutter's CENTRE reaches the
   *            edge of the proven corridor: the move is a full slot, and no
   *            appeal to the operation's own stepover excuses that. This is the
   *            term that keeps a coarse stepover with a small cutter out.
   *        Both terms are the operation's own numbers, not a tuned constant.
   *
   *        DECIDE AND LOG (LIENCAM rule 3, WO-266). Pure containment -- escape
   *        must be 0 -- is the stricter reading, and it is not shipped: with
   *        the stepover perpendicular to the passes, EVERY raster link escapes
   *        by exactly the stepover, so containment refuses all of them. It was
   *        measured on real parts at 4 configurations and cost 130 of the 130
   *        stay-down links, converting each into a retract; on the unproven
   *        stock-top path those retracts are lateral rapids at the authored
   *        clearance. That is the wholesale lift of Stay Down Operator ruled out
   *        twice in WO-096, so the bound above is what ships. Reversing this
   *        decision is one line: set `maxUnprovenBiteMm` to 0.
   *
   *   (P2) ABOVE ALL PROVEN MATERIAL. If a proven `materialTopZ` exists and the
   *        WHOLE connector -- both endpoints and every sampled interior point --
   *        rides at or above it, the tool (which occupies only z >= its tip)
   *        meets nothing at all. This is what keeps stay-down alive when
   *        surfacing a slab whose top face IS the stock top, even at a stepover
   *        coarser than the cutter radius.
   *
   * With neither proof the link is UNPROVABLE and must retract over the
   * clearance plane. Note P1 needs no stock model and no store wiring: the
   * cutter physically swept that corridor whether or not anyone told us where
   * the stock top is, so the common finishing case (a connector that is one
   * stepover across and otherwise runs along the corridor) keeps every link it
   * had. Stay Down stays a feature.
   */
  const tryStayDown = async (
    pass: Float64Array,
    previousPass: Float64Array,
  ): Promise<boolean> => {
    const sx = pass[0];
    const sy = pass[1];
    const sz = pass[2];
    // Snapshot the connector origin: push() advances px/py/pz while the
    // commit loop below emits, so interpolation must use the frozen start.
    const ex = px;
    const ey = py;
    const ez = pz;
    const dx = sx - ex;
    const dy = sy - ey;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 2 * stepover + Z_EPS) return false; // long connector: retract
    if (len === 0) {
      // Shared endpoint: continue directly (a z jump at identical xy would
      // be a vertical move against the surface -- only allow exact match).
      // Zero lateral travel crosses no territory at all, so P1 holds trivially.
      return pz === sz;
    }
    // P1 (WO-266): how far does the WHOLE CUTTER walk out of the corridor the
    // previous pass swept, and is that bite one this operation already takes?
    // `escapeMm` is 0 for a connector running along the corridor and equals its
    // length for one running across it -- the direction blindness WO-266 exists
    // to close. When P1 holds no z floor applies (-Infinity); when it does not,
    // P2 is the only proof left, so the whole connector must ride at or above
    // the proven material top.
    const escapeMm = corridorEscapeMm(previousPass, ex, ey, sx, sy);
    const insideSweptCorridor = escapeMm <= maxUnprovenBiteMm + Z_EPS;
    let provenFloorZ = -Infinity;
    if (!insideSweptCorridor) {
      // Reject before sampling when P2 cannot apply at all (no proven material
      // top, or an endpoint already below it) -- an unprovable link costs no
      // surface queries, exactly like a too-long one.
      if (materialTopZ === undefined) return false;
      provenFloorZ = materialTopZ;
      if (ez < provenFloorZ - Z_EPS || sz < provenFloorZ - Z_EPS) return false;
    }
    const nSeg = Math.max(1, Math.ceil(len / sampleStep - Z_EPS));
    let zs: Float64Array | null = null;
    if (nSeg > 1) {
      const xy = new Float64Array((nSeg - 1) * 2);
      for (let i = 1; i < nSeg; i++) {
        const t = i / nSeg;
        xy[(i - 1) * 2] = ex + dx * t;
        xy[(i - 1) * 2 + 1] = ey + dy * t;
      }
      zs = await sampleSurface(xy);
      if (zs.length !== nSeg - 1) {
        fail(`connector sampler returned ${zs.length} z values for ${nSeg - 1} points`);
      }
      for (let i = 1; i < nSeg; i++) {
        const z = zs[i - 1];
        if (!Number.isFinite(z)) fail(`connector sampler returned non-finite z ${z}`);
        if (z > clearanceZ + Z_EPS) {
          fail(`connector surface z=${z} above clearanceZ=${clearanceZ}`);
        }
        const chord = ez + (sz - ez) * (i / nSeg);
        if (Math.abs(z - chord) > maxDev) return false; // ridge/valley: retract
        // P2 (the connector left the swept corridor): every interior point must
        // also ride at or above the proven material top, or the territory is
        // unproven and the link retracts. No-op under P1 (floor -Infinity).
        if (z < provenFloorZ - Z_EPS) return false;
      }
    }
    // Commit: feed along the sampled surface (each interior move endpoint is
    // exactly the drop z at its xy, raised to `linkFloorZ` where the surface
    // lies below every pass -- WO-2405), ending on the next pass's first sample.
    if (zs !== null) {
      for (let i = 1; i < nSeg; i++) {
        push('feed', ex + dx * (i / nSeg), ey + dy * (i / nSeg), Math.max(zs[i - 1], linkFloorZ), 'stepover');
      }
    }
    push('feed', sx, sy, sz, 'stepover');
    return true;
  };

  for (let i = 0; i < oriented.length; i++) {
    const pass = oriented[i];
    if (i === 0) {
      enterViaRetract(pass);
      continue;
    }
    if (await tryStayDown(pass, oriented[i - 1])) {
      emitCuts(pass, 1); // link already ended on pass sample 0
    } else {
      enterViaRetract(pass);
    }
  }
  // Final retract: leave the tool at a safe traverse level.
  push('rapid', px, py, traverseZ, 'rapid');
  return moves;
}
