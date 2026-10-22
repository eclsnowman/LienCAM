// @vitest-environment jsdom
// WO-3021: a Chamfer takes its path, width and depth from a chamfer the part
// already has.
//
// the operator (2026-10-21): "Do we have the ability to select a 2d modeled chamfer and
// have it know the path, and the correct setting to reproduce it, then use
// those?" - and on the card: "pick a modeled chamfer (or all on a part) and the
// op takes the edge path, width and depth from it; if the bit angle differs
// from the chamfer angle it says so in one line."
//
// Measured against the Full Suite Plate (outer bevel 0.50 x 0.50 at Z 4.0,
// bolt/boss mouths 0.25 x 0.25 at Z 4.0, shaft mouth 0.25 at Z 1.8) and its
// hand-built finish chamfers, ops 10-13 of Setup 1. The Plate's chamfers are
// read from its own STL bytes, the operations computed by the store's own
// compute, the dialog driven through its real buttons.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, Project } from '../../types'
import { typedMock } from '../support/typedMock'

const stlBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, bytes: ArrayBuffer) => { stlBytes.set(id, bytes) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytes.get(id) ?? null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return memory.size }, clear: () => memory.clear(),
    getItem: (k: string) => memory.get(k) ?? null, key: (i: number) => [...memory.keys()][i] ?? null,
    removeItem: (k: string) => { memory.delete(k) }, setItem: (k: string, v: string) => { memory.set(k, String(v)) },
  },
  configurable: true,
})

const { useCamStore, smartHeightStockBounds } = await import('../../store')

