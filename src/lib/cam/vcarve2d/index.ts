// V-carve toolpath builder.
//
// What the operator gets (the sign-maker's V-carve every router CAM ships):
//   - the V-bit rides the medial axis of every closed region, tip depth =
//     (inscribed radius - tip radius) / tan(half angle), so both walls of the
//     groove are the drawn outline and convex corners come to a sharp point
//     at the surface;
//   - a flat depth (the operator's, or the bit's own physical limit) clips the
//     carve: wherever the region is wider than the bit can reach at that
//     depth, the walls are cut at the flat depth along the inset outline and
//     the floor between them is cleared flat;
//   - floors are cleared by this V-bit (concentric rings, stepover chosen by
//     the operator), by a separate end mill as its own sibling operation
//     (role 'flat_clearing', built here too), or left alone;
//   - start depth, allowance and multi-depth passes.
//
// Heights: Material Start (topZ) already includes the start depth; bottomZ is
// Material Start minus the effective maximum depth, both resolved by Smart
// Height V2 in the store. The builder recomputes the depth limit from the
// tool and never cuts below whichever of the two is shallower.
//
// Refusals are thrown (ADR-0003): no closed loop selected, a tool with no tip
// angle, a flat depth the bit cannot cut, a region the bit's tip flat cannot
// enter anywhere.

import type { ToolpathMove, VCarveWorkerPayload, LoopData, PocketWorkerPayload, PocketParams } from '../types'
import type { Tool } from '../../../types'
import { resolveHeights } from '../heights'
import { resolveFeedrates } from '../feedrates'
import { rapidEntryAt, retractFrom } from '../moves'
import { assertToolFluteReach } from '../toolFluteReach'
import { toolHalfAngleRad } from '../geometry'
import { buildPocketToolpath } from '../pocket2d'
import { medialAxis, type AxisNode, type AxisPath, type Region } from './medialAxis'
import { buildRegions, insetRegion, regionLoops, regionPerimeter, regionContains, treeToRegions } from './regions'
import { differenceTree, offsetLoops, offsetTree, treeToOrientedLoops, type Loops } from './clipper'

export { ensureVCarveClipperReady, vcarveClipperReady } from './clipper'
export { medialAxis } from './medialAxis'
export { buildRegions } from './regions'
export type { AxisNode, AxisPath, Region } from './medialAxis'

// ---------------------------------------------------------------------------
// Tool geometry
// ---------------------------------------------------------------------------

export interface VBitGeometry {
  /** tan of the half angle (per side, from the axis). */
  tanHalf: number
  tipRadius: number
  /** Deepest cut this bit can make: full diameter reached, or flute length. */
  physicalMaxDepth: number
}

export function vbitGeometry(tool: Pick<Tool, 'angleFromAxisDeg' | 'tipDiameter' | 'diameter' | 'fluteLength' | 'name'>): VBitGeometry {
  const angle = tool.angleFromAxisDeg
  if (typeof angle !== 'number' || !Number.isFinite(angle) || angle <= 0 || angle >= 90) {
    throw new Error(
      `V-carve: tool "${tool.name}" has no usable tip angle. ` +
      'Choose a V-bit, engraving bit or chamfer mill with an angle between 0 and 90 degrees per side.',
    )
  }
  const tanHalf = Math.tan(toolHalfAngleRad(angle))
  const tipRadius = Math.max(0, (tool.tipDiameter ?? 0) / 2)
  const radius = tool.diameter / 2
  if (!(radius > tipRadius)) {
    throw new Error(`V-carve: tool "${tool.name}" tip flat (${(tipRadius * 2).toFixed(3)} mm) is not smaller than its diameter (${tool.diameter} mm).`)
  }
  const flute = Number.isFinite(tool.fluteLength) && tool.fluteLength > 0 ? tool.fluteLength : Infinity
  const physicalMaxDepth = Math.min(flute, (radius - tipRadius) / tanHalf)
  return { tanHalf, tipRadius, physicalMaxDepth }
}

/** Effective maximum carve depth: the operator's flat depth when set, else
 *  the bit's physical limit. Refuses a flat depth the bit cannot reach. */
export function effectiveMaxDepth(geom: VBitGeometry, flatDepthMm: number | undefined, toolName: string): number {
  if (flatDepthMm === undefined) return geom.physicalMaxDepth
  if (!Number.isFinite(flatDepthMm) || flatDepthMm <= 0) {
    throw new Error('V-carve: flat depth must be a positive distance below Material Start.')
  }
  if (flatDepthMm > geom.physicalMaxDepth + 1e-9) {
    throw new Error(
      `V-carve: flat depth ${flatDepthMm.toFixed(3)} mm is deeper than tool "${toolName}" can cut ` +
      `(${geom.physicalMaxDepth.toFixed(3)} mm at its full diameter or flute length). Reduce the flat depth or choose a larger bit.`,
    )
  }
  return flatDepthMm
}

/** Depth below Material Start for an inscribed radius r (>= 0, clipped). */
export function depthForRadius(r: number, geom: VBitGeometry, maxDepth: number): number {
  const d = (r - geom.tipRadius) / geom.tanHalf
  return d <= 0 ? 0 : d >= maxDepth ? maxDepth : d
}

// ---------------------------------------------------------------------------
// Ridge path helpers
// ---------------------------------------------------------------------------

interface Ridge3 { x: number; y: number; d: number }

/** Split an axis path into runs where the radius stays at or below rFlat,
 *  interpolating the crossing point so each run ends exactly on the flat
 *  boundary. Runs inside the flat region are handled by the wall pass. */
function splitByRadius(path: AxisPath, rFlat: number): AxisNode[][] {
  // A closed chain starts at its widest point so the seam falls inside the
  // flat region and never splits one run in two.
  let base = path.points
  if (path.closed && base.length > 1) {
    let widest = 0
    for (let i = 1; i < base.length; i++) if (base[i].r > base[widest].r) widest = i
    base = [...base.slice(widest), ...base.slice(0, widest)]
  }
  const pts = path.closed && base.length > 1 ? [...base, base[0]] : base
  const runs: AxisNode[][] = []
  let cur: AxisNode[] = []
  const flush = () => { if (cur.length >= 1) runs.push(cur); cur = [] }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const inside = p.r <= rFlat
    if (i > 0) {
      const q = pts[i - 1]
      const qInside = q.r <= rFlat
      if (qInside !== inside) {
        const t = (rFlat - q.r) / (p.r - q.r)
        const x = { x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t, r: rFlat }
        if (qInside) { cur.push(x); flush() } else { cur.push(x) }
      }
    }
    if (inside) cur.push(p)
    else if (cur.length) flush()
  }
  flush()
  return runs.filter(r => r.length >= 1)
}

/** Keep the portions of a run deeper than `minDepth` (for the earlier of the
 *  multi-depth passes, so a shallow pass does not re-trace what it already
 *  cut), splitting at the crossings. */
function trimShallower(run: Ridge3[], minDepth: number): Ridge3[][] {
  if (minDepth <= 0) return [run]
  const out: Ridge3[][] = []
  let cur: Ridge3[] = []
  const flush = () => { if (cur.length >= 2) out.push(cur); cur = [] }
  for (let i = 0; i < run.length; i++) {
    const p = run[i]
    const deep = p.d > minDepth
    if (i > 0) {
      const q = run[i - 1]
      const qDeep = q.d > minDepth
      if (qDeep !== deep) {
        const t = (minDepth - q.d) / (p.d - q.d)
        const x = { x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t, d: minDepth }
        if (qDeep) { cur.push(x); flush() } else { cur.push(x) }
      }
    }
    if (deep) cur.push(p)
    else if (cur.length) flush()
  }
  flush()
  return out
}

/** Greedy nearest-end ordering of polylines, allowing reversal. */
function orderRuns<T extends { x: number; y: number }>(runs: T[][]): T[][] {
  if (runs.length <= 1) return runs
  const remaining = runs.map(r => r)
  const out: T[][] = []
  let cur = remaining.shift()!
  out.push(cur)
  while (remaining.length) {
    const end = cur[cur.length - 1]
    let bi = 0, bd = Infinity, rev = false
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i]
      const a = r[0], b = r[r.length - 1]
      const da = (a.x - end.x) ** 2 + (a.y - end.y) ** 2
      const db = (b.x - end.x) ** 2 + (b.y - end.y) ** 2
      if (da < bd) { bd = da; bi = i; rev = false }
      if (db < bd) { bd = db; bi = i; rev = true }
    }
    const next = remaining.splice(bi, 1)[0]
    cur = rev ? [...next].reverse() : next
    out.push(cur)
  }
  return out
}

