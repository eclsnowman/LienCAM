// @vitest-environment jsdom
//
// React-render SMOKE test for the DesignTree Stock section's NAMED AUTO STOCK
// UI (the +Auto button + AutoStockNode + member picker). The repo's vitest env
// is 'node' by default (vite.config.ts); the directive above flips THIS file to
// jsdom so a real React tree can mount.
//
// WHY THIS GATE EXISTS: a hooks-order bug ("Rendered more hooks than during the
// previous render") shipped once in a modal because a hook sat below an early
// return and tsc + the pure-logic vitest suite did not catch it. The render-gate
// rule (feedback_render_gate_ui_changes) requires a React MOUNT test for UI
// changes. This file mounts the DesignTree with an auto-stock present and after
// a +Auto click, exercising the AutoStockNode render path that tsc cannot see.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { queryByTooltip } from '../support/tooltipQuery'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store. Pure test
// scaffolding; no app change. (Mirrors NestModal.smoke.test.tsx.)
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

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

afterEach(cleanup)

// The store is a process singleton; reset to a clean project before each test so
// the tests are order-independent (no inherited auto stocks).
beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useUiPrefs.getState().setExpandedStockIds([])
  })
})

describe('DesignTree auto-stock UI render smoke', () => {
  it('mounts with the +Auto button present (no hooks crash)', () => {
    // A clean project now always has ONE default auto stock (the catch-all made
    // visible — guarantees imported geometry always has a home). Mounting must
    // not throw, the always-on +Auto/+Fixed add buttons must be in the Stock
    // section header, and exactly the default auto-stock node renders.
    render(<DesignTree />)
    expect(screen.getByTestId('stock-add-auto')).not.toBeNull()
    expect(screen.getByTestId('stock-add-fixed')).not.toBeNull()
    expect(screen.getAllByTestId('auto-stock-node').length).toBe(1)
  })

  it('renders the default auto stock COLLAPSED on a fresh mount (Tier 4 declutter), fields still reachable on expand', () => {
    // Tier 4 declutter: expandedStocks now seeds an EMPTY set, so the
    // always-present default auto stock shows as a one-liner (no offset fields)
    // on a fresh project. The offset fields ("XY offset" / "Z top") are NOT
    // removed for the auto stock — they remain reachable by expanding the node
    // (the auto offsets are only editable in-tree; PropertiesPanel's
    // AutoStockSummary is read-only). This asserts the new default AND that the
    // capability still exists on click.
    render(<DesignTree />)
    const node = screen.getAllByTestId('auto-stock-node')[0]
    // Collapsed: no expanded body, no offset labels visible yet.
    expect(node.querySelector('.fixed-stock-fields')).toBeNull()
    expect(node.textContent).not.toContain('XY offset')
    // Expanding the node through its dedicated chevron reveals the offset
    // fields. The row body is reserved for selecting the stock.
    act(() => {
      fireEvent.click(screen.getByTestId('auto-stock-chevron'))
    })
    const expanded = screen.getAllByTestId('auto-stock-node')[0]
    expect(expanded.querySelector('.fixed-stock-fields')).not.toBeNull()
    expect(expanded.textContent).toContain('XY offset')
    expect(expanded.textContent).toContain('Z top')
    expect(expanded.textContent).toContain('Z bottom') // AUTO-STOCK-BOTTOM: flip/backside allowance field
  })

  it('renders an additional AutoStockNode after clicking +Auto', () => {
    render(<DesignTree />)
    // Starts with the default auto stock.
    expect(screen.getAllByTestId('auto-stock-node').length).toBe(1)

    // Click +Auto. This calls the real handleAddAutoStock -> addAutoStock store
    // action; getVp() returns null in the test so the optional rebuildStock is a
    // no-op. The store update re-renders the tree with a second AutoStockNode —
    // the exact mount path tsc cannot verify (the hooks-order guard).
    act(() => {
      fireEvent.click(screen.getByTestId('stock-add-auto'))
    })

    const nodes = screen.getAllByTestId('auto-stock-node')
    expect(nodes.length).toBe(2)
    // The store really gained the auto stock (UI wired to state, not a fake):
    // the default plus the newly added one.
    expect((useCamStore.getState().project.sceneStock.autoStocks ?? []).length).toBe(2)
  })

  it('selects an auto stock from its row without changing expansion', () => {
    render(<DesignTree />)
    const stock = useCamStore.getState().project.sceneStock.autoStocks![0]
    const node = screen.getAllByTestId('auto-stock-node')[0]
    const header = node.querySelector('.fixed-stock-header')!

    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
    expect(node.querySelector('.fixed-stock-fields')).toBeNull()

    act(() => {
      fireEvent.click(screen.getByTestId('tree-name-stock-auto'))
    })

    expect(useCamStore.getState().viewer.selectedStockId).toBe(stock.id)
    expect(header.className).toContain('tree-item-geo-active')
    expect(node.querySelector('.fixed-stock-fields')).toBeNull()
  })

  it('expands from the chevron without selecting the auto stock', () => {
    render(<DesignTree />)
    const node = screen.getAllByTestId('auto-stock-node')[0]

    act(() => {
      fireEvent.click(screen.getByTestId('auto-stock-chevron'))
    })

    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
    expect(node.querySelector('.fixed-stock-fields')).not.toBeNull()
  })

  it('does not select the auto stock when its remove action is clicked', () => {
    render(<DesignTree />)
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()

    act(() => {
      fireEvent.click(screen.getByLabelText('Remove auto stock'))
    })

    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
  })

  it('renders an AutoStockNode for a pre-seeded auto stock', () => {
    // Seed via the store action directly, then mount: covers the
    // already-open-with-data first-render path (distinct from the click path).
    // The default auto stock is already present, so the seed makes two nodes.
    act(() => {
      useCamStore.getState().addAutoStock({
        id: 'seed-auto-1',
        name: 'Seeded Auto',
        autoOffsetXY: 3,
        autoOffsetZTop: 2,
      })
    })
    render(<DesignTree />)
    expect(screen.getByText('Seeded Auto')).not.toBeNull()
    expect(screen.getAllByTestId('auto-stock-node').length).toBe(2)
  })

  // ── B5 render gate: N0.1 multi-stock UI cleanup ──────────────────────────
  // Locks the toggle removal, read-only member list, and the None dropdown
  // option against silent regression (hooks-order + wiring tsc cannot see).

  it('no longer renders the AUTO/FIXED mode toggle', () => {
    render(<DesignTree />)
    // The toggle was two buttons with text AUTO / FIXED in a stock-mode-row.
    expect(screen.queryByText('AUTO')).toBeNull()
    expect(screen.queryByText('FIXED')).toBeNull()
  })

  it('auto-stock member list has no checkboxes (read-only)', () => {
    // Add a geometry and pin it to the default auto stock so its member list
    // renders, then expand that node. The list must be READ-ONLY: no checkbox
    // inputs anywhere in the auto-stock node.
    const DERIVED = 'stock-derived-migrated'
    act(() => {
      useCamStore.getState().addGeometry({
        id: 'g-mem', name: 'MemberPart', filename: 'm.stl', type: 'mesh', format: 'stl',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
          size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
        },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      })
      useCamStore.getState().setStockMembership('g-mem', DERIVED)
    })
    render(<DesignTree />)
    const node = screen.getAllByTestId('auto-stock-node')[0]
    // Expand the node through its dedicated chevron so the member list mounts.
    act(() => {
      fireEvent.click(screen.getByTestId('auto-stock-chevron'))
    })
    // The assigned part shows by name; zero checkboxes in the whole node.
    expect(node.querySelectorAll('input[type="checkbox"]').length).toBe(0)
  })

  // ── Setup-bound-to-auto-stock invalid-flag repro ─────────────────────────
  // BUG (Operator, visual): a setup whose WCS is corner-bound to the DEFAULT auto
  // stock (wcs.stockId === DERIVED_STOCK_ID) was flagged as having a missing
  // stock reference ("WCS stock reference is missing — edit setup to reassign",
  // the AlertCircle + .tree-setup-invalid red row). The auto stock DOES exist —
  // it lives in project.stocks (the derived PhysicalStock twin), not in
  // sceneStock.fixedStocks. The stockInvalid guard only consulted fixedStocks,
  // so every auto-bound setup looked dangling. The guard must accept a stockId
  // that resolves to ANY existing stock (auto twin in project.stocks OR a
  // fixedStock), while still flagging a genuinely dangling id (no regression).
  const DERIVED = 'stock-derived-migrated'

  function addCornerSetup(stockId: string) {
    useCamStore.getState().addSetup({
      id: `setup-${stockId}`,
      name: 'Bound Setup',
      wcs: {
        id: 'wcs-1',
        label: 'G54',
        fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        zAxis: { x: 0, y: 0, z: 1 },
        stockId,
        cornerRow: 2,
        cornerCol: 0,
        cornerFace: 'top',
        originBinding: {
          kind: 'stock_corner',
          stockId,
          cornerRow: 2,
          cornerCol: 0,
          cornerFace: 'top',
        },
      },
      stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 5, offsetZBottom: 0, material: 'wood' },
      operations: [],
      notes: '',
    })
  }

  it('does NOT flag a setup bound to the default auto stock as invalid', () => {
    // The default auto stock (DERIVED_STOCK_ID) exists in project.stocks of a
    // fresh project. Binding a setup to it must NOT raise the invalid flag.
    act(() => {
      addCornerSetup(DERIVED)
    })
    render(<DesignTree />)
    expect(document.querySelector('.tree-setup-invalid')).toBeNull()
    expect(
      queryByTooltip('WCS stock reference is missing — edit setup to reassign'),
    ).toBeNull()
  })

  it('STILL flags a setup bound to a genuinely dangling stock id', () => {
    // Regression guard: a stockId matching neither a fixedStock nor any
    // project.stocks entry is a real dangling reference and must stay flagged.
    act(() => {
      addCornerSetup('no-such-stock-id')
    })
    render(<DesignTree />)
    expect(document.querySelector('.tree-setup-invalid')).not.toBeNull()
    expect(
      queryByTooltip('WCS stock reference is missing — edit setup to reassign'),
    ).not.toBeNull()
  })

  it('per-geometry stock dropdown contains a None option', () => {
    act(() => {
      useCamStore.getState().addGeometry({
        id: 'g-drop', name: 'DropPart', filename: 'd.stl', type: 'mesh', format: 'stl',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
          size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
        },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      })
    })
    render(<DesignTree />)
    const select = document.querySelector('select.tree-geo-stock-select') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    const optionTexts = Array.from(select!.options).map((o) => o.textContent)
    expect(optionTexts).toContain('None')
  })
})
