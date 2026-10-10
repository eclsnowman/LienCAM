// GEO-22 / GEO-22B blind-hole render-truth regression (real occt-wasm kernel).
//
// HISTORY (GEO-22, characterization only): the original round was an
// INVESTIGATION harness (no product edits) that reproduced Operator's hands-on
// finding "blind holes render as through-holes" (2026-07-17,
// coordination/findings/OPERATOR-FINDINGS-2026-07-17-blind-holes-render-through.md;
// three screenshots in coordination/inbox/T-UI70-OVERLAY-RESTYLE/) and pinned,
// with NUMBERS, which layer told the truth: KERNEL geometry correct (blind cut
// bounded to depth, real planar floor at z = top - depth); TESSELLATION did not
// drop or cull the floor; the DEFECT was a tessellation NORMAL-ORIENTATION bug.
// That round carried an `it.fails` DEFECT sentinel.
//
// CURRENT (GEO-22B, this is a FIXED regression): geom-engine.ts tessellate()
// now negates the per-vertex SHADING normal ONLY on TopAbs_REVERSED faces
// (k.shapeOrientation(face) === 'reversed'), so a reversed face's shading normal
// agrees with its already-correct winding/outward normal. The `it.fails` sentinel
// was promoted to a plain `it` (the primary gate at "FIX (tessellation
// orientation)"). GEO-22B-R1 (this rework) HARDENS the census: it proves the
// fix's TRANSFORM with ORIENTATION as the assertion axis -- forward faces are
// byte-identical pre/post, reversed faces are exactly negated -- and adds
// direct-kernel enclosed-cavity and hollow-shell probes. See the block comment on
// the "ORIENTATION-TRANSFORM census" test for why orientation, not geometric face
// class, is the truth.
//
// The root-cause mechanism, unchanged: occt-wasm meshShape emits per-vertex
// SHADING normals as the raw surface normal WITHOUT applying the face's TopAbs
// orientation. For a TopAbs_REVERSED face the winding (index order) is already
// orientation-corrected -- so culling is right (THREE.FrontSide keeps the floor) --
// but the shading normal points INTO the solid, opposite the outward/winding
// normal. Under the all-above workbench light rig (sceneRuntime.ts hemisphere sky
// +Z + key/fill/rim all above; verified 1813-1824) an upward-facing REVERSED
// planar face (a blind-hole/pocket floor, the plate bottom) shades near-black and
// reads as a see-through void -- Operator's symptom. geom-engine.ts tessellate() is
// the single source of truth: viewport3d/tessGeometry.ts buildBufferGeometry
// wraps the normal buffer verbatim.
//
// Real occt-wasm kernel in Node (same harness as hole.test.ts / editfeature.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { HoleRequest, Vec3, BodyHandle, StableId, TessBuffers, FeatureVerdict } from '../../geom/geom-service.ts'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
// GEO-23 L5 / preflight A4-3b: derive the workbench rig this test models from the
// SAME builder the live runtime (sceneRuntime.ts) uses, over the SAME shared rig
// descriptors -- so litResponse() can never assert against a stale lighting rig.
import { buildWorkbenchRig } from '../../lib/viewport/lighting/workbenchRig.ts'
import {
  WORKBENCH_ACCENT_LIGHTS, WORKBENCH_HEMISPHERE,
  WORKBENCH_KEY_COLOR, WORKBENCH_FILL_COLOR, WORKBENCH_RIM_COLOR,
} from '../../lib/viewport/lighting/rigDescriptors.ts'
import * as THREE from 'three'

// Plate from Operator's screenshots' proportions (thin plate, partial-depth hole).
const PLATE = { x: 120, y: 80, z: 20 }
const TOP: StableId = 'F1:BOX:zMax' as StableId
const CENTER: Vec3 = { x: 60, y: 40, z: 20 } // on the top face (z = zMax)
const DIA = 25
const DEPTH = 6 // strictly < plate thickness (20) => genuinely BLIND
const PI = Math.PI

// occt-wasm per-face mesh options the product tessellate() loop uses, mirrored
// here so a raw-kernel meshShape of the SAME face is byte-for-byte what the
// product loop consumed (geom-engine.ts builds opts = { linearDeflection:
// deflection, angularDeflection }). DEFLECTION/ANGULAR match the tessellate()
// calls below (0.08 / 0.35).
const MESH_OPTS = { linearDeflection: 0.08, angularDeflection: 0.35 }

// GEO-23 L5: the workbench CAD rig is NO LONGER hand-mirrored here (it used to be
// a frozen copy of sceneRuntime.ts's LIGHTS + HEMI_INTENSITY, which silently went
// stale the instant the rig was retuned). Both the live runtime and this test now
// build the rig from buildWorkbenchRig() over the shared rig descriptors, so the
// numbers below track the runtime automatically. The RIG SYNC test (preflight
// A4-3b) proves the builder faithfully reflects the descriptors.
const RIG = buildWorkbenchRig()
const LIGHTS = RIG.accents.map((l) => ({
  name: l.name,
  pos: [l.position.x, l.position.y, l.position.z] as const,
  intensity: l.intensity,
}))
const HEMI_INTENSITY = RIG.hemisphere.intensity // sky (bright) at +Z, ground (dark) at -Z
// Ground-term luminance from the rig's actual ground colour (was a hardcoded
// 0.18). THREE stores colours linear; the channel mean is enough for this
// floor-check model.
const GROUND_LUM = (RIG.hemisphere.groundColor.r + RIG.hemisphere.groundColor.g + RIG.hemisphere.groundColor.b) / 3

