// WO-1892 — model faces keep their names through edits.
//
// The order's acceptance case: a block with a pocket; change the pocket's
// SKETCH DIMENSION so the pocket resizes. Every face that still exists must
// keep the id it had, so an operation Operator bound to the pocket floor is still
// bound to the pocket floor afterwards.
//
// What decides that is where the id comes from. A boolean's cavity walls used
// to be named by a GEOMETRIC guess: `#relabelWithToolLineage` matched each new
// result face to the nearest tool face centroid within 2% of the body diagonal.
// Resize the sketch and those centroids all move, so the guess can miss and the
// wall falls back to a positional `<fid>:CUT:new#k` name whose `k` depends on
// the sort order of the faces that happen to exist — exactly the silent
// rebind stable-id-spec §3 calls the one unforgivable failure mode.
//
// This order gives the kernel's own record the first say: the boolean now runs
// non-destructively (so a tool face hash taken before Build still names that
// face after it) and is asked about the tool's faces as well as the target's,
// and `#buildToolLineageFromHistory` turns that record into result-hash ->
// tool id. The geometric match stays as the fallback.
//
// Everything below drives the PRODUCTION path — GeomEngine.makeBox +
// GeomEngine.makeExtrude, the same engine the app's geom worker runs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, OpResult, ProfileRegion, StableId } from '../../geom/geom-service.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const BLOCK = { x: 60, y: 40, z: 20 }
const SKETCH = 'SK1'
const FEATURE = 'P1'
const DEPTH = 8

/** The pocket sketch: a rectangle on the block's top face whose far edge sits
 *  at `xFar`. Changing `xFar` IS the sketch dimension change. */
function pocketProfile(xFar: number): ProfileRegion {
  return { sketchId: SKETCH, plane: xyPlane(BLOCK.z), loops: [rectLoop(SKETCH, 10, 10, xFar, 30)] }
}

/** Build the block and cut the pocket, from scratch, the way a rebuild does. */
async function buildPocketedBlock(engine: GeomEngine, xFar: number): Promise<OpResult> {
  const block = (await engine.makeBox('B1', BLOCK)).body!
  const r = await engine.makeExtrude({
    featureId: FEATURE,
    profiles: [pocketProfile(xFar)],
    end: { kind: 'blind', distance: -DEPTH },
    op: 'cut',
    target: block,
  })
  expect(r.ok).toBe(true)
  return r
}

/** Every id the pocket cut produced, with its post-op centroid. */
function pocketFaces(r: OpResult): Map<StableId, [number, number, number]> {
  const g = r.elementMap!.geometry!
  const out = new Map<StableId, [number, number, number]>()
  for (const id of r.elementMap!.generated) {
    const s = g[id]
    if (s) out.set(id, [s.centroid.x, s.centroid.y, s.centroid.z])
  }
  return out
}

/** The pocket FLOOR: the one generated face whose centroid sits at the pocket
 *  bottom (z = block height - depth). Found by geometry, never by id, so the
 *  test cannot pass by agreeing with whatever the engine happened to name it. */
function floorIdOf(faces: Map<StableId, [number, number, number]>): StableId {
  const z = BLOCK.z - DEPTH
  const hits = [...faces].filter(([, c]) => Math.abs(c[2] - z) < 1e-6)
  expect(hits.length, `exactly one generated face at the pocket floor z=${z}`).toBe(1)
  return hits[0][0]
}

/** The four pocket WALLS: generated faces spanning the pocket depth. */
function wallIdsOf(faces: Map<StableId, [number, number, number]>): StableId[] {
  const zMid = BLOCK.z - DEPTH / 2
  return [...faces].filter(([, c]) => Math.abs(c[2] - zMid) < 1e-6).map(([id]) => id).sort()
}

