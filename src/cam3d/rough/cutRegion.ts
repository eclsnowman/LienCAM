// cam3d rough: per-level CUT REGION geometry -- the crux of stage A1.
//
// At a Z level the cut region is the plan-view area a rougher must still clear:
//   cutRegion(z) = (stock cross-section at z) MINUS (part cross-section at z)
// The stock cross-section is the conservative remainingAbove() cell union. The
// part cross-section interpolates crossings between sampled column heights so
// curved walls retain their sub-cell shape. Both use the geom2d ring convention
// (CCW outers, CW holes).
//
// radialStockToLeave grows the PART section OUTWARD before the difference
// (leaving a radial skin of stock on the part walls). It is NOT tool radius --
// the clearer applies tool-radius offset later; adding it here would double it.
//
// decomposeToComponents splits the flat ring set into bounded components (one
// CCW outer with the CW holes inside it), so a later stage can hand the clearer
// ONE compartment at a time -- the hard design constraint "bounded per-
// compartment regions, never one giant merged region".

import { boolean, offset, area, type Ring } from '../geom2d';
import { validateRings } from '../geom2d/rings';
import { cam3dAdapter, createGeometryService, fromRings, toRings, type Result } from '../../kernel/geometry';
import type { ZDexelField } from '../stock';
import { EPS_ABOVE, remainingAbove } from '../stock';
import type { CutterSpec, GeometryKernel, MeshHandle } from '../kernel/types';

// WO-2998: the stock/part offsets and the stock-minus-part difference go
// through the kernel geometry service's cam3d adapter over the UNCHANGED
// geom2d module (never the reverse, which would recurse). geom2d's own
// validation runs first so every native exception keeps today's message; the
// facade then has nothing to skip, and any result it does not fully support
// is rethrown rather than replaced by another engine.
const geometry = createGeometryService(cam3dAdapter({ offset, boolean }));
const closedPaths = (rings: readonly Ring[]) =>
  fromRings(rings).map((points, i) => ({ id: `ring-${i}`, closed: true, points }));
function supportedRings(result: Result<ReturnType<typeof fromRings>>): Ring[] {
  if (result.status !== 'supported' || !result.value) {
    throw new Error(result.diagnostics.map(d => d.message).join('; '));
  }
  return toRings(result.value);
}
function serviceOffset(rings: readonly Ring[], delta: number): Ring[] {
  validateRings(rings, 'offset input');
  return supportedRings(geometry.offset(closedPaths(rings), delta, { join: 'round' }));
}
function serviceDifference(a: readonly Ring[], b: readonly Ring[]): Ring[] {
  validateRings(a, 'boolean(difference) subject');
  validateRings(b, 'boolean(difference) clip');
  return supportedRings(geometry.boolean(closedPaths(a), closedPaths(b), 'difference'));
}

interface IsoPoint {
  x: number;
  y: number;
  key: string;
  subcell: boolean;
}

interface IsoSegment {
  a: IsoPoint;
  b: IsoPoint;
  used: boolean;
}

interface InterpolatedRing {
  ring: Ring;
  hasSubcellCrossing: boolean;
}

/**
 * Interpolate the part's sampled height field at z instead of returning the
 * union-of-grid-cells staircase from remainingAbove(). The part field samples
 * the actual top surface at column centres, so a smooth slope contains the
 * sub-cell crossing that the binary mask discards.
 *
 * A vertical discontinuity is different: interpolation between a floor and a
 * wall top would make the wall move sideways as z changes. Empty-to-solid
 * edges and slopes steeper than 4:1 therefore cross at the cell midpoint, the
 * same unbiased location as the block trace. One mirrored sample is padded
 * around the field so contours which meet the frame close exactly on its edge.
 */