// The real toolpathWorker in-process behind a Worker shim (spindleStopsRaised.
// wo2693's pattern, in jsdom: the worker's `self` is this window). Every reply
// names its operation, so each goes back to the shim that asked for it.
type WorkerMsg = import('../../lib/cam/types').WorkerResponseMsg
type WorkerReq = import('../../lib/cam/types').WorkerRequestMsg
type Vec3 = { x: number; y: number; z: number }
type Shim = { onmessage: ((e: { data: WorkerMsg }) => void) | null }
const shimFor = new Map<string, Shim>()
const scope = window as unknown as {
  postMessage: (m: WorkerMsg) => void
  onmessage: ((e: { data: WorkerReq }) => Promise<void>) | null
  __cncViewport?: unknown
  Worker: unknown
}
scope.postMessage = (m: WorkerMsg) => {
  const key = 'opId' in m ? m.opId : m.nestId
  shimFor.get(key)?.onmessage?.({ data: m })
}
await import('../../lib/cam/toolpathWorker')
const workerHandler = scope.onmessage
if (typeof workerHandler !== 'function') throw new Error('the real toolpathWorker did not install its handler')
scope.onmessage = null
scope.Worker = class {
  onmessage: ((e: { data: WorkerMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(data: WorkerReq): void {
    const payload = (data as unknown as { payload?: { opId?: string; nestId?: string } }).payload
    const key = payload?.opId ?? payload?.nestId ?? (data as unknown as { opId?: string }).opId
    if (key) shimFor.set(key, this)
    void workerHandler!({ data })
  }
  terminate(): void { for (const [k, v] of shimFor) if (v === this) shimFor.delete(k) }
}
// The rendered stock box (CNCViewport.getStockBounds), from the store's own bounds.
// The 3D view's loop pick: the dialog hands it a callback; a test click calls it.
const viewportPick: { onLoop: ((loopId: string, nowSelected: boolean) => void) | null; picked: string[] } = { onLoop: null, picked: [] }
scope.__cncViewport = {
  setLoopPickMode: (onLoop: ((loopId: string, nowSelected: boolean) => void) | null) => { viewportPick.onLoop = onLoop },
  setPickedLoops: (ids: string[]) => { viewportPick.picked = [...ids] },
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const ids = stockId !== undefined ? [stockId] : (project.stocks ?? []).map(s => s.id)
    const boxes = ids.map(id => smartHeightStockBounds(project, id)).filter((b): b is { min: Vec3; max: Vec3 } => b !== null)
    if (boxes.length === 0) return null
    return {
      min: { x: Math.min(...boxes.map(b => b.min.x)), y: Math.min(...boxes.map(b => b.min.y)), z: Math.min(...boxes.map(b => b.min.z)) },
      max: { x: Math.max(...boxes.map(b => b.max.x)), y: Math.max(...boxes.map(b => b.max.y)), z: Math.max(...boxes.map(b => b.max.z)) },
    }
  },
}
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const {
  chamferAngleNote, chamferParamsFromPass, modeledChamferRecordOf, modeledChamfersOnPart, modeledPassDatum,
} = await import('../../lib/cam/chamferFromModel')
const { rebuildChamferSmartHeightFormulaIntent } = await import('../../lib/cam/smartHeights')
const { intentReferenceForUiReference } = await import('../../lib/cam/heightReference')
const { loadCachedSTL } = await import('../../lib/stlCache')
const { resolveGeometryZToFramesModelAwareSafe, resolveTopZ, transformLoopPoints } = await import('../../store/dispatchGeo')
const frames = { resolveGeometryZToFramesModelAwareSafe, resolveTopZ, transformLoopPoints }

const FINISH_OPS = ['wo2935-plate-chamfer', 'wo2935-plate-chamfer-bolts', 'wo2935-plate-chamfer-boss', 'wo2935-plate-chamfer-shaft']
const noStep = async () => null
const unusedKernel = async () => { throw new Error('no STEP part in this case') }

let fullSuite: Project
const setup1 = () => useCamStore.getState().project.setups[0]
const plate = (): ImportedGeometry => useCamStore.getState().project.geometry.find(g => g.name === 'Plate')!
const exampleOp = (id: string): Operation => setup1().operations.find(o => o.id === id)!
const loaders = () => ({
  loadStl: loadCachedSTL, loadStep: noStep, readStepChamfers: unusedKernel,
  placements: useCamStore.getState().project.modelItemPlacements ?? [], frames,
})
const datumContext = () => {
  const project = useCamStore.getState().project
  return { setup: setup1(), geometry: project.geometry, sceneStock: project.sceneStock, stocks: project.stocks ?? [], placements: project.modelItemPlacements ?? [], frames }
}
const plateResult = async () => {
  const result = await modeledChamfersOnPart(plate(), loaders())
  expect(result, 'the Plate has a mesh to read').not.toBeNull()
  return result!
}

beforeAll(async () => {
  const text = readFileSync(join(process.cwd(), 'Example Projects/Full Suite.camproject'), 'utf8')
  await useCamStore.getState().loadProjectFromFile(text)
  fullSuite = useCamStore.getState().project
}, 600_000)
afterEach(cleanup)

describe('WO-3021 Chamfer from model on the Full Suite Plate', () => {
  it('All modeled chamfers: the outer 0.5 pass and the mouth passes, with the example ops\' loops, widths and heights', async () => {
    const result = await plateResult()
    const summary = result.passes.map(pass => ({
      loopIds: [...pass.loopIds].sort(),
      loopSides: pass.loopSides,
      chamferWidth: pass.chamferWidth,
      datum: modeledPassDatum(pass, datumContext()),
    }))
    // What the hand-built ops 10-13 carry, grouped the way one chamfer2d pass
    // can carry them: one reference height, one depth per pass.
    const expected = [
      ['wo2935-plate-chamfer'],
      ['wo2935-plate-chamfer-bolts', 'wo2935-plate-chamfer-boss'],
      ['wo2935-plate-chamfer-shaft'],
    ].map(ids => {
      const ops = ids.map(exampleOp)
      const params = ops.map(op => op.params as { loopIds: string[]; loopSides: Record<string, string>; chamferWidth: number; heightReference: string; planeOffset: number })
      return {
        loopIds: params.flatMap(p => p.loopIds).sort(),
        loopSides: Object.assign({}, ...params.map(p => p.loopSides)),
        chamferWidth: params[0].chamferWidth,
        datum: { heightReference: params[0].heightReference, planeOffset: params[0].planeOffset },
      }
    })
    expect(summary).toEqual(expected)
    expect(result.passes.map(p => [p.record.depthMm, p.record.widthMm, p.record.topZ])).toEqual([[0.5, 0.5, 4], [0.25, 0.2499, 4], [0.25, 0.25, 1.8]])
    expect(result.skipped).toEqual([])
    expect(result.unmatched).toBe(0)
  }, 120_000)

  it('each from-model pass computes the same moves as the hand-built finish chamfer (ops 10-13)', async () => {
    const result = await plateResult()
    const store = useCamStore.getState()
    const setupId = setup1().id
    const compared: Array<{ id: string; moves: number }> = []
    for (const id of FINISH_OPS) {
      const example = exampleOp(id)
      const exampleParams = example.params as unknown as import('../../lib/cam/types').ChamferParams
      const pass = result.passes.find(p => exampleParams.loopIds.every(l => p.loopIds.includes(l)))
      expect(pass, `${id}: a pass covers its loops`).toBeDefined()
      // Only this op's loops, so the two paths cover the same edges.
      const onlyThese = {
        ...pass!,
        loopIds: [...exampleParams.loopIds],
        loopSides: Object.fromEntries(exampleParams.loopIds.map(l => [l, pass!.loopSides[l]])),
      }
      const params = chamferParamsFromPass(exampleParams, plate().id, onlyThese, modeledPassDatum(onlyThese, datumContext()))
      const intent = example.smartHeight!.kind === 'smart_v2' ? example.smartHeight!.intent : undefined
      expect(intent, `${id}: Smart Height authority`).toBeDefined()
      const fromModel: Operation = {
        ...example, id: `${id}-from-model`, name: `${example.name} (from model)`,
        status: 'pending', toolpathMoves: undefined, resolvedHeights: undefined, resolvedHeightPlan: undefined, generationFingerprint: undefined,
        geometrySelections: [...params.loopIds],
        params: params as unknown as Record<string, unknown>,
        smartHeight: {
          kind: 'smart_v2',
          intent: rebuildChamferSmartHeightFormulaIntent({ intent: intent as import('../../lib/cam/smartHeights').OperationHeightIntentV2, patch: {
            datumReference: intentReferenceForUiReference(params.heightReference, 'top') as never,
            datumOffsetMm: params.planeOffset, chamferWidthMm: params.chamferWidth,
          } }),
        },
      }
      act(() => store.addOperation(setupId, fromModel))
      await store.computeOperationToolpath(setupId, example.id)
      await store.computeOperationToolpath(setupId, fromModel.id)
      const a = exampleOp(example.id); const b = exampleOp(fromModel.id)
      expect(b.errorMessage, `${id}: from-model op computes`).toBeUndefined()
      expect(a.toolpathMoves?.length ?? 0, `${id}: example op has moves`).toBeGreaterThan(0)
      expect(b.toolpathMoves, `${id}: same moves as the hand-built op`).toEqual(a.toolpathMoves)
      compared.push({ id, moves: b.toolpathMoves!.length })
      act(() => store.removeOperation(setupId, fromModel.id))
    }
    console.log(`[WO-3021] moves equal: ${JSON.stringify(compared)}`)
  }, 600_000)

  it('the dialog: All modeled chamfers fills the Chamfer, Create adds one operation per pass and they compute', async () => {
    act(() => useCamStore.setState({ project: fullSuite }))
    const before = setup1().operations.length
    const computed: string[] = []
    const realCompute = useCamStore.getState().computeOperationToolpath
    act(() => useCamStore.setState({ computeOperationToolpath: vi.fn(async (setupId: string, opId: string) => { computed.push(opId); await realCompute(setupId, opId) }) as never }))
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Chamfer'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('6mm pointed 90deg chamfer mill'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: plate().id } })
    const all = await screen.findByTestId('chamfer-from-model-all', {}, { timeout: 60_000 })
    expect(all.textContent).toBe('All modeled chamfers on this part (7)')
    fireEvent.click(all)
    expect(screen.getByTestId('chamfer-from-model-filled').textContent)
      .toBe('From the modeled chamfer: 0.500 mm deep, top edge at Z 4.000 mm on the part, 90°. The values stay editable.')
    expect(screen.getByTestId('chamfer-from-model-extra').textContent)
      .toBe('Create also adds 2 more Chamfer operation(s) for the modeled chamfers at other heights or sizes: 0.250 mm deep at top Z 4.000 mm (5 loop(s)); 0.250 mm deep at top Z 1.800 mm (1 loop(s)).')
    // The 90 deg bit is the modeled 90 deg chamfer: no angle line.
    expect(screen.queryByTestId('chamfer-angle-note')).toBeNull()
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false), { timeout: 60_000 })
    fireEvent.click(screen.getByTestId('op-create'))
    await waitFor(() => expect(setup1().operations.length).toBe(before + 3), { timeout: 60_000 })
    const added = setup1().operations.slice(before)
    const shape = added.map(op => {
      const p = op.params as Record<string, unknown> & { loopIds: string[]; modeledChamfer: { featureIds: string[] } }
      return { type: op.type, loops: [...p.loopIds].sort(), loopSides: p.loopSides, chamferWidth: p.chamferWidth,
        heightReference: p.heightReference, planeOffset: p.planeOffset, featureIds: p.modeledChamfer.featureIds.length }
    })
    const ex = (id: string) => exampleOp(id).params as { loopIds: string[]; loopSides: Record<string, string> }
    expect(shape).toEqual([
      { type: 'chamfer', loops: [...ex('wo2935-plate-chamfer').loopIds].sort(), loopSides: ex('wo2935-plate-chamfer').loopSides,
        chamferWidth: 0.5, heightReference: 'stock_bottom', planeOffset: 4, featureIds: 8 },
      { type: 'chamfer', loops: [...ex('wo2935-plate-chamfer-bolts').loopIds, ...ex('wo2935-plate-chamfer-boss').loopIds].sort(),
        loopSides: { ...ex('wo2935-plate-chamfer-bolts').loopSides, ...ex('wo2935-plate-chamfer-boss').loopSides },
        chamferWidth: 0.25, heightReference: 'stock_bottom', planeOffset: 4, featureIds: 5 },
      { type: 'chamfer', loops: [...ex('wo2935-plate-chamfer-shaft').loopIds], loopSides: ex('wo2935-plate-chamfer-shaft').loopSides,
        chamferWidth: 0.25, heightReference: 'stock_bottom', planeOffset: 1.8, featureIds: 1 },
    ])
    await waitFor(() => expect(added.every(op => computed.includes(op.id))).toBe(true), { timeout: 60_000 })
    await waitFor(() => expect(setup1().operations.slice(before).every(op => op.status !== 'computing' && op.status !== 'pending')).toBe(true), { timeout: 300_000 })
    expect(setup1().operations.slice(before).map(op => [op.status, op.errorMessage])).toEqual([['ready', undefined], ['ready', undefined], ['ready', undefined]])
    for (const op of setup1().operations.slice(before)) expect(op.toolpathMoves?.length ?? 0).toBeGreaterThan(0)
    // The op summary says where the values came from.
    cleanup()
    act(() => useCamStore.setState(state => ({ project: { ...state.project, activeSetupId: setup1().id, activeOperationId: added[2].id } })))
    render(createElement(PropertiesPanel))
    expect(screen.getByTestId('props-chamfer-from-model').textContent)
      .toBe('From the modeled chamfer: 0.250 mm deep, top edge at Z 1.800 mm on the part, 90°')
    expect(screen.queryByTestId('props-chamfer-angle-note')).toBeNull()
  }, 600_000)

  it('a 60 deg bit on the modeled 90 deg bevel: one line in the dialog and in the op summary, nothing refused', async () => {
    act(() => useCamStore.setState({ project: fullSuite }))
    const vbit60 = { ...useCamStore.getState().toolLibrary.find(t => t.id === 'wo2935-chamfer90')!, id: 'wo3021-vbit60', name: '60deg V-bit (WO-3021)', angleFromAxisDeg: 30 }
    act(() => useCamStore.setState(state => ({ toolLibrary: [...state.toolLibrary, vbit60] })))
    const before = setup1().operations.length
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Chamfer'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(vbit60.name))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: plate().id } })
    const outerLoop = (exampleOp('wo2935-plate-chamfer').params as { loopIds: string[] }).loopIds[0]
    fireEvent.click(await screen.findByTestId(`chamfer-from-model-pick-${outerLoop}`, {}, { timeout: 60_000 }))
    const line = 'This 60° bit is not the modeled 90° chamfer: at the modeled 0.500 mm depth it cuts 0.289 mm wide on top, not the modeled 0.500 mm.'
    expect(screen.getByTestId('chamfer-angle-note').textContent).toBe(line)
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false), { timeout: 60_000 })
    fireEvent.click(screen.getByTestId('op-create'))
    await waitFor(() => expect(setup1().operations.length).toBe(before + 1), { timeout: 60_000 })
    const op = setup1().operations.at(-1)!
    expect(op.toolId).toBe(vbit60.id)
    expect((op.params as { chamferWidth: number }).chamferWidth).toBe(0.5)
    cleanup()
    act(() => useCamStore.setState(state => ({ project: { ...state.project, activeSetupId: setup1().id, activeOperationId: op.id } })))
    render(createElement(PropertiesPanel))
    expect(screen.getByTestId('props-chamfer-angle-note').textContent).toBe(line)
  }, 600_000)

  it('Pick on one modeled chamfer fills only that loop', async () => {
    act(() => useCamStore.setState({ project: fullSuite }))
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Chamfer'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('6mm pointed 90deg chamfer mill'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: plate().id } })
    const shaftLoop = (exampleOp('wo2935-plate-chamfer-shaft').params as { loopIds: string[] }).loopIds[0]
    const row = await screen.findByTestId(`chamfer-from-model-row-${shaftLoop}`, {}, { timeout: 60_000 })
    expect(within(row).getByText(/0\.250 mm deep x 0\.250 mm wide, 90°, top edge Z 1\.800 mm/)).toBeTruthy()
    fireEvent.click(screen.getByTestId(`chamfer-from-model-pick-${shaftLoop}`))
    expect(screen.getByTestId('chamfer-from-model-filled').textContent)
      .toBe('From the modeled chamfer: 0.250 mm deep, top edge at Z 1.800 mm on the part, 90°. The values stay editable.')
    expect(screen.queryByTestId('chamfer-from-model-extra')).toBeNull()
  }, 120_000)

  it('Pick modeled chamfer in the 3D view: an edge with a chamfer fills it, an edge without one changes nothing', async () => {
    act(() => useCamStore.setState({ project: fullSuite }))
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Chamfer'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('6mm pointed 90deg chamfer mill'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: plate().id } })
    const button = await screen.findByTestId('chamfer-from-model-pick-view', {}, { timeout: 60_000 })
    expect(button.textContent).toBe('Pick modeled chamfer')
    fireEvent.click(button)
    expect(screen.getByTestId('chamfer-from-model-pick-hint').textContent)
      .toBe('Click an edge of the part in the 3D view: the modeled chamfer along it fills the Chamfer.')
    expect(viewportPick.onLoop, 'the 3D view is in pick mode').not.toBeNull()
    // An edge of the Plate with no modeled chamfer along it: nothing is filled.
    const modeledLoops = new Set((await plateResult()).loops.map(l => l.loopId))
    const plain = plate().loops!.find(l => !modeledLoops.has(l.id))!
    act(() => viewportPick.onLoop!(plain.id, true))
    expect(screen.getByTestId('chamfer-from-model-pick-missed').textContent)
      .toBe('No modeled chamfer runs along that edge; the Chamfer is unchanged.')
    expect(screen.queryByTestId('chamfer-from-model-filled')).toBeNull()
    // The shaft mouth's edge: its modeled chamfer fills the Chamfer and the pick ends.
    const shaftLoop = (exampleOp('wo2935-plate-chamfer-shaft').params as { loopIds: string[] }).loopIds[0]
    act(() => viewportPick.onLoop!(shaftLoop, true))
    expect(screen.getByTestId('chamfer-from-model-filled').textContent)
      .toBe('From the modeled chamfer: 0.250 mm deep, top edge at Z 1.800 mm on the part, 90°. The values stay editable.')
    expect(viewportPick.onLoop, 'the pick ended').toBeNull()
    expect(viewportPick.picked).toEqual([shaftLoop])
    expect(screen.queryByTestId('chamfer-from-model-pick-hint')).toBeNull()
  }, 120_000)

  it('a hand edit of the width, datum or loops retires the modeled-chamfer record', async () => {
    const pass = (await plateResult()).passes.find(p => p.record.topZ === 1.8)!
    const params = chamferParamsFromPass(exampleOp('wo2935-plate-chamfer-shaft').params as never, plate().id, pass, modeledPassDatum(pass, datumContext()))
    const asRecord = (p: object) => modeledChamferRecordOf(p as Record<string, unknown>)
    expect(asRecord(params)?.depthMm).toBe(0.25)
    expect(asRecord({ ...params, tipOffset: 1.4 }), 'a tip offset is not from the model').toBeDefined()
    expect(asRecord({ ...params, chamferWidth: 0.3 })).toBeUndefined()
    expect(asRecord({ ...params, planeOffset: 2 })).toBeUndefined()
    expect(asRecord({ ...params, heightReference: 'absolute' })).toBeUndefined()
    expect(asRecord({ ...params, loopIds: [...params.loopIds, 'another'] })).toBeUndefined()
    // In the dialog: the line goes as soon as the width is typed over, and Create saves no record.
    act(() => useCamStore.setState({ project: fullSuite }))
    const before = setup1().operations.length
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Chamfer'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('6mm pointed 90deg chamfer mill'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: plate().id } })
    const shaftLoop = (exampleOp('wo2935-plate-chamfer-shaft').params as { loopIds: string[] }).loopIds[0]
    fireEvent.click(await screen.findByTestId(`chamfer-from-model-pick-${shaftLoop}`, {}, { timeout: 60_000 }))
    expect(screen.getByTestId('chamfer-from-model-filled')).toBeTruthy()
    fireEvent.click(screen.getByText('Passes'))
    const width = screen.getByText('Chamfer width').closest('.op-field-row')!.querySelector('input')!
    fireEvent.change(width, { target: { value: '0.3' } })
    fireEvent.blur(width)
    fireEvent.click(screen.getByText('Geometry'))
    expect(screen.queryByTestId('chamfer-from-model-filled')).toBeNull()
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false), { timeout: 60_000 })
    fireEvent.click(screen.getByTestId('op-create'))
    await waitFor(() => expect(setup1().operations.length).toBe(before + 1), { timeout: 60_000 })
    const saved = setup1().operations[before].params as Record<string, unknown>
    expect(saved.chamferWidth).toBe(0.3)
    expect(saved.modeledChamfer).toBeUndefined()
  }, 180_000)
})