describe('WO-1892 kernel-history face naming (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#1 the pocket floor and walls are named from the sketch, not from a position', async () => {
    const r = await buildPocketedBlock(engine, 40)
    const faces = pocketFaces(r)

    const floor = floorIdOf(faces)
    const walls = wallIdsOf(faces)
    expect(walls.length, 'four pocket walls').toBe(4)

    // Every wall carries the sketch segment that drew it. A `:CUT:new#k` name
    // here is the positional fallback and is what this order exists to remove.
    for (const w of walls) {
      expect(w, `wall ${w} names its sketch segment`).toMatch(
        new RegExp(`^${FEATURE}:XTR:${SKETCH}\\.e[0-3]:side$`),
      )
    }
    expect([...walls].sort()).toEqual([
      `${FEATURE}:XTR:${SKETCH}.e0:side`,
      `${FEATURE}:XTR:${SKETCH}.e1:side`,
      `${FEATURE}:XTR:${SKETCH}.e2:side`,
      `${FEATURE}:XTR:${SKETCH}.e3:side`,
    ])
    // The floor is the tool prism's far cap, named from the sketch too.
    expect(floor).toMatch(new RegExp(`^${FEATURE}:XTR:${SKETCH}:cap(Start|End)$`))

    // ...and the KERNEL's record is what named them. Without this the test
    // would pass on the old geometric guess too, and prove nothing about where
    // the id came from. `unmatched` is the positional `:CUT:new#k` fallback.
    const census = engine.debugToolLineageCensus()
    expect(census.history, JSON.stringify(census)).toBeGreaterThan(0)
    expect(census.unmatched, JSON.stringify(census)).toBe(0)

    await engine.disposeAll()
  }, 60_000)

  it('#2 resizing the pocket sketch keeps every surviving face id', async () => {
    const narrow = await buildPocketedBlock(engine, 40)
    const narrowFaces = pocketFaces(narrow)
    const narrowFloor = floorIdOf(narrowFaces)
    const narrowWalls = wallIdsOf(narrowFaces)
    await engine.disposeAll()

    // The ONLY change: the sketch rectangle's far edge moves 40 -> 50.
    const wide = await buildPocketedBlock(engine, 50)
    const wideFaces = pocketFaces(wide)
    const wideFloor = floorIdOf(wideFaces)
    const wideWalls = wallIdsOf(wideFaces)

    // The pocket really did resize (otherwise this test proves nothing).
    const narrowFloorC = narrowFaces.get(narrowFloor)!
    const wideFloorC = wideFaces.get(wideFloor)!
    expect(wideFloorC[0]).toBeGreaterThan(narrowFloorC[0])

    // ...and every face that still exists kept its name.
    expect(wideFloor).toBe(narrowFloor)
    expect(wideWalls).toEqual(narrowWalls)

    await engine.disposeAll()
  }, 60_000)

  it('#3 a blind pocket binds its walls from the kernel record, not a centroid guess', async () => {
    // A BLIND pocket is where the geometric fallback is weakest: the tool wall
    // runs the full prism height while the result wall is only the part inside
    // the block, so the two centroids are a whole half-depth apart. Deepen the
    // pocket and that gap grows; the ids must not care.
    const shallow = await engine.makeBox('B1', BLOCK)
    const r1 = await engine.makeExtrude({
      featureId: FEATURE,
      profiles: [pocketProfile(40)],
      end: { kind: 'blind', distance: -2 },
      op: 'cut',
      target: shallow.body!,
    })
    expect(r1.ok).toBe(true)
    const shallowWalls = [...pocketFaces(r1).keys()]
      .filter((id) => id.includes(`:XTR:${SKETCH}.`))
      .sort()
    await engine.disposeAll()

    const deep = await engine.makeBox('B1', BLOCK)
    const r2 = await engine.makeExtrude({
      featureId: FEATURE,
      profiles: [pocketProfile(40)],
      end: { kind: 'blind', distance: -16 },
      op: 'cut',
      target: deep.body!,
    })
    expect(r2.ok).toBe(true)
    const deepWalls = [...pocketFaces(r2).keys()]
      .filter((id) => id.includes(`:XTR:${SKETCH}.`))
      .sort()

    expect(shallowWalls.length).toBe(4)
    expect(deepWalls).toEqual(shallowWalls)

    await engine.disposeAll()
  }, 60_000)

  it('#4 an operation bound to the pocket floor is still bound after the resize', async () => {
    const narrow = await buildPocketedBlock(engine, 40)
    const floor = floorIdOf(pocketFaces(narrow))
    // What a contour operation stores: the face id, nothing else.
    const bound: StableId[] = [floor]
    await engine.disposeAll()

    const wide = await buildPocketedBlock(engine, 50)
    const body: BodyHandle = wide.body!
    const [res] = await engine.resolve(body, bound)
    expect(res.status, `operation bound to ${floor} after the sketch resize`).not.toBe('lost')

    await engine.disposeAll()
  }, 60_000)
})


