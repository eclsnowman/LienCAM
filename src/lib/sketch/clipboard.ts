import { resolveBlockMembers } from './blocks'
import { constraintRefIds } from './refIds'
import { withoutOffsetLink } from './tools/offsetTool'
import { withoutProjectionLink } from './projectLink'
import { isInjectedSketchAnchorId } from './sketchAnchors'
import type {
  BlockDefinition,
  PointRef,
  Sketch,
  SketchBlockEntity,
  SketchConstraint,
  SketchDimension,
  SketchEntity,
  Vec2,
} from './types'

export interface SketchClipboardPayload {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  /** Stable group reference point translated onto the paste location. */
  anchor: Vec2
}

export interface SketchClipboardPaste {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  selectedIds: string[]
}

export type SketchClipboardIdFactory = () => string

function clone<T>(value: T): T {
  return structuredClone(value)
}

function entityAnchor(entity: SketchEntity): Vec2 {
  switch (entity.kind) {
    case 'point':
      return entity.at
    case 'line':
      return {
        x: (entity.start.x + entity.end.x) / 2,
        y: (entity.start.y + entity.end.y) / 2,
      }
    case 'circle':
    case 'arc':
    case 'ellipse':
    case 'elliptical-arc':
      return entity.center
    case 'spline': {
      const divisor = Math.max(1, entity.points.length)
      return entity.points.reduce(
        (sum, point) => ({ x: sum.x + point.x / divisor, y: sum.y + point.y / divisor }),
        { x: 0, y: 0 },
      )
    }
    case 'text':
      return entity.at
    case 'block':
      return entity.origin
  }
}

function groupAnchor(entities: readonly SketchEntity[]): Vec2 {
  const divisor = Math.max(1, entities.length)
  return entities.reduce(
    (sum, entity) => {
      const point = entityAnchor(entity)
      return { x: sum.x + point.x / divisor, y: sum.y + point.y / divisor }
    },
    { x: 0, y: 0 },
  )
}

function materializeBlock(
  block: SketchBlockEntity,
  defs: Record<string, BlockDefinition> | undefined,
): SketchBlockEntity {
  if (block.defId === undefined) return clone(block)
  return {
    ...clone(block),
    defId: undefined,
    members: clone(resolveBlockMembers(block, defs)),
  }
}

/**
 * Capture only real selected entities and geometric constraints whose complete
 * reference set is inside that selection. Dimensions are intentionally excluded:
 * pasted geometry keeps its internal shape relationships but does not duplicate
 * driving values/absolute dimension labels, so it remains free to place.
 */
export function captureSketchClipboard(
  sketch: Pick<Sketch, 'entities' | 'constraints' | 'blockDefs'>,
  selectedIds: readonly string[],
): SketchClipboardPayload | null {
  const selected = new Set(
    selectedIds.filter((id) => !isInjectedSketchAnchorId(id)),
  )
  const entities = sketch.entities
    .filter((entity) => selected.has(entity.id) && !isInjectedSketchAnchorId(entity.id))
    .map((entity) => entity.kind === 'block'
      ? materializeBlock(entity, sketch.blockDefs)
      : clone(entity))
  if (entities.length === 0) return null

  const selectedEntityIds = new Set(entities.map((entity) => entity.id))
  const constraints = sketch.constraints
    .filter((constraint) => {
      // A fix is an absolute/world anchor, not an internal relationship.
      // Carrying it would make a pasted entity fully defined at its new
      // location, violating the clipboard contract that paste stays movable.
      if (constraint.kind === 'fix') return false
      const refs = constraintRefIds(constraint)
      return refs.length > 0 && refs.every((id) => selectedEntityIds.has(id))
    })
    .map(clone)

  return { entities, constraints, anchor: groupAnchor(entities) }
}

function remapPointRef(ref: PointRef, entityId: (id: string) => string): PointRef {
  return { ...ref, entityId: entityId(ref.entityId) }
}

/**
 * WO-1859: re-ID an ASSOCIATIVE OFFSET link onto the copy. A pasted
 * source+offset pair keeps its OWN internal link (new link id, source ids
 * remapped into the paste) and never points back at the original — the same
 * rule text-on-path's `pathId` and the WO-1867 ordinate datum follow. An
 * offset pasted WITHOUT its source has nothing in the paste to follow, so the
 * link is dropped and the copy is ordinary geometry (pointing at the original
 * would make an unrelated edit move a copy the operator placed by hand).
 */
