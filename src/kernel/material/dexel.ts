// WO-3017: the kernel z-dexel field. One [bottom, top] interval per XY column
// over a regular grid, two Float32Arrays, column (i, j) centred at
// (originX + (i + 0.5) * cell, originY + (j + 0.5) * cell), index j * nx + i,
// top === bottom encoding an empty column. Layout, budget and coarsening are
// today's src/cam3d/stock/zdexel.ts ZDexelField.fromBox, so a kernel field and
// today's field built from the same box are the same grid, byte for byte.

export const DEFAULT_CELL_BUDGET = 4_000_000
const MAX_COARSEN_ATTEMPTS = 8

export interface Box3 {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
}

export class DexelField {
  readonly nx: number
  readonly ny: number
  readonly originX: number
  readonly originY: number
  readonly cell: number
  readonly requestedCellSize: number
  readonly warnings: readonly string[]
  readonly top: Float32Array
  readonly bottom: Float32Array

  private constructor(nx: number, ny: number, originX: number, originY: number, cell: number,
    requestedCellSize: number, warnings: string[], top: Float32Array, bottom: Float32Array) {
    this.nx = nx
    this.ny = ny
    this.originX = originX
    this.originY = originY
    this.cell = cell
    this.requestedCellSize = requestedCellSize
    this.warnings = warnings
    this.top = top
    this.bottom = bottom
  }

  /** A full stock box, every column solid from minZ to maxZ; coarsened to the budget with a warning. */
  static fromBox(bounds: Box3, requestedCellSize: number, budget: number = DEFAULT_CELL_BUDGET): DexelField {
    for (const [label, v] of Object.entries(bounds)) {
      if (!Number.isFinite(v)) throw new Error(`DexelField: bounds.${label} must be finite, got ${v}.`)
    }
    const width = bounds.maxX - bounds.minX
    const height = bounds.maxY - bounds.minY
    if (width <= 0 || height <= 0) {
      throw new Error(`DexelField.fromBox: bounds must have positive XY extent (got ${width} x ${height}).`)
    }
    if (bounds.maxZ < bounds.minZ) throw new Error(`DexelField.fromBox: maxZ (${bounds.maxZ}) < minZ (${bounds.minZ}).`)
    if (!Number.isFinite(requestedCellSize) || requestedCellSize <= 0) {
      throw new Error(`DexelField.fromBox: requestedCellSize must be positive and finite, got ${requestedCellSize}.`)
    }
    if (!Number.isInteger(budget) || budget < 1) {
      throw new Error(`DexelField.fromBox: budget must be a positive integer, got ${budget}.`)
    }
    let cell = requestedCellSize
    let nx = 0
    let ny = 0
    let fits = false
    for (let attempt = 0; attempt <= MAX_COARSEN_ATTEMPTS; attempt++) {
      nx = Math.max(1, Math.ceil(width / cell - 1e-9))
      ny = Math.max(1, Math.ceil(height / cell - 1e-9))
      if (nx * ny <= budget) { fits = true; break }
      cell = cell * Math.sqrt((nx * ny) / budget) * 1.02
    }
    if (!fits) {
      throw new Error(`DexelField.fromBox: could not fit ${width} x ${height} mm under the ${budget}-cell budget.`)
    }
    const warnings: string[] = []
    if (cell > requestedCellSize) {
      warnings.push(`Cell budget (${budget}) forced coarsening: z-dexel cell size is ${cell.toFixed(6)} mm ` +
        `instead of the requested ${requestedCellSize.toFixed(6)} mm.`)
    }
    const n = nx * ny
    const top = new Float32Array(n)
    const bottom = new Float32Array(n)
    top.fill(Math.fround(bounds.maxZ))
    bottom.fill(Math.fround(bounds.minZ))
    return new DexelField(nx, ny, bounds.minX, bounds.minY, cell, requestedCellSize, warnings, top, bottom)
  }

  clone(): DexelField {
    return new DexelField(this.nx, this.ny, this.originX, this.originY, this.cell, this.requestedCellSize,
      [...this.warnings], this.top.slice(), this.bottom.slice())
  }
}
