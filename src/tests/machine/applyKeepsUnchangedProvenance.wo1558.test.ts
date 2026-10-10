// @vitest-environment jsdom
//
// WO-1558 - APPLYING A DEFINITION DOES NOT OVERWRITE WHO SET AN UNCHANGED VALUE.
//
// Board, 2026-09-14: the machine seat pressed Apply on a definition nobody had
// edited. Values were unchanged, but every provenance stamp's `source` became
// the seat's own apply timestamp, replacing Operator's 09-11 20:10 edit. The
// record of WHO set acceleration 1000 was lost.
//
// Root cause: `machineDefinitionApplyProvenance` (machineSession.ts) compared
// every sent value against the ORIGINAL profile-import baseline, which is
// captured once and never moves - so a value that drifted from that baseline
// on some earlier Apply reads as "changed" on every LATER Apply too, forever,
// and got a fresh timestamp each time. This drives the REAL apply path (the
// real store, the real MachineDefinitionPanel form, a fake bridge transport
// standing in for the AXBB-E) through three presses of Apply and reads the
// exact frame that reached the wire each time - the evidence tier the WO
// calls for, not a hand-built payload against the bare function.
//
// This also proves the WO-1558 persistence half: Machine.cs's
// `SaveDefinitionCache` rebuilds its cached `provenance` document from
// whatever this apply sends, with no per-key merge of its own (read there
// directly, the same guard WO-1073's test uses on Machine.cs). So the app
// itself has to be the one place an established stamp survives between
// applies, or the SECOND apply has nothing to restate and mints a fresh one
// regardless of the first fix.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  BridgeApplyDefinitionReply,
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineDefinitionProvenance } from '../../lib/machine/controller'
import type { MachineConfig } from '../../types'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  applyCalls(): BridgeCallMessage[]
  emit(message: BridgeMessage): void
}
const fakeBridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

// jsdom's built-in localStorage is broken under vitest's node launch flags -
// same in-memory shim as WO-928/WO-1073, installed before the store import.
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
  lines: [{ text: 'Machine definition: 4 of 4 settings written and read back.', severity: 'info' }],
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() { super(); fakeBridge.last = this }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: { protocol: 1, bridge: 'wo1558-fake-bridge', capabilities: CAPS, readOnly: false },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m !== 'applyMachineDefinition') return
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: CLEAN_REPLY })
    }

    async close(): Promise<void> { this.fakeEvents?.onClose('closed') }
    emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }
    applyCalls(): BridgeCallMessage[] { return this.sent.filter((c) => c.m === 'applyMachineDefinition') }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeTransport,
  })
})

const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { importUccncProfile } = await import('../../lib/machine/uccncProfileImport')

const state = () => useCamStore.getState()

const MACHINE_CS = readFileSync(resolve(process.cwd(), 'pendant/uccnc-bridge/Machine.cs'), 'utf8')
const LIENCNC_V2_PROFILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'), 'utf8',
)

// WO-1657: the ORIGINAL fixture here was a `createDefaultControllerDefinition`
// with one synthetic `stated` entry - 3 axes, no real drift history. It
// passed at the desk, and then the SAME "no-change Apply" the desk test pins
// re-stamped all five provenance entries at Operator's board (2026-09-17
// evening). This fixture is the real thing instead: `importUccncProfile` on
// Operator's actual `.pro` (4 axes, Y slaved to A, the real `stated` log a UCCNC
// import produces) - the shape a no-change Apply actually runs against.
function shopRouter(): MachineConfig {
  const imported = importUccncProfile(LIENCNC_V2_PROFILE)
  const definition = imported.definition
  if (!definition) throw new Error("Operator's LienCNC V2 profile did not import")
  return {
    id: 'wo1558-machine', name: 'LienCNC V2', type: 'gantry_router', controller: 'uccnc',
    travel: { x: 738, y: 724.5, z: 128.9 }, rapidRate: 6000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: definition,
  }
}

function seedLibraryAndProject(machine: MachineConfig): void {
  const projectCopy: MachineConfig = JSON.parse(JSON.stringify(machine))
  act(() => {
    useCamStore.setState({ machineLibrary: [machine], consoleEvents: [] } as never)
    state().setProjectMachine(projectCopy)
    state().closeModal()
  })
}

// WO-1690: the axis table moved off the three Legacy groups onto the outer
// "Machine" area tab - tried first, since that is where those controls live
// now. A label starting with an axis letter beyond that may be behind that
// axis's own "Pins and more" drawer.
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
  throw new Error(`no group on the definition page carries a control labelled "${label}"`)
}

const setNumber = (label: string, value: number) => {
  const field = reveal(label)
  act(() => { fireEvent.change(field, { target: { value: String(value) } }) })
  act(() => { fireEvent.blur(field) })
}

