// HeightmapSimulator.ts — 2.5D stock removal engine
//
// Stores a 2D grid of Z heights representing the top surface of remaining
// material.  Initialised to stockTop; carve() stamps tool footprints into it.
// The viewport reads heights[] to displace mesh vertices.

export class HeightmapSimulator {
  readonly nx: number         // cells in X
  readonly ny: number         // cells in Y
  readonly x0: number         // world min X
  readonly y0: number         // world min Y
  readonly stockTop: number   // initial Z (material surface)
  readonly stockBot: number   // Z floor (can't carve below this)
  readonly cellSize: number   // mm per cell

  heights: Float32Array       // [iy * nx + ix] = current top Z

  constructor(
    x0: number, y0: number,
    width: number, height: number,
    stockTop: number, stockBot: number,
    cellSizeMm: number,
  ) {
    this.x0       = x0
    this.y0       = y0
    this.stockTop = stockTop
    this.stockBot = stockBot
    this.cellSize = cellSizeMm
    this.nx = Math.max(2, Math.ceil(width  / cellSizeMm))
    this.ny = Math.max(2, Math.ceil(height / cellSizeMm))
    this.heights = new Float32Array(this.nx * this.ny).fill(stockTop)
  }

  reset(): void {
    this.heights.fill(this.stockTop)
  }

  // Carve a cylindrical footprint centred at world (wx, wy) cutting down to cutZ.
  // Only lowers material — never raises it.
  carve(wx: number, wy: number, cutZ: number, toolRadius: number): void {
    if (cutZ >= this.stockTop) return   // tool above stock, nothing to remove
    const { x0, y0, cellSize, nx, ny, stockBot, heights } = this
    const rSq = toolRadius * toolRadius
    const ix0 = Math.max(0,    Math.floor((wx - toolRadius - x0) / cellSize))
    const ix1 = Math.min(nx-1, Math.ceil ((wx + toolRadius - x0) / cellSize))
    const iy0 = Math.max(0,    Math.floor((wy - toolRadius - y0) / cellSize))
    const iy1 = Math.min(ny-1, Math.ceil ((wy + toolRadius - y0) / cellSize))
    const floorZ = Math.max(cutZ, stockBot)
    for (let iy = iy0; iy <= iy1; iy++) {
      const cy = y0 + (iy + 0.5) * cellSize
      const dy = cy - wy
      const dySq = dy * dy
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = x0 + (ix + 0.5) * cellSize
        const dx = cx - wx
        if (dx * dx + dySq <= rSq) {
          const i = iy * nx + ix
          if (floorZ < heights[i]) heights[i] = floorZ
        }
      }
    }
  }

  // Sweep a move from (x0,y0,z0) → (x1,y1,z1), carving the cylinder along the path.
  sweepMove(
    fromX: number, fromY: number, fromZ: number,
    toX: number,   toY: number,   toZ: number,
    toolRadius: number,
  ): void {
    const dist = Math.hypot(toX - fromX, toY - fromY, toZ - fromZ)
    // Step ≤ half a cell so no cell is ever skipped
    const steps = Math.max(1, Math.ceil(dist / (this.cellSize * 0.5)))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      this.carve(
        fromX + t * (toX - fromX),
        fromY + t * (toY - fromY),
        fromZ + t * (toZ - fromZ),
        toolRadius,
      )
    }
  }

  // Carve using a radial profile function.
  // profile(d) returns how much HIGHER than tipZ the tool body is at radial distance d.
  //   flat end mill:  profile = () => 0
  //   ball nose R:    profile = d => R - sqrt(R²-d²)   (d<=R), R (d>R)
  //   bull nose r:    profile = d => 0 (d<=Rflat), r-sqrt(r²-(d-Rflat)²) otherwise
  //   v-bit angle α:  profile = d => d / tan(α/2)
  // bodyTop(d) (optional, undercut tools) is the top of the tool body rising from
  // that bottom (toolBodyTopAtRadius). A column whose surface is above it keeps its
  // surface: the tool passes underneath, and a heightmap cannot show the void.
  carveWithProfile(
    wx: number, wy: number, tipZ: number,
    toolRadius: number,
    profile: (d: number) => number,
    bodyTop?: (d: number) => number,
  ): void {
    if (tipZ >= this.stockTop) return
    const { x0, y0, cellSize, nx, ny, stockBot, heights } = this
    const rSq = toolRadius * toolRadius
    const ix0 = Math.max(0,    Math.floor((wx - toolRadius - x0) / cellSize))
    const ix1 = Math.min(nx-1, Math.ceil ((wx + toolRadius - x0) / cellSize))
    const iy0 = Math.max(0,    Math.floor((wy - toolRadius - y0) / cellSize))
    const iy1 = Math.min(ny-1, Math.ceil ((wy + toolRadius - y0) / cellSize))
    for (let iy = iy0; iy <= iy1; iy++) {
      const cy = y0 + (iy + 0.5) * cellSize
      const dy = cy - wy
      const dySq = dy * dy
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = x0 + (ix + 0.5) * cellSize
        const dx = cx - wx
        const dSq = dx * dx + dySq
        if (dSq <= rSq) {
          const d = Math.sqrt(dSq)
          const floorZ = Math.max(tipZ + profile(d), stockBot)
          const i = iy * nx + ix
          if (floorZ < heights[i] && (bodyTop === undefined || heights[i] <= tipZ + bodyTop(d))) {
            heights[i] = floorZ
          }
        }
      }
    }
  }

  sweepMoveWithProfile(
    fromX: number, fromY: number, fromZ: number,
    toX:   number, toY:   number, toZ:   number,
    toolRadius: number,
    profile: (d: number) => number,
    bodyTop?: (d: number) => number,
  ): void {
    const dist = Math.hypot(toX - fromX, toY - fromY, toZ - fromZ)
    const steps = Math.max(1, Math.ceil(dist / (this.cellSize * 0.5)))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      this.carveWithProfile(
        fromX + t * (toX - fromX),
        fromY + t * (toY - fromY),
        fromZ + t * (toZ - fromZ),
        toolRadius, profile, bodyTop,
      )
    }
  }

  // Save / restore for pre-op rest-machining baseline
  snapshot(): Float32Array {
    return this.heights.slice()
  }

  restore(snap: Float32Array): void {
    this.heights.set(snap)
  }
}
