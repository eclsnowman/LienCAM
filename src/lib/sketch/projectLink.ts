// LIVE MODEL REFERENCES for Project/Use geometry (WO-1864).
//
// A projected model face/edge/vertex commits fixed pieces that each carry a `projectionLink`
// (types.ts). This module is the pure half of keeping them tied to the model: given a way to
// re-resolve a stored source into fresh sketch-local paths/points, it rewrites the linked pieces'
// coordinates IN PLACE (same entity ids, so every constraint, dimension and chain joint stays
// attached). Their Project/Use Fix grounds them at the new coordinates, so the host's next solve
// carries everything constrained to them along -- the same solve, not a later interaction.
//
// THE RULE WHEN A SOURCE CANNOT BE FOLLOWED (the refusal bar, LIENCAM rule 11): nothing is
// refused and nothing the operator drew is destroyed. A source that is gone, ambiguous, or whose
// shape no longer maps piece-for-piece onto the stored pieces leaves those pieces exactly where
// they last stood, marked `unresolved`, still grounded, still solving and still baking. The host
// says so in one sentence naming the source. When the source comes back (undo, a re-added
// feature), the next pass resolves it again and the mark clears.
//
// Breaking a link, editing a linked piece's geometry, or pasting a copy all drop the link and
// leave an ordinary static copy (WO-058 behaviour, provenance colour kept).

import type { Loop2D } from '../../types'
import { liftLoops } from './lift'
import type { ProjectCandidate } from './projectUse'
import type {
  PierceConstraint, PointRef, SketchConstraint, SketchEntity, SketchPierceSource, SketchProjectionLink,
  SketchProjectionSourceKind, Vec2,
} from './types'

/** Fresh sketch-local geometry for one stored source, or why it cannot be found. */
export type ProjectionSourceGeometry =
  | { ok: true; paths: readonly Loop2D[]; points: readonly Vec2[] }
  | { ok: false; reason: string }

/** Resolve one stored source. Called once per link group per pass. */
export type ProjectionSourceResolver = (link: SketchProjectionLink) => ProjectionSourceGeometry

export interface ProjectionRelinkResult {
  /** The updated entity list (the input array itself when nothing changed). */
  entities: SketchEntity[]
  /** True when any coordinate or unresolved mark changed. */
  changed: boolean
  /** Sources that were resolved before this pass and could not be followed now. */
  newlyUnresolved: SketchProjectionLink[]
  /** Every source that could not be followed this pass (new or already marked). */
  unresolved: SketchProjectionLink[]
}

const MATCH_EPS = 1e-9

/**
 * Stamp a fresh Project commit's entities with their live link when the candidate is a model
 * source (face/edge/vertex carrying its source identity). buildProjectCommit emits points first,
 * then each path's lifted pieces in path order; the per-path piece counts come from the same
 * per-loop lift, so every piece records its path and index. A CAM layer loop -- no model to
 * follow -- is returned unchanged. The link id derives from the first piece's id, so a commit
 * needs no extra id.
 */
export function linkProjectedEntities(
  entities: readonly SketchEntity[],
  candidate: ProjectCandidate,
): SketchEntity[] {
  const identity = candidate.sourceIdentity
  if (candidate.sourceKind === 'cam-layer-loop' || identity === undefined || entities.length === 0) {
    return [...entities]
  }
  const points = candidate.points ?? []
  let n = 0
  const piecesPerPath = candidate.paths.map((path) => liftLoops([path], { newId: () => `count-${n++}` }).entities.length)
  if (points.length + piecesPerPath.reduce((a, b) => a + b, 0) !== entities.length) return [...entities]
  const base = {
    id: `projection:${entities[0].id}`,
    sourceKind: candidate.sourceKind as SketchProjectionSourceKind,
    bodyId: identity.bodyId,
    stableId: identity.stableId,
    sourceLabel: candidate.sourceLabel,
  }
  const slots: Array<{ path: number; piece: number; pathPieces: number }> = [
    ...points.map((_, piece) => ({ path: -1, piece, pathPieces: points.length })),
    ...piecesPerPath.flatMap((count, path) =>
      Array.from({ length: count }, (_, piece) => ({ path, piece, pathPieces: count }))),
  ]
  return entities.map((entity, index) => ({ ...entity, projectionLink: { ...base, ...slots[index] } }))
}

export function withoutProjectionLink(entity: SketchEntity): SketchEntity {
  if (entity.projectionLink === undefined) return entity
  const { projectionLink: _link, ...rest } = entity
  return rest as SketchEntity
}

/** Linked projected entity ids within a selection. */
export function projectionLinkedIdsIn(
  entities: readonly SketchEntity[],
  selectedIds: readonly string[],
): string[] {
  const selected = new Set(selectedIds)
  return entities
    .filter((entity) => selected.has(entity.id) && entity.projectionLink !== undefined)
    .map((entity) => entity.id)
}

/** Break the link on exactly the given entities: they keep their coordinates, their Project/Use
 *  grounding and their provenance colour, and stop following the model. Null when none is linked. */
export function breakProjectionLinks(
  entities: readonly SketchEntity[],
  entityIds: readonly string[],
): SketchEntity[] | null {
  const ids = new Set(entityIds)
  if (!entities.some((entity) => ids.has(entity.id) && entity.projectionLink !== undefined)) return null
  return entities.map((entity) => (ids.has(entity.id) ? withoutProjectionLink(entity) : entity))
}

/** True when any entity still follows a model source. */
export function hasProjectionLinks(entities: readonly SketchEntity[]): boolean {
  return entities.some((entity) => entity.projectionLink !== undefined)
}

/** One plain sentence naming the sources a sketch could not find (rule 11: say it, never refuse).
 *  `sketchLabel` is the sketch's own tree name ("Sketch on YZ"). */
export function unresolvedReferenceSentence(
  sketchLabel: string,
  links: readonly SketchProjectionLink[],
): string {
  const names = [...new Set(links.map((link) => link.sourceLabel))]
  const named = names.map((name) => `"${name}"`).join(', ')
  return names.length === 1
    ? `${sketchLabel}: the projected reference ${named} could not be found in the model; ` +
      'its geometry stays where it last stood.'
    : `${sketchLabel}: the projected references ${named} could not be found in the model; ` +
      'their geometry stays where it last stood.'
}

// ---- Piece mapping -------------------------------------------------------------------------------

function sameGeometry(a: SketchEntity, b: SketchEntity): boolean {
  const close = (p: Vec2, q: Vec2): boolean => Math.abs(p.x - q.x) <= MATCH_EPS && Math.abs(p.y - q.y) <= MATCH_EPS
  if (a.kind === 'point' && b.kind === 'point') return close(a.at, b.at)
  if (a.kind === 'line' && b.kind === 'line') return close(a.start, b.start) && close(a.end, b.end)
  if (a.kind === 'arc' && b.kind === 'arc') {
    return close(a.center, b.center) && Math.abs(a.radius - b.radius) <= MATCH_EPS
      && Math.abs(a.startAngle - b.startAngle) <= MATCH_EPS && Math.abs(a.endAngle - b.endAngle) <= MATCH_EPS
  }
  if (a.kind === 'circle' && b.kind === 'circle') {
    return close(a.center, b.center) && Math.abs(a.radius - b.radius) <= MATCH_EPS
  }
  return false
}

/** Squared displacement between a stored piece and a fresh one of the same kind. */
function displacement(a: SketchEntity, b: SketchEntity): number {
  const d = (p: Vec2, q: Vec2): number => (p.x - q.x) ** 2 + (p.y - q.y) ** 2
  if (a.kind === 'point' && b.kind === 'point') return d(a.at, b.at)
  if (a.kind === 'line' && b.kind === 'line') return d(a.start, b.start) + d(a.end, b.end)
  if ((a.kind === 'arc' || a.kind === 'circle') && (b.kind === 'arc' || b.kind === 'circle')) {
    return d(a.center, b.center) + (a.radius - b.radius) ** 2
  }
  return Infinity
}

