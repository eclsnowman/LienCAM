import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMachineControl } from '../../store/machineControlStore'
import {
  __resetEstopInterlockForTest,
  getMachineController,
  isProbeCycleActive,
  runFeatureProbeCycle,
} from '../../lib/machine/machineSession'
import type { ProbeFeatureCyclePlan } from '../../lib/machine/probeFeatureCycle'
import { resolveProbeConfig } from '../../lib/machine/toolTable'
import type { CommandAck } from '../../lib/machine/grbl/controller'
import type { JogAxis, MachineController } from '../../lib/machine/controller'

const ACK: CommandAck = { ok: true, code: 0, message: 'ok' }
const config = resolveProbeConfig(null, {
  positioningFeed: 1200,
  fastFeed: 300,
  slowFeed: 40,
  retract: 2,
  maxTravel: 30,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
})

const plan: ProbeFeatureCyclePlan = {
  kind: 'bore',
  expectedCenter: { x: 100, y: 100, z: 20 },
  searchTravelMm: 10,
  stepOffMm: 2,
  summary: 'test plan',
  review: {
    touchOrder: [{ key: 'xNegative', axis: 'X', direction: '-' }],
    approachClearanceMm: 5,
    positioningFeedMmMin: 1200,
    searchFeedMmMin: 300,
    probeFeedMmMin: 40,
    clearMotion: { kind: 'bore-center', center: { x: 100, y: 100, z: 20 } },
  },
  steps: [
    {
      kind: 'touch',
      key: 'xNegative',
      label: 'Probe xNegative',
      axis: 'X',
      direction: '-',
      travelMm: 10,
      expectedStart: { x: 100, y: 100, z: 20 },
    },
    {
      kind: 'position',
      label: 'Return toward start after xNegative',
      target: { x: 100, y: 100, z: 20 },
      axes: ['X', 'Y'],
    },
  ],
}

function connectedIdleController() {
  const ctrl = getMachineController()
  vi.spyOn(ctrl, 'connectionPhase').mockReturnValue('connected')
  vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(false)
  vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
  vi.spyOn(ctrl, 'homedThisSession').mockReturnValue(true)
  vi.spyOn(
    ctrl as MachineController & { homedAxesThisSession(): Partial<Record<JogAxis, boolean>> },
    'homedAxesThisSession',
  ).mockReturnValue({ X: true, Y: true, Z: true })
  vi.spyOn(ctrl, 'sendCommand').mockReturnValue(true)
  vi.spyOn(ctrl, 'refreshState').mockReturnValue(true)
  return ctrl
}

beforeEach(() => {
  __resetEstopInterlockForTest()
  useMachineControl.setState({ probe: null })
  connectedIdleController()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WO-372 atomic feature probe execution', () => {
  it('uses positioning, search, and final probe feeds in one locked sequence', async () => {
    const lines: string[] = []
    let probePass = 0
    vi.spyOn(getMachineController(), 'sendCommandAwait').mockImplementation((line) => {
      lines.push(line)
      if (line.includes('G38.2') && ++probePass === 2) {
        useMachineControl.setState({ probe: { values: [81.25, 0, 0], success: true } })
      }
      return Promise.resolve(ACK)
    })

    const landed: Array<[string, number]> = []
    const result = await runFeatureProbeCycle(plan, config, true, (key, value) => {
      landed.push([key, value])
    })

    expect(result).toMatchObject({ ok: true, touches: { xNegative: 81.25 } })
    expect(landed).toEqual([['xNegative', 81.25]])
    expect(lines).toEqual([
      'G21 G91 G38.2 X-10 F300',
      'G91 G0 X2',
      'G91 G38.2 X-4 F40',
      'G91 G0 X2',
      'G21 G90 G53 G1 X100 Y100 F1200',
    ])
    expect(isProbeCycleActive()).toBe(false)
  })

  it('holds the probe authority lock during clear positioning as well as contact', async () => {
    let release!: (ack: CommandAck) => void
    const firstMove = new Promise<CommandAck>((resolve) => { release = resolve })
    vi.spyOn(getMachineController(), 'sendCommandAwait').mockReturnValueOnce(firstMove)

    const pending = runFeatureProbeCycle(plan, config, true)
    expect(isProbeCycleActive()).toBe(true)
    release({ ok: false, code: 9, message: 'stopped for test' })
    const result = await pending

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Probe xNegative stopped')
    expect(isProbeCycleActive()).toBe(false)
  })

  it('sends no command until the operator confirms the clear path', async () => {
    const send = vi.spyOn(getMachineController(), 'sendCommandAwait')
    const result = await runFeatureProbeCycle(plan, config, false)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Confirm')
    expect(send).not.toHaveBeenCalled()
  })
})