describe('WO-3021 the angle line', () => {
  it('a 60 deg chamfer (2 across, 3.5 down) with the 90 deg bit says what the bit cuts instead', () => {
    // chamfer_unequal_chain's strips: 2 mm across the top, 3.5 mm down the wall.
    const angleFromAxisDeg = Math.atan(2 / 3.5) * 180 / Math.PI
    expect(chamferAngleNote({ angleFromAxisDeg, depthMm: 3.5, widthMm: 2 }, 45)).toEqual({
      bitIncludedDeg: 90, chamferIncludedDeg: 59.5, depthMm: 3.5, cutWidthMm: 3.5, modeledWidthMm: 2,
    })
    expect(chamferAngleNote({ angleFromAxisDeg: 45, depthMm: 0.5, widthMm: 0.5 }, 45)).toBeNull()
  })
})

describe('WO-3021 a STEP body: chamfer_unequal_chain (2 mm across, 3.5 mm down)', () => {
  it('gives its depth, width and top height the same way, and the 90 deg bit gets the one angle line', async () => {
    const buf = readFileSync(join(process.cwd(), 'src/tests/evidence/WO-2766/chamfer_unequal_chain.step'))
    const stepBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    const { createLocalGeomService } = await import('../../geom')
    const { projectSTLToLoopsInPlane } = await import('../../lib/geometry/stlProjection')
    // The model kernel the dialog asks, in-process here in place of its worker.
    const readStepChamfers = async (bytes: ArrayBuffer) => {
      const kernel = createLocalGeomService()
      await kernel.init()
      const [body] = (await kernel.importStep(bytes, 'CHAMFER')).bodies
      const verdicts = await kernel.recognizeFeatures(body.handle)
      const tess = await kernel.tessellate(body.handle, { deflection: 0.005, angularDeflection: 0.1 })
      await kernel.terminate()
      return { tessellation: { position: tess.position, index: tess.index, triFace: tess.triFace, faceIds: tess.faceIds }, verdicts }
    }
    const { tessellation } = await readStepChamfers(stepBytes)
    // The part's wall outline, sliced 1 mm above its floor - the loop an
    // operator projects to chamfer its top edge.
    let minZ = Infinity; let maxZ = -Infinity
    for (let i = 2; i < tessellation.position.length; i += 3) {
      minZ = Math.min(minZ, tessellation.position[i]); maxZ = Math.max(maxZ, tessellation.position[i])
    }
    const soup = new Float32Array(tessellation.index.length * 3)
    tessellation.index.forEach((v, i) => soup.set(tessellation.position.subarray(v * 3, v * 3 + 3), i * 3))
    const { loops } = projectSTLToLoopsInPlane(soup, {
      planeNormal: { x: 0, y: 0, z: 1 }, planeOrigin: { x: 0, y: 0, z: minZ + 1 },
      simplificationTolerance: 0.001, minPerimeter: 1,
    })
    const outline = loops.filter(l => l.closed).sort((a, b) => b.area - a.area)[0]
    expect(outline, 'the wall outline').toBeDefined()
    const geo = {
      id: 'step-unequal', type: 'brep', format: 'step', loops: [outline],
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    } as unknown as ImportedGeometry
    const result = await modeledChamfersOnPart(geo, {
      loadStl: async () => null, loadStep: async () => stepBytes, readStepChamfers, placements: [], frames,
    })
    expect(result?.source).toBe('step')
    expect(result!.passes).toHaveLength(1)
    const [pass] = result!.passes
    expect(pass.loopIds).toEqual([outline.id])
    expect(pass.loopSides).toEqual({ [outline.id]: 'outer' })
    expect(pass.chamferWidth).toBeCloseTo(3.5, 3)
    expect(pass.record.widthMm).toBeCloseTo(2, 2)
    expect(pass.record.angleFromAxisDeg).toBeCloseTo(Math.atan(2 / 3.5) * 180 / Math.PI, 1)
    expect(pass.record.topZ).toBeCloseTo(maxZ, 3)
    const note = chamferAngleNote(pass.record, 45)
    expect(note).toMatchObject({ bitIncludedDeg: 90, chamferIncludedDeg: 59.5 })
    expect(note!.cutWidthMm).toBeCloseTo(3.5, 3)
    expect(note!.modeledWidthMm).toBeCloseTo(2, 2)
  }, 600_000)
})

