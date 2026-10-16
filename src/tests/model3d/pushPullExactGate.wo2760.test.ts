// @vitest-environment jsdom
//
// WO-2760: Push/Pull stops making wrong geometry next to blends, and accepts
// the correct dome result. The WO-2757 audit cells, through the production
// route: the real Model screen (SolidsWorkbenchPage) on the real in-process
// kernel, the part imported through the screen's own Import input, the face
// picked by a viewport ray, the Push/Pull button, the typed value, preview,
// Apply. The kernel is read only to measure a result.
//
// - PP-1 (the owner's dome-on-plate top +3 mm) applies, at the audit's volume.
// - WO-2767: PP-2/4/8/11/12 carry the neighbouring blend/cone/draft,
//   checked at the landed order's hand volumes and geometric guards.
// - PP-3/5/9/10 (square neighbours) still apply at the audit's volumes.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import type { BodyHandle, StableId } from '../../geom/geom-service'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

const { stepCache } = vi.hoisted(() => ({ stepCache: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => stepCache.get(id) ?? null,
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))

// jsdom's localStorage is broken under Vitest's node launch flags (same shim
// directEditAudit.wo2757.test.ts installs before importing the page).
const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { useCamStore } = await import('../../store')

// The WO-2757 audit parts (generate_parts.py), copied here so this file
// stands alone; the dome, drafted wall and tapered boss are test_fixtures.
const part = (name: string) => resolve(process.cwd(), 'src/tests/evidence/WO-2760', name)
const fixture = (name: string) => resolve(process.cwd(), 'test_fixtures/brep', name)

type V3 = { x: number; y: number; z: number }
interface FaceInfo { id: StableId; type: string; centroid: V3; normal: V3; min: V3; max: V3; aim: { point: V3; normal: V3 } }
type Outcome =
  | { kind: 'applied'; id: string; volumeDelta: number }
  | { kind: 'refused'; stage: string; message: string }

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  stepCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}
const canvas = () => screen.getByTestId('solids-workbench-canvas')

function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

interface StepSession { runtime: FakeSceneRuntime; volume: number }

/** Mount the Model screen on the real kernel and import `path` through the
 *  screen's own Import input. */
async function openStep(path: string): Promise<StepSession> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  const name = path.split(/[\\/]/).pop()!
  fireEvent.change(input, { target: { files: [new File([bytesOf(path)], name, { type: 'application/octet-stream' })] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
  return { runtime, volume: await volumeOf('IMP1') }
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

/** Every face of a live body: kernel surface class, area-weighted centroid
 *  and normal, bounds, and its largest triangle to aim a ray at. */
async function facesOf(featureId: string): Promise<FaceInfo[]> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const mesh = await hooks().client.tessellate(h, { deflection: 0.05 })
  const acc = mesh.faceIds.map(() => ({ a: 0, c: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 0 }, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity }, best: -1, bestA: 0 }))
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  const tri = (t: number) => {
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    return { a, b, c, cr: { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x } }
  }
  for (let t = 0; t < mesh.triFace.length; t++) {
    const f = acc[mesh.triFace[t]]
    const { a, b, c, cr } = tri(t)
    const area = Math.hypot(cr.x, cr.y, cr.z) / 2
    f.a += area
    for (const k of ['x', 'y', 'z'] as const) {
      f.c[k] += area * (a[k] + b[k] + c[k]) / 3
      f.n[k] += cr[k] / 2
      f.min[k] = Math.min(f.min[k], a[k], b[k], c[k])
      f.max[k] = Math.max(f.max[k], a[k], b[k], c[k])
    }
    if (area > f.bestA) { f.bestA = area; f.best = t }
  }
  const out: FaceInfo[] = []
  for (let i = 0; i < mesh.faceIds.length; i++) {
    const f = acc[i]
    if (f.best < 0) continue
    const { a, b, c, cr } = tri(f.best)
    const cl = Math.hypot(cr.x, cr.y, cr.z)
    const nl = Math.hypot(f.n.x, f.n.y, f.n.z) || 1
    out.push({
      id: mesh.faceIds[i],
      type: await hooks().client.classifyFace(h, mesh.faceIds[i]),
      centroid: { x: f.c.x / f.a, y: f.c.y / f.a, z: f.c.z / f.a },
      normal: { x: f.n.x / nl, y: f.n.y / nl, z: f.n.z / nl },
      min: f.min, max: f.max,
      aim: { point: { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 }, normal: { x: cr.x / cl, y: cr.y / cl, z: cr.z / cl } },
    })
  }
  return out
}

