// @vitest-environment jsdom
// WO-959 - folding the spindle panel must not make it lie.
//
// The panel read TWO sources for one fact and only one of them was alive:
//   OPEN       latched   <- the VFD's own telemetry (Modbus) + what we commanded
//   COLLAPSED  dirText   <- reportedAccessories.spindle
// `reportedAccessories` is filled by `onAccessories`, which fires only for a
// backend that OWNS the spindle, and this machine's bridge reports
// ownsSpindle=false because the AXBB-E's spindle is on its own Modbus link. So
// the collapsed summary printed "Off | Off" permanently, whatever the spindle
// was doing, three lines below an open panel that was reading it correctly.
//
// THE TEST STRATEGY THE ORDER ASKS FOR: drive ONE machine state and read BOTH
// renderings of it. Two code paths inspected separately can each look right and
// still disagree - that is exactly how this defect survived.

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
import type { MachineController, StreamerProgress } from '../../lib/machine/controller'
import { useUiPrefs } from '../../store/uiPrefs'
// WO-3191: the commanded direction now lives in the shared store, which this
// suite's mock keeps REAL across tests - each case must start from 'off'.
import { useMachineControl } from '../../store/machineControlStore'

let reportedRunning: boolean | null = null
// Whether THIS backend owns the spindle/coolant. False is Operator's machine (the
// AXBB-E's spindle is on its own Modbus link); true is the simulator and GRBL.
// The summary picks its source from this, so both branches get exercised.
let ownsSpindle = false

const commandSpindle = vi.fn(
  (..._args: unknown[]): SpindleCommandResult => ({ ok: true, route: 'calls' }),
)
const runMachineAction = vi.fn((..._args: unknown[]): MachineActionResult => ({ ok: true, sent: 1 }))
const estopNeedsReset = vi.fn(() => false)

// Function DECLARATIONS, not const arrow assignments: a mock's transitive
// resolution can fire during an EARLIER static import's own resolution
// (SpindlePanel's), which runs before ANY of this file's own top-level code -
// a `const` would be a TDZ crash the moment `vi.fn(stubMachineController)`
// evaluates below. A function declaration is fully hoisted with its body, and
// the `let`s it closes over are only actually READ later, when the mock's
// `getMachineController()` is CALLED during a test - by which point the whole
// module has finished loading and they are initialized.
function emptyJobProgress(): StreamerProgress {
  return {
    phase: 'empty', totalLines: 0, sentLines: 0, ackedLines: 0, ackedSourceLine: 0, sentSourceLine: 0,
    bytesInFlight: 0,
  }
}

/** A fully-shaped MachineController stub: this file only drives `capabilities`
 *  and `status()`, but a mock replacing `getMachineController`'s return type
 *  is checked against the WHOLE contract, not the two members this suite
 *  reads - see typedMock.ts. Every other member is a harmless no-op/default,
 *  never called by SpindlePanel in this harness. */
function stubMachineController(): MachineController {
  return {
  capabilities: {
    geometryQueue: false, executingMoveId: false, bufferSeconds: false,
    gcodeText: false, perAxisHoming: false, ownsSpindle, spindleCommands: false,
  },
  connect: async () => {},
  disconnect: async () => {},
  connectionPhase: () => 'connected',
  firmwareVersion: () => null,
  machineState: () => 'idle',
  status: () => ({
    state: 'idle', subState: null, machinePos: null, workPos: null, feedMmMin: null, spindleRpm: null,
    overrides: null, executingMoveId: null, buffer: null, inputs: null, homed: null,
    spindle:
      reportedRunning === null
        ? null
        : {
          volts: null, amps: null, torque: null, power: null, upToSpeed: null,
          running: reportedRunning, linkUp: null,
        },
  }),
  queryStatus: () => {},
  refreshState: () => true,
  querySettings: () => true,
  verifiedIdle: () => true,
  homedThisSession: () => false,
  resetInProgress: () => false,
  subscribeResetInProgress: () => () => {},
  jog: () => true,
  jogToWorkXY: () => true,
  jogToMachineZ: () => true,
  jogCancel: () => {},
  home: () => true,
  feedHold: () => {},
  cycleResume: () => true,
  reset: () => {},
  unlock: () => true,
  emergencyStop: () => {},
  resetToIdle: async () => ({ ok: true, reason: null }),
  setOverride: () => {},
  selectWcs: () => true,
  zeroWorkAxis: () => true,
  probe: async () => ({ ok: true, at: null }),
  sendCommand: () => true,
  sendCommandAwait: async () => ({ ok: true, message: null }),
  loadJob: () => ({ ok: true, result: { lines: [], skipped: 0, overlongLines: [] } }),
  loadJobFrom: () => ({ ok: true, result: { lines: [], skipped: 0, overlongLines: [] } }),
  startJob: () => true,
  pauseJob: () => {},
  resumeJob: () => true,
  stopJob: () => {},
  stepJob: () => true,
  setSingleBlockMode: () => {},
  singleBlockMode: () => false,
  hasActiveJob: () => false,
    jobProgress: emptyJobProgress,
    stoppedJobProgress: () => null,
  }
}

