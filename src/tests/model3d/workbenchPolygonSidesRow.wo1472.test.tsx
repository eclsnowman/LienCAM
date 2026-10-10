// @vitest-environment jsdom
//
// WO-1472: the Model workbench's copied sketch rail arms the SAME polygon
// tool as the Sketch workspace through the shared useSketcherTool/
// sketcherTools engine (WorkbenchToolRail.tsx's own header calls it "the
// ALREADY-SHARED sketcherTools/useSketcherTool engine"), but never rendered
// the side-count + inscribed/circumscribed row SketchToolbox.tsx's
// PolygonSidesRow provides -- so a Model workbench polygon always used
// whatever side count the shared store last held, with no rail control.
//
// This proves the rail renders that row while its own polygon tool is
// armed, and that editing it drives the SAME sketcherToolStore SketchToolbox
// reads/writes -- FAILS on main (no row, so no `polygon-mode`/sides input
// exists under the rail) before the fix.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react'

import { sketcherToolStore, sketcherTools } from '../../lib/sketch/sketcher'
import { WorkbenchToolRail } from '../../components/model3d/workbench/WorkbenchToolRail'

const noop = () => {}

afterEach(() => {
  cleanup()
  sketcherToolStore.__reset()
})

function mountModelingRail() {
  render(
    <WorkbenchToolRail
      sketchActive
      modelingSections={[]}
      sketchHistoryTools={[]}
      onFinishSketch={noop}
    />,
  )
}

describe('WO-1472: the Model workbench rail carries the Polygon side-count + mode row', () => {
  it('renders no polygon row while the polygon tool is not armed', () => {
    mountModelingRail()
    expect(screen.queryByTestId('polygon-mode')).toBeNull()
  })

  it('arming Polygon from the rail reveals the Sides + Mode controls', () => {
    mountModelingRail()
    fireEvent.click(screen.getByTestId('workbench-package-tool-polygon'))
    expect(sketcherToolStore.getState().tool).toBe('polygon')
    expect(screen.getByTestId('polygon-mode')).toBeTruthy()
  })

  it('editing Sides/Mode in the rail writes the SAME shared sketcherToolStore SketchToolbox reads', () => {
    mountModelingRail()
    fireEvent.click(screen.getByTestId('workbench-package-tool-polygon'))
    expect(sketcherToolStore.getState().polygonSides).toBe(6)
    expect(sketcherToolStore.getState().polygonMode).toBe('inscribed')

    const sidesInput = screen.getByTestId('polygon-mode').closest('.sketch-snap-settings')!
      .querySelector('input') as HTMLInputElement
    fireEvent.change(sidesInput, { target: { value: '5' } })
    fireEvent.blur(sidesInput)
    // FAILS-IF the rail row is not wired to sketcherTools.setPolygonSides.
    expect(sketcherToolStore.getState().polygonSides).toBe(5)

    fireEvent.change(screen.getByTestId('polygon-mode'), { target: { value: 'circumscribed' } })
    // FAILS-IF the rail row is not wired to sketcherTools.setPolygonMode.
    expect(sketcherToolStore.getState().polygonMode).toBe('circumscribed')
  })

  it('disarming Polygon (Esc) hides the row again', () => {
    mountModelingRail()
    fireEvent.click(screen.getByTestId('workbench-package-tool-polygon'))
    expect(screen.getByTestId('polygon-mode')).toBeTruthy()
    act(() => { sketcherTools.armTool('select') })
    expect(screen.queryByTestId('polygon-mode')).toBeNull()
  })
})
