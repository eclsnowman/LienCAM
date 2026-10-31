// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PhysicalStock, Setup, Vec3 } from '../../types'
import {
  planSecondSideSetup,
  flipPointToSecondSide,
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
const { ConfirmModal } = await import('../../components/modals/ConfirmModal')
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


describe('WO-3108 production second-side creation', () => {
  it.each(['x', 'y'] as const)('creates and reloads the %s flipped frame on translated stock without moving the parent', async axis => {
    const stock = block('block', 'Translated block', 54)
    stock.position = { x: 30, y: -40, z: 12 }
    const parent = firstSide('side-1', 'block', 54, { x: 30, y: -40, z: 32 })
    installProject([stock], [parent], false)
    installViewport([stock])
    const before = JSON.parse(JSON.stringify(useCamStore.getState().project))
    render(React.createElement(SetupModal))
    act(() => useCamStore.getState().openModal('new-setup'))
    fireEvent.change(screen.getByTestId('setup-second-side-of'), { target: { value: parent.id } })
    fireEvent.change(screen.getByTestId('setup-second-side-axis'), { target: { value: axis } })
    expect((screen.getByTestId('stock-work-offset-select') as HTMLSelectElement).value).toBe('55')
    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))
    const created = useCamStore.getState().project.setups[1]
    const expected = axis === 'x' ? { x: 30, y: 10, z: 32 } : { x: 130, y: -40, z: 32 }
    expect(created.wcs.origin).toEqual(expected)
    expect(created.wcs.fixtureOffset).toBe(55)
    expect(created.wcs).toMatchObject({ fixtureOffsetOwner: 'setup' })
    expect(created.wcs.originBinding).toMatchObject({ stockId: 'block', cornerFace: 'top',
      cornerRow: axis === 'x' ? 0 : 2, cornerCol: axis === 'y' ? 2 : 0 })
    expect(useCamStore.getState().project.setups[0]).toEqual(before.setups[0])
    expect(useCamStore.getState().project.stocks).toEqual(before.stocks)
    expect(useCamStore.getState().project.geometry).toEqual(before.geometry)

    // Real file persistence, then real edit/save: neither may reallocate the child.
    const blobs: Blob[] = []
    vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:wo3108' }, revokeObjectURL: () => {} })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await act(async () => useCamStore.getState().saveProjectToFile())
    const saved = await blobs[0].text()
    delete (window as unknown as Record<string, unknown>).__cncViewport
    await act(async () => useCamStore.getState().loadProjectFromFile(saved))
    installViewport([stock])
    expect(useCamStore.getState().project.setups[1].wcs).toEqual(created.wcs)
    act(() => useCamStore.getState().openEditSetup(created.id))
    fireEvent.change(screen.getByTestId('stock-work-offset-select'), { target: { value: '58' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Setup/ }))
    const edited = useCamStore.getState().project.setups[1]
    expect(edited.wcs.fixtureOffset).toBe(58)
    expect(edited.wcs.origin).toEqual(expected)
    expect(edited.flipOf).toEqual(created.flipOf)
    vi.unstubAllGlobals()
  })


  it.each(['x', 'y'] as const)('zeros the %s flip on a rotated derived stock envelope, independent of parent Z', axis => {
    // PhysicalStock is an axis-aligned world envelope, not a rotatable pose.
    // Independently rotate eight cuboid vertices 90 degrees about X, then
    // translate (30,-40,12). Its envelope is (30,-60,12)..(130,-40,62).
    const vertices = [0, 100].flatMap(x => [0, 50].flatMap(y => [0, 20].map(z =>
      ({ x: 30 + x, y: -40 - z, z: 12 + y }))))
    const stock = block('block', 'Rotated derived envelope', 54)
    stock.mode = 'derived'
    stock.position = { x: 30, y: -60, z: 12 } // must NOT be added twice
    const min = { x: 30, y: -60, z: 12 }, max = { x: 130, y: -40, z: 62 }
    stock.bounds = { min, max, size: { x: 100, y: 20, z: 50 }, center: { x: 80, y: -50, z: 37 } }
    const parent = firstSide('side-1', 'block', 54, { x: 30, y: -60, z: 37 })
    installProject([stock], [parent], false)
    installViewport([stock])
    const before = structuredClone(useCamStore.getState().project)
    render(React.createElement(SetupModal))
    act(() => useCamStore.getState().openModal('new-setup'))
    fireEvent.change(screen.getByTestId('setup-second-side-of'), { target: { value: parent.id } })
    fireEvent.change(screen.getByTestId('setup-second-side-axis'), { target: { value: axis } })
    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))
    const child = useCamStore.getState().project.setups[1]
    const top = Math.max(...vertices.map(v => v.z))
    expect(child.wcs.origin).toEqual({ x: axis === 'y' ? 130 : 30, y: axis === 'x' ? -40 : -60, z: top })
    expect(top - child.wcs.origin.z).toBe(0)
    expect(child.wcs.originBinding).toMatchObject({ cornerFace: 'top' })
    expect(child.wcs.fixtureOffset).toBe(55)
    expect(useCamStore.getState().project.setups[0]).toEqual(before.setups[0])
    expect(useCamStore.getState().project.stocks).toEqual(before.stocks)
    const plan = planSecondSideSetup(before, { parentSetupId: parent.id, axis })
    if (!plan.ok) throw new Error(plan.code)
    // A world point (40,-55,20) turns to Z54, 8 mm below the new top.
    expect(flipPointToSecondSide({ x: 10, y: 5, z: -17 }, axis, plan).z).toBe(-8)
  })

  it.each(['x', 'y'] as const)('preserves explicit bottom and manual saved datums on the %s route', axis => {
    const stock = block('block', 'Translated block', 54)
    stock.position = { x: 30, y: -40, z: 12 }
    const parent = firstSide('parent', 'block', 54, { x: 30, y: -40, z: 32 })
    for (const manual of [false, true]) {
      const child = firstSide('child', 'block', 58, { x: 80, y: -15, z: manual ? 23 : 12 })
      Object.assign(child.wcs, { fixtureOffsetOwner: 'setup' })
      child.wcs.cornerFace = 'bottom'
      child.wcs.originBinding = manual ? { kind: 'manual' } : {
        kind: 'stock_corner', stockId: 'block', cornerRow: 1, cornerCol: 1, cornerFace: 'bottom',
      }
      const project = { stocks: [stock], setups: [parent, child] }
      const before = structuredClone(project)
      const plan = planSecondSideSetup(project, { parentSetupId: parent.id, axis, existingSetup: child })
      expect(plan).toMatchObject({ ok: true, fixtureOffset: 58, origin: child.wcs.origin })
      if (!manual) expect(plan).toMatchObject({ cornerFace: 'bottom', cornerRow: 1, cornerCol: 1 })
      expect(project).toEqual(before)
    }
  })

  it('uses the first unused slot and marks parent reuse for confirmation only when full', () => {
    const parent = firstSide('side-1', 'block', 54)
    const stock = block('block', 'Block', 54)
    const occupied = firstSide('other', 'another', 55)
    expect(planSecondSideSetup({ stocks: [stock], setups: [parent, occupied] }, { parentSetupId: parent.id, axis: 'x' }))
      .toMatchObject({ ok: true, fixtureOffset: 56 })
    const last = firstSide('last', 'block', 59)
    expect(planSecondSideSetup({ stocks: [block()], setups: [last] }, { parentSetupId: last.id, axis: 'y' }))
      .toMatchObject({ ok: true, fixtureOffset: 54 })
    const setups = [parent, ...[55, 56, 57, 58, 59].map(n => firstSide(`s${n}`, `b${n}`, n))]
    expect(planSecondSideSetup({ stocks: [stock], setups }, { parentSetupId: parent.id, axis: 'x' }))
      .toMatchObject({ ok: true, fixtureOffset: 54, requiresOffsetReuseConfirmation: true })
  })

  it.each(['x', 'y'] as const)('asks before exhausted-slot reuse on %s, cancels without writing and creates only after consent', async axis => {
    const stock = block('block', 'Block', 54)
    const parent = firstSide('parent', 'block', 54)
    const setups = [parent, ...[55, 56, 57, 58, 59].map(n => {
      const sibling = firstSide(`s${n}`, 'block', n)
      Object.assign(sibling.wcs, { fixtureOffsetOwner: 'setup' })
      return sibling
    })]
    installProject([stock], setups, false)
    installViewport([stock])
    render(<><SetupModal /><ConfirmModal /></>)
    act(() => useCamStore.getState().openModal('new-setup'))
    fireEvent.change(screen.getByTestId('setup-second-side-of'), { target: { value: parent.id } })
    fireEvent.change(screen.getByTestId('setup-second-side-axis'), { target: { value: axis } })
    const before = structuredClone(useCamStore.getState().project)
    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))
    expect(screen.getByRole('alertdialog', { name: 'Reuse G54?' })).toBeTruthy()
    expect(useCamStore.getState().project).toEqual(before)
    // Duplicate activation must neither replace the pending consent nor write.
    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))
    await act(async () => fireEvent.keyDown(window, { key: 'Escape' }))
    expect(useCamStore.getState().project).toEqual(before)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByTestId('setup-second-side-of')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))
    await act(async () => fireEvent.click(screen.getByTestId('confirm-dialog-confirm')))
    const project = useCamStore.getState().project
    expect(project.setups).toHaveLength(7)
    expect(project.setups.slice(0, 6)).toEqual(before.setups)
    expect(project.stocks).toEqual(before.stocks)
    expect(project.setups[6]).toMatchObject({ flipOf: { setupId: parent.id, axis },
      wcs: { fixtureOffset: 54, fixtureOffsetOwner: 'setup', origin: { x: axis === 'y' ? 100 : 0, y: axis === 'x' ? 50 : 0, z: 20 } } })
    // Saved children do not ask again or get reallocated on the probing route.
    expect(planSecondSideSetup(project, { parentSetupId: parent.id, axis, existingSetup: project.setups[6] }))
      .toMatchObject({ ok: true, fixtureOffset: 54, requiresOffsetReuseConfirmation: false })
  })

  it('considers same-stock siblings and manual setups, and rechecks claims at Save', () => {
    const stock = block('block', 'Block', 54)
    const parent = firstSide('parent', 'block', 54)
    const sibling = firstSide('sibling', 'block', 55)
    Object.assign(sibling.wcs, { fixtureOffsetOwner: 'setup' })
    const manual = firstSide('manual', 'block', 56)
    manual.wcs.originBinding = { kind: 'manual' }
    installProject([stock], [parent, sibling, manual], false)
    installViewport([stock])
    render(<><SetupModal /><ConfirmModal /></>)
    act(() => useCamStore.getState().openModal('new-setup'))
    fireEvent.change(screen.getByTestId('setup-second-side-of'), { target: { value: parent.id } })
    expect((screen.getByTestId('stock-work-offset-select') as HTMLSelectElement).value).toBe('57')
    const late = firstSide('late', 'another', 57)
    act(() => useCamStore.setState(s => ({ project: { ...s.project, setups: [...s.project.setups, late] } })))
    expect((screen.getByTestId('stock-work-offset-select') as HTMLSelectElement).value).toBe('58')
    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(useCamStore.getState().project.setups.at(-1)?.wcs.fixtureOffset).toBe(58)
  })

  it('takes a lower unused slot before a higher one', () => {
    const parent = firstSide('parent', 'block', 56)
    expect(planSecondSideSetup({ stocks: [block()], setups: [parent] }, { parentSetupId: parent.id, axis: 'x' }))
      .toMatchObject({ ok: true, fixtureOffset: 54, requiresOffsetReuseConfirmation: false })
  })


  it('uses the same confirmation on Enter and replans if a slot becomes free while asking', async () => {
    const stock = block('block', 'Block', 54)
    const parent = firstSide('parent', 'block', 54)
    const setups = [parent, ...[55, 56, 57, 58, 59].map(n => firstSide(`s${n}`, `b${n}`, n))]
    installProject([stock], setups, false)
    installViewport([stock])
    render(<><SetupModal /><ConfirmModal /></>)
    act(() => useCamStore.getState().openModal('new-setup'))
    fireEvent.change(screen.getByTestId('setup-second-side-of'), { target: { value: parent.id } })
    fireEvent.keyDown(screen.getByTestId('setup-modal-panel'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alertdialog', { name: 'Reuse G54?' })).toBeTruthy())
    act(() => useCamStore.setState(s => ({ project: { ...s.project,
      setups: s.project.setups.filter(setup => setup.id !== 's55') } })))
    await act(async () => fireEvent.click(screen.getByTestId('confirm-dialog-confirm')))
    expect(useCamStore.getState().project.setups).toHaveLength(6)
    expect(useCamStore.getState().project.setups.at(-1)?.wcs.fixtureOffset).toBe(55)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

})
