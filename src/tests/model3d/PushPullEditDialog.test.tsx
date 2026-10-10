// @vitest-environment jsdom
//
// WO UI-80 AM4 + render smoke: the edit-after-creation dialog for a first-class
// push/pull node. Renders standalone against a real FeatureDag + CommandHistory
// (both pure -- no kernel), so it doubles as the React render smoke test a new
// modal owes (charter rule 10 / render-gate). Proves:
//  - the modal renders its distance + direction controls (hooks-order safe);
//  - Apply runs EXACTLY one EditFeaturePayloadCommand on the pushPull node
//    itself (not the owner), updating the signed delta, with ONE undo step and
//    the node's identity/topology (opType/ownerId/consumes/refs) preserved --
//    the ExtrudeDialog edit-mode parity AM4 requires.
//
// FAILS-IF: Apply targets the owner instead of the node, or writes a raw
// magnitude without the direction sign, or pushes more than one command.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeatureDag, CommandHistory } from '../../doc'
import { PushPullEditDialog } from '../../components/model3d/dialogs/PushPullEditDialog'

afterEach(cleanup)

function dagWithPushPull(delta: number): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], payload: { opType: 'extrude', name: 'Extrude F1' } })
  dag.insertNode({
    id: 'F2',
    kind: 'feature',
    consumes: ['F1'],
    refs: [{ id: 'F1:BOX:zMax', kind: 'single-face' }],
    payload: { opType: 'pushPull', ownerId: 'F1', delta, normal: { x: 0, y: 0, z: 1 }, name: 'Push/Pull F2' },
  })
  return dag
}

function distanceInput(): HTMLInputElement {
  return screen.getByTestId('pushpull-distance').querySelector('input') as HTMLInputElement
}

describe('WO UI-80 PushPullEditDialog (AM4)', () => {
  it('renders distance + direction controls seeded from the node payload', () => {
    const dag = dagWithPushPull(3)
    render(<PushPullEditDialog dag={dag} history={new CommandHistory(dag)} featureId="F2" onApplied={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('pushpull-direction-select')).toBeTruthy()
    expect(distanceInput().value).toBe('3')
    expect((screen.getByTestId('pushpull-direction-select') as HTMLSelectElement).value).toBe('outward')
  })

  it('seeds an inward (negative) delta as magnitude 5 + inward direction', () => {
    const dag = dagWithPushPull(-5)
    render(<PushPullEditDialog dag={dag} history={new CommandHistory(dag)} featureId="F2" onApplied={() => {}} onClose={() => {}} />)
    expect(distanceInput().value).toBe('5')
    expect((screen.getByTestId('pushpull-direction-select') as HTMLSelectElement).value).toBe('inward')
  })

  it('Apply runs one EditFeaturePayloadCommand on the pushPull NODE, updates the signed delta, and is a single undo step', () => {
    const dag = dagWithPushPull(3)
    const history = new CommandHistory(dag)
    const onApplied = vi.fn()
    const onClose = vi.fn()
    render(<PushPullEditDialog dag={dag} history={history} featureId="F2" onApplied={onApplied} onClose={onClose} />)

    // Change magnitude to 8, flip to inward -> delta must become -8.
    // NumericInput commits on blur (same contract the extrude dialog tests use).
    fireEvent.change(distanceInput(), { target: { value: '8' } })
    fireEvent.blur(distanceInput())
    fireEvent.change(screen.getByTestId('pushpull-direction-select'), { target: { value: 'inward' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    // The pushPull node's own payload changed; the owner F1 is untouched.
    expect(dag.getNode('F2')!.payload.delta).toBe(-8)
    expect(dag.getNode('F2')!.payload.opType).toBe('pushPull')
    expect(dag.getNode('F2')!.payload.ownerId).toBe('F1')
    expect(dag.getNode('F2')!.consumes).toEqual(['F1'])
    expect(dag.getNode('F2')!.refs).toEqual([{ id: 'F1:BOX:zMax', kind: 'single-face' }])
    expect(onApplied).toHaveBeenCalledWith('F2')
    expect(onClose).toHaveBeenCalledTimes(1)

    // ONE undo step reverts the delta exactly (ExtrudeDialog edit-mode parity).
    expect(history.canUndo()).toBe(true)
    expect(history.undo()).toBe(true)
    expect(dag.getNode('F2')!.payload.delta).toBe(3)
    expect(history.canUndo()).toBe(false)
  })
})
