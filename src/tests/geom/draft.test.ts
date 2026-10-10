// GEO-4 acceptance #4 (draft: planar classification + normal tilt + frustum
// analytic volume), #5 (constructed lineage / determinism -- draft is a
// direct edit, ids persist), #6 (element-map deltas), #7c (diagnostics),
// #9 (WASM-handle lifecycle). REAL occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

const W = 40, H = 20, D = 10
const SIDE_IDS = ['F1:BOX:xMin', 'F1:BOX:xMax', 'F1:BOX:yMin', 'F1:BOX:yMax']

describe('applyDraft (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('#4 4 side faces drafted 5deg about the bottom neutral plane: planar + 5deg normal tilt + frustum analytic volume', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const angleDeg = 5
    const r = await engine.applyDraft({
      featureId: 'F2',
      body: box.body!,
      faces: SIDE_IDS,
      neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      pullDir: { x: 0, y: 0, z: -1 },
      angleDeg,
    })
    expect(r.ok).toBe(true)
    const dm = r.elementMap!

    // ids persist (direct edit -- no new faces, no deletions).
    expect(dm.generated).toEqual([])
    expect(dm.deleted).toEqual([])
    for (const id of SIDE_IDS) expect(dm.geometry![id]).toBeDefined()

    const t = Math.tan((angleDeg * Math.PI) / 180)
    const analytic = W * H * D + t * (W + H) * D * D + (4 / 3) * t * t * D * D * D
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - analytic) / analytic).toBeLessThan(1e-6)

    for (const id of SIDE_IDS) {
      expect(await engine.classifyFace(r.body!, id)).toBe('plane')
      const n = dm.geometry![id].normal!
      // wall normal started purely horizontal (dot with vertical = 0); after
      // an angleDeg draft about the z=0 neutral plane it picks up a vertical
      // component of exactly sin(angleDeg) -- the tilt "from vertical".
      expect(Math.abs(Math.abs(n.z) - Math.sin((angleDeg * Math.PI) / 180))).toBeLessThan(1e-5)
    }
    await engine.disposeAll()
  }, 60_000)

  // GEO-4-R1.2: valid drafts LARGER than 5deg must succeed. The pre-R1 rebind
  // reused restoreBody's fixed 1%-of-bbox-diag centroid tolerance (~0.46 for
  // this box); a side face drafted 10deg moves its centroid ~0.88, so pre-R1
  // failed it as a lost-track DRAFT_FAILED. The motion-aware tolerance (bounded
  // by tan(angle) x distance-to-neutral-plane) fixes it. The 10deg case FAILS
  // against the pre-R1 implementation (it returned ok:false there).
  for (const angleDeg of [10, 30]) {
    it(`#R1.2 all 4 side faces drafted ${angleDeg}deg succeed with persistent ids + frustum analytic volume`, async () => {
      const box = await engine.makeBox('F1', { x: W, y: H, z: D })
      const r = await engine.applyDraft({
        featureId: 'F2',
        body: box.body!,
        faces: SIDE_IDS,
        neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
        pullDir: { x: 0, y: 0, z: -1 },
        angleDeg,
      })
      expect(r.ok).toBe(true)
      const dm = r.elementMap!
      expect(dm.generated).toEqual([])
      expect(dm.deleted).toEqual([])
      // every original side id persisted (draft is a direct edit, no new ids).
      for (const id of SIDE_IDS) expect(dm.geometry![id]).toBeDefined()

      const t = Math.tan((angleDeg * Math.PI) / 180)
      const analytic = W * H * D + t * (W + H) * D * D + (4 / 3) * t * t * D * D * D
      const vol = await engine.measure(r.body!, 'volume')
      expect(Math.abs(vol.value - analytic) / analytic).toBeLessThan(1e-6)

      for (const id of SIDE_IDS) {
        expect(await engine.classifyFace(r.body!, id)).toBe('plane')
        const n = dm.geometry![id].normal!
        expect(Math.abs(Math.abs(n.z) - Math.sin((angleDeg * Math.PI) / 180))).toBeLessThan(1e-5)
      }
      await engine.disposeAll()
    }, 60_000)
  }

  // BK-53 (GEO-5 ruling 3): the GEO-4-R1.1 z=5 mid-plane refusal now FLIPS to a
  // SUCCESS via translate-conjugation (translate the body so the requested plane
  // passes through the world origin, draft, translate back). Drafting all 4 side
  // faces about the MID plane z=D/2 leaves the volume near the box (the two
  // halves' first-order changes cancel) plus the exact second-order frustum term
  // V = W*H*D + t^2 * D^3 / 3 (integral of (W+2t*u)(H+2t*u) over u in [-D/2,D/2]).
  // This test FAILS against the pre-GEO-5 implementation, which refused it.
  it('#BK-53 a mid-height neutral plane (z=5) now SUCCEEDS with the frustum analytic (translate-conjugation)', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const angleDeg = 5
    const r = await engine.applyDraft({
      featureId: 'F2',
      body: box.body!,
      faces: SIDE_IDS,
      neutralPlane: { origin: { x: 0, y: 0, z: D / 2 }, normal: { x: 0, y: 0, z: 1 } },
      pullDir: { x: 0, y: 0, z: -1 },
      angleDeg,
    })
    expect(r.ok).toBe(true)
    const dm = r.elementMap!
    // direct edit -> ids persist, no new faces / deletions.
    expect(dm.generated).toEqual([])
    expect(dm.deleted).toEqual([])
    for (const id of SIDE_IDS) expect(dm.geometry![id]).toBeDefined()

    const t = Math.tan((angleDeg * Math.PI) / 180)
    const analytic = W * H * D + (t * t * D * D * D) / 3
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - analytic) / analytic).toBeLessThan(1e-6)

    for (const id of SIDE_IDS) {
      expect(await engine.classifyFace(r.body!, id)).toBe('plane')
      const n = dm.geometry![id].normal!
      expect(Math.abs(Math.abs(n.z) - Math.sin((angleDeg * Math.PI) / 180))).toBeLessThan(1e-5)
    }
    await engine.disposeAll()
  }, 60_000)

  // BK-53: a neutral plane whose normal is NOT (anti)parallel to the pull
  // direction remains a structured refusal (the wrapper limit — a tilted neutral
  // surface needs a lower-level kernel API occt-wasm 3.6.1 does not expose).
  it('#BK-53 a neutral plane whose normal is NOT parallel to the pull direction is still refused', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const volBefore = (await engine.measure(box.body!, 'volume')).value
    const r = await engine.applyDraft({
      featureId: 'F2',
      body: box.body!,
      faces: ['F1:BOX:xMax'],
      neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 1 } }, // tilted 45deg vs pull -Z
      pullDir: { x: 0, y: 0, z: -1 },
      angleDeg: 5,
    })
    expect(r.ok).toBe(false)
    const diag = r.diagnostics[0]
    expect(diag.code).toBe('DRAFT_FAILED')
    const message = String(diag.params!.reason)
    expect(message).toContain('F1:BOX:xMax')
    expect(message).toContain('parallel')
    expect(message.toLowerCase()).not.toContain('webassembly')
    expect(message.toLowerCase()).not.toContain('[object')
    const volAfter = (await engine.measure(box.body!, 'volume')).value
    expect(volAfter).toBe(volBefore)
    await engine.disposeAll()
  }, 60_000)

  // GEO-4-R1.1: the matching case still proceeds -- a neutral plane through the
  // world origin whose normal is (anti)parallel to the pull direction coincides
  // with what the kernel implies, so it drafts normally.
  it('#R1.1 a neutral plane that COINCIDES with the kernel plane (through origin, normal || pull) proceeds', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const r = await engine.applyDraft({
      featureId: 'F2',
      body: box.body!,
      faces: ['F1:BOX:xMax'],
      // origin anywhere ON the z=0 plane (x/y free), normal antiparallel to pull.
      neutralPlane: { origin: { x: 17, y: -3, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      pullDir: { x: 0, y: 0, z: -1 },
      angleDeg: 5,
    })
    expect(r.ok).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('#GEO18 X and Y pull directions succeed through rigid frame conjugation', async () => {
    const cases = [
      {
        featureId: 'FX',
        faces: ['F1:BOX:yMin', 'F1:BOX:yMax', 'F1:BOX:zMin', 'F1:BOX:zMax'],
        direction: { x: 1, y: 0, z: 0 },
      },
      {
        featureId: 'FY',
        faces: ['F1:BOX:xMin', 'F1:BOX:xMax', 'F1:BOX:zMin', 'F1:BOX:zMax'],
        direction: { x: 0, y: 1, z: 0 },
      },
    ] as const

    for (const testCase of cases) {
      const box = await engine.makeBox('F1', { x: W, y: H, z: D })
      const r = await engine.applyDraft({
        featureId: testCase.featureId,
        body: box.body!,
        faces: [...testCase.faces],
        neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: testCase.direction },
        pullDir: testCase.direction,
        angleDeg: 5,
      })
      expect(r.ok, String(r.diagnostics[0]?.params?.reason ?? '')).toBe(true)
      expect((await engine.measure(r.body!, 'volume')).value).toBeGreaterThan(0)
      for (const id of testCase.faces) expect(r.elementMap?.geometry?.[id]).toBeDefined()
      await engine.disposeAll()
    }
  }, 60_000)

  // WO UI-16 first exposed +Z and offset. GEO-18's rotation-conjugation above
  // now extends the same kernel path to X/Y and arbitrary face normals.
  it('#UI16-C2 a non-default pull direction the OLD dialog could never emit (+Z, flipped, WITH a plane offset) succeeds', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const r = await engine.applyDraft({
      featureId: 'F2',
      body: box.body!,
      faces: SIDE_IDS,
      neutralPlane: { origin: { x: 0, y: 0, z: 3 }, normal: { x: 0, y: 0, z: 1 } },
      pullDir: { x: 0, y: 0, z: 1 },
      angleDeg: 5,
    })
    expect(r.ok).toBe(true)
    const dm = r.elementMap!
    expect(dm.generated).toEqual([])
    expect(dm.deleted).toEqual([])
    for (const id of SIDE_IDS) {
      expect(dm.geometry![id]).toBeDefined()
      expect(await engine.classifyFace(r.body!, id)).toBe('plane')
    }
    await engine.disposeAll()
  }, 60_000)

  it('#5 DETERMINISM golden: two runs produce byte-identical geometry for every id', async () => {
    const mk = async () => {
      const box = await engine.makeBox('F1', { x: W, y: H, z: D })
      return engine.applyDraft({
        featureId: 'F2',
        body: box.body!,
        faces: SIDE_IDS,
        neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
        pullDir: { x: 0, y: 0, z: -1 },
        angleDeg: 5,
      })
    }
    const a = await mk()
    const b = await mk()
    for (const id of SIDE_IDS) {
      expect(a.elementMap!.geometry![id].centroid).toEqual(b.elementMap!.geometry![id].centroid)
      expect(a.elementMap!.geometry![id].normal).toEqual(b.elementMap!.geometry![id].normal)
    }
    await engine.disposeAll()
  }, 60_000)

  it('DIAGNOSTICS: an impossible draft angle -> DRAFT_FAILED naming the face + angle, no raw kernel text, body unchanged', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const volBefore = (await engine.measure(box.body!, 'volume')).value

    const r = await engine.applyDraft({
      featureId: 'F2',
      body: box.body!,
      faces: ['F1:BOX:xMax'],
      neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      pullDir: { x: 0, y: 0, z: -1 },
      angleDeg: 95,
    })
    expect(r.ok).toBe(false)
    const diag = r.diagnostics[0]
    expect(diag.code).toBe('DRAFT_FAILED')
    const message = String(diag.params!.reason)
    expect(message).toContain('F1:BOX:xMax')
    expect(message).toContain('95')
    expect(message.toLowerCase()).not.toContain('webassembly')

    const volAfter = (await engine.measure(box.body!, 'volume')).value
    expect(volAfter).toBe(volBefore)
    await engine.disposeAll()
  }, 60_000)

  it('#9 WASM-HANDLE LIFECYCLE: the impossible-angle error path leaks no kernel handles', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const baseline = engine.debugKernelShapeCount()
    const r = await engine.applyDraft({
      featureId: 'F2',
      body: box.body!,
      faces: ['F1:BOX:xMax'],
      neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      pullDir: { x: 0, y: 0, z: -1 },
      angleDeg: 95,
    })
    expect(r.ok).toBe(false)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
    await engine.disposeAll()
  }, 60_000)
})
