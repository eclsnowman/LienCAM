// @vitest-environment jsdom
// WO-2819: audit only. Real Model screen, real OCCT, original WO-2757 parts.
// Fake scene runtime supplies deterministic rays; no edit calls go straight to a kernel.
// Kernel tessellation/measurement and mesh-journal replay are read-only observations.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import * as THREE from 'three'
import { typedMock } from '../support/typedMock'
import type { BodyHandle, StableId } from '../../geom/geom-service'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

const { formGizmos } = vi.hoisted(() => ({ formGizmos: [] as Array<{
  object?: import('three').Object3D; emit(type: string, event?: { value?: boolean }): void
}> }))
vi.mock('../../components/model3d/gizmos/TransformControlsAdapter', async (original) => {
  const actual = await original<typeof import('../../components/model3d/gizmos/TransformControlsAdapter')>()
  const { Object3D } = await import('three')
  return typedMock<typeof import('../../components/model3d/gizmos/TransformControlsAdapter')>({ ...actual, createDefaultTransformControlsAdapter: () => {
    const listeners = new Map<string, Set<(e: { value?: boolean }) => void>>()
    const helper = new Object3D()
    const adapter = {
      object: undefined as import('three').Object3D | undefined,
      enabled: true,
      attach(object: import('three').Object3D) { this.object = object },
      detach() { this.object = undefined },
      setMode() {}, setSpace() {}, dispose() {}, getHelper: () => helper,
      addEventListener(type: string, cb: (e: { value?: boolean }) => void) { const l = listeners.get(type) ?? new Set(); l.add(cb); listeners.set(type, l) },
      removeEventListener(type: string, cb: (e: { value?: boolean }) => void) { listeners.get(type)?.delete(cb) },
      emit(type: string, event = {}) { for (const cb of listeners.get(type) ?? []) cb(event) },
    }
    formGizmos.push(adapter)
    return adapter
  } })
})

