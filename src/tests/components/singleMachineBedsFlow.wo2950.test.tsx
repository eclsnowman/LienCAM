// @vitest-environment jsdom
//
// WO-2983 (WO-2950 plan): the operator's flow for two beds on one machine, on
// the real screens. operator ruling 2026-10-20: "Yes - share G54, separate files only
// (recommended)". The Setup dialog lets a second load pick a G54 another
// stock already uses and says so; the tree switches beds; Post Process
// exports one file per bed with distinct names, and each bed's setup sheet
// describes that bed's own program.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BoundingBox, ImportedGeometry, PhysicalStock, Project, Setup, Vec3 } from '../../types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size }, clear: () => mem.clear(), getItem: (key: string) => mem.get(key) ?? null,
  key: (i: number) => [...mem.keys()][i] ?? null, removeItem: (key: string) => mem.delete(key),
  setItem: (key: string, value: string) => mem.set(key, String(value)),
} })

const { SetupModal } = await import('../../components/modals/SetupModal')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { postProject } = await import('../../lib/post/postProject')
const { UCCNC_CONFIG } = await import('../../lib/post/dialects/uccnc')
const { buildSetupSheet } = await import('../../lib/post/setupSheet')
const { stockWorldBounds } = await import('../../store/stockAssignment')
const { setupOwnsFixtureOffset } = await import('../../lib/post/workOffsets')
const { makeMachine, makeOp, makeStock, makeTool, move, stampGenerationCurrent } = await import('../post/helpers')

const initial = useCamStore.getState()

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const stock = (id: string, name: string, x: number): PhysicalStock => ({
  id, name, mode: 'explicit',
  bounds: bbox({ x, y: 0, z: -18 }, { x: x + 100, y: 60, z: 0 }), position: { x: 0, y: 0, z: 0 },
})

const geometry = (id: string, stockId: string, x: number): ImportedGeometry => ({
  id, name: id, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
  boundingBox: bbox({ x, y: 0, z: 0 }, { x: x + 80, y: 50, z: 0 }),
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId, loops: [],
} as ImportedGeometry)

/** A bed as the Setup dialog saves it: setup-owned G54, corner of its own stock. */
function bed(id: string, name: string, stockId: string, x: number, opIds: string[], fixtureOffset = 54): Setup {
  return {
    id, name, notes: '', stock: makeStock(),
    wcs: {
      id: `wcs-${id}`, label: `G${fixtureOffset}`, fixtureOffset, fixtureOffsetOwner: 'setup',
      origin: { x, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      originBinding: { kind: 'stock_corner', stockId, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
    } as Setup['wcs'],
    operations: opIds.map((opId, i) => makeOp({
      id: opId, name: opId, toolId: 't1', params: { geometryId: `geo-${stockId}` },
      toolpathMoves: [
        move({ type: 'rapid', x: x + i * 10, y: 0, z: 5, role: 'rapid' }),
        move({ type: 'feed', x: x + i * 10 + 5, y: 0, z: -1, feed: 100, role: 'cut' }),
        move({ type: 'rapid', x: x + i * 10 + 5, y: 0, z: 5, role: 'rapid' }),
      ],
    })),
  }
}

function install(setups: Setup[], stocks: PhysicalStock[]): Project {
  const tool = makeTool({ id: 't1', toolNumber: 1 })
  const project: Project = {
    ...initial.project, id: 'beds-flow', name: 'Cabinet', machine: makeMachine(),
    toolLibrary: [tool], stocks, nests: [], modelItems: [],
    geometry: stocks.map((s) => geometry(`geo-${s.id}`, s.id, s.bounds.min.x)),
    setups, activeSetupId: setups[0]?.id ?? null, activeOperationId: null,
  }
  for (const s of setups) for (const op of s.operations) stampGenerationCurrent(project, s, op, tool)
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({ project, toolLibrary: [tool], consoleEvents: [], modelRefsVerifiedSinceLoad: true })
  })
  return project
}

const offsetSelect = () => screen.getByTestId('stock-work-offset-select') as HTMLSelectElement
const createButton = () => screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement
const stockSelect = () => document.querySelector('select.wcs-stock-select') as HTMLSelectElement

let files: { name: string; parts: unknown[]; type: string }[]
let pending: { parts: unknown[]; type: string }

beforeEach(() => {
  mem.clear()
  files = []
  class CaptureBlob {
    parts: unknown[]; type: string
    constructor(parts: unknown[], options?: { type?: string }) { this.parts = parts; this.type = options?.type ?? '' }
  }
  vi.stubGlobal('Blob', CaptureBlob)
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn((blob) => { pending = blob; return 'blob:wo2983' }), revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    files.push({ name: this.download, ...pending })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__cncViewport
  act(() => useCamStore.setState({ project: initial.project, toolLibrary: initial.toolLibrary, activeModal: null }))
})

