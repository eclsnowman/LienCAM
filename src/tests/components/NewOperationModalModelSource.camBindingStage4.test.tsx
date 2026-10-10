// @vitest-environment jsdom
//
// CAM-BINDING Stage 4 (coordination/work-orders/CAM-BINDING.md): the
// existing "Section at Z -> pocket" wizard flow now ALSO offers itself for a
// modeled body (format:'model'), UI-level. Extends
// NewOperationModalModelSource.camBindingStage1.test.tsx's harness (same
// seeded model row shape) rather than duplicating it - that Stage 1 file now
// asserts the section button DOES render for a model row; this file covers
// the rest of the Stage 4 UI surface: WORLD-coordinate Z-range labeling (vs.
// the brep path's model-coordinate labeling), the "Set in viewport" live-
// scrub button staying brep-only (Stage 4's disclosed scope boundary), and a
// click deriving a real snapshot layer end-to-end through the real store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ImportedGeometry, ModelItemPlacementRecord, Setup } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: memStorage,
  configurable: true,
})

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const MODEL_ID = 'modelbody:F1'

interface Pt2 { x: number; y: number }
function buildWallMesh(polygons: Pt2[][], z0: number, z1: number): { positions: number[]; indices: number[] } {
  const positions: number[] = []
  const indices: number[] = []
  for (const pts of polygons) {
    const n = pts.length
    const base = positions.length / 3
    for (let i = 0; i < n; i++) {
      positions.push(pts[i].x, pts[i].y, z0)
      positions.push(pts[i].x, pts[i].y, z1)
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const b0 = base + 2 * i, t0 = base + 2 * i + 1
      const b1 = base + 2 * j, t1 = base + 2 * j + 1
      indices.push(b0, b1, t1)
      indices.push(b0, t1, t0)
    }
  }
  return { positions, indices }
}
const rectCW20x20: Pt2[] = [
  { x: 0, y: 0 }, { x: 0, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 0 },
]

function seedProject(placementOffsetZ = 0) {
  const mesh = buildWallMesh([rectCW20x20], 0, 10)
  const geometry = [
    {
      id: MODEL_ID,
      name: 'Model F1',
      type: 'model',
      format: 'model',
      filename: 'Model F1',
      loaded: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 20, y: 20, z: 10 },
      },
      modelItemId: 'legacy',
      modelBody: {
        ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 },
        display: {
          positions: mesh.positions, normals: [], indices: mesh.indices,
          edgePositions: [], edgeOffsets: [],
          bbox: { min: [0, 0, 0], max: [20, 20, 10] },
        },
      },
    },
  ] as unknown as ImportedGeometry[]
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null, operations: [], notes: '',
  } as unknown as Setup
  const modelItemPlacements: ModelItemPlacementRecord[] = [
    { modelItemId: 'legacy', position: { x: 0, y: 0, z: placementOffsetZ }, rotation: { x: 0, y: 0, z: 0 } },
  ]

  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project,
      geometry, setups: [setup], activeSetupId: setup.id, modelItemPlacements,
    },
  })
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartPickMode: vi.fn(),
    setSelectedPart: vi.fn(),
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

function openWizardOnModelSource() {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Geometry'))
  const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: MODEL_ID } })
}

describe('CAM-BINDING Stage 4: Section-at-Z UI for a modeled body', () => {
  it('shows the Section-at-Z button + Z input, labeled in WORLD coords, and hides the live-scrub "Set in viewport" button (brep-only scope)', () => {
    seedProject()
    openWizardOnModelSource()

    expect(screen.getByTestId('brep-section-z')).toBeTruthy()
    expect(screen.getByTestId('brep-section-z-input')).toBeTruthy()
    expect(screen.queryByTestId('brep-section-viewport')).toBeNull()
    expect(screen.getByText(/world coords/i)).toBeTruthy()
  })

  it('the Z-range label reflects the PLACEMENT-shifted world range, not the raw local bbox', () => {
    seedProject(50) // Model Item Placement moved the body +50mm in Z
    openWizardOnModelSource()

    // Local bbox z is [0,10]; Placement position.z=50 -> world range [50,60].
    expect(screen.getByText(/50\.000.*60\.000|50.*60/)).toBeTruthy()
  })

  it('clicking Section at Z lands a real derived layer on the model row and auto-selects its loops for the op', async () => {
    seedProject()
    openWizardOnModelSource()

    const zInput = screen.getByTestId('brep-section-z-input') as HTMLInputElement
    fireEvent.change(zInput, { target: { value: '5' } })
    fireEvent.blur(zInput)
    fireEvent.click(screen.getByTestId('brep-section-z'))

    await waitFor(() => {
      const geo = useCamStore.getState().project.geometry.find((g) => g.id === MODEL_ID)!
      expect((geo.loops ?? []).length).toBeGreaterThan(0)
    })
    expect(screen.queryByTestId('brep-derive-error')).toBeNull()
  })
})