/** Start a closed run at its shallowest point so the plunge is minimal. */
function rotateToShallowest(run: Ridge3[]): Ridge3[] {
  let best = 0
  for (let i = 1; i < run.length; i++) if (run[i].d < run[best].d) best = i
  return [...run.slice(best), ...run.slice(0, best)]
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildVCarveToolpath(
  payload: VCarveWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
): ToolpathMove[] {
  const { params, heights, passes, tool, loops, wcsOrigin } = payload
  const { clearanceZ, retractZ, feedZ, topZ, bottomZ } = resolveHeights(heights, wcsOrigin)
  const { feedRate, plungeRate } = resolveFeedrates(tool, payload.feedrateOverride)
  const tol = params.tolerance > 0 ? params.tolerance : 0.01

  // Closed loops only; loopIds narrows when given.
  const selected = loops.filter(l =>
    l.closed && l.points.length >= 3 && (params.loopIds.length === 0 || params.loopIds.includes(l.id)))
  if (selected.length === 0) {
    throw new Error('V-carve: no closed outline selected. Pick closed loops (letters, shapes); open curves cannot be V-carved.')
  }

  const regions = buildRegions(selected.map(l => l.points), { allowanceMm: params.allowanceMm, arcTol: tol })
  if (regions.length === 0) {
    throw new Error('V-carve: the selected outlines enclose no area after welding and allowance.')
  }

  if (params.role === 'flat_clearing') return buildFlatClearing(payload, regions, { clearanceZ, retractZ, feedZ, topZ, bottomZ }, onProgress)

  const geom = vbitGeometry(tool)
  const maxDepthByTool = effectiveMaxDepth(geom, params.flatDepthMm, tool.name)
  // Never below the resolver's bottom plane either.
  const maxDepth = Math.min(maxDepthByTool, Math.max(0, topZ - bottomZ))
  if (!(maxDepth > 0)) throw new Error('V-carve: Material Start is not above Cutter End; nothing to carve.')
  assertToolFluteReach({ operation: 'V-carve', topZ, bottomZ: topZ - maxDepth, fluteLength: tool.fluteLength })
  const rFlat = geom.tipRadius + maxDepth * geom.tanHalf

  const moves: ToolpathMove[] = []
  const stepdown = passes.stepdown > 0 ? passes.stepdown : maxDepth
  const levelCount = Math.ceil(maxDepth / stepdown - 1e-9)
  if (levelCount > 200) {
    throw new Error(
      `V-carve: stepdown ${stepdown} mm over ${maxDepth.toFixed(2)} mm of depth makes ${levelCount} passes. Use a stepdown of at least ${(maxDepth / 200).toFixed(3)} mm.`,
    )
  }
  const clampLevels: number[] = []
  for (let c = stepdown; c < maxDepth - 1e-9; c += stepdown) clampLevels.push(c)
  clampLevels.push(maxDepth)

  const total = regions.length || 1
  let anyCut = false
  regions.forEach((region, ri) => {
    const phase = total > 1 ? `V-carve region ${ri + 1}/${total}` : 'V-carve'
    onProgress?.(ri / total, phase)

    // Flat floors: where the region is wider than the bit reaches at maxDepth.
    const flats = insetRegion(region, rFlat, tol)

    // 1 and 2. Floor clearing and the wall pass, one depth level at a time so a
    // deep flat depth never starts with a full-depth plunge. At level c the
    // final wall sits tipRadius + c * tan(half) inside the outline; the bit
    // centred on that inset with its tip at depth c has its edge exactly on
    // the wall, and everything inside it is floor to clear at that depth.
    if (flats.length) {
      const stepover = params.flatClearing.stepoverMm > 0 ? params.flatClearing.stepoverMm : Math.max(geom.tipRadius * 2, 0.5)
      for (const c of clampLevels) {
        const z = topZ - c
        const rLevel = geom.tipRadius + c * geom.tanHalf
        const levelFlats = c >= maxDepth - 1e-9 ? flats : insetRegion(region, rLevel, tol)
        if (params.flatClearing.mode !== 'none') {
          let floorLoops: Loops = levelFlats.flatMap(regionLoops)
          if (params.flatClearing.mode === 'tool') {
            const re = (params.flatClearing.clearingToolDiameter ?? 0) / 2
            if (re > 0) {
              // What the end mill can reach: erode then dilate by its radius.
              const reach = offsetLoops(offsetLoops(floorLoops, -re, tol), re, tol)
              floorLoops = treeToOrientedLoops(differenceTree(floorLoops, reach))
            }
          }
          if (floorLoops.length) {
            anyCut = emitFloorRings(moves, floorLoops, stepover, tol, z, feedZ, retractZ, clearanceZ, feedRate, plungeRate) || anyCut
          }
        }
        for (const flat of levelFlats) {
          for (const loop of regionLoops(flat)) {
            if (loop.length < 3) continue
            rapidEntryAt(moves, loop[0], feedZ, retractZ, clearanceZ)
            moves.push({ type: 'feed', x: loop[0].x, y: loop[0].y, z, feed: plungeRate, role: 'plunge' })
            for (let i = 1; i < loop.length; i++) moves.push({ type: 'feed', x: loop[i].x, y: loop[i].y, z, feed: feedRate, role: 'cut' })
            moves.push({ type: 'feed', x: loop[0].x, y: loop[0].y, z, feed: feedRate, role: 'cut' })
            retractFrom(moves, retractZ, clearanceZ)
            anyCut = true
          }
        }
      }
    }

    // 3. Ridge passes along the medial axis.
    const spacing = sampleSpacing(region, tol)
    const paths = medialAxis(region, { spacing })
    const runs: Ridge3[][] = []
    const closedRuns: Ridge3[][] = []
    for (const path of paths) {
      if (path.points.length === 1) {
        // A disc-like region: one dimple at the deepest point.
        const p = path.points[0]
        const d = depthForRadius(p.r, geom, maxDepth)
        if (d > 0 && !flats.length) runs.push([{ x: p.x, y: p.y, d }, { x: p.x, y: p.y, d }])
        continue
      }
      const pieces = flats.length ? splitByRadius(path, rFlat) : [path.closed ? [...path.points, path.points[0]] : path.points]
      const wholeClosed = path.closed && pieces.length === 1 && pieces[0].length === path.points.length + 1
      for (const piece of pieces) {
        const run = piece.map(p => ({ x: p.x, y: p.y, d: depthForRadius(p.r, geom, maxDepth) }))
        if (run.length < 2) continue
        if (run.every(p => p.d <= 0)) continue
        if (wholeClosed) closedRuns.push(run.slice(0, -1))
        else runs.push(run)
      }
    }
    if (!runs.length && !closedRuns.length) return

    for (let li = 0; li < clampLevels.length; li++) {
      const clamp = clampLevels[li]
      const minDepth = li === 0 ? 0 : clampLevels[li - 1]
      const passRuns: Ridge3[][] = []
      for (const run of runs) {
        for (const piece of trimShallower(run, minDepth)) passRuns.push(piece.map(p => ({ ...p, d: Math.min(p.d, clamp) })))
      }
      for (const run of closedRuns) {
        const clamped = run.map(p => ({ ...p, d: Math.min(p.d, clamp) }))
        if (minDepth > 0 && run.some(p => p.d <= minDepth)) {
          const pieces = trimShallower([...run, run[0]], minDepth)
          for (const piece of pieces) passRuns.push(piece.map(p => ({ ...p, d: Math.min(p.d, clamp) })))
        } else {
          const rotated = rotateToShallowest(clamped)
          passRuns.push([...rotated, rotated[0]])
        }
      }
      for (const run of orderRuns(passRuns)) {
        if (run.length < 2) continue
        // A zero-length run (two junction nodes at one point) cuts nothing.
        let length = 0
        for (let i = 1; i < run.length; i++) length += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y)
        if (length < 1e-6 && run.every(p => Math.abs(p.d - run[0].d) < 1e-9)) continue
        emitRidge(moves, run, topZ, feedZ, retractZ, clearanceZ, feedRate, plungeRate)
        anyCut = true
      }
    }
  })

  if (!anyCut) {
    throw new Error(
      `V-carve: tool "${tool.name}" cannot enter the selected outlines anywhere - every part of the drawing is narrower than its ${(geom.tipRadius * 2).toFixed(2)} mm tip flat. Choose a sharper bit or a larger design.`,
    )
  }
  onProgress?.(1)
  return moves
}

