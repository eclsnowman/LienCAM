// WO-1217 -- the chain runner. It drives the PRODUCTION entry point.
//
// Rule 6: "Any count or claim about what the APPLICATION draws must run through
// the application's production entry point. A hand-built payload sent directly
// to an engine is a control, never application truth."
//
// So this runner stands the app up around the real cam3d kernel and calls
// `useCamStore.getState().computeOperationToolpath(setupId, opId)` for every step
// of a chain, in order, exactly as the app does when a machinist presses
// Generate. The scene setup is lifted from `src/tests/cam3d/restWiring.wo279.test.ts`
// (a third way of standing the store up is how contracts drift apart): a
// Cam3dClient wired straight to a Cam3dDispatcher over an in-process channel, so
// every carve is real geometry and every decision is the production one. Only the
// STEP byte cache and the tessellator are stubbed -- the benchmark is about what
// the engine plans, not about reading files.
//
// PLANNING AND SCORING ARE SEPARATE. `planChain` is the expensive half (the app
// computing toolpaths); `scoreChain` turns what it produced into a scorecard row.
// Splitting them is what lets the injected-regression proof mutate one link and
// re-score without a third planning pass.
//
// NOTHING HERE KNOWS THE NAME OF A PART, A TOOL OR AN OPERATION. It runs whatever
// `registry.ts` declares.

import { vi } from 'vitest'

