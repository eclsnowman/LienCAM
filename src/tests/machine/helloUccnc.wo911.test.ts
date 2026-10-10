// WO-911: `hello.uccnc` reaches the browser.
//
// The bridge already sends it (Bridge.cs:480, `hello.Set("uccnc",
// uccnc.Hello())`) - the browser threw it away. This proves the plumbing
// added here: UccncController.bridgeHello() now carries the raw
// `hello.uccnc` block the same way it already carried `hello.vfd`
// (WO-448), using the bridge's REAL key names
// (`UccncPaths.Hello()`, Bridge.cs:433-445) rather than this WO's draft
// names - `installRoot`, `profile`, `uc100Dll`, `ftd2xxDll`, `profiles`, not
// `profilePath`/`uc100DllPath`/`ftd2xxDllPath`.
//
// No bridge process or hardware involved, no UI: this order adds none. Same
// mock-transport posture as uccncController.wo421.test.ts.

import { describe, it, expect } from 'vitest'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeHelloPush, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents, MachineStatus } from '../../lib/machine/controller'

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

/** A mock of the bridge's browser-side socket, exactly as
 *  uccncController.wo421.test.ts drives one - not a mock of UccncController
 *  itself. */
class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  closeCalls = 0

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }
  send(message: BridgeCallMessage): void {
    this.sent.push(message)
  }
  async close(): Promise<void> {
    this.closeCalls++
  }
  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
  emitClose(reason: string | null): void {
    this.events?.onClose(reason)
  }
}

function events(): ControllerEvents {
  const statuses: MachineStatus[] = []
  return {
    onStatus: (s) => statuses.push(s),
    onConsole: () => {},
    onJobEvent: () => {},
    onHomed: () => {},
    onAlarm: () => {},
  }
}

/** The bridge's own answer shape (Bridge.cs UccncPaths.Hello()) - a
 *  fully-resolved install, one profile, three .pro files found under its
 *  Profiles folder. */
const REAL_UCCNC_HELLO = {
  installRoot: 'C:\\UCCNC',
  profile: 'C:\\UCCNC\\Profiles\\Operator.pro',
  uc100Dll: 'C:\\UCCNC\\API\\DLL\\UC100.dll',
  ftd2xxDll: 'C:\\UCCNC\\ftd2xx64.dll',
  profiles: [
    'C:\\UCCNC\\Profiles\\Default.pro',
    'C:\\UCCNC\\Profiles\\Operator.pro',
    'C:\\UCCNC\\Profiles\\Spare.pro',
  ],
}

interface HelloOverrides {
  readOnly?: boolean
  // Typed against the WIRE CONTRACT, not against REAL_UCCNC_HELLO. Inferring
  // it from that fixture made every path field `string`, so the
  // unconfigured-install case below - which is all nulls, and is the whole
  // point of the field being nullable - did not type check under `tsc -b`.
  // `tsc --noEmit` did not catch it; the build did.
  uccnc?: NonNullable<BridgeHelloPush['v']['uccnc']>
}

function helloMessage(overrides: HelloOverrides = {}): BridgeMessage {
  const v: Record<string, unknown> = {
    protocol: SUPPORTED_BRIDGE_PROTOCOL,
    bridge: 'liencam-uccnc-bridge/0.2',
    capabilities: NO_CAPS,
    readOnly: overrides.readOnly ?? false,
  }
  // Mirrors the WO-448 `vfd` fixture pattern: only set the key when the
  // test actually wants it present, so the "no uccnc key at all" case is a
  // truly absent key, not an explicit `undefined` value serialized away.
  if ('uccnc' in overrides) v.uccnc = overrides.uccnc
  return { t: 'hello', v } as BridgeMessage
}

async function connectWithHello(
  controller: UccncController,
  transport: FakeTransport,
  overrides: HelloOverrides = {},
): Promise<void> {
  const connectPromise = controller.connect({ kind: 'messages', transport })
  transport.emit(helloMessage(overrides))
  await connectPromise
}

describe('WO-911: hello.uccnc reaches UccncController.bridgeHello()', () => {
  it('publishes the bridge-real uccnc fields - installRoot/profile/uc100Dll/ftd2xxDll/profiles', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())

    await connectWithHello(controller, transport, { uccnc: REAL_UCCNC_HELLO })

    expect(controller.connectionPhase()).toBe('connected')
    expect(controller.bridgeHello()?.uccnc).toEqual(REAL_UCCNC_HELLO)
  })

  it('an empty profiles list is preserved as [], never treated as absent', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    const noProfiles = { ...REAL_UCCNC_HELLO, profiles: [] }

    await connectWithHello(controller, transport, { uccnc: noProfiles })

    expect(controller.bridgeHello()?.uccnc?.profiles).toEqual([])
  })

  it('an unconfigured install reports null path fields with profiles still an array', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    const unconfigured = {
      installRoot: null,
      profile: null,
      uc100Dll: null,
      ftd2xxDll: null,
      profiles: [],
    }

    await connectWithHello(controller, transport, { uccnc: unconfigured })

    expect(controller.bridgeHello()?.uccnc).toEqual(unconfigured)
  })

  // Negative control - the order is not done without this (WO-911
  // Acceptance): a hello with NO `uccnc` key at all must still connect, and
  // the field must read as null/undefined, never a `{}` a later profile
  // picker (WO-916) could mistake for "zero profiles found on this
  // machine."
  it('NEGATIVE CONTROL: a hello with no uccnc key still connects, and uccnc is null/undefined - not a crash, not {}', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())

    await connectWithHello(controller, transport /* no uccnc override at all */)

    expect(controller.connectionPhase()).toBe('connected')
    const hello = controller.bridgeHello()
    expect(hello).not.toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    expect(hello?.uccnc == null).toBe(true)
    expect(hello?.uccnc).not.toEqual({})
  })

  it('disconnect clears uccnc, the same way it clears vfd', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())

    await connectWithHello(controller, transport, { uccnc: REAL_UCCNC_HELLO })
    expect(controller.bridgeHello()?.uccnc).toEqual(REAL_UCCNC_HELLO)

    await controller.disconnect()
    // bridgeHello() itself returns null once disconnected (phase-gated,
    // same as before this WO) - reconnect and confirm no stale copy of the
    // PREVIOUS bridge's uccnc block survives into the new session.
    expect(controller.bridgeHello()).toBeNull()

    const transport2 = new FakeTransport()
    await connectWithHello(controller, transport2 /* this bridge sends no uccnc key */)
    expect(controller.connectionPhase()).toBe('connected')
    expect(controller.bridgeHello()?.uccnc == null).toBe(true)
  })
})
