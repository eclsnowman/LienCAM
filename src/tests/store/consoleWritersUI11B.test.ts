// WO UI-11B batch B: the COMPUTE and NEST lane writers, plus the BK-78
// severity seam. Pure store tests (no React render), mirroring
// consoleWriters.test.ts's approach (WO UI-11A).
//
// Coverage (acceptance criterion 1):
//  - COMPUTE: any op status:'error' transition (updateOperation's single
//    hook-in point — covers every fail-loud call site, incl. worker hard
//    errors) lands one error/compute event with entityRef {kind:'op'}.
//  - NEST: run start (info), run finish success (applyNestResult) and error
//    (applyNestError), and the createNest skipped-sources warning naming the
//    skipped source(s).
//  - BK-78: showSketchNotice's optional severity arg — explicit
//    warning/error pass through; an unspecified call stays 'info' (default
//    unchanged from UI-11A).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCamStore, showSketchNotice } from '../../store'
// The armed-tool chain + fillet radius and the overlay-apply dispatch now live
// in the sketcher package (WO SKC-14B). sketchNotice itself is UNCHANGED and
// still lives on the CAM store.
import { sketcherTools, sketcherToolStore, type SketcherToolState } from '../../lib/sketch/sketcher'
import type {
  ImportedGeometry, FixedStockItem, SceneStock, PhysicalStock, Setup, Operation, Tool,
  HeightParams, PassParams, LinkingParams,
} from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0, sketchNotice: null })
})

// =============================================================================
// BK-78: showSketchNotice severity seam
// =============================================================================

describe('showSketchNotice severity seam (BK-78)', () => {
  it('defaults to info when no severity is given (unchanged from UI-11A)', () => {
    showSketchNotice(useCamStore.setState, 'plain notice')
    expect(useCamStore.getState().consoleEvents[0].severity).toBe('info')
  })

  it('passes an explicit warning-class severity through to the event', () => {
    showSketchNotice(useCamStore.setState, 'Dimension no longer exists', 'warning')
    expect(useCamStore.getState().consoleEvents[0]).toMatchObject({ severity: 'warning', source: 'sketch' })
  })

  it('passes an explicit error-class severity through to the event', () => {
    showSketchNotice(useCamStore.setState, 'Font import failed: bad file', 'error')
    expect(useCamStore.getState().consoleEvents[0]).toMatchObject({ severity: 'error', source: 'sketch' })
  })

  it('a REAL classified call site (fillet nothing-applied) lands an error event', () => {
    // installFilletOverlayScene below is overkill for this — the classification
    // is exercised directly at the writer level (store/index.ts's fillet-apply
    // branch passes 'error' explicitly); this test proves the wiring end to
    // end via the store action a real Apply click drives.
    useCamStore.setState((_s) => ({
      activeSketch: {
        id: 'sk-1', layerId: 'L1', entities: [], constraints: [], dimensions: [],
      } as unknown as typeof _s.activeSketch,
    }))
    // Chain + fillet radius are package tool state now (WO SKC-14B).
    sketcherToolStore.setState({
      chain: { kind: 'fillet', corners: [{ aId: 'a', bId: 'b' }] } as unknown as SketcherToolState['chain'],
      filletRadius: 2,
    })
    sketcherTools.overlayApply()
    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].severity).toBe('error')
  })
})

// =============================================================================
// COMPUTE lane: updateOperation's single hook-in point
// =============================================================================

describe('COMPUTE lane console writer', () => {
  it('a status:"error" transition with an errorMessage lands one error/compute event with entityRef to the op', () => {
    useCamStore.getState().updateOperation('setup-1', 'op-1', {
      status: 'error', errorMessage: 'Plane ordering error: clearance must be above retract',
    })
    const events = useCamStore.getState().consoleEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      severity: 'error', source: 'compute',
      message: 'Plane ordering error: clearance must be above retract',
      entityRef: { kind: 'op', id: 'op-1' },
    })
  })

  it('a status transition to anything OTHER than error lands no compute event', () => {
    useCamStore.getState().updateOperation('setup-1', 'op-1', { status: 'ready' })
    useCamStore.getState().updateOperation('setup-1', 'op-1', { status: 'pending' })
    expect(useCamStore.getState().consoleEvents).toEqual([])
  })

})

