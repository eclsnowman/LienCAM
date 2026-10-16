// @vitest-environment jsdom
//
// WO-2762: edit ONE step of a counterbore or countersink on an imported part.
// the owner (2026-10-10): "counterbored holes (adjusting just one step)".
//
// Cells from the WO-2757 audit (docs/audits/DIRECT-EDIT-IMPORTED-GEOMETRY-
// AUDIT-2026-10.md), run the audit's way - through the app, never a kernel
// call with a hand-built payload:
//   - STEP: the real Model screen (SolidsWorkbenchPage) on the real in-process
//     kernel; the part comes in through the screen's Import input, the hole
//     wall is picked by a viewport ray, and Resize Hole's own anchored entry
//     previews and applies.
//   - STL: the store's "Edit as model" and the same Resize Hole pick on the
//     mesh route.
// Every result is judged by the audit's own hand formula for the volume, plus
// a shape check where volume alone can't tell (the countersink's top
// diameter, the pilot left alone).
//
// RH-2 / SRH-1: picking the COUNTERBORE wall edits the counterbore (d11 ->
// d12) and leaves the d6.6 pilot. RH-4: a countersunk pilot resize keeps the
// d13 countersink. RH-3, RH-5, SRH-2, SRH-3: the audit's WORKS hole cells
// still work.

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

// jsdom's localStorage is broken under Vitest's node launch flags (the shim
// the WO-2757 audit suite installs before importing the page).
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
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { useCamStore } = await import('../../store')

const PART = (name: string) => resolve(process.cwd(), 'src/tests/evidence/WO-2757', name)
const PI = Math.PI

type V3 = { x: number; y: number; z: number }

let consoleLines: string[] = []
const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  stepCache.clear()
  stlCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
  consoleLines = []
  useCamStore.getState().addConsoleEvent = (event) => { consoleLines.push(event.message) }
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  useCamStore.getState().addConsoleEvent = realAddConsoleEvent
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

function click(): void {
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
}

function aimAt(runtime: FakeSceneRuntime, from: V3, to: V3): void {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const l = Math.hypot(d.x, d.y, d.z)
  runtime.rayOverride = { origin: from, direction: { x: d.x / l, y: d.y / l, z: d.z / l } }
}

// ---------------------------------------------------------------- STEP route

interface StepSession { runtime: FakeSceneRuntime; volume: number }
interface FaceInfo { id: StableId; type: string; centroid: V3; min: V3; max: V3; aim: { point: V3; normal: V3 } }

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

/** The Model screen on the real kernel, the part imported through its own Import input. */
async function openStep(path: string): Promise<StepSession> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([bytesOf(path)], 'stepped_holes.step', { type: 'application/octet-stream' })] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
  return { runtime, volume: await volumeOf('IMP1') }
}

/** Every face of a live body: kernel surface class, area-weighted centroid,
 *  bounds, and its largest triangle to aim a ray at. */
async function facesOf(featureId: string): Promise<FaceInfo[]> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const mesh = await hooks().client.tessellate(h, { deflection: 0.05 })
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  const acc = mesh.faceIds.map(() => ({ a: 0, c: { x: 0, y: 0, z: 0 }, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity }, best: -1, bestA: 0 }))
  const crossOf = (t: number) => {
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    return { a, b, c, cr: { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x } }
  }
  for (let t = 0; t < mesh.triFace.length; t++) {
    const f = acc[mesh.triFace[t]]
    const { a, b, c, cr } = crossOf(t)
    const area = Math.hypot(cr.x, cr.y, cr.z) / 2
    f.a += area
    for (const k of ['x', 'y', 'z'] as const) {
      f.c[k] += area * (a[k] + b[k] + c[k]) / 3
      f.min[k] = Math.min(f.min[k], a[k], b[k], c[k])
      f.max[k] = Math.max(f.max[k], a[k], b[k], c[k])
    }
    if (area > f.bestA) { f.bestA = area; f.best = t }
  }
  const out: FaceInfo[] = []
  for (let i = 0; i < mesh.faceIds.length; i++) {
    const f = acc[i]
    if (f.best < 0) continue
    const { a, b, c, cr } = crossOf(f.best)
    const cl = Math.hypot(cr.x, cr.y, cr.z)
    out.push({
      id: mesh.faceIds[i],
      type: await hooks().client.classifyFace(h, mesh.faceIds[i]),
      centroid: { x: f.c.x / f.a, y: f.c.y / f.a, z: f.c.z / f.a },
      min: f.min, max: f.max,
      aim: { point: { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 }, normal: { x: cr.x / cl, y: cr.y / cl, z: cr.z / cl } },
    })
  }
  return out
}

