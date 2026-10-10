// @vitest-environment jsdom
//
// WO INT-4A-R1 (R1.3): fullResync used to scheduler.markDirty() EVERY body
// feature after every mutation instead of just the edited node (docs/
// 3d-modeling-plan.md:221 -- "dirty-marking from the edited node downstream
// only"). Drives the real SolidsWorkbenchPage (worker faked at the facade
// boundary) through two INDEPENDENT extrude features and asserts editing one
// does not re-execute the other's kernel op -- the over-regeneration guard
// the audit finding called for. Must FAIL against pre-R1: pre-fix, editing
// F1 also calls makeExtrude again for F2 (and every other body feature).

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

describe('SolidsWorkbenchPage over-regeneration guard (WO INT-4A-R1.3)', () => {
  it('editing one extrude feature does not re-execute an unrelated extrude feature', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    // --- Feature A: sketch -> extrude (F1) ---------------------------------
    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // --- Feature B: a SECOND, unrelated sketch -> extrude (F2) -------------
    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK2' } })
    commitField('extrude-distance', '15')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    // WO-035: the builds include each dialog's live-preview evaluation, so the
    // over-regeneration invariant is counted as a DELTA from here on -- the
    // point under test is that F2's count never grows from an F1 edit,
    // preview or commit.
    const f1AfterBuild = extrudeCallCount(client, 'F1')
    const f2AfterBuild = extrudeCallCount(client, 'F2')

    // --- Edit F1 only -- F2 (unrelated) must NOT re-execute -----------------
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    commitField('extrude-distance', '99')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(hooks().dag.getNode('F1')?.payload.distance).toBe(99))
    await waitFor(() => expect(extrudeCallCount(client, 'F1')).toBeGreaterThan(f1AfterBuild))
    expect(extrudeCallCount(client, 'F2')).toBe(f2AfterBuild)
  })
})