function interpolatedPartSection(
  field: ZDexelField,
  z: number,
  locate?: (point: IsoPoint, ax: number, ay: number, bx: number, by: number, highA: boolean, frameEdge: boolean) => IsoPoint,
): InterpolatedRing[] {
  const level = z + EPS_ABOVE;
  const pxCount = field.nx + 2;
  const pyCount = field.ny + 2;
  const values = new Float64Array(pxCount * pyCount);
  const material = new Uint8Array(pxCount * pyCount);
  const actual = new Uint8Array(pxCount * pyCount);
  const index = (px: number, py: number): number => py * pxCount + px;

  for (let py = 0; py < pyCount; py++) {
    for (let px = 0; px < pxCount; px++) {
      const i = Math.max(0, Math.min(field.nx - 1, px - 1));
      const j = Math.max(0, Math.min(field.ny - 1, py - 1));
      const source = field.colIndex(i, j);
      const at = index(px, py);
      const isActual = px > 0 && px <= field.nx && py > 0 && py <= field.ny;
      const top = field.top[source];
      const hasMaterial = top > field.bottom[source];
      actual[at] = isActual ? 1 : 0;
      material[at] = isActual && hasMaterial ? 1 : 0;
      // A mirrored exterior value puts a high edge sample's crossing halfway
      // to the virtual sample: exactly on the field/stock frame boundary.
      values[at] = isActual || top <= level ? top : 2 * level - top;
    }
  }

  const xAt = (px: number): number => field.originX + (px - 0.5) * field.cell;
  const yAt = (py: number): number => field.originY + (py - 0.5) * field.cell;
  const edgePoint = (
    a: number,
    b: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    key: string,
  ): IsoPoint => {
    const av = values[a];
    const bv = values[b];
    const steep = Math.abs(bv - av) > 4 * field.cell;
    const discontinuous = !actual[a] || !actual[b] || !material[a] || !material[b];
    const denominator = bv - av;
    const subcell = !discontinuous && !steep && Math.abs(denominator) > 1e-12;
    const t = subcell
      ? Math.max(0, Math.min(1, (level - av) / denominator))
      : 0.5;
    const point = { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, key, subcell };
    return locate ? locate(point, ax, ay, bx, by, av > level, !actual[a] || !actual[b]) : point;
  };

  const segments: IsoSegment[] = [];
  for (let py = 0; py < pyCount - 1; py++) {
    for (let px = 0; px < pxCount - 1; px++) {
      const bl = index(px, py);
      const br = index(px + 1, py);
      const tl = index(px, py + 1);
      const tr = index(px + 1, py + 1);
      // Most cells lie wholly above or below the level. Skip them before any
      // edge keys are built: those strings dominated every section (WO-2096).
      const blHigh = values[bl] > level;
      if (blHigh === (values[br] > level) && blHigh === (values[tl] > level)
        && blHigh === (values[tr] > level)) continue;
      const corners = [bl, br, tr, tl] as const;
      const edgeDefs = [
        [bl, br, xAt(px), yAt(py), xAt(px + 1), yAt(py), `h:${py}:${px}`],
        [br, tr, xAt(px + 1), yAt(py), xAt(px + 1), yAt(py + 1), `v:${py}:${px + 1}`],
        [tl, tr, xAt(px), yAt(py + 1), xAt(px + 1), yAt(py + 1), `h:${py + 1}:${px}`],
        [bl, tl, xAt(px), yAt(py), xAt(px), yAt(py + 1), `v:${py}:${px}`],
      ] as const;
      const crossings: IsoPoint[] = [];
      for (const [a, b, ax, ay, bx, by, key] of edgeDefs) {
        if ((values[a] > level) !== (values[b] > level)) {
          crossings.push(edgePoint(a, b, ax, ay, bx, by, key));
        }
      }
      if (crossings.length === 2) {
        segments.push({ a: crossings[0], b: crossings[1], used: false });
      } else if (crossings.length === 4) {
        // Asymptotic-decider style deterministic saddle resolution. High
        // centre means the two low corners remain separate, and vice versa.
        const centerHigh = corners.reduce((sum, corner) => sum + values[corner], 0) / 4 > level;
        const pairs = centerHigh ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];
        for (const [a, b] of pairs) {
          segments.push({ a: crossings[a], b: crossings[b], used: false });
        }
      }
    }
  }
  if (segments.length === 0) return [];

  const byKey = new Map<string, number[]>();
  const addKey = (key: string, segmentIndex: number): void => {
    const entries = byKey.get(key);
    if (entries) entries.push(segmentIndex);
    else byKey.set(key, [segmentIndex]);
  };
  segments.forEach((segment, segmentIndex) => {
    addKey(segment.a.key, segmentIndex);
    addKey(segment.b.key, segmentIndex);
  });

  const raw: InterpolatedRing[] = [];
  for (let startIndex = 0; startIndex < segments.length; startIndex++) {
    if (segments[startIndex].used) continue;
    const start = segments[startIndex];
    let point = start.a;
    const startKey = point.key;
    const coordinates: number[] = [point.x, point.y];
    let hasSubcellCrossing = point.subcell;
    let segmentIndex = startIndex;
    for (;;) {
      const segment = segments[segmentIndex];
      segment.used = true;
      point = segment.a.key === point.key ? segment.b : segment.a;
      hasSubcellCrossing ||= point.subcell;
      if (point.key === startKey) break;
      coordinates.push(point.x, point.y);
      const next = (byKey.get(point.key) ?? []).find((candidate) => !segments[candidate].used);
      if (next === undefined) {
        throw new Error('cutRegionAt: interpolated part contour produced an open chain.');
      }
      segmentIndex = next;
    }
    if (coordinates.length >= 6) {
      raw.push({ ring: Float64Array.from(coordinates), hasSubcellCrossing });
    }
  }

  // Segment stitching is intentionally undirected. Restore the geom2d winding
  // contract from containment depth: even nesting = outer/CCW, odd = hole/CW.
  return raw.map(({ ring, hasSubcellCrossing }, ringIndex) => {
    let depth = 0;
    for (let other = 0; other < raw.length; other++) {
      if (other !== ringIndex && pointInRing(raw[other].ring, ring[0], ring[1])) depth++;
    }
    const wantPositive = depth % 2 === 0;
    if ((area(ring) > 0) === wantPositive) return { ring, hasSubcellCrossing };
    const reversed = new Float64Array(ring.length);
    const count = ring.length / 2;
    for (let i = 0; i < count; i++) {
      reversed[2 * i] = ring[2 * (count - 1 - i)];
      reversed[2 * i + 1] = ring[2 * (count - 1 - i) + 1];
    }
    return { ring: reversed, hasSubcellCrossing };
  });
}

