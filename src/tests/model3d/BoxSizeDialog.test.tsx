// @vitest-environment jsdom
//
// WO UI-3 acceptance #2: property-dialog framework proof. Drives the REAL
// FeatureDag + CommandHistory (DOC-2) through the demo BoxSizeDialog:
//  - open: reads the feature's current payload
//  - field change: onPreview fires with the draft size (live-preview seam)
//  - cancel: onCancelPreview fires, DAG untouched (nothing to undo)
//  - apply: EditFeaturePayloadCommand lands through CommandHistory, and
//    history.undo() restores the exact original payload (undo works).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { BoxSizeDialog } from '../../components/model3d/dialogs'
import { CommandHistory, FeatureDag } from '../../doc'

afterEach(cleanup)

function setup() {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', payload: { name: 'Box', size: { x: 10, y: 20, z: 5 } } })
  const history = new CommandHistory(dag)
  return { dag, history }
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

describe('BoxSizeDialog (WO UI-3 acceptance #2)', () => {
  it('opens with the feature current size', () => {
    const { dag, history } = setup()
    render(<BoxSizeDialog dag={dag} history={history} featureId="F1" onClose={() => {}} />)
    const xInput = screen.getByTestId('box-size-x').querySelector('input') as HTMLInputElement
    expect(xInput.value).toBe('10')
  })

  it('invokes the live-preview seam on field change, and onCancelPreview on cancel without touching the DAG', () => {
    const { dag, history } = setup()
    const previews: Array<{ x: number; y: number; z: number }> = []
    let cancelPreviewCalled = false
    let closed = false
    render(
      <BoxSizeDialog
        dag={dag}
        history={history}
        featureId="F1"
        onPreview={(size) => previews.push(size)}
        onCancelPreview={() => {
          cancelPreviewCalled = true
        }}
        onClose={() => {
          closed = true
        }}
      />,
    )

    commitField('box-size-x', '42')
    expect(previews).toEqual([{ x: 42, y: 20, z: 5 }])

    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect(cancelPreviewCalled).toBe(true)
    expect(closed).toBe(true)
    // Cancel never executed a command -- the DAG's payload is byte-identical
    // to what it was before the dialog opened.
    expect(dag.getNode('F1')?.payload.size).toEqual({ x: 10, y: 20, z: 5 })
    expect(history.canUndo()).toBe(false)
  })

  it('apply commits through CommandHistory, and undo restores the original size', () => {
    const { dag, history } = setup()
    render(<BoxSizeDialog dag={dag} history={history} featureId="F1" onClose={() => {}} />)

    commitField('box-size-x', '99')
    commitField('box-size-z', '7')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(dag.getNode('F1')?.payload.size).toEqual({ x: 99, y: 20, z: 7 })
    expect(history.canUndo()).toBe(true)

    const undone = history.undo()
    expect(undone).toBe(true)
    expect(dag.getNode('F1')?.payload.size).toEqual({ x: 10, y: 20, z: 5 })
    expect(dag.getNode('F1')?.payload.name).toBe('Box') // rest of the payload survives the round trip
  })
})
