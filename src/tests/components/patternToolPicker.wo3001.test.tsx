// @vitest-environment jsdom
//
// WO-3001 (audit route, fix round 1): the Properties quick tool picker for a
// pattern operation offers what the pattern engine measures - ball, bull,
// flat and pointed cutters (pattern2d/envelope.ts footprintHalfWidth; the
// pattern metadata lists v_bit). Before the fix the pattern row reused
// isMillingTool, which drops the V-bit (toolMeta group 'engraving').
// The rig below is quickToolPicker.wo1375.test.tsx's seedOp, unchanged.
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

function openQuickPicker(): void {
  fireEvent.click(screen.getByTestId('quickedit-change-tool'))
}

describe('WO-3001 pattern quick tool picker', () => {
  it('a pattern operation lists the V-bit and the countersink beside the ball, bull and flat end mills', () => {
    seedOp('pattern', BALL_ID, [
      tool(FLAT_ID, 'Flat 6mm', 'flat_end_mill'),
      tool(BALL_ID, 'Ball 6mm', 'ball_end_mill'),
      tool(BULL_ID, 'Bull 6mm', 'bull_nose'),
      tool(VBIT_ID, 'V-bit 60', 'v_bit', { angleFromAxisDeg: 30 }),
      tool(COUNTERSINK_ID, 'Countersink 90', 'countersink', { angleFromAxisDeg: 45 }),
    ])
    render(<PropertiesPanel />)
    openQuickPicker()
    for (const id of [FLAT_ID, BALL_ID, BULL_ID]) expect(screen.getByTestId(`quickedit-tool-${id}`)).not.toBeNull()
    expect(screen.queryByTestId(`quickedit-tool-${VBIT_ID}`), 'the V-bit is missing from the pattern quick picker').not.toBeNull()
    expect(screen.queryByTestId(`quickedit-tool-${COUNTERSINK_ID}`), 'the countersink is missing from the pattern quick picker').not.toBeNull()
  })
})
