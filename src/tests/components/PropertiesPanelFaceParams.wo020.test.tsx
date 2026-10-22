// @vitest-environment jsdom
//
// WO-020: first-class inline FACE coverage in the Properties panel with FULL
// bounds parity against the New Operation modal. Rebuilt from the WO-015
// branch (audit FAIL: the panel accepted out-of-range values the modal
// refused - its numRow supported min but not max, and its tests only used
// in-range values). This suite closes both gaps:
//  - every bounded Face field gets OUT-OF-RANGE commit attempts, asserting
//    the persisted value clamps to the bound (181 deg / 101 mm / -101 mm are
//    impossible to persist from the panel);
//  - the bounds asserted are IMPORTED from faceFieldBounds.ts - the same
//    module the modal renders from - not re-derived literals, and a source
//    census pins both surfaces to that module so parity holds by construction.
//
// Also proves the panel exposes the implemented v1 FaceParams surface the
// modal edits (strategy, pass angle/extension, stock offset, containment,
// per-level toggles, shared axial floor stock) through the REAL store action
// (updateOperation) with the stale-marking shape, preserving unrelated params
// (merge), with undo. Mirrors the localStorage shim + newProject seeding of
// the sibling PropertiesPanelHeightsPassesEdit.smoke.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ImportedGeometry, Operation, Setup } from '../../types'
import type { FaceParams } from '../../lib/cam/types'
import {
  FACE_PASS_ANGLE_BOUNDS,
  FACE_PASS_EXTENSION_BOUNDS,
  FACE_STOCK_OFFSET_BOUNDS,
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

// Implemented v1 FaceParams as the modal authors them, plus a sentinel key to
// prove the panel's merge path never drops unknown params.
function faceParamsSeed(overrides: Partial<FaceParams> = {}): Record<string, unknown> {
  return {
    geometryId: GEO_ID,
    boundarySource: 'stock',
    loopIds: [],
    stockOffset: 0,
    boundaryContainment: 'outside',
    avoidanceLoopIds: [],
    pattern: 'one_way',
    passAngle: 0,
    direction: 'conventional',
    fromOtherSide: false,
    passExtension: 2,
    chipThinning: false,
    bothSidesPerLevel: false,
    floorStockToLeave: 0,
    finishPass: false,
    heightReference: 'stock_top',
    planeOffset: 0,
    entryType: 'plunge',
    leadInRadius: 0,
    leadOutRadius: 0,
    keepToolDown: true,
    maxStayDownDistance: 100,
    extendBeforeRetract: false,
    transition: 'straight',
    tolerance: 0.05,
    keepMe: 'preserved',
    ...overrides,
  }
}

function seedFace(paramOverrides: Partial<FaceParams> = {}): void {
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
    id: 'op-1', name: 'Face', type: 'face', toolId: 't-none', status: 'ready',
    geometrySelections: [],
    // a computed result so we can prove the stale-marking clears it
    toolpathMoves: [{ type: 'rapid' }], computeTimeMs: 42, estimatedCutTimeMs: 84,
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0.1, floorStockToLeave: 0, finishPasses: 0, springPasses: 0 },
    params: faceParamsSeed(paramOverrides),
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
      toolLibrary: [{
        id: 't-none', name: '4mm EM', type: 'flat_end_mill', diameter: 4,
        fluteLength: 12, shankDiameter: 4, overallLength: 50, numberOfFlutes: 2,
        material: 'carbide', coating: 'none', notes: '',
        feedsAndSpeeds: {
          default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 1, stepover: 2 },
        },
      }],
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    }))
  })
}

function opNow(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}
function paramsNow(): FaceParams {
  return opNow().params as unknown as FaceParams
}
// Find the <input> next to a props-label with the given text.
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

const STALE_KEYS = ['toolpathMoves', 'computeTimeMs', 'estimatedCutTimeMs'] as const
function expectStale(op: Operation): void {
  expect(op.status).toBe('pending')
  for (const key of STALE_KEYS) expect(op[key]).toBeUndefined()
}

