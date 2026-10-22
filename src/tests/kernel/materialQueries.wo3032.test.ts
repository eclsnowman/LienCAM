// WO-3032 (alpha.3 A3-10b): the kernel material queries at parity. Under the
// parity policy every kernel answer is compared with the answer today's code
// gives on the same inputs, through today's own entry points:
//   replay           remainingStockBefore           (src/store/toolReachInputs.ts)
//   2D rest air      skipAirOnlyPasses              (src/lib/cam/restAir2d.ts)
//   2.5D top of cut  highestMaterialOver + the store's prefix search (earlierMaterialStartFor)
//   3D air feeds     rapidAirFeedsOverRemovedStock  (src/cam3d/integration/airFeedOverRemovedStock.ts)
//   A.5 cells        collectAlpha3 + carveCoverage  (src/tests/benchmark, as scoreChain runs them)
//   hand-off         restStartStockFor              (src/cam3d/integration/adaptive3dOperation.ts)
//   polygon backend  remainingAbove                 (src/cam3d/stock/remainingAbove.ts), within one cell
//   reach(T)         assemblySweepBands             (src/lib/cam/holderClearance.ts, module-private: lifted)
// Fixtures: BL-282 loop JSON (test_fixtures/adaptive-clearing) cut by today's
// pocket engine; the A.5 multi-operation rows on the BL-281 procedural meshes,
// planned by the production store through planChain.
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Tool, ToolpathMove } from '../../types'
import type { LoopData, PocketParams, PocketWorkerPayload } from '../../lib/cam/types'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { skipAirOnlyPasses } from '../../lib/cam/restAir2d'
import { highestMaterialOver } from '../../lib/cam/smartHeights/earlierMaterial'
import { smartHeightEvidenceFingerprint } from '../../lib/cam/smartHeights/adaptive3d'
import { remainingStockBefore, type PrecedingOperationResult } from '../../store/toolReachInputs'
import { rapidAirFeedsOverRemovedStock } from '../../cam3d/integration/airFeedOverRemovedStock'
import { restStartStockFor, type RetainedRoughField } from '../../cam3d/integration/adaptive3dOperation'
import { DEFAULT_CELL_BUDGET, ZDexelField, remainingAbove } from '../../cam3d/stock'
import { boolean as geom2dBoolean, ensureGeom2dReady, offset as geom2dOffset, area as ringArea } from '../../cam3d/geom2d'
import { toolTypeMeta } from '../../lib/tool/toolMeta'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import { resolveFeedrates, resolveMoveFeedrate } from '../../lib/cam/feedrates'
import { cam3dAdapter, createGeometryService, fromRings, toRings } from '../../kernel/geometry'
import {
  PARITY_POLICY, PARITY_QUERY_POLICY, adaptiveChainFingerprint, adaptiveHandoff, airAlong, createMaterialLifecycle,
  dropCutterSpec, finishAirFeeds, polygonSnapshotAfter, reach, regionArea, regionPerimeter, remainingWithin,
  restAir2dPlan, smartTop2d, sweepHeight, sweepShape, topHeight, type AdaptiveHandoffFacts, type MaterialOperation,
  type MaterialSnapshot, type ReachComponent, type SweepShape, type ToolShapeSource,
} from '../../kernel/material'
import { makeTool } from '../post/helpers'

await ensureClipperReady()
await ensureGeom2dReady()

function source(tool: Tool): ToolShapeSource {
  return { tool, profileKind: toolTypeMeta(tool.type).profileKind, profile: buildToolProfile(tool) }
}

function shapeOf(tool: Tool): SweepShape {
  const shape = sweepShape(source(tool))
  if (!shape.ok) throw new Error(shape.reason)
  return shape.value
}

/** Today's StockState topZ and the kernel snapshot's columns, byte for byte. */
function sameColumns(snapshot: MaterialSnapshot, today: { nx: number; ny: number; resolutionMm: number; bottomZ: number; topZ: Float32Array }): boolean {
  const f = snapshot.field
  if (f.nx !== today.nx || f.ny !== today.ny || f.cell !== today.resolutionMm || f.bottom[0] !== today.bottomZ) return false
  return Buffer.from(f.top.buffer, f.top.byteOffset, f.top.byteLength).equals(Buffer.from(today.topZ.buffer, today.topZ.byteOffset, today.topZ.byteLength))
}

function toPreceding(ops: readonly MaterialOperation[]): PrecedingOperationResult[] {
  return ops.map(op => ({ enabled: op.enabled, status: op.status, toolpathMoves: op.moves, tool: op.tool }))
}

// ─── BL-282 2D chains: today's pocket engine on the adaptive-clearing loops ──────

const STOCK_TOP = 0
const STOCK_BOTTOM = -10
const RETRACT_Z = 5