/** Lambert diffuse + hemisphere irradiance for a unit normal under the STATIC
 *  accent rig above. A minimal model of MeshStandardMaterial's response to N --
 *  enough to show the floor's inverted normal collapses its lit response toward
 *  zero. It DELIBERATELY models only the static accents + hemisphere: it does NOT
 *  model GEO-23's L1 IBL base (a PMREM texture has no closed form) or the L2
 *  view-dependent headlight (a function of live camera state). Those carry the
 *  full "lit from every orientation" claim, which is G1's real-GPU pixel job, not
 *  this Node approximation's -- here litResponse only checks that the accent rig
 *  alone still puts the corrected floor normal in a sane range vs the top face. */
function litResponse(n: readonly [number, number, number]): number {
  let d = 0
  for (const l of LIGHTS) {
    const m = Math.hypot(l.pos[0], l.pos[1], l.pos[2])
    const L: [number, number, number] = [l.pos[0] / m, l.pos[1] / m, l.pos[2] / m]
    d += l.intensity * Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2])
  }
  // Hemisphere: sky weight = 0.5*(dot(N,+Z)+1); ground weight = 1 - that.
  const sky = 0.5 * (n[2] + 1)
  d += HEMI_INTENSITY * (sky * 1.0 + (1 - sky) * GROUND_LUM)
  return d
}

interface TriStats {
  count: number
  windingNormalZ: number // mean unit winding (index-order) normal Z: +Z faces up
  shading: [number, number, number] // mean stored per-vertex normal (shading only)
  meanZ: number // mean vertex z of the face's triangles (where the face sits)
}

/** Aggregate the triangles of one tessellated face: winding normal (culling),
 *  shading normal (lighting), and mean z. */
function faceTriStats(t: TessBuffers, faceIndex: number): TriStats {
  const pos = t.position, nrm = t.normal, idx = t.index, triFace = t.triFace
  let wx = 0, wy = 0, wz = 0
  let snx = 0, sny = 0, snz = 0, zsum = 0, vcount = 0
  let count = 0
  for (let tri = 0; tri < triFace.length; tri++) {
    if (triFace[tri] !== faceIndex) continue
    count++
    const a = idx[tri * 3], b = idx[tri * 3 + 1], c = idx[tri * 3 + 2]
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2]
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2]
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2]
    // right-hand winding normal = (B-A) x (C-A); magnitude = 2*area (area-weighted).
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    wx += uy * vz - uz * vy
    wy += uz * vx - ux * vz
    wz += ux * vy - uy * vx
    for (const vi of [a, b, c]) {
      snx += nrm[vi * 3]; sny += nrm[vi * 3 + 1]; snz += nrm[vi * 3 + 2]
      zsum += pos[vi * 3 + 2]
      vcount++
    }
  }
  const wmag = Math.hypot(wx, wy, wz) || 1
  const smag = Math.hypot(snx, sny, snz) || 1
  return {
    count,
    windingNormalZ: wz / wmag,
    shading: [snx / smag, sny / smag, snz / smag],
    meanZ: zsum / (vcount || 1),
  }
}

function faceIndicesWhere(t: TessBuffers, pred: (id: string) => boolean): number[] {
  const out: number[] = []
  t.faceIds.forEach((id, i) => { if (pred(String(id))) out.push(i) })
  return out
}

interface FaceDot {
  count: number
  minDot: number // min over all triangle/vertex pairs of dot(unit shading, unit winding)
  meanWindingZ: number
}

/** FULL-VECTOR agreement census for one tessellated face. For every triangle,
 *  take the right-hand winding (index-order) normal -- what THREE culls on and
 *  the outward direction after orientation correction -- and dot it (as a unit
 *  3-vector) with each of the triangle's three stored per-vertex SHADING normals
 *  (what THREE lights on). Returns the MINIMUM dot across the whole face.
 *  minDot > 0 <=> shading agrees with winding as full 3D vectors on every
 *  triangle. This judges vertical/radial faces (side walls, hole cylinders),
 *  which a Z-sign-only `agree` flag could not; NaN>0 is false, so a
 *  missing/degenerate face fails closed. */
function faceDotStats(t: TessBuffers, faceIndex: number): FaceDot {
  const pos = t.position, nrm = t.normal, idx = t.index, triFace = t.triFace
  let count = 0, minDot = Infinity, wzSum = 0
  for (let tri = 0; tri < triFace.length; tri++) {
    if (triFace[tri] !== faceIndex) continue
    const a = idx[tri * 3], b = idx[tri * 3 + 1], c = idx[tri * 3 + 2]
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2]
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2]
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2]
    let wx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
    let wy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
    let wz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    const wmag = Math.hypot(wx, wy, wz)
    if (wmag < 1e-12) continue // degenerate sliver: no meaningful winding normal
    wx /= wmag; wy /= wmag; wz /= wmag
    count++
    wzSum += wz
    for (const vi of [a, b, c]) {
      let nx = nrm[vi * 3], ny = nrm[vi * 3 + 1], nz = nrm[vi * 3 + 2]
      const nmag = Math.hypot(nx, ny, nz) || 1
      nx /= nmag; ny /= nmag; nz /= nmag
      const dot = nx * wx + ny * wy + nz * wz
      if (dot < minDot) minDot = dot
    }
  }
  return { count, minDot: count ? minDot : NaN, meanWindingZ: count ? wzSum / count : NaN }
}

