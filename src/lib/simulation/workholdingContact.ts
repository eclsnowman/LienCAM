// WO-1578. Simulation names any contact with workholding: the same contact
// rule WO-1565/1575's trim uses (cutter, neck, shank and holder kept the
// allowance clear of a vise, jaw or clamp) run over a PLAYED program without
// changing it. Nothing here refuses or stops playback (rule 11) - it only
// reports where the tool assembly would have touched.
//
// holderClearance.ts (WO-263/1565/1575) owns the collision arithmetic and is
// out of this order's owned-paths, so its private per-component band builders
// (shankComponents/holderComponents/headBandsFor) cannot be imported. This
// module rebuilds the same bands from the same Tool/ToolHolder fields using
// only holderClearance's PUBLIC surface (buildSolidColumns, toolNeckBand, the
// exported types) plus buildToolProfile, so the semantics track the trim
// without touching a file this order does not own.

import type { ImportedGeometry, Project, Tool, ToolHolder, ToolpathMove, Vec3, BoundingBox } from '../../types'
import { buildToolProfile } from '../tool/toolProfile'
import { rotationMatrixXYZ } from '../geometry/rotationMatrixXYZ'
import { sampleArcMovesForLinearConsumers } from '../cam/toolpathArcSampling'
import {
  buildSolidColumns,
  toolNeckBand,
  type ClearanceComponent,
  type ClearanceMesh,
  type SolidColumns,
} from '../cam/holderClearance'
import { transformPositions } from '../workholding/pose'
import { placedBoundingBox, resolveInstancePlacements, workholdingComponentGeometryIds } from '../workholding/resolveWorkholding'
import {
  cachedWorkholdingShapeReader, readDisplayShape, type LocalMesh, type WorkholdingShapeReader,
} from '../workholding/shapes'

export type { ClearanceMesh }

/** A move in a played program. `line` is the source .nc/.gcode line number when
 *  the program was loaded from a file; absent for a computed operation, whose
 *  moves are reported by operation name + move index instead. */
export interface WorkholdingContactMove extends ToolpathMove {
  readonly line?: number
}

export type ContactComponent = 'cutter' | ClearanceComponent

/** One contiguous run of contacting moves, collapsed to a single report line. */
export interface WorkholdingContactHit {
  readonly firstMoveIndex: number
  readonly lastMoveIndex: number
  readonly components: readonly ContactComponent[]
}

export interface WorkholdingContactReport {
  readonly hits: readonly WorkholdingContactHit[]
}

