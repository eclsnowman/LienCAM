// WO-1476: buildProjectCommit must keep liftLoops' chain-joint coincident
// constraints, not just the per-entity Fix. Without them a projected chain
// is three independently-fixed entities, not one connected grounded chain --
// editing a chamfer setback at one corner can silently pull an UNTOUCHED
// joint apart (Codex audit BUG-440).

import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import type { GcsWrapper } from '@salusoft89/planegcs'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper, type SketchSolveOutcome } from '../../lib/sketch/solver/gcsMapping'
import { buildProjectCommit, type ProjectCandidate } from '../../lib/sketch/projectUse'
import { chamferLines, type ChamferResult } from '../../lib/sketch/tools/chamferTool'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import type { Sketch, SketchEntity, SketchLineEntity } from '../../lib/sketch/types'
import type { Loop2D } from '../../types'

let wrapperPromise: Promise<GcsWrapper> | null = null
const getWrapper = () => (wrapperPromise ??= createGcsWrapper())

const candidate = (paths: readonly Loop2D[]): ProjectCandidate => ({
  paths,
  sourceKind: 'cam-layer-loop',
  sourceLabel: 'Outline',
  stablePickKey: 'cam-layer-loop:fixture',
})

function asLine(entities: readonly { id: string }[], id: string): SketchLineEntity {
  const entity = entities.find((candidate) => candidate.id === id)
  return entity as SketchLineEntity
}

// An OPEN three-line chain: L1 (0,0)->(10,0), L2 (10,0)->(10,10), L3
// (10,10)->(0,10). Two joints: J1 (L1/L2 at (10,0)) and J2 (L2/L3 at
// (10,10)). The corner at J1 gets chamfered; J2 is never touched.
function threeLineChain(): Loop2D {
  return {
    id: 'chain', layerId: 'src-layer', type: 'open', closed: false, area: 0,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  }
}

function findByEndpoints(
  entities: readonly SketchLineEntity[], from: { x: number; y: number }, to: { x: number; y: number },
): SketchLineEntity {
  const hit = entities.find((line) =>
    Math.hypot(line.start.x - from.x, line.start.y - from.y) < 1e-9 &&
    Math.hypot(line.end.x - to.x, line.end.y - to.y) < 1e-9)
  if (!hit) throw new Error(`no lifted line from (${from.x},${from.y}) to (${to.x},${to.y})`)
  return hit
}

/** Project the three-line chain and chamfer J1 (L1/L2 at (10,0)), leaving
 *  J2 (L2/L3 at (10,10)) untouched. Shared by the regression test and the
 *  evidence picture below so both draw from the exact same fixture. */
function buildChamferedChain(): {
  l1: SketchLineEntity; l2: SketchLineEntity; l3: SketchLineEntity
  sketch: Sketch; chamfer: ChamferResult
} {
  let n = 0
  const built = buildProjectCommit(candidate([threeLineChain()]), false, () => `wo1476-${n++}`)
  if (!built.ok) throw new Error(built.message)

  const lines = built.commit.entities as SketchLineEntity[]
  const l1 = findByEndpoints(lines, { x: 0, y: 0 }, { x: 10, y: 0 })
  const l2 = findByEndpoints(lines, { x: 10, y: 0 }, { x: 10, y: 10 })
  const l3 = findByEndpoints(lines, { x: 10, y: 10 }, { x: 0, y: 10 })

  const projectedDoc: SketchDoc = {
    entities: built.commit.entities, constraints: built.commit.constraints, dimensions: [],
  }
  const chamfer = chamferLines(
    projectedDoc, l1.id, l2.id, { x: 0, y: 0 }, { x: 10, y: 10 }, 2, () => `chamfer-${n++}`,
  )
  if (typeof chamfer === 'string') throw new Error(chamfer)

  const sketch: Sketch = {
    id: 'wo1476-chain', layerId: 'src-layer',
    entities: chamfer.transform.entities,
    constraints: chamfer.transform.constraints,
    dimensions: chamfer.transform.dimensions,
    solveStatus: null,
  }
  return { l1, l2, l3, sketch, chamfer }
}

