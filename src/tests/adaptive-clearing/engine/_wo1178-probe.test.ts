// WO-1178 DIAGNOSIS PROBE (underscore = not CI). Runs one GOOD-corpus operation at the
// project's own settings through the 2D engine, records every pass with its measured
// engagement, censuses the four bounding-box corners (3 x 3 tool radii) and renders a
// zoomed crop of each corner. Writes JSON + PNG under WO1178_OUT (default: a scratch dir).
//
// Run:  WO1178_SHAPES=Bar WO1178_DIR=climb npx vitest run src/tests/adaptive-clearing/engine/_wo1178-probe.test.ts

import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import {
  ensureEngineClipperReady, diskPath, offsetOpenRound, offsetClosed, union, difference, netArea,
  type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  processFeature, setFragmentationCensus, getFragmentationCensus, contourOverCap,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { projectFixture } from './_wo1178-fixture'

const OUT_DIR = process.env.WO1178_OUT ?? 'src/tests/evidence/WO-1178/_probe'
const SHAPES = (process.env.WO1178_SHAPES ?? 'Bar').split(',')
const DIR = (process.env.WO1178_DIR ?? 'climb') as 'climb' | 'conventional'
const TAG = process.env.WO1178_TAG ?? 'probe'
// WO1178_CANON=1: the canonical tripwire settings (R 2.0, 0.2D, tol 0.1, stock 0.5, wall finish
// OFF, helix from the gt fixture) instead of the project's, on the same project geometry.
const CANON = process.env.WO1178_CANON === '1'

// ---- minimal PNG framebuffer (copied from _wo410-corpus-render.test.ts) ----
class FB {
  buf: Uint8Array; w: number; h: number
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

const COLOR: Record<string, [number, number, number]> = {
  cut: [70, 130, 230], wallfollow: [40, 200, 180], loopback: [240, 170, 30], lead: [240, 240, 240],
  link1: [60, 200, 60], link2: [255, 60, 60], link2micro: [255, 140, 0], finish: [220, 60, 220], entry: [255, 255, 0],
}

function polyLen(p: Pt[]): number { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); return s }
function chordDev(p: Pt[]): number {
  if (p.length < 3) return 0
  const a = p[0], b = p[p.length - 1]
  const L = Math.hypot(b.x - a.x, b.y - a.y)
  if (L < 1e-9) return polyLen(p)
  let worst = 0
  for (const q of p) {
    const d = Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / L
    if (d > worst) worst = d
  }
  return worst
}
function segHitsSquare(a: Pt, b: Pt, sq: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1))
  for (let k = 0; k <= n; k++) {
    const t = k / n
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
    if (x >= sq.x0 && x <= sq.x1 && y >= sq.y0 && y <= sq.y1) return true
  }
  return false
}

