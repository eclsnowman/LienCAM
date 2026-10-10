// Discontinuity-aware hybrid mesh for the stock-removal simulation surface.
//
// The simulation heightmap (src/lib/simulation/HeightmapSimulator.ts) stores one
// remaining-material top-Z per grid cell, indexed heights[iy*nx + ix]. The legacy
// viewport mesh drew ONE vertex per cell CENTRE and stitched quads between
// centres; that interpolates across a hole edge over a full cell, so a vertical
// wall reads as an inverted-funnel ramp (wider at the top).
//
// This module meshes the heightmap so that:
//   - gently varying neighbours produce a SMOOTH, watertight surface (corner
//     vertices are shared/coincident, normals averaged) -- future-proof for
//     ball/V-bit/3D surfacing, and
//   - sharp height discontinuities ("cliffs") produce TRUE VERTICAL walls (the
//     corner splits, opening a gap that a wall quad fills) -- fixes the funnel.
//
// It is DISPLAY-ONLY: the heightmap DATA is authoritative and untouched. No
// Three.js dependency -- the functions return plain typed arrays the viewport
// uploads into a BufferGeometry.
//
// Geometry layout (fixed once per resolution):
//   TOP: 4 corner verts per cell, 2 tris/cell. Cell base index = (iy*nx+ix)*4.
//     Corner order c00(-x,-y), c10(+x,-y), c11(+x,+y), c01(-x,+y).
//   WALLS: one quad per INTERIOR edge (each cell's +x neighbour if ix<nx-1, and
//     +y neighbour if iy<ny-1), 4 verts + 2 tris each. A wall is zero-area
//     (invisible) when the two cells' shared-corner heights match.
//   SIDES + BOTTOM (WO-2509, only when the stock bottom Z is given): one quad per
//     OUTER cell edge from that cell's top corners down to the stock bottom, then
//     one bottom quad. Without them the remaining stock was an open sheet: a base
//     left under the deepest cut drew as a flat plane floating above the vise.
//     They follow the interior walls in the wall buffers, so the viewport's
//     concatenation and edge carrier pick them up unchanged.

/**
 * Slope steeper than ~atan(factor) reads as a vertical wall rather than a smooth
 * ramp. threshold = factor * min(csx,csy); factor 3 => ~71.6deg. Single tunable.
 */
export const STOCK_SIM_CLIFF_THRESHOLD_FACTOR = 3

export interface StockSimLayout {
  nx: number
  ny: number
  csx: number
  csy: number
  x0: number
  y0: number
  /** 4 corner verts per cell * 3 floats. XY filled by build; Z by update. */
  topPositions: Float32Array
  /** matches topPositions; filled per-update. */
  topNormals: Float32Array
  /** 2 tris per cell. */
  topIndices: Uint32Array
  /** number of wall-buffer quads: interior edges, then outer sides, then bottom. */
  wallQuadCount: number
  /** 4 verts per wall quad * 3 floats; XY+Z filled per-update. */
  wallPositions: Float32Array
  /** matches wallPositions; filled per-update. */
  wallNormals: Float32Array
  /** 2 tris per wall quad. */
  wallIndices: Uint32Array
  /**
   * Per-wall descriptor so update can find the two cells sharing each edge and
   * the boundary endpoints. axis: 0 = +x neighbour, 1 = +y neighbour.
   */
  walls: ReadonlyArray<{ ix: number; iy: number; axis: 0 | 1 }>
  /** Stock bottom Z the sides drop to; null = open top surface only. */
  bottomZ: number | null
  /**
   * Outer-edge side quads, stored in the wall buffers right after `walls`.
   * side: 0 = -x edge, 1 = +x edge, 2 = -y edge, 3 = +y edge of cell (ix,iy).
   * A bottom quad follows them when bottomZ is set.
   */
  sides: ReadonlyArray<{ ix: number; iy: number; side: 0 | 1 | 2 | 3 }>
}

