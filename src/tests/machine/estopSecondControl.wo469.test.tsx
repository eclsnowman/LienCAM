// @vitest-environment jsdom
//
// WO-469, the re-scope: EVERY E-STOP CONTROL FOLLOWS THE TWO-MODE DESIGN.
//
// This file exists because of the audit that failed attempt 1, and it pins
// exactly what that audit found. Attempt 1 built Operator's two-mode control in
// ControlTransportBar and left the app's OTHER E-STOP - the one the Routines
// tab shows while a routine is moving the machine - as a hand-rolled copy:
//
//     ProbeRoutineRunPanel.tsx:145
//       className="control-btn-estop control-estop-armed ..."   // always armed
//       onClick={() => { void pressEstop() }}                    // result discarded
//       <OctagonX size={16} /> E-STOP                            // always "E-STOP"
//
// Once pressEstop() gained the clear mode, that control became a button
// labelled E-STOP that performed a CLEAR, and its discarded result meant it
// could not even say so. The architect's verdict, and it is the rule this file
// enforces: "A mislabelled stop control is worse than the deadlock this order
// started from... EVERY E-STOP CONTROL FOLLOWS THE TWO-MODE DESIGN. Not the
// transport bar's. Every one. If a third ever appears it inherits this rule
// automatically."
//
// "Automatically" is only true if there is ONE implementation to inherit, so
// the fix made EstopControl that implementation and both panels render it. The
// last test in this file is the structural pin that keeps it that way: a
// second hand-rolled E-STOP anywhere under src/components/ fails it, which is
// the only kind of test that could have caught attempt 1's miss before an
// auditor read the diff.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { resolveProbeConfig } from '../../lib/machine/toolTable'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ControlTransportBar, ESTOP_SETTLING_NOTE } = await import('../../components/machine/ControlTransportBar')
const { ProbeRoutineEditor } = await import('../../components/machine/ProbeRoutineEditor')
const { useProbeRoutineStore } = await import('../../store/probeRoutineStore')
const {
  __armEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  ESTOP_CLEAR_DELAY_MS,
  estopControlMode,
  estopNeedsReset,
  getMachineController,
  runMachineAction,
} = await import('../../lib/machine/machineSession')

const TRANSPORT = 'control-estop'
const PANEL = 'probe-routine-run-estop'

const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 300, y: 300, z: 100 },
)
const probe = resolveProbeConfig(null, {
  positioningFeed: 1200, fastFeed: 300, slowFeed: 40, retract: 2, maxTravel: 30,
  surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10,
})

async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** The word on a control, as an operator reads it - not a data attribute. */
function label(testId: string): string {
  return (screen.getByTestId(testId).textContent ?? '').trim()
}

function mode(testId: string): string | null {
  return screen.getByTestId(testId).getAttribute('data-estop-mode')
}

/** Both panels on screen at once, which is what makes "the two controls agree"
 *  assertable at all. The real simulator singleton is underneath - no mocked
 *  pressEstop, no test hatch: the latch these clicks move is the real one. */
function mountBoth() {
  return render(
    <>
      <ControlTransportBar sections="row" />
      <ProbeRoutineEditor
        start={{ x: 100, y: 100, z: 40 }}
        envelopeStatus="homed"
        envelope={envelope}
        probe={probe}
        tipRadiusMm={1.5}
        axisLimits={null}
        activeWcs="G54"
        units="mm"
        defaultOpen
      />
    </>,
  )
}

async function connectSimulator(): Promise<void> {
  await act(async () => {
    const pending = connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(100)
    await pending
  })
  await settle(700)
  // WO-1182: a fresh connect releases the latch once the controller reports
  // idle; these tests walk out of a REAL stop, so arm it the way a trip does.
  __armEstopInterlockForTest()
}

/** The WO-328 startup latch, cleared the way an operator clears it - through
 *  the transport bar's own control. No hatch. */
