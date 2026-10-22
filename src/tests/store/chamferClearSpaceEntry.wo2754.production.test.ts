// WO-2754: adapt the preserved passive production trace. Only the new policy
// changes in memory; original diagnosis receipts and project stay untouched.
import { createHash } from 'node:crypto'
import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { parseGcode } from '../../lib/gcode/parse'
import { toWork } from '../../lib/post/coords'

const source = resolve('examples/01-fixture-plate/fixture-plate.camproject')
// WO-2784: the original pin 3e87c9f1caac03bb9b07c7b3f4b10e1602fcbec0a37eeaaf7928e3935e568036
// was the CRLF rendering of committed blob c738102770 (WO-2515); an LF
// checkout (Linux, no autocrlf) holds the same content as a1b089fc. Hash the
// LF-normalized text so the pin names the committed content on every host.
const expectedSourceSha256 = 'a1b089fcf7ca1f580784da20dd8b68ce3cbe7c97b2d1b4256e9648dbea31350c'
const bytes = new Map<string, ArrayBuffer>()

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, value: ArrayBuffer) => { bytes.set(id, value) }),
  loadCachedSTL: vi.fn(async (id: string) => bytes.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { bytes.delete(id) }),
}))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => [...mem.keys()][index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  },
  configurable: true,
})

const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../store')
const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')

