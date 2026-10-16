// @vitest-environment jsdom
//
// WO-2795 (audit cell ED-2): the tree's Edit reopens a Resize Hole made on an
// imported hole. The REAL Model screen on the REAL in-process occt kernel: the
// plate comes in through the screen's Import input, the hole wall is picked by
// a viewport ray, and every edit goes through the tree's context menu, the
// anchored entry, Apply and the Undo button. The kernel is read only to
// MEASURE volumes, judged against hand formulas.
//
// Why it refused: the kernel rebuilds a resized hole's wall from its other end
// (stored `hole:20:20:10:0:0:1:3`, live `hole:20:20:0:0:0:-1:4`), so the edit
// could not find "the same hole" on the live body. It is now resolved on the
// owner body the resize replays on.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import type { BodyHandle } from '../../geom/geom-service'
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

const PLATE = resolve(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step')
const PI = Math.PI
/** fix_plate_holes is 10 mm thick; the hole at (20,20) is d6 through. */
const THICK = 10
const throughDelta = (from: number, to: number) => -THICK * PI * ((to / 2) ** 2 - (from / 2) ** 2)

let consoleLines: string[] = []
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  stepCache.clear()
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
const text = (testId: string) => screen.queryByTestId(testId)?.textContent ?? ''
const statusOf = (testId: string) => screen.queryByTestId(testId)?.getAttribute('data-status') ?? null
const newFeatureId = (before: string[]) => hooks().dag.featureOrder().find((f) => !before.includes(f)) ?? ''
const refusals = (from: number) => consoleLines.slice(from).filter((l) => /cannot reopen|refused/i.test(l))

function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

async function openPlate(): Promise<{ runtime: FakeSceneRuntime; volume: number }> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 200, y: 200 }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([bytesOf(PLATE)], 'fix_plate_holes.step', { type: 'application/octet-stream' })] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
  return { runtime, volume: await volumeOf('IMP1') }
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId) as BodyHandle | undefined
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

/** Aim the viewport ray from `from` at `to` (mm) and click. */
function clickAt(runtime: FakeSceneRuntime, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const l = Math.hypot(d.x, d.y, d.z)
  runtime.rayOverride = { origin: from, direction: { x: d.x / l, y: d.y / l, z: d.z / l } }
  fireEvent.pointerMove(canvas())
  fireEvent.click(canvas())
}

/** A ray across the hole at (x,y) mid-thickness, from inside the bore, so it
 *  lands on the wall whatever the hole's diameter. */
const clickHoleWall = (runtime: FakeSceneRuntime, x: number, y: number, z = THICK / 2) =>
  clickAt(runtime, { x, y, z }, { x: x + 10, y, z })

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

/** Arm Resize Hole, pick the wall at (x,y), type `diameter`, Apply; returns the new node id. */
async function resizeHole(runtime: FakeSceneRuntime, x: number, y: number, diameter: string, z?: number): Promise<string> {
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('workbench-resize-hole'))
  await waitFor(() => expect(text('solids-workbench-resizehole-hint')).not.toMatch(/recognizing/i), { timeout: 30_000 })
  clickHoleWall(runtime, x, y, z)
  await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
  fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: diameter } })
  await waitFor(() => expect(statusOf('resize-hole-anchor-entry-status')).toBe('ready'), { timeout: 60_000 })
  fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
  let id = ''
  await waitFor(() => {
    id = newFeatureId(before)
    expect(hooks().scheduler.statusOf(id)).toBe('ok')
  }, { timeout: 60_000 })
  // Leave the tool, as an operator does before going to the tree.
  fireEvent.click(screen.getByTestId('workbench-resize-hole'))
  await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())
  return id
}

function treeEdit(id: string): void {
  fireEvent.contextMenu(screen.getByTestId(`feature-row-${id}`), { clientX: 40, clientY: 60 })
  fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
}

describe('WO-2795 ED-2: the tree Edit reopens a Resize Hole on an imported hole', () => {
  it('opens on d9, re-applies d10 to the hand volume, and Undo returns to d9', async () => {
    const s = await openPlate()
    const id = await resizeHole(s.runtime, 20, 20, '9')
    expect(hooks().dag.getNode(id)?.payload.newDiameter).toBe(9)
    expect((await volumeOf(id)) - s.volume).toBeCloseTo(throughDelta(6, 9), 1)
    const order = hooks().dag.featureOrder()

    const from = consoleLines.length
    treeEdit(id)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(refusals(from), consoleLines.slice(from).join(' | ')).toEqual([])
    // Opens with the diameter the hole has now.
    expect((screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement).value).toBe('9')

    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '10' } })
    await waitFor(() => expect(['ready', 'refused']).toContain(statusOf('resize-hole-anchor-entry-status')), { timeout: 60_000 })
    expect(statusOf('resize-hole-anchor-entry-status'), text('resize-hole-anchor-entry-status')).toBe('ready')
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(hooks().dag.getNode(id)?.payload.newDiameter).toBe(10), { timeout: 30_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30_000 })
    // The SAME node was rewritten; nothing was added to the tree.
    expect(hooks().dag.featureOrder()).toEqual(order)
    expect((await volumeOf(id)) - s.volume).toBeCloseTo(throughDelta(6, 10), 1)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode(id)?.payload.newDiameter).toBe(9), { timeout: 30_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf(id)).toBe('ok'), { timeout: 30_000 })
    await waitFor(async () => expect((await volumeOf(id)) - s.volume).toBeCloseTo(throughDelta(6, 9), 1), { timeout: 30_000 })
    expect(hooks().dag.featureOrder()).toEqual(order)
  }, 240_000)

  it('a hole deleted upstream still refuses, in one plain line', async () => {
    const s = await openPlate()
    // A new d5 x 3 hole at (60,50) on the plate top, then resize it to d6:
    // the resize's owner is the Hole step.
    const before = hooks().dag.featureOrder()
    fireEvent.click(screen.getByTestId('workbench-hole'))
    clickAt(s.runtime, { x: 60, y: 50, z: 20 }, { x: 60, y: 50, z: THICK })
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy(), { timeout: 20_000 })
    commitField('hole-diameter', '5')
    commitField('hole-blind-distance', '3')
    await waitFor(() => expect(statusOf('hole-preview-status')).toBe('ready'), { timeout: 60_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    let holeId = ''
    await waitFor(() => {
      holeId = newFeatureId(before)
      expect(hooks().scheduler.statusOf(holeId)).toBe('ok')
    }, { timeout: 60_000 })
    expect((await volumeOf(holeId)) - s.volume).toBeCloseTo(-PI * 2.5 ** 2 * 3, 1)
    const id = await resizeHole(s.runtime, 60, 50, '6', THICK - 1.5)
    expect(hooks().dag.getNode(id)?.payload.ownerId).toBe(holeId)

    // Delete the hole upstream: suppress the Hole step.
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${holeId}`), { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByTestId('tree-context-menu-suppress'))
    await waitFor(() => expect(hooks().scheduler.statusOf(id)).not.toBe('ok'), { timeout: 30_000 })

    const from = consoleLines.length
    treeEdit(id)
    await waitFor(() => expect(refusals(from)).not.toEqual([]), { timeout: 20_000 })
    expect(refusals(from), consoleLines.slice(from).join(' | ')).toEqual([
      'Resize hole: cannot reopen "Resize hole to 6 mm" - the hole it resized is not found on the body as it stands now, so there is nothing to attach the edit to. To change it, delete this step in the tree and resize the hole again.',
    ])
    expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull()
    expect(hooks().dag.getNode(id)?.payload.newDiameter).toBe(6)
  }, 240_000)
})
