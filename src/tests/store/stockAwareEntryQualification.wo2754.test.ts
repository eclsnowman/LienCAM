// WO-2754: two bounded stock-aware entry qualification pairs. Adapted from
// WO-1609's actual store -> real worker fixture; no new planner or repair.

import { resolve } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import type { StockState } from '../../lib/cam/stockState'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, OperationType, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolHolder, Vec3, WCS,
} from '../../types'

const SETUP_ID = 'setup-1'
const PLATE_TOP = 20
const POCKET_DEPTH = 10
const STEPDOWN = 3

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function sketchRect(id: string, name: string, x0: number, y0: number, x1: number, y1: number): ImportedGeometry {
  return {
    id, name, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: x0, y: y0, z: 0 }, { x: x1, y: y1, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: `${id}-loop`, closed: true, type: 'contour', layerId: 'L1', area: (x1 - x0) * (y1 - y0),
      points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

const POCKET_SKETCH = () => sketchRect('dxf-pocket', 'Pocket sketch', -10, -8, 10, 8)
/** Covers the whole plate, so the face takes 2 mm off everywhere the pocket is. */
const FACE_ALL_SKETCH = () => sketchRect('dxf-face', 'Face boundary', -30, -20, 30, 20)
const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'tool', name: 'tool', type: 'flat_end_mill',
    diameter: 6, fluteLength: 25, shankDiameter: 6, overallLength: 70,
    lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool
}

const FACE_MILL = tool({ id: 'face-mill', name: '10 mm end mill', diameter: 10, shankDiameter: 10 })
const POCKET_MILL = tool({ id: 'pocket-mill', name: '6 mm end mill' })

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

const HEIGHTS: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 10, feedHeight: 5,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -POCKET_DEPTH, bottomHeightMode: 'absolute',
}

function pocketParams(type: OperationType): Record<string, unknown> {
  if (type === 'adaptive_clearing_2d') {
    return {
      geometryId: 'dxf-pocket', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.7,
      stepDistance: 0.4, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
    }
  }
  if (type === 'contour_2d') {
    return { geometryId: 'dxf-pocket', loopIds: [], side: 'outer', direction: 'climb', tabs: false }
  }
  return { geometryId: 'dxf-pocket', loopIds: [], stepover: 3, heightReference: 'absolute', planeOffset: 0, direction: 'climb' }
}

function secondOp(type: 'pocket_2d' | 'adaptive_clearing_2d' | 'contour_2d'): Operation {
  const params = pocketParams(type)
  const passes: PassParams = { stepdown: STEPDOWN, stepover: 3, stockToLeave: 0, finishPasses: type === 'contour_2d' ? 1 : 0, springPasses: 0 }
  return {
    id: 'op-pocket', name: 'Pocket', type, enabled: true, status: 'pending',
    toolId: POCKET_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture(type, {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds: ['dxf-pocket'], explicitDepthMm: POCKET_DEPTH,
    }),
  } as unknown as Operation
}

function install(
  operations: Operation[],
  faceSketch: ImportedGeometry = FACE_ALL_SKETCH(),
  extraGeometry: readonly ImportedGeometry[] = [],
): void {
  const stock = {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -30, y: -20, z: 0 }, { x: 30, y: 20, z: PLATE_TOP }),
    position: { x: -30, y: -20, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: SETUP_ID, name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -30, y: -20, z: PLATE_TOP },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations, notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 60, fixedHeight: 40, fixedDepth: PLATE_TOP, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [FACE_MILL, POCKET_MILL],
    holders: [HOLDER],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project, geometry: [POCKET_SKETCH(), faceSketch, ...extraGeometry], stocks: [stock], setups: [setup], sceneStock,
      activeSetupId: SETUP_ID, activeOperationId: operations[0].id,
      modelItemPlacements: [],
    } as Project,
  }))
}