// ---- direct-kernel probe helpers (GEO-22B-R1) --------------------------------

interface Vert { pos: [number, number, number]; nrm: [number, number, number] }

/** Exact position key. Engine tessellate positions and raw kernel meshShape
 *  positions are the SAME Float32 bits (engine.makeBox is exactly k.makeBox with
 *  no heal, so per-face meshShape is deterministic across the two shapes), so
 *  keying on the raw doubles matches byte-for-byte. */
function posKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`
}

/** Collect one engine tessellated face's per-vertex position+shading normal. */
function engineFaceVerts(t: TessBuffers, faceIndex: number): Vert[] {
  const out: Vert[] = []
  const seen = new Set<number>()
  for (let tri = 0; tri < t.triFace.length; tri++) {
    if (t.triFace[tri] !== faceIndex) continue
    for (let k = 0; k < 3; k++) {
      const vi = t.index[tri * 3 + k]
      if (seen.has(vi)) continue
      seen.add(vi)
      out.push({
        pos: [t.position[vi * 3], t.position[vi * 3 + 1], t.position[vi * 3 + 2]],
        nrm: [t.normal[vi * 3], t.normal[vi * 3 + 1], t.normal[vi * 3 + 2]],
      })
    }
  }
  return out
}

function centroidOf(verts: Vert[]): [number, number, number] {
  let x = 0, y = 0, z = 0
  for (const v of verts) { x += v.pos[0]; y += v.pos[1]; z += v.pos[2] }
  const n = verts.length || 1
  return [x / n, y / n, z / n]
}

interface OrientProbe {
  orientCounts: Record<string, number>
  worstDot: number // min dot(production post-fix normal, winding) over all faces
  faceCount: number
  reversedFaces: number
  triCount: number
}

/** Direct-kernel orientation probe reproducing the auditor's method. For every
 *  face of `solid`: record shapeOrientation; mesh it; apply the PRODUCTION rule
 *  (negate the per-vertex normal iff the face is TopAbs_REVERSED, exactly as
 *  geom-engine.ts tessellate() does); and dot that post-fix normal against the
 *  triangle's right-hand winding normal. A valid solid boundary must return
 *  worstDot > 0 (production rule orients every face outward) and must emit ONLY
 *  forward/reversed faces (never internal/external), which is why the binary
 *  reversed-guard in the fix is complete for sampled solids. */
function probeSolidOrientation(k: OcctKernel, solid: ShapeHandle): OrientProbe {
  const faces = k.getSubShapes(solid, 'face')
  const orientCounts: Record<string, number> = {}
  let worstDot = Infinity, faceCount = 0, reversedFaces = 0, triCount = 0
  try {
    for (const f of faces) {
      const orientation = String(k.shapeOrientation(f))
      orientCounts[orientation] = (orientCounts[orientation] ?? 0) + 1
      const reversed = orientation === 'reversed'
      if (reversed) reversedFaces++
      const m = k.meshShape(f, MESH_OPTS)
      faceCount++
      for (let t = 0; t < m.indices.length; t += 3) {
        const a = m.indices[t], b = m.indices[t + 1], c = m.indices[t + 2]
        const ax = m.positions[a * 3], ay = m.positions[a * 3 + 1], az = m.positions[a * 3 + 2]
        const bx = m.positions[b * 3], by = m.positions[b * 3 + 1], bz = m.positions[b * 3 + 2]
        const cx = m.positions[c * 3], cy = m.positions[c * 3 + 1], cz = m.positions[c * 3 + 2]
        let wx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
        let wy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
        let wz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        const wmag = Math.hypot(wx, wy, wz)
        if (wmag < 1e-12) continue
        wx /= wmag; wy /= wmag; wz /= wmag
        triCount++
        for (const vi of [a, b, c]) {
          // PRODUCTION rule: negate iff reversed (geom-engine.ts tessellate()).
          let nx = m.normals[vi * 3], ny = m.normals[vi * 3 + 1], nz = m.normals[vi * 3 + 2]
          if (reversed) { nx = -nx; ny = -ny; nz = -nz }
          const nmag = Math.hypot(nx, ny, nz) || 1
          nx /= nmag; ny /= nmag; nz /= nmag
          const dot = nx * wx + ny * wy + nz * wz
          if (dot < worstDot) worstDot = dot
        }
      }
    }
  } finally {
    for (const f of faces) { try { k.release(f) } catch { /* */ } }
  }
  return { orientCounts, worstDot: faceCount ? worstDot : NaN, faceCount, reversedFaces, triCount }
}

describe('GEO-22 blind-hole render truth (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  async function blindHoleBody(): Promise<{ body: BodyHandle; floorId: string }> {
    const box = (await engine.makeBox('F1', PLATE)).body!
    const req: HoleRequest = {
      featureId: 'H1', body: box, face: TOP, points: [CENTER],
      style: { kind: 'simple', diameter: DIA }, depth: { kind: 'blind', distance: DEPTH },
    }
    const r = await engine.makeHole(req)
    expect(r.ok).toBe(true)
    const floorId = r.elementMap!.generated.find((g) => String(g).endsWith(':floor'))!
    expect(floorId).toBeDefined()
    return { body: r.body!, floorId: String(floorId) }
  }

  it('KERNEL is correct: blind hole removes the blind cylinder ONLY and owns a floor at z = top - depth', async () => {
    const box = (await engine.makeBox('F1', PLATE)).body!
    const v0 = (await engine.measure(box, 'volume')).value
    const { body } = await blindHoleBody()
    const v1 = (await engine.measure(body, 'volume')).value
    const removedBlind = PI * (DIA / 2) ** 2 * DEPTH
    const removedThrough = PI * (DIA / 2) ** 2 * PLATE.z
    // Removed volume matches the BLIND cylinder, NOT the through cylinder: the
    // numeric proof the geometry does not pass through the body.
    expect(Math.abs((v0 - v1) - removedBlind) / removedBlind).toBeLessThan(1e-6)
    expect(Math.abs((v0 - v1) - removedThrough) / removedThrough).toBeGreaterThan(0.5)
    // eslint-disable-next-line no-console
    console.log(`[GEO-22] KERNEL blind volume removed=${(v0 - v1).toFixed(3)} mm^3 (blind cyl=${removedBlind.toFixed(3)}, through cyl=${removedThrough.toFixed(3)})`)
    await engine.disposeAll()
  }, 60_000)

  it('TESSELLATION does not drop the floor and does not cull it: floor triangles present, WINDING normal +Z', async () => {
    const { body, floorId } = await blindHoleBody()
    const tess = await engine.tessellate(body, { deflection: 0.08, angularDeflection: 0.35 })

    // Full-face enumeration for the evidence trail: which faces' shading normal
    // AGREES with their winding (outward) and which DISAGREES (the defect).
    // eslint-disable-next-line no-console
    console.log('[GEO-22] face enumeration (id | tris | windingNZ | shadingN | agree | meanZ):')
    tess.faceIds.forEach((id, i) => {
      const s = faceTriStats(tess, i)
      if (s.count === 0) return
      const agree = Math.sign(s.shading[2] || 0) === Math.sign(s.windingNormalZ || 0)
      // eslint-disable-next-line no-console
      console.log(`  ${String(id).padEnd(20)} n=${String(s.count).padStart(3)} wNZ=${s.windingNormalZ.toFixed(3).padStart(7)} sN=[${s.shading.map((x) => x.toFixed(2)).join(',')}] agree=${agree} z=${s.meanZ.toFixed(2)}`)
    })

    // Control: the plate top face renders correctly in every screenshot -> its
    // winding normal MUST be +Z (validates this probe's sign convention) and its
    // shading normal MUST agree.
    const topIdxs = faceIndicesWhere(tess, (id) => id === TOP)
    expect(topIdxs.length).toBe(1)
    const top = faceTriStats(tess, topIdxs[0])
    expect(top.count).toBeGreaterThan(0)
    expect(Math.abs(top.meanZ - PLATE.z)).toBeLessThan(1e-3)
    expect(top.windingNormalZ).toBeGreaterThan(0.9) // +Z, front-facing from above
    expect(top.shading[2]).toBeGreaterThan(0.9) // shading agrees -> it renders lit

    // The blind-pocket floor: tessellated (not dropped) AND front-facing (not
    // culled). These both PASS -> the bug is neither a missing floor nor culling.
    const floorIdxs = faceIndicesWhere(tess, (id) => id === floorId)
    expect(floorIdxs.length).toBe(1)
    const floor = faceTriStats(tess, floorIdxs[0])
    expect(floor.count).toBeGreaterThan(0)
    expect(Math.abs(floor.meanZ - (PLATE.z - DEPTH))).toBeLessThan(1e-3)
    expect(floor.windingNormalZ).toBeGreaterThan(0.9) // NOT culled by FrontSide
    // eslint-disable-next-line no-console
    console.log(`[GEO-22] FLOOR wNZ=${floor.windingNormalZ.toFixed(4)} sN=[${floor.shading.map((x) => x.toFixed(3)).join(',')}] lit(+Z truth)=${litResponse([0, 0, 1]).toFixed(3)} lit(actual)=${litResponse(floor.shading).toFixed(3)}`)
    await engine.disposeAll()
  }, 60_000)

  // ---- THE PRIMARY GATE: the fix makes the floor shading normal point +Z ------
  // GEO-22B promoted this from GEO-22's `it.fails` DEFECT sentinel to a plain
  // `it`. Before the tessellate() orientation fix the floor's stored SHADING
  // normal pointed -Z (into the solid) while its winding normal was +Z, so the
  // floor shaded near-black under the all-above rig and read as a see-through
  // void. With tessellate() negating reversed-face normals the shading normal
  // now agrees with the (already-correct) winding, i.e. points +Z, and the floor
  // is lit like the top face. This test PASSES only when the fix is present; if
  // the fix is reverted these two assertions fail (the GEO-22B mutation proof).
  it('FIX (tessellation orientation): the blind-pocket floor SHADING normal points +Z and lights like the top face', async () => {
    const { body, floorId } = await blindHoleBody()
    const tess = await engine.tessellate(body, { deflection: 0.08, angularDeflection: 0.35 })
    const floorIdxs = faceIndicesWhere(tess, (id) => id === floorId)
    const floor = faceTriStats(tess, floorIdxs[0])
    // TRUTH: shading normal agrees with winding (both outward, +Z). With the fix
    // the floor shading Z ~ +1 (was ~ -1 pre-fix, which shaded it near-black).
    expect(floor.shading[2]).toBeGreaterThan(0.9)
    // And the lit response of the actual normal must now match the true (+Z) one.
    expect(litResponse([0, 0, 1]) - litResponse(floor.shading)).toBeLessThan(0.05)
    await engine.disposeAll()
  }, 60_000)

  // ---- RIG SYNC (GEO-23 preflight A4-3b) --------------------------------------
  // The Node-level sync-check that keeps litResponse()'s rig model honest. Both
  // the live workbench runtime (sceneRuntime.ts) and this test build the accent
  // rig via buildWorkbenchRig(); this test asserts that builder faithfully
  // reflects the shared rig descriptors (intensities + positions + colours). If a
  // future edit made buildWorkbenchRig() hardcode a value away from the
  // descriptors -- the exact way the runtime could drift from what this test
  // models -- THIS assertion goes red, independently of any downstream lighting
  // assertion or G1's real-pixel proof. Non-vacuous: it checks the retune-prone
  // numbers (intensity, position) component by component.
  it('RIG SYNC (GEO-23 A4-3b): buildWorkbenchRig() faithfully reflects the shared rig descriptors (retune-safe)', () => {
    const rig = buildWorkbenchRig()
    // Hemisphere term.
    expect(rig.hemisphere.intensity, 'hemisphere intensity').toBe(WORKBENCH_HEMISPHERE.intensity)
    expect(rig.hemisphere.color.getHex(), 'hemisphere sky colour').toBe(new THREE.Color(WORKBENCH_HEMISPHERE.sky).getHex())
    expect(rig.hemisphere.groundColor.getHex(), 'hemisphere ground colour').toBe(new THREE.Color(WORKBENCH_HEMISPHERE.ground).getHex())
    // Accent lights, in descriptor order.
    const expectColor: Record<string, number> = { key: WORKBENCH_KEY_COLOR, fill: WORKBENCH_FILL_COLOR, rim: WORKBENCH_RIM_COLOR }
    expect(rig.accents.length, 'accent count').toBe(WORKBENCH_ACCENT_LIGHTS.length)
    WORKBENCH_ACCENT_LIGHTS.forEach((desc, i) => {
      const light = rig.accents[i]
      expect(light.name, `accent[${i}] role`).toBe(`workbench-cad-${desc.role}`)
      expect(light.intensity, `${desc.role} intensity`).toBe(desc.intensity)
      expect([light.position.x, light.position.y, light.position.z], `${desc.role} position`).toEqual([...desc.position])
      expect(light.color.getHex(), `${desc.role} colour`).toBe(new THREE.Color(expectColor[desc.role]).getHex())
    })
  })

  it('RESIZE PATH (Operator repro): grow blind hole diameter; kernel/winding stay truthful; shading now +Z after fix', async () => {
    // Mirror the screenshots' exact path: cut a small blind hole, then RESIZE its
    // diameter (editFeature holeDiameter) -- the heal-then-re-cut lane.
    const box = (await engine.makeBox('F1', PLATE)).body!
    const drill = await engine.makeHole({
      featureId: 'H1', body: box, face: TOP, points: [CENTER],
      style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: DEPTH },
    })
    expect(drill.ok).toBe(true)
    const verdicts: FeatureVerdict[] = await engine.recognizeFeatures(drill.body!)
    const blind = verdicts.find((v) => v.featureClass === 'blindHole')
    expect(blind, 'blind hole recognized before resize').toBeDefined()
    const resized = await engine.editFeature({ featureId: 'E1', body: drill.body!, featureKey: blind!.featureKey, delta: 19, kind: 'holeDiameter' })
    expect(resized.ok).toBe(true)

    // Still a blind hole after resize (not silently promoted to through).
    const rr: FeatureVerdict[] = await engine.recognizeFeatures(resized.body!)
    expect(rr.filter((v) => v.featureClass === 'blindHole').length).toBe(1)
    expect(rr.filter((v) => v.featureClass === 'throughHole').length).toBe(0)

    const tess = await engine.tessellate(resized.body!, { deflection: 0.08, angularDeflection: 0.35 })
    const floorIdxs = faceIndicesWhere(tess, (id) => id.endsWith(':floor'))
    expect(floorIdxs.length).toBeGreaterThanOrEqual(1)
    const floor = faceTriStats(tess, floorIdxs[0])
    expect(floor.count).toBeGreaterThan(0)
    expect(Math.abs(floor.meanZ - (PLATE.z - DEPTH))).toBeLessThan(1e-3)
    expect(floor.windingNormalZ).toBeGreaterThan(0.9) // still not culled
    // eslint-disable-next-line no-console
    console.log(`[GEO-22] RESIZED FLOOR wNZ=${floor.windingNormalZ.toFixed(4)} sN=[${floor.shading.map((x) => x.toFixed(3)).join(',')}]`)
    // After the fix, the resize path's floor shading normal is also corrected +Z
    // (the heal-then-re-cut lane produces a REVERSED floor face exactly like the
    // create path, so the shared tessellate() fix covers it too).
    expect(floor.shading[2]).toBeGreaterThan(0.9) // FIXED on the resize path too
    await engine.disposeAll()
  }, 90_000)

  // ---- ORIENTATION-TRANSFORM census (byte-level; orientation is the axis) ------
  // Binding audit MAJOR (GEO-22B-R1, coordination/reports/GEO-22B.audit.json):
  // the prior census proved final winding-agreement but OVERCLAIMED an
  // orientation-specific no-double-flip proof -- it never recorded
  // shapeOrientation and never compared forward-face normal BYTES before/after.
  // The truth the fix implements is orientation-determined, NOT face-class-
  // determined: a plain box splits 3 TopAbs_REVERSED / 3 forward (an OUTER side
  // wall such as F1:BOX:xMin is REVERSED and IS corrected by the fix -- correct
  // and desirable), so labelling "outer walls = forward = untouched" is wrong.
  //
  // This census proves the fix's TRANSFORM directly. engine.makeBox is exactly
  // k.makeBox(x,y,z) with no heal (geom-engine.ts:792), so a raw-kernel box built
  // with the same dimensions meshes each face byte-for-byte identically to what
  // the product tessellate() loop consumed PRE-fix. For every face we read
  // shapeOrientation from the raw box and assert, on the ENGINE's POST-fix
  // tessellation:
  //   * FORWARD face  -> every shading-normal component is BYTE-IDENTICAL (Object.is)
  //     to the raw pre-fix normal (no double-flip: forward faces are untouched);
  //   * REVERSED face -> every component is EXACTLY the NEGATION of the raw normal.
  // Orientation, never geometric class, is the assertion axis. A sampled solid
  // boundary emits ONLY forward/reversed faces (no internal/external), which the
  // orientation-split assertion states explicitly.
  it('ORIENTATION-TRANSFORM census (byte-level): FORWARD faces byte-identical, REVERSED faces exactly negated -- orientation is the axis', async () => {
    // PRODUCT (post-fix) tessellation of a plain box.
    const box = (await engine.makeBox('F1', PLATE)).body!
    const tess = await engine.tessellate(box, { deflection: 0.08, angularDeflection: 0.35 })

    // RAW (pre-fix) per-face meshShape of an identically-constructed box.
    const k2 = await OcctKernel.init()
    try {
      const rawBox = k2.makeBox(PLATE.x, PLATE.y, PLATE.z)
      const rawFaces = k2.getSubShapes(rawBox, 'face')
      interface RawRec { orientation: string; centroid: [number, number, number]; normalByPos: Map<string, [number, number, number]> }
      const rawRecs: RawRec[] = []
      try {
        for (const f of rawFaces) {
          const orientation = String(k2.shapeOrientation(f))
          const m = k2.meshShape(f, MESH_OPTS)
          const normalByPos = new Map<string, [number, number, number]>()
          let cx = 0, cy = 0, cz = 0, n = 0
          for (let i = 0; i < m.positions.length; i += 3) {
            normalByPos.set(posKey(m.positions[i], m.positions[i + 1], m.positions[i + 2]),
              [m.normals[i], m.normals[i + 1], m.normals[i + 2]])
            cx += m.positions[i]; cy += m.positions[i + 1]; cz += m.positions[i + 2]; n++
          }
          rawRecs.push({ orientation, centroid: [cx / (n || 1), cy / (n || 1), cz / (n || 1)], normalByPos })
        }
      } finally {
        for (const f of rawFaces) { try { k2.release(f) } catch { /* */ } }
      }

      // Orientation split (the fact the prior prose got wrong). STATE it: a
      // sampled solid boundary emits ONLY forward/reversed -- no internal/external.
      const orientCounts: Record<string, number> = {}
      for (const r of rawRecs) orientCounts[r.orientation] = (orientCounts[r.orientation] ?? 0) + 1
      // eslint-disable-next-line no-console
      console.log(`[GEO-22B-R1] plain-box shapeOrientation split: ${JSON.stringify(orientCounts)} (outer side walls are among the REVERSED faces the fix corrects)`)
      expect(orientCounts['internal'] ?? 0, 'a sampled solid boundary emits NO internal-oriented faces').toBe(0)
      expect(orientCounts['external'] ?? 0, 'a sampled solid boundary emits NO external-oriented faces').toBe(0)
      expect(orientCounts['forward'] ?? 0, 'plain box carries forward faces').toBeGreaterThan(0)
      expect(orientCounts['reversed'] ?? 0, 'plain box carries reversed faces (else the negate path is never exercised)').toBeGreaterThan(0)
      expect((orientCounts['forward'] ?? 0) + (orientCounts['reversed'] ?? 0), 'every box face is forward or reversed').toBe(6)

      // The byte-level transform assertion, orientation as the axis.
      let checkedForward = 0, checkedReversed = 0, negatedNonzeroComps = 0
      tess.faceIds.forEach((id, fi) => {
        const verts = engineFaceVerts(tess, fi)
        if (verts.length === 0) return
        const ec = centroidOf(verts)
        // Pair to the raw face by centroid (box faces are well separated); the
        // <1e-6 assertion catches any mispairing (fail closed).
        let rec = rawRecs[0], best = Infinity
        for (const r of rawRecs) {
          const dd = Math.hypot(r.centroid[0] - ec[0], r.centroid[1] - ec[1], r.centroid[2] - ec[2])
          if (dd < best) { best = dd; rec = r }
        }
        expect(best, `engine face ${id} pairs to a raw box face by centroid`).toBeLessThan(1e-6)
        const reversed = rec.orientation === 'reversed'
        for (const v of verts) {
          const raw = rec.normalByPos.get(posKey(v.pos[0], v.pos[1], v.pos[2]))
          expect(raw, `engine vertex of ${id} has a matching raw pre-fix normal (identical box construction is deterministic)`).toBeDefined()
          for (let c = 0; c < 3; c++) {
            const expected = reversed ? -raw![c] : raw![c]
            // Byte-exact: Object.is distinguishes +0/-0 and the product stored
            // exactly `m.normals[i]` (forward) or `-m.normals[i]` (reversed).
            expect(Object.is(v.nrm[c], expected),
              `face ${id} (${rec.orientation}) normal[${c}]: post=${v.nrm[c]} expected ${reversed ? 'NEGATED' : 'IDENTICAL'} ${expected} (raw ${raw![c]})`).toBe(true)
            if (reversed && raw![c] !== 0) negatedNonzeroComps++
          }
        }
        if (reversed) checkedReversed++; else checkedForward++
      })
      // eslint-disable-next-line no-console
      console.log(`[GEO-22B-R1] byte census: forward byte-identical faces=${checkedForward}, reversed exactly-negated faces=${checkedReversed}, negated nonzero comps=${negatedNonzeroComps}`)
      expect(checkedForward, 'forward faces byte-verified untouched').toBeGreaterThan(0)
      expect(checkedReversed, 'reversed faces negation-verified').toBeGreaterThan(0)
      // Non-vacuous: the reversed path actually flipped real (nonzero) bytes, so
      // "byte-identical / negated" is not passing on all-zero normals.
      expect(negatedNonzeroComps, 'reversed faces had nonzero normal components that were actually negated').toBeGreaterThan(0)

      k2.release(rawBox)
    } finally {
      try { k2[Symbol.dispose]() } catch { /* already disposed */ }
    }
    await engine.disposeAll()
  }, 120_000)

  // ---- DIRECT-KERNEL enclosed cavity + hollow shell (GEO-22B-R1) ---------------
  // Reproduce the auditor's independent probes as committed tests. Each builds a
  // solid whose interior is bounded by REVERSED faces (an enclosed void; a
  // thick-walled shell), then asserts (a) the boundary emits ONLY forward/reversed
  // faces -- explicitly NO internal/external -- so the fix's binary reversed-guard
  // is complete, and (b) the PRODUCTION rule (negate iff reversed) orients every
  // face outward (worstDot > 0). reversedFaces > 0 makes each non-vacuous: the
  // negate path is genuinely exercised on interior walls.
  it('DIRECT-KERNEL enclosed cavity: interior void faces are forward/reversed only (no internal/external); production rule orients all outward', async () => {
    const k = await OcctKernel.init()
    try {
      const outer = k.makeBoxFromCorners({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 100 })
      const inner = k.makeBoxFromCorners({ x: 30, y: 30, z: 30 }, { x: 70, y: 70, z: 70 })
      // cut() of a fully-INTERNAL tool returns a compound wrapping ONE solid with
      // an enclosed void; extract that solid and probe it.
      const cut = k.cut(outer, inner)
      const solids = k.getSubShapes(cut, 'solid')
      try {
        expect(solids.length, 'cut of an internal box yields exactly one solid (walls around an enclosed void)').toBe(1)
        const cavity = solids[0]
        expect(k.isValid(cavity) && k.isSolid(cavity), 'enclosed-cavity solid is a valid solid').toBe(true)
        // Volume proves the void is truly enclosed: outer 100^3 minus inner 40^3.
        expect(Math.abs(k.getVolume(cavity) - (100 ** 3 - 40 ** 3)), 'enclosed void volume = outer - inner').toBeLessThan(1)
        const p = probeSolidOrientation(k, cavity)
        // eslint-disable-next-line no-console
        console.log(`[GEO-22B-R1] enclosed cavity: faces=${p.faceCount} reversed=${p.reversedFaces} split=${JSON.stringify(p.orientCounts)} worstDot=${p.worstDot.toFixed(4)} tris=${p.triCount}`)
        expect(p.faceCount, 'enclosed cavity has 12 faces: 6 outer + 6 enclosed-void walls').toBe(12)
        expect(p.orientCounts['internal'] ?? 0, 'enclosed cavity emits NO internal-oriented faces').toBe(0)
        expect(p.orientCounts['external'] ?? 0, 'enclosed cavity emits NO external-oriented faces').toBe(0)
        expect(p.reversedFaces, 'enclosed cavity has reversed void-wall faces (negate path exercised)').toBeGreaterThan(0)
        expect(p.triCount, 'cavity produced meshable triangles').toBeGreaterThan(0)
        expect(p.worstDot, 'production negate-iff-reversed orients every cavity face outward').toBeGreaterThan(0)
      } finally {
        for (const h of solids) { try { k.release(h) } catch { /* */ } }
        for (const h of [outer, inner, cut]) { try { k.release(h) } catch { /* */ } }
      }
    } finally {
      try { k[Symbol.dispose]() } catch { /* */ }
    }
  }, 120_000)

  it('DIRECT-KERNEL hollow shell: thick-walled shell faces are forward/reversed only (no internal/external); production rule orients all outward', async () => {
    const k = await OcctKernel.init()
    try {
      const solid = k.makeBox(80, 80, 40)
      const boxFaces = k.getSubShapes(solid, 'face')
      // Remove the top face (max mean-z) and offset the rest inward -> a hollow
      // shell (an open thick-walled container) whose INNER walls are reversed.
      let top = boxFaces[0], topZ = -Infinity
      for (const f of boxFaces) {
        const m = k.meshShape(f, MESH_OPTS)
        let z = 0
        for (let i = 2; i < m.positions.length; i += 3) z += m.positions[i]
        z /= (m.positions.length / 3) || 1
        if (z > topZ) { topZ = z; top = f }
      }
      const shell = k.shell(solid, [top], 6, 1e-6)
      try {
        expect(k.isValid(shell) && k.isSolid(shell), 'hollow shell is a valid solid').toBe(true)
        const p = probeSolidOrientation(k, shell)
        // eslint-disable-next-line no-console
        console.log(`[GEO-22B-R1] hollow shell: faces=${p.faceCount} reversed=${p.reversedFaces} split=${JSON.stringify(p.orientCounts)} worstDot=${p.worstDot.toFixed(4)} tris=${p.triCount}`)
        expect(p.orientCounts['internal'] ?? 0, 'hollow shell emits NO internal-oriented faces').toBe(0)
        expect(p.orientCounts['external'] ?? 0, 'hollow shell emits NO external-oriented faces').toBe(0)
        expect(p.reversedFaces, 'hollow shell has reversed inner-wall faces (negate path exercised)').toBeGreaterThan(0)
        expect(p.triCount, 'shell produced meshable triangles').toBeGreaterThan(0)
        expect(p.worstDot, 'production negate-iff-reversed orients every shell face outward').toBeGreaterThan(0)
      } finally {
        for (const f of boxFaces) { try { k.release(f) } catch { /* */ } }
        for (const h of [solid, shell]) { try { k.release(h) } catch { /* */ } }
      }
    } finally {
      try { k[Symbol.dispose]() } catch { /* */ }
    }
  }, 120_000)

  // ---- FULL-VECTOR AGREEMENT census on a rich multi-class body -----------------
  // The integration/no-double-flip check that complements the byte-level
  // orientation census above. On one body carrying planar AND cylindrical faces
  // (top, bottom, four side walls, a BLIND hole floor+wall, a THROUGH hole wall)
  // the product's POST-fix shading normal must agree with the outward winding
  // normal as a FULL 3D VECTOR (dot > 0) on every triangle of every face. This is
  // orientation-determined, not face-class-determined: whether a given face was
  // forward (untouched) or reversed (negated) is decided by shapeOrientation, and
  // the fix corrects EVERY reversed face -- including the plate bottom and, on the
  // plain box above, outer side walls -- which is correct and desirable. Because
  // the census demands dot > 0 on the already-correct faces too, a double-flip
  // would drive one negative and fail here; all pass, so the guarded negation
  // touches only reversed faces and leaves forward faces outward. The face
  // classes below are an evidence/coverage label for the log -- NOT a claim that
  // class determines orientation.
  it('FULL-VECTOR AGREEMENT census (no double-flip): post-fix shading agrees with outward winding (dot>0) on top, bottom, sides, blind floor+wall, through wall', async () => {
    const box = (await engine.makeBox('F1', PLATE)).body!
    const blind = await engine.makeHole({
      featureId: 'H1', body: box, face: TOP, points: [{ x: 40, y: 40, z: 20 }],
      style: { kind: 'simple', diameter: DIA }, depth: { kind: 'blind', distance: DEPTH },
    })
    expect(blind.ok, 'blind hole cut ok').toBe(true)
    const through = await engine.makeHole({
      featureId: 'H2', body: blind.body!, face: TOP, points: [{ x: 90, y: 40, z: 20 }],
      style: { kind: 'simple', diameter: DIA }, depth: { kind: 'throughAll' },
    })
    expect(through.ok, 'through hole cut ok').toBe(true)
    const tess = await engine.tessellate(through.body!, { deflection: 0.08, angularDeflection: 0.35 })

    // Coverage label ONLY (which classes were exercised), not an orientation claim.
    const classOf = (id: string): string => {
      if (id === 'F1:BOX:zMax') return 'top'
      if (id === 'F1:BOX:zMin') return 'bottom'
      if (/^F1:BOX:(xMin|xMax|yMin|yMax)$/.test(id)) return 'side'
      if (id.startsWith('H1:HOL') && /:floor(#\d+)?$/.test(id)) return 'blindFloor'
      if (id.startsWith('H1:HOL') && /:wall(#\d+)?$/.test(id)) return 'blindWall'
      if (id.startsWith('H2:HOL') && /:wall(#\d+)?$/.test(id)) return 'throughWall'
      return 'other'
    }

    const seen = new Map<string, number>()
    let worst = { id: '', dot: Infinity }
    // eslint-disable-next-line no-console
    console.log('[GEO-22B] full-vector agreement census (id | coverage-class | tris | minDot(shading.winding) | windingZ):')
    tess.faceIds.forEach((id, i) => {
      const d = faceDotStats(tess, i)
      if (!(d.count > 0)) return
      const cls = classOf(String(id))
      seen.set(cls, (seen.get(cls) ?? 0) + 1)
      // eslint-disable-next-line no-console
      console.log(`  ${String(id).padEnd(22)} ${cls.padEnd(11)} n=${String(d.count).padStart(3)} minDot=${d.minDot.toFixed(4).padStart(8)} wZ=${d.meanWindingZ.toFixed(3).padStart(7)}`)
      // THE ASSERTION: full-vector agreement on every triangle of every face,
      // regardless of the face's orientation or geometric class.
      expect(d.minDot, `face ${id} (${cls}) shading disagrees with winding minDot=${d.minDot}`).toBeGreaterThan(0)
      if (d.minDot < worst.dot) worst = { id: String(id), dot: d.minDot }
    })
    // eslint-disable-next-line no-console
    console.log(`[GEO-22B] worst full-vector agreement across ALL faces: ${worst.id} minDot=${worst.dot.toFixed(4)}`)

    // Non-vacuous: every exercised face class must actually be present (else the
    // census could "pass" by never testing a class).
    for (const cls of ['top', 'bottom', 'side', 'blindFloor', 'blindWall', 'throughWall']) {
      expect(seen.get(cls) ?? 0, `census missing required coverage class: ${cls}`).toBeGreaterThan(0)
    }
    expect(seen.get('side'), 'all four box side walls judged').toBe(4)
    await engine.disposeAll()
  }, 120_000)
})
