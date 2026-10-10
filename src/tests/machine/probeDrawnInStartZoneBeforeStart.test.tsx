// @vitest-environment jsdom
//
// the owner's machine-proven probing picture (sessions 09-26..10-04, approved screen WO-2063):
// before Start, the probe is drawn in the start zone the step tells him to jog to - wherever
// the machine really is. WO-2558 drew it at the machine's position instead, pinned to the
// picture's corner when the machine was elsewhere, and was reverted 2026-10-04. Enters through
// the production panel with a connected machine far from the feature.

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
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

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', undefined)
  __resetProbingSessionForTest()
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'serial',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    homed: true,
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const ROUTINES = ['edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'workZero']
// Machine far from every feature (the 10-04 capture had work X 150), and near-but-outside.
const POSITIONS = [[150, 0, 10], [-150, 150, 200], [150, -150, -200], [40, 40, 60]] as const

const num = (el: Element, key: string) => Number(el.getAttribute(key))

describe('before Start the probe is drawn in its start zone, wherever the machine is', () => {
  it.each(POSITIONS)('machine at work (%s, %s, %s)', (x, y, z) => {
    useMachineControl.setState({ wpos: { x, y, z }, mpos: { x: x + 200, y: y + 200, z: z + 70 } })
    render(React.createElement(ProbingPanel))
    let checked = 0
    for (const kind of ROUTINES) {
      fireEvent.click(screen.getByTestId(`control-work-probe-routine-${kind}`))
      const zone = screen.queryByTestId('probe-zone')
      if (!zone) continue
      const ball = screen.getByTestId('probe-side-probe').querySelector('circle')!
      const cx = num(ball, 'cx'), cy = num(ball, 'cy')
      const zx = num(zone, 'x'), zy = num(zone, 'y'), zw = num(zone, 'width'), zh = num(zone, 'height')
      expect({ kind, inX: cx >= zx - 0.01 && cx <= zx + zw + 0.01 }).toEqual({ kind, inX: true })
      expect({ kind, inZ: cy >= zy - 0.01 && cy <= zy + zh + 0.01 }).toEqual({ kind, inZ: true })
      checked++
    }
    // Every face-touching routine the owner proved shows a start zone; at least these must be checked.
    expect(checked).toBeGreaterThanOrEqual(6)
  })
})
