// @vitest-environment jsdom
// WO SKC-15B (S3) item 5 -- the SKC-14C techDebt question, answered and pinned:
// "what does a workbench document/session switch mean for the singleton menuStore anchor?"
//
// THE DECISION: it CLOSES.
//
// The context-menu anchor is package state (overlays/menuStore.ts) and it is a module SINGLETON,
// shared by every mount. It is anchored to a SELECTION inside a specific document. `toolController
// .resetForDocumentSwitch()` already establishes the rule for the other selection-scoped state:
// "selection and armed tool never survive a document switch". The menu anchor is selection-scoped
// state by that same argument -- and it is worse than the armed tool, because an open menu's Delete
// item would dispatch `deleteSelection()` into the NEW document, against ids that belong to the old
// one.
//
// THE HOOK POINT: `Sketcher.setDocumentPort()`. SKC-14B's report already named it as where a mount
// switch hooks, and it is the only call in the package that means "the document being edited has
// changed". Guarded on a REAL switch: CAM's viewport mount effect re-binds the SAME module const
// (`camSketchDocumentPort`) on every remount, and an idempotent re-bind is not a document switch.
//
// Do-not-redo (SKC-14C): no field here is named `sketchMenuAt` -- that token is a rule-(a) offender
// in oneSketchPointerOwner.test.ts and the guard fires on it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'

import { Sketcher } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import type { SketcherHost, SketchDocumentPort } from '../../lib/sketch/sketcher/ports'

function makeHost(): SketcherHost {
  const overlayHost = document.createElement('div')
  const canvas = document.createElement('canvas')
  const container = document.createElement('div')
  container.appendChild(canvas)
  overlayHost.appendChild(container)
  document.body.appendChild(overlayHost)
  return {
    domElement: canvas,
    container,
    overlayHost,
    overlayRoot: new THREE.Group(),
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10),
    controls: { enableRotate: true },
    clientToPlaneWorld: (x, y) => ({ x, y }),
    worldPerPixel: () => 1,
    saveCameraPose: () => ({}),
    restoreCameraPose: () => {},
    frameNormalToPlane: () => {},
  }
}

/** Two DISTINCT document sinks -- switching between them is the event under test. */
function makePort(): SketchDocumentPort {
  return {
    getSketch: () => null,
    ensureSketch: () => null,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 10,
    getProjectCandidates: () => [],
    getSelection: () => [],
    setSelection: () => {},
    getLastStagedSize: () => null,
    setLastStagedSize: () => {},
    notice: () => {},
    beginStep: () => {},
    append: () => {},
    replace: () => {},
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: () => false,
    dragMove: () => {},
    dragEnd: () => {},
    moveDimLabel: () => {},
    openDimEditor: () => {},
    getTextEditId: () => null,
    getPickPathForTextId: () => null,
    editText: () => {},
    commitTextEdit: () => {},
    cancelTextEdit: () => {},
    cancelPickTextPath: () => {},
    placeText: () => {},
    bindTextPath: () => {},
  }
}

let sketcher: Sketcher

beforeEach(() => {
  sketcherMenuStore.__reset()
  sketcher = new Sketcher(makeHost())
})
afterEach(() => {
  sketcher.dispose()
  document.body.innerHTML = ''
})

describe('the context-menu anchor never survives a document switch', () => {
  it('NON-VACUITY: the menu store really can hold an open anchor', () => {
    sketcherMenuStore.open(120, 340)
    expect(sketcherMenuStore.getState().menuAt).toEqual({ x: 120, y: 340 })
  })

  it('switching the document port CLOSES an open menu anchor', () => {
    const portA = makePort()
    const portB = makePort()
    sketcher.setDocumentPort(portA)

    sketcherMenuStore.open(120, 340)
    expect(sketcherMenuStore.getState().menuAt).not.toBeNull()

    sketcher.setDocumentPort(portB)

    // FAILS-IF the close is removed from setDocumentPort: a menu anchored to a selection in
    // document A stays open over document B, and its Delete item dispatches into B.
    expect(sketcherMenuStore.getState().menuAt).toBeNull()
  })

  it('UNBINDING the document port (mount teardown) also closes the anchor', () => {
    sketcher.setDocumentPort(makePort())
    sketcherMenuStore.open(5, 6)
    sketcher.setDocumentPort(null)
    expect(sketcherMenuStore.getState().menuAt).toBeNull()
  })

  it('an IDEMPOTENT re-bind of the SAME port is not a document switch and leaves the anchor alone', () => {
    const port = makePort()
    sketcher.setDocumentPort(port)
    sketcherMenuStore.open(7, 8)

    sketcher.setDocumentPort(port) // CAM's viewport remount re-binds its module const

    // FAILS-IF the guard is dropped and every re-bind closes the menu: CAM's own right-click menu
    // would vanish whenever anything re-ran the mount effect.
    expect(sketcherMenuStore.getState().menuAt).toEqual({ x: 7, y: 8 })
  })
})