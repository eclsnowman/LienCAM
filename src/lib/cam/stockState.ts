import type { CutterSpec } from '../../cam3d/kernel/types'
import {
  DEFAULT_CELL_BUDGET,
  ZDexelField,
  maxTraverseIntrusion,
  removeSweep,
  type Box3,
  type LinearMove,
} from '../../cam3d/stock'

export type StockStateCutter = Extract<CutterSpec, { kind: 'flat' | 'ball' }>

export interface StockState {
  readonly schemaVersion: 1
  readonly representation: 'z-dexel'
  readonly bounds: Readonly<Box3>
  readonly requestedResolutionMm: number
  readonly resolutionMm: number
  readonly warnings: readonly string[]
  readonly nx: number
  readonly ny: number
  readonly bottomZ: number
  readonly topZ: Float32Array
}

export interface StockCut {
  readonly move: LinearMove
  readonly cutter: StockStateCutter
}

export type StockRegion =
  | { readonly kind: 'box'; readonly bounds: Readonly<Box3> }
  | {
      readonly kind: 'swept-cutter'
      readonly move: LinearMove
      readonly cutter: StockStateCutter
    }

interface SerializedStockState {
  schemaVersion: 1
  representation: 'z-dexel'
  bounds: Box3
  requestedResolutionMm: number
  resolutionMm: number
  warnings: string[]
  nx: number
  ny: number
  bottomZ: number
  topZ: number[]
}

function copyBounds(bounds: Readonly<Box3>): Box3 {
  return {
    minX: bounds.minX,
    minY: bounds.minY,
    minZ: bounds.minZ,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    maxZ: bounds.maxZ,
  }
}

function stateFromField(
  field: ZDexelField,
  bounds: Readonly<Box3>,
  requestedResolutionMm: number,
  warnings: readonly string[] = field.warnings,
): StockState {
  return {
    schemaVersion: 1,
    representation: 'z-dexel',
    bounds: Object.freeze(copyBounds(bounds)),
    requestedResolutionMm,
    resolutionMm: field.cell,
    warnings: Object.freeze([...warnings]),
    nx: field.nx,
    ny: field.ny,
    bottomZ: field.bottom[0],
    topZ: field.top.slice(),
  }
}

function fieldFromState(state: StockState): ZDexelField {
  if (state.topZ.length !== state.nx * state.ny) {
    throw new Error(
      `StockState: topZ has ${state.topZ.length} entries, grid needs ${state.nx * state.ny}.`,
    )
  }
  return ZDexelField.fromColumnTops(
    {
      originX: state.bounds.minX,
      originY: state.bounds.minY,
      nx: state.nx,
      ny: state.ny,
      cell: state.resolutionMm,
    },
    state.topZ,
    state.bottomZ,
  )
}

/**
 * Start with a solid axis-aligned stock box on an explicitly requested XY
 * resolution. The effective resolution and any budget coarsening warning are
 * carried on the returned state so loss of fidelity is never silent.
 */
export function createStockState(
  bounds: Readonly<Box3>,
  requestedResolutionMm: number,
  maxColumns: number = DEFAULT_CELL_BUDGET,
): StockState {
  const field = ZDexelField.fromBox(bounds, requestedResolutionMm, maxColumns)
  return stateFromField(field, bounds, requestedResolutionMm)
}

/**
 * Apply one operation's cutting sweeps and return a new remaining-material
 * state. The input state is not mutated, so operation boundaries can retain or
 * serialize their own snapshots safely.
 */
export function applyStockOperation(
  state: StockState,
  cuts: readonly StockCut[],
): StockState {
  const field = fieldFromState(state)
  for (const cut of cuts) removeSweep(field, cut.move, cut.cutter)
  return stateFromField(field, state.bounds, state.requestedResolutionMm, state.warnings)
}

function assertBox(bounds: Readonly<Box3>, label: string): void {
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isFinite(value)) throw new Error(`${label}.${name} must be finite, got ${value}.`)
  }
  if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY || bounds.maxZ < bounds.minZ) {
    throw new Error(`${label} max must be greater than or equal to min on every axis.`)
  }
}

