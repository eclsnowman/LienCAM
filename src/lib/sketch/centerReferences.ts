import type { PointRef, SketchEntity, Vec2 } from './types'

export interface CenterBearingCensusRow {
  included: boolean
  reason: string
}

/**
 * Compiler-derived atomic center census. `satisfies Record<...>` makes a
 * future SketchEntity union member a compile failure until its center
 * semantics are accepted or mechanically excluded.
 */
export const CENTER_BEARING_ENTITY_CENSUS = {
  point: {
    included: false,
    reason: 'the entity is already an ordinary point; a center node would duplicate it',
  },
  line: {
    included: true,
    reason: 'a finite segment has one canonical midpoint derived from its two endpoints',
  },
  arc: {
    included: true,
    reason: 'the persisted supporting circle has one canonical center',
  },
  circle: {
    included: true,
    reason: 'the persisted circle has one canonical center',
  },
  ellipse: {
    included: true,
    reason: 'the persisted ellipse has one canonical center',
  },
  'elliptical-arc': {
    included: true,
    reason: 'the persisted supporting ellipse has one canonical center',
  },
  spline: {
    included: false,
    reason: 'parameter midpoint, arc-length midpoint, bounds center, and centroid are not equivalent',
  },
  text: {
    included: false,
    reason: 'the baseline anchor, glyph bounds center, and glyph centroid are not equivalent',
  },
  block: {
    included: false,
    reason: 'a block is a rigid container addressed by its origin anchor, not a center node',
  },
} as const satisfies Record<SketchEntity['kind'], CenterBearingCensusRow>

export type CenterBearingEntity = Extract<
  SketchEntity,
  { kind: 'line' | 'arc' | 'circle' | 'ellipse' | 'elliptical-arc' }
>

const CENTER_SELECTION_PREFIX = '__sketch_center_ref__:'
const ENDPOINT_SELECTION_PREFIX = '__sketch_endpoint_ref__:'

export class SketchCenterReferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SketchCenterReferenceError'
  }
}

export function centerRefForEntity(entity: SketchEntity): PointRef | null {
  return CENTER_BEARING_ENTITY_CENSUS[entity.kind].included
    ? { entityId: entity.id, site: 'center' }
    : null
}

export function centerPointForEntity(entity: SketchEntity): Vec2 | null {
  let point: Vec2
  switch (entity.kind) {
    case 'line':
      point = {
        x: (entity.start.x + entity.end.x) / 2,
        y: (entity.start.y + entity.end.y) / 2,
      }
      break
    case 'arc':
    case 'circle':
    case 'ellipse':
    case 'elliptical-arc':
      point = entity.center
      break
    case 'point':
    case 'spline':
    case 'text':
    case 'block':
      return null
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    // A non-finite center means the entity is degenerate, not that the whole
    // sketch is unusable: report "no addressable center" exactly like the
    // point/spline/text kinds above. Throwing here crashed the entire
    // sketchLayer.rebuild on one NaN-poisoned entity and preempted the
    // SKC-46-R2 preselection rule that names and drops the non-finite
    // sibling (RED-C, 2026-07-21). Callers that REQUIRE a resolvable center
    // (selection decode, constraint planning) keep their own named throws.
    return null
  }
  return point
}

export function encodeCenterSelectionRef(ref: PointRef): string {
  if (ref.site !== 'center') {
    throw new SketchCenterReferenceError(
      `cannot encode non-center point site '${ref.site}' as a center selection`,
    )
  }
  return `${CENTER_SELECTION_PREFIX}${encodeURIComponent(ref.entityId)}`
}

export function centerSelectionIdForEntity(entity: SketchEntity): string | null {
  const ref = centerRefForEntity(entity)
  return ref ? encodeCenterSelectionRef(ref) : null
}

export function decodeCenterSelectionRef(selectionId: string): PointRef | null {
  if (!selectionId.startsWith(CENTER_SELECTION_PREFIX)) return null
  const encodedOwner = selectionId.slice(CENTER_SELECTION_PREFIX.length)
  if (encodedOwner.length === 0) {
    throw new SketchCenterReferenceError('center selection is missing its owner entity id')
  }
  let entityId: string
  try {
    entityId = decodeURIComponent(encodedOwner)
  } catch {
    throw new SketchCenterReferenceError(
      `center selection has malformed owner encoding '${encodedOwner}'`,
    )
  }
  if (entityId.length === 0) {
    throw new SketchCenterReferenceError('center selection has an empty owner entity id')
  }
  return { entityId, site: 'center' }
}

export function encodeEndpointSelectionRef(ref: PointRef): string {
  if (ref.site !== 'start' && ref.site !== 'end') {
    throw new SketchCenterReferenceError(
      `cannot encode non-endpoint point site '${ref.site}' as an endpoint selection`,
    )
  }
  return `${ENDPOINT_SELECTION_PREFIX}${ref.site}:${encodeURIComponent(ref.entityId)}`
}

export function decodeEndpointSelectionRef(selectionId: string): PointRef | null {
  if (!selectionId.startsWith(ENDPOINT_SELECTION_PREFIX)) return null
  const encoded = selectionId.slice(ENDPOINT_SELECTION_PREFIX.length)
  const separator = encoded.indexOf(':')
  const site = encoded.slice(0, separator)
  const encodedOwner = separator >= 0 ? encoded.slice(separator + 1) : ''
  if ((site !== 'start' && site !== 'end') || encodedOwner.length === 0) {
    throw new SketchCenterReferenceError(`malformed endpoint selection '${encoded}'`)
  }
  let entityId: string
  try {
    entityId = decodeURIComponent(encodedOwner)
  } catch {
    throw new SketchCenterReferenceError(
      `endpoint selection has malformed owner encoding '${encodedOwner}'`,
    )
  }
  if (entityId.length === 0) {
    throw new SketchCenterReferenceError('endpoint selection has an empty owner entity id')
  }
  return { entityId, site }
}

export function decodePointSelectionRef(selectionId: string): PointRef | null {
  return decodeCenterSelectionRef(selectionId) ?? decodeEndpointSelectionRef(selectionId)
}

export function resolveCenterRef(
  entities: readonly SketchEntity[],
  ref: PointRef,
): { entity: CenterBearingEntity; point: Vec2 } {
  if (ref.site !== 'center') {
    throw new SketchCenterReferenceError(
      `point site '${ref.site}' is not a center reference`,
    )
  }
  const entity = entities.find((candidate) => candidate.id === ref.entityId)
  if (!entity) {
    throw new SketchCenterReferenceError(
      `center reference names unknown entity '${ref.entityId}'`,
    )
  }
  const point = centerPointForEntity(entity)
  if (!point) {
    throw new SketchCenterReferenceError(
      `entity '${entity.id}' (${entity.kind}) has no canonical center`,
    )
  }
  return { entity: entity as CenterBearingEntity, point }
}

export function ownerIdForSelection(selectionId: string): string {
  return decodePointSelectionRef(selectionId)?.entityId ?? selectionId
}