// -----------------------------------------------------------------------------
// Rework (WO UI-11B-R1, Finding 1): the worker-hard-error coverage above only
// proved updateOperation's hook fires — it never drove the REAL crash path.
// This fixture builds a full computable scene so computeOperationToolpath
// (store/index.ts) actually constructs a toolpathWorker and installs the real
// worker.onerror handler; the test then fires THAT handler directly (as the
// browser runtime would on a worker crash), never calling updateOperation
// itself. Fails-if: removing the onerror handler's emission (store/index.ts's
// `worker.onerror = (e) => { ... get().updateOperation(...) }`) fails this.
// -----------------------------------------------------------------------------

class CrashWorker {
  static instances: CrashWorker[] = []
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: { message: string; filename?: string; lineno?: number; error?: unknown }) => void) | null = null
  constructor() { CrashWorker.instances.push(this) }
  postMessage(): void {}
  terminate(): void {}
}

function crashStock(): FixedStockItem {
  return {
    id: 'wstock-1', name: 'Stock', width: 100, height: 100, depth: 12,
    position: { x: 0, y: 0, z: 0 },
  }
}

function crashSceneStock(stock: FixedStockItem): SceneStock {
  return {
    mode: 'fixed', autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [stock],
  }
}

function crashPhysicalStock(stock: FixedStockItem): PhysicalStock {
  return {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: stock.width, y: stock.height, z: stock.depth },
      size: { x: stock.width, y: stock.height, z: stock.depth },
      center: { x: stock.width / 2, y: stock.height / 2, z: stock.depth / 2 },
    },
    position: { x: stock.position.x, y: stock.position.y, z: stock.position.z },
  }
}

function crashGeo(): ImportedGeometry {
  return {
    id: 'wgeo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 10 },
      size: { x: 50, y: 50, z: 10 }, center: { x: 25, y: 25, z: 5 },
    },
    position: { x: 0, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: 'wstock-1',
    loops: [{
      id: 'wloop-1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as ImportedGeometry
}

function crashTool(): Tool {
  return {
    id: 'wtool-1', name: '4mm EM', type: 'flat_endmill',
    diameter: 4, fluteLength: 12, shankDiameter: 4, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 1.6 } },
  } as unknown as Tool
}

const crashHeights: HeightParams = {
  clearanceHeight: 20, clearanceHeightMode: 'absolute',
  retractHeight: 10, feedHeight: 8,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -3, bottomHeightMode: 'absolute',
}
const crashPasses: PassParams = { stepdown: 2, stepover: 1.6, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const crashLinking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 10,
  leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
}

function crashOp(): Operation {
  const params = { geometryId: 'wgeo-1', loopIds: [], side: 'outer', direction: 'climb', tabs: false }
  return {
    id: 'op-crash', name: 'Op', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'wtool-1', geometrySelections: [],
    heights: crashHeights, passes: crashPasses, linking: crashLinking,
    params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights: crashHeights, params, geometryIds: ['wgeo-1'],
    }),
  }
}

function crashSetup(): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 5 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: 'wstock-1',
    },
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    } as Setup['stock'],
    operations: [crashOp()],
    notes: '',
  }
}

function installWorkerCrashScene(): void {
  const stock = crashStock()
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [crashGeo()],
      setups: [crashSetup()],
      sceneStock: crashSceneStock(stock),
      stocks: [crashPhysicalStock(stock)],
      activeSetupId: 'setup-1', activeOperationId: 'op-crash',
    },
    toolLibrary: [crashTool()],
    toolpathBatch: null,
    consoleEvents: [], consoleReadThroughId: 0,
  }))
}

describe('COMPUTE lane console writer: REAL worker.onerror path (UI-11B-R1 Finding 1)', () => {
  beforeEach(() => {
    CrashWorker.instances = []
    vi.stubGlobal('Worker', CrashWorker)
    installWorkerCrashScene()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('firing the REAL worker.onerror handler (installed by computeOperationToolpath, never calling updateOperation directly) lands one error/compute event with entityRef to the op', () => {
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-crash')

    expect(CrashWorker.instances).toHaveLength(1)
    const worker = CrashWorker.instances[0]
    expect(typeof worker.onerror).toBe('function')

    // Simulate the browser runtime invoking the worker's real onerror callback
    // on a crash — this is the actual trigger point, not a stand-in call.
    worker.onerror!({ message: 'Simulated worker crash', filename: 'toolpathWorker.ts', lineno: 42 })

    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'compute')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      severity: 'error',
      entityRef: { kind: 'op', id: 'op-crash' },
    })
    expect(events[0].message).toContain('Simulated worker crash')
  })
})

