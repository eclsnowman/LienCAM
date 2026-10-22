// Actual application store entry and real worker. No builder or postprocessing mocks.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import type { ToolReachInputs } from '../../lib/cam/holderClearanceGate'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import { pointInPolygon } from '../../lib/cam/geometry'
import { buildFaceSmartHeightIntent, buildPlanarRoughSmartHeightIntent } from '../../lib/cam/smartHeights'
import type { FacePilotEnvelope } from '../../kernel/planners/face'
import type { ToolpathCompleteWithNotices } from '../../lib/cam/toolpathWorker'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { ImportedGeometry, Operation, Project, ToolpathMove } from '../../types'

const donor = JSON.parse(readFileSync('src/tests/evidence/WO-2694/journey-1009-scratch.camproject', 'utf8')) as Project
const evidence: unknown[] = []
type Request = WorkerRequestMsg & { facePilot?: FacePilotEnvelope }
let requests: Request[] = []
let responses: ToolpathCompleteWithNotices[] = []
let instances: RealWorker[] = []
let holdTerminal = false
let alterWire: ((data: Request) => void) | undefined
let active: RealWorker | undefined
const workerSelf: {
  onmessage: ((event: { data: Request }) => Promise<void>) | null
  postMessage: (data: WorkerResponseMsg) => void
} = {
  onmessage: null,
  postMessage: data => {
    if (data.type === 'TOOLPATH_COMPLETE') responses.push(structuredClone(data))
    if (holdTerminal && data.type !== 'TOOLPATH_PROGRESS') active!.terminal = data
    else active?.onmessage?.({ data })
  },
}
class RealWorker {
  onmessage: ((event: { data: WorkerResponseMsg }) => void) | null = null
  onerror: ((error: ErrorEvent) => void) | null = null
  terminal?: WorkerResponseMsg
  terminated = false
  constructor() { instances.push(this) }
  postMessage(request: Request) {
    const data = structuredClone(request)
    alterWire?.(data)
    requests.push(data)
    active = this
    void workerSelf.onmessage!({ data })
  }
  terminate() { this.terminated = true }
  release(data = this.terminal!) { this.onmessage?.({ data }) }
}

beforeAll(async () => {
  vi.stubGlobal('self', workerSelf)
  vi.stubGlobal('Worker', RealWorker)
  await import('../../lib/cam/toolpathWorker')
})
beforeEach(() => {
  vi.stubEnv('LIENCAM_ENGINE', 'current')
  requests = []; responses = []; instances = []; holdTerminal = false; alterWire = undefined
  install()
})
afterEach(() => { vi.useRealTimers() })
afterAll(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  if (process.env.WO2953_REST_CAPTURE === '1') writeFileSync('src/tests/evidence/WO-2953/rest-application.json', JSON.stringify({
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    entry: 'computeOperationToolpath -> real toolpathWorker -> published operation',
    limits: 'Numeric world-mm application output; no hardware or rendered evidence.',
    cases: evidence.filter(item => (item as { rest?: boolean }).rest),
  }, null, 2) + '\n')
  if (process.env.WO2944_APP_CAPTURE === '1') {
    const paths = ['src/store/index.ts', 'src/lib/cam/toolpathWorker.ts', 'src/kernel/planning.ts',
      'src/kernel/planners/face.ts', 'src/tests/store/faceKernelPilot.wo2944.test.ts']
    writeFileSync('src/tests/evidence/WO-2944/application-comparison.json', JSON.stringify({
      source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      command: 'WO2944_APP_CAPTURE=1 npx vitest run src/tests/store/faceKernelPilot.wo2944.test.ts src/tests/kernel/facePilot.wo2944.test.ts',
      entry: 'useCamStore.getState().computeOperationToolpath',
      sourceHashes: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
      limits: 'Numeric application output only; sampled coverage, axial gouge and horizontal rapid clearance; no rendered image, hardware readback, swept-volume, engagement or peak-memory claim.',
      cases: evidence,
    }, null, 2) + '\n')
  }
})

