/**
 * MSH-3 — Prismatic mesh -> B-rep bridge (geom side).
 * ==========================================================================
 * Implements the frozen GeomService contract's v0.4 makeSolidFromPlanarFaces
 * (see src/geom/geom-service.ts PlanarFaceSet). The mesh lane's prismatic
 * converter (src/mesh/prismatic.ts) hands over a PlanarFaceSet — each face a
 * closed outer polygon plus holes on its own plane, vertices in model mm — and
 * this rebuilds every face, sews them into a single solid, and returns a
 * standard OpResult with import-rooted stable ids (CNVn:face#i grammar).
 *
 * OWNERSHIP: this is MSH-3's ONE new file on the GEO side (WO ruling 1). It
 * takes the kernel + the engine's release-safe helpers via `deps` so it adds no
 * new field or dependency to GeomEngine — the engine method is a 5-line
 * delegator (its "minimum registration lines").
 *
 * WASM-HANDLE LIFECYCLE (standing acceptance #9): every edge/wire/face handle
 * built here is pushed to `scratch` and released in a finally on BOTH the
 * success and error paths (GEO-1-R1.3 precedent). The sewn solid is released
 * too UNLESS it was minted into a body record (after which the record owns it).
 */
import type { OcctKernel, ShapeHandle } from 'occt-wasm'
import type {
  BodyHandle,
  Diag,
  GeometrySnapshot as ContractGeometrySnapshot,
  OpResult,
  PlanarFaceSet,
  StableId,
  Vec3 as GVec3,
} from '../geom-service.ts'
import type { BodyRecord, FaceProbe, GeometrySnapshot } from './internal-types.ts'

/** Everything prismaticBuild needs from the engine, passed as closures so this
 *  file never reaches into GeomEngine's private state directly. */
export interface PrismaticDeps {
  k(): OcctKernel
  mint(rec: BodyRecord): BodyHandle
  faceProbes(shape: ShapeHandle): FaceProbe[]
  toContractGeom(snap: GeometrySnapshot): ContractGeometrySnapshot
}

function toKPoint(v: GVec3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z }
}

/** Build a closed wire from a loop of points (implicitly closed: last->first). */
function buildLoopWire(k: OcctKernel, loop: GVec3[], scratch: ShapeHandle[]): ShapeHandle {
  if (loop.length < 3) throw new Error(`prismatic face loop has only ${loop.length} point(s); need >= 3`)
  const edges: ShapeHandle[] = []
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    const e = k.makeLineEdge(toKPoint(a), toKPoint(b))
    scratch.push(e)
    edges.push(e)
  }
  const wire = k.makeWire(edges)
  scratch.push(wire)
  return wire
}

/** Build a planar face (outer ring + holes) from one PlanarFaceSet face. */
function buildFace(k: OcctKernel, face: PlanarFaceSet['faces'][number], scratch: ShapeHandle[]): ShapeHandle {
  const outerWire = buildLoopWire(k, face.outer, scratch)
  let f = k.makeFace(outerWire)
  scratch.push(f)
  if (face.holes.length > 0) {
    const holeWires = face.holes.map((h) => buildLoopWire(k, h, scratch))
    const holed = k.addHolesInFace(f, holeWires)
    scratch.push(holed)
    f = holed
  }
  return f
}

function centroidOf(points: GVec3[]): [number, number, number] {
  let x = 0, y = 0, z = 0
  for (const p of points) { x += p.x; y += p.y; z += p.z }
  const n = Math.max(1, points.length)
  return [x / n, y / n, z / n]
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

export type FaceMatchResult =
  | { ok: true; faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>; generated: StableId[] }
  | { ok: false; duplicateInputFaceIndex: number }
  | { ok: false; unmatchedInputFaceIndices: number[]; probeCount: number; expectedFaceCount: number }

/**
 * Assign import-rooted stable ids by matching each sewn face back to its
 * originating input face (nearest centroid). Deterministic: input-face order
 * roots the ids; the match is geometric, never kernel enumeration order.
 *
 * MSH-3-R1.3: if two sewn faces nearest-match the SAME input face, a
 * deterministic identity cannot be assigned. The stable-ID spec forbids
 * silent guessing in that case (no `.dup` off-grammar suffix) -- the caller
 * refuses instead, naming the contested input face index. Exported standalone
 * so the matching/dup-detection logic is unit-testable without spinning up a
 * real kernel.
 *
 * MSH-4 rider (a) / MSH-3-R1.audit finding 2: the duplicate check above only
 * catches TOO MANY probes landing on one input face. It did not catch the
 * opposite non-bijective case -- the kernel returning FEWER face probes than
 * input faces (e.g. a sew silently merged or dropped a face) -- which used to
 * fall through to `ok: true` with a PARTIAL faceMap covering only some
 * `CNVn:face#i` inputs, silently dropping import-rooted lineage for the rest.
 * After the match loop completes cleanly (no duplicates), verify the map is
 * a COMPLETE bijection: every input face index must have been claimed by
 * exactly one probe. If not, refuse and name every unmatched input face
 * index -- same no-silent-guessing posture as the duplicate case, just the
 * other direction of the same bijectivity requirement.
 */
export function matchProbesToInputFaces(
  probes: FaceProbe[],
  inputCentroids: Array<[number, number, number]>,
  convertId: string,
): FaceMatchResult {
  const usedBase = new Set<number>()
  const faceMap = new Map<number, StableId>()
  const snapshots = new Map<StableId, GeometrySnapshot>()
  const generated: StableId[] = []
  for (const probe of probes) {
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < inputCentroids.length; i++) {
      const d = dist3(probe.snapshot.centroid, inputCentroids[i])
      if (d < bestDist) { bestDist = d; best = i }
    }
    if (usedBase.has(best)) {
      return { ok: false, duplicateInputFaceIndex: best }
    }
    usedBase.add(best)
    const id: StableId = `${convertId}:face#${best}`
    faceMap.set(probe.hash, id)
    snapshots.set(id, probe.snapshot)
    generated.push(id)
  }
  if (usedBase.size !== inputCentroids.length) {
    const unmatchedInputFaceIndices: number[] = []
    for (let i = 0; i < inputCentroids.length; i++) {
      if (!usedBase.has(i)) unmatchedInputFaceIndices.push(i)
    }
    return { ok: false, unmatchedInputFaceIndices, probeCount: probes.length, expectedFaceCount: inputCentroids.length }
  }
  return { ok: true, faceMap, snapshots, generated }
}