function isBoxEmpty(state: StockState, bounds: Readonly<Box3>): boolean {
  assertBox(bounds, 'StockRegion.bounds')
  if (
    bounds.maxX === bounds.minX ||
    bounds.maxY === bounds.minY ||
    bounds.maxZ === bounds.minZ
  ) {
    return true
  }

  const cell = state.resolutionMm
  const rawI0 = Math.floor((bounds.minX - state.bounds.minX) / cell)
  const rawI1 = Math.ceil((bounds.maxX - state.bounds.minX) / cell) - 1
  const rawJ0 = Math.floor((bounds.minY - state.bounds.minY) / cell)
  const rawJ1 = Math.ceil((bounds.maxY - state.bounds.minY) / cell) - 1
  if (rawI1 < 0 || rawJ1 < 0 || rawI0 >= state.nx || rawJ0 >= state.ny) return true

  const i0 = Math.max(0, rawI0)
  const i1 = Math.min(state.nx - 1, rawI1)
  const j0 = Math.max(0, rawJ0)
  const j1 = Math.min(state.ny - 1, rawJ1)
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const top = state.topZ[j * state.nx + i]
      if (top > state.bottomZ && top > bounds.minZ && state.bottomZ < bounds.maxZ) return false
    }
  }
  return true
}

/**
 * True when the represented remaining material has no positive-volume overlap
 * with the requested box or swept cutter. Swept-cutter queries test the whole
 * cutter footprint, not only the tool-tip centerline.
 */
export function isStockRegionEmpty(state: StockState, region: StockRegion): boolean {
  if (region.kind === 'box') return isBoxEmpty(state, region.bounds)
  const intrusion = maxTraverseIntrusion(fieldFromState(state), region.move, region.cutter)
  return intrusion.intrusionMm <= 0
}

export function serializeStockState(state: StockState): string {
  const value: SerializedStockState = {
    schemaVersion: 1,
    representation: 'z-dexel',
    bounds: copyBounds(state.bounds),
    requestedResolutionMm: state.requestedResolutionMm,
    resolutionMm: state.resolutionMm,
    warnings: [...state.warnings],
    nx: state.nx,
    ny: state.ny,
    bottomZ: state.bottomZ,
    topZ: Array.from(state.topZ),
  }
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`deserializeStockState: ${label} must be a finite number.`)
  }
  return value
}

/** Reload a state produced by serializeStockState, rejecting other schemas. */
export function deserializeStockState(serialized: string): StockState {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('deserializeStockState: input is not valid JSON.')
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.representation !== 'z-dexel') {
    throw new Error('deserializeStockState: unsupported stock-state schema.')
  }
  if (!isRecord(value.bounds)) throw new Error('deserializeStockState: bounds are missing.')
  const bounds: Box3 = {
    minX: requireFiniteNumber(value.bounds.minX, 'bounds.minX'),
    minY: requireFiniteNumber(value.bounds.minY, 'bounds.minY'),
    minZ: requireFiniteNumber(value.bounds.minZ, 'bounds.minZ'),
    maxX: requireFiniteNumber(value.bounds.maxX, 'bounds.maxX'),
    maxY: requireFiniteNumber(value.bounds.maxY, 'bounds.maxY'),
    maxZ: requireFiniteNumber(value.bounds.maxZ, 'bounds.maxZ'),
  }
  assertBox(bounds, 'deserializeStockState.bounds')

  const requestedResolutionMm = requireFiniteNumber(
    value.requestedResolutionMm,
    'requestedResolutionMm',
  )
  const resolutionMm = requireFiniteNumber(value.resolutionMm, 'resolutionMm')
  const nx = requireFiniteNumber(value.nx, 'nx')
  const ny = requireFiniteNumber(value.ny, 'ny')
  const bottomZ = requireFiniteNumber(value.bottomZ, 'bottomZ')
  if (!Number.isInteger(nx) || nx < 1 || !Number.isInteger(ny) || ny < 1) {
    throw new Error('deserializeStockState: nx and ny must be positive integers.')
  }
  if (!(resolutionMm > 0) || !(requestedResolutionMm > 0)) {
    throw new Error('deserializeStockState: resolutions must be positive.')
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((item) => typeof item !== 'string')) {
    throw new Error('deserializeStockState: warnings must be an array of strings.')
  }
  if (!Array.isArray(value.topZ) || value.topZ.length !== nx * ny) {
    throw new Error(`deserializeStockState: topZ must contain ${nx * ny} entries.`)
  }
  const topZ = Float32Array.from(
    value.topZ.map((entry, index) => requireFiniteNumber(entry, `topZ[${index}]`)),
  )
  const field = ZDexelField.fromColumnTops(
    { originX: bounds.minX, originY: bounds.minY, nx, ny, cell: resolutionMm },
    topZ,
    bottomZ,
  )
  return stateFromField(field, bounds, requestedResolutionMm, value.warnings as string[])
}