function install(change?: (project: Project, op: Operation) => void) {
  const project = structuredClone(donor)
  const setup = project.setups[0]
  const op = setup.operations.find(candidate => candidate.type === 'face')!
  setup.operations = [op]
  project.geometry = []; project.modelItems = []; project.modelItemPlacements = []
  project.modelItemDocuments = undefined
  const stock = project.stocks![0]
  stock.mode = 'explicit'
  project.sceneStock = { ...project.sceneStock, mode: 'fixed', autoStocks: [], fixedStocks: [{
    id: stock.id, name: stock.name, width: stock.bounds.size.x, height: stock.bounds.size.y,
    depth: stock.bounds.size.z, position: { ...stock.bounds.min },
  }] }
  op.toolpathMoves = undefined; op.generationFingerprint = undefined
  change?.(project, op)
  useCamStore.setState({ project, toolLibrary: structuredClone(project.toolLibrary), toolpathBatch: null })
}
// Real predecessor generation, supported flat-tool linear removal, and an interior
// pocket large enough that the cutter-radius inset has a nonempty forbidden area.
function installRestPocket() {
  install((project, face) => {
    project.stocks![0].position = { ...project.stocks![0].bounds.min }
    const setup = project.setups[0]
    const points = [{ x: -20, y: -15 }, { x: 20, y: -15 }, { x: 20, y: 15 }, { x: -20, y: 15 }]
    project.geometry = [{
      id: 'rest-pocket', name: 'Rest pocket', filename: 'rest.dxf',
      type: 'curves_2d', format: 'dxf', loaded: true, stockId: project.stocks![0].id,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      boundingBox: { min: { x: -20, y: -15, z: 0 }, max: { x: 20, y: 15, z: 0 },
        size: { x: 40, y: 30, z: 0 }, center: { x: 0, y: 0, z: 0 } },
      loops: [{ id: 'pocket-loop', layerId: 'outline', closed: true, type: 'contour', points }],
      layers2d: [{ id: 'outline', name: 'Outline', color: '#fff', visible: true }],
    }] as ImportedGeometry[]
    const pocket = structuredClone(donor.setups[0].operations.find(op => op.type === 'pocket_2d')!)
    pocket.id = 'rest-prior'; pocket.enabled = true; pocket.status = 'pending'
    pocket.toolpathMoves = undefined; pocket.generationFingerprint = undefined
    pocket.resolvedHeights = undefined; pocket.resolvedHeightPlan = undefined
    pocket.params = { ...pocket.params, geometryId: 'rest-pocket', loopIds: [],
      fillStrategy: 'outside_in', stepoverLeadIn: 'none', finishContour: false }
    pocket.linking = { ...pocket.linking, entryType: 'plunge' }
    pocket.smartHeight = { kind: 'smart_v2', intent: buildPlanarRoughSmartHeightIntent({
      setupId: setup.id, operationType: 'pocket_2d', geometryIds: ['rest-pocket'],
      safetyIntent: face.heights.heightIntent!, mode: 'explicit_depth', explicitTargetWcsMm: -6,
    }) }
    face.params = { ...face.params, boundarySource: 'rest' }
    face.smartHeight = { kind: 'smart_v2', intent: buildFaceSmartHeightIntent({
      setupId: setup.id, stockId: project.stocks![0].id, safetyIntent: face.heights.heightIntent!,
      mode: 'explicit_depth', explicitTargetWcsMm: -5,
    }) }
    setup.operations.unshift(pocket)
  })
}

// Analytic segment/open-rectangle intersection, with the inherited 1e-9 mm
// bound. WO-1820 permits cutter-radius overrun into the removed pocket.
function crossesPocketInterior(moves: ToolpathMove[]): boolean {
  return moves.some((b, i) => {
    if (!i || b.type === 'rapid' || (b.role !== 'cut' && b.role !== 'stepover')) return false
    const a = moves[i - 1]
    if (Math.abs(a.z - 11) > 1e-9 || Math.abs(b.z - 11) > 1e-9) return false
    let lo = 0, hi = 1
    for (const [axis, min, max] of [['x', -17, 17], ['y', -12, 12]] as const) {
      const delta = b[axis] - a[axis]
      if (delta === 0) { if (a[axis] <= min + 1e-9 || a[axis] >= max - 1e-9) return false }
      else {
        const t0 = (min + 1e-9 - a[axis]) / delta, t1 = (max - 1e-9 - a[axis]) / delta
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1))
      }
    }
    return lo < hi
  })
}
function assertRestExclusion(moves: ToolpathMove[]) {
  const cuts = moves.filter(move => move.role === 'cut' && Math.abs(move.z - 11) < 1e-9)
  expect(cuts.length).toBeGreaterThan(0)
  expect(cuts.some(move => move.x < -20)).toBe(true)
  expect(cuts.some(move => move.x > 20)).toBe(true)
  expect(crossesPocketInterior(moves)).toBe(false)
}

