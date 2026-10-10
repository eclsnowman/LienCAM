// @vitest-environment jsdom
//
// WO-412: the intended-stock card in the Control preview FOLLOWS the active
// setup of a multi-setup (version-2) program - the setup the acknowledged line
// is in - and shows THAT setup's verdict, so a stale setup 2 reads STALE while
// setup 1 still reads CURRENT. WO-414's collapsed/expanded structure is untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

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
// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
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
  },
}))

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { buildMultiSetupProgramContext, deriveOperationProgress } = await import('../../lib/machine/programContext')
const { GRBL_CONFIG, postProject } = await import('../../lib/post')
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
function makeProject(): Project {
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
    machine: makeMachine({ controller: 'grbl' }), toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [], setups, activeSetupId: 's1', activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const setup of setups) for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary[0])
  return project
}

function loadTwoSetups() {
  const project = makeProject()
  act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
  const posted = postProject({ ...project }, project.setups, GRBL_CONFIG, { mode: 'combined', pauseBetweenSetups: false, baseName: 'c', ext: 'nc', modelRefsVerifiedSinceLoad: true })
  if (!posted.ok || !posted.combined?.operationSpans) throw new Error('fixture did not post')
  const context = buildMultiSetupProgramContext(project, project.setups, GRBL_CONFIG, posted.combined.gcode, posted.combined.operationSpans)
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
const badge = () => screen.getByTestId('program-preview-intended-stock-badge').textContent
const state = () => screen.getByTestId('program-preview-intended-stock').getAttribute('data-context-state')
function lastBox() {
  const vp = harness.instances[harness.instances.length - 1]
  const calls = vp.setIntendedStock.mock.calls
  return calls.length ? calls[calls.length - 1][0] : undefined
}

describe('WO-412: the intended-stock card follows the active setup and shows its own verdict', () => {
  beforeEach(() => {
    harness.instances.length = 0
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })
  afterEach(() => {
    cleanup()
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })

  it('armed: the lead setup; the acknowledged line crossing into setup 2 switches the card (name, WCS, stock size, block)', async () => {
    const { bounds } = loadTwoSetups()
    render(<ProgramPreview />)
    await act(async () => {})
    openDetails()
    expect(summary()).toMatch(/Intended stock - CURRENT - Top \(G54\)/)
    expect(screen.getByTestId('program-preview-intended-stock-setup').textContent).toBe('Top')
    expect(screen.getByTestId('program-preview-intended-stock-wcs').textContent).toBe('G54')
    expect(screen.getByTestId('program-preview-intended-stock-size').textContent).toBe('X 100.00  Y 20.00  Z 100.00 mm')
    expect(lastBox()).toMatchObject({ max: { x: 100 }, stale: false })

    ack(bounds[0].firstExecutableLine)
    await act(async () => {})
    expect(summary()).toMatch(/Top \(G54\)/)

    ack(bounds[1].firstExecutableLine)
    await act(async () => {})
    expect(summary()).toMatch(/Intended stock - CURRENT - Bottom \(G55\)/)
    expect(screen.getByTestId('program-preview-intended-stock-setup').textContent).toBe('Bottom')
    expect(screen.getByTestId('program-preview-intended-stock-wcs').textContent).toBe('G55')
    expect(screen.getByTestId('program-preview-intended-stock-size').textContent).toBe('X 80.00  Y 20.00  Z 100.00 mm')
    expect(lastBox()).toMatchObject({ max: { x: 80 }, stale: false })

    ack(bounds[1].lastExecutableLine, 'complete')
    await act(async () => {})
    expect(summary()).toMatch(/Bottom \(G55\)/)
  })

  it('a stale setup 2 reads STALE while setup 1 still reads CURRENT - one stale setup does not hide the other', async () => {
    const { bounds } = loadTwoSetups()
    render(<ProgramPreview />)
    await act(async () => {})
    openDetails()
    act(() => {
      useCamStore.setState((st) => ({
        project: { ...st.project, setups: st.project.setups.map((s) => (s.id === 's2' ? { ...s, notes: 'edited after post' } : s)) },
      }))
    })
    await act(async () => {})
    // Armed at the top: setup 1 is the active one and it is current.
    expect(summary()).toMatch(/Intended stock - CURRENT - Top \(G54\)/)
    expect(state()).toBe('current')
    expect(lastBox()).toMatchObject({ stale: false })

    ack(bounds[1].firstExecutableLine)
    await act(async () => {})
    expect(summary()).toMatch(/Intended stock - STALE - Bottom \(G55\)/)
    expect(state()).toBe('project-changed')
    expect(badge()).toBe('STALE')
    expect(screen.getByTestId('program-preview-intended-stock-note').textContent).toMatch(/Setup changed since this program was posted/)
    expect(lastBox()).toMatchObject({ max: { x: 80 }, stale: true })

    // Back in setup 1 (a re-arm from the top): CURRENT again.
    ack(bounds[0].firstExecutableLine)
    await act(async () => {})
    expect(summary()).toMatch(/CURRENT - Top \(G54\)/)
    expect(state()).toBe('current')
  })
})
