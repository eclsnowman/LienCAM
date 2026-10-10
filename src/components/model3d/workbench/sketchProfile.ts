// WO SKC-15 (S3), item 4: the accept point between THE Sketcher's document and the kernel.
//
// "On finish, closed loops from the Sketcher document become the sketch node's consumable regions
// so whole-sketch extrudes can use all of them while single-region features choose deliberately.
// Data validity at the accept point: loop extraction validates finite coordinates and closed loops;
// an open or degenerate sketch refuses profile production BY NAME (the sketch still saves; the
// feature dialog reports no profile) -- never NaN into the kernel."
//
// WHY THIS FILE IS AN ADAPTER, NOT A SECOND LOOP EXTRACTOR: it owns no loop/region geometry of its
// own. It adapts the CAM `SketchEntity` model onto `Sketch3dEntity` -- the two are structurally
// IDENTICAL for line/circle/arc (id / construction / start+end / center+radius / center+radius+
// startAngle+endAngle) -- and delegates region extraction to ONE engine.
//
// WHICH engine changed in WO BUG-MODEL-REGION-PICK (2026-08-05). It used to be
// `src/sketch3d/regions.ts` (chainEntitiesIntoLoops + computeProfileRegions), which is a
// WHOLE-PROFILE chainer: it throws on any vertex of degree != 2, so one stray edge or two profiles
// that abut/cross refuse the entire sketch, and a region bounded by several profiles' edges cannot
// exist. The workbench now delegates to `./sketchRegionArrangement.ts`, which builds the planar
// arrangement and enumerates its enclosed faces. regions.ts is unchanged and still drives the
// 3D-lab sketch3d path through regen.ts (it is outside that WO's ownership); the two agree on every
// input regions.ts accepts and differ only where it used to throw. See the arrangement module's
// header for the full rationale and the named follow-on.
//
// What this file genuinely ADDS, because the engine does not do it and because the kernel is what
// pays for it:
//
//   1. FINITE-COORDINATE validation. An unsolved/conflicting sketch can carry NaN. Neither engine
//      checks: both would thread NaN through their vertex keys and hand the kernel a NaN profile.
//   2. UNSUPPORTED-ENTITY refusal. Both engines consume only line/arc/circle -- so a CAM spline /
//      text entity is SILENTLY IGNORED by them. Silently ignoring a closed spline that the user drew
//      as their outer boundary would extrude the wrong solid. CAM's Sketch is a superset of
//      sketch3d's model; the still-unsupported part of that superset must be refused by name here,
//      not dropped.
//   3. A NAMED refusal, so the feature dialog can say what is wrong and the sketch can still save.
//
// WO SKC-47 -- ELLIPSE PROFILES. A closed region bounded wholly or partly by an ellipse or an
// elliptical arc now produces a profile. The representation is TESSELLATION, not an exact kernel
// ellipse edge, decided on evidence:
//   - occt-wasm DOES expose makeEllipseEdge/makeEllipseArc, but their signatures carry NO
//     major-axis-direction argument (center, normal, majorRadius, minorRadius[, a0, a1]) -- OCCT
//     defaults the major axis to the profile plane's xDir. A ROTATED ellipse (the `rotation` field,
//     and the general case in Operator's N-25 sketch) is therefore NOT exactly expressible through the
//     geom-engine's profile-wire surface. So "the geom engine supports elliptical edges" is false
//     for the general case the WO must cover.
//   - `ProfileSegment` (geom-service.ts) is the FROZEN GEO-lane profile contract and has only
//     `line` and `arc` variants; keeping ellipse support in THIS adapter leaves that contract and
//     the shared regions.ts engine byte-identical.
//   - Tessellation reuses the EXISTING repo-wide convention -- src/lib/sketch/ellipse.ts's
//     tessellateEllipse / tessellateEllipticalArc (TESS_STEP_MM = 0.3 mm chord budget, clamped
//     16..512 segments). That is the SAME sampler the bake path (src/lib/sketch/bake.ts) already
//     feeds to the CAM kernel, so the 3D modeling workspace solid and the CAM toolpath approximate one
//     ellipse identically for a FULL ellipse -- no divergence, no invented knob. An exact
//     axis-aligned ellipse edge is a possible future GEO-lane upgrade, disclosed in the report.
//
// WO SKC-47-R1 (audit MAJOR 2) -- HONEST CAM PARITY. The claim above holds ONLY for a full ellipse.
// bakeSketch (src/lib/sketch/bake.ts:433-440) tessellates an elliptical arc as its OWN standalone
// OPEN polyline loop and never chains it with a neighbouring line/arc the way this 3D modeling workspace
// adapter's chainEntitiesIntoLoops does -- so a partial-ellipse region (e.g. the arc+chord D-shape
// this file accepts as ONE closed profile) reaches CAM bake as TWO disconnected open loops, not one
// closed CAM profile. The CAM-side chaining fix is booked as SKC-48 (visible on the board) and is
// deliberately NOT implemented here -- this workspace-scoped WO owns sketchProfile.ts only.
//
// WO SKC-47-R2 -- the DERIVED closed-loop-consumer census (src/tests/cam/loop-consumer-census.test.ts;
// see coordination/DECISIONS.md "2026-07-15 -- SKC-47 two-bounce STOP" for why R1's version of this
// paragraph was wrong twice: it asserted every consumer refuses by name from prose memory, without
// ever deriving the actual consumer set from source). The real classification, one row per consumer:
//   - REFUSES BY NAME on a no-closed-loop selection: Contour (contour2d.ts:85), Pocket
//     (pocket2d.ts:1143/:1148), Chamfer (chamfer2d.ts:123) -- all pre-existing; Drill (drill2d.ts) and
//     Thread Mill (threadmill2d.ts) -- SKC-47-R2 fix, they used to filter by loopIds ONLY (no closed
//     check), so an open loop picked as a hole silently drilled/orbited at the open arc's centroid,
//     worse than empty; Face (face2d/index.ts) -- SKC-47-R2 fix, used to `return moves` silently;
//     Adaptive Clearing (adaptiveClearing2d/engine/index.ts) -- SKC-47-R2 fix, used to console.warn +
//     `return []`, and unlike Face there is NO store-level pre-dispatch guard for AC's geometry
//     boundary branch (store/index.ts has one for Face only, :5415-5420), so AC was genuinely silent
//     END TO END -- the live user-facing defect the R1 audit named.
//   - PROVEN-SAFE, not a refusal target: Engrave (engrave2d/index.ts:117-121) consumes open loops BY
//     DESIGN (a baked partial-ellipse polyline is a valid trace/engrave target); Nest resolves loops
//     at the STORE boundary instead of a builder payload and visibly SKIPS a no-closed-loop source
//     (store/index.ts:2739, :7762-7765).
// So the R1 claim "every closed-loop-consuming CAM op already fails loud by name" was materially false
// for Face and, worse, silent for Adaptive Clearing -- both are now real refusals, proven end to end
// (builder-boundary test for Face + the pre-existing store guard as the user-visible surface; a real
// dispatch -> real builder throw -> real TOOLPATH_ERROR store-handler drive for Adaptive Clearing,
// src/tests/store/adaptiveClearingGeometryRefusal.test.ts).
//
// An ellipse/elliptical-arc is adapted into a chain of synthetic `line` Sketch3dEntity segments
// (unique ids `${id}~ell${i}`) that chainEntitiesIntoLoops threads exactly like any polyline: a full
// ellipse closes into its own loop; an elliptical arc chains through its shared endpoints with the
// neighbouring lines/arcs of the region.
//
// WO SKC-47-R1 (audit MAJOR 1) -- SRCID LINEAGE. Those synthetic `~ell<i>` ids exist ONLY to give
// chainEntitiesIntoLoops distinct per-segment identity while threading a tessellated curve; they are
// NOT sketch-entity ids and the frozen stable-id contract (docs/stable-id-spec.md, geom-service.ts)
// requires ProfileSegment.srcId to be the ORIGINAL sketch-entity id, because the kernel boundary
// (geom-engine.ts #assignSweptFaceIds) uses srcId as the side-face origin tag and already applies its
// own deterministic `#j` centroid-ordered disambiguator when several faces share one srcId -- exactly
// the case a many-segment tessellated ellipse produces. Emitting the synthetic ids instead would mint
// generated-face tags like `F1:XTR:e~ell0:side` that name no entity in the saved sketch and bypass
// that disambiguator. `adaptEntities` therefore also returns a synthetic-id -> source-entity-id map;
// `rewriteSrcIds` applies it to every loop segment of the extracted ProfileRegion, right before it
// crosses the kernel boundary in `extractSketchProfile`, so the emitted srcId is always the source
// ellipse/elliptical-arc id (or, for a mixed region, the neighbouring line/arc's own untouched id).
//
// Every refusal is a `SketchProfileRefusalCode` -- named, enumerable, and asserted one-by-one in
// src/tests/model3d/sketchProfile.test.ts. Mutation proof (b) in this WO's report targets the
// `open-loop` arm below.

