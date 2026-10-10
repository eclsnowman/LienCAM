// Sketch3d Lab (WO INT-2): maps a constraint-tool click + the current canvas selection to the
// matching src/sketch3d constraintTools call. Pure and React-free so every kind's selection
// contract is unit-testable without mounting the page. `kind` always comes from which toolbar
// button was pressed - selection SHAPE alone is deliberately ambiguous between some kinds (e.g.
// horizontal-by-2-points and coincident both take 2 points, 0 entities), exactly like a real CAD
// sketcher where the tool you pick disambiguates the same picks.
import {
  addAngleConstraint,
  addCoincidentConstraint,
  addDiameterConstraint,
  addDistanceConstraint,
  addEqualConstraint,
  addFixedConstraint,
  addHorizontalConstraint,
  addMidpointConstraint,
  addParallelConstraint,
  addPerpendicularConstraint,
  addRadiusConstraint,
  addTangentConstraint,
  addVerticalConstraint,
} from '../../sketch3d'
import type { Sketch3dConstraint, Sketch3dDocument, Sketch3dPointRef } from '../../sketch3d'

export type Sketch3dLabConstraintKind = Sketch3dConstraint['kind']

export const SKETCH3DLAB_CONSTRAINT_KINDS: Sketch3dLabConstraintKind[] = [
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
  'equal',
  'midpoint',
  'distance',
  'angle',
  'radius',
  'diameter',
  'fixed',
]

export interface Sketch3dLabSelection {
  points: Sketch3dPointRef[]
  entities: string[]
}

export const EMPTY_SELECTION: Sketch3dLabSelection = { points: [], entities: [] }

export interface Sketch3dLabConstraintOutcome {
  document?: Sketch3dDocument
  error?: string
}

const VALUE_REQUIRED_KINDS: Sketch3dLabConstraintKind[] = ['distance', 'angle', 'radius', 'diameter']

export function constraintNeedsValue(kind: Sketch3dLabConstraintKind): boolean {
  return VALUE_REQUIRED_KINDS.includes(kind)
}

export function applyConstraintFromSelection(
  kind: Sketch3dLabConstraintKind,
  document: Sketch3dDocument,
  selection: Sketch3dLabSelection,
  id: string,
  value: number | null,
): Sketch3dLabConstraintOutcome {
  const { points, entities } = selection
  if (constraintNeedsValue(kind) && (value === null || !Number.isFinite(value))) {
    return { error: `'${kind}' needs a numeric value` }
  }

  try {
    switch (kind) {
      case 'coincident': {
        if (points.length !== 2 || entities.length !== 0) return { error: 'Coincident needs exactly 2 points selected' }
        return { document: addCoincidentConstraint(document, id, points[0], points[1]) }
      }
      case 'horizontal':
      case 'vertical': {
        const add = kind === 'horizontal' ? addHorizontalConstraint : addVerticalConstraint
        if (entities.length === 1 && points.length === 0) return { document: add(document, id, { line: entities[0] }) }
        if (points.length === 2 && entities.length === 0) {
          return { document: add(document, id, { points: [points[0], points[1]] }) }
        }
        return { error: `'${kind}' needs exactly 1 line, or 2 points selected` }
      }
      case 'parallel':
      case 'perpendicular':
      case 'tangent':
      case 'equal': {
        if (entities.length !== 2 || points.length !== 0) return { error: `'${kind}' needs exactly 2 entities selected` }
        const add =
          kind === 'parallel'
            ? addParallelConstraint
            : kind === 'perpendicular'
              ? addPerpendicularConstraint
              : kind === 'tangent'
                ? addTangentConstraint
                : addEqualConstraint
        return { document: add(document, id, entities[0], entities[1]) }
      }
      case 'midpoint': {
        if (points.length !== 1 || entities.length !== 1) return { error: "'midpoint' needs exactly 1 point + 1 line selected" }
        return { document: addMidpointConstraint(document, id, points[0], entities[0]) }
      }
      case 'distance': {
        if (points.length === 2 && entities.length === 0) {
          return { document: addDistanceConstraint(document, id, points[0], { b: points[1] }, value as number) }
        }
        if (points.length === 1 && entities.length === 1) {
          return { document: addDistanceConstraint(document, id, points[0], { line: entities[0] }, value as number) }
        }
        return { error: "'distance' needs 2 points, or 1 point + 1 line selected" }
      }
      case 'angle': {
        if (entities.length !== 2 || points.length !== 0) return { error: "'angle' needs exactly 2 lines selected" }
        return { document: addAngleConstraint(document, id, entities[0], entities[1], value as number) }
      }
      case 'radius':
      case 'diameter': {
        if (entities.length !== 1 || points.length !== 0) return { error: `'${kind}' needs exactly 1 entity selected` }
        const add = kind === 'radius' ? addRadiusConstraint : addDiameterConstraint
        return { document: add(document, id, entities[0], value as number) }
      }
      case 'fixed': {
        if (points.length === 1 && entities.length === 0) return { document: addFixedConstraint(document, id, { point: points[0] }) }
        if (entities.length === 1 && points.length === 0) return { document: addFixedConstraint(document, id, { entityId: entities[0] }) }
        return { error: "'fixed' needs exactly 1 point or 1 entity selected" }
      }
      default:
        return { error: `unsupported constraint kind '${kind satisfies never}'` }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
