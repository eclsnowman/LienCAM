// @vitest-environment jsdom
//
// WO-1470 (BUG-397): the four Create toolbar tools (Extrude/Revolve/Sweep/
// Loft) must open their dialogs defaulted to the sketch currently selected in
// the design tree, not the first sketch in the document. They route that
// selection through the dialogs' existing nonce-gated `treeSketchPick`
// channel; a non-sketch selection (or none) must leave the `sketches[0]`
// fallback untouched.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d } from './loadTolerantWaitFor'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

async function mountWithThreeSketches(): Promise<void> {
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={() => createFakeSceneRuntime()} />)
  await waitForLoadedModel3d(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  await mintRectangleSketch({ id: 'SK1', offset: 0 })
  await waitForLoadedModel3d(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  await mintRectangleSketch({ id: 'SK2', offset: 30 })
  await waitForLoadedModel3d(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
  await mintRectangleSketch({ id: 'SK3', offset: 60 })
  await waitForLoadedModel3d(() => expect(screen.getByTestId('feature-row-SK3')).toBeTruthy())
}

describe('WO-1470 command dialogs honor the preselected tree sketch', () => {
  it('Extrude, Revolve, Sweep and Loft open on the selected sketch instead of the first', async () => {
    await mountWithThreeSketches()

    fireEvent.click(screen.getByTestId('feature-row-SK3'))
    expect(screen.getByTestId('feature-row-SK3').getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    await waitForLoadedModel3d(() => expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK3'))

    fireEvent.click(screen.getByTestId('workbench-revolve'))
    await waitForLoadedModel3d(() => expect((screen.getByTestId('revolve-profile-select') as HTMLSelectElement).value).toBe('SK3'))

    fireEvent.click(screen.getByTestId('workbench-sweep'))
    await waitForLoadedModel3d(() => expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK3'))

    fireEvent.click(screen.getByTestId('workbench-loft'))
    await waitForLoadedModel3d(() => expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK3'))
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK2')
  }, 30_000)

  it('a non-sketch tree selection falls back to the first sketch', async () => {
    await mountWithThreeSketches()

    fireEvent.click(screen.getByTestId('feature-row-SK3'))
    fireEvent.click(screen.getByTestId('feature-row-datum:XY'))
    expect(screen.getByTestId('feature-row-datum:XY').getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    await waitForLoadedModel3d(() => expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK1'))
  }, 30_000)

  it('no selection falls back to the first sketch', async () => {
    await mountWithThreeSketches()

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    await waitForLoadedModel3d(() => expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK1'))
  }, 30_000)
})