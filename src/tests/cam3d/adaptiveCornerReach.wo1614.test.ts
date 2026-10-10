// WO-1614 (finding SH-4 of the Smart Heights campaign): does Adaptive 3D cut
// into the closed box's sharp vertical corners?
//
// Measured here independently of the WO-1606 gouge helper: for every cutting
// move below the box top, the exact XY distance from the tool axis to the box's
// side faces (the rectangle X 0..30, Y 0..20), with arc moves sampled ON the
// arc about their centre. The tool radius plus the radial stock to leave, less
// the operation's 0.05 mm tolerance, is the closest the axis may come.
//
// Finding (2026-09-16): the path does not reach into the box. At each corner
// the rough wraps with an arc_ccw about the corner itself, radius 3.05. The
// WO-1606 helper (solidGougeMm in src/tests/helpers/heightScenario.ts) steps
// every move as a straight line between its end points, so an arc is read as
// its chord, which cuts across the corner: that chord is the 0.75 to 1 mm
// "reach". The CHORD reading is logged below as a control.
//
// Runs through the production compute path, the same way WO-1606 does: only
// the browser transports are replaced (see heightScenario.ts, "WO-1606").

import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))

import * as scenarioModule from '../helpers/heightScenario'
import { installRealToolpathWorker, isRapid, runSolidScenario, type SolidOperationReading } from '../helpers/heightScenario'
import type { ToolpathMove } from '../../types'

installRealToolpathWorker()

const TOOL_R = 3
/** The operation's default tolerance (DEFAULT_ADAPTIVE3D_PARAMS.tolerance). */
const TOLERANCE = 0.05
/** The closed box on the table: model X 0..30, Y 0..20, Z 0..10, machine frame. */
const BOX = { x0: 0, x1: 30, y0: 0, y1: 20, top: 10 }

const toBox = (x: number, y: number) =>
  Math.hypot(Math.max(BOX.x0 - x, 0, x - BOX.x1), Math.max(BOX.y0 - y, 0, y - BOX.y1))

interface Sample { x: number; y: number; z: number; move: number }

const isArc = (m: ToolpathMove) => (m.type === 'arc_cw' || m.type === 'arc_ccw') && m.cx !== undefined && m.cy !== undefined

/** Points along move b (from a), 0.05 mm apart. `chord` treats arcs as straight
 * lines, as the WO-1606 helper does. */
function samplesOf(a: ToolpathMove, b: ToolpathMove, move: number, chord = false): Sample[] {
  const out: Sample[] = []
  if (isArc(b) && !chord) {
    const cx = b.cx!, cy = b.cy!
    const r = Math.hypot(a.x - cx, a.y - cy)
    const a0 = Math.atan2(a.y - cy, a.x - cx)
    let a1 = Math.atan2(b.y - cy, b.x - cx)
    if (b.type === 'arc_ccw') { while (a1 <= a0) a1 += 2 * Math.PI } else { while (a1 >= a0) a1 -= 2 * Math.PI }
    const n = Math.max(1, Math.ceil((Math.abs(a1 - a0) * r) / 0.05))
    for (let k = 0; k <= n; k++) {
      const t = a0 + ((a1 - a0) * k) / n
      out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t), z: a.z + ((b.z - a.z) * k) / n, move })
    }
    return out
  }
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05))
  for (let k = 0; k <= n; k++) {
    const t = k / n
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, move })
  }
  return out
}

/** Every cutting sample below the box top (where the box's side faces stand). */
function cuttingSamples(moves: readonly ToolpathMove[], chord = false): Sample[] {
  const out: Sample[] = []
  for (let i = 1; i < moves.length; i++) {
    if (isRapid(moves[i])) continue
    for (const s of samplesOf(moves[i - 1], moves[i], i, chord)) if (s.z < BOX.top) out.push(s)
  }
  return out
}

function closest(samples: readonly Sample[]): { d: number; s: Sample } {
  let best = { d: Infinity, s: samples[0] }
  for (const s of samples) {
    const d = toBox(s.x, s.y)
    if (d < best.d) best = { d, s }
  }
  return best
}

function runRough(radialStockToLeave: number): Promise<SolidOperationReading> {
  return runSolidScenario({
    part: 'closed_box', z: 0,
    stock: { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 },
    operations: [{
      kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0.5,
      params: { useStockBoundary: true, radialStockToLeave },
    }],
  }).then(readings => readings[0])
}

