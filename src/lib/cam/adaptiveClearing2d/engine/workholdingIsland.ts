// WO-1579: a clamp inside a clearing region is cleared around like an island.
//
// Pocket and Adaptive Clearing take the workholding's footprint out of the region
// BEFORE they plan, so the clearing routes around a strap clamp and still clears
// everything else, instead of the WO-1575 reach trim cutting stubs and gaps into a
// path planned straight through it. The trim still runs afterwards (the worker's
// single exit) and stays the guarantee for whatever the island cannot express - an
// overhang the holder reaches, a shank wider than the cutter.
//
// The footprint is read off the SAME solid column grid the trim tests
// (buildSolidColumns), so the two agree about where the jaw is: a column counts when
// it holds solid anywhere in the Z window the cutter sweeps. Each occupied column's
// cell is grown by the allowance plus the cell's half-diagonal (the slack the trim
// adds, since it tests column centres) plus a small margin for the offsetter's chord
// tolerance. The planner then keeps the tool centre its own radius off that grown
// footprint, which is the trim's cutter test with room to spare - so no stop follows.
//
// Both booleans run through face2d's clipper offsetter (the one the pocket worker
// already loads) as ONE keyhole path per operation: every loop is visited from a
// shared start point and returned to it, so the spokes cancel, and a zero-length
// offset of that path is a Positive-fill union of the loops. Outer loops wind CCW,
// holes and keep-outs CW, so the union's positive area is the region less the holes
// less the keep-outs - a keep-out that runs past the boundary included.

import { buildSolidColumns, type ClearanceMesh, type SolidColumns } from '../../holderClearance'
import { offsetLoop } from '../../face2d/clipperOffset'
import { signedArea } from '../../geometry'

type Pt = { x: number; y: number }

/** Below clipper's half-unit threshold at its 6-decimal precision: the path is
 *  unioned with the Positive fill rule and not moved. */
const UNION_ONLY_DELTA_MM = 2e-7
/** Covers the offsetter's round-join and decimation tolerance (0.005 mm) and a
 *  planner's chord sampling, so the planned path never lands exactly on the grown
 *  footprint the trim then measures against. */
const ISLAND_MARGIN_MM = 0.05
/** A region piece smaller than this is left out rather than planned. */
const MIN_PIECE_AREA_MM2 = 1e-3

export interface WorkholdingIslandInputs {
  /** Vises, jaws and clamps, one mesh each, in the frame of the region's loops. */
  readonly meshes: readonly ClearanceMesh[]
  /** The deepest Z the operation cuts at. */
  readonly bottomZ: number
  /** The highest Z the cutter reaches while cutting: the shallowest cut plus the
   *  flute length. A jaw entirely above this is the trim's business, not an island. */
  readonly topZ: number
  /** The operation's Shank clearance, mm. */
  readonly allowanceMm: number
}

/**
 * The workholding footprint inside [bottomZ, topZ], grown by the allowance and the
 * grid slack, as CCW loops. Empty when no workholding reaches into that window.
 */
export function workholdingKeepOuts(input: WorkholdingIslandInputs): Pt[][] {
  const allowance = Number.isFinite(input.allowanceMm) && input.allowanceMm > 0 ? input.allowanceMm : 0
  const columns = input.meshes.map(mesh => buildSolidColumns(mesh))
  return keepOutsFromColumns(columns, input.bottomZ, input.topZ, allowance)
}

/** A floor added over workholding sits this far above the tool-tip allowance, so the
 *  trim's strict overlap test never reads the floor as touching the jaw top. */
const FLOOR_MARGIN_MM = 0.001

export interface WorkholdingDepthBandInputs {
  readonly meshes: readonly ClearanceMesh[]
  /** The operation's cutting depths, highest first. */
  readonly depths: readonly number[]
  /** The highest Z the cutter reaches while cutting (shallowest cut plus flute length). */
  readonly topZ: number
  /** The operation's Shank clearance, mm. */
  readonly allowanceMm: number
}

export interface WorkholdingDepthBand {
  /** The depths this band cuts, highest first. */
  readonly depths: number[]
  /** The footprint to take out at these depths (empty: nothing in reach). */
  readonly keepOuts: Pt[][]
  /** Set when the band's last depth was ADDED to stop just above a workholding top the
   *  next band reaches; the caller drops it when the next band's region is no smaller. */
  readonly addedFloorZ?: number
  /** The workholding top that floor keeps clear of. */
  readonly workholdingTopZ?: number
}

/**
 * WO-1618. The footprint applies only at the depths where the tool tip comes within the
 * allowance of a workholding top: a vise UNDER a through pocket takes nothing out above
 * its top, so the pocket still clears down to it. Depths are grouped into bands sharing
 * one footprint. Where the footprint grows between two depths, a floor is added at the
 * highest newly reached top plus the allowance, so the band above cuts down to it; a
 * sloped fixture with several tops in one step is kept clear from that highest top
 * down (at most one stepdown of material left, never a cut into it).
 */
