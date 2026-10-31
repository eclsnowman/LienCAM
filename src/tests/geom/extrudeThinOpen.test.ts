// WO-3237 (WO-3173 Draft B1): a makeExtrude request carrying
// thin:{thickness, side, open:true} builds a square-ended solid wall along ONE
// open chain - the chain offset left / right of its persisted travel direction,
// both ends cut straight across - and refuses in one line whatever it cannot
// build exactly. Side follows the travel direction, never the shape's bend.
//
// Independent truth (REPORT analytic cases at D = 8, t = 2):
//   straight 30 mm chain, any side: 30 * 2 * 8 = 480
//   U (0,30)->(0,0)->(36,0)->(36,30): left of travel is its inside
//     left  (36*30 - 32*28) * 8 = 1472   right (40*32 - 36*30) * 8 = 1600
//     center 96 mm of centreline * 2 * 8 = 1536 (90 degree miters add and take equally)
//   half circle r = 10, CCW: right (pi/2)(12^2-10^2)*8 = 176 pi, left (pi/2)(10^2-8^2)*8 = 144 pi
//   J = line 20 + tangent half circle r = 10, center: (20*2 + (pi/2)(11^2-9^2)) * 8 = 320 + 160 pi
// The body is exported to STEP and read back into a SEPARATE kernel, where
// bounds, a mid-height section and empty-centre probes are measured with plain
// kernel calls - not with the engine that built it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel, type ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ExtrudeRequest, ProfileRegion, ProfileSegment, ThinOpenSide } from '../../geom/geom-service.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const D = 8, T = 2
const rel = (a: number, e: number): number => Math.abs(a - e) / Math.abs(e)

const line = (srcId: string, a: [number, number], b: [number, number]): ProfileSegment => ({ kind: 'line', a, b, srcId })
function chain(segments: ProfileSegment[], sketchId = 'S1'): ProfileRegion {
  return { sketchId, plane: xyPlane(0), loops: [segments] }
}
/** The persisted U: down the left leg, along the bottom, up the right leg. */
const U = (): ProfileSegment[] => [
  line('S1.e0', [0, 30], [0, 0]),
  line('S1.e1', [0, 0], [36, 0]),
  line('S1.e2', [36, 0], [36, 30]),
]
/** The same U walked the other way (what Reverse persists). */
const UReversed = (): ProfileSegment[] => [
  line('S1.e2', [36, 30], [36, 0]),
  line('S1.e1', [36, 0], [0, 0]),
  line('S1.e0', [0, 0], [0, 30]),
]
function openReq(
  profile: ProfileRegion,
  side: ThinOpenSide | undefined,
  extra: Partial<ExtrudeRequest> = {},
  thickness = T,
): ExtrudeRequest {
  return {
    featureId: 'F1',
    profiles: [profile],
    end: { kind: 'blind', distance: D },
    op: 'newBody',
    thin: { thickness, ...(side === undefined ? {} : { side }), open: true },
    ...extra,
  } as ExtrudeRequest
}

let engine: GeomEngine
let oracle: OcctKernel
const held: ShapeHandle[] = []
const own = <S extends ShapeHandle>(h: S): S => { held.push(h); return h }

async function readBack(body: BodyHandle): Promise<ShapeHandle> {
  const bytes = await engine.exportStep([body])
  return own(oracle.importStep(new TextDecoder().decode(bytes)))
}
function boxAt(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): ShapeHandle {
  return own(oracle.translate(own(oracle.makeBox(x1 - x0, y1 - y0, z1 - z0)), x0, y0, z0))
}
function volumeIn(shape: ShapeHandle, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const common = own(oracle.intersect(shape, boxAt(x0, y0, z0, x1, y1, z1)))
  return oracle.getSubShapes(common, 'solid').length === 0 ? 0 : oracle.getVolume(common)
}
function expectBounds(shape: ShapeHandle, want: number[]): void {
  const b = oracle.getBoundingBox(shape, false)
  ;[b.xmin, b.ymin, b.zmin, b.xmax, b.ymax, b.zmax].forEach((v, i) => expect(v, `bound ${i}`).toBeCloseTo(want[i], 4))
}
async function volumeOf(body: BodyHandle): Promise<number> {
  return (await engine.measure(body, 'volume')).value
}

