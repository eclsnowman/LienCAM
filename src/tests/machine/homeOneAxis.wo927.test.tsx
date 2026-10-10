// @vitest-environment jsdom
//
// WO-927: HOME ONE AXIS, NOT ALL OF THEM.
//
// The defect: `JogPanel` had exactly one homing control, Home All, which
// resolves this machine's order and sends the whole list. On Operator's machine
// that order is Z, X, Y - so "home Z" IMMEDIATELY DRIVES X NEXT, and X is the
// axis that ran 229mm into a stop on 2026-08-23 and against its hard stop on
// 2026-08-21. The acceptance demo for the scripted hardware session is
// "change one axis's setting, apply, home THAT AXIS, watch the outcome
// change", and until this landed the app could not do it at all.
//
// The plumbing was already there and unused: `homeAxes(axes)` on the contract,
// implemented in both backends, and the bridge homes ONE axis per HomeOn call
// - per-axis IS the native shape and the full cycle is the loop. So this is a
// UI affordance over `homeAxes([axis])`, not new machinery.
//
// THE HEADLINE these tests exist to hold down: homing a single axis commands
// EXACTLY that axis and no other, observed at the controller - the simulator
// genuinely sequences axes, so "only X moved" is a fact about machine
// position, not about which function was called.
//
// The remaining controller safety questions, and where each is pinned below:
//   1. THE GANTRY (section 4). Y is slaved to A and the bridge refuses to home
//      Y if the board is not holding the slave. A single-axis request is the
//      SAME `homeAxes` call Home All makes, so that refusal rejects the same
//      promise and lands on the same console, verbatim.
//   2. GRBL (section 5). `capabilities.perAxisHoming` is false there: the
//      gesture is not advertised on any control, and refuses honestly rather
//      than falling back to a whole-machine $H, if tried anyway.
//
// WO-1120 makes the app-side order decision explicit: Home All still follows
// the machine order, while Home X/Y/Z is the operator's choice and sends that
// one axis immediately on the first press. WO-1128 supersedes only "every
// press": presses during that cycle are refused, and the next press after
// completion is a new command without any confirmation gesture.
//
// WO-931 REPIN (2026-08-24). This suite was written for WO-927's Alt-click on
// the six jog buttons, chosen because the rail had no vertical budget. Operator
// REJECTED that control - "Using the alt key for homing an axis sets a user up
// to crash or break an endmill if they don't know the functionality exists. I
// want selecting things to be explicit."
//
// So the TRIGGER moved to three labelled per-axis Home buttons. WO-1120 later
// removed the app's order/confirmation gate while preserving the gantry
// refusal, the honest refusal on a controller that cannot home per axis, and a
// refused home not marking the session homed.
//
// Two tests were INVERTED rather than repointed, because they asserted the
// property he overturned:
//   - "THE AFFORDANCE COSTS NOTHING ... not in a new control" is now "THE
//     AFFORDANCE IS A CONTROL, NOT A SECRET".
//   - "the gesture is not advertised where the controller cannot do it" is now
//     "the control is ABSENT there" - absent beats present-and-refusing.
// One test was ADDED: the old gesture is dead, and Alt-click now jogs.
//
// The layout budget that drove the original choice was paid rather than
// argued: the jog step sizes became a dropdown and the panel went 343 -> 349px.
// Measured before/after numbers are in src/tests/evidence/WO-931/.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ConsoleEntry, MachineController } from '../../lib/machine/controller'
import { createDefaultControllerDefinition } from '../../types'
import type { AxisName } from '../../types'

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

const { JogPanel } = await import('../../components/machine/JogPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { __resetEstopInterlockForTest, connectMachine, disconnectMachine, getMachineController } =
  await import('../../lib/machine/machineSession')

// ---------------------------------------------------------------------------
// 1. THE HEADLINE - ONE AXIS MOVES, OBSERVED AT THE CONTROLLER
// ---------------------------------------------------------------------------

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')
}