const applyButton = () => screen.getByTestId('machine-def-bar-apply')

const pressApply = async () => {
  const button = applyButton()
  await act(async () => { fireEvent.click(button) })
}

async function connectBridge(): Promise<void> {
  await act(async () => { await session.connectMachine('bridge') })
  expect(useMachineControl.getState().connectionPhase).toBe('connected')
}

function lastApplyProvenance(): MachineDefinitionProvenance {
  const calls = fakeBridge.last?.applyCalls() ?? []
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1].a.provenance as MachineDefinitionProvenance
}

// Review FAIL (2026-09-15): a stamping Apply (one that actually mints or
// restates a provenance entry) persisted the carrier onto the saved record
// AFTER `confirmControlSessionDefinition` had already cloned the pre-persist
// definition into `appliedMachine`. The panel's authority/apply surfaces
// compare the saved record against `appliedMachine` and against the pressed
// definition's own signature, so both read a false mismatch right after a
// controller-confirmed success. These two reads are exactly the review's own
// reproduction (scratch DOM probe after Apply 1).
const authorityState = (): string | null =>
  screen.getByTestId('machine-def-panel-authority-status').getAttribute('data-authority-state')
const applyButtonState = (): string | null =>
  applyButton().getAttribute('data-apply-state')

beforeEach(() => { fakeBridge.last = null })

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await act(async () => { await session.disconnectMachine() })
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WO-1558 Machine.cs has no per-key provenance merge of its own', () => {
  it('rebuilds its whole cached provenance document from exactly what the apply frame sent', () => {
    expect(MACHINE_CS).toMatch(/doc\.Set\("provenance",\s*provenance\)/)
    expect(MACHINE_CS).toMatch(/var doc = new Json\.Obj\(\)/)
  })
})

