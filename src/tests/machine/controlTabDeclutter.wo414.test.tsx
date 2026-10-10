// @vitest-environment jsdom
//
// WO-414 (Operator 2026-08-21, marked-up Control screenshot). Batch 1 folded the
// three viewport overlay cards and made the transport's two grey sentences
// one status line (WO-2276: only mode changes echo to the console). Batch 2 applied Operator's verdicts on the
// cards: Grid = ONE dropdown (Off, Machine, G54..G59 - "No more than that");
// Intended stock = ONE line lower-right with a show/hide eye, the facts a
// popover above it; the Table card REMOVED - its off-table verdict became one
// amber sentence under the Control strip, then (WO-414, Operator on Chat: "The
// partially outside banner steals vertical pixels. Don't do that. Use
// console for messages.") that sentence was removed too - it is a console
// line only now; INSIDE / homed say nothing here.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const harness = vi.hoisted(() => ({ instances: [] as Array<{ setIntendedStock: ReturnType<typeof vi.fn> }> }))

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    static MOVE_PICK_TOLERANCE_PX = 8
    static LOOP_HIGHLIGHT_RENDER_ORDER = 95
    static BREP_EDGE_PICK_TOLERANCE_PX = 10
    static BREP_PICK_COLOR_BASE = 0
    static BREP_HOVER_COLOR_BASE = 0
    static Z2D = 0.3
    static NEST_Z2D = 0.3
    static ZERO_PREVIEW_OUTLINE_RADIUS = 4
    static ZERO_PREVIEW_FILL_RADIUS = 2.6
    constructor() { harness.instances.push(this as unknown as { setIntendedStock: ReturnType<typeof vi.fn> }) }
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  },
}))

Object.defineProperty(globalThis, 'requestAnimationFrame', { value: vi.fn(() => 1), configurable: true })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const {
  ControlStepRow,
  SINGLE_BLOCK_STATUS,
  deriveTransportStatusLine,
  resetTransportStatusConsole,
} = await import('../../components/machine/ControlTransportBar')
const { INTENDED_STOCK_HIDDEN_KEY } = await import('../../components/machine/ProgramPreview')
const { resetProgramFitConsole } = await import('../../components/machine/ProgramFitStatusLine')
const { PROGRAM_PREVIEW_GRID_STORAGE_KEY } = await import('../../components/machine/ProgramPreviewGridControl')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

const PROGRAM = 'G21 G90 G54\nG0 X0 Y0 Z5\nG1 Z-16 F300\nG1 X80 Y0 F800\nG1 X80 Y60\nG1 X0 Y60\nG1 X0 Y0\nG0 Z5\nM30\n'

/** These preview assertions deliberately exercise a negative machine frame.
 * Select that machine explicitly instead of inheriting the seeded LienCNC
 * controller definition and its unrelated positive soft limits. */
function setPreviewState(offsetG54: number[]) {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      machine: {
        ...s.project.machine,
        id: 'wo414-negative-preview-machine',
        name: 'WO-414 negative preview fixture',
        controller: 'grbl',
        controllerDefinition: undefined,
        unsentSettings: undefined,
        travel: { x: 738, y: 724.5, z: 128.9 },
        homeConvention: {
          x: { homesToward: 'max' as const, machineZeroAt: 'max' as const },
          y: { homesToward: 'max' as const, machineZeroAt: 'max' as const },
          z: { homesToward: 'max' as const, machineZeroAt: 'max' as const },
        },
        noHomingSwitches: false,
      },
    },
  }))
  useMachineControl.setState({
    programText: PROGRAM,
    programContext: null,
    job: { ...useMachineControl.getState().job, name: 'part.nc' },
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    activeWcs: 'G54',
    offsets: { G54: offsetG54 },
    settings: { 130: '738.000', 131: '724.500', 132: '128.900' },
    homed: true,
  })
}

function resetPrefs() {
  useUiPrefs.setState({ collapsedPropsGroups: {} })
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  resetPrefs()
  resetTransportStatusConsole()
  resetProgramFitConsole()
  harness.instances.length = 0
})
afterEach(cleanup)