/** WO-2953: separate from the legacy CENTER samples above. Every value here
 * encloses the material over an ENTIRE cell. Never cast a StockState to this
 * capability. Z-up, upward-open removal only; not a mesh/undercut certificate. */
export interface ConservativeStockColumns {
  readonly representation: 'full-cell-upper-envelope-v1'
  readonly bounds: Readonly<Box3>
  readonly resolutionMm: number
  readonly requestedResolutionMm: number
  readonly nx: number
  readonly ny: number
  readonly warnings: readonly string[]
  readonly topZ: readonly number[]
  readonly roundingAllowanceMm: number
}

function numericalAllowance(values: readonly number[]): number {
  return 128 * Number.EPSILON * Math.max(1, ...values.map(Math.abs))
}

function frozenColumns(state: ConservativeStockColumns): ConservativeStockColumns {
  return Object.freeze({ ...state, bounds: Object.freeze(copyBounds(state.bounds)),
    warnings: Object.freeze([...state.warnings]), topZ: Object.freeze([...state.topZ]) })
}

export function createConservativeStockColumns(
  bounds: Readonly<Box3>, resolutionMm: number, maxColumns = DEFAULT_CELL_BUDGET,
): ConservativeStockColumns {
  assertBox(bounds, 'ConservativeStock.bounds')
  // Reuse budget policy, NEVER its Float32 material samples (which can round
  // downward). Correct its center-grid epsilon at a whole-cell boundary.
  let grid = ZDexelField.fromBox(bounds, resolutionMm, maxColumns)
  let nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / grid.cell))
  let ny = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / grid.cell))
  if (nx * ny > maxColumns) {
    grid = ZDexelField.fromBox(bounds, grid.cell * 1.02, maxColumns)
    nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / grid.cell))
    ny = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / grid.cell))
  }
  const allowance = numericalAllowance(Object.values(bounds))
  if (grid.cell <= allowance * 8 || nx * ny > maxColumns) {
    throw new Error('Conservative stock resolution cannot be bounded numerically.')
  }
  const warnings = grid.cell > resolutionMm
    ? [`Cell budget (${maxColumns}) forced coarsening to ${grid.cell} mm.`] : []
  return frozenColumns({ representation: 'full-cell-upper-envelope-v1', bounds,
    resolutionMm: grid.cell, requestedResolutionMm: resolutionMm, nx, ny, warnings,
    roundingAllowanceMm: allowance, topZ: Array(nx * ny).fill(bounds.maxZ) })
}

function requireConservativeCut(cut: StockCut): void {
  const { move, cutter } = cut
  if (Object.values(move).some(v => !Number.isFinite(v)) ||
      !['x0', 'y0', 'z0', 'x1', 'y1', 'z1'].every(k => Number.isFinite(move[k as keyof LinearMove])) ||
      !['flat', 'ball'].includes(cutter.kind) || !Number.isFinite(cutter.diameter) || cutter.diameter <= 0) {
    throw new Error('Conservative stock requires finite linear moves and flat/ball cutters.')
  }
  if (move.z0 !== move.z1 && (move.x0 !== move.x1 || move.y0 !== move.y1)) {
    throw new Error('Conservative stock does not support ramps; supply a proven envelope backend.')
  }
}

/** Full-cell proof: distance to a segment is convex, so its maximum over a
 * rectangle is attained at a corner. The whole rectangle must be inside the
 * capsule. For a ball use the highest profile on that rectangle. Numerical
 * slack shrinks removal and raises its envelope. No center-only clearance. */
