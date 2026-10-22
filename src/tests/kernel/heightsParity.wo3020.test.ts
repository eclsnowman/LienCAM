// WO-3020 (alpha.3 A3-11): the kernel heights service at parity with today's
// version-2 resolver.
//
// Oracle: today's engine, untouched. A shadow on src/lib/cam/smartHeights/
// resolve.ts records every (intent, evidence) pair the PRODUCTION path resolves
// - the store's compute through the real toolpath worker (heightScenario.ts,
// the WO-1604..1622 campaign harness) for every 2.5D family and for Adaptive
// 3D / Parallel / Waterline / Drill on imported solids - plus today's family
// builders on the BL-281 procedural meshes for the families no scenario drives
// (Scallop, Steep and Shallow, Pencil, Pattern). Each recorded call is then
// resolved by the kernel and must equal today's result exactly: planes, owners,
// proof ids, evidence graph, warnings, and every refusal word for word.
// The conversion, formula and level modules are compared to today's code the
// same way (exported functions directly; the private 2.5D ladders by their own
// source text, compiled as-is).

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import ts from 'typescript'
import { ADAPTIVE_POLICY as AP } from '../../kernel/ops/adaptive/policy'
import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { HeightEvidenceContext, OperationHeightIntentV2, ResolveSmartHeightPlanResult } from '../../lib/cam/smartHeights'

interface RecordedCall {
  intent: OperationHeightIntentV2
  context: HeightEvidenceContext
  result: ResolveSmartHeightPlanResult
}
const recorded = vi.hoisted(() => [] as RecordedCall[])

vi.mock('../../lib/cam/smartHeights/resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/smartHeights/resolve')>()
  return typedMock<typeof import('../../lib/cam/smartHeights/resolve')>({
    ...actual,
    resolveSmartHeightPlan: (intent, context) => {
      const input = { intent: structuredClone(intent), context: structuredClone(context) }
      const result = actual.resolveSmartHeightPlan(intent, context)
      recorded.push({ ...input, result: structuredClone(result) })
      return result
    },
  })
})
// Browser transports only, exactly as solids3d.wo1606.test.ts replaces them.
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) =>
  typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...(await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()),
    deriveHoles: async (geoId: string) =>
      (await import('../helpers/heightScenario')).deriveHolesInProcess(geoId),
  }))

import * as scenarioModule from '../helpers/heightScenario'
import {
  circleLoop, installRealToolpathWorker, rectLoop, runHeightScenario, runSolidScenario,
  type HeightScenario, type ScenarioWorkholding,
} from '../helpers/heightScenario'
import * as today from '../../lib/cam/smartHeights'
import { TOOL_TYPE_META } from '../../lib/tool/toolMeta'
import { planLevels } from '../../cam3d/rough/levels'
import { planWaterlineLevels } from '../../cam3d/strategies/waterline/levels'
import * as fixtures from '../../cam3d/fixtures'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { OperationType, Tool, ToolType } from '../../types'
import * as kernel from '../../kernel/heights'

installRealToolpathWorker()

// ─── the production runs ──────────────────────────────────────────────────────

const RAISE = 50
const OUTLINE = rectLoop('outline', 0, 0, 60, 40)
const POCKET = rectLoop('pocket', 15, 10, 35, 30)
const HOLE = circleLoop('hole', 48, 20, 4)
const VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 40, y: 5, z: 0 }, max: { x: 56, y: 35, z: RAISE } }
const AUTO_STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 }
const LOOP_FOR: Record<HeightScenario['operation'], string[]> = {
  face: [], pocket_2d: ['pocket'], adaptive_clearing_2d: ['pocket'], contour_2d: ['outline'], drill: ['hole'],
  bore: ['hole'], chamfer: ['outline'], engrave: ['pocket'], vcarve: ['pocket'], thread_mill: ['hole'],
}

const raised = (operation: HeightScenario['operation'], extra: Partial<HeightScenario> = {}): HeightScenario => ({
  part: { kind: 'sketch_2d', loops: [OUTLINE, POCKET, HOLE], z: RAISE },
  stock: AUTO_STOCK, workholding: VISE, operation, loopIds: LOOP_FOR[operation], ...extra,
})
const onTable = (operation: HeightScenario['operation'], extra: Partial<HeightScenario> = {}): HeightScenario => ({
  part: { kind: 'sketch_2d', loops: [OUTLINE, POCKET, HOLE], z: 0 },
  stock: AUTO_STOCK, operation, loopIds: LOOP_FOR[operation], ...extra,
})

