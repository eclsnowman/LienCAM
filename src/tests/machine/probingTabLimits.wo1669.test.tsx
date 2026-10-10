// @vitest-environment jsdom
//
// WO-1669: the Probing tab's guided-cycle card must read the same resolved
// machine motion the Control tab and the fit check use. A bridge/UCCNC
// session never populates the store's numeric `settings` dump (its keys are
// strings like `axessettingscontrolx.Softlimitnegative`, dropped by
// machineSession.ts's onSetting), so gating "limits known" on that dump alone
// left the guided-cycle card claiming the limits were unread even after the
// definition had been applied and read back.

import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const UNKNOWN = "The machine's travel limits are not known yet - the controller settings have not been read."

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

/** WO-2063 (v2 brief): the plan text block went with the old screen. A
 *  planning refusal is now Start probing's reason - grey, with the refusal in
 *  its hover - and the same words reach the console once. A live Start
 *  probing means the routine planned. */
function visiblePlanText(): string {
  const start = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement
  return start.disabled ? (start.getAttribute('data-tooltip') ?? '').trim() : 'Motion plan'
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
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
    job: { ...useMachineControl.getState().job, phase: 'empty', name: 'wo1669.nc' },
  })
})

afterEach(() => cleanup())

describe('WO-1669 the Probing tab knows the travel limits the definition just applied', () => {
  it('shows no "not known yet" sentence once a bridge definition is applied and read back', async () => {
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
      // so the plan renders rather than refusing an out-of-envelope start.
      mpos: { x: 300, y: 300, z: 50 },
      wpos: { x: 0, y: 0, z: 0 },
    })

    render(React.createElement(ProbingPanel))

    await waitFor(() => expect(visiblePlanText()).toContain('Motion plan'))
    expect(visiblePlanText()).not.toBe(UNKNOWN)
    expect(visiblePlanText()).not.toContain('not known yet')
  })

  it('still shows the honest "not known yet" sentence with no controller definition applied', async () => {
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

    render(React.createElement(ProbingPanel))

    await waitFor(() => expect(visiblePlanText()).toBe(UNKNOWN))
  })

  it('known limits never stand in for a datum: unhomed, the MPos is still not used and no motion plan is offered', async () => {
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

    render(React.createElement(ProbingPanel))

    await waitFor(() => expect(visiblePlanText()).toBe('Home the machine before planning an automatic probe cycle.'))
    expect(visiblePlanText()).not.toContain('Motion plan')
  })
})
