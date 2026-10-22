// WO-2902: test-side observations. Never trim a path, gate an operator or alter moves.
import type { Tool, ToolHolder, ToolpathMove } from '../../types'
import type { CutterSpec } from '../../cam3d/kernel/types'
import { removeSweep, type Box3, type ZDexelField } from '../../cam3d/stock'
import { maxTraverseIntrusion, plungeUncutFraction } from '../../cam3d/stock/traverseClearance'
import { forEachLinearSweep, replaySagittaFor } from '../../cam3d/rough/replayStock'
import { measurePathEngagement } from '../../cam3d/rough/pathEngagement'
import { effectiveMoveMotion, effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'
import { checkHolderClearanceForToolpath } from '../../lib/cam/holderClearanceGate'
import { assertToolFluteReach } from '../../lib/cam/toolFluteReach'
import { resolveFeedrates, resolveMoveFeedrate } from '../../lib/cam/feedrates'
import { emitProgram } from '../../lib/post/emit'
import { BUILT_IN_DIALECTS } from '../../lib/post'
const POSTS = BUILT_IN_DIALECTS.filter(config => config.builtin)
import { makeMachine, makeOp, makeWcs } from '../post/helpers'
import { moveLength, pathMetrics, toIrMoves, type Point3 } from './metrics'
import { notApplicable, type MetricValue } from './metricRegistry'
import type { PlannedStep } from './chainRunner'

export const COLLECTOR_KEYS = ['M-SAFE-2', 'M-SAFE-4', 'M-SAFE-5', 'M-SAFE-6',
  'M-LOAD-4', 'M-LOAD-5', 'M-LOAD-7', 'M-GEOM-2', 'M-GEOM-2.mean', 'M-GEOM-3', 'M-GEOM-4',
  'M-ENTRY-1', 'M-ENTRY-2', 'M-ENTRY-3', 'M-ENTRY-3.length', 'M-ENTRY-4',
  'M-ENTRY-4.outside', 'M-ENTRY-4.cleared', 'M-ENTRY-4.helix', 'M-ENTRY-4.ramp', 'M-ENTRY-4.plunge',
  'M-ENTRY-5', 'M-ENTRY-6', 'M-LINK-4', 'M-LINK-5', 'M-AIR-1', 'M-AIR-1.share', 'M-AIR-2',
  'M-PART-5', 'M-TIME-3', 'M-PROG-4', 'M-PROG-5',
  ...POSTS.flatMap(c => [`M-PROG-4.${c.id}.bytesPerMm`, `M-PROG-4.${c.id}.arcShare`])] as const
const na = (why: string) => notApplicable(`n/a: ${why}`)
const round = (n: number) => Math.round(n * 1e6) / 1e6
const entryRoles = new Set(['helix', 'ramp', 'plunge'])
export type EntryClass = 'outside' | 'cleared' | 'helix' | 'ramp' | 'plunge' | 'X'
export interface EntryObservation {
  moveIndex: number; class: EntryClass; contactFraction: number; feed?: number; angleDeg: number
  centreCutting?: boolean; alternativesFit?: boolean
}
export interface CollectorInput {
  planned: PlannedStep; tool: Tool; opType: string
  stock?: { field: ZDexelField; bounds: Box3; cutter: CutterSpec }
  // Machine registration is not inferred from a fixture's WCS origin.
  machineBox?: Box3; holder?: ToolHolder; unavailable?: string
  centreCutting?: boolean; alternativesFit?: boolean
  slotFeed?: number; controllerBlockPeriodMs?: number
  wallRadialDepthsMm?: number[]
  cornerWindows?: { engagement: number; passMedian: number }[]
  restAccounting?: { regions: number; reportedAndJustified: number }
}

/** Closed-form implied cusp, not a programmed stepover setting. */
export function impliedCusp(radius: number, spacing: number): number | undefined {
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(spacing) || spacing < 0 || spacing > 2 * radius) return undefined
  return radius - Math.sqrt(radius * radius - (spacing / 2) ** 2)
}