// WO BUG-MODEL-REGION-PICK (Operator, 2026-08-05): the region engine is now the planar ARRANGEMENT in
// sketchRegionArrangement.ts, not regions.ts's whole-profile chainEntitiesIntoLoops. See that
// module's header for the full why; the short version is that chaining is all-or-nothing at PROFILE
// granularity -- one stray edge, or two profiles that abut or cross, and the whole sketch refuses --
// while the user is asking for the ENCLOSED REGIONS, which may be bounded by several profiles' edges
// at once. Everything else in this adapter (finite/degenerate/unsupported refusals, block expansion,
// ellipse tessellation, srcId rewriting) is unchanged and still runs BEFORE the engine.
import { arrangementFaceLoops, computeArrangementRegions } from './sketchRegionArrangement'
import type { PlaneFrame, Sketch3dEntity } from '../../../sketch3d'
import type { ProfileRegion } from '../../../geom/geom-service'
// SKC-BLOCKS Stage 3: a sketch may hold a rigid BLOCK (a locked import, or a
// hand-grouped cluster). A block carries its member geometry verbatim in a local
// frame, so profile extraction must see the block's WORLD member entities, not
// the opaque block itself (which is not profile geometry). expandBlocksForGeometry
// is the SAME flattening bake uses, so the extruded solid and the CAM baked
// profile of one block agree by construction. Non-block sketches are unchanged.
import { expandBlocksForGeometry } from '../../../lib/sketch/blocks'
// The document type comes FROM the component that owns it (the package re-exports it deliberately:
// "a mount imports its document type from the sketcher, never the other way round").
import type { Sketch, SketchEntity } from '../../../lib/sketch/sketcher'
// The ONE ellipse sampler (pure, headless). Reusing it -- rather than re-deriving cos/sin sampling
// here -- is why the 3D modeling workspace solid and the CAM bake approximate the same ellipse identically.
import { tessellateEllipse, tessellateEllipticalArc, type EllipseShape } from '../../../lib/sketch/ellipse'

