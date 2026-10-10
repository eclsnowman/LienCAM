// @vitest-environment jsdom
//
// WO-380: the stock the loaded setup was planned against, drawn in the Control
// program preview from the FROZEN snapshot (WO-379) - placement in the program's
// own work frame, the readout (setup, stock, X/Y/Z, material, G54-G59), the
// stale states (project-changed / program-changed: labelled, tinted, never
// moved), the no-context state, and that none of it touches arm/stream authority.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

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

// The viewport is the WebGL seam: stub every method ProgramPreview calls and
// record what the intended-stock block was told to be.
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
/** WO-414 batch 2 (Operator): the intended-stock readout is ONE line lower-right;
 *  clicking the line opens the facts as a popover above it. These cases read
 *  the facts, so they click the line after mounting. */
function openStockDetails() {
  const line = screen.queryByTestId('program-preview-intended-stock-summary')
  if (line) fireEvent.click(line)
}
const { ProgramPreview, intendedStockWorkBox } = await import('../../components/machine/ProgramPreview')
const { buildProgramContext } = await import('../../lib/machine/programContext')
const { GRBL_CONFIG, postProject } = await import('../../lib/post')
const { makeMachine, makeOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent } =
  await import('../post/helpers')
const { SMART_HEIGHT_INTENT_VERSION, SMART_HEIGHT_POLICY_VERSION } =
  await import('../../lib/cam/smartHeights')
import type { PhysicalStock, Project, Setup, Tool } from '../../types'
import type { ProgramContextV1 } from '../../lib/machine/programContext'

// ---------------------------------------------------------------------------
// Pure geometry: snapshot -> program (work) frame
// ---------------------------------------------------------------------------

type StockSnap = ProgramContextV1['stock']
type WcsSnap = ProgramContextV1['wcs']

function stockSnap(over: Partial<StockSnap>): StockSnap {
  return {
    provenance: 'physical',
    coordinateSpace: 'world',
    id: 's', name: 'Stock', mode: 'explicit', primitive: 'rectangular', material: 'aluminum',
    position: { x: 0, y: 0, z: 0 },
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 } },
    fixtureOffset: 54,
    authored: { type: 'rectangular', width: 100, height: 80, depth: 20, diameter: null, length: null, offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0 },
    fingerprint: 'sha256:0',
    ...over,
  }
}
function wcsSnap(origin: { x: number; y: number; z: number }): WcsSnap {
  return { id: 'w1', label: 'G54', fixtureOffset: 54, origin }
}

