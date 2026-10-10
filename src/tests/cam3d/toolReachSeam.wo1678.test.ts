// WO-1678: one tool-reach seam for every strategy.
//
// A 16 x 16 mm cavity 25 mm deep in a 40 x 40 x 30 mm block, machined with a
// 6 mm ball end mill whose flutes run 40 mm but which sticks out only 15 mm below a
// 20 mm holder. The holder cannot follow the cutter into the cavity: its bottom
// must stay the 0.25 mm Shank clearance above the part top, so the tip can go no
// lower than Z 30 - 15 + 0.25 = 15.25. The 2D pocket trims the moves it cannot
// reach and runs the rest; every 3D finish must do the same, at the same depth,
// in the same words, through the store's own generate action.
//
// Every case presses computeOperationToolpath. The 2D worker is the REAL
// toolpathWorker.ts in-process; the 3D finishes run their real adapters over a
// real in-process cam3d kernel (the waterline slicer is a fake rectangle slicer:
// node has no opencamlib window). The expected depth is computed HERE from the
// tool and the block, never from the trim module.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { evidenceOutDir } from '../helpers/evidenceScratch'

const cam3d = vi.hoisted(() => ({ client: undefined as unknown, partMesh: undefined as PartMesh | undefined }))

vi.mock('../../lib/stlCache', async (importOriginal) => typedMock<typeof import('../../lib/stlCache')>({
  ...await importOriginal<typeof import('../../lib/stlCache')>(),
  loadCachedSTL: vi.fn(async () => null),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...await importOriginal<typeof import('../../lib/stepCache')>(),
  loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
  loadCachedStepDisplay: vi.fn(async () => null),
}))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/appClient')>({
  ...await importOriginal<typeof import('../../cam3d/integration/appClient')>(),
  getCam3dClient: () => cam3d.client as Cam3dClient,
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
  ...await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>(),
  acquirePartMesh: vi.fn(async () => cam3d.partMesh!),
}))

import { useCamStore } from '../../store'
import { smartHeightAuthorityFixture, stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { pocketBox } from '../../cam3d/fixtures'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types'
import type { WaterlineSlicer } from '../../cam3d/kernel/oclWaterline'
import type { Ring } from '../../cam3d/geom2d'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, ImportedGeometry, LinkingParams, Operation, PhysicalStock, Project, SceneStock, Setup,
  Tool, ToolHolder, ToolpathMove, Vec3, WCS,
} from '../../types'

// ── The block, the cavity, the tool ──────────────────────────────────────────

const OUTER = { x: 40, y: 40, z: 30 }
const CAVITY = { x: 16, y: 16, depth: 25 }
const TOP_Z = OUTER.z
const FLOOR_Z = OUTER.z - CAVITY.depth
const ALLOWANCE = 0.25
const SHORT_STICKOUT = 15
const LONG_STICKOUT = 40
/** The lowest tip the 20 mm holder allows over the cavity, from the tool and the block alone. */
const REACH_FLOOR_Z = TOP_Z - SHORT_STICKOUT + ALLOWANCE

const HOLDER: ToolHolder = { id: 'holder-1', name: 'ER20', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] }

function mill(stickout: number): Tool {
  return {
    id: 'tool-1', name: '6 mm ball end mill', type: 'ball_end_mill',
    diameter: 6, fluteLength: 40, shankDiameter: 6, overallLength: 80,
    lengthBelowHolder: stickout, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 5, stepover: 2 } },
  } as unknown as Tool
}

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const PART_ID = 'block'
const OUTLINE_ID = 'cavity-outline'
const STOCK_ID = 'stock-block'
const C0 = { x: (OUTER.x - CAVITY.x) / 2, y: (OUTER.y - CAVITY.y) / 2 }
const C1 = { x: C0.x + CAVITY.x, y: C0.y + CAVITY.y }

function part(): ImportedGeometry {
  return {
    id: PART_ID, name: 'Block', filename: 'block.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: OUTER.x, y: OUTER.y, z: OUTER.z }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId: STOCK_ID,
  } as unknown as ImportedGeometry
}

