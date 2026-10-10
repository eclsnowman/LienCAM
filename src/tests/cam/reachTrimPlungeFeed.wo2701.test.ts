// Production compute -> real CAM worker/kernel -> reach seam -> real UCCNC post.
// Only the browser's worker and IndexedDB transports are replaced.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { hemisphereOnSlab } from '../../cam3d/fixtures'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { Operation, Setup, Tool, ToolHolder, ToolpathMove } from '../../types'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import { evidenceOutDir } from '../helpers/evidenceScratch'

const mesh = hemisphereOnSlab(6, { x: 40, y: 20, t: 2 })
const worker: WorkerLike = {
  onmessage: null, onerror: null,
  postMessage: message => { dispatcher.handle(message as Cam3dRequest) },
  terminate: () => {},
}
const dispatcher = new Cam3dDispatcher(new BvhKernel(), (message: Cam3dResponse) => {
  worker.onmessage?.({ data: message } as MessageEvent)
})
const client = new Cam3dClient(worker)

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => new ArrayBuffer(8)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async importOriginal =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async () => mesh,
  }))
vi.mock('../../cam3d/integration/appClient', async importOriginal =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => client, disposeCam3dClient: () => {},
  }))

const { useCamStore } = await import('../../store')
const { postProject } = await import('../../lib/post/postProject')
const { UCCNC_CONFIG } = await import('../../lib/post')

let activeWorker: InProcessToolpathWorker | undefined
const workerSelf: {
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
  postMessage: (message: WorkerResponseMsg) => void
} = {
  onmessage: null,
  postMessage: message => activeWorker?.onmessage?.({ data: message }),
}
class InProcessToolpathWorker {
  onmessage: ((event: { data: WorkerResponseMsg }) => void) | null = null
  onerror: unknown = null
  postMessage(data: WorkerRequestMsg): void {
    activeWorker = this
    void workerSelf.onmessage!({ data })
  }
  terminate(): void { activeWorker = undefined }
}

const holder: ToolHolder = {
  id: 'holder-2701', name: 'Short ER20',
  segments: [{ height: 30, lowerDiameter: 20, upperDiameter: 20 }],
}
const tool: Tool = {
  id: 'tool-2701', name: '2 mm ball', type: 'ball_end_mill', toolNumber: 1,
  diameter: 2, fluteLength: 20, shankDiameter: 2, overallLength: 60,
  lengthBelowHolder: 4, holderId: holder.id,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: {
    rpm: 10000, feedRate: 1000, plungeRate: 300, rampFeedrate: 450,
    depthOfCut: 2, stepover: 2,
  } },
} as Tool

