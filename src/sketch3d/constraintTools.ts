// Constraint tools (WP3.3): one function per constraint kind in the WO's required vocabulary.
// Each tool is a pure "apply through a tool action" step - it builds the typed constraint object
// and appends it to a NEW document (never mutates the input), so a UI action handler can call
// these directly off a click/keybinding without touching the solver or planegcs mapping layer.
// Validation of *geometric* legality (right entity kinds, valid point sites) happens later, at
// mapping/solve time (src/sketch3d/solveBridge.ts) - these tools only guard the tool-boundary
// concern of duplicate constraint ids, so a caller gets an immediate, specific error instead of
// a confusing failure deep in the next solve.
import type {
  Sketch3dConstraint,
  Sketch3dConstraintBase,
  Sketch3dDocument,
  Sketch3dPointRef,
} from './types'

export type Sketch3dConstraintToolOptions = Partial<Omit<Sketch3dConstraintBase, 'id'>>

export function addConstraint(document: Sketch3dDocument, constraint: Sketch3dConstraint): Sketch3dDocument {
  if (document.constraints.some((existing) => existing.id === constraint.id)) {
    throw new Error(`sketch3d constraint tools: duplicate constraint id '${constraint.id}'`)
  }
  return { ...document, constraints: [...document.constraints, constraint] }
}

export function removeConstraint(document: Sketch3dDocument, constraintId: string): Sketch3dDocument {
  return { ...document, constraints: document.constraints.filter((existing) => existing.id !== constraintId) }
}

export function addCoincidentConstraint(
  document: Sketch3dDocument,
  id: string,
  a: Sketch3dPointRef,
  b: Sketch3dPointRef,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'coincident', a, b, ...options })
}

type LineOrPoints = { line: string; points?: undefined } | { line?: undefined; points: [Sketch3dPointRef, Sketch3dPointRef] }

export function addHorizontalConstraint(
  document: Sketch3dDocument,
  id: string,
  target: LineOrPoints,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'horizontal', ...target, ...options })
}

export function addVerticalConstraint(
  document: Sketch3dDocument,
  id: string,
  target: LineOrPoints,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'vertical', ...target, ...options })
}

export function addParallelConstraint(
  document: Sketch3dDocument,
  id: string,
  a: string,
  b: string,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'parallel', a, b, ...options })
}

export function addPerpendicularConstraint(
  document: Sketch3dDocument,
  id: string,
  a: string,
  b: string,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'perpendicular', a, b, ...options })
}

export function addTangentConstraint(
  document: Sketch3dDocument,
  id: string,
  a: string,
  b: string,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'tangent', a, b, ...options })
}

export function addEqualConstraint(
  document: Sketch3dDocument,
  id: string,
  a: string,
  b: string,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'equal', a, b, ...options })
}

export function addMidpointConstraint(
  document: Sketch3dDocument,
  id: string,
  point: Sketch3dPointRef,
  line: string,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'midpoint', point, line, ...options })
}

type DistanceTarget = { b: Sketch3dPointRef; line?: undefined } | { b?: undefined; line: string }

export function addDistanceConstraint(
  document: Sketch3dDocument,
  id: string,
  a: Sketch3dPointRef,
  target: DistanceTarget,
  value: number,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'distance', a, value, ...target, ...options })
}

export function addAngleConstraint(
  document: Sketch3dDocument,
  id: string,
  a: string,
  b: string,
  value: number,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'angle', a, b, value, ...options })
}

export function addRadiusConstraint(
  document: Sketch3dDocument,
  id: string,
  entityId: string,
  value: number,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'radius', entityId, value, ...options })
}

export function addDiameterConstraint(
  document: Sketch3dDocument,
  id: string,
  entityId: string,
  value: number,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'diameter', entityId, value, ...options })
}

type FixedTarget = { point: Sketch3dPointRef; entityId?: undefined } | { point?: undefined; entityId: string }

export function addFixedConstraint(
  document: Sketch3dDocument,
  id: string,
  target: FixedTarget,
  options: Sketch3dConstraintToolOptions = {},
): Sketch3dDocument {
  return addConstraint(document, { id, kind: 'fixed', ...target, ...options })
}