/** Every way a sketch can fail to produce a profile. Named so a caller reports a reason and a test
 *  asserts THE reason -- "something refused" is not an acceptance gate. */
export type SketchProfileRefusalCode =
  | 'no-geometry'
  | 'unsupported-entity'
  | 'non-finite-coordinate'
  | 'degenerate-entity'
  | 'open-loop'

export interface SketchProfileRefusal {
  code: SketchProfileRefusalCode
  /** UI-ready sentence. The feature dialog shows this verbatim. */
  message: string
  /** The entity ids that caused it, when the refusal is entity-scoped. */
  entityIds: string[]
}

export type SketchProfileResult =
  | {
      ok: true
      /** @deprecated Runtime compatibility for callers not yet migrated to `regions`. */
      profile: ProfileRegion
      regions: [ProfileRegion, ...ProfileRegion[]]
    }
  | { ok: false; refusal: SketchProfileRefusal }

function refuse(code: SketchProfileRefusalCode, message: string, entityIds: string[] = []): SketchProfileRefusal {
  return { code, message, entityIds }
}

/** The kinds that are profile geometry. line/circle/arc exist in both models and adapt structurally;
 *  ellipse/elliptical-arc are CAM-only and are tessellated into line segments below (SKC-47). `point`
 *  is not profile geometry (it constrains, it does not bound) and is ignored by both models alike. */