function remapOffsetLink(
  entity: SketchEntity,
  mappedEntityId: (id: string) => string | undefined,
  mappedLinkId: (id: string) => string,
): SketchEntity {
  const link = entity.offsetLink
  if (link === undefined) return entity
  const source = link.source.map((ref) => {
    const next = mappedEntityId(ref.entityId)
    return next === undefined ? null : { ...ref, entityId: next }
  })
  if (source.some((ref) => ref === null)) return withoutOffsetLink(entity)
  return {
    ...entity,
    offsetLink: {
      ...link,
      id: mappedLinkId(link.id),
      source: source as typeof link.source,
    },
  }
}

function remapConstraint(
  constraint: SketchConstraint,
  id: string,
  entityId: (id: string) => string,
): SketchConstraint {
  const base = { ...clone(constraint), id }
  switch (base.kind) {
    case 'coincident':
    case 'continuity_g1':
    case 'continuity_g2':
      return {
        ...base,
        a: remapPointRef(base.a, entityId),
        b: remapPointRef(base.b, entityId),
      }
    case 'concentric':
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'tangent':
    case 'equal':
      return { ...base, a: entityId(base.a), b: entityId(base.b) }
    case 'horizontal':
    case 'vertical':
      return base.line !== undefined
        ? { ...base, line: entityId(base.line) }
        : {
            ...base,
            points: (base.points ?? []).map((point) => remapPointRef(point, entityId)) as typeof base.points,
          }
    case 'midpoint':
      return {
        ...base,
        point: remapPointRef(base.point, entityId),
        line: entityId(base.line),
      }
    case 'symmetric':
      return {
        ...base,
        a: remapPointRef(base.a, entityId),
        b: remapPointRef(base.b, entityId),
        axis: entityId(base.axis),
      }
    case 'fix':
      if (base.point !== undefined) {
        return { ...base, point: remapPointRef(base.point, entityId) }
      }
      return base.entityId !== undefined
        ? { ...base, entityId: entityId(base.entityId) }
        : base
    case 'point_on_object':
      return {
        ...base,
        point: remapPointRef(base.point, entityId),
        object: entityId(base.object),
      }
    case 'pierce':
      // WO-1865: the pasted point stays pierced by the SAME model edge (the edge is not part of
      // the sketch, so there is nothing to remap it onto); the next regen pass re-resolves it.
      return { ...base, point: remapPointRef(base.point, entityId) }
  }
}

function remapDimension(
  dimension: SketchDimension,
  id: string,
  entityId: (id: string) => string,
): SketchDimension {
  const base = { ...clone(dimension), id }
  switch (base.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY':
      return {
        ...base,
        a: remapPointRef(base.a, entityId),
        b: remapPointRef(base.b, entityId),
      }
    // WO-1867: an ordinate carries TWO point refs (its datum and the measured
    // point) and both re-ID with the paste, so a copied hole pattern keeps its
    // own datum instead of silently pointing back at the original's.
    case 'ordinate':
      return {
        ...base,
        origin: remapPointRef(base.origin, entityId),
        point: remapPointRef(base.point, entityId),
      }
    case 'distancePL':
      return {
        ...base,
        point: remapPointRef(base.point, entityId),
        line: entityId(base.line),
      }
    case 'angle':
      return { ...base, a: entityId(base.a), b: entityId(base.b) }
    // WO-1868: a pasted three-point angle re-IDs all three of its point refs.
    case 'angle3':
      return {
        ...base,
        vertex: remapPointRef(base.vertex, entityId),
        a: remapPointRef(base.a, entityId),
        b: remapPointRef(base.b, entityId),
      }
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
    case 'd1xd2':
      return { ...base, entityId: entityId(base.entityId) }
  }
}

function translateEntity(entity: SketchEntity, delta: Vec2): SketchEntity {
  const move = (point: Vec2): Vec2 => ({
    x: point.x + delta.x,
    y: point.y + delta.y,
  })
  switch (entity.kind) {
    case 'point':
      return { ...entity, at: move(entity.at) }
    case 'line':
      return { ...entity, start: move(entity.start), end: move(entity.end) }
    case 'circle':
    case 'arc':
    case 'ellipse':
    case 'elliptical-arc':
      return { ...entity, center: move(entity.center) }
    case 'spline':
      return { ...entity, points: entity.points.map(move) }
    case 'text':
      return { ...entity, at: move(entity.at) }
    case 'block':
      return { ...entity, origin: move(entity.origin) }
  }
}

