// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { INTERACTION_ORANGE } from '../../viewport3d'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function buildBox(
  runtime: ReturnType<typeof createFakeSceneRuntime>,
  sketchId: string,
  bodyId: string,
  offset: string,
): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset, id: sketchId })
  await waitFor(() => expect(screen.getByTestId(`feature-row-${sketchId}`)).toBeTruthy())
  await waitFor(() => expect((screen.getByTestId('workbench-extrude') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.click(screen.getByTestId('extrude-pick-profile'))
  runtime.rayOverride = {
    origin: { x: Number(offset) + 20, y: 10, z: 100 },
    direction: { x: 0, y: 0, z: -1 },
  }
  fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'), { clientX: 400, clientY: 300 })
  expect(screen.getByTestId('workbench-profile-hover-readout').textContent).toContain(sketchId)
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'), { clientX: 400, clientY: 300 })
  fireEvent.click(screen.getByTestId('workbench-done-profile-pick'))
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle(bodyId)).not.toBeUndefined(), { timeout: 20_000 })
}

async function forkBodyFeature(sourceId: string, id: string): Promise<void> {
  const source = hooks().dag.getNode(sourceId)
  if (source === undefined) throw new Error(`missing source ${sourceId}`)
  hooks().dag.insertNode({
    id,
    kind: 'feature',
    consumes: [sourceId],
    refs: [],
    payload: { ...source.payload, name: id },
  })
  await hooks().fullResync([id])
  await waitFor(() => expect(hooks().getBodyHandle(id)).not.toBeUndefined(), { timeout: 20_000 })
  await waitFor(() => expect(screen.getByTestId(`feature-row-${id}`)).toBeTruthy())
}

function expectWholeBodySelected(bodyId: string): void {
  expect(hooks().getBodyMaterialSnapshot(bodyId)).toMatchObject({
    color: INTERACTION_ORANGE,
    vertexColors: false,
  })
  expect(hooks().getBodyInteractionSnapshot(bodyId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'body-outline', variant: 'selected' }),
  ]))
}

describe('UI-94 Model viewport and feature-tree body selection', () => {
  it('synchronizes leaf, history, fan-out, multi-body, and command-picker paths without collapsing subshape selection', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await buildBox(runtime, 'SK1', 'F1', '10')
    await buildBox(runtime, 'SK2', 'F2', '100')

    // Tree -> viewport: selecting a current body is a whole-solid selection,
    // not a stale subshape lock.
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    await waitFor(() => expectWholeBodySelected('F1'))
    expect(screen.getByTestId('body-row-F1').getAttribute('aria-selected')).toBe('true')
    expect(hooks().bridgeSession?.selection.selection.size).toBe(0)

    // Viewport -> tree in a multi-body scene: the nearest rendered body owns
    // the tree/body row, while its picked face remains a distinct subshape.
    runtime.rayOverride = { origin: { x: 120, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-F2').getAttribute('aria-selected')).toBe('true'))
    await waitFor(() => expectWholeBodySelected('F2'))
    expect(hooks().bridgeSession?.selection.selection.size).toBe(1)
    expect(hooks().getBodyInteractionSnapshot('F2')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'face-fill', variant: 'selected' }),
      expect.objectContaining({ kind: 'body-outline', variant: 'selected' }),
    ]))

    // A command picker owns the canvas. It suppresses ordinary body tint while
    // armed, does not reroute its click into body selection, and restores the
    // same selected owner after the command pick completes.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    await waitFor(() => {
      expect(hooks().getBodyInteractionSnapshot('F2').some((entry) => entry.kind === 'body-outline')).toBe(false)
    })
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    expect(screen.getByTestId('feature-row-F2').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('solids-workbench-profile-pick-hint')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('solids-workbench-profile-pick-hint')).toBeNull()
    await waitFor(() => expectWholeBodySelected('F2'))
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    // A consumed history row keeps its authored selection/edit identity while
    // its sole live owner carries the body-row and viewport presentation.
    await forkBodyFeature('F1', 'F3')
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    await waitFor(() => expect(screen.getByTestId('feature-row-F1').getAttribute('aria-selected')).toBe('true'))
    expect(screen.getByTestId('feature-row-F3').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('body-row-F3').getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expectWholeBodySelected('F3'))

    // Fan-out has no honest single owner. The tree selection and presentation
    // clear rather than guessing between two live descendants.
    await forkBodyFeature('F1', 'F4')
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    await waitFor(() => {
      expect(screen.getByTestId('feature-row-F3').getAttribute('aria-selected')).toBe('false')
      expect(screen.getByTestId('feature-row-F4').getAttribute('aria-selected')).toBe('false')
    })
    await waitFor(() => {
      expect(hooks().getBodyInteractionSnapshot('F3')).toEqual([])
      expect(hooks().getBodyInteractionSnapshot('F4')).toEqual([])
    })
  }, 60_000)
})
