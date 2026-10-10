// @vitest-environment jsdom
//
// WO-1266: the Main tab's work-offsets table showed G54 Z 12.160 highlighted as
// active while the bridge and the DRO held 66.570 (machine seat, 2026-09-07).
// Two views held two numbers: the Offsets tab read the DURABLE record, which an
// operator's zero had updated through its receipt; the Main card read the
// SESSION table, which only hello and the connect restore ever wrote on the
// bridge backend. Same root cause as 2026-08-22: "the UI renders what it
// commanded, not what the machine reports".
//
// The rule these tests pin: the Main card renders what the controller REPORTED.
// A receipt's echo is such a report and now reaches the session table through
// the same `onOffset` event a grbl `$#` row uses; a slot the controller has not
// reported is a dash, never a remembered number.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { OffsetsPanel } from '../../components/machine/OffsetsPanel'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'
import { buildContractEvents, zeroWorkAxes } from '../../lib/machine/machineSession'
import { SUPPORTED_BRIDGE_PROTOCOL, UccncController } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type {
  BridgeCallMessage,
  BridgeHelloPush,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'
import type { MachineVec3, WcsId } from '../../lib/machine/types'

const WCS: WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']
/** What the bridge held at hello on 2026-09-07 - UCCNC's remembered G54. */
const HELLO_G54: MachineVec3 = { x: 81.2275, y: 61.3225, z: 12.16 }
/** Operator's work zero, as the bridge and the DRO reported it after his zero. */
const SAMPLE_MACHINE_G54: MachineVec3 = { x: 188.7325, y: 397.655, z: 66.57 }
const ZERO: MachineVec3 = { x: 0, y: 0, z: 0 }

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

function allOffsets(g54: MachineVec3): Record<WcsId, MachineVec3> {
  return Object.fromEntries(
    WCS.map((wcs) => [wcs, wcs === 'G54' ? { ...g54 } : { ...ZERO }]),
  ) as Record<WcsId, MachineVec3>
}

type ZeroReplyShape = 'echo' | 'bare-true'

/** A bridge that answers `setWorkOffset` and `zeroWorkAxis` with WO-1083's
 *  echo of the whole row it now holds. `zeroReply: 'bare-true'` is the older
 *  bridge that applies the zero and cannot say what the offset became. */
class FakeBridge implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  held = allOffsets(HELLO_G54)
  /** Where the tool stands: a zero writes this into the active row. */
  at: MachineVec3 = { ...SAMPLE_MACHINE_G54 }
  refuseWrites = false
  zeroReply: ZeroReplyShape = 'echo'

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }

  send(message: BridgeCallMessage): void {
    this.sent.push(message)
    if (message.m === 'setWorkOffset') {
      const wcs = message.a?.wcs as WcsId
      const requested = message.a ?? {}
      const next = {
        ...this.held[wcs],
        ...(requested.x === undefined ? {} : { x: requested.x as number }),
        ...(requested.y === undefined ? {} : { y: requested.y as number }),
        ...(requested.z === undefined ? {} : { z: requested.z as number }),
      }
      if (!this.refuseWrites) this.held[wcs] = next
      this.reply(message.seq, this.refuseWrites
        ? { ok: false, reason: 'refused by fixture', offset: null }
        : { ok: true, reason: null, offset: { ...next } }, !this.refuseWrites)
      return
    }
    if (message.m === 'zeroWorkAxis') {
      const axis = (message.a?.axis as string).toLowerCase() as keyof MachineVec3
      this.held.G54 = { ...this.held.G54, [axis]: this.at[axis] }
      this.reply(message.seq, this.zeroReply === 'bare-true'
        ? true
        : { ok: true, reason: null, wcs: 'G54', axis: message.a?.axis, offset: { ...this.held.G54 } }, true)
    }
  }

  async close(): Promise<void> {}

  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }

  private reply(seq: number, v: unknown, ok: boolean): void {
    queueMicrotask(() => this.emit({
      t: 'reply',
      seq,
      ok,
      v,
      ...(ok ? {} : { error: 'refused by fixture' }),
    } as BridgeMessage))
  }
}

