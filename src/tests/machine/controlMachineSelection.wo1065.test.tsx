// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MachineConfig } from '../../types'
import type { JogAxis, MachineController } from '../../lib/machine/controller'
import type { ProbeRoutine } from '../../lib/machine/probeRoutineFormat'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: vi.fn(() => 1), configurable: true, writable: true,
})
Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  value: vi.fn(), configurable: true, writable: true,
})

vi.mock('../../components/machine/ProbeRoutineEditor', () => typedMock<typeof import('../../components/machine/ProbeRoutineEditor')>({
  ProbeRoutineEditor: ({ probe, axisLimits }) => (
    <div
      data-testid="wo1065-probe-routine-machine"
      data-fast-feed={probe.fastFeed}
      data-x-rapid={axisLimits?.x.maxRapid ?? ''}
    />
  ),
}))

const { default: App } = await import('../../App')
const { controlMachine, controlMachineSelection, persistPartialize, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { createDefaultControllerDefinition, withMachineSafeZ } = await import('../../types')
const { ControlPage } = await import('../../components/machine/ControlPage')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { JogPanel } = await import('../../components/machine/JogPanel')
const { MacroEditor } = await import('../../components/machine/MacroEditor')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { MachineActionsModal } = await import('../../components/machine/MachineActionsModal')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { ProbeRoutineRunPanel } = await import('../../components/machine/ProbeRoutineRunPanel')
const { ProbeRoutinesTab } = await import('../../components/machine/ProbeRoutinesTab')
const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { deriveMachineEnvelopeFromConvention } = await import('../../lib/machine/machineEnvelope')
const { expandProbeRoutine } = await import('../../lib/machine/probeRoutineExpand')
const { resolveProbeConfig } = await import('../../lib/machine/toolTable')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { SpindlePanel } = await import('../../components/machine/SpindlePanel')
const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const { ToolGlance } = await import('../../components/machine/ToolGlance')
const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { controlConnectionKinds } = await import('../../components/machine/ControlPage')
const { executePendantMachineCommand } = await import('../../lib/machine/pendantMachine')
const { programIntentIdentity } = await import('../../lib/machine/programContext')
const {
  BridgeTransport,
  bridgeUrl,
  vfdPortLinkState,
} = await import('../../lib/machine/bridgeTransport')
const session = await import('../../lib/machine/machineSession')

const CONTROL_COMPONENT_DIR = 'src/components/machine'
const CONTROL_LIBRARY_DIR = 'src/lib/machine'

const CAM_MACHINE: MachineConfig = {
  id: 'wo1065-cam',
  name: 'CAM GRBL Router',
  type: 'gantry_router',
  controller: 'grbl',
  travel: { x: 400, y: 300, z: 80 },
  rapidRate: 3200,
  maxSpindleRpm: 18000,
  minSpindleRpm: 6000,
  spindleDirection: 'cw',
  toolChanger: 'manual',
  coolant: false,
  probing: {
    positioningFeed: 1000, fastFeed: 111, slowFeed: 50,
    retract: 2, maxTravel: 50, surfaceClearance: 5,
    overtravel: 5, crossOverLift: 10, padThickness: 10,
  },
  axisLimits: {
    x: { maxCutting: 1100, maxRapid: 1200 },
    y: { maxCutting: 1100, maxRapid: 1200 },
    z: { maxCutting: 500, maxRapid: 600 },
  },
  notes: '',
}

const CONTROL_MACHINE: MachineConfig = {
  ...CAM_MACHINE,
  id: 'wo1065-control',
  name: 'Control UCCNC Router',
  controller: 'uccnc',
  travel: { x: 738, y: 724.5, z: 128.9 },
  rapidRate: 5000,
  maxSpindleRpm: 12345,
  probing: {
    positioningFeed: 1000, fastFeed: 777, slowFeed: 50,
    retract: 2, maxTravel: 50, surfaceClearance: 5,
    overtravel: 5, crossOverLift: 10, padThickness: 10,
  },
  axisLimits: {
    x: { maxCutting: 4100, maxRapid: 4200 },
    y: { maxCutting: 4100, maxRapid: 4200 },
    z: { maxCutting: 900, maxRapid: 1000 },
  },
  homeConvention: {
    x: { homesToward: 'max', machineZeroAt: 'min' },
    y: { homesToward: 'max', machineZeroAt: 'min' },
    z: { homesToward: 'max', machineZeroAt: 'min' },
  },
  controllerDefinition: (() => {
    const definition = createDefaultControllerDefinition()
    definition.homing.order = ['Y', 'X', 'Z']
    definition.axes.forEach((axis, index) => {
      axis.homePin = { port: 1, pin: index + 1, negate: false }
    })
    return definition
  })(),
}

let originalLibrary: MachineConfig[]
let originalProjectMachine: MachineConfig
let originalActions: ReturnType<typeof useMachineActions.getState>['byMachine']
let originalArrangements: ReturnType<typeof useMachineActions.getState>['macroArrangementByMachine']
let originalToolTables: ReturnType<typeof useMachineToolTable.getState>['byMachine']

beforeEach(() => {
  vi.restoreAllMocks()
  session.__resetEstopInterlockForTest()
  session.__resetCamMovedNoticeForTest()
  originalLibrary = useCamStore.getState().machineLibrary
  originalProjectMachine = useCamStore.getState().project.machine
  originalActions = useMachineActions.getState().byMachine
  originalArrangements = useMachineActions.getState().macroArrangementByMachine
  originalToolTables = useMachineToolTable.getState().byMachine
  useCamStore.setState((state) => ({
    machineLibrary: [...originalLibrary, CAM_MACHINE, CONTROL_MACHINE],
    project: { ...state.project, machine: CAM_MACHINE },
    control: { activeMachineId: null, sessionMachine: null },
    workspace: 'cam',
  }))
  useMachineControl.setState((state) => ({
    connectionPhase: 'disconnected',
    connectionKind: null,
    connectionDetail: null,
    machineState: 'unknown',
    homed: false,
    mpos: null,
    wpos: null,
    settings: {},
    programText: null,
    programContext: null,
    activeTool: null,
    consoleLines: [],
    job: { ...state.job, phase: 'empty', name: null },
  }))
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useMachineToolTable.setState({ byMachine: {} })
  // Safe Z lives on the record now (WO-1702); reset the shared fixtures so a
  // value one behavior sets never leaks into the next.
  CAM_MACHINE.safeZMachine = undefined
  CONTROL_MACHINE.safeZMachine = undefined
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await act(async () => { await session.disconnectMachine() })
  }
  useCamStore.setState((state) => ({
    machineLibrary: originalLibrary,
    project: { ...state.project, machine: originalProjectMachine },
    control: { activeMachineId: null, sessionMachine: null },
    workspace: 'cam',
  }))
  useMachineActions.setState({
    byMachine: originalActions,
    macroArrangementByMachine: originalArrangements,
  })
  useMachineToolTable.setState({ byMachine: originalToolTables })
  session.__resetEstopInterlockForTest()
  session.__resetCamMovedNoticeForTest()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function mountControl(): Promise<void> {
  render(<App />)
  fireEvent.click(screen.getByTestId('mode-tab-control'))
  await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
}

function selectControlMachine(): void {
  useCamStore.getState().setControlMachineId(CONTROL_MACHINE.id)
  expect(useCamStore.getState().project.machine).toBe(CAM_MACHINE)
  expect(controlMachine(useCamStore.getState())).toBe(CONTROL_MACHINE)
}

/** The SAME resolved machine as `selectControlMachine`, reached the other way:
 *  Follow CAM was selected, a session pinned CONTROL_MACHINE, and CAM then
 *  moved to CAM_MACHINE underneath it. Every reader must still be on
 *  CONTROL_MACHINE, which is why the whole behaviour table is driven twice -
 *  a reader that consults raw state instead of the resolver passes the first
 *  pass and fails this one. */
function pinSessionToControlMachineWhileCamMoves(): void {
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: CONTROL_MACHINE },
    control: { activeMachineId: null, sessionMachine: null },
  }))
  useCamStore.getState().setControlSessionMachine(CONTROL_MACHINE)
  useCamStore.getState().setProjectMachine(CAM_MACHINE)
  expect(useCamStore.getState().control.activeMachineId).toBeNull()
  expect(useCamStore.getState().project.machine).toBe(CAM_MACHINE)
  expect(controlMachine(useCamStore.getState())).toMatchObject({ id: CONTROL_MACHINE.id })
  useMachineControl.setState({ consoleLines: [] })
}

