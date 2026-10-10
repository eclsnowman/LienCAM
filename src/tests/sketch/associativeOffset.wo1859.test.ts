// WO-1859: an offset that stays tied to what it was offset from.
//
// The CAM reason this is a Tier-2 differentiator (hitlist line 1552): an
// offset is how a clearance boundary, a wall-thickness line or a laser-kerf
// allowance is expressed, so a one-shot copy goes silently WRONG the moment
// the profile changes while still looking right.
//
// The behaviour is proved against the REAL planegcs solver through the real
// solve entry point (solveSketchOnWrapper -> entitiesFromSolved), not a
// hand-inspected primitive list: a drag and a driven dimension have to carry
// the offset in the SAME solve, and every piece of the result has to still be
// exactly the offset distance from the SOLVED source.
//
// FIXTURE ("a four-line-and-two-arc closed chain", the acceptance's shape):
// a plate traversed CCW --
//   sL1 (0,0)->(40,0)   sL2 (40,0)->(40,20)   sL3 (40,20)->(0,20)
//   sL4 (0,20)->(0,14)  sA1 (0,14)->(-5,7)    sA2 (-5,7)->(0,0)
// The two R6 arcs are a pair of outward bulges on the left edge, so FOUR
// corners are convex (filleted at R = distance) and TWO are concave (trimmed
// to their exact intersection): the 2 mm OUTWARD offset is 6 parallels +
// 4 fillet arcs = 10 pieces in one closed loop.
//
// The source is constrained the way a real sketch is (horizontal/vertical
// edges, a grounded origin, driving width / neck / radius dimensions), which
// leaves exactly ONE freedom: the height sL3 sits at. That is the freedom the
// drag consumes, so a drag of sL3 changes three line lengths and nothing else
// -- the source shape's topology is not in question, only whether the OFFSET
// follows it.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyOffsetLinks, breakOffsetLinks, offsetApply, offsetClick, offsetLinkIdsIn,
  recomputeOffsetLinks, resetOffsetLinkNoteLog, setOffsetLinkDistance,
  withoutOffsetLink,
} from '../../lib/sketch/tools/offsetTool'
import { solveSketchOnWrapper, type DragRequest } from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { deleteFromSketch } from '../../lib/sketch/deleteSelection'
import {
  captureSketchClipboard, instantiateSketchClipboard,
} from '../../lib/sketch/clipboard'
import type {
  Sketch, SketchArcEntity, SketchConstraint, SketchDimension, SketchEntity,
  SketchLineEntity, Vec2,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `wo1859-${n++}`

const TWO_PI = Math.PI * 2

// ---- The fixture -------------------------------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

/** The arc of radius `r` from `from` to `to` whose centre sits to the LEFT of
 *  that travel -- i.e. an outward bulge on a CCW boundary. Derived, never
 *  transcribed, so the seed chain closes to machine precision. */
function arcThrough(id: string, from: Vec2, to: Vec2, r: number): SketchArcEntity {
  const dx = to.x - from.x, dy = to.y - from.y
  const chord = Math.hypot(dx, dy)
  const h = Math.sqrt(r * r - (chord / 2) ** 2)
  const u = { x: dx / chord, y: dy / chord }
  const left = { x: -u.y, y: u.x }
  const centre = {
    x: (from.x + to.x) / 2 + h * left.x,
    y: (from.y + to.y) / 2 + h * left.y,
  }
  return {
    id, kind: 'arc', construction: false, center: centre, radius: r,
    startAngle: Math.atan2(from.y - centre.y, from.x - centre.x),
    endAngle: Math.atan2(to.y - centre.y, to.x - centre.x),
  }
}

const SOURCE_IDS = ['sL1', 'sL2', 'sL3', 'sL4', 'sA1', 'sA2']
/** The four CONVEX source corners (outward offset fillets one arc at each). */
const CONVEX_CORNERS: Vec2[] = [
  { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 },
]

function plateEntities(): SketchEntity[] {
  return [
    line('sL1', 0, 0, 40, 0),
    line('sL2', 40, 0, 40, 20),
    line('sL3', 40, 20, 0, 20),
    line('sL4', 0, 20, 0, 14),
    arcThrough('sA1', { x: 0, y: 14 }, { x: -5, y: 7 }, 6),
    arcThrough('sA2', { x: -5, y: 7 }, { x: 0, y: 0 }, 6),
  ]
}

function plateConstraints(): SketchConstraint[] {
  const joint = (
    a: string, aSite: 'start' | 'end', b: string, bSite: 'start' | 'end',
  ): SketchConstraint => ({
    id: newId(), kind: 'coincident',
    a: { entityId: a, site: aSite }, b: { entityId: b, site: bSite },
  })
  return [
    joint('sL1', 'end', 'sL2', 'start'),
    joint('sL2', 'end', 'sL3', 'start'),
    joint('sL3', 'end', 'sL4', 'start'),
    joint('sL4', 'end', 'sA1', 'start'),
    joint('sA1', 'end', 'sA2', 'start'),
    joint('sA2', 'end', 'sL1', 'start'),
    { id: newId(), kind: 'horizontal', line: 'sL1' },
    { id: newId(), kind: 'horizontal', line: 'sL3' },
    { id: newId(), kind: 'vertical', line: 'sL2' },
    { id: newId(), kind: 'vertical', line: 'sL4' },
    { id: newId(), kind: 'fix', point: { entityId: 'sL1', site: 'start' } },
    // The left edge runs up the Y axis: sL4's own x is otherwise free.
    { id: newId(), kind: 'vertical',
      points: [{ entityId: 'sL1', site: 'start' }, { entityId: 'sL4', site: 'end' }] },
  ]
}

/** WIDTH is the dimension the acceptance drives 40 -> 60. */
const WIDTH_DIM = 'wo1859-width'
const HEIGHT_DIM = 'wo1859-height'

function plateDimensions(): SketchDimension[] {
  return [
    { id: WIDTH_DIM, kind: 'distanceX', driving: true, value: 40,
      a: { entityId: 'sL1', site: 'start' }, b: { entityId: 'sL1', site: 'end' } },
    { id: newId(), kind: 'distanceY', driving: true, value: 14,
      a: { entityId: 'sL1', site: 'start' }, b: { entityId: 'sL4', site: 'end' } },
    { id: newId(), kind: 'radius', entityId: 'sA1', driving: true, value: 6 },
    { id: newId(), kind: 'radius', entityId: 'sA2', driving: true, value: 6 },
  ]
}

/** The plate, plus an OUTWARD offset committed through the real tool flow
 *  (pick the chain, lock the outside, OK at the distance). `pinHeight` adds
 *  the last driving dimension, leaving the source fully defined -- the state a
 *  DRIVEN-dimension edit starts from, as opposed to a draggable one. */
function plateWithOffset(distance = 2, pinHeight = false): Sketch {
  const entities = plateEntities()
  const constraints = plateConstraints()
  // Click the bottom edge: its whole chain is selected.
  const picked = offsetClick(null, entities, constraints, { x: 20, y: 0 }, 0.5)
  expect(picked.chain).not.toBeNull()
  // Click BELOW the plate: locks the outside.
  const locked = offsetClick(picked.chain, entities, constraints, { x: 20, y: -5 }, 0.5)
  const commit = offsetApply(locked.chain!, distance, newId)
  if (typeof commit === 'string') throw new Error(commit)
  return {
    id: 'wo1859-plate', layerId: 'L',
    entities: [...entities, ...commit.entities],
    constraints: [...constraints, ...commit.constraints],
    dimensions: [
      ...plateDimensions(),
      ...(pinHeight ? [{
        id: HEIGHT_DIM, kind: 'distanceY' as const, driving: true, value: 20,
        a: { entityId: 'sL1', site: 'start' as const },
        b: { entityId: 'sL3', site: 'start' as const },
      }] : []),
    ],
    solveStatus: null,
  }
}

// ---- Geometry helpers (independent of the tool's own maths) --------------------

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

function sweepOf(a: SketchArcEntity): number {
  const s = norm(a.endAngle - a.startAngle)
  return s < 1e-12 ? TWO_PI : s
}

function segDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function distanceTo(e: SketchEntity, p: Vec2): number {
  if (e.kind === 'line') return segDistance(p, e.start, e.end)
  if (e.kind !== 'arc') return Infinity
  const rel = norm(Math.atan2(p.y - e.center.y, p.x - e.center.x) - e.startAngle)
  if (rel <= sweepOf(e)) return Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius)
  const at = (ang: number) => ({
    x: e.center.x + e.radius * Math.cos(ang), y: e.center.y + e.radius * Math.sin(ang),
  })
  const s = at(e.startAngle), en = at(e.endAngle)
  return Math.min(Math.hypot(p.x - s.x, p.y - s.y), Math.hypot(p.x - en.x, p.y - en.y))
}

