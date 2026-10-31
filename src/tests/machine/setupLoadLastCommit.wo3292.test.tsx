// @vitest-environment jsdom
//
// WO-3292: the last commit after Setup Load stays under 200 ms. The slow test machine's
// profile of WO-3125 r8 named one ~410 ms task: the read-set's full raw/ABA
// scan, the session's load, and the preview drawing and framing the adopted
// program, all inside one store commit. Driven through the real ProgramPanel
// and ProgramPreview on the in-app simulator with the shipped Full Suite; only
// the viewport (jsdom has no WebGL) is replaced. Real task boundaries are
// counted on the MessageChannel continuation Setup Load already uses.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { Project } from '../../types'

const vp = vi.hoisted(() => ({ calls: [] as Array<{ name: string; task: number; moves?: number }>, task: { value: 0 } }))

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = () => {}
    renderToolpath = (moves: unknown[]) => { vp.calls.push({ name: 'renderToolpath', task: vp.task.value, moves: moves.length }) }
    setToolMarkerPosition = () => {}
    dispose = () => {}
    setStockVisible = () => {}
    setWorkpieceVisible = () => {}
    setMachineVisible = () => {}
    showToolMarker = () => {}
    setActiveToolpathSegment = () => {}
    setToolpathDoneBoundary = () => {}
    setSimulationToolpathPreview = () => {}
    setIntendedStock = () => {}
    fitProgramPointsIso = () => { vp.calls.push({ name: 'fit', task: vp.task.value }); return true }
    fitToolpath = () => { vp.calls.push({ name: 'fit', task: vp.task.value }); return true }
    fitToolpathPreservingView = () => true
    fitBoundsPreservingView = () => true
    setOrbitFocus = () => {}
    setCameraView = () => {}
    setPreviewRotation = () => {}
    worldToScreen = (x: number, y: number) => ({ x, y })
  } as unknown as typeof import('../../lib/viewport/CNCViewport').CNCViewport,
}))

Object.defineProperty(globalThis, 'requestAnimationFrame', { value: () => 1, configurable: true, writable: true })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: () => {}, configurable: true, writable: true })

const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const preparation = await import('../../lib/machine/setupLoadPreparation')
const { resolveDeclaredController } = await import('../../lib/machine/machineChoice')

// Each delivered continuation is one real task; the counter is read by every
// recorder above and below.
const NativeChannel = MessageChannel
class CountingChannel {
  private inner = new NativeChannel()
  port1 = { onmessage: null as ((event: MessageEvent) => void) | null, close: () => this.inner.port1.close() }
  port2 = { postMessage: (value: unknown) => this.inner.port2.postMessage(value), close: () => this.inner.port2.close() }
  constructor() { this.inner.port1.onmessage = event => { vp.task.value++; this.port1.onmessage?.(event) } }
}

let project: Project
beforeEach(async () => {
  vp.calls.length = 0
  project = JSON.parse(readFileSync('Example Projects/Full Suite.camproject', 'utf8'))
  useCamStore.setState(s => ({ project, toolLibrary: project.toolLibrary, machineLibrary: [project.machine],
    modelRefsVerifiedSinceLoad: true, control: { ...s.control, activeMachineId: project.machine.id, sessionMachine: null, appliedMachine: null } }))
  vi.useFakeTimers()
  const connecting = session.connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(400)
  await connecting
  vi.useRealTimers()
  session.__resetEstopInterlockForTest()
  useMachineControl.getState().setProgram(null, null, [], null)
})
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useFakeTimers()
  const disconnecting = session.disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await disconnecting
  vi.useRealTimers()
})

function witnessInput() {
  const resolution = resolveDeclaredController(project.machine)
  if (!resolution.ok) throw new Error(resolution.reason)
  return { project, toolLibrary: project.toolLibrary, setupId: project.setups[0].id, machine: project.machine,
    post: resolution.dialect, modelRefsVerifiedSinceLoad: true as const, parserIdentity: preparation.setupLoadParserIdentity() }
}