const { stepCache, stlCache } = vi.hoisted(() => ({
  stepCache: new Map<string, ArrayBuffer>(),
  stlCache: new Map<string, ArrayBuffer>(),
}))
vi.mock('../../lib/stepCache', async (original) => typedMock<typeof import('../../lib/stepCache')>({
  ...await original<typeof import('../../lib/stepCache')>(),
  loadCachedStepDisplay: async () => null,
  cacheStepDisplay: async () => {},
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
const { useCamStore } = await import('../../store')
const { useFormStore } = await import('../../form/formStore')
const { useReliefStore } = await import('../../components/model3d/relief/reliefStore')
const { resetDocumentHolder } = await import('../../doc/documentHolder')

const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const part = (name: string) => resolve(PARTS, name)

type V3 = { x: number; y: number; z: number }
export type Verdict = 'WORKS' | 'REFUSES' | 'WRONG' | 'SILENT'
export interface Outcome { verdict: Verdict; message: string; detail: Record<string, unknown> }

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  resetDocumentHolder()
  useFormStore.getState().closeSession()
  useReliefStore.getState().closeSession()
  formGizmos.length = 0
  fixtureInputs.clear()
  memory.clear()
  stepCache.clear()
  stlCache.clear()
  const restoreBase = stubCanvas2d()
  const baseContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof baseContext>) {
    const context = baseContext.apply(this, args)
    if (args[0] !== '2d' || context === null) return context
    return new Proxy(context, { get(target, key) {
      if (key === 'createImageData') return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      return Reflect.get(target, key)
    } })
  } as typeof baseContext
  restoreCanvas2d = restoreBase
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

function bytesOf(path: string): ArrayBuffer {
  fixtureInputs.add(path)
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}


const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let consoleLines: string[] = []
const text = (id: string) => screen.queryByTestId(id)?.textContent ?? ''
const statusOf = (id: string) => screen.queryByTestId(id)?.getAttribute('data-status') ?? null
const PICK_WAIT = 2000
const EXPECTED: Record<string, Verdict> = {
  "STEP-fillet": "WORKS",
  "STEP-chamfer": "WORKS",
  "STL-fillet": "WORKS",
  "STL-chamfer": "WORKS",
  "STEP-FORM-rib_part": "WORKS",
  "STEP-FORM-boss_fillet_base": "WORKS",
  "STL-FORM-rib_part": "WORKS",
  "STL-FORM-boss_fillet_base": "WORKS",
  "STEP-BOOLEAN-fuse": "WORKS",
  "STEP-BOOLEAN-cut": "REFUSES",
  "STEP-BOOLEAN-intersect": "WORKS",
  "STL+STL-BOOLEAN": "WORKS",
  "STL+STEP-BOOLEAN": "WORKS",
  "STEP-RELIEF": "WORKS",
  "STL-RELIEF": "REFUSES",
  "STEP-CHAIN-pushpull": "WORKS",
  "STEP-CHAIN-hole": "WORKS",
  "STL-CHAIN-pushpull": "WORKS",
  "STL-CHAIN-hole": "WORKS",
  "STEP-FORM-translate": "WORKS",
  "STEP-FORM-scale": "WORKS",
  "STEP-FORM-axis": "WORKS",
  "STL-FORM-translate": "WORKS",
  "STL-FORM-scale": "WORKS",
  "STL-FORM-axis": "WORKS",
  "STEP-OFFSET": "WORKS",
  "STEP-MIDPLANE": "WORKS",
  "STEP-ANGLE": "WORKS",
  "STEP-FORM-MIRROR": "WORKS",
  "STEP-PATTERN": "REFUSES",
  "STEP-SPLIT": "REFUSES",
  "STL-OFFSET": "WORKS",
  "STL-MIDPLANE": "WORKS",
  "STL-ANGLE": "WORKS",
  "STL-FORM-MIRROR": "WORKS",
  "STL-PATTERN": "REFUSES",
  "STL-SPLIT": "REFUSES",
  "STEP-CONSTRUCT-axis": "WORKS",
  "STEP-CONSTRUCT-point": "WORKS",
  "STEP-CONSTRUCT-plane-through": "WORKS",
  "STEP-CONSTRUCT-tangent-plane": "WORKS",
  "STL-CONSTRUCT-axis": "WORKS",
  "STL-CONSTRUCT-point": "WORKS",
  "STL-CONSTRUCT-plane-through": "WORKS",
  "STL-CONSTRUCT-tangent-plane": "WORKS",
  "STEP-BOOLEAN-different-fuse": "WORKS",
  "STEP-BOOLEAN-different-cut": "WORKS",
  "STEP-BOOLEAN-different-intersect": "WORKS",
  "STEP-EXPORT-STL": "WORKS",
  "STEP-DEBUG": "WORKS",
  "STEP-EXPORT-STEP": "WORKS",
  "STL-EXPORT-STL": "WORKS",
  "STL-DEBUG": "WORKS",
  "STL-EXPORT-STEP": "WORKS"
}
const cells: Record<string, Outcome> = {}
// WO-2912 reuses these exact production-route actions, fixtures and oracles.
// Configuration happens during test collection, before any registered test runs.
interface AuditOptions {
  label: string
  evidenceDir: string
  onRecord?: (cell: string, outcome: Outcome) => Promise<void>
  wrapClient?: (client: ReturnType<typeof createLocalGeomService>) => ReturnType<typeof createLocalGeomService>
}
let audit: AuditOptions = { label: 'WO-2819', evidenceDir: 'src/tests/evidence/WO-2819' }
export function configureActionAudit(options: AuditOptions): void { audit = options }
let mountProps: Parameters<typeof SolidsWorkbenchPage>[0]
const fixtureInputs = new Set<string>()
function mountWorkbench(props: Parameters<typeof SolidsWorkbenchPage>[0]): void {
  mountProps = props
  const factory = props.createClient
  render(createElement(SolidsWorkbenchPage, audit.wrapClient && factory
    ? { ...props, createClient: () => audit.wrapClient!(factory()) } : props))
}
export const actionAudit = {
  cells, hooks, volumeOf, commitField, commitLabel,
  get consoleLines() { return [...consoleLines] },
  openStep, openPrismaticStl, facesOf, findFace, aimAtFace, aimAt, click, judgeApplied, previewThenApply,
  fixtureInputs,
  clearCaches: () => { stepCache.clear(); stlCache.clear() },
  unmount: cleanup,
  remount: () => mountWorkbench(mountProps),
}

async function record(cell: string, outcome: Outcome): Promise<Outcome> {
  cells[cell] = outcome
  console.log(`${audit.label} CELL ${cell} ${JSON.stringify(outcome)}`)
  await audit.onRecord?.(cell, outcome)
  if (outcome.verdict === 'WORKS') expect(typeof outcome.detail.expectedDelta === 'number' || typeof outcome.detail.check === 'string').toBe(true)
  expect(outcome.verdict, cell + ': ' + outcome.message).toBe(EXPECTED[cell])
  return outcome
}
afterAll(() => {
  writeFileSync(resolve(process.cwd(), audit.evidenceDir + '/cells.json'), JSON.stringify({ source: audit.label === 'WO-2819' ? '849c2fc3e7' : 'see matrix.json', route: 'SolidsWorkbenchPage; real createLocalGeomService; WO-2757 fixtures', cells }, null, 2) + '\n')
})
interface StepSession { runtime: FakeSceneRuntime; volume: number }

/** Mount the Model screen on the real kernel and import `path` through the
 *  screen's own Import input (the button's hidden file input). */
async function openStep(path: string, bodyIds: string[] = ['IMP1']): Promise<StepSession> {
  const runtime = createFakeSceneRuntime()
  // Anchored value entries render only while their anchor projects on screen.
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  mountWorkbench({ createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver })
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
    return { verdict: 'SILENT', message: 'no feature landed after Apply', detail: {} }
  }
  const status = hooks().scheduler.statusOf(id!)
  if (status !== 'ok') {
    const diag = hooks().scheduler.diagnosticsOf(id!)
    return { verdict: 'REFUSES', message: `feature ${id} ${status}: ${JSON.stringify(diag)}`, detail: { id } }
  }
  await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
  let after: number
  try { after = await volumeOf(id!) } catch (e) { return { verdict: 'WRONG', message: String(e), detail: { id, expectedDelta, stage: 'measure finished body' } } }
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

interface StlSession { runtime: FakeSceneRuntime; id: string; bytes: ArrayBuffer; volume: number }

/** The part never reached the Model screen - the cell's outcome is this refusal. */
class StlOpenRefused extends Error {}

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
  mountWorkbench({ modelItemId: useCamStore.getState().activeModelItemId ?? undefined, createClient: createLocalGeomService, createSceneRuntime: () => runtime })
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


async function importMore(name: string, id: string): Promise<void> {
  fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [new File([bytesOf(part(name))], name)] } })
  await waitFor(() => expect(hooks().getBodyHandle(id)).toBeDefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30_000 })
}

async function fromBody(format: 'STEP' | 'STL', fixture = 'rib_part'): Promise<{ runtime: FakeSceneRuntime; volume: number; refusal?: Outcome }> {
  const s = format === 'STEP' ? await openStep(part(fixture + '.step')) : await openStl(fixture + '.stl')
  fireEvent.click(screen.getByTestId('workbench-form'))
  fireEvent.click(screen.getByTestId('form-starter-body'))
  await waitFor(() => expect(useFormStore.getState().sourceBodyId !== null || /Select a body|Refused|Cannot/i.test(text('form-notice'))).toBe(true), { timeout: 30_000 })
  if (useFormStore.getState().sourceBodyId === null) return { ...s, refusal: { verdict: 'REFUSES', message: text('form-notice'), detail: { stage: 'From body', sourceBodyId: null } } }
  return s
}

function commitLabel(label: string, raw: string): void {
  const input = screen.getByLabelText(label)
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function finishForm(s: StepSession, expectedDelta: number): Promise<Outcome> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('form-finish'))
  const outcome = await judgeApplied(before, s.volume, expectedDelta)
  // Form is a tolerance-based reconstruction. The independent volume budget
  // is 0.2% of the imported part, not 0.05 mm3 irrespective of part size.
  const error = typeof outcome.detail.volumeDelta === 'number' ? Math.abs(outcome.detail.volumeDelta - expectedDelta) : Infinity
  if (outcome.verdict === 'WRONG' && error <= s.volume * 0.002) return { ...outcome, verdict: 'WORKS', message: 'finished within 0.2% source volume', detail: { ...outcome.detail, sourceVolume: s.volume, volumeBudget: s.volume * 0.002 } }
  return outcome
}