// Top-vert corner offsets within a cell base (each entry is 3 floats stride).
// 0:c00 1:c10 2:c11 3:c01
const C00 = 0
const C10 = 1
const C11 = 2
const C01 = 3

/**
 * Build the fixed topology for an nx*ny heightmap grid. XY of every top corner
 * is filled now (Z=0); normals + Z + all wall data are filled by
 * updateStockSimMesh. Cell (ix,iy) spans world X [ix*csx+x0 .. (ix+1)*csx+x0]
 * and Y [iy*csy+y0 .. (iy+1)*csy+y0]. With `bottomZ` (the stock bottom) the
 * layout also carries the outer side walls and the bottom face, so the
 * remaining stock draws as a closed solid.
 */
export function buildStockSimTopology(
  nx: number,
  ny: number,
  csx: number,
  csy: number,
  x0: number,
  y0: number,
  bottomZ?: number,
): StockSimLayout {
  const cellCount = nx * ny

  const topPositions = new Float32Array(cellCount * 4 * 3)
  const topNormals = new Float32Array(cellCount * 4 * 3)
  const topIndices = new Uint32Array(cellCount * 2 * 3)

  // Fill top corner XY (Z stays 0) and tri indices.
  let t = 0
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const cell = iy * nx + ix
      const base = cell * 4
      const xL = ix * csx + x0
      const xR = (ix + 1) * csx + x0
      const yB = iy * csy + y0
      const yT = (iy + 1) * csy + y0

      // c00, c10, c11, c01
      setXY(topPositions, base + C00, xL, yB)
      setXY(topPositions, base + C10, xR, yB)
      setXY(topPositions, base + C11, xR, yT)
      setXY(topPositions, base + C01, xL, yT)

      // CCW seen from +Z: (c00,c10,c11),(c00,c11,c01)
      topIndices[t++] = base + C00
      topIndices[t++] = base + C10
      topIndices[t++] = base + C11
      topIndices[t++] = base + C00
      topIndices[t++] = base + C11
      topIndices[t++] = base + C01
    }
  }

  // Enumerate interior edge quads: +x neighbour and +y neighbour per cell.
  const walls: { ix: number; iy: number; axis: 0 | 1 }[] = []
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (ix < nx - 1) walls.push({ ix, iy, axis: 0 })
      if (iy < ny - 1) walls.push({ ix, iy, axis: 1 })
    }
  }
  // Outer sides: every border cell edge, walked round the rectangle.
  const sides: { ix: number; iy: number; side: 0 | 1 | 2 | 3 }[] = []
  const bz = bottomZ !== undefined && Number.isFinite(bottomZ) ? bottomZ : null
  const closed = bz !== null
  if (closed) {
    for (let iy = 0; iy < ny; iy++) {
      sides.push({ ix: 0, iy, side: 0 })
      sides.push({ ix: nx - 1, iy, side: 1 })
    }
    for (let ix = 0; ix < nx; ix++) {
      sides.push({ ix, iy: 0, side: 2 })
      sides.push({ ix, iy: ny - 1, side: 3 })
    }
  }
  const wallQuadCount = walls.length + sides.length + (closed ? 1 : 0)

  const wallPositions = new Float32Array(wallQuadCount * 4 * 3)
  const wallNormals = new Float32Array(wallQuadCount * 4 * 3)
  const wallIndices = new Uint32Array(wallQuadCount * 2 * 3)
  // Wall quad verts in order [top@A, top@B, bot@B, bot@A] -> 2 tris.
  for (let w = 0; w < wallQuadCount; w++) {
    const vb = w * 4
    const i = w * 6
    wallIndices[i] = vb + 0
    wallIndices[i + 1] = vb + 1
    wallIndices[i + 2] = vb + 2
    wallIndices[i + 3] = vb + 0
    wallIndices[i + 4] = vb + 2
    wallIndices[i + 5] = vb + 3
  }

  // The bottom face never moves: fill it once, facing -Z.
  if (bz !== null) {
    const vb = (wallQuadCount - 1) * 4
    const xR = nx * csx + x0
    const yT = ny * csy + y0
    setVert(wallPositions, vb + 0, x0, y0, bz)
    setVert(wallPositions, vb + 1, x0, yT, bz)
    setVert(wallPositions, vb + 2, xR, yT, bz)
    setVert(wallPositions, vb + 3, xR, y0, bz)
    for (let k = 0; k < 4; k++) wallNormals[(vb + k) * 3 + 2] = -1
  }

  return {
    nx,
    ny,
    csx,
    csy,
    x0,
    y0,
    topPositions,
    topNormals,
    topIndices,
    wallQuadCount,
    wallPositions,
    wallNormals,
    wallIndices,
    walls,
    bottomZ: bz,
    sides,
  }
}

