// @vitest-environment jsdom
// WO-474 - a refused spindle press must say so, and must NOT latch.
//
// 2026-08-23 RE-PIN: WHERE it says so changed, on Operator's ruling at the machine
// - "should be in the consol. We have taled about this." A refusal now goes to
// the machine console instead of a sentence beside the button. Every property
// this file pinned still holds and is still asserted; only the destination
// moved. What is NOT weakened: a refusal is still never silent, still names
// the E-STOP when that is the cause, still refuses to blame it when it is not,
// and still does not latch the button.
//
// Found by driving the panel in a real browser 2026-08-22: with the E-STOP
// latch un-reset (its state on EVERY fresh load) pressing CW put zero frames
// on the wire, printed nothing, and still lit the button as though the
// spindle were running - because setSpindleDir ran unconditionally beside the
// command. Silence would have been bad; the affirmative latch was worse.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { create } from 'zustand'
// Imported BEFORE SpindlePanel/machineSession below on purpose: those
// transitively trigger this file's mock factories during THEIR static-import
// resolution. A `typedMock` import placed after them left a factory closing
// over a binding not yet initialized - "Cannot access '__vi_import_N__'
// before initialization" (see holderClearance3d.wo278.test.ts).
import { typedMock } from '../support/typedMock'
import { SpindlePanel } from '../../components/machine/SpindlePanel'
// WO-474 item 1: the refusal SENTENCES now live in machineSession beside the
// code that chooses them, so this file asserts the same strings the product
// ships rather than a copy that can drift.
import { ESTOP_BLOCKS_MOTION, SPINDLE_REFUSAL } from '../../lib/machine/machineSession'
import type { MachineActionResult, SpindleCommandResult, SpindleRoute } from '../../lib/machine/machineSession'
import type {
  ConnectionPhase, LoadOutcome, MachineController, MachineState, MachineStatus, StreamerProgress,
} from '../../lib/machine/controller'

// The panel calls this with (direction, rpm, textLines). The mock must
// DECLARE that it takes arguments, or `mock.calls[0][0]` is a type error
// against a zero-length tuple - which is how this file broke the build on
// main 2026-08-22 while every test in it still passed. vitest does not
// type-check; `tsc -b` is the instrument that sees this.
// FIFTH time this one file has been bitten by a mock that did not carry the
// real shape, and the first four are already in the header above. Here the
// SHAPE was inferred from the initial value - { ok, route } - so the mock
// physically could not express the `reason` WO-474 item 1 added, and every
// mockReturnValue carrying one was a type error while vitest stayed green.
// Typing it as the product's own SpindleCommandResult is what stops that: the
// mock can now only return things the real function could have returned.
const commandSpindle = vi.fn(
  (..._args: unknown[]): SpindleCommandResult => ({ ok: true, route: 'calls' }),
)
const estopNeedsReset = vi.fn(() => false)

let reportedRunning: boolean | null = null

/** A full MachineController stub - the panel's stop path keys off what the
 *  MACHINE reports, so this mock has to be able to say "running" (same
 *  shape as collapsedSummaryTruth.wo959.test.tsx's stubMachineController). */
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
          : // THE WHOLE SHAPE, not just the field under test: the panel's
            // telemetry row reads volts/amps/torque/power/upToSpeed and threw
            // on undefined when this carried only `running`. Same lesson as the
            // runMachineAction and commandSpindle mocks in this file's header.
            {
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
  runMachineAction: vi.fn((): MachineActionResult => ({ ok: true, sent: 1 })),
  spindleRoute: vi.fn((): SpindleRoute => 'calls'),
  commandSpindle: (...args: unknown[]) => commandSpindle(...args),
  estopNeedsReset: () => estopNeedsReset(),
  // Real constants, not stand-ins: a mocked sentence would let the product's
  // text drift while this file stayed green.
  ESTOP_BLOCKS_MOTION: 'The software stop is latched. Press CLEAR to reset it.',
  SPINDLE_REFUSAL: {
    estop: 'The software stop is latched. Press CLEAR to reset it.',
    unsupported: 'This controller has no spindle control.',
    controllerRefused: 'The controller would not start the spindle.',
    notSent: 'The spindle command could not be sent to the machine.',
  },
}))

// A MOCK MUST CARRY THE REAL SHAPE - the fourth distinct way this one file has
// been bitten by that (missing member, wrong return type, wrong arity, and now
// a missing static). The panel reports refusals through
// useMachineControl.getState().pushConsole, so a selector-only mock makes it
// throw before any assertion runs.
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
/** Every refusal the panel reported, in order. The console is append-only, so
 *  tests that used to assert "the sentence is gone" now assert "no NEW refusal
 *  was reported" - which is the property that actually mattered. */
const refusals = () =>
  pushConsole.mock.calls.filter((c) => c[2] === 'error').map((c) => String(c[1]))
const isLatched = (el: HTMLElement) => el.className.includes('control-latched')

// cleanup AFTER each test, not before: cleaning up first leaves the LAST
// render mounted when the file ends, and it leaks into whichever test file
// runs next in the same environment. That is exactly what it did - it broke
// controlTabRegrid, which passes alone and failed only in the full slice.
afterEach(cleanup)

