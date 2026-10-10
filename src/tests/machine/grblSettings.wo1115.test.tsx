// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrblSettingsTable } from '../../components/machine/GrblSettingsTable'
import { MachineDefinitionPanel } from '../../components/machine/MachineDefinitionPanel'
import { machineAxisAccelerations } from '../../components/toolpath/ToolpathFeedEstimatePanel'
import type { MachineController } from '../../lib/machine/controller'
import { resolveMachineMotion } from '../../lib/machine/resolvedMachineMotion'
import {
  applyStoredGrblSettings,
  getMachineController,
  writeGrblSettingAndReadBack,
} from '../../lib/machine/machineSession'
import {
  formatGrblMask,
  formatGrblSetting,
  GRBL_SETTINGS,
  parseGrblSetting,
  recordGrblSettings,
} from '../../lib/machine/grbl/settings'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'
import { adoptMachineDocument, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import type { MachineConfig } from '../../types'
import { createDefaultControllerDefinition, machineRapidRate } from '../../types'

const originalMachine = useCamStore.getState().project.machine
const originalLibrary = useCamStore.getState().machineLibrary
const originalControl = useCamStore.getState().control

function machineWithSettings(settings: Record<number, string>): MachineConfig {
  return { ...originalMachine, id: 'wo1115-grbl', controller: 'grbl', grblSettings: settings }
}

function Harness({ initial }: { initial: MachineConfig }) {
  const [machine, setMachine] = useState(initial)
  return (
    <>
      <GrblSettingsTable machine={machine} onChange={(mut) => setMachine((current) => mut(current))} />
      <output data-testid="stored-settings">{JSON.stringify(machine.grblSettings ?? {})}</output>
      <output data-testid="axis-settings">{JSON.stringify(machine.controllerDefinition?.axes ?? [])}</output>
    </>
  )
}

interface FakeWire {
  transport: MachineTransport
  commands: string[]
  setWriteReply: (reply: 'ok' | 'error:3') => void
}

function fakeGrblWire(readbacks: string[], readbackIds: number[] = []): FakeWire {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const commands: string[] = []
  let events: TransportEvents | null = null
  let read = 0
  let writeReply: 'ok' | 'error:3' = 'ok'
  const emit = (line: string) => events?.onChunk(encoder.encode(`${line}\r\n`))
  return {
    commands,
    setWriteReply: (reply) => { writeReply = reply },
    transport: {
      start: async (next) => {
        events = next
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
          const index = Math.min(read, readbacks.length - 1)
          emit(`$${readbackIds[index] ?? 110}=${readbacks[index]}`)
          read++
          emit('ok')
          return
        }
        emit(writeReply)
      },
      close: async () => events?.onClose(null),
    },
  }
}

