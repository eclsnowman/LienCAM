// @vitest-environment jsdom
//
// WO-1000 -- the COM port picker (MACHINE-SETTINGS-DESIGN.md slice S5).
//
// This is the design's section 3.2 gates written as TESTS rather than prose,
// plus the acceptance the work order names. Everything below runs against a
// FAKED BRIDGE speaking the agreed contract over a fake WebSocket, driving the
// real BridgeTransport and the real Controller Setup group -- no mocked internals.
//
//   listSerialPorts -> { ports: string[] }
//   setVfdPort { port }
//   `port` on the `vfd` push
//
// Gate 4 (the app remembers the chosen port and re-sends it on every connect)
// is proved here for BOTH halves: a bridge restart with LienCAM still open, and
// a LienCAM RELOAD - the durable, machine-scoped half the attempt-1 audit found
// missing. The store it is proved against is the real one: `machineLinks` in
// `src/store/uiPrefs.ts`, written through zustand persist into a real (in
// memory) Storage and read back with `persist.rehydrate()`, exactly as
// WO-997's own test does.
//
// WHAT THIS FILE DOES NOT PROVE, and cannot:
// the bridge's Close/Open cycle on a live VfdLink. That is unverified item 6 of
// the design and it is a HARDWARE acceptance -- a green run here says the
// browser half is right, and says nothing whatsoever about whether a real
// spindle link survives being moved. See the work order's result section.
//
// The file is .ts, not .tsx (owned-paths), so the render tests build their
// elements with createElement instead of JSX. Nothing else about them differs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { createElement, type ComponentType } from 'react'

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the cam store writes through persist() on every set, so a minimal in-memory
// Storage goes in BEFORE the store module is imported. Pure test scaffolding,
// copied from settingsThemeRemoval.wo270.test.tsx.
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

const {
  BridgeTransport,
  BRIDGE_LIST_SERIAL_PORTS,
  BRIDGE_SET_VFD_PORT,
  VFD_PORT_REFUSAL,
  vfdPortLinkState,
  activeVfdPortLink,
  VfdPortLink,
  bridgeUrl,
} = await import('../../lib/machine/bridgeTransport')
type BridgeVfdPush = import('../../lib/machine/bridgeTransport').BridgeVfdPush
type BridgeSerialPortsValue = import('../../lib/machine/bridgeTransport').BridgeSerialPortsValue

const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
type MachineDefinitionPanelProps = import('../../components/machine/MachineDefinitionPanel').MachineDefinitionPanelProps
const ControllerSetupPanel = MachineDefinitionPanel as ComponentType<MachineDefinitionPanelProps>
const { useCamStore } = await import('../../store')
// Importing the store is also what INSTALLS the durable gate-4 memory into the
// transport (uiPrefs.ts calls `installVfdPortMemory` at module scope), which is
// the same thing that happens in the app - machineSession imports uiPrefs to
// resolve the bridge URL before it can construct a transport at all.
const {
  INVALID_VFD_PORT_MESSAGE,
  UI_PREFS_STORAGE_KEY,
  UI_PREFS_VERSION,
  machineBridgePort,
  machineVfdPort,
  useUiPrefs,
} = await import('../../store/uiPrefs')

/** Two machine profiles on one computer. Gate 4's record is keyed by profile
 *  id (WO-997), so these must never see each other's spindle port. */
const MACHINE_A = 'axbb-router'
const MACHINE_B = 'second-router'

// ---- the fake socket (same shape as bridgeTransport.test.ts's) ------------

class FakeSocket {
  static last: FakeSocket | null = null
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((e: { reason: string }) => void) | null = null
  readonly url: string
  constructor(url: string) { this.url = url; FakeSocket.last = this }
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
}

interface SentCall { seq: number; m: string; a: Record<string, unknown> }

/** A bridge that implements the agreed contract, and nothing more. Every frame
 *  it sends is JSON on the wire, exactly as a real one would be. */
class FakeBridge {
  private readonly socket: FakeSocket
  constructor(socket: FakeSocket) { this.socket = socket }

