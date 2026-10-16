// @vitest-environment jsdom
// WO-2856: Push/Pull on an imported STEP part applies (feature row, volume
// change, Undo) or says in one line why it cannot -- never a silent no-op.

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

const { stepCache, stlCache } = vi.hoisted(() => ({
  stepCache: new Map<string, ArrayBuffer>(),
  stlCache: new Map<string, ArrayBuffer>(),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => stepCache.get(id) ?? null,
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id, bytes) => { stlCache.set(id, bytes) },
  loadCachedSTL: async (id) => stlCache.get(id) ?? null,
  removeCachedSTL: async (id) => { stlCache.delete(id) },
}))

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

const PART = resolve(process.cwd(), 'Sample Parts/Step Test With Holes.step')
type V3 = { x: number; y: number; z: number }
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear(); stepCache.clear(); stlCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
})
afterEach(() => { cleanup(); restoreCanvas2d?.(); restoreCanvas2d = null })

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

async function openStep(): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([bytesOf(PART)], 'Step Test With Holes.step', { type: 'application/octet-stream' })] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
  return runtime
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

interface TopFace { id: StableId; point: V3; area: number; z: number }
/** The topmost planar face whose normal points +Z, and a point on it. */
async function topFace(featureId: string): Promise<TopFace> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const mesh = await hooks().client.tessellate(h, { deflection: 0.05 })
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  const faces = new Map<number, { area: number; z: number; best: V3; bestA: number }>()
  for (let t = 0; t < mesh.triFace.length; t++) {
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    const nz = u.x * v.y - u.y * v.x
    const area = Math.hypot(u.y * v.z - u.z * v.y, u.z * v.x - u.x * v.z, nz) / 2
    if (area < 1e-9 || nz / (2 * area) < 0.999) continue
    const f = faces.get(mesh.triFace[t]) ?? { area: 0, z: a.z, best: a, bestA: 0 }
    f.area += area
    if (area > f.bestA) { f.bestA = area; f.best = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 } }
    faces.set(mesh.triFace[t], f)
  }
  let top: TopFace | null = null
  for (const [i, f] of faces) {
    if (top === null || f.z > top.z + 1e-6 || (Math.abs(f.z - top.z) < 1e-6 && f.area > top.area)) top = { id: mesh.faceIds[i], point: f.best, area: f.area, z: f.z }
  }
  if (top === null) throw new Error('no +Z planar face')
  return top
}


/** The body's cross-section area on the plane z = h, from its tessellation
 *  (Green's theorem over the cut segments, each oriented by its triangle's
 *  outward normal so holes subtract). Independent of how the edit was built. */
async function sectionArea(featureId: string, h: number): Promise<number> {
  const mesh = await hooks().client.tessellate(hooks().getBodyHandle(featureId) as BodyHandle, { deflection: 0.01 })
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  let area = 0
  for (let t = 0; t < mesh.index.length / 3; t++) {
    const v = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const cuts: Array<{ x: number; y: number }> = []
    for (let j = 0; j < 3; j++) {
      const a = v[j], b = v[(j + 1) % 3]
      if ((a.z < h) === (b.z < h)) continue
      const s = (h - a.z) / (b.z - a.z)
      cuts.push({ x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y) })
    }
    if (cuts.length !== 2) continue
    const u = { x: v[1].x - v[0].x, y: v[1].y - v[0].y, z: v[1].z - v[0].z }
    const w = { x: v[2].x - v[0].x, y: v[2].y - v[0].y, z: v[2].z - v[0].z }
    const nx = u.y * w.z - u.z * w.y, ny = u.z * w.x - u.x * w.z
    let [a, b] = cuts
    // material on the left of a -> b: the outward normal lies to its right
    if ((b.y - a.y) * nx - (b.x - a.x) * ny < 0) [a, b] = [b, a]
    area += (a.x * b.y - b.x * a.y) / 2
  }
  return area
}

