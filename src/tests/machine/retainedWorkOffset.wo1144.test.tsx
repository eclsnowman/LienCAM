// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createDefaultControllerDefinition,
  machineHasNoHomeSwitches,
  type ControllerDefinition,
  type MachineConfig,
} from '../../types'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { OffsetsPanel } from '../../components/machine/OffsetsPanel'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { expandProbeRoutine } from '../../lib/machine/probeRoutineExpand'
import { FACTORY_BORE_CENTRE } from '../../lib/machine/probeRoutineFactory'
import { resolveProbeConfig } from '../../lib/machine/toolTable'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  currentResolvedMachineMotion,
  disconnectMachine,
  getMachineController,
  gotoWorkXYZero,
  probeRoutineExecutionRefusal,
  setMachinePosition,
  setWorkOffsetValue,
} from '../../lib/machine/machineSession'

const UCCNC_HOME_KEYS = ['Homeportnumber', 'Homepinnumber'] as const

function suppliedDefinition(stated: boolean): ControllerDefinition {
  const definition = createDefaultControllerDefinition()
  definition.axes.forEach((axis, index) => {
    axis.stepPin = { port: 1, pin: 2 + index * 2, negate: false }
    axis.dirPin = { port: 1, pin: 3 + index * 2, negate: false }
  })
  if (stated) {
    definition.stated = definition.axes.flatMap((axis) => UCCNC_HOME_KEYS.map((key) => ({
      controller: 'uccnc' as const,
      key: `axessettingscontrol${axis.axis}.${key}`,
    })))
  } else {
    delete definition.stated
  }
  return definition
}

function suppliedMachine(): MachineConfig {
  const base = structuredClone(useCamStore.getState().project.machine!)
  return {
    ...base,
    id: 'wo-1144-retained-vise',
    name: 'WO-1144 retained vise',
    controller: 'uccnc',
    travel: { x: 738, y: 724.5, z: 128.9 },
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'min' },
      y: { homesToward: 'max', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'min' },
    },
    controllerDefinition: suppliedDefinition(false),
    noHomingSwitches: undefined,
    rapidRate: 60_000,
  }
}

let connected = false

async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function connectSuppliedMachine(): Promise<void> {
  const pending = connectMachine('simulator')
  await settle(300)
  await pending
  connected = true
  act(() => { __resetEstopInterlockForTest() })
}

async function disconnect(): Promise<void> {
  if (!connected) return
  const pending = disconnectMachine()
  await settle(100)
  await pending
  connected = false
}

beforeEach(() => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  useCamStore.setState((state) => ({
    machineWorkOffsets: {},
    control: { ...state.control, activeMachineId: null, sessionMachine: null },
  }))
  useCamStore.getState().updateMachine(suppliedMachine())
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
})

afterEach(async () => {
  cleanup()
  await disconnect()
  vi.useRealTimers()
})

