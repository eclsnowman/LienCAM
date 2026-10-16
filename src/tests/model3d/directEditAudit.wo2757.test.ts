// @vitest-environment jsdom
//
// WO-2757: direct editing of imported geometry - what works, what refuses,
// what produces wrong geometry. One test per audit matrix cell
// (docs/audits/DIRECT-EDIT-IMPORTED-GEOMETRY-AUDIT-2026-10.md).
//
// Every STEP cell runs the REAL Model screen (SolidsWorkbenchPage) on the REAL
// in-process occt kernel (createLocalGeomService): the part comes in through
// the screen's own Import input, the face/edge is picked by a viewport ray,
// and the edit goes through the tool's own button, dialog and Apply. Every STL
// cell opens the part through the store's "Edit as model" action
// (wrapImportedGeometryAsModelItem) and drives the same tool buttons on the
// mesh route (src/mesh/edit + recognition). Nothing calls a kernel function
// with a hand-built payload; the kernel is read only to MEASURE a result
// (volume) or to find where a face is so the ray can aim at it.
//
// Each test asserts the CURRENT outcome. A cell marked `CURRENT: REFUSES` or
// `CURRENT: WRONG` is an expected failure: the fix order that changes it flips
// that one assertion (and the matrix row) on purpose.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolveEditedStlMesh } from '../../mesh/edit'
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

// jsdom's localStorage is broken under Vitest's node launch flags (same shim
// pushPullAfterHoleResize.wo1416.test.ts installs before importing the page).
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

const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const DOME_STEP = resolve(process.cwd(), 'test_fixtures/brep/fix_freeform.step')
const part = (name: string) => resolve(PARTS, name)

type V3 = { x: number; y: number; z: number }
type Verdict = 'WORKS' | 'REFUSES' | 'WRONG' | 'CRASH'
interface Outcome { verdict: Verdict; message: string; detail: Record<string, unknown> }

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

// TODAY'S OUTCOME OF EVERY CELL. This is the matrix in
// docs/audits/DIRECT-EDIT-IMPORTED-GEOMETRY-AUDIT-2026-10.md, pinned. A fix
// order flips its own row here (REFUSES/WRONG -> WORKS) and nothing else.
const EXPECTED: Record<string, { verdict: Verdict; message?: RegExp }> = {
  // STEP - Push/Pull
  'PP-1': { verdict: 'WORKS' }, // WO-2760: the plane meets the dome
  'PP-2': { verdict: 'WORKS' }, // WO-2767: the foot fillet rides up with the plate top (was a moat, then a WO-2760 refusal)
  'PP-3': { verdict: 'WORKS' },
  'PP-4': { verdict: 'WORKS' }, // WO-2767: the r2 chain rides up with the top (was a plateau)
  'PP-5': { verdict: 'WORKS' },
  'PP-6': { verdict: 'WORKS' }, // WO-2813: the counterbore wall grows its radius
  'PP-7': { verdict: 'WORKS' }, // WO-2813: the countersink cone offsets along its normal
  'PP-8': { verdict: 'WORKS' }, // WO-2767: the floor fillets go down with the floor (was a narrow well)
  'PP-9': { verdict: 'WORKS' },
  'PP-10': { verdict: 'WORKS' },
  'PP-11': { verdict: 'WORKS' }, // WO-2767: the wall moves between deck and floor (was a 0.259 mm lip)
  'PP-12': { verdict: 'WORKS' }, // WO-2767: the base meets the cone (was a wedge groove)
  // STEP - Fillet / Chamfer
  'FI-1': { verdict: 'WORKS' }, // WO-2766: was a silent dead click
  'FI-2': { verdict: 'WORKS' }, // WO-2766
  'FI-3': { verdict: 'WORKS' }, // WO-2766
  'FI-4': { verdict: 'WORKS' }, // WO-2766
  'FI-5': { verdict: 'WORKS' },
  'FI-6': { verdict: 'WORKS' },
  'FI-cause': { verdict: 'REFUSES' },
  'CH-1': { verdict: 'WORKS' }, // WO-2766
  'CH-2': { verdict: 'WORKS' },
  'CH-3': { verdict: 'WORKS' }, // WO-2803: seam edge no longer offered; the circular edge chamfers
  'CH-3b': { verdict: 'WORKS' },
  // STEP - Shell / Draft / Hole
  'SH-1': { verdict: 'WORKS' }, // WO-2799: two pieces, 2 mm walls
  'SH-2': { verdict: 'WORKS' },
  'SH-3': { verdict: 'WORKS' }, // WO-2799: two pieces, 1 mm walls
  'SH-4': { verdict: 'WORKS' },
  'DR-1': { verdict: 'WORKS' },
  'DR-2': { verdict: 'WORKS' }, // WO-2799: drafts beside the floor fillets, radii restored
  'HO-1': { verdict: 'WORKS' },
  'HO-2': { verdict: 'WORKS' }, // WO-2794: drilled along the dome normal at the pick (was 34 deg off, out into the plate)
  // STEP - Resize Hole
  'RH-1': { verdict: 'WORKS' },
  'RH-2': { verdict: 'WORKS' }, // WO-2762: only the counterbore step changes
  'RH-3': { verdict: 'WORKS' },
  'RH-4': { verdict: 'WORKS' }, // WO-2762: the countersink keeps its d13 top
  'RH-5': { verdict: 'WORKS' },
  // STEP - Defeature
  'DF-1': { verdict: 'WORKS' },
  'DF-2': { verdict: 'WORKS' },
  'DF-3': { verdict: 'WORKS' },
  'DF-4': { verdict: 'WORKS' }, // WO-2766
  'DF-5': { verdict: 'WORKS' }, // WO-2766
  'DF-6': { verdict: 'WORKS' }, // WO-2766
  'DF-7': { verdict: 'WORKS' }, // WO-2766: the foot fillet goes with the boss
  'DF-8': { verdict: 'WORKS' },
  'DF-9': { verdict: 'WORKS' }, // WO-2766
  // STEP - Edit / Boolean / Import / buttons
  'ED-1': { verdict: 'WORKS' },
  'ED-2': { verdict: 'WORKS' }, // WO-2795: resolved against the owner body the resize replays on
  'BO-1': { verdict: 'WORKS' }, // WO-2796: the Model screen imports one body per solid (was 'import each separately')
  'BO-2': { verdict: 'WORKS' },
  'FO-1': { verdict: 'WORKS' }, // availability only - no operation executed
  'HM-1': { verdict: 'WORKS' },
  // STL
  'SPP-1': { verdict: 'WORKS' }, // WO-2802
  'SPP-2': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SPP-3': { verdict: 'WORKS' },
  'SPP-4': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SPP-5': { verdict: 'WORKS' }, // WO-2803: STL counterbore floor takes Push/Pull
  'SPP-6': { verdict: 'WRONG' }, // countersink carried up lopsided
  'SPP-8': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SPP-9': { verdict: 'WORKS' },
  'SFI-1': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SFI-2': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SFI-3': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SFI-4': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SFI-5': { verdict: 'WORKS' },
  'SCH-1': { verdict: 'WORKS' }, // WO-2802
  'SCH-2': { verdict: 'WORKS' },
  'SRH-1': { verdict: 'WORKS' }, // WO-2762: the STL counterbore step alone goes to d12
  'SRH-2': { verdict: 'WORKS' },
  'SRH-3': { verdict: 'WORKS' },
  'SRH-4': { verdict: 'WORKS' },
  'SDF-1': { verdict: 'WORKS' },
  'SDF-2': { verdict: 'WORKS' },
  'SDF-3': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  // WO-2798 recognizes the foot fillet (one removable item); the boss itself still cannot be picked.
  'SDF-4': { verdict: 'WORKS' }, // WO-2802
  'SDF-5': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SDF-6': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SDF-7': { verdict: 'WORKS' }, // WO-2802
  'SDF-8': { verdict: 'WORKS' }, // WO-2798: STL route carries the blend
  'SHO-1': { verdict: 'WORKS' },
  'SSH-1': { verdict: 'WORKS' },
  'SDR-1': { verdict: 'WORKS' },
  'SFO-1': { verdict: 'WORKS' }, // availability only
  'SED-1': { verdict: 'REFUSES', message: /re-open not driven yet/ }, // WO-2803: the tree row now exists; this cell does not drive the re-open - modelScreenLeftovers.wo2803 proves it on the production route (+2 -> +3, hand volume, Undo)
  'SHM-1': { verdict: 'WORKS' },
}

function record(cell: string, outcome: Outcome): Outcome {
  // One line per cell - the audit doc's matrix is transcribed from these.
  console.log(`WO-2757 CELL ${cell} ${JSON.stringify(outcome)}`)
  const want = EXPECTED[cell]
  expect(want, `cell ${cell} has no pinned outcome`).toBeDefined()
  expect(outcome.verdict, `${cell}: ${outcome.message}`).toBe(want.verdict)
  if (want.message !== undefined) expect(outcome.message).toMatch(want.message)
  // A WORKS cell must rest on an independent oracle: a hand-formula volume
  // (expectedDelta) or a named shape/state check - never "it applied".
  if (outcome.verdict === 'WORKS') {
    const { expectedDelta, check } = outcome.detail
    expect(typeof expectedDelta === 'number' || typeof check === 'string', `${cell}: WORKS without a geometric oracle`).toBe(true)
  }
  return outcome
}

/** Judge an applied cell whose hand formula is only known after the edit
 *  (it reads the feature's own payload, or is too long to inline). */
function againstFormula(o: Outcome, expectedDelta: number, tol = 0.002): Outcome {
  if (o.verdict !== 'WORKS') return o
  const delta = Number(o.detail.volumeDelta)
  const detail = { ...o.detail, expectedDelta: Number(expectedDelta.toFixed(3)) }
  if (Math.abs(delta - expectedDelta) > Math.max(tol * Math.abs(expectedDelta), 0.05)) {
    return { verdict: 'WRONG', message: `volume changed by ${delta}, expected ${expectedDelta.toFixed(3)}`, detail }
  }
  return { ...o, detail }
}

// ---------------------------------------------------------------- STEP route

interface StepSession { runtime: FakeSceneRuntime; volume: number }

/** Mount the Model screen on the real kernel and import `path` through the
 *  screen's own Import input (the button's hidden file input). */
async function openStep(path: string, bodyIds: string[] = ['IMP1']): Promise<StepSession> {
  const runtime = createFakeSceneRuntime()
  // Anchored value entries render only while their anchor projects on screen.
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  const name = path.split(/[\\/]/).pop()!
  fireEvent.change(input, { target: { files: [new File([bytesOf(path)], name, { type: 'application/octet-stream' })] } })
  try {
    for (const id of bodyIds) {
      await waitFor(() => expect(hooks().getBodyHandle(id)).not.toBeUndefined(), { timeout: 30_000 })
      await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30_000 })
    }
  } catch (e) {
    throw new Error(`import of ${name} did not produce ${bodyIds.join(',')}: features [${hooks().dag.featureOrder().join(',')}] ${text('workbench-status-bodies')}; IMP1 ${hooks().scheduler.statusOf('IMP1')} ${JSON.stringify(hooks().scheduler.diagnosticsOf('IMP1'))}`, { cause: e })
  }
  return { runtime, volume: await volumeOf(bodyIds[0]) }
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

interface FaceInfo { id: StableId; type: string; centroid: V3; normal: V3; min: V3; max: V3; aim: { point: V3; normal: V3 } }

/** Every face of a live body: kernel surface class, triangle-area-weighted
 *  centroid/normal and bounds, plus the largest triangle to aim a ray at. */
async function facesOf(featureId: string): Promise<FaceInfo[]> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const mesh = await hooks().client.tessellate(h, { deflection: 0.05 })
  const acc = mesh.faceIds.map(() => ({ a: 0, c: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 0 }, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity }, best: -1, bestA: 0 }))
  const p = (i: number): V3 => ({ x: mesh.position[i * 3], y: mesh.position[i * 3 + 1], z: mesh.position[i * 3 + 2] })
  for (let t = 0; t < mesh.triFace.length; t++) {
    const f = acc[mesh.triFace[t]]
    const [a, b, c] = [p(mesh.index[t * 3]), p(mesh.index[t * 3 + 1]), p(mesh.index[t * 3 + 2])]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    const cr = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
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
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    const cr = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
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
  const hits = faces.filter(test)
  if (hits.length === 0) throw new Error(`no face matches ${label}: ${JSON.stringify(faces.map((f) => [f.type, f.centroid, f.normal]))}`)
  return hits[0]
}

