// @vitest-environment jsdom
//
// WO-3153: Full Suite's saved Adaptive Clearing 1 was planned by an older
// adaptive engine (10 rapids) yet carried the same stamp a fresh compute
// writes today (2,736 rapids), so Simulate played the old path while Control
// posted the new one. Both claims here go through the production entries:
// File Open (loadProjectFromFile), the mounted SimulationPanel, the store's
// computeOperationToolpath with the production toolpath worker in-thread, and
// the real CNCViewport window builder.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Operation, ToolpathMove } from '../../types'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key), clear: () => memory.clear(),
} })

// The PRODUCTION toolpath worker, run in this thread (same harness as WO-1908).
const workerScope: {
  onmessage: ((event: MessageEvent) => unknown) | null
  postMessage: (data: unknown) => void
  location: Location
} = { onmessage: null, postMessage: () => {}, location: window.location }
vi.stubGlobal('self', workerScope)
await import('../../lib/cam/toolpathWorker')
let activeWorker: { onmessage: ((event: MessageEvent) => void) | null } | null = null
workerScope.postMessage = (data) => activeWorker?.onmessage?.({ data } as MessageEvent)
class InProcessToolpathWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(data: unknown): void {
    activeWorker = this
    void workerScope.onmessage?.({ data } as MessageEvent)
  }
  terminate(): void { /* in-process */ }
}
const { useCamStore } = await import('../../store')
// A spy lives on in every later state object; each test starts from the real compute.
const realCompute = useCamStore.getState().computeOperationToolpath
const { operationGenerationIsCurrent } = await import('../../lib/cam/generationFingerprint')
const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')

// The shipped demo was regenerated after the revision; its selected pre-refresh artifact keeps
// the older engine's 10-rapid Adaptive Clearing 1 this test opens.
const FULL_SUITE = readFileSync('src/tests/evidence/WO-2935/attempt6/modeled.camproject', 'utf8')
const saved = JSON.parse(FULL_SUITE) as { setups: { id: string; operations: (Operation & { dependsOnPredecessors?: boolean })[] }[] }
const SETUP_ID = saved.setups[0].id
const ADAPTIVE = saved.setups[0].operations.find(op => op.name === 'Adaptive Clearing 1')!
const rapids = (moves: readonly ToolpathMove[] | undefined) => (moves ?? []).filter(move => move.type === 'rapid').length
const adaptive = () => useCamStore.getState().project.setups.find(s => s.id === SETUP_ID)!
  .operations.find(op => op.id === ADAPTIVE.id)!
const current = (op: Operation, setupId = SETUP_ID) => {
  const state = useCamStore.getState()
  const setup = state.project.setups.find(s => s.id === setupId)!
  return op.status === 'ready' && operationGenerationIsCurrent({ ...state.project, toolLibrary: state.toolLibrary }, setup, op)
}
async function openFullSuite() {
  const error = console.error
  console.error = () => {} // jsdom has no indexedDB for the scene cache; paths do not use it
  try { await act(async () => { await useCamStore.getState().loadProjectFromFile(FULL_SUITE) }) }
  finally { console.error = error }
}

let viewport: Pick<CNCViewport, 'setSimulationToolpathWindow'>
beforeEach(() => {
  vi.stubGlobal('self', workerScope)
  vi.stubGlobal('Worker', InProcessToolpathWorker)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  act(() => useCamStore.setState({ computeOperationToolpath: realCompute }))
  act(() => useCamStore.getState().newProject())
  viewport = Object.assign(Object.create(CNCViewport.prototype), {
    toolpathGroup: new THREE.Group(), toolpathRoleLines: new Map(),
    setToolMarkerPosition: vi.fn(), showToolMarker: vi.fn(),
    updateToolGeometry: vi.fn(), disposeStockSim: vi.fn(), disposeVoxelSim: vi.fn(),
    setStockSimOpacity: vi.fn(), supportsVoxelSim: vi.fn(() => false), initStockSim: vi.fn(() => null),
  }) as typeof viewport
  Object.defineProperty(window, '__cncViewport', { configurable: true, value: viewport })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, '__cncViewport')
})

