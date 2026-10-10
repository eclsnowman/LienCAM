// WO SKC-47 -- the real-solver + real-kernel gate for ellipse profiles.
//
// The unit tests in sketchProfile.test.ts prove the ADAPTER (validate + extract) accepts ellipses
// and tessellates them. They do NOT prove the last link: that an ellipse sketch, run through the
// production extractSketchProfile path, extrudes and REVOLVES into a real occt-wasm body whose
// volume is the ANALYTIC ellipse volume -- not a circle, not an empty shell, not a silently-wrong
// solid. This file drives extractSketchProfile -> GeomEngine.makeExtrude / makeRevolve on the REAL
// kernel (the same harness extrude.test.ts / revolve.test.ts use) and measures the body.
//
// Non-vacuity is built in: each volume assertion is bracketed so that using majorRadius for BOTH
// axes (mutation proof B) -- which would turn the ellipse into a circle -- overshoots the band and
// fails BY NAME. A pi*a*b body cannot be mistaken for a pi*a*a body.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { extractSketchProfile } from '../../components/model3d/workbench/sketchProfile.ts'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes.ts'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'

function sketch(entities: SketchEntity[]): Sketch {
  return { id: 'S1', layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }
}

const ellipse = (
  id: string, majorRadius: number, minorRadius: number, cx = 0, cy = 0, rotation = 0, construction = false,
): SketchEntity => ({ id, kind: 'ellipse', construction, center: { x: cx, y: cy }, majorRadius, minorRadius, rotation })

const line = (id: string, ax: number, ay: number, bx: number, by: number): SketchEntity => ({
  id, kind: 'line', construction: false, start: { x: ax, y: ay }, end: { x: bx, y: by },
})

const ellipticalArc = (
  id: string, majorRadius: number, minorRadius: number, startParam: number, endParam: number,
  cx = 0, cy = 0, rotation = 0,
): SketchEntity => ({
  id, kind: 'elliptical-arc', construction: false,
  center: { x: cx, y: cy }, majorRadius, minorRadius, rotation, startParam, endParam,
})

// Point on an ellipse at eccentric parameter t, in world coords -- mirrors sketchProfile.test.ts's
// copy so this fixture doesn't depend on importing it.
function ellipsePt(majorRadius: number, minorRadius: number, rotation: number, cx: number, cy: number, t: number): { x: number; y: number } {
  const c = Math.cos(rotation), s = Math.sin(rotation)
  const x = majorRadius * Math.cos(t), y = minorRadius * Math.sin(t)
  return { x: cx + x * c - y * s, y: cy + x * s + y * c }
}

/** Extrude ids are `<featureId>:XTR:<srcId>:side` (sweep-lineage.ts extrudeSideId), optionally
 *  `#<j>` disambiguated by geom-engine.ts #assignSweptFaceIds when several faces share one srcId --
 *  exactly what a tessellated ellipse produces. Parses the srcId back out, or fails the assertion
 *  (never silently skips a face whose id doesn't match the expected shape). */
function sideSrcId(featureId: string, id: string): string {
  const m = id.match(new RegExp(`^${featureId}:XTR:(.+):side(?:#\\d+)?$`))
  if (!m) throw new Error(`generated id does not match the extrude side-face shape: ${id}`)
  return m[1]
}