async function connectedBridge(
  events: ControllerEvents,
  workOffsets: NonNullable<BridgeHelloPush['v']['workOffsets']> | undefined = {
    current: allOffsets(HELLO_G54),
    profile: allOffsets(HELLO_G54),
  },
): Promise<{ controller: UccncController; transport: FakeBridge }> {
  const controller = new UccncController(events)
  const transport = new FakeBridge()
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'wo-1266-fixture',
      capabilities: NO_CAPS,
      readOnly: false,
      ...(workOffsets ? { workOffsets } : {}),
    },
  })
  await connecting
  return { controller, transport }
}

function offsetInput(wcs: string, axis: string): HTMLInputElement | null {
  return screen.queryByTestId(`control-offset-${wcs}-${axis}`) as HTMLInputElement | null
}

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState({ machineWorkOffsets: {} })
  useUiPrefs.setState({ machineOffsetsCollapsed: false })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    offsets: {},
    consoleLines: [],
  })
})

afterEach(() => cleanup())

describe('WO-1266 the bridge backend reports every offset receipt', () => {
  it('a setWorkOffset echo is raised as an offset report for that WCS', async () => {
    const onOffset = vi.fn()
    const { controller } = await connectedBridge({ onOffset })

    const receipt = await controller.setWorkOffset('G54', { z: SAMPLE_MACHINE_G54.z })

    expect(receipt.ok).toBe(true)
    expect(onOffset).toHaveBeenCalledTimes(1)
    expect(onOffset).toHaveBeenCalledWith({
      label: 'G54',
      values: [HELLO_G54.x, HELLO_G54.y, SAMPLE_MACHINE_G54.z],
    })
  })

  it('a zeroWorkAxis echo is raised as an offset report for the WCS the bridge names', async () => {
    const onOffset = vi.fn()
    const { controller } = await connectedBridge({ onOffset })

    const receipt = await controller.zeroWorkAxisAwait('Z')

    expect(receipt).toMatchObject({ confirmed: true, wcs: 'G54' })
    expect(onOffset).toHaveBeenCalledWith({
      label: 'G54',
      values: [HELLO_G54.x, HELLO_G54.y, SAMPLE_MACHINE_G54.z],
    })
  })

  it('a refused write and an older bridge\'s bare-true zero report nothing', async () => {
    const onOffset = vi.fn()
    const { controller, transport } = await connectedBridge({ onOffset })

    transport.refuseWrites = true
    const refused = await controller.setWorkOffset('G54', { z: SAMPLE_MACHINE_G54.z })
    expect(refused.ok).toBe(false)

    transport.zeroReply = 'bare-true'
    const bare = await controller.zeroWorkAxisAwait('Z')
    expect(bare).toEqual({ confirmed: true })

    expect(onOffset).not.toHaveBeenCalled()
  })

  it('a receipt that lands after the transport was replaced is not reported', async () => {
    const onOffset = vi.fn()
    const { controller, transport } = await connectedBridge({ onOffset })
    // Hold the reply: the controller is torn down before it arrives.
    const heldSeq: number[] = []
    transport.send = (message) => { heldSeq.push(message.seq) }
    const pending = controller.setWorkOffset('G54', { z: SAMPLE_MACHINE_G54.z })
    await controller.disconnect()
    transport.emit({
      t: 'reply', seq: heldSeq[0], ok: true,
      v: { ok: true, reason: null, offset: { ...SAMPLE_MACHINE_G54 } },
    } as BridgeMessage)
    await pending.catch(() => undefined)

    expect(onOffset).not.toHaveBeenCalled()
  })
})