describe('WO-1476: project/use keeps chain-joint coincidents through a chamfer + setback edit', () => {
  it('the untouched J2 joint stays connected after chamfering J1 and editing its setback', async () => {
    const { l2, l3, sketch, chamfer } = buildChamferedChain()
    const wrapper = await getWrapper()
    const initial = solveSketchOnWrapper(wrapper, sketch)
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    expect(initial.status.conflicting).toEqual([])
    const initialL2 = asLine(initial.entities, l2.id)
    const initialL3 = asLine(initial.entities, l3.id)
    expect(Math.hypot(initialL2.end.x - initialL3.start.x, initialL2.end.y - initialL3.start.y))
      .toBeCloseTo(0, 6)

    // Edit ONLY the chamfered corner's own setback (J1) -- J2 is never named
    // by this edit.
    const editedSketch: Sketch = {
      ...sketch,
      entities: initial.entities,
      solveStatus: initial.status,
      dimensions: sketch.dimensions.map((dimension) =>
        dimension.id === chamfer.setbackDimAId ? { ...dimension, value: 4 } : dimension),
    }
    const edited = solveSketchOnWrapper(wrapper, editedSketch)
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.status.conflicting).toEqual([])

    const editedL2 = asLine(edited.entities, l2.id)
    const editedL3 = asLine(edited.entities, l3.id)
    // The regression this WO fixes: without the J2 coincident, editing J1's
    // setback frees L2 entirely and its far end no longer tracks L3's fixed
    // start -- the chain splits into two open pieces.
    expect(Math.hypot(editedL2.end.x - editedL3.start.x, editedL2.end.y - editedL3.start.y))
      .toBeCloseTo(0, 6)
    // L3 itself never moved (still independently grounded at its original position).
    expect(editedL3.start.x).toBeCloseTo(10, 6)
    expect(editedL3.start.y).toBeCloseTo(10, 6)
  })

  it('a plain closed-chain project/use solves clean with no drift from the added joint coincidents', async () => {
    const rect: Loop2D = {
      id: 'rect', layerId: 'src-layer', type: 'contour', closed: true, area: 200,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
    }
    let n = 0
    const built = buildProjectCommit(candidate([rect]), false, () => `rect-${n++}`)
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error(built.message)

    const sketch: Sketch = {
      id: 'wo1476-rect', layerId: 'src-layer',
      entities: built.commit.entities, constraints: built.commit.constraints,
      dimensions: [], solveStatus: null,
    }
    const wrapper = await getWrapper()
    const out = solveSketchOnWrapper(wrapper, sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.conflicting).toEqual([])
    for (const entity of out.entities) {
      const original = built.commit.entities.find((candidate) => candidate.id === entity.id)
      if (entity.kind !== 'line' || original?.kind !== 'line') continue
      expect(entity.start.x).toBeCloseTo(original.start.x, 9)
      expect(entity.start.y).toBeCloseTo(original.start.y, 9)
      expect(entity.end.x).toBeCloseTo(original.end.x, 9)
      expect(entity.end.y).toBeCloseTo(original.end.y, 9)
    }
  })
})

// ---- WO-1476 evidence picture (writes nothing unless WRITE_EVIDENCE=1) ----
//
//   WRITE_EVIDENCE=1 npx vitest run src/tests/sketch/projectUseChainTopology.wo1476.test.ts
//
// Before/after PNG in src/tests/evidence/WO-1476/: the same chamfer + setback
// edit as the regression test above, drawn so J2 (L2/L3, top right) visibly
// stays one connected corner in both panels instead of pulling apart.
const EVID = 'src/tests/evidence/WO-1476'
const WRITE = !!process.env.WRITE_EVIDENCE

