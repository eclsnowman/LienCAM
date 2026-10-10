// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { makeMachine } from '../post/helpers'
import { DEFAULT_MACHINE_PROBE_DEFAULTS } from '../../lib/machine/toolTable'
import { fmtDim, fmtMachineLength, fmtMachineDiagnostic, type Units } from '../../lib/ui/unitFormat'
import { postedTwoSetupProgram } from './support/twoSetupProgram'
import { programFitSentence } from '../../components/machine/ProgramFitStatusLine'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'

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

vi.mock('../../lib/machine/machineSession', async (original) => {
  const actual = await original<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runZProbeCycle: async () => ({ ok: true, message: 'Fixture setter contact', probedMachineZ: 71.73789 }),
  })
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { useCamStore, controlMachine } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable, saveMachineToolRecord } = await import('../../store/machineToolTableStore')
const session = await import('../../lib/machine/machineSession')

const expectedLength = (mm: number, units: Units) => (units === 'inch' ? mm / 25.4 : mm).toFixed(units === 'inch' ? 3 : 2)

async function settle(ms = 100) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(async () => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  // Public, synthetic travel contains the measured positions without depending
  // on an operator profile. All precision and wire assertions below stay intact.
  const machine = makeMachine({ id: 'precision-fixture', controller: 'grbl',
    probing: { ...DEFAULT_MACHINE_PROBE_DEFAULTS },
    homeConvention: {
      x: { homesToward: 'min', homePositionMm: 0 },
      y: { homesToward: 'min', homePositionMm: 0 },
      z: { homesToward: 'min', homePositionMm: 0 },
    } })
  useCamStore.setState(state => ({
    machineLibrary: [machine],
    appSettings: { ...state.appSettings, defaultMachineId: machine.id },
    project: { ...state.project, machine },
  }))
  useUiPrefs.setState({ machineDisplayUnits: 'mm', machineJogStepMm: 1, machineJogContinuous: false, machineOffsetsCollapsed: false, probeSensingByMachine: {} })
  useMachineToolTable.setState({ byMachine: {} })
  __resetProbingSessionForTest()
  const connected = session.connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(300)
  await connected
  session.__resetEstopInterlockForTest()
  session.getMachineController().setMachinePosition!({ x: 432.51234, y: 12.34567, z: 71.73789 })
  const id = controlMachine(useCamStore.getState()).id
  useMachineToolTable.getState().recordProbedZ(id, 19, 71.73789, 1)
  saveMachineToolRecord(controlMachine(useCamStore.getState()))
  useCamStore.getState().setMachineWorkOffset(id, 'G54', { x: 432.51234 }, 'not-sent')
  session.setWorkOffsetValue('G54', 'X', 432.51234)
  await vi.advanceTimersByTimeAsync(50)
  useMachineControl.setState({ activeTool: 19, activeWcs: 'G54' })
})