describe('WO-2983 single-machine beds: Setup dialog', () => {
  it('lets Bed 2 on stock B pick the G54 that Bed 1 on stock A uses, with a plain note', () => {
    install([bed('bed-1', 'Bed 1 - cabinet sides', 'stock-a', 0, ['a1'])],
      [stock('stock-a', 'Sides blank', 0), stock('stock-b', 'Back blank', 300)])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    act(() => { fireEvent.change(stockSelect(), { target: { value: 'stock-b' } }) })

    // A free slot is still preferred by default, and says nothing.
    expect(offsetSelect().value).toBe('55')
    expect(screen.queryByTestId('setup-shared-work-offset-note')).toBeNull()

    const g54 = Array.from(offsetSelect().options).find((o) => o.value === '54')!
    expect(g54.disabled).toBe(false)
    expect(g54.textContent).toBe('G54 - in use (stock Sides blank)')
    act(() => { fireEvent.change(offsetSelect(), { target: { value: '54' } }) })
    expect(offsetSelect().value).toBe('54')
    expect(screen.getByTestId('setup-shared-work-offset-note').textContent).toBe(
      'G54 is also used (stock Sides blank). That works when these setups post as separate files (one per setup); a combined program refuses it.',
    )
    expect(createButton().disabled).toBe(false)
    act(() => { fireEvent.change(screen.getByDisplayValue(/^Setup 2$/), { target: { value: 'Bed 2 - cabinet back' } }) })
    act(() => { fireEvent.click(createButton()) })

    const saved = useCamStore.getState().project.setups
    expect(saved.map((s) => [s.name, s.wcs.fixtureOffset, s.wcs.stockId])).toEqual([
      ['Bed 1 - cabinet sides', 54, 'stock-a'],
      ['Bed 2 - cabinet back', 54, 'stock-b'],
    ])
    expect(setupOwnsFixtureOffset(saved[1].wcs)).toBe(true)
    // No physical-stock slot was assigned or rewritten.
    expect(useCamStore.getState().project.stocks?.map((s) => s.fixtureOffset)).toEqual([undefined, undefined])
  })

  it('creates a seventh load when G54-G59 are all in use (no six-bed cap)', () => {
    const stocks = Array.from({ length: 7 }, (_, i) => stock(`stock-${i}`, `Blank ${i + 1}`, i * 150))
    install([54, 55, 56, 57, 58, 59].map((offset, i) => bed(`bed-${i}`, `Bed ${i + 1}`, `stock-${i}`, i * 150, [`op-${i}`], offset)), stocks)
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    act(() => { fireEvent.change(stockSelect(), { target: { value: 'stock-6' } }) })
    expect(Array.from(offsetSelect().options).every((o) => !o.disabled)).toBe(true)
    expect(offsetSelect().value).toBe('54')
    expect(screen.getByTestId('setup-shared-work-offset-note').textContent).toContain('stock Blank 1')
    expect(createButton().disabled).toBe(false)
    act(() => { fireEvent.click(createButton()) })
    const seventh = useCamStore.getState().project.setups[6]
    expect(seventh.wcs).toMatchObject({ fixtureOffset: 54, stockId: 'stock-6' })
  })

  it('a second setup on the SAME stock and slot shows no note (same block, existing behaviour)', () => {
    install([bed('bed-1', 'Top', 'stock-a', 0, ['a1'])], [stock('stock-a', 'Sides blank', 0)])
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    expect(offsetSelect().value).toBe('54')
    expect(screen.queryByTestId('setup-shared-work-offset-note')).toBeNull()
  })
})

describe('WO-2983 single-machine beds: tree selection', () => {
  it('the tree row switches beds and clears the other bed’s operation selection', () => {
    install([bed('bed-1', 'Bed 1 - cabinet sides', 'stock-a', 0, ['a1', 'a2']), bed('bed-2', 'Bed 2 - cabinet back', 'stock-b', 300, ['b1'])],
      [stock('stock-a', 'Sides blank', 0), stock('stock-b', 'Back blank', 300)])
    act(() => { useCamStore.getState().setActiveSetup('bed-1'); useCamStore.getState().setActiveOperation('a2') })
    const before = JSON.stringify(useCamStore.getState().project.stocks)
    render(<DesignTree />)
    const header = screen.getByText('Bed 2 - cabinet back').closest('.tree-setup-header') as HTMLElement
    act(() => { fireEvent.click(header) })
    expect(useCamStore.getState().project.activeSetupId).toBe('bed-2')
    expect(useCamStore.getState().project.activeOperationId).toBeNull()
    expect(JSON.stringify(useCamStore.getState().project.stocks)).toBe(before)
  })
})

