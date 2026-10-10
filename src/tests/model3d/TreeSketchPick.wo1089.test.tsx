// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ExtrudeDialog,
  RevolveDialog,
} from '../../components/model3d/dialogs'
import type { ExtrudePreviewIntent } from '../../components/model3d/dialogs/ExtrudeDialog'
import { LoftDialog } from '../../components/model3d/dialogs/LoftDialog'
import type { RevolvePreviewIntent } from '../../components/model3d/dialogs/RevolveDialog'
import { SweepDialog } from '../../components/model3d/dialogs/SweepDialog'
import { SolidsWorkbenchPage } from '../../components/model3d'
import type { ProfilePickRequest, StartProfilePick } from '../../components/model3d/workbench/profileRegionPicker'
import { CommandHistory, FeatureDag } from '../../doc'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d } from './loadTolerantWaitFor'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sketchOptions = [
  { id: 'SK1', label: 'Sketch A' },
  { id: 'SK2', label: 'Sketch B' },
  { id: 'SK3', label: 'Sketch C' },
]

function setupDialogs(): { dag: FeatureDag; history: CommandHistory } {
  const dag = new FeatureDag()
  for (const option of sketchOptions) {
    dag.insertNode({ id: option.id, kind: 'sketch', payload: { name: option.label } })
  }
  return { dag, history: new CommandHistory(dag) }
}

function setupEditDialog(
  payload: Record<string, unknown>,
  consumes: string[],
): { dag: FeatureDag; history: CommandHistory } {
  const dag = new FeatureDag()
  for (const option of sketchOptions.slice(0, 2)) {
    dag.insertNode({ id: option.id, kind: 'sketch', payload: { name: option.label } })
  }
  dag.insertNode({ id: 'F1', kind: 'feature', consumes, payload })
  dag.insertNode({ id: 'SK3', kind: 'sketch', payload: { name: 'Sketch C' } })
  return { dag, history: new CommandHistory(dag) }
}

function profileRequestCapture(): {
  start: StartProfilePick
  request(): ProfilePickRequest
} {
  let captured: ProfilePickRequest | undefined
  return {
    start: (request) => { captured = request },
    request: () => {
      if (captured === undefined) throw new Error('profile picker request was not captured')
      return captured
    },
  }
}

const regionC = { kind: 'region' as const, signature: ['c-edge-1', 'c-edge-2'] }

