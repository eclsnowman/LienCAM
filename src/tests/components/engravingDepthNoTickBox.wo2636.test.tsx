// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const {
  buildEngraveSmartHeightIntent,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const {
  defaultEngraveParams, defaultHeights, defaultLinking, defaultPasses,
} = await import('../../components/modals/newOperationModalDefaults')

const tool = {
  id: 'engrave-tool-1', name: '90 degree engraving bit', type: 'chamfer_mill', diameter: 6,
  tipDiameter: 0.5, fluteLength: 10, shankDiameter: 6, overallLength: 50,
  numberOfFlutes: 2, angleFromAxisDeg: 45,
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 9 },
  machine: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 9 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 15, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 5, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 10, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 9, provenance: 'inferred' },
  },
  dependencyIds: ['art-1', tool.id],
}

function geometry(): ImportedGeometry {
  return {
    id: 'art-1', name: 'Artwork.dxf', filename: 'Artwork.dxf',
    type: 'curves_2d', format: 'dxf', loaded: true, loopsVersion: 4,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 10 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 0 }, center: { x: 10, y: 10, z: 10 },
    },
    loops: [
      {
        id: 'open-path', layerId: 'art-layer', closed: false, type: 'contour', area: 0,
        points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }],
      },
      {
        id: 'closed-path', layerId: 'art-layer', closed: true, type: 'contour', area: 100,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      },
    ],
    layers2d: [{
      id: 'art-layer', name: 'Artwork', color: '#fff', visible: true,
      frame: 'geometry_local',
      projectionPlane: {
        origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
      },
    }],
  } as ImportedGeometry
}

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

function baseEngrave(): Operation {
  return {
    id: 'base-engrave', name: 'Base Engrave', type: 'engrave',
    enabled: true, status: 'ready', toolId: tool.id,
    geometrySelections: ['open-path', 'closed-path'],
    heights: { ...defaultHeights, topHeight: 10, bottomHeight: 8 },
    passes: { ...defaultPasses }, linking: { ...defaultLinking },
    params: {
      ...defaultEngraveParams, geometryId: 'art-1', loopIds: ['open-path', 'closed-path'],
    },
} as unknown as Operation
}

function smartWidthEngraveWithStaleMirrors(): Operation {
  return {
    ...baseEngrave(), id: 'smart-engrave', name: 'Smart Engrave',
    params: {
      ...defaultEngraveParams, geometryId: 'art-1', loopIds: ['open-path', 'closed-path'],
      targetLineWidth: 7, axialOffset: 9, planeOffset: -99, useWidthForDepth: false,
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildEngraveSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: defaultHeightIntent(),
        datumReference: 'geometry_plane', datumOffsetMm: 0, axialOffsetMm: 0.25,
        depth: { kind: 'line_width', targetLineWidthMm: 2 },
        scope: {
          geometryIds: ['art-1'], loopIds: ['open-path', 'closed-path'],
          includeOpen: true, includeClosed: true,
        },
      }),
    },
    resolvedHeights: snapshot,
} as unknown as Operation
}

function seed(operations: Operation[] = []) {
  const activeSetup = setup(operations)
  const preview = vi.fn(async (_setupId: string, operation: Operation) => {
    const validated = validatePersistedSmartHeightState(operation.smartHeight)
    expect(validated.ok && validated.state.kind === 'smart_v2').toBe(true)
    return smartHeightPlanFixture(operation, snapshot)
  })
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool], computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: preview,
    previewEngraveSmartHeights: vi.fn(() => snapshot),
    project: {
      ...state.project, setups: [activeSetup], activeSetupId: activeSetup.id,
      activeOperationId: activeSetup.operations[0]?.id, geometry: [geometry()],
    },
  } as never)
  return preview
}

async function authorNewEngrave(): Promise<void> {
  fireEvent.click(screen.getByText('Engrave / Trace'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'art-1' } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('engrave-height-policy')).not.toBeNull())
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

function enterDepth(depth: number) {
  const label = screen.getByText('Engraving depth')
  const input = label.closest('.op-field-row')!.querySelector('input')!
  fireEvent.change(input, { target: { value: String(depth) } })
  fireEvent.blur(input)
}

async function expectReady() {
  await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
}

