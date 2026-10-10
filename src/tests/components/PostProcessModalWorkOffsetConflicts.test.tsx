// @vitest-environment jsdom
//
// POST-MODAL-WORK-OFFSET-CONFLICT: regression for the Post Process modal's
// inline "conflicts with" badges. The modal must use the SAME resolved,
// physical-owner-aware conflict semantics as the real post path
// (resolveSetupWorkOffset + findResolvedWorkOffsetConflicts), not the legacy
// setup-only findWorkOffsetConflicts. Two setups on the SAME stock sharing one
// offset are valid (no badge); two DIFFERENT physical owners on one offset are
// still a conflict (badge shows). The modal must not throw during render when
// resolution refuses malformed setup/stock data.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type {
  BoundingBox,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  Project,
  Setup,
  Vec3,
} from '../../types'
import { makeTool, makeOp, makeWcs, makeMachine, move } from '../post/helpers'

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

// ---- localStorage stub (the modal reads/saves user posts on open) ----
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

// ---- test data constructors (mirror src/tests/post/perStockWorkOffsets.test.ts) ----
function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min },
    max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    },
  }
}

function stock(id: string, fixtureOffset?: number): PhysicalStock {
  return {
    id,
    name: `Stock ${id}`,
    mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 10 }),
    position: { x: 0, y: 0, z: 0 },
    fixtureOffset,
  }
}

function geometry(id: string, stockId: string): ImportedGeometry {
  return {
    id,
    name: id,
    filename: `${id}.dxf`,
    type: 'curves_2d',
    format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId,
    loops: [],
  } as ImportedGeometry
}

function operation(id: string, geometryId: string): Operation {
  return makeOp({
    id,
    name: id,
    toolId: 't1',
    params: { geometryId },
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 5, y: 0, z: 0, feed: 100, role: 'cut' }),
    ],
  })
}

function setup(
  id: string,
  fixtureOffset: number,
  stockId?: string,
  operations: Operation[] = [],
): Setup {
  return {
    id,
    name: `Setup ${id}`,
    wcs: makeWcs({
      id: `wcs-${id}`,
      label: `G${fixtureOffset}`,
      fixtureOffset,
      ...(stockId
        ? {
            stockId,
            cornerRow: 2,
            cornerCol: 0,
            cornerFace: 'top' as const,
            originBinding: {
              kind: 'stock_corner' as const,
              stockId,
              cornerRow: 2,
              cornerCol: 0,
              cornerFace: 'top' as const,
            },
          }
        : {}),
    }),
    stock: {} as Setup['stock'],
    operations,
    notes: '',
  }
}

function project(
  setups: Setup[],
  geometryRows: ImportedGeometry[],
  stocks: PhysicalStock[],
): Project {
  return {
    id: 'p',
    name: 'Post-modal WO conflict',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: geometryRows,
    stocks,
    setups,
    activeSetupId: setups[0]?.id ?? null,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }
}

const originalProject = useCamStore.getState().project
const originalToolLibrary = useCamStore.getState().toolLibrary

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
  useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary })
})

// WO-2043 opens on the active setup with "All operations" off, so the
// per-setup ScopeTree and its inline conflict badges are already visible.
function renderModalWithScopeTree(p: Project): void {
  act(() => {
    useCamStore.setState({
      project: p,
      toolLibrary: p.toolLibrary,
    } as never)
  })
  render(<PostProcessModal />)
  act(() => { useCamStore.getState().openModal('post-process') })
  expect((screen.getByRole('checkbox', { name: /^All operations/ }) as HTMLInputElement).checked).toBe(false)
}

function setupRow(setupName: string): HTMLElement {
  const nameEl = screen.getByText(setupName)
  return nameEl.closest('.scope-setup-row')!
}

function setupWcsLabel(setupName: string): string {
  const row = setupRow(setupName)
  return (row.querySelector('.scope-setup-wcs') as HTMLElement).textContent ?? ''
}

function setupConflictNote(setupName: string): string | null {
  const row = setupRow(setupName)
  const note = row.querySelector('.scope-conflict-note')
  return note ? (note as HTMLElement).textContent ?? '' : null
}

describe('PostProcessModal work-offset conflict badges (stock-aware)', () => {
  it('shows NO conflict badge when two setups share the SAME stock and offset', () => {
    const opA = operation('op-a', 'geo-a')
    const opB = operation('op-b', 'geo-b')
    // Both setups bind to stock-a; stock-a owns G57. Setup-local labels (G54/G55)
    // are stale and must be overridden by the resolved G57.
    const a = setup('a', 54, 'stock-a', [opA])
    const b = setup('b', 55, 'stock-a', [opB])
    const p = project(
      [a, b],
      [geometry('geo-a', 'stock-a'), geometry('geo-b', 'stock-a')],
      [stock('stock-a', 57)],
    )

    renderModalWithScopeTree(p)

    // Resolved labels follow the stock override (G57), not the stale setup-local values.
    expect(setupWcsLabel('Setup a')).toBe('G57')
    expect(setupWcsLabel('Setup b')).toBe('G57')
    // Same physical owner -> no inline conflict badge on either row.
    expect(setupConflictNote('Setup a')).toBeNull()
    expect(setupConflictNote('Setup b')).toBeNull()
    expect(screen.queryByText(/conflicts with/i)).toBeNull()
  })

  it('shows the conflict badge when DIFFERENT physical owners share one offset', () => {
    const opA = operation('op-a', 'geo-a')
    const opB = operation('op-b', 'geo-b')
    // Two distinct stocks both assigned G55 -> a real cross-owner conflict.
    const a = setup('a', 54, 'stock-a', [opA])
    const b = setup('b', 56, 'stock-b', [opB])
    const p = project(
      [a, b],
      [geometry('geo-a', 'stock-a'), geometry('geo-b', 'stock-b')],
      [stock('stock-a', 55), stock('stock-b', 55)],
    )

    renderModalWithScopeTree(p)

    // Both resolve to G55 (stock override).
    expect(setupWcsLabel('Setup a')).toBe('G55')
    expect(setupWcsLabel('Setup b')).toBe('G55')
    // Different owners on one offset -> inline badge on both rows.
    expect(setupConflictNote('Setup a')).toMatch(/conflicts with/i)
    expect(setupConflictNote('Setup b')).toMatch(/conflicts with/i)
  })

  it('does not throw during render when a setup binds to a missing stock', () => {
    // 'dangling' is bound to a stock id that does not exist -> resolveSetupWorkOffset
    // throws WORK_OFFSET_STOCK_MISSING. The modal must swallow it (render anyway)
    // and fall back to the stale setup-local label, while posting still fails loud.
    const dangling = setup('dangling', 54, 'ghost')
    const p = project([dangling], [], [stock('stock-a', 55)])

    expect(() => renderModalWithScopeTree(p)).not.toThrow()

    // Resolution refused -> falls back to the setup-local G54 label.
    expect(setupWcsLabel('Setup dangling')).toBe('G54')
    // No conflict badge (the malformed setup was skipped, not declared valid).
    expect(setupConflictNote('Setup dangling')).toBeNull()
  })
})
