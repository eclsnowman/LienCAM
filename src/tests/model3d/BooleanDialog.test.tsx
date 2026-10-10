// @vitest-environment jsdom
//
// WO INT-4A: BooleanDialog render/behavior test (DAG + CommandHistory only).
// Proves Apply inserts a 'feature' node consuming BOTH input bodies with the
// chosen op, Apply is disabled while target === tool, and undo removes it.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { useState } from 'react'
import { BooleanDialog } from '../../components/model3d/dialogs'
import type { BooleanBodyPickRole } from '../../components/model3d/dialogs/BooleanDialog'
import { CommandHistory, FeatureDag } from '../../doc'

afterEach(cleanup)

function setupWithBodies() {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Extrude F1' } })
  dag.insertNode({ id: 'F2', kind: 'feature', payload: { opType: 'revolve', name: 'Revolve F2' } })
  const history = new CommandHistory(dag)
  return { dag, history }
}

describe('BooleanDialog (WO INT-4A)', () => {
  it('inserts a feature node consuming both bodies with the chosen op, undo removes it', () => {
    const { dag, history } = setupWithBodies()
    let applied: string | null = null
    render(
      <BooleanDialog
        dag={dag}
        history={history}
        mode="create"
        bodyOptions={[{ id: 'F1', label: 'Extrude F1' }, { id: 'F2', label: 'Revolve F2' }]}
        onApplied={(id) => (applied = id)}
        onClose={() => {}}
      />,
    )

    fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'intersect' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(applied).toBe('F3')
    const node = dag.getNode('F3')
    expect(node?.consumes?.slice().sort()).toEqual(['F1', 'F2'])
    expect(node?.payload).toMatchObject({ opType: 'boolean', targetFeatureId: 'F1', toolFeatureId: 'F2', boolOp: 'intersect' })

    expect(history.undo()).toBe(true)
    expect(dag.has('F3')).toBe(false)
  })

  it('disables Apply when target and tool are the same body', () => {
    const { dag, history } = setupWithBodies()
    render(
      <BooleanDialog dag={dag} history={history} mode="create" bodyOptions={[{ id: 'F1', label: 'Extrude F1' }]} onApplied={() => {}} onClose={() => {}} />,
    )
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers Union, Subtract, and Intersect as selectable operations', () => {
    const { dag, history } = setupWithBodies()
    render(
      <BooleanDialog
        dag={dag}
        history={history}
        mode="create"
        bodyOptions={[{ id: 'F1', label: 'Extrude F1' }, { id: 'F2', label: 'Revolve F2' }]}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    expect((screen.getByTestId('boolean-op-option-fuse') as HTMLOptionElement).disabled).toBe(false)
    expect((screen.getByTestId('boolean-op-option-intersect') as HTMLOptionElement).disabled).toBe(false)
    expect((screen.getByTestId('boolean-op-option-cut') as HTMLOptionElement).disabled).toBe(false)
  })

  it('WO-1497 presents as a draggable floating palette so it can be moved off the bodies it covers', () => {
    const { dag, history } = setupWithBodies()
    render(
      <BooleanDialog
        dag={dag}
        history={history}
        mode="create"
        bodyOptions={[{ id: 'F1', label: 'Extrude F1' }, { id: 'F2', label: 'Revolve F2' }]}
        onRequestBodyPick={() => {}}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )

    const panel = screen.getByTestId('dialog-shell')
    expect(panel.getAttribute('data-presentation')).toBe('floating-palette')

    const header = panel.querySelector('.modal-header')
    if (header === null) throw new Error('expected Boolean dialog header')
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const getBoundingClientRect = panel.getBoundingClientRect
    panel.getBoundingClientRect = () => ({
      x: 288,
      y: 76,
      width: 320,
      height: 420,
      top: 76,
      right: 608,
      bottom: 496,
      left: 288,
      toJSON: () => ({}),
    }) as DOMRect

    try {
      fireEvent.pointerDown(header, { pointerId: 9, clientX: 312, clientY: 100 })
      fireEvent.pointerMove(window, { pointerId: 9, clientX: 612, clientY: 260 })
      fireEvent.pointerUp(window, { pointerId: 9 })
      expect(panel.style.left).toBe('588px')
      expect(panel.style.top).toBe('236px')
    } finally {
      panel.getBoundingClientRect = getBoundingClientRect
      if (innerWidth === undefined) delete (window as { innerWidth?: number }).innerWidth
      else Object.defineProperty(window, 'innerWidth', innerWidth)
      if (innerHeight === undefined) delete (window as { innerHeight?: number }).innerHeight
      else Object.defineProperty(window, 'innerHeight', innerHeight)
    }
  })

  it('UI-65/UI-87 auto-arms target, advances to tool, and keeps list fallback synchronized', () => {
    const { dag, history } = setupWithBodies()
    const requests: Array<{
      role: BooleanBodyPickRole
      excludedIds: readonly string[]
      onPicked: (featureId: string) => void
    }> = []
    function BooleanPickerHarness() {
      const [activeBodyPickRole, setActiveBodyPickRole] = useState<BooleanBodyPickRole | null>(null)
      return (
        <BooleanDialog
          dag={dag}
          history={history}
          mode="create"
          bodyOptions={[{ id: 'F1', label: 'Extrude F1' }, { id: 'F2', label: 'Revolve F2' }]}
          activeBodyPickRole={activeBodyPickRole}
          onRequestBodyPick={(role, excludedIds, onPicked) => {
            setActiveBodyPickRole(role)
            requests.push({
              role,
              excludedIds,
              onPicked: (featureId) => {
                setActiveBodyPickRole(null)
                onPicked(featureId)
              },
            })
          }}
          onApplied={() => {}}
          onClose={() => {}}
        />
      )
    }

    render(<BooleanPickerHarness />)

    expect(screen.getByTestId('dialog-shell-backdrop').className).toContain('modal-backdrop-transparent')
    expect(requests[0]).toMatchObject({ role: 'target', excludedIds: [] })
    expect(screen.getByTestId('boolean-pick-role').textContent).toContain('TARGET')

    act(() => requests[0].onPicked('F2'))
    expect(requests[1]).toMatchObject({ role: 'tool', excludedIds: ['F2'] })
    expect(screen.getByTestId('boolean-pick-role').textContent).toContain('TOOL')
    act(() => requests[1].onPicked('F1'))

    expect((screen.getByTestId('boolean-target-select') as HTMLSelectElement).value).toBe('F2')
    expect((screen.getByTestId('boolean-tool-select') as HTMLSelectElement).value).toBe('F1')
    expect(screen.getByTestId('boolean-pick-status').textContent).toContain('Target: Revolve F2')
    expect(screen.getByTestId('boolean-pick-status').textContent).toContain('Tool: Extrude F1')
  })
})
