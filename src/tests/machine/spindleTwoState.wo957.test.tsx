// @vitest-environment jsdom
// WO-957, AS AMENDED BY WO-964 - Operator's ruling, not a fix.
//
// WO-957 removed the Off button from BOTH groups on his first instruction
// ("Remove off... Change to a two state button"). He then looked at it and
// ruled again:
//
//   "OK we can leave off button on spindle. But spindle only. All others are
//    two state buttons. Figure it out."
//
// So the shape is now:
//   SPINDLE   CW / CCW / OFF   three buttons, Off restored, NOT two-state
//   COOLANT   Mist / Flood     two-state, exactly as WO-957 landed it
//
// WHAT WAS DELETED WITH IT, and why this file no longer asserts it: WO-957 also
// added a rule Operator's words did not cover - a press was a stop whenever the
// button was lit OR the machine reported the spindle running. He challenged
// both premises it rested on and the record supports him:
//
//   - "the drive reports direction backwards" overstated VFD-COMMISSIONING 4.9,
//     which measured the STATUS REGISTER returning the opposite of the command
//     with rotation verified correct by eye, and concluded only "never infer
//     direction from that register". A VFD drives phase order and has no notion
//     of clockwise; CW/CCW is a label fixed by swapping two motor leads.
//   - "running when we did not start it" is not his machine: the drive is in
//     remote mode and only this software starts it.
//
// With Off on the panel there is always an unconditional stop, so the clause
// was solving a problem the button solves directly. The tests that PROVED that
// clause are RETIRED below, named, with the reason - not silently dropped.
//
// WHAT SURVIVES UNCHANGED: WO-474's fix. The latch still follows what the
// machine DID, never what was requested, and that is asserted here with a
// refusal injected.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { create } from 'zustand'
// Imported BEFORE SpindlePanel below on purpose: it transitively imports
// machineSession/machineControlStore, which triggers this file's mock
// factories during ITS static-import resolution. A `typedMock` import placed
// after it left a factory closing over a binding not yet initialized -
// "Cannot access '__vi_import_N__' before initialization" (see
// holderClearance3d.wo278.test.ts).
import { typedMock } from '../support/typedMock'
import { SpindlePanel } from '../../components/machine/SpindlePanel'
import type { MachineActionResult, SpindleCommandResult, SpindleRoute } from '../../lib/machine/machineSession'
import type {
  ConnectionPhase, LoadOutcome, MachineController, MachineState, MachineStatus, StreamerProgress,
} from '../../lib/machine/controller'

let reportedRunning: boolean | null = null

// TYPED TO THE PRODUCT CONTRACT, not to its first return value (WO-960).
const commandSpindle = vi.fn(
  (..._args: unknown[]): SpindleCommandResult => ({ ok: true, route: 'calls' }),
)
const runMachineAction = vi.fn((..._args: unknown[]): MachineActionResult => ({ ok: true, sent: 1 }))
const estopNeedsReset = vi.fn(() => false)

/** A full MachineController stub - see collapsedSummaryTruth.wo959.test.tsx's
 *  stubMachineController for why this must be the whole interface. */
