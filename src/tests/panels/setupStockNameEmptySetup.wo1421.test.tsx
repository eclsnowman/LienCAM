// @vitest-environment jsdom
//
// WO-1421: PropertiesPanel's setup Stock row showed the generic stock TYPE
// label ("rectangular"/"auto") for a setup with zero operations even when the
// setup's own WCS is explicitly bound to a named stock. The row derived
// resolvedStockName ONLY from setupStockConsistency, which walks OPERATIONS —
// a setup with none has nothing to walk. The fix falls back to the setup's
// own bound stock (setupProvenStockId, the same resolver two other call sites
// in this file already reuse) when the op-based check cannot name one.
//
// Mirrors PropertiesPanelSetupStock.smoke.test.tsx's render scaffolding.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { BoundingBox, PhysicalStock, Setup, Operation, ImportedGeometry } from '../../types'

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

function geo(id: string, name: string, stockId?: string): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: box(10, 10, 10),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId, stockIdLocked: stockId !== undefined,
  } as unknown as ImportedGeometry
}

function op(id: string, geometryId: string): Operation {
  return {
    id, name: id, toolId: 't1', params: { geometryId }, status: 'ready',
    toolpathMoves: [{ type: 'rapid', x: 1, y: 2, z: 3 }],
  } as unknown as Operation
}

// Seed a project with one named stock, one geometry bound to it, and a setup
// whose operations + WCS binding are supplied by the caller — lets each test
// build the exact zero-op / bound / unbound combination it needs.
function seedProject(opts: {
  ops: Operation[]
  wcs: Partial<Setup['wcs']>
  stockType?: string
}): Setup {
  const stocks: PhysicalStock[] = [explicitStock('stock-a', 'Stock 1')]
  const geos: ImportedGeometry[] = [geo('g-0', 'Part 1', 'stock-a')]
  const setup = {
    id: 'setup-1', name: 'Setup A', operations: opts.ops,
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 1, y: 2, z: 3 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      originBinding: { kind: 'manual' },
      ...opts.wcs,
    },
    stock: { type: opts.stockType ?? 'rectangular' }, notes: '',
  } as unknown as Setup
  act(() => {
    useCamStore.setState((s) => ({
      project: { ...s.project, stocks, geometry: geos, setups: [setup] },
    }))
    useCamStore.getState().setActiveSetup(setup.id)
  })
  return setup
}

describe('WO-1421: setup Stock row falls back to the setup\'s own binding when there are no operations', () => {
  it('(AC1) zero operations, explicit stock_corner binding -> shows the bound stock name', () => {
    seedProject({
      ops: [],
      wcs: { originBinding: { kind: 'stock_corner', stockId: 'stock-a', cornerRow: 0, cornerCol: 0, cornerFace: 'top' } },
    })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('setup-stock-name').textContent).toBe('Stock 1')
  })

  it('(AC1) zero operations, part_feature binding with no explicit stockId -> infers via the bound feature\'s owning geometry', () => {
    seedProject({
      ops: [],
      wcs: {
        originBinding: {
          kind: 'part_feature', geoId: 'g-0',
          featureRef: { kind: 'vertex', localPt: { x: 0, y: 0, z: 0 } } as never,
        },
      },
    })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('setup-stock-name').textContent).toBe('Stock 1')
  })

  it('(AC2) operations agree on one stock -> unchanged, still the op-resolved name', () => {
    seedProject({
      ops: [op('op-0', 'g-0')],
      wcs: {},
    })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('setup-stock-name').textContent).toBe('Stock 1')
    expect(screen.queryByTestId('setup-stock-conflict')).toBeNull()
  })

  it('(AC3) operations disagree -> unchanged, existing conflict message and generic label', () => {
    const stocks: PhysicalStock[] = [explicitStock('stock-a', 'Stock 1'), explicitStock('stock-b', 'Stock 2')]
    const geos: ImportedGeometry[] = [geo('g-0', 'Part 1', 'stock-a'), geo('g-1', 'Part 2', 'stock-b')]
    const setup = {
      id: 'setup-1', name: 'Setup A', operations: [op('op-0', 'g-0'), op('op-1', 'g-1')],
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54,
        origin: { x: 1, y: 2, z: 3 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        originBinding: { kind: 'manual' },
      },
      stock: { type: 'rectangular' }, notes: '',
    } as unknown as Setup
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, stocks, geometry: geos, setups: [setup] },
      }))
      useCamStore.getState().setActiveSetup(setup.id)
    })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('setup-stock-conflict').textContent).toContain('spans multiple stocks')
    expect(screen.getByTestId('setup-stock-name').textContent).toBe('rectangular')
  })

  it('(AC4) zero operations, no resolvable binding of any kind -> generic type label, unchanged', () => {
    seedProject({
      ops: [],
      wcs: { originBinding: { kind: 'manual' } },
      stockType: 'rectangular',
    })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('setup-stock-name').textContent).toBe('rectangular')
  })
})
