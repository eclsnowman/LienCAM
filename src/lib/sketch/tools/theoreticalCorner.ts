import type {
  PointRef,
  SketchConstraint,
  SketchArcEntity,
  SketchCircleEntity,
  SketchEntity,
  SketchLineEntity,
  SketchEllipseEntity,
  SketchEllipticalArcEntity,
  SketchSplineEntity,
  Vec2,
} from '../types'
import { arcPointAtAngle } from '../sketcher/geometry/arcTessellation'
import type { SketchDoc } from './trimTool'

export interface TheoreticalCornerSpec {
  hostA: SketchLineEntity | SketchArcEntity | SketchCircleEntity | SketchEllipseEntity | SketchEllipticalArcEntity | SketchSplineEntity
  hostB: SketchLineEntity | SketchArcEntity | SketchCircleEntity | SketchEllipseEntity | SketchEllipticalArcEntity | SketchSplineEntity
  corner: Vec2
  trimA: {
    site: 'start' | 'end'
    at: Vec2
    replacement?: SketchLineEntity | SketchArcEntity | SketchEllipticalArcEntity | SketchSplineEntity
    consumedSite?: 'start' | 'end' | null
  }
  trimB: {
    site: 'start' | 'end'
    at: Vec2
    replacement?: SketchLineEntity | SketchArcEntity | SketchEllipticalArcEntity | SketchSplineEntity
    consumedSite?: 'start' | 'end' | null
  }
  phantomPointId: string
  hostAPinId: string
  hostBPinId: string
}

export interface TheoreticalCornerResult {
  /** Original entities with real-profile/midpoint moves applied, followed by the phantom. */
  entities: SketchEntity[]
  /** Original constraints with the consumed host corner removed and construction anchors retargeted. */
  constraints: SketchConstraint[]
  /** Passive intersection pins. Callers append these after their profile-joint constraints. */
  pinConstraints: SketchConstraint[]
  phantomRef: PointRef
  cornerSiteA: PointRef | null
  cornerSiteB: PointRef | null
}

export function refEq(a: PointRef, b: PointRef): boolean {
  return a.entityId === b.entityId && a.site === b.site
}

/**
 * Preserve the untrimmed intersection of two line/circular hosts as a passive
 * reference. Circular replacements retain their host ids, so the same
 * point-on-object pins continue to describe the sharp intersection.
 *
 * The helper deliberately accepts preallocated IDs. Fillet and chamfer have public,
 * deterministic ID order, and a pure geometry helper must not hide ID consumption.
 * The returned arrays also leave caller-created joint constraints separate so each
 * tool can preserve its existing document ordering.
 */
