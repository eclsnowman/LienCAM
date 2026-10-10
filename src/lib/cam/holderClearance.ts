import type { Tool, ToolHolder, ToolpathMove } from '../../types'
import { buildToolProfile } from '../tool/toolProfile'
import { isStockRegionEmpty, type StockState } from './stockState'
import { sampleArcMovesForLinearConsumers } from './toolpathArcSampling'
import { resolveFeedrates } from './feedrates'

export type ClearanceComponent = 'neck' | 'shank' | 'holder'

export interface HolderClearanceCollision {
  readonly moveIndex: number
  readonly move: ToolpathMove
  readonly components: readonly ClearanceComponent[]
}

export interface HolderClearanceReport {
  readonly complete: boolean
  readonly shankStatus: 'checked' | 'invalid-profile'
  readonly holderStatus: 'checked' | 'missing-profile' | 'missing-stickout'
  readonly boundaryPolicy: 'contact-is-collision'
  readonly contactBiasMm: number
  readonly collisions: readonly HolderClearanceCollision[]
  readonly warnings: readonly string[]
}

export interface HolderClearanceCheck {
  readonly stock: StockState
  readonly moves: readonly ToolpathMove[]
  readonly tool: Tool
  readonly holder?: ToolHolder
}

interface RadialComponent {
  kind: ClearanceComponent
  bottomOffsetMm: number
  /** Absent = the component runs on up (the z-dexel stock query is unbounded
   *  upward anyway); only the reach check against the part uses a finite top. */
  topOffsetMm?: number
  diameterMm: number
}

// WO-262 deliberately treats zero intrusion as clear because its primitive asks
// about positive-volume overlap. Clearance checking has the opposite safety
// boundary: physical contact is already a crash. Stock tops are stored as f32,
// so align the queried assembly bottom to that representation before lowering
// it by one micron. Otherwise f32 downward rounding can swallow a fixed nudge.
const CONTACT_BIAS_MM = 1e-6

function contactCollisionZ(z: number): number {
  return Math.fround(z) - CONTACT_BIAS_MM
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

function holderComponents(
  tool: Tool,
  holder: ToolHolder | undefined,
  warnings: string[],
): { status: HolderClearanceReport['holderStatus']; components: RadialComponent[] } {
  // WO-1626 (Operator ruling 2026-09-16): whether to define a holder or a stickout is the
  // operator's decision, not ours to nag about, so neither missing case warns -
  // the check simply has no holder component to add. A holder the operator DID
  // define but that is unreadable (below) is their data being broken, not a
  // choice, and still says so.
  if (!holder || holder.segments.length === 0 || (tool.holderId && holder.id !== tool.holderId)) {
    return { status: 'missing-profile', components: [] }
  }
  if (!isPositiveFinite(tool.lengthBelowHolder)) {
    return { status: 'missing-stickout', components: [] }
  }

  const components: RadialComponent[] = []
  let segmentBottom = tool.lengthBelowHolder
  for (const [index, segment] of holder.segments.entries()) {
    if (
      !isPositiveFinite(segment.height) ||
      !isPositiveFinite(segment.lowerDiameter) ||
      !isPositiveFinite(segment.upperDiameter)
    ) {
      warnings.push(`Holder segment ${index} is invalid; holder clearance was not checked.`)
      return { status: 'missing-profile', components: [] }
    }
    components.push({
      kind: 'holder',
      bottomOffsetMm: segmentBottom,
      // The top segment runs on into the spindle nose.
      ...(index < holder.segments.length - 1 ? { topOffsetMm: segmentBottom + segment.height } : {}),
      // A tapered segment is represented conservatively by its widest diameter
      // from the segment bottom upward. This can over-report; it cannot miss a
      // holder hit in the z-dexel stock representation.
      diameterMm: Math.max(segment.lowerDiameter, segment.upperDiameter),
    })
    segmentBottom += segment.height
  }
  return { status: 'checked', components }
}

/**
 * WO-1565. The neck of an undercut tool (lollipop, disc, dovetail, necked thread
 * mill), read from the tool's own revolved profile - the one source of truth for
 * its shape - as a band from the top of the cutting head to where the shank
 * begins. Absent when the tool declares no neck narrower than its cutter, or its
 * profile carries none; such a tool keeps cutter -> shank -> holder.
 */
export function toolNeckBand(tool: Tool): { bottomMm: number; topMm: number; diameterMm: number } | undefined {
  if (!isPositiveFinite(tool.neckDiameter) || !(tool.neckDiameter < tool.diameter)) return undefined
  const profile = buildToolProfile(tool)
  const shankRadius = tool.shankDiameter / 2
  let widest = 0
  let top = profile.cuttingMaxZ
  const vertices = profile.vertices
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i]
    const b = vertices[i + 1]
    if (b.z <= profile.cuttingMaxZ + 1e-9 || b.z <= a.z) continue
    if (a.z > top + 1e-9) break
    const radius = Math.max(a.r, b.r)
    // The shank (or the cone rising to it) starts here; it is modelled as shank.
    if (radius >= shankRadius - 1e-9) break
    widest = Math.max(widest, radius)
    top = b.z
  }
  if (!(top > profile.cuttingMaxZ) || !(widest > 0)) return undefined
  return { bottomMm: profile.cuttingMaxZ, topMm: top, diameterMm: 2 * widest }
}

function shankComponents(
  tool: Tool,
  warnings: string[],
): { status: HolderClearanceReport['shankStatus']; components: RadialComponent[] } {
  if (!isPositiveFinite(tool.fluteLength) || !isPositiveFinite(tool.shankDiameter)) {
    warnings.push('Tool shank profile is invalid; shank clearance was not checked.')
    return { status: 'invalid-profile', components: [] }
  }

  const exposedTop = isPositiveFinite(tool.lengthBelowHolder)
    ? tool.lengthBelowHolder
    : tool.overallLength
  const neck = toolNeckBand(tool)
  if (neck && isPositiveFinite(exposedTop) && exposedTop > neck.bottomMm) {
    const components: RadialComponent[] = [{
      kind: 'neck',
      bottomOffsetMm: neck.bottomMm,
      topOffsetMm: Math.min(neck.topMm, exposedTop),
      diameterMm: neck.diameterMm,
    }]
    if (exposedTop > neck.topMm) {
      components.push({ kind: 'shank', bottomOffsetMm: neck.topMm, diameterMm: tool.shankDiameter })
    }
    return { status: 'checked', components }
  }
  if (!isPositiveFinite(exposedTop) || exposedTop <= tool.fluteLength) {
    return { status: 'checked', components: [] }
  }
  return {
    status: 'checked',
    components: [{
      kind: 'shank',
      bottomOffsetMm: tool.fluteLength,
      diameterMm: tool.shankDiameter,
    }],
  }
}

