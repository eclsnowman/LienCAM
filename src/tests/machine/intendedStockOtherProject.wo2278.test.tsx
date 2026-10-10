// @vitest-environment jsdom
// WO-2278: another project is named only in the Intended stock readout.

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
// CNCViewport has private nominal members; use the established WebGL mock cast.
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

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { buildProgramContext, buildMultiSetupProgramContext, compareProgramContext, compareProgramContextPerSetup } = await import('../../lib/machine/programContext')
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


function loadPostedProgram(multi: boolean) {
  const project = makeProject()
  if (!multi) project.setups = [project.setups[0]]
  const posted = postProject(project, project.setups, GRBL_CONFIG, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'other-project', ext: 'nc', modelRefsVerifiedSinceLoad: true,
  })
  if (!posted.ok || !posted.combined?.operationSpans) throw new Error('fixture did not post')
  const gcode = posted.combined.gcode
  const context = multi
    ? buildMultiSetupProgramContext(project, project.setups, GRBL_CONFIG, gcode, posted.combined.operationSpans)
    : buildProgramContext(project, project.setups[0], GRBL_CONFIG, gcode, posted.combined.operationSpans)
  act(() => {
    useCamStore.setState({ project, toolLibrary: project.toolLibrary })
    useMachineControl.getState().setProgram('other-project.nc', gcode, [], context)
  })
  return { project, gcode, context }
}

const badge = () => screen.getByTestId('program-preview-intended-stock-badge').textContent
const note = () => screen.getByTestId('program-preview-intended-stock-note').textContent
const state = () => screen.getByTestId('program-preview-intended-stock').getAttribute('data-context-state')
const openDetails = () => fireEvent.click(screen.getByTestId('program-preview-intended-stock-summary'))

// Real Control preview, real post and comparison; only the WebGL viewport is mocked.
// The verdict must stay project-changed: this is a words-only distinction.
describe.each([false, true])('WO-2278 Intended stock (multi-setup=%s)', (multi) => {
  beforeEach(() => {
    mem.clear()
    harness.instances.length = 0
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })
  afterEach(() => {
    cleanup()
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })

  it('an unchanged post from another project says so, including when setup IDs coincide', async () => {
    const { project, gcode, context } = loadPostedProgram(multi)
    render(<ProgramPreview />)
    expect(badge()).toBe('CURRENT')
    const other = { ...project, id: 'another-project', name: 'Open project' }
    const consoleError = vi.spyOn(console, 'error')
    const consoleWarn = vi.spyOn(console, 'warn')
    try {
      act(() => { useCamStore.setState({ project: other }) })
      await act(async () => {})
      openDetails()
      expect(badge()).toBe('other project')
      expect(note()).toBe('This program was posted from another project. The block shows the stock AS POSTED in that project.')
      expect(state()).toBe('project-changed')
      expect(screen.getByTestId('program-preview-intended-stock-setup').textContent).toBe('Top')
      expect(compareProgramContext(context, other, gcode, GRBL_CONFIG)).toBe('project-changed')
      expect(compareProgramContextPerSetup(context, other, gcode, GRBL_CONFIG).map((v) => v.verdict))
        .toEqual(project.setups.map(() => 'project-changed'))
      const calls = harness.instances.at(-1)!.setIntendedStock.mock.calls
      expect(calls.at(-1)![0]).toMatchObject({ stale: true })
      expect(consoleError).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
      // A live project switch back clears the words-only distinction.
      act(() => { useCamStore.setState({ project }) })
      expect(badge()).toBe('CURRENT')
      expect(screen.queryByTestId('program-preview-intended-stock-note')).toBeNull()
    } finally {
      consoleError.mockRestore()
      consoleWarn.mockRestore()
    }
  })

  it('an edit to the same project still says STALE and names the setup change', async () => {
    const { project } = loadPostedProgram(multi)
    act(() => {
      useCamStore.setState({ project: { ...project, setups: project.setups.map((s) => ({ ...s, notes: 'edited after post' })) } })
    })
    render(<ProgramPreview />)
    await act(async () => {})
    openDetails()
    expect(badge()).toBe('STALE')
    expect(state()).toBe('project-changed')
    expect(note()).toMatch(/^Setup changed since this program was posted/)
  })

  it('changed executable text wins over another project and still says STALE', async () => {
    const { project, gcode, context } = loadPostedProgram(multi)
    const changed = gcode.replace('X30', 'X31')
    expect(changed).not.toBe(gcode)
    const other = { ...project, id: 'another-project' }
    act(() => {
      useCamStore.setState({ project: other })
      // Edit an already loaded program; setProgram correctly rejects a mismatched snapshot on load.
      useMachineControl.setState({ programText: changed })
    })
    render(<ProgramPreview />)
    await act(async () => {})
    openDetails()
    expect(badge()).toBe('STALE')
    expect(state()).toBe('program-changed')
    expect(note()).toMatch(/^Program text changed since it was posted/)
    expect(compareProgramContext(context, other, changed, GRBL_CONFIG)).toBe('program-changed')
    expect(compareProgramContextPerSetup(context, other, changed, GRBL_CONFIG).map((v) => v.verdict))
      .toEqual(project.setups.map(() => 'program-changed'))
  })
})