/** Which axes report homed, in the order the machine reached their switches. */
function homedSoFar(ctrl: MachineController): string[] {
  return Object.entries(ctrl.status().homed ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k)
}

function setOrder(order: AxisName[] | null): void {
  const machine = useCamStore.getState().project.machine!
  if (order === null) {
    const { controllerDefinition: _drop, ...rest } = machine
    useCamStore.getState().updateMachine(rest)
    return
  }
  const definition = createDefaultControllerDefinition()
  definition.homing.order = order
  useCamStore.getState().updateMachine({ ...machine, controllerDefinition: definition })
}

/** WO-931 REPIN: the trigger moved from a modifier to an explicit button. */
function homePress(axis: 'X' | 'Y' | 'Z'): void {
  fireEvent.click(screen.getByTestId(`control-home-${axis.toLowerCase()}`))
}

/** Which axis a jog test id names, so the repin is mechanical and visible. */
function altClick(testId: string): void {
  const axis = testId.includes('-x-') ? 'X' : testId.includes('-y-') ? 'Y' : 'Z'
  homePress(axis)
}

function plainClick(testId: string): void {
  fireEvent.pointerDown(screen.getByTestId(testId), { altKey: false })
  fireEvent.pointerUp(screen.getByTestId(testId))
}

/** WO-1128: a later home is legitimate only after the reported cycle ends. */
function finishReportedHomeCycle(): void {
  act(() => useMachineControl.setState({ machineState: 'home' }))
  act(() => useMachineControl.setState({ machineState: 'idle' }))
}

describe('WO-927 homing one axis', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineJogContinuous: false, machineJogStepMm: 10, machineJogFeedMmMin: 1000 })
    await connectMachine('simulator')
    // These cases inspect homing after the startup E-STOP has been cleared.
    __resetEstopInterlockForTest()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
    useMachineControl.getState().clearConsole()
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await disconnectMachine()
    vi.useRealTimers()
  })

  it('THE ACCEPTANCE ITEM: "home Z" homes Z AND NOTHING ELSE - X never moves', async () => {
    // This is the exact defect. Before WO-927 the only homing control sent
    // the whole order, so pressing it with Z in mind drove X next - into the
    // stop it had already hit twice that week.
    const ctrl = getMachineController()
    const start = ctrl.status().machinePos!
    render(<JogPanel />)

    altClick('control-jog-z-plus')

    // The whole single-axis cycle, and then some.
    await vi.advanceTimersByTimeAsync(2000)

    expect(homedSoFar(ctrl)).toEqual(['Z'])
    expect(ctrl.status().machinePos!.z).toBe(0)
    expect(ctrl.status().machinePos!.x).toBe(start.x)
    expect(ctrl.status().machinePos!.y).toBe(start.y)
    expect(ctrl.machineState()).toBe('idle')
  })

  it('AT THE BOUNDARY: exactly one homeAxes call, carrying exactly ["Z"], and no home()', () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    const home = vi.spyOn(getMachineController(), 'home').mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-z-plus')

    expect(homeAxes).toHaveBeenCalledTimes(1)
    expect(homeAxes).toHaveBeenCalledWith(['Z'])
    // Never the orderless whole-machine cycle, which is what would have moved
    // three axes.
    expect(home).not.toHaveBeenCalled()
  })

  it('either button for an axis means the same axis - the machine picks the direction', () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-z-minus')

    expect(homeAxes).toHaveBeenCalledWith(['Z'])
  })

  it('a single-axis choice is independent of Home All order', () => {
    setOrder(['Y', 'X', 'Z'])
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-y-plus')

    expect(homeAxes).toHaveBeenCalledWith(['Y'])
  })

  it('reports one plain informational console line', () => {
    vi.spyOn(getMachineController() as Required<MachineController>, 'homeAxes').mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-z-plus')

    expect(consoleText()).toBe('Homing Z.')
    expect(useMachineControl.getState().consoleLines).toHaveLength(1)
    expect(useMachineControl.getState().consoleLines[0]?.severity).toBe('info')
  })

  it('a controller refusal at the call site is reported, not swallowed', () => {
    vi.spyOn(getMachineController() as Required<MachineController>, 'homeAxes').mockReturnValue(false)
    render(<JogPanel />)

    altClick('control-jog-z-plus')

    expect(consoleText()).toMatch(/Home Z was refused by the controller - nothing was homed/)
  })
})

