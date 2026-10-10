// @vitest-environment jsdom
//
// The Construct group's Midplane and At angle buttons, through the real workbench page: the one
// construction-plane dialog in each mode, viewport picks, Apply, the datum it writes and its frame,
// Edit, and a reload.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const { stepStore } = vi.hoisted(() => ({ stepStore: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepStore.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepStore.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepStore.delete(id) }),
}))
vi.mock('../../lib/import/stepAttributes', () => typedMock<typeof import('../../lib/import/stepAttributes')>({
  readStepDisplayAttributes: vi.fn(async () => ({ name: 'Imported fixture', partCount: 1 })),
}))

import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { FeatureDag } from '../../doc'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import type { GeomClient } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { buildOffsetPlaneDatumNodeInput, isOffsetPlaneDatumPayload, type OffsetPlaneDatumPayload } from '../../sketch3d'
import { useCamStore } from '../../store'

let restoreCanvas: (() => void) | null = null

beforeEach(() => {
  restoreCanvas = stubCanvas2d()
  stepStore.clear()
  useCamStore.setState({ consoleEvents: [] })
})
afterEach(() => {
  cleanup()
  restoreCanvas?.()
  restoreCanvas = null
})

function hooks(): SolidsWorkbenchHooks {
  if (window.__solidsWorkbenchHooks === undefined) throw new Error('workbench hooks unavailable')
  return window.__solidsWorkbenchHooks
}

async function boot(createClient: () => GeomClient = createFakeGeomClient): Promise<FakeSceneRuntime> {
  let runtime: FakeSceneRuntime | null = null
  const createRuntime: CreateSceneRuntime = () => {
    runtime = createFakeSceneRuntime()
    return runtime
  }
  render(<SolidsWorkbenchPage createClient={createClient} createSceneRuntime={createRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  const canvas = screen.getByTestId('solids-workbench-canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect)
  return runtime as unknown as FakeSceneRuntime
}

async function waitForApplyEnabled(): Promise<void> {
  await waitFor(() => expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false))
}
const payloadOf = (id: string) => {
  const node = hooks().dag.getNode(id)
  if (node === undefined || !isOffsetPlaneDatumPayload(node.payload)) throw new Error(`${id} is not a construction plane`)
  return node.payload as OffsetPlaneDatumPayload
}
const select = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } })
const strip = (): string => screen.getByTestId('console-strip').textContent ?? ''

