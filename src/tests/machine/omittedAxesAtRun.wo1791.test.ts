// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import type { MachinePosition } from '../../lib/machine/types'

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
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setMachinePosition,
  setMachineSingleBlock,
  zeroWorkAxes,
} = await import('../../lib/machine/machineSession')

const LOAD_MACHINE_POSITION = { x: 10, y: 20, z: 30 }
const RUN_AT = { x: 40, y: 50, z: 0 }
const RUN_MACHINE_POSITION = { x: 50, y: 70, z: 30 }
/** WO-2004: G54 is zeroed at LOAD_MACHINE_POSITION, and the simulator stages a
 *  file's work coordinates through it as the bridge does: work Z 53 is machine
 *  Z 83, work X70 Y80 is machine X80 Y100. */
const G54_Z53_MACHINE_Z = 53 + LOAD_MACHINE_POSITION.z
const G54_X70_Y80_MACHINE = { x: 70 + LOAD_MACHINE_POSITION.x, y: 80 + LOAD_MACHINE_POSITION.y }

beforeEach(async () => {
  vi.useFakeTimers()
  mem.clear()
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine!
  const configured = {
    ...machine,
    noHomingSwitches: true,
    rapidRate: 6000,
    travel: { x: 300, y: 300, z: 150 },
    // WO-2712: the GRBL Sample router now defaults its home end to max; this
    // fixture's positive work moves predate it, so it is its own machine (not the
    // sample) and keeps the unplaced record.
    id: 'wo1791-positive-router',
    homeConvention: undefined,
  }
  useCamStore.getState().updateMachine(configured)
  useCamStore.setState((state) => ({
    machineWorkOffsets: {
      ...state.machineWorkOffsets,
      [configured.id]: { G54: { offset: { x: 0, y: 0, z: 0 }, state: 'sent' } },
    },
  }))
  await connectMachine('simulator')
  __resetEstopInterlockForTest()
  expect(setMachinePosition(LOAD_MACHINE_POSITION).ok).toBe(true)
  expect(zeroWorkAxes(['X', 'Y', 'Z']).ok).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  useMachineControl.getState().clearConsole()
})

afterEach(async () => {
  cleanup()
  setMachineSingleBlock(false)
  clearPathFidelity()
  await disconnectMachine()
  vi.useRealTimers()
})

async function runAndTrace(milliseconds: number): Promise<MachinePosition[]> {
  const trace: MachinePosition[] = []
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 20) {
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    const point = getMachineController().status().machinePos
    if (point) trace.push({ ...point })
  }
  return trace
}

async function jogToRunPosition(): Promise<void> {
  const ctrl = getMachineController()
  expect(ctrl.jogToWorkXY(RUN_AT.x, RUN_AT.y, 6000)).toBe(true)
  await runAndTrace(800)
  expect(ctrl.status().workPos).toMatchObject(RUN_AT)
}

function expectZThenXY(trace: MachinePosition[], z: number, end: MachinePosition): void {
  const firstXY = trace.findIndex((point) =>
    Math.abs(point.x - RUN_MACHINE_POSITION.x) > 1e-6 || Math.abs(point.y - RUN_MACHINE_POSITION.y) > 1e-6)
  expect(firstXY).toBeGreaterThan(0)
  for (const point of trace.slice(0, firstXY)) {
    expect(point.x).toBeCloseTo(RUN_MACHINE_POSITION.x, 6)
    expect(point.y).toBeCloseTo(RUN_MACHINE_POSITION.y, 6)
  }
  expect(trace[firstXY - 1].z).toBeCloseTo(z, 6)
  expect(trace.at(-1)).toMatchObject(end)
}

describe('WO-1791 execution-time omitted-axis position', () => {
  it('load at A, jog to B, Cycle Start: Z-only motion holds B through the whole Z segment', async () => {
    expect(loadGcodeTextToolpathProgram(
      'wo1791-z-only.nc',
      'G21 G90 G54\nG0 Z53\nG0 X70 Y80\nM30\n',
      { publishListing: true },
    )).toEqual({ ok: true, reason: null })

    // This is the operator sequence from the incident: the file was staged at
    // A, then the machine position changed before the first release.
    await jogToRunPosition()

    expect(await executeOperatorCycleStart()).toBe(true)
    const trace = await runAndTrace(1800)
    expectZThenXY(trace, G54_Z53_MACHINE_Z, { ...G54_X70_Y80_MACHINE, z: G54_Z53_MACHINE_Z })

    const listing = useMachineControl.getState().stagedProgram
    expect(listing?.program.steps[0]).toMatchObject({ kind: 'line', to: { z: 53 } })
    expect(listing?.program.steps[0]).not.toMatchObject({ to: { x: expect.any(Number), y: expect.any(Number) } })
  })

  it('re-reads an initial G91 move at Cycle Start so its distance begins at B, not A', async () => {
    expect(loadGcodeTextToolpathProgram(
      'wo1791-incremental.nc',
      'G21 G91 G54\nG0 X5\nM30\n',
    )).toEqual({ ok: true, reason: null })
    await jogToRunPosition()

    expect(await executeOperatorCycleStart()).toBe(true)
    await runAndTrace(500)
    // B is machine X 50; an incremental +5 ends at machine X 55 (work X 45).
    expect(getMachineController().status().machinePos).toMatchObject({ x: 55, y: 70, z: 30 })
    expect(getMachineController().status().workPos).toMatchObject({ x: 45, y: 50, z: 0 })
  })

  it('uses the same fresh-position door for the first Single Block press', async () => {
    expect(loadGcodeTextToolpathProgram(
      'wo1791-single-block.nc',
      'G21 G90 G54\nG0 Z53\nG0 X70 Y80\nM30\n',
    )).toEqual({ ok: true, reason: null })
    await jogToRunPosition()
    setMachineSingleBlock(true)

    expect(await executeOperatorCycleStart()).toBe(true)
    const trace = await runAndTrace(800)
    expect(trace.every((point) => Math.abs(point.x - RUN_MACHINE_POSITION.x) < 1e-6)).toBe(true)
    expect(trace.every((point) => Math.abs(point.y - RUN_MACHINE_POSITION.y) < 1e-6)).toBe(true)
    expect(getMachineController().status().machinePos).toMatchObject({ x: 50, y: 70, z: G54_Z53_MACHINE_Z })
  })
})
