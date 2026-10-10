// @vitest-environment jsdom
//
// SIM-7 (BK-139 Part 3.1): render-level census lock for carved-stock display.
//
// src/tests/simulation/stockRemovalDisplayAuthority.sim6.test.ts proves
// shouldDisplayAdaptiveCarvedStock in isolation, but it re-implements the gate
// check INLINE in the test ("if (shouldDisplayAdaptiveCarvedStock('simulation'))
// showAdaptivePreview(viewport)") -- it never runs Viewport.tsx's own code. A
// Viewport.tsx edit that bypasses the real call at Viewport.tsx (the
// `if (shouldDisplayAdaptiveCarvedStock(viewer.mode))` gate around the
// showCarvedStock/clearCarvedStock branch) would stay unit-green under sim6's
// test forever.
//
// This test MOUNTS the real <Viewport/> component in Simulation mode, with:
//   - an adaptive_3d op whose carved-stock preview IS available (would show if
//     the gate were bypassed), AND
//   - the stock-sim (heightmap) engine independently enabled, so a SECOND,
//     unrelated carved-stock body (the heightmap surface, built by
//     SimulationPanel's own effect) is also live.
// The scene-graph census (visibleStockRemovalBodies) must stay at exactly 1 --
// the heightmap body only. If Viewport.tsx's real gate is bypassed, the
// adaptive preview would ALSO show, and the census would wrongly read 2.
//
// CNCViewport constructs a real THREE.WebGLRenderer (jsdom has no WebGL), so
// the whole class is mocked with a lightweight fake that tracks exactly the
// scene-graph state stockRemovalDisplayAuthority.ts cares about (which
// carved-stock ids are currently shown), mirroring the REAL showCarvedStock /
// clearCarvedStock / initStockSim contracts (CNCViewport.ts:1335-1402, 1621+)
// closely enough that a gate bypass changes the census. ViewCube is mocked too
// (it builds its own real WebGLRenderer independently of CNCViewport).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { ImportedGeometry, Operation, Setup } from '../../types'
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

const OP_ID = 'op-a3d-census-1'
const CARVED_MESH = {
  positions: new Float32Array([0, 0, 0, 8, 0, 0, 0, 8, 0]),
  indices: new Uint32Array([0, 1, 2]),
  position: { x: 0, y: 0, z: 0 },
  rotationZDeg: 0,
}

// The scene-graph census this test cares about: which carved-stock ids are
// CURRENTLY shown, tracked with the same add/remove-by-id, clear-all-when-
// no-id semantics as the real CNCViewport methods (CNCViewport.ts:1335-1402).
let shownBodyIds: Set<string>
function census(): number { return shownBodyIds.size }

vi.mock('../../lib/viewport/CNCViewport', () => {
  class CNCViewport {
    referenceImageHost = vi.fn(() => ({ runtime: createFakeSceneRuntime(), canvas: document.createElement('canvas') }))
    // Direct (non-optional-chained) calls Viewport.tsx's own effects make —
    // must all exist as real functions or the mount throws.
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
    setSetupSupportPlane = vi.fn() // WO-227 (8381d758): setup fixture support planes
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
    // INT-13B suspend/resume contract: Viewport.tsx's suspend effect calls
    // these non-optionally on every mount (resumeRender on the initial
    // suspended=false pass) — caught by the v0.12.11 merge campaign when this
    // main-side mock predated the branch's interface change.
    suspendRender = vi.fn()
    resumeRender = vi.fn()

    // Tracked: the SAME per-id add / global-clear contract as the real
    // CNCViewport (CNCViewport.ts:1335-1402).
    showCarvedStock = vi.fn((id: string) => { shownBodyIds.add(`adaptive:${id}`) })
    clearCarvedStock = vi.fn((id?: string) => {
      if (id !== undefined) shownBodyIds.delete(`adaptive:${id}`)
      else { for (const k of [...shownBodyIds]) if (k.startsWith('adaptive:')) shownBodyIds.delete(k) }
    })

    // Tracked: the stock-sim (heightmap) body SimulationPanel drives
    // independently of the adaptive-preview gate (CNCViewport.ts:1621+).
    initStockSim = vi.fn(() => {
      shownBodyIds.add('heightmap')
      return { x0: 0, y0: 0, nx: 8, ny: 8, cellSize: 1, stockTop: 8, stockBot: 0 }
    })
    disposeStockSim = vi.fn(() => { shownBodyIds.delete('heightmap') })
  }
  // WO-1052 FINDING: CNCViewport's private static members are nominally
  // untypeable from outside its own declaration (see
  // owningStockViewportPick.ui64.test.tsx). Left untyped.
  return { CNCViewport }
})