async function clearStartupLatch(): Promise<void> {
  expect(estopControlMode()).toBe('stopped')
  fireEvent.click(screen.getByTestId(TRANSPORT))
  await settle(1500)
  expect(estopControlMode()).toBe('armed')
}

/** A probe cycle refuses on an unhomed machine ("Home the machine before
 *  running an automatic probe cycle"), so the routine below could never even
 *  start without this. The real simulator homes for real; nothing here is
 *  mocked. */
async function homeTheSimulator(): Promise<void> {
  expect(getMachineController().home()).toBe(true)
  await settle(20_000)
  expect(getMachineController().homedThisSession()).toBe(true)
}

/** Park a routine mid-run so the panel stays busy and its E-STOP stays up.
 *  Returns the release. */
function gateTheRun(): () => void {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const ctrl = getMachineController()
  vi.spyOn(ctrl, 'probe').mockImplementation(async () => {
    await gate
    return { ok: false, at: null, reason: 'Test gate released.' }
  })
  return release
}

/** Pick a routine, check it, tick the path-clear statement and press Run.
 *  WO-2065: the factory Edge, whose first step (its top touch) is a probe
 *  call the gate parks on - the Bore now descends with G38.3 first, a line
 *  this simulator does not speak. */
async function startRoutine(): Promise<void> {
  fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.edge.x-minus' } })
  fireEvent.click(screen.getByTestId('probe-routine-check'))
  fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
  await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-run')) })
  // Let the real simulator complete the typed positioning move so the routine
  // reaches the gated probe verb. The old runner reached its text-command gate
  // immediately; typed moves deliberately wait for target + stable idle.
  await settle(10_000)
  expect(screen.getByTestId('probe-routine-run-panel').getAttribute('data-busy')).toBe('true')
}