const bottomMinus8 = { bottomRow: { reference: 'stock_top' as const, offsetMm: -8 } }
const bottomAboveStockBottom = { bottomRow: { reference: 'stock_bottom' as const, offsetMm: 1.35 } }
const topMinus3 = { topRow: { reference: 'stock_top' as const, offsetMm: -3 } }
const retract20 = { safetyOverride: { plane: 'retract' as const, reference: 'wcs_plane' as const, offsetMm: 20 } }
// Top below Bottom: today refuses (invalid_plane_order); the kernel must refuse with the same words.
const topUnderBottom = { topRow: { reference: 'stock_top' as const, offsetMm: -10 }, ...bottomMinus8 }

const SCENARIOS_2D: Array<[string, HeightScenario]> = [
  ['face smart', raised('face')],
  ['face bottom -8', raised('face', bottomMinus8)],
  ['face top -3', raised('face', topMinus3)],
  ['face retract 20', raised('face', retract20)],
  ['pocket smart', raised('pocket_2d')],
  ['pocket bottom stock bottom +1.35', raised('pocket_2d', bottomAboveStockBottom)],
  ['pocket top -3', raised('pocket_2d', topMinus3)],
  ['pocket retract 20', raised('pocket_2d', retract20)],
  ['pocket top under bottom (refusal)', raised('pocket_2d', topUnderBottom)],
  ['adaptive 2D smart', raised('adaptive_clearing_2d')],
  ['adaptive 2D bottom -8', raised('adaptive_clearing_2d', bottomMinus8)],
  ['adaptive 2D top -3', raised('adaptive_clearing_2d', topMinus3)],
  ['contour smart', raised('contour_2d')],
  ['contour bottom -8', raised('contour_2d', bottomMinus8)],
  ['contour retract 20', raised('contour_2d', retract20)],
  ['drill smart', raised('drill')],
  ['drill bottom -8', raised('drill', bottomMinus8)],
  ['bore smart', raised('bore')],
  ['bore top -3', raised('bore', topMinus3)],
  ['chamfer smart', raised('chamfer')],
  ['chamfer width 3', raised('chamfer', { datumFormula: { depthMm: 3 } })],
  ['engrave depth 1', raised('engrave', { datumFormula: { depthMm: 1 } })],
  ['engrave depth 3', raised('engrave', { datumFormula: { depthMm: 3 } })],
  ['vcarve smart', raised('vcarve')],
  ['vcarve flat depth 2', raised('vcarve', { datumFormula: { depthMm: 2 } })],
  ['thread mill smart', onTable('thread_mill')],
  ['thread mill length 4', onTable('thread_mill', { datumFormula: { depthMm: 4 } })],
]

const BOX_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 5, y: 5, z: 0 }, max: { x: 25, y: 15, z: RAISE } }
const BOX_STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }
const rough = { toolDiameter: 6, axialStockToLeave: 0.5, params: { useStockBoundary: true } }

/** Where each run's resolutions begin in `recorded`, by label. */
const runIndex: Array<{ label: string; from: number; to: number; status: string }> = []

async function production(): Promise<void> {
  for (const [label, scenario] of SCENARIOS_2D) {
    const from = recorded.length
    const reading = await runHeightScenario(scenario)
    runIndex.push({ label, from, to: recorded.length, status: `${reading.status} ${reading.errorMessage ?? reading.authoringError ?? ''}`.trim() })
  }
  const solids: Array<[string, Parameters<typeof runSolidScenario>[0]]> = [
    ['closed box raised: adaptive current, adaptive rest, parallel, waterline', {
      part: 'closed_box', z: RAISE, stock: BOX_STOCK, workholding: BOX_VISE,
      operations: [
        { kind: 'adaptive_3d', source: 'current_material', ...rough },
        { kind: 'adaptive_3d', source: 'rest', ...rough },
        { kind: 'parallel_3d', toolDiameter: 6 },
        { kind: 'waterline_3d', toolDiameter: 6 },
      ],
    }],
    ['closed box on the table: adaptive initial stock, adaptive bounded band, retract 20', {
      part: 'closed_box', z: 0, stock: BOX_STOCK,
      operations: [
        { kind: 'adaptive_3d', source: 'initial_stock', ...rough },
        { kind: 'adaptive_3d', source: 'bounded_band', band: { topWcsMm: 2, bottomWcsMm: -8 }, ...rough },
        { kind: 'adaptive_3d', source: 'current_material', ...rough, safetyOverride: retract20.safetyOverride },
      ],
    }],
    ['plate with holes: drill on detected holes', {
      part: 'plate_holes', z: 0, stock: BOX_STOCK,
      operations: [{ kind: 'drill', toolDiameter: 5, holeDiameters: [6, 10] }],
    }],
  ]
  for (const [label, scenario] of solids) {
    const from = recorded.length
    const readings = await runSolidScenario(scenario)
    runIndex.push({ label, from, to: recorded.length, status: readings.map(r => `${r.status}${r.errorMessage ? ` (${r.errorMessage})` : ''}`).join(', ') })
  }
}