export interface WorkholdingContactInput {
  readonly moves: readonly WorkholdingContactMove[]
  readonly tool: Tool
  readonly holder?: ToolHolder
  /** Vises, jaws and clamps, one triangle mesh each, in the SAME frame as the
   *  moves. Empty/absent = nothing to report. */
  readonly workholding: readonly ClearanceMesh[]
  readonly allowanceMm: number
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

interface ContactBand {
  readonly kind: ClearanceComponent
  readonly bottomOffsetMm: number
  readonly topOffsetMm?: number
  readonly diameterMm: number
}

/** Mirrors holderClearance.ts's private shankComponents: the neck (if the tool
 *  declares one) then the shank, from the tool's own exposed length. */
function neckAndShankBands(tool: Tool): ContactBand[] {
  if (!isPositiveFinite(tool.fluteLength) || !isPositiveFinite(tool.shankDiameter)) return []
  const exposedTop = isPositiveFinite(tool.lengthBelowHolder) ? tool.lengthBelowHolder : tool.overallLength
  const neck = toolNeckBand(tool)
  if (neck && isPositiveFinite(exposedTop) && exposedTop > neck.bottomMm) {
    const bands: ContactBand[] = [{
      kind: 'neck',
      bottomOffsetMm: neck.bottomMm,
      topOffsetMm: Math.min(neck.topMm, exposedTop),
      diameterMm: neck.diameterMm,
    }]
    if (exposedTop > neck.topMm) {
      bands.push({ kind: 'shank', bottomOffsetMm: neck.topMm, diameterMm: tool.shankDiameter })
    }
    return bands
  }
  if (!isPositiveFinite(exposedTop) || exposedTop <= tool.fluteLength) return []
  return [{ kind: 'shank', bottomOffsetMm: tool.fluteLength, diameterMm: tool.shankDiameter }]
}

/** Mirrors holderClearance.ts's private holderComponents: any invalid segment
 *  means the whole holder is not checked, same as the trim. */
function holderBands(tool: Tool, holder: ToolHolder | undefined): ContactBand[] {
  if (!holder || holder.segments.length === 0 || (tool.holderId && holder.id !== tool.holderId)) return []
  if (!isPositiveFinite(tool.lengthBelowHolder)) return []
  const bands: ContactBand[] = []
  let segmentBottom = tool.lengthBelowHolder
  for (let index = 0; index < holder.segments.length; index++) {
    const segment = holder.segments[index]
    if (!isPositiveFinite(segment.height) || !isPositiveFinite(segment.lowerDiameter) || !isPositiveFinite(segment.upperDiameter)) {
      return []
    }
    bands.push({
      kind: 'holder',
      bottomOffsetMm: segmentBottom,
      ...(index < holder.segments.length - 1 ? { topOffsetMm: segmentBottom + segment.height } : {}),
      diameterMm: Math.max(segment.lowerDiameter, segment.upperDiameter),
    })
    segmentBottom += segment.height
  }
  return bands
}

interface HeadBand { readonly bottom: number; readonly top: number; readonly radius: number }

/** Mirrors holderClearance.ts's private headBandsFor(tool, 0, 0): against
 *  workholding the whole cutting head, at its full profile radius, keeps the
 *  allowance like the rest of the assembly (WO-1575). */
function cutterHeadBands(tool: Tool): HeadBand[] {
  const profile = buildToolProfile(tool)
  const bands: HeadBand[] = []
  const vertices = profile.vertices
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i]
    const b = vertices[i + 1]
    if (a.z >= profile.cuttingMaxZ - 1e-9) break
    if (!(b.z > a.z)) continue
    const radius = Math.max(a.r, b.r)
    if (radius > 0) bands.push({ bottom: a.z, top: Math.min(b.z, profile.cuttingMaxZ), radius })
  }
  return bands
}

/** Whether any workholding column under a disc of `radius` holds solid
 *  material between z0 and z1. Mirrors holderClearance.ts's private
 *  partHitsCylinder, built only from SolidColumns's public fields. */
