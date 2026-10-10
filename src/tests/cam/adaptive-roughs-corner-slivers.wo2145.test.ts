// WO-2145: Adaptive roughs a part whose stock is exactly its box.
//
// The Form session's knob (docs/design/FORM-ENVIRONMENT.md, Stage 4) with the default stock -
// exactly the part's bounding box - refused its Adaptive rough: "refusing a straight plunge
// through remaining stock at (-14.97, -14.97) ... helix radius 0.065 below the 0.200 minimum".
// The only material such a stock holds is the slivers at the part's rounded corners and edges,
// and every one of them is open to the outside, so the rough enters it from the side.
//
// The parts: a rounded pad and an oval knob, each 30 x 20 x 10 with a 3 mm round along the top
// edge (see Shape), each in its own box stock. They go through the application's Generate route
// (heightScenario's runSolidScenario: store actions, computeOperationToolpath, the real
// toolpath worker and the real cam3d dispatcher); only the browser transports are replaced
// (see heightScenario.ts, "WO-1606"), and the mesh transport hands the store this part. The
// project's part row is the closed-box fixture, whose bounding box (X 0..30, Y 0..20, Z 0..10)
// is exactly this part's, so the auto stock with no offsets is exactly the part's box.

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
    acquirePartMesh: async () => partMesh(currentShape),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))

import * as scenarioModule from '../helpers/heightScenario'
import { installRealToolpathWorker, isRapid, runSolidScenario, type SolidOperationReading } from '../helpers/heightScenario'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { ToolpathMove } from '../../types'

installRealToolpathWorker()

const W = 30
const H = 20
const TOP = 10
const CORNER_R = 6
const ROUND_R = 3
const TOOL_D = 6

/** 'pad': a rounded rectangle (vertical corner radius 6) - its long walls lie ON the box.
 *  'oval': an oval knob - it touches its box at four points only. Both carry the 3 mm top round. */
type Shape = 'pad' | 'oval'
/** 'around part' is the New Operation default (useStockBoundary off); 'all stock' turns it on. */
type Mode = 'around part' | 'all stock'
let currentShape: Shape = 'pad'

/** How far the side wall stands in from the box at height z (0 below the top round). */
function insetAt(z: number): number {
  const below = TOP - ROUND_R
  if (z <= below) return 0
  const t = Math.min((z - below) / ROUND_R, 1)
  return ROUND_R - Math.sqrt(Math.max(ROUND_R * ROUND_R - (t * ROUND_R) ** 2, 0))
}

/** The part's cross-section at height z, CCW. */
function sectionAt(shape: Shape, z: number): { x: number; y: number }[] {
  const PER_CORNER = 16
  const cx = W / 2, cy = H / 2
  const d = insetAt(z)
  const out: { x: number; y: number }[] = []
  if (shape === 'oval') {
    const n = 4 * (PER_CORNER + 1)
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI
      out.push({ x: cx + (W / 2 - d) * Math.cos(a), y: cy + (H / 2 - d) * Math.sin(a) })
    }
    return out
  }
  const r = CORNER_R - d
  for (const [sx, sy, a0] of [[1, 1, 0], [-1, 1, 0.5], [-1, -1, 1], [1, -1, 1.5]]) {
    const ox = cx + sx * (W / 2 - CORNER_R), oy = cy + sy * (H / 2 - CORNER_R)
    for (let k = 0; k <= PER_CORNER; k++) {
      const a = (a0 + (k / PER_CORNER) * 0.5) * Math.PI
      out.push({ x: ox + r * Math.cos(a), y: oy + r * Math.sin(a) })
    }
  }
  return out
}

/** The part's closed, outward-wound mesh; bounds exactly X 0..30, Y 0..20, Z 0..10. */
function partMesh(shape: Shape): PartMesh {
  const zs = [0, TOP - ROUND_R]
  for (let k = 1; k <= 12; k++) zs.push(TOP - ROUND_R + ROUND_R * Math.sin((k / 12) * (Math.PI / 2)))
  zs[zs.length - 1] = TOP
  const cx = W / 2, cy = H / 2
  const positions: number[] = []
  const rings = zs.map((z) => {
    const start = positions.length / 3
    for (const p of sectionAt(shape, z)) positions.push(p.x, p.y, z)
    return start
  })
  const n = sectionAt(shape, 0).length
  const indices: number[] = []
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < n; j++) {
      const l0 = rings[i] + j, l1 = rings[i] + ((j + 1) % n)
      const u0 = rings[i + 1] + j, u1 = rings[i + 1] + ((j + 1) % n)
      indices.push(l0, l1, u1, l0, u1, u0)
    }
  }
  const bottomC = positions.length / 3
  positions.push(cx, cy, 0)
  const topC = positions.length / 3
  positions.push(cx, cy, TOP)
  const bottom = rings[0], top = rings[rings.length - 1]
  for (let j = 0; j < n; j++) {
    indices.push(bottomC, bottom + ((j + 1) % n), bottom + j)
    indices.push(topC, top + j, top + ((j + 1) % n))
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    bounds: { min: [0, 0, 0], max: [W, H, TOP] },
    source: 'fixture',
  }
}