describe('WO-3021 the lib/cam boundary', () => {
  it('chamferFromModel imports nothing from the store but types (the store hands in its frame resolvers)', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/cam/chamferFromModel.ts'), 'utf8')
    const storeImports = [...source.matchAll(/^import\s+(type\s+)?[^\n]*?from\s+'([^']+)'/gm)]
      .filter(m => /(^|\/)store(\/|$)/.test(m[2]))
    expect(storeImports.length, 'the resolvers come from the store, as types').toBeGreaterThan(0)
    expect(storeImports.filter(m => !m[1]).map(m => m[0])).toEqual([])
  })
})

// ---------------------------------------------------------------- fix round 2

/** A 10 x 10 x 4 block with modeled 45 deg bevels on chosen top edges (0 = a
 *  sharp edge): `south` along y = 0, `north` along y = 10, both running the
 *  block's full length in X. A closed, outward-wound triangle mesh - what a
 *  modeled body's tessellation or an STL gives the recogniser. */
function bevelledBlock(opts: { south?: number; north?: number } = {}) {
  const [length, width, height] = [10, 10, 4]
  const s = opts.south ?? 0
  const n = opts.north ?? 0
  const profile: Array<[number, number]> = [[0, 0], [width, 0]]
  if (n > 0) profile.push([width, height - n], [width - n, height])
  else profile.push([width, height])
  if (s > 0) profile.push([s, height], [0, height - s])
  else profile.push([0, height])
  const positions: number[] = []
  const indices: number[] = []
  const centre = [length / 2, width / 2, height / 2]
  const tri = (a: number[], b: number[], c: number[]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const m = [0, 1, 2].map(k => (a[k] + b[k] + c[k]) / 3 - centre[k])
    const out = nrm[0] * m[0] + nrm[1] * m[1] + nrm[2] * m[2] > 0
    const base = positions.length / 3
    positions.push(...a, ...(out ? b : c), ...(out ? c : b))
    indices.push(base, base + 1, base + 2)
  }
  const at = (x: number, [y, z]: [number, number]) => [x, y, z]
  for (let i = 1; i + 1 < profile.length; i++) {
    tri(at(0, profile[0]), at(0, profile[i]), at(0, profile[i + 1]))
    tri(at(length, profile[0]), at(length, profile[i]), at(length, profile[i + 1]))
  }
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i]; const b = profile[(i + 1) % profile.length]
    tri(at(0, a), at(0, b), at(length, b))
    tri(at(0, a), at(length, b), at(length, a))
  }
  return { positions, indices }
}