export function applyConservativeStockOperation(
  state: ConservativeStockColumns, cuts: readonly StockCut[],
): ConservativeStockColumns {
  const tops = [...state.topZ]
  let roundingAllowanceMm = state.roundingAllowanceMm
  for (const cut of cuts) {
    requireConservativeCut(cut)
    const { move: m, cutter } = cut
    const radius = cutter.diameter / 2
    const eps = numericalAllowance([...Object.values(m), radius, ...Object.values(state.bounds)])
    if (state.resolutionMm <= eps * 8 || radius <= eps * 8) {
      throw new Error('Conservative sweep precision cannot be bounded numerically.')
    }
    roundingAllowanceMm = Math.max(roundingAllowanceMm, eps)
    const dx = m.x1 - m.x0, dy = m.y1 - m.y0
    const length2 = dx * dx + dy * dy
    if (!Number.isFinite(length2) || !Number.isFinite(radius * radius)) {
      throw new Error('Conservative sweep arithmetic cannot be bounded numerically.')
    }
    const distance = (x: number, y: number) => {
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - m.x0) * dx + (y - m.y0) * dy) / length2))
      return Math.hypot(x - m.x0 - t * dx, y - m.y0 - t * dy)
    }
    for (let j = 0; j < state.ny; j++) {
      const y0 = state.bounds.minY + j * state.resolutionMm
      const y1 = Math.min(state.bounds.maxY, y0 + state.resolutionMm)
      if (y1 < Math.min(m.y0, m.y1) - radius || y0 > Math.max(m.y0, m.y1) + radius) continue
      for (let i = 0; i < state.nx; i++) {
        const x0 = state.bounds.minX + i * state.resolutionMm
        const x1 = Math.min(state.bounds.maxX, x0 + state.resolutionMm)
        const farthest = Math.max(distance(x0, y0), distance(x1, y0), distance(x0, y1), distance(x1, y1)) + eps
        if (farthest >= radius) continue
        const height = cutter.kind === 'ball' ? radius - Math.sqrt(radius * radius - farthest * farthest) : 0
        const envelope = Math.max(state.bounds.minZ, Math.min(m.z0, m.z1) + height + eps)
        if (!Number.isFinite(envelope)) throw new Error('Conservative sweep envelope must be finite.')
        const index = j * state.nx + i
        tops[index] = Math.min(tops[index], envelope)
      }
    }
  }
  return frozenColumns({ ...state, roundingAllowanceMm, topZ: tops })
}

/** Positive-volume box overlap; conservatively includes touching XY cells.
 * Highest queries return undefined outside stock and exact initial top for a
 * zero-height stock. Queries never use the legacy sampled traverse routine. */
export function highestConservativeStockOver(
  state: ConservativeStockColumns, region: Readonly<Box3>,
): number | undefined {
  assertBox(region, 'ConservativeStock.query')
  if (region.maxX < state.bounds.minX || region.minX > state.bounds.maxX ||
      region.maxY < state.bounds.minY || region.minY > state.bounds.maxY) return undefined
  const c = state.resolutionMm
  const i0 = Math.max(0, Math.ceil((region.minX - state.bounds.minX) / c) - 1)
  const i1 = Math.min(state.nx - 1, Math.floor((region.maxX - state.bounds.minX) / c))
  const j0 = Math.max(0, Math.ceil((region.minY - state.bounds.minY) / c) - 1)
  const j1 = Math.min(state.ny - 1, Math.floor((region.maxY - state.bounds.minY) / c))
  let top = state.bounds.minZ
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) top = Math.max(top, state.topZ[j * state.nx + i])
  return top
}

export function isConservativeStockRegionEmpty(state: ConservativeStockColumns, region: StockRegion): boolean {
  if (region.kind === 'swept-cutter') {
    requireConservativeCut(region)
    const { move: m, cutter } = region
    const r = cutter.diameter / 2 + state.roundingAllowanceMm
    // Enclose the whole cutter, including its flank. False non-clear is allowed;
    // no claim of tight swept-clearance fidelity is made by this representation.
    return isConservativeStockRegionEmpty(state, { kind: 'box', bounds: {
      minX: Math.min(m.x0, m.x1) - r, maxX: Math.max(m.x0, m.x1) + r,
      minY: Math.min(m.y0, m.y1) - r, maxY: Math.max(m.y0, m.y1) + r,
      minZ: Math.min(m.z0, m.z1) - state.roundingAllowanceMm,
      maxZ: Math.max(state.bounds.maxZ, m.z0, m.z1) + r,
    } })
  }
  const b = region.bounds
  assertBox(b, 'ConservativeStock.query')
  if (b.minX === b.maxX || b.minY === b.maxY || b.minZ === b.maxZ || b.maxZ <= state.bounds.minZ) return true
  const top = highestConservativeStockOver(state, b)
  return top === undefined || top <= state.bounds.minZ || top <= b.minZ
}
