// M2 demo seed (WO SKC-3, criterion 3): a nontrivial CLOSED bracket profile - 3 lines + 1
// filleted (tangent-connected) arc corner - used as the "fully constrain a nontrivial profile"
// gate demo fixture. Built on top of SKC-2's bracketDragFixture (src/tests/sketch3d/dragFixtures.ts),
// which deliberately leaves the loop OPEN with 2 free DOF at bl3's end; this fixture closes that
// same loop with one more coincidence, which is exactly what takes it from 2 DOF to fully
// constrained (0 DOF) - verified against the live solver in bracketFixture.test.ts, not just
// asserted by hand-count, per the WO's "matches planegcs ground truth" requirement.
import type { Sketch3dConstraint, Sketch3dDocument, Sketch3dPointRef } from '../../../sketch3d'

function ref(entityId: string, site: Sketch3dPointRef['site']): Sketch3dPointRef {
  return { entityId, site }
}

const entities: Sketch3dDocument['entities'] = [
  { id: 'bl1', kind: 'line', start: { x: 0.3, y: -0.2 }, end: { x: 39.6, y: 0.4 } },
  { id: 'ba1', kind: 'arc', center: { x: 40.7, y: 5.3 }, radius: 5.4, startAngle: -1.62, endAngle: -0.08 },
  { id: 'bl2', kind: 'line', start: { x: 45.4, y: 4.6 }, end: { x: 44.7, y: 24.8 } },
  { id: 'bl3', kind: 'line', start: { x: 45.3, y: 25.2 }, end: { x: 5.4, y: 24.6 } },
]

// Every constraint the closed, fully-constrained bracket carries. bracketPartialFixture() below
// removes a documented subset of these to land on an exact, non-zero expected DOF.
const fullConstraints: Sketch3dConstraint[] = [
  { id: 'bco1', kind: 'coincident', a: ref('bl1', 'end'), b: ref('ba1', 'start') },
  { id: 'bco2', kind: 'coincident', a: ref('ba1', 'end'), b: ref('bl2', 'start') },
  { id: 'bco3', kind: 'coincident', a: ref('bl2', 'end'), b: ref('bl3', 'start') },
  { id: 'bco4', kind: 'coincident', a: ref('bl3', 'end'), b: ref('bl1', 'start') },
  { id: 'btan1', kind: 'tangent', a: 'bl1', b: 'ba1' },
  { id: 'btan2', kind: 'tangent', a: 'ba1', b: 'bl2' },
  { id: 'bh1', kind: 'horizontal', line: 'bl1' },
  { id: 'bv2', kind: 'vertical', line: 'bl2' },
  { id: 'brad', kind: 'radius', entityId: 'ba1', value: 5 },
  { id: 'bd1', kind: 'distance', a: ref('bl1', 'start'), b: ref('bl1', 'end'), value: 40 },
  { id: 'bd2', kind: 'distance', a: ref('bl2', 'start'), b: ref('bl2', 'end'), value: 20 },
  { id: 'bfix0', kind: 'fixed', point: ref('bl1', 'start') },
]

function cloneEntities(): Sketch3dDocument['entities'] {
  return entities.map((entity) => ({ ...entity }))
}

// Fully constrained (0 DOF): the M2 demo seed itself.
export function bracketFixture(): Sketch3dDocument {
  return { id: 'bracket', entities: cloneEntities(), constraints: fullConstraints.map((c) => ({ ...c })) }
}

// Partially constrained variant: drops the two length dimensions (bd1, bd2), leaving the corner
// radius, tangencies, orientation, and closing coincidences intact. Each dropped distance
// constraint frees exactly 1 DOF (a scalar length, not a free point), so 2 constraints removed
// from the 0-DOF full fixture -> exactly 2 DOF remaining (verified in bracketFixture.test.ts).
export function bracketPartialFixture(): Sketch3dDocument {
  const constraints = fullConstraints.filter((c) => c.id !== 'bd1' && c.id !== 'bd2').map((c) => ({ ...c }))
  return { id: 'bracket-partial', entities: cloneEntities(), constraints }
}

// Empty sketch: zero entities, zero constraints - the DOF-chip "nothing to constrain" baseline.
export function emptySketchFixture(): Sketch3dDocument {
  return { id: 'empty', entities: [], constraints: [] }
}
