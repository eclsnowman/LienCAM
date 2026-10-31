// WO-3233: a thin closed-wall extrude goes through the same NewBody / Add / Cut /
// Intersect machinery as an ordinary extrude.
//
// Independent truth: a 40 x 20 x 8 block at x 0..40 (V = 6400) and a thin
// tool from the 40 x 20 rectangle at x 20..60, inside t = 2, D = 8
// (V = (40*20 - 36*16) * 8 = 1792). The tool's material inside the block is
// its left wall (2 x 20) plus the parts of its bottom and top walls with
// x <= 40 (2 x 18 each): 112 mm2, so the overlap volume is 112 * 8 = 896.
//   Add 6400 + 1792 - 896 = 7296   Cut 6400 - 896 = 5504   Intersect 896
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ExtrudeRequest, OpResult, ProfileRegion } from '../../geom/geom-service.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const D = 8, T = 2
const BLOCK = 40 * 20 * D
const TOOL = 1792
const OVERLAP = 896

const blockProfile: ProfileRegion = { sketchId: 'S0', plane: xyPlane(0), loops: [rectLoop('S0', 0, 0, 40, 20)] }
const toolProfile: ProfileRegion = { sketchId: 'S1', plane: xyPlane(0), loops: [rectLoop('S1', 20, 0, 60, 20)] }

let engine: GeomEngine
beforeAll(async () => {
  engine = new GeomEngine()
  await engine.init()
}, 60_000)
afterAll(async () => { await engine.disposeKernel() })

const volume = async (h: BodyHandle): Promise<number> => (await engine.measure(h, 'volume')).value
async function block(): Promise<BodyHandle> {
  const r = await engine.makeExtrude({ featureId: 'F0', profiles: [blockProfile], end: { kind: 'blind', distance: D }, op: 'newBody' })
  expect(r.ok).toBe(true)
  return r.body!
}
function thinTool(op: ExtrudeRequest['op'], target?: BodyHandle, thickness = T): ExtrudeRequest {
  return { featureId: 'F1', profiles: [toolProfile], end: { kind: 'blind', distance: D }, op, target, thin: { thickness, side: 'inside' } }
}
function refused(r: OpResult): void {
  expect(r.ok).toBe(false)
  expect(r.body).toBeUndefined()
  expect(r.diagnostics[0]?.severity).toBe('error')
}

describe('WO-3233 thin extrude feature ops on a known rectangular overlap', () => {
  it('NewBody builds the tool alone: V = 1792', async () => {
    const r = await engine.makeExtrude(thinTool('newBody'))
    expect(r.ok).toBe(true)
    expect(await volume(r.body!)).toBeCloseTo(TOOL, 6)
    await engine.dispose(r.body!)
  }, 60_000)

  const ops = [
    { op: 'add' as const, expected: BLOCK + TOOL - OVERLAP },
    { op: 'cut' as const, expected: BLOCK - OVERLAP },
    { op: 'intersect' as const, expected: OVERLAP },
  ]
  for (const { op, expected } of ops) {
    it(`${op}: V = ${expected}, the target body itself unchanged`, async () => {
      const target = await block()
      const r = await engine.makeExtrude(thinTool(op, target))
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
      expect(r.body).not.toBe(target)
      expect(Math.abs(await volume(r.body!) - expected) / expected).toBeLessThanOrEqual(1e-6)
      expect(r.resolvedExtrudeEnd).toMatchObject({ kind: 'blind', startDistance: 0, endDistance: D })
      // The new walls carry the thin tool's constructed lineage.
      expect(r.elementMap!.generated.some((id) => /^F1:XTR:S1\.e\d:thin(In|Out)/.test(id))).toBe(true)
      expect(await volume(target)).toBeCloseTo(BLOCK, 6)
      await engine.dispose(r.body!)
      await engine.dispose(target)
    }, 60_000)
  }
})

describe('WO-3233 thin feature ops refuse bad targets and leave them unchanged', () => {
  it('a missing target is refused', async () => {
    const r = await engine.makeExtrude(thinTool('cut', undefined))
    refused(r)
    expect(String(r.diagnostics[0].params?.reason)).toBe('a thin cut needs a target body')
  }, 60_000)

  it('a disposed or foreign (never minted here) target is refused', async () => {
    const gone = await block()
    await engine.dispose(gone)
    refused(await engine.makeExtrude(thinTool('add', gone)))
    refused(await engine.makeExtrude(thinTool('intersect', 987_654 as BodyHandle)))
  }, 60_000)

  it('cutting the thin body from itself leaves nothing: refused, the body kept and still exportable', async () => {
    const self = await engine.makeExtrude(thinTool('newBody'))
    expect(self.ok).toBe(true)
    refused(await engine.makeExtrude({ ...thinTool('cut', self.body!), featureId: 'F2' }))
    expect(await volume(self.body!)).toBeCloseTo(TOOL, 6)
    const step = new TextDecoder().decode(await engine.exportStep([self.body!]))
    expect(step).toContain('MANIFOLD_SOLID_BREP')
    await engine.dispose(self.body!)
  }, 60_000)

  it('a refused thin op leaves the target unchanged, and the next op on it succeeds', async () => {
    const target = await block()
    for (const thickness of [0, 10, Number.NaN]) refused(await engine.makeExtrude(thinTool('cut', target, thickness)))
    expect(await volume(target)).toBeCloseTo(BLOCK, 6)
    const r = await engine.makeExtrude(thinTool('cut', target))
    expect(r.ok).toBe(true)
    expect(await volume(r.body!)).toBeCloseTo(BLOCK - OVERLAP, 6)
    await engine.dispose(r.body!)
    await engine.dispose(target)
  }, 60_000)
})