/** Distance from p to the nearest SOURCE entity of the chain. */
function distanceToSource(entities: readonly SketchEntity[], p: Vec2): number {
  return Math.min(...entities.filter((e) => SOURCE_IDS.includes(e.id))
    .map((e) => distanceTo(e, p)))
}

/** Sample points along a piece (both ends included). */
function samples(e: SketchEntity, count = 12): Vec2[] {
  const out: Vec2[] = []
  if (e.kind === 'line') {
    for (let i = 0; i <= count; i++) {
      out.push({
        x: e.start.x + (i / count) * (e.end.x - e.start.x),
        y: e.start.y + (i / count) * (e.end.y - e.start.y),
      })
    }
    return out
  }
  if (e.kind !== 'arc') return out
  const sweep = sweepOf(e)
  for (let i = 0; i <= count; i++) {
    const a = e.startAngle + (i / count) * sweep
    out.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) })
  }
  return out
}

function offsetPieces(entities: readonly SketchEntity[]): SketchEntity[] {
  return entities.filter((e) => !SOURCE_IDS.includes(e.id))
}

/**
 * THE acceptance measurement: the largest deviation from `distance` over every
 * sampled point of every offset piece. A true offset boundary has EVERY point
 * at exactly the distance from its source, so one number covers "every piece
 * still exactly 2 mm from its source piece".
 */