// ---------------------------------------------------------------------------
// 2. WO-1120 - A SINGLE-AXIS HOME IS THE OPERATOR'S CHOICE
// ---------------------------------------------------------------------------

describe('WO-1120 homing one axis is the user\'s choice', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineJogContinuous: false, machineJogStepMm: 10, machineJogFeedMmMin: 1000 })
    await connectMachine('simulator')
    __resetEstopInterlockForTest()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
    useMachineControl.getState().clearConsole()
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await disconnectMachine()
    vi.useRealTimers()
  })

  it('THE ACCEPTANCE ITEM: first Home X press sends X with Z unhomed', () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-x-plus')

    expect(homeAxes).toHaveBeenCalledTimes(1)
    expect(homeAxes).toHaveBeenCalledWith(['X'])
    expect(consoleText()).toBe('Homing X.')
    expect(consoleText()).not.toMatch(/NOTHING MOVED|Press Home X again|tool in the spindle/)
  })

  it('every Home X press after the prior cycle is a command, not a confirmation gesture', () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-x-plus')
    altClick('control-jog-x-plus')
    expect(homeAxes).toHaveBeenCalledTimes(1)

    finishReportedHomeCycle()
    altClick('control-jog-x-plus')

    expect(homeAxes).toHaveBeenCalledTimes(2)
    expect(homeAxes.mock.calls).toEqual([[['X']], [['X']]])
    expect(consoleText()).toBe('Homing X.\nHoming X.')
  })

  it('AND IT REALLY IS ONLY X: through the real simulator, Y and Z never move', async () => {
    const ctrl = getMachineController()
    const start = ctrl.status().machinePos!
    render(<JogPanel />)

    altClick('control-jog-x-plus')
    await vi.advanceTimersByTimeAsync(2000)

    expect(homedSoFar(ctrl)).toEqual(['X'])
    expect(ctrl.status().machinePos!.x).toBe(0)
    expect(ctrl.status().machinePos!.y).toBe(start.y)
    expect(ctrl.status().machinePos!.z).toBe(start.z)
  })

  it('elapsed time does not create or expire a confirmation window', async () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-x-plus')
    await vi.advanceTimersByTimeAsync(6001)
    altClick('control-jog-x-plus')

    expect(homeAxes).toHaveBeenCalledTimes(2)
    expect(homeAxes).toHaveBeenNthCalledWith(1, ['X'])
    expect(homeAxes).toHaveBeenNthCalledWith(2, ['X'])
  })

  it('each axis button sends the axis the operator selected immediately', () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-x-plus')
    finishReportedHomeCycle()
    altClick('control-jog-y-plus')

    expect(homeAxes.mock.calls).toEqual([[['X']], [['Y']]])
  })

  it('a previously homed axis does not change the first-press behavior', async () => {
    const ctrl = getMachineController()
    render(<JogPanel />)

    altClick('control-jog-z-plus')
    await vi.advanceTimersByTimeAsync(2000)
    expect(homedSoFar(ctrl)).toEqual(['Z'])

    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    altClick('control-jog-x-plus')

    expect(homeAxes).toHaveBeenCalledTimes(1)
    expect(homeAxes).toHaveBeenCalledWith(['X'])
  })

  it('THE GAP THIS WO PINNED IS CLOSED (WO-930): one axis does NOT flip homedThisSession()', async () => {
    // AS PINNED BY WO-927, AND FIXED BY WO-930. Both backends used to set a
    // "homed this session" flag when a homeAxes call COMPLETED, whatever the
    // list was - simulatedController.ts:1511 and uccncController.ts:516 - so
    // homing Z alone reported the session homed while X and Y were still
    // unreferenced, and machineSession's `homedThisSession()` probe gates
    // opened. Those two files belonged to other lanes, so this WO could only
    // record the gap; WO-930 owns them and closed it by deriving the boolean
    // from the per-axis truth this control already reasoned from.
    //
    // The assertion is INVERTED rather than deleted: the sentence this file
    // wants to keep making is "one axis is one axis", and it now makes it
    // about the boolean as well as about `status().homed`.
    const ctrl = getMachineController()
    render(<JogPanel />)

    altClick('control-jog-z-plus')
    await vi.advanceTimersByTimeAsync(2000)

    expect(ctrl.homedThisSession()).toBe(false)
    // ...and the per-axis truth, which the UI uses, agrees with it now.
    expect(homedSoFar(ctrl)).toEqual(['Z'])
  })
})