interface Bl282 { name: string; stock: { x: number; y: number }[]; boundary: { x: number; y: number }[] }
const BL282 = ['Bar', 'BootL', 'Tee', 'Triangle', 'Kidney'].map(name =>
  ({ ...(JSON.parse(readFileSync(`test_fixtures/adaptive-clearing/${name}_fixture.json`, 'utf8')) as Bl282), name }))

function flat(diameter: number, id = `flat-${diameter}`): Tool {
  return makeTool({ id, name: `${diameter} mm flat`, type: 'flat_end_mill', diameter, fluteLength: 20, shankDiameter: diameter, overallLength: 60 })
}

function pocket(loop: LoopData, tool: Tool, stockToLeave: number, bottom: number): ToolpathMove[] {
  const params = {
    geometryId: 'geometry', loopIds: [loop.id], direction: 'climb', orderStrategy: 'by_depth', fillStrategy: 'outside_in',
    floorStockToLeave: 0, finishContour: false, helixDiameter: 80, overlapMm: 0, stepoverLeadIn: 'none',
    stayDown: false, stayDownLift: 0.6,
  } as PocketParams
  const payload = {
    opId: 'op', setupId: 'setup', params,
    heights: { clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: RETRACT_Z, feedHeight: 1,
      topHeight: STOCK_TOP, topHeightMode: 'absolute', bottomHeight: bottom, bottomHeightMode: 'absolute' },
    passes: { stepdown: 2.5, stepover: tool.diameter * 0.4, stockToLeave, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: { entryType: 'ramp_linear', rampAngle: 3, rampLength: 8, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'minimum', transitionType: 'avoid_stock' },
    tool, loops: [loop], wcsOrigin: { x: 0, y: 0, z: 0 },
  } as unknown as PocketWorkerPayload
  return buildPocketToolpath(payload)
}

/** A drilled hole as the drill engine leaves it: rapid over, plunge, rapid out. */
function drillMoves(points: { x: number; y: number }[], depth: number): ToolpathMove[] {
  return points.flatMap(p => [
    { type: 'rapid', x: p.x, y: p.y, z: RETRACT_Z, role: 'rapid' },
    { type: 'feed', x: p.x, y: p.y, z: depth, role: 'plunge' },
    { type: 'rapid', x: p.x, y: p.y, z: RETRACT_Z, role: 'rapid' },
  ] as ToolpathMove[])
}

interface Chain2d {
  name: string
  stock: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
  ops: MaterialOperation[]
  finish: { index: number; moves: ToolpathMove[]; tool: Tool }
  region: { minX: number; minY: number; maxX: number; maxY: number }
}

function chain2d(fixture: Bl282): Chain2d {
  const xs = fixture.stock.map(p => p.x), ys = fixture.stock.map(p => p.y)
  const stock = { minX: Math.min(...xs), minY: Math.min(...ys), minZ: STOCK_BOTTOM, maxX: Math.max(...xs), maxY: Math.max(...ys), maxZ: STOCK_TOP }
  const loop: LoopData = { id: 'boundary', closed: true, type: 'contour', points: fixture.boundary.map(p => ({ x: p.x, y: p.y })) }
  const bx = loop.points.map(p => p.x), by = loop.points.map(p => p.y)
  const region = { minX: Math.min(...bx), minY: Math.min(...by), maxX: Math.max(...bx), maxY: Math.max(...by) }
  const rougher = flat(6, 'rough-6')
  const finisher = flat(6, 'finish-6')
  const spot = makeTool({ id: 'spot', name: 'spot', type: 'spot_drill', diameter: 6, angleFromAxisDeg: 45, fluteLength: 10, shankDiameter: 6, overallLength: 50 })
  const holes = [{ x: (region.minX + region.maxX) / 2, y: (region.minY + region.maxY) / 2 }, { x: region.minX + 8, y: region.minY + 8 }]
  const rough = pocket(loop, rougher, 0.4, -5)
  const shallow = pocket(loop, flat(4, 'shallow-4'), 0.2, -2.5)
  const finish = pocket(loop, finisher, 0, -5)
  const ops: MaterialOperation[] = [
    { id: 'rough', type: 'pocket_2d', enabled: true, status: 'ready', tool: rougher, moves: rough },
    { id: 'spot', type: 'drill', enabled: true, status: 'ready', tool: spot, moves: drillMoves(holes, -6) },
    { id: 'disabled', type: 'pocket_2d', enabled: false, status: 'ready', tool: flat(10), moves: finish },
    { id: 'failed', type: 'pocket_2d', enabled: true, status: 'error', tool: flat(10), moves: finish },
    { id: 'chamfer', type: 'chamfer', enabled: true, status: 'ready', tool: makeTool({ id: 'v', type: 'v_bit', diameter: 6 }), moves: finish },
    { id: 'shallow', type: 'pocket_2d', enabled: true, status: 'ready', tool: flat(4, 'shallow-4'), moves: shallow },
    { id: 'finish', type: 'pocket_2d', enabled: true, status: 'ready', tool: finisher, moves: finish },
    { id: 'after', type: 'pocket_2d', enabled: true, status: 'pending', tool: finisher, moves: undefined },
  ]
  return { name: fixture.name, stock, ops, finish: { index: 6, moves: finish, tool: finisher }, region }
}

const CHAINS_2D = BL282.map(chain2d)

/** Today's skipAirOnlyPasses output rebuilt from the kernel's decisions (lift + rapid links, floor hop 0). */
function emitFromPlan(moves: readonly ToolpathMove[], plan: ReturnType<typeof restAir2dPlan>): ToolpathMove[] {
  const starts = new Map(plan.droppedBlocks.map(([a, b]) => [a, b]))
  const links = new Set(plan.airLinks)
  const out: ToolpathMove[] = []
  for (let index = 0; index < moves.length;) {
    const end = starts.get(index)
    if (end !== undefined) {
      const from = moves[index - 1]
      if (from.z < RETRACT_Z - 1e-9) out.push({ type: 'rapid', x: from.x, y: from.y, z: RETRACT_Z, role: 'rapid' })
      index = end + 1
      continue
    }
    const move = moves[index]
    out.push(links.has(index) ? { type: 'rapid', x: move.x, y: move.y, z: move.z, role: 'rapid' } : move)
    index++
  }
  return out
}

describe('WO-3032 kernel material queries at parity: BL-282 2D chains', () => {
  it('snapshotBefore(N) is today\'s remainingStockBefore, column for column, for every operation of every chain', () => {
    const mismatches: string[] = []
    for (const chain of CHAINS_2D) {
      const lifecycle = createMaterialLifecycle({ stock: chain.stock })
      const block = { min: { x: chain.stock.minX, y: chain.stock.minY, z: chain.stock.minZ }, max: { x: chain.stock.maxX, y: chain.stock.maxY, z: chain.stock.maxZ } }
      for (let n = 0; n <= chain.ops.length; n++) {
        const today = remainingStockBefore(toPreceding(chain.ops.slice(0, n)), block)
        const kernel = lifecycle.snapshotBefore(chain.ops, n)
        if (!today) { if (kernel.operationsReplayed !== 0) mismatches.push(`${chain.name}@${n}: today replayed nothing`); continue }
        if (today.operationsReplayed !== kernel.operationsReplayed) mismatches.push(`${chain.name}@${n}: replayed ${kernel.operationsReplayed} vs ${today.operationsReplayed}`)
        if (!sameColumns(kernel, today.stock)) mismatches.push(`${chain.name}@${n}: columns differ`)
      }
      // The drill counted down to its full diameter, and the not-replayed operations said so.
      const all = lifecycle.snapshotAfter(chain.ops, chain.ops.length - 1)
      expect(all.replayedIds).toEqual(['rough', 'spot', 'shallow', 'finish'])
      expect(all.notes.some(n => n.startsWith('failed: not computed'))).toBe(true)
      expect(all.notes.some(n => n.startsWith('chamfer: tool v_bit is not replayed'))).toBe(true)
    }
    expect(mismatches).toEqual([])
  }, 120_000)

  it('2D rest air: the kernel\'s decisions are today\'s skipAirOnlyPasses, pass for pass and link for link', () => {
    const rows: string[] = []
    let skipped = 0, links = 0
    for (const chain of CHAINS_2D) {
      const lifecycle = createMaterialLifecycle({ stock: chain.stock })
      const block = { min: { x: chain.stock.minX, y: chain.stock.minY, z: chain.stock.minZ }, max: { x: chain.stock.maxX, y: chain.stock.maxY, z: chain.stock.maxZ } }
      for (const subject of [chain.finish, { index: 5, moves: chain.ops[5].moves!, tool: chain.ops[5].tool! }]) {
        const today = remainingStockBefore(toPreceding(chain.ops.slice(0, subject.index)), block)!
        const expected = skipAirOnlyPasses({ moves: subject.moves, tool: subject.tool, remaining: today.stock, retractZ: RETRACT_Z, floorHopMm: 0 })
        const plan = restAir2dPlan(lifecycle.snapshotBefore(chain.ops, subject.index), subject.moves, subject.tool, RETRACT_Z)
        const got = { passes: plan.passes, skippedPasses: plan.skippedPasses, rapidedLinks: plan.rapidedLinks, cutLengthRemovedMm: plan.cutLengthRemovedMm }
        const want = { passes: expected.passes, skippedPasses: expected.skippedPasses, rapidedLinks: expected.rapidedLinks, cutLengthRemovedMm: expected.cutLengthRemovedMm }
        if (JSON.stringify(got) !== JSON.stringify(want)) rows.push(`${chain.name}@${subject.index}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`)
        expect(emitFromPlan(subject.moves, plan)).toEqual(expected.moves)
        skipped += plan.skippedPasses
        links += plan.rapidedLinks
      }
    }
    expect(rows).toEqual([])
    // The fixtures exercise the rule: passes really are dropped.
    expect(skipped).toBeGreaterThan(0)
    console.info(`[WO-3032] 2D rest air parity: ${skipped} passes dropped, ${links} links at rapid over ${CHAINS_2D.length} BL-282 chains`)
  }, 120_000)

  it('2.5D top of cut: Smart Top\'s material start and source operation, from snapshotBefore + topHeight', () => {
    const rows: string[] = []
    for (const chain of CHAINS_2D) {
      const lifecycle = createMaterialLifecycle({ stock: chain.stock })
      const block = { min: { x: chain.stock.minX, y: chain.stock.minY, z: chain.stock.minZ }, max: { x: chain.stock.maxX, y: chain.stock.maxY, z: chain.stock.maxZ } }
      const cx = (chain.region.minX + chain.region.maxX) / 2, cy = (chain.region.minY + chain.region.maxY) / 2
      const regions = [chain.region, { minX: cx - 5, minY: cy - 5, maxX: cx + 5, maxY: cy + 5 },
        { minX: chain.region.minX + 4, minY: chain.region.minY + 4, maxX: chain.region.minX + 6, maxY: chain.region.minY + 6 },
        { minX: chain.stock.minX, minY: chain.stock.minY, maxX: chain.stock.minX + 1, maxY: chain.stock.minY + 1 }]
      for (let n = 0; n < chain.ops.length; n++) {
        for (const region of regions) {
          // Today's earlierMaterialStartFor, on today's primitives.
          let want: { materialTopZ: number; sourceIndex: number } | undefined
          const preceding = toPreceding(chain.ops.slice(0, n))
          const remaining = n > 0 ? remainingStockBefore(preceding, block) : undefined
          const highest = remaining ? highestMaterialOver(remaining.stock, region) : undefined
          if (remaining && highest !== undefined && highest < block.max.z - 1e-6) {
            let sourceIndex = n - 1
            for (let count = 1; count <= n; count++) {
              const prefix = remainingStockBefore(preceding.slice(0, count), block)
              const prefixTop = prefix ? highestMaterialOver(prefix.stock, region) : undefined
              if (prefixTop !== undefined && prefixTop <= highest + 1e-9) { sourceIndex = count - 1; break }
            }
            want = { materialTopZ: Math.min(block.max.z, Math.max(block.min.z, highest)), sourceIndex }
          }
          const got = smartTop2d(lifecycle, chain.ops, n, region)
          if (JSON.stringify(got) !== JSON.stringify(want)) rows.push(`${chain.name}@${n} ${JSON.stringify(region)}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`)
          if (remaining) expect(topHeight(lifecycle.snapshotBefore(chain.ops, n), region)).toBe(highestMaterialOver(remaining.stock, region))
        }
      }
    }
    expect(rows).toEqual([])
  }, 120_000)

  it('polygon backend: each level\'s remaining region is today\'s remainingAbove trace within one cell of its boundary', () => {
    const service = createGeometryService(cam3dAdapter({ offset: geom2dOffset, boolean: geom2dBoolean }))
    const rows: string[] = []
    for (const chain of CHAINS_2D.slice(0, 3)) {
      const block = { min: { x: chain.stock.minX, y: chain.stock.minY, z: chain.stock.minZ }, max: { x: chain.stock.maxX, y: chain.stock.maxY, z: chain.stock.maxZ } }
      const levels = [-5.5, -4.9, -3, -2.4, -0.5]
      const n = chain.ops.length - 1
      const today = remainingStockBefore(toPreceding(chain.ops), block)!.stock
      const field = ZDexelField.fromColumnTops({ originX: today.bounds.minX, originY: today.bounds.minY, nx: today.nx, ny: today.ny, cell: today.resolutionMm }, today.topZ, today.bottomZ)
      const poly = polygonSnapshotAfter(service, chain.stock, levels, chain.ops, n)
      expect(poly.operationsReplayed).toBe(4)
      levels.forEach((z, i) => {
        const traced = remainingAbove(field, z)
        const kernelRings = toRings(poly.regions[i])
        const xor = traced.length && kernelRings.length ? geom2dBoolean(traced, kernelRings, 'xor') : [...traced, ...kernelRings]
        const xorArea = Math.abs(xor.reduce((s, r) => s + ringArea(r), 0))
        const perimeter = regionPerimeter(poly.regions[i]) + regionPerimeter(fromRings(traced))
        const tracedArea = traced.reduce((s, r) => s + ringArea(r), 0)
        // One cell either side of the boundary, nothing more.
        if (xorArea > perimeter * today.resolutionMm) rows.push(`${chain.name} z ${z}: xor ${xorArea.toFixed(2)} > ${(perimeter * today.resolutionMm).toFixed(2)} (areas ${regionArea(poly.regions[i]).toFixed(1)} / ${tracedArea.toFixed(1)})`)
      })
    }
    expect(rows).toEqual([])
  }, 300_000)
})

// ─── A.5 multi-operation rows (BL-281 meshes), planned by the production store ──

/** collectAlpha3 publishes every number rounded to 1e-6 (metrics.alpha3.ts round). */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

const A5_CHAINS = ['stepped-boss-rough-finish-declared', 'engagement-pocket-rest-pencil-declared', 'boss-taper-step-rough-finish-declared']

interface PlannedA5 {
  id: string
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
  cell: number
  surfaceZ: Float64Array
  steps: { stepId: string; type: string; tool: Tool | undefined; planned: import('../benchmark/chainRunner').PlannedStep }[]
}

const planned: PlannedA5[] = []

beforeAll(async () => {
  const { alpha3Chains, toolById } = await import('../benchmark/registry')
  const { inventoryTools } = await import('../benchmark/alpha3Registry')
  const { chainScene, planChain } = await import('../benchmark/chainRunner')
  const { surfaceHeightField } = await import('../benchmark/metrics')
  for (const id of A5_CHAINS) {
    const chain = alpha3Chains().find(c => c.id === id)
    if (!chain) throw new Error(`A.5 chain ${id} is not in the registry`)
    const plan = await planChain(chain)
    const { part, mesh, box } = await chainScene(chain)
    const surfaceZ = await surfaceHeightField(mesh, ZDexelField.fromBox(box, part.coverageCell))
    planned.push({ id, box, cell: part.coverageCell, surfaceZ, steps: chain.steps.map(step => {
      const spec = toolById(step.toolId)
      return { stepId: step.id, type: step.type, tool: spec.libraryTool ? inventoryTools([spec.libraryTool])[0] : undefined,
        planned: plan.steps.find(s => s.stepId === step.id)! }
    }) })
  }
}, 600_000)

function a5Ops(chain: PlannedA5): MaterialOperation[] {
  return chain.steps.map(s => ({ id: s.stepId, type: s.type, enabled: true,
    status: s.planned.status === 'ready' && s.planned.moves.length > 0 ? 'ready' : (s.planned.status ?? 'n/a'),
    tool: s.tool, moves: s.planned.moves }))
}

describe('WO-3032 kernel material queries at parity: A.5 multi-operation rows', () => {
  it('M-SAFE-2, M-AIR-1, M-AIR-2 and M-PART-1 from kernel snapshots equal scoreChain\'s collectAlpha3 and carveCoverage', async () => {
    const { collectAlpha3 } = await import('../benchmark/metrics.alpha3')
    const { carveCoverage, UNCUT_TOLERANCE_MM } = await import('../benchmark/metrics')
    const { toolToCutterSpec } = await import('../../cam3d/integration/cutterSpec')
    const rows: string[] = []
    let measured = 0
    for (const chain of planned) {
      const field = ZDexelField.fromBox(chain.box, chain.cell)
      const ops = a5Ops(chain)
      const lifecycle = createMaterialLifecycle({ stock: chain.box, grid: { cellMm: chain.cell, budget: DEFAULT_CELL_BUDGET } })
      chain.steps.forEach((step, k) => {
        if (ops[k].status !== 'ready' || !step.tool) return
        const plan = step.planned
        const cutter = toolToCutterSpec(step.tool)
        const today = collectAlpha3({ planned: plan, tool: step.tool, opType: step.type, stock: { field, bounds: chain.box, cutter },
          slotFeed: step.type.startsWith('adaptive') ? 0 : undefined })
        const coverage = carveCoverage({ field, surfaceZ: chain.surfaceZ, cutter, moves: plan.moves })
        const before = lifecycle.snapshotBefore(ops, k)
        const along = airAlong(before, plan.moves, shapeOf(step.tool))
        const feeds = resolveFeedrates(step.tool, plan.settings?.feedrateOverride, 8000)
        let airMs = 0, timed = true
        for (let i = 1; i < plan.moves.length; i++) {
          if (!along.air[i]) continue
          const feed = resolveMoveFeedrate(plan.moves[i], feeds)
          if (feed !== undefined && feed > 0) airMs += along.lengthMm[i] / feed * 60000
          else timed = false
        }
        const kernel = {
          'M-SAFE-2': round6(along.nonCuttingIntrusionMm),
          'M-AIR-1': round6(along.airLengthMm),
          'M-AIR-2': timed && plan.cutTimeMs !== undefined && plan.cutTimeMs > 0 ? round6(airMs / plan.cutTimeMs * 100) : today.metrics['M-AIR-2'],
          'M-PART-1': remainingWithin(lifecycle.snapshotAfter(ops, k), { floorZ: chain.surfaceZ, minThicknessMm: UNCUT_TOLERANCE_MM }).areaMm2,
        }
        const want = { 'M-SAFE-2': today.metrics['M-SAFE-2'], 'M-AIR-1': today.metrics['M-AIR-1'], 'M-AIR-2': today.metrics['M-AIR-2'], 'M-PART-1': coverage.uncutAreaMm2 }
        if (JSON.stringify(kernel) !== JSON.stringify(want)) rows.push(`${chain.id}/${step.stepId}: ${JSON.stringify(kernel)} vs ${JSON.stringify(want)}`)
        // The snapshot after this step is the chain's carried field.
        if (!Buffer.from(lifecycle.snapshotAfter(ops, k).field.top.buffer).equals(Buffer.from(field.top.buffer))) rows.push(`${chain.id}/${step.stepId}: carried field differs`)
        measured++
      })
    }
    expect(rows).toEqual([])
    expect(measured).toBeGreaterThanOrEqual(6)
  }, 600_000)

  it('3D air feed demotions: finishAirFeeds demotes exactly the moves rapidAirFeedsOverRemovedStock demotes', () => {
    const rows: string[] = []
    let demoted = 0, candidates = 0
    for (const chain of planned) {
      const ops = a5Ops(chain)
      const block = { min: { x: chain.box.minX, y: chain.box.minY, z: chain.box.minZ }, max: { x: chain.box.maxX, y: chain.box.maxY, z: chain.box.maxZ } }
      const lifecycle = createMaterialLifecycle({ stock: chain.box })
      const finisher = makeTool({ id: 'ball-3', name: 'ball 3', type: 'ball_end_mill', diameter: 3, fluteLength: 12, shankDiameter: 3, overallLength: 50 })
      const raster: ToolpathMove[] = []
      for (const z of [chain.box.maxZ - 0.5, (chain.box.maxZ + chain.box.minZ) / 2, chain.box.minZ + 3]) {
        for (let y = chain.box.minY + 2, row = 0; y < chain.box.maxY - 2; y += 3.1, row++) {
          const [x0, x1] = row % 2 ? [chain.box.maxX - 1, chain.box.minX + 1] : [chain.box.minX + 1, chain.box.maxX - 1]
          raster.push({ type: 'rapid', x: x0, y, z: chain.box.maxZ + 5, role: 'rapid' }, { type: 'feed', x: x0, y, z, role: 'plunge' })
          for (let s = 1; s <= 8; s++) raster.push({ type: 'feed', x: x0 + (x1 - x0) * s / 8, y, z, role: 'cut' })
          raster.push({ type: 'rapid', x: x1, y, z: chain.box.maxZ + 5, role: 'rapid' })
        }
      }
      const subjects: { name: string; at: number; moves: readonly ToolpathMove[]; tool: Tool }[] = [{ name: 'raster', at: ops.length, moves: raster, tool: finisher }]
      ops.forEach((op, k) => { if (k > 0 && op.status === 'ready' && op.tool) subjects.push({ name: op.id, at: k, moves: op.moves!, tool: op.tool }) })
      for (const subject of subjects) {
        const preceding = toPreceding(ops.slice(0, subject.at))
        const remaining = remainingStockBefore(preceding, block)
        if (!remaining) continue
        const today = rapidAirFeedsOverRemovedStock({ moves: subject.moves, tool: subject.tool, remaining: remaining.stock, preceding, floorHopMm: 0 })
        const wantDemoted = today.moves.flatMap((m, i) => (m.type === 'rapid' && subject.moves[i].type === 'feed' ? [i] : []))
        const spec = dropCutterSpec(source(subject.tool))
        if (!spec.ok) throw new Error(spec.reason)
        const got = finishAirFeeds(lifecycle.snapshotBefore(ops, Math.min(subject.at, ops.length)), {
          moves: subject.moves, cutter: spec.value, fluteLength: subject.tool.fluteLength, shankDiameter: subject.tool.shankDiameter,
          preceding: ops.slice(0, subject.at).map(op => {
            const c = op.tool ? dropCutterSpec(source(op.tool)) : undefined
            return { enabled: op.enabled, status: op.status, moves: op.moves, cutter: c?.ok ? c.value : undefined, fluteLength: op.tool?.fluteLength }
          }),
        })
        if (got.candidates !== today.candidates || JSON.stringify(got.demoted) !== JSON.stringify(wantDemoted)) {
          rows.push(`${chain.id}/${subject.name}: ${got.candidates}/${got.demoted.length} vs ${today.candidates}/${wantDemoted.length}`)
        }
        demoted += got.demoted.length
        candidates += got.candidates
      }
    }
    expect(rows).toEqual([])
    expect(demoted).toBeGreaterThan(0)
    console.info(`[WO-3032] 3D air feed parity: ${demoted} of ${candidates} fed moves demoted, identical to today`)
  }, 600_000)
})

// ─── adjacent-roughs-only hand-off ───────────────────────────────────────────────

describe('WO-3032 kernel material queries at parity: hand-off and reach', () => {
  it('the adaptive_3d hand-off is today\'s restStartStockFor on every combination of the facts it reads', () => {
    const client = {} as RetainedRoughField['client']
    const other = {} as RetainedRoughField['client']
    const handle = { id: 'h' } as unknown as RetainedRoughField['handle']
    const box = { minX: 0, minY: 0, minZ: 0, maxX: 50, maxY: 40, maxZ: 20 }
    const prevs = [undefined, ...['adaptive_3d', 'parallel_3d', 'pocket_2d'].flatMap(type => [true, false].flatMap(enabled =>
      ['ready', 'outdated', 'error'].map(status => ({ id: 'rough', type, enabled, status }))))]
    const variants: [string, (r: RetainedRoughField) => Partial<RetainedRoughField>][] = [
      ['same', () => ({})], ['other client', () => ({ client: other })], ['other setup', () => ({ setupId: 's2' })],
      ['other op', () => ({ opId: 'x' })], ['other solid', () => ({ geometryId: 'g2' })], ['other cell', () => ({ cellSize: 0.75 })],
      ['other chain', () => ({ upstreamChainFingerprint: 'f2' })],
      ...(['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'] as const).map(k => [`box ${k}`, (r: RetainedRoughField) => ({ stockBounds: { ...r.stockBounds, [k]: r.stockBounds[k] + 0.001 } })] as [string, (r: RetainedRoughField) => Partial<RetainedRoughField>]),
      ['NaN box', r => ({ stockBounds: { ...r.stockBounds, maxZ: NaN } })],
    ]
    let retainedCount = 0, total = 0
    for (const previous of prevs) {
      for (const retainedPresent of [true, false]) {
        for (const [label, vary] of variants) {
          for (const geometryId of ['g1', undefined]) {
            const base: RetainedRoughField = { client, handle, setupId: 's1', opId: 'rough', geometryId: 'g1', stockBounds: box, cellSize: 0.5, upstreamChainFingerprint: 'f1' }
            const retained = retainedPresent ? { ...base, ...vary(base) } : undefined
            const today = restStartStockFor({ retained, client, setupId: 's1', previousOp: previous as never, geometryId, stockBounds: box, cellSize: 0.5, upstreamChainFingerprint: 'f1' })
            const facts: AdaptiveHandoffFacts = {
              ...(retained ? { retained: { sameClient: retained.client === client, setupId: retained.setupId, opId: retained.opId, geometryId: retained.geometryId,
                stockBounds: retained.stockBounds, cellSize: retained.cellSize, upstreamChainFingerprint: retained.upstreamChainFingerprint } } : {}),
              setupId: 's1', ...(previous ? { previous } : {}), geometryId, stockBounds: box, cellSize: 0.5, upstreamChainFingerprint: 'f1',
            }
            const kernel = adaptiveHandoff(facts)
            expect(kernel.source === 'retained-field', `${label} ${JSON.stringify(previous)} retained=${retainedPresent} geometry=${geometryId}`).toBe(today !== undefined)
            if (kernel.source !== 'retained-field') expect(kernel.source).toBe('stock-box')
            if (today !== undefined) retainedCount++
            total++
          }
        }
      }
    }
    expect(retainedCount).toBeGreaterThan(0)
    expect(total - retainedCount).toBeGreaterThan(0)
  })

  it('the upstream chain fingerprint is the store\'s adaptive3dMaterialChainFingerprint record, value for value', () => {
    const store = readFileSync('src/store/index.ts', 'utf8')
    const body = store.slice(store.indexOf('function adaptive3dMaterialChainFingerprint'))
    const record = body.slice(body.indexOf('.map(operation => ({') + 20, body.indexOf('})))'))
    const fields = [...record.matchAll(/(\w+): operation\.(\w+)/g)].map(m => [m[1], m[2]])
    expect(fields.every(([a, b]) => a === b)).toBe(true)
    expect(fields.map(([a]) => a)).toEqual(['id', 'type', 'status', 'toolId', 'geometrySelections', 'params', 'smartHeight', 'generationFingerprint'])
    expect(body.slice(0, body.indexOf('.map('))).toContain('.filter(operation => operation.enabled)')
    const ops = [
      { id: 'a', type: 'adaptive_3d', status: 'ready', enabled: true, toolId: 't1', geometrySelections: ['g'], params: { stepover: 1 }, generationFingerprint: 'x' },
      { id: 'b', type: 'parallel_3d', status: 'outdated', enabled: false, toolId: 't2', geometrySelections: ['g'], params: {} },
      { id: 'c', type: 'pocket_2d', status: 'ready', enabled: true, toolId: 't3', geometrySelections: [], params: { a: [1, 2] }, smartHeight: { v: 1 } },
    ]
    const want = smartHeightEvidenceFingerprint(ops.filter(o => o.enabled).map(o => Object.fromEntries(fields.map(([k]) => [k, (o as Record<string, unknown>)[k]]))))
    expect(adaptiveChainFingerprint(ops)).toBe(want)
  })

  it('reach(T): the assembly bands are today\'s assemblySweepBands; the head-only shape is recorded and OFF', () => {
    const text = readFileSync('src/lib/cam/holderClearance.ts', 'utf8')
    const file = ts.createSourceFile('holderClearance.ts', text, ts.ScriptTarget.ES2020, true)
    const fn = (name: string) => {
      const decl = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)
      if (!decl) throw new Error(`${name} not found`)
      return ts.transpileModule(decl.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
    }
    const gouge = Number(/const GOUGE_TOLERANCE_MM = ([\d.]+)/.exec(text)![1])
    const assemblySweepBands = new Function('buildToolProfile', 'GOUGE_TOLERANCE_MM', `${fn('headBandsFor')}\n${fn('assemblySweepBands')}\nreturn assemblySweepBands`)(buildToolProfile, gouge) as
      (tool: Tool, profile: unknown, upper: readonly ReachComponent[], neck?: { bottomMm: number; topMm: number }) => ReachComponent[]
    const tools: Tool[] = [
      makeTool({ type: 'flat_end_mill', diameter: 6, fluteLength: 18, shankDiameter: 6, overallLength: 60 }),
      makeTool({ type: 'flat_end_mill', diameter: 4, fluteLength: 8, shankDiameter: 6, neckDiameter: 3.6, shoulderLength: 10, overallLength: 50 }),
      makeTool({ type: 'ball_end_mill', diameter: 3, fluteLength: 9, shankDiameter: 4, overallLength: 50 }),
      makeTool({ type: 'bull_nose', diameter: 10, cornerRadius: 1, fluteLength: 25, shankDiameter: 10, overallLength: 70 }),
      makeTool({ type: 'v_bit', diameter: 12, angleFromAxisDeg: 45, fluteLength: 10, shankDiameter: 8, overallLength: 50 }),
      makeTool({ type: 'lollipop_mill', diameter: 6, fluteLength: 5, shankDiameter: 6, neckDiameter: 3, shoulderLength: 12, overallLength: 50 }),
      makeTool({ type: 'drill', diameter: 5, fluteLength: 30, shankDiameter: 5, overallLength: 70 }),
    ]
    const upper: ReachComponent[] = [{ kind: 'shank', bottomOffsetMm: 20, topOffsetMm: 40, diameterMm: 6 }, { kind: 'holder', bottomOffsetMm: 40, diameterMm: 32 }]
    for (const tool of tools) {
      for (const neck of [undefined, { bottomMm: 4, topMm: 12 }]) {
        const kernel = reach(source(tool), { upper, ...(neck ? { neck } : {}) })
        expect(kernel.components, tool.type).toEqual(assemblySweepBands(tool, buildToolProfile(tool), upper, neck))
        expect(kernel.cuttingReachMm).toBe(buildToolProfile(tool).cuttingMaxZ)
      }
    }
    // Part a's lollipop note: the head-only shape is wider than the neck-limited sweep, recorded, not used.
    const lolli = reach(source(tools[5]))
    const neckLimited = shapeOf(tools[5])
    expect(lolli.headOnly?.shape.radius).toBeCloseTo(3, 3)
    expect(sweepHeight(lolli.headOnly!.shape, 2.5)).toBeLessThan(4)
    expect(sweepHeight(neckLimited, 2.5)).toBeGreaterThan(17)
    expect(lolli.headOnly!.note).toContain('recorded, not used')
    for (const t of tools.slice(0, 5)) expect(reach(source(t)).headOnly, t.type).toBeUndefined()
    expect(PARITY_QUERY_POLICY).toEqual({ head_only_reach_shape: false })
    expect(PARITY_POLICY).toEqual({ removed_definition: 'centre', single_air_rule: false, top_of_cut_from_material: false, non_adjacent_handoff: false, profile_replay: false })
  })
})
