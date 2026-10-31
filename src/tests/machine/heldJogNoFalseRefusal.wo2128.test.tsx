// @vitest-environment jsdom
//
// WO-2128 - A HELD JOG NEVER PRINTS A FALSE REFUSAL.
//
// Operator, 2026-09-28 7:36 AM, on the in-app simulator (LienCNC V2): holding X-
// in Cont printed "Jog X: refused - the controller did not take the jog (it
// reads jog) ... Nothing moved" while the axis was moving at X 98.3.
//
// ROOT CAUSE: the simulator has no native continuous jog, so the panel sends
// a burst of step jogs, each feed x 150 ms x 1.5. The queue ran ahead of the
// machine without bound; the simulator checks each new step against the END
// OF ITS QUEUE, so after a few seconds the queued end passed the travel limit
// while the machine was still far inside it, and the session - which checks
// the CURRENT position - printed the fallback line that says nothing moved.
//
// Driven here through the real JogPanel, the real session singleton and the
// real SimulatedController on Operator's own profile, docs/machine/profiles/
// LienCNCV2.machine.json. Nothing injects a machine state.
//
// NOT CLAIMED: the UCCNC bridge or LinuxCNC. Both have a native continuous
// jog and never take the burst route; that route is pinned below as untouched.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineConfig } from '../../types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => [...mem.keys()][index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } as Storage,
  configurable: true,
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { JogPanel } = await import('../../components/machine/JogPanel')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { __resetEstopInterlockForTest, connectMachine, disconnectMachine, getMachineController } = session

const PROFILE = JSON.parse(readFileSync(
  resolve('docs/machine/profiles/LienCNCV2.machine.json'),
  'utf8',
)) as MachineConfig

const X_MAX = 738
const Z_MAX = 129.1
const FEED = 5000

