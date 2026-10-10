// @vitest-environment jsdom
//
// WO-914: THE HOMING ORDER BECOMES A SETTING, AND THE APP PASSES IT.
//
// Before this, the order a machine homed its axes in was a hardcoded C#
// literal - `HomeAxes(new List<string> { "Z", "X", "Y" })` at Machine.cs:2148 -
// that ran on every machine on earth. It matched Operator's profile's
// `Homesequence` by coincidence, not by lookup: `Homesequence` appeared
// EXACTLY ONCE in the whole bridge, in a comment. The app passed no order at
// all, even though `homeAxes(axes)` existed unused on both sides.
//
// THIS IS A SAFETY ORDER, NOT A CONVENIENCE. Homing Z last on a router with a
// tool in the spindle drives the tool through the work on its way to the X or
// Y switch. An order that is right for one machine is dangerous on another.
//
// The three things these tests exist to hold down:
//
//   1. THE FALLBACK LIVES IN EXACTLY ONE PLACE. Every profile that exists
//      today has no `controllerDefinition`, so the fallback is the COMMON
//      path. `resolveHomingOrder` is the only reader of `DEFAULT_HOMING_ORDER`
//      and `DEFAULT_HOMING_ORDER` is the only Z,X,Y in the product. There is a
//      test below that walks the source and fails if a second copy appears -
//      in `src/` OR in the bridge.
//   2. THE TWO SIDES CANNOT DISAGREE. The app is authoritative. The bridge
//      holds no order and `Machine.Home()` REFUSES rather than substituting
//      one, so a future reader can never be in doubt about which list ran.
//   3. NO GATE MAY EVER BLOCK A STOP. Nothing here sits between the operator
//      and the E-STOP. The converse is also asserted: an E-STOP pressed during
//      a homing cycle ABANDONS the cycle rather than letting it run to
//      completion behind the latch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { SimulatedController, type SimulatedController as Sim } from '../../lib/machine/simulatedController'
import { resolveHomingOrder } from '../../lib/machine/controller'
import type { ControllerEvents, MachineController } from '../../lib/machine/controller'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import { DEFAULT_HOMING_ORDER, createDefaultControllerDefinition } from '../../types'
import type { AxisName, ControllerDefinition } from '../../types'

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
const { connectMachine, disconnectMachine, getMachineController, __resetEstopInterlockForTest } =
  await import('../../lib/machine/machineSession')

// ---------------------------------------------------------------------------
// 1. THE FALLBACK - ONE PLACE, Z FIRST
// ---------------------------------------------------------------------------

describe('WO-914 the fallback homing order', () => {
  it('SAFETY DEFAULT, NOT A PREFERENCE: a machine with no definition homes Z FIRST', () => {
    // The common path, not the edge case: WO-912 made `controllerDefinition`
    // optional, so EVERY profile that exists today lands here.
    expect(resolveHomingOrder(null)).toEqual(['Z', 'X', 'Y'])
    expect(resolveHomingOrder(undefined)).toEqual(['Z', 'X', 'Y'])
    expect(resolveHomingOrder(null)[0]).toBe('Z')
  })

  it('SAFETY DEFAULT: an empty order is not an order - it falls back to Z first, it does not home nothing', () => {
    const def = createDefaultControllerDefinition()
    def.homing.order = []
    expect(resolveHomingOrder(def)).toEqual(['Z', 'X', 'Y'])
    expect(resolveHomingOrder(def)[0]).toBe('Z')
  })

  it('reaches the ONE constant rather than carrying a literal of its own', () => {
    expect(resolveHomingOrder(null)).toEqual([...DEFAULT_HOMING_ORDER])
  })

  it('hands back a copy, so no caller can mutate the product-wide default', () => {
    const order = resolveHomingOrder(null)
    order.push('A')
    expect([...DEFAULT_HOMING_ORDER]).toEqual(['Z', 'X', 'Y'])
    expect(resolveHomingOrder(null)).toEqual(['Z', 'X', 'Y'])
  })

  it('an explicit order is passed through verbatim - not reordered, not "corrected" to Z first', () => {
    const def = createDefaultControllerDefinition()
    def.homing.order = ['Y', 'X', 'Z']
    // The product does NOT silently rewrite a machine's own order. Z-first is
    // the DEFAULT for a machine that has not said; a machine that HAS said is
    // obeyed, because the person who wired it knows what its switches do.
    expect(resolveHomingOrder(def)).toEqual(['Y', 'X', 'Z'])
  })
})

// ---------------------------------------------------------------------------
// 2. THE LITERAL EXISTS IN EXACTLY ONE PLACE - THE GUARD ON THE WHOLE ORDER
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'evidence') continue
      walk(full, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full.replace(/\\/g, '/'))
    }
  }
  return out
}

