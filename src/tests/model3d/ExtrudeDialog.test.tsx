// @vitest-environment jsdom
//
// WO INT-4A: ExtrudeDialog render/behavior test (DAG + CommandHistory only,
// no kernel). Create mode inserts a 'feature' node consuming the chosen
// sketch (InsertNodeCommand, undo removes it); edit mode goes through the
// SAME EditFeaturePayloadCommand seam BoxSizeDialog.test.tsx proves.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ExtrudeDialog } from '../../components/model3d/dialogs'
import { CommandHistory, FeatureDag } from '../../doc'

afterEach(cleanup)

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function setupWithSketch() {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1' } })
  const history = new CommandHistory(dag)
  return { dag, history }
}

describe('ExtrudeDialog (WO INT-4A)', () => {
  it('create mode inserts a feature node consuming the selected sketch, undo removes it', () => {
    const { dag, history } = setupWithSketch()
    let applied: string | null = null
    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="create"
        sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]}
        onApplied={(id) => (applied = id)}
        onClose={() => {}}
      />,
    )

    commitField('extrude-distance', '25')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(applied).toBe('F1')
    const node = dag.getNode('F1')
    expect(node?.kind).toBe('feature')
    expect(node?.consumes).toEqual(['SK1'])
    expect(node?.payload).toMatchObject({ opType: 'extrude', sketchId: 'SK1', distance: 25 })

    expect(history.undo()).toBe(true)
    expect(dag.has('F1')).toBe(false)
  })

  it('edit mode changes only the distance through EditFeaturePayloadCommand, undo restores it', () => {
    const { dag, history } = setupWithSketch()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', distance: 10, name: 'Extrude F1' } })

    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="edit"
        featureId="F1"
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )

    const distanceInput = screen.getByTestId('extrude-distance').querySelector('input') as HTMLInputElement
    expect(distanceInput.value).toBe('10')
    expect((screen.getByTestId('extrude-profile-select') as HTMLSelectElement).value).toBe('SK1')

    commitField('extrude-distance', '40')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(dag.getNode('F1')?.payload).toMatchObject({ sketchId: 'SK1', distance: 40 })
    expect(history.undo()).toBe(true)
    expect(dag.getNode('F1')?.payload.distance).toBe(10)
  })

  it('WO INT-4A-R1.1: binding a driving expression sets payload.expression and consumes the referenced parameter', () => {
    const { dag, history } = setupWithSketch()
    dag.insertNode({ id: 'param:base', kind: 'parameter', payload: { name: 'base', expression: '5', value: 5 } })
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', distance: 10, name: 'Extrude F1' } })

    render(<ExtrudeDialog dag={dag} history={history} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)

    fireEvent.change(screen.getByTestId('extrude-distance-expression'), { target: { value: 'base*7' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const node = dag.getNode('F1')
    expect(node?.payload.expression).toBe('base*7')
    expect(node?.consumes.slice().sort()).toEqual(['SK1', 'param:base'])
  })

  it('WO INT-4A-R1.1: an invalid expression is rejected and blocks Apply (nothing committed)', () => {
    const { dag, history } = setupWithSketch()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', distance: 10, name: 'Extrude F1' } })

    render(<ExtrudeDialog dag={dag} history={history} mode="edit" featureId="F1" onApplied={() => {}} onClose={() => {}} />)

    const expressionInput = screen.getByTestId('extrude-distance-expression')
    fireEvent.change(expressionInput, { target: { value: '1 + ' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(dag.getNode('F1')?.payload.expression).toBeUndefined()
    expect(dag.getNode('F1')?.payload.distance).toBe(10)
    expect(screen.getByTestId('extrude-distance-expression-error')).toBeTruthy()
  })

  // ---- WO UI-51A: direction / boolean mode / target ----

  it('WO UI-51A: create mode defaults to up / newBody with no target, consuming only the sketch', () => {
    const { dag, history } = setupWithSketch()
    let applied: string | null = null
    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="create"
        sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]}
        bodyOptions={[]}
        onApplied={(id) => (applied = id)}
        onClose={() => {}}
      />,
    )
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(applied).toBe('F1')
    const node = dag.getNode('F1')
    expect(node?.payload).toMatchObject({ opType: 'extrude', sketchId: 'SK1', distance: 12, direction: 'up', boolMode: 'newBody' })
    expect(node?.payload.targetFeatureId).toBeUndefined()
    expect(node?.consumes).toEqual(['SK1'])
  })

  it('WO UI-51A: create mode down + Remove against a target writes the target edge + payload', () => {
    const { dag, history } = setupWithSketch()
    dag.insertNode({ id: 'B1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', distance: 30, direction: 'up', boolMode: 'newBody', name: 'Extrude B1' } })
    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="create"
        sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]}
        bodyOptions={[{ id: 'B1', label: 'Extrude B1' }]}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByTestId('extrude-direction-select'), { target: { value: 'down' } })
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    // target select auto-populates to B1 (first body); confirm it renders.
    expect((screen.getByTestId('extrude-target-select') as HTMLSelectElement).value).toBe('B1')
    commitField('extrude-distance', '8')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const node = dag.getNode('F1')
    expect(node?.payload).toMatchObject({ direction: 'down', boolMode: 'remove', targetFeatureId: 'B1', distance: 8 })
    expect(node?.consumes.slice().sort()).toEqual(['B1', 'SK1'])
  })

  it('WO UI-51A: Remove with no available body disables Apply and names why', () => {
    const { dag, history } = setupWithSketch()
    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="create"
        sketchOptions={[{ id: 'SK1', label: 'Sketch SK1' }]}
        bodyOptions={[]}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    expect(screen.getByTestId('extrude-target-error')).toBeTruthy()
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
  })

  it('WO UI-51A: edit mode prefills direction, result, and target', () => {
    const { dag, history } = setupWithSketch()
    dag.insertNode({ id: 'B0', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', distance: 30, direction: 'up', boolMode: 'newBody', name: 'B0' } })
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1', 'B0'],
      payload: { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'remove', targetFeatureId: 'B0', name: 'Extrude F1' },
    })
    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="edit"
        featureId="F1"
        bodyOptions={[{ id: 'B0', label: 'B0' }]}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    expect((screen.getByTestId('extrude-boolmode-select') as HTMLSelectElement).value).toBe('remove')
    expect((screen.getByTestId('extrude-target-select') as HTMLSelectElement).value).toBe('B0')

    // WO-216 (b5b5c712) made 'midplane' a direction implied by the 'symmetric'
    // end condition, not a directly selectable option (the direction select is
    // disabled and filtered to 'midplane' only once endCondition==='symmetric').
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'symmetric' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const node = dag.getNode('F1')
    expect(node?.payload).toMatchObject({ direction: 'midplane', boolMode: 'remove', targetFeatureId: 'B0', distance: 10 })
    expect(node?.consumes.slice().sort()).toEqual(['B0', 'SK1'])
  })

  it('UI-54: an unavailable edit target is named and cannot mutate the graph', () => {
    const { dag, history } = setupWithSketch()
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1', 'MISSING'],
      payload: {
        opType: 'extrude',
        sketchId: 'SK1',
        distance: 10,
        direction: 'up',
        boolMode: 'remove',
        targetFeatureId: 'MISSING',
        name: 'Extrude F1',
      },
    })
    const before = dag.getNode('F1')

    render(
      <ExtrudeDialog
        dag={dag}
        history={history}
        mode="edit"
        featureId="F1"
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )

    expect(screen.getByTestId('extrude-target-error').textContent).toMatch(/needs an existing body/i)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(dag.getNode('F1')).toEqual(before)
    expect(history.canUndo()).toBe(false)
  })
})
