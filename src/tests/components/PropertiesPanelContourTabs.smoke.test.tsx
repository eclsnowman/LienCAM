// @vitest-environment jsdom
//
// React-render SMOKE test for Tabs v2 deliverable 3: the "Edit tab locations"
// block inside props-contour-tabs. Proves the toggle button renders and gates
// on a computed contourTabPreview, that entering the mode SEEDS tabLocations
// from the evenly-spaced centers and calls the viewport's
// enterContourTabEditMode, that the custom-count readout appears with the
// "count field ignored" note, and that Reset to even spacing clears
// tabLocations - all through the REAL store action (updateOperation) with the
// stale-marking shape.
//
// Mirrors the localStorage shim + store seeding of the sibling PropertiesPanel
// smoke tests. The 3D interaction itself (markers, drags) lives in CNCViewport
// and is exempt from jsdom per existing practice; the viewport handle is
// stubbed at window.__cncViewport exactly as the app publishes it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { Operation, Setup } from '../../types'
import type { ContourCuttingStrategy } from '../../lib/cam/types'

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
const { contourPassParamsForMode } = await import('../../lib/cam/types')

const enterContourTabEditMode = vi.fn()
const exitContourTabEditMode = vi.fn()

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  enterContourTabEditMode.mockClear()
  exitContourTabEditMode.mockClear()
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    enterContourTabEditMode,
    exitContourTabEditMode,
  }
})

const LOOP_ID = 'loop-1'

function seedContour(opts: {
  withPreview?: boolean
  tabLocations?: { [id: string]: number[] }
  pathType?: 'closed' | 'open'
  mode?: ContourCuttingStrategy
} = {}): void {
  const { withPreview = true, tabLocations, pathType, mode = 'cut_at_geometry' } = opts
  const modePasses = contourPassParamsForMode(mode, { stockToLeave: 0.3, finishPasses: 2 })
  const op = {
    id: 'op-1', name: 'Contour', type: 'contour_2d', toolId: 't-none', status: 'ready',
    geometrySelections: [],
    toolpathMoves: [{ type: 'rapid', x: 1, y: 2, z: 3 }],
    computeTimeMs: 42, estimatedCutTimeMs: 84,
    passes: {
      stepdown: 2, stepover: 3, springPasses: 2,
      stockToLeave: modePasses.stockToLeave,
      finishPasses: modePasses.finishPasses,
    },
    params: {
      geometryId: 'geo-1', loopIds: [], side: 'outer', direction: 'climb',
      tabs: true, tabWidth: 8, tabHeight: 2, tabCount: 4,
      contourFinishMode: modePasses.contourFinishMode,
      ...(pathType ? { pathType } : {}),
      ...(tabLocations ? { tabLocations } : {}),
    },
    linking: {
      entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 2,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
    },
    ...(withPreview
      ? {
          contourTabPreview: {
            loops: [{
              loopId: LOOP_ID,
              path: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
              perimeter: 160,
            }],
            tabTopZ: -4,
          },
        }
      : {}),
  } as unknown as Operation

  const setup = {
    id: 'setup-1', name: 'Setup 1', wcs: { origin: { x: 0, y: 0, z: 0 } }, operations: [op],
  } as unknown as Setup

  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project, setups: [setup],
        activeSetupId: 'setup-1', activeOperationId: 'op-1',
      },
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    }))
  })
}

function opNow(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}

