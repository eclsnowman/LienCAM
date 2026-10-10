// Pure-math tests for the discontinuity-aware stock-sim mesh
// (src/lib/viewport/stockSimMesh.ts). DISPLAY-ONLY: the heightmap data is
// authoritative; these only check how it is meshed (smooth ramps stay smooth,
// cliffs become true vertical walls, surface stays watertight).

import { describe, it, expect } from 'vitest'
import {
  buildStockSimTopology,
  updateStockSimMesh,
  STOCK_SIM_CLIFF_THRESHOLD_FACTOR,
  type StockSimLayout,
} from '../../lib/viewport/stockSimMesh'

// Convenience: read a top-corner Z. cell = iy*nx+ix; localCorner 0..3.
function topZ(layout: StockSimLayout, ix: number, iy: number, localCorner: number): number {
  const cell = iy * layout.nx + ix
  return layout.topPositions[(cell * 4 + localCorner) * 3 + 2]
}

// A wall quad's 4 Z values (verts [top@A, top@B, bot@B, bot@A]).
function wallZ(layout: StockSimLayout, w: number): number[] {
  const vb = w * 4
  return [0, 1, 2, 3].map((k) => layout.wallPositions[(vb + k) * 3 + 2])
}

// Max vertical extent of a wall quad (0 == degenerate / invisible).
function wallExtent(layout: StockSimLayout, w: number): number {
  const zs = wallZ(layout, w)
  return Math.max(...zs) - Math.min(...zs)
}

// The wall OPENING: how far the quad's top edge sits above its bottom edge at
// each shared endpoint (top@A - bot@A and top@B - bot@B). Verts are
// [top@A, top@B, bot@B, bot@A], so gaps are |z0-z3| and |z1-z2|. A smooth ramp
// has coincident corner Z across cells -> zero opening even though the (sloped)
// quad has non-zero overall extent. A cliff opens this gap == the height jump.
function wallOpening(layout: StockSimLayout, w: number): number {
  const z = wallZ(layout, w)
  return Math.max(Math.abs(z[0] - z[3]), Math.abs(z[1] - z[2]))
}

const CSX = 1
const CSY = 1
const THRESH = STOCK_SIM_CLIFF_THRESHOLD_FACTOR * Math.min(CSX, CSY) // = 3

describe('buildStockSimTopology', () => {
  it('2x2 grid: correct vert + index counts', () => {
    const nx = 2, ny = 2
    const layout = buildStockSimTopology(nx, ny, CSX, CSY, 0, 0)

    // 4 verts/cell * 4 cells = 16 top verts -> 48 floats.
    expect(layout.topPositions.length).toBe(16 * 3)
    expect(layout.topNormals.length).toBe(16 * 3)
    // 2 tris/cell * 4 cells = 8 tris -> 24 indices.
    expect(layout.topIndices.length).toBe(8 * 3)

    // Interior edges: +x for the 2 left cells, +y for the 2 bottom cells = 4.
    expect(layout.wallQuadCount).toBe(4)
    expect(layout.wallPositions.length).toBe(4 * 4 * 3) // 16 wall verts
    expect(layout.wallNormals.length).toBe(4 * 4 * 3)
    expect(layout.wallIndices.length).toBe(4 * 2 * 3)
  })

  it('top corner XY tiles the cell exactly (c00..c01)', () => {
    const layout = buildStockSimTopology(2, 2, CSX, CSY, 0, 0)
    // cell (0,0): c00 (0,0), c10 (1,0), c11 (1,1), c01 (0,1)
    const base = 0
    expect([layout.topPositions[(base + 0) * 3], layout.topPositions[(base + 0) * 3 + 1]]).toEqual([0, 0])
    expect([layout.topPositions[(base + 1) * 3], layout.topPositions[(base + 1) * 3 + 1]]).toEqual([1, 0])
    expect([layout.topPositions[(base + 2) * 3], layout.topPositions[(base + 2) * 3 + 1]]).toEqual([1, 1])
    expect([layout.topPositions[(base + 3) * 3], layout.topPositions[(base + 3) * 3 + 1]]).toEqual([0, 1])
  })
})

describe('updateStockSimMesh - flat surface', () => {
  it('all-equal heights: every wall degenerate, all top Z equal', () => {
    const nx = 4, ny = 4
    const layout = buildStockSimTopology(nx, ny, CSX, CSY, 0, 0)
    const heights = new Float32Array(nx * ny).fill(5)
    updateStockSimMesh(heights, nx, ny, layout, THRESH)

    // Every top corner Z == 5.
    for (let i = 0; i < nx * ny * 4; i++) {
      expect(layout.topPositions[i * 3 + 2]).toBeCloseTo(5, 6)
    }
    // Every wall quad has zero vertical extent.
    for (let w = 0; w < layout.wallQuadCount; w++) {
      expect(wallExtent(layout, w)).toBeCloseTo(0, 6)
    }
  })
})