beforeAll(async () => {
  engine = new GeomEngine()
  await engine.init()
  oracle = await OcctKernel.init()
}, 120_000)
afterAll(async () => {
  for (const h of held) { try { oracle.release(h) } catch { /* gone */ } }
  oracle?.[Symbol.dispose]()
  await engine.disposeKernel()
})

describe('WO-3237 open-chain thin walls: a straight 30 mm chain at D = 8, t = 2', () => {
  const cases = [
    { side: 'left' as const, y: [0, 2] },
    { side: 'right' as const, y: [-2, 0] },
    { side: 'center' as const, y: [-1, 1] },
  ]
  for (const c of cases) {
    it(`${c.side}: V = 480, square ends at x = 0 and x = 30, wall named by side of travel`, async () => {
      const r = await engine.makeExtrude(openReq(chain([line('S1.e0', [0, 0], [30, 0])]), c.side))
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
      expect(rel(await volumeOf(r.body!), 480)).toBeLessThanOrEqual(1e-6)
      const shape = await readBack(r.body!)
      expect(oracle.isValid(shape)).toBe(true)
      expect(oracle.getSubShapes(shape, 'solid')).toHaveLength(1)
      expectBounds(shape, [0, c.y[0], 0, 30, c.y[1], D])
      const g = r.elementMap!.geometry!
      expect(g['F1:XTR:S1.e0:thinLeft'].centroid.y).toBeCloseTo(c.y[1], 6)
      expect(g['F1:XTR:S1.e0:thinRight'].centroid.y).toBeCloseTo(c.y[0], 6)
      // Square ends: flat faces across the chain at its first and last point.
      expect(g['F1:XTR:S1.e0:thinStart'].centroid.x).toBeCloseTo(0, 6)
      expect(g['F1:XTR:S1.e0:thinEnd'].centroid.x).toBeCloseTo(30, 6)
      expect(g['F1:XTR:S1.e0:thinStart'].area).toBeCloseTo(T * D, 6)
      expect(g['F1:XTR:S1.e0:thinCapStart'].centroid.z).toBeCloseTo(0, 6)
      expect(g['F1:XTR:S1.e0:thinCapEnd'].centroid.z).toBeCloseTo(D, 6)
      expect(r.elementMap!.generated).toHaveLength(6)
      await engine.dispose(r.body!)
    }, 60_000)
  }

  it('a missing side means left of travel', async () => {
    const r = await engine.makeExtrude(openReq(chain([line('S1.e0', [0, 0], [30, 0])]), undefined))
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    const shape = await readBack(r.body!)
    expectBounds(shape, [0, 0, 0, 30, 2, D])
    await engine.dispose(r.body!)
  }, 60_000)

  it('symmetric and blind-down ends put the wall where the end says', async () => {
    const sym = await engine.makeExtrude(openReq(chain([line('S1.e0', [0, 0], [30, 0])]), 'left', { end: { kind: 'symmetric', distance: D } }))
    expect(sym.ok, JSON.stringify(sym.diagnostics)).toBe(true)
    expectBounds(await readBack(sym.body!), [0, 0, -D / 2, 30, 2, D / 2])
    const down = await engine.makeExtrude(openReq(chain([line('S1.e0', [0, 0], [30, 0])]), 'left', { end: { kind: 'blind', distance: -D } }))
    expect(down.ok, JSON.stringify(down.diagnostics)).toBe(true)
    expectBounds(await readBack(down.body!), [0, 0, -D, 30, 2, 0])
    expect(rel(await volumeOf(down.body!), 480)).toBeLessThanOrEqual(1e-6)
    await engine.dispose(sym.body!)
    await engine.dispose(down.body!)
  }, 60_000)
})

