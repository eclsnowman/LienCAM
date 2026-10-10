// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeDefinitionSource,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import type { StagedProgramView } from '../../store/machineControlStore'
import { typedMock } from '../support/typedMock'

const bridge = vi.hoisted(() => ({
  source: 'cache-baseline' as BridgeDefinitionSource,
  events: null as BridgeTransportEvents | null,
}))
const programParts = vi.hoisted(() => ({ combinedSetupActive: false }))

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class HelloTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    async start(events: BridgeTransportEvents): Promise<void> {
      bridge.events = events
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'liencam-uccnc-bridge/WO-1327',
          capabilities: CAPABILITIES,
          readOnly: false,
          definitionSource: bridge.source,
          definitionDrift: [],
        },
      })
    }
    send(_message: BridgeCallMessage): void {}
    async close(): Promise<void> { bridge.events = null }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: HelloTransport,
  })
})

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    combinedSetupProgramActive: () => programParts.combinedSetupActive,
  })
})

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setActiveToolpathSegment = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    fitToolpath = vi.fn()
  } as never,
}))

const {
  bridgePresenceIssue,
  machineStateChipLabel,
} = await import('../../components/machine/ControlTransportBar')
const {
  resolveProgramPreviewGrid,
} = await import('../../components/machine/ProgramPreviewGridControl')
const { ProgramPanel, stagedSetupChipLabel } = await import('../../components/machine/ProgramPanel')
const session = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

const STAGED: StagedProgramView = {
  program: { frame: 'work', units: 'mm', steps: [], index: {} },
  setups: [
    { setupName: 'Setup 1', wcs: 'G54', firstStepId: 1 },
    { setupName: 'Setup 2', wcs: 'G55', firstStepId: 4 },
  ],
}

beforeEach(() => {
  useCamStore.getState().newProject()
  useMachineControl.setState({ consoleLines: [] })
  bridge.events = null
  programParts.combinedSetupActive = false
})

afterEach(async () => {
  cleanup()
  await session.disconnectMachine()
})

describe('WO-1327 console and control names', () => {
  it('names Connect while the bridge is running and Reconnect only when the process needs recovery', () => {
    const running = bridgePresenceIssue(
      { socket: 'closed', controller: 'unknown', process: 'running' },
      'hosted',
    )
    const stopped = bridgePresenceIssue(
      { socket: 'closed', controller: 'unknown', process: 'stopped' },
      'hosted',
    )
    const gaveUp = bridgePresenceIssue(
      { socket: 'closed', controller: 'unknown', process: 'gave-up' },
      'hosted',
    )

    expect(running?.detail).toContain('Use Connect before moving.')
    expect(running?.detail).not.toContain('Use Reconnect')
    expect(stopped?.detail).toContain('Use Reconnect before moving.')
    expect(gaveUp?.detail).toContain('Use Reconnect before moving.')
  })

  it('lets the app E-STOP latch outrank an idle controller poll', () => {
    expect(machineStateChipLabel({
      machineState: 'idle',
      softLimitLatched: false,
      estopTripped: true,
    })).toBe('E-STOP')
    expect(machineStateChipLabel({
      machineState: 'idle',
      softLimitLatched: false,
      estopTripped: false,
    })).toBe('Idle')
  })

  it('names the homing requirement instead of calling the machine unavailable', () => {
    const resolution = resolveProgramPreviewGrid(
      'machine',
      'G54',
      { G54: [0, 0, 0] },
      {
        x: { travelMm: 800, homesToward: 'min', homePositionMm: 0, pulloffMm: 1, min: 0, max: 800 },
        y: { travelMm: 600, homesToward: 'min', homePositionMm: 0, pulloffMm: 1, min: 0, max: 600 },
        z: { travelMm: 100, homesToward: 'min', homePositionMm: 0, pulloffMm: 1, min: 0, max: 100 },
      },
      'not-homed',
    )
    expect(resolution.label).toBe('Machine - HOME FIRST')
  })

  it('names every staged setup before start and the live setup after start', () => {
    expect(stagedSetupChipLabel(STAGED, null)).toBe('Setup 1 + Setup 2')
    expect(stagedSetupChipLabel(STAGED, 2)).toBe('Setup 1 (G54) running')
    expect(stagedSetupChipLabel(STAGED, 5)).toBe('Setup 2 (G55) running')
  })

  it('shows the combined-setup chip before start and during a stage', () => {
    programParts.combinedSetupActive = true
    useMachineControl.setState((state) => ({
      programText: null,
      programContext: null,
      stagedProgram: STAGED,
      executingMoveId: null,
      job: {
        ...state.job,
        name: 'Setup 1 + Setup 2 (toolpath)',
        phase: 'ready',
      },
    }))
    render(<ProgramPanel />)

    expect(screen.getByTestId('control-program-context').textContent).toBe('Setup 1 + Setup 2')

    act(() => useMachineControl.getState().setExecutingMoveId(5))
    expect(screen.getByTestId('control-program-context').textContent).toBe('Setup 2 (G55) ready')
  })

  it('prints an active-job program-load refusal exactly once', () => {
    const activeJob = vi.spyOn(session.getMachineController(), 'hasActiveJob').mockReturnValue(true)

    const loaded = session.loadGcodeTextToolpathProgram('replacement.nc', 'G21\nM30\n')

    expect(loaded).toEqual({
      ok: false,
      reason: 'The program is still running - Feed Hold, then Stop, before loading another.',
    })
    expect(useMachineControl.getState().consoleLines.filter(({ text }) => text === loaded.reason))
      .toHaveLength(1)
    activeJob.mockRestore()
  })

  it.each([
    ['cache-baseline', "Machine configured from this computer's data (the .pro was not opened)."],
    ['cache', 'Machine configured from the bridge cache; its start-up source was not distinguished.'],
  ] as const)('reports a %s hello with its distinct source sentence', async (source, expected) => {
    bridge.source = source
    // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
    }))
    await session.connectMachine('bridge')

    expect(useMachineControl.getState().consoleLines.filter(({ text }) => text === expected))
      .toHaveLength(1)
  })
})
