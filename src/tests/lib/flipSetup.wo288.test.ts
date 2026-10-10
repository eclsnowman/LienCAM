// @vitest-environment jsdom
//
// WO-288: a setup can be the second side of another - the same block of
// material, turned over, machined again.
//
// The file carries all four proofs the work order asks for:
//   1. the arithmetic, pure (incl. the sign trap: a plausible wrong answer
//      asserted against the right one),
//   2. the two refusals - a flip across different stock, and a work offset
//      another owner already holds,
//   3. a MOUNTED proof that the setup dialog offers "second side of <setup>"
//      and that the created setup holds the relationship,
//   4. a reload proof through the REAL saveProjectToFile/loadProjectFromFile.
//
// jsdom is needed for (3): the repo's vitest env is 'node' (vite.config.mts), so
// the directive above flips this file, exactly as SetupModal.smoke.test.tsx and
// probeRoutines.wo261.test.ts do. React is mounted through createElement
// because this is a .ts file (the work order's declared slice).

import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PhysicalStock, Project, Setup, Vec3 } from '../../types'
import {
  farCornerInSetupCoords,
  flipPointToSecondSide,
  planSecondSideSetup,
} from '../../lib/cam/flipSetup'
import { typedMock } from '../support/typedMock'

// No real IndexedDB here; collectProjectBinaries reads through these on save.
// Every project below is geometry-free, so nothing is ever fetched.
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). Same in-memory shim the sibling component
// tests install, BEFORE the store is imported.
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
})

const { SetupModal } = await import('../../components/modals/SetupModal')
const { useCamStore } = await import('../../store')

// -- fixtures -----------------------------------------------------------------

/** 100 x 50 x 20 mm block sitting at the world origin. */
function block(id = 'block', name = 'Vise Block', fixtureOffset?: number): PhysicalStock {
  return {
    id,
    name,
    mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 100, y: 50, z: 20 },
      size: { x: 100, y: 50, z: 20 },
      center: { x: 50, y: 25, z: 10 },
    },
    position: { x: 0, y: 0, z: 0 },
    ...(fixtureOffset === undefined ? {} : { fixtureOffset }),
  }
}

/** First side: zero on the FRONT LEFT TOP corner of the block (row 2, col 0). */
function firstSide(
  id = 'side-1',
  stockId = 'block',
  fixtureOffset = 56,
  origin: Vec3 = { x: 0, y: 0, z: 20 },
): Setup {
  return {
    id,
    name: 'Top side',
    wcs: {
      id: `wcs-${id}`,
      label: `G${fixtureOffset}`,
      fixtureOffset,
      origin,
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
      offsetX: 0, offsetY: 0, offsetZTop: 5, offsetZBottom: 0,
      material: 'aluminium',
    },
    operations: [],
    notes: '',
  }
}

/** A setup whose origin was typed in by hand: bound to no stock at all. */
function unboundSetup(id = 'side-loose'): Setup {
  const setup = firstSide(id)
  return {
    ...setup,
    name: 'Hand-typed origin',
    wcs: {
      ...setup.wcs,
      stockId: undefined,
      cornerRow: undefined,
      cornerCol: undefined,
      cornerFace: undefined,
      originBinding: { kind: 'manual' },
    },
  }
}

function projectWith(
  stocks: PhysicalStock[],
  setups: Setup[],
): Pick<Project, 'setups' | 'stocks'> {
  return { stocks, setups }
}

/** Frame of the fixtures above: 100 x 50 x 20 block, zero on its front-left TOP
 *  corner (so the zero sits at z = 20 measured from the block's minimum). */
const TOP_FRONT_LEFT = {
  stockSize: { x: 100, y: 50, z: 20 },
  originInStock: { x: 0, y: 0, z: 20 },
}

// -- 1. the arithmetic ---------------------------------------------------------

