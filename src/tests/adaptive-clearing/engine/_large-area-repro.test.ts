// REPRO TOOL (env-gated, NOT a CI assertion). Investigates the large-area bug report:
// "did a spiral out but did not fill the large space and eventually shot over to the
// edge and ended". Runs the engine on a synthetic LARGE rectangle pocket and dumps a
// PNG + numeric evidence (cut length, pass count, toolpath bbox vs pocket, coverage,
// end point, longest non-cut hop, abort reason, elapsed ms).
//
//   REPRO=1 npx vitest run src/tests/adaptive-clearing/engine/_large-area-repro.test.ts
//   REPRO=1 W=600 H=400 STEPOVER=0.25 OUT=big600.png npx vitest run ...
//
// Env knobs: W,H = rectangle size mm (default 300x200); STEPOVER = fraction of tool
// DIAMETER (default 0.25 = 1mm with 4mm tool); TOOLR (default 2); SHAPE=L for a big
// L-shape; CORNER=1 puts a notch so the helix seeds near a corner; OUT = png name.
import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import { ensureEngineClipperReady, totalArea, intersection, offsetClosed, type Loop, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

// --- tiny RGBA framebuffer + PNG encoder (copy of _visual-dump's) ---------------
class FB {
  buf: Uint8Array
  w: number
  h: number
  constructor(w: number, h: number, bg: [number, number, number]) {
    this.w = w; this.h = h
    this.buf = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) { this.buf[i * 4] = bg[0]; this.buf[i * 4 + 1] = bg[1]; this.buf[i * 4 + 2] = bg[2]; this.buf[i * 4 + 3] = 255 }
  }
  px(x: number, y: number, c: [number, number, number]) {
    x |= 0; y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; this.buf[i + 3] = 255
  }
  dot(x: number, y: number, c: [number, number, number], r = 0) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.px(x + dx, y + dy, c)
  }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], r = 0) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (; ;) {
      this.dot(x0, y0, c, r)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  png(): Buffer {
    const raw = Buffer.alloc(this.h * (this.w * 4 + 1))
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 4 + 1)] = 0
      this.buf.subarray(y * this.w * 4, (y + 1) * this.w * 4).forEach((v, i) => { raw[y * (this.w * 4 + 1) + 1 + i] = v })
    }
    const idat = zlib.deflateSync(raw)
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
      const t = Buffer.from(type, 'ascii')
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0)
      return Buffer.concat([len, t, data, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 6
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
  }
}
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c
}

function makeBoundary(): { boundary: Loop; name: string } {
  const W = Number(process.env.W ?? 300)
  const H = Number(process.env.H ?? 200)
  if (process.env.SHAPE === 'L') {
    // big L: full W x H minus a (W*0.55 x H*0.55) bite out of the top-right
    const bw = W * 0.55, bh = H * 0.55
    return {
      name: `L-${W}x${H}`,
      boundary: [
        { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H - bh },
        { x: W - bw, y: H - bh }, { x: W - bw, y: H }, { x: 0, y: H },
      ],
    }
  }
  return {
    name: `rect-${W}x${H}`,
    boundary: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }],
  }
}

