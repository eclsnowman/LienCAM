// @vitest-environment jsdom
//
// WO-2690 C3 - "Setup 1 (posted)  Setup changed since post" + "Intended stock -
// other project" on Control > Load, right after posting Setup 1.
//
// Journey audit 2026-10-08 (u11-setup1-load-menu.png): the header of the Load
// menu read as above in the UCCNC run, AFTER File > Open of Full Suite, and the
// audit took it for Full Suite's own Setup 1, posted seconds earlier.
//
// WHAT THE PRODUCTION PATHS SAY (no simulator, no connection - the Load menu
// posts and binds on its own):
//  1. "other project" is printed only when the loaded program's context names a
//     project id other than the open project's (ProgramPreview.tsx, WO-2278),
//     and the Load menu builds the context from the open project itself, so a
//     Load > Setup 1 of the open project reads CURRENT, same project.
//  2. The Post Process modal's Export writes a file and never touches Control;
//     its Send to Control names the program after the FILE, never
//     "Setup 1 (posted)" - that name is minted only by Load > Setup.
//  3. A program loaded from an earlier project stays loaded across
//     File > Open (WO-379: opening a project is not a program unload), and THAT
//     reads exactly the journey's picture. The UCCNC run had loaded its designed
//     part's "Setup 1" through Load > Setup (the setup door it reported blocked
//     by G98) before it opened Full Suite, whose first setup is also "Setup 1".
// So the readout told the truth about the program in Control; nothing in
// product changes for C3. These cases pin all three facts.

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

// CNCViewport needs WebGL; the preview's scene calls are inert here.
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
    setOrbitFocus = vi.fn()
    dispose = vi.fn()
  } as unknown as typeof import('../../lib/viewport/CNCViewport').CNCViewport,
}))

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { makeMachine, makeOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent } =
  await import('../post/helpers')
const { SMART_HEIGHT_INTENT_VERSION, SMART_HEIGHT_POLICY_VERSION } =
  await import('../../lib/cam/smartHeights')
import type { PhysicalStock, Project, Setup, Tool } from '../../types'
import { setupLoadAdoptionInProgress, setupLoadInProgress, yieldSetupLoadTask } from '../../lib/machine/setupLoadPreparation'

function faceIntent() {
  const owner = { kind: 'operation_policy' as const }
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: 'face' as const, variant: 'explicit_depth' as const },
    safety: {
      clearance: { reference: 'wcs_plane' as const, offsetMm: 15, owner },
      retract: { reference: 'wcs_plane' as const, offsetMm: 10, owner },
      feed: { reference: 'wcs_plane' as const, offsetMm: 7, owner },
    },
    machining: {
      start: { value: { kind: 'policy_default' as const }, owner },
      end: { value: { kind: 'policy_default' as const }, owner },
      scope: { value: { kind: 'selected_geometry' as const, geometryIds: ['geo-1'] }, owner },
    },
  }
}

function facePlan() {
  const owner = { kind: 'operation_policy' as const }
  return {
    version: 2 as const,
    policyVersion: 1 as const,
    policy: { operationType: 'face' as const, variant: 'explicit_depth' as const },
    revision: { projectRevision: 'r1', setupRevision: 's1', operationRevision: 'o1' },
    safety: {
      clearance: { wcsMm: 15, machineMm: 15, owner, proofNodeIds: [] },
      retract: { wcsMm: 10, machineMm: 10, owner, proofNodeIds: [] },
      feed: { wcsMm: 7, machineMm: 7, owner, proofNodeIds: [] },
    },
    machining: { materialStart: { wcsMm: 5, machineMm: 5, owner, proofNodeIds: [] } },
    evidenceGraph: [],
    dependencyFingerprints: [],
    warnings: [],
  }
}

/** A postable one-setup project whose only setup is called "Setup 1", on a
 *  UCCNC machine (tests/post/helpers makeMachine) like the journey's LienCNC V2. */
