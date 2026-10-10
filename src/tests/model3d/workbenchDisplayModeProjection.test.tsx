// @vitest-environment jsdom
//
// WO UI-23 (C4): the display-mode flyout's new Perspective/Orthographic
// radio pair. Additive props (projection/onProjectionChange) -- omitting
// both must leave the flyout exactly as it shipped for UI-17 (no projection
// section at all), so existing callers/tests that don't pass them are
// unaffected.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { WorkbenchDisplayMode } from '../../components/model3d/workbench/WorkbenchDisplayMode'

afterEach(cleanup)

describe('WO UI-23 (C4): WorkbenchDisplayMode projection radios', () => {
  it('omitting projection/onProjectionChange renders NO projection section (backward compatible)', () => {
    const { getByTestId, queryByTestId } = render(
      <WorkbenchDisplayMode mode="shaded-edges" onModeChange={() => {}} />,
    )
    fireEvent.click(getByTestId('workbench-display-mode-btn'))
    expect(queryByTestId('workbench-projection-perspective')).toBeNull()
    expect(queryByTestId('workbench-projection-orthographic')).toBeNull()
  })

  it('with projection props, both radios render; the current mode is checked', () => {
    const { getByTestId } = render(
      <WorkbenchDisplayMode mode="shaded-edges" onModeChange={() => {}} projection="perspective" onProjectionChange={() => {}} />,
    )
    fireEvent.click(getByTestId('workbench-display-mode-btn'))
    const persp = getByTestId('workbench-projection-perspective') as HTMLInputElement
    const ortho = getByTestId('workbench-projection-orthographic') as HTMLInputElement
    expect(persp.checked).toBe(true)
    expect(ortho.checked).toBe(false)
  })

  it('clicking Orthographic calls onProjectionChange("orthographic") exactly once, without touching onModeChange', () => {
    const projectionCalls: string[] = []
    const modeCalls: string[] = []
    const { getByTestId } = render(
      <WorkbenchDisplayMode
        mode="shaded-edges"
        onModeChange={(m) => modeCalls.push(m)}
        projection="perspective"
        onProjectionChange={(p) => projectionCalls.push(p)}
      />,
    )
    fireEvent.click(getByTestId('workbench-display-mode-btn'))
    fireEvent.click(getByTestId('workbench-projection-orthographic'))
    expect(projectionCalls).toEqual(['orthographic'])
    expect(modeCalls).toEqual([])
  })
})
