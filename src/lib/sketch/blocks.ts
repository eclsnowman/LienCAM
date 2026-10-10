// SKC-BLOCKS Stage 1 - group selected entities into a rigid block, and explode
// a block back into ordinary entities.
//
// A block is the solver-inert entity doctrine (ellipse/spline/text carry their
// shape verbatim; only an anchor point enters the solve) generalized from "one
// carried shape" to "a carried nested sub-sketch". See types.ts SketchBlockEntity.
//
// COORDINATE FRAME. Members live in the block's LOCAL frame. World placement:
//   world = origin + Rot(rotation) * (scale * local)
// Stage 1 commits rotation=0, scale=1 (pure translation), so a block created here
// stores members as (worldAtGroupTime - origin). blockMemberWorldEntities()
// reverses that for bake/render/explode. The transform is implemented for the
// general (rotation, scale) case so Stage 2 (typed scale/rotation) is a rider.
//
// PURE module: every function returns NEW document data and never mutates its
// input. The store applies the result as one undo step and re-solves.

import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, SketchDimensionKind,
  SketchBlockEntity, BlockDefinition, FixConstraint, Vec2, PointRef,
} from './types'
import { constraintRefIds, dimensionRefIds } from './refIds'

// ---- Definition / instance registry (SKC-BLOCKS Stage 5) -------------------
//
// A block is EITHER a single-use inline block (Stage 1: members live on the
// entity, defId undefined) OR a def-backed INSTANCE (Stage 5: defId names a
// shared BlockDefinition in sketch.blockDefs; the entity's own members are
// empty). Many instances share ONE definition, so editing the definition once
// updates every instance. `resolveBlockMembers` is the SINGLE resolver every
// geometry consumer calls -- never read block.members directly, or an instance
// renders empty.

export interface BlockMembers {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  dimensions: SketchDimension[]
}

/**
 * The EFFECTIVE members of a block: the shared definition's members when the
 * block is a def-backed instance (defId set), else the block's own inline
 * members (single-use). A def-backed instance whose definition is missing is a
 * corrupt document and throws loudly (ADR-0003, never silently renders empty).
 */
export function resolveBlockMembers(
  block: SketchBlockEntity,
  defs?: Record<string, BlockDefinition>,
): BlockMembers {
  if (block.defId === undefined) return block.members
  const def = defs?.[block.defId]
  if (!def) {
    throw new Error(
      `[ADR-0003] block instance ${block.id} references block definition ${block.defId}, ` +
        `which is not present in this sketch's blockDefs.`,
    )
  }
  return def.members
}

// ---- Per-instance id namespacing -------------------------------------------
//
// Two instances of ONE definition share the definition's member entity/
// constraint/dimension ids. When >1 instance is flattened into the SAME list
// (bake / CAM geometry via expandBlocksForGeometry, or a permanent explode),
// those shared ids would COLLIDE -- extractChains keys chains + terminals off
// entity.id, so duplicate ids would cross-join two instances' geometry, and the
// solver rejects duplicate top-level ids. Namespacing each instance's member
// ids by the instance id keeps them distinct and independent. Loop ids derive
// from WORLD coordinates (loopId.ts), never from entity ids, so namespacing is
// invisible to ADR-0019 stable-id stability -- two instances at different
// positions still get distinct, stable, content-derived loop ids.
//
// NOT applied when a SINGLE block is materialized alone (render/hit-test, or
// single-use explode), where ids are canonical and no collision is possible.

const INSTANCE_ID_SEP = '~i~'

function instanceIdMapper(instanceId: string): (id: string) => string {
  return (id: string) => `${instanceId}${INSTANCE_ID_SEP}${id}`
}

function remapPointRef(r: PointRef, map: (id: string) => string): PointRef {
  return { ...r, entityId: map(r.entityId) }
}

/** Rewrite every entity-id reference (and the constraint's own id) through
 *  `map`. Mirrors constraintRefIds exactly so no ref kind is missed. */
function remapConstraintIds(c: SketchConstraint, map: (id: string) => string): SketchConstraint {
  const base = { ...c, id: map(c.id) }
  switch (base.kind) {
    case 'coincident':
    case 'continuity_g1':
    case 'continuity_g2':
      return { ...base, a: remapPointRef(base.a, map), b: remapPointRef(base.b, map) }
    case 'concentric':
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'tangent':
    case 'equal':
      return { ...base, a: map(base.a), b: map(base.b) }
    case 'horizontal':
    case 'vertical':
      return base.line !== undefined
        ? { ...base, line: map(base.line) }
        : {
            ...base,
            points: (base.points ?? []).map((p) => remapPointRef(p, map)) as typeof base.points,
          }
    case 'midpoint':
      return { ...base, point: remapPointRef(base.point, map), line: map(base.line) }
    case 'symmetric':
      return { ...base, a: remapPointRef(base.a, map), b: remapPointRef(base.b, map), axis: map(base.axis) }
    case 'fix':
      if (base.point) return { ...base, point: remapPointRef(base.point, map) }
      return base.entityId !== undefined ? { ...base, entityId: map(base.entityId) } : base
    case 'point_on_object':
      return { ...base, point: remapPointRef(base.point, map), object: map(base.object) }
    case 'pierce':
      return { ...base, point: remapPointRef(base.point, map) }
  }
}

/** Rewrite every entity-id reference (and the dimension's own id) through
 *  `map`. Mirrors dimensionRefIds exactly. */
function remapDimensionIds(d: SketchDimension, map: (id: string) => string): SketchDimension {
  const base = { ...d, id: map(d.id) }
  switch (base.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY':
      return { ...base, a: remapPointRef(base.a, map), b: remapPointRef(base.b, map) }
    // WO-1867: both of an ordinate's point refs (datum + measured point) move
    // onto the block's fresh ids -- mirrors dimensionRefIds, which is what
    // decides an ordinate is INTERNAL to the block in the first place.
    case 'ordinate':
      return { ...base, origin: remapPointRef(base.origin, map), point: remapPointRef(base.point, map) }
    case 'distancePL':
      return { ...base, point: remapPointRef(base.point, map), line: map(base.line) }
    case 'angle':
      return { ...base, a: map(base.a), b: map(base.b) }
    // WO-1868: all three point refs (vertex + both legs) move onto the block's
    // fresh ids, mirroring dimensionRefIds.
    case 'angle3':
      return { ...base, vertex: remapPointRef(base.vertex, map), a: remapPointRef(base.a, map), b: remapPointRef(base.b, map) }
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
    case 'd1xd2':
      return { ...base, entityId: map(base.entityId) }
  }
}

// ---- Frame transform (local <-> world) ------------------------------------

export interface BlockFrame {
  origin: Vec2
  rotation: number
  scale: number
}

