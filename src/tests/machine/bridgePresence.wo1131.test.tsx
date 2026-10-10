// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineConfig } from '../../types'
import { typedMock } from '../support/typedMock'

type BridgeHostModule = typeof import('../../lib/machine/bridgeHost')

const host = vi.hoisted(() => ({
  capability: 'unhosted' as 'hosted' | 'supervisor' | 'unhosted',
  restart: vi.fn<BridgeHostModule['restartBridge']>(),
  status: vi.fn<BridgeHostModule['bridgeProcessStatus']>(),
}))

vi.mock('../../lib/machine/bridgeHost', () =>
  typedMock<BridgeHostModule>({
    bridgeHostCapability: () => host.capability,
    bridgeProcessStatus: host.status,
    restartBridge: host.restart,
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

const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { ControlPage } = await import('../../components/machine/ControlPage')
const { JogPanel } = await import('../../components/machine/JogPanel')
const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const {
  bridgePresence,
  useMachineControl,
} = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  describeConfigWriteRequest,
  describeProfileActivation,
} = await import('../../lib/machine/uccncProfileImport')
const {
  __resetEstopInterlockForTest,
  buildContractEvents,
} = await import('../../lib/machine/machineSession')

function machine(controller: MachineConfig['controller']): MachineConfig {
  return {
    id: `wo1131-${controller}`,
    name: `WO-1131 ${controller}`,
    type: 'gantry_router',
    controller,
    travel: { x: 800, y: 600, z: 100 },
    rapidRate: 6000,
    maxSpindleRpm: 24000,
    minSpindleRpm: 8000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
  }
}

function seedMachine(controller: MachineConfig['controller'] = 'uccnc'): MachineConfig {
  const selected = machine(controller)
  useCamStore.setState((state) => ({
    machineLibrary: [selected],
    project: { ...state.project, machine: selected },
    control: { ...state.control, activeMachineId: selected.id },
  }))
  return selected
}

function seedPresence(overrides: Partial<ReturnType<typeof useMachineControl.getState>> = {}): void {
  useMachineControl.setState((state) => ({
    connectionPhase: 'disconnected',
    connectionKind: null,
    machineState: 'unknown',
    homed: false,
    bridgeControllerPresence: 'unknown',
    bridgeProcessPresence: 'unknown',
    consoleLines: [],
    job: { ...state.job, phase: 'empty' },
    ...overrides,
  }))
}

beforeEach(() => {
  cleanup()
  memory.clear()
  host.capability = 'unhosted'
  host.restart.mockReset()
  host.restart.mockResolvedValue({ ok: true, pid: 1131, port: 8325 })
  host.status.mockReset()
  host.status.mockResolvedValue(null)
  __resetEstopInterlockForTest()
  seedMachine()
  seedPresence()
  useUiPrefs.setState({ collapsedPropsGroups: {}, machineJogContinuous: false })
  useCamStore.getState().closeModal()
})

afterEach(() => {
  cleanup()
  useCamStore.getState().closeModal()
  __resetEstopInterlockForTest()
})

describe('WO-1131 bridge presence model', () => {
  it('keeps socket, controller, and process as three independent facts', () => {
    expect(bridgePresence({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      bridgeControllerPresence: 'unknown',
      bridgeProcessPresence: 'gave-up',
    })).toEqual({ socket: 'open', controller: 'unknown', process: 'gave-up' })

    expect(bridgePresence({
      connectionPhase: 'disconnected',
      connectionKind: null,
      bridgeControllerPresence: 'lost',
      bridgeProcessPresence: 'running',
    })).toEqual({ socket: 'closed', controller: 'lost', process: 'running' })
  })

  it('tells an unhosted operator what is on their screen and renders no dead control', () => {
    seedPresence({ bridgeProcessPresence: 'unknown', connectionDetail: 'socket closed' })
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)

    const chip = screen.getByTestId('control-state-chip')
    expect(chip.textContent).toBe('Bridge disconnected')
    expect(chip.title).toContain('Close the bridge window and start it again')
    expect(screen.queryByTestId('control-bridge-reconnect')).toBeNull()
    expect(useMachineControl.getState().consoleLines).toHaveLength(1)

    act(() => useMachineControl.getState().setBridgeProcessPresence('stopped'))
    expect(useMachineControl.getState().consoleLines).toHaveLength(1)
  })

  it('offers hosted recovery without inventing a Home All requirement', async () => {
    host.capability = 'hosted'
    seedPresence({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      machineState: 'idle',
      bridgeProcessPresence: 'stopped',
    })
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)

    fireEvent.click(screen.getByTestId('control-bridge-reconnect'))
    await waitFor(() => expect(host.restart).toHaveBeenCalledWith(8325, undefined))
    expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toBe('Bridge recovery complete. The machine is connected.')
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .not.toMatch(/home all|home required/i)
  })

  it('reports a fast bridge exit with the bridge\'s own last line, never a paraphrase (WO-1306)', async () => {
    host.capability = 'hosted'
    const bridgeLine = 'Board 1: 0 device(s) found - waiting for the controller to come back... 10 s'
    host.restart.mockResolvedValueOnce({
      ok: false,
      reason: 'exited',
      lastExit: { code: 2, signal: null, error: bridgeLine },
    })
    seedPresence({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      machineState: 'idle',
      bridgeProcessPresence: 'stopped',
    })
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)

    fireEvent.click(screen.getByTestId('control-bridge-reconnect'))
    await waitFor(() => expect(host.restart).toHaveBeenCalled())
    await waitFor(() => expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toBe(`Reconnect failed. The bridge exited at once; its last line: ${bridgeLine}`))
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .not.toMatch(/straight away/)
  })

  it('names a silent fast exit instead of inventing a reason (WO-1306)', async () => {
    host.capability = 'hosted'
    host.restart.mockResolvedValueOnce({ ok: false, reason: 'exited', lastExit: null })
    seedPresence({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      machineState: 'idle',
      bridgeProcessPresence: 'stopped',
    })
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)

    fireEvent.click(screen.getByTestId('control-bridge-reconnect'))
    await waitFor(() => expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toBe('Reconnect failed. The bridge exited at once and printed nothing.'))
  })

  it('does not call a healthy first bridge connection a recovery', () => {
    seedPresence({
      connectionPhase: 'connecting',
      connectionKind: 'bridge',
      machineState: 'idle',
      bridgeProcessPresence: 'running',
    })

    act(() => buildContractEvents().onConnectionPhase!('connected', null))

    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)
    expect(screen.getByTestId('control-state-chip').textContent).not.toBe('Home required')
    render(<JogPanel selectedConnectionKind="bridge" />)
    fireEvent.pointerDown(screen.getByTestId('control-jog-x-plus'))
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .not.toMatch(/bridge connection was recovered|Jog refused:/)
  })

  it('allows jog immediately after this session observes a bridge loss and reconnect', () => {
    seedPresence({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      machineState: 'idle',
      bridgeProcessPresence: 'unknown',
    })

    act(() => buildContractEvents().onConnectionPhase!('disconnected', 'socket closed'))

    act(() => useMachineControl.getState().setConnectionKind('bridge'))
    act(() => buildContractEvents().onConnectionPhase!('connecting', null))
    act(() => buildContractEvents().onConnectionPhase!('connected', null))
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)
    render(<JogPanel selectedConnectionKind="bridge" />)
    expect(screen.getByTestId('control-state-chip').textContent).not.toBe('Home required')
    fireEvent.pointerDown(screen.getByTestId('control-jog-x-plus'))
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .not.toMatch(/bridge connection was recovered|Jog refused:/)
  })

  it('does not claim homing or announce bridge recovery while the machine is in alarm', () => {
    host.capability = 'hosted'
    seedPresence({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      machineState: 'idle',
      bridgeProcessPresence: 'stopped',
    })
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)

    act(() => useMachineControl.setState({ machineState: 'alarm' }))
    act(() => useMachineControl.getState().setBridgeProcessPresence('running'))
    expect(useMachineControl.getState().consoleLines).toHaveLength(1)

    act(() => useMachineControl.setState({ machineState: 'idle' }))
    const recovery = useMachineControl.getState().consoleLines.at(-1)?.text ?? ''
    expect(recovery).toBe('Bridge recovery complete. The machine is connected.')
    expect(recovery).not.toContain('homed')
  })

  it('trusts an open socket when a hosted app did not spawn the bridge process', async () => {
    host.capability = 'hosted'
    host.status.mockResolvedValue({
      configured: false,
      running: false,
      pid: null,
      lastExit: null,
      respawn: { attempts: 0, gaveUp: false, lastAttemptAt: null },
    })
    seedPresence({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      machineState: 'idle',
      bridgeProcessPresence: 'unknown',
    })

    render(<ControlPage />)
    await waitFor(() => expect(host.status).toHaveBeenCalled())
    expect(useMachineControl.getState().bridgeProcessPresence).toBe('unknown')
    expect(screen.getByTestId('control-state-chip').textContent).toBe('Idle')

    fireEvent.pointerDown(screen.getByTestId('control-jog-x-plus'))
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .not.toContain('Jog refused:')
  })

  it.each([
    { gaveUp: false, headline: 'Bridge not running', presence: 'stopped' as const },
    { gaveUp: true, headline: 'Bridge stopped', presence: 'gave-up' as const },
  ])('surfaces a supervisor process reported as $presence', async ({ gaveUp, headline, presence }) => {
    host.capability = 'supervisor'
    host.status.mockResolvedValue({
      configured: true,
      running: false,
      pid: null,
      lastExit: null,
      respawn: { attempts: gaveUp ? 3 : 0, gaveUp, lastAttemptAt: null },
    })
    seedPresence({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      machineState: 'idle',
      bridgeProcessPresence: 'unknown',
    })

    render(<ControlPage />)

    await waitFor(() => expect(useMachineControl.getState().bridgeProcessPresence).toBe(presence))
    expect(screen.getByTestId('control-state-chip').textContent).toBe(headline)

    fireEvent.pointerDown(screen.getByTestId('control-jog-x-plus'))
    expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toContain('Jog refused: the bridge process is not running')
  })

  it('never gives a switchless operator a home demand during a bridge incident or recovery', () => {
    const selected = seedMachine()
    const switchless = { ...selected, noHomingSwitches: true }
    useCamStore.setState((state) => ({
      machineLibrary: [switchless],
      project: { ...state.project, machine: switchless },
      control: { ...state.control, activeMachineId: switchless.id, sessionMachine: switchless },
    }))
    seedPresence({
      connectionPhase: 'disconnected',
      connectionKind: null,
      connectionDetail: 'socket closed',
      machineState: 'idle',
      bridgeProcessPresence: 'unknown',
    })
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)
    render(<JogPanel selectedConnectionKind="bridge" />)

    expect(screen.getByTestId('control-state-chip').title).not.toMatch(/home/i)
    fireEvent.pointerDown(screen.getByTestId('control-jog-x-plus'))
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).not.toMatch(/home/i)

    act(() => useMachineControl.setState({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      connectionDetail: null,
      bridgeProcessPresence: 'stopped',
    }))
    expect(screen.getByTestId('control-state-chip').title).not.toMatch(/home/i)

    act(() => useMachineControl.getState().setBridgeProcessPresence('running'))
    fireEvent.pointerDown(screen.getByTestId('control-jog-x-plus'))
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .not.toMatch(/home all|home required|bridge connection was recovered/i)
    expect(useMachineControl.getState().homed).toBe(false)
  })
})

