// WO-3032 (alpha.3 A3-10b, parity): the polygon backend. For a 2D-only setup the
// remaining material is a region per Z level: the stock outline minus the union
// of the regions the cutting sweeps cleared at that level, by boolean
// subtraction through the kernel geometry service (read-only, injected: the
// caller hands in createGeometryService(<its backend>), so no WASM crosses the
// kernel boundary).
//
// A sweep clears level L where its cutter's lower surface reaches L: at XY
// distance d from the tip path when tipZ + height(d) <= L, i.e. within the
// radius the sweep shape has at height L - tipZ above its tip (flat: R once the
// tip is at or below L). Horizontal moves clear a capsule; a plunge clears a
// disc at its lowest tip; a ramp is cut into pieces no longer than half the
// resolution and each piece clears the capsule of its HIGHER end (removes no
// more than the tool). Capsules are inscribed polygons (vertices on the circle,
// chord error within the arc tolerance), so every cleared region lies inside
// what the tool swept: remaining material is never under-stated.
//
// Parity: the same replay the dexel backend runs (same operations, same replay
// cutter, same sweeps), so each level's region matches today's remainingAbove
// trace of the replayed field within one cell of its boundary.
import type { Loop, Loops, Path } from '../geometry/contracts'
import type { createGeometryService } from '../geometry'
import type { LinearMove, SweepShape } from './contracts'
import type { Box3 } from './dexel'
import { PARITY_POLICY, type MaterialPolicy } from './policy'
import { cuttingSweeps, notReplayedReason, PARITY_REPLAY, replayCutterFor, type MaterialOperation } from './replay'

export type GeometryService = ReturnType<typeof createGeometryService>

export interface PolygonMaterial {
  readonly backend: 'polygon'
  readonly stock: Readonly<Box3>
  /** World Z of each level, as the caller asked. */
  readonly levels: readonly number[]
  /** Remaining region at each level (geometry-service loops; empty = nothing left there). */
  readonly regions: readonly Loops[]
  readonly operationsReplayed: number
  readonly notes: readonly string[]
}

export interface PolygonOptions {
  /** Ramp pieces are no longer than half of this; today's replay resolution by default. */
  readonly resolutionMm?: number
  /** Chord error of the inscribed capsule polygons, mm. */
  readonly arcToleranceMm?: number
}

function stockLoop(stock: Box3): Loop {
  return [{ x: stock.minX, y: stock.minY }, { x: stock.maxX, y: stock.minY }, { x: stock.maxX, y: stock.maxY }, { x: stock.minX, y: stock.maxY }]
}

/** The full stock block at every level that lies inside it (a level at or above the top holds nothing). */
export function polygonFromBox(stock: Box3, levels: readonly number[]): PolygonMaterial {
  for (const z of levels) if (!Number.isFinite(z)) throw new Error(`polygon material: level ${z} must be finite.`)
  return Object.freeze({
    backend: 'polygon', stock: Object.freeze({ ...stock }), levels: Object.freeze([...levels]),
    regions: Object.freeze(levels.map(z => (z < stock.maxZ && z >= stock.minZ ? [stockLoop(stock)] : []))),
    operationsReplayed: 0, notes: Object.freeze([]),
  })
}

/** Radius at which the shape's lower surface sits `dh` above its tip; -1 where it does not reach. */
export function radiusAtHeight(shape: SweepShape, dh: number): number {
  const R = shape.radius
  if (!(dh >= 0)) return -1
  switch (shape.kind) {
    case 'flat': return R
    case 'ball': return dh >= R ? R : Math.sqrt(dh * (2 * R - dh))
    case 'bull': {
      const c = shape.cornerRadius
      return dh >= c ? R : (R - c) + Math.sqrt(dh * (2 * c - dh))
    }
    case 'cone': {
      if (!(shape.coneHeight > 0) || dh >= shape.coneHeight) return R
      return shape.tipRadius + dh * (R - shape.tipRadius) / shape.coneHeight
    }
    default: {
      const { zs, rs } = shape
      if (dh < zs[0]) return -1
      for (let k = 0; k < zs.length - 1; k++) {
        if (dh <= zs[k + 1]) return zs[k + 1] === zs[k] ? rs[k + 1] : rs[k] + (rs[k + 1] - rs[k]) * ((dh - zs[k]) / (zs[k + 1] - zs[k]))
      }
      return rs[rs.length - 1]
    }
  }
}

/** Inscribed polygon of the capsule of radius r around segment a-b (a disc when a = b), counter-clockwise. */
export function capsule(ax: number, ay: number, bx: number, by: number, r: number, arcToleranceMm: number): Loop {
  const tol = Math.min(arcToleranceMm, r)
  const half = Math.max(4, Math.ceil(Math.PI / Math.acos(1 - tol / r)))
  const len = Math.hypot(bx - ax, by - ay)
  const phi = len > 0 ? Math.atan2(by - ay, bx - ax) : 0
  const out: Loop = []
  if (len === 0) {
    for (let k = 0; k < 2 * half; k++) {
      const t = phi + (Math.PI * k) / half
      out.push({ x: ax + r * Math.cos(t), y: ay + r * Math.sin(t) })
    }
    return out
  }
  for (let k = 0; k <= half; k++) {
    const t = phi - Math.PI / 2 + (Math.PI * k) / half
    out.push({ x: bx + r * Math.cos(t), y: by + r * Math.sin(t) })
  }
  for (let k = 0; k <= half; k++) {
    const t = phi + Math.PI / 2 + (Math.PI * k) / half
    out.push({ x: ax + r * Math.cos(t), y: ay + r * Math.sin(t) })
  }
  return out
}

