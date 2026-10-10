// @vitest-environment jsdom

import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandHistory, CompositeCommand, FeatureDag, RemoveNodeCommand } from '../../doc'
import {
  FeatureTree,
  planFeatureDelete,
  visibleFeatureTreeOrder,
} from '../../components/model3d/tree'

afterEach(cleanup)

function faceSketchDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', payload: { name: 'Body' } })
  dag.insertNode({
    id: 'datum:SK2',
    kind: 'datum',
    consumes: ['F1'],
    payload: { datumType: 'plane', planeKind: 'face-plane' },
  })
  dag.insertNode({
    id: 'sketch3d:SK2',
    kind: 'sketch',
    consumes: ['datum:SK2'],
    payload: { name: 'Face sketch', planeNodeId: 'datum:SK2', sketch: {} },
  })
  return dag
}

function DeleteHarness({ dag, history }: { dag: FeatureDag; history: CommandHistory }) {
  const [, rerender] = useState(0)
  return (
    <FeatureTree
      dag={dag}
      del={{
        consumersOf: (id) => dag.transitiveConsumersOf(id),
        onDelete: (id) => {
          const plan = planFeatureDelete(dag, id)
          if (!plan.ok) return
          history.execute(new CompositeCommand(
            plan.removalOrder.map((nodeId) => new RemoveNodeCommand(nodeId)),
            'deleteFeature',
          ))
          rerender((value) => value + 1)
        },
      }}
    />
  )
}

describe('UI-55 private face datum lifecycle', () => {
  it('keeps the datum live for internal consumers without rendering a user row', () => {
    const dag = faceSketchDag()
    render(<FeatureTree dag={dag} />)

    expect(dag.has('datum:SK2')).toBe(true)
    const privateDatumRow = screen.getByTestId('feature-row-datum:SK2')
    expect(privateDatumRow.hidden).toBe(true)
    expect(privateDatumRow.style.display).toBe('none')
    expect(privateDatumRow.getAttribute('aria-hidden')).toBe('true')
    expect(privateDatumRow.tabIndex).toBe(-1)
    expect(screen.getByTestId('feature-row-sketch3d:SK2')).toBeTruthy()
    expect(visibleFeatureTreeOrder(dag)).toEqual(['F1', 'sketch3d:SK2'])
    expect(screen.getByTestId('tree-filter-count').textContent).toContain('2')
  })

  it('deletes an unshared generated datum with its sketch in one undoable action', () => {
    const dag = faceSketchDag()
    const history = new CommandHistory(dag)
    const beforeOrder = dag.featureOrder()
    render(<DeleteHarness dag={dag} history={history} />)

    fireEvent.keyDown(screen.getByTestId('feature-row-sketch3d:SK2'), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))

    expect(dag.has('sketch3d:SK2')).toBe(false)
    expect(dag.has('datum:SK2')).toBe(false)
    expect(dag.has('F1')).toBe(true)
    expect(history.size()).toBe(1)

    expect(history.undo()).toBe(true)
    expect(dag.has('datum:SK2')).toBe(true)
    expect(dag.has('sketch3d:SK2')).toBe(true)
    expect(dag.featureOrder()).toEqual(beforeOrder)

    expect(history.redo()).toBe(true)
    expect(dag.has('sketch3d:SK2')).toBe(false)
    expect(dag.has('datum:SK2')).toBe(false)
    expect(dag.has('F1')).toBe(true)
  })

  it('shows an explicit Offset Plane as a normal named tree feature', () => {
    const dag = faceSketchDag()
    dag.insertNode({
      id: 'datum:Offset1',
      kind: 'datum',
      consumes: ['datum:SK2'],
      payload: {
        datumType: 'plane',
        planeKind: 'offset-plane',
        payloadSchema: 1,
        name: 'Offset Plane 1',
        definition: { kind: 'offset', distance: 10, flipNormal: false },
      },
    })
    render(<FeatureTree dag={dag} />)

    const row = screen.getByTestId('feature-row-datum:Offset1')
    expect(row.hidden).toBe(false)
    expect(row.textContent).toContain('Offset Plane 1')
    expect(visibleFeatureTreeOrder(dag)).toEqual(['F1', 'sketch3d:SK2', 'datum:Offset1'])
  })

  it('refuses the delete plan and preserves both nodes when another consumer uses the datum', () => {
    const dag = faceSketchDag()
    dag.insertNode({
      id: 'sketch3d:OTHER',
      kind: 'sketch',
      consumes: ['datum:SK2'],
      payload: { name: 'Referenced sketch', planeNodeId: 'datum:SK2', sketch: {} },
    })
    const before = dag.serialize()

    const plan = planFeatureDelete(dag, 'sketch3d:SK2')

    expect(plan).toEqual({
      ok: false,
      datumId: 'datum:SK2',
      retainedConsumerIds: ['sketch3d:OTHER'],
    })
    expect(dag.serialize()).toBe(before)
    expect(dag.has('datum:SK2')).toBe(true)
    expect(dag.has('sketch3d:SK2')).toBe(true)
  })
})