describe('WO-1558 an apply stamps a new source only on the values it changes', () => {
  it('keeps an established source through a clean second Apply, and only stamps '
    + 'the axis that actually moved on a third', async () => {
    seedLibraryAndProject(shopRouter())
    await connectBridge()
    render(createElement(MachineDefinitionPanel))

    // Apply 1, 2026-09-11 20:10 - Operator edits X acceleration. This is the
    // apply that establishes X's provenance.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T20:10:00-05:00'))
    setNumber('X acceleration (units per second squared)', 1000)
    await pressApply()
    const firstFrame = lastApplyProvenance()
    const xSource = firstFrame['axes.X.acceleration']?.source
    expect(xSource).toContain('9/11/2026')
    expect(firstFrame['axes.X.acceleration']?.kind).toBe('liencam-ui')
    // Review FAIL: Apply 1 stamps X, which is exactly a "stamping apply" -
    // the panel must not invent a pending warning or drop Apply to idle over
    // its own successful, controller-confirmed metadata write.
    expect(authorityState()).toBe('applied')
    expect(applyButtonState()).toBe('applied')

    // Apply 2, 2026-09-14 19:37 - the machine seat presses Apply again with
    // NOTHING edited. THE DEFECT: this used to re-stamp X with today's date
    // even though its number never moved.
    vi.setSystemTime(new Date('2026-09-14T19:37:17-05:00'))
    await pressApply()
    const secondFrame = lastApplyProvenance()
    expect(secondFrame['axes.X.acceleration']).toEqual(firstFrame['axes.X.acceleration'])
    expect(secondFrame['axes.X.acceleration']?.source).toContain('9/11/2026')
    expect(secondFrame['axes.X.acceleration']?.source).not.toContain('9/14/2026')

    // Apply 3 - Y acceleration changes to 900. Y gets today's stamp; X keeps
    // its 09-11 one, in the very same outgoing frame.
    setNumber('Y acceleration (units per second squared)', 900)
    await pressApply()
    const thirdFrame = lastApplyProvenance()
    expect(thirdFrame['axes.X.acceleration']).toEqual(firstFrame['axes.X.acceleration'])
    expect(thirdFrame['axes.Y.acceleration']?.kind).toBe('liencam-ui')
    expect(thirdFrame['axes.Y.acceleration']?.source).toContain('9/14/2026')
    expect(thirdFrame['axes.Y.acceleration']?.source).not.toEqual(thirdFrame['axes.X.acceleration']?.source)
    // Apply 3 is also a stamping apply (Y just moved) - same two surfaces.
    expect(authorityState()).toBe('applied')
    expect(applyButtonState()).toBe('applied')
  })

  // Review FAIL (2026-09-15): an apply that declares nothing (every drifted
  // key lands back on its profile seed) skipped the persist step entirely,
  // so `liencamLastAppliedDriftValues` stayed at whatever the LAST stamping
  // apply sent - stale the moment this "nothing changed" apply actually put a
  // DIFFERENT number on the wire. A later apply that returned to that old
  // number then read as "already declared" against the stale record and
  // restated the wrong stamp.
  it('stamps a fresh source when a value returns to one it held before a '
    + 'revert to the profile seed', async () => {
    seedLibraryAndProject(shopRouter())
    await connectBridge()
    render(createElement(MachineDefinitionPanel))

    // Apply 1, 2026-09-11 20:10 - X acceleration set to 1000, stamped 9/11.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T20:10:00-05:00'))
    setNumber('X acceleration (units per second squared)', 1000)
    await pressApply()
    const firstFrame = lastApplyProvenance()
    expect(firstFrame['axes.X.acceleration']?.source).toContain('9/11/2026')

    // Apply 2, 2026-09-12 - X set back to the profile seed (Operator's real
    // LienCNC V2 .pro states X acceleration 500). This apply declares nothing
    // (X no longer differs from the seed), but it DID just put 500 on the
    // wire - the last-applied record must move to match.
    vi.setSystemTime(new Date('2026-09-12T09:00:00-05:00'))
    setNumber('X acceleration (units per second squared)', 500)
    await pressApply()
    const secondFrame = lastApplyProvenance()
    expect(secondFrame['axes.X.acceleration']).toBeUndefined()

    // Apply 3, 2026-09-14 - X set to 1000 again. This is a NEW edit (500 ->
    // 1000, not a no-op), so it must get TODAY's stamp, not the stale 9/11
    // one restated from before the revert.
    vi.setSystemTime(new Date('2026-09-14T19:37:17-05:00'))
    setNumber('X acceleration (units per second squared)', 1000)
    await pressApply()
    const thirdFrame = lastApplyProvenance()
    expect(thirdFrame['axes.X.acceleration']?.kind).toBe('liencam-ui')
    expect(thirdFrame['axes.X.acceleration']?.source).toContain('9/14/2026')
    expect(thirdFrame['axes.X.acceleration']?.source).not.toContain('9/11/2026')
  })

  // WO-1657 acceptance: the recorded 2026-09-17 cache
  // (`liencam-bridge.definition.json`, savedUtc 2026-09-15T00:37:17Z, md5
  // 9D453210) as the fixture - five keys, all "liencam-ui | LienCNC V2 -
  // LienCAM definition editor - 9/14/2026, 7:37:17 PM": X/Y/Z/A acceleration
  // 1000, Z soft limit minimum 0. A no-change Apply against it must not move
  // any of the five; changing only X must move only X's.
  it('WO-1657: a no-change Apply against the recorded 2026-09-17 cache keeps all five stamps', async () => {
    seedLibraryAndProject(shopRouter())
    await connectBridge()
    render(createElement(MachineDefinitionPanel))

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T19:37:17-05:00'))
    setNumber('X acceleration (units per second squared)', 1000)
    setNumber('Y acceleration (units per second squared)', 1000)
    setNumber('Z acceleration (units per second squared)', 1000)
    setNumber('A acceleration (units per second squared)', 1000)
    setNumber('Z soft limit minimum', 0)
    await pressApply()
    const established = lastApplyProvenance()
    for (const key of [
      'axes.X.acceleration', 'axes.Y.acceleration', 'axes.Z.acceleration',
      'axes.A.acceleration', 'axes.Z.softLimitMin',
    ]) {
      expect(established[key]?.source).toContain('9/14/2026')
    }

    // The no-change Apply, at the board's own moment: 2026-09-17, 6:53:53 PM.
    vi.setSystemTime(new Date('2026-09-17T18:53:53-05:00'))
    await pressApply()
    const noChange = lastApplyProvenance()
    for (const key of [
      'axes.X.acceleration', 'axes.Y.acceleration', 'axes.Z.acceleration',
      'axes.A.acceleration', 'axes.Z.softLimitMin',
    ]) {
      expect(noChange[key]).toEqual(established[key])
      expect(noChange[key]?.source).toContain('9/14/2026')
      expect(noChange[key]?.source).not.toContain('9/17/2026')
    }

    // Change acceleration on X only -> only X's stamp moves.
    vi.setSystemTime(new Date('2026-09-18T10:00:00-05:00'))
    setNumber('X acceleration (units per second squared)', 1100)
    await pressApply()
    const xOnly = lastApplyProvenance()
    expect(xOnly['axes.X.acceleration']?.source).toContain('9/18/2026')
    for (const key of ['axes.Y.acceleration', 'axes.Z.acceleration', 'axes.A.acceleration', 'axes.Z.softLimitMin']) {
      expect(xOnly[key]).toEqual(established[key])
    }
  })
})
