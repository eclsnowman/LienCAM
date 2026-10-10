// @vitest-environment jsdom
//
// WO-1404 (BUG-525, family K1): ProgramPreview's per-setup "intended stock"
// card hard-coded GRBL_CONFIG for its staleness comparison instead of
// resolving the project's ACTUAL declared post the way ProgramPanel's header
// chip already does (resolveDeclaredController). Post configuration is part
// of the comparison's digest, so a UCCNC project's per-setup card computed a
// different digest than the header did and reported STALE for a setup that
// had not actually changed. This file proves the header (ProgramPanel) and
// the per-setup card (ProgramPreview, rendered inside it) now agree.
//
// NOTE (decide-and-log, WO-1404 worker attempt 1): the work order's
// owned-paths named this file with a `.test.ts` extension. A DOM-rendering
// regression test needs JSX, which requires `.tsx` under this repo's esbuild
// config (plain `.ts` refuses JSX syntax) - every existing component test in
// this directory (e.g. intendedStockMultiSetup.wo412.test.tsx) is `.tsx` for
// exactly that reason. Filed as `.tsx`; vitest's include glob covers both.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

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

import { typedMock } from '../support/typedMock'

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
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
    constructor() { /* no instances needed - this file reads the DOM, not viewport calls */ }
  } as unknown as typeof import('../../lib/viewport/CNCViewport').CNCViewport,
}))

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { buildMultiSetupProgramContext, buildProgramContext, deriveOperationProgress } =
  await import('../../lib/machine/programContext')
const { GRBL_CONFIG, UCCNC_CONFIG, postProject } = await import('../../lib/post')
const { resolveDeclaredController } = await import('../../lib/machine/machineChoice')
const { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } = await import('../post/helpers')
import type { Operation, Project, Setup, Stock } from '../../types'
import type { PostConfig } from '../../lib/post'

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
function makeTwoSetupProject(controller: 'uccnc' | 'grbl'): Project {
  const setups = [
    makeSetup('s1', 'Top', 54, [twoMoveOp('opA', 'Face top', 30)], 'Clamp left.', 100),
    makeSetup('s2', 'Bottom', 55, [twoMoveOp('opB', 'Face bottom', 40)], 'Flip.', 80),
  ]
  const project: Project = {
    id: 'p-wo1404', name: 'WO-1404 post identity', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine({ controller }), toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [], setups, activeSetupId: 's1', activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const setup of setups) for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary[0])
  return project
}

/** Posts BOTH setups as one combined program using the dialect the project's
 *  MACHINE actually declares - resolveDeclaredController, the exact function
 *  ProgramPanel's header chip resolves its comparison post from (loadFromSetup
 *  does the same on the real Load path). This is deliberately NOT a fixed
 *  GRBL_CONFIG: proving the header and the per-setup card agree requires a
 *  program posted with the SAME dialect the project actually declares. */
function loadTwoSetupsOffline(project: Project) {
  act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
  const resolution = resolveDeclaredController(project.machine)
  if (!resolution.ok) throw new Error(resolution.reason)
  const dialect: PostConfig = resolution.dialect
  const posted = postProject({ ...project }, project.setups, dialect, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'c', ext: 'nc', modelRefsVerifiedSinceLoad: true,
  })
  if (!posted.ok || !posted.combined?.operationSpans) throw new Error('fixture did not post')
  const context = buildMultiSetupProgramContext(project, project.setups, dialect, posted.combined.gcode, posted.combined.operationSpans)
  act(() => { useMachineControl.getState().setProgram('multi (posted)', posted.combined!.gcode, [], context) })
  const progress = deriveOperationProgress(context, posted.combined.gcode, { phase: 'ready', ackedSourceLine: 0 })!
  return { bounds: progress.entries }
}

function ack(line: number, phase: 'streaming' | 'complete' = 'streaming') {
  act(() => {
    useMachineControl.getState().applyJobProgress({
      phase, totalLines: 100, sentLines: line, ackedLines: line, ackedSourceLine: line, sentSourceLine: line,
    } as Parameters<ReturnType<typeof useMachineControl.getState>['applyJobProgress']>[0])
  })
}