function runRough(shape: Shape, mode: Mode): Promise<SolidOperationReading> {
  currentShape = shape
  return runSolidScenario({
    part: 'closed_box', z: 0,
    // The default stock: exactly the part's box.
    stock: { kind: 'auto', offsetXY: 0, offsetZTop: 0, offsetZBottom: 0 },
    operations: [{ kind: 'adaptive_3d', source: 'current_material', toolDiameter: TOOL_D,
      ...(mode === 'all stock' ? { params: { useStockBoundary: true } } : {}) }],
  }).then((readings) => readings[0])
}

/** Points along one move, at most `step` mm apart, following an arc (helical when Z
 * changes) as the controller does - never its chord. */
function pointsAlong(a: ToolpathMove, b: ToolpathMove, step: number): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = []
  if ((b.type === 'arc_cw' || b.type === 'arc_ccw') && b.cx !== undefined && b.cy !== undefined) {
    const r = Math.hypot(a.x - b.cx, a.y - b.cy)
    const a0 = Math.atan2(a.y - b.cy, a.x - b.cx)
    let sweep = Math.atan2(b.y - b.cy, b.x - b.cx) - a0
    if (b.type === 'arc_cw') { while (sweep >= 0) sweep -= 2 * Math.PI } else { while (sweep <= 0) sweep += 2 * Math.PI }
    const n = Math.max(1, Math.ceil(Math.hypot(Math.abs(sweep) * r, b.z - a.z) / step))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push({ x: b.cx + r * Math.cos(a0 + sweep * t), y: b.cy + r * Math.sin(a0 + sweep * t), z: a.z + (b.z - a.z) * t })
    }
    return out
  }
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step))
  for (let k = 0; k <= n; k++) {
    const t = k / n
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
  }
  return out
}

/** How deep the flat cutter's tip goes below the part surface under it, mm (0 = never).
 * Every feed move (arcs as arcs) sampled every 0.25 mm; the contact is the kernel's own
 * drop-cutter. */
async function gougeMm(shape: Shape, moves: readonly ToolpathMove[]): Promise<{ max: number; at?: ToolpathMove }> {
  const { BvhKernel } = await import('../../cam3d/kernel/bvhKernel')
  const kernel = new BvhKernel()
  const mesh = kernel.uploadMesh(partMesh(shape))
  // 0.02 mm radial slack: a wall the tool only touches is not a cut into it.
  const cutter = kernel.makeCutter({ kind: 'flat', diameter: TOOL_D - 0.04 })
  const zSeed = -1e4
  const pts: { x: number; y: number; z: number; m: ToolpathMove }[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (isRapid(b)) continue
    for (const p of pointsAlong(a, b, 0.25)) pts.push({ ...p, m: b })
  }
  const xy = new Float64Array(pts.length * 2)
  pts.forEach((p, i) => { xy[2 * i] = p.x; xy[2 * i + 1] = p.y })
  const dropped = await kernel.dropPath(mesh, cutter, xy, zSeed)
  let max = 0
  let at: ToolpathMove | undefined
  pts.forEach((p, i) => {
    if (dropped[i] <= zSeed) return
    const g = dropped[i] - p.z
    if (g > max) { max = g; at = p.m }
  })
  return { max, at }
}

describe("WO-2145: which stock is the part's own box", () => {
  const ring = (x0: number, y0: number, x1: number, y1: number) => Float64Array.from([x0, y0, x1, y0, x1, y1, x0, y1])
  const bounds = { min: [0, 0, 0], max: [W, H, TOP] }
  it('the default stock (exactly the part box, within 0.05 mm) is the part box', async () => {
    const { stockFootprintIsPartBox } = await import('../../cam3d/integration/adaptive3dOperation')
    expect(stockFootprintIsPartBox(ring(0, 0, W, H), bounds)).toBe(true)
    expect(stockFootprintIsPartBox(ring(-0.04, 0.03, W + 0.04, H), bounds)).toBe(true)
  })
  it('a stock standing proud of the part on any side is a real stock (clear around part keeps its meaning)', async () => {
    const { stockFootprintIsPartBox } = await import('../../cam3d/integration/adaptive3dOperation')
    expect(stockFootprintIsPartBox(ring(-2, -2, W + 2, H + 2), bounds)).toBe(false)
    expect(stockFootprintIsPartBox(ring(0, 0, W + 0.2, H), bounds)).toBe(false)
    expect(stockFootprintIsPartBox(undefined, bounds)).toBe(false)
  })
})

