import type { ModelBodyDisplay } from '../../types'

const FINGERPRINT_SCALE = 100_000
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const FNV_MASK = 0xffffffffffffffffn

function quantized(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error('Model body display contains a non-finite coordinate.')
  }
  return Math.round(value * FINGERPRINT_SCALE).toString()
}

function pointKey(values: readonly number[], pointIndex: number): string {
  const offset = pointIndex * 3
  if (
    !Number.isInteger(pointIndex)
    || pointIndex < 0
    || offset + 2 >= values.length
  ) {
    throw new Error(`Model body display references invalid point index ${pointIndex}.`)
  }
  return [
    quantized(values[offset]),
    quantized(values[offset + 1]),
    quantized(values[offset + 2]),
  ].join(',')
}

function updateHash(hash: bigint, value: string): bigint {
  let next = hash
  for (let i = 0; i < value.length; i += 1) {
    next ^= BigInt(value.charCodeAt(i))
    next = (next * FNV_PRIME) & FNV_MASK
  }
  return next
}

/**
 * Stable geometry-content fingerprint for a modeled body's tessellation.
 *
 * Triangle order, winding, vertex order within a triangle, edge order, and
 * edge direction do not affect the result. Coordinates are quantized to
 * 0.00001 mm so harmless serialization noise cannot stale a section.
 */
export function modelBodyGeometryFingerprint(display: ModelBodyDisplay): string {
  if (display.positions.length % 3 !== 0 || display.indices.length % 3 !== 0) {
    throw new Error('Model body display has incomplete triangle data.')
  }
  if (display.edgePositions.length % 3 !== 0) {
    throw new Error('Model body display has incomplete edge point data.')
  }

  const triangles: string[] = []
  for (let i = 0; i < display.indices.length; i += 3) {
    triangles.push([
      pointKey(display.positions, display.indices[i]),
      pointKey(display.positions, display.indices[i + 1]),
      pointKey(display.positions, display.indices[i + 2]),
    ].sort().join(';'))
  }
  triangles.sort()

  const edges: string[] = []
  for (let i = 0; i + 1 < display.edgeOffsets.length; i += 1) {
    const start = display.edgeOffsets[i]
    const end = display.edgeOffsets[i + 1]
    if (
      !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 0
      || end < start
      || end * 3 > display.edgePositions.length
    ) {
      throw new Error(`Model body display contains invalid edge offsets at edge ${i}.`)
    }
    const points: string[] = []
    for (let pointIndex = start; pointIndex < end; pointIndex += 1) {
      points.push(pointKey(display.edgePositions, pointIndex))
    }
    const forward = points.join(';')
    const reverse = points.slice().reverse().join(';')
    edges.push(forward <= reverse ? forward : reverse)
  }
  edges.sort()

  const bbox = [
    ...display.bbox.min.map(quantized),
    ...display.bbox.max.map(quantized),
  ].join(',')

  let hash = FNV_OFFSET
  hash = updateHash(hash, `v1|bbox:${bbox}|triangles:${triangles.length}|`)
  for (const triangle of triangles) hash = updateHash(hash, `${triangle}|`)
  hash = updateHash(hash, `edges:${edges.length}|`)
  for (const edge of edges) hash = updateHash(hash, `${edge}|`)
  return `mbf1:${hash.toString(16).padStart(16, '0')}`
}
