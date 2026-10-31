import type { ToolpathMove } from '../../types'
import { samplePath } from './metrics'
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'

export interface Point { x: number; y: number }
export interface Region { outer: Point[]; islands: Point[][] }
export interface QualityLevel {
  z: number
  maximumEngagementRatio: number
  p99EngagementRatio: number
  residualAreaMm2: number
  maximumWallExcursionMm: number
  sampledAreaMm2: number
}

export function polygonArea(loop: readonly Point[]): number {
  return Math.abs(loop.reduce((a, p, i) => {
    const q = loop[(i + 1) % loop.length]
    return a + p.x * q.y - p.y * q.x
  }, 0)) / 2
}

function inside(p: Point, loop: readonly Point[]): boolean {
  let hit = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

function distance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

/** Independent raster material, capsule sweeps, and analytic polygon-wall distance.
 * No engine stock, engagement, clipping or diagnostics are consulted.
 * Engagement is the total fresh-material arc on the cutter circumference in radians,
 * measured before each sweep; entries are included. P99 is sample-count weighted.
 * Residual is cell-centre quadrature, NOT an exact polygon area. Record resolution
 * and a half-cell convergence run with every baseline. Walls have no raster tolerance.
 * Arc linearization is reused from metrics.samplePath (0.25 mm arc spacing).
 */
export function adaptiveQualityOracle(input: {
  moves: readonly ToolpathMove[]; radius: number; region: Region; targetEngagement: number
  /** Authored floor schedule when published horizontal feeds also include lifted links. */
  levels?: readonly number[]
  cellMm?: number; spacingMm?: number; angularSamples?: number
}): QualityLevel[] {
  const { moves, radius, region, targetEngagement } = input
  const cell = input.cellMm ?? 0.1, spacing = input.spacingMm ?? 0.2, angles = input.angularSamples ?? 360
  if (!(radius > 0 && targetEngagement > 0 && cell > 0 && spacing > 0 && angles >= 4)) throw new Error('Invalid oracle resolution or cutter')
  const inRegion = (p: Point) => inside(p, region.outer) && !region.islands.some(loop => inside(p, loop))
  const x0 = Math.min(...region.outer.map(p => p.x)), y0 = Math.min(...region.outer.map(p => p.y))
  const nx = Math.ceil((Math.max(...region.outer.map(p => p.x)) - x0) / cell)
  const ny = Math.ceil((Math.max(...region.outer.map(p => p.y)) - y0) / cell)
  const original = new Uint8Array(nx * ny)
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    original[y * nx + x] = Number(inRegion({ x: x0 + (x + 0.5) * cell, y: y0 + (y + 0.5) * cell }))
  }
  const samples = samplePath(moves, spacing)
  // Horizontal published cuts define machining levels. The emitter also publishes
  // zero-distance helix anchors at the entry height: those are not machining levels.
  // Native fork feeds include LINK_LIFT traverses. An explicit authored schedule
  // selects measurement planes without discarding those feeds from stock removal.
  const levels = [...new Set(input.levels ?? moves.flatMap((m, i) => i && isStockCuttingRole(effectiveMoveRole(m)) && m.z < 0 &&
    Math.hypot(m.x - moves[i - 1].x, m.y - moves[i - 1].y) > 1e-8 &&
    Math.abs(m.z - moves[i - 1].z) < 1e-8 ? [Number(m.z.toFixed(6))] : []))].sort((a, b) => b - a)
  if (!levels.every(Number.isFinite)) throw new Error('Invalid authored level')
  const rim = Array.from({ length: angles }, (_, i) => ({ x: radius * Math.cos(i * 2 * Math.PI / angles), y: radius * Math.sin(i * 2 * Math.PI / angles) }))
  return levels.map(z => {
    const stock = original.slice(), ratios: number[] = []
    let excursion = 0
    for (let i = 1; i < samples.length; i++) {
      const p = samples[i], prev = samples[i - 1]
      if (!p.cutting || p.z > z + 1e-7) continue
      // If descending through this level, start at the crossing, not above it.
      const t = prev.z > z && prev.z !== p.z ? (z - p.z) / (prev.z - p.z) : 1
      const a = { x: p.x + t * (prev.x - p.x), y: p.y + t * (prev.y - p.y) }
      let engaged = 0
      for (const r of rim) {
        const q = { x: p.x + r.x, y: p.y + r.y }
        const x = Math.floor((q.x - x0) / cell), y = Math.floor((q.y - y0) / cell)
        if (x >= 0 && x < nx && y >= 0 && y < ny && inRegion(q) && stock[y * nx + x]) engaged++
      }
      ratios.push(engaged * 2 * Math.PI / angles / targetEngagement)
      const wallDistance = Math.min(...[region.outer, ...region.islands].map(loop =>
        Math.min(...loop.map((v, j) => distance(p, v, loop[(j + 1) % loop.length])))))
      excursion = Math.max(excursion, radius + (inRegion(p) ? -wallDistance : wallDistance))
      const minX = Math.max(0, Math.floor((Math.min(a.x, p.x) - radius - x0) / cell))
      const maxX = Math.min(nx - 1, Math.ceil((Math.max(a.x, p.x) + radius - x0) / cell))
      const minY = Math.max(0, Math.floor((Math.min(a.y, p.y) - radius - y0) / cell))
      const maxY = Math.min(ny - 1, Math.ceil((Math.max(a.y, p.y) + radius - y0) / cell))
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const index = y * nx + x
        if (stock[index] && distance({ x: x0 + (x + 0.5) * cell, y: y0 + (y + 0.5) * cell }, a, p) <= radius) stock[index] = 0
      }
    }
    ratios.sort((a, b) => a - b)
    return { z, maximumEngagementRatio: ratios.at(-1) ?? 0,
      p99EngagementRatio: ratios[Math.max(0, Math.ceil(ratios.length * 0.99) - 1)] ?? 0,
      residualAreaMm2: stock.reduce((a, b) => a + b, 0) * cell * cell,
      sampledAreaMm2: original.reduce((a, b) => a + b, 0) * cell * cell,
      maximumWallExcursionMm: excursion }
  })
}