function worstOffsetError(entities: readonly SketchEntity[], distance: number): number {
  let worst = 0
  for (const e of offsetPieces(entities)) {
    for (const p of samples(e)) {
      worst = Math.max(worst, Math.abs(distanceToSource(entities, p) - distance))
    }
  }
  return worst
}

/** The offset line lying at a constant y (the parallel of a horizontal source
 *  edge), or null. Says WHERE the offset went, not just that it is 2 mm from
 *  something. */
function horizontalOffsetAt(entities: readonly SketchEntity[], y: number): SketchLineEntity | null {
  for (const e of offsetPieces(entities)) {
    if (e.kind !== 'line') continue
    if (Math.abs(e.start.y - y) < 1e-6 && Math.abs(e.end.y - y) < 1e-6) return e
  }
  return null
}

/** Corner fillets: offset arcs at exactly R = distance. */
function filletArcs(entities: readonly SketchEntity[], distance: number): SketchArcEntity[] {
  return offsetPieces(entities)
    .filter((e): e is SketchArcEntity => e.kind === 'arc' && Math.abs(e.radius - distance) < 1e-6)
}

async function withWrapper<T>(
  fn: (w: Awaited<ReturnType<typeof createGcsWrapper>>) => T | Promise<T>,
): Promise<T> {
  const wrapper = await createGcsWrapper()
  try {
    return await fn(wrapper)
  } finally {
    wrapper.destroy_gcs_module()
  }
}