/** The pieces of a tip move with the tip height each clears at (a ramp's piece clears at its higher end). */
function pieces(move: LinearMove, resolutionMm: number): { ax: number; ay: number; bx: number; by: number; z: number }[] {
  const dx = move.x1 - move.x0, dy = move.y1 - move.y0, dz = move.z1 - move.z0
  if (dx === 0 && dy === 0) return [{ ax: move.x0, ay: move.y0, bx: move.x0, by: move.y0, z: Math.min(move.z0, move.z1) }]
  if (dz === 0) return [{ ax: move.x0, ay: move.y0, bx: move.x1, by: move.y1, z: move.z0 }]
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (resolutionMm / 2)))
  const out = []
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n
    out.push({ ax: move.x0 + t0 * dx, ay: move.y0 + t0 * dy, bx: move.x0 + t1 * dx, by: move.y0 + t1 * dy,
      z: Math.max(move.z0 + t0 * dz, move.z0 + t1 * dz) })
  }
  return out
}

/** Subtract a batch of sweeps from every level: one boolean difference per level that a sweep reaches. */
export function subtractSweeps(service: GeometryService, material: PolygonMaterial,
  sweeps: readonly { readonly move: LinearMove; readonly shape: SweepShape }[], options: PolygonOptions = {}): PolygonMaterial {
  const resolution = options.resolutionMm ?? PARITY_REPLAY.cellMm
  const tol = options.arcToleranceMm ?? 0.01
  const split = sweeps.map(s => ({ shape: s.shape, parts: pieces(s.move, resolution) }))
  const regions = material.levels.map((level, index) => {
    const region = material.regions[index]
    if (region.length === 0) return region
    const clip: Path[] = []
    for (const { shape, parts } of split) {
      for (const p of parts) {
        const r = radiusAtHeight(shape, level - p.z)
        if (r > 0) clip.push({ id: `c${clip.length}`, closed: true, points: capsule(p.ax, p.ay, p.bx, p.by, r, tol) })
      }
    }
    if (clip.length === 0) return region
    const subject: Path[] = region.map((points, i) => ({ id: `r${i}`, closed: true, points }))
    const result = service.boolean(subject, clip, 'difference')
    if (result.status === 'rejected' || result.status === 'unsupported' || result.value === null) {
      throw new Error(`polygon material: the geometry service could not subtract at z ${level} (${result.diagnostics.map(d => d.message).join('; ')}).`)
    }
    return result.value
  })
  return Object.freeze({ ...material, regions: Object.freeze(regions) })
}

/**
 * snapshotAfter(N) on the polygon backend: the same replay as the dexel
 * backend (enabled, ready operations in order, today's replay cutter, cutting
 * sweeps at a quarter-resolution sagitta, drill flats lifted by their point).
 */
export function polygonSnapshotAfter(service: GeometryService, stock: Box3, levels: readonly number[],
  chain: readonly MaterialOperation[], n: number, policy: MaterialPolicy = PARITY_POLICY, options: PolygonOptions = {}): PolygonMaterial {
  const resolution = options.resolutionMm ?? PARITY_REPLAY.cellMm
  let material = polygonFromBox(stock, levels)
  let replayed = 0
  const notes: string[] = []
  for (let i = 0; i <= n && i < chain.length; i++) {
    const operation = chain[i]
    const why = notReplayedReason(operation, policy)
    if (why) { notes.push(`${operation.id}: ${why}`); continue }
    const cutter = replayCutterFor(operation, policy)!
    let sweeps: LinearMove[]
    try {
      sweeps = cuttingSweeps(operation.moves!, resolution * PARITY_REPLAY.sagittaCells)
    } catch (err) {
      notes.push(`${operation.id}: result could not be read (${err instanceof Error ? err.message : String(err)}): treated as not cut`)
      continue
    }
    const lifted = sweeps.map(m => cutter.liftMm > 0 ? { ...m, z0: m.z0 + cutter.liftMm, z1: m.z1 + cutter.liftMm } : m)
    material = subtractSweeps(service, material, lifted.map(move => ({ move, shape: cutter.shape })), options)
    replayed++
  }
  return Object.freeze({ ...material, operationsReplayed: replayed, notes: Object.freeze(notes) })
}

/** Net area of a region (counter-clockwise outers positive, clockwise holes negative). */
export function regionArea(loops: Loops): number {
  let area = 0
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) area += (loop[j].x + loop[i].x) * (loop[j].y - loop[i].y)
  }
  return -area / 2
}

/** Total boundary length of a region. */
export function regionPerimeter(loops: Loops): number {
  let length = 0
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) length += Math.hypot(loop[i].x - loop[j].x, loop[i].y - loop[j].y)
  }
  return length
}
