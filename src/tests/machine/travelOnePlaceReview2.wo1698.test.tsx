// @vitest-environment jsdom
//
// WO-1698 review 2 (opus, safety path, after fix round 2).
//
// The Machine Library's Travel link can now land the Control page's
// Definition panel on machine B while a live bridge session holds machine A.
// These cases prove the machine-harm boundary on that path through the REAL
// session code (only the bridge's WebSocket is faked):
//   - the page shows B (by name and id) and says, naming both machines, that
//     B is not the live machine (WO-1712: the header line replaces the old
//     generic "Saved profile" text for exactly this case);
//   - WO-1712 re-pin: Apply is not offered anywhere on the page while it
//     shows B (bar, Legacy section, Legacy button all absent) - a control
//     that could only refuse was removed rather than left to refuse on
//     click. The same apply path it used to reach is proved unchanged by
//     calling it directly: it still refuses and sends NOTHING to A's board;
//     A's record and the live session are untouched;
//   - leaving the Definition tab and coming back (the panel unmounts - Control
//     renders it only while Machine -> Definition is open) shows A again.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { MachineConfig } from '../../types'
import type {
  BridgeApplyDefinitionReply,
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  applyCalls(): BridgeCallMessage[]
}
const fakeBridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

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
  lines: [{ text: 'Machine definition: all settings written and read back.', severity: 'info' }],
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null
    constructor() { super(); fakeBridge.last = this }
    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: { protocol: 1, bridge: 'fake-bridge 0.0', capabilities: CAPS, readOnly: false },
      })
    }
    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m !== 'applyMachineDefinition') return
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: CLEAN_REPLY })
    }
    async close(): Promise<void> { this.fakeEvents?.onClose('closed') }
    emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }
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
const { requestMachineDefinitionSection } =
  await import('../../components/machine/definition/machineDefinitionSectionRequest')
const { useCamStore, controlMachine } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { createDefaultControllerDefinition } = await import('../../types')

const state = () => useCamStore.getState()

function router(id: string, name: string, backOff: number): MachineConfig {
  const definition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
  definition.homing.perAxis.Z!.backOff = backOff
  return {
    id, name, type: 'gantry_router', controller: 'uccnc',
    travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: definition,
  }
}

const A = () => router('wo1698-r2-a', 'Review Machine A (connected)', 2)
const B = () => router('wo1698-r2-b', 'Review Router B (library)', 5)

async function connectToA(): Promise<void> {
  const a = A()
  act(() => {
    useCamStore.setState({ machineLibrary: [a, B()], consoleEvents: [] } as never)
    state().setProjectMachine(JSON.parse(JSON.stringify(a)))
    useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: null } }))
    state().closeModal()
  })
  await act(async () => { await session.connectMachine('bridge') })
  expect(useMachineControl.getState().connectionPhase).toBe('connected')
  expect(controlMachine(state()).id).toBe(a.id)
}

beforeEach(() => { fakeBridge.last = null })

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await act(async () => { await session.disconnectMachine() })
  }
  vi.restoreAllMocks()
})

describe('WO-1698 review 2 - Definition page on B while A is connected', () => {
  // WO-1712 re-pin: outcome 1 closes this hole at the page itself - Apply is
  // not offered on ANY of the page's three Apply surfaces (bar, Legacy
  // section, Legacy button) while it shows a foreign machine, and the header
  // names both machines in plain words. The wire-level refusal this test
  // originally reached by clicking Apply (WO-1698's
  // `applyConnectedMachineDefinition` machine-id check) is unchanged - proved
  // here by calling that same apply path directly, since the page no longer
  // exposes a control that would reach it.
  it('Apply is not offered on B; the same apply path still refuses and sends nothing; A\'s record is untouched', async () => {
    await connectToA()
    const aBefore = JSON.stringify(state().machineLibrary.find((m) => m.id === 'wo1698-r2-a'))
    // What the Machine Library's Travel link does while pinned to another machine.
    act(() => { requestMachineDefinitionSection('wo1698-r2-b', 'machine') })
    render(<MachineDefinitionPanel />)

    const panel = screen.getByTestId('machine-definition-panel')
    expect(panel.getAttribute('data-machine-id')).toBe('wo1698-r2-b')
    // The page states B is not the live machine, naming both machines - the
    // one place the page names the machine at all now (WO-1713 removed the
    // header's own redundant name badge).
    expect(screen.getByTestId('machine-def-panel-authority-status').textContent).toBe(
      'This is Review Router B (library) - not the machine connected now '
      + '(Review Machine A (connected)). Changes are saved to Review Router B (library); '
      + 'apply them when Review Router B (library) is connected.',
    )
    // No Apply control anywhere on the page while it shows a foreign machine.
    expect(screen.queryByTestId('machine-def-bar-apply')).toBeNull()
    expect(screen.queryByTestId('machine-def-panel-apply-section')).toBeNull()
    expect(screen.queryByTestId('machine-def-panel-apply')).toBeNull()

    // The same apply path the removed button used to reach still refuses and
    // sends nothing, in plain words - defense in depth under the page gate.
    const outcome = await session.applyActiveMachineDefinition(
      {}, session.activeMachineDefinition(), 'wo1698-r2-b',
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe(
      'Nothing was sent: this definition does not belong to the connected machine session.',
    )

    // Nothing reached the wire.
    expect(fakeBridge.last).not.toBeNull()
    expect(fakeBridge.last!.applyCalls()).toHaveLength(0)
    // A's record and the live session are untouched; Control still drives A.
    expect(JSON.stringify(state().machineLibrary.find((m) => m.id === 'wo1698-r2-a'))).toBe(aBefore)
    expect(state().control.sessionMachine?.id).toBe('wo1698-r2-a')
    expect(session.activeMachineDefinition()!.homing.perAxis.Z!.backOff).toBe(2)
    expect(controlMachine(state()).id).toBe('wo1698-r2-a')
  })

  it('leaving the Definition tab and coming back shows the connected machine again', async () => {
    await connectToA()
    act(() => { requestMachineDefinitionSection('wo1698-r2-b', 'machine') })
    const first = render(<MachineDefinitionPanel />)
    expect(screen.getByTestId('machine-definition-panel').getAttribute('data-machine-id'))
      .toBe('wo1698-r2-b')
    // Control renders the panel only while Machine -> Definition is open, so
    // any other Control view or Machine sub-tab unmounts it.
    first.unmount()
    render(<MachineDefinitionPanel />)
    expect(screen.getByTestId('machine-definition-panel').getAttribute('data-machine-id'))
      .toBe('wo1698-r2-a')
  })
})