import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { toolToCutterSpec } from '../../cam3d/integration/cutterSpec'
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types'
import { ZDexelField } from '../../cam3d/stock'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type {
  AdaptiveRoughDiagnostics,
  FixedStockItem,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  SceneStock,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'
import {
  carveCoverage,
  linkClearanceMetric,
  measureRadialEngagement,
  pathMetrics,
  samplePath,
  stockBoxFor,
  surfaceHeightField,
  surfaceMetrics,
  type RadialEngagementMetrics,
} from './metrics'
import {
  assertRowComplete,
  notApplicable,
  requireMetricNumber,
  type MetricValue,
} from './metricRegistry'
import type { BenchmarkChain, BenchmarkStep, BenchmarkTool } from './registry'
import { partById, rowKey, toolById } from './registry'

/** Tool-tip sample spacing for the gouge / stock-to-leave check, mm. */
const GOUGE_SAMPLE_SPACING_MM = 0.25

/**
 * The two metric GROUPS a row either measures in full or declares absent in full.
 *
 * Each group is ONE list, walked by both branches, so the measured set and the
 * reasoned-absent set cannot drift apart -- which is exactly how the finish rows
 * ended up carrying eleven fewer cells than the rough rows and nobody noticed.
 */
const ENGAGEMENT_METRIC_KEYS = [
  'peakEngagementFraction',
  'p95EngagementFraction',
  'engagementCapFraction',
  'engagementOverCapLengthMm',
  'engagementOverCapPct',
  'measuredCuttingLengthMm',
] as const satisfies readonly (keyof RadialEngagementMetrics)[]

/** Compile-time proof the list above names EVERY engagement metric the collector returns. */
type UnlistedEngagementKey = Exclude<keyof RadialEngagementMetrics, (typeof ENGAGEMENT_METRIC_KEYS)[number]>
const _engagementKeysExhaustive: UnlistedEngagementKey extends never ? true : never = true
void _engagementKeysExhaustive

/** The numeric fields of the app's own adaptive-rough diagnostics. */
type NumericRegionKey = {
  [K in keyof AdaptiveRoughDiagnostics]: AdaptiveRoughDiagnostics[K] extends number ? K : never
}[keyof AdaptiveRoughDiagnostics]

const REGION_METRIC_KEYS = [
  'levelCount',
  'plannedRegions',
  'machinedRegions',
  'skippedRegions',
  'partialRegions',
] as const satisfies readonly NumericRegionKey[]

/** What the app produced for one step of a chain. */
export interface PlannedStep {
  stepId: string
  /** The setup this step actually ran in, WO-1219 -- a multi-setup chain runs
   *  its steps across more than one. */
  setupId: string
  moves: ToolpathMove[]
  /** Planning wall time, ms, as the app measured it. WO-1198 cost 2.10x and
   *  nobody noticed until it was measured. */
  planMs: number
  /** The app's own machine-time estimate for these moves, ms. */
  cutTimeMs?: number
  /** The operation's own region diagnostics, where the strategy publishes them. */
  regions?: AdaptiveRoughDiagnostics
  /** The heights the store actually resolved for this operation, WO-1219 --
   *  the proof that a second setup's heights are its own and not a silent
   *  revert to the setup before it. */
  heights?: Operation['heights']
}

export interface PlannedChain {
  chainId: string
  steps: PlannedStep[]
}

/**
 * One scorecard row: one operation of one chain.
 *
 * `metrics` is the deterministic half -- two runs of the same code must produce
 * identical values, and the determinism assert compares exactly this object.
 * `planMs` is wall time and lives outside it.
 *
 * EVERY metric in the registry appears here on EVERY row, as a number or as an
 * explicit `notApplicable("why")`. `assertRowComplete` enforces that before the
 * row is pushed -- see metricRegistry.ts for why a missing metric is the one
 * failure this harness cannot see by itself.
 */
export interface ScorecardRow {
  key: string
  partId: string
  setupLabel: string
  stepId: string
  toolId: string
  scopeId: string
  opType: string
  toolDiameterMm: number
  metrics: Record<string, MetricValue>
  planMs: number
  asserts: {
    maxGougeMm: number
    minCutMarginMm: number
    stockToLeaveMm: number
    gougeToleranceMm: number
    samplesOverPart: number
    cutSamplesOverPart: number
    steepInteriorSamplesSkipped: number
  }
}

export interface ChainResult {
  chainId: string
  rows: ScorecardRow[]
  /** Chain totals over every row, for the one-line-per-chain summary. */
  totals: { moves: number; flownDistanceMm: number; cutTimeMs: number; planMs: number }
}

/** Six decimals: enough that no real change hides, coarse enough that f64 noise cannot forge one. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function toolFor(spec: BenchmarkTool): Tool {
  return {
    id: spec.id,
    name: spec.label,
    type: spec.type,
    diameter: spec.diameter,
    ...(spec.cornerRadius === undefined ? {} : { cornerRadius: spec.cornerRadius }),
    fluteLength: spec.fluteLengthMm,
    shankDiameter: spec.diameter,
    overallLength: spec.fluteLengthMm + 35,
    numberOfFlutes: spec.type === 'ball_end_mill' ? 2 : 3,
    material: 'carbide',
    coating: 'none',
    notes: '',
    // Feeds are DATA, derived from the diameter so a tool change moves the cut
    // time honestly instead of leaving it unmeasurable (an operation with no feed
    // cannot be timed at all -- ADR-0003).
    feedsAndSpeeds: {
      default: {
        rpm: 12000,
        feedRate: Math.round(200 * spec.diameter),
        plungeRate: Math.round(70 * spec.diameter),
        depthOfCut: spec.diameter / 2,
        stepover: spec.diameter * 0.4,
      },
    },
  }
}

function operationFor(
  step: BenchmarkStep,
  setupId: string,
  geometryId: string,
  stockId: string,
  topZ: number,
): Operation {
  const override = step.heightOverride
  return stampSmartHeightAuthority(
    {
      id: step.id,
      name: step.id,
      type: step.type,
      enabled: true,
      status: 'pending',
      toolId: step.toolId,
      geometrySelections: [geometryId],
      heights: {
        clearanceHeight: override?.clearanceHeight ?? topZ + 10,
        clearanceHeightMode: 'absolute',
        retractHeight: override?.retractHeight ?? topZ + 2,
        feedHeight: override?.feedHeight ?? topZ + 1,
        topHeight: 0,
        topHeightMode: 'model_top',
        bottomHeight: 0,
        bottomHeightMode: 'model_bottom',
      },
      passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: {
        entryType: 'plunge',
        rampAngle: 3,
        rampLength: 10,
        leadInRadius: 0,
        leadOutRadius: 0,
        retractType: 'full',
        transitionType: 'safe_height',
      },
      params: step.params,
    },
    { setupId, geometryIds: [geometryId], stockId },
  )
}

/** The setup id a step runs in, WO-1219: the chain's own label unless the step
 *  names a different one (a second setup in a flip). */
export function setupIdFor(partId: string, setupLabel: string): string {
  return `setup-${partId}-${setupLabel}`
}

function stepSetupLabel(chain: BenchmarkChain, step: BenchmarkStep): string {
  return step.setupLabel ?? chain.setupLabel
}

function stepSetupId(chain: BenchmarkChain, step: BenchmarkStep): string {
  return setupIdFor(chain.partId, stepSetupLabel(chain, step))
}

/**
 * Everything about a chain that both halves need, derived from registry data.
 * Exported (WO-1219) so a proof test that needs to inspect the Setup objects
 * themselves (their WCS, their operation order) does not have to build a
 * FOURTH way of standing the store up -- see restWiring.wo279.test.ts's own
 * warning against exactly that.
 */
export async function chainScene(chain: BenchmarkChain) {
  const part = partById(chain.partId)
  const mesh = await part.mesh()
  const box = stockBoxFor(mesh, part.stockMargin)
  const geometryId = `geo-${chain.partId}`
  const stockId = `stock-${chain.partId}`

  const stock: FixedStockItem = {
    id: stockId,
    name: `${part.label} block`,
    width: box.maxX - box.minX,
    height: box.maxY - box.minY,
    depth: box.maxZ - box.minZ,
    position: { x: box.minX, y: box.minY, z: box.minZ },
  }
  // STEP, not STL: an imported STL is recentred for display, so its moves land in
  // a shifted frame and could not be compared with the fixture's own coordinates.
  const geometry: ImportedGeometry = {
    id: geometryId,
    name: part.label,
    filename: `${part.id}.step`,
    type: 'brep',
    format: 'step',
    boundingBox: {
      min: { x: mesh.bounds.min[0], y: mesh.bounds.min[1], z: mesh.bounds.min[2] },
      max: { x: mesh.bounds.max[0], y: mesh.bounds.max[1], z: mesh.bounds.max[2] },
      size: {
        x: mesh.bounds.max[0] - mesh.bounds.min[0],
        y: mesh.bounds.max[1] - mesh.bounds.min[1],
        z: mesh.bounds.max[2] - mesh.bounds.min[2],
      },
      center: {
        x: (mesh.bounds.max[0] + mesh.bounds.min[0]) / 2,
        y: (mesh.bounds.max[1] + mesh.bounds.min[1]) / 2,
        z: (mesh.bounds.max[2] + mesh.bounds.min[2]) / 2,
      },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId,
  }
  const physicalStock: PhysicalStock = {
    id: stockId,
    name: stock.name,
    mode: 'explicit',
    bounds: {
      min: { x: box.minX, y: box.minY, z: box.minZ },
      max: { x: box.maxX, y: box.maxY, z: box.maxZ },
      size: { x: stock.width, y: stock.height, z: stock.depth },
      center: {
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
        z: (box.minZ + box.maxZ) / 2,
      },
    },
    position: { x: 0, y: 0, z: 0 },
  }
  const sceneStock: SceneStock = {
    mode: 'fixed',
    autoOffsetXY: 0,
    autoOffsetZTop: 0,
    fixedWidth: stock.width,
    fixedHeight: stock.height,
    fixedDepth: stock.depth,
    fixedStocks: [stock],
  }
  const tools = [...new Set(chain.steps.map((step) => step.toolId))].map((id) => toolFor(toolById(id)))
  // One Setup per distinct label the steps declare, in first-appearance order --
  // every chain before WO-1219 named exactly one (chain.setupLabel), so this
  // produces the same single setup, same id, same G54 it always did. A chain
  // whose steps name a SECOND label (a flip) gets a second Setup with its own
  // fixture offset, so the two never share a WCS or an operations array.
  const setupLabels = [...new Set(chain.steps.map((step) => stepSetupLabel(chain, step)))]
  const setups: Setup[] = setupLabels.map((label, index) => {
    const setupId = setupIdFor(chain.partId, label)
    return {
      id: setupId,
      name: `${part.label} / ${label}`,
      wcs: {
        id: `wcs-${setupId}`,
        label: `G${54 + index}`,
        fixtureOffset: 54 + index,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        zAxis: { x: 0, y: 0, z: 1 },
        stockId,
      },
      stock: {
        type: 'rectangular',
        offsetX: 0,
        offsetY: 0,
        offsetZTop: 0,
        offsetZBottom: 0,
        material: 'aluminum',
      },
      operations: chain.steps
        .filter((step) => stepSetupLabel(chain, step) === label)
        .map((step) => operationFor(step, setupId, geometryId, stockId, box.maxZ)),
      notes: '',
    }
  })
  return { part, mesh, box, geometryId, geometry, physicalStock, sceneStock, stock, tools, setups }
}

interface Scene {
  compute: (setupId: string, opId: string) => Promise<void>
  op: (setupId: string, opId: string) => Operation
  dispose: () => Promise<void>
}

async function makeScene(input: {
  mesh: PartMesh
  setups: Setup[]
  tools: Tool[]
  geometry: ImportedGeometry
  physicalStock: PhysicalStock
  sceneStock: SceneStock
}): Promise<Scene> {
  vi.resetModules()

  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest)
    },
    terminate(): void {
      // The in-process test channel owns no browser worker.
    },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  })
  const client = new Cam3dClient(fakeWorker)

  vi.doMock('../../cam3d/integration/appClient', async (importOriginal) =>
    typedMock<typeof import('../../cam3d/integration/appClient')>({
      ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
      getCam3dClient: () => client,
    }))
  vi.doMock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
    typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
      ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
      acquirePartMesh: vi.fn(async () => input.mesh),
    }))
  vi.doMock('../../lib/stepCache', async (importOriginal) =>
    typedMock<typeof import('../../lib/stepCache')>({
      ...(await importOriginal<typeof import('../../lib/stepCache')>()),
      loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
    }))

  const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', { localStorage, __cncViewport: { getStockBounds: () => null } })

  const { useCamStore } = await import('../../store')

  useCamStore.setState((state) => ({
    project: {
      ...state.project,
      id: 'project-benchmark',
      geometry: [input.geometry],
      setups: input.setups,
      stocks: [input.physicalStock],
      sceneStock: input.sceneStock,
      toolLibrary: input.tools,
      activeSetupId: input.setups[0].id,
    },
    toolLibrary: input.tools,
    toolpathBatch: null,
  }))

  return {
    compute: (setupId, opId) => useCamStore.getState().computeOperationToolpath(setupId, opId),
    op: (setupId, opId) => {
      const found = useCamStore
        .getState()
        .project.setups.find((s) => s.id === setupId)
        ?.operations.find((o) => o.id === opId)
      if (!found) throw new Error(`benchmark: operation ${opId} vanished from setup ${setupId}`)
      return found
    },
    dispose: async () => {
      await client.dispose()
      vi.doUnmock('../../cam3d/integration/appClient')
      vi.doUnmock('../../cam3d/integration/parallel3dOperation')
      vi.doUnmock('../../lib/stepCache')
      vi.unstubAllGlobals()
      vi.resetModules()
    },
  }
}