function freshenBlockMembers(
  block: SketchBlockEntity,
  allocateId: () => string,
): SketchBlockEntity {
  const entityIds = new Map<string, string>()
  for (const entity of block.members.entities) entityIds.set(entity.id, allocateId())
  const mappedEntityId = (oldId: string): string => {
    const next = entityIds.get(oldId)
    if (next === undefined) {
      throw new Error(`Sketch clipboard block member references missing entity '${oldId}'.`)
    }
    return next
  }
  const memberLinkIds = new Map<string, string>()
  const memberLinkId = (oldId: string): string => {
    const next = memberLinkIds.get(oldId) ?? allocateId()
    memberLinkIds.set(oldId, next)
    return next
  }
  const entities = block.members.entities.map((entity): SketchEntity => {
    const next = { ...clone(entity), id: mappedEntityId(entity.id) }
    if (next.kind === 'text' && next.pathId !== undefined) {
      const mappedPath = entityIds.get(next.pathId)
      if (mappedPath === undefined) {
        const {
          pathId: _pathId, pathOffsetMm: _pathOffsetMm, pathFlip: _pathFlip,
          pathAlign: _pathAlign, ...freeText
        } = next
        return freeText
      }
      return { ...next, pathId: mappedPath }
    }
    return withoutProjectionLink(remapOffsetLink(next, (id) => entityIds.get(id), memberLinkId))
  })
  const constraints = block.members.constraints.map((constraint) =>
    remapConstraint(constraint, allocateId(), mappedEntityId))
  const dimensions = block.members.dimensions.map((dimension) =>
    remapDimension(dimension, allocateId(), mappedEntityId))
  return {
    ...block,
    members: { entities, constraints, dimensions },
  }
}

/**
 * Instantiate a captured payload with collision-free IDs and translate its
 * stable group anchor to `placement`. Every reference is rewritten through the
 * same entity map; an impossible dangling reference throws by name.
 */
export function instantiateSketchClipboard(
  payload: SketchClipboardPayload,
  placement: Vec2,
  newId: SketchClipboardIdFactory,
  reservedIds: Iterable<string> = [],
): SketchClipboardPaste {
  if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y)) {
    throw new Error('Sketch clipboard paste location is not finite.')
  }
  const reserved = new Set(reservedIds)
  const allocateId = (): string => {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = newId()
      if (!candidate || reserved.has(candidate)) continue
      reserved.add(candidate)
      return candidate
    }
    throw new Error('Sketch clipboard could not allocate a unique ID.')
  }

  const entityIds = new Map<string, string>()
  for (const entity of payload.entities) entityIds.set(entity.id, allocateId())
  const mappedEntityId = (oldId: string): string => {
    const next = entityIds.get(oldId)
    if (next === undefined) {
      throw new Error(`Sketch clipboard constraint references uncopied entity '${oldId}'.`)
    }
    return next
  }
  const linkIds = new Map<string, string>()
  const mappedLinkId = (oldId: string): string => {
    const next = linkIds.get(oldId) ?? allocateId()
    linkIds.set(oldId, next)
    return next
  }
  const delta = {
    x: placement.x - payload.anchor.x,
    y: placement.y - payload.anchor.y,
  }

  const entities = payload.entities.map((source): SketchEntity => {
    let entity: SketchEntity = { ...clone(source), id: mappedEntityId(source.id) }
    if (entity.kind === 'text' && entity.pathId !== undefined) {
      const mappedPath = entityIds.get(entity.pathId)
      if (mappedPath === undefined) {
        const {
          pathId: _pathId, pathOffsetMm: _pathOffsetMm, pathFlip: _pathFlip,
          pathAlign: _pathAlign, ...freeText
        } = entity
        entity = freeText
      } else {
        entity = { ...entity, pathId: mappedPath }
      }
    }
    entity = remapOffsetLink(entity, (id) => entityIds.get(id), mappedLinkId)
    // WO-1864: a pasted projected piece is a detached static copy -- placed by hand, it must never
    // be snapped back onto the model source the original follows. Provenance colour is kept.
    entity = withoutProjectionLink(entity)
    if (entity.kind === 'block') entity = freshenBlockMembers(entity, allocateId)
    return translateEntity(entity, delta)
  })
  const constraints = payload.constraints.map((constraint) =>
    remapConstraint(constraint, allocateId(), mappedEntityId))

  return {
    entities,
    constraints,
    selectedIds: entities.map((entity) => entity.id),
  }
}
