// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { UccncTransport } from '../../lib/machine/uccncController'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => [...mem.keys()][index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const {
  machineSerialBaud,
  persistMerge,
  persistPartialize,
  useCamStore,
} = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { SUPPORTED_BRIDGE_PROTOCOL, UccncController } = await import('../../lib/machine/uccncController')

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

class FakeBridge implements UccncTransport {
  events: BridgeTransportEvents | null = null
  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(_message: BridgeCallMessage): void {}
  async close(): Promise<void> {}
  push(message: BridgeMessage): void { this.events?.onMessage(message) }
}

function controllerEvents(): ControllerEvents {
  return {
    onStatus: () => {},
    onConsole: () => {},
    onJobEvent: () => {},
    onHomed: () => {},
    onAlarm: () => {},
  }
}

async function publishFakeHello(): Promise<void> {
  const transport = new FakeBridge()
  const controller = new UccncController(controllerEvents())
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.push({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'fake-bridge/WO-998',
      capabilities: NO_CAPS,
      readOnly: false,
      uccnc: {
        installRoot: 'C:\\UCCNC',
        profile: 'C:\\UCCNC\\Profiles\\LienCNC.pro',
        uc100Dll: 'C:\\UCCNC\\API\\DLL\\UC100.dll',
        ftd2xxDll: 'C:\\UCCNC\\ftd2xx64.dll',
        profiles: ['C:\\UCCNC\\Profiles\\LienCNC.pro'],
        board: 7,
      },
    },
  } as BridgeMessage)
  await connecting
  useMachineControl.getState().setBridgeHello(controller.bridgeHello())
}

beforeEach(() => {
  mem.clear()
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam', activeModal: null })
  useUiPrefs.setState({ machineLinks: {} })
  useMachineControl.getState().setConnection('disconnected', null)
  useMachineControl.getState().setBridgeHello(null)
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
  })
})

afterEach(() => cleanup())

