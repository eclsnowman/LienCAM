// WO-3259 (WO-3181 phase A): the gamepad adapter's numbers and state machine,
// against WO-3181's numeric table (tolerance 1e-12) and the order's routes.
// Pure logic: no controller here - gamepadJogSession.wo3181 drives the real
// session and simulator.
import { describe, expect, it } from 'vitest'
import {
  GAMEPAD_STALE_READ_MS,
  GamepadJogMachine,
  capturedRawInput,
  emptyGamepadJogPrefs,
  gamepadFingerprint,
  gamepadMappingClash,
  gamepadStepDeltaMm,
  gamepadStepFeedMmMin,
  normalizeGamepadAxis,
  readGamepadGesture,
  readGamepadJogPrefs,
  type GamepadJogAction,
  type GamepadJogContext,
  type GamepadJogPrefs,
  type GamepadSnapshot,
} from '../../lib/machine/gamepadJogInput'

const TOL = 1e-12

describe('WO-3259 numbers (WO-3181 table)', () => {
  it('dead zone d=0.20 maps a to q exactly', () => {
    const a = [-1, -0.6, -0.2, 0, 0.2, 0.6, 1]
    const q = [-1, -0.5, 0, 0, 0, 0.5, 1]
    a.forEach((value, i) => expect(Math.abs(normalizeGamepadAxis(value, 0.2) - q[i])).toBeLessThan(TOL))
  })

  it('a step is sign(q) times the Jog panel step, never |q| times it', () => {
    expect(gamepadStepDeltaMm(0.5, 1)).toBe(1)
    expect(gamepadStepDeltaMm(-0.01, 0.1)).toBe(-0.1)
    expect(gamepadStepDeltaMm(0, 1)).toBe(0)
  })

  it('Fbase 1000 x scale 0.25 is F250', () => {
    expect(gamepadStepFeedMmMin(1000, 0.25)).toBe(250)
  })

  it('invert turns 0.6 into -0.5', () => {
    const prefs = mapped({ inverted: { X: true, Y: false, Z: false } })
    const gesture = readGamepadGesture(pad({ axes: [0.6, 0, 0, 0] }), prefs)
    expect(gesture.kind).toBe('direction')
    if (gesture.kind !== 'direction') return
    expect(gesture.axis).toBe('X')
    expect(Math.abs(gesture.q - -0.5)).toBeLessThan(TOL)
  })

  it('a non-finite reading is neutral', () => {
    expect(normalizeGamepadAxis(Number.NaN, 0.2)).toBe(0)
  })
})

// ── fixtures ─────────────────────────────────────────────────────────────

const PAD_ID = 'Test Pad (STANDARD GAMEPAD)'
let clock = 0

function pad(over: Partial<GamepadSnapshot> & { press?: number[] } = {}): GamepadSnapshot {
  const buttons = Array.from({ length: 8 }, (_, i) => ({ pressed: over.press?.includes(i) === true, value: over.press?.includes(i) ? 1 : 0 }))
  return {
    id: PAD_ID,
    index: 0,
    connected: true,
    timestamp: over.timestamp ?? clock,
    axes: over.axes ?? [0, 0, 0, 0],
    buttons: over.buttons ?? buttons,
  }
}

/** Left stick X = axis 0, Y = axis 1 (up is negative, as on a standard pad);
 *  Z on buttons 4 (+) and 5 (-); deadman button 7. */
function mapped(over: Partial<GamepadJogPrefs> = {}): GamepadJogPrefs {
  return {
    ...emptyGamepadJogPrefs(gamepadFingerprint(pad())),
    mappings: {
      'X+': { kind: 'axis', index: 0, sign: 1 },
      'X-': { kind: 'axis', index: 0, sign: -1 },
      'Y+': { kind: 'axis', index: 1, sign: -1 },
      'Y-': { kind: 'axis', index: 1, sign: 1 },
      'Z+': { kind: 'button', index: 4 },
      'Z-': { kind: 'button', index: 5 },
    },
    deadman: { kind: 'button', index: 7 },
    ...over,
  }
}

const DEADMAN = 7

class Harness {
  machine = new GamepadJogMachine()
  actions: GamepadJogAction[] = []
  ctx: Omit<GamepadJogContext, 'now' | 'pad'> = {
    enabled: true,
    prefs: { status: 'ok', prefs: mapped() },
    away: false,
    jogAllowed: true,
    jogRefusal: null,
    enabledAxes: ['X', 'Y', 'Z'],
    machineState: 'idle',
    machineJogStepMm: 1,
    machineJogFeedMmMin: 1000,
  }

