// @vitest-environment jsdom
//
// React-render SMOKE test for SetupModal. The repo's vitest env is 'node' by
// default (see vite.config.ts); the directive above flips THIS file to jsdom so
// a real React tree can mount. jsdom is already a devDependency. Pattern mirrors
// src/tests/components/NestModal.smoke.test.tsx.
//
// WHY THIS EXISTS (feedback_render_gate_ui_changes): tsc + the pure-logic vitest
// suite do NOT catch React hooks-order crashes (a useEffect below an early
// `if (!isOpen) return null` throws "Rendered more hooks than during the
// previous render" only at render time). The mount-closed-then-open transition
// below is exactly that path. This file also guards the DEFECT-2 fix: the stock
// picker must be MODE-AGNOSTIC and list every named stock from project.stocks
// (auto twins + fixed twins), not just fixed stocks.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { PhysicalStock, BoundingBox, Operation, Setup, Vec3 } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags; the
// Zustand store uses persist() which writes on every set(). Install a minimal
// in-memory Storage shim BEFORE importing the store. Pure test scaffolding.
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

const { SetupModal } = await import('../../components/modals/SetupModal')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent, heightParamsFromSetupIntent } = await import('../../lib/cam/heightIntent')
const { buildPlanarRoughSmartHeightIntent } = await import('../../lib/cam/smartHeights')
const { operationGenerationIsCurrent } = await import('../../lib/cam/generationFingerprint')
const { setupOwnsFixtureOffset } = await import('../../lib/post/workOffsets')
const { makeOp, makeTool, stampGenerationCurrent } = await import('../post/helpers')

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function derivedStock(id: string, name: string): PhysicalStock {
  return {
    id, name, mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 5 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function explicitStock(id: string, name: string): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }),
    position: { x: 200, y: 0, z: 0 },
  }
}

