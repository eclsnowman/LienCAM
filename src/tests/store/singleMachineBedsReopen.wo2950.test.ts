// @vitest-environment jsdom
//
// WO-2983 (WO-2950 plan): two beds on one machine stay separate through the
// real store routes. operator ruling 2026-10-20: "Yes - share G54, separate files only
// (recommended)". A bed is an existing Setup (Setup.id is its identity): two
// setups on stocks A and B, both setup-owned G54, created through the same
// executeCamCommands call the Setup dialog makes, edited through the public
// store actions, then saved (saveProjectToFile -> loadProjectFromFile) and
// restored from browser recovery (persistPartialize -> persist.rehydrate).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

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

// jsdom's localStorage is broken under vitest's node launch flags; the store's
// persist() writes on every set() (same shim as setupOriginStaysOnModelFinish.wo2271).
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

const { useCamStore, persistPartialize } = await import('../../store')
const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { makeOp, move } = await import('../post/helpers')
const { stampSmartHeightAuthority } = await import('../helpers/smartHeightAuthorityFixture')

import type { BoundingBox, ImportedGeometry, Operation, PhysicalStock, Project, Setup, Vec3 } from '../../types'
import type { SetupAuthoringFacts } from '../../kernel/authoring'

const state = () => useCamStore.getState()

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const stock = (id: string, x: number): PhysicalStock => ({
  id, name: `Stock ${id}`, mode: 'explicit',
  bounds: bbox({ x, y: 0, z: 0 }, { x: x + 100, y: 60, z: 18 }), position: { x: 0, y: 0, z: 0 },
})

const geometry = (id: string, stockId: string, x: number): ImportedGeometry => ({
  id, name: id, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
  boundingBox: bbox({ x, y: 0, z: 0 }, { x: x + 80, y: 50, z: 0 }),
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId,
  loops: [{ id: `${id}-loop`, points: [{ x, y: 0 }, { x: x + 80, y: 0 }, { x: x + 80, y: 50 }, { x, y: 50 }],
    closed: true, type: 'contour', layerId: 'L1', area: 4000 }],
  layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
} as ImportedGeometry)

/** The setup record SetupModal.handleSave builds for a new corner-bound setup. */
function bedSetup(id: string, name: string, stockId: string, x: number): Setup {
  return {
    id, name,
    wcs: {
      id: `wcs-${id}`, label: 'G54', fixtureOffset: 54, fixtureOffsetOwner: 'setup',
      origin: { x, y: 0, z: 18 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      originBinding: { kind: 'stock_corner', stockId, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
    },
    stock: {
      type: 'rectangular', width: 100, height: 60, depth: 18,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'plywood',
    },
    operations: [], notes: '',
  } as unknown as Setup
}

/** Facts the Setup dialog passes for a valid corner setup whose G54 is held by
 *  the other bed's stock (the dialog no longer turns that into a refusal). */
const FACTS: SetupAuthoringFacts = {
  heightsResolved: true, fixtureStackError: null, mustPickStock: false,
  originMode: 'corner', boreBound: false, secondSide: 'none',
}

const op = (id: string, setupId: string, stockId: string, geometryId: string, x: number): Operation =>
  stampSmartHeightAuthority(makeOp({
    id, name: id, toolId: state().toolLibrary[0]?.id ?? 't1', params: { geometryId },
    toolpathMoves: [
      move({ type: 'rapid', x, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: x + 10, y: 0, z: -1, feed: 100, role: 'cut' }),
    ],
  }), { setupId, stockId })

const setupById = (id: string) => state().project.setups.find((s) => s.id === id)!

/** What a bed authors (not derived caches, which the two persistence legs
 *  deliberately treat differently). */
function authored(project: Project) {
  return project.setups.map((s) => ({
    id: s.id, name: s.name,
    wcs: {
      fixtureOffset: s.wcs.fixtureOffset, label: s.wcs.label,
      fixtureOffsetOwner: (s.wcs as { fixtureOffsetOwner?: string }).fixtureOffsetOwner,
      origin: s.wcs.origin, stockId: s.wcs.stockId, originBinding: s.wcs.originBinding,
    },
    operations: s.operations.map((o) => ({
      id: o.id, name: o.name, enabled: o.enabled, geometryId: (o.params as { geometryId?: string }).geometryId,
    })),
  }))
}

let savedProjectText = ''

/** Two beds on one machine, built the way the operator builds them. */
function buildBeds(): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [geometry('geo-a', 'stock-a', 0), geometry('geo-b', 'stock-b', 300)],
      stocks: [stock('stock-a', 0), stock('stock-b', 300)],
    },
  }))
  for (const [id, name, stockId, x] of [
    ['bed-1', 'Bed 1 - cabinet sides', 'stock-a', 0],
    ['bed-2', 'Bed 2 - cabinet back', 'stock-b', 300],
  ] as const) {
    expect(state().executeCamCommands([{ kind: 'setup.add', setup: bedSetup(id, name, stockId, x) }],
      { kind: 'setup', facts: FACTS })).toMatchObject({ ok: true })
  }
  expect(state().executeCamCommands([
    { kind: 'operation.add', setupId: 'bed-1', operation: op('a-side-1', 'bed-1', 'stock-a', 'geo-a', 0) },
    { kind: 'operation.add', setupId: 'bed-1', operation: op('a-side-2', 'bed-1', 'stock-a', 'geo-a', 20) },
    { kind: 'operation.add', setupId: 'bed-1', operation: op('a-side-3', 'bed-1', 'stock-a', 'geo-a', 40) },
    { kind: 'operation.add', setupId: 'bed-2', operation: op('b-back-1', 'bed-2', 'stock-b', 'geo-b', 300) },
  ])).toMatchObject({ ok: true })
}

