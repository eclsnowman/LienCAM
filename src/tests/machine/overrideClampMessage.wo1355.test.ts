import { beforeEach, describe, expect, it } from 'vitest'
import type { ControllerEvents, MachineStatus, OverrideChange } from '../../lib/machine/controller'
import { buildContractEvents } from '../../lib/machine/machineSession'
import { useMachineControl } from '../../store/machineControlStore'

type OverrideKind = OverrideChange['kind']

function status(overrides: NonNullable<MachineStatus['overrides']>): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: null,
    workPos: null,
    feedMmMin: null,
    spindleRpm: null,
    overrides,
    executingMoveId: null,
    buffer: null,
    inputs: null,
    homed: null,
    spindle: null,
  }
}

function staleClampNotice(
  events: ControllerEvents,
  kind: OverrideKind,
  previous: number,
  requested: number,
): void {
  events.onConsole?.({
    dir: 'rx',
    severity: 'warn',
    text: `the controller clamped the ${kind} override to ${previous}% (asked for ${requested}%)`,
  })
}

function consoleText(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

beforeEach(() => {
  useMachineControl.setState({ consoleLines: [] })
})

describe('WO-1355 override clamp message uses the status readback for this press', () => {
  it('says nothing when the board reports the requested override', () => {
    const events = buildContractEvents()

    staleClampNotice(events, 'feed', 100, 90)
    expect(consoleText()).toEqual([])

    events.onStatus?.(status({ feed: 90, rapid: null, spindle: 100 }))

    expect(consoleText()).toEqual([])
  })

  it('reports one genuine clamp with the value the board actually holds', () => {
    const events = buildContractEvents()

    staleClampNotice(events, 'feed', 90, 110)
    events.onStatus?.(status({ feed: 100, rapid: null, spindle: 100 }))
    events.onStatus?.(status({ feed: 100, rapid: null, spindle: 100 }))

    expect(consoleText()).toEqual([
      'the controller clamped the feed override to 100% (asked for 110%)',
    ])
  })

  it('does not compare any of four successive requests with the preceding readback', () => {
    const events = buildContractEvents()
    const sequence = [
      { previous: 100, requested: 90 },
      { previous: 90, requested: 100 },
      { previous: 100, requested: 110 },
      { previous: 110, requested: 100 },
    ]

    for (const press of sequence) {
      staleClampNotice(events, 'feed', press.previous, press.requested)
      events.onStatus?.(status({ feed: press.requested, rapid: null, spindle: 100 }))
    }

    expect(consoleText()).toEqual([])
  })
})