// New sharp-edge edits: these really apply, rather than reporting availability.
for (const format of ['STEP', 'STL'] as const) {
  for (const tool of ['fillet', 'chamfer'] as const) {
    it(`${format}-${tool}: new 1 mm blend on imported sharp rib edge`, async () => {
      const s = format === 'STEP' ? await openStep(part('rib_part.step')) : await openPrismaticStl()
      const expected = tool === 'fillet' ? -(1 - Math.PI / 4) * 50 : -0.5 * 50
      await record(`${format}-${tool}`, await blendStep(tool, s, [() => aimAt(s.runtime, { x: 30, y: -12, z: 40 }, { x: 30, y: 8, z: 20 })], '1', expected))
    }, 180_000)
  }
}

// Prismatic STL must use Edit as model, not rename an STL to STEP.
async function openPrismaticStl(fixture = 'rib_part'): Promise<StepSession> {
  const id = 'rib-prismatic'
  const bytes = bytesOf(part(fixture + '.stl'))
  stlCache.set(id, bytes)
  act(() => useCamStore.setState((st) => ({ project: { ...st.project, geometry: [{
    id, name: fixture + '.stl', filename: fixture + '.stl', type: 'mesh', format: 'stl', loaded: true,
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 20 }, size: { x: 60, y: 40, z: 20 }, center: { x: 30, y: 20, z: 10 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  }] } })))
  await act(async () => { expect((await useCamStore.getState().wrapImportedGeometryAsModelItem(id)).ok).toBe(true) })
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  mountWorkbench({ modelItemId: useCamStore.getState().activeModelItemId ?? undefined, createClient: createLocalGeomService, createSceneRuntime: () => runtime })
  await waitFor(() => expect(hooks().dag.featureOrder().some((id) => hooks().getBodyHandle(id) !== undefined)).toBe(true), { timeout: 30_000 })
  const body = hooks().dag.featureOrder().find((id) => hooks().getBodyHandle(id) !== undefined)!
  await waitFor(() => expect(hooks().scheduler.statusOf(body)).toBe('ok'), { timeout: 30_000 })
  return { runtime, volume: await volumeOf(body) }
}

for (const format of ['STEP', 'STL'] as const) {
  for (const fixture of ['rib_part', 'boss_fillet_base']) {
    it(`${format}-FORM-${fixture}: From body -> rotate all 90 degrees -> Finish`, async () => {
      const s = fixture === 'rib_part' && format === 'STL'
        ? await (async () => {
          const s = await openPrismaticStl()
          fireEvent.click(screen.getByTestId('workbench-form'))
          fireEvent.click(screen.getByTestId('form-starter-body'))
          await waitFor(() => expect(useFormStore.getState().sourceBodyId).not.toBeNull(), { timeout: 30_000 })
          return { ...s, refusal: undefined as Outcome | undefined }
        })()
        : await fromBody(format, fixture)
      const cell = `${format}-FORM-${fixture}`
      if (s.refusal) { await record(cell, s.refusal); return }
      const original = useFormStore.getState().cage.positions.map((p) => [...p])
      fireEvent.click(screen.getByTestId('form-select-all'))
      fireEvent.click(screen.getByTestId('form-transform-rotate'))
      fireEvent.change(screen.getByLabelText('Centre rotation axis'), { target: { value: 'z' } })
      commitLabel('Rotation angle', '90')
      fireEvent.click(screen.getByTestId('form-rotation-apply'))
      const after = useFormStore.getState().cage.positions
      const centre = [0, 1, 2].map((k) => original.reduce((sum, p) => sum + p[k], 0) / original.length)
      const error = Math.max(...original.map((p, i) => Math.hypot(after[i][0] - (centre[0] - (p[1] - centre[1])), after[i][1] - (centre[1] + (p[0] - centre[0])), after[i][2] - p[2])))
      expect(error).toBeLessThan(1e-7)
      const sourceId = useFormStore.getState().sourceBodyId!
      const outcome = await finishForm(s, 0)
      await captureWrong(cell, outcome, sourceId)
      await record(cell, { ...outcome, detail: { ...outcome.detail, pointQuarterTurnError: error, check: 'every cage point matches an independent 90 degree turn; finished volume must equal source' } })
    }, 180_000)
  }
}

for (const op of ['fuse', 'cut', 'intersect']) {
  it(`STEP-BOOLEAN-${op}: two imported rib bodies`, async () => {
    const s = await openStep(part('rib_part.step'))
    await importMore('rib_part.step', 'IMP2')
    fireEvent.click(screen.getByTestId('workbench-boolean'))
    fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'IMP1' } })
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'IMP2' } })
    fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: op } })
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    // Identical ribs are 60*40*5 + 2*50*3*15 = 16500 mm3.
    // A-A is empty, which cannot be represented as one solid: a truthful refusal.
    const outcome = await judgeApplied(before, s.volume, op === 'cut' ? -16500 : 0)
    await captureWrong(`STEP-BOOLEAN-${op}`, outcome, 'IMP1')
    await record(`STEP-BOOLEAN-${op}`, outcome)
  }, 180_000)
}

// WO-2823: the second body comes in through the Model screen's Import, STL or
// STEP alike, and the Boolean offers every body as target and as tool in both
// directions. The cell applies boss STL (target) fuse second body (tool) and
// measures the result against the parts' own dimensions.
type Top = (x: number, y: number) => number
/** generate_parts.py: plate 60x60x10; boss d20 x 12 at (30,30); r3 fillet at its foot. */
const bossTop: Top = (x, y) => {
  if (x < 0 || x > 60 || y < 0 || y > 60) return 0
  const r = Math.hypot(x - 30, y - 30)
  if (r <= 10) return 22
  if (r < 13) return 13 - Math.sqrt(9 - (r - 13) ** 2)
  return 10
}
/** Base 60x40x5; ribs 50x3x15 at x 5..55, y 8..11 and y 29..32. */
const ribTop: Top = (x, y) => {
  if (x < 0 || x > 60 || y < 0 || y > 40) return 0
  if (x >= 5 && x <= 55 && ((y >= 8 && y <= 11) || (y >= 29 && y <= 32))) return 20
  return 5
}
/** Plate 70x40x15; at y 20: x 15 d6.6 through + d11 x 6.5 counterbore;
 *  x 35 d6.6 through + 90 degree countersink to d13; x 55 d5 through. */
