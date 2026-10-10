// @vitest-environment jsdom
//
// The display flyout's curvature settings (stage 47): the measure (how tight / Gaussian) and the range (flat and
// tight radii), for every body at once; the legend follows; each change asks the scene for a render.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkbenchDisplayMode } from '../../components/model3d/workbench/WorkbenchDisplayMode'
import { CURVATURE_FLAT_MM, CURVATURE_TIGHT_MM, curvatureDisplay, setCurvatureDisplay } from '../../lib/viewport/lighting/zebra'

afterEach(() => { cleanup(); setCurvatureDisplay({ mode: 'curvedness', flatMm: CURVATURE_FLAT_MM, tightMm: CURVATURE_TIGHT_MM }) })
const mount = (onSettings = vi.fn()) => {
  render(<WorkbenchDisplayMode mode="shaded-edges" onModeChange={() => {}} curvature onCurvatureChange={() => {}} onCurvatureSettingsChange={onSettings} />)
  fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
  return onSettings
}
const legend = () => screen.getByTestId('workbench-curvature-legend').textContent ?? ''

describe('curvature settings in the display flyout', () => {
  it('Gaussian: the measure changes for every body, the legend reads saddle / flat / dome, a render is asked', () => {
    const onSettings = mount()
    expect(legend()).toContain('200+')
    fireEvent.click(screen.getByTestId('workbench-curvature-mode-gaussian'))
    expect(curvatureDisplay().mode).toBe('gaussian')
    expect(legend()).toContain('flat / ruled')
    expect(legend()).toContain('saddle 3-')
    expect(onSettings).toHaveBeenCalledTimes(1)
  })

  it('the range: typed radii move the legend; the wrong way round comes back swapped', () => {
    const onSettings = mount()
    const flat = screen.getByTestId('workbench-curvature-flat') as HTMLInputElement
    fireEvent.change(flat, { target: { value: '50' } })
    fireEvent.blur(flat)
    expect(curvatureDisplay()).toMatchObject({ flatMm: 50, tightMm: 3 })
    expect(legend()).toContain('50+')
    const tight = screen.getByTestId('workbench-curvature-tight') as HTMLInputElement
    fireEvent.change(tight, { target: { value: '80' } })
    fireEvent.blur(tight)
    expect(curvatureDisplay()).toMatchObject({ flatMm: 80, tightMm: 50 })
    expect((screen.getByTestId('workbench-curvature-flat') as HTMLInputElement).value).toBe('80')
    expect(onSettings).toHaveBeenCalledTimes(2)
  })
})