describe('PropertiesPanel Face bounds parity (WO-020)', () => {
  // The WO-015 audit's named failure, verbatim: 181 deg pass angle, 101 mm
  // pass extension, 101 mm stock offset (and -101 mm) must be IMPOSSIBLE to
  // persist from the panel. Every attempt clamps to the modal's bound.
  it('clamps the audit-named out-of-range literals (181 deg / 101 mm / -101 mm)', () => {
    seedFace()
    render(<PropertiesPanel />)

    commitValue(inputForLabel('Pass angle'), '181')
    expect(paramsNow().passAngle).toBe(180)

    commitValue(inputForLabel('Pass extension'), '101')
    expect(paramsNow().passExtension).toBe(100)

    commitValue(inputForLabel('Stock offset'), '101')
    expect(paramsNow().stockOffset).toBe(100)
    commitValue(inputForLabel('Stock offset'), '-101')
    expect(paramsNow().stockOffset).toBe(-100)
  })

  // Parity asserted against the MODAL's bounds: the expected values are read
  // from faceFieldBounds.ts (the module the modal renders from), never
  // re-derived. If a bound changes there, these attempts move with it.
  it('clamps every bounded FaceParams field to the shared modal bounds (both ends)', () => {
    seedFace()
    render(<PropertiesPanel />)

    const angle = inputForLabel('Pass angle')
    commitValue(angle, String(FACE_PASS_ANGLE_BOUNDS.max + 1))
    expect(paramsNow().passAngle).toBe(FACE_PASS_ANGLE_BOUNDS.max)
    commitValue(angle, String(FACE_PASS_ANGLE_BOUNDS.min - 5))
    expect(paramsNow().passAngle).toBe(FACE_PASS_ANGLE_BOUNDS.min)

    const ext = inputForLabel('Pass extension')
    commitValue(ext, String(FACE_PASS_EXTENSION_BOUNDS.max + 1))
    expect(paramsNow().passExtension).toBe(FACE_PASS_EXTENSION_BOUNDS.max)
    commitValue(ext, String(FACE_PASS_EXTENSION_BOUNDS.min - 1))
    expect(paramsNow().passExtension).toBe(FACE_PASS_EXTENSION_BOUNDS.min)

    const offset = inputForLabel('Stock offset')
    commitValue(offset, String(FACE_STOCK_OFFSET_BOUNDS.max + 1))
    expect(paramsNow().stockOffset).toBe(FACE_STOCK_OFFSET_BOUNDS.max)
    commitValue(offset, String(FACE_STOCK_OFFSET_BOUNDS.min - 1))
    expect(paramsNow().stockOffset).toBe(FACE_STOCK_OFFSET_BOUNDS.min)
  })

  // Floor stock is the one remaining min-only row, same as the modal's
  // matching field (min 0, no max). The shared Stepdown/Stepover/Stock-to-
  // leave rows carry the modal's Face PASS bounds since WO-027 - their
  // two-sided out-of-range coverage lives in
  // PropertiesPanelFacePassBounds.wo027.test.tsx.
  it('clamps the min-only bounded rows on out-of-range attempts', () => {
    seedFace()
    render(<PropertiesPanel />)

    commitValue(inputForLabel('Floor stock'), '-1')
    expect(opNow().passes.floorStockToLeave).toBe(0)
  })

  // Parity by construction: BOTH surfaces must render the three fields from
  // faceFieldBounds.ts. A revert of either side to inline literals (how the
  // WO-015 divergence happened) fails here even if the literals still agree
  // today. Same source-census technique as the overlay census tests.
  it('modal and panel both read the shared faceFieldBounds module', () => {
    const src = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf8')
    const modal = src('src/components/modals/NewOperationModalBody.tsx')
    const panel = src('src/components/panels/PropertiesPanel.tsx')
    for (const file of [modal, panel]) {
      expect(file).toMatch(/from '[./]+modals\/faceFieldBounds'|from '\.\/faceFieldBounds'/)
      expect(file).toContain('FACE_PASS_ANGLE_BOUNDS')
      expect(file).toContain('FACE_PASS_EXTENSION_BOUNDS')
      expect(file).toContain('FACE_STOCK_OFFSET_BOUNDS')
    }
  })
})

