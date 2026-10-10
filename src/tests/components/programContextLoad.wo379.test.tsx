// @vitest-environment jsdom
//
// WO-379 integration proof: the immutable program-context snapshot binds to a
// loaded program through the REAL store/session boundary, never leaks between
// loads, is enforced immutable against a mutable caller, survives the real
// lifecycle (newProject / disconnect / arm / run / hold / resume / completion),
// and cannot change what the streamer sends. Includes a real end-to-end
// "Load setup" drive through postProject.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
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

// WO-396: count the expensive section resolution the intent digest performs, so a test
// can prove a tree click (activeOperationId) costs nothing and a real edit still recomputes.
const sectionCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../lib/cam/nesting/nestRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/nesting/nestRuntime')>()
  return typedMock<typeof import('../../lib/cam/nesting/nestRuntime')>({
    ...actual,
    collectToolpathSections: (...args: Parameters<typeof actual.collectToolpathSections>) => {
      sectionCalls.n++
      return actual.collectToolpathSections(...args)
    },
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const {
  buildProgramContext,
  compareProgramContext,
  computeMotionDigest,
} = await import('../../lib/machine/programContext')
const { prepareProgram } = await import('../../lib/gcode/text')
const { GRBL_CONFIG, UCCNC_CONFIG, postProject } = await import('../../lib/post')
const { makeMachine, makeOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent } =
  await import('../post/helpers')
const { SMART_HEIGHT_INTENT_VERSION, SMART_HEIGHT_POLICY_VERSION } =
  await import('../../lib/cam/smartHeights')
import type { PhysicalStock, Project, Setup, Tool } from '../../types'

const GCODE = [
  'G21 G90 G54',
  'M3 S12000',
  'G0 X0 Y0',
  'G0 Z5',
  'G1 Z-2 F300',
  'G1 X10 Y0 F800',
  'G1 X10 Y10',
  'G0 Z5',
  'M5',
  'M30',
].join('\n')

const GCODE_OTHER = 'G21 G90 G55\nG0 X5 Y5\nG1 X20 Y5 F500\nM30'

/** The lifecycle program uses work Z -2..5. GRBL homes at machine Z0 and
 * travels negative, so G54 Z -5 maps those moves to machine Z -7..0. */
function selectProgramMotionFixture(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo379-program-motion-machine',
    name: 'WO-379 program motion fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 0 },
    },
  })
}

interface Fixture {
  project: Project
  setup: Setup
  gcode: string
}

function makeFixture(id = 'projA', setupName = 'Setup A', notes = 'notes-A'): Fixture {
  const setup: Setup = {
    id: 'setupA',
    name: setupName,
    wcs: makeWcs({ fixtureOffset: 54, label: 'G54', stockId: 'stockA' }),
    stock: makeStock({ material: 'aluminum' }),
    operations: [
      makeOp({ id: 'opA', name: 'Face', type: 'face', generationFingerprint: 'gf-A' }),
    ],
    notes,
  }
  const stock: PhysicalStock = {
    id: 'stockA',
    name: 'Stock A',
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
    name: id,
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [],
    setups: [setup],
    activeSetupId: 'setupA',
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    stocks: [stock],
    notes: '',
  }
  return { project, setup, gcode: GCODE }
}

function fixtureSpans(setup: Setup, gcode: string) {
  return [{
    opId: setup.operations[0].id,
    setupId: setup.id,
    startLine: 1,
    endLine: gcode.split(/\r?\n/).length,
  }]
}

// ---- A minimal, V2-authoritative, genuinely-postable face operation ---------

function makeV2FaceIntent() {
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

function makeV2Plan() {
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
    machining: {
      materialStart: { wcsMm: 5, machineMm: 5, owner, proofNodeIds: [] },
    },
    evidenceGraph: [],
    dependencyFingerprints: [],
    warnings: [],
  }
}

