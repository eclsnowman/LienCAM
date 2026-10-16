// Sketch entry chooser logic (Stage 5, PLAN 3.2) — headless tests.
//
// Pins: the Sketch tab needs the chooser ONLY when no document is active
// (direct entries set the document first and bypass it); the candidate
// list covers every OPENABLE 2D layer with loop counts - projection layers
// (read-only, ADR-0011) and locked layers are not listed, and a part with no
// openable layer has no group (WO-2854, the operator 2026-10-15: "are we going to
// allow editing of STL projections? If not why is it in there?"); "New sketch"
// (startNewSketch) always creates a fresh blank layer + document, never
// reopening a stored one. UI-level behavior (modal rendering, Esc) is
// covered by the stage gate capture.
//
// NAV-SKETCH-TAB-SELECTION (GEO-UNIFY Stage 5): resolveSketchTabSelection's
// own routing rules (one candidate = direct, 2+ = ambiguous, 0/none = fall
// through) are pinned here too — the store-level wiring (enterSketchWorkspace,
// the dead-fallback refusal) is covered by
// src/tests/store/sketchTabDeadFallback.navSketchTabSelection.test.ts and
// the render-level ModeTabStrip suite.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import {
  listSketchEntryCandidates, sketchTabNeedsChooser, resolveSketchTabSelection,
  resolvePromoteTabSelection,
} from '../../lib/sketch/entryChooser'
import { createBlankSketch } from '../../lib/sketch/blankSketch'
import type { ImportedGeometry } from '../../types'

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
})

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchTool: 'select' as const,
    sketchToolChain: null,
    sketchConstructionMode: false,
    sketchNotice: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    project: { ...s.project, geometry: [] },
    projectHistory: [],
    sketchHistory: [],
  }))
})

const BBOX = {
  min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
  size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
}

function geo(partial: Partial<ImportedGeometry>): ImportedGeometry {
  return {
    id: 'g', name: 'g', filename: 'g', type: 'curves_2d', format: 'dxf',
    boundingBox: BBOX,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ...partial,
  }
}

describe('sketchTabNeedsChooser (bypass logic)', () => {
  it('needs the chooser only when NO document is active', () => {
    expect(sketchTabNeedsChooser(null)).toBe(true)
    expect(sketchTabNeedsChooser(createBlankSketch('layer-x'))).toBe(false)
  })

  it('direct entry (openSketchForLayer) sets the document, bypassing the chooser', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [geo({
          id: 'dxf', name: 'part.dxf',
          loops: [{
            id: 'lp', layerId: 'L', closed: true, type: 'contour', area: 100,
            points: [
              { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
            ],
          }],
          layers2d: [{ id: 'L', name: '0', color: '#fff', visible: true }],
        })],
      },
    }))
    expect(useCamStore.getState().openSketchForLayer('L')).toBe(true)
    expect(sketchTabNeedsChooser(useCamStore.getState().activeSketch)).toBe(false)
  })
})

