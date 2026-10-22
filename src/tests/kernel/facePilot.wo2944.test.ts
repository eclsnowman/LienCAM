// Real Face builder + manifest + shared services. Unit evidence only: the store
// resolver, worker postprocessing and actual application route are not wired here.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFacePlanner, type FacePlannerDependencies, type FacePlanningServices, type ResolvedFaceInput } from '../../kernel/planners/face'
import { createEngineRouter, kernelPlanners, type KernelPlan, type PlanningInput } from '../../kernel/planning'
import { createGeometryService, faceAdapter, scriptAdapter, type Point } from '../../kernel/geometry'
import { createToolModel } from '../../kernel/tools/model'
import { OPERATION_REGISTRY } from '../../kernel/registry'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import * as faceClipper from '../../lib/cam/face2d/clipperOffset'
import * as nativeGeometry from '../../lib/cam/geometry'
import { TOOL_TYPE_META } from '../../lib/tool/toolMeta'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { estimateRuntimeMs } from '../../lib/cam/runtime'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import type { FaceWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Project, ToolpathMove } from '../../types'

const donorPath = 'src/tests/evidence/WO-2694/journey-1009-scratch.camproject'
const donor = JSON.parse(readFileSync(donorPath, 'utf8')) as Project
const geometry = createGeometryService(faceAdapter(faceClipper, nativeGeometry.pointInPolygon))
const tools = createToolModel({ types: TOOL_TYPE_META, buildToolProfile })
// A fixture token shaped like the accepted frame checkpoint; no competing
// product FrameRef. Production must inject WO-2945's type/assertion instead.
const frame = { kind: 'world', projectEpoch: donor.id, entityId: 'world', revision: 'fixture-1' }
type Frame = typeof frame
type Fixture = ReturnType<typeof fixture>

function loop(id: string, points: Point[]): LoopData {
  return { id, type: 'contour', closed: true, points }
}
const rectangle = (id: string, x = 0, y = 0, w = 60, h = 40) => loop(id,
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }])

function fixture() {
  const project = structuredClone(donor)
  const setup = project.setups[0]
  const operation = setup.operations.find(op => op.type === 'face')!
  const tool = project.toolLibrary.find(t => t.id === operation.toolId)!
  const stock = project.stocks!.find(stock => stock.id === setup.wcs.stockId)!
  const { min, max } = stock.bounds
  const loops = [rectangle('stock', min.x, min.y, max.x - min.x, max.y - min.y)]
  const input: PlanningInput = { operation, setup, project, tool }
  // Use the actual manifest row, including its floor-allowance-once policy.
  const route = OPERATION_REGISTRY.face.compute
  if (route.lane !== 'toolpath-worker') throw new Error('Face route unexpectedly changed')
  const request = route.buildRequest({
    op: operation, opHeights: operation.heights,
    resolvedTopPlane: operation.resolvedHeights!.wcs.top,
    resolvedBottomPlane: operation.resolvedHeights!.wcs.bottom,
    chamferBottomResolved: false, engraveBottomResolved: false,
    basePayload: { opId: operation.id, setupId: setup.id, heights: operation.heights,
      passes: operation.passes, linking: operation.linking, tool, loops,
      wcsOrigin: setup.wcs.origin, feedrateOverride: operation.feedrateOverride },
  })
  if (request.type !== 'COMPUTE_FACE') throw new Error('Face manifest returned a different request')
  const { tool: _tool, opId: _op, setupId: _setup, ...payload } = request.payload
  const resolved: ResolvedFaceInput<Frame> = { frame: { ...frame }, payload,
    resolvedHeights: operation.resolvedHeights!, resolvedHeightPlan: operation.resolvedHeightPlan! }
  return { input, resolved, request: request.payload }
}

function dependencies(f: Fixture, overrides: Partial<FacePlannerDependencies<Frame>> = {}): FacePlannerDependencies<Frame> {
  return { geometry, tools, ready: faceClipper.ensureClipperReady, build: buildFaceToolpath,
    resolve: async () => f.resolved,
    assertCurrent: resolved => {
      if (resolved.frame.kind !== 'world' || resolved.frame.projectEpoch !== frame.projectEpoch
        || resolved.frame.revision !== frame.revision) throw new Error('unsupported or stale shared frame')
    }, ...overrides }
}

