// cam3d rough: EXTERIOR ACCESS analysis -- which remaining stock in a depth band
// can the cutter reach from outside the stock through air (WO-2758, step 1 of
// the outside-in roughing proposal on wo/WO-2654).
//
// READ-ONLY. Nothing calls this yet except its tests. It never writes the
// field, never consumes planned removals, and changes no toolpath, job,
// warning or refusal. It is stock-topology evidence for a future scheduler,
// NOT a certificate that an entry is safe for the whole tool assembly.
//
// MODEL. The field is the z-dexel stock the rougher already uses (zdexel.ts:
// one upward-open [bottom, top] interval per XY column, centre-sampled). For a
// band [bottomZ, topZ]:
//  - BAND MATERIAL is a column whose top lies inside the band,
//    bottomZ < top <= topZ. That is the material this band clears: under
//    upward-open removal a column whose top rises above topZ cannot lose its
//    in-band material without losing everything above it too, so it belongs
//    to the band that holds its top.
//  - The tool tip travels on the band's TOP plane. A tool-centre position is
//    BLOCKED when standing material under its footprint rises into the cutter
//    there (the traverseClearance.ts collision test: top > topZ + height(r)).
//    Band material never blocks (its top is at or below the plane), so cutting
//    it cannot open a new route at this band; only a cut above topZ can.
//  - Tool centres start OUTSIDE the stock boundary (a padding ring of air
//    around the grid) and flood 4-connected through unblocked positions.
//  - Each band column is classified ONLY by direct footprint coverage, never
//    by its neighbours: EXTERIOR when a centre reachable from outside has it
//    within the cutter radius; ENCLOSED when only unblocked centres not
//    connected to the outside do; UNREACHABLE when no unblocked centre covers
//    it at all (inside-corner residue, a slot or neck narrower than the
//    cutter). No verdict is inherited through band material: both WO-2758
//    audit FAILs came from untouched columns copying a nearby reached
//    column's EXTERIOR (unbounded, then bounded by a residue distance), which
//    is not cutter access. Components are 4-connected groups of band columns
//    with the same label, so a slot mouth and its unreachable inside are
//    separate components, and every column of an EXTERIOR component is
//    directly touched by an outside-reachable centre (reachedColumns ===
//    columns).
//
// CONSERVATIVE (rounds toward "not reachable"). Positions are grid cell centres
// only. The obstacle footprint is the cutter radius PLUS half a cell diagonal,
// with the ball height taken at the nearest point of that inflation, so a
// tool-centre step between adjacent cells (at most half a cell from either end)
// is covered by the check at one of its ends. ENCLOSED and UNREACHABLE
// therefore mean "no proven exterior route at this band"; neither claims the
// material is physically out of reach of every motion.
//
// UNRESOLVED, never a guess:
//  - no-full-stock-proof: the field may be part-bounds/fallback stock, whose
//    edge is not physically open air;
//  - cutter-not-supported: bull/vbit have no profile in the stock services yet
//    (cutterProfile.ts);
//  - budget-exceeded: the padded scan grid or the footprint work would exceed
//    the cell/work budget (checked up front, so the answer is deterministic);
//  - not-upward-open: a component column whose bottom sits above the stock
//    floor, i.e. material over a void the single interval cannot express.
//
// STALENESS. Every result carries the caller's stock revision, the band, the
// grid and a digest of the field arrays. exteriorAccessAt() rejects a result
// queried against a different revision or a field whose bytes changed.
//
// PURE + DETERMINISTIC (D-006): fixed scan order (j outer, i inner), FIFO flood,
// no RNG, no time; identical inputs give identical results.

import type { CutterSpec } from '../kernel/types';
import { DEFAULT_CELL_BUDGET, profileHeight, type GridFrame, type ZDexelField } from '../stock';

/** Float32 storage tolerance for band membership and obstacle tests, mm. */
const EPS = 1e-4;

/** Default footprint-work budget (obstacle and touch offset checks). */
export const DEFAULT_ACCESS_WORK_BUDGET = 200_000_000;

export type ExteriorAccess = 'exterior' | 'enclosed' | 'unreachable' | 'unresolved';

export type ExteriorAccessUnresolvedReason =
  | 'no-full-stock-proof'
  | 'cutter-not-supported'
  | 'budget-exceeded'
  | 'not-upward-open';

export interface ExteriorAccessBand {
  /** Upper plane of the band; the tool tip travels here. */
  topZ: number;
  /** Lower plane of the band. */
  bottomZ: number;
}

