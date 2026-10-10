// @vitest-environment jsdom
//
// WO UI-6 (BK-39) mission #5 ("honest interactions") + acceptance #1, driven
// through the REAL SolidsWorkbenchPage (worker faked at the facade boundary,
// same idiom as SolidsWorkbenchPage.regenGuard.test.tsx): suppressing a
// feature that a live viewport body depends on removes that body from
// display (absent, not stale) and stops the kernel op from re-running;
// unsuppressing replays it and repaints.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function extrudeCallCount(client: ReturnType<typeof createFakeGeomClient>, featureId: string): number {
  return client.opCalls.filter((c) => c.op === 'makeExtrude' && c.featureId === featureId).length
}

describe('SolidsWorkbenchPage suppress/unsuppress (WO UI-6, BK-39)', () => {
  it('suppressing a body feature disposes its viewport body and skips its kernel op on regen; unsuppressing replays and repaints', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    // WO-035: the build includes the dialog's live-preview evaluation, so the
    // invariant is counted as a DELTA from here on, not an absolute 1.
    const callsAfterBuild = extrudeCallCount(client, 'F1')

    // Suppress F1 through the tree row toggle -- the SAME command surface
    // (SetSuppressedCommand) mission #3 requires.
    fireEvent.click(screen.getByTestId('feature-row-suppress-F1'))
    await waitFor(() => expect(hooks().dag.getNode('F1')!.suppressed).toBe(true))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())

    // Absent, not stale: the kernel op was never re-invoked for the suppress
    // itself (only the ORIGINAL build call counts).
    expect(extrudeCallCount(client, 'F1')).toBe(callsAfterBuild)
    expect(hooks().scheduler.statusOf('F1')).toBe('suppressed')
    expect(screen.getByTestId('feature-row-F1').dataset.suppressed).toBe('root')

    // Unsuppress -- regen replays the kernel op and the body reappears.
    fireEvent.click(screen.getByTestId('feature-row-suppress-F1'))
    await waitFor(() => expect(hooks().dag.getNode('F1')!.suppressed).toBe(false))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    expect(extrudeCallCount(client, 'F1')).toBe(callsAfterBuild + 1)
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
    expect(screen.getByTestId('feature-row-F1').dataset.suppressed).toBe('none')
  })

  it('undo/redo of a suppress toggle round-trips through the workbench (command surface, mission #3)', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    fireEvent.click(screen.getByTestId('feature-row-suppress-F1'))
    await waitFor(() => expect(hooks().dag.getNode('F1')!.suppressed).toBe(true))

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F1')!.suppressed).toBe(false))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode('F1')!.suppressed).toBe(true))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())
  })
})
