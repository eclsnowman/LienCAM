/** WO-2505 experiment only. Not registered as a Model operation.
 *
 * A surface cover must enclose EVERY point of the final trimmed boundary,
 * including seams, holes, location transforms and any healing movement.
 * Witness boxes must each contain at least one point of that boundary.
 * Neither display tessellation nor a requested deflection establishes this
 * contract. The installed kernel has no such cover exporter; see the explicit
 * incomplete result in checkKernelBodyDeviation rather than silently sampling.
 */
import type { OcctKernel, ShapeHandle } from 'occt-wasm'

export type Point3 = readonly [number, number, number]
export interface SurfaceBox { min: Point3; max: Point3 }
export interface SurfaceCover {
  cells: readonly SurfaceBox[]
  witnesses: readonly SurfaceBox[]
}
export interface DirectedBound { lowerMm: number; upperMm: number }
export interface TwoWayBound {
  status: 'within-limit' | 'outside-limit' | 'inconclusive'
  originalToCandidate: DirectedBound
  candidateToOriginal: DirectedBound
  maximum: DirectedBound
  withinLimit: boolean
}

const float = new DataView(new ArrayBuffer(8))
/** Adjacent binary64 value: outward rounding, also for subnormal coordinates. */
function next(value: number, up: boolean): number {
  if (Number.isNaN(value) || value === (up ? Infinity : -Infinity)) return value
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE
  float.setFloat64(0, value)
  const bits = float.getBigUint64(0)
  float.setBigUint64(0, bits + ((value > 0) === up ? 1n : -1n))
  return float.getFloat64(0)
}

function validateCover(cover: SurfaceCover): void {
  if (!cover.cells.length || !cover.witnesses.length) throw new Error('Empty boundary cover or witness set')
  for (const b of [...cover.cells, ...cover.witnesses]) {
    if (b.min.length !== 3 || b.max.length !== 3 || b.min.some((v, axis) =>
      !Number.isFinite(v) || !Number.isFinite(b.max[axis]) || v > b.max[axis])) {
      throw new Error('Invalid boundary enclosure')
    }
  }
}

function boxDistance(a: SurfaceBox, b: SurfaceBox, upper: boolean): number {
  let squared = 0
  for (let axis = 0; axis < 3; axis++) {
    const gap = upper
      ? Math.max(0, next(a.max[axis] - b.min[axis], true),
        next(b.max[axis] - a.min[axis], true))
      : Math.max(0, next(a.min[axis] - b.max[axis], false), next(b.min[axis] - a.max[axis], false))
    const term = next(gap * gap, upper)
    squared = Math.max(0, next(squared + term, upper))
  }
  return Math.max(0, next(Math.sqrt(squared), upper))
}

/** Upper: every source cell to a target boundary witness (not a nearest-point
 * assumption). Lower: source witnesses to the COMPLETE target enclosure union.
 * Extra untrimmed coverage loosens the answer but cannot hide an unsampled peak.
 * Refinement belongs to the cover provider; inconclusive covers never approve.
 */
function directed(source: SurfaceCover, target: SurfaceCover): DirectedBound {
  let upperMm = 0, lowerMm = 0
  for (const cell of source.cells) {
    let best = Infinity
    for (const witness of target.witnesses) best = Math.min(best, boxDistance(cell, witness, true))
    upperMm = Math.max(upperMm, best)
  }
  for (const witness of source.witnesses) {
    let best = Infinity
    for (const cell of target.cells) best = Math.min(best, boxDistance(witness, cell, false))
    lowerMm = Math.max(lowerMm, best)
  }
  return { lowerMm, upperMm }
}

export function boundTwoWayDeviation(original: SurfaceCover, candidate: SurfaceCover, limitMm: number): TwoWayBound {
  if (!Number.isFinite(limitMm) || limitMm < 0) throw new Error('Invalid deviation limit')
  validateCover(original)
  validateCover(candidate)
  const originalToCandidate = directed(original, candidate)
  const candidateToOriginal = directed(candidate, original)
  const maximum = {
    lowerMm: Math.max(originalToCandidate.lowerMm, candidateToOriginal.lowerMm),
    upperMm: Math.max(originalToCandidate.upperMm, candidateToOriginal.upperMm),
  }
  const withinLimit = maximum.upperMm <= limitMm
  return { status: withinLimit ? 'within-limit' : maximum.lowerMm > limitMm ? 'outside-limit' : 'inconclusive',
    originalToCandidate, candidateToOriginal, maximum, withinLimit }
}

export type KernelDeviation =
  | { status: 'verified-identical'; maximum: DirectedBound; withinLimit: true; originalFaces: number; candidateFaces: number }
  | { status: 'inconclusive'; maximum: null; withinLimit: false; originalFaces: number; candidateFaces: number;
      originalUncoveredFaces: number; candidateUncoveredFaces: number; reason: string }

/** The only current kernel certificate is exact surface identity. We compare
 * complete face BREP records, including trims and locations, with precision-17
 * serialization; a missed identity is inconclusive, never an approximate match.
 * Both set inclusions are necessary: removing a face or adding a distant face
 * must not pass just because the remaining faces match.
 *
 * Consumer census: this new experimental API is consumed only by the WO-2505
 * test/experiment. GeomService, geom-worker dispatch, replay, preview, CAM and
 * Model UI have no call route. No existing state/phase condition is altered.
 */
export function checkKernelBodyDeviation(k: OcctKernel, original: ShapeHandle, candidate: ShapeHandle, limitMm: number): KernelDeviation {
  if (!Number.isFinite(limitMm) || limitMm < 0) throw new Error('Invalid deviation limit')
  const a = k.getSubShapes(original, 'face')
  const b = k.getSubShapes(candidate, 'face')
  try {
    if (!a.length || !b.length) throw new Error('Expected nonempty body boundaries')
    const aRecords = a.map(f => k.toBREP(f)), bRecords = b.map(f => k.toBREP(f))
    const aSet = new Set(aRecords), bSet = new Set(bRecords)
    const originalUncoveredFaces = aRecords.filter(s => !bSet.has(s)).length
    const candidateUncoveredFaces = bRecords.filter(s => !aSet.has(s)).length
    if (!originalUncoveredFaces && !candidateUncoveredFaces) {
      return { status: 'verified-identical', maximum: { lowerMm: 0, upperMm: 0 }, withinLimit: true,
        originalFaces: a.length, candidateFaces: b.length }
    }
    return { status: 'inconclusive', maximum: null, withinLimit: false, originalFaces: a.length, candidateFaces: b.length,
      originalUncoveredFaces, candidateUncoveredFaces,
      reason: 'Changed trimmed faces need a complete conservative surface-cell cover and verified boundary witnesses. '
        + 'The installed kernel exports neither; sampled distances, volume and requested mesh deflection cannot certify the maximum.' }
  } finally {
    for (const f of [...a, ...b]) k.release(f)
  }
}