describe('listSketchEntryCandidates', () => {
  it('lists openable 2D layers with container/loop count; projected and locked layers are absent', () => {
    const geometry: ImportedGeometry[] = [
      geo({
        id: 'dxf', name: 'part.dxf', format: 'dxf',
        loops: [
          {
            id: 'a', layerId: 'd1', closed: true, type: 'contour', area: 1,
            points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
          },
          {
            id: 'b', layerId: 'd1', closed: false, type: 'open', area: 0,
            points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
          },
        ],
        layers2d: [
          { id: 'd1', name: 'profile', color: '#fff', visible: true },
          { id: 'd2', name: 'frozen', color: '#fff', visible: true, locked: true },
        ],
      }),
      geo({
        id: 'stl', name: 'body.stl', format: 'stl', type: 'mesh',
        loops: [],
        layers2d: [{
          id: 's1', name: 'STL Projection 1', color: '#fff', visible: true,
          projectionPlane: {
            origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
          },
        }],
      }),
      geo({
        id: 'sketch-container', name: 'Sketches', format: 'sketch',
        loops: [],
        layers2d: [{
          id: 'k1', name: 'Sketch 1', color: '#ffd740', visible: true,
          sourceType: 'sketch',
        }],
        sketches: [createBlankSketch('k1')],
      }),
    ]
    const c = listSketchEntryCandidates(geometry)
    expect(c.map((x) => x.layerId)).toEqual(['d1', 'k1'])

    const byId = new Map(c.map((x) => [x.layerId, x]))
    // DXF layer: selectable, 2 loops, container named after the file.
    expect(byId.get('d1')!.disabledReason).toBeNull()
    expect(byId.get('d1')!.loopCount).toBe(2)
    expect(byId.get('d1')!.containerName).toBe('part.dxf')
    expect(byId.get('d1')!.hasStoredSketch).toBe(false)
    // Locked layer and STL projection (read-only per ADR-0011): not offered,
    // and the STL part - projections only - contributes no group.
    expect(byId.has('d2')).toBe(false)
    expect(byId.has('s1')).toBe(false)
    expect(c.some((x) => x.geoId === 'stl')).toBe(false)
    // Baked sketch layer: selectable, flagged as a parametric re-edit.
    expect(byId.get('k1')!.disabledReason).toBeNull()
    expect(byId.get('k1')!.hasStoredSketch).toBe(true)
  })

  it('WO-2854: Full Suite offers no projection row - STEP and model projection parts have no group', () => {
    const plane = {
      origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
    }
    const geometry: ImportedGeometry[] = [
      geo({
        id: 'svg', name: 'Leadscrew_Stepper_Mount', format: 'svg', loops: [],
        layers2d: [
          { id: 'color-0', name: 'Layer 1', color: '#0ff', visible: true },
          { id: 'color-1', name: 'Layer 2', color: '#f0f', visible: true },
        ],
      }),
      geo({
        id: 'step', name: 'Part 1', format: 'step', type: 'brep', loops: [],
        layers2d: [{ id: 'cyl', name: 'Cylinder (12)', color: '#fff', visible: true, projectionPlane: plane }],
      }),
      geo({
        id: 'model', name: 'Extrude F1', format: 'model', type: 'brep', loops: [],
        layers2d: [{ id: 'sec', name: 'Section z=0.1', color: '#fff', visible: true, projectionPlane: plane }],
      }),
      geo({
        id: 'locked-only', name: 'frozen.dxf', format: 'dxf', loops: [],
        layers2d: [{ id: 'f', name: '0', color: '#fff', visible: true, locked: true }],
      }),
    ]
    const c = listSketchEntryCandidates(geometry)
    expect(c.map((x) => `${x.geoId}:${x.layerId}`)).toEqual(['svg:color-0', 'svg:color-1'])
    expect(c.every((x) => x.disabledReason === null)).toBe(true)
    expect(JSON.stringify(c)).not.toMatch(/projection|read-only|ADR-0011|locked/i)
  })

  it('empty project -> no candidates (chooser shows only New sketch)', () => {
    expect(listSketchEntryCandidates([])).toHaveLength(0)
  })
})

describe('startNewSketch (chooser "New sketch" path)', () => {
  it('always creates a FRESH blank document + layer and enters sketch mode', () => {
    useCamStore.getState().startNewSketch()
    const first = useCamStore.getState().activeSketch
    expect(first).not.toBeNull()
    // WO SKC-49: a fresh blank document owns exactly the three injected origin/axis anchors.
    expect(first!.entities).toHaveLength(3)
    expect(useCamStore.getState().viewer.mode).toBe('sketch')

    // Leave (empty -> aborted entry cleans the layer up, no orphans).
    useCamStore.getState().setViewerMode('setup')
    expect(useCamStore.getState().activeSketch).toBeNull()
    expect(useCamStore.getState().project.geometry).toHaveLength(0)

    // A second entry is a NEW document, not a reopen.
    useCamStore.getState().startNewSketch()
    const second = useCamStore.getState().activeSketch
    expect(second).not.toBeNull()
    expect(second!.id).not.toBe(first!.id)
    expect(second!.layerId).not.toBe(first!.layerId)
  })
})

