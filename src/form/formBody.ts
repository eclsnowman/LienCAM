// Form - the Model-history feature a finished form becomes, and the solid it
// replays into.
//
// Finish Form commits ONE feature node (opType 'form') whose payload is the
// cage itself - the parameters of the shape, the way an extrude's payload is
// its sketch reference and distance. Replaying the node builds a real body in
// the Model tree, beside the others:
//   - the EXACT solid (exactStep.ts): the limit surface as B-spline faces, read
//     in through the kernel's STEP import - fillets, chamfers, holes and shells
//     work on its own edges and faces, and a STEP export carries the surfaces;
//   - the FACETED solid, when the exact one cannot be built: the tessellated
//     limit surface (finish.ts), one planar face per triangle or flat region,
//     sewn by makeSolidFromPlanarFaces. Booleans, cuts and CAM take it too.

import type { SymmetryMode } from './symmetry'
import type { Cage, Vec3 } from './cage'
import { validateCage } from './halfEdge'
import { DEFAULT_CHORD_TOLERANCE_MM, tessellateForm, type FormTessellation } from './finish'
import { formStep } from './exactStep'
import type { BodyHandle, Diag, GeomService, OpResult, PlanarFaceSet } from '../geom/geom-service'

/**
 * The kernel sews every triangle into the solid, and sewing grows faster than
 * linearly (measured in this sandbox: 3,072 triangles ~0.8 s, 12,288 ~7.5 s).
 * A form body is refined until it meets its tolerance or this many triangles,
 * whichever comes first; the chord it actually reached is reported.
 */
export const FORM_BODY_MAX_TRIANGLES = 12_288

export interface FormFeaturePayload {
  opType: 'form'
  name: string
  cage: Cage
  /** requested chord tolerance, mm */
  tolerance: number
  /** the symmetry the form was edited with (a mirror, or `c<N>` circular), restored when it is edited again */
  symmetry?: SymmetryMode
  /** where the mirror plane sits along its normal (n . p = symmetryAt) */
  symmetryAt?: number
  /** a placed mirror plane's unit normal (symmetry 'p') */
  symmetryNormal?: Vec3
}

export function isFormFeaturePayload(payload: Record<string, unknown>): payload is FormFeaturePayload & Record<string, unknown> {
  const cage = payload.cage as Cage | undefined
  return payload.opType === 'form'
    && typeof cage === 'object' && cage !== null
    && Array.isArray(cage.positions) && Array.isArray(cage.faces) && Array.isArray(cage.creases)
}

export function makeFormFeaturePayload(name: string, cage: Cage, tolerance = DEFAULT_CHORD_TOLERANCE_MM, symmetry: SymmetryMode | null = null, symmetryAt = 0, symmetryNormal: Vec3 | null = null): FormFeaturePayload {
  return {
    opType: 'form',
    name,
    cage: { positions: cage.positions.map((p) => [p[0], p[1], p[2]]), faces: cage.faces.map((f) => f.slice()), creases: cage.creases.slice(), ...(cage.weights !== undefined ? { weights: { ...cage.weights } } : {}) },
    tolerance,
    ...(symmetry !== null ? { symmetry } : {}),
    ...(symmetry !== null && symmetryAt !== 0 ? { symmetryAt } : {}),
    ...(symmetry === 'p' && symmetryNormal !== null ? { symmetryNormal: [symmetryNormal[0], symmetryNormal[1], symmetryNormal[2]] as Vec3 } : {}),
  }
}

/** Refinement steps before the exact patches are built (the patches near an extraordinary point shrink with each). */
export const FORM_EXACT_LEVELS = 3

type FormKernel = Pick<GeomService, 'importStep' | 'makeSolidFromPlanarFaces' | 'measure' | 'dispose'>

/**
 * The body a form feature replays into: the exact solid, or the faceted one
 * when the exact one cannot be built (an info diagnostic says which, and why).
 */
