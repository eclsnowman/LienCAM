// cam3d stock (L0/L3): z-dexel stock field -- ONE interval per XY column.
//
// D-016: V1 is 3-axis with radially-monotone cutters, so every removal is an
// upward-open interval per column and a single [bottom, top] interval per
// column is EXACT (not an approximation) for everything V1 can cut.
// Multi-interval chains arrive with the tri-dexel X/Y fields in Phase 4.
//
// STORAGE (D-014 browser headroom): structure-of-arrays, two Float32Arrays
// (top[], bottom[]) over a regular XY grid -- 8 bytes per column, no per-cell
// objects. At the default 4M-cell budget the field costs 4M * 8 B = 32 MB,
// allocated ONCE up front; nothing in this module allocates per sweep.
//
// GRID CONVENTION: column (i, j) has its center at
//   (originX + (i + 0.5) * cell, originY + (j + 0.5) * cell),
// row-major with y as the OUTER loop: column index = j * nx + i (same layout
// as kernel GridSpec results). The grid covers the requested bounds fully --
// nx = ceil(width / cell) -- so the last column row/col may overhang the
// bounds by less than one cell; the overhang columns are ordinary stock.
//
// EMPTY ENCODING: a column with no material has top === bottom EXACTLY (the
// canonical encoding; sweeps clamp to it). This keeps "empty" a single bit
// pattern so identical operation sequences stay byte-identical (D-006).
//
// BUDGET (D-016, mirrors the STEP importer's triangle budget in
// input/step.ts): the caller REQUESTS a cell size; if that grid would exceed
// the cell budget the size is coarsened until it fits and a LOUD warning is
// surfaced on the instance -- never silently.

/** D-016 default cell budget: 4M columns = 32 MB for the two f32 arrays. */
export const DEFAULT_CELL_BUDGET = 4_000_000;

/** Bounded coarsening retries before declaring the request un-budgetable. */
const MAX_COARSEN_ATTEMPTS = 8;

/** Axis-aligned box, mm. */
export interface Box3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Grid frame for direct field construction (see fromColumnTops). */
export interface GridFrame {
  originX: number;
  originY: number;
  nx: number;
  ny: number;
  cell: number;
}

function assertFinite(v: number, label: string): void {
  if (!Number.isFinite(v)) {
    throw new Error(`ZDexelField: ${label} must be finite, got ${v}.`);
  }
}

export class ZDexelField {
  /** Columns along x / y. */
  readonly nx: number;
  readonly ny: number;
  /** World position of the grid's min corner (NOT the first cell center). */
  readonly originX: number;
  readonly originY: number;
  /** Effective cell size, mm (post-coarsening). */
  readonly cell: number;
  /** The cell size the caller asked for (pre-coarsening), mm. */
  readonly requestedCellSize: number;
  /** Coarsening (and future) warnings; empty when the request fit as-is. */
  readonly warnings: readonly string[];
  /** Per-column material top z, mm. Length nx * ny, index = j * nx + i. */
  readonly top: Float32Array;
  /** Per-column material bottom z, mm. top === bottom encodes EMPTY. */
  readonly bottom: Float32Array;
  /** Exact maximum supplied to fromColumnTops, before f32 storage narrowing. */
  readonly coverageMaxTopZ: number | undefined;

  /** Alias for `cell` matching the D-016 wording. */
  get effectiveCellSize(): number {
    return this.cell;
  }

  private constructor(
    nx: number,
    ny: number,
    originX: number,
    originY: number,
    cell: number,
    requestedCellSize: number,
    warnings: string[],
    top: Float32Array,
    bottom: Float32Array,
    coverageMaxTopZ?: number,
  ) {
    this.nx = nx;
    this.ny = ny;
    this.originX = originX;
    this.originY = originY;
    this.cell = cell;
    this.requestedCellSize = requestedCellSize;
    this.warnings = warnings;
    this.top = top;
    this.bottom = bottom;
    this.coverageMaxTopZ = coverageMaxTopZ;
  }

