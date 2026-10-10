// NAV-SKETCH-TAB-SELECTION (GEO-UNIFY Stage 5, NAV-PARITY-AUDIT Gap 1) —
// headless store tests for `enterSketchWorkspace` and the reconciled
// `setViewerMode` dead-fallback.
//
// Before this WO: `setViewerMode('sketch')` reached with no active document
// AND a selected geometry would silently resolve at GEOMETRY granularity
// ("most recently finished" sketch in geo.sketches) or, for a part with no
// stored sketch yet, fabricate a brand-new UNRELATED blank sketch instead of
// lifting the selected part's own loops (NAV-PARITY-AUDIT.report.md Gap 1,
// store/index.ts pre-fix). That path was unreachable from any real UI
// control even then (ModeTabStrip's chooser gate always intercepted first),
// but it was live, wrong, and reachable via a bare store call.
//
// After: the Sketch tab routes through `enterSketchWorkspace`, which
// resolves the selection BEFORE ever calling setViewerMode (direct open /
// pre-filtered chooser / today's plain behavior) — and a bare
// setViewerMode('sketch') reached with a selection but no resolved document
// now REFUSES loudly (ADR-0003) instead of guessing, leaving mode/
// activeSketch untouched. A bare setViewerMode('sketch') with NO selection
// keeps the plain "always give the tools a target" auto-blank-sketch
// behavior other suites rely on as a test convenience (unchanged, and
// exercised elsewhere already).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
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
    activeModal: null,
    sketchEntryFilterGeoId: null,
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

const oneLayerPart = () => geo({
  id: 'part1', name: 'part1.dxf',
  layers2d: [{ id: 'L1', name: '0', color: '#fff', visible: true }],
})

const twoLayerPart = () => geo({
  id: 'part2', name: 'part2.dxf',
  layers2d: [
    { id: 'A', name: '0', color: '#fff', visible: true },
    { id: 'B', name: '1', color: '#fff', visible: true },
  ],
})

describe('enterSketchWorkspace routing', () => {
  it('exactly ONE sketch-editable layer on the selected part -> opens it directly', () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [oneLayerPart()] } }))
    useCamStore.getState().setSelectedGeometry('part1')

    useCamStore.getState().enterSketchWorkspace()

    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('sketch')
    expect(st.activeSketch).not.toBeNull()
    expect(st.activeSketch!.layerId).toBe('L1')
    // No chooser was needed.
    expect(st.activeModal).toBeNull()
  })

  it('2+ sketch-editable layers on the selected part -> opens the chooser PRE-FILTERED to it', () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [twoLayerPart()] } }))
    useCamStore.getState().setSelectedGeometry('part2')

    useCamStore.getState().enterSketchWorkspace()

    const st = useCamStore.getState()
    expect(st.activeModal).toBe('sketch-entry')
    expect(st.sketchEntryFilterGeoId).toBe('part2')
    // Nothing was guessed — no document opened, mode unchanged.
    expect(st.activeSketch).toBeNull()
    expect(st.viewer.mode).toBe('setup')
  })

  it('no selection, no active document -> unchanged: unfiltered chooser opens', () => {
    useCamStore.getState().enterSketchWorkspace()

    const st = useCamStore.getState()
    expect(st.activeModal).toBe('sketch-entry')
    expect(st.sketchEntryFilterGeoId).toBeNull()
    expect(st.activeSketch).toBeNull()
  })

  it('no selection, a document IS already active -> unchanged: just shows it, no chooser', () => {
    useCamStore.getState().startNewSketch()
    const opened = useCamStore.getState().activeSketch
    expect(opened).not.toBeNull()

    useCamStore.getState().enterSketchWorkspace()

    const st = useCamStore.getState()
    expect(st.activeModal).toBeNull()
    expect(st.viewer.mode).toBe('sketch')
    expect(st.activeSketch!.id).toBe(opened!.id)
  })

  it('a selection with ZERO sketch-editable layers (e.g. a locked-only part) -> unchanged plain behavior', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [geo({
          id: 'locked1',
          layers2d: [{ id: 'L', name: '0', color: '#fff', visible: true, locked: true }],
        })],
      },
    }))
    useCamStore.getState().setSelectedGeometry('locked1')

    useCamStore.getState().enterSketchWorkspace()

    const st = useCamStore.getState()
    // Falls through exactly like "no selection" — the generic chooser, not a guess.
    expect(st.activeModal).toBe('sketch-entry')
    expect(st.sketchEntryFilterGeoId).toBeNull()
  })
})

describe('setViewerMode dead-fallback refusal (ADR-0003)', () => {
  it('a bare setViewerMode("sketch") with a SELECTED geometry and no resolved document REFUSES', () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [oneLayerPart()] } }))
    useCamStore.getState().setSelectedGeometry('part1')

    // Simulates a caller that bypasses enterSketchWorkspace/openSketchForLayer
    // and calls the raw mode switch directly — exactly the reachability the
    // audit flagged.
    useCamStore.getState().setViewerMode('sketch')

    const st = useCamStore.getState()
    // Refused: no mode switch, no fabricated document, no silent guess.
    expect(st.viewer.mode).toBe('setup')
    expect(st.activeSketch).toBeNull()
    expect(st.sketchNotice).toMatch(/could not open a sketch/i)
    expect(st.sketchNotice).toMatch(/part1\.dxf/)
  })

  it('a bare setViewerMode("sketch") with NO selection keeps the plain auto-blank-sketch behavior', () => {
    // Unchanged control case: many other suites rely on this exact
    // convenience (no selection -> always give the tools a target).
    useCamStore.getState().setViewerMode('sketch')

    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('sketch')
    expect(st.activeSketch).not.toBeNull()
  })
})