function solved(
  w: Awaited<ReturnType<typeof createGcsWrapper>>, sketch: Sketch, drag?: DragRequest,
): SketchEntity[] {
  const out = solveSketchOnWrapper(w, sketch, drag)
  if (!out.ok) throw new Error(`solve failed: ${out.reason}: ${out.message}`)
  return out.entities
}

/** Drag the top source edge rigidly to y = `y` (both endpoints, same delta) --
 *  exactly the two pins a body drag on a line produces. */
function dragTopEdgeTo(y: number): DragRequest {
  return {
    targets: [
      { point: { entityId: 'sL3', site: 'start' }, to: { x: 40, y } },
      { point: { entityId: 'sL3', site: 'end' }, to: { x: 0, y } },
    ],
  }
}

beforeEach(() => {
  resetOffsetLinkNoteLog()
})

// ---- 1. The link exists and is born with the offset ------------------------------

describe('WO-1859: the offset is born tied to its source', () => {
  it('every committed piece carries the same link: the source chain, the distance, the side', () => {
    const sk = plateWithOffset(2)
    const pieces = offsetPieces(sk.entities)
    // 6 parallels + 4 convex-corner fillet arcs.
    expect(pieces).toHaveLength(10)

    const links = pieces.map((e) => e.offsetLink)
    expect(links.every((l) => l !== undefined)).toBe(true)
    expect(new Set(links.map((l) => l!.id)).size).toBe(1)
    expect(new Set(links.map((l) => l!.distance))).toEqual(new Set([2]))
    expect(links[0]!.loopSizes).toEqual([10])
    expect(links[0]!.closed).toBe(true)
    // The source is the six-entity chain, in ONE traversal order, no repeats.
    expect(links[0]!.source).toHaveLength(6)
    expect(new Set(links[0]!.source.map((r) => r.entityId))).toEqual(new Set(SOURCE_IDS))
    // Indices cover the whole piece list exactly once.
    expect([...links.map((l) => l!.index)].sort((a, b) => a - b))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    // As built: exactly 2 mm from the source everywhere.
    expect(worstOffsetError(sk.entities, 2)).toBeLessThan(1e-9)
  })

  it('the link is DATA, not a constraint: still no constraint references a source entity', () => {
    const sk = plateWithOffset(2)
    const offsetIds = new Set(offsetPieces(sk.entities).map((e) => e.id))
    const sourceIds = new Set(SOURCE_IDS)
    // The 10 coincidents the offset added chain only its OWN pieces.
    const offsetJoints = sk.constraints.filter((c) =>
      c.kind === 'coincident' && offsetIds.has(c.a.entityId))
    expect(offsetJoints).toHaveLength(10)
    for (const c of offsetJoints) {
      if (c.kind !== 'coincident') continue
      expect(sourceIds.has(c.a.entityId)).toBe(false)
      expect(sourceIds.has(c.b.entityId)).toBe(false)
    }
  })
})

// ---- 2. Editing the source carries the offset ------------------------------------