function setXY(arr: Float32Array, vert: number, x: number, y: number): void {
  arr[vert * 3] = x
  arr[vert * 3 + 1] = y
}

/**
 * Fill top Z + normals and wall positions + normals from a fresh heights array.
 * Mutates the layout's typed arrays in place (fixed topology; no reallocation).
 *
 * @param threshold absolute height delta above which a corner is a "cliff".
 *   Compute as STOCK_SIM_CLIFF_THRESHOLD_FACTOR * min(csx,csy) at the call site.
 */
export function updateStockSimMesh(
  heights: Float32Array,
  nx: number,
  ny: number,
  layout: StockSimLayout,
  threshold: number,
): void {
  const { csx, csy, topPositions, topNormals, wallPositions, wallNormals, walls } = layout

  const hAt = (ix: number, iy: number): number => heights[iy * nx + ix]

  // Per-cell gradient (central differences, clamped at borders), normalized.
  // g = (-dh/dx, -dh/dy, 1) so the surface normal points up the slope.
  const gradX = new Float32Array(nx * ny)
  const gradY = new Float32Array(nx * ny)
  const gradZ = new Float32Array(nx * ny)
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const xl = ix > 0 ? ix - 1 : ix
      const xr = ix < nx - 1 ? ix + 1 : ix
      const yl = iy > 0 ? iy - 1 : iy
      const yr = iy < ny - 1 ? iy + 1 : iy
      const dx = (hAt(xr, iy) - hAt(xl, iy)) / ((xr - xl || 1) * csx)
      const dy = (hAt(ix, yr) - hAt(ix, yl)) / ((yr - yl || 1) * csy)
      let gx = -dx
      let gy = -dy
      let gz = 1
      const len = Math.hypot(gx, gy, gz) || 1
      gx /= len
      gy /= len
      gz /= len
      const c = iy * nx + ix
      gradX[c] = gx
      gradY[c] = gy
      gradZ[c] = gz
    }
  }

  // For each cell corner (a grid corner shared by up to 4 cells), decide smooth
  // vs cliff. Grid corner (gx,gy) is touched by cells (gx-1,gy-1),(gx,gy-1),
  // (gx-1,gy),(gx,gy). Each cell sees that grid corner via a specific local
  // corner index:
  //   cell(gx,gy)     -> its c00   (lower-left)  = grid corner (gx,gy)
  //   cell(gx-1,gy)   -> its c10
  //   cell(gx,gy-1)   -> its c01
  //   cell(gx-1,gy-1) -> its c11
  // We compute the resolved Z + normal once per (cell, localCorner) pair.
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const cell = iy * nx + ix
      const base = cell * 4
      // The four corners of THIS cell map to four grid corners:
      //   c00 -> grid (ix,   iy)
      //   c10 -> grid (ix+1, iy)
      //   c11 -> grid (ix+1, iy+1)
      //   c01 -> grid (ix,   iy+1)
      resolveCorner(base + C00, ix, iy, ix, iy)
      resolveCorner(base + C10, ix + 1, iy, ix, iy)
      resolveCorner(base + C11, ix + 1, iy + 1, ix, iy)
      resolveCorner(base + C01, ix, iy + 1, ix, iy)
    }
  }

  // Resolve one cell-corner: gx,gy = grid corner; (ownIx,ownIy) = the cell that
  // owns this vertex (used as the cliff fallback).
  function resolveCorner(
    vert: number,
    gx: number,
    gy: number,
    ownIx: number,
    ownIy: number,
  ): void {
    // Gather in-bounds cells touching this grid corner.
    let hMin = Infinity
    let hMax = -Infinity
    let sumGx = 0
    let sumGy = 0
    let sumGz = 0
    let count = 0
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const cx = gx + dx
        const cy = gy + dy
        if (cx < 0 || cx >= nx || cy < 0 || cy >= ny) continue
        const h = hAt(cx, cy)
        if (h < hMin) hMin = h
        if (h > hMax) hMax = h
        const c = cy * nx + cx
        sumGx += gradX[c]
        sumGy += gradY[c]
        sumGz += gradZ[c]
        count++
      }
    }

    const span = hMax - hMin
    let z: number
    let nXv: number
    let nYv: number
    let nZv: number
    if (count > 0 && span <= threshold) {
      // Smooth: coincident corners across cells get identical Z (every cell
      // touching this grid corner computes the SAME mean) -> watertight.
      z = meanHeight(gx, gy)
      const len = Math.hypot(sumGx, sumGy, sumGz) || 1
      nXv = sumGx / len
      nYv = sumGy / len
      nZv = sumGz / len
    } else {
      // Cliff: snap to the owning cell's height + gradient; corner splits open.
      const oc = ownIy * nx + ownIx
      z = hAt(ownIx, ownIy)
      nXv = gradX[oc]
      nYv = gradY[oc]
      nZv = gradZ[oc]
    }
    topPositions[vert * 3 + 2] = z
    topNormals[vert * 3] = nXv
    topNormals[vert * 3 + 1] = nYv
    topNormals[vert * 3 + 2] = nZv
  }

  function meanHeight(gx: number, gy: number): number {
    let sum = 0
    let count = 0
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const cx = gx + dx
        const cy = gy + dy
        if (cx < 0 || cx >= nx || cy < 0 || cy >= ny) continue
        sum += hAt(cx, cy)
        count++
      }
    }
    return count > 0 ? sum / count : 0
  }

  // Helper: read a cell's already-resolved TOP Z at a given local corner.
  const topZ = (cell: number, localCorner: number): number =>
    topPositions[(cell * 4 + localCorner) * 3 + 2]

  // Walls. Each fills 4 verts: [top@A, top@B, bot@B, bot@A].
  for (let w = 0; w < walls.length; w++) {
    const { ix, iy, axis } = walls[w]
    const vb = w * 4

    let ax: number, ay: number, bx: number, by: number
    let zTopA: number, zBotA: number, zTopB: number, zBotB: number
    let normalX: number, normalY: number

    const cellL = iy * nx + ix

    if (axis === 0) {
      // +x neighbour: shared boundary at grid x = ix+1, spanning grid y iy..iy+1.
      const cellR = iy * nx + (ix + 1)
      // At grid corner (ix+1, iy): left cell's c10, right cell's c00.
      const zL = topZ(cellL, C10)
      const zR = topZ(cellR, C00)
      // At grid corner (ix+1, iy+1): left cell's c11, right cell's c01.
      const zL2 = topZ(cellL, C11)
      const zR2 = topZ(cellR, C01)
      ax = (ix + 1) * csx + layout.x0
      ay = iy * csy + layout.y0
      bx = ax
      by = (iy + 1) * csy + layout.y0
      zTopA = Math.max(zL, zR)
      zBotA = Math.min(zL, zR)
      zTopB = Math.max(zL2, zR2)
      zBotB = Math.min(zL2, zR2)
      // Edge AB runs along +y; horizontal normal is +/-x. Point toward the lower
      // cell's centre (DoubleSide makes exact sign non-critical).
      normalX = hAt(ix, iy) <= hAt(ix + 1, iy) ? -1 : 1
      normalY = 0
    } else {
      // +y neighbour: shared boundary at grid y = iy+1, spanning grid x ix..ix+1.
      const cellU = (iy + 1) * nx + ix
      // At grid corner (ix, iy+1): bottom cell's c01, top cell's c00.
      const zB = topZ(cellL, C01)
      const zU = topZ(cellU, C00)
      // At grid corner (ix+1, iy+1): bottom cell's c11, top cell's c10.
      const zB2 = topZ(cellL, C11)
      const zU2 = topZ(cellU, C10)
      ax = ix * csx + layout.x0
      ay = (iy + 1) * csy + layout.y0
      bx = (ix + 1) * csx + layout.x0
      by = ay
      zTopA = Math.max(zB, zU)
      zBotA = Math.min(zB, zU)
      zTopB = Math.max(zB2, zU2)
      zBotB = Math.min(zB2, zU2)
      // Edge AB runs along +x; horizontal normal is +/-y.
      normalX = 0
      normalY = hAt(ix, iy) <= hAt(ix, iy + 1) ? -1 : 1
    }

    // verts: [top@A, top@B, bot@B, bot@A]
    setVert(wallPositions, vb + 0, ax, ay, zTopA)
    setVert(wallPositions, vb + 1, bx, by, zTopB)
    setVert(wallPositions, vb + 2, bx, by, zBotB)
    setVert(wallPositions, vb + 3, ax, ay, zBotA)

    for (let k = 0; k < 4; k++) {
      wallNormals[(vb + k) * 3] = normalX
      wallNormals[(vb + k) * 3 + 1] = normalY
      wallNormals[(vb + k) * 3 + 2] = 0
    }
  }

  // Outer sides (WO-2509): each border cell edge drops from that cell's own top
  // corners to the stock bottom, so the side meets the top surface exactly.
  const bottomZ = layout.bottomZ
  if (bottomZ === null) return
  const { sides, x0, y0 } = layout
  for (let s = 0; s < sides.length; s++) {
    const { ix, iy, side } = sides[s]
    const vb = (walls.length + s) * 4
    const cell = iy * nx + ix
    const xL = ix * csx + x0
    const xR = (ix + 1) * csx + x0
    const yB = iy * csy + y0
    const yT = (iy + 1) * csy + y0
    // [A corner, B corner] of the edge, each with its local top-corner index.
    // A -> B runs clockwise round the rim seen from above, so the quad
    // [topA, topB, bottomB, bottomA] winds counter-clockwise seen from
    // OUTSIDE: its front face is the outer face, matching the outward normal
    // (the material is DoubleSide, which flips the normal on a back face).
    let ax: number, ay: number, bx: number, by: number, ca: number, cb: number
    let normalX = 0, normalY = 0
    if (side === 0) { ax = xL; ay = yB; bx = xL; by = yT; ca = C00; cb = C01; normalX = -1 }
    else if (side === 1) { ax = xR; ay = yT; bx = xR; by = yB; ca = C11; cb = C10; normalX = 1 }
    else if (side === 2) { ax = xR; ay = yB; bx = xL; by = yB; ca = C10; cb = C00; normalY = -1 }
    else { ax = xL; ay = yT; bx = xR; by = yT; ca = C01; cb = C11; normalY = 1 }

    setVert(wallPositions, vb + 0, ax, ay, topZ(cell, ca))
    setVert(wallPositions, vb + 1, bx, by, topZ(cell, cb))
    setVert(wallPositions, vb + 2, bx, by, bottomZ)
    setVert(wallPositions, vb + 3, ax, ay, bottomZ)

    for (let k = 0; k < 4; k++) {
      wallNormals[(vb + k) * 3] = normalX
      wallNormals[(vb + k) * 3 + 1] = normalY
      wallNormals[(vb + k) * 3 + 2] = 0
    }
  }
}

function setVert(arr: Float32Array, vert: number, x: number, y: number, z: number): void {
  arr[vert * 3] = x
  arr[vert * 3 + 1] = y
  arr[vert * 3 + 2] = z
}