function postableProject(id: string, name: string, x: number): { project: Project; toolLibrary: Tool[] } {
  const tool = makeTool({ id: 't1', toolNumber: 1 })
  const op = makeOp({
    id: `${id}-face`,
    name: 'Face',
    type: 'face',
    toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: x + 20, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
  const setup: Setup = {
    id: `${id}-setup1`,
    name: 'Setup 1',
    wcs: makeWcs({ fixtureOffset: 54, label: 'G54', stockId: `${id}-stock` }),
    stock: makeStock({ material: 'aluminum' }),
    operations: [op],
    notes: '',
  }
  const stock: PhysicalStock = {
    id: `${id}-stock`,
    name: 'Stock 1',
    mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 100, y: 80, z: 20 },
      size: { x: 100, y: 80, z: 20 },
      center: { x: 50, y: 40, z: 10 },
    },
    position: { x: 0, y: 0, z: 0 },
    fixtureOffset: 54,
  }
  const project: Project = {
    id,
    name,
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [tool],
    geometry: [],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    stocks: [stock],
    notes: '',
  }
  op.smartHeight = { kind: 'smart_v2', intent: faceIntent() }
  op.resolvedHeightPlan = facePlan()
  stampGenerationCurrent(project, setup, op, tool)
  return { project, toolLibrary: [tool] }
}

const chip = () => screen.getByTestId('control-program-context')
const stockBadge = () => screen.queryByTestId('program-preview-intended-stock-badge')?.textContent ?? ''

async function loadSetup1(): Promise<void> {
  const setupId = useCamStore.getState().project.setups[0].id
  fireEvent.click(screen.getByTestId('control-load-menu'))
  await act(async () => { fireEvent.click(screen.getByTestId(`control-load-setup-item-${setupId}`)) })
  // WO-3125/WO-3292 made Setup Load span several real tasks (worker prep, then
  // scan, load and preview draw each in its own task); wait for it to finish.
  for (let i = 0; i < 500 && (setupLoadInProgress() || setupLoadAdoptionInProgress()); i++) {
    await act(async () => { await yieldSetupLoadTask() })
  }
}

async function fileOpen(project: Project): Promise<void> {
  await act(async () => {
    const store = useCamStore.getState()
    await store.loadProjectFromFile(JSON.stringify(project), store.beginProjectOpen())
  })
}

beforeEach(() => {
  useMachineControl.setState({ programText: null, programContext: null })
})

afterEach(() => { cleanup() })

describe('WO-2690 C3: a setup loaded from the open project reads current; another project\'s says so', () => {
  it('Load > Setup 1 of the open project reads current, same project, never "other project"', async () => {
    const part = postableProject('wo2690-part', 'Designed Part', 10)
    act(() => { useCamStore.setState({ project: part.project, toolLibrary: part.toolLibrary }) })
    render(<ProgramPanel />)

    await loadSetup1()

    expect(useMachineControl.getState().job.name).toBe('Setup 1 (posted)')
    expect(useMachineControl.getState().programContext!.project.id).toBe(useCamStore.getState().project.id)
    expect(chip().getAttribute('data-staleness')).toBe('current')
    expect(chip().textContent).toBe('Setup 1 (G54) - posted')
    expect(chip().textContent).not.toContain('changed since post')
    expect(stockBadge()).not.toContain('other project')
  })

  it('the journey picture: Setup 1 loaded from the earlier project, then File > Open of another project with a "Setup 1"', async () => {
    const part = postableProject('wo2690-part', 'Designed Part', 10)
    act(() => { useCamStore.setState({ project: part.project, toolLibrary: part.toolLibrary }) })
    render(<ProgramPanel />)
    await loadSetup1()
    expect(chip().getAttribute('data-staleness')).toBe('current')

    const suite = postableProject('wo2690-suite', 'Full Suite', 40)
    await fileOpen(suite.project)
    await act(async () => {})

    // Opening a project does not unload the program in Control (WO-379), and
    // that program is the earlier project's - the readout says so.
    expect(useCamStore.getState().project.id).toBe('wo2690-suite')
    expect(useMachineControl.getState().job.name).toBe('Setup 1 (posted)')
    expect(useMachineControl.getState().programContext!.project.id).toBe('wo2690-part')
    expect(chip().getAttribute('data-staleness')).toBe('project-changed')
    expect(chip().textContent).toBe('Setup changed since post')
    expect(stockBadge()).toContain('other project')

    // Loading the open project's Setup 1 - what the operator does from that
    // menu - reads current and same project at once. (This fixture's synthetic
    // face operation cannot be regenerated after a file round-trip - opening
    // reconciles freshness and it has no stock-footprint scope - so the same
    // project, ready, is installed the way the first case installs its part.)
    act(() => { useCamStore.setState({ project: suite.project, toolLibrary: suite.toolLibrary }) })
    await loadSetup1()
    expect(useMachineControl.getState().programContext!.project.id).toBe('wo2690-suite')
    expect(chip().getAttribute('data-staleness')).toBe('current')
    expect(chip().textContent).toBe('Setup 1 (G54) - posted')
    expect(stockBadge()).not.toContain('other project')
  })
})
