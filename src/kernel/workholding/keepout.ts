// Keep-out at a cutting level (A3-19 algorithm steps 2 and 3), at parity with
// src/lib/cam/adaptiveClearing2d/engine/workholdingIsland.ts (WO-1579, WO-1618).
// The footprint is read off the same solid column grid the reach trim tests; each
// occupied column's cell is grown by the allowance, the cell's half-diagonal and a
// margin for the offsetter's chord tolerance. Every boolean and offset runs through
// the WO-2931 geometry service on the injected face backend: one keyhole path per
// union, Positive fill, exactly as today's engine does it.

import { signedArea } from '../geometry/predicates'
import type { Point } from '../geometry/contracts'
import type { createGeometryService } from '../geometry'
import type { DepthBand, DepthBandRequest, KeepOutLevel, ObstacleColumns, ReducedRegion } from './contracts'

type Geometry = ReturnType<typeof createGeometryService>

/** Below clipper's half-unit threshold at its 6-decimal precision: union only. */
const UNION_ONLY_DELTA_MM = 2e-7
/** The offsetter's round-join and decimation tolerance plus a planner's chord sampling. */
export const ISLAND_MARGIN_MM = 0.05
/** A region piece smaller than this is left out rather than planned. */
const MIN_PIECE_AREA_MM2 = 1e-3
/** An added floor sits this far above the tool-tip allowance over a workholding top. */
const FLOOR_MARGIN_MM = 0.001