/** Boundary sample spacing: fine enough for the tolerance, capped so a very
 *  long perimeter stays inside a sane sample budget. */
function sampleSpacing(region: Region, tol: number): number {
  const perimeter = regionPerimeter(region)
  const byTol = Math.max(0.05, Math.min(0.5, tol * 8))
  const byBudget = perimeter / 60_000
  return Math.max(byTol, byBudget)
}

function emitRidge(
  moves: ToolpathMove[], run: Ridge3[], topZ: number,
  feedZ: number, retractZ: number, clearanceZ: number, feedRate: number, plungeRate: number,
): void {
  const start = run[0]
  rapidEntryAt(moves, start, feedZ, retractZ, clearanceZ)
  moves.push({ type: 'feed', x: start.x, y: start.y, z: topZ - start.d, feed: plungeRate, role: 'plunge' })
  for (let i = 1; i < run.length; i++) {
    const p = run[i]
    moves.push({ type: 'feed', x: p.x, y: p.y, z: topZ - p.d, feed: feedRate, role: 'cut' })
  }
  retractFrom(moves, retractZ, clearanceZ)
}

/** Concentric inside-out ring fill of floor polygons at one depth, plus one
 *  pass down the medial axis of the innermost core so the strip the last ring
 *  leaves (up to a stepover wide) is cut too. The outermost ring is the floor
 *  boundary itself (the wall pass repeats it as a finish). Every point of the
 *  floor ends up within half a stepover of a cut. */
