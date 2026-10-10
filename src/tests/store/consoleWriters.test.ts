// WO UI-11A acceptance #2: the three console-event writers, EXHAUSTIVE list —
// (b) sketchNotice, (c) toolpathBatch start/finish. (a) the App status-
// transition writer lives in App.tsx (a component effect) and is covered by
// a React-render test in src/tests/components/ instead.
//
// Each writer test asserts exactly one event lands with the stated
// severity/source. The sketchNotice test also re-asserts its existing footer
// behavior (sketchNotice value + auto-clear) is UNCHANGED — the WO's binding
// requirement that this hook-in never touches that contract.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore, showSketchNotice } from '../../store'
import type {
  ImportedGeometry, FixedStockItem, SceneStock, Setup, Operation, Tool, PhysicalStock, HeightParams,
} from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0, sketchNotice: null })
})

// ── (b) showSketchNotice ────────────────────────────────────────────────────
describe('showSketchNotice console writer', () => {
  it('lands exactly one info/sketch event, and the footer notice is unchanged', () => {
    vi.useFakeTimers()
    try {
      showSketchNotice(useCamStore.setState, 'Sketch baked to layer L1: 3 loops (2 closed)')

      // Existing footer behavior (unchanged): the transient notice is set immediately.
      expect(useCamStore.getState().sketchNotice).toBe('Sketch baked to layer L1: 3 loops (2 closed)')

      // New WO UI-11A behavior: exactly one console event, uniform info/sketch policy
      // (the ~40 call sites funnel through this one function; classifying each site's
      // phrasing into warning/error is deeper routing, reserved for UI-11B).
      const events = useCamStore.getState().consoleEvents
      expect(events.length).toBe(1)
      expect(events[0]).toMatchObject({
        severity: 'info', source: 'sketch', message: 'Sketch baked to layer L1: 3 loops (2 closed)',
      })

      // Existing footer behavior (unchanged): auto-clears after 8s, and does NOT
      // touch the console log (the event is a permanent record of what happened).
      vi.advanceTimersByTime(8000)
      expect(useCamStore.getState().sketchNotice).toBeNull()
      expect(useCamStore.getState().consoleEvents.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a second notice replaces the footer but APPENDS a second event (not exactly-one across calls)', () => {
    vi.useFakeTimers()
    try {
      showSketchNotice(useCamStore.setState, 'first')
      showSketchNotice(useCamStore.setState, 'second')
      expect(useCamStore.getState().sketchNotice).toBe('second')
      expect(useCamStore.getState().consoleEvents.map(e => e.message)).toEqual(['first', 'second'])
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── (c) toolpathBatch start/finish ──────────────────────────────────────────
// Milestone policy (mission :34): only the two terminal edges (start, finish)
// land an event — no per-op progress milestones, so a large "Generate All"
// batch doesn't flood the log.

class MockWorker {
  static instances: MockWorker[] = []
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: { message: string; filename?: string; lineno?: number; error?: Error }) => void) | null = null
  posted: unknown[] = []
  constructor(_url: unknown, _opts?: unknown) { MockWorker.instances.push(this) }
  postMessage(msg: unknown): void { this.posted.push(msg) }
  terminate(): void { /* no-op */ }
}

function makeStock(): FixedStockItem {
  return { id: 'stock-1', name: 'Stock', width: 100, height: 100, depth: 12, position: { x: 0, y: 0, z: 0 } }
}
function makeSceneStock(stock: FixedStockItem): SceneStock {
  return { mode: 'fixed', autoOffsetXY: 2, autoOffsetZTop: 1, fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [stock] }
}
function makeGeo(): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 10 }, size: { x: 50, y: 50, z: 10 }, center: { x: 25, y: 25, z: 5 } },
    position: { x: 0, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{ id: 'loop-1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], closed: true, type: 'contour', layerId: 'L1', area: 100 }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    stockId: 'stock-1',
  }
}
function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 5 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: 'stock-1',
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations: [op],
    notes: '',
  }
}
function makeTool(): Tool {
  return {
    id: 'tool-1', name: '4mm EM', type: 'flat_endmill',
    diameter: 4, fluteLength: 12, shankDiameter: 4, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 1.6 } },
  } as unknown as Tool
}
function makeOp(): Operation {
  const heights: HeightParams = {
    clearanceHeight: 20, clearanceHeightMode: 'absolute', retractHeight: 10, feedHeight: 8,
    topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -3, bottomHeightMode: 'absolute',
  }
  const params = { geometryId: 'geo-1', loopIds: [], side: 'outer', direction: 'climb', tabs: false }
  return {
    id: 'op-1', name: 'Op', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [],
    heights, passes: { stepdown: 2, stepover: 1.6, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: { entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
    params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights, params, geometryIds: ['geo-1'],
    }),
  }
}

