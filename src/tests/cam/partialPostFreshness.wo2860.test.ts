// @vitest-environment jsdom
//
// WO-2860: a partial post leaves every operation as it was.
//
// Sweep 1 F7 (10-15): Setup 1 = Face 1, Adaptive 2, Contour 3, Drill 4. Post
// Process with Contour 3 unticked -> Export: the console said "Recomputed
// Drill 4: Contour 3 is not part of this program", and afterwards the tree
// showed Drill 4 "Outdated" and the setup time dropped 18m55s -> 16m04s.
// Sweep 3 H4 (10-16): after that Export the dialog's Output Scope reset - the
// unticked operation came back ticked within a second.
//
// Both through the real route: the real PostProcessModal, the real Export
// click, the real store compute and the real toolpathWorker.ts in-process. A
// real Face, a real Contour and a real Drill that reads what they left
// (dependsOnPredecessors, WO-1582/1653).
//
// Sweep 2 G13 (10-16): after New the status strip still showed the previous
// project's last console line. New starts an empty console.

import React from 'react'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import { makeMachine } from '../post/helpers'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { GeomClient } from '../../geom'
import type { BodyHandle } from '../../geom/geom-service'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, ModelBodyDisplay, Operation, PassParams,
  PhysicalStock, Project, SceneStock, Setup, Tool, Vec3, WCS,
} from '../../types'

// The STEP bytes stay in the (mocked) IndexedDB cache, as they do in the app.
const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))

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

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { BottomConsole } = await import('../../components/panels/BottomConsole')
const { useCamStore } = await import('../../store')
const { operationGenerationIsCurrent } = await import('../../lib/cam/generationFingerprint')
const { setupEnabledCutTimeMs } = await import('../../lib/cam/operationSuppression')
const { createLocalGeomService } = await import('../../geom')
const { resetDocumentHolder, stashLoadedDocument, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { finalizeSeedArchive, newSeededModelDag } = await import('../../doc/seedModelArchive')
const { __setModelBodyHeadlessClientFactoryForTests } = await import('../../lib/cam/modelBodyHoleRecognition')
const { edgeId } = await import('../../geom/worker/stable-id')

// fix_single_hole_block.step: a 40 x 20 x 20 block, one blind hole d6 x 8 at
// (20, 10) from the top face at Z 20 - "Part 1, imported STEP", with the
// Fillet r1.5 the operator's Part 1 carries (WO-2857 F2).
const STEP_FIXTURE = resolve(process.cwd(), 'test_fixtures/brep/fix_single_hole_block.step')
const CACHE_KEY = 'wo2860-part1'
const IMPORT = 'IMP1'
const SETUP_ID = 'setup-1'
const STOCK_ID = 'stock-wo2860'
const PLATE_TOP = 20
const HOLE_CLASSES = ['throughHole', 'blindHole', 'counterboreStack']

function fixtureBytes(): ArrayBuffer {
  const source = readFileSync(STEP_FIXTURE)
  return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}
const rect = (x0: number, y0: number, x1: number, y1: number) =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]

const HOLDER = { id: 'holder-1', name: 'ER20', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] }
function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'tool', name: 'tool', type: 'flat_end_mill', toolNumber: 1, cutHand: 'right',
    diameter: 6, fluteLength: 25, shankDiameter: 6, overallLength: 70, lengthBelowHolder: 40,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', holderId: HOLDER.id, notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool
}
const FACE_MILL = tool({ id: 'face-mill', name: '10 mm end mill', toolNumber: 1, diameter: 10, shankDiameter: 10 })
const END_MILL = tool({ id: 'end-mill', name: '6 mm end mill', toolNumber: 2 })
const DRILL = tool({
  id: 'drill-6', name: 'Drill 6', type: 'drill', toolNumber: 4, diameter: 6, shankDiameter: 6,
  feedsAndSpeeds: { default: { rpm: 3000, feedRate: 200, plungeRate: 100, depthOfCut: 2, stepover: 1 } },
})

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const HEIGHTS: HeightParams = {
  clearanceHeight: 35, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
  topHeight: PLATE_TOP, topHeightMode: 'absolute', bottomHeight: 12, bottomHeightMode: 'absolute',
}

function faceOp(): Operation {
  const params = {
    boundarySource: 'geometry', geometryId: 'face-sketch', loopIds: [],
    stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
    pattern: 'zigzag', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
    passExtension: 2, chipThinning: false, bothSidesPerLevel: false,
    floorStockToLeave: 0, finishPass: false, entryType: 'plunge', leadInRadius: 0,
    leadOutRadius: 0, keepToolDown: false, maxStayDownDistance: 0,
    extendBeforeRetract: false, transition: 'direct', tolerance: 0.05,
  }
  const passes: PassParams = { stepdown: 1, stepover: 5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: 'op-face', name: 'Face 1', type: 'face', enabled: true, status: 'pending',
    toolId: FACE_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('face', {
      setupId: SETUP_ID, heights: HEIGHTS, params, stockId: STOCK_ID, explicitDepthMm: 1,
    }),
  } as unknown as Operation
}