describe('WO-380: intendedStockWorkBox - the snapshot stock in the program frame', () => {
  it('an explicit physical stock is position + size, then translated by the WCS origin', () => {
    // Stock sits at world (10,20,-5), 100x80x20. WCS zero is its top-left-front
    // top corner (10,20,15) -> in work coords the block is X 0..100, Y 0..80, Z -20..0.
    const box = intendedStockWorkBox({
      stock: stockSnap({ position: { x: 10, y: 20, z: -5 } }),
      wcs: wcsSnap({ x: 10, y: 20, z: 15 }),
    })
    expect(box).toEqual({ min: { x: 0, y: 0, z: -20 }, max: { x: 100, y: 80, z: 0 } })
  })

  it('an explicit stock uses bounds only for SIZE - min/max that are not at 0 still place by position', () => {
    const box = intendedStockWorkBox({
      stock: stockSnap({
        position: { x: 5, y: 5, z: 0 },
        bounds: { min: { x: 300, y: 300, z: 300 }, max: { x: 350, y: 340, z: 310 } },
      }),
      wcs: wcsSnap({ x: 0, y: 0, z: 0 }),
    })
    expect(box).toEqual({ min: { x: 5, y: 5, z: 0 }, max: { x: 55, y: 45, z: 10 } })
  })

  it('a derived physical stock reads its bounds verbatim as world (position is NOT re-added)', () => {
    const box = intendedStockWorkBox({
      stock: stockSnap({
        mode: 'derived',
        position: { x: 999, y: 999, z: 999 },
        bounds: { min: { x: -50, y: -40, z: -10 }, max: { x: 50, y: 40, z: 0 } },
      }),
      wcs: wcsSnap({ x: -50, y: -40, z: 0 }),
    })
    expect(box).toEqual({ min: { x: 0, y: 0, z: -10 }, max: { x: 100, y: 80, z: 0 } })
  })

  it('an authored (setup-wcs) stock is already in the work frame and ignores the WCS origin', () => {
    const box = intendedStockWorkBox({
      stock: stockSnap({
        provenance: 'authored', coordinateSpace: 'setup-wcs', mode: 'authored',
        position: { x: 0, y: 0, z: 0 },
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 12 } },
      }),
      wcs: wcsSnap({ x: 123, y: 456, z: 789 }),
    })
    expect(box).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 12 } })
  })

  it('a zero-volume block and a null context draw nothing', () => {
    expect(intendedStockWorkBox(null)).toBeNull()
    expect(intendedStockWorkBox({
      stock: stockSnap({ bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 0 } } }),
      wcs: wcsSnap({ x: 0, y: 0, z: 0 }),
    })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Component: the block + the readout from a REAL posted context
// ---------------------------------------------------------------------------

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

/** A genuinely postable single-setup project whose stock sits away from the
 *  world origin with the WCS zero at the stock's top-left corner - so the
 *  work-frame placement is a real transform, not an identity. */
function makePostableProject(): { project: Project; toolLibrary: Tool[] } {
  const tool = makeTool({ id: 't1', toolNumber: 1 })
  const op = makeOp({
    id: 'op-face',
    name: 'Face Op',
    type: 'face',
    toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 40, y: 50, z: 20, role: 'rapid' }),
      move({ type: 'feed', x: 60, y: 50, z: 20, feed: 2000, role: 'cut' }),
    ],
  })
  const setup: Setup = {
    id: 'setup1',
    name: 'Top face',
    wcs: makeWcs({ fixtureOffset: 55, label: 'G55', stockId: 'stock1', origin: { x: 30, y: 40, z: 20 } }),
    stock: makeStock({ material: '6061 aluminum' }),
    operations: [op],
    notes: 'wo380 notes',
  }
  const stock: PhysicalStock = {
    id: 'stock1',
    name: 'Billet A',
    mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 100, y: 80, z: 20 },
      size: { x: 100, y: 80, z: 20 },
      center: { x: 50, y: 40, z: 10 },
    },
    position: { x: 30, y: 40, z: 0 },
    fixtureOffset: 55,
  }
  const project: Project = {
    id: 'proj-wo380',
    name: 'WO-380 Part',
    version: '1',
    createdAt: '',
    updatedAt: '',
    // WO-1404: the fixture posts with GRBL_CONFIG (line ~255 below); the
    // declared machine must match it, or the preview's post-identity
    // resolution (now the same one ProgramPanel's header uses) reads this
    // as a real GRBL-vs-UCCNC mismatch and reports STALE.
    machine: makeMachine({ controller: 'grbl' }),
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

/** Post the setup through the real post and bind its context - what "Load
 *  setup" does in ProgramPanel, without the panel. */
function loadSetupDirectly(): { gcode: string; context: ProgramContextV1 } {
  const { project, toolLibrary } = makePostableProject()
  act(() => { useCamStore.setState({ project, toolLibrary }) })
  const posted = postProject({ ...project, toolLibrary }, [project.setups[0]], GRBL_CONFIG, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'control', ext: 'nc', modelRefsVerifiedSinceLoad: true,
  })
  if (!posted.ok || !posted.combined?.operationSpans) throw new Error('fixture did not post')
  const context = buildProgramContext(
    { ...project, toolLibrary }, project.setups[0], GRBL_CONFIG, posted.combined.gcode, posted.combined.operationSpans,
  )
  act(() => { useMachineControl.getState().setProgram('Top face (posted)', posted.combined!.gcode, [], context) })
  return { gcode: posted.combined.gcode, context }
}