/** Aim the viewport ray straight down a face's own outward normal. */
function aimAtFace(runtime: FakeSceneRuntime, f: FaceInfo): void {
  const { point, normal } = f.aim
  runtime.rayOverride = {
    origin: { x: point.x + normal.x * 0.5, y: point.y + normal.y * 0.5, z: point.z + normal.z * 0.5 },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

/** Aim at a world point from `from` (both in mm). */
function aimAt(runtime: FakeSceneRuntime, from: V3, to: V3): void {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const l = Math.hypot(d.x, d.y, d.z)
  runtime.rayOverride = { origin: from, direction: { x: d.x / l, y: d.y / l, z: d.z / l } }
}

function click(): void {
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

const FO_BUTTONS = ['workbench-form', 'workbench-relief', 'workbench-extrude', 'workbench-revolve', 'workbench-sweep', 'workbench-loft', 'workbench-boolean', 'workbench-defeature', 'workbench-edit-feature']
const buttonStates = () => Object.fromEntries(FO_BUTTONS.map((id) => [id, (screen.getByTestId(id) as HTMLButtonElement).disabled ? 'disabled' : 'enabled']))
const FO_STATES_STEP = {
  'workbench-form': 'enabled', 'workbench-relief': 'enabled', 'workbench-extrude': 'disabled', 'workbench-revolve': 'disabled',
  'workbench-sweep': 'disabled', 'workbench-loft': 'disabled', 'workbench-boolean': 'disabled', 'workbench-defeature': 'enabled', 'workbench-edit-feature': 'disabled',
}
// Measured on one STL mesh body: Boolean is offered (the mesh route's own
// body Boolean), Relief is not.
const FO_STATES_STL = { ...FO_STATES_STEP, 'workbench-relief': 'disabled', 'workbench-boolean': 'enabled' }
function newFeatureId(before: string[]): string | undefined {
  return hooks().dag.featureOrder().find((id) => !before.includes(id))
}

/** After an Apply: did a feature land, replay ok, and change the volume by
 *  what the edit means? `expectedDelta` null = no analytic check. */
async function judgeApplied(before: string[], startVolume: number, expectedDelta: number | null, tol = 0.002): Promise<Outcome> {
  let id: string | undefined
  try {
    await waitFor(() => {
      id = newFeatureId(before)
      expect(id).toBeDefined()
      expect(['ok', 'failed']).toContain(hooks().scheduler.statusOf(id!))
    }, { timeout: 60_000 })
  } catch {
    return { verdict: 'CRASH', message: 'no feature landed after Apply', detail: {} }
  }
  const status = hooks().scheduler.statusOf(id!)
  if (status !== 'ok') {
    const diag = hooks().scheduler.diagnosticsOf(id!)
    return { verdict: 'REFUSES', message: `feature ${id} ${status}: ${JSON.stringify(diag)}`, detail: { id } }
  }
  await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
  const after = await volumeOf(id!)
  const delta = after - startVolume
  const detail = { id, opType: hooks().dag.getNode(id!)?.payload.opType, volumeDelta: Number(delta.toFixed(3)), expectedDelta }
  if (expectedDelta !== null && Math.abs(delta - expectedDelta) > Math.max(tol * Math.abs(expectedDelta), 0.05)) {
    return { verdict: 'WRONG', message: `volume changed by ${delta.toFixed(3)}, expected ${expectedDelta.toFixed(3)}`, detail }
  }
  return { verdict: 'WORKS', message: 'applied', detail }
}

// --- Push/Pull (kernel route): typed two-stage entry, Enter previews, Enter applies.
async function pushPullStep(s: StepSession, face: FaceInfo, delta: number, expectedDelta: number | null): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  aimAtFace(s.runtime, face)
  click()
  const hint = () => screen.queryByTestId('solids-workbench-pushpull-hint')
  const refused = () => hint()?.className.includes('refusal') === true
  try {
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') !== null || refused()).toBe(true), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `pick did not mount: ${hint()?.textContent ?? '(no hint)'}`, detail: {} }
  }
  if (refused()) return { verdict: 'REFUSES', message: hint()?.textContent ?? '', detail: { stage: 'pick' } }
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
    return { verdict: 'REFUSES', message, detail: { stage: 'preview' } }
  }
  fireEvent.keyDown(screen.getByTestId('pushpull-delta-entry-input'), { key: 'Enter' })
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') === null || refused()).toBe(true), { timeout: 60_000 })
  if (refused()) return { verdict: 'REFUSES', message: hint()?.textContent ?? '', detail: { stage: 'apply' } }
  return judgeApplied(before, s.volume, expectedDelta)
}

describe('WO-2757 STEP: the owner dome row (10-10 screenshot)', () => {
  it('PP-1 dome-on-plate: +3 mm on the flat top face next to the dome (the owner 10-10 screenshot) - WORKS since WO-2760', async () => {
    const s = await openStep(DOME_STEP)
    const faces = await facesOf('IMP1')
    const top = findFace(faces, 'plate top', (f) => f.type === 'plane' && f.normal.z > 0.99 && Math.abs(f.centroid.z - 10) < 1e-3)
    // Correct result: block 40x40x13 fused with the same dome. The dome
    // already fills the face's circular opening for z 10..13, so the true
    // volume gain is the plate-top area (40x40 minus the r 11.83 opening)
    // times 3 plus the dome's own slab between z 10 and 13 that now sits
    // inside the block = 40*40*3 minus the dome-in-slab volume already there.
    // = 40*40*3 - pi * integral of (144 - (z-12)^2) over z 10..13 = 4800 - 429 pi.
    const o = record('PP-1', await pushPullStep(s, top, 3, 40 * 40 * 3 - PI * 429))
    expect(o.verdict).toBe('WORKS')
  }, 180_000)
})

// --- Dress-up tools (Fillet / Chamfer / Shell / Hole): button, pick(s), field, preview, Apply.
const text = (testId: string) => screen.queryByTestId(testId)?.textContent ?? ''
const statusOf = (testId: string) => screen.queryByTestId(testId)?.getAttribute('data-status') ?? null

async function previewThenApply(tool: string, s: StepSession, before: string[], expectedDelta: number | null): Promise<Outcome> {
  const statusId = `${tool}-preview-status`
  try {
    await waitFor(() => {
      const st = statusOf(statusId)
      expect(st !== null && st !== 'pending' && st !== 'idle').toBe(true)
    }, { timeout: 60_000 })
  } catch {
    return { verdict: 'REFUSES', message: `no preview: ${text(statusId) || text('solids-workbench-dressup-hint')}`, detail: { stage: 'preview' } }
  }
  if (statusOf(statusId) !== 'ready') {
    return { verdict: 'REFUSES', message: text(statusId), detail: { stage: 'preview', status: statusOf(statusId) } }
  }
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  return judgeApplied(before, s.volume, expectedDelta)
}

async function waitCount(testId: string, pattern: RegExp): Promise<boolean> {
  try {
    await waitFor(() => expect(text(testId)).toMatch(pattern), { timeout: PICK_WAIT })
    return true
  } catch { return false }
}

/** Fillet/Chamfer: picks are edges or (on an imported blend) the blend face. */
async function blendStep(tool: 'fillet' | 'chamfer', s: StepSession, picks: Array<() => void>, value: string, expectedDelta: number | null): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId(`workbench-${tool}`))
  for (const pick of picks) { pick(); click() }
  if (!await waitCount(`${tool}-edge-count`, /[1-9]\d* edge/)) {
    return { verdict: 'REFUSES', message: `pick not taken: ${text(`${tool}-edge-count`) || text('solids-workbench-dressup-hint')}`, detail: { stage: 'pick' } }
  }
  const edges = text(`${tool}-edge-count`)
  const field = tool === 'fillet' ? 'fillet-radius' : 'chamfer-distance'
  const measured = (screen.getByTestId(field).querySelector('input') as HTMLInputElement).value
  commitField(field, value)
  const o = await previewThenApply(tool, s, before, expectedDelta)
  return { ...o, detail: { ...o.detail, edges, measured } }
}

async function shellStep(s: StepSession, openFace: FaceInfo, thickness: string): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-shell'))
  aimAtFace(s.runtime, openFace); click()
  if (!await waitCount('shell-face-count', /1 face/)) {
    return { verdict: 'REFUSES', message: `pick not taken: ${text('shell-face-count') || text('solids-workbench-dressup-hint')}`, detail: { stage: 'pick' } }
  }
  commitField('shell-thickness', thickness)
  return previewThenApply('shell', s, before, null)
}

async function draftStep(s: StepSession, neutral: FaceInfo, drafted: FaceInfo, angle: string): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-draft'))
  aimAtFace(s.runtime, neutral); click()
  if (!await waitCount('draft-neutral-face-role', /confirm this role/i)) {
    return { verdict: 'REFUSES', message: `neutral pick not taken: ${text('draft-neutral-face-role') || text('solids-workbench-dressup-hint')}`, detail: { stage: 'pick' } }
  }
  fireEvent.click(screen.getByTestId('draft-confirm-neutral'))
  aimAtFace(s.runtime, drafted); click()
  if (!await waitCount('draft-face-role', /1 draft face selected/i)) {
    return { verdict: 'REFUSES', message: `draft face pick not taken: ${text('draft-face-role') || text('solids-workbench-dressup-hint')}`, detail: { stage: 'pick' } }
  }
  commitField('draft-angle', angle)
  return previewThenApply('draft', s, before, null)
}

async function holeStep(s: StepSession, face: FaceInfo, diameter: string, depth: string, expectedDelta: number | null): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-hole'))
  aimAtFace(s.runtime, face); click()
  try {
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy(), { timeout: 20_000 })
  } catch {
    return { verdict: 'REFUSES', message: `pick not taken: ${text('solids-workbench-dressup-hint')}`, detail: { stage: 'pick' } }
  }
  commitField('hole-diameter', diameter)
  commitField('hole-blind-distance', depth)
  return previewThenApply('hole', s, before, expectedDelta)
}

// --- Resize Hole (kernel route): arm, pick the hole wall, type, preview, Apply.
async function resizeHoleStep(s: StepSession, wall: FaceInfo, diameter: string, expectedDelta: number | null): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-resize-hole'))
  await waitFor(() => expect(text('solids-workbench-resizehole-hint')).not.toMatch(/recognizing/i), { timeout: 30_000 })
  aimAtFace(s.runtime, wall); click()
  try {
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
  } catch {
    return { verdict: 'REFUSES', message: `pick not taken: ${text('solids-workbench-resizehole-hint')}`, detail: { stage: 'pick' } }
  }
  const current = text('resize-hole-anchor-entry-current')
  fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: diameter } })
  try {
    await waitFor(() => expect(['ready', 'refused']).toContain(statusOf('resize-hole-anchor-entry-status')), { timeout: 60_000 })
  } catch {
    return { verdict: 'REFUSES', message: `no preview: ${text('resize-hole-anchor-entry-status')}`, detail: { stage: 'preview', current } }
  }
  if (statusOf('resize-hole-anchor-entry-status') === 'refused') {
    return { verdict: 'REFUSES', message: text('resize-hole-anchor-entry-status'), detail: { stage: 'preview', current } }
  }
  fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
  const o = await judgeApplied(before, s.volume, expectedDelta)
  return { ...o, detail: { ...o.detail, current } }
}

// --- Defeature (kernel route): open the card, click the feature, preview, Apply.
async function defeatureStep(s: StepSession, face: FaceInfo, expectedDelta: number | null): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-defeature'))
  try {
    await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy(), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: 'Defeature card did not open', detail: {} }
  }
  aimAtFace(s.runtime, face); click()
  const state = () => screen.queryByTestId('defeature-preview-status')?.getAttribute('data-state') ?? null
  try {
    await waitFor(() => expect(['ready', 'failed']).toContain(state()), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `nothing picked/previewed: ${text('defeature-summary')} ${text('defeature-preview-status')}`, detail: { stage: 'pick' } }
  }
  const summary = text('defeature-summary')
  if (state() !== 'ready') return { verdict: 'REFUSES', message: text('defeature-preview-status'), detail: { stage: 'preview', summary } }
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  const o = await judgeApplied(before, s.volume, expectedDelta)
  return { ...o, detail: { ...o.detail, summary } }
}

/** How long a pick may take to register before the cell calls it not taken. */
const PICK_WAIT = 8_000
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol
const at = (f: FaceInfo, x: number, y: number, r = 1) => Math.hypot(f.centroid.x - x, f.centroid.y - y) < r
const PI = Math.PI
const TAN3 = Math.tan(3 * PI / 180)
/** Concave/convex r-blend ring (Pappus): the (1 - PI/4) r^2 section sits
 *  r(10 - 3PI)/(12 - 3PI) out from the corner it fills. */