describe('Construct: Midplane and Plane at angle', () => {
  it('the Construct group has Offset plane, Midplane and At angle', async () => {
    await boot()
    const construct = screen.getByTestId('workbench-rail-section-construct')
    for (const id of ['workbench-offset-plane', 'workbench-midplane', 'workbench-angle-plane']) expect(construct.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
  })

  it('Midplane between XY and an offset plane 20 mm up: halfway, one datum consuming both, and it edits and reloads', async () => {
    await boot()
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '20' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined())

    fireEvent.click(screen.getByTestId('workbench-midplane'))
    expect(screen.getByTestId('dialog-shell').textContent).toContain('Midplane')
    select('offset-plane-source', 'datum:XY')
    // no second plane yet: nothing to make
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    select('construction-plane-second-source', 'datum:RP1')
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP2')).toBeDefined())
    expect([...hooks().dag.getNode('datum:RP2')!.consumes].sort()).toEqual(['datum:RP1', 'datum:XY'])
    expect(payloadOf('datum:RP2').definition).toEqual({ kind: 'midplane', flipNormal: false })
    expect(payloadOf('datum:RP2').lastGoodFrame?.origin.z).toBeCloseTo(10, 9)
    expect(payloadOf('datum:RP2').name).toBe('Midplane RP2')

    // edit the offset plane: the midplane follows it. Offset-plane wording is unchanged.
    fireEvent.click(screen.getByTestId('feature-row-datum:RP1'))
    await waitFor(() => expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    await waitFor(() => expect(strip()).toBe('Edit offset plane: change it in the panel, then Apply.'))
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '30' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(payloadOf('datum:RP2').lastGoodFrame?.origin.z).toBeCloseTo(15, 9))

    // the midplane itself edits in its own dialog (flip), and reloads; its own kind names both the
    // dialog title and the console strip
    fireEvent.click(screen.getByTestId('feature-row-datum:RP2'))
    await waitFor(() => expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    expect(screen.getByTestId('dialog-shell').textContent).toContain('Edit midplane')
    await waitFor(() => expect(strip()).toBe('Edit midplane: change it in the panel, then Apply.'))
    fireEvent.click(screen.getByTestId('offset-plane-flip-normal'))
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(payloadOf('datum:RP2').lastGoodFrame?.normal.z).toBeCloseTo(-1, 9))
    const restored = FeatureDag.restore(hooks().dag.serialize())
    expect([...restored.getNode('datum:RP2')!.consumes].sort()).toEqual(['datum:RP1', 'datum:XY'])
  })

  it('Midplane by two viewport clicks: first then second; XZ and YZ meet on Z, so it halves their right angle', async () => {
    const runtime = await boot()
    fireEvent.click(screen.getByTestId('workbench-midplane'))
    // a ray square to XZ, then one square to YZ, each hitting only that plane
    runtime.rayOverride = { origin: { x: 20, y: -100, z: 20 }, direction: { x: 0, y: 1, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XZ'))
    runtime.rayOverride = { origin: { x: -100, y: 20, z: 20 }, direction: { x: 1, y: 0, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect((screen.getByTestId('construction-plane-second-source') as HTMLSelectElement).value).toBe('datum:YZ'))
    expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XZ')
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined())
    const f = payloadOf('datum:RP1').lastGoodFrame!
    expect(Math.abs(f.normal.x)).toBeCloseTo(Math.SQRT1_2, 9)
    expect(Math.abs(f.normal.y)).toBeCloseTo(Math.SQRT1_2, 9)
    expect(f.normal.z).toBeCloseTo(0, 9)
    // the Z axis lies in it
    expect(f.origin.x * f.normal.x + f.origin.y * f.normal.y).toBeCloseTo(0, 9)
  })

  it('At angle: XY turned 30 deg about its X axis, then edited to 60 deg about Y', async () => {
    await boot()
    fireEvent.click(screen.getByTestId('workbench-angle-plane'))
    expect(screen.getByTestId('dialog-shell').textContent).toContain('Plane at angle')
    expect(screen.queryByTestId('offset-plane-distance')).toBeNull()
    select('offset-plane-source', 'datum:XY')
    fireEvent.change(screen.getByTestId('construction-plane-angle'), { target: { value: '30' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined())
    expect(payloadOf('datum:RP1').definition).toEqual({ kind: 'angle', angleDeg: 30, hinge: 'x', flipNormal: false })
    let f = payloadOf('datum:RP1').lastGoodFrame!
    expect(f.normal.y).toBeCloseTo(-0.5, 9)
    expect(f.normal.z).toBeCloseTo(Math.sqrt(3) / 2, 9)

    fireEvent.click(screen.getByTestId('feature-row-datum:RP1'))
    await waitFor(() => expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    expect((screen.getByTestId('construction-plane-angle') as HTMLInputElement).value).toBe('30')
    await waitFor(() => expect(strip()).toBe('Edit plane at angle: change it in the panel, then Apply.'))
    fireEvent.change(screen.getByTestId('construction-plane-angle'), { target: { value: '60' } })
    select('construction-plane-hinge', 'y')
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(payloadOf('datum:RP1').definition).toMatchObject({ angleDeg: 60, hinge: 'y' }))
    f = payloadOf('datum:RP1').lastGoodFrame!
    expect(f.normal.x).toBeCloseTo(Math.sqrt(3) / 2, 9)
    expect(f.normal.z).toBeCloseTo(0.5, 9)
  })

  it('a model change under a live edit refuses the preview by the plane\'s own kind; offset plane wording is unchanged', async () => {
    await boot()
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '20' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined())

    fireEvent.click(screen.getByTestId('workbench-midplane'))
    select('offset-plane-source', 'datum:XY')
    select('construction-plane-second-source', 'datum:RP1')
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP2')).toBeDefined())

    fireEvent.click(screen.getByTestId('workbench-angle-plane'))
    select('offset-plane-source', 'datum:XY')
    fireEvent.change(screen.getByTestId('construction-plane-angle'), { target: { value: '30' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP3')).toBeDefined())

    let driftId = 0
    const driftAndRefuse = async (featureRowId: string, driftEditedField: () => void, expectedMessage: string): Promise<void> => {
      fireEvent.click(screen.getByTestId(featureRowId))
      await waitFor(() => expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getByTestId('workbench-edit-feature'))
      await waitForApplyEnabled()
      // another actor mutates the document while this edit session is live
      const { input } = buildOffsetPlaneDatumNodeInput({ id: `drift${driftId++}`, parentPlaneNodeId: 'datum:XY', distance: 1 })
      hooks().dag.insertNode(input)
      driftEditedField()
      await waitFor(() => expect(screen.getByTestId('offset-plane-preview-refusal').textContent).toBe(expectedMessage))
      fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    }

    await driftAndRefuse(
      'feature-row-datum:RP1',
      () => fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '25' } }),
      'Offset Plane preview refused: the model changed while previewing.',
    )
    await driftAndRefuse(
      'feature-row-datum:RP2',
      () => fireEvent.click(screen.getByTestId('offset-plane-flip-normal')),
      'Midplane preview refused: the model changed while previewing.',
    )
    await driftAndRefuse(
      'feature-row-datum:RP3',
      () => fireEvent.change(screen.getByTestId('construction-plane-angle'), { target: { value: '45' } }),
      'Plane at angle preview refused: the model changed while previewing.',
    )
  })
})
