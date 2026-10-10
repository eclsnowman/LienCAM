// @vitest-environment jsdom
//
// WO SKC-16 (Operator hands-on findings B1/B2/B3): the workbench sketch rail's CAM-parity pack --
// SELECT+DELETE, CONSTRUCTION, and the CONSTRAINTS section -- proved through the REAL rail buttons
// driving the REAL shared engine (a real `Sketcher`, a real `FeatureDag`+`CommandHistory`, the real
// workbench ports, and a REAL planegcs solver). No store harness stands in for the button: every
// assertion below starts at a rendered rail button click and ends at `payload.sketch`.
//
// This is the jsdom half of the acceptance harness. The real-browser half (click/marquee select and
// dashed construction render, as PIXELS in real Chromium) is coordination/evidence/SKC-16/tools/
// capture.mjs.
//
// The engine wiring itself (Del/Backspace key, click/marquee pick, one-undo-step-per-gesture) is
// already owned by workbenchSketchMount.test.ts and the CAM sketcher's own suites; this file adds the
// three RAIL affordances SKC-15/UI-17 left off, and proves each drives that already-wired engine.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

import { Sketcher, sketcherToolStore } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import { planConstraintForSelection } from '../../lib/sketch/constraintActions'
import type { Sketch } from '../../lib/sketch/sketcher'
import type { GcsWrapper } from '@salusoft89/planegcs'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { CommandHistory, FeatureDag, RegenScheduler, ElementMap } from '../../doc'
import { seedGenesisNodes, BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  workbenchSketchDocumentPort, __resetSketchDocumentPort, syncSketchSessionFromDag,
} from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import {
  createWorkbenchSketcherHost, makePlaneFrameGroup,
} from '../../components/model3d/workbench/workbenchSketcherHost'
import { WorkbenchToolRail } from '../../components/model3d/workbench/WorkbenchToolRail'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'

const SKETCH_NODE_ID = 'sketch3d:s1'

// The real solver, booted once (wasm). Shared across the file exactly as the CAM constraintApply
// suite does; the whole point of the constraint assertions is a real solve.
let WRAPPER: GcsWrapper
beforeAll(async () => { WRAPPER = await createGcsWrapper() }, 60_000)

let restoreCanvas2d: (() => void) | null = null

function blankSketch(): Sketch {
  return { id: 's1', layerId: 'workbench', entities: [], constraints: [], dimensions: [], solveStatus: null }
}

interface Mount {
  sketcher: Sketcher
  canvas: HTMLCanvasElement
  dag: FeatureDag
  history: CommandHistory
  runtime: FakeSceneRuntime
  notices: Array<{ message: string; severity: string }>
}

/** The workbench mount as SolidsWorkbenchPage builds it, WITH a real solver bound, PLUS the real
 *  WorkbenchToolRail rendered in sketch mode -- so the rail's buttons and the sketcher's canvas share
 *  the one `sketchSessionStore` and every button click drives the live document. */
function mountRail(plane: 'xy' | 'xz' | 'yz' = 'xy'): Mount {
  const canvas = document.createElement('canvas')
  const container = document.createElement('div')
  container.appendChild(canvas)
  document.body.appendChild(container)

  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas.getBoundingClientRect = () => rect
  container.getBoundingClientRect = () => rect

  const runtime = createFakeSceneRuntime()
  const frame = BASE_PLANE_FRAMES[plane]
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const n = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z)
  cam.position.copy(new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)).addScaledVector(n, 100)
  cam.up.set(0, 0, 1)
  if (plane === 'xy') cam.up.set(0, 1, 0)
  cam.lookAt(frame.origin.x, frame.origin.y, frame.origin.z)
  cam.updateMatrixWorld(true)
  runtime.camera = cam

  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  const history = new CommandHistory(dag)
  const scheduler = new RegenScheduler(dag, new ElementMap())

  dag.insertNode({
    id: SKETCH_NODE_ID, kind: 'sketch', consumes: [], refs: [],
    payload: { sketch: blankSketch(), externalRefs: [], dimensionDiagnostics: [] },
  }, dag.featureOrder().length)

  const notices: Array<{ message: string; severity: string }> = []
  const sketcher = new Sketcher(createWorkbenchSketcherHost({
    canvas, container, runtime, overlayRoot: makePlaneFrameGroup(frame), getFrame: () => frame,
  }))
  sketchSessionStore.bindDeps({
    dag, history, scheduler,
    wrapper: WRAPPER,
    notice: (message, severity) => { notices.push({ message, severity }) },
    // Keep the package layer's mirror of the document current, exactly as the page's mount effect
    // does -- so a solve/commit is reflected back for the next pick/preview.
    onDocumentChanged: () => { sketcher.updateSketch(sketchSessionStore.getState().sketch) },
    onHistoryStep: () => {},
  })

  sketcher.setDocumentPort(workbenchSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => { workbenchSketchDocumentPort.beginStep() } })
  sketchSessionStore.begin(SKETCH_NODE_ID, frame, blankSketch())
  sketcher.enter()
  sketcher.updateSketch(sketchSessionStore.getState().sketch)

  render(
    <WorkbenchToolRail
      sketchActive
      modelingSections={[]}
      sketchHistoryTools={[]}
      onFinishSketch={() => {}}
    />,
  )

  return { sketcher, canvas, dag, history, runtime, notices }
}