describe('PropertiesPanel first-class Face params (WO-020, rebuilt from WO-015)', () => {
  it('renders the full face edit surface with editable passes and read-only Bottom', () => {
    seedFace()
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-face-strategy')).toBeTruthy()
    expect(screen.getByTestId('props-face-edit')).toBeTruthy()
    expect(screen.getByTestId('props-face-containment')).toBeTruthy()
    // face is passes-editable: the generic rows are inputs
    expect(inputForLabel('Stepdown')).toBeTruthy()
    expect(inputForLabel('Stepover')).toBeTruthy()
    expect(inputForLabel('Stock to leave')).toBeTruthy()
    // face-specific rows
    expect(inputForLabel('Floor stock')).toBeTruthy()
    expect(inputForLabel('Pass angle')).toBeTruthy()
    expect(inputForLabel('Pass extension')).toBeTruthy()
    expect(inputForLabel('Stock offset')).toBeTruthy()
    // Bottom stays an honest readout for face (ADR-0020: only pocket
    // back-solves an inline Bottom edit)
    // (f589407e: the row is the shared conventional 'Bottom Height' row.)
    expect(screen.getByTestId('props-height-row-bottom').querySelector('input')).toBeNull()
  })

  it('does not render the face section for non-face operations', () => {
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
    expect(screen.queryByTestId('props-face-strategy')).toBeNull()
    expect(screen.queryByTestId('props-face-edit')).toBeNull()
  })

  it('derives the strategy value from pattern+direction, including legacy linear', () => {
    seedFace() // one_way + conventional
    const { unmount } = render(<PropertiesPanel />)
    expect((screen.getByTestId('props-face-strategy') as HTMLSelectElement).value)
      .toBe('one_way_conventional')
    unmount()

    // legacy 'linear' pattern follows the cut direction in the compute
    // (face2d bothWays rule) — both_ways therefore reads as Zigzag
    seedFace({ pattern: 'linear', direction: 'both_ways' })
    render(<PropertiesPanel />)
    expect((screen.getByTestId('props-face-strategy') as HTMLSelectElement).value)
      .toBe('zigzag')
  })

  it('changing the strategy commits the canonical pattern+direction pair, marks STALE, supports undo', () => {
    seedFace()
    render(<PropertiesPanel />)
    expect(opNow().status).toBe('ready')
    fireEvent.change(screen.getByTestId('props-face-strategy'), { target: { value: 'zigzag' } })

    const edited = opNow()
    expect(edited.params).toMatchObject({
      pattern: 'zigzag',
      direction: 'both_ways',
      geometryId: GEO_ID,
      passExtension: 2,
      keepMe: 'preserved',
    })
    expectStale(edited)
    expect(useCamStore.getState().canUndo).toBe(true)

    act(() => { useCamStore.getState().undo() })
    expect(opNow().params).toMatchObject({ pattern: 'one_way', direction: 'conventional' })
    // Project history strips generated paths: authored values return, the op
    // is honestly outdated rather than falsely ready.
    expect(opNow().status).toBe('outdated')
  })

  it('edits in-range Pass angle and Pass extension without losing other face params', () => {
    seedFace()
    render(<PropertiesPanel />)
    commitValue(inputForLabel('Pass angle'), '90')
    commitValue(inputForLabel('Pass extension'), '4.5')

    const edited = opNow()
    expect(edited.params).toMatchObject({
      passAngle: 90,
      passExtension: 4.5,
      pattern: 'one_way',
      direction: 'conventional',
      boundaryContainment: 'outside',
      geometryId: GEO_ID,
      keepMe: 'preserved',
    })
    expectStale(edited)
  })

  it('edits Stock offset including in-range negative shrink values', () => {
    seedFace()
    render(<PropertiesPanel />)
    commitValue(inputForLabel('Stock offset'), '-1.5')
    expect(paramsNow().stockOffset).toBe(-1.5)
    expectStale(opNow())
  })

  it('edits boundary containment through the select', () => {
    seedFace()
    render(<PropertiesPanel />)
    fireEvent.change(screen.getByTestId('props-face-containment'), { target: { value: 'inside' } })
    expect(paramsNow().boundaryContainment).toBe('inside')
    expect(paramsNow().stockOffset).toBe(0) // merge preserved
    expectStale(opNow())
  })

  it('toggles Alternate levels and Finish pass checkboxes', () => {
    seedFace()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-face-both-sides'))
    expect(paramsNow().bothSidesPerLevel).toBe(true)
    fireEvent.click(screen.getByTestId('props-face-finish-pass'))
    expect(paramsNow().finishPass).toBe(true)
    expectStale(opNow())
    // toggle back off
    fireEvent.click(screen.getByTestId('props-face-finish-pass'))
    expect(paramsNow().finishPass).toBe(false)
  })

  it('edits Floor stock into the shared passes.floorStockToLeave field', () => {
    seedFace()
    render(<PropertiesPanel />)
    commitValue(inputForLabel('Floor stock'), '0.3')

    const edited = opNow()
    // the SHARED PassParams field the compute reads first — NOT the legacy
    // per-op FaceParams.floorStockToLeave fallback
    expect(edited.passes.floorStockToLeave).toBe(0.3)
    expect((edited.params as unknown as FaceParams).floorStockToLeave).toBe(0)
    expect(edited.passes).toMatchObject({ stepdown: 2, stepover: 3, stockToLeave: 0.1 })
    expectStale(edited)
  })
})


describe('WO-2954 optional inward spiral strategy', () => {
  it('commits Spiral, invalidates stale paths, persists authored values and supports undo/redo', () => {
    seedFace()
    render(<PropertiesPanel />)
    fireEvent.change(screen.getByTestId('props-face-strategy'), { target: { value: 'spiral' } })
    expect(paramsNow()).toMatchObject({ pattern: 'spiral', direction: 'climb', keepMe: 'preserved' })
    expectStale(opNow())
    const saved = JSON.parse(JSON.stringify(useCamStore.getState().project))
    expect(saved.setups[0].operations[0].params.pattern).toBe('spiral')
    act(() => { useCamStore.getState().undo() })
    expect(paramsNow()).toMatchObject({ pattern: 'one_way', direction: 'conventional' })
    act(() => { useCamStore.getState().redo() })
    expect(paramsNow()).toMatchObject({ pattern: 'spiral', direction: 'climb' })
    expect((screen.getByTestId('props-face-strategy') as HTMLSelectElement).value).toBe('spiral')
  })

  it('reads an existing Spiral project as Spiral with accessible English fallback', async () => {
    const { applyLanguage } = await import('../../i18n')
    await applyLanguage('de')
    seedFace({ pattern: 'spiral', direction: 'climb' })
    render(<PropertiesPanel />)
    expect((screen.getByTestId('props-face-strategy') as HTMLSelectElement).value).toBe('spiral')
    expect(screen.getByTestId('props-face-strategy').getAttribute('aria-label')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Inward spiral' })).toBeTruthy()
    await applyLanguage('en')
  })
})