const square = { id: 'square', closed: true, type: 'contour' as const, layerId: 'outline', area: 100,
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }

/** chamfer2d's own payload for one Chamfer pass over the square, 90 deg bit. */
function squarePayload(params: Record<string, unknown>, linking: Record<string, unknown> = {}) {
  return {
    opId: 'chamfer', setupId: 'setup',
    params: { direction: 'climb', tipOffset: 0, overlapMm: 0.5, heightReference: 'absolute', planeOffset: 4, ...params },
    heights: { clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 6, feedHeight: 5, topHeight: 4,
      topHeightMode: 'absolute', bottomHeight: 0, bottomHeightMode: 'absolute' },
    passes: { stepdown: 1, stepover: 1, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: { entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height', ...linking },
    tool: { id: 't', name: '90 deg chamfer', type: 'chamfer_mill', diameter: 6, fluteLength: 6, shankDiameter: 6,
      overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '', angleFromAxisDeg: 45,
      feedsAndSpeeds: { default: { rpm: 10_000, feedRate: 700, plungeRate: 200, depthOfCut: 1, stepover: 1 } } },
    loops: [square], wcsOrigin: { x: 0, y: 0, z: 0 },
  } as unknown as import('../../lib/cam/types').ChamferWorkerPayload
}

/** The XY span the feed moves (entry and cut) cover. */
function cutSpan(moves: ReadonlyArray<{ x: number; y: number; z: number; type: string; role?: string }>) {
  const cuts = moves.filter(m => m.type === 'feed')
  const xs = cuts.map(m => m.x); const ys = cuts.map(m => m.y)
  return { cuts: cuts.length, xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) }
}

describe('WO-3021 fix 2: a chamfer modeled along part of a loop machines only that part (audit finding 1)', () => {
  it('ONE bevelled 10 mm south edge on a 10 x 10 block: the row is that edge, and chamfer2d cuts only it', async () => {
    const { matchModeledChamfersToLoops, chamferPassesFromModel, chamferParamsFromPass, modeledChamfersOnMesh } =
      await import('../../lib/cam/chamferFromModel')
    const { buildChamferToolpath } = await import('../../lib/cam/chamfer2d')
    const block = bevelledBlock({ south: 0.5 })
    const scan = modeledChamfersOnMesh({ positions: Float32Array.from(block.positions), indices: Uint32Array.from(block.indices) })
    expect(scan.chamfers.map(c => [c.depthMm, c.topZ])).toEqual([[0.5, 4]])
    const pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }
    const rows = matchModeledChamfersToLoops(scan.chamfers, [square], pose, transformLoopPoints)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ loopId: 'square', side: 'outer', depthMm: 0.5, extent: [[0, 10]], coveredMm: 10, loopLengthMm: 40 })
    const [pass] = chamferPassesFromModel(rows, 'block', 'mesh')
    const base = { geometryId: 'block', loopIds: [], loopSides: {}, direction: 'climb', chamferWidth: 1, tipOffset: 0,
      overlapMm: 0.5, heightReference: 'absolute', planeOffset: 0 } as unknown as import('../../lib/cam/types').ChamferParams
    const params = chamferParamsFromPass(base, 'block', pass, { heightReference: 'absolute', planeOffset: 4 })
    expect(params.loopExtents).toEqual({ square: [[0, 10]] })
    expect(modeledChamferRecordOf(params as unknown as Record<string, unknown>)?.filled?.loopExtents).toEqual({ square: [[0, 10]] })
    // The cut runs the south edge only, at the modeled depth, for plunge and ramp entry.
    for (const entryType of ['plunge', 'ramp_linear']) {
      const moves = buildChamferToolpath(squarePayload(params as unknown as Record<string, unknown>, { entryType }))
      expect(cutSpan(moves), entryType).toEqual({ cuts: expect.any(Number), xMin: 0, xMax: 10, yMin: 0, yMax: 0 })
      expect(moves.filter(m => m.type === 'feed').every(m => Math.abs(m.y) < 1e-9), entryType).toBe(true)
      expect(Math.min(...moves.map(m => m.z)), entryType).toBeCloseTo(3.5, 9)
    }
    // A tip offset moves the open stretch outward, off the part, by offset x tan(45).
    const offset = buildChamferToolpath(squarePayload({ ...params, tipOffset: 1 } as unknown as Record<string, unknown>))
    const shifted = cutSpan(offset)
    expect(shifted.yMin).toBeCloseTo(-1, 9)
    expect(shifted.yMax).toBeCloseTo(-1, 9)
    expect([shifted.xMin, shifted.xMax]).toEqual([0, 10])
    // The same op without the stretch (every older op) still cuts the whole square.
    const { loopExtents: _stretch, ...whole } = params
    expect(cutSpan(buildChamferToolpath(squarePayload(whole as unknown as Record<string, unknown>))))
      .toMatchObject({ xMin: 0, xMax: 10, yMin: 0, yMax: 10 })
  })

  it('two bevels of different sizes on one loop: each is its own row and pass with its own stretch', async () => {
    const { matchModeledChamfersToLoops, chamferPassesFromModel, modeledChamfersOnMesh } = await import('../../lib/cam/chamferFromModel')
    const block = bevelledBlock({ south: 0.5, north: 0.25 })
    const scan = modeledChamfersOnMesh({ positions: Float32Array.from(block.positions), indices: Uint32Array.from(block.indices) })
    const pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }
    const rows = matchModeledChamfersToLoops(scan.chamfers, [square], pose, transformLoopPoints)
    expect(rows.map(r => ({ rowId: r.rowId, depth: r.depthMm, extent: r.extent }))).toEqual([
      { rowId: 'square', depth: 0.5, extent: [[0, 10]] },
      { rowId: 'square#2', depth: 0.25, extent: [[20, 30]] },
    ])
    const passes = chamferPassesFromModel(rows, 'block', 'mesh')
    expect(passes.map(p => [p.chamferWidth, p.loopExtents])).toEqual([
      [0.5, { square: [[0, 10]] }],
      [0.25, { square: [[20, 30]] }],
    ])
  })
})

