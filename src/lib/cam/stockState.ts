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