/**
 * Plan a chain through the app: one `computeOperationToolpath` per step, in the
 * declared order, in one setup, so rest machining and staleness see the sequence a
 * machinist would run. An operation that does not land `ready` fails loud with the
 * app's own message -- a benchmark that quietly scores a refused operation is worse
 * than no benchmark.
 */
export async function planChain(chain: BenchmarkChain): Promise<PlannedChain> {
  const { mesh, geometry, physicalStock, sceneStock, tools, setups } = await chainScene(chain)
  const scene = await makeScene({ mesh, setups, tools, geometry, physicalStock, sceneStock })
  const steps: PlannedStep[] = []
  try {
    for (const step of chain.steps) {
      const setupId = stepSetupId(chain, step)
      await scene.compute(setupId, step.id)
      const op = scene.op(setupId, step.id)
      if (op.status !== 'ready') {
        throw new Error(
          `benchmark chain ${chain.id} step ${step.id}: status ${op.status}` +
            `${op.errorMessage ? ` -- ${op.errorMessage}` : ''}`,
        )
      }
      const moves = op.toolpathMoves ?? []
      if (moves.length === 0) throw new Error(`benchmark chain ${chain.id} step ${step.id}: no moves`)
      steps.push({
        stepId: step.id,
        setupId,
        moves: moves.map((move) => ({ ...move })),
        heights: { ...op.heights },
        planMs: op.computeTimeMs ?? 0,
        ...(typeof op.estimatedCutTimeMs === 'number' && Number.isFinite(op.estimatedCutTimeMs)
          ? { cutTimeMs: op.estimatedCutTimeMs }
          : {}),
        ...(op.diagnostics?.adaptiveRough ? { regions: op.diagnostics.adaptiveRough } : {}),
      })
    }
  } finally {
    await scene.dispose()
  }
  return { chainId: chain.id, steps }
}