  /**
   * Create a full stock box: every column solid from minZ to maxZ. The
   * requested cell size is clamped by the cell budget with a loud warning
   * (module header). Deterministic: same inputs give the same grid and
   * byte-identical arrays.
   */
  static fromBox(
    bounds: Box3,
    requestedCellSize: number,
    budget: number = DEFAULT_CELL_BUDGET,
  ): ZDexelField {
    for (const [v, label] of [
      [bounds.minX, 'bounds.minX'],
      [bounds.minY, 'bounds.minY'],
      [bounds.minZ, 'bounds.minZ'],
      [bounds.maxX, 'bounds.maxX'],
      [bounds.maxY, 'bounds.maxY'],
      [bounds.maxZ, 'bounds.maxZ'],
    ] as const) {
      assertFinite(v, label);
    }
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (width <= 0 || height <= 0) {
      throw new Error(
        `ZDexelField.fromBox: bounds must have positive XY extent ` +
          `(got ${width} x ${height}).`,
      );
    }
    if (bounds.maxZ < bounds.minZ) {
      throw new Error(`ZDexelField.fromBox: maxZ (${bounds.maxZ}) < minZ (${bounds.minZ}).`);
    }
    if (!Number.isFinite(requestedCellSize) || requestedCellSize <= 0) {
      throw new Error(
        `ZDexelField.fromBox: requestedCellSize must be positive and finite, ` +
          `got ${requestedCellSize}.`,
      );
    }
    if (!Number.isInteger(budget) || budget < 1) {
      throw new Error(`ZDexelField.fromBox: budget must be a positive integer, got ${budget}.`);
    }

    // Budget clamp loop (mirrors input/step.ts): scale the cell up by the
    // area ratio's square root with a small overshoot factor; converges in
    // 1-2 iterations, fails loud rather than looping forever.
    let cell = requestedCellSize;
    let nx = 0;
    let ny = 0;
    let fits = false;
    for (let attempt = 0; attempt <= MAX_COARSEN_ATTEMPTS; attempt++) {
      // -1e-9 snaps float noise like width/cell = 200.0000000001 back to 200.
      nx = Math.max(1, Math.ceil(width / cell - 1e-9));
      ny = Math.max(1, Math.ceil(height / cell - 1e-9));
      if (nx * ny <= budget) {
        fits = true;
        break;
      }
      cell = cell * Math.sqrt((nx * ny) / budget) * 1.02;
    }
    if (!fits) {
      throw new Error(
        `ZDexelField.fromBox: could not fit ${width} x ${height} mm under the ` +
          `${budget}-cell budget after ${MAX_COARSEN_ATTEMPTS} coarsening attempts ` +
          `(last cell size ${cell.toFixed(6)} mm).`,
      );
    }

    const warnings: string[] = [];
    if (cell > requestedCellSize) {
      warnings.push(
        `Cell budget (${budget}) forced coarsening: z-dexel cell size is ` +
          `${cell.toFixed(6)} mm instead of the requested ` +
          `${requestedCellSize.toFixed(6)} mm (grid ${nx} x ${ny} = ${nx * ny} columns). ` +
          `Stock/simulation resolution is coarser than requested.`,
      );
    }

    const n = nx * ny;
    const top = new Float32Array(n);
    const bottom = new Float32Array(n);
    // maxZ === minZ encodes an everywhere-empty field via the canonical
    // top === bottom encoding; fill() keeps both arrays byte-deterministic.
    top.fill(Math.fround(bounds.maxZ));
    bottom.fill(Math.fround(bounds.minZ));
    return new ZDexelField(
      nx, ny, bounds.minX, bounds.minY, cell, requestedCellSize, warnings, top, bottom,
    );
  }

  /**
   * Direct construction from per-column tops over an explicit grid frame with
   * a uniform bottom. The exact maximum is retained as a scalar completeness
   * witness before ordinary f32 field storage narrows the individual samples.
   * The tops array is COPIED; columns with top <= bottom are canonicalized
   * to the empty encoding (top === bottom).
   */
  static fromColumnTops(frame: GridFrame, tops: ArrayLike<number>, bottom: number): ZDexelField {
    const { originX, originY, nx, ny, cell } = frame;
    assertFinite(originX, 'frame.originX');
    assertFinite(originY, 'frame.originY');
    assertFinite(bottom, 'bottom');
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1) {
      throw new Error(`ZDexelField.fromColumnTops: nx/ny must be positive integers (${nx}, ${ny}).`);
    }
    if (!Number.isFinite(cell) || cell <= 0) {
      throw new Error(`ZDexelField.fromColumnTops: cell must be positive and finite, got ${cell}.`);
    }
    if (tops.length !== nx * ny) {
      throw new Error(
        `ZDexelField.fromColumnTops: tops has ${tops.length} entries, grid needs ${nx * ny}.`,
      );
    }
    const b = Math.fround(bottom);
    const top = new Float32Array(nx * ny);
    const bot = new Float32Array(nx * ny);
    bot.fill(b);
    let coverageMaxTopZ = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < tops.length; c++) {
      const t = tops[c];
      if (!Number.isFinite(t)) {
        throw new Error(`ZDexelField.fromColumnTops: non-finite top at column ${c} (${t}).`);
      }
      top[c] = t <= b ? b : t;
      if (t > b && t > coverageMaxTopZ) coverageMaxTopZ = t;
    }
    return new ZDexelField(
      nx, ny, originX, originY, cell, cell, [], top, bot, coverageMaxTopZ,
    );
  }

  /**
   * Deep copy of the material arrays (used by verify/sim and engagementAt).
   * Scalar structural fields are shared by value; the warnings array is
   * copied so the clone owns its list.
   */
  clone(): ZDexelField {
    return new ZDexelField(
      this.nx,
      this.ny,
      this.originX,
      this.originY,
      this.cell,
      this.requestedCellSize,
      [...this.warnings],
      this.top.slice(),
      this.bottom.slice(),
      this.coverageMaxTopZ,
    );
  }

  /** Column index for (i, j): row-major, y outer. */
  colIndex(i: number, j: number): number {
    return j * this.nx + i;
  }

  /** World x of column i's center. */
  centerX(i: number): number {
    return this.originX + (i + 0.5) * this.cell;
  }

  /** World y of column j's center. */
  centerY(j: number): number {
    return this.originY + (j + 0.5) * this.cell;
  }
}