function makePostableProject(): { project: Project; toolLibrary: Tool[] } {
  const tool = makeTool({ id: 't1', toolNumber: 1 })
  const op = makeOp({
    id: 'op-face',
    name: 'Face Op',
    type: 'face',
    toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
  const setup: Setup = {
    id: 'setup1',
    name: 'Setup 1',
    wcs: makeWcs({ fixtureOffset: 54, label: 'G54', stockId: 'stock1' }),
    stock: makeStock({ material: 'aluminum' }),
    operations: [op],
    notes: 'e2e notes',
  }
  const stock: PhysicalStock = {
    id: 'stock1',
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
    id: 'proj-e2e',
    name: 'E2E Part',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [tool],
    geometry: [],
    setups: [setup],
    activeSetupId: 'setup1',
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    stocks: [stock],
    notes: '',
  }
  op.smartHeight = { kind: 'smart_v2', intent: makeV2FaceIntent() }
  op.resolvedHeightPlan = makeV2Plan()
  stampGenerationCurrent(project, setup, op, tool)
  return { project, toolLibrary: [tool] }
}

async function connectSimulator(): Promise<void> {
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  await vi.advanceTimersByTimeAsync(300)
  __resetEstopInterlockForTest()
  expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
  if (!setWorkOffsetValue('G54', 'Z', -5)) throw new Error('The simulator refused the G54 Z fixture offset.')
  await vi.advanceTimersByTimeAsync(50)
}

async function teardown(): Promise<void> {
  cleanup()
  act(() => { getMachineController().emergencyStop() })
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(200)
  await pending
  vi.useRealTimers()
  act(() => useMachineControl.getState().setSingleBlock(false))
}

describe('WO-379: boundary immutability and atomic binding through the real session', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    selectProgramMotionFixture()
    await connectSimulator()
  })

  afterEach(teardown)

  it('direct load binds a deep-copied frozen snapshot to the loaded program', () => {
    const { project, setup, gcode } = makeFixture()
    const ctx = buildProgramContext(project, setup, GRBL_CONFIG, gcode, fixtureSpans(setup, gcode))

    act(() => { loadMachineProgram('setup.nc', gcode, ctx) })
    const s = useMachineControl.getState()
    expect(s.programContext).not.toBeNull()
    expect(s.programContext).not.toBe(ctx) // stored as a separate frozen copy
    expect(Object.isFrozen(s.programContext)).toBe(true)
    expect(s.programContext!.motionDigest).toBe(computeMotionDigest(gcode))
    expect(s.programContext!.project.id).toBe('projA')
    expect(s.programText).toBe(gcode)
  })

  it('a mutable caller object is copied + frozen; mutating the original cannot reach the store', () => {
    const { project, setup, gcode } = makeFixture()
    const frozen = buildProgramContext(project, setup, GRBL_CONFIG, gcode, [
      { opId: 'opA', setupId: 'setupA', startLine: 1, endLine: 3 },
    ])
    const mutable = JSON.parse(JSON.stringify(frozen))

    act(() => { loadMachineProgram('setup.nc', gcode, mutable) })
    const stored = useMachineControl.getState().programContext!

    // Mutate the ORIGINAL mutable object and nested values afterward.
    mutable.notes = 'hacked'
    mutable.operations[0].name = 'hacked op'
    mutable.stock.name = 'hacked stock'
    mutable.wcs.label = 'G55'

    expect(stored.notes).toBe('notes-A')
    expect(stored.operations[0].name).toBe('Face')
    expect(stored.stock!.name).toBe('Stock A')
    expect(stored.wcs.label).toBe('G54')
    expect(Object.isFrozen(stored)).toBe(true)
    expect(stored.motionDigest).toBe(computeMotionDigest(useMachineControl.getState().programText!))
  })

  it('arbitrary file load creates an explicit no-context state', () => {
    act(() => { loadMachineProgram('file.nc', GCODE_OTHER) })
    expect(useMachineControl.getState().programContext).toBeNull()
  })

  it("WO-397: an ordinary file shows 'No setup information' and nothing claims it matches the project", () => {
    act(() => { loadMachineProgram('file.nc', GCODE_OTHER) })
    render(<ProgramPanel />)
    const chip = screen.getByTestId('control-program-context')
    expect(chip.getAttribute('data-staleness')).toBe('no-context')
    expect(chip.textContent).toBe('No setup information')
    expect(screen.queryByText(/^Setup: /)).toBeNull()
    expect(compareProgramContext(null, useCamStore.getState().project, GCODE_OTHER, GRBL_CONFIG)).toBe('no-context')
  })

  it('arbitrary file load cannot inherit context from a previous direct load', () => {
    const { project, setup, gcode } = makeFixture()
    const ctx = buildProgramContext(project, setup, GRBL_CONFIG, gcode, fixtureSpans(setup, gcode))
    act(() => { loadMachineProgram('setup.nc', gcode, ctx) })
    expect(useMachineControl.getState().programContext).not.toBeNull()

    act(() => { loadMachineProgram('file.nc', GCODE_OTHER) })
    expect(useMachineControl.getState().programContext).toBeNull()
    expect(useMachineControl.getState().programText).toBe(GCODE_OTHER)
  })

  it('reposting/reloading atomically replaces program and context', () => {
    const a = makeFixture('projA', 'Setup A', 'notes-A')
    const b = makeFixture('projB', 'Setup B', 'notes-B')
    const ctxA = buildProgramContext(a.project, a.setup, GRBL_CONFIG, a.gcode, fixtureSpans(a.setup, a.gcode))
    const ctxB = buildProgramContext(b.project, b.setup, GRBL_CONFIG, b.gcode, fixtureSpans(b.setup, b.gcode))

    act(() => { loadMachineProgram('a.nc', a.gcode, ctxA) })
    expect(useMachineControl.getState().programContext!.project.id).toBe('projA')

    act(() => { loadMachineProgram('b.nc', b.gcode, ctxB) })
    expect(useMachineControl.getState().programContext!.project.id).toBe('projB')
    expect(useMachineControl.getState().programText).toBe(b.gcode)
  })

  it('clearing the program clears its context in the same atomic step', () => {
    const { project, setup, gcode } = makeFixture()
    const ctx = buildProgramContext(project, setup, GRBL_CONFIG, gcode, fixtureSpans(setup, gcode))
    act(() => { loadMachineProgram('setup.nc', gcode, ctx) })
    expect(useMachineControl.getState().programContext).not.toBeNull()

    act(() => { useMachineControl.getState().setProgram(null, null) })
    expect(useMachineControl.getState().programText).toBeNull()
    expect(useMachineControl.getState().programContext).toBeNull()
  })

  it('re-loading the same text preserves the context (re-arm / mesh re-arm path)', () => {
    const { project, setup, gcode } = makeFixture()
    const ctx = buildProgramContext(project, setup, GRBL_CONFIG, gcode, fixtureSpans(setup, gcode))
    act(() => { loadMachineProgram('setup.nc', gcode, ctx) })
    const stored = useMachineControl.getState().programContext

    // loadMachineProgram(name, text) with no context = the re-arm path.
    act(() => { loadMachineProgram('setup.nc', gcode) })
    expect(useMachineControl.getState().programContext).toBe(stored)
  })

  it('arm/run/hold/resume/completion do not mutate the context', async () => {
    const { project, setup, gcode } = makeFixture()
    const ctx = buildProgramContext(project, setup, GRBL_CONFIG, gcode, fixtureSpans(setup, gcode))
    act(() => { loadMachineProgram('setup.nc', gcode, ctx) })
    const ref = useMachineControl.getState().programContext

    expect(getMachineController().startJob()).toBe(true)
    expect(useMachineControl.getState().programContext).toBe(ref)

    act(() => getMachineController().pauseJob())
    expect(useMachineControl.getState().programContext).toBe(ref)

    act(() => getMachineController().resumeJob())
    expect(useMachineControl.getState().programContext).toBe(ref)

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(useMachineControl.getState().programContext).toBe(ref)
    expect(Object.isFrozen(ref)).toBe(true)
  })

  it('context presence cannot change motion, and tampering is refused before controller/store mutation', () => {
    const { project, setup, gcode } = makeFixture()
    const ctx = buildProgramContext(project, setup, GRBL_CONFIG, gcode, fixtureSpans(setup, gcode))
    const expectedLines = prepareProgram(gcode).lines.length

    act(() => { loadMachineProgram('plain.nc', gcode) })
    expect(getMachineController().jobProgress().totalLines).toBe(expectedLines)

    act(() => { loadMachineProgram('with-context.nc', gcode, ctx) })
    expect(getMachineController().jobProgress().totalLines).toBe(expectedLines)
    const storedContext = useMachineControl.getState().programContext

    const impostor = { ...ctx, motionDigest: 'sha256:deadbeef' }
    expect(() => act(() => { loadMachineProgram('tampered.nc', gcode, impostor) })).toThrow(
      /invalid program-context snapshot/,
    )
    expect(getMachineController().jobProgress().totalLines).toBe(expectedLines)
    expect(useMachineControl.getState().programText).toBe(gcode)
    expect(useMachineControl.getState().job.name).toBe('with-context.nc')
    expect(useMachineControl.getState().programContext).toBe(storedContext)
  })
})

