// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const {
  setModelBodyFaceSnapshotReader,
  setModelBodyHoleRecognizer,
} = await import('../../lib/cam/modelBodyHoleRecognition')
const originalDeriveBrepLayer = useCamStore.getState().deriveBrepLayer

const { smartHeightPlanFixture } = await import('../helpers/smartHeightPlanFixture')

const SETUP_ID = 'keyboard-setup'
const GEO_ID = 'keyboard-geometry'
const STOCK_ID = 'keyboard-stock'

// Smart Height V2 is the only authority (2e5678b7): the modal's Create button
// stays disabled until the operation's Smart Height preflight resolves, and
// that needs a proven owning stock plus a resolved plan. The store's async
// preview is stubbed with the shared plan fixture, exactly as the per-family
// V2 modal tests do (ContourSmartHeightOperationUI.phase7).
const keyboardStock = {
  id: STOCK_ID, name: 'Keyboard Stock', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
}
const keyboardSnapshot = {
  version: 1,
  wcs: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 8 },
  machine: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 8 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 30, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 25, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 22, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 20, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 8, provenance: 'inferred' },
  },
  dependencyIds: [STOCK_ID, GEO_ID],
}

function seedProject() {
  const loops = [{
    id: 'keyboard-loop',
    points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
    closed: true,
    type: 'contour',
    layerId: 'keyboard-layer',
    area: 400,
  }]
  const geometry = [{
    id: GEO_ID,
    name: 'keyboard-part.svg',
    type: 'curves_2d',
    format: 'svg',
    loaded: true,
    stockId: STOCK_ID,
    loops,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 0 } },
  }]
  const wcs = {
    id: 'keyboard-wcs',
    label: 'G54',
    fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
    stockId: STOCK_ID,
  }
  const setup = { id: SETUP_ID, name: 'Keyboard Setup', wcs, stock: null, operations: [], notes: '' }

  act(() => {
    const state = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [{
        id: 'keyboard-tool',
        name: 'Keyboard Tool',
        type: 'flat_end_mill',
        diameter: 6,
        fluteLength: 20,
        shankDiameter: 6,
        overallLength: 50,
        numberOfFlutes: 2,
      }],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: { smartHeight?: unknown }) =>
        smartHeightPlanFixture(operation as never, keyboardSnapshot as never)),
      previewContourSmartHeights: vi.fn(() => keyboardSnapshot),
      project: {
        ...state.project,
        geometry,
        setups: [setup],
        stocks: [keyboardStock],
        activeSetupId: SETUP_ID,
      },
    } as never)
  })
}

function removeProvenStock() {
  act(() => {
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        stocks: [],
        geometry: state.project.geometry.map(geometry => ({ ...geometry, stockId: undefined })),
        setups: state.project.setups.map(setup => ({ ...setup, wcs: { ...setup.wcs, stockId: undefined } })),
      },
    }))
  })
}

/** Drive a fresh contour to the V2 creatable state: tool, one loop, an
 * explicit end plane (a flat SVG has no physical floor to detect) and a
 * resolved preflight. Leaves the modal on Type & Name. */
async function makeCreatable() {
  chooseTool()
  selectKeyboardGeometryLoop()
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('contour-height-mode')).not.toBeNull())
  fireEvent.change(screen.getByTestId('contour-height-mode'), { target: { value: 'explicit_depth' } })
  await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
  await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByText('Type & Name'))
}

function openModal() {
  act(() => { useCamStore.getState().openModal('new-operation') })
}

function chooseTool() {
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('Keyboard Tool'))
}

function chooseOperationType(label: '2D Pocket' | '2D Adaptive Clearing' | 'Drill' | 'Bore') {
  fireEvent.click(screen.getByText(label))
}

function stubViewport() {
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartPickMode: vi.fn(),
    setSelectedPart: vi.fn(),
    setBrepPickMode: vi.fn(),
    setPickedBrepSelections: vi.fn(),
    setPickedLoops: vi.fn(),
  }
}

