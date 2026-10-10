// Image relief stage 1a (WO-2170) - measure the two Apply routes of
// docs/design/IMAGE-RELIEF-PLAN.md section 3 on one relief, step by step,
// through the product's own code: the geometry engine (GeomEngine: BREP
// hand-off, tessellation, the cut boolean), the mesh tools (manifold boolean)
// and the 3D CAM worker (computeParallel3dMoves). Each step records its
// time, the process's peak memory where the caller can read it, triangle
// counts and volume errors. The test src/tests/relief/reliefKernel.test.ts
// runs it; RELIEF_BENCH=1 runs every size and writes the evidence file.

import type { OcctKernel, ShapeHandle } from 'occt-wasm'
import type { GeomEngine } from '../geom/worker/geom-engine'
import type { BodyHandle } from '../geom/geom-service'
import type { Cam3dClient } from '../cam3d/worker/client'
import type { PartMesh } from '../cam3d/kernel/types'
import type { ManifoldWasmModule } from '../mesh/manifoldKernel'
import type { Tool } from '../types'
import { sanitizeTriangleMesh } from '../cam3d/input/sanitize'
import { computeParallel3dMoves, DEFAULT_PARALLEL3D_PARAMS } from '../cam3d/integration/parallel3dOperation'
import { booleanMesh } from '../mesh/manifoldOps'
import { gridVolumeInDisk, reliefSurfacePoints, type HeightGrid } from './heightGrid'
import { poleSurfaceHeight, poleSurfaceVolume, reliefPoles, type ReliefPoles } from './reliefStep'
import { buildExactRelief, sewReliefIntoSolid } from './reliefKernel'
import { cylinderMesh, meshVolume, reliefPlateMesh, type PlateSpec } from './reliefMesh'

/** CAM tolerance: the Parallel Finish default; model tessellation at a quarter of it (D-007, src/cam3d/input/step.ts). */
export const CAM_TOLERANCE_MM = DEFAULT_PARALLEL3D_PARAMS.tolerance
export const CAM_DEFLECTION_MM = CAM_TOLERANCE_MM / 4
export const CAM_ANGULAR_DEFLECTION_RAD = 0.35
/** Mesh-route hole sides: chord error 3 x (1 - cos(pi/64)) = 0.0036 mm, under the CAM deflection. */
const HOLE_SEGMENTS = 64

export interface BenchContext {
  kernel: OcctKernel
  engine: GeomEngine
  cam: Cam3dClient
  manifold: ManifoldWasmModule
  /** peak resident memory of the process so far, MB; undefined where it cannot be read */
  peakMemoryMb: () => number | undefined
}

export interface BenchCase {
  fixture: string
  /** the working grid (heights in mm, border at 0) */
  grid: HeightGrid
  plate: PlateSpec
  /** low corner of the relief on the plate top */
  origin: { x: number; y: number }
  /** the relief's volume above the plate top, mm^3 */
  referenceVolume: number
  referenceSource: string
  /** the through hole, plate coordinates */
  hole: { x: number; y: number; radius: number }
  finish: { tool: Tool; stepover: number }
}

export interface Step {
  ms: number
  peakMemoryMb?: number
  triangles?: number
  /** largest distance, mm, from the mesh to the exact relief surface, over the relief's triangles (centroids and edge midpoints) */
  maxChordMm?: number
}

export interface FinishStep extends Step {
  /** the kernel's own compute time (computeTimeMs); ms includes the mesh upload */
  computeMs: number
  moves: number
  cutMoves: number
}

export interface RouteRecord {
  route: 'exact' | 'mesh' | 'exact-fit'
  fixture: string
  /** control points per side (exact routes) */
  n?: number
  /** grid samples (mesh route) */
  grid?: { cols: number; rows: number }
  ok: boolean
  error?: string
  steps: Record<string, Step | FinishStep>
  /**
   * relief volume the built body carries (body volume minus the plain plate), mm^3.
   * Exact routes: from the engine's CAM tessellation of the body (its chord
   * error is recorded on the step), because the kernel's getVolume over-reads
   * a detailed B-spline face (see getVolumeErrorPct).
   */
  reliefVolume?: number
  /** (reliefVolume - reference) / reference, % */
  volumeErrorPct?: number
  /** exact route: the kernel's getVolume against the reference, % (MEASURED: +1 % on a detailed face whose geometry is right) */
  getVolumeErrorPct?: number
  /** exact route: the pole surface's closed-form volume against the reference, % (the sampling error alone) */
  poleVolumeErrorPct?: number
  /** removed by the hole (difference of the CAM tessellations' volumes before and after), vs expected, mm^3 */
  hole?: { removed: number; expected: number }
  notes?: string[]
}