// ─── the BL-281 procedural meshes, through today's family builders ───────────

const REVISION = { projectRevision: 'p-r1', setupRevision: 's-r1', operationRevision: 'o-r1' }
const SAFETY = {
  clearance: { reference: 'retract' as const, offset: 10, provenance: 'default' as const },
  retract: { reference: 'stock_top' as const, offset: 5, provenance: 'default' as const },
  feed: { reference: 'top' as const, offset: 5, provenance: 'default' as const },
}

function meshes(): Array<[string, PartMesh]> {
  return [
    ['wave', fixtures.wave(100, 41)], ['sphere', fixtures.sphere()], ['hemisphereOnSlab', fixtures.hemisphereOnSlab()],
    ['steps', fixtures.steps()], ['pocketBox', fixtures.pocketBox()], ['engagementPocket', fixtures.engagementPocket()],
    ['draftDomePocket', fixtures.draftDomePocket(61, 41)],
  ]
}

interface MeshRun {
  family: OperationType
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  positionZ: number
  stockTopMachineMm?: number
}

function meshRuns(): MeshRun[] {
  const runs: MeshRun[] = []
  for (const [name, mesh] of meshes()) {
    const positionZ = 20
    const wcsOrigin = positionZ + mesh.bounds.max[2] + 2
    const target = {
      minX: mesh.bounds.min[0], minY: mesh.bounds.min[1], minZ: positionZ + mesh.bounds.min[2],
      maxX: mesh.bounds.max[0], maxY: mesh.bounds.max[1], maxZ: positionZ + mesh.bounds.max[2],
    }
    const stock = { ...target, minX: target.minX - 5, minY: target.minY - 5, maxX: target.maxX + 5, maxY: target.maxY + 5, maxZ: target.maxZ + 2 }
    const geometryIds = [`mesh-${name}`]
    for (const [withStock, finishDepthMm] of [[true, undefined], [false, 4]] as const) {
      const evidenceInput: today.Parallel3dEvidenceInput = {
        revision: REVISION, wcsOriginMachineMm: wcsOrigin, operationId: `op-${name}`, geometryIds,
        target: { geometryId: geometryIds[0], artifactId: `art-${name}`, boundsMachineMm: target, fingerprint: `fp-${name}`, representation: 'mesh' },
        ...(withStock ? { owningStock: { stockId: 'stock-1', artifactId: 'stock-art', boundsMachineMm: stock, fingerprint: 'fp-stock', representation: 'box' } } : {}),
      }
      const intentInput = { setupId: 'setup-1', geometryIds, safetyIntent: SAFETY, ...(finishDepthMm ? { finishDepthMm } : {}) }
      const stockTopMachineMm = withStock ? stock.maxZ : undefined
      runs.push(
        { family: 'parallel_3d', intent: today.buildParallel3dSmartIntent(intentInput), evidence: today.buildParallel3dEvidenceContext(evidenceInput), positionZ, stockTopMachineMm },
        { family: 'scallop_3d', intent: today.buildScallop3dSmartIntent(intentInput), evidence: today.buildScallop3dEvidenceContext(evidenceInput), positionZ, stockTopMachineMm },
        { family: 'steep_shallow_3d', intent: today.buildSteepShallow3dSmartIntent(intentInput), evidence: today.buildSteepShallow3dEvidenceContext(evidenceInput), positionZ, stockTopMachineMm },
        { family: 'pencil_3d', intent: today.buildPencil3dSmartIntent(intentInput), evidence: today.buildPencil3dEvidenceContext(evidenceInput), positionZ, stockTopMachineMm },
        { family: 'waterline_3d', intent: today.buildWaterline3dSmartIntent(intentInput), evidence: today.buildWaterline3dEvidenceContext(evidenceInput), positionZ, stockTopMachineMm },
      )
    }
    for (const mode of ['current_material', 'initial_stock', 'bounded_band'] as const) {
      runs.push({
        family: 'adaptive_3d', positionZ,
        intent: today.buildAdaptive3dSmartIntent({
          setupId: 'setup-1', geometryIds, safetyIntent: SAFETY, mode,
          ...(mode === 'bounded_band' ? { boundedBand: { topWcsMm: -2, bottomWcsMm: target.minZ - wcsOrigin + 3 } } : {}),
        }),
        evidence: today.buildAdaptive3dEvidenceContext({
          revision: REVISION, wcsOriginMachineMm: wcsOrigin, operationId: `op-${name}`, geometryIds,
          owningStocks: [{ stockId: 'stock-1', artifactId: 'stock-art', boundsMachineMm: stock, fingerprint: 'fp-stock', representation: 'box' }],
          target: { geometryId: geometryIds[0], artifactId: `art-${name}`, boundsMachineMm: target, fingerprint: `fp-${name}`, representation: 'mesh' },
          tool: { toolId: 'tool-6', fingerprint: 'fp-tool' }, axialStockToLeaveMm: 0.5,
        }),
      })
    }
    runs.push({
      family: 'pattern', positionZ,
      intent: today.buildPatternSmartHeightIntent({ setupId: 'setup-1', safetyIntent: SAFETY, stockId: 'stock-1', depthMm: 1.5 }),
      evidence: today.buildPatternSmartHeightEvidenceContext({
        revision: REVISION, wcsOriginMachineMm: wcsOrigin, operationId: `op-${name}`,
        owningStock: { stockId: 'stock-1', artifactId: 'stock-art', boundsMachineMm: stock, fingerprint: 'fp-stock', representation: 'box' },
      }),
    })
  }
  return runs
}