/** Promote WO-1192's section intersections, using BOTH section directions so
 * parallel X and parallel Y paths are treated alike. Gaps >= D stay unmeasured.
 * Z differences are part of surface spacing (steep-wall growth is visible). */
export function crossSectionCusps(moves: readonly ToolpathMove[], radius: number) {
  const linear: { a: Point3; b: Point3 }[] = []
  const ir = toIrMoves(moves)
  for (let i = 1; i < moves.length; i++) {
    if (!['cut', 'finish', 'wall_follow'].includes(effectiveMoveRole(moves[i]))) continue
    forEachLinearSweep(moves[i - 1], ir[i], 0.001, sweep => linear.push({
      a: { x: sweep.x0, y: sweep.y0, z: sweep.z0 }, b: { x: sweep.x1, y: sweep.y1, z: sweep.z1 },
    }))
  }
  const samples: number[] = []
  for (const axis of ['x', 'y'] as const) {
    const other = axis === 'x' ? 'y' : 'x'
    let low = Infinity, high = -Infinity
    for (const { a, b } of linear) { low = Math.min(low, a[axis], b[axis]); high = Math.max(high, a[axis], b[axis]) }
    for (let section = 1; section <= 7 && high > low; section++) {
      const at = low + (high - low) * section / 8
      const hits: { p: number; z: number }[] = []
      for (const { a, b } of linear) {
        if (Math.abs(b[axis] - a[axis]) < 1e-10) continue
        const t = (at - a[axis]) / (b[axis] - a[axis])
        if (t < 0 || t >= 1) continue // half-open: a vertex belongs to one segment
        hits.push({ p: a[other] + t * (b[other] - a[other]), z: a.z + t * (b.z - a.z) })
      }
      hits.sort((a, b) => a.p - b.p || a.z - b.z)
      const unique = hits.filter((h, i) => !i || Math.hypot(h.p - hits[i - 1].p, h.z - hits[i - 1].z) > 0.03)
      for (let i = 1; i < unique.length; i++) {
        const s = Math.hypot(unique[i].p - unique[i - 1].p, unique[i].z - unique[i - 1].z)
        if (s >= 2 * radius) continue
        const h = impliedCusp(radius, s)
        if (h !== undefined) samples.push(h)
      }
    }
  }
  return samples.length ? { max: samples.reduce((a, b) => Math.max(a, b), 0), mean: samples.reduce((a, b) => a + b, 0) / samples.length, samples: samples.length } : undefined
}

export function envelopeExcursion(moves: readonly ToolpathMove[], box: Box3): number {
  let worst = 0
  const ir = toIrMoves(moves)
  const check = (p: Point3) => { worst = Math.max(worst, box.minX - p.x, p.x - box.maxX,
    box.minY - p.y, p.y - box.maxY, box.minZ - p.z, p.z - box.maxZ) }
  for (let i = 0; i < moves.length; i++) {
    check(moves[i])
    if (i && ir[i].t === 'arc') {
      // Include exact cardinal extrema, rather than chord samples that miss them.
      const p = moves[i - 1], m = moves[i], cx = m.cx!, cy = m.cy!
      const r = Math.hypot(p.x - cx, p.y - cy), a = Math.atan2(p.y - cy, p.x - cx)
      const norm = (n: number) => (n % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
      const distance = (n: number) => norm(m.type === 'arc_cw' ? a - n : n - a)
      const sweep = distance(Math.atan2(m.y - cy, m.x - cx)) || 2 * Math.PI
      for (let k = 0; k < 4; k++) if (distance(k * Math.PI / 2) <= sweep + 1e-12) {
        check({ x: cx + r * Math.cos(k * Math.PI / 2), y: cy + r * Math.sin(k * Math.PI / 2), z: p.z })
      }
    }
  }
  return worst
}

export function shortSegmentShare(moves: readonly ToolpathMove[], blockMs?: number): MetricValue {
  if (!(blockMs !== undefined && Number.isFinite(blockMs) && blockMs > 0)) return na('controller block period unmeasured; WO-A3-04 owes calibration (no threshold)')
  let short = 0, total = 0
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i]
    if (m.type === 'rapid' || !isStockCuttingRole(effectiveMoveRole(m))) continue
    const length = moveLength(moves[i - 1], m)
    if (!(m.feed !== undefined && m.feed > 0)) return na('cut segment feed unavailable')
    total += length
    if (length < m.feed * blockMs / 60000) short += length
  }
  return total ? 100 * short / total : na('no cutting length')
}