function columnsHitCylinder(columns: SolidColumns, x: number, y: number, radius: number, z0: number, z1: number): boolean {
  const { originX, originY, cell, nx, ny, spanStart, spanZ } = columns
  const i0 = Math.max(0, Math.ceil((x - radius - originX) / cell - 0.5))
  const i1 = Math.min(nx - 1, Math.floor((x + radius - originX) / cell - 0.5))
  const j0 = Math.max(0, Math.ceil((y - radius - originY) / cell - 0.5))
  const j1 = Math.min(ny - 1, Math.floor((y + radius - originY) / cell - 0.5))
  if (i0 > i1 || j0 > j1) return false
  const r2 = radius * radius
  // WO-2706: walk BLOCK x BLOCK groups of columns first. A group is skipped
  // only when no span in it can overlap (z0, z1) - its lowest bottom is at or
  // above z1, or its highest top at or below z0 - or when none of its cell
  // centres can lie inside the disc (tested with a margin, so float rounding
  // can only keep a group, never drop one). Every column in a kept group gets
  // the original per-column test unchanged, so the answer is identical.
  const index = blockIndexOf(columns)
  if (index.minBottom >= z1 || index.maxTop <= z0) return false
  const { bnx, blockMinBottom, blockMaxTop } = index
  const r2Margin = r2 + 1e-9 * (r2 + 1) + 4 * cell * cell * 1e-9
  const bj0 = Math.floor(j0 / BLOCK)
  const bj1 = Math.floor(j1 / BLOCK)
  const bi0 = Math.floor(i0 / BLOCK)
  const bi1 = Math.floor(i1 / BLOCK)
  for (let bj = bj0; bj <= bj1; bj++) {
    const cj0 = Math.max(j0, bj * BLOCK)
    const cj1 = Math.min(j1, bj * BLOCK + BLOCK - 1)
    const yLo = originY + (cj0 + 0.5) * cell - y
    const yHi = originY + (cj1 + 0.5) * cell - y
    const ny2 = yLo > 0 ? yLo * yLo : (yHi < 0 ? yHi * yHi : 0)
    if (ny2 > r2Margin) continue
    for (let bi = bi0; bi <= bi1; bi++) {
      const block = bj * bnx + bi
      if (blockMinBottom[block] >= z1 || blockMaxTop[block] <= z0) continue
      const ci0 = Math.max(i0, bi * BLOCK)
      const ci1 = Math.min(i1, bi * BLOCK + BLOCK - 1)
      const xLo = originX + (ci0 + 0.5) * cell - x
      const xHi = originX + (ci1 + 0.5) * cell - x
      const nx2 = xLo > 0 ? xLo * xLo : (xHi < 0 ? xHi * xHi : 0)
      if (nx2 + ny2 > r2Margin) continue
      for (let j = cj0; j <= cj1; j++) {
        const dy = originY + (j + 0.5) * cell - y
        if (dy * dy > r2) continue
        for (let i = ci0; i <= ci1; i++) {
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
    }
  }
  return false
}

// WO-2706: the panel rebuilds fresh mesh objects for the same vise on every
// rebuild (Simulate entry, the stock-removal toggle) and runs this once per
// operation; the columns are a pure function of the mesh, so a mesh whose
// positions and indices are element-for-element equal to a cached one reuses
// that one's columns (and with them its block index).
interface ColumnsCacheEntry {
  readonly positions: Float64Array
  readonly indices: Float64Array
  readonly columns: SolidColumns | null
}
const COLUMNS_CACHE_LIMIT = 16
const columnsCache: ColumnsCacheEntry[] = []

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

function cachedSolidColumns(mesh: ClearanceMesh): SolidColumns | null {
  const positions = Float64Array.from(mesh.positions)
  const indices = Float64Array.from(mesh.indices)
  for (const entry of columnsCache) {
    if (sameArray(entry.positions, positions) && sameArray(entry.indices, indices)) return entry.columns
  }
  const columns = buildSolidColumns(mesh)
  columnsCache.unshift({ positions, indices, columns })
  if (columnsCache.length > COLUMNS_CACHE_LIMIT) columnsCache.pop()
  return columns
}

// WO-2706: per-part block bounds for columnsHitCylinder's exact early-outs.
const BLOCK = 16

interface BlockIndex {
  readonly bnx: number
  readonly minBottom: number
  readonly maxTop: number
  /** Per block: lowest span bottom (+Infinity when the block is all air). */
  readonly blockMinBottom: Float64Array
  /** Per block: highest span top (-Infinity when the block is all air). */
  readonly blockMaxTop: Float64Array
}

const blockIndexes = new WeakMap<SolidColumns, BlockIndex>()

function blockIndexOf(columns: SolidColumns): BlockIndex {
  const cached = blockIndexes.get(columns)
  if (cached) return cached
  const { nx, ny, spanStart, spanZ } = columns
  const bnx = Math.ceil(nx / BLOCK)
  const bny = Math.ceil(ny / BLOCK)
  const blockMinBottom = new Float64Array(bnx * bny).fill(Number.POSITIVE_INFINITY)
  const blockMaxTop = new Float64Array(bnx * bny).fill(Number.NEGATIVE_INFINITY)
  let minBottom = Number.POSITIVE_INFINITY
  let maxTop = Number.NEGATIVE_INFINITY
  for (let j = 0; j < ny; j++) {
    const rowBlock = Math.floor(j / BLOCK) * bnx
    for (let i = 0; i < nx; i++) {
      const column = j * nx + i
      const end = spanStart[column + 1]
      const start = spanStart[column]
      if (start === end) continue
      const block = rowBlock + Math.floor(i / BLOCK)
      for (let k = start; k < end; k += 2) {
        const bottom = spanZ[k]
        const top = spanZ[k + 1]
        if (bottom < blockMinBottom[block]) blockMinBottom[block] = bottom
        if (top > blockMaxTop[block]) blockMaxTop[block] = top
        if (bottom < minBottom) minBottom = bottom
        if (top > maxTop) maxTop = top
      }
    }
  }
  const index: BlockIndex = { bnx, minBottom, maxTop, blockMinBottom, blockMaxTop }
  blockIndexes.set(columns, index)
  return index
}

// A program can carry hundreds of thousands of moves (a dense adaptive
// clearing pass); this check runs on the MAIN thread (the simulation panel),
// unlike the worker-side trim, so the sampling pitch is coarser than the
// trim's own REACH_STEP_MM to keep it responsive. Coarser sampling can only
// ever miss a contact narrower than this pitch along the direction of travel;
// it never invents one that is not there.
const CONTACT_SAMPLE_STEP_MM = 1

function contactAt(
  x: number, y: number, z: number,
  columnsList: readonly SolidColumns[],
  allowanceMm: number,
  bands: readonly ContactBand[],
  headBands: readonly HeadBand[],
): ReadonlySet<ContactComponent> | null {
  let hit: Set<ContactComponent> | null = null
  for (const columns of columnsList) {
    for (const band of headBands) {
      if (columnsHitCylinder(
        columns, x, y, band.radius + allowanceMm,
        z + band.bottom - allowanceMm, z + band.top + allowanceMm,
      )) {
        hit ??= new Set()
        hit.add('cutter')
      }
    }
    for (const band of bands) {
      const top = band.topOffsetMm === undefined ? Number.POSITIVE_INFINITY : z + band.topOffsetMm + allowanceMm
      if (columnsHitCylinder(columns, x, y, band.diameterMm / 2 + allowanceMm, z + band.bottomOffsetMm - allowanceMm, top)) {
        hit ??= new Set()
        hit.add(band.kind)
      }
    }
  }
  return hit
}

/**
 * WO-1578. Run WO-1575's contact rule over a played program: every move is
 * checked, nothing is trimmed or refused, and contacting moves come back as
 * one entry per contiguous run so a caller can post one console line per run.
 */
export function checkWorkholdingContact(input: WorkholdingContactInput): WorkholdingContactReport {
  const { moves, tool, holder, workholding, allowanceMm } = input
  if (moves.length === 0 || workholding.length === 0) return { hits: [] }

  const columnsList = workholding
    .map((mesh) => cachedSolidColumns(mesh))
    .filter((columns): columns is SolidColumns => columns !== null)
  if (columnsList.length === 0) return { hits: [] }

  const bands = [...neckAndShankBands(tool), ...holderBands(tool, holder)]
  const headBands = cutterHeadBands(tool)
  if (bands.length === 0 && headBands.length === 0) return { hits: [] }

  const allowance = Math.max(0, allowanceMm)
  const originIndices: number[] = []
  const sampled = sampleArcMovesForLinearConsumers(moves, {}, originIndices)
  const perMoveHits = new Map<number, Set<ContactComponent>>()

  const recordHit = (moveIndex: number, hit: ReadonlySet<ContactComponent>) => {
    let set = perMoveHits.get(moveIndex)
    if (!set) {
      set = new Set()
      perMoveHits.set(moveIndex, set)
    }
    for (const component of hit) set.add(component)
  }

  if (sampled.length > 0) {
    const first = contactAt(sampled[0].x, sampled[0].y, sampled[0].z, columnsList, allowance, bands, headBands)
    if (first) recordHit(originIndices[0], first)
  }
  for (let i = 1; i < sampled.length; i++) {
    const from = sampled[i - 1]
    const to = sampled[i]
    const moveIndex = originIndices[i]
    const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
    const steps = Math.max(1, Math.ceil(dist / CONTACT_SAMPLE_STEP_MM))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const x = from.x + (to.x - from.x) * t
      const y = from.y + (to.y - from.y) * t
      const z = from.z + (to.z - from.z) * t
      const hit = contactAt(x, y, z, columnsList, allowance, bands, headBands)
      if (hit) recordHit(moveIndex, hit)
    }
  }

  const sortedIndices = [...perMoveHits.keys()].sort((a, b) => a - b)
  const hits: WorkholdingContactHit[] = []
  let runStart = -1
  let runEnd = -1
  let runComponents: Set<ContactComponent> = new Set()
  const flush = () => {
    if (runStart < 0) return
    hits.push({ firstMoveIndex: runStart, lastMoveIndex: runEnd, components: [...runComponents].sort() })
  }
  for (const index of sortedIndices) {
    if (runStart >= 0 && index === runEnd + 1) {
      runEnd = index
      for (const component of perMoveHits.get(index)!) runComponents.add(component)
    } else {
      flush()
      runStart = index
      runEnd = index
      runComponents = new Set(perMoveHits.get(index))
    }
  }
  flush()
  return { hits }
}

const COMPONENT_NAMES: Record<ContactComponent, string> = {
  cutter: 'cutter', neck: 'neck', shank: 'shank', holder: 'holder',
}

function componentPhrase(components: readonly ContactComponent[]): string {
  const names = components.map((component) => COMPONENT_NAMES[component])
  if (names.length <= 1) return names[0] ?? 'the tool'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function place(move: Pick<WorkholdingContactMove, 'x' | 'y' | 'z'>): string {
  return `X ${move.x.toFixed(2)} Y ${move.y.toFixed(2)} Z ${move.z.toFixed(2)}`
}

/**
 * WO-1578. One console line per hit: the program line number when the move
 * carries one (a loaded .nc/.gcode file), else the operation name and move
 * index; the XYZ of the first contacting position; which tool component; and
 * the word "workholding". A run of consecutive contacting moves is one line.
 */
export function workholdingContactConsoleLines(
  operation: string,
  moves: readonly WorkholdingContactMove[],
  report: WorkholdingContactReport,
): string[] {
  return report.hits.map((hit) => {
    const first = moves[hit.firstMoveIndex]
    const last = moves[hit.lastMoveIndex]
    const label = first.line !== undefined
      ? (last.line !== undefined && last.line !== first.line ? `line ${first.line}-${last.line}` : `line ${first.line}`)
      : (hit.lastMoveIndex > hit.firstMoveIndex
          ? `${operation}, moves ${hit.firstMoveIndex + 1}-${hit.lastMoveIndex + 1}`
          : `${operation}, move ${hit.firstMoveIndex + 1}`)
    return `${label}: ${componentPhrase(hit.components)} contacts workholding at ${place(first)}.`
  })
}

/**
 * WO-1578. A workholding body's real shape is not tessellated data this order
 * can reach from the store (an imported mesh's triangles live only in the
 * live viewport scene) - its bounding box, carried through the SAME
 * position/rotation the viewport applies, is a safe over-approximation: it
 * can report a contact a tighter real shape would have cleared, it can never
 * miss one that is real.
 */
export function workholdingBoxMesh(
  boundingBox: BoundingBox,
  position: Vec3,
  rotation: Vec3,
): ClearanceMesh {
  const { min, max } = boundingBox
  const corners: Vec3[] = [
    { x: min.x, y: min.y, z: min.z }, { x: max.x, y: min.y, z: min.z },
    { x: max.x, y: max.y, z: min.z }, { x: min.x, y: max.y, z: min.z },
    { x: min.x, y: min.y, z: max.z }, { x: max.x, y: min.y, z: max.z },
    { x: max.x, y: max.y, z: max.z }, { x: min.x, y: max.y, z: max.z },
  ]
  const rot = rotationMatrixXYZ(rotation)
  const positions = new Float32Array(24)
  corners.forEach((corner, i) => {
    positions[i * 3] = rot.col1.x * corner.x + rot.col2.x * corner.y + rot.col3.x * corner.z + position.x
    positions[i * 3 + 1] = rot.col1.y * corner.x + rot.col2.y * corner.y + rot.col3.y * corner.z + position.y
    positions[i * 3 + 2] = rot.col1.z * corner.x + rot.col2.z * corner.y + rot.col3.z * corner.z + position.z
  })
  const indices = Uint32Array.from([
    0, 1, 2, 0, 2, 3, // bottom
    4, 6, 5, 4, 7, 6, // top
    0, 4, 5, 0, 5, 1, // side y=min
    1, 5, 6, 1, 6, 2, // side x=max
    2, 6, 7, 2, 7, 3, // side y=max
    3, 7, 4, 3, 4, 0, // side x=min
  ])
  return { positions, indices }
}

// ── WO-2646: the exact shape of a vise or clamp ──────────────────────────────
//
// The box alone (workholdingContactBodies) reported a contact that was not
// there: the shipped soft-jaws vise's fixed half is a base with two ledges and
// an open gap between them, and its box fills that gap up to the ledge tops. A
// drill through the jaw blank ends at the blank's bottom, over the gap, 10 mm
// clear of the base - and on the top face of the box.
//
// The panel builds frames synchronously and an imported shape is an async read
// (the STL/STEP caches), so the shapes are read ahead into this cache - the
// panel primes it every time it rebuilds, in every view mode, so by the time
// the operator enters Simulate the read has long finished. A component whose
// shape is not read yet (or cannot be read) keeps its box: over-report, never
// miss (WO-1578). Keyed by geometry id and held against the row object, so an
// edited or re-imported row is read again; a shape that could not be read is
// not remembered, so the next rebuild tries again (a cache filled late).

const exactShapes = new Map<string, { readonly row: ImportedGeometry; readonly shape: LocalMesh }>()

/** Reads every vise and clamp component's exact shape into the cache. */
export async function primeWorkholdingContactShapes(
  project: Pick<Project, 'geometry' | 'workholding'>,
  reader: WorkholdingShapeReader = cachedWorkholdingShapeReader,
): Promise<void> {
  const ids = workholdingComponentGeometryIds(project.workholding)
  for (const id of [...exactShapes.keys()]) if (!ids.has(id)) exactShapes.delete(id)
  await Promise.all(project.geometry
    .filter((row) => ids.has(row.id) && exactShapes.get(row.id)?.row !== row)
    .map(async (row) => {
      const shape = await readDisplayShape(row, reader)
      if (shape) exactShapes.set(row.id, { row, shape })
      else exactShapes.delete(row.id)
    }))
}

/**
 * The workholding the contact check runs against in `setupId`: each placed
 * vise or clamp component as its exact shape once primed, else its bounding
 * box; every other marked row boxed exactly as workholding/contactBodies.ts
 * does.
 */
export function workholdingContactShapes(
  project: Pick<Project, 'geometry' | 'workholding'>,
  setupId: string | null | undefined,
): ClearanceMesh[] {
  const rows = new Map(project.geometry.map((g) => [g.id, g]))
  const meshes: ClearanceMesh[] = []
  for (const placement of resolveInstancePlacements(project, setupId).placements) {
    const row = rows.get(placement.geometryId)!
    const cached = exactShapes.get(row.id)
    const mesh = cached?.row === row
      ? {
          positions: transformPositions(placement.worldFromComponent, cached.shape.positions),
          indices: Uint32Array.from(cached.shape.indices),
        }
      : placedBoundingBox(placement, row)
    if (mesh) meshes.push(mesh)
  }
  const componentRows = workholdingComponentGeometryIds(project.workholding)
  for (const g of project.geometry) {
    if (g.workholding !== true || componentRows.has(g.id)) continue
    meshes.push(workholdingBoxMesh(g.boundingBox, g.position, g.rotation))
  }
  return meshes
}
