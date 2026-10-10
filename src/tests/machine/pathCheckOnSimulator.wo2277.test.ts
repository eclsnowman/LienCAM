// @vitest-environment jsdom
// Real session/controller; only the hardware byte pipe is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { analysePathFidelity } from '../../lib/machine/pathFidelity'
import type { QueuedMove } from '../../lib/machine/controller'
import type { TransportEvents } from '../../lib/machine/types'
import type { MachineConfig } from '../../types'
import { createDefaultControllerDefinition } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/webSerialTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/webSerialTransport')>()
  class FakeBoard extends actual.WebSerialTransport {
    private boardEvents: TransportEvents | null = null
    static isSupported(): boolean { return true }
    static async requestPort(): Promise<SerialPort> { return {} as SerialPort }
    static async grantedPorts(): Promise<SerialPort[]> { return [] }
    async start(events: TransportEvents): Promise<void> {
      this.boardEvents = events
      this.reply("Grbl 1.1h ['$' for help]\r\n")
    }
    private reply(text: string): void { this.boardEvents?.onChunk(new TextEncoder().encode(text)) }
    async write(data: Uint8Array): Promise<void> {
      const text = new TextDecoder().decode(data)
      if (text === '?') this.reply('<Idle|MPos:10,10,0|WCO:0,0,0|FS:0,0>\r\n')
      else if (text.includes('$G')) this.reply('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F600 S0]\r\nok\r\n')
      else if (text.includes('$#')) this.reply('[G54:0,0,0]\r\n[TLO:0]\r\nok\r\n')
      else if (text.includes('\n')) this.reply('ok\r\n')
    }
    async close(): Promise<void> { this.boardEvents?.onClose(null) }
  }
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({ ...actual, WebSerialTransport: FakeBoard })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest, clearPathFidelity, connectMachine, disconnectMachine,
  getMachineController, loadMachineProgram, pathFidelityReport, pathToleranceMmValue,
  refreshPathToleranceFromMachine, setPathToleranceMm, startMachineJob,
} = await import('../../lib/machine/machineSession')
const { SimulatedController } = await import('../../lib/machine/simulatedController')

const PROGRAM = 'G21 G90 G54\nG1 X10 Y0 F600\nG1 X10 Y10\nM30'
const original = useCamStore.getState()

function selectMachine(controller: 'grbl' | 'uccnc' = 'grbl', tolerance?: string): void {
  const definition = createDefaultControllerDefinition()
  for (const axis of definition.axes) {
    axis.softLimitMin = 0
    axis.softLimitMax = 100
  }
  const machine: MachineConfig = {
    ...original.project.machine,
    id: 'wo2277-machine', name: 'WO-2277 Router', controller,
    controllerDefinition: definition, noHomingSwitches: true,
    unsentSettings: tolerance === undefined ? undefined : [{
      controller: 'uccnc', key: 'Generalsettings.Linearerror', value: tolerance,
    }],
    travel: { x: 100, y: 100, z: 100 }, rapidRate: 6000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
  }
  useCamStore.setState((s) => ({
    machineLibrary: [machine], project: { ...s.project, machine, setups: [], activeSetupId: null },
    control: { ...s.control, activeMachineId: machine.id, sessionMachine: null },
  }))
}

async function connect(kind: 'simulator' | 'serial'): Promise<void> {
  const pending = connectMachine(kind, 115200)
  await vi.advanceTimersByTimeAsync(500)
  await pending
  __resetEstopInterlockForTest()
  if (kind === 'simulator') {
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
  }
}

async function disconnect(): Promise<void> {
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(300)
  await pending
}

async function run(): Promise<string> {
  useMachineControl.getState().clearConsole()
  const loaded = loadMachineProgram('corner.nc', PROGRAM)
  expect(loaded.lines.length).toBeGreaterThan(0)
  const previous = pathFidelityReport()
  const started = startMachineJob()
  expect(started, useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')).toBe(true)
  await vi.advanceTimersByTimeAsync(15000)
  expect(useMachineControl.getState().job.phase).toBe('complete')
  expect(pathFidelityReport()).not.toBe(previous)
  const lines = useMachineControl.getState().consoleLines.map((line) => line.text)
  const pathCheck = lines.find((line) => line.startsWith('Path check:'))
  expect(pathCheck).toBeDefined()
  return pathCheck!
}

beforeEach(() => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  useMachineControl.setState({ consoleLines: [], parserModal: null, toolChange: null })
  clearPathFidelity()
  setPathToleranceMm(null)
  selectMachine()
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') await disconnect()
  clearPathFidelity()
  setPathToleranceMm(null)
  useCamStore.setState({
    machineLibrary: original.machineLibrary, project: original.project, control: original.control,
  })
  vi.useRealTimers()
})

