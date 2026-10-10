// @vitest-environment jsdom
//
// WO UI-4 acceptance #4: FeatureTree's optional per-row hide/isolate
// controls -- additive, only rendered for 'body'-kind nodes, tree state
// reflects the viewport (isBodyVisible/isIsolated) and drives it
// (onToggleVisible/onIsolate) both ways.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeatureTree } from '../../components/model3d/tree'
import { FeatureDag } from '../../doc'

afterEach(cleanup)

describe('FeatureTree visibility controls (WO UI-4 acceptance #4)', () => {
  it('renders no visibility controls when the prop is omitted (fully backward compatible)', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'B1', kind: 'body', payload: { name: 'Body 1' } })
    render(<FeatureTree dag={dag} />)
    expect(screen.queryByTestId('feature-row-visible-B1')).toBeNull()
  })

  it('renders hide/isolate controls only for body-kind rows, reflecting live visibility state', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'B1', kind: 'body', payload: { name: 'Body 1' } })
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { name: 'Feature 1' } })

    const onToggleVisible = vi.fn()
    const onIsolate = vi.fn()
    render(
      <FeatureTree
        dag={dag}
        visibility={{
          isBodyVisible: (id) => id !== 'B1', // start hidden, to prove the icon reflects state
          isIsolated: () => false,
          onToggleVisible,
          onIsolate,
        }}
      />,
    )

    expect(screen.getByTestId('feature-row-visible-B1')).toBeTruthy()
    expect(screen.getByTestId('feature-row-isolate-B1')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-visible-F1')).toBeNull()

    fireEvent.click(screen.getByTestId('feature-row-visible-B1'))
    expect(onToggleVisible).toHaveBeenCalledWith('B1')

    fireEvent.click(screen.getByTestId('feature-row-isolate-B1'))
    expect(onIsolate).toHaveBeenCalledWith('B1')
  })

  it('clicking a visibility control does not also trigger row selection (stopPropagation)', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'B1', kind: 'body', payload: { name: 'Body 1' } })
    const onSelect = vi.fn()
    render(
      <FeatureTree
        dag={dag}
        onSelect={onSelect}
        visibility={{ isBodyVisible: () => true, isIsolated: () => false, onToggleVisible: () => {}, onIsolate: () => {} }}
      />,
    )
    fireEvent.click(screen.getByTestId('feature-row-visible-B1'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
