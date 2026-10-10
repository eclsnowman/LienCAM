// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'
import { fmtDim } from '../../lib/ui/unitFormat'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) }, setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const {
  deriveDrillBoreFeatureBindings,
  drillPointCompensationMm,
} = await import('../../lib/cam/smartHeights')

function setup(operations: Operation[] = []): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', notes: '', operations,
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null,
  } as unknown as Setup
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

// WO-1390 / BUG-407: the drill per-hole "auto" tooltip must show the RESOLVED
// cutter-center endpoint (drill-point compensation included), not the raw
// undented detected floor - they disagree by exactly the tool's point
// compensation whenever the tip is not flat.
describe('Drill per-hole depth tooltip reads the resolved plan (BUG-407)', () => {
  const tool = {
    id: 'drill-1', name: '6 mm Drill', type: 'drill', diameter: 6, tipDiameter: 0,
    fluteLength: 25, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
    angleFromAxisDeg: 59,
  } as unknown as Tool

  const geometry: ImportedGeometry = {
    id: 'part-1', name: 'Hole.step', filename: 'Hole.step',
    type: 'brep', format: 'step', loaded: true, stockId: undefined,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    loops: [{
      id: 'hole-1', layerId: 'holes', closed: true, type: 'contour', area: 28,
      points: [{ x: 7, y: 10 }, { x: 10, y: 13 }, { x: 13, y: 10 }, { x: 10, y: 7 }],
    }],
    layers2d: [{
      id: 'holes', name: 'Holes', color: '#fff', visible: true, frame: 'geometry_local',
      // Raw physical floor at Z=4 - what the OLD tooltip showed verbatim.
      holes: [{ center: [10, 10], diameter: 6, topZ: 10, bottomZ: 4, through: false, loopId: 'hole-1' }],
    }],
  } as ImportedGeometry

  it('shows the resolved endpoint, not the raw detected floor', async () => {
    const activeSetup = setup()
    const bindings = deriveDrillBoreFeatureBindings([geometry], ['hole-1'], 'drill')
    if (!bindings.ok) throw new Error(bindings.refusals[0].message)
    const feature = bindings.bindings[0].feature
    const rawFloorWcsMm = 4
    const pointCompMm = drillPointCompensationMm(tool)
    expect(pointCompMm).toBeGreaterThan(0)
    const resolvedEndWcsMm = rawFloorWcsMm - pointCompMm

    const owner = { kind: 'operation_policy' as const }
    const preview = vi.fn(async (_setupId: string, operation: Operation) => {
      const snapshot: ResolvedHeightSnapshotV1 = {
        version: 1,
        wcs: { clearance: 30, retract: 25, feed: 22, top: 10, bottom: resolvedEndWcsMm },
        machine: { clearance: 30, retract: 25, feed: 22, top: 10, bottom: resolvedEndWcsMm },
        intent: {
          version: 1,
          clearance: { reference: 'wcs_plane', offset: 30, provenance: 'inferred' },
          retract: { reference: 'wcs_plane', offset: 25, provenance: 'inferred' },
          feed: { reference: 'wcs_plane', offset: 22, provenance: 'inferred' },
          top: { reference: 'wcs_plane', offset: 10, provenance: 'inferred' },
          bottom: { reference: 'wcs_plane', offset: resolvedEndWcsMm, provenance: 'inferred' },
        },
        dependencyIds: [],
      }
      const base = smartHeightPlanFixture(operation, snapshot)
      return {
        ...base,
        machining: {
          ...base.machining,
          featureEndpoints: [{
            feature,
            physicalTarget: { wcsMm: rawFloorWcsMm, machineMm: rawFloorWcsMm, owner, proofNodeIds: [] },
            cutterCenterEnd: { wcsMm: resolvedEndWcsMm, machineMm: resolvedEndWcsMm, owner, proofNodeIds: [] },
          }],
        },
      }
    })
    const state = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [tool], computeOperationToolpath: vi.fn(),
      previewOperationSmartHeightPlan: preview,
      project: {
        ...state.project, setups: [activeSetup], activeSetupId: activeSetup.id,
        geometry: [geometry],
      },
    } as never)

    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Drill'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(tool.name))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'part-1' } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    expect(preview).toHaveBeenCalled()

    fireEvent.click(screen.getByText('Passes'))
    const input = await screen.findByTestId('drill-perhole-input')
    const tooltip = input.getAttribute('data-tooltip') ?? ''
    expect(tooltip).toContain(fmtDim(resolvedEndWcsMm, 'mm'))
    expect(tooltip).not.toContain(fmtDim(rawFloorWcsMm, 'mm'))
  })
})

// WO-1390 / BUG-414: the height diagram's top/bottom lines must match the
// numeric rows beside them, both driven by the SAME resolved Smart Height
// plan - not a legacy reference calculation that can disagree with it.
describe('Height diagram reflects the Thread Mill resolved plan (BUG-414)', () => {
  const tool = {
    id: 'thread-tool-1', name: 'Thread Mill 6 mm', type: 'flat_end_mill', diameter: 6,
    fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 3,
  } as unknown as Tool

  const geometry: ImportedGeometry = {
    id: 'part-1', name: 'Circle.dxf', filename: 'Circle.dxf',
    type: 'curves_2d', format: 'dxf', loaded: true, loopsVersion: 3,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    loops: [{
      id: 'thread-loop', layerId: 'thread-layer', closed: true, type: 'hole', area: 28,
      points: [{ x: 7, y: 10 }, { x: 10, y: 13 }, { x: 13, y: 10 }, { x: 10, y: 7 }],
    }],
    layers2d: [{ id: 'thread-layer', name: 'Thread', color: '#fff', visible: true, frame: 'geometry_local' }],
  } as ImportedGeometry

  // Distinct from defaultHeights (topHeight: 0, bottomHeight: -5) so a diagram
  // that fell back to the legacy mirror/reference calc would visibly disagree.
  const snapshot: ResolvedHeightSnapshotV1 = {
    version: 1,
    wcs: { clearance: 30, retract: 25, feed: 22, top: 10, bottom: 2 },
    machine: { clearance: 30, retract: 25, feed: 22, top: 10, bottom: 2 },
    intent: {
      version: 1,
      clearance: { reference: 'wcs_plane', offset: 30, provenance: 'inferred' },
      retract: { reference: 'wcs_plane', offset: 25, provenance: 'inferred' },
      feed: { reference: 'wcs_plane', offset: 22, provenance: 'inferred' },
      top: { reference: 'wcs_plane', offset: 10, provenance: 'inferred' },
      bottom: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
    },
    dependencyIds: [],
  }

  it("the diagram's top/bottom lines match the resolved plan", async () => {
    const preview = vi.fn(async (_setupId: string, operation: Operation) =>
      smartHeightPlanFixture(operation, snapshot))
    const activeSetup = setup()
    const state = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [tool], computeOperationToolpath: vi.fn(),
      previewOperationSmartHeightPlan: preview,
      project: {
        ...state.project, setups: [activeSetup], activeSetupId: activeSetup.id,
        geometry: [geometry],
      },
    } as never)

    const { container } = render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Thread Mill'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(tool.name))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'part-1' } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    expect(preview).toHaveBeenCalled()

    const diagramTexts = Array.from(container.querySelectorAll('svg.op-heights-diag text'))
    const topRow = diagramTexts.find(el => el.textContent?.startsWith('Top of cut'))
    const bottomRow = diagramTexts.find(el => el.textContent?.startsWith('Bottom of cut'))
    expect(topRow?.textContent).toContain('+10 mm')
    expect(bottomRow?.textContent).toContain('+2 mm')
  })
})
