// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { currentBodyOwnerForRenderedHit } from '../../components/model3d/SolidsWorkbenchPage'
import { FeatureDag } from '../../doc'
import { createLocalGeomService } from '../../geom'
import { SELECTION_ORANGE_SELECTED } from '../../lib/viewport/lighting/selectionGlowTokens'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

async function buildBox(sketchId: string, bodyId: string, offset: string): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset, id: sketchId })
  await waitFor(() => expect(screen.getByTestId(`feature-row-${sketchId}`)).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sketchId } })
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle(bodyId)).not.toBeUndefined(), { timeout: 20_000 })
}

function addBodyFeature(dag: FeatureDag, id: string, consumes: string[] = []): void {
  dag.insertNode({ id, kind: 'feature', consumes, payload: { opType: 'extrude', name: id } })
}

describe('UI-68/UI-69 ordinary viewport body selection', () => {
  it('syncs the owning live feature row, tree actions, Bodies, and Mass Properties without selecting hidden geometry', async () => {
    const historyDag = new FeatureDag()
    addBodyFeature(historyDag, 'F1')
    addBodyFeature(historyDag, 'F2', ['F1'])
    addBodyFeature(historyDag, 'F3', ['F2'])

    // A rendered retained-history mesh must select the current body row, not
    // the stale mesh id. Fan-out has no unique current owner, so it clears.
    expect(currentBodyOwnerForRenderedHit(historyDag, 'F1', ['F3'])).toBe('F3')
    expect(currentBodyOwnerForRenderedHit(historyDag, 'F2', ['F3'])).toBe('F3')
    expect(currentBodyOwnerForRenderedHit(historyDag, 'F3', ['F3'])).toBe('F3')
    expect(currentBodyOwnerForRenderedHit(historyDag, 'F1', ['F2', 'F3'])).toBeNull()

    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await buildBox('SK1', 'F1', '10')
    await buildBox('SK2', 'F2', '100')

    const canvas = screen.getByTestId('solids-workbench-canvas')
    const massBodySelect = screen.getByTestId('mass-body-select') as HTMLSelectElement

    // Start with an explicit dropdown override so the viewport click must
    // replace it rather than merely agreeing with the current fallback.
    fireEvent.change(massBodySelect, { target: { value: 'F2' } })
    expect(massBodySelect.value).toBe('F2')

    runtime.rayOverride = { origin: { x: 20, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(canvas)

    await waitFor(() => expect(massBodySelect.value).toBe('F1'))
    await waitFor(() => expect(hooks().bridgeSession?.selection.selection.size).toBe(1))
    const selectedFaceId = [...hooks().bridgeSession!.selection.selection][0]
    const controlFaceId = hooks().getBodyFaceIds('F1')?.find((id) => id !== selectedFaceId)
    expect(controlFaceId).not.toBeUndefined()
    // WO-270: this used to assert the legacy INTERACTION_ORANGE fill first,
    // then flip the Settings > Display glow selector live and assert the
    // selection re-painted. That selector is gone and the glow is frozen at
    // the shipped 'signature' pair, so the selected face paints
    // SELECTION_ORANGE_SELECTED from the first paint. The palette-sensitivity
    // half of the test went with the setting that made it possible.
    await waitFor(() => {
      expect(hooks().getBodyFaceColorSample('F1', selectedFaceId))
        .toEqual(hooks().getBodyFaceColorSample('F1', controlFaceId!))
      expect(hooks().getBodyInteractionSnapshot('F1')).toContainEqual({
        kind: 'face-fill',
        variant: 'selected',
        color: SELECTION_ORANGE_SELECTED,
        depthTest: true,
        clippingPlaneCount: 0,
      })
    })
    expect(screen.getByTestId('feature-row-F1').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('feature-row-F2').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('body-row-F1').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('body-row-F2').getAttribute('aria-selected')).toBe('false')
    expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(false)

    // Tree-originated selection writes the same selectedId in the other
    // direction, so Bodies and Mass Properties follow it too.
    fireEvent.click(screen.getByTestId('feature-row-F2'))
    await waitFor(() => expect(massBodySelect.value).toBe('F2'))
    expect(screen.getByTestId('feature-row-F2').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('body-row-F2').getAttribute('aria-selected')).toBe('true')

    // A hidden body's cached tessellation is not a spatial candidate. Clicking
    // where F1 used to be is therefore the same ordinary miss as empty space:
    // tree/body selection clears, while Mass Properties preserves its
    // established first-body fallback.
    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))
    runtime.rayOverride = { origin: { x: 20, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(canvas)

    await waitFor(() => expect(massBodySelect.value).toBe('F1'))
    await waitFor(() => expect(hooks().bridgeSession?.selection.selection.size).toBe(0))
    await waitFor(() => expect(hooks().getBodyInteractionSnapshot('F1')).toEqual([]))
    expect(screen.getByTestId('feature-row-F1').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('feature-row-F2').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('body-row-F1').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('body-row-F2').getAttribute('aria-selected')).toBe('false')
  }, 60_000)
})
