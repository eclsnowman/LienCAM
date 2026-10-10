// ADR-0003 fail-loud guard: an operation whose source geometry has no stock
// (explicit "None", or otherwise unresolvable to a stock) must NOT silently emit
// a toolpath. computeOperationToolpath blocks compute at the geometry-resolution
// seam and lands a named error on the op.
//
// Tests:
//   1. An op on a None-stock geometry sets status='error' with a message naming
//      the geometry + "not assigned to any stock".
//   2. An op on a stocked (named) geometry is NOT blocked by this guard (it gets
//      past it — here, into the computing state / worker dispatch).

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type {
  ImportedGeometry, SceneStock, PhysicalStock, BoundingBox, Vec3, Project,
  Setup, Operation, WCS, Tool, HeightParams, PassParams, LinkingParams,
} from '../../types'

// -- Fixtures -----------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'WidgetPart', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  } as ImportedGeometry
}

function derivedStock(id = DERIVED_STOCK_ID, name = 'Auto Stock 1'): PhysicalStock {
  return {
    id, name, mode: 'derived',
    bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 12, y: 12, z: 1 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function autoSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], ...over,
  }
}

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 1.5, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

function makeOp(): Operation {
  return {
    id: 'op-1', name: 'Profile Cut', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: ['loop-1'],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { geometryId: 'geo-1', side: 'outside', direction: 'climb' },
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights, geometryIds: ['geo-1'],
    }),
  }
}

function makeWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
}

function makeSetup(ops: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: ops, notes: '',
  }
}

const tool: Tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

function installProject(geo: ImportedGeometry, stocks: PhysicalStock[]): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project,
      geometry: [geo],
      stocks,
      setups: [makeSetup([makeOp()])],
      sceneStock: autoSceneStock(),
    } as Project,
  }))
}

function opStatus(): Operation {
  const op = useCamStore.getState().project.setups[0].operations[0]
  return op
}

// =============================================================================

describe('computeOperationToolpath: fail-loud on no-stock geometry (ADR-0003)', () => {
  it('an op on an explicit-None geometry errors, naming the part + no-stock', () => {
    // geo-1 is explicit None: locked + no stockId.
    installProject(
      makeGeo({ stockId: undefined, stockIdLocked: true }),
      [derivedStock()],
    )
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    const op = opStatus()
    expect(op.status).toBe('error')
    expect(op.errorMessage).toMatch(/WidgetPart/)
    expect(op.errorMessage).toMatch(/not assigned to any stock/)
  })

  it('an op on a geometry with a dangling stock id also errors', () => {
    installProject(
      makeGeo({ stockId: 'ghost-stock', stockIdLocked: true }),
      [derivedStock()],
    )
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(opStatus().status).toBe('error')
    expect(opStatus().errorMessage).toMatch(/not assigned to any stock/)
  })
})

describe('computeOperationToolpath: a stocked op is NOT blocked by the guard', () => {
  // Worker construction would throw in jsdom; stub it so compute proceeds past
  // the guard. We only assert the no-stock guard did not fire.
  let OrigWorker: typeof Worker | undefined
  beforeEach(() => {
    OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((e: unknown) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      postMessage(): void { /* no-op */ }
      terminate(): void { /* no-op */ }
    }
  })
  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
    vi.restoreAllMocks()
  })

  it('a named-stock geometry gets past the guard (status leaves "ready")', () => {
    installProject(
      makeGeo({ stockId: DERIVED_STOCK_ID, stockIdLocked: true }),
      [derivedStock()],
    )
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    const op = opStatus()
    // The no-stock guard did NOT fire: either we reached 'computing' (worker
    // dispatched) or some OTHER validation, but never the no-stock message.
    expect(op.errorMessage ?? '').not.toMatch(/not assigned to any stock/)
  })
})
