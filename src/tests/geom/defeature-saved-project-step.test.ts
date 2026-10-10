// Regression for the saved multi-operation step body that exposed Defeature's
// "0 of 1 removable feature(s) healed" refusal. This is intentionally not a
// primitive box: the body is authored as extrude -> side cut -> three-edge
// fillet, leaving an 11-face stepped solid whose fillet hosts are only locally
// bounded by the sharp step geometry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProfileRegion, StableId } from '../../geom/geom-service.ts'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { edgeId } from '../../geom/worker/stable-id.ts'

const BASE: ProfileRegion = {
  sketchId: 'SK1',
  plane: {
    normal: { x: 0, y: 0, z: 1 },
    origin: { x: 0, y: 0, z: 0 },
    xDir: { x: 1, y: 0, z: 0 },
  },
  loops: [[
    { kind: 'line', a: [31.1535992527557, 23.365199039578453], b: [-31.1535992527557, 23.365199039578453], srcId: '07851560-d3f7-42ce-b4af-e1a1e8fd122e' },
    { kind: 'line', a: [-31.1535992527557, 23.365199039578453], b: [-31.1535992527557, -23.365199039578453], srcId: '62ef5d72-7b62-4073-8a04-7cdfd44ad9ac' },
    { kind: 'line', a: [-31.1535992527557, -23.365199039578453], b: [31.1535992527557, -23.365199039578453], srcId: 'e7ec4046-2043-45a0-939c-cbab58a56bef' },
    { kind: 'line', a: [31.1535992527557, -23.365199039578453], b: [31.1535992527557, 23.365199039578453], srcId: 'b7183056-7bb4-4a48-b260-2bd3edb0fc09' },
  ]],
}

const SIDE_CUT: ProfileRegion = {
  sketchId: 'SK2',
  plane: {
    normal: { x: 0, y: -1, z: 0 },
    origin: { x: 0, y: -23.365199039578453, z: 15 },
    xDir: { x: 1, y: 0, z: 0 },
  },
  loops: [[
    { kind: 'line', a: [-14.88140678591455, 3.6160427704091447], b: [-14.88140678591455, 34.491484886979514], srcId: '07c7913f-bdb5-4c41-95c3-fdc2ebd8659d' },
    { kind: 'line', a: [-14.88140678591455, 34.491484886979514], b: [-54.93603439660045, 34.491484886979514], srcId: '1e1bcaa3-df0d-4e54-a7d1-e7d5b10b7ea0' },
    { kind: 'line', a: [-54.93603439660045, 34.491484886979514], b: [-54.93603439660045, 3.6160427704091447], srcId: 'ad003982-de9a-489c-a672-bbc4e58b5be5' },
    { kind: 'line', a: [-54.93603439660045, 3.6160427704091447], b: [-14.88140678591455, 3.6160427704091447], srcId: '8522d372-3ceb-4fd3-b829-264ca33a0675' },
  ]],
}

// Fixture provenance (WO-1892, ADR-0040): the F3 fillet edges were regenerated
// through today's engine, same modelling steps. The side cut's floor (z 18.6,
// swept from segment 8522d372) and wall (x -14.88, from 07c7913f) are now named
// from the kernel's boolean record; the saved project called them F2:CUT:new#0
// and F2:CUT:new#1. The three picked edges are the same physical edges.
async function filletedStep(engine: GeomEngine) {
  const extruded = await engine.makeExtrude({
    featureId: 'F1',
    profile: BASE,
    end: { kind: 'blind', distance: 30 },
    op: 'newBody',
  })
  expect(extruded.ok, JSON.stringify(extruded.diagnostics)).toBe(true)

  const cut = await engine.makeExtrude({
    featureId: 'F2',
    profile: SIDE_CUT,
    end: { kind: 'blind', distance: -100 },
    op: 'cut',
    target: extruded.body!,
  })
  expect(cut.ok, JSON.stringify(cut.diagnostics)).toBe(true)

  const filleted = await engine.applyFillet({
    featureId: 'F3',
    body: cut.body!,
    edges: [
      edgeId(['F1:XTR:SK1:capEnd' as StableId, 'F2:XTR:07c7913f-bdb5-4c41-95c3-fdc2ebd8659d:side' as StableId], '0'),
      edgeId(['F2:XTR:07c7913f-bdb5-4c41-95c3-fdc2ebd8659d:side' as StableId, 'F2:XTR:8522d372-3ceb-4fd3-b829-264ca33a0675:side' as StableId], '0'),
      edgeId(['F1:XTR:62ef5d72-7b62-4073-8a04-7cdfd44ad9ac:side' as StableId, 'F2:XTR:8522d372-3ceb-4fd3-b829-264ca33a0675:side' as StableId], '0'),
    ],
    radius: 2,
    propagateTangent: true,
  })
  expect(filleted.ok, JSON.stringify(filleted.diagnostics)).toBe(true)
  return filleted.body!
}

describe('Defeature on a saved multi-operation filleted step', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('removes one recognized supported fillet and heals the stepped solid watertight', async () => {
    const body = await filletedStep(engine)
    const beforeVolume = (await engine.measure(body, 'volume')).value
    const beforeFaces = new Set((await engine.tessellate(body, { deflection: 0.1 })).faceIds)
    expect(beforeFaces.size).toBe(11)

    const verdicts = await engine.recognizeFeatures(body)
    const supported = verdicts.filter((verdict) =>
      verdict.featureClass === 'filletPlanar' && verdict.removable && verdict.params.radius === 2,
    )
    expect(supported.length).toBeGreaterThan(0)

    const target = supported[0]
    const removed = await engine.defeatureBatch({
      featureId: 'F4',
      body,
      featureKeys: [target.featureKey],
    })
    expect(
      removed.ok,
      JSON.stringify({ diagnostics: removed.diagnostics, report: removed.report }, null, 2),
    ).toBe(true)
    expect(removed.report).toMatchObject({
      requested: 1,
      healed: 1,
      failed: 0,
      refused: 0,
      items: [{ featureKey: target.featureKey, healed: true, effect: 'add' }],
    })
    expect((await engine.measure(removed.body!, 'volume')).value).toBeGreaterThan(beforeVolume)
    expect(new Set((await engine.tessellate(removed.body!, { deflection: 0.1 })).faceIds).size)
      .toBeLessThan(beforeFaces.size)

    const afterVerdicts = await engine.recognizeFeatures(removed.body!)
    expect(afterVerdicts.some((verdict) => verdict.featureKey === target.featureKey)).toBe(false)
    await engine.disposeAll()
  }, 60_000)
})