export function buildTheoreticalCorner(
  doc: SketchDoc,
  spec: TheoreticalCornerSpec,
): TheoreticalCornerResult {
  const {
    hostA, hostB, corner, trimA, trimB,
    phantomPointId, hostAPinId, hostBPinId,
  } = spec
  const phantomRef: PointRef = { entityId: phantomPointId, site: 'self' }
  const phantomPoint: SketchEntity = {
    id: phantomPointId,
    kind: 'point',
    construction: true,
    at: corner,
  }
  const cornerSiteA: PointRef | null = trimA.consumedSite === null
    ? null
    : { entityId: hostA.id, site: trimA.consumedSite ?? trimA.site }
  const cornerSiteB: PointRef | null = trimB.consumedSite === null
    ? null
    : { entityId: hostB.id, site: trimB.consumedSite ?? trimB.site }
  const isCornerCoincident = (constraint: SketchConstraint): boolean =>
    cornerSiteA !== null && cornerSiteB !== null && constraint.kind === 'coincident' &&
    ((refEq(constraint.a, cornerSiteA) && refEq(constraint.b, cornerSiteB)) ||
      (refEq(constraint.a, cornerSiteB) && refEq(constraint.b, cornerSiteA)))

  const key = (ref: PointRef): string => `${ref.entityId}|${ref.site}`
  const isConstructionRef = (ref: PointRef): boolean => {
    const entity = doc.entities.find((candidate) => candidate.id === ref.entityId)
    return !!entity && entity.construction
  }

  // Real profile geometry hard-coincident to a trim site follows the trim.
  // Construction references instead stay at the theoretical corner and have
  // their stale coincidence retargeted to the phantom below.
  const moved = new Map<string, Vec2>()
  if (cornerSiteA) moved.set(key(cornerSiteA), trimA.at)
  if (cornerSiteB) moved.set(key(cornerSiteB), trimB.at)
  const staleConstructionCoincidentIds = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const constraint of doc.constraints) {
      if (constraint.kind !== 'coincident' || isCornerCoincident(constraint)) continue
      if (staleConstructionCoincidentIds.has(constraint.id)) continue
      const aKey = key(constraint.a), bKey = key(constraint.b)
      const aMoved = moved.get(aKey)
      const bMoved = moved.get(bKey)
      if (aMoved && !bMoved) {
        if (isConstructionRef(constraint.b)) {
          staleConstructionCoincidentIds.add(constraint.id)
          continue
        }
        /* SKC-41A-MUTATION: propagate-a-to-b */ moved.set(bKey, aMoved)
        grew = true
      } else if (bMoved && !aMoved) {
        if (isConstructionRef(constraint.a)) {
          staleConstructionCoincidentIds.add(constraint.id)
          continue
        }
        /* SKC-41A-MUTATION: propagate-b-to-a */ moved.set(aKey, bMoved)
        grew = true
      }
    }
  }

  const lineEndPosition = (lineId: string, site: 'start' | 'end'): Vec2 | null => {
    const target = moved.get(`${lineId}|${site}`)
    if (target) return target
    const entity = doc.entities.find((candidate) => candidate.id === lineId)
    return entity && entity.kind === 'line' ? entity[site] : null
  }

  // Midpoint-derived points follow any real line whose endpoint moved, so
  // the emitted document already satisfies its surviving midpoint relation.
  for (const constraint of doc.constraints) {
    if (constraint.kind !== 'midpoint') continue
    const start = lineEndPosition(constraint.line, 'start')
    const end = lineEndPosition(constraint.line, 'end')
    if (!start || !end) continue
    if (!moved.has(`${constraint.line}|start`) && !moved.has(`${constraint.line}|end`)) continue
    moved.set(key(constraint.point), {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    })
  }

  const replacementById = new Map<string, SketchLineEntity | SketchArcEntity | SketchEllipticalArcEntity | SketchSplineEntity>()
  if (trimA.replacement) replacementById.set(hostA.id, trimA.replacement)
  if (trimB.replacement) replacementById.set(hostB.id, trimB.replacement)

  const applyMoves = (source: SketchEntity): SketchEntity => {
    const entity = replacementById.get(source.id) ?? source
    if (entity.kind === 'line') {
      const start = moved.get(`${entity.id}|start`)
      const end = moved.get(`${entity.id}|end`)
      return start || end
        ? { ...entity, start: start ?? entity.start, end: end ?? entity.end }
        : entity
    }
    if (entity.kind === 'point') {
      const at = moved.get(`${entity.id}|self`)
      return at ? { ...entity, at } : entity
    }
    if (entity.kind === 'arc') {
      const displacements: Vec2[] = []
      for (const site of ['start', 'end'] as const) {
        const target = moved.get(`${entity.id}|${site}`)
        if (!target) continue
        const angle = site === 'start' ? entity.startAngle : entity.endAngle
        const current = arcPointAtAngle(entity, angle)
        displacements.push({ x: target.x - current.x, y: target.y - current.y })
      }
      if (displacements.length === 0) return entity
      const [translation] = displacements
      if (displacements.some((candidate) =>
        Math.abs(candidate.x - translation.x) > 1e-9 ||
        Math.abs(candidate.y - translation.y) > 1e-9)) {
        throw new Error(
          `buildTheoreticalCorner: arc ${entity.id} endpoints require incompatible rigid translations`,
        )
      }
      // Translating the center moves either endpoint without changing the arc's
      // radius, angles, or CCW sweep contract.
      /* SKC-41A-R1-MUTATION: rigid-arc-reseed */
      return {
        ...entity,
        center: {
          x: entity.center.x + translation.x,
          y: entity.center.y + translation.y,
        },
      }
    }
    return entity
  }

  const retargetedCoincidentPairs: Array<readonly [PointRef, PointRef]> = []
  const hasRetargetedCoincident = (a: PointRef, b: PointRef): boolean =>
    retargetedCoincidentPairs.some(([existingA, existingB]) =>
      (refEq(a, existingA) && refEq(b, existingB)) ||
      /* SKC-41A-R1-MUTATION: unordered-retarget-comparison */
      (refEq(a, existingB) && refEq(b, existingA)))
  const preserveConstraint = (constraint: SketchConstraint): SketchConstraint | null => {
    if (isCornerCoincident(constraint)) return null
    if (constraint.kind !== 'coincident' ||
        !staleConstructionCoincidentIds.has(constraint.id)) return constraint
    /* SKC-41A-MUTATION: retarget-construction-to-phantom */
    const retargeted = isConstructionRef(constraint.a)
      ? { ...constraint, b: phantomRef }
      : { ...constraint, a: phantomRef }
    /* SKC-41A-R1-MUTATION: deduplicate-retargeted-coincidences */
    if (hasRetargetedCoincident(retargeted.a, retargeted.b)) return null
    retargetedCoincidentPairs.push([retargeted.a, retargeted.b])
    return retargeted
  }

  /* SKC-41A-MUTATION: keep-phantom-entity */
  const entities = [...doc.entities.map(applyMoves), phantomPoint]
  const constraints = doc.constraints
    .map(preserveConstraint)
    .filter((constraint): constraint is SketchConstraint => constraint !== null)
  const pinConstraints: SketchConstraint[] = [
    /* SKC-41A-MUTATION: host-a-passive-pin */
    { id: hostAPinId, kind: 'point_on_object', point: phantomRef, object: hostA.id },
    /* SKC-41A-MUTATION: host-b-passive-pin */
    { id: hostBPinId, kind: 'point_on_object', point: phantomRef, object: hostB.id },
  ]

  return {
    entities,
    constraints,
    pinConstraints,
    phantomRef,
    cornerSiteA,
    cornerSiteB,
  }
}