function findFace(faces: FaceInfo[], label: string, test: (f: FaceInfo) => boolean): FaceInfo {
  const hit = faces.find(test)
  if (hit === undefined) throw new Error(`no face matches ${label}: ${JSON.stringify(faces.map((f) => [f.type, f.centroid, f.normal]))}`)
  return hit
}

/** Aim the viewport ray straight down a face's own outward normal. */
function aimAtFace(runtime: FakeSceneRuntime, f: FaceInfo): void {
  const { point, normal } = f.aim
  runtime.rayOverride = {
    origin: { x: point.x + normal.x * 0.5, y: point.y + normal.y * 0.5, z: point.z + normal.z * 0.5 },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

/** Push/Pull through the Model screen: button, pick, typed value, Enter
 *  previews, Enter applies. */
async function pushPull(s: StepSession, face: FaceInfo, delta: number): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  aimAtFace(s.runtime, face)
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
  const hint = () => screen.queryByTestId('solids-workbench-pushpull-hint')
  const refused = () => hint()?.className.includes('refusal') === true
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') !== null || refused()).toBe(true), { timeout: 30_000 })
  if (refused()) return { kind: 'refused', stage: 'pick', message: hint()?.textContent ?? '' }
  const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
  fireEvent.change(input, { target: { value: String(delta) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => {
    const g = hooks().getPushPullTransactionState().gesture
    expect(!g.inFlight && (g.previewHandle !== null || refused())).toBe(true)
  }, { timeout: 60_000 })
  if (refused()) {
    const message = hint()?.textContent ?? ''
    fireEvent.click(screen.getByTestId('workbench-cancel-pushpull'))
    return { kind: 'refused', stage: 'preview', message }
  }
  fireEvent.keyDown(screen.getByTestId('pushpull-delta-entry-input'), { key: 'Enter' })
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') === null || refused()).toBe(true), { timeout: 60_000 })
  if (refused()) return { kind: 'refused', stage: 'apply', message: hint()?.textContent ?? '' }
  let id: string | undefined
  await waitFor(() => {
    id = hooks().dag.featureOrder().find((f) => !before.includes(f))
    expect(id).toBeDefined()
    expect(hooks().scheduler.statusOf(id!), JSON.stringify(hooks().scheduler.diagnosticsOf(id!))).toBe('ok')
    expect(hooks().getBodyHandle(id!)).not.toBeUndefined()
  }, { timeout: 60_000 })
  return { kind: 'applied', id: id!, volumeDelta: (await volumeOf(id!)) - s.volume }
}

/** Applied, with the volume change the audit's hand formula gives. */
async function expectApplied(o: Outcome, expectedDelta: number): Promise<string> {
  expect(o, JSON.stringify(o)).toMatchObject({ kind: 'applied' })
  if (o.kind !== 'applied') throw new Error('unreachable')
  expect(Math.abs(o.volumeDelta - expectedDelta), `volume changed by ${o.volumeDelta}, expected ${expectedDelta}`)
    .toBeLessThan(Math.max(0.002 * Math.abs(expectedDelta), 0.05))
  return o.id
}

async function chainsOf(featureId: string, kind: 'fillet' | 'chamfer', size: number) {
  const word = kind === 'fillet' ? 'radius' : 'distance'
  const all = await hooks().client.recognizeFeatures(hooks().getBodyHandle(featureId) as BodyHandle)
  return all.filter(v => v.featureKey.startsWith(`chain:${kind}:`) && Math.abs(Number(v.params[word]) - size) < 1e-3)
}

const PI = Math.PI
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol
const at = (f: FaceInfo, x: number, y: number, r = 1) => Math.hypot(f.centroid.x - x, f.centroid.y - y) < r
const upPlanes = (faces: FaceInfo[]) => faces.filter(f => f.type === 'plane' && f.normal.z > 0.99)
const flatUp = (f: FaceInfo, z: number) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, z)

describe('WO-2760 Push/Pull: the dome-on-plate move the owner hit is accepted', () => {
  it('PP-1 dome-on-plate: plate top +3 mm applies at 40x40x3 less the dome slab already there, and the raised top meets the dome', async () => {
    const s = await openStep(fixture('fix_freeform.step'))
    const top = findFace(await facesOf('IMP1'), 'plate top', (f) => flatUp(f, 10))
    // Block 40x40x10 + sphere r12 centred (20,20,12). The raised block fills
    // z 10..13 except what the dome already fills there:
    // pi x integral of (144 - (z-12)^2) over z 10..13 = pi x 429.
    const id = await expectApplied(await pushPull(s, top, 3), 40 * 40 * 3 - PI * 429)
    const faces = await facesOf(id)
    // Face check: the new top is one plane at z 13 whose inner rim is the
    // dome at z 13 (r sqrt(144 - 1)); no straight prism wall is left round it.
    const newTop = findFace(faces, 'raised top', (f) => flatUp(f, 13))
    expect(newTop.max.x - newTop.min.x).toBeCloseTo(40, 3)
    expect(faces.filter((f) => f.type === 'cylinder')).toEqual([])
    const dome = findFace(faces, 'dome', (f) => f.type === 'sphere')
    expect(dome.min.z).toBeCloseTo(13, 2)
    expect(faces.filter((f) => f.type === 'plane' && f.max.z > 13 + 1e-3)).toEqual([])
  }, 180_000)

  // Audit round 1 (astra): the sphere is back to the plate-top rim radius
  // sqrt(140) at z 14 and narrows above it, so a pull past +4 mm must not keep
  // the straight prism wall between z 14 and the new top - that is a ring
  // groove round the dome. Either the raised top meets the dome at its new
  // level, or the move refuses at preview and the part is unchanged.
  for (const delta of [4.2, 4.05]) {
    it(`PP-1 dome-on-plate: plate top +${delta} mm never leaves a ring groove round the dome`, async () => {
      const s = await openStep(fixture('fix_freeform.step'))
      const top = findFace(await facesOf('IMP1'), 'plate top', (f) => flatUp(f, 10))
      const before = hooks().dag.featureOrder()
      const o = await pushPull(s, top, delta)
      if (o.kind === 'applied') {
        const faces = await facesOf(o.id)
        expect(faces.filter((f) => f.type === 'cylinder'), 'a straight prism wall left round the dome is a groove').toEqual([])
        expect(findFace(faces, 'dome', (f) => f.type === 'sphere').min.z).toBeCloseTo(10 + delta, 2)
        return
      }
      expect(o, JSON.stringify(o)).toMatchObject({ kind: 'refused', stage: 'preview' })
      expect(o.message).toMatch(/Push\/Pull can't move this face .*: it meets a sphere/)
      expect(o.message).toMatch(/Nothing was changed\./)
      expect(o.message).not.toMatch(/faceOffset|out-of-class|IMP1/)
      await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull(), { timeout: 30_000 })
      expect(hooks().dag.featureOrder()).toEqual(before)
      expect(await volumeOf('IMP1')).toBeCloseTo(s.volume, 6)
    }, 180_000)
  }
})

// WO-2767 deliberately replaces WO-2760's refusals with carried blends.
describe('WO-2767 Push/Pull carries fillets, cones and drafts with the face (Model screen, real kernel)', () => {
  it('PP-2 plate top +3 mm beside the r3 filleted boss: the fillet rides up with the plate top, no moat', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const top = findFace(await facesOf('IMP1'), 'plate top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 10))
    const outcome = await pushPull(s, top, 3)
    // the plate grows 3 mm; the boss's own d20 core already fills its share
    const id = await expectApplied(outcome, 3 * (3600 - 100 * PI))
    const faces = await facesOf(id)
    // the r3 foot fillet is back, one chain, sitting on the new plate top
    expect(await chainsOf(id, 'fillet', 3)).toHaveLength(1)
    const torus = faces.filter((f) => f.type === 'torus')
    expect(torus).toHaveLength(1)
    expect(torus[0].min.z).toBeCloseTo(13, 2)
    expect(torus[0].max.z).toBeCloseTo(16, 2)
    // no moat: nothing curved reaches below the new plate top, and the plate
    // top is one face at z 13
    expect(faces.filter((f) => f.type !== 'plane' && f.min.z < 13 - 1e-3)).toHaveLength(0)
    expect(upPlanes(faces).map((f) => Number(f.centroid.z.toFixed(3))).sort()).toEqual([13, 22])
  }, 180_000)

  it('PP-4 top +2 mm inside the r2 fillet chain: the whole chain rides up, no plateau', async () => {
    const s = await openStep(part('fillet_chain.step'))
    const top = findFace(await facesOf('IMP1'), 'top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 20))
    const outcome = await pushPull(s, top, 2)
    // the part gets 2 mm taller over its whole r6-cornered 60 x 40 section
    const id = await expectApplied(outcome, 2 * (2400 - (4 - PI) * 36))
    const chains = await chainsOf(id, 'fillet', 2)
    expect(chains).toHaveLength(1)
    expect(chains[0].faceIds).toHaveLength(8)
    const faces = await facesOf(id)
    // one top, at the new height; the chain runs from z 20 to z 22
    expect(upPlanes(faces).map((f) => Number(f.centroid.z.toFixed(3)))).toEqual([22])
    const tori = faces.filter((f) => f.type === 'torus')
    expect(tori).toHaveLength(4)
    for (const t of tori) {
      expect(t.min.z).toBeCloseTo(20, 2)
      expect(t.max.z).toBeCloseTo(22, 2)
    }
  }, 180_000)

  it('PP-8 pocket floor -2 mm inside the r2 floor fillets: the fillets go down with the floor, no narrow well', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const floor = findFace(await facesOf('IMP1'), 'pocket floor', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 12))
    const outcome = await pushPull(s, floor, -2)
    // the whole r5-cornered 30 x 20 pocket deepens 2 mm
    const id = await expectApplied(outcome, -2 * (600 - (4 - PI) * 25))
    const chains = await chainsOf(id, 'fillet', 2)
    expect(chains).toHaveLength(1)
    expect(chains[0].faceIds).toHaveLength(8)
    const faces = await facesOf(id)
    // the floor at z 10, the deck at z 20, nothing left at the old floor
    expect(upPlanes(faces).map((f) => Number(f.centroid.z.toFixed(3))).sort()).toEqual([10, 20])
    // every floor fillet sits between the new floor and 2 mm above it (the
    // pocket's r5 corner rounds stand straight up: normal z 0)
    const blends = faces.filter((f) => f.type === 'torus' || (f.type === 'cylinder' && Math.abs(f.normal.z) > 0.3))
    expect(blends).toHaveLength(8)
    for (const b of blends) {
      expect(b.min.z).toBeCloseTo(10, 2)
      expect(b.max.z).toBeCloseTo(12, 2)
    }
  }, 180_000)

  it('PP-11 15 deg drafted pocket wall +1 mm: the wall moves, deck and floor re-trim, no lip and no notch', async () => {
    const s = await openStep(fixture('fix_feature_block.step'))
    const isWall = (f: FaceInfo) => f.type === 'plane' && Math.abs(f.normal.z) > 0.2 && Math.abs(f.normal.z) < 0.5 && f.max.x < 35
    const wall = findFace(await facesOf('IMP1'), 'drafted wall', isWall)
    const outcome = await pushPull(s, wall, 1)
    // the slab between the old and new wall planes, floor z 8 to deck z 20,
    // y 8..32: 12 mm high and 1/cos 15 deg across = wall area x 1
    const slant = 12 / Math.cos(15 * PI / 180)
    const id = await expectApplied(outcome, slant * 24 * 1)
    const faces = await facesOf(id)
    // no lip: nothing stands above the deck between the wall and the cap
    expect(faces.filter((f) => f.max.z > 20.05 && f.max.z < 21 && f.min.x > 26 && f.max.x < 33)).toHaveLength(0)
    // the moved wall still runs from the floor to the deck, 1/cos 15 deg
    // nearer the open side (x 28 - 1.035 at the floor), and it is the only
    // drafted face (no notch face at the floor)
    const walls = faces.filter(isWall)
    expect(walls).toHaveLength(1)
    expect(walls[0].min.z).toBeCloseTo(8, 2)
    expect(walls[0].max.z).toBeCloseTo(20, 2)
    expect(walls[0].min.x).toBeCloseTo(28 - 1 / Math.cos(15 * PI / 180), 2)
  }, 180_000)

  it('PP-12 base top +2 mm round the tapered (cone) boss: the base meets the cone, no wedge groove', async () => {
    const s = await openStep(fixture('fix_boss_taper.step'))
    const top = findFace(await facesOf('IMP1'), 'base top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 10))
    const outcome = await pushPull(s, top, 2)
    // the block grows to z 12 and buries the cone's lowest 2 mm (r 15 -> 14)
    const id = await expectApplied(outcome, 3600 * 2 - PI * 2 / 3 * (15 ** 2 + 15 * 14 + 14 ** 2))
    const faces = await facesOf(id)
    // the cone now starts at the new base top (r 14 at z 12); no other
    // curved face, so no groove wall round its foot
    const curved = faces.filter((f) => f.type !== 'plane')
    expect(curved.map((f) => f.type)).toEqual(['cone'])
    expect(curved[0].min.z).toBeCloseTo(12, 2)
    expect(curved[0].max.x - curved[0].min.x).toBeCloseTo(28, 1)
    expect(upPlanes(faces).map((f) => Number(f.centroid.z.toFixed(3))).sort()).toEqual([12, 22])
  }, 180_000)
})

describe('WO-2760 Push/Pull: square neighbours still work', () => {
  it('PP-3 boss top +2 mm = pi x 10^2 x 2', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const top = findFace(await facesOf('IMP1'), 'boss top', (f) => flatUp(f, 22))
    await expectApplied(await pushPull(s, top, 2), 2 * 100 * PI)
  }, 180_000)

  it('PP-5 counterbore floor -2 mm = -annulus (r 5.5 / 3.3) x 2', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const floor = findFace(await facesOf('IMP1'), 'cbore floor', (f) => flatUp(f, 8.5) && at(f, 15, 20))
    await expectApplied(await pushPull(s, floor, -2), -2 * PI * (5.5 ** 2 - 3.3 ** 2))
  }, 180_000)

  it('PP-9 rib side +1 mm = 50 x 15 x 1', async () => {
    const s = await openStep(part('rib_part.step'))
    const side = findFace(await facesOf('IMP1'), 'rib side', (f) => f.type === 'plane' && f.normal.y < -0.99 && near(f.centroid.y, 8))
    await expectApplied(await pushPull(s, side, 1), 50 * 15)
  }, 180_000)

  it('PP-10 rib top +2 mm = 50 x 3 x 2', async () => {
    const s = await openStep(part('rib_part.step'))
    const top = findFace(await facesOf('IMP1'), 'rib top', (f) => flatUp(f, 20) && f.max.y < 12)
    await expectApplied(await pushPull(s, top, 2), 50 * 3 * 2)
  }, 180_000)
})
