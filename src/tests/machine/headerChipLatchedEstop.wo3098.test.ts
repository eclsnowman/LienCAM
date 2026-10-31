// @vitest-environment jsdom
//
// WO-3098: The header machine chip never says Ready while a stop is latched.
//
// owner 2026-10-23 ("Yes" to CT-16): on the controller kit the top-right chip
// stayed green "Ready" while the Control state chip read E-STOP; the browser
// simulator turned it red only because its controller reports `alarm` after a
// stop. The latch itself is the session's (machineSession estopTripNeedsReset),
// shared by every controller route, so the chip must read it rather than wait
// for a controller to say `alarm`.
//
// Routes are modelled by what their controller reports while the latch is up:
//   - browser simulator / GRBL: `alarm`
//   - SimUC100 kit, UC100/AXBB-E bridge (repro k2-homed-estop-chips.json): `idle`
//   - a bridge frame with the board E-STOP in, or LinuxCNC estop: `unknown`
//   - a stop pressed mid-program: `hold` with the job still `paused`/`streaming`

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { deriveMachineChip, type MachineChipFacts } from '../../lib/machine/machineChip'
import type { MachineState } from '../../lib/machine/types'
import type { StreamerPhase, MachineController } from '../../lib/machine/controller'
import {
  __armEstopInterlockForTest,
  __resetEstopInterlockForTest,
  estopTripNeedsReset,
  getMachineController,
} from '../../lib/machine/machineSession'
import { machineStateChipLabel } from '../../components/machine/ControlTransportBar'
import { MachineStatusChip } from '../../components/toolbar/MachineStatusChip'
import { useMachineControl } from '../../store/machineControlStore'

const HOMED = { X: true, Y: true, Z: true }
const UNHOMED = { X: false, Y: true, Z: true }

function resolver(axes: Record<string, boolean>) {
  return { homedThisSession: () => Object.values(axes).every(Boolean), homedAxesThisSession: () => axes }
}

function facts(overrides: Partial<MachineChipFacts>): MachineChipFacts {
  return { connectionPhase: 'connected', machineState: 'idle', jobPhase: 'ready', datumResolver: resolver(HOMED), ...overrides }
}

const ROUTES: Array<{ route: string, machineState: MachineState, jobPhase: StreamerPhase }> = [
  { route: 'browser simulator', machineState: 'alarm', jobPhase: 'ready' },
  { route: 'GRBL', machineState: 'alarm', jobPhase: 'ready' },
  { route: 'SimUC100 kit bridge', machineState: 'idle', jobPhase: 'ready' },
  { route: 'UC100/AXBB-E bridge', machineState: 'idle', jobPhase: 'ready' },
  { route: 'bridge frame with board E-STOP in', machineState: 'unknown', jobPhase: 'ready' },
  { route: 'LinuxCNC estop', machineState: 'unknown', jobPhase: 'ready' },
  { route: 'stop mid-program (held)', machineState: 'hold', jobPhase: 'paused' },
  { route: 'stop mid-program (streamer not yet settled)', machineState: 'idle', jobPhase: 'streaming' },
]

const DATUM = [
  { datum: 'homed', axes: HOMED },
  { datum: 'not homed', axes: UNHOMED },
]

describe('WO-3098 header chip derivation: a latched stop outranks every other reading', () => {
  for (const { route, machineState, jobPhase } of ROUTES) {
    for (const { datum, axes } of DATUM) {
      it(`${route}, ${datum}, latched -> red E-STOP`, () => {
        expect(deriveMachineChip(facts({ machineState, jobPhase, datumResolver: resolver(axes), estopTripped: true })))
          .toEqual({ state: 'alarm', label: 'E-STOP' })
      })
    }
  }

  it('latched also outranks an M0 hold, a tool-change card and a stopped probe run', () => {
    expect(deriveMachineChip(facts({ estopTripped: true, programM0Held: true, jobPhase: 'paused' })))
      .toEqual({ state: 'alarm', label: 'E-STOP' })
    expect(deriveMachineChip(facts({ estopTripped: true, toolChangeWaiting: true })))
      .toEqual({ state: 'alarm', label: 'E-STOP' })
    expect(deriveMachineChip(facts({ estopTripped: true, probeRunStopped: true })))
      .toEqual({ state: 'alarm', label: 'E-STOP' })
  })

  it('a departed connection still reads Offline, never a stale E-STOP', () => {
    expect(deriveMachineChip(facts({ connectionPhase: 'disconnected', estopTripped: true })))
      .toEqual({ state: 'offline', label: 'Offline' })
  })

  it.each(DATUM)('clear latch, $datum: the chip returns to the machine reading', ({ axes }) => {
    const expected = axes === HOMED ? { state: 'ready', label: 'Ready' } : { state: 'not-homed', label: 'Not homed' }
    expect(deriveMachineChip(facts({ datumResolver: resolver(axes), estopTripped: false }))).toEqual(expected)
    expect(deriveMachineChip(facts({ datumResolver: resolver(axes) }))).toEqual(expected)
  })

  it('a controller alarm without a latched stop still reads Alarm', () => {
    expect(deriveMachineChip(facts({ machineState: 'alarm', estopTripped: false })))
      .toEqual({ state: 'alarm', label: 'Alarm' })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  __resetEstopInterlockForTest()
})

describe('WO-3098 rendered header chip reads the session latch', () => {
  function mount(axes: Record<string, boolean>) {
    const controller = getMachineController() as MachineController & Required<Pick<MachineController, 'homedAxesThisSession'>>
    vi.spyOn(controller, 'homedAxesThisSession').mockReturnValue(axes)
    vi.spyOn(controller, 'homedThisSession').mockReturnValue(Object.values(axes).every(Boolean))
    const job = useMachineControl.getState().job
    __resetEstopInterlockForTest()
    // The kit repro: the controller keeps reporting `idle` behind the latch.
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle', job: { ...job, phase: 'ready' } })
    render(createElement(MachineStatusChip))
    return screen.getByTestId('machine-status-chip')
  }

  it.each(DATUM)('$datum: Ready/Not homed -> E-STOP on the trip -> back on the reset', ({ axes }) => {
    const chip = mount(axes)
    const clear = axes === HOMED ? 'ready' : 'not-homed'
    expect(chip.getAttribute('data-state')).toBe(clear)

    act(() => __armEstopInterlockForTest())
    expect(estopTripNeedsReset()).toBe(true)
    expect(chip.getAttribute('data-state')).toBe('alarm')
    // Same words as the Control state chip beside it.
    const controlWords = machineStateChipLabel({ machineState: 'idle', softLimitLatched: false, estopTripped: true })
    expect(chip.textContent).toBe(controlWords)
    expect(chip.getAttribute('aria-label')).toBe(`Machine status: ${controlWords}`)

    act(() => __resetEstopInterlockForTest())
    expect(chip.getAttribute('data-state')).toBe(clear)
  })
})
