// @vitest-environment jsdom
//
// WO UI-9 (BK-41): drag-reorder a feature row in the Design Tree, driven at
// the REAL tree UI boundary -- render SolidsWorkbenchPage, drag via the real
// FeatureTree handlers (worker faked at the facade boundary, same idiom as
// SolidsWorkbenchPage.rollback.test.tsx).
//
// AC #1's "regen after reorder replays in the new order and produces the
// DAG-correct result (execution-order spy test)": RegenScheduler.markDirty
// expands a reorder's own touched id to its DOWNSTREAM CLOSURE (regen/
// scheduler.ts) -- so reordering a PRODUCER that has a real downstream
// consumer (the boolean feature below) naturally re-dirties both in the SAME
// pass, and the fake client's opCalls records the actual kernel-op execution
// order. topoOrder() itself (dag.ts) is a pure function of nodes+edges,
// unaffected by featureOrder()'s cosmetic permutation -- this test proves
// that invariant survives a real reorder: the producer's kernel op still
// runs before its consumer's, and an UNTOUCHED sibling never re-executes
// (the R1.3 over-regeneration guard, unaffected by this WO).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
// WO SKC-15: every workbench document is now born with Origin + XY/XZ/YZ at featureOrder() indices
// 0..3 (Operator A2). The absolute-order assertions below therefore carry that prefix. Asserting the
// FULL order -- rather than filtering the genesis rows out -- keeps these list-equality checks
// honest about what featureOrder() actually contains. The drags themselves are unaffected: they
// target rows by testid, not by index.
import { GENESIS_NODE_IDS as G } from '../../doc'
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

function dataTransferStub(payload: string) {
  return { getData: () => payload, setData: () => undefined }
}

function dragRow(fromTestId: string, ontoTestId: string, payload: string): void {
  fireEvent.dragStart(screen.getByTestId(fromTestId), { dataTransfer: dataTransferStub(payload) })
  fireEvent.dragOver(screen.getByTestId(ontoTestId), { dataTransfer: dataTransferStub(payload) })
  fireEvent.drop(screen.getByTestId(ontoTestId), { dataTransfer: dataTransferStub(payload) })
}

async function newSketch(name: string): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId(`feature-row-${name}`)).toBeTruthy())
}

/** SK1 -> F1 (extrude), SK2 -> F2 (extrude), Boolean(target F1, tool F2) -> F3.
 *  featureOrder() ends up ['SK1', 'F1', 'SK2', 'F2', 'F3']; F3 consumes [F1, F2]
 *  directly (BooleanDialog.tsx) -- F1 and F2 have no edge between each other. */
async function buildTwoExtrudesAndBoolean(client: ReturnType<typeof createFakeGeomClient>): Promise<void> {
  render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

  await newSketch('SK1')
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

  await newSketch('SK2')
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK2' } })
  commitField('extrude-distance', '5')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

  fireEvent.click(screen.getByTestId('workbench-boolean'))
  fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'F1' } })
  fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'F2' } })
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined())

  expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'F1', 'SK2', 'F2', 'F3'])
}

describe('SolidsWorkbenchPage drag-reorder (WO UI-9, BK-41)', () => {
  it('AC #1: a legal drag-reorder at the real tree UI boundary moves featureOrder(), and the subsequent regen pass executes the DOWNSTREAM consumer AFTER its reordered producer while leaving an untouched sibling alone', async () => {
    const client = createFakeGeomClient()
    await buildTwoExtrudesAndBoolean(client)

    const before = client.opCalls.length

    // F1 may move anywhere between SK1 (its own producer, stays before it)
    // and F3 (its consumer, stays after it) -- drop it onto F2's row to
    // land it right after SK2/F2, still legally above F3.
    dragRow('feature-row-F1', 'feature-row-F2', 'F1')
    await waitFor(() => expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'SK2', 'F2', 'F1', 'F3']))

    // markDirty('F1') expands to F1's downstream closure -- F3 consumes F1,
    // so BOTH re-execute in this one pass; F2 (untouched, no edge to F1)
    // does not.
    await waitFor(() => expect(client.opCalls.length).toBeGreaterThan(before))
    const replayed = client.opCalls.slice(before)
    expect(replayed.map((c) => c.featureId)).toEqual(['F1', 'F3'])
    expect(replayed[0].op).toBe('makeExtrude')
    expect(replayed[1].op).toBe('applyBoolean')
  })

  it('AC #2: an illegal drop at the real tree UI boundary is refused -- featureOrder() and body handles are untouched, no kernel op re-runs', async () => {
    const client = createFakeGeomClient()
    await buildTwoExtrudesAndBoolean(client)
    const before = client.opCalls.length

    // F3 consumes F1 -- dropping F3 above F1 (onto SK1's row) is illegal.
    dragRow('feature-row-F3', 'feature-row-SK1', 'F3')

    expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'F1', 'SK2', 'F2', 'F3'])
    expect(screen.getByTestId('reorder-refusal-message').textContent).toMatch(/uses/i)
    expect(client.opCalls.length).toBe(before)
  })

  it('AC #4: undo/redo round-trips a drag-reorder through the real workbench', async () => {
    const client = createFakeGeomClient()
    await buildTwoExtrudesAndBoolean(client)

    dragRow('feature-row-F1', 'feature-row-F2', 'F1')
    await waitFor(() => expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'SK2', 'F2', 'F1', 'F3']))

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'F1', 'SK2', 'F2', 'F3']))

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'SK2', 'F2', 'F1', 'F3']))
  })

  it('interplay: dragging an independent feature below the rollback marker rollback-suppresses it; dragging it back above restores it (WO UI-7 semantics, real UI boundary)', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await newSketch('SK1')
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    await newSketch('SK2') // independent -- no extrude, no edges at all
    expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'F1', 'SK2'])

    // Drop the marker onto SK2's row (no reorder payload -- falls through to
    // the marker-move branch) -- marker lands after F1; SK2 is rolled back.
    fireEvent.drop(screen.getByTestId('feature-row-SK2'))
    await waitFor(() => expect(hooks().dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'F1' }))
    expect(hooks().dag.isRolledBack('SK2')).toBe(true)
    expect(screen.getByTestId('feature-row-SK2').dataset.rolledBack).toBe('true')

    // Drag SK2 back above the marker (onto F1's row) -- SK2 has no edges at
    // all, so this is unconditionally legal.
    dragRow('feature-row-SK2', 'feature-row-F1', 'SK2')
    await waitFor(() => expect(hooks().dag.featureOrder()).toEqual([...G, 'SK1', 'SK2', 'F1']))
    expect(hooks().dag.isRolledBack('SK2')).toBe(false)
    expect(screen.getByTestId('feature-row-SK2').dataset.rolledBack).toBe('false')
  })
})
