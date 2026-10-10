// VISUAL DEV TOOL (not a CI assertion -- gated behind DUMP=1 so the normal suite
// skips it). Runs the adaptive engine on a ground-truth fixture and renders a PNG of
// the toolpath for visual review, using a pure-JS PNG encoder (node zlib for deflate,
// no extra deps). Also prints coverage + effective-stepover stats.
//
//   DUMP=1 FIX=2 npx vitest run src/tests/adaptive-clearing/engine/_visual-dump.test.ts
//   DUMP=1 FIX=0 STEPOVER=0.4 OUT=comma40.png npx vitest run .../_visual-dump.test.ts
//
// Colors: cut=blue, keep-down link=green, lift link=red, wall=gray, island=rose,
// tool-centre region=dim gray, cleared outline=dim blue, helix start=yellow.
import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import { ensureEngineClipperReady, totalArea, intersection, difference, offsetClosed, type Loop, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { importDXF } from '../../../lib/import/dxfImporter'

// Load boundary + holes either from a GT fixture JSON (FIX=n) or a real DXF (DXF=path).
// For a DXF: largest-area closed loop = outer contour (boundary); every other closed loop
// with area > 1mm2 that sits inside it = island/hole. Prints the loop inventory so the
// boundary/island choice is visible and correctable.
function loadFeature(): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const dxfPath = process.env.DXF
  if (dxfPath) {
    const fsx = fs.readFileSync(dxfPath, 'utf8')
    const { loops } = importDXF(fsx)
    const closed = loops.filter(l => l.closed && l.points.length >= 3).sort((a, b) => b.area - a.area)
    if (closed.length === 0) throw new Error(`DXF ${dxfPath} has no closed loops`)
    const toLoop = (pts: { x: number; y: number }[]): Loop => pts.map(p => ({ x: p.x, y: p.y }))
    const boundary = toLoop(closed[0].points)
    // MAXISLANDS caps the number of islands (largest-first) to match a real op's loop
    // selection (e.g. outer + one pocket); default = all closed loops > 1mm2.
    const maxIslands = Number(process.env.MAXISLANDS ?? 9999)
    const holes = closed.slice(1).filter(l => l.area > 1).slice(0, maxIslands).map(l => toLoop(l.points))
    // eslint-disable-next-line no-console
    console.log(`DXF ${dxfPath}: ${closed.length} closed loops -> boundary area=${closed[0].area.toFixed(1)}mm2, ${holes.length} island(s) [${closed.slice(1).filter(l => l.area > 1).map(l => l.area.toFixed(1)).join(', ')}]mm2`)
    return { boundary, holes, helixDiameter: 3, name: dxfPath.split(/[\\/]/).pop() ?? 'dxf' }
  }
  const FIX = process.env.FIX ?? '0'
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${FIX}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

// --- tiny RGBA framebuffer + PNG encoder --------------------------------------
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

describe.runIf(!!process.env.DUMP)('adaptive visual dump', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it('renders a fixture toolpath to PNG', () => {
    const { boundary, holes, helixDiameter, name } = loadFeature()
    const STEPOVER = Number(process.env.STEPOVER ?? 0.2)
    const TOOLR = Number(process.env.TOOLR ?? 2.0)
    // Review images live in review-images/ (gitignored), not the project root.
    const OUT_DIR = 'review-images'
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const OUT = `${OUT_DIR}/${process.env.OUT ?? `${process.env.DXF ? 'dxf' : 'fix' + (process.env.FIX ?? '0')}-adaptive.png`}`
    const d = { name }
    const params = { toolRadius: TOOLR, stepOver: STEPOVER, tolerance: 0.1, helixDiameter, stockToLeave: 0.5, integralWallFollow: !!process.env.WALLFOLLOW, wallCleanupAsWeGo: !!process.env.WALLCLEAN2, loopbackFilletPct: Number(process.env.FILLETPCT ?? 25) }
    const t0 = Date.now()
    const res = processFeature({ boundary, holes }, params)
    const ms = Date.now() - t0

    const cutPasses = res.passes.filter(p => p.type === 'cut')
    const finishStock = params.tolerance / 2 + params.stockToLeave
    const targetRaw = offsetClosed([boundary], -finishStock)
    const islandGrown = holes.length ? offsetClosed(holes, finishStock) : []
    const target = islandGrown.length ? difference(targetRaw, islandGrown) : targetRaw
    const coverage = totalArea(intersection(res.cleared, target)) / totalArea(target)
    const links = res.passes.filter(p => p.type === 'link') as { jumpType: 1 | 2 }[]
    let cutLen = 0
    for (const p of cutPasses) for (let i = 1; i < p.points.length; i++) cutLen += Math.hypot(p.points[i].x - p.points[i - 1].x, p.points[i].y - p.points[i - 1].y)
    const clearedArea = totalArea(res.cleared)
    const helixEntries = res.entries.filter(e => e.mode === 'helix').length
    const plungeEntries = res.entries.filter(e => e.mode === 'plunge').length
    // eslint-disable-next-line no-console
    console.log(`${d.name}: ${ms}ms cutPasses=${cutPasses.length} entries=${res.entries.length}(helix ${helixEntries}/plunge ${plungeEntries}) links(keep/lift)=${links.filter(l => l.jumpType === 1).length}/${links.filter(l => l.jumpType === 2).length} coverage=${(coverage * 100).toFixed(1)}% | GAP residualArea=${res.stats.residualArea.toFixed(2)}mm2 worstGapR=${res.stats.residualMaxInscribedR.toFixed(2)}mm aborted=${res.stats.aborted ?? 'no'}`)
    // eslint-disable-next-line no-console
    console.log(`  spacing nominal=${(params.stepOver * params.toolRadius * 2).toFixed(3)}mm measured(area/len)=${(clearedArea / cutLen).toFixed(3)}mm`)
    // wall-clean transition telemetry (loopback vs wallfollow vs link breakdown)
    const loopbackPasses = res.passes.filter(p => p.type === 'loopback') as { points: Pt[] }[]
    const loopbacks = loopbackPasses.length
    const wallfollows = res.passes.filter(p => p.type === 'wallfollow').length
    // cross-loop audit: project each emitted loopback's first/last point onto the cutRegion loops;
    // a same-loop guard should make this 0.
    const nearestLoop = (pt: Pt): number => {
      let bi = -1, bd = Infinity
      for (let li = 0; li < res.cutRegion.length; li++) {
        const lp = res.cutRegion[li]
        for (let i = 0; i < lp.length; i++) {
          const a = lp[i], b = lp[(i + 1) % lp.length]
          const abx = b.x - a.x, aby = b.y - a.y
          const L2 = abx * abx + aby * aby
          let t = L2 > 1e-12 ? ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / L2 : 0
          t = Math.max(0, Math.min(1, t))
          const dx = pt.x - (a.x + abx * t), dy = pt.y - (a.y + aby * t)
          const d = Math.hypot(dx, dy)
          if (d < bd) { bd = d; bi = li }
        }
      }
      return bi
    }
    let crossLoopLB = 0
    for (const lb of loopbackPasses) {
      const l0 = nearestLoop(lb.points[0]), l1 = nearestLoop(lb.points[lb.points.length - 1])
      if (l0 !== l1) crossLoopLB++
    }
    // eslint-disable-next-line no-console
    console.log(`  WALLCLEAN: loopbacks=${loopbacks} crossLoopLoopbacks=${crossLoopLB} wallfollows=${wallfollows} keepLinks=${links.filter(l => l.jumpType === 1).length} liftLinks=${links.filter(l => l.jumpType === 2).length}`)

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of boundary) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    const pad = 3, S = Math.min(1100 / (maxX - minX + 2 * pad), 1100 / (maxY - minY + 2 * pad))
    const W = Math.ceil((maxX - minX + 2 * pad) * S), H = Math.ceil((maxY - minY + 2 * pad) * S)
    const T = (p: Pt): [number, number] => [(p.x - minX + pad) * S, ((maxY - p.y) + pad) * S]
    const fb = new FB(W, H, [17, 17, 17])
    const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
      if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    }
    for (const loop of res.cleared) drawLoop(loop, [40, 70, 100], true)
    drawLoop(boundary, [140, 140, 140], true)
    for (const h of holes) drawLoop(h, [180, 120, 120], true)
    for (const loop of res.cutRegion) drawLoop(loop, [80, 80, 80], true)
    for (const p of res.passes) if (p.type === 'link') drawLoop(p.points, p.jumpType === 2 ? [230, 40, 50] : [40, 200, 40], false)
    for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [78, 166, 255], false, 1)
    // integral wall-follow passes (teal) -- the wall-rides that replaced lifts
    for (const p of res.passes) if (p.type === 'wallfollow') drawLoop(p.points, [0, 208, 160], false, 1)
    // wall-clean loopback passes (amber: fillet -> fast-traverse -> fillet) over cleared stock
    for (const p of res.passes) if (p.type === 'loopback') drawLoop(p.points, [255, 180, 0], false, 1)
    // Phase A diagnostic: recovered wall-follow spans (bright orange), start=green dot,
    // end=red dot. Lets us see whether the span is a forward wall-follow from the arc end
    // or a retrace from the pass start. Only present on links that carry one.
    if (process.env.SPANS) for (const p of res.passes) if (p.type === 'link' && p.boundarySpan) {
      drawLoop(p.boundarySpan, [255, 160, 0], false, 1)
      const s = T(p.boundarySpan[0]); fb.dot(s[0], s[1], [0, 255, 0], 2)
      const e = T(p.boundarySpan[p.boundarySpan.length - 1]); fb.dot(e[0], e[1], [255, 0, 0], 2)
    }
    // residual uncut stock in bright magenta (thick) so gaps are unmissable
    for (const loop of res.residual) drawLoop(loop, [255, 0, 200], true, 1)
    // entries: helix = yellow ring + dot, plunge = orange dot
    for (const e of res.entries) {
      const col: [number, number, number] = e.mode === 'helix' ? [255, 230, 0] : [255, 140, 0]
      const c = T(e.point); fb.dot(c[0], c[1], col, 3)
      if (e.radius > 0) for (let a = 0; a < 360; a += 5) {
        const p = T({ x: e.point.x + e.radius * Math.cos(a * Math.PI / 180), y: e.point.y + e.radius * Math.sin(a * Math.PI / 180) })
        fb.dot(p[0], p[1], col, 0)
      }
    }
    fs.writeFileSync(OUT, fb.png())
    // eslint-disable-next-line no-console
    console.log('wrote', OUT, `${W}x${H}`)
  }, 120_000)
})
