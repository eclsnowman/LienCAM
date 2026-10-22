// WO-3022: Form - From body on the operator's PortalHandle.step froze the page. The remesher made a
// 61,228-face cage that the From body check refuses (faces that repeat a point, faces wound against
// each other), but formFromBody Pulled it onto the body first - three subdivision levels over the
// whole cage - and the page ran out of memory there, so the refusal never showed. formFromBody now
// Pulls only a cage that passes the check.
//
// The reduced fixture is ONE body face cut from the file's own From body tessellation (face 0: 60
// triangles, a curved strip 12 x 34 mm, points rounded to 0.1 um): alone it already remeshes into a
// cage the check refuses. The full file runs as a journey receipt when it is on this machine
// (H:\LienCAM\fixtures\PortalHandle.step, never committed; WO3022_STEP names another path).
import { existsSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const pulls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../form/shapeTools', async (original) => {
  const real = await original<typeof import('../../form/shapeTools')>()
  return (await import('../support/typedMock')).typedMock<typeof import('../../form/shapeTools')>({ ...real, pullOntoTargets: (...a: Parameters<typeof real.pullOntoTargets>) => { pulls.count++; return real.pullOntoTargets(...a) } })
})

import { formFromBody, FORM_FROM_BODY_TESS } from '../../form/fromMesh'
import { remeshFromBody } from '../../form/remesh'
import { validateCage } from '../../form/halfEdge'
import { GeomEngine } from '../../geom/worker/geom-engine'
import type { BodyHandle } from '../../geom/geom-service'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'

const FACE0_POSITION = [310.974,23.2764,45.4155,312.3108,22.7873,45.0399,311.4256,23.1096,45.2831,309.6832,23.8834,45.7785,309.8012,23.8329,45.74,308.2423,24.7461,46.1826,306.9019,25.7686,46.555,307.9701,24.9479,46.253,304.5818,28.2446,47.1861,305.6778,26.9408,46.8904,305.0696,27.6479,47.0473,303.0282,30.7761,47.5861,303.5756,29.7448,47.4523,303.9651,29.1483,47.3412,301.9487,33.3592,47.8691,302.6054,31.6344,47.7029,302.169,32.7587,47.8065,301.0343,38.3318,48.0906,301.1031,37.3372,48.0803,301.1454,37.0782,48.0629,300.9998,39.5885,48.0991,300.988,39.6001,48.1086,301.1328,41.8312,48.066,301.1532,42.0909,48.0672,301.5681,44.269,47.958,301.6056,44.4601,47.9538,302.1399,46.2021,47.8193,303.8518,49.7062,47.378,303.0244,48.2549,47.5935,303.2318,48.6322,47.5337,305.8605,52.2358,46.8335,304.8182,51.0628,47.1213,304.4431,50.5517,47.2147,305.915,52.3077,46.8249,306.6475,52.9925,46.6185,307.1314,53.4241,46.4913,307.4853,53.6914,46.3874,308.5715,54.4701,46.0909,309.1172,54.7905,45.932,310.3841,55.4636,45.582,312.3045,56.2108,45.0419,310.9529,55.6989,45.4159,313.1237,56.4335,44.8078,302.2669,46.5283,47.7822,306.4395,26.1979,46.6757,313.1236,22.5664,44.8077,306.0126,26.6033,46.7953,304.2094,28.7719,47.2809,302.7977,31.2294,47.6478,301.7945,33.8834,47.9032,301.4681,35.1174,47.9894,301.5393,34.8563,47.9651,301.1953,36.659,48.0531,304.1946,50.2085,47.2831,310.5457,55.5286,45.5329]
const FACE0_INDEX = [0,1,2,3,0,4,5,3,4,6,5,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,17,22,21,20,23,21,22,24,23,22,25,23,24,26,25,24,27,28,29,30,31,32,33,31,30,34,33,30,35,33,34,36,35,34,37,35,36,38,37,36,39,37,38,40,39,41,42,40,41,28,26,43,21,18,17,43,29,28,24,43,26,7,44,6,4,7,5,2,4,0,45,2,1,46,9,6,46,44,10,46,6,44,46,10,9,47,12,8,47,10,13,47,8,10,47,13,12,48,15,12,48,11,16,48,12,11,48,16,15,49,50,14,49,16,51,49,14,16,49,51,50,52,19,18,52,18,50,52,51,19,52,50,51,53,31,27,53,27,29,53,29,32,53,32,31,54,38,41,54,39,38,54,41,39]
const face0 = { position: Float32Array.from(FACE0_POSITION), index: Uint32Array.from(FACE0_INDEX), triFace: new Uint32Array(FACE0_INDEX.length / 3) }