type Message = { type: string; [key: string]: unknown }
const dispatched: Message[] = []
const completed: Message[] = []
const host = globalThis as unknown as { window?: Record<string, unknown>; Worker: unknown }
host.window ??= {}
const children = new Set<ProductionWorker>()
// Match real Worker scheduling: actual store dispatch stays here, while the
// real toolpathWorker handler executes off-thread through existing vite-node.
// Advanced IPC preserves typed arrays/undefined; no request/result substitution.
class ProductionWorker {
  onmessage: ((event: { data: Message }) => void) | null = null
  onerror: ((error: Error) => void) | null = null
  private child: ChildProcess
  private ready = false
  private stopping = false
  private failed = false
  private queued: Message[] = []
  readonly closed: Promise<void>
  constructor() {
    this.child = fork(resolve('node_modules/vite-node/vite-node.mjs'),
      [resolve('src/tests/evidence/WO-2754/production-worker-child.ts')], {
        cwd: process.cwd(), execArgv: [], serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
    children.add(this)
    this.closed = new Promise(resolveClose => this.child.once('close', () => {
      children.delete(this)
      resolveClose()
    }))
    this.child.stdout?.on('data', data => process.stdout.write(data))
    this.child.stderr?.on('data', data => process.stderr.write(data))
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => {
      if (!this.stopping) this.fail(new Error(`Production worker exited before termination: ${code}/${signal}`))
    })
    this.child.on('message', wire => {
      if (this.stopping) return
      const value = wire as { kind?: string; message?: Message; error?: string }
      if (value.kind === 'ready') {
        this.ready = true
        for (const message of this.queued.splice(0)) this.send(message)
      } else if (value.kind === 'response' && value.message) {
        if (value.message.type === 'TOOLPATH_COMPLETE') completed.push(structuredClone(value.message))
        this.onmessage?.({ data: value.message })
      } else this.fail(new Error(value.error ?? 'Unexpected production worker protocol message'))
    })
  }
  private fail(error: Error) {
    if (this.failed || this.stopping) return
    this.failed = true
    this.onerror?.(error)
    this.terminate()
  }
  private send(message: Message) {
    this.child.send({ kind: 'request', message }, error => { if (error) this.fail(error) })
  }
  postMessage(data: Message): void {
    const message = structuredClone(data)
    if (data.type === 'COMPUTE_CHAMFER') dispatched.push(structuredClone(data))
    if (this.ready) this.send(message)
    else this.queued.push(message)
  }
  terminate(): void {
    if (this.stopping) return
    this.stopping = true
    this.queued = []
    this.child.kill('SIGTERM')
  }
  forceTerminate(): void { this.child.kill('SIGKILL') }
}
host.Worker = ProductionWorker
afterEach(async () => {
  const owned = [...children]
  for (const child of owned) child.terminate()
  const force = setTimeout(() => { for (const child of owned) child.forceTerminate() }, 2_000)
  try { await Promise.all(owned.map(child => child.closed)) }
  finally { clearTimeout(force) }
})
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const shaFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const sourceSha256 = (text: string) => sha256(text.replace(/\r\n/g, '\n'))
type Move = { type: string; role?: string; x: number; y: number; z: number; feed?: number }

function summarize(moves: Move[], stockTop: number, facedTop: number) {
  const starts = moves.flatMap((m, i) =>
    m.type === 'rapid' && moves[i + 1]?.type === 'rapid' && moves[i + 2]?.type === 'rapid'
      && moves[i + 3]?.role === 'ramp' ? [i] : [])
  const surfaceTime = (surface: number) => {
    let minutes = 0
    for (let j = 1; j < moves.length; j++) {
      const a = moves[j - 1], b = moves[j]
      if (b.role !== 'ramp' || !b.feed) continue
      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      const fraction = a.z > surface && b.z > surface ? 1
        : a.z <= surface && b.z <= surface ? 0
        : a.z > b.z ? (a.z - surface) / (a.z - b.z)
        : (b.z - surface) / (b.z - a.z)
      minutes += fraction * d / b.feed
    }
    return minutes
  }
  return {
    count: moves.length,
    sha256: sha256(JSON.stringify(moves)),
    loopEntries: starts.length,
    entryTriples: starts.map(i => moves.slice(i, i + 3).map(m => m.z)),
    rampMoves: moves.filter(m => m.role === 'ramp').length,
    firstHole: starts[1] !== undefined ? moves.slice(starts[1], starts[1] + 12) : [],
    cutZ: [...new Set(moves.filter(m => m.role === 'cut').map(m => m.z))].sort((a, b) => a - b),
    rampMinutes: surfaceTime(-Infinity),
    aboveStockRampMinutes: surfaceTime(stockTop),
    aboveFacedRampMinutes: surfaceTime(facedTop),
  }
}

describe('WO-2754 unchanged Fixture Plate through production', () => {
  // WO-2784: WO-2754 made this a coordinator-granted, on-demand receipt run
  // (explicit create-only WO2754_PRODUCTION_OUT, commit e8b6653176). Without
  // that destination it cannot run, so it is skipped in ordinary suite runs.
  it.skipIf(!process.env.WO2754_PRODUCTION_OUT)('generates all 15 clear-space entries and exits while retaining the saved heights', { timeout: 120_000 }, async () => {
    const configuredOutput = process.env.WO2754_PRODUCTION_OUT
    if (!configuredOutput) throw new Error('Set WO2754_PRODUCTION_OUT to a fresh coordinator-approved receipt destination.')
    const output = resolve(configuredOutput)
    if (existsSync(output)) throw new Error(`Preserving existing receipt; choose a fresh WO2754_PRODUCTION_OUT: ${output}`)
    const originalText = readFileSync(source, 'utf8')
    const originalHash = sourceSha256(originalText)
    expect(originalHash).toBe(expectedSourceSha256)
    const original = JSON.parse(originalText)
    const cached = original.setups[0].operations[4]
    expect(cached.name).toBe('Chamfer 5')
    mem.clear(); bytes.clear(); dispatched.length = 0; completed.length = 0; resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())
    useCamStore.getState().newProject()
    await useCamStore.getState().loadProjectFromFile(originalText)
    // A headless file open has no mounted viewport. Publish only the stock
    // bounds hook for compute, after the production open has completed.
    host.window!.__cncViewport = {
      getStockBounds: (stockId?: string) => {
        const project = useCamStore.getState().project
        const activeSetup = project.setups[0]
        return smartHeightStockBounds(project, stockId ?? setupProvenStockId(activeSetup, project)!)
      },
    }
    const setup = useCamStore.getState().project.setups[0]
    const op = setup.operations.find((item: { name: string }) => item.name === 'Chamfer 5')!
    useCamStore.getState().updateOperation(setup.id, op.id, { params: { ...op.params, entryPolicy: 'clear_space' } })
    await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
    const result = useCamStore.getState().project.setups[0].operations.find(item => item.id === op.id)!
    const chamferRequests = dispatched.filter(message => message.type === 'COMPUTE_CHAMFER' && message.payload && (message.payload as { opId?: string }).opId === op.id)
    const chamferCompletions = completed.filter(message => message.type === 'TOOLPATH_COMPLETE' && message.opId === op.id)
    const afterHash = sourceSha256(readFileSync(source, 'utf8'))
    expect(afterHash).toBe(originalHash)
    const cachedMoves = cached.toolpathMoves as Move[]
    const emittedMoves = (result.toolpathMoves ?? []) as Move[]
    const sourceFiles = [
      'src/store/index.ts', 'src/store/toolReachInputs.ts', 'src/lib/cam/types.ts', 'src/lib/cam/generationFingerprint.ts',
      'src/lib/cam/smartHeights/chamfer.ts',
      'src/lib/cam/chamfer2d.ts', 'src/lib/cam/moves/index.ts',
      'src/lib/cam/toolpathWorker.ts', 'src/lib/cam/holderClearance.ts', 'src/lib/cam/holderClearanceGate.ts',
      'src/tests/store/chamferClearSpaceEntry.wo2754.production.test.ts',
    ]
    const current = useCamStore.getState()
    const posted = result.status === 'ready' ? postProject({ ...current.project, toolLibrary: current.toolLibrary }, current.project.setups, UCCNC_CONFIG, {
      mode: 'combined', pauseBetweenSetups: false, baseName: 'WO-2754', ext: 'nc', selectedOpIds: { [setup.id]: [op.id] },
      modelRefsVerifiedSinceLoad: current.modelRefsVerifiedSinceLoad,
    }) : null
    const postedProgram = posted?.combined ? parseGcode(posted.combined.gcode) : null
    const entries = emittedMoves.flatMap((m, i) => m.role === 'lead_in' ? [{ approach: emittedMoves.slice(i - 4, i), lead: m, firstCut: emittedMoves[i + 1] }] : [])
    const exits = emittedMoves.flatMap((m, i) => m.role === 'lead_out' ? [{ lastCut: emittedMoves[i - 1], lead: m, retract: emittedMoves.slice(i + 1, i + 3) }] : [])
    const record = {
      source,
      sourceSha256Before: originalHash,
      sourceSha256After: afterHash,
      gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceHashes: Object.fromEntries(sourceFiles.map(path => [path, shaFile(path)])),
      projectId: original.id, setupId: setup.id, operationId: op.id,
      loadedStatus: op.status, emittedStatus: result.status, errorMessage: result.errorMessage ?? null,
      clearSpaceObservation: { available: false, reason: 'Real off-thread production worker; parent-only optional stage observer is not installed.' },
      workerDispatchCount: chamferRequests.length,
      workerCompletionCount: chamferCompletions.length,
      actualWorkerRequest: chamferRequests[0] ?? null,
      completionMoveSha256: chamferCompletions[0]?.moves ? sha256(JSON.stringify(chamferCompletions[0].moves)) : null,
      cachedResolvedHeights: cached.resolvedHeights?.wcs,
      emittedResolvedHeights: result.resolvedHeights?.wcs,
      cached: summarize(cachedMoves, 0, -.5),
      emitted: summarize(emittedMoves, 0, -.5),
      estimatedCutTimeMs: result.estimatedCutTimeMs ?? null,
      computeTimeMs: result.computeTimeMs ?? null,
      entries, exits, posted, postedProgram,
      actualWorkerCompletion: chamferCompletions[0] ?? null,
      notices: current.consoleEvents.map(e => e.message),
      priorStockSha256: sha256(JSON.stringify((chamferRequests[0]?.payload as { remainingStock?: unknown } | undefined)?.remainingStock ?? null)),
      cachedMoves,
      emittedMoves,
    }
    // Exclusive creation also protects a receipt created after the admission check.
    writeFileSync(output, JSON.stringify(record, null, 2), { flag: 'wx' })
    expect(chamferRequests).toHaveLength(1)
    expect(chamferCompletions).toHaveLength(1)
    expect(chamferCompletions[0].moves).toEqual(emittedMoves)
    expect(result.status, result.errorMessage).toBe('ready')
    expect(emittedMoves.length).toBeGreaterThan(0)
    expect(entries).toHaveLength(15)
    expect(exits).toHaveLength(15)
    expect(emittedMoves.filter(m => m.role === 'ramp')).toHaveLength(0)
    expect(result.resolvedHeights?.wcs).toEqual(cached.resolvedHeights?.wcs)
    expect(posted?.ok, JSON.stringify(posted?.diagnostics)).toBe(true)
    for (const move of emittedMoves.filter(m => m.role === 'lead_in' || m.role === 'lead_out' || m.role === 'plunge')) {
      const point = toWork(move, setup.wcs)
      expect(postedProgram?.segments.some(s => s.kind === 'feed' && s.feed === move.feed &&
        Math.abs(s.to.x - point.x) <= 0.002 && Math.abs(s.to.y - point.y) <= 0.002 && Math.abs(s.to.z - point.z) <= 0.002)).toBe(true)
    }
    const request = chamferRequests[0].payload as import('../../lib/cam/types').ChamferWorkerPayload
    expect(request.params.entryPolicy).toBe('clear_space')
    expect(request.entryEvidence!.stockSource).toBe('prior-result-envelope')
    expect(request.entryEvidence!.workholding.complete).toBe(true)
    expect(request.loops.filter(l => l.type === 'hole')).toHaveLength(14)
    // Actual store dispatch carries original ready predecessor moves/tool data,
    // not the center-sampled top array relabeled as a clearance certificate.
    expect(request.clearSpacePredecessors).toHaveLength(3)
    expect(request.clearSpacePredecessors!.map(p => p.tool.type)).toEqual(['flat_end_mill', 'drill', 'flat_end_mill'])
    for (const predecessor of request.clearSpacePredecessors!) {
      expect(setup.operations.some(op => op.toolId === predecessor.tool.id &&
        JSON.stringify(op.toolpathMoves) === JSON.stringify(predecessor.moves))).toBe(true)
      expect(predecessor.moves.every(m => ['rapid', 'feed'].includes(m.type))).toBe(true)
    }
    expect(request.clearSpacePredecessors!.some(p => p.tool.type === 'thread_mill')).toBe(false)
    expect((result as typeof result & { dependsOnPredecessors?: boolean }).dependsOnPredecessors).toBe(true)
    for (const e of entries) {
      expect(e.lead.z).toBe(-0.8)
      expect(e.lead.feed).toBe(400)
      expect(e.approach.map(m => m.z)).toEqual([15, 5, 4.5, -0.8])
      expect(e.approach[3].feed).toBe(150)
      expect(Math.hypot(e.lead.x - e.approach[3].x, e.lead.y - e.approach[3].y)).toBeGreaterThan(0)
    }
    for (const e of exits) {
      expect(e.lastCut.role).toBe('cut')
      expect(e.lastCut.z).toBe(e.lead.z)
      expect(e.retract.map(m => m.z)).toEqual([5, 15])
      expect(e.retract.every(m => m.x === e.lead.x && m.y === e.lead.y)).toBe(true)
    }
  })
})