describe('WO-2145: Adaptive roughs a rounded part whose stock is exactly its box', () => {
  for (const shape of ['oval', 'pad'] as const) for (const mode of ['around part', 'all stock'] as const) {
  it(`${shape}, clear ${mode}: a rough that takes the corner and edge slivers from the open side, without cutting the part`, async () => {
    const r = await runRough(shape, mode)
    expect(r.authoringError).toBeUndefined()
    expect(r.status, r.errorMessage).toBe('ready')

    const cutting = r.worldMoves.filter((m) => !isRapid(m))
    const lowest = Math.min(...cutting.map((m) => m.z))
    // Not vacuous: the rough goes down beside the part, into the corner slivers.
    expect(cutting.length).toBeGreaterThan(0)
    expect(lowest).toBeLessThan(TOP - ROUND_R)
    // Every region is entered from the side: a lead-in, and no plunge through standing stock.
    expect(r.worldMoves.some((m) => m.role === 'lead_in')).toBe(true)

    const gouge = await gougeMm(shape, r.worldMoves)
    console.log(`[WO-2145] ${shape}, ${mode}: ${r.worldMoves.length} moves (${cutting.length} feed), lowest feed Z ${lowest.toFixed(3)}, ` +
      `${r.worldMoves.filter((m) => m.role === 'lead_in').length} lead-ins, ` +
      `${r.worldMoves.filter((m) => m.role === 'plunge').length} plunges, ` +
      `${r.worldMoves.filter((m) => m.role === 'ramp').length} ramp moves, max gouge ${gouge.max.toFixed(4)} mm`)
    expect(gouge.max, `gouge at ${JSON.stringify(gouge.at)}`).toBeLessThanOrEqual(0.05)

    if (process.env.WRITE_EVIDENCE === '1') writePlanPicture(shape, mode, r.worldMoves)
  }, 300_000)
  }
})

// --- evidence: plan view of the rough over the part and its box stock ---------

function writePlanPicture(shape: Shape, mode: Mode, moves: readonly ToolpathMove[]): void {
  const dir = resolve(process.cwd(), 'src/tests/evidence/WO-2145')
  mkdirSync(dir, { recursive: true })
  const png = resolve(dir, `rough-plan-${shape}-${mode.replace(' ', '-')}.png`)
  // DELETE FIRST: a stale artifact must never be mistaken for a fresh shot.
  rmSync(png, { force: true })
  writeFileSync(png, renderPlan(shape, moves))
}

function renderPlan(shape: Shape, moves: readonly ToolpathMove[]): Buffer {
  const PX = 20, X0 = -8, Y0 = -8, SW = W + 16, SH = H + 16
  const w = SW * PX, h = SH * PX
  const rgb = new Uint8Array(w * h * 3).fill(250)
  const set = (px: number, py: number, c: readonly number[]) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return
    const o = (py * w + px) * 3
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]
  }
  const toPx = (x: number, y: number) => [Math.round((x - X0) * PX), Math.round((Y0 + SH - y) * PX)]
  // Part footprint (grey), its flat top (lighter), the box stock outline (brown).
  const footprint = sectionAt(shape, 0), top = sectionAt(shape, TOP)
  const inRing = (ring: readonly { x: number; y: number }[], x: number, y: number) => {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j]
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
    return inside
  }
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = X0 + (px + 0.5) / PX, y = Y0 + SH - (py + 0.5) / PX
      if (inRing(top, x, y)) set(px, py, [200, 200, 200])
      else if (inRing(footprint, x, y)) set(px, py, [160, 160, 160])
      const onBox = (Math.abs(x) < 0.05 || Math.abs(x - W) < 0.05) && y >= 0 && y <= H
        || (Math.abs(y) < 0.05 || Math.abs(y - H) < 0.05) && x >= 0 && x <= W
      if (onBox) set(px, py, [140, 90, 30])
    }
  }
  // Tool axis: feed (blue), lead-in (green), rapids skipped.
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (isRapid(b)) continue
    const c = b.role === 'lead_in' ? [20, 150, 40] : [30, 60, 190]
    for (const p of pointsAlong(a, b, 0.5 / PX)) {
      const [x, y] = toPx(p.x, p.y)
      set(x, y, c); set(x + 1, y, c); set(x, y + 1, c)
    }
  }
  return encodePng(w, h, rgb)
}

function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1)
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