export interface ExteriorAccessInput {
  /** The actual stock field (never mutated). */
  field: ZDexelField;
  /** Caller-owned revision of `field`; results are bound to it. */
  stockRevision: number;
  band: ExteriorAccessBand;
  cutter: CutterSpec;
  /** True only when the field is proven full stock (its edge is open air). */
  fullStockProof: boolean;
  /** Max padded scan-grid columns (default DEFAULT_CELL_BUDGET). */
  cellBudget?: number;
  /** Max footprint offset checks (default DEFAULT_ACCESS_WORK_BUDGET). */
  workBudget?: number;
}

export interface ExteriorAccessComponent {
  /** Index into `components`; also the value in `componentOf`. */
  id: number;
  access: ExteriorAccess;
  /** Set exactly when access === 'unresolved'. */
  reason?: ExteriorAccessUnresolvedReason;
  /** Band-material columns in the component. */
  columns: number;
  /** Of those, columns a tool centre reachable from outside touches directly. */
  reachedColumns: number;
  /** Inclusive grid-index bounds. */
  minI: number;
  maxI: number;
  minJ: number;
  maxJ: number;
  minTopZ: number;
  maxTopZ: number;
  /** Centre of the component's first column in scan order. */
  witnessX: number;
  witnessY: number;
}

export interface ExteriorAccessResult {
  stockRevision: number;
  band: Readonly<ExteriorAccessBand>;
  cutter: Readonly<CutterSpec>;
  grid: Readonly<GridFrame>;
  /** Digest of the field's grid and arrays at analysis time. */
  fieldDigest: string;
  /** Set when one reason makes every component unresolved. */
  unresolvedReason?: ExteriorAccessUnresolvedReason;
  components: readonly ExteriorAccessComponent[];
  /** Per field column (j * nx + i): component id, or -1 for no band material. */
  componentOf: Int32Array;
  /** Footprint offset checks counted against the work budget (0 if not run). */
  work: number;
}

export type ExteriorAccessStaleReason = 'revision-mismatch' | 'field-changed';

export type ExteriorAccessQuery =
  | { status: 'current'; component: ExteriorAccessComponent | undefined }
  | { status: 'stale'; reason: ExteriorAccessStaleReason };

function assertFinite(v: number, label: string): void {
  if (!Number.isFinite(v)) {
    throw new Error(`exteriorAccess: ${label} must be finite, got ${v}.`);
  }
}

/** FNV-1a over 32-bit words of the grid scalars and both column arrays. Also
 *  binds WO-2786's envelope results to the exact field they judged. */
export function digestField(field: ZDexelField): string {
  let h = 0x811c9dc5;
  const mixWords = (words: Uint32Array): void => {
    for (let k = 0; k < words.length; k++) {
      h = Math.imul(h ^ words[k], 0x01000193) >>> 0;
    }
  };
  const scalars = new Float64Array([field.nx, field.ny, field.originX, field.originY, field.cell]);
  mixWords(new Uint32Array(scalars.buffer));
  mixWords(new Uint32Array(field.top.buffer, field.top.byteOffset, field.top.length));
  mixWords(new Uint32Array(field.bottom.buffer, field.bottom.byteOffset, field.bottom.length));
  return `${field.nx}x${field.ny}:${h.toString(16).padStart(8, '0')}`;
}

/** Per-column coverage labels (step 5) and the access each one reports. */
const UNTOUCHED = 0;
const REACHED = 1;
const INSIDE = 2;
const VERDICT_ACCESS: readonly ExteriorAccess[] = ['unreachable', 'exterior', 'enclosed'];

interface Offset {
  di: number;
  dj: number;
  /** Cutter height above the tip at the nearest inflated distance, mm. */
  h: number;
}

/**
 * 4-connected components of band columns, joined only where `cls` agrees
 * (all join when `cls` is absent). Ids are assigned in scan order of each
 * component's first column; -1 marks non-band columns.
 */
function labelComponents(nx: number, ny: number, isBand: Uint8Array, cls?: Uint8Array): Int32Array {
  const n = nx * ny;
  const of = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let next = 0;
  for (let seed = 0; seed < n; seed++) {
    if (!isBand[seed] || of[seed] !== -1) continue;
    const id = next++;
    const want = cls ? cls[seed] : 0;
    let head = 0;
    let tail = 0;
    of[seed] = id;
    queue[tail++] = seed;
    const visit = (d: number): void => {
      if (isBand[d] && of[d] === -1 && (cls ? cls[d] : 0) === want) {
        of[d] = id;
        queue[tail++] = d;
      }
    };
    while (head < tail) {
      const c = queue[head++];
      const i = c % nx;
      const j = (c - i) / nx;
      if (i > 0) visit(c - 1);
      if (i < nx - 1) visit(c + 1);
      if (j > 0) visit(c - nx);
      if (j < ny - 1) visit(c + nx);
    }
  }
  return of;
}