// The fused-cylinder seam, picked by the name the kernel record gives it. Two
// overlapping cylinders fused (edge-id-collision.test.ts's body): the second
// cylinder's side used to be `UC2:FUS:new#0` / `new#3` because the centroid
// match refused it; it is now `UC2:XTR:US2.c0:side#0` / `#1`. A fillet on the
// seam by that name must work. The old positional name is gone, and under
// ADR-0040 (no legacy before 1.0) a stale pick of it fails loud with
// REFERENCE_UNRESOLVED - never a silent bind to some other edge.
function circleProfile(sketchId: string, cx: number): ProfileRegion {
  return {
    sketchId,
    plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
    loops: [[{ kind: 'arc', c: [cx, 0], r: 10, a0: 0, a1: Math.PI * 2, ccw: true, srcId: `${sketchId}.c0` }]],
  }
}

async function fusedCylinders(engine: GeomEngine): Promise<BodyHandle> {
  const c1 = await engine.makeExtrude({ featureId: 'UC1', profile: circleProfile('US1', 0), end: { kind: 'blind', distance: 20 }, op: 'newBody' })
  expect(c1.ok).toBe(true)
  const fused = await engine.makeExtrude({ featureId: 'UC2', profile: circleProfile('US2', 12), end: { kind: 'blind', distance: 20 }, op: 'add', target: c1.body! })
  expect(fused.ok).toBe(true)
  return fused.body!
}

describe('WO-1892 a fillet on a boolean-created seam, by its kernel-record name', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#5 the seam `UC2:XTR:US2.c0:side#0` fillets; the retired `UC2:FUS:new#0` fails loud', async () => {
    const OLD = '(UC1:XTR:US1.c0:side∧UC2:FUS:new#0)' as StableId
    const NEW = '(UC1:XTR:US1.c0:side∧UC2:XTR:US2.c0:side#0)' as StableId

    const body = await fusedCylinders(engine)
    const ids = (await engine.tessellate(body, { deflection: 0.1 })).edgeIds
    expect(ids).toContain(NEW)
    expect(ids).not.toContain(OLD)
    const viaNew = await engine.applyFillet({ featureId: 'SFIL', body, edges: [NEW], radius: 0.5, propagateTangent: true })
    expect(viaNew.ok, JSON.stringify(viaNew.diagnostics)).toBe(true)
    const volBefore = (await engine.measure(body, 'volume')).value
    const volAfter = (await engine.measure(viaNew.body!, 'volume')).value
    expect(volAfter).not.toBeCloseTo(volBefore, 6)

    const viaOld = await engine.applyFillet({ featureId: 'SFIL2', body, edges: [OLD], radius: 0.5, propagateTangent: true })
    expect(viaOld.ok).toBe(false)
    expect(viaOld.diagnostics.map((d) => d.code)).toContain('REFERENCE_UNRESOLVED')
    await engine.disposeAll()
  }, 60_000)
})