function currentPayload(f: Fixture): FaceWorkerPayload {
  return { ...structuredClone(f.resolved.payload), opId: f.input.operation.id,
    setupId: f.input.setup.id, tool: structuredClone(f.input.tool) }
}

function pointSegmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

function measure(moves: ToolpathMove[], payload: FaceWorkerPayload) {
  const linear = sampleArcMovesForLinearConsumers(moves)
  const bottom = payload.heights.bottomHeight + payload.wcsOrigin.z
  const retract = payload.heights.retractHeight + payload.wcsOrigin.z
  const radius = payload.tool.diameter / 2
  const angle = payload.params.passAngle * Math.PI / 180
  const segments: [ToolpathMove, ToolpathMove][] = []
  let cutMm = 0, linkMm = 0, rapidMm = 0, positiveMm = 0, negativeMm = 0
  let axialGougeMm = 0, rapidClearanceMm = Infinity, rapidAndLinkTimeMs = 0
  const rapidRate = 6000 // explicit desk control, not a machine performance claim
  for (let i = 1; i < linear.length; i++) {
    const a = linear[i - 1], b = linear[i]
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    if (b.type !== 'rapid') axialGougeMm = Math.max(axialGougeMm, bottom - Math.min(a.z, b.z))
    if (b.role === 'cut') {
      cutMm += length
      const projected = (b.x - a.x) * Math.cos(angle) + (b.y - a.y) * Math.sin(angle)
      positiveMm += Math.max(0, projected)
      negativeMm += Math.max(0, -projected)
      if (Math.abs(a.z - bottom) < 1e-9 && Math.abs(b.z - bottom) < 1e-9) segments.push([a, b])
    } else {
      if (b.type === 'rapid') rapidMm += length
      else linkMm += length
      rapidAndLinkTimeMs += length / (b.type === 'rapid' ? rapidRate : b.feed!) * 60000
    }
    if (b.type === 'rapid' && Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) {
      rapidClearanceMm = Math.min(rapidClearanceMm, Math.min(a.z, b.z) - retract)
    }
  }
  const paths = payload.loops.filter(path => path.closed)
  // Non-rest's largest-only rule is intentional; present [] means ALL outers.
  const outers = payload.regionHoles === undefined
    ? [paths.reduce((a, b) => Math.abs(nativeGeometry.signedArea(a.points)) > Math.abs(nativeGeometry.signedArea(b.points)) ? a : b)]
    : paths
  const holes = (payload.regionHoles ?? []).map((points, i) => ({ id: `hole-${i}`, closed: true, points }))
  const points = outers.flatMap(path => path.points)
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  let sampled = 0, uncovered = 0, maxResidualMm = 0
  for (let y = Math.min(...ys) + 0.5; y < Math.max(...ys); y += 1) {
    for (let x = Math.min(...xs) + 0.5; x < Math.max(...xs); x += 1) {
      const inside = (path: { id: string; closed: boolean; points: Point[] }) => {
        const answer = geometry.predicate({ x, y }, path)
        if (answer.status !== 'supported' || !answer.value) throw new Error('coverage predicate unavailable')
        return answer.value.location !== 'outside'
      }
      if (!outers.some(inside) || holes.some(inside)) continue
      sampled++
      const residual = Math.max(0, Math.min(...segments.map(([a, b]) => pointSegmentDistance({ x, y }, a, b))) - radius)
      maxResidualMm = Math.max(maxResidualMm, residual)
      if (residual > 0.005) uncovered++
    }
  }
  const cuts = moves.filter(move => move.role === 'cut')
  const engagement = cuts.flatMap(move => move.engagement === undefined ? [] : [move.engagement])
  const rates = resolveFeedrates(payload.tool, payload.feedrateOverride)
  return { sampled, uncovered, residualFraction: uncovered / sampled, maxResidualMm,
    axialGougeMm, rapidClearanceMm: Number.isFinite(rapidClearanceMm) ? rapidClearanceMm : null,
    cutMm, linkMm, rapidMm, positiveMm, negativeMm, rapidAndLinkTimeMs,
    cycleMs: estimateRuntimeMs(moves, rapidRate, rates.fastTraverseRate, rates.finishRate),
    maxEngagementMm: engagement.length ? Math.max(...engagement) : null,
    missingEngagement: cuts.length - engagement.length,
    outputBytes: Buffer.byteLength(JSON.stringify(moves)), moveCount: moves.length }
}

