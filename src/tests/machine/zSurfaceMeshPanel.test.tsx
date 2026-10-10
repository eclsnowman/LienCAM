// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSurfaceMeshPoints, fingerprintProgram, type SurfaceMeshMap } from '../../lib/machine/zSurfaceMesh'

const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

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

const PROGRAM = [
  'G21 G90 G54',
  'G0 X100 Y100 Z5',
  'G0 X10 Y20',
  'G1 Z-0.2 F100',
  'G1 X30 Y20 F400',
  'G1 X30 Y40',
  'G1 X10 Y40',
  'G1 X10 Y20',
  'G0 X150 Y150',
].join('\n')

function activeMesh(): SurfaceMeshMap {
  const bounds = { minX: 8, minY: 18, maxX: 32, maxY: 42 }
  const points = buildSurfaceMeshPoints(bounds, 3, 3)
  return {
    bounds,
    cutBounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 },
    pointsX: 3,
    pointsY: 3,
    fadeMm: 10,
    referenceMachineZ: -40,
    samples: points.map((point, index) => ({ ...point, machineZ: -40 + index * 0.01 })),
    sourceFingerprint: fingerprintProgram(PROGRAM),
    sourceName: 'pcb.nc',
    workOffset: 'G54',
    probedAt: 1,
    active: true,
  }
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: 1,
    mpos: { x: 0, y: 0, z: 10 },
    wpos: { x: 0, y: 0, z: 0 },
    homed: true,
    settings: { 23: '7', 130: '740.000', 131: '724.000', 132: '130.000' },
    alarm: null,
    programText: PROGRAM,
    surfaceMesh: null,
    job: { ...useMachineControl.getState().job, phase: 'ready', name: 'pcb.nc' },
  })
})

afterEach(() => cleanup())
import { expectOneEstopControl } from './support/estopControl'

describe('Z surface mesh operator station', () => {
  it('defaults to cutting-only bounds and exposes editable grid, fade, preview, and visible E-STOP', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))

    expect(screen.getByTestId('control-surface-mesh-margin')).toBeTruthy()
    expect(screen.getByTestId('control-surface-mesh-fade')).toBeTruthy()
    expect((screen.getByTestId('control-surface-mesh-minx') as HTMLInputElement).value).toBe('8.00')
    expect((screen.getByTestId('control-surface-mesh-maxx') as HTMLInputElement).value).toBe('32.00')
    expect((screen.getByTestId('control-surface-mesh-miny') as HTMLInputElement).value).toBe('18.00')
    expect((screen.getByTestId('control-surface-mesh-maxy') as HTMLInputElement).value).toBe('42.00')
    // WO-2063 (v2 brief): the old static surface-map diagram went with the old
    // screen. The steps are the preview: point 1, point 2, and the rest of the
    // 5 x 5 grid said in words.
    const chips = screen.getAllByTestId(/^probing-step-chip-/)
    const said = chips.map((chip) => {
      fireEvent.click(chip)
      return screen.getByTestId('probing-step-sentence').textContent ?? ''
    })
    expect(said.join(' ')).toContain('repeat for every point (25 in all)')
    expect(screen.getByTestId('probe-picture')).toBeTruthy()
    // WO-469: the E-STOP control's visible word follows its MODE now, so a
    // substring of the cluster's text tests which mode this fixture mounted in
    // rather than that the control is there. Ask for the control instead - the
    // property this line has always been about - and keep it pinned INSIDE the
    // probe cluster, which the substring was the only thing checking.
    expect(
      expectOneEstopControl().closest('[data-testid="control-probe-command-cluster"]'),
    ).toBeTruthy()
  })

  // WO-2063 (v2 brief): the words "MESH COMPENSATION ACTIVE" and the measured
  // height colours were marks of the old surface-map diagram and target line,
  // retired with them. The active mesh's own control stays in the setup.
  it('an active mesh offers its Disable compensation control in the Z surface setup', () => {
    act(() => useMachineControl.getState().setSurfaceMesh(activeMesh()))
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))

    const disable = screen.getByTestId('control-surface-mesh-disable') as HTMLButtonElement
    expect(disable.disabled).toBe(false)
    expect(screen.getByTestId('control-probe-setup-card').contains(disable)).toBe(true)
    // Negative control: with no mesh armed there is nothing to disable.
    act(() => useMachineControl.getState().setSurfaceMesh(null))
    expect(screen.queryByTestId('control-surface-mesh-disable')).toBeNull()
  })
})
