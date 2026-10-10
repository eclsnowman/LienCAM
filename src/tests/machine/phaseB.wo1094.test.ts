import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeApplyDefinitionReply,
  BridgeApplyMachineDefinitionArgs,
  BridgeCallMessage,
  BridgeDefinitionSource,
  BridgeHelloPush,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'
import type { ControllerDefinition } from '../../types'
import { typedMock } from '../support/typedMock'

const bridgeFixture = vi.hoisted(() => ({
  source: 'cache-baseline' as BridgeDefinitionSource,
  events: null as BridgeTransportEvents | null,
}))

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class SessionTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }

    async start(events: BridgeTransportEvents): Promise<void> {
      bridgeFixture.events = events
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'liencam-uccnc-bridge/WO-1094',
          capabilities: CAPABILITIES,
          readOnly: false,
          definitionSource: bridgeFixture.source,
          definitionDrift: [],
        },
      })
    }

    send(_message: BridgeCallMessage): void {}
    async close(): Promise<void> { bridgeFixture.events = null }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: SessionTransport,
  })
})

const { SUPPORTED_BRIDGE_PROTOCOL, UccncController } =
  await import('../../lib/machine/uccncController')
const { importUccncProfile, previewProfileChanges } = await import('../../lib/machine/uccncProfileImport')
const { withControllerSetting } = await import('../../types')
const session = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

const PROFILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'),
  'utf8',
)

class CaptureTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []

  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(message: BridgeCallMessage): void { this.sent.push(message) }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
}

function importedDefinition(): ControllerDefinition {
  const imported = importUccncProfile(PROFILE)
  if (!imported.definition) throw new Error("Operator's profile did not import")
  return imported.definition
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function connectedController(): Promise<{
  controller: InstanceType<typeof UccncController>
  transport: CaptureTransport
}> {
  const events: ControllerEvents = {}
  const controller = new UccncController(events)
  const transport = new CaptureTransport()
  const pending = controller.connect({ kind: 'messages', transport })
  const hello: BridgeHelloPush = {
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'wo1094-capture-bridge',
      capabilities: CAPABILITIES,
      readOnly: false,
      definitionSource: 'cache-baseline',
      definitionDrift: [],
    },
  }
  transport.emit(hello)
  await pending
  return { controller, transport }
}

function replyToApply(transport: CaptureTransport, call: BridgeCallMessage): void {
  const value: BridgeApplyDefinitionReply = {
    ok: true,
    error: null,
    configuredThisSession: true,
    reHome: [],
    lines: [],
  }
  transport.emit({ t: 'reply', seq: call.seq, ok: true, v: value })
}

beforeEach(() => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useMachineControl.setState({ consoleLines: [] })
  bridgeFixture.events = null
})

afterEach(async () => {
  await session.disconnectMachine()
  vi.useRealTimers()
})