  read(sample: GamepadSnapshot | null, over: Partial<GamepadJogContext> = {}): GamepadJogAction[] {
    clock += 20
    const got = this.machine.step({ ...this.ctx, now: clock, pad: sample === null ? null : { ...sample, timestamp: clock }, ...over })
    this.actions.push(...got)
    return got
  }

  /** Enable at rest, then a fresh deadman press. */
  arm(): void {
    this.read(pad())
    this.read(pad({ press: [DEADMAN] }))
    expect(this.machine.phase).toBe('armed')
  }

  jogs() { return this.actions.filter((a) => a.type === 'jog') }
  cancels() { return this.actions.filter((a) => a.type === 'cancel') }
}

describe('WO-3259 step gestures', () => {
  it('step 1 mm: a=0.6 then 1 without neutral asks for exactly one +1 mm', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ axes: [0.6, 0, 0, 0], press: [DEADMAN] }))
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    expect(h.jogs()).toEqual([{ type: 'jog', axis: 'X', deltaMm: 1, feedMmMin: 1000, gesture: 1 }])
  })

  it('neutral then -0.6 at step 0.1 asks for exactly one -0.1 mm', () => {
    const h = new Harness()
    h.ctx.machineJogStepMm = 0.1
    h.arm()
    h.read(pad({ axes: [0.6, 0, 0, 0], press: [DEADMAN] }))
    // Neutral for the stick settle (GAMEPAD_STICK_SETTLE_MS, operator 10-30).
    for (let i = 0; i < 6; i++) h.read(pad({ press: [DEADMAN] }))
    h.read(pad({ axes: [-0.6, 0, 0, 0], press: [DEADMAN] }))
    h.read(pad({ axes: [-0.6, 0, 0, 0], press: [DEADMAN] }))
    expect(h.jogs().map((a) => a.type === 'jog' && [a.axis, a.deltaMm])).toEqual([['X', 0.1], ['X', -0.1]])
  })

  it('every step carries Fbase x scale: 1000 x 0.25 = F250', () => {
    const h = new Harness()
    h.ctx.prefs = { status: 'ok', prefs: mapped({ speedScale: 0.25 }) }
    h.arm()
    h.read(pad({ press: [DEADMAN, 4] }))
    h.read(pad({ press: [DEADMAN] }))
    h.read(pad({ press: [DEADMAN, 5] }))
    expect(h.jogs().map((a) => a.type === 'jog' && [a.axis, a.deltaMm, a.feedMmMin])).toEqual([['Z', 1, 250], ['Z', -1, 250]])
  })

  it('1 inch display: the stored 25.4 mm step is one 25.4 mm request', () => {
    const h = new Harness()
    h.ctx.machineJogStepMm = 25.4
    h.arm()
    h.read(pad({ axes: [0, -1, 0, 0], press: [DEADMAN] }))
    expect(h.jogs().map((a) => a.type === 'jog' && [a.axis, a.deltaMm])).toEqual([['Y', 25.4]])
  })

  it('inside the dead zone nothing moves', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ axes: [0.2, -0.19, 0, 0], press: [DEADMAN] }))
    expect(h.jogs()).toEqual([])
  })
})

describe('WO-3259 deadman', () => {
  it('a deadman already held when enabled never arms; release then press does', () => {
    const h = new Harness()
    h.read(pad({ press: [DEADMAN] }))
    h.read(pad({ press: [DEADMAN] }))
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    expect(h.machine.phase).toBe('waiting-neutral')
    expect(h.jogs()).toEqual([])
    h.read(pad())
    expect(h.machine.phase).toBe('ready')
    h.read(pad({ press: [DEADMAN] }))
    expect(h.machine.phase).toBe('armed')
  })

  it('a deadman pressed with a direction already held does not arm', () => {
    const h = new Harness()
    h.read(pad())
    h.read(pad({ axes: [1, 0, 0, 0] }))
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    expect(h.machine.phase).toBe('waiting-neutral')
    h.read(pad({ press: [DEADMAN] }))
    expect(h.jogs()).toEqual([])
    expect(h.machine.phase).toBe('waiting-neutral')
  })

  it('a direction without the deadman sends nothing', () => {
    const h = new Harness()
    h.read(pad())
    h.read(pad({ axes: [1, 0, 0, 0] }))
    h.read(pad({ press: [4] }))
    expect(h.jogs()).toEqual([])
  })

  it('release cancels the step this adapter still owns, once', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    h.read(pad({ axes: [1, 0, 0, 0] }))
    h.read(pad())
    expect(h.cancels()).toEqual([{ type: 'cancel', gesture: 1 }])
    expect(h.machine.phase).toBe('ready')
  })

  it('release cancels nothing once another input has asked to move', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    h.machine.noteExternalIntent()
    h.read(pad())
    expect(h.cancels()).toEqual([])
  })

  it('release cancels nothing once the owned step was seen to finish', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }), { machineState: 'jog' })
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }), { machineState: 'idle' })
    h.read(pad())
    expect(h.cancels()).toEqual([])
  })
})

