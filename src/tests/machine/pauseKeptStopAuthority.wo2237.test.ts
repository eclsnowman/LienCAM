// WO-2237: while a program is paused at rest, the Control page's jog, Safe Z,
// MDI, spindle and output controls work exactly as with no program loaded
// (Operator ruling 2026-09-29: "when it's in a pause, be able to accept commands and then
// resume"). What stays as it was: a running program, the tool-change hold, a
// program held between parts at Idle, Go to XY0 / Zero axis, Home.
import { describe, expect, it } from 'vitest'
import { authorize, type OperatorAuthorityFacts, type OperatorCommand } from '../../lib/machine/operatorAuthority'

const PAUSED: OperatorAuthorityFacts = {
  connected: true,
  machineState: 'hold',
  jobPhase: 'paused',
  estopLatched: false,
  homed: true,
  noHomeSwitches: false,
  softLimitLatched: false,
  toolChangeHold: false,
  homingInFlight: false,
  bridgeJogRefusal: null,
  safeZSet: true,
  singleBlock: false,
  steppingBack: false,
  reArming: false,
  ackedSourceLine: 12,
  cycleStartEnabled: true,
  reArmEnabled: true,
  spindleRouted: true,
  spindleLinkDown: false,
  offsetWriteBusy: false,
  mdiLine: 'G0 X10',
  probeRoutineRunning: false,
}
/** The UCCNC bridge reads a paused program as still streaming, held. */
const PAUSED_ON_THE_BRIDGE: OperatorAuthorityFacts = { ...PAUSED, jobPhase: 'streaming' }
const RUNNING: OperatorAuthorityFacts = { ...PAUSED, machineState: 'run', jobPhase: 'streaming' }
const TOOL_CHANGE_HOLD: OperatorAuthorityFacts = { ...PAUSED, machineState: 'idle', toolChangeHold: true }
const HELD_BETWEEN_PARTS: OperatorAuthorityFacts = { ...PAUSED, machineState: 'idle' }

const OPENED: readonly OperatorCommand[] = ['jog', 'safeZ', 'mdiInput', 'mdiSend', 'spindleStart', 'spindleStop', 'accessory']

describe('WO-2237: a paused program lends the operator its controls', () => {
  it('jog, Safe Z, MDI, spindle and outputs are open in a pause at rest, on either door', () => {
    for (const facts of [PAUSED, PAUSED_ON_THE_BRIDGE]) {
      for (const command of OPENED) expect(authorize(command, facts), `${command} ${facts.jobPhase}`).toMatchObject({ allowed: true })
    }
  })

  it('a running program still locks every one of them, with the same sentence', () => {
    for (const command of OPENED) expect(authorize(command, RUNNING).allowed, command).toBe(false)
    expect(authorize('jog', RUNNING).refusal).toBe('A program is running - jogging is locked out.')
  })

  it('the tool-change hold is unchanged: jog and Safe Z only', () => {
    expect(authorize('jog', TOOL_CHANGE_HOLD).allowed).toBe(true)
    expect(authorize('safeZ', TOOL_CHANGE_HOLD).allowed).toBe(true)
    for (const command of ['mdiInput', 'mdiSend', 'spindleStart', 'accessory'] as const) {
      expect(authorize(command, TOOL_CHANGE_HOLD), command).toMatchObject({ allowed: false, refusedBy: 'programNotRunning' })
    }
    // A tool-change hold that reads Hold on the controller lends nothing more.
    const heldToolChange = { ...TOOL_CHANGE_HOLD, machineState: 'hold' as const }
    expect(authorize('mdiSend', heldToolChange).allowed).toBe(false)
  })

  it('a program held between parts at Idle is not a pause at rest - unchanged', () => {
    for (const command of OPENED) expect(authorize(command, HELD_BETWEEN_PARTS).allowed, command).toBe(false)
  })

  it('Go to XY0, Zero axis and Home keep their own rows; CYCLE START and Stop stay open', () => {
    expect(authorize('gotoWorkXY0', PAUSED)).toMatchObject({ allowed: false, refusedBy: 'idle' })
    expect(authorize('zeroWorkAxis', PAUSED)).toMatchObject({ allowed: false, refusedBy: 'idle' })
    expect(authorize('home', PAUSED).allowed).toBe(true)
    expect(authorize('cycleStart', PAUSED).allowed).toBe(true)
    expect(authorize('stopReset', PAUSED).allowed).toBe(true)
  })

  it('a hold another flow owns, or a pause the session cannot keep, keeps every lock it had', () => {
    // The session's verdict (pausedProgramTakesCommands) reads false there:
    // the clamp card, a probe routine, Step Back, the fit trace, a boundary
    // macro, the operator's own held MDI line.
    const notKept = { ...PAUSED, pauseTakesCommands: false }
    for (const command of OPENED) expect(authorize(command, notKept).allowed, command).toBe(false)
    expect(authorize('jog', notKept).refusal).toBe('A program is running - jogging is locked out.')
    expect(authorize('mdiSend', notKept)).toMatchObject({ allowed: false, refusedBy: 'programNotRunning' })
    for (const command of OPENED) {
      expect(authorize(command, { ...PAUSED, pauseTakesCommands: true }).allowed, command).toBe(true)
    }
  })

  it('the E-STOP latch still refuses jog in a pause', () => {
    expect(authorize('jog', { ...PAUSED, estopLatched: true }).allowed).toBe(false)
  })
})