  calls(method?: string): SentCall[] {
    return this.socket.sent
      .map((s) => JSON.parse(s) as SentCall)
      .filter((c) => method === undefined || c.m === method)
  }

  lastCall(method: string): SentCall {
    const all = this.calls(method)
    expect(all.length, `no ${method} call was sent`).toBeGreaterThan(0)
    return all[all.length - 1]
  }

  private frame(value: unknown): void {
    this.socket.onmessage?.({ data: JSON.stringify(value) })
  }

  hello(options: { vfdPresent: boolean }): void {
    this.frame({
      t: 'hello',
      v: {
        protocol: 1,
        bridge: 'fake-bridge/WO-1000',
        capabilities: {},
        readOnly: false,
        vfd: options.vfdPresent
          ? { present: true, verified: true, name: 'huanyang-gt' }
          : { present: false, verified: false, name: null },
      },
    })
  }

  /** A `vfd` push. `port` is spread in only when the caller supplies the key,
   *  so an "old bridge" push really does omit it. */
  vfd(overrides: Partial<BridgeVfdPush['v']>): void {
    this.frame({
      t: 'vfd',
      v: {
        up: true,
        running: false,
        faulted: false,
        runStateWord: 0,
        commandWord: 0,
        setpointWord: 0,
        consecutiveFailures: 0,
        lastStopReason: 'none',
        lastError: null,
        statusWords: [],
        status: {},
        upToSpeed: null,
        ...overrides,
      },
    })
  }

  jobEvent(event: string): void {
    this.frame({ t: 'jobEvent', v: { event, fault: null } })
  }

  reply(seq: number, ok: boolean, value?: unknown, error?: string): void {
    this.frame({ t: 'reply', seq, ok, ...(value === undefined ? {} : { v: value }), ...(error === undefined ? {} : { error }) })
  }
}

// ---- harness --------------------------------------------------------------

let restoreWebSocket: (() => void) | null = null
let openTransport: InstanceType<typeof BridgeTransport> | null = null
const forwarded: unknown[] = []

async function connectBridge(machineId: string = MACHINE_A): Promise<FakeBridge> {
  // Exactly what `machineSession.connectMachine` does for a bridge connection:
  // resolve this machine's port at the connection boundary, then hand the
  // transport a URL and nothing else. The machine id reaches the transport the
  // way it does in the app - as `machineBridgePort`'s note - so this proves the
  // production wiring rather than a convenience the test passed in by hand.
  const transport = new BridgeTransport(bridgeUrl(machineBridgePort(machineId)))
  openTransport = transport
  const started = transport.start({
    onMessage: (m) => { forwarded.push(m) },
    onClose: () => {},
  })
  const socket = FakeSocket.last!
  socket.open()
  await started
  return new FakeBridge(socket)
}

/** Connected, with a spindle link, sitting on COM3 -- the ordinary state the
 *  operator opens Settings in. */
async function connectedOnCom3(machineId: string = MACHINE_A): Promise<FakeBridge> {
  const bridge = await connectBridge(machineId)
  bridge.hello({ vfdPresent: true })
  bridge.vfd({ port: 'COM3' })
  return bridge
}

/** The BRIDGE process restarts: this socket goes away and a new bridge answers
 *  on the same endpoint. LienCAM is NOT reloaded - same module, same memory,
 *  which is exactly the case gate 4 is about. */
async function bridgeRestarts(machineId: string = MACHINE_A): Promise<FakeBridge> {
  await openTransport!.close()
  FakeSocket.last = null
  return await connectBridge(machineId)
}

/** LienCAM ITSELF is closed and reopened: the socket goes, and every scrap of
 *  in-memory state goes with it. Only what reached browser storage comes back,
 *  which is the half the attempt-1 audit found missing. */
async function liencamReloads(): Promise<void> {
  await openTransport!.close()
  openTransport = null
  FakeSocket.last = null
  const persisted = mem.get(UI_PREFS_STORAGE_KEY) ?? null
  useUiPrefs.setState({ machineLinks: {} })
  mem.clear()
  if (persisted !== null) mem.set(UI_PREFS_STORAGE_KEY, persisted)
  await useUiPrefs.persist.rehydrate()
}

