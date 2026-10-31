// @vitest-environment jsdom
// The spindle buttons must show what the MACHINE reports, not what we asked for.
//
// Found at the machine 2026-08-22 by Operator: the CW button was lit from an
// earlier press, on a spindle that was not turning. The bridge's client-gone
// watchdog had stopped it (the app was not sending a heartbeat - see
// uccncKeepAlive.test.ts), and nothing corrected the panel, because the latch
// was local `useState` written on a successful command and read by nobody else.
//
// WO-474 pinned the refused-command half: a command that never went must not
// latch. This is the other half, and it is the one that bit at the machine: a
// command that WENT, SUCCEEDED, and then stopped being true.
//
// Direction still comes from what was commanded, deliberately. This inverter
// reports the OPPOSITE direction from the one commanded while rotating
// correctly (VFD-COMMISSIONING.md 4.9), so it is honest about whether it turns
// and unreliable about which way.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { create } from 'zustand'
// Imported BEFORE SpindlePanel below on purpose: it transitively imports
// machineSession/machineControlStore, which triggers this file's mock
// factories during ITS static-import resolution. A `typedMock` import placed
// after it left a factory closing over a binding not yet initialized -
// "Cannot access '__vi_import_N__' before initialization" (see
// holderClearance3d.wo278.test.ts).
import { typedMock } from '../support/typedMock'
import { SpindlePanel } from '../../components/machine/SpindlePanel'
// WO-3191: the commanded direction now lives in the shared store. The mock below
// keeps that store REAL across tests, so each case must start from 'off'.
import { useMachineControl } from '../../store/machineControlStore'
import type {
  ConnectionPhase, LoadOutcome, MachineController, MachineState, MachineStatus, StreamerProgress,
} from '../../lib/machine/controller'
import type { MachineActionResult, SpindleCommandResult, SpindleRoute } from '../../lib/machine/machineSession'

/** What the controller currently reports. Tests reassign this between polls. */
let reported: MachineStatus['spindle'] = null

const commandSpindle = vi.fn((..._args: unknown[]): SpindleCommandResult => ({ ok: true, route: 'calls' }))

/** A full MachineController stub - this suite only varies `status().spindle`,
 *  but the module's real `getMachineController` returns a genuine
 *  `MachineController` (same shape as collapsedSummaryTruth.wo959.test.tsx's
 *  stubMachineController). */
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
      overrides: null, executingMoveId: null, buffer: null, inputs: null, homed: null, spindle: reported,
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
  estopNeedsReset: () => false,
}))

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
    })),
  })
})

function telemetry(running: boolean | null): MachineStatus['spindle'] {
  // WO-475: `linkUp` joined this block - liveness of the inverter link, a
  // different question from `running`. Null here: these cases are about the
  // latch, and say nothing about the link.
  return { volts: null, amps: null, torque: null, power: null, upToSpeed: null, running, linkUp: null }
}

const cw = () => screen.getByTestId('control-spindle-cw')
const ccw = () => screen.getByTestId('control-spindle-ccw')
// WO-957 RE-PIN: there is no Off button any more (Operator removed it; CW/CCW are
// two-state). The assertions that used it meant "nothing in the group claims
// the spindle is on", so that is what they now say - and it is a STRONGER
// statement than "Off is lit", because it cannot be satisfied by one stale
// member.
const spindleGroup = () => document.querySelector('[data-spindle-dir]') as HTMLElement
const nothingLatched = () =>
  spindleGroup().querySelectorAll('.control-latched').length === 0
const isLatched = (el: HTMLElement) => el.className.includes('control-latched')

/** The panel re-reads the controller on a 500 ms timer. */
const nextPoll = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
}

// cleanup AFTER each, never before: cleaning up first leaves the last render
// mounted past the end of the file and leaks into the next one.
afterEach(cleanup)

beforeEach(() => {
  vi.useFakeTimers()
  reported = null
  useMachineControl.setState({ commandedSpindle: 'off' })
  commandSpindle.mockReset()
  commandSpindle.mockReturnValue({ ok: true, route: 'calls' })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the spindle buttons follow the machine', () => {
  it('un-latches when the machine stops the spindle on its own', async () => {
    // Operator's exact case: the command went, then the bridge's watchdog stopped
    // the spindle, and the button stayed lit through it.
    //
    // WO-957 RE-PIN, fixture ordering only - the ASSERTIONS are untouched.
    // This used to report running BEFORE the first click, which no real
    // sequence does: you press CW on a stopped spindle and the machine then
    // reports it turning. It matters now because a press on a spindle the
    // machine says is RUNNING is a STOP (pressSpindle), so the old ordering
    // made the opening click mean the opposite of what the test intended.
    reported = telemetry(false)
    render(<SpindlePanel onOpenActions={() => {}} />)
    fireEvent.click(cw())
    reported = telemetry(true) // the machine now says it is turning
    await nextPoll()
    expect(isLatched(cw())).toBe(true)

    reported = telemetry(false) // stopped by something that was not this UI
    await nextPoll()

    expect(isLatched(cw())).toBe(false)
    // WO-964: Operator restored the Off button, so "stopped" has a member to light
    // again. Exactly one lit, and it is Off.
    expect(isLatched(screen.getByTestId('control-spindle-off'))).toBe(true)
    expect(spindleGroup().querySelectorAll('.control-latched').length).toBe(1)
  })

  it('keeps the commanded DIRECTION while the machine says it is turning', async () => {
    // The drive reports direction backwards, so direction may never be taken
    // from it - only running/stopped may.
    // WO-957 RE-PIN: same fixture-ordering move as above. Start stopped, press,
    // then let the machine report turning. The property under test - direction
    // comes from what WE commanded, never from the drive - is unchanged.
    reported = telemetry(false)
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(ccw())
    reported = telemetry(true)
    await nextPoll()

    expect(isLatched(ccw())).toBe(true)
    expect(isLatched(cw())).toBe(false)
  })

  it('latches nothing when it is turning and this UI did not start it', async () => {
    // Running, no commanded direction: "Off" would be a lie and a direction
    // would be a guess. Claim neither.
    reported = telemetry(true)
    render(<SpindlePanel onOpenActions={() => {}} />)

    await nextPoll()

    expect(isLatched(cw())).toBe(false)
    expect(isLatched(ccw())).toBe(false)
    // Running, and this UI did not start it: "Off" would be a lie and a
    // direction would be a guess, so NOTHING is lit even though Off exists.
    expect(nothingLatched()).toBe(true)
  })

  it('falls back to the commanded state on a backend that cannot report', async () => {
    // GRBL and the simulator report `spindle: null`. Nothing regresses there:
    // the commanded state is all there is, which is what it was before.
    reported = null
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())
    await nextPoll()

    expect(isLatched(cw())).toBe(true)
  })

  it('does not latch a direction the machine never confirmed turning', async () => {
    // A press that succeeded but never spun anything - the inverter answers
    // "not running" - must not leave an affirmative button behind.
    reported = telemetry(false)
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())
    await nextPoll()

    expect(isLatched(cw())).toBe(false)
  })
})