const headerStaleness = () => screen.getByTestId('control-program-context').getAttribute('data-staleness')
const cardState = () => screen.getByTestId('program-preview-intended-stock').getAttribute('data-context-state')
const cardSummary = () => screen.getByTestId('program-preview-intended-stock-summary').textContent ?? ''

describe('WO-1404: ProgramPreview compares against the SAME resolved post ProgramPanel\'s header uses', () => {
  beforeEach(() => {
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })
  afterEach(() => {
    cleanup()
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })

  it('a UCCNC project, unchanged multi-setup program reloaded offline: the header AND every per-setup card read current', async () => {
    const project = makeTwoSetupProject('uccnc')
    expect(resolveDeclaredController(project.machine)).toMatchObject({ ok: true, dialect: { id: UCCNC_CONFIG.id } })
    const { bounds } = loadTwoSetupsOffline(project)
    render(<ProgramPanel />)
    await act(async () => {})

    // Armed at the top: setup 1 is active.
    expect(headerStaleness()).toBe('current')
    expect(cardState()).toBe('current')
    expect(cardSummary()).toMatch(/Intended stock - CURRENT - Top \(G54\)/)

    // Cross into setup 2: still current, on both surfaces.
    ack(bounds[1].firstExecutableLine)
    await act(async () => {})
    expect(headerStaleness()).toBe('current')
    expect(cardState()).toBe('current')
    expect(cardSummary()).toMatch(/Intended stock - CURRENT - Bottom \(G55\)/)
  })

  it('a genuine setup edit after reload stales that setup (header + card); the unedited setup stays current', async () => {
    const project = makeTwoSetupProject('uccnc')
    const { bounds } = loadTwoSetupsOffline(project)
    render(<ProgramPanel />)
    await act(async () => {})

    act(() => {
      useCamStore.setState((st) => ({
        project: { ...st.project, setups: st.project.setups.map((s) => (s.id === 's2' ? { ...s, notes: 'edited after post' } : s)) },
      }))
    })
    await act(async () => {})

    // Setup 1 (still active/lead) is unaffected by setup 2's edit.
    expect(cardState()).toBe('current')

    // Setup 2 (edited) reads stale on both surfaces once it is active.
    ack(bounds[1].firstExecutableLine)
    await act(async () => {})
    expect(headerStaleness()).toBe('project-changed')
    expect(cardState()).toBe('project-changed')
    expect(cardSummary()).toMatch(/Intended stock - STALE - Bottom \(G55\)/)

    // Back in setup 1: current again - one stale setup does not hide the other.
    ack(bounds[0].firstExecutableLine)
    await act(async () => {})
    expect(cardState()).toBe('current')
  })

  it('a GRBL project (where the old hard-coded config happened to match) is unchanged: no regression', async () => {
    const project = makeTwoSetupProject('grbl')
    expect(resolveDeclaredController(project.machine)).toMatchObject({ ok: true, dialect: { id: GRBL_CONFIG.id } })
    loadTwoSetupsOffline(project)
    render(<ProgramPanel />)
    await act(async () => {})
    expect(headerStaleness()).toBe('current')
    expect(cardState()).toBe('current')
  })

  it('a single-setup program built through buildProgramContext (the version-1 shape) agrees too', async () => {
    const project = makeTwoSetupProject('uccnc')
    project.setups = [project.setups[0]]
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    const resolution = resolveDeclaredController(project.machine)
    if (!resolution.ok) throw new Error(resolution.reason)
    const posted = postProject({ ...project }, project.setups, resolution.dialect, {
      mode: 'combined', pauseBetweenSetups: false, baseName: 'c', ext: 'nc', modelRefsVerifiedSinceLoad: true,
    })
    if (!posted.ok || !posted.combined?.operationSpans) throw new Error('fixture did not post')
    const context = buildProgramContext(project, project.setups[0], resolution.dialect, posted.combined.gcode, posted.combined.operationSpans)
    act(() => { useMachineControl.getState().setProgram('Top (posted)', posted.combined!.gcode, [], context) })

    render(<ProgramPanel />)
    await act(async () => {})
    expect(headerStaleness()).toBe('current')
    expect(cardState()).toBe('current')
  })
})