function install(override: boolean, stickout = 4): void {
  const params = { stepover: 4, angleDeg: 0, tolerance: 0.1, useStockBoundary: false }
  const heights = {
    clearanceHeight: 25, clearanceHeightMode: 'absolute', retractHeight: 17,
    feedHeight: 13, topHeight: 8, topHeightMode: 'absolute',
    bottomHeight: 0, bottomHeightMode: 'absolute',
  } as Operation['heights']
  const op = {
    id: 'op-2701', name: 'Dome finish', type: 'parallel_3d', toolId: tool.id,
    enabled: true, status: 'pending', geometrySelections: ['part-2701'], params, heights,
    passes: { stepdown: 2, stepover: 4, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: { entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
    smartHeight: smartHeightAuthorityFixture('parallel_3d', {
      setupId: 'setup-2701', heights, params, geometryIds: ['part-2701'],
    }),
    ...(override ? { feedrateOverride: {
      enabled: true, feedRate: 1200, plungeRate: 180, rampFeedrate: 450,
      leadInFeedrate: 1200, leadOutFeedrate: 1200, fastTraverseFeedrate: 1200,
    } } : {}),
  } as Operation
  const bounds = {
    min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 2 },
    size: { x: 40, y: 20, z: 2 }, center: { x: 20, y: 10, z: 1 },
  }
  const setup = {
    id: 'setup-2701', name: 'Setup 1', notes: '', operations: [op],
    wcs: { id: 'wcs-2701', label: 'G54', fixtureOffset: 54, stockId: 'stock-2701',
      origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0,
      offsetZBottom: 0, material: 'aluminum' },
  } as Setup
  useCamStore.setState(state => ({
    project: { ...state.project, setups: [setup], activeSetupId: setup.id,
      activeOperationId: op.id,
      geometry: [{ id: 'part-2701', name: 'Dome', filename: 'dome.stl', type: 'mesh',
        format: 'stl', loaded: true, stockId: 'stock-2701',
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        boundingBox: { ...bounds, max: { x: 40, y: 20, z: 8 },
          size: { x: 40, y: 20, z: 8 }, center: { x: 20, y: 10, z: 4 } } }],
      sceneStock: { mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
        fixedWidth: 40, fixedHeight: 20, fixedDepth: 2,
        fixedStocks: [{ id: 'stock-2701', name: 'Slab stock', width: 40, height: 20,
          depth: 2, position: { x: 0, y: 0, z: 0 } }] },
      stocks: [{ id: 'stock-2701', name: 'Slab stock', mode: 'explicit', bounds,
        position: { x: 0, y: 0, z: 0 } }],
    },
    toolLibrary: [{ ...tool, lengthBelowHolder: stickout }], holders: [holder],
    toolpathBatch: null, consoleEvents: [],
  }))
}

interface Capture { moves: ToolpathMove[]; gcode: string[] }
async function compute(override: boolean, route: 'parallel' | 'engrave' = 'parallel', stickout = 4): Promise<Capture> {
  install(override, route === 'engrave' ? 1 : stickout)
  if (route === 'engrave') {
    const state = useCamStore.getState()
    const setup = state.project.setups[0]
    const params = { geometryId: 'part-2701', loopIds: ['line'], includeOpen: true,
      includeClosed: true, mode: 'trace', depthModel: 'constant', side: 'center',
      sideOffset: 0, axialOffset: 0, targetLineWidth: 1, useWidthForDepth: false,
      direction: 'as_drawn', heightReference: 'stock_top', planeOffset: 0, tolerance: 0.01 }
    const op: Operation = { ...setup.operations[0], type: 'engrave', name: 'Stock-edge trace', params,
      geometrySelections: [],
      smartHeight: smartHeightAuthorityFixture('engrave', {
        setupId: setup.id, params, heights: setup.operations[0].heights,
        geometryIds: ['part-2701'], explicitDepthMm: 2,
      }) }
    useCamStore.setState({ project: { ...state.project,
      setups: [{ ...setup, operations: [op] }],
      geometry: [{ ...state.project.geometry[0], type: 'curves_2d', format: 'dxf',
        loops: [{ id: 'line', layerId: 'layer', closed: false, type: 'open', area: 0,
          points: [{ x: -15, y: -6 }, { x: 55, y: -6 }] }],
        layers2d: [{ id: 'layer', name: 'Trace', color: '#fff', visible: true }] }],
    } })
  }
  await useCamStore.getState().computeOperationToolpath('setup-2701', 'op-2701')
  await vi.waitFor(() => expect(['ready', 'error']).toContain(
    useCamStore.getState().project.setups[0].operations[0].status), { timeout: 20000 })
  const state = useCamStore.getState()
  const project = { ...state.project, toolLibrary: state.toolLibrary, holders: state.holders }
  const setup = project.setups[0]
  const op = setup.operations[0]
  expect(op.status, op.errorMessage).toBe('ready')
  const posted = postProject(project, [setup], UCCNC_CONFIG, {
    mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2701', ext: 'nc',
  })
  expect(posted.diagnostics.filter(d => d.level === 'error')).toEqual([])
  const result = posted.files![0].result
  const span = result.operationSpans!.find(s => s.opId === op.id)!
  return { moves: op.toolpathMoves ?? [],
    gcode: result.gcode.split('\n').slice(span.startLine - 1, span.endLine) }
}

function descents(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((m, i) => i > 0 && m.type === 'feed' && m.role === 'plunge' &&
    moves[i - 1].type === 'rapid' && m.x === moves[i - 1].x &&
    m.y === moves[i - 1].y && m.z < moves[i - 1].z)
}

describe('WO-2701 reach-trim re-entry plunge feed', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { __cncViewport: { getStockBounds: () => ({
      min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 2 },
    }) } })
    vi.stubGlobal('self', workerSelf)
    vi.stubGlobal('Worker', InProcessToolpathWorker)
    await import('../../lib/cam/toolpathWorker')
  })
  afterAll(() => vi.unstubAllGlobals())

  for (const route of ['parallel', 'engrave'] as const) for (const override of [false, true]) {
    it(`production ${route} re-entry uses ${override ? 'override 180' : 'tool default 300'} in moves and post`, async () => {
      const capture = await compute(override, route)
      const variant = `${route}-${override ? 'override' : 'default'}`
      const label = process.env.WO2701_EVIDENCE_LABEL
      if (label) {
        const dir = evidenceOutDir('src/tests/evidence/WO-2701')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${label}-${variant}.json`), JSON.stringify(capture, null, 2) + '\n')
        writeFileSync(join(dir, `${label}-${variant}.nc`), capture.gcode.join('\n') + '\n')
      }
      const plunges = descents(capture.moves)
      expect(plunges.length, 'holder must force a reach-trimmed re-entry').toBeGreaterThan(0)
      const rate = override ? 180 : 300
      expect(plunges.map(m => m.feed)).toEqual(plunges.map(() => rate))
      expect(capture.gcode.some(line => new RegExp(`^G1 Z[-\\d.]+ F${rate}(?:\\s|$)`).test(line))).toBe(true)
      if (label === 'branch') {
        const main: Capture = JSON.parse(readFileSync(`src/tests/evidence/WO-2701/main-${variant}.json`, 'utf8'))
        const expected = main.moves.map(m => m.role === 'plunge' && m.feed === (override ? 1200 : 1000)
          ? { ...m, feed: rate } : m)
        expect(capture.moves, 'only inserted plunge feeds differ from main').toEqual(expected)
      }
    }, 60000)
  }
})