export async function buildFormBody(kernel: FormKernel, payload: FormFeaturePayload, featureId: string): Promise<OpResult> {
  let why: string
  try {
    const step = formStep(payload.cage, payload.name, FORM_EXACT_LEVELS)
    const imported = await kernel.importStep(new TextEncoder().encode(step.text).buffer as ArrayBuffer, featureId)
    const [body, ...extra] = imported.bodies
    for (const b of extra) await kernel.dispose(b.handle).catch(() => undefined)
    if (body === undefined || extra.length > 0) {
      why = `the exact surface read back as ${imported.bodies.length} bodies`
      if (body !== undefined) await kernel.dispose(body.handle).catch(() => undefined)
    } else {
      // a gross failure (a face turned inside out, a gap) shows in the volume: against a
      // coarse tessellation of the limit surface (0.2 mm chord: within ~2%, in milliseconds)
      const volume = (await kernel.measure(body.handle, 'volume')).value
      const t = tessellateForm(payload.cage, 0.2, 50_000)
      const expected = meshVolume(t.positions, t.indices)
      if (expected > 0 && Math.abs(volume - expected) <= 0.05 * expected) {
        const diagnostics: Diag[] = [...imported.diagnostics, { code: 'OK', severity: 'info', params: { surface: 'exact', faces: step.bsplineFaces + step.planarFaces, exactPatches: step.exactPatches, patches: step.patches } }]
        return { ok: true, body: body.handle as BodyHandle, elementMap: body.elementMap, diagnostics }
      }
      why = `the exact solid's volume ${volume.toFixed(3)} mm^3 is not the surface's ${expected.toFixed(3)} mm^3`
      await kernel.dispose(body.handle).catch(() => undefined)
    }
  } catch (e) {
    why = (e instanceof Error ? e.message : String(e)).slice(0, 200)
  }
  const faces = formFaceSet(payload, featureId)
  if (!faces.ok) return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { reason: faces.reason } }] }
  const built = await kernel.makeSolidFromPlanarFaces(faces.faceSet)
  return { ...built, diagnostics: [...built.diagnostics, { code: 'OK', severity: 'info', params: { surface: 'faceted', reason: why } }] }
}

/** Signed volume of a closed triangle mesh (divergence theorem). */
function meshVolume(P: Float64Array, I: Uint32Array): number {
  let v = 0
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6
  }
  return v
}

export type FormFaceSetResult =
  | { ok: true; faceSet: PlanarFaceSet; tessellation: FormTessellation }
  | { ok: false; reason: string }

/** The triangles of a form's limit surface as the kernel's planar face set. */
export function formFaceSet(payload: FormFeaturePayload, convertId: string, maxTriangles = FORM_BODY_MAX_TRIANGLES): FormFaceSetResult {
  const check = validateCage(payload.cage, true)
  if (!check.ok) {
    return { ok: false, reason: `form "${payload.name}" is not a closed cage: ${check.problems[0]}` }
  }
  const t = tessellateForm(payload.cage, payload.tolerance, maxTriangles)
  const P = t.positions
  const pt = (i: number) => ({ x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2] })
  const faces: PlanarFaceSet['faces'] = []
  const pushFace = (ring: Array<{ x: number; y: number; z: number }>) => {
    const [A, B, C] = ring
    const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z
    const vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz)
    const ul = Math.hypot(ux, uy, uz)
    // a sliver the limit surface can collapse (a point pulled onto a line) carries no area: skip it
    if (!(nl > 1e-12) || !(ul > 1e-12)) return
    faces.push({
      plane: { origin: A, normal: { x: nx / nl, y: ny / nl, z: nz / nl }, xDir: { x: ux / ul, y: uy / ul, z: uz / ul } },
      outer: ring,
      holes: [],
      confidence: 1,
    })
  }
  for (const ring of faceRings(P, t.indices)) pushFace(ring.map(pt))
  return { ok: true, faceSet: { convertId, planarTolerance: 1e-4, faces }, tessellation: t }
}