function cavityOutline(): ImportedGeometry {
  return {
    id: OUTLINE_ID, name: 'Cavity outline', filename: 'cavity.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: C0.x, y: C0.y, z: 0 }, { x: C1.x, y: C1.y, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId: STOCK_ID,
    loops: [{
      id: 'cavity-loop', closed: true, type: 'contour', layerId: 'L1', area: CAVITY.x * CAVITY.y,
      points: [{ x: C0.x, y: C0.y }, { x: C1.x, y: C0.y }, { x: C1.x, y: C1.y }, { x: C0.x, y: C1.y }],
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

function pocketOp(id = 'op-pocket'): Operation {
  const heights = {
    clearanceHeight: 50, clearanceHeightMode: 'absolute', retractHeight: 40, feedHeight: 32,
    topHeight: TOP_Z, topHeightMode: 'absolute', bottomHeight: FLOOR_Z, bottomHeightMode: 'absolute',
  }
  const params = {
    geometryId: OUTLINE_ID, loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
    fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
    helixDiameter: 0, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
  }
  return {
    id, name: 'Cavity pocket', type: 'pocket_2d', enabled: true, status: 'pending', toolId: 'tool-1',
    geometrySelections: [OUTLINE_ID], heights,
    passes: { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', {
      setupId: 'setup-1', heights: heights as never, params, geometryIds: [OUTLINE_ID], stockId: STOCK_ID,
      // The fixture's explicit target is WCS -depth; the cavity floor is WCS +5.
      explicitDepthMm: -FLOOR_Z,
    }),
  } as unknown as Operation
}

function finishOp(id: string, type: Operation['type'], params: Record<string, unknown>): Operation {
  return stampSmartHeightAuthority({
    id, name: `${type} in the cavity`, type, enabled: true, status: 'pending', toolId: 'tool-1',
    geometrySelections: [PART_ID],
    heights: {
      clearanceHeight: 50, clearanceHeightMode: 'absolute', retractHeight: 40, feedHeight: 32,
      topHeight: 0, topHeightMode: 'model_top', bottomHeight: 0, bottomHeightMode: 'model_bottom',
    },
    passes: { stepdown: 3, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: LINKING,
    params,
  } as unknown as Operation, { setupId: 'setup-1', geometryIds: [PART_ID], stockId: STOCK_ID }) as Operation
}

function install(ops: Operation[], stickout: number): void {
  cam3d.partMesh = pocketBox(OUTER, CAVITY)
  const fixedStock = { id: STOCK_ID, name: 'Block stock', width: OUTER.x, height: OUTER.y, depth: OUTER.z, position: { x: 0, y: 0, z: 0 } }
  const stock = {
    id: STOCK_ID, name: 'Block stock', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: OUTER.x, y: OUTER.y, z: OUTER.z }), position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: ops, notes: '',
  } as unknown as Setup
  const tool = mill(stickout)
  useCamStore.setState((s) => ({
    toolLibrary: [tool], holders: [HOLDER], toolpathBatch: null, consoleEvents: [],
    project: {
      ...s.project, geometry: [part(), cavityOutline()], stocks: [stock], setups: [setup],
      sceneStock: {
        mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: OUTER.x, fixedHeight: OUTER.y,
        fixedDepth: OUTER.z, fixedStocks: [fixedStock],
      } as unknown as SceneStock,
      toolLibrary: [tool], activeSetupId: 'setup-1', activeOperationId: ops[0].id,
      modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    } as Project,
  }))
}

// ── The wires: the real 2D worker and a real cam3d kernel, in-process ───────

/** The cavity walls, offset inward by the cutter radius, at every level inside the cavity. */
const cavitySlicer: WaterlineSlicer = {
  name: 'fake-cavity',
  async slice(_mesh: PartMesh, cutter: CutterSpec, z: number): Promise<Ring[]> {
    if (z > TOP_Z || z < FLOOR_Z) return []
    const r = cutter.diameter / 2
    return [new Float64Array([C0.x + r, C0.y + r, C1.x - r, C0.y + r, C1.x - r, C1.y - r, C0.x + r, C1.y - r])]
  },
}

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest) },
    terminate(): void { /* in-process */ },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  }, { slicer: cavitySlicer })
  return new Cam3dClient(fakeWorker)
}

