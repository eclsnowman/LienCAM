// @vitest-environment jsdom
//
// WO-906 re-pinned by WO-1101 and WO-1098: text capability is irrelevant to
// routines. An unsupported typed step disables Run with its reason in the
// title and publishes that reason once to the machine console, never a note.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProbeRoutineRunPanel } from '../../components/machine/ProbeRoutineRunPanel'
import { useMachineControl } from '../../store/machineControlStore'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { expandProbeRoutine, type ExpandedRoutine, type ExpandedStep } from '../../lib/machine/probeRoutineExpand'
import { FACTORY_BORE_CENTRE } from '../../lib/machine/probeRoutineFactory'
import {
  __resetEstopInterlockForTest,
  getMachineController,
  probeRoutineExecutionRefusal,
  runProbeRoutine,
} from '../../lib/machine/machineSession'
import { resolveProbeConfig } from '../../lib/machine/toolTable'

const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 300, y: 300, z: 100 },
)
const rawProbe = {
  positioningFeed: 1200,
  fastFeed: 300,
  slowFeed: 40,
  retract: 2,
  maxTravel: 30,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
}
const probe = resolveProbeConfig(null, rawProbe)

function expandBore(): ExpandedRoutine {
  const result = expandProbeRoutine(
    FACTORY_BORE_CENTRE,
    // WO-2065: the Bore descends from its top (work Z0 or the rim) - here machine Z 15
    { diameter: 40, topZ: 15 },
    {
      start: { x: 100, y: 100, z: 20 },
      envelope,
      probe,
      tipRadiusMm: 1.5,
      activeWcs: 'G54',
    },
  )
  if (!result.ok) throw new Error(result.errors.map((error) => error.sentence).join('\n'))
  return result.expanded
}

function withUnsupportedCombinedMove(): ExpandedRoutine {
  const expanded = expandBore()
  let changed = false
  const alter = (steps: ExpandedStep[]): ExpandedStep[] => steps.map((step) => {
      // WO-2554: first XY move is the conditional return away from the left wall.
      if (step.kind === 'branch') return { ...step, then: alter(step.then), else: alter(step.else) }
      if (changed || step.kind !== 'move' || step.label !== 'backFromLeft') return step
      changed = true
      return { ...step, axes: ['X', 'Z'] }
    })
  return { ...expanded, steps: alter(expanded.steps) }
}

const ctrl = getMachineController()
const originalCapabilities = ctrl.capabilities

beforeEach(() => {
  __resetEstopInterlockForTest()
  useMachineControl.getState().clearConsole()
  Object.defineProperty(ctrl, 'capabilities', {
    configurable: true,
    value: { ...originalCapabilities, gcodeText: false },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(ctrl, 'capabilities', {
    configurable: true,
    value: originalCapabilities,
  })
})

describe('WO-906/1098/1101: probe routines refuse unsupported typed steps before motion', () => {
  it('ignores gcodeText:false and names an unsupported step before any verb reaches the controller', async () => {
    const sendCommandAwait = vi.spyOn(ctrl, 'sendCommandAwait')
    const sendCommand = vi.spyOn(ctrl, 'sendCommand')
    const jogToWorkXY = vi.spyOn(ctrl, 'jogToWorkXY')
    const jogToMachineZ = vi.spyOn(ctrl, 'jogToMachineZ')
    const probeVerb = vi.spyOn(ctrl, 'probe')
    const expanded = withUnsupportedCombinedMove()
    const refusal = probeRoutineExecutionRefusal(expanded, ctrl)
    if (!refusal) throw new Error('fixture must have an unsupported typed step')

    const result = await runProbeRoutine(expanded, rawProbe, true, expanded.hash, { envelope })

    expect(result.ok).toBe(false)
    expect(result.message).toBe(refusal)
    expect(result.message).toContain('backFromLeft')
    expect(result.message).toContain('combined XYZ move')
    expect(result.touches).toEqual([])
    expect(sendCommandAwait).toHaveBeenCalledTimes(0)
    expect(sendCommand).toHaveBeenCalledTimes(0)
    expect(jogToWorkXY).toHaveBeenCalledTimes(0)
    expect(jogToMachineZ).toHaveBeenCalledTimes(0)
    expect(probeVerb).toHaveBeenCalledTimes(0)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toBe(`Probe routine: refused - ${refusal}`)
  })

  it('keeps the refusal off the panel, on disabled Run, and once in the console', async () => {
    const expanded = withUnsupportedCombinedMove()
    const refusal = probeRoutineExecutionRefusal(expanded, ctrl)
    if (!refusal) throw new Error('fixture must have an unsupported typed step')
    const sendCommandAwait = vi.spyOn(ctrl, 'sendCommandAwait')
    const sendCommand = vi.spyOn(ctrl, 'sendCommand')
    const jogToWorkXY = vi.spyOn(ctrl, 'jogToWorkXY')
    const jogToMachineZ = vi.spyOn(ctrl, 'jogToMachineZ')
    const probeVerb = vi.spyOn(ctrl, 'probe')

    render(
      <ProbeRoutineRunPanel
        expanded={expanded}
        stale={false}
        probe={probe}
        envelope={envelope}
        activeWcs="G54"
        units="mm"
      />,
    )

    const run = screen.getByTestId('probe-routine-run') as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.title).toBe(refusal)
    expect(screen.queryByTestId('probe-routine-run-note')).toBeNull()

    await waitFor(() => {
      expect(useMachineControl.getState().consoleLines.filter(
        (line) => line.text === `Probe routine: refused - ${refusal}`,
      )).toHaveLength(1)
    })

    fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
    expect(run.disabled).toBe(true)
    fireEvent.click(run)

    expect(useMachineControl.getState().consoleLines.filter(
      (line) => line.text === `Probe routine: refused - ${refusal}`,
    )).toHaveLength(1)
    expect(screen.queryByTestId('probe-routine-run-message')).toBeNull()
    expect(sendCommandAwait).toHaveBeenCalledTimes(0)
    expect(sendCommand).toHaveBeenCalledTimes(0)
    expect(jogToWorkXY).toHaveBeenCalledTimes(0)
    expect(jogToMachineZ).toHaveBeenCalledTimes(0)
    expect(probeVerb).toHaveBeenCalledTimes(0)
  })

  it('leaves a live-position refusal to the runner instead of freezing it in the panel', async () => {
    const expanded = expandBore()
    const refusal = probeRoutineExecutionRefusal(expanded, ctrl)
    expect(refusal).toContain('has not reported both machine and work position')

    render(
      <ProbeRoutineRunPanel
        expanded={expanded}
        stale={false}
        probe={probe}
        envelope={envelope}
        activeWcs="G54"
        units="mm"
      />,
    )

    const run = screen.getByTestId('probe-routine-run') as HTMLButtonElement
    expect(screen.queryByTestId('probe-routine-run-note')).toBeNull()
    expect(useMachineControl.getState().consoleLines).toEqual([])
    expect(run.disabled).toBe(true)

    fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))

    expect(run.disabled).toBe(false)
    expect(run.title).toBe(`Run ${expanded.routineName}`)
    expect(useMachineControl.getState().consoleLines).toEqual([])

    fireEvent.click(run)

    await waitFor(() => {
      expect(useMachineControl.getState().consoleLines.at(-1)?.text)
        .toBe(`Probe routine: refused - ${refusal}`)
    })
    expect(screen.getByTestId('probe-routine-run-message').textContent).toBe(refusal)
  })
})
