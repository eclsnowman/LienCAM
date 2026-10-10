export interface Sketch3dVec2 {
  x: number
  y: number
}

interface Sketch3dEntityBase {
  id: string
  construction?: boolean
}

export interface Sketch3dPointEntity extends Sketch3dEntityBase {
  kind: 'point'
  at: Sketch3dVec2
  fixed?: boolean
}

export interface Sketch3dLineEntity extends Sketch3dEntityBase {
  kind: 'line'
  start: Sketch3dVec2
  end: Sketch3dVec2
}

export interface Sketch3dCircleEntity extends Sketch3dEntityBase {
  kind: 'circle'
  center: Sketch3dVec2
  radius: number
}

export interface Sketch3dArcEntity extends Sketch3dEntityBase {
  kind: 'arc'
  center: Sketch3dVec2
  radius: number
  startAngle: number
  endAngle: number
}

export type Sketch3dEntity =
  | Sketch3dPointEntity
  | Sketch3dLineEntity
  | Sketch3dCircleEntity
  | Sketch3dArcEntity

export type Sketch3dPointSite = 'self' | 'start' | 'end' | 'center'

export interface Sketch3dPointRef {
  entityId: string
  site: Sketch3dPointSite
}

export interface Sketch3dConstraintBase {
  id: string
  driving?: boolean
  temporary?: boolean
  scale?: number
  /**
   * WO SKC-4 (WP3.5): when present, this dimension's numeric `value` is DRIVEN
   * by a DOC-4 parameter-table expression (e.g. "2*base+3") rather than being
   * a plain typed literal. Only meaningful on the four value-bearing kinds
   * (distance/angle/radius/diameter) -- see src/sketch3d/dimensionBinding.ts,
   * the only module that reads/writes it. `value` always still holds the
   * constraint's CURRENT usable number (mm for distance/radius/diameter,
   * degrees for angle): when `expression` is bound, `value` is the last
   * SUCCESSFULLY evaluated result, retained (never zeroed/dropped) across an
   * evaluation failure so the solver always has a real number to drive with.
   */
  expression?: string
}

export interface Sketch3dCoincidentConstraint extends Sketch3dConstraintBase {
  kind: 'coincident'
  a: Sketch3dPointRef
  b: Sketch3dPointRef
}

export interface Sketch3dHorizontalConstraint extends Sketch3dConstraintBase {
  kind: 'horizontal'
  line?: string
  points?: [Sketch3dPointRef, Sketch3dPointRef]
}

export interface Sketch3dVerticalConstraint extends Sketch3dConstraintBase {
  kind: 'vertical'
  line?: string
  points?: [Sketch3dPointRef, Sketch3dPointRef]
}

export interface Sketch3dParallelConstraint extends Sketch3dConstraintBase {
  kind: 'parallel'
  a: string
  b: string
}

export interface Sketch3dPerpendicularConstraint extends Sketch3dConstraintBase {
  kind: 'perpendicular'
  a: string
  b: string
}

export interface Sketch3dTangentConstraint extends Sketch3dConstraintBase {
  kind: 'tangent'
  a: string
  b: string
}

export interface Sketch3dEqualConstraint extends Sketch3dConstraintBase {
  kind: 'equal'
  a: string
  b: string
}

export interface Sketch3dDistanceConstraint extends Sketch3dConstraintBase {
  kind: 'distance'
  a: Sketch3dPointRef
  // Exactly one of b (point-point distance) or line (point-line distance) must be set.
  b?: Sketch3dPointRef
  line?: string
  value: number
}

export interface Sketch3dMidpointConstraint extends Sketch3dConstraintBase {
  kind: 'midpoint'
  point: Sketch3dPointRef
  line: string
}

export interface Sketch3dAngleConstraint extends Sketch3dConstraintBase {
  kind: 'angle'
  a: string
  b: string
  value: number
}

export interface Sketch3dRadiusConstraint extends Sketch3dConstraintBase {
  kind: 'radius'
  entityId: string
  value: number
}

export interface Sketch3dDiameterConstraint extends Sketch3dConstraintBase {
  kind: 'diameter'
  entityId: string
  value: number
}

export interface Sketch3dFixedConstraint extends Sketch3dConstraintBase {
  kind: 'fixed'
  point?: Sketch3dPointRef
  entityId?: string
}

