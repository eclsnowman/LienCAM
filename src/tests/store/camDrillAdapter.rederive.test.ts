// CAM-DRILL-ADAPTER: store-level re-derive / amber on model edit for drill ops.
//
// MUTATION proof: delete markDrillTargetOpsOutdated from syncModelBodies
// or from updateModelItemPlacement -> these tests go RED (status stays ready).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ModelBodyDisplay } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'

const { useCamStore } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')

function display(min: [number, number, number], max: [number, number, number]): ModelBodyDisplay {
  return {
    positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
    bbox: { min, max },
  }
}

let idb: FakeIndexedDBHandle
beforeEach(() => {
  resetDocumentHolder()
  idb = installFakeIndexedDB()
  vi.clearAllMocks()
  useCamStore.getState().newProject()
})
afterEach(() => { idb.restore() })

function seedDrillOpOnBody(bodyId: string): void {
  useCamStore.getState().syncModelBodies({
    live: [{ bodyId, name: 'Plate' }],
    derived: [{
      bodyId, version: 1, stableIds: [`${bodyId}:F0`],
      display: display([-20, -15, 0], [20, 15, 10]),
    }],
  })
  const state = useCamStore.getState()
  const geo = state.project.geometry.find((g) => g.format === 'model')
  expect(geo).toBeDefined()
  const toolId = state.toolLibrary[0]?.id ?? 'tool-1'
  if (!state.toolLibrary[0]) {
    useCamStore.setState({
      toolLibrary: [{
        id: toolId, name: 'D6', type: 'drill', diameter: 6,
        fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
      } as never],
    })
  }
  const op = {
    id: 'op-drill-1',
    name: 'Drill holes',
    type: 'drill',
    enabled: true,
    status: 'ready',
    toolId,
    geometrySelections: [],
    modelReferences: [{ bodyId, stableIds: [`${bodyId}:wall`], role: 'drill-targets' }],
    heights: {
      clearanceHeight: 15, clearanceHeightMode: 'absolute',
      retractHeight: 5, feedHeight: 2, topHeight: 0, topHeightMode: 'absolute',
      bottomHeight: -5, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: geo!.id, loopIds: [], cycleType: 'simple', peckDepth: 2,
      chipBreakRetract: 1, dwell: 0, retractMode: 'retract', sortStrategy: 'none',
    },
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' }],
  } as never
  const existing = useCamStore.getState().project.setups
  if (existing.length === 0) {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        setups: [{
          id: 'setup-1', name: 'Setup 1', operations: [op],
          wcs: {
            id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          },
          stock: null, notes: '',
        } as never],
        activeSetupId: 'setup-1',
      },
    }))
  } else {
    useCamStore.getState().addOperation(existing[0].id, op)
  }
}

function findDrillOp() {
  for (const s of useCamStore.getState().project.setups) {
    const op = s.operations.find((o) => o.id === 'op-drill-1')
    if (op) return op
  }
  return undefined
}

describe('CAM-DRILL-ADAPTER store re-derive amber', () => {
  it('syncModelBodies updated body ambers drill-targets op and retains toolpath', () => {
    seedDrillOpOnBody('BODY-A')
    let op = findDrillOp()
    expect(op?.status).toBe('ready')
    expect(op?.toolpathMoves?.length).toBe(1)

    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'BODY-A', name: 'Plate' }],
      derived: [{
        bodyId: 'BODY-A', version: 2, stableIds: ['BODY-A:F0'],
        display: display([-20, -15, 0], [20, 15, 12]),
      }],
    })
    op = findDrillOp()
    expect(op?.status).toBe('outdated')
    expect(op?.modelReferenceNote).toMatch(/drill hole targets/i)
    expect(op?.toolpathMoves?.length).toBe(1)
  })

  it('updateModelItemPlacement ambers drill-targets op on that item', () => {
    seedDrillOpOnBody('BODY-B')
    useCamStore.getState().updateModelItemPlacement(
      'legacy', undefined,
      { x: 5, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    )
    const op = findDrillOp()
    expect(op?.status).toBe('outdated')
    expect(op?.toolpathMoves?.length).toBe(1)
  })
})

