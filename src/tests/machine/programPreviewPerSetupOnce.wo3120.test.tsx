// @vitest-environment jsdom
//
// WO-3120: real preview and post/comparison; only WebGL is replaced.
// Progress must pick cached verdicts without repeating project fingerprints.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const harness = vi.hoisted(() => ({
  instances: [] as Array<{ setIntendedStock: ReturnType<typeof vi.fn> }>,
}))
// Established WebGL stand-in; the real component and comparisons run.
vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setIntendedStock = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setActiveToolpathSegment = vi.fn()
    setToolMarkerPosition = vi.fn()
    showToolMarker = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    fitToolpath = vi.fn()
    fitToolpathPreservingView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    setCameraView = vi.fn()
    dispose = vi.fn()
    constructor() { harness.instances.push(this) }
  } as unknown as typeof import('../../lib/viewport/CNCViewport').CNCViewport,
}))

vi.mock('../../lib/machine/programContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/programContext')>()
  return typedMock<typeof import('../../lib/machine/programContext')>({ ...actual, compareProgramContextPerSetup: vi.fn(actual.compareProgramContextPerSetup), compareProgramContext: vi.fn(actual.compareProgramContext) })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { buildProgramContext, buildMultiSetupProgramContext, compareProgramContextPerSetup, compareProgramContext, deriveOperationProgress } = await import('../../lib/machine/programContext')
const { GRBL_CONFIG, UCCNC_CONFIG, postProject } = await import('../../lib/post')
const { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } = await import('../post/helpers')
import type { Operation, Project, Setup, Stock } from '../../types'