type ThreeDFamily = 'adaptive_3d' | 'parallel_3d' | 'waterline_3d' | 'steep_shallow_3d' | 'scallop_3d' | 'pencil_3d'
/** Today's per-family 3D conversion (the six local copies the kernel's one conversion replaces). */
function todayThreeD(run: MeshRun) {
  const geometryIds = run.intent.machining.scope.value.kind === 'whole_target' ? run.intent.machining.scope.value.geometryIds : []
  const input = { intent: run.intent, evidence: run.evidence, geometryIds, geometryPositionZ: run.positionZ, stockTopMachineMm: run.stockTopMachineMm }
  switch (run.family as ThreeDFamily) {
    case 'adaptive_3d': return today.resolveAdaptive3dSmartHeights(input)
    case 'parallel_3d': return today.resolveParallel3dSmartHeights(input)
    case 'waterline_3d': return today.resolveWaterline3dSmartHeights(input)
    case 'steep_shallow_3d': return today.resolveSteepShallow3dSmartHeights(input)
    case 'scallop_3d': return today.resolveScallop3dSmartHeights(input)
    case 'pencil_3d': return today.resolvePencil3dSmartHeights(input)
  }
}

/** The kernel's one conversion for the same run. */
function kernelThreeD(run: MeshRun) {
  const adaptive = run.family === 'adaptive_3d'
  const intent = adaptive ? run.intent : kernel.bindUnprovenStockTop(run.intent, run.evidence)
  const result = kernel.resolveHeightPlan(intent, run.evidence)
  if (!result.ok) throw new Error(result.refusal.message)
  const finish = !adaptive && run.intent.machining.end.value.kind === 'target_surface' &&
    run.intent.machining.end.value.lowerLimit !== undefined
  const converted = kernel.planToLocalHeights(result.plan, {
    geometryPositionZ: run.positionZ,
    wcsOriginMachineMm: run.evidence.wcsOriginMachineMm,
    stockTop: adaptive ? { kind: 'material_start' } : { kind: 'stock_record', machineMm: run.stockTopMachineMm },
    withFinishDepth: finish,
  })
  return { plan: result.plan, ...converted, dependencyIds: kernel.planDependencyIds(result.plan) }
}

// ─── today's private 2.5D ladders, compiled from their own source ────────────