function step(ctx: BenchContext, t0: number, extra: Omit<Step, 'ms' | 'peakMemoryMb'> = {}): Step {
  const mem = ctx.peakMemoryMb()
  return { ms: Math.round((performance.now() - t0) * 10) / 10, ...(mem !== undefined ? { peakMemoryMb: Math.round(mem) } : {}), ...extra }
}

function plateVolume(p: PlateSpec): number {
  return p.x * p.y * p.z
}

function pct(measured: number, reference: number): number {
  return Math.round(((measured - reference) / reference) * 1e6) / 1e4
}

function reliefRing(c: BenchCase): Float64Array {
  const { x, y } = c.origin
  const w = c.grid.widthMm, d = c.grid.depthMm
  return new Float64Array([x, y, x + w, y, x + w, y + d, x, y + d])
}

async function finishOn(ctx: BenchContext, c: BenchCase, partMesh: PartMesh): Promise<FinishStep> {
  const t0 = performance.now()
  let maxZ = -Infinity
  for (let i = 2; i < partMesh.positions.length; i += 3) maxZ = Math.max(maxZ, partMesh.positions[i])
  const { moves, computeTimeMs } = await computeParallel3dMoves({
    partMesh,
    tool: c.finish.tool,
    params: { ...DEFAULT_PARALLEL3D_PARAMS, stepover: c.finish.stepover, tolerance: CAM_TOLERANCE_MM, stockEdgeOvershoot: 0 },
    resolvedHeights: { clearanceZ: maxZ + 10, retractZ: maxZ + 5, feedZ: maxZ + 2, topZ: maxZ, bottomZ: 0, stockTopZ: maxZ },
    boundary: [reliefRing(c)],
    boundaryKind: 'selection',
    client: ctx.cam,
  })
  const s = step(ctx, t0)
  return { ...s, computeMs: Math.round(computeTimeMs * 10) / 10, moves: moves.length, cutMoves: moves.filter((m) => m.role === 'cut').length }
}

function toPartMesh(position: Float32Array, index: Uint32Array, faceIds?: Uint32Array): PartMesh {
  const clean = sanitizeTriangleMesh(position, index, faceIds)
  if (!clean.watertight && !clean.watertightBeforeRepair) throw new Error(`CAM mesh not watertight: ${clean.boundaryEdges} open edges`)
  return { positions: clean.positions, indices: clean.indices, bounds: clean.bounds, ...(clean.faceIds ? { faceIds: clean.faceIds } : {}), source: 'model' }
}

/** The mesh's largest vertical gap to the pole surface, over triangles lying on the relief rectangle. */
function reliefChordError(positions: ArrayLike<number>, indices: ArrayLike<number>, poles: ReliefPoles, c: BenchCase): number {
  const { x: ox, y: oy } = c.origin
  const eps = 1e-6
  const inside = (x: number, y: number) => x > ox - eps && y > oy - eps && x < ox + poles.widthMm + eps && y < oy + poles.depthMm + eps
  let worst = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, d = indices[t + 2] * 3
    const P = [a, b, d].map((i) => [positions[i], positions[i + 1], positions[i + 2]])
    if (!P.every(([x, y, z]) => inside(x, y) && z > c.plate.z - 1e-4)) continue
    const probes = [
      [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3, (P[0][2] + P[1][2] + P[2][2]) / 3],
      ...[[0, 1], [1, 2], [2, 0]].map(([i, j]) => [(P[i][0] + P[j][0]) / 2, (P[i][1] + P[j][1]) / 2, (P[i][2] + P[j][2]) / 2]),
    ]
    for (const [x, y, z] of probes) worst = Math.max(worst, Math.abs(z - c.plate.z - poleSurfaceHeight(poles, x - ox, y - oy)))
  }
  return Math.round(worst * 1e5) / 1e5
}

function expectedHoleRemoval(c: BenchCase, area: number): number {
  const r = c.hole.radius
  return area * c.plate.z + gridVolumeInDisk(c.grid, c.hole.x - c.origin.x, c.hole.y - c.origin.y, r) * (area / (Math.PI * r * r))
}

/**
 * Route (b): n x n explicit poles -> STEP face -> split + sew into the plate
 * (kernel) -> BREP hand-off to the geometry engine -> CAM tessellation ->
 * through-hole cut (engine boolean) -> tessellation -> Parallel Finish (3D).
 */
