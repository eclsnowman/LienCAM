// WO-3066: the floor of a blind recess in an STL, read off its edge chains.
//
// An STL's sharp edges load as closed chains, one per Z (meshContourLoops in
// store/index.ts), each carrying the part-local Z it lies at (bottom of the
// part = 0, the mesh's own lowest point, whether or not an edge chain lies
// there). A straight-walled recess leaves two chains with the same
// footprint: its rim at the top of the wall and its floor edge at the bottom.
// The floor edge sitting above the part bottom makes the recess BLIND; a wall
// that runs to the part bottom is a THROUGH feature (a bore, a hole).
//
// Owner 2026-10-22 (WO-3066): a new 2D Pocket / Adaptive on the NEMA17 plate's
// 2.2 mm relief must stop at the relief floor, not cut the disc through.

/** The fields this reader needs from a Loop2D. */
export interface RecessChain {
  id: string
  closed: boolean
  points: ReadonlyArray<{ x: number; y: number }>
  z?: number
}

interface Footprint {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function footprintOf(chain: RecessChain): Footprint {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
  for (const point of chain.points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
  }
  return { minX, maxX, minY, maxY }
}

/** Same outline in XY: the two ends of one vertical wall. Matched on the
 *  bounding box, to 1% of the larger side (at least 0.02 mm), so tessellation
 *  noise passes and a stepped or drafted wall does not. */
function sameFootprint(a: Footprint, b: Footprint): boolean {
  const size = Math.max(a.maxX - a.minX, a.maxY - a.minY, b.maxX - b.minX, b.maxY - b.minY)
  const tolerance = Math.max(0.02, size * 0.01)
  return Math.abs(a.minX - b.minX) <= tolerance && Math.abs(a.maxX - b.maxX) <= tolerance
    && Math.abs(a.minY - b.minY) <= tolerance && Math.abs(a.maxY - b.maxY) <= tolerance
}

const Z_EPSILON = 1e-4

/** The part-local floor Z of the blind recess a picked chain bounds, or
 *  undefined when the chain is not one (a through wall, a chain with no
 *  partner wall end, a loop with no Z).
 *  - Picked rim: the floor is the nearest same-footprint chain below it.
 *  - Picked floor edge (a same-footprint chain above, none below): itself. */
function blindFloorZ(picked: RecessChain, chains: ReadonlyArray<RecessChain>, partBottomZ: number): number | undefined {
  if (!picked.closed || picked.z === undefined) return undefined
  const pickedZ = picked.z
  const footprint = footprintOf(picked)
  const partners = chains.filter(chain => chain !== picked && chain.closed && chain.z !== undefined
    && Math.abs(chain.z - pickedZ) > Z_EPSILON && sameFootprint(footprint, footprintOf(chain)))
  const below = partners.filter(chain => chain.z! < pickedZ).map(chain => chain.z!)
  const floorZ = below.length > 0
    ? Math.max(...below)
    : partners.some(chain => chain.z! > pickedZ) ? pickedZ : undefined
  if (floorZ === undefined || floorZ <= partBottomZ + Z_EPSILON) return undefined
  return floorZ
}

/**
 * The part-local Z a new 2D Pocket / Adaptive on these picked STL chains
 * should stop at, or undefined to keep today's default. Every picked chain
 * must bound a blind recess; one through feature (or any pick that is not an
 * STL chain with a Z) keeps the default. Picks with different floors take the
 * shallowest, so no picked recess is cut through its floor.
 */
export function stlRecessFloorLocalZ(
  chains: ReadonlyArray<RecessChain>,
  pickedIds: ReadonlyArray<string>,
): number | undefined {
  if (pickedIds.length === 0) return undefined
  const withZ = chains.filter(chain => chain.z !== undefined)
  if (withZ.length === 0) return undefined
  // Not the lowest chain: a part whose underside edges are all rounded has no
  // chain at its bottom, and its lowest chain may be a recess floor.
  const partBottomZ = 0
  const floors: number[] = []
  for (const id of new Set(pickedIds)) {
    const picked = withZ.find(chain => chain.id === id)
    const floorZ = picked ? blindFloorZ(picked, withZ, partBottomZ) : undefined
    if (floorZ === undefined) return undefined
    floors.push(floorZ)
  }
  return Math.max(...floors)
}