export async function buildSolidFromPlanarFaces(deps: PrismaticDeps, req: PlanarFaceSet): Promise<OpResult> {
  const k = deps.k()
  const convertId = req.convertId || 'CNV1'
  const tol = req.planarTolerance > 0 ? req.planarTolerance : 1e-6
  const scratch: ShapeHandle[] = []
  let solid: ShapeHandle | null = null
  let minted = false

  const sewFailed = (reason: string): OpResult => ({
    ok: false,
    diagnostics: [{ code: 'SEW_FAILED', severity: 'error', params: { convertId, reason } }],
  })

  try {
    if (req.faces.length < 4) {
      return sewFailed(`a closed solid needs at least 4 planar faces; got ${req.faces.length}`)
    }

    const faceHandles: ShapeHandle[] = []
    for (const face of req.faces) faceHandles.push(buildFace(k, face, scratch))

    // Sew the faces into a shell and solidify. sewAndSolidify returns an
    // independent shape; the input face handles stay caller-owned (released via
    // scratch in the finally).
    const built = k.sewAndSolidify(faceHandles, tol)
    solid = built

    if (!k.isSolid(built) || !k.isValid(built)) {
      // Not minted -> released by the finally below.
      return sewFailed('the planar faces did not sew into a valid closed solid (open/self-intersecting boundary?)')
    }

    // Assign import-rooted stable ids by matching each sewn face back to its
    // originating input face (nearest centroid). Deterministic: input-face
    // order roots the ids; the match is geometric, never kernel enumeration
    // order.
    const probes = deps.faceProbes(built)
    const inputCentroids = req.faces.map((f) => centroidOf(f.outer))
    const match = matchProbesToInputFaces(probes, inputCentroids, convertId)
    if (!match.ok) {
      // No silent guessing (stable-ID spec): a duplicate nearest-face match
      // means identity cannot be deterministically assigned. Refuse rather
      // than mint an off-grammar `.dup` id -- not minted, so the finally
      // below releases `solid` via scratch.
      if ('unmatchedInputFaceIndices' in match) {
        return sewFailed(
          `kernel returned ${match.probeCount} face probe(s) for ${match.expectedFaceCount} input face(s) -- ` +
            `a partial, non-bijective match; unmatched input face indices: ${match.unmatchedInputFaceIndices.join(', ')}`,
        )
      }
      return sewFailed(
        `two sewn faces both nearest-matched input face #${match.duplicateInputFaceIndex}; a stable id cannot be deterministically assigned (duplicate face match)`,
      )
    }
    const { faceMap, snapshots, generated } = match
    generated.sort()

    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const [id, snap] of snapshots) geometry[id] = deps.toContractGeom(snap)

    const handle = deps.mint({ shape: built as number, faceMap, snapshots })
    minted = true

    // Confidence is carried into diagnostics only (contract: does not affect
    // geometry). One info diag with the aggregate + a warning per low-confidence
    // face so the UI can flag faces the mesh side was unsure about.
    const confidences = req.faces.map((f) => f.confidence)
    const minConfidence = confidences.reduce((m, c) => Math.min(m, c), 1)
    const diagnostics: Diag[] = [
      {
        code: 'OK',
        severity: 'info',
        params: {
          convertId,
          faceCount: req.faces.length,
          minConfidence: Math.round(minConfidence * 1e6) / 1e6,
        },
      },
    ]
    req.faces.forEach((f, i) => {
      if (f.confidence < 0.5) {
        diagnostics.push({
          code: 'REFERENCE_FALLBACK',
          severity: 'warning',
          params: { face: `${convertId}:face#${i}`, confidence: Math.round(f.confidence * 1e6) / 1e6 },
        })
      }
    })

    return {
      ok: true,
      body: handle,
      elementMap: { featureId: convertId, modified: {}, generated, deleted: [], geometry },
      diagnostics,
    }
  } catch (e) {
    return sewFailed((e instanceof Error ? e.message : String(e)).slice(0, 200))
  } finally {
    for (const s of scratch) {
      try { k.release(s) } catch { /* already released */ }
    }
    if (solid !== null && !minted) {
      try { k.release(solid) } catch { /* already released */ }
    }
  }
}