const steppedTop: Top = (x, y) => {
  if (x < 0 || x > 70 || y < 0 || y > 40) return 0
  const r1 = Math.hypot(x - 15, y - 20), r2 = Math.hypot(x - 35, y - 20), r3 = Math.hypot(x - 55, y - 20)
  if (r1 < 3.3 || r2 < 3.3 || r3 < 2.5) return 0
  if (r1 < 5.5) return 15 - 6.5
  if (r2 < 6.5) return 11.8 + (r2 - 3.3)
  return 15
}
// Closed forms. Fillet ring: 2*pi * integral_0^3 (13 - u)(3 - sqrt(9 - u^2)) du.
const BOSS_VOLUME = 60 * 60 * 10 + Math.PI * 10 ** 2 * 12 + 2 * Math.PI * (112.5 - 117 * Math.PI / 4)
const RIB_VOLUME = 60 * 40 * 5 + 2 * 50 * 3 * 15
const STEPPED_VOLUME = 70 * 40 * 15 - Math.PI * (2 * 3.3 ** 2 * 15 + (5.5 ** 2 - 3.3 ** 2) * 6.5 +
  (3.2 / 3) * (6.5 ** 2 + 6.5 * 3.3 + 3.3 ** 2) - 3.3 ** 2 * 3.2 + 2.5 ** 2 * 15)
/** The overlap min(topA, topB) by the midpoint rule at 0.01 mm over the shared 60x40 footprint. */
function overlapVolume(a: Top, b: Top): number {
  const h = 0.01
  let v = 0
  for (let x = h / 2; x < 60; x += h) for (let y = h / 2; y < 40; y += h) v += Math.min(a(x, y), b(x, y))
  return v * h * h
}

for (const pair of ['STL+STL', 'STL+STEP'] as const) {
  it(`${pair}-BOOLEAN: a second imported body, target and tool both ways, Apply fuse`, async () => {
    const s = await openStl('boss_fillet_base.stl')
    const name = pair === 'STL+STL' ? 'stepped_holes.stl' : 'rib_part.step'
    const importStart = consoleLines.length
    fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [new File([bytesOf(part(name))], name)] } })
    try {
      await waitFor(() => expect(hooks().getBodyHandle('IMP1')).toBeDefined(), { timeout: 60_000 })
      await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 60_000 })
    } catch {
      await record(`${pair}-BOOLEAN`, { verdict: 'REFUSES', message: consoleLines.slice(importStart).join(' | '), detail: { stage: 'Import', name } })
      return
    }
    const secondVolume = await volumeOf('IMP1')
    fireEvent.click(screen.getByTestId('workbench-boolean'))
    const target = screen.getByTestId('boolean-target-select') as HTMLSelectElement
    const meshId = `stl-body:${s.id}`
    const targetOptions = [...target.options].map((o) => ({ id: o.value, label: o.text }))
    expect(targetOptions.map((o) => o.id)).toEqual([meshId, 'IMP1'])
    // STL target: its tool list holds the primitives and the second body.
    fireEvent.change(target, { target: { value: meshId } })
    const stlToolOptions = [...(screen.getByTestId('boolean-tool-shape-select') as HTMLSelectElement).options].map((o) => o.value)
    expect(stlToolOptions).toEqual(['box', 'cylinder', 'IMP1'])
    // Second body as target: its tool list holds the STL.
    fireEvent.change(target, { target: { value: 'IMP1' } })
    const reverseToolOptions = [...(screen.getByTestId('boolean-tool-select') as HTMLSelectElement).options].map((o) => o.value)
    expect(reverseToolOptions).toEqual(['IMP1', meshId])
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: meshId } })
    const reverseApplyEnabled = !(screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled
    expect(reverseApplyEnabled, text('boolean-selection-error')).toBe(true)
    // Back to the STL as target, the second body as its tool, fuse.
    fireEvent.change(target, { target: { value: meshId } })
    fireEvent.change(screen.getByTestId('boolean-tool-shape-select'), { target: { value: 'IMP1' } })
    fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'fuse' } })
    const apply = screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
    expect(apply.disabled, text('boolean-selection-error')).toBe(false)
    const before = hooks().dag.featureOrder()
    fireEvent.click(apply)
    // Apply adds the STL's import and the Boolean that consumes it.
    let resultId = ''
    try {
      await waitFor(() => {
        resultId = hooks().dag.featureOrder().filter((id) => !before.includes(id)).find((id) => hooks().dag.getNode(id)?.payload.opType === 'boolean') ?? ''
        expect(resultId).not.toBe('')
        expect(['ok', 'failed', 'degraded']).toContain(hooks().scheduler.statusOf(resultId))
      }, { timeout: 120_000 })
    } catch {
      await record(`${pair}-BOOLEAN`, { verdict: 'SILENT', message: `no Boolean landed after Apply: ${text('boolean-apply-error')} ${lastConsole()}`, detail: {} })
      return
    }
    if (hooks().scheduler.statusOf(resultId) !== 'ok') {
      await record(`${pair}-BOOLEAN`, { verdict: 'REFUSES', message: `${resultId} ${hooks().scheduler.statusOf(resultId)}: ${JSON.stringify(hooks().scheduler.diagnosticsOf(resultId))}`, detail: { id: resultId } })
      return
    }
    await waitFor(() => expect(hooks().getBodyHandle(resultId)).toBeDefined(), { timeout: 30_000 })
    const measured = await volumeOf(resultId)
    const [secondTop, secondExact] = pair === 'STL+STL' ? [steppedTop, STEPPED_VOLUME] : [ribTop, RIB_VOLUME]
    const overlap = overlapVolume(bossTop, secondTop)
    const expected = BOSS_VOLUME + secondExact - overlap
    // The STL operands are faceted: their own |faceted - exact| volume, plus 1 mm3.
    const tolerance = Math.abs(s.volume - BOSS_VOLUME) + (pair === 'STL+STL' ? Math.abs(secondVolume - STEPPED_VOLUME) : 0) + 1
    const ok = Math.abs(measured - expected) <= tolerance
    await record(`${pair}-BOOLEAN`, {
      verdict: ok ? 'WORKS' : 'WRONG',
      message: ok ? 'second body offered as target and tool both ways; STL fuse second body applied' : `fused volume ${measured.toFixed(3)}, expected ${expected.toFixed(3)} +/- ${tolerance.toFixed(3)}`,
      detail: {
        check: 'fuse = A + B - I; A, B closed forms from generate_parts.py, I = midpoint integral of min(topA, topB) at 0.01 mm',
        id: resultId, targetOptions, stlToolOptions, reverseToolOptions, reverseApplyEnabled,
        measured: Number(measured.toFixed(3)), expected: Number(expected.toFixed(3)), tolerance: Number(tolerance.toFixed(3)),
        bossExact: Number(BOSS_VOLUME.toFixed(3)), secondExact: Number(secondExact.toFixed(3)), overlap: Number(overlap.toFixed(3)),
        stlVolume: Number(s.volume.toFixed(3)), secondVolume: Number(secondVolume.toFixed(3)),
      },
    })
  }, 240_000)
}

