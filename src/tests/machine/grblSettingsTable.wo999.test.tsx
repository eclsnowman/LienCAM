// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineController } from '../../lib/machine/controller'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'
import { createDefaultControllerDefinition } from '../../types'

const memory = new Map<string, string>()
const localStorageShim: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageShim,
  configurable: true,
})

const machineSession = await import('../../lib/machine/machineSession')
const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { useCamStore } = await import('../../store')
const { axisSoftLimitStatementKey } = await import('../../lib/machine/resolvedMachineMotion')
const { useMachineControl } = await import('../../store/machineControlStore')
const originalProject = useCamStore.getState().project

function fakeController(overrides: Partial<MachineController> = {}): MachineController {
  return {
    capabilities: { gcodeText: true },
    sendCommandAwait: vi.fn(() => Promise.resolve({ ok: true, message: null })),
    querySettings: vi.fn(() => true),
    ...overrides,
  } as unknown as MachineController
}

function openSettings(): void {
  render(<SettingsModal />)
  act(() => useCamStore.getState().openModal('settings'))
}

function editSetting(key: number, value: string): void {
  const input = screen.getByLabelText(`Edit GRBL setting $${key}`)
  fireEvent.change(input, { target: { value } })
  fireEvent.click(screen.getByTestId(`settings-grbl-row-${key}`).querySelector('button')!)
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().closeModal()
  // WO-1113 contract row: grblSettings exists only for a declared GRBL machine;
  // a live serial connection controls enablement, not surface existence.
  useCamStore.setState({
    project: {
      ...originalProject,
      machine: { ...originalProject.machine, controller: 'grbl' },
    },
  })
  useMachineControl.setState({
    connectionKind: 'serial',
    settings: { 10: '3', 130: '500.000' },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useCamStore.getState().closeModal()
  useCamStore.setState({ project: originalProject })
  useMachineControl.setState({ connectionKind: null, settings: {} })
})

describe('WO-999 write, then re-read proof', () => {
  it('resolves the production waiter only through the serial onSetting readback', async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const commands: string[] = []
    let events: TransportEvents | null = null
    let settingsQueries = 0
    let closed = false
    const emit = (line: string): void => {
      events?.onChunk(encoder.encode(`${line}\r\n`))
    }
    const transport: MachineTransport = {
      start: async (nextEvents) => {
        events = nextEvents
        emit("Grbl 1.1h ['$' for help]")
      },
      write: async (data) => {
        if (data.length === 1) {
          if (data[0] === 0x3f) emit('<Idle|MPos:0.000,0.000,0.000|FS:0,0>')
          return
        }
        const command = decoder.decode(data).trim()
        commands.push(command)
        if (command === '$$') {
          settingsQueries++
          emit(`$130=${settingsQueries === 1 ? '500.000' : '599.875'}`)
        }
        emit('ok')
      },
      close: async () => {
        if (closed) return
        closed = true
        events?.onClose(null)
      },
    }
    const controller = machineSession.getMachineController()

    try {
      await controller.connect({ kind: 'bytes', transport })
      commands.length = 0

      const result = await machineSession.writeGrblSettingAndReadBack(130, '600.000', {
        controller,
      })

      expect(commands).toEqual(['$130=600.000', '$$'])
      expect(result).toEqual({ ok: true, key: 130, value: '599.875' })
      expect(useMachineControl.getState().settings[130]).toBe('599.875')
    } finally {
      await controller.disconnect()
    }
  })

  it('returns the value read back from $$, never the attempted value', async () => {
    const order: string[] = []
    const controller = fakeController({
      sendCommandAwait: vi.fn((command) => {
        order.push(`write ${command}`)
        return Promise.resolve({ ok: true, message: null })
      }),
      querySettings: vi.fn(() => {
        order.push('query $$')
        return true
      }),
    })

    const result = await machineSession.writeGrblSettingAndReadBack(130, '600.000', {
      controller,
      waitForReadback: async (key, querySettings) => {
        expect(key).toBe(130)
        expect(querySettings()).toBe(true)
        order.push('read $130=599.875')
        return '599.875'
      },
    })

    expect(order).toEqual(['write $130=600.000', 'query $$', 'read $130=599.875'])
    expect(result).toEqual({ ok: true, key: 130, value: '599.875' })
  })

  it('does not ask for $$ when the write is refused', async () => {
    const controller = fakeController({
      sendCommandAwait: vi.fn(() => Promise.resolve({
        ok: false,
        message: 'error: Invalid statement',
      })),
    })
    const waitForReadback = vi.fn()

    const result = await machineSession.writeGrblSettingAndReadBack(10, '4', {
      controller,
      waitForReadback,
    })

    expect(result).toEqual({ ok: false, reason: 'error: Invalid statement' })
    expect(waitForReadback).not.toHaveBeenCalled()
    expect(controller.querySettings).not.toHaveBeenCalled()
  })
})