function pointer(target: EventTarget, type: string, x: number, y: number, button = 0): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button }))
}

function payloadSketch(m: Mount): Sketch {
  return m.dag.getNode(SKETCH_NODE_ID)!.payload.sketch as Sketch
}

/** Arm a sketch tool through its RAIL button (real UI), not the engine directly. */
function armViaRail(id: string): void {
  fireEvent.click(screen.getByTestId(`workbench-package-tool-${id}`))
}

/** Draw one line between two screen points, then end the chain -- a standalone line entity. Every
 *  store-mutating dispatch is inside act(), so the rendered rail re-renders to the new document
 *  (a stale-DOM disabled button would silently swallow the next click). */
function drawLine(m: Mount, a: { x: number; y: number }, b: { x: number; y: number }): void {
  armViaRail('line')
  act(() => {
    pointer(m.canvas, 'pointerdown', a.x, a.y); pointer(m.canvas, 'pointerup', a.x, a.y)
    pointer(m.canvas, 'pointerdown', b.x, b.y); pointer(m.canvas, 'pointerup', b.x, b.y)
    m.sketcher.updateSketch(sketchSessionStore.getState().sketch)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

/** Set the sketch-scoped selection through the real port, flushing the rail's re-render so button
 *  enabled-state (which reads the live selection) is current before the next assertion/click. */
function select(ids: string[]): void {
  act(() => { workbenchSketchDocumentPort.setSelection(ids) })
}

let M: Mount

beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
})
afterEach(() => {
  cleanup()
  M?.sketcher.dispose()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  document.body.innerHTML = ''
})

// ---- B2: SELECT + DELETE -----------------------------------------------------------------------

describe('SKC-26B: Utility owns the one workbench Project / Use rail action', () => {
  it('renders exactly one Project / Use button under Utility and arms the shared project tool id', () => {
    M = mountRail()
    const utility = screen.getByTestId('workbench-rail-section-utility')
    const projectButtons = screen.getAllByTestId('workbench-package-tool-project')
    expect(projectButtons).toHaveLength(1)
    expect(utility.contains(projectButtons[0])).toBe(true)
    expect(projectButtons[0].textContent).toContain('Project / Use')
    expect(projectButtons[0].getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(projectButtons[0])
    expect(sketcherToolStore.getState().tool).toBe('project')
    expect(projectButtons[0].getAttribute('aria-pressed')).toBe('true')
  })

  it('routes I through the real Model SketchInteraction and keeps suspended/repeated/guarded keys inert', () => {
    M = mountRail()
    const measured: Sketch = {
      ...blankSketch(),
      entities: [{
        id: 'measure-line',
        kind: 'line',
        construction: false,
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 },
      }],
    }
    act(() => {
      sketchSessionStore.setState({ sketch: measured, selectedIds: ['measure-line'] })
    })

    const measure = screen.getByTestId('workbench-package-measure')
    expect(measure.getAttribute('aria-pressed')).toBe('false')
    expect(measure.getAttribute('data-tooltip')).toContain('(I)')
    expect(screen.queryByTestId('workbench-sketch-measure-readout')).toBeNull()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'I', bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('workbench-sketch-measure-readout').textContent).toContain('Line')

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', repeat: true, bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('true')

    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', bubbles: true, cancelable: true,
      }))
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', ctrlKey: true, bubbles: true, cancelable: true,
      }))
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', altKey: true, bubbles: true, cancelable: true,
      }))
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', metaKey: true, bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('true')

    // Suspend preserves this live session's UI state but removes its listener.
    act(() => { M.sketcher.suspend() })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('true')

    act(() => { M.sketcher.resume() })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('workbench-sketch-measure-readout')).toBeNull()
  })

  it('derives Model tool hints for every new shortcut from the shared map', () => {
    M = mountRail()
    expect(screen.getByTestId('workbench-package-tool-extend').getAttribute('data-tooltip')).toBe('Extend (E)')
    expect(screen.getByTestId('workbench-package-tool-fillet').getAttribute('data-tooltip')).toBe('Fillet (F)')
    expect(screen.getByTestId('workbench-package-tool-chamfer').getAttribute('data-tooltip')).toBe('Chamfer (H)')
    expect(screen.getByTestId('workbench-package-tool-pattern-linear').getAttribute('data-tooltip')).toBe('Linear Pat. (1)')
    expect(screen.getByTestId('workbench-package-tool-pattern-circular').getAttribute('data-tooltip')).toBe('Circular Pat. (2)')
  })
})