describe('WO-1094 Phase B startup authority', () => {
  it.each([
    ['cache-baseline', "Machine configured from this computer's data (the .pro was not opened)."],
    ['profile', 'Machine configured from the .pro, once - the first start under this bridge; apply the definition to make this computer the source.'],
    ['none', 'The bridge holds no definition - nothing configured; apply one.'],
  ] as const)('reports %s once in plain words', async (source, expected) => {
  bridgeFixture.source = source
    await session.connectMachine('bridge')

    expect(useMachineControl.getState().consoleLines.filter(({ text }) => text === expected))
      .toHaveLength(1)

    bridgeFixture.events?.onMessage({
      t: 'phase',
      v: { phase: 'connected', version: 'liencam-uccnc-bridge/WO-1094' },
    })
    expect(useMachineControl.getState().consoleLines.filter(({ text }) => text === expected))
      .toHaveLength(1)
  })

  it('does not guess that a cache-source bridge is old or that it opened the profile', async () => {
    bridgeFixture.source = 'cache'
    await session.connectMachine('bridge')
    expect(useMachineControl.getState().consoleLines.map(({ text }) => text)).toContain(
      'Machine configured from the bridge cache; its start-up source was not distinguished.',
    )
    expect(useMachineControl.getState().consoleLines.map(({ text }) => text).join('\n'))
      .not.toMatch(/older bridge|may also/i)
  })

  it('sends the imported definition settings for all five Phase B groups', async () => {
    const definition = importedDefinition()
    const { controller, transport } = await connectedController()
    const pending = controller.applyMachineDefinition(definition, {})
    const call = transport.sent.find((message) => message.m === 'applyMachineDefinition')
    if (!call) throw new Error('applyMachineDefinition was not sent')
    replyToApply(transport, call)
    await pending

    const args = call.a as BridgeApplyMachineDefinitionArgs
    expect(args.definition).toEqual(definition)
    const keys = new Set((args.definition.settings ?? []).map(({ key }) => key))

    expect([...keys]).toEqual(expect.arrayContaining([
      'Generalsettings.Constantvelocitymode',
      'Generalsettings.Stopatangle',
      'Generalsettings.Linearerror',
      'Generalsettings.Cornerserror',
      'Generalsettings.USBbuffersize',
      'Generalsettings.Softlimitsenable',
      'axessettingscontrolX.Compaccel',
      'axessettingscontrolY.Compaccel',
      'axessettingscontrolZ.Compaccel',
      'axessettingscontrolA.Compaccel',
      'axessettingscontrolB.Compaccel',
      'axessettingscontrolC.Compaccel',
      'FaultSignals.Enable1',
      'FaultSignals.ActiveLow1',
      'FaultSignals.Description1',
    ]))
    expect([...keys].filter((key) => key.startsWith('Workoffset_G'))).toEqual(
      ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'].flatMap((offset) =>
        ['X', 'Y', 'Z'].map((axis) => `Workoffset_${offset}.Workoffset${axis}`)),
    )
  })

  it('names four changed accelerations and a changed fault signal in re-import preview', () => {
    const imported = importUccncProfile(PROFILE)
    if (!imported.definition || !imported.travel) throw new Error("Operator's profile did not import")
    const current = clone(imported.definition)
    for (const axis of ['X', 'Y', 'Z', 'A'] as const) {
      const row = current.axes.find((candidate) => candidate.axis === axis)
      if (!row) throw new Error(`profile has no ${axis} axis`)
      row.acceleration = 1000
    }
    current.settings = withControllerSetting(
      current.settings,
      'uccnc',
      'FaultSignals.Enable1',
      { kind: 'boolean', value: false },
    )

    const preview = previewProfileChanges({
      name: 'LienCNC V2',
      controllerDefinition: current,
      travel: imported.travel,
      unsentSettings: imported.unsent,
    }, {
      ok: true,
      error: null,
      path: 'C:\\UCCNC\\Profiles\\LienCNCV2.pro',
      profileName: 'LienCNCV2',
      board: { type: 'AXBB-E', pinTranslation: true },
      definition: imported.definition,
      travel: imported.travel,
      pins: [],
      unsent: imported.unsent,
      warnings: [],
    })

    // WO-1730: Confirm now writes the app-owned probing.toolSetter fact, so the
    // preview must name its three rows. Operator's profile states FixedProbePos
    // 738/724.5/120; the target record here carries no prior fact, so each row
    // shows the absent value honestly.
    expect(preview.changes.filter(({ changed }) => changed).map((row) => ({
      key: row.key,
      label: row.label,
      before: row.before,
      after: row.after,
    }))).toEqual([
      { key: 'probing.toolSetter.x', label: 'tool setter X machine coordinate', before: 'not in this machine', after: '738' },
      { key: 'probing.toolSetter.y', label: 'tool setter Y machine coordinate', before: 'not in this machine', after: '724.5' },
      { key: 'probing.toolSetter.z', label: 'tool setter Z machine coordinate', before: 'not in this machine', after: '120' },
      { key: 'axis.X.acceleration', label: 'acceleration (units/s2)', before: '1000', after: '500' },
      { key: 'axis.Y.acceleration', label: 'acceleration (units/s2)', before: '1000', after: '500' },
      { key: 'axis.Z.acceleration', label: 'acceleration (units/s2)', before: '1000', after: '500' },
      { key: 'axis.A.acceleration', label: 'acceleration (units/s2)', before: '1000', after: '500' },
      { key: 'FaultSignals.Enable1', label: 'FaultSignals.Enable1', before: 'False', after: 'True' },
    ])
    expect(preview.changedCount).toBe(8)
  })
})
