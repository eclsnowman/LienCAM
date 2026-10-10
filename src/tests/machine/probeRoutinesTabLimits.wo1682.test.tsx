// @vitest-environment jsdom
//
// WO-1682: the same fix WO-1669 made on the Probing tab
// (probingTabLimits.wo1669.test.tsx), applied to the Routines tab. A
// bridge/UCCNC session never populates the store's numeric `settings` dump
// (its keys are strings like `axessettingscontrolx.Softlimitnegative`,
// dropped by machineSession.ts's onSetting), so gating "limits known" on that
// dump alone left ProbeRoutinesTab's Check button claiming the limits were
// unread even after the definition had been applied and read back.

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { createDefaultControllerDefinition, type MachineConfig } from '../../types'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { ProbeRoutinesTab } = await import('../../components/machine/ProbeRoutinesTab')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { useProbeRoutineStore } = await import('../../store/probeRoutineStore')

const BLOCKED_UNKNOWN = 'connect the machine and read its settings first'
const BLOCKED_NOT_HOMED = 'home the machine ($H) first'

// The finding's own read-back rows: docs/machine/NEXT-HARDWARE-SESSION.md
// 'FINDINGS LOG - 2026-09-17', soft limits X 0..738, Y 0..724.5, Z -0.1..129.1.
function readBackDefinition(): MachineConfig['controllerDefinition'] {
  const definition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
  const limits: Record<string, readonly [number, number]> = { X: [0, 738], Y: [0, 724.5], Z: [-0.1, 129.1] }
  definition.axes = definition.axes.map((axis) => ({
    ...axis,
    enabled: true,
    softLimitMin: limits[axis.axis]![0],
    softLimitMax: limits[axis.axis]![1],
  }))
  definition.stated = definition.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
    controller: 'uccnc' as const,
    key: axisSoftLimitStatementKey(axis.axis, end),
  })))
  return definition
}

async function checkBoreCentre() {
  fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.bore-centre' } })
  await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-check')) })
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  act(() => { useProbeRoutineStore.setState({ routines: {}, quarantined: {}, hidden: [] }) })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    connectionKind: 'bridge',
    machineState: 'unknown',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    homed: false,
    settings: {},
    mpos: null,
    wpos: null,
    programText: '',
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty', name: 'wo1682.nc' },
  })
})

afterEach(() => cleanup())

describe('WO-1682 the Routines tab knows the travel limits the definition just applied', () => {
  it('shows no envelope-unknown "Check" refusal once a bridge definition is applied and read back', async () => {
    const machine = useCamStore.getState().project.machine!
    useCamStore.getState().updateMachine({
      ...machine,
      controller: 'uccnc',
      controllerDefinition: readBackDefinition(),
    })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: true,
      // The bridge never fills this GRBL-shaped dump; only the applied
      // controller definition carries the read-back limits.
      settings: {},
      // Well inside the read-back envelope (X 0..738, Y 0..724.5, Z -0.1..129.1)
      mpos: { x: 300, y: 300, z: 50 },
      wpos: { x: 0, y: 0, z: 0 },
    })

    render(React.createElement(ProbeRoutinesTab))
    await checkBoreCentre()

    await waitFor(() => expect(screen.getByTestId('probe-routine-preview').getAttribute('data-state')).not.toBe('idle'))
    const blocked = screen.queryByTestId('probe-routine-preview-blocked')
    expect(blocked?.textContent ?? '').not.toContain(BLOCKED_UNKNOWN)
  })

  it('still refuses "Check" with the honest unread-settings reason with no controller definition applied', async () => {
    const machine = useCamStore.getState().project.machine!
    useCamStore.getState().updateMachine({
      ...machine,
      controller: 'uccnc',
      controllerDefinition: undefined,
    })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: true,
      settings: {},
      mpos: { x: -50, y: -50, z: -10 },
      wpos: { x: 0, y: 0, z: 0 },
    })

    render(React.createElement(ProbeRoutinesTab))
    await checkBoreCentre()

    await waitFor(() => expect(screen.getByTestId('probe-routine-preview-blocked').textContent).toContain(BLOCKED_UNKNOWN))
  })

  it('known limits never stand in for a datum: unhomed, the MPos is still not used', async () => {
    const machine = useCamStore.getState().project.machine!
    useCamStore.getState().updateMachine({
      ...machine,
      controller: 'uccnc',
      controllerDefinition: readBackDefinition(),
    })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: false,
      settings: {},
      mpos: { x: 300, y: 300, z: 50 },
      wpos: { x: 0, y: 0, z: 0 },
    })

    render(React.createElement(ProbeRoutinesTab))
    await checkBoreCentre()

    await waitFor(() => expect(screen.getByTestId('probe-routine-preview-blocked').textContent).toContain(BLOCKED_NOT_HOMED))
  })
})