export function workholdingDepthBands(input: WorkholdingDepthBandInputs): WorkholdingDepthBand[] {
  const allowance = Number.isFinite(input.allowanceMm) && input.allowanceMm > 0 ? input.allowanceMm : 0
  const columns = input.meshes.map(mesh => buildSolidColumns(mesh))
  // Every solid top that could be in reach, highest first.
  const topSet = new Set<number>()
  for (const c of columns) {
    if (!c) continue
    for (let k = 0; k + 1 < c.spanZ.length; k += 2) {
      if (c.spanZ[k] < input.topZ) topSet.add(c.spanZ[k + 1])
    }
  }
  const tops = [...topSet].sort((a, b) => b - a)
  const reachedCount = (depth: number): number => {
    let n = 0
    while (n < tops.length && tops[n] > depth - allowance) n++
    return n
  }
  const bands: { depths: number[]; count: number; addedFloorZ?: number; workholdingTopZ?: number }[] = []
  for (const depth of input.depths) {
    const count = reachedCount(depth)
    const last = bands[bands.length - 1]
    if (last && last.count === count) {
      last.depths.push(depth)
      continue
    }
    if (last) {
      // The highest top this depth reaches that the band above did not.
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
  const byCount = new Map<number, Pt[][]>()
  return bands.map(band => {
    let keepOuts = byCount.get(band.count)
    if (!keepOuts) {
      keepOuts = band.count === 0
        ? []
        : keepOutsFromColumns(columns, band.depths[band.depths.length - 1] - allowance, input.topZ, allowance)
      byCount.set(band.count, keepOuts)
    }
    return {
      depths: band.depths,
      keepOuts,
      ...(band.addedFloorZ !== undefined
        ? { addedFloorZ: band.addedFloorZ, workholdingTopZ: band.workholdingTopZ } : {}),
    }
  })
}

function keepOutsFromColumns(
  columnSets: readonly (SolidColumns | null)[], bottomZ: number, topZ: number, allowance: number,
): Pt[][] {
  const keepOuts: Pt[][] = []
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
    const cells: Pt[][] = []
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
      for (const grown of offsetLoop(outline, grow)) {
        if (signedArea(grown) > 0) keepOuts.push(grown)
      }
    }
  }
  return keepOuts
}

export interface ReducedRegion {
  /** The region's loops after the keep-outs are taken out: outers CCW, holes CW. */
  readonly loops: Pt[][]
  /** Net area the keep-outs removed from the region, mm^2. */
  readonly removedAreaMm2: number
}

/**
 * Take the keep-outs out of a region given as loops whose winding says what they are
 * (outer CCW = material to clear, CW = a hole). Returns null when no keep-out
 * touches the region, so the caller plans exactly what it was given.
 */
export function reduceRegionAroundKeepOuts(regionLoops: readonly Pt[][], keepOuts: readonly Pt[][]): ReducedRegion | null {
  if (keepOuts.length === 0 || regionLoops.length === 0) return null
  const before = netArea(regionLoops)
  const reversed = keepOuts.map(loop => (signedArea(loop) > 0 ? [...loop].reverse() : loop))
  const loops = unionPositive([...regionLoops, ...reversed])
    .filter(loop => Math.abs(signedArea(loop)) >= MIN_PIECE_AREA_MM2)
  const removed = before - netArea(loops)
  if (removed <= MIN_PIECE_AREA_MM2) return null
  return { loops, removedAreaMm2: removed }
}

/** Operator words for the console, shared by both operations. */
export function workholdingIslandNotice(operation: string, removedAreaMm2: number, allowanceMm: number): string {
  return `${operation}: the clearing region was reduced around the workholding by ${removedAreaMm2.toFixed(1)} sq mm ` +
    `so the tool keeps ${allowanceMm} mm clear of it; everything else is cleared.`
}

function netArea(loops: readonly Pt[][]): number {
  let area = 0
  for (const loop of loops) area += signedArea(loop)
  return area
}

/**
 * Positive-fill union of loops as one keyhole path (see the header). Clipper picks
 * the fill rule from the path's net winding, so a square of material far to the +X
 * side, larger than everything else together, keeps that winding positive even when
 * the keep-outs outweigh the region; its own loop is dropped from the answer.
 */
function unionPositive(loops: readonly Pt[][]): Pt[][] {
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
  const frame: Pt[] = [
    { x: frameX, y: minY }, { x: frameX + side, y: minY },
    { x: frameX + side, y: minY + side }, { x: frameX, y: minY + side },
  ]
  const hub = usable[0][0]
  const path: Pt[] = []
  for (const loop of [...usable, frame]) {
    for (const p of loop) path.push(p)
    path.push(loop[0])
    path.push(hub)
  }
  return offsetLoop(path, UNION_ONLY_DELTA_MM)
    .filter(loop => !loop.every(p => p.x > frameX - 1))
}