function stubMachineController(): MachineController {
  const jobProgress: StreamerProgress = {
    phase: 'empty', totalLines: 0, sentLines: 0, ackedLines: 0,
    ackedSourceLine: 0, sentSourceLine: 0, bytesInFlight: 0,
  }
  return {
    capabilities: {
      geometryQueue: false, executingMoveId: false, bufferSeconds: false,
      gcodeText: false, perAxisHoming: false, ownsSpindle: false, spindleCommands: false,
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    connectionPhase: vi.fn((): ConnectionPhase => 'connected'),
    firmwareVersion: vi.fn(() => null),
    machineState: vi.fn((): MachineState => 'idle'),
    status: vi.fn((): MachineStatus => ({
      state: 'idle', subState: null, machinePos: null, workPos: null, feedMmMin: null, spindleRpm: null,
      overrides: null, executingMoveId: null, buffer: null, inputs: null, homed: null,
      spindle:
        reportedRunning === null
          ? null
          : {
            volts: null, amps: null, torque: null, power: null,
            upToSpeed: null, running: reportedRunning, linkUp: null,
          },
    })),
    queryStatus: vi.fn(),
    refreshState: vi.fn(() => true),
    querySettings: vi.fn(() => true),
    verifiedIdle: vi.fn(() => true),
    homedThisSession: vi.fn(() => false),
    resetInProgress: vi.fn(() => false),
    subscribeResetInProgress: vi.fn(() => () => {}),
    jog: vi.fn(() => true),
    jogToWorkXY: vi.fn(() => true),
    jogToMachineZ: vi.fn(() => true),
    jogCancel: vi.fn(),
    home: vi.fn(() => true),
    feedHold: vi.fn(),
    cycleResume: vi.fn(() => true),
    reset: vi.fn(),
    unlock: vi.fn(() => true),
    emergencyStop: vi.fn(),
    resetToIdle: vi.fn(async () => ({ ok: true, reason: null })),
    setOverride: vi.fn(),
    selectWcs: vi.fn(() => true),
    zeroWorkAxis: vi.fn(() => true),
    probe: vi.fn(async () => ({ ok: true, at: null })),
    sendCommand: vi.fn(() => true),
    sendCommandAwait: vi.fn(async () => ({ ok: true, message: null })),
    loadJob: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    loadJobFrom: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    startJob: vi.fn(() => true),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(() => true),
    stopJob: vi.fn(),
    stepJob: vi.fn(() => true),
    setSingleBlockMode: vi.fn(),
    singleBlockMode: vi.fn(() => false),
    hasActiveJob: vi.fn(() => false),
    jobProgress: vi.fn(() => jobProgress),
    stoppedJobProgress: vi.fn(() => null),
  }
}

vi.mock('../../lib/machine/machineSession', () => typedMock<typeof import('../../lib/machine/machineSession')>({
  // WO-2237: SpindlePanel reads the tool-change hold and the kept-pause verdict.
  subscribeToolChangeHold: () => () => {},
  toolChangeHoldActive: () => false,
  subscribePausedProgramTakesCommands: () => () => {},
  pausedProgramTakesCommands: () => false,
  getMachineController: vi.fn(() => stubMachineController()),
  runMachineAction: (...args: unknown[]) => runMachineAction(...args),
  spindleRoute: vi.fn((): SpindleRoute => 'calls'),
  commandSpindle: (...args: unknown[]) => commandSpindle(...args),
  estopNeedsReset: () => estopNeedsReset(),
  ESTOP_BLOCKS_MOTION: 'The software stop is latched. Press CLEAR to reset it.',
  SPINDLE_REFUSAL: {
    estop: 'The software stop is latched. Press CLEAR to reset it.',
    unsupported: 'This controller has no spindle control.',
    controllerRefused: 'The controller would not start the spindle.',
    notSent: 'The spindle command could not be sent to the machine.',
  },
}))

// vi.hoisted: a mock's transitive resolution can fire during an EARLIER
// static import's own resolution (SpindlePanel's, here), which runs before
// ANY of this file's own top-level code - a plain `const` below the factory
// that references it would be a TDZ crash ("Cannot access 'pushConsole'
// before initialization"), same class of bug as the import-order note above.
const pushConsole = vi.hoisted(() => vi.fn())
vi.mock('../../store/machineControlStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/machineControlStore')>()
  const initial = actual.useMachineControl.getState()
  return typedMock<typeof import('../../store/machineControlStore')>({
    ...actual,
    useMachineControl: create<typeof initial>()(() => ({
      ...initial,
      connectionPhase: 'connected',
      job: { ...initial.job, phase: 'empty' },
      spindleRpm: null,
      reportedAccessories: { spindle: 'off', mist: false, flood: false },
      pushConsole,
    })),
  })
})

const cw = () => screen.getByTestId('control-spindle-cw')
const ccw = () => screen.getByTestId('control-spindle-ccw')
const off = () => screen.getByTestId('control-spindle-off')
const mist = () => screen.getByTestId('control-coolant-mist')
const flood = () => screen.getByTestId('control-coolant-flood')
const lit = (el: HTMLElement) => el.className.includes('control-latched')
const litCount = (sel: string) =>
  document.querySelector(sel)!.querySelectorAll('.control-latched').length

afterEach(cleanup)
beforeEach(() => {
  reportedRunning = null
  pushConsole.mockReset()
  commandSpindle.mockReset()
  commandSpindle.mockReturnValue({ ok: true, route: 'calls' })
  runMachineAction.mockReset()
  runMachineAction.mockReturnValue({ ok: true, sent: 1 })
  estopNeedsReset.mockReset()
  estopNeedsReset.mockReturnValue(false)
})

describe('WO-964: the spindle keeps its Off; the coolant does not have one', () => {
  it('spindle has CW/CCW/Off, coolant has Mist/Flood only', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    expect(screen.getByTestId('control-spindle-off')).toBeTruthy()
    expect(screen.queryByTestId('control-coolant-off')).toBeNull()
    expect(document.querySelector('[data-spindle-dir]')!.querySelectorAll('button').length).toBe(3)
    expect(document.querySelector('[data-coolant-mode]')!.querySelectorAll('button').length).toBe(2)
  })

  it('at rest the spindle shows Off lit, and the coolant shows nothing lit', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    // Two different resting states in one panel, on purpose. The spindle has an
    // Off MEMBER to light; the coolant's "off" is the absence of a lit button.
    expect(lit(off())).toBe(true)
    expect(litCount('[data-spindle-dir]')).toBe(1)
    expect(litCount('[data-coolant-mode]')).toBe(0)
  })
})

