// @vitest-environment jsdom
//
// WO-2761: a Model-tab click on an imported face that a tool cannot use says
// why. The WO-2757 audit's dead clicks (FI-1..4, CH-1, ED-2 in
// docs/audits/DIRECT-EDIT-IMPORTED-GEOMETRY-AUDIT-2026-10.md) each post ONE
// console line naming the picked face and the reason, and change nothing else.
// WO-2766 made the FI-1..4 and CH-1 clicks live: they now open the change
// dialog on the blend's measured size (blendChains.wo2766 drives them on to
// Apply), so those rows assert the dialog opens with no reason line.
// WO-2795 made ED-2 live too: tree Edit opens on the resized diameter.
//
// Same production route as the audit (directEditAudit.wo2757.test.ts): the REAL
// Model screen on the REAL in-process occt kernel, the part imported through
// the screen's own Import input, the face picked by a viewport ray, the tool
// armed by its own button, the edit reopened from the tree's own menu.

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

const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const part = (name: string) => resolve(PARTS, name)

type V3 = { x: number; y: number; z: number }
interface Line { severity: string; message: string }
let consoleLines: Line[] = []

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  stepCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
  consoleLines = []
  useCamStore.getState().addConsoleEvent = (event) => { consoleLines.push({ severity: event.severity, message: event.message }) }
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
const text = (testId: string) => screen.queryByTestId(testId)?.textContent ?? ''
const statusOf = (testId: string) => screen.queryByTestId(testId)?.getAttribute('data-status') ?? null

function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

async function openStep(path: string): Promise<FakeSceneRuntime> {
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
  return runtime
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

interface FaceInfo { id: StableId; type: string; centroid: V3; normal: V3; min: V3; max: V3; aim: { point: V3; normal: V3 } }

/** Every face of a live body (same reading as the audit): kernel surface
 *  class, area-weighted centroid/normal, bounds, and the largest triangle to
 *  aim a ray at. Read only - it places the ray, it edits nothing. */
async function facesOf(featureId: string): Promise<FaceInfo[]> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const mesh = await hooks().client.tessellate(h, { deflection: 0.05 })
  const acc = mesh.faceIds.map(() => ({ a: 0, c: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 0 }, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity }, best: -1, bestA: 0 }))
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  const cross = (a: V3, b: V3, c: V3): V3 => {
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    return { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
  }
  for (let t = 0; t < mesh.triFace.length; t++) {
    const f = acc[mesh.triFace[t]]
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const cr = cross(a, b, c)
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
    const t = f.best
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const cr = cross(a, b, c)
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
  if (hit === undefined) throw new Error(`no face matches ${label}`)
  return hit
}

function aimAtFace(runtime: FakeSceneRuntime, f: FaceInfo): void {
  const { point, normal } = f.aim
  runtime.rayOverride = {
    origin: { x: point.x + normal.x * 0.5, y: point.y + normal.y * 0.5, z: point.z + normal.z * 0.5 },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

function aimAt(runtime: FakeSceneRuntime, from: V3, to: V3): void {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const l = Math.hypot(d.x, d.y, d.z)
  runtime.rayOverride = { origin: from, direction: { x: d.x / l, y: d.y / l, z: d.z / l } }
}

function click(): void {
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
}

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 400)))
const reasonLines = (from: number) => consoleLines.slice(from).filter((l) => l.severity === 'warning' || l.severity === 'error')

/** WO-2766: arm the tool, click the blend face, and the change dialog opens on
 *  the blend's measured size - no reason line, nothing applied yet. */
async function opensChange(tool: 'fillet' | 'chamfer', runtime: FakeSceneRuntime, face: FaceInfo, measured: string): Promise<void> {
  const features = hooks().dag.featureOrder()
  const volume = await volumeOf('IMP1')
  fireEvent.click(screen.getByTestId(`workbench-${tool}`))
  await settle()
  const from = consoleLines.length
  aimAtFace(runtime, face)
  click()
  await waitFor(() => expect(text(`${tool}-edge-count`)).toMatch(/[1-9]\d* edge/), { timeout: 20_000 })
  await settle()
  expect(reasonLines(from), JSON.stringify(consoleLines.slice(from))).toEqual([])
  const field = tool === 'fillet' ? 'fillet-radius' : 'chamfer-distance'
  expect((screen.getByTestId(field).querySelector('input') as HTMLInputElement).value).toBe(measured)
  expect(hooks().dag.featureOrder()).toEqual(features)
  expect(await volumeOf('IMP1')).toBeCloseTo(volume, 6)
}

