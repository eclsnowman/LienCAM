// @vitest-environment jsdom
//
// WO UI-7 (BK-40) rider (UI-6 audit note): the workbench Bodies panel +
// export eligibility must exclude effectively-suppressed AND rolled-back
// features' bodies. Driven through the REAL SolidsWorkbenchPage (worker
// faked at the facade boundary), same idiom as SolidsWorkbenchPage.suppress.test.tsx.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
// WO SKC-15: every workbench document is now born with Origin + XY/XZ/YZ at featureOrder() indices
// 0..3 (Operator A2), so the absolute-order assertions below carry that prefix. Insert-at-marker still
// lands features at the marker; markerInsertIndex('start') now resolves BELOW the genesis run.
import { GENESIS_NODE_IDS as G } from '../../doc'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

// WO-123: these page-level tests each boot and mutate a complete workbench.
// Under concurrent slice load that work can exceed Vitest's 5s default even
// though the state transitions and assertions are deterministic.
const LOAD_TOLERANT_TEST_TIMEOUT_MS = 20_000

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

async function buildOneExtrude(client: ReturnType<typeof createFakeGeomClient>): Promise<void> {
  render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
}

describe('SolidsWorkbenchPage bodies panel + export rider (WO UI-7, BK-40)', () => {
  it('a suppressed feature is excluded from the Bodies panel row and the Export STEP eligible pool', async () => {
    const client = createFakeGeomClient()
    await buildOneExtrude(client)

    expect(screen.getByTestId('body-visible-F1')).toBeTruthy()
    expect((screen.getByTestId('workbench-export-step') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId('feature-row-suppress-F1'))
    await waitFor(() => expect(hooks().dag.getNode('F1')!.suppressed).toBe(true))

    expect(screen.queryByTestId('body-visible-F1')).toBeNull()
    expect((screen.getByTestId('workbench-export-step') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId('feature-row-suppress-F1'))
    await waitFor(() => expect(hooks().dag.getNode('F1')!.suppressed).toBe(false))
    expect(screen.getByTestId('body-visible-F1')).toBeTruthy()
  }, LOAD_TOLERANT_TEST_TIMEOUT_MS)

  it('a rolled-back feature is excluded from the Bodies panel row, has its viewport handle disposed, and is excluded from export; moving the marker back restores it (replays the kernel op)', async () => {
    const client = createFakeGeomClient()
    await buildOneExtrude(client)
    // WO-035: the build includes the dialog's live-preview evaluation, so the
    // invariant is counted as a DELTA from here on, not an absolute 1.
    const callsAfterBuild = extrudeCallCount(client, 'F1')

    // Roll back past SK1 -- the only feature after it is F1.
    fireEvent.click(screen.getByTestId('rollback-marker-up'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(true))

    expect(screen.queryByTestId('body-visible-F1')).toBeNull()
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())
    expect((screen.getByTestId('workbench-export-step') as HTMLButtonElement).disabled).toBe(true)
    // Absent, not stale: no re-invocation from the rollback itself.
    expect(extrudeCallCount(client, 'F1')).toBe(callsAfterBuild)
    expect(hooks().scheduler.statusOf('F1')).toBe('rolledBack')

    // Move the marker back down -- F1 is restored and replays.
    fireEvent.click(screen.getByTestId('rollback-marker-down'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(false))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    expect(screen.getByTestId('body-visible-F1')).toBeTruthy()
    expect(extrudeCallCount(client, 'F1')).toBe(callsAfterBuild + 1)
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
  }, LOAD_TOLERANT_TEST_TIMEOUT_MS)

  it('undo/redo of a rollback-marker move round-trips through the workbench', async () => {
    const client = createFakeGeomClient()
    await buildOneExtrude(client)

    fireEvent.click(screen.getByTestId('rollback-marker-up'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(true))

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(false))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(true))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())
  }, LOAD_TOLERANT_TEST_TIMEOUT_MS)
})

describe('SolidsWorkbenchPage toolbar create routes through insert-at-marker (WO UI-7-R1, audit blocker)', () => {
  it('creating a feature from the real toolbar while rolled back lands it AT the marker, not appended past rolled-back features', async () => {
    const client = createFakeGeomClient()
    await buildOneExtrude(client)
    expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'F1'])

    // Roll back past SK1 -- only F1 (the feature after it) is rolled back.
    fireEvent.click(screen.getByTestId('rollback-marker-up'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(true))
    expect(hooks().dag.isRolledBack('SK1')).toBe(false)

    // Create a brand-new sketch from the real toolbar entry while rolled back.
    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())

    // Must land AT the marker (between SK1 and F1), not appended to the end.
    expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'SK2', 'F1'])
    expect(hooks().dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'SK2' })
    expect(hooks().dag.isRolledBack('SK2')).toBe(false)
    expect(hooks().dag.isRolledBack('F1')).toBe(true)
  }, LOAD_TOLERANT_TEST_TIMEOUT_MS)

  it('creating a feature that would consume a rolled-back producer is refused, and the reason surfaces in the dialog (not just thrown)', async () => {
    const client = createFakeGeomClient()
    await buildOneExtrude(client)

    // Roll all the way back -- SK1 itself (and F1) are now rolled back.
    fireEvent.click(screen.getByTestId('rollback-marker-up'))
    await waitFor(() => expect(hooks().dag.isRolledBack('F1')).toBe(true))
    fireEvent.click(screen.getByTestId('rollback-marker-up'))
    await waitFor(() => expect(hooks().dag.isRolledBack('SK1')).toBe(true))

    // The profile dropdown still offers SK1 (sketch options are not filtered
    // by rolled-back status) -- picking it and applying must be refused with
    // a plain reason shown in the dialog, not an uncaught throw.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    // WO-035: Apply now routes through the async preview guard, so the plain
    // refusal surfaces after the guard settles -- same reason, same seam.
    await waitFor(() => expect(screen.getByTestId('extrude-apply-error').textContent).toMatch(/rolled back/i))
    // Dialog stays open (Apply refused, not a silent close) and nothing committed.
    expect(screen.getByTestId('dialog-shell')).toBeTruthy()
    expect(hooks().dag.has('F2')).toBe(false)
    expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'F1'])
  }, LOAD_TOLERANT_TEST_TIMEOUT_MS)
})