describe('WO-1859: editing the source carries the offset', () => {
  it('dragging one source edge 5 mm carries the offset, every piece still exactly 2 mm out', async () => {
    const sk = plateWithOffset(2)
    // Before: the parallel of the top edge sits at y = 22.
    expect(horizontalOffsetAt(sk.entities, 22)).not.toBeNull()
    expect(horizontalOffsetAt(sk.entities, 27)).toBeNull()

    const after = await withWrapper((w) => solved(w, sk, dragTopEdgeTo(25)))

    // The source moved.
    const movedTop = after.find((e) => e.id === 'sL3') as SketchLineEntity
    expect(movedTop.start.y).toBeCloseTo(25, 6)
    expect(movedTop.end.y).toBeCloseTo(25, 6)
    // The offset FOLLOWED it, and is still exactly 2 mm from the whole chain.
    expect(horizontalOffsetAt(after, 27)).not.toBeNull()
    expect(horizontalOffsetAt(after, 22)).toBeNull()
    expect(worstOffsetError(after, 2)).toBeLessThan(1e-6)
    // Corners: still four R2 fillets, still centred on the four CONVEX source
    // corners, and the two CONCAVE joints still carry no piece at all (they
    // trim to their exact intersection) -- 6 parallels + 4 fillets.
    expect(offsetPieces(after)).toHaveLength(10)
    const fillets = filletArcs(after, 2)
    expect(fillets).toHaveLength(4)
    const movedCorners = CONVEX_CORNERS.map((c) => c.y === 20 ? { ...c, y: 25 } : c)
    for (const c of movedCorners) {
      expect(fillets.some((a) =>
        Math.abs(a.center.x - c.x) < 1e-6 && Math.abs(a.center.y - c.y) < 1e-6)).toBe(true)
    }
  })

  it('NEGATIVE CONTROL: with the re-offset skipped, the same drag leaves the offset behind', async () => {
    const sk = plateWithOffset(2)
    // The ONLY thing removed is the associative link, so this is the exact
    // pre-WO-1859 one-shot copy going through the exact same solve.
    const unlinked: Sketch = {
      ...sk,
      entities: sk.entities.map((e) => withoutOffsetLink(e)),
    }
    const after = await withWrapper((w) => solved(w, unlinked, dragTopEdgeTo(25)))

    const movedTop = after.find((e) => e.id === 'sL3') as SketchLineEntity
    expect(movedTop.start.y).toBeCloseTo(25, 6)
    // The offset did NOT follow: it is still at 22, now 3 mm from a source
    // edge it is supposed to be 2 mm from -- the silent wrongness WO-1859 exists
    // to remove.
    expect(horizontalOffsetAt(after, 27)).toBeNull()
    expect(horizontalOffsetAt(after, 22)).not.toBeNull()
    expect(worstOffsetError(after, 2)).toBeGreaterThan(0.9)
  })

  it('driving a source dimension 40 -> 60 carries the offset in the SAME solve', async () => {
    const base = plateWithOffset(2, true)
    const driven: Sketch = {
      ...base,
      dimensions: base.dimensions.map((d) => d.id === WIDTH_DIM ? { ...d, value: 60 } : d),
    }
    const after = await withWrapper((w) => solved(w, driven))

    const bottom = after.find((e) => e.id === 'sL1') as SketchLineEntity
    expect(bottom.end.x - bottom.start.x).toBeCloseTo(60, 4)
    // ONE solve, and the offset is already at the new shape: exactly 2 mm from
    // the solved source everywhere, with the same ten pieces.
    expect(offsetPieces(after)).toHaveLength(10)
    expect(worstOffsetError(after, 2)).toBeLessThan(1e-5)
    // The widened plate's bottom-right fillet moved with the corner.
    expect(filletArcs(after, 2).some((a) =>
      Math.abs(a.center.x - 60) < 1e-4 && Math.abs(a.center.y) < 1e-4)).toBe(true)
  })
})

// ---- 3. Changing the offset distance ---------------------------------------------