/** Every traversal of one fresh path that yields the same pieces in a different order: an open
 *  path forward and backward, a closed loop from each start in both directions. The stored
 *  traversal is matched to the closest one so a re-extracted edge that comes back reversed or a
 *  face loop that starts at another corner does not swap which endpoint a constraint holds. */
function pathVariants(path: Loop2D): Loop2D[] {
  if (path.segments !== undefined && path.segments.length > 0) return [path]
  const forward = path.points
  const backward = [...forward].reverse()
  if (!path.closed) return [path, { ...path, points: backward }]
  const out: Loop2D[] = []
  for (const base of [forward, backward]) {
    for (let start = 0; start < base.length; start++) {
      out.push({ ...path, points: [...base.slice(start), ...base.slice(0, start)] })
    }
  }
  return out
}

function freshPieces(path: Loop2D): SketchEntity[] {
  let n = 0
  return liftLoops([path], { newId: () => `fresh-${n++}` }).entities
}

/** Map a fresh path's pieces onto the stored pieces of the same path, choosing the traversal
 *  closest to where they stand. Null when the shape no longer corresponds piece-for-piece: the
 *  fresh path has a different piece count than the one committed, or a piece changed kind. Pieces
 *  the operator deleted or detached are simply absent from `stored`; the rest keep their index. */
function mapPath(stored: readonly SketchEntity[], path: Loop2D): SketchEntity[] | null {
  const linkOf = (entity: SketchEntity): SketchProjectionLink => entity.projectionLink as SketchProjectionLink
  let best: SketchEntity[] | null = null
  let bestCost = Infinity
  for (const variant of pathVariants(path)) {
    const pieces = freshPieces(variant)
    const picked: SketchEntity[] = []
    let cost = 0
    for (const entity of stored) {
      const fresh = pieces.length === linkOf(entity).pathPieces ? pieces[linkOf(entity).piece] : undefined
      if (fresh === undefined || fresh.kind !== entity.kind) { cost = Infinity; break }
      cost += displacement(entity, fresh)
      picked.push(fresh)
    }
    if (cost < bestCost) {
      bestCost = cost
      best = picked
    }
  }
  return best
}

/** The fresh piece written onto a stored one: fresh geometry, stored identity and flags. */
function adopt(stored: SketchEntity, fresh: SketchEntity, link: SketchProjectionLink): SketchEntity {
  const { unresolved: _unresolved, ...resolvedLink } = link
  if (sameGeometry(stored, fresh)) {
    return link.unresolved ? { ...stored, projectionLink: resolvedLink } : stored
  }
  return {
    ...stored,
    ...geometryOf(fresh),
    projectionLink: resolvedLink,
  } as SketchEntity
}

function geometryOf(entity: SketchEntity): Partial<SketchEntity> {
  switch (entity.kind) {
    case 'point': return { at: { ...entity.at } }
    case 'line': return { start: { ...entity.start }, end: { ...entity.end } }
    case 'arc':
      return {
        center: { ...entity.center }, radius: entity.radius,
        startAngle: entity.startAngle, endAngle: entity.endAngle,
      }
    case 'circle': return { center: { ...entity.center }, radius: entity.radius }
    default: return {}
  }
}

function markUnresolved(entity: SketchEntity): SketchEntity {
  const link = entity.projectionLink
  if (link === undefined || link.unresolved) return entity
  return { ...entity, projectionLink: { ...link, unresolved: true } }
}

/**
 * Re-resolve every linked piece of a sketch and write fresh coordinates onto the same entities.
 * Unlinked entities are returned untouched. The resolver is called once per link group.
 */