const BLEND_CENTROID = (10 - 3 * PI) / (12 - 3 * PI)
// WO-2766 blend-chain parts (the same hand formulas blendChains.wo2766 asserts).
const blendSection = (r: number) => (1 - PI / 4) * r * r
/** boss_fillet_base: concave ring at the foot of a d20 boss. */
const bossFoot = (r: number) => blendSection(r) * 2 * PI * (10 + r * BLEND_CENTROID)
/** fillet_chain / chamfer_chain: the top loop of a 60x40 block with r6 vertical
 *  corners - 152 straight plus four quarter-turns round the r6 corner axes. */
const topFillet = (r: number) => blendSection(r) * (152 + 2 * PI * (6 - r * BLEND_CENTROID))
const topChamfer = (d: number) => d * d / 2 * (152 + 2 * PI * (6 - d / 3))
/** pocket_floor_fillet: the floor loop of a 30x20 pocket with r5 corners. */
const floorFillet = (r: number) => blendSection(r) * (60 + 2 * PI * (5 - r * BLEND_CENTROID))

/** WO-2799 Shell oracle on pocket_floor_fillet (two pieces once the top ring is open): the part is a 60x40x20 block less a
 *  30x20x8 r5-cornered pocket plus its r2 floor-fillet ring; the outer piece is the open box 60x40x20 less its inner box;
 *  the pocket skin is WO-2799's independent section integration (src/tests/evidence/WO-2799/). */
const POCKET_PART = 60 * 40 * 20 - (30 * 20 - (4 - PI) * 25) * 8 + floorFillet(2)
const pocketShellDelta = (t: number, pocketSkin: number) => 60 * 40 * 20 - (60 - 2 * t) * (40 - 2 * t) * (20 - t) + pocketSkin - POCKET_PART
async function shellWithOracle(o: Outcome, expectedDelta: number): Promise<Outcome> {
  if (o.verdict !== 'WORKS') return o
  const d = Number(o.detail.volumeDelta)
  return { ...o, verdict: Math.abs(d - expectedDelta) < Math.abs(expectedDelta) * 0.005 ? 'WORKS' : 'WRONG', detail: { ...o.detail, expectedDelta } }
}

// Hand formulas the kernel is NOT asked for. Dome part (fix_freeform.step):
// block 40x40x10 + sphere r12 centred (20,20,12), cap above z 10 meets the
// top in a circle r sqrt(140).
const DOME_C = { x: 20, y: 20, z: 12 }
const DOME_R = 12
const insideDomePart = (x: number, y: number, z: number) =>
  (x >= 0 && x <= 40 && y >= 0 && y <= 40 && z >= 0 && z <= 10) ||
  (x - DOME_C.x) ** 2 + (y - DOME_C.y) ** 2 + (z - DOME_C.z) ** 2 <= DOME_R ** 2

/** Volume a constant-thickness shell (bottom open) removes from the dome
 *  part: every point at least `t` from the top, sides, plate top and dome.
 *  Below z = 10 - t that is the 40-2t square; above it the region is round
 *  about the dome axis, integrated in (rho, z). */
function domeShellRemoved(t: number): number {
  const rj = Math.sqrt(DOME_R ** 2 - (10 - DOME_C.z) ** 2)
  const h = 0.005
  let v = 0
  for (let z = 10 - t + h / 2; z < DOME_C.z + DOME_R; z += h) {
    for (let r = h / 2; r < DOME_R + 0.5; r += h) {
      if (z > 10 && r * r + (z - DOME_C.z) ** 2 > DOME_R ** 2) continue
      const dRim = Math.hypot(r - rj, z - 10)
      const dTop = r >= rj ? Math.abs(z - 10) : dRim
      const len = Math.hypot(r, z - DOME_C.z)
      const dCap = DOME_C.z + DOME_R * (z - DOME_C.z) / len >= 10 ? Math.abs(DOME_R - len) : dRim
      if (Math.min(dTop, dCap) >= t) v += 2 * PI * r * h * h
    }
  }
  return (40 - 2 * t) ** 2 * (10 - t) + v
}

/** Material a cylinder (radius r, along -n from `seed`, `depth` long) takes
 *  out of the dome part - midpoint quadrature over the cylinder. */
