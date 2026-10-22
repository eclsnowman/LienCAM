// Real current-engine integration, through the same store entry point as Generate.
// Only worker transport, browser persistence and cached mesh acquisition are replaced;
// no builder result, geometry planner, height resolver or refusal is mocked.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { createHeadlessPlanner } from '../../kernel/headless'
import { OPERATION_REGISTRY, operationTypes } from '../../kernel/registry'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { KernelPlan, PlanningInput } from '../../kernel/planning'
import type { Operation, OperationType, Project } from '../../types'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { defaultPatternParams } from '../../kernel/parameterDefaults'
import { buildPatternSmartHeightIntent } from '../../lib/cam/smartHeights'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { typedMock } from '../support/typedMock'
import { chainScene } from '../benchmark/chainRunner'
import { alpha3Chains, CHAINS, rowKey, toolById, type BenchmarkChain } from '../benchmark/registry'

const evidence = 'src/tests/evidence/WO-2905'
const oldLive = JSON.parse(readFileSync('src/tests/evidence/WO-2904/baseline-current.json', 'utf8')) as {
  rows: { key: string; opType: OperationType; status?: string; planMs: { value: number } }[]
}
const chains = alpha3Chains()
function fixture(type: OperationType): { chain: BenchmarkChain; step: BenchmarkChain['steps'][number] } {
  if (type === 'pattern') {
    // WO-3001: no benchmark chain cuts a pattern yet. Run the default pattern
    // (the rose spiral at the WCS origin) in a real engrave task's project.
    const base = fixture('engrave')
    return { chain: base.chain, step: { ...base.step, type, params: structuredClone(defaultPatternParams) as unknown as Record<string, unknown> } }
  }
  // WO-3025: with its island a hole the declared H-pocket plans nothing (WO-3019 item 2, owned by WO-3024).
  if (type === 'adaptive_clearing_2d') {
    const chain = chains.find(chain => chain.id === 'engagement-pocket-adaptive_clearing_2d-default')!
    return { chain, step: chain.steps[0] }
  }
  // Select a real, previously runnable task, rather than manufacture engine payloads.
  const rows = oldLive.rows.filter(row => row.opType === type && row.status === 'ready')
    .sort((a, b) => a.planMs.value - b.planMs.value)
  for (const row of rows) for (const chain of chains) {
    const step = chain.steps.find(step => rowKey(chain, step) === row.key)
    if (step) return { chain, step }
  }
  const chain = type === 'pencil_3d'
    ? CHAINS.find(chain => chain.steps.some(step => step.type === type))!
    : chains.find(chain => chain.alpha3?.project && chain.steps.some(step => step.type === type))!
  return { chain, step: chain.steps.find(step => step.type === type)! }
}

const observations: object[] = []
let client: Cam3dClient | undefined
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
afterEach(async () => {
  await client?.dispose()
  client = undefined
  vi.doUnmock('../../cam3d/integration/appClient')
  vi.doUnmock('../../cam3d/integration/parallel3dOperation')
  vi.doUnmock('../../lib/stepCache')
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function inputFor(chain: BenchmarkChain, step: BenchmarkChain['steps'][number]): Promise<PlanningInput> {
  vi.resetModules()
  const channel: WorkerLike = {
    onmessage: null, onerror: null,
    postMessage: message => dispatcher.handle(message as Cam3dRequest),
    terminate: () => {},
  }
  const dispatcher = new Cam3dDispatcher(new BvhKernel(), (message: Cam3dResponse) =>
    channel.onmessage?.({ data: message } as MessageEvent))
  client = new Cam3dClient(channel)
  vi.doMock('../../cam3d/integration/appClient', async importOriginal => typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...await importOriginal<typeof import('../../cam3d/integration/appClient')>(),
    getCam3dClient: () => client!,
  }))
  let project: Project
  let setup: PlanningInput['setup']
  let authored: Operation
  if (chain.alpha3?.project) {
    project = structuredClone(chain.alpha3.project)
    setup = project.setups.find(setup => setup.id === step.authoredSetupId)!
    authored = structuredClone(step.authoredOperation!)
  } else {
    const scene = await chainScene({ ...chain, steps: [step] })
    vi.doMock('../../cam3d/integration/parallel3dOperation', async importOriginal => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
      ...await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>(),
      acquirePartMesh: async () => scene.mesh,
    }))
    vi.doMock('../../lib/stepCache', async importOriginal => typedMock<typeof import('../../lib/stepCache')>({
      ...await importOriginal<typeof import('../../lib/stepCache')>(),
      loadCachedStep: async () => new ArrayBuffer(8),
    }))
    const { useCamStore } = await import('../../store')
    project = { ...useCamStore.getState().project, geometry: [scene.geometry],
      setups: scene.setups, stocks: [scene.physicalStock], sceneStock: scene.sceneStock,
      toolLibrary: scene.tools, modelItemPlacements: scene.modelItemPlacements }
    setup = project.setups[0]
    authored = setup.operations[0]
  }
  const spec = toolById(step.toolId)
  const tool = spec.libraryTool ?? project.toolLibrary.find(tool => tool.id === step.toolId)!
  const operation = createHeadlessPlanner(async () => { throw new Error('construction must not plan') }).create(
    step.type, { id: step.id, name: step.id, toolId: tool.id }, {
      params: step.params, heights: authored.heights, passes: authored.passes,
      linking: authored.linking, geometrySelections: authored.geometrySelections,
      smartHeight: step.type === 'pattern'
        ? { kind: 'smart_v2', intent: buildPatternSmartHeightIntent({ setupId: setup.id,
            safetyIntent: authored.heights.heightIntent ?? defaultHeightIntent(),
            stockId: (await import('../../store')).setupProvenStockId(setup, project) ?? '', depthMm: 0.15 }) }
        : authored.smartHeight,
    })
  // Same fresh-task envelope as chainRunner.makeProjectScene: the added text
  // trace has no persisted authority, while saved operations keep theirs.
  if (!operation.smartHeight) operation.smartHeight = stampSmartHeightAuthority(operation, {
    setupId: setup.id, geometryIds: [...new Set(operation.geometrySelections.map(id => id.split('~')[0]))],
    stockId: setup.wcs.stockId,
  }).smartHeight
  setup.operations = [operation]
  project.toolLibrary = [...project.toolLibrary.filter(candidate => candidate.id !== tool.id), tool]
  project.activeSetupId = setup.id
  return { operation, project, setup, tool }
}

