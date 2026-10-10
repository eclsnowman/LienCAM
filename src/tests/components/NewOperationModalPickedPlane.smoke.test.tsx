// @vitest-environment jsdom
//
// React-render SMOKE test for the 'picked_plane' MANUAL datum UI in
// NewOperationModal.
//
// WHY THIS EXISTS: the 'picked_plane' heightReference backend (resolver reads
// params.referencePlaneGeo = {geoId,faceIndex,localZ} + planeOffset) already
// ships; this test guards the UI that SETS it. Selecting "Picked surface" in the
// Reference plane dropdown must render the "Pick face on model" button
// (data-testid="pick-datum-face") and, with nothing picked yet, the
// "No surface picked yet" hint. tsc + pure vitest cannot catch render/hooks-order
// behavior, so this mounts the real modal on a contour op and drives the dropdown.
// jsdom cannot run OCCT, so the actual face pick is NOT exercised here (proven by
// a real-app harness later).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags; the
// store's persist() needs a working backend. Install an in-memory shim BEFORE the
// store import. Pure test scaffolding; no app change. (Same pattern as the loops
// smoke test alongside this one.)
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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const GEO_ID = 'geo-test'
const SETUP_ID = 'setup-test'

// A geometry with one closed loop + a setup the modal can find via activeSetupId.
// Cast loosely — render scaffolding; the modal only reads id/name/type/loops here.
function seedProject() {
  const loops = [
    { id: 'loop-a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, type: 'contour', layerId: 'L', area: 100 },
  ]
  const geometry = [{
    id: GEO_ID, name: 'part.svg', type: 'curves_2d', format: 'svg', loaded: true, loops,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
  }]
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

// Open the modal (default op is contour_2d), select the test geometry on the
// Geometry tab, then land on the Heights tab where the Reference plane dropdown
// (data-testid="ref-plane-select") renders.
function openModalOnHeights() {
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, { target: { value: GEO_ID } })
  fireEvent.click(screen.getByText('Heights'))
}

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

// 2026-08-18: the two picked_plane datum tests were retired. The V1
// reference-plane picker ('ref-plane-select' with a "Picked surface" datum)
// is no longer the pocket's height authority since the V2-only cutover
// (2e5678b7); pocket/adaptive author a planar-rough Smart Height policy
// instead (PlanarRoughSmartHeightOperationUI tests). ADR-0040: no legacy path.
describe('NewOperationModal picked_plane datum smoke', () => {

  // Q-92 ("when you explicitly ask me to select a face it should really turn
  // off all body selection anyway"): arming the datum pick clears the whole-body
  // selection AND its live orange viewport highlight, arms the raycast UNSCOPED
  // (the datum carries its own geoId, so its face never needed the operation's
  // source body preselected), and exiting restores ordinary behaviour exactly.

  // Ordinary whole-body selection is untouched outside face-pick mode: no
  // suspension exists, and selecting/clearing a body behaves exactly as before.
  it('leaves ordinary body selection alone when no face pick is armed', () => {
    seedProject()
    render(<NewOperationModal />)
    openModalOnHeights()

    expect(useCamStore.getState().facePickBodySuspension).toBeNull()
    act(() => { useCamStore.getState().setSelectedGeometry(GEO_ID) })
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(GEO_ID)
    act(() => { useCamStore.getState().setSelectedGeometry(null) })
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()
    // A stray end with nothing suspended must never resurrect a selection.
    expect(useCamStore.getState().endFacePickBodySelection()).toBeNull()
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()
  })
})
