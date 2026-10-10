// @vitest-environment jsdom
//
// WO-1375 / BUG-507: the Properties panel's quick tool picker (QuickEditCard)
// offered every tool in the library, unfiltered by operation type, so a
// Pocket operation could pick a drill and generate a lateral milling path
// from a bit that was never meant to move sideways. It also swapped the
// toolId without marking the operation stale, so a changed tool stayed
// `ready` over the PREVIOUS tool's moves.
//
// This file proves both are fixed:
//  1. the quick picker's tool list excludes tool types that are not eligible
//     for the operation's type (Pocket excludes a drill);
//  2. picking a different eligible tool marks the operation no longer ready.
//
// Seeding mirrors PropertiesPanelFaceParams.wo020.test.tsx's `seedFace` (a
// minimal fixed-stock + geometry + setup rig proven to mount
// OperationProperties for a pocket_2d op without crashing - see that file's
// "does not render the face section for non-face operations" case, which
// mutates the same op shape to pocket_2d and renders successfully).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ImportedGeometry, Operation, Setup, Tool, ToolType } from '../../types'

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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

class MockWorker {
  onmessage: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage(): void { /* no-op */ }
  terminate(): void { /* no-op */ }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.stubGlobal('Worker', MockWorker)
  act(() => { useCamStore.getState().newProject() })
})

const GEO_ID = 'geo-1'
const FLAT_ID = 't-flat'
const BALL_ID = 't-ball'
const DRILL_ID = 't-drill'
const BULL_ID = 't-bull'
const VBIT_ID = 't-vbit'
const COUNTERSINK_ID = 't-countersink'

const tool = (id: string, name: string, type: ToolType, extra?: Partial<{ angleFromAxisDeg: number }>): Tool => ({
  id, name, type, diameter: 6,
  fluteLength: 12, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: {
    default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 1, stepover: 2 },
  },
  ...extra,
})

// An operation of the given type + a library of the given tools. Mirrors
// seedFace()'s fixed-stock/geometry/setup rig, with op.type set per case
// (proven renderable, see the file banner).
function seedOp(opType: Operation['type'], toolId: string, tools: ReturnType<typeof tool>[]): void {
  const fixedStock = {
    id: 'stock-1', name: 'Stock', width: 100, height: 100, depth: 12,
    position: { x: 0, y: 0, z: 0 },
  }
  const physicalStock = {
    id: fixedStock.id, name: fixedStock.name, mode: 'explicit' as const,
    position: { x: 0, y: 0, z: 0 },
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 12 },
      size: { x: 100, y: 100, z: 12 }, center: { x: 50, y: 50, z: 6 },
    },
  }
  const geo = {
    id: GEO_ID, name: 'Part', format: 'step',
    stockId: fixedStock.id,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: -20 }, max: { x: 10, y: 10, z: 0 } },
    loops: [{
      id: 'l1', closed: true, type: 'contour', layerId: 'L1', area: 100,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    }],
  } as unknown as ImportedGeometry

  const op = {
    id: 'op-1', name: 'Op', type: opType, toolId, status: 'ready',
    geometrySelections: [],
    // a computed result so we can prove tool selection clears it (stale-marking)
    toolpathMoves: [{ type: 'rapid' }], computeTimeMs: 42, estimatedCutTimeMs: 84,
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0.1, floorStockToLeave: 0, finishPasses: 0, springPasses: 0 },
    // chamferWidth/tipOffset are only read for opType 'chamfer' (chamferParams
    // at PropertiesPanel.tsx:3926); harmless on every other op type here.
    params: {
      geometryId: GEO_ID, heightReference: 'geometry_face', planeOffset: 0,
      chamferWidth: 1, tipOffset: 0,
    },
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 2,
      topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -5, bottomHeightMode: 'absolute',
    },
  } as unknown as Operation

  const setup = {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, stockId: fixedStock.id,
      origin: { x: 0, y: 0, z: 12 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    operations: [op],
  } as unknown as Setup

  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [geo], setups: [setup], activeSetupId: 'setup-1', activeOperationId: 'op-1',
        sceneStock: {
          mode: 'fixed', autoOffsetXY: 2, autoOffsetZTop: 1,
          fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [fixedStock],
        },
        stocks: [physicalStock],
      },
      toolLibrary: tools,
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    }))
  })
}

function opNow(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}

function openQuickPicker(): void {
  fireEvent.click(screen.getByTestId('quickedit-change-tool'))
}

// A pocket_2d operation + a library holding a flat end mill, a ball end mill
// and a twist drill.
function seedPocket(): void {
  seedOp('pocket_2d', FLAT_ID, [
    tool(FLAT_ID, 'Flat 6mm', 'flat_end_mill'),
    tool(BALL_ID, 'Ball 6mm', 'ball_end_mill'),
    tool(DRILL_ID, 'Twist Drill 6mm', 'drill'),
  ])
}