const observations: object[] = []
beforeAll(async () => {
  await faceClipper.ensureClipperReady()
  buildFaceToolpath(currentPayload(fixture()))
})
afterAll(() => {
  if (process.env.WO2944_CAPTURE !== '1') return
  const paths = [donorPath, 'src/kernel/planners/face.ts', 'src/kernel/planning.ts',
    'src/kernel/registry.ts', 'src/lib/cam/face2d/index.ts', 'src/lib/cam/face2d/clipperOffset.ts',
    'src/kernel/geometry/index.ts', 'src/kernel/geometry/adapters.ts', 'src/kernel/tools/model.ts',
    'src/tests/kernel/facePilot.wo2944.test.ts']
  writeFileSync('src/tests/evidence/WO-2944/comparison.json', JSON.stringify({
    scope: 'unit manifest/builder/service controls; NOT application-entry or board proof',
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    hashes: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    sampleGridMm: 1, observations,
  }, null, 2) + '\n')
})

const cases: { name: string; change?: (f: Fixture) => void }[] = [
  { name: 'saved journey stock, nonzero WCS Z' },
  { name: 'translated XY and 37 degree passes', change: f => {
    f.resolved.payload.loops = [rectangle('translated', 137, -83)]
    f.resolved.payload.params.passAngle = 37
    f.resolved.payload.wcsOrigin = { x: 137, y: -83, z: 16 }
  } },
  { name: 'concave slot and smooth links', change: f => {
    f.resolved.payload.loops = [loop('slot', [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 60 },
      { x: 50, y: 60 }, { x: 50, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 60 }, { x: 0, y: 60 }])]
    f.resolved.payload.params.transition = 'smooth'
  } },
  { name: 'inside containment and radial stock', change: f => {
    f.resolved.payload.params.boundaryContainment = 'inside'
    f.resolved.payload.params.stockOffset = 0.4
    f.resolved.payload.passes.stockToLeave = 0.2
  } },
  { name: 'offset rings', change: f => { f.resolved.payload.params.pattern = 'offset' } },
  { name: 'left hand one way', change: f => {
    f.input.tool.cutHand = 'left'
    f.resolved.payload.params.direction = 'climb'
    f.resolved.payload.params.pattern = 'one_way'
  } },
  { name: 'stepped finish and feed override', change: f => {
    f.resolved.payload.params.finishPass = true
    f.resolved.payload.passes.finishStepover = 1
    f.resolved.payload.feedrateOverride = { enabled: true, rpm: 18000, feedRate: 720,
      plungeRate: 180, rampFeedrate: 270, leadInFeedrate: 720,
      leadOutFeedrate: 720, fastTraverseFeedrate: 1000 }
  } },
  { name: 'resolved rest holes and disjoint outer', change: f => {
    f.resolved.payload.params.boundarySource = 'rest'
    f.resolved.payload.loops = [rectangle('main'), rectangle('other', 85, 0, 10, 10)]
    f.resolved.payload.regionHoles = [rectangle('removed', 15, 10, 25, 20).points]
  } },
]