export async function measureExactRoute(ctx: BenchContext, c: BenchCase, n: number, opts: { finish?: boolean } = {}): Promise<RouteRecord> {
  const k = ctx.kernel
  const rec: RouteRecord = { route: 'exact', fixture: c.fixture, n, ok: false, steps: {} }
  const own: ShapeHandle[] = []
  const bodies: BodyHandle[] = []
  try {
    let t0 = performance.now()
    const poles = reliefPoles(c.grid, n)
    rec.steps.poles = step(ctx, t0)

    const plate = k.makeBox(c.plate.x, c.plate.y, c.plate.z)
    own.push(plate)
    t0 = performance.now()
    const built = buildExactRelief(k, plate, poles, { origin: c.origin, baseZ: c.plate.z })
    own.push(built.solid)
    rec.steps.build = step(ctx, t0)
    rec.steps.buildWriteStep = { ms: Math.round(built.times.writeMs) }
    rec.steps.buildReadStep = { ms: Math.round(built.times.readMs) }
    rec.steps.buildSplit = { ms: Math.round(built.times.splitMs) }
    rec.steps.buildSew = { ms: Math.round(built.times.sewMs) }
    rec.notes = [`STEP text ${(built.stepBytes / 1e6).toFixed(1)} MB`]

    rec.getVolumeErrorPct = pct(k.getVolume(built.solid) - plateVolume(c.plate), c.referenceVolume)
    rec.poleVolumeErrorPct = pct(poleSurfaceVolume(poles), c.referenceVolume)

    t0 = performance.now()
    const bytes = k.toBREPBinary(built.solid).slice().buffer
    const body = await ctx.engine.restoreBody(bytes, { featureId: 'relief', modified: {}, generated: [], deleted: [] })
    bodies.push(body)
    rec.steps.handoff = step(ctx, t0)
    rec.notes.push(`BREP ${(bytes.byteLength / 1e6).toFixed(1)} MB`)

    const q = { deflection: CAM_DEFLECTION_MM, angularDeflection: CAM_ANGULAR_DEFLECTION_RAD }
    t0 = performance.now()
    const tess = await ctx.engine.tessellate(body, q)
    rec.steps.tessellate = step(ctx, t0, { triangles: tess.index.length / 3 })
    rec.steps.tessellate.maxChordMm = reliefChordError(tess.position, tess.index, poles, c)
    const v = meshVolume({ positions: tess.position, indices: tess.index }) - plateVolume(c.plate)
    rec.reliefVolume = v
    rec.volumeErrorPct = pct(v, c.referenceVolume)

    const cyl = k.translate(k.makeCylinder(c.hole.radius, c.plate.z + 20), c.hole.x, c.hole.y, -5)
    own.push(cyl)
    const tool = await ctx.engine.restoreBody(k.toBREPBinary(cyl).slice().buffer, { featureId: 'hole-tool', modified: {}, generated: [], deleted: [] })
    bodies.push(tool)
    t0 = performance.now()
    const cut = await ctx.engine.applyBoolean({ featureId: 'hole', op: 'cut', target: body, tools: [tool] })
    if (!cut.ok || cut.body === undefined) throw new Error(`hole cut failed: ${JSON.stringify(cut.diagnostics)}`)
    bodies.push(cut.body)
    rec.steps.hole = step(ctx, t0)

    t0 = performance.now()
    const tess2 = await ctx.engine.tessellate(cut.body, q)
    const part = toPartMesh(tess2.position, tess2.index, tess2.triFace)
    rec.steps.tessellateAfterHole = step(ctx, t0, { triangles: part.indices.length / 3 })
    rec.hole = {
      removed: meshVolume({ positions: tess.position, indices: tess.index }) - meshVolume({ positions: tess2.position, indices: tess2.index }),
      expected: expectedHoleRemoval(c, Math.PI * c.hole.radius ** 2),
    }

    if (opts.finish !== false) rec.steps.parallelFinish = await finishOn(ctx, c, part)
    rec.ok = true
  } catch (err) {
    rec.error = err instanceof Error ? err.message : String(err)
  } finally {
    for (const b of bodies) await ctx.engine.dispose(b).catch(() => undefined)
    for (const s of own) {
      try { k.release(s) } catch { /* already gone */ }
    }
  }
  return rec
}