/**
 * Classify the band material of `field` as exterior, enclosed or unresolved.
 * Throws only for malformed input (non-finite numbers, inverted band, invalid
 * cutter diameter); every analysis limit is an unresolved verdict instead.
 */
export function analyzeExteriorAccess(input: ExteriorAccessInput): ExteriorAccessResult {
  const { field, stockRevision, band, cutter, fullStockProof } = input;
  assertFinite(stockRevision, 'stockRevision');
  assertFinite(band.topZ, 'band.topZ');
  assertFinite(band.bottomZ, 'band.bottomZ');
  if (!(band.topZ > band.bottomZ)) {
    throw new Error(
      `exteriorAccess: band.topZ (${band.topZ}) must be above band.bottomZ (${band.bottomZ}).`,
    );
  }
  if (!Number.isFinite(cutter.diameter) || cutter.diameter <= 0) {
    throw new Error(`exteriorAccess: cutter diameter must be positive and finite, got ${cutter.diameter}.`);
  }
  const cellBudget = input.cellBudget ?? DEFAULT_CELL_BUDGET;
  const workBudget = input.workBudget ?? DEFAULT_ACCESS_WORK_BUDGET;

  const { nx, ny, cell, originX, originY, top, bottom } = field;
  const n = nx * ny;
  const { topZ, bottomZ } = band;

  // --- 1. Band material, the stock floor and material hanging above it. ---
  const isBand = new Uint8Array(n);
  let bandColumns = 0;
  let stockFloor = Number.POSITIVE_INFINITY;
  for (let c = 0; c < n; c++) {
    const t = top[c];
    if (!(t > bottom[c])) continue;
    if (bottom[c] < stockFloor) stockFloor = bottom[c];
    if (t > bottomZ + EPS && t <= topZ + EPS) {
      isBand[c] = 1;
      bandColumns++;
    }
  }
  // Hanging material taints its whole connected band material, whatever the
  // later reach split does.
  const baseOf = labelComponents(nx, ny, isBand);
  const hangingBase = new Set<number>();
  for (let c = 0; c < n; c++) {
    if (isBand[c] && bottom[c] > stockFloor + EPS) hangingBase.add(baseOf[c]);
  }

  const build = (
    of: Int32Array,
    work: number,
    unresolvedReason?: ExteriorAccessUnresolvedReason,
    verdict?: Uint8Array,
  ): ExteriorAccessResult => {
    const components: ExteriorAccessComponent[] = [];
    for (let c = 0; c < n; c++) {
      const id = of[c];
      if (id < 0) continue;
      const i = c % nx;
      const j = (c - i) / nx;
      let comp = components[id];
      if (comp === undefined) {
        const reason = unresolvedReason ?? (hangingBase.has(baseOf[c]) ? 'not-upward-open' : undefined);
        comp = {
          id,
          access: reason !== undefined ? 'unresolved' : VERDICT_ACCESS[verdict?.[c] ?? UNTOUCHED],
          ...(reason !== undefined ? { reason } : {}),
          columns: 0,
          reachedColumns: 0,
          minI: i,
          maxI: i,
          minJ: j,
          maxJ: j,
          minTopZ: top[c],
          maxTopZ: top[c],
          witnessX: field.centerX(i),
          witnessY: field.centerY(j),
        };
        components[id] = comp;
      }
      comp.columns++;
      if (verdict?.[c] === REACHED) comp.reachedColumns++;
      if (i < comp.minI) comp.minI = i;
      if (i > comp.maxI) comp.maxI = i;
      if (j < comp.minJ) comp.minJ = j;
      if (j > comp.maxJ) comp.maxJ = j;
      if (top[c] < comp.minTopZ) comp.minTopZ = top[c];
      if (top[c] > comp.maxTopZ) comp.maxTopZ = top[c];
    }
    for (const comp of components) Object.freeze(comp);
    return {
      stockRevision,
      band: Object.freeze({ topZ, bottomZ }),
      cutter: Object.freeze({ ...cutter }),
      grid: Object.freeze({ originX, originY, nx, ny, cell }),
      fieldDigest: digestField(field),
      ...(unresolvedReason !== undefined ? { unresolvedReason } : {}),
      components: Object.freeze(components),
      componentOf: of,
      work,
    };
  };

  // --- 2. Whole-result limits. ---
  if (cutter.kind !== 'flat' && cutter.kind !== 'ball') return build(baseOf, 0, 'cutter-not-supported');
  if (!fullStockProof) return build(baseOf, 0, 'no-full-stock-proof');
  const kind = cutter.kind;
  const R = cutter.diameter / 2;
  const halfDiag = (cell * Math.SQRT2) / 2;
  const m = Math.ceil((R + halfDiag) / cell);
  const pad = m + 1;
  const px = nx + 2 * pad;
  const py = ny + 2 * pad;
  if (px * py > cellBudget) return build(baseOf, 0, 'budget-exceeded');

  const blockOffsets: Offset[] = [];
  const touchOffsets: Offset[] = [];
  for (let dj = -m; dj <= m; dj++) {
    for (let di = -m; di <= m; di++) {
      const d = Math.hypot(di, dj) * cell;
      const dMin = Math.max(0, d - halfDiag);
      if (dMin <= R) blockOffsets.push({ di, dj, h: profileHeight(kind, R, dMin) });
      if (d <= R) touchOffsets.push({ di, dj, h: 0 });
    }
  }
  let obstacleColumns = 0;
  for (let c = 0; c < n; c++) {
    if (top[c] > bottom[c] && top[c] > topZ + EPS) obstacleColumns++;
  }
  const work = obstacleColumns * blockOffsets.length + bandColumns * touchOffsets.length;
  if (work > workBudget) return build(baseOf, 0, 'budget-exceeded');

  // --- 3. Blocked tool-centre positions on the padded grid. ---
  const blocked = new Uint8Array(px * py);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const t = top[c];
      if (!(t > bottom[c]) || !(t > topZ + EPS)) continue;
      for (const o of blockOffsets) {
        if (t > topZ + o.h + EPS) blocked[(j + pad + o.dj) * px + (i + pad + o.di)] = 1;
      }
    }
  }

  // --- 4. Flood tool centres from the outside ring of the padded grid. ---
  const reach = new Uint8Array(px * py);
  const pq = new Int32Array(px * py);
  let head = 0;
  let tail = 0;
  const enter = (p: number): void => {
    if (!reach[p] && !blocked[p]) {
      reach[p] = 1;
      pq[tail++] = p;
    }
  };
  for (let i = 0; i < px; i++) {
    enter(i);
    enter((py - 1) * px + i);
  }
  for (let j = 1; j < py - 1; j++) {
    enter(j * px);
    enter(j * px + px - 1);
  }
  while (head < tail) {
    const p = pq[head++];
    const i = p % px;
    const j = (p - i) / px;
    if (i > 0) enter(p - 1);
    if (i < px - 1) enter(p + 1);
    if (j > 0) enter(p - px);
    if (j < py - 1) enter(p + px);
  }

  // --- 5. Label per band column by direct coverage only (no inheritance). ---
  const verdict = new Uint8Array(n);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!isBand[c]) continue;
      let v = UNTOUCHED;
      for (const o of touchOffsets) {
        const p = (j + pad + o.dj) * px + (i + pad + o.di);
        if (reach[p]) {
          v = REACHED;
          break;
        }
        if (!blocked[p]) v = INSIDE;
      }
      verdict[c] = v;
    }
  }

  // --- 6. Split band material by label. ---
  return build(labelComponents(nx, ny, isBand, verdict), work, undefined, verdict);
}

/**
 * Look up the component under world point (x, y), rejecting the result as
 * stale unless it was computed for exactly this revision AND these field bytes.
 */
export function exteriorAccessAt(
  result: ExteriorAccessResult,
  field: ZDexelField,
  stockRevision: number,
  x: number,
  y: number,
): ExteriorAccessQuery {
  if (stockRevision !== result.stockRevision) return { status: 'stale', reason: 'revision-mismatch' };
  if (digestField(field) !== result.fieldDigest) return { status: 'stale', reason: 'field-changed' };
  const { originX, originY, nx, ny, cell } = result.grid;
  const i = Math.floor((x - originX) / cell);
  const j = Math.floor((y - originY) / cell);
  if (!(i >= 0 && i < nx && j >= 0 && j < ny)) return { status: 'current', component: undefined };
  const id = result.componentOf[j * nx + i];
  return { status: 'current', component: id < 0 ? undefined : result.components[id] };
}