export function relinkProjectedEntities(
  entities: readonly SketchEntity[],
  resolve: ProjectionSourceResolver,
): ProjectionRelinkResult {
  const groups = new Map<string, SketchEntity[]>()
  const replaced = new Map<string, SketchEntity>()
  const claimed = new Set<string>()
  for (const entity of entities) {
    const link = entity.projectionLink
    if (link === undefined) continue
    // A link only means something on the committed projected piece itself. A copy made by a tool
    // that spreads the entity (transform copy drops provenance), a piece moved in place
    // (projectionDetached), or a second holder of the same piece slot follows nothing -- it would
    // otherwise be snapped onto the source -- so its stale link is dropped here.
    const slot = `${link.id}|${link.path}|${link.piece}`
    if (entity.provenance !== 'projected' || entity.projectionDetached === true || claimed.has(slot)) {
      replaced.set(entity.id, withoutProjectionLink(entity))
      continue
    }
    claimed.add(slot)
    const group = groups.get(link.id)
    if (group) group.push(entity)
    else groups.set(link.id, [entity])
  }
  if (groups.size === 0 && replaced.size === 0) {
    return { entities: entities as SketchEntity[], changed: false, newlyUnresolved: [], unresolved: [] }
  }

  const newlyUnresolved: SketchProjectionLink[] = []
  const unresolved: SketchProjectionLink[] = []
  for (const group of groups.values()) {
    const head = group[0].projectionLink as SketchProjectionLink
    const fail = (): void => {
      unresolved.push(head)
      if (group.some((entity) => entity.projectionLink?.unresolved !== true)) newlyUnresolved.push(head)
      for (const entity of group) replaced.set(entity.id, markUnresolved(entity))
    }
    let geometry: ProjectionSourceGeometry
    try {
      geometry = resolve(head)
    } catch (error) {
      geometry = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (!geometry.ok) { fail(); continue }

    // Stored pieces per path, in piece order. A broken or deleted piece is simply absent; the
    // fresh path must still produce a piece at every stored index to be followed.
    const byPath = new Map<number, SketchEntity[]>()
    for (const entity of group) {
      const link = entity.projectionLink as SketchProjectionLink
      const list = byPath.get(link.path) ?? []
      list.push(entity)
      byPath.set(link.path, list)
    }
    const updates: SketchEntity[] = []
    let followed = true
    for (const [path, stored] of byPath) {
      stored.sort((a, b) => (a.projectionLink as SketchProjectionLink).piece - (b.projectionLink as SketchProjectionLink).piece)
      if (path === -1) {
        for (const entity of stored) {
          const piece = (entity.projectionLink as SketchProjectionLink).piece
          const point = geometry.points[piece]
          if (point === undefined || entity.kind !== 'point' || geometry.points.length !== entity.projectionLink?.pathPieces) {
            followed = false
            break
          }
          updates.push(adopt(entity, { ...entity, at: { x: point.x, y: point.y } }, entity.projectionLink as SketchProjectionLink))
        }
        if (!followed) break
        continue
      }
      const freshPath = geometry.paths[path]
      if (freshPath === undefined) { followed = false; break }
      const mapped = mapPath(stored, freshPath)
      if (mapped === null) { followed = false; break }
      stored.forEach((entity, index) => {
        updates.push(adopt(entity, mapped[index], entity.projectionLink as SketchProjectionLink))
      })
    }
    if (!followed) { fail(); continue }
    for (const entity of updates) replaced.set(entity.id, entity)
  }

  let changed = false
  const next = entities.map((entity) => {
    const update = replaced.get(entity.id)
    if (update === undefined || update === entity) return entity
    changed = true
    return update
  })
  return { entities: changed ? next : entities as SketchEntity[], changed, newlyUnresolved, unresolved }
}

// ---- Pierce (WO-1865) ----------------------------------------------------------------------------
//
// A pierce holds one sketch point where a MODEL edge crosses the sketch plane. It rides the same
// stored source identity as a live projection (body id followed to its live descendant +
// persistent edge id); the host resolves that edge to a polyline in SKETCH-LOCAL 3D (x, y in the
// plane, z = height above it along the plane normal) and this module finds the crossing. The
// solver never sees the model: the crossing is written onto the constraint (`at`) and gcsMapping
// maps it as two ordinary coordinate equations, so the point and everything tied to it move in
// the same solve.
//
// THE REFUSAL BAR (rule 11): an edge that does not presently cross the plane (parallel to it, or
// a curved edge whose span stays on one side) or that cannot be found is never a refusal. The
// constraint keeps its last crossing, is marked `unresolved`, the sketch still solves, and the host
// says so in one sentence. The next pass that finds a crossing clears the mark.

/** A point in sketch-local 3D: (x, y) in the sketch plane, z = signed height above it. */
export interface SketchLocal3 {
  x: number
  y: number
  z: number
}

export type PierceCrossing =
  | { ok: true; at: Vec2 }
  | { ok: false; reason: string }

/** Resolve one pierce source to its crossing; `near` is the point's last crossing (picks among
 *  several crossings of a curved edge). */
export type PierceResolver = (source: SketchPierceSource, near: Vec2) => PierceCrossing

const PIERCE_STRAIGHT_REL = 1e-9
const PIERCE_PARALLEL_REL = 1e-12

/**
 * Where an edge polyline crosses the sketch plane (z = 0). A STRAIGHT edge is taken as its
 * infinite line, so a sketch on an offset plane is still pierced by an edge that ends short of it;
 * only an edge parallel to the plane has no crossing. A CURVED edge (a tessellated arc or spline)
 * must cross within its own span; when it crosses more than once the crossing nearest `near` wins.
 */
export function edgePlaneCrossing(points: readonly SketchLocal3[], near: Vec2): PierceCrossing {
  if (points.length < 2 || !points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) {
    return { ok: false, reason: 'degenerate-edge' }
  }
  const first = points[0]
  const last = points[points.length - 1]
  const d = { x: last.x - first.x, y: last.y - first.y, z: last.z - first.z }
  const length = Math.hypot(d.x, d.y, d.z)
  const scale = Math.max(1, ...points.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z))))
  const straight = length > PIERCE_STRAIGHT_REL * scale && points.every((p) => {
    // Distance of p from the chord first -> last.
    const r = { x: p.x - first.x, y: p.y - first.y, z: p.z - first.z }
    const c = { x: r.y * d.z - r.z * d.y, y: r.z * d.x - r.x * d.z, z: r.x * d.y - r.y * d.x }
    return Math.hypot(c.x, c.y, c.z) / length <= PIERCE_STRAIGHT_REL * scale
  })
  if (straight) {
    if (Math.abs(d.z) <= PIERCE_PARALLEL_REL * length) {
      return { ok: false, reason: Math.abs(first.z) <= PIERCE_STRAIGHT_REL * scale ? 'in-plane' : 'parallel' }
    }
    const t = -first.z / d.z
    return { ok: true, at: { x: first.x + t * d.x, y: first.y + t * d.y } }
  }
  const crossings: Vec2[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (a.z === 0) crossings.push({ x: a.x, y: a.y })
    if ((a.z < 0 && b.z > 0) || (a.z > 0 && b.z < 0)) {
      const t = a.z / (a.z - b.z)
      crossings.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) })
    }
  }
  if (last.z === 0) crossings.push({ x: last.x, y: last.y })
  if (crossings.length === 0) return { ok: false, reason: 'no-crossing' }
  let best = crossings[0]
  let bestDistance = Infinity
  for (const crossing of crossings) {
    const distance = Math.hypot(crossing.x - near.x, crossing.y - near.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = crossing
    }
  }
  return { ok: true, at: best }
}