describe('WO-1266 the Main card renders what the controller reported', () => {
  it('shows the new zero in the table after an operator zero, with no reconnect and no remount', async () => {
    const machineId = useCamStore.getState().project.machine.id
    const { controller } = await connectedBridge(buildContractEvents())
    // The hello reached the session table the way WO-1184's reconcile does.
    act(() => {
      useMachineControl.getState().applyOffset({
        label: 'G54', values: [HELLO_G54.x, HELLO_G54.y, HELLO_G54.z],
      })
    })
    render(<OffsetsPanel />)
    expect(offsetInput('g54', 'z')?.value).toBe('12.16')

    await act(async () => {
      expect(zeroWorkAxes(['X', 'Y', 'Z'], controller).ok).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The bridge's echo is the session table's value AND the card's value.
    expect(useMachineControl.getState().offsets.G54).toEqual([SAMPLE_MACHINE_G54.x, SAMPLE_MACHINE_G54.y, SAMPLE_MACHINE_G54.z])
    expect(offsetInput('g54', 'x')?.value).toBe('188.73')
    expect(offsetInput('g54', 'y')?.value).toBe('397.65')
    expect(offsetInput('g54', 'z')?.value).toBe('66.57')
    // The durable record agrees, so the two tabs can no longer disagree.
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.offset).toEqual(SAMPLE_MACHINE_G54)
  })

  it('a slot the controller has not reported is a dash, never a previous session\'s number', () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', SAMPLE_MACHINE_G54, 'sent')
    render(<OffsetsPanel />)

    expect(offsetInput('g54', 'x')).toBeNull()
    expect(offsetInput('g54', 'z')).toBeNull()
    const table = screen.getByTestId('control-offsets-table')
    expect(table.textContent).not.toContain('188.73')
    expect(table.textContent).not.toContain('66.57')
  })

  it('an unsent edit never replaces the controller\'s value on the card - only its marker shows', () => {
    const machineId = useCamStore.getState().project.machine.id
    useMachineControl.setState({ offsets: { G54: [HELLO_G54.x, HELLO_G54.y, HELLO_G54.z] } })
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { z: SAMPLE_MACHINE_G54.z }, 'not-sent')
    render(<OffsetsPanel />)

    const z = offsetInput('g54', 'z')!
    expect(z.value).toBe('12.16')
    expect(z.closest('[data-offset-value-pair]')?.hasAttribute('data-not-sent')).toBe(true)
  })

  it('disconnect clears the report, numbers, and active highlight without changing the durable record', () => {
    const machineId = useCamStore.getState().project.machine.id
    useMachineControl.setState({ offsets: { G54: [HELLO_G54.x, HELLO_G54.y, HELLO_G54.z] } })
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { z: SAMPLE_MACHINE_G54.z }, 'not-sent')
    render(<OffsetsPanel />)
    expect(offsetInput('g54', 'x')?.value).toBe('81.23')

    act(() => useMachineControl.getState().setConnection('disconnected', null))

    expect(useMachineControl.getState().offsets).toEqual({})
    // No controller, no controller value: the Main card shows only dashes and
    // does not make the remembered G54 look active. The Offsets workspace owns
    // editing the durable value, which survives unchanged here.
    expect(offsetInput('g54', 'x')).toBeNull()
    expect(offsetInput('g54', 'z')).toBeNull()
    const table = screen.getByTestId('control-offsets-table')
    expect(table.textContent).toContain('G54')
    expect(table.textContent).not.toContain('WCS?')
    expect(table.textContent).toContain('G54---')
    expect(table.textContent).not.toContain('66.57')
    expect(table.querySelector('.control-offsets-active')).toBeNull()
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.offset.z).toBe(SAMPLE_MACHINE_G54.z)
  })

  it('connected before the first offset report also shows no active slot', () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', SAMPLE_MACHINE_G54, 'sent')
    render(<OffsetsPanel />)

    const table = screen.getByTestId('control-offsets-table')
    expect(table.textContent).toContain('G54')
    expect(table.textContent).not.toContain('WCS?')
    expect(table.textContent).toContain('G54---')
    expect(table.querySelector('.control-offsets-active')).toBeNull()
    expect(screen.getByTestId('control-wcs-g54').classList.contains('control-chip-active')).toBe(false)

    act(() => useMachineControl.getState().applyOffset({ label: 'G54', values: [1, 2, 3] }))
    expect(screen.getByTestId('control-offsets-table').querySelector('.control-offsets-active')).not.toBeNull()
    expect(offsetInput('g54', 'z')?.value).toBe('3.00')
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.offset).toEqual(SAMPLE_MACHINE_G54)
  })
})