export function allowanceOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function createKeepOuts(geometry: Geometry) {
  if (geometry.profile.id !== 'face') throw new Error('Workholding kernel: the Face compatibility geometry profile is required.')

  const offset = (loop: Point[], delta: number): Point[][] => {
    const result = geometry.offset([{ id: 'workholding', closed: true, points: loop }], delta)
    if (result.status === 'rejected' || result.status === 'unsupported' || !result.value) {
      throw new Error(`Workholding kernel: offset failed - ${result.diagnostics.map(d => d.message).join('; ')}`)
    }
    return result.value
  }

  /** Positive-fill union of loops as one keyhole path; a frame square far to +X keeps
   * the path's net winding positive and is dropped from the answer. */
  const unionPositive = (loops: readonly Point[][]): Point[][] => {
    const usable = loops.filter(loop => loop.length >= 3)
    if (usable.length === 0) return []
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let totalArea = 0
    for (const loop of usable) {
      for (const p of loop) { maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y) }
      totalArea += Math.abs(signedArea(loop))
    }
    const frameX = maxX + 10
    const side = Math.sqrt(totalArea) + 10
    const frame: Point[] = [
      { x: frameX, y: minY }, { x: frameX + side, y: minY },
      { x: frameX + side, y: minY + side }, { x: frameX, y: minY + side },
    ]
    const hub = usable[0][0]
    const path: Point[] = []
    for (const loop of [...usable, frame]) {
      for (const p of loop) path.push(p)
      path.push(loop[0])
      path.push(hub)
    }
    return offset(path, UNION_ONLY_DELTA_MM).filter(loop => !loop.every(p => p.x > frameX - 1))
  }

  const fromColumns = (columnSets: readonly (ObstacleColumns | null)[], bottomZ: number, topZ: number, allowance: number): Point[][] => {
    const keepOuts: Point[][] = []
    for (const columns of columnSets) {
      if (!columns) continue
      const { originX, originY, cell, nx, ny, spanStart, spanZ } = columns
      const occupied = (column: number): boolean => {
        for (let k = spanStart[column]; k < spanStart[column + 1]; k += 2) {
          if (spanZ[k] < topZ && spanZ[k + 1] > bottomZ) return true
        }
        return false
      }
      // One rectangle per run of occupied columns in a row.
      const cells: Point[][] = []
      for (let j = 0; j < ny; j++) {
        const y0 = originY + j * cell
        const y1 = y0 + cell
        let runStart = -1
        for (let i = 0; i <= nx; i++) {
          const on = i < nx && occupied(j * nx + i)
          if (on && runStart < 0) runStart = i
          if (!on && runStart >= 0) {
            const x0 = originX + runStart * cell
            const x1 = originX + i * cell
            cells.push([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }])
            runStart = -1
          }
        }
      }
      if (cells.length === 0) continue
      const grow = allowance + cell * Math.SQRT1_2 + ISLAND_MARGIN_MM
      // A hole in the footprint (a ring-shaped clamp) is filled: kept clear of, never cut into.
      for (const outline of unionPositive(cells).filter(loop => signedArea(loop) > 0)) {
        for (const grown of offset(outline, grow)) {
          if (signedArea(grown) > 0) keepOuts.push(grown)
        }
      }
    }
    return keepOuts
  }

  const netArea = (loops: readonly Point[][]) => loops.reduce((area, loop) => area + signedArea(loop), 0)

  return {
    /** Footprint islands for one cutting window, CCW; empty when nothing reaches into it. */
    atLevel(columns: readonly (ObstacleColumns | null)[], level: KeepOutLevel): Point[][] {
      return fromColumns(columns, level.bottomZ, level.topZ, allowanceOf(level.allowanceMm))
    },

    /** Depths grouped into bands sharing one footprint; a floor is added just above a
     * newly reached workholding top so the band above cuts down to it (WO-1618). */
    depthBands(columns: readonly (ObstacleColumns | null)[], request: DepthBandRequest): DepthBand[] {
      const allowance = allowanceOf(request.allowanceMm)
      const topSet = new Set<number>()
      for (const c of columns) {
        if (!c) continue
        for (let k = 0; k + 1 < c.spanZ.length; k += 2) {
          if (c.spanZ[k] < request.topZ) topSet.add(c.spanZ[k + 1])
        }
      }
      const tops = [...topSet].sort((a, b) => b - a)
      const reachedCount = (depth: number): number => {
        let n = 0
        while (n < tops.length && tops[n] > depth - allowance) n++
        return n
      }
      const bands: { depths: number[]; count: number; addedFloorZ?: number; workholdingTopZ?: number }[] = []
      for (const depth of request.depths) {
        const count = reachedCount(depth)
        const last = bands[bands.length - 1]
        if (last && last.count === count) {
          last.depths.push(depth)
          continue
        }
        if (last) {
          const top = tops[last.count]
          const floor = top + allowance + FLOOR_MARGIN_MM
          const above = last.depths[last.depths.length - 1]
          if (floor < above - FLOOR_MARGIN_MM && floor > depth) {
            last.depths.push(floor)
            last.addedFloorZ = floor
            last.workholdingTopZ = top
          }
        }
        bands.push({ depths: [depth], count })
      }
      const byCount = new Map<number, Point[][]>()
      return bands.map(band => {
        let keepOuts = byCount.get(band.count)
        if (!keepOuts) {
          keepOuts = band.count === 0
            ? []
            : fromColumns(columns, band.depths[band.depths.length - 1] - allowance, request.topZ, allowance)
          byCount.set(band.count, keepOuts)
        }
        return {
          depths: band.depths,
          keepOuts,
          ...(band.addedFloorZ !== undefined ? { addedFloorZ: band.addedFloorZ, workholdingTopZ: band.workholdingTopZ } : {}),
        }
      })
    },

    /** The region (outers CCW, holes CW) less the keep-outs; null when none touches it. */
    reduceRegion(regionLoops: readonly Point[][], keepOuts: readonly Point[][]): ReducedRegion | null {
      if (keepOuts.length === 0 || regionLoops.length === 0) return null
      const before = netArea(regionLoops)
      const reversed = keepOuts.map(loop => (signedArea(loop) > 0 ? [...loop].reverse() : loop))
      const loops = unionPositive([...regionLoops, ...reversed])
        .filter(loop => Math.abs(signedArea(loop)) >= MIN_PIECE_AREA_MM2)
      const removed = before - netArea(loops)
      if (removed <= MIN_PIECE_AREA_MM2) return null
      return { loops, removedAreaMm2: removed }
    },

    /** Where the tool CENTRE may not go: each island grown by the tool radius (step 2,
     * "inflated by tool radius plus allowance"; the allowance is already in the island).
     * Today the family planner applies this radius itself; nothing calls this yet. */
    toolCentre(keepOuts: readonly Point[][], toolRadiusMm: number): Point[][] {
      if (!(toolRadiusMm > 0)) return keepOuts.map(loop => loop.map(p => ({ ...p })))
      return keepOuts.flatMap(loop => offset(loop, toolRadiusMm)).filter(loop => signedArea(loop) > 0)
    },
  }
}
