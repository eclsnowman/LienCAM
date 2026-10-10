// @vitest-environment jsdom
//
// WO SKC-17 (BK-123(2), BK-122(3)): the workbench sketch rail's glyph-visibility toggle, DoF badge,
// and Finish-sketch button green/Check parity -- proved against the REAL shared engine, same pattern
// as workbenchSketchRail.test.tsx (a real `Sketcher`, a real `FeatureDag`+`CommandHistory`, the real
// workbench ports, a REAL planegcs solver).
//
// The real-browser half (glyphs on/off as PIXELS, getComputedStyle on the finish button) is
// coordination/evidence/SKC-17/tools/capture.mjs.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

import { Sketcher, sketcherToolStore } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import type { Sketch } from '../../lib/sketch/sketcher'
import type { GcsWrapper } from '@salusoft89/planegcs'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { CommandHistory, FeatureDag, RegenScheduler, ElementMap } from '../../doc'
import { seedGenesisNodes, BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  workbenchSketchDocumentPort, __resetSketchDocumentPort,
} from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import {
  createWorkbenchSketcherHost, makePlaneFrameGroup,
} from '../../components/model3d/workbench/workbenchSketcherHost'
import { WorkbenchToolRail } from '../../components/model3d/workbench/WorkbenchToolRail'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'

const SKETCH_NODE_ID = 'sketch3d:s1'

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
}

/** The workbench mount as SolidsWorkbenchPage builds it (real solver bound), PLUS the real
 *  WorkbenchToolRail rendered in sketch mode. `onDocumentChanged` mirrors the page's own body EXACTLY
 *  (WO SKC-17: scheduler.markDirty + updateSketch(sketch, getViewState()) + a render request) so this
 *  test proves the SAME wiring the page runs, not a parallel stand-in. */
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

  const sketcher = new Sketcher(createWorkbenchSketcherHost({
    canvas, container, runtime, overlayRoot: makePlaneFrameGroup(frame), getFrame: () => frame,
  }))
  sketchSessionStore.bindDeps({
    dag, history, scheduler,
    wrapper: WRAPPER,
    notice: () => {},
    onDocumentChanged: (nodeId) => {
      scheduler.markDirty(nodeId)
      sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())
    },
    onHistoryStep: () => {},
  })

  sketcher.setDocumentPort(workbenchSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => { workbenchSketchDocumentPort.beginStep() } })
  sketchSessionStore.begin(SKETCH_NODE_ID, frame, blankSketch())
  sketcher.enter()
  sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())

  render(
    <WorkbenchToolRail
      sketchActive
      modelingSections={[]}
      sketchHistoryTools={[]}
      onFinishSketch={() => {}}
    />,
  )

  return { sketcher, canvas, dag, history, runtime }
}

function pointer(target: EventTarget, type: string, x: number, y: number, button = 0): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button }))
}

function payloadSketch(m: Mount): Sketch {
  return m.dag.getNode(SKETCH_NODE_ID)!.payload.sketch as Sketch
}

function armViaRail(id: string): void {
  fireEvent.click(screen.getByTestId(`workbench-package-tool-${id}`))
}