function domeHoleRemoved(seed: V3, n: V3, r: number, depth: number): number {
  const nl = Math.hypot(n.x, n.y, n.z)
  const w = { x: n.x / nl, y: n.y / nl, z: n.z / nl }
  const a = Math.abs(w.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const u0 = { x: a.y * w.z - a.z * w.y, y: a.z * w.x - a.x * w.z, z: a.x * w.y - a.y * w.x }
  const ul = Math.hypot(u0.x, u0.y, u0.z)
  const u = { x: u0.x / ul, y: u0.y / ul, z: u0.z / ul }
  const v = { x: w.y * u.z - w.z * u.y, y: w.z * u.x - w.x * u.z, z: w.x * u.y - w.y * u.x }
  const h = 0.02
  let vol = 0
  for (let i = -r + h / 2; i < r; i += h) {
    for (let j = -r + h / 2; j < r; j += h) {
      if (i * i + j * j > r * r) continue
      for (let k = h / 2; k < depth; k += h) {
        const p = { x: seed.x + i * u.x + j * v.x - k * w.x, y: seed.y + i * u.y + j * v.y - k * w.y, z: seed.z + i * u.z + j * v.z - k * w.z }
        if (insideDomePart(p.x, p.y, p.z)) vol += h * h * h
      }
    }
  }
  return vol
}

/** Union of the boss part (plate 60x60x10, d20 x 12 boss at (30,30), r3 foot
 *  fillet) and the rib part (base 60x40x5, ribs 50x3x15 at y 8..11 and
 *  29..32): the shared volume is the whole rib base, both ribs' z 5..10, and
 *  where the y 29..32 rib passes through the boss above z 10 (the r10 chord
 *  strip x 10 tall plus the fillet ring inside the strip). */
function bossRibOverlap(): number {
  const strip = (t: number) => t * Math.sqrt(100 - t * t) + 100 * Math.asin(t / 10)
  const h = 0.002
  let fillet = 0
  for (let x = 17 + h / 2; x < 43; x += h) {
    for (let y = 29 + h / 2; y < 32; y += h) {
      const r = Math.hypot(x - 30, y - 30)
      if (r >= 10 && r <= 13) fillet += (3 - Math.sqrt(9 - (13 - r) ** 2)) * h * h
    }
  }
  return 60 * 40 * 5 + 2 * 50 * 3 * 5 + 10 * (strip(2) - strip(-1)) + fillet
}

describe('WO-2757 STEP: Push/Pull, Fillet, Chamfer, Shell, Draft, Hole, Resize Hole, Defeature', () => {
  it('PP-2 boss with base fillet: +3 mm on the plate top whose neighbour is the fillet', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const top = findFace(await facesOf('IMP1'), 'plate top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 10))
    // Correct: plate 60x60 grows 3 mm; the boss and its fillet ride up with
    // the new top (fillet kept at the boss foot) = 60*60*3 minus the boss's
    // own d20 core already there = 3*(3600 - 100*PI).
    const o = record('PP-2', await pushPullStep(s, top, 3, 3 * (3600 - 100 * PI)))
    await captureStep('PP-2', 'plate top +3 mm beside the filleted boss - the foot fillet rides up with the plate top', o.detail.id, 'y', 30)
  }, 180_000)

  it('PP-3 boss top: +2 mm (neighbour is the boss cylinder)', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const top = findFace(await facesOf('IMP1'), 'boss top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 22))
    record('PP-3', await pushPullStep(s, top, 2, 2 * 100 * PI))
  }, 180_000)

  it('PP-4 fillet chain: +2 mm on the top face bounded by the r2 chain', async () => {
    const s = await openStep(part('fillet_chain.step'))
    const top = findFace(await facesOf('IMP1'), 'top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 20))
    // Correct: the part gets 2 mm taller, chain kept = full r6-cornered
    // section 60x40 times 2.
    const o = record('PP-4', await pushPullStep(s, top, 2, 2 * (2400 - (4 - PI) * 36)))
    await captureStep('PP-4', 'top +2 mm inside the r2 fillet chain - the chain rides up with the top', o.detail.id, 'y', 20)
  }, 180_000)

  it('PP-5 counterbore floor: -2 mm (deepen just the counterbore step)', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const floor = findFace(await facesOf('IMP1'), 'cbore floor', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 8.5) && at(f, 15, 20))
    record('PP-5', await pushPullStep(s, floor, -2, -2 * PI * (5.5 ** 2 - 3.3 ** 2)))
  }, 180_000)

  it('PP-6 counterbore wall (cylinder): +0.5 mm', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'cbore wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8)
    // d11 counterbore 6.5 deep: radius 5.5 -> 6.0 over its height.
    record('PP-6', await pushPullStep(s, wall, 0.5, -PI * (6 ** 2 - 5.5 ** 2) * 6.5))
  }, 180_000)

  it('PP-7 countersink cone face: +0.5 mm', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const cone = findFace(await facesOf('IMP1'), 'csk cone', (f) => f.type === 'cone' && at(f, 35, 20))
    // d13/d6.6 90 deg countersink: top radius 6.5 -> 6.5 + 0.5/cos 45; cone to the d6.6 pilot.
    const removed = (r: number) => PI * (r - 3.3) / 3 * (r * r + r * 3.3 + 3.3 * 3.3) - PI * 3.3 ** 2 * (r - 3.3)
    record('PP-7', await pushPullStep(s, cone, 0.5, -(removed(6.5 + 0.5 * Math.SQRT2) - removed(6.5))))
  }, 180_000)

  it('PP-8 pocket floor with floor fillets: -2 mm (deepen the pocket)', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const floor = findFace(await facesOf('IMP1'), 'pocket floor', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 12))
    // Correct: the whole r5-cornered 30x20 pocket deepens 2 mm, floor fillets kept.
    const o = record('PP-8', await pushPullStep(s, floor, -2, -2 * (600 - (4 - PI) * 25)))
    await captureStep('PP-8', 'pocket floor -2 mm inside the floor fillets - the fillets go down with the floor', o.detail.id, 'y', 20)
  }, 180_000)

  it('PP-9 rib side face: +1 mm (thicken a rib)', async () => {
    const s = await openStep(part('rib_part.step'))
    const side = findFace(await facesOf('IMP1'), 'rib side', (f) => f.type === 'plane' && f.normal.y < -0.99 && near(f.centroid.y, 8))
    record('PP-9', await pushPullStep(s, side, 1, 50 * 15))
  }, 180_000)

  it('PP-10 rib top: +2 mm (taller rib)', async () => {
    const s = await openStep(part('rib_part.step'))
    const top = findFace(await facesOf('IMP1'), 'rib top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 20) && f.max.y < 12)
    record('PP-10', await pushPullStep(s, top, 2, 50 * 3 * 2))
  }, 180_000)

  it('PP-12 tapered boss: +2 mm on the base top whose neighbour is the cone', async () => {
    const s = await openStep(resolve(process.cwd(), 'test_fixtures/brep/fix_boss_taper.step'))
    const top = findFace(await facesOf('IMP1'), 'base top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 10))
    // Correct: block grows to z 12 and buries the cone's lowest 2 mm =
    // 60*60*2 minus the frustum slice z 10..12 (r 15 -> 14).
    const o = record('PP-12', await pushPullStep(s, top, 2, 3600 * 2 - PI * 2 / 3 * (15 ** 2 + 15 * 14 + 14 ** 2)))
    await captureStep('PP-12', 'base top +2 mm beside the tapered boss - the base meets the cone', o.detail.id, 'y', 30)
  }, 180_000)

  it('FI-1 boss base fillet: change r3 -> r4 from the blend face', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const blend = findFace(await facesOf('IMP1'), 'base fillet', (f) => f.type === 'torus')
    record('FI-1', await blendStep('fillet', s, [() => aimAtFace(s.runtime, blend)], '4', bossFoot(4) - bossFoot(3)))
  }, 180_000)

  it('FI-2 fillet chain: change one straight member r2 -> r3', async () => {
    const s = await openStep(part('fillet_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chain straight member', (f) => f.type === 'cylinder' && f.min.z > 17 && f.normal.y < -0.5)
    record('FI-2', await blendStep('fillet', s, [() => aimAtFace(s.runtime, member)], '3', -(topFillet(3) - topFillet(2))))
  }, 180_000)

  it('FI-3 fillet chain: change the corner (torus) member r2 -> r3', async () => {
    const s = await openStep(part('fillet_chain.step'))
    const corner = findFace(await facesOf('IMP1'), 'chain corner', (f) => f.type === 'torus' && f.min.z > 17)
    record('FI-3', await blendStep('fillet', s, [() => aimAtFace(s.runtime, corner)], '3', -(topFillet(3) - topFillet(2))))
  }, 180_000)

  it('FI-4 pocket floor fillet: change r2 -> r3', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const blend = findFace(await facesOf('IMP1'), 'floor fillet', (f) => f.type === 'cylinder' && f.max.z < 14.5 && f.min.z > 11.5 && Math.abs(f.normal.z) > 0.3)
    record('FI-4', await blendStep('fillet', s, [() => aimAtFace(s.runtime, blend)], '3', floorFillet(3) - floorFillet(2)))
  }, 180_000)

  it('FI-5 new r1 fillet on a sharp rib top edge', async () => {
    const s = await openStep(part('rib_part.step'))
    record('FI-5', await blendStep('fillet', s, [() => aimAt(s.runtime, { x: 30, y: -12, z: 40 }, { x: 30, y: 8, z: 20 })], '1', -(1 - PI / 4) * 50))
  }, 180_000)

  it('CH-1 chamfer chain: change one chamfer member 2 -> 3 from its face', async () => {
    const s = await openStep(part('chamfer_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chamfer member', (f) => f.type === 'plane' && f.normal.y < -0.5 && f.normal.z > 0.5)
    record('CH-1', await blendStep('chamfer', s, [() => aimAtFace(s.runtime, member)], '3', -(topChamfer(3) - topChamfer(2))))
  }, 180_000)

  it('CH-2 new 1 mm chamfer on a sharp rib top edge', async () => {
    const s = await openStep(part('rib_part.step'))
    record('CH-2', await blendStep('chamfer', s, [() => aimAt(s.runtime, { x: 30, y: -12, z: 40 }, { x: 30, y: 8, z: 20 })], '1', -0.5 * 50))
  }, 180_000)

  it('CH-3 new 0.5 mm chamfer on the counterbore top rim', async () => {
    const s = await openStep(part('stepped_holes.step'))
    record('CH-3', await blendStep('chamfer', s, [() => aimAt(s.runtime, { x: 15 + 5.5 + 10, y: 20, z: 25 }, { x: 15 + 5.5, y: 20, z: 15 })], '0.5', -(0.5 ** 2 / 2) * 2 * PI * (5.5 + 0.5 / 3)))
  }, 180_000)

  it('SH-1 shell the pocket block, opening the top', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const top = findFace(await facesOf('IMP1'), 'top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 20, 1))
    record('SH-1', await shellWithOracle(await shellStep(s, top, '2'), pocketShellDelta(2, 2849.363721)))
  }, 180_000)

  it('SH-2 shell the dome-on-plate, opening the bottom', async () => {
    const s = await openStep(DOME_STEP)
    const bottom = findFace(await facesOf('IMP1'), 'bottom', (f) => f.type === 'plane' && f.normal.z < -0.99)
    // Correct: constant 2 mm wall everywhere but the open bottom (hand
    // integration in domeShellRemoved).
    record('SH-2', againstFormula(await shellStep(s, bottom, '2'), -domeShellRemoved(2)))
  }, 180_000)

  it('DR-1 draft a rib side 3 deg from the base top', async () => {
    const s = await openStep(part('rib_part.step'))
    const faces = await facesOf('IMP1')
    const neutral = findFace(faces, 'base top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 5))
    const side = findFace(faces, 'rib side', (f) => f.type === 'plane' && f.normal.y < -0.99 && near(f.centroid.y, 8))
    // Correct: the 50 long x 15 tall wall tips in about its foot, losing a
    // 3 deg wedge = 50 * 15^2 * tan 3 / 2.
    record('DR-1', againstFormula(await draftStep(s, neutral, side, '3'), -50 * 15 ** 2 * TAN3 / 2))
  }, 180_000)

  it('DR-2 draft a pocket wall 3 deg from the pocket floor (wall meets corner and floor fillets)', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const faces = await facesOf('IMP1')
    const floor = findFace(faces, 'pocket floor', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 12))
    const wall = findFace(faces, 'pocket wall', (f) => f.type === 'plane' && f.normal.y > 0.99 && near(f.centroid.y, 10, 0.5))
    { const o = await draftStep(s, floor, wall, '3'); record('DR-2', o.verdict === 'WORKS' ? { ...o, detail: { ...o.detail, check: 'signed 3 deg draft, neutral line at the floor and the restored r2/r5 radii are measured by shellDraftFilleted.wo2799 on the production route' } } : o) }
  }, 180_000)

  it('HO-1 new d5 x 3 hole on the rib part base top', async () => {
    const s = await openStep(part('rib_part.step'))
    const base = findFace(await facesOf('IMP1'), 'base top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 5))
    record('HO-1', await holeStep(s, base, '5', '3', -PI * 2.5 ** 2 * 3))
  }, 180_000)

  it('HO-2 new d5 x 3 hole on the dome (curved face)', async () => {
    const s = await openStep(DOME_STEP)
    const dome = findFace(await facesOf('IMP1'), 'dome', (f) => f.type === 'sphere')
    const o = await holeStep(s, dome, '5', '3', null)
    if (o.verdict !== 'WORKS') { record('HO-2', o); return }
    // Correct (WO-2794): a d5 cylinder 3 deep along the dome's normal at the
    // pick, from the pick carried onto the sphere, cut out of block + sphere
    // by quadrature. The feature's stored seed/normal come from the drawn
    // (tessellated) dome - the seed sits ~0.06 mm inside the sphere and the
    // facet normal is ~1.4 deg off the sphere's - so the axis is taken from
    // the sphere itself.
    const p = hooks().dag.getNode(String(o.detail.id))!.payload as { seed: V3; normal: V3; depth: { distance?: number } }
    const radial = { x: p.seed.x - DOME_C.x, y: p.seed.y - DOME_C.y, z: p.seed.z - DOME_C.z }
    const rl = Math.hypot(radial.x, radial.y, radial.z)
    const sn = { x: radial.x / rl, y: radial.y / rl, z: radial.z / rl }
    const onDome = { x: DOME_C.x + DOME_R * sn.x, y: DOME_C.y + DOME_R * sn.y, z: DOME_C.z + DOME_R * sn.z }
    const tilt = Math.acos(Math.min(1, (sn.x * p.normal.x + sn.y * p.normal.y + sn.z * p.normal.z) / Math.hypot(p.normal.x, p.normal.y, p.normal.z))) * 180 / PI
    const judged = againstFormula(o, -domeHoleRemoved(onDome, sn, 2.5, Number(p.depth.distance)), 0.01)
    // Which way was it actually drilled? The hole's flat floor is the plane
    // near the seed that faces back up the hole from deepest in; its normal
    // is the drilled axis.
    const rise = (f: FaceInfo) => (onDome.x - f.centroid.x) * f.normal.x + (onDome.y - f.centroid.y) * f.normal.y + (onDome.z - f.centroid.z) * f.normal.z
    const bottom = (await facesOf(String(o.detail.id))).filter((f) => f.type === 'plane' &&
      Math.hypot(f.centroid.x - onDome.x, f.centroid.y - onDome.y, f.centroid.z - onDome.z) < 6).sort((a, b) => rise(b) - rise(a))[0]
    const off = bottom === undefined ? null : Number((Math.acos(Math.min(1, Math.abs(bottom.normal.x * sn.x + bottom.normal.y * sn.y + bottom.normal.z * sn.z))) * 180 / PI).toFixed(4))
    const detail = { ...judged.detail, seed: p.seed, normal: p.normal, depth: p.depth, pickNormalTiltFromSphereNormalDeg: Number(tilt.toFixed(2)), drilledAxis: bottom?.normal, drilledAxisOffSphereNormalDeg: off }
    if (judged.verdict === 'WORKS' && !(off !== null && off < 0.01)) {
      record('HO-2', { verdict: 'WRONG', message: `drilled axis is ${off} deg off the dome normal at the pick`, detail })
      return
    }
    record('HO-2', judged.verdict === 'WRONG' ? { ...judged, message: `${judged.message}; drilled axis is ${off} deg off the dome normal at the pick`, detail } : { ...judged, detail })
    await captureStep('HO-2', 'd5 x 3 hole picked on the dome - drilled along the dome normal at the pick', o.detail.id, 'y', 20.75)
  }, 180_000)

  it('RH-1 plain d6 through hole -> d8', async () => {
    const s = await openStep(resolve(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'd6 at (20,20)', (f) => f.type === 'cylinder' && at(f, 20, 20))
    record('RH-1', await resizeHoleStep(s, wall, '8', -10 * PI * (16 - 9)))
  }, 180_000)

  it('RH-2 counterbore: change only the counterbore d11 -> d12', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'cbore wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8)
    record('RH-2', await resizeHoleStep(s, wall, '12', -6.5 * PI * (36 - 30.25)))
  }, 180_000)

  it('RH-3 counterbore: change only the through hole d6.6 -> d7', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'through wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.max.z < 9)
    record('RH-3', await resizeHoleStep(s, wall, '7', -8.5 * PI * (12.25 - 10.89)))
  }, 180_000)

  it('RH-5 tapped-size d5 -> d6', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'd5 wall', (f) => f.type === 'cylinder' && at(f, 55, 20))
    record('RH-5', await resizeHoleStep(s, wall, '6', -15 * PI * (9 - 6.25)))
  }, 180_000)

  it('DF-1 delete one d6 hole of the three-hole pattern', async () => {
    const s = await openStep(resolve(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'd6 at (50,20)', (f) => f.type === 'cylinder' && at(f, 50, 20))
    record('DF-1', await defeatureStep(s, wall, 10 * PI * 9))
  }, 180_000)

  it('DF-2 delete the counterbored hole (both steps)', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'cbore wall', (f) => f.type === 'cylinder' && at(f, 15, 20) && f.min.z > 8)
    record('DF-2', await defeatureStep(s, wall, PI * (6.5 * 30.25 + 8.5 * 10.89)))
  }, 180_000)

  it('DF-3 delete the countersunk hole', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const cone = findFace(await facesOf('IMP1'), 'csk cone', (f) => f.type === 'cone' && at(f, 35, 20))
    // Correct: refill the d6.6 pilot (z 0..11.8) and the 90 deg countersink
    // frustum (r 3.3 -> 6.5 over z 11.8..15).
    record('DF-3', await defeatureStep(s, cone, PI * (3.3 ** 2 * 11.8 + 3.2 / 3 * (3.3 ** 2 + 3.3 * 6.5 + 6.5 ** 2))))
  }, 180_000)

  it('DF-4 remove the boss base fillet', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const blend = findFace(await facesOf('IMP1'), 'base fillet', (f) => f.type === 'torus')
    // The r3 concave fillet ring at the foot of a d20 boss: section (1 - PI/4) r^2,
    // its centroid sits r(10 - 3PI)/(12 - 3PI) out from the wall (Pappus).
    const sec = (1 - PI / 4) * 9
    const cx = 10 + 3 * (10 - 3 * PI) / (12 - 3 * PI)
    record('DF-4', await defeatureStep(s, blend, -sec * 2 * PI * cx))
  }, 180_000)

  it('DF-5 remove the top fillet chain', async () => {
    const s = await openStep(part('fillet_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chain straight member', (f) => f.type === 'cylinder' && f.min.z > 17 && f.normal.y < -0.5)
    record('DF-5', await defeatureStep(s, member, topFillet(2)))
  }, 180_000)

  it('DF-6 remove the top chamfer chain', async () => {
    const s = await openStep(part('chamfer_chain.step'))
    const member = findFace(await facesOf('IMP1'), 'chamfer member', (f) => f.type === 'plane' && f.normal.y < -0.5 && f.normal.z > 0.5)
    record('DF-6', await defeatureStep(s, member, topChamfer(2)))
  }, 180_000)

  it('DF-7 remove the boss (with its base fillet)', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const wall = findFace(await facesOf('IMP1'), 'boss wall', (f) => f.type === 'cylinder')
    record('DF-7', await defeatureStep(s, wall, -(PI * 10 ** 2 * 12 + bossFoot(3))))
  }, 180_000)

  it('DF-8 remove the dome', async () => {
    const s = await openStep(DOME_STEP)
    const dome = findFace(await facesOf('IMP1'), 'dome', (f) => f.type === 'sphere')
    // Correct: the plate keeps its flat top; the sphere cap above z 10
    // (height 14 of r 12) goes = PI h^2 (3R - h) / 3.
    record('DF-8', await defeatureStep(s, dome, -PI * 14 ** 2 * (3 * DOME_R - 14) / 3))
  }, 180_000)

  it('DF-9 remove the floor fillets of the pocket', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const blend = findFace(await facesOf('IMP1'), 'floor fillet', (f) => f.type === 'cylinder' && f.max.z < 14.5 && f.min.z > 11.5 && Math.abs(f.normal.z) > 0.3)
    record('DF-9', await defeatureStep(s, blend, -floorFillet(2)))
  }, 180_000)
})

// ---------------------------------------------------------------- diagnosis helpers

/** What the kernel's recogniser calls the face a pick landed on - read only,
 *  so a pick that silently does nothing can say why. */