/** Keep the dome branch's exact location for a single coherent model wall.
 * Multi-ring sections are the expensive corpus case: their interpolated
 * crossings already preserve topology, while exact refinement multiplied the
 * kernel work across every island and level. */
export function partSectionNeedsModelLocation(field: ZDexelField, z: number): boolean {
  const sections = interpolatedPartSection(field, z);
  return sections.length === 1;
}

/** Locate section crossings on the immutable model, including vertical walls.
 * The height grid supplies topology and brackets, not the final wall positions.
 * In particular, a floor/wall discontinuity must not become a staircase of
 * artificial concave corners that the adaptive walker repeatedly re-enters. */
export async function modelPartSection(
  kernel: GeometryKernel,
  mesh: MeshHandle,
  field: ZDexelField,
  probe: CutterSpec,
  z: number,
  xyTolerance: number,
  signal?: AbortSignal,
): Promise<Ring[]> {
  if (!(xyTolerance > 0) || !Number.isFinite(xyTolerance)) throw new Error('modelPartSection: invalid tolerance');
  const brackets = new Map<string, { ax: number; ay: number; bx: number; by: number; highA: boolean }>();
  const discontinuousKeys = new Set<string>();
  interpolatedPartSection(field, z, (point, ax, ay, bx, by, highA, frameEdge) => {
    if (!frameEdge) {
      brackets.set(point.key, { ax, ay, bx, by, highA });
      if (!point.subcell) discontinuousKeys.add(point.key);
    }
    return point;
  });
  if (!brackets.size) return interpolatedPartSection(field, z).map(section => section.ring);
  const entries = [...brackets.entries()];
  const steps = Math.max(0, Math.ceil(Math.log2(field.cell / xyTolerance)));
  const zSeed = field.bottom.reduce((lowest, bottom) => Math.min(lowest, bottom), z) - 1;
  const cutter = kernel.makeCutter(probe);
  try {
    for (let step = 0; step < steps; step++) {
      const xy = Float64Array.from(entries.flatMap(([, edge]) => [(edge.ax + edge.bx) / 2, (edge.ay + edge.by) / 2]));
      const heights = await kernel.dropPoints(mesh, cutter, xy, zSeed,
        signal ? { signal } : undefined);
      for (let i = 0; i < entries.length; i++) {
        const edge = entries[i][1];
        if ((heights[i] > z + EPS_ABOVE) === edge.highA) { edge.ax = xy[2 * i]; edge.ay = xy[2 * i + 1]; }
        else { edge.bx = xy[2 * i]; edge.by = xy[2 * i + 1]; }
      }
    }
    const rings = interpolatedPartSection(field, z, (point) => {
      const edge = brackets.get(point.key);
      // Keep the proven exterior end of the bracket, within xyTolerance.
      return edge ? { ...point, x: edge.highA ? edge.bx : edge.ax, y: edge.highA ? edge.by : edge.ay, subcell: true } : point;
    }).map(section => section.ring);
    const discontinuousPoints = new Set([...discontinuousKeys].flatMap((key) => {
      const edge = brackets.get(key);
      if (!edge) return [];
      const x = edge.highA ? edge.bx : edge.ax;
      const y = edge.highA ? edge.by : edge.ay;
      return [`${x},${y}`];
    }));

    // Two exact edge crossings do not prove the chord between them. A rounded
    // square corner can live wholly inside that cell. Locate the intervening
    // surface along the chord normal and subdivide until its deviation is
    // bounded. This refines MODEL geometry before toolpath planning.
    type Point = { x: number; y: number };
    type Segment = { a: Point; b: Point; refine: boolean; children?: [Segment, Segment] };
    const trees: Segment[][] = rings.map(ring => Array.from({ length: ring.length / 2 }, (_, i) => ({
      a: { x: ring[2 * i], y: ring[2 * i + 1] },
      b: { x: ring[(2 * i + 2) % ring.length], y: ring[(2 * i + 3) % ring.length] },
      refine: discontinuousPoints.has(`${ring[2 * i]},${ring[2 * i + 1]}`)
        && discontinuousPoints.has(`${ring[(2 * i + 2) % ring.length]},${ring[(2 * i + 3) % ring.length]}`),
    })));
    const maxX = field.originX + field.nx * field.cell, maxY = field.originY + field.ny * field.cell;
    const onFrame = ({ a, b }: Segment): boolean =>
      (a.x === b.x && (a.x === field.originX || a.x === maxX))
      || (a.y === b.y && (a.y === field.originY || a.y === maxY));
    let pending = trees.flat().filter(segment => segment.refine && !onFrame(segment));
    for (let depth = 0; depth < 12 && pending.length; depth++) {
      const candidates = pending.flatMap(segment => {
        const { a, b } = segment;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length <= xyTolerance) return [];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const distance = Math.min(field.cell, Math.max(length, xyTolerance * 4));
        const nx = (b.y - a.y) / length, ny = -(b.x - a.x) / length;
        return [{ segment, mid,
          inside: { x: mid.x - nx * distance, y: mid.y - ny * distance },
          outside: { x: mid.x + nx * distance, y: mid.y + ny * distance } }];
      });
      if (!candidates.length) { pending = []; break; }
      const ends = Float64Array.from(candidates.flatMap(c => [c.inside.x, c.inside.y, c.outside.x, c.outside.y]));
      const endHeights = await kernel.dropPoints(mesh, cutter, ends, zSeed, signal ? { signal } : undefined);
      // Close neighbors can make a normal cross a second wall. Such a normal
      // is not an unambiguous bracket; retain the original local section there.
      const valid = candidates.filter((_, i) => endHeights[2 * i] > z + EPS_ABOVE && endHeights[2 * i + 1] <= z + EPS_ABOVE);
      const normalSteps = Math.max(0, Math.ceil(Math.log2(8 * field.cell / xyTolerance)));
      for (let iteration = 0; iteration < normalSteps && valid.length; iteration++) {
        const xy = Float64Array.from(valid.flatMap(c => [(c.inside.x + c.outside.x) / 2, (c.inside.y + c.outside.y) / 2]));
        const heights = await kernel.dropPoints(mesh, cutter, xy, zSeed, signal ? { signal } : undefined);
        for (let i = 0; i < valid.length; i++) {
          const point = { x: xy[2 * i], y: xy[2 * i + 1] };
          if (heights[i] > z + EPS_ABOVE) valid[i].inside = point;
          else valid[i].outside = point;
        }
      }
      pending = [];
      for (const c of valid) {
        if (Math.hypot(c.mid.x - c.outside.x, c.mid.y - c.outside.y) <= xyTolerance) continue;
        const children: [Segment, Segment] = [
          { a: c.segment.a, b: c.outside, refine: true },
          { a: c.outside, b: c.segment.b, refine: true },
        ];
        c.segment.children = children;
        pending.push(...children);
      }
    }
    if (pending.length) throw new Error('modelPartSection: model curve refinement did not converge');
    return trees.map(tree => {
      const points: number[] = [];
      const append = (segment: Segment): void => {
        if (segment.children) { append(segment.children[0]); append(segment.children[1]); }
        else points.push(segment.a.x, segment.a.y);
      };
      tree.forEach(append);
      return Float64Array.from(points);
    });
  } finally {
    kernel.releaseCutter(cutter);
  }
}

