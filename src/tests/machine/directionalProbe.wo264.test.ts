import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMachineControl } from '../../store/machineControlStore'
import {
  __resetEstopInterlockForTest,
  getMachineController,
  isProbeCycleActive,
  runDirectionalProbeTouch,
  type ProbeAxis,
  type ProbeDirection,
} from '../../lib/machine/machineSession'
import type { CommandAck } from '../../lib/machine/grbl/controller'
import type { ZProbeConfig } from '../../lib/machine/toolTable'

const CONFIG: ZProbeConfig = {
  fastFeed: 120,
  slowFeed: 30,
  retract: 2,
  maxTravel: 12,
  padThickness: 5,
}
const ACK: CommandAck = { ok: true, code: 0, message: 'ok' }

function fakeConnectedIdleController() {
  const ctrl = getMachineController()
  vi.spyOn(ctrl, 'connectionPhase').mockReturnValue('connected')
  vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(false)
  vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
  vi.spyOn(ctrl, 'sendCommand').mockReturnValue(true)
  vi.spyOn(ctrl, 'refreshState').mockReturnValue(true)
  return ctrl
}

function fakeSuccessfulTouch(axis: ProbeAxis, position: number) {
  const ctrl = getMachineController()
  const lines: string[] = []
  let probePass = 0
  vi.spyOn(ctrl, 'sendCommandAwait').mockImplementation((line) => {
    lines.push(line)
    if (line.includes('G38.2') && ++probePass === 2) {
      const values = [0, 0, 0]
      values[axis === 'X' ? 0 : axis === 'Y' ? 1 : 2] = position
      useMachineControl.setState({ probe: { values, success: true } })
    }
    return Promise.resolve(ACK)
  })
  return lines
}

beforeEach(() => {
  __resetEstopInterlockForTest()
  useMachineControl.setState({ probe: null })
  fakeConnectedIdleController()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runDirectionalProbeTouch signed motion', () => {
  it.each<{
    label: string
    axis: ProbeAxis
    direction: ProbeDirection
    position: number
    probeWord: string
    retractWord: string
  }>([
    { label: 'X+', axis: 'X', direction: '+', position: 8.25, probeWord: 'X', retractWord: 'X-' },
    { label: 'X-', axis: 'X', direction: '-', position: -9.5, probeWord: 'X-', retractWord: 'X' },
    { label: 'Y+', axis: 'Y', direction: '+', position: 6.75, probeWord: 'Y', retractWord: 'Y-' },
    { label: 'Y-', axis: 'Y', direction: '-', position: -7.125, probeWord: 'Y-', retractWord: 'Y' },
    { label: 'Z-', axis: 'Z', direction: '-', position: -40, probeWord: 'Z-', retractWord: 'Z' },
  ])('$label sends signed fast, retract, slow, and final retract commands', async (probe) => {
    const lines = fakeSuccessfulTouch(probe.axis, probe.position)

    const result = await runDirectionalProbeTouch(probe.axis, probe.direction, CONFIG)

    expect(lines).toEqual([
      `G21 G91 G38.2 ${probe.probeWord}12 F120`,
      `G91 G0 ${probe.retractWord}2`,
      `G91 G38.2 ${probe.probeWord}4 F30`,
      `G91 G0 ${probe.retractWord}2`,
    ])
    expect(result).toMatchObject({ ok: true, probedMachinePosition: probe.position })
  })

  it('reads the non-Z trigger coordinate from the PRB report', async () => {
    fakeSuccessfulTouch('Y', 17.375)

    const result = await runDirectionalProbeTouch('Y', '+', CONFIG)

    expect(result.ok).toBe(true)
    expect(result.probedMachinePosition).toBe(17.375)
    expect(result.message).toContain('machine Y 17.38 mm')
  })
})

describe('runDirectionalProbeTouch fail-loud behavior', () => {
  it.each([
    ['X', '+'],
    ['Y', '-'],
    ['Z', '-'],
  ] as const)('fails without a position when %s misses its PRB contact', async (axis, direction) => {
    vi.spyOn(getMachineController(), 'sendCommandAwait').mockResolvedValue(ACK)

    const result = await runDirectionalProbeTouch(axis, direction, CONFIG)

    expect(result.ok).toBe(false)
    expect(result.probedMachinePosition).toBeNull()
    expect(result.message).toContain('[PRB]')
  })

  it('fails loudly when a non-Z probe command is refused', async () => {
    vi.spyOn(getMachineController(), 'sendCommandAwait').mockReturnValue(null)

    const result = await runDirectionalProbeTouch('X', '+', CONFIG)

    expect(result).toEqual({
      ok: false,
      message: 'The controller refused the probe command.',
      probedMachinePosition: null,
    })
  })

  it('fails loudly when a non-Z probe command receives a failed acknowledgement', async () => {
    // WO-422: sendCommandAwait is typed by the CONTRACT now ({ ok, message }).
    // GRBL's own ack still carries `code`; nothing in the probe runner reads
    // it, so the mock states only what the contract promises.
    vi.spyOn(getMachineController(), 'sendCommandAwait').mockResolvedValue({
      ok: false,
      message: 'Probe fail',
    })

    const result = await runDirectionalProbeTouch('Y', '-', CONFIG)

    expect(result.ok).toBe(false)
    expect(result.probedMachinePosition).toBeNull()
    expect(result.message).toContain('never made contact within 12.00 mm (Probe fail)')
    expect(result.message).toContain('Unlock ($X)')
  })

  it('holds probeCycleActive for the whole non-Z touch and clears it afterward', async () => {
    let releaseFast!: (ack: CommandAck) => void
    const fastAck = new Promise<CommandAck>((resolve) => {
      releaseFast = resolve
    })
    let call = 0
    vi.spyOn(getMachineController(), 'sendCommandAwait').mockImplementation((line) => {
      call++
      if (call === 1) return fastAck
      if (line.includes('G38.2')) {
        useMachineControl.setState({ probe: { values: [3.5, 0, 0], success: true } })
      }
      return Promise.resolve(ACK)
    })

    const pending = runDirectionalProbeTouch('X', '+', CONFIG)
    expect(isProbeCycleActive()).toBe(true)

    releaseFast(ACK)
    const result = await pending

    expect(result.ok).toBe(true)
    expect(isProbeCycleActive()).toBe(false)
  })
})