const TWO_PI = Math.PI * 2
export function normAngle(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

/** Map a LOCAL point into sketch-world coords: origin + Rot(rotation)*scale*local. */
export function blockLocalToWorld(p: Vec2, frame: BlockFrame): Vec2 {
  const sx = p.x * frame.scale
  const sy = p.y * frame.scale
  const c = Math.cos(frame.rotation)
  const s = Math.sin(frame.rotation)
  return {
    x: frame.origin.x + (c * sx - s * sy),
    y: frame.origin.y + (s * sx + c * sy),
  }
}

/** Map a sketch-world point back into a frame's LOCAL coords (inverse of
 *  blockLocalToWorld). Used at group time (rotation=0, scale=1) and available for
 *  edit-in-place later. */
export function blockWorldToLocal(p: Vec2, frame: BlockFrame): Vec2 {
  const dx = p.x - frame.origin.x
  const dy = p.y - frame.origin.y
  const c = Math.cos(-frame.rotation)
  const s = Math.sin(-frame.rotation)
  const rx = c * dx - s * dy
  const ry = s * dx + c * dy
  return { x: rx / frame.scale, y: ry / frame.scale }
}

/** Transform ONE entity's geometry by a frame (local -> world). Ids are
 *  preserved (a block group/explode is lossless in identity). A nested block is
 *  forbidden in v1 and throws loudly (never silently drops geometry, ADR-0003). */
export function transformEntityByFrame(e: SketchEntity, frame: BlockFrame): SketchEntity {
  const map = (p: Vec2) => blockLocalToWorld(p, frame)
  switch (e.kind) {
    case 'point':
      return { ...e, at: map(e.at) }
    case 'line':
      return { ...e, start: map(e.start), end: map(e.end) }
    case 'circle':
      return { ...e, center: map(e.center), radius: e.radius * frame.scale }
    case 'arc':
      return {
        ...e, center: map(e.center), radius: e.radius * frame.scale,
        startAngle: normAngle(e.startAngle + frame.rotation),
        endAngle: normAngle(e.endAngle + frame.rotation),
      }
    case 'ellipse':
      return {
        ...e, center: map(e.center),
        majorRadius: e.majorRadius * frame.scale, minorRadius: e.minorRadius * frame.scale,
        rotation: e.rotation + frame.rotation,
      }
    case 'elliptical-arc':
      return {
        ...e, center: map(e.center),
        majorRadius: e.majorRadius * frame.scale, minorRadius: e.minorRadius * frame.scale,
        rotation: e.rotation + frame.rotation,
      }
    case 'spline':
      return { ...e, points: e.points.map(map) }
    case 'text':
      return {
        ...e, at: map(e.at), height: e.height * frame.scale,
        rotation: (e.rotation ?? 0) + frame.rotation,
      }
    case 'block':
      throw new Error('nested blocks are not supported (v1): a block member cannot itself be a block')
  }
}

/** A block's frame (origin/rotation/scale). */
function blockFrame(block: SketchBlockEntity): BlockFrame {
  return { origin: block.origin, rotation: block.rotation, scale: block.scale }
}

/** The block's members, transformed from local frame into sketch-world coords.
 *  Resolves a def-backed instance's members from `defs` (Stage 5). Ids are
 *  CANONICAL (never namespaced) -- this materializes ONE block for render /
 *  hit-test where no cross-instance collision is possible. This is what render,
 *  hit-test and single-use explode consume. */
export function blockMemberWorldEntities(
  block: SketchBlockEntity,
  defs?: Record<string, BlockDefinition>,
): SketchEntity[] {
  const frame = blockFrame(block)
  return resolveBlockMembers(block, defs).entities.map((e) => transformEntityByFrame(e, frame))
}

/** Flatten ONE block into its WORLD members + internal constraints + dimensions.
 *  `namespace` prefixes every member id (and internal ref) by the block/instance
 *  id, for use where MULTIPLE blocks are flattened into a single list (bake / CAM
 *  geometry, permanent explode) and shared definition ids would otherwise
 *  collide. Resolves def-backed instances via `defs`. */
export function flattenBlockToWorld(
  block: SketchBlockEntity,
  defs: Record<string, BlockDefinition> | undefined,
  namespace: boolean,
): BlockMembers {
  const frame = blockFrame(block)
  const members = resolveBlockMembers(block, defs)
  if (!namespace) {
    return {
      entities: members.entities.map((e) => transformEntityByFrame(e, frame)),
      constraints: [...members.constraints],
      dimensions: [...members.dimensions],
    }
  }
  const map = instanceIdMapper(block.id)
  return {
    entities: members.entities.map((e) => ({ ...transformEntityByFrame(e, frame), id: map(e.id) })),
    constraints: members.constraints.map((c) => remapConstraintIds(c, map)),
    dimensions: members.dimensions.map((d) => remapDimensionIds(d, map)),
  }
}

/**
 * Flatten every block in a sketch into its world member entities + the block's
 * internal constraints, leaving loose entities untouched. This is the ONE place
 * bake (and any geometry consumer) turns blocks into ordinary world geometry, so
 * a baked block is byte-for-byte the geometry an explode would produce -- which
 * is exactly what keeps content-derived loop ids stable across group/explode
 * (ADR-0019). Member ids are preserved by the world transform, so the internal
 * constraints still reference valid ids and chain the members correctly.
 */
export function expandBlocksForGeometry(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  defs?: Record<string, BlockDefinition>,
): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  const outE: SketchEntity[] = []
  const outC: SketchConstraint[] = [...constraints]
  for (const e of entities) {
    if (e.kind === 'block') {
      // Namespace def-backed instances (defId set) so two instances of one
      // definition, sharing the definition's member ids, do not collide in this
      // flat list. Single-use inline blocks keep canonical ids (unchanged).
      const flat = flattenBlockToWorld(e, defs, e.defId !== undefined)
      outE.push(...flat.entities)
      outC.push(...flat.constraints)
    } else {
      outE.push(e)
    }
  }
  return { entities: outE, constraints: outC }
}

/**
 * Return a sketch in which every def-backed INSTANCE is replaced by an
 * equivalent SINGLE-USE inline block (defId stripped, members resolved from the
 * shared definition), leaving the id/frame untouched. Render + hit-test code can
 * then treat every block as a plain inline block without knowing about the
 * definition registry -- the pick still returns the instance's own id, and the
 * STORE's source-of-truth sketch keeps defId. A sketch with no def-backed
 * instances is returned UNCHANGED (same reference). This is the single ingest
 * transform the shared sketch layer applies so the rest of the render path stays
 * definition-agnostic.
 */