/** Observed tangent roll-in/out on explicitly labelled wall passes. Whether
 * another approach fits is separate evidence, not inferred from a role. */
export function wallLeadShare(moves: readonly ToolpathMove[]): MetricValue {
  const wall = (i: number) => ['finish', 'wall_follow'].includes(effectiveMoveRole(moves[i]))
  const tangent = (i: number, end: boolean): [number, number] => {
    const m = moves[i], p = moves[i - 1]
    if ((m.type === 'arc_cw' || m.type === 'arc_ccw') && m.cx !== undefined && m.cy !== undefined) {
      const at = end ? m : p, sign = m.type === 'arc_ccw' ? 1 : -1
      return [-sign * (at.y - m.cy), sign * (at.x - m.cx)]
    }
    return [m.x - p.x, m.y - p.y]
  }
  const tangentJoin = (i: number, j: number) => {
    const a = tangent(i, true), b = tangent(j, false)
    const denominator = Math.hypot(...a) * Math.hypot(...b)
    return denominator > 0 && (a[0] * b[0] + a[1] * b[1]) / denominator > 1 - 1e-6
  }
  let passes = 0, rolls = 0
  for (let i = 1; i < moves.length; i++) {
    if (!wall(i)) continue
    const first = i
    while (i + 1 < moves.length && wall(i + 1)) i++
    passes++
    const lead = moves[first - 1], exit = moves[i + 1]
    const arc = (m: ToolpathMove) => m.type === 'arc_cw' || m.type === 'arc_ccw'
    if (first > 1 && exit && lead.role === 'lead_in' && arc(lead) && exit.role === 'lead_out' && arc(exit) &&
      tangentJoin(first - 1, first) && tangentJoin(i, i + 1)) rolls++
  }
  return passes ? rolls / passes : na('no explicitly labelled wall-finishing passes; roll feasibility unmeasured')
}

/** Count modal motion blocks, including inherited G2/G3 and rapid motion.
 * Comments, setup coordinates, dwell and canned-cycle blocks are not arcs. */
export function postedArcShare(lines: readonly string[]): number {
  let mode = -1, motions = 0, arcs = 0, cycle = false
  for (const raw of lines) {
    const line = raw.replace(/\([^)]*\)/g, '').split(';')[0]
    const codes = [...line.matchAll(/\bG0*(\d+)(?:\.\d+)?\b/g)].map(m => Number(m[1]))
    if (codes.includes(80)) cycle = false
    if (codes.some(n => n >= 81 && n <= 89)) cycle = true
    for (const n of codes) if (n >= 0 && n <= 3) mode = n
    if (cycle || codes.some(n => [4, 10, 28, 30, 52, 92].includes(n))) continue
    if (mode >= 0 && /\b[XYZIJ][-+]?\d/.test(line)) { motions++; if (mode === 2 || mode === 3) arcs++ }
  }
  return motions ? arcs / motions : 0
}