describe('WO-288 flip arithmetic', () => {
  it('turns a point about X: it measures from the opposite face, not negated', () => {
    // 10 right, 5 back from the front face, 3 mm below the top.
    const onSideOne: Vec3 = { x: 10, y: 5, z: -3 }
    const onSideTwo = flipPointToSecondSide(onSideOne, 'x', TOP_FRONT_LEFT)

    // X carries over. The point is still 5 mm from the face it was 5 mm from,
    // but that face is now the BACK: 50 - 5 = 45. It sat 3 mm below the old
    // top, so it is 3 mm above the new bottom: 20 - 3 = 17 below the new top.
    expect(onSideTwo).toEqual({ x: 10, y: 45, z: -17 })
    // THE SIGN TRAP: negating instead of measuring from the opposite face gives
    // (-5, 3) - a perfectly plausible pair of numbers, and wrong. It would put
    // the feature 5 mm OFF the block and 3 mm ABOVE the material.
    expect(onSideTwo).not.toEqual({ x: 10, y: -5, z: 3 })
  })

  it('turns a point about Y: X swings, Y is the one that carries over', () => {
    expect(flipPointToSecondSide({ x: 10, y: 5, z: -3 }, 'y', TOP_FRONT_LEFT))
      .toEqual({ x: 90, y: 5, z: -17 })
  })

  it('answers differently for X and Y, so the axis can never be guessed', () => {
    const point: Vec3 = { x: 10, y: 5, z: -3 }
    expect(flipPointToSecondSide(point, 'x', TOP_FRONT_LEFT))
      .not.toEqual(flipPointToSecondSide(point, 'y', TOP_FRONT_LEFT))
  })

  it('answers from where the zero sits in the block, not from its size alone', () => {
    // Same block, same point, same axis - zero at the CENTRE of the block. Now
    // the negated answer above is the RIGHT one, which is exactly why the
    // origin is part of the frame and not an afterthought.
    const centred = {
      stockSize: { x: 100, y: 50, z: 20 },
      originInStock: { x: 50, y: 25, z: 10 },
    }
    expect(flipPointToSecondSide({ x: 10, y: 5, z: -3 }, 'x', centred))
      .toEqual({ x: 10, y: -5, z: 3 })
  })

  it('handles a zero on the BOTTOM face', () => {
    const bottom = {
      stockSize: { x: 100, y: 50, z: 20 },
      originInStock: { x: 0, y: 0, z: 0 },
    }
    // 3 mm above the bottom becomes 3 mm below the new top of a 20 mm block.
    expect(flipPointToSecondSide({ x: 10, y: 5, z: 3 }, 'x', bottom))
      .toEqual({ x: 10, y: 45, z: 17 })
  })

  it('turning the block back over returns the point it started at', () => {
    const point: Vec3 = { x: 12.5, y: 7.25, z: -4.5 }
    for (const axis of ['x', 'y'] as const) {
      const there = flipPointToSecondSide(point, axis, TOP_FRONT_LEFT)
      expect(flipPointToSecondSide(there, axis, TOP_FRONT_LEFT)).toEqual(point)
    }
  })

  it('reads the far corner of the block on both sides', () => {
    const plan = planSecondSideSetup(
      projectWith([block('block', 'Vise Block', 56)], [firstSide()]),
      { parentSetupId: 'side-1', axis: 'x' },
    )
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.code}`)
    const far = farCornerInSetupCoords(plan)
    // Back right, top of the block as the first side sees it...
    expect(far).toEqual({ x: 100, y: 50, z: 0 })
    // ...is front right, bottom once the block is turned about X.
    expect(flipPointToSecondSide(far, 'x', plan)).toEqual({ x: 100, y: 0, z: -20 })
  })
})

// -- 2. the plan and its refusals ----------------------------------------------

describe('WO-288 second-side plan', () => {
  it('takes the stock, corner, origin and work offset from the first side', () => {
    const plan = planSecondSideSetup(
      projectWith([block('block', 'Vise Block', 56)], [firstSide()]),
      { parentSetupId: 'side-1', axis: 'x' },
    )
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.code}`)
    expect(plan.stockId).toBe('block')
    expect(plan.stockName).toBe('Vise Block')
    expect(plan.axis).toBe('x')
    expect(plan.parentSetupName).toBe('Top side')
    // The block did not move, and the zero stays on its corner.
    expect(plan.origin).toEqual({ x: 0, y: 0, z: 20 })
    expect(plan.cornerRow).toBe(2)
    expect(plan.cornerCol).toBe(0)
    expect(plan.cornerFace).toBe('top')
    expect(plan.stockSize).toEqual({ x: 100, y: 50, z: 20 })
    expect(plan.originInStock).toEqual({ x: 0, y: 0, z: 20 })
    // The stock owns the offset; both sides run on it.
    expect(plan.fixtureOffset).toBe(56)
  })

  // WO-1291: a setup owns its own controller frame. The flip plan must resolve
  // the parent the same way the post does, or the dialog quotes one G-code and
  // the program emits another. Legacy stock value (G54) deliberately DISAGREES
  // with the parent's owned offset (G57) so a stock-first reader fails here.
  it("follows the first side OWN offset, not the stock legacy value", () => {
    const parent = firstSide('side-1', 'block', 57)
    ;(parent.wcs as typeof parent.wcs & { fixtureOffsetOwner: 'setup' }).fixtureOffsetOwner = 'setup'
    const plan = planSecondSideSetup(
      projectWith([block('block', 'Vise Block', 54)], [parent]),
      { parentSetupId: 'side-1', axis: 'y' },
    )
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.code}`)
    expect(plan.fixtureOffset).toBe(57)
  })
  it('inherits the SETUP offset when the stock predates per-stock offsets', () => {
    const plan = planSecondSideSetup(
      projectWith([block()], [firstSide('side-1', 'block', 55)]),
      { parentSetupId: 'side-1', axis: 'y' },
    )
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.code}`)
    expect(plan.fixtureOffset).toBe(55)
  })

  // REFUSAL 1: different stock.
  it('refuses a second side on a different block of material', () => {
    const project = projectWith(
      [block('block', 'Vise Block', 56), block('other', 'Second Block', 57)],
      [firstSide()],
    )
    const refusal = planSecondSideSetup(project, {
      parentSetupId: 'side-1',
      axis: 'x',
      stockId: 'other',
    })
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('FLIP_STOCK_MISMATCH')
    expect(refusal.message).toContain('SAME block of material')
    expect(refusal.message).toContain('Second Block')
  })

  it('refuses when the first side is not on a stock corner at all', () => {
    const refusal = planSecondSideSetup(
      projectWith([block('block', 'Vise Block', 56)], [unboundSetup()]),
      { parentSetupId: 'side-loose', axis: 'x' },
    )
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('FLIP_PARENT_NOT_STOCK_BOUND')
    expect(refusal.message).toContain('Hand-typed origin')
  })

  it('refuses when the first side names a stock this project no longer has', () => {
    const refusal = planSecondSideSetup(
      projectWith([block('block', 'Vise Block', 56)], [firstSide('side-1', 'deleted-stock')]),
      { parentSetupId: 'side-1', axis: 'x' },
    )
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('FLIP_STOCK_MISSING')
  })

  // REFUSAL 2: the work offset both sides would run on is someone else's.
  it('refuses when another owner already holds that work offset', () => {
    const project = projectWith(
      [block('block', 'Vise Block', 56), block('other', 'Fixture Plate', 56)],
      [firstSide()],
    )
    const refusal = planSecondSideSetup(project, { parentSetupId: 'side-1', axis: 'x' })
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('FLIP_WORK_OFFSET_CLAIMED')
    expect(refusal.message).toContain('G56')
    expect(refusal.message).toContain('Fixture Plate')
  })

  it('refuses a first side whose offset is not a real G54-G59 slot', () => {
    const refusal = planSecondSideSetup(
      projectWith([block()], [firstSide('side-1', 'block', 12)]),
      { parentSetupId: 'side-1', axis: 'x' },
    )
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('FLIP_WORK_OFFSET_INVALID')
  })

  it('refuses when the first side has been deleted', () => {
    const refusal = planSecondSideSetup(projectWith([block()], []), {
      parentSetupId: 'gone',
      axis: 'x',
    })
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('FLIP_PARENT_MISSING')
  })
})