export type Sketch3dConstraint =
  | Sketch3dCoincidentConstraint
  | Sketch3dHorizontalConstraint
  | Sketch3dVerticalConstraint
  | Sketch3dParallelConstraint
  | Sketch3dPerpendicularConstraint
  | Sketch3dTangentConstraint
  | Sketch3dEqualConstraint
  | Sketch3dDistanceConstraint
  | Sketch3dMidpointConstraint
  | Sketch3dAngleConstraint
  | Sketch3dRadiusConstraint
  | Sketch3dDiameterConstraint
  | Sketch3dFixedConstraint

export interface Sketch3dDocument {
  id: string
  entities: Sketch3dEntity[]
  constraints: Sketch3dConstraint[]
}

export interface Sketch3dEntityHandle {
  entityId: string
  kind: Sketch3dEntity['kind']
  geometryId?: string
  pointIds: Partial<Record<Sketch3dPointSite, string>>
  ruleId?: string
}

export type Sketch3dSolveStatus =
  | 'success'
  | 'redundant'
  | 'conflicting'
  | 'invalid_sketch'
  | 'failed'

export type Sketch3dUpdatedPosition =
  | { entityId: string; kind: 'point'; at: Sketch3dVec2 }
  | { entityId: string; kind: 'line'; start: Sketch3dVec2; end: Sketch3dVec2 }
  | { entityId: string; kind: 'circle'; center: Sketch3dVec2; radius: number }
  | {
      entityId: string
      kind: 'arc'
      center: Sketch3dVec2
      start: Sketch3dVec2
      end: Sketch3dVec2
      radius: number
      startAngle: number
      endAngle: number
    }

export interface Sketch3dSolveResult {
  status: Sketch3dSolveStatus
  rawStatus: number | null
  dof: number
  conflicting: string[]
  redundant: string[]
  handles: Sketch3dEntityHandle[]
  updatedPositions: Sketch3dUpdatedPosition[]
  entities: Sketch3dEntity[]
  error?: string
}

export interface Sketch3dSolveOptions {
  algorithm?: 0 | 1 | 2
}

// --- Auto-constraint inference on draw (WP3.3) ---

export type Sketch3dInferenceKind = 'horizontal' | 'vertical' | 'coincident' | 'tangent'

export interface Sketch3dInferenceCandidate {
  kind: Sketch3dInferenceKind
  constraint: Sketch3dConstraint
  // Lower is a tighter match; used only to rank multiple candidates against each other.
  score: number
}

// Suppression lives on the tool model (not the inference function) so a UI can flip it from
// a held modifier key without threading key-state through every call site.
export interface Sketch3dDrawToolState {
  suppressInference: boolean
}

// --- DOF chip (WP3.4) ---

export type Sketch3dDofChipStatus =
  | 'unconstrained'
  | 'partially_constrained'
  | 'fully_constrained'
  | 'redundant'
  | 'conflicting'
  | 'invalid'

export interface Sketch3dDofChip {
  dof: number
  status: Sketch3dDofChipStatus
  label: string
}

// --- Conflict / redundant panel (WP3.4) ---

export interface Sketch3dConflictEntry {
  constraintId: string
  kind: Sketch3dConstraint['kind'] | 'unknown'
  label: string
  entityIds: string[]
  severity: 'conflicting' | 'redundant'
}

export interface Sketch3dConflictPanel {
  conflicting: Sketch3dConflictEntry[]
  redundant: Sketch3dConflictEntry[]
  isEmpty: boolean
}

// --- Canvas constraint glyphs (WP3.3/3.4) ---

export type Sketch3dGlyphState = 'normal' | 'conflicting' | 'redundant'

export interface Sketch3dConstraintGlyph {
  constraintId: string
  kind: Sketch3dConstraint['kind']
  label: string
  // Where a UI should draw the glyph icon.
  anchor: Sketch3dVec2
  // Entities highlighted together with the glyph on hover/select.
  entityIds: string[]
  // Point-level refs highlighted together with the glyph on hover/select (subset of entityIds'
  // owned points - e.g. just the two coincident points, not every point on their owning lines).
  pointIds: string[]
  state: Sketch3dGlyphState
}