describe('WO-2983 single-machine beds: Post Process separate files', () => {
  function openPost() {
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))
    const context = screen.getByTestId('post-include-context-row').querySelector('input') as HTMLInputElement
    if (context.checked) fireEvent.click(context)
    fireEvent.click(screen.getByRole('checkbox', { name: /^All operations/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Separate files (one per setup)' }))
  }
  const twoBeds = () => install(
    [bed('bed-1', 'Bed 1 - cabinet sides', 'stock-a', 0, ['a1', 'a2']), bed('bed-2', 'Bed 2 - cabinet back', 'stock-b', 300, ['b1'])],
    [stock('stock-a', 'Sides blank', 0), stock('stock-b', 'Back blank', 300)],
  )

  it('exports one file per G54 bed under distinct names, each equal to posting that bed alone', async () => {
    const project = twoBeds()
    openPost()
    const names = (screen.getAllByRole('textbox', { name: /^File name -/ }) as HTMLInputElement[]).map((f) => f.value)
    expect(names).toEqual(['Cabinet-G54-Bed-1-cabinet-sides.nc', 'Cabinet-G54-Bed-2-cabinet-back.nc'])
    const exportButton = screen.getByRole('button', { name: 'Export 2 files' }) as HTMLButtonElement
    expect(exportButton.disabled).toBe(false)
    fireEvent.click(exportButton)
    await waitFor(() => expect(files).toHaveLength(2))
    expect(files.map((f) => f.name)).toEqual(names)
    for (const [i, setup] of project.setups.entries()) {
      const alone = postProject(project, [setup], UCCNC_CONFIG, { mode: 'separate', pauseBetweenSetups: false, baseName: 'Cabinet', ext: 'nc' })
      expect(files[i].parts[0]).toBe(alone.files![0].result.gcode)
    }
  })

  it('downloads each bed’s own setup sheet pair (no bed gets another bed’s program)', async () => {
    const project = twoBeds()
    openPost()
    fireEvent.click(screen.getByTestId('post-download-setup-sheet'))
    await waitFor(() => expect(files).toHaveLength(4), { timeout: 15000 })
    const posted = postProject(project, project.setups, UCCNC_CONFIG, { mode: 'separate', pauseBetweenSetups: false, baseName: 'Cabinet', ext: 'nc' })
    expect(posted.ok).toBe(true)
    for (const [i, file] of posted.files!.entries()) {
      const setup = project.setups.find((s) => s.id === file.setupId)!
      expect(files[i * 2].name).toBe(file.filename.replace(/\.nc$/, '.setup.txt'))
      expect(files[i * 2].parts[0]).toBe(await buildSetupSheet(project, [setup], UCCNC_CONFIG, file.result, file.filename, stockWorldBounds))
      expect(String(files[i * 2].parts[0])).toContain(setup.name)
      expect(files[i * 2 + 1].name).toBe(file.filename.replace(/\.nc$/, '.setup.pdf'))
    }
  })

  it('the scope tree paints the shared G54 as a conflict in Combined only, never in Separate', () => {
    twoBeds()
    openPost()
    expect(document.querySelectorAll('.scope-conflict')).toHaveLength(0)
    expect(document.querySelectorAll('.scope-conflict-note')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /^Combined/ }))
    expect(document.querySelectorAll('.scope-conflict')).toHaveLength(2)
    const notes = Array.from(document.querySelectorAll('.scope-conflict-note')).map((n) => n.textContent)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatch(/G54.*conflicts with.*Back blank/)
    expect(notes[1]).toMatch(/G54.*conflicts with.*Sides blank/)
    fireEvent.click(screen.getByRole('button', { name: 'Separate files (one per setup)' }))
    expect(document.querySelectorAll('.scope-conflict')).toHaveLength(0)
  })

  it('exporting Bed 2 alone keeps the historical name; combined still refuses the shared G54', async () => {
    twoBeds()
    openPost()
    fireEvent.click(document.querySelectorAll('.scope-setup-cb')[0])
    expect((screen.getAllByRole('textbox', { name: /^File name -/ }) as HTMLInputElement[]).map((f) => f.value))
      .toEqual(['Cabinet-G54.nc'])
    fireEvent.click(document.querySelectorAll('.scope-setup-cb')[0])
    fireEvent.click(screen.getByRole('button', { name: /^Combined/ }))
    await waitFor(() => expect(screen.getAllByText(/so one combined program cannot run them/i).length).toBeGreaterThan(0))
  })
})