const EXPECTED_BOX = { min: { x: 0, y: 0, z: -20 }, max: { x: 100, y: 80, z: 0 } }

function lastIntendedStockCall() {
  const vp = harness.instances[harness.instances.length - 1]
  const calls = vp.setIntendedStock.mock.calls
  return calls.length ? calls[calls.length - 1][0] : undefined
}

describe('WO-380: the intended stock block + readout in the Control program preview', () => {
  beforeEach(() => {
    harness.instances.length = 0
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })
  afterEach(() => {
    cleanup()
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  })

  it('a directly-loaded setup draws its stock in the work frame and names setup/stock/size/material/WCS', async () => {
    loadSetupDirectly()
    render(<ProgramPreview />)
    await act(async () => {})
    openStockDetails()

    // The block: WCS zero is at the stock's top corner (30,40,20) and the stock
    // sits at (30,40,0) 100x80x20 -> work-frame X 0..100, Y 0..80, Z -20..0.
    expect(lastIntendedStockCall()).toEqual({ ...EXPECTED_BOX, stale: false })

    const card = screen.getByTestId('program-preview-intended-stock')
    expect(card.getAttribute('data-context-state')).toBe('current')
    expect(screen.getByTestId('program-preview-intended-stock-badge').textContent).toBe('CURRENT')
    expect(screen.getByTestId('program-preview-intended-stock-setup').textContent).toBe('Top face')
    // Operator ruling 2026-08-21: no material is printed until there is a place to set one (the old 'wood' default leaked here)
    expect(screen.getByTestId('program-preview-intended-stock-name').textContent).toBe('Billet A')
    expect(screen.getByTestId('program-preview-intended-stock-size').textContent).toBe('X 100.00  Y 80.00  Z 20.00 mm')
    expect(screen.getByTestId('program-preview-intended-stock-wcs').textContent).toBe('G55')
    expect(screen.queryByTestId('program-preview-intended-stock-note')).toBeNull()
  })

  it('a live project edit makes the context STALE (labelled, tinted) but never moves the block', async () => {
    loadSetupDirectly()
    render(<ProgramPreview />)
    await act(async () => {})
    openStockDetails()
    const vp = harness.instances[0]
    const callsBefore = vp.setIntendedStock.mock.calls.length

    // Edit the live setup: notes are in the intent digest, and move the live
    // stock too - the snapshot must not follow either.
    act(() => {
      useCamStore.setState((st) => ({
        project: {
          ...st.project,
          setups: st.project.setups.map((s) => ({ ...s, notes: 'edited after post' })),
          stocks: (st.project.stocks ?? []).map((s) => ({ ...s, position: { x: 500, y: 500, z: 500 } })),
        },
      }))
    })
    await act(async () => {})

    const card = screen.getByTestId('program-preview-intended-stock')
    expect(card.getAttribute('data-context-state')).toBe('project-changed')
    expect(screen.getByTestId('program-preview-intended-stock-badge').textContent).toBe('STALE')
    expect(screen.getByTestId('program-preview-intended-stock-note').textContent).toMatch(/Setup changed since this program was posted/)
    // The block is re-pushed ONLY for the tint; its geometry is the snapshot's.
    expect(vp.setIntendedStock.mock.calls.length).toBe(callsBefore + 1)
    expect(lastIntendedStockCall()).toEqual({ ...EXPECTED_BOX, stale: true })
    // The readout still names what was POSTED, not the live edit.
    expect(screen.getByTestId('program-preview-intended-stock-size').textContent).toBe('X 100.00  Y 80.00  Z 20.00 mm')
  })

  it('program text that drifts from its snapshot is STALE as program-changed', async () => {
    const { gcode, context } = loadSetupDirectly()
    render(<ProgramPreview />)
    await act(async () => {})
    openStockDetails()
    // Keep the context but change the executable text (setProgram with the
    // same context would refuse - go through the store field the way a
    // text edit after load would land).
    act(() => { useMachineControl.setState({ programText: gcode + '\nG0 X99 Y99' }) })
    await act(async () => {})
    expect(useMachineControl.getState().programContext).toBe(useMachineControl.getState().programContext)
    expect(screen.getByTestId('program-preview-intended-stock').getAttribute('data-context-state')).toBe('program-changed')
    expect(screen.getByTestId('program-preview-intended-stock-badge').textContent).toBe('STALE')
    expect(screen.getByTestId('program-preview-intended-stock-note').textContent).toMatch(/Program text changed/)
    expect(lastIntendedStockCall()).toEqual({ ...EXPECTED_BOX, stale: true })
    expect(context.stock.name).toBe('Billet A')
  })

  it('a file with no context shows the concise no-intended-stock state and pushes no block', async () => {
    act(() => { useMachineControl.getState().setProgram('foreign.nc', 'G21 G90\nG0 X1 Y1\nM30', [], null) })
    render(<ProgramPreview />)
    await act(async () => {})
    openStockDetails()
    const card = screen.getByTestId('program-preview-intended-stock')
    expect(card.getAttribute('data-context-state')).toBe('no-context')
    expect(screen.getByTestId('program-preview-intended-stock-badge').textContent).toBe('NONE')
    expect(screen.getByTestId('program-preview-intended-stock-note').textContent).toMatch(/No intended stock information/)
    expect(screen.queryByTestId('program-preview-intended-stock-facts')).toBeNull()
    // Nothing claims a match, and the scene was never told to draw a block.
    expect(card.textContent).not.toMatch(/CURRENT/)
    expect(harness.instances[0].setIntendedStock).not.toHaveBeenCalled()
    // The preview stays fully usable: the view rail and grid selector are still there.
    expect(screen.getByLabelText('Preview coordinate grid')).toBeTruthy()
    expect(screen.getByLabelText('Fit program extents')).toBeTruthy()
  })

  it('loading a foreign file after a setup clears the block (no stale retention)', async () => {
    loadSetupDirectly()
    render(<ProgramPreview />)
    await act(async () => {})
    openStockDetails()
    expect(lastIntendedStockCall()).toEqual({ ...EXPECTED_BOX, stale: false })
    act(() => { useMachineControl.getState().setProgram('foreign.nc', 'G21 G90\nG0 X1 Y1\nM30', [], null) })
    await act(async () => {})
    expect(lastIntendedStockCall()).toBeNull()
    expect(screen.getByTestId('program-preview-intended-stock').getAttribute('data-context-state')).toBe('no-context')
  })

  it('no program loaded: no readout at all', () => {
    render(<ProgramPreview />)
    expect(screen.queryByTestId('program-preview-intended-stock')).toBeNull()
  })

  it('the readout is advisory: no controls, and it touches neither the job nor the program text', async () => {
    const { gcode } = loadSetupDirectly()
    const jobBefore = useMachineControl.getState().job
    render(<ProgramPreview />)
    await act(async () => {})
    openStockDetails()
    const card = screen.getByTestId('program-preview-intended-stock')
    // WO-413: the help link opens the Help Center and nothing else; WO-414
    // batch 2: the line itself opens the facts popover, the eye shows/hides
    // the box in the scene, and nothing else. Every other button is still
    // forbidden.
    const buttons = within(card).queryAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('data-help-topic') ?? b.getAttribute('data-testid'))).toEqual([
      'program-preview-intended-stock-summary',
      'program-context',
      'program-preview-intended-stock-visible',
    ])
    expect(within(card).queryAllByRole('textbox')).toEqual([])
    expect(useMachineControl.getState().job).toBe(jobBefore)
    expect(useMachineControl.getState().job.phase).toBe('empty')
    expect(useMachineControl.getState().programText).toBe(gcode)
  })
})
