// @vitest-environment jsdom
//
// WO-928 - APPLY SENDS THE DEFINITION THE MACHINE ACTUALLY USES.
//
// Two defects from the WO-925 adversarial audit, one lane, because they are
// the same trip:
//
//   F16  `applyMachineDefinition` was implemented on the controller and on the
//        bridge, rc-checked with a 23-field readback, and NOTHING in `src/`
//        called it. There was no Apply.
//
//   F17  THE DANGEROUS ONE. `project.machine` is a SEPARATE COPY of the
//        machine-library entry, and `project.machine.controllerDefinition` is
//        what `JogPanel` reads when it homes. `commitDraft` wrote only the
//        library. So Save-then-Apply could send the board one definition while
//        the app homed against another - and NOTHING warned, because the
//        readback PASSES: the board holds exactly what Apply sent. Silent,
//        self-consistent, wrong.
//
// THE HEADLINE HERE IS THE F17 PROOF, and it is deliberately an IDENTITY
// assertion, not a "something was sent" assertion:
//
//        the object on the wire  ===  project.machine.controllerDefinition
//
// which is the exact expression `JogPanel.tsx:127` reads for the homing order.
// A test that only checked Apply sent *something* would miss the entire
// defect, so every send assertion below also names where homing reads.
//
// Three things in here are requirements, not style, and must not be tidied:
//
//   1. NO OPTIMISTIC STATE. Nothing may say the definition landed before the
//      controller answers. Proven with a bridge that is held mid-call.
//   2. THE CONTROLLER'S REPORT IS VERBATIM. A 23-field mismatch is the whole
//      point of the readback; it is never collapsed into "failed".
//   3. Q3 IS CLOSED BY OPERATOR AND PERMANENT. Nothing may claim a live PIN change
//      takes effect. The apply may say a pin was STORED, and if it says
//      anything more it says: jog the axis and watch which one moves.
//
// No bridge process and no hardware are involved - the protocol IS the
// contract (WO-421), so this drives the real UccncController over a fake
// message channel, the same posture as WO-448 and WO-915.
//
// WO-942 REPIN (2026-08-24): Operator's ruling ("only Control can apply it to the
// machine") moved the ONE Apply control from MachineLibraryModal to
// MachineDefinitionPanel (WO-941). Every test here now mounts the panel
// instead of the modal and presses `machine-def-bar-apply` instead of
// `machine-def-apply`. The panel's sections are laid out FLAT on a page -
// there is no disclosure to expand first, so the old `expand(...)` calls are
// gone. The contract this suite defends (F16, F17, the refusals, no
// optimistic state, the verbatim report, the pin hedge, no gate on a stop) is
// UNCHANGED - `applyActiveMachineDefinition` is the same function, moved
// whole (MachineDefinitionPanel.tsx:504-508).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { MachineConfig, ControllerDefinition } from '../../types'
import type {
  BridgeApplyDefinitionReply,
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

// The real BridgeTransport declares private instance fields (url, socket,
// closed, vfdPortLink, handleClose), so no class outside its own declaration
// can satisfy `typeof BridgeTransport` structurally - the fake must EXTEND it
// (see hardwareEstop.test.tsx). Extending happens inside the vi.mock factory,
// where the real class is reachable via importOriginal, so the shared "last
// fake instance" handle is a vi.hoisted() object rather than a static on a
// module-scope class.
interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  applyCalls(): BridgeCallMessage[]
  reply(seq: number, value: BridgeApplyDefinitionReply): void
  emit(message: BridgeMessage): void
}
const fakeBridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). In-memory shim BEFORE the store import
// (same scaffolding as the other modal suites). No app change.
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

/** The AXBB-E's real answer (same fixture as WO-422/WO-448). */
const CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const CLEAN_REPLY: BridgeApplyDefinitionReply = {
  ok: true,
  error: null,
  configuredThisSession: true,
  reHome: [],
  lines: [
    { text: 'Machine definition: 23 of 23 settings written and read back.', severity: 'info' },
  ],
}

/** What a PARTIAL apply looks like: the bridge names every field that did not
 *  read back. This is the text that must survive to the operator intact. */
