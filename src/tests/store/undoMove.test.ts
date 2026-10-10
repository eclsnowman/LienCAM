// B1 (docs/planning/POST-MERGE-WORKPLAN.md): gizmo moves were not in the undo
// history. updateGeometryTransform was the only geometry mutation that never
// called pushHistory, so after import -> gizmo move, Ctrl+Z popped the
// pre-IMPORT snapshot (geometry vanished) instead of the pre-MOVE one.
//
// Granularity contract (matches the real input paths):
//   - During a gizmo drag, TransformControls mutates the THREE group directly;
//     the store is touched exactly ONCE, at drag end (CNCViewport's
//     'dragging-changed' handler -> Viewport.handlePartTransformChange ->
//     updateGeometryTransform). So one completed gesture = one store call =
//     one history entry. There is no per-frame store flood to guard against,
//     but a zero-delta commit (clicking a gizmo handle without moving, or the
//     input blur re-commit after Enter) must NOT push - it would make Ctrl+Z
//     appear dead.
//   - The properties-panel typed commit (commitTransformAxis, B11 path) lands
//     in the same store action, so it becomes the same kind of undo step.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import { commitTransformAxis } from '../../components/panels/PropertiesPanel'
import type { ImportedGeometry, SceneStock } from '../../types'

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -25, y: -25, z: 0 }, max: { x: 25, y: 25, z: 10 },
      size: { x: 50, y: 50, z: 10 }, center: { x: 0, y: 0, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ...over,
  }
}

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function resetStore(): void {
  useCamStore.setState(s => ({
    project: { ...s.project, geometry: [], setups: [], sceneStock: autoStock },
    projectHistory: [],
    sketchHistory: [],
    canUndo: false,
  }))
}

const state = () => useCamStore.getState()
const geoCount = () => state().project.geometry.length
const geo = () => state().project.geometry[0]
const historyLen = () => state().projectHistory.length

describe('B1: gizmo move is one undo step', () => {
  beforeEach(() => {
    resetStore()
    // commitTransformAxis reaches for window.__cncViewport; in the app the
    // group was already moved/synced. Here: no viewport, handler tolerates it.
    vi.stubGlobal('window', {})
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('import -> gizmo move -> undo restores the move (geometry stays) -> undo removes the import', () => {
    // Import (the DesignTree file handler ends in addGeometry).
    state().addGeometry(makeGeo())
    expect(geoCount()).toBe(1)

    // Gizmo gesture: live drag moves only the THREE group; drag end syncs the
    // final transform to the store exactly once.
    state().updateGeometryTransform('geo-1', { x: 10, y: 5, z: 3 }, { x: 0, y: 0, z: 0 })
    expect(geo().position).toEqual({ x: 10, y: 5, z: 3 })

    // First undo: the MOVE is undone, the geometry is still there.
    state().undo()
    expect(geoCount()).toBe(1)
    expect(geo().position).toEqual({ x: 0, y: 0, z: 0 })

    // Second undo: now the IMPORT is undone.
    state().undo()
    expect(geoCount()).toBe(0)
  })

  it('one completed gesture = exactly one history entry; zero-delta commits push nothing', () => {
    state().addGeometry(makeGeo())
    const baseline = historyLen()

    // One gesture -> one entry.
    state().updateGeometryTransform('geo-1', { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(historyLen()).toBe(baseline + 1)

    // Zero-delta re-commit (gizmo handle clicked without moving, or the panel
    // input's blur firing right after Enter committed the same value).
    state().updateGeometryTransform('geo-1', { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(historyLen()).toBe(baseline + 1)

    // A second real gesture -> a second entry (per-gesture, not coalesced away).
    state().updateGeometryTransform('geo-1', { x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(historyLen()).toBe(baseline + 2)
  })

  it('rotation-only gizmo gesture is also one undoable step', () => {
    state().addGeometry(makeGeo())
    state().updateGeometryTransform('geo-1', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 90 })
    expect(geo().rotation.z).toBe(90)

    state().undo()
    expect(geoCount()).toBe(1)
    expect(geo().rotation.z).toBe(0)
  })

  it('typed-Z panel commit (B11 path) is undoable as the same kind of step', () => {
    state().addGeometry(makeGeo({ position: { x: 1, y: 2, z: 4 } }))

    // The properties-panel Z input commit handler (Enter/blur).
    commitTransformAxis(geo(), 'position', 'z', 12)
    expect(geo().position.z).toBe(12)

    state().undo()
    expect(geoCount()).toBe(1)
    expect(geo().position).toEqual({ x: 1, y: 2, z: 4 })
  })

  it('a move marks ready ops referencing the geometry outdated on BOTH input paths', () => {
    const op = {
      id: 'op-1', name: 'Op', type: 'contour_2d' as const, enabled: true,
      status: 'ready' as const, toolId: 'tool-1', geometrySelections: [],
      heights: {
        clearanceHeight: 30, clearanceHeightMode: 'absolute' as const,
        retractHeight: 20, feedHeight: 15,
        topHeight: 0, topHeightMode: 'stock_top' as const,
        bottomHeight: -3, bottomHeightMode: 'absolute' as const,
      },
      passes: { stepdown: 2, stepover: 1.6, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: {
        entryType: 'plunge' as const, rampAngle: 3, rampLength: 10,
        leadInRadius: 0, leadOutRadius: 0,
        retractType: 'full' as const, transitionType: 'safe_height' as const,
      },
      params: { geometryId: 'geo-1', loopIds: [] },
      toolpathMoves: [],
    }
    const setup = {
      id: 'setup-1', name: 'Setup 1',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      },
      stock: {
        type: 'rectangular' as const,
        offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
        material: 'aluminum',
      },
      operations: [op],
      notes: '',
    }

    // Gizmo path (drag-end store sync).
    useCamStore.setState(s => ({
      project: { ...s.project, geometry: [makeGeo()], setups: [setup] },
    }))
    state().updateGeometryTransform('geo-1', { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(state().project.setups[0].operations[0].status).toBe('outdated')

    // Panel path (typed axis commit).
    useCamStore.setState(s => ({
      project: { ...s.project, geometry: [makeGeo()], setups: [{ ...setup, operations: [{ ...op }] }] },
    }))
    commitTransformAxis(geo(), 'position', 'z', 6)
    expect(state().project.setups[0].operations[0].status).toBe('outdated')
  })
})