it.each(operationTypes)('WO-2905 creates, validates and plans %s through real Generate with no DOM or viewport', async type => {
  expect(typeof document).toBe('undefined')
  expect(typeof window).toBe('undefined')
  const { chain, step } = fixture(type)
  const input = await inputFor(chain, step)
  // In-process transport uses the real toolpathWorker message entry point.
  let deliver: ((message: WorkerResponseMsg) => void) | undefined
  const workerSelf: { postMessage: (message: WorkerResponseMsg) => void;
    onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null } = {
    postMessage: message => deliver?.(message), onmessage: null,
  }
  vi.stubGlobal('self', workerSelf)
  vi.stubGlobal('Worker', class {
    onmessage: ((event: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((error: unknown) => void) | null = null
    postMessage(request: WorkerRequestMsg) {
      deliver = message => this.onmessage?.({ data: structuredClone(message) })
      void workerSelf.onmessage!({ data: structuredClone(request) }).catch(error => this.onerror?.(error))
    }
    terminate() {}
  })
  await import('../../lib/cam/toolpathWorker')
  const { useCamStore } = await import('../../store')
  const api = createHeadlessPlanner(async currentInput => {
    useCamStore.setState({ project: currentInput.project, toolLibrary: currentInput.project.toolLibrary, toolpathBatch: null })
    await useCamStore.getState().computeOperationToolpath(currentInput.setup.id, currentInput.operation.id)
    const actual = useCamStore.getState().project.setups.find(setup => setup.id === currentInput.setup.id)!
      .operations.find(operation => operation.id === currentInput.operation.id)!
    observations.push({ type, chain: chain.id, step: step.id, status: actual.status,
      moveCount: actual.toolpathMoves?.length ?? 0, operatorText: actual.errorMessage ?? '',
      hasResolvedHeights: Boolean(actual.resolvedHeights), hasResolvedHeightPlan: Boolean(actual.resolvedHeightPlan) })
    writeFileSync(`${evidence}/headless-current.json`, JSON.stringify({ source,
      environment: 'Node; window and document undefined; no viewport', observations }, null, 2) + '\n')
    if (actual.status !== 'ready') throw new Error(actual.errorMessage ?? `Current engine status ${actual.status}`)
    expect(actual.resolvedHeights).toBeDefined()
    expect(actual.resolvedHeightPlan).toBeDefined()
    return { moves: actual.toolpathMoves!, resolvedHeights: actual.resolvedHeights!,
      resolvedHeightPlan: actual.resolvedHeightPlan!, computeTimeMs: actual.computeTimeMs ?? 0 } satisfies KernelPlan
  })
  expect(api.validate(type, { operationName: input.operation.name,
    available: OPERATION_REGISTRY[type].knowledge.required }).status).toBe('PROCEED')
  // Face once refused here (no viewport footprint); auto-stock now resolves headless, so it plans
  // like every other type (the operator 2026-10-21 card Q-FACE-NOW-PLANS-WITH-NO-VIEWPORT: "Update the test").
  const result = await api.plan(input)
  expect(result.moves.length).toBeGreaterThan(0)
  expect(result.moves.every(move => Number.isFinite(move.x) && Number.isFinite(move.y) && Number.isFinite(move.z))).toBe(true)
  expect(typeof document).toBe('undefined')
  expect(typeof window).toBe('undefined')
}, 180_000)