describe('WO SKC-47: an ellipse profile extrudes/revolves into a real occt-wasm body', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('full ellipse extrudes to volume == pi*a*b*distance (and is NOT a circle)', async () => {
    const a = 20, b = 10, distance = 8
    const res = await extractSketchProfile(sketch([ellipse('e', a, b)]), BASE_PLANE_FRAMES.xy, 'SKE')
    expect(res.ok, 'the ellipse must produce a profile').toBe(true)
    if (!res.ok) return

    const r = await engine.makeExtrude({ featureId: 'F1', profiles: res.regions, end: { kind: 'blind', distance }, op: 'newBody' })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    expect(Number.isFinite(vol.value)).toBe(true)

    const expected = Math.PI * a * b * distance // 5026.5 mm^3
    // Tessellated (inscribed) polygon volume is a hair UNDER the analytic ellipse; 1% covers the
    // 0.3mm-chord deficit with margin.
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(0.01)
    // Non-vacuity: a circle of r=major would be pi*a*a*d = 10053 (2x); r=minor would be 2513 (0.5x).
    // Both are far outside the +/-1% band, so this body demonstrably honoured BOTH semi-axes.
    expect(vol.value).toBeGreaterThan(Math.PI * b * b * distance * 1.5)
    expect(vol.value).toBeLessThan(Math.PI * a * a * distance * 0.75)
    await engine.dispose(r.body!)
  }, 60_000)

  it('rotated ellipse extrudes to the same pi*a*b*distance volume (rotation is area-invariant)', async () => {
    const a = 20, b = 10, distance = 8
    const res = await extractSketchProfile(sketch([ellipse('e', a, b, 4, -3, Math.PI / 5)]), BASE_PLANE_FRAMES.xy, 'SKR')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const r = await engine.makeExtrude({ featureId: 'F1', profiles: res.regions, end: { kind: 'blind', distance }, op: 'newBody' })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    const expected = Math.PI * a * b * distance
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(0.01)
    await engine.dispose(r.body!)
  }, 60_000)

  it('full ellipse revolves 360deg into a torus of volume == 2*pi*R*(pi*a*b) [Pappus]', async () => {
    // On the XZ base plane (localY = world +Z), an ellipse offset to local (D,0) sits at radius D
    // from the world Z axis; a full revolve sweeps an elliptical-section torus.
    const a = 10, b = 5, D = 40
    const res = await extractSketchProfile(sketch([ellipse('e', a, b, D, 0)]), BASE_PLANE_FRAMES.xz, 'SKV')
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const r = await engine.makeRevolve({
      featureId: 'RV1', profile: res.regions[0],
      axis: { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } }, angleDeg: 360, op: 'newBody',
    })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    // Pappus: V = 2*pi*R * A, R = D (centroid radius), A = pi*a*b. = 2*pi^2*D*a*b = 39478 mm^3.
    const expected = 2 * Math.PI * Math.PI * D * a * b
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(0.01)
    // Non-vacuity: a circular (r=a) section torus would be 2*pi^2*D*a*a = 78957 (2x) -- excluded.
    expect(vol.value).toBeLessThan(2 * Math.PI * Math.PI * D * a * a * 0.75)
    await engine.dispose(r.body!)
  }, 60_000)

  it('a construction ellipse is excluded end-to-end: the square body ignores it', async () => {
    // 10x10 square + a construction ellipse straddling it. If construction were ignored, the ellipse
    // would either carve/branch the profile or add a second region -- the volume would not be the
    // clean square prism. That it equals side^2 * distance proves exclusion through the real kernel.
    const side = 10, distance = 8
    const square: SketchEntity[] = [
      line('s0', 0, 0, side, 0), line('s1', side, 0, side, side),
      line('s2', side, side, 0, side), line('s3', 0, side, 0, 0),
    ]
    const res = await extractSketchProfile(
      sketch([...square, ellipse('e', 6, 3, side / 2, side / 2, 0, /* construction */ true)]),
      BASE_PLANE_FRAMES.xy, 'SKC',
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const r = await engine.makeExtrude({ featureId: 'F1', profiles: res.regions, end: { kind: 'blind', distance }, op: 'newBody' })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    const expected = side * side * distance // 800 mm^3, the plain square prism
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(1e-6)
    await engine.dispose(r.body!)
  }, 60_000)

  // WO SKC-47-R1 (audit MAJOR 1): the ADAPTER-level proof in sketchProfile.test.ts shows the emitted
  // ProfileSegment.srcId is always an original entity id. This is the LAST-LINK proof: the real
  // occt-wasm ElementMap the kernel actually mints (geom-engine.ts #assignSweptFaceIds) names its
  // generated side faces by that same original id -- using its own `#j` disambiguator for the many
  // side faces one tessellated ellipse produces -- rather than a synthetic `~ell<i>` tessellation id
  // that names no entity in the saved sketch.
  it('extrude ElementMap: every generated side-face id names an ORIGINAL entity id, deterministic across two runs', async () => {
    const a = 20, b = 10, distance = 8
    const build = async (featureId: string) => {
      const res = await extractSketchProfile(sketch([ellipse('e', a, b)]), BASE_PLANE_FRAMES.xy, 'SKM')
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      const r = await engine.makeExtrude({ featureId, profiles: res.regions, end: { kind: 'blind', distance }, op: 'newBody' })
      expect(r.ok).toBe(true)
      const sideIds = r.elementMap!.generated.filter((id) => /:side(#\d+)?$/.test(id) && !id.includes(':cap'))
      expect(sideIds.length).toBeGreaterThan(0)
      // Over EVERY generated side face, not a sample: the parsed srcId is the ORIGINAL entity id.
      for (const id of sideIds) expect(sideSrcId(featureId, id)).toBe('e')
      await engine.dispose(r.body!)
      return [...r.elementMap!.generated].sort()
    }
    const run1 = await build('F1')
    const run2 = await build('F1')
    // Deterministic: identical featureId + identical profile mints byte-identical ids both times.
    expect(run2).toEqual(run1)
  }, 60_000)

  it('elliptical-arc + chord (D-shape) region: side-face ids name only the TWO original entity ids, and volume matches the analytic half-ellipse', async () => {
    const a = 20, b = 10, distance = 8
    const start = ellipsePt(a, b, 0, 0, 0, 0)
    const end = ellipsePt(a, b, 0, 0, 0, Math.PI)
    const arc = ellipticalArc('ea', a, b, 0, Math.PI)
    const chord = line('chord', end.x, end.y, start.x, start.y)
    const res = await extractSketchProfile(sketch([arc, chord]), BASE_PLANE_FRAMES.xy, 'SKD')
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const r = await engine.makeExtrude({ featureId: 'F1', profiles: res.regions, end: { kind: 'blind', distance }, op: 'newBody' })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    const expected = 0.5 * Math.PI * a * b * distance // half-ellipse prism
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(0.01)

    const sideIds = r.elementMap!.generated.filter((id) => /:side(#\d+)?$/.test(id) && !id.includes(':cap'))
    expect(sideIds.length).toBeGreaterThan(0)
    const srcIdsSeen = new Set(sideIds.map((id) => sideSrcId('F1', id)))
    // Only the two ORIGINAL sketch entities -- the tessellated arc plus the chord -- ever appear as
    // side-face origins; no synthetic `ea~ell<i>` tessellation id leaks past the kernel boundary.
    expect([...srcIdsSeen].sort()).toEqual(['chord', 'ea'])
    await engine.dispose(r.body!)
  }, 60_000)
})