describe('WO-414 batch 2: Grid = one dropdown, Intended stock = one line lower-right, Table card gone', () => {
  it('Grid: ONE select with exactly Off / Machine / G54..G59; no chevron, no card body, no caption; the choice persists', () => {
    setPreviewState([-400, -400, -20])
    render(<ProgramPreview />)
    const select = screen.getByTestId('program-preview-grid-label') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Off', 'Machine', 'G54', 'G55', 'G56', 'G57', 'G58', 'G59'])
    expect(screen.queryByTestId('program-preview-grid-toggle')).toBeNull()
    expect(screen.queryByTestId('program-preview-grid-summary')).toBeNull()
    expect(screen.queryByTestId('program-preview-grid-caption')).toBeNull()
    // The whole control is the select: nothing else inside the card.
    expect(screen.getByTestId('program-preview-grid-control').children).toHaveLength(1)
    fireEvent.change(select, { target: { value: 'G57' } })
    expect(select.value).toBe('G57')
    expect(localStorage.getItem(PROGRAM_PREVIEW_GRID_STORAGE_KEY)).toBe('G57')
    fireEvent.change(select, { target: { value: 'off' } })
    expect(localStorage.getItem(PROGRAM_PREVIEW_GRID_STORAGE_KEY)).toBe('off')
  })

  it('Table: no card in the viewport; INSIDE says nothing anywhere; a travel mismatch keeps one amber line', () => {
    setPreviewState([-400, -400, -20])
    render(<ProgramPreview />)
    expect(screen.queryByTestId('program-preview-envelope')).toBeNull()
    expect(screen.queryByTestId('program-preview-envelope-summary')).toBeNull()
    expect(screen.queryByTestId('control-program-fit')).toBeNull()
    expect(screen.queryByTestId('program-preview-envelope-mismatch')).toBeNull()
    cleanup()
    // The controller disagrees with the Machine Library on X travel: the one
    // fact the Table card showed that lives nowhere else stays, as one line.
    useMachineControl.setState({ settings: { 130: '700.000', 131: '724.500', 132: '128.900' } })
    render(<ProgramPreview />)
    expect(screen.getByTestId('program-preview-envelope-mismatch').textContent).toContain('X travel: Machine Library 738.00 mm, controller 700.00 mm')
  })

  it('Table: a program off the table is a console line only, no banner and no card', () => {
    // WO-1999: an all-zero G54 is "no work zero yet" and stays silent; a real
    // work zero past machine zero puts the program off the table.
    setPreviewState([10, 10, 0])
    useMachineControl.setState({ consoleLines: [] })
    render(<ProgramPreview />)
    expect(screen.queryByTestId('program-preview-envelope')).toBeNull()
    // No amber banner anywhere (WO-414: "use console for messages").
    expect(screen.queryByTestId('control-program-fit')).toBeNull()
    expect(screen.queryAllByRole('status')).toHaveLength(0)
    const lines = useMachineControl.getState().consoleLines
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toMatch(/^OUTSIDE - Program \(after G54\) lies entirely off the table on X, Y/)
    expect(lines[0].severity).toBe('error')
  })

  it('Intended stock: one line lower-right (badge, setup, help link, eye); clicking the line opens the facts as a popover above it; Escape closes', () => {
    setPreviewState([-400, -400, -20])
    render(<ProgramPreview />)
    const card = screen.getByTestId('program-preview-intended-stock')
    expect(card.className).toContain('control-overlay-bottom-right')
    expect(card.className).not.toContain('control-overlay-top-left')
    expect(card.getAttribute('data-expanded')).toBe('false')
    expect(screen.getByTestId('program-preview-intended-stock-summary').textContent).toBe('Intended stock - NONE')
    expect(screen.getByTestId('program-preview-intended-stock-badge').textContent).toBe('NONE')
    expect(screen.getByTestId('program-preview-intended-stock-help')).toBeTruthy()
    expect(screen.getByTestId('program-preview-intended-stock-visible')).toBeTruthy()
    expect(screen.queryByTestId('program-preview-intended-stock-toggle')).toBeNull()
    expect(screen.queryByTestId('program-preview-intended-stock-body')).toBeNull()

    fireEvent.click(screen.getByTestId('program-preview-intended-stock-summary'))
    expect(card.getAttribute('data-expanded')).toBe('true')
    const body = screen.getByTestId('program-preview-intended-stock-body')
    expect(body.className).toContain('control-intended-stock-popover')
    expect(screen.getByTestId('program-preview-intended-stock-note').textContent).toContain('No intended stock information')
    // The popover is transient: nothing written to the persisted record.
    expect(useUiPrefs.getState().collapsedPropsGroups).toEqual({})

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(card.getAttribute('data-expanded')).toBe('false')
    expect(screen.queryByTestId('program-preview-intended-stock-body')).toBeNull()
    // The line toggles too.
    fireEvent.click(screen.getByTestId('program-preview-intended-stock-summary'))
    expect(card.getAttribute('data-expanded')).toBe('true')
    fireEvent.click(screen.getByTestId('program-preview-intended-stock-summary'))
    expect(card.getAttribute('data-expanded')).toBe('false')
  })

  it('Intended stock: the eye hides / shows the box in the scene, default shown, remembered in the shared persisted record', async () => {
    // A real setup context so a box exists to draw.
    useMachineControl.setState({
      programContext: {
        version: 1,
        setup: { id: 's1', name: 'Top' },
        wcs: { fixtureOffset: 54, label: 'G54', origin: { x: 0, y: 0, z: 0 } },
        stock: { id: 'k1', name: 'Block', material: null, mode: 'explicit', coordinateSpace: 'world', position: { x: 0, y: 0, z: 0 }, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } } },
        intent: { digest: 'x', toolDigest: 'x', postDigest: 'x' },
        postedAt: 0,
      } as unknown as ReturnType<typeof useMachineControl.getState>['programContext'],
    })
    render(<ProgramPreview />)
    await act(async () => {})
    const vp = harness.instances[0]
    const last = () => vp.setIntendedStock.mock.calls.at(-1)?.[0]
    expect(last()).toMatchObject({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } })
    const eye = screen.getByTestId('program-preview-intended-stock-visible')
    expect(eye.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('program-preview-intended-stock').getAttribute('data-stock-visible')).toBe('true')

    fireEvent.click(eye)
    await act(async () => {})
    expect(last()).toBeNull()
    expect(eye.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('program-preview-intended-stock').getAttribute('data-stock-visible')).toBe('false')
    expect(useUiPrefs.getState().collapsedPropsGroups[INTENDED_STOCK_HIDDEN_KEY]).toBe(true)
    // The line itself still says what the stock is.
    expect(screen.getByTestId('program-preview-intended-stock-summary').textContent).toContain('Top (G54)')

    fireEvent.click(eye)
    await act(async () => {})
    expect(last()).toMatchObject({ max: { x: 10, y: 10, z: 10 } })
    expect(useUiPrefs.getState().collapsedPropsGroups[INTENDED_STOCK_HIDDEN_KEY]).toBe(false)
  })
})

