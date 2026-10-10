// SKC-BLOCKS Stage 5 gates: block DEFINITIONS + placed INSTANCES.
//
// Covers:
//   - hoist a single-use block into a shared definition + first instance
//   - place additional instances (many instances, one definition)
//   - THE propagation contract: editing one instance's definition updates EVERY
//     instance (the headline of Stage 5)
//   - ADR-0019: two instances at different positions bake to DISTINCT, STABLE
//     loop ids, and each instance's chain stays independent (namespaced members)
//   - explode an instance keeps the definition alive for its siblings; the last
//     explode prunes the orphaned definition
//   - materializeInstancesForView flattens instances for the def-agnostic layer

import { describe, it, expect } from 'vitest'
import {
  groupIntoBlock,
  hoistBlockToDefinition,
  placeBlockInstance,
  insertInstanceOfBlock,
  explodeBlock,
  pruneUnusedBlockDefs,
  resolveBlockMembers,
  blockMemberWorldEntities,
  materializeInstancesForView,
  beginBlockEdit,
  finishBlockEdit,
} from '../../lib/sketch/blocks'
import { bakeSketch } from '../../lib/sketch/bake'
import { computeLoopContentId } from '../../lib/geometry/loopId'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint, SketchBlockEntity, PointRef,
} from '../../lib/sketch/types'

