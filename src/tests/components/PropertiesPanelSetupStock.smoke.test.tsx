// @vitest-environment jsdom
//
// React-render SMOKE test for the PropertiesPanel SETUP branch one-stock-per-setup
// fail-loud banner (ADR 0026 + ADR 0003). The repo's vitest env is 'node' by
// default (vite.config.ts); the directive above flips THIS file to jsdom so a real
// React tree can mount.
//
// WHY THIS GATE EXISTS: a hooks-order bug ("Rendered more hooks than during the
// previous render") shipped once because a hook sat below an early return and tsc
// + the pure-logic suite did not catch it (feedback_render_gate_ui_changes). The
// banner adds useMemo + three useCamStore selectors to SetupProperties; this file
// mounts PropertiesPanel with a selected setup so that render path runs.
//
// WHAT IT ASSERTS:
//  (a) a setup whose two ops resolve to TWO different stocks -> the conflict
//      banner renders and contains the checker's "spans multiple stocks" reason.
//  (b) a single-stock setup -> no conflict banner.
// Resilient: render + presence/absence, not pixel-perfect.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { BoundingBox, PhysicalStock, Setup, Operation, ImportedGeometry } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a minimal
// in-memory Storage shim BEFORE importing the store. Pure test scaffolding; no app
// change. (Mirrors PropertiesPanelNest.smoke.test.tsx.)
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

// The store is a process singleton; reset to a clean project before each test so
// the tests are order-independent.
beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
  })
})

function box(w: number, h: number, d: number): BoundingBox {
  return {
    min: { x: 0, y: 0, z: 0 }, max: { x: w, y: h, z: d },
    size: { x: w, y: h, z: d }, center: { x: w / 2, y: h / 2, z: d / 2 },
  }
}

function explicitStock(id: string, name: string): PhysicalStock {
  return {
    id, name, mode: 'explicit', bounds: box(100, 100, 20), position: { x: 0, y: 0, z: 0 },
  }
}

function geo(id: string, name: string, stockId: string): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: box(10, 10, 10),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId, stockIdLocked: true,
  } as unknown as ImportedGeometry
}

function op(id: string, geometryId: string): Operation {
  return {
    id, name: id, toolId: 't1', params: { geometryId }, status: 'ready',
    toolpathMoves: [{ type: 'rapid', x: 1, y: 2, z: 3 }],
  } as unknown as Operation
}

// Seed N geometries (each bound to its own stock) + a setup with one op per
// geometry, then select that setup so SetupProperties renders.
function seedSetup(
  stockIds: string[],
  wcsUpdates: Partial<Setup['wcs']> = {},
): Setup {
  const stocks: PhysicalStock[] = stockIds.map((sid, i) => explicitStock(sid, `Stock ${i + 1}`))
  const geos: ImportedGeometry[] = stockIds.map((sid, i) => geo(`g-${i}`, `Part ${i + 1}`, sid))
  const ops: Operation[] = geos.map((g, i) => op(`op-${i}`, g.id))
  // wcs.label + stock.type are read by the existing SetupProperties rows; supply
  // minimal runtime values so the (pre-existing) summary renders.
  const setup = {
    id: 'setup-1', name: 'Setup A', operations: ops,
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 1, y: 2, z: 3 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      originBinding: { kind: 'manual' },
      ...wcsUpdates,
    },
    stock: { type: 'auto' }, notes: '',
  } as unknown as Setup
  act(() => {
    useCamStore.setState((s) => ({
      project: { ...s.project, stocks, geometry: geos, setups: [setup] },
    }))
    useCamStore.getState().setActiveSetup(setup.id)
  })
  return setup
}

describe('PropertiesPanel setup one-stock-per-setup banner render smoke', () => {
  it('mounts the setup view without throwing (guards hooks-order)', () => {
    seedSetup(['stock-a'])
    render(<PropertiesPanel />)
    expect(screen.getByText('Properties')).not.toBeNull()
    expect((screen.getByTestId('setup-name-input') as HTMLInputElement).value).toBe('Setup A')
  })

  it('(a) a setup spanning TWO stocks renders the conflict banner with the reason', () => {
    seedSetup(['stock-a', 'stock-b'])
    render(<PropertiesPanel />)
    const banner = screen.getByTestId('setup-stock-conflict')
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('spans multiple stocks')
    // The reason names both bound stocks.
    expect(banner.textContent).toContain('Stock 1')
    expect(banner.textContent).toContain('Stock 2')
  })

  it('(b) a single-stock setup renders NO conflict banner', () => {
    seedSetup(['stock-a'])
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('setup-stock-conflict')).toBeNull()
  })

  it('edits the setup name through updateSetup and records an undo entry', () => {
    seedSetup(['stock-a'])
    render(<PropertiesPanel />)
    const input = screen.getByTestId('setup-name-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Second setup' } })
    fireEvent.blur(input)

    expect(useCamStore.getState().project.setups[0].name).toBe('Second setup')
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.setups[0].name).toBe('Setup A')
  })

  it.each([
    ['x', 12, { x: 12, y: 2, z: 3 }],
    ['y', 13, { x: 1, y: 13, z: 3 }],
    ['z', 14, { x: 1, y: 2, z: 14 }],
  ] as const)('edits manual WCS %s and centrally invalidates ready toolpaths', (axis, value, expectedOrigin) => {
    seedSetup(['stock-a'])
    render(<PropertiesPanel />)
    const input = screen.getByLabelText(`WCS origin ${axis.toUpperCase()} (mm)`) as HTMLInputElement
    fireEvent.change(input, { target: { value: String(value) } })
    fireEvent.blur(input)

    const changed = useCamStore.getState().project.setups[0]
    expect(changed.wcs.origin).toEqual(expectedOrigin)
    expect(changed.wcs.originBinding).toEqual({ kind: 'manual' })
    expect(changed.wcs.stockId).toBeUndefined()
    expect(changed.wcs.snapGeoId).toBeUndefined()
    expect(changed.operations[0].status).toBe('outdated')
    expect(changed.operations[0].toolpathMoves).toBeUndefined()
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.setups[0].wcs.origin).toEqual({ x: 1, y: 2, z: 3 })
  })

  it.each([
    [{ originBinding: { kind: 'stock_corner', stockId: 'stock-a', cornerRow: 0, cornerCol: 0, cornerFace: 'top' } }, 'stock corner'],
    [{ originBinding: { kind: 'part_feature', geoId: 'g-0', featureRef: { kind: 'vertex', localPt: { x: 0, y: 0, z: 0 } } } }, 'model vertex'],
    [{ originBinding: undefined, stockId: 'stock-a', cornerRow: 0, cornerCol: 0, cornerFace: 'top' }, 'stock corner'],
    [{ originBinding: undefined, snapGeoId: 'g-0', snapLocalPt: { x: 0, y: 0, z: 0 } }, 'model vertex'],
  ] as const)('keeps a bound origin read-only and directs it to Edit setup', (wcsUpdates, label) => {
    seedSetup(['stock-a'], wcsUpdates as Partial<Setup['wcs']>)
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('setup-wcs-origin-manual')).toBeNull()
    // WO-2007 (CS 21): the binding is the origin value's tooltip, not a sentence under it.
    const bound = screen.getByTestId('setup-wcs-origin-bound')
    expect(bound.textContent).not.toContain('Bound to')
    expect(bound.getAttribute('data-tooltip')).toContain(`Bound to ${label}`)
    expect(bound.getAttribute('data-tooltip')).toContain('Use Edit setup')
  })
})