// ---- Chamfer d1xd2 corner lookup (UI-50C) --------------------------------
//
// Given only a CHAMFER LINE id, recover the theoretical (untrimmed) corner
// buildTheoreticalCorner rigged for it: the two host legs (found via the
// chamfer line's own coincident joints, chamferTool.ts's `joints`) and the
// construction phantom point pinned to BOTH of them (point_on_object,
// chamferTool.ts's `hostAPinId`/`hostBPinId`). Named REFUSE rather than a
// virtual intersection when that rig is absent (a hand-drawn line that only
// LOOKS chamfered, or a file predating SKC-41A) or when the CURRENT legs are
// parallel (EPS_ANG precedent, chamferTool.ts) -- both real document states,
// not corruption.

export type ChamferCornerRefusal = 'no-theoretical-corner' | 'parallel-legs'

export interface ResolvedChamferCorner {
  /** Current position of the theoretical (untrimmed) corner. */
  phantom: Vec2
  /** The phantom point itself, ready to use as a dimension/solver operand
   *  (WO-1858: the DRIVING d1xd2 compound mapping pins both setbacks to it).
   *  Same shape ResolvedFilletCorner already exposes for the fillet rig. */
  phantomRef: PointRef
  hostA: SketchLineEntity
  hostB: SketchLineEntity
}

export type ChamferCornerResolution =
  | { ok: true; corner: ResolvedChamferCorner }
  | { ok: false; reason: ChamferCornerRefusal }

// Mirrors chamferTool.ts's EPS_ANG (parallel/collinear guard at construction
// time) so a leg drag that re-parallels the corner refuses by the same name.
const CHAMFER_CORNER_EPS_ANG = 1e-9

/** True only for a line chamferTool.chamferLines created (durable chamfer
 *  identity, UI-50C-R1 major 1). Gates the smart-dim d1xd2 default: an
 *  ordinary line -- even one whose endpoints happen to be coincident-joined
 *  on both sides, like a polyline segment -- must never be routed through
 *  resolveChamferCorner at all, so it can never be misdiagnosed as a
 *  "chamfer with a broken corner". */
export function isChamferSetbackLine(entity: SketchEntity): boolean {
  return entity.kind === 'line' && entity.chamferSetback === true
}

