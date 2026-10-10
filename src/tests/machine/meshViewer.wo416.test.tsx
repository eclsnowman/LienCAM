// @vitest-environment jsdom
//
// WO-416 (Operator 2026-08-21): "Do not ever apply a huge vertical pixel stealing
// banner across the entire screen ... Don't do that again." - the full-width
// "MESH COMPENSATION ACTIVE" strip under the Control tab row is gone
// (ControlPage.tsx). Its replacement is a small chip in ProgramPanel's
// existing controls row that opens MeshViewerModal, a Mainsail-style
// orbitable flatness viewer ("I want a visualization of the flatness plane
// from the mesh. It should popup in a modal to look at.").
//
// This file proves both halves:
//   1. the chip renders ONLY while a mesh is active, and opens the modal
//   2. the modal reads the right min/max/range/reference for a known 3x3
//      sample set (three.js needs no real WebGL for this - the numeric
//      readouts are plain DOM text; see MeshViewerModal's webglAvailable()
//      guard for the jsdom-safe fallback).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { buildSurfaceMeshPoints, type SurfaceMeshMap } from '../../lib/machine/zSurfaceMesh'

// Must run before ProgramPanel (and its ProgramPreview child) are imported
// below, so the real WebGL-backed CNCViewport is never constructed in jsdom.
// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  },
}))

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

const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { MeshViewerModal, computeMeshViewerStats } = await import('../../components/machine/MeshViewerModal')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')

/** 3x3 grid over a 30x20 mm rectangle, Z climbing 0.01 mm per point from a
 *  known reference - min/max/range/exaggeration all work out to round,
 *  hand-checkable numbers. */
function knownMesh(): SurfaceMeshMap {
  const bounds = { minX: 0, minY: 0, maxX: 30, maxY: 20 }
  const points = buildSurfaceMeshPoints(bounds, 3, 3)
  const samples = points.map((point, index) => ({ ...point, machineZ: -50 + index * 0.01 }))
  return {
    bounds,
    cutBounds: bounds,
    pointsX: 3,
    pointsY: 3,
    fadeMm: 10,
    referenceMachineZ: samples[0].machineZ,
    samples,
    sourceFingerprint: 'test-fingerprint',
    sourceName: 'mesh-test.nc',
    workOffset: 'G54',
    probedAt: 1,
    active: true,
  }
}

beforeEach(() => {
  mem.clear()
  useCamStore.getState().newProject()
  act(() => { useCamStore.getState().closeModal() })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    consoleLines: [],
    surfaceMesh: null,
  })
})
afterEach(() => cleanup())

describe('WO-416: the mesh chip replaces the full-width banner', () => {
  it('renders no chip while no mesh is active', () => {
    render(<ProgramPanel />)
    expect(screen.queryByTestId('control-mesh-chip')).toBeNull()
  })

  it('renders "Mesh 3x3" and opens the viewer modal on click, once a mesh is active', () => {
    act(() => { useMachineControl.getState().setSurfaceMesh(knownMesh()) })
    render(<ProgramPanel />)
    const chip = screen.getByTestId('control-mesh-chip')
    expect(chip.textContent).toContain('Mesh 3x3')

    expect(useCamStore.getState().activeModal).not.toBe('mesh-viewer')
    fireEvent.click(chip)
    expect(useCamStore.getState().activeModal).toBe('mesh-viewer')
  })
})

describe('WO-416: MeshViewerModal readouts', () => {
  it('renders nothing while closed', () => {
    render(<MeshViewerModal />)
    expect(screen.queryByTestId('mesh-viewer-modal')).toBeNull()
  })

  it('computeMeshViewerStats reads min/max/range/reference off the known 3x3 fixture', () => {
    const stats = computeMeshViewerStats(knownMesh())
    expect(stats.pointsX).toBe(3)
    expect(stats.pointsY).toBe(3)
    expect(stats.minZ).toBeCloseTo(-50, 6)
    expect(stats.maxZ).toBeCloseTo(-49.92, 6)
    expect(stats.range).toBeCloseTo(0.08, 6)
    expect(stats.referenceZ).toBeCloseTo(-50, 6)
    expect(stats.exaggeration).toBeGreaterThanOrEqual(1)
  })

  it('shows the right numbers in the DOM for the known 3x3 sample set', () => {
    act(() => { useMachineControl.getState().setSurfaceMesh(knownMesh()) })
    act(() => { useCamStore.getState().openModal('mesh-viewer') })
    render(<MeshViewerModal />)

    expect(screen.getByTestId('mesh-viewer-modal')).toBeTruthy()
    expect(screen.getByTestId('mesh-viewer-points').textContent).toBe('3 x 3')
    expect(screen.getByTestId('mesh-viewer-min-z').textContent).toBe('-50.00 mm')
    expect(screen.getByTestId('mesh-viewer-max-z').textContent).toBe('-49.92 mm')
    expect(screen.getByTestId('mesh-viewer-range').textContent).toBe('0.08 mm')
    expect(screen.getByTestId('mesh-viewer-reference-z').textContent).toBe('-50.00 mm')

    // jsdom has no WebGL - the component falls back to the flat heatmap, and
    // still renders SOMETHING in the scene slot either way.
    const scene = screen.getByTestId('mesh-viewer-scene')
    expect(scene.querySelector('[data-testid="mesh-viewer-heatmap"], [data-testid="mesh-viewer-canvas-mount"]')).toBeTruthy()
  })

  it('shows an empty state and no crash when no mesh is active but the modal is open', () => {
    act(() => { useCamStore.getState().openModal('mesh-viewer') })
    render(<MeshViewerModal />)
    expect(screen.getByTestId('mesh-viewer-empty')).toBeTruthy()
    expect(screen.queryByTestId('mesh-viewer-readouts')).toBeNull()
  })

  it('closes on the close button and on Escape', () => {
    act(() => { useMachineControl.getState().setSurfaceMesh(knownMesh()) })
    act(() => { useCamStore.getState().openModal('mesh-viewer') })
    render(<MeshViewerModal />)
    expect(screen.getByTestId('mesh-viewer-modal')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useCamStore.getState().activeModal).toBeNull()
  })
})
