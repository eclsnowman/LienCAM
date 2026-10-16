import type { Tool, ToolHolder, ToolpathMove } from '../../types'
import { buildToolProfile } from '../tool/toolProfile'
import { createStockState, isStockRegionEmpty, type StockState, type StockStateCutter } from './stockState'
import { effectiveMoveRole, isStockCuttingRole } from './stockCuttingRoles'
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

/** WO-2754: a separate enclosure for clear-space proof, never the sampled reach
 * model. Every triangle whose XY projection touches a cell contributes its
 * FULL Z extent, including vertical faces. A closed solid's occupied vertical
 * interval has boundary triangles at both ends, so joining all such extents
 * encloses its interior too. Through cavities remain empty where no boundary
 * projects; multiple spans/overhang gaps and sloping faces can be over-filled.
 * Exact welded edge closure is required: unreadable/open/nonconforming meshes
 * cannot establish this proof and return null rather than sampled clearance. */
export function buildClearSpaceSolidColumns(
  mesh: ClearanceMesh,
  requestedCellMm: number = DEFAULT_PART_CELL_MM,
  maxColumns: number = MAX_PART_COLUMNS,
): SolidColumns | null {
  const { positions, indices } = mesh
  if (positions.length < 9 || positions.length % 3 !== 0 || indices.length < 3 || indices.length % 3 !== 0 ||
      !Number.isFinite(requestedCellMm) || requestedCellMm <= 0 || !Number.isInteger(maxColumns) || maxColumns <= 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, magnitude = 1
  // STL meshes may repeat the same vertex for each face. Weld exact coordinates
  // only: a near match cannot certify that a missing boundary was closed.
  const vertexIds = new Map<string, number>()
  const welded: number[] = []
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v], y = positions[v + 1], z = positions[v + 2]
    if (![x, y, z].every(Number.isFinite)) return null
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    magnitude = Math.max(magnitude, Math.abs(x), Math.abs(y))
    const key = `${x},${y},${z}`
    if (!vertexIds.has(key)) vertexIds.set(key, vertexIds.size)
    welded.push(vertexIds.get(key)!)
  }
  const edges = new Map<string, number>()
  for (let t = 0; t < indices.length; t += 3) {
    const vertices = [indices[t], indices[t + 1], indices[t + 2]]
    if (vertices.some(v => !Number.isInteger(v) || v < 0 || v >= welded.length)) return null
    const ids = vertices.map(v => welded[v])
    if (new Set(ids).size !== 3) return null
    for (let e = 0; e < 3; e++) {
      const a = ids[e], b = ids[(e + 1) % 3]
      const key = a < b ? `${a},${b}` : `${b},${a}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  if ([...edges.values()].some(count => count !== 2)) return null
  const width = maxX - minX, height = maxY - minY
  if (!Number.isFinite(width * height)) return null
  let cell = Math.max(requestedCellMm, Math.sqrt(width * height / maxColumns), width / maxColumns, height / maxColumns)
  let nx = Math.max(1, Math.ceil(width / cell)), ny = Math.max(1, Math.ceil(height / cell))
  // Ceilings may exceed the requested memory bound even after area scaling.
  while (nx * ny > maxColumns) {
    cell *= 1.01
    nx = Math.max(1, Math.ceil(width / cell)); ny = Math.max(1, Math.ceil(height / cell))
  }
  const columns = nx * ny
  const bottoms = new Float64Array(columns).fill(Infinity)
  const tops = new Float64Array(columns).fill(-Infinity)
  const epsilon = Math.max(1e-9, magnitude * Number.EPSILON * 32)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const xs = [positions[a], positions[b], positions[c]]
    const ys = [positions[a + 1], positions[b + 1], positions[c + 1]]
    const bottom = Math.min(positions[a + 2], positions[b + 2], positions[c + 2])
    const top = Math.max(positions[a + 2], positions[b + 2], positions[c + 2])
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - minX - epsilon) / cell))
    const i1 = Math.min(nx - 1, Math.floor((Math.max(...xs) - minX + epsilon) / cell))
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - minY - epsilon) / cell))
    const j1 = Math.min(ny - 1, Math.floor((Math.max(...ys) - minY + epsilon) / cell))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = minX + (i + 0.5) * cell, y = minY + (j + 0.5) * cell
      const localX = xs.map(v => v - x), localY = ys.map(v => v - y)
      const half = cell / 2 + epsilon
      // Separating axes for a square and a projected triangle. Vertical and
      // collinear projections still contribute; a zero-length edge adds no axis.
      const separated = (ax: number, ay: number) => {
        const extent = half * (Math.abs(ax) + Math.abs(ay))
        const projections = localX.map((v, k) => v * ax + localY[k] * ay)
        return Math.min(...projections) > extent || Math.max(...projections) < -extent
      }
      if (separated(1, 0) || separated(0, 1) || localX.some((_, k) => {
        const next = (k + 1) % 3
        const dx = localX[next] - localX[k], dy = localY[next] - localY[k]
        const length = Math.hypot(dx, dy)
        return length > 0 && separated(-dy / length, dx / length)
      })) continue
      const column = j * nx + i
      bottoms[column] = Math.min(bottoms[column], bottom)
      tops[column] = Math.max(tops[column], top)
    }
  }
  const spanStart = new Uint32Array(columns + 1)
  for (let column = 0; column < columns; column++) {
    spanStart[column + 1] = spanStart[column] + (tops[column] >= bottoms[column] ? 2 : 0)
  }
  const spanZ = new Float64Array(spanStart[columns])
  for (let column = 0; column < columns; column++) {
    if (spanStart[column + 1] === spanStart[column]) continue
    spanZ[spanStart[column]] = bottoms[column]
    spanZ[spanStart[column] + 1] = tops[column]
  }
  return { originX: minX, originY: minY, cell, nx, ny, spanStart, spanZ }
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

/** A candidate is a clearance query, never an own-bore or cutting permission.
 * The caller must supply current obstacles in the candidate's world frame.
 * Cutting engagement needs a separate removal-volume proof before using this
 * query to select a Chamfer lead. Existing reach/trim callers are unchanged. */
/** Plain dispatch provenance. The worker reconstructs removal; sampled replay
 * arrays and caller-supplied evidence labels cannot certify a whole cell. */
export interface ClearSpacePredecessor {
  readonly tool: Tool
  readonly cutter: StockStateCutter
  readonly liftMm: number
  readonly moves: readonly ToolpathMove[]
}

declare const clearSpaceStockBrand: unique symbol
export interface ClearSpaceStockEnvelope {
  readonly [clearSpaceStockBrand]: true
  readonly bounds: StockState['bounds']
  readonly resolutionMm: number
  readonly nx: number
  readonly ny: number
  readonly bottomZ: number
  /** Inspection copy, never the private proof storage. */
  readonly topZ: Float64Array
}
interface PriorCutCylinder {
  readonly a: Readonly<ReachPoint>
  readonly b: Readonly<ReachPoint>
  readonly radius: number
  readonly bottomOffset: number
  readonly topOffset: number
}
type ClearSpaceStockSnapshot = Omit<StockState, 'topZ'> & {
  readonly topZ: Float64Array
  readonly priorCuts: readonly PriorCutCylinder[]
}
const clearSpaceStockSnapshots = new WeakMap<ClearSpaceStockEnvelope, ClearSpaceStockSnapshot>()

// Exact predicates on the supplied finite IEEE values. A shared closed cutting
// boundary cannot be proved by adding a tolerance to a cutter radius. Rational
// clipping and squared distances retain that boundary without rounding slack.
type StockQ = { n: bigint; d: bigint }
type StockQPoint = { x: StockQ; y: StockQ }
type StockDistanceConstants = { a: StockQPoint; b: StockQPoint; edge: StockQPoint; length2: StockQ; radius2: StockQ }
type PriorContactReuse = {
  scalars: Map<number, StockQ>
  cylinders: Map<PriorCutCylinder, { bottom: StockQ; top: StockQ; distance?: StockDistanceConstants }>
  geometry?: { origin: StockQPoint; lead: StockQPoint; valid: boolean }
}
class StockExactBound extends Error {}
function stockQ(n: bigint, d = 1n): StockQ {
  // A fixed budget, not recursive refinement. Every returned operand has at
  // most8192 bits; one following product/sum has at most16385 before this
  // check. Excessive exact work retains the original collision decision.
  if (d === 0n || n.toString(2).length > 8192 || d.toString(2).length > 8192) throw new StockExactBound()
  if (d < 0n) { n = -n; d = -d }
  let a = n < 0n ? -n : n, b = d
  while (b) { const remainder = a % b; a = b; b = remainder }
  return { n: n / a, d: d / a }
}
function stockQOf(value: number): StockQ {
  if (!Number.isFinite(value)) throw new StockExactBound()
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n)
  let significand = bits & ((1n << 52n) - 1n)
  if (exponent) significand += 1n << 52n
  if (bits >> 63n) significand = -significand
  const power = exponent ? exponent - 1075 : -1074
  return power >= 0 ? stockQ(significand << BigInt(power)) : stockQ(significand, 1n << BigInt(-power))
}
const stockQAdd = (a: StockQ, b: StockQ) => stockQ(a.n * b.d + b.n * a.d, a.d * b.d)
const stockQSub = (a: StockQ, b: StockQ) => stockQ(a.n * b.d - b.n * a.d, a.d * b.d)
const stockQMul = (a: StockQ, b: StockQ) => stockQ(a.n * b.n, a.d * b.d)
const stockQDiv = (a: StockQ, b: StockQ) => stockQ(a.n * b.d, a.d * b.n)
const stockQCmp = (a: StockQ, b: StockQ) => a.n * b.d - b.n * a.d
const stockQPoint = (p: { x: number; y: number }): StockQPoint => ({ x: stockQOf(p.x), y: stockQOf(p.y) })
const stockQDelta = (a: StockQPoint, b: StockQPoint): StockQPoint => ({ x: stockQSub(a.x, b.x), y: stockQSub(a.y, b.y) })
const stockQDot = (a: StockQPoint, b: StockQPoint) => stockQAdd(stockQMul(a.x, b.x), stockQMul(a.y, b.y))
function stockQDistanceWithin(p: StockQPoint, a: StockQPoint, b: StockQPoint, radius: StockQ,
  prepared?: StockDistanceConstants): boolean {
  const edge = prepared?.edge ?? stockQDelta(b, a), offset = stockQDelta(p, a)
  const length2 = prepared?.length2 ?? stockQDot(edge, edge), along = stockQDot(offset, edge)
  const radius2 = prepared?.radius2 ?? stockQMul(radius, radius)
  if (length2.n === 0n || along.n <= 0n) return stockQCmp(stockQDot(offset, offset), radius2) <= 0n
  if (stockQCmp(along, length2) >= 0n) {
    const endOffset = stockQDelta(p, b)
    return stockQCmp(stockQDot(endOffset, endOffset), radius2) <= 0n
  }
  const cross = stockQSub(stockQMul(offset.x, edge.y), stockQMul(offset.y, edge.x))
  return stockQCmp(stockQMul(cross, cross), stockQMul(radius2, length2)) <= 0n
}

/** The backward half-plane is inside the authored sweep because its nearest
 * lead point is the actual cut anchor. One validated prior finite cylinder
 * must cover the ENTIRE remaining convex polygon and the whole query Z band.
 * This is a union proof for stock/cutter contact only, not a stock-top edit. */
function priorCutCoversForwardCell(
  priorCuts: readonly PriorCutCylinder[], x: number, y: number, pitch: number,
  anchor: ReachPoint, free: ReachPoint, path: readonly { x: number; y: number }[],
  low: number, high: number, actualSegments?: ChamferCutSweep['actualSegments'],
  reuse?: PriorContactReuse,
): boolean {
  try { return priorCutCoversForwardCellExact(priorCuts, x, y, pitch, anchor, free, path, low, high, actualSegments, reuse) }
  catch (error) {
    if (error instanceof StockExactBound) return false
    throw error
  }
}
function priorCutCoversForwardCellExact(
  priorCuts: readonly PriorCutCylinder[], x: number, y: number, pitch: number,
  anchor: ReachPoint, free: ReachPoint, path: readonly { x: number; y: number }[],
  low: number, high: number, actualSegments?: ChamferCutSweep['actualSegments'],
  reuse?: PriorContactReuse,
): boolean {
  if (!Number.isFinite(low) || !Number.isFinite(high) || priorCuts.length === 0) return false
  // Only successful conversions are retained, privately for this synchronous
  // query. Failed/never-visited arithmetic is neither swallowed nor made eager.
  const of = (value: number) => {
    const saved = reuse?.scalars.get(value)
    if (saved) return saved
    const result = stockQOf(value)
    reuse?.scalars.set(value, result)
    return result
  }
  const point = (p: { x: number; y: number }): StockQPoint => ({ x: of(p.x), y: of(p.y) })
  let geometry = reuse?.geometry
  if (!geometry) {
    const origin = point(anchor), end = point(free), lead = stockQDelta(end, origin)
    const valid = !(stockQDot(lead, lead).n === 0n || !path.some((a, i) =>
      stockQDistanceWithin(origin, point(a), point(path[(i + 1) % path.length]), stockQ(0n))) &&
        !actualSegments?.some(segment => stockQDistanceWithin(origin, point(segment.from), point(segment.to), stockQ(0n))))
    geometry = { origin, lead, valid }
    if (reuse) reuse.geometry = geometry
  }
  if (!geometry.valid) return false
  const { origin, lead } = geometry
  const margin = of(CONTACT_BIAS_MM), width = stockQOf(pitch)
  // Region coordinates vary; do not retain a grid/leaf-sized scalar cache.
  const left = stockQSub(stockQOf(x), margin), bottom = stockQSub(stockQOf(y), margin)
  const right = stockQAdd(stockQAdd(stockQOf(x), width), margin)
  const top = stockQAdd(stockQAdd(stockQOf(y), width), margin)
  const rectangle = [{ x: left, y: bottom }, { x: right, y: bottom }, { x: right, y: top }, { x: left, y: top }]
  const forward = (p: StockQPoint) => stockQDot(stockQDelta(p, origin), lead)
  const polygon: StockQPoint[] = []
  for (let i = 0; i < rectangle.length; i++) {
    const a = rectangle[i], b = rectangle[(i + 1) % rectangle.length], da = forward(a), db = forward(b)
    if (da.n >= 0n) polygon.push(a)
    if ((da.n >= 0n) !== (db.n >= 0n)) {
      const t = stockQDiv(da, stockQSub(da, db)), edge = stockQDelta(b, a)
      polygon.push({ x: stockQAdd(a.x, stockQMul(t, edge.x)), y: stockQAdd(a.y, stockQMul(t, edge.y)) })
    }
  }
  if (polygon.length === 0) return true
  const lowQ = of(low), highQ = of(high)
  return priorCuts.some(prior => {
    // Exact sums avoid promoting rounded finite flute/floor boundaries.
    let saved = reuse?.cylinders.get(prior)
    if (!saved) {
      saved = { bottom: stockQAdd(of(Math.min(prior.a.z, prior.b.z)), of(prior.bottomOffset)),
        top: stockQAdd(of(Math.max(prior.a.z, prior.b.z)), of(prior.topOffset)) }
      reuse?.cylinders.set(prior, saved)
    }
    const cylinder = saved
    if (stockQCmp(lowQ, cylinder.bottom) < 0n || stockQCmp(highQ, cylinder.top) > 0n) return false
    const a = cylinder.distance?.a ?? point(prior.a), b = cylinder.distance?.b ?? point(prior.b), radius = of(prior.radius)
    // A finite capsule is convex, so closed-set membership of all polygon
    // vertices proves membership of every point, not just sampled contacts.
    return polygon.every(p => {
      // Prepare only when this same certificate/vertex would be visited by the
      // original ordered predicate; never precompute an unvisited later cut.
      if (reuse && !cylinder.distance) {
        const edge = stockQDelta(b, a)
        cylinder.distance = { a, b, edge, length2: stockQDot(edge, edge), radius2: stockQMul(radius, radius) }
      }
      return stockQDistanceWithin(p, a, b, radius, cylinder.distance)
    })
  })
}

/** Round toward retained material, including negative values and signed zero. */
function retainedFloat32Ceil(value: number): number {
  const rounded = Math.fround(value)
  if (rounded >= value) return rounded
  const bytes = new ArrayBuffer(4), view = new DataView(bytes)
  view.setFloat32(0, rounded)
  const bits = view.getUint32(0)
  view.setUint32(0, rounded >= 0 ? bits + 1 : bits - 1)
  return view.getFloat32(0)
}

/** Constructs the only stock accepted by the two new queries. Each lowered
 * column is wholly inside actual finite cutting volume. Unproved volume stays
 * at the loaded top. Existing center-sampled replay is deliberately untouched.
 * No certificate can be serialized, spread-cloned, or forged from a top array. */
export function createClearSpaceStockEnvelope(
  bounds: StockState['bounds'], resolutionMm: number, maxColumns: number,
  predecessors: readonly ClearSpacePredecessor[] = [],
): ClearSpaceStockEnvelope {
  if (!Object.values(bounds).every(Number.isFinite) || !(bounds.maxX > bounds.minX) ||
      !(bounds.maxY > bounds.minY) || !(bounds.maxZ > bounds.minZ) ||
      !(resolutionMm > 0) || !Number.isFinite(resolutionMm) ||
      !Number.isInteger(maxColumns) || maxColumns <= 0) throw new Error('Invalid whole-cell stock bounds or grid.')
  const grid = createStockState(bounds, resolutionMm, maxColumns)
  const top = retainedFloat32Ceil(bounds.maxZ)
  if (!Number.isFinite(top)) throw new Error('Stock top cannot be conservatively represented.')
  const topZ = new Float64Array(grid.nx * grid.ny).fill(top)
  const priorCuts: PriorCutCylinder[] = []
  const cell = grid.resolutionMm
  const scale = Math.max(1, ...Object.values(bounds).map(Math.abs))
  const pad = CONTACT_BIAS_MM + 64 * Number.EPSILON * scale
  for (const predecessor of predecessors) {
    const { tool, cutter, liftMm, moves } = predecessor
    if (!['flat_end_mill', 'face_mill', 'ball_end_mill', 'bull_nose', 'drill', 'spot_drill', 'center_drill'].includes(tool.type) ||
        !Number.isFinite(tool.diameter) || !(tool.diameter > 0) || cutter.diameter !== tool.diameter ||
        !['flat', 'ball'].includes(cutter.kind) || !Number.isFinite(liftMm) || liftMm < 0) continue
    let profile: ReturnType<typeof buildToolProfile>
    try { profile = buildToolProfile(tool) } catch { continue }
    const height = profile.cuttingMaxZ
    // Below this bound the fixed inward/outward padding dominates arithmetic
    // uncertainty. Unreadable/extreme provenance cannot remove loaded material.
    let calculationScale = Math.max(scale, Math.abs(height), Math.abs(tool.diameter))
    for (const move of moves) calculationScale = Math.max(calculationScale, Math.abs(move.x), Math.abs(move.y), Math.abs(move.z))
    if (!Number.isFinite(calculationScale) || 64 * Number.EPSILON * calculationScale > CONTACT_BIAS_MM) continue
    if (!(height > 0) || !Number.isFinite(height) || profile.vertices.length < 2 ||
        profile.vertices.some((v, i) => !Number.isFinite(v.z) || !Number.isFinite(v.r) || v.r < 0 ||
          v.z < 0 || (i > 0 && v.z < profile.vertices[i - 1].z))) continue
    // Retain only a proven full-radius cylindrical tail of the cutting profile.
    // Its top must be an actual profile vertex; no interpolated/neck extension.
    const radius = tool.diameter / 2
    let tailIndex = profile.vertices.findIndex(v => v.z === height && v.r >= radius)
    let tailBottom: number | undefined
    if (tailIndex >= 0) {
      while (tailIndex > 0 && profile.vertices[tailIndex - 1].r >= radius) tailIndex--
      const lower = Math.max(liftMm, profile.vertices[tailIndex].z)
      if (lower < height) tailBottom = lower
    }
    // The contiguous tail of the actual cutting profile supports this entire
    // radius. Neck/shank above cuttingMaxZ is never counted as removed stock.
    const floorOffset = (radius: number): number | undefined => {
      const required = radius + pad
      let lower = height
      for (let k = profile.vertices.length - 2; k >= 0; k--) {
        const a = profile.vertices[k], b = profile.vertices[k + 1]
        const hi = Math.min(height, b.z)
        if (!(hi > a.z) || a.z >= height) continue
        const rhi = a.r + (b.r - a.r) * (hi - a.z) / (b.z - a.z)
        if (hi < lower || !(rhi > required)) break
        if (a.r > required) lower = a.z
        else if (rhi > a.r) { lower = a.z + (required - a.r) * (b.z - a.z) / (b.r - a.r); break }
        else break
      }
      return lower < height ? Math.max(liftMm, lower) : undefined
    }
    const stamp = (a: ReachPoint, b: ReachPoint) => {
      // Constant-Z finite segments, or a vertical finite plunge. Ramps are
      // represented below by actual cutter poses, never by their lowest disc.
      const radius = tool.diameter / 2
      const minI = Math.max(0, Math.floor((Math.min(a.x, b.x) - radius - bounds.minX) / cell))
      const maxI = Math.min(grid.nx - 1, Math.floor((Math.max(a.x, b.x) + radius - bounds.minX) / cell))
      const minJ = Math.max(0, Math.floor((Math.min(a.y, b.y) - radius - bounds.minY) / cell))
      const maxJ = Math.min(grid.ny - 1, Math.floor((Math.max(a.y, b.y) + radius - bounds.minY) / cell))
      const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy
      for (let j = minJ; j <= maxJ; j++) for (let i = minI; i <= maxI; i++) {
        const index = j * grid.nx + i, currentTop = topZ[index]
        if (currentTop <= bounds.minZ) continue
        let farthest = 0
        for (const x of [bounds.minX + i * cell - pad, Math.min(bounds.maxX, bounds.minX + (i + 1) * cell) + pad]) {
          for (const y of [bounds.minY + j * cell - pad, Math.min(bounds.maxY, bounds.minY + (j + 1) * cell) + pad]) {
            const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0
            farthest = Math.max(farthest, Math.hypot(x - a.x - t * dx, y - a.y - t * dy))
          }
        }
        const offset = floorOffset(farthest)
        if (offset === undefined || !(Math.max(a.z, b.z) + height - pad >= currentTop)) continue
        const floor = Math.min(a.z, b.z) + offset + pad
        if (!Number.isFinite(floor)) continue
        // Exact double bottom marks emptiness only after a proved through cut.
        const retained = floor <= bounds.minZ ? bounds.minZ : retainedFloat32Ceil(floor)
        if (retained < currentTop) topZ[index] = retained
      }
    }
    let previous: ReachPoint | undefined
    for (const move of moves) {
      const next = { x: move.x, y: move.y, z: move.z }
      if (![next.x, next.y, next.z].every(Number.isFinite)) { previous = undefined; continue }
      const from = previous
      previous = next
      // Explicit cut on a rapid is not proof. Arc chords are not physical arcs:
      // retain their removal entirely until an analytic arc certificate exists.
      if (!from || move.type !== 'feed') continue
      let cutting = false
      try { cutting = isStockCuttingRole(effectiveMoveRole(move)) } catch { continue }
      if (!cutting) continue
      if (from.z === next.z || (from.x === next.x && from.y === next.y)) {
        if (tailBottom !== undefined) priorCuts.push(Object.freeze({
          a: Object.freeze({ ...from }), b: Object.freeze({ ...next }), radius,
          bottomOffset: tailBottom, topOffset: height,
        }))
        stamp(from, next)
      }
      else {
        const steps = Math.ceil(Math.hypot(next.x - from.x, next.y - from.y, next.z - from.z) / (cell / 2))
        // Bounded work; omitted poses retain material rather than bridging gaps.
        if (!Number.isSafeInteger(steps) || steps > 100000) continue
        for (let k = 0; k <= steps; k++) {
          const t = k / Math.max(1, steps)
          const p = { x: from.x + t * (next.x - from.x), y: from.y + t * (next.y - from.y), z: from.z + t * (next.z - from.z) }
          stamp(p, p)
        }
      }
    }
  }
  const snapshot: ClearSpaceStockSnapshot = { ...grid, bounds: Object.freeze({ ...bounds }), bottomZ: bounds.minZ, topZ,
    priorCuts: Object.freeze(priorCuts) }
  const envelope = Object.freeze({ bounds: snapshot.bounds, resolutionMm: cell, nx: grid.nx, ny: grid.ny,
    bottomZ: bounds.minZ, get topZ() { return topZ.slice() } }) as ClearSpaceStockEnvelope
  clearSpaceStockSnapshots.set(envelope, snapshot)
  return envelope
}

export interface ClearSpaceCandidateSweep {
  /** Diagnostic only; normal production callers leave this absent. */
  readonly includeFirstStockRejection?: boolean
  readonly from: ReachPoint
  readonly to: ReachPoint
  readonly tool: Tool
  readonly holder?: ToolHolder
  readonly stock?: ClearSpaceStockEnvelope
  readonly part?: SolidColumns
  readonly workholding?: readonly SolidColumns[]
  /** Availability must come from the dispatch authority, not be inferred from
   * an empty mesh list or a same-sized grid. This query cannot authenticate it. */
  readonly evidence: {
    /** current is a caller-owned current envelope, not a physical-stock certificate. */
    readonly stock: 'current' | 'retained-envelope' | 'missing' | 'stale'
    readonly frame: 'world' | 'mismatched' | 'unknown'
    readonly workholding: 'complete' | 'unreadable' | 'unknown'
  }
}

/** First broad-phase stock rejection, not an exact cutter/contact intersection.
 * Permission facts below describe the existing short-circuit path; null means
 * that permission branch was not evaluated. No extra geometry query is run. */
export interface ClearSpaceStockRejection {
  readonly column: number
  readonly cell: { ix: number; iy: number; minX: number; minY: number; maxX: number; maxY: number; pitch: number; topZ: number; bottomZ: number }
  readonly band: { component: ReachComponent; bottomOffsetMm: number; topOffsetMm: number | null;
    sweepRadiusMm: number; expandedRadiusMm: number; intendedRadiusMm: number;
    lowZ: number; highZ: number | null; highUnbounded: boolean }
  readonly permission: { cutterEligible: boolean; cutAvailable: boolean; onCutSegment: boolean | null;
    anchor: ReachPoint | null; free: ReachPoint | null; anchorHalfPlane: false | null; wholeCellContainment: false | null; forwardSubsetDomination: false | null }
  readonly exactContactSubset: 'not-computed'
}

export interface ClearSpaceCandidateReport {
  readonly firstStockRejection?: ClearSpaceStockRejection
  readonly status: 'clear' | 'collision' | 'not-checked'
  readonly blocker?: ReachBlocker
  readonly reason?: string
  readonly shankStatus: HolderClearanceReport['shankStatus']
  readonly holderStatus: HolderClearanceReport['holderStatus']
  readonly scope: 'tool-and-shank' | 'tool-shank-and-holder'
  readonly warnings: readonly string[]
}

/** A false result is a separating-axis certificate, never a cutting permission.
 * Direction construction need not be exact: separation along ANY finite axis
 * proves disjointness. Support intervals include both finite segment endpoints
 * and all square corners; radius and numerical padding enlarge possible contact.
 * The axes cover edge, endpoint and corner nearest-feature pairs, including a
 * stationary segment. Uncertain arithmetic deliberately retains possible contact. */
export function capsuleMayContactCell(
  from: { x: number; y: number }, to: { x: number; y: number }, radius: number,
  minX: number, minY: number, cell: number,
): boolean {
  const maxX = minX + cell, maxY = minY + cell
  const values = [from.x, from.y, to.x, to.y, radius, minX, minY, maxX, maxY, cell]
  if (!values.every(Number.isFinite) || radius < 0 || !(cell > 0)) return true
  const scale = values.reduce((s, value) => Math.max(s, Math.abs(value)), 1)
  const roundoff = 128 * Number.EPSILON * scale
  if (roundoff > CONTACT_BIAS_MM / 64) return true
  const dx = to.x - from.x, dy = to.y - from.y
  const padding = radius + CONTACT_BIAS_MM + roundoff
  // These are the exact first two support axes of the former eager list.
  // Evaluate them before allocating corners or constructing later directions.
  const minRelativeX = minX - from.x, maxRelativeX = maxX - from.x
  const minRelativeY = minY - from.y, maxRelativeY = maxY - from.y
  if (minRelativeX - Math.max(0, dx) > padding || Math.min(0, dx) - maxRelativeX > padding ||
      minRelativeY - Math.max(0, dy) > padding || Math.min(0, dy) - maxRelativeY > padding) return false
  const corners = [
    { x: minX - from.x, y: minY - from.y }, { x: maxX - from.x, y: minY - from.y },
    { x: maxX - from.x, y: maxY - from.y }, { x: minX - from.x, y: maxY - from.y },
  ]
  const axes = [{ x: -dy, y: dx }]
  for (const end of [from, to]) {
    axes.push({ x: end.x - Math.max(minX, Math.min(maxX, end.x)),
      y: end.y - Math.max(minY, Math.min(maxY, end.y)) })
  }
  const length2 = dx * dx + dy * dy
  for (const corner of corners) {
    const t = length2 > 0 ? Math.max(0, Math.min(1, (corner.x * dx + corner.y * dy) / length2)) : 0
    axes.push({ x: corner.x - t * dx, y: corner.y - t * dy })
  }
  for (const axis of axes) {
    const norm = Math.hypot(axis.x, axis.y)
    if (!Number.isFinite(norm) || norm <= roundoff) continue
    // Normalization keeps support arithmetic bounded; its roundoff is included
    // in the conservative padding above, never subtracted from tool radius.
    const ux = axis.x / norm, uy = axis.y / norm
    const end = dx * ux + dy * uy
    const projected = corners.map(p => p.x * ux + p.y * uy)
    if (![end, ...projected].every(Number.isFinite)) continue
    if (Math.min(...projected) - Math.max(0, end) > padding ||
        Math.min(0, end) - Math.max(...projected) > padding) return false
  }
  return true
}

/** Every column square touched by a continuous XY capsule is considered. The
 * half-diagonal inflation selects candidates; only a conservative square/capsule
 * separation certificate can discard one before its material is queried. */
function sweepColumns(
  originX: number, originY: number, cell: number, nx: number, ny: number,
  from: ReachPoint, to: ReachPoint, radius: number,
  hits: (column: number) => boolean,
  materialCanOverlap: (column: number) => boolean,
): boolean {
  const expanded = radius + cell * Math.SQRT1_2 + CONTACT_BIAS_MM
  const i0 = Math.max(0, Math.ceil((Math.min(from.x, to.x) - expanded - originX) / cell - 0.5))
  const i1 = Math.min(nx - 1, Math.floor((Math.max(from.x, to.x) + expanded - originX) / cell - 0.5))
  const j0 = Math.max(0, Math.ceil((Math.min(from.y, to.y) - expanded - originY) / cell - 0.5))
  const j1 = Math.min(ny - 1, Math.floor((Math.max(from.y, to.y) + expanded - originY) / cell - 0.5))
  const dx = to.x - from.x, dy = to.y - from.y
  const length2 = dx * dx + dy * dy
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = originX + (i + 0.5) * cell - from.x
      const y = originY + (j + 0.5) * cell - from.y
      const t = length2 > 0 ? Math.max(0, Math.min(1, (x * dx + y * dy) / length2)) : 0
      if ((x - t * dx) ** 2 + (y - t * dy) ** 2 <= expanded ** 2 &&
          materialCanOverlap(j * nx + i) &&
          capsuleMayContactCell(from, to, radius, originX + i * cell, originY + j * cell, cell) &&
          hits(j * nx + i)) return true
    }
  }
  return false
}

function usableSweepColumns(columns: SolidColumns): boolean {
  const { cell, nx, ny, originX, originY, spanStart, spanZ } = columns
  if (![cell, originX, originY].every(Number.isFinite) || !(cell > 0) ||
      !Number.isInteger(nx) || !Number.isInteger(ny) || nx <= 0 || ny <= 0 ||
      spanStart.length !== nx * ny + 1 || spanStart[0] !== 0 || spanStart[nx * ny] !== spanZ.length) return false
  for (let c = 0; c < nx * ny; c++) {
    const start = spanStart[c], end = spanStart[c + 1]
    if (end < start || (end - start) % 2 !== 0) return false
    for (let k = start; k < end; k += 2) {
      if (!Number.isFinite(spanZ[k]) || !Number.isFinite(spanZ[k + 1]) || spanZ[k + 1] < spanZ[k]) return false
    }
  }
  return true
}

/** Pure full-profile proof for one LINEAR segment. Each actual profile slope
 * is enclosed by <= 0.05 mm axial bands (the existing gouge tolerance). There
 * is no radius reduction, gouge allowance or engagement exception here. Z is
 * enclosed over the entire segment, so diagonal travel can over-report, never
 * miss a crossing. Empty columns at stock bottom mean through-clear stock;
 * motion past the validated grid is outside declared stock, not proof about
 * unknown fixtures. No stock is modified or replayed. */
export function checkClearSpaceCandidateSweep(input: ClearSpaceCandidateSweep): ClearSpaceCandidateReport {
  return checkCandidateSweep(input)
}

export interface ChamferCutSweep {
  readonly path: readonly { x: number; y: number }[]
  readonly z: number
  /** Ordered OPEN actual cutting segments, supplied only after all original
   * cutting checks pass. Never the candidate lead or an implied closure. */
  readonly actualSegments?: readonly { readonly from: Readonly<ReachPoint>; readonly to: Readonly<ReachPoint> }[]
}

function exactActualCutAnchor(point: ReachPoint, segments: NonNullable<ChamferCutSweep['actualSegments']>): boolean {
  try {
    return segments.some(segment => stockQDistanceWithin(stockQPoint(point),
      stockQPoint(segment.from), stockQPoint(segment.to), stockQ(0n)))
  } catch (error) {
    if (error instanceof StockExactBound) return false
    throw error
  }
}

/** Cover a closed region, never sample it. Shared child endpoints partition the
 * parent exactly even when the chosen midpoint rounded. Each certificate sees
 * an outward enclosing square; no rounded half-width can leave an inward gap.
 * The fixed budget limits total leaf/certificate work. Exhaustion is UNKNOWN,
 * represented by false, and therefore retains the original stock collision. */
function coveredContactRegion(
  x: number, y: number, pitch: number,
  covered: (x: number, y: number, pitch: number) => boolean,
): boolean {
  type Region = { minX: number; minY: number; maxX: number; maxY: number; depth: number }
  const stack: Region[] = [{ minX: x, minY: y, maxX: x + pitch, maxY: y + pitch, depth: 0 }]
  let visited = 0
  while (stack.length > 0) {
    if (++visited > 256) return false
    const r = stack.pop()!
    if (![r.minX, r.minY, r.maxX, r.maxY].every(Number.isFinite) ||
        !(r.maxX > r.minX) || !(r.maxY > r.minY)) return false
    let width = Math.max(r.maxX - r.minX, r.maxY - r.minY)
    if (!Number.isFinite(width) || !(width > 0)) return false
    // Advance one representable positive double. The following endpoint tests
    // establish enclosure directly; if one ULP did not suffice, do not certify.
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, width)
    view.setBigUint64(0, view.getBigUint64(0) + 1n)
    width = view.getFloat64(0)
    if (!Number.isFinite(width) || !Number.isFinite(r.minX + width) || !Number.isFinite(r.minY + width) ||
        r.minX + width < r.maxX || r.minY + width < r.maxY) return false
    if (covered(r.minX, r.minY, width)) continue
    if (r.depth >= 6) return false
    const midX = r.minX + (r.maxX - r.minX) / 2, midY = r.minY + (r.maxY - r.minY) / 2
    if (!(midX > r.minX && midX < r.maxX && midY > r.minY && midY < r.maxY)) return false
    const depth = r.depth + 1
    stack.push(
      { minX: r.minX, minY: r.minY, maxX: midX, maxY: midY, depth },
      { minX: midX, minY: r.minY, maxX: r.maxX, maxY: midY, depth },
      { minX: r.minX, minY: midY, maxX: midX, maxY: r.maxY, depth },
      { minX: midX, minY: midY, maxX: r.maxX, maxY: r.maxY, depth },
    )
  }
  return true
}

/** Only cutter engagement in the SAME programmed contour sweep is intentional.
 * This never exempts fixtures, shank or holder, and never applies on descent.
 * The occupied cell must either be entirely inside the minimum actual band
 * radius of a contour segment, or be on the anchor side where its distance to
 * that contour is <= its distance to the proposed lead. Ambiguous cells stay
 * blocked. No cell slack or gouge tolerance expands the removal permission. */
export function checkChamferEngagementSweep(
  input: ClearSpaceCandidateSweep,
  cut: ChamferCutSweep,
): ClearSpaceCandidateReport {
  return checkCandidateSweep(input, cut)
}

/** A finite revolved profile, ordered tip upward, with a positive cutting height. */
function usableToolProfile(profile: ReturnType<typeof buildToolProfile>): boolean {
  return profile.cuttingMaxZ > 0 && Number.isFinite(profile.cuttingMaxZ) &&
    profile.vertices.length >= 2 &&
    !profile.vertices.some((v, i) => i > 0 && v.z < profile.vertices[i - 1].z) &&
    !profile.vertices.some(v => !Number.isFinite(v.r) || !Number.isFinite(v.z) || v.r < 0 || v.z < 0)
}

/** The whole assembly as swept radial bands, tip upward: the cutting head in
 * <= 0.05 mm bands (the existing gouge tolerance), then the actual non-cutting
 * silhouette, then the supplied shank/holder components. The existing shank
 * bands supply their conservative upper extent, but a shoulder/taper above
 * cuttingMaxZ can be wider than the nominal shank, so the actual silhouette is
 * kept too rather than inferred from fluteLength. Silhouette bands are labelled
 * 'shank' unless `neck` is given and contains them (WO-2786 reports the neck by
 * name; the clear-space candidate keeps its original labels). */
function assemblySweepBands(
  tool: Tool,
  profile: ReturnType<typeof buildToolProfile>,
  upper: readonly RadialComponent[],
  neck?: { bottomMm: number; topMm: number },
): (RadialComponent | { kind: 'cutter'; bottomOffsetMm: number; topOffsetMm: number; diameterMm: number })[] {
  const noncuttingProfile: RadialComponent[] = []
  for (let i = 0; i < profile.vertices.length - 1; i++) {
    const a = profile.vertices[i], b = profile.vertices[i + 1]
    const bottom = Math.max(a.z, profile.cuttingMaxZ)
    if (!(b.z > bottom)) continue
    const pieces = a.r === b.r ? 1 : Math.ceil((b.z - bottom) / GOUGE_TOLERANCE_MM)
    const radiusAt = (z: number) => a.r + (b.r - a.r) * (z - a.z) / (b.z - a.z)
    for (let p = 0; p < pieces; p++) {
      const z0 = bottom + (b.z - bottom) * p / pieces
      const z1 = bottom + (b.z - bottom) * (p + 1) / pieces
      const kind = neck && z0 >= neck.bottomMm - 1e-9 && z1 <= neck.topMm + 1e-9 ? 'neck' : 'shank'
      noncuttingProfile.push({ kind, bottomOffsetMm: z0, topOffsetMm: z1,
        diameterMm: 2 * Math.max(radiusAt(z0), radiusAt(z1)) })
    }
  }
  return [
    ...headBandsFor(tool, 0, 0, GOUGE_TOLERANCE_MM).map(band => ({
      kind: 'cutter' as const, bottomOffsetMm: band.bottom,
      topOffsetMm: band.top, diameterMm: 2 * band.radius,
    })),
    ...noncuttingProfile, ...upper,
  ]
}

function checkCandidateSweep(
  input: ClearSpaceCandidateSweep,
  cut?: ChamferCutSweep,
): ClearSpaceCandidateReport {
  const { from, to, tool, holder, part, workholding = [] } = input
  const stock = input.stock && clearSpaceStockSnapshots.get(input.stock)
  const warnings: string[] = []
  const shank = shankComponents(tool, warnings)
  const holderResult = holderComponents(tool, holder, warnings)
  const base = {
    shankStatus: shank.status, holderStatus: holderResult.status, warnings,
    scope: holderResult.status === 'checked' ? 'tool-shank-and-holder' as const : 'tool-and-shank' as const,
  }
  const unchecked = (reason: string): ClearSpaceCandidateReport => ({ status: 'not-checked', reason, ...base })
  if (!['current', 'retained-envelope'].includes(input.evidence.stock) || !stock) return unchecked('Worker-constructed whole-cell stock evidence is unavailable.')
  if (input.evidence.frame !== 'world') return unchecked('Candidate and obstacles are not proved in the same world frame.')
  if (input.evidence.workholding !== 'complete') return unchecked('Workholding evidence is incomplete.')
  if (![from.x, from.y, from.z, to.x, to.y, to.z].every(Number.isFinite)) return unchecked('Candidate coordinates are invalid.')
  const { bounds, nx, ny, resolutionMm: cell, bottomZ, topZ } = stock
  if (stock.schemaVersion !== 1 || stock.representation !== 'z-dexel' || !bounds ||
      ![cell, bottomZ, bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ].every(Number.isFinite) ||
      !(cell > 0) || !Number.isInteger(nx) || !Number.isInteger(ny) || nx <= 0 || ny <= 0 || topZ.length !== nx * ny ||
      !(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY) || !(bounds.maxZ > bounds.minZ) || bottomZ !== bounds.minZ ||
      nx * cell < bounds.maxX - bounds.minX - CONTACT_BIAS_MM || ny * cell < bounds.maxY - bounds.minY - CONTACT_BIAS_MM) {
    return unchecked('Prior-stock grid does not cover its declared bounds.')
  }
  let maxTop = -Infinity
  for (const top of topZ) {
    if (!Number.isFinite(top) || top < bottomZ - CONTACT_BIAS_MM || top > retainedFloat32Ceil(bounds.maxZ)) {
      return unchecked('Prior-stock column is invalid.')
    }
    // Complete validation is retained even when an earlier column would prove
    // a band disjoint. This bound belongs only to this call's stock snapshot.
    maxTop = Math.max(maxTop, top)
  }
  if ((part && !usableSweepColumns(part)) || workholding.some(columns => !usableSweepColumns(columns))) {
    return unchecked('Obstacle columns are invalid.')
  }
  const profile = buildToolProfile(tool)
  if (cut && (cut.path.length < 3 || cut.path.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)) ||
      from.z !== cut.z || to.z !== cut.z)) return unchecked('Intended engagement must be at the programmed contour depth.')
  if (cut?.actualSegments) {
    const segments = cut.actualSegments
    if (segments.length === 0 || !cut.path.some(p => p.x === segments[0].from.x && p.y === segments[0].from.y) ||
        segments.some((segment, i) => [segment.from, segment.to].some(p =>
          ![p.x, p.y, p.z].every(Number.isFinite) || p.z !== cut.z) ||
          (i > 0 && (segment.from.x !== segments[i - 1].to.x || segment.from.y !== segments[i - 1].to.y ||
            segment.from.z !== segments[i - 1].to.z)))) return unchecked('Actual cutting contact provenance is invalid.')
  }
  if (shank.status !== 'checked' || warnings.length > 0 || !usableToolProfile(profile)) {
    return unchecked('Tool or assigned holder profile is invalid.')
  }
  const components = assemblySweepBands(tool, profile, [...shank.components, ...holderResult.components])
  if (components.length === 0) return unchecked('Tool profile has no usable sweep bands.')
  const distance2 = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0
    return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2
  }
  const onCutSegment = cut?.path.some((a, i) => {
    const b = cut.path[(i + 1) % cut.path.length]
    return distance2(from, a, b) <= 1e-20 && distance2(to, a, b) <= 1e-20
  }) ?? false
  const anchor = cut && [from, to].find(p => cut.path.some((a, i) =>
    distance2(p, a, cut.path[(i + 1) % cut.path.length]) <= 1e-20))
  const free = anchor === from ? to : from
  // Keep actual-cut authority confined to the new stock/cutter union proof.
  const unionAnchor = cut?.actualSegments
    ? [from, to].find(p => exactActualCutAnchor(p, cut.actualSegments!)) ?? anchor : anchor
  const unionFree = unionAnchor === from ? to : from
  const hasExactUnionAnchor = () => cut && unionAnchor && exactActualCutAnchor(unionAnchor,
    cut.actualSegments ?? cut.path.map((p, i) => ({ from: { ...p, z: cut.z },
      to: { ...cut.path[(i + 1) % cut.path.length], z: cut.z } })))
  // One synchronous query owns these immutable exact constants. No stock,
  // tool, result or certificate is shared/cached across queries or mutations.
  const usePriorContactReuse = true
  let priorContactReuse: PriorContactReuse | undefined
  const contactConstants = (): PriorContactReuse | undefined => usePriorContactReuse
    ? priorContactReuse ??= { scalars: new Map(), cylinders: new Map() } : undefined
  const radiusAt = (z: number) => {
    for (let i = 0; i + 1 < profile.vertices.length; i++) {
      const a = profile.vertices[i], b = profile.vertices[i + 1]
      if (z >= a.z && z <= b.z && b.z > a.z) return a.r + (b.r - a.r) * (z - a.z) / (b.z - a.z)
    }
    return 0
  }
  // Radius-independent sufficient proof for the forward part of one cell.
  // If distance(p, finite cut edge) <= distance(p, finite lead), every actual
  // cutter cross-section contacting p is also inside the authored cut sweep.
  const forwardSubsetContained = (x: number, y: number, pitch: number): boolean => {
    if (!cut || !anchor) return false
    const dx = free.x - anchor.x, dy = free.y - anchor.y
    const leadLength = Math.hypot(dx, dy)
    // This margin SHRINKS permission. Expand the tested rectangle and retain
    // a back-side strip when clipping, then require strict interior proofs.
    const margin = CONTACT_BIAS_MM
    const scale = cut.path.reduce((largest, p) => Math.max(largest, Math.abs(p.x), Math.abs(p.y)),
      Math.max(1, Math.abs(x), Math.abs(y), Math.abs(anchor.x), Math.abs(anchor.y), Math.abs(free.x), Math.abs(free.y), pitch))
    const roundoff = 128 * Number.EPSILON * scale
    if (!Number.isFinite(scale) || !(pitch > 0) || !(leadLength > margin) || roundoff > margin / 64 ||
        roundoff * (1 + scale / leadLength) > margin / 16) return false
    const nx = dx / leadLength, ny = dy / leadLength
    const rectangle = [
      { x: x - margin - anchor.x, y: y - margin - anchor.y },
      { x: x + pitch + margin - anchor.x, y: y - margin - anchor.y },
      { x: x + pitch + margin - anchor.x, y: y + pitch + margin - anchor.y },
      { x: x - margin - anchor.x, y: y + pitch + margin - anchor.y },
    ]
    const forward = (p: { x: number; y: number }) => p.x * nx + p.y * ny
    const polygon: { x: number; y: number }[] = []
    for (let i = 0; i < rectangle.length; i++) {
      const a = rectangle[i], b = rectangle[(i + 1) % rectangle.length]
      const da = forward(a), db = forward(b)
      if (da >= -margin) polygon.push(a)
      if ((da >= -margin) !== (db >= -margin)) {
        const denominator = db - da
        // Reject an ill-conditioned intersection rather than trimming away
        // an uncertain contact region. Padding remains much larger than error.
        if (Math.abs(denominator) <= margin ||
            roundoff * (1 + pitch / Math.abs(denominator)) > margin / 16) return false
        const t = (-margin - da) / denominator
        if (!(t >= 0 && t <= 1)) return false
        polygon.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) })
      }
    }
    if (polygon.length < 3) return false
    // Signed distance to the infinite lead line must have one definite sign.
    const leadSide = polygon.map(p => nx * p.y - ny * p.x)
    const sign = leadSide.every(d => d >= margin) ? 1 : leadSide.every(d => d <= -margin) ? -1 : 0
    if (!sign) return false
    const interiorEdgeContained = cut.path.some((a, i) => {
      const b = cut.path[(i + 1) % cut.path.length]
      if (distance2(anchor, a, b) > 1e-20) return false
      const ex = b.x - a.x, ey = b.y - a.y, length = Math.hypot(ex, ey)
      if (!(length > 2 * margin) || roundoff * (1 + scale / length) > margin / 16) return false
      const ux = ex / length, uy = ey / length
      return polygon.every((p, n) => {
        const px = p.x + (anchor.x - a.x), py = p.y + (anchor.y - a.y)
        const along = px * ux + py * uy
        const cutSide = ux * py - uy * px
        const leadDistance = sign * leadSide[n]
        // Vertex tests suffice: projection and both signed-distance
        // inequalities are affine over this convex polygon. Finite lead
        // distance >= line distance; finite cut distance equals line distance.
        return along >= margin && along <= length - margin &&
          leadDistance - cutSide >= margin && leadDistance + cutSide >= margin
      })
    })
    if (interiorEdgeContained) return true
    // A single ACTUAL finite endpoint must certify the entire same polygon.
    // |p-B|² - cross(n,p)² is convex (Hessian 2*n*n^T), so a strict negative
    // value at every vertex bounds the whole polygon, including its interior.
    // Shared conditioning checks bound linear arithmetic uncertainty below
    // margin. Local coordinates are <= 2*scale+margin; this squared-unit
    // allowance bounds subtraction, dot/cross and square errors conservatively.
    // It shrinks permission; it never enlarges authored removal or a radius.
    const squaredUncertainty = 64 * scale * margin + 16 * margin * margin
    const endpointContained = cut.path.some(endpoint => polygon.every((p, i) => {
      const px = p.x + (anchor.x - endpoint.x), py = p.y + (anchor.y - endpoint.y)
      const gap = leadSide[i] * leadSide[i] - (px * px + py * py)
      return Number.isFinite(gap) && gap > squaredUncertainty
    }))
    return endpointContained
  }
  const permittedCell = (x: number, y: number, pitch: number, radius: number): boolean => {
    if (!cut) return false
    if (onCutSegment) return true // candidate sweep is a subset of the authored cut sweep
    const corners = [{ x, y }, { x: x + pitch, y }, { x, y: y + pitch }, { x: x + pitch, y: y + pitch }]
    // On this half-plane the anchor is the nearest lead point. Since the cut
    // contains the anchor, any ACTUAL cutter contact is also inside the cut.
    if (anchor && corners.every(p => (p.x - anchor.x) * (free.x - anchor.x) +
        (p.y - anchor.y) * (free.y - anchor.y) <= 0)) return true
    if (cut.path.some((a, i) => corners.every(p =>
      distance2(p, a, cut.path[(i + 1) % cut.path.length]) <= radius * radius))) return true
    return forwardSubsetContained(x, y, pitch)
  }
  for (const component of components) {
    const radius = component.diameterMm / 2
    const bandBottom = Math.min(from.z, to.z) + component.bottomOffsetMm
    // Stock alignment must not raise the physical bottom used to certify
    // prior removal (whose authored floors remain doubles). Preserve the
    // existing downward alignment/bias, including when Float32 rounds up.
    const low = Math.min(bandBottom, Math.fround(bandBottom)) - CONTACT_BIAS_MM
    const high = component.topOffsetMm === undefined ? Infinity
      : Math.max(from.z, to.z) + component.topOffsetMm + CONTACT_BIAS_MM
    const intendedRadius = Math.min(radiusAt(Math.max(0, component.bottomOffsetMm - CONTACT_BIAS_MM)),
      radiusAt(component.topOffsetMm ?? component.bottomOffsetMm))
    const intendedCell = (originX: number, originY: number, pitch: number, width: number, c: number) =>
      component.kind === 'cutter' && permittedCell(originX + (c % width) * pitch,
        originY + Math.floor(c / width) * pitch, pitch, intendedRadius)
    const hitsSolid = (columns: SolidColumns, allowCut = false) => sweepColumns(
      columns.originX, columns.originY, columns.cell, columns.nx, columns.ny, from, to, radius,
      c => {
        for (let k = columns.spanStart[c]; k < columns.spanStart[c + 1]; k += 2) {
          if (columns.spanZ[k] <= high && columns.spanZ[k + 1] >= low &&
              !(allowCut && intendedCell(columns.originX, columns.originY, columns.cell, columns.nx, c))) return true
        }
        return false
      },
      c => {
        // Pure Z eligibility only. Permission and diagnostic-producing hits
        // remain after spatial qualification, in their original traversal order.
        for (let k = columns.spanStart[c]; k < columns.spanStart[c + 1]; k += 2) {
          if (columns.spanZ[k] <= high && columns.spanZ[k + 1] >= low) return true
        }
        return false
      },
    )
    let obstacle: ReachObstacle | undefined
    let firstStockRejection: ClearSpaceStockRejection | undefined
    if (workholding.some(columns => hitsSolid(columns))) obstacle = 'workholding'
    else if (part && hitsSolid(part, true)) obstacle = 'part'
    else if (maxTop > bottomZ && maxTop >= low && bottomZ <= high &&
      sweepColumns(bounds.minX, bounds.minY, cell, nx, ny, from, to, radius,
      c => {
        let hit = topZ[c] > bottomZ && topZ[c] >= low && bottomZ <= high &&
          !intendedCell(bounds.minX, bounds.minY, cell, nx, c) &&
          !(component.kind === 'cutter' && cut && unionAnchor && priorCutCoversForwardCell(
            stock.priorCuts, bounds.minX + (c % nx) * cell, bounds.minY + Math.floor(c / nx) * cell,
            cell, unionAnchor, unionFree, cut.path, low, high, cut.actualSegments, contactConstants()))
        // Refine ONLY an otherwise rejected stock/cutter engagement. Every
        // leaf retains the original maximum band radius, full Z enclosure and
        // finite lead. True spatial overlap is not permission: each residual
        // region needs authored contact or validated prior-removal authority.
        if (hit && component.kind === 'cutter' && cut && unionAnchor && hasExactUnionAnchor()) {
          const covered = coveredContactRegion(bounds.minX + (c % nx) * cell,
            bounds.minY + Math.floor(c / nx) * cell, cell, (x, y, width) =>
              !capsuleMayContactCell(from, to, radius, x, y, width) ||
              permittedCell(x, y, width, intendedRadius) ||
              priorCutCoversForwardCell(stock.priorCuts, x, y, width,
                unionAnchor, unionFree, cut.path, low, high, cut.actualSegments, contactConstants()))
          if (covered) hit = false
        }
        if (hit && input.includeFirstStockRejection) {
          const ix = c % nx, iy = Math.floor(c / nx)
          const x = bounds.minX + ix * cell, y = bounds.minY + iy * cell
          const cutterEligible = component.kind === 'cutter'
          // A rejected intendedCell proves these visited permission branches
          // returned false. Do not rerun them or evaluate skipped branches.
          const permissionVisited = cutterEligible && !!cut
          firstStockRejection = {
            column: c,
            cell: { ix, iy, minX: x, minY: y, maxX: x + cell, maxY: y + cell,
              pitch: cell, topZ: topZ[c], bottomZ },
            band: { component: component.kind, bottomOffsetMm: component.bottomOffsetMm,
              topOffsetMm: component.topOffsetMm ?? null, sweepRadiusMm: radius,
              expandedRadiusMm: radius + cell * Math.SQRT1_2 + CONTACT_BIAS_MM,
              intendedRadiusMm: intendedRadius, lowZ: low, highZ: Number.isFinite(high) ? high : null,
              highUnbounded: high === Infinity },
            permission: { cutterEligible, cutAvailable: !!cut,
              onCutSegment: permissionVisited ? onCutSegment : null,
              anchor: permissionVisited && anchor ? { x: anchor.x, y: anchor.y, z: anchor.z } : null,
              free: permissionVisited && anchor ? { x: free.x, y: free.y, z: free.z } : null,
              anchorHalfPlane: permissionVisited && anchor ? false : null,
              wholeCellContainment: permissionVisited ? false : null,
              forwardSubsetDomination: permissionVisited && anchor ? false : null },
            exactContactSubset: 'not-computed',
          }
        }
        return hit
      },
      c => topZ[c] > bottomZ && topZ[c] >= low && bottomZ <= high)) obstacle = 'stock'
    if (obstacle) return { status: 'collision', blocker: { component: component.kind, obstacle }, ...base,
      ...(firstStockRejection ? { firstStockRejection } : {}) }
  }
  return { status: 'clear', ...base }
}

// ── WO-2786: the whole assembly against everything, for ONE proposed move ────
//
// Step 2 of outside-in roughing (proposal on wo/WO-2654, "Later increments" 2).
// A READ-ONLY candidate query: nothing in production calls it yet. It reuses
// this file's one sweep implementation (the clear-space candidate's bands and
// column sweep) and adds exactly one permission: on a CUTTING move the cutting
// head may meet stock - that is removal. Everything else that touches is a
// collision: the cutting head in the part or the workholding, or on a
// non-cutting move in stock; any neck, shank or holder contact with stock,
// part or workholding. Non-cutting contact is never removal.
//
// Geometry that is absent or unreadable is UNRESOLVED with a reason, never
// assumed clear. A missing holder or stickout is unresolved only when the
// assembly that IS known clears; a proven contact is a collision either way.
// The operator's quiet missing-holder policy (WO-1626) is untouched: this query
// raises no warning and is consulted by nothing that emits a toolpath.

export type AssemblyEnvelopeUnresolved =
  | 'coordinates-invalid'
  | 'allowance-invalid'
  | 'obstacle-invalid'
  | 'tool-profile-invalid'
  | 'holder-invalid'
  | 'holder-missing'
  | 'stickout-missing'

export interface AssemblyEnvelopeSweep {
  readonly from: ReachPoint
  readonly to: ReachPoint
  readonly tool: Tool
  readonly holder?: ToolHolder
  /** Material present now, as column spans in the move's frame. Never mutated. */
  readonly stock: SolidColumns
  /** The protected part, as column spans in the move's frame. */
  readonly part: SolidColumns
  /** Every fixture, as column spans. Empty = proven none. */
  readonly workholding: readonly SolidColumns[]
  /** True for a cutting move: the cutting head may meet stock. */
  readonly cutsStock: boolean
  /** Kept radially and axially by neck/shank/holder from part and stock, and by
   *  every component - the cutter included - from the workholding, mm. */
  readonly allowanceMm: number
  /** Kept radially and axially by the cutting head from the part (stock to leave), mm. */
  readonly partAllowanceMm: number
}

export interface AssemblyEnvelopeReport {
  readonly status: 'clear' | 'collision' | 'unresolved'
  /** Set exactly when status === 'unresolved'. */
  readonly reason?: AssemblyEnvelopeUnresolved
  /** Every forbidden contact, ordered cutter, neck, shank, holder, then part,
   *  stock, workholding. */
  readonly collisions: readonly ReachBlocker[]
  /** The cutting head meets stock on a cutting move. Never set by neck, shank or
   *  holder contact, nor on a non-cutting move (that contact is a collision). */
  readonly removesStock: boolean
  readonly shankStatus: HolderClearanceReport['shankStatus']
  readonly holderStatus: HolderClearanceReport['holderStatus']
}

// The cutting head's lowest point may rest on stock it stands on - the floor a
// cut just left, a step-up leaving it - without that being removal or a crash.
// Material must rise more than this above the tip to count. Same figure and
// reason as cam3d's TRAVERSE_INTRUSION_TOLERANCE_MM (f32 tops); it applies to
// the cutting head against stock only, never to the part, workholding or any
// non-cutting component, and it widens nothing radially.
const ENVELOPE_FLOOR_TOLERANCE_MM = 1e-3

const ENVELOPE_COMPONENT_ORDER: readonly ReachComponent[] = ['cutter', 'neck', 'shank', 'holder']
const ENVELOPE_OBSTACLE_ORDER: readonly ReachObstacle[] = ['part', 'stock', 'workholding']

/** Judge one LINEAR move of the whole tool assembly. Z is enclosed over the
 * entire segment (as in the clear-space candidate), so a diagonal move can
 * over-report, never miss; column selection is conservative by a half cell. */
export function checkAssemblyEnvelopeSweep(input: AssemblyEnvelopeSweep): AssemblyEnvelopeReport {
  const { from, to, tool, holder, stock, part, workholding, cutsStock, allowanceMm, partAllowanceMm } = input
  const warnings: string[] = []
  const shank = shankComponents(tool, warnings)
  const holderResult = holderComponents(tool, holder, warnings)
  const base = { shankStatus: shank.status, holderStatus: holderResult.status }
  const unresolved = (reason: AssemblyEnvelopeUnresolved): AssemblyEnvelopeReport =>
    ({ status: 'unresolved', reason, collisions: [], removesStock: false, ...base })
  if (![from.x, from.y, from.z, to.x, to.y, to.z].every(Number.isFinite)) return unresolved('coordinates-invalid')
  if (![allowanceMm, partAllowanceMm].every(v => Number.isFinite(v) && v >= 0)) return unresolved('allowance-invalid')
  if (![stock, part, ...workholding].every(usableSweepColumns)) return unresolved('obstacle-invalid')
  let profile: ReturnType<typeof buildToolProfile>
  try { profile = buildToolProfile(tool) } catch { return unresolved('tool-profile-invalid') }
  if (shank.status !== 'checked' || !usableToolProfile(profile)) return unresolved('tool-profile-invalid')
  const holderInvalid = holderResult.status === 'missing-profile' && warnings.length > 0

  const components = assemblySweepBands(tool, profile,
    [...shank.components, ...holderResult.components], toolNeckBand(tool))
  const found = new Set<string>()
  let removesStock = false
  const tipZ = Math.min(from.z, to.z)
  const hits = (
    columns: SolidColumns, component: (typeof components)[number], allowance: number, floorTolerant = false,
  ): boolean => {
    const bandBottom = tipZ + component.bottomOffsetMm - allowance
    const aligned = Math.min(bandBottom, Math.fround(bandBottom)) - CONTACT_BIAS_MM
    const low = floorTolerant ? Math.max(aligned, tipZ + ENVELOPE_FLOOR_TOLERANCE_MM) : aligned
    const high = component.topOffsetMm === undefined ? Infinity
      : Math.max(from.z, to.z) + component.topOffsetMm + allowance + CONTACT_BIAS_MM
    const overlaps = (c: number): boolean => {
      for (let k = columns.spanStart[c]; k < columns.spanStart[c + 1]; k += 2) {
        if (columns.spanZ[k] <= high && columns.spanZ[k + 1] >= low) return true
      }
      return false
    }
    return sweepColumns(columns.originX, columns.originY, columns.cell, columns.nx, columns.ny,
      from, to, component.diameterMm / 2 + allowance, overlaps, overlaps)
  }
  const record = (component: ReachComponent, obstacle: ReachObstacle) => found.add(`${component}:${obstacle}`)
  const has = (component: ReachComponent, obstacle: ReachObstacle) => found.has(`${component}:${obstacle}`)
  for (const component of components) {
    const cutter = component.kind === 'cutter'
    if (!has(component.kind, 'workholding') && workholding.some(columns => hits(columns, component, allowanceMm))) {
      record(component.kind, 'workholding')
    }
    if (!has(component.kind, 'part') && hits(part, component, cutter ? partAllowanceMm : allowanceMm)) {
      record(component.kind, 'part')
    }
    if (cutter && cutsStock) {
      // Permitted contact only: this is the removal the move exists for.
      if (!removesStock && hits(stock, component, 0, true)) removesStock = true
    } else if (!has(component.kind, 'stock') && hits(stock, component, cutter ? 0 : allowanceMm, cutter)) {
      record(component.kind, 'stock')
    }
  }
  const collisions: ReachBlocker[] = []
  for (const component of ENVELOPE_COMPONENT_ORDER) {
    for (const obstacle of ENVELOPE_OBSTACLE_ORDER) {
      if (has(component, obstacle)) collisions.push({ component, obstacle })
    }
  }
  if (collisions.length > 0) return { status: 'collision', collisions, removesStock, ...base }
  const reason: AssemblyEnvelopeUnresolved | undefined = holderInvalid ? 'holder-invalid'
    : holderResult.status === 'missing-profile' ? 'holder-missing'
    : holderResult.status === 'missing-stickout' ? 'stickout-missing' : undefined
  if (reason) return { status: 'unresolved', reason, collisions, removesStock, ...base }
  return { status: 'clear', collisions, removesStock, ...base }
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