describe('WO-3259 one axis at a time', () => {
  it('two mapped axes: no motion, one sentence', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ axes: [1, -1, 0, 0], press: [DEADMAN] }))
    h.read(pad({ axes: [1, -1, 0, 0], press: [DEADMAN] }))
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    expect(h.jogs()).toEqual([])
    expect(h.actions.filter((a) => a.type === 'say')).toEqual([{ type: 'say', text: 'simultaneous' }])
  })

  it('opposing buttons: no motion, one sentence', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ press: [DEADMAN, 4, 5] }))
    h.read(pad({ press: [DEADMAN, 4, 5] }))
    expect(h.jogs()).toEqual([])
    expect(h.actions.filter((a) => a.type === 'say')).toEqual([{ type: 'say', text: 'simultaneous' }])
  })

  it('an axis the machine does not enable: no motion, one sentence', () => {
    const h = new Harness()
    h.ctx.enabledAxes = ['X', 'Y']
    h.arm()
    h.read(pad({ press: [DEADMAN, 4] }))
    h.read(pad({ press: [DEADMAN, 4] }))
    expect(h.jogs()).toEqual([])
    expect(h.actions.filter((a) => a.type === 'say')).toEqual([{ type: 'say', text: 'axis-not-enabled', axis: 'Z' }])
  })
})

describe('WO-3259 losing the pad, the page or eligibility drops the arm', () => {
  const cases: Array<[string, (h: Harness) => void, boolean]> = [
    ['null slot', (h) => { h.read(null) }, true],
    ['disconnected sample', (h) => { h.read({ ...pad({ press: [DEADMAN] }), connected: false }) }, true],
    ['away (another workspace, a dialog, typing, hidden, blur)', (h) => { h.read(pad({ press: [DEADMAN] }), { away: true }) }, true],
    ['leave() now', (h) => { h.actions.push(...h.machine.leave('away')) }, true],
    ['stale reads', (h) => { clock += GAMEPAD_STALE_READ_MS + 1; h.read(pad({ press: [DEADMAN] })) }, true],
    ['invalid sample', (h) => { h.read(pad({ axes: [Number.NaN, 0, 0, 0], press: [DEADMAN] })) }, true],
    ['session disabled', (h) => { h.read(pad({ press: [DEADMAN] }), { enabled: false }) }, true],
    ['E-STOP', (h) => { h.actions.push(...h.machine.noteStop('estop')) }, false],
    ['Feed Hold', (h) => { h.actions.push(...h.machine.noteStop('feed-hold')) }, false],
    ['connection replaced', (h) => { h.actions.push(...h.machine.noteConnection()) }, false],
    ['jog no longer authorized (alarm, homing, a program)', (h) => { h.read(pad({ press: [DEADMAN] }), { jogAllowed: false }) }, false],
  ]

  it.each(cases)('%s', (_name, lose, cancels) => {
    const h = new Harness()
    h.arm()
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    lose(h)
    expect(h.cancels().length).toBe(cancels ? 1 : 0)
    expect(['waiting-neutral', 'session-disabled']).toContain(h.machine.phase)
    // Coming back with everything still held replays nothing.
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    h.read(pad({ axes: [1, 0, 0, 0], press: [DEADMAN] }))
    h.read(pad({ press: [DEADMAN] }))
    h.read(pad({ axes: [-1, 0, 0, 0], press: [DEADMAN] }))
    expect(h.jogs().length).toBe(1)
  })

  it('a sample whose timestamp went back is not acted on', () => {
    const h = new Harness()
    h.arm()
    clock += 20
    h.machine.step({ ...h.ctx, now: clock, pad: { ...pad({ press: [DEADMAN] }), timestamp: 5 } })
    expect(h.machine.phase).toBe('waiting-neutral')
  })

  it('a refused deadman press says the jog gate sentence once', () => {
    const h = new Harness()
    h.read(pad())
    h.read(pad({ press: [DEADMAN] }), { jogAllowed: false, jogRefusal: 'A program is running - jogging is locked out.' })
    h.read(pad({ press: [DEADMAN] }), { jogAllowed: false, jogRefusal: 'A program is running - jogging is locked out.' })
    expect(h.actions).toEqual([{ type: 'say', text: 'refused', refusal: 'A program is running - jogging is locked out.' }])
    // Eligibility back with the deadman still held: no arm without a fresh press.
    h.read(pad({ press: [DEADMAN] }))
    expect(h.machine.phase).toBe('waiting-neutral')
  })
})

