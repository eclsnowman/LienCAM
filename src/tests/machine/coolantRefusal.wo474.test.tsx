// @vitest-environment jsdom
// WO-474, THE OTHER HALF - a refused COOLANT press must say so, and must NOT
// latch.
//
// The spindle buttons were fixed on 2026-08-22. The coolant buttons twelve
// lines below them in the same file were not, and kept the original
// `run(action); setCoolantMode(mode)` pair: `run` returns runMachineAction's
// { ok, sent } and all three call sites discarded it. So with the E-STOP latch
// set - its state on EVERY fresh load - pressing Mist put nothing on the wire,
// printed nothing, and still lit the button.
//
// This matters more than a display bug because WO-957 removes the coolant
// "Off" button on Operator's ruling, which takes away the unconditional escape
// hatch that currently makes a lying latch survivable.
//
// WHAT IS NOT ASSERTED HERE: that the panel shows REPORTED coolant state.
// `onAccessories` fires only when `capabilities.ownsSpindle`, and this
// machine's bridge reports that false (Bridge.cs:1384) - coolant is on a
// separate Modbus link. Latching on `reportedAccessories` would mean a button
// that never lights, which is indistinguishable from a command that never
// went. Commanded-state is the honest source here; the spindle half has a live
// VFD telemetry channel and coolant has none.

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
import type {
  ConnectionPhase, LoadOutcome, MachineController, MachineState, MachineStatus, StreamerProgress,
} from '../../lib/machine/controller'
import type { SpindleCommandResult, SpindleRoute } from '../../lib/machine/machineSession'

// The coolant path goes through runMachineAction, not commandSpindle. The mock
// must carry the real return SHAPE ({ ok, sent }) - a bare boolean would let
// `run(action).ok` read undefined and every refusal assertion would pass for
// the wrong reason.
// WO-963: runMachineAction now returns a DISCRIMINATED result, so this mock is
// typed to the real shape. The panel no longer infers the cause from
// estopNeedsReset() - it prints the reason the session handed it - which means
// a mock that omits `reason` is modelling a return value the session cannot
// produce. That is the wrongly-typed-mock hazard WO-960 was opened about, and
// one of these was `vi.fn(() => true)` for months.
const ESTOP_SENTENCE = 'The software stop is latched. Press CLEAR to reset it.'
const NOT_SENT_SENTENCE = 'That could not be sent to the machine.'
const runMachineAction = vi.fn((..._args: unknown[]) => ({ ok: true, sent: 1 }) as
  | { ok: true; sent: number }
  | { ok: false; sent: number; reason: string })
const estopNeedsReset = vi.fn(() => false)

/** A full MachineController stub - this suite only cares about a constant
 *  `status().spindle: null`, but the module's real `getMachineController`
 *  returns a genuine `MachineController` (same shape as
 *  collapsedSummaryTruth.wo959.test.tsx's stubMachineController). */