describe('WO-3022: From body never Pulls a cage it then refuses', () => {
  // WO-3051 re-pin (architect YES on PR #82): face 0 alone used to grid into quads wound against each other, a cage
  // the check refuses, and formFromBody handed it back unpulled. Remesh now drops a grid that folds: the face keeps
  // its own triangles, a cage the check passes, and formFromBody Pulls it once like any body that shapes
  it('the PortalHandle face remeshes into a cage the check passes, and formFromBody Pulls it once', () => {
    const bare = remeshFromBody(face0, { sharpDeg: 30, pull: false })
    expect(validateCage(bare.cage).ok).toBe(true)
    pulls.count = 0
    const r = formFromBody(face0)
    expect(pulls.count).toBe(1)
    expect(validateCage(r.cage).ok).toBe(true)
    expect(r.cage.faces).toEqual(bare.cage.faces)
    expect(r.cage).toEqual(remeshFromBody(face0, { sharpDeg: 30 }).cage)
  })

  describe('a body that shapes still gets its Pulled cage, unchanged (real occt-wasm)', () => {
    let engine: GeomEngine
    const bodies = new Map<string, BodyHandle>()
    beforeAll(async () => {
      engine = new GeomEngine()
      await engine.init()
      const box = await engine.makeBox('B', { x: 40, y: 30, z: 20 })
      bodies.set('box', box.body!)
      bodies.set('cylinder', (await engine.debugMakeCylinder('C', 10, 20)).body!)
      const t0 = await engine.tessellate(box.body!, FORM_FROM_BODY_TESS)
      bodies.set('filleted box', (await engine.applyFillet({ featureId: 'F', body: box.body!, edges: [...t0.edgeIds], radius: 4, propagateTangent: true })).body!)
    }, 180_000)
    afterAll(async () => { await engine.disposeKernel() })

    for (const name of ['box', 'cylinder', 'filleted box']) {
      it(`${name}: the same cage as the remesher's own Pulled one, and the check passes`, async () => {
        const mesh = await engine.tessellate(bodies.get(name)!, FORM_FROM_BODY_TESS)
        pulls.count = 0
        const r = formFromBody(mesh)
        expect(validateCage(r.cage).ok).toBe(true)
        expect(pulls.count).toBe(1)
        expect(r.cage).toEqual(remeshFromBody(mesh, { sharpDeg: 30 }).cage)
      })
    }
  })
})

// Journey receipt on the full file through the Model page's engine (importStep, the display
// tessellation the page draws first, then the From body tessellation the page asks for - the
// kernel keeps the finer display one, 55,733 triangles).
const STEP = process.env.WO3022_STEP ?? 'H:/LienCAM/fixtures/PortalHandle.step'
describe.skipIf(!existsSync(STEP))('WO-3022 journey: From body on the full PortalHandle.step', () => {
  it('finishes and hands back a cage the check passes (WO-3051; WO-3022: refused, instead of running out of memory)', async () => {
    const engine = new GeomEngine()
    await engine.init()
    try {
      const bytes = readFileSync(STEP)
      const imp = await engine.importStep(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'IMP1')
      expect(imp.bodies).toHaveLength(1)
      expect(imp.bodies[0].elementMap.generated).toHaveLength(268)
      await engine.tessellate(imp.bodies[0].handle, DISPLAY_TESS_QUALITY)
      const mesh = await engine.tessellate(imp.bodies[0].handle, FORM_FROM_BODY_TESS)
      pulls.count = 0
      const t0 = performance.now()
      const r = formFromBody(mesh)
      const ms = performance.now() - t0
      console.log(JSON.stringify({ journey: 'PortalHandle From body', triangles: mesh.index.length / 3, cagePoints: r.cage.positions.length, cageFaces: r.cage.faces.length, ms: Math.round(ms), pulls: pulls.count }))
      expect(pulls.count).toBe(1)
      expect(validateCage(r.cage).ok).toBe(true)
    } finally {
      await engine.disposeKernel()
    }
  }, 600_000)
})
