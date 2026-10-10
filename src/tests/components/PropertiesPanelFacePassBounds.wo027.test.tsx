// @vitest-environment jsdom
//
// WO-027: Face PASS-field bounds parity - the rows WO-020 deferred. The
// WO-020 audit named the gap exactly: the panel's shared Stepdown/Stepover/
// Stock-to-leave rows kept generic floors (0.01 / 0.01 / 0, no max) while the
// modal's Face passes section bounds them 0.1..50, 0.1..tool diameter, and
// 0..tool diameter. This suite closes it the way the WO demands:
//  - EVERY bounded Face pass field gets BOTH below-min and above-max commit
//    attempts (one-sided probes are what let WO-020 through);
//  - the two diameter-capped fields (Stepover, radial Stock to Leave) are
//    probed with a value just above the selected tool's diameter;
//  - expected values are IMPORTED from faceFieldBounds.ts - the module the
//    modal renders from - plus the seeded tool's diameter through the SAME
//    faceToolDiameterCap helper the modal uses, never re-derived literals;
//  - a source census pins both surfaces to the shared symbols so a revert to
//    inline literals fails even while the literals still agree.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ImportedGeometry, Operation, Setup, Tool } from '../../types'
import {
  FACE_STEPOVER_BOUNDS,
  FACE_STEPDOWN_BOUNDS,
  FACE_RADIAL_STOCK_BOUNDS,
  faceToolDiameterCap,
} from '../../components/modals/faceFieldBounds'

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
const TOOL = {
  id: 't-4mm', name: '4mm EM', type: 'flat_end_mill', diameter: 4,
  fluteLength: 12, shankDiameter: 4, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: {
    default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 1, stepover: 2 },
  },
} as unknown as Tool

// Same seeding shape as the sibling wo020 suite: a face op with a computed
// result, a 4 mm tool in the library, in-range seed passes.
function seedFace(opOverrides: Partial<Operation> = {}): void {
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
    id: 'op-1', name: 'Face', type: 'face', toolId: TOOL.id, status: 'ready',
    geometrySelections: [],
    toolpathMoves: [{ type: 'rapid' }], computeTimeMs: 42, estimatedCutTimeMs: 84,
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0.1, floorStockToLeave: 0, finishPasses: 0, springPasses: 0 },
    params: {
      geometryId: GEO_ID, boundarySource: 'stock', loopIds: [], stockOffset: 0,
      boundaryContainment: 'outside', avoidanceLoopIds: [], pattern: 'one_way',
      passAngle: 0, direction: 'conventional', fromOtherSide: false,
      passExtension: 2, chipThinning: false, bothSidesPerLevel: false,
      floorStockToLeave: 0, finishPass: false, heightReference: 'stock_top',
      planeOffset: 0, entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0,
      keepToolDown: true, maxStayDownDistance: 100, extendBeforeRetract: false,
      transition: 'straight', tolerance: 0.05,
    },
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 2,
      topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -5, bottomHeightMode: 'absolute',
    },
    ...opOverrides,
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
      toolLibrary: [TOOL],
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    }))
  })
}

