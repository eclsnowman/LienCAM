// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import type {
  BoundingBox,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  Setup,
  Vec3,
  WCS,
} from '../../types'

const { useCamStore } = await import('../../store')

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min },
    max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    },
  }
}

function readyOp(): Operation {
  return {
    id: 'op-1',
    name: 'Pocket',
    type: 'pocket_2d',
    toolId: 'tool-1',
    status: 'ready',
    geometrySelections: [],
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 }],
    passes: { stepdown: 1, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    params: {},
    heights: {
      clearanceHeight: 10,
      retractHeight: 5,
      feedHeight: 2,
      topHeight: 0,
      bottomHeight: -1,
    },
  } as unknown as Operation
}

function wcs(over: Partial<WCS> = {}): WCS {
  return {
    id: 'wcs-1',
    label: 'G54',
    fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
    originBinding: { kind: 'manual' },
    ...over,
  }
}

function setup(over: Partial<Setup> = {}): Setup {
  return {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: wcs(),
    stock: { type: 'rectangular' },
    operations: [readyOp()],
    notes: '',
    ...over,
  } as unknown as Setup
}

function geometry(stockId: string): ImportedGeometry {
  return {
    id: 'geo-1',
    name: 'Part',
    filename: 'part.dxf',
    type: 'curves_2d',
    format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId,
    loops: [{
      id: 'old-loop',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true,
      type: 'contour',
      layerId: 'layer-1',
      area: 100,
    }],
    layers2d: [{ id: 'layer-1', name: 'Layer', color: '#fff', visible: true }],
  } as ImportedGeometry
}

beforeEach(() => {
  useCamStore.getState().newProject()
})

describe('INT-8C WCS and stock correctness', () => {
  it('deep-merges partial WCS edits and invalidates trusted moves only for origin/binding changes', () => {
    useCamStore.setState((state) => ({
      project: { ...state.project, setups: [setup()], activeSetupId: 'setup-1' },
    }))

    useCamStore.getState().updateSetup('setup-1', { wcs: { label: 'G55' } })
    let current = useCamStore.getState().project.setups[0]
    expect(current.wcs).toMatchObject({
      label: 'G55',
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
    })
    expect(current.operations[0].status).toBe('ready')

    useCamStore.getState().updateSetup('setup-1', {
      wcs: {
        origin: { x: 12, y: 3, z: 1 },
        stockId: 'stock-b',
        originBinding: {
          kind: 'stock_corner',
          stockId: 'stock-b',
          cornerRow: 2,
          cornerCol: 0,
          cornerFace: 'top',
        },
      },
    })
    current = useCamStore.getState().project.setups[0]
    expect(current.wcs.label).toBe('G55')
    expect(current.wcs.origin).toEqual({ x: 12, y: 3, z: 1 })
    expect(current.operations[0].status).toBe('outdated')
    expect(current.operations[0].toolpathMoves).toBeUndefined()
  })

  it('removing fixed stock reassigns parts, repoints WCS, and clears selection', () => {
    const fixedId = 'fixed-a'
    const stocks: PhysicalStock[] = [
      {
        id: fixedId,
        name: 'Fixed A',
        mode: 'explicit',
        bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 10 }),
        position: { x: 0, y: 0, z: 0 },
      },
      {
        id: DERIVED_STOCK_ID,
        name: 'Auto Stock',
        mode: 'derived',
        bounds: bbox({ x: -5, y: -5, z: 0 }, { x: 15, y: 15, z: 5 }),
        position: { x: 0, y: 0, z: 0 },
      },
    ]
    const boundWcs = wcs({
      stockId: fixedId,
      cornerRow: 2,
      cornerCol: 0,
      cornerFace: 'top',
      originBinding: {
        kind: 'stock_corner',
        stockId: fixedId,
        cornerRow: 2,
        cornerCol: 0,
        cornerFace: 'top',
      },
    })
    useCamStore.setState((state) => ({
      viewer: { ...state.viewer, selectedStockId: fixedId },
      project: {
        ...state.project,
        geometry: [geometry(fixedId)],
        stocks,
        setups: [setup({ wcs: boundWcs })],
        sceneStock: {
          ...state.project.sceneStock,
          mode: 'fixed',
          fixedStocks: [{
            id: fixedId,
            name: 'Fixed A',
            width: 20,
            height: 20,
            depth: 10,
            position: { x: 0, y: 0, z: 0 },
          }],
        },
      },
    }))

    useCamStore.getState().removeFixedStock(fixedId)
    const state = useCamStore.getState()
    expect(state.viewer.selectedStockId).toBeNull()
    expect(state.project.geometry[0].stockId).toBe(DERIVED_STOCK_ID)
    expect(state.project.setups[0].wcs.stockId).toBe(DERIVED_STOCK_ID)
    expect(state.project.setups[0].wcs.originBinding).toMatchObject({
      kind: 'stock_corner',
      stockId: DERIVED_STOCK_ID,
    })
  })

  it('rewraps stored Auto Stock bounds after a sketch loop edit', () => {
    const autoStock: PhysicalStock = {
      id: DERIVED_STOCK_ID,
      name: 'Auto Stock',
      mode: 'derived',
      bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 12, y: 12, z: 1 }),
      position: { x: 0, y: 0, z: 0 },
    }
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        geometry: [geometry(DERIVED_STOCK_ID)],
        stocks: [autoStock],
        sceneStock: {
          ...state.project.sceneStock,
          mode: 'auto',
          autoOffsetXY: 2,
          autoOffsetZTop: 1,
        },
      },
    }))

    useCamStore.getState().setGeometryLoops(
      'geo-1',
      [{
        id: 'incoming-id',
        points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 0, y: 10 }],
        closed: true,
        type: 'contour',
        layerId: 'layer-1',
        area: 300,
      }],
      [{ id: 'layer-1', name: 'Layer', color: '#fff', visible: true }],
    )

    const stored = useCamStore.getState().project.stocks?.find((item) => item.id === DERIVED_STOCK_ID)
    expect(stored?.bounds.min).toEqual({ x: -5, y: -5, z: 0 })
    expect(stored?.bounds.max).toEqual({ x: 35, y: 15, z: 5 })
  })
})