describe('WO-3237 open-chain thin walls: a U chain at D = 8, t = 2', () => {
  const cases = [
    { side: 'left' as const, volume: 1472, box: [0, 0, 0, 36, 30, D], hollow: [2, 2, 34, 30] },
    { side: 'right' as const, volume: 1600, box: [-2, -2, 0, 38, 30, D], hollow: [0, 0, 36, 30] },
    { side: 'center' as const, volume: 1536, box: [-1, -1, 0, 37, 30, D], hollow: [1, 1, 35, 30] },
  ]
  for (const c of cases) {
    it(`${c.side}: V = ${c.volume}, the centre stays empty, the ends stay square at y = 30`, async () => {
      const r = await engine.makeExtrude(openReq(chain(U()), c.side))
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
      expect(rel(await volumeOf(r.body!), c.volume), `volume`).toBeLessThanOrEqual(1e-6)
      const shape = await readBack(r.body!)
      expect(oracle.isValid(shape)).toBe(true)
      expect(oracle.getSubShapes(shape, 'solid')).toHaveLength(1)
      expectBounds(shape, c.box)
      // Mid-height slab: the wall section is V / D at every height.
      expect(volumeIn(shape, -10, -10, 3.5, 50, 40, 4.5)).toBeCloseTo(c.volume / D, 6)
      // The U's centre is empty top to bottom and nothing closes its open top.
      const [x0, y0, x1, y1] = c.hollow
      expect(volumeIn(shape, x0 + 1e-3, y0 + 1e-3, -1, x1 - 1e-3, y1 + 5, D + 1)).toBe(0)
      // Square ends: both legs stop flat at y = 30, as wide as the wall.
      const g = r.elementMap!.geometry!
      for (const id of ['F1:XTR:S1.e0:thinStart', 'F1:XTR:S1.e2:thinEnd']) {
        expect(g[id].surfaceType).toBe('plane')
        expect(g[id].centroid.y).toBeCloseTo(30, 6)
        expect(g[id].area).toBeCloseTo(T * D, 6)
      }
      await engine.dispose(r.body!)
    }, 60_000)
  }

  it('side follows the persisted direction, not the bend: the reversed U puts left outside', async () => {
    const r = await engine.makeExtrude(openReq(chain(UReversed()), 'left'))
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    expect(rel(await volumeOf(r.body!), 1600)).toBeLessThanOrEqual(1e-6)
    expectBounds(await readBack(r.body!), [-2, -2, 0, 38, 30, D])
    // The bottom's left wall is now the outer one, at y = -2.
    expect(r.elementMap!.geometry!['F1:XTR:S1.e1:thinLeft'].centroid.y).toBeCloseTo(-2, 6)
    await engine.dispose(r.body!)
  }, 60_000)
})

