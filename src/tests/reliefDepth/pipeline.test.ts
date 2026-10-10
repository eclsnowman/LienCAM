// WO-2173: the tiled depth merge leaves no seam at tile edges. The first evidence run showed straight lines
// on the soft dome fixture exactly at the tile boundaries (rows 250 and 518 of 768): each tile's wrong border
// rows, scaled up by its fit, leaked in through the feather window's small edge weights. A seam is a line
// whose curvature stands far above the rest.
import { describe, expect, it } from 'vitest'
import { featherWeights, runPipeline, tileOrigins, type RunModel } from '../../lib/reliefDepth/pipeline'

/** A relative-depth stand-in that fails the way the real model did on the dome: each tile's own depth range
 *  is tiny next to the whole-picture pass (so the fit scales it up a lot), and its outermost row and column
 *  are wrong - harmless inside the tile, a visible line wherever they leak into the merge. */
function borderyModel(): RunModel {
  let call = 0
  return async (t, w, h) => {
    const scale = call++ === 0 ? 1 : 0.01
    const plane = w * h
    const out = new Float32Array(plane)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y)
      out[y * w + x] = scale * t[y * w + x] + (edge < 1 ? 0.05 : 0)
    }
    return out
  }
}

function softDome(n: number) {
  const data = new Uint8ClampedArray(n * n * 4)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const r = Math.hypot(x - n / 2, y - n / 2) / (n / 2)
    const v = Math.round(255 * (r < 1 ? 0.5 * (1 + Math.cos(Math.PI * r)) : 0))
    data.set([v, v, v, 255], (y * n + x) * 4)
  }
  return { width: n, height: n, data }
}

describe('WO-2173 tiled depth merge', () => {
  it('leaves no seam along the tile edges', async () => {
    const n = 150, side = 56
    const r = await runPipeline(borderyModel(), { image: softDome(n), detail: 'high', fineDetail: 0, tuning: { modelSide: side, maxWorkingSide: 4096, tileOverlap: 1 / 3 } })
    expect(r.passes).toBeGreaterThan(1)
    const h = r.heights
    // mean |second difference| down each row, away from the picture's own border
    const curv: number[] = []
    for (let y = 1; y < n - 1; y++) {
      let s = 0
      for (let x = 8; x < n - 8; x++) s += Math.abs(h[(y + 1) * n + x] - 2 * h[y * n + x] + h[(y - 1) * n + x])
      curv.push(s / (n - 16))
    }
    const inner = curv.slice(8, -8)
    const sorted = [...inner].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const edges = tileOrigins(n, side, 1 / 3).flatMap(o => [o, o + side - 1]).filter(v => v > 10 && v < n - 10)
    for (const e of edges) expect(curv[e - 1], `row ${e}`).toBeLessThan(5 * median + 20)
  })

  it('gives every pixel a positive total weight, and a tile margin none', () => {
    for (const [size, tile] of [[150, 56], [90, 42], [1536, 518], [800, 518], [40, 28]]) {
      const margin = Math.max(2, Math.round(tile * 0.06))
      const ramp = Math.max(1, tile - Math.round(tile * (2 / 3)) - 2 * margin)
      const total = new Float64Array(size)
      for (const o of tileOrigins(size, tile, 1 / 3)) {
        const n = Math.min(tile, size - o)
        const wts = featherWeights(n, o, size, margin, ramp)
        wts.forEach((v, i) => { total[o + i] += v })
        if (o > 0) expect(Array.from(wts.subarray(0, margin)).every(v => v === 0)).toBe(true)
        if (o + n < size) expect(Array.from(wts.subarray(n - margin)).every(v => v === 0)).toBe(true)
      }
      expect(Math.min(...total), `size ${size} tile ${tile}`).toBeGreaterThan(0)
    }
  })

  it('places tiles overlapping, flush with the far edge, and one tile when the picture is small', () => {
    expect(tileOrigins(90, 42, 1 / 3)).toEqual([0, 28, 48])
    expect(tileOrigins(40, 42, 1 / 3)).toEqual([0])
    expect(tileOrigins(1536, 518, 1 / 3)).toEqual([0, 345, 690, 1018])
  })
})