describe('WO-1089 dialog tree sketch picks', () => {
  it('Extrude: tree picks become whole-sketch previews and later dropdown/viewport/tree picks each win', async () => {
    const { dag, history } = setupDialogs()
    const picker = profileRequestCapture()
    const previews: Array<ExtrudePreviewIntent | null> = []
    const baseProps = {
      dag,
      history,
      mode: 'create' as const,
      sketchOptions,
      onStartProfilePick: picker.start,
      onPreviewIntent: (intent: ExtrudePreviewIntent | null) => { previews.push(intent) },
      onApplied: () => {},
      onClose: () => {},
    }
    const view = render(<ExtrudeDialog {...baseProps} />)

    view.rerender(<ExtrudeDialog {...baseProps} treeSketchPick={{ sketchId: 'SK2', nonce: 1 }} />)
    await waitFor(() => expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK2'))
    expect(screen.getByTestId('extrude-tree-sketch-status').textContent).toContain('Sketch B (from the design tree) - whole sketch')
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK2', profileSelector: { kind: 'whole-sketch' } }))

    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK3' } })
    expect(screen.queryByTestId('extrude-tree-sketch-status')).toBeNull()
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK3', profileSelector: { kind: 'whole-sketch' } }))

    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    act(() => { picker.request().onDone([{ sketchId: 'SK3', profileSelector: regionC }]) })
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK3', profileSelector: regionC }))

    view.rerender(<ExtrudeDialog {...baseProps} treeSketchPick={{ sketchId: 'SK1', nonce: 2 }} />)
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: { kind: 'whole-sketch' } }))
    expect(screen.getByTestId('extrude-tree-sketch-status').textContent).toContain('Sketch A')
  })

  it('Revolve: tree picks become whole-sketch previews and later dropdown/viewport/tree picks each win', async () => {
    const { dag, history } = setupDialogs()
    const picker = profileRequestCapture()
    const previews: Array<RevolvePreviewIntent | null> = []
    const baseProps = {
      dag,
      history,
      mode: 'create' as const,
      sketchOptions,
      onStartProfilePick: picker.start,
      onPreviewIntent: (intent: RevolvePreviewIntent | null) => { previews.push(intent) },
      onApplied: () => {},
      onClose: () => {},
    }
    const view = render(<RevolveDialog {...baseProps} />)

    view.rerender(<RevolveDialog {...baseProps} treeSketchPick={{ sketchId: 'SK2', nonce: 1 }} />)
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK2', profileSelector: { kind: 'whole-sketch' } }))
    expect(screen.getByTestId('revolve-tree-sketch-status').textContent).toContain('Sketch B')

    fireEvent.change(screen.getByTestId('revolve-profile-select'), { target: { value: 'SK3' } })
    expect(screen.queryByTestId('revolve-tree-sketch-status')).toBeNull()
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK3', profileSelector: { kind: 'whole-sketch' } }))

    fireEvent.click(screen.getByTestId('revolve-pick-profile'))
    act(() => { picker.request().onDone([{ sketchId: 'SK3', profileSelector: regionC }]) })
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK3', profileSelector: regionC }))

    view.rerender(<RevolveDialog {...baseProps} treeSketchPick={{ sketchId: 'SK1', nonce: 2 }} />)
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: { kind: 'whole-sketch' } }))
  })

  it('Sweep: tree, dropdown, viewport, and a later tree pick all update the one sketch field', async () => {
    const { dag, history } = setupDialogs()
    const picker = profileRequestCapture()
    const baseProps = {
      dag,
      history,
      sketchOptions,
      onStartProfilePick: picker.start,
      onApplied: () => {},
      onClose: () => {},
    }
    const view = render(<SweepDialog {...baseProps} />)

    view.rerender(<SweepDialog {...baseProps} treeSketchPick={{ sketchId: 'SK2', nonce: 1 }} />)
    await waitFor(() => expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK2'))
    expect(screen.getByTestId('sweep-tree-sketch-status').textContent).toContain('Sketch B')

    fireEvent.change(screen.getByTestId('sweep-profile-select'), { target: { value: 'SK3' } })
    expect(screen.queryByTestId('sweep-tree-sketch-status')).toBeNull()

    fireEvent.click(screen.getByTestId('sweep-pick-profile'))
    act(() => { picker.request().onDone([{ sketchId: 'SK3', profileSelector: regionC }]) })
    await waitFor(() => expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK3'))

    view.rerender(<SweepDialog {...baseProps} treeSketchPick={{ sketchId: 'SK1', nonce: 2 }} />)
    await waitFor(() => expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK1'))
    expect(screen.getByTestId('sweep-tree-sketch-status').textContent).toContain('Sketch A')
  })

  it('Loft: a tree pick replaces the first section while preserving the second, then later selection methods win', async () => {
    const { dag, history } = setupDialogs()
    const picker = profileRequestCapture()
    const baseProps = {
      dag,
      history,
      sketchOptions,
      onStartProfilePick: picker.start,
      onApplied: () => {},
      onClose: () => {},
    }
    const view = render(<LoftDialog {...baseProps} />)

    view.rerender(<LoftDialog {...baseProps} treeSketchPick={{ sketchId: 'SK3', nonce: 1 }} />)
    await waitFor(() => expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK3'))
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK2')
    expect(screen.getByTestId('loft-tree-sketch-status').textContent).toContain('Sketch C')

    fireEvent.change(screen.getByTestId('loft-section1-select'), { target: { value: 'SK1' } })
    expect(screen.queryByTestId('loft-tree-sketch-status')).toBeNull()

    fireEvent.click(screen.getByTestId('loft-pick-profiles'))
    act(() => {
      picker.request().onDone([
        { sketchId: 'SK3', profileSelector: regionC },
        { sketchId: 'SK1', profileSelector: { kind: 'whole-sketch' } },
      ])
    })
    await waitFor(() => expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK3'))
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK1')

    view.rerender(<LoftDialog {...baseProps} treeSketchPick={{ sketchId: 'SK2', nonce: 2 }} />)
    await waitFor(() => expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK2'))
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK1')
  })

  it('Extrude edit ignores a downstream tree sketch without losing its saved region or preview', async () => {
    const { dag, history } = setupEditDialog(
      { opType: 'extrude', sketchId: 'SK1', profileSelector: regionC, distance: 10, name: 'Extrude F1' },
      ['SK1'],
    )
    const previews: Array<ExtrudePreviewIntent | null> = []
    const consumed: number[] = []
    const treeSketchPick = { sketchId: 'SK3', nonce: 1 }
    const baseProps = {
      dag,
      history,
      mode: 'edit' as const,
      featureId: 'F1',
      sketchOptions,
      onTreePickConsumed: (nonce: number) => { consumed.push(nonce) },
      onPreviewIntent: (intent: ExtrudePreviewIntent | null) => { previews.push(intent) },
      onApplied: () => {},
      onClose: () => {},
    }
    const view = render(<ExtrudeDialog {...baseProps} />)
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: regionC }))

    view.rerender(<ExtrudeDialog {...baseProps} treeSketchPick={treeSketchPick} />)

    await waitFor(() => expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK1'))
    expect(consumed).toEqual([1])
    expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: regionC })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('extrude-tree-sketch-status')).toBeNull()

    dag.reorderNode('SK3', dag.featureOrder().indexOf('F1'))
    view.rerender(<ExtrudeDialog {...baseProps} treeSketchPick={treeSketchPick} />)
    expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK1')
    expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: regionC })
    expect(consumed).toEqual([1])
  })

  it('Extrude drops a tree pick during a profile-pick session and never replays it after cancel or reopen', async () => {
    const { dag, history } = setupEditDialog(
      { opType: 'extrude', sketchId: 'SK1', profileSelector: regionC, distance: 10, name: 'Extrude F1' },
      ['SK1'],
    )
    const picker = profileRequestCapture()
    const previews: Array<ExtrudePreviewIntent | null> = []
    const consumed: number[] = []
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const baseProps = {
      dag,
      history,
      mode: 'edit' as const,
      featureId: 'F1',
      sketchOptions,
      onStartProfilePick: picker.start,
      onTreePickConsumed: (nonce: number) => { consumed.push(nonce) },
      onPreviewIntent: (intent: ExtrudePreviewIntent | null) => { previews.push(intent) },
      onApplied: () => {},
      onClose: () => {},
    }
    const view = render(<ExtrudeDialog {...baseProps} />)
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: regionC }))

    fireEvent.click(screen.getByTestId('extrude-pick-profile'))
    view.rerender(<ExtrudeDialog {...baseProps} treeSketchPick={{ sketchId: 'SK2', nonce: 7 }} />)

    await waitFor(() => expect(consumed).toEqual([7]))
    expect(info).toHaveBeenCalledWith('Tree pick ignored: profile pick session is active')
    expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK1')
    expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: regionC })

    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK1')
    expect(consumed).toEqual([7])

    view.unmount()
    render(<ExtrudeDialog {...baseProps} />)
    await waitFor(() => expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK1'))
    expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: regionC })
    expect(screen.queryByTestId('extrude-tree-sketch-status')).toBeNull()
  })

  it('Revolve edit ignores a downstream tree sketch without losing its saved region or preview', async () => {
    const { dag, history } = setupEditDialog(
      { opType: 'revolve', sketchId: 'SK1', profileSelector: regionC, angleDeg: 270, name: 'Revolve F1' },
      ['SK1'],
    )
    const previews: Array<RevolvePreviewIntent | null> = []
    const baseProps = {
      dag,
      history,
      mode: 'edit' as const,
      featureId: 'F1',
      sketchOptions,
      onPreviewIntent: (intent: RevolvePreviewIntent | null) => { previews.push(intent) },
      onApplied: () => {},
      onClose: () => {},
    }
    const view = render(<RevolveDialog {...baseProps} />)
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: regionC }))

    view.rerender(<RevolveDialog {...baseProps} treeSketchPick={{ sketchId: 'SK3', nonce: 1 }} />)

    await waitFor(() => expect((screen.getByTestId('revolve-profile-select') as HTMLSelectElement).value).toBe('SK1'))
    expect(previews.at(-1)).toMatchObject({ sketchId: 'SK1', profileSelector: regionC })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('revolve-tree-sketch-status')).toBeNull()
  })

  it('Sweep edit ignores a downstream tree sketch and keeps the dialog valid', async () => {
    const { dag, history } = setupEditDialog(
      { opType: 'sweep', sketchId: 'SK1', axis: 'z', length: 10, orientation: 'fixed', name: 'Sweep F1' },
      ['SK1'],
    )
    const baseProps = {
      dag,
      history,
      mode: 'edit' as const,
      featureId: 'F1',
      sketchOptions,
      onApplied: () => {},
      onClose: () => {},
    }
    const view = render(<SweepDialog {...baseProps} />)

    view.rerender(<SweepDialog {...baseProps} treeSketchPick={{ sketchId: 'SK3', nonce: 1 }} />)

    await waitFor(() => expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK1'))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('sweep-tree-sketch-status')).toBeNull()
  })

  it('Loft edit ignores a downstream tree sketch and preserves both sections', async () => {
    const { dag, history } = setupEditDialog(
      { opType: 'loft', sectionIds: ['SK1', 'SK2'], spacing: 12, ruled: true, name: 'Loft F1' },
      ['SK1', 'SK2'],
    )
    const baseProps = {
      dag,
      history,
      mode: 'edit' as const,
      featureId: 'F1',
      sketchOptions,
      onApplied: () => {},
      onClose: () => {},
    }
    const view = render(<LoftDialog {...baseProps} />)

    view.rerender(<LoftDialog {...baseProps} treeSketchPick={{ sketchId: 'SK3', nonce: 1 }} />)

    await waitFor(() => expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK1'))
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK2')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('loft-tree-sketch-status')).toBeNull()
  })
})