beforeEach(() => {
  reportedRunning = null
  pushConsole.mockReset()
  commandSpindle.mockReset()
  estopNeedsReset.mockReset()
  estopNeedsReset.mockReturnValue(false)
})

describe('WO-474: a refused press does not pretend it worked', () => {
  it('does NOT latch the button when the command was refused', () => {
    commandSpindle.mockReturnValue({ ok: false, route: 'calls', reason: ESTOP_BLOCKS_MOTION })
    estopNeedsReset.mockReturnValue(true)
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())

    // The whole defect, as one assertion.
    expect(isLatched(cw())).toBe(false)
  })

  // WO-474 item 1 changed what this test PROVES, and it is a better property.
  // It used to prove the panel could INFER "E-STOP" by asking estopNeedsReset
  // itself. It now proves the panel REPORTS FAITHFULLY the reason the command
  // gave it - note estopNeedsReset is left FALSE here on purpose: if the panel
  // were still inferring, this would print the generic sentence and fail.
  it('says WHY, naming the software stop latch when that is the cause', () => {
    commandSpindle.mockReturnValue({ ok: false, route: 'calls', reason: ESTOP_BLOCKS_MOTION })
    estopNeedsReset.mockReturnValue(false)
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())

    expect(refusals()).toHaveLength(1)
    // WO-1789: the sentence names the software latch and CLEAR, not the
    // physical switch. Faithful-report property unchanged.
    expect(refusals()[0]).toMatch(/software stop/i)
  })

  // The mirror of the above: estopNeedsReset is left TRUE, so a panel that
  // still inferred would wrongly blame the E-STOP. It reports what it was told.
  it('does not blame the E-STOP when the E-STOP is not the cause', () => {
    commandSpindle.mockReturnValue({ ok: false, route: 'calls', reason: SPINDLE_REFUSAL.unsupported })
    estopNeedsReset.mockReturnValue(true)
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())

    expect(refusals()).toHaveLength(1)
    expect(refusals()[0]).not.toMatch(/E-STOP/i)
  })

  it('latches, and shows nothing, when the command actually went', () => {
    commandSpindle.mockReturnValue({ ok: true, route: 'calls' })
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())

    expect(isLatched(cw())).toBe(true)
    expect(refusals()).toEqual([])
  })

  // NOTHING GATES A STOP. Proven a layer down in
  // estopResetInterlock.wo328.test.tsx:287, and correct by construction here
  // because the panel adds no gate of its own - but this panel is where an
  // operator presses Off, so the press is worth one test.
  //
  // WO-964 RE-POINT: WO-957 briefly removed Off, so this asserted the stop
  // through a press on a running spindle instead. Operator restored Off ("we can
  // leave off button on spindle. But spindle only"), so the stop is back where
  // it always was and is asserted directly. The PROPERTY never moved.
  //
  // RETIRED with it: "a press on a turning spindle never commands a DIRECTION
  // into it". That guarded WO-957's "or the machine reports running" clause,
  // which WO-964 deletes - Operator's machine is in remote mode so only this
  // software starts the spindle, and a VFD drives phase order and has no notion
  // of clockwise to reverse. Named here rather than skipped: a skipped test
  // reads as an intention to come back.
  it('presses OFF even with the E-STOP latch set, and says nothing', () => {
    estopNeedsReset.mockReturnValue(true)
    commandSpindle.mockReturnValue({ ok: true, route: 'calls' })
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(screen.getByTestId('control-spindle-off'))

    // The stop went, despite the latch that blocks a start.
    expect(commandSpindle).toHaveBeenCalledTimes(1)
    expect(commandSpindle.mock.calls[0][0]).toBe('off')
    expect(refusals()).toEqual([])
    expect(isLatched(screen.getByTestId('control-spindle-off'))).toBe(true)
  })

  it('the panel adds NO gate of its own before a stop', () => {
    // The failure this guards: someone "tidying" the handler by checking
    // estopNeedsReset before calling commandSpindle would break the stop for
    // every direction at once, and the test above would still pass if the
    // mock happened to agree. Assert the call is made at all.
    estopNeedsReset.mockReturnValue(true)
    commandSpindle.mockReturnValue({ ok: true, route: 'calls' })
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(screen.getByTestId('control-spindle-off'))

    expect(commandSpindle).toHaveBeenCalled()
  })

  // RE-PINNED 2026-08-23. The original pinned that a stale refusal SENTENCE
  // disappeared once a later command succeeded - a property of an inline
  // element that no longer exists. The console is a log: a refusal that
  // happened stays in the record, and erasing history would be the defect, not
  // the fix. What must still hold is that success adds NO new refusal and the
  // button latches - so the operator is never told a working command failed.
  it('adds no new refusal when a later command succeeds, and latches', () => {
    commandSpindle.mockReturnValue({ ok: false, route: 'calls', reason: ESTOP_BLOCKS_MOTION })
    estopNeedsReset.mockReturnValue(true)
    render(<SpindlePanel onOpenActions={() => {}} />)
    fireEvent.click(cw())
    expect(refusals()).toHaveLength(1)

    commandSpindle.mockReturnValue({ ok: true, route: 'calls' })
    estopNeedsReset.mockReturnValue(false)
    fireEvent.click(cw())

    expect(refusals()).toHaveLength(1) // still just the first one
    expect(isLatched(cw())).toBe(true)
  })
})