class ReaderFakeSocket {
  static OPEN = 1
  static last: ReaderFakeSocket | null = null
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { reason: string }) => void) | null = null
  sent: string[] = []
  readonly url: string

  constructor(url: string) {
    this.url = url
    ReaderFakeSocket.last = this
  }

  open(): void {
    this.readyState = ReaderFakeSocket.OPEN
    this.onopen?.()
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {}
}

type ReaderBehavior = {
  path: string
  prove: () => void | Promise<void>
}

const CONTROL_MACHINE_BEHAVIORS: ReaderBehavior[] = [
  {
    path: 'src/components/machine/ControlPage.tsx',
    prove: () => {
      render(<ControlPage />)
      expect(screen.getByText(`Connect to ${CONTROL_MACHINE.name} or simulate it to begin.`)).toBeTruthy()
    },
  },
  {
    path: 'src/components/machine/ControlTransportBar.tsx',
    prove: () => {
      // The CHECKED row names the resolved machine, whichever way it was
      // resolved: an explicit pick renders its library row, a pinned Follow
      // CAM renders the follow row naming the same machine. Which row that is
      // belongs to the mode, and the four selector cases below own it.
      render(<ControlTransportBar sections="nav" />)
      const select = screen.getByTestId('control-machine-select') as HTMLSelectElement
      expect(select.selectedOptions[0].text).toContain(CONTROL_MACHINE.name)
    },
  },
  {
    path: 'src/components/machine/JogPanel.tsx',
    prove: async () => {
      // WO-1702: Safe Z is one field on the machine record, never a value
      // stored separately with the wiring - `Object.assign` keeps the
      // fixtures' identity (`toBe(CONTROL_MACHINE)` elsewhere in this file)
      // while writing through the one function every editor uses.
      Object.assign(CAM_MACHINE, withMachineSafeZ(CAM_MACHINE, 12))
      Object.assign(CONTROL_MACHINE, withMachineSafeZ(CONTROL_MACHINE, 91))
      vi.useFakeTimers()
      const pending = session.connectMachine('simulator')
      await vi.advanceTimersByTimeAsync(300)
      await pending
      // Operator 2026-09-14 ("A: Flash, all motion off"): this behavior is about
      // per-machine tooltip content, not the E-STOP latch - clear it so the
      // tooltip reads the safe-Z/homing wording under test.
      session.__resetEstopInterlockForTest()
      useMachineControl.setState({ homed: true, machineState: 'idle' })
      render(<JogPanel />)
      expect(screen.getByTestId('control-safez').getAttribute('data-tooltip')).toContain('machine Z91')
      expect(screen.getByTestId('control-home').getAttribute('data-tooltip')).toContain('Y, X, Z')
    },
  },
  {
    path: 'src/components/machine/MachineActionsModal.tsx',
    prove: () => {
      // WO-1707: user buttons moved to the macro editor - what this modal
      // still owns per machine is the built-in override table. `setOverride`
      // writes onto the machine RECORD (WO-1676), so only the Control
      // machine is touched here - touching CAM_MACHINE would break its own
      // identity check elsewhere in this table.
      useMachineActions.getState().setOverride(CONTROL_MACHINE.id, 'coolantMist', ['M200'])
      render(<MachineActionsModal open onClose={() => {}} />)
      expect(screen.getByText(/Machine actions - Control UCCNC Router/)).toBeTruthy()
      expect((screen.getByTestId('control-action-coolantMist') as HTMLTextAreaElement).value).toBe('M200')
    },
  },
  {
    path: 'src/components/machine/definition/useMachineDefinitionPanel.tsx',
    prove: () => {
      render(<MachineDefinitionPanel />)
      expect(screen.getByTestId('machine-definition-panel').getAttribute('data-machine-id'))
        .toBe(CONTROL_MACHINE.id)
    },
  },
  {
    path: 'src/components/machine/MacroPanel.tsx',
    prove: () => {
      // WO-1707: user buttons are macros on the machine record now (a
      // pre-1707 custom button is moved there once, on load).
      useCamStore.getState().updateMachineInLibrary(CAM_MACHINE.id, {
        macros: [{ id: 'cam-macro', name: 'CAM macro', body: 'lines("M8")' }],
      })
      useCamStore.getState().updateMachineInLibrary(CONTROL_MACHINE.id, {
        macros: [{ id: 'control-macro', name: 'CONTROL macro', body: 'lines("M9")', color: 'cyan' }],
      })
      render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
      expect(screen.getByText('CONTROL macro')).toBeTruthy()
      expect(screen.queryByText('CAM macro')).toBeNull()
    },
  },
  {
    path: 'src/components/machine/MacroEditor.tsx',
    prove: () => {
      useCamStore.getState().updateMachineInLibrary(CAM_MACHINE.id, {
        macros: [{ id: 'cam-macro', name: 'CAM macro', body: "line('M8')" }],
      })
      useCamStore.getState().updateMachineInLibrary(CONTROL_MACHINE.id, {
        macros: [{ id: 'control-macro', name: 'CONTROL macro', body: "line('M9')" }],
      })
      render(<MacroEditor open onClose={() => {}} />)
      expect(screen.getByText(new RegExp(`Edit macros - ${CONTROL_MACHINE.name}`))).toBeTruthy()
      expect(screen.getByText('CONTROL macro')).toBeTruthy()
      expect(screen.queryByText('CAM macro')).toBeNull()
    },
  },
  {
    // WO-1370: the tool-length Confirm button reads the tool table for
    // whichever machine Control is driving, through `controlMachine` -
    // proved here by adding the probed tool only to CONTROL_MACHINE's
    // table and seeing Confirm enable against it.
    path: 'src/components/machine/ProbeRoutineRunPanel.tsx',
    prove: async () => {
      useMachineToolTable.getState().addTool(CONTROL_MACHINE.id, 7)
      const ctrl = session.getMachineController()
      const baseStatus = ctrl.status()
      let pos = { x: 100, y: 100, z: 40 }
      vi.spyOn(ctrl, 'connectionPhase').mockReturnValue('connected')
      vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(false)
      vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
      vi.spyOn(ctrl, 'homedThisSession').mockReturnValue(true)
      vi.spyOn(
        ctrl as MachineController & { homedAxesThisSession(): Partial<Record<JogAxis, boolean>> },
        'homedAxesThisSession',
      ).mockReturnValue({ X: true, Y: true, Z: true })
      vi.spyOn(ctrl, 'refreshState').mockReturnValue(true)
      vi.spyOn(ctrl, 'queryStatus').mockReturnValue(undefined)
      vi.spyOn(ctrl, 'verifiedIdle').mockReturnValue(true)
      vi.spyOn(ctrl, 'status').mockImplementation(() => ({
        ...baseStatus, state: 'idle', machinePos: { ...pos }, workPos: { ...pos },
      }))
      vi.spyOn(ctrl, 'jog').mockImplementation((axis, delta) => {
        const key = axis.toLowerCase() as 'x' | 'y' | 'z'
        pos = { ...pos, [key]: pos[key] + delta }
        return true
      })
      vi.spyOn(ctrl, 'probe').mockImplementation(async () => {
        pos = { ...pos, z: 12.3456 }
        return { ok: true, at: { ...pos } }
      })

      const envelope = deriveMachineEnvelopeFromConvention(
        {
          x: { homesToward: 'min', machineZeroAt: 'min' },
          y: { homesToward: 'min', machineZeroAt: 'min' },
          z: { homesToward: 'min', machineZeroAt: 'min' },
        },
        { x: 300, y: 300, z: 100 },
      )
      const probeCfg = resolveProbeConfig(null, {
        positioningFeed: 1200, fastFeed: 300, slowFeed: 40, retract: 2, maxTravel: 30,
        surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10,
      })
      const routine: ProbeRoutine = {
        schemaVersion: 1,
        id: 'wo1065.tool-length',
        name: 'WO-1065 tool-length reader',
        version: '1.0.0',
        provenance: { kind: 'user' },
        description: 'Touch a fixed pad and record the tool length.',
        requires: { homed: true, envelope: 'full', probe: 'touch' },
        inputs: [],
        steps: [
          { kind: 'touch', name: 'pad', axis: 'Z', direction: '-', searchMm: 20 },
        ],
        outputs: [
          { kind: 'toolLength', tool: 7, machineZ: 'touch.pad.z', label: 'Record tool length' },
        ],
      }
      const result = expandProbeRoutine(routine, {}, {
        start: { ...pos }, envelope, probe: probeCfg, tipRadiusMm: 1.5, activeWcs: 'G54',
      })
      if (!result.ok) throw new Error(`expand failed: ${JSON.stringify(result.errors)}`)

      render(
        <ProbeRoutineRunPanel
          expanded={result.expanded}
          stale={false}
          probe={probeCfg}
          envelope={envelope}
          activeWcs="G54"
          units="mm"
        />,
      )
      fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
      await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-run')) })
      await waitFor(() => expect(screen.getByTestId('probe-routine-run-result')).toBeTruthy(), { timeout: 5_000 })

      const confirmBtn = screen.getByTestId('probe-routine-confirm-tool-length') as HTMLButtonElement
      expect(confirmBtn.disabled).toBe(false)
      expect(confirmBtn.title).toContain('T7')
    },
  },
  {
    path: 'src/components/machine/ProbeRoutinesTab.tsx',
    prove: () => {
      render(<ProbeRoutinesTab />)
      expect(screen.getByTestId('wo1065-probe-routine-machine')).toMatchObject({
        dataset: { fastFeed: '777', xRapid: '4200' },
      })
    },
  },
  {
    path: 'src/components/machine/ProbingPanel.tsx',
    prove: () => {
      useMachineControl.setState({
        connectionPhase: 'connected',
        connectionKind: 'simulator',
        machineState: 'idle',
        homed: true,
        mpos: { x: 100, y: 100, z: 50 },
        wpos: { x: 100, y: 100, z: 50 },
        settings: { 130: '738.000', 131: '724.500', 132: '128.900' },
      })
      render(<ProbingPanel />)
      // WO-2063 (v2 brief): the feeds are in the probe step's More, not a
      // plan-feeds line. Edge's probe step is step 7.
      fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
      fireEvent.click(screen.getByTestId('probing-step-chip-7'))
      fireEvent.click(screen.getByTestId('probing-more-toggle'))
      expect(screen.getByTestId('probing-more').textContent).toContain('Search: 777 mm/min until it touches')
    },
  },
  {
    path: 'src/components/machine/ProgramPanel.tsx',
    prove: () => {
      Object.assign(CONTROL_MACHINE, withMachineSafeZ(CONTROL_MACHINE, 91))
      useMachineControl.setState({
        connectionPhase: 'connected', machineState: 'idle', homed: true,
        programText: 'G21\nG0 X0 Y0\n',
      })
      render(<ProgramPanel />)
      expect(screen.getByTestId('control-fittrace').getAttribute('data-tooltip')).toMatch(/Trace the job/i)
    },
  },
  {
    path: 'src/components/machine/ProgramPreview.tsx',
    prove: () => {
      useMachineControl.setState({
        connectionPhase: 'connected', connectionKind: 'serial', homed: true,
        settings: { 130: '400.000', 131: '300.000', 132: '80.000' },
      })
      render(<ProgramPreview />)
      const mismatch = screen.getByTestId('program-preview-envelope-mismatch').textContent ?? ''
      expect(mismatch).toContain('Machine Library 738.00 mm, controller 400.00 mm')
      expect(mismatch).not.toContain('Machine Library 400.00 mm, controller 400.00 mm')
    },
  },
  {
    // WO-1042: the stored work offset is per MACHINE, so the panel must read
    // the machine Control is driving. Keying it off the CAM setup would show
    // - and let an operator act on - another machine's remembered work zero.
    path: 'src/components/machine/OffsetsPanel.tsx',
    prove: () => {
      // WO-1182: the stored value is no longer shown as a second number; the
      // only trace of the per-machine record is the provenance marker, so the
      // CAM machine's record is left NOT-SENT and the Control machine's SENT.
      useCamStore.getState().setMachineWorkOffset(CAM_MACHINE.id, 'G54', { x: 11.111 }, 'not-sent')
      useCamStore.getState().setMachineWorkOffset(CONTROL_MACHINE.id, 'G54', { x: 22.222 }, 'sent')
      useMachineControl.setState({
        connectionPhase: 'connected', machineState: 'idle',
        activeWcs: 'G54', offsets: { G54: [22.222, 0, 0] },
      })
      render(<OffsetsPanel />)
      const pair = screen.getByTestId('control-offset-g54-x').closest('[data-offset-value-pair]')
      expect(pair?.hasAttribute('data-wired')).toBe(true)
      expect(pair?.hasAttribute('data-not-sent')).toBe(false)
    },
  },
  {
    path: 'src/components/machine/SpindlePanel.tsx',
    prove: () => {
      const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
      expect((container.querySelector('.control-rpm-input') as HTMLInputElement).max).toBe('12345')
    },
  },
  {
    path: 'src/components/machine/ToolGlance.tsx',
    prove: () => {
      useMachineToolTable.getState().addTool(CAM_MACHINE.id, 5)
      useMachineToolTable.getState().updateTool(CAM_MACHINE.id, 5, { note: 'CAM tool' })
      useMachineToolTable.getState().addTool(CONTROL_MACHINE.id, 5)
      useMachineToolTable.getState().updateTool(CONTROL_MACHINE.id, 5, { note: 'CONTROL tool' })
      useMachineControl.setState({ activeTool: 5 })
      render(<ToolGlance onChangeTool={() => {}} />)
      expect(screen.getByText(/CONTROL tool/)).toBeTruthy()
      expect(screen.queryByText(/CAM tool/)).toBeNull()
    },
  },
  {
    path: 'src/components/machine/ToolsProbePanel.tsx',
    prove: () => {
      render(<ToolsProbePanel />)
      expect((screen.getByTestId('control-probe-cfg-fast') as HTMLInputElement).value).toBe('777.0')
    },
  },
  {
    path: 'src/lib/machine/machineSession.ts',
    prove: async () => {
      vi.useFakeTimers()
      const pending = session.connectMachine('simulator')
      await vi.advanceTimersByTimeAsync(300)
      await pending
      session.getMachineController().querySettings()
      await vi.advanceTimersByTimeAsync(10)
      expect(useMachineControl.getState().settings).toMatchObject({
        130: '738.000', 131: '724.500', 132: '128.900',
      })
    },
  },
  {
    path: 'src/lib/machine/pendantMachine.ts',
    prove: async () => {
      // WO-2468: continuous jog no longer reads the machine's travel (it moves
      // through the shared held-jog route). The pendant's macros still read the
      // Control machine: Go XY zero runs at its rapid rate.
      session.__resetEstopInterlockForTest()
      useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
      const ctrl = session.getMachineController()
      vi.spyOn(ctrl as Required<typeof ctrl>, 'homedAxesThisSession').mockReturnValue({ X: true, Y: true, Z: true })
      vi.spyOn(ctrl, 'homedThisSession').mockReturnValue(true)
      const goto = vi.spyOn(ctrl, 'jogToWorkXY').mockReturnValue(true)
      const result = await executePendantMachineCommand(
        { kind: 'macro', id: 'go-xy-zero' },
        { clientId: 'wo1065-reader', emit: vi.fn() },
      )
      expect(result).toEqual({ ok: true })
      expect(goto).toHaveBeenCalledWith(0, 0, CONTROL_MACHINE.rapidRate)
    },
  },
  {
    path: 'src/lib/machine/programContext.ts',
    prove: () => {
      const state = useCamStore.getState()
      const identity = programIntentIdentity(state.project, state.toolLibrary)
      expect(identity).toContain(CAM_MACHINE)
      expect(identity).not.toContain(CONTROL_MACHINE)
    },
  },
  {
    path: 'src/lib/machine/bridgeTransport.ts',
    prove: async () => {
      const target = globalThis as unknown as { WebSocket: unknown }
      const original = target.WebSocket
      target.WebSocket = ReaderFakeSocket as unknown
      try {
        const transport = new BridgeTransport(bridgeUrl(), CONTROL_MACHINE.id)
        const started = transport.start({ onMessage: vi.fn(), onClose: vi.fn() })
        ReaderFakeSocket.last?.open()
        await started
        expect(vfdPortLinkState().machineId).toBe(CONTROL_MACHINE.id)
        await transport.close()
      } finally {
        target.WebSocket = original
      }
    },
  },
]