/**
 * The faces a tessellation goes to the kernel as, each a loop of vertex
 * indices. A flat region of the surface (a creased flat bottom, a planar side)
 * is ONE face: the Model tools then see the plane the operator sees - a Hole
 * or a sketch lands on it, a fillet runs along its rim - and there are fewer
 * faces to sew. Everything else is a triangle, a flat quad one face (two
 * triangles of a flat quad can share the same bounding box, which leaves the
 * kernel no way to tell them apart).
 */
export function faceRings(P: Float64Array | Float32Array | number[], indices: Uint32Array | number[]): number[][] {
  const pt = (i: number) => ({ x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2] })
  const triCount = Math.floor(indices.length / 3)
  const tri = (n: number) => [indices[n * 3], indices[n * 3 + 1], indices[n * 3 + 2]]
  const regions = planarRegions(P, indices)
  const merged = new Set<number>()
  for (const ring of regions) for (const n of ring.triangles) merged.add(n)
  // A straight run of a merged face's rim is one edge to the kernel: a point
  // in the middle of it is dropped (the sew fails on it otherwise) - but only
  // where every face meeting at that point drops it too, else it would leave
  // a T-junction against a face that keeps it.
  const keepPoint = new Set<number>()
  for (let n = 0; n < triCount; n++) if (!merged.has(n)) for (const p of tri(n)) keepPoint.add(p)
  for (const ring of regions) {
    ring.loop.forEach((p, i) => {
      const a = ring.loop[(i + ring.loop.length - 1) % ring.loop.length], b = ring.loop[(i + 1) % ring.loop.length]
      if (!isCollinear(pt(a), pt(p), pt(b))) keepPoint.add(p)
    })
  }
  const rings = regions.map((ring) => ring.loop.filter((p) => keepPoint.has(p)))
  // the tessellation emits each quad as two consecutive triangles
  for (let n = 0; n < triCount; n += 2) {
    const tri1 = tri(n)
    const tri2 = n + 1 < triCount ? tri(n + 1) : null
    const quad = tri2 !== null && !merged.has(n) && !merged.has(n + 1) ? quadOf(tri1, tri2) : null
    if (quad !== null && isFlat(quad.map(pt))) {
      rings.push(quad)
      continue
    }
    if (!merged.has(n)) rings.push(tri1)
    if (tri2 !== null && !merged.has(n + 1)) rings.push(tri2)
  }
  return rings
}

export interface PlanarRegion {
  /** boundary points (vertex indices) in the triangles' own winding */
  loop: number[]
  /** the triangles (index / 3) the region replaces */
  triangles: number[]
}

/**
 * Connected groups of two or more edge-adjacent triangles lying on one plane,
 * each with its single boundary loop. A group whose boundary is not one simple
 * loop (a flat ring around a bump, a pinch at a point) is left as triangles -
 * still a valid solid, just not merged.
 */