describe('WO-998 controller setup bodies', () => {
  it('renders the real parsed bridge hello and leaves every unsent value unset', async () => {
    await publishFakeHello()
    render(<MachineDefinitionPanel connectionKind="bridge" />)

    expect(screen.getByTestId('machine-controller-setup').getAttribute('data-connection-kind')).toBe('bridge')
    expect(screen.getByTestId('machine-controller-uccnc-install').textContent).toContain('C:\\UCCNC')
    const profile = screen.getByTestId('machine-controller-uccnc-profile')
    expect(profile.textContent).toContain('Seeded from: C:\\UCCNC\\Profiles\\LienCNC.pro')
    expect(profile.textContent).toContain("The bridge's .pro file seeds this machine once. This stored copy is the authority after that.")
    expect(profile.textContent).not.toContain('Running now:')
    expect(screen.getByTestId('machine-controller-uccnc-board').textContent).toContain('7')
    expect(screen.getByTestId('machine-controller-uccnc-uc100-dll').textContent).toContain('UC100.dll')
    expect(screen.getByTestId('machine-controller-uccnc-ftd2xx-dll').textContent).toContain('ftd2xx64.dll')
    expect(screen.getByTestId('machine-controller-uccnc-install').textContent).toContain('Running now:')
    expect(screen.getByTestId('machine-controller-uccnc-board').textContent).toContain('Running now:')

    // A bridge that reports no install details leaves NOTHING running to name,
    // so the "Running now" line goes away rather than saying "unset" under
    // every field (architect, 2026-09-03: it is only shown when the bridge is
    // using something different from what the field holds).
    useMachineControl.getState().setBridgeHello({ readOnly: false, vfd: null, uccnc: undefined })
    await waitFor(() => expect(screen.getByTestId('machine-controller-uccnc-install').textContent)
      .not.toContain('Running now'))
    expect(screen.getByTestId('machine-controller-uccnc-board').textContent).not.toContain('Running now')
    expect(screen.getByTestId('machine-controller-uccnc-install-input')).toBeTruthy()
  })

  it('keeps a remembered spindle port available without showing it as bridge-reported', () => {
    const machineId = useCamStore.getState().project.machine.id
    useUiPrefs.getState().setMachineVfdPort(machineId, 'COM7')
    render(<MachineDefinitionPanel connectionKind="bridge" />)

    const spindlePort = screen.getByTestId('machine-controller-vfd-port') as HTMLSelectElement
    expect(spindlePort.value).toBe('')
    expect(spindlePort.selectedOptions[0]?.textContent).toBe('unset')
    expect([...spindlePort.options].some((option) => option.value === 'COM7')).toBe(true)
  })

  it('shows serial setup, persists baud per machine, and keeps it outside profile export JSON', () => {
    const machineId = useCamStore.getState().project.machine.id
    useUiPrefs.getState().setMachineBridgePort(machineId, 9123)
    useUiPrefs.getState().setMachineVfdPort(machineId, 'COM7')
    render(<MachineDefinitionPanel connectionKind="serial" />)

    expect(screen.getByTestId('machine-controller-serial-port').textContent)
      .toContain('Chosen in the browser when Connect is pressed')
    fireEvent.change(screen.getByTestId('machine-controller-serial-baud'), {
      target: { value: '250000' },
    })
    expect(machineSerialBaud(useCamStore.getState().appSettings, machineId)).toBe(250000)

    const written = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
    const reloaded = persistMerge(written, useCamStore.getState())
    expect(machineSerialBaud(reloaded.appSettings, machineId)).toBe(250000)

    const exportedProfile = JSON.stringify(useCamStore.getState().project.machine)
    expect(exportedProfile).not.toContain('COM7')
    expect(exportedProfile).not.toContain('9123')
    expect(exportedProfile).not.toContain('250000')
    expect(exportedProfile).not.toContain('C:\\UCCNC')
    expect(exportedProfile).not.toContain('"board":7')
  })

  it('keeps the moved baud selector locked during a live session or connection action', () => {
    const view = render(<MachineDefinitionPanel connectionKind="serial" connectionBusy />)
    const baud = screen.getByTestId('machine-controller-serial-baud') as HTMLSelectElement
    expect(baud.disabled).toBe(true)

    act(() => { useMachineControl.getState().setConnection('connected', 'test GRBL session') })
    view.rerender(<MachineDefinitionPanel connectionKind="serial" />)
    expect(baud.disabled).toBe(true)
  })

  it('says the simulator has nothing to configure instead of showing an empty frame', () => {
    render(<MachineDefinitionPanel connectionKind="simulator" />)
    expect(screen.getByTestId('machine-controller-setup-simulator').textContent)
      .toContain('nothing to configure')
    expect(screen.queryByTestId('machine-controller-setup-bridge')).toBeNull()
    expect(screen.queryByTestId('machine-controller-setup-serial')).toBeNull()
  })
})

describe('WO-998 zero-row door', () => {
  it('opens Machine Definitions at the highlighted setup group and removes baud from the Control rail', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('mode-tab-control'))
    await screen.findByTestId('control-page', {}, { timeout: 10000 })

    let gear = screen.getByTestId('control-controller-setup')
    expect(gear.closest('.panel-header')).toBeTruthy()
    expect(gear.parentElement?.querySelector('[data-testid="control-machine-toggle"]')).toBeTruthy()
    expect(screen.queryByTestId('control-baud')).toBeNull()

    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    expect(screen.getByTestId('control-machine-collapsed-values')).toBeTruthy()
    expect(screen.queryByTestId('control-controller-setup')).toBeNull()

    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    gear = screen.getByTestId('control-controller-setup')
    fireEvent.click(gear)
    const group = await screen.findByTestId('machine-controller-setup')
    expect(screen.getByTestId('control-machine-tab-definition').getAttribute('aria-selected')).toBe('true')
    expect(group.getAttribute('data-highlighted')).toBe('')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})
