// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransportEvents } from '../../lib/machine/types'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/webSerialTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/webSerialTransport')>()
  class FakeWebSerialTransport extends actual.WebSerialTransport {
    private fakeEvents: TransportEvents | null = null

    static isSupported(): boolean { return true }
    static async requestPort(): Promise<SerialPort> { return {} as SerialPort }
    static async grantedPorts(): Promise<SerialPort[]> { return [] }

    async start(events: TransportEvents): Promise<void> {
      this.fakeEvents = events
      events.onChunk(new TextEncoder().encode("Grbl 1.1h ['$' for help]\r\n"))
    }

    async write(_data: Uint8Array): Promise<void> {}
    async close(): Promise<void> { this.fakeEvents?.onClose(null) }
  }
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({
    ...actual,
    WebSerialTransport: FakeWebSerialTransport,
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const {
  __resetEstopInterlockForTest,
  __reportWorkOffsetsForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  sendMdiLine,
  stagedGeometryProgramPath,
} = await import('../../lib/machine/machineSession')

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

function machine(referencePositions: MachineConfig['referencePositions'] = {
  1: { x: 0, y: 0, z: 0 },
  2: { x: 80, y: 20, z: 90 },
  3: { x: 20, y: 20, z: 90 },
  4: { x: 20, y: 80, z: 90 },
}): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const [index, axis] of controllerDefinition.axes.entries()) {
    axis.softLimitMin = 0
    axis.softLimitMax = 100
    axis.homePin = { port: 1, pin: index + 1, negate: false }
  }
  return makeMachine({
    id: 'wo-1362-machine',
    name: 'WO-1362 machine',
    controller: 'uccnc',
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 3000,
    noHomingSwitches: false,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    controllerDefinition,
    referencePositions,
  })
}

function install(target = machine()): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [target],
    project: { ...state.project, machine: target },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  })
}

async function connectSimulator(home: boolean): Promise<void> {
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => { __reportWorkOffsetsForTest({ G54: { x: 0, y: 0, z: 0 } }) })
  if (!home) return
  if (!getMachineController().home()) throw new Error('simulator refused home')
  await vi.advanceTimersByTimeAsync(2_000)
}

beforeEach(() => {
  vi.useFakeTimers()
  originalProject = useCamStore.getState().project
  originalLibrary = useCamStore.getState().machineLibrary
  originalControl = useCamStore.getState().control
  install()
  useMachineControl.setState({ consoleLines: [] })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject, machineLibrary: originalLibrary, control: originalControl })
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