describe('WO-1144 switch and datum authority', () => {
  it('requires explicit switchless authority or stated UCCNC pins on relevant axes', () => {
    const machine = suppliedMachine()
    expect(machineHasNoHomeSwitches(machine)).toBe(false)
    expect(machineHasNoHomeSwitches({ ...machine, noHomingSwitches: true })).toBe(true)

    const stated = { ...machine, controllerDefinition: suppliedDefinition(true) }
    expect(machineHasNoHomeSwitches(stated)).toBe(true)

    const compatibility = {
      ...machine,
      controllerDefinition: createDefaultControllerDefinition(['X', 'Y', 'Z', 'A']),
    }
    const compatibilitySpare = compatibility.controllerDefinition.axes[3]
    compatibilitySpare.homePin = { port: 9, pin: 9, negate: false }
    expect(machineHasNoHomeSwitches(compatibility)).toBe(true)

    const withDisabledSpare = structuredClone(stated)
    const spare = withDisabledSpare.controllerDefinition!.axes[2]
    spare.enabled = false
    spare.homePin = { port: 9, pin: 9, negate: false }
    expect(machineHasNoHomeSwitches(withDisabledSpare)).toBe(true)

    withDisabledSpare.controllerDefinition!.stated = withDisabledSpare.controllerDefinition!.stated!
      .filter((entry) => !entry.key.includes('controlY.Homepin'))
    expect(machineHasNoHomeSwitches(withDisabledSpare)).toBe(false)
  })

  it('uses controller-confirmed per-axis homing rather than incomplete static wiring', async () => {
    await connectSuppliedMachine()
    const controller = getMachineController()
    expect(controller.homeAxes?.(['X', 'Y'])).toBe(true)
    await settle(4_000)

    const datum = currentResolvedMachineMotion().datum
    expect(datum.known).toBe(false)
    expect(datum.axes.x).toMatchObject({ known: true, source: 'homed-session' })
    expect(datum.axes.y).toMatchObject({ known: true, source: 'homed-session' })
    expect(datum.axes.z.known).toBe(false)
    expect(gotoWorkXYZero(60_000)).toBe(true)
  })

  it('refuses XY when only Z is homed even though G54 X/Y are verified', async () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { x: 20, y: 20 }, 'restored')
    await connectSuppliedMachine()
    const controller = getMachineController()
    expect(controller.homeAxes?.(['Z'])).toBe(true)
    await settle(4_000)

    expect(currentResolvedMachineMotion().datum.axes).toMatchObject({
      x: { known: false },
      y: { known: false },
      z: { known: true, source: 'homed-session' },
    })
    const before = controller.status().machinePos
    expect(gotoWorkXYZero(60_000)).toBe(false)
    expect(controller.status().machinePos).toEqual(before)
  })

  it('allows a reported live G54 after a manual datum, then follows accepted X/Y writes', async () => {
    useCamStore.getState().updateMachine({
      ...useCamStore.getState().project.machine,
      noHomingSwitches: true,
    })
    await connectSuppliedMachine()
    const controller = getMachineController()
    expect(setMachinePosition({ x: 250, y: 250, z: 100 })).toEqual({ ok: true })
    expect(currentResolvedMachineMotion().datum).toMatchObject({
      known: true,
      source: 'manual-session-datum',
    })
    expect(useCamStore.getState().machineWorkOffsets[useCamStore.getState().project.machine.id]?.G54)
      .toBeUndefined()
    expect(useMachineControl.getState().offsets.G54).toEqual([0, 0, 0])

    expect(gotoWorkXYZero(60_000)).toBe(true)
    await settle(2_000)
    expect(controller.status().machinePos).toEqual({ x: 0, y: 0, z: 100 })

    expect(setWorkOffsetValue('G54', 'X', 25)).toBe(true)
    expect(setWorkOffsetValue('G54', 'Y', 30)).toBe(true)
    await settle(500)
    expect(useMachineControl.getState().offsets.G54).toEqual([25, 30, 0])

    expect(gotoWorkXYZero(60_000)).toBe(true)
    await settle(2_000)
    expect(controller.status().machinePos).toEqual({ x: 25, y: 30, z: 100 })
  })

  it('WO-1182: an unreported active WCS is not a refusal - the goto is sent and the controller obeys its own offset', async () => {
    useCamStore.getState().updateMachine({
      ...useCamStore.getState().project.machine,
      noHomingSwitches: true,
    })
    await connectSuppliedMachine()
    expect(setMachinePosition({ x: 250, y: 250, z: 100 })).toEqual({ ok: true })
    useMachineControl.setState({ offsets: {} })

    expect(gotoWorkXYZero(60_000)).toBe(true)
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text.includes('has not reported'),
    )).toBe(false)
  })

  it('keeps probe-routine XY moves behind the fresh-session work-zero gate', async () => {
    useCamStore.getState().updateMachine({
      ...useCamStore.getState().project.machine,
      noHomingSwitches: true,
    })
    await connectSuppliedMachine()
    const machine = useCamStore.getState().project.machine
    const probe = resolveProbeConfig(machine.probing, null)
    const expanded = expandProbeRoutine(
      FACTORY_BORE_CENTRE,
      // WO-2065: the Bore descends from its top (work Z0 or the rim) - here machine Z 15
      { diameter: 40, topZ: 15 },
      {
        start: { x: 100, y: 100, z: 20 },
        envelope: deriveMachineEnvelopeFromConvention(machine.homeConvention!, machine.travel),
        probe,
        tipRadiusMm: 1.5,
        activeWcs: 'G54',
      },
    )
    if (!expanded.ok) throw new Error(expanded.errors.map((error) => error.sentence).join('\n'))

    expect(useMachineControl.getState()).toMatchObject({
      activeWcs: 'G54',
      offsets: { G54: [0, 0, 0] },
      homed: false,
    })
    expect(probeRoutineExecutionRefusal(expanded.expanded)).toBe(
      'backFromLeft: set the G54 work zero for X and Y here first.',
    )
  })

  it('WO-1182: a live value that differs from the retained one is obeyed, not refused', async () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { x: 20, y: 20, z: 7 }, 'restored')
    await connectSuppliedMachine()
    const controller = getMachineController()
    expect(controller.home()).toBe(true)
    await settle(6_000)
    const changed = controller.sendCommandAwait('G10 L2 P1 X21')
    expect(changed).not.toBeNull()
    await expect(changed).resolves.toMatchObject({ ok: true })
    controller.refreshState()
    await settle(100)

    expect(useMachineControl.getState().offsets.G54).toEqual([21, 20, 7])
    expect(gotoWorkXYZero(60_000)).toBe(true)
    await settle(2_000)
    expect(controller.status().machinePos).toMatchObject({ x: 21, y: 20 })
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text.includes('retained 20 mm'),
    )).toBe(false)
  })
})