const at = (f: FaceInfo, x: number, y: number) => Math.hypot(f.centroid.x - x, f.centroid.y - y) < 1
const widthOf = (f: FaceInfo) => Number((f.max.x - f.min.x).toFixed(3))

function findFace(faces: FaceInfo[], label: string, test: (f: FaceInfo) => boolean): FaceInfo {
  const hit = faces.find(test)
  if (hit === undefined) throw new Error(`no face matches ${label}: ${JSON.stringify(faces.map((f) => [f.type, f.centroid]))}`)
  return hit
}

function aimAtFace(runtime: FakeSceneRuntime, f: FaceInfo): void {
  const { point, normal } = f.aim
  runtime.rayOverride = {
    origin: { x: point.x + normal.x * 0.5, y: point.y + normal.y * 0.5, z: point.z + normal.z * 0.5 },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

interface Applied { current: string; title: string; volumeDelta: number; id: string }

/** Resize Hole: arm, pick `wall`, optionally switch the entry to Depth, type
 *  `value`, wait for the preview, Apply, and measure the landed feature. */
async function resizeHoleStep(s: StepSession, wall: FaceInfo, value: string, field?: 'depth'): Promise<Applied> {
  const before = hooks().dag.featureOrder()
  // Resize Hole stays armed after an Apply; the next edit picks straight away.
  if (screen.queryByTestId('solids-workbench-resizehole-hint') === null) fireEvent.click(screen.getByTestId('workbench-resize-hole'))
  await waitFor(() => expect(text('solids-workbench-resizehole-hint')).not.toMatch(/recognizing/i), { timeout: 30_000 })
  if (field === 'depth') fireEvent.click(screen.getByTestId('workbench-resizehole-field'))
  aimAtFace(s.runtime, wall); click()
  await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
  const current = text('resize-hole-anchor-entry-current')
  const title = text('resize-hole-anchor-entry')
  fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value } })
  await waitFor(() => expect(['ready', 'refused']).toContain(statusOf('resize-hole-anchor-entry-status')), { timeout: 60_000 })
  expect(statusOf('resize-hole-anchor-entry-status'), text('resize-hole-anchor-entry-status')).toBe('ready')
  fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
  let id: string | undefined
  await waitFor(() => {
    id = hooks().dag.featureOrder().find((f) => !before.includes(f))
    expect(id).toBeDefined()
    expect(['ok', 'failed']).toContain(hooks().scheduler.statusOf(id!))
  }, { timeout: 60_000 })
  expect(hooks().scheduler.statusOf(id!), JSON.stringify(hooks().scheduler.diagnosticsOf(id!))).toBe('ok')
  await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
  return { current, title, volumeDelta: (await volumeOf(id!)) - s.volume, id: id! }
}

/** The audit's volume tolerance for STEP cells (0.2 %, never under 0.05 mm3). */
function expectVolume(delta: number, expected: number, tol = 0.002): void {
  expect(Math.abs(delta - expected), `volume changed by ${delta.toFixed(3)}, expected ${expected.toFixed(3)}`)
    .toBeLessThanOrEqual(Math.max(tol * Math.abs(expected), 0.05))
}

// The countersunk pilot d6.6 -> d7 (stepped_holes: plate 15 thick, 90 deg
// countersink to d13, so the cone is r = 3.3 + (z - 11.8)): the pilot ring
// over z 0..11.8, plus the sliver of the cone's foot the wider pilot eats.
// The countersink keeps its d13 top. (The audit's SRH-3 formula.)
const CSK_PILOT_7 = -PI * ((3.5 ** 2 - 3.3 ** 2) * 11.8 + 3.5 ** 2 * 0.2 - (3.5 ** 3 - 3.3 ** 3) / 3)