describe('WO-2856 Push/Pull on an imported STEP applies', () => {
  it('top face -2 mm through typed entry + Apply: a Push/Pull row, the part 2 mm thinner with its dressings carried, Undo restores', async () => {
    const runtime = await openStep()
    const startVolume = await volumeOf('IMP1')
    const face = await topFace('IMP1')
    // Below the countersinks and edge chamfers the part is a straight prism:
    // its section there is what a 2 mm push takes out.
    const section = await sectionArea('IMP1', face.z - 2.5)
    expect(await sectionArea('IMP1', face.z - 3.5)).toBeCloseTo(section, 0)
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    runtime.rayOverride = { origin: { x: face.point.x, y: face.point.y, z: face.point.z + 50 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(canvas())
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).not.toBeNull(), { timeout: 30_000 })
    const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-2' } })
    fireEvent.click(screen.getByTestId('pushpull-delta-entry-apply'))
    let id: string | undefined
    await waitFor(() => {
      id = hooks().dag.featureOrder().find((f) => !before.includes(f))
      const hint = screen.queryByTestId('solids-workbench-pushpull-hint')?.textContent ?? ''
      expect(id, `no Push/Pull row; hint: ${hint}`).toBeDefined()
      expect(hooks().scheduler.statusOf(id!)).toBe('ok')
    }, { timeout: 60_000 })
    expect(hooks().dag.getNode(id!)?.payload.opType).toBe('pushPull')
    expect(screen.getByTestId(`feature-row-${id}`)).toBeTruthy()
    await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
    const after = await volumeOf(id!)
    const moved = await topFace(id!)
    console.log('WO-2856 STEP', JSON.stringify({ startVolume, after, section, top: face, movedTop: moved }))
    // the section's hole circles are chords of the true circles: 0.1 %
    expect(Math.abs((after - startVolume) / (-2 * section) - 1)).toBeLessThan(1e-3)
    // the top face itself arrives 2 mm lower at its own size: every
    // countersink and edge chamfer around it rode along unchanged
    expect(moved.z).toBeCloseTo(face.z - 2, 4)
    expect(moved.area).toBeCloseTo(face.area, 1)
    const undo = screen.getByTestId('workbench-undo') as HTMLButtonElement
    expect(undo.disabled).toBe(false)
    fireEvent.click(undo)
    await waitFor(() => expect(hooks().dag.featureOrder()).not.toContain(id), { timeout: 20_000 })
    expect(await volumeOf('IMP1')).toBeCloseTo(startVolume, 3)
  }, 180_000)

  it('tree Edit of that Push/Pull to -3 mm (the drag arrow, typed value and Edit share this one Apply) re-builds with the dressings carried', async () => {
    const runtime = await openStep()
    const startVolume = await volumeOf('IMP1')
    const face = await topFace('IMP1')
    const section = await sectionArea('IMP1', face.z - 3.5)
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    runtime.rayOverride = { origin: { x: face.point.x, y: face.point.y, z: face.point.z + 50 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(canvas())
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).not.toBeNull(), { timeout: 30_000 })
    fireEvent.change(screen.getByTestId('pushpull-delta-entry-input'), { target: { value: '-2' } })
    fireEvent.click(screen.getByTestId('pushpull-delta-entry-apply'))
    let id: string | undefined
    await waitFor(() => {
      id = hooks().dag.featureOrder().find((f) => !before.includes(f))
      expect(id).toBeDefined()
      expect(hooks().scheduler.statusOf(id!)).toBe('ok')
    }, { timeout: 60_000 })
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull(), { timeout: 20_000 })
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${id}`), { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).not.toBeNull(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('pushpull-delta-entry-input'), { target: { value: '-3' } })
    fireEvent.click(screen.getByTestId('pushpull-delta-entry-apply'))
    await waitFor(() => expect(hooks().dag.getNode(id!)?.payload.delta).toBe(-3), { timeout: 60_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf(id!)).toBe('ok'), { timeout: 60_000 })
    await waitFor(async () => expect((await topFace(id!)).z).toBeCloseTo(face.z - 3, 4), { timeout: 30_000 })
    const after = await volumeOf(id!)
    expect(Math.abs((after - startVolume) / (-3 * section) - 1)).toBeLessThan(1e-3)
    expect((await topFace(id!)).area).toBeCloseTo(face.area, 1)
  }, 180_000)

  it('top face +2 mm (a pull) raises the face with its dressings: the section below them stretches by 2 mm', async () => {
    const runtime = await openStep()
    const startVolume = await volumeOf('IMP1')
    const face = await topFace('IMP1')
    const section = await sectionArea('IMP1', face.z - 2.5)
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    runtime.rayOverride = { origin: { x: face.point.x, y: face.point.y, z: face.point.z + 50 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(canvas())
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).not.toBeNull(), { timeout: 30_000 })
    fireEvent.change(screen.getByTestId('pushpull-delta-entry-input'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('pushpull-delta-entry-apply'))
    let id: string | undefined
    await waitFor(() => {
      id = hooks().dag.featureOrder().find((f) => !before.includes(f))
      expect(id, `no row; console: ${useCamStore.getState().consoleEvents.at(-1)?.message}`).toBeDefined()
      expect(hooks().scheduler.statusOf(id!)).toBe('ok')
    }, { timeout: 60_000 })
    await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
    const after = await volumeOf(id!)
    const moved = await topFace(id!)
    expect(moved.z).toBeCloseTo(face.z + 2, 4)
    expect(moved.area).toBeCloseTo(face.area, 1)
    expect(Math.abs((after - startVolume) / (2 * section) - 1)).toBeLessThan(1e-3)
  }, 180_000)

  it('a push the part cannot take (through it) changes nothing and says why in one line', async () => {
    const runtime = await openStep()
    const startVolume = await volumeOf('IMP1')
    const face = await topFace('IMP1')
    const before = hooks().dag.featureOrder()
    const consoleBefore = useCamStore.getState().consoleEvents.length
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    runtime.rayOverride = { origin: { x: face.point.x, y: face.point.y, z: face.point.z + 50 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(canvas())
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).not.toBeNull(), { timeout: 30_000 })
    fireEvent.change(screen.getByTestId('pushpull-delta-entry-input'), { target: { value: '-50' } })
    fireEvent.click(screen.getByTestId('pushpull-delta-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull(), { timeout: 60_000 })
    // one console line naming Push/Pull and that nothing changed
    let line = ''
    await waitFor(() => {
      const added = useCamStore.getState().consoleEvents.slice(consoleBefore).filter((e) => e.severity === 'warning' && /push\/pull/i.test(e.message))
      expect(added).toHaveLength(1)
      line = added[0].message
    }, { timeout: 20_000 })
    console.log('WO-2856 refusal line:', line)
    expect(line).toMatch(/nothing was changed|no changes were applied/i)
    expect(hooks().dag.featureOrder()).toEqual(before)
    expect(await volumeOf('IMP1')).toBeCloseTo(startVolume, 3)
    // and the hint bar carries the same line when the tool is armed again
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-pushpull-hint').textContent).toContain(line), { timeout: 20_000 })
  }, 180_000)
})

/** A 60 x 60 x 10 plate with a 10 x 10 square through-hole whose top 3 mm is
 *  a 45 deg square countersink (16 x 16 at the top face). Every face is flat,
 *  so "Edit as model" rebuilds it as a kernel body (the prismatic route). */
function countersunkPlateStl(): ArrayBuffer {
  const tris: V3[][] = []
  const P = (x: number, y: number, z: number): V3 => ({ x, y, z })
  // a planar quad a-b-c-d, counter-clockwise seen from outside the part
  const quad = (a: V3, b: V3, c: V3, d: V3) => { tris.push([a, b, c], [a, c, d]) }
  // the ring between an outer and an inner square at height z
  const ring = (o: number, i: number, z: number, up: boolean) => {
    const sq = (h: number) => [P(-h, -h, z), P(h, -h, z), P(h, h, z), P(-h, h, z)]
    const [O, I] = [sq(o), sq(i)]
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4
      if (up) quad(O[k], O[n], I[n], I[k])
      else quad(O[n], O[k], I[k], I[n])
    }
  }
  ring(30, 8, 10, true) // top face
  ring(30, 5, 0, false) // bottom face
  // the outer walls, the countersink and the hole walls: quads between two
  // squares (half-size a at za, half-size b at zb), facing out (+1) or in (-1)
  const band = (a: number, za: number, b: number, zb: number, out: boolean) => {
    const sq = (h: number, z: number) => [P(-h, -h, z), P(h, -h, z), P(h, h, z), P(-h, h, z)]
    const [A, B] = [sq(a, za), sq(b, zb)]
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4
      if (out) quad(A[k], A[n], B[n], B[k])
      else quad(A[n], A[k], B[k], B[n])
    }
  }
  band(30, 0, 30, 10, true)
  band(5, 7, 8, 10, false) // countersink, facing into the hole
  band(5, 0, 5, 7, false)
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const dv = new DataView(buf)
  dv.setUint32(80, tris.length, true)
  tris.forEach((t, i) => {
    const o = 84 + i * 50
    const u = { x: t[1].x - t[0].x, y: t[1].y - t[0].y, z: t[1].z - t[0].z }
    const w = { x: t[2].x - t[0].x, y: t[2].y - t[0].y, z: t[2].z - t[0].z }
    const n = { x: u.y * w.z - u.z * w.y, y: u.z * w.x - u.x * w.z, z: u.x * w.y - u.y * w.x }
    const l = Math.hypot(n.x, n.y, n.z) || 1
    ;[n.x / l, n.y / l, n.z / l, ...t.flatMap((v) => [v.x, v.y, v.z])].forEach((x, j) => dv.setFloat32(o + j * 4, x, true))
  })
  return buf
}

describe('WO-2856 Push/Pull on a wrapped prismatic STL applies', () => {
  it('countersunk plate top face -2 mm: a Push/Pull row, the hand-computed volume, Undo restores', async () => {
    const id = 'countersunk-plate'
    stlCache.set(id, countersunkPlateStl())
    act(() => {
      useCamStore.setState((st) => ({
        project: {
          ...st.project,
          geometry: [{
            id, name: 'countersunk plate', filename: 'countersunk-plate.stl', type: 'mesh', format: 'stl',
            boundingBox: { min: { x: -30, y: -30, z: 0 }, max: { x: 30, y: 30, z: 10 }, size: { x: 60, y: 60, z: 10 }, center: { x: 0, y: 0, z: 5 } },
            position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
          }],
        },
      }))
    })
    let wrapped: { ok: boolean; reason?: string } | undefined
    await act(async () => { wrapped = await useCamStore.getState().wrapImportedGeometryAsModelItem(id) })
    expect(wrapped?.ok, wrapped?.reason).toBe(true)
    const runtime = createFakeSceneRuntime()
    runtime.projectToCanvasResult = { x: 200, y: 200 }
    const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
    render(createElement(SolidsWorkbenchPage, { modelItemId: useCamStore.getState().activeModelItemId ?? undefined, createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
    let bodyId = ''
    await waitFor(() => {
      bodyId = hooks().dag.featureOrder().find((f) => hooks().getBodyHandle(f) !== undefined) ?? ''
      expect(bodyId).not.toBe('')
      expect(hooks().scheduler.statusOf(bodyId)).toBe('ok')
    }, { timeout: 30_000 })
    // hand oracle: 60^2*10 - the 10x10 hole - the countersink frustum's extra
    // (1/3 * 3 * (100 + 256 + 160) - 300 = 216)
    const startVolume = await volumeOf(bodyId)
    expect(startVolume).toBeCloseTo(36000 - 1000 - 216, 2)
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    runtime.rayOverride = { origin: { x: 20, y: 20, z: 60 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(canvas())
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).not.toBeNull(), { timeout: 30_000 })
    fireEvent.change(screen.getByTestId('pushpull-delta-entry-input'), { target: { value: '-2' } })
    fireEvent.click(screen.getByTestId('pushpull-delta-entry-apply'))
    let fid: string | undefined
    await waitFor(() => {
      fid = hooks().dag.featureOrder().find((f) => !before.includes(f))
      const hint = screen.queryByTestId('solids-workbench-pushpull-hint')?.textContent ?? ''
      const lines = useCamStore.getState().consoleEvents.map((e) => e.message).slice(-2).join(' | ')
      expect(fid, `no Push/Pull row; hint: ${hint}; console: ${lines}`).toBeDefined()
      expect(hooks().scheduler.statusOf(fid!)).toBe('ok')
    }, { timeout: 60_000 })
    expect(hooks().dag.getNode(fid!)?.payload.opType).toBe('pushPull')
    expect(screen.getByTestId(`feature-row-${fid}`)).toBeTruthy()
    await waitFor(() => expect(hooks().getBodyHandle(fid!)).not.toBeUndefined(), { timeout: 30_000 })
    const after = await volumeOf(fid!)
    const top = await topFace(fid!)
    console.log('WO-2856 STL', JSON.stringify({ startVolume, after, delta: after - startVolume, top }))
    expect(top.z).toBeCloseTo(8, 4)
    // the countersink rides down with the face at its own size (16 x 16 at the
    // top, 3 mm deep), as on the STEP route: 60^2*8 - 10*10*8 - 216, and the
    // top face keeps its area 60^2 - 16^2
    expect(after).toBeCloseTo(28800 - 800 - 216, 2)
    expect(top.area).toBeCloseTo(3600 - 256, 2)
    const undo = screen.getByTestId('workbench-undo') as HTMLButtonElement
    expect(undo.disabled).toBe(false)
    fireEvent.click(undo)
    await waitFor(() => expect(hooks().dag.featureOrder()).not.toContain(fid), { timeout: 20_000 })
    expect(await volumeOf(bodyId)).toBeCloseTo(startVolume, 3)
  }, 180_000)
})