describe('WO-3237 open-chain thin walls: exact arcs', () => {
  const half = (ccw = true): ProfileSegment => (ccw
    ? { kind: 'arc', c: [0, 0], r: 10, a0: 0, a1: Math.PI, ccw: true, srcId: 'S1.a0' }
    : { kind: 'arc', c: [0, 0], r: 10, a0: Math.PI, a1: 0, ccw: false, srcId: 'S1.a0' })

  it('a CCW half circle, right t = 2: V = 176 pi with a cylindrical wall at r = 12', async () => {
    const r = await engine.makeExtrude(openReq(chain([half()]), 'right'))
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    expect(rel(await volumeOf(r.body!), 176 * Math.PI)).toBeLessThanOrEqual(1e-6)
    const g = r.elementMap!.geometry!
    expect(g['F1:XTR:S1.a0:thinRight'].surfaceType).toBe('cylinder')
    expect(g['F1:XTR:S1.a0:thinRight'].area / (Math.PI * D)).toBeCloseTo(12, 6)
    expect(g['F1:XTR:S1.a0:thinLeft'].area / (Math.PI * D)).toBeCloseTo(10, 6)
    expectBounds(await readBack(r.body!), [-12, 0, 0, 12, 12, D])
    await engine.dispose(r.body!)
  }, 60_000)

  it('left t = 2: V = 144 pi; walked the other way left becomes the outside', async () => {
    const a = await engine.makeExtrude(openReq(chain([half()]), 'left'))
    expect(a.ok, JSON.stringify(a.diagnostics)).toBe(true)
    expect(rel(await volumeOf(a.body!), 144 * Math.PI)).toBeLessThanOrEqual(1e-6)
    const b = await engine.makeExtrude(openReq(chain([half(false)]), 'left'))
    expect(b.ok, JSON.stringify(b.diagnostics)).toBe(true)
    expect(rel(await volumeOf(b.body!), 176 * Math.PI)).toBeLessThanOrEqual(1e-6)
    await engine.dispose(a.body!)
    await engine.dispose(b.body!)
  }, 60_000)

  it('a J (line + tangent arc), center t = 2: V = 320 + 160 pi', async () => {
    const J: ProfileSegment[] = [
      line('S1.e0', [10, 20], [10, 0]),
      { kind: 'arc', c: [0, 0], r: 10, a0: 0, a1: -Math.PI, ccw: false, srcId: 'S1.a1' },
    ]
    const r = await engine.makeExtrude(openReq(chain(J), 'center'))
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    expect(rel(await volumeOf(r.body!), 320 + 160 * Math.PI)).toBeLessThanOrEqual(1e-6)
    expectBounds(await readBack(r.body!), [-11, -11, 0, 11, 20, D])
    await engine.dispose(r.body!)
  }, 60_000)
})

describe('WO-3237 open-chain thin walls: Add / Cut / Intersect on a known overlap', () => {
  // Block x -5..41, y -5..10, z 0..8 (V = 5520). The centered U wall overlaps
  // it in its bottom bar (38 x 2) and the legs' lower parts (2 x 9 each): 112 mm2.
  const BLOCK = 46 * 15 * D, TOOL = 1536, OVERLAP = 112 * D
  async function block(): Promise<BodyHandle> {
    const r = await engine.makeExtrude({
      featureId: 'B1',
      profiles: [{ sketchId: 'SB', plane: xyPlane(0), loops: [rectLoop('SB', -5, -5, 41, 10)] }],
      end: { kind: 'blind', distance: D },
      op: 'newBody',
    })
    expect(r.ok).toBe(true)
    return r.body!
  }
  const cases = [
    { op: 'add' as const, expected: BLOCK + TOOL - OVERLAP },
    { op: 'cut' as const, expected: BLOCK - OVERLAP },
    { op: 'intersect' as const, expected: OVERLAP },
  ]
  for (const c of cases) {
    it(`${c.op}: V = ${c.expected}, the target body itself unchanged`, async () => {
      const target = await block()
      const r = await engine.makeExtrude(openReq(chain(U()), 'center', { op: c.op, target }))
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
      expect(rel(await volumeOf(r.body!), c.expected)).toBeLessThanOrEqual(1e-6)
      expect(rel(await volumeOf(target), BLOCK)).toBeLessThanOrEqual(1e-9)
      await engine.dispose(r.body!)
      await engine.dispose(target)
    }, 60_000)
  }
})