describe('WO-3021 fix 3: Pick of one modeled bevel never takes a separate bevel of the same size (audit 59e51998)', () => {
  it('equal 0.5 mm south and north bevels: each is its own row; Pick cuts its own edge, All one pass over both', async () => {
    const { matchModeledChamfersToLoops, chamferPassesFromModel, chamferParamsFromPass, modeledChamfersOnMesh } =
      await import('../../lib/cam/chamferFromModel')
    const { buildChamferToolpath } = await import('../../lib/cam/chamfer2d')
    const block = bevelledBlock({ south: 0.5, north: 0.5 })
    const scan = modeledChamfersOnMesh({ positions: Float32Array.from(block.positions), indices: Uint32Array.from(block.indices) })
    expect(scan.chamfers).toHaveLength(2)
    const pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }
    const rows = matchModeledChamfersToLoops(scan.chamfers, [square], pose, transformLoopPoints)
    expect(rows.map(r => ({ rowId: r.rowId, features: r.featureIds.length, extent: r.extent, covered: r.coveredMm }))).toEqual([
      { rowId: 'square', features: 1, extent: [[0, 10]], covered: 10 },
      { rowId: 'square#2', features: 1, extent: [[20, 30]], covered: 10 },
    ])
    // Pick on the south bevel, the way the dialog picks by the chamfer's id: its own stretch only.
    const south = rows[0].featureIds[0]
    const picked = chamferPassesFromModel(rows.filter(r => r.featureIds.includes(south)), 'block', 'mesh')
    expect(picked.map(p => [p.loopIds, p.loopExtents, p.record.featureIds])).toEqual([[['square'], { square: [[0, 10]] }, [south]]])
    const base = { geometryId: 'block', loopIds: [], loopSides: {}, direction: 'climb', chamferWidth: 1, tipOffset: 0,
      overlapMm: 0.5, heightReference: 'absolute', planeOffset: 0 } as unknown as import('../../lib/cam/types').ChamferParams
    const params = chamferParamsFromPass(base, 'block', picked[0], { heightReference: 'absolute', planeOffset: 4 })
    expect(cutSpan(buildChamferToolpath(squarePayload(params as unknown as Record<string, unknown>))))
      .toEqual({ cuts: expect.any(Number), xMin: 0, xMax: 10, yMin: 0, yMax: 0 })
    // All: the two equal bevels share one pass that cuts both stretches, and nothing between them.
    const all = chamferPassesFromModel(rows, 'block', 'mesh')
    expect(all.map(p => [p.loopIds, p.loopExtents, p.record.featureIds.length])).toEqual([[['square'], { square: [[0, 10], [20, 30]] }, 2]])
    const both = buildChamferToolpath(squarePayload(chamferParamsFromPass(base, 'block', all[0],
      { heightReference: 'absolute', planeOffset: 4 }) as unknown as Record<string, unknown>))
    const cuts = both.filter(m => m.type === 'feed')
    expect(cuts.every(m => Math.abs(m.y) < 1e-9 || Math.abs(m.y - 10) < 1e-9)).toBe(true)
    expect(new Set(cuts.map(m => Math.round(m.y)))).toEqual(new Set([0, 10]))
  })

  it('a loop whose same-size stretches meet all the way round is one whole-loop pass under All', async () => {
    const { chamferPassesFromModel } = await import('../../lib/cam/chamferFromModel')
    const row = (rowId: string, featureId: string, extent: Array<[number, number]>) => ({ rowId, loopId: 'square', side: 'outer' as const,
      featureIds: [featureId], topZ: 4, depthMm: 0.5, widthMm: 0.5, angleFromAxisDeg: 45, extent, coveredMm: 20, loopLengthMm: 40 })
    const [pass] = chamferPassesFromModel([row('square', 'a', [[0, 20]]), row('square#2', 'b', [[20, 40]])], 'block', 'mesh')
    expect([pass.loopIds, pass.loopExtents]).toEqual([['square'], {}])
  })
})