let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let client: Cam3dClient

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  activeShim = null
  client = makeClient()
  cam3d.client = client
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { /* no thread */ }
  })
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  await client.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Reading the result ───────────────────────────────────────────────────────

const opById = (id: string) => useCamStore.getState().project.setups[0].operations.find((op) => op.id === id)!
const linesFor = (id: string) => useCamStore.getState().consoleEvents
  .filter((e) => e.source === 'toolpath' && e.entityRef?.kind === 'op' && e.entityRef.id === id)
  .map((e) => e.message)

async function generate(id: string): Promise<Operation> {
  await useCamStore.getState().computeOperationToolpath('setup-1', id)
  const op = opById(id)
  expect(op.status, op.errorMessage).toBe('ready')
  return op
}

/** Every tip position along the fed moves inside the cavity footprint, 0.1 mm apart. */
function cavitySamples(moves: readonly ToolpathMove[]): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type === 'rapid') continue
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.1))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
      if (p.x > C0.x && p.x < C1.x && p.y > C0.y && p.y < C1.y && p.z < TOP_Z) out.push(p)
    }
  }
  return out
}

// WO-1683: the reach trim now says every stop of one generate as ONE console
// line naming its frame ("G54 X.. Y.. Z..") instead of one bare-number line
// per stop, and adds the operation's reached/asked/uncut fact to the same
// sentence. Every strategy must say it, in these words.
const HOLDER_STOP = new RegExp(
  ': cut stopped at G54 X -?[\\d.]+ Y -?[\\d.]+ Z (-?[\\d.]+) - the holder would come within 0\\.25 mm of ' +
  'the (part|stock|remaining stock)(?: \\(\\d+ stops\\))?\\. [\\d.]+ mm of cutting path was left uncut, .*; ' +
  'reached Z [\\d.]+ of Z [\\d.]+ asked; a tool with a longer reach cuts the rest\\.',
)

function holderStops(lines: readonly string[]): number[] {
  return lines.flatMap((line) => {
    const hit = HOLDER_STOP.exec(line)
    return hit ? [Number(hit[1])] : []
  })
}

// ── The strategies ───────────────────────────────────────────────────────────

const FINISHES: [Operation['type'], Record<string, unknown>][] = [
  ['parallel_3d', { stepover: 2, angleDeg: 0, tolerance: 0.1, surfaceStockToLeave: 0, useStockBoundary: false }],
  ['waterline_3d', { stepdown: 2, tolerance: 0.1, stockToLeave: 0, useStockBoundary: false }],
  ['scallop_3d', { scallopHeight: 0.5, tolerance: 0.1, stockToLeave: 0, useStockBoundary: false }],
  ['pencil_3d', { tolerance: 0.1, stockToLeave: 0, useStockBoundary: false }],
  ['steep_shallow_3d', { stepover: 2, angleDeg: 0, tolerance: 0.1, stockToLeave: 0, useStockBoundary: false }],
]

interface Outcome { label: string; moves: ToolpathMove[]; deepest: number | undefined; stops: number[]; lines: string[] }

const outcomes: Outcome[] = []

function outcomeOf(label: string, op: Operation): Outcome {
  const moves = op.toolpathMoves ?? []
  const samples = cavitySamples(moves)
  const deepest = samples.length > 0 ? Math.min(...samples.map((p) => p.z)) : undefined
  const lines = linesFor(op.id)
  return { label, moves, deepest, stops: holderStops(lines), lines }
}