// Resolver boundary controls share this order's production test lane. These are
// input controls, not proof about the Fixture Plate's generated motion.
import { resolveWorkholdingObstacles } from '../../store/fixtureObstacles'
import { resolveWorkholdingPlacements } from '../../lib/workholding/resolveWorkholding'
import type { ImportedGeometry, Project, WorkholdingModel } from '../../types'
import type { WorkholdingShapeReader } from '../../lib/workholding/shapes'

const zero = { x: 0, y: 0, z: 0 }
const pose = { position: zero, rotation: zero }
const noShape: WorkholdingShapeReader = { stl: async () => null, step: async () => null }
function fixtureRow(patch: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return { id: 'jaw-shape', name: 'Jaw', filename: 'jaw.stl', type: 'mesh', format: 'stl', loaded: true,
    position: zero, rotation: zero, workholding: true,
    boundingBox: { min: zero, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } }, ...patch } as ImportedGeometry
}
function assembly(missingDefinition = false): WorkholdingModel {
  return { definitions: missingDefinition ? [] : [{ id: 'vise', name: 'Vise', kind: 'vise', revision: 1,
    components: [{ id: 'jaw', name: 'Jaw', geometryId: 'jaw-shape', localPose: pose }] }],
    instances: [{ id: 'instance', definitionId: 'vise', worldPose: pose, setupScope: { kind: 'all' } }] } as WorkholdingModel
}
const available = (workholding?: WorkholdingModel) => ({ workholding, setupId: 'setup', includeAvailability: true })
describe('WO-2754 scoped workholding availability', () => {
  it('distinguishes no obstacles from an omitted in-scope definition', async () => {
    expect((await resolveWorkholdingObstacles([], [], [], noShape, available())).availability).toEqual({ complete: true, omissions: [] })
    expect((await resolveWorkholdingObstacles([], [], [], noShape, available(assembly(true)))).availability)
      .toMatchObject({ complete: false, omissions: [{ instanceId: 'instance', reason: 'missing-definition' }] })
  })
  it('reports missing component identities, respecting the cut-body exclusion', async () => {
    const scope = available(assembly())
    expect((await resolveWorkholdingObstacles([], [], [], noShape, scope)).availability)
      .toMatchObject({ complete: false, omissions: [{ geometryId: 'jaw-shape', reason: 'missing-component' }] })
    expect((await resolveWorkholdingObstacles([], [], ['jaw-shape'], noShape, scope)).availability?.complete).toBe(true)
  })
  it('keeps out-of-setup missing definitions outside the obligation', async () => {
    const model = assembly(true)
    model.instances[0].setupScope = { kind: 'setups', setupIds: ['other'] } as typeof model.instances[0]['setupScope']
    expect((await resolveWorkholdingObstacles([], [], [], noShape, available(model))).availability?.complete).toBe(true)
  })
  it('retains conservative boxes and their existing notice without calling them omissions', async () => {
    const row = fixtureRow()
    const ordinary = await resolveWorkholdingObstacles([row], [], [], noShape)
    const qualified = await resolveWorkholdingObstacles([row], [], [], noShape, available())
    expect(qualified.meshes).toEqual(ordinary.meshes)
    expect(qualified.notices).toEqual(ordinary.notices)
    expect(qualified.meshes).toHaveLength(1)
    expect(qualified.availability?.complete).toBe(true)
  })
  it('distinguishes positively planar rows from failed exact+box resolution', async () => {
    const planar = fixtureRow({ format: 'sketch', type: 'curves_2d' })
    planar.boundingBox.max.z = planar.boundingBox.min.z
    expect((await resolveWorkholdingObstacles([planar], [], [], noShape, available())).availability?.complete).toBe(true)
    const failed = fixtureRow({ boundingBox: undefined } as unknown as Partial<ImportedGeometry>)
    expect((await resolveWorkholdingObstacles([failed], [], [], noShape, available())).availability?.complete).toBe(false)
  })
  it('records missing marked-row Model Item placement instead of inferring an empty fixture', async () => {
    const row = fixtureRow({ format: 'model', modelItemId: 'missing' })
    const placements = resolveWorkholdingPlacements({ geometry: [row], modelItemPlacements: [], workholding: undefined } as Pick<Project, 'geometry' | 'modelItemPlacements' | 'workholding'>,
      'setup', { includeAvailability: true })
    expect(placements.omissions).toMatchObject([{ geometryId: row.id, reason: 'missing-placement' }])
    expect((await resolveWorkholdingObstacles([row], [], [], noShape, available())).availability?.complete).toBe(false)
  })
  it('keeps joint-zero fallback placed and complete', async () => {
    const model = assembly()
    model.definitions[0].components[0].joint = { kind: 'linear', axis: zero, minMm: 0, maxMm: 10, closedAtMm: 0 }
    const result = await resolveWorkholdingObstacles([fixtureRow()], [], [], noShape, available(model))
    expect(result.meshes).toHaveLength(1)
    expect(result.notices.join(' ')).toContain('zero position')
    expect(result.availability?.complete).toBe(true)
  })
})