export function materializeInstancesForView(sketch: Sketch): Sketch {
  if (!sketch.blockDefs) return sketch
  let changed = false
  const entities = sketch.entities.map((e) => {
    if (e.kind !== 'block' || e.defId === undefined) return e
    changed = true
    const members = resolveBlockMembers(e, sketch.blockDefs)
    const inline: SketchBlockEntity = {
      ...e,
      defId: undefined,
      members: {
        entities: [...members.entities],
        constraints: [...members.constraints],
        dimensions: [...members.dimensions],
      },
    }
    return inline
  })
  return changed ? { ...sketch, entities } : sketch
}

// ---- Centroid (default block origin) --------------------------------------

/** Characteristic points of an entity, for a stable group-anchor centroid. */
function entityAnchorPoints(e: SketchEntity): Vec2[] {
  switch (e.kind) {
    case 'point':          return [e.at]
    case 'line':           return [e.start, e.end]
    case 'circle':         return [e.center]
    case 'arc':            return [e.center]
    case 'ellipse':        return [e.center]
    case 'elliptical-arc': return [e.center]
    case 'spline':         return e.points
    case 'text':           return [e.at]
    case 'block':          return [e.origin]
  }
}

/** Centroid of a set of world entities (average of characteristic points).
 *  Origin choice is cosmetic (the drag handle) -- loop ids derive from WORLD
 *  geometry, which is invariant to it -- so a plain average is enough. */
export function centroidOfEntities(entities: readonly SketchEntity[]): Vec2 {
  let sx = 0, sy = 0, n = 0
  for (const e of entities) {
    for (const p of entityAnchorPoints(e)) { sx += p.x; sy += p.y; n += 1 }
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 }
}

// ---- Group / Explode results ----------------------------------------------

export interface GroupOk {
  ok: true
  sketch: Sketch
  blockId: string
}
export interface GroupRefusal {
  ok: false
  reason: 'empty' | 'nested' | 'cross-boundary'
  message: string
}
export type GroupResult = GroupOk | GroupRefusal

export interface ExplodeOk {
  ok: true
  sketch: Sketch
  /** Ids of the entities the block was replaced by (its restored members). */
  memberIds: string[]
}
export interface ExplodeRefusal {
  ok: false
  reason: 'not-a-block'
  message: string
}
export type ExplodeResult = ExplodeOk | ExplodeRefusal

// ---- Group ----------------------------------------------------------------

/**
 * Group the selected top-level entities named by `ids` into ONE rigid block.
 *
 * Refuses by name (ADR-0003) when:
 *   - the selection contains a block (nested blocks forbidden in v1), or
 *   - a constraint/dimension links a would-be member to a NON-member (a
 *     cross-boundary reference is never silently severed).
 *
 * WHOLLY-internal constraints/dimensions (all refs inside the selection) are
 * absorbed into the block; wholly-external ones stay on the sketch. Members are
 * re-expressed in the block's LOCAL frame (origin = selection centroid,
 * rotation 0, scale 1). Member ids are PRESERVED so an explode is lossless and
 * so CAM loop selections survive (ADR-0019: the baked world geometry is
 * unchanged, so its content-derived ids are unchanged).
 */
export function groupIntoBlock(
  sketch: Sketch,
  ids: readonly string[],
  newId: () => string = () => crypto.randomUUID(),
): GroupResult {
  const idSet = new Set(ids)
  const members = sketch.entities.filter((e) => idSet.has(e.id))
  if (members.length === 0) {
    return { ok: false, reason: 'empty', message: 'Select one or more sketch entities to group into a block.' }
  }

  // Nested blocks forbidden by name (v1).
  const nested = members.filter((e) => e.kind === 'block')
  if (nested.length > 0) {
    return {
      ok: false, reason: 'nested',
      message: 'Cannot group: the selection already contains a block. Nested blocks are not supported yet - explode it first.',
    }
  }

  const memberIds = new Set(members.map((e) => e.id))

  // Partition constraints: internal (all refs inside) vs external (all refs
  // outside) vs cross-boundary (some in, some out -> refuse by name).
  const internalConstraints: SketchConstraint[] = []
  const externalConstraints: SketchConstraint[] = []
  const crossKinds = new Set<string>()
  for (const c of sketch.constraints) {
    const refs = constraintRefIds(c)
    const inside = refs.filter((r) => memberIds.has(r)).length
    if (refs.length > 0 && inside === refs.length) internalConstraints.push(c)
    else if (inside > 0) crossKinds.add(`${c.kind} constraint`)
    else externalConstraints.push(c)
  }
  const internalDims: SketchDimension[] = []
  const externalDims: SketchDimension[] = []
  for (const d of sketch.dimensions) {
    const refs = dimensionRefIds(d)
    const inside = refs.filter((r) => memberIds.has(r)).length
    if (refs.length > 0 && inside === refs.length) internalDims.push(d)
    else if (inside > 0) crossKinds.add(`${d.kind} dimension`)
    else externalDims.push(d)
  }

  if (crossKinds.size > 0) {
    const named = [...crossKinds].join(', ')
    return {
      ok: false, reason: 'cross-boundary',
      message: `Cannot group: a ${named} links a selected entity to one outside the selection. Include both entities in the selection, or remove that ${crossKinds.size === 1 ? 'reference' : 'references'} first.`,
    }
  }

  // Origin = centroid of the members (world). Re-express members in the block's
  // LOCAL frame (translation-only at group time: rotation 0, scale 1).
  const origin = centroidOfEntities(members)
  const localMembers = members.map((e) => shiftEntity(e, -origin.x, -origin.y))

  const block: SketchBlockEntity = {
    id: newId(),
    kind: 'block',
    construction: false,
    origin,
    rotation: 0,
    scale: 1,
    members: {
      entities: localMembers,
      constraints: internalConstraints,
      dimensions: internalDims,
    },
  }

  const nextEntities = sketch.entities.filter((e) => !memberIds.has(e.id))
  nextEntities.push(block)

  return {
    ok: true,
    blockId: block.id,
    sketch: {
      ...sketch,
      entities: nextEntities,
      constraints: externalConstraints,
      dimensions: externalDims,
      // Grouping changes the constraint network (member count -> 1 block),
      // so the persisted status is stale until the next solve.
      solveStatus: null,
    },
  }
}

/** Translate every coordinate an entity owns by (dx, dy). Ids preserved. A
 *  nested block is forbidden and throws (never reached for group -- nested is
 *  refused earlier -- but keeps the switch exhaustive and loud). */
function shiftEntity(e: SketchEntity, dx: number, dy: number): SketchEntity {
  const t = (p: Vec2): Vec2 => ({ x: p.x + dx, y: p.y + dy })
  switch (e.kind) {
    case 'point':          return { ...e, at: t(e.at) }
    case 'line':           return { ...e, start: t(e.start), end: t(e.end) }
    case 'circle':         return { ...e, center: t(e.center) }
    case 'arc':            return { ...e, center: t(e.center) }
    case 'ellipse':        return { ...e, center: t(e.center) }
    case 'elliptical-arc': return { ...e, center: t(e.center) }
    case 'spline':         return { ...e, points: e.points.map(t) }
    case 'text':           return { ...e, at: t(e.at) }
    case 'block':          return { ...e, origin: t(e.origin) }
  }
}