function consoleLines(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

function jogLines(axis: string): string[] {
  return consoleLines().filter((line) => line.startsWith(`Jog ${axis}`))
}

async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function install(target: MachineConfig): void {
  useCamStore.setState((state) => ({
    machineLibrary: [target],
    project: { ...state.project, machine: target, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  }))
}

let originalState: ReturnType<typeof useCamStore.getState>
let savedPrefs: Pick<ReturnType<typeof useUiPrefs.getState>,
  'machineJogStepMm' | 'machineJogContinuous' | 'machineJogFeedMmMin'>

beforeEach(() => {
  vi.useFakeTimers()
  originalState = useCamStore.getState()
  const prefs = useUiPrefs.getState()
  savedPrefs = {
    machineJogStepMm: prefs.machineJogStepMm,
    machineJogContinuous: prefs.machineJogContinuous,
    machineJogFeedMmMin: prefs.machineJogFeedMmMin,
  }
  useMachineControl.setState({ consoleLines: [], alarm: null, singleBlock: false })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useUiPrefs.setState(savedPrefs)
  useCamStore.setState({
    project: originalState.project,
    machineLibrary: originalState.machineLibrary,
    control: originalState.control,
  })
  act(() => { __resetEstopInterlockForTest() })
  useMachineControl.setState({ consoleLines: [], alarm: null })
  vi.useRealTimers()
})

/** Connect Simulate LienCNC V2, home it, park at a machine position. */
async function connectHomedAt(at: { x: number; z: number }) {
  install(PROFILE)
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(1)
  await pending
  __resetEstopInterlockForTest()
  const ctrl = getMachineController()
  expect(ctrl.jogStartContinuous).toBeUndefined()
  expect(ctrl.home()).toBe(true)
  await settle(60_000)
  expect(ctrl.machineState()).toBe('idle')
  const pos = ctrl.status().machinePos!
  expect(ctrl.jog('X', at.x - pos.x, 60_000)).toBe(true)
  expect(ctrl.jog('Z', at.z - pos.z, 60_000)).toBe(true)
  await settle(10_000)
  expect(ctrl.machineState()).toBe('idle')
  expect(ctrl.status().machinePos!.x).toBeCloseTo(at.x, 3)
  expect(ctrl.status().machinePos!.z).toBeCloseTo(at.z, 3)
  useMachineControl.setState({ consoleLines: [] })
  return ctrl
}

function contPanel(): void {
  useUiPrefs.setState({ machineJogContinuous: true, machineJogFeedMmMin: FEED, machineJogStepMm: 10 })
  render(createElement(JogPanel))
}

/** Hold a jog button for `holdMs`, sampling the position every 250 ms. */
async function hold(testid: string, holdMs: number): Promise<number[]> {
  const ctrl = getMachineController()
  const button = screen.getByTestId(testid) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  const samples: number[] = []
  act(() => { fireEvent.pointerDown(button) })
  for (let t = 0; t < holdMs; t += 250) {
    await settle(250)
    const key = testid.includes('-x-') ? 'x' : 'z'
    samples.push(ctrl.status().machinePos![key])
  }
  act(() => { fireEvent.pointerUp(button) })
  return samples
}

describe('WO-2128: a held Cont jog on the simulator prints nothing false', () => {
  it('X- held for 4 s from mid-travel at 5000 mm/min: moves while held, no refusal, stops on release', async () => {
    const ctrl = await connectHomedAt({ x: 400, z: 100 })
    contPanel()
    const samples = await hold('control-jog-x-minus', 4_000)
    const released = ctrl.status().machinePos!.x
    // It moved the whole time the finger was down.
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeLessThan(samples[i - 1])
    expect(released).toBeLessThan(400 - 200)
    expect(released).toBeGreaterThan(0)
    // Nothing false: no refusal of any kind while the axis moved inside travel.
    expect(jogLines('X'), consoleLines().join('\n')).toEqual([])
    expect(consoleLines().join('\n')).not.toContain('Nothing moved')
    // Released: it stops, and close to where the finger came off.
    await settle(3_000)
    const stopped = ctrl.status().machinePos!.x
    expect(ctrl.machineState()).toBe('idle')
    expect(released - stopped).toBeGreaterThanOrEqual(0)
    expect(released - stopped).toBeLessThan(40)
    await settle(2_000)
    expect(ctrl.status().machinePos!.x).toBeCloseTo(stopped, 6)
  }, 60_000)

  it('Z- held for 4 s at 5000 mm/min from high Z: stops at the end of travel, at most one true line', async () => {
    const ctrl = await connectHomedAt({ x: 400, z: 125 })
    contPanel()
    await hold('control-jog-z-minus', 4_000)
    await settle(3_000)
    const z = ctrl.status().machinePos!.z
    expect(ctrl.machineState()).toBe('idle')
    // At the end of the travel, not short of it and never past it.
    expect(z).toBeGreaterThanOrEqual(0 - 1e-6)
    expect(z).toBeLessThan(0.5)
    expect(jogLines('Z'), consoleLines().join('\n')).toEqual([
      'Jog Z-: Z reached the end of its travel at machine Z 0.000 and stopped there.',
    ])
    expect(consoleLines().join('\n')).not.toContain('Nothing moved')
    expect(consoleLines().join('\n')).not.toContain('did not take the jog')
    expect(useMachineControl.getState().consoleLines.filter((l) => l.severity === 'error')).toEqual([])
  }, 60_000)

  it('X+ held past the far end: stops at X 738, never beyond, at most one line', async () => {
    const ctrl = await connectHomedAt({ x: 600, z: 100 })
    contPanel()
    await hold('control-jog-x-plus', 5_000)
    await settle(3_000)
    const x = ctrl.status().machinePos!.x
    expect(x).toBeLessThanOrEqual(X_MAX + 1e-6)
    expect(x).toBeGreaterThan(X_MAX - 0.5)
    expect(jogLines('X'), consoleLines().join('\n')).toEqual([
      'Jog X+: X reached the end of its travel at machine X 738.000 and stopped there.',
    ])
    expect(consoleLines().join('\n')).not.toContain('Nothing moved')
  }, 60_000)

  it('Z+ held from near the top: the run-ahead never stops it short of the end', async () => {
    const ctrl = await connectHomedAt({ x: 400, z: 20 })
    contPanel()
    await hold('control-jog-z-plus', 4_000)
    await settle(3_000)
    expect(ctrl.status().machinePos!.z).toBeGreaterThan(Z_MAX - 0.5)
    expect(ctrl.status().machinePos!.z).toBeLessThanOrEqual(Z_MAX + 1e-6)
    expect(consoleLines().join('\n')).not.toContain('Nothing moved')
  }, 60_000)

  it('unhomed: a held X- from where the simulator powers up still ends at the travel end, nothing false', async () => {
    install(PROFILE)
    const pending = connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(1)
    await pending
    __resetEstopInterlockForTest()
    const ctrl = getMachineController()
    expect(ctrl.homedThisSession()).toBe(false)
    const start = ctrl.status().machinePos!
    expect(ctrl.jog('X', 100 - start.x, 60_000)).toBe(true)
    await settle(5_000)
    useMachineControl.setState({ consoleLines: [] })
    contPanel()
    await hold('control-jog-x-minus', 3_000)
    await settle(3_000)
    expect(ctrl.status().machinePos!.x).toBeGreaterThanOrEqual(0 - 1e-6)
    expect(ctrl.status().machinePos!.x).toBeLessThan(0.5)
    expect(consoleLines().join('\n')).not.toContain('Nothing moved')
    expect(jogLines('X'), consoleLines().join('\n')).toEqual([
      'Jog X-: X reached the end of its travel at machine X 0.000 and stopped there.',
    ])
  }, 60_000)

  it('a position reported only once a second (GRBL while idle) never stalls the held jog', async () => {
    const ctrl = await connectHomedAt({ x: 400, z: 100 })
    // The burst route's other backend reports position at 1 Hz until it sees
    // itself jogging. Serve the panel a snapshot refreshed once a second.
    const live = ctrl.status.bind(ctrl)
    let snapshot = live()
    let takenAt = Date.now()
    ctrl.status = () => {
      if (Date.now() - takenAt >= 1000) { snapshot = live(); takenAt = Date.now() }
      return snapshot
    }
    try {
      contPanel()
      const samples: number[] = []
      const button = screen.getByTestId('control-jog-x-minus') as HTMLButtonElement
      act(() => { fireEvent.pointerDown(button) })
      for (let t = 0; t < 3_000; t += 100) {
        await settle(100)
        samples.push(live().machinePos!.x)
      }
      act(() => { fireEvent.pointerUp(button) })
      // Every 100 ms of the hold after the first step, the axis moved.
      for (let i = 1; i < samples.length; i++) expect(samples[i], samples.join(' ')).toBeLessThan(samples[i - 1])
      expect(400 - samples[samples.length - 1]).toBeGreaterThan(200)
      expect(jogLines('X'), consoleLines().join('\n')).toEqual([])
    } finally {
      ctrl.status = live
    }
  }, 60_000)

  it('unhomed real controller (GRBL, soft limits off): a held Z+ from its power-up MPos keeps jogging, never clamped', async () => {
    // WO-2128 audit: an unhomed GRBL powers up at MPos 0, which the profile's
    // box calls the Z max end. That end is not a fact about the table, and the
    // controller (soft limits off) accepts every step. The panel must keep
    // sending while the finger is down, as it always did.
    install(PROFILE)
    const pending = connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(1)
    await pending
    __resetEstopInterlockForTest()
    const ctrl = getMachineController()
    expect(ctrl.homedThisSession()).toBe(false)
    const liveJog = ctrl.jog.bind(ctrl)
    const liveStatus = ctrl.status.bind(ctrl)
    // GRBL-shaped: every jog accepted, MPos follows what was sent.
    let z = Z_MAX
    const sent: number[] = []
    ctrl.jog = (axis, distance) => {
      if (axis === 'Z') { sent.push(distance); z += distance }
      return true
    }
    ctrl.status = () => {
      const snap = liveStatus()
      return { ...snap, machinePos: { ...snap.machinePos!, z } }
    }
    try {
      act(() => { useMachineControl.setState({ connectionKind: 'serial', homed: false, consoleLines: [] }) })
      useUiPrefs.setState({ machineJogContinuous: true, machineJogFeedMmMin: 1000, machineJogStepMm: 10 })
      render(createElement(JogPanel))
      const button = screen.getByTestId('control-jog-z-plus') as HTMLButtonElement
      expect(button.disabled).toBe(false)
      act(() => { fireEvent.pointerDown(button) })
      await settle(3_000)
      act(() => { fireEvent.pointerUp(button) })
      // Every 150 ms interval sent a step: about 21 in 3 s, not one.
      expect(sent.length, sent.join(' ')).toBeGreaterThanOrEqual(15)
      for (const d of sent) expect(d).toBeGreaterThan(0)
      expect(z).toBeGreaterThan(Z_MAX + 30)
      expect(jogLines('Z'), consoleLines().join('\n')).toEqual([])
    } finally {
      ctrl.jog = liveJog
      ctrl.status = liveStatus
    }
  }, 60_000)

  // The real board, 2026-10-30: a step sent past a stated soft limit latched
  // the controller. A step past the end now stops just inside it and says so.
  it('a 50 mm step past the end stops just inside the soft limit and says so', async () => {
    const ctrl = await connectHomedAt({ x: 20, z: 100 })
    useUiPrefs.setState({ machineJogContinuous: false, machineJogFeedMmMin: FEED, machineJogStepMm: 50 })
    render(createElement(JogPanel))
    const xMinus = screen.getByTestId('control-jog-x-minus') as HTMLButtonElement
    act(() => { fireEvent.pointerDown(xMinus) })
    act(() => { fireEvent.pointerUp(xMinus) })
    await settle(2_000)
    expect(ctrl.status().machinePos!.x).toBeCloseTo(0.01, 3)
    expect(consoleLines().join('\n')).toContain('Jog stopped at the X soft limit (')
    // An in-travel step still moves exactly its step.
    act(() => { useUiPrefs.setState({ machineJogStepMm: 10 }) })
    const xPlus = screen.getByTestId('control-jog-x-plus') as HTMLButtonElement
    act(() => { fireEvent.pointerDown(xPlus) })
    act(() => { fireEvent.pointerUp(xPlus) })
    await settle(2_000)
    expect(ctrl.status().machinePos!.x).toBeCloseTo(10.01, 3)
  }, 60_000)
})