describe('WO-1144 retained simulator work offsets', () => {
  it('reconciles retained G54, applies it exactly once, and survives reconnect', async () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { x: 20, y: 20, z: 7 }, 'restored')

    for (let connection = 0; connection < 2; connection += 1) {
      await connectSuppliedMachine()
      const controller = getMachineController()
      expect(controller.home()).toBe(true)
      await settle(6_000)

      expect(machineHasNoHomeSwitches(useCamStore.getState().project.machine)).toBe(false)
      expect(currentResolvedMachineMotion().datum).toMatchObject({
        known: true,
        source: 'homed-session',
      })
      expect(useMachineControl.getState().offsets.G54).toEqual([20, 20, 7])
      expect(useMachineControl.getState().mpos).toEqual({ x: 738, y: 724.5, z: 128.9 })
      expect(useMachineControl.getState().wpos).toEqual({ x: 718, y: 704.5, z: 121.9 })

      expect(gotoWorkXYZero(60_000)).toBe(true)
      await settle(2_000)
      expect(useMachineControl.getState().mpos).toEqual({ x: 20, y: 20, z: 128.9 })
      expect(useMachineControl.getState().consoleLines.some(
        (line) => line.text.includes('Goto work XY zero: refused'),
      )).toBe(false)

      await disconnect()
    }
  })

  it('loads mixed retained values for a non-default WCS and stores manual entry only after acceptance', async () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G55', { x: 0, y: -12.5, z: 4 }, 'restored')
    await connectSuppliedMachine()

    expect(useMachineControl.getState().offsets.G55).toEqual([0, -12.5, 4])
    const before = getMachineController().status().machinePos
    expect(setWorkOffsetValue('G55', 'X', 31.25)).toBe(true)
    await settle(500)

    expect(getMachineController().status().machinePos).toEqual(before)
    expect(useMachineControl.getState().offsets.G55).toEqual([31.25, -12.5, 4])
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55).toEqual({
      offset: { x: 31.25, y: -12.5, z: 4 },
      state: 'sent',
    })
  })

  it("loads only the pinned Control machine's retained offsets", async () => {
    const control = suppliedMachine()
    const cam = { ...control, id: 'wo-1144-cam-machine', name: 'WO-1144 CAM machine' }
    useCamStore.setState((state) => ({
      machineLibrary: [...state.machineLibrary.filter(
        (machine) => machine.id !== cam.id && machine.id !== control.id,
      ), cam, control],
      project: { ...state.project, machine: cam },
      control: { ...state.control, activeMachineId: control.id, sessionMachine: null },
    }))
    useCamStore.getState().setMachineWorkOffset(cam.id, 'G54', { x: 111, y: 112, z: 113 }, 'restored')
    useCamStore.getState().setMachineWorkOffset(control.id, 'G54', { x: 21, y: -22, z: 3 }, 'restored')

    await connectSuppliedMachine()

    expect(useCamStore.getState().project.machine.id).toBe(cam.id)
    expect(useMachineControl.getState().offsets.G54).toEqual([21, -22, 3])
    expect(useMachineControl.getState().offsets.G54).not.toEqual([111, 112, 113])
  })

  it('commits absolute entry on Enter and blur, cancels Escape, and never moves the machine', async () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { x: 20, y: 20, z: 7 }, 'restored')
    await connectSuppliedMachine()
    render(<OffsetsPanel />)

    const axis = (name: 'x' | 'y' | 'z') =>
      screen.getByTestId(`control-offset-g54-${name}`) as HTMLInputElement
    const before = getMachineController().status().machinePos

    fireEvent.focus(axis('x'))
    fireEvent.change(axis('x'), { target: { value: '123.5' } })
    fireEvent.keyDown(axis('x'), { key: 'Escape' })
    expect(axis('x').value).toBe('20.00')
    expect(useMachineControl.getState().offsets.G54).toEqual([20, 20, 7])

    fireEvent.focus(axis('x'))
    fireEvent.change(axis('x'), { target: { value: '31.25' } })
    fireEvent.keyDown(axis('x'), { key: 'Enter' })
    // jsdom does not dispatch React's focusout when NumCell calls the native
    // blur() from its Enter handler; emit that browser event explicitly.
    fireEvent.blur(axis('x'))
    await settle(500)
    expect(useMachineControl.getState().offsets.G54).toEqual([31.25, 20, 7])

    fireEvent.change(axis('y'), { target: { value: '-12.5' } })
    fireEvent.blur(axis('y'))
    await settle(500)
    expect(useMachineControl.getState().offsets.G54).toEqual([31.25, -12.5, 7])

    fireEvent.change(axis('z'), { target: { value: 'not-a-number' } })
    fireEvent.blur(axis('z'))
    await settle(100)
    expect(useMachineControl.getState().offsets.G54).toEqual([31.25, -12.5, 7])
    expect(getMachineController().status().machinePos).toEqual(before)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 31.25, y: -12.5, z: 7 },
      state: 'sent',
    })
  })
})