function contourOp(): Operation {
  const params = {
    geometryId: 'part-sketch', loopIds: ['outer'], side: 'outer', direction: 'climb',
    contourFinishMode: 'final', tabs: false,
  }
  const passes: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0.5, finishPasses: 1, springPasses: 0 }
  return {
    id: 'op-contour', name: 'Contour 3', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: END_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds: ['part-sketch'],
    }),
  } as unknown as Operation
}

/** Drill 4 drills the recognized hole of the imported part, bound by face ids
 *  as the New Operation dialog binds them (deriveModelBodyDrillTargets). */
function drillOp(geometryId: string, bodyId: string, stableIds: string[]): Operation {
  const params = {
    geometryId, loopIds: [], cycleType: 'simple', peckDepth: 2,
    chipBreakRetract: 1, dwell: 0, retractMode: 'retract', sortStrategy: 'none',
  }
  const passes: PassParams = { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: 'op-drill', name: 'Drill 4', type: 'drill', enabled: true, status: 'pending',
    toolId: DRILL.id, geometrySelections: [],
    modelReferences: [{ bodyId, stableIds, role: 'drill-targets' }],
    heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('drill', {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds: [geometryId],
    }),
  } as unknown as Operation
}

function display(): ModelBodyDisplay {
  return {
    positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
    bbox: { min: [0, 0, 0], max: [40, 20, 20] },
  }
}

/** Part 1 (imported STEP + Fillet F1) live in the Model workspace, and Setup 1. */
async function install(client: GeomClient): Promise<void> {
  const imported = await client.importStep(fixtureBytes(), IMPORT)
  expect(imported.bodies).toHaveLength(1)
  const part: BodyHandle = imported.bodies[0].handle
  const edges = [edgeId(['IMP1:step:face#2', 'IMP1:step:face#0'], '0')]
  const fillet = await client.applyFillet({ featureId: 'F1', body: part, edges, radius: 1.5, propagateTangent: true })
  expect(fillet.ok, JSON.stringify(fillet.diagnostics)).toBe(true)
  const liveHandle = fillet.body!
  ;(window as unknown as Record<string, unknown>).__solidsWorkbenchHooks = {
    getBodyHandle: (id: string) => (id === 'F1' ? liveHandle : undefined),
    client,
  }
  const dag = newSeededModelDag()
  dag.insertNode({
    id: IMPORT, kind: 'import', consumes: [], refs: [],
    payload: { fileName: 'Part 1.step', cacheKey: CACHE_KEY, name: 'Part 1' },
  })
  dag.insertNode({
    id: 'F1', kind: 'feature', consumes: [IMPORT], refs: [],
    payload: { opType: 'fillet', ownerId: IMPORT, edges, radius: 1.5, name: 'Fillet F1' },
  })
  stashLoadedDocument(finalizeSeedArchive(dag))
  const holeFaces = (await client.recognizeFeatures(liveHandle))
    .filter((v) => HOLE_CLASSES.includes(v.featureClass)).flatMap((v) => v.faceIds ?? [])
  expect(holeFaces.length, 'Part 1 has its hole').toBeGreaterThan(0)

  useCamStore.getState().syncModelBodies({
    live: [{ bodyId: 'F1', name: 'Part 1' }],
    derived: [{ bodyId: 'F1', version: 1, stableIds: [], display: display() }],
  })
  const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')
  expect(modelGeo, 'syncModelBodies published the modeled body row').toBeDefined()

  const sketch = (id: string, name: string, loops: unknown[]) => ({
    id, name, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: PLATE_TOP }, { x: 40, y: 20, z: PLATE_TOP }),
    position: { x: 0, y: 0, z: PLATE_TOP }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: STOCK_ID, stockIdLocked: true, loops,
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  }) as unknown as ImportedGeometry
  const faceSketch = sketch('face-sketch', 'Face boundary', [
    { id: 'face-loop', closed: true, type: 'contour', layerId: 'L1', area: 40 * 20, points: rect(0, 0, 40, 20) },
  ])
  const partSketch = sketch('part-sketch', 'Outline', [
    { id: 'outer', closed: true, type: 'contour', layerId: 'L1', area: 32 * 14, points: rect(4, 3, 36, 17) },
  ])
  const stock = {
    id: STOCK_ID, name: 'Stock 1', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 20, z: PLATE_TOP }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
  const sceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 40, fixedHeight: 20, fixedDepth: PLATE_TOP,
    fixedStocks: [],
  } as unknown as SceneStock
  const setup = {
    id: SETUP_ID, name: 'Setup 1', notes: '',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    } as WCS,
    stock: {
      type: 'rectangular', width: 40, height: 20, depth: PLATE_TOP,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [faceOp(), contourOp(), drillOp(modelGeo!.id, 'F1', [...new Set(holeFaces)])],
  } as unknown as Setup
  useCamStore.setState((s) => ({
    project: {
      ...s.project, name: 'WO2860', machine: makeMachine(), geometry: [...s.project.geometry, faceSketch, partSketch],
      stocks: [stock], setups: [setup], sceneStock, activeSetupId: SETUP_ID, activeOperationId: null,
    } as unknown as Project,
    toolLibrary: [FACE_MILL, END_MILL, DRILL],
    holders: [HOLDER],
    toolpathBatch: null,
    modelRefsVerifiedSinceLoad: true,
    consoleEvents: [], consoleReadThroughId: 0,
  }) as never)
  useCamStore.getState().setStockMembership(modelGeo!.id, STOCK_ID)
}