const CONTROL_COMPONENT_SELECTOR_PATHS = CONTROL_MACHINE_BEHAVIORS
  .map(({ path }) => path)
  .filter((path) => path.startsWith(`${CONTROL_COMPONENT_DIR}/`))
  .sort()

const CONTROL_LIBRARY_SELECTOR_PATHS = CONTROL_MACHINE_BEHAVIORS
  .map(({ path }) => path)
  .filter((path) => path === 'src/lib/machine/machineSession.ts' || path === 'src/lib/machine/pendantMachine.ts')
  .sort()

describe('WO-1065 Control machine ownership', () => {
  it.each(CONTROL_MACHINE_BEHAVIORS)('drives $path with CAM A and Control B', async ({ prove }) => {
    selectControlMachine()
    await prove()
    expect(useCamStore.getState().project.machine).toBe(CAM_MACHINE)
  })

  it.each(CONTROL_MACHINE_BEHAVIORS)(
    'drives $path from the pin while the CAM setup moves away',
    async ({ prove }) => {
      pinSessionToControlMachineWhileCamMoves()
      await prove()
      expect(useCamStore.getState().project.machine).toBe(CAM_MACHINE)
      expect(controlMachine(useCamStore.getState()).id).toBe(CONTROL_MACHINE.id)
    },
  )

  it('censuses every Control component and library selector plus every remaining CAM machine reference', () => {
    const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory()
        ? sourceFiles(join(dir, entry.name)).map((name) => `${entry.name}/${name}`)
        : /\.tsx?$/.test(entry.name) ? [entry.name] : [])
    const componentFiles = sourceFiles(CONTROL_COMPONENT_DIR)
    const selectorPaths = componentFiles
      .filter((name) => /\bcontrolMachine\b/.test(readFileSync(join(CONTROL_COMPONENT_DIR, name), 'utf8')))
      .map((name) => `${CONTROL_COMPONENT_DIR}/${name}`)
      .sort()
    expect(selectorPaths).toEqual(CONTROL_COMPONENT_SELECTOR_PATHS)

    // These are job/setup identity or write-through reads, not operational
    // Control-machine reads. Any new project.machine site in this directory
    // must be classified here instead of silently splitting machine identity.
    const camReferencePaths = componentFiles
      .filter((name) => /project\.machine/.test(readFileSync(join(CONTROL_COMPONENT_DIR, name), 'utf8')))
      .map((name) => `${CONTROL_COMPONENT_DIR}/${name}`)
      .sort()
    expect(camReferencePaths).toEqual([
      'src/components/machine/MachineDefinitionPanel.tsx', // Retained write-through rationale.
      'src/components/machine/ProgramPanel.tsx',
      // WO-1404: the per-setup intended-stock comparison resolves the SAME
      // post identity as ProgramPanel's header (resolveDeclaredController) -
      // the PROJECT's declared machine, because post config is baked into the
      // program's own intent digest at post time, not the pinned control machine.
      'src/components/machine/ProgramPreview.tsx',
      'src/components/machine/definition/useMachineDefinitionPanel.tsx',
    ])
    // WO-1065 attempt 3: ControlTransportBar left this list. The machine
    // selector is the surface both audits caught reading raw state, and it
    // now renders entirely from `controlMachineSelection`.
    expect(camReferencePaths).not.toContain('src/components/machine/ControlTransportBar.tsx')

    const libraryFiles = readdirSync(CONTROL_LIBRARY_DIR).filter((name) => name.endsWith('.ts'))
    const librarySelectorPaths = libraryFiles
      .filter((name) => /\bcontrolMachine\b/.test(readFileSync(join(CONTROL_LIBRARY_DIR, name), 'utf8')))
      .map((name) => `${CONTROL_LIBRARY_DIR}/${name}`)
      .sort()
    expect(librarySelectorPaths).toEqual(CONTROL_LIBRARY_SELECTOR_PATHS)

    const libraryCamReferencePaths = libraryFiles
      .filter((name) => /project\.machine/.test(readFileSync(join(CONTROL_LIBRARY_DIR, name), 'utf8')))
      .map((name) => `${CONTROL_LIBRARY_DIR}/${name}`)
      .sort()
    expect(libraryCamReferencePaths).toEqual([
      'src/lib/machine/machineSession.ts',
      'src/lib/machine/programContext.ts',
    ])
  })

  it('follows CAM until the first Control pick, then stays independent and persists the id', () => {
    expect(controlMachine(useCamStore.getState())).toBe(CAM_MACHINE)

    useCamStore.setState((state) => ({
      project: { ...state.project, machine: CONTROL_MACHINE },
    }))
    expect(controlMachine(useCamStore.getState())).toBe(CONTROL_MACHINE)

    useCamStore.getState().setControlMachineId(CAM_MACHINE.id)
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: CONTROL_MACHINE },
    }))

    expect(controlMachine(useCamStore.getState())).toBe(CAM_MACHINE)
    expect(useCamStore.getState().project.machine).toBe(CONTROL_MACHINE)
    expect(persistPartialize(useCamStore.getState()).control).toEqual({
      activeMachineId: CAM_MACHINE.id,
    })

    useCamStore.getState().setControlMachineId(null)
    expect(controlMachine(useCamStore.getState())).toBe(CONTROL_MACHINE)
    expect(persistPartialize(useCamStore.getState()).control).toEqual({ activeMachineId: null })
  })

  it('filters transports by known capability and preserves all transports for open declarations', () => {
    expect(controlConnectionKinds({ controller: 'uccnc' })).toEqual(['bridge', 'simulator'])
    expect(controlConnectionKinds({ controller: 'grbl' })).toEqual(['serial', 'simulator'])
    // WO-2066: every open declaration keeps its transports except the UCCNC
    // bridge, which is offered to a UCCNC machine and nothing else.
    // WO-2068 + WO-1987: LinuxCNC offers its own gateway, then its simulator.
    expect(controlConnectionKinds({ controller: 'linuxcnc' })).toEqual(['gateway', 'simulator'])
    expect(controlConnectionKinds({ controller: 'generic' })).toEqual(['serial', 'simulator'])
    expect(controlConnectionKinds({ controller: 'legacy-controller' } as unknown as Pick<MachineConfig, 'controller'>))
      .toEqual(['serial', 'simulator'])
  })

  it('filters real transports by the Control machine and labels simulation twice', async () => {
    await mountControl()

    const machineSelect = screen.getByTestId('control-machine-select') as HTMLSelectElement
    expect(machineSelect.value).toBe('')
    expect(machineSelect.selectedOptions[0].text).toContain(`Follow CAM setup (${CAM_MACHINE.name})`)
    expect(machineSelect.selectedOptions[0].text).toContain('simulated')
    expect(Array.from(machineSelect.options).find((option) => option.value === CAM_MACHINE.id)?.text)
      .toContain('same as CAM setup')

    let kinds = screen.getByTestId('control-kind-select') as HTMLSelectElement
    expect(Array.from(kinds.options).map((option) => option.value)).toEqual(['serial', 'simulator'])

    fireEvent.change(machineSelect, { target: { value: CONTROL_MACHINE.id } })
    await waitFor(() => expect((screen.getByTestId('control-kind-select') as HTMLSelectElement).value).toBe('bridge'))

    expect(useCamStore.getState().project.machine).toBe(CAM_MACHINE)
    expect(controlMachine(useCamStore.getState())).toBe(CONTROL_MACHINE)
    kinds = screen.getByTestId('control-kind-select') as HTMLSelectElement
    expect(Array.from(kinds.options).map((option) => option.value)).toEqual(['bridge', 'simulator'])
    // WO-1750: the label names the controller, never a board the definition does not state.
    expect(kinds.options[0].text).toBe('Machine bridge (UCCNC)')

    fireEvent.change(kinds, { target: { value: 'simulator' } })
    expect((screen.getByTestId('control-machine-select') as HTMLSelectElement).selectedOptions[0].text)
      .toContain('simulated')
    // Operator 09-19: the button never repeats "simulated" - the kind select says it.
    expect(screen.getByTestId('control-connect').textContent?.trim()).toBe('Connect')
    expect(kinds.selectedOptions[0].text).toBe(`Simulate ${CONTROL_MACHINE.name}`)
  })

  it('distinguishes following the project copy from explicitly choosing the CAM library record', async () => {
    const projectCopy = { ...CAM_MACHINE, name: 'Project-tuned CAM router', rapidRate: 4321 }
    useCamStore.setState((state) => ({ project: { ...state.project, machine: projectCopy } }))
    await mountControl()

    const machineSelect = screen.getByTestId('control-machine-select') as HTMLSelectElement
    expect(machineSelect.value).toBe('')
    expect(machineSelect.selectedOptions[0].text).toContain('Follow CAM setup (Project-tuned CAM router)')
    expect(controlMachine(useCamStore.getState())).toBe(projectCopy)

    fireEvent.change(machineSelect, { target: { value: CAM_MACHINE.id } })
    expect(useCamStore.getState().control.activeMachineId).toBe(CAM_MACHINE.id)
    expect(controlMachine(useCamStore.getState())).toBe(CAM_MACHINE)
    expect(useCamStore.getState().project.machine).toBe(projectCopy)

    fireEvent.change(machineSelect, { target: { value: '' } })
    expect(useCamStore.getState().control.activeMachineId).toBeNull()
    expect(controlMachine(useCamStore.getState())).toBe(projectCopy)
  })

  it('disconnects the live Control session before publishing another machine selection', async () => {
    await mountControl()
    await connectSimulated()

    fireEvent.change(screen.getByTestId('control-machine-select'), {
      target: { value: CONTROL_MACHINE.id },
    })
    for (let turn = 0; turn < 4; turn++) await Promise.resolve()

    expect(controlMachine(useCamStore.getState())).toBe(CONTROL_MACHINE)
    expect(session.getMachineController().connectionPhase()).toBe('disconnected')
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .not.toMatch(/disconnect first/i)
  })

  it('pins the Follow CAM definition for the live session when the CAM setup machine changes', async () => {
    useMachineActions.getState().addPark(CAM_MACHINE.id, {
      id: 'live-cam-park', label: 'Live CAM park', x: 11, y: 22,
    })
    useMachineActions.getState().addPark(CONTROL_MACHINE.id, {
      id: 'new-cam-park', label: 'New CAM park', x: 33, y: 44,
    })
    vi.useFakeTimers()
    const pending = session.connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(300)
    await pending

    const liveDefinition = useCamStore.getState().control.sessionMachine!
    expect(liveDefinition).toEqual(CAM_MACHINE)
    expect(controlMachine(useCamStore.getState())).toBe(liveDefinition)
    expect(persistPartialize(useCamStore.getState()).control).toEqual({ activeMachineId: null })

    useCamStore.getState().setProjectMachine(CONTROL_MACHINE)

    expect(useCamStore.getState().control.activeMachineId).toBeNull()
    expect(useCamStore.getState().project.machine).toBe(CONTROL_MACHINE)
    expect(controlMachine(useCamStore.getState())).toBe(liveDefinition)
    expect(controlMachine(useCamStore.getState())).toMatchObject({
      id: CAM_MACHINE.id,
      travel: CAM_MACHINE.travel,
      rapidRate: CAM_MACHINE.rapidRate,
      maxSpindleRpm: CAM_MACHINE.maxSpindleRpm,
    })
    expect(controlMachine(useCamStore.getState()).controllerDefinition).toBeUndefined()

    const { container } = render(
      <>
        <MacroPanel onOpenActions={() => {}} rpm={10000} />
        <SpindlePanel onOpenActions={() => {}} />
      </>,
    )
    expect(screen.getByTestId('control-park-live-cam-park')).toBeTruthy()
    expect(screen.queryByTestId('control-park-new-cam-park')).toBeNull()
    expect((container.querySelector('.control-rpm-input') as HTMLInputElement).max).toBe('18000')

    await session.disconnectMachine()
    expect(useCamStore.getState().control.sessionMachine).toBeNull()
    expect(controlMachine(useCamStore.getState())).toBe(CONTROL_MACHINE)
  })

  // ---- WO-1065 attempt 3: the selector says what the readers do -----------
  //
  // Both audit failures were the same shape - a surface that recomputed the
  // machine from raw state instead of asking the resolver - so these four
  // cases pin the SELECTOR and the Machine panel to the resolver's own view,
  // and pin the console to saying it once.

  async function connectSimulated(): Promise<void> {
    vi.useFakeTimers()
    const pending = session.connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }

  function camMovedNotices(): string[] {
    return useMachineControl.getState().consoleLines
      .map((line) => line.text)
      .filter((text) => /the CAM setup moved to/.test(text))
  }

  it('holds the pinned machine in the selector, the panel and one console line when CAM moves', async () => {
    await connectSimulated()
    act(() => { useCamStore.getState().setProjectMachine(CONTROL_MACHINE) })

    const view = controlMachineSelection(useCamStore.getState())
    expect(view.machine.id).toBe(CAM_MACHINE.id)
    expect(view.mode).toBe('follow-cam')
    expect(view.pinned).toBe(true)
    expect(view.camMovedTo).toBe(CONTROL_MACHINE)

    render(
      <>
        <ControlTransportBar sections="nav" />
        <MachineDefinitionPanel />
      </>,
    )
    const select = screen.getByTestId('control-machine-select') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.selectedOptions[0].text).toContain(`Follow CAM setup (${CAM_MACHINE.name})`)
    expect(select.selectedOptions[0].text)
      .toContain(`pinned while connected; CAM is now on ${CONTROL_MACHINE.name}`)
    // The closed control is capped so the pinned sentence cannot wrap the
    // operator's row (46 px, measured), so the hover has to carry it whole.
    expect(select.getAttribute('data-tooltip'))
      .toContain(`pinned while connected; CAM is now on ${CONTROL_MACHINE.name}`)
    expect(screen.getByTestId('machine-definition-panel').getAttribute('data-machine-id'))
      .toBe(CAM_MACHINE.id)

    expect(camMovedNotices()).toHaveLength(1)
    expect(camMovedNotices()[0]).toContain(CAM_MACHINE.name)
    expect(camMovedNotices()[0]).toContain(CONTROL_MACHINE.name)

    // ONCE PER TRANSITION, not per store write: the store publishes on every
    // DRO tick, and this line must not become the console.
    act(() => { useCamStore.setState({}) })
    act(() => { useCamStore.getState().setProjectMachine(CONTROL_MACHINE) })
    expect(camMovedNotices()).toHaveLength(1)
  })

  it('says nothing and shows the picked machine when the pin is an explicit choice', async () => {
    useCamStore.getState().setControlMachineId(CONTROL_MACHINE.id)
    await connectSimulated()

    const movedCam = { ...CAM_MACHINE, id: 'wo1065-cam-b', name: 'Second CAM Router' }
    act(() => { useCamStore.getState().setProjectMachine(movedCam) })

    const view = controlMachineSelection(useCamStore.getState())
    expect(view.machine).toBe(useCamStore.getState().control.sessionMachine)
    expect(view.machine).toEqual(CONTROL_MACHINE)
    expect(view.mode).toBe('explicit')
    expect(view.pinned).toBe(true)
    expect(view.camMovedTo).toBeNull()

    render(<ControlTransportBar sections="nav" />)
    const select = screen.getByTestId('control-machine-select') as HTMLSelectElement
    expect(select.value).toBe(CONTROL_MACHINE.id)
    expect(select.selectedOptions[0].text).toContain(CONTROL_MACHINE.name)
    expect(select.selectedOptions[0].text).not.toContain('CAM is now on')
    expect(camMovedNotices()).toEqual([])
  })

  it('simply follows when the CAM setup moves with no session holding it', () => {
    act(() => { useCamStore.getState().setProjectMachine(CONTROL_MACHINE) })

    const view = controlMachineSelection(useCamStore.getState())
    expect(view.machine).toBe(CONTROL_MACHINE)
    expect(view.mode).toBe('follow-cam')
    expect(view.pinned).toBe(false)
    expect(view.camMovedTo).toBeNull()

    render(<ControlTransportBar sections="nav" />)
    const select = screen.getByTestId('control-machine-select') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.selectedOptions[0].text).toContain(`Follow CAM setup (${CONTROL_MACHINE.name})`)
    expect(select.selectedOptions[0].text).not.toContain('CAM is now on')
    expect(camMovedNotices()).toEqual([])
  })

  it('releases the pin on disconnect and follows CAM to the machine it moved to', async () => {
    await connectSimulated()
    act(() => { useCamStore.getState().setProjectMachine(CONTROL_MACHINE) })
    expect(camMovedNotices()).toHaveLength(1)

    await act(async () => { await session.disconnectMachine() })

    expect(useCamStore.getState().control.sessionMachine).toBeNull()
    const view = controlMachineSelection(useCamStore.getState())
    expect(view.machine).toBe(CONTROL_MACHINE)
    expect(view.mode).toBe('follow-cam')
    expect(view.pinned).toBe(false)
    expect(view.camMovedTo).toBeNull()

    render(
      <>
        <ControlTransportBar sections="nav" />
        <MachineDefinitionPanel />
      </>,
    )
    const select = screen.getByTestId('control-machine-select') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.selectedOptions[0].text).toBe(`Follow CAM setup (${CONTROL_MACHINE.name})`)
    expect(screen.getByTestId('machine-definition-panel').getAttribute('data-machine-id'))
      .toBe(CONTROL_MACHINE.id)
    expect(camMovedNotices()).toHaveLength(1)
  })

  it('builds simulation from the explicitly selected Control profile, not CAM', async () => {
    vi.useFakeTimers()
    useCamStore.getState().setControlMachineId(CONTROL_MACHINE.id)

    const pending = session.connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(300)
    await pending
    session.getMachineController().querySettings()
    await vi.advanceTimersByTimeAsync(10)

    expect(useMachineControl.getState().settings).toMatchObject({
      130: '738.000',
      131: '724.500',
      132: '128.900',
    })
    expect(useCamStore.getState().project.machine.travel).toEqual(CAM_MACHINE.travel)
  })

  it('keys parks, action editing, and probe routines to the Control machine', () => {
    useCamStore.getState().setControlMachineId(CONTROL_MACHINE.id)
    useCamStore.getState().updateMachineInLibrary(CAM_MACHINE.id, {
      macros: [{ id: 'cam-action', name: 'CAM action', body: 'lines("M8")' }],
    })
    useCamStore.getState().updateMachineInLibrary(CONTROL_MACHINE.id, {
      macros: [{ id: 'control-action', name: 'CONTROL action', body: 'lines("M9")', color: 'cyan' }],
    })
    useMachineActions.getState().addPark(CAM_MACHINE.id, {
      id: 'cam-park', label: 'CAM park', x: 10, y: 20,
    })
    useMachineActions.getState().addPark(CONTROL_MACHINE.id, {
      id: 'control-park', label: 'CONTROL park', x: 30, y: 40,
    })
    useMachineToolTable.getState().setProbeConfig(CAM_MACHINE.id, { fastFeed: 112 })
    useMachineToolTable.getState().setProbeConfig(CONTROL_MACHINE.id, { fastFeed: 778 })

    render(
      <>
        <MacroPanel onOpenActions={() => {}} rpm={10000} />
        <MachineActionsModal open onClose={() => {}} />
        <ProbeRoutinesTab />
      </>,
    )

    // WO-1707: MachineActionsModal no longer shows user buttons (folded into
    // macros, edited in MacroEditor) - one instance now, from MacroPanel.
    expect(screen.getAllByText('CONTROL action')).toHaveLength(1)
    expect(screen.queryByText('CAM action')).toBeNull()
    expect(screen.getByTestId('control-park-control-park')).toBeTruthy()
    expect(screen.queryByTestId('control-park-cam-park')).toBeNull()
    expect(screen.getByText(/Machine actions - Control UCCNC Router/)).toBeTruthy()
    expect(screen.getByTestId('wo1065-probe-routine-machine')).toMatchObject({
      dataset: { fastFeed: '778', xRapid: '4200' },
    })
    expect(useCamStore.getState().project.machine).toBe(CAM_MACHINE)
  })
})