function emitFloorRings(
  moves: ToolpathMove[], floor: Loops, stepover: number, tol: number, z: number,
  feedZ: number, retractZ: number, clearanceZ: number, feedRate: number, plungeRate: number,
): boolean {
  // Rings from the boundary inward until the offset vanishes.
  const rings: Region[][] = []
  let current = treeToRegions(offsetTree(floor, 0, tol))
  let guard = 0
  while (current.length && guard++ < 10_000) {
    rings.push(current)
    current = current.flatMap(r => insetRegion(r, stepover, tol))
  }
  if (!rings.length) return false

  // A stay-down link between two loops is only allowed when the straight
  // line between them lies inside the floor itself: crossing a standing
  // island (a letter in a carved field) at depth would gouge it.
  const floorRegions = rings[0]
  const linkStaysOnFloor = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(2, Math.ceil(len / Math.min(stepover, 0.5)))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      let inside = false
      for (const r of floorRegions) if (regionContains(r, p)) { inside = true; break }
      if (!inside) return false
    }
    return true
  }
  let cut = false
  const enter = (p: { x: number; y: number }) => {
    const last = moves[moves.length - 1]
    const atDepth = last && last.type === 'feed' && Math.abs(last.z - z) < 1e-9 && linkStaysOnFloor(last, p)
    if (!atDepth) {
      if (last && last.type === 'feed') retractFrom(moves, retractZ, clearanceZ)
      rapidEntryAt(moves, p, feedZ, retractZ, clearanceZ)
      moves.push({ type: 'feed', x: p.x, y: p.y, z, feed: plungeRate, role: 'plunge' })
    } else {
      moves.push({ type: 'feed', x: p.x, y: p.y, z, feed: feedRate, role: 'stepover' })
    }
  }

  // Core pass: the medial axis of the innermost ring's interior.
  for (const core of rings[rings.length - 1]) {
    const spacing = Math.max(Math.max(0.05, Math.min(stepover / 4, 0.5)), regionPerimeter(core) / 60_000)
    for (const path of medialAxis(core, { spacing })) {
      const pts = path.closed && path.points.length > 1 ? [...path.points, path.points[0]] : path.points
      if (pts.length === 0) continue
      enter(pts[0])
      for (let i = 1; i < pts.length; i++) moves.push({ type: 'feed', x: pts[i].x, y: pts[i].y, z, feed: feedRate, role: 'cut' })
      cut = true
    }
  }

  // Inside-out rings: each ring cuts on its outer side only.
  for (let k = rings.length - 1; k >= 0; k--) {
    for (const region of rings[k]) {
      for (const loop of regionLoops(region)) {
        if (loop.length < 3) continue
        enter(loop[0])
        for (let i = 1; i < loop.length; i++) moves.push({ type: 'feed', x: loop[i].x, y: loop[i].y, z, feed: feedRate, role: 'cut' })
        moves.push({ type: 'feed', x: loop[0].x, y: loop[0].y, z, feed: feedRate, role: 'cut' })
        cut = true
      }
    }
  }
  if (cut) retractFrom(moves, retractZ, clearanceZ)
  return cut
}