// The countersunk hole's whole volume with its pilot at radius r and the d13
// 90 deg countersink kept: the pilot up to the cone's foot (15 - (6.5 - r)),
// plus the cone frustum r -> 6.5 over its axial depth 6.5 - r.
const cskHole = (r: number) => PI * r ** 2 * (15 - (6.5 - r)) + PI * (6.5 - r) * (6.5 ** 2 + 6.5 * r + r ** 2) / 3
/** The volume change of a countersunk pilot resize d6.6 -> 2r (CSK_PILOT_7 = cskPilot(3.5)). */
const cskPilot = (r: number) => -(cskHole(r) - cskHole(3.3))

describe('WO-2762 STEP: Resize Hole edits one step of a counterbore or countersink', () => {
  it('RH-2 counterbore wall picked: the entry shows d11 and d12 widens only the counterbore', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'cbore wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8)
    const r = await resizeHoleStep(s, wall, '12')
    expect(r.current).toMatch(/Current counterbore diameter\s*11 mm/)
    expect(r.title).toMatch(/Resize counterbore/)
    // Correct: the counterbore (z 8.5..15) grows r5.5 -> r6; the pilot is untouched.
    expectVolume(r.volumeDelta, -6.5 * PI * (36 - 30.25))
    const faces = await facesOf(r.id)
    const cylinders = faces.filter((f) => f.type === 'cylinder' && at(f, 15, 20))
    expect(Math.abs(Math.max(...cylinders.filter((f) => f.min.z > 8).map(widthOf)) - 12)).toBeLessThan(0.05)
    expect(Math.abs(Math.max(...cylinders.filter((f) => f.max.z < 9).map(widthOf)) - 6.6)).toBeLessThan(0.05)
  }, 180_000)

  it('RH-2 depth: the counterbore wall picked with Depth deepens only the counterbore (6.5 -> 8)', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'cbore wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8)
    const r = await resizeHoleStep(s, wall, '8', 'depth')
    expect(r.current).toMatch(/Current counterbore depth\s*6\.5 mm/)
    // Correct: the d11 counterbore runs 1.5 mm deeper into the d6.6 pilot.
    expectVolume(r.volumeDelta, -1.5 * PI * (30.25 - 10.89))
  }, 180_000)

  it('RH-3 counterbore pilot picked: d6.6 -> d7 still changes only the pilot', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'through wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.max.z < 9)
    const r = await resizeHoleStep(s, wall, '7')
    expect(r.current).toMatch(/Current diameter\s*6\.6 mm/)
    expectVolume(r.volumeDelta, -8.5 * PI * (12.25 - 10.89))
    const faces = await facesOf(r.id)
    expect(Math.abs(Math.max(...faces.filter((f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8).map(widthOf)) - 11)).toBeLessThan(0.05)
  }, 180_000)

  it('RH-4 countersunk pilot d6.6 -> d7: the countersink stays d13', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'csk through wall', (f) => f.type === 'cylinder' && at(f, 35, 20))
    const r = await resizeHoleStep(s, wall, '7')
    const cone = (await facesOf(r.id)).find((f) => f.type === 'cone' && at(f, 35, 20))
    expect(cone, 'the countersink cone survives').toBeDefined()
    expect(widthOf(cone!)).toBeCloseTo(13, 1)
    expect(Math.abs(widthOf(cone!) - 13)).toBeLessThan(0.05)
    expectVolume(r.volumeDelta, CSK_PILOT_7)
  }, 180_000)

  // Fix round (astra audit, architect 2026-10-13 8:29 PM): nothing the kernel
  // can cut is refused (LIENCAM.md rule 11), and a countersink is told from a
  // chamfer once, so the same final value gives the same shape by any route.

  it('counterbore depth to the pilot bottom (6.5 -> 15): the hole becomes one d11 bore, through', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'cbore wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8)
    const r = await resizeHoleStep(s, wall, '15', 'depth')
    // The d11 counterbore now runs the plate's 15 mm: the pilot's 8.5 mm below the shoulder is bored to d11.
    expectVolume(r.volumeDelta, -8.5 * PI * (30.25 - 10.89))
    expect(consoleLines.join('\n')).toMatch(/the hole is now one 11 mm bore, right through/)
  }, 180_000)

  it('counterbore depth Through: the hole becomes one d11 bore, through', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'cbore wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8)
    const r = await resizeHoleStep(s, wall, 'through', 'depth')
    expectVolume(r.volumeDelta, -8.5 * PI * (30.25 - 10.89))
    expect(consoleLines.join('\n')).toMatch(/the hole is now one 11 mm bore, right through/)
  }, 180_000)

  it('counterbore d11 -> d6.6 (its pilot): the hole becomes one d6.6 bore', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'cbore wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8)
    const r = await resizeHoleStep(s, wall, '6.6')
    // The counterbore (z 8.5..15) is filled back to the pilot: r5.5 -> r3.3.
    expectVolume(r.volumeDelta, 6.5 * PI * (30.25 - 10.89))
    expect(consoleLines.join('\n'), consoleLines.join(' | ')).toMatch(/the hole is now one 6\.6 mm bore, right through/)
  }, 180_000)

  it('counterbore d11 -> d5 (under its pilot): cut as asked, the d6.6 pilot left below it', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'cbore wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8)
    const r = await resizeHoleStep(s, wall, '5')
    // The top step (z 8.5..15) is r5 -> r2.5; the pilot below keeps r3.3.
    expectVolume(r.volumeDelta, 6.5 * PI * (30.25 - 6.25))
    const cylinders = (await facesOf(r.id)).filter((f) => f.type === 'cylinder' && at(f, 15, 20))
    expect(Math.abs(Math.max(...cylinders.filter((f) => f.min.z > 8).map(widthOf)) - 5)).toBeLessThan(0.05)
    expect(Math.abs(Math.max(...cylinders.filter((f) => f.max.z < 9).map(widthOf)) - 6.6)).toBeLessThan(0.05)
    expect(consoleLines.join('\n')).toMatch(/the counterbore is now narrower than the 6\.6 mm hole below it/)
  }, 180_000)

  it('countersunk pilot d6.6 -> d9, then d9 -> d10, is the same as d6.6 -> d10: the countersink stays d13', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'csk through wall', (f) => f.type === 'cylinder' && at(f, 35, 20))
    const r9 = await resizeHoleStep(s, wall, '9')
    expectVolume(r9.volumeDelta, cskPilot(4.5))
    const wall9 = findFace(await facesOf(r9.id), 'csk d9 wall', (f) => f.type === 'cylinder' && at(f, 35, 20))
    const r10 = await resizeHoleStep(s, wall9, '10')
    const cone = (await facesOf(r10.id)).find((f) => f.type === 'cone' && at(f, 35, 20))
    expect(cone, 'the countersink cone survives').toBeDefined()
    expect(Math.abs(widthOf(cone!) - 13)).toBeLessThan(0.05)
    expectVolume(r10.volumeDelta, cskPilot(5))
  }, 240_000)

  it('countersunk pilot d6.6 -> d10 in one edit: the countersink stays d13', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'csk through wall', (f) => f.type === 'cylinder' && at(f, 35, 20))
    const r = await resizeHoleStep(s, wall, '10')
    const cone = (await facesOf(r.id)).find((f) => f.type === 'cone' && at(f, 35, 20))
    expect(cone, 'the countersink cone survives').toBeDefined()
    expect(Math.abs(widthOf(cone!) - 13)).toBeLessThan(0.05)
    expectVolume(r.volumeDelta, cskPilot(5))
  }, 180_000)

  it('countersunk pilot d6.6 -> d13: the bore takes the countersink in (its top does not grow)', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'csk through wall', (f) => f.type === 'cylinder' && at(f, 35, 20))
    const r = await resizeHoleStep(s, wall, '13')
    expect((await facesOf(r.id)).some((f) => f.type === 'cone' && at(f, 35, 20)), 'no cone is left').toBe(false)
    expectVolume(r.volumeDelta, -(PI * 6.5 ** 2 * 15 - cskHole(3.3)))
    expect(consoleLines.join('\n')).toMatch(/takes the countersink in/)
  }, 180_000)

  it('RH-5 tapped-size d5 -> d6 still works', async () => {
    const s = await openStep(PART('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'd5 wall', (f) => f.type === 'cylinder' && at(f, 55, 20))
    const r = await resizeHoleStep(s, wall, '6')
    expectVolume(r.volumeDelta, -15 * PI * (9 - 6.25))
  }, 180_000)
})