function stubMachineController(): MachineController {
  const status: MachineStatus = {
    state: 'idle', subState: null, machinePos: null, workPos: null, feedMmMin: null, spindleRpm: null,
    overrides: null, executingMoveId: null, buffer: null, inputs: null, homed: null, spindle: null,
  }
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
    status: vi.fn(() => status),
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
  commandSpindle: vi.fn((): SpindleCommandResult => ({ ok: true, route: 'calls' })),
  estopNeedsReset: () => estopNeedsReset(),
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

const mist = () => screen.getByTestId('control-coolant-mist')
const flood = () => screen.getByTestId('control-coolant-flood')
// WO-957: the coolant Off button is gone. A press on the LIT button is the stop.
const coolantGroup = () => document.querySelector('[data-coolant-mode]') as HTMLElement
const nothingLatched = () => coolantGroup().querySelectorAll('.control-latched').length === 0
const refusals = () =>
  pushConsole.mock.calls.filter((c) => c[2] === 'error').map((c) => String(c[1]))
const isLatched = (el: HTMLElement) => el.className.includes('control-latched')

afterEach(cleanup)

beforeEach(() => {
  pushConsole.mockReset()
  runMachineAction.mockReset()
  runMachineAction.mockReturnValue({ ok: true, sent: 1 })
  estopNeedsReset.mockReset()
  estopNeedsReset.mockReturnValue(false)
})

describe('WO-474 (coolant): a refused press does not pretend it worked', () => {
  // THE ACCEPTANCE ITEM. This is the negative control: the command is made to
  // fail, and the button must stay PLAIN. Not inferred from a happy path.
  it('does NOT latch Mist when the command was refused', () => {
    runMachineAction.mockReturnValue({ ok: false, sent: 0, reason: ESTOP_SENTENCE })
    estopNeedsReset.mockReturnValue(true)
    render(<SpindlePanel onOpenActions={() => {}} />)

    expect(isLatched(mist())).toBe(false)
    fireEvent.click(mist())
    expect(isLatched(mist())).toBe(false)
  })

  it('names the software stop latch as the reason when that is the cause', () => {
    runMachineAction.mockReturnValue({ ok: false, sent: 0, reason: ESTOP_SENTENCE })
    estopNeedsReset.mockReturnValue(true)
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(mist())
    expect(refusals()).toHaveLength(1)
    // WO-1789: the sentence names the latch and the CLEAR control, not the
    // physical switch. The property is unchanged: the panel prints the reason
    // it was handed, and that reason names the stop.
    expect(refusals()[0]).toMatch(/software stop/i)
  })

  // Honest about being unspecific rather than inventing a cause - the same
  // rule runSpindle follows.
  it('refuses to blame the software stop when it is not the cause', () => {
    runMachineAction.mockReturnValue({ ok: false, sent: 0, reason: NOT_SENT_SENTENCE })
    estopNeedsReset.mockReturnValue(false)
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(flood())
    expect(refusals()).toHaveLength(1)
    // WO-1789: same mirror property as the test above, re-pinned to the new
    // sentence - a transport refusal must not name the stop latch.
    expect(refusals()[0]).not.toMatch(/software stop/i)
    expect(isLatched(flood())).toBe(false)
  })

  it('a refusal is never silent', () => {
    runMachineAction.mockReturnValue({ ok: false, sent: 0, reason: NOT_SENT_SENTENCE })
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(mist())
    fireEvent.click(flood())
    expect(refusals()).toHaveLength(2)
  })

  // The other half of the contract: the fix must not break the working case.
  it('DOES latch when the command actually went, and says nothing', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(mist())
    expect(isLatched(mist())).toBe(true)
    expect(refusals()).toHaveLength(0)
  })

  it('switching Mist then Flood keeps the coolant pair two-state', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(mist())
    expect(isLatched(mist())).toBe(true)
    fireEvent.click(flood())
    expect(isLatched(flood())).toBe(true)
    expect(isLatched(mist())).toBe(false)

    runMachineAction.mockClear()
    fireEvent.click(flood())
    expect(runMachineAction.mock.calls[0][0]).toEqual(['M9'])
    expect(isLatched(flood())).toBe(false)
    expect(isLatched(mist())).toBe(false)
  })

  // NOTHING GATES A STOP. coolantOff is stop-exempt by action identity, so a
  // configured stop goes through with the latch set regardless of its text.
  //
  // WO-957 RE-PIN. The Off button is gone, so the stop is now a press on the
  // LIT button - and the reachability question has a DIFFERENT answer here than
  // on the spindle side, which is why it gets its own test rather than an
  // argument by analogy. Coolant has NO telemetry to say "it is on" (this
  // machine's bridge reports ownsSpindle false), so the only thing that can
  // light a coolant button is a command of ours that went. The realistic
  // sequence is therefore: coolant started while the machine was clear, THEN
  // the E-STOP tripped. The stop must still go.
  it('a coolant stop still goes through once the E-STOP latch is set', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    // Mist on, while nothing is refusing.
    fireEvent.click(mist())
    expect(isLatched(mist())).toBe(true)

    // Now the E-STOP trips. The lit button must still stop the coolant.
    estopNeedsReset.mockReturnValue(true)
    runMachineAction.mockClear()
    fireEvent.click(mist())

    expect(runMachineAction).toHaveBeenCalledTimes(1)
    expect(nothingLatched()).toBe(true)
    expect(refusals()).toHaveLength(0)
  })

  it('the panel adds no gate of its own before a coolant stop', () => {
    // The failure this guards: someone "tidying" pressCoolant by checking
    // estopNeedsReset before calling run() would break the stop, and a test
    // that only looked at the latch could still pass. Assert the call is made.
    render(<SpindlePanel onOpenActions={() => {}} />)
    fireEvent.click(mist())

    estopNeedsReset.mockReturnValue(true)
    runMachineAction.mockClear()
    fireEvent.click(mist())

    expect(runMachineAction).toHaveBeenCalledTimes(1)
  })

  // The two-state behaviour itself, in Operator's words: hit once for on, hit
  // twice and it turns off.
  it('a second press on a lit coolant button turns it off', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)
    fireEvent.click(flood())
    expect(isLatched(flood())).toBe(true)
    fireEvent.click(flood())
    expect(isLatched(flood())).toBe(false)
    expect(nothingLatched()).toBe(true)
  })
})