describe('WO-964: the spindle is a three-way choice again', () => {
  it('CW starts CW; Off stops; exactly one member is ever lit', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())
    expect(lit(cw())).toBe(true)
    expect(litCount('[data-spindle-dir]')).toBe(1)
    expect(commandSpindle.mock.calls[0][0]).toBe('cw')

    fireEvent.click(off())
    expect(lit(off())).toBe(true)
    expect(lit(cw())).toBe(false)
    expect(commandSpindle.mock.calls[1][0]).toBe('off')
  })

  // RETIRED with WO-964: "a SECOND press on CW turns the spindle off". The
  // spindle is no longer two-state - Operator's ruling - so pressing CW while CW is
  // lit re-sends CW. That is the three-button behaviour he asked to keep, and
  // asserting it here is what stops the two-state press being re-derived.
  it('a second press on CW does NOT stop the spindle - that is what Off is for', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())
    fireEvent.click(cw())

    expect(commandSpindle.mock.calls.map((c) => c[0])).toEqual(['cw', 'cw'])
    expect(lit(cw())).toBe(true)
  })

  it('CCW replaces CW without going through Off', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())
    fireEvent.click(ccw())

    expect(lit(ccw())).toBe(true)
    expect(lit(cw())).toBe(false)
    expect(litCount('[data-spindle-dir]')).toBe(1)
  })
})

describe('WO-957 (kept): the coolant half is two-state and stays that way', () => {
  it('Mist and Flood are two-state, and never light together', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(mist())
    expect(lit(mist())).toBe(true)
    fireEvent.click(flood())
    expect(lit(flood())).toBe(true)
    expect(lit(mist())).toBe(false)
    expect(litCount('[data-coolant-mode]')).toBe(1)

    fireEvent.click(flood())
    expect(litCount('[data-coolant-mode]')).toBe(0)
  })
})

describe('WO-474 (unchanged by WO-964): the latch follows what the machine DID', () => {
  // THE NEGATIVE CONTROL. The refusal is INJECTED and the button must stay
  // plain. This is the property WO-964 explicitly must not weaken, and it is
  // the one the whole Off-button argument was really about.
  it('a REFUSED spindle press leaves CW plain and leaves Off lit', () => {
    commandSpindle.mockReturnValue({
      ok: false,
      route: 'calls',
      reason: 'The software stop is latched. Press CLEAR to reset it.',
    })
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())

    expect(lit(cw())).toBe(false)
    // The panel still says what it knows: nothing was started, so Off stands.
    expect(lit(off())).toBe(true)
  })

  it('a REFUSED coolant press leaves the button plain', () => {
    runMachineAction.mockReturnValue({ ok: false, sent: 0, reason: 'refused' })
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(mist())

    expect(lit(mist())).toBe(false)
    expect(litCount('[data-coolant-mode]')).toBe(0)
  })

  it('the machine stopping on its own moves the latch to Off', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)
    fireEvent.click(cw())
    reportedRunning = true
    expect(lit(cw())).toBe(true)

    // Something that is not this UI stops the spindle - the bridge watchdog,
    // an M5 in a program. The panel must not keep claiming CW.
    reportedRunning = false
    cleanup()
    render(<SpindlePanel onOpenActions={() => {}} />)
    expect(litCount('[data-spindle-dir]')).toBe(1)
    expect(lit(off())).toBe(true)
  })
})

describe('WO-964 SAFETY: nothing gates a stop', () => {
  // KEPT, and re-pointed at the restored button. WO-957 proved this through a
  // press on a running spindle because Off did not exist; with Off back, the
  // stop is where it always was and the property is asserted directly.
  it('Off goes through with the E-STOP latch set, and says nothing', () => {
    estopNeedsReset.mockReturnValue(true)
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(off())

    expect(commandSpindle).toHaveBeenCalledTimes(1)
    expect(commandSpindle.mock.calls[0][0]).toBe('off')
    expect(pushConsole.mock.calls.filter((c) => c[2] === 'error')).toHaveLength(0)
  })

  // The failure this guards: someone "tidying" the handler by checking
  // estopNeedsReset before calling commandSpindle would break the stop for
  // every direction at once. Assert the call is made at all.
  it('the panel adds NO gate of its own before a stop', () => {
    estopNeedsReset.mockReturnValue(true)
    commandSpindle.mockReturnValue({ ok: false, route: 'calls', reason: 'refused' })
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(off())

    expect(commandSpindle).toHaveBeenCalledTimes(1)
  })

  // Off is disabled only by `!canAct` - never by `spindleDisabled`. A stop that
  // cannot be expressed on this controller is still attempted on every route
  // there is, so a missing spindle ROUTE must not disable the stop button.
  it('Off is not disabled by the same condition that disables a start', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)
    expect(off().hasAttribute('disabled')).toBe(false)
  })
})

// RETIRED BY WO-964, listed so nobody re-derives them from WO-957's evidence:
//
//   "a press stops a spindle the MACHINE reports running, even with the E-STOP
//    set"  - the clause it tested is deleted. The property it really protected,
//    that a stop survives the latch, is now proven directly through Off above.
//
//   "neither direction button commands a DIRECTION into a turning spindle"
//    - Operator ruled the hazard does not exist on his machine: remote mode, only
//      this software starts the spindle, and a VFD has no notion of clockwise
//      to be reversed. Retained as a comment rather than a skipped test,
//      because a skipped test reads as an intention to return.
