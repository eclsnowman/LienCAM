// Image relief - the height grid and the numbers made from it (plain typed
// arrays, no React, no kernel). docs/design/IMAGE-RELIEF-PLAN.md section 3.
//
// A height grid is the picture after adjustments, in millimetres: `cols` x
// `rows` samples spread EVENLY over a `widthMm` x `depthMm` rectangle, sample
// (0, 0) at the rectangle's (0, 0) corner and sample (cols-1, rows-1) at its
// far corner, row-major, row index along Y. Between samples the relief is the
// bilinear surface through them; that surface's volume is the reference every
// built body is checked against.

export interface HeightGrid {
  cols: number
  rows: number
  widthMm: number
  depthMm: number
  /** heights above the face, mm; index = row * cols + col */
  heights: Float32Array
}

export interface SurfacePoint { x: number; y: number; z: number }

/** The working grid of the standard (RELIEF-WHAT-GOOD-LOOKS-LIKE.md section 1): 10 samples per mm, capped on the long side. */
export const WORKING_SAMPLES_PER_MM = 10
export const WORKING_GRID_CAP = 2048

/** Samples per side of the working grid for a placed rectangle. */
export function workingGridSize(widthMm: number, depthMm: number, perMm = WORKING_SAMPLES_PER_MM, cap = WORKING_GRID_CAP): { cols: number; rows: number } {
  const scale = Math.min(1, cap / (Math.max(widthMm, depthMm) * perMm))
  return {
    cols: Math.max(2, Math.round(widthMm * perMm * scale) + 1),
    rows: Math.max(2, Math.round(depthMm * perMm * scale) + 1),
  }
}

/** A grid sampled from a height function h(x, y) in placed millimetres. */
export function sampleHeightGrid(widthMm: number, depthMm: number, cols: number, rows: number, h: (x: number, y: number) => number): HeightGrid {
  const heights = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    const y = (depthMm * r) / (rows - 1)
    for (let c = 0; c < cols; c++) heights[r * cols + c] = h((widthMm * c) / (cols - 1), y)
  }
  return { cols, rows, widthMm, depthMm, heights }
}

/** The bilinear height at (x, y) mm inside the grid's rectangle (clamped to it). */
export function heightAt(g: HeightGrid, x: number, y: number): number {
  const fx = Math.min(Math.max((x / g.widthMm) * (g.cols - 1), 0), g.cols - 1)
  const fy = Math.min(Math.max((y / g.depthMm) * (g.rows - 1), 0), g.rows - 1)
  const c0 = Math.min(Math.floor(fx), g.cols - 2)
  const r0 = Math.min(Math.floor(fy), g.rows - 2)
  const tx = fx - c0
  const ty = fy - r0
  const i = r0 * g.cols + c0
  const h = g.heights
  return (h[i] * (1 - tx) + h[i + 1] * tx) * (1 - ty) + (h[i + g.cols] * (1 - tx) + h[i + g.cols + 1] * tx) * ty
}

/** Exact volume under the bilinear surface through the grid, mm^3 (the trapezoid rule is exact for it). */
export function gridVolume(g: HeightGrid): number {
  let sum = 0
  for (let r = 0; r < g.rows; r++) {
    const wr = r === 0 || r === g.rows - 1 ? 0.5 : 1
    for (let c = 0; c < g.cols; c++) {
      const wc = c === 0 || c === g.cols - 1 ? 0.5 : 1
      sum += wr * wc * g.heights[r * g.cols + c]
    }
  }
  return sum * (g.widthMm / (g.cols - 1)) * (g.depthMm / (g.rows - 1))
}

/** Volume under the grid's bilinear surface inside a circle (centre in grid mm), by 0.02 mm midpoint sampling. */
export function gridVolumeInDisk(g: HeightGrid, cx: number, cy: number, radius: number, step = 0.02): number {
  let sum = 0
  for (let y = cy - radius + step / 2; y < cy + radius; y += step) {
    for (let x = cx - radius + step / 2; x < cx + radius; x += step) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) sum += heightAt(g, x, y)
    }
  }
  return sum * step * step
}

/** A resampled copy (bilinear) at another sample count over the same rectangle. */
export function resampleGrid(g: HeightGrid, cols: number, rows: number): HeightGrid {
  return sampleHeightGrid(g.widthMm, g.depthMm, cols, rows, (x, y) => heightAt(g, x, y))
}

// ---- the cosine bump: a relief with a known volume ------------------------

export interface CosineBump { widthMm: number; depthMm: number; amplitudeMm: number; radiusMm: number }

/** h(r) = A (1 + cos(pi r / R)) / 2 inside r < R, centred in the rectangle; smooth, zero slope at its rim. */
export function cosineBumpHeight(b: CosineBump): (x: number, y: number) => number {
  const cx = b.widthMm / 2
  const cy = b.depthMm / 2
  return (x, y) => {
    const r = Math.hypot(x - cx, y - cy)
    return r < b.radiusMm ? (b.amplitudeMm * (1 + Math.cos((Math.PI * r) / b.radiusMm))) / 2 : 0
  }
}