describe('WO-379: real lifecycle paths (newProject / disconnect)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    selectProgramMotionFixture()
    await connectSimulator()
  })

  afterEach(teardown)

  it('newProject does NOT unload the machine program; it becomes project-changed', () => {
    const { project, setup, gcode } = makeFixture()
    const ctx = buildProgramContext(project, setup, GRBL_CONFIG, gcode, fixtureSpans(setup, gcode))
    act(() => { loadMachineProgram('setup.nc', gcode, ctx) })
    const stored = useMachineControl.getState().programContext

    act(() => { useCamStore.getState().newProject() })

    // The loaded machine program and its frozen snapshot are NOT unloaded.
    expect(useMachineControl.getState().programText).toBe(gcode)
    expect(useMachineControl.getState().programContext).toBe(stored)
    expect(useMachineControl.getState().programContext!.project.id).toBe('projA')

    // But the snapshot is now stale against the live (new) project.
    expect(
      compareProgramContext(stored, useCamStore.getState().project, gcode, GRBL_CONFIG),
    ).toBe('project-changed')
  })

  it('disconnect does NOT clear the program or its context (it is not a program unload)', async () => {
    const { project, setup, gcode } = makeFixture()
    const ctx = buildProgramContext(project, setup, GRBL_CONFIG, gcode, fixtureSpans(setup, gcode))
    act(() => { loadMachineProgram('setup.nc', gcode, ctx) })
    const stored = useMachineControl.getState().programContext

    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(200)
    await pending

    expect(useMachineControl.getState().programText).toBe(gcode)
    expect(useMachineControl.getState().programContext).toBe(stored)
    expect(useMachineControl.getState().connectionPhase).toBe('disconnected')
  })

  it('a fresh setup load from a NEW project replaces the old snapshot (no stale retention)', () => {
    const a = makeFixture('projA', 'Setup A', 'notes-A')
    const b = makeFixture('projB', 'Setup B', 'notes-B')
    const ctxA = buildProgramContext(a.project, a.setup, GRBL_CONFIG, a.gcode, fixtureSpans(a.setup, a.gcode))

    act(() => { loadMachineProgram('a.nc', a.gcode, ctxA) })
    expect(useMachineControl.getState().programContext!.project.id).toBe('projA')

    const ctxB = buildProgramContext(b.project, b.setup, GRBL_CONFIG, b.gcode, fixtureSpans(b.setup, b.gcode))
    act(() => { loadMachineProgram('b.nc', b.gcode, ctxB) })
    expect(useMachineControl.getState().programContext!.project.id).toBe('projB')
    expect(compareProgramContext(ctxA, b.project, a.gcode, GRBL_CONFIG)).toBe('project-changed')
  })
})