beforeEach(() => {
  useMachineControl.setState({
    connectionKind: null,
    connectionPhase: 'disconnected',
    settings: {},
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  const controller = getMachineController()
  if (controller.connectionPhase() !== 'disconnected') await controller.disconnect()
  useCamStore.setState((state) => ({
    machineLibrary: originalLibrary,
    project: { ...state.project, machine: originalMachine },
    control: originalControl,
  }))
})

describe('WO-1115 GRBL setting vocabulary', () => {
  it('parses and formats numbered rows, masks, and the complete GRBL 1.1 range', () => {
    expect(parseGrblSetting(' $110=6000.000 ')).toEqual({ id: 110, value: '6000.000' })
    expect(parseGrblSetting('$x=4')).toBeNull()
    expect(formatGrblSetting(110, ' 6000 ')).toBe('$110=6000')
    expect(formatGrblSetting(110, 'six thousand')).toBeNull()
    expect(formatGrblMask('5', ['X', 'Y', 'Z'])).toBe('X, Z')
    expect(Object.keys(GRBL_SETTINGS).map(Number)).toContain(132)
    expect(Object.keys(GRBL_SETTINGS)).toHaveLength(34)
  })

  it('mirrors GRBL motion rows into the definition consumed by planning', () => {
    const machine = machineWithSettings({})
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])

    const recorded = recordGrblSettings(machine, {
      100: '320.000', 101: '', 111: '1500.000', 122: '100.000',
    })

    expect(recorded.controllerDefinition?.axes.find((axis) => axis.axis === 'X')?.stepsPerUnit).toBe(320)
    expect(recorded.controllerDefinition?.axes.find((axis) => axis.axis === 'Y')?.maxVelocity).toBe(1500)
    expect(recorded.controllerDefinition?.axes.find((axis) => axis.axis === 'Z')?.acceleration).toBe(100)
    expect(resolveMachineMotion({ machine: recorded, connectionKind: null }).axes.y.maxVelocityMmMin)
      .toBe(1500)
    expect(machineAxisAccelerations(recorded)?.z).toBe(100)
    expect(recorded.controllerDefinition?.axes.find((axis) => axis.axis === 'Y')?.stepsPerUnit)
      .toBe(machine.controllerDefinition.axes.find((axis) => axis.axis === 'Y')?.stepsPerUnit)
    expect(machine.controllerDefinition.axes.find((axis) => axis.axis === 'Z')?.acceleration).not.toBe(100)
  })

  it('derives every legacy GRBL-owned machine fact from the recorded rows', () => {
    const machine = machineWithSettings({})
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])

    const recorded = recordGrblSettings(machine, {
      3: '5', 5: '1', 20: '1', 21: '1', 22: '1', 23: '2',
      24: '125.5', 25: '900', 27: '3.25', 30: '18000', 31: '6000',
      130: '750', 131: '500', 132: '120',
    })

    expect(recorded.travel).toEqual({ x: 750, y: 500, z: 120 })
    expect(recorded.maxSpindleRpm).toBe(18000)
    expect(recorded.minSpindleRpm).toBe(6000)
    expect(recorded.noHomingSwitches).toBe(false)
    expect(recorded.controllerDefinition?.axes.map((axis) => ({
      axis: axis.axis,
      softLimitMin: axis.softLimitMin,
      softLimitMax: axis.softLimitMax,
      directionInverted: axis.dirPin.negate,
      limitsInverted: axis.limitMinusPin.negate,
      homeInverted: axis.homePin.negate,
    }))).toEqual([
      { axis: 'X', softLimitMin: -750, softLimitMax: 0, directionInverted: true, limitsInverted: true, homeInverted: true },
      { axis: 'Y', softLimitMin: -500, softLimitMax: 0, directionInverted: false, limitsInverted: true, homeInverted: true },
      { axis: 'Z', softLimitMin: -120, softLimitMax: 0, directionInverted: true, limitsInverted: true, homeInverted: true },
    ])
    expect(recorded.controllerDefinition?.homing.perAxis).toMatchObject({
      X: { direction: 'positive', slowSpeed: 125.5, fastSpeed: 900, backOff: 3.25 },
      Y: { direction: 'negative', slowSpeed: 125.5, fastSpeed: 900, backOff: 3.25 },
      Z: { direction: 'positive', slowSpeed: 125.5, fastSpeed: 900, backOff: 3.25 },
    })
    expect(recorded.grblSettings?.[20]).toBe('1')
    expect(recorded.grblSettings?.[21]).toBe('1')
    expect(machine.travel).not.toEqual(recorded.travel)
  })

  it('preserves live-editor changes when a GRBL document enters the store', () => {
    const machine = machineWithSettings({
      3: '1', 22: '1', 23: '4', 24: '100', 25: '800', 27: '2',
      30: '18000', 31: '6000', 130: '750', 131: '500', 132: '120',
    })
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
    const derived = recordGrblSettings(machine, machine.grblSettings ?? {})
    const conflicting = {
      ...derived,
      // WO-1700: the store writes the definition's slowest axis speed onto
      // rapidRate; a record already in agreement is adopted as itself.
      rapidRate: machineRapidRate(derived)?.mmMin ?? derived.rapidRate,
      travel: { ...derived.travel, x: 999 },
      maxSpindleRpm: 24000,
      noHomingSwitches: true,
      controllerDefinition: {
        ...derived.controllerDefinition!,
        axes: derived.controllerDefinition!.axes.map((axis) => axis.axis === 'X'
          ? {
              ...axis,
              softLimitMin: -999,
              dirPin: { ...axis.dirPin, negate: false },
              homePin: { ...axis.homePin, negate: false },
              limitMinusPin: { ...axis.limitMinusPin, negate: false },
              limitPlusPin: { ...axis.limitPlusPin, negate: false },
            }
          : axis),
        homing: {
          ...derived.controllerDefinition!.homing,
          perAxis: {
            ...derived.controllerDefinition!.homing.perAxis,
            Z: { ...derived.controllerDefinition!.homing.perAxis.Z!, direction: 'positive' as const },
          },
        },
      },
    }

    expect(adoptMachineDocument(conflicting)).toBe(conflicting)
    act(() => {
      useCamStore.setState({ machineLibrary: [derived] })
      useCamStore.getState().updateMachineInLibrary(machine.id, conflicting)
    })
    const adopted = useCamStore.getState().machineLibrary[0]

    expect(adopted.travel.x).toBe(999)
    expect(adopted.maxSpindleRpm).toBe(24000)
    expect(adopted.noHomingSwitches).toBe(true)
    expect(adopted.controllerDefinition?.axes[0]).toMatchObject({
      softLimitMin: -999,
      softLimitMax: 0,
      dirPin: { negate: false },
      homePin: { negate: false },
      limitMinusPin: { negate: false },
      limitPlusPin: { negate: false },
    })
    expect(adopted.controllerDefinition?.homing.perAxis.Z?.direction).toBe('positive')
    expect(adopted.grblSettings).toEqual(machine.grblSettings)
  })
})