/** Comments are allowed to SPELL OUT the order - that is how the reason
 *  survives. What must not exist twice is the list in CODE. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const Z_X_Y_ARRAY = /\[\s*(['"`])Z\1\s*,\s*(['"`])X\2\s*,\s*(['"`])Y\3\s*,?\s*\]/

describe('WO-914 THE ONE-PLACE RULE', () => {
  it('the Z,X,Y list appears in CODE in exactly one file under src/, and it is the types module', () => {
    const offenders = walk('src')
      .filter((f) => !f.startsWith('src/tests/'))
      .filter((f) => Z_X_Y_ARRAY.test(stripComments(readFileSync(f, 'utf8'))))
    expect(
      offenders,
      'THE DEFECT WO-914 EXISTS TO REMOVE IS THIS LITERAL EXISTING TWICE.\n' +
      'The order a machine homes its axes in is a safety setting - Z last on a\n' +
      'router with a tool in the spindle drives the tool through the work on\n' +
      'the way to its switch - and with the list written in two files nobody\n' +
      'can tell which copy ran. There is one: DEFAULT_HOMING_ORDER in\n' +
      'src/types/index.ts, reached through resolveHomingOrder() in\n' +
      'src/lib/machine/controller.ts. Use it; do not copy it.\n' +
      'Offending files: ' + offenders.join(', '),
    ).toEqual(['src/types/index.ts'])
  })

  it('THE BRIDGE HOLDS NO HOMING ORDER AT ALL - not a literal, not a second default', () => {
    const bridge = readdirSync('pendant/uccnc-bridge')
      .filter((f) => f.endsWith('.cs'))
      .map((f) => join('pendant/uccnc-bridge', f).replace(/\\/g, '/'))
    expect(bridge.length).toBeGreaterThan(0)
    // Comments STRIPPED FIRST, on the WO-912 precedent: the reason a rule
    // exists must be free to name the thing it forbids. What is forbidden is
    // the list in CODE.
    const offenders = bridge.filter((f) =>
      /\{\s*"Z"\s*,\s*"X"\s*,\s*"Y"\s*\}/.test(stripComments(readFileSync(f, 'utf8'))),
    )
    expect(
      offenders,
      'Machine.cs used to answer Home() with HomeAxes(new List<string> {"Z","X","Y"}).\n' +
      'The app is authoritative for the homing order and the bridge must not\n' +
      'substitute a list of its own - if both ends carry one, a future reader\n' +
      'cannot tell which ran. Offending files: ' + offenders.join(', '),
    ).toEqual([])
  })

  it('Machine.Home() refuses instead of guessing, and says what to send instead', () => {
    const cs = readFileSync('pendant/uccnc-bridge/Machine.cs', 'utf8')
    const body = cs.slice(cs.indexOf('public bool Home(out string err)'))
    const home = body.slice(0, body.indexOf('public bool HomeAxes'))
    expect(home).toContain('return false;')
    expect(home).toMatch(/no homing order was given/)
    expect(home).toMatch(/homeAxes/)
    // It must NOT quietly fall through to a cycle of its own.
    expect(home).not.toMatch(/return HomeAxes\(/)
  })

  it('HomeAxes validates the WHOLE order before homing any of it', () => {
    // The list used to be a literal and could not be wrong. It is now typed by
    // a person, and finding "unknown axis" on the third entry would leave the
    // machine part-homed with a refusal that says nothing about which axes
    // moved. Same rule as the live apply: refuse whole, change nothing.
    const cs = readFileSync('pendant/uccnc-bridge/Machine.cs', 'utf8')
    const homeAxes = cs.slice(cs.indexOf('public bool HomeAxes(List<string> axes'))
    expect(homeAxes).toMatch(/refusing the whole homing order: unknown axis/)
    expect(homeAxes).toMatch(/refusing the whole homing order: axis .* is listed twice/)
    expect(homeAxes).toMatch(/Nothing was homed/)
  })
})

// ---------------------------------------------------------------------------
// 3. THE HEADLINE - THE SIMULATOR HOMES IN THE ORDER IT WAS GIVEN
// ---------------------------------------------------------------------------

const HOME_CONVENTION = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}

function makeEvents(): ControllerEvents & { homed: Array<AxisName[] | null> } {
  const homed: Array<AxisName[] | null> = []
  return { homed, onHomed: (axes) => homed.push(axes as AxisName[] | null) }
}

async function connectedSim() {
  const events = makeEvents()
  const ctrl: Sim = new SimulatedController(events, {
    travelMm: { x: 300, y: 300, z: 100 },
    homeConvention: HOME_CONVENTION,
  })
  await ctrl.connect({ kind: 'none' })
  return { ctrl, events }
}

/** Which axes report `homed`, in insertion order - the sequence the machine
 *  actually reached its switches in. */