function makeStock(width: number): Stock {
  return { type: 'rectangular', width, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 }, material: 'aluminum' } as unknown as Stock
}
function twoMoveOp(id: string, name: string, x: number): Operation {
  return makeOp({
    id, name, toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}
function makeSetup(id: string, name: string, fixtureOffset: number, ops: Operation[], notes: string, width: number): Setup {
  return { id, name, wcs: makeWcs({ id: `wcs-${id}`, label: `G${fixtureOffset}`, fixtureOffset }), stock: makeStock(width), operations: ops, notes }
}
function makeProject(controller: 'grbl' | 'uccnc' = 'grbl'): Project {
  const setups = [
    makeSetup('s1', 'Top', 54, [twoMoveOp('opA', 'Face top', 30)], 'Clamp left.', 100),
    makeSetup('s2', 'Bottom', 55, [twoMoveOp('opB', 'Face bottom', 40)], 'Flip.', 80),
  ]
  const project: Project = {
    id: 'p-multi-ui', name: 'Multi UI', version: '1', createdAt: '', updatedAt: '',
    // WO-1404: this fixture posts with GRBL_CONFIG below; the declared machine
    // must match it, or the preview's post-identity resolution (now the same
    // one ProgramPanel's header uses) reads this as a real GRBL-vs-UCCNC
    // mismatch and reports STALE.
    machine: makeMachine({ controller }), toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [], setups, activeSetupId: 's1', activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const setup of setups) for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary[0])
  return project
}

function loadTwoSetups(controller: 'grbl' | 'uccnc' = 'grbl', single = false) {
  const project = makeProject(controller)
  if (single) project.setups = [project.setups[0]]
  const post = controller === 'grbl' ? GRBL_CONFIG : UCCNC_CONFIG
  act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
  const posted = postProject({ ...project }, project.setups, post, { mode: 'combined', pauseBetweenSetups: false, baseName: 'c', ext: 'nc', modelRefsVerifiedSinceLoad: true })
  if (!posted.ok || !posted.combined?.operationSpans) throw new Error('fixture did not post')
  const context = single
    ? buildProgramContext(project, project.setups[0], post, posted.combined.gcode, posted.combined.operationSpans)
    : buildMultiSetupProgramContext(project, project.setups, post, posted.combined.gcode, posted.combined.operationSpans)
  act(() => { useMachineControl.getState().setProgram('multi (posted)', posted.combined!.gcode, [], context) })
  const progress = deriveOperationProgress(context, posted.combined.gcode, { phase: 'ready', ackedSourceLine: 0 })!
  return { project, gcode: posted.combined.gcode, context, bounds: progress.entries }
}

function ack(line: number, phase: 'streaming' | 'complete' = 'streaming') {
  act(() => {
    useMachineControl.getState().applyJobProgress({
      phase, totalLines: 100, sentLines: line, ackedLines: line, ackedSourceLine: line, sentSourceLine: line,
    } as Parameters<ReturnType<typeof useMachineControl.getState>['applyJobProgress']>[0])
  })
}

const summary = () => screen.getByTestId('program-preview-intended-stock-summary').textContent ?? ''
/** WO-414 batch 2: the facts are a popover opened by clicking the line. */
const openDetails = () => fireEvent.click(screen.getByTestId('program-preview-intended-stock-summary'))
const state = () => screen.getByTestId('program-preview-intended-stock').getAttribute('data-context-state')
function lastBox() {
  const vp = harness.instances[harness.instances.length - 1]
  const calls = vp.setIntendedStock.mock.calls
  return calls.length ? calls[calls.length - 1][0] : undefined
}

const comparisons = vi.mocked(compareProgramContextPerSetup)
const wholeComparison = vi.mocked(compareProgramContext)

describe('WO-3120: compare intent only when its real inputs change', () => {
  beforeEach(() => {
    mem.clear()
    harness.instances.length = 0
    comparisons.mockClear()
    wholeComparison.mockClear()
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })

  it.each(['grbl', 'uccnc'] as const)('%s: one comparison across every ack and setup boundary', (controller) => {
    const { gcode, bounds } = loadTwoSetups(controller)
    render(<ProgramPreview />)
    openDetails()
    expect(summary()).toMatch(/CURRENT - Top \(G54\)/)
    for (let line = 1; line <= gcode.split('\n').length; line++) ack(line)
    expect(summary()).toMatch(/CURRENT - Bottom \(G55\)/)
    expect(lastBox()).toMatchObject({ max: { x: 80 }, stale: false })
    // Intended failure on shipped code: full-project hashes repeated per line.
    expect(comparisons).toHaveBeenCalledTimes(1)
    expect(wholeComparison).not.toHaveBeenCalled()
    ack(bounds[0].firstExecutableLine)
    expect(summary()).toMatch(/CURRENT - Top \(G54\)/)
    ack(bounds[1].lastExecutableLine, 'complete')
    expect(summary()).toMatch(/Bottom \(G55\)/)
    expect(comparisons).toHaveBeenCalledTimes(1)
  })

  it('keeps different setup verdicts through hold, re-arm and completion', () => {
    const { project, bounds } = loadTwoSetups()
    act(() => { useCamStore.setState({ project: { ...project, setups: project.setups.map(s => s.id === 's2' ? { ...s, notes: 'edited' } : s) } }) })
    render(<ProgramPreview />)
    openDetails()
    expect(state()).toBe('current')
    ack(bounds[1].firstExecutableLine)
    expect(state()).toBe('project-changed')
    expect(lastBox()).toMatchObject({ stale: true, max: { x: 80 } })
    act(() => { useMachineControl.setState(s => ({ job: { ...s.job, phase: 'paused' } })) })
    expect(state()).toBe('project-changed')
    act(() => { useMachineControl.setState(s => ({ armedFromLine: bounds[1].firstExecutableLine, job: { ...s.job, phase: 'ready', ackedSourceLine: 0 } })) })
    expect(summary()).toMatch(/STALE - Bottom \(G55\)/)
    ack(bounds[1].lastExecutableLine, 'complete')
    expect(state()).toBe('project-changed')
    expect(comparisons).toHaveBeenCalledTimes(1)
  })

  it('invalidates on context replacement, executable text, intent, tools and declared post', () => {
    const { project, context, gcode } = loadTwoSetups()
    render(<ProgramPreview />)
    openDetails()
    expect(state()).toBe('current')
    expect(comparisons).toHaveBeenCalledTimes(1)
    // Selection-only project replacement must stay cheap (WO-396).
    act(() => { useCamStore.setState({ project: { ...project, activeSetupId: 's2' } }) })
    expect(comparisons).toHaveBeenCalledTimes(1)
    act(() => { useMachineControl.setState({ programContext: { ...context } }) })
    expect(comparisons).toHaveBeenCalledTimes(2)
    const changed = gcode.replace('X30', 'X31')
    expect(changed).not.toBe(gcode)
    act(() => { useMachineControl.setState({ programText: changed }) })
    expect(state()).toBe('program-changed')
    expect(comparisons).toHaveBeenCalledTimes(3)
    act(() => { useMachineControl.setState({ programText: gcode }) })
    expect(state()).toBe('current')
    expect(comparisons).toHaveBeenCalledTimes(4)
    act(() => { useCamStore.setState({ project: { ...project, setups: project.setups.map(s => ({ ...s, notes: 'edited' })) } }) })
    expect(state()).toBe('project-changed')
    expect(comparisons).toHaveBeenCalledTimes(5)
    act(() => { useCamStore.setState({ project }) })
    expect(state()).toBe('current')
    expect(comparisons).toHaveBeenCalledTimes(6)
    act(() => { useCamStore.setState({ toolLibrary: project.toolLibrary.map(t => ({ ...t, diameter: t.diameter + 1 })) }) })
    expect(state()).toBe('project-changed')
    expect(comparisons).toHaveBeenCalledTimes(7)
    act(() => { useCamStore.setState({ toolLibrary: project.toolLibrary, project: { ...project, machine: { ...project.machine!, controller: 'uccnc' } } }) })
    expect(state()).toBe('project-changed')
    expect(comparisons).toHaveBeenCalledTimes(8)
  })

  it('preserves comparison-failed without retrying a fault on every ack', () => {
    const { bounds } = loadTwoSetups()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    comparisons.mockImplementationOnce(() => { throw new Error('comparison defect') })
    try {
      render(<ProgramPreview />)
      expect(state()).toBe('comparison-failed')
      ack(bounds[0].firstExecutableLine)
      ack(bounds[1].firstExecutableLine)
      expect(state()).toBe('comparison-failed')
      expect(comparisons).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledTimes(1)
    } finally { error.mockRestore() }
  })

  it('keeps the whole-context fallback if a per-setup verdict is missing', () => {
    loadTwoSetups()
    comparisons.mockReturnValueOnce([])
    render(<ProgramPreview />)
    expect(state()).toBe('current')
    expect(wholeComparison).toHaveBeenCalledTimes(1)
    ack(1)
    ack(2)
    expect(state()).toBe('current')
    expect(wholeComparison).toHaveBeenCalledTimes(1)
    expect(comparisons).toHaveBeenCalledTimes(1)
  })

  it('preserves single-setup and no-context routes', () => {
    loadTwoSetups('grbl', true)
    render(<ProgramPreview />)
    expect(state()).toBe('current')
    ack(1)
    ack(2)
    expect(comparisons).toHaveBeenCalledTimes(1)
    act(() => { useMachineControl.getState().setProgram('plain.nc', 'G0 X1', [], null) })
    expect(state()).toBe('no-context')
    expect(comparisons).toHaveBeenCalledTimes(1)
  })
})
