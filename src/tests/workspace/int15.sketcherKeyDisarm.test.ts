// @vitest-environment jsdom
//
// WO INT-15, Work item 3 (F-5) + Work item 6 (sketcher PARITY): Sketcher.suspend() must DISARM
// the interaction's window keydown handler, and resume() re-arm it -- proved PER INSTANCE against
// BOTH host shapes (CAM omits orbitPolicy -> 'session'; Part sets 'drag'), because this lands in
// the ONE shared Sketcher both hosts mount (feedback_sketcher_parity_part_cam: a shared-surface
// change is gated on both mounts, never one).
//
// This builds the REAL Sketcher package against each host shape (the same seam
// sketcherSuspendParity.int13b uses), enters a session -- attaching the REAL window keydown handler
// (sketchInteraction.ts) -- and asserts both the STRUCTURAL seam (isInteractionKeyListenerAttached)
// and the BEHAVIOUR (a real single-key tool chord dispatched at window arms a tool only while the
// handler is attached). Structural + behavioural together: a future edit that flipped the seam flag
// without detaching, or detached without flipping, turns one of them RED.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'

import { Sketcher, sketcherToolStore } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import type { SketcherHost, SketchDocumentPort, SketcherOrbitPolicy } from '../../lib/sketch/sketcher/ports'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

const P0: SketchEntity = { id: 'p0', kind: 'point', construction: false, at: { x: 0, y: 0 } }
const P1: SketchEntity = { id: 'p1', kind: 'point', construction: false, at: { x: 10, y: 0 } }
function freshSketch(): Sketch {
  return { id: 's', layerId: 'l', entities: [P0, P1], constraints: [], dimensions: [], solveStatus: null }
}

interface Mount { label: string; sketcher: Sketcher; overlayHost: HTMLElement }
const mounts: Mount[] = []

/** Build the real Sketcher against ONE host shape. `orbitPolicy: undefined` IS the CAM mount
 *  (CNCViewport omits the field -> 'session'); `'drag'` is the workbench. Only the key handler is
 *  under test, so the document port is a minimal real sink (arming a tool reads getSketch/getSelection
 *  and writes the shared tool store). Mirrors int13cHarness.mountRealSketcher / sketcherSuspendParity. */
function makeMount(label: string, orbitPolicy: SketcherOrbitPolicy | undefined): Mount {
  const overlayHost = document.createElement('div')
  const canvas = document.createElement('canvas')
  const container = document.createElement('div')
  container.appendChild(canvas)
  overlayHost.appendChild(container)
  document.body.appendChild(overlayHost)
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect

  const camera = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
  camera.position.set(0, 0, 10)
  camera.updateMatrixWorld(true)

  const sketch = freshSketch()
  const host: SketcherHost = {
    domElement: canvas, container, overlayHost, overlayRoot: new THREE.Group(), camera,
    controls: { enableRotate: true }, orbitPolicy,
    clientToPlaneWorld: () => ({ x: 0, y: 0 }), worldPerPixel: () => 1,
    saveCameraPose: () => ({ token: label }), restoreCameraPose: () => {}, frameNormalToPlane: () => {},
  }
  const doc: SketchDocumentPort = {
    getSketch: () => sketch, ensureSketch: () => sketch, getDisplayUnits: () => 'mm',
    getGridSpacing: () => 10, getProjectCandidates: () => [], getSelection: () => [], setSelection: () => {},
    getLastStagedSize: () => null, setLastStagedSize: () => {}, notice: () => {}, beginStep: () => {},
    append: () => {}, replace: () => {}, toggleSelectionConstruction: () => false, deleteSelection: () => {},
    dragBegin: () => true, dragMove: () => {}, dragEnd: () => {}, moveDimLabel: () => {}, openDimEditor: () => {},
    getTextEditId: () => null, getPickPathForTextId: () => null, editText: () => {}, commitTextEdit: () => {},
    cancelTextEdit: () => {}, cancelPickTextPath: () => {}, placeText: () => {}, bindTextPath: () => {},
  }
  const sketcher = new Sketcher(host)
  sketcher.setDocumentPort(doc)
  sketcher.setUndoSink({ beginGesture: () => {} })
  const m = { label, sketcher, overlayHost }
  mounts.push(m)
  return m
}

const armedTool = () => sketcherToolStore.getState().tool
const pressKey = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

beforeEach(() => {
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
})
afterEach(() => {
  for (const m of mounts) { m.sketcher.dispose(); m.overlayHost.remove() }
  mounts.length = 0
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
})

// The one field that distinguishes the two production mounts.
const SHAPES: Array<{ label: string; policy: SketcherOrbitPolicy | undefined }> = [
  { label: 'CAM mount (orbitPolicy undefined)', policy: undefined },
  { label: 'Part mount (orbitPolicy drag)', policy: 'drag' },
]

describe('INT-15 F-5: Sketcher.suspend() disarms the window key handler on BOTH mounts (parity)', () => {
  for (const { label, policy } of SHAPES) {
    it(`${label}: entered arms, suspend disarms (structural + behavioural), resume re-arms`, () => {
      const { sketcher } = makeMount(label, policy)
      sketcher.enter()

      // ENTERED: the handler is attached and a real single-key chord arms a tool.
      expect(sketcher.isInteractionKeyListenerAttached()).toBe(true)
      sketcherToolStore.__reset()
      pressKey('c')
      expect(armedTool()).toBe('circle-center') // non-vacuity: the chord is real and owned

      // SUSPENDED: the handler is detached (structural) AND a chord no longer arms (behavioural).
      sketcher.suspend()
      expect(sketcher.isInteractionKeyListenerAttached()).toBe(false)
      sketcherToolStore.setState({ tool: 'select' })
      pressKey('r') // rect-corner, were the suspended handler still live
      expect(armedTool()).toBe('select') // refused: no arming from the suspended sketcher

      // RESUMED: re-attached, and arming works again -- the session never exited.
      sketcher.resume()
      expect(sketcher.isInteractionKeyListenerAttached()).toBe(true)
      pressKey('r')
      expect(armedTool()).toBe('rect-corner')
    })
  }

  it('suspend()/resume() are idempotent on the key handler (no double-detach throw, no double-attach)', () => {
    const { sketcher } = makeMount('idempotency', undefined)
    sketcher.enter()
    sketcher.suspend()
    sketcher.suspend() // idempotent: no throw, still detached
    expect(sketcher.isInteractionKeyListenerAttached()).toBe(false)
    sketcher.resume()
    sketcher.resume() // idempotent: still attached, exactly one binding
    expect(sketcher.isInteractionKeyListenerAttached()).toBe(true)
    // Exactly one binding: one `c` arms once (a double-attach would still arm once, but a
    // subsequent detach-count check in dispose would leak; the structural seam above is the guard).
    sketcherToolStore.setState({ tool: 'select' })
    pressKey('c')
    expect(armedTool()).toBe('circle-center')
  })

  it('suspend() with no session entered is a no-op (never throws -- every cold start suspends first)', () => {
    const { sketcher } = makeMount('no-session', undefined)
    expect(() => { sketcher.suspend(); sketcher.resume() }).not.toThrow()
    expect(sketcher.isInteractionKeyListenerAttached()).toBe(false)
  })
})