describe('WO-2277 simulator path tolerance', () => {
  it.each(['moving', 'stationary'] as const)(
    'measures all 50000 %s frames within ten seconds without losing a sustained departure',
    (route) => {
      const moves: QueuedMove[] = Array.from({ length: 50_000 }, (_, i) => ({
        id: 2 * i + 7, kind: 'line', to: { x: route === 'moving' ? i + 1 : 0, y: 0, z: 0 },
        feedMmMin: 60,
      }))
      const samples = moves.map((move, i) => ({
        atMs: i * 1000, executingMoveId: move.id,
        machinePos: { x: route === 'moving' ? i + 0.5 : 0, y: i >= 25_000 ? 1 : 0, z: 0 },
      }))
      const started = performance.now()
      const report = analysePathFidelity({
        moves, samples, startPos: { x: 0, y: 0, z: 0 },
        reportsExecutingMoveId: true, toleranceMm: 1e-6,
      })
      expect(performance.now() - started).toBeLessThan(10_000)
      expect(report.verdict).toBe('divergence')
      expect(report.samples.attributed).toBe(50_000)
      expect(report.evidence).toHaveLength(50_000)
      expect(report.spans).toHaveLength(1)
      expect(report.spans[0]).toMatchObject({ startIndex: 25_000, sampleCount: 25_000, peakDeviationMm: 1 })
      expect(report.evidence?.[0].commandedMoveId).toBe(7)
    },
  )

  it('keeps both travel-window boundaries and stationary blocks eligible with zero slack', () => {
    const moves: QueuedMove[] = [
      { id: 7, kind: 'line', to: { x: 1 }, feedMmMin: 60 },
      { id: 11, kind: 'line', to: { x: 1 }, feedMmMin: 60 },
      { id: 19, kind: 'line', to: { x: 1 }, feedMmMin: 60 },
      { id: 23, kind: 'line', to: { x: 2 }, feedMmMin: 60 },
    ]
    const report = analysePathFidelity({
      moves, startPos: { x: 0, y: 0, z: 0 }, reportsExecutingMoveId: true, toleranceMm: 1e-6,
      options: { attributionSlackPolls: 0 },
      samples: [0.5, 1, 1.5].map((x, i) => ({
        atMs: i * 1000, executingMoveId: 19, machinePos: { x, y: 0, z: 0 },
      })),
    })
    expect(report.verdict).toBe('clean')
    expect(report.evidence?.map((row) => row.commandedMoveId)).toEqual([7, 7, 23])
    expect(report.evidence?.map((row) => row.deviationMm)).toEqual([0, 0, 0])
  })

  it('GRBL machine on the native simulator runs a corner and gets a measured verdict', async () => {
    await connect('simulator')
    const ctrl = getMachineController()
    expect(ctrl).toBeInstanceOf(SimulatedController)
    const said = await run()
    expect(said).not.toContain('has not been read back')
    expect(said).not.toContain('CANNOT ASSESS')
    expect(pathFidelityReport()?.verdict).toBe('clean')
    expect(pathFidelityReport()?.samples.attributed).toBeGreaterThan(3)
    expect(pathToleranceMmValue()).toBe((ctrl as InstanceType<typeof SimulatedController>).pathToleranceMm)
    expect(pathFidelityReport()?.toleranceMm).toBe(pathToleranceMmValue())
    expect(pathFidelityReport()?.thresholdMm).toBeCloseTo(3 * pathToleranceMmValue()!, 10)
    expect(useMachineControl.getState().consoleLines.filter((l) => l.severity === 'error')).toEqual([])
  })

  it('the same program on a serial GRBL board still cannot assess, even after a simulator connection', async () => {
    await connect('simulator')
    loadMachineProgram('corner.nc', PROGRAM)
    await disconnect()
    await connect('serial')
    const said = await run()
    expect(pathToleranceMmValue()).toBeNull()
    expect(said).toContain('CANNOT ASSESS')
    expect(pathFidelityReport()?.verdict).toBe('unknown')
    // WO-2581 supplies executing-block attribution, so the analyser now
    // reaches the missing tolerance; simulator tolerance must not leak here.
    expect(said).toContain("the controller's configured path tolerance has not been read back")
  })

  it('preserves a UCCNC profile Linearerror of 0.03 and its existing threshold', async () => {
    selectMachine('uccnc', '0.03')
    refreshPathToleranceFromMachine()
    expect(pathToleranceMmValue()).toBe(0.03)
    await connect('simulator')
    expect(await run()).not.toContain('CANNOT ASSESS')
    expect(pathFidelityReport()?.toleranceMm).toBe(0.03)
    expect(pathFidelityReport()?.thresholdMm).toBeCloseTo(0.09, 10)
  })
})
