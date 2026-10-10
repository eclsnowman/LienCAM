import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeHelloPush,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import { typedMock } from '../support/typedMock'

type DefinitionHelloFields = Pick<
  BridgeHelloPush['v'],
  'definitionSource' | 'definitionDrift'
>
type UccncController = import('../../lib/machine/uccncController').UccncController

const bridgeFixture = vi.hoisted(() => ({
  fields: {} as DefinitionHelloFields,
  events: null as BridgeTransportEvents | null,
}))

const BRIDGE_CAPABILITIES: BridgeHelloPush['v']['capabilities'] = {
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
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }

    async start(events: BridgeTransportEvents): Promise<void> {
      bridgeFixture.events = events
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'liencam-uccnc-bridge/WO-1072',
          capabilities: BRIDGE_CAPABILITIES,
          readOnly: false,
          ...bridgeFixture.fields,
        },
      })
    }

    send(_message: BridgeCallMessage): void {}

    async close(): Promise<void> {
      bridgeFixture.events = null
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const {
  readBridgeDefinitionDrift,
  readBridgeDefinitionSource,
} = await import('../../lib/machine/bridgeTransport')
const session = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

const EVIDENCE = resolve(__dirname, '../evidence/WO-1048')

function evidenceHello(file: string): DefinitionHelloFields {
  const raw = JSON.parse(readFileSync(resolve(EVIDENCE, file), 'utf8')) as Record<string, unknown>
  const definitionSource = readBridgeDefinitionSource(raw.definitionSource)
  const definitionDrift = readBridgeDefinitionDrift(raw.definitionDrift)
  if (definitionSource === undefined || definitionDrift === undefined) {
    throw new Error(`${file} is not a WO-1048 definition report`)
  }
  return { definitionSource, definitionDrift }
}

const CONTAMINATED = evidenceHello('hello-A-contaminated.hello.json')
const AGREES = evidenceHello('hello-E-agrees.hello.json')

function reportLines() {
  return useMachineControl.getState().consoleLines.filter((line) =>
    line.text.startsWith('Bridge start-up check:')
      || line.text.startsWith('This bridge did not check')
      || line.text.startsWith('  '),
  )
}

async function connectBridge(fields: DefinitionHelloFields): Promise<void> {
  bridgeFixture.fields = fields
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  await session.connectMachine('bridge')
}

beforeEach(() => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  useMachineControl.setState({ consoleLines: [] })
  bridgeFixture.fields = {}
  bridgeFixture.events = null
})

afterEach(async () => {
  await session.disconnectMachine()
  vi.useRealTimers()
})

describe('WO-1072: bridge cache/profile reconciliation reaches the machine console', () => {
  it('reports the real contaminated hello with one warning per refused key', async () => {
    await connectBridge(CONTAMINATED)

    expect((session.getMachineController() as UccncController).bridgeHello()).toMatchObject({
      definitionSource: 'cache',
      definitionDrift: CONTAMINATED.definitionDrift,
    })
    expect(reportLines().map(({ dir, text, severity }) => ({ dir, text, severity }))).toEqual([
      {
        dir: 'rx',
        severity: 'warn',
        text: "Bridge start-up check: 3 cached settings differ from the profile - 0 kept, 3 sent back to the profile's value.",
      },
      {
        dir: 'rx',
        severity: 'warn',
        text: '  X acceleration: cache 3000, profile 500 - refused, no one accounts for it',
      },
      {
        dir: 'rx',
        severity: 'warn',
        text: '  B homing back-off: cache 2, profile 0 - refused, no one accounts for it',
      },
      {
        dir: 'rx',
        severity: 'warn',
        text: '  C homing back-off: cache 2, profile 0 - refused, no one accounts for it',
      },
    ])

    bridgeFixture.events?.onMessage({
      t: 'phase',
      v: { phase: 'connected', version: 'liencam-uccnc-bridge/WO-1072' },
    })
    expect(reportLines()).toHaveLength(4)
  })

  it('marks an accountable kept value as info and names its provenance', async () => {
    await connectBridge({
      definitionSource: 'cache',
      definitionDrift: [{
        key: 'axes.X.acceleration',
        cache: '1000',
        profile: '500',
        kind: 'operator',
        source: 'Operator, 2026-08-26 ladder',
        kept: true,
      }],
    })

    expect(reportLines().map(({ text, severity }) => ({ text, severity }))).toEqual([
      {
        severity: 'warn',
        text: "Bridge start-up check: 1 cached settings differ from the profile - 1 kept, 0 sent back to the profile's value.",
      },
      {
        severity: 'info',
        text: '  X acceleration: cache 1000, profile 500 - kept (operator: Operator, 2026-08-26 ladder)',
      },
    ])
  })

  it('reports the real empty drift fixture as checked agreement', async () => {
    await connectBridge(AGREES)

    expect(reportLines().map(({ text, severity }) => ({ text, severity }))).toEqual([{
      severity: 'info',
      text: 'Bridge start-up check: cached settings agree with the profile on every key.',
    }])
  })

  it('warns when an older bridge omits the drift field', async () => {
    await connectBridge({})

    expect(reportLines().map(({ text, severity }) => ({ text, severity }))).toEqual([{
      severity: 'warn',
      text: "This bridge did not check its cached settings against the profile (older build) - values on the board may not be the profile's.",
    }])
  })

  it('emits no cache/profile report for a simulator connection', async () => {
    await session.connectMachine('simulator')

    expect(reportLines()).toEqual([])
  })
})