describe('updateStockSimMesh - single 1-cell hole (cliff)', () => {
  it('walls bounding the hole are vertical with height == depth; far walls degenerate', () => {
    const nx = 5, ny = 5
    const layout = buildStockSimTopology(nx, ny, CSX, CSY, 0, 0)
    const top = 10
    const depth = 6 // >> THRESH (3)
    const heights = new Float32Array(nx * ny).fill(top)
    const hx = 2, hy = 2
    heights[hy * nx + hx] = top - depth
    updateStockSimMesh(heights, nx, ny, layout, THRESH)

    // The 4 interior walls bounding cell (2,2) must be vertical, extent==depth.
    const boundary: number[] = []
    for (let w = 0; w < layout.walls.length; w++) {
      const { ix, iy, axis } = layout.walls[w]
      const touchesHole =
        (axis === 0 && ((ix === hx && iy === hy) || (ix + 1 === hx && iy === hy))) ||
        (axis === 1 && ((ix === hx && iy === hy) || (ix === hx && iy + 1 === hy)))
      if (touchesHole) boundary.push(w)
    }
    // up to 4 bounding walls (all 4 here since hole is fully interior)
    expect(boundary.length).toBe(4)
    for (const w of boundary) {
      expect(wallExtent(layout, w)).toBeCloseTo(depth, 5)
    }

    // A wall far from the hole (e.g. cell (0,0) +x) is degenerate.
    const farW = layout.walls.findIndex((e) => e.ix === 0 && e.iy === 0 && e.axis === 0)
    expect(farW).toBeGreaterThanOrEqual(0)
    expect(wallExtent(layout, farW)).toBeCloseTo(0, 6)
  })
})

describe('updateStockSimMesh - gradual ramp', () => {
  it('sub-threshold per-cell step: NO vertical walls, top Z monotonic', () => {
    const nx = 6, ny = 3
    const layout = buildStockSimTopology(nx, ny, CSX, CSY, 0, 0)
    const step = 1 // < THRESH (3): a gentle slope
    const heights = new Float32Array(nx * ny)
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        heights[iy * nx + ix] = ix * step
      }
    }
    updateStockSimMesh(heights, nx, ny, layout, THRESH)

    // No wall OPENS (no vertical gap between adjacent cells' shared corners) --
    // the smooth ramp stays watertight. (A wall quad may still be a sloped sliver
    // following the ramp, but it must not crack open into a vertical face.)
    for (let w = 0; w < layout.wallQuadCount; w++) {
      expect(wallOpening(layout, w)).toBeLessThan(1e-6)
    }

    // Top Z monotonically increases in +x along the bottom row of cells (read
    // each cell's c00 corner Z).
    let prev = -Infinity
    for (let ix = 0; ix < nx; ix++) {
      const z = topZ(layout, ix, 0, 0)
      expect(z).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = z
    }
  })
})

describe('updateStockSimMesh - watertight at a cliff', () => {
  it('wall top Z == higher adjacent corner, bottom Z == lower', () => {
    const nx = 4, ny = 4
    const layout = buildStockSimTopology(nx, ny, CSX, CSY, 0, 0)
    const high = 12
    const low = 4 // delta 8 >> THRESH
    // Left half high, right half low -> a clean cliff at grid x=2.
    const heights = new Float32Array(nx * ny)
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        heights[iy * nx + ix] = ix < 2 ? high : low
      }
    }
    updateStockSimMesh(heights, nx, ny, layout, THRESH)

    // The +x wall between cell (1,iy) [high] and cell (2,iy) [low] is the cliff.
    for (let iy = 0; iy < ny; iy++) {
      const w = layout.walls.findIndex((e) => e.ix === 1 && e.iy === iy && e.axis === 0)
      expect(w).toBeGreaterThanOrEqual(0)
      const zs = wallZ(layout, w)
      expect(Math.max(...zs)).toBeCloseTo(high, 5) // top rides the higher cell
      expect(Math.min(...zs)).toBeCloseTo(low, 5)  // bottom rides the lower cell
      // Watertight: the high cell's c10 corner Z == wall top; low cell's c00 == wall bottom.
      expect(topZ(layout, 1, iy, 1)).toBeCloseTo(high, 5) // cell(1,iy) c10
      expect(topZ(layout, 2, iy, 0)).toBeCloseTo(low, 5)  // cell(2,iy) c00
    }
  })
})