beforeEach(() => {
  forwarded.length = 0
  // Every test starts as a fresh INSTALL - no stored prefs on this computer,
  // so nothing is remembered for any machine.
  mem.clear()
  useUiPrefs.setState({ machineLinks: {} })
  const g = globalThis as unknown as { WebSocket: unknown }
  const original = g.WebSocket
  g.WebSocket = FakeSocket as unknown
  restoreWebSocket = () => { g.WebSocket = original }
  act(() => { useCamStore.getState().closeModal() })
})

afterEach(async () => {
  cleanup()
  await openTransport?.close()
  openTransport = null
  FakeSocket.last = null
  restoreWebSocket?.()
  restoreWebSocket = null
})

// ---------------------------------------------------------------------------

describe('WO-1000 the wire contract (design 3.2 Option B)', () => {
  it('types the two calls and the new push field without a protocol bump', () => {
    expect(BRIDGE_LIST_SERIAL_PORTS).toBe('listSerialPorts')
    expect(BRIDGE_SET_VFD_PORT).toBe('setVfdPort')

    // The reply value is exactly what the design specifies.
    const value: BridgeSerialPortsValue = { ports: ['COM1', 'COM3'] }
    expect(value.ports).toHaveLength(2)

    // Gate 5: `port` is ADDITIVE on the existing push. A push built without it
    // still satisfies the type, which is what "an old bridge keeps working"
    // means at compile time.
    const oldBridgePush: BridgeVfdPush = {
      t: 'vfd',
      v: {
        up: true, running: false, faulted: false, runStateWord: 0, commandWord: 0,
        setpointWord: 0, consecutiveFailures: 0, lastStopReason: 'none',
        lastError: null, statusWords: [], status: {}, upToSpeed: null,
      },
    }
    expect('port' in oldBridgePush.v).toBe(false)
  })

  it('lists the ports on this computer and asks for one by name', async () => {
    const bridge = await connectedOnCom3()
    const link = activeVfdPortLink()!

    const listing = link.listPorts()
    const listCall = bridge.lastCall(BRIDGE_LIST_SERIAL_PORTS)
    expect(listCall.a).toEqual({})
    bridge.reply(listCall.seq, true, { ports: ['COM1', 'COM3', 'COM7'] })
    expect(await listing).toEqual({ ok: true, error: null })
    expect(vfdPortLinkState().ports).toEqual(['COM1', 'COM3', 'COM7'])

    const request = link.selectPort('COM7')
    const setCall = bridge.lastCall(BRIDGE_SET_VFD_PORT)
    expect(setCall.a).toEqual({ port: 'COM7' })
    bridge.reply(setCall.seq, true)
    expect(await request).toEqual({ ok: true, error: null })
  })

  it('never numbers a call into the controller\'s seq space', async () => {
    const bridge = await connectedOnCom3()
    const link = activeVfdPortLink()!
    const listing = link.listPorts()
    const call = bridge.lastCall(BRIDGE_LIST_SERIAL_PORTS)
    // UccncController numbers from 1 upward and drops replies it does not
    // recognise; a collision would hand it this reply as one of its own.
    expect(call.seq).toBeGreaterThan(100000)
    bridge.reply(call.seq, true, { ports: [] })
    await listing
    // ...and the picker's own reply is still forwarded, unchanged, to the
    // controller, which ignores it. The transport consumes nothing.
    expect(forwarded.some((m) => (m as { t: string; seq?: number }).seq === call.seq)).toBe(true)
  })
})