vi.mock('../../lib/machine/machineSession', () => typedMock<typeof import('../../lib/machine/machineSession')>({
  // WO-2237: SpindlePanel reads the tool-change hold and the kept-pause verdict.
  subscribeToolChangeHold: () => () => {},
  toolChangeHoldActive: () => false,
  subscribePausedProgramTakesCommands: () => () => {},
  pausedProgramTakesCommands: () => false,
  getMachineController: vi.fn(stubMachineController),
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

// THE WHOLE POINT OF THE ORDER, encoded in the harness: this backend does NOT
// own accessories, so reportedAccessories is the all-off constant it is on
// Operator's machine. Any token that reads it will say "Off" no matter what the
// spindle does - which is what these tests are here to catch.
//
// A REAL zustand store (built with the same `create` the product store uses),
// seeded from the real module's own initial state and overridden with the
// facts this suite drives - so `useMachineControl` is a genuine
// `UseBoundStore<StoreApi<MachineControlState>>` by construction, not a
// hand-rolled selector function standing in for one.
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
const mist = () => screen.getByTestId('control-coolant-mist')
const lit = (el: HTMLElement) => el.className.includes('control-latched')

/** Fold the panel. The collapse toggle is the operator's own gesture, so the
 *  test uses it rather than reaching into the prefs store - the summary must be
 *  right by the route a person actually takes to it. */
const collapse = () => fireEvent.click(screen.getByTestId('control-spindle-toggle'))
const summary = () => screen.getByTestId('control-spindle-collapsed-state').textContent ?? ''
/** The row is "<rpm> rpm <spindle> | <coolant>". Assertions about the SPINDLE
 *  must not be able to pass or fail on the coolant token beside it - the first
 *  version of this file asserted on the whole string and tripped over a coolant
 *  "Off" that was correct. */
const spindleToken = () => summary().split('|')[0]
const coolantToken = () => summary().split('|')[1] ?? ''

afterEach(cleanup)
beforeEach(() => {
  // The collapse flag lives in a REAL store that persists across tests in this
  // file - the first test that folds the panel left every later render folded,
  // and the buttons simply were not there. Reset it, so each case starts open.
  useUiPrefs.setState({ collapsedPropsGroups: {} })
  // WO-3191 moved the commanded direction into the shared store, which this
  // suite's mock keeps as a REAL store across tests. A successful press in an
  // earlier case would otherwise leak into the refused / external-running cases.
  useMachineControl.setState({ commandedSpindle: 'off' })
  reportedRunning = null
  ownsSpindle = false
  pushConsole.mockReset()
  commandSpindle.mockReset()
  commandSpindle.mockReturnValue({ ok: true, route: 'calls' })
  runMachineAction.mockReset()
  runMachineAction.mockReturnValue({ ok: true, sent: 1 })
  estopNeedsReset.mockReset()
  estopNeedsReset.mockReturnValue(false)
})

describe('WO-959: the fold cannot change what the panel claims', () => {
  it('a running CW spindle reads CW open AND folded', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())
    reportedRunning = true
    expect(lit(cw())).toBe(true) // the open panel's answer

    collapse()
    expect(summary()).toContain('CW') // the folded panel's answer
    expect(summary()).not.toMatch(/\bOff\b\s*\|/) // and it is not the old constant
  })

  // THE ACCEPTANCE ITEM, and the exact state Operator's machine sits in whenever a
  // program starts the spindle: the machine says it is turning and this UI did
  // not start it. The open panel deliberately lights NOTHING - the drive reports
  // direction backwards, so naming one would be a guess. The fold must not
  // convert "we do not know" into a confident "Off".
  it('a spindle turning that we did not start is never summarised as Off', () => {
    reportedRunning = true
    render(<SpindlePanel onOpenActions={() => {}} />)

    // Open: nothing claims a direction. Off exists again (WO-964) but is NOT
    // lit here - the machine says turning, so claiming stopped would be a lie.
    expect(document.querySelector('[data-spindle-dir]')!.querySelectorAll('.control-latched').length).toBe(0)

    collapse()

    // Folded: the SPINDLE token must say turning, and must NOT say Off.
    expect(spindleToken()).toContain('Turning')
    expect(spindleToken()).not.toContain('Off')
    // The coolant token beside it is genuinely off and correctly says so - the
    // assertion above must not be satisfiable by it either way.
    expect(coolantToken()).toContain('Off')
  })

  it('coolant reads the same folded as it does open', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(mist())
    expect(lit(mist())).toBe(true)

    collapse()
    expect(coolantToken()).toContain('Mist')
  })

  // A REFUSED press must not become a claim in the summary either - this is the
  // WO-474 defect one fold along, and it would have been invisible before,
  // because the summary was not reading the command's result at all.
  it('a refused start is not summarised as running', () => {
    commandSpindle.mockReturnValue({ ok: false, route: 'calls', reason: 'refused' })
    render(<SpindlePanel onOpenActions={() => {}} />)

    fireEvent.click(cw())
    expect(lit(cw())).toBe(false)

    collapse()
    expect(spindleToken()).not.toContain('CW')
  })

  // THE OTHER BRANCH, and the reason WO-133's test was right to exist. When the
  // controller DOES own accessories the reported state wins, because it catches
  // what this panel never commanded - an M5 inside a streamed program, an
  // E-stop reset. WO-959 did not get to delete that; it only got to stop it
  // being used where it is a constant.
  it('when the controller OWNS accessories, the summary follows the machine, not the buttons', () => {
    ownsSpindle = true
    render(<SpindlePanel onOpenActions={() => {}} />)

    // The buttons say stopped - WO-964 restored the Off member and it is lit
    // at rest...
    expect(document.querySelector('[data-spindle-dir]')!.querySelectorAll('.control-latched').length).toBe(1)

    collapse()
    // ...and the summary reports what the MACHINE said, which here is off.
    // The harness's reportedAccessories is the all-off constant, so this
    // asserts the SOURCE, not the value: with ownsSpindle true the panel must
    // not be substituting its own 'Turning'.
    reportedRunning = true
    expect(spindleToken()).toContain('Off')
    expect(spindleToken()).not.toContain('Turning')
  })

  // And the fallback is chosen by whether the source is ALIVE, not by taste.
  it('the same machine state reads differently depending on who owns the truth', () => {
    reportedRunning = true

    ownsSpindle = false
    render(<SpindlePanel onOpenActions={() => {}} />)
    collapse()
    expect(spindleToken()).toContain('Turning') // no reported source: use ours

    cleanup()
    useUiPrefs.setState({ collapsedPropsGroups: {} })
    ownsSpindle = true
    render(<SpindlePanel onOpenActions={() => {}} />)
    collapse()
    expect(spindleToken()).not.toContain('Turning') // reported source wins
  })

  // The panel must not hold a second opinion at all. If the summary ever reads
  // a source the buttons do not, this is the assertion that notices: every state
  // below is driven once and checked in both renderings.
  it('open and folded agree across every state this panel can be in', () => {
    const cases: Array<{ name: string; drive: () => void; open: string; folded: string }> = [
      { name: 'at rest', drive: () => {}, open: 'off', folded: 'Off' },
      {
        name: 'commanded CW and turning',
        drive: () => {
          fireEvent.click(cw())
          reportedRunning = true
        },
        open: 'cw',
        folded: 'CW',
      },
    ]

    for (const c of cases) {
      cleanup()
      useUiPrefs.setState({ collapsedPropsGroups: {} })
      reportedRunning = null
      render(<SpindlePanel onOpenActions={() => {}} />)
      c.drive()

      const litNow = [...document.querySelectorAll('[data-spindle-dir] .control-latched')]
      const openAnswer = litNow.length === 0 ? 'none' : (litNow[0] as HTMLElement).textContent!.trim().toLowerCase()
      expect(openAnswer, `${c.name}: open`).toBe(c.open)

      collapse()
      expect(spindleToken(), `${c.name}: folded`).toContain(c.folded)
    }
  })
})
