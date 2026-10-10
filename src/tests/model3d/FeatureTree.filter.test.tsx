// @vitest-environment jsdom
//
// WO UI-8 (BK-42 mission #1): Design Tree filter bar -- text match, :errors,
// :suppressed, :type <kind> operators, matched-count, and the BINDING
// "filtering never changes document state" invariant (AC #1). Real render()
// (render-gate rule), never a store/test-harness proxy.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeatureTree } from '../../components/model3d/tree'
import { FeatureDag, RegenScheduler, ElementMap } from '../../doc'

afterEach(cleanup)

function chainDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], payload: { name: 'Base', opType: 'extrude' } })
  dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'], payload: { name: 'Hole', opType: 'revolve' } })
  dag.insertNode({ id: 'F3', kind: 'sketch', consumes: [], payload: { name: 'Sketch1' } })
  return dag
}

describe('FeatureTree filter bar (WO UI-8, BK-42 mission #1)', () => {
  it('renders the full tree and a plain total count when nothing is typed', () => {
    const dag = chainDag()
    render(<FeatureTree dag={dag} />)
    for (const id of ['F1', 'F2', 'F3']) expect(screen.getByTestId(`feature-row-${id}`)).toBeTruthy()
    expect(screen.getByTestId('tree-filter-count').textContent).toBe('3')
    expect(screen.queryByTestId('tree-filter-clear')).toBeNull()
  })

  it('plain text filters by name (case-insensitive substring), hides non-matching rows, shows shown/total', () => {
    const dag = chainDag()
    render(<FeatureTree dag={dag} />)
    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: 'hole' } })

    expect(screen.getByTestId('feature-row-F2')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-F1')).toBeNull()
    expect(screen.queryByTestId('feature-row-F3')).toBeNull()
    expect(screen.getByTestId('tree-filter-count').textContent).toBe('1/3')
  })

  it(':type <kind> matches a feature\'s opType when present', () => {
    const dag = chainDag()
    render(<FeatureTree dag={dag} />)
    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: ':type extrude' } })

    expect(screen.getByTestId('feature-row-F1')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-F2')).toBeNull()
    expect(screen.queryByTestId('feature-row-F3')).toBeNull()
  })

  it(':type <kind> matches DagNodeKind for nodes with no opType (e.g. sketch)', () => {
    const dag = chainDag()
    render(<FeatureTree dag={dag} />)
    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: ':type sketch' } })
    expect(screen.getByTestId('feature-row-F3')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-F1')).toBeNull()
  })

  it(':suppressed matches root-, cascade-, and rollback-suppressed features', () => {
    const dag = chainDag()
    dag.setSuppressed('F1', true) // cascades to F2 too
    render(<FeatureTree dag={dag} />)
    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: ':suppressed' } })

    expect(screen.getByTestId('feature-row-F1')).toBeTruthy() // root
    expect(screen.getByTestId('feature-row-F2')).toBeTruthy() // cascade
    expect(screen.queryByTestId('feature-row-F3')).toBeNull() // healthy
  })

  it(':errors matches degraded/failed features -- pairs with the shipped status badge', async () => {
    // Independent nodes (no consumes edge) so only F1's OWN failure is under
    // test -- an upstream-failure CASCADE (F2 degraded because it consumes a
    // failed F1) is a real, separate 'degraded' case this same filter also
    // matches; keeping F1/F2 independent here isolates the plain 'failed' case.
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], payload: { name: 'Base', opType: 'extrude' } })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: [], payload: { name: 'Hole', opType: 'revolve' } })
    dag.insertNode({ id: 'F3', kind: 'sketch', consumes: [], payload: { name: 'Sketch1' } })
    const scheduler = new RegenScheduler(dag, new ElementMap())
    scheduler.markDirty('F1')
    scheduler.markDirty('F2')
    // Executor that always fails F1 -- puts it in 'failed' status; F2 succeeds.
    await scheduler.run(async (node) => {
      if (node.id === 'F1') return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: {} }] }
      return { ok: true, diagnostics: [] }
    })
    render(<FeatureTree dag={dag} scheduler={scheduler} />)
    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: ':errors' } })

    expect(screen.getByTestId('feature-row-F1')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-F2')).toBeNull()
    expect(screen.queryByTestId('feature-row-F3')).toBeNull()
  })

  it('operators AND with free text: :type extrude combined with a non-matching name excludes the row', () => {
    const dag = chainDag()
    render(<FeatureTree dag={dag} />)
    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: ':type extrude hole' } })
    expect(screen.queryByTestId('feature-row-F1')).toBeNull() // opType matches, name does not
  })

  it('the clear button and Escape both restore the full tree', () => {
    const dag = chainDag()
    render(<FeatureTree dag={dag} />)
    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: 'hole' } })
    expect(screen.queryByTestId('feature-row-F1')).toBeNull()

    fireEvent.click(screen.getByTestId('tree-filter-clear'))
    expect(screen.getByTestId('feature-row-F1')).toBeTruthy()
    expect(screen.getByTestId('tree-filter-count').textContent).toBe('3')

    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: 'hole' } })
    fireEvent.keyDown(screen.getByTestId('tree-filter-input'), { key: 'Escape' })
    expect(screen.getByTestId('feature-row-F1')).toBeTruthy()
  })

  // AC #1's binding invariant: filtering is a VIEW, never document state.
  it('AC #1: typing/clearing a filter never changes dag.serialize() (document byte-identical)', () => {
    const dag = chainDag()
    const before = dag.serialize()
    render(<FeatureTree dag={dag} />)

    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: ':errors :suppressed :type extrude hole' } })
    expect(dag.serialize()).toBe(before)

    fireEvent.click(screen.getByTestId('tree-filter-clear'))
    expect(dag.serialize()).toBe(before)
  })

  it('an empty tree still renders the filter bar', () => {
    const dag = new FeatureDag()
    render(<FeatureTree dag={dag} />)
    expect(screen.getByTestId('tree-filter-bar')).toBeTruthy()
    expect(screen.getByTestId('tree-filter-count').textContent).toBe('0')
  })
})