describe('WO-1000 gate 3 - the dropdown renders the PUSHED port, always', () => {
  it('takes the port from the vfd push, with no call of its own', async () => {
    const bridge = await connectedOnCom3()
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
    bridge.vfd({ port: 'COM9' })
    expect(vfdPortLinkState().reportedPort).toBe('COM9')
    expect(new FakeBridge(FakeSocket.last!).calls()).toHaveLength(0)
  })

  it('does not move the selection when the bridge merely ACCEPTS the ask', async () => {
    const bridge = await connectedOnCom3()
    const link = activeVfdPortLink()!

    const request = link.selectPort('COM7')
    bridge.reply(bridge.lastCall(BRIDGE_SET_VFD_PORT).seq, true)
    await request
    // Accepted, but nothing has reported the link moved yet.
    expect(vfdPortLinkState().reportedPort).toBe('COM3')

    bridge.vfd({ port: 'COM7' })
    expect(vfdPortLinkState().reportedPort).toBe('COM7')
  })

  it('reads an omitted port as "this bridge does not say", not as "no port"', async () => {
    const bridge = await connectedOnCom3()
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
    bridge.vfd({})                       // an old bridge, no `port` key at all
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
    bridge.vfd({ port: null })           // a new bridge saying "nothing open"
    expect(vfdPortLinkState().reportedPort).toBeNull()
  })
})

describe('WO-1000 THE NEGATIVE CONTROL - a port that will not open', () => {
  it('reports the failure and leaves the PREVIOUS port selected', async () => {
    const bridge = await connectedOnCom3()
    const link = activeVfdPortLink()!

    const request = link.selectPort('COM7')
    bridge.reply(
      bridge.lastCall(BRIDGE_SET_VFD_PORT).seq,
      false,
      undefined,
      'could not open COM7 - Access to the port is denied.',
    )

    expect(await request).toEqual({
      ok: false,
      error: 'could not open COM7 - Access to the port is denied.',
    })
    const state = vfdPortLinkState()
    expect(state.error).toBe('could not open COM7 - Access to the port is denied.')
    // Nothing switched underneath anyone.
    expect(state.reportedPort).toBe('COM3')
  })

  it('stays on the previous port when the bridge accepts and then reports the OLD one', async () => {
    const bridge = await connectedOnCom3()
    const link = activeVfdPortLink()!
    const request = link.selectPort('COM7')
    bridge.reply(bridge.lastCall(BRIDGE_SET_VFD_PORT).seq, true)
    await request
    // The move failed after the reply; the link fell back and says so.
    bridge.vfd({ port: 'COM3' })
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
  })

  it('says so, rather than hanging, when the bridge never answers', async () => {
    // A link with 5 ms of patience standing in for the shipped 8 s, talking to
    // a bridge that takes the call and says nothing.
    const sent: unknown[] = []
    const link = new VfdPortLink((m) => { sent.push(m) }, () => {}, 5)
    const result = await link.listPorts()
    expect(sent).toHaveLength(1)
    expect(result).toEqual({ ok: false, error: VFD_PORT_REFUSAL.timedOut })
    expect(link.state().ports).toBeNull()
  })
})