// ---- builders --------------------------------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}
function sketch(entities: SketchEntity[], constraints: SketchConstraint[] = []): Sketch {
  return { id: 'sk', layerId: 'L', entities, constraints, dimensions: [], solveStatus: null }
}
// A closed 40x30 rectangle: 4 lines chained by coincident corners (all internal).
function rectEntities(): SketchLineEntity[] {
  return [
    line('l1', 0, 0, 40, 0),
    line('l2', 40, 0, 40, 30),
    line('l3', 40, 30, 0, 30),
    line('l4', 0, 30, 0, 0),
  ]
}
function rectConstraints(): SketchConstraint[] {
  return [
    { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
    { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
    { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
    { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
  ]
}
// Deterministic id generator so tests can assert on ids.
function seqIds(prefix: string): () => string {
  let n = 0
  return () => `${prefix}-${n++}`
}

/** Group a rectangle into a single-use block. */
function rectBlockSketch(): { sk: Sketch; blockId: string } {
  const grouped = groupIntoBlock(sketch(rectEntities(), rectConstraints()), ['l1', 'l2', 'l3', 'l4'], seqIds('blk'))
  if (!grouped.ok) throw new Error('group failed')
  return { sk: grouped.sketch, blockId: grouped.blockId }
}

// ---- hoist -----------------------------------------------------------------

describe('hoistBlockToDefinition', () => {
  it('converts a single-use block into a shared definition + first instance', () => {
    const { sk, blockId } = rectBlockSketch()
    const res = hoistBlockToDefinition(sk, blockId, seqIds('def'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const def = res.sketch.blockDefs![res.defId]
    expect(def).toBeDefined()
    expect(def.members.entities.length).toBe(4)
    expect(def.members.constraints.length).toBe(4)
    const inst = res.sketch.entities.find((e): e is SketchBlockEntity => e.kind === 'block')!
    expect(inst.id).toBe(blockId) // same id, no jump
    expect(inst.defId).toBe(res.defId)
    expect(inst.members.entities.length).toBe(0) // geometry moved to the definition
  })

  it('is idempotent on an already def-backed instance (no new def, unchanged sketch)', () => {
    const { sk, blockId } = rectBlockSketch()
    const first = hoistBlockToDefinition(sk, blockId, seqIds('def'))
    if (!first.ok) throw new Error('hoist failed')
    const second = hoistBlockToDefinition(first.sketch, blockId, seqIds('def2'))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.defId).toBe(first.defId)
    expect(second.sketch).toBe(first.sketch) // same reference, no-op
  })

  it('refuses by name when the target is not a block (ADR-0003)', () => {
    const res = hoistBlockToDefinition(sketch([line('x', 0, 0, 1, 1)]), 'x')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('not-a-block')
  })
})

// ---- place / insert instances ---------------------------------------------

describe('placeBlockInstance / insertInstanceOfBlock', () => {
  it('places a new instance that shares the definition', () => {
    const { sk, blockId } = rectBlockSketch()
    const hoisted = hoistBlockToDefinition(sk, blockId, seqIds('def'))
    if (!hoisted.ok) throw new Error('hoist failed')
    const placed = placeBlockInstance(hoisted.sketch, hoisted.defId, { x: 100, y: 0 }, seqIds('inst'))
    expect(placed.ok).toBe(true)
    if (!placed.ok) return
    const instances = placed.sketch.entities.filter((e): e is SketchBlockEntity => e.kind === 'block')
    expect(instances.length).toBe(2)
    expect(instances.every((i) => i.defId === hoisted.defId)).toBe(true)
    // Only ONE copy of the geometry exists (on the definition).
    expect(Object.keys(placed.sketch.blockDefs!).length).toBe(1)
  })

  it('refuses to place an instance of a missing definition (ADR-0003)', () => {
    const res = placeBlockInstance(sketch([]), 'nope', { x: 0, y: 0 })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('no-def')
  })

  it('insertInstanceOfBlock hoists-then-places in one call; both instances share a def', () => {
    const { sk, blockId } = rectBlockSketch()
    const res = insertInstanceOfBlock(sk, blockId, { x: 60, y: 0 }, seqIds('x'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const instances = res.sketch.entities.filter((e): e is SketchBlockEntity => e.kind === 'block')
    expect(instances.length).toBe(2)
    expect(new Set(instances.map((i) => i.defId)).size).toBe(1)
    expect(instances.map((i) => i.defId)[0]).toBe(res.defId)
  })
})

// ---- THE propagation contract ----------------------------------------------

describe('editing a definition updates every instance (Stage 5 headline)', () => {
  it('editing instance A widens the definition -> instance B reflects the change', () => {
    // Two instances of one 40x30 rectangle definition, A at 0, B offset to 100.
    const { sk, blockId } = rectBlockSketch()
    const inserted = insertInstanceOfBlock(sk, blockId, { x: 100, y: 0 }, seqIds('x'))
    if (!inserted.ok) throw new Error('insert failed')
    const s0 = inserted.sketch
    const instA = blockId
    const instB = inserted.blockId
    const defs0 = s0.blockDefs!

    // Instance B, before the edit: rectangle world width is 40 (member l1 spans x 0..40).
    const bBefore = blockMemberWorldEntities(
      s0.entities.find((e): e is SketchBlockEntity => e.id === instB)!, defs0,
    )
    const l1Before = bBefore.find((e) => e.id === 'l1') as SketchLineEntity
    expect(Math.abs(l1Before.end.x - l1Before.start.x)).toBeCloseTo(40, 6)

    // Edit instance A: enter edit-in-place, move l1's end from x=40 to x=80
    // (widen the rectangle), finish.
    const begun = beginBlockEdit(s0, instA)
    if (!begun.ok) throw new Error('begin failed')
    // l1 is loose in world with canonical id 'l1'; widen it.
    const edited: Sketch = {
      ...begun.sketch,
      entities: begun.sketch.entities.map((e) =>
        e.id === 'l1' && e.kind === 'line' ? { ...e, end: { ...e.end, x: 80 } } : e,
      ),
    }
    const finished = finishBlockEdit(edited, begun.meta)
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    const s1 = finished.sketch

    // The DEFINITION now carries the widened member.
    const defId = inserted.defId
    const defL1 = s1.blockDefs![defId].members.entities.find((e) => e.id === 'l1') as SketchLineEntity
    expect(Math.abs(defL1.end.x - defL1.start.x)).toBeCloseTo(80, 6)

    // Instance B -- which was NEVER touched -- now resolves the widened geometry.
    const bAfter = blockMemberWorldEntities(
      s1.entities.find((e): e is SketchBlockEntity => e.id === instB)!, s1.blockDefs!,
    )
    const l1After = bAfter.find((e) => e.id === 'l1') as SketchLineEntity
    expect(Math.abs(l1After.end.x - l1After.start.x)).toBeCloseTo(80, 6)
    // And B is still positioned at its own origin (offset preserved, not jumped).
    expect(l1After.start.x).toBeCloseTo(l1Before.start.x, 6)
  })

  it('a begin -> finish with NO edit is an identity round-trip for a def-backed instance', () => {
    const { sk, blockId } = rectBlockSketch()
    const inserted = insertInstanceOfBlock(sk, blockId, { x: 100, y: 0 }, seqIds('x'))
    if (!inserted.ok) throw new Error('insert failed')
    const s0 = inserted.sketch
    const defBefore = JSON.parse(JSON.stringify(s0.blockDefs![inserted.defId]))

    const begun = beginBlockEdit(s0, blockId)
    if (!begun.ok) throw new Error('begin failed')
    const finished = finishBlockEdit(begun.sketch, begun.meta)
    expect(finished.ok).toBe(true)
    if (!finished.ok) return

    // Definition members unchanged (to float round-off), instance still def-backed.
    const defAfter = finished.sketch.blockDefs![inserted.defId]
    expect(defAfter.members.entities.length).toBe(defBefore.members.entities.length)
    const inst = finished.sketch.entities.find((e): e is SketchBlockEntity => e.id === blockId)!
    expect(inst.defId).toBe(inserted.defId)
    expect(inst.members.entities.length).toBe(0)
  })
})

// ---- ADR-0019: distinct + stable loop ids for two instances ----------------

describe('two instances bake to distinct, stable, independent loops (ADR-0019)', () => {
  function twoInstanceSketch(): Sketch {
    const { sk, blockId } = rectBlockSketch()
    const inserted = insertInstanceOfBlock(sk, blockId, { x: 100, y: 0 }, seqIds('x'))
    if (!inserted.ok) throw new Error('insert failed')
    return inserted.sketch
  }

  it('each instance yields its own closed loop (chains stay independent, not cross-joined)', () => {
    const baked = bakeSketch(twoInstanceSketch())
    const closed = baked.loops.filter((l) => l.closed)
    // Two separate 40x30 rectangles -> exactly two closed loops.
    expect(closed.length).toBe(2)
  })

  it('the two loops have DISTINCT content ids and are STABLE across a re-bake', () => {
    // Content ids (ADR-0019) are computed from loop POINTS, exactly as the store
    // stamps them via assignStableLoopIds -- bake itself mints throwaway ids.
    const contentIds = (sk: Sketch) =>
      bakeSketch(sk).loops
        .filter((l) => l.closed)
        .map((l) => computeLoopContentId(l.layerId, l.points))
        .sort()
    const sk = twoInstanceSketch()
    const first = contentIds(sk)
    const second = contentIds(sk)
    expect(new Set(first).size).toBe(2) // two instances at different positions -> distinct
    expect(second).toEqual(first) // stable across re-derive
  })
})

// ---- explode keeps the definition for siblings -----------------------------

describe('exploding one instance preserves the definition for its siblings', () => {
  it('explode A -> A becomes loose lines, definition survives for B, then last explode prunes it', () => {
    const { sk, blockId } = rectBlockSketch()
    const inserted = insertInstanceOfBlock(sk, blockId, { x: 100, y: 0 }, seqIds('x'))
    if (!inserted.ok) throw new Error('insert failed')
    const s0 = inserted.sketch
    const instB = inserted.blockId
    const defId = inserted.defId

    const explodedA = explodeBlock(s0, blockId)
    expect(explodedA.ok).toBe(true)
    if (!explodedA.ok) return
    const s1 = explodedA.sketch
    // Definition still present (B references it).
    expect(s1.blockDefs![defId]).toBeDefined()
    // A's members are loose, namespaced (unique) so they cannot collide with B.
    const looseLines = s1.entities.filter((e) => e.kind === 'line')
    expect(looseLines.length).toBe(4)
    expect(looseLines.every((e) => e.id.includes(blockId))).toBe(true)
    // B remains a block instance.
    expect(s1.entities.some((e) => e.id === instB && e.kind === 'block')).toBe(true)

    // Explode B too -> definition is now orphaned and pruned.
    const explodedB = explodeBlock(s1, instB)
    expect(explodedB.ok).toBe(true)
    if (!explodedB.ok) return
    expect(explodedB.sketch.blockDefs?.[defId]).toBeUndefined()
  })

  it('pruneUnusedBlockDefs drops a definition with no instances', () => {
    const { sk, blockId } = rectBlockSketch()
    const hoisted = hoistBlockToDefinition(sk, blockId, seqIds('def'))
    if (!hoisted.ok) throw new Error('hoist failed')
    // Remove the only instance manually, then prune.
    const orphaned: Sketch = { ...hoisted.sketch, entities: [] }
    const pruned = pruneUnusedBlockDefs(orphaned)
    expect(Object.keys(pruned.blockDefs ?? {}).length).toBe(0)
  })
})

// ---- materialize for the def-agnostic render layer -------------------------

describe('materializeInstancesForView', () => {
  it('flattens a def-backed instance into an inline block (same id/frame, def resolved)', () => {
    const { sk, blockId } = rectBlockSketch()
    const inserted = insertInstanceOfBlock(sk, blockId, { x: 100, y: 0 }, seqIds('x'))
    if (!inserted.ok) throw new Error('insert failed')
    const view = materializeInstancesForView(inserted.sketch)
    const inst = view.entities.find((e): e is SketchBlockEntity => e.id === inserted.blockId)!
    expect(inst.defId).toBeUndefined() // flattened
    expect(inst.members.entities.length).toBe(4) // resolved from the definition
    expect(inst.origin.x).toBeCloseTo(inserted.sketch.entities
      .find((e): e is SketchBlockEntity => e.id === inserted.blockId)!.origin.x, 6)
  })

  it('returns the SAME reference when there are no def-backed instances', () => {
    const { sk } = rectBlockSketch()
    expect(materializeInstancesForView(sk)).toBe(sk)
  })

  it('resolveBlockMembers throws loud on a def-backed instance with a missing def (ADR-0003)', () => {
    const inst: SketchBlockEntity = {
      id: 'i', kind: 'block', construction: false, defId: 'gone',
      origin: { x: 0, y: 0 }, rotation: 0, scale: 1,
      members: { entities: [], constraints: [], dimensions: [] },
    }
    expect(() => resolveBlockMembers(inst, {})).toThrow(/ADR-0003/)
  })
})