async function verdictsOn(featureId: string, face: FaceInfo): Promise<unknown[]> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  const all = await hooks().client.recognizeFeatures(h)
  return all.filter((v) => v.faceIds.includes(face.id)).map((v) => ({ key: v.featureKey, cls: v.featureClass, removable: v.removable, radius: v.params.radius }))
}

// ---------------------------------------------------------------- captures
// WO2757_CAPTURE=1 writes a section picture per WRONG cell into
// src/tests/evidence/WO-2757/: the part cut by a vertical plane, the imported
// shape in grey and the edited result in red, so the wrong geometry is visible
// (a moat, a plateau, a groove) without a WebGL screen. The cut is taken from
// the same tessellation the Model screen draws.

const CAPTURE = process.env.WO2757_CAPTURE === '1'
type Seg = [number, number, number, number]

/** Cut a triangle mesh with the plane `axis` = `at`; segments in the other
 *  horizontal axis (u) and z. */
function sectionOf(pos: ArrayLike<number>, idx: ArrayLike<number>, axis: 'x' | 'y', at: number): Seg[] {
  const a = axis === 'y' ? 1 : 0
  const u = axis === 'y' ? 0 : 1
  const out: Seg[] = []
  for (let t = 0; t < idx.length; t += 3) {
    const v = [idx[t], idx[t + 1], idx[t + 2]].map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]])
    const pts: Array<[number, number]> = []
    for (let k = 0; k < 3; k++) {
      const p = v[k]
      const q = v[(k + 1) % 3]
      const dp = p[a] - at
      const dq = q[a] - at
      if ((dp < 0 && dq >= 0) || (dp >= 0 && dq < 0)) {
        const f = dp / (dp - dq)
        pts.push([p[u] + f * (q[u] - p[u]), p[2] + f * (q[2] - p[2])])
      }
    }
    if (pts.length === 2) out.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]])
  }
  return out
}

async function applyHoleMove(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('move-hole-entry')).toBeTruthy())
  fireEvent.change(screen.getByTestId('move-hole-x'), { target: { value: '10' } })
  await waitFor(() => expect(statusOf('move-hole-status')).toMatch(/ready|refused/), { timeout: 30000 })
  expect(statusOf('move-hole-status'), text('move-hole-status')).toBe('ready')
  fireEvent.click(screen.getByTestId('move-hole-apply'))
  await waitFor(() => expect(screen.queryByTestId('move-hole-entry')).toBeNull())
}
function movedHoleSections(pos: ArrayLike<number>, idx: ArrayLike<number>): Record<string, number[]> {
  const lines = sectionOf(pos,idx,'y',20), result: Record<string,number[]> = {}
  for(const z of [2,8.49,8.51,10,11.79,11.81,14,14.99]) {
    const cb = z>8.5 ? 5.5 : 3.3, cs = z>11.8 ? 3.3+z-11.8 : 3.3
    const expected = [0,15-cb,15+cb,35-cs,35+cs,62.5,67.5,70]
    const xs = lines.flatMap(([a,b,c,d]) => (b<z&&d>=z)||(d<z&&b>=z) ? [a+(z-b)*(c-a)/(d-b)] : []).sort((a,b)=>a-b)
    const actual = xs.filter((v,i) => i===0 || v-xs[i-1]>.001)
    expect(actual, `new centre 65, old centre solid at z=${z}`).toHaveLength(expected.length)
    actual.forEach((x,i)=>expect(Math.abs(x-expected[i])).toBeLessThan(.03))
    result[String(z)] = actual
  }
  return result
}