describe('WO-3237 open-chain refusals: one line, nothing built, nothing substituted', () => {
  async function refused(req: ExtrudeRequest, words: RegExp): Promise<void> {
    const r = await engine.makeExtrude(req)
    expect(r.ok).toBe(false)
    expect(r.body).toBeUndefined()
    expect(r.diagnostics).toHaveLength(1)
    expect(JSON.stringify(r.diagnostics[0].params)).toMatch(words)
  }

  it('a self-crossing chain needs a union contract: refused, no closed region or solid instead', async () => {
    const Z = [line('S1.e0', [0, 0], [10, 10]), line('S1.e1', [10, 10], [10, 0]), line('S1.e2', [10, 0], [0, 10])]
    await refused(openReq(chain(Z), 'center'), /crosses itself.*union contract/)
  }, 60_000)

  it('a wall thicker than an end curve allows is refused by name', async () => {
    const hook = [line('S1.e0', [0, 0], [10, 0]), line('S1.e1', [10, 0], [10, 1])]
    await refused(openReq(chain(hook), 'left'), /S1\.e1.*thicker than the end curve/)
  }, 60_000)

  it('closed sides, two chains, a broken or closed chain and bad thickness are refused', async () => {
    const straight = chain([line('S1.e0', [0, 0], [30, 0])])
    await refused({ ...openReq(straight, 'left'), thin: { thickness: T, side: 'inside', open: true } } as unknown as ExtrudeRequest, /left, right or center/)
    await refused(openReq({ ...straight, loops: [...straight.loops, [line('S1.e9', [0, 5], [30, 5])]] }, 'left'), /exactly one chain/)
    await refused(openReq(chain([line('S1.e0', [0, 0], [10, 0]), line('S1.e1', [11, 0], [11, 10])]), 'left'), /breaks between S1\.e0 and S1\.e1/)
    const square = rectLoop('S1', 0, 0, 10, 10)
    await refused(openReq(chain(square), 'left'), /closed loop, not an open chain/)
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await refused(openReq(straight, 'left', {}, t), /positive finite length/)
    }
  }, 60_000)

  it('after refusals a fresh open wall and a closed thin wall still build and export', async () => {
    const r = await engine.makeExtrude(openReq(chain(U()), 'center'))
    expect(r.ok).toBe(true)
    expect((await engine.exportStep([r.body!])).byteLength).toBeGreaterThan(0)
    const closed = await engine.makeExtrude({
      featureId: 'F2',
      profiles: [{ sketchId: 'S2', plane: xyPlane(0), loops: [rectLoop('S2', 0, 0, 40, 20)] }],
      end: { kind: 'blind', distance: D },
      op: 'newBody',
      thin: { thickness: T, side: 'inside' },
    })
    expect(closed.ok).toBe(true)
    expect(rel(await volumeOf(closed.body!), 1792)).toBeLessThanOrEqual(1e-6)
    await engine.dispose(r.body!)
    await engine.dispose(closed.body!)
  }, 60_000)
})

describe('WO-3237 open-chain lineage', () => {
  it('thickness and distance edits keep every name; geometry moves', async () => {
    const a = await engine.makeExtrude(openReq(chain(U()), 'left'))
    const b = await engine.makeExtrude(openReq(chain(U()), 'left', { end: { kind: 'blind', distance: 12 } }, 3))
    expect(a.ok && b.ok).toBe(true)
    expect(b.elementMap!.generated).toEqual(a.elementMap!.generated)
    expect(a.elementMap!.generated).toEqual(expect.arrayContaining([
      'F1:XTR:S1.e0:thinLeft', 'F1:XTR:S1.e1:thinLeft', 'F1:XTR:S1.e2:thinLeft',
      'F1:XTR:S1.e0:thinRight', 'F1:XTR:S1.e1:thinRight', 'F1:XTR:S1.e2:thinRight',
      'F1:XTR:S1.e0:thinStart', 'F1:XTR:S1.e2:thinEnd',
      'F1:XTR:S1.e0:thinCapStart', 'F1:XTR:S1.e0:thinCapEnd',
    ]))
    expect(a.elementMap!.generated).toHaveLength(10)
    expect(b.elementMap!.geometry!['F1:XTR:S1.e1:thinLeft'].centroid.y).toBeCloseTo(3, 6)
    await engine.dispose(a.body!)
    await engine.dispose(b.body!)
  }, 60_000)
})