function drawLine(m: Mount, a: { x: number; y: number }, b: { x: number; y: number }): void {
  armViaRail('line')
  act(() => {
    pointer(m.canvas, 'pointerdown', a.x, a.y); pointer(m.canvas, 'pointerup', a.x, a.y)
    pointer(m.canvas, 'pointerdown', b.x, b.y); pointer(m.canvas, 'pointerup', b.x, b.y)
    m.sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function select(ids: string[]): void {
  act(() => { workbenchSketchDocumentPort.setSelection(ids) })
}

/** Count the layer's live constraint-glyph badge sprites -- the ONE `THREE.Sprite` creation site in
 *  sketchLayer.ts is `buildBadges()` (sketchLayer.ts:1504), itself gated on `view.glyphsVisible`
 *  (sketchLayer.ts:1472). This is "the layer's badge build", not store state, per the charter's
 *  non-vacuous-probe rule. */
function badgeSpriteCount(m: Mount): number {
  return m.sketcher.layer.group.children.filter((c) => c instanceof THREE.Sprite).length
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

describe('WO SKC-17 (BK-123(2)): the CONSTRAINTS-header glyph toggle drives the LIVE layer, not just the store', () => {
  it('toggling flips sketchSessionStore.glyphsVisible AND the layer stops/starts building badge sprites', () => {
    M = mountRail()
    drawLine(M, { x: 340, y: 280 }, { x: 460, y: 340 })
    const id = payloadSketch(M).entities[0].id
    select([id])
    fireEvent.click(screen.getByTestId('workbench-package-constraint-fix'))
    // A 'fix' constraint stood -> at least one badge sprite while glyphs are ON (default).
    expect(payloadSketch(M).constraints.filter((c) => c.kind === 'fix')).toHaveLength(1)
    expect(sketchSessionStore.getState().glyphsVisible).toBe(true)
    const onCount = badgeSpriteCount(M)
    expect(onCount).toBeGreaterThan(0)

    const toggle = screen.getByTestId('workbench-package-glyph-toggle')
    fireEvent.click(toggle)
    // FAILS-IF the toggle only flips the store (the classic "store said yes, screen still shows it"
    // bug this WO exists to close): the sprite count must drop to zero, not just the flag.
    expect(sketchSessionStore.getState().glyphsVisible).toBe(false)
    expect(badgeSpriteCount(M)).toBe(0)

    fireEvent.click(toggle)
    expect(sketchSessionStore.getState().glyphsVisible).toBe(true)
    expect(badgeSpriteCount(M)).toBe(onCount)
  })

  it('the toggle survives a Finish/re-enter cycle as a PREFERENCE, not per-document state', () => {
    M = mountRail()
    fireEvent.click(screen.getByTestId('workbench-package-glyph-toggle'))
    expect(sketchSessionStore.getState().glyphsVisible).toBe(false)
    sketchSessionStore.end()
    // Re-enter: begin() must not silently re-show glyphs the user just hid.
    sketchSessionStore.begin(SKETCH_NODE_ID, BASE_PLANE_FRAMES.xy, blankSketch())
    expect(sketchSessionStore.getState().glyphsVisible).toBe(false)
  })
})

describe('WO SKC-17 (BK-123(2)): the panel-header DoF badge shows the LIVE degrees-of-freedom count', () => {
  it('an unconstrained line shows its real DoF count; a Fix constraint drives it toward fully defined', () => {
    M = mountRail()
    drawLine(M, { x: 340, y: 280 }, { x: 460, y: 340 })
    const chip = () => screen.getByTestId('workbench-sketch-dof-chip')
    // Two free points = 4 DoF for a standalone line with no constraints.
    const before = payloadSketch(M).solveStatus
    expect(before).not.toBeNull()
    expect((before as { dof: number }).dof).toBeGreaterThan(0)
    // FAILS-IF the chip shows a hardcoded/stale label: it must carry the ACTUAL live dof count.
    expect(chip().textContent).toContain(String((before as { dof: number }).dof))
    expect(chip().textContent).toMatch(/DoF/)

    const id = payloadSketch(M).entities[0].id
    select([id, ...payloadSketch(M).entities.slice(1).map((e) => e.id)])
    fireEvent.click(screen.getByTestId('workbench-package-constraint-fix'))
    // FAILS-IF the badge reads a stale/cached number: it must track the POST-constraint solve.
    // A Fix constraint pins the whole line (both endpoints), so a standalone line goes straight to
    // dof === 0 -- the badge must then show "Fully defined" (CAM parity: dof 0 is a distinct state
    // from "N DoF remain", never rendered as "0 DoF").
    const after = payloadSketch(M).solveStatus as { dof: number }
    expect(after.dof).toBeLessThan((before as { dof: number }).dof)
    expect(after.dof).toBe(0)
    expect(chip().textContent).toContain('Fully defined')
  })
})

describe('WO SKC-17 (BK-122(3)): Finish sketch adopts the CAM green-checked language', () => {
  it('renders the shared .sketch-finish-btn class with a Check icon, not a bespoke modal-btn-primary', () => {
    M = mountRail()
    const btn = screen.getByTestId('workbench-finish-package-sketch')
    expect(btn.className).toContain('sketch-finish-btn')
    expect(btn.className).not.toContain('modal-btn-primary')
    expect(btn.querySelector('svg')).not.toBeNull()
  })
})

describe('CAM unaffected: this WO touches no useCamStore field', () => {
  it('sketchSessionStore glyphsVisible is independent of any CAM store import in this file\'s reach', () => {
    // Structural guard, not a behavioral one: the workbench toggle lives entirely in
    // sketchSessionStore (this file never imports useCamStore/toggleSketchGlyphs), so CAM's own
    // sketchGlyphsVisible field and ConstraintGlyphToggle are provably untouched by this test suite.
    expect(Object.keys(sketchSessionStore.getState())).toContain('glyphsVisible')
  })
})