describe('WO-1678: a cavity deeper than the holder lets the tool reach', () => {
  it('the 2D pocket trims below the reach floor, runs the rest and says so', { timeout: 120_000 }, async () => {
    install([pocketOp()], SHORT_STICKOUT)
    const result = outcomeOf('pocket_2d', await generate('op-pocket'))
    outcomes.push(result)
    expect(result.stops.length, result.lines.join('\n')).toBeGreaterThan(0)
    expect(result.deepest).toBeDefined()
    expect(result.deepest!).toBeGreaterThan(REACH_FLOOR_Z - 0.3)
    expect(result.deepest!).toBeLessThan(REACH_FLOOR_Z + 1)
  })

  for (const [type, params] of FINISHES) {
    it(`${type}: trims the same region as the 2D pocket, runs the rest, and says it in the same words`, { timeout: 120_000 }, async () => {
      install([finishOp('op-finish', type, params)], SHORT_STICKOUT)
      const result = outcomeOf(type, await generate('op-finish'))
      outcomes.push(result)
      // Nothing below the reach floor survives, anywhere in the cavity.
      if (result.deepest !== undefined) {
        expect(result.deepest).toBeGreaterThan(REACH_FLOOR_Z - 0.3)
        expect(Math.abs(result.deepest - REACH_FLOOR_Z), `${type} deepest cut`).toBeLessThan(1)
      }
      // The trim is said, in the 2D pocket's sentence, and it stops at the reach floor.
      expect(result.stops.length, result.lines.join('\n')).toBeGreaterThan(0)
      for (const z of result.stops) expect(Math.abs(z - REACH_FLOOR_Z), `${type} stop Z`).toBeLessThan(1)
      for (const line of result.lines.filter((l) => HOLDER_STOP.test(l))) {
        expect(line).toContain(`"${type} in the cavity"`)
      }
    })
  }

  it('rest: a finish after the pocket keeps clear of the same holder, over what the pocket left', { timeout: 120_000 }, async () => {
    install([pocketOp(), finishOp('op-finish', 'parallel_3d', FINISHES[0][1])], SHORT_STICKOUT)
    await generate('op-pocket')
    const result = outcomeOf('parallel_3d after the pocket', await generate('op-finish'))
    outcomes.push(result)
    expect(result.stops.length, result.lines.join('\n')).toBeGreaterThan(0)
    if (result.deepest !== undefined) expect(Math.abs(result.deepest - REACH_FLOOR_Z)).toBeLessThan(1)
  })
})

describe('WO-1678: the same cavity with a tool that reaches', () => {
  it('the 2D pocket trims nothing and cuts to the floor', { timeout: 120_000 }, async () => {
    install([pocketOp()], LONG_STICKOUT)
    const result = outcomeOf('pocket_2d', await generate('op-pocket'))
    expect(result.stops).toEqual([])
    expect(result.deepest).toBeCloseTo(FLOOR_Z, 3)
  })

  for (const [type, params] of FINISHES) {
    it(`${type}: trims nothing`, { timeout: 120_000 }, async () => {
      install([finishOp('op-finish', type, params)], LONG_STICKOUT)
      const result = outcomeOf(type, await generate('op-finish'))
      expect(result.stops, result.lines.join('\n')).toEqual([])
      expect(result.lines.filter((l) => /cut stopped at/.test(l))).toEqual([])
      expect(result.deepest).toBeDefined()
      expect(result.deepest!).toBeLessThan(REACH_FLOOR_Z - 1)
    })
  }
})

// ── Pictures: a side view per strategy, cutter, neck, shank and holder drawn ──

afterAll(() => {
  if (outcomes.length === 0) return
  const dir = evidenceOutDir(join(process.cwd(), 'src', 'tests', 'evidence', 'WO-1678'))
  mkdirSync(dir, { recursive: true })
  const summary: string[] = []
  for (const outcome of outcomes) {
    writeFileSync(join(dir, `side-${outcome.label.replace(/[^a-z0-9]+/gi, '-')}.svg`), sideView(outcome))
    summary.push(
      `${outcome.label}: deepest cut in the cavity Z ${outcome.deepest?.toFixed(2) ?? 'none'}; ` +
      `${outcome.stops.length} holder stop(s) at Z ${outcome.stops.map((z) => z.toFixed(2)).join(', ') || '-'}`,
      ...outcome.lines.map((line) => `  console: ${line}`),
    )
  }
  writeFileSync(join(dir, 'summary.txt'), [
    `WO-1678 - cavity ${CAVITY.x} x ${CAVITY.y} x ${CAVITY.depth} deep in a ${OUTER.x} x ${OUTER.y} x ${OUTER.z} block.`,
    `Tool 6 mm ball, flutes 40 mm, stickout ${SHORT_STICKOUT} mm below a 20 mm holder; Shank clearance ${ALLOWANCE} mm.`,
    `Reach floor (from the tool and the block): tip Z ${REACH_FLOOR_Z.toFixed(2)}. Coordinates are G54 = world (origin 0,0,0).`,
    '',
    ...summary,
  ].join('\n') + '\n')
})