describe('WO SKC-16 B2: the rail Delete action removes the selection, and undo restores it', () => {
  it('the Delete button is disabled with no selection and enabled once entities are selected', () => {
    M = mountRail()
    drawLine(M, { x: 350, y: 300 }, { x: 450, y: 300 })
    const del = () => screen.getByTestId('workbench-package-delete') as HTMLButtonElement

    // No selection -> disabled (CAM parity: "Delete - select entities first").
    expect(del().disabled).toBe(true)

    const id = payloadSketch(M).entities[0].id
    select([id])
    // FAILS-IF the rail does not read the live selection: the button would stay disabled.
    expect(del().disabled).toBe(false)
  })

  it('clicking Delete removes exactly the selected entities (cascading refs), and history.undo restores them', () => {
    M = mountRail()
    // Three standalone lines.
    drawLine(M, { x: 340, y: 280 }, { x: 440, y: 280 })
    drawLine(M, { x: 340, y: 320 }, { x: 440, y: 320 })
    drawLine(M, { x: 340, y: 360 }, { x: 440, y: 360 })
    const ids = payloadSketch(M).entities.map((e) => e.id)
    expect(ids).toHaveLength(3)

    // Select two, click the RAIL Delete button.
    select([ids[0], ids[1]])
    fireEvent.click(screen.getByTestId('workbench-package-delete'))

    const after = payloadSketch(M).entities.map((e) => e.id)
    // FAILS-IF the button is not wired to deleteSelection: nothing would be removed.
    expect(after).toEqual([ids[2]])

    // One undo step restores all three (the delete owns exactly one CommandHistory step).
    expect(M.history.canUndo()).toBe(true)
    M.history.undo()
    syncSketchSessionFromDag()
    expect(payloadSketch(M).entities.map((e) => e.id).sort()).toEqual([...ids].sort())
  })
})

// ---- B3: CONSTRUCTION --------------------------------------------------------------------------