// ----------------------------------------------------------------- STL route

interface StlSession { runtime: FakeSceneRuntime; id: string; bytes: ArrayBuffer; volume: number }

const journalOf = (id: string) => useCamStore.getState().project.geometry.find((g) => g.id === id)?.meshEdits

function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  let v = 0
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3]
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])
  }
  return v / 6
}

async function editedMesh(s: StlSession) {
  const edit = await import('../../mesh/edit')
  return edit.resolveEditedStlMesh(s.bytes, journalOf(s.id)).mesh
}

/** Open the STL the product's way - the store's "Edit as model" - and mount
 *  the Model screen on it (mesh route, the test's stand-in kernel client). */
async function openStl(name: string): Promise<StlSession> {
  const id = name.replace(/\W/g, '-')
  const bytes = bytesOf(PART(name))
  stlCache.set(id, bytes)
  act(() => {
    useCamStore.setState((st) => ({
      project: {
        ...st.project,
        geometry: [{
          id, name, filename: name, type: 'mesh', format: 'stl',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 70, y: 40, z: 15 }, size: { x: 70, y: 40, z: 15 }, center: { x: 35, y: 20, z: 7.5 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        }],
      },
    }))
  })
  let wrapped: { ok: boolean; reason?: string } | undefined
  await act(async () => { wrapped = await useCamStore.getState().wrapImportedGeometryAsModelItem(id) })
  expect(wrapped?.ok, `Edit as model refused: ${wrapped?.reason}`).toBe(true)
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(createElement(SolidsWorkbenchPage, { createClient: () => createFakeGeomClient(), createSceneRuntime: () => runtime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  await waitFor(() => expect(screen.getByTestId(`body-row-stl-body:${id}`)).toBeTruthy(), { timeout: 30_000 })
  const s = { runtime, id, bytes, volume: 0 }
  const m = await editedMesh(s)
  s.volume = meshVolume(m.positions, m.indices)
  return s
}

/** Resize Hole on the STL: pick the wall the ray from `from` to `to` hits,
 *  type `diameter`, Apply, and measure the edited mesh. */
async function stlResize(s: StlSession, from: V3, to: V3, diameter: string): Promise<{ current: string; volumeDelta: number }> {
  fireEvent.click(screen.getByTestId('workbench-resize-hole'))
  aimAt(s.runtime, from, to); click()
  await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
  const current = text('resize-hole-anchor-entry-current')
  fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: diameter } })
  await waitFor(() => expect(statusOf('resize-hole-anchor-entry-status')).toMatch(/ready|refused/), { timeout: 30_000 })
  expect(statusOf('resize-hole-anchor-entry-status'), `${text('resize-hole-anchor-entry-status')} ${consoleLines.slice(-2).join(' | ')}`).toBe('ready')
  fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
  await waitFor(() => expect(journalOf(s.id)?.length ?? 0).toBeGreaterThan(0), { timeout: 30_000 })
  const m = await editedMesh(s)
  return { current, volumeDelta: meshVolume(m.positions, m.indices) - s.volume }
}

