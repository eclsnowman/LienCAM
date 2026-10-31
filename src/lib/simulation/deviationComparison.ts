import { sameFrame, type FrameRef } from '../geometry/coordinateFrames'
import type { StockSurface } from '../cam/operationStockAuthority'

export type DeviationKind = 'gouge' | 'residual' | 'match' | 'possible-residual' | 'unknown'
export interface TargetSurface {
  readonly frame: FrameRef<'world'>
  /** Highest intended triangle intersection in world mm; null where nothing is
   * intended (outside the footprint). WO-3096: bounded stock there is excess. */
  topAt(x: number, y: number): number | null
}
export interface DeviationCell {
  readonly x: number; readonly y: number; readonly width: number; readonly height: number
  readonly stockZ: number; readonly targetZ: number | null
  /** Signed upper bound: positive = possible excess; negative = missing. */
  readonly upperMm: number | null
  readonly lowerMm: number | null
  readonly kind: DeviationKind
}
export interface DeviationResult {
  readonly frame: FrameRef<'world'>
  readonly cells: readonly DeviationCell[]
  readonly counts: Readonly<Record<DeviationKind, number>>
  /** WO-3096: plan area per class (mm^2) and the material volume (mm^3) the
   * signed distance encloses: excess above the part, gouge cut into it. */
  readonly areas: Readonly<Record<DeviationKind, number>>
  readonly volumes: Readonly<{ residual: number; gouge: number }>
  readonly cellMm: number
  readonly sourceCellMm: number
  readonly elapsedMs: number
  readonly estimatedBytes: number
}
/** Interval control fixtures may supply bounded material evidence. The live
 * authority currently supplies null, never a guessed bound from sampling. */
export type ComparisonSurface = Omit<StockSurface, 'quality' | 'token'> & {
  /** Present on an authority surface; a point-sampled surface has none. */
  readonly token?: StockSurface['token']
  readonly quality: Omit<StockSurface['quality'], 'maxVerticalOverRetentionMm' | 'capability'> & {
    /** WO-3096: 'point-sample-v1' is exact at each sample within its bound. */
    readonly capability: StockSurface['quality']['capability'] | 'point-sample-v1'
    readonly maxVerticalOverRetentionMm: number | null
  }
}
export function classifyDeviation(upper: number, overRetention: number | null, toleranceMm: number, coarse = false): DeviationKind {
  if (upper < -toleranceMm) return 'gouge'
  if (overRetention === null || coarse) return upper > toleranceMm ? 'possible-residual' : 'unknown'
  if (upper - overRetention > toleranceMm) return 'residual'
  if (upper <= toleranceMm && upper - overRetention >= -toleranceMm) return 'match'
  return 'unknown'
}

/** At most 65,536 display cells. Coarse blocks take the MAX stock envelope;
 * they can lose gouge evidence but cannot invent it. Yield to cancel/input
 * edits between chunks; no comparison work belongs to playback frames. */