function opNow(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}
function inputForLabel(label: string): HTMLInputElement {
  const el = screen.getByText(label)
  const input = el.parentElement?.querySelector('input')
  if (!input) throw new Error(`no input for label ${label}`)
  return input as HTMLInputElement
}
function commitValue(input: HTMLInputElement, value: string): void {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

describe('PropertiesPanel Face PASS-field bounds parity (WO-027)', () => {
  it('clamps Stepover on BOTH sides: below 0.1 and just above the tool diameter', () => {
    seedFace()
    render(<PropertiesPanel />)
    const cap = faceToolDiameterCap(TOOL)! // 4 mm - same helper the modal renders from

    const stepover = inputForLabel('Stepover')
    commitValue(stepover, String(FACE_STEPOVER_BOUNDS.min - 0.05))
    expect(opNow().passes.stepover).toBe(FACE_STEPOVER_BOUNDS.min)

    commitValue(stepover, String(cap + 0.1)) // 4.1: just above the 4 mm tool
    expect(opNow().passes.stepover).toBe(cap)
  })

  it('clamps Stepdown on BOTH sides: below 0.1 and above 50', () => {
    seedFace()
    render(<PropertiesPanel />)

    const stepdown = inputForLabel('Stepdown')
    commitValue(stepdown, String(FACE_STEPDOWN_BOUNDS.min - 0.05))
    expect(opNow().passes.stepdown).toBe(FACE_STEPDOWN_BOUNDS.min)

    commitValue(stepdown, String(FACE_STEPDOWN_BOUNDS.max + 1))
    expect(opNow().passes.stepdown).toBe(FACE_STEPDOWN_BOUNDS.max)
  })

  it('clamps radial Stock to leave on BOTH sides: below 0 and just above the tool diameter', () => {
    seedFace()
    render(<PropertiesPanel />)
    const cap = faceToolDiameterCap(TOOL)!

    const stock = inputForLabel('Stock to leave')
    commitValue(stock, String(FACE_RADIAL_STOCK_BOUNDS.min - 1))
    expect(opNow().passes.stockToLeave).toBe(FACE_RADIAL_STOCK_BOUNDS.min)

    commitValue(stock, String(cap + 0.1))
    expect(opNow().passes.stockToLeave).toBe(cap)
  })

  it('persists values exactly AT the bounds (the caps are inclusive, as in the modal)', () => {
    seedFace()
    render(<PropertiesPanel />)
    const cap = faceToolDiameterCap(TOOL)!

    commitValue(inputForLabel('Stepover'), String(cap))
    expect(opNow().passes.stepover).toBe(cap)

    commitValue(inputForLabel('Stepdown'), String(FACE_STEPDOWN_BOUNDS.max))
    expect(opNow().passes.stepdown).toBe(FACE_STEPDOWN_BOUNDS.max)

    commitValue(inputForLabel('Stepdown'), String(FACE_STEPDOWN_BOUNDS.min))
    expect(opNow().passes.stepdown).toBe(FACE_STEPDOWN_BOUNDS.min)
  })

  // The modal renders max={faceToolDiameterCap(selectedTool)}: no resolvable
  // tool means UNCAPPED, floors still enforced. The panel must match - a
  // panel-side hardcoded fallback cap would be a new divergence.
  it('leaves the diameter-capped fields uncapped when no tool resolves, exactly like the modal', () => {
    seedFace({ toolId: 'tool-that-does-not-exist' } as Partial<Operation>)
    render(<PropertiesPanel />)

    const stepover = inputForLabel('Stepover')
    commitValue(stepover, '25')
    expect(opNow().passes.stepover).toBe(25)
    commitValue(stepover, '-1')
    expect(opNow().passes.stepover).toBe(FACE_STEPOVER_BOUNDS.min)

    const stock = inputForLabel('Stock to leave')
    commitValue(stock, '25')
    expect(opNow().passes.stockToLeave).toBe(25)
    commitValue(stock, '-1')
    expect(opNow().passes.stockToLeave).toBe(FACE_RADIAL_STOCK_BOUNDS.min)
  })

  // The Face bounds must not leak onto other op types: their shared rows keep
  // the generic panel floors (0.01) with no max.
  it('keeps the generic floors on non-face operations', () => {
    seedFace()
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          setups: s.project.setups.map((setup) => ({
            ...setup,
            operations: setup.operations.map((operation) => ({
              ...operation,
              type: 'pocket_2d' as const,
              params: { geometryId: GEO_ID, heightReference: 'geometry_face', planeOffset: 0 },
            })),
          })),
        },
      }))
    })
    render(<PropertiesPanel />)

    const stepdown = inputForLabel('Stepdown')
    commitValue(stepdown, '0.05') // below the FACE floor, above the generic one
    expect(opNow().passes.stepdown).toBe(0.05)
    commitValue(stepdown, '51') // above the FACE max: pocket has no max
    expect(opNow().passes.stepdown).toBe(51)

    commitValue(inputForLabel('Stepover'), String(TOOL.diameter + 0.1))
    expect(opNow().passes.stepover).toBe(TOOL.diameter + 0.1)
  })

  // Parity by construction: BOTH surfaces must render the pass bounds from
  // faceFieldBounds.ts, including the tool-diameter cap through the shared
  // helper. Same source-census technique as the wo020 suite - a revert of
  // either side to inline literals fails here even while the values agree.
  it('modal and panel both read the shared pass bounds and diameter-cap helper', () => {
    const src = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf8')
    const modal = src('src/components/modals/NewOperationModalBody.tsx')
    const panel = src('src/components/panels/PropertiesPanel.tsx')
    for (const file of [modal, panel]) {
      expect(file).toMatch(/from '[./]+modals\/faceFieldBounds'|from '\.\/faceFieldBounds'/)
      expect(file).toContain('FACE_STEPOVER_BOUNDS')
      expect(file).toContain('FACE_STEPDOWN_BOUNDS')
      expect(file).toContain('FACE_RADIAL_STOCK_BOUNDS')
      expect(file).toContain('faceToolDiameterCap(')
    }
  })
})