describe.runIf(!!process.env.REPRO)('large-area adaptive repro', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it('runs the engine on a large rectangle and dumps evidence', () => {
    const { boundary, name } = makeBoundary()
    const STEPOVER = Number(process.env.STEPOVER ?? 0.25) // fraction of tool DIAMETER
    const TOOLR = Number(process.env.TOOLR ?? 2.0)
    const params = {
      toolRadius: TOOLR, stepOver: STEPOVER, tolerance: 0.1, helixDiameter: 3,
      stockToLeave: 0.5,
    }
    const t0 = Date.now()
    const res = processFeature({ boundary, holes: [] }, params)
    const ms = Date.now() - t0

    // ---- numeric evidence -------------------------------------------------
    const cutPasses = res.passes.filter(p => p.type === 'cut') as { points: Pt[] }[]
    let cutLen = 0
    let tminX = Infinity, tminY = Infinity, tmaxX = -Infinity, tmaxY = -Infinity
    for (const p of cutPasses) {
      for (let i = 0; i < p.points.length; i++) {
        const q = p.points[i]
        tminX = Math.min(tminX, q.x); tminY = Math.min(tminY, q.y)
        tmaxX = Math.max(tmaxX, q.x); tmaxY = Math.max(tmaxY, q.y)
        if (i > 0) cutLen += Math.hypot(q.x - p.points[i - 1].x, q.y - p.points[i - 1].y)
      }
    }
    const finishStock = params.tolerance / 2 + params.stockToLeave
    const target = offsetClosed([boundary], -finishStock)
    const targetA = totalArea(target)
    const coverage = totalArea(intersection(res.cleared, target)) / targetA
    const clearedArea = totalArea(res.cleared)

    // end of path + the longest single hop between consecutive emitted points (any pass type)
    let lastPt: Pt | null = null
    let longestHop = 0; let hopFrom: Pt = { x: 0, y: 0 }; let hopTo: Pt = { x: 0, y: 0 }; let hopKind = ''
    for (const p of res.passes) {
      const pts: Pt[] = (p as { points?: Pt[] }).points ?? []
      if (pts.length === 0) continue
      if (lastPt) {
        const d = Math.hypot(pts[0].x - lastPt.x, pts[0].y - lastPt.y)
        if (d > longestHop) { longestHop = d; hopFrom = lastPt; hopTo = pts[0]; hopKind = `gap->${p.type}` }
      }
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
        if (d > longestHop) { longestHop = d; hopFrom = pts[i - 1]; hopTo = pts[i]; hopKind = p.type }
      }
      lastPt = pts[pts.length - 1]
    }
    // last CUT pass specifics
    const lastCut = cutPasses[cutPasses.length - 1]
    const lastCutStart = lastCut?.points[0]
    const lastCutEnd = lastCut?.points[lastCut.points.length - 1]
    let lastCutLen = 0
    if (lastCut) for (let i = 1; i < lastCut.points.length; i++) lastCutLen += Math.hypot(lastCut.points[i].x - lastCut.points[i - 1].x, lastCut.points[i].y - lastCut.points[i - 1].y)

    /* eslint-disable no-console */
    console.log(`${name}: ${ms}ms tool=D${TOOLR * 2} stepover=${(STEPOVER * TOOLR * 2).toFixed(2)}mm`)
    console.log(`  cutPasses=${cutPasses.length} totalPoints=${res.stats.points} entries=${res.entries.length} aborted=${res.stats.aborted ?? 'no'}`)
    console.log(`  cutLen=${cutLen.toFixed(0)}mm clearedArea=${clearedArea.toFixed(0)}mm2 targetArea=${targetA.toFixed(0)}mm2 coverage=${(coverage * 100).toFixed(1)}%`)
    console.log(`  residualArea=${res.stats.residualArea.toFixed(1)}mm2 worstGapR=${res.stats.residualMaxInscribedR.toFixed(2)}mm`)
    console.log(`  toolpathBBox=[${tminX.toFixed(1)},${tminY.toFixed(1)}]..[${tmaxX.toFixed(1)},${tmaxY.toFixed(1)}] pocket=[0,0]..[${boundary[1].x},${boundary[boundary.length - 1].y}]`)
    console.log(`  pathEnd=(${lastPt?.x.toFixed(1)},${lastPt?.y.toFixed(1)}) lastCut: start=(${lastCutStart?.x.toFixed(1)},${lastCutStart?.y.toFixed(1)}) end=(${lastCutEnd?.x.toFixed(1)},${lastCutEnd?.y.toFixed(1)}) len=${lastCutLen.toFixed(1)}mm pts=${lastCut?.points.length}`)
    console.log(`  longestHop=${longestHop.toFixed(1)}mm [${hopKind}] (${hopFrom.x.toFixed(1)},${hopFrom.y.toFixed(1)})->(${hopTo.x.toFixed(1)},${hopTo.y.toFixed(1)})`)
    // per-pass digest of the LAST few passes (kind, npts, start->end) to see the ending
    const tail = res.passes.slice(-8)
    for (const p of tail) {
      const pts: Pt[] = (p as { points?: Pt[] }).points ?? []
      if (pts.length === 0) { console.log(`  tail ${p.type}: (no points)`); continue }
      console.log(`  tail ${p.type}: ${pts.length}pts (${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)})->(${pts[pts.length - 1].x.toFixed(1)},${pts[pts.length - 1].y.toFixed(1)})`)
    }

    // ---- render -----------------------------------------------------------
    const OUT_DIR = 'review-images'
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const OUT = `${OUT_DIR}/${process.env.OUT ?? `large-${name}-adaptive.png`}`
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of boundary) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    const pad = 5, S = Math.min(1400 / (maxX - minX + 2 * pad), 1400 / (maxY - minY + 2 * pad))
    const Wpx = Math.ceil((maxX - minX + 2 * pad) * S), Hpx = Math.ceil((maxY - minY + 2 * pad) * S)
    const T = (p: Pt): [number, number] => [(p.x - minX + pad) * S, ((maxY - p.y) + pad) * S]
    const fb = new FB(Wpx, Hpx, [17, 17, 17])
    const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
      if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    }
    for (const loop of res.cleared) drawLoop(loop, [40, 70, 100], true)
    drawLoop(boundary, [140, 140, 140], true)
    for (const loop of res.cutRegion) drawLoop(loop, [80, 80, 80], true)
    for (const p of res.passes) if (p.type === 'link') drawLoop(p.points, p.jumpType === 2 ? [230, 40, 50] : [40, 200, 40], false)
    for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [78, 166, 255], false, 1)
    for (const loop of res.residual) drawLoop(loop, [255, 0, 200], true, 1)
    for (const e of res.entries) {
      const col: [number, number, number] = e.mode === 'helix' ? [255, 230, 0] : [255, 140, 0]
      const c = T(e.point); fb.dot(c[0], c[1], col, 3)
    }
    // mark the path END with a big white dot, and the longest hop in bright red thick
    if (lastPt) { const c = T(lastPt); fb.dot(c[0], c[1], [255, 255, 255], 4) }
    if (longestHop > 0) { const a = T(hopFrom), b = T(hopTo); fb.line(a[0], a[1], b[0], b[1], [255, 60, 60], 1) }
    fs.writeFileSync(OUT, fb.png())
    console.log('wrote', OUT, `${Wpx}x${Hpx}`)
    /* eslint-enable no-console */
  }, 600_000)
})