afterEach(async () => {
  cleanup()
  const disconnected = session.disconnectMachine()
  await vi.advanceTimersByTimeAsync(300)
  await disconnected
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WO-2474: Control length precision stays at the presentation edge', () => {
  for (const [units, typed, wantedMm, wireMm] of [
    ['mm', '432.514', 432.514, 432.514],
    ['inch', '17.0281', 17.0281 * 25.4, 432.5137],
  ] as const) {
    it(`keeps a quick-card edit that rounds to the existing display in ${units}`, async () => {
      useUiPrefs.setState({ machineDisplayUnits: units })
      render(<ControlPage />)
      await settle(1400)
      fireEvent.click(screen.getByTestId('control-view-offsets'))
      const id = controlMachine(useCamStore.getState()).id
      const storedX = () => useCamStore.getState().machineWorkOffsets[id].G54!.offset.x!
      const input = screen.getByTestId('control-offset-g54-x') as HTMLInputElement
      const shown = expectedLength(432.51234, units)
      const send = vi.spyOn(session.getMachineController(), 'sendCommandAwait')
      expect(input.value).toBe(shown)
      expect(expectedLength(wantedMm, units)).toBe(shown)
      act(() => { input.focus() })
      fireEvent.blur(input)
      await settle(500)
      expect(storedX()).toBe(432.51234)
      expect(send.mock.calls.some(([line]) => line.includes('G10'))).toBe(false)
      act(() => { input.focus() })
      fireEvent.change(input, { target: { value: typed } })
      expect(input.value).toBe(typed)
      fireEvent.blur(input)
      await settle(500)
      expect(storedX()).toBe(wantedMm)
      // The existing text-controller route serializes mm at four decimals;
      // the durable record keeps the exact parsed edit independently.
      expect(send.mock.calls).toContainEqual([`${units === 'inch' ? 'G21 ' : ''}G10 L2 P1 X${wireMm}`])
      expect(useMachineControl.getState().offsets.G54[0]).toBe(wireMm)
      expect((screen.getByTestId('control-offset-g54-x') as HTMLInputElement).value).toBe(shown)
    })
  }

  for (const units of ['mm', 'inch'] as const) {
    it(`formats DRO, both offsets surfaces, setter fields and probe results in ${units}`, async () => {
      useUiPrefs.setState({ machineDisplayUnits: units })
      render(<ControlPage />)
      await settle(1400)
      expect((screen.getByTestId('control-dro-machine-x') as HTMLInputElement).value).toBe(expectedLength(432.51234, units))
      fireEvent.click(screen.getByTestId('control-view-offsets'))
      expect((screen.getByTestId('control-offset-g54-x') as HTMLInputElement).value).toBe(expectedLength(432.51234, units))
      const input = screen.getByTestId('offsets-workspace-g54-x') as HTMLInputElement
      expect(input.value).toBe(expectedLength(432.51234, units))
      act(() => { input.focus() })
      fireEvent.change(input, { target: { value: '12.345678' } })
      expect(input.value).toBe('12.345678')
      fireEvent.blur(input)
      const stored = useCamStore.getState().machineWorkOffsets[controlMachine(useCamStore.getState()).id].G54!.offset.x!
      expect(stored).toBe(units === 'mm' ? 12.345678 : 12.345678 * 25.4)
      expect(input.value).toBe(expectedLength(stored, units))
      fireEvent.click(screen.getByTestId('control-view-tools'))
      expect(document.querySelector('.control-jog-step-readout')?.textContent).toBe(`${expectedLength(1, units)} ${units === 'mm' ? 'mm' : 'in'}`)
      expect((screen.getByTestId('control-tool-len-19') as HTMLInputElement).value).toBe(expectedLength(71.73789, units))
      fireEvent.click(screen.getByTestId('control-view-probing'))
      fireEvent.click(screen.getByTestId('control-work-probe-routine-toolZ'))
      fireEvent.click(screen.getByTestId('control-probe-run-guided'))
      await settle(200)
      expect(screen.getByTestId('control-work-probe-result').textContent).toContain(`machine Z ${expectedLength(71.73789, units)} ${units === 'mm' ? 'mm' : 'in'} on the setter`)
      expect(useMachineToolTable.getState().tableFor(controlMachine(useCamStore.getState()).id).tools.find(t => t.tool === 19)?.probedMachineZ).toBe(71.73789)
    })
  }

  it('keeps posted and sent G-code byte-identical when only display units change', async () => {
    const ctrl = session.getMachineController()
    const send = vi.spyOn(ctrl, 'sendCommand')
    const programs: string[] = []
    const commands: string[][] = []
    for (const units of ['mm', 'inch'] as const) {
      useUiPrefs.setState({ machineDisplayUnits: units })
      programs.push(postedTwoSetupProgram(GRBL_CONFIG).gcode)
      send.mockClear()
      expect(session.applyToolLengthOffset(12.345678)).toBe(true)
      expect(session.clearToolLengthOffset()).toBe(true)
      commands.push(send.mock.calls.map(call => call[0]))
    }
    expect(programs[1]).toBe(programs[0])
    expect(commands[0]).toEqual(['G43.1 Z12.3457', 'G49'])
    expect(commands[1]).toEqual(commands[0])
  })

  it('formats console machine positions in the effective units without changing the datum', () => {
    for (const units of ['mm', 'inch'] as const) {
      useUiPrefs.setState({ machineDisplayUnits: units })
      expect(session.sendMdiLine('G30.1')).toBe(true)
      expect(useMachineControl.getState().consoleLines.at(-1)?.text).toContain(`X ${expectedLength(432.51234, units)} ${units === 'mm' ? 'mm' : 'in'}`)
      expect(session.getMachineController().status().machinePos?.x).toBe(432.51234)
    }
  })

  it('formats refused-jog travel boundaries in the effective units without moving', async () => {
    const ctrl = session.getMachineController()
    const range = session.currentResolvedMachineMotion().envelope.x!
    for (const units of ['mm', 'inch'] as const) {
      useUiPrefs.setState({ machineDisplayUnits: units })
      // Refusal rows are throttled for held jog buttons, independently of units.
      await settle(1100)
      expect(ctrl.jog('X', 10000, 500)).toBe(false)
      const label = units === 'mm' ? 'mm' : 'in'
      expect(useMachineControl.getState().consoleLines.at(-1)?.text).toContain(
        `outside X travel (${expectedLength(range.min, units)} ${label} to ${expectedLength(range.max, units)} ${label})`,
      )
      expect(ctrl.status().machinePos?.x).toBe(432.51234)
    }
  })

  it('formats program and table travel extents in the selected units', () => {
    const fit = {
      state: 'partial' as const, axes: [], offending: [{ axis: 'x' as const, state: 'partial' as const,
        programMin: -12.3456, programMax: 25.4, machineMin: 0, machineMax: 254 }],
    }
    expect(programFitSentence(fit, 'G54', 'mm')).toContain('program -12.35..25.40, table 0.00..254.00 mm')
    expect(programFitSentence(fit, 'G54', 'inch')).toContain('program -0.486..1.000, table 0.000..10.000 in')
  })

  it('formats legacy diagnostic positions and lengths while retaining feeds and angles', () => {
    const text = 'G54 X 25.4 Z -12.3456; deviation 0.127 mm at 1000 mm/min, rotated 12.345 deg'
    expect(fmtMachineDiagnostic(text, 'mm')).toBe('G54 X 25.40 mm Z -12.35 mm; deviation 0.13 mm at 1000 mm/min, rotated 12.345 deg')
    expect(fmtMachineDiagnostic(text, 'inch')).toBe('G54 X 1.000 in Z -0.486 in; deviation 0.005 in at 1000 mm/min, rotated 12.345 deg')
    for (const units of ['mm', 'inch'] as const) {
      expect(fmtMachineDiagnostic('Z 100 mm/min; X 12.345 deg; A 15 deg', units))
        .toBe('Z 100 mm/min; X 12.345 deg; A 15 deg')
    }
  })

  it('keeps CAM dimensions and machine trailing zeros independent', () => {
    for (const [units, machine, cam] of [['mm', '3.17', '3.175'], ['inch', '0.125', '0.1250']] as [Units, string, string][]) {
      expect(fmtMachineLength(3.175, units)).toBe(machine)
      expect(fmtDim(3.175, units)).toBe(cam)
    }
    expect(fmtMachineLength(0, 'mm')).toBe('0.00')
    expect(fmtMachineLength(0, 'inch')).toBe('0.000')
  })
})