// ---- Explode --------------------------------------------------------------

// Dimension kinds whose stored `value` (and, for 'd1xd2', `d2`) is a LENGTH in
// sketch-plane mm. 'angle' is the one non-length kind (radians) and is left
// alone below ('angle3' too, WO-1868): a uniform rotation of the whole block rotates BOTH of an angle
// dimension's operand lines together, so their RELATIVE angle -- what the
// dimension actually measures -- never changes. Every other kind measures a
// length, which SCALES with the block (rotation leaves lengths unchanged).
const LENGTH_DIMENSION_KINDS: ReadonlySet<SketchDimensionKind> = new Set([
  'distance', 'distanceX', 'distanceY', 'ordinate', 'distancePL',
  'radius', 'diameter', 'arcLength', 'majorRadius', 'minorRadius', 'focusDistance', 'd1xd2',
])

/**
 * Rescale a dimension ABSORBED into a block's members for restoration on
 * explode (SKC-BLOCKS Stage 2 fix). A block's `scale`/`rotation` are direct-
 * edit inert fields (blocks.ts setBlockScale/setBlockRotationDeg): they change
 * the members' WORLD placement but never rewrite the members' own LOCAL
 * geometry or the absorbed dimension's stored value -- that is the whole
 * point of "carried verbatim". But once EXPLODED, an absorbed dimension
 * becomes an ordinary TOP-LEVEL driving dimension again, and if its stored
 * value still names the pre-scale length, a driving dimension is now
 * INCONSISTENT with the just-restored (scaled) world geometry: the next solve
 * treats the stale value as authoritative and silently snaps the exploded
 * geometry back to the un-scaled size (ADR-0003: a defect, not a feature).
 * Rescaling the value here at the exact moment it re-enters the top-level
 * document keeps the dimension consistent with the geometry it now sits next
 * to, for every LENGTH-valued kind; 'angle' is rotation/scale-invariant and
 * is returned unchanged (see LENGTH_DIMENSION_KINDS above).
 */
export function scaleDimensionForExplode(d: SketchDimension, scale: number): SketchDimension {
  if (scale === 1 || !LENGTH_DIMENSION_KINDS.has(d.kind)) return d
  if (d.kind === 'd1xd2') return { ...d, value: d.value * scale, d2: d.d2 * scale }
  return { ...d, value: d.value * scale }
}

/**
 * Explode the block named by `blockId`: replace it with its member
 * entities/constraints/dimensions transformed back into sketch-world coords,
 * link dropped (ADR-0025 explode vocabulary). Lossless for geometry: a
 * group->explode round-trip restores the original world entities (member ids
 * preserved). Members become ordinary, re-fixable/dimensionable entities.
 * Absorbed dimension VALUES are rescaled by the block's current `scale`
 * (see scaleDimensionForExplode) so a driving dimension never fights the
 * just-restored, possibly-scaled world geometry on the next solve.
 */
export function explodeBlock(sketch: Sketch, blockId: string): ExplodeResult {
  const block = sketch.entities.find((e): e is SketchBlockEntity => e.id === blockId && e.kind === 'block')
  if (!block) {
    return { ok: false, reason: 'not-a-block', message: 'That entity is not a block.' }
  }
  // Def-backed INSTANCE (Stage 5): resolve members from the shared definition
  // and NAMESPACE them by the instance id so the loose lines are unique -- they
  // must not collide with the definition's canonical ids nor with a SIBLING
  // instance's members if it too is exploded. A single-use inline block keeps
  // canonical ids (namespace off), preserving the Stage-1 group->explode
  // byte-identity round-trip.
  const namespace = block.defId !== undefined
  const flat = flattenBlockToWorld(block, sketch.blockDefs, namespace)
  const worldMembers = flat.entities
  const memberIds = worldMembers.map((e) => e.id)

  const nextEntities = sketch.entities.filter((e) => e.id !== blockId)
  nextEntities.push(...worldMembers)

  // Drop any top-level constraint/dimension that referenced the BLOCK ITSELF
  // (e.g. the fix pinning its origin that a locked import is born with -- SKC-
  // BLOCKS Stage 3 -- or a coincident/dimension that PLACED the block). The
  // block is gone and its members become free, loose, editable geometry: the
  // placement link is dropped (ADR-0025 explode vocabulary), so those refs have
  // no target and must not dangle into the solver. Constraints among OTHER
  // entities are untouched.
  const keptConstraints = sketch.constraints.filter((c) => !constraintRefIds(c).includes(blockId))
  const keptDimensions = sketch.dimensions.filter((d) => !dimensionRefIds(d).includes(blockId))
  const restoredDimensions = flat.dimensions.map((d) => scaleDimensionForExplode(d, block.scale))

  return {
    ok: true,
    memberIds,
    sketch: pruneDefIfOrphan(
      {
        ...sketch,
        entities: nextEntities,
        constraints: [...keptConstraints, ...flat.constraints],
        dimensions: [...keptDimensions, ...restoredDimensions],
        solveStatus: null,
      },
      block.defId,
    ),
  }
}

// ---- Definition/instance lifecycle (SKC-BLOCKS Stage 5) --------------------

/** Drop `defId` from `sketch.blockDefs` if no remaining block entity references
 *  it. A no-op when defId is undefined or still referenced. Returns a NEW sketch
 *  only when it prunes. */
function pruneDefIfOrphan(sketch: Sketch, defId: string | undefined): Sketch {
  if (defId === undefined || !sketch.blockDefs || !(defId in sketch.blockDefs)) return sketch
  const stillUsed = sketch.entities.some((e) => e.kind === 'block' && e.defId === defId)
  if (stillUsed) return sketch
  const nextDefs = { ...sketch.blockDefs }
  delete nextDefs[defId]
  return { ...sketch, blockDefs: nextDefs }
}

/** Remove every block definition no reachable instance references (housekeeping
 *  after deletes/explodes). Returns the SAME sketch when nothing is orphaned. */
export function pruneUnusedBlockDefs(sketch: Sketch): Sketch {
  if (!sketch.blockDefs) return sketch
  const used = new Set<string>()
  for (const e of sketch.entities) if (e.kind === 'block' && e.defId !== undefined) used.add(e.defId)
  const orphans = Object.keys(sketch.blockDefs).filter((id) => !used.has(id))
  if (orphans.length === 0) return sketch
  const nextDefs = { ...sketch.blockDefs }
  for (const id of orphans) delete nextDefs[id]
  return { ...sketch, blockDefs: nextDefs }
}