describe('WO-3259 stored preferences and capture', () => {
  it('absent prefs (an older blob) are unmapped; an unknown version is unreadable', () => {
    expect(readGamepadJogPrefs(undefined)).toEqual({ status: 'unmapped' })
    expect(readGamepadJogPrefs(null)).toEqual({ status: 'unmapped' })
    expect(readGamepadJogPrefs({ ...mapped(), schemaVersion: 2 })).toEqual({ status: 'unreadable' })
    expect(readGamepadJogPrefs({ ...mapped(), deadZone: 1 })).toEqual({ status: 'unreadable' })
    expect(readGamepadJogPrefs(JSON.parse(JSON.stringify(mapped())))).toEqual({ status: 'ok', prefs: mapped() })
  })

  it('a deadman that is also a direction, or a shared input, is a clash', () => {
    expect(gamepadMappingClash(mapped())).toBeNull()
    expect(gamepadMappingClash(mapped({ deadman: { kind: 'button', index: 4 } })))
      .toEqual({ kind: 'deadman-is-direction', direction: 'Z+' })
    const shared = mapped()
    shared.mappings['Y+'] = { kind: 'axis', index: 0, sign: 1 }
    expect(gamepadMappingClash(shared)).toEqual({ kind: 'shared', first: 'X+', second: 'Y+' })
  })

  it('capture takes a fresh button, or an axis moved from where it rested', () => {
    const rest = pad({ axes: [0, 0, -1, 0] })
    expect(capturedRawInput(rest, pad({ axes: [0, 0, -1, 0], press: [3] }))).toEqual({ kind: 'button', index: 3 })
    // A trigger resting at -1 pulled to +1 captures as its + half.
    expect(capturedRawInput(rest, pad({ axes: [0, 0, 1, 0] }))).toEqual({ kind: 'axis', index: 2, sign: 1 })
    expect(capturedRawInput(rest, pad({ axes: [0, -0.7, -1, 0] }))).toEqual({ kind: 'axis', index: 1, sign: -1 })
    expect(capturedRawInput(rest, pad({ axes: [0, -0.7, -1, 0] }), true)).toBeNull()
  })
})

// The operator, 2026-10-30, on the machine PC (installed alpha.3.2 RC 293c338f1c, Xbox 360 XInput pad, D-pad X/Y,
// bumpers Z, left-trigger deadman): with the deadman held the first press stepped 1.00 mm and every
// later press did nothing until he let go of everything - the board reports our own step as a moving
// machine, the jog gate refuses while it moves, and that refusal dropped the arm. His ruling: "unless
// I let go of the dead man it doesn't disable the step ... Fix it." Evidence:
// src/tests/evidence/ALPHA32-BOARD-2026-10-30/board/gamepad/.

/** A read `dt` ms after the last one (the harness adds 20). */
function after(h: Harness, dt: number, sample: GamepadSnapshot, over: Partial<GamepadJogContext> = {}): GamepadJogAction[] {
  clock += dt - 20
  return h.read(sample, over)
}