// ---------------------------------------------------------------------------
// 4. THE GESTURE IS A HOME, NEVER ALSO A JOG - AND HOME ALL IS UNTOUCHED
// ---------------------------------------------------------------------------

describe('WO-927 the gesture does not disturb what was already there', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineJogContinuous: false, machineJogStepMm: 10, machineJogFeedMmMin: 1000 })
    await connectMachine('simulator')
    __resetEstopInterlockForTest()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
    useMachineControl.getState().clearConsole()
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await disconnectMachine()
    vi.useRealTimers()
  })

  it('a home press never ALSO jogs - a home request is not half a nudge', () => {
    const jog = vi.spyOn(getMachineController(), 'jog').mockReturnValue(true)
    vi.spyOn(getMachineController() as Required<MachineController>, 'homeAxes').mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-z-plus')

    expect(jog).not.toHaveBeenCalled()
  })

  it('a plain click still jogs, and never homes', () => {
    const jog = vi.spyOn(getMachineController(), 'jog').mockReturnValue(true)
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    plainClick('control-jog-z-plus')

    expect(jog).toHaveBeenCalledWith('Z', 10, 1000)
    expect(homeAxes).not.toHaveBeenCalled()
  })

  it('HOME ALL IS UNCHANGED: it still sends this machine\'s whole order, in order', async () => {
    await disconnectMachine()
    setOrder(['Y', 'X', 'Z'])
    await connectMachine('simulator')
    __resetEstopInterlockForTest()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    const home = vi.spyOn(getMachineController(), 'home').mockReturnValue(true)
    render(<JogPanel />)

    fireEvent.click(screen.getByTestId('control-home'))

    expect(homeAxes).toHaveBeenCalledWith(['Y', 'X', 'Z'])
    expect(home).not.toHaveBeenCalled()
  })

  it('a single-axis command does not replace or reorder Home All after it finishes', () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    altClick('control-jog-x-plus')
    finishReportedHomeCycle()
    fireEvent.click(screen.getByTestId('control-home'))

    expect(homeAxes).toHaveBeenCalledTimes(2)
    expect(homeAxes).toHaveBeenNthCalledWith(1, ['X'])
    expect(homeAxes).toHaveBeenNthCalledWith(2, ['Z', 'X', 'Y'])
  })

  // WO-931 REPIN. This test asserted the OPPOSITE of what Operator then ruled:
  // that the affordance costs nothing because it hides in hover context and
  // adds no control. He rejected exactly that - "I want selecting things to be
  // explicit" - so the property is inverted rather than deleted. What survives
  // unchanged is the WO-914 part: Home All still says which order it runs.
  it('THE AFFORDANCE IS A CONTROL, NOT A SECRET: three buttons, no hidden gesture', () => {
    render(<JogPanel />)

    // Each axis has its own labelled button, reachable with no modifier and
    // no prior knowledge. That single property IS WO-931.
    for (const axis of ['Z', 'X', 'Y'] as const) {
      const btn = screen.getByTestId(`control-home-${axis.toLowerCase()}`)
      expect(btn.tagName).toBe('BUTTON')
      expect(btn.getAttribute('aria-label')).toBe(`Home ${axis} only`)
    }

    // And nothing on the jog buttons advertises a gesture any more, because
    // there is no longer a gesture to advertise.
    expect(screen.getByTestId('control-jog-x-plus').getAttribute('data-tooltip'))
      .not.toMatch(/Alt/)
    expect(screen.getByTestId('control-home').getAttribute('data-tooltip'))
      .not.toMatch(/Alt/)

    // WO-914 survives: Home All still names the order it will run.
    expect(screen.getByTestId('control-home').getAttribute('data-tooltip'))
      .toContain('Z, X, Y')
  })

  it('THE OLD GESTURE IS DEAD: Alt-click on a jog button jogs, and homes nothing', () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    const home = vi.spyOn(getMachineController(), 'home').mockReturnValue(true)
    const jog = vi.spyOn(getMachineController(), 'jog')
    render(<JogPanel />)

    // The exact press WO-927 built, on the axis its own headline test used.
    fireEvent.pointerDown(screen.getByTestId('control-jog-z-plus'), { altKey: true })
    fireEvent.pointerUp(screen.getByTestId('control-jog-z-plus'))

    // NOTHING HOMED. This is what proves the hazard is GONE rather than merely
    // unadvertised: someone who learned the old gesture, or who simply happens
    // to be holding Alt, gets the jog they aimed at and never a homing cycle.
    // Operator's objection was that a user "doesn't know the functionality exists"
    // - removing the tooltip would not have answered it, only removing this.
    expect(homeAxes).not.toHaveBeenCalled()
    expect(home).not.toHaveBeenCalled()
    expect(jog).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 4. THE GANTRY REFUSAL REACHES THE OPERATOR
// ---------------------------------------------------------------------------

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(message: BridgeCallMessage): void { this.sent.push(message) }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
  lastCall(m: string): BridgeCallMessage {
    const last = this.sent.filter((c) => c.m === m).at(-1)
    if (!last) throw new Error(`no call sent for "${m}"; sent: ${this.sent.map((c) => c.m).join(', ')}`)
    return last
  }
}