export function resolveChamferCorner(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  lineId: string,
): ChamferCornerResolution {
  const hostViaJoint = (site: 'start' | 'end'): SketchLineEntity | null => {
    const mine: PointRef = { entityId: lineId, site }
    for (const c of constraints) {
      if (c.kind !== 'coincident') continue
      const other = refEq(c.a, mine) ? c.b : refEq(c.b, mine) ? c.a : null
      if (!other || other.entityId === lineId) continue
      const e = entities.find((candidate) => candidate.id === other.entityId)
      if (e && e.kind === 'line') return e
    }
    return null
  }
  const hostA = hostViaJoint('start')
  const hostB = hostViaJoint('end')
  if (!hostA || !hostB) return { ok: false, reason: 'no-theoretical-corner' }
  // UI-50C-R1 major 2: a well-formed rig always names TWO DISTINCT host legs
  // (the joint search above walks the line's OWN start/end coincidents, so
  // this can only collide on a corrupted/hand-crafted document -- refuse
  // rather than measure against a single line twice).
  if (hostA.id === hostB.id) return { ok: false, reason: 'no-theoretical-corner' }

  const pinnedTo = (targetId: string): Set<string> => {
    const s = new Set<string>()
    for (const c of constraints) {
      if (c.kind === 'point_on_object' && c.object === targetId) s.add(c.point.entityId)
    }
    return s
  }
  const onA = pinnedTo(hostA.id)
  const onB = pinnedTo(hostB.id)
  // UI-50C-R1 major 2 (false-phantom hardening): buildTheoreticalCorner's
  // phantom is ALWAYS construction geometry (theoreticalCorner.ts's own
  // `phantomPoint`). A point_on_object pin naming a NON-construction point
  // proves it is unrelated real geometry that merely happens to sit on both
  // legs (an adversarial or coincidental rig) -- never the tool-built
  // phantom. Filter to construction candidates before accepting one.
  let phantomId: string | null = null
  for (const id of onA) {
    if (!onB.has(id)) continue
    const candidate = entities.find((e) => e.id === id)
    if (candidate && candidate.kind === 'point' && candidate.construction) {
      phantomId = id
      break
    }
  }
  if (!phantomId) return { ok: false, reason: 'no-theoretical-corner' }
  const phantomEntity = entities.find((e) => e.id === phantomId)
  if (!phantomEntity || phantomEntity.kind !== 'point') {
    return { ok: false, reason: 'no-theoretical-corner' }
  }

  const dax = hostA.end.x - hostA.start.x, day = hostA.end.y - hostA.start.y
  const dbx = hostB.end.x - hostB.start.x, dby = hostB.end.y - hostB.start.y
  const la = Math.hypot(dax, day), lb = Math.hypot(dbx, dby)
  if (la <= 1e-9 || lb <= 1e-9) return { ok: false, reason: 'parallel-legs' }
  const cosT = Math.max(-1, Math.min(1, Math.abs((dax * dbx + day * dby) / (la * lb))))
  if (Math.acos(cosT) <= CHAMFER_CORNER_EPS_ANG) return { ok: false, reason: 'parallel-legs' }

  return {
    ok: true,
    corner: {
      phantom: phantomEntity.at,
      phantomRef: { entityId: phantomId, site: 'self' },
      hostA,
      hostB,
    },
  }
}

/** Measured d1/d2 setback pair for a chamfer LINE (UI-50C, reference-only):
 *  distance from the resolved theoretical corner to each of the chamfer
 *  line's OWN endpoints. Reading the chamfer line's own (solved) start/end
 *  avoids re-deriving the host trim points -- the joint coincident
 *  constraints chamferTool.ts creates guarantee they agree. Null when the
 *  entity is not a line, or resolveChamferCorner refuses (dimTool "missing
 *  entity" convention -- never a guessed value). */
export function measureChamferSetbacks(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  lineId: string,
): { d1: number; d2: number } | null {
  const line = entities.find((e) => e.id === lineId)
  if (!line || line.kind !== 'line') return null
  const resolved = resolveChamferCorner(entities, constraints, lineId)
  if (!resolved.ok) return null
  const p = resolved.corner.phantom
  return {
    d1: Math.hypot(line.start.x - p.x, line.start.y - p.y),
    d2: Math.hypot(line.end.x - p.x, line.end.y - p.y),
  }
}

// ---- Fillet theoretical-corner lookup by SITE (SKC-75) -------------------
//
// Given a specific LINE ENDPOINT (entityId + 'start'/'end'), find the fillet
// arc joined there (a `tangent` link to this line PLUS a `coincident` joint
// at this exact site -- the two hallmarks filletLines/buildTheoreticalCorner
// always create together), the arc's OTHER tangent leg, and the construction
// phantom point buildTheoreticalCorner pinned (point_on_object) to BOTH legs
// -- the theoretical (untrimmed) corner this specific site was trimmed from.
//
// Three-way result (unlike resolveChamferCorner's two-way ok/refuse):
//   detected=false        this site carries NO fillet evidence at all -- an
//                          ordinary line endpoint, or a site the caller
//                          should treat exactly as before (NOT an error).
//   detected=true, ok      the rig is intact -- callers should redirect to
//                          `corner.phantomRef` instead of the raw site.
//   detected=true, !ok     this site IS fillet-trimmed (the tangent+arc
//                          evidence is present) but the phantom/pin rig is
//                          broken or missing -- callers must FAIL LOUD
//                          (ADR-0003), never silently keep the trimmed site.

