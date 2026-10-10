// @vitest-environment jsdom
//
// React-render SMOKE test for the Thread Mill op-type path in NewOperationModal.
//
// WHY THIS EXISTS: a new thread_mill CAM op was wired into the operation wizard
// (op-type card, geometry/loop selection mirroring Drill, and a thread params
// section). UI/modal changes need a real React RENDER test because tsc + the
// pure-logic vitest suites cannot catch hooks-order bugs (a useEffect placed
// after an early `return null`, a state hook added under a new branch, etc.).
// This mounts the real modal, picks the Thread Mill card, lands on the Passes
// tab, and asserts the thread params render WITHOUT throwing. The render itself
// passing (stable hook order across the closed->open and op-type transitions) is
// the core regression gate. Mirrors NewOperationModalLoops.smoke.test.tsx.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags; the
// store's persist() needs a working backend. Install an in-memory shim BEFORE the
// store import. Pure test scaffolding; no app change. (Same pattern as NestModal.)
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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const GEO_ID = 'geo-test'
const SETUP_ID = 'setup-test'

// A geometry with three closed loops + a setup the modal can find via
// activeSetupId. Cast loosely — render scaffolding; the modal only reads
// id/name/type/loops and loop id/closed/type/area/points. (Same as the loops
// smoke test.)
function seedProjectWithLoops() {
  const loops = [
    { id: 'loop-a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, type: 'contour', layerId: 'L', area: 100 },
    { id: 'loop-b', points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
    { id: 'loop-c', points: [{ x: 6, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 8 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
  ]
  const geometry = [{
    id: GEO_ID, name: 'part.svg', type: 'curves_2d', format: 'svg', loaded: true, loops,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
  }]
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

// A 'brep' (STEP) source geometry the modal recognizes for the "From 3D model"
// derive panel (isBrepGeo = type === 'brep'). A non-zero Z bbox feeds the
// Section-at-Z field range. The modal only reads id/name/type/boundingBox here.
function seedProjectWithBrep() {
  const geometry = [{
    id: GEO_ID, name: 'boss.step', type: 'brep', format: 'step', loaded: true, loops: [],
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 20 } },
  }]
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

// Seed a geometry + an EXISTING thread_mill operation carrying a specific
// geometrySource, then open the modal in EDIT mode (the prefill effect copies
// op.params into the modal's threadMill state). This is the only path that can
// stamp geometrySource:'cylinder' without running an OCCT cylinder derive.
// heights/passes/linking are plausible but unread by the Passes tab; the modal
// top-level never reads heights fields dangerously (resolveRefZ is try/caught).
function seedProjectWithThreadOp(
  geometrySource: 'loop' | 'cylinder',
  threadKind: 'internal' | 'external' = 'internal',
) {
  const loops = [
    { id: 'loop-a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, type: 'contour', layerId: 'L', area: 100 },
    { id: 'loop-b', points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
  ]
  const geometry = [{
    id: GEO_ID, name: 'part.svg', type: 'curves_2d', format: 'svg', loaded: true, loops,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
  }]
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const op = {
    id: 'op-tm', name: 'Thread 1', type: 'thread_mill', enabled: true, status: 'pending', toolId: '',
    geometrySelections: ['loop-b'],
    heights: { topHeight: 5, bottomHeight: -9, clearanceHeight: 15, retractHeight: 10, feedHeight: 1, topHeightMode: 'stock_top', bottomHeightMode: 'geometry_face', planeOffset: 0 },
    passes: { stockToLeave: 0, finishPasses: 0, depthPerPass: 1, stepover: 0.4 },
    linking: {},
    params: {
      geometryId: GEO_ID, loopIds: ['loop-b'],
      threadKind, externalReference: 'top',
      majorDiameter: 10, pitch: 1.5, handedness: 'right', cutDirection: 'climb',
      roughingPasses: 1, springPasses: 0, leadInOut: 'arc', compensation: 'computer',
      heightReference: 'geometry_face', planeOffset: 0, threadDepth: 9,
      geometrySource,
    },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [op], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

// Open the modal, pick the Thread Mill op-type card, select the geometry, and
// land on the Passes tab where the thread params render.
function openModalOnThreadMillPasses() {
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Thread Mill'))         // Type tab card
  fireEvent.click(screen.getByText('Geometry'))            // Geometry tab
  fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, { target: { value: GEO_ID } })
  fireEvent.click(screen.getByText('Passes'))              // Passes tab (thread controls)
}

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

describe('NewOperationModal thread-mill smoke', () => {
  it('selecting the Thread Mill card renders the thread params section without throwing', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnThreadMillPasses()

    // The card click + op-type transition + Passes render did not throw a
    // hooks-order error — the regression class this smoke guards. The thread
    // params labels prove the thread section rendered. (getAllByText, not
    // getByText: the field LABEL and the NumericInput's aria-label both carry the
    // text, so >=1 match is the assertion we want.)
    expect(screen.getAllByText(/Major diameter/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/^Pitch$/).length).toBeGreaterThan(0)

    // The thread-specific selects render and carry their v1 defaults.
    const kind = screen.getByTestId('thread-kind') as HTMLSelectElement
    expect(kind.value).toBe('internal')
    // Compensation moved behind the collapsed "Advanced" DisclosureSection
    // (clutter P6) - expand it first (also guards the collapsed->expanded
    // hook transition).
    fireEvent.click(screen.getByTestId('disclosure-passes-advanced'))
    const comp = screen.getByTestId('thread-compensation') as HTMLSelectElement
    expect(comp.value).toBe('computer')
    expect(comp.disabled).toBe(true)
  })

  it('the thread-kind select offers internal AND external, both enabled', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnThreadMillPasses()

    const kind = screen.getByTestId('thread-kind') as HTMLSelectElement
    const options = Array.from(kind.options)
    const internal = options.find(o => o.value === 'internal')!
    const external = options.find(o => o.value === 'external')!
    expect(internal.disabled).toBe(false)
    expect(external.disabled).toBe(false)
    expect(external.textContent?.toLowerCase()).not.toContain('coming soon')
  })

  it('the thread-size preset select renders with Custom + standard sizes and applies without throwing', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnThreadMillPasses()

    const preset = screen.getByTestId('thread-size-preset') as HTMLSelectElement
    const optionValues = Array.from(preset.options).map(o => o.value)
    expect(optionValues[0]).toBe('')            // leading "Custom" option does nothing
    expect(optionValues).toContain('M10x1.5')   // standard metric entry present

    // Selecting a preset batch-fills majorDiameter + pitch via setThreadMill;
    // the render surviving the change is the regression gate (no throw, no
    // hooks-order break). The Major diameter label still renders afterwards.
    fireEvent.change(preset, { target: { value: 'M10x1.5' } })
    expect(screen.getAllByText(/Major diameter/i).length).toBeGreaterThan(0)
  })

  it('an external boss offers a reference-direction toggle that flips the thread-depth DIRECTION hint between "down from the top" and "up from the base"', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnThreadMillPasses()

    // Switch to an EXTERNAL boss on the Passes tab, then visit Heights.
    fireEvent.change(screen.getByTestId('thread-kind') as HTMLSelectElement, { target: { value: 'external' } })
    fireEvent.click(screen.getByText('Heights'))

    // The reference-direction select renders for external, offers BOTH options,
    // and defaults to 'top' (thread down from the boss top).
    const ref = screen.getByTestId('thread-external-reference') as HTMLSelectElement
    const refValues = Array.from(ref.options).map(o => o.value)
    expect(refValues).toEqual(['top', 'base'])
    expect(ref.value).toBe('top')

    // The field LABEL is band language "Thread depth"; WO-1182 removed the
    // direction hint under it - the reference select carries the direction.
    expect(screen.getAllByText(/^Thread depth$/i).length).toBeGreaterThan(0)
    fireEvent.change(ref, { target: { value: 'base' } })
    expect(ref.value).toBe('base')
  })

  it('with a B-rep source selected, the Geometry tab shows the in-modal derive controls (Pick face / Section at Z / Pick edges)', () => {
    // Regression gate for enabling the generic B-rep derive UI on thread_mill:
    // the user must be able to pick a boss-top planar face directly in the thread
    // op (showPickFace/showSectionZ/showPickEdges gated on isThreadMill).
    seedProjectWithBrep()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Thread Mill'))   // Type tab card
    fireEvent.click(screen.getByText('Geometry'))       // Geometry tab
    fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, { target: { value: GEO_ID } })

    // All three derive controls render for a thread_mill + brep source.
    expect(screen.getByTestId('brep-pick-face')).toBeTruthy()
    expect(screen.getByTestId('brep-section-z')).toBeTruthy()
    expect(screen.getByTestId('brep-pick-edges')).toBeTruthy()
    // "Detect holes" stays drill-only — not present for thread mill.
    expect(screen.queryByTestId('brep-detect-holes')).toBeNull()
  })

  it('geometrySource:loop shows the MANUAL badge and a prominent (non-Advanced) thread-kind select', () => {
    seedProjectWithThreadOp('loop')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-tm') })
    fireEvent.click(screen.getByText('Passes'))

    const badge = screen.getByTestId('thread-source-badge')
    expect(badge.textContent).toMatch(/Manual - set kind & direction/i)

    // The manual path renders the editable kind select directly (NOT tucked in an
    // Advanced <details>), and there is no read-only "Detected" line.
    const kind = screen.getByTestId('thread-kind') as HTMLSelectElement
    expect(kind.value).toBe('internal')
    expect(kind.closest('details')).toBeNull()
    expect(screen.queryByTestId('thread-detected-kind')).toBeNull()
  })

  it('geometrySource:cylinder shows the AUTO badge + detected-kind line, with the kind select inside an Advanced <details>', () => {
    seedProjectWithThreadOp('cylinder')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-tm') })
    fireEvent.click(screen.getByText('Passes'))

    const badge = screen.getByTestId('thread-source-badge')
    expect(badge.textContent).toMatch(/Auto from selected cylinder face/i)

    // The inferred kind is shown read-only...
    const detected = screen.getByTestId('thread-detected-kind')
    expect(detected.textContent).toMatch(/Detected:\s*Internal \(bore\)/i)

    // ...and the editable select still exists but is nested in the Advanced
    // override <details> (kept functional, same data-testid).
    const kind = screen.getByTestId('thread-kind') as HTMLSelectElement
    expect(kind.value).toBe('internal')
    expect(kind.closest('details')).not.toBeNull()
  })

  it('thread Heights tab DROPS the generic reference-plane dropdown and shows the locked datum line', () => {
    // Item 3/4: thread heights are locked to geometry_face (cylinder top /
    // circle plane), so the shared 5-option ref-plane <select> must NOT render
    // for a thread op; a static datum line communicates the lock instead.
    seedProjectWithThreadOp('loop')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-tm') })
    fireEvent.click(screen.getByText('Heights'))

    expect(screen.queryByTestId('ref-plane-select')).toBeNull()
    expect(screen.getByTestId('thread-datum-line')).toBeTruthy()
    // Thread-specific section label replaces the generic "Bottom of cut" framing.
    expect(screen.getByTestId('thread-datum-label')).toBeTruthy()
    expect(screen.queryByTestId('ref-section-label')).toBeNull()
  })

  it('external + cylinder source DEMOTES the thread-direction toggle into an Advanced <details>', () => {
    // Cylinder pick inferred direction; the override is rarely needed, so the
    // externalReference select lives inside <details data-testid=thread-direction-advanced>.
    seedProjectWithThreadOp('cylinder', 'external')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-tm') })
    fireEvent.click(screen.getByText('Heights'))

    const ref = screen.getByTestId('thread-external-reference') as HTMLSelectElement
    expect(ref.closest('details')).not.toBeNull()
    expect(screen.getByTestId('thread-direction-advanced')).toBeTruthy()
  })

  it('external + loop/manual source shows the thread-direction toggle PROMINENTLY (not in <details>)', () => {
    // A 2D circle cannot infer thread direction, so the externalReference select
    // must be shown directly (required input), not tucked behind a disclosure.
    seedProjectWithThreadOp('loop', 'external')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-tm') })
    fireEvent.click(screen.getByText('Heights'))

    const ref = screen.getByTestId('thread-external-reference') as HTMLSelectElement
    expect(ref.closest('details')).toBeNull()
    expect(screen.queryByTestId('thread-direction-advanced')).toBeNull()
  })

  it('a NON-thread op (default contour) keeps its own Smart Height controls isolated from Thread Mill', () => {
    // Gate-isolation sanity: Contour now owns a V2 policy panel rather than the
    // retired generic reference-plane selector. Thread-only datum UI must not
    // leak into it.
    seedProjectWithLoops()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Heights'))

    expect(screen.queryByTestId('ref-plane-select')).toBeNull()
    expect(screen.getByTestId('contour-height-policy')).toBeTruthy()
    expect(screen.queryByTestId('thread-datum-line')).toBeNull()
  })

  it('re-opening on Thread Mill after closing does not throw (closed->open hook stability)', () => {
    // The closed->open transition is the exact path a misplaced hook would crash
    // on. A bare store closeModal() leaves the modal mounted (it returns null) but
    // does NOT reset the React-local tab state, so each iteration unmounts +
    // remounts for a true fresh closed->open->closed cycle starting on the Type tab.
    seedProjectWithLoops()
    for (let i = 0; i < 2; i++) {
      const { unmount } = render(<NewOperationModal />)
      openModalOnThreadMillPasses()
      expect(screen.getAllByText(/Major diameter/i).length).toBeGreaterThan(0)
      act(() => { useCamStore.getState().closeModal() })
      unmount()
    }
  })
})