describe('WO-1115 Definition table', () => {
  it('keeps the GRBL-backend settings surface available for a grblHAL declaration', () => {
    const machine: MachineConfig = {
      ...machineWithSettings({ 110: '6000' }),
      id: 'wo1171-grblhal-settings',
      controller: 'grblhal',
    }
    act(() => useCamStore.setState((state) => ({
      machineLibrary: [machine],
      project: { ...state.project, machine },
      control: {
        activeMachineId: machine.id,
        sessionMachine: null,
        appliedMachine: null,
        sessionActiveMachineId: null,
      },
    })))

    render(<MachineDefinitionPanel connectionKind="serial" />)

    expect(screen.getByTestId('machine-def-grbl-settings')).toBeTruthy()
    expect((screen.getByLabelText('Edit GRBL setting $110') as HTMLInputElement).value)
      .toBe('6000')
  })

  it('shows connected readback without rewriting the definition draft', async () => {
    const onChange = vi.fn()
    useMachineControl.setState({
      connectionKind: 'serial',
      connectionPhase: 'connected',
      settings: { 110: '6000' },
    })

    render(
      <GrblSettingsTable
        machine={machineWithSettings({ 110: '5000' })}
        onChange={onChange}
      />,
    )

    await waitFor(() => expect((screen.getByLabelText('Edit GRBL setting $110') as HTMLInputElement).value)
      .toBe('6000'))
    expect(screen.getByTestId('machine-def-grbl-state-110').textContent).toBe('differs from stored')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('records a complete explicit read when the operator saves the panel', async () => {
    const machine = machineWithSettings({})
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
    act(() => useCamStore.setState((state) => ({
      machineLibrary: [machine],
      project: { ...state.project, machine },
      control: {
        activeMachineId: machine.id,
        sessionMachine: machine,
        appliedMachine: null,
        sessionActiveMachineId: machine.id,
      },
    })))
    const wire = fakeGrblWire(['6000'])
    const controller = getMachineController()
    await controller.connect({ kind: 'bytes', transport: wire.transport })
    act(() => useMachineControl.getState().setConnectionKind('serial'))
    render(<MachineDefinitionPanel connectionKind="serial" />)
    fireEvent.click(screen.getByTestId('machine-def-tab-controller'))

    fireEvent.click(screen.getByRole('button', { name: 'Read from GRBL for Save' }))

    await waitFor(() => expect(wire.commands).toContain('$$'))
    expect(screen.getByTestId('machine-def-grbl-status').textContent)
      .toBe('GRBL read back 1 settings; Save records this copy.')
    await waitFor(() => expect(
      (screen.getByTestId('machine-def-panel-save') as HTMLButtonElement).disabled,
    ).toBe(false))
    fireEvent.click(screen.getByTestId('machine-def-panel-save'))
    await waitFor(() => expect(useCamStore.getState().machineLibrary[0].grblSettings)
      .toEqual({ 110: '6000' }))
    expect(useCamStore.getState().machineLibrary[0].controllerDefinition?.axes
      .find((axis) => axis.axis === 'X')?.maxVelocity).toBe(6000)
  })

  it('derives GRBL-owned motion fields from connected readback without a second editor', () => {
    const machine = machineWithSettings({})
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
    act(() => {
      useCamStore.setState((state) => ({
        machineLibrary: [machine],
        project: { ...state.project, machine },
        control: {
          activeMachineId: machine.id,
          sessionMachine: machine,
          appliedMachine: null,
          sessionActiveMachineId: machine.id,
        },
      }))
      useMachineControl.setState({
        connectionKind: 'serial',
        connectionPhase: 'connected',
        settings: { 100: '800', 110: '6000', 120: '500' },
      })
    })

    render(<MachineDefinitionPanel connectionKind="serial" />)
    fireEvent.click(screen.getByTestId('machine-def-tab-machine'))

    expect(screen.getByTestId('machine-def-grbl-axis-steps-X').textContent).toBe('800')
    expect(screen.getByTestId('machine-def-grbl-axis-rate-X').textContent).toBe('6000')
    expect(screen.getByTestId('machine-def-grbl-axis-accel-X').textContent).toBe('500')
    expect(screen.queryByLabelText('X steps per unit')).toBeNull()
  })

  it('gates only GRBL-owned travel and homing fields while keeping app-owned editors', () => {
    const machine = machineWithSettings({
      20: '1', 21: '1', 22: '1', 23: '5', 24: '125.5', 25: '900', 27: '3.25',
      130: '750', 131: '500', 132: '120',
    })
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
    const { X: _xHoming, ...homingWithoutX } = machine.controllerDefinition.homing.perAxis
    machine.controllerDefinition.homing = {
      ...machine.controllerDefinition.homing,
      perAxis: homingWithoutX,
    }
    act(() => useCamStore.setState((state) => ({
      machineLibrary: [machine],
      project: { ...state.project, machine },
      control: {
        activeMachineId: machine.id,
        sessionMachine: machine,
        appliedMachine: null,
        sessionActiveMachineId: machine.id,
      },
    })))

    render(<MachineDefinitionPanel connectionKind="serial" />)
    fireEvent.click(screen.getByTestId('machine-def-tab-machine'))

    expect(screen.getByTestId('machine-def-grbl-homing-summary').textContent)
      .toBe('Soft limits: onHard limits: onHoming cycle: on')
    expect(screen.getByTestId('machine-def-grbl-travel-X').textContent).toBe('750')
    expect(screen.getByTestId('machine-def-grbl-homing-direction-X').textContent).toBe('negative')
    expect(screen.getByTestId('machine-def-grbl-homing-direction-Y').textContent).toBe('positive')
    expect(screen.getByTestId('machine-def-grbl-homing-direction-Z').textContent).toBe('negative')
    expect(screen.queryByLabelText('X soft limit minimum')).toBeNull()
    expect(screen.queryByLabelText('X soft limit maximum')).toBeNull()
    expect(screen.queryByLabelText('X homing direction')).toBeNull()
    expect(screen.queryByLabelText('X homing fast speed')).toBeNull()
    expect(screen.queryByLabelText('X homing slow speed')).toBeNull()
    expect(screen.queryByLabelText('X homing back off')).toBeNull()
    expect(screen.getByTestId('machine-def-panel-homing-order-0')).toBeTruthy()
    // WO-1690: these live in the axis drawer. WO-1773: on a GRBL-family board
    // the homing switch IS machine zero, so the Home value editor is
    // deliberately ABSENT - an editor whose edit normalizes away is a trap,
    // not a control. Auto-zero stays this software's own either way: GRBL has
    // no concept of it.
    fireEvent.click(screen.getByTestId('machine-def-panel-axis-pins-more-Y'))
    expect(screen.queryByLabelText('Y homing value')).toBeNull()
    expect(screen.getByLabelText('Y homing auto zero')).toBeTruthy()
    expect(screen.getByTestId('machine-def-panel-homing-define-X')).toBeTruthy()
    expect(screen.getByTestId('machine-def-panel-unset-soft-limits').textContent)
      .toContain('Read $130-$132 from GRBL for X/Y/Z')
  })

  it('keeps fourth-axis travel and homing editable when GRBL owns X/Y/Z', () => {
    const machine = machineWithSettings({
      20: '1', 21: '1', 22: '1', 23: '5', 24: '125.5', 25: '900', 27: '3.25',
      130: '750', 131: '500', 132: '120',
    })
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z', 'A'])
    act(() => useCamStore.setState((state) => ({
      machineLibrary: [machine],
      project: { ...state.project, machine },
      control: {
        activeMachineId: machine.id,
        sessionMachine: machine,
        appliedMachine: null,
        sessionActiveMachineId: machine.id,
      },
    })))

    render(<MachineDefinitionPanel connectionKind="serial" />)
    fireEvent.click(screen.getByTestId('machine-def-tab-machine'))

    expect(screen.queryByLabelText('X soft limit minimum')).toBeNull()
    expect(screen.queryByLabelText('X homing direction')).toBeNull()
    expect(screen.getByTestId('machine-def-grbl-travel-X').textContent).toBe('750')

    const softMin = screen.getByLabelText('A soft limit minimum') as HTMLInputElement
    const softMax = screen.getByLabelText('A soft limit maximum') as HTMLInputElement
    const direction = screen.getByLabelText('A homing direction') as HTMLSelectElement
    const fast = screen.getByLabelText('A homing fast speed') as HTMLInputElement
    // WO-1690: slow approach and back off are behind A's own "Pins and more" drawer.
    fireEvent.click(screen.getByTestId('machine-def-panel-axis-pins-more-A'))
    const slow = screen.getByLabelText('A homing slow speed') as HTMLInputElement
    const backOff = screen.getByLabelText('A homing back off') as HTMLInputElement

    expect([softMin, softMax, direction, fast, slow, backOff]
      .every((input) => !input.disabled)).toBe(true)
    fireEvent.change(softMin, { target: { value: '-360' } })
    fireEvent.change(softMax, { target: { value: '0' } })
    fireEvent.change(direction, { target: { value: 'positive' } })
    fireEvent.change(fast, { target: { value: '700' } })
    fireEvent.change(slow, { target: { value: '80' } })
    fireEvent.change(backOff, { target: { value: '2.5' } })

    expect((screen.getByLabelText('A soft limit minimum') as HTMLInputElement).value).toBe('-360')
    expect((screen.getByLabelText('A homing direction') as HTMLSelectElement).value).toBe('positive')
    expect((screen.getByLabelText('A homing fast speed') as HTMLInputElement).value).toBe('700')
  })

  it('keeps fourth-axis wiring polarity editable while GRBL owns X/Y/Z polarity', () => {
    const machine = machineWithSettings({ 3: '0', 5: '0' })
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z', 'A'])
    act(() => {
      useCamStore.setState((state) => ({
        machineLibrary: [machine],
        project: { ...state.project, machine },
        control: {
          activeMachineId: machine.id,
          sessionMachine: machine,
          appliedMachine: null,
          sessionActiveMachineId: machine.id,
        },
      }))
      useMachineControl.setState({
        connectionKind: 'serial',
        connectionPhase: 'connected',
        settings: { 3: '1', 5: '1' },
      })
    })

    render(<MachineDefinitionPanel connectionKind="serial" />)
    fireEvent.click(screen.getByTestId('machine-def-tab-machine'))

    // WO-1690: every pin, X's included, is behind that axis's own "Pins and
    // more" drawer now - one axis's drawer is open at a time.
    fireEvent.click(screen.getByTestId('machine-def-panel-axis-pins-more-X'))
    const xDirection = screen.getByLabelText('X dir negate') as HTMLInputElement
    const xHome = screen.getByLabelText('X home negate') as HTMLInputElement
    const xLimitMinus = screen.getByLabelText('X limit- negate') as HTMLInputElement
    const xLimitPlus = screen.getByLabelText('X limit+ negate') as HTMLInputElement
    expect(xDirection.checked).toBe(true)
    expect([xDirection, xHome, xLimitMinus, xLimitPlus]
      .every((input) => input.disabled)).toBe(true)
    expect(xHome.checked).toBe(true)
    expect((screen.getByLabelText('X dir port') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('X dir pin') as HTMLInputElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId('machine-def-panel-axis-pins-more-Y'))
    const yDirection = screen.getByLabelText('Y dir negate') as HTMLInputElement
    expect(yDirection.checked).toBe(false)
    expect(yDirection.disabled).toBe(true)

    fireEvent.click(screen.getByTestId('machine-def-panel-axis-pins-more-A'))
    const fourthAxisPolarities = ['dir', 'home', 'limit-', 'limit+']
      .map((label) => screen.getByLabelText(`A ${label} negate`) as HTMLInputElement)
    expect(fourthAxisPolarities.every((input) => !input.disabled)).toBe(true)
    fireEvent.click(fourthAxisPolarities[0])
    expect((screen.getByLabelText('A dir negate') as HTMLInputElement).checked).toBe(true)
  })

  it('stores an offline edit and marks it not sent', async () => {
    const machine = machineWithSettings({ 110: '5000' })
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
    render(<Harness initial={machine} />)
    const input = screen.getByLabelText('Edit GRBL setting $110')
    fireEvent.change(input, { target: { value: '6000' } })
    fireEvent.blur(input)

    await waitFor(() => expect(screen.getByTestId('stored-settings').textContent).toContain('6000'))
    expect(screen.getByTestId('machine-def-grbl-status').textContent)
      .toBe('$110 not sent - connect to apply.')
    expect(screen.getByTestId('machine-def-grbl-state-110').textContent)
      .toBe('not sent - connect to apply')
    expect(screen.getByTestId('axis-settings').textContent).toContain('"maxVelocity":6000')
  })

  it('does not mark an untouched offline row as edited on blur', () => {
    render(<Harness initial={machineWithSettings({ 110: '5000' })} />)

    fireEvent.blur(screen.getByLabelText('Edit GRBL setting $110'))

    expect(screen.getByTestId('machine-def-grbl-state-110').textContent).toBe('stored copy')
    expect(screen.queryByTestId('machine-def-grbl-status')).toBeNull()
  })

  it('replaces the apply snapshot when the definition changes during a live connection', async () => {
    useMachineControl.setState({
      connectionKind: 'serial',
      connectionPhase: 'connected',
      settings: { 110: '5000' },
    })
    const first = machineWithSettings({ 110: '5000' })
    const second = { ...machineWithSettings({ 110: '7000' }), id: 'wo1115-second-grbl' }
    const onChange = vi.fn()
    const view = render(<GrblSettingsTable machine={first} onChange={onChange} />)

    view.rerender(<GrblSettingsTable machine={second} onChange={onChange} />)

    expect(screen.getByTestId('machine-def-grbl-state-110').textContent).toBe('differs from stored')
    fireEvent.click(screen.getByTestId('machine-def-grbl-apply-stored'))
    await waitFor(() => expect(screen.getByTestId('machine-def-grbl-status').textContent)
      .not.toContain('Stored settings already agree'))
  })

  it('applies the post-read definition instead of the stale pre-read copy', async () => {
    const wire = fakeGrblWire(['750', '750'], [130, 130])
    const controller = getMachineController()
    await controller.connect({ kind: 'bytes', transport: wire.transport })
    act(() => {
      useMachineControl.getState().setConnectionKind('serial')
      useMachineControl.setState({ settings: { 130: '200' } })
    })
    render(<Harness initial={machineWithSettings({ 130: '200' })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Read from GRBL for Save' }))

    await waitFor(() => expect(screen.getByTestId('stored-settings').textContent)
      .toContain('750'))
    wire.commands.length = 0
    fireEvent.click(screen.getByTestId('machine-def-grbl-apply-stored'))

    await waitFor(() => expect(wire.commands).toEqual(['$130=750', '$$']))
  })

  it('sends exactly the edited id, re-reads $$, and shows only readback', async () => {
    const wire = fakeGrblWire(['5000', '5999.875'])
    const controller = getMachineController()
    await controller.connect({ kind: 'bytes', transport: wire.transport })
    act(() => useMachineControl.getState().setConnectionKind('serial'))
    wire.commands.length = 0
    useMachineControl.getState().clearConsole()
    const machine = machineWithSettings({ 110: '5000' })
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
    render(<Harness initial={machine} />)

    const input = screen.getByLabelText('Edit GRBL setting $110')
    fireEvent.change(input, { target: { value: '6000' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(wire.commands).toEqual(['$110=6000', '$$']))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('5999.875'))
    expect(screen.getByTestId('stored-settings').textContent).toContain('5999.875')
    expect(screen.getByTestId('axis-settings').textContent).toContain('"maxVelocity":5999.875')
    expect(screen.getByTestId('machine-def-grbl-status').textContent)
      .toBe('GRBL read back $110=5999.875.')
  })

  it('reverts an error:3 edit and emits one decoded controller line', async () => {
    const wire = fakeGrblWire(['5000'])
    wire.setWriteReply('error:3')
    const controller = getMachineController()
    await controller.connect({ kind: 'bytes', transport: wire.transport })
    act(() => useMachineControl.getState().setConnectionKind('serial'))
    wire.commands.length = 0
    useMachineControl.getState().clearConsole()
    render(<Harness initial={machineWithSettings({ 110: '5000' })} />)

    const input = screen.getByLabelText('Edit GRBL setting $110')
    fireEvent.change(input, { target: { value: '6000' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('machine-def-grbl-status').textContent)
      .toContain('The controller does not know that $ command.'))
    expect((input as HTMLInputElement).value).toBe('5000')
    expect(wire.commands).toEqual(['$110=6000'])
    expect(useMachineControl.getState().consoleLines
      .filter((line) => line.text.includes('error:3 - The controller does not know that $ command.'))).toHaveLength(1)
  })

  it('records stored-apply readback into the planner-facing axis definition', async () => {
    const wire = fakeGrblWire(['225'], [120])
    const controller = getMachineController()
    await controller.connect({ kind: 'bytes', transport: wire.transport })
    act(() => {
      useMachineControl.getState().setConnectionKind('serial')
      useMachineControl.setState({ settings: { 120: '100' } })
    })
    wire.commands.length = 0
    const machine = machineWithSettings({ 120: '225' })
    machine.controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
    render(<Harness initial={machine} />)

    fireEvent.click(screen.getByTestId('machine-def-grbl-apply-stored'))

    await waitFor(() => expect(wire.commands).toEqual(['$120=225', '$$']))
    await waitFor(() => expect(screen.getByTestId('axis-settings').textContent)
      .toContain('"acceleration":225'))
  })
})

describe('WO-1115 explicit stored apply and safety', () => {
  it('applies only differing ids and follows each write with $$', async () => {
    const wire = fakeGrblWire(['5000', '6000', '8000'], [110, 110, 112])
    const controller = getMachineController()
    await controller.connect({ kind: 'bytes', transport: wire.transport })
    wire.commands.length = 0

    const results = await applyStoredGrblSettings(
      { 110: '6000', 111: '7000', 112: '8000' },
      controller,
      { 110: '5000', 111: '7000', 112: '7500' },
    )

    expect(wire.commands).toEqual(['$110=6000', '$$', '$112=8000', '$$'])
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.ok)).toBe(true)
  })

  it('never writes a stored setting that the controller did not report', async () => {
    const wire = fakeGrblWire(['5000', '6000'], [110, 110])
    const controller = getMachineController()
    await controller.connect({ kind: 'bytes', transport: wire.transport })
    wire.commands.length = 0

    const results = await applyStoredGrblSettings(
      { 110: '6000', 111: '7000' },
      controller,
      { 110: '5000' },
    )

    expect(wire.commands).toEqual(['$110=6000', '$$'])
    expect(results).toEqual([{ ok: true, key: 110, value: '6000' }])
  })

  it('refuses every setting write while a program is active', async () => {
    const sendCommandAwait = vi.fn()
    const controller = {
      capabilities: { gcodeText: true },
      hasActiveJob: () => true,
      querySettings: vi.fn(),
      sendCommandAwait,
    } as unknown as MachineController

    const result = await writeGrblSettingAndReadBack(110, '6000', { controller })

    expect(result).toEqual({
      ok: false,
      reason: 'A program is running - GRBL setting $110 was not sent.',
    })
    expect(sendCommandAwait).not.toHaveBeenCalled()
  })
})
