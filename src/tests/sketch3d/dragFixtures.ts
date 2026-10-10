// Shared fixture builders for the SKC-2 drag-solve loop tests.
import type {
  Sketch3dConstraint,
  Sketch3dDocument,
  Sketch3dLineEntity,
  Sketch3dPointRef,
} from '../../sketch3d'

function ref(entityId: string, site: Sketch3dPointRef['site']): Sketch3dPointRef {
  return { entityId, site }
}

// A straight+alternating-direction chain of `entityCount` lines: the first point is fixed,
// every segment but the last is dimensioned (horizontal/vertical + length), and the last
// line's end point carries the sketch's only 2 free DOF - a scalable stand-in "drag handle"
// for perf/soak/throttle fixtures where entity count is the thing under test, not shape.
//
// DOF proof (holds for any entityCount N >= 1): raw dof = 4N (2 points/line, 2 coords/point,
// none pre-shared). Removed: 2*(N-1) from the N-1 chain coincidences, 2 from the single fixed
// point, (N-1) from horizontal/vertical on every segment but the last, (N-1) from a distance
// dimension on every segment but the last. Total removed = 4N-2, leaving exactly 2.
export function chainDragFixture(entityCount: number): { document: Sketch3dDocument; dragPoint: Sketch3dPointRef } {
  if (entityCount < 1) throw new Error('chainDragFixture: entityCount must be >= 1')
  const entities: Sketch3dLineEntity[] = []
  const constraints: Sketch3dConstraint[] = []
  const step = 4
  let x = 0
  let y = 0

  for (let i = 0; i < entityCount; i++) {
    const horizontal = i % 2 === 0
    const nx = horizontal ? x + step : x
    const ny = horizontal ? y : y + step
    entities.push({ id: `cl${i}`, kind: 'line', start: { x, y }, end: { x: nx, y: ny } })
    if (i > 0) {
      constraints.push({
        id: `cco${i}`,
        kind: 'coincident',
        a: ref(`cl${i - 1}`, 'end'),
        b: ref(`cl${i}`, 'start'),
      })
    }
    if (i < entityCount - 1) {
      constraints.push({ id: `chv${i}`, kind: horizontal ? 'horizontal' : 'vertical', line: `cl${i}` })
      constraints.push({
        id: `cd${i}`,
        kind: 'distance',
        a: ref(`cl${i}`, 'start'),
        b: ref(`cl${i}`, 'end'),
        value: step,
      })
    }
    x = nx
    y = ny
  }

  constraints.push({ id: 'cfix0', kind: 'fixed', point: ref('cl0', 'start') })

  return {
    document: { id: 'chain-drag', entities, constraints },
    dragPoint: ref(`cl${entityCount - 1}`, 'end'),
  }
}

// A small "nontrivial bracket profile" (lines + a filleted arc + tangencies + dimensions)
// left exactly 2-DOF-free at its open end - the closing coincidence between the last line
// and the first point is deliberately omitted. Used for the drag-correctness fixture
// (criterion 3): dragging the open end to a cursor position is mathematically identical to
// solving the same profile with that point `fixed` at the cursor instead, which gives an
// exact 1e-9 reference to compare against.
export function bracketDragFixture(): { document: Sketch3dDocument; dragPoint: Sketch3dPointRef } {
  // Coordinates are deliberately perturbed off the "nice" tangent-consistent numbers (same
  // convention as the SKC-1 rectangle fixture): planegcs's redundancy detector inspects the
  // constraint Jacobian rank AT THE SEED, and an exactly-already-tangent seed makes the
  // explicit tangent constraints numerically indistinguishable from already-implied,
  // spuriously flagging them redundant. A generic (non-degenerate) seed forces the solver
  // to actually use every constraint to reach the exact solution.
  const entities: Sketch3dDocument['entities'] = [
    { id: 'bl1', kind: 'line', start: { x: 0.3, y: -0.2 }, end: { x: 39.6, y: 0.4 } },
    { id: 'ba1', kind: 'arc', center: { x: 40.7, y: 5.3 }, radius: 5.4, startAngle: -1.62, endAngle: -0.08 },
    { id: 'bl2', kind: 'line', start: { x: 45.4, y: 4.6 }, end: { x: 44.7, y: 24.8 } },
    { id: 'bl3', kind: 'line', start: { x: 45.3, y: 25.2 }, end: { x: 5.4, y: 24.6 } },
  ]

  const constraints: Sketch3dConstraint[] = [
    { id: 'bco1', kind: 'coincident', a: ref('bl1', 'end'), b: ref('ba1', 'start') },
    { id: 'bco2', kind: 'coincident', a: ref('ba1', 'end'), b: ref('bl2', 'start') },
    { id: 'bco3', kind: 'coincident', a: ref('bl2', 'end'), b: ref('bl3', 'start') },
    { id: 'btan1', kind: 'tangent', a: 'bl1', b: 'ba1' },
    { id: 'btan2', kind: 'tangent', a: 'ba1', b: 'bl2' },
    { id: 'bh1', kind: 'horizontal', line: 'bl1' },
    { id: 'bv2', kind: 'vertical', line: 'bl2' },
    { id: 'brad', kind: 'radius', entityId: 'ba1', value: 5 },
    { id: 'bd1', kind: 'distance', a: ref('bl1', 'start'), b: ref('bl1', 'end'), value: 40 },
    { id: 'bd2', kind: 'distance', a: ref('bl2', 'start'), b: ref('bl2', 'end'), value: 20 },
    { id: 'bfix0', kind: 'fixed', point: ref('bl1', 'start') },
  ]

  return {
    document: { id: 'bracket-drag', entities, constraints },
    dragPoint: ref('bl3', 'end'),
  }
}