function componentHitsMove(
  stock: StockState,
  from: ToolpathMove,
  to: ToolpathMove,
  component: RadialComponent,
): boolean {
  return !isStockRegionEmpty(stock, {
    kind: 'swept-cutter',
    move: {
      x0: from.x,
      y0: from.y,
      z0: contactCollisionZ(from.z + component.bottomOffsetMm),
      x1: to.x,
      y1: to.y,
      z1: contactCollisionZ(to.z + component.bottomOffsetMm),
    },
    cutter: { kind: 'flat', diameter: component.diameterMm },
  })
}

/**
 * Report the original toolpath moves whose non-cutting shank or explicit
 * holder profile intersects remaining stock. The toolpath is never changed.
 * Arc samples are attributed back to their original G2/G3 move index.
 */
export function checkHolderAndShankClearance({
  stock,
  moves,
  tool,
  holder,
}: HolderClearanceCheck): HolderClearanceReport {
  const warnings: string[] = []
  const shank = shankComponents(tool, warnings)
  const holderResult = holderComponents(tool, holder, warnings)
  const components = [...shank.components, ...holderResult.components]
  const hits = new Map<number, Set<ClearanceComponent>>()

  if (moves.length > 0 && components.length > 0) {
    const originIndices: number[] = []
    const sampled = sampleArcMovesForLinearConsumers(moves, {}, originIndices)
    for (let sampleIndex = 0; sampleIndex < sampled.length; sampleIndex++) {
      const to = sampled[sampleIndex]
      const from = sampleIndex === 0 ? to : sampled[sampleIndex - 1]
      const moveIndex = originIndices[sampleIndex]
      for (const component of components) {
        if (!componentHitsMove(stock, from, to, component)) continue
        let moveHits = hits.get(moveIndex)
        if (!moveHits) {
          moveHits = new Set()
          hits.set(moveIndex, moveHits)
        }
        moveHits.add(component.kind)
      }
    }
  }

  const collisions = [...hits.entries()]
    .sort(([a], [b]) => a - b)
    .map(([moveIndex, componentsForMove]) => ({
      moveIndex,
      move: moves[moveIndex],
      components: [...componentsForMove].sort() as ClearanceComponent[],
    }))

  return {
    complete: shank.status === 'checked' && holderResult.status === 'checked',
    shankStatus: shank.status,
    holderStatus: holderResult.status,
    boundaryPolicy: 'contact-is-collision',
    contactBiasMm: CONTACT_BIAS_MM,
    collisions,
    warnings,
  }
}

// ── WO-1565: cut only what the tool assembly can reach ───────────────────────
//
// Operator's rule, 2026-09-15: the cutting head may take material under an overhang,
// but the neck, shank and holder never rub the part or the stock left behind.
// Where going on would make them rub, the cut stops at the last position that
// keeps the allowance, and picks up again where the assembly clears.
//
// The z-dexel stock above cannot hold an overhang (it is one top per column),
// so the PART is represented as vertical solid spans per column, cast from its
// triangle mesh. The remaining stock stays a z-dexel: material from the column
// bottom up to its top is exactly what a stock-left-behind state claims.

/** A triangle mesh in the SAME frame as the moves. */
export interface ClearanceMesh {
  /** xyz triples, mm. */
  readonly positions: ArrayLike<number>
  /** Triangle vertex indices into positions / 3. */
  readonly indices: ArrayLike<number>
}

/** The part as solid Z spans on a regular XY grid of column centres. */
export interface SolidColumns {
  readonly originX: number
  readonly originY: number
  readonly cell: number
  readonly nx: number
  readonly ny: number
  /** Column c = j * nx + i owns spanZ[spanStart[c] .. spanStart[c + 1]):
   *  sorted [bottom, top, bottom, top, ...]; an empty range is air. */
  readonly spanStart: Uint32Array
  readonly spanZ: Float64Array
}

const DEFAULT_PART_CELL_MM = 0.05
const MAX_PART_COLUMNS = 2_000_000
// A cutter that sits exactly on a wall it is cutting touches it by design; only
// an intrusion past this is a gouge. The grid tests column centres, so the head
// is widened by the half-diagonal of a cell to never miss a deeper intrusion, and
// the tolerance is kept at least twice that so a wall it only touches never counts.
const GOUGE_TOLERANCE_MM = 0.05
// Path sampling pitch for the reach check, and bisection depth for the stop.
const REACH_STEP_MM = 0.25
const STOP_BISECTIONS = 14
// WO-1577. A raise is computed as "workholding top + allowance", which puts the
// tool exactly ON the boundary the clearance test asks about. This much extra
// keeps the emitted move STRICTLY clear of it, so f32 span tops and the raise's
// own arithmetic can never round the answer back onto the jaw. Small enough to
// be invisible in the program (a micron), large enough to beat float noise.
const RAISE_MARGIN_MM = 1e-3

/**
 * Cast the mesh into vertical solid spans. Vertical faces carry no XY area and
 * contribute nothing; a column centre on an edge shared by two faces reports the
 * same height twice and is de-duplicated. An odd crossing count (an open mesh)
 * is closed conservatively into one span from the lowest to the highest hit.
 */