async function connectedBridge(perAxisHoming = true) {
  const transport = new FakeTransport()
  const console: ConsoleEntry[] = []
  const controller = new UccncController({ onConsole: (e) => console.push(e) })
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.2',
      capabilities: {
        geometryQueue: true, executingMoveId: true, bufferSeconds: true,
        gcodeText: false, perAxisHoming,
        ownsSpindle: true, spindleCommands: false,
      },
      readOnly: false,
    },
  })
  await connecting
  return { controller, transport, console }
}

describe('WO-927 SAFETY: a single-axis request on the wire', () => {
  it('ONE AXIS, VERBATIM: homing Y alone puts exactly ["Y"] on the wire', async () => {
    const { controller, transport } = await connectedBridge()
    expect(controller.homeAxes(['Y'])).toBe(true)
    expect(transport.lastCall('homeAxes').a).toEqual({ axes: ['Y'] })
    // Not the whole cycle, and not the orderless call the bridge refuses.
    expect(transport.sent.some((c) => c.m === 'home')).toBe(false)
  })

  it('THE GANTRY: the bridge\'s slave refusal reaches the console for a single-axis request', async () => {
    // Y is slaved to A on this machine and `Machine.HomeAxes` refuses if the
    // board is not holding the slave. A single-axis home is the SAME call, so
    // the refusal rejects the same promise and `reportCallFailure` puts the
    // bridge's own sentence on the console - the surface machineSession pipes
    // into the operator's console (machineSession.ts onConsole). Nothing here
    // rewrites, shortens or replaces it.
    const { controller, transport, console } = await connectedBridge()
    expect(controller.homeAxes(['Y'])).toBe(true)
    const seq = transport.lastCall('homeAxes').seq
    transport.emit({
      t: 'reply',
      seq,
      ok: false,
      error: 'refusing to home Y: the board is not holding the A slave. Nothing was homed.',
    })
    await Promise.resolve()
    await Promise.resolve()

    const errors = console.filter((e) => e.severity === 'error').map((e) => e.text)
    expect(errors.join('\n')).toContain('the board is not holding the A slave')
    expect(errors.join('\n')).toContain('Nothing was homed')
  })

  it('and a refused single-axis home does NOT mark the session homed', async () => {
    const { controller, transport } = await connectedBridge()
    controller.homeAxes(['Y'])
    transport.emit({
      t: 'reply',
      seq: transport.lastCall('homeAxes').seq,
      ok: false,
      error: 'refusing to home Y: the board is not holding the A slave.',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.homedThisSession()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. GRBL CANNOT DO THIS, AND SAYS SO
// ---------------------------------------------------------------------------

/** GRBL: no geometry queue, no per-axis homing - $H runs its own cycle. */
const GRBL_CAPS = {
  geometryQueue: false, executingMoveId: false, bufferSeconds: false,
  gcodeText: true, perAxisHoming: false,
  ownsSpindle: true, spindleCommands: true,
}

describe('WO-927 SAFETY: a controller that cannot home per axis', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineJogContinuous: false, machineJogStepMm: 10, machineJogFeedMmMin: 1000 })
    await connectMachine('simulator')
    __resetEstopInterlockForTest()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
    useMachineControl.getState().clearConsole()
    // GRBL: `capabilities.perAxisHoming` is false (uccncController.ts:87's
    // default, and GRBL's own $H runs the cycle its firmware config holds).
    Object.defineProperty(getMachineController(), 'capabilities', {
      configurable: true,
      get: () => GRBL_CAPS,
    })
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await disconnectMachine()
    vi.useRealTimers()
  })

  it('THE CONTROL IS ABSENT where the controller cannot do it', () => {
    render(<JogPanel />)
    // WO-931 REPIN: WO-927 could only decline to ADVERTISE the gesture, because
    // a modifier exists on every button whether it is mentioned or not. An
    // explicit control can simply not be there - and absent is a stronger
    // guarantee than present-and-refusing. "Never invent a machine fact" cuts
    // this way too: a Home X button on a controller that cannot home X alone
    // would be the surface claiming a capability the machine does not have.
    for (const axis of ['Z', 'X', 'Y'] as const) {
      expect(screen.queryByTestId(`control-home-${axis.toLowerCase()}`)).toBeNull()
    }
    expect(screen.getByTestId('control-jog-x-plus').getAttribute('data-tooltip')).toBe('Jog X+')
  })

  it('a stale Home X control refuses honestly and never substitutes whole-machine $H', () => {
    const ctrl = getMachineController()
    Object.defineProperty(ctrl, 'capabilities', {
      configurable: true,
      get: () => ({ ...GRBL_CAPS, perAxisHoming: true }),
    })
    const homeAxes = vi.spyOn(ctrl as Required<MachineController>, 'homeAxes').mockReturnValue(true)
    const home = vi.spyOn(ctrl, 'home').mockReturnValue(true)
    render(<JogPanel />)

    // Capabilities can change during a disconnect while the old render is
    // still on screen. Exercise the handler's own guard, not only the render
    // guard that normally removes these buttons for GRBL.
    Object.defineProperty(ctrl, 'capabilities', {
      configurable: true,
      get: () => GRBL_CAPS,
    })
    fireEvent.click(screen.getByTestId('control-home-x'))

    expect(homeAxes).not.toHaveBeenCalled()
    expect(home).not.toHaveBeenCalled()
    expect(consoleText()).toMatch(/cannot home one axis at a time/)
    expect(consoleText()).toMatch(/Use Home All/)
    expect(consoleText()).toMatch(/X was NOT homed and nothing moved/)
    expect(consoleText()).not.toContain('Homing X.')
    expect(useMachineControl.getState().consoleLines[0]?.severity).toBe('error')
  })

  it('Home All still works there - it just asks the controller for its own cycle', () => {
    const home = vi.spyOn(getMachineController(), 'home').mockReturnValue(true)
    render(<JogPanel />)

    fireEvent.click(screen.getByTestId('control-home'))

    expect(home).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('control-home').getAttribute('data-tooltip'))
      .toMatch(/chooses its own axis order/)
  })
})
