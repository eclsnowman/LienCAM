// WO UI-50C-R2 (DECISIONS 2026-07-16 STOP requirement 3, preflight section
// 4): a COMMITTED pre-R1-shaped fixture -- a genuine SKC-41A tool-built
// chamfer rig with the `chamferSetback` identity marker (introduced by
// UI-50C-R1) stripped off, exactly what a real pre-R1 `.camproject` file
// carries on disk. Built via the REAL `chamferTool.chamferLines` (not
// hand-typed geometry) so the rig's numbers are authentic, then the marker
// is stripped -- never fabricated by hand, which is exactly the class of
// mistake a hand-rolled rig risks (WORKER-CHARTER item 6 precedent: "commit
// the PRE-MUTATION SOURCE as an artifact", same discipline applied to a
// fixture instead of a mutation).
//
// Reused by src/tests/store/projectMigration.test.ts's backfill enumeration.

import { chamferLines } from '../../../lib/sketch/tools/chamferTool'
import type { SketchDoc } from '../../../lib/sketch/tools/trimTool'
import type { SketchEntity, SketchLineEntity } from '../../../lib/sketch/types'

let n = 0
const newId = () => `pre-r1-fixture-${n++}`

/** A genuine 90-deg-corner chamfer rig (chamferTool's own output), with the
 *  `chamferSetback` marker stripped -- the exact shape a pre-R1 tool-built
 *  chamfer carries in a real legacy `.camproject`. */
export function buildPreR1ChamferRig(setback = 3): { entities: SketchEntity[]; constraints: SketchDoc['constraints']; chamferLineId: string } {
  const doc: SketchDoc = {
    entities: [
      { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'B', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    ],
    constraints: [
      { id: 'corner', kind: 'coincident',
        a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' } },
    ],
    dimensions: [],
  }
  const r = chamferLines(doc, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, setback, newId)
  if (typeof r === 'string') throw new Error(`buildPreR1ChamferRig: chamferLines failed: ${r}`)
  // Strip the marker (UI-50C-R1's own identity, never written pre-R1) --
  // this is the ONE deliberate divergence from the tool's real output.
  const entities = r.transform.entities.map((e): SketchEntity => {
    if (e.id !== r.lineId) return e
    const { chamferSetback: _drop, ...rest } = e as SketchLineEntity
    return rest as SketchEntity
  })
  return { entities, constraints: r.transform.constraints, chamferLineId: r.lineId }
}

/** A project document (schema v6, pre-dating d1xd2/v7 entirely) whose sole
 *  sketch carries ONE genuine pre-R1 chamfer rig with no marker -- the exact
 *  "genuine pre-R1 SKC-41A tool-built chamfer" the R1 re-audit's MAJOR A
 *  finding describes. `geometryIndex`/`sketchIndex` let a caller graft this
 *  into an existing project fixture at any position. */
export function preR1ChamferSketch(setback = 3) {
  const rig = buildPreR1ChamferRig(setback)
  return {
    id: 'pre-r1-chamfer-sketch', layerId: 'layer-1',
    entities: rig.entities,
    constraints: rig.constraints,
    dimensions: [],
    solveStatus: null,
    chamferLineId: rig.chamferLineId,
  }
}

/** An INCOMPLETE rig: the chamfer line is coincident-joined to hostA only
 *  (hostB's joint is missing entirely -- the phantom/pin machinery never
 *  ran). Structurally the same shape a corrupted or hand-edited pre-R1 file
 *  could carry; `resolveChamferCorner` refuses it ('no-theoretical-corner'),
 *  so backfill must NOT mark it. */
export function incompleteRigSketch() {
  return {
    id: 'incomplete-rig-sketch', layerId: 'layer-1',
    entities: [
      { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'chamfer', kind: 'line', construction: false, start: { x: 7, y: 0 }, end: { x: 8, y: 5 } },
    ],
    constraints: [
      { id: 'j1', kind: 'coincident',
        a: { entityId: 'chamfer', site: 'start' }, b: { entityId: 'A', site: 'end' } },
      // hostB joint deliberately absent.
    ],
    dimensions: [],
    solveStatus: null,
  }
}

/** WO UI-50C-R3 MAJOR 3: the ACTUAL "single pin" rig the R2 backfill
 *  enumeration named but never committed (its case (c), `incompleteRigSketch`
 *  above, has ZERO pins and a missing host joint entirely -- a different,
 *  also-legitimate refusal shape, not this one). Here BOTH host joints are
 *  present (chamfer coincident-joined to hostA AND hostB, hosts distinct and
 *  nonparallel) and a genuine construction phantom point exists, but it
 *  carries exactly ONE `point_on_object` pin (to hostA only) instead of the
 *  required two. `resolveChamferCorner`'s phantom search is an intersection
 *  of "pinned to hostA" and "pinned to hostB" (theoreticalCorner.ts:285-301)
 *  -- a single pin makes that intersection empty, so it refuses
 *  'no-theoretical-corner' exactly like a rig with no phantom at all. */
export function singlePinRigSketch() {
  return {
    id: 'single-pin-rig-sketch', layerId: 'layer-1',
    entities: [
      { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'B', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { id: 'chamfer', kind: 'line', construction: false, start: { x: 7, y: 0 }, end: { x: 10, y: 3 } },
      { id: 'phantom', kind: 'point', construction: true, at: { x: 10, y: 0 } },
    ],
    constraints: [
      { id: 'j1', kind: 'coincident',
        a: { entityId: 'chamfer', site: 'start' }, b: { entityId: 'A', site: 'end' } },
      { id: 'j2', kind: 'coincident',
        a: { entityId: 'chamfer', site: 'end' }, b: { entityId: 'B', site: 'start' } },
      { id: 'p1', kind: 'point_on_object', point: { entityId: 'phantom', site: 'self' }, object: 'A' },
      // The pin to hostB is deliberately absent -- exactly ONE point_on_object pin total.
    ],
    dimensions: [],
    solveStatus: null,
  }
}