export type FilletCornerRefusal = 'no-theoretical-corner'

export interface ResolvedFilletCorner {
  /** The theoretical corner's phantom point, ready to use as a dimension
   *  operand in place of the trimmed site. */
  phantomRef: PointRef
  /** Current position of the theoretical (untrimmed) corner. */
  phantom: Vec2
}

export type FilletCornerSiteDetection =
  | { detected: false }
  | { detected: true; ok: true; corner: ResolvedFilletCorner }
  | { detected: true; ok: false; reason: FilletCornerRefusal }

/** True iff `a` and `b` are linked by a `tangent` constraint (order-independent). */
function isTangentPair(constraints: readonly SketchConstraint[], a: string, b: string): boolean {
  return constraints.some((c) =>
    c.kind === 'tangent' && ((c.a === a && c.b === b) || (c.a === b && c.b === a)))
}

export function resolveFilletCornerSite(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  lineId: string,
  site: 'start' | 'end',
): FilletCornerSiteDetection {
  const mine: PointRef = { entityId: lineId, site }
  // Find an ARC coincident-joined at exactly this site, tangent to this line.
  let arcId: string | null = null
  let arcSite: 'start' | 'end' | null = null
  for (const c of constraints) {
    if (c.kind !== 'coincident') continue
    const other = refEq(c.a, mine) ? c.b : refEq(c.b, mine) ? c.a : null
    if (!other || (other.site !== 'start' && other.site !== 'end')) continue
    const e = entities.find((candidate) => candidate.id === other.entityId)
    if (e && e.kind === 'arc') { arcId = e.id; arcSite = other.site; break }
  }
  // No arc joined here at all -- an ordinary (non-filleted) site. Not an
  // error: the caller keeps its normal, unredirected behavior.
  if (!arcId || !arcSite || !isTangentPair(constraints, arcId, lineId)) return { detected: false }

  // Fillet evidence confirmed (a tangent arc IS joined at this exact site) --
  // every path from here on either resolves the phantom or refuses BY NAME;
  // it may never fall back to "not detected".
  const otherArcSite: 'start' | 'end' = arcSite === 'start' ? 'end' : 'start'
  const otherArcRef: PointRef = { entityId: arcId, site: otherArcSite }
  let otherLegId: string | null = null
  for (const c of constraints) {
    if (c.kind !== 'coincident') continue
    const other = refEq(c.a, otherArcRef) ? c.b : refEq(c.b, otherArcRef) ? c.a : null
    if (!other) continue
    const e = entities.find((candidate) => candidate.id === other.entityId)
    if (e && e.kind === 'line' && isTangentPair(constraints, arcId, e.id)) { otherLegId = e.id; break }
  }
  if (!otherLegId) return { detected: true, ok: false, reason: 'no-theoretical-corner' }

  const pinnedTo = (targetId: string): Set<string> => {
    const s = new Set<string>()
    for (const c of constraints) {
      if (c.kind === 'point_on_object' && c.object === targetId) s.add(c.point.entityId)
    }
    return s
  }
  const onThis = pinnedTo(lineId)
  const onOther = pinnedTo(otherLegId)
  let phantomId: string | null = null
  for (const id of onThis) {
    if (!onOther.has(id)) continue
    const candidate = entities.find((e) => e.id === id)
    // False-phantom hardening (mirrors resolveChamferCorner): only a
    // CONSTRUCTION point qualifies -- buildTheoreticalCorner's phantom is
    // always construction geometry, so real geometry that merely happens to
    // sit on both legs can never be misdiagnosed as the rig.
    if (candidate && candidate.kind === 'point' && candidate.construction) {
      phantomId = id
      break
    }
  }
  if (!phantomId) return { detected: true, ok: false, reason: 'no-theoretical-corner' }
  const phantomEntity = entities.find((e) => e.id === phantomId)
  if (!phantomEntity || phantomEntity.kind !== 'point') {
    return { detected: true, ok: false, reason: 'no-theoretical-corner' }
  }
  return {
    detected: true,
    ok: true,
    corner: {
      phantomRef: { entityId: phantomId, site: 'self' },
      phantom: phantomEntity.at,
    },
  }
}