function setupForStock(
  id: string,
  stockId: string,
  fixtureOffset: 54 | 55 | 56 | 57 | 58 | 59,
): Setup {
  return {
    id,
    name: `Setup ${id}`,
    wcs: {
      id: `wcs-${id}`,
      label: `G${fixtureOffset}`,
      fixtureOffset,
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
    stock: {
      type: 'rectangular',
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 5,
      offsetZBottom: 0,
      material: 'wood',
    },
    operations: [],
    notes: '',
  }
}

/** Install stocks into the store and force the setup modal closed. */
function installStocks(stocks: PhysicalStock[]): void {
  installProject(stocks, [], [])
}

/** Install stocks + geometry + nests into the store and force the modal closed.
 *  Geometry/nests drive the new smart-pick (geometryBearingStockIds). */
function installProject(
  stocks: PhysicalStock[],
  geometry: Array<{ stockId?: string }>,
  nests: Array<{ boundStockId?: string }>,
): void {
  act(() => {
    useCamStore.setState((s) => ({
      activeModal: null,
      editingSetupId: null,
      project: {
        ...s.project,
        stocks,
        setups: [],
        // Cast: the smoke fixtures carry only the id-bearing fields the
        // smart-pick reads; the modal does not touch the rest in these paths.
        geometry: geometry as unknown as typeof s.project.geometry,
        nests: nests as unknown as typeof s.project.nests,
      },
    }))
  })
}

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

describe('SetupModal render smoke', () => {
  it('mounts closed without crashing', () => {
    installStocks([derivedStock('stock-derived-migrated', 'Auto Stock 1')])
    render(<SetupModal />)
    // Closed -> the modal self-gates and renders nothing.
    expect(screen.queryByText('New Setup')).toBeNull()
  })

  it('opens without a hooks-order crash and shows the stock picker', () => {
    installStocks([derivedStock('stock-derived-migrated', 'Auto Stock 1')])
    // Mount CLOSED first so the open is a true closed->open hook transition.
    render(<SetupModal />)
    expect(screen.queryByText('New Setup')).toBeNull()

    act(() => { useCamStore.getState().openModal('new-setup') })

    // Modal body rendered (all hooks in stable order).
    expect(screen.getByText('New Setup')).not.toBeNull()
    // The mode-agnostic stock picker label renders (one auto stock present).
    expect(screen.getByText('Stock')).not.toBeNull()
    // And its option carries the named auto stock.
    expect(screen.getByRole('option', { name: /Auto Stock 1/ })).not.toBeNull()
    for (const plane of ['clearance', 'retract', 'feed', 'top', 'bottom']) {
      expect(screen.getByLabelText(`Setup default ${plane} height`)).not.toBeNull()
    }

    act(() => { useCamStore.getState().closeModal() })
    expect(screen.queryByText('New Setup')).toBeNull()
  })

  it('lists BOTH a named auto stock and a fixed stock (mode-agnostic)', () => {
    installStocks([
      derivedStock('stock-derived-migrated', 'Auto Stock 1'),
      explicitStock('fixed-1', 'Vise Block'),
    ])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    expect(screen.getByText('New Setup')).not.toBeNull()
    // Both named stocks appear as options, proving the picker sources the
    // unified project.stocks (auto + fixed), not the fixed-only legacy list.
    expect(screen.getByRole('option', { name: /Auto Stock 1/ })).not.toBeNull()
    expect(screen.getByRole('option', { name: /Vise Block/ })).not.toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })

  it('shows and saves the selected setup work offset without rewriting its stock', () => {
    const block = { ...explicitStock('fixed-offset', 'Offset Block'), fixtureOffset: 56 }
    installProject([block], [{ stockId: block.id }], [])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    const offset = screen.getByTestId('stock-work-offset-select') as HTMLSelectElement
    expect(offset.value).toBe('56')

    act(() => { fireEvent.change(offset, { target: { value: '57' } }) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Create Setup/ })) })

    const state = useCamStore.getState()
    expect(state.project.stocks?.find((stock) => stock.id === block.id)?.fixtureOffset).toBe(56)
    expect(state.project.setups[0].wcs.fixtureOffset).toBe(57)
    expect(state.project.setups[0].wcs.label).toBe('G57')
    expect(setupOwnsFixtureOffset(state.project.setups[0].wcs)).toBe(true)
    expect(state.project.setups[0].defaultHeightIntent).toEqual(defaultHeightIntent())
  })

  // The invalidation this WO adds must fire on a real change and ONLY on a real
  // change. Re-opening a setup and pressing Save without touching anything is the
  // commonest thing an operator does to one, and outdating computed work there
  // would be the same invisible loss in a new costume.
  it('saving an unchanged setup leaves its computed work current and says nothing', () => {
    const block = { ...explicitStock('fixed-noop', 'No-op Block'), fixtureOffset: 54 }
    const tool = makeTool()
    const op = makeOp({ id: 'noop-op' })
    const setup = { ...setupForStock('noop', block.id, 54), operations: [op] }
    ;(setup.wcs as typeof setup.wcs & { fixtureOffsetOwner: 'setup' }).fixtureOffsetOwner = 'setup'
    installProject([block], [{ stockId: block.id }], [])
    act(() => {
      useCamStore.setState((state) => ({
        consoleEvents: [],
        project: {
          ...state.project,
          setups: [setup],
          activeSetupId: setup.id,
          toolLibrary: [tool],
        },
      }))
    })
    const primed = useCamStore.getState().project
    stampGenerationCurrent(primed, setup, op, tool)
    expect(operationGenerationIsCurrent(primed, setup, op)).toBe(true)

    render(<SetupModal />)
    act(() => { useCamStore.getState().openEditSetup(setup.id) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Save Setup/ })) })

    const after = useCamStore.getState()
    const savedOp = after.project.setups[0].operations[0]
    expect(savedOp.status).toBe('ready')
    expect(savedOp.toolpathMoves).toEqual(op.toolpathMoves)
    expect(operationGenerationIsCurrent(after.project, after.project.setups[0], savedOp)).toBe(true)
    expect(after.consoleEvents.length).toBe(0)
  })

  it('creates Setup 2 on G55 without changing or outdating computed Setup 1', () => {
    const block = { ...explicitStock('fixed-two-setup', 'Two Setup Block'), fixtureOffset: 54 }
    installProject([block], [{ stockId: block.id }], [])
    const tool = makeTool()
    const op = makeOp({ id: 'computed-op' })
    const first = { ...setupForStock('first', block.id, 54), operations: [op] }
    const project = {
      ...useCamStore.getState().project,
      setups: [first],
      activeSetupId: first.id,
      toolLibrary: [tool],
    }
    stampGenerationCurrent(project, first, op, tool)
    act(() => { useCamStore.setState({ project }) })
    expect(operationGenerationIsCurrent(project, first, op)).toBe(true)

    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    fireEvent.change(screen.getByTestId('stock-work-offset-select'), { target: { value: '55' } })
    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))

    const savedProject = useCamStore.getState().project
    const [savedFirst, savedSecond] = savedProject.setups
    expect(savedFirst.wcs).toMatchObject({ fixtureOffset: 54, label: 'G54' })
    expect(savedFirst.operations[0]).toBe(op)
    expect(operationGenerationIsCurrent(savedProject, savedFirst, savedFirst.operations[0])).toBe(true)
    expect(savedSecond.wcs).toMatchObject({ fixtureOffset: 55, label: 'G55' })
    expect(setupOwnsFixtureOffset(savedSecond.wcs)).toBe(true)
    expect(savedProject.stocks?.[0].fixtureOffset).toBe(54)
  })

  it('marks computed work outdated and says so when a setup offset changes', () => {
    const block = { ...explicitStock('fixed-edit-offset', 'Edit Offset Block'), fixtureOffset: 54 }
    const op = makeOp({ id: 'edit-offset-op', computeTimeMs: 42 })
    const setup = { ...setupForStock('edit-offset', block.id, 54), operations: [op] }
    ;(setup.wcs as typeof setup.wcs & { fixtureOffsetOwner: 'setup' }).fixtureOffsetOwner = 'setup'
    installProject([block], [{ stockId: block.id }], [])
    act(() => {
      useCamStore.setState((state) => ({
        consoleEvents: [],
        project: { ...state.project, setups: [setup], activeSetupId: setup.id },
      }))
    })

    render(<SetupModal />)
    act(() => { useCamStore.getState().openEditSetup(setup.id) })
    fireEvent.change(screen.getByTestId('stock-work-offset-select'), { target: { value: '55' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Setup/ }))

    const state = useCamStore.getState()
    expect(state.project.setups[0].wcs).toMatchObject({ fixtureOffset: 55, label: 'G55' })
    expect(state.project.setups[0].operations[0]).toMatchObject({
      status: 'outdated',
      errorMessage: 'Setup work coordinate system changed; regenerate this operation.',
    })
    expect(state.project.setups[0].operations[0].toolpathMoves).toBeUndefined()
    expect(state.project.setups[0].operations[0].computeTimeMs).toBeUndefined()
    expect(state.consoleEvents.at(-1)).toMatchObject({
      severity: 'warning',
      source: 'setup',
    })
    expect(state.consoleEvents.at(-1)?.message).toContain(
      'work offset changed from G54 to G55; 1 computed operation must be regenerated.',
    )
  })

  it('propagates changed defaults only to setup-owned height components', () => {
    const block = { ...explicitStock('fixed-heights', 'Height Block'), fixtureOffset: 54 }
    const setupIntent = defaultHeightIntent()
    const inheritedHeights = heightParamsFromSetupIntent(setupIntent)
    const setupOwnedIntent = buildPlanarRoughSmartHeightIntent({
      setupId: 'height-setup',
      operationType: 'pocket_2d',
      safetyIntent: setupIntent,
      mode: 'stock_rough',
      stockId: block.id,
    })
    const setupOwned = {
      id: 'op-setup',
      name: 'Setup owned',
      type: 'pocket_2d',
      status: 'ready',
      heights: inheritedHeights,
      smartHeight: { kind: 'smart_v2', intent: setupOwnedIntent },
      toolpathMoves: [{ type: 'rapid', x: 1, y: 2, z: 3 }],
    } as unknown as Operation
    const override = {
      ...setupOwned,
      id: 'op-override',
      name: 'Override',
      heights: { ...inheritedHeights, clearanceHeight: 30 },
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...setupOwnedIntent,
          safety: {
            ...setupOwnedIntent.safety,
            clearance: {
              ...setupOwnedIntent.safety.clearance,
              owner: { kind: 'user_override' },
            },
          },
        },
      },
    } as Operation
    const setup = {
      ...setupForStock('height-setup', block.id, 54),
      defaultHeightIntent: setupIntent,
      operations: [setupOwned, override],
    }
    installProject([block], [{ stockId: block.id }], [])
    act(() => {
      useCamStore.setState((state) => ({
        project: { ...state.project, setups: [setup], activeSetupId: setup.id },
      }))
    })

    render(<SetupModal />)
    act(() => { useCamStore.getState().openEditSetup(setup.id) })
    const clearance = screen.getByLabelText('Setup default clearance height') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '20' } })
    fireEvent.blur(clearance)
    fireEvent.click(screen.getByRole('button', { name: /Save Setup/ }))

    const saved = useCamStore.getState().project.setups[0]
    expect(saved.defaultHeightIntent?.clearance.offset).toBe(20)
    expect(saved.operations[0].heights.clearanceHeight).toBe(25)
    expect(saved.operations[0].status).toBe('pending')
    expect(saved.operations[0].toolpathMoves).toBeUndefined()
    expect(saved.operations[1].heights.clearanceHeight).toBe(30)
    expect(saved.operations[1].smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        safety: {
          clearance: { owner: { kind: 'user_override' } },
          retract: { owner: { kind: 'setup', setupId: setup.id } },
          feed: { owner: { kind: 'setup', setupId: setup.id } },
        },
      },
    })
    expect(saved.operations[1].status).toBe('pending')
  })

  it('saving unrelated Setup edits leaves setup-owned operation output intact', () => {
    const block = { ...explicitStock('fixed-unchanged', 'Unchanged Block'), fixtureOffset: 54 }
    const setupOwned = {
      id: 'op-setup',
      name: 'Setup owned',
      type: 'pocket_2d',
      status: 'ready',
      heights: heightParamsFromSetupIntent(defaultHeightIntent()),
      toolpathMoves: [{ type: 'rapid', x: 1, y: 2, z: 3 }],
      computeTimeMs: 42,
    } as unknown as Operation
    const setup = {
      ...setupForStock('unchanged-setup', block.id, 54),
      defaultHeightIntent: defaultHeightIntent(),
      operations: [setupOwned],
    }
    installProject([block], [{ stockId: block.id }], [])
    act(() => {
      useCamStore.setState((state) => ({
        project: { ...state.project, setups: [setup], activeSetupId: setup.id },
      }))
    })

    render(<SetupModal />)
    act(() => { useCamStore.getState().openEditSetup(setup.id) })
    fireEvent.click(screen.getByRole('button', { name: /Save Setup/ }))

    const saved = useCamStore.getState().project.setups[0].operations[0]
    expect(saved.status).toBe('ready')
    expect(saved.computeTimeMs).toBe(42)
    expect(saved.toolpathMoves).toEqual([{ type: 'rapid', x: 1, y: 2, z: 3 }])
  })

  it('allows another setup on the same stock to share its work offset', () => {
    const block = { ...explicitStock('fixed-shared', 'Shared Block'), fixtureOffset: 56 }
    installProject([block], [{ stockId: block.id }], [])
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          setups: [setupForStock('existing', block.id, 56)],
        },
      }))
    })

    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    const offset = screen.getByTestId('stock-work-offset-select') as HTMLSelectElement
    const sharedOption = screen.getByRole('option', { name: 'G56' }) as HTMLOptionElement
    expect(offset.value).toBe('56')
    expect(sharedOption.disabled).toBe(false)
    expect(
      (screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement).disabled,
    ).toBe(false)

    act(() => { fireEvent.click(screen.getByRole('button', { name: /Create Setup/ })) })

    const state = useCamStore.getState()
    expect(state.project.setups).toHaveLength(2)
    expect(state.project.setups.map((setup) => setup.wcs.fixtureOffset)).toEqual([56, 56])
    expect(state.project.stocks?.[0].fixtureOffset).toBe(56)
  })

  it('NEW setup with a nest-bound sheet defaults the picker to that sheet', () => {
    // One geometry-bearing stock = the nest's bound sheet (no member geometry of
    // its own). Smart-pick must select it, NOT silently land on the auto stock.
    const sheet = explicitStock('sheet-1', 'Nest Sheet')
    const auto = derivedStock('stock-derived-migrated', 'Auto Stock 1')
    installProject(
      [auto, sheet],
      [],                              // no parts assigned to the auto stock
      [{ boundStockId: 'sheet-1' }],   // the nest binds the sheet
    )
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    expect(screen.getByText('New Setup')).not.toBeNull()
    // The stock <select> is pre-selected to the nest's bound sheet.
    const selects = Array.from(document.querySelectorAll('select.wcs-stock-select')) as HTMLSelectElement[]
    expect(selects[0]?.value).toBe('sheet-1')
    // Create is NOT blocked (an unambiguous single candidate).
    expect(screen.queryByTestId('setup-must-pick-stock')).toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })

  it('NEW setup with TWO geometry-bearing stocks forces a pick + disables Create', () => {
    // A nest sheet AND a separately-assigned member stock = ambiguous cut stock.
    const sheet = explicitStock('sheet-1', 'Nest Sheet')
    const block = explicitStock('fixed-2', 'Vise Block')
    installProject(
      [sheet, block],
      [{ stockId: 'fixed-2' }],        // a real part assigned to the block
      [{ boundStockId: 'sheet-1' }],   // a nest binds the sheet
    )
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    expect(screen.getByText('New Setup')).not.toBeNull()
    // The "All stocks (combined bounds)" choice is GONE — a corner origin must
    // bind a specific stock. The picker shows only real stocks + a disabled
    // "-- Select a stock --" placeholder.
    expect(screen.queryByRole('option', { name: /All stocks/ })).toBeNull()
    // The placeholder carries `hidden` (so it can't be re-picked), which makes
    // it inaccessible to role queries — assert via the DOM instead.
    const opts = Array.from(document.querySelectorAll('select.wcs-stock-select option')) as HTMLOptionElement[]
    expect(opts.some((o) => /Select a stock/.test(o.textContent ?? ''))).toBe(true)
    // Nothing pre-selected: the stock <select> sits on the empty placeholder row.
    const selects = Array.from(document.querySelectorAll('select.wcs-stock-select')) as HTMLSelectElement[]
    expect(selects[0]?.value).toBe('')
    // The force-choice message renders.
    expect(screen.getByTestId('setup-must-pick-stock')).not.toBeNull()
    // Create Setup is disabled until a choice is made.
    const createBtn = screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement
    expect(createBtn.disabled).toBe(true)

    // Picking a stock clears the gate and enables Create.
    act(() => { fireEvent.change(selects[0], { target: { value: 'sheet-1' } }) })
    expect(screen.queryByTestId('setup-must-pick-stock')).toBeNull()
    expect((screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement).disabled).toBe(false)

    act(() => { useCamStore.getState().closeModal() })
  })

  it('EDIT of a legacy unbound corner setup forces a pick + disables Save', () => {
    // A legacy "All stocks" / unbound corner setup: corner WCS with NO stockId.
    // Under the new always-bind-a-stock rule, opening it must restore the
    // placeholder (nothing selected) and block Save until a stock is bound.
    const block = explicitStock('fixed-3', 'Vise Block')
    const legacySetup = {
      id: 'setup-legacy',
      name: 'Legacy Setup',
      wcs: {
        id: 'wcs-legacy',
        label: 'G54',
        fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        zAxis: { x: 0, y: 0, z: 1 },
        // Corner-bound but NO stockId (the legacy "All stocks" state).
        cornerRow: 2, cornerCol: 0, cornerFace: 'top' as const,
      },
      stock: { type: 'rectangular' as const, offsetX: 0, offsetY: 0, offsetZTop: 5, offsetZBottom: 0, material: 'wood' },
      operations: [],
      notes: '',
    }
    act(() => {
      useCamStore.setState((s) => ({
        activeModal: null,
        editingSetupId: null,
        project: {
          ...s.project,
          stocks: [block],
          setups: [legacySetup] as unknown as typeof s.project.setups,
          geometry: [] as unknown as typeof s.project.geometry,
          nests: [] as unknown as typeof s.project.nests,
        },
      }))
    })
    render(<SetupModal />)
    act(() => { useCamStore.getState().openEditSetup('setup-legacy') })

    expect(screen.getByText('Edit Setup')).not.toBeNull()
    // Placeholder shown, nothing bound.
    const selects = Array.from(document.querySelectorAll('select.wcs-stock-select')) as HTMLSelectElement[]
    expect(selects[0]?.value).toBe('')
    // Force-choice gate active; Save disabled.
    expect(screen.getByTestId('setup-must-pick-stock')).not.toBeNull()
    expect((screen.getByRole('button', { name: /Save Setup/ }) as HTMLButtonElement).disabled).toBe(true)

    act(() => { useCamStore.getState().closeModal() })
  })

  it('saves exactly once when Enter comes from an ordinary enabled field', async () => {
    installStocks([derivedStock('stock-derived-migrated', 'Keyboard Stock')])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    const name = screen.getByPlaceholderText('Setup 1') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Keyboard setup' } })
    fireEvent.keyDown(name, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(useCamStore.getState().project.setups).toHaveLength(1))
    expect(useCamStore.getState().project.setups[0].name).toBe('Keyboard setup')
    expect(screen.queryByTestId('setup-modal-panel')).toBeNull()
  })

  it('commits a real numeric draft into the saved payload on the same Enter', async () => {
    installStocks([derivedStock('stock-derived-migrated', 'Keyboard Stock')])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    const clearance = screen.getByLabelText('Setup default clearance height') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '17.5' } })
    fireEvent.keyDown(clearance, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(useCamStore.getState().project.setups).toHaveLength(1))
    expect(useCamStore.getState().project.setups[0].defaultHeightIntent?.clearance.offset)
      .toBe(17.5)
  })

  it('cancels a pending Enter save on Escape', async () => {
    installStocks([derivedStock('stock-derived-migrated', 'Keyboard Stock')])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    const name = screen.getByPlaceholderText('Setup 1')
    fireEvent.keyDown(name, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(useCamStore.getState().project.setups).toHaveLength(0)
    expect(useCamStore.getState().activeModal).toBeNull()
  })

  it('cancels a pending Enter save when the modal unmounts', async () => {
    installStocks([derivedStock('stock-derived-migrated', 'Keyboard Stock')])
    const mounted = render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    fireEvent.keyDown(screen.getByPlaceholderText('Setup 1'), { key: 'Enter', code: 'Enter' })
    mounted.unmount()

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(useCamStore.getState().project.setups).toHaveLength(0)
  })

  it('uses the first Escape to leave stock-corner pick mode and the second to close', () => {
    const exitStockCornerPickMode = vi.fn()
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 5 } }),
      enterStockCornerPickMode: vi.fn(),
      exitStockCornerPickMode,
    }
    installStocks([derivedStock('stock-derived-migrated', 'Keyboard Stock')])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    fireEvent.click(screen.getByTestId('setup-pick-stock-corner'))
    expect(screen.getByTestId('setup-stock-corner-pick-banner')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByTestId('setup-stock-corner-pick-banner')).toBeNull()
    expect(screen.getByTestId('setup-modal-panel')).not.toBeNull()
    expect(useCamStore.getState().activeModal).toBe('new-setup')

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(useCamStore.getState().activeModal).toBeNull()
    expect(exitStockCornerPickMode).toHaveBeenCalled()
  })

  it('leaves Enter inert while Save is disabled', () => {
    installProject(
      [derivedStock('keyboard-a', 'Keyboard A'), explicitStock('keyboard-b', 'Keyboard B')],
      [{ stockId: 'keyboard-a' }, { stockId: 'keyboard-b' }],
      [],
    )
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    const save = screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.keyDown(screen.getByPlaceholderText('Setup 1'), { key: 'Enter', code: 'Enter' })

    expect(useCamStore.getState().project.setups).toHaveLength(0)
    expect(screen.getByTestId('setup-modal-panel')).not.toBeNull()
  })

  it('does not hijack excluded Enter, composing, prevented, or consumed keys', () => {
    installStocks([derivedStock('stock-derived-migrated', 'Keyboard Stock')])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    const panel = screen.getByTestId('setup-modal-panel')
    const name = screen.getByPlaceholderText('Setup 1') as HTMLInputElement
    const textarea = document.createElement('textarea')
    const multiline = document.createElement('div')
    multiline.setAttribute('aria-multiline', 'true')
    const contenteditable = document.createElement('div')
    contenteditable.setAttribute('contenteditable', 'true')
    const roleLink = document.createElement('div')
    roleLink.setAttribute('role', 'link')
    const select = document.createElement('select')
    const option = document.createElement('option')
    select.append(option)
    const listbox = document.createElement('div')
    listbox.setAttribute('role', 'listbox')
    const roleOption = document.createElement('div')
    roleOption.setAttribute('role', 'option')
    const button = document.createElement('button')
    const disabledInput = document.createElement('input')
    disabledInput.type = 'text'
    disabledInput.disabled = true
    panel.append(
      textarea,
      multiline,
      contenteditable,
      roleLink,
      select,
      listbox,
      roleOption,
      button,
      disabledInput,
    )

    const expectStillOpen = () => {
      expect(useCamStore.getState().activeModal).toBe('new-setup')
      expect(useCamStore.getState().project.setups).toHaveLength(0)
    }
    for (const target of [
      textarea,
      multiline,
      contenteditable,
      roleLink,
      select,
      option,
      listbox,
      roleOption,
      button,
      disabledInput,
    ]) {
      fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' })
      expectStillOpen()
    }

    for (const key of ['Enter', 'Escape']) {
      fireEvent.keyDown(name, { key, code: key, isComposing: true })
      expectStillOpen()

      fireEvent.keyDown(name, { key, code: key, keyCode: 229 })
      expectStillOpen()

      name.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
      fireEvent.keyDown(name, { key, code: key })
      expectStillOpen()

      name.addEventListener('keydown', (event) => event.stopPropagation(), { once: true })
      fireEvent.keyDown(name, { key, code: key })
      expectStillOpen()
    }

    fireEvent.keyDown(name, { key: 'Process', code: 'Process' })
    expectStillOpen()

    // The native button keeps its single native activation path.
    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))
    expect(useCamStore.getState().project.setups).toHaveLength(1)
  })

  it('routes unconsumed Escape from a multiline child through the modal Cancel action', () => {
    installStocks([derivedStock('stock-derived-migrated', 'Keyboard Stock')])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    const textarea = document.createElement('textarea')
    screen.getByTestId('setup-modal-panel').append(textarea)
    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' })

    expect(useCamStore.getState().activeModal).toBeNull()
    expect(useCamStore.getState().project.setups).toHaveLength(0)
  })
})