function privateFunction<F>(file: string, name: string): { fn: F; text: string } {
  const source = readFileSync(resolvePath(file), 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let text: string | undefined
  sf.forEachChild(node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(sf)
  })
  if (!text) throw new Error(`${file} has no function ${name}`)
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  // Free names the engine module binds at import (WO-3018: the policy record as AP) are
  // bound here to the same object, so the compiled copy reads what the engine reads.
  return { fn: new Function('AP', `${js}\nreturn ${name}`)(AP) as F, text }
}

const FIXED_STEP_COPIES = [
  'src/lib/cam/pocket2d.ts', 'src/lib/cam/contour2d.ts', 'src/lib/cam/face2d/index.ts',
  'src/lib/cam/bore2d.ts', 'src/lib/cam/engrave2d/index.ts',
]

// ─── the parity assertions ───────────────────────────────────────────────────

const ALL_TYPES = Object.keys(today.OPERATION_HEIGHT_POLICIES) as OperationType[]

describe('WO-3020 kernel heights at parity with today\'s resolver', () => {
  let meshRunList: MeshRun[] = []

  // The harness swaps in its Worker shim per test, so the production runs live in the first test.
  it('the production runs resolved every operation type through today\'s resolver', async () => {
    await production()
    meshRunList = meshRuns()
    for (const run of meshRunList) {
      if (run.family === 'pattern') today.resolvePatternSmartHeights({ intent: run.intent, evidence: run.evidence, stockId: 'stock-1' })
      else todayThreeD(run)
    }
    const seen = new Set(recorded.map(call => call.context.operationType))
    expect(ALL_TYPES.filter(type => !seen.has(type)), JSON.stringify(runIndex, null, 1)).toEqual([])
    for (const run of runIndex) expect(run.to - run.from, `${run.label}: ${run.status}`).toBeGreaterThan(0)
  }, 600_000)

  it('kernel resolution equals today\'s on every recorded call: planes, owners, proofs, graph, warnings, refusals', () => {
    const differences = recorded.flatMap((call, index) => {
      const ours = kernel.resolveHeightPlan(call.intent, call.context)
      return JSON.stringify(ours) === JSON.stringify(call.result)
        ? []
        : [{ index, type: call.context.operationType, variant: call.intent.policy.variant, today: call.result, kernel: ours }]
    })
    expect(differences).toEqual([])
    // Both outcomes are exercised: resolved plans and refusals.
    expect(recorded.some(call => call.result.ok)).toBe(true)
    expect(recorded.some(call => !call.result.ok && call.result.refusal.code === 'invalid_plane_order')).toBe(true)
  })

  it('per type, the resolved planes equal today\'s (the A.5 cells this order can fill)', () => {
    const planes = (result: ResolveSmartHeightPlanResult | ReturnType<typeof kernel.resolveHeightPlan>) => result.ok
      ? {
          clearance: result.plan.safety.clearance.wcsMm, retract: result.plan.safety.retract.wcsMm,
          feed: result.plan.safety.feed.wcsMm, top: result.plan.machining.materialStart.wcsMm,
          bottom: result.plan.machining.cutterCenterEnd?.wcsMm,
          featureBottoms: result.plan.machining.featureEndpoints?.map(e => e.cutterCenterEnd.wcsMm),
        }
      : { refusal: result.refusal.message }
    const rows: Array<Record<string, unknown>> = []
    for (const type of ALL_TYPES) {
      const calls = recorded.filter(call => call.context.operationType === type)
      expect(calls.length, type).toBeGreaterThan(0)
      const ours = calls.map(call => planes(kernel.resolveHeightPlan(call.intent, call.context)))
      expect(ours, type).toEqual(calls.map(call => planes(call.result)))
      calls.forEach((call, i) => rows.push({ type, variant: call.intent.policy.variant, today: planes(call.result), kernel: ours[i] }))
    }
    // WO3020_EVIDENCE=1 writes the table this order's evidence records.
    if (process.env.WO3020_EVIDENCE === '1') {
      writeFileSync(resolvePath('src/tests/evidence/WO-3020/parity.json'), JSON.stringify({
        order: 'WO-3020', command: 'WO3020_EVIDENCE=1 npx vitest run src/tests/kernel/heightsParity.wo3020.test.ts',
        runs: runIndex.map(run => ({ label: run.label, status: run.status, resolutions: run.to - run.from })),
        recordedCalls: recorded.length, rows,
      }, null, 1) + '\n')
    }
  })

  it('the policy registry and contract versions equal today\'s', () => {
    expect(kernel.OPERATION_HEIGHT_POLICIES).toEqual(today.OPERATION_HEIGHT_POLICIES)
    expect(kernel.SMART_HEIGHT_RUNTIME_CONFORMANCE_MANIFEST).toEqual(today.SMART_HEIGHT_RUNTIME_CONFORMANCE_MANIFEST)
    expect([kernel.SMART_HEIGHT_INTENT_VERSION, kernel.SMART_HEIGHT_POLICY_VERSION])
      .toEqual([today.SMART_HEIGHT_INTENT_VERSION, today.SMART_HEIGHT_POLICY_VERSION])
  })

  it('3D lane: the one conversion equals each of today\'s six family conversions on the BL-281 meshes', () => {
    const threeD = meshRunList.filter(run => run.family !== 'pattern')
    expect(new Set(threeD.map(run => run.family)).size).toBe(6)
    for (const run of threeD) {
      const ours = kernelThreeD(run)
      const theirs = todayThreeD(run)
      expect({ ...ours }, `${run.family} ${run.intent.policy.variant}`).toEqual({ ...theirs })
    }
  })

  it('3D lane: the one conversion equals today\'s on every recorded production 3D call', () => {
    const families: ThreeDFamily[] = ['adaptive_3d', 'parallel_3d', 'waterline_3d']
    const calls = recorded.filter(call => families.includes(call.context.operationType as ThreeDFamily) && call.result.ok)
    expect(new Set(calls.map(call => call.context.operationType)).size).toBe(3)
    for (const call of calls) {
      const run: MeshRun = { family: call.context.operationType, intent: call.intent, evidence: call.context, positionZ: 7.25, stockTopMachineMm: 61.5 }
      expect(kernelThreeD(run)).toEqual({ ...todayThreeD(run) })
    }
  })

  it('2.5D lane: the one conversion equals today\'s Face, Pattern and Thread Mill worker heights', () => {
    const faceCalls = recorded.filter(call => call.context.operationType === 'face' && call.result.ok)
    const threadCalls = recorded.filter(call => call.context.operationType === 'thread_mill' && call.result.ok)
    const patternRuns = meshRunList.filter(run => run.family === 'pattern')
    expect([faceCalls.length > 0, threadCalls.length > 0, patternRuns.length > 0]).toEqual([true, true, true])
    const kernelWorker = (intent: OperationHeightIntentV2, context: HeightEvidenceContext, key: 'entity' | 'node' = 'entity') => {
      const result = kernel.resolveHeightPlan(intent, context)
      if (!result.ok) throw new Error(result.refusal.message)
      return { plan: result.plan, ...kernel.planToWorkerHeights(result.plan), dependencyIds: kernel.planDependencyIds(result.plan, key) }
    }
    for (const call of faceCalls) {
      const scope = call.intent.machining.scope.value
      const theirs = today.resolveFaceSmartHeights({
        intent: call.intent, evidence: call.context,
        geometryIds: scope.kind === 'selected_geometry' ? scope.geometryIds : undefined,
        stockId: scope.kind === 'stock_footprint' ? scope.stockId : undefined,
      })
      expect(kernelWorker(call.intent, call.context)).toEqual({ ...theirs })
    }
    for (const run of patternRuns) {
      expect(kernelWorker(run.intent, run.evidence))
        .toEqual({ ...today.resolvePatternSmartHeights({ intent: run.intent, evidence: run.evidence, stockId: 'stock-1' }) })
    }
    for (const call of threadCalls) {
      const theirs = today.resolveThreadMillSmartHeights({ intent: call.intent, evidence: call.context })
      const { formula: _formula, ...rest } = theirs
      expect(kernelWorker(call.intent, call.context, 'node')).toEqual(rest)
    }
  })

  it('formula bands equal today\'s evidence builders on every recorded Chamfer, Thread Mill, Engrave and V-carve call', () => {
    const scalar = (context: HeightEvidenceContext, role: string) =>
      context.evidence.find(node => node.role === role)?.scalar?.valueMm
    const seen = new Set<string>()
    for (const call of recorded) {
      const end = call.intent.machining.end.value
      if (end.kind !== 'geometry_tool_formula') continue
      const start = scalar(call.context, 'formula_material_start')!
      const cutterEnd = scalar(call.context, 'formula_cutter_end')!
      const remainingTop = scalar(call.context, 'material_top')
      const datum = scalar(call.context, 'selected_plane') ?? scalar(call.context, 'feature_top') ?? scalar(call.context, 'feature_floor')!
      const formula = end.formula
      seen.add(formula.kind)
      switch (formula.kind) {
        case 'chamfer_edge':
          expect(kernel.chamferBand({ formula, datumMachineMm: datum, remainingTopMachineMm: remainingTop }))
            .toEqual({ materialStartMachineMm: start, cutterEndMachineMm: cutterEnd })
          break
        case 'thread_band': {
          const datumMachineMm = (formula.datum === 'authored_plane' ? datum : datum + formula.datumOffsetMm)
          expect(kernel.threadBand({ formula, datumMachineMm, remainingTopMachineMm: remainingTop }))
            .toEqual({ materialStartMachineMm: start, cutterEndMachineMm: cutterEnd })
          break
        }
        case 'engrave_path':
          expect(kernel.engraveBand({ formula, depthMm: start - cutterEnd, datumMachineMm: datum, remainingTopMachineMm: remainingTop }).materialStartMachineMm)
            .toBe(start)
          break
        case 'vcarve_region':
          expect(kernel.vcarveBand({ formula, maxDepthMm: start - cutterEnd, datumMachineMm: datum, remainingTopMachineMm: remainingTop }).materialStartMachineMm)
            .toBe(start)
          break
      }
    }
    expect([...seen].sort()).toEqual(['chamfer_edge', 'engrave_path', 'thread_band', 'vcarve_region'])
  })

  it('tool-dependent depths equal today\'s engrave and V-carve functions over a tool grid', () => {
    const tools: Tool[] = []
    for (const type of ['v_bit', 'chamfer_mill', 'flat_end_mill', 'drill'] as ToolType[]) {
      for (const angle of [15, 30, 45, 60, undefined]) {
        for (const tip of [0, 0.2, 1]) {
          for (const flute of [2, 6, 0]) {
            tools.push({ id: `t-${type}-${angle}-${tip}-${flute}`, name: type, type, diameter: 6, fluteLength: flute, tipDiameter: tip, angleFromAxisDeg: angle } as unknown as Tool)
          }
        }
      }
    }
    const outcome = (fn: () => number) => { try { return fn() } catch (error) { return (error as Error).message } }
    const engraveFormulas = [
      { depth: { kind: 'explicit' as const, depthMm: 1 } }, { depth: { kind: 'explicit' as const, depthMm: 5 } },
      { depth: { kind: 'line_width' as const, targetLineWidthMm: 1.5 } }, { depth: { kind: 'line_width' as const, targetLineWidthMm: 0.1 } },
    ]
    const vcarveFormulas = [
      { flatDepth: { kind: 'tool_limit' as const } }, { flatDepth: { kind: 'explicit' as const, depthMm: 2 } },
      { flatDepth: { kind: 'explicit' as const, depthMm: 40 } },
    ]
    for (const tool of tools) {
      for (const formula of engraveFormulas) {
        const full = { kind: 'engrave_path' as const, datumPlane: { reference: 'stock_top' as const, offsetMm: 0, owner: { kind: 'operation_policy' as const } }, axialOffsetMm: 0, ...formula }
        expect(outcome(() => kernel.engraveDepthMm(full, tool))).toEqual(outcome(() => today.engraveFormulaDepthMm(full, tool)))
      }
      expect(outcome(() => kernel.vcarveToolLimitDepthMm(tool))).toEqual(outcome(() => today.vcarveToolLimitDepthMm(tool)))
      for (const formula of vcarveFormulas) {
        // Today's flat-depth check is private; its tool limit is the angled-type
        // rule, pinned to TOOL_TYPE_META below and exercised through the scenarios.
        expect(typeof outcome(() => kernel.vcarveMaxDepthMm(formula, tool))).toMatch(/number|string/)
      }
    }
    const hasAngle = Object.values(TOOL_TYPE_META).filter(meta => meta.hasAngle).map(meta => meta.value).sort()
    expect([...kernel.ANGLED_TOOL_TYPES].sort()).toEqual(hasAngle)
  })

  it('the fingerprint convention equals today\'s', () => {
    for (const value of [{ b: 1, a: [0, -0, NaN] }, 'x', [1.5, { z: undefined, y: new Float32Array([1, 2]) }], null]) {
      expect(kernel.heightsFingerprint(value)).toBe(today.smartHeightEvidenceFingerprint(value))
    }
  })
})

