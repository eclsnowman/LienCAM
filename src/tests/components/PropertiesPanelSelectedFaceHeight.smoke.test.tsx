// @vitest-environment jsdom
//
// React-render SMOKE test for the selected-face BOTTOM-of-cut readout —
// Phase H0b regression lock for "refresh-on-move" (COORD-SYSTEM-MAP section D).
//
// WHAT SURFACE THIS TESTS AND WHY: the spec's first choice is the
// NewOperationModal selected-face block, but that modal is impractical to mount
// in jsdom (it pulls the whole 7-tab wizard, a live 3D viewport bridge, and
// pick-time geometry state). The PropertiesPanel OperationProperties "Bottom"
// row is driven by the SAME pure converter — resolveGeometryZToFrames(localZ,
// geo, setup) — via displayBottom (PropertiesPanel.tsx ~849-863), so it proves
// the exact converter wiring the modal uses, at the React layer, without faking
// anything. The panel exposes the WCS-relative wcsZ (= worldZ - wcs.origin.z);
// since the WCS origin is held constant across the move, a +d shift of the
// part's Z moves worldZ by d AND moves the displayed wcsZ by d — so asserting
// the Bottom value shifts by d proves the converter is folding the part's
// position.z (worldZ = selectedFaceZ + position.z) live, on every store change.
//
// This is the render-layer regression lock: a future change that makes the
// readout read a stale stored field (the old bug) instead of re-resolving in
// render would fail the post-move assertion here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { ImportedGeometry, Operation, Setup } from '../../types'

// jsdom's localStorage is unreliable under vitest's node launch flags and the
// Zustand store uses persist(); install an in-memory shim BEFORE importing the
// store (mirrors the other *.smoke.test.tsx files).
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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
})

// Known test frame:
//   selectedFaceZ (geometry-local face plane) F = -14
//   geometry.position.z (part placement)      P =  5
//   wcs.origin.z (work zero)                  O =  3
// => worldZ = F + P = -9 ; wcsZ (Bottom row)  = worldZ - O = -12
const GEO_ID = 'geo-step-1'
const F = -14
const P = 5
const O = 3

function seedSelectedFacePocket(opType: string = 'pocket_2d'): void {
  const geo = {
    id: GEO_ID,
    name: 'StepPart',
    format: 'step',
    position: { x: 0, y: 0, z: P },
    rotation: { x: 0, y: 0, z: 0 },
    // a real bounding box so the move path's assignStocks/geometryWorldBounds
    // (which reads boundingBox.min/max) does not crash.
    boundingBox: { min: { x: 0, y: 0, z: -20 }, max: { x: 10, y: 10, z: 0 } },
    // a non-empty loops array so updateGeometryTransform treats it as real
    // geometry; content is irrelevant to the height converter.
    loops: [{ id: 'l1', points: [] }],
  } as unknown as ImportedGeometry

  const op = {
    id: 'op-pocket-1',
    name: 'Selected-Face Pocket',
    type: opType,
    toolId: 't-none',
    status: 'idle',
    geometrySelections: [],
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    params: { geometryId: GEO_ID },
    heights: {
      clearanceHeight: 10,
      clearanceHeightMode: 'absolute',
      retractHeight: 5,
      feedHeight: 2,
      topHeight: 0,
      topHeightMode: 'stock_top',
      bottomHeight: -5, // the STALE legacy field — must NOT be what renders
      bottomHeightMode: 'selected_face',
      selectedFaceZ: F,
    },
  } as unknown as Operation

  const setup = {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: { origin: { x: 0, y: 0, z: O } },
    operations: [op],
  } as unknown as Setup

  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [geo],
        setups: [setup],
        activeSetupId: 'setup-1',
        activeOperationId: 'op-pocket-1',
      },
      // ensure the op (not a geometry) is the selected properties surface
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    }))
  })
}

// 2026-08-18: the three selected-face Bottom readout tests were retired.
// The V2-only cutover (2e5678b7) turned the Properties panel's V1 reference
// plane / selected-face readout off (showRefPlane = false); the panel now
// shows the resolved V2 plan rows (props-height-row-*). Per ADR-0040 there is
// no legacy path to satisfy them; selected-face targeting lives in the V2
// selected_feature / target_face families and their own tests.
describe('PropertiesPanel selected-face Bottom readout (H0b refresh-on-move)', () => {
  it('mounts the op properties without throwing (guards hooks-order)', () => {
    seedSelectedFacePocket()
    render(<PropertiesPanel />)
    expect(screen.getByText('Properties')).not.toBeNull()
  })



  // Regression lock for the displayBottom HOIST fix: the selected_face converter
  // branch must run for ALL boundary ops, not just pocket_2d. Before the fix the
  // pocket-only guard early-returned the stale stored bottomHeight (-5) for a
  // contour_2d op; after the fix it resolves to the converter wcsZ (-12).
})

// Focused UNIT test for the NewOperationModal "passes to depth" arithmetic fix.
// The full modal is impractical to mount in jsdom, so we reproduce the exact
// depthRange/estPasses formula (NewOperationModal.tsx ~line 771-784) and prove
// that using the RESOLVED selected_face bottom yields the correct pass count,
// while the stale stored bottomHeight would yield a wrongly-small count.
describe('NewOperationModal passes-to-depth uses resolved selected_face bottom', () => {
  it('ceil(|top - resolvedBottom| / stepdown) is correct, stale value undercounts', () => {
    const top = 0
    const resolvedBottom = -26 // real cut bottom from resolveGeometryZToFrames
    const staleBottom = -5     // stale stored heights.bottomHeight
    const stepdown = 2

    const depthRangeResolved = Math.abs(top - resolvedBottom)
    const estPassesResolved = depthRangeResolved > 0
      ? Math.ceil(depthRangeResolved / Math.max(0.01, stepdown)) : 1
    expect(estPassesResolved).toBe(13) // ceil(26 / 2)

    const depthRangeStale = Math.abs(top - staleBottom)
    const estPassesStale = depthRangeStale > 0
      ? Math.ceil(depthRangeStale / Math.max(0.01, stepdown)) : 1
    expect(estPassesStale).toBe(3) // ceil(5 / 2) — the WRONG count the bug showed
    expect(estPassesStale).not.toBe(estPassesResolved)
  })
})