export interface HoistOk {
  ok: true
  sketch: Sketch
  /** The definition the block now references (new, or its existing defId). */
  defId: string
}
export interface HoistRefusal {
  ok: false
  reason: 'not-a-block'
  message: string
}
export type HoistResult = HoistOk | HoistRefusal

/**
 * Hoist a single-use inline block into a SHARED definition, converting the
 * block itself into the first def-backed INSTANCE of it (same id, same frame).
 * Idempotent: a block that is ALREADY a def-backed instance returns its existing
 * defId with the sketch unchanged (so "place another" works on any block). The
 * definition captures the block's inline members verbatim (already in the
 * block's local frame); the instance's inline members are emptied. Loop ids are
 * coord-derived, so nothing the block bakes to changes (ADR-0019).
 */
export function hoistBlockToDefinition(
  sketch: Sketch,
  blockId: string,
  newId: () => string = () => crypto.randomUUID(),
): HoistResult {
  const block = sketch.entities.find((e): e is SketchBlockEntity => e.id === blockId && e.kind === 'block')
  if (!block) return { ok: false, reason: 'not-a-block', message: 'That entity is not a block.' }
  if (block.defId !== undefined) return { ok: true, sketch, defId: block.defId }

  const defId = newId()
  const def: BlockDefinition = {
    id: defId,
    ...(block.name === undefined ? {} : { name: block.name }),
    members: {
      entities: block.members.entities,
      constraints: block.members.constraints,
      dimensions: block.members.dimensions,
    },
  }
  const instance: SketchBlockEntity = {
    ...block,
    defId,
    members: { entities: [], constraints: [], dimensions: [] },
  }
  return {
    ok: true,
    defId,
    sketch: {
      ...sketch,
      entities: sketch.entities.map((e) => (e.id === blockId ? instance : e)),
      blockDefs: { ...(sketch.blockDefs ?? {}), [defId]: def },
      // A hoist does not change any world geometry, so the solve is unaffected --
      // but callers apply it as one undo step, and a null keeps the persisted
      // status honest until the next (identity) solve.
      solveStatus: null,
    },
  }
}

export interface PlaceInstanceOk {
  ok: true
  sketch: Sketch
  blockId: string
}
export interface PlaceInstanceRefusal {
  ok: false
  reason: 'no-def'
  message: string
}
export type PlaceInstanceResult = PlaceInstanceOk | PlaceInstanceRefusal

/**
 * Place a NEW def-backed instance of an existing definition at `origin`
 * (rotation 0, scale 1). Refuses by name (ADR-0003) if the definition is
 * missing. The new instance shares the definition's members, so editing the
 * definition updates it too.
 */
export function placeBlockInstance(
  sketch: Sketch,
  defId: string,
  origin: Vec2,
  newId: () => string = () => crypto.randomUUID(),
): PlaceInstanceResult {
  const def = sketch.blockDefs?.[defId]
  if (!def) {
    return { ok: false, reason: 'no-def', message: `No block definition ${defId} to place an instance of.` }
  }
  const instance: SketchBlockEntity = {
    id: newId(),
    kind: 'block',
    construction: false,
    defId,
    origin,
    rotation: 0,
    scale: 1,
    ...(def.name === undefined ? {} : { name: def.name }),
    members: { entities: [], constraints: [], dimensions: [] },
  }
  return {
    ok: true,
    blockId: instance.id,
    sketch: { ...sketch, entities: [...sketch.entities, instance], solveStatus: null },
  }
}

export interface InsertInstanceOk {
  ok: true
  sketch: Sketch
  /** The freshly placed instance's id (for selection/focus). */
  blockId: string
  /** The definition both the source and the new instance now share. */
  defId: string
}
export type InsertInstanceResult = InsertInstanceOk | HoistRefusal

/**
 * "Place another" a block: hoist the source block into a shared definition if it
 * is not already one, then place a fresh instance offset from the source's
 * origin. The single store-facing action behind the context-menu / toolbar
 * "Insert instance" command. Refuses by name if `sourceBlockId` is not a block.
 */
export function insertInstanceOfBlock(
  sketch: Sketch,
  sourceBlockId: string,
  offset: Vec2 = { x: 15, y: -15 },
  newId: () => string = () => crypto.randomUUID(),
): InsertInstanceResult {
  const source = sketch.entities.find(
    (e): e is SketchBlockEntity => e.id === sourceBlockId && e.kind === 'block',
  )
  if (!source) return { ok: false, reason: 'not-a-block', message: 'That entity is not a block.' }

  const hoisted = hoistBlockToDefinition(sketch, sourceBlockId, newId)
  if (!hoisted.ok) return hoisted
  const origin: Vec2 = { x: source.origin.x + offset.x, y: source.origin.y + offset.y }
  const placed = placeBlockInstance(hoisted.sketch, hoisted.defId, origin, newId)
  // placeBlockInstance only refuses 'no-def'; the def was just created/confirmed.
  if (!placed.ok) return { ok: false, reason: 'not-a-block', message: placed.message }
  return { ok: true, sketch: placed.sketch, blockId: placed.blockId, defId: hoisted.defId }
}

// ---- Wrap a fresh lift as a LOCKED block (SKC-BLOCKS Stage 3) --------------

export interface WrapLiftedOk {
  ok: true
  /** The single block entity wrapping every lifted member (origin = centroid,
   *  members re-expressed in the block's local frame, internal joints absorbed). */
  block: SketchBlockEntity
  /** The fix constraint grounding the block's origin. An imported block is BORN
   *  locked (its origin pinned) so the whole import reads dof 0 -- fully-defined
   *  by construction, not the blue sea of under-defined lines a loose lift is. */
  fix: FixConstraint
  blockId: string
}
export type WrapLiftedResult = WrapLiftedOk | GroupRefusal

/**
 * Wrap a fresh lift (entities + coincident joints from `liftLoops`) into ONE
 * LOCKED block: the whole imported DXF/SVG layer collapses to a single rigid
 * object placed by one FIX-anchored origin point (SKC-BLOCKS Stage 3, plan sec
 * 5). This kills both import pains at the source: the sea of under-defined blue
 * lines (the block is fully-defined by construction) AND the fixed-16MB-heap
 * OOM (the solver sees ONE point, not the hundreds of entities a dense import
 * lifts to -- plan sec 1, the 340-entity BMG.dxf case).
 *
 * Reuses `groupIntoBlock` verbatim (origin = centroid, members local, wholly-
 * internal coincident joints absorbed) and then pins the origin with a `fix`.
 * A fresh lift never contains a block and its coincident joints reference only
 * lifted entities, so grouping only ever refuses an EMPTY lift; any refusal is
 * returned BY NAME (ADR-0003) so the caller can keep the loose lift with a named
 * reason -- never a silent fallback.
 */