/** The audit's STL tolerance (3 %, never under 0.5 mm3 - the part is faceted). */
function expectStlVolume(delta: number, expected: number): void {
  expect(Math.abs(delta - expected), `volume changed by ${delta.toFixed(3)}, expected ${expected.toFixed(3)}`)
    .toBeLessThanOrEqual(Math.max(0.03 * Math.abs(expected), 0.5))
}

/** Smallest distance from (cx, cy) of an edited-mesh vertex on the plane z,
 *  within `within` mm - the radius of the opening a hole cuts in that plane. */
async function rimRadius(s: StlSession, cx: number, cy: number, z: number, within = 10): Promise<number> {
  const m = await editedMesh(s)
  let r = Infinity
  for (let i = 0; i < m.positions.length; i += 3) {
    if (Math.abs(m.positions[i + 2] - z) > 1e-3) continue
    const d = Math.hypot(m.positions[i] - cx, m.positions[i + 1] - cy)
    if (d < within) r = Math.min(r, d)
  }
  return r
}

const P = (x: number, y: number, z: number): V3 => ({ x, y, z })

describe('WO-2762 STL: Resize Hole edits one step of a counterbore', () => {
  it('SRH-1 counterbore wall picked: the entry shows d11 and d12 keeps the step', async () => {
    const s = await openStl('stepped_holes.stl')
    const r = await stlResize(s, P(15, 20, 12), P(15, 25.5, 12), '12')
    expect(r.current).toMatch(/^Current counterbore diameter/)
    expect(Number(/([\d.]+) mm/.exec(r.current)?.[1])).toBeCloseTo(11, 1)
    // Correct: the counterbore (z 8.5..15) grows r5.5 -> r6; the pilot is untouched.
    expectStlVolume(r.volumeDelta, -6.5 * PI * (36 - 30.25))
    // The step is kept: the shoulder (z 8.5) still opens at the d6.6 pilot,
    // and the floor of the part (z 0) still opens at d6.6.
    expect(2 * await rimRadius(s, 15, 20, 0)).toBeCloseTo(6.6, 1)
    expect(2 * await rimRadius(s, 15, 20, 8.5)).toBeCloseTo(6.6, 1)
  }, 120_000)

  it('counterbore wall picked, d11 -> d6.6 (its pilot): the hole becomes one d6.6 bore', async () => {
    const s = await openStl('stepped_holes.stl')
    const r = await stlResize(s, P(15, 20, 12), P(15, 25.5, 12), '6.6')
    // The counterbore (z 8.5..15) is filled back to the pilot: r5.5 -> r3.3.
    expectStlVolume(r.volumeDelta, 6.5 * PI * (30.25 - 10.89))
    expect(2 * await rimRadius(s, 15, 20, 15)).toBeCloseTo(6.6, 1)
    expect(consoleLines.join('\n')).toMatch(/the counterbore is now the same 6\.6 mm as the hole below it, so the hole is one bore/)
  }, 120_000)

  it('counterbore wall picked, d11 -> d5 (under its pilot): cut as asked, the d6.6 pilot left below it', async () => {
    const s = await openStl('stepped_holes.stl')
    const r = await stlResize(s, P(15, 20, 12), P(15, 25.5, 12), '5')
    expectStlVolume(r.volumeDelta, 6.5 * PI * (30.25 - 6.25))
    expect(2 * await rimRadius(s, 15, 20, 15)).toBeCloseTo(5, 1)
    expect(2 * await rimRadius(s, 15, 20, 0)).toBeCloseTo(6.6, 1)
    expect(consoleLines.join('\n')).toMatch(/the counterbore is now narrower than the 6\.6 mm hole below it/)
  }, 120_000)

  it('SRH-2 counterbore pilot picked: d6.6 -> d7 still bores only the pilot', async () => {
    const s = await openStl('stepped_holes.stl')
    const r = await stlResize(s, P(15, 20, 4), P(15, 23.3, 4), '7')
    expect(r.current).toMatch(/Current diameter\s*6\.6/)
    expectStlVolume(r.volumeDelta, -8.5 * PI * (12.25 - 10.89))
  }, 120_000)

  it('SRH-3 countersunk pilot d6.6 -> d7 keeps the d13 countersink', async () => {
    const s = await openStl('stepped_holes.stl')
    const r = await stlResize(s, P(35, 20, 4), P(35, 23.3, 4), '7')
    expectStlVolume(r.volumeDelta, CSK_PILOT_7)
    expect(Math.abs(2 * await rimRadius(s, 35, 20, 15) - 13)).toBeLessThanOrEqual(0.05)
  }, 120_000)
})
