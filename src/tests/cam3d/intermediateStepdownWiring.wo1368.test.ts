// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeAdaptive3dMoves,
  readAdaptive3dParams,
  type Adaptive3dParams,
} from '../../cam3d/integration/adaptive3dOperation'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough'
import type { Cam3dClient } from '../../cam3d/worker/client'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null,
  key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

const SETUP_ID = 'setup-wo1368'
const GEO_ID = 'geo-wo1368'
const OP_ID = 'op-wo1368'
const TOOL_ID = 'tool-wo1368'

const tool = {
  id: TOOL_ID,
  name: 'WO-1368 Flat 6mm',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 20,
  numberOfFlutes: 2,
} as unknown as Tool

const partMesh: PartMesh = {
  positions: new Float32Array([0, 0, 0, 20, 0, 0, 0, 20, 10]),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: [0, 0, 0], max: [20, 20, 10] },
  source: 'fixture',
}

function geometry(): ImportedGeometry {
  return {
    id: GEO_ID,
    name: 'WO-1368 Widget',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    stockId: 'stock-wo1368',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
  } as unknown as ImportedGeometry
}

function setup(operations: Operation[] = []): Setup {
  return {
    id: SETUP_ID,
    name: 'WO-1368 Setup',
    wcs: {
      id: 'wcs-wo1368',
      label: 'G54',
      fixtureOffset: 54,
      stockId: 'stock-wo1368',
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null,
    operations,
    notes: '',
  } as unknown as Setup
}

function existingAdaptiveOperation(): Operation {
  return {
    id: OP_ID,
    name: 'WO-1368 Existing Rough',
    type: 'adaptive_3d',
    enabled: true,
    status: 'ready',
    toolId: TOOL_ID,
    geometrySelections: [GEO_ID],
    heights: {
      clearanceHeight: 15,
      clearanceHeightMode: 'absolute',
      retractHeight: 12,
      feedHeight: 10.5,
      topHeight: 10,
      topHeightMode: 'absolute',
      bottomHeight: 0,
      bottomHeightMode: 'absolute',
    },
    passes: {
      stepdown: 3,
      stepover: 2.4,
      stockToLeave: 0,
      finishPasses: 1,
      springPasses: 0,
    },
    linking: {},
    // This represents a project saved before WO-1368: the new flag is absent.
    params: {
      maxStepdown: 3,
      stepover: 0.4,
      millingDirection: 'climb',
      tolerance: 0.05,
      helixDiameter: 3,
      radialStockToLeave: 0,
      axialStockToLeave: 0,
      cellSize: 0,
      useStockBoundary: false,
    },
  } as unknown as Operation
}

const previewSnapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 0 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 0 },
  intent: defaultHeightIntent(),
  dependencyIds: ['stock:stock-wo1368', `geometry:${GEO_ID}`, `tool:${TOOL_ID}`],
}

function seedModal(): void {
  act(() => {
    const current = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [tool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, previewSnapshot)),
      project: {
        ...current.project,
        geometry: [geometry()],
        setups: [setup()],
        activeSetupId: SETUP_ID,
      },
    } as never)
  })
}

function seedProperties(): void {
  act(() => {
    const current = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [tool],
      project: {
        ...current.project,
        geometry: [geometry()],
        setups: [setup([existingAdaptiveOperation()])],
        activeSetupId: SETUP_ID,
        activeOperationId: OP_ID,
      },
      viewer: {
        ...current.viewer,
        selectedGeometryId: null,
        selectedStockId: null,
        selectedNestId: null,
      },
    } as never)
  })
}

async function emitRough(paramsRecord: Record<string, unknown>): Promise<{
  moves: Awaited<ReturnType<typeof computeAdaptive3dMoves>>['moves']
  strategyInput: AdaptiveRoughInput
}> {
  let strategyInput: AdaptiveRoughInput | undefined
  const client = {
    generateAdaptiveRough: vi.fn(async (input: AdaptiveRoughInput) => {
      strategyInput = input
      return {
        ir: {
          moves: [
            { t: 'rapid' as const, x: 1, y: 1, z: 15, role: 'rapid' as const },
            { t: 'feed' as const, x: 5, y: 5, z: 7, role: 'cut' as const },
            ...(input.intermediateStepdown
              ? [{ t: 'feed' as const, x: 8, y: 8, z: 5.5, role: 'cut' as const }]
              : []),
          ],
          meta: {
            strategyId: 'adaptive_rough',
            cutterId: TOOL_ID,
            params: { floorZ: 0, intermediateStepdown: input.intermediateStepdown === true },
          },
        },
      }
    }),
  } as unknown as Cam3dClient

  const result = await computeAdaptive3dMoves({
    partMesh,
    tool,
    params: readAdaptive3dParams(paramsRecord),
    stockBounds: { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 10 },
    stockBoundsAreRealStock: true,
    resolvedHeights: { clearanceZ: 15, retractZ: 12, feedZ: 10.5, topZ: 10, bottomZ: 0 },
    client,
  })
  if (strategyInput === undefined) throw new Error('Adaptive strategy was not called')
  return { moves: result.moves, strategyInput }
}

afterEach(cleanup)
beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})

describe('WO-1368 optional reduced-stair-step wiring', () => {
  it('carries the New Operation selection through op.params to a changed rough', async () => {
    seedModal()
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Passes'))

    const toggle = screen.getByTestId('op-adaptive3d-reduce-stair-steps') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(toggle.closest('label')?.title).toContain('finish path and finish time stay unchanged')
    fireEvent.click(toggle)

    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(tool.name))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    expect((created.params as Partial<Adaptive3dParams>).intermediateStepdown).toBe(true)

    const disabled = await emitRough({ ...created.params, intermediateStepdown: false })
    const enabled = await emitRough(created.params)
    expect(disabled.strategyInput.intermediateStepdown).toBe(false)
    expect(enabled.strategyInput.intermediateStepdown).toBe(true)
    expect(enabled.moves).not.toEqual(disabled.moves)
  })

  it('defaults an existing operation off and carries a Properties edit to the strategy', async () => {
    seedProperties()
    render(createElement(PropertiesPanel))

    const toggle = screen.getByTestId('props-adaptive3d-reduce-stair-steps') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(toggle.closest('label')?.title).toContain('roughing removes more material')
    fireEvent.click(toggle)

    const updated = useCamStore.getState().project.setups[0].operations[0]
    expect((updated.params as Partial<Adaptive3dParams>).intermediateStepdown).toBe(true)
    expect(updated.status).toBe('outdated')

    const disabled = await emitRough({ ...updated.params, intermediateStepdown: false })
    const enabled = await emitRough(updated.params)
    expect(enabled.strategyInput.intermediateStepdown).toBe(true)
    expect(enabled.moves).not.toEqual(disabled.moves)
  })

  it('keeps a pre-WO-1368 operation byte-identical to explicit off', async () => {
    const legacyParams = existingAdaptiveOperation().params
    expect(readAdaptive3dParams(legacyParams).intermediateStepdown).toBe(false)

    const legacy = await emitRough(legacyParams)
    const explicitOff = await emitRough({ ...legacyParams, intermediateStepdown: false })
    expect(legacy.strategyInput.intermediateStepdown).toBe(false)
    expect(legacy.moves).toEqual(explicitOff.moves)
  })
})