describe('WO-1614: Adaptive 3D keeps the cutter out of the closed box, sharp vertical corners included', () => {
  for (const radial of [0, 0.5]) {
    it(`radial stock to leave ${radial}: no cutting move closer than ${TOOL_R} + ${radial} - ${TOLERANCE} mm`, async () => {
      const r = await runRough(radial)
      expect(r.status, r.errorMessage).toBe('ready')
      const samples = cuttingSamples(r.worldMoves)
      const arcs = r.worldMoves.filter(isArc).length
      const levels = new Set(samples.map(s => s.z.toFixed(3))).size
      const trueReach = closest(samples)
      const chordReach = closest(cuttingSamples(r.worldMoves, true))
      const reach = (d: number) => +(TOOL_R + radial - d).toFixed(3)
      console.log(`[WO-1614] radial ${radial}: ${samples.length} samples, ${levels} Z values, ${arcs} arcs; ` +
        `true reach ${reach(trueReach.d)} mm at ${JSON.stringify(trueReach.s)}; ` +
        `chord (WO-1606 helper) reach ${reach(chordReach.d)} mm at ${JSON.stringify(chordReach.s)}`)

      // Not vacuous: the rough cuts below the box top and comes to its walls.
      expect(samples.length).toBeGreaterThan(0)
      expect(trueReach.d, 'the rough comes to the walls').toBeLessThanOrEqual(TOOL_R + radial + 0.5)
      // The outcome: never closer than the radial stock to leave minus the tolerance.
      expect(trueReach.d, `closest approach ${JSON.stringify(trueReach.s)}`)
        .toBeGreaterThanOrEqual(TOOL_R + radial - TOLERANCE)

      // The corner wrap is where the reading was taken: each corner the path
      // passes at a cutting level is cleared by the whole cutter.
      for (const [cx, cy] of [[BOX.x0, BOX.y0], [BOX.x1, BOX.y0], [BOX.x1, BOX.y1], [BOX.x0, BOX.y1]]) {
        const near = samples.filter(s => Math.hypot(s.x - cx, s.y - cy) < TOOL_R + radial + 0.5)
        for (const s of near) {
          expect(Math.hypot(s.x - cx, s.y - cy), `corner (${cx}, ${cy}) at ${JSON.stringify(s)}`)
            .toBeGreaterThanOrEqual(TOOL_R + radial - TOLERANCE)
        }
      }

      if (process.env.WRITE_EVIDENCE === '1' && radial === 0) writeCornerPicture(r.worldMoves, trueReach, chordReach)
    }, 180_000)
  }
})

// --- evidence: plan view of the corner (0, 0) at one level -----------------

function writeCornerPicture(
  moves: readonly ToolpathMove[], trueReach: { d: number; s: Sample }, chordReach: { d: number; s: Sample },
): void {
  const z = trueReach.s.z
  const atLevel = (chord: boolean) =>
    cuttingSamples(moves, chord).filter(s => Math.abs(s.z - z) < 1e-6)
  const dir = resolve(process.cwd(), 'src/tests/evidence/WO-1614')
  mkdirSync(dir, { recursive: true })
  const before = resolve(dir, 'corner-before-chord-reading.png')
  const after = resolve(dir, 'corner-after-true-arcs.png')
  const notes = resolve(dir, 'corner-notes.json')
  // DELETE FIRST: a stale artifact must never be mistaken for a fresh shot.
  for (const p of [before, after, notes]) rmSync(p, { force: true })
  writeFileSync(before, renderCorner(atLevel(true)))
  writeFileSync(after, renderCorner(atLevel(false)))
  writeFileSync(notes, `${JSON.stringify({
    level: `machine Z ${z} (box top 10)`,
    view: 'plan, X -8..4, Y -8..4 around the box corner (0, 0); 50 px/mm; north up',
    key: 'grey = box; blue = cutter envelope (6 mm flat) swept along the path; dark blue = tool axis; red = cutter over the box',
    before: `corner-before-chord-reading.png: arcs drawn as chords (how the WO-1606 helper samples them); reach ${
      +(TOOL_R - chordReach.d).toFixed(3)} mm into the box`,
    after: `corner-after-true-arcs.png: arcs drawn as arcs (what the machine runs); reach ${
      +(TOOL_R - trueReach.d).toFixed(3)} mm (negative = clear of the box)`,
  }, null, 2)}\n`)
}

function renderCorner(samples: readonly Sample[]): Buffer {
  const PX = 50, X0 = -8, Y0 = -8, SPAN = 12
  const w = SPAN * PX, h = SPAN * PX
  const rgb = new Uint8Array(w * h * 3)
  const inBox = (x: number, y: number) => x >= BOX.x0 && x <= BOX.x1 && y >= BOX.y0 && y <= BOX.y1
  const near = samples.filter(s => s.x > X0 - TOOL_R && s.x < X0 + SPAN + TOOL_R && s.y > Y0 - TOOL_R && s.y < Y0 + SPAN + TOOL_R)
  for (let py = 0; py < h; py++) {
    const y = Y0 + SPAN - (py + 0.5) / PX
    for (let px = 0; px < w; px++) {
      const x = X0 + (px + 0.5) / PX
      let axis = false, swept = false
      for (const s of near) {
        const d = Math.hypot(x - s.x, y - s.y)
        if (d <= 0.06) { axis = true; break }
        if (d <= TOOL_R) swept = true
      }
      const o = (py * w + px) * 3
      const box = inBox(x, y)
      const c = axis ? [20, 40, 140] : swept && box ? [210, 40, 40] : swept ? [150, 190, 235] : box ? [120, 120, 120] : [245, 245, 245]
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]
    }
  }
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (1 + w * 3) + 1)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