describe('WO-379: end-to-end "Load setup" through the real post + UI path', () => {
  afterEach(() => { cleanup() })
  it('stores a context that matches the exact emitted program, order, spans, and inputs', async () => {
    const { project, toolLibrary } = makePostableProject()
    act(() => { useCamStore.setState({ project, toolLibrary }) })

    // Independently compute the expected post result through the real path.
    // UCCNC, because THIS FIXTURE'S MACHINE DECLARES controller: 'uccnc'
    // (tests/post/helpers makeMachine). "Load setup" used to post every project
    // through GRBL_CONFIG regardless of the machine, and this expectation was
    // built the same way - so the test agreed with the panel by sharing its
    // defect, and a UCCNC machine silently got GRBL-flavoured G-code. Both now
    // resolve the dialect from the machine, so this asserts the CONTRACT (the
    // post follows the declared controller) rather than a hardcode.
    const expected = postProject({ ...project, toolLibrary }, [project.setups[0]], UCCNC_CONFIG, {
      mode: 'combined',
      pauseBetweenSetups: false,
      baseName: 'control',
      ext: 'nc',
      modelRefsVerifiedSinceLoad: true,
    })
    expect(expected.ok).toBe(true)

    render(<ProgramPanel />)
    // WO-414 batch 3 (R6): "Load setup" is an item of the one Load menu.
    fireEvent.click(screen.getByTestId('control-load-menu'))
    const button = screen.getByTestId(`control-load-setup-item-${project.setups[0].id}`)
    expect((button as HTMLButtonElement).disabled).toBe(false)

    await act(async () => { fireEvent.click(button) })

    const ctx = useMachineControl.getState().programContext
    expect(ctx).not.toBeNull()
    expect(useMachineControl.getState().programText).toBe(expected.combined!.gcode)

    // Motion digest is the canonical SHA-256 of the exact emitted program.
    expect(ctx!.motionDigest).toBe(computeMotionDigest(expected.combined!.gcode))
    expect(ctx!.motionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    // Emitted operation order + verified source-line spans come from the post.
    expect(ctx!.operations.map((o) => o.id)).toEqual(
      expected.combined!.operationSpans!.map((s) => s.opId),
    )
    expect(ctx!.operations.map((o) => [o.startLine, o.endLine])).toEqual(
      expected.combined!.operationSpans!.map((s) => [s.startLine, s.endLine]),
    )

    // Manufacturing inputs are captured exactly.
    expect(ctx!.source).toBe('live-setup')
    expect(ctx!.project.id).toBe('proj-e2e')
    expect(ctx!.setup.id).toBe('setup1')
    expect(ctx!.stock!.id).toBe('stock1')
    expect(ctx!.wcs.label).toBe('G54')
    // The context records the dialect the program was ACTUALLY posted with, and
    // that dialect comes from the machine - this fixture declares
    // controller: 'uccnc'. It is asserted here rather than left implicit because
    // the post config is part of the hashed program intent: post with one
    // dialect and compare with another and the panel reports "the project
    // changed" forever, on a program nobody touched.
    expect(ctx!.post.id).toBe(UCCNC_CONFIG.id)
    expect(ctx!.post.id).toBe(project.machine!.controller)
    expect(ctx!.notes).toBe('e2e notes')
    expect(Object.isFrozen(ctx)).toBe(true)
  })

  it('WO-396: a tree click re-resolves nothing; a real edit still recomputes on the next render', async () => {
    const { project, toolLibrary } = makePostableProject()
    act(() => { useCamStore.setState({ project, toolLibrary }) })
    render(<ProgramPanel />)
    fireEvent.click(screen.getByTestId('control-load-menu'))
    await act(async () => { fireEvent.click(screen.getByTestId(`control-load-setup-item-${project.setups[0].id}`)) })
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('current')
    // Settle: any pending render has run.
    await act(async () => {})
    const before = sectionCalls.n
    const t0 = performance.now()
    // Ten tree clicks: only the UI selection fields move; the project object is replaced each time.
    for (let i = 0; i < 10; i++) {
      act(() => { useCamStore.setState((st) => ({ project: { ...st.project, activeOperationId: `click-${i}` } })) })
    }
    const clickMs = performance.now() - t0
    expect(sectionCalls.n).toBe(before)
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('current')
    // A real intent edit (setup notes are in the digest) recomputes at once - no staleness window.
    const t1 = performance.now()
    act(() => {
      useCamStore.setState((st) => ({
        project: { ...st.project, setups: st.project.setups.map((s, i) => (i === 0 ? { ...s, notes: 'edited' } : s)) },
      }))
    })
    const editMs = performance.now() - t1
    expect(sectionCalls.n).toBeGreaterThan(before)
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('project-changed')
    // eslint-disable-next-line no-console
    console.log(`[wo396] 10 tree clicks: ${clickMs.toFixed(1)} ms, 0 section resolutions; one real edit: ${editMs.toFixed(1)} ms, ${sectionCalls.n - before} resolution(s)`)
  })
})