// -- 3. the dialog -------------------------------------------------------------

/** Install a project and force the setup modal closed.
 *
 *  `withGeometry` seeds ONE id-bearing stand-in part so the dialog's smart-pick
 *  has an unambiguous cut stock (the same stand-in SetupModal.smoke.test.tsx
 *  uses). It carries no bounding box, so the save/reload test below installs
 *  without it - the real load path measures every part. */
function installProject(
  stocks: PhysicalStock[],
  setups: Setup[],
  withGeometry = true,
): void {
  act(() => {
    useCamStore.setState((s) => ({
      activeModal: null,
      editingSetupId: null,
      project: {
        ...s.project,
        stocks,
        setups,
        geometry: (withGeometry && stocks[0]
          ? [{ stockId: stocks[0].id }]
          : []) as unknown as typeof s.project.geometry,
        nests: [] as unknown as typeof s.project.nests,
      },
    }))
  })
}

/** The dialog reads stock bounds from the rendered viewport. */
function installViewport(stocks: PhysicalStock[]): void {
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: (stockId?: string) => {
      const stock = stocks.find((candidate) => candidate.id === stockId) ?? stocks[0]
      return stock ? { min: { ...stock.bounds.min }, max: { ...stock.bounds.max } } : null
    },
  }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
  vi.restoreAllMocks()
})

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-288 setup dialog', () => {
  it('offers the second side and creates a setup that holds the relationship', () => {
    const stock = block('block', 'Vise Block', 56)
    installProject([stock], [firstSide()])
    installViewport([stock])
    render(React.createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    // The dialog offers it, by name, and defaults to "not a second side".
    const parentSelect = screen.getByTestId('setup-second-side-of') as HTMLSelectElement
    expect(parentSelect.value).toBe('')
    expect(screen.getByRole('option', { name: 'Top side' })).not.toBeNull()
    expect(screen.queryByTestId('setup-second-side-axis')).toBeNull()

    act(() => { fireEvent.change(parentSelect, { target: { value: 'side-1' } }) })

    // Naming the first side reveals the axis choice - the app never guesses it.
    const axisSelect = screen.getByTestId('setup-second-side-axis') as HTMLSelectElement
    expect(axisSelect.value).toBe('x')
    act(() => { fireEvent.change(axisSelect, { target: { value: 'y' } }) })

    // The stock, corner and offset are now the first side's and are held.
    // WO-1182 stripped the summary and lock READOUTS from every dialog on
    // Operator's order, so what is asserted here is the holding itself - the
    // controls that must not be editable - not the sentence that described it.
    expect(screen.queryByTestId('setup-second-side-summary')).toBeNull()
    expect((screen.getByTestId('stock-work-offset-select') as HTMLSelectElement).disabled).toBe(true)
    expect((document.querySelector('select.wcs-stock-select') as HTMLSelectElement).disabled).toBe(true)

    act(() => { fireEvent.click(screen.getByRole('button', { name: /Create Setup/ })) })

    const setups = useCamStore.getState().project.setups
    expect(setups).toHaveLength(2)
    const secondSide = setups[1]
    expect(secondSide.flipOf).toEqual({ setupId: 'side-1', axis: 'y' })
    // One block: same stock, same corner, same zero, same work offset.
    expect(secondSide.wcs.originBinding).toEqual({
      kind: 'stock_corner',
      stockId: 'block',
      cornerRow: 2,
      cornerCol: 0,
      cornerFace: 'top',
    })
    expect(secondSide.wcs.origin).toEqual(setups[0].wcs.origin)
    expect(secondSide.wcs.fixtureOffset).toBe(56)
    expect(useCamStore.getState().project.stocks?.[0].fixtureOffset).toBe(56)
  })

  it('an ordinary setup created alongside is NOT marked as a second side', () => {
    const stock = block('block', 'Vise Block', 56)
    installProject([stock], [firstSide()])
    installViewport([stock])
    render(React.createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Create Setup/ })) })

    expect(useCamStore.getState().project.setups[1].flipOf).toBeUndefined()
  })

  it('shows the refusal and blocks Create when the two cannot be one block', () => {
    const stock = block('block', 'Vise Block', 56)
    installProject([stock], [unboundSetup()])
    installViewport([stock])
    render(React.createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    act(() => {
      fireEvent.change(screen.getByTestId('setup-second-side-of'), {
        target: { value: 'side-loose' },
      })
    })

    expect(screen.getByTestId('setup-second-side-refusal').textContent)
      .toContain('does not zero on a stock corner')
    expect((screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement).disabled)
      .toBe(true)
    // Nothing was written on the way past the refusal.
    expect(useCamStore.getState().project.setups).toHaveLength(1)
  })

  // The hold has to cover the ORIGIN MODE, not just the stock and the corner.
  // Leaving Snap / Manual / Gizmo live let a committed flip be typed off its
  // block: the created setup carried flipOf while binding no stock at all, so
  // the "same block of material" the order demands could not be shown - and the
  // refusal never fired because the plan never sees the origin mode.
  it('holds the origin-mode tabs too: a committed flip cannot be typed off its block', () => {
    const stock = block('block', 'Vise Block', 56)
    installProject([stock], [firstSide()])
    installViewport([stock])
    render(React.createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    const tab = (mode: 'corner' | 'snap' | 'manual' | 'gizmo') =>
      screen.getByTestId(`setup-origin-mode-${mode}`) as HTMLButtonElement
    // On an ordinary new setup they are all ordinary choices.
    expect(tab('manual').disabled).toBe(false)
    expect(tab('gizmo').disabled).toBe(false)

    act(() => {
      fireEvent.change(screen.getByTestId('setup-second-side-of'), { target: { value: 'side-1' } })
    })

    // Committed: every way out of stock-corner mode is held with the stock,
    // the corner and the offset, and the dialog says so.
    for (const mode of ['corner', 'snap', 'manual', 'gizmo'] as const) {
      expect(tab(mode).disabled).toBe(true)
    }
    // Click Manual anyway - the exact path that produced the unbound flip.
    act(() => { fireEvent.click(tab('manual')) })

    // The mode did not move: no hand-typed origin inputs, and the corner
    // picker is still there. (The summary readout it used to assert was
    // stripped dialog-wide by WO-1182.)
    expect(document.querySelector('.wcs-manual')).toBeNull()
    expect(document.querySelector('.wcs-corner-picker')).not.toBeNull()

    const createButton = screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement
    expect(createButton.disabled).toBe(false)
    act(() => { fireEvent.click(createButton) })

    // What the defect produced was flipOf + originBinding {kind:'manual'} +
    // stockId undefined. The created setup is bound to the block instead.
    const created = useCamStore.getState().project.setups[1]
    expect(created.flipOf).toEqual({ setupId: 'side-1', axis: 'x' })
    expect(created.wcs.originBinding).toEqual({
      kind: 'stock_corner',
      stockId: 'block',
      cornerRow: 2,
      cornerCol: 0,
      cornerFace: 'top',
    })
    expect(created.wcs.stockId).toBe('block')
  })

  it('pulls a hand-typed origin back onto the block when a first side is named', () => {
    const stock = block('block', 'Vise Block', 56)
    installProject([stock], [firstSide()])
    installViewport([stock])
    render(React.createElement(SetupModal))
    act(() => { useCamStore.getState().openModal('new-setup') })

    // The other way in: type an origin FIRST, then declare the second side.
    act(() => { fireEvent.click(screen.getByTestId('setup-origin-mode-manual')) })
    expect(document.querySelector('.wcs-manual')).not.toBeNull()

    act(() => {
      fireEvent.change(screen.getByTestId('setup-second-side-of'), { target: { value: 'side-1' } })
    })

    // Naming it moves the form back onto the block rather than leaving a typed
    // origin under a recorded relationship.
    expect(document.querySelector('.wcs-manual')).toBeNull()
    expect(screen.getByTestId('setup-origin-mode-manual').getAttribute('disabled')).not.toBeNull()

    act(() => { fireEvent.click(screen.getByRole('button', { name: /Create Setup/ })) })

    const created = useCamStore.getState().project.setups[1]
    expect(created.flipOf).toEqual({ setupId: 'side-1', axis: 'x' })
    expect(created.wcs.stockId).toBe('block')
    expect(created.wcs.origin).toEqual({ x: 0, y: 0, z: 20 })
  })

  it('never offers a second side while EDITING a setup (creation only)', () => {
    const stock = block('block', 'Vise Block', 56)
    installProject([stock], [firstSide()])
    installViewport([stock])
    render(React.createElement(SetupModal))
    act(() => { useCamStore.getState().openEditSetup('side-1') })

    expect(screen.getByText('Edit Setup')).not.toBeNull()
    expect(screen.queryByTestId('setup-second-side-of')).toBeNull()
  })
})