describe('WO-2761 -> WO-2766: a Fillet/Chamfer click on an imported blend opens its change dialog (audit FI-1..4, CH-1)', () => {
  it('FI-1 boss-foot fillet (torus): the Fillet dialog opens on r3', async () => {
    const runtime = await openStep(part('boss_fillet_base.step'))
    const blend = findFace(await facesOf('IMP1'), 'base fillet', (f) => f.type === 'torus')
    await opensChange('fillet', runtime, blend, '3')
  }, 180_000)

  it('FI-2 one straight member of the r2 fillet chain: the Fillet dialog opens on r2', async () => {
    const runtime = await openStep(part('fillet_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chain straight member', (f) => f.type === 'cylinder' && f.min.z > 17 && f.normal.y < -0.5)
    await opensChange('fillet', runtime, member, '2')
  }, 180_000)

  it('FI-3 the corner (torus) member of the chain: the Fillet dialog opens on r2', async () => {
    const runtime = await openStep(part('fillet_chain.step'))
    const corner = findFace(await facesOf('IMP1'), 'chain corner', (f) => f.type === 'torus' && f.min.z > 17)
    await opensChange('fillet', runtime, corner, '2')
  }, 180_000)

  it('FI-4 pocket floor fillet: the Fillet dialog opens on r2', async () => {
    const runtime = await openStep(part('pocket_floor_fillet.step'))
    const blend = findFace(await facesOf('IMP1'), 'floor fillet', (f) => f.type === 'cylinder' && f.max.z < 14.5 && f.min.z > 11.5 && Math.abs(f.normal.z) > 0.3)
    await opensChange('fillet', runtime, blend, '2')
  }, 180_000)

  it('CH-1 one member of the 2 mm chamfer chain: the Chamfer dialog opens on 2 mm', async () => {
    const runtime = await openStep(part('chamfer_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chamfer member', (f) => f.type === 'plane' && f.normal.y < -0.5 && f.normal.z > 0.5)
    await opensChange('chamfer', runtime, member, '2')
  }, 180_000)

  it('control: a sharp rib edge still picks for Fillet with no reason line (FI-5 pick)', async () => {
    const runtime = await openStep(part('rib_part.step'))
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    await settle()
    const from = consoleLines.length
    aimAt(runtime, { x: 30, y: -12, z: 40 }, { x: 30, y: 8, z: 20 })
    click()
    await waitFor(() => expect(text('fillet-edge-count')).toMatch(/1 edge/), { timeout: 8_000 })
    await settle()
    expect(reasonLines(from)).toEqual([])
  }, 180_000)
})

describe('WO-2761 -> WO-2795: the Resize Hole tree Edit on an imported hole reopens (audit ED-2)', () => {
  it('ED-2 re-open a Resize Hole (d6 -> d8) from the tree: opens on d8 with no refusal line', async () => {
    const runtime = await openStep(resolve(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'd6 at (20,20)', (f) => f.type === 'cylinder' && Math.hypot(f.centroid.x - 20, f.centroid.y - 20) < 1)
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(text('solids-workbench-resizehole-hint')).not.toMatch(/recognizing/i), { timeout: 30_000 })
    aimAtFace(runtime, wall); click()
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitFor(() => expect(statusOf('resize-hole-anchor-entry-status')).toBe('ready'), { timeout: 60_000 })
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    let id = ''
    await waitFor(() => {
      id = hooks().dag.featureOrder().find((f) => !before.includes(f)) ?? ''
      expect(hooks().scheduler.statusOf(id)).toBe('ok')
    }, { timeout: 60_000 })
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())
    await settle()

    const from = consoleLines.length
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${id}`), { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    await settle()
    expect((screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement).value).toBe('8')
    expect(reasonLines(from), JSON.stringify(consoleLines.slice(from))).toEqual([])
    expect(hooks().dag.featureOrder()).toEqual([...before, id])
    expect(hooks().dag.getNode(id)?.payload.newDiameter).toBe(8)
  }, 180_000)
})