const PROFILE_KINDS = new Set(['line', 'circle', 'arc', 'ellipse', 'elliptical-arc'])

const finite = (...xs: number[]): boolean => xs.every((x) => Number.isFinite(x))

/** Zero-length lines, zero/negative radii and zero-sweep arcs. Each would emit a degenerate
 *  LoopSegment the kernel cannot build a face from. */
const DEGENERATE_EPS = 1e-9
const TWO_PI = Math.PI * 2

/** Normalized eccentric sweep of an elliptical arc in [0, 2*PI). A zero sweep (start == end) is
 *  degenerate; this is measured on the RAW delta so a genuine ~0 sweep is not remapped to a full
 *  turn the way ellipse.ts's ellipticalArcSweep (used only for point sampling) deliberately does. */
function ellipticalArcSweepNorm(startParam: number, endParam: number): number {
  return ((endParam - startParam) % TWO_PI + TWO_PI) % TWO_PI
}

function entityFinite(e: SketchEntity): boolean {
  if (e.kind === 'line') return finite(e.start.x, e.start.y, e.end.x, e.end.y)
  if (e.kind === 'circle') return finite(e.center.x, e.center.y, e.radius)
  if (e.kind === 'arc') return finite(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle)
  if (e.kind === 'ellipse') return finite(e.center.x, e.center.y, e.majorRadius, e.minorRadius, e.rotation)
  if (e.kind === 'elliptical-arc') {
    return finite(e.center.x, e.center.y, e.majorRadius, e.minorRadius, e.rotation, e.startParam, e.endParam)
  }
  return true
}

function entityDegenerate(e: SketchEntity): boolean {
  if (e.kind === 'line') return Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) <= DEGENERATE_EPS
  if (e.kind === 'circle') return e.radius <= DEGENERATE_EPS
  if (e.kind === 'arc') return e.radius <= DEGENERATE_EPS || Math.abs(e.endAngle - e.startAngle) <= DEGENERATE_EPS
  // A zero (or negative) semi-axis collapses the ellipse to a segment/point; matches bake.ts's own
  // `majorRadius > eps && minorRadius > eps` filter.
  if (e.kind === 'ellipse') return e.majorRadius <= DEGENERATE_EPS || e.minorRadius <= DEGENERATE_EPS
  if (e.kind === 'elliptical-arc') {
    return e.majorRadius <= DEGENERATE_EPS || e.minorRadius <= DEGENERATE_EPS ||
      ellipticalArcSweepNorm(e.startParam, e.endParam) <= DEGENERATE_EPS
  }
  return false
}

/** The bounded ellipse shape both variants share, as ellipse.ts's samplers expect it. */
function ellipseShapeOf(e: Extract<SketchEntity, { kind: 'ellipse' | 'elliptical-arc' }>): EllipseShape {
  return { center: e.center, majorRadius: e.majorRadius, minorRadius: e.minorRadius, rotation: e.rotation }
}

/**
 * A tessellated ellipse/elliptical-arc polyline -> a chain of synthetic `line` Sketch3dEntity
 * segments. Consecutive points become one line each, so the segments meet exactly at shared vertices
 * -- which is precisely what chainEntitiesIntoLoops threads by. The synthetic ids are UNIQUE PER
 * SEGMENT only so chainEntitiesIntoLoops (which keys loop segments by entity id) can thread each one
 * individually; every id this function mints is recorded into `srcIdMap` (synthetic id -> `e.id`) so
 * the caller can rewrite ProfileSegment.srcId back to the real sketch entity before the kernel
 * boundary (SKC-47-R1 MAJOR 1) -- these ids must NEVER reach a ProfileSegment un-rewritten.
 *
 * `closed` (a full ellipse) closes the ring back to `pts[0]` by REUSING that exact vertex, dropping
 * the sampler's duplicate final point. This is not cosmetic: for an axis-aligned ellipse the sampler's
 * closing point evaluates y = minorRadius*sin(2*PI) ~ -6e-15, whose vertexKey `-0.000000` would NOT
 * match the start's `0.000000` -- the loop would fail to close and chainEntitiesIntoLoops would throw
 * a false open-loop. Closing to the identical start vertex eliminates that entirely. An OPEN arc keeps
 * both true endpoints (pts[0], pts[last]) so it can chain with its neighbouring region entities.
 */