beforeEach(() => {
  vi.useFakeTimers()
  mem.clear()
  act(() => { useProbeRoutineStore.setState({ routines: {}, quarantined: {}, hidden: [] }) })
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await act(async () => {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(200)
    await pending
  })
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
describe('WO-469 the Routines tab E-STOP is the same control, not a copy of it', () => {
  it('THE AUDIT FINDING: it is never a button that says E-STOP while performing a clear', async () => {
    mountBoth()
    await connectSimulator()
    await clearStartupLatch()
    await homeTheSimulator()

    const release = gateTheRun()
    await startRoutine()

    // Armed, and it says the word that means what a click will do.
    expect(label(PANEL)).toBe('E-STOP')
    expect(mode(PANEL)).toBe('estop')

    // ---- the stop, from THIS control -----------------------------------
    fireEvent.click(screen.getByTestId(PANEL))
    // Synchronous, asserted with no time advance: a stop is never gated.
    expect(getMachineController().machineState()).toBe('alarm')
    expect(estopNeedsReset()).toBe(true)

    // THE FINDING, pinned: the instant this control's clicks start meaning
    // "clear", the control stops saying "E-STOP". There is no window in which
    // the word and the action disagree.
    expect(label(PANEL)).not.toBe('E-STOP')
    expect(mode(PANEL)).not.toBe('estop')

    release()
    await settle(1500)
  })

  it('the two E-STOPs on screen are never in different modes, through every transition', async () => {
    mountBoth()
    await connectSimulator()
    await clearStartupLatch()
    await homeTheSimulator()

    const release = gateTheRun()
    await startRoutine()

    const bothAgree = (expected: string) => {
      expect(mode(TRANSPORT)).toBe(expected)
      expect(mode(PANEL)).toBe(expected)
      expect(label(TRANSPORT)).toBe(label(PANEL))
    }

    bothAgree('estop')

    // Stopped from the PANEL - and the transport bar's control follows it.
    fireEvent.click(screen.getByTestId(PANEL))
    bothAgree('settling')

    await settle(ESTOP_CLEAR_DELAY_MS + 1)
    bothAgree('clear')

    release()
    await settle(1500)
  })

  it('the control survives the stop it makes, so the operator is not stranded on the tab they are standing on', async () => {
    mountBoth()
    await connectSimulator()
    await clearStartupLatch()
    await homeTheSimulator()

    const release = gateTheRun()
    await startRoutine()

    fireEvent.click(screen.getByTestId(PANEL))
    release()
    await settle(1500)

    // The run is over - runProbeRoutine's `finally` cleared `busy`, which is
    // what used to UNMOUNT this control. The Routines tab carries no transport
    // row, so that left the operator with no way out of a stop they had just
    // made from this very panel: WO-469's own disease, in a second place.
    expect(screen.getByTestId('probe-routine-run-panel').getAttribute('data-busy')).toBeNull()
    expect(screen.getByTestId(PANEL)).toBeTruthy()
    expect(label(PANEL)).toBe('CLEAR')

    // ---- and the way out actually works, from this control --------------
    fireEvent.click(screen.getByTestId(PANEL))
    await settle(1500)

    expect(estopNeedsReset()).toBe(false)
    expect(getMachineController().machineState()).toBe('idle')
    // Nothing is loaded and no program was ever armed - the no-program case.
    expect(runMachineAction(['G0 X10 Y5'])).toEqual({ ok: true, sent: 1 })

    // Cleared, so it is not this panel's business any more: the control goes
    // away exactly as WO-411's "it is gone when the run ends" required.
    expect(screen.queryByTestId(PANEL)).toBeNull()
  })

  it('it can SAY it was refused - the discarded onClick result was half the finding', async () => {
    mountBoth()
    await connectSimulator()
    await clearStartupLatch()
    await homeTheSimulator()

    const release = gateTheRun()
    await startRoutine()

    fireEvent.click(screen.getByTestId(PANEL)) // the stop
    fireEvent.click(screen.getByTestId(PANEL)) // the double tap

    // The old control threw its result away, so a refusal here was invisible
    // by construction. This one has a sentence, unprompted, for the whole
    // settling window (WO-474: no silent no-op).
    expect(screen.getByTestId(`${PANEL}-settling-note`).textContent).toBe(ESTOP_SETTLING_NOTE)
    expect(estopNeedsReset()).toBe(true)

    release()
    await settle(1500)
  })
})

// ---------------------------------------------------------------------------
// The pin that makes "a third one inherits the rule automatically" true.
// ---------------------------------------------------------------------------
describe('WO-469 there is exactly one E-STOP implementation to inherit', () => {
  it('no component hand-rolls an E-STOP button - they all render EstopControl', () => {
    const dir = join(process.cwd(), 'src', 'components', 'machine')
    const offenders: string[] = []

    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.tsx')) continue
      const text = readFileSync(join(dir, name), 'utf8')
      // `control-btn-estop` is the class that makes something LOOK like the
      // E-STOP. Only the one implementation may apply it; anything else
      // wearing it is a copy, which is precisely what attempt 1 shipped.
      if (!text.includes('control-btn-estop')) continue
      if (name === 'ControlTransportBar.tsx') continue // the implementation itself
      offenders.push(name)
    }

    expect(offenders).toEqual([])
  })

  it('the panels that show an E-STOP get it from the one component', () => {
    const dir = join(process.cwd(), 'src', 'components', 'machine')
    const panel = readFileSync(join(dir, 'ProbeRoutineRunPanel.tsx'), 'utf8')

    expect(panel).toContain("import { EstopControl } from './ControlTransportBar'")
    expect(panel).toContain('<EstopControl')

    // A revert must be a FAILING TEST, not a silent regression. Read the
    // IMPORT LIST rather than the prose: this panel's comments quote the old
    // shape deliberately, so a substring search over the whole file would pin
    // the explanation instead of the code.
    const imports = panel.slice(0, panel.indexOf('const WCS_SLOTS'))
    expect(imports).not.toContain('pressEstop')
    // ...and it must not hand-roll the button again.
    expect(panel).not.toContain('className="control-btn-estop')
  })
})