describe('WO-1089 SolidsWorkbenchPage tree delivery', () => {
  it('does not retain no-dialog picks, forwards in-dialog sketches to all four dialogs, and preserves ordinary tree selection', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await waitForLoadedModel3d(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await mintRectangleSketch({ id: 'SK1', offset: 0 })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    await mintRectangleSketch({ id: 'SK2', offset: 30 })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    await mintRectangleSketch({ id: 'SK3', offset: 60 })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK3')).toBeTruthy())

    fireEvent.click(screen.getByTestId('feature-row-SK3'))
    expect(screen.getByTestId('feature-row-SK3').getAttribute('aria-selected')).toBe('true')

    // WO-1470: opening a Create tool now honors the tree selection, so the
    // dialog opens on SK3 (the selected sketch) instead of the first sketch.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK3')
    fireEvent.click(screen.getByTestId('feature-row-SK2'))
    await waitFor(() => expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK2'))
    expect(screen.getByTestId('extrude-tree-sketch-status')).toBeTruthy()

    fireEvent.click(screen.getByTestId('feature-row-datum:XY'))
    expect(screen.getByTestId('feature-row-datum:XY').getAttribute('aria-selected')).toBe('true')
    expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK2')

    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK1' } })
    expect(screen.queryByTestId('extrude-tree-sketch-status')).toBeNull()
    fireEvent.click(screen.getByTestId('feature-row-SK1'))
    await waitFor(() => expect(screen.getByTestId('extrude-tree-sketch-status')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-revolve'))
    fireEvent.click(screen.getByTestId('feature-row-SK2'))
    await waitFor(() => expect((screen.getByTestId('revolve-profile-select') as HTMLSelectElement).value).toBe('SK2'))

    fireEvent.click(screen.getByTestId('workbench-sweep'))
    fireEvent.click(screen.getByTestId('feature-row-SK3'))
    await waitFor(() => expect((screen.getByTestId('sweep-profile-select') as HTMLSelectElement).value).toBe('SK3'))

    fireEvent.click(screen.getByTestId('workbench-loft'))
    fireEvent.click(screen.getByTestId('feature-row-SK3'))
    await waitFor(() => expect((screen.getByTestId('loft-section1-select') as HTMLSelectElement).value).toBe('SK3'))
    expect((screen.getByTestId('loft-section2-select') as HTMLSelectElement).value).toBe('SK2')
  }, 30_000)
})