export function wrapLiftedAsBlock(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  opts: { name?: string; newId?: () => string } = {},
): WrapLiftedResult {
  const newId = opts.newId ?? (() => crypto.randomUUID())
  // Scratch sketch of the loose lift; group ALL of it into one block.
  const scratch: Sketch = {
    id: 'lift', layerId: 'lift',
    entities: [...entities], constraints: [...constraints], dimensions: [],
    solveStatus: null,
  }
  const grouped = groupIntoBlock(scratch, entities.map((e) => e.id), newId)
  if (!grouped.ok) return grouped
  const base = grouped.sketch.entities.find(
    (e): e is SketchBlockEntity => e.id === grouped.blockId && e.kind === 'block',
  )!
  const block: SketchBlockEntity = opts.name ? { ...base, name: opts.name } : base
  const fix: FixConstraint = {
    id: newId(), kind: 'fix',
    point: { entityId: block.id, site: 'origin' },
  }
  return { ok: true, block, fix, blockId: block.id }
}

// ---- Direct-edit inert SCALE / ROTATION (SKC-BLOCKS Stage 2) --------------
//
// scale/rotation are PLAIN FIELDS on SketchBlockEntity (types.ts), not gcs
// constraints and not SketchDimension-backed like the ellipse's majorRadius --
// there is nothing to push to the solver and nothing for mapDimension to
// validate. Writing the field is the ENTIRE "driving edit": the general
// (rotation, scale) transform is already live in blockLocalToWorld /
// transformEntityByFrame / blockMemberWorldEntities (Stage 1 built it for this
// exact rider, per the header comment), so every render/bake/explode path
// picks up the new value with zero further change. This is a narrower case of
// the ADR-0033 inert-direct-edit pattern than applyInertEllipseDims: no
// pre-solve rewrite pass is needed because there is no dimension array to
// rewrite FROM -- the UI writes the entity field directly, same posture as
// grouping/exploding writing `entities` directly.

export interface SetBlockFieldOk {
  ok: true
  sketch: Sketch
}
export interface SetBlockFieldRefusal {
  ok: false
  reason: 'not-a-block' | 'invalid-value'
  message: string
}
export type SetBlockFieldResult = SetBlockFieldOk | SetBlockFieldRefusal

/**
 * Direct-edit a block's uniform SCALE factor (Q-66: one typed factor, no
 * independent X/Y, no free-drag in v1). Refuses a non-finite or non-positive
 * value BY NAME (ADR-0003) -- zero or negative would collapse or mirror every
 * member, which v1's uniform-positive-scale model does not support. A no-op
 * (value unchanged) returns the SAME sketch reference so callers can skip an
 * undo step / re-solve for an edit that changed nothing.
 */
export function setBlockScale(sketch: Sketch, blockId: string, scale: number): SetBlockFieldResult {
  if (!Number.isFinite(scale) || scale <= 0) {
    return { ok: false, reason: 'invalid-value', message: 'Scale must be a positive number.' }
  }
  const block = sketch.entities.find((e): e is SketchBlockEntity => e.id === blockId && e.kind === 'block')
  if (!block) return { ok: false, reason: 'not-a-block', message: 'That entity is not a block.' }
  if (block.scale === scale) return { ok: true, sketch }
  return {
    ok: true,
    sketch: {
      ...sketch,
      entities: sketch.entities.map((e) => (e.id === blockId ? { ...block, scale } : e)),
    },
  }
}

/**
 * Direct-edit a block's ROTATION, in DEGREES (converted to the entity's
 * stored radians here, matching every other degree-typed sketch field --
 * e.g. `setSketchTextRotation`). Normalized into [0, 2*PI) via `normAngle`,
 * the SAME normalization `transformEntityByFrame` already applies to member
 * angles, so a block's own stored rotation and its members' derived world
 * angles never disagree on convention. Any finite degree value is valid (a
 * full turn just wraps); only a non-finite input refuses BY NAME. No-op
 * (value unchanged after normalization) returns the SAME sketch reference.
 */
export function setBlockRotationDeg(sketch: Sketch, blockId: string, deg: number): SetBlockFieldResult {
  if (!Number.isFinite(deg)) {
    return { ok: false, reason: 'invalid-value', message: 'Rotation must be a number.' }
  }
  const block = sketch.entities.find((e): e is SketchBlockEntity => e.id === blockId && e.kind === 'block')
  if (!block) return { ok: false, reason: 'not-a-block', message: 'That entity is not a block.' }
  const rotation = normAngle((deg * Math.PI) / 180)
  if (block.rotation === rotation) return { ok: true, sketch }
  return {
    ok: true,
    sketch: {
      ...sketch,
      entities: sketch.entities.map((e) => (e.id === blockId ? { ...block, rotation } : e)),
    },
  }
}

// ---- Edit a block IN PLACE (SKC-BLOCKS Stage 4) ----------------------------
//
// Edit-in-place lets a user open a block, edit its members with the FULL sketch
// toolset (the block's original creation UI IS the sketch canvas -- law: "edit
// reuses the ORIGINAL creation UI"), and exit re-freezing the members as one
// rigid object -- all WITHOUT the identity loss a manual explode -> edit ->
// re-group would cause (a fresh group mints a NEW block id and resets the origin
// to the member centroid, which would jump the block and orphan any CAM loop
// selection or placement constraint tied to it).
//
// MECHANISM (mirrors the shipped live-text-edit document cursor):
//   beginBlockEdit  -- detach the block into its world members (reusing
//                      explodeBlock's world-transform + internal c/d restore +
//                      block-ref drop + length-dim rescale), capturing the frame
//                      (origin/rotation/scale/name/construction/locked) and the
//                      OUTER entity ids (the ghost backdrop) needed to re-freeze.
//   finishBlockEdit -- re-group the CURRENT members (every entity NOT in the
//                      captured outerIds -- so entities the user newly draws are
//                      members too) into a block with the SAME id and SAME frame
//                      (no centroid recompute, no jump), folding world -> local
//                      via worldEntityToLocalByFrame and dividing absorbed length
//                      dims back down by scale (the inverse of the *scale explode
//                      applies), re-adding the origin fix iff the block was locked.
//
// The host owns the session cursor (store.sketchBlockEditId), ghosting, and undo,
// exactly as it does for text edit; these two PURE functions are the whole
// coordinate/identity contract, unit-testable without a host.

