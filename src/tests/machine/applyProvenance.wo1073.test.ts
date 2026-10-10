// @vitest-environment jsdom
// WO-1073 - the app, not the bridge, declares who changed each cached value.
//
// The bridge keeps a cached/profile disagreement only when the apply frame
// accounts for that exact drift key. These tests pin all three seams together:
// the keys are derived from Machine.cs, the app emits only changed keys, and
// the UCCNC backend carries that map verbatim on the real call frame.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeApplyDefinitionReply,
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type {
  ControllerCapabilities,
  ControllerEvents,
  MachineDefinitionProvenance,
} from '../../lib/machine/controller'
import {
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'
import { importUccncProfile } from '../../lib/machine/uccncProfileImport'
import type { ControllerDefinition, MachineConfig } from '../../types'
import { typedMock } from '../support/typedMock'

const panelApply = vi.hoisted(() => ({
  provenance: [] as MachineDefinitionProvenance[],
}))

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, value) },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: memoryStorage,
  configurable: true,
})

// The panel test stops at the existing hardware boundary and records what it
// passes there. The direct UccncController tests below still inspect the real
// wire frame, so neither half is replaced by a duplicate implementation.
vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    applyActiveMachineDefinition: async (
      provenance: Parameters<typeof actual.applyActiveMachineDefinition>[0] = {},
    ) => {
      panelApply.provenance.push(provenance)
      const sent = actual.activeMachineDefinition()
      return {
        ok: true,
        sent,
        refusal: null,
        result: {
          ok: true,
          error: null,
          configuredThisSession: true,
          reHome: [],
          lines: [],
        },
      }
    },
  })
})

const {
  machineDefinitionApplyProvenance,
  machineDefinitionDriftKeys,
  withMachineDefinitionProfileBaseline,
} = await import('../../lib/machine/machineSession')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { useCamStore } = await import('../../store')

const MACHINE_CS = readFileSync(
  resolve(process.cwd(), 'pendant/uccnc-bridge/Machine.cs'),
  'utf8',
)
const PROFILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'),
  'utf8',
)

const CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []

  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(message: BridgeCallMessage): void { this.sent.push(message) }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
  lastApply(): BridgeCallMessage {
    const call = this.sent.filter((message) => message.m === 'applyMachineDefinition').at(-1)
    if (!call) throw new Error('no applyMachineDefinition call was sent')
    return call
  }
}

async function connected(): Promise<{ controller: UccncController; transport: FakeTransport }> {
  const events: ControllerEvents = {}
  const controller = new UccncController(events)
  const transport = new FakeTransport()
  const pending = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'wo1073-fake-bridge',
      capabilities: CAPS,
      readOnly: false,
    },
  })
  await pending
  return { controller, transport }
}

function replyToApply(transport: FakeTransport, call: BridgeCallMessage): void {
  const value: BridgeApplyDefinitionReply = {
    ok: true,
    error: null,
    configuredThisSession: true,
    reHome: [],
    lines: [],
  }
  transport.emit({ t: 'reply', seq: call.seq, ok: true, v: value })
}

function clone(definition: ControllerDefinition): ControllerDefinition {
  return JSON.parse(JSON.stringify(definition)) as ControllerDefinition
}

function cloneMachine(machine: MachineConfig): MachineConfig {
  return JSON.parse(JSON.stringify(machine)) as MachineConfig
}

function profileDefinition(): ControllerDefinition {
  const imported = importUccncProfile(PROFILE)
  if (!imported.definition) throw new Error("Operator's profile did not import")
  return imported.definition
}

function machineWith(definition: ControllerDefinition): MachineConfig {
  return {
    id: 'wo1073-machine',
    name: 'LienCNC V2',
    type: 'gantry_router',
    controller: 'uccnc',
    travel: { x: 738, y: 724.5, z: 128.9 },
    rapidRate: 6000,
    maxSpindleRpm: 24000,
    minSpindleRpm: 8000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
    controllerDefinition: definition,
  }
}

function seedPanel(machine: MachineConfig): void {
  const projectMachine = cloneMachine(machine)
  act(() => {
    useCamStore.setState((state) => ({
      machineLibrary: [machine],
      project: { ...state.project, machine: projectMachine },
      consoleEvents: [],
    }))
  })
}

function setNumber(label: string, value: number): void {
  // WO-1690: the axis table moved off Legacy onto the outer Machine tab.
  const machineTab = screen.queryByTestId('machine-def-tab-machine')
  if (machineTab) act(() => { fireEvent.click(machineTab) })
  const field = screen.getByLabelText(label)
  act(() => { fireEvent.change(field, { target: { value: String(value) } }) })
  act(() => { fireEvent.blur(field) })
}

async function pressApply(): Promise<void> {
  const count = panelApply.provenance.length
  act(() => { fireEvent.click(screen.getByTestId('machine-def-bar-apply')) })
  await waitFor(() => { expect(panelApply.provenance.length).toBe(count + 1) })
  await waitFor(() => {
    expect(screen.getByTestId('machine-def-bar-apply').getAttribute('data-apply-state'))
      .toBe('applied')
  })
}