function tessellatedLineEntities(
  e: Extract<SketchEntity, { kind: 'ellipse' | 'elliptical-arc' }>,
  pts: { x: number; y: number }[],
  closed: boolean,
  srcIdMap: Map<string, string>,
): Sketch3dEntity[] {
  const ring = closed ? pts.slice(0, -1) : pts
  const out: Sketch3dEntity[] = []
  const lastIndex = closed ? ring.length : ring.length - 1
  for (let i = 0; i < lastIndex; i++) {
    const start = ring[i]
    const end = closed ? ring[(i + 1) % ring.length] : ring[i + 1]
    const id = `${e.id}~ell${i}`
    srcIdMap.set(id, e.id)
    out.push({ id, construction: e.construction, kind: 'line', start, end })
  }
  return out
}

/**
 * CAM `SketchEntity` -> `Sketch3dEntity[]` plus the synthetic-id -> source-entity-id map that lets the
 * caller rewrite ProfileSegment.srcId back to the real sketch entity before the kernel boundary
 * (SKC-47-R1 MAJOR 1). line/circle/arc adapt structurally (identical field names and units, which is
 * why regions.ts can be reused rather than forked) and never enter the map -- their id IS already the
 * source entity id. ellipse/elliptical-arc expand into a chain of synthetic line segments via the
 * shared ellipse.ts sampler (SKC-47); each synthetic id maps back to the source ellipse/arc id.
 * Callers must have already refused genuinely unsupported kinds (spline/text) and any
 * non-finite/degenerate entity.
 */
function adaptEntities(entities: readonly SketchEntity[]): { adapted: Sketch3dEntity[]; srcIdMap: Map<string, string> } {
  const out: Sketch3dEntity[] = []
  const srcIdMap = new Map<string, string>()
  for (const e of entities) {
    if (e.kind === 'line') out.push({ id: e.id, construction: e.construction, kind: 'line', start: e.start, end: e.end })
    else if (e.kind === 'circle') out.push({ id: e.id, construction: e.construction, kind: 'circle', center: e.center, radius: e.radius })
    else if (e.kind === 'arc') {
      out.push({
        id: e.id, construction: e.construction, kind: 'arc',
        center: e.center, radius: e.radius, startAngle: e.startAngle, endAngle: e.endAngle,
      })
    } else if (e.kind === 'ellipse') {
      out.push(...tessellatedLineEntities(e, tessellateEllipse(ellipseShapeOf(e)), /* closed */ true, srcIdMap))
    } else if (e.kind === 'elliptical-arc') {
      out.push(...tessellatedLineEntities(e, tessellateEllipticalArc(ellipseShapeOf(e), e.startParam, e.endParam), /* closed */ false, srcIdMap))
    }
  }
  return { adapted: out, srcIdMap }
}

/**
 * Rewrite tessellation-adapter synthetic srcIds (`${entityId}~ell${i}`) back to their original
 * sketch-entity id, applied to every loop segment right before the ProfileRegion crosses the kernel
 * boundary. Non-ellipse segments are untouched (`srcIdMap.get` misses, so the fallback `?? seg.srcId`
 * keeps the original id). Empty map (no ellipse in this sketch) short-circuits to the same reference
 * -- SKC-47-R1 MAJOR 1: the frozen contract requires srcId to be the ORIGINAL sketch-entity id, and
 * the kernel's own #j centroid-ordered disambiguator (geom-engine.ts #assignSweptFaceIds) already
 * handles multiple side faces sharing one srcId, which a many-segment tessellated ellipse produces.
 */