export function buildSolidColumns(
  mesh: ClearanceMesh,
  requestedCellMm: number = DEFAULT_PART_CELL_MM,
  maxColumns: number = MAX_PART_COLUMNS,
): SolidColumns | null {
  const { positions, indices } = mesh
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let v = 0; v + 2 < positions.length; v += 3) {
    const x = positions[v]
    const y = positions[v + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(positions[v + 2])) continue
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  if (indices.length < 3 || !(maxX > minX) || !(maxY > minY)) return null

  const area = (maxX - minX) * (maxY - minY)
  const cell = Math.max(requestedCellMm, Math.sqrt(area / maxColumns))
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell))
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell))
  const columns = nx * ny

  // Two passes over the triangles - count, then fill - so a large grid holds
  // flat typed arrays rather than one small array per column.
  const castTriangles = (visit: (column: number, z: number) => void) => {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t] * 3
      const b = indices[t + 1] * 3
      const c = indices[t + 2] * 3
      const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
      const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
      const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]
      const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if (!Number.isFinite(area2) || Math.abs(area2) < 1e-12) continue
      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - minX) / cell - 0.5))
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - minX) / cell - 0.5))
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - minY) / cell - 0.5))
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - minY) / cell - 0.5))
      for (let j = j0; j <= j1; j++) {
        const py = minY + (j + 0.5) * cell
        for (let i = i0; i <= i1; i++) {
          const px = minX + (i + 0.5) * cell
          const wa = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) / area2
          const wb = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) / area2
          const wc = 1 - wa - wb
          if (wa < -1e-12 || wb < -1e-12 || wc < -1e-12) continue
          visit(j * nx + i, wa * az + wb * bz + wc * cz)
        }
      }
    }
  }

  const hitStart = new Uint32Array(columns + 1)
  castTriangles((column) => { hitStart[column + 1]++ })
  for (let column = 0; column < columns; column++) hitStart[column + 1] += hitStart[column]
  const hitZ = new Float64Array(hitStart[columns])
  const filled = hitStart.slice(0, columns)
  castTriangles((column, z) => { hitZ[filled[column]++] = z })

  const spanStart = new Uint32Array(columns + 1)
  const spanZ = new Float64Array(hitZ.length)
  let written = 0
  for (let column = 0; column < columns; column++) {
    spanStart[column] = written
    const from = hitStart[column]
    const to = hitStart[column + 1]
    if (to - from < 2) continue
    const hits = hitZ.subarray(from, to).sort()
    let unique = 0
    for (let k = 0; k < hits.length; k++) {
      if (unique === 0 || hits[k] - hits[unique - 1] > 1e-6) hits[unique++] = hits[k]
    }
    if (unique < 2) continue
    if (unique % 2 === 0) {
      for (let k = 0; k < unique; k++) spanZ[written++] = hits[k]
    } else {
      spanZ[written++] = hits[0]
      spanZ[written++] = hits[unique - 1]
    }
  }
  spanStart[columns] = written
  return { originX: minX, originY: minY, cell, nx, ny, spanStart, spanZ: spanZ.slice(0, written) }
}

interface HeadBand {
  bottom: number
  top: number
  radius: number
}

/**
 * WO-1813. A cutting-head profile compiled once for all reach samples in one
 * trim. Monotone profiles can use two exact lower-bound searches: first for a
 * radius that passes the existing strict radial comparison, then for a band
 * top that passes the existing strict Z comparison. Profiles whose radius or
 * axial order is not proved monotone keep the original scan.
 */
interface HeadBandIndex {
  readonly bands: readonly HeadBand[]
  readonly maxRadius: number
  /** WO-1975: radii never narrow before `peak` and never widen after it, and
   *  bands are ordered tip-up - a ball or lollipop as well as a cone or flat. The
   *  bands wider than any distance are then one contiguous run around the peak. */
  readonly monotone: boolean
  /** Index of the first widest band. */
  readonly peak: number
}

function indexHeadBands(bands: readonly HeadBand[]): HeadBandIndex {
  let maxRadius = 0
  let peak = 0
  let monotone = true
  let narrowing = false
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]
    if (band.radius > maxRadius) {
      maxRadius = band.radius
      peak = i
    }
    if (i > 0) {
      const previous = bands[i - 1]
      if (band.bottom < previous.bottom || band.top < previous.top) monotone = false
      if (band.radius < previous.radius) narrowing = true
      else if (band.radius > previous.radius && narrowing) monotone = false
    }
  }
  return { bands, maxRadius, monotone, peak }
}

/** Whether any part column under a disc of `radius` holds solid between z0 and z1. */
function partHitsCylinder(part: SolidColumns, x: number, y: number, radius: number, z0: number, z1: number): boolean {
  const { originX, originY, cell, nx, ny, spanStart, spanZ } = part
  const i0 = Math.max(0, Math.ceil((x - radius - originX) / cell - 0.5))
  const i1 = Math.min(nx - 1, Math.floor((x + radius - originX) / cell - 0.5))
  const j0 = Math.max(0, Math.ceil((y - radius - originY) / cell - 0.5))
  const j1 = Math.min(ny - 1, Math.floor((y + radius - originY) / cell - 0.5))
  const r2 = radius * radius
  for (let j = j0; j <= j1; j++) {
    const dy = originY + (j + 0.5) * cell - y
    if (dy * dy > r2) continue
    for (let i = i0; i <= i1; i++) {
      const column = j * nx + i
      const end = spanStart[column + 1]
      if (spanStart[column] === end) continue
      const dx = originX + (i + 0.5) * cell - x
      if (dx * dx + dy * dy > r2) continue
      for (let k = spanStart[column]; k < end; k += 2) {
        if (spanZ[k] < z1 && spanZ[k + 1] > z0) return true
      }
    }
  }
  return false
}

/**
 * WO-1577. The highest solid top under a disc of `radius`, or -Infinity where
 * every column in reach is air. Spans are stored sorted, so a column's last
 * entry is its highest top - an overhanging clamp nose included.
 */
function highestSpanTop(columns: SolidColumns, x: number, y: number, radius: number): number {
  const { originX, originY, cell, nx, ny, spanStart, spanZ } = columns
  const i0 = Math.max(0, Math.ceil((x - radius - originX) / cell - 0.5))
  const i1 = Math.min(nx - 1, Math.floor((x + radius - originX) / cell - 0.5))
  const j0 = Math.max(0, Math.ceil((y - radius - originY) / cell - 0.5))
  const j1 = Math.min(ny - 1, Math.floor((y + radius - originY) / cell - 0.5))
  const r2 = radius * radius
  let top = Number.NEGATIVE_INFINITY
  for (let j = j0; j <= j1; j++) {
    const dy = originY + (j + 0.5) * cell - y
    if (dy * dy > r2) continue
    for (let i = i0; i <= i1; i++) {
      const column = j * nx + i
      const end = spanStart[column + 1]
      if (spanStart[column] === end) continue
      const dx = originX + (i + 0.5) * cell - x
      if (dx * dx + dy * dy > r2) continue
      if (spanZ[end - 1] > top) top = spanZ[end - 1]
    }
  }
  return top
}

/** WO-1577. The highest solid top anywhere in an XY window, or -Infinity for air. */
function highestSpanTopInWindow(
  columns: SolidColumns, minX: number, minY: number, maxX: number, maxY: number,
): number {
  const { originX, originY, cell, nx, ny, spanStart, spanZ } = columns
  const i0 = Math.max(0, Math.ceil((minX - originX) / cell - 0.5))
  const i1 = Math.min(nx - 1, Math.floor((maxX - originX) / cell - 0.5))
  const j0 = Math.max(0, Math.ceil((minY - originY) / cell - 0.5))
  const j1 = Math.min(ny - 1, Math.floor((maxY - originY) / cell - 0.5))
  let top = Number.NEGATIVE_INFINITY
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const column = j * nx + i
      const end = spanStart[column + 1]
      if (spanStart[column] === end) continue
      if (spanZ[end - 1] > top) top = spanZ[end - 1]
    }
  }
  return top
}