/** Side view on the cavity's XZ section (Y = cavity centre): part section, path, the tool assembly at its deepest cut. */
function sideView(outcome: Outcome): string {
  const s = 10
  const pad = 40
  const width = OUTER.x * s + 2 * pad + 420
  const height = 90 * s + 2 * pad
  const X = (x: number) => pad + x * s
  const Z = (z: number) => height - pad - (z + 5) * s
  const partPath = [
    `M ${X(0)} ${Z(0)}`, `L ${X(OUTER.x)} ${Z(0)}`, `L ${X(OUTER.x)} ${Z(TOP_Z)}`, `L ${X(C1.x)} ${Z(TOP_Z)}`,
    `L ${X(C1.x)} ${Z(FLOOR_Z)}`, `L ${X(C0.x)} ${Z(FLOOR_Z)}`, `L ${X(C0.x)} ${Z(TOP_Z)}`, `L ${X(0)} ${Z(TOP_Z)}`, 'Z',
  ].join(' ')
  const cuts: string[] = []
  for (let i = 1; i < outcome.moves.length; i++) {
    const a = outcome.moves[i - 1], b = outcome.moves[i]
    const colour = b.type === 'rapid' ? '#999' : '#0070f3'
    cuts.push(`<line x1="${X(a.x).toFixed(1)}" y1="${Z(a.z).toFixed(1)}" x2="${X(b.x).toFixed(1)}" y2="${Z(b.z).toFixed(1)}" stroke="${colour}" stroke-width="0.6" opacity="0.5"/>`)
  }
  const tipX = OUTER.x / 2
  const tipZ = outcome.deepest ?? TOP_Z
  const rect = (z0: number, z1: number, r: number, fill: string, label: string) =>
    `<rect x="${X(tipX - r)}" y="${Z(z1)}" width="${2 * r * s}" height="${(z1 - z0) * s}" fill="${fill}" fill-opacity="0.55" stroke="#222"/>` +
    `<text x="${X(tipX + r) + 4}" y="${Z((z0 + z1) / 2)}" font-size="12" font-family="sans-serif">${label}</text>`
  const tool = [
    rect(tipZ, tipZ + SHORT_STICKOUT, 3, '#d9822b', 'cutter (flutes 40 mm; no neck on this tool)'),
    rect(tipZ + SHORT_STICKOUT, tipZ + SHORT_STICKOUT + 40, 10, '#6c757d', 'holder ER20, 20 mm'),
  ].join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#fff"/>
<text x="${pad}" y="20" font-size="14" font-family="sans-serif">WO-1678 ${outcome.label}: side view, section through the cavity (Y ${OUTER.y / 2}); world Z up</text>
<path d="${partPath}" fill="#c8d6e5" stroke="#34495e"/>
<line x1="${X(0)}" y1="${Z(REACH_FLOOR_Z)}" x2="${X(OUTER.x)}" y2="${Z(REACH_FLOOR_Z)}" stroke="#c0392b" stroke-dasharray="6 4"/>
<text x="${X(0)}" y="${Z(REACH_FLOOR_Z) - 4}" font-size="12" fill="#c0392b" font-family="sans-serif">reach floor Z ${REACH_FLOOR_Z.toFixed(2)} (holder 0.25 mm above the part top)</text>
${cuts.join('\n')}
${tool}
<text x="${pad}" y="${height - 10}" font-size="12" font-family="sans-serif">deepest cut in the cavity: Z ${outcome.deepest?.toFixed(2) ?? 'none'}; holder stops: ${outcome.stops.length}; the shank is inside the holder (flutes 40 mm &gt; stickout 15 mm)</text>
</svg>
`
}