function rewriteSrcIds(profile: ProfileRegion, srcIdMap: Map<string, string>): ProfileRegion {
  if (srcIdMap.size === 0) return profile
  return {
    ...profile,
    loops: profile.loops.map((loop) =>
      loop.map((seg) => {
        const srcId = srcIdMap.get(seg.srcId) ?? seg.srcId
        return srcId === seg.srcId ? seg : { ...seg, srcId }
      }),
    ),
  }
}

/**
 * Synchronous gate. Returns the refusal, or null when the sketch WILL produce a profile.
 * Split out from `extractSketchProfile` so a feature dialog can ask "is there a profile?" without
 * awaiting the clipper2 boot that region classification needs.
 *
 * Order matters: finite BEFORE degenerate (a NaN radius is not "a zero radius"), and both before
 * loop chaining (chainEntitiesIntoLoops threads NaN through its vertex keys without complaint).
 */
export function validateSketchForProfile(sketch: Sketch | null): SketchProfileRefusal | null {
  if (sketch === null) return refuse('no-geometry', 'No sketch is open.')

  // Flatten any rigid block into its world member geometry FIRST (SKC-BLOCKS
  // Stage 3): the block is a container, its members are the real profile lines/
  // arcs/circles. Without this a locked import (or a grouped cluster) would be
  // refused as 'unsupported-entity'.
  const live = expandBlocksForGeometry(sketch.entities, [], sketch.blockDefs).entities.filter((e) => !e.construction)

  const unsupported = live.filter((e) => e.kind !== 'point' && !PROFILE_KINDS.has(e.kind))
  if (unsupported.length > 0) {
    const kinds = [...new Set(unsupported.map((e) => e.kind))].join(', ')
    return refuse(
      'unsupported-entity',
      `This sketch contains ${kinds} geometry, which cannot be extruded or revolved yet. ` +
        `Delete it, or mark it as construction geometry, to produce a profile.`,
      unsupported.map((e) => e.id),
    )
  }

  const profileEntities = live.filter((e) => PROFILE_KINDS.has(e.kind))
  if (profileEntities.length === 0) {
    return refuse('no-geometry', 'This sketch has no closed profile yet -- draw one to extrude or revolve it.')
  }

  const nonFinite = profileEntities.filter((e) => !entityFinite(e))
  if (nonFinite.length > 0) {
    return refuse(
      'non-finite-coordinate',
      'This sketch has geometry with non-finite coordinates (the constraint solve did not converge). ' +
        'No profile is produced.',
      nonFinite.map((e) => e.id),
    )
  }

  const degenerate = profileEntities.filter((e) => entityDegenerate(e))
  if (degenerate.length > 0) {
    return refuse(
      'degenerate-entity',
      'This sketch has zero-length or zero-radius geometry. No profile is produced.',
      degenerate.map((e) => e.id),
    )
  }

  // THE enclosure check. Delegated to the ONE arrangement engine, whose bounded-face count IS the
  // test: "does this sketch enclose anything at all?". BUG-MODEL-REGION-PICK deliberately changed
  // what this refuses. It used to be a whole-sketch verdict -- a single dangling edge, or two
  // profiles sharing a corner, threw a degree != 2 error and refused EVERY region on the sketch,
  // which is precisely the defect Operator reported ("vertex ... has degree 1" while several closed
  // regions were plainly on screen). Now stray/open/branching geometry contributes what it can and
  // is otherwise ignored, and the refusal fires only when NOTHING is enclosed. The refusal code and
  // sentence are unchanged, because "no closed region here" is still exactly what it means.
  // Mutation proof (b) breaks this arm.
  if (arrangementFaceLoops(adaptEntities(profileEntities).adapted).length === 0) {
    return refuse(
      'open-loop',
      'This sketch profile is not closed. Close the loop (or remove the stray geometry) to extrude or revolve it.',
      [],
    )
  }
  return null
}

