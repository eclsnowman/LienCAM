// @vitest-environment jsdom
//
// WO-1524 / BUG-527 (family K12b), Tier 2: rendered PropertiesPanel on a real
// fill-mode NestRecord that has been saved and reopened (no modal session state).
//
// The modal's NestResultSummary (NestModal.tsx:1006-1063) already branches on
// isExactChoice(lastCalcSolver): in EXACT modes it shows "<placed> / <requested>";
// in FILL mode (fixSheet) source.quantity is only a RATIO, so it shows just the
// placed count. PropertiesPanel's persisted-record summary never adopted that
// distinction and rendered "15 / 3" for a 1:2 ratio pack that placed 5 rings +
// 10 tiles -- a nonsense shortfall against the raw ratio sum.
//
// This file fails on main before the fix (fill mode renders "15 / 3") and passes
// after (fill mode renders "15"; exact mode is byte-identical to today).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { NestRecord } from '../../types'

// jsdom's localStorage is broken under vitest's node launch flags, and the
// Zustand store uses persist(); install the in-memory shim BEFORE importing the
// store (mirrors PropertiesPanelNest.smoke.test.tsx).
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

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
  })
})

/** One placement record (one placed instance), posed in sheet coords. */
function placement(partId: string, instanceId: string, x: number, y: number) {
  return { partId, instanceId, x, y, rotationDeg: 0, depth: 0 }
}

function makeNest(overrides: Partial<NestRecord>): NestRecord {
  return {
    id: 'nest-wo1524',
    name: 'Ratio Nest',
    sheet: { width: 300, height: 200 },
    style: 'ninety',
    spacing: { partGap: 1, sheetMargin: 2, windowGap: 0 },
    seed: 42,
    sources: [
      { geometryId: 'g-ring', quantity: 1 },
      { geometryId: 'g-tile', quantity: 2 },
    ],
    placements: [],
    unplaced: [],
    utilization: 0.5,
    ...overrides,
  }
}

/** Seed a geometry id so source rows resolve a real name (not the raw id). */
function addGeom(id: string, name: string) {
  useCamStore.getState().addGeometry({
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  })
}

function seedSelectedNest(nest: NestRecord) {
  act(() => {
    addGeom('g-ring', 'Ring')
    addGeom('g-tile', 'Tile')
    useCamStore.setState((s) => ({ project: { ...s.project, nests: [nest] } }))
    useCamStore.getState().setSelectedNest(nest.id)
  })
}

/** The value cell of the "Placed" summary row. */
function placedValue(): HTMLElement {
  const label = screen.getByText('Placed')
  const value = label.parentElement?.querySelector('.props-value')
  if (!value) throw new Error('Placed value cell not found')
  return value as HTMLElement
}

describe('WO-1524: PropertiesPanel Placed summary honours solver exact-vs-fill', () => {
  it('fill mode (fixSheet) shows the placed count, never "placed / ratio-sum"', () => {
    // A correctly packed 1:2 ratio nest: 5 rings + 10 tiles placed (15 total),
    // sources sum to 1 + 2 = 3. Before the fix this read "15 / 3".
    const placements = [
      ...Array.from({ length: 5 }, (_, i) => placement('g-ring', `r-${i}`, i * 10, 0)),
      ...Array.from({ length: 10 }, (_, i) => placement('g-tile', `t-${i}`, i * 10, 20)),
    ]
    seedSelectedNest(makeNest({ solver: { kind: 'fixSheet' }, placements }))
    render(<PropertiesPanel />)

    const cell = placedValue()
    expect(cell.textContent).toBe('15')
    expect(cell.textContent).not.toContain('/')
    expect(cell.getAttribute('data-tooltip')).not.toMatch(/vs requested/i)
  })

  it('fill mode never shows a "(N left)" shortfall suffix against the ratio sum', () => {
    // Leftovers on a fill-mode pack describe the multiplied set, not a requested
    // quantity, so they must not surface as a shortfall here.
    seedSelectedNest(makeNest({
      solver: { kind: 'fixSheet' },
      placements: [placement('g-ring', 'r-0', 0, 0)],
      unplaced: [{ partId: 'g-tile', count: 4 }],
    }))
    render(<PropertiesPanel />)
    const cell = placedValue()
    expect(cell.textContent).toBe('1')
    expect(cell.textContent).not.toContain('left')
  })

  it('exact-quantity mode is unchanged: "<placed> / <requested> (N left)"', () => {
    seedSelectedNest(makeNest({
      solver: { kind: 'fixSheetExact' },
      placements: [placement('g-ring', 'r-0', 0, 0), placement('g-tile', 't-0', 20, 0)],
      unplaced: [{ partId: 'g-tile', count: 1 }],
    }))
    render(<PropertiesPanel />)
    const cell = placedValue()
    expect(cell.textContent).toBe('2 / 3 (1 left)')
    expect(cell.getAttribute('data-tooltip')).toBe('Placed instances vs requested quantity')
  })

  it('exact-quantity mode with no leftover keeps the bare placed/requested form', () => {
    seedSelectedNest(makeNest({
      solver: { kind: 'fixSheetExact' },
      placements: [
        placement('g-ring', 'r-0', 0, 0),
        placement('g-tile', 't-0', 20, 0),
        placement('g-tile', 't-1', 20, 20),
      ],
    }))
    render(<PropertiesPanel />)
    expect(placedValue().textContent).toBe('3 / 3')
  })

  it('fixQtyRatio is EXACT (ratio is a sheet aspect, qty is a requested count) -- matches isExactChoice', () => {
    // The engine's fixQtyRatio packs the EXACT requested quantities at a fixed
    // sheet aspect (solver.ts:455-489, HANDOFF). isExactChoice treats it as exact,
    // so the persisted-record path must too.
    seedSelectedNest(makeNest({
      solver: { kind: 'fixQtyRatio', ratio: 0.5 },
      placements: [
        placement('g-ring', 'r-0', 0, 0),
        placement('g-tile', 't-0', 20, 0),
        placement('g-tile', 't-1', 20, 20),
      ],
    }))
    render(<PropertiesPanel />)
    expect(placedValue().textContent).toBe('3 / 3')
  })

  it('reopening the record does not change stored sources quantities or placements', () => {
    const placements = [
      ...Array.from({ length: 5 }, (_, i) => placement('g-ring', `r-${i}`, i * 10, 0)),
      ...Array.from({ length: 10 }, (_, i) => placement('g-tile', `t-${i}`, i * 10, 20)),
    ]
    const nest = makeNest({ solver: { kind: 'fixSheet' }, placements })
    const before = JSON.stringify({ sources: nest.sources, placements: nest.placements })
    seedSelectedNest(nest)
    render(<PropertiesPanel />)

    const stored = useCamStore.getState().project.nests?.find((n) => n.id === nest.id)
    expect(stored).toBeDefined()
    expect(JSON.stringify({ sources: stored!.sources, placements: stored!.placements })).toBe(before)
  })
})