/**
 * WO-1577. The lowest tool-tip Z at which a disc of `radius` standing at (x, y)
 * keeps `allowanceMm` from every piece of workholding under it, or -Infinity
 * where nothing stands there.
 *
 * This is the whole arithmetic of going OVER a jaw rather than through it, and
 * it is short because everything on the assembly sits at the tip or above it:
 * put the tip above the highest thing in the way plus the allowance and the
 * neck, shank and holder are above that again. `cam3d`'s stay-down links use it
 * with the cutter's own radius; `trimToolpathToAssemblyReach` applies the same
 * rule per component so a wide holder 40 mm up does not lift a link it clears.
 */
export function workholdingClearTipZ(
  workholding: readonly SolidColumns[],
  x: number,
  y: number,
  radius: number,
  allowanceMm: number,
): number {
  let need = Number.NEGATIVE_INFINITY
  for (const fixture of workholding) {
    const top = highestSpanTop(fixture, x, y, radius + allowanceMm + fixture.cell * Math.SQRT1_2)
    if (top > Number.NEGATIVE_INFINITY) need = Math.max(need, top + allowanceMm + RAISE_MARGIN_MM)
  }
  return need
}

/** Whether the revolved cutting head, translated to world Z, enters the part. */
function partHitsHead(
  part: SolidColumns,
  x: number,
  y: number,
  index: HeadBandIndex,
  z: number,
  lift: number,
  bottomOffset: number,
): boolean {
  const { bands, maxRadius } = index
  const { originX, originY, cell, nx, ny, spanStart, spanZ } = part
  const i0 = Math.max(0, Math.ceil((x - maxRadius - originX) / cell - 0.5))
  const i1 = Math.min(nx - 1, Math.floor((x + maxRadius - originX) / cell - 0.5))
  const j0 = Math.max(0, Math.ceil((y - maxRadius - originY) / cell - 0.5))
  const j1 = Math.min(ny - 1, Math.floor((y + maxRadius - originY) / cell - 0.5))
  for (let j = j0; j <= j1; j++) {
    const dy = originY + (j + 0.5) * cell - y
    for (let i = i0; i <= i1; i++) {
      const column = j * nx + i
      const end = spanStart[column + 1]
      if (spanStart[column] === end) continue
      const dx = originX + (i + 0.5) * cell - x
      const d = Math.hypot(dx, dy)
      if (d > maxRadius) continue

      if (bands.length === 1) {
        // Flat and cylindrical cutting heads have one band. Avoid both binary
        // searches in this common roughing case while retaining the old loop's
        // arithmetic and strict contact policy.
        const band = bands[0]
        if (band.radius <= d) continue
        const bottom = z + band.bottom + bottomOffset
        const top = z + lift + band.top
        for (let k = spanStart[column]; k < end; k += 2) {
          if (spanZ[k] < top && spanZ[k + 1] > bottom) return true
        }
        continue
      }

      if (!index.monotone) {
        // Exact fallback for lollipop, dovetail, thread and any future profile
        // whose radii narrow or whose axial bands are not ordered tip-up.
        for (const band of bands) {
          if (band.radius <= d) continue
          const bottom = z + band.bottom + bottomOffset
          const top = z + lift + band.top
          for (let k = spanStart[column]; k < end; k += 2) {
            if (spanZ[k] < top && spanZ[k + 1] > bottom) return true
          }
        }
        continue
      }

      // First band with radius > d, searched up to the peak. This is the same
      // strict comparison as the scan above; plateaus and exact/ULP-neighbor
      // contacts keep their verdict.
      const { peak } = index
      if (bands[peak].radius <= d) continue
      let radialLo = 0
      let radialHi = peak
      while (radialLo < radialHi) {
        const mid = (radialLo + radialHi) >>> 1
        if (bands[mid].radius <= d) radialLo = mid + 1
        else radialHi = mid
      }
      // WO-1975: past the peak the head narrows again (a ball above its
      // equator); the eligible run ends at the first band there with radius <= d.
      let eligibleEnd = peak + 1
      let narrowHi = bands.length
      while (eligibleEnd < narrowHi) {
        const mid = (eligibleEnd + narrowHi) >>> 1
        if (bands[mid].radius <= d) narrowHi = mid
        else eligibleEnd = mid + 1
      }

      for (let k = spanStart[column]; k < end; k += 2) {
        // Among the radially eligible run, find the first band whose top is
        // strictly above this span's bottom. If that band's bottom is below the
        // span top, it overlaps. Otherwise every later bottom is higher and no
        // band can overlap. This remains exact when bottomOffset > lift leaves
        // axial gaps between adjacent bands; the gaps are never unioned.
        let axialLo = radialLo
        let axialHi = eligibleEnd
        while (axialLo < axialHi) {
          const mid = (axialLo + axialHi) >>> 1
          const top = z + lift + bands[mid].top
          if (spanZ[k] < top) axialHi = mid
          else axialLo = mid + 1
        }
        if (axialLo === eligibleEnd) continue
        const bottom = z + bands[axialLo].bottom + bottomOffset
        if (spanZ[k + 1] > bottom) return true
      }
    }
  }
  return false
}

/** Whether remaining stock (material from the column bottom to its top) lies
 *  under a disc of `radius` above zBottom. */
function stockHitsCylinder(stock: StockState, x: number, y: number, radius: number, zBottom: number): boolean {
  const cell = stock.resolutionMm
  const { minX, minY } = stock.bounds
  const i0 = Math.max(0, Math.ceil((x - radius - minX) / cell - 0.5))
  const i1 = Math.min(stock.nx - 1, Math.floor((x + radius - minX) / cell - 0.5))
  const j0 = Math.max(0, Math.ceil((y - radius - minY) / cell - 0.5))
  const j1 = Math.min(stock.ny - 1, Math.floor((y + radius - minY) / cell - 0.5))
  const r2 = radius * radius
  for (let j = j0; j <= j1; j++) {
    const dy = minY + (j + 0.5) * cell - y
    if (dy * dy > r2) continue
    for (let i = i0; i <= i1; i++) {
      const dx = minX + (i + 0.5) * cell - x
      if (dx * dx + dy * dy > r2) continue
      const top = stock.topZ[j * stock.nx + i]
      if (top > stock.bottomZ && top > zBottom) return true
    }
  }
  return false
}

export type ReachComponent = ClearanceComponent | 'cutter'
export type ReachObstacle = 'part' | 'stock' | 'workholding'

export interface ReachBlocker {
  /** 'cutter' = the cutting head itself would cut into the part, or come within
   *  the allowance of the workholding. */
  readonly component: ReachComponent
  readonly obstacle: ReachObstacle
}