/**
 * Inverse of transformEntityByFrame: map ONE entity's geometry from sketch-WORLD
 * coords back into a frame's LOCAL coords. Ids are preserved (edit-in-place is
 * lossless in identity, like group/explode). A nested block is forbidden in v1
 * and throws loudly (ADR-0003, never silently drops geometry). This is the exact
 * mirror of transformEntityByFrame -- every operation is the arithmetic inverse
 * of the corresponding forward case (point via blockWorldToLocal, radius / scale,
 * angle - rotation), so `worldEntityToLocalByFrame(transformEntityByFrame(e)) === e`
 * to floating-point round-off.
 */
export function worldEntityToLocalByFrame(e: SketchEntity, frame: BlockFrame): SketchEntity {
  const map = (p: Vec2) => blockWorldToLocal(p, frame)
  switch (e.kind) {
    case 'point':
      return { ...e, at: map(e.at) }
    case 'line':
      return { ...e, start: map(e.start), end: map(e.end) }
    case 'circle':
      return { ...e, center: map(e.center), radius: e.radius / frame.scale }
    case 'arc':
      return {
        ...e, center: map(e.center), radius: e.radius / frame.scale,
        startAngle: normAngle(e.startAngle - frame.rotation),
        endAngle: normAngle(e.endAngle - frame.rotation),
      }
    case 'ellipse':
      return {
        ...e, center: map(e.center),
        majorRadius: e.majorRadius / frame.scale, minorRadius: e.minorRadius / frame.scale,
        rotation: e.rotation - frame.rotation,
      }
    case 'elliptical-arc':
      return {
        ...e, center: map(e.center),
        majorRadius: e.majorRadius / frame.scale, minorRadius: e.minorRadius / frame.scale,
        rotation: e.rotation - frame.rotation,
      }
    case 'spline':
      return { ...e, points: e.points.map(map) }
    case 'text':
      return {
        ...e, at: map(e.at), height: e.height / frame.scale,
        rotation: (e.rotation ?? 0) - frame.rotation,
      }
    case 'block':
      throw new Error('nested blocks are not supported (v1): a block member cannot itself be a block')
  }
}

/** Everything a host must remember between beginBlockEdit and finishBlockEdit to
 *  re-freeze the block WITHOUT changing its identity, position, or definition. */
export interface BlockEditSessionMeta {
  /** The id the re-frozen block MUST keep (CAM loop selections + placement
   *  constraints ride this id -- ADR-0019 / ADR-0025). */
  blockId: string
  /** The block's frame at edit time -- preserved exactly on exit, so the block
   *  never jumps and its typed Scale/Rotation survive an internal edit. */
  frame: BlockFrame
  name?: string
  construction: boolean
  /** The block carried a top-level `fix` on its origin (a locked import, Stage
   *  3): re-added on finish so the block re-freezes locked/dof-0. */
  locked: boolean
  /** SKC-BLOCKS Stage 5: the shared definition being edited, when this session
   *  was entered on a def-backed INSTANCE. On finish the edited members are
   *  written BACK to this definition, so EVERY instance updates -- not just the
   *  one that opened the edit. Undefined = a single-use inline block (members
   *  re-freeze onto the block entity itself, Stage 4 behavior). */
  defId?: string
  /** Ids of the entities that are NOT part of the block (the ghost backdrop).
   *  Captured at begin; on finish every entity whose id is NOT here is a member
   *  (so entities the user newly draws inside the session are absorbed too). */
  outerIds: string[]
}

export interface BeginBlockEditOk {
  ok: true
  sketch: Sketch
  meta: BlockEditSessionMeta
  /** Ids of the detached member entities (for an initial selection / focus). */
  memberIds: string[]
}
export interface BeginBlockEditRefusal {
  ok: false
  reason: 'not-a-block'
  message: string
}
export type BeginBlockEditResult = BeginBlockEditOk | BeginBlockEditRefusal

/**
 * Enter edit-in-place on the block named by `blockId`: detach it into its world
 * member entities so the user edits them with the ordinary sketch tools, and
 * capture the metadata `finishBlockEdit` needs to re-freeze the block unchanged.
 * Refuses by name (ADR-0003) if `blockId` is not a block.
 *
 * Detaches with CANONICAL member ids (never namespaced) and, for a def-backed
 * INSTANCE, does NOT prune the shared definition (it is being edited) and leaves
 * every SIBLING instance untouched and collapsed. Only ONE instance is ever
 * exploded during a session, so canonical ids cannot collide -- and canonical
 * ids are exactly what `finishBlockEdit` needs to fold the members straight back
 * onto the definition. A begin -> finish with NO edit is a perfect identity
 * round-trip (proven by test), for both single-use and def-backed blocks.
 */
export function beginBlockEdit(sketch: Sketch, blockId: string): BeginBlockEditResult {
  const block = sketch.entities.find((e): e is SketchBlockEntity => e.id === blockId && e.kind === 'block')
  if (!block) {
    return { ok: false, reason: 'not-a-block', message: 'That entity is not a block.' }
  }
  const locked = sketch.constraints.some(
    (c) => c.kind === 'fix' && c.point?.entityId === blockId && c.point?.site === 'origin',
  )
  const outerIds = sketch.entities.filter((e) => e.id !== blockId).map((e) => e.id)

  // Detach: resolve members (canonical ids, no namespace) into world coords,
  // restore the internal constraints + length-scaled dimensions, and drop any
  // top-level ref to the block id (the fix/placement is re-applied on finish).
  const flat = flattenBlockToWorld(block, sketch.blockDefs, false)
  const worldMembers = flat.entities
  const restoredDims = flat.dimensions.map((d) => scaleDimensionForExplode(d, block.scale))
  const keptConstraints = sketch.constraints.filter((c) => !constraintRefIds(c).includes(blockId))
  const keptDimensions = sketch.dimensions.filter((d) => !dimensionRefIds(d).includes(blockId))
  const nextEntities = sketch.entities.filter((e) => e.id !== blockId)
  nextEntities.push(...worldMembers)

  return {
    ok: true,
    sketch: {
      ...sketch,
      entities: nextEntities,
      constraints: [...keptConstraints, ...flat.constraints],
      dimensions: [...keptDimensions, ...restoredDims],
      solveStatus: null,
    },
    memberIds: worldMembers.map((e) => e.id),
    meta: {
      blockId,
      frame: { origin: block.origin, rotation: block.rotation, scale: block.scale },
      ...(block.name === undefined ? {} : { name: block.name }),
      construction: block.construction,
      locked,
      ...(block.defId === undefined ? {} : { defId: block.defId }),
      outerIds,
    },
  }
}

export interface FinishBlockEditOk {
  ok: true
  sketch: Sketch
  blockId: string
  /** True when the user deleted every member: the block is removed entirely. */
  deleted: boolean
}
export interface FinishBlockEditRefusal {
  ok: false
  reason: 'cross-boundary' | 'nested'
  message: string
}
export type FinishBlockEditResult = FinishBlockEditOk | FinishBlockEditRefusal