// ── The worker wire: real toolpathWorker.ts, in-process, one request at a time ──

let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerQueue: Promise<void> = Promise.resolve()
const dispatched: string[] = []
let realSelf: unknown
let liveClient: GeomClient | null = null

beforeAll(async () => {
  realSelf = (globalThis as { self?: unknown }).self
  Object.defineProperty(globalThis, 'self', {
    value: {
      postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
      onmessage: null,
      location: window.location,
    },
    configurable: true, writable: true,
  })
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  Object.defineProperty(globalThis, 'self', { value: realSelf, configurable: true, writable: true })
})

beforeEach(async () => {
  mem.clear()
  stepBytes.clear()
  stepBytes.set(CACHE_KEY, fixtureBytes())
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.getState().newProject()
  })
  __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
  workerQueue = Promise.resolve()
  activeShim = null
  dispatched.length = 0
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      dispatched.push((data as { payload: { opId: string } }).payload.opId)
      workerQueue = workerQueue.then(async () => {
        activeShim = this
        await workerSelf.onmessage!({ data })
      })
    }
    terminate(): void { /* no thread */ }
  })
  class MockURL extends URL {
    static createObjectURL = vi.fn(() => 'blob:mock')
    static revokeObjectURL = vi.fn()
  }
  vi.stubGlobal('URL', MockURL)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: PLATE_TOP } }),
  }
  liveClient = createLocalGeomService()
  await liveClient.init()
})

afterEach(async () => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
  delete (window as unknown as Record<string, unknown>).__solidsWorkbenchHooks
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
  stepBytes.clear()
  if (liveClient !== null) await liveClient.terminate().catch(() => undefined)
  liveClient = null
})

const opById = (id: string) => useCamStore.getState().project.setups[0].operations.find((op) => op.id === id)!
const consoleText = () => useCamStore.getState().consoleEvents.map((e) => e.message).join('\n')
const setupTimeMs = () => setupEnabledCutTimeMs(useCamStore.getState().project.setups[0].operations)
const isCurrent = (id: string) => {
  const s = useCamStore.getState()
  const setup = s.project.setups[0]
  return operationGenerationIsCurrent({ ...s.project, toolLibrary: s.toolLibrary }, setup, setup.operations.find((op) => op.id === id)!)
}

/** Every compute settled: nothing reads Computing and the worker queue is drained. */
async function settle(): Promise<void> {
  for (let quiet = 0; quiet < 5;) {
    const queue = workerQueue
    await act(async () => {
      await queue
      await new Promise((r) => setTimeout(r, 20))
    })
    const computing = useCamStore.getState().project.setups[0].operations.some((op) => op.status === 'computing')
    quiet = computing || queue !== workerQueue ? 0 : quiet + 1
  }
}

/** The sweep's clicks: generate Face 1, Contour 3, Drill 4 in order, open Post
 *  Process, untick Contour 3, Export, and wait for every compute to settle. */