describe('WO-3292: the Setup Load adoption commit', () => {
  it('rechecks the scanned intent references without re-walking the program graph, and nothing else is skipped', () => {
    const input = witnessInput()
    const witness = preparation.observeSetupLoadInputs(input)
    const owns = vi.spyOn(Object, 'hasOwn')
    expect(witness.changed(input)).toBe(false)
    const full = owns.mock.calls.length
    owns.mockClear()
    expect(witness.changed(input, true)).toBe(false)
    expect(full, 'the full scan walks every move of every setup').toBeGreaterThan(100000)
    expect(owns.mock.calls.length, 'the commit recheck compares only the small machine/post values').toBeLessThan(full / 100)
    owns.mockRestore()

    // A replaced intent member is walked in full again.
    const edited = { ...input, project: { ...project, setups: structuredClone(project.setups) } }
    expect(witness.changed(edited, true)).toBe(false)
    edited.project.setups[0].operations.find(op => op.toolpathMoves?.length)!.toolpathMoves![0].x += 0.125
    const replaced = { ...edited, project: { ...edited.project, setups: [...edited.project.setups] } }
    expect(witness.changed(replaced, true), 'new references get the full raw scan').toBe(true)
    expect(witness.changed(input, true), 'sticky').toBe(true)

    // Machine and post are never skipped, and a recheck before any full scan is one.
    const machine = preparation.observeSetupLoadInputs(input)
    expect(machine.changed(input)).toBe(false)
    expect(machine.changed({ ...input, machine: { ...input.machine, name: input.machine.name + ' changed' } }, true)).toBe(true)
    const unscanned = preparation.observeSetupLoadInputs(input)
    const move = project.setups[0].operations.find(op => op.toolpathMoves?.length)!.toolpathMoves![0]
    move.x += 0.125
    expect(unscanned.changed(input, true), 'no full scan yet: the recheck is a full scan').toBe(true)
  }, 60000)

  it('keeps the full scan, the session load, and the preview draw in separate tasks with the same program', async () => {
    vi.stubGlobal('MessageChannel', CountingChannel)
    const log: Array<{ what: 'scan' | 'recheck' | 'load'; task: number }> = []
    const observe = preparation.observeSetupLoadInputs
    vi.spyOn(preparation, 'observeSetupLoadInputs').mockImplementation(input => {
      const witness = observe(input)
      return { changed(current, recheck) {
        log.push({ what: recheck ? 'recheck' : 'scan', task: vp.task.value })
        return witness.changed(current, recheck)
      } }
    })
    const load = session.loadGcodeFile
    vi.spyOn(session, 'loadGcodeFile').mockImplementation((...args) => {
      log.push({ what: 'load', task: vp.task.value })
      return load(...args)
    })
    render(createElement('div', null, createElement(ProgramPanel), createElement(ProgramPreview)))
    vp.calls.length = 0
    fireEvent.click(screen.getByTestId('control-load-menu'))
    fireEvent.click(screen.getByTestId(`control-load-setup-item-${project.setups[0].id}`))
    await waitFor(() => expect(log.some(entry => entry.what === 'load')).toBe(true), { timeout: 45000 })
    await waitFor(() => expect(vp.calls.some(call => call.name === 'renderToolpath' && (call.moves ?? 0) > 1)).toBe(true), { timeout: 15000 })

    const commit = log.find(entry => entry.what === 'load')!.task
    const lastScan = Math.max(...log.filter(entry => entry.what === 'scan').map(entry => entry.task))
    expect(lastScan, 'the last full raw/ABA scan runs in a task before the commit').toBeLessThan(commit)
    expect(log.filter(entry => entry.task === commit).map(entry => entry.what), 'the commit task rechecks, then loads').toEqual(['recheck', 'load'])
    const drawn = vp.calls.filter(call => call.name === 'renderToolpath' && (call.moves ?? 0) > 1)
    expect(drawn[0].task, 'the adopted program is drawn in the next task, not inside the commit').toBeGreaterThan(commit)
    const framed = vp.calls.filter(call => call.name === 'fit')
    expect(framed.length, 'Load still frames the program').toBeGreaterThan(0)
    expect(Math.min(...framed.map(call => call.task)), 'and frames it after the commit').toBeGreaterThan(commit)

    // The CURRENT program is the setup's one post, byte for byte.
    const state = useCamStore.getState()
    const resolution = resolveDeclaredController(state.project.machine)
    if (!resolution.ok) throw new Error(resolution.reason)
    const expected = preparation.prepareSetupLoad({ project: { ...state.project, toolLibrary: state.toolLibrary }, setupId: project.setups[0].id,
      post: resolution.dialect, modelRefsVerifiedSinceLoad: state.modelRefsVerifiedSinceLoad, machine: state.project.machine,
      tables: preparation.setupLoadParserTables(), reader: { dialect: 'uccnc', initialPosition: { x: 0, y: 0, z: 0 }, sessionWcs: 'G54' } })
    expect(useMachineControl.getState().programText).toBe(expected.posted.combined!.gcode)
    expect(useMachineControl.getState().programContext?.setup.id).toBe(project.setups[0].id)
    expect(drawn.at(-1)!.moves).toBe(preparation.preparedSourceProgram(useMachineControl.getState().programText)!.path.moves.length)
    await waitFor(() => expect(preparation.setupLoadAdoptionInProgress()).toBe(false))
  }, 90000)

  it('a file Load is drawn inside its own commit, as before', async () => {
    vi.stubGlobal('MessageChannel', CountingChannel)
    render(createElement(ProgramPreview))
    vp.calls.length = 0
    const task = vp.task.value
    act(() => { session.loadGcodeFile('file.nc', 'G21 G90 G54\nG0 Z5\nG1 X10 Y0 Z-1 F100\nG1 X10 Y10\nM30', null) })
    const drawn = vp.calls.filter(call => call.name === 'renderToolpath' && (call.moves ?? 0) > 1)
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn[0].task).toBe(task)
    expect(vp.calls.some(call => call.name === 'fit' && call.task === task)).toBe(true)
  }, 30000)
})
