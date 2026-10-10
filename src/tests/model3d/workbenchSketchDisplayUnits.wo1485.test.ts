// @vitest-environment jsdom
//
// WO-1485: the Model-workbench sketch Measure follows the SAME display-units choice CAM does.
//
// DEFECT (on main): `workbenchSketchDocumentPort.getDisplayUnits()` hardcoded `'mm'`, so a
// Model-workbench circle's Measure readout showed `Radius 12.700 mm` (and Diameter/Circumference)
// even with Settings > Display units set to `in`. This file proves the readout now follows the live
// preference supplied through `SketchSessionDeps.getDisplayUnits`.
//
// It drives the REAL `WorkbenchToolRail` (the production caller of the port getter, whose handout
// of the value is `WorkbenchToolRail.tsx`'s `displayUnits={workbenchSketchDocumentPort
// .getDisplayUnits()}`) and asserts the rendered Measure readout, not a hand-built payload.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, act, cleanup, type RenderResult } from '@testing-library/react'

import { CommandHistory, FeatureDag, RegenScheduler, ElementMap } from '../../doc'
import { seedGenesisNodes, BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  workbenchSketchDocumentPort, __resetSketchDocumentPort,
} from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import { WorkbenchToolRail } from '../../components/model3d/workbench/WorkbenchToolRail'
import { sketcherToolStore } from '../../lib/sketch/sketcher'
import { useCamStore } from '../../store'
import type { Sketch } from '../../lib/sketch/sketcher'

const SKETCH_NODE_ID = 'sketch3d:s1'
const CIRCLE_RADIUS_MM = 12.7 // exactly 0.5 in

function circleSketch(): Sketch {
  return {
    id: 's1', layerId: 'workbench',
    entities: [
      { id: 'circle-1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: CIRCLE_RADIUS_MM },
    ],
    constraints: [], dimensions: [], solveStatus: null,
  }
}

let rendered: RenderResult | null = null

// A FRESH element each render: reusing one element object makes React bail out of re-rendering
// (same-element identity), which would mask whether the port getter is re-read.
const railElement = (): ReturnType<typeof createElement> => createElement(WorkbenchToolRail, {
  sketchActive: true,
  modelingSections: [],
  sketchHistoryTools: [],
  onFinishSketch: () => {},
})

function renderRail(): void {
  rendered = render(railElement())
}

beforeEach(() => {
  useCamStore.getState().setDisplayUnits('mm')
  sketcherToolStore.__reset()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()

  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  const history = new CommandHistory(dag)
  const scheduler = new RegenScheduler(dag, new ElementMap())
  dag.insertNode({
    id: SKETCH_NODE_ID, kind: 'sketch', consumes: [], refs: [],
    payload: { sketch: circleSketch(), externalRefs: [], dimensionDiagnostics: [] },
  }, dag.featureOrder().length)

  // The page's bindDeps shape, with the display-units source the page actually supplies: the shared
  // CAM store's live preference (presentation only; stored geometry stays mm).
  sketchSessionStore.bindDeps({
    dag, history, scheduler,
    getDisplayUnits: () => useCamStore.getState().appSettings.displayUnits,
    getGridSpacing: () => 25,
    wrapper: null,
    notice: () => {},
    onDocumentChanged: () => {},
    onHistoryStep: () => {},
  })
  sketchSessionStore.begin(SKETCH_NODE_ID, BASE_PLANE_FRAMES.xy, circleSketch())

  renderRail()
  // Open Measure through the real rail button, then select the circle through the real port.
  act(() => { document.querySelector<HTMLButtonElement>('[data-testid="workbench-package-measure"]')!.click() })
  act(() => { workbenchSketchDocumentPort.setSelection(['circle-1']) })
})

afterEach(() => {
  cleanup()
  rendered = null
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
  document.body.innerHTML = ''
})

describe('WO-1485: workbench sketch Measure honors display units', () => {
  it('the document port reads the live units off SketchSessionDeps (not a hardcoded mm)', () => {
    expect(workbenchSketchDocumentPort.getDisplayUnits()).toBe('mm')
    act(() => { useCamStore.getState().setDisplayUnits('inch') })
    expect(workbenchSketchDocumentPort.getDisplayUnits()).toBe('inch')
  })

  it('renders the circle Measure readout in inches and updates live when the preference changes', () => {
    const readout = (): string => screen.getByTestId('workbench-sketch-measure-readout').textContent ?? ''

    expect(readout()).toContain('12.700 mm')

    // The page re-renders on an appSettings.displayUnits change (SolidsWorkbenchPage subscribes to
    // it), which re-renders this rail; the port getter must then hand the readout the new units.
    act(() => { useCamStore.getState().setDisplayUnits('inch') })
    act(() => { rendered!.rerender(railElement()) })
    const inches = screen.getByTestId('workbench-sketch-measure-readout').textContent ?? ''
    expect(inches).toContain('0.5000 in')
    expect(inches).not.toContain('mm')
  })

  it('leaves canonical stored geometry in millimeters (presentation-only)', () => {
    act(() => { useCamStore.getState().setDisplayUnits('inch') })
    const stored = sketchSessionStore.getState().sketch
    const circle = stored?.entities.find((e) => e.id === 'circle-1')
    expect(circle?.kind === 'circle' ? circle.radius : null).toBe(CIRCLE_RADIUS_MM)
  })
})