export function planarRegions(P: Float64Array | Float32Array | number[], indices: Uint32Array | number[]): PlanarRegion[] {
  const triCount = Math.floor(indices.length / 3)
  const v = (i: number) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]
  const normal: Array<[number, number, number] | null> = []
  let extent = 0
  for (let i = 0; i < P.length; i++) extent = Math.max(extent, Math.abs(P[i]))
  const tol = 1e-9 * Math.max(1, extent)
  for (let t = 0; t < triCount; t++) {
    const a = v(indices[t * 3]), b = v(indices[t * 3 + 1]), c = v(indices[t * 3 + 2])
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2]
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    const l = Math.hypot(nx, ny, nz)
    normal.push(l > 1e-12 ? [nx / l, ny / l, nz / l] : null)
  }
  // edge -> the triangles on it
  const byEdge = new Map<string, number[]>()
  const ek = (x: number, y: number) => (x < y ? `${x}:${y}` : `${y}:${x}`)
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const key = ek(indices[t * 3 + k], indices[t * 3 + (k + 1) % 3])
      const list = byEdge.get(key)
      if (list) list.push(t)
      else byEdge.set(key, [t])
    }
  }
  const coplanar = (s: number, t: number) => {
    const n = normal[s], m = normal[t]
    if (n === null || m === null || n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 1 - 1e-12) return false
    const o = v(indices[s * 3])
    for (let k = 0; k < 3; k++) {
      const q = v(indices[t * 3 + k])
      if (Math.abs((q[0] - o[0]) * n[0] + (q[1] - o[1]) * n[1] + (q[2] - o[2]) * n[2]) > tol) return false
    }
    return true
  }
  const group = new Int32Array(triCount).fill(-1)
  const out: PlanarRegion[] = []
  for (let seed = 0; seed < triCount; seed++) {
    if (group[seed] >= 0 || normal[seed] === null) continue
    const members = [seed]
    group[seed] = seed
    for (let h = 0; h < members.length; h++) {
      const t = members[h]
      for (let k = 0; k < 3; k++) {
        for (const u of byEdge.get(ek(indices[t * 3 + k], indices[t * 3 + (k + 1) % 3])) ?? []) {
          if (group[u] < 0 && coplanar(seed, u)) { group[u] = seed; members.push(u) }
        }
      }
    }
    if (members.length < 2) continue
    // boundary half-edges: a directed triangle edge whose edge no other member
    // shares. A rim that is not one simple loop (a hole, a pinch at a point)
    // does not walk back to its start through every half-edge.
    const next = new Map<number, number>()
    let simple = true
    for (const t of members) {
      for (let k = 0; k < 3; k++) {
        const a = indices[t * 3 + k], b = indices[t * 3 + (k + 1) % 3]
        const inside = (byEdge.get(ek(a, b)) ?? []).filter((u) => group[u] === seed).length
        if (inside !== 1) continue
        next.set(a, b)
      }
    }
    if (next.size < 3) continue
    const start = next.keys().next().value as number
    const loop = [start]
    for (let p = next.get(start)!; p !== start; p = next.get(p)!) {
      if (p === undefined || loop.length > next.size) { simple = false; break }
      loop.push(p)
    }
    if (!simple || loop.length !== next.size) continue
    out.push({ loop, triangles: members })
  }
  return out
}

type P3 = { x: number; y: number; z: number }

/** b lies on the straight line a -> c (within 1e-9 of the run's length), between them. */
function isCollinear(a: P3, b: P3, c: P3): boolean {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z
  const len = Math.hypot(vx, vy, vz)
  if (!(len > 1e-12)) return false
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
  const along = (ux * vx + uy * vy + uz * vz) / len
  return Math.hypot(cx, cy, cz) / len <= 1e-9 * Math.max(1, len) && along > 0 && along < len
}

/** The quad two triangles of one split make (they share exactly one edge), in loop order; null otherwise. */
function quadOf(t1: number[], t2: number[]): number[] | null {
  const shared = t1.filter((v) => t2.includes(v))
  if (shared.length !== 2) return null
  const lone1 = t1.find((v) => !shared.includes(v))!
  const lone2 = t2.find((v) => !shared.includes(v))!
  // walk t1 from its lone point: lone1 -> s1 -> s2 (t1's own orientation), then t2's lone point sits between s2 and lone1
  const k = t1.indexOf(lone1)
  const s1 = t1[(k + 1) % 3], s2 = t1[(k + 2) % 3]
  return [lone1, s1, lone2, s2]
}

/** All points on one plane within 1e-9 of the quad's size. */
function isFlat(ring: P3[]): boolean {
  const [A, B, C, D] = ring
  const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z
  const vx = D.x - A.x, vy = D.y - A.y, vz = D.z - A.z
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const nl = Math.hypot(nx, ny, nz)
  if (!(nl > 1e-12)) return false
  const size = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz))
  const off = Math.abs((C.x - A.x) * nx + (C.y - A.y) * ny + (C.z - A.z) * nz) / nl
  return off <= 1e-9 * Math.max(1, size)
}