let workerRequests: WorkerRequestMsg[] = []
let completions: WorkerResponseMsg[] = []
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { if (m.type !== 'TOOLPATH_PROGRESS') completions.push(m); activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  workerRequests = []; completions = []
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { /* no thread */ }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Adapt the established real-store fixture. These are qualification pairs,
// not a repair or a defect verdict when entry placement is inconclusive.
const opById = (id: string) => useCamStore.getState().project.setups[0].operations.find(o => o.id === id)!
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function forceTopZero(op: Operation): void {
  const state = op.smartHeight as unknown as { intent: { machining: { start: unknown } } }
  state.intent.machining.start = { owner: { kind: 'user_override' }, value: { kind: 'explicit_plane',
    plane: { reference: 'stock_top', offsetMm: 0, owner: { kind: 'user_override' } } } }
}
function earlierPocket(): Operation {
  const p = secondOp('pocket_2d')
  p.id = 'prior'; p.name = 'Prior local pocket'
  p.params = { ...p.params, geometryId: 'dxf-face', loopIds: [] }
  p.heights = { ...p.heights, bottomHeight: -4 }
  p.passes = { ...p.passes, stepdown: 2 }
  p.smartHeight = smartHeightAuthorityFixture('pocket_2d', { setupId: SETUP_ID, heights: p.heights,
    params: p.params, geometryIds: ['dxf-face'], explicitDepthMm: 4 })
  return p
}
async function runCase(type: 'contour_2d' | 'adaptive_clearing_2d', cleared: readonly [number, number, number, number]) {
  const target = secondOp(type)
  target.linking = { ...target.linking, entryType: type === 'contour_2d' ? 'ramp_linear' : 'ramp_helical', rampAngle: 3 }
  forceTopZero(target)
  install([earlierPocket(), target], sketchRect('dxf-face', 'Local prior pocket', ...cleared))
  for (const id of ['prior', target.id]) {
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, id)
    expect(opById(id).status, opById(id).errorMessage).toBe('ready')
  }
  const result = opById(target.id), moves = result.toolpathMoves ?? []
  const request = workerRequests.filter((r): r is Extract<WorkerRequestMsg, { type: 'COMPUTE_CONTOUR' | 'COMPUTE_ADAPTIVE_CLEARING' }> =>
    (r.type === 'COMPUTE_CONTOUR' || r.type === 'COMPUTE_ADAPTIVE_CLEARING') && r.payload.opId === target.id).at(-1)!
  const completion = completions.filter(r => r.type === 'TOOLPATH_COMPLETE' && r.opId === target.id).at(-1)
  expect(completion && 'moves' in completion ? completion.moves : undefined).toEqual(moves)
  const current = useCamStore.getState()
  const posted = postProject({ ...current.project, toolLibrary: current.toolLibrary }, current.project.setups, UCCNC_CONFIG, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'WO-2754-qualification', ext: 'nc', selectedOpIds: { [SETUP_ID]: [target.id] },
    modelRefsVerifiedSinceLoad: current.modelRefsVerifiedSinceLoad,
  })
  const first = moves.findIndex(m => m.role === (type === 'contour_2d' ? 'ramp' : 'helix'))
  let last = first
  while (last >= 0 && last + 1 < moves.length && moves[last + 1].role === moves[first].role) last++
  const entry = first < 0 ? [] : moves.slice(Math.max(0, first - 1), last + 1)
  const stock = (request.payload as unknown as { remainingStock?: StockState }).remainingStock
  const radius = POCKET_MILL.diameter / 2
  const xs = entry.flatMap(m => m.cx === undefined || m.cy === undefined ? [m.x]
    : [m.x, m.cx - Math.hypot(m.x - m.cx, m.y - m.cy), m.cx + Math.hypot(m.x - m.cx, m.y - m.cy)])
  const ys = entry.flatMap(m => m.cx === undefined || m.cy === undefined ? [m.y]
    : [m.y, m.cy - Math.hypot(m.x - m.cx, m.y - m.cy), m.cy + Math.hypot(m.x - m.cx, m.y - m.cy)])
  const footprint = entry.length === 0 ? null : {
    minX: Math.min(...xs) - radius, maxX: Math.max(...xs) + radius,
    minY: Math.min(...ys) - radius, maxY: Math.max(...ys) + radius,
  }
  let localTop: number | null = null
  if (stock && footprint) {
    localTop = -Infinity
    for (let j = 0; j < stock.ny; j++) for (let i = 0; i < stock.nx; i++) {
      const x = stock.bounds.minX + (i + 0.5) * stock.resolutionMm
      const y = stock.bounds.minY + (j + 0.5) * stock.resolutionMm
      if (x >= footprint.minX - stock.resolutionMm / 2 && x <= footprint.maxX + stock.resolutionMm / 2 &&
          y >= footprint.minY - stock.resolutionMm / 2 && y <= footprint.maxY + stock.resolutionMm / 2) {
        localTop = Math.max(localTop, stock.topZ[j * stock.nx + i])
      }
    }
    if (!Number.isFinite(localTop)) localTop = null
  }
  expect(result.resolvedHeights?.wcs.feed).toBe(5)
  expect(request.payload.heights.feedHeight).toBe(5)
  return { type, cleared, request, completion, moves, entry, footprint, localTop, posted,
    moveSha256: hash(moves), stockSha256: hash(stock ?? null), notices: current.consoleEvents.map(e => e.message) }
}
function receiptDestination(variable: 'WO2754_CONTOUR_OUT' | 'WO2754_ADAPTIVE_OUT'): string {
  const configured = process.env[variable]
  if (!configured) throw new Error(`Set ${variable} to a fresh coordinator-approved receipt destination.`)
  const output = resolve(configured)
  if (existsSync(output)) throw new Error(`Preserving existing receipt; choose a fresh ${variable}: ${output}`)
  return output
}
function savePair(output: string, candidate: Awaited<ReturnType<typeof runCase>>, control: Awaited<ReturnType<typeof runCase>>) {
  const covered = candidate.localTop !== null && candidate.localTop <= PLATE_TOP - 4 + 0.01
  const retained = control.localTop !== null && control.localTop >= PLATE_TOP - 0.01
  const record = { candidate, control, coverage: { candidateCovered: covered, controlRetained: retained },
    classification: covered && retained ? 'qualified entry footprints; inspect recorded motion' : 'inconclusive; no defect attributed',
    sourceHashes: Object.fromEntries(['src/store/index.ts', 'src/lib/cam/contour2d.ts', 'src/lib/cam/toolpathWorker.ts'].map(path =>
      [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) }
  writeFileSync(output, JSON.stringify(record, null, 2), { flag: 'wx' })
}
// WO-2784: WO-2754 made these coordinator-granted, on-demand receipt runs
// (explicit create-only WO2754_CONTOUR_OUT / WO2754_ADAPTIVE_OUT, commit
// e8b6653176). Without a destination they cannot run, so ordinary suite runs
// skip them; every assertion is unchanged when the variable is set.
describe('WO-2754 bounded existing-entry qualification', () => {
  it.skipIf(!process.env.WO2754_CONTOUR_OUT)('records one Contour ramp cleared-footprint and retained-material pair at Feed +5', async () => {
    const output = receiptDestination('WO2754_CONTOUR_OUT')
    const control = await runCase('contour_2d', [18, 8, 28, 18])
    const candidate = await runCase('contour_2d', [-24, -19, 24, 19])
    savePair(output, candidate, control)
    expect(candidate.request.type).toBe('COMPUTE_CONTOUR')
    expect(control.request.type).toBe('COMPUTE_CONTOUR')
  }, 120000)
  it.skipIf(!process.env.WO2754_ADAPTIVE_OUT)('records one Adaptive2D pair using the actual control helix footprint', async () => {
    const output = receiptDestination('WO2754_ADAPTIVE_OUT')
    const control = await runCase('adaptive_clearing_2d', [18, 8, 28, 18])
    const f = control.footprint
    const cleared: [number, number, number, number] = f ? [Math.max(-29, f.minX - 2), Math.max(-19, f.minY - 2),
      Math.min(29, f.maxX + 2), Math.min(19, f.maxY + 2)] : [-9, -7, 9, 7]
    const candidate = await runCase('adaptive_clearing_2d', cleared)
    savePair(output, candidate, control)
    expect(candidate.request.type).toBe('COMPUTE_ADAPTIVE_CLEARING')
    expect(control.request.type).toBe('COMPUTE_ADAPTIVE_CLEARING')
  }, 120000)
})