/** The pierce constraint for a point and a crossing just picked. */
export function makePierceConstraint(
  id: string,
  point: PointRef,
  source: SketchPierceSource,
  at: Vec2,
): PierceConstraint {
  return { id, kind: 'pierce', point: { ...point }, at: { x: at.x, y: at.y }, source: { ...source } }
}

/** Apply a pierce: any older pierce on the same point site is replaced (re-piercing a point is a
 *  re-pick, never a conflict to refuse). */
export function withPierce(
  constraints: readonly SketchConstraint[],
  pierce: PierceConstraint,
): SketchConstraint[] {
  return [
    ...constraints.filter((c) => !(c.kind === 'pierce'
      && c.point.entityId === pierce.point.entityId && c.point.site === pierce.point.site)),
    pierce,
  ]
}

export function hasPierceConstraints(constraints: readonly SketchConstraint[]): boolean {
  return constraints.some((c) => c.kind === 'pierce')
}

export interface PierceUnresolved {
  source: SketchPierceSource
  reason: string
}

export interface PierceRelinkResult {
  /** The updated constraint list (the input array itself when nothing changed). */
  constraints: SketchConstraint[]
  changed: boolean
  /** Pierces that crossed before this pass and do not now. */
  newlyUnresolved: PierceUnresolved[]
  /** Every pierce without a crossing this pass. */
  unresolved: PierceUnresolved[]
}