describe('WO-1859: changing the offset distance re-offsets in place', () => {
  it('2 -> 6 moves the SAME entities: no second chain, no duplicate constraint', () => {
    const sk = plateWithOffset(2)
    const before = offsetPieces(sk.entities).map((e) => e.id).sort()

    const next = setOffsetLinkDistance(sk.entities, offsetLinkIdsIn(sk.entities, before), 6)
    expect(typeof next).not.toBe('string')
    if (typeof next === 'string') return

    // Same entity set, same count, same ids.
    expect(next).toHaveLength(sk.entities.length)
    expect(offsetPieces(next).map((e) => e.id).sort()).toEqual(before)
    // And it is now a 6 mm offset everywhere.
    expect(worstOffsetError(next, 6)).toBeLessThan(1e-9)
    expect(filletArcs(next, 6)).toHaveLength(4)
    // The link itself carries the new distance, so the NEXT solve re-offsets at 6.
    expect(offsetPieces(next).every((e) => e.offsetLink!.distance === 6)).toBe(true)
    // Nothing about the constraint arrays is touched by a distance change.
    expect(sk.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(6 + 10)
  })

  it('a distance the shape cannot take is refused by name and changes nothing', () => {
    const sk = plateWithOffset(2)
    const linkIds = offsetLinkIdsIn(sk.entities, offsetPieces(sk.entities).map((e) => e.id))
    const r = setOffsetLinkDistance(sk.entities, linkIds, -1)
    expect(typeof r).toBe('string')
    expect(r as string).toMatch(/positive/)
  })
})

// ---- 4. The refusal bar (rule 11) and the WO-1475 rule ---------------------------

describe('WO-1859: a source edit the offset cannot follow is never refused', () => {
  // The WO-1475 dumbbell: two 100x100 blocks joined by a 60 x 20 neck. An
  // INWARD offset of 30 collapses the neck; the true offset is two disjoint
  // regions. Here the link is built at a distance where the shape is ONE loop
  // and is then pushed into the collapse.
  const NECK: [number, number][] = [
    [0, 0], [100, 0], [100, 40], [160, 40], [160, 0], [260, 0],
    [260, 100], [160, 100], [160, 60], [100, 60], [100, 100], [0, 100],
  ]

  function neckSketch(distance: number): Sketch {
    const entities: SketchEntity[] = NECK.map(([x, y], i) => {
      const [x2, y2] = NECK[(i + 1) % NECK.length]
      return line(`n${i}`, x, y, x2, y2)
    })
    const constraints: SketchConstraint[] = entities.map((e, i) => ({
      id: newId(), kind: 'coincident' as const,
      a: { entityId: e.id, site: 'end' as const },
      b: { entityId: entities[(i + 1) % entities.length].id, site: 'start' as const },
    }))
    const picked = offsetClick(null, entities, constraints, { x: 130, y: 40 }, 0.5)
    const locked = offsetClick(picked.chain, entities, constraints, { x: 50, y: 50 }, 0.5)
    const commit = offsetApply(locked.chain!, distance, newId)
    if (typeof commit === 'string') throw new Error(commit)
    return {
      id: 'wo1859-neck', layerId: 'L',
      entities: [...entities, ...commit.entities],
      constraints: [...constraints, ...commit.constraints],
      dimensions: [], solveStatus: null,
    }
  }

  it('a 5 mm link recomputes unchanged while the shape holds', () => {
    const sk = neckSketch(5)
    const before = sk.entities.map((e) => JSON.stringify(e))
    const r = recomputeOffsetLinks(sk.entities)
    expect(r.notes).toHaveLength(0)
    expect(r.updatedLinkIds).toHaveLength(1)
    expect(r.entities.map((e) => JSON.stringify(e))).toEqual(before)
  })

  it('a distance that collapses the neck keeps the geometry and says so in one line', () => {
    const sk = neckSketch(5)
    const linked = sk.entities.filter((e) => e.offsetLink)
    const linkId = linked[0].offsetLink!.id
    // 30 mm across this neck separates into TWO regions (the WO-1475 rule),
    // which this 16-piece single loop cannot become in place.
    const collapsed = sk.entities.map((e) =>
      e.offsetLink ? { ...e, offsetLink: { ...e.offsetLink, distance: 30 } } : e)

    const r = recomputeOffsetLinks(collapsed)
    expect(r.updatedLinkIds).toHaveLength(0)
    expect(r.notes).toHaveLength(1)
    expect(r.notes[0].linkId).toBe(linkId)
    expect(r.notes[0].outcome).toBe('kept')
    // The line names what happened to the SHAPE (two loops instead of one).
    expect(r.notes[0].message).toMatch(/2 loops/)
    // Nothing was destroyed, nothing moved: the operator's sketch stays usable,
    // and no crossed loop was ever written.
    expect(r.entities.filter((e) => e.offsetLink)).toHaveLength(linked.length)
    expect(r.entities.map((e) => JSON.stringify(e)))
      .toEqual(collapsed.map((e) => JSON.stringify(e)))
  })

  it('a link that cannot be carried says its line ONCE, not on every solve', () => {
    const sk = neckSketch(5)
    const collapsed = sk.entities.map((e) =>
      e.offsetLink ? { ...e, offsetLink: { ...e.offsetLink, distance: 30 } } : e)
    const lines: string[] = []
    const realInfo = console.info
    console.info = (...args: unknown[]) => { lines.push(args.join(' ')) }
    try {
      applyOffsetLinks(collapsed)
      applyOffsetLinks(collapsed)
      applyOffsetLinks(collapsed)
    } finally {
      console.info = realInfo
    }
    expect(lines.filter((l) => l.startsWith('[offset]'))).toHaveLength(1)
  })
})

// ---- 5. Breaking the link ---------------------------------------------------------

describe('WO-1859: breaking the link', () => {
  it('leaves the geometry at the exact coordinates it had, and source edits stop moving it', async () => {
    const sk = plateWithOffset(2)
    const linkIds = offsetLinkIdsIn(sk.entities, offsetPieces(sk.entities).map((e) => e.id))
    const broken = breakOffsetLinks(sk.entities, linkIds)
    expect(broken).not.toBeNull()

    // EXACT coordinates: the only difference from before is the missing link.
    const strip = (es: readonly SketchEntity[]) =>
      es.map((e) => JSON.stringify(withoutOffsetLink(e)))
    expect(strip(broken!)).toEqual(strip(sk.entities))
    expect(broken!.some((e) => e.offsetLink !== undefined)).toBe(false)

    // And a source edit no longer moves it.
    const after = await withWrapper((w) =>
      solved(w, { ...sk, entities: broken! }, dragTopEdgeTo(25)))
    expect(horizontalOffsetAt(after, 22)).not.toBeNull()
    expect(horizontalOffsetAt(after, 27)).toBeNull()
  })

  it('breaking a link nothing names changes nothing', () => {
    const sk = plateWithOffset(2)
    expect(breakOffsetLinks(sk.entities, ['not-a-link'])).toBeNull()
  })
})

// ---- 6. Deleting the source --------------------------------------------------------

describe('WO-1859: deleting the source', () => {
  it('leaves the offset standing as ordinary geometry - nothing destroyed, nothing dangling', () => {
    const sk = plateWithOffset(2)
    const offsetIds = offsetPieces(sk.entities).map((e) => e.id)

    const r = deleteFromSketch(sk, ['sL3'])
    expect(r).not.toBeNull()
    if (!r) return

    // Every offset piece survives, at its own coordinates, with no link left.
    expect(r.entities.filter((e) => offsetIds.includes(e.id))).toHaveLength(10)
    expect(r.entities.some((e) => e.offsetLink !== undefined)).toBe(false)
    const before = new Map(sk.entities.map((e) => [e.id, JSON.stringify(withoutOffsetLink(e))]))
    for (const e of r.entities) {
      if (!offsetIds.includes(e.id)) continue
      expect(JSON.stringify(e)).toEqual(before.get(e.id))
    }
    // The offset's own ten coincidents survive too, and nothing dangles.
    const surviving = new Set(r.entities.map((e) => e.id))
    for (const c of r.constraints) {
      if (c.kind !== 'coincident') continue
      expect(surviving.has(c.a.entityId)).toBe(true)
      expect(surviving.has(c.b.entityId)).toBe(true)
    }
  })

  it('a recompute after ANY path removed the source drops the link and keeps the geometry', () => {
    const sk = plateWithOffset(2)
    const without = sk.entities.filter((e) => e.id !== 'sA1')
    const r = recomputeOffsetLinks(without)
    expect(r.notes).toHaveLength(1)
    expect(r.notes[0].outcome).toBe('dropped')
    expect(r.entities.some((e) => e.offsetLink !== undefined)).toBe(false)
    expect(r.entities.map((e) => JSON.stringify(withoutOffsetLink(e))))
      .toEqual(without.map((e) => JSON.stringify(withoutOffsetLink(e))))
  })
})

// ---- 7. Save / reload and copy / paste ----------------------------------------------

describe('WO-1859: the link survives save/reload and copy/paste', () => {
  it('a JSON round trip (the .camproject persist path) keeps the link working', async () => {
    const sk = plateWithOffset(2)
    const reloaded = JSON.parse(JSON.stringify(sk)) as Sketch
    expect(offsetPieces(reloaded.entities).every((e) => e.offsetLink !== undefined)).toBe(true)

    const after = await withWrapper((w) => solved(w, reloaded, dragTopEdgeTo(25)))
    expect(horizontalOffsetAt(after, 27)).not.toBeNull()
    expect(worstOffsetError(after, 2)).toBeLessThan(1e-6)
  })

  it('a pasted source+offset pair keeps its OWN link and does not point back at the original', () => {
    const sk = plateWithOffset(2)
    const all = sk.entities.map((e) => e.id)
    const payload = captureSketchClipboard(sk, all)
    expect(payload).not.toBeNull()
    const paste = instantiateSketchClipboard(payload!, { x: 200, y: 200 }, newId, all)

    const pastedOffsets = paste.entities.filter((e) => e.offsetLink)
    expect(pastedOffsets).toHaveLength(10)
    // A NEW link id, and every source ref inside the paste.
    const pastedIds = new Set(paste.entities.map((e) => e.id))
    const originalLink = offsetPieces(sk.entities)[0].offsetLink!.id
    for (const e of pastedOffsets) {
      expect(e.offsetLink!.id).not.toBe(originalLink)
      for (const ref of e.offsetLink!.source) {
        expect(pastedIds.has(ref.entityId)).toBe(true)
        expect(SOURCE_IDS.includes(ref.entityId)).toBe(false)
      }
    }
    expect(new Set(pastedOffsets.map((e) => e.offsetLink!.id)).size).toBe(1)

    // The copy follows its OWN source: a recompute over the paste alone is
    // clean, and every pasted piece is 2 mm from the pasted source.
    const copySource = new Set(pastedOffsets[0].offsetLink!.source.map((r) => r.entityId))
    const r = recomputeOffsetLinks(paste.entities)
    expect(r.notes).toHaveLength(0)
    expect(r.updatedLinkIds).toHaveLength(1)
    const copySources = paste.entities.filter((s) => copySource.has(s.id))
    for (const e of pastedOffsets) {
      for (const p of samples(e)) {
        const nearest = Math.min(...copySources.map((s) => distanceTo(s, p)))
        expect(Math.abs(nearest - 2)).toBeLessThan(1e-6)
      }
    }
  })

  it('an offset pasted WITHOUT its source arrives as ordinary geometry', () => {
    const sk = plateWithOffset(2)
    const offsetIds = offsetPieces(sk.entities).map((e) => e.id)
    const payload = captureSketchClipboard(sk, offsetIds)
    expect(payload).not.toBeNull()
    const paste = instantiateSketchClipboard(payload!, { x: 200, y: 200 }, newId, offsetIds)
    expect(paste.entities).toHaveLength(10)
    // Never a link pointing back at the original's source.
    expect(paste.entities.some((e) => e.offsetLink !== undefined)).toBe(false)
  })
})
