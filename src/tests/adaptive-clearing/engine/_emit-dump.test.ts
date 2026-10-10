// VISUAL DEV TOOL (gated behind DUMP=1 so the normal suite skips it). Runs the full
// engine entry buildAdaptiveClearingToolpath on a ground-truth fixture and renders the
// EMITTED ToolpathMove[] to a PNG -- the Phase-5 analog of _visual-dump (which renders
// the 2D processFeature output). Top view; cut moves are shaded by Z (depth level), so
// the multi-depth replay is visible; helix = yellow, plunge = orange, lift rapids = dim
// red, keep-down stepover = green.
//
//   DUMP=1 FIX=0 npx vitest run src/tests/adaptive-clearing/engine/_emit-dump.test.ts
//   DUMP=1 FIX=4 OUT=emit-fix4.png STEPOVER=0.2 npx vitest run .../_emit-dump.test.ts
import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { buildAdaptiveClearingToolpath } from '../../../lib/cam/adaptiveClearing2d/engine'
import type { ACWorkerPayload } from '../../../lib/cam/types'
import type { Tool, ToolpathMove } from '../../../types'

class FB {
  buf: Uint8Array; w: number; h: number
  constructor(w: number, h: number, bg: [number, number, number]) {
    this.w = w; this.h = h; this.buf = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) { this.buf[i * 4] = bg[0]; this.buf[i * 4 + 1] = bg[1]; this.buf[i * 4 + 2] = bg[2]; this.buf[i * 4 + 3] = 255 }
  }
  px(x: number, y: number, c: [number, number, number]) {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4; this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; this.buf[i + 3] = 255
  }
  dot(x: number, y: number, c: [number, number, number], r = 0) { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.px(x + dx, y + dy, c) }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], r = 0) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0); const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let err = dx + dy
    for (; ;) { this.dot(x0, y0, c, r); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx } if (e2 <= dx) { err += dx; y0 += sy } }
  }
  png(): Buffer {
    const raw = Buffer.alloc(this.h * (this.w * 4 + 1))
    for (let y = 0; y < this.h; y++) { raw[y * (this.w * 4 + 1)] = 0; this.buf.subarray(y * this.w * 4, (y + 1) * this.w * 4).forEach((v, i) => { raw[y * (this.w * 4 + 1) + 1 + i] = v }) }
    const idat = zlib.deflateSync(raw)
    const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0); return Buffer.concat([len, t, data, crc]) }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 6
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
  }
}
function crc32(buf: Buffer): number { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) } return ~c }

const tool = {
  id: 't', name: 'EM4', type: 'flat', diameter: 4, fluteLength: 20, shankDiameter: 4, overallLength: 50,
  numberOfFlutes: 3, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { feedRate: 1200, plungeRate: 400, rampFeedrate: 600, rpm: 10000 } },
} as unknown as Tool

describe.runIf(!!process.env.DUMP)('adaptive emit dump', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it('renders the emitted toolpath to PNG', async () => {
    const FIX = process.env.FIX ?? '0'
    const STEPOVER_FRAC = Number(process.env.STEPOVER ?? 0.2)
    const OUT_DIR = 'review-images'
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const OUT = `${OUT_DIR}/${process.env.OUT ?? `emit-fix${FIX}.png`}`
    const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${FIX}.json`, 'utf8'))
    const boundary: Loop = (d.boundary as number[][]).map(([x, y]) => ({ x, y }))
    const islands: number[][][] = d.islands ?? []
    const helixPct = ((d.helix?.diameter ?? 3) / tool.diameter) * 100

    const payload: ACWorkerPayload = {
      opId: 'op', setupId: 's',
      params: { geometryId: 'g', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6, stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1, helixDiameter: helixPct, tolerance: 0.1 },
      heights: { clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1, topHeight: 0, topHeightMode: 'absolute', bottomHeight: -4, bottomHeightMode: 'absolute' },
      passes: { stepdown: 2, stepover: STEPOVER_FRAC * tool.diameter, stockToLeave: 0.5, finishPasses: 0, springPasses: 0 },
      linking: { entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 1, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height' },
      tool,
      loops: [
        { id: 'b', closed: true, type: 'boundary', points: boundary },
        ...islands.map((isl, i) => ({ id: `i${i}`, closed: true, type: 'island', points: isl.map(([x, y]) => ({ x, y })) })),
      ],
      wcsOrigin: { x: 0, y: 0, z: 0 },
    }

    const t0 = Date.now()
    const moves = await buildAdaptiveClearingToolpath(payload)
    const ms = Date.now() - t0

    const roleCount: Record<string, number> = {}
    let minZ = Infinity, maxZ = -Infinity
    for (const m of moves) { roleCount[m.role ?? '?'] = (roleCount[m.role ?? '?'] ?? 0) + 1; if (m.type === 'feed') { minZ = Math.min(minZ, m.z); maxZ = Math.max(maxZ, m.z) } }
    const cutZs = [...new Set(moves.filter(m => m.role === 'cut').map(m => Math.round(m.z * 100) / 100))].sort((a, b) => b - a)
    // eslint-disable-next-line no-console
    console.log(`emit fix${FIX} ${d.name}: ${ms}ms moves=${moves.length} roles=${JSON.stringify(roleCount)} cutZlevels=${JSON.stringify(cutZs)} feedZ[${minZ.toFixed(2)},${maxZ.toFixed(2)}]`)

    // --- render top view ---
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of boundary) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    const pad = 3, S = Math.min(1100 / (maxX - minX + 2 * pad), 1100 / (maxY - minY + 2 * pad))
    const W = Math.ceil((maxX - minX + 2 * pad) * S), Ht = Math.ceil((maxY - minY + 2 * pad) * S)
    const T = (x: number, y: number): [number, number] => [(x - minX + pad) * S, ((maxY - y) + pad) * S]
    const fb = new FB(W, Ht, [17, 17, 17])
    const drawLoop = (loop: { x: number; y: number }[], c: [number, number, number]) => { for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1].x, loop[i - 1].y), b = T(loop[i].x, loop[i].y); fb.line(a[0], a[1], b[0], b[1], c) } const a = T(loop[loop.length - 1].x, loop[loop.length - 1].y), b = T(loop[0].x, loop[0].y); fb.line(a[0], a[1], b[0], b[1], c) }
    drawLoop(boundary, [140, 140, 140])
    for (const isl of islands) drawLoop(isl.map(([x, y]) => ({ x, y })), [180, 120, 120])

    // depth -> blue..cyan gradient (shallow dark, deep bright)
    const depthColor = (z: number): [number, number, number] => { const t = maxZ === minZ ? 1 : (maxZ - z) / (maxZ - minZ); return [30, Math.round(90 + 110 * t), Math.round(150 + 105 * t)] }
    let prev: ToolpathMove | null = null
    for (const m of moves) {
      if (prev) {
        const a = T(prev.x, prev.y), b = T(m.x, m.y)
        let c: [number, number, number] | null = null; let r = 0
        if (m.role === 'cut') { c = depthColor(m.z); r = 1 }
        else if (m.role === 'helix') c = [255, 230, 0]
        else if (m.role === 'plunge') c = [255, 140, 0]
        else if (m.role === 'stepover') c = [40, 200, 40]
        else if (m.role === 'rapid' && m.type === 'rapid') c = [90, 30, 30] // lift travel (faint)
        if (c) fb.line(a[0], a[1], b[0], b[1], c, r)
      }
      prev = m
    }
    fs.writeFileSync(OUT, fb.png())
    // eslint-disable-next-line no-console
    console.log('wrote', OUT, `${W}x${Ht}`)
  }, 120_000)
})