/**
 * Re-resolve every pierce against the current model and write the fresh crossing onto it. A pierce
 * whose edge cannot be followed keeps `at` (the point stays where it last was) and is marked
 * unresolved. Nothing is deleted.
 */
export function relinkPierceConstraints(
  constraints: readonly SketchConstraint[],
  resolve: PierceResolver,
): PierceRelinkResult {
  const newlyUnresolved: PierceUnresolved[] = []
  const unresolved: PierceUnresolved[] = []
  let changed = false
  const next = constraints.map((c): SketchConstraint => {
    if (c.kind !== 'pierce') return c
    let crossing: PierceCrossing
    try {
      crossing = resolve(c.source, c.at)
    } catch (error) {
      crossing = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (!crossing.ok || !Number.isFinite(crossing.at.x) || !Number.isFinite(crossing.at.y)) {
      const miss = { source: c.source, reason: crossing.ok ? 'non-finite-point' : crossing.reason }
      unresolved.push(miss)
      if (c.unresolved === miss.reason) return c
      if (c.unresolved === undefined) newlyUnresolved.push(miss)
      changed = true
      return { ...c, unresolved: miss.reason }
    }
    if (c.unresolved === undefined && c.at.x === crossing.at.x && c.at.y === crossing.at.y) return c
    const { unresolved: _unresolved, ...resolved } = c
    changed = true
    return { ...resolved, at: { x: crossing.at.x, y: crossing.at.y } }
  })
  return { constraints: changed ? next : constraints as SketchConstraint[], changed, newlyUnresolved, unresolved }
}

/** Why a pierce has no crossing, in the operator's words. */
export function pierceMissPhrase(reason: string): string {
  switch (reason) {
    case 'parallel': return 'runs parallel to the sketch plane, so it does not presently cross it'
    case 'in-plane': return 'lies in the sketch plane, so it has no single crossing'
    case 'no-crossing': return 'does not presently cross the sketch plane'
    default: return 'could not be found in the model'
  }
}

/** One plain sentence per pierce that lost its crossing (rule 11: say it, never refuse). */
export function pierceUnresolvedSentence(sketchLabel: string, misses: readonly PierceUnresolved[]): string {
  return misses
    .map((miss) => `${sketchLabel}: the model edge "${miss.source.sourceLabel}" ${pierceMissPhrase(miss.reason)}; ` +
      'its pierced point stays where it last was.')
    .join(' ')
}