beforeEach(() => { panelApply.provenance.length = 0 })
afterEach(() => { cleanup() })

/** Lift the vocabulary from the calls that actually perform WO-1048's drift
 * checks. Axis keys are constructed as `k + suffix` in C#; IO keys are literal. */
function bridgeDriftKeys(definition: ControllerDefinition): string[] {
  const axisSuffixes = [
    ...MACHINE_CS.matchAll(
      /Check(?:Num|Bool|Slave|Pin)\(\s*parsedCache,\s*k \+ "([^"]+)"/g,
    ),
    ...MACHINE_CS.matchAll(
      /RecordDrift\(\s*parsedCache,\s*k \+ "([^"]+)"/g,
    ),
  ].map((match) => match[1])
  const ioKeys = [...MACHINE_CS.matchAll(
    /CheckPin\(\s*parsedCache,\s*"(io\.[^"]+)"/g,
  )].map((match) => match[1])

  const keys = definition.axes.flatMap((axis) => axisSuffixes
    .filter((suffix) => !suffix.startsWith('homing.') || definition.homing.perAxis[axis.axis])
    .map((suffix) => `axes.${axis.axis}.${suffix}`))
  return [...keys, ...ioKeys]
}

describe('WO-1073 apply provenance', () => {
  it('uses exactly the drift keys lifted from Machine.cs', () => {
    const definition = profileDefinition()
    expect(machineDefinitionDriftKeys(definition).sort())
      .toEqual(bridgeDriftKeys(definition).sort())
  })

  it('puts exactly one edited key on the apply frame and declares the UI source', async () => {
    const profile = profileDefinition()
    const edited = clone(profile)
    const x = edited.axes.find((axis) => axis.axis === 'X')!
    x.acceleration += 500
    const at = new Date('2026-08-27T20:31:45-05:00')
    const provenance = machineDefinitionApplyProvenance(profile, edited, 'LienCNC V2', at)

    expect(provenance).toEqual({
      'axes.X.acceleration': {
        kind: 'liencam-ui',
        source: `LienCNC V2 - LienCAM definition editor - ${at.toLocaleString()}`,
      },
    })
    expect(provenance).not.toHaveProperty('axes.X.stepsPerUnit')

    const { controller, transport } = await connected()
    const pending = controller.applyMachineDefinition(edited, provenance)
    const call = transport.lastApply()
    replyToApply(transport, call)
    await pending

    expect(call.a).toEqual({ definition: edited, provenance })
  })

  it('drops authorship when the edit is reverted to the profile value', async () => {
    const profile = profileDefinition()
    const reverted = clone(profile)
    const original = profile.axes.find((axis) => axis.axis === 'X')!.acceleration
    const x = reverted.axes.find((axis) => axis.axis === 'X')!
    x.acceleration = original + 500
    x.acceleration = original
    const provenance = machineDefinitionApplyProvenance(profile, reverted, 'LienCNC V2')

    expect(provenance).toEqual({})

    const { controller, transport } = await connected()
    const pending = controller.applyMachineDefinition(reverted, provenance)
    const call = transport.lastApply()
    replyToApply(transport, call)
    await pending

    expect(call.a).toEqual({ definition: reverted, provenance: {} })
  })

  it('the panel keeps the profile baseline through Save, reload, and a clean second Apply', async () => {
    const profile = profileDefinition()
    const original = profile.axes.find((axis) => axis.axis === 'X')!.acceleration
    seedPanel(machineWith(profile))
    render(createElement(MachineDefinitionPanel))

    setNumber('X acceleration (units per second squared)', original + 500)
    await pressApply()
    expect(Object.keys(panelApply.provenance[0])).toEqual(['axes.X.acceleration'])
    expect(panelApply.provenance[0]['axes.X.acceleration'].kind).toBe('liencam-ui')

    const saved = cloneMachine(useCamStore.getState().machineLibrary[0])
    cleanup()
    seedPanel(saved)
    render(createElement(MachineDefinitionPanel))

    await pressApply()
    expect(Object.keys(panelApply.provenance[1])).toEqual(['axes.X.acceleration'])
    expect(panelApply.provenance[1]['axes.X.acceleration'].kind).toBe('liencam-ui')

    setNumber('X acceleration (units per second squared)', original)
    await pressApply()
    expect(panelApply.provenance[2]).toEqual({})
  })

  it('declares a sent homing block that the profile baseline did not contain', () => {
    const profile = profileDefinition()
    const sent = clone(profile)
    delete profile.homing.perAxis.A
    sent.homing.perAxis.A = {
      direction: 'negative',
      fastSpeed: 1000,
      slowSpeed: 100,
      backOff: 2,
      homingValue: 0,
      autoZero: true,
    }
    const saved = withMachineDefinitionProfileBaseline(profile, sent)
    const provenance = machineDefinitionApplyProvenance(saved, saved, 'LienCNC V2')

    expect(Object.keys(provenance).sort()).toEqual([
      'axes.A.homing.backOff',
      'axes.A.homing.direction',
      'axes.A.homing.fastSpeed',
      'axes.A.homing.homingValue',
      'axes.A.homing.slowSpeed',
    ])
  })
})