for (const format of ['STEP', 'STL'] as const) {
  it(`${format}-RELIEF: imported rib base, constant-white height image`, async () => {
    const s = format === 'STEP' ? await openStep(part('rib_part.step')) : await openStl('boss_fillet_base.stl')
    aimAt(s.runtime, { x: 15, y: 20, z: 100 }, { x: 15, y: 20, z: 5 }); click()
    const button = screen.getByTestId('workbench-relief') as HTMLButtonElement
    if (button.disabled) { await record(`${format}-RELIEF`, { verdict: 'REFUSES', message: `Relief disabled: ${button.title}`, detail: { stage: 'button' } }); return }
    fireEvent.click(button)
    await waitFor(() => expect(useReliefStore.getState().target).not.toBeNull(), { timeout: 30_000 })
    // A 4x4 opaque white PNG, generated without a browser decoder. Pure white
    // means interior height 1. The specified zero-height border ring is
    // included in the independent B-spline integral below.
    const { zlibSync } = await import('fflate')
    const crc = (a: Uint8Array) => { let c = 0xffffffff; for (const b of a) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0) } return (c ^ 0xffffffff) >>> 0 }
    const chunk = (kind: string, data: Uint8Array) => { const b = Buffer.concat([Buffer.from(kind), data]); const n = Buffer.alloc(4); n.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(b)); return Buffer.concat([n, b, c]) }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 0
    const pixels = new Uint8Array(20).fill(255); for (let y = 0; y < 4; y++) pixels[y * 5] = 0
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(pixels)), chunk('IEND', new Uint8Array())])
    fireEvent.change(screen.getByTestId('relief-file-input'), { target: { files: [new File([png], 'white.png', { type: 'image/png' })] } })
    await waitFor(() => expect(useReliefStore.getState().settings).not.toBeNull(), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('relief-auto-toggle').querySelector('input')!)
    fireEvent.click(screen.getByTestId('relief-dir-raise'))
    commitLabel('Relief width', '4'); commitLabel('Relief depth', '1')
    fireEvent.change(screen.getByTestId('relief-zero-slider'), { target: { value: '0' } })
    if (useReliefStore.getState().settings!.invert) fireEvent.click(screen.getAllByTestId('relief-invert').find((e) => e.tagName === 'LABEL')!.querySelector('input')!)
    // Put the tiny square between the ribs, on the actual selected face.
    commitLabel('Relief move X', '0'); commitLabel('Relief move Y', '0')
    const before = hooks().dag.featureOrder()
    await waitFor(() => expect((screen.getByTestId('relief-apply') as HTMLButtonElement).disabled).toBe(false), { timeout: 30_000 })
    const settings = useReliefStore.getState().settings!
    // Cubic basis endpoint integrals are 1/(4*(n-3)); two zero endpoints
    // remove 1/(2*(n-3)) on each axis. n=4*10+1=41 poles.
    // This is hand integration, not a call to poleSurfaceVolume.
    const expectedRelief = 4 * 4 * (1 - 1 / (2 * (41 - 3))) ** 2
    fireEvent.click(screen.getByTestId('relief-apply'))
    const outcome = await judgeApplied(before, s.volume, expectedRelief)
    await captureWrong(`${format}-RELIEF`, outcome, 'IMP1')
    await record(`${format}-RELIEF`, { ...outcome, detail: { ...outcome.detail, settings, oracle: "16*(1-1/(2*38))^2, zero boundary ring" } })
  }, 180_000)
}

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
  writeFileSync(resolve(process.cwd(), audit.evidenceDir, `${cell}-section.svg`), svg)
}


async function captureWrong(cell: string, outcome: Outcome, sourceId: string): Promise<void> {
  if (outcome.verdict !== 'WRONG' || typeof outcome.detail.id !== 'string') return
  const cut = async (id: string) => {
    const m = await hooks().client.tessellate(hooks().getBodyHandle(id)!, { deflection: 0.05 })
    return sectionOf(m.position, m.index, 'y', 30)
  }
  writeSectionSvg(cell, 'Form result vs imported body', await cut(sourceId), await cut(outcome.detail.id), 'y', 30)
}

for (const format of ['STEP', 'STL'] as const) {
  for (const next of ['pushpull', 'hole'] as const) {
    it(`${format}-CHAIN-${next}: import -> Form rotate -> fillet -> ${next}`, async () => {
      const s = format === 'STEP' ? await fromBody('STEP') : await (async () => {
        const s = await openPrismaticStl()
        fireEvent.click(screen.getByTestId('workbench-form')); fireEvent.click(screen.getByTestId('form-starter-body'))
        await waitFor(() => expect(useFormStore.getState().sourceBodyId).not.toBeNull(), { timeout: 30_000 })
        return { ...s, refusal: undefined as Outcome | undefined }
      })()
      const cell = `${format}-CHAIN-${next}`
      if (s.refusal) { await record(cell, s.refusal); return }
      fireEvent.click(screen.getByTestId('form-select-all'))
      fireEvent.click(screen.getByTestId('form-transform-rotate'))
      fireEvent.change(screen.getByLabelText('Centre rotation axis'), { target: { value: 'z' } })
      commitLabel('Rotation angle', '90'); fireEvent.click(screen.getByTestId('form-rotation-apply'))
      const form = await finishForm(s, 0)
      if (form.verdict !== 'WORKS') { await record(cell, { ...form, detail: { ...form.detail, stage: 'Form' } }); return }
      const formed = { ...s, volume: await volumeOf(String(form.detail.id)) }
      const blend = await blendStep('fillet', formed, [() => aimAt(s.runtime, { x: 62, y: 20, z: 40 }, { x: 42, y: 20, z: 20 })], '1', -(1 - Math.PI / 4) * 50)
      // Compare the blend to the measured Form output; conversion's own
      // approximation is checked separately, never charged to a later edit.
      if (blend.verdict !== 'WORKS') { await record(cell, { ...blend, detail: { ...blend.detail, stage: 'fillet' } }); return }
      const id = String(blend.detail.id)
      const current = { ...s, volume: await volumeOf(id) }
      const faces = await facesOf(id)
      if (next === 'pushpull') {
        const f = findFace(faces, 'unfilleted rib top', (f) => f.type === 'plane' && f.normal.z > 0.99 && Math.abs(f.centroid.z - 20) < 0.01 && f.centroid.x < 25)
        await record(cell, await pushPullStep(current, f, 1, 150))
      } else {
        const before = hooks().dag.featureOrder()
        fireEvent.click(screen.getByTestId('workbench-hole'))
        aimAt(s.runtime, { x: 30, y: 20, z: 100 }, { x: 30, y: 20, z: 5 }); click()
        await waitFor(() => expect(screen.queryByTestId('hole-diameter')).not.toBeNull(), { timeout: 10_000 })
        commitField('hole-diameter', '5'); commitField('hole-blind-distance', '3')
        await record(cell, await previewThenApply('hole', current, before, -Math.PI * 2.5 ** 2 * 3))
      }
    }, 180_000)
  }
}