/**
 * Match interpolated rings to the legacy topology and preserve all
 * stock-coincident frame edges. Internal rings use their interpolated
 * coordinates when expanding to the quantized block area would move points by
 * more than a small fraction of one source cell. Large outward corrections
 * replace the interpolated surface with block-quantization bias; legacy
 * contractions and sub-cell corrections retain the audited safety behavior.
 * An ambiguous topology falls back as a whole.
 */
function matchSectionRings(section: InterpolatedRing[], block: Ring[], field: ZDexelField): Ring[] {
  const maxX = field.originX + field.nx * field.cell;
  const maxY = field.originY + field.ny * field.cell;
  const frameTol = Math.max(1e-7, field.cell * 1e-7);
  const touchesFrame = (ring: Ring): boolean => {
    for (let i = 0; i < ring.length; i += 2) {
      if (Math.abs(ring[i] - field.originX) <= frameTol
          || Math.abs(ring[i] - maxX) <= frameTol
          || Math.abs(ring[i + 1] - field.originY) <= frameTol
          || Math.abs(ring[i + 1] - maxY) <= frameTol) return true;
    }
    return false;
  };

  const available = section
    .map(({ ring, hasSubcellCrossing }, index) => ({
      ring,
      index,
      hasSubcellCrossing,
      centre: ringCentroid(ring),
    }))
    .filter(({ ring }) => !touchesFrame(ring));
  const expectedInternal = block.filter((ring) => !touchesFrame(ring));
  if (available.length !== expectedInternal.length) return block;

  const used = new Set<number>();
  const matched: Ring[] = [];
  for (const target of block) {
    if (touchesFrame(target)) {
      matched.push(target);
      continue;
    }
    const targetCentre = ringCentroid(target);
    let best: (typeof available)[number] | undefined;
    let bestDistance = Infinity;
    for (const candidate of available) {
      if (used.has(candidate.index) || Math.sign(area(candidate.ring)) !== Math.sign(area(target))) continue;
      const distance = Math.hypot(candidate.centre[0] - targetCentre[0], candidate.centre[1] - targetCentre[1]);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (!best) return block;
    used.add(best.index);
    if (!best.hasSubcellCrossing) {
      matched.push(target);
      continue;
    }
    const sourceArea = Math.abs(area(best.ring));
    const targetArea = Math.abs(area(target));
    if (!(sourceArea > 1e-12) || !(targetArea > 1e-12)) return block;
    const scale = Math.sqrt(targetArea / sourceArea);
    let maxRescaleDisplacement = 0;
    for (let i = 0; i < best.ring.length; i += 2) {
      maxRescaleDisplacement = Math.max(
        maxRescaleDisplacement,
        Math.hypot(best.ring[i] - best.centre[0], best.ring[i + 1] - best.centre[1])
          * Math.abs(scale - 1),
      );
    }
    if (scale > 1 && maxRescaleDisplacement > field.cell / 16) {
      matched.push(best.ring);
      continue;
    }
    const scaled = new Float64Array(best.ring.length);
    for (let i = 0; i < best.ring.length; i += 2) {
      scaled[i] = best.centre[0] + (best.ring[i] - best.centre[0]) * scale;
      scaled[i + 1] = best.centre[1] + (best.ring[i + 1] - best.centre[1]) * scale;
    }
    matched.push(scaled);
  }
  return matched;
}

export interface CutRegionOpts {
  /** Optional model-located section; already in world XY, before radial allowance. */
  partSection?: readonly Ring[];
  /**
   * Radial stock left on the part walls (mm): the part section is grown
   * OUTWARD by this before subtraction. NOT tool radius (applied later).
   */
  radialStockToLeave?: number;
  /**
   * Corner-reach (mm): dilate the STOCK section OUTWARD by this before the
   * stock/part difference (Stage C-2). The engine later insets the whole region
   * back by toolRadius, so at reach = toolRadius the outer boundary returns to
   * the true stock edge and the tool CENTRE reaches the corner apex (clearing
   * the leftover posts). MUST be 0 outside the full-clear branch (dilating a
   * part-AABB field would push the tool into surrounding UNCLEARED stock).
   * Default (absent/0) = byte-identical to pre-C-2.
   */
  reachStockEdgeBy?: number;
}

/**
 * Cut region at plane `z`: stock section minus (optionally grown) part section.
 * Returns [] cleanly when there is nothing to cut (above the stock, or the part
 * fills the stock) -- a valid result, not an error. Requires
 * ensureGeom2dReady() to have resolved (offset/boolean use the geom2d wasm).
 */
export async function cutRegionAt(
  stock: ZDexelField,
  part: ZDexelField,
  z: number,
  opts?: CutRegionOpts,
): Promise<Ring[]> {
  if (!Number.isFinite(z)) {
    throw new Error(`cutRegionAt: z must be finite, got ${z}.`);
  }
  const grow = opts?.radialStockToLeave ?? 0;
  if (!Number.isFinite(grow) || grow < 0) {
    throw new Error(`cutRegionAt: radialStockToLeave must be finite and >= 0, got ${grow}.`);
  }

  let stockSec = remainingAbove(stock, z);
  if (stockSec.length === 0) return []; // above the stock: nothing to cut
  const reach = opts?.reachStockEdgeBy ?? 0;
  if (!Number.isFinite(reach) || reach < 0) {
    throw new Error(`cutRegionAt: reachStockEdgeBy must be finite and >= 0, got ${reach}.`);
  }
  if (reach > 0) {
    // Round join: the corner-reach rolls the stock edge outward like a radius.
    stockSec = serviceOffset(stockSec, reach);
  }

  const blockPartSec = opts?.partSection === undefined ? remainingAbove(part, z) : [];
  let partSec = opts?.partSection !== undefined ? [...opts.partSection] : blockPartSec.length > 0
    ? matchSectionRings(interpolatedPartSection(part, z), blockPartSec, part)
    : [];
  if (grow > 0 && partSec.length > 0) {
    // Round join: the grown skin follows the wall like a rolling radius.
    partSec = serviceOffset(partSec, grow);
  }
  if (partSec.length === 0) return stockSec; // no part here: clear the whole stock

  return serviceDifference(stockSec, partSec);
}

/** One bounded region: a CCW outer boundary with the CW holes inside it. */
export interface RegionComponent {
  boundary: Ring;
  holes: Ring[];
}

/**
 * Even-odd point-in-ring (ray cast). Used for hole->outer containment
 * (geom2d exposes no point query) and, EXPORTED, by emit's side-entry to verify
 * a lead-in touchdown lands OUTSIDE the stock footprint (in air). The tested
 * point in the containment use is a hole vertex, which lies strictly inside its
 * owning outer, so edge cases do not arise for well-formed region output.
 */
export function pointInRing(ring: Ring, x: number, y: number): boolean {
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

/**
 * True when any positive area of a cutter disk overlaps the material represented by
 * a flat ring set. Unlike pointInRing, this catches a centre in air whose cutter edge
 * crosses the stock boundary. Exact tangency is clear: contact without area overlap
 * does not put the cutter inside material.
 */
export function cutterDiskIntersectsRegion(
  rings: readonly Ring[],
  x: number,
  y: number,
  radius: number,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(radius > 0) || !Number.isFinite(radius)) {
    throw new Error(
      `cutterDiskIntersectsRegion: centre and radius must be finite with radius > 0; ` +
        `got (${x}, ${y}), radius ${radius}.`,
    );
  }

  let centreInMaterial = false;
  let minBoundaryDistance = Infinity;
  for (const ring of rings) {
    if (pointInRing(ring, x, y)) centreInMaterial = !centreInMaterial;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[2 * i];
      const ay = ring[2 * i + 1];
      const bx = ring[2 * j];
      const by = ring[2 * j + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0
        ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq))
        : 0;
      minBoundaryDistance = Math.min(
        minBoundaryDistance,
        Math.hypot(x - (ax + t * dx), y - (ay + t * dy)),
      );
    }
  }

  if (centreInMaterial) return true;
  return minBoundaryDistance < radius - 1e-7;
}

