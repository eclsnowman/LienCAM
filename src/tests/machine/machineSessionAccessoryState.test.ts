import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectMachine,
  disconnectMachine,
  getMachineController,
} from '../../lib/machine/machineSession'
import { useMachineControl } from '../../store/machineControlStore'

const OFF = { spindle: 'off', flood: false, mist: false } as const

describe('machineSession accessory state integration', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
  })

  afterEach(async () => {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  async function command(line: string) {
    expect(getMachineController().sendCommand(line)).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
  }

  // WO-1201: this used to send `M4 S1200` and expect `ccw`, on a simulator that
  // ignored the machine definition. The seeded machine is `spindleDirection:
  // 'cw'` (liencncSeed.ts) and the simulator now refuses a direction its machine
  // cannot do, so `M4` here would be asserting that the simulator accepts a
  // command the real machine rejects - the opposite of what a simulator is for.
  // What this case exists to prove is the A-field -> store hand-off, which M3
  // proves exactly as well. The `ccw` field mapping itself stays pinned one
  // layer down, on the wire, in grblLines.test.ts.
  it('forwards simulator A: spindle and coolant fields into reported store state', async () => {
    await command('M3 S1200')
    await command('M8')

    getMachineController().queryStatus()
    await vi.advanceTimersByTimeAsync(10)

    expect(useMachineControl.getState().reportedAccessories).toEqual({
      spindle: 'cw',
      flood: true,
      mist: false,
    })
  })

  // WO-433: this used to pin a wire-protocol nuance - real GRBL's status
  // report only carries an `A:` field when the NEXT poll happens to catch
  // it, so a bare parser-state refresh (no fresh status report) genuinely
  // could leave `reportedAccessories` lagging behind `commandedAccessories`
  // for a real (or GRBL-emulating) connection. The native SimulatedController
  // this WO switched the simulator to has no wire at all (its own file
  // header: "pure software... there is no wire between them") - WO-434
  // deliberately made its MDI M-word handling raise onAccessories in the
  // SAME instant the command is parsed (simulatedControllerMdi.wo434.test.ts
  // pins exactly this: "M3/M4/M5 drive the spindle immediately... not only
  // inside a loaded program"), so `reportedAccessories` is never stale
  // against `commandedAccessories` under the simulator - there is nothing
  // for it to lag behind. Keeping the old expectation here would mean
  // pinning a staleness this controller cannot produce.
  it('reports accessories in the same instant they are commanded - no wire, nothing to lag behind', async () => {
    expect(useMachineControl.getState().reportedAccessories).toEqual(OFF)
    await command('M8')

    expect(getMachineController().refreshState()).toBe(true)
    await vi.advanceTimersByTimeAsync(10)

    const state = useMachineControl.getState()
    expect(state.commandedAccessories).toEqual({ spindle: 'off', coolant: 'flood' })
    expect(state.reportedAccessories).toEqual({ spindle: 'off', flood: true, mist: false })
  })
})