export interface ReachPoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface ReachStop {
  /** The last position that keeps the allowance, or absent when the path could
   *  not be reached from its very start. */
  readonly stoppedAt?: ReachPoint
  /** Where cutting picks up again; absent when nothing after the stop is reachable. */
  readonly resumedAt?: ReachPoint
  /** What would rub first past the stop. */
  readonly blocker: ReachBlocker
  /** Feed path length (mm) between the stop and the resume that was not cut. */
  readonly uncutMm: number
}

export interface ToolReachCheck {
  readonly moves: readonly ToolpathMove[]
  readonly tool: Tool
  /** Operation-resolved rate for the vertical re-entry inserted by the trim. */
  readonly plungeRate?: number
  readonly holder?: ToolHolder
  /** The part, as column spans. Absent = only the stock is checked. */
  readonly part?: SolidColumns | null
  /** Material present while this operation runs. Absent = no stock check. */
  readonly stock?: StockState
  /** WO-1575. Vises, jaws and clamps as column spans (an overhanging clamp nose
   *  is a second span over the same column). Every component of the tool - the
   *  cutter included - keeps the allowance from them. Absent or empty = none. */
  readonly workholding?: readonly SolidColumns[]
  /** Radial and axial clearance kept between neck/shank/holder and the part or
   *  stock, and between every component and the workholding. */
  readonly allowanceMm: number
}

/**
 * WO-1577. A non-cutting move that was raised so it passes OVER the workholding
 * instead of through it: a rapid between features, a link, or the trim's own
 * retract / re-entry between two stretches of cut.
 */
export interface RaisedTraverse {
  /** Where the raised link leaves. */
  readonly from: ReachPoint
  /** Where it lands. */
  readonly to: ReachPoint
  /** Tool tip Z the raised link travels across at, mm. */
  readonly travelZ: number
  /** Highest workholding under that link, mm - `travelZ` clears it by the allowance. */
  readonly overTopZ: number
  /** True for a link this function emitted itself (a retract / re-entry around a
   *  trimmed stretch), false for a move that was already in the program. */
  readonly link: boolean
}

export interface ToolReachResult {
  /** The original moves when nothing had to be trimmed; otherwise the trimmed path. */
  readonly moves: readonly ToolpathMove[]
  readonly trimmed: boolean
  readonly stops: readonly ReachStop[]
  /** WO-1577: every non-cutting move raised to clear the workholding. */
  readonly raised: readonly RaisedTraverse[]
  readonly shankStatus: HolderClearanceReport['shankStatus']
  readonly holderStatus: HolderClearanceReport['holderStatus']
  readonly warnings: readonly string[]
}

interface PathPosition extends ReachPoint {
  /** Index into the sampled path; the position lies on the segment ending there. */
  readonly seg: number
  /** 0..1 along that segment (1 = its end point). */
  readonly t: number
}

/**
 * The cutting head as stacked cylinders. A band is as wide as its segment's
 * widest end, so it claims the head from its bottom out to that width. For a
 * sloped segment - a V-bit's cone, the flanks of a ball or bull corner - that
 * over-claims by up to the band's height: WO-1975 found one 5 mm cone band
 * standing in for a full-radius cylinder from the tip, trimming a V-bit off every
 * slope it cleared. `maxBandHeightMm` splits sloped segments into bands no taller
 * than that, so the over-claim stays inside the gouge tolerance that lifts every
 * band's bottom. Vertical segments are exact as one band.
 */
function headBandsFor(tool: Tool, toleranceMm: number, slackMm: number, maxBandHeightMm = Infinity): HeadBand[] {
  const profile = buildToolProfile(tool)
  const bands: HeadBand[] = []
  const vertices = profile.vertices
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i]
    const b = vertices[i + 1]
    if (a.z >= profile.cuttingMaxZ - 1e-9) break
    if (!(b.z > a.z)) continue
    const top = Math.min(b.z, profile.cuttingMaxZ)
    const pieces = a.r === b.r ? 1 : Math.max(1, Math.ceil((top - a.z) / maxBandHeightMm - 1e-9))
    if (pieces === 1) {
      const radius = Math.max(a.r, b.r) - toleranceMm + slackMm
      if (radius > 0) bands.push({ bottom: a.z, top, radius })
      continue
    }
    const radiusAt = (z: number) => a.r + (b.r - a.r) * ((z - a.z) / (b.z - a.z))
    for (let p = 0; p < pieces; p++) {
      const z0 = p === 0 ? a.z : a.z + (top - a.z) * (p / pieces)
      const z1 = p === pieces - 1 ? top : a.z + (top - a.z) * ((p + 1) / pieces)
      const radius = Math.max(radiusAt(z0), radiusAt(z1)) - toleranceMm + slackMm
      if (radius > 0) bands.push({ bottom: z0, top: z1, radius })
    }
  }
  return bands
}

/**
 * Trim a computed toolpath to what the tool assembly can reach. Nothing is
 * refused: positions where the neck, shank or holder would come within the
 * allowance of the part or the stock - or where the cutter itself would cut the
 * part - are left out, the cut stops at the last clear position, backs out along
 * its own path to where it can lift straight up, and re-enters where it can come
 * straight down. A path with nothing to trim is returned as the same array.
 */