function installOneOpScene(): void {
  const stock = makeStock()
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: stock.width, y: stock.height, z: stock.depth },
      size: { x: stock.width, y: stock.height, z: stock.depth }, center: { x: stock.width / 2, y: stock.height / 2, z: stock.depth / 2 },
    },
    position: { x: stock.position.x, y: stock.position.y, z: stock.position.z },
  }
  useCamStore.setState(s => ({
    project: {
      ...s.project,
      geometry: [makeGeo()],
      setups: [makeSetup(makeOp())],
      sceneStock: makeSceneStock(stock),
      stocks: [physicalStock],
      activeSetupId: 'setup-1',
      activeOperationId: 'op-1',
    },
    toolLibrary: [makeTool()],
    toolpathBatch: null,
    consoleEvents: [],
    consoleReadThroughId: 0,
  }))
}

describe('toolpathBatch start/finish console writer', () => {
  beforeEach(() => {
    MockWorker.instances = []
    vi.stubGlobal('Worker', MockWorker)
    installOneOpScene()
  })
  afterAll(() => { vi.unstubAllGlobals() })

  it('start: computeAllToolpaths lands exactly one info/batch event naming the op count', () => {
    useCamStore.getState().computeAllToolpaths()
    const batchEvents = useCamStore.getState().consoleEvents.filter(e => e.source === 'batch')
    expect(batchEvents.length).toBe(1)
    expect(batchEvents[0].severity).toBe('info')
    expect(batchEvents[0].message).toContain('1')
  })

  it('computeAllToolpaths with nothing enabled starts NO batch and lands NO batch event', () => {
    useCamStore.setState(s => ({
      project: { ...s.project, setups: s.project.setups.map(su => ({ ...su, operations: su.operations.map(o => ({ ...o, enabled: false })) })) },
    }))
    useCamStore.getState().computeAllToolpaths()
    expect(useCamStore.getState().toolpathBatch).toBeNull()
    expect(useCamStore.getState().consoleEvents.filter(e => e.source === 'batch')).toEqual([])
  })

  it('finish: the terminal worker message (success OR error) lands exactly one success/batch event and clears the batch', () => {
    useCamStore.getState().computeAllToolpaths()
    expect(useCamStore.getState().toolpathBatch).toMatchObject({ total: 1, completed: 0 })
    expect(useCamStore.getState().toolpathBatch?.id).toEqual(expect.any(String))
    expect(MockWorker.instances.length).toBe(1)

    // Drive the terminal edge via the worker's error path — markBatchOpDone runs on
    // EITHER terminal branch (TOOLPATH_ERROR/onerror or TOOLPATH_COMPLETE); the error
    // path needs no fabricated toolpath-moves payload, so it's the minimal way to
    // reach "the last op finished" without asserting on unrelated compute output.
    MockWorker.instances[0].onerror?.({ message: 'synthetic failure for the finish-event test' })

    expect(useCamStore.getState().toolpathBatch).toBeNull()
    const batchEvents = useCamStore.getState().consoleEvents.filter(e => e.source === 'batch')
    expect(batchEvents.length).toBe(2) // start + finish
    expect(batchEvents[1].severity).toBe('success')
    expect(batchEvents[1].message).toContain('1')
  })
})