describe('WO-1362 G30.1 machine workflow', () => {
  it('leaves GRBL-owned G30.1 and G30 on the controller text route', async () => {
    const target = machine()
    target.controller = 'grbl'
    target.controllerDefinition = undefined
    install(target)
    await connectMachine('serial')
    act(() => { __resetEstopInterlockForTest() })
    const ctrl = getMachineController()
    const send = vi.spyOn(ctrl, 'sendCommand')
    const before = structuredClone(useCamStore.getState().machineLibrary[0].referencePositions)

    expect(sendMdiLine('G30.1')).toBe(true)
    expect(sendMdiLine('G30')).toBe(true)

    expect(send).toHaveBeenNthCalledWith(1, 'G30.1')
    expect(send).toHaveBeenNthCalledWith(2, 'G30')
    expect(useCamStore.getState().machineLibrary[0].referencePositions).toEqual(before)
  })

  it('loads Operator\'s G30 as the same machine-Z then machine-XY rapids as M2001', async () => {
    const target = machine({
      1: { x: 738, y: 724.5, z: 128 },
      2: { x: 738, y: 50, z: 128 },
      3: { x: 50, y: 50, z: 128 },
      4: { x: 50, y: 724.5, z: 128 },
    })
    target.travel = { x: 800, y: 800, z: 200 }
    for (const axis of target.controllerDefinition!.axes) {
      axis.softLimitMax = axis.axis === 'Z' ? 200 : 800
    }
    install(target)
    await connectSimulator(true)

    const loaded = loadGcodeTextToolpathProgram(
      'g30-park.nc',
      'G21 G90 G54\nG30\nM30\n',
    )
    expect(loaded).toEqual({ ok: true, reason: null })
    const staged = stagedGeometryProgramPath()
    expect(staged?.moves).toEqual([
      { type: 'rapid', role: 'rapid', x: 0, y: 0, z: 128 },
      { type: 'rapid', role: 'rapid', x: 738, y: 724.5, z: 128 },
    ])

    if (process.env.WRITE_EVIDENCE === '1') {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync('src/tests/evidence/WO-1362', { recursive: true })
      writeFileSync('src/tests/evidence/WO-1362/g30-park-staged.json', `${JSON.stringify({
        tier: 2,
        hardwareClaim: false,
        source: 'g30-park.nc: G21 G90 G54 / G30 / M30',
        expectedMacroSequence: ['G00 G53 Z128', 'G00 G53 X738 Y724.5'],
        observedStagedMoves: staged?.moves,
        note: 'Captured through loadGcodeTextToolpathProgram on the simulator. The real-board park remains Tier 1 owed.',
      }, null, 2)}\n`)
    }
  })

  it('stores the reported machine position in point 1, says it, and G30 returns there', async () => {
    await connectSimulator(true)
    const ctrl = getMachineController()
    const storedAt = ctrl.status().machinePos
    expect(storedAt).not.toBeNull()

    expect(sendMdiLine('G30.1')).toBe(true)
    expect(useCamStore.getState().machineLibrary[0].referencePositions?.[1]).toEqual(storedAt)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toContain('stored reference point 1 at machine X')

    expect(ctrl.jog('X', 10, 1000)).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ctrl.status().machinePos?.x).toBeCloseTo(storedAt!.x + 10, 6)

    const sent = sendMdiLine('G30')
    expect(sent, useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')).toBe(true)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(ctrl.status().machinePos).toEqual(storedAt)
  })

  it('refuses G30.1 before homing and stores nothing', async () => {
    await connectSimulator(false)
    const before = useCamStore.getState().machineLibrary[0].referencePositions?.[1]
    expect(sendMdiLine('G30.1')).toBe(false)
    expect(useCamStore.getState().machineLibrary[0].referencePositions?.[1]).toEqual(before)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toContain('not been homed')
  })
})

describe('WO-1362 Machine Definition reference-position editor', () => {
  it('shows all four points in All settings and saves an edited machine coordinate', () => {
    render(<MachineDefinitionPanel />)
    fireEvent.click(screen.getByTestId('machine-def-tab-allSettings'))

    expect(screen.getAllByTestId(/^machine-def-all-settings-row-machine-park\.P/)).toHaveLength(12)
    const x = screen.getByLabelText('park.P2.x') as HTMLInputElement
    fireEvent.change(x, { target: { value: '82.5' } })
    fireEvent.blur(x)
    fireEvent.click(screen.getByTestId('machine-def-panel-save'))

    expect(useCamStore.getState().machineLibrary[0].referencePositions?.[2]?.x).toBe(82.5)
  })

  it('shows the G30.1 setup route when a machine stores no points', () => {
    install(machine({}))
    render(<MachineDefinitionPanel />)
    fireEvent.click(screen.getByTestId('machine-def-tab-allSettings'))
    expect(screen.getByTestId('machine-def-all-settings-row-machine-park.P1.x').textContent)
      .toContain('G30.1 stores P1')
    expect((screen.getByLabelText('park.P1.x') as HTMLInputElement).value).toBe('')
  })

  it('adds and saves a missing point 2 from an empty machine definition', () => {
    install(machine({}))
    render(<MachineDefinitionPanel />)
    fireEvent.click(screen.getByTestId('machine-def-tab-allSettings'))

    expect(screen.getAllByTestId(/^machine-def-all-settings-row-machine-park\.P/)).toHaveLength(12)
    for (const [axis, value] of [['X', '82.5'], ['Y', '24'], ['Z', '91']] as const) {
      const input = screen.getByLabelText(`park.P2.${axis.toLowerCase()}`)
      fireEvent.change(input, { target: { value } })
      fireEvent.blur(input)
    }
    fireEvent.click(screen.getByTestId('machine-def-panel-save'))

    expect(useCamStore.getState().machineLibrary[0].referencePositions?.[2]).toEqual({
      x: 82.5,
      y: 24,
      z: 91,
    })
  }, 60_000)
})