/** Integral of the bump: A R^2 (pi/2 - 2/pi). */
export function cosineBumpVolume(b: CosineBump): number {
  return b.amplitudeMm * b.radiusMm * b.radiusMm * (Math.PI / 2 - 2 / Math.PI)
}

// ---- a picture into heights ------------------------------------------------

/**
 * Greyscale pixels (0..1, row 0 = TOP of the picture) placed on a rectangle,
 * sampled onto a grid (row 0 = the rectangle's low-Y edge, so the picture
 * reads upright from above). Light = high; `invert` flips that.
 */
export function imageToHeightGrid(
  pixels: Float32Array, pixelCols: number, pixelRows: number,
  widthMm: number, depthMm: number, depthOfRelief: number,
  cols: number, rows: number, invert = false,
): HeightGrid {
  const img: HeightGrid = { cols: pixelCols, rows: pixelRows, widthMm, depthMm, heights: pixels }
  return sampleHeightGrid(widthMm, depthMm, cols, rows, (x, y) => {
    const v = heightAt(img, x, depthMm - y)
    return (invert ? 1 - v : v) * depthOfRelief
  })
}

/** Separable Gaussian smoothing, sigma in mm (edges clamp). */
export function smoothGrid(g: HeightGrid, sigmaMm: number): HeightGrid {
  const sx = (sigmaMm * (g.cols - 1)) / g.widthMm
  const sy = (sigmaMm * (g.rows - 1)) / g.depthMm
  const pass = (src: Float32Array, n: number, count: number, stride: number, step: number, sigma: number): Float32Array => {
    const out = new Float32Array(src.length)
    const rad = Math.ceil(3 * sigma)
    const w = Array.from({ length: 2 * rad + 1 }, (_, i) => Math.exp(-((i - rad) ** 2) / (2 * sigma * sigma)))
    const wsum = w.reduce((a, b) => a + b, 0)
    for (let line = 0; line < count; line++) {
      const base = line * stride
      for (let i = 0; i < n; i++) {
        let s = 0
        for (let k = -rad; k <= rad; k++) s += w[k + rad] * src[base + Math.min(Math.max(i + k, 0), n - 1) * step]
        out[base + i * step] = s / wsum
      }
    }
    return out
  }
  if (sx <= 0 || sy <= 0) return g
  const a = pass(g.heights, g.cols, g.rows, g.cols, 1, sx)
  // columns: line = col, stride 1 between lines, step = cols along a column
  const b = pass(a, g.rows, g.cols, 1, g.cols, sy)
  return { ...g, heights: b }
}

/**
 * Bring the heights smoothly to exactly zero within `marginMm` of the
 * rectangle's edge (smoothstep of the distance), so the relief meets the face
 * with no step and no slope change - the plan's edge blend on a rectangle mask.
 */
export function fadeToEdges(g: HeightGrid, marginMm: number): HeightGrid {
  const heights = new Float32Array(g.heights.length)
  for (let r = 0; r < g.rows; r++) {
    const y = (g.depthMm * r) / (g.rows - 1)
    for (let c = 0; c < g.cols; c++) {
      const x = (g.widthMm * c) / (g.cols - 1)
      const d = Math.min(x, y, g.widthMm - x, g.depthMm - y)
      const t = Math.min(Math.max(d / marginMm, 0), 1)
      heights[r * g.cols + c] = g.heights[r * g.cols + c] * t * t * (3 - 2 * t)
    }
  }
  return { ...g, heights }
}

// ---- the surface points handed to the kernel ------------------------------

/**
 * An n x n grid of points on the relief (placed at `origin`, heights added to
 * `baseZ`), row-major with rows along Y: the layout occt-wasm's
 * `bsplineSurface(points, rows, cols)` takes, rows -> the surface's U.
 * MEASURED (WO-2170): the kernel FITS a B-spline through these points
 * (degree up to 8, its own pole count) - they are points ON the surface, not
 * its control poles. The four edge rows are forced to exactly baseZ so the
 * relief's boundary lies in the face.
 */
export function reliefSurfacePoints(g: HeightGrid, n: number, origin: { x: number; y: number }, baseZ: number): SurfacePoint[] {
  const pts: SurfacePoint[] = new Array(n * n)
  for (let r = 0; r < n; r++) {
    const y = (g.depthMm * r) / (n - 1)
    for (let c = 0; c < n; c++) {
      const x = (g.widthMm * c) / (n - 1)
      const edge = r === 0 || c === 0 || r === n - 1 || c === n - 1
      pts[r * n + c] = { x: origin.x + x, y: origin.y + y, z: baseZ + (edge ? 0 : heightAt(g, x, y)) }
    }
  }
  return pts
}
