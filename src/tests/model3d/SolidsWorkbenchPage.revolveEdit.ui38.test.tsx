// @vitest-environment jsdom
//
// UI-38: integrated Revolve edit reliability evidence. This drives the real
// SolidsWorkbenchPage and in-process OCCT service through the visible edit,
// undo, and redo affordances. Kernel volume and body-handle assertions prove
// each history transition replayed geometry instead of only rewriting payload.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { createLocalGeomService } from '../../geom'
import type { BodyHandle } from '../../geom/geom-service'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
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

async function waitForFreshBody(featureId: string, prior?: BodyHandle): Promise<BodyHandle> {
  let current: BodyHandle | undefined
  await waitFor(() => {
    current = hooks().getBodyHandle(featureId)
    expect(current).not.toBeUndefined()
    if (prior !== undefined) expect(current).not.toBe(prior)
  }, { timeout: 20_000 })
  return current as BodyHandle
}

async function volumeOf(handle: BodyHandle): Promise<number> {
  return (await hooks().client.measure(handle, 'volume')).value
}

describe('UI-38 Revolve edit reliability (real workbench and OCCT kernel)', () => {
  it('edits the same feature, replays geometry through undo/redo, and refuses a missing profile without changing history', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
      { timeout: 20_000 },
    )

    // The XZ rectangle spans radius 10..50 and height 20. Its full revolve
    // volume is exact by Pappus, and a 180deg edit must halve that volume.
    await mintRectangleSketch({ width: '40', height: '20', offset: '10', plane: 'xz' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-revolve'))
    commitField('revolve-angle', '360')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const originalHandle = await waitForFreshBody('F1')
    const originalVolume = await volumeOf(originalHandle)
    const expectedFullVolume = Math.PI * (50 * 50 - 10 * 10) * 20
    expect(Math.abs(originalVolume - expectedFullVolume) / expectedFullVolume).toBeLessThan(1e-6)
    const originalOrder = hooks().dag.featureOrder()
    expect(originalOrder).toEqual(expect.arrayContaining(['SK1', 'F1']))

    // Open the selected EXISTING node through the shared workbench Edit path.
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    expect(screen.getByTestId('dialog-shell').querySelector('.modal-title')?.textContent).toMatch(/edit revolve/i)
    expect((screen.getByTestId('revolve-profile-select') as HTMLSelectElement).value).toBe('SK1')
    expect(screen.getByTestId('revolve-pick-profile')).toBeTruthy()
    expect((screen.getByTestId('revolve-angle').querySelector('input') as HTMLInputElement).value).toBe('360')

    commitField('revolve-angle', '180')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const editedHandle = await waitForFreshBody('F1', originalHandle)
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    expect(hooks().dag.getNode('F1')?.payload).toMatchObject({
      opType: 'revolve',
      sketchId: 'SK1',
      angleDeg: 180,
    })
    expect(hooks().dag.has('F2')).toBe(false)
    const editedVolume = await volumeOf(editedHandle)
    expect(Math.abs(editedVolume - expectedFullVolume / 2) / (expectedFullVolume / 2)).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    const undoneHandle = await waitForFreshBody('F1', editedHandle)
    expect(hooks().dag.getNode('F1')?.payload.angleDeg).toBe(360)
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    expect(Math.abs((await volumeOf(undoneHandle)) - originalVolume) / originalVolume).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-redo'))
    const redoneHandle = await waitForFreshBody('F1', undoneHandle)
    expect(hooks().dag.getNode('F1')?.payload.angleDeg).toBe(180)
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    expect(Math.abs((await volumeOf(redoneHandle)) - editedVolume) / editedVolume).toBeLessThan(1e-6)

    // Simulate a persisted/corrupted feature whose declared profile producer
    // is absent. The regen scheduler and dialog both refuse it by name. Opening
    // the editor and clicking its disabled Apply must not repair, append, or
    // otherwise rewrite the user's DAG/history behind their back.
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'BAD-REVOLVE',
      kind: 'feature',
      consumes: ['SK-MISSING'],
      payload: {
        opType: 'revolve',
        sketchId: 'SK-MISSING',
        angleDeg: 90,
        name: 'Broken revolve',
      },
    }))
    await hooks().fullResync(['BAD-REVOLVE'])
    expect(hooks().scheduler.statusOf('BAD-REVOLVE')).toBe('degraded')
    expect(hooks().scheduler.diagnosticsOf('BAD-REVOLVE')).toContainEqual({
      code: 'UPSTREAM_REMOVED',
      severity: 'warning',
      params: { id: 'BAD-REVOLVE', removedUpstream: 'SK-MISSING' },
    })
    expect(hooks().getBodyHandle('BAD-REVOLVE')).toBeUndefined()

    const brokenBefore = hooks().dag.getNode('BAD-REVOLVE')
    const orderBeforeRefusal = hooks().dag.featureOrder()
    const historyBeforeRefusal = hooks().history.serialize()
    const historySizeBeforeRefusal = hooks().history.size()

    const invalidEntry = hooks().editEntryFor('BAD-REVOLVE')
    if (invalidEntry === undefined || !('onEdit' in invalidEntry)) {
      throw new Error('BAD-REVOLVE must route to its edit dialog')
    }
    invalidEntry.onEdit()
    await waitFor(() => {
      expect(screen.getByTestId('revolve-profile-error').textContent).toMatch(/available upstream sketch profile/i)
    })
    const apply = screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)

    expect(hooks().dag.getNode('BAD-REVOLVE')).toEqual(brokenBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeRefusal)
    expect(hooks().history.size()).toBe(historySizeBeforeRefusal)
    expect(hooks().history.serialize()).toEqual(historyBeforeRefusal)
  }, 90_000)
})