function homedSoFar(ctrl: MachineController): string[] {
  return Object.entries(ctrl.status().homed ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k)
}

describe('WO-914 a machine homes in ITS OWN order', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // THE ACCEPTANCE ITEM. Deliberately NOT Z,X,Y: a test that passes with the
  // default proves nothing, because the default is what the code did before.
  it('THE HEADLINE: an explicit order of Y, X, Z homes Y then X then Z - not the default', async () => {
    const { ctrl, events } = await connectedSim()
    const def: ControllerDefinition = createDefaultControllerDefinition()
    def.homing.order = ['Y', 'X', 'Z']

    const start = ctrl.status().machinePos!
    expect(ctrl.homeAxes!(resolveHomingOrder(def))).toBe(true)
    expect(ctrl.machineState()).toBe('home')

    // First slot: Y is on its switch. X and Z have not moved at all.
    await vi.advanceTimersByTimeAsync(520)
    expect(homedSoFar(ctrl)).toEqual(['Y'])
    expect(ctrl.status().machinePos!.y).toBe(0)
    expect(ctrl.status().machinePos!.x).toBe(start.x)
    expect(ctrl.status().machinePos!.z).toBe(start.z)
    expect(ctrl.homedThisSession()).toBe(false)

    // Second slot: X joins it. Z still has not moved.
    await vi.advanceTimersByTimeAsync(500)
    expect(homedSoFar(ctrl)).toEqual(['Y', 'X'])
    expect(ctrl.status().machinePos!.z).toBe(start.z)

    // Third slot: Z last, because THIS machine said so.
    await vi.advanceTimersByTimeAsync(500)
    expect(homedSoFar(ctrl)).toEqual(['Y', 'X', 'Z'])
    expect(ctrl.homedThisSession()).toBe(true)
    expect(ctrl.machineState()).toBe('idle')
    expect(ctrl.status().machinePos).toEqual({ x: 0, y: 0, z: 0 })

    // And the completion event reports the real sequence, not a canonical one.
    expect(events.homed).toEqual([['Y', 'X', 'Z']])
  })

  it('THE NEGATIVE CONTROL: a machine with no order homes exactly as today - Z, X, Y', async () => {
    const { ctrl, events } = await connectedSim()
    const start = ctrl.status().machinePos!

    expect(ctrl.homeAxes!(resolveHomingOrder(null))).toBe(true)

    await vi.advanceTimersByTimeAsync(520)
    expect(homedSoFar(ctrl)).toEqual(['Z'])
    expect(ctrl.status().machinePos!.z).toBe(0)
    expect(ctrl.status().machinePos!.x).toBe(start.x)

    await vi.advanceTimersByTimeAsync(1000)
    expect(events.homed).toEqual([['Z', 'X', 'Y']])
    expect(ctrl.homedThisSession()).toBe(true)
    expect(ctrl.status().machinePos).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('the whole cycle still takes the time it always took - sequencing is not a slowdown', async () => {
    const { ctrl } = await connectedSim()
    expect(ctrl.homeAxes!(['Z', 'X', 'Y'])).toBe(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(ctrl.homedThisSession()).toBe(true)
  })

  it('home() - the orderless whole-machine cycle - runs the ONE fallback, Z first', async () => {
    // It used to be its own literal, ['X','Y','Z'], which is Z LAST.
    const { ctrl, events } = await connectedSim()
    expect(ctrl.home()).toBe(true)
    await vi.advanceTimersByTimeAsync(1600)
    expect(events.homed).toEqual([[...DEFAULT_HOMING_ORDER]])
    expect(events.homed[0]![0]).toBe('Z')
  })

  it('refuses an axis it does not model rather than quietly homing a different list', async () => {
    const { ctrl } = await connectedSim()
    // A 4-axis definition. The simulator is a 3-axis machine; dropping A and
    // homing the rest would be substituting an order nobody asked for.
    expect(ctrl.homeAxes!(['Z', 'X', 'Y', 'A'])).toBe(false)
    expect(ctrl.machineState()).not.toBe('home')
    expect(ctrl.homedThisSession()).toBe(false)
  })

  it('refuses an order that lists the same axis twice', async () => {
    const { ctrl } = await connectedSim()
    expect(ctrl.homeAxes!(['Z', 'Z', 'X'])).toBe(false)
    expect(ctrl.machineState()).not.toBe('home')
  })

  it('NO GATE MAY BLOCK A STOP: an E-STOP mid-cycle abandons homing instead of finishing it', async () => {
    const { ctrl, events } = await connectedSim()
    expect(ctrl.homeAxes!(['Z', 'X', 'Y'])).toBe(true)
    await vi.advanceTimersByTimeAsync(520)
    expect(homedSoFar(ctrl)).toEqual(['Z'])

    ctrl.emergencyStop()
    expect(ctrl.machineState()).toBe('alarm')

    // Long past when the cycle would have finished. It must NOT have finished,
    // and it must not have put the machine back in 'idle' behind the latch.
    await vi.advanceTimersByTimeAsync(3000)
    expect(ctrl.machineState()).toBe('alarm')
    expect(ctrl.homedThisSession()).toBe(false)
    expect(homedSoFar(ctrl)).toEqual(['Z'])
    expect(events.homed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. HOME ALL PASSES THE MACHINE'S ORDER
// ---------------------------------------------------------------------------

describe('WO-914 Home All passes the profile order', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineJogContinuous: false, machineJogStepMm: 10, machineJogFeedMmMin: 1000 })
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await disconnectMachine()
  })

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

  async function connectWithOrder(order: AxisName[] | null): Promise<void> {
    setOrder(order)
    await connectMachine('simulator')
    // Operator 2026-09-14 ("A: Flash, all motion off"): this section is about
    // which homing order Home All sends, not the fresh-connect E-STOP latch.
    __resetEstopInterlockForTest()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
  }

  it('THE HEADLINE, THROUGH THE BUTTON: Home All sends the profile order Y, X, Z', async () => {
    await connectWithOrder(['Y', 'X', 'Z'])
    const homeAxes = vi.spyOn(getMachineController() as Required<MachineController>, 'homeAxes').mockReturnValue(true)
    const home = vi.spyOn(getMachineController(), 'home').mockReturnValue(true)
    render(<JogPanel />)

    fireEvent.click(screen.getByTestId('control-home'))

    expect(homeAxes).toHaveBeenCalledWith(['Y', 'X', 'Z'])
    // Never both, and never the orderless form when an order is available.
    expect(home).not.toHaveBeenCalled()
  })

  it('THE NEGATIVE CONTROL, THROUGH THE BUTTON: no definition sends the Z-first fallback', async () => {
    await connectWithOrder(null)
    const homeAxes = vi.spyOn(getMachineController() as Required<MachineController>, 'homeAxes').mockReturnValue(true)
    render(<JogPanel />)

    fireEvent.click(screen.getByTestId('control-home'))

    expect(homeAxes).toHaveBeenCalledWith(['Z', 'X', 'Y'])
    expect(homeAxes.mock.calls[0][0][0]).toBe('Z')
  })

  it('the button says which order it will run, so the operator reads it before pressing', async () => {
    await connectWithOrder(['Y', 'X', 'Z'])
    render(<JogPanel />)
    expect(screen.getByTestId('control-home').getAttribute('data-tooltip')).toContain('Y, X, Z')
  })
})

// ---------------------------------------------------------------------------
// 5. THE WIRE - THE ORDER TRAVELS VERBATIM, AND `home` STAYS ORDERLESS
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

async function connectedBridge() {
  const transport = new FakeTransport()
  const controller = new UccncController({})
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.2',
      capabilities: {
        geometryQueue: true, executingMoveId: true, bufferSeconds: true,
        gcodeText: false, perAxisHoming: true,
        ownsSpindle: true, spindleCommands: false,
      },
      readOnly: false,
    },
  })
  await connecting
  return { controller, transport }
}

describe('WO-914 the order on the wire', () => {
  it('homeAxes carries the machine definition order VERBATIM - no reorder, no filter', async () => {
    const { controller, transport } = await connectedBridge()
    const def = createDefaultControllerDefinition(['X', 'Y', 'Z', 'A'])
    def.homing.order = ['Y', 'Z', 'A', 'X']
    expect(controller.homeAxes(resolveHomingOrder(def))).toBe(true)
    expect(transport.lastCall('homeAxes').a).toEqual({ axes: ['Y', 'Z', 'A', 'X'] })
  })

  it('home() stays the ORDERLESS call and does not rewrite itself into a default', () => {
    // The bridge refuses an orderless home and says what to send instead. If
    // this backend quietly translated it into homeAxes(Z,X,Y), that refusal -
    // the whole mechanism keeping the two sides from disagreeing - would be
    // unreachable, and a second default would be back, just hidden. The
    // fallback belongs where the machine definition is: JogPanel's Home All.
    return connectedBridge().then(({ controller, transport }) => {
      expect(controller.home()).toBe(true)
      expect(transport.lastCall('home').a).toEqual({})
      expect(transport.sent.some((c) => c.m === 'homeAxes')).toBe(false)
    })
  })
})