/**
 * Score what the app produced. No engine work happens here, so the injected-
 * regression proof can hand this mutated moves and get a scorecard back for the
 * price of the collectors alone.
 */
export async function scoreChain(chain: BenchmarkChain, planned: PlannedChain): Promise<ChainResult> {
  const { part, mesh, box } = await chainScene(chain)
  // The chain's own stock accounting: one field carried from operation to
  // operation, so "what is still standing" is a chain fact and not a per-op one.
  const field = ZDexelField.fromBox(box, part.coverageCell)
  const surfaceZ = await surfaceHeightField(mesh, field)

  const rows: ScorecardRow[] = []
  for (const step of chain.steps) {
    const plannedStep = planned.steps.find((candidate) => candidate.stepId === step.id)
    if (!plannedStep) throw new Error(`benchmark chain ${chain.id}: nothing planned for step ${step.id}`)
    const { moves } = plannedStep
    const toolSpec = toolById(step.toolId)
    const cutter: CutterSpec = toolToCutterSpec(toolFor(toolSpec))
    const path = pathMetrics(moves)
    const coverage = carveCoverage({ field, surfaceZ, cutter, moves })
    const surface = await surfaceMetrics({
      mesh,
      cutter,
      samples: samplePath(moves, GOUGE_SAMPLE_SPACING_MM),
      shrinkMm: step.lateralAllowanceMm,
    })

    const metrics: Record<string, MetricValue> = {}
    for (const [name, value] of Object.entries(path)) metrics[name] = round6(value)
    // WO-1880: round6(NaN) is still NaN, so the "no non-cutting sample" case
    // (metrics.ts:minLinkClearanceMm) survives rounding and reaches the
    // reasoned-absence conversion below -- see linkClearanceMetric.
    metrics.minLinkClearanceMm = linkClearanceMetric(round6(surface.minLinkClearanceMm))
    metrics.uncutAreaMm2 = round6(coverage.uncutAreaMm2)
    metrics.machinedAreaMm2 = round6(coverage.machinedAreaMm2)
    metrics.removedVolumeMm3 = round6(coverage.removedVolumeMm3)

    // Radial engagement is the engine's own measure, and it is only taken where
    // the strategy actually promises a bound: see BenchmarkStep.engagementCapFraction.
    // Where it does not, the cells are written as REASONED ABSENCES rather than
    // left out -- a row that silently lacks a metric is invisible, and that is the
    // defect this shape exists to make impossible.
    if (step.engagementCapFraction !== undefined) {
      const engagement = measureRadialEngagement({
        moves,
        stockBounds: box,
        cellMm: step.engagementCellMm ?? part.coverageCell,
        cutter,
        capFraction: step.engagementCapFraction,
      })
      for (const name of ENGAGEMENT_METRIC_KEYS) metrics[name] = round6(engagement[name])
    } else {
      // measurePathEngagement (src/cam3d/rough/pathEngagement.ts) builds its replay
      // field from the UNCUT stock box and takes no pre-carved field, so for a step
      // that is not the first of its chain it would attribute the rougher's removal
      // to this path. Neither is this strategy making an engagement promise to
      // score against. A wrong number is worse than a reasoned absence -- the audit
      // proved that twice on this very order (rounds 1 and 2).
      const why =
        `${step.type} declares no engagement cap (BenchmarkStep.engagementCapFraction), and ` +
        'measurePathEngagement replays from the UNCUT stock box with no pre-carved-field entry ' +
        'point, so a later step in a chain cannot be measured against the stock it really cuts.'
      for (const name of ENGAGEMENT_METRIC_KEYS) metrics[name] = notApplicable(why)
    }

    metrics.cutTimeMs =
      plannedStep.cutTimeMs === undefined
        ? notApplicable(
            'the application published no estimatedCutTimeMs for this operation (an operation ' +
              'with no feed rate cannot be timed at all -- ADR-0003).',
          )
        : round6(plannedStep.cutTimeMs)

    // Region coverage comes from the operation's OWN diagnostics -- the app's count,
    // not ours. `OperationDiagnostics` publishes regions only for adaptive rough, so
    // any other strategy says so in the reason instead of having a region count
    // invented for it here.
    if (plannedStep.regions) {
      const regions = plannedStep.regions
      for (const name of REGION_METRIC_KEYS) metrics[name] = regions[name]
    } else {
      const why =
        `the application publishes region diagnostics only for adaptive rough ` +
        `(OperationDiagnostics.adaptiveRough); ${step.type} publishes none, and the harness ` +
        'measures the application rather than modelling it. Area coverage for this row is ' +
        'carried by uncutAreaMm2 / machinedAreaMm2 / removedVolumeMm3, which ARE measured.'
      for (const name of REGION_METRIC_KEYS) metrics[name] = notApplicable(why)
    }

    // The completeness invariant, at the one write path: every registry metric is
    // present here, as a number or as a reasoned absence, or this throws.
    const key = rowKey(chain, step)
    assertRowComplete(key, metrics)

    rows.push({
      key,
      partId: chain.partId,
      setupLabel: step.setupLabel ?? chain.setupLabel,
      stepId: step.id,
      toolId: step.toolId,
      scopeId: step.scope.id,
      opType: step.type,
      toolDiameterMm: toolSpec.diameter,
      metrics,
      planMs: round6(plannedStep.planMs),
      asserts: {
        maxGougeMm: round6(surface.maxGougeMm),
        minCutMarginMm: round6(surface.minCutMarginMm),
        stockToLeaveMm: step.stockToLeaveMm,
        gougeToleranceMm: step.gougeToleranceMm,
        samplesOverPart: surface.samplesOverPart,
        cutSamplesOverPart: surface.cutSamplesOverPart,
        steepInteriorSamplesSkipped: surface.steepInteriorSamplesSkipped,
      },
    })
  }

  return {
    chainId: chain.id,
    rows,
    // Totals REQUIRE their metrics to be numbers. Summing a reasoned absence as
    // zero would quietly under-report a chain, which is the same class of lie the
    // completeness invariant exists to stop; a chain whose cut time nobody could
    // measure must fail rather than report a smaller total.
    totals: {
      moves: rows.reduce((sum, row) => sum + requireMetricNumber(row.key, 'moves', row.metrics.moves), 0),
      flownDistanceMm: round6(
        rows.reduce((sum, row) => sum + requireMetricNumber(row.key, 'flownDistanceMm', row.metrics.flownDistanceMm), 0),
      ),
      cutTimeMs: round6(
        rows.reduce((sum, row) => sum + requireMetricNumber(row.key, 'cutTimeMs', row.metrics.cutTimeMs), 0),
      ),
      planMs: round6(rows.reduce((sum, row) => sum + row.planMs, 0)),
    },
  }
}

/** Plan every chain of a tier, in registry order. */
export async function planChains(chains: readonly BenchmarkChain[]): Promise<PlannedChain[]> {
  const out: PlannedChain[] = []
  for (const chain of chains) out.push(await planChain(chain))
  return out
}

/** Score every planned chain, in registry order. */
export async function scoreChains(
  chains: readonly BenchmarkChain[],
  planned: readonly PlannedChain[],
): Promise<ChainResult[]> {
  const out: ChainResult[] = []
  for (let index = 0; index < chains.length; index++) {
    out.push(await scoreChain(chains[index], planned[index]))
  }
  return out
}

/** Every row of every chain result, in row order. */
export function allRows(results: readonly ChainResult[]): ScorecardRow[] {
  return results.flatMap((result) => result.rows)
}
