// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineProgram } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  } as never,
}))

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  sendMdiLine,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

const TWO_SECTION_FILE = [
  'G21 G90 G54',
  'G0 X0 Y0 Z10',
  'G1 Z1 F300',
  'G0 Z10',
  'G55',
  'G0 X0 Y0 Z10',
  'G1 Z1 F300',
  'M30',
  '',
].join('\n')

function programFile(name: string, text: string): File {
  const file = new File([text], name, { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: async () => text })
  return file
}

function program(moveCount: number): MachineProgram {
  const steps: MachineProgram['steps'] = Array.from({ length: moveCount }, (_, index) => ({
    id: index + 1,
    kind: 'line' as const,
    rapid: index % 5 === 0 ? true : undefined,
    to: { x: index % 500, y: Math.floor(index / 500), z: index % 5 === 0 ? 5 : -1 },
    feedMmMin: index % 5 === 0 ? 3000 : 500,
  }))
  return { frame: 'work', units: 'mm', steps, index: {} }
}

function stageFile(moveCount: number, phase: 'ready' | 'streaming' = 'ready'): void {
  const staged = program(moveCount)
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    machineState: phase === 'streaming' ? 'run' : 'idle',
    homed: true,
    programText: null,
    programContext: null,
    stagedProgram: {
      program: staged,
      setups: [
        { setupName: 'File section 1', wcs: 'G54', firstStepId: 1 },
        ...(moveCount > 4
          ? [{ setupName: 'File section 2', wcs: 'G55' as const, firstStepId: Math.floor(moveCount / 2) + 1 }]
          : []),
      ],
    },
    executingMoveId: null,
    fitTrace: null,
    toolChange: null,
    job: {
      ...useMachineControl.getState().job,
      phase,
      name: 'fusion-liencnc-v2-sample.nc',
      totalLines: moveCount,
      sentLines: phase === 'streaming' ? moveCount : 0,
      ackedLines: 0,
      ackedSourceLine: 0,
      startedAt: phase === 'streaming' ? 1 : null,
    },
  })
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  const machineId = useCamStore.getState().project.machine?.id ?? 'default'
  useMachineActions.setState({
    byMachine: {
      [machineId]: {
        overrides: {},
        custom: [],
        parks: [],
        toolChangeParkId: null,
      },
    },
    macroArrangementByMachine: {},
  })
})

afterEach(cleanup)

describe('WO-1347 opened file listing', () => {
  it('shows the opened file moves and truthful section context', () => {
    stageFile(10)
    render(<ProgramPanel />)

    const list = screen.getByTestId('control-gcode-list')
    expect(list.textContent).toContain('File section 1 in G54')
    expect(list.textContent).toContain('File section 2 in G55')
    expect(list.textContent).toContain('G0 X0 Y0 Z5')
    expect(list.textContent).not.toContain('Load a posted setup')
    expect(screen.getByTestId('control-program-context').textContent).toBe(
      'fusion-liencnc-v2-sample.nc - 2 sections (G54 -> G55)',
    )
    expect(screen.queryByTestId('control-program-name')).toBeNull()
    expect(screen.queryByTestId('control-runfrom-input')).toBeNull()
  })

  it('windows 110,615 moves and follows the controller move id near the end', () => {
    stageFile(110_615, 'streaming')

    const renderStarted = performance.now()
    render(<ProgramPanel />)
    const renderMs = performance.now() - renderStarted
    expect(document.querySelectorAll('.gcode-line').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('.gcode-line').length).toBeLessThanOrEqual(160)

    const updateStarted = performance.now()
    act(() => useMachineControl.getState().setExecutingMoveId(110_601))
    const updateMs = performance.now() - updateStarted
    expect(document.querySelector('.gcode-line-hl')?.textContent).toContain('G0 X100 Y221 Z5')
    expect(document.querySelectorAll('.gcode-line').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('.gcode-line').length).toBeLessThanOrEqual(160)

    console.info(`WO-1347 responsiveness: render=${renderMs.toFixed(1)}ms update=${updateMs.toFixed(1)}ms`)
    expect(renderMs).toBeLessThan(5_000)
    expect(updateMs).toBeLessThan(1_000)
  })

  it('keeps the posted-toolpath listing and executing highlight unchanged', () => {
    stageFile(10, 'streaming')
    useMachineControl.setState((state) => ({
      job: { ...state.job, name: 'Setup 1 + Setup 2 (toolpath)' },
      stagedProgram: state.stagedProgram && {
        ...state.stagedProgram,
        setups: [
          { setupName: 'Setup 1', wcs: 'G54', firstStepId: 1 },
          { setupName: 'Setup 2', wcs: 'G55', firstStepId: 6 },
        ],
      },
    }))
    render(<ProgramPanel />)

    act(() => useMachineControl.getState().setExecutingMoveId(7))
    expect(screen.getByTestId('control-gcode-list').textContent).toContain('Setup 2 in G55')
    expect(document.querySelector('.gcode-line-hl')?.textContent).toContain('G1 X6 Y0 Z-1 F500')
    expect(screen.getByTestId('control-program-context').textContent).toBe('No setup information')
  })
})

describe('WO-1347 opened file load route', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    const connecting = connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(300)
    await connecting
    __resetEstopInterlockForTest()
    if (!getMachineController().home()) throw new Error('simulator refused the homed fixture')
    await vi.advanceTimersByTimeAsync(2_000)
    for (const wcs of ['G54', 'G55'] as const) {
      // WO-2712: both file setups and the MDI control sit inside the sample's
      // stated negative travel instead of placing their positive coordinates off table.
      for (const axis of ['X', 'Y', 'Z'] as const) setWorkOffsetValue(wcs, axis, axis === 'Z' ? -40 : -100)
      await vi.advanceTimersByTimeAsync(200)
    }
    // The simulator supplies a real machine-program implementation; declaring
    // its text capability false gives this fixture the AXBB-E route choice.
    const capabilities = getMachineController().capabilities as { gcodeText: boolean }
    capabilities.gcodeText = false
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const disconnecting = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await disconnecting
    }
    vi.useRealTimers()
  })

  it('publishes both file sections through Open file and keeps MDI out of the listing', async () => {
    render(<ProgramPanel />)
    const input = screen.getByTestId('control-file-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [programFile('two-section.nc', TWO_SECTION_FILE)] },
      })
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10)
    })

    const staged = useMachineControl.getState().stagedProgram
    expect(staged?.setups).toEqual([
      { setupName: 'File section 1', wcs: 'G54', firstStepId: 1 },
      { setupName: 'File section 2', wcs: 'G55', firstStepId: 4 },
    ])
    expect(staged?.program.steps).toHaveLength(5)
    expect(screen.getByTestId('control-gcode-list').textContent).toContain('File section 2 in G55')

    // WO-2234: the MDI line stays out of the listing, and the listing stays
    // the loaded file's - an MDI line never unloads the loaded program.
    expect(sendMdiLine('G0 X5 Y5 Z10')).toBe(true)
    expect(useMachineControl.getState().stagedProgram).toBe(staged)
    expect(screen.getByTestId('control-gcode-list').textContent).toContain('File section 2 in G55')
  })
})