function savedDepth(operation: Operation) {
  expect(operation.smartHeight).toMatchObject({ kind: 'smart_v2' })
  return (operation.smartHeight as any).intent.machining.end.value.formula.depth
}

describe('WO-2636 engraving depth without a second confirmation', () => {
  it('accepts a deliberately retyped default, but an untouched field supplies no intent', async () => {
    seed()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await authorNewEngrave()
    const input = screen.getByText('Engraving depth').closest('.op-field-row')!.querySelector('input')!
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '1.0' } })
    fireEvent.blur(input)
    await expectReady()
    fireEvent.click(screen.getByTestId('op-create'))
    expect(savedDepth(useCamStore.getState().project.setups[0].operations.at(-1)!))
      .toEqual({ kind: 'explicit', depthMm: 1 })
  })
  it('requires depth entry, then creates with that exact depth and no checkbox', async () => {
    const preview = seed()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await authorNewEngrave()
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    expect(preview).not.toHaveBeenCalled()
    enterDepth(0.8)
    await expectReady()
    expect(screen.queryByTestId('engrave-depth-confirmation')).toBeNull()
    expect(savedDepth(preview.mock.calls.at(-1)![1])).toEqual({ kind: 'explicit', depthMm: 0.8 })
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations.at(-1)!
    expect(savedDepth(created)).toEqual({ kind: 'explicit', depthMm: 0.8 })
    expect(created.geometrySelections).toEqual(['open-path', 'closed-path'])
  })

  it('updates depth again without another confirmation, including Follow the surface and re-edit', async () => {
    const preview = seed()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await authorNewEngrave()
    enterDepth(0.8)
    await expectReady()
    fireEvent.click(screen.getByTestId('engrave-follow-surface'))
    enterDepth(1.7)
    await waitFor(() => expect(savedDepth(preview.mock.calls.at(-1)![1])).toEqual({ kind: 'explicit', depthMm: 1.7 }))
    await expectReady()
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations.at(-1)!
    expect(savedDepth(created)).toEqual({ kind: 'explicit', depthMm: 1.7 })
    expect(created.smartHeight).toMatchObject({ intent: { policy: { variant: 'surface_following' } } })
    act(() => useCamStore.getState().openEditOperation('setup-1', created.id))
    fireEvent.click(screen.getByText('Heights'))
    await expectReady()
    enterDepth(2.3)
    await waitFor(() => expect(savedDepth(preview.mock.calls.at(-1)![1])).toEqual({ kind: 'explicit', depthMm: 2.3 }))
    await expectReady()
    fireEvent.click(screen.getByTestId('op-create'))
    const edited = useCamStore.getState().project.setups[0].operations.find(op => op.id === created.id)!
    expect(savedDepth(edited)).toEqual({ kind: 'explicit', depthMm: 2.3 })
    expect(edited.smartHeight).toMatchObject({ intent: { policy: { variant: 'surface_following' } } })
  })

  it('keeps width-derived depth working and accepts explicit depth after switching back', async () => {
    seed([smartWidthEngraveWithStaleMirrors()])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openEditOperation('setup-1', 'smart-engrave'))
    fireEvent.click(screen.getByText('Heights'))
    await expectReady()
    expect(screen.queryByText('Engraving depth')).toBeNull()
    fireEvent.click(screen.getByText('Passes'))
    fireEvent.click(screen.getByRole('button', { name: /Depth from line width/ }))
    fireEvent.click(screen.getByText('Heights'))
    enterDepth(0.6)
    await expectReady()
    fireEvent.click(screen.getByTestId('op-create'))
    expect(savedDepth(useCamStore.getState().project.setups[0].operations[0]))
      .toEqual({ kind: 'explicit', depthMm: 0.6 })
  })

  it('still blocks creation when real height preflight fails', async () => {
    seed()
    useCamStore.setState({ previewOperationSmartHeightPlan: vi.fn(async () => { throw new Error('No usable datum plane') }) })
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await authorNewEngrave()
    enterDepth(0.8)
    await waitFor(() => expect(screen.getByText('No usable datum plane')).not.toBeNull())
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    expect(useCamStore.getState().project.setups[0].operations).toHaveLength(0)
  })
})