// WO-1093 rule: evidence is written only on request. Without WRITE_EVIDENCE=1 this probe is
// skipped, so the declared test-slice never overwrites the committed BEFORE files under
// `_probe/` (WO-1178 audit finding 3).
describe.runIf(process.env.WRITE_EVIDENCE === '1')(`WO-1178 probe (${TAG}, ${DIR})`, () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  for (const name of SHAPES) {
    it(`probes ${name}`, () => {
      const { boundary, holes, params } = projectFixture(name, { direction: DIR, canonical: CANON })
      const R = params.toolRadius
      const arcTol = Math.max(params.tolerance * 0.25, 0.01)
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
      setFragmentationCensus(true)
      const t0 = performance.now()
      let res
      try { res = processFeature({ boundary, holes }, params) } finally { console.warn = warn; setFragmentationCensus(false) }
      const seconds = (performance.now() - t0) / 1000
      const census = getFragmentationCensus()

      // Progressive cleared belief, folded the way the engine folds it (entry disks + cut corridors).
      let cleared: Loops = []
      const records: Record<string, unknown>[] = []
      const byType: Record<string, number> = {}
      res.passes.forEach((pass, index) => {
        const key = pass.type === 'link' ? `link${pass.jumpType}${pass.microLift ? 'micro' : ''}` : pass.type
        byType[key] = (byType[key] ?? 0) + 1
        if (pass.type === 'entry') {
          records.push({ index, type: 'entry', mode: pass.mode, x: +pass.point.x.toFixed(3), y: +pass.point.y.toFixed(3), radius: +pass.radius.toFixed(3) })
          cleared = union(cleared, diskPath(pass.point, R + pass.radius, arcTol))
          return
        }
        const pts = pass.points
        // The engine's own windowed measure against the physical belief (growing stock along
        // the ride), with the short-circuit sentinel bypassed: `peakWidth` is the 2 mm-window
        // peak, `stepWidth` the deepest 0.75 mm sub-step bite.
        const load = pass.type === 'link' && pass.jumpType === 2
          ? { peak: 0, maxStep: 0 }
          : contourOverCap(pts, cleared, R, 1e9, arcTol, true)
        const rec: Record<string, unknown> = {
          index, type: key, n: pts.length, len: +polyLen(pts).toFixed(3),
          from: [+pts[0].x.toFixed(3), +pts[0].y.toFixed(3)], to: [+pts[pts.length - 1].x.toFixed(3), +pts[pts.length - 1].y.toFixed(3)],
          chordDev: +chordDev(pts).toFixed(3), peakWidth: +load.peak.toFixed(3), stepWidth: +load.maxStep.toFixed(3),
        }
        if (pass.type === 'link') {
          rec.liftReason = (pass as unknown as { liftReason?: string }).liftReason
          rec.helix = pass.helixDescent ? { x: +pass.helixDescent.center.x.toFixed(2), y: +pass.helixDescent.center.y.toFixed(2), r: +pass.helixDescent.radius.toFixed(2) } : undefined
        }
        records.push(rec)
        // Physical truth: every at-depth motion sweeps its capsule -- a wall ride, a loopback, a
        // lead and a keep-down link remove stock exactly as a cut does. Measuring later moves
        // against a belief that omits them inflates their bite (the engine's own `cleared`
        // omits rides on purpose, as the conservative side for its gates).
        if (pass.type === 'cut' || pass.type === 'wallfollow' || pass.type === 'loopback' || pass.type === 'lead' || pass.type === 'finish' || (pass.type === 'link' && pass.jumpType === 1)) {
          if (pts.length >= 2) cleared = union(cleared, offsetOpenRound(pts, R, arcTol))
        }
      })

      // Corner census on the bounding box corners, 3 x 3 tool radii square inside each corner.
      const xs = boundary.map(p => p.x), ys = boundary.map(p => p.y)
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
      const side = 3 * R
      const corners = {
        topLeft: { x0: minX, y0: maxY - side, x1: minX + side, y1: maxY },
        topRight: { x0: maxX - side, y0: maxY - side, x1: maxX, y1: maxY },
        bottomLeft: { x0: minX, y0: minY, x1: minX + side, y1: minY + side },
        bottomRight: { x0: maxX - side, y0: minY, x1: maxX, y1: minY + side },
      }
      const cornerCensus: Record<string, unknown[]> = {}
      for (const [cname, sq] of Object.entries(corners)) {
        const hits: unknown[] = []
        res.passes.forEach((pass, index) => {
          if (pass.type === 'entry') return
          const pts = pass.points
          let inside = false
          for (let i = 1; i < pts.length && !inside; i++) inside = segHitsSquare(pts[i - 1], pts[i], sq)
          if (inside) hits.push(records[index])
        })
        cornerCensus[cname] = hits
      }

      // Residual AFTER the wall stack, as the corpus render measures it: target region minus the
      // cut belief minus every emitted wall ride's capsule and the true-wall finish lap's sweep.
      const finishStock = params.tolerance / 2 + (params.stockToLeave ?? 0)
      const targetRegion = difference(offsetClosed([boundary], -finishStock, arcTol), offsetClosed(holes, finishStock, arcTol))
      const wallRegion = difference(offsetClosed([boundary], -R, arcTol), offsetClosed(holes, R, arcTol))
      let swept: Loops = wallRegion.length ? difference(offsetClosed(wallRegion, R, arcTol), offsetClosed(wallRegion, -R, arcTol)) : []
      for (const pass of res.passes) {
        if ((pass.type === 'wallfollow' || pass.type === 'finish') && pass.points.length >= 2) swept = union(swept, offsetOpenRound(pass.points, R, arcTol))
      }
      const afterStack = difference(difference(targetRegion, res.cleared), swept)
      const afterStackLoops = afterStack.map(l => { const xs = l.map(p => p.x), ys = l.map(p => p.y); return { area: +netArea([l]).toFixed(3), x: +((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(2), y: +((Math.min(...ys) + Math.max(...ys)) / 2).toFixed(2), w: +(Math.max(...xs) - Math.min(...xs)).toFixed(2), h: +(Math.max(...ys) - Math.min(...ys)).toFixed(2) } }).filter(l => Math.abs(l.area) > 0.02)
      const endReasons: Record<string, number> = {}
      for (const e of census.passEnds) endReasons[e.reason] = (endReasons[e.reason] ?? 0) + 1
      const summary = {
        name, direction: DIR, seconds: +seconds.toFixed(1), params,
        entries: res.entries.map(e => ({ mode: e.mode, x: +e.point.x.toFixed(2), y: +e.point.y.toFixed(2), r: +e.radius.toFixed(2) })),
        byType, endReasons, reseeds: census.reseeds, aborted: res.stats.aborted ?? null,
        passEnds: census.passEnds.map(e => ({ pass: e.pass, reason: e.reason, detail: e.detail, x: +e.x.toFixed(2), y: +e.y.toFixed(2), travel: +e.travel.toFixed(2), area: +e.area.toFixed(2), kept: e.kept })),
        residual: +res.stats.residualArea.toFixed(3),
        residualAfterStack: +Math.abs(netArea(afterStack)).toFixed(3), afterStackLoops,
        residualLoops: res.residual.map(l => { const xs = l.map(p => p.x), ys = l.map(p => p.y); let a = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p.x * q.y - q.x * p.y } return { area: +(a / 2).toFixed(3), x: +((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(2), y: +((Math.min(...ys) + Math.max(...ys)) / 2).toFixed(2), w: +(Math.max(...xs) - Math.min(...xs)).toFixed(2), h: +(Math.max(...ys) - Math.min(...ys)).toFixed(2) } }),
        lifts: records.filter(r => typeof r.type === 'string' && (r.type as string).startsWith('link2')),
        bbox: { minX, maxX, minY, maxY },
        cornerCounts: Object.fromEntries(Object.entries(cornerCensus).map(([k, v]) => [k, v.length])),
      }
      fs.mkdirSync(OUT_DIR, { recursive: true })
      fs.writeFileSync(`${OUT_DIR}/${name}_${DIR}_${TAG}_summary.json`, JSON.stringify(summary, null, 1))
      fs.writeFileSync(`${OUT_DIR}/${name}_${DIR}_${TAG}_passes.json`, JSON.stringify(records, null, 0))
      fs.writeFileSync(`${OUT_DIR}/${name}_${DIR}_${TAG}_corners.json`, JSON.stringify(cornerCensus, null, 1))
      fs.writeFileSync(`${OUT_DIR}/${name}_${DIR}_${TAG}_warnings.txt`, warnings.join('\n'))
      fs.writeFileSync(`${OUT_DIR}/${name}_${DIR}_${TAG}_stream.json`, JSON.stringify(res.passes))
      const cutLens = res.passes.filter(p => p.type === 'cut').map(p => polyLen(p.points))
      const hist = { under1: cutLens.filter(l => l < 1).length, under3: cutLens.filter(l => l >= 1 && l < 3).length, under10: cutLens.filter(l => l >= 3 && l < 10).length, over10: cutLens.filter(l => l >= 10).length }
      console.log(`[wo1178-probe] ${name} ${DIR}${CANON ? ' CANON' : ''}: ${JSON.stringify({ byType, endReasons, entries: summary.entries, cornerCounts: summary.cornerCounts, residual: summary.residual, aborted: summary.aborted, seconds: summary.seconds, cutLenHist: hist })}`)

      // Corner crops: 12 mm window at 50 px/mm, anchored on each corner.
      const win = 12, scale = 50
      const drawCrop = (cname: string, cx: number, cy: number, sx: 1 | -1, sy: 1 | -1) => {
        const fb = new FB(win * scale, win * scale, [18, 18, 18])
        // world -> px: the corner sits at a margin of 1 mm from the crop edge.
        const ox = sx > 0 ? cx - 1 : cx + 1 - win
        const oy = sy > 0 ? cy - 1 : cy + 1 - win
        const px = (p: Pt) => ({ x: (p.x - ox) * scale, y: (win - (p.y - oy)) * scale })
        const drawPoly = (pts: Pt[], c: [number, number, number], r = 0) => {
          for (let i = 1; i < pts.length; i++) { const a = px(pts[i - 1]), b = px(pts[i]); fb.line(a.x, a.y, b.x, b.y, c, r) }
        }
        for (const lp of res.cutRegion) drawPoly([...lp, lp[0]], [90, 90, 90])
        drawPoly([...boundary, boundary[0]], [150, 150, 150])
        for (const pass of res.passes) {
          if (pass.type === 'entry') continue
          const key = pass.type === 'link' ? `link${pass.jumpType}${pass.microLift ? 'micro' : ''}` : pass.type
          drawPoly(pass.points, COLOR[key] ?? [255, 255, 255], key === 'cut' ? 1 : 0)
        }
        fs.writeFileSync(`${OUT_DIR}/${name}_${DIR}_${TAG}_${cname}.png`, fb.png())
      }
      // WO1178_CROP="x,y,size": an extra crop centred anywhere (diagnosis of a named spot).
      if (process.env.WO1178_CROP) {
        const [cxs, cys, szs] = process.env.WO1178_CROP.split(',')
        const cx = Number(cxs), cy = Number(cys), sz = Number(szs)
        const fb = new FB(sz * scale, sz * scale, [18, 18, 18])
        const ox = cx - sz / 2, oy = cy - sz / 2
        const px = (p: Pt) => ({ x: (p.x - ox) * scale, y: (sz - (p.y - oy)) * scale })
        const drawPoly = (pts: Pt[], c: [number, number, number], r = 0) => {
          for (let i = 1; i < pts.length; i++) { const a = px(pts[i - 1]), b = px(pts[i]); fb.line(a.x, a.y, b.x, b.y, c, r) }
        }
        for (const lp of res.cutRegion) drawPoly([...lp, lp[0]], [90, 90, 90])
        for (const lp of res.residual) drawPoly([...lp, lp[0]], [255, 40, 40])
        res.passes.forEach((pass, index) => {
          if (pass.type === 'entry') return
          const key = pass.type === 'link' ? `link${pass.jumpType}${pass.microLift ? 'micro' : ''}` : pass.type
          drawPoly(pass.points, COLOR[key] ?? [255, 255, 255], key === 'cut' ? 1 : 0)
          const p0 = px(pass.points[0]); if (key === 'cut') fb.dot(p0.x, p0.y, [255, 255, 0], 2)
          void index
        })
        fs.writeFileSync(`${OUT_DIR}/${name}_${DIR}_${TAG}_crop.png`, fb.png())
      }
      drawCrop('topLeft', minX, maxY, 1, -1)
      drawCrop('topRight', maxX, maxY, -1, -1)
      drawCrop('bottomLeft', minX, minY, 1, 1)
      drawCrop('bottomRight', maxX, minY, -1, 1)
    }, 300_000)
  }
})
