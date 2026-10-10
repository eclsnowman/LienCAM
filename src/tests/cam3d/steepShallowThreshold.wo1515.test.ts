// @vitest-environment jsdom
//
// WO-1515 / BUG-422: the operation modal's Threshold field already carries
// min={0} max={90} (NewOperationModalBody.tsx), but PropertiesPanel's
// quick-edit row for the same field had no max, so Properties accepted and
// saved thresholdDeg: 100. On read, readSteepShallow3dParams silently
// substituted the DEFAULT (30 deg) for any threshold above 90 -- a different
// strategy split, with no error and no visible change to the saved value
// Properties kept displaying.
//
// Architect decision (2026-09-14): clamp, never refuse. Both editors clamp a
// typed value into [0, 90] on commit and show the clamped value; compute
// uses exactly the saved value and never substitutes an unrelated default
// for an out-of-range (but numeric) threshold.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ImportedGeometry, Operation, Setup, Tool } from '../../types'
import {
  DEFAULT_STEEP_SHALLOW3D_PARAMS,
  readSteepShallow3dParams,
} from '../../cam3d/integration/steepShallow3dOperation'

// jsdom's localStorage is unreliable under vitest's node launch flags and the
// Zustand store uses persist(); install an in-memory shim BEFORE importing
// the store (mirrors the other PropertiesPanel *.test.tsx files).
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

const SETUP_ID = 'setup-1'
const GEO_ID = 'geo-solid-1'
const TOOL_ID = 'tool-flat-1'
const OP_ID = 'op-ss3d-1'

const flatTool = {
  id: TOOL_ID, name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, numberOfFlutes: 2,
} as unknown as Tool

// A single ready steep_shallow_3d op so the PropertiesPanel quick-edit block renders.
function seedSteepShallow3dOp(thresholdDeg = 30): void {
  const geo = {
    id: GEO_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
    loops: [{ id: 'l1', points: [] }],
  } as unknown as ImportedGeometry
  const op = {
    id: OP_ID, name: 'Steep and Shallow 1', type: 'steep_shallow_3d', toolId: TOOL_ID,
    enabled: true, status: 'ready', geometrySelections: [GEO_ID],
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {},
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
      feedHeight: 0.5, topHeight: 0, topHeightMode: 'stock_top',
      bottomHeight: -5, bottomHeightMode: 'absolute',
    },
    params: { ...DEFAULT_STEEP_SHALLOW3D_PARAMS, thresholdDeg },
  } as unknown as Operation
  const setup = {
    id: SETUP_ID, name: 'Setup 1', wcs: { origin: { x: 0, y: 0, z: 0 } },
    operations: [op],
  } as unknown as Setup
  act(() => {
    useCamStore.setState((s) => ({
      toolLibrary: [flatTool],
      project: {
        ...s.project, geometry: [geo], setups: [setup],
        activeSetupId: SETUP_ID, activeOperationId: OP_ID,
      },
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    } as never))
  })
}

function thresholdInput(): HTMLInputElement {
  const label = screen.getByText('Threshold')
  const input = label.parentElement?.querySelector('input')
  if (!input) throw new Error('no input found for Threshold row')
  return input as HTMLInputElement
}
function commitValue(input: HTMLInputElement, value: string): void {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}
function opParams(): { thresholdDeg: number } {
  return useCamStore.getState().project.setups[0].operations[0].params as { thresholdDeg: number }
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
})

describe('PropertiesPanel Steep/Shallow Threshold bound (WO-1515)', () => {
  it('will not save or display a value above 90 degrees (matches the modal field)', () => {
    seedSteepShallow3dOp()
    render(createElement(PropertiesPanel))

    commitValue(thresholdInput(), '100')
    expect(opParams().thresholdDeg).toBe(90)
    expect(thresholdInput().value).toBe('90')
  })

  it('will not save or display a value below 0 degrees', () => {
    seedSteepShallow3dOp()
    render(createElement(PropertiesPanel))

    commitValue(thresholdInput(), '-5')
    expect(opParams().thresholdDeg).toBe(0)
    expect(thresholdInput().value).toBe('0')
  })

  it('keeps an in-range typed value exactly as entered', () => {
    seedSteepShallow3dOp()
    render(createElement(PropertiesPanel))

    commitValue(thresholdInput(), '42')
    expect(opParams().thresholdDeg).toBe(42)
  })
})

describe('readSteepShallow3dParams threshold handling (WO-1515 / BUG-422)', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => warn.mockRestore())

  it('never silently substitutes the default for an out-of-range numeric threshold', () => {
    // The audit-named defect: a persisted 100 (e.g. from an old file, or a
    // value entered before this fix) must resolve to a value that is
    // VISIBLY the value actually used -- not the unrelated 30 deg default.
    expect(readSteepShallow3dParams({ thresholdDeg: 100 }).thresholdDeg).toBe(90)
    expect(readSteepShallow3dParams({ thresholdDeg: 100 }).thresholdDeg)
      .not.toBe(DEFAULT_STEEP_SHALLOW3D_PARAMS.thresholdDeg)
  })

  it('clamps at both boundaries to the same 0-90 range the UI enforces', () => {
    expect(readSteepShallow3dParams({ thresholdDeg: 91 }).thresholdDeg).toBe(90)
    expect(readSteepShallow3dParams({ thresholdDeg: -1 }).thresholdDeg).toBe(0)
    expect(readSteepShallow3dParams({ thresholdDeg: 42 }).thresholdDeg).toBe(42)
  })

  it('falls back to the default only for a genuinely absent/invalid field, not an out-of-range one', () => {
    expect(readSteepShallow3dParams({}).thresholdDeg).toBe(DEFAULT_STEEP_SHALLOW3D_PARAMS.thresholdDeg)
    expect(readSteepShallow3dParams({ thresholdDeg: 'bogus' }).thresholdDeg)
      .toBe(DEFAULT_STEEP_SHALLOW3D_PARAMS.thresholdDeg)
    expect(readSteepShallow3dParams({ thresholdDeg: NaN }).thresholdDeg)
      .toBe(DEFAULT_STEEP_SHALLOW3D_PARAMS.thresholdDeg)
  })

  it('logs one console line naming the clamp when a persisted value was out of range', () => {
    readSteepShallow3dParams({ thresholdDeg: 100 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('100')
    expect(warn.mock.calls[0][0]).toContain('90')
  })

  it('stays silent for an in-range value', () => {
    readSteepShallow3dParams({ thresholdDeg: 42 })
    expect(warn).not.toHaveBeenCalled()
  })
})