describe('resolveSketchTabSelection (NAV-SKETCH-TAB-SELECTION, Stage 5)', () => {
  it('no selection -> none (falls through to today\'s plain behavior)', () => {
    expect(resolveSketchTabSelection([], null)).toEqual({ kind: 'none' })
  })

  it('selection is an UNKNOWN geometry id -> none', () => {
    const geometry = [geo({ id: 'dxf', layers2d: [{ id: 'L', name: '0', color: '#fff', visible: true }] })]
    expect(resolveSketchTabSelection(geometry, 'ghost')).toEqual({ kind: 'none' })
  })

  it('selected part has exactly ONE sketch-editable layer -> direct', () => {
    const geometry = [geo({
      id: 'dxf',
      layers2d: [{ id: 'L', name: '0', color: '#fff', visible: true }],
    })]
    expect(resolveSketchTabSelection(geometry, 'dxf')).toEqual({
      kind: 'direct', geoId: 'dxf', layerId: 'L',
    })
  })

  it('selected part has 2+ sketch-editable layers -> ambiguous, named by geoId', () => {
    const geometry = [geo({
      id: 'dxf',
      layers2d: [
        { id: 'L1', name: '0', color: '#fff', visible: true },
        { id: 'L2', name: '1', color: '#fff', visible: true },
      ],
    })]
    expect(resolveSketchTabSelection(geometry, 'dxf')).toEqual({
      kind: 'ambiguous', geoId: 'dxf',
    })
  })

  it('selected part\'s only layer is LOCKED (zero usable candidates) -> none, never a refusal here', () => {
    const geometry = [geo({
      id: 'dxf',
      layers2d: [{ id: 'L', name: '0', color: '#fff', visible: true, locked: true }],
    })]
    expect(resolveSketchTabSelection(geometry, 'dxf')).toEqual({ kind: 'none' })
  })

  it('selected part\'s only layer is an STL projection (read-only) -> none', () => {
    const geometry = [geo({
      id: 'stl', format: 'stl', type: 'mesh',
      layers2d: [{
        id: 's1', name: 'STL Projection 1', color: '#fff', visible: true,
        projectionPlane: {
          origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
        },
      }],
    })]
    expect(resolveSketchTabSelection(geometry, 'stl')).toEqual({ kind: 'none' })
  })

  it('a locked layer alongside an unlocked one -> direct on the SINGLE usable candidate', () => {
    const geometry = [geo({
      id: 'dxf',
      layers2d: [
        { id: 'L1', name: '0', color: '#fff', visible: true },
        { id: 'L2', name: '1', color: '#fff', visible: true, locked: true },
      ],
    })]
    expect(resolveSketchTabSelection(geometry, 'dxf')).toEqual({
      kind: 'direct', geoId: 'dxf', layerId: 'L1',
    })
  })

  it('selected part has NO layers at all (e.g. a 3D model body) -> none', () => {
    const geometry = [geo({ id: 'model', format: 'model', layers2d: [] })]
    expect(resolveSketchTabSelection(geometry, 'model')).toEqual({ kind: 'none' })
  })
})

// PROMOTE-SKETCH-FAIL round 2: the Model-tab (promote) select-then-switch
// resolver. The pre-fix Model tab read ONLY selectedGeometryId, so a selected
// sketch LAYER (which clears selectedGeometryId and sets selectedLayerId)
// resolved to nothing and the tab silently navigated away without promoting.
describe('resolvePromoteTabSelection (Model-tab path 3, promote)', () => {
  const sketchGeo = () => geo({
    id: 'sk', name: 'Sketches', format: 'sketch',
    layers2d: [{ id: 'L1', name: 'Sketch 1', color: '#fff', visible: true }],
    loops: [{ id: 'lp', layerId: 'L1', closed: true, type: 'contour', area: 100, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }],
  })

  it('a selected sketch LAYER (selectedLayerId set, selectedGeometryId null) -> direct promote of that layer', () => {
    expect(resolvePromoteTabSelection([sketchGeo()], null, 'L1', 'sk')).toEqual({
      kind: 'direct', geoId: 'sk', layerId: 'L1',
    })
  })

  it('a selected layer with only a layerId (no geoId) is still resolved by search', () => {
    expect(resolvePromoteTabSelection([sketchGeo()], null, 'L1', null)).toEqual({
      kind: 'direct', geoId: 'sk', layerId: 'L1',
    })
  })

  it('a whole single-sketch PART selected -> direct promote of its sole layer', () => {
    expect(resolvePromoteTabSelection([sketchGeo()], 'sk', null, null)).toEqual({
      kind: 'direct', geoId: 'sk', layerId: 'L1',
    })
  })

  it('a whole part with 2+ sketch-editable layers -> ambiguous (no single sketch to promote)', () => {
    const twoLayer = geo({
      id: 'dxf', name: 'part.dxf', format: 'dxf',
      layers2d: [
        { id: 'L1', name: '0', color: '#fff', visible: true },
        { id: 'L2', name: '1', color: '#fff', visible: true },
      ],
      loops: [
        { id: 'a', layerId: 'L1', closed: true, type: 'contour', area: 1, points: [{ x: 0, y: 0 }] },
        { id: 'b', layerId: 'L2', closed: true, type: 'contour', area: 1, points: [{ x: 0, y: 0 }] },
      ],
    })
    expect(resolvePromoteTabSelection([twoLayer], 'dxf', null, null)).toEqual({ kind: 'ambiguous', geoId: 'dxf' })
  })

  it('a locked/projection layer selected -> none (no promotable sketch), never a wrong promote', () => {
    const locked = geo({
      id: 'sk', format: 'sketch',
      layers2d: [{ id: 'L1', name: 'Sketch 1', color: '#fff', visible: true, locked: true }],
    })
    expect(resolvePromoteTabSelection([locked], null, 'L1', 'sk')).toEqual({ kind: 'none' })
  })

  it('no selection at all -> none (falls through to plain Model-tab nav)', () => {
    expect(resolvePromoteTabSelection([sketchGeo()], null, null, null)).toEqual({ kind: 'none' })
  })
})