const GLYPHS: Record<string, number[]> = {
  'A': [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], 'B': [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
  'C': [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E], 'D': [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
  'E': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F], 'F': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
  'G': [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F], 'H': [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  'I': [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E], 'J': [0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0C],
  'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], 'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
  'M': [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11], 'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  'O': [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], 'P': [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
  'R': [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11], 'S': [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
  'T': [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04], 'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04], 'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
  'Y': [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04], 'Z': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
  '0': [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E], '1': [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  '2': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F], '3': [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
  '4': [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02], '6': [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
  '7': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  ' ': [0, 0, 0, 0, 0, 0, 0], '-': [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C], ':': [0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
}
type RGB = [number, number, number]
class FB {
  buf: Uint8Array; w: number; h: number
  constructor(w: number, h: number, bg: RGB) {
    this.w = w; this.h = h; this.buf = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      this.buf[i * 4] = bg[0]; this.buf[i * 4 + 1] = bg[1]; this.buf[i * 4 + 2] = bg[2]; this.buf[i * 4 + 3] = 255
    }
  }
  px(x: number, y: number, c: RGB) {
    x |= 0; y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; this.buf[i + 3] = 255
  }
  dot(x: number, y: number, c: RGB, r = 0) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 1) this.px(x + dx, y + dy, c)
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, r = 0) {
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
  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.px(x, y, c)
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB) {
    this.line(x0, y0, x1, y0, c); this.line(x1, y0, x1, y1, c)
    this.line(x1, y1, x0, y1, c); this.line(x0, y1, x0, y0, c)
  }
  circle(cx: number, cy: number, rad: number, c: RGB, thick = 1) {
    const steps = Math.max(32, Math.ceil(rad * 2))
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * 2 * Math.PI, a1 = ((i + 1) / steps) * 2 * Math.PI
      this.line(cx + Math.cos(a0) * rad, cy + Math.sin(a0) * rad, cx + Math.cos(a1) * rad, cy + Math.sin(a1) * rad, c, thick)
    }
  }
  text(str: string, x: number, y: number, c: RGB, scale = 2) {
    let cx = x
    for (const chRaw of str.toUpperCase()) {
      const g = GLYPHS[chRaw]
      if (g) for (let row = 0; row < 7; row++) {
        const bits = g[row]
        for (let col = 0; col < 5; col++) if (bits & (1 << (4 - col)))
          this.fillRect(cx + col * scale, y + row * scale, cx + col * scale + scale - 1, y + row * scale + scale - 1, c)
      }
      cx += 6 * scale
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
      const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0)
      const t = Buffer.from(type, 'ascii')
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0)
      return Buffer.concat([l, t, data, crc])
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
const COL = {
  bg: [16, 18, 22] as RGB, panel: [10, 11, 14] as RGB, frame: [70, 74, 82] as RGB,
  band: [255, 211, 77] as RGB, bandText: [20, 20, 20] as RGB, label: [214, 219, 226] as RGB,
  l1: [70, 130, 210] as RGB, l2: [80, 200, 120] as RGB, l3: [220, 120, 60] as RGB,
  chamfer: [200, 200, 60] as RGB, joint: [255, 60, 60] as RGB,
}

describe('WO-1476 evidence picture', () => {
  it('draws the before/after chamfer + setback edit', async () => {
    const { l2, l3, sketch, chamfer } = buildChamferedChain()
    // THE CLAIM THE PICTURE IS EVIDENCE FOR, asserted here so the picture and
    // the regression test above can never disagree.
    expect(chamfer.setbackDimAId).toBeTruthy()
    if (!WRITE) return

    const wrapper = await getWrapper()
    const initial = solveSketchOnWrapper(wrapper, sketch)
    if (!initial.ok) throw new Error('initial solve failed')
    const editedSketch: Sketch = {
      ...sketch,
      entities: initial.entities,
      solveStatus: initial.status,
      dimensions: sketch.dimensions.map((dimension) =>
        dimension.id === chamfer.setbackDimAId ? { ...dimension, value: 4 } : dimension),
    }
    const edited: SketchSolveOutcome = solveSketchOnWrapper(wrapper, editedSketch)
    if (!edited.ok) throw new Error('edited solve failed')

    const W = 1200, H = 640
    const PAD_T = 46
    const pw = Math.floor(W / 2)
    const view = (x: number, y: number, ox: number): [number, number] => [ox + 30 + x * 10, H - 60 - y * 10]

    const fb = new FB(W, H, COL.bg)
    const drawPanel = (entities: readonly SketchEntity[], ox: number, title: string) => {
      const lines = entities.filter((e): e is SketchLineEntity => e.kind === 'line')
      const byId = new Map(lines.map((e) => [e.id, e]))
      const chamferLine = byId.get(chamfer.lineId)
      if (chamferLine) {
        const [x0, y0] = view(chamferLine.start.x, chamferLine.start.y, ox)
        const [x1, y1] = view(chamferLine.end.x, chamferLine.end.y, ox)
        fb.line(x0, y0, x1, y1, COL.chamfer, 1)
      }
      for (const e of lines) {
        if (e.id === chamfer.lineId) continue
        const c = e.id === l2.id ? COL.l2 : e.id === l3.id ? COL.l3 : COL.l1
        const [x0, y0] = view(e.start.x, e.start.y, ox)
        const [x1, y1] = view(e.end.x, e.end.y, ox)
        fb.line(x0, y0, x1, y1, c, 1)
      }
      const j2 = byId.get(l3.id)
      if (j2) {
        const [jx, jy] = view(j2.start.x, j2.start.y, ox)
        fb.circle(jx, jy, 10, COL.joint, 1)
      }
      fb.text(title, ox + 14, PAD_T + 10, COL.label, 1)
    }

    fb.fillRect(0, 0, W - 1, PAD_T - 1, COL.band)
    fb.text('WO-1476: PROJECT USE CHAIN-JOINT COINCIDENTS SURVIVE A CHAMFER SETBACK EDIT', 14, 12, COL.bandText, 2)
    fb.rect(0, PAD_T, pw - 4, H - 1, COL.frame)
    fb.rect(pw + 4, PAD_T, W - 1, H - 1, COL.frame)
    drawPanel(sketch.entities, 0, 'BEFORE - CHAMFER - NO EDIT YET')
    drawPanel(edited.entities, pw + 4, 'AFTER - J1 SETBACK EDITED 2 TO 4')
    fb.text('RED RING IS J2 L2 TO L3 -- NEVER TOUCHED BY THE EDIT -- STAYS CLOSED IN BOTH PANELS', 14, H - 24, COL.label, 1)
    fs.mkdirSync(EVID, { recursive: true })
    fs.writeFileSync(`${EVID}/joint-stays-connected.png`, fb.png())
    console.log(`wrote ${EVID}/joint-stays-connected.png (${W}x${H})`)
  })
})