function operation() { return useCamStore.getState().project.setups[0].operations.at(-1)! }
async function compute(engine: 'current' | 'both' | 'kernel') {
  vi.stubEnv('LIENCAM_ENGINE', engine)
  const setup = useCamStore.getState().project.setups[0]
  await useCamStore.getState().computeOperationToolpath(setup.id, operation().id)
  expect(operation().status, operation().errorMessage).toBe('ready')
  return structuredClone(operation())
}
function metrics(moves: ToolpathMove[], bottom: number, retract: number, radius: number) {
  let cutMm = 0, linkMm = 0, rapidMm = 0, gouge = 0, clearance = Infinity, positive = 0, negative = 0, airMs = 0
  const cuts: [ToolpathMove, ToolpathMove][] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    const distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    if (b.type === 'rapid') {
      rapidMm += distance; airMs += distance / 6000 * 60000
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) clearance = Math.min(clearance, a.z - retract, b.z - retract)
    } else {
      if (b.role === 'cut') cutMm += distance
      else linkMm += distance
      gouge = Math.max(gouge, bottom - b.z)
      positive += Math.max(0, b.x - a.x); negative += Math.max(0, a.x - b.x)
      if (Math.abs(a.z - bottom) < 1e-8 && Math.abs(b.z - bottom) < 1e-8) cuts.push([a, b])
    }
  }
  // Donor stock footprint: deterministic 2 mm material sampling.
  const { min, max } = useCamStore.getState().project.stocks![0].bounds
  let sampled = 0, residual = 0, maxResidualMm = 0
  for (let x = min.x + 1; x < max.x; x += 2) for (let y = min.y + 1; y < max.y; y += 2) {
    const request = requests.at(-1)!
    if (request.type === 'COMPUTE_FACE' && !request.payload.loops.some(loop =>
      loop.closed && pointInPolygon({ x, y }, loop.points))) continue
    let distance = Infinity
    for (const [a, b] of cuts) {
      const dx = b.x - a.x, dy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)))
      distance = Math.min(distance, Math.hypot(x - a.x - t * dx, y - a.y - t * dy))
    }
    sampled++; if (distance > radius + 0.005) residual++
    maxResidualMm = Math.max(maxResidualMm, distance - radius)
  }
  return { cutMm, linkMm, rapidMm, positive, negative, axialGougeMm: gouge,
    rapidClearanceMm: Number.isFinite(clearance) ? clearance : null,
    rapidTimeProxyMs: airMs, sampled, residual, maxResidualMm,
    outputBytes: Buffer.byteLength(JSON.stringify(moves)) }
}
function assertParity(current: Operation, candidate: Operation) {
  const radius = useCamStore.getState().toolLibrary.find(tool => tool.id === current.toolId)!.diameter / 2
  const m = (op: Operation) => metrics(op.toolpathMoves!, op.resolvedHeights!.machine.bottom,
    op.resolvedHeights!.machine.retract, radius)
  const before = m(current), after = m(candidate)
  for (const name of ['cutMm', 'linkMm', 'rapidMm', 'positive', 'negative', 'rapidTimeProxyMs'] as const)
    expect(after[name]).toBeCloseTo(before[name], 6)
  expect(after.axialGougeMm).toBeLessThanOrEqual(1e-9)
  expect(after.residual).toBeLessThanOrEqual(before.residual)
  expect(after.maxResidualMm).toBeLessThanOrEqual(before.maxResidualMm + 0.005)
  expect(after.rapidClearanceMm).toBe(before.rapidClearanceMm)
  expect(after.outputBytes).toBeLessThanOrEqual(before.outputBytes + Math.max(1024, before.outputBytes * 0.05))
  expect(candidate.estimatedCutTimeMs!).toBeCloseTo(current.estimatedCutTimeMs!, 2)
  expect(candidate.resolvedHeights).toEqual(current.resolvedHeights)
  expect(candidate.computeTimeMs!).toBeLessThan(5000)
  expect(candidate.resolvedHeightPlan).toEqual(current.resolvedHeightPlan)
  evidence.push({ before, after, current, candidate, requests: structuredClone(requests), responses: structuredClone(responses) })
}

