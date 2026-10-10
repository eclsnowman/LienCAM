// @vitest-environment jsdom
//
// UI-38: integrated Sweep/Loft edit reliability evidence. These tests drive
// the real SolidsWorkbenchPage and in-process OCCT service through visible
// edit, undo, and redo affordances. Fresh body handles and measured volumes
// prove that each history transition replays geometry, not only dialog state.

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

async function waitForReady(): Promise<void> {
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
    { timeout: 20_000 },
  )
}

function openEdit(featureId: string): void {
  fireEvent.click(screen.getByTestId(`feature-row-${featureId}`))
  fireEvent.click(screen.getByTestId('workbench-edit-feature'))
}

function openInvalidEdit(featureId: string): void {
  const entry = hooks().editEntryFor(featureId)
  if (entry === undefined || !('onEdit' in entry)) {
    throw new Error(`${featureId} must route to its edit dialog`)
  }
  entry.onEdit()
}

describe('UI-38 Sweep/Loft edit reliability (real workbench and OCCT kernel)', () => {
  it('Sweep edits the same node, replays geometry through undo/redo, and blocks a missing profile without history mutation', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    await mintRectangleSketch({ width: '10', height: '10', offset: '5', id: 'SK1' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-sweep'))
    fireEvent.change(screen.getByTestId('sweep-profile-select'), { target: { value: 'SK1' } })
    fireEvent.change(screen.getByTestId('sweep-path-axis-select'), { target: { value: 'z' } })
    commitField('sweep-length', '30')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const originalHandle = await waitForFreshBody('F1')
    const originalVolume = await volumeOf(originalHandle)
    expect(Math.abs(originalVolume - 3000) / 3000).toBeLessThan(1e-6)
    const originalOrder = hooks().dag.featureOrder()

    openEdit('F1')
    expect(screen.getByTestId('dialog-shell').querySelector('.modal-title')?.textContent).toMatch(/edit sweep/i)
    expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK1')
    expect((screen.getByTestId('sweep-path-axis-select') as HTMLSelectElement).value).toBe('z')
    expect((screen.getByTestId('sweep-length').querySelector('input') as HTMLInputElement).value).toBe('30')
    expect((screen.getByTestId('sweep-orientation-select') as HTMLSelectElement).value).toBe('fixed')

    commitField('sweep-length', '45')
    fireEvent.change(screen.getByTestId('sweep-orientation-select'), { target: { value: 'frenet' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const editedHandle = await waitForFreshBody('F1', originalHandle)
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    expect(hooks().dag.getNode('F1')?.payload).toMatchObject({
      opType: 'sweep',
      sketchId: 'SK1',
      axis: 'z',
      length: 45,
      orientation: 'frenet',
    })
    expect(hooks().dag.has('F2')).toBe(false)
    const editedVolume = await volumeOf(editedHandle)
    expect(Math.abs(editedVolume - 4500) / 4500).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    const undoneHandle = await waitForFreshBody('F1', editedHandle)
    expect(hooks().dag.getNode('F1')?.payload).toMatchObject({ length: 30, orientation: 'fixed' })
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    expect(Math.abs((await volumeOf(undoneHandle)) - originalVolume) / originalVolume).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-redo'))
    const redoneHandle = await waitForFreshBody('F1', undoneHandle)
    expect(hooks().dag.getNode('F1')?.payload).toMatchObject({ length: 45, orientation: 'frenet' })
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    expect(Math.abs((await volumeOf(redoneHandle)) - editedVolume) / editedVolume).toBeLessThan(1e-6)

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'BAD-SWEEP',
      kind: 'feature',
      consumes: ['SK-MISSING'],
      payload: {
        opType: 'sweep',
        sketchId: 'SK-MISSING',
        axis: 'z',
        length: 30,
        orientation: 'fixed',
        name: 'Broken sweep',
      },
    }))
    await hooks().fullResync(['BAD-SWEEP'])
    expect(hooks().scheduler.statusOf('BAD-SWEEP')).toBe('degraded')
    expect(hooks().scheduler.diagnosticsOf('BAD-SWEEP')).toContainEqual({
      code: 'UPSTREAM_REMOVED',
      severity: 'warning',
      params: { id: 'BAD-SWEEP', removedUpstream: 'SK-MISSING' },
    })
    expect(hooks().getBodyHandle('BAD-SWEEP')).toBeUndefined()

    const brokenBefore = hooks().dag.getNode('BAD-SWEEP')
    const orderBeforeRefusal = hooks().dag.featureOrder()
    const historyBeforeRefusal = hooks().history.serialize()
    const historySizeBeforeRefusal = hooks().history.size()

    openInvalidEdit('BAD-SWEEP')
    await waitFor(() => {
      expect(screen.getByTestId('sweep-profile-error').textContent).toMatch(/available upstream sketch profile/i)
    })
    expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK-MISSING')
    const apply = screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)

    expect(hooks().dag.getNode('BAD-SWEEP')).toEqual(brokenBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeRefusal)
    expect(hooks().history.size()).toBe(historySizeBeforeRefusal)
    expect(hooks().history.serialize()).toEqual(historyBeforeRefusal)
  }, 90_000)

  it('Loft edits the same node, replays geometry through undo/redo, and blocks a missing section without history mutation', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    await mintRectangleSketch({ width: '20', height: '10', offset: '0', id: 'SK1' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    await mintRectangleSketch({ width: '10', height: '6', offset: '0', id: 'SK2' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-loft'))
    fireEvent.change(screen.getByTestId('loft-section1-select'), { target: { value: 'SK1' } })
    fireEvent.change(screen.getByTestId('loft-section2-select'), { target: { value: 'SK2' } })
    commitField('loft-spacing', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const originalHandle = await waitForFreshBody('F1')
    const originalVolume = await volumeOf(originalHandle)
    const expectedOriginalVolume = (12 / 6) * (200 + 4 * 120 + 60)
    expect(Math.abs(originalVolume - expectedOriginalVolume) / expectedOriginalVolume).toBeLessThan(1e-6)
    const originalOrder = hooks().dag.featureOrder()

    openEdit('F1')
    expect(screen.getByTestId('dialog-shell').querySelector('.modal-title')?.textContent).toMatch(/edit loft/i)
    expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK1')
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK2')
    expect((screen.getByTestId('loft-spacing').querySelector('input') as HTMLInputElement).value).toBe('12')
    expect((screen.getByTestId('loft-ruled-checkbox') as HTMLInputElement).checked).toBe(true)

    commitField('loft-spacing', '24')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const editedHandle = await waitForFreshBody('F1', originalHandle)
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    expect(hooks().dag.getNode('F1')?.payload).toMatchObject({
      opType: 'loft',
      sectionIds: ['SK1', 'SK2'],
      spacing: 24,
      ruled: true,
    })
    expect(hooks().dag.has('F2')).toBe(false)
    const editedVolume = await volumeOf(editedHandle)
    expect(Math.abs(editedVolume - expectedOriginalVolume * 2) / (expectedOriginalVolume * 2)).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    const undoneHandle = await waitForFreshBody('F1', editedHandle)
    expect(hooks().dag.getNode('F1')?.payload).toMatchObject({ spacing: 12, ruled: true })
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    expect(Math.abs((await volumeOf(undoneHandle)) - originalVolume) / originalVolume).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-redo'))
    const redoneHandle = await waitForFreshBody('F1', undoneHandle)
    expect(hooks().dag.getNode('F1')?.payload).toMatchObject({ spacing: 24, ruled: true })
    expect(hooks().dag.featureOrder()).toEqual(originalOrder)
    expect(Math.abs((await volumeOf(redoneHandle)) - editedVolume) / editedVolume).toBeLessThan(1e-6)

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'BAD-LOFT',
      kind: 'feature',
      consumes: ['SK1', 'SK-MISSING'],
      payload: {
        opType: 'loft',
        sectionIds: ['SK1', 'SK-MISSING'],
        spacing: 12,
        ruled: true,
        name: 'Broken loft',
      },
    }))
    await hooks().fullResync(['BAD-LOFT'])
    expect(hooks().scheduler.statusOf('BAD-LOFT')).toBe('degraded')
    expect(hooks().scheduler.diagnosticsOf('BAD-LOFT')).toContainEqual({
      code: 'UPSTREAM_REMOVED',
      severity: 'warning',
      params: { id: 'BAD-LOFT', removedUpstream: 'SK-MISSING' },
    })
    expect(hooks().getBodyHandle('BAD-LOFT')).toBeUndefined()

    const brokenBefore = hooks().dag.getNode('BAD-LOFT')
    const orderBeforeRefusal = hooks().dag.featureOrder()
    const historyBeforeRefusal = hooks().history.serialize()
    const historySizeBeforeRefusal = hooks().history.size()

    openInvalidEdit('BAD-LOFT')
    await waitFor(() => {
      expect(screen.getByTestId('loft-sections-error').textContent).toMatch(/two available upstream sketch sections/i)
    })
    expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK1')
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK-MISSING')
    const apply = screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)

    expect(hooks().dag.getNode('BAD-LOFT')).toEqual(brokenBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeRefusal)
    expect(hooks().history.size()).toBe(historySizeBeforeRefusal)
    expect(hooks().history.serialize()).toEqual(historyBeforeRefusal)
  }, 90_000)
})