// ViewCube builds its own real WebGLRenderer independently of CNCViewport
// (ViewCube.tsx:46-58) — stub it out; irrelevant to the carved-stock gate.
vi.mock('../../components/viewport/ViewCube', () => typedMock<typeof import('../../components/viewport/ViewCube')>({ ViewCube: () => <></> }))

// getAdaptive3dCarvedStock reads a module-private Map with no exported setter
// (store/index.ts) — populated only by the internal compute-completion
// handler. Override just this one named export so the carved mesh IS
// available for OP_ID (the real scenario the gate must suppress), leaving
// every other store export/behavior real.
vi.mock('../../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store')>()
  return typedMock<typeof import('../../store')>({
    ...actual, getAdaptive3dCarvedStock: (opId: string) => (opId === OP_ID ? CARVED_MESH : undefined),
  })
})

const { Viewport } = await import('../../components/viewport/Viewport')
const { useCamStore } = await import('../../store')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  shownBodyIds = new Set()
  act(() => { useCamStore.getState().newProject() })
})

function seedReadyAdaptive3dOp(mode: 'toolpath' | 'simulation' = 'simulation'): void {
  const geo = {
    id: 'geo-solid-1', name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
  } as unknown as ImportedGeometry
  const op = {
    id: OP_ID, name: '3D Rough 1', type: 'adaptive_3d', toolId: 'tool-1',
    enabled: true, status: 'ready', geometrySelections: ['geo-solid-1'],
    heights: {}, passes: {}, linking: {}, params: {},
    toolpathMoves: [
      { type: 'rapid', x: 0, y: 0, z: 10 },
      { type: 'feed', x: 10, y: 0, z: 0, feed: 1000 },
    ],
  } as unknown as Operation
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      origin: { x: 0, y: 0, z: 0 }, label: 'G54',
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    operations: [op],
  } as unknown as Setup
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project, geometry: [geo], setups: [setup],
        activeSetupId: 'setup-1', activeOperationId: null,
      },
      viewer: { ...s.viewer, mode },
    } as never))
  })
}

describe('Viewport carved-stock census (Simulation mode, render-level)', () => {
  it('stays at exactly ONE visible body: the heightmap, never the adaptive preview', () => {
    seedReadyAdaptive3dOp()
    render(<Viewport />)

    // First commit: Viewport's own carved-stock effect has run (mode is
    // 'simulation' from the start, so shouldDisplayAdaptiveCarvedStock gates
    // the adaptive preview off) -- census must already be 0 here.
    expect(census()).toBe(0)

    // Second commit: flip stockSimEnabled so SimulationPanel's stock-sim
    // effect re-fires (its deps include stockSimEnabled). By now
    // window.__cncViewport is live (Viewport's expose-effect ran during the
    // first commit's parent phase), so this reaches the real initStockSim call.
    act(() => { useCamStore.getState().setStockSimEnabled(true) })

    expect(census()).toBe(1)
    expect([...shownBodyIds]).toEqual(['heightmap'])
  })

  it('SIM-8 toggles only the Toolpath-mode roughing preview', () => {
    seedReadyAdaptive3dOp('toolpath')
    render(<Viewport />)

    // Operator's requested default: the diagnostic starts OFF so it cannot
    // obscure the part without the user explicitly asking for it.
    expect(useCamStore.getState().viewer.showRoughingPreview).toBe(false)
    expect(census()).toBe(0)

    act(() => { useCamStore.getState().toggleViewerFlag('showRoughingPreview') })
    expect([...shownBodyIds]).toEqual([`adaptive:${OP_ID}`])

    act(() => { useCamStore.getState().toggleViewerFlag('showRoughingPreview') })
    expect(census()).toBe(0)
  })
})