describe('WO-3021 fix 2: a freshly modeled body (no loops yet) fills from its modeled chamfer (audit finding 2)', () => {
  it('Pick derives the loop with Section at Z under the bevel, fills the stretch, and the op cuts only the bevelled edge', async () => {
    const { buildModelBodyGeometry } = await import('../../lib/cam/modelBodyAdapter')
    const block = bevelledBlock({ south: 0.5 })
    const display = {
      positions: block.positions, normals: block.positions.map(() => 0), indices: block.indices,
      edgePositions: [], edgeOffsets: [0], bbox: { min: [0, 0, 0], max: [10, 10, 4] },
    } as unknown as import('../../types').ModelBodyDisplay
    // The model kernel's own producer for a fresh body: no loops of its own.
    const body = buildModelBodyGeometry({ bodyId: 'fresh-block', name: 'Fresh block' },
      { bodyId: 'fresh-block', version: 1, stableIds: [], display })
    expect(body.loops).toBeUndefined()
    // A new part in a setup with no operations yet, as a freshly modeled one is.
    act(() => useCamStore.setState({ project: { ...fullSuite, geometry: [...fullSuite.geometry, body],
      setups: fullSuite.setups.map((setup, i) => i === 0 ? { ...setup, operations: [] } : setup) } }))
    const before = setup1().operations.length
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Chamfer'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('6mm pointed 90deg chamfer mill'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: body.id } })
    const all = await screen.findByTestId('chamfer-from-model-all', {}, { timeout: 60_000 })
    expect(all.textContent).toBe('All modeled chamfers on this part (1)')
    expect(screen.getByTestId('chamfer-from-model-pending-hint').textContent)
      .toBe('1 modeled chamfer(s) have no loop on this part yet. Pick or All first derives one with Section at Z just under the chamfer.')
    const [pick] = screen.getAllByTestId(/^chamfer-from-model-pick-pending-/)
    fireEvent.click(pick)
    await waitFor(() => expect(screen.getByTestId('chamfer-from-model-filled').textContent)
      .toBe('From the modeled chamfer: 0.500 mm deep, top edge at Z 4.000 mm on the part, 90°. The values stay editable.'), { timeout: 60_000 })
    expect(screen.getByTestId('chamfer-from-model-stretch').textContent)
      .toBe("Only the modeled stretch is cut: 10.000 mm along 1 loop(s). The loop's other edges are left as they are.")
    // The section landed on the body as a derived layer, the way Section at Z lands one.
    const landed = useCamStore.getState().project.geometry.find(g => g.id === body.id)!
    expect(landed.loops?.length).toBe(1)
    expect(landed.layers2d?.some(l => l.derived && l.projectionPlane?.origin.z === 3.45)).toBe(true)
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false), { timeout: 60_000 })
    fireEvent.click(screen.getByTestId('op-create'))
    await waitFor(() => expect(setup1().operations.length).toBe(before + 1), { timeout: 60_000 })
    const op = setup1().operations[before]
    expect((op.params as { loopExtents?: unknown }).loopExtents).toEqual({ [landed.loops![0].id]: [[expect.any(Number), expect.any(Number)]] })
    await waitFor(() => expect(setup1().operations[before].status).not.toMatch(/computing|pending/), { timeout: 300_000 })
    const done = setup1().operations[before]
    expect([done.status, done.errorMessage]).toEqual(['ready', undefined])
    // The bevelled south edge, 10 mm, one straight run: no other edge of the block is cut.
    const span = cutSpan(done.toolpathMoves ?? [])
    expect(span.cuts).toBeGreaterThan(0)
    expect(span.xMax - span.xMin).toBeCloseTo(10, 6)
    expect(span.yMax - span.yMin).toBeCloseTo(0, 6)
  }, 600_000)

  it('fix 3: two equal bevels on a fresh body; Pick on one row fills and cuts only that bevel\'s 10 mm edge', async () => {
    const { buildModelBodyGeometry } = await import('../../lib/cam/modelBodyAdapter')
    const block = bevelledBlock({ south: 0.5, north: 0.5 })
    const display = {
      positions: block.positions, normals: block.positions.map(() => 0), indices: block.indices,
      edgePositions: [], edgeOffsets: [0], bbox: { min: [0, 0, 0], max: [10, 10, 4] },
    } as unknown as import('../../types').ModelBodyDisplay
    const body = buildModelBodyGeometry({ bodyId: 'twin-block', name: 'Twin block' },
      { bodyId: 'twin-block', version: 1, stableIds: [], display })
    act(() => useCamStore.setState({ project: { ...fullSuite, geometry: [...fullSuite.geometry, body],
      setups: fullSuite.setups.map((setup, i) => i === 0 ? { ...setup, operations: [] } : setup) } }))
    const before = setup1().operations.length
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Chamfer'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('6mm pointed 90deg chamfer mill'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: body.id } })
    const all = await screen.findByTestId('chamfer-from-model-all', {}, { timeout: 60_000 })
    expect(all.textContent).toBe('All modeled chamfers on this part (2)')
    const picks = screen.getAllByTestId(/^chamfer-from-model-pick-pending-/)
    expect(picks).toHaveLength(2)
    fireEvent.click(picks[0])
    await waitFor(() => expect(screen.getByTestId('chamfer-from-model-stretch').textContent)
      .toBe("Only the modeled stretch is cut: 10.000 mm along 1 loop(s). The loop's other edges are left as they are."), { timeout: 60_000 })
    // The 3D view's pick names the loop, not an edge: on this loop with two separate bevels it fills
    // nothing (never both) and says to use a row's own Pick.
    fireEvent.click(screen.getByTestId('chamfer-from-model-pick-view'))
    const loopId = useCamStore.getState().project.geometry.find(g => g.id === body.id)!.loops![0].id
    act(() => viewportPick.onLoop!(loopId, true))
    expect(screen.getByTestId('chamfer-from-model-pick-several').textContent)
      .toBe('That edge loop carries 2 separate modeled chamfers; the Chamfer is unchanged. Use Pick on one of their rows.')
    expect(screen.getByTestId('chamfer-from-model-stretch').textContent)
      .toBe("Only the modeled stretch is cut: 10.000 mm along 1 loop(s). The loop's other edges are left as they are.")
    fireEvent.click(screen.getByTestId('chamfer-from-model-pick-view'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false), { timeout: 60_000 })
    fireEvent.click(screen.getByTestId('op-create'))
    await waitFor(() => expect(setup1().operations.length).toBe(before + 1), { timeout: 60_000 })
    const extents = Object.values((setup1().operations[before].params as { loopExtents?: Record<string, Array<[number, number]>> }).loopExtents ?? {})
    expect(extents).toHaveLength(1)
    expect(extents[0]).toHaveLength(1)
    expect(extents[0][0][1] - extents[0][0][0]).toBeCloseTo(10, 6)
    await waitFor(() => expect(setup1().operations[before].status).not.toMatch(/computing|pending/), { timeout: 300_000 })
    const done = setup1().operations[before]
    expect([done.status, done.errorMessage]).toEqual(['ready', undefined])
    // One straight 10 mm edge: the other bevelled edge, 10 mm away, is not cut.
    const span = cutSpan(done.toolpathMoves ?? [])
    expect(span.xMax - span.xMin).toBeCloseTo(10, 6)
    expect(span.yMax - span.yMin).toBeCloseTo(0, 6)
  }, 600_000)
})
