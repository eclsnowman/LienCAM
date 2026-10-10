// @vitest-environment jsdom
//
// WO-2091: change a hole's depth from the Model screen. Imports
// test_fixtures/brep/fix_plate_holes.step (10 mm plate, six through holes)
// through the app's own STEP import, arms Resize hole, switches it to Depth,
// picks the Ø10 hole and drives the real anchored entry: through -> blind at
// 5 mm, blind 5 -> 8 mm, then Through again; Undo restores the prior body.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
}))
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { createLocalGeomService } from '../../geom'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { stubCanvas2d } from './stubCanvas2d'

const STEP_FIXTURE = resolve(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step')
const HOLE = 'hole:30:40:' // the Ø10 through hole; matched by x:y (either opening may name it)

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

const cylinder = (diameter: number, length: number): number => Math.PI * (diameter / 2) ** 2 * length

let restoreCanvas2d: (() => void) | null = null

beforeEach(() => {
  stepBytes.clear()
  resetDocumentHolder()
  restoreCanvas2d = stubCanvas2d()
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  vi.unstubAllGlobals()
  resetDocumentHolder()
})

async function importFixture(): Promise<void> {
  const createSceneRuntime = (): FakeSceneRuntime => {
    const rt = createFakeSceneRuntime()
    rt.projectToCanvasResult = { x: 200, y: 200 }
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={createSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const source = readFileSync(STEP_FIXTURE)
  const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([sourceBytes], 'fix_plate_holes.step')] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 20_000 })
}

async function volumeOf(featureId: string): Promise<number> {
  const handle = hooks().getBodyHandle(featureId)
  if (handle === undefined) throw new Error(`${featureId} has no live body`)
  return (await hooks().client.measure(handle, 'volume')).value
}

async function holeOn(featureId: string): Promise<{ featureClass: string; depth: number; diameter: number }> {
  const verdicts = await hooks().client.recognizeFeatures(hooks().getBodyHandle(featureId)!)
  const hole = verdicts.find((v) => v.featureKey.startsWith(HOLE))
  if (hole === undefined) throw new Error(`hole ${HOLE} not recognized on ${featureId}`)
  return { featureClass: hole.featureClass, depth: Number(hole.params.depth), diameter: Number(hole.params.diameter) }
}

async function waitRecognized(): Promise<void> {
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i),
    { timeout: 20_000 },
  )
}

/** Picks the Ø10 hole from the supplement list (same effect as a viewport click). */
async function pickHole(): Promise<void> {
  await waitRecognized()
  fireEvent.click(screen.getByTestId('workbench-resizehole-list'))
  await waitFor(() => expect(screen.getByTestId('resize-hole-picker')).toBeTruthy(), { timeout: 20_000 })
  const option = screen.getAllByRole('radio').find((el) => (el.getAttribute('data-feature-key') ?? '').startsWith(HOLE))
  expect(option, 'the Ø10 hole is listed').toBeDefined()
  fireEvent.click(option!)
  await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
}

async function waitPreviewReady(): Promise<void> {
  await waitFor(() => {
    const readout = screen.getByTestId('resize-hole-anchor-entry-status')
    if (readout.getAttribute('data-status') === 'refused') throw new Error(readout.textContent ?? 'preview refused')
    expect(readout.getAttribute('data-status')).toBe('ready')
  }, { timeout: 20_000 })
}

/** Applies the entry and returns the new resizeHole node id. */
async function applyEntry(): Promise<string> {
  const prior = new Set(hooks().dag.featureOrder())
  await waitPreviewReady()
  fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
  await waitFor(() => {
    if (screen.queryByTestId('resize-hole-anchor-entry') !== null) {
      throw new Error(screen.queryByTestId('resize-hole-anchor-entry-apply-error')?.textContent ?? 'apply pending')
    }
  }, { timeout: 20_000 })
  const id = hooks().dag.featureOrder().find((f) => !prior.has(f) && hooks().dag.getNode(f)?.payload.opType === 'resizeHole')
  expect(id).toBeDefined()
  await waitFor(() => expect(hooks().getBodyHandle(id!)).not.toBeUndefined(), { timeout: 30_000 })
  expect(hooks().scheduler.statusOf(id!)).toBe('ok')
  return id!
}

describe('WO-2091: Hole depth from the Model screen', () => {
  it('through -> blind 5 mm -> 8 mm -> through on the imported plate, and Undo restores', async () => {
    useCamStore.getState().newProject()
    await importFixture()
    const v0 = await volumeOf('IMP1')
    expect((await holeOn('IMP1')).featureClass).toBe('throughHole')

    // Resize hole offers Depth; the switch retitles the pick.
    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-resizehole-field'))
    await waitRecognized()
    expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).toMatch(/change its depth/i)
    expect(screen.getByTestId('workbench-resizehole-field').textContent).toMatch(/diameter/i)

    // 1) through -> blind at 5 mm.
    await pickHole()
    expect(screen.getByTestId('resize-hole-anchor-entry').textContent).toMatch(/Hole depth/)
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toMatch(/10 mm \(through\)/)
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '5' } })
    expect(screen.getByTestId('resize-hole-anchor-entry-delta').textContent).toContain('-5 mm')
    const d1 = await applyEntry()
    expect(hooks().dag.getNode(d1)?.payload).toMatchObject({ holeEdit: 'depth', currentDepth: 10, currentThrough: true, newDepth: 5, delta: 0 })
    const v1 = await volumeOf(d1)
    expect(v1 - v0).toBeCloseTo(cylinder(10, 5), 2)
    expect(await holeOn(d1)).toMatchObject({ featureClass: 'blindHole' })
    expect((await holeOn(d1)).depth).toBeCloseTo(5, 3)
    expect((await holeOn(d1)).diameter).toBeCloseTo(10, 3)

    // Still armed on Depth after Apply. 2) blind 5 -> 8 mm.
    expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).toMatch(/change its depth/i)
    await pickHole()
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toMatch(/5 mm/)
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    const d2 = await applyEntry()
    const v2 = await volumeOf(d2)
    expect(v1 - v2).toBeCloseTo(cylinder(10, 3), 2)
    expect((await holeOn(d2)).depth).toBeCloseTo(8, 3)
    expect((await holeOn(d2)).diameter).toBeCloseTo(10, 3)

    // 3) blind -> through with the entry's Through button.
    await pickHole()
    fireEvent.click(screen.getByTestId('workbench-holedepth-through'))
    const d3 = await applyEntry()
    expect(hooks().dag.getNode(d3)?.payload).toMatchObject({ holeEdit: 'depth', newDepth: 'through' })
    expect(await volumeOf(d3)).toBeCloseTo(v0, 2)
    expect((await holeOn(d3)).featureClass).toBe('throughHole')

    // Undo removes the last edit: the 8 mm blind hole's body is live again.
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode(d3)).toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyHandle(d2)).not.toBeUndefined(), { timeout: 20_000 })
    expect(await volumeOf(d2)).toBeCloseTo(v2, 2)
    expect((await holeOn(d2)).depth).toBeCloseTo(8, 3)
  }, 180_000)
})
