// @vitest-environment jsdom

// WO-2712 amendment (Operator 10-09 5:26 PM): "fix it the right way by setting
// g54 offsets logically, and homing correct". The shipped Sample router homes
// to its max ends (machine zero back-right top), so a fresh profile's G54 is
// placed where the simulated part's FRONT-LEFT TOP corner is - the same
// placement buildDefaultSimulatedPart uses, so the two always agree. Nothing
// the operator or a controller set is overwritten. And an offset edited after
// Load is the one Cycle Start runs in - the simulator reads the staged text
// against the work zero in force when it starts, as GRBL reads a block when it
// executes it.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import { createDefaultControllerDefinition, type MachineConfig } from '../../types'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { MachineStatus } from '../../lib/machine/controller'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'

vi.mock('../../components/machine/ProgramPreview', () => typedMock<typeof import('../../components/machine/ProgramPreview')>({
  ProgramPreview: () => createElement('div', { 'data-testid': 'program-preview-stub' }),
}))

// Review regression: WO-2140's homed native board reports positive machine
// coordinates and its own G54. Drive the actual session/controller route;
// this fake transport is desk evidence, never a hardware motion claim.
let bridgeEvents: BridgeTransportEvents | null = null
let bridgeVerbs: string[] = []
const bridgePosition = { x: 205, y: 275, z: 40 }
const bridgeG54 = { x: 200, y: 200, z: 30 }
function pushBridgeStatus(): void {
  bridgeEvents?.onMessage({ t: 'status', v: {
    state: 'idle', subState: null, machinePos: bridgePosition,
    workPos: { x: 5, y: 75, z: 10 }, feedMmMin: 0, spindleRpm: 0,
    overrides: null, executingMoveId: null,
    buffer: { moves: 0, capacitySeconds: 0.1 }, inputs: null,
    homed: { X: true, Y: true, Z: true }, spindle: null,
  } as MachineStatus } as BridgeMessage)
}
vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        const zero = { x: 0, y: 0, z: 0 }
        const offsets = { G54: bridgeG54, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
        events.onMessage({ t: 'hello', v: {
          protocol: 1, bridge: 'liencam-uccnc-bridge/0.4', readOnly: false,
          capabilities: {
            geometryQueue: true, executingMoveId: true, bufferSeconds: true,
            gcodeText: false, machineProgram: true, perAxisHoming: true,
            ownsSpindle: false, spindleCommands: false,
          },
          workOffsets: { current: offsets, profile: offsets },
        } } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        bridgeVerbs.push(message.m)
        if (message.m === 'queryStatus') {
          pushBridgeStatus()
        }
        bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true,
          v: message.m === 'setSingleBlockMode' ? null : true })
        if (message.m === 'startJob') {
          bridgeEvents?.onMessage({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  buildDefaultSimulatedPart,
  connectMachine,
  currentResolvedMachineMotion,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  sendMdiLine,
  setWorkOffsetValue,
  transferReview,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

const PLAIN_FILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/final-session-programs/final-o9-comments-first.nc'),
  'utf8',
)
const initial = useCamStore.getInitialState()
const initialControl = useMachineControl.getState()

async function connectSimulatorWith(machine: MachineConfig): Promise<void> {
  useCamStore.setState({ project: { ...initial.project, machine }, machineLibrary: [machine] })
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(350)
  await pending
  await vi.advanceTimersByTimeAsync(50)
}

function liveG54(): number[] | undefined {
  return useMachineControl.getState().offsets.G54
}

describe('WO-2712 amendment: a fresh profile places G54 logically on the Sample router', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useCamStore.setState(initial, true)
    useMachineControl.setState({ ...initialControl, consoleLines: [] })
  })

  afterEach(async () => {
    cleanup()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
    useCamStore.setState(initial, true)
  })

  it('fresh profile: G54 is the simulated part\'s front-left top corner, from the same placement', async () => {
    const sample = useCamStore.getInitialState().project.machine
    await connectSimulatorWith(sample)
    const part = buildDefaultSimulatedPart()
    const g54 = liveG54()
    expect(g54).toBeDefined()
    expect(g54![0]).toBeCloseTo(part.origin.x, 6)
    expect(g54![1]).toBeCloseTo(part.origin.y, 6)
    expect(g54![2]).toBeCloseTo(part.topZ, 6)
    // On the table, inside the stated travel (X/Y -406..0, Z -95..0).
    expect(g54![0]).toBeGreaterThan(-406)
    expect(g54![1]).toBeGreaterThan(-406)
    expect(g54![2]).toBeGreaterThan(-95)
    expect(g54!.slice(0, 3).every((v) => v < 0)).toBe(true)
    // A default, not a record: nothing is written into the durable store.
    expect(useCamStore.getState().machineWorkOffsets[sample.id]?.G54).toBeUndefined()
  })

  it('an offset the operator set is never overwritten - even an explicit 0, 0, 0', async () => {
    const sample = useCamStore.getInitialState().project.machine
    useCamStore.getState().setMachineWorkOffset(sample.id, 'G54', { x: 0, y: 0, z: 0 }, 'not-sent')
    await connectSimulatorWith(sample)
    expect(liveG54()?.slice(0, 3)).toEqual([0, 0, 0])
  })

  it('fresh profile: home, then Cycle Start runs the plain file with no error', async () => {
    const sample = useCamStore.getInitialState().project.machine
    await connectSimulatorWith(sample)
    __resetEstopInterlockForTest()
    loadMachineProgram('final-o9-comments-first.nc', PLAIN_FILE, null)
    expect(getMachineController().homeAxes?.(['X', 'Y', 'Z'])).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await executeOperatorCycleStart()).toBe(true)
    const errors = useMachineControl.getState().consoleLines
      .filter((line) => line.severity === 'error')
      .map((line) => line.text)
    expect(errors, JSON.stringify(errors)).toEqual([])
  })

  it('G54 changed on the Offsets tab after Load: Cycle Start runs in the CURRENT zero, no re-load', async () => {
    const sample = useCamStore.getInitialState().project.machine
    // The operator's own zero at machine zero: the file's +X/+Y/+Z leave travel.
    useCamStore.getState().setMachineWorkOffset(sample.id, 'G54', { x: 0, y: 0, z: 0 }, 'not-sent')
    await connectSimulatorWith(sample)
    __resetEstopInterlockForTest()
    loadMachineProgram('final-o9-comments-first.nc', PLAIN_FILE, null)
    expect(getMachineController().homeAxes?.(['X', 'Y', 'Z'])).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    // Offsets tab: type the new zero and Push, axis by axis.
    for (const [axis, value] of [['X', -250], ['Y', -240], ['Z', -60]] as const) {
      expect(setWorkOffsetValue('G54', axis, value)).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(liveG54()?.slice(0, 3)).toEqual([-250, -240, -60])
    // WO-3184 validates the stored zero at Load. The initial zero was outside
    // travel, as were the partially edited zeros. Those console errors are history.
    const priorErrors = useMachineControl.getState().consoleLines.filter(line => line.severity === 'error')
    expect(priorErrors.length).toBeGreaterThan(0)
    expect(priorErrors.every(line => /program range .* exceeds soft limits/.test(line.text))).toBe(true)

    expect(await executeOperatorCycleStart()).toBe(true)
    const errors = useMachineControl.getState().consoleLines
      .filter((line) => line.severity === 'error')
      .map((line) => line.text)
      .slice(priorErrors.length)
    expect(errors, JSON.stringify(errors)).toEqual([])
    // It runs at the new zero: the first rapid lands at work Z15 = machine Z -45.
    await vi.advanceTimersByTimeAsync(3_000)
    const touched = getMachineController().status().machinePos
    expect(touched!.z).toBeLessThanOrEqual(-45 + 1e-6)
  })
})