beforeEach(() => {
  mem.clear()
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  state().newProject()
  savedProjectText = ''
  vi.stubGlobal('liencamHost', {
    saveFile: async (_filename: string, data: string | Uint8Array) => {
      savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return 'C:\\Temp\\WO-2983.camproject'
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetDocumentHolder()
})

describe('WO-2983 single-machine beds through save, open and browser recovery', () => {
  it('creates two G54 beds on different stocks through the Setup dialog command', () => {
    buildBeds()
    const beds = authored(state().project).filter((s) => s.id.startsWith('bed-'))
    expect(beds.map((b) => [b.id, b.wcs.fixtureOffset, b.wcs.fixtureOffsetOwner, b.wcs.stockId])).toEqual([
      ['bed-1', 54, 'setup', 'stock-a'],
      ['bed-2', 54, 'setup', 'stock-b'],
    ])
    expect(beds.map((b) => b.operations.map((o) => o.id))).toEqual([['a-side-1', 'a-side-2', 'a-side-3'], ['b-back-1']])
    // The project still has one machine, and creating a bed moved no stock.
    expect(state().project.stocks?.map((s) => [s.id, s.bounds.min.x, s.fixtureOffset])).toEqual([
      ['stock-a', 0, undefined], ['stock-b', 300, undefined],
    ])
  })

  it('switching beds clears the operation selection and moves nothing', () => {
    buildBeds()
    state().setActiveSetup('bed-1')
    state().setActiveOperation('a-side-2')
    expect(state().project.activeOperationId).toBe('a-side-2')
    const before = JSON.stringify({ stocks: state().project.stocks, geometry: state().project.geometry,
      machine: state().project.machine, setups: authored(state().project) })
    state().setActiveSetup('bed-2')
    expect(state().project.activeSetupId).toBe('bed-2')
    expect(state().project.activeOperationId).toBeNull()
    expect(JSON.stringify({ stocks: state().project.stocks, geometry: state().project.geometry,
      machine: state().project.machine, setups: authored(state().project) })).toBe(before)
  })

  it("editing, suppressing, reordering and deleting in bed 1 never touches bed 2; undo restores bed 1", () => {
    buildBeds()
    const bed2 = JSON.stringify(setupById('bed-2'))
    const bed2Authored = authored(state().project).find((s) => s.id === 'bed-2')
    const bed1 = authored(state().project).find((s) => s.id === 'bed-1')
    const historyBefore = state().projectHistory.length
    state().updateSetup('bed-1', { name: 'Bed 1 - sides (2nd load)', wcs: { origin: { x: 5, y: 5, z: 18 } } })
    state().updateOperation('bed-1', 'a-side-1', { enabled: false })
    state().reorderOperations('bed-1', 0, 2)
    state().removeOperation('bed-1', 'a-side-2')
    expect(JSON.stringify(setupById('bed-2'))).toBe(bed2)
    const edited = authored(state().project).find((s) => s.id === 'bed-1')!
    expect(edited.name).toBe('Bed 1 - sides (2nd load)')
    expect(edited.wcs.origin).toEqual({ x: 5, y: 5, z: 18 })
    expect(edited.operations.map((o) => [o.id, o.enabled])).toEqual([['a-side-3', true], ['a-side-1', false]])
    expect(state().projectHistory.length).toBeGreaterThan(historyBefore)
    while (state().projectHistory.length > historyBefore) state().undo()
    expect(authored(state().project).find((s) => s.id === 'bed-1')).toEqual(bed1)
    // Undo restores a history snapshot, which keeps no generated toolpaths for
    // ANY setup (pushHistory strips them project-wide), so bed 2 only needs a
    // regenerate; what it authors is untouched.
    expect(authored(state().project).find((s) => s.id === 'bed-2')).toEqual(bed2Authored)
  })

  it('deleting the active bed leaves no guessed replacement and keeps the other bed', () => {
    buildBeds()
    state().setActiveSetup('bed-2')
    const bed1 = JSON.stringify(setupById('bed-1'))
    state().removeSetup('bed-2')
    expect(state().project.setups.some((s) => s.id === 'bed-2')).toBe(false)
    expect(state().project.activeSetupId).toBeNull()
    expect(JSON.stringify(setupById('bed-1'))).toBe(bed1)
    state().undo()
    expect(setupById('bed-2').operations.map((o) => o.id)).toEqual(['b-back-1'])
  })

  it('save, close and reopen keeps both beds, their stocks, origins and operations apart', async () => {
    buildBeds()
    state().setActiveSetup('bed-2')
    const before = authored(state().project)
    await state().saveProjectToFile()
    expect(savedProjectText).not.toBe('')

    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())
    useCamStore.setState(useCamStore.getInitialState(), true)
    await state().loadProjectFromFile(savedProjectText)

    expect(authored(state().project)).toEqual(before)
    expect(state().project.activeSetupId).toBe('bed-2')
    expect(state().project.stocks?.map((s) => [s.id, s.bounds.min.x])).toEqual([['stock-a', 0], ['stock-b', 300]])
    // Opening does not hand out a new offset or rewrite either G54.
    expect(state().project.setups.map((s) => s.wcs.fixtureOffset)).toEqual(before.map((s) => s.wcs.fixtureOffset))
  })

  it('browser recovery (persistPartialize -> rehydrate) keeps the same authored beds', async () => {
    buildBeds()
    state().setActiveSetup('bed-1')
    const before = authored(state().project)
    const blob = JSON.stringify({ state: persistPartialize(state()), version: useCamStore.persist.getOptions().version })
    const originalOptions = useCamStore.persist.getOptions()
    try {
      useCamStore.setState(useCamStore.getInitialState(), true)
      useCamStore.persist.setOptions({ storage: {
        getItem: () => JSON.parse(blob), setItem: () => {}, removeItem: () => {},
      } })
      await useCamStore.persist.rehydrate()
      expect(authored(state().project)).toEqual(before)
      expect(state().project.activeSetupId).toBe('bed-1')
    } finally {
      useCamStore.persist.setOptions(originalOptions)
    }
  })

  it('a bed that deliberately reuses stock A stays on stock A through reopen (shared-stock control)', async () => {
    buildBeds()
    expect(state().executeCamCommands([{ kind: 'setup.add', setup: bedSetup('bed-3', 'Bed 3 - same block, top', 'stock-a', 0) }],
      { kind: 'setup', facts: FACTS })).toMatchObject({ ok: true })
    await state().saveProjectToFile()
    useCamStore.setState(useCamStore.getInitialState(), true)
    await state().loadProjectFromFile(savedProjectText)
    expect(setupById('bed-3').wcs.stockId).toBe('stock-a')
    expect(setupById('bed-3').wcs.originBinding).toMatchObject({ stockId: 'stock-a' })
    expect(setupById('bed-1').wcs.stockId).toBe('stock-a')
    expect(setupById('bed-2').wcs.stockId).toBe('stock-b')
    expect(state().project.stocks).toHaveLength(2)
  })
})