describe('WO-2944 executable Face pilot', () => {
  it.each(cases)('compares physical output: $name', async ({ name, change }) => {
    const f = fixture()
    change?.(f)
    const payload = currentPayload(f)
    const start = performance.now()
    const current = buildFaceToolpath(payload)
    const currentMs = performance.now() - start
    const result = await createFacePlanner(dependencies(f))(f.input)
    const before = measure(current, payload), after = measure(result.moves, payload)
    observations.push({ name, payload, currentMs, kernelMs: result.computeTimeMs,
      current: before, kernel: after, currentMoves: current, kernelMoves: result.moves })
    expect(before.sampled).toBeGreaterThan(0)
    expect(after.residualFraction).toBeLessThanOrEqual(before.residualFraction)
    expect(after.maxResidualMm).toBeLessThanOrEqual(before.maxResidualMm + 0.005)
    expect(after.axialGougeMm).toBeLessThanOrEqual(1e-9)
    expect(after.rapidClearanceMm).toBe(before.rapidClearanceMm)
    if (after.rapidClearanceMm !== null) expect(after.rapidClearanceMm).toBeGreaterThanOrEqual(-1e-9)
    expect(after.maxEngagementMm).toBe(before.maxEngagementMm)
    expect(after.missingEngagement).toBe(before.missingEngagement)
    for (const key of ['cutMm', 'linkMm', 'rapidMm', 'positiveMm', 'negativeMm'] as const) {
      expect(Math.abs(after[key] - before[key]), key).toBeLessThanOrEqual(1e-6)
    }
    expect(Math.abs(after.cycleMs - before.cycleMs)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(after.rapidAndLinkTimeMs - before.rapidAndLinkTimeMs)).toBeLessThanOrEqual(0.01)
    expect(after.outputBytes).toBeLessThanOrEqual(before.outputBytes + Math.max(1024, before.outputBytes * 0.05))
    expect(result.computeTimeMs).toBeLessThan(5000)
    expect(result.resolvedHeights).toEqual(f.resolved.resolvedHeights)
    expect(result.resolvedHeightPlan).toEqual(f.resolved.resolvedHeightPlan)
    if (name.startsWith('saved journey')) {
      expect(after.uncovered).toBe(0)
      expect(after.positiveMm).toBeGreaterThan(0)
      expect(after.negativeMm).toBeGreaterThan(0)
      expect(result.moves.filter(move => move.role === 'cut').at(-1)!.z).toBe(11)
    }
    if (name === 'left hand one way') {
      expect(after.positiveMm).toBe(0)
      expect(after.negativeMm).toBeGreaterThan(0)
    }
    if (name === 'stepped finish and feed override') {
      expect(new Set(result.moves.filter(move => move.role === 'cut').map(move => move.feed))).toEqual(new Set([720]))
      expect(new Set(result.moves.filter(move => move.role === 'plunge').map(move => move.feed))).toEqual(new Set([180]))
    }
  })

  it('runs through a local kernel router, preserving shared services, exact tool and payload fields', async () => {
    const f = fixture(), untouched = structuredClone(f)
    const resolve = vi.fn(async (_input: PlanningInput, services: FacePlanningServices) => {
      expect(services).toEqual({ geometry, tools })
      return f.resolved
    })
    const build = vi.fn(buildFaceToolpath), current = vi.fn(), publish = vi.fn(), compare = vi.fn()
    const planner = createFacePlanner(dependencies(f, { resolve, build }))
    await createEngineRouter({ face: planner }, () => 'kernel').plan(f.input, current, publish, compare)
    expect(resolve).toHaveBeenCalledOnce()
    expect(build).toHaveBeenCalledExactlyOnceWith(f.request)
    expect(publish).toHaveBeenCalledOnce()
    expect(current).not.toHaveBeenCalled()
    expect(compare).not.toHaveBeenCalled()
    expect(f).toEqual(untouched)
    expect(publish.mock.calls[0][0].resolvedHeights).not.toBe(f.resolved.resolvedHeights)
    expect(publish.mock.calls[0][0].resolvedHeightPlan).not.toBe(f.resolved.resolvedHeightPlan)
    expect(kernelPlanners.face).toBeUndefined()
  })

  it('shadow plans real moves once and keeps current authoritative', async () => {
    const f = fixture(), events: string[] = []
    const current = vi.fn(async () => { events.push('current') })
    const publish = vi.fn(), compare = vi.fn((plan: KernelPlan) => {
      events.push('compare')
      expect(measure(plan.moves, currentPayload(f)).uncovered).toBe(0)
    })
    await createEngineRouter({ face: createFacePlanner(dependencies(f)) }, () => 'both')
      .plan(f.input, current, publish, compare)
    expect(events).toEqual(['current', 'compare'])
    expect(current).toHaveBeenCalledOnce()
    expect(compare).toHaveBeenCalledOnce()
    expect(publish).not.toHaveBeenCalled()
  })

  it.each(['resolver', 'readiness', 'builder', 'frame'] as const)('propagates %s failures with no fallback or publish', async failure => {
    const f = fixture(), error = new Error(`${failure} unavailable`)
    const fail = () => { throw error }
    const overrides = failure === 'resolver' ? { resolve: async () => fail() }
      : failure === 'readiness' ? { ready: async () => fail() }
      : failure === 'builder' ? { build: fail } : { assertCurrent: fail }
    const current = vi.fn(), publish = vi.fn(), compare = vi.fn()
    await expect(createEngineRouter({ face: createFacePlanner(dependencies(f, overrides)) }, () => 'kernel')
      .plan(f.input, current, publish, compare)).rejects.toBe(error)
    expect(current).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(compare).not.toHaveBeenCalled()
  })

  it.each(['ready', 'build'] as const)('rejects a frame revision changing during %s', async boundary => {
    const f = fixture(), publish = vi.fn(), build = vi.fn(buildFaceToolpath)
    const overrides = boundary === 'ready'
      ? { ready: async () => { f.resolved.frame.revision = 'stale' }, build }
      : { build: async (payload: FaceWorkerPayload) => {
        const moves = build(payload)
        f.resolved.frame.revision = 'stale'
        return moves
      } }
    await expect(createEngineRouter({ face: createFacePlanner(dependencies(f, overrides)) }, () => 'kernel')
      .plan(f.input, vi.fn(), publish, vi.fn())).rejects.toThrow('stale shared frame')
    expect(publish).not.toHaveBeenCalled()
    if (boundary === 'ready') expect(build).not.toHaveBeenCalled()
  })

  it('preserves absent versus present-empty rest holes and largest-only semantics', async () => {
    const f = fixture()
    f.resolved.payload.loops = [rectangle('main'), rectangle('remote', 100, 0, 10, 10)]
    const ordinary = await createFacePlanner(dependencies(f))(f.input)
    expect(Math.max(...ordinary.moves.map(move => move.x))).toBeLessThan(100)
    f.resolved.payload.regionHoles = []
    const rest = await createFacePlanner(dependencies(f))(f.input)
    expect(Math.max(...rest.moves.map(move => move.x))).toBeGreaterThan(110)
  })

  it.each(['entry', 'rest-offset', 'open'] as const)('preserves native %s refusals', async kind => {
    const f = fixture()
    if (kind === 'entry') f.resolved.payload.params.entryType = 'lead_in_arc'
    if (kind === 'rest-offset') {
      f.resolved.payload.params.pattern = 'offset'
      f.resolved.payload.regionHoles = [rectangle('hole', 10, 10, 10, 10).points]
    }
    if (kind === 'open') f.resolved.payload.loops = []
    let message = ''
    try { buildFaceToolpath(currentPayload(f)) } catch (error) { message = (error as Error).message }
    expect(message).toMatch(/^Face:/)
    await expect(createFacePlanner(dependencies(f))(f.input)).rejects.toThrow(message)
  })

  it('cannot construct a partial resolver or a different compatibility profile', () => {
    const f = fixture()
    expect(() => createFacePlanner(dependencies(f, { resolve: undefined }))).toThrow('complete resolver')
    expect(() => createFacePlanner(dependencies(f, { geometry: createGeometryService(scriptAdapter(nativeGeometry)) })))
      .toThrow('Face compatibility geometry profile')
  })

  it('does not plan another family or publish missing height metadata', async () => {
    const f = fixture(), build = vi.fn(buildFaceToolpath)
    f.input.operation.type = 'pocket_2d'
    await expect(createFacePlanner(dependencies(f, { build }))(f.input)).rejects.toThrow('only handles Face')
    f.input.operation.type = 'face'
    // Deliberately incomplete external resolver; the TypeScript contract also requires it.
    delete (f.resolved as Partial<ResolvedFaceInput<Frame>>).resolvedHeightPlan
    await expect(createFacePlanner(dependencies(f, { build }))(f.input)).rejects.toThrow('both resolved height metadata')
    expect(build).not.toHaveBeenCalled()
  })
})