// All rendered top-level tools are retained in the evidence, including
// construction and document tools. Sketch-only pattern/split operate on
// sketch entities; they are not solid direct-edit operations.
it('INVENTORY: enumerate the production Model and Form rails on an imported part', async () => {
  await openStep(part('rib_part.step'))
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.sketch-tool-btn[data-testid]')].map((b) => ({ id: b.dataset.testid, label: b.textContent?.trim(), disabled: b.disabled, title: b.title }))
  const model = buttons()
  fireEvent.click(screen.getByTestId('workbench-form'))
  const form = buttons()
  fireEvent.click(screen.getByTestId('form-cancel'))
  expect(model.some((b) => b.id === 'workbench-form')).toBe(true)
  cells.INVENTORY = { verdict: 'WORKS', message: 'source and live rail inventory, not an edit verdict', detail: { check: 'live labels and testids', model, form } }
}, 180_000)

function formPointer(kind: 'point' | 'edge' | 'face', runtime: FakeSceneRuntime): void {
  const c = canvas()
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 900 } as DOMRect)
  const camera = runtime.camera as THREE.PerspectiveCamera
  camera.position.set(140, -160, 180); camera.up.set(0, 0, 1); camera.lookAt(30, 20, 10)
  camera.aspect = 4 / 3; camera.fov = 45; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true)
  const cage = useFormStore.getState().cage
  fireEvent.click(screen.getByTestId('form-display-cage'))
  const candidates = kind === 'point' ? cage.positions : kind === 'face'
    ? cage.faces.map((f) => f.reduce((a, i) => a.map((v, k) => v + cage.positions[i][k] / f.length), [0, 0, 0]))
    : cage.faces.flatMap((f) => f.map((a, i) => cage.positions[a].map((v, k) => (v + cage.positions[f[(i + 1) % f.length]][k]) / 2)))
  const overlay = window.__formOverlay!
  for (const point of candidates) {
    const q = overlay.screenOf(point as [number, number, number])
    if (overlay.pickAt(q.x, q.y)?.kind !== kind) continue
    for (const type of ['pointerdown', 'pointerup']) {
      const e = new MouseEvent(type, { clientX: q.x, clientY: q.y, button: 0, buttons: type === 'pointerdown' ? 1 : 0, bubbles: true })
      Object.defineProperty(e, 'pointerId', { value: 1 }); Object.defineProperty(e, 'pointerType', { value: 'mouse' })
      act(() => { c.dispatchEvent(e) })
    }
    return
  }
  throw new Error('fixture camera cannot see a cage ' + kind)
}

for (const format of ['STEP', 'STL'] as const) {
  for (const mode of ['translate', 'scale', 'axis'] as const) {
    it(`${format}-FORM-${mode}: execute on the imported rib cage and finish`, async () => {
      const s = format === 'STEP' ? await fromBody('STEP') : await (async () => {
        const s = await openPrismaticStl()
        fireEvent.click(screen.getByTestId('workbench-form')); fireEvent.click(screen.getByTestId('form-starter-body'))
        await waitFor(() => expect(useFormStore.getState().sourceBodyId).not.toBeNull(), { timeout: 30_000 })
        return s
      })()
      const cell = `${format}-FORM-${mode}`
      fireEvent.click(screen.getByTestId('form-select-all'))
      const original = useFormStore.getState().cage.positions.map((p) => [...p])
      let expected = 0
      if (mode === 'axis') {
        fireEvent.click(screen.getByTestId('form-transform-rotate'))
        fireEvent.change(screen.getByTestId('form-rotation-axis'), { target: { value: 'z' } })
        formPointer('point', s.runtime)
        const axis = useFormStore.getState().rotationAxis!
        expect(axis).not.toBeNull()
        commitLabel('Rotation angle', '90'); fireEvent.click(screen.getByTestId('form-rotation-apply'))
        useFormStore.getState().cage.positions.forEach((p, i) => {
          expect(p[0]).toBeCloseTo(axis.origin[0] - (original[i][1] - axis.origin[1]), 7)
          expect(p[1]).toBeCloseTo(axis.origin[1] + (original[i][0] - axis.origin[0]), 7)
          expect(p[2]).toBeCloseTo(original[i][2], 7)
        })
      } else {
        fireEvent.click(screen.getByTestId(`form-transform-${mode}`))
        const gizmo = formGizmos.at(-1)!
        expect(gizmo.object).toBeDefined()
        const centre = [gizmo.object!.position.x, gizmo.object!.position.y, gizmo.object!.position.z]
        act(() => {
          gizmo.emit('dragging-changed', { value: true })
          if (mode === 'translate') gizmo.object!.position.add(new THREE.Vector3(3, 2, 1))
          else gizmo.object!.scale.setScalar(2)
          gizmo.emit('objectChange')
          gizmo.emit('dragging-changed', { value: false })
        })
        useFormStore.getState().cage.positions.forEach((p, i) => p.forEach((v, k) => expect(v).toBeCloseTo(mode === 'translate' ? original[i][k] + [3, 2, 1][k] : centre[k] + 2 * (original[i][k] - centre[k]), 7)))
        expected = mode === 'scale' ? 16500 * 7 : 0
      }
      const outcome = await finishForm(s, expected)
      await record(cell, { ...outcome, detail: { ...outcome.detail, check: 'every point matches independent transform; translation/rotation preserve 16500 mm3; double scale gives 132000 mm3' } })
    }, 180_000)
  }
}