describe('WO-414 / WO-2276: one status line under the transport; console reports mode changes', () => {
  const reArmIdle = { offered: true, enabled: true, detail: 'Arm this program again from its first line.' }
  const reArmRunning = { offered: true, enabled: false, detail: 'The program is still running - Feed Hold, then Stop/Reset, before re-arming.' }

  it('picks ONE sentence: step-back result > re-arm reason > single-block mode', () => {
    expect(deriveTransportStatusLine({ singleBlock: false, reArm: reArmIdle, reArming: false, stepBack: null }))
      .toMatchObject({ kind: 'single-block', text: SINGLE_BLOCK_STATUS.off, testId: 'control-singleblock-mode' })
    expect(deriveTransportStatusLine({ singleBlock: true, reArm: reArmIdle, reArming: false, stepBack: null }))
      .toMatchObject({ kind: 'single-block', text: SINGLE_BLOCK_STATUS.on })
    expect(deriveTransportStatusLine({ singleBlock: false, reArm: reArmRunning, reArming: false, stepBack: null }))
      .toMatchObject({ kind: 'rearm', text: reArmRunning.detail, testId: 'control-rearm-reason' })
    // While the controller is resetting the button says so itself - no reason line.
    expect(deriveTransportStatusLine({ singleBlock: false, reArm: reArmRunning, reArming: true, stepBack: null }).kind)
      .toBe('single-block')
    expect(deriveTransportStatusLine({
      singleBlock: true, reArm: reArmRunning, reArming: false,
      stepBack: { plan: { startLine: 12, warnings: [] }, error: null },
    })).toMatchObject({ kind: 'step-back', text: 'Back armed line 12. Review the run-from plan, then press CYCLE START.' })
    expect(deriveTransportStatusLine({
      singleBlock: true, reArm: reArmIdle, reArming: false,
      stepBack: { plan: null, error: 'nothing to step back to' },
    })).toMatchObject({ kind: 'step-back', text: 'Back refused: nothing to step back to' })
  })

  it('the STEP row renders exactly one status line, and a mode flip writes one console line (never on first paint)', () => {
    useMachineControl.setState({ consoleLines: [], singleBlock: false })
    render(<ControlStepRow />)
    const line = screen.getByTestId('control-singleblock-explainer')
    expect(line.getAttribute('data-status-kind')).toBe('single-block')
    expect(line.textContent).toContain('CYCLE START runs it all')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(useMachineControl.getState().consoleLines).toEqual([])

    act(() => { useMachineControl.setState({ singleBlock: true }) })
    expect(screen.getByTestId('control-singleblock-mode').textContent).toBe(SINGLE_BLOCK_STATUS.on)
    const lines = useMachineControl.getState().consoleLines
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ text: SINGLE_BLOCK_STATUS.on, severity: 'info' })

    // The same sentence again (re-render, second mount) never writes twice.
    act(() => { useMachineControl.setState({ singleBlock: true }) })
    render(<ControlStepRow />)
    expect(useMachineControl.getState().consoleLines).toHaveLength(1)
  })
})