/** Post-condition: nothing non-finite reaches the kernel, whatever the region engine did upstream.
 *  This is the last line before `client.makeExtrude`, so it asserts rather than trusts. */
function profileIsFinite(profile: ProfileRegion): boolean {
  const p = profile.plane
  if (!finite(p.origin.x, p.origin.y, p.origin.z, p.normal.x, p.normal.y, p.normal.z, p.xDir.x, p.xDir.y, p.xDir.z)) return false
  return profile.loops.every((loop) =>
    loop.every((seg) =>
      seg.kind === 'line'
        ? finite(seg.a[0], seg.a[1], seg.b[0], seg.b[1])
        : finite(seg.c[0], seg.c[1], seg.r, seg.a0, seg.a1),
    ),
  )
}

/**
 * The accept point. Validates, then delegates face enumeration + nesting classification to
 * `computeArrangementRegions` -- the SAME traversal `validateSketchForProfile` already ran, so the
 * "is there a profile?" answer and the profile itself can never disagree.
 *
 * Returns the full canonical region list. A whole-sketch consumer uses every
 * region; consumers that intentionally require one region choose it explicitly.
 *
 * BUG-MODEL-REGION-PICK: a sketch whose profiles abut, cross, or trail a stray edge now yields its
 * ENCLOSED regions here instead of refusing wholesale, so `regions` -- which is what
 * profileRegionPicker.ts turns into viewport pick candidates and what regionSelector.ts resolves a
 * persisted selection against -- finally contains the sub-region the user is clicking.
 */
export async function extractSketchProfile(
  sketch: Sketch | null,
  frame: PlaneFrame,
  sketchId: string,
): Promise<SketchProfileResult> {
  const refusal = validateSketchForProfile(sketch)
  if (refusal !== null) return { ok: false, refusal }

  const live = expandBlocksForGeometry(sketch!.entities, [], sketch!.blockDefs).entities
    .filter((e) => !e.construction && PROFILE_KINDS.has(e.kind))
  const { adapted, srcIdMap } = adaptEntities(live)

  let regions: ProfileRegion[]
  try {
    regions = await computeArrangementRegions(adapted, sketchId, frame)
  } catch (err) {
    // validateSketchForProfile already ran the same face traversal, so reaching here means the
    // nesting classifier itself refused. Named rather than swallowed.
    return {
      ok: false,
      refusal: refuse('open-loop', `This sketch profile could not be built.${err instanceof Error ? ` (${err.message})` : ''}`),
    }
  }

  if (regions[0] === undefined) {
    return { ok: false, refusal: refuse('no-geometry', 'This sketch has no closed profile yet.') }
  }
  // SKC-47-R1 MAJOR 1: the kernel-facing srcId must be the ORIGINAL sketch-entity id, never the
  // synthetic tessellation id minted above for loop-chaining. Rewrite before the finiteness check
  // (the check doesn't read srcId, but this keeps everything past this line kernel-boundary-ready).
  const rewrittenRegions = regions.map((region) => rewriteSrcIds(region, srcIdMap))
  if (rewrittenRegions.some((region) => !profileIsFinite(region))) {
    return {
      ok: false,
      refusal: refuse('non-finite-coordinate', 'The extracted profile contains non-finite coordinates. No profile is produced.'),
    }
  }
  // Transitional compatibility view: old direct `.profile` reads still get
  // the real first region, while reflection and serialization expose only the
  // canonical `regions` field. Remove this facade when those callers migrate.
  const result: Extract<SketchProfileResult, { ok: true }> = {
    ok: true,
    get profile() {
      return rewrittenRegions[0]
    },
    regions: rewrittenRegions as [ProfileRegion, ...ProfileRegion[]],
  }
  return new Proxy(result, {
    has: (target, property) => property === 'profile' ? false : Reflect.has(target, property),
    ownKeys: (target) => Reflect.ownKeys(target).filter((property) => property !== 'profile'),
    getOwnPropertyDescriptor: (target, property) =>
      property === 'profile' ? undefined : Reflect.getOwnPropertyDescriptor(target, property),
  })
}
