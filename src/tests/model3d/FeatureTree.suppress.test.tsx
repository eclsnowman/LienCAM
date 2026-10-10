// @vitest-environment jsdom
//
// WO UI-6 (BK-39) acceptance criterion 5: suppressed row greyed w/ glyph;
// cascade-suppressed visually distinct from root-suppressed; render smoke
// test per state (the render-gate rule -- src/tests uses React Testing
// Library render(), never a store/test-harness proxy, for exactly this
// reason: a hooks-order or prop-plumbing bug only shows up on a real render).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

describe('FeatureTree suppress states (WO UI-6 acceptance #5)', () => {
  it('an unsuppressed row renders normally: data-suppressed="none", no suppress glyph', () => {
    const dag = chainDag()
    render(<FeatureTree dag={dag} />)
    const row = screen.getByTestId('feature-row-A')
    expect(row.dataset.suppressed).toBe('none')
    expect(screen.queryByTestId('feature-row-suppressed-glyph-A')).toBeNull()
  })

  it('root-suppressed: data-suppressed="root", suppress glyph rendered, row greyed', () => {
    const dag = chainDag()
    dag.setSuppressed('B', true)
    render(<FeatureTree dag={dag} />)

    const row = screen.getByTestId('feature-row-B')
    expect(row.dataset.suppressed).toBe('root')
    expect(row.style.opacity).toBe('0.5')
    expect(screen.getByTestId('feature-row-suppressed-glyph-B')).toBeTruthy()
    expect(screen.getByTestId('feature-row-suppressed-glyph-B').getAttribute('aria-label')).toBe('Suppressed')
    // Root suppression never says "(upstream suppressed)" -- that phrase is cascade-only.
    expect(row.textContent).not.toContain('upstream suppressed')
  })

  it('cascade-suppressed: data-suppressed="cascade", distinct from root, "(upstream suppressed)" label', () => {
    const dag = chainDag()
    dag.setSuppressed('B', true)
    render(<FeatureTree dag={dag} />)

    const row = screen.getByTestId('feature-row-C')
    expect(row.dataset.suppressed).toBe('cascade')
    expect(row.style.opacity).toBe('0.5')
    expect(screen.getByTestId('feature-row-suppressed-glyph-C').getAttribute('aria-label')).toBe('Suppressed (upstream)')
    expect(row.textContent).toContain('upstream suppressed')

    // A is upstream of the suppressed node B (B consumes A) -- untouched.
    expect(screen.getByTestId('feature-row-A').dataset.suppressed).toBe('none')
  })

  it('renders no suppress toggle button when the `suppress` prop is omitted (backward compatible), but glyphs/greying still render', () => {
    const dag = chainDag()
    dag.setSuppressed('B', true)
    render(<FeatureTree dag={dag} />)
    expect(screen.queryByTestId('feature-row-suppress-B')).toBeNull()
    expect(screen.getByTestId('feature-row-suppressed-glyph-B')).toBeTruthy()
  })

  it('the suppress toggle button reflects aria-pressed and calls onToggleSuppress with the row id, without triggering row selection', () => {
    const dag = chainDag()
    const onToggleSuppress = vi.fn()
    const onSelect = vi.fn()
    render(<FeatureTree dag={dag} onSelect={onSelect} suppress={{ onToggleSuppress }} />)

    const button = screen.getByTestId('feature-row-suppress-B')
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)
    expect(onToggleSuppress).toHaveBeenCalledWith('B')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('a cascade-suppressed row still exposes its own (false) toggle state -- toggling it sets its OWN root flag independently of the cascade', () => {
    const dag = chainDag()
    dag.setSuppressed('B', true)
    const onToggleSuppress = vi.fn()
    render(<FeatureTree dag={dag} suppress={{ onToggleSuppress }} />)

    const button = screen.getByTestId('feature-row-suppress-C')
    expect(button.getAttribute('aria-pressed')).toBe('false') // C's OWN flag is still false
    fireEvent.click(button)
    expect(onToggleSuppress).toHaveBeenCalledWith('C')
  })
})
