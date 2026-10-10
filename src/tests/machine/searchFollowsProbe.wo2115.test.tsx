// @vitest-environment jsdom
//
// WO-2115 - the running picture follows the real probe during a search.
//
// The walkthrough of 2026-09-28 (native Edge, top search): the drawn probe
// reached the top ~5 mm early (machine still at Z 48.7) and waited ~1.5 s for
// the real touch. The top search starts at any height up to the search above
// the top, and the picture draws that start at one height; followed at the
// drawn distance, a start higher than drawn reached the drawn top early.
//
// Through the real ProbingPanel; only the routine runner is stubbed (it never
// resolves - the machine position stream drives the picture, as on the
// machine).

import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

type CycleResult = Awaited<ReturnType<typeof import('../../lib/machine/machineSession').runFeatureProbeCycle>>
const runFeatureProbeCycle = vi.fn(() => new Promise<CycleResult>(() => {}))

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle,
    setWorkOffsetValue: vi.fn(() => true),
  })
})

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

const SETTINGS = { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' }
const START = { x: -50, y: -50, z: -10 }
type P = { x: number; y: number; z: number }

beforeEach(() => {
  // Each report drawn as it comes (the glide between reports is the screen's
  // own frame rate; the 5 fps strips in src/tests/evidence/WO-2115 show it).
  vi.stubGlobal('requestAnimationFrame', undefined)
  __resetProbingSessionForTest()
  memory.clear()
  runFeatureProbeCycle.mockClear()
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
    settings: SETTINGS,
    mpos: { ...START },
    wpos: { x: 5, y: 0, z: 10 },
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const realZ = () => Number((screen.getByTestId('probe-picture').getAttribute('data-real') ?? '').split(',')[2])
const label = () => screen.getByTestId('probe-move-label').textContent ?? ''
const at = async (pos: P) => { await act(async () => { useMachineControl.setState({ mpos: pos }) }) }

async function startEdge() {
  render(React.createElement(ProbingPanel))
  fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
  const drawnStartZ = realZ()
  await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
  expect(runFeatureProbeCycle).toHaveBeenCalledTimes(1)
  // WO-2557: the screen stays on its preview until the machine reports motion.
  expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('preview')
  return drawnStartZ
}

describe('WO-2115 the running picture follows the real probe during the top search', () => {
  it('a start higher than drawn: the drawn probe tracks the machine down and reaches the top only at the real touch', async () => {
    const drawnStartZ = await startEdge()
    // The drawn top is z 0; the start is drawn 10 mm above it; the search is 25 mm.
    expect(drawnStartZ).toBeCloseTo(10, 3)
    // The real top is 22 mm below where the operator left the probe - higher
    // than drawn, inside the 25 mm search.
    const topMachineZ = START.z - 22
    let prev = drawnStartZ
    for (let d = 1; d <= 21.5; d += 0.5) {
      await at({ ...START, z: START.z - d })
      const z = realZ()
      // It follows the machine: every report down moves the drawn probe down.
      expect(z).toBeLessThan(prev)
      prev = z
      // Never ahead of the machine: the drawn probe has not covered more of
      // the drawn distance than the machine has of its search to the real top.
      const drawnShare = (drawnStartZ - z) / drawnStartZ
      const realShare = d / 22
      expect(drawnShare).toBeLessThanOrEqual(realShare + 1e-9)
      // Not on the top while the real probe is still in the air (today: on
      // the drawn top from 10 mm down, 12 mm before the touch).
      expect(z).toBeGreaterThan(0.5)
      // The distance counts the search left.
      expect(label()).toBe(`Z- up to ${Number((25 - d).toFixed(1))} mm`)
    }
    // The real touch, then the back-off: the drawn probe is at the top, lit.
    await at({ ...START, z: topMachineZ })
    await at({ ...START, z: topMachineZ + 0.5 })
    expect(realZ()).toBeLessThan(1)
    expect(realZ()).toBeGreaterThanOrEqual(0)
    const picture = screen.getByTestId('probe-picture')
    expect(within(picture).getByTestId('probe-touch-lit')).toBeTruthy()
  })

  it('a start lower than drawn: the drawn probe is still in the air until the touch, then on the top', async () => {
    const drawnStartZ = await startEdge()
    // The real top is 6 mm below the start.
    for (let d = 1; d <= 6; d += 1) {
      await at({ ...START, z: START.z - d })
      expect(realZ()).toBeGreaterThan(0.5)
      expect(realZ()).toBeLessThan(drawnStartZ)
    }
    await at({ ...START, z: START.z - 5.5 })
    expect(realZ()).toBeLessThan(1)
    expect(within(screen.getByTestId('probe-picture')).getByTestId('probe-touch-lit')).toBeTruthy()
  })
})