for (const format of ['STEP', 'STL'] as const) {
  it(`${format}-CONSTRUCT: offset, midplane and angle on the imported model`, async () => {
    if (format === 'STEP') await openStep(part('rib_part.step')); else await openPrismaticStl()
    const apply = async () => {
      await waitFor(() => expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 })
      fireEvent.click(screen.getByTestId('dialog-shell-apply'))
      await waitFor(() => expect(screen.queryByTestId('dialog-shell')).toBeNull(), { timeout: 10_000 })
    }
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-source'), { target: { value: 'datum:XY' } })
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '20' } })
    await apply()
    const frame = (id: string) => hooks().dag.getNode(id)!.payload.lastGoodFrame as { origin: V3; normal: V3 }
    expect(frame('datum:RP1').origin.z).toBeCloseTo(20, 8)
    await record(`${format}-OFFSET`, { verdict: 'WORKS', message: '20 mm from XY', detail: { check: 'datum origin z=20', measured: frame('datum:RP1') } })
    fireEvent.click(screen.getByTestId('workbench-midplane'))
    fireEvent.change(screen.getByTestId('offset-plane-source'), { target: { value: 'datum:XY' } })
    fireEvent.change(screen.getByTestId('construction-plane-second-source'), { target: { value: 'datum:RP1' } })
    await apply()
    expect(frame('datum:RP2').origin.z).toBeCloseTo(10, 8)
    await record(`${format}-MIDPLANE`, { verdict: 'WORKS', message: 'halfway between z=0 and z=20', detail: { check: 'datum origin z=10', measured: frame('datum:RP2') } })
    fireEvent.click(screen.getByTestId('workbench-angle-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-source'), { target: { value: 'datum:XY' } })
    fireEvent.change(screen.getByTestId('construction-plane-angle'), { target: { value: '30' } })
    await apply()
    expect(frame('datum:RP3').normal.y).toBeCloseTo(-0.5, 8)
    expect(frame('datum:RP3').normal.z).toBeCloseTo(Math.sqrt(3) / 2, 8)
    await record(`${format}-ANGLE`, { verdict: 'WORKS', message: 'XY tilted 30 degrees', detail: { check: 'normal y=-sin30,z=cos30', measured: frame('datum:RP3') } })
  }, 180_000)

  it(`${format}-FORM-MIRROR: mirror duplicate across X=0 and Finish`, async () => {
    const s = format === 'STEP' ? await fromBody('STEP') : await (async () => {
      const s = await openPrismaticStl()
      fireEvent.click(screen.getByTestId('workbench-form')); fireEvent.click(screen.getByTestId('form-starter-body'))
      await waitFor(() => expect(useFormStore.getState().sourceBodyId).not.toBeNull(), { timeout: 30_000 })
      return s
    })()
    fireEvent.click(screen.getByTestId('form-mirror-x'))
    fireEvent.click(screen.getByTestId('form-mirror-duplicate'))
    const cage = useFormStore.getState().cage
    expect(Math.min(...cage.positions.map((p) => p[0]))).toBeCloseTo(-60, 7)
    expect(Math.max(...cage.positions.map((p) => p[0]))).toBeCloseTo(60, 7)
    const notice = text('form-notice')
    const outcome = await finishForm(s, 16500)
    await captureWrong(`${format}-FORM-MIRROR`, outcome, format === 'STEP' ? 'IMP1' : hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.kind === 'import')!)
    await record(`${format}-FORM-MIRROR`, { ...outcome, detail: { ...outcome.detail, notice, check: 'mirror spans -60..60 in X, double rib volume = 33000 mm3' } })
  }, 180_000)

  it(`${format}-NO-SOLID-PATTERN-SPLIT: inspect available imported-body routes`, async () => {
    if (format === 'STEP') await openStep(part('rib_part.step')); else await openPrismaticStl()
    const ids = [...document.querySelectorAll('button[data-testid]')].map((b) => b.getAttribute('data-testid'))
    expect(ids.filter((id) => /workbench-(pattern|mirror|split|scale|rotate)/.test(id ?? ''))).toEqual([])
    for (const tool of ['PATTERN', 'SPLIT']) await record(`${format}-${tool}`, { verdict: 'REFUSES', message: `No solid-body ${tool.toLowerCase()} tool on the Model rail. Sketch tools require sketch entities.`, detail: { route: 'Model rail', offered: false } })
  }, 180_000)
}