type TerminalEvent = 'browser error' | 'watchdog timeout'
async function startHeld(engine: 'current' | 'both' | 'kernel') {
  vi.useFakeTimers()
  vi.stubEnv('LIENCAM_ENGINE', engine)
  holdTerminal = true
  const setup = useCamStore.getState().project.setups[0]
  const done = useCamStore.getState().computeOperationToolpath(setup.id, operation().id)
  await vi.waitFor(() => expect(instances[0]?.terminal).toBeDefined())
  expect(operation().status).toBe('computing')
  return { done, setup, worker: instances[0] }
}
async function endHeld(worker: RealWorker, terminal: TerminalEvent, done: Promise<void>) {
  if (terminal === 'watchdog timeout') await vi.advanceTimersByTimeAsync(180_000)
  else worker.onerror?.({ message: 'controlled browser crash', filename: 'face-worker.js',
    lineno: 7, error: new Error('controlled browser crash') } as ErrorEvent)
  await done
  expect(worker.terminated).toBe(true)
}

describe('WO-2944 actual Face application route', () => {
  it('keeps default current and makes shadow retain current publication', async () => {
    const current = await compute('current')
    expect(requests.at(-1)!.facePilot).toBeUndefined()
    const shadow = await compute('both')
    expect(requests.at(-1)!.facePilot?.engine).toBe('both')
    const response = responses.at(-1)!
    expect(response.faceShadow?.moves.length).toBeGreaterThan(0)
    expect(shadow.toolpathMoves).toEqual(response.moves)
    assertParity(current, shadow)
    assertParity(current, { ...shadow, toolpathMoves: response.faceShadow!.moves })
  })
  it('keeps current authoritative even when a shadow transport control yields different kernel moves', async () => {
    const current = await compute('current')
    // Adversarial control only: corrupt the cloned worker envelope's kernel
    // tool while leaving the prepared native request untouched. Both builders
    // and all postprocessing still run. This is not application truth evidence.
    alterWire = data => { if (data.facePilot) data.facePilot.input.tool = { ...data.facePilot.input.tool, diameter: 12 } }
    const shadow = await compute('both')
    const response = responses.at(-1)!
    expect(response.faceShadow!.moves).not.toEqual(response.moves)
    expect(shadow.toolpathMoves).toEqual(current.toolpathMoves)
    expect(shadow.toolpathMoves).toEqual(response.moves)
  })
  it('registers explicit kernel at the complete prepared application boundary', async () => {
    const current = await compute('current')
    const kernel = await compute('kernel')
    const pilot = requests.at(-1)!.facePilot
    expect(pilot?.engine).toBe('kernel')
    expect(pilot?.frame.kind).toBe('world')
    expect(pilot?.frame.revision).toBe(kernel.generationFingerprint)
    expect(responses.at(-1)!.faceShadow).toBeUndefined()
    expect(kernel.toolpathMoves!.length).toBeGreaterThan(0)
    assertParity(current, kernel)
  })
  it('preserves translated and yawed setup world output without another transform', async () => {
    install(project => {
      const wcs = project.setups[0].wcs
      wcs.xAxis = { x: 0, y: 1, z: 0 }; wcs.yAxis = { x: -1, y: 0, z: 0 }
    })
    const current = await compute('current'), kernel = await compute('kernel')
    expect(kernel.resolvedHeights!.machine.bottom).toBe(11)
    expect(Math.min(...kernel.toolpathMoves!.map(move => move.z))).toBeCloseTo(11, 8)
    assertParity(current, kernel)
  })
  it('uses selected tool hand, enabled feed override and manual height intent', async () => {
    install((project, op) => {
      project.toolLibrary.find(tool => tool.id === op.toolId)!.cutHand = 'left'
      op.params = { ...op.params, pattern: 'one_way', direction: 'climb' }
      op.feedrateOverride = { ...op.feedrateOverride!, enabled: true, feedRate: 777, plungeRate: 222 }
      op.smartHeight = { kind: 'smart_v2', intent: buildFaceSmartHeightIntent({
        setupId: project.setups[0].id, stockId: project.stocks![0].id,
        mode: 'explicit_depth', explicitTargetWcsMm: -3,
        safetyIntent: {
          clearance: { reference: 'wcs_plane', offset: 15, provenance: 'user' },
          retract: { reference: 'wcs_plane', offset: 5, provenance: 'user' },
          feed: { reference: 'wcs_plane', offset: 2, provenance: 'user' },
        },
      }) }
    })
    const current = await compute('current'), kernel = await compute('kernel')
    expect(kernel.resolvedHeights!.machine.bottom).toBe(13)
    expect(kernel.toolpathMoves!.some(move => move.feed === 777)).toBe(true)
    expect(requests.at(-1)!.facePilot!.input.tool.cutHand).toBe('left')
    const cutDeltas = kernel.toolpathMoves!.slice(1).flatMap((move, i) =>
      move.role === 'cut' ? [move.x - kernel.toolpathMoves![i].x] : [])
    expect(cutDeltas.some(dx => dx < -1e-6)).toBe(true)
    expect(cutDeltas.every(dx => dx <= 1e-9)).toBe(true)
    assertParity(current, kernel)
  })
  it('preserves placed concave geometry and supported offset-pattern preparation', async () => {
    install((project, op) => {
      const stock = project.stocks![0]
      const points = [{ x: 0, y: 0 }, { x: 45, y: 0 }, { x: 45, y: 12 },
        { x: 25, y: 12 }, { x: 25, y: 30 }, { x: 0, y: 30 }]
      project.geometry = [{
        id: 'placed-outline', name: 'Concave sketch', filename: 'pilot.dxf',
        type: 'curves_2d', format: 'dxf', loaded: true, stockId: stock.id,
        position: { x: -30, y: -20, z: 0 }, rotation: { x: 0, y: 0, z: 25 },
        boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 45, y: 30, z: 0 },
          size: { x: 45, y: 30, z: 0 }, center: { x: 22.5, y: 15, z: 0 } },
        loops: [{ id: 'concave', layerId: 'outline', closed: true, type: 'contour', points }],
        layers2d: [{ id: 'outline', name: 'Outline', color: '#fff', visible: true }],
      }] as ImportedGeometry[]
      op.params = { ...op.params, boundarySource: 'geometry', geometryId: 'placed-outline', pattern: 'offset' }
    })
    const current = await compute('current'), kernel = await compute('kernel')
    const request = requests.at(-1)!
    if (request.type !== 'COMPUTE_FACE') throw new Error('Expected Face request')
    expect(request.payload.loops[0].points[0]).toEqual({ x: -30, y: -20 })
    expect(request.payload.loops[0].points[1].y).not.toBe(-20)
    assertParity(current, kernel)
  })
  it('retains tool-reach trim, notices and shortfall through kernel publication', async () => {
    install((project, op) => {
      const tool = project.toolLibrary.find(tool => tool.id === op.toolId)!
      tool.lengthBelowHolder = 1; tool.holderId = 'pilot-holder'
      project.holders = [{ id: 'pilot-holder', name: 'Pilot holder', segments: [
        { height: 30, lowerDiameter: 30, upperDiameter: 30 },
      ] }]
    })
    const current = await compute('current'), kernel = await compute('kernel')
    const request = requests.at(-1)!
    if (request.type !== 'COMPUTE_FACE') throw new Error('Expected Face request')
    const raw = buildFaceToolpath(request.payload)
    expect(kernel.reachShortfall).toBeDefined()
    expect(kernel.reachShortfall).toEqual(current.reachShortfall)
    expect(kernel.toolpathMoves).not.toEqual(raw)
    expect(responses.at(-1)!.notices!.length).toBeGreaterThan(0)
    expect(kernel.toolpathMoves).toEqual(current.toolpathMoves)
    evidence.push({ postprocessing: 'reach', request, raw, current, kernel, response: responses.at(-1) })
  })
  it('retains actual workholding obstacles and their postprocessing on both routes', async () => {
    install(project => {
      const min = { x: -5, y: -8, z: 0 }, max = { x: 5, y: 8, z: 20 }
      project.geometry = [{
        id: 'clamp', name: 'Pilot clamp', filename: 'clamp.step', loaded: true,
        type: 'mesh', format: 'step', workholding: true,
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        boundingBox: { min, max, size: { x: 10, y: 16, z: 20 }, center: { x: 0, y: 0, z: 10 } },
        loops: [], layers2d: [],
      }] as ImportedGeometry[]
    })
    const current = await compute('current'), kernel = await compute('kernel')
    const request = requests.at(-1)!
    if (request.type !== 'COMPUTE_FACE') throw new Error('Expected Face request')
    expect((request.payload as typeof request.payload & ToolReachInputs).workholding!.length).toBe(1)
    expect(kernel.toolpathMoves).not.toEqual(buildFaceToolpath(request.payload))
    expect(kernel.toolpathMoves).toEqual(current.toolpathMoves)
    expect(kernel.reachShortfall).toEqual(current.reachShortfall)
    evidence.push({ postprocessing: 'workholding', request, current, kernel, response: responses.at(-1) })
  })
  it('invalidates kernel fingerprints when rolled back to current', async () => {
    const kernel = await compute('kernel')
    const state = useCamStore.getState(), setup = state.project.setups[0]
    expect(operationGenerationIsCurrent(state.project, setup, operation())).toBe(true)
    vi.stubEnv('LIENCAM_ENGINE', 'current')
    expect(operationGenerationIsCurrent(state.project, setup, operation())).toBe(false)
    const current = await compute('current')
    expect(current.generationFingerprint).not.toBe(kernel.generationFingerprint)
    expect(operationGenerationIsCurrent(useCamStore.getState().project, useCamStore.getState().project.setups[0], operation())).toBe(true)
  })
  it.each(['current', 'both', 'kernel'] as const)('publishes prepared rest holes and current material on %s', async engine => {
    installRestPocket()
    const current = await compute('current')
    const candidate = await compute(engine)
    const state = useCamStore.getState(), setup = state.project.setups[0]
    const pocket = setup.operations[0]
    expect(pocket.status).toBe('ready')
    expect(operationGenerationIsCurrent(state.project, setup, pocket)).toBe(true)
    expect(operationGenerationIsCurrent(state.project, setup, operation())).toBe(true)
    const request = requests.at(-1)!
    if (request.type !== 'COMPUTE_FACE') throw new Error('Expected prepared Face request')
    expect(request.payload.regionHoles).toHaveLength(1)
    expect(pointInPolygon({ x: 0, y: 0 }, request.payload.regionHoles![0])).toBe(true)
    expect(request.payload.loops.every(loop => loop.id.startsWith('__rest_'))).toBe(true)
    expect(request.facePilot?.engine).toBe(engine === 'current' ? undefined : engine)
    // The central pocket leaves the surrounding stock at Z16; the Face floor is Z11.
    expect(candidate.resolvedHeightPlan!.machining.materialStart.machineMm).toBeCloseTo(16, 9)
    expect(candidate.resolvedHeights!.machine.bottom).toBeCloseTo(11, 9)
    expect(request.payload.heights.topHeight + setup.wcs.origin.z).toBeCloseTo(16, 9)
    const response = responses.at(-1)!
    expect(candidate.toolpathMoves).toEqual(response.moves)
    expect(candidate.toolpathMoves).toEqual(current.toolpathMoves)
    assertRestExclusion(candidate.toolpathMoves!)
    if (engine === 'both') {
      expect(response.faceShadow!.moves).toEqual(current.toolpathMoves)
      assertRestExclusion(response.faceShadow!.moves)
    }
    // Prove this physical oracle detects omitted holes, rather than a vacuous no-cut path.
    const plain = buildFaceToolpath({ ...request.payload, regionHoles: undefined })
    expect(crossesPocketInterior(plain)).toBe(true)
    evidence.push({ rest: true, engine, pocket, request, response, current, candidate })
  })
  it.each(['current', 'both', 'kernel'] as const)('rejects stale prepared rest success on %s', async engine => {
    installRestPocket()
    await compute(engine)
    requests = []; instances = []; holdTerminal = true
    const setup = useCamStore.getState().project.setups[0]
    const done = useCamStore.getState().computeOperationToolpath(setup.id, operation().id)
    await vi.waitFor(() => expect(instances[0]?.terminal).toBeDefined())
    const request = requests.at(-1)!
    if (request.type !== 'COMPUTE_FACE') throw new Error('Expected prepared Face request')
    expect(request.payload.regionHoles).toHaveLength(1)
    // Same semantic inputs after ABA must still reject the consumed material token.
    useCamStore.getState().updateOperation(setup.id, setup.operations[0].id, { enabled: false })
    useCamStore.getState().updateOperation(setup.id, setup.operations[0].id, { enabled: true })
    instances[0].release(); await done
    expect(operation().status).toBe('outdated')
    expect(operation().toolpathMoves).toBeUndefined()
  })
  it('uses supported predecessor material in the actual kernel payload', async () => {
    install(project => {
      const setup = project.setups[0], target = setup.operations[0]
      const prior = structuredClone(target); prior.id = 'prior'; prior.enabled = true
      for (const [op, depth] of [[prior, -2], [target, -5]] as const) {
        op.smartHeight = { kind: 'smart_v2', intent: buildFaceSmartHeightIntent({
          setupId: setup.id, stockId: project.stocks![0].id,
          safetyIntent: op.heights.heightIntent!, mode: 'explicit_depth', explicitTargetWcsMm: depth }) }
      }
      setup.operations.unshift(prior)
    })
    const kernel = await compute('kernel')
    const setup = useCamStore.getState().project.setups[0]
    expect(setup.operations[0].status).toBe('ready')
    const materialTop = setup.wcs.origin.z - 2
    expect(kernel.resolvedHeightPlan!.machining.materialStart.machineMm).toBeCloseTo(materialTop, 9)
    expect(kernel.resolvedHeights!.machine.bottom).toBeCloseTo(setup.wcs.origin.z - 5, 9)
    expect(requests.map(request => {
      if (request.type !== 'COMPUTE_FACE') throw new Error('Expected Face payload')
      return request.payload.opId
    })).toEqual(['prior', kernel.id])
    const request = requests.at(-1)!
    expect(request.type).toBe('COMPUTE_FACE')
    if (request.type !== 'COMPUTE_FACE') throw new Error('Expected Face payload')
    expect(request.facePilot?.engine).toBe('kernel')
    expect(request.payload.heights.topHeight + setup.wcs.origin.z).toBeCloseTo(materialTop, 9)
    expect(kernel.toolpathMoves!.some(move => move.role === 'cut')).toBe(true)
  })
  it('does not treat disabled predecessors as removed material', async () => {
    install(project => {
      const prior = structuredClone(project.setups[0].operations[0]); prior.id = 'disabled'; prior.enabled = false
      project.setups[0].operations.unshift(prior)
    })
    const kernel = await compute('kernel')
    expect(kernel.toolpathMoves!.length).toBeGreaterThan(0)
  })
  it('refuses malformed height authority before worker dispatch', async () => {
    install((_project, op) => { op.smartHeight = undefined })
    vi.stubEnv('LIENCAM_ENGINE', 'kernel')
    const setup = useCamStore.getState().project.setups[0]
    await useCamStore.getState().computeOperationToolpath(setup.id, operation().id)
    expect(operation().status).toBe('error'); expect(requests).toHaveLength(0)
  })
  it('propagates a native kernel error without fallback or partial publication', async () => {
    install((_project, op) => { op.params = { ...op.params, entryType: 'lead_in_arc' } })
    vi.stubEnv('LIENCAM_ENGINE', 'kernel')
    const setup = useCamStore.getState().project.setups[0]
    await useCamStore.getState().computeOperationToolpath(setup.id, operation().id)
    expect(operation().status).toBe('error'); expect(requests).toHaveLength(1)
    expect(operation().errorMessage).toContain('arc lead-in')
    expect(operation().toolpathMoves).toBeUndefined()
  })
  describe.each(['current', 'both', 'kernel'] as const)('%s terminal request ownership', engine => {
    it.each(['browser error', 'watchdog timeout'] as const)('marks edited inputs outdated after %s', async terminal => {
      const { done, setup, worker } = await startHeld(engine)
      useCamStore.getState().updateOperation(setup.id, operation().id, {
        passes: { ...operation().passes, stepover: 2 },
      })
      expect(operation().status).toBe('computing')
      await endHeld(worker, terminal, done)
      expect(operation().status).toBe('outdated')
      expect(operation().toolpathMoves).toBeUndefined()
      expect(operation().generationFingerprint).toBeUndefined()
      expect(operation().progress).toBeUndefined()
      expect(operation().progressPhase).toBeUndefined()
      expect(operation().errorMessage).toBeTruthy()
      const settled = structuredClone(operation())
      worker.release() // A queued success cannot resurrect the terminated request.
      worker.onerror?.({ message: 'late browser crash' } as ErrorEvent)
      await vi.advanceTimersByTimeAsync(180_000)
      expect(operation()).toEqual(settled)
    })
    it.each(['browser error', 'watchdog timeout'] as const)('retains current-input error handling after %s', async terminal => {
      const { done, worker } = await startHeld(engine)
      await endHeld(worker, terminal, done)
      expect(operation().status).toBe('error')
      expect(operation().errorMessage).toContain(terminal === 'browser error'
        ? 'controlled browser crash @ face-worker.js:7' : operation().name)
      expect(operation().progress).toBeUndefined()
      const settled = structuredClone(operation())
      worker.release()
      await vi.advanceTimersByTimeAsync(180_000)
      expect(operation()).toEqual(settled)
    })
    it.each(['browser error', 'watchdog timeout'] as const)('preserves a newer pending request after %s', async terminal => {
      const { done, setup, worker } = await startHeld(engine)
      const newer = useCamStore.getState().computeOperationToolpath(setup.id, operation().id)
      await vi.waitFor(() => expect(instances[1]?.terminal).toBeDefined())
      // Keep the new request alive past the old deadline. Its identical inputs
      // deliberately require the request token, rather than fingerprint alone.
      await vi.advanceTimersByTimeAsync(1000)
      instances[1].release({ type: 'TOOLPATH_PROGRESS', opId: operation().id, progress: 0.6, phase: 'New request' })
      const pending = structuredClone(operation())
      if (terminal === 'watchdog timeout') {
        // The old deadline is the next timer; the new request was just pulsed.
        await vi.advanceTimersToNextTimerAsync()
        await done
        expect(worker.terminated).toBe(true)
      } else await endHeld(worker, terminal, done)
      expect(operation()).toEqual(pending)
      expect(instances[1].terminated).toBe(false)
      instances[1].release(); await newer
      expect(operation().status).toBe('ready')
    })
    it.each(['browser error', 'watchdog timeout'] as const)('preserves newer success after %s', async terminal => {
      const { done, worker } = await startHeld(engine)
      holdTerminal = false
      const newer = await compute(engine)
      await endHeld(worker, terminal, done)
      expect(operation()).toEqual(newer)
    })
    it.each(['browser error', 'watchdog timeout'] as const)('preserves a replacement project after %s', async terminal => {
      const { done, worker } = await startHeld(engine)
      install(project => { project.id = 'replacement-project' })
      const replacement = structuredClone(operation())
      await endHeld(worker, terminal, done)
      expect(useCamStore.getState().project.id).toBe('replacement-project')
      expect(operation()).toEqual(replacement)
    })
  })
  it('ignores late stale error after newer kernel success', async () => {
    vi.stubEnv('LIENCAM_ENGINE', 'kernel'); holdTerminal = true
    const setup = useCamStore.getState().project.setups[0]
    const first = useCamStore.getState().computeOperationToolpath(setup.id, operation().id)
    await vi.waitFor(() => expect(instances[0]?.terminal).toBeDefined())
    holdTerminal = false
    const second = await compute('kernel')
    instances[0].release({ type: 'TOOLPATH_ERROR', opId: operation().id, message: 'obsolete failure' })
    await first
    expect(operation().status).toBe('ready')
    expect(operation().toolpathMoves).toEqual(second.toolpathMoves)
    expect(operation().errorMessage).toBeUndefined()
  })
  it('discards stale success after an input edit and stale completion after project replacement', async () => {
    vi.stubEnv('LIENCAM_ENGINE', 'kernel'); holdTerminal = true
    const setup = useCamStore.getState().project.setups[0]
    const first = useCamStore.getState().computeOperationToolpath(setup.id, operation().id)
    await vi.waitFor(() => expect(instances[0]?.terminal).toBeDefined())
    useCamStore.getState().updateOperation(setup.id, operation().id, { passes: { ...operation().passes, stepover: 2 } })
    instances[0].release(); await first
    expect(operation().status).toBe('outdated'); expect(operation().toolpathMoves).toBeUndefined()
    const next = useCamStore.getState().computeOperationToolpath(setup.id, operation().id)
    await vi.waitFor(() => expect(instances[1]?.terminal).toBeDefined())
    install(project => { project.id = 'replacement-project' })
    instances[1].release(); await next
    expect(operation().status).toBe('pending'); expect(operation().toolpathMoves).toBeUndefined()
  })
})