/** Centroid (vertex average) of a ring -- a containment fallback point. */
function ringCentroid(ring: Ring): [number, number] {
  const n = ring.length / 2;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += ring[2 * i];
    sy += ring[2 * i + 1];
  }
  return [sx / n, sy / n];
}

/**
 * Split a flat ring set (geom2d convention) into bounded components: each CCW
 * outer with the CW holes geometrically inside it. Every hole is assigned to
 * the SMALLEST-area outer that contains it (correct nesting when outers are
 * themselves nested). Fails loud if a hole lands inside no outer (that would be
 * a malformed ring set, not a valid region).
 */
export function decomposeToComponents(rings: Ring[]): RegionComponent[] {
  const outers: Ring[] = [];
  const holes: Ring[] = [];
  for (const r of rings) {
    if (r.length < 6) {
      throw new Error(`decomposeToComponents: degenerate ring with ${r.length / 2} points.`);
    }
    if (area(r) > 0) outers.push(r);
    else if (area(r) < 0) holes.push(r);
    // Exactly-zero-area rings (collinear slivers) carry no region; drop them.
  }

  const comps: RegionComponent[] = outers.map((boundary) => ({ boundary, holes: [] }));
  const outerArea = outers.map((o) => area(o));

  for (const hole of holes) {
    // Prefer a hole vertex (strictly inside its owner); fall back to centroid.
    let hx = hole[0];
    let hy = hole[1];
    let owner = pickOwner(outers, outerArea, hx, hy);
    if (owner < 0) {
      [hx, hy] = ringCentroid(hole);
      owner = pickOwner(outers, outerArea, hx, hy);
    }
    if (owner < 0) {
      throw new Error(
        'decomposeToComponents: hole ring is inside no outer boundary (malformed region).',
      );
    }
    comps[owner].holes.push(hole);
  }
  return comps;
}

/** Index of the smallest-area outer containing (x, y), or -1 if none. */
function pickOwner(outers: Ring[], outerArea: number[], x: number, y: number): number {
  let best = -1;
  let bestArea = Infinity;
  for (let o = 0; o < outers.length; o++) {
    if (outerArea[o] < bestArea && pointInRing(outers[o], x, y)) {
      best = o;
      bestArea = outerArea[o];
    }
  }
  return best;
}