async function exportWithContour3Unticked() {
  await install(liveClient!)
  for (const id of ['op-face', 'op-contour', 'op-drill']) {
    await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, id) })
    expect(opById(id).status, `${id}: ${opById(id).errorMessage}`).toBe('ready')
  }
  expect((opById('op-drill') as { dependsOnPredecessors?: boolean }).dependsOnPredecessors,
    'Drill 4 reads what Face 1 and Contour 3 left').toBe(true)
  const before = opById('op-drill')
  const timeBefore = setupTimeMs()
  expect(timeBefore).toBeGreaterThan(0)
  expect(isCurrent('op-drill')).toBe(true)
  // Evidence: WO2860_PROJECT_OUT=<dir> keeps this project, saved by the
  // production save path, for the real-app capture (src/tests/evidence/WO-2860/shoot.mjs).
  const projectOut = process.env.WO2860_PROJECT_OUT
  if (projectOut) {
    vi.stubGlobal('liencamHost', {
      saveFile: async (_filename: string, data: string | Uint8Array) => {
        writeFileSync(resolve(projectOut, 'partial-post.camproject'), typeof data === 'string' ? data : new TextDecoder().decode(data))
        return 'C:\\Temp\\WO-2860.camproject'
      },
    })
    await act(async () => { await useCamStore.getState().saveProjectToFile() })
    vi.stubGlobal('liencamHost', undefined)
  }

  render(React.createElement(PostProcessModal))
  act(() => { useCamStore.getState().openModal('post-process') })

  const contourBox = await screen.findByRole('checkbox', { name: 'Contour 3' }) as HTMLInputElement
  expect(contourBox.checked).toBe(true)
  act(() => { fireEvent.click(contourBox) })
  expect((screen.getByRole('checkbox', { name: 'Contour 3' }) as HTMLInputElement).checked).toBe(false)
  const exportBtn = screen.getByRole('button', { name: /Export \.nc/i })
  await waitFor(() => expect(exportBtn.hasAttribute('disabled')).toBe(false))
  const previewBefore = screen.getAllByTestId('post-gcode-preview')[0].textContent ?? ''
  expect(previewBefore).toMatch(/T4\b/)
  expect(previewBefore).not.toMatch(/T2\b/)

  // A real click, outside act(): the store's staging and React's renders
  // interleave as they do in the browser.
  dispatched.length = 0
  fireEvent.click(exportBtn)
  await waitFor(() => expect(consoleText()).toMatch(/Posted /), { timeout: 30_000 })
  await settle()
  // The program without Contour 3 is computed for the material actually there (WO-1653).
  expect(consoleText()).toMatch(/Recomputed "?Drill 4"?: "Contour 3" is not part of this program/)
  return { before, timeBefore, previewBefore }
}

describe('WO-2860: a partial post leaves every operation as it was', () => {
  it('F7: after Export with Contour 3 unticked, Drill 4 stays ready and current and the setup time holds', async () => {
    const { before, timeBefore } = await exportWithContour3Unticked()

    const after = opById('op-drill')
    expect(after.status, `Drill 4 after the partial post: ${after.errorMessage ?? ''}`).toBe('ready')
    expect(after.toolpathMoves).toEqual(before.toolpathMoves)
    expect(after.generationFingerprint).toBe(before.generationFingerprint)
    expect(isCurrent('op-drill'), 'Drill 4 generation is current').toBe(true)
    for (const id of ['op-face', 'op-contour']) {
      expect(opById(id).status).toBe('ready')
      expect(opById(id).enabled).toBe(true)
    }
    expect(setupTimeMs(), 'setup time after the partial post').toBe(timeBefore)
    // Only the staging recompute ran: the dialog did not compute the staged program again.
    expect(dispatched, 'computes dispatched by the Export').toEqual(['op-drill'])
  }, 120_000)

  it('H4: after Export the Output Scope stays exactly as the operator left it, and the preview stays', async () => {
    const { previewBefore } = await exportWithContour3Unticked()

    await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
    expect((screen.getByRole('checkbox', { name: 'Contour 3' }) as HTMLInputElement).checked,
      'Contour 3 stays unticked after Export').toBe(false)
    expect((screen.getByRole('checkbox', { name: 'Face 1' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Drill 4' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getAllByTestId('post-gcode-preview')[0].textContent).toBe(previewBefore)
    expect(screen.getByRole('button', { name: /Export \.nc/i }).hasAttribute('disabled')).toBe(false)
  }, 120_000)
})

describe('WO-2860 G13: New starts an empty console', () => {
  it('the status strip does not carry the previous project\'s last line, and the unread count is zero', () => {
    render(React.createElement(BottomConsole))
    act(() => {
      useCamStore.getState().addConsoleEvent({
        severity: 'success', source: 'post', message: 'Downloaded 01_Fixture_plate_setup.txt and .pdf',
      })
      useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'post', message: 'An old error' })
    })
    expect(screen.getByTestId('console-strip').textContent).toMatch(/An old error/)
    expect(screen.getByTestId('console-unread-badge').textContent).toBe('1')

    act(() => { useCamStore.getState().newProject() })

    expect(useCamStore.getState().consoleEvents).toEqual([])
    expect(useCamStore.getState().consoleReadThroughId).toBe(0)
    expect(screen.getByTestId('console-strip').textContent).not.toMatch(/An old error|Downloaded 01_Fixture_plate/)
    expect(screen.queryByTestId('console-unread-badge')).toBeNull()
  })
})