describe('WO-2712 review: sample GRBL convention does not place a native bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useCamStore.setState(initial, true)
    useMachineControl.setState({ ...initialControl, consoleLines: [] })
    bridgeVerbs = []
  })

  afterEach(async () => {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
    vi.useRealTimers()
    useCamStore.setState(initial, true)
  })

  async function connectBridge(machine: MachineConfig): Promise<void> {
    useCamStore.setState({ project: { ...initial.project, machine }, machineLibrary: [machine] })
    const pending = connectMachine('bridge')
    await vi.advanceTimersByTimeAsync(350)
    await pending
    pushBridgeStatus()
    await vi.advanceTimersByTimeAsync(50)
    __resetEstopInterlockForTest()
    bridgeVerbs = []
    expect(getMachineController().status().machinePos).toEqual(bridgePosition)
    expect(liveG54()?.slice(0, 3)).toEqual([200, 200, 30])
  }

  it('stages, starts and completes MDI to the bridge-reported current position without a new refusal', async () => {
    await connectBridge({ ...initial.project.machine, controller: 'uccnc' })
    expect(sendMdiLine('G0 X5 Y75 Z10')).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(bridgeVerbs).toContain('loadMoves')
    expect(bridgeVerbs).toContain('startJob')
    bridgeEvents?.onMessage({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    await vi.advanceTimersByTimeAsync(50)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(useMachineControl.getState().consoleLines.filter((line) => line.severity === 'error')).toEqual([])
    // The saved sample record and simulator defaults remain intact.
    expect(useCamStore.getState().project.machine.homeConvention).toEqual(initial.project.machine.homeConvention)
  })

  it('still enforces explicitly stated native controller limits', async () => {
    const definition = createDefaultControllerDefinition()
    definition.axes = definition.axes.map((axis) => ({ ...axis, softLimitMin: 0, softLimitMax: 100 }))
    definition.stated = definition.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const, key: axisSoftLimitStatementKey(axis.axis, end),
    })))
    await connectBridge({ ...initial.project.machine, controller: 'uccnc', controllerDefinition: definition })
    expect(currentResolvedMachineMotion().envelope.x).toMatchObject({ min: 0, max: 100 })
    expect(sendMdiLine('G0 X5 Y75 Z10')).toBe(false)
    expect(bridgeVerbs).not.toContain('loadMoves')
    expect(bridgeVerbs).not.toContain('startJob')
  })

  // The judges' demonstrated cases, kept together (Rholand 10-09 7:40 PM): review 2 (loaded file on the
  // native bridge), audit 3 (any non-GRBL controller - same resolver input as here), audit 4 (operator-saved max/max).
  it('review 2: a loaded file asking for the bridge-reported position gets no travel refusal (main behaviour)', async () => {
    await connectBridge({ ...initial.project.machine, controller: 'uccnc' })
    expect(currentResolvedMachineMotion().envelope.x).toBeNull()
    loadMachineProgram('here.nc', ['G21 G90', 'G53 G0 X205 Y275 Z40', 'M2', ''].join('\n'))
    await vi.advanceTimersByTimeAsync(50)
    expect(transferReview().result.refusals).toEqual([])
  })

  it('audit 4: an operator-saved max/max on the native sample record supplies the stated envelope', async () => {
    const homeConvention = {
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'max', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    } as const
    await connectBridge({ ...initial.project.machine, controller: 'uccnc', homeConvention })
    expect(useCamStore.getState().project.machine.homeConvention).toEqual(homeConvention)
    expect(currentResolvedMachineMotion().envelope.x).toMatchObject({ min: -406, max: 0 })
    expect(currentResolvedMachineMotion().envelope.z).toMatchObject({ min: -95, max: 0 })
  })

  it('retains a custom home convention on a sample-derived native profile', async () => {
    const homeConvention = {
      x: { homesToward: 'max', machineZeroAt: 'min' },
      y: { homesToward: 'max', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'min' },
    } as const
    await connectBridge({ ...initial.project.machine, controller: 'uccnc', homeConvention })
    expect(currentResolvedMachineMotion().envelope.x).toMatchObject({ min: 0, max: 406 })
    expect(sendMdiLine('G0 X5 Y75 Z10')).toBe(true)
  })
})