describe('WO-1000 gate 1 - never while the spindle turns or a program runs', () => {
  it('refuses under a running spindle, and sends nothing', async () => {
    const bridge = await connectedOnCom3()
    bridge.vfd({ port: 'COM3', running: true })

    const result = await activeVfdPortLink()!.selectPort('COM7')
    expect(result).toEqual({ ok: false, error: VFD_PORT_REFUSAL.spindleRunning })
    expect(bridge.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
  })

  it('refuses while a program is running, including while it is paused', async () => {
    const bridge = await connectedOnCom3()

    bridge.jobEvent('started')
    expect(await activeVfdPortLink()!.selectPort('COM7'))
      .toEqual({ ok: false, error: VFD_PORT_REFUSAL.jobActive })

    bridge.jobEvent('paused')
    expect(await activeVfdPortLink()!.selectPort('COM7'))
      .toEqual({ ok: false, error: VFD_PORT_REFUSAL.jobActive })

    expect(bridge.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)

    // The job ends and the ask goes through.
    bridge.jobEvent('completed')
    const request = activeVfdPortLink()!.selectPort('COM7')
    bridge.reply(bridge.lastCall(BRIDGE_SET_VFD_PORT).seq, true)
    expect(await request).toEqual({ ok: true, error: null })
  })
})

describe('WO-1000 gate 2 - it may MOVE a link, never create one', () => {
  it('refuses with the bridge\'s own sentence when no spindle link exists', async () => {
    const bridge = await connectBridge()
    bridge.hello({ vfdPresent: false })

    expect(vfdPortLinkState().linkPresent).toBe(false)
    const result = await activeVfdPortLink()!.selectPort('COM7')
    expect(result).toEqual({ ok: false, error: VFD_PORT_REFUSAL.noLink })
    // The whole point: nothing reached the wire, so nothing could have opened
    // a serial port (BRIDGE-PROTOCOL safety rule 5).
    expect(bridge.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
  })
})

describe('WO-1000 an old bridge degrades cleanly', () => {
  it('shows the bridge\'s unknown-method sentence and offers no list', async () => {
    const bridge = await connectedOnCom3()
    const link = activeVfdPortLink()!

    const listing = link.listPorts()
    bridge.reply(
      bridge.lastCall(BRIDGE_LIST_SERIAL_PORTS).seq,
      false,
      undefined,
      "the bridge does not know the method 'listSerialPorts'",
    )
    expect(await listing).toEqual({
      ok: false,
      error: "the bridge does not know the method 'listSerialPorts'",
    })
    // "never asked / the ask failed" is not flattened into "no ports here".
    expect(vfdPortLinkState().ports).toBeNull()
    // And the connection is entirely unharmed - the vfd push still lands.
    bridge.vfd({ port: 'COM3' })
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
  })

  it('goes blank and answers outstanding calls when the bridge disconnects', async () => {
    const bridge = await connectedOnCom3()
    const link = activeVfdPortLink()!
    const listing = link.listPorts()
    expect(bridge.calls(BRIDGE_LIST_SERIAL_PORTS)).toHaveLength(1)

    await openTransport!.close()
    expect(await listing).toEqual({ ok: false, error: VFD_PORT_REFUSAL.disconnected })
    expect(vfdPortLinkState().connected).toBe(false)
    expect(activeVfdPortLink()).toBeNull()
  })
})

describe('WO-1000 gate 4 - the app remembers the port and asks again on reconnect', () => {
  /** Pick COM7, have the bridge take it, and watch the link land there. */
  async function operatorPicksCom7(bridge: FakeBridge): Promise<void> {
    const request = activeVfdPortLink()!.selectPort('COM7')
    const call = bridge.lastCall(BRIDGE_SET_VFD_PORT)
    bridge.reply(call.seq, true)
    expect(await request).toEqual({ ok: true, error: null })
    bridge.vfd({ port: 'COM7' })
    expect(vfdPortLinkState().reportedPort).toBe('COM7')
  }

  it('re-sends the remembered port when the bridge comes back on another one', async () => {
    const bridge = await connectedOnCom3()
    await operatorPicksCom7(bridge)
    // The choice is the app's, not the bridge's - and it is filed under THIS
    // machine's `machineLinks` record, which is where the design puts it.
    expect(machineVfdPort(MACHINE_A)).toBe('COM7')
    expect(useUiPrefs.getState().machineLinks[MACHINE_A]).toEqual({ vfdPort: 'COM7' })

    // The bridge is restarted and comes back on its definition's default.
    const restarted = await bridgeRestarts()
    restarted.hello({ vfdPresent: true })
    // `hello` alone moves NOTHING: it does not say which port the link came up
    // on, and a blind setVfdPort would Close a link that may be fine already.
    expect(restarted.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)

    restarted.vfd({ port: 'COM3' })
    const resend = restarted.lastCall(BRIDGE_SET_VFD_PORT)
    expect(resend.a).toEqual({ port: 'COM7' })
    expect(restarted.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(1)
    // Gate 3 still binds the re-send: the picker shows COM3 until the bridge
    // says otherwise, even though the app just asked for COM7.
    expect(vfdPortLinkState().reportedPort).toBe('COM3')

    restarted.reply(resend.seq, true)
    await Promise.resolve()
    restarted.vfd({ port: 'COM7' })
    expect(vfdPortLinkState().reportedPort).toBe('COM7')
    // Once per connection, not once per push.
    restarted.vfd({ port: 'COM7' })
    expect(restarted.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(1)
  })

  it('sends NOTHING when the restarted bridge is already on the remembered port', async () => {
    const bridge = await connectedOnCom3()
    await operatorPicksCom7(bridge)

    const restarted = await bridgeRestarts()
    restarted.hello({ vfdPresent: true })
    restarted.vfd({ port: 'COM7' })

    // A setVfdPort here would Close() a healthy link - which stops the spindle
    // - and Open() it again, on every single connect, for nothing.
    expect(restarted.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
    expect(vfdPortLinkState().reportedPort).toBe('COM7')
    expect(vfdPortLinkState().error).toBeNull()
  })

  it('does not remember a port the bridge REFUSED', async () => {
    const bridge = await connectedOnCom3()
    const request = activeVfdPortLink()!.selectPort('COM7')
    bridge.reply(
      bridge.lastCall(BRIDGE_SET_VFD_PORT).seq,
      false,
      undefined,
      'could not open COM7 - Access to the port is denied.',
    )
    expect((await request).ok).toBe(false)
    expect(machineVfdPort(MACHINE_A)).toBeNull()

    // A port that would not open is not a standing choice, so the next connect
    // is not a refusal loop.
    const restarted = await bridgeRestarts()
    restarted.hello({ vfdPresent: true })
    restarted.vfd({ port: 'COM3' })
    expect(restarted.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
  })

  it('will not restore the port while the spindle is turning, and says so', async () => {
    const bridge = await connectedOnCom3()
    await operatorPicksCom7(bridge)

    const restarted = await bridgeRestarts()
    restarted.hello({ vfdPresent: true })
    restarted.vfd({ port: 'COM3', running: true })

    // Gate 1 binds the re-send exactly as it binds the operator's own ask.
    expect(restarted.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
    expect(vfdPortLinkState().error).toBe(VFD_PORT_REFUSAL.spindleRunning)
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
  })

  it('will not restore the port at a bridge that never says where it is', async () => {
    const bridge = await connectedOnCom3()
    await operatorPicksCom7(bridge)

    const restarted = await bridgeRestarts()
    restarted.hello({ vfdPresent: true })
    restarted.vfd({})                    // an old bridge: no `port` key at all
    restarted.vfd({})

    // Nothing to compare against, so nothing is moved on a guess.
    expect(restarted.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
  })

  it('leaves the link where it is when the re-send itself is refused', async () => {
    const bridge = await connectedOnCom3()
    await operatorPicksCom7(bridge)

    const restarted = await bridgeRestarts()
    restarted.hello({ vfdPresent: true })
    restarted.vfd({ port: 'COM3' })
    const resend = restarted.lastCall(BRIDGE_SET_VFD_PORT)
    restarted.reply(resend.seq, false, undefined, 'could not open COM7 - the port is gone.')
    await Promise.resolve()

    // THE NEGATIVE CONTROL, on the automatic ask: the operator is told, and the
    // link stays on the port it is actually on.
    expect(vfdPortLinkState().error).toBe('could not open COM7 - the port is gone.')
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
  })

  // ---- the durable half: the attempt-1 audit finding ----------------------

  it("writes the choice into browser storage, in this machine's link record", async () => {
    const bridge = await connectedOnCom3()
    await operatorPicksCom7(bridge)

    // Not a claim about the store's in-memory state: these are the BYTES on
    // this computer, under the key WO-997 already persists machineLinks with.
    const persisted = mem.get(UI_PREFS_STORAGE_KEY)
    expect(persisted, 'nothing was written to browser storage').toBeTruthy()
    expect(JSON.parse(persisted!).state.machineLinks[MACHINE_A]).toEqual({ vfdPort: 'COM7' })
  })

  it('survives a LienCAM RELOAD and asks for the same port again', async () => {
    const bridge = await connectedOnCom3()
    await operatorPicksCom7(bridge)

    // Close the tab, reopen it: every scrap of in-memory state is gone and only
    // what reached storage comes back.
    await liencamReloads()
    expect(machineVfdPort(MACHINE_A)).toBe('COM7')

    const reopened = await connectBridge()
    reopened.hello({ vfdPresent: true })
    reopened.vfd({ port: 'COM3' })

    const resend = reopened.lastCall(BRIDGE_SET_VFD_PORT)
    expect(resend.a).toEqual({ port: 'COM7' })
    // Gate 3 still binds: the picker shows COM3 until the bridge says otherwise.
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
    reopened.reply(resend.seq, true)
    await Promise.resolve()
    reopened.vfd({ port: 'COM7' })
    expect(vfdPortLinkState().reportedPort).toBe('COM7')
  })

  it("keeps one machine's port out of another machine's connection", async () => {
    const bridge = await connectedOnCom3(MACHINE_A)
    await operatorPicksCom7(bridge)
    await liencamReloads()

    // A different machine profile, same computer, same bridge endpoint.
    const other = await connectBridge(MACHINE_B)
    other.hello({ vfdPresent: true })
    other.vfd({ port: 'COM3' })

    // Machine B never chose a port, so nothing is asked of its spindle link.
    expect(other.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
    expect(machineVfdPort(MACHINE_B)).toBeNull()
    // ...and machine A's choice is untouched by machine B connecting.
    expect(machineVfdPort(MACHINE_A)).toBe('COM7')
  })

  it('remembers each machine separately once both have chosen', async () => {
    const first = await connectedOnCom3(MACHINE_A)
    await operatorPicksCom7(first)
    await liencamReloads()

    const second = await connectedOnCom3(MACHINE_B)
    const request = activeVfdPortLink()!.selectPort('COM9')
    second.reply(second.lastCall(BRIDGE_SET_VFD_PORT).seq, true)
    expect(await request).toEqual({ ok: true, error: null })

    expect(machineVfdPort(MACHINE_A)).toBe('COM7')
    expect(machineVfdPort(MACHINE_B)).toBe('COM9')
  })

  it('refuses a port name that is not one, rather than storing it', () => {
    for (const bad of ['', '   ']) {
      expect(() => useUiPrefs.getState().setMachineVfdPort(MACHINE_A, bad))
        .toThrow(INVALID_VFD_PORT_MESSAGE)
    }
    expect(useUiPrefs.getState().machineLinks).toEqual({})
  })

  it('re-sends nothing when a stored port name is stale rubbish', async () => {
    // A tampered or half-written pref must not fail the CONNECT the way a bad
    // bridge port does - nothing dials a VFD port name - so it reads as "never
    // chosen" and the bridge's own reported port stands.
    mem.set(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { machineLinks: { [MACHINE_A]: { vfdPort: 42 } } },
      version: UI_PREFS_VERSION,
    }))
    await useUiPrefs.persist.rehydrate()
    expect(machineVfdPort(MACHINE_A)).toBeNull()

    const bridge = await connectedOnCom3()
    expect(bridge.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
    expect(vfdPortLinkState().reportedPort).toBe('COM3')
  })
})

// ---- the surface the operator actually touches -----------------------------

function openControllerSetup(): void {
  render(createElement(ControllerSetupPanel, { connectionKind: 'bridge' }))
}

describe('WO-1000 the picker in Controller Setup', () => {
  it('keeps its single home visible but disabled when no machine bridge is connected', () => {
    openControllerSetup()
    expect(screen.getByTestId('machine-controller-setup')).not.toBeNull()
    expect(screen.getByTestId('machine-controller-vfd-port').hasAttribute('disabled')).toBe(true)
    expect(screen.queryByTestId('settings-vfd-port')).toBeNull()
  })

  it('refuses without sending when the bridge reports no spindle link', async () => {
    const bridge = await connectBridge()
    await act(async () => { bridge.hello({ vfdPresent: false }) })
    openControllerSetup()

    expect(screen.getByTestId('machine-controller-vfd-port').hasAttribute('disabled')).toBe(true)
    expect(await activeVfdPortLink()!.selectPort('COM7'))
      .toEqual({ ok: false, error: VFD_PORT_REFUSAL.noLink })
    expect(bridge.calls(BRIDGE_LIST_SERIAL_PORTS)).toHaveLength(0)
    expect(bridge.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
  })

  it('lists the computer\'s ports and shows the one the bridge reports', async () => {
    const bridge = await connectedOnCom3()
    openControllerSetup()

    const picker = screen.getByTestId('machine-controller-vfd-port') as HTMLSelectElement
    act(() => { fireEvent.focus(picker) })
    const call = bridge.lastCall(BRIDGE_LIST_SERIAL_PORTS)
    await act(async () => { bridge.reply(call.seq, true, { ports: ['COM1', 'COM3', 'COM7'] }) })

    expect(picker.value).toBe('COM3')
    expect([...picker.options].map((option) => option.value))
      .toEqual(expect.arrayContaining(['COM1', 'COM3', 'COM7']))
  })

  it('THE NEGATIVE CONTROL, end to end: a refused port leaves COM3 selected', async () => {
    const bridge = await connectedOnCom3()
    openControllerSetup()
    const picker = screen.getByTestId('machine-controller-vfd-port') as HTMLSelectElement
    act(() => { fireEvent.focus(picker) })
    await act(async () => {
      bridge.reply(bridge.lastCall(BRIDGE_LIST_SERIAL_PORTS).seq, true, { ports: ['COM3', 'COM7'] })
    })

    act(() => { fireEvent.change(picker, { target: { value: 'COM7' } }) })

    const setCall = bridge.lastCall(BRIDGE_SET_VFD_PORT)
    expect(setCall.a).toEqual({ port: 'COM7' })
    await act(async () => {
      bridge.reply(setCall.seq, false, undefined, 'could not open COM7 - Access to the port is denied.')
    })

    expect(screen.getByRole('status').textContent)
      .toBe('could not open COM7 - Access to the port is denied.')
    // The picker still shows the port the link is still on -- NOT the one that
    // was clicked. This is the whole acceptance item.
    expect(picker.value).toBe('COM3')
  })

  it('will not let the port be changed under a turning spindle', async () => {
    const bridge = await connectedOnCom3()
    openControllerSetup()
    await act(async () => { bridge.vfd({ port: 'COM3', running: true }) })

    expect(screen.getByTestId('machine-controller-vfd-port').hasAttribute('disabled')).toBe(true)
    expect(await activeVfdPortLink()!.selectPort('COM7'))
      .toEqual({ ok: false, error: VFD_PORT_REFUSAL.spindleRunning })
    expect(bridge.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
  })

  it('writes the selected port through selectPort and waits for bridge readback', async () => {
    const bridge = await connectedOnCom3()
    openControllerSetup()
    const picker = screen.getByTestId('machine-controller-vfd-port') as HTMLSelectElement
    act(() => { fireEvent.focus(picker) })
    await act(async () => {
      bridge.reply(bridge.lastCall(BRIDGE_LIST_SERIAL_PORTS).seq, true, { ports: ['COM3', 'COM7'] })
    })

    act(() => { fireEvent.change(picker, { target: { value: 'COM7' } }) })
    const setCall = bridge.lastCall(BRIDGE_SET_VFD_PORT)
    expect(setCall.a).toEqual({ port: 'COM7' })
    await act(async () => { bridge.reply(setCall.seq, true) })
    expect(picker.value).toBe('COM3')
    await act(async () => { bridge.vfd({ port: 'COM7' }) })
    expect(picker.value).toBe('COM7')
  })

  it('refreshes the list on focus without ever opening a port', async () => {
    const bridge = await connectedOnCom3()
    openControllerSetup()
    const picker = screen.getByTestId('machine-controller-vfd-port') as HTMLSelectElement
    act(() => { fireEvent.focus(picker) })
    await act(async () => {
      bridge.reply(bridge.lastCall(BRIDGE_LIST_SERIAL_PORTS).seq, true, { ports: ['COM3'] })
    })

    act(() => { fireEvent.blur(picker); fireEvent.focus(picker) })
    await act(async () => {
      bridge.reply(bridge.lastCall(BRIDGE_LIST_SERIAL_PORTS).seq, true, { ports: ['COM3', 'COM7'] })
    })

    expect(bridge.calls(BRIDGE_LIST_SERIAL_PORTS)).toHaveLength(2)
    expect(bridge.calls(BRIDGE_SET_VFD_PORT)).toHaveLength(0)
    expect([...picker.options].some((option) => option.value === 'COM7')).toBe(true)
  })
})