export function trimToolpathToAssemblyReach({
  moves,
  tool,
  plungeRate,
  holder,
  part,
  stock,
  workholding = [],
  allowanceMm,
}: ToolReachCheck): ToolReachResult {
  const warnings: string[] = []
  const shank = shankComponents(tool, warnings)
  const holderResult = holderComponents(tool, holder, warnings)
  const components = [...shank.components, ...holderResult.components]
  const base = {
    shankStatus: shank.status,
    holderStatus: holderResult.status,
    warnings,
  }
  const unchanged: ToolReachResult = { moves, trimmed: false, stops: [], raised: [], ...base }
  if (moves.length === 0 || (!part && !stock && workholding.length === 0)) return unchanged

  const allowance = Math.max(0, allowanceMm)
  // Against workholding nothing touches by design: the whole cutting head, at its
  // full profile radius, keeps the allowance like the rest of the assembly.
  const fixtureHead = workholding.length > 0 ? headBandsFor(tool, 0, 0) : []
  const gougeTolerance = part ? Math.max(GOUGE_TOLERANCE_MM, 2 * part.cell * Math.SQRT1_2) : 0
  // WO-1975: sloped head segments are split to bands no taller than the gouge
  // tolerance, so a V-bit's cone is a cone and not a full-width cylinder.
  const head = part ? headBandsFor(tool, gougeTolerance, part.cell * Math.SQRT1_2, gougeTolerance) : []
  const headIndex = indexHeadBands(head)
  const partSlack = part ? part.cell * Math.SQRT1_2 : 0
  const stockSlack = stock ? stock.resolutionMm * Math.SQRT1_2 : 0

  // A head coming straight down bores the hole its own narrower neck follows it
  // into, so a descending neck is not rubbing the stock that head just removed.
  const profile = buildToolProfile(tool)
  const boreRadius = profile.vertices.reduce(
    (widest, vertex) => vertex.z <= profile.cuttingMaxZ + 1e-9 ? Math.max(widest, vertex.r) : widest, 0)

  const blockerAt = (x: number, y: number, z: number, riseTo: number, descending: boolean): ReachBlocker | null => {
    const lift = Math.max(0, riseTo - z)
    for (const component of components) {
      const radius = component.diameterMm / 2 + allowance
      const bottom = z + component.bottomOffsetMm - allowance
      if (part) {
        const top = component.topOffsetMm === undefined
          ? Number.POSITIVE_INFINITY
          : z + lift + component.topOffsetMm + allowance
        if (partHitsCylinder(part, x, y, radius + partSlack, bottom, top)) {
          return { component: component.kind, obstacle: 'part' }
        }
      }
      const inOwnBore = descending && radius <= boreRadius
      if (stock && !inOwnBore && stockHitsCylinder(stock, x, y, radius + stockSlack, bottom)) {
        return { component: component.kind, obstacle: 'stock' }
      }
    }
    if (part && head.length > 0) {
      if (partHitsHead(part, x, y, headIndex, z, lift, gougeTolerance)) {
        return { component: 'cutter', obstacle: 'part' }
      }
    }
    for (const fixture of workholding) {
      const slack = fixture.cell * Math.SQRT1_2
      for (const band of fixtureHead) {
        if (partHitsCylinder(fixture, x, y, band.radius + allowance + slack,
          z + band.bottom - allowance, z + lift + band.top + allowance)) {
          return { component: 'cutter', obstacle: 'workholding' }
        }
      }
      for (const component of components) {
        const top = component.topOffsetMm === undefined
          ? Number.POSITIVE_INFINITY
          : z + lift + component.topOffsetMm + allowance
        if (partHitsCylinder(fixture, x, y, component.diameterMm / 2 + allowance + slack,
          z + component.bottomOffsetMm - allowance, top)) {
          return { component: component.kind, obstacle: 'workholding' }
        }
      }
    }
    return null
  }

  // ── WO-1577: non-cutting moves go OVER the workholding, never through it ───
  //
  // Same obstacle columns as the trim above - there is no second model. The one
  // number a raise needs is the lowest TIP z at which nothing of the assembly is
  // within the allowance of a jaw, and that number is easy because every part of
  // the tool sits at the tip or above it: for a band or component standing
  // `offset` above the tip, the tip clears a jaw topping out at `top` once it is
  // at `top + allowance - offset`. The binding term is therefore the cutting
  // head's own bottom (offset 0) whenever the head is over the jaw at all, and a
  // wide holder 40 mm up stops mattering, which is why a raise lifts by the jaw
  // and not by the widest thing on the spindle.
  const raised: RaisedTraverse[] = []

  /** Lowest tip z that keeps the whole assembly clear of workholding at (x, y). */
  const clearTipZAt = (x: number, y: number): number => {
    let need = Number.NEGATIVE_INFINITY
    for (const fixture of workholding) {
      const slack = fixture.cell * Math.SQRT1_2
      for (const band of fixtureHead) {
        const top = highestSpanTop(fixture, x, y, band.radius + allowance + slack)
        if (top > Number.NEGATIVE_INFINITY) need = Math.max(need, top + allowance - band.bottom)
      }
      for (const component of components) {
        const top = highestSpanTop(fixture, x, y, component.diameterMm / 2 + allowance + slack)
        if (top > Number.NEGATIVE_INFINITY) need = Math.max(need, top + allowance - component.bottomOffsetMm)
      }
    }
    return need > Number.NEGATIVE_INFINITY ? need + RAISE_MARGIN_MM : need
  }

  /** Sample points along an XY corridor, endpoints included. */
  const corridor = (from: ReachPoint, to: ReachPoint): { x: number; y: number }[] => {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / REACH_STEP_MM))
    const pts: { x: number; y: number }[] = []
    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
    return pts
  }

  /** The lowest tip z that clears the workholding everywhere along a corridor. */
  const clearTipZAlong = (from: ReachPoint, to: ReachPoint): number =>
    corridor(from, to).reduce((need, p) => Math.max(need, clearTipZAt(p.x, p.y)), Number.NEGATIVE_INFINITY)

  /** Widest thing on the assembly, for reporting which workholding a link passed over. */
  const assemblyRadius = Math.max(
    fixtureHead.reduce((widest, band) => Math.max(widest, band.radius), 0),
    components.reduce((widest, component) => Math.max(widest, component.diameterMm / 2), 0),
  )

  /** The highest workholding anywhere under a corridor - what a raise went over. */
  const fixtureTopAlong = (from: ReachPoint, to: ReachPoint): number => {
    let top = Number.NEGATIVE_INFINITY
    for (const p of corridor(from, to)) {
      for (const fixture of workholding) {
        top = Math.max(top, highestSpanTop(
          fixture, p.x, p.y, assemblyRadius + allowance + fixture.cell * Math.SQRT1_2))
      }
    }
    return top
  }

  /**
   * A raise is only taken when the moves it emits are themselves proven at the
   * emitted height: the straight lift where it leaves, the corridor it crosses
   * at, and the straight descent where it lands. A lift is NOT free against
   * workholding - a clamp nose is a second span over the same column - so it is
   * checked like anything else. What cannot be proven is left alone and falls
   * through to the trim below, which backs out along the path to somewhere it
   * can lift and re-enters where it can come down.
   */
  const raiseIsProven = (from: ReachPoint, to: ReachPoint, travelZ: number): boolean => {
    if (blockerAt(from.x, from.y, from.z, travelZ, false) !== null) return false
    for (const p of corridor(from, to)) {
      if (blockerAt(p.x, p.y, travelZ, travelZ, false) !== null) return false
    }
    return blockerAt(to.x, to.y, to.z, travelZ, true) === null
  }

  const isTraverse = (move: ToolpathMove): boolean => move.type === 'rapid' || move.role === 'rapid'

  const raiseTraverses = (): readonly ToolpathMove[] => {
    const lifted: ToolpathMove[] = []
    let from: ReachPoint | null = null
    for (const move of moves) {
      const to: ReachPoint = { x: move.x, y: move.y, z: move.z }
      const linear = move.type !== 'arc_cw' && move.type !== 'arc_ccw'
      if (from === null || !linear || !isTraverse(move)) {
        lifted.push(move)
        from = to
        continue
      }
      const need = clearTipZAlong(from, to)
      const travelZ = Math.max(need, from.z, to.z)
      if (!(need > Math.min(from.z, to.z)) || !raiseIsProven(from, to, travelZ)) {
        lifted.push(move)
        from = to
        continue
      }
      // Up where it stands, across over the jaw, down where it lands - each leg
      // keeping this move's own type, role and feed so a raised link is still
      // the same kind of move it was.
      if (travelZ > from.z) lifted.push({ ...move, x: from.x, y: from.y, z: travelZ })
      lifted.push({ ...move, z: travelZ })
      if (to.z < travelZ) lifted.push({ ...move })
      raised.push({ from, to, travelZ, overTopZ: fixtureTopAlong(from, to), link: false })
      from = to
    }
    return lifted
  }

  const pathMoves = workholding.length > 0 ? raiseTraverses() : moves

  const sampled = sampleArcMovesForLinearConsumers(pathMoves)
  const pointAt = (seg: number, t: number): PathPosition => {
    const end = sampled[seg]
    if (seg === 0 || t >= 1) return { seg, t: seg === 0 ? 1 : t, x: end.x, y: end.y, z: end.z }
    const start = sampled[seg - 1]
    return {
      seg,
      t,
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      z: start.z + (end.z - start.z) * t,
    }
  }

  // Feed length up to each sampled end point; rapids cut nothing.
  const segmentLength: number[] = [0]
  const feedBefore: number[] = [0]
  let topZ = sampled[0].z
  for (let seg = 1; seg < sampled.length; seg++) {
    const a = sampled[seg - 1]
    const b = sampled[seg]
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    segmentLength.push(length)
    feedBefore.push(feedBefore[seg - 1] + (b.type === 'rapid' ? 0 : length))
    topZ = Math.max(topZ, b.z)
  }
  const feedAt = (p: PathPosition): number => p.seg === 0
    ? 0
    : feedBefore[p.seg - 1] + (sampled[p.seg].type === 'rapid' ? 0 : segmentLength[p.seg] * p.t)

  const positions: PathPosition[] = [pointAt(0, 1)]
  for (let seg = 1; seg < sampled.length; seg++) {
    const steps = Math.max(1, Math.ceil(segmentLength[seg] / REACH_STEP_MM))
    for (let step = 1; step <= steps; step++) positions.push(pointAt(seg, step / steps))
  }
  const descends = (seg: number): boolean => seg > 0 &&
    sampled[seg].x === sampled[seg - 1].x && sampled[seg].y === sampled[seg - 1].y && sampled[seg].z < sampled[seg - 1].z
  const blockers = positions.map((p) => blockerAt(p.x, p.y, p.z, p.z, descends(p.seg)))

  // WO-1577. The height this function's OWN links travel at - the retract off a
  // trimmed stretch and the re-entry into the next one. It was the path's own top,
  // which a jaw taller than the retract height stands straight through. Raised
  // here over every piece of workholding standing anywhere near the path, so the
  // link between two stops clears the jaw, and so `canComeDown` / `canLift` judge
  // the lift column over its WHOLE travel rather than only up to the old top.
  // One number for the whole path, like the top it replaces: the link between two
  // stretches is a straight line that may cross anywhere inside the path's own
  // footprint, so the only honest window is that footprint.
  let linkZ = topZ
  if (workholding.length > 0) {
    let minX = sampled[0].x, maxX = sampled[0].x, minY = sampled[0].y, maxY = sampled[0].y
    for (const point of sampled) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
    }
    for (const fixture of workholding) {
      // The cutting head's own bottom sits at the tip, so it is the binding
      // component wherever the assembly is over a jaw at all; nothing above the
      // tip can need a higher tip than that.
      const reach = assemblyRadius + allowance + fixture.cell * Math.SQRT1_2
      const top = highestSpanTopInWindow(fixture, minX - reach, minY - reach, maxX + reach, maxY + reach)
      if (top > Number.NEGATIVE_INFINITY) linkZ = Math.max(linkZ, top + allowance + RAISE_MARGIN_MM)
    }
  }

  /**
   * WO-1577. Say it. One sentence, on the console, whenever a non-cutting move
   * was moved to pass over the workholding - the operator sees a rapid at a
   * height he did not ask for and is owed the reason. It is a warning rather
   * than a refusal because nothing was refused: the program still does
   * everything it was asked to do, over the jaw instead of through it.
   */
  const announceRaises = (): void => {
    if (raised.length === 0) return
    const travelZ = raised.reduce((highest, link) => Math.max(highest, link.travelZ), Number.NEGATIVE_INFINITY)
    const overTopZ = raised.reduce((highest, link) => Math.max(highest, link.overTopZ), Number.NEGATIVE_INFINITY)
    const what = raised.length === 1 ? 'one non-cutting move was' : `${raised.length} non-cutting moves were`
    const sentence =
      `${what} raised to Z ${travelZ.toFixed(2)} to pass over the workholding, ` +
      `which tops out at Z ${overTopZ.toFixed(2)}`
    warnings.push(`${sentence}.`)
    // eslint-disable-next-line no-console
    console.info(`[workholding-clearance] ${sentence} (allowance ${allowance} mm, WO-1577).`)
  }

  if (blockers.every((blocker) => blocker === null)) {
    if (raised.length === 0) return unchanged
    announceRaises()
    return { moves: pathMoves, trimmed: true, stops: [], raised, ...base }
  }

  // Bisect along the segment between two consecutive positions whose verdicts
  // differ. Returns the clear side of the boundary.
  const refine = (clearSide: PathPosition, blockedSide: PathPosition): PathPosition => {
    const forward = blockedSide.seg > clearSide.seg ||
      (blockedSide.seg === clearSide.seg && blockedSide.t > clearSide.t)
    const later = forward ? blockedSide : clearSide
    const earlier = forward ? clearSide : blockedSide
    const seg = later.seg
    let clearT = forward ? (earlier.seg === seg ? earlier.t : 0) : later.t
    let blockedT = forward ? later.t : (earlier.seg === seg ? earlier.t : 0)
    for (let i = 0; i < STOP_BISECTIONS; i++) {
      const mid = (clearT + blockedT) / 2
      const p = pointAt(seg, mid)
      if (blockerAt(p.x, p.y, p.z, p.z, descends(seg)) === null) clearT = mid
      else blockedT = mid
    }
    return pointAt(seg, clearT)
  }

  interface Run { first: number; last: number; start: PathPosition; end: PathPosition; points: PathPosition[] }
  const runs: Run[] = []
  for (let index = 0; index < positions.length; index++) {
    if (blockers[index] !== null) continue
    let last = index
    while (last + 1 < positions.length && blockers[last + 1] === null) last++
    const start = index === 0 ? positions[0] : refine(positions[index], positions[index - 1])
    const end = last === positions.length - 1 ? positions[last] : refine(positions[last], positions[last + 1])
    runs.push({ first: index, last, start, end, points: [start, ...positions.slice(index, last + 1), end] })
    index = last
  }

  const canComeDown = (p: PathPosition) => blockerAt(p.x, p.y, p.z, linkZ, true) === null
  const canLift = (p: PathPosition) => blockerAt(p.x, p.y, p.z, linkZ, false) === null
  const out: ToolpathMove[] = []
  const template = (seg: number): ToolpathMove => {
    const { cx: _cx, cy: _cy, ...rest } = sampled[seg]
    return rest.type === 'arc_cw' || rest.type === 'arc_ccw' ? { ...rest, type: 'feed' } : rest
  }
  const feedOf = (seg: number): number | undefined => {
    for (let s = seg; s >= 0; s--) if (sampled[s].type !== 'rapid' && sampled[s].feed !== undefined) return sampled[s].feed
    return moves.find((move) => move.type !== 'rapid' && move.feed !== undefined)?.feed
  }
  // The sampled end points strictly between two positions along the path, then `to`.
  const between = (from: PathPosition, to: PathPosition): PathPosition[] => {
    const pts: PathPosition[] = []
    const lo = from.seg + (from.t >= 1 || from.seg === 0 ? 1 : 0)
    for (let seg = lo; seg < to.seg; seg++) pts.push(pointAt(seg, 1))
    return pts
  }
  const emitForward = (from: PathPosition, to: PathPosition) => {
    for (const p of [...between(from, to), to]) {
      if (p === from) continue
      out.push({ ...template(p.seg), x: p.x, y: p.y, z: p.z })
    }
  }
  const emitBackward = (from: PathPosition, to: PathPosition, role: ToolpathMove['role']) => {
    const pts = [...between(to, from)].reverse()
    pts.push(to)
    for (const p of pts) {
      if (p.x === from.x && p.y === from.y && p.z === from.z) continue
      const feed = feedOf(p.seg)
      out.push({ type: 'feed', x: p.x, y: p.y, z: p.z, role, ...(feed !== undefined ? { feed } : {}) })
    }
  }

  const stops: ReachStop[] = []
  const lastIndex = positions.length - 1
  // WO-1597: stretches left uncut because nothing along them could get back out.
  const trapped: Run[] = []
  // End of the last run actually cut, and the first position after it.
  let previousEnd: PathPosition | undefined
  // WO-1577: where the tool last lifted off the path, so a raised link can say
  // where it left from.
  let previousExit: PathPosition | undefined
  let gapStart = 0
  const recordGap = (gapEnd: number, resume: PathPosition | undefined) => {
    let blocker: ReachBlocker | null = null
    for (let i = gapStart; i < gapEnd && blocker === null; i++) blocker = blockers[i]
    if (blocker === null) return
    const uncut = (resume ? feedAt(resume) : feedAt(positions[lastIndex])) - (previousEnd ? feedAt(previousEnd) : 0)
    stops.push({
      ...(previousEnd ? { stoppedAt: { x: previousEnd.x, y: previousEnd.y, z: previousEnd.z } } : {}),
      ...(resume ? { resumedAt: { x: resume.x, y: resume.y, z: resume.z } } : {}),
      blocker,
      uncutMm: Math.max(0, uncut),
    })
  }

  for (const run of runs) {
    // Come straight down where the whole assembly clears, then work back along
    // the path to where this stretch starts.
    const entry = run.first === 0 ? undefined : run.points.find(canComeDown)
    if (run.first !== 0 && !entry) continue // no way down into this stretch: it stays part of the gap
    // WO-1597. Where the tool gets back out, decided BEFORE anything of this
    // stretch is cut: back out along the path to where the whole column up to
    // linkZ is proven clear, or else up the very column the plunge into this
    // stretch was proven down. When neither exists the stretch is not cut at all
    // - a retract nobody proved is never emitted - and the console says why.
    const finishes = run.last === lastIndex
    const exit = finishes ? undefined : [...run.points].reverse().find(canLift) ?? entry
    if (!finishes && !exit) {
      trapped.push(run)
      continue
    }
    if (!entry) {
      out.push(template(0))
    } else {
      recordGap(run.first, run.start)
      // WO-1577: the link from the last stop to this re-entry travels at linkZ,
      // which stands over the workholding. Recorded when a jaw is what put it
      // there, so the console can say the move was raised over the workholding.
      if (linkZ > topZ) {
        const leave = previousExit ?? positions[0]
        raised.push({
          from: { x: leave.x, y: leave.y, z: leave.z },
          to: { x: entry.x, y: entry.y, z: entry.z },
          travelZ: linkZ,
          overTopZ: fixtureTopAlong(leave, entry),
          link: true,
        })
      }
      out.push({ type: 'rapid', role: 'rapid', x: entry.x, y: entry.y, z: linkZ })
      // WO-2701: this straight-down descent is a plunge, even when the
      // segment it rejoins cuts at a different feed. Back-along-path leads
      // above/below still use feedOf and retain the original segment's rate.
      const plungeFeed = plungeRate ?? resolveFeedrates(tool, undefined).plungeRate
      out.push({
        type: 'feed', role: 'plunge', x: entry.x, y: entry.y, z: entry.z,
        feed: plungeFeed,
      })
      if (entry !== run.start) emitBackward(entry, run.start, 'lead_in')
    }
    emitForward(run.start, run.end)
    if (!exit) {
      gapStart = positions.length
      break
    }
    // Back out along the path already cut to where the assembly can lift clear.
    if (exit !== run.end) emitBackward(run.end, exit, 'lead_out')
    out.push({ type: 'rapid', role: 'rapid', x: exit.x, y: exit.y, z: linkZ })
    previousExit = exit
    previousEnd = run.end
    gapStart = run.last + 1
  }
  if (gapStart < positions.length) recordGap(positions.length, undefined)

  announceRaises()
  // WO-1597. Say it: a stretch the tool could have cut but could not get back out
  // of. It is part of a stop's uncut length already; this is the reason.
  for (const run of trapped) {
    const blocker = blockerAt(run.end.x, run.end.y, run.end.z, linkZ, false)
    const obstacle = blocker?.obstacle ?? 'workholding'
    const length = Math.max(0, feedAt(run.end) - feedAt(run.start))
    const sentence =
      `${length.toFixed(1)} mm of cutting path from X ${run.start.x.toFixed(2)} Y ${run.start.y.toFixed(2)} ` +
      `was left uncut: the tool could not lift out from anywhere along it without crossing the ${obstacle}`
    warnings.push(`${sentence}.`)
    // eslint-disable-next-line no-console
    console.info(`[workholding-clearance] ${sentence} (allowance ${allowance} mm, WO-1597).`)
  }
  return { moves: out, trimmed: true, stops, raised, ...base }
}