describe('operator 10-30: the held deadman keeps the arm across steps', () => {
  it.each(['run', 'jog'] as const)('a fresh press steps again after our own step moved (board reports %s)', (moving) => {
    const h = new Harness()
    const busy = { machineState: moving, jogAllowed: false, jogRefusal: null }
    h.arm()
    h.read(pad({ press: [DEADMAN, 4] }))
    h.read(pad({ press: [DEADMAN, 4] }), busy)
    h.read(pad({ press: [DEADMAN] }), busy)
    h.read(pad({ press: [DEADMAN] }))
    expect(h.machine.phase).toBe('armed')
    h.read(pad({ press: [DEADMAN, 5] }))
    h.read(pad({ press: [DEADMAN, 5] }), busy)
    h.read(pad({ press: [DEADMAN] }))
    h.read(pad({ press: [DEADMAN, 4] }))
    expect(h.jogs().map((j) => [j.axis, j.deltaMm])).toEqual([['Z', 1], ['Z', -1], ['Z', 1]])
    expect(h.cancels()).toEqual([])
  })

  it('a direction held through our own step is not stepped again when it ends', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ press: [DEADMAN, 4] }))
    h.read(pad({ press: [DEADMAN, 4] }), { machineState: 'run', jogAllowed: false })
    h.read(pad({ press: [DEADMAN, 4] }))
    h.read(pad({ press: [DEADMAN, 4] }))
    expect(h.jogs().length).toBe(1)
    h.read(pad({ press: [DEADMAN] }))
    h.read(pad({ press: [DEADMAN, 4] }))
    expect(h.jogs().length).toBe(2)
  })

  it('letting go of the deadman while our own step moves cancels it and disarms', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ press: [DEADMAN, 4] }))
    h.read(pad({ press: [4] }), { machineState: 'run', jogAllowed: false })
    expect(h.cancels()).toEqual([{ type: 'cancel', gesture: 1 }])
    h.read(pad())
    h.read(pad({ press: [4] }))
    expect(h.jogs().length).toBe(1)
  })

  it.each(['alarm', 'hold', 'home'] as const)('real ineligibility (%s) while our step moves still drops the arm', (state) => {
    const h = new Harness()
    h.arm()
    h.read(pad({ press: [DEADMAN, 4] }))
    h.read(pad({ press: [DEADMAN] }), { machineState: state, jogAllowed: false })
    expect(h.machine.phase).toBe('waiting-neutral')
    h.read(pad({ press: [DEADMAN] }))
    h.read(pad({ press: [DEADMAN, 5] }))
    expect(h.jogs().length).toBe(1)
  })

  it('a program running (not our step) with the deadman held still drops the arm', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ press: [DEADMAN] }), { machineState: 'run', jogAllowed: false, jogRefusal: 'A program is running - jogging is locked out.' })
    expect(h.machine.phase).toBe('waiting-neutral')
  })
})

describe('operator 10-30: a stick springing back past centre is not a fresh press', () => {
  // Measured on the machine PC (raw navigator.getGamepads, 30 ms samples): a full push on axis 1 let go
  // overshot to -0.33 for one sample (past the 0.20 dead zone) before resting. The pass through
  // centre on the way can land on a read of its own, so it is in the trace.
  const REBOUND: Array<[number, number]> = [[0, 0.26], [32, 0.87], [27, 1], [241, 0.99], [31, 1], [45, 0], [44, -0.33], [30, 0]]

  it('the recorded rebound after a Y- push asks for exactly one Y- step, never Y+', () => {
    const h = new Harness()
    h.arm()
    for (const [dt, a] of REBOUND) after(h, dt, pad({ axes: [0, a, 0, 0], press: [DEADMAN] }))
    for (let i = 0; i < 10; i++) h.read(pad({ press: [DEADMAN] }))
    expect(h.jogs().map((j) => [j.axis, j.deltaMm])).toEqual([['Y', -1]])
  })

  it('once the stick has rested past the settle time, a fresh push steps', () => {
    const h = new Harness()
    h.arm()
    for (const [dt, a] of REBOUND) after(h, dt, pad({ axes: [0, a, 0, 0], press: [DEADMAN] }))
    after(h, 150, pad({ press: [DEADMAN] }))
    h.read(pad({ axes: [0, -1, 0, 0], press: [DEADMAN] }))
    expect(h.jogs().map((j) => [j.axis, j.deltaMm])).toEqual([['Y', -1], ['Y', 1]])
  })

  it('buttons need no settle: his fastest D-pad re-press (88 ms) still steps', () => {
    const h = new Harness()
    h.arm()
    h.read(pad({ press: [DEADMAN, 4] }))
    after(h, 150, pad({ press: [DEADMAN] }))
    after(h, 88, pad({ press: [DEADMAN, 4] }))
    expect(h.jogs().length).toBe(2)
  })
})