describe('WO-999 rendered table', () => {
  it('renders every reported raw value, omits unsent keys, and labels ownership', () => {
    openSettings()

    expect(screen.getByTestId('settings-grbl-reported-10').textContent).toBe('3')
    expect(screen.getByTestId('settings-grbl-reported-130').textContent).toBe('500.000')
    expect(screen.queryByTestId('settings-grbl-row-11')).toBeNull()
    expect(screen.getAllByText('GRBL controller')).toHaveLength(2)

    const software = screen.getByTestId('settings-software-capabilities-table')
    expect(software.textContent).toContain('Homing order / back-off')
    expect(software.textContent).toContain('Probing routines')
    expect(software.textContent).toContain('Coolant / vacuum M-code relays')
    expect(software.textContent).toContain('Per-axis soft limits')
    expect(software.textContent).toContain('Spindle ramps')
    expect(software.textContent).toContain('LienCAM software')
  })

  it('never renders definition defaults as machine-stated capability values', () => {
    const definition = createDefaultControllerDefinition()
    const machine = {
      ...originalProject.machine,
      id: 'wo999-hand-built-grbl',
      name: 'Hand-built GRBL',
      controller: 'grbl' as const,
      controllerDefinition: definition,
    }
    act(() => useCamStore.setState({
      project: { ...originalProject, machine },
    }))
    openSettings()

    const homing = screen.getByText('Homing order / back-off').closest('tr')!
    const limits = screen.getByText('Per-axis soft limits').closest('tr')!
    expect(homing.textContent).toContain(
      'back-off Z not stated, X not stated, Y not stated',
    )
    expect(limits.textContent).toContain(
      'X not stated..not stated, Y not stated..not stated, Z not stated..not stated',
    )
    expect(homing.textContent).not.toContain('Z 2')
    expect(limits.textContent).not.toContain('X 0..0')

    // WO-1642: UCCNC's key names are NOT this GRBL machine's words. Stating
    // them on a GRBL machine states nothing.
    const uccncWords = {
      ...definition,
      stated: [
        { controller: 'uccnc' as const, key: 'axessettingscontrolX.Homebackoff' },
        { controller: 'uccnc' as const, key: 'axessettingscontrolX.Softlimitnegative' },
        { controller: 'uccnc' as const, key: 'axessettingscontrolX.Softlimitpositive' },
      ],
    }
    act(() => useCamStore.setState({
      project: {
        ...originalProject,
        machine: { ...machine, controllerDefinition: uccncWords },
      },
    }))
    expect(homing.textContent).not.toContain('X 2')
    expect(limits.textContent).not.toContain('X 0..0')

    // Stated in its own vocabulary - the app's controller-neutral soft-limit
    // statements for X and GRBL's own $27 pull-off - the values appear.
    const statedDefinition = {
      ...definition,
      stated: [
        { controller: 'grbl' as const, key: axisSoftLimitStatementKey('X', 'min') },
        { controller: 'grbl' as const, key: axisSoftLimitStatementKey('X', 'max') },
      ],
    }
    act(() => useCamStore.setState({
      project: {
        ...originalProject,
        machine: { ...machine, controllerDefinition: statedDefinition, grblSettings: { 27: '2' } },
      },
    }))

    expect(homing.textContent).toContain('X 2')
    expect(limits.textContent).toContain('X 0..0')
    expect(limits.textContent).toContain('Y not stated..not stated')
  })

  it('shows the controller readback after an accepted edit', async () => {
    vi.spyOn(machineSession, 'writeGrblSettingAndReadBack')
      .mockImplementation(async (key, attempted) => {
        expect([key, attempted]).toEqual([130, '600.000'])
        act(() => useMachineControl.getState().applySetting(130, '599.875'))
        return { ok: true, key, value: '599.875' }
      })
    openSettings()

    editSetting(130, '600.000')

    await waitFor(() => {
      expect(screen.getByTestId('settings-grbl-reported-130').textContent).toBe('599.875')
      expect(screen.getByTestId('settings-grbl-status').textContent)
        .toBe('Controller read back $130=599.875.')
    })
    expect((screen.getByLabelText('Edit GRBL setting $130') as HTMLInputElement).value)
      .toBe('599.875')
  })

  it('keeps the reported value unchanged and says so after a refusal', async () => {
    vi.spyOn(machineSession, 'writeGrblSettingAndReadBack')
      .mockResolvedValue({ ok: false, reason: 'error: Invalid statement' })
    openSettings()

    editSetting(10, '999')

    await waitFor(() => {
      expect(screen.getByTestId('settings-grbl-status').textContent)
        .toBe('Refused: error: Invalid statement')
    })
    expect(screen.getByTestId('settings-grbl-reported-10').textContent).toBe('3')
    expect((screen.getByLabelText('Edit GRBL setting $10') as HTMLInputElement).value).toBe('3')
    expect(useMachineControl.getState().settings[10]).toBe('3')
  })
})
