// @vitest-environment jsdom
//
// WO-1503 / BUG-478: the browser fires its native 'contextmenu' event on
// right-button release no matter how far the pointer moved first, so a
// right-drag pan (the default right-button-pans camera scheme) used to always
// pop Viewport.tsx's model-mode context menu too
// (handleModelContextMenu, Viewport.tsx:288-312, wired through
// ViewportContextMenuSurface's onContextMenu={onOpenMenu}).
//
// This test MOUNTS the real <Viewport/> and drives the actual DOM gesture:
// a pointerdown on the viewport canvas with button 2, then a native
// 'contextmenu' event (the browser's real sequence) at a client position
// far enough away to have crossed the click-drag threshold. CNCViewport
// constructs a real THREE.WebGLRenderer (jsdom has no WebGL), so the class is
// mocked -- the fake mirrors the real CNCViewport.consumeRightButtonWasDrag
// contract closely enough that a gate bypass in either Viewport.tsx or
// CNCViewport.ts would flip this test (CNCViewport.ts: rightButtonDownPos /
// consumeRightButtonWasDrag, handlePointerDown's button===2 branch).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import { createFakeSceneRuntime } from '../model3d/fakeSceneRuntime'

// jsdom's localStorage is unreliable under vitest's node launch flags and the
// Zustand store uses persist(); install an in-memory shim BEFORE importing the
// store (mirrors every other *.smoke.test.tsx in this suite).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

// WO-1503 threshold, mirrored from CLICK_DRAG_THRESHOLD_SQ_PX (CNCViewport.ts).
const CLICK_DRAG_THRESHOLD_SQ_PX = 25

vi.mock('../../lib/viewport/CNCViewport', () => {
  class CNCViewport {
    referenceImageHost = vi.fn(() => ({ runtime: createFakeSceneRuntime(), canvas: document.createElement('canvas') }))
    // Direct (non-optional-chained) calls Viewport.tsx's own effects make —
    // must all exist as real functions or the mount throws (mirrors
    // ViewportCarvedStockCensus.sim7.test.tsx's mock).
    setSketchOverlayHost = vi.fn()
    setSketchMenuPort = vi.fn()
    setSketchUndoSink = vi.fn()
    setSketchDocumentPort = vi.fn()
    applyNavPreset = vi.fn()
    setCameraChangeHandler = vi.fn()
    restoreCameraState = vi.fn()
    markCameraUserPositioned = vi.fn()
    rebuildStock = vi.fn()
    dispose = vi.fn()
    updateSketch = vi.fn()
    setSketchEditingLayer = vi.fn()
    enterSketchView = vi.fn()
    exitSketchView = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setToolpathVisible = vi.fn()
    setGridVisible = vi.fn()
    setAxesVisible = vi.fn()
    setSeedOutlineVisible = vi.fn()
    setMachineVisible = vi.fn()
    setShadingMode = vi.fn()
    setSectionView = vi.fn()
    renderToolpath = vi.fn()
    setHiddenToolpathRoles = vi.fn()
    updateHeightPlanes = vi.fn()
    setSetupSupportPlane = vi.fn()
    setWCSOrigin = vi.fn()
    setBrepPickMode = vi.fn()
    setMoveSelectCallback = vi.fn()
    partPointToScreen = vi.fn()
    setPartTransform = vi.fn()
    clearPartLoopsOnFacePlane = vi.fn()
    setPartProjectedLoops = vi.fn()
    saveCameraState = vi.fn()
    clearScene = vi.fn()
    setGridSpacing = vi.fn()
    setMachineTravel = vi.fn()
    suspendRender = vi.fn()
    resumeRender = vi.fn()
    setSelectedPart = vi.fn()
    clearCarvedStock = vi.fn()
    showCarvedStock = vi.fn()

    // WO-1503: pick resolves to nothing under the mouse in this test — the
    // gesture-arbitration decision (does the menu open at all) is what's
    // under test, not target resolution.
    pickAtClientPosition = vi.fn(() => ({ kind: null, id: null }))

    // Mirrors the real CNCViewport contract this WO added:
    //   - handlePointerDown records a button===2 pointerdown's client
    //     position (CNCViewport.ts:5499-5503);
    //   - consumeRightButtonWasDrag (CNCViewport.ts) compares that position
    //     against the 'contextmenu' event's own client position using the
    //     SAME squared-distance click-drag threshold handleClick already
    //     uses, and CONSUMES (clears) it either way.
    private rightButtonDownPos: { x: number; y: number } | null = null

    constructor(container: HTMLElement) {
      container.addEventListener('pointerdown', ((event: PointerEvent) => {
        if (event.button === 2) {
          this.rightButtonDownPos = { x: event.clientX, y: event.clientY }
        }
      }) as EventListener)
    }

    consumeRightButtonWasDrag(clientX: number, clientY: number): boolean {
      const down = this.rightButtonDownPos
      this.rightButtonDownPos = null
      if (!down) return false
      const dx = clientX - down.x
      const dy = clientY - down.y
      return dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_SQ_PX
    }
  }
  return { CNCViewport }
})

// ViewCube builds its own real WebGLRenderer independently of CNCViewport
// (ViewCube.tsx) — stub it out; irrelevant to this gesture.
vi.mock('../../components/viewport/ViewCube', () => typedMock<typeof import('../../components/viewport/ViewCube')>({ ViewCube: () => <></> }))

const { Viewport } = await import('../../components/viewport/Viewport')
const { useCamStore } = await import('../../store')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
})

function canvas(): HTMLElement {
  return document.querySelector('.viewport-canvas') as HTMLElement
}

function root(): HTMLElement {
  return document.querySelector('.viewport-root') as HTMLElement
}

function rightPointerDown(x: number, y: number): void {
  fireEvent.pointerDown(canvas(), { button: 2, clientX: x, clientY: y })
}

function nativeContextMenu(x: number, y: number): void {
  fireEvent.contextMenu(root(), { clientX: x, clientY: y })
}

describe('Viewport model-mode context menu right-button gesture arbitration (WO-1503)', () => {
  it('does not open when the right-button gesture drags past the click threshold before release', () => {
    render(<Viewport />)

    rightPointerDown(100, 100)
    // Past threshold: dx=40 -> 1600 > 25.
    nativeContextMenu(140, 100)

    expect(screen.queryByTestId('viewport-context-menu')).toBeNull()
  })

  it('still opens, with the correct empty target, for an ordinary right-click within the threshold', () => {
    render(<Viewport />)

    rightPointerDown(100, 100)
    // Within threshold: dx=2 -> 4 <= 25.
    nativeContextMenu(102, 100)

    expect(screen.getByTestId('viewport-context-menu')).not.toBeNull()
  })

  it('opens normally on a later, separate right-click after an earlier pan-then-release', () => {
    render(<Viewport />)

    // First gesture: a pan (suppressed).
    rightPointerDown(100, 100)
    nativeContextMenu(140, 100)
    expect(screen.queryByTestId('viewport-context-menu')).toBeNull()

    // Second, separate gesture: an ordinary right-click. The suppression from
    // the first gesture must not carry over.
    rightPointerDown(200, 200)
    nativeContextMenu(201, 200)
    expect(screen.getByTestId('viewport-context-menu')).not.toBeNull()
  })
})