// -- 4. the relationship survives a save and a reload --------------------------

describe('WO-288 persistence', () => {
  it('keeps the relationship through saveProjectToFile -> loadProjectFromFile', async () => {
    const stock = block('block', 'Vise Block', 56)
    const secondSide: Setup = {
      ...firstSide('side-2'),
      name: 'Second side',
      flipOf: { setupId: 'side-1', axis: 'x' },
    }
    installProject([stock], [firstSide(), secondSide], false)

    const blobs: Blob[] = []
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:wo288' },
      revokeObjectURL: () => {},
    })
    // jsdom would try to NAVIGATE to the download anchor; the captured Blob is
    // the artifact, so the click itself is neutralised.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await act(async () => { await useCamStore.getState().saveProjectToFile() })
    expect(blobs).toHaveLength(1)
    const saved = await blobs[0].text()
    // The relationship is IN the file, not only in memory.
    expect(JSON.parse(saved).setups[1].flipOf).toEqual({ setupId: 'side-1', axis: 'x' })

    // Wipe the live project, then open the saved file for real.
    installProject([], [], false)
    expect(useCamStore.getState().project.setups).toHaveLength(0)
    await act(async () => { await useCamStore.getState().loadProjectFromFile(saved) })

    const reloaded = useCamStore.getState().project.setups
    expect(reloaded).toHaveLength(2)
    expect(reloaded[1].flipOf).toEqual({ setupId: 'side-1', axis: 'x' })
    expect(reloaded[1].wcs.origin).toEqual(reloaded[0].wcs.origin)
    vi.unstubAllGlobals()
  })

  it('drops the relationship rather than let it name a deleted first side', () => {
    const stock = block('block', 'Vise Block', 56)
    const secondSide: Setup = {
      ...firstSide('side-2'),
      name: 'Second side',
      flipOf: { setupId: 'side-1', axis: 'x' },
    }
    installProject([stock], [firstSide(), secondSide])

    act(() => { useCamStore.getState().removeSetup('side-1') })

    const survivors = useCamStore.getState().project.setups
    expect(survivors).toHaveLength(1)
    expect(survivors[0].id).toBe('side-2')
    expect(survivors[0].flipOf).toBeUndefined()
    // The survivor keeps its own zero; only the claim is dropped.
    expect(survivors[0].wcs.origin).toEqual({ x: 0, y: 0, z: 20 })
  })
})