// =============================================================================
// NEST lane: skipped-sources warning, run start, run finish (success/error)
// =============================================================================

function bbox(min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function squareLoop(id: string, s: number) {
  return {
    id, layerId: 'L', closed: true, type: 'contour' as const, area: s * s,
    points: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }],
  }
}

function makeGeo(id: string, side: number): ImportedGeometry {
  return {
    id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: side, y: side, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [squareLoop(`${id}-outer`, side)],
  } as ImportedGeometry
}

function installProject(geometry: ImportedGeometry[]): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project, geometry, geometryFolders: [], nests: [], setups: [], stocks: undefined,
    },
    projectHistory: [], canUndo: false,
    consoleEvents: [], consoleReadThroughId: 0,
  }))
}

function createParams(over: Partial<Parameters<ReturnType<typeof useCamStore.getState>['createNest']>[0]> = {}) {
  return {
    sources: [{ geometryId: 'a', quantity: 4 }],
    sheet: { width: 100, height: 100 },
    style: 'ninety' as const,
    spacing: { partGap: 1, sheetMargin: 2, windowGap: 1 },
    seed: 42,
    ...over,
  }
}

describe('NEST lane console writer: skipped sources', () => {
  beforeEach(() => installProject([makeGeo('a', 20)]))

  it('a source that resolves to no geometry lands ONE warning event naming it (not one per source)', () => {
    useCamStore.getState().createNest(createParams({
      sources: [{ geometryId: 'a', quantity: 1 }, { geometryId: 'ghost', quantity: 1 }],
    }))
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'nest')
    const warnings = events.filter((e) => e.severity === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('ghost')
  })

  it('a source with no closed loops is named the same way', () => {
    installProject([makeGeo('a', 20), { ...makeGeo('open', 10), loops: [{ ...squareLoop('x', 10), closed: false }] }])
    useCamStore.getState().createNest(createParams({
      sources: [{ geometryId: 'a', quantity: 1 }, { geometryId: 'open', quantity: 1 }],
    }))
    const warnings = useCamStore.getState().consoleEvents.filter((e) => e.source === 'nest' && e.severity === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('Part open')
  })

  it('no skip -> no warning event', () => {
    useCamStore.getState().createNest(createParams())
    expect(useCamStore.getState().consoleEvents.filter((e) => e.source === 'nest' && e.severity === 'warning')).toEqual([])
  })
})

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  static instances: StubWorker[] = []
  constructor() { StubWorker.instances.push(this) }
  postMessage(): void {}
  terminate(): void {}
}

describe('NEST lane console writer: run start + finish', () => {
  beforeEach(() => {
    StubWorker.instances = []
    vi.stubGlobal('Worker', StubWorker)
    installProject([makeGeo('a', 20)])
  })

  it('dispatching a pack lands one info/nest "packing" start event', () => {
    useCamStore.getState().createNest(createParams())
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'nest')
    expect(events[0]).toMatchObject({ severity: 'info' })
    expect(events[0].message).toContain('packing')
  })

  it('applyNestResult (worker NEST_COMPLETE) lands a success finish event', () => {
    const id = useCamStore.getState().createNest(createParams())
    useCamStore.getState().applyNestResult(id, {
      placements: [{ instanceId: 'i1', partId: 'a', x: 0, y: 0, rotationDeg: 0, depth: 0 }],
      unplaced: [{ partId: 'a', count: 1 }],
      utilization: 0.5,
      sheetUsed: { width: 100, height: 100 },
    })
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'nest')
    const finish = events[events.length - 1]
    expect(finish.severity).toBe('success')
    expect(finish.message).toContain('50%')
  })

  it('applyNestError (worker NEST_ERROR/onerror) lands an error finish event', () => {
    const id = useCamStore.getState().createNest(createParams())
    useCamStore.getState().applyNestError(id, 'packer crashed')
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'nest')
    const finish = events[events.length - 1]
    expect(finish.severity).toBe('error')
    expect(finish.message).toContain('packer crashed')
  })

  it('applyNestError is a no-op (including no event) for an unknown nest id', () => {
    installProject([makeGeo('a', 20)])
    useCamStore.getState().applyNestError('ghost', 'x')
    expect(useCamStore.getState().consoleEvents).toEqual([])
  })
})