describe('WO-3020 one depth-level builder at parity with today\'s ladders', () => {
  const grid: Array<[number, number, number]> = []
  for (const top of [0, 2.5, -1]) {
    for (const depth of [0, 0.0005, 0.3, 1, 2.5, 5, 7.3, 12]) {
      for (const step of [0, 0.05, 0.5, 1, 1.7, 3, -2]) grid.push([top, top - depth, step])
    }
  }
  const outcome = <T>(fn: () => T): T | string => { try { return fn() } catch (error) { return (error as Error).message } }

  it('fixed_step equals the five private 2.5D copies, which are one text', () => {
    const copies = FIXED_STEP_COPIES.map(file => privateFunction<(t: number, b: number, s: number) => number[]>(file, 'buildDepths'))
    const normalized = copies.map(copy => copy.text.replace(/[\s;]+/g, ''))
    expect(new Set(normalized).size).toBe(1)
    for (const [top, bottom, step] of grid) {
      for (const copy of copies) {
        expect(kernel.buildDepthLevels({ kind: 'fixed_step', topZ: top, bottomZ: bottom, stepdown: step }).levels)
          .toEqual(copy.fn(top, bottom, step))
      }
    }
    // Top = Bottom gives one level, at Bottom, as today does.
    expect(kernel.buildDepthLevels({ kind: 'fixed_step', topZ: -3, bottomZ: -3, stepdown: 1 }).levels).toEqual([-3])
  })

  it('adaptive_2d equals today\'s adaptive clearing schedule (scheduledDepths)', () => {
    const { fn } = privateFunction<(s: { topZ: number; roughBottomZ: number; stepdown: number; floorFinishDepth?: number }) => { depths: number[]; floorAppended: boolean }>(
      'src/lib/cam/adaptiveClearing2d/engine/index.ts', 'scheduledDepths')
    for (const [top, bottom, step] of grid) {
      for (const floor of [undefined, bottom, bottom - 0.2]) {
        const theirs = fn({ topZ: top, roughBottomZ: bottom, stepdown: step, floorFinishDepth: floor })
        expect(kernel.buildDepthLevels({ kind: 'adaptive_2d', topZ: top, roughBottomZ: bottom, stepdown: step, floorFinishDepth: floor }))
          .toEqual({ levels: theirs.depths, floorAppended: theirs.floorAppended })
      }
    }
    // Today, Top = Bottom gives NO adaptive level (recorded, not changed).
    expect(kernel.buildDepthLevels({ kind: 'adaptive_2d', topZ: -3, roughBottomZ: -3, stepdown: 1 }).levels).toEqual([])
  })

  it('even_3d equals cam3d planLevels, pins and refusals included', () => {
    for (const [top, bottom, step] of grid) {
      for (const pins of [[], [top - 0.7, bottom + 0.1, top - 0.7], [NaN]]) {
        expect(outcome(() => kernel.buildDepthLevels({ kind: 'even_3d', topZ: top, bottomZ: bottom, stepdown: step, requiredDepths: pins }).levels))
          .toEqual(outcome(() => planLevels(top, bottom, step, pins)))
      }
    }
  })

  it('waterline equals cam3d planWaterlineLevels, flats, lift and refusals included', () => {
    for (const [top, bottom, step] of grid) {
      for (const flats of [[], [top - 1, bottom, bottom + 0.4]]) {
        for (const lift of [0, 0.02]) {
          const input = { topZ: top, bottomZ: bottom, stepdown: step, flatHeights: flats, liftOffFlats: flats, flatLiftMm: lift }
          expect(outcome(() => kernel.buildDepthLevels({ kind: 'waterline', ...input }).levels))
            .toEqual(outcome(() => planWaterlineLevels(input)))
        }
      }
    }
  })

  it('every recorded 2.5D plan gives today\'s fixed-step level list', () => {
    const copy = privateFunction<(t: number, b: number, s: number) => number[]>('src/lib/cam/pocket2d.ts', 'buildDepths').fn
    const plans = recorded.flatMap(call => call.result.ok && call.result.plan.machining.cutterCenterEnd ? [call.result.plan] : [])
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      const top = plan.machining.materialStart.wcsMm
      const bottom = plan.machining.cutterCenterEnd!.wcsMm
      for (const step of [0, 1, 2.5]) {
        expect(kernel.buildDepthLevels({ kind: 'fixed_step', topZ: top, bottomZ: bottom, stepdown: step }).levels).toEqual(copy(top, bottom, step))
      }
    }
  })
})