describe('WO-1131 motion and profile refusals', () => {
  it('refuses a bridge jog out loud without printing a motion confirmation', () => {
    seedPresence({ connectionDetail: 'socket closed' })
    render(<JogPanel selectedConnectionKind="bridge" />)
    fireEvent.pointerDown(screen.getByTestId('control-jog-x-plus'))

    const lines = useMachineControl.getState().consoleLines.map((line) => line.text)
    expect(lines.at(-1)).toContain('Jog refused: not connected to the bridge')
    expect(lines.at(-1)).toContain('Close the bridge window and start it again')
    expect(lines.join('\n')).not.toMatch(/continuous jog ON/i)
  })

  it('permits bridge jog when the socket and hosted process are available', () => {
    host.capability = 'hosted'
    seedPresence({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      machineState: 'idle',
      bridgeProcessPresence: 'running',
    })
    render(<JogPanel />)
    fireEvent.pointerDown(screen.getByTestId('control-jog-y-minus'))

    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .not.toContain('Jog refused:')
  })

  it('makes pending-profile recovery truthful in both host types', () => {
    const hosted = describeProfileActivation({
      runningProfile: 'C:\\UCCNC\\Profiles\\Old.pro',
      chosenProfile: 'C:\\UCCNC\\Profiles\\New.pro',
      bridgeCapability: 'hosted',
    })
    const unhosted = describeProfileActivation({
      runningProfile: 'C:\\UCCNC\\Profiles\\Old.pro',
      chosenProfile: 'C:\\UCCNC\\Profiles\\New.pro',
      bridgeCapability: 'unhosted',
    })
    expect(hosted).toContain('Use Reconnect on the Control screen')
    expect(unhosted).toContain('Close the bridge window and start it again')
    expect(unhosted).not.toBe('Restart the bridge before this profile drives the machine.')

    const request = describeConfigWriteRequest({
      path: 'C:\\UCCNC\\Profiles\\New.pro',
      error: null,
      reply: {
        ok: true,
        error: null,
        requestedProfile: 'C:\\UCCNC\\Profiles\\New.pro',
        configPath: 'C:\\bridge\\config.json',
        written: true,
        restartRequired: true,
        runningProfile: 'C:\\UCCNC\\Profiles\\Old.pro',
      },
    }, 'unhosted')
    expect(request).toContain('Close the bridge window and start it again')
    expect(request).not.toBe('Restart the bridge before this profile drives the machine.')
  })

  it('does not read a local UCCNC profile for a declared GRBL machine', async () => {
    seedMachine('grbl')
    const read = vi.spyOn(FileReader.prototype, 'readAsText')
    render(<MachineLibraryModal />)
    act(() => useCamStore.getState().openModal('machine-config'))
    const input = await screen.findByTestId('machine-library-import-input')

    fireEvent.change(input, {
      target: { files: [new File(['ProfileName=wrong'], 'wrong.pro', { type: 'text/plain' })] },
    })

    expect(read).not.toHaveBeenCalled()
    expect(screen.queryByTestId('uccnc-profile-preview')).toBeNull()
    read.mockRestore()
  })
})