function openBoundaryOperation(label: '2D Pocket' | '2D Adaptive Clearing') {
  render(<NewOperationModal />)
  openModal()
  chooseOperationType(label)
  chooseTool()
  fireEvent.click(screen.getByText('Geometry'))
}

function selectKeyboardGeometryLoop() {
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
  const loop = document.querySelector('.op-loop-list input[type="checkbox"]') as HTMLInputElement | null
  if (!loop) throw new Error('keyboard geometry loop was not rendered')
  if (!loop.checked) fireEvent.click(loop)
}

function operationCount(): number {
  return useCamStore.getState().project.setups[0].operations.length
}

function numericInput(label: string): HTMLInputElement {
  const labelNode = screen.getAllByText(label)
    .find(element => element.classList.contains('op-field-label'))
  const input = labelNode?.parentElement?.querySelector('input')
  if (!input) throw new Error(`no numeric input for ${label}`)
  return input as HTMLInputElement
}

async function flushDeferredCreate() {
  await act(async () => {
    await new Promise<void>(resolve => window.setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  vi.stubGlobal('Worker', class {
    onmessage: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    postMessage(): void { /* no-op */ }
    terminate(): void { /* no-op */ }
  })
  act(() => {
    useCamStore.setState({
      deriveBrepLayer: originalDeriveBrepLayer,
    })
  })
  act(() => { useCamStore.getState().closeModal() })
  seedProject()
  stubViewport()
})

afterEach(() => {
  cleanup()
  setModelBodyHoleRecognizer(null)
  setModelBodyFaceSnapshotReader(null)
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('New Operation keyboard flow', () => {
  // Smart Height V2 is the only authority (2e5678b7; ADR-0040: no legacy, no
  // migration). The heights-intent tests that used to live here drove the
  // pre-V2 modal fields (Retract height / Depth from top / ref-plane-select /
  // selected-face bottoms / heightIntent writers) and were retired on
  // 2026-08-18. Per-family V2 authoring truth lives in
  // src/tests/components/*SmartHeightOperationUI*.test.tsx. What remains here
  // is the keyboard flow itself.

  it.each([
    { name: 'Pocket', operationLabel: '2D Pocket' as const },
    { name: 'Adaptive', operationLabel: '2D Adaptive Clearing' as const },
  ])('refuses $name stock roughing when the Setup has no proven stock', async ({ operationLabel }) => {
    removeProvenStock()
    openBoundaryOperation(operationLabel)

    fireEvent.click(screen.getByRole('button', { name: 'Stock' }))
    const previewTestId = operationLabel === '2D Pocket'
      ? 'pocket-stock-smart-height-preview'
      : 'adaptive-stock-smart-height-preview'
    await waitFor(() => expect(screen.getByTestId(previewTestId).textContent)
      .toContain('requires one proven stock assigned to this Setup'))
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    expect(operationCount()).toBe(0)
  })

  it('creates exactly once when Enter comes from an ordinary text input', async () => {
    render(<NewOperationModal />)
    openModal()
    await makeCreatable()

    const name = screen.getByPlaceholderText('Contour 1') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Keyboard contour' } })
    fireEvent.keyDown(name, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(operationCount()).toBe(1))
    expect(useCamStore.getState().project.setups[0].operations[0].name)
      .toBe('Keyboard contour')
    expect(screen.queryByTestId('op-create')).toBeNull()
  })

  it('persists a new Target End and creates exactly once on the same numeric Enter', async () => {
    render(<NewOperationModal />)
    openModal()
    await makeCreatable()
    fireEvent.click(screen.getByText('Heights'))

    const numeric = numericInput('Target End (WCS)')
    fireEvent.focus(numeric)
    fireEvent.change(numeric, { target: { value: '-12' } })
    fireEvent.keyDown(numeric, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(operationCount()).toBe(1))
    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'contour_2d', variant: 'explicit_depth' },
        machining: { end: { value: { plane: { offsetMm: -12 } } } },
      },
    })
    expect(screen.queryByTestId('op-create')).toBeNull()
  })

  it('leaves Enter inert when Create is disabled', () => {
    render(<NewOperationModal />)
    openModal()

    const name = screen.getByPlaceholderText('Contour 1') as HTMLInputElement
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(name, { key: 'Enter', code: 'Enter' })

    expect(operationCount()).toBe(0)
    expect(screen.getByTestId('op-create')).not.toBeNull()
  })

  it('does not steal multiline, IME, consumed, interactive, or button Enter', async () => {
    render(<NewOperationModal />)
    openModal()
    await makeCreatable()

    const panel = screen.getByTestId('op-modal-panel')
    const name = screen.getByPlaceholderText('Contour 1') as HTMLInputElement
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    const option = document.createElement('option')
    select.append(option)
    const listbox = document.createElement('div')
    listbox.setAttribute('role', 'listbox')
    const ariaMultiline = document.createElement('div')
    ariaMultiline.setAttribute('role', 'textbox')
    ariaMultiline.setAttribute('aria-multiline', 'true')
    const contentEditable = document.createElement('div')
    contentEditable.setAttribute('contenteditable', 'true')
    const roleLink = document.createElement('span')
    roleLink.setAttribute('role', 'link')
    panel.append(textarea, select, listbox, ariaMultiline, contentEditable, roleLink)

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(select, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(option, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(listbox, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(ariaMultiline, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(contentEditable, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(roleLink, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(name, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.keyDown(name, { key: 'Enter', code: 'Enter', keyCode: 229 })

    const prevent = (event: KeyboardEvent) => event.preventDefault()
    name.addEventListener('keydown', prevent, { once: true })
    fireEvent.keyDown(name, { key: 'Enter', code: 'Enter' })

    const consume = (event: KeyboardEvent) => event.stopPropagation()
    name.addEventListener('keydown', consume, { once: true })
    fireEvent.keyDown(name, { key: 'Enter', code: 'Enter' })

    const create = screen.getByTestId('op-create') as HTMLButtonElement
    fireEvent.keyDown(create, { key: 'Enter', code: 'Enter' })
    await flushDeferredCreate()
    expect(operationCount()).toBe(0)

    // Native button activation remains the one and only create path.
    fireEvent.click(create)
    expect(operationCount()).toBe(1)
  })

  it('blocks live-input Enter while picking, then routes Escape to picker before modal', async () => {
    const setLoopPickMode = vi.fn()
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setLoopPickMode,
      setPickedLoops: vi.fn(),
    }
    render(<NewOperationModal />)
    openModal()
    chooseTool()
    fireEvent.click(screen.getByText('Type & Name'))
    const name = screen.getByPlaceholderText('Contour 1') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Keep picker draft' } })
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    fireEvent.click(screen.getByText('Type & Name'))

    const liveName = screen.getByPlaceholderText('Contour 1') as HTMLInputElement
    expect(liveName).not.toBe(name)
    expect(liveName.isConnected).toBe(true)
    fireEvent.keyDown(liveName, { key: 'Enter', code: 'Enter' })
    await flushDeferredCreate()
    expect(operationCount()).toBe(0)
    expect(screen.getByTestId('op-loop-pick-banner')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(setLoopPickMode).toHaveBeenLastCalledWith(null)
    expect(screen.queryByTestId('op-loop-pick-banner')).toBeNull()
    expect(screen.getByTestId('op-create')).not.toBeNull()
    expect((screen.getByPlaceholderText('Contour 1') as HTMLInputElement).value)
      .toBe('Keep picker draft')

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByTestId('op-create')).toBeNull()
    expect(operationCount()).toBe(0)
  })
})

// The three regression pins the park-time confirmation audit held WO-012 open
// for (old repo, codex/keyflow-wip-2026-08-04 commit body). Each pin targets
// ONE specific guard so that deleting that guard alone turns exactly one test
// red -- the existing tests above cannot distinguish which guard suppressed a
// create, only that something did.
describe('New Operation keyboard flow: audit pins (WO-012 close-out)', () => {
  async function armCreatableModal() {
    render(<NewOperationModal />)
    openModal()
    await makeCreatable()
    return screen.getByPlaceholderText('Contour 1') as HTMLInputElement
  }

  function armLoopPicking() {
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
  }

  it('Escape between Enter and the deferred fire cancels the pending create (no create after the modal closes)', async () => {
    const name = await armCreatableModal()
    // Consumed Enter = the create is now scheduled on a 0ms timer.
    expect(fireEvent.keyDown(name, { key: 'Enter', code: 'Enter' })).toBe(false)
    // Escape lands in the same macrotask, before the timer can fire.
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByTestId('op-create')).toBeNull()
    await flushDeferredCreate()
    expect(operationCount()).toBe(0)
  })

  it('unmount between Enter and the deferred fire cancels the pending create', async () => {
    const name = await armCreatableModal()
    expect(fireEvent.keyDown(name, { key: 'Enter', code: 'Enter' })).toBe(false)
    cleanup() // unmounts the modal with the create still pending
    await flushDeferredCreate()
    expect(operationCount()).toBe(0)
  })

  it('a STANDALONE raw <option> (no ancestor select/listbox) never triggers create -- pins the bare option selector entry', async () => {
    await armCreatableModal()
    const panel = screen.getByTestId('op-modal-panel')
    // Deliberately NOT inside a <select>: the suite's earlier option test is
    // nested in one, so closest('select') would mask deleting 'option' from
    // the unsafe-target list. This element is caught by 'option' alone.
    const rawOption = document.createElement('option')
    panel.append(rawOption)
    expect(fireEvent.keyDown(rawOption, { key: 'Enter', code: 'Enter' })).toBe(true)
    await flushDeferredCreate()
    expect(operationCount()).toBe(0)
    // The only blocker was the target rule: the native button still creates.
    fireEvent.click(screen.getByTestId('op-create'))
    expect(operationCount()).toBe(1)
  })

  it('picker guard 1 (pre-schedule gate): Enter while picking is left UNCONSUMED -- the guard returns before preventDefault', async () => {
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setLoopPickMode: vi.fn(),
      setPickedLoops: vi.fn(),
    }
    await armCreatableModal()
    armLoopPicking()
    fireEvent.click(screen.getByText('Type & Name'))
    const liveName = screen.getByPlaceholderText('Contour 1') as HTMLInputElement
    // true = defaultPrevented was NOT called: the early gate refused before
    // consuming. The fire-time re-check (guard 2) consumes first, so this
    // assertion fails if guard 1 is deleted even though guard 2 still
    // suppresses the create.
    expect(fireEvent.keyDown(liveName, { key: 'Enter', code: 'Enter' })).toBe(true)
    await flushDeferredCreate()
    expect(operationCount()).toBe(0)
    expect(screen.getByTestId('op-loop-pick-banner')).not.toBeNull()
  })

  it('picker guard 2 (fire-time re-check): picking armed AFTER Enter was scheduled still suppresses the create', async () => {
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setLoopPickMode: vi.fn(),
      setPickedLoops: vi.fn(),
    }
    const name = await armCreatableModal()
    // Scheduled and consumed while NOT picking: guard 1 passed it through.
    expect(fireEvent.keyDown(name, { key: 'Enter', code: 'Enter' })).toBe(false)
    // Arm the picker synchronously, before the 0ms timer can fire.
    armLoopPicking()
    await flushDeferredCreate()
    expect(operationCount()).toBe(0)
    expect(screen.getByTestId('op-loop-pick-banner')).not.toBeNull()
  })
})
