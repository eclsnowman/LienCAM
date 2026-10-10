// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMachineControl } from '../../store/machineControlStore'
import {
  __resetEstopInterlockForTest,
  getMachineController,
  triggerEmergencyStop,
} from '../../lib/machine/machineSession'
import { executePendantMachineCommand } from '../../lib/machine/pendantMachine'
import type { PendantCommand } from '../../lib/machine/pendantBridge'

const context = { clientId: 'phone-a', emit: vi.fn() }

async function execute(command: PendantCommand) {
  return executePendantMachineCommand(command, context)
}

describe('production pendant machine adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    __resetEstopInterlockForTest()
    context.emit.mockClear()
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      activeWcs: 'G54',
    })
  })

  afterEach(() => {
    __resetEstopInterlockForTest()
    vi.restoreAllMocks()
    useMachineControl.setState({ connectionPhase: 'disconnected', machineState: 'unknown' })
  })

  it('routes a valid remote step jog through the existing controller', async () => {
    const jog = vi.spyOn(getMachineController(), 'jog').mockReturnValue(true)
    const result = await execute({ kind: 'jog-step', axis: 'X', deltaMm: -2, feedMmMin: 600 })
    expect(result).toEqual({ ok: true })
    expect(jog).toHaveBeenCalledWith('X', -2, 600)
  })

  it('blocks remote motion while the desktop E-stop latch needs reset', async () => {
    vi.spyOn(getMachineController(), 'emergencyStop').mockImplementation(() => undefined)
    const jog = vi.spyOn(getMachineController(), 'jog').mockReturnValue(true)
    triggerEmergencyStop()
    const result = await execute({ kind: 'jog-step', axis: 'Y', deltaMm: 1, feedMmMin: 500 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Reset the desktop E-stop')
    expect(jog).not.toHaveBeenCalled()
  })

  it('keeps feed hold immediately available even while motion is interlocked', async () => {
    vi.spyOn(getMachineController(), 'emergencyStop').mockImplementation(() => undefined)
    const hold = vi.spyOn(getMachineController(), 'feedHold').mockImplementation(() => undefined)
    triggerEmergencyStop()
    expect(await execute({ kind: 'feed-hold' })).toEqual({ ok: true })
    expect(hold).toHaveBeenCalledOnce()
  })

  it('rejects unsupported override values without touching the controller', async () => {
    // WO-422: the pendant sends OverrideChange now, not GRBL realtime bytes.
    const override = vi.spyOn(getMachineController(), 'setOverride').mockImplementation(() => undefined)
    const result = await execute({ kind: 'override', channel: 'rapid', value: 75 })
    expect(result).toEqual({ ok: false, error: 'Rapid override must be 25%, 50%, or 100%.' })
    expect(override).not.toHaveBeenCalled()
  })

  it('requires an explicit clear-path confirmation before any probe plan runs', async () => {
    const result = await execute({
      kind: 'probe-start',
      routineId: 'bore',
      params: {
        probeFeed: 80,
        searchTravel: 20,
        tipRadius: 2,
        nominalSize: 30,
        edgeAxis: 'X',
        edgeDirection: '-',
        pathClearConfirmed: false,
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Confirm that the probe and positioning path are clear')
  })
})