// ---------------------------------------------------------------------------
// Role 'flat_clearing': the end mill's own operation
// ---------------------------------------------------------------------------

function buildFlatClearing(
  payload: VCarveWorkerPayload,
  regions: Region[],
  z: { clearanceZ: number; retractZ: number; feedZ: number; topZ: number; bottomZ: number },
  onProgress?: (fraction: number, phase?: string) => void,
): ToolpathMove[] {
  const { params, tool } = payload
  const vbit = params.vbit
  if (!vbit) throw new Error('V-carve flat clearing: the V-bit that will follow is not recorded on this operation. Re-create it from the V-carve dialog.')
  const geom = vbitGeometry({ ...vbit, diameter: Infinity, fluteLength: Infinity, name: 'V-bit' })
  const maxDepth = Math.max(0, z.topZ - z.bottomZ)
  if (!(maxDepth > 0)) throw new Error('V-carve flat clearing: Material Start is not above Cutter End; nothing to clear.')
  const rFlat = geom.tipRadius + maxDepth * geom.tanHalf
  const tol = params.tolerance > 0 ? params.tolerance : 0.01

  const floorLoops: LoopData[] = []
  let n = 0
  for (const region of regions) {
    for (const flat of insetRegion(region, rFlat, tol)) {
      for (const loop of regionLoops(flat)) {
        floorLoops.push({ id: `vcarve-floor-${n++}`, points: loop.map(p => ({ x: p.x, y: p.y })), closed: true, type: 'closed' })
      }
    }
  }
  if (floorLoops.length === 0) {
    throw new Error(
      `V-carve flat clearing: nothing is wider than the V-bit reaches at ${maxDepth.toFixed(2)} mm, so there is no flat floor for tool "${tool.name}" to clear. Delete this operation or deepen the flat depth.`,
    )
  }
  const pocketParams: PocketParams = {
    geometryId: params.geometryId,
    loopIds: [],
    direction: 'climb',
    orderStrategy: 'by_region',
    fillStrategy: 'outside_in',
    floorStockToLeave: 0,
    finishContour: false,
    helixDiameter: 0,
    overlapMm: 0,
    stepoverLeadIn: 'none',
    stayDown: true,
    stayDownLift: 0.5,
  }
  const pocketPayload: PocketWorkerPayload = {
    ...payload,
    params: pocketParams,
    loops: floorLoops,
  }
  onProgress?.(0.1, 'V-carve flat clearing')
  return buildPocketToolpath(pocketPayload, onProgress)
}

/** Exposed for tests and the store: is every point of these moves inside
 *  one of the regions (XY), within `eps`? */
export function cutsStayInside(moves: ToolpathMove[], regions: Region[], eps: number): boolean {
  const grown = regions.map(r => ({ outer: r.outer, holes: r.holes }))
  for (const m of moves) {
    if (m.type !== 'feed' || (m.role !== 'cut' && m.role !== 'plunge')) continue
    let ok = false
    for (const r of grown) if (regionContains(r, m)) { ok = true; break }
    if (!ok) {
      // Allow boundary contact within eps.
      let near = false
      for (const r of regions) for (const loop of regionLoops(r)) {
        for (let i = 0; i < loop.length && !near; i++) {
          const a = loop[i], b = loop[(i + 1) % loop.length]
          const dx = b.x - a.x, dy = b.y - a.y
          const l2 = dx * dx + dy * dy
          let t = l2 > 0 ? ((m.x - a.x) * dx + (m.y - a.y) * dy) / l2 : 0
          t = t < 0 ? 0 : t > 1 ? 1 : t
          if (Math.hypot(a.x + t * dx - m.x, a.y + t * dy - m.y) <= eps) near = true
        }
      }
      if (!near) return false
    }
  }
  return true
}