describe('WO-3153: a path an older generator saved is not current', () => {
  it('File Open does not accept the saved 10-rapid Adaptive Clearing 1 as current', async () => {
    expect(rapids(ADAPTIVE.toolpathMoves)).toBe(10)
    await openFullSuite()
    const state = useCamStore.getState()
    const setup = state.project.setups.find(s => s.id === SETUP_ID)!
    const op = adaptive()
    expect(current(op) && rapids(op.toolpathMoves) === 10, 'the old engine path reads as current').toBe(false)
    // Setup 1's later operations read Adaptive Clearing 1's result
    // (dependsOnPredecessors), so they were built on the old path too.
    for (const later of setup.operations.filter(o => o.id !== ADAPTIVE.id)) {
      expect((later as { dependsOnPredecessors?: boolean }).dependsOnPredecessors === true && !current(later), later.name).toBe(true)
    }
    // Round 4: Generate All also moved these five paths under an unchanged
    // stamp (drill, contour_2d, adaptive_3d, parallel_3d); they renew too.
    // Face 1's planner did not change, so it stays current.
    const later = state.project.setups.filter(s => s.id !== SETUP_ID)
      .flatMap(other => other.operations.map(op => [op.name, current(op, other.id)]))
    expect(Object.fromEntries(later)).toEqual({
      'Drill 2': false, 'X part - 6mm rough': false, 'Face 1': true,
      '3D Rough 1': false, '3D Finish 3': false, 'Contour 2': false,
    })
    await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, ADAPTIVE.id) })
    const computed = adaptive()
    expect(computed.status, computed.errorMessage).toBe('ready')
    expect(current(computed)).toBe(true)
    expect(rapids(computed.toolpathMoves)).toBeGreaterThan(2000)
    expect(computed.generationFingerprint).not.toBe(ADAPTIVE.generationFingerprint)
  }, 120_000)

  it('Simulate regenerates it like Control does before Post and plays the regenerated rapids', async () => {
    // What the production compute makes from these inputs, for comparison.
    await openFullSuite()
    await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, ADAPTIVE.id) })
    const reference = JSON.stringify(adaptive().toolpathMoves)

    await openFullSuite()
    const compute = vi.spyOn(useCamStore.getState(), 'computeOperationToolpath')
    act(() => useCamStore.setState(state => ({
      project: { ...state.project, activeSetupId: SETUP_ID, activeOperationId: null },
      viewer: { ...state.viewer, mode: 'simulation', stockSimEnabled: false },
      appSettings: { ...state.appSettings, simulationEngine: 'heightmap' },
    })))
    render(createElement(SimulationPanel))
    // Old code never regenerates: the wait ends at once on the saved paths.
    const setupOps = () => useCamStore.getState().project.setups.find(s => s.id === SETUP_ID)!.operations
    await vi.waitFor(() => expect(setupOps().every(o => current(o) || o.status === 'error')).toBe(true),
      { timeout: 200_000, interval: 200 })
    // What Simulate plays: walk the whole timeline through contiguous trail windows.
    const windowPreview = vi.spyOn(viewport, 'setSimulationToolpathWindow')
    fireEvent.change(screen.getByRole('combobox', { name: 'Path display' }), { target: { value: 'trail' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Trail (recent seconds)' }), { target: { value: '60' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Lead (upcoming seconds)' }), { target: { value: '60' } })
    const slider = screen.getByRole('slider', { name: 'Simulation position' }) as HTMLInputElement
    const total = Number(slider.max)
    const played = new Set<unknown>()
    for (let ms = 0; ms <= total + 120_000; ms += 100_000) {
      fireEvent.change(slider, { target: { value: String(Math.min(ms, total)) } })
      for (const segment of windowPreview.mock.calls.at(-1)?.[0] ?? []) {
        const source = segment.frame.sourceMove
        if (segment.frame.sourceOperationId !== ADAPTIVE.id || source?.type !== 'rapid') continue
        expect(segment.frame.role).toBe('rapid')
        played.add(source)
      }
    }
    expect(played.size, 'Simulate plays the saved 10-rapid path').toBeGreaterThan(2000)
    // In setup order, each once: a predecessor regenerates before what reads it.
    expect(compute.mock.calls.map(call => call[1])).toEqual(saved.setups[0].operations.map(o => o.id))
    for (const o of setupOps()) expect(o.status, `${o.name}: ${o.errorMessage}`).toBe('ready')
    const op = adaptive()
    expect(JSON.stringify(op.toolpathMoves)).toBe(reference) // regenerated, never relabelled
    // Every regenerated rapid is played as a rapid; move 0 is the opening
    // position, which has no segment to draw on any route.
    expect(played.size).toBe(rapids(op.toolpathMoves!.slice(1)))
  }, 400_000)

  // Audit 2026-10-27: an edit made while Simulate regenerates an operation
  // makes the compute discard its result; the edited inputs were never tried.
  const editFeed = (feedRate: number) => {
    const op = adaptive()
    useCamStore.getState().updateOperation(SETUP_ID, op.id, {
      feedrateOverride: { ...op.feedrateOverride!, enabled: true, feedRate, plungeRate: 100 },
    })
  }
  const selectAdaptive = (setupId = SETUP_ID, operationId: string | null = ADAPTIVE.id) =>
    act(() => useCamStore.setState(state => ({
      project: { ...state.project, activeSetupId: setupId, activeOperationId: operationId },
      viewer: { ...state.viewer, mode: 'simulation', stockSimEnabled: false },
      appSettings: { ...state.appSettings, simulationEngine: 'heightmap' },
    })))
  const simulateAdaptiveOnly = () => {
    selectAdaptive()
    render(createElement(SimulationPanel))
  }
  const setMode = (mode: 'toolpath' | 'simulation') =>
    act(() => useCamStore.setState(state => ({ viewer: { ...state.viewer, mode } })))

  it('an edit during the regeneration is regenerated with the edited inputs, never left empty', async () => {
    await openFullSuite()
    const compute0 = useCamStore.getState().computeOperationToolpath
    let settled = 0
    const compute = vi.spyOn(useCamStore.getState(), 'computeOperationToolpath')
      .mockImplementation(async (...args) => { try { return await compute0(...args) } finally { settled++ } })
    // The operator edits the feed the moment Simulate's regeneration starts.
    const stop = useCamStore.subscribe(() => {
      if (adaptive().status !== 'computing') return
      stop()
      editFeed(321)
    })
    simulateAdaptiveOnly()
    await vi.waitFor(() => expect(settled).toBeGreaterThanOrEqual(1), { timeout: 200_000, interval: 100 })
    expect(adaptive().feedrateOverride?.feedRate).toBe(321)
    await vi.waitFor(() => expect(compute.mock.calls.length, 'the edited inputs are never regenerated').toBe(2),
      { timeout: 5_000, interval: 50 })
    await vi.waitFor(() => expect(settled).toBe(2), { timeout: 200_000, interval: 100 })
    const op = adaptive()
    expect(op.status, op.errorMessage).toBe('ready')
    expect(current(op)).toBe(true)
    expect(op.feedrateOverride?.feedRate).toBe(321)
    expect(rapids(op.toolpathMoves)).toBeGreaterThan(2000)
    expect(screen.getByRole('slider', { name: 'Simulation position' })).toBeTruthy()
  }, 400_000)

  it('a regeneration that settles still outdated on the same inputs is not repeated', async () => {
    await openFullSuite()
    const compute = vi.spyOn(useCamStore.getState(), 'computeOperationToolpath').mockImplementation(async () => {})
    simulateAdaptiveOnly()
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 20 })
    for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve() })
    setMode('toolpath')
    setMode('simulation')
    for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve() })
    expect(adaptive().status).toBe('outdated')
    expect(compute).toHaveBeenCalledTimes(1)
    // A real change makes it due again.
    act(() => editFeed(321))
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2), { timeout: 5_000, interval: 20 })
  }, 120_000)

  // Audit 2026-10-27 (round 5): the attempt memory was keyed by operation id,
  // so it outlived the document it was about. A reopened project is a new
  // outdated instance of the same ids and inputs; it must get its own renewal.
  const settle = async () => { for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve() }) }
  // The auditor's route: leave Simulate, File Open, select Adaptive Clearing 1, Simulate.
  const reopen = async () => { setMode('toolpath'); await openFullSuite(); selectAdaptive() }
  const succeed = (setupId: string, opId: string) =>
    useCamStore.getState().updateOperation(setupId, opId, { status: 'ready' })

  it('reopening the older saved project after a successful renewal renews it again', async () => {
    await openFullSuite()
    const compute = vi.spyOn(useCamStore.getState(), 'computeOperationToolpath')
    simulateAdaptiveOnly()
    await vi.waitFor(() => expect(current(adaptive())).toBe(true), { timeout: 200_000, interval: 100 })
    expect(compute).toHaveBeenCalledTimes(1)
    await reopen()
    await vi.waitFor(() => expect(compute.mock.calls.length, 'the reopened project is never renewed').toBe(2),
      { timeout: 5_000, interval: 50 })
    await vi.waitFor(() => expect(current(adaptive())).toBe(true), { timeout: 200_000, interval: 100 })
    expect(rapids(adaptive().toolpathMoves)).toBeGreaterThan(2000)
    expect(screen.getByRole('slider', { name: 'Simulation position' })).toBeTruthy()
    // Current now: leaving and re-entering Simulate renews nothing.
    setMode('toolpath')
    setMode('simulation')
    await settle()
    expect(compute).toHaveBeenCalledTimes(2)
  }, 400_000)

  it('a project reopened while a renewal runs is renewed after it, and the run in flight is awaited', async () => {
    await openFullSuite()
    const finish: (() => void)[] = []
    const writes: boolean[] = [false, true] // the first run's result is dropped, the second lands
    const compute = vi.spyOn(useCamStore.getState(), 'computeOperationToolpath').mockImplementation(
      (setupId, opId) => new Promise<void>(resolve => finish.push(() => {
        if (writes.shift()) succeed(setupId, opId)
        resolve()
      })))
    simulateAdaptiveOnly()
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 20 })
    await reopen()
    setMode('toolpath')
    setMode('simulation')
    await settle()
    expect(compute, 'a second run started while the first was in flight').toHaveBeenCalledTimes(1)
    await act(async () => { finish.shift()!() })
    await vi.waitFor(() => expect(compute.mock.calls.length, 'the reopened project is never renewed').toBe(2),
      { timeout: 5_000, interval: 20 })
    await act(async () => { finish.shift()!() })
    await settle()
    expect(adaptive().status).toBe('ready')
    expect(compute).toHaveBeenCalledTimes(2)
  }, 120_000)

  it('an unsuccessful renewal is not looped, yet a reopened or new project and another setup get their own', async () => {
    await openFullSuite()
    const compute = vi.spyOn(useCamStore.getState(), 'computeOperationToolpath').mockImplementation(async () => {})
    simulateAdaptiveOnly()
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 20 })
    await settle()
    await reopen()
    await vi.waitFor(() => expect(compute.mock.calls.length, 'the reopened project is never renewed').toBe(2),
      { timeout: 5_000, interval: 20 })
    await settle()
    setMode('toolpath')
    setMode('simulation')
    await settle()
    expect(compute).toHaveBeenCalledTimes(2)
    act(() => useCamStore.getState().newProject())
    await reopen()
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(3), { timeout: 5_000, interval: 20 })
    // Another setup's outdated operations are their own; coming back to the
    // same unsuccessful instance does not repeat it.
    const other = saved.setups[1]
    selectAdaptive(other.id, null)
    await vi.waitFor(() => expect(compute.mock.calls.slice(3).map(call => call[1]))
      .toEqual(other.operations.filter(op => op.enabled !== false).map(op => op.id)), { timeout: 5_000, interval: 20 })
    await settle()
    const settled = compute.mock.calls.length
    selectAdaptive()
    await settle()
    selectAdaptive(other.id, null)
    await settle()
    expect(compute).toHaveBeenCalledTimes(settled)
  }, 120_000)

  it('undo and redo after successful renewals never leave the operation outdated and unrenewed', async () => {
    await openFullSuite()
    const compute = vi.spyOn(useCamStore.getState(), 'computeOperationToolpath')
      .mockImplementation(async (setupId, opId) => { succeed(setupId, opId) })
    simulateAdaptiveOnly()
    await vi.waitFor(() => expect(adaptive().status).toBe('ready'), { timeout: 5_000, interval: 20 })
    act(() => editFeed(321))
    await settle()
    await vi.waitFor(() => expect(adaptive().status).toBe('ready'), { timeout: 5_000, interval: 20 })
    const edited = compute.mock.calls.length
    act(() => useCamStore.getState().undo())
    await settle()
    await vi.waitFor(() => expect(adaptive().status).toBe('ready'), { timeout: 5_000, interval: 20 })
    act(() => useCamStore.getState().redo())
    await settle()
    await vi.waitFor(() => expect(adaptive().status).toBe('ready'), { timeout: 5_000, interval: 20 })
    expect(compute.mock.calls.length).toBeGreaterThanOrEqual(edited)
  }, 120_000)
})