export async function compareDeviation(stock: ComparisonSurface, target: TargetSurface,
  options: { toleranceMm: number; maxCellMm: number; signal?: AbortSignal; maxCells?: number; maxMs?: number
    /** WO-3096: fraction of rows compared, 0..1. */
    onProgress?(fraction: number): void },
): Promise<DeviationResult> {
  const start = performance.now()
  const { toleranceMm, maxCellMm, signal } = options
  const budget = options.maxCells ?? 65_536
  if (!sameFrame(stock.frame, target.frame)) throw new Error('Intended geometry and stock frame mismatch.')
  if (!Number.isFinite(toleranceMm) || toleranceMm < 0 || !Number.isFinite(maxCellMm) || maxCellMm <= 0 ||
      !Number.isSafeInteger(budget) || budget < 1 || budget > 65_536) throw new Error('Invalid comparison resolution or tolerance.')
  if (stock.topZ.length !== stock.nx * stock.ny || stock.cellMm <= 0) throw new Error('Invalid stock surface.')
  const check = () => {
    signal?.throwIfAborted()
    if (performance.now() - start > (options.maxMs ?? 3000)) throw new Error('Comparison exceeded its 3 s time budget; use a smaller target.')
  }
  let stride = Math.max(1, Math.ceil(Math.sqrt(stock.nx * stock.ny / budget)))
  while (Math.ceil(stock.nx / stride) * Math.ceil(stock.ny / stride) > budget) stride++
  const cells: DeviationCell[] = []
  const counts: Record<DeviationKind, number> = { gouge: 0, residual: 0, match: 0, 'possible-residual': 0, unknown: 0 }
  const areas: Record<DeviationKind, number> = { gouge: 0, residual: 0, match: 0, 'possible-residual': 0, unknown: 0 }
  const volumes = { residual: 0, gouge: 0 }
  for (let j = 0; j < stock.ny; j += stride) {
    check()
    options.onProgress?.(j / stock.ny)
    for (let i = 0; i < stock.nx; i += stride) {
      if (cells.length >= budget) throw new Error('Comparison cell budget exceeded.')
      const x = stock.bounds.minX + i * stock.cellMm, y = stock.bounds.minY + j * stock.cellMm
      const width = Math.min(stride * stock.cellMm, stock.bounds.maxX - x)
      const height = Math.min(stride * stock.cellMm, stock.bounds.maxY - y)
      let stockZ = -Infinity
      for (let b = j; b < Math.min(stock.ny, j + stride); b++) for (let a = i; a < Math.min(stock.nx, i + stride); a++) {
        stockZ = Math.max(stockZ, stock.topZ[b * stock.nx + a])
      }
      const z = target.topAt(x + width / 2, y + height / 2)
      const targetZ = z !== null && Number.isFinite(z) ? z : null
      const bound = stock.quality.maxVerticalOverRetentionMm
      // WO-3096 (architect 2026-10-23, the owner's reference-comparison-1.png): with
      // bounded stock samples, material left where nothing is intended is
      // excess, measured down to the stock bottom; cut through, it is within
      // tolerance. An unbounded envelope proves no material there: unknown.
      const floorZ = targetZ ?? (bound !== null ? stock.bounds.minZ : null)
      const upperMm = floorZ !== null && Number.isFinite(stockZ) ? stockZ - floorZ : null
      const kind = upperMm === null ? 'unknown' : classifyDeviation(upperMm, bound, toleranceMm, stride * stock.cellMm > maxCellMm)
      const lowerMm = upperMm !== null && bound !== null ? upperMm - bound : null
      counts[kind]++
      areas[kind] += width * height
      if ((kind === 'residual' || kind === 'gouge') && upperMm !== null) volumes[kind] += width * height * Math.abs(upperMm)
      cells.push(Object.freeze({ x, y, width, height, stockZ, targetZ, upperMm, lowerMm, kind }))
      if (cells.length % 256 === 0) { check(); await new Promise<void>(resolve => setTimeout(resolve, 0)) }
    }
  }
  check()
  return Object.freeze({ frame: stock.frame, cells: Object.freeze(cells), counts: Object.freeze(counts),
    areas: Object.freeze(areas), volumes: Object.freeze(volumes),
    cellMm: stride * stock.cellMm, sourceCellMm: stock.cellMm, elapsedMs: performance.now() - start,
    estimatedBytes: cells.length * 640 + stock.topZ.length * 8 })
}

export interface FinalStockDomain {
  readonly authority: import('../cam/operationStockAuthority').OperationStockAuthority
  readonly frame: FrameRef<'world'>
  readonly finalOperationId: string
}
/** The adapter owns the canonical end boundary, including the last enabled
 * operation. The viewer must never replace it with last-op.id (before-last). */
export function readFinalStockSurface(domain: FinalStockDomain) {
  const read = domain.authority.readBefore({ beforeOperationId: domain.finalOperationId,
    frame: domain.frame, maxCellMm: Number.MAX_VALUE })
  if (read.status !== 'ready') return read
  const exported = domain.authority.exportSurface(read.token)
  return exported.status === 'ready' ? exported : { status: 'unavailable' as const, reason: exported.reason }
}
