// @vitest-environment jsdom
//
// WO-1389: DesignTree and PropertiesPanel printed setup.wcs.label as STORED,
// while post/simulation/program context resolve the effective offset through
// resolveSetupWorkOffset (a stock-bound fixture-offset override can leave the
// stored label stale). BUG-524: tree/Properties showed G56 while the posted
// program used G55. This is a React-render SMOKE/pin test: the fix is a
// display-only read substitution, invisible to pure-logic tests.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the uiPrefs/useCamStore Zustand stores use persist(). Install a minimal
// in-memory Storage shim BEFORE importing the store (same scaffolding as
// PropertiesPanelSetupStock.smoke.test.tsx / DesignTreeSetupAutoExpand.test.tsx).
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

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { ImportedGeometry, PhysicalStock, Setup } from '../../types'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { makeMachine, makeOp, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'

const { DesignTree } = await import('../../components/panels/DesignTree')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { postProject } = await import('../../lib/post/postProject')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({ expandedSetupIds: [] })
  })
})

function stock(id: string, fixtureOffset?: number): PhysicalStock {
  return {
    id,
    name: `Stock ${id}`,
    mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 20 },
      size: { x: 100, y: 100, z: 20 }, center: { x: 50, y: 50, z: 10 },
    },
    position: { x: 0, y: 0, z: 0 },
    fixtureOffset,
  }
}

// A setup whose stored wcs.label/fixtureOffset (G56) disagrees with its bound
// stock's assigned fixtureOffset (G55). Unmarked (no fixtureOffsetOwner), so
// resolveSetupWorkOffset applies the legacy stock-first rule -> resolves G55,
// same as BUG-524.
function setupBoundToStock(stockId: string): Setup {
  return {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: makeWcs({
      id: 'wcs-1',
      label: 'G56',
      fixtureOffset: 56,
      stockId,
      cornerRow: 0,
      cornerCol: 0,
      cornerFace: 'top',
      originBinding: {
        kind: 'stock_corner',
        stockId,
        cornerRow: 0,
        cornerCol: 0,
        cornerFace: 'top',
      },
    }),
    stock: {} as Setup['stock'],
    operations: [],
    notes: '',
  }
}

// A plain unbound setup: no stock override, wcs.label unchanged by the resolver.
function unboundSetup(): Setup {
  return {
    id: 'setup-2',
    name: 'Setup 2',
    wcs: makeWcs({ id: 'wcs-2', label: 'G54', fixtureOffset: 54 }),
    stock: {} as Setup['stock'],
    operations: [],
    notes: '',
  }
}

function seed(setups: Setup[], geometry: ImportedGeometry[], stocks: PhysicalStock[]) {
  act(() => {
    useCamStore.setState((s) => ({
      project: { ...s.project, stocks, geometry, setups, activeSetupId: setups[0]?.id ?? null },
    }))
  })
}

describe('WO-1389: tree and Properties display the resolved work offset', () => {
  it('DesignTree shows the resolved label (G55), not the stale stored label (G56)', () => {
    seed([setupBoundToStock('stock-a')], [], [stock('stock-a', 55)])
    render(<DesignTree />)
    const meta = document.querySelector('.tree-setup-meta')
    expect(meta?.textContent).toBe('G55')
  })

  it('PropertiesPanel shows the resolved label (G55), not the stale stored label (G56)', () => {
    seed([setupBoundToStock('stock-a')], [], [stock('stock-a', 55)])
    act(() => { useCamStore.getState().setActiveSetup('setup-1') })
    render(<PropertiesPanel />)
    expect(screen.getByText('WCS').nextSibling?.textContent).toBe('G55')
  })

  it('the posted program actually uses G55 for the same setup/stock binding', () => {
    const s = setupBoundToStock('stock-a')
    const op = makeOp({ id: 'op-1', name: 'Op 1', toolId: 't1' })
    s.operations = [op]
    const project = {
      id: 'p', name: 'WO-1389', version: '1', createdAt: '', updatedAt: '',
      machine: makeMachine(), toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
      geometry: [], stocks: [stock('stock-a', 55)], setups: [s],
      activeSetupId: s.id, activeOperationId: null,
      sceneStock: {} as never, notes: '',
    }
    stampGenerationCurrent(project as never, s, op, project.toolLibrary[0])

    const result = postProject(project as never, [s], UCCNC_CONFIG, {
      mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc',
    })
    expect(result.ok).toBe(true)
    expect(result.combined?.gcode.split('\n')).toContain('G55')
    expect(result.combined?.gcode.split('\n')).not.toContain('G56')
  })

  it('unaffected: a setup with no stock override displays its stored label unchanged', () => {
    seed([unboundSetup()], [], [])
    render(<DesignTree />)
    const meta = document.querySelector('.tree-setup-meta')
    expect(meta?.textContent).toBe('G54')
  })

  it('PropertiesPanel: a setup with no stock override displays its stored label unchanged', () => {
    seed([unboundSetup()], [], [])
    act(() => { useCamStore.getState().setActiveSetup('setup-2') })
    render(<PropertiesPanel />)
    expect(screen.getByText('WCS').nextSibling?.textContent).toBe('G54')
  })
})
