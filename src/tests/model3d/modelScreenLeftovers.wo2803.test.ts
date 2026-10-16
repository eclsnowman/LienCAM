// @vitest-environment jsdom
// WO-2803: production Model-screen entry, real STL replay and STEP kernel.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
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
const part = (name: string) => resolve(PARTS, name)

type V3 = { x: number; y: number; z: number }

const cells: Record<string, unknown>[] = []
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
  if (cells.length === 3) writeFileSync(resolve('src/tests/evidence/WO-2803/cells.json'), JSON.stringify(cells, null, 2) + '\n')
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

function aimAt(runtime: FakeSceneRuntime, from: V3, to: V3): void {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const l = Math.hypot(d.x, d.y, d.z)
  runtime.rayOverride = { origin: from, direction: { x: d.x / l, y: d.y / l, z: d.z / l } }
}

function click(): void {
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
}


const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let consoleLines: string[] = []
const text = (id: string) => screen.queryByTestId(id)?.textContent ?? ""
interface StepSession { runtime: FakeSceneRuntime; volume: number }
interface StlSession { runtime: FakeSceneRuntime; id: string; bytes: ArrayBuffer; volume: number }
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
  if (wrapped?.ok !== true) throw new Error(`Edit as model refused: ${wrapped?.reason ?? '?'} ${lastConsole()}`)
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(createElement(SolidsWorkbenchPage, { createClient: () => createFakeGeomClient(), createSceneRuntime: () => runtime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  try {
    await waitFor(() => expect(screen.getByTestId(`body-row-stl-body:${id}`)).toBeTruthy(), { timeout: 30_000 })
  } catch {
    throw new Error(`no STL body in the Model screen: ${consoleLines.join(' | ')}`)
  }
  const s = { runtime, id, bytes, volume: 0 }
  s.volume = await stlVolume(s)
  return s
}

afterEach(() => { useCamStore.getState().addConsoleEvent = realAddConsoleEvent })

const lastConsole = () => consoleLines.slice(-2).join(' | ')


const P = (x: number, y: number, z: number): V3 => ({ x, y, z })
const status = (id: string) => screen.getByTestId(id).getAttribute('data-status')
async function applyPush(delta: number): Promise<void> {
  const input = screen.getByTestId('pushpull-delta-entry-input')
  fireEvent.change(input, { target: { value: String(delta) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(status('pushpull-delta-entry-status')).toBe('ready'), { timeout: 30000 })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull())
}
async function pickPush(s: StlSession, from: V3, to: V3): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  aimAt(s.runtime, from, to); click()
  await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).not.toBeNull(), { timeout: 8000 })
}
async function expectDelta(s: StlSession, delta: number): Promise<void> {
  await waitFor(async () => expect(Math.abs(await stlVolume(s) - s.volume - delta)).toBeLessThan(Math.abs(delta) * 0.03))
}
describe('WO-2803 Model screen leftovers', () => {
  it('SED-1 reopens the stored +2, rewrites it to +3, and Undo/Redo restores the same row', async () => {
    const s = await openStl('boss_fillet_base.stl')
    await pickPush(s, P(31,31,40), P(31,31,22)); await applyPush(2)
    const area = 100 * Math.PI
    await expectDelta(s, 2 * area)
    const record = journalOf(s.id)![0]
    const rowId = `stl-edit:${record.id}`
    await waitFor(() => expect(screen.queryByTestId(`feature-row-${rowId}`)).not.toBeNull(), { timeout: 8000 })
    fireEvent.click(screen.getByTestId(`feature-row-${rowId}`))
    expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    await waitFor(() => expect((screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement).value).toBe('2'))
    await applyPush(3)
    expect(journalOf(s.id)).toHaveLength(1)
    expect(journalOf(s.id)![0].id).toBe(record.id)
    await expectDelta(s, 3 * area)
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(journalOf(s.id)![0]?.parameters.distanceMm).toBe(2))
    await expectDelta(s, 2 * area)
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(journalOf(s.id)![0]?.parameters.distanceMm).toBe(3))
    await expectDelta(s, 3 * area)
    const finalVolume = await stlVolume(s)
    const persisted = JSON.parse(JSON.stringify(journalOf(s.id)))
    fireEvent.click(screen.getByTestId(`stl-edit-reopen-${record.id}`))
    await waitFor(() => expect((screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement).value).toBe('3'))
    fireEvent.change(screen.getByTestId('pushpull-delta-entry-input'), { target: { value: '9' } })
    fireEvent.click(screen.getByTestId('pushpull-delta-entry-cancel'))
    expect(journalOf(s.id)).toEqual(persisted)
    await expectDelta(s, 3 * area)
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(journalOf(s.id)?.[0]?.parameters.distanceMm).toBe(2))
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(journalOf(s.id) ?? []).toHaveLength(0))
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(journalOf(s.id)?.[0]?.id).toBe(record.id))
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(journalOf(s.id)?.[0]?.parameters.distanceMm).toBe(3))
    expect(journalOf(s.id)).toHaveLength(1)
    await expectDelta(s, 3 * area)
    cells.push({ cell: 'SED-1', verdict: 'WORKS', beforeVolume: s.volume, afterVolume: finalVolume,
      measuredDelta: finalVolume - s.volume, handDelta: 3 * area, handFormula: '3 * pi * 10^2', tolerance: '3% STL tessellation',
      evidence: 'tree reopen +2 -> +3 keeps ID; Undo +2; Redo +3; Cancel leaves persisted journal unchanged' })
  }, 120000)
  it('SED-1 orders burst Undo/Redo across replacements and original creation', async () => {
    const s = await openStl('boss_fillet_base.stl')
    await pickPush(s, P(31,31,40), P(31,31,22)); await applyPush(2)
    const recordId = journalOf(s.id)![0].id
    for (const delta of [3, 4]) {
      fireEvent.click(screen.getByTestId(`stl-edit-reopen-${recordId}`))
      await waitFor(() => expect((screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement).value).toBe(String(delta - 1)))
      await applyPush(delta)
    }
    const area = 100 * Math.PI
    await expectDelta(s, 4 * area)
    const burst = async (direction: 'undo' | 'redo', count: number): Promise<void> => {
      // Same-turn presses: no await between the production history actions.
      await act(async () => {
        for (let i = 0; i < count; i++) fireEvent.click(screen.getByTestId(`workbench-${direction}`))
      })
    }
    const expectRecord = async (distance: number): Promise<void> => {
      await waitFor(() => {
        expect(journalOf(s.id)).toHaveLength(1)
        expect(journalOf(s.id)![0].id).toBe(recordId)
        expect(journalOf(s.id)![0].parameters.distanceMm).toBe(distance)
      })
      await expectDelta(s, distance * area)
      expect(journalOf(s.id)).toHaveLength(1)
    }
    await burst('undo', 2)
    await expectRecord(2)
    await burst('redo', 2)
    await expectRecord(4)
    // Creation shares the ordering domain with both replacement commands.
    await burst('undo', 3)
    await waitFor(() => expect(journalOf(s.id) ?? []).toHaveLength(0))
    expect(await stlVolume(s)).toBeCloseTo(s.volume, 6)
    await burst('redo', 3)
    await expectRecord(4)
    expect(consoleLines.some(line => /did not|failed|error/i.test(line))).toBe(false)
  // This sequence replays nine history mutations in addition to three tool
  // Applies; allow the real mesh/recognition work on the shared lane host.
  }, 300000)
  it('SED-1 preserves a later independent edit when rewriting an earlier Push/Pull', async () => {
    const s = await openStl('boss_fillet_base.stl')
    await pickPush(s, P(31,31,40), P(31,31,22)); await applyPush(2)
    await pickPush(s, P(5,5,30), P(5,5,10)); await applyPush(1)
    const [first, later] = journalOf(s.id)!
    fireEvent.click(screen.getByTestId(`stl-edit-reopen-${first.id}`))
    await waitFor(() => expect((screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement).value).toBe('2'))
    await applyPush(3)
    expect(journalOf(s.id)).toHaveLength(2)
    expect(journalOf(s.id)![1]).toEqual(later)
    const { resolveEditedStlMesh } = await import('../../mesh/edit')
    expect(resolveEditedStlMesh(s.bytes, journalOf(s.id)).stopped).toBeUndefined()
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(journalOf(s.id)?.[0]?.parameters.distanceMm).toBe(2))
    await waitFor(() => expect(journalOf(s.id)?.[1]).toEqual(later))
  }, 120000)
  it('SPP-5 picks the counterbore floor and moves -2 by its annular area', async () => {
    const s = await openStl('stepped_holes.stl')
    await pickPush(s, P(19.4,20,30), P(19.4,20,8.5)); await applyPush(-2)
    const area = (5.5 ** 2 - 3.3 ** 2) * Math.PI
    await expectDelta(s, -2 * area)
    expect(journalOf(s.id)).toHaveLength(1)
    const afterVolume = await stlVolume(s)
    cells.push({ cell: 'SPP-5', verdict: 'WORKS', beforeVolume: s.volume, afterVolume,
      measuredDelta: afterVolume - s.volume, handDelta: -2 * area, handFormula: '-2 * pi * (5.5^2 - 3.3^2)', tolerance: '3% STL tessellation' })
  }, 120000)
  it('CH-3 ignores a true cylinder seam and still picks and chamfers the circular rim', async () => {
    const s = await openStep(part('stepped_holes.step'))
    const mesh = await hooks().client.tessellate(hooks().getBodyHandle('IMP1')!, { deflection: 0.05 })
    const seamIds = mesh.edgeIds.filter((_, i) => mesh.edgeClasses?.[i] === 'seam')
    expect(seamIds.length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('workbench-chamfer'))
    aimAt(s.runtime, P(19,20,11), P(20.5,20,11)); fireEvent.pointerMove(canvas())
    for (const id of seamIds) expect(hooks().getPickHighlightState(id)).toBe('none')
    click()
    expect(text('chamfer-edge-count')).toMatch(/0 edge/)
    aimAt(s.runtime, P(15,35.5,25), P(15,25.5,15)); click()
    await waitFor(() => expect(text('chamfer-edge-count')).toMatch(/1 edge/))
    const input = screen.getByTestId('chamfer-distance').querySelector('input')!
    fireEvent.change(input, { target: { value: '0.5' } }); fireEvent.blur(input)
    await waitFor(() => expect(status('chamfer-preview-status')).toBe('ready'), { timeout: 30000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.featureOrder().some(id => hooks().dag.getNode(id)?.payload.opType === 'chamfer')).toBe(true))
    const id = hooks().dag.featureOrder().find(id => hooks().dag.getNode(id)?.payload.opType === 'chamfer')!
    await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30000 })
    const afterVolume = await volumeOf(id)
    const handDelta = -0.125 * 2 * Math.PI * (5.5 + 0.5 / 3)
    expect(afterVolume - s.volume).toBeCloseTo(handDelta, 1)
    cells.push({ cell: 'CH-3', verdict: 'WORKS', seamIds, beforeVolume: s.volume, afterVolume,
      measuredDelta: afterVolume - s.volume, handDelta, handFormula: '-0.125 * 2 * pi * (5.5 + 0.5/3)',
      evidence: 'viewport hover ignores seam; click selects 0 edges; circular rim selects 1 and chamfers 0.5 mm' })
  }, 120000)
})
