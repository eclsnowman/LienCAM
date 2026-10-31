// @vitest-environment jsdom
//
// WO-3230 (WO-3172 Draft C): the Sweep dialog's explicit Axis / Sketch path
// switch, at the dialog seam (a plain FeatureDag + CommandHistory, no kernel).
// The workbench-level route, with the real kernel and measured volumes, is
// SolidsWorkbenchPage.curvedSweep.wo3172.test.tsx.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SweepDialog } from '../../components/model3d/dialogs/SweepDialog'
import { CommandHistory, FeatureDag } from '../../doc'
import { NODE_ID_BY_BASE_PLANE, seedGenesisNodes } from '../../components/model3d/workbench/basePlanes'
import type { ProfilePickRequest } from '../../components/model3d/workbench/profileRegionPicker'
import type { Sketch } from '../../lib/sketch/types'

afterEach(cleanup)

const PROF = 'sketch3d:PROF'
const PATH = 'sketch3d:PATH'
const XY = NODE_ID_BY_BASE_PLANE.xy

function packageSketch(entities: Sketch['entities']): Sketch {
  return { id: 'S', layerId: 'plane:xy', entities, constraints: [], dimensions: [], solveStatus: null }
}

/** A closed profile sketch, an open L path sketch (l1 then l2) and one legacy axis sweep F1. */
function fixture(): { dag: FeatureDag; history: CommandHistory } {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  dag.insertNode({
    id: PROF, kind: 'sketch', consumes: [XY],
    payload: {
      name: 'Profile', planeNodeId: XY,
      sketch: packageSketch([{ id: 'c1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 2 }]),
    },
  })
  dag.insertNode({
    id: PATH, kind: 'sketch', consumes: [XY],
    payload: {
      name: 'Path', planeNodeId: XY,
      sketch: packageSketch([
        { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
        { id: 'l2', kind: 'line', construction: false, start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
      ]),
    },
  })
  dag.insertNode({
    id: 'F1', kind: 'feature', consumes: [PROF],
    payload: { opType: 'sweep', sketchId: PROF, axis: 'x', length: 42, orientation: 'fixed', name: 'Sweep F1', profileSelector: { kind: 'whole-sketch' }, note: 'kept' },
  })
  return { dag, history: new CommandHistory(dag) }
}

const options = [{ id: PROF, label: 'Profile' }, { id: PATH, label: 'Path' }]

function chooseChain(text: RegExp): void {
  const select = screen.getByTestId('sweep-path-chain-select') as HTMLSelectElement
  const option = Array.from(select.options).find((o) => text.test(o.textContent ?? ''))
  expect(option, `a chain option matching ${text}`).toBeDefined()
  fireEvent.change(select, { target: { value: option!.value } })
}

describe('WO-3230 Sweep dialog: Axis / Sketch path', () => {
  it('switches axis and sketch mode explicitly while preserving legacy fields', () => {
    const { dag, history } = fixture()
    const onApplied = vi.fn()
    const view = render(<SweepDialog dag={dag} history={history} sketchOptions={options} mode="edit" featureId="F1" onApplied={onApplied} onClose={() => {}} />)

    const sketchMode = screen.queryByTestId('sweep-path-mode-sketch') as HTMLInputElement | null
    expect(sketchMode, 'the dialog offers an explicit Sketch path mode').not.toBeNull()
    expect((screen.getByTestId('sweep-path-mode-axis') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(sketchMode!)
    // An edit never re-chooses the operator's orientation behind their back.
    expect((screen.getByTestId('sweep-orientation-select') as HTMLSelectElement).value).toBe('fixed')
    fireEvent.change(screen.getByTestId('sweep-orientation-select'), { target: { value: 'frenet' } })
    expect(screen.getByTestId('sweep-orientation-select').textContent).toMatch(/Follow path/)
    chooseChain(/line l1.*line l2/)
    expect(screen.getByTestId('sweep-path-start').textContent).toBe('Starts at (0, 0, 0) mm, heading (1, 0, 0)')
    fireEvent.click(screen.getByTestId('sweep-path-reverse'))
    expect(screen.getByTestId('sweep-path-start').textContent).toBe('Starts at (20, 20, 0) mm, heading (0, -1, 0)')
    fireEvent.click(screen.getByTestId('sweep-path-reverse'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const swept = dag.getNode('F1')!
    expect(swept.payload).toEqual({
      opType: 'sweep', sketchId: PROF, axis: 'x', length: 42, orientation: 'frenet', name: 'Sweep F1',
      profileSelector: { kind: 'whole-sketch' }, note: 'kept',
      path: { kind: 'sketch-chain', sketchId: PATH, steps: [{ entityId: 'l1', forward: true }, { entityId: 'l2', forward: true }] },
    })
    expect(swept.consumes).toEqual([PROF, PATH])
    expect(onApplied).toHaveBeenCalledWith('F1')
    view.unmount()

    // Back to Axis: the dormant axis/length come back unchanged and the path producer is released.
    render(<SweepDialog dag={dag} history={history} sketchOptions={options} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)
    expect((screen.getByTestId('sweep-path-mode-sketch') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('sweep-path-mode-axis'))
    expect((screen.getByTestId('sweep-path-axis-select') as HTMLSelectElement).value).toBe('x')
    expect((screen.getByTestId('sweep-length').querySelector('input') as HTMLInputElement).value).toBe('42')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    const axisAgain = dag.getNode('F1')!
    expect(axisAgain.payload).toEqual({
      opType: 'sweep', sketchId: PROF, axis: 'x', length: 42, orientation: 'frenet', name: 'Sweep F1',
      profileSelector: { kind: 'whole-sketch' }, note: 'kept',
    })
    expect(axisAgain.consumes).toEqual([PROF])
    expect(history.size()).toBe(2)
    cleanup()

    // A new sweep: Sketch path takes Follow path for the untouched orientation; back on Axis it is Fixed again.
    render(<SweepDialog dag={dag} history={history} sketchOptions={options} onApplied={() => {}} onClose={() => {}} />)
    const orientationNow = () => (screen.getByTestId('sweep-orientation-select') as HTMLSelectElement).value
    expect(orientationNow()).toBe('fixed')
    fireEvent.click(screen.getByTestId('sweep-path-mode-sketch'))
    expect(orientationNow()).toBe('frenet')
    fireEvent.click(screen.getByTestId('sweep-path-mode-axis'))
    expect(orientationNow()).toBe('fixed')
  })

  it('cancel escape tool switch and late picker completion leave DAG and history unchanged', () => {
    const { dag, history } = fixture()
    const before = dag.serialize()
    let lateRequest: ProfilePickRequest | undefined
    const onStartProfilePick = (request: ProfilePickRequest): (() => void) => {
      lateRequest = request
      return () => {}
    }
    const onClose = vi.fn()
    const onApplied = vi.fn()
    const open = () => render(
      <SweepDialog dag={dag} history={history} sketchOptions={options} onStartProfilePick={onStartProfilePick} onApplied={onApplied} onClose={onClose} />,
    )

    // Cancel after choosing a sketch path.
    let view = open()
    const sketchMode = screen.queryByTestId('sweep-path-mode-sketch')
    expect(sketchMode, 'the dialog offers an explicit Sketch path mode').not.toBeNull()
    fireEvent.click(sketchMode!)
    chooseChain(/line l1/)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    view.unmount()

    // Escape after choosing a sketch path.
    view = open()
    fireEvent.click(screen.getByTestId('sweep-path-mode-sketch'))
    chooseChain(/line l1/)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()

    // Tool switch: the workbench unmounts the dialog while a profile pick is live, and the pick
    // completes after that.
    view = open()
    fireEvent.click(screen.getByTestId('sweep-path-mode-sketch'))
    chooseChain(/line l1/)
    fireEvent.click(screen.getByTestId('sweep-pick-profile'))
    expect(lateRequest).toBeDefined()
    view.unmount()
    lateRequest!.onDone([{ sketchId: PROF, profileSelector: { kind: 'whole-sketch' } }])

    expect(onApplied).not.toHaveBeenCalled()
    expect(dag.serialize()).toBe(before)
    expect(history.size()).toBe(0)
  })
  it('refuses a path sketch that is built from this sweep, naming the loop', () => {
    const { dag, history } = fixture()
    const ON_F1 = 'sketch3d:ONF1'
    dag.insertNode({
      id: ON_F1, kind: 'sketch', consumes: [XY, 'F1'],
      payload: {
        name: 'On sweep', planeNodeId: XY,
        sketch: packageSketch([{ id: 'm1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 0, y: 30 } }]),
      },
    })
    const before = dag.serialize()
    render(<SweepDialog dag={dag} history={history} sketchOptions={[...options, { id: ON_F1, label: 'On sweep' }]} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('sweep-path-mode-sketch'))
    chooseChain(/On sweep.*line m1/)
    expect(screen.getByTestId('sweep-path-error').textContent).toMatch(/On sweep is built from Sweep F1/)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(dag.serialize()).toBe(before)
    expect(history.size()).toBe(0)

    // Any other sketch is fine whichever was drawn first.
    chooseChain(/line l1.*line l2/)
    expect(screen.queryByTestId('sweep-path-error')).toBeNull()
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
  })
})