const MISMATCH_REPLY: BridgeApplyDefinitionReply = {
  ok: false,
  error: '3 of 23 settings did not read back as written.',
  configuredThisSession: false,
  reHome: ['X', 'Z'],
  lines: [
    { text: 'X Stepsperunit: wrote 640, read back 400.', severity: 'error' },
    { text: 'Z Softlimitnegative: wrote -95, read back 0.', severity: 'error' },
    { text: 'Z Homebackoff: wrote 3, read back 0.', severity: 'error' },
    { text: 'The controller kept its previous values for the three above.', severity: 'warn' },
  ],
}

let applyReplyMode: 'auto' | 'hold' = 'auto'
let nextApplyReply: BridgeApplyDefinitionReply = CLEAN_REPLY
let heldApplySeq: number | null = null
let nextReadOnly = false

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  // Stands in for bridgeTransport's WebSocket. Sends hello the moment the
  // controller attaches, exactly as the real bridge does, then records every
  // call. Only `applyMachineDefinition` is answered - the controller's own
  // housekeeping calls are recorded and ignored, as in WO-448's fake.
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() { super(); fakeBridge.last = this }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'fake-bridge 0.0',
          capabilities: CAPS,
          readOnly: nextReadOnly,
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m !== 'applyMachineDefinition') return
      if (applyReplyMode === 'hold') { heldApplySeq = message.seq; return }
      this.reply(message.seq, nextApplyReply)
    }

    async close(): Promise<void> { this.fakeEvents?.onClose('closed') }

    emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }

    reply(seq: number, value: BridgeApplyDefinitionReply): void {
      this.emit({ t: 'reply', seq, ok: true, v: value })
    }

    applyCalls(): BridgeCallMessage[] {
      return this.sent.filter((c) => c.m === 'applyMachineDefinition')
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { resolveHomingOrder } = await import('../../lib/machine/controller')
const { createDefaultControllerDefinition } = await import('../../types')

const state = () => useCamStore.getState()

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

function shopRouter(): MachineConfig {
  const definition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
  definition.homing.perAxis.Z!.backOff = 2
  return {
    id: 'wo928', name: 'Shop Router', type: 'gantry_router', controller: 'uccnc',
    travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: definition,
  }
}

/** THE SHAPE OF THE DEFECT, set up faithfully: the library entry and
 *  `project.machine` start as two SEPARATE deep copies of the same values.
 *  This is exactly what `MachineChoiceModal` produces (`{ ...chosen }`) and
 *  what a loaded project file holds. If Save only wrote the library, these two
 *  would drift the moment anything was edited. */
function seedLibraryAndProject(machine: MachineConfig = shopRouter()): void {
  const projectCopy: MachineConfig = JSON.parse(JSON.stringify(machine))
  act(() => {
    useCamStore.setState({ machineLibrary: [machine], consoleEvents: [] } as never)
    state().setProjectMachine(projectCopy)
    state().closeModal()
  })
}

/** The panel is a page, not a modal - it mounts once and every section is
 *  already open, so there is no `expand(...)` step before a field is
 *  reachable (WO-939: "a page has room for all six"). */
function mountPanel() {
  return render(<MachineDefinitionPanel />)
}

// WO-1690: the axis table (use/steps/speed/accel/travel/homing/slave/pins)
// moved off the three Legacy groups onto the outer "Machine" area tab - tried
// first, since that is where those controls live now. A label starting with
// an axis letter beyond that may be behind that axis's own "Pins and more"
// drawer (enable delay, backlash, every pin, and every homing field but
// direction/fast speed).
const AXIS_LETTERS = ['X', 'Y', 'Z', 'A', 'B', 'C']
const reveal = (label: string): HTMLElement => {
  const here = screen.queryByLabelText(label)
  if (here) return here
  const machineTab = screen.queryByTestId('machine-def-tab-machine')
  if (machineTab) act(() => { fireEvent.click(machineTab) })
  const onMachineArea = screen.queryByLabelText(label)
  if (onMachineArea) return onMachineArea
  const axis = label.split(' ')[0]
  if (AXIS_LETTERS.includes(axis)) {
    const chip = screen.queryByTestId(`machine-def-panel-axis-pins-more-${axis}`)
    if (chip) act(() => { fireEvent.click(chip) })
    const inDrawer = screen.queryByLabelText(label)
    if (inDrawer) return inDrawer
  }
  const controllerTab = screen.queryByTestId('machine-def-tab-controller')
  if (controllerTab) act(() => { fireEvent.click(controllerTab) })
  const onControllerArea = screen.queryByLabelText(label)
  if (onControllerArea) return onControllerArea
  throw new Error(`no group on the definition page carries a control labelled "${label}"`)
}

/** NumericInput keeps a local edit draft and commits on blur/Enter. */
const setNumber = (label: string, value: number) => {
  const field = reveal(label)
  act(() => { fireEvent.change(field, { target: { value: String(value) } }) })
  act(() => { fireEvent.blur(field) })
}

const save = () => { act(() => { fireEvent.click(screen.getByTestId('machine-def-panel-save')) }) }

const applyButton = () => screen.getByTestId('machine-def-bar-apply')

const pressApply = async () => {
  // Resolved BEFORE act() - same reason `reveal` above is: a nested act()
  // does not flush the tab switch `applyButton` can require until the outer
  // one closes.
  const button = applyButton()
  await act(async () => { fireEvent.click(button) })
}

async function connectBridge(): Promise<void> {
  await act(async () => { await session.connectMachine('bridge') })
  expect(useMachineControl.getState().connectionPhase).toBe('connected')
}

/** The definition the app itself homes with - JogPanel.tsx:127's expression,
 *  written out here rather than imported so this file states the claim in the
 *  same words the homing path does. */
const definitionTheAppHomesWith = (): ControllerDefinition | null =>
  session.activeMachineDefinition()

/** The definition object that actually reached the wire. FakeBridgeTransport
 *  records the frame OBJECT, so this is the very reference the app handed
 *  over - which is what makes the identity assertions below meaningful. */
const definitionOnTheWire = (): ControllerDefinition => {
  const calls = fakeBridge.last?.applyCalls() ?? []
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1].a.definition as ControllerDefinition
}