describe('PropertiesPanel quick tool picker filters by operation type (WO-1375, BUG-507)', () => {
  it('a Pocket operation lists the milling tools and excludes the drill', () => {
    seedPocket()
    render(<PropertiesPanel />)
    openQuickPicker()

    const list = screen.getByTestId('quickedit-tool-list')
    expect(list).not.toBeNull()
    expect(screen.getByTestId(`quickedit-tool-${FLAT_ID}`)).not.toBeNull()
    expect(screen.getByTestId(`quickedit-tool-${BALL_ID}`)).not.toBeNull()
    expect(screen.queryByTestId(`quickedit-tool-${DRILL_ID}`)).toBeNull()
  })

  it('picking a different eligible tool marks the operation no longer ready', () => {
    seedPocket()
    render(<PropertiesPanel />)
    expect(opNow().status).toBe('ready')

    openQuickPicker()
    fireEvent.click(screen.getByTestId(`quickedit-tool-${BALL_ID}`))

    const edited = opNow()
    expect(edited.toolId).toBe(BALL_ID)
    expect(edited.status).not.toBe('ready')
    expect(edited.toolpathMoves).toBeUndefined()
  })
})

describe('PropertiesPanel quick tool picker matches what each engine actually accepts (WO-1375 audit fix round)', () => {
  it('a Bore operation lists the flat and bull-nose end mills and excludes the drill (bore2d.ts only accepts end mills)', () => {
    seedOp('bore', FLAT_ID, [
      tool(FLAT_ID, 'Flat 6mm', 'flat_end_mill'),
      tool(BULL_ID, 'Bull 6mm', 'bull_nose'),
      tool(DRILL_ID, 'Twist Drill 6mm', 'drill'),
    ])
    render(<PropertiesPanel />)
    openQuickPicker()

    expect(screen.getByTestId(`quickedit-tool-${FLAT_ID}`)).not.toBeNull()
    expect(screen.getByTestId(`quickedit-tool-${BULL_ID}`)).not.toBeNull()
    expect(screen.queryByTestId(`quickedit-tool-${DRILL_ID}`)).toBeNull()
  })

  it('a Drill operation lists holemaking tools plus flat and bull-nose end mills, and excludes a ball end mill (drill2d.ts has no tool-type check; a centre-cutting end mill can plunge a hole)', () => {
    seedOp('drill', DRILL_ID, [
      tool(DRILL_ID, 'Twist Drill 6mm', 'drill'),
      tool(FLAT_ID, 'Flat 6mm', 'flat_end_mill'),
      tool(BULL_ID, 'Bull 6mm', 'bull_nose'),
      tool(BALL_ID, 'Ball 6mm', 'ball_end_mill'),
    ])
    render(<PropertiesPanel />)
    openQuickPicker()

    expect(screen.getByTestId(`quickedit-tool-${DRILL_ID}`)).not.toBeNull()
    expect(screen.getByTestId(`quickedit-tool-${FLAT_ID}`)).not.toBeNull()
    expect(screen.getByTestId(`quickedit-tool-${BULL_ID}`)).not.toBeNull()
    expect(screen.queryByTestId(`quickedit-tool-${BALL_ID}`)).toBeNull()
  })

  it('an Engrave operation lists every tool, including a plain end mill (engrave2d only uses the tip angle when the tool has one)', () => {
    seedOp('engrave', FLAT_ID, [
      tool(FLAT_ID, 'Flat 6mm', 'flat_end_mill'),
      tool(VBIT_ID, '60deg V-Bit', 'v_bit', { angleFromAxisDeg: 30 }),
    ])
    render(<PropertiesPanel />)
    openQuickPicker()

    expect(screen.getByTestId(`quickedit-tool-${FLAT_ID}`)).not.toBeNull()
    expect(screen.getByTestId(`quickedit-tool-${VBIT_ID}`)).not.toBeNull()
  })

  it('a V-Carve operation lists the V-bit and chamfer mill and excludes the plain end mill (vcarve2d requires a tip angle)', () => {
    seedOp('vcarve', VBIT_ID, [
      tool(VBIT_ID, '60deg V-Bit', 'v_bit', { angleFromAxisDeg: 30 }),
      tool('t-chamfer', 'Chamfer Mill', 'chamfer_mill', { angleFromAxisDeg: 45 }),
      tool(FLAT_ID, 'Flat 6mm', 'flat_end_mill'),
    ])
    render(<PropertiesPanel />)
    openQuickPicker()

    expect(screen.getByTestId(`quickedit-tool-${VBIT_ID}`)).not.toBeNull()
    expect(screen.getByTestId('quickedit-tool-t-chamfer')).not.toBeNull()
    expect(screen.queryByTestId(`quickedit-tool-${FLAT_ID}`)).toBeNull()
  })

  it('a Chamfer operation lists a countersink and excludes the plain end mill (chamfer2d only requires a tip angle, not a milling-group type)', () => {
    seedOp('chamfer', COUNTERSINK_ID, [
      tool(COUNTERSINK_ID, 'Countersink', 'countersink', { angleFromAxisDeg: 45 }),
      tool(FLAT_ID, 'Flat 6mm', 'flat_end_mill'),
    ])
    render(<PropertiesPanel />)
    openQuickPicker()

    expect(screen.getByTestId(`quickedit-tool-${COUNTERSINK_ID}`)).not.toBeNull()
    expect(screen.queryByTestId(`quickedit-tool-${FLAT_ID}`)).toBeNull()
  })
})
