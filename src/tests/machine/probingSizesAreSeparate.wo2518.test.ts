// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

// Observe real planning calls from the production panel and picture, without motion.
vi.mock('../../lib/machine/probeFeatureCycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/probeFeatureCycle')>()
  return typedMock<typeof import('../../lib/machine/probeFeatureCycle')>({
    ...actual, planFeatureProbeCycle: vi.fn(actual.planFeatureProbeCycle),
  })
})
const { planFeatureProbeCycle } = await import('../../lib/machine/probeFeatureCycle')
const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

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
  memory.clear()
  __resetProbingSessionForTest()
  useCamStore.getState().newProject()
  useCamStore.getState().setDisplayUnits('mm')
  useMachineControl.setState({
    connectionPhase: 'connected', connectionKind: 'serial', machineState: 'idle',
    activeWcs: 'G54', activeTool: null, tlo: null, homed: true,
    settings: { 130: '600', 131: '600', 132: '100' },
    mpos: { x: 300, y: 300, z: 50 }, wpos: { x: 0, y: 0, z: 10 },
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  vi.mocked(planFeatureProbeCycle).mockClear()
})
afterEach(cleanup)

function pick(kind: string) { fireEvent.click(screen.getByTestId(`control-work-probe-routine-${kind}`)) }
function input(field: string) { return screen.getByTestId(`control-work-probe-nominal-${field}`) as HTMLInputElement }
function type(field: string, value: string) {
  fireEvent.change(input(field), { target: { value } })
  fireEvent.blur(input(field))
}
function expectPlan(kind: string, x: number, y: number) {
  const calls = vi.mocked(planFeatureProbeCycle).mock.calls.filter(([request]) => request.kind === kind)
  // Distinguish the real machine request from the schematic scene planner.
  const cycle = calls.filter(([request]) => request.start.x === 300)
  const picture = calls.filter(([request]) => request.start.x !== 300)
  for (const route of [cycle, picture]) {
    expect(route.length).toBeGreaterThan(0)
    expect(route.at(-1)![0]).toMatchObject({ nominalSizeXmm: x, nominalSizeYmm: y })
  }
}

describe('WO-2518 circular diameter and rectangular widths are separate in the Probing panel', () => {
  it('Rect boss Width X 64 leaves the default Bore diameter 25', () => {
    render(React.createElement(ProbingPanel))
    pick('rectBoss')
    type('x', '64')
    expectPlan('rectBoss', 64, 25)
    pick('bore')
    expect(input('diameter').value).toBe('25.00')
    expectPlan('bore', 25, 25)
  })

  it.each(['bore', 'boss'])('%s retains its last diameter after both rectangular routines change', (round) => {
    render(React.createElement(ProbingPanel))
    pick(round)
    type('diameter', '43.5')
    for (const rect of ['rectPocket', 'rectBoss']) {
      pick(rect)
      type('x', '64')
      type('y', '48')
      expectPlan(rect, 64, 48)
      pick(round)
      expect(input('diameter').value).toBe('43.50')
      expectPlan(round, 43.5, 43.5)
    }
  })

  it('changing diameter leaves Rect X/Y intact, including after leaving the panel', () => {
    const mounted = render(React.createElement(ProbingPanel))
    pick('rectPocket')
    type('x', '64')
    type('y', '48')
    pick('boss')
    expect(input('diameter').value).toBe('25.00')
    type('diameter', '43.5')
    mounted.unmount()
    render(React.createElement(ProbingPanel))
    expect(input('diameter').value).toBe('43.50')
    pick('rectBoss')
    expect(input('x').value).toBe('64.00')
    expect(input('y').value).toBe('48.00')
    expectPlan('rectBoss', 64, 48)
  })

  it('Calibrate uses its reference diameter independently of both remembered sizes', () => {
    render(React.createElement(ProbingPanel))
    pick('bore')
    type('diameter', '43.5')
    pick('rectBoss')
    type('x', '64')
    type('y', '48')
    pick('calibrate')
    const ref = screen.getByTestId('control-calibrate-reference-diameter') as HTMLInputElement
    fireEvent.change(ref, { target: { value: '30' } })
    fireEvent.blur(ref)
    expectPlan('boss', 30, 30)
    pick('bore')
    expect(input('diameter').value).toBe('43.50')
    pick('rectPocket')
    expect(input('x').value).toBe('64.00')
    expect(input('y').value).toBe('48.00')
  })
})