const machineConsoleText = (): string =>
  state().consoleEvents.filter((e) => e.source === 'machine').map((e) => e.message).join('\n')

beforeEach(() => {
  applyReplyMode = 'auto'
  nextApplyReply = CLEAN_REPLY
  heldApplySeq = null
  nextReadOnly = false
  fakeBridge.last = null
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await act(async () => { await session.disconnectMachine() })
  }
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. THE HEADLINE: F17. Save, Apply, and the two are the SAME definition.
// ---------------------------------------------------------------------------

describe('WO-928 F17 - what Apply sends IS what the app homes with', () => {
  it('THE PROOF: edit a value, Save, Apply - the definition on the wire becomes '
    + 'the receipt-confirmed values the homing path reads', async () => {
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()

    // 1. Edit. Z back-off 2 -> 10, through the real form.
    setNumber('Z homing back off', 10)

    // 2. Save. BEFORE WO-928 this wrote the library ONLY, and the assertion
    //    below is the one that failed: the app kept homing with backOff 2.
    save()
    expect(state().machineLibrary[0].controllerDefinition!.homing.perAxis.Z!.backOff).toBe(10)
    // WO-1147: Save is future intent. Runtime stays on the connection-start
    // value until the matching successful readback below.
    expect(definitionTheAppHomesWith()!.homing.perAxis.Z!.backOff).toBe(2)

    // 3. Apply.
    await pressApply()

    // 4. THE ASSERTION THAT MATTERS. Not "something was sent" - the matched
    //    readback promoted the sent values into the runtime homing model.
    const sent = definitionOnTheWire()
    expect(sent).toEqual(definitionTheAppHomesWith())
    expect(sent.homing.perAxis.Z!.backOff).toBe(10)
    expect(sent).toEqual(definitionTheAppHomesWith())

    // 5. And the homing ORDER the app would run comes off that same object,
    //    so there is no third definition anywhere in the loop.
    expect(resolveHomingOrder(sent))
      .toEqual(resolveHomingOrder(definitionTheAppHomesWith()))
  })

  it('the saved intent, confirmed runtime and wire agree after a successful receipt', async () => {
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()

    setNumber('X homing back off', 7)
    save()
    await pressApply()

    const inLibrary = state().machineLibrary[0].controllerDefinition!
    const homedWith = definitionTheAppHomesWith()!
    expect(homedWith).toEqual(inLibrary)
    expect(homedWith).not.toBe(inLibrary)
    expect(definitionOnTheWire()).toBe(inLibrary)
    expect(inLibrary.homing.perAxis.X!.backOff).toBe(7)
  })

  it('an edit that is applied WITHOUT pressing Save first still cannot split '
    + 'the two: Apply commits, then reads where homing reads', async () => {
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()

    setNumber('Z homing back off', 4.5)
    // No save() - straight to Apply.
    await pressApply()

    expect(definitionOnTheWire()).toEqual(definitionTheAppHomesWith())
    expect(definitionTheAppHomesWith()!.homing.perAxis.Z!.backOff).toBe(4.5)
  })

  it('a project whose machine copy was ALREADY stale before the modal opened '
    + 'is reconciled by Apply, not shipped as-is', async () => {
    // The pre-WO-928 world leaves project files in exactly this state: the
    // library entry carries an edit the project copy never received.
    const library = shopRouter()
    library.controllerDefinition!.homing.perAxis.Z!.backOff = 12
    const stale: MachineConfig = JSON.parse(JSON.stringify(library))
    stale.controllerDefinition!.homing.perAxis.Z!.backOff = 2
    act(() => {
      useCamStore.setState({ machineLibrary: [library], consoleEvents: [] } as never)
      state().setProjectMachine(stale)
      state().closeModal()
    })
    expect(definitionTheAppHomesWith()!.homing.perAxis.Z!.backOff).toBe(2)

    await connectBridge()
    mountPanel()
    await pressApply()

    // What is on screen, what the app homes with and what went on the wire are
    // one set of values - the modal never sends a definition it is not showing.
    expect(definitionOnTheWire()).toEqual(definitionTheAppHomesWith())
    expect(definitionOnTheWire().homing.perAxis.Z!.backOff).toBe(12)
  })
})

// ---------------------------------------------------------------------------
// 2. REFUSE HONESTLY where the two CANNOT be reconciled
// ---------------------------------------------------------------------------

describe('WO-928 - the refusals name what is wrong and send nothing', () => {
  // WO-942 REPIN: this test used to click a machine-library ROW inside the
  // modal to point the draft at a machine other than the project's active
  // one, then proved Apply refused rather than configuring the board from a
  // definition the app would not home with. MachineDefinitionPanel has no
  // such row - it has no machine-switcher at all (WO-941/WO-939: "THE RECORD
  // BEING EDITED is the ACTIVE machine", MachineDefinitionPanel.tsx:278-285).
  // `draft` is derived from `project.machine.id` every render, so `draft.id
  // !== active.id` cannot occur through any control this panel offers - the
  // F17 risk this refusal existed to catch is now prevented STRUCTURALLY
  // rather than caught at Apply time. The runtime guard in `handleApply`
  // (MachineDefinitionPanel.tsx:531-540) stays as defense in depth and is
  // documented there as unreachable; this test proves the structural half -
  // that there is no UI path back into reachability - which is the property
  // that actually stands between an operator and F17 now.
  it('the panel has no control that can point it at a machine other than the '
    + 'project\'s active one - the F17 risk this refusal existed for has no way back in',
  async () => {
    const active = shopRouter()
    const other: MachineConfig = { ...JSON.parse(JSON.stringify(active)), id: 'other', name: 'Spare Mill' }
    act(() => {
      useCamStore.setState({ machineLibrary: [active, other], consoleEvents: [] } as never)
      state().setProjectMachine(JSON.parse(JSON.stringify(active)))
      state().closeModal()
    })
    await connectBridge()
    mountPanel()

    // The panel names one machine - the active one - and offers no row, list
    // or picker naming the other library entry. WO-1713 removed the header's
    // repeated name badge; `data-machine-id` is the same identity fact.
    expect(screen.getByTestId('machine-definition-panel').getAttribute('data-machine-id')).toBe(active.id)
    expect(screen.queryByText('Spare Mill')).toBeNull()

    // So every Apply this panel can ever fire targets the shown machine,
    // which IS the active one - the refusal is never reached because the
    // mismatch it guarded against cannot be constructed.
    await pressApply()
    expect(fakeBridge.last!.applyCalls()).toHaveLength(1)
    const sent = definitionOnTheWire()
    expect(sent).toEqual(definitionTheAppHomesWith())
    expect(applyButton().getAttribute('data-apply-state')).toBe('applied')
  })

  it('refuses with nothing on the wire when the machine is not connected', async () => {
    seedLibraryAndProject()
    mountPanel()
    await pressApply()

    expect(fakeBridge.last).toBeNull()
    expect(machineConsoleText()).toContain('the machine is not connected')
  })

  it('refuses on a backend that cannot write settings, and says so plainly', async () => {
    seedLibraryAndProject()
    await act(async () => { await session.connectMachine('simulator') })
    mountPanel()
    await pressApply()

    expect(machineConsoleText()).toContain('cannot write settings to a controller')
  })

  it('a READ-ONLY bridge refusal reaches the operator as the bridge\'s own '
    + 'sentence, not as a generic failure', async () => {
    nextReadOnly = true
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()
    await pressApply()

    expect(fakeBridge.last!.applyCalls()).toHaveLength(0)
    expect(machineConsoleText()).toContain('read only')
  })

  it('a machine with no definition offers no Apply at all - there is nothing '
    + 'to send, and a button that sends nothing is worse than none', () => {
    const bare = shopRouter()
    delete bare.controllerDefinition
    seedLibraryAndProject(bare)
    mountPanel()

    expect(screen.queryByTestId('machine-def-bar-apply')).toBeNull()
    expect(screen.getByTestId('machine-def-panel-define')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 3. NO OPTIMISTIC STATE - nothing claims success before the reply
// ---------------------------------------------------------------------------

describe('WO-928 - the UI never runs ahead of the controller', () => {
  it('while the apply is in flight the control says it is APPLYING and nothing '
    + 'anywhere says it landed', async () => {
    applyReplyMode = 'hold'
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()

    await pressApply()

    // The call is out and the reply has NOT come back.
    expect(fakeBridge.last!.applyCalls()).toHaveLength(1)
    expect(heldApplySeq).not.toBeNull()
    expect(applyButton().getAttribute('data-apply-state')).toBe('applying')
    expect(applyButton().textContent).toContain('Applying')
    expect(applyButton().textContent).not.toContain('Applied')
    expect(machineConsoleText()).not.toContain('Machine definition applied')

    // Now the controller answers, and only now is anything claimed.
    await act(async () => {
      fakeBridge.last!.reply(heldApplySeq!, CLEAN_REPLY)
    })
    await waitFor(() => {
      expect(applyButton().getAttribute('data-apply-state')).toBe('applied')
    })
    expect(machineConsoleText()).toContain('Machine definition applied')
  })

  it('a stale "Applied" cannot stand over a definition the board has not seen: '
    + 'editing after a clean apply returns the control to neutral', async () => {
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()
    await pressApply()
    expect(applyButton().getAttribute('data-apply-state')).toBe('applied')

    setNumber('Z homing back off', 9)

    expect(applyButton().getAttribute('data-apply-state')).toBe('idle')
    expect(applyButton().textContent).toContain('Apply to Machine')
  })
})

// ---------------------------------------------------------------------------
// 4. THE CONTROLLER'S REPORT, VERBATIM
// ---------------------------------------------------------------------------

describe('WO-928 - a 23-field mismatch report is never collapsed into "failed"', () => {
  it('every line of a partial apply reaches the operator word for word', async () => {
    nextApplyReply = MISMATCH_REPLY
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()
    setNumber('Z homing back off', 19)
    await pressApply()

    const text = machineConsoleText()
    expect(text).toContain('3 of 23 settings did not read back as written.')
    for (const line of MISMATCH_REPLY.lines) expect(text).toContain(line.text)
    expect(applyButton().getAttribute('data-apply-state')).toBe('failed')
    expect(session.activeMachineDefinition()!.homing.perAxis.Z!.backOff).toBe(2)
    expect(state().machineLibrary[0].controllerDefinition!.homing.perAxis.Z!.backOff).toBe(19)
  })

  it('SAFETY: an apply that names axes to re-home drops "homed" in the store - '
    + 'the position counter no longer means what it did', async () => {
    nextApplyReply = MISMATCH_REPLY
    seedLibraryAndProject()
    await connectBridge()
    act(() => { useMachineControl.setState({ homed: true }) })
    mountPanel()
    await pressApply()

    expect(useMachineControl.getState().homed).toBe(false)
    expect(machineConsoleText()).toContain('Re-home X, Z before moving')
  })

  it('a clean apply reports the controller accepting AND reading back', async () => {
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()
    await pressApply()

    expect(machineConsoleText()).toContain('accepted and read back every value')
    expect(machineConsoleText()).toContain('23 of 23 settings written and read back')
  })
})

// ---------------------------------------------------------------------------
// 5. Q3 IS CLOSED BY OPERATOR AND PERMANENT
// ---------------------------------------------------------------------------

describe('WO-928 - nothing claims a live PIN change takes effect', () => {
  it('a successful apply says a pin was STORED and sends the operator to the '
    + 'only proof there is: jog the axis and watch which one moves', async () => {
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()
    await pressApply()

    const text = machineConsoleText()
    expect(text).toContain('STORED')
    expect(text).toContain('not demonstrated')
    expect(text).toContain('jog that axis and watch which axis moves')
  })

  it('the hedge is a fixed sentence, not prose a later reader can drift', () => {
    // Operator ruled Q3 closed - "not worth the risk - ship it as is". The wording
    // lives in ONE exported constant so a rewrite of it is a visible diff here.
    expect(session.APPLY_PIN_HEDGE).toContain('STORED')
    expect(session.APPLY_PIN_HEDGE).toContain('not demonstrated')
    expect(session.APPLY_PIN_HEDGE.toLowerCase()).not.toContain('takes effect')
    expect(session.APPLY_PIN_HEDGE.toLowerCase()).not.toContain('now in use')
  })
})

// ---------------------------------------------------------------------------
// 6. NO GATE MAY EVER BLOCK A STOP
// ---------------------------------------------------------------------------

describe('WO-928 - the apply sits between the operator and nothing', () => {
  it('an E-STOP pressed while an apply is in flight reaches the controller '
    + 'immediately - it does not queue behind the reply', async () => {
    applyReplyMode = 'hold'
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()
    await pressApply()
    expect(heldApplySeq).not.toBeNull()

    act(() => { session.triggerEmergencyStop() })

    const frames = fakeBridge.last!.sent.map((c) => c.m)
    expect(frames).toContain('emergencyStop')
    // And it went out WHILE the apply was still unanswered.
    expect(frames.indexOf('emergencyStop'))
      .toBeGreaterThan(frames.indexOf('applyMachineDefinition'))

    await act(async () => {
      fakeBridge.last!.reply(heldApplySeq!, CLEAN_REPLY)
    })
  })

  // WO-942 REPIN: "dismiss the modal" has no counterpart on a page - there is
  // nothing to dismiss. The property this test actually proved was "nothing
  // here traps the operator behind a pending reply" (MachineDefinitionPanel.tsx
  // :17-18: "this page can be navigated away from while it is in flight").
  // The page-form of leaving is navigating away, i.e. unmounting the panel -
  // Control switches sub-tabs (WO-917) or views without waiting on this
  // promise. The `mountedRef` guard the panel keeps for exactly this (see
  // MachineDefinitionPanel.tsx:311-320) is what this now proves.
  it('the page can be navigated away from while an apply is in flight - nothing '
    + 'traps the operator behind a pending reply', async () => {
    applyReplyMode = 'hold'
    seedLibraryAndProject()
    await connectBridge()
    const { unmount } = mountPanel()
    await pressApply()
    expect(heldApplySeq).not.toBeNull()

    unmount()

    // The late reply still lands somewhere honest rather than throwing -
    // the guarded setState after unmount is exactly what mountedRef exists
    // to make safe.
    await act(async () => {
      fakeBridge.last!.reply(heldApplySeq!, CLEAN_REPLY)
    })
    expect(machineConsoleText()).toContain('Machine definition applied')
  })
})

describe('WO-1147 - only a current matched receipt may change runtime authority', () => {
  it('keeps the connection-start definition live when Apply times out', async () => {
    applyReplyMode = 'hold'
    seedLibraryAndProject()
    await connectBridge()
    const runtimeBefore = structuredClone(session.activeMachineDefinition()!)
    const saved = structuredClone(state().machineLibrary[0].controllerDefinition!)
    saved.homing.perAxis.Z!.backOff = 14

    vi.useFakeTimers()
    const pending = session.applyConnectedMachineDefinition(saved, {}, 'wo928')
    expect(heldApplySeq).not.toBeNull()
    await vi.advanceTimersByTimeAsync(30_100)
    const outcome = await pending

    expect(outcome.ok).toBe(false)
    expect(outcome.result?.error).toMatch(/did not answer.*in time/i)
    expect(session.activeMachineDefinition()).toEqual(runtimeBefore)
    expect(state().control.appliedMachine).toBeNull()
  })

  it('ignores a successful old-backend receipt after the backend is replaced', async () => {
    applyReplyMode = 'hold'
    seedLibraryAndProject()
    await connectBridge()
    const runtimeBefore = structuredClone(session.activeMachineDefinition()!)
    const saved = structuredClone(state().machineLibrary[0].controllerDefinition!)
    saved.homing.perAxis.Z!.backOff = 16

    const pending = session.applyConnectedMachineDefinition(saved, {}, 'wo928')
    expect(heldApplySeq).not.toBeNull()
    await session.connectMachine('simulator')
    fakeBridge.last!.reply(heldApplySeq!, CLEAN_REPLY)
    const outcome = await pending

    expect(outcome.ok).toBe(false)
    expect(outcome.authorityRefusal).toMatch(/replaced backend\/session/i)
    expect(session.activeMachineDefinition()).toEqual(runtimeBefore)
    expect(state().control.appliedMachine).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. F16 - the wire itself
// ---------------------------------------------------------------------------

describe('WO-928 F16 - applyMachineDefinition is reachable from src/ at last', () => {
  it('the definition crosses the wire VERBATIM - the app translates no pin', async () => {
    seedLibraryAndProject()
    await connectBridge()
    mountPanel()
    const estopPort = reveal('E-stop port')
    act(() => { fireEvent.change(estopPort, { target: { value: '2' } }) })
    const estopPin = reveal('E-stop pin')
    act(() => { fireEvent.change(estopPin, { target: { value: '9' } }) })
    save()
    await pressApply()

    const sent = definitionOnTheWire()
    // (port, pin) as typed. Every pin on the wire is still the three-field
    // shape a person reads off a wiring diagram - never a single board pin
    // number, because the bridge owns the only copy of that translation
    // (WO-912, whose own guard test forbids even naming it in src/).
    // (port, pin) as typed, AND THE POLARITY AS UNKNOWN AS IT WAS TYPED -
    // which is to say not at all (WO-995). Nobody touched the negate box, so
    // `null` is what the record holds and `null` is what crosses, VERBATIM.
    // Coercing it to `false` here would be this app translating a pin, which
    // is the one thing this test exists to forbid; the bridge already applies
    // its own default at the moment it calls the board (`Json.Bool(p,
    // "negate", false)`, Machine.cs:1140), and that is where the default
    // belongs - in the one place that owns the board.
    expect(sent.io.estop).toEqual({ port: 2, pin: 9, negate: null })
    expect('negate' in (sent.io.estop as object)).toBe(true)
    for (const axis of sent.axes) {
      expect(Object.keys(axis.stepPin).sort()).toEqual(['negate', 'pin', 'port'])
      expect(Object.keys(axis.homePin).sort()).toEqual(['negate', 'pin', 'port'])
    }
  })

  it('the session helper reads exactly where JogPanel reads', () => {
    seedLibraryAndProject()
    expect(session.activeMachineDefinition())
      .toBe(useCamStore.getState().project.machine!.controllerDefinition)
  })
})