for (const format of ['STEP', 'STL'] as const) {
  for (const tool of ['axis', 'point', 'plane-through', 'tangent-plane'] as const) {
    it(`${format}-CONSTRUCT-${tool}: pick imported rib geometry, Apply, measure datum`, async () => {
      const s = format === 'STEP' ? await openStep(part('rib_part.step')) : await openPrismaticStl()
      const before = new Set(hooks().dag.nodeIds())
      fireEvent.click(screen.getByTestId(`workbench-${tool}`))
      if (tool === 'axis') {
        fireEvent.change(screen.getByTestId('axis-type'), { target: { value: 'edge' } })
        aimAt(s.runtime, { x: 30, y: -50, z: 55 }, { x: 30, y: 0, z: 5 }); click()
      } else if (tool === 'point') {
        aimAt(s.runtime, { x: -50, y: -50, z: 55 }, { x: 0, y: 0, z: 5 }); click()
      } else if (tool === 'tangent-plane') {
        aimAt(s.runtime, { x: 15, y: 20, z: 100 }, { x: 15, y: 20, z: 5 }); click()
      } else {
        for (const [x, y] of [[0, 0], [60, 0], [60, 40]]) {
          aimAt(s.runtime, { x: x === 0 ? -50 : 110, y: y === 0 ? -50 : 90, z: 55 }, { x, y, z: 5 }); click()
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
        }
      }
      const prefix = tool === 'point' ? 'point-datum' : tool === 'axis' ? 'axis' : 'picked-plane'
      await waitFor(() => expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 })
      const picked = text(`${prefix}-picked`)
      fireEvent.click(screen.getByTestId('dialog-shell-apply'))
      await waitFor(() => expect(screen.queryByTestId('dialog-shell')).toBeNull(), { timeout: 10_000 })
      const node = hooks().dag.getNode(hooks().dag.nodeIds().find((id) => !before.has(id))!)!
      expect(node).toBeDefined()
      const payload = node.payload
      const frame = payload.lastGoodFrame as { origin: V3; normal: V3 } | undefined
      const axis = payload.lastGoodAxis as { origin: V3; dir: V3 } | undefined
      const point = payload.lastGoodPoint as V3 | undefined
      if (frame) { expect(frame.origin.z).toBeCloseTo(5, 4); expect(Math.abs(frame.normal.z)).toBeCloseTo(1, 6) }
      if (axis) { expect(Math.abs(axis.dir.x)).toBeCloseTo(1, 6); expect(axis.origin.y).toBeCloseTo(0, 4); expect(axis.origin.z).toBeCloseTo(5, 4) }
      if (point) { expect(point.x).toBeCloseTo(0, 4); expect(point.y).toBeCloseTo(0, 4); expect(point.z).toBeCloseTo(5, 4) }
      expect(frame !== undefined || axis !== undefined || point !== undefined).toBe(true)
      await record(`${format}-CONSTRUCT-${tool}`, { verdict: 'WORKS', message: picked, detail: { check: 'hand coordinates: base top z=5; edge along X at y=0,z=5; corner (0,0,5)', payload } })
    }, 180_000)
  }
}

for (const op of ['fuse', 'cut', 'intersect']) {
  it(`STEP-BOOLEAN-different-${op}: rib and stepped-hole plate, analytic intersection`, async () => {
    const s = await openStep(part('rib_part.step'))
    await importMore('stepped_holes.step', 'IMP2')
    const second = await volumeOf('IMP2')
    // Both ribs overlap the plate for 10 mm above the base. All three holes
    // miss the ribs, and pierce the 5 mm base at their pilot diameters.
    const overlap = 60 * 40 * 5 + 2 * 50 * 3 * 10 - 5 * Math.PI * (2 * 3.3 ** 2 + 2.5 ** 2)
    const total = op === 'fuse' ? s.volume + second - overlap : op === 'cut' ? s.volume - overlap : overlap
    fireEvent.click(screen.getByTestId('workbench-boolean'))
    fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'IMP1' } })
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'IMP2' } })
    fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: op } })
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    const outcome = await judgeApplied(before, s.volume, total - s.volume)
    await captureWrong(`STEP-BOOLEAN-different-${op}`, outcome, 'IMP1')
    await record(`STEP-BOOLEAN-different-${op}`, { ...outcome, detail: { ...outcome.detail, overlap, expectedTotal: total } })
  }, 180_000)
}

for (const format of ['STEP', 'STL'] as const) {
  it(`${format}-DOCUMENT: export STEP/STL/debug, reimport exported STEP and measure`, async () => {
    const s = format === 'STEP' ? await openStep(part('rib_part.step')) : await openPrismaticStl()
    const blobs: Blob[] = []
    const savedCreate = URL.createObjectURL, savedRevoke = URL.revokeObjectURL
    URL.createObjectURL = ((blob: Blob) => { blobs.push(blob); return 'blob:wo2819-export' }) as typeof URL.createObjectURL
    URL.revokeObjectURL = () => {}
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const read = (blob: Blob): Promise<ArrayBuffer> => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as ArrayBuffer); r.onerror = reject; r.readAsArrayBuffer(blob) })
    try {
      fireEvent.click(screen.getByTestId('workbench-export-step'))
      await waitFor(() => expect(blobs.length).toBe(1), { timeout: 30_000 })
      const step = await read(blobs[0])
      expect(new TextDecoder().decode(step)).toContain('ISO-10303-21')
      fireEvent.click(screen.getByTestId('workbench-export-stl'))
      await waitFor(() => expect(blobs.length).toBe(2), { timeout: 30_000 })
      const stl = await read(blobs[1])
      const { resolveEditedStlMesh } = await import('../../mesh/edit')
      const mesh = resolveEditedStlMesh(stl, undefined).mesh
      const exportedVolume = meshVolume(mesh.positions, mesh.indices)
      expect(exportedVolume).toBeCloseTo(16500, 1)
      await record(`${format}-EXPORT-STL`, { verdict: 'WORKS', message: 'exported imported rib', detail: { expectedDelta: 0, check: 'signed tetrahedral volume of exported STL = 16500 mm3', exportedVolume, bytes: stl.byteLength } })
      fireEvent.click(screen.getByTestId('workbench-debug-export'))
      await waitFor(() => expect(blobs.length).toBe(3), { timeout: 30_000 })
      const debug = new TextDecoder().decode(await read(blobs[2]))
      const snapshot = JSON.parse(debug)
      expect(JSON.parse(snapshot.dag).nodes.some((n: { kind: string }) => n.kind === (format === 'STEP' ? 'import' : 'meshImport'))).toBe(true)
      await record(`${format}-DEBUG`, { verdict: 'WORKS', message: 'debug scene includes the imported source', detail: { check: 'download emitted valid JSON retaining import or meshImport source node', keys: Object.keys(JSON.parse(debug)) } })
      const oldIds = new Set(hooks().dag.featureOrder())
      fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [new File([step], 'roundtrip.step')] } })
      await waitFor(() => expect(hooks().dag.featureOrder().some((id) => !oldIds.has(id) && hooks().getBodyHandle(id) !== undefined)).toBe(true), { timeout: 30_000 })
      const id = hooks().dag.featureOrder().find((id) => !oldIds.has(id))!
      const volume = await volumeOf(id)
      expect(volume).toBeCloseTo(16500, 3)
      await record(`${format}-EXPORT-STEP`, { verdict: 'WORKS', message: 'exported STEP reimported through the Model picker', detail: { expectedDelta: 0, check: 'roundtrip volume = 60*40*5+2*50*3*15', volume, bytes: step.byteLength, sourceVolume: s.volume } })
    } finally {
      click.mockRestore(); URL.createObjectURL = savedCreate; URL.revokeObjectURL = savedRevoke
    }
  }, 180_000)
}