/**
 * The kernel's own bsplineSurface on the same n x n samples (it FITS a surface
 * through them): build time, how far the fit strays from the plate plane,
 * and whether it sews into a valid solid of the right volume.
 */
export function measureFitRoute(ctx: BenchContext, c: BenchCase, n: number): RouteRecord {
  const k = ctx.kernel
  const rec: RouteRecord = { route: 'exact-fit', fixture: c.fixture, n, ok: false, steps: {} }
  const own: ShapeHandle[] = []
  try {
    const pts = reliefSurfacePoints(c.grid, n, c.origin, c.plate.z)
    let t0 = performance.now()
    const face = k.bsplineSurface(pts, n, n)
    own.push(face)
    rec.steps.fit = step(ctx, t0)
    const bb = k.getBoundingBox(face, false)
    let maxH = 0
    for (let i = 0; i < c.grid.heights.length; i++) maxH = Math.max(maxH, c.grid.heights[i])
    rec.notes = [`fitted face z ${(bb.zmin - c.plate.z).toFixed(3)} .. ${(bb.zmax - c.plate.z).toFixed(3)} mm over the face (heights 0 .. ${maxH.toFixed(3)}); x ${bb.xmin.toFixed(2)} .. ${bb.xmax.toFixed(2)}, y ${bb.ymin.toFixed(2)} .. ${bb.ymax.toFixed(2)}`]
    const plate = k.makeBox(c.plate.x, c.plate.y, c.plate.z)
    own.push(plate)
    t0 = performance.now()
    const sewn = sewReliefIntoSolid(k, plate, face, { origin: c.origin, baseZ: c.plate.z }, c.grid.widthMm * c.grid.depthMm, 1e-3)
    own.push(sewn.solid)
    rec.steps.splitSew = step(ctx, t0)
    rec.getVolumeErrorPct = pct(k.getVolume(sewn.solid) - plateVolume(c.plate), c.referenceVolume)
    const v = meshVolume(k.tessellate(sewn.solid, { linearDeflection: CAM_DEFLECTION_MM, angularDeflection: CAM_ANGULAR_DEFLECTION_RAD })) - plateVolume(c.plate)
    rec.reliefVolume = v
    rec.volumeErrorPct = pct(v, c.referenceVolume)
    rec.ok = true
  } catch (err) {
    rec.error = err instanceof Error ? err.message : String(err)
  } finally {
    for (const s of own) {
      try { k.release(s) } catch { /* already gone */ }
    }
  }
  return rec
}

/**
 * Route (a): the working grid as a closed triangle mesh -> through-hole cut
 * (manifold mesh boolean, the Mesh tools' route) -> Parallel Finish (3D) on
 * the mesh as it is.
 */
export async function measureMeshRoute(ctx: BenchContext, c: BenchCase, opts: { finish?: boolean } = {}): Promise<RouteRecord> {
  const rec: RouteRecord = { route: 'mesh', fixture: c.fixture, grid: { cols: c.grid.cols, rows: c.grid.rows }, ok: false, steps: {} }
  try {
    let t0 = performance.now()
    const body = reliefPlateMesh(c.grid, c.plate, c.origin)
    rec.steps.build = step(ctx, t0, { triangles: body.indices.length / 3 })
    const v = meshVolume(body) - plateVolume(c.plate)
    rec.reliefVolume = v
    rec.volumeErrorPct = pct(v, c.referenceVolume)

    const tool = cylinderMesh(c.hole.x, c.hole.y, c.hole.radius, -5, c.plate.z + 15, HOLE_SEGMENTS)
    t0 = performance.now()
    const cut = booleanMesh(ctx.manifold, body, tool, { operation: 'difference' })
    rec.steps.hole = step(ctx, t0, { triangles: cut.measures.triangleCount })
    const polyArea = (HOLE_SEGMENTS / 2) * c.hole.radius ** 2 * Math.sin((2 * Math.PI) / HOLE_SEGMENTS)
    rec.hole = { removed: v + plateVolume(c.plate) - cut.measures.signedVolume, expected: expectedHoleRemoval(c, polyArea) }

    t0 = performance.now()
    const part = toPartMesh(cut.mesh.positions, cut.mesh.indices)
    rec.steps.camMesh = step(ctx, t0, { triangles: part.indices.length / 3 })
    if (opts.finish !== false) rec.steps.parallelFinish = await finishOn(ctx, c, part)
    rec.ok = true
  } catch (err) {
    rec.error = err instanceof Error ? err.message : String(err)
  }
  return rec
}