describe('PropertiesPanel contour tab locations (Tabs v2)', () => {
  it('suppresses holding-tab controls and viewport editing for open contours', () => {
    seedContour({ pathType: 'open' })
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('props-contour-tabs')).toBeNull()
    expect(screen.queryByTestId('props-contour-tab-edit')).toBeNull()
    expect(enterContourTabEditMode).not.toHaveBeenCalled()
  })

  it('renders the edit button inside the tabs block when tabs are enabled', () => {
    seedContour()
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-contour-tabs')).toBeTruthy()
    const btn = screen.getByTestId('props-contour-tab-edit') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toBe('Edit tab locations')
  })

  it('gates the button on a computed preview (disabled + hint without one)', () => {
    seedContour({ withPreview: false })
    render(<PropertiesPanel />)
    const btn = screen.getByTestId('props-contour-tab-edit') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('entering the mode SEEDS even-spacing fractions, marks STALE, and calls the viewport', () => {
    seedContour()
    render(<PropertiesPanel />)
    expect(opNow().status).toBe('ready')
    fireEvent.click(screen.getByTestId('props-contour-tab-edit'))

    // Seed: (i + 0.5) / count for count 4, committed through the real store.
    const op = opNow()
    const locs = (op.params as { tabLocations?: { [id: string]: number[] } }).tabLocations
    expect(locs?.[LOOP_ID]).toEqual([0.125, 0.375, 0.625, 0.875])
    expect(op.status).toBe('pending')
    expect(op.toolpathMoves).toBeUndefined()

    // Viewport mode entered with the full callback set; button toggles.
    expect(enterContourTabEditMode).toHaveBeenCalledTimes(1)
    const callbacks = enterContourTabEditMode.mock.calls[0][0]
    expect(typeof callbacks.onAdd).toBe('function')
    expect(typeof callbacks.onMove).toBe('function')
    expect(typeof callbacks.onRemove).toBe('function')
    expect(typeof callbacks.onExit).toBe('function')
    expect((screen.getByTestId('props-contour-tab-edit') as HTMLButtonElement).textContent)
      .toBe('Done placing tabs')
  })

  it('viewport callbacks commit adds/moves/removes through the store (sorted, STALE)', () => {
    seedContour({ tabLocations: { [LOOP_ID]: [0.125, 0.375, 0.625, 0.875] } })
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-contour-tab-edit'))
    const callbacks = enterContourTabEditMode.mock.calls[0][0]

    act(() => { callbacks.onAdd(LOOP_ID, 0.01) })
    let locs = (opNow().params as { tabLocations: { [id: string]: number[] } }).tabLocations
    expect(locs[LOOP_ID]).toEqual([0.01, 0.125, 0.375, 0.625, 0.875])

    act(() => { callbacks.onMove(LOOP_ID, 0, 0.95) })
    locs = (opNow().params as { tabLocations: { [id: string]: number[] } }).tabLocations
    expect(locs[LOOP_ID]).toEqual([0.125, 0.375, 0.625, 0.875, 0.95])

    act(() => { callbacks.onRemove(LOOP_ID, 4) })
    locs = (opNow().params as { tabLocations: { [id: string]: number[] } }).tabLocations
    expect(locs[LOOP_ID]).toEqual([0.125, 0.375, 0.625, 0.875])
    expect(opNow().status).toBe('pending')
  })

  it('shows the custom count readout and Reset clears tabLocations', () => {
    seedContour({ tabLocations: { [LOOP_ID]: [0.1, 0.4, 0.7] } })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-contour-tab-custom-count').textContent)
      .toBe('3 custom tabs - count field ignored')

    fireEvent.click(screen.getByTestId('props-contour-tab-reset'))
    const op = opNow()
    expect((op.params as { tabLocations?: unknown }).tabLocations).toBeUndefined()
    expect(op.status).toBe('pending')
    // Reset never leaves a live viewport mode behind.
    expect(exitContourTabEditMode).toHaveBeenCalled()
  })

  it('toggling the button off exits the viewport mode without extra commits', () => {
    seedContour({ tabLocations: { [LOOP_ID]: [0.125, 0.375, 0.625, 0.875] } })
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-contour-tab-edit'))
    // Already-custom locations: entering must NOT re-seed or change them.
    const before = (opNow().params as { tabLocations: { [id: string]: number[] } }).tabLocations
    expect(before[LOOP_ID]).toEqual([0.125, 0.375, 0.625, 0.875])
    const statusAfterEnter = opNow().status

    fireEvent.click(screen.getByTestId('props-contour-tab-edit'))
    expect(exitContourTabEditMode).toHaveBeenCalled()
    expect((screen.getByTestId('props-contour-tab-edit') as HTMLButtonElement).textContent)
      .toBe('Edit tab locations')
    // Exiting commits nothing extra.
    expect(opNow().status).toBe(statusAfterEnter)
    expect((opNow().params as { tabLocations: { [id: string]: number[] } }).tabLocations[LOOP_ID])
      .toEqual([0.125, 0.375, 0.625, 0.875])
  })
})

describe('PropertiesPanel contour cutting strategy', () => {
  it.each([
    'cut_at_geometry',
    'roughing_only',
    'rough_finish_each',
    'rough_finish_final',
  ] as const)('derives and renders the saved %s mode', (mode) => {
    seedContour({ mode })
    render(<PropertiesPanel />)
    expect((screen.getByTestId('props-contour-cutting-strategy') as HTMLSelectElement).value)
      .toBe(mode)
  })

  it('changes strategy atomically, preserves unrelated fields, clears output, and undoes once', () => {
    seedContour({ mode: 'roughing_only' })
    render(<PropertiesPanel />)

    fireEvent.change(screen.getByTestId('props-contour-cutting-strategy'), {
      target: { value: 'rough_finish_each' },
    })

    const changed = opNow()
    expect(changed.passes).toMatchObject({
      stockToLeave: 0.3,
      finishPasses: 1,
      stepdown: 2,
      stepover: 3,
      springPasses: 2,
    })
    expect(changed.params).toMatchObject({
      geometryId: 'geo-1',
      tabs: true,
      side: 'outer',
      contourFinishMode: 'each_stepdown',
    })
    expect(changed.status).toBe('pending')
    expect(changed.toolpathMoves).toBeUndefined()
    expect(changed.computeTimeMs).toBeUndefined()
    expect(changed.estimatedCutTimeMs).toBeUndefined()
    expect(useCamStore.getState().canUndo).toBe(true)

    act(() => { useCamStore.getState().undo() })
    expect(opNow().passes).toMatchObject({ stockToLeave: 0.3, finishPasses: 0 })
    expect((opNow().params as { contourFinishMode?: string }).contourFinishMode).toBeUndefined()
  })
})
