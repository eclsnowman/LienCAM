// @vitest-environment jsdom
//
// WO-2008: the Control tab stops nagging, part two - through the real session
// on the simulated controller.
//   (a) a leftover finished/idle controller job is not "the program is still
//       running"; a job that really runs still refuses.
//   (c) a path check prints ONE console row and never downloads a file.
//   (d) a disabled Measure / Add tool says why.

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineConfig, Project, Setup, ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeStock, makeWcs } from '../post/helpers'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGeometryProgram,
  setPathToleranceMm,
  __reportWorkOffsetsForTest,
} = await import('../../lib/machine/machineSession')

const TRACE = { opId: 'op1', setupId: 'setup1' }
const STILL_RUNNING = 'The program is still running'

function machine(): MachineConfig {
  return makeMachine({
    id: 'wo2008-machine',
    name: 'WO-2008 Test Machine',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
  })
}

function setup(): Setup {
  return {
    id: 'setup1',
    name: 'Setup 1',
    wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 10, y: 5, z: 2 } }),
    stock: makeStock({ material: 'aluminum' }),
    operations: [makeOp({ id: 'op1', name: 'Contour', type: 'contour_2d' })],
    notes: '',
  }
}

function toolpath(): ToolpathMove[] {
  return [
    { type: 'rapid', x: 10, y: 5, z: 22 },
    { type: 'feed', x: 10, y: 5, z: 1, feed: 300 },
    { type: 'feed', x: 60, y: 5, z: 1, feed: 900 },
    { type: 'feed', x: 60, y: 45, z: 1, feed: 900 },
  ]
}

const consoleTexts = (): string[] => useMachineControl.getState().consoleLines.map((line) => line.text)

let originalProject: Project

beforeEach(async () => {
  vi.useFakeTimers()
  originalProject = useCamStore.getState().project
  useCamStore.setState((s) => ({
    project: { ...s.project, machine: machine(), setups: [setup()], activeSetupId: 'setup1' },
  }))
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  if (!getMachineController().home()) throw new Error('The simulator refused the homed fixture.')
  await vi.advanceTimersByTimeAsync(2_000)
  getMachineController().refreshState()
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(300)
  await pending
  useCamStore.setState({ project: originalProject })
  clearPathFidelity()
  setPathToleranceMm(null)
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

describe('WO-2008 (a): "still running" only while a program really runs', () => {
  it('a leftover flag on an idle, fully acknowledged job does not refuse a load', () => {
    const ctrl = getMachineController()
    vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(true)
    vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
    vi.spyOn(ctrl, 'jobProgress').mockReturnValue({
      phase: 'streaming', totalLines: 4, sentLines: 4, ackedLines: 4,
      ackedSourceLine: 4, sentSourceLine: 4, bytesInFlight: 0,
    })
    const result = loadGeometryProgram('wo2008-leftover', toolpath(), TRACE)
    expect(result.ok).toBe(true)
    expect(consoleTexts().some((text) => text.includes(STILL_RUNNING))).toBe(false)
  })

  it('a leftover flag does not refuse the load after the work-offset reply either', async () => {
    const ctrl = getMachineController()
    __reportWorkOffsetsForTest({ G54: { x: 10, y: 5, z: 2 } })
    ;(ctrl as unknown as { selectWcsAwait: () => Promise<boolean> }).selectWcsAwait = () => Promise.resolve(true)
    vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(true)
    vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
    vi.spyOn(ctrl, 'jobProgress').mockReturnValue({
      phase: 'streaming', totalLines: 4, sentLines: 4, ackedLines: 4,
      ackedSourceLine: 4, sentSourceLine: 4, bytesInFlight: 0,
    })
    const door = loadGeometryProgram('wo2008-leftover-async', toolpath(), TRACE)
    expect(door.reason).toBeNull()
    expect(door.ok).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(consoleTexts().some((text) => text.includes('started running before its work offset'))).toBe(false)
    expect(consoleTexts().some((text) => text.includes(STILL_RUNNING))).toBe(false)
  })

  it('control: a job that really runs still refuses the load', async () => {
    expect(loadGeometryProgram('wo2008-first', toolpath(), TRACE).ok).toBe(true)
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(60)
    expect(getMachineController().hasActiveJob()).toBe(true)
    const result = loadGeometryProgram('wo2008-second', toolpath(), TRACE)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain(STILL_RUNNING)
  })

  it('control: an idle job with moves still to go is running, not a leftover', () => {
    const ctrl = getMachineController()
    vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(true)
    vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
    vi.spyOn(ctrl, 'jobProgress').mockReturnValue({
      phase: 'streaming', totalLines: 4, sentLines: 4, ackedLines: 1,
      ackedSourceLine: 1, sentSourceLine: 4, bytesInFlight: 0,
    })
    expect(loadGeometryProgram('wo2008-mid', toolpath(), TRACE).ok).toBe(false)
  })
})

describe('WO-2008 (c): a path check is one row and never a download', () => {
  it('a finished run prints at most one path-check row and clicks no download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    // A tolerance no real run can meet, so the check has something to report.
    setPathToleranceMm(0.000001)
    expect(loadGeometryProgram('wo2008-path', toolpath(), TRACE).ok).toBe(true)
    const before = consoleTexts().length
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    const rows = consoleTexts().slice(before)
      .filter((text) => text.startsWith('Path check') || text.startsWith('  limit: '))
    expect(rows.length).toBeLessThanOrEqual(1)
    expect(rows.some((text) => text.startsWith('  limit: '))).toBe(false)
    expect(click).not.toHaveBeenCalled()
    expect(consoleTexts().some((text) => text.includes('Path check evidence saved'))).toBe(false)
  })
})

describe('WO-2008 (d): disabled controls say why', () => {
  it('Measure names the tool-change hold; Add tool asks for a tool number', () => {
    act(() => {
      useMachineControl.setState({ connectionPhase: 'connected', machineState: 'hold' })
    })
    render(<ToolsProbePanel />)
    const measure = screen.getByTestId('control-probe-measure')
    expect(measure.hasAttribute('disabled')).toBe(true)
    expect(measure.getAttribute('data-tooltip')).toMatch(/tool change/i)
    const add = screen.getByTestId('control-tool-add')
    expect(add.hasAttribute('disabled')).toBe(true)
    expect(add.getAttribute('data-tooltip')).toMatch(/tool number/i)
  })
})