describe('WO SKC-16 B3: the rail Construction button toggles draw-mode and flips selected entities', () => {
  it('with NO selection it toggles draw-as-construction MODE (lit while on)', () => {
    M = mountRail()
    const btn = () => screen.getByTestId('workbench-package-construction') as HTMLButtonElement

    expect(btn().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn())
    // FAILS-IF the button is not wired to sketcherTools.toggleConstruction.
    expect(sketcherToolStore.getState().constructionMode).toBe(true)
    expect(btn().getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(btn())
    expect(sketcherToolStore.getState().constructionMode).toBe(false)
  })

  it('with a selection it flips THOSE entities to construction (no draw-mode change)', () => {
    M = mountRail()
    drawLine(M, { x: 350, y: 300 }, { x: 450, y: 300 })
    const id = payloadSketch(M).entities[0].id
    expect((payloadSketch(M).entities[0] as { construction: boolean }).construction).toBe(false)

    select([id])
    fireEvent.click(screen.getByTestId('workbench-package-construction'))

    // The selected entity flipped; the draw MODE did NOT (the selection path wins).
    expect((payloadSketch(M).entities[0] as { construction: boolean }).construction).toBe(true)
    expect(sketcherToolStore.getState().constructionMode).toBe(false)
    // Flipping back is one more click.
    fireEvent.click(screen.getByTestId('workbench-package-construction'))
    expect((payloadSketch(M).entities[0] as { construction: boolean }).construction).toBe(false)
  })
})

// ---- B1: CONSTRAINTS ---------------------------------------------------------------------------

describe('WO SKC-16 B1: the CONSTRAINTS rail section drives the shared engine, gated by planConstraintForSelection', () => {
  it('applying Horizontal from the rail solves the geometry horizontal -- the SAME engine outcome as the CAM route', () => {
    M = mountRail()
    // A single clearly non-horizontal line.
    drawLine(M, { x: 340, y: 280 }, { x: 460, y: 340 })
    const line0 = payloadSketch(M).entities[0]
    expect(line0.kind).toBe('line')
    const before = line0 as Extract<Sketch['entities'][number], { kind: 'line' }>
    expect(Math.abs(before.start.y - before.end.y)).toBeGreaterThan(1e-3) // genuinely slanted

    select([before.id])
    // The button is enabled iff planConstraintForSelection says so -- assert the rail agrees.
    const hBtn = screen.getByTestId('workbench-package-constraint-horizontal') as HTMLButtonElement
    expect(hBtn.disabled).toBe(false)
    fireEvent.click(hBtn)

    const s = payloadSketch(M)
    // One horizontal constraint stood...
    expect(s.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(1)
    // ...and the REAL solver made the line horizontal (the CAM parity assertion, constraintApply.test.ts:250).
    const after = s.entities.find((e) => e.id === before.id) as Extract<Sketch['entities'][number], { kind: 'line' }>
    expect(after.start.y).toBeCloseTo(after.end.y, 6)
  })

  it('button enable/disable tracks planConstraintForSelection exactly (parallel needs two lines; fix needs any entity)', () => {
    M = mountRail()
    drawLine(M, { x: 340, y: 280 }, { x: 440, y: 285 })
    drawLine(M, { x: 340, y: 340 }, { x: 440, y: 345 })
    const [a, b] = payloadSketch(M).entities.map((e) => e.id)

    const disabled = (kind: string) => (screen.getByTestId(`workbench-package-constraint-${kind}`) as HTMLButtonElement).disabled

    // No selection: everything is disabled (nothing is a valid operand set).
    select([])
    for (const kind of ['parallel', 'horizontal', 'coincident', 'fix', 'tangent']) {
      expect(disabled(kind), `${kind} with empty selection`).toBe(true)
      // ...and that is EXACTLY what the planner says.
      expect(planConstraintForSelection(payloadSketch(M), [], kind as never).ok).toBe(false)
    }

    // One line: fix + horizontal valid; parallel/coincident/tangent not.
    select([a])
    expect(disabled('fix')).toBe(false)
    expect(disabled('horizontal')).toBe(false)
    expect(disabled('parallel')).toBe(true)
    expect(disabled('coincident')).toBe(true)

    // Two lines: parallel becomes valid; coincident (needs 2 points) still not.
    select([a, b])
    expect(disabled('parallel')).toBe(false)
    expect(disabled('coincident')).toBe(true)
    // The rail's disabled map matches the planner for every button, both directions.
    for (const kind of ['parallel', 'horizontal', 'coincident', 'fix', 'tangent', 'equal', 'perpendicular']) {
      const planned = planConstraintForSelection(payloadSketch(M), [a, b], kind as never).ok
      expect(disabled(kind), `${kind} rail vs planner`).toBe(!planned)
    }
  })

  it('an ineligible selection cannot be applied from the rail (the button refuses by staying disabled)', () => {
    M = mountRail()
    drawLine(M, { x: 340, y: 280 }, { x: 460, y: 340 })
    const id = payloadSketch(M).entities[0].id
    // A single line is not a valid Parallel operand set.
    select([id])
    const pBtn = screen.getByTestId('workbench-package-constraint-parallel') as HTMLButtonElement
    expect(pBtn.disabled).toBe(true)
    // A disabled button dispatches no click; the document is untouched.
    fireEvent.click(pBtn)
    expect(payloadSketch(M).constraints).toHaveLength(0)
  })
})