function writeSectionSvg(cell: string, title: string, before: Seg[], after: Seg[], axis: 'x' | 'y', at: number): void {
  const all = [...before, ...after]
  const us = all.flatMap((s) => [s[0], s[2]])
  const zs = all.flatMap((s) => [s[1], s[3]])
  const [u0, u1, z0, z1] = [Math.min(...us) - 2, Math.max(...us) + 2, Math.min(...zs) - 2, Math.max(...zs) + 2]
  const scale = 760 / Math.max(u1 - u0, (z1 - z0) * 1.6)
  const W = Math.ceil((u1 - u0) * scale) + 40
  const H = Math.ceil((z1 - z0) * scale) + 90
  const X = (v: number) => (20 + (v - u0) * scale).toFixed(2)
  const Z = (v: number) => (70 + (z1 - v) * scale).toFixed(2)
  const lines = (segs: Seg[], color: string, width: number) => segs.map((s) =>
    `<line x1="${X(s[0])}" y1="${Z(s[1])}" x2="${X(s[2])}" y2="${Z(s[3])}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`).join('\n')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="20" y="24" font-family="sans-serif" font-size="16" font-weight="bold">${cell}: ${title}</text>
<text x="20" y="46" font-family="sans-serif" font-size="13">Section at ${axis} = ${at} mm (horizontal: ${axis === 'y' ? 'x' : 'y'}, vertical: z). Grey = imported part, red = result after the edit.</text>
${lines(before, '#9a9a9a', 4)}
${lines(after, '#d0302f', 1.6)}
</svg>
`
  writeFileSync(resolve(PARTS, `${cell}-section.svg`), svg)
}

async function captureStep(cell: string, title: string, resultId: unknown, axis: 'x' | 'y', at: number): Promise<void> {
  if (!CAPTURE || typeof resultId !== 'string') return
  const cut = async (id: string) => {
    const m = await hooks().client.tessellate(hooks().getBodyHandle(id) as BodyHandle, { deflection: 0.02 })
    return sectionOf(m.position, m.index, axis, at)
  }
  writeSectionSvg(cell, title, await cut('IMP1'), await cut(resultId), axis, at)
}

async function captureStl(cell: string, title: string, s: StlSession, axis: 'x' | 'y', at: number): Promise<void> {
  if (!CAPTURE) return
  const edit = await import('../../mesh/edit')
  const before = edit.resolveEditedStlMesh(s.bytes, undefined).mesh
  const after = edit.resolveEditedStlMesh(s.bytes, journalOf(s.id)).mesh
  writeSectionSvg(cell, title, sectionOf(before.positions, before.indices, axis, at), sectionOf(after.positions, after.indices, axis, at), axis, at)
}

describe('WO-2757 STEP: causes, Edit, Boolean, Import, rim blends, Shell', () => {
  it('FI-cause blend-face picks: what the recogniser calls each blend face a Fillet/Chamfer click lands on', async () => {
    const out: Record<string, unknown> = {}
    for (const [cell, file, label, test] of [
      ['FI-1', part('boss_fillet_base.step'), 'base fillet', (f: FaceInfo) => f.type === 'torus'],
      ['FI-2', part('fillet_chain.step'), 'chain member', (f: FaceInfo) => f.type === 'cylinder' && f.min.z > 17 && f.normal.y < -0.5],
      ['FI-3', part('fillet_chain.step'), 'chain corner', (f: FaceInfo) => f.type === 'torus' && f.min.z > 17],
      ['FI-4', part('pocket_floor_fillet.step'), 'floor fillet', (f: FaceInfo) => f.type === 'cylinder' && f.max.z < 14.5 && f.min.z > 11.5 && Math.abs(f.normal.z) > 0.3],
      ['CH-1', part('chamfer_chain.step'), 'chamfer member', (f: FaceInfo) => f.type === 'plane' && f.normal.y < -0.5 && f.normal.z > 0.5],
    ] as const) {
      await openStep(file)
      const face = findFace(await facesOf('IMP1'), label, test)
      out[cell] = await verdictsOn('IMP1', face)
      cleanup()
    }
    record('FI-cause', { verdict: 'REFUSES', message: 'recogniser verdicts on the picked blend faces', detail: out })
    // Why FI-1..4 and CH-1 were dead clicks: the imported-fillet edit only took
    // a removable 'absorbed:' fillet verdict. WO-2766: each blend face now also
    // carries the removable chain it belongs to, which Fillet/Chamfer edit.
    const cls = (cell: string) => (out[cell] as Array<{ cls: string; removable: boolean }>).map((v) => `${v.cls}/${v.removable}`)
    expect(cls('FI-1')).toEqual(['filletChain/true', 'filletCurvedCorner/false', 'boss/true'])
    expect(cls('FI-2')).toEqual(['filletChain/true', 'filletCurvedCorner/false'])
    expect(cls('FI-3')).toEqual(['filletChain/true', 'filletCurvedCorner/false'])
    expect(cls('FI-4')).toEqual(['filletChain/true', 'pocket/true'])
    expect(cls('CH-1')).toEqual(['chamferChain/true'])
  }, 300_000)

  it('PP-11 drafted pocket wall +1 mm: does the moved wall leave a lip above the deck?', async () => {
    const s = await openStep(resolve(process.cwd(), 'test_fixtures/brep/fix_feature_block.step'))
    const wall = findFace(await facesOf('IMP1'), 'drafted wall', (f) => f.type === 'plane' && Math.abs(f.normal.z) > 0.2 && Math.abs(f.normal.z) < 0.5 && f.max.x < 35)
    // WO-2767: the slab between the old and new wall planes, floor z 8 to
    // deck z 20, y 8..32 - 12 mm high and 1/cos 15 deg across.
    const o = await pushPullStep(s, wall, 1, 12 / Math.cos(15 * PI / 180) * 24)
    if (o.verdict !== 'WORKS') { record('PP-11', o); return }
    // Moving the 15 deg wall 1 mm along its normal lifts its top edge
    // 0.259 mm (sin 15 deg); a true face move re-trims the deck instead.
    // Any face of the result standing above the deck (z 20) between the
    // wall and the sphere cap (x 26..33) is that lip.
    const lip = (await facesOf(String(o.detail.id))).filter((f) => f.max.z > 20.05 && f.max.z < 21 && f.min.x > 26 && f.max.x < 33)
    const lipTop = lip.length === 0 ? null : Number(Math.max(...lip.map((f) => f.max.z)).toFixed(3))
    const r = record('PP-11', lip.length === 0 ? o : { ...o, verdict: 'WRONG', message: `a lip stands ${(lipTop! - 20).toFixed(3)} mm above the deck`, detail: { ...o.detail, lipTop } })
    await captureStep('PP-11', 'drafted wall +1 mm - the wall moves, deck and floor re-trim', r.detail.id, 'y', 20)
  }, 180_000)

  it('RH-4 countersunk hole d6.6 -> d7: does the countersink stay d13?', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'csk through wall', (f) => f.type === 'cylinder' && at(f, 35, 20))
    const o = await resizeHoleStep(s, wall, '7', null)
    if (o.verdict !== 'WORKS') { record('RH-4', o); return }
    const cone = (await facesOf(String(o.detail.id))).find((f) => f.type === 'cone' && at(f, 35, 20))
    const top = cone === undefined ? null : Number((cone.max.x - cone.min.x).toFixed(3))
    // WO-2762: the oracle for WORKS is the countersink's d13 top, measured on the result.
    const r = record('RH-4', top !== null && Math.abs(top - 13) < 0.05 ? { ...o, detail: { ...o.detail, countersinkTop: top, check: 'countersink top stays d13 (+-0.05)' } } : { ...o, verdict: 'WRONG', message: `asked for the d7 pilot only; the countersink top went 13 -> ${top}`, detail: { ...o.detail, countersinkTop: top } })
    await captureStep('RH-4', 'countersunk hole pilot 6.6 -> 7 - the countersink grows too', r.detail.id, 'y', 20)
  }, 180_000)

  it('ED-1 Edit: re-open a Push/Pull on an imported rib (+1 -> +2) from the tree', async () => {
    const s = await openStep(part('rib_part.step'))
    const side = findFace(await facesOf('IMP1'), 'rib side', (f) => f.type === 'plane' && f.normal.y < -0.99 && near(f.centroid.y, 8))
    const first = await pushPullStep(s, side, 1, 750)
    if (first.verdict !== 'WORKS') { record('ED-1', first); return }
    const id = String(first.detail.id)
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${id}`), { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry') ?? screen.queryByTestId('pushpull-distance')).toBeTruthy(), { timeout: 20_000 })
    if (screen.queryByTestId('pushpull-distance') !== null) {
      commitField('pushpull-distance', '2')
      fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    } else {
      const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
      fireEvent.change(input, { target: { value: '2' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(hooks().getPushPullTransactionState().gesture.inFlight).toBe(false), { timeout: 30_000 })
      fireEvent.keyDown(screen.getByTestId('pushpull-delta-entry-input'), { key: 'Enter' })
    }
    try {
      await waitFor(() => expect(Number(hooks().dag.getNode(id)?.payload.delta)).toBe(2), { timeout: 30_000 })
      await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30_000 })
    } catch {
      record('ED-1', { verdict: 'REFUSES', message: `edit did not land: ${text('pushpull-apply-error')} ${text('solids-workbench-pushpull-hint')} payload=${JSON.stringify(hooks().dag.getNode(id)?.payload)}`, detail: {} })
      return
    }
    const delta = (await volumeOf(id)) - s.volume
    record('ED-1', { verdict: Math.abs(delta - 1500) < 1 ? 'WORKS' : 'WRONG', message: 'edited', detail: { volumeDelta: Number(delta.toFixed(3)), expectedDelta: 1500 } })
  }, 180_000)

  it('ED-2 Edit: re-open a Resize Hole on an imported plate (d8 -> d9) from the tree', async () => {
    const s = await openStep(resolve(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step'))
    const wall = findFace(await facesOf('IMP1'), 'd6 at (20,20)', (f) => f.type === 'cylinder' && at(f, 20, 20))
    const first = await resizeHoleStep(s, wall, '8', -10 * PI * 7)
    if (first.verdict !== 'WORKS') { record('ED-2', first); return }
    const id = String(first.detail.id)
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${id}`), { clientX: 40, clientY: 60 })
    const menuItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    const entryKind = Object.keys(hooks().editEntryFor(id) ?? {}).join(',')
    fireEvent.click(menuItem)
    try {
      await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    } catch {
      record('ED-2', { verdict: 'REFUSES', message: `tree Edit did not reopen the resize entry: menu disabled=${menuItem.disabled}, entry=${entryKind}, hint=${text('solids-workbench-resizehole-hint')}; console: ${lastConsole()}`, detail: { shown: [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')!).filter((t) => /resize|hole|dialog|edit/i.test(t)).slice(0, 30) } })
      return
    }
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '9' } })
    await waitFor(() => expect(['ready', 'refused']).toContain(statusOf('resize-hole-anchor-entry-status')), { timeout: 60_000 })
    if (statusOf('resize-hole-anchor-entry-status') === 'refused') {
      record('ED-2', { verdict: 'REFUSES', message: text('resize-hole-anchor-entry-status'), detail: {} })
      return
    }
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(hooks().dag.getNode(id)?.payload.newDiameter).toBe(9), { timeout: 30_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30_000 })
    const delta = (await volumeOf(id)) - s.volume
    const expected = -10 * PI * (20.25 - 9)
    record('ED-2', { verdict: Math.abs(delta - expected) < 1 ? 'WORKS' : 'WRONG', message: 'edited', detail: { volumeDelta: Number(delta.toFixed(3)), expectedDelta: expected } })
  }, 180_000)

  it('BO-1 Import: one STEP holding two solids, through the Model screen Import button', async () => {
    let message = ''
    try {
      await openStep(resolve(process.cwd(), 'test_fixtures/brep/fix_two_solids.step'), ['IMP1', 'IMP2'])
    } catch (e) {
      message = String(e)
    }
    if (message !== '') { record('BO-1', { verdict: 'REFUSES', message, detail: {} }); return }
    // Hand volumes of the fixture's two boxes: 30 x 20 x 10 and 15 x 15 x 15.
    const v1 = await volumeOf('IMP1'), v2 = await volumeOf('IMP2')
    const ok = Math.abs(v1 - 6000) < 1 && Math.abs(v2 - 3375) < 1
    record('BO-1', { verdict: ok ? 'WORKS' : 'WRONG', message: ok ? '' : `volumes ${v1} / ${v2}`, detail: { check: 'two bodies with the two solids at their hand volumes 6000 and 3375', v1, v2 } })
  }, 180_000)

  it('BO-2 Boolean: union two imported STEP bodies (boss part + rib part, imported one after the other)', async () => {
    const s = await openStep(part('boss_fillet_base.step'))
    const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([bytesOf(part('rib_part.step'))], 'rib_part.step', { type: 'application/octet-stream' })] } })
    await waitFor(() => expect(hooks().getBodyHandle('IMP2')).not.toBeUndefined(), { timeout: 30_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('IMP2')).toBe('ok'), { timeout: 30_000 })
    const button = screen.getByTestId('workbench-boolean') as HTMLButtonElement
    if (button.disabled) { record('BO-2', { verdict: 'REFUSES', message: `Boolean disabled: ${button.title}`, detail: {} }); return }
    const before = hooks().dag.featureOrder()
    const v1 = s.volume
    const v2 = await volumeOf('IMP2')
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('boolean-target-select')).toBeTruthy())
    const options = [...(screen.getByTestId('boolean-op-select') as HTMLSelectElement).options].map((o) => o.value)
    fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'IMP1' } })
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'IMP2' } })
    const union = options.find((o) => /union|fuse|add|join/i.test(o)) ?? options[0]
    fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: union } })
    const apply = screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
    await waitFor(() => expect(apply.disabled).toBe(false), { timeout: 30_000 })
    fireEvent.click(apply)
    const o = await judgeApplied(before, v1 + v2, -bossRibOverlap())
    record('BO-2', { ...o, detail: { ...o.detail, ops: options, chosen: union, separateVolumes: [v1, v2] } })
  }, 180_000)

  it('FO-1 Form / Relief / Sweep / Loft with only an imported body in the model (availability only, no operation run)', async () => {
    await openStep(part('rib_part.step'))
    const state = buttonStates()
    record('FO-1', { verdict: 'WORKS', message: 'availability only: button states with one imported STEP body; no operation executed', detail: { ...state, check: 'button states asserted' } })
    // Form and Relief act on a body; Extrude/Revolve/Sweep/Loft need a sketch
    // profile (none yet); Boolean needs a second body; Edit needs a selected
    // feature row. Every disabled button here is a real missing input.
    expect(state).toEqual(FO_STATES_STEP)
  }, 180_000)

  it('HM-1 hole relocation on an imported STEP preserves the complete hole', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const before = hooks().dag.featureOrder()
    const wall = findFace(await facesOf('IMP1'), 'd5 wall', f => f.type === 'cylinder' && at(f, 55, 20))
    fireEvent.click(screen.getByTestId('workbench-move-hole'))
    await waitFor(() => expect(text('solids-workbench-resizehole-hint')).not.toMatch(/recognizing/i))
    aimAtFace(s.runtime, wall); click()
    await applyHoleMove()
    const id = hooks().dag.featureOrder().find(f => !before.includes(f))!
    const volume = await volumeOf(id)
    expect(Math.abs(volume - s.volume), 'same void, hand volume delta zero').toBeLessThan(.003)
    const mesh = await hooks().client.tessellate(hooks().getBodyHandle(id)!, { deflection: .01 })
    const sections = movedHoleSections(mesh.position, mesh.index)
    record('HM-1', { verdict: 'WORKS', message: 'moved complete hole +10 mm X',
      detail: { expectedDelta: 0, volumeDelta: volume - s.volume, sections } })
  }, 180_000)

  it('CH-3b new 0.5 mm chamfer on the counterbore top rim, picked away from the seam', async () => {
    const s = await openStep(part('stepped_holes.step'))
    // Correct: a 0.5 x 0.5 triangle swept round the r5.5 rim, its centroid
    // at r 5.5 + 0.5/3.
    record('CH-3b', await blendStep('chamfer', s, [() => aimAt(s.runtime, { x: 15, y: 20 + 5.5 + 10, z: 25 }, { x: 15, y: 20 + 5.5, z: 15 })], '0.5', -0.125 * 2 * PI * (5.5 + 0.5 / 3)))
  }, 180_000)

  it('FI-6 new r1 fillet on the counterbore top rim, picked away from the seam', async () => {
    const s = await openStep(part('stepped_holes.step'))
    // Correct: the r1 convex blend section swept round the r5.5 rim (Pappus).
    record('FI-6', await blendStep('fillet', s, [() => aimAt(s.runtime, { x: 15, y: 20 + 5.5 + 10, z: 25 }, { x: 15, y: 20 + 5.5, z: 15 })], '1', -(1 - PI / 4) * 2 * PI * (5.5 + BLEND_CENTROID)))
  }, 180_000)

  it('SH-3 shell the pocket block 1 mm, opening the top', async () => {
    const s = await openStep(part('pocket_floor_fillet.step'))
    const top = findFace(await facesOf('IMP1'), 'top', (f) => f.type === 'plane' && f.normal.z > 0.99 && near(f.centroid.z, 20, 1))
    record('SH-3', await shellWithOracle(await shellStep(s, top, '1'), pocketShellDelta(1, 1325.054450)))
  }, 180_000)

  it('SH-4 shell the rib part 1 mm, opening the bottom (thin ribs)', async () => {
    const s = await openStep(part('rib_part.step'))
    const bottom = findFace(await facesOf('IMP1'), 'bottom', (f) => f.type === 'plane' && f.normal.z < -0.99)
    // Correct: 1 mm everywhere but the bottom. Hollow = base 58x38x4 plus each
    // rib's 48x1x15 core, plus where the two meet the 1 mm distance rounds the
    // inside of each rib foot: per 50x3 rib, integral over the footprint's
    // 1 mm inner band of (1 - sqrt(1 - d^2)) = 106 (1 - PI/4) - 8/6.
    record('SH-4', againstFormula(await shellStep(s, bottom, '1'), -(58 * 38 * 4 + 2 * 48 * 15 + 2 * (106 * (1 - PI / 4) - 4 / 3))))
  }, 180_000)
})

// ---------------------------------------------------------------- STL route

const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let consoleLines: string[] = []

interface StlSession { runtime: FakeSceneRuntime; id: string; bytes: ArrayBuffer; volume: number }

/** The part never reached the Model screen - the cell's outcome is this refusal. */
class StlOpenRefused extends Error {}

/** Run one STL cell; a part that cannot be opened is recorded as REFUSES. */
async function stlCell(cell: string, name: string, run: (s: StlSession) => Promise<Outcome>): Promise<Outcome> {
  try {
    return record(cell, await run(await openStl(name)))
  } catch (e) {
    if (e instanceof StlOpenRefused) return record(cell, { verdict: 'REFUSES', message: e.message, detail: { stage: 'open' } })
    throw e
  }
}

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

const journalOf = (id: string) => useCamStore.getState().project.geometry.find((g) => g.id === id)?.meshEdits

async function stlVolume(s: StlSession): Promise<number> {
  const edit = await import('../../mesh/edit')
  const r = edit.resolveEditedStlMesh(s.bytes, journalOf(s.id))
  return meshVolume(r.mesh.positions, r.mesh.indices)
}

/** Open an STL the product's way - the store's "Edit as model" - and mount
 *  the Model screen on it (mesh route; the kernel client is the test fake,
 *  exactly as the WO-1936 suite runs it). */
async function openStl(name: string): Promise<StlSession> {
  const id = name.replace(/\W/g, '-')
  const bytes = bytesOf(part(name))
  stlCache.set(id, bytes)
  act(() => {
    useCamStore.setState((st) => ({
      project: {
        ...st.project,
        geometry: [{
          id, name, filename: name, type: 'mesh', format: 'stl',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 70, y: 60, z: 24 }, size: { x: 70, y: 60, z: 24 }, center: { x: 35, y: 30, z: 12 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        }],
      },
    }))
  })
  let wrapped: { ok: boolean; reason?: string } | undefined
  await act(async () => { wrapped = await useCamStore.getState().wrapImportedGeometryAsModelItem(id) })
  if (wrapped?.ok !== true) throw new StlOpenRefused(`Edit as model refused: ${wrapped?.reason ?? '?'} ${lastConsole()}`)
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(createElement(SolidsWorkbenchPage, { createClient: () => createFakeGeomClient(), createSceneRuntime: () => runtime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  try {
    await waitFor(() => expect(screen.getByTestId(`body-row-stl-body:${id}`)).toBeTruthy(), { timeout: 30_000 })
  } catch {
    throw new StlOpenRefused(`no STL body in the Model screen: ${consoleLines.join(' | ')}`)
  }
  const s = { runtime, id, bytes, volume: 0 }
  s.volume = await stlVolume(s)
  return s
}

afterEach(() => { useCamStore.getState().addConsoleEvent = realAddConsoleEvent })

const lastConsole = () => consoleLines.slice(-2).join(' | ')

async function judgeStl(s: StlSession, expectedDelta: number | null, tol = 0.03): Promise<Outcome> {
  try {
    await waitFor(() => expect(journalOf(s.id)?.length ?? 0).toBeGreaterThan(0), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `nothing recorded after Apply: ${lastConsole()}`, detail: { stage: 'apply' } }
  }
  const j = journalOf(s.id)!
  const delta = (await stlVolume(s)) - s.volume
  const detail = { kind: j[j.length - 1].kind, volumeDelta: Number(delta.toFixed(3)), expectedDelta }
  if (expectedDelta !== null && Math.abs(delta - expectedDelta) > Math.max(tol * Math.abs(expectedDelta), 0.5)) {
    return { verdict: 'WRONG', message: `volume changed by ${delta.toFixed(3)}, expected ${expectedDelta.toFixed(3)}`, detail }
  }
  return { verdict: 'WORKS', message: 'applied', detail }
}

async function stlPushPull(s: StlSession, from: V3, to: V3, delta: number, expectedDelta: number | null): Promise<Outcome> {
  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  aimAt(s.runtime, from, to); click()
  try {
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: PICK_WAIT })
  } catch {
    return { verdict: 'REFUSES', message: `pick not taken: ${text('solids-workbench-pushpull-hint')} ${lastConsole()}`, detail: { stage: 'pick' } }
  }
  const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
  fireEvent.change(input, { target: { value: String(delta) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  try {
    await waitFor(() => expect(statusOf('pushpull-delta-entry-status')).toMatch(/ready|refused/), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `no preview: ${text('pushpull-delta-entry-status')} ${lastConsole()}`, detail: { stage: 'preview' } }
  }
  if (statusOf('pushpull-delta-entry-status') === 'refused') return { verdict: 'REFUSES', message: text('pushpull-delta-entry-status'), detail: { stage: 'preview' } }
  fireEvent.keyDown(input, { key: 'Enter' })
  return judgeStl(s, expectedDelta)
}

async function stlBlend(tool: 'fillet' | 'chamfer', s: StlSession, from: V3, to: V3, value: string, expectedDelta: number | null): Promise<Outcome> {
  fireEvent.click(screen.getByTestId(`workbench-${tool}`))
  aimAt(s.runtime, from, to); click()
  if (!await waitCount(`${tool}-edge-count`, /[1-9]\d* edge/)) {
    return { verdict: 'REFUSES', message: `pick not taken: ${text(`${tool}-edge-count`)} ${lastConsole()}`, detail: { stage: 'pick' } }
  }
  const field = tool === 'fillet' ? 'fillet-radius' : 'chamfer-distance'
  const measured = (screen.getByTestId(field).querySelector('input') as HTMLInputElement).value
  const input = screen.getByTestId(field).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
  try {
    await waitFor(() => expect(statusOf(`${tool}-preview-status`)).toMatch(/ready|refused/), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `no preview: ${text(`${tool}-preview-status`)} ${lastConsole()}`, detail: { stage: 'preview', measured } }
  }
  if (statusOf(`${tool}-preview-status`) !== 'ready') return { verdict: 'REFUSES', message: text(`${tool}-preview-status`), detail: { stage: 'preview', measured } }
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  const o = await judgeStl(s, expectedDelta)
  return { ...o, detail: { ...o.detail, measured, edges: text(`${tool}-edge-count`) } }
}

async function stlResize(s: StlSession, from: V3, to: V3, diameter: string, expectedDelta: number | null): Promise<Outcome> {
  fireEvent.click(screen.getByTestId('workbench-resize-hole'))
  aimAt(s.runtime, from, to); click()
  try {
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
  } catch {
    return { verdict: 'REFUSES', message: `pick not taken: ${text('solids-workbench-resizehole-hint')} ${lastConsole()}`, detail: { stage: 'pick' } }
  }
  const current = text('resize-hole-anchor-entry-current')
  fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: diameter } })
  try {
    await waitFor(() => expect(statusOf('resize-hole-anchor-entry-status')).toMatch(/ready|refused/), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `no preview: ${text('resize-hole-anchor-entry-status')} ${lastConsole()}`, detail: { stage: 'preview', current } }
  }
  if (statusOf('resize-hole-anchor-entry-status') !== 'ready') return { verdict: 'REFUSES', message: text('resize-hole-anchor-entry-status'), detail: { stage: 'preview', current } }
  fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
  const o = await judgeStl(s, expectedDelta)
  return { ...o, detail: { ...o.detail, current } }
}

async function stlDefeature(s: StlSession, from: V3, to: V3, expectedDelta: number | null): Promise<Outcome> {
  fireEvent.click(screen.getByTestId('workbench-defeature'))
  try {
    await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy(), { timeout: 20_000 })
  } catch {
    return { verdict: 'REFUSES', message: `Defeature did not open: ${lastConsole()}`, detail: {} }
  }
  const rows = screen.queryAllByTestId(/^defeature-row-/).map((r) => r.getAttribute('data-testid')!.replace('defeature-row-', ''))
  aimAt(s.runtime, from, to); click()
  const state = () => screen.queryByTestId('defeature-preview-status')?.getAttribute('data-state') ?? null
  try {
    await waitFor(() => expect(['ready', 'failed']).toContain(state()), { timeout: PICK_WAIT })
  } catch {
    return { verdict: 'REFUSES', message: `nothing picked/previewed: ${text('defeature-preview-status')} ${lastConsole()}`, detail: { stage: 'pick', rows } }
  }
  if (state() !== 'ready') return { verdict: 'REFUSES', message: text('defeature-preview-status'), detail: { stage: 'preview', rows } }
  const picked = rows.filter((r) => (screen.queryByTestId(`defeature-check-${r}`) as HTMLInputElement | null)?.checked === true)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  const o = await judgeStl(s, expectedDelta)
  return { ...o, detail: { ...o.detail, rows, picked } }
}

/** A flat-faced (prismatic) STL is not a mesh body: "Edit as model" converts
 *  it into a real kernel body (makeSolidFromPlanarFaces), so its cells run on
 *  the real kernel exactly like a STEP. Returns the session and the body id. */
async function openPrismaticStl(name: string): Promise<StepSession & { bodyId: string }> {
  const id = name.replace(/\W/g, '-')
  stlCache.set(id, bytesOf(part(name)))
  act(() => {
    useCamStore.setState((st) => ({
      project: {
        ...st.project,
        geometry: [{
          id, name, filename: name, type: 'mesh', format: 'stl',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 20 }, size: { x: 60, y: 40, z: 20 }, center: { x: 30, y: 20, z: 10 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        }],
      },
    }))
  })
  let wrapped: { ok: boolean; reason?: string } | undefined
  await act(async () => { wrapped = await useCamStore.getState().wrapImportedGeometryAsModelItem(id) })
  if (wrapped?.ok !== true) throw new Error(`Edit as model refused: ${wrapped?.reason ?? '?'}`)
  const modelItemId = useCamStore.getState().activeModelItemId ?? undefined
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { modelItemId, createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  let bodyId = ''
  await waitFor(() => {
    bodyId = hooks().dag.featureOrder().find((f) => hooks().getBodyHandle(f) !== undefined) ?? ''
    expect(bodyId).not.toBe('')
    expect(hooks().scheduler.statusOf(bodyId)).toBe('ok')
  }, { timeout: 30_000 })
  return { runtime, volume: await volumeOf(bodyId), bodyId }
}

const P = (x: number, y: number, z: number): V3 => ({ x, y, z })
const S45 = Math.SQRT1_2

describe('WO-2757 STL: Push/Pull, Fillet, Chamfer, Resize Hole, Defeature', () => {
  it('SPP-1 dome-on-plate STL: +3 mm on the flat top next to the dome', async () => {
    await stlCell('SPP-1', 'dome_on_plate.stl', (s) => stlPushPull(s, P(5, 5, 30), P(5, 5, 10), 3, 4800 - 429 * PI)) // WO-2802: plate top +3 beside the dome (hand oracle)
  }, 120_000)

  it('SPP-2 boss STL: +3 mm on the plate top whose neighbour is the fillet', async () => {
    await stlCell('SPP-2', 'boss_fillet_base.stl', (s) => stlPushPull(s, P(5, 5, 30), P(5, 5, 10), 3, 3 * (3600 - 100 * PI)))
  }, 120_000)

  it('SPP-3 boss STL: boss top +2 mm', async () => {
    await stlCell('SPP-3', 'boss_fillet_base.stl', (s) => stlPushPull(s, P(31, 31, 40), P(31, 31, 22), 2, 2 * 100 * PI))
  }, 120_000)

  it('SPP-4 fillet chain STL: top +2 mm', async () => {
    await stlCell('SPP-4', 'fillet_chain.stl', (s) => stlPushPull(s, P(30, 20, 40), P(30, 20, 20), 2, 2 * (2400 - (4 - PI) * 36)))
  }, 120_000)

  it('SPP-5 counterbore floor STL: -2 mm', async () => {
    await stlCell('SPP-5', 'stepped_holes.stl', (s) => stlPushPull(s, P(19.4, 20, 30), P(19.4, 20, 8.5), -2, -2 * PI * (5.5 ** 2 - 3.3 ** 2)))
  }, 120_000)

  it('SPP-8 pocket floor STL with floor fillets: -2 mm', async () => {
    await stlCell('SPP-8', 'pocket_floor_fillet.stl', (s) => stlPushPull(s, P(30, 20, 40), P(30, 20, 12), -2, -2 * (600 - (4 - PI) * 25)))
  }, 120_000)

  it('SPP-9 rib STL (prismatic, becomes a kernel body): rib side +1 mm', async () => {
    const s = await openPrismaticStl('rib_part.stl')
    const side = findFace(await facesOf(s.bodyId), 'rib side', (f) => f.type === 'plane' && f.normal.y < -0.99 && near(f.centroid.y, 8))
    record('SPP-9', await pushPullStep(s, side, 1, 750))
  }, 120_000)

  it('SFI-1 boss STL: base fillet r3 -> r4', async () => {
    await stlCell('SFI-1', 'boss_fillet_base.stl', (s) => {
      const pt = P(30, 30 + 10 + 3 - 3 * S45, 10 + 3 - 3 * S45)
      return stlBlend('fillet', s, P(pt.x, pt.y + 5, pt.z + 5), pt, '4', bossFoot(4) - bossFoot(3))
    })
  }, 120_000)

  it('SFI-2 fillet chain STL: one straight member r2 -> r3', async () => {
    await stlCell('SFI-2', 'fillet_chain.stl', (s) => {
      const pt = P(30, 2 - 2 * S45, 18 + 2 * S45)
      return stlBlend('fillet', s, P(pt.x, pt.y - 5, pt.z + 5), pt, '3', -(topFillet(3) - topFillet(2)))
    })
  }, 120_000)

  it('SFI-3 fillet chain STL: the corner member r2 -> r3', async () => {
    await stlCell('SFI-3', 'fillet_chain.stl', (s) => {
      const pt = P(6 - 5.414 * S45, 6 - 5.414 * S45, 18 + 2 * S45)
      return stlBlend('fillet', s, P(pt.x - 2.5, pt.y - 2.5, pt.z + 3.5), pt, '3', -(topFillet(3) - topFillet(2)))
    })
  }, 120_000)

  it('SFI-4 pocket STL: floor fillet r2 -> r3', async () => {
    await stlCell('SFI-4', 'pocket_floor_fillet.stl', (s) => {
      const pt = P(30, 12 - 2 * S45, 14 - 2 * S45)
      return stlBlend('fillet', s, P(pt.x, pt.y + 4, pt.z + 4), pt, '3', floorFillet(3) - floorFillet(2))
    })
  }, 120_000)

  it('SFI-5 rib STL: new r1 fillet on a sharp rib top edge', async () => {
    const s = await openPrismaticStl('rib_part.stl')
    record('SFI-5', await blendStep('fillet', s, [() => aimAt(s.runtime, { x: 30, y: -12, z: 40 }, { x: 30, y: 8, z: 20 })], '1', -(1 - PI / 4) * 50))
  }, 120_000)

  it('SCH-1 chamfer chain STL: one member 2 -> 3', async () => {
    await stlCell('SCH-1', 'chamfer_chain.stl', (s) => stlBlend('chamfer', s, P(30, -4, 24), P(30, 1, 19), '3', -(topChamfer(3) - topChamfer(2)))) // WO-2802
  }, 120_000)

  it('SCH-2 rib STL: new 1 mm chamfer on a sharp rib top edge', async () => {
    const s = await openPrismaticStl('rib_part.stl')
    record('SCH-2', await blendStep('chamfer', s, [() => aimAt(s.runtime, { x: 30, y: -12, z: 40 }, { x: 30, y: 8, z: 20 })], '1', -25))
  }, 120_000)

  it('SRH-1 counterbore STL: pick the counterbore wall, d11 -> d12', async () => {
    await stlCell('SRH-1', 'stepped_holes.stl', async (s) => {
      const o = await stlResize(s, P(15, 20, 12), P(15, 25.5, 12), '12', -6.5 * PI * (36 - 30.25))
      await captureStl('SRH-1', 'STL counterbore wall picked, 12 mm typed - the whole hole is bored to 12 mm', s, 'y', 20)
      return o
    })
  }, 120_000)

  it('SRH-2 counterbore STL: pick the through wall, d6.6 -> d7', async () => {
    await stlCell('SRH-2', 'stepped_holes.stl', (s) => stlResize(s, P(15, 20, 4), P(15, 23.3, 4), '7', -8.5 * PI * (12.25 - 10.89)))
  }, 120_000)

  it('SRH-3 countersink STL: through d6.6 -> d7', async () => {
    // Correct: only the pilot grows - r 3.3 -> 3.5 over z 0..11.8, plus the
    // sliver of the cone's foot the wider pilot eats (cone r = 3.3 + (z - 11.8))
    // - and the countersink keeps its d13 rim on the top face.
    await stlCell('SRH-3', 'stepped_holes.stl', async (s) => {
      const o = await stlResize(s, P(35, 20, 4), P(35, 23.3, 4), '7', -PI * ((3.5 ** 2 - 3.3 ** 2) * 11.8 + 3.5 ** 2 * 0.2 - (3.5 ** 3 - 3.3 ** 3) / 3))
      if (o.verdict !== 'WORKS') return o
      const rim = await topRimRadius(s, 35, 20, 15)
      const detail = { ...o.detail, countersinkTopDiameter: Number((2 * rim).toFixed(3)), check: 'countersink rim on the top face stays d13 (+-0.05)' }
      return Math.abs(2 * rim - 13) <= 0.05 ? { ...o, detail } : { ...o, verdict: 'WRONG', message: `asked for the d7 pilot only; the countersink top went 13 -> ${(2 * rim).toFixed(3)}`, detail }
    })
  }, 120_000)

  it('SRH-4 tapped-size STL: d5 -> d6', async () => {
    await stlCell('SRH-4', 'stepped_holes.stl', (s) => stlResize(s, P(55, 20, 7), P(55, 22.5, 7), '6', -15 * PI * (9 - 6.25)))
  }, 120_000)

  it('SDF-1 counterbore STL: delete the whole stepped hole', async () => {
    await stlCell('SDF-1', 'stepped_holes.stl', (s) => stlDefeature(s, P(15, 20, 12), P(15, 25.5, 12), PI * (6.5 * 30.25 + 8.5 * 10.89)))
  }, 120_000)

  it('SDF-2 countersink STL: delete the hole', async () => {
    await stlCell('SDF-2', 'stepped_holes.stl', (s) => stlDefeature(s, P(35, 20, 4), P(35, 23.3, 4), 653.654))
  }, 120_000)

  it('SDF-3 boss STL: remove the base fillet', async () => {
    await stlCell('SDF-3', 'boss_fillet_base.stl', (s) => {
      const pt = P(30, 30 + 10 + 3 - 3 * S45, 10 + 3 - 3 * S45)
      return stlDefeature(s, P(pt.x, pt.y + 5, pt.z + 5), pt, -bossFoot(3))
    })
  }, 120_000)

  it('SDF-4 boss STL: remove the boss', async () => {
    await stlCell('SDF-4', 'boss_fillet_base.stl', (s) => stlDefeature(s, P(30, 60, 16), P(30, 40, 16), -(PI * 100 * 12 + bossFoot(3)))) // WO-2802: boss and its whole foot fillet
  }, 120_000)

  it('SDF-5 fillet chain STL: remove the chain', async () => {
    await stlCell('SDF-5', 'fillet_chain.stl', (s) => {
      const pt = P(30, 2 - 2 * S45, 18 + 2 * S45)
      return stlDefeature(s, P(pt.x, pt.y - 5, pt.z + 5), pt, topFillet(2))
    })
  }, 120_000)

  it('SDF-6 chamfer chain STL: remove a chamfer', async () => {
    await stlCell('SDF-6', 'chamfer_chain.stl', (s) => stlDefeature(s, P(30, -4, 24), P(30, 1, 19), topChamfer(2)))
  }, 120_000)

  it('SDF-7 dome STL: remove the dome', async () => {
    await stlCell('SDF-7', 'dome_on_plate.stl', (s) => stlDefeature(s, P(20, 20, 40), P(20, 20, 24), -4515.516))
  }, 120_000)

  it('SDF-8 pocket STL: remove the floor fillets', async () => {
    await stlCell('SDF-8', 'pocket_floor_fillet.stl', (s) => {
      const pt = P(30, 12 - 2 * S45, 14 - 2 * S45)
      return stlDefeature(s, P(pt.x, pt.y + 4, pt.z + 4), pt, -floorFillet(2))
    })
  }, 120_000)
})

async function stlPreviewApply(tool: string, s: StlSession, expectedDelta: number | null, tol?: number): Promise<Outcome> {
  try {
    await waitFor(() => expect(statusOf(`${tool}-preview-status`)).toMatch(/ready|refused/), { timeout: 30_000 })
  } catch {
    return { verdict: 'REFUSES', message: `no preview: ${text(`${tool}-preview-status`)} ${lastConsole()}`, detail: { stage: 'preview' } }
  }
  if (statusOf(`${tool}-preview-status`) !== 'ready') return { verdict: 'REFUSES', message: text(`${tool}-preview-status`), detail: { stage: 'preview' } }
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  return judgeStl(s, expectedDelta, tol)
}

/** Smallest distance from (cx, cy) of an edited-mesh vertex on the plane
 *  z = `z` within 10 mm - the radius of the opening a hole cuts in that face. */
async function topRimRadius(s: StlSession, cx: number, cy: number, z: number): Promise<number> {
  const edit = await import('../../mesh/edit')
  const m = edit.resolveEditedStlMesh(s.bytes, journalOf(s.id)).mesh
  let r = Infinity
  for (let i = 0; i < m.positions.length; i += 3) {
    if (Math.abs(m.positions[i + 2] - z) > 1e-3) continue
    const d = Math.hypot(m.positions[i] - cx, m.positions[i + 1] - cy)
    if (d < 10) r = Math.min(r, d)
  }
  return r
}

describe('WO-2757 STL: Push/Pull on a holed face, Hole, Shell, Draft', () => {
  it('SPP-6 stepped-holes STL: +1 mm on the top face that carries three hole openings', async () => {
    // The plate gets 1 mm thicker and each opening carries up with it: top
    // area minus the d11 / d13 / d5 openings, times 1 (faceted, so 1 %).
    await stlCell('SPP-6', 'stepped_holes.stl', async (s) => {
      const o = await stlPushPull(s, P(65, 35, 30), P(65, 35, 15), 1, null)
      const expected = 2800 - PI * (5.5 ** 2 + 6.5 ** 2 + 2.5 ** 2)
      await captureStl('SPP-6', 'STL top +1 mm over a counterbore, a countersink and a d5 hole', s, 'y', 20)
      const delta = Number(o.detail.volumeDelta)
      return o.verdict === 'WORKS' && Math.abs(delta - expected) > 0.01 * expected
        ? { ...o, verdict: 'WRONG', message: `volume changed by ${delta}, expected ${expected.toFixed(3)}`, detail: { ...o.detail, expectedDelta: expected } }
        : o
    })
  }, 120_000)

  it('SHO-1 boss STL: new d5 x 3 hole on the plate top', async () => {
    await stlCell('SHO-1', 'boss_fillet_base.stl', async (s) => {
      fireEvent.click(screen.getByTestId('workbench-hole'))
      aimAt(s.runtime, P(8, 8, 30), P(8, 8, 10)); click()
      try {
        await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy(), { timeout: 10_000 })
      } catch {
        return { verdict: 'REFUSES', message: `pick not taken: ${lastConsole()}`, detail: { stage: 'pick' } }
      }
      commitField('hole-diameter', '5')
      if (screen.queryByTestId('hole-blind-distance') !== null) commitField('hole-blind-distance', '3')
      return stlPreviewApply('hole', s, -PI * 2.5 ** 2 * 3)
    })
  }, 120_000)

  it('SSH-1 boss STL: shell 2 mm, opening the bottom', async () => {
    await stlCell('SSH-1', 'boss_fillet_base.stl', async (s) => {
      fireEvent.click(screen.getByTestId('workbench-shell'))
      aimAt(s.runtime, P(8, 8, -30), P(8, 8, 0)); click()
      if (!await waitCount('shell-face-count', /1 face/)) return { verdict: 'REFUSES', message: `pick not taken: ${text('shell-face-count')} ${lastConsole()}`, detail: { stage: 'pick' } }
      const input = screen.getByLabelText('Shell thickness') as HTMLInputElement
      fireEvent.change(input, { target: { value: '2' } })
      fireEvent.blur(input)
      // Correct: 2 mm everywhere but the bottom. Hollow = plate 56x56x8, the
      // boss core r8 over z 8..20, and the r3 foot fillet becomes an r5 cove
      // inside (same centre), whose (1 - PI/4) 25 corner rides at r 8 + 5k.
      return stlPreviewApply('shell', s, -(56 * 56 * 8 + PI * 64 * 12 + 25 * (1 - PI / 4) * 2 * PI * (8 + 5 * BLEND_CENTROID)), 0.002)
    })
  }, 120_000)

  it('SDR-1 pocket STL: draft the front side 3 deg from the top', async () => {
    await stlCell('SDR-1', 'pocket_floor_fillet.stl', async (s) => {
      fireEvent.click(screen.getByTestId('workbench-draft'))
      aimAt(s.runtime, P(5, 5, 40), P(5, 5, 20)); click()
      if (!await waitCount('draft-face-count', /1 neutral face/)) return { verdict: 'REFUSES', message: `neutral pick not taken: ${text('draft-face-count')} ${lastConsole()}`, detail: { stage: 'pick' } }
      fireEvent.click(screen.getByTestId('draft-confirm-neutral'))
      aimAt(s.runtime, P(30, -20, 10), P(30, 0, 10)); click()
      if (!await waitCount('draft-face-count', /1 draft face/)) return { verdict: 'REFUSES', message: `draft face pick not taken: ${text('draft-face-count')} ${lastConsole()}`, detail: { stage: 'pick' } }
      commitField('draft-angle', '3')
      // Correct: neutral at the top, so the 60 long x 20 tall front wall
      // leans out toward the floor (part narrower at the top): + 60 * 20^2 * tan 3 / 2.
      return stlPreviewApply('draft', s, 60 * 20 ** 2 * TAN3 / 2, 0.005)
    })
  }, 120_000)
})

describe('WO-2757 STL: Form / Boolean availability, re-edit, hole relocation', () => {
  it('SFO-1 boss STL (mesh body): Form / Relief / Sweep / Loft / Boolean / Edit availability (no operation run)', async () => {
    await stlCell('SFO-1', 'boss_fillet_base.stl', async () => {
      const state = buttonStates()
      expect(state).toEqual(FO_STATES_STL)
      return { verdict: 'WORKS', message: 'availability only: button states with one STL mesh body; no operation executed', detail: { ...state, check: 'button states asserted' } }
    })
  }, 120_000)

  it('SED-1 boss STL: re-open a Push/Pull (boss top +2) to change it', async () => {
    await stlCell('SED-1', 'boss_fillet_base.stl', async (s) => {
      const first = await stlPushPull(s, P(31, 31, 40), P(31, 31, 22), 2, 2 * 100 * PI)
      if (first.verdict !== 'WORKS') return first
      // The origin and the three datum planes are always in the tree; any
      // other row would be the edit itself.
      const rows = screen.queryAllByTestId(/^feature-row-/).map((r) => r.getAttribute('data-testid')!).filter((r) => !/^feature-row-(origin|datum:)/.test(r))
      const edit = screen.queryByTestId('workbench-edit-feature') as HTMLButtonElement | null
      const journal = (journalOf(s.id) ?? []).map((r) => r.kind)
      if (rows.length === 0) {
        return { verdict: 'REFUSES', message: `no tree row to re-open: the mesh edit lands in the row's journal [${journal.join(', ')}]; Edit is ${edit?.disabled === false ? 'enabled' : 'disabled'}; the only change is Properties > remove the edit and redo it`, detail: { journal } }
      }
      return { verdict: 'REFUSES', message: `tree rows ${rows.join(',')} exist - re-open not driven yet`, detail: { rows, journal } }
    })
  }, 120_000)

  it('SHM-1 stepped-holes STL preserves the complete moved hole', async () => {
    await stlCell('SHM-1', 'stepped_holes.stl', async s => {
      fireEvent.click(screen.getByTestId('workbench-move-hole'))
      aimAt(s.runtime, P(55,20,7), P(55,22.5,7)); click()
      await applyHoleMove()
      await waitFor(() => expect(journalOf(s.id)).toHaveLength(1))
      const mesh = resolveEditedStlMesh(s.bytes,journalOf(s.id)).mesh
      const sections = movedHoleSections(mesh.positions,mesh.indices)
      const volume = await stlVolume(s)
      expect(Math.abs(volume - s.volume), 'same void, hand volume delta zero').toBeLessThan(.003)
      return { verdict: 'WORKS', message: 'moved complete hole +10 mm X',
        detail: { expectedDelta: 0, volumeDelta: volume - s.volume, sections } }
    })
  }, 120_000)
})
