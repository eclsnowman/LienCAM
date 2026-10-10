// GEO-3 acceptance #1 (extrude bodies + end conditions + ops), #3 (constructed
// lineage grammar + determinism golden + FAILS-IF enumeration), #8 (wasm-handle
// lifecycle on the error path). REAL occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ExtrudeRequest, ProfileRegion, ResolvedExtrudePlaneTarget, ResolvedExtrudeTarget } from '../../geom/geom-service.ts'
import { vertexId } from '../../doc/stable-id.ts'
import { rectWithHole, rectLoop, xyPlane } from './fixtures/profiles.ts'

const W = 40, H = 20, R = 5, CX = 20, CY = 10, DEPTH = 8

function circleRegion(sketchId: string, srcId: string, cx: number, cy: number, radius: number, z = 0): ProfileRegion {
  return {
    sketchId,
    plane: xyPlane(z),
    loops: [[{ kind: 'arc', c: [cx, cy], r: radius, a0: 0, a1: Math.PI * 2, ccw: true, srcId }]],
  }
}

describe('makeExtrude (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('#1 rectangle-with-hole blind extrude: correct faces + exact volume', async () => {
    const req: ExtrudeRequest = {
      featureId: 'F1',
      profiles: [rectWithHole('S1', W, H, CX, CY, R)],
      end: { kind: 'blind', distance: DEPTH },
      op: 'newBody',
    }
    const r = await engine.makeExtrude(req)
    expect(r.ok).toBe(true)
    const dm = r.elementMap!

    // volume exact vs analytic: (W*H - pi r^2) * depth, within 1e-6 relative.
    const vol = await engine.measure(r.body!, 'volume')
    const expected = (W * H - Math.PI * R * R) * DEPTH
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(1e-6)

    // face count: 4 outer sides + hole cylinder side(s) + 2 caps = 7 or 8.
    expect(dm.generated.length).toBeGreaterThanOrEqual(7)
    expect(dm.generated.length).toBeLessThanOrEqual(8)

    // every outer side + hole side + both caps present, by CONSTRUCTED id.
    for (const e of ['e0', 'e1', 'e2', 'e3']) {
      expect(dm.generated).toContain(`F1:XTR:S1.${e}:side`)
    }
    expect(dm.generated.some((id) => id.startsWith('F1:XTR:S1.h0:side'))).toBe(true)
    expect(dm.generated).toContain('F1:XTR:S1:capStart')
    expect(dm.generated).toContain('F1:XTR:S1:capEnd')

    // every named id carries an inline geometry snapshot (ICR-1 / criterion #4).
    for (const id of dm.generated) expect(dm.geometry![id]).toBeDefined()
    await engine.dispose(r.body!)
  }, 60_000)

  it('#3 FAILS-IF: side-face IDs are lineage-derived, not enumeration order', async () => {
    // Each outer wall's CONSTRUCTED id must land on ITS OWN geometry — a wall
    // named by kernel enumeration order would scramble which id sits on which
    // wall. Verify positionally via the inline geometry centroid.
    const r = await engine.makeExtrude({
      featureId: 'F1',
      profiles: [rectWithHole('S1', W, H, CX, CY, R)],
      end: { kind: 'blind', distance: DEPTH },
      op: 'newBody',
    })
    const g = r.elementMap!.geometry!
    // e0 = bottom wall (y=0); e1 = right (x=W); e2 = top (y=H); e3 = left (x=0)
    expect(g['F1:XTR:S1.e0:side'].centroid.y).toBeCloseTo(0, 5)
    expect(g['F1:XTR:S1.e1:side'].centroid.x).toBeCloseTo(W, 5)
    expect(g['F1:XTR:S1.e2:side'].centroid.y).toBeCloseTo(H, 5)
    expect(g['F1:XTR:S1.e3:side'].centroid.x).toBeCloseTo(0, 5)
    // caps sit at z=0 (start) and z=DEPTH (end).
    expect(g['F1:XTR:S1:capStart'].centroid.z).toBeCloseTo(0, 5)
    expect(g['F1:XTR:S1:capEnd'].centroid.z).toBeCloseTo(DEPTH, 5)
    await engine.dispose(r.body!)
  }, 60_000)

  it('#3 DETERMINISM golden: two runs produce byte-identical ID sets', async () => {
    const mk = (): Promise<import('../../geom/geom-service.ts').OpResult> => engine.makeExtrude({
      featureId: 'F1',
      profiles: [rectWithHole('S1', W, H, CX, CY, R)],
      end: { kind: 'blind', distance: DEPTH },
      op: 'newBody',
    })
    const a = await mk()
    const b = await mk()
    const idsA = [...a.elementMap!.generated].sort()
    const idsB = [...b.elementMap!.generated].sort()
    expect(idsA).toEqual(idsB)
    // and they are the lineage names, not `side#<enumIndex>` fallbacks.
    expect(idsA.every((id) => /:XTR:S1(\.\w+:side(#\d+)?|:cap(Start|End))$/.test(id))).toBe(true)
    await engine.dispose(a.body!)
    await engine.dispose(b.body!)
  }, 60_000)

  it('#1 symmetric end: centered about the profile plane, exact volume', async () => {
    const req: ExtrudeRequest = {
      featureId: 'F2',
      profiles: [{ sketchId: 'S2', plane: xyPlane(0), loops: [rectLoop('S2', 0, 0, 20, 10)] }],
      end: { kind: 'symmetric', distance: 10 },
      op: 'newBody',
    }
    const r = await engine.makeExtrude(req)
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - 20 * 10 * 10) / 2000).toBeLessThan(1e-6)
    const g = r.elementMap!.geometry!
    expect(g['F2:XTR:S2:capStart'].centroid.z).toBeCloseTo(-5, 5)
    expect(g['F2:XTR:S2:capEnd'].centroid.z).toBeCloseTo(5, 5)
    await engine.dispose(r.body!)
  }, 60_000)

  it('#1 cut into an existing box: exact volume, valid delta', async () => {
    const box = (await engine.makeBox('B1', { x: 40, y: 20, z: 10 })).body!
    // A 10x10 pillar centered in the box, extruded through it (z 0..10).
    const tool: ProfileRegion = { sketchId: 'S3', plane: xyPlane(0), loops: [rectLoop('S3', 15, 5, 25, 15)] }
    const r = await engine.makeExtrude({ featureId: 'F3', profiles: [tool], end: { kind: 'blind', distance: 10 }, op: 'cut', target: box })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - (40 * 20 * 10 - 10 * 10 * 10)) / 7000).toBeLessThan(1e-6)
    // delta names survivors + new walls, each with inline geometry.
    const dm = r.elementMap!
    for (const id of dm.generated) expect(dm.geometry![id]).toBeDefined()
    // cavity walls relabeled with the tool's XTR lineage where matchable.
    expect(dm.generated.some((id) => id.includes(':XTR:S3.'))).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('WO-1084 whole-sketch cut subtracts seven disjoint circular regions and recognizes seven holes', async () => {
    const boxSize = { x: 100, y: 80, z: 20 }
    const radius = 3
    const depth = 15
    const centers = [
      [15, 15], [40, 15], [65, 15], [85, 15],
      [25, 50], [50, 50], [75, 50],
    ] as const
    const box = (await engine.makeBox('WO1084-BOX', boxSize)).body!
    const profiles = centers.map(([x, y], index) =>
      circleRegion('WO1084-SK', `circle-${index + 1}`, x, y, radius, boxSize.z),
    ) as [ProfileRegion, ...ProfileRegion[]]

    const result = await engine.makeExtrude({
      featureId: 'WO1084-CUT',
      profiles,
      end: { kind: 'blind', distance: -depth },
      op: 'cut',
      target: box,
    })
    expect(result.ok).toBe(true)
    const measured = await engine.measure(result.body!, 'volume')
    const expected = boxSize.x * boxSize.y * boxSize.z - centers.length * Math.PI * radius * radius * depth
    expect(Math.abs(measured.value - expected) / expected).toBeLessThan(1e-6)

    const holes = (await engine.recognizeFeatures(result.body!)).filter((feature) =>
      feature.featureClass === 'blindHole' || feature.featureClass === 'throughHole' || feature.featureClass === 'counterboreStack',
    )
    expect(holes).toHaveLength(7)
    await engine.disposeAll()
  }, 60_000)

  it('WO-1084 nested whole-sketch regions fuse to the full rectangle prism', async () => {
    const width = 20
    const height = 10
    const depth = 6
    const profiles: [ProfileRegion, ProfileRegion] = [
      rectWithHole('WO1084-NEST', width, height, 10, 5, 2),
      circleRegion('WO1084-NEST', 'nested-disc', 10, 5, 2),
    ]

    const result = await engine.makeExtrude({
      featureId: 'WO1084-NEST-ADD',
      profiles,
      end: { kind: 'blind', distance: depth },
      op: 'newBody',
    })
    expect(result.ok).toBe(true)
    const measured = await engine.measure(result.body!, 'volume')
    const expected = width * height * depth
    expect(Math.abs(measured.value - expected) / expected).toBeLessThan(1e-6)
    await engine.disposeAll()
  }, 60_000)

  it('#1 add (fuse) a pillar onto a box: exact volume', async () => {
    const box = (await engine.makeBox('B2', { x: 40, y: 20, z: 10 })).body!
    const tool: ProfileRegion = { sketchId: 'S4', plane: xyPlane(10), loops: [rectLoop('S4', 15, 5, 25, 15)] }
    const r = await engine.makeExtrude({ featureId: 'F4', profiles: [tool], end: { kind: 'blind', distance: 10 }, op: 'add', target: box })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - (40 * 20 * 10 + 10 * 10 * 10)) / 9000).toBeLessThan(1e-6)
    await engine.disposeAll()
  }, 60_000)

  // WO UI-51A: the direction x booleanMode census against the REAL occt-wasm
  // kernel with exact analytic volumes. The parameter model (extrudeParams.ts)
  // maps direction -> ExtrudeEnd and mode -> op; here we drive makeExtrude with
  // exactly the mapped {end, op} for every one of the 12 cells and assert the
  // resulting solid's volume. Fixture: a 10x10 tool rectangle on the z=20
  // plane, magnitude 10, so up=z20..30, down=z10..20, midplane=z15..25. The
  // boolean target is a box spanning z0..40 (makeBox is corner-at-origin, vol
  // 32000) that fully contains all three tool orientations, keeping every cell
  // non-degenerate (no empty/disjoint edge cases -- those are covered by name
  // in extrudeParams.test.ts + the executor). Tool volume is always
  // 10*10*10 = 1000.
  //
  // This is the literal "one test per (direction x mode) cell against exact
  // volumes" gate. FAILS-IF: flip resolveExtrudeEnd's 'down' back to +distance
  // (extrudeParams.ts) and every down-* cell's volume assertion breaks (down
  // would extrude z20..30, identical to up -- but the cut/intersect cells still
  // land inside the box, so the volume stays 31000/1000; the DISTINCT proof is
  // the cap-centroid check below and the pure-mapping census).
  const TOOL = (): ProfileRegion => ({ sketchId: 'SM', plane: xyPlane(20), loops: [rectLoop('SM', 15, 5, 25, 15)] })
  const END_FOR: Record<'up' | 'down' | 'midplane', import('../../geom/geom-service.ts').ExtrudeEnd> = {
    up: { kind: 'blind', distance: 10 },
    down: { kind: 'blind', distance: -10 },
    midplane: { kind: 'symmetric', distance: 10 },
  }
  const OP_FOR = { newBody: 'newBody', add: 'add', remove: 'cut', intersect: 'intersect' } as const
  const BOX_VOL = 40 * 20 * 40 // tall target box, z -20..20
  const TOOL_VOL = 10 * 10 * 10
  // Every tool orientation sits fully inside the tall box, so: newBody=tool,
  // add=box (tool absorbed), cut=box-tool, intersect=tool.
  const EXPECTED_VOL: Record<string, number> = {
    newBody: TOOL_VOL,
    add: BOX_VOL,
    remove: BOX_VOL - TOOL_VOL,
    intersect: TOOL_VOL,
  }
  // The two cap-face centroid Z values per direction (tool profile at z=20,
  // magnitude 10). This SET distinguishes the direction SIGN independent of
  // start/end cap naming -- the volume alone can't (the tool sits inside the
  // box in every orientation).
  const EXPECTED_CAP_ZS: Record<'up' | 'down' | 'midplane', number[]> = {
    up: [20, 30],
    down: [10, 20],
    midplane: [15, 25],
  }

  for (const direction of ['up', 'down', 'midplane'] as const) {
    for (const mode of ['newBody', 'add', 'remove', 'intersect'] as const) {
      it(`#UI-51A cell direction=${direction} x mode=${mode}: exact volume against the real kernel`, async () => {
        const end = END_FOR[direction]
        const op = OP_FOR[mode]
        let target: import('../../geom/geom-service.ts').BodyHandle | undefined
        if (op !== 'newBody') {
          // Box z0..40 (corner-at-origin) fully contains all three tool orientations.
          const box = await engine.makeBox('BM', { x: 40, y: 20, z: 40 })
          expect(box.ok).toBe(true)
          target = box.body!
          const bv = await engine.measure(target, 'volume')
          expect(Math.abs(bv.value - BOX_VOL) / BOX_VOL).toBeLessThan(1e-6)
        }
        const r = await engine.makeExtrude({ featureId: 'FM', profiles: [TOOL()], end, op, target })
        expect(r.ok).toBe(true)
        const vol = await engine.measure(r.body!, 'volume')
        const expected = EXPECTED_VOL[mode]
        expect(Math.abs(vol.value - expected) / expected).toBeLessThan(1e-6)
        // Direction-SIGN proof (newBody only, where both caps survive): the two
        // XTR cap faces sit at the expected Z pair for this direction. This is
        // what actually fails if resolveExtrudeEnd's 'down' sign is dropped.
        if (mode === 'newBody') {
          const g = r.elementMap!.geometry!
          const capZs = Object.entries(g)
            .filter(([id]) => id.includes(':cap'))
            .map(([, snap]) => Math.round(snap.centroid.z * 1e5) / 1e5)
            .sort((a, b) => a - b)
          expect(capZs).toEqual(EXPECTED_CAP_ZS[direction])
        }
        await engine.disposeAll()
      }, 60_000)
    }
  }

  const MODEL_ITEM = 'MODEL-1'
  const END_TOOL = (): ProfileRegion => ({ sketchId: 'SEND', plane: xyPlane(0), loops: [rectLoop('SEND', 5, 5, 15, 15)] })
  const bodyTarget = (bodyFeatureId: string, body: BodyHandle): ResolvedExtrudeTarget => ({
    identity: { modelItemId: MODEL_ITEM, bodyFeatureId },
    body,
  })
  const subshapeTarget = (
    bodyFeatureId: string,
    body: BodyHandle,
    kind: 'face' | 'vertex',
    stableId: string,
    lineage?: string[],
  ): ResolvedExtrudeTarget => ({
    identity: { modelItemId: MODEL_ITEM, bodyFeatureId, subshape: { kind, stableId, ...(lineage ? { lineage } : {}) } },
    body,
  })
  const makeEndTarget = async (featureId: string, sketchId: string, direction: 1 | -1, size = 20) => {
    const nearZ = direction === 1 ? 10 : -10
    const target = await engine.makeExtrude({
      featureId,
      profiles: [{ sketchId, plane: xyPlane(nearZ), loops: [rectLoop(sketchId, 0, 0, size, size)] }],
      end: { kind: 'blind', distance: direction * 5 },
      op: 'newBody',
    })
    expect(target.ok).toBe(true)
    const nearCap = `${featureId}:XTR:${sketchId}:${direction === 1 ? 'capStart' : 'capEnd'}`
    const corner = vertexId([nearCap, `${featureId}:XTR:${sketchId}.e0:side`, `${featureId}:XTR:${sketchId}.e3:side`])
    return { target, nearCap, corner }
  }

  it.each([
    ['upToNext', 1], ['upToNext', -1],
    ['toFace', 1], ['toFace', -1],
    ['toPart', 1], ['toPart', -1],
    ['toVertex', 1], ['toVertex', -1],
  ] as const)('WO-214 %s executes in direction %s against real target geometry', async (kind, direction) => {
    try {
      const { target, nearCap, corner } = await makeEndTarget(`BT-${kind}-${direction}`, `ST-${kind}-${direction}`, direction)
      const body = bodyTarget(`BT-${kind}-${direction}`, target.body!)
      const end: ExtrudeRequest['end'] = kind === 'upToNext'
        ? { kind, direction, candidates: [body] }
        : kind === 'toFace'
          ? { kind, direction, target: subshapeTarget(body.identity.bodyFeatureId, body.body, 'face', nearCap) }
          : kind === 'toPart'
            ? { kind, direction, target: body }
            : { kind, direction, target: subshapeTarget(body.identity.bodyFeatureId, body.body, 'vertex', corner) }
      const result = await engine.makeExtrude({ featureId: `F-${kind}-${direction}`, profiles: [END_TOOL()], end, op: 'newBody', modelItemId: MODEL_ITEM })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const volume = await engine.measure(result.body!, 'volume')
      expect(volume.value).toBeCloseTo(100 * 10, 5)
      expect(result.resolvedExtrudeEnd?.startDistance).toBe(0)
      expect(result.resolvedExtrudeEnd?.endDistance).toBe(direction * 10)
      expect(result.resolvedExtrudeEnd?.targets[0].bodyFeatureId).toBe(body.identity.bodyFeatureId)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it.each([1, -1] as const)('WO-214 Through all executes in direction %s and clears the complete target extent', async (direction) => {
    try {
      const { target } = await makeEndTarget(`BTA-${direction}`, `STA-${direction}`, direction)
      const scope = bodyTarget(`BTA-${direction}`, target.body!)
      const result = await engine.makeExtrude({
        featureId: `FTA-${direction}`,
        profiles: [END_TOOL()],
        end: { kind: 'throughAll', direction, targets: [scope] },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const end = result.resolvedExtrudeEnd!
      expect(direction * end.endDistance).toBeGreaterThan(15)
      const volume = await engine.measure(result.body!, 'volume')
      expect(volume.value).toBeGreaterThan(1500)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('WO-214 symmetric Through all spans equal distances on both sides', async () => {
    try {
      const up = await makeEndTarget('BTS-UP', 'STS-UP', 1)
      const down = await makeEndTarget('BTS-DOWN', 'STS-DOWN', -1)
      const result = await engine.makeExtrude({
        featureId: 'FTS',
        profiles: [END_TOOL()],
        end: { kind: 'throughAll', direction: 1, targets: [bodyTarget('BTS-UP', up.target.body!), bodyTarget('BTS-DOWN', down.target.body!)], symmetric: true },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      expect(result.resolvedExtrudeEnd!.startDistance).toBeCloseTo(-result.resolvedExtrudeEnd!.endDistance, 8)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it.each([[-2, 800], [2, 1200]] as const)('WO-214 signed terminal offset %s falls short or extends Up to face', async (offset, expectedVolume) => {
    try {
      const { target, nearCap } = await makeEndTarget(`BO-${offset}`, `SO-${offset}`, 1)
      const selected = subshapeTarget(`BO-${offset}`, target.body!, 'face', nearCap)
      const result = await engine.makeExtrude({
        featureId: `FO-${offset}`,
        profiles: [END_TOOL()],
        end: { kind: 'toFace', direction: 1, target: selected, offset },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const volume = await engine.measure(result.body!, 'volume')
      expect(volume.value).toBeCloseTo(expectedVolume, 5)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('WO-214 Up to next chooses the nearest eligible body regardless of candidate order', async () => {
    try {
      const near = await makeEndTarget('BN', 'SN', 1)
      const far = await engine.makeExtrude({
        featureId: 'BF',
        profiles: [{ sketchId: 'SF', plane: xyPlane(20), loops: [rectLoop('SF', 0, 0, 20, 20)] }],
        end: { kind: 'blind', distance: 5 },
        op: 'newBody',
      })
      const result = await engine.makeExtrude({
        featureId: 'FN',
        profiles: [END_TOOL()],
        end: { kind: 'upToNext', direction: 1, candidates: [bodyTarget('BF', far.body!), bodyTarget('BN', near.target.body!)] },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      expect(result.resolvedExtrudeEnd?.endDistance).toBeCloseTo(10, 6)
      expect(result.resolvedExtrudeEnd?.targets[0].bodyFeatureId).toBe('BN')
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('WO-214 Up to part refuses a partial footprint that cannot fully terminate the profile', async () => {
    try {
      const partial = await makeEndTarget('BPARTIAL', 'SPARTIAL', 1, 4)
      const result = await engine.makeExtrude({
        featureId: 'FNOHIT',
        profiles: [END_TOOL()],
        end: { kind: 'toPart', direction: 1, target: bodyTarget('BPARTIAL', partial.target.body!) },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok).toBe(false)
      expect(result.diagnostics[0].params?.reason).toMatch(/no geometry that fully terminates/i)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('WO-214 Up to face uses the infinite underlying plane, not the displayed trim', async () => {
    try {
      const small = await makeEndTarget('BSMALL', 'SSMALL', 1, 4)
      const selected = subshapeTarget('BSMALL', small.target.body!, 'face', small.nearCap)
      const result = await engine.makeExtrude({
        featureId: 'FPLANE', profiles: [END_TOOL()], end: { kind: 'toFace', direction: 1, target: selected }, op: 'newBody', modelItemId: MODEL_ITEM,
      })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const volume = await engine.measure(result.body!, 'volume')
      expect(volume.value).toBeCloseTo(1000, 5)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it.each([1, -1] as const)('WO-214 Up to plane executes a persisted standalone datum target in direction %s', async (direction) => {
    try {
      const identity = { modelItemId: MODEL_ITEM, planeFeatureId: `datum:offset:${direction}` }
      const target: ResolvedExtrudePlaneTarget = {
        identity,
        plane: {
          origin: { x: 0, y: 0, z: direction * 10 },
          normal: { x: 0, y: 0, z: 1 },
          xDir: { x: 1, y: 0, z: 0 },
        },
      }
      const result = await engine.makeExtrude({
        featureId: `F-DATUM-${direction}`,
        profiles: [END_TOOL()],
        end: { kind: 'toFace', direction, target, offset: 2 },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const volume = await engine.measure(result.body!, 'volume')
      expect(volume.value).toBeCloseTo(1200, 5)
      expect(result.resolvedExtrudeEnd).toEqual({
        kind: 'toFace',
        startDistance: 0,
        endDistance: direction * 12,
        targets: [identity],
      })
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it.each([
    ['forward', 1, -10],
    ['reverse', -1, 10],
  ] as const)('WO-222 refuses an un-offset datum plane behind the %s direction even when +12 offset would cross the profile', async (_label, direction, targetZ) => {
    try {
      const identity = { modelItemId: MODEL_ITEM, planeFeatureId: `datum:behind:${direction}` }
      const target: ResolvedExtrudePlaneTarget = {
        identity,
        plane: {
          origin: { x: 0, y: 0, z: targetZ },
          normal: { x: 0, y: 0, z: 1 },
          xDir: { x: 1, y: 0, z: 0 },
        },
      }
      const result = await engine.makeExtrude({
        featureId: `F-DATUM-BEHIND-${direction}`,
        profiles: [END_TOOL()],
        end: { kind: 'toFace', direction, target, offset: 12 },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok).toBe(false)
      expect(result.diagnostics[0].params?.reason).toMatch(/before offset; terminal offset cannot make an ineligible target valid/i)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it.each(['face', 'vertex'] as const)('WO-222 refuses an un-offset selected %s behind +Z even when +12 offset would cross the profile', async (kind) => {
    try {
      const featureId = `B-BEHIND-${kind}`
      const sketchId = `S-BEHIND-${kind}`
      const { target } = await makeEndTarget(featureId, sketchId, -1)
      const cap = `${featureId}:XTR:${sketchId}:capStart`
      const stableId = kind === 'face'
        ? cap
        : vertexId([cap, `${featureId}:XTR:${sketchId}.e0:side`, `${featureId}:XTR:${sketchId}.e3:side`])
      const selected = subshapeTarget(featureId, target.body!, kind, stableId)
      const result = await engine.makeExtrude({
        featureId: `F-BEHIND-${kind}`,
        profiles: [END_TOOL()],
        end: kind === 'face'
          ? { kind: 'toFace', direction: 1, target: selected, offset: 12 }
          : { kind: 'toVertex', direction: 1, target: selected, offset: 12 },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok).toBe(false)
      expect(result.diagnostics[0].params?.reason).toMatch(/before offset; terminal offset cannot make an ineligible target valid/i)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it.each(['upToNext', 'toPart'] as const)('WO-222 refuses a behind-direction body for %s before considering its +20 offset', async (kind) => {
    try {
      const { target } = await makeEndTarget(`B-BEHIND-${kind}`, `S-BEHIND-${kind}`, -1)
      const body = bodyTarget(`B-BEHIND-${kind}`, target.body!)
      const result = await engine.makeExtrude({
        featureId: `F-BEHIND-${kind}`,
        profiles: [END_TOOL()],
        end: kind === 'upToNext'
          ? { kind, direction: 1, candidates: [body], offset: 20 }
          : { kind, direction: 1, target: body, offset: 20 },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok).toBe(false)
      expect(result.diagnostics[0].params?.reason).toMatch(/no geometry that fully terminates the profile/i)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('WO-222 gives an actionable refusal when an eligible target offset crosses the profile plane', async () => {
    try {
      const identity = { modelItemId: MODEL_ITEM, planeFeatureId: 'datum:eligible-crossing' }
      const target: ResolvedExtrudePlaneTarget = {
        identity,
        plane: {
          origin: { x: 0, y: 0, z: 10 },
          normal: { x: 0, y: 0, z: 1 },
          xDir: { x: 1, y: 0, z: 0 },
        },
      }
      const result = await engine.makeExtrude({
        featureId: 'F-DATUM-CROSSING',
        profiles: [END_TOOL()],
        end: { kind: 'toFace', direction: 1, target, offset: -12 },
        op: 'newBody',
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok).toBe(false)
      expect(result.diagnostics[0].params?.reason).toMatch(/eligible before offset.*crosses the profile plane; reduce or reverse the offset/i)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('WO-214 refuses a selected non-planar face with a specific unsupported-target diagnostic', async () => {
    try {
      const circle: ProfileRegion = {
        sketchId: 'SCYL', plane: xyPlane(10),
        loops: [[{ kind: 'arc', c: [10, 10], r: 5, a0: 0, a1: Math.PI * 2, ccw: true, srcId: 'SCYL.c0' }]],
      }
      const cylinder = await engine.makeExtrude({ featureId: 'BCYL', profiles: [circle], end: { kind: 'blind', distance: 5 }, op: 'newBody' })
      const selected = subshapeTarget('BCYL', cylinder.body!, 'face', 'BCYL:XTR:SCYL.c0:side')
      const result = await engine.makeExtrude({
        featureId: 'FNONPLANAR', profiles: [END_TOOL()], end: { kind: 'toFace', direction: 1, target: selected }, op: 'newBody', modelItemId: MODEL_ITEM,
      })
      expect(result.ok).toBe(false)
      expect(result.diagnostics[0].params?.reason).toMatch(/unsupported non-planar surface 'cylinder'/i)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('WO-214 stable face identity re-resolves after kernel body serialize/restore', async () => {
    try {
      const original = await makeEndTarget('BRELOAD', 'SRELOAD', 1)
      const bytes = await engine.serializeBody(original.target.body!)
      const restored = await engine.restoreBody(bytes, original.target.elementMap!)
      const selected = subshapeTarget('BRELOAD', restored, 'face', original.nearCap)
      const result = await engine.makeExtrude({
        featureId: 'FRELOAD', profiles: [END_TOOL()], end: { kind: 'toFace', direction: 1, target: selected }, op: 'newBody', modelItemId: MODEL_ITEM,
      })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      expect(result.resolvedExtrudeEnd?.targets[0]).toEqual(selected.identity)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('WO-214 lost, ambiguous, behind-direction, and cross-item face targets all refuse by name', async () => {
    try {
      const { target, nearCap } = await makeEndTarget('BREFUSE', 'SREFUSE', 1)
      const farCap = 'BREFUSE:XTR:SREFUSE:capEnd'
      const cases: Array<{ name: string; reqTarget: ResolvedExtrudeTarget; direction: 1 | -1; modelItemId: string; reason: RegExp }> = [
        { name: 'lost', reqTarget: subshapeTarget('BREFUSE', target.body!, 'face', 'BREFUSE:XTR:SREFUSE:missing'), direction: 1, modelItemId: MODEL_ITEM, reason: /is lost/i },
        { name: 'ambiguous', reqTarget: subshapeTarget('BREFUSE', target.body!, 'face', 'missing', [nearCap, farCap]), direction: 1, modelItemId: MODEL_ITEM, reason: /ambiguous/i },
        { name: 'behind', reqTarget: subshapeTarget('BREFUSE', target.body!, 'face', nearCap), direction: -1, modelItemId: MODEL_ITEM, reason: /selected extrusion direction before offset/i },
        { name: 'cross-item', reqTarget: { ...subshapeTarget('BREFUSE', target.body!, 'face', nearCap), identity: { ...subshapeTarget('BREFUSE', target.body!, 'face', nearCap).identity, modelItemId: 'MODEL-2' } }, direction: 1, modelItemId: MODEL_ITEM, reason: /belongs to Model Item/i },
      ]
      for (const c of cases) {
        const result = await engine.makeExtrude({
          featureId: `F-${c.name}`, profiles: [END_TOOL()], end: { kind: 'toFace', direction: c.direction, target: c.reqTarget }, op: 'newBody', modelItemId: c.modelItemId,
        })
        expect(result.ok, c.name).toBe(false)
        expect(result.diagnostics[0].params?.reason, c.name).toMatch(c.reason)
      }
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it.each([
    ['add', 40 * 20 * 10],
    ['cut', 40 * 20 * 10 - 10 * 10 * 10],
    ['intersect', 10 * 10 * 10],
  ] as const)('WO-214 Through all interacts correctly with boolean op %s', async (op, expectedVolume) => {
    try {
      const target = (await engine.makeBox(`BBOOL-${op}`, { x: 40, y: 20, z: 10 })).body!
      const scope = bodyTarget(`BBOOL-${op}`, target)
      const result = await engine.makeExtrude({
        featureId: `FBOOL-${op}`,
        profiles: [{ sketchId: `SBOOL-${op}`, plane: xyPlane(0), loops: [rectLoop(`SBOOL-${op}`, 15, 5, 25, 15)] }],
        end: { kind: 'throughAll', direction: 1, targets: [scope] },
        op,
        target,
        modelItemId: MODEL_ITEM,
      })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const volume = await engine.measure(result.body!, 'volume')
      expect(Math.abs(volume.value - expectedVolume) / expectedVolume).toBeLessThan(1e-5)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('#8 WASM-HANDLE LIFECYCLE: degenerate profile fails cleanly, no handle growth', async () => {
    const baseline = engine.debugKernelShapeCount()
    // Degenerate: a single-segment "loop" that cannot close into a face.
    const bad: ProfileRegion = {
      sketchId: 'SBAD',
      plane: xyPlane(0),
      loops: [[{ kind: 'line', a: [0, 0], b: [10, 0], srcId: 'SBAD.e0' }]],
    }
    const r = await engine.makeExtrude({ featureId: 'FBAD', profiles: [bad], end: { kind: 'blind', distance: 5 }, op: 'newBody' })
    expect(r.ok).toBe(false)
    expect(r.body).toBeUndefined()
    // Every transient created on the way to the failure was released — the live
    // kernel shape count returns exactly to baseline (criterion #8).
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
  }, 60_000)

  it('#8 WASM-HANDLE LIFECYCLE: error AFTER the sweep boolean releases the result shape', async () => {
    // The degenerate-profile test above fails BEFORE any boolean result exists.
    // This drives the OTHER error path (GEO-3 R1 audit finding): a fault AFTER
    // cutWithHistory has produced its result shape but BEFORE that shape is
    // minted into a body record. Without the release-on-error guard in
    // #applySweepBoolean, the orphaned result would leak a kernel shape (the
    // outer makeExtrude finally only releases the tool, never the boolean
    // result). Assert the live kernel shape count returns exactly to baseline.
    const box = (await engine.makeBox('B8', { x: 40, y: 20, z: 10 })).body!
    const baseline = engine.debugKernelShapeCount()
    const tool: ProfileRegion = { sketchId: 'S8', plane: xyPlane(0), loops: [rectLoop('S8', 15, 5, 25, 15)] }
    engine.debugSetSweepFaultAfterBoolean(() => { throw new Error('injected post-boolean fault') })
    try {
      const r = await engine.makeExtrude({ featureId: 'F8', profiles: [tool], end: { kind: 'blind', distance: 10 }, op: 'cut', target: box })
      expect(r.ok).toBe(false)
      expect(r.body).toBeUndefined()
    } finally {
      engine.debugSetSweepFaultAfterBoolean(null)
    }
    // The orphaned boolean result was released; only the target box shape remains.
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
    await engine.disposeAll()
  }, 60_000)
})