export function collectAlpha3(input: CollectorInput) {
  const { planned: plan, tool, stock } = input
  const metrics: Record<string, MetricValue> = Object.fromEntries(COLLECTOR_KEYS.map(key => [key,
    na(input.unavailable ?? 'required geometry or observation unavailable')]))
  const observations: { entries: EntryObservation[]; holder?: ReturnType<typeof checkHolderClearanceForToolpath>;
    fluteReach?: string; cusp?: ReturnType<typeof crossSectionCusps>; program: Record<string, { bytes: number; arcShare: number }> } = { entries: [], program: {} }
  if (input.unavailable) return { metrics, observations }
  const moves = plan.moves, path = pathMetrics(moves)
  const feeds = resolveFeedrates(tool, plan.settings?.feedrateOverride, 8000)
  metrics['M-SAFE-6'] = input.machineBox ? envelopeExcursion(moves, input.machineBox) : na('machine-to-fixture registration unavailable; travel dimensions alone do not locate the path')
  metrics['M-ENTRY-5'] = wallLeadShare(moves)
  metrics['M-PROG-5'] = shortSegmentShare(moves, input.controllerBlockPeriodMs)
  metrics['M-LOAD-7'] = input.cornerWindows?.length
    ? Math.max(...input.cornerWindows.map(w => w.engagement / w.passMedian)) : na('internal corner identities and per-pass engagement medians unavailable')
  metrics['M-GEOM-4'] = input.wallRadialDepthsMm?.length
    ? Math.max(...input.wallRadialDepthsMm) / tool.diameter : na('measured radial wall-finish depths unavailable; programmed allowance is not actual engagement')
  metrics['M-PART-5'] = input.restAccounting && input.restAccounting.regions > 0
    ? input.restAccounting.reportedAndJustified / input.restAccounting.regions
    : na('no independently justified and located rest-region report available')
  if (tool.type === 'ball_end_mill' && /parallel|scallop|waterline|steep_shallow/.test(input.opType)) {
    observations.cusp = crossSectionCusps(moves, tool.diameter / 2)
    if (observations.cusp) {
      metrics['M-GEOM-2'] = observations.cusp.max
      metrics['M-GEOM-2.mean'] = observations.cusp.mean
      metrics['M-GEOM-3'] = observations.cusp.max
    } else for (const key of ['M-GEOM-2', 'M-GEOM-2.mean', 'M-GEOM-3']) metrics[key] = na('no adjacent finishing-pass section intersections within one cutter diameter')
  } else for (const key of ['M-GEOM-2', 'M-GEOM-2.mean', 'M-GEOM-3']) metrics[key] = na('requires a ball-nose 3D finishing row')

  // Actual emitted programs, one per shipping dialect. The detached operation
  // wrapper supplies only post metadata; its moves are the production capture.
  const machine = makeMachine({ id: 'liencnc-v2', rapidRate: 8000, travel: { x: 738, y: 724.5, z: 129.2 } })
  const op = makeOp({ id: plan.stepId, type: input.opType as ReturnType<typeof makeOp>['type'],
    toolId: tool.id, ...plan.settings, toolpathMoves: moves })
  for (const config of POSTS) {
    try {
      const result = emitProgram({ machine, setup: { wcs: plan.sourceWcs ?? makeWcs({ origin: plan.sourceWcsOrigin ?? { x: 0, y: 0, z: 0 } }), operations: [{ op, tool, feeds,
        spindle: { rpm: plan.settings?.feedrateOverride?.enabled ? plan.settings.feedrateOverride.rpm : tool.feedsAndSpeeds.default?.rpm ?? 0, dir: 'cw' }, coolant: 'none', moves }] } }, config)
      if (result.diagnostics.some(d => d.level === 'error')) {
        for (const suffix of ['bytesPerMm', 'arcShare']) metrics[`M-PROG-4.${config.id}.${suffix}`] = na(`post ${config.id}: ${result.diagnostics.map(d => d.message).join('; ')}`)
        continue
      }
      const lines = result.lines
      const arcShare = postedArcShare(lines)
      const bytes = new TextEncoder().encode(lines.join('\n') + '\n').length
      observations.program[config.id] = { bytes, arcShare }
      metrics[`M-PROG-4.${config.id}.bytesPerMm`] = path.cutLengthMm ? bytes / path.cutLengthMm : na('no cutting length')
      metrics[`M-PROG-4.${config.id}.arcShare`] = arcShare
    } catch (error) {
      for (const suffix of ['bytesPerMm', 'arcShare']) metrics[`M-PROG-4.${config.id}.${suffix}`] = na(`post ${config.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  metrics['M-PROG-4'] = metrics['M-PROG-4.uccnc.bytesPerMm'] ?? na('UCCNC post unavailable')
  if (!stock) {
    for (const key of ['M-SAFE-2', 'M-SAFE-4', 'M-SAFE-5', 'M-LOAD-4', 'M-LOAD-5',
      'M-ENTRY-1', 'M-ENTRY-2', 'M-ENTRY-3', 'M-ENTRY-3.length', 'M-ENTRY-4',
      'M-ENTRY-4.outside', 'M-ENTRY-4.cleared', 'M-ENTRY-4.helix', 'M-ENTRY-4.ramp', 'M-ENTRY-4.plunge',
      'M-ENTRY-6', 'M-LINK-4', 'M-LINK-5', 'M-AIR-1', 'M-AIR-1.share', 'M-AIR-2', 'M-TIME-3']) {
      metrics[key] = na('verified world-space in-process stock replay unavailable for this project row')
    }
    return finish()
  }
  const field = stock.field.clone(), ir = toIrMoves(moves)
  let intrusion = 0, maxDepth = 0, removed = 0, airLength = 0, airMs = 0, timed = true
  let entryLength = 0, entryCount = 0, violations = 0, maxAngle = 0, entryFeedLength = 0, entryFeedSum = 0
  let previousEntry = false, previousCuts = false, previousPass: Point3 | undefined
  let linkLength = 0, linkHighest = -Infinity, linkStart: Point3 | undefined, linkSafeZ = -Infinity
  let worstDetour = 0, worstLift = 0, linkCount = 0, liftedCount = 0
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i], from = moves[i - 1], role = effectiveMoveRole(m)
    const cuts = isStockCuttingRole(role), length = moveLength(from, m)
    // A-29 is geometric: an unlabelled/continuing 'cut' can descend into
    // standing stock too. Do not let role annotations hide that descent.
    const straightDescent = m.type === 'feed' && Math.hypot(m.x - from.x, m.y - from.y) < 1e-6 && m.z < from.z
    const entry = entryRoles.has(role) || (cuts && (!previousCuts || straightDescent))
    const feed = resolveMoveFeedrate(m, feeds)
    let moveIntrusion = -Infinity, volume = 0, contactTop = -Infinity
    // Read entry contact BEFORE removing this move, against this instant's field.
    const contact = entry ? plungeUncutFraction(field, from.x, from.y, Math.min(from.z, m.z), stock.cutter) : undefined
    forEachLinearSweep(from, ir[i], replaySagittaFor(field), sweep => {
      const hit = maxTraverseIntrusion(field, sweep, stock.cutter)
      moveIntrusion = Math.max(moveIntrusion, hit.intrusionMm)
      if (Number.isFinite(hit.materialTopZ)) contactTop = Math.max(contactTop, hit.materialTopZ)
      if (cuts) volume += removeSweep(field, sweep, stock.cutter).removedVolumeMm3
    })
    if (!cuts) intrusion = Math.max(intrusion, moveIntrusion)
    else { removed += volume; if (Number.isFinite(contactTop)) maxDepth = Math.max(maxDepth, contactTop - Math.min(from.z, m.z)) }
    if (m.type !== 'rapid' && length > 0 && moveIntrusion <= 1e-3) {
      airLength += length
      if (feed !== undefined && feed > 0) airMs += length / feed * 60000
      else timed = false
    }
    if (entry) {
      const xy = (m.type === 'arc_cw' || m.type === 'arc_ccw') ? Math.sqrt(Math.max(0, length ** 2 - (m.z - from.z) ** 2)) : Math.hypot(m.x - from.x, m.y - from.y)
      const angle = Math.atan2(Math.abs(m.z - from.z), xy) * 180 / Math.PI
      maxAngle = Math.max(maxAngle, angle)
      const standing = (contact?.fraction ?? 0) > 0.05
      const outside = from.x + tool.diameter / 2 < stock.bounds.minX || from.x - tool.diameter / 2 > stock.bounds.maxX ||
        from.y + tool.diameter / 2 < stock.bounds.minY || from.y - tool.diameter / 2 > stock.bounds.maxY
      const plunge = standing && xy < 1e-6 && m.z < from.z && tool.type !== 'drill'
      const forbidden = plunge && feed !== undefined && feed >= feeds.feedRate
      if (forbidden) violations++
      const cls: EntryClass = outside ? 'outside' : !standing ? 'cleared' : role === 'helix' ? 'helix' : role === 'ramp' ? 'ramp'
        : plunge && feed !== undefined && feed < feeds.feedRate && input.centreCutting === true && input.alternativesFit === false ? 'plunge' : 'X'
      if (!previousEntry) observations.entries.push({ moveIndex: i, class: cls, contactFraction: contact?.fraction ?? 0,
        feed, angleDeg: angle, centreCutting: input.centreCutting, alternativesFit: input.alternativesFit })
      if (standing) { entryLength += length; if (!previousEntry) entryCount++ }
      if (feed !== undefined && feeds.feedRate > 0) { entryFeedSum += feed / feeds.feedRate * length; entryFeedLength += length }
    }
    if (effectiveMoveMotion(m) === 'pass') {
      if (previousPass && linkStart && linkLength > 0) {
        const direct = Math.hypot(from.x - linkStart.x, from.y - linkStart.y, from.z - linkStart.z)
        if (linkHighest <= Math.max(linkStart.z, m.z) + 1e-4 && direct > 1e-9) { worstDetour = Math.max(worstDetour, linkLength / direct); linkCount++ }
        else if (linkHighest > Math.max(linkStart.z, m.z) + 1e-4 && Number.isFinite(linkSafeZ)) { worstLift = Math.max(worstLift, linkHighest - linkSafeZ); liftedCount++ }
      }
      previousPass = m; linkStart = undefined; linkLength = 0; linkHighest = -Infinity; linkSafeZ = -Infinity
    } else if (previousPass) {
      linkStart ??= from
      linkLength += length
      linkHighest = Math.max(linkHighest, from.z, m.z)
      if (Number.isFinite(moveIntrusion)) linkSafeZ = Math.max(linkSafeZ, Math.min(from.z, m.z) + moveIntrusion)
    }
    previousEntry = entry; previousCuts = cuts
  }
  metrics['M-SAFE-2'] = Math.max(0, intrusion)
  // Call the existing checks read-only. A gate's quiet 'clear' with missing
  // geometry is not a measurement of 0.25 mm; nor does its contact report
  // expose a minimum distance. Retain the report without inventing that number.
  observations.holder = checkHolderClearanceForToolpath({ operation: input.opType, moves, tool, holder: input.holder,
    stockBlock: { min: { x: stock.bounds.minX, y: stock.bounds.minY, z: stock.bounds.minZ }, max: { x: stock.bounds.maxX, y: stock.bounds.maxY, z: stock.bounds.maxZ } } })
  metrics['M-SAFE-4'] = na(!input.holder ? 'no holder geometry' : 'holder gate exposes contact status, not minimum clearance distance; millimetre collector unavailable')
  try { assertToolFluteReach({ operation: input.opType, topZ: maxDepth, bottomZ: 0, fluteLength: tool.fluteLength }); observations.fluteReach = 'pass' }
  catch (error) { observations.fluteReach = error instanceof Error ? error.message : String(error) }
  metrics['M-SAFE-5'] = tool.fluteLength > 0 ? maxDepth - tool.fluteLength : na('no usable flute length')
  metrics['M-AIR-1'] = airLength
  metrics['M-AIR-1.share'] = path.cutLengthMm ? 100 * airLength / path.cutLengthMm : na('no cutting length')
  metrics['M-AIR-2'] = timed && plan.cutTimeMs !== undefined && plan.cutTimeMs > 0 ? airMs / plan.cutTimeMs * 100 : na('air feed or application cycle time unavailable')
  metrics['M-TIME-3'] = plan.cutTimeMs !== undefined && plan.cutTimeMs > 0 ? removed / plan.cutTimeMs * 60000 : na('application cycle time unavailable')
  metrics['M-ENTRY-1'] = violations
  metrics['M-ENTRY-2'] = observations.entries.length ? maxAngle : na('no entries')
  metrics['M-ENTRY-3'] = entryCount; metrics['M-ENTRY-3.length'] = entryLength
  metrics['M-ENTRY-4'] = observations.entries.length ? observations.entries.filter(e => e.class !== 'X').length / observations.entries.length : na('no entries')
  for (const cls of ['outside', 'cleared', 'helix', 'ramp', 'plunge']) metrics[`M-ENTRY-4.${cls}`] = observations.entries.length ? observations.entries.filter(e => e.class === cls).length / observations.entries.length : na('no entries')
  metrics['M-ENTRY-6'] = entryFeedLength ? entryFeedSum / entryFeedLength : na('entry feed or entry length unavailable')
  metrics['M-LINK-4'] = linkCount ? worstDetour : na('no keep-down links with distinct endpoints')
  metrics['M-LINK-5'] = liftedCount ? worstLift : na('no lifted links with a stock-supported safe height')
  // Windowed engagement is independent of settings-rule availability and runs
  // for every supported cutter/operation, with entries excluded by production.
  const windows: { fraction: number; length: number; index: number }[] = []
  const engagement = measurePathEngagement(ir, stock.bounds, stock.field.cell, stock.cutter, {
    startingStock: stock.field, capFraction: Number.MIN_VALUE,
    onOverCap: h => windows.push({ fraction: h.fraction, length: h.lengthMm, index: h.moveIndex }),
  })
  if (!input.wallRadialDepthsMm?.length && stock.cutter.kind === 'flat') {
    const wallWindows = windows.filter(w => ['finish', 'wall_follow'].includes(effectiveMoveRole(moves[w.index])))
    if (wallWindows.length) metrics['M-GEOM-4'] = wallWindows.reduce((maximum, w) => Math.max(maximum, w.fraction), 0)
  }
  const weight = engagement.cuttingLengthMm
  const zeroWeight = Math.max(0, weight - windows.reduce((n, w) => n + w.length, 0))
  const mean = weight ? windows.reduce((n, w) => n + w.fraction * w.length, 0) / weight : 0
  metrics['M-LOAD-4'] = mean > 0 ? Math.sqrt(windows.reduce((n, w) => n + (w.fraction - mean) ** 2 * w.length, zeroWeight * mean ** 2) / weight) / mean : na('no positive mean lateral engagement')
  metrics['M-LOAD-5'] = input.slotFeed !== undefined ? windows.filter(w => w.fraction >= 0.95 &&
    (resolveMoveFeedrate(moves[w.index], feeds) ?? Infinity) > input.slotFeed! * 1.001).reduce((n, w) => n + w.length, 0)
    : na(`slot-feed policy unavailable for ${input.opType}; measured cutting length ${round(engagement.cuttingLengthMm)} mm`)
  return finish()
  function finish() {
    for (const [key, value] of Object.entries(metrics)) if (typeof value === 'number') metrics[key] = Number.isFinite(value) ? round(value) : na('non-finite measurement; denominator or geometry unavailable')
    return { metrics, observations }
  }
}

/** The alpha3 hard verdicts are observations, separate from smoke/full bands. */
export function alpha3HardVerdicts(metrics: Readonly<Record<string, MetricValue>>) {
  const limits: Record<string, (value: number) => boolean> = {
    'M-SAFE-2': n => n <= 1e-3, 'M-SAFE-4': n => n >= 0.25, 'M-SAFE-5': n => n <= 1e-6,
    'M-SAFE-6': n => n <= 0, 'M-ENTRY-1': n => n === 0, 'M-PART-4': n => n === 1,
  }
  return Object.fromEntries(Object.entries(limits).map(([key, test]) => [key,
    typeof metrics[key] === 'number' ? test(metrics[key]) ? 'PASS' : 'FAIL' : 'n/a']))
}