/**
 * Exit edit-in-place: re-group the CURRENT members (every entity whose id is NOT
 * in `meta.outerIds`) back into ONE block that keeps `meta.blockId` and
 * `meta.frame` EXACTLY -- no centroid recompute, no jump, typed Scale/Rotation
 * preserved. Members are folded world -> local via worldEntityToLocalByFrame and
 * absorbed length dimensions are divided by scale (the inverse of the *scale that
 * explode applied at begin), so a begin -> finish with no edit is byte-identical.
 * The origin `fix` is re-added iff `meta.locked`.
 *
 * Refuses by name (ADR-0003), leaving the session for the caller to keep open:
 *   - a constraint/dimension links a member to an OUTER entity (cross-boundary --
 *     the user must resolve it, never silently severed), or
 *   - a member is itself a block (nested, forbidden in v1 -- unreachable while
 *     v1 forbids nesting at group time, but checked so it can never slip in).
 *
 * If the user deleted every member the block is removed entirely (deleted:true).
 */
export function finishBlockEdit(sketch: Sketch, meta: BlockEditSessionMeta): FinishBlockEditResult {
  const outer = new Set(meta.outerIds)
  const members = sketch.entities.filter((e) => !outer.has(e.id))
  const memberIds = new Set(members.map((e) => e.id))

  // Deleted every member of a SINGLE-USE block -> the block is gone. (A def-
  // backed instance falls through to the normal path, which writes the emptied
  // member set to the shared definition and keeps the instance -- undoable, and
  // consistent with "the edit edits the definition".) Drop any top-level
  // constraint/dim that referenced a (now-absent) member or the block id.
  if (members.length === 0 && meta.defId === undefined) {
    const outerEntities = sketch.entities.filter((e) => outer.has(e.id))
    return {
      ok: true,
      blockId: meta.blockId,
      deleted: true,
      sketch: {
        ...sketch,
        entities: outerEntities,
        constraints: sketch.constraints.filter(
          (c) => !constraintRefIds(c).some((r) => !outer.has(r)),
        ),
        dimensions: sketch.dimensions.filter(
          (d) => !dimensionRefIds(d).some((r) => !outer.has(r)),
        ),
        solveStatus: null,
      },
    }
  }

  // A member cannot be a block (v1 forbids nesting); refuse loudly if one slipped in.
  const nested = members.filter((e) => e.kind === 'block')
  if (nested.length > 0) {
    return {
      ok: false, reason: 'nested',
      message: 'Cannot finish: a block cannot contain another block. Explode the inner block first.',
    }
  }

  // Partition constraints/dimensions: wholly-internal (all refs are members) are
  // absorbed into the block; wholly-external (no member ref) stay on the sketch;
  // cross-boundary (some in, some out) refuse by name.
  const internalConstraints: SketchConstraint[] = []
  const externalConstraints: SketchConstraint[] = []
  const crossKinds = new Set<string>()
  for (const c of sketch.constraints) {
    const refs = constraintRefIds(c)
    // The block id itself is gone during the session; a ref to it is stale and
    // dropped either way (never re-attached: the block is being rebuilt).
    if (refs.includes(meta.blockId)) continue
    const inside = refs.filter((r) => memberIds.has(r)).length
    if (refs.length > 0 && inside === refs.length) internalConstraints.push(c)
    else if (inside > 0) crossKinds.add(`${c.kind} constraint`)
    else externalConstraints.push(c)
  }
  const internalDims: SketchDimension[] = []
  const externalDims: SketchDimension[] = []
  for (const d of sketch.dimensions) {
    const refs = dimensionRefIds(d)
    if (refs.includes(meta.blockId)) continue
    const inside = refs.filter((r) => memberIds.has(r)).length
    if (refs.length > 0 && inside === refs.length) internalDims.push(d)
    else if (inside > 0) crossKinds.add(`${d.kind} dimension`)
    else externalDims.push(d)
  }

  if (crossKinds.size > 0) {
    const named = [...crossKinds].join(', ')
    return {
      ok: false, reason: 'cross-boundary',
      message: `Cannot finish: a ${named} links a block member to an entity outside the block. Include both in the block, or remove that ${crossKinds.size === 1 ? 'reference' : 'references'} first.`,
    }
  }

  // Fold members world -> local by the PRESERVED frame, and divide absorbed
  // length dims back down by scale (inverse of the begin-time *scale). These are
  // the canonical LOCAL members -- for a single-use block they re-freeze onto the
  // block entity; for a def-backed instance they are written to the shared
  // DEFINITION (so every instance updates).
  const localMembers = members.map((e) => worldEntityToLocalByFrame(e, meta.frame))
  const localDims = internalDims.map((d) => scaleDimensionForExplode(d, 1 / meta.frame.scale))

  const block: SketchBlockEntity = {
    id: meta.blockId,
    kind: 'block',
    construction: meta.construction,
    origin: meta.frame.origin,
    rotation: meta.frame.rotation,
    scale: meta.frame.scale,
    ...(meta.name === undefined ? {} : { name: meta.name }),
    ...(meta.defId === undefined ? {} : { defId: meta.defId }),
    // A def-backed instance carries EMPTY inline members (the geometry lives on
    // the definition, written below); a single-use block carries them inline.
    members:
      meta.defId === undefined
        ? { entities: localMembers, constraints: internalConstraints, dimensions: localDims }
        : { entities: [], constraints: [], dimensions: [] },
  }

  const nextEntities = sketch.entities.filter((e) => outer.has(e.id))
  nextEntities.push(block)
  const nextConstraints = [...externalConstraints]
  if (meta.locked) {
    const fix: FixConstraint = {
      id: crypto.randomUUID(), kind: 'fix',
      point: { entityId: meta.blockId, site: 'origin' },
    }
    nextConstraints.push(fix)
  }

  // SKC-BLOCKS Stage 5 propagation: write the edited members back to the SHARED
  // definition, so this re-frozen instance AND every sibling instance render the
  // edit. The definition's members are canonical (def-local frame), exactly the
  // localMembers/localDims/internalConstraints just computed.
  const nextDefs =
    meta.defId === undefined
      ? sketch.blockDefs
      : {
          ...(sketch.blockDefs ?? {}),
          [meta.defId]: {
            id: meta.defId,
            ...(meta.name === undefined ? {} : { name: meta.name }),
            members: {
              entities: localMembers,
              constraints: internalConstraints,
              dimensions: localDims,
            },
          } as BlockDefinition,
        }

  return {
    ok: true,
    blockId: meta.blockId,
    deleted: false,
    sketch: {
      ...sketch,
      entities: nextEntities,
      constraints: nextConstraints,
      dimensions: externalDims,
      ...(nextDefs === undefined ? {} : { blockDefs: nextDefs }),
      solveStatus: null,
    },
  }
}