// Transport-boundary controls only: actual store dispatch/freshness closure,
// deliberately controlled completion. These are not CAM or motion evidence.
describe('WO-2754 absent replay predecessor dependency', () => {
  it.each([
    { name: 'publishes an unchanged completion with predecessor dependency', changeWhilePending: false },
    { name: 'rejects a delayed completion after predecessor authored inputs change', changeWhilePending: true },
  ])('$name', { timeout: 15_000 }, async ({ changeWhilePending }) => {
    // The shipped example is fixture data here, read (never written). Its
    // content is regenerated with the examples (WO-2975, 1935f923b0), so these
    // transport controls prove the file is unchanged by the run rather than
    // pinning one regeneration; the on-demand receipt run above keeps the
    // WO-2515 pin its receipts describe.
    const originalText = readFileSync(source, 'utf8')
    const originalSha256 = sourceSha256(originalText)
    const fixture = JSON.parse(originalText)
    const savedSetup = fixture.setups[0]
    const thread = savedSetup.operations.find((op: { type: string }) => op.type === 'thread_mill')!
    const chamfer = savedSetup.operations.find((op: { name: string }) => op.name === 'Chamfer 5')!
    expect(thread.status).toBe('ready')
    // Isolated in-memory dependency fixture: no replayable predecessor remains.
    // Restoring its saved ready result below is fixture setup, not regeneration.
    savedSetup.operations = [thread, chamfer]
    const realWorker = host.Worker
    const oldViewport = host.window!.__cncViewport
    const deliveries: { message: Message; worker: BoundaryWorker }[] = []
    class BoundaryWorker {
      onmessage: ((event: { data: Message }) => void) | null = null
      onerror: ((error: unknown) => void) | null = null
      postMessage(message: Message): void {
        if (message.type !== 'COMPUTE_CHAMFER') throw new Error('Unexpected boundary fixture dispatch: ' + message.type)
        deliveries.push({ message: structuredClone(message), worker: this })
      }
      terminate(): void { /* no native process in this transport fixture */ }
    }
    let pending: Promise<void> | undefined
    let delivered = false
    try {
      mem.clear(); bytes.clear(); resetDocumentHolder()
      setDocumentStorage(new InMemoryDocumentStorage())
      useCamStore.getState().newProject()
      await useCamStore.getState().loadProjectFromFile(JSON.stringify(fixture))
      host.window!.__cncViewport = {
        getStockBounds: (stockId?: string) => {
          const project = useCamStore.getState().project, activeSetup = project.setups[0]
          return smartHeightStockBounds(project, stockId ?? setupProvenStockId(activeSetup, project)!)
        },
      }
      const setupId = useCamStore.getState().project.setups[0].id
      const current = () => useCamStore.getState().project.setups[0]
      const target = current().operations.find(op => op.id === chamfer.id)!
      useCamStore.getState().updateOperation(setupId, target.id, { params: { ...target.params, entryPolicy: 'clear_space' } })
      // Controlled saved-result publication AFTER fixture setup. Its original
      // fingerprint described removed predecessors; compute the real current
      // fingerprint rather than bypassing normal freshness reconciliation.
      // The saved path/height authority is fixture data, not a newly cut path.
      const { projectOperationFingerprint } = await import('../../lib/cam/generationFingerprint')
      const beforePublication = current().operations.find(op => op.id === thread.id)!
      const restoredResult = {
        ...beforePublication, status: 'ready' as const, toolpathMoves: thread.toolpathMoves,
        resolvedHeights: thread.resolvedHeights, resolvedHeightPlan: thread.resolvedHeightPlan,
      }
      const generationFingerprint = projectOperationFingerprint(
        useCamStore.getState().project, current(), restoredResult, restoredResult.resolvedHeights,
        undefined, toolId => useCamStore.getState().toolLibrary.find(tool => tool.id === toolId),
      )
      useCamStore.getState().updateOperation(setupId, thread.id, {
        status: 'ready', toolpathMoves: restoredResult.toolpathMoves,
        resolvedHeights: restoredResult.resolvedHeights, resolvedHeightPlan: restoredResult.resolvedHeightPlan,
        generationFingerprint,
      })
      const readyThread = current().operations.find(op => op.id === thread.id)!
      expect(readyThread.enabled).toBe(true)
      expect(readyThread.status).toBe('ready')
      expect(readyThread.toolpathMoves!.length).toBeGreaterThan(0)
      expect(useCamStore.getState().toolLibrary.find(t => t.id === readyThread.toolId)?.type).toBe('thread_mill')
      expect(readyThread.generationFingerprint).toBe(generationFingerprint)
      host.Worker = BoundaryWorker
      pending = useCamStore.getState().computeOperationToolpath(setupId, target.id)
      await vi.waitFor(() => expect(deliveries).toHaveLength(1), { timeout: 5_000, interval: 10 })
      expect(current().operations.find(op => op.id === thread.id)!.status).toBe('ready')
      const held = deliveries[0]
      const payload = held.message.payload as import('../../lib/cam/types').ChamferWorkerPayload & { noEarlierOperations?: boolean }
      expect(payload.params.entryPolicy).toBe('clear_space')
      expect(payload.stockBlock).toBeDefined()
      expect(payload.remainingStock).toBeUndefined()
      expect(payload.noEarlierOperations).not.toBe(true)
      expect(payload.entryEvidence?.stockSource).toBe('loaded-stock-envelope')
      expect(payload.clearSpacePredecessors).toEqual([])
      expect(current().operations.map(op => op.id)).toEqual([thread.id, target.id])
      if (changeWhilePending) {
        const before = current().operations.find(op => op.id === thread.id)!
        useCamStore.getState().updateOperation(setupId, thread.id, { params: { ...before.params, pitch: 1.25 } })
      }
      // Same controlled response in both cases; no geometry routine ran here.
      const moves = [{ type: 'rapid', role: 'rapid', x: 0, y: 0, z: 15 },
        { type: 'feed', role: 'cut', x: 0, y: 0, z: -.8, feed: 400 }]
      delivered = true
      held.worker.onmessage?.({ data: { type: 'TOOLPATH_COMPLETE', moves, computeTimeMs: 1 } })
      await pending
      const result = current().operations.find(op => op.id === target.id)!
      if (changeWhilePending) {
        expect(result.status).toBe('outdated')
        expect(result.toolpathMoves).toBeUndefined()
        expect(result.generationFingerprint).toBeUndefined()
      } else {
        expect(result.status).toBe('ready')
        expect(result.toolpathMoves).toEqual(moves)
        expect(result.generationFingerprint).toBeTruthy()
        expect((result as typeof result & { dependsOnPredecessors?: boolean }).dependsOnPredecessors).toBe(true)
      }
    } finally {
      try {
        if (!delivered && deliveries[0]) deliveries[0].worker.onmessage?.({ data: {
          type: 'TOOLPATH_ERROR', message: 'Boundary fixture cleanup; no motion generated.',
        } })
        if (pending) await pending
      } finally {
        host.Worker = realWorker
        host.window!.__cncViewport = oldViewport
        expect(sourceSha256(readFileSync(source, 'utf8'))).toBe(originalSha256)
      }
    }
  })
})
