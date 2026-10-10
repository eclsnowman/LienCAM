// @vitest-environment jsdom
//
// WO UI-7 (BK-40) mission #2: a draggable marker row in the Design Tree
// feature list; features below render in the rollback visual state,
// distinct from the two UI-6 suppress states (render-gate rule: React
// Testing Library render(), never a store/test-harness proxy).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, createEvent } from '@testing-library/react'
import { FeatureTree } from '../../components/model3d/tree'
import { FeatureDag } from '../../doc'

afterEach(cleanup)

function chainDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'Box' } })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'], payload: { name: 'Cut' } })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'], payload: { name: 'Fillet' } })
  return dag
}

function dataTransferStub(payload = 'x') {
  return { getData: () => payload, setData: () => undefined }
}

describe('FeatureTree rollback marker + rolled-back row state (WO UI-7, BK-40)', () => {
  it('with no marker set, no marker row renders and no row is rolled back', () => {
    const dag = chainDag()
    render(<FeatureTree dag={dag} />)
    expect(screen.queryByTestId('rollback-marker-row')).toBeNull()
    for (const id of ['A', 'B', 'C']) expect(screen.getByTestId(`feature-row-${id}`).dataset.rolledBack).toBe('false')
  })

  it('rolled-back visual state renders read-only even without the `rollback` control prop (glyph/opacity/label), matching the suppress backward-compat contract', () => {
    const dag = chainDag()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'A' })
    render(<FeatureTree dag={dag} />)

    const rowB = screen.getByTestId('feature-row-B')
    expect(rowB.dataset.rolledBack).toBe('true')
    expect(rowB.style.opacity).toBe('0.5')
    expect(screen.getByTestId('feature-row-rolledback-glyph-B').getAttribute('aria-label')).toBe('Rolled back')
    expect(rowB.textContent).toContain('rolled back')

    const rowA = screen.getByTestId('feature-row-A')
    expect(rowA.dataset.rolledBack).toBe('false')
    expect(rowA.style.opacity).toBe('1')

    // No `rollback` prop -> no interactive marker row.
    expect(screen.queryByTestId('rollback-marker-row')).toBeNull()
  })

  it('the marker row renders at the correct slot when `rollback` is wired, splitting active rows from rolled-back rows', () => {
    const dag = chainDag()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'A' })
    const onMoveMarker = vi.fn()
    render(<FeatureTree dag={dag} rollback={{ marker: dag.getRollbackMarker(), onMoveMarker }} />)

    const tree = screen.getByTestId('feature-tree')
    const order = ['feature-row-A', 'rollback-marker-row', 'feature-row-B', 'feature-row-C']
    const indices = order.map((testid) => [...tree.querySelectorAll(`[data-testid="${testid}"]`)][0])
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i - 1].compareDocumentPosition(indices[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('marker row renders at the very end when the marker is at "end" (nothing rolled back)', () => {
    const dag = chainDag()
    const onMoveMarker = vi.fn()
    render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)
    const tree = screen.getByTestId('feature-tree')
    const children = [...tree.children]
    // WO UI-14A (D1): the marker row is the last FEATURE-related row --
    // the trailing drop-zone (rollback-marker-trailing-dropzone) renders
    // one slot further still (a persistent drop target reaching 'end' by
    // drag, see FeatureTree.tsx's own D1 comment), so it is now the very
    // last DOM child instead.
    expect(children[children.length - 1].getAttribute('data-testid')).toBe('rollback-marker-trailing-dropzone')
    expect(children[children.length - 2].getAttribute('data-testid')).toBe('rollback-marker-row')
  })

  it('the up/down marker controls call onMoveMarker with the adjacent slot', () => {
    const dag = chainDag()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // slot 2 (A,B active; C rolled back)
    const onMoveMarker = vi.fn()
    render(<FeatureTree dag={dag} rollback={{ marker: dag.getRollbackMarker(), onMoveMarker }} />)

    fireEvent.click(screen.getByTestId('rollback-marker-up'))
    expect(onMoveMarker).toHaveBeenCalledWith({ kind: 'after', nodeId: 'A' })

    fireEvent.click(screen.getByTestId('rollback-marker-down'))
    expect(onMoveMarker).toHaveBeenCalledWith({ kind: 'end' })
  })

  it('dropping the marker onto a row moves it to sit immediately before that row', () => {
    const dag = chainDag()
    const onMoveMarker = vi.fn()
    render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)

    fireEvent.drop(screen.getByTestId('feature-row-B'))
    expect(onMoveMarker).toHaveBeenCalledWith({ kind: 'after', nodeId: 'A' })
  })

  // WO UI-14A (D1, UI-14.report.json defects[1]): dropOnRow(index) alone can
  // never reach slot=order.length ('end') -- index only ranges 0..length-1.
  // Three independent regression tests for the three new drop targets that
  // now reach it, mirroring the flipped d1-rollback-marker.mjs probe's own
  // two repro cases (last row's bottom half; the trailing empty space) plus
  // the marker-at-end row's own new onDrop.
  describe('marker reaches the true "end" slot by drag (WO UI-14A, D1)', () => {
    /** Mocks getBoundingClientRect on `el` to a real-looking 24px-tall row at
     *  `top`, restoring the original after the test (afterEach's cleanup()
     *  only unmounts React, it does not touch prototype mocks). */
    function mockRowRect(el: HTMLElement, top: number): () => void {
      const original = el.getBoundingClientRect
      el.getBoundingClientRect = () => ({ top, bottom: top + 24, left: 0, right: 200, width: 200, height: 24, x: 0, y: top, toJSON: () => ({}) })
      return () => {
        el.getBoundingClientRect = original
      }
    }

    /** jsdom has no real DragEvent constructor, so @testing-library's own
     *  fireEvent.drop(el, {clientY}) silently drops clientY (a MouseEvent-only
     *  init field the plain Event fallback it builds doesn't recognize) --
     *  confirmed empirically (a fireEvent.drop with clientY set produces
     *  e.clientY === undefined inside the handler). Builds the event via
     *  createEvent (same one fireEvent uses internally) and defines clientY
     *  directly on the instance before dispatch, exactly like dataTransfer
     *  already gets special-cased by the library itself. */
    function fireDropAt(el: HTMLElement, clientY: number): void {
      const event = createEvent.drop(el, { dataTransfer: dataTransferStub('') })
      Object.defineProperty(event, 'clientY', { value: clientY, configurable: true })
      fireEvent(el, event)
    }

    /** Same clientY special-casing as fireDropAt above, for dragOver instead
     *  of drop -- WO UI-14A-R1's D1 fix (the live indicator's own bottom-half
     *  test) needs to drive dragOver with a real clientY, not just drop. */
    function fireDragOverAt(el: HTMLElement, clientY: number): void {
      const event = createEvent.dragOver(el, { dataTransfer: dataTransferStub('') })
      Object.defineProperty(event, 'clientY', { value: clientY, configurable: true })
      fireEvent(el, event)
    }

    it('dropping on the TOP half of the LAST row still rolls back just that row (existing behavior preserved)', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)

      const rowC = screen.getByTestId('feature-row-C')
      const restore = mockRowRect(rowC, 100)
      try {
        fireDropAt(rowC, 106) // 6px into a 24px row -- top half
        expect(onMoveMarker).toHaveBeenCalledWith({ kind: 'after', nodeId: 'B' })
      } finally {
        restore()
      }
    })

    it('dropping on the BOTTOM half of the LAST row reaches the true end slot (nothing rolled back)', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)

      const rowC = screen.getByTestId('feature-row-C')
      const restore = mockRowRect(rowC, 100)
      try {
        fireDropAt(rowC, 118) // 18px into a 24px row -- bottom half
        expect(onMoveMarker).toHaveBeenCalledWith({ kind: 'end' })
      } finally {
        restore()
      }
    })

    // WO UI-14A-R1 (D1, UI-14A.audit.json findings[2]): the LIVE indicator
    // must agree with where the drop actually lands -- proven above at the
    // onDrop layer, but the audit's own finding is that the HOVER indicator
    // disagreed with it (always previewing "before this row" regardless of
    // half). These two tests drive dragOver (not drop) with a real clientY
    // and assert on the RENDERED indicator position, not just row identity.
    it('hovering the TOP half of the LAST row still shows the "before this row" indicator (existing behavior preserved)', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)

      const markerRow = screen.getByTestId('rollback-marker-row')
      fireEvent.dragStart(markerRow, { dataTransfer: dataTransferStub() })
      const rowC = screen.getByTestId('feature-row-C')
      const restore = mockRowRect(rowC, 100)
      try {
        fireDragOverAt(rowC, 106) // 6px into a 24px row -- top half
        expect(screen.getByTestId('marker-drag-indicator-C')).toBeTruthy()
        expect(screen.getByTestId('rollback-marker-trailing-dropzone').style.borderTop).toBe('2px solid transparent')
      } finally {
        restore()
      }
    })

    it('hovering the BOTTOM half of the LAST row shows the end-slot indicator BELOW the last row, never "before the last row" (the audit-caught disagreement)', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)

      const markerRow = screen.getByTestId('rollback-marker-row')
      fireEvent.dragStart(markerRow, { dataTransfer: dataTransferStub() })
      const rowC = screen.getByTestId('feature-row-C')
      const restore = mockRowRect(rowC, 100)
      try {
        fireDragOverAt(rowC, 118) // 18px into a 24px row -- bottom half
        // Fails-if the pre-fix behavior regresses: the "before C" bar must
        // NOT render once the pointer is in C's bottom half...
        expect(screen.queryByTestId('marker-drag-indicator-C')).toBeNull()
        // ...instead, the end-slot indicator (the trailing drop-zone's own
        // highlighted top border) renders BELOW the last row, matching
        // dropOnRow's actual slot=order.length resolution for this exact
        // hover position.
        expect(screen.getByTestId('rollback-marker-trailing-dropzone').style.borderTop).toBe('2px solid var(--status-outdated, #caa53d)')
      } finally {
        restore()
      }
    })

    it('dropping on the trailing drop-zone below the last row reaches the true end slot', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'after', nodeId: 'A' }, onMoveMarker }} />)

      fireEvent.drop(screen.getByTestId('rollback-marker-trailing-dropzone'))
      expect(onMoveMarker).toHaveBeenCalledWith({ kind: 'end' })
    })

    it('the trailing drop-zone ignores a feature-row (folder/reorder) drag payload -- never misread as a marker move', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'after', nodeId: 'A' }, onMoveMarker }} />)

      fireEvent.drop(screen.getByTestId('rollback-marker-trailing-dropzone'), { dataTransfer: dataTransferStub('B') })
      expect(onMoveMarker).not.toHaveBeenCalled()
    })

    it('dropping directly onto the marker-at-end row itself is a real drop target (mirrors dropOnRow, not a silent no-op)', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)

      fireEvent.drop(screen.getByTestId('rollback-marker-row'))
      expect(onMoveMarker).toHaveBeenCalledWith({ kind: 'end' })
    })
  })

  it('a row that is BOTH user-suppressed and rolled back shows the suppress glyph (suppression is the more specific state), but data-rolled-back still reports true', () => {
    const dag = chainDag()
    dag.setSuppressed('C', true)
    dag.setRollbackMarker({ kind: 'after', nodeId: 'A' }) // rolls back B and C too
    render(<FeatureTree dag={dag} />)

    const rowC = screen.getByTestId('feature-row-C')
    expect(rowC.dataset.suppressed).toBe('root')
    expect(rowC.dataset.rolledBack).toBe('true')
    expect(screen.getByTestId('feature-row-suppressed-glyph-C')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-rolledback-glyph-C')).toBeNull()
  })

  // WO UI-12 (BK-72 mission #3): the marker drag's own live insertion
  // indicator -- distinct from (and never confused with) UI-9's reorder
  // indicator.
  describe('marker drag insertion indicator (WO UI-12, BK-72)', () => {
    it('AC #2: during a marker drag, hovering row k renders the marker-specific indicator at k and the reorder indicator does NOT', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)

      const markerRow = screen.getByTestId('rollback-marker-row')
      fireEvent.dragStart(markerRow, { dataTransfer: dataTransferStub() })
      fireEvent.dragOver(screen.getByTestId('feature-row-B'), { dataTransfer: dataTransferStub() })

      expect(screen.getByTestId('marker-drag-indicator-B')).toBeTruthy()
      expect(screen.getByTestId('feature-row-B').dataset.reorderDrop).toBe('none')
      // Fails-if the indicator were gated on the wrong drag payload: it must
      // not render for a row NOT currently hovered.
      expect(screen.queryByTestId('marker-drag-indicator-A')).toBeNull()
    })

    it('AC #2: during a feature-row drag, the marker indicator never renders', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      const reorder = { checkReorder: () => null, onReorder: () => undefined }
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} reorder={reorder} />)

      fireEvent.dragStart(screen.getByTestId('feature-row-A'), { dataTransfer: dataTransferStub('A') })
      fireEvent.dragOver(screen.getByTestId('feature-row-B'), { dataTransfer: dataTransferStub('A') })

      expect(screen.queryByTestId('marker-drag-indicator-B')).toBeNull()
      // The reorder indicator DOES render for this drag (sanity check that
      // the two indicators are genuinely mutually exclusive, not both off).
      expect(screen.getByTestId('feature-row-B').dataset.reorderDrop).toBe('legal')
    })

    it('the indicator tracks row hover (moves as the drag crosses rows) and clears on drag end', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)
      const markerRow = screen.getByTestId('rollback-marker-row')
      fireEvent.dragStart(markerRow, { dataTransfer: dataTransferStub() })

      fireEvent.dragOver(screen.getByTestId('feature-row-A'), { dataTransfer: dataTransferStub() })
      expect(screen.getByTestId('marker-drag-indicator-A')).toBeTruthy()

      fireEvent.dragOver(screen.getByTestId('feature-row-C'), { dataTransfer: dataTransferStub() })
      expect(screen.queryByTestId('marker-drag-indicator-A')).toBeNull()
      expect(screen.getByTestId('marker-drag-indicator-C')).toBeTruthy()

      fireEvent.dragEnd(markerRow)
      expect(screen.queryByTestId('marker-drag-indicator-C')).toBeNull()
    })
  })

  // WO UI-12-R1 (Finding 2, minor, tests): the AC #2 tests above prove
  // marker-row STATE (markerDragging flips) and feature-row EXCLUSION (the
  // indicator gate), but that gate reads component-local React state, never
  // the DataTransfer payload itself -- so those tests would still pass even
  // if MarkerRow's onDragStart never called setData at all. The REAL payload
  // gate lives in draggedFeatureId (FeatureTree.tsx), which dropOnRow uses to
  // decide reorder-vs-marker-move on an actual drop; these tests exercise it
  // directly with the real 'rollback-marker' sentinel.
  describe('marker DataTransfer payload gate (WO UI-12-R1 Finding 2)', () => {
    it('MarkerRow onDragStart actually sets the "rollback-marker" sentinel on text/plain (recording stub, not just the markerDragging flag)', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      render(<FeatureTree dag={dag} rollback={{ marker: { kind: 'end' }, onMoveMarker }} />)

      const calls: Array<[string, string]> = []
      const recordingDataTransfer = {
        getData: () => '',
        setData: (type: string, value: string) => {
          calls.push([type, value])
        },
      }
      fireEvent.dragStart(screen.getByTestId('rollback-marker-row'), { dataTransfer: recordingDataTransfer })
      expect(calls).toContainEqual(['text/plain', 'rollback-marker'])
    })

    it('negative case: a non-marker (real feature-id) payload drops as a REORDER, never a marker move', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      const onReorder = vi.fn()
      render(
        <FeatureTree
          dag={dag}
          rollback={{ marker: { kind: 'end' }, onMoveMarker }}
          reorder={{ checkReorder: () => null, onReorder }}
        />,
      )

      fireEvent.drop(screen.getByTestId('feature-row-A'), { dataTransfer: dataTransferStub('B') })
      expect(onReorder).toHaveBeenCalledWith('B', 0)
      expect(onMoveMarker).not.toHaveBeenCalled()
    })

    it('positive case: the marker sentinel payload drops as a MARKER MOVE, never a reorder', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      const onReorder = vi.fn()
      render(
        <FeatureTree
          dag={dag}
          rollback={{ marker: { kind: 'end' }, onMoveMarker }}
          reorder={{ checkReorder: () => null, onReorder }}
        />,
      )

      fireEvent.drop(screen.getByTestId('feature-row-B'), { dataTransfer: dataTransferStub('rollback-marker') })
      expect(onReorder).not.toHaveBeenCalled()
      expect(onMoveMarker).toHaveBeenCalledWith({ kind: 'after', nodeId: 'A' })
    })

    it('positive case: no readable dragover data (empty payload) ALSO drops as a marker move, never a reorder', () => {
      const dag = chainDag()
      const onMoveMarker = vi.fn()
      const onReorder = vi.fn()
      render(
        <FeatureTree
          dag={dag}
          rollback={{ marker: { kind: 'end' }, onMoveMarker }}
          reorder={{ checkReorder: () => null, onReorder }}
        />,
      )

      fireEvent.drop(screen.getByTestId('feature-row-C'), { dataTransfer: dataTransferStub('') })
      expect(onReorder).not.toHaveBeenCalled()
      expect(onMoveMarker).toHaveBeenCalledWith({ kind: 'after', nodeId: 'B' })
    })
  })
})
