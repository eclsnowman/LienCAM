// Extend tool (interaction framework rework: two-step flow).
//
// Step 1 picks the entity; step 2's cursor selects the end AND the
// boundary (drag farther to reach farther boundaries), with a ghost
// previewing the extension; the click commits the SAME resolution
// (preview-equals-commit). The landing gets coincident (exact boundary
// endpoint) or point_on_object; nothing reachable = a notice, never
// silent.

import { describe, it, expect } from 'vitest'
import {
  extendClick, extendPreview, resolveExtend,
  type ExtendChainState,
} from '../../lib/sketch/tools/extendTool'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import type {
  SketchEntity, SketchArcEntity, SketchLineEntity, Vec2,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `ext-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number,
  construction = false,
): SketchEntity {
  return { id, kind: 'line', construction, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function doc(entities: SketchEntity[]): SketchDoc {
  return { entities, constraints: [], dimensions: [] }
}

/** Step 1: pick the entity at `at`; returns the chain. */
function pick(d: SketchDoc, at: Vec2): ExtendChainState {
  const r = extendClick(null, d, at, 0.5, newId)
  expect(r.chain).not.toBeNull()
  return r.chain!
}

describe('extendClick - two-step flow on lines', () => {
  it('pick, then a cursor toward the boundary commits the extension', () => {
    const d = doc([
      line('T', 0, 0, 5, 0),
      line('B', 10, -5, 10, 5),
    ])
    const chain = pick(d, { x: 2.5, y: 0 })
    const r = extendClick(chain, d, { x: 7, y: 0 }, 0.5, newId)
    expect(r.notice).toBeNull()
    expect(r.chain).toBeNull() // flow complete
    const t = r.transform!
    const ext = t.entities.find((e) => e.id === 'T') as SketchLineEntity
    expect(ext.start).toEqual({ x: 0, y: 0 }) // untouched end
    expect(ext.end.x).toBeCloseTo(10, 9)
    expect(ext.end.y).toBeCloseTo(0, 9)
    // Landing mid-span of the boundary: point_on_object.
    const added = t.constraints[t.constraints.length - 1]
    expect(added.kind).toBe('point_on_object')
    if (added.kind === 'point_on_object') {
      expect(added.point).toEqual({ entityId: 'T', site: 'end' })
      expect(added.object).toBe('B')
    }
  })

  it('preview-equals-commit: the ghost ends exactly where the commit lands', () => {
    const d = doc([
      line('T', 0, 0, 5, 0),
      line('B', 10, -5, 10, 5),
    ])
    const chain = pick(d, { x: 2.5, y: 0 })
    const cursor = { x: 8, y: 0.3 }
    const ghost = extendPreview(chain, d, cursor)!
    const r = extendClick(chain, d, cursor, 0.5, newId)
    const ext = r.transform!.entities.find((e) => e.id === 'T') as SketchLineEntity
    expect(ghost[0]).toEqual({ x: 5, y: 0 }) // from the moving end
    expect(ghost[ghost.length - 1].x).toBeCloseTo(ext.end.x, 12)
    expect(ghost[ghost.length - 1].y).toBeCloseTo(ext.end.y, 12)
  })

  it('cursor before the first boundary selects the NEAREST', () => {
    const d = doc([
      line('T', 0, 0, 5, 0),
      line('FAR', 12, -5, 12, 5),
      line('NEAR', 8, -5, 8, 5),
    ])
    const chain = pick(d, { x: 2.5, y: 0 })
    const r = extendClick(chain, d, { x: 6, y: 0 }, 0.5, newId)
    const ext = r.transform!.entities.find((e) => e.id === 'T') as SketchLineEntity
    expect(ext.end.x).toBeCloseTo(8, 9)
  })

  it('cursor past the near boundary selects the FARTHER one', () => {
    const d = doc([
      line('T', 0, 0, 5, 0),
      line('FAR', 12, -5, 12, 5),
      line('NEAR', 8, -5, 8, 5),
    ])
    const chain = pick(d, { x: 2.5, y: 0 })
    const r = extendClick(chain, d, { x: 10, y: 0 }, 0.5, newId)
    const ext = r.transform!.entities.find((e) => e.id === 'T') as SketchLineEntity
    expect(ext.end.x).toBeCloseTo(12, 9)
    // Overshooting all candidates still lands on the farthest.
    const chain2 = pick(d, { x: 2.5, y: 0 })
    const r2 = extendClick(chain2, d, { x: 100, y: 0 }, 0.5, newId)
    const ext2 = r2.transform!.entities.find((e) => e.id === 'T') as SketchLineEntity
    expect(ext2.end.x).toBeCloseTo(12, 9)
  })

  it('cursor on the start side extends the START', () => {
    const d = doc([
      line('T', 0, 0, 5, 0),
      line('B', -3, -5, -3, 5),
    ])
    const chain = pick(d, { x: 2.5, y: 0 })
    const r = extendClick(chain, d, { x: -1, y: 0 }, 0.5, newId)
    const ext = r.transform!.entities.find((e) => e.id === 'T') as SketchLineEntity
    expect(ext.start.x).toBeCloseTo(-3, 9)
    expect(ext.end).toEqual({ x: 5, y: 0 })
    const added = r.transform!.constraints[r.transform!.constraints.length - 1]
    expect(added.kind).toBe('point_on_object')
    if (added.kind === 'point_on_object') {
      expect(added.point).toEqual({ entityId: 'T', site: 'start' })
    }
  })

  it('landing exactly on a boundary ENDPOINT upgrades to coincident', () => {
    const d = doc([
      line('T', 0, 0, 5, 0),
      line('B', 10, 0, 10, 5), // boundary START sits exactly on the extension
    ])
    const chain = pick(d, { x: 2.5, y: 0 })
    const r = extendClick(chain, d, { x: 7, y: 0 }, 0.5, newId)
    const added = r.transform!.constraints[r.transform!.constraints.length - 1]
    expect(added.kind).toBe('coincident')
    if (added.kind === 'coincident') {
      expect(added.a).toEqual({ entityId: 'T', site: 'end' })
      expect(added.b).toEqual({ entityId: 'B', site: 'start' })
    }
  })

  it('construction geometry is not an extension boundary', () => {
    const d = doc([
      line('T', 0, 0, 5, 0),
      line('C', 10, -5, 10, 5, true),
    ])
    const chain = pick(d, { x: 2.5, y: 0 })
    expect(extendPreview(chain, d, { x: 7, y: 0 })).toBeNull() // no ghost
    const r = extendClick(chain, d, { x: 7, y: 0 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.notice).toMatch(/nothing in that direction/i)
    expect(r.chain).toEqual(chain) // pick survives for a retry
  })

  it('no boundary in the cursor direction = explanatory notice', () => {
    const d = doc([
      line('T', 0, 0, 5, 0),
      line('MISS', 10, 2, 10, 5), // beyond the end but off the line's path
    ])
    const chain = pick(d, { x: 2.5, y: 0 })
    const r = extendClick(chain, d, { x: 7, y: 0 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.notice).toMatch(/nothing in that direction/i)
  })
})

describe('extendClick - arcs and circles', () => {
  it('an arc extends along its own circle toward the cursor', () => {
    // Quarter arc 0..pi/2 on r=5; a horizontal line crosses the full
    // circle at (-5,0) (angle pi) and (5,0) (the arc's own start, which
    // extension may never pass). Cursor past the END selects pi.
    const arc: SketchArcEntity = {
      id: 'A', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2,
    }
    const boundary = line('B', -10, 0, 10, 0)
    const d = doc([arc, boundary])
    const chain = pick(d, { x: 5 * Math.cos(Math.PI / 3), y: 5 * Math.sin(Math.PI / 3) })
    const cursor = { x: 5 * Math.cos(Math.PI * 0.75), y: 5 * Math.sin(Math.PI * 0.75) }
    // Ghost rides the circle from the end to the landing.
    const ghost = extendPreview(chain, d, cursor)!
    for (const p of ghost) expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 9)
    const r = extendClick(chain, d, cursor, 0.5, newId)
    expect(r.notice).toBeNull()
    const ext = r.transform!.entities.find((e) => e.id === 'A') as SketchArcEntity
    expect(ext.startAngle).toBeCloseTo(0, 9)
    expect(ext.endAngle).toBeCloseTo(Math.PI, 9)
    expect(ghost[ghost.length - 1].x).toBeCloseTo(-5, 9)
    expect(ghost[ghost.length - 1].y).toBeCloseTo(0, 9)
    const added = r.transform!.constraints[r.transform!.constraints.length - 1]
    expect(added.kind).toBe('point_on_object')
    if (added.kind === 'point_on_object') {
      expect(added.point).toEqual({ entityId: 'A', site: 'end' })
      expect(added.object).toBe('B')
    }
  })

  it('a cursor on the start side travels clockwise to the boundary', () => {
    // Arc pi/2..pi; a vertical line crosses the circle at (0,-5) = 3pi/2
    // and (0,5) = pi/2 (the arc's own start; travel 0, excluded). A
    // cursor just CW of the start picks the start end -> 3pi/2.
    const arc: SketchArcEntity = {
      id: 'A', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: Math.PI / 2, endAngle: Math.PI,
    }
    const boundary = line('B', 0, -10, 0, 10)
    const d = doc([arc, boundary])
    const chain = pick(d, { x: 5 * Math.cos(Math.PI * 0.55), y: 5 * Math.sin(Math.PI * 0.55) })
    const cursor = { x: 5 * Math.cos(Math.PI * 0.3), y: 5 * Math.sin(Math.PI * 0.3) }
    const r = extendClick(chain, d, cursor, 0.5, newId)
    expect(r.notice).toBeNull()
    const ext = r.transform!.entities.find((e) => e.id === 'A') as SketchArcEntity
    expect(ext.startAngle).toBeCloseTo((3 * Math.PI) / 2, 9)
    expect(ext.endAngle).toBeCloseTo(Math.PI, 9)
  })

  it('a circle cannot extend (named notice at pick time)', () => {
    const circle: SketchEntity = {
      id: 'C', kind: 'circle', construction: false,
      center: { x: 0, y: 0 }, radius: 5,
    }
    const r = extendClick(null, doc([circle]), { x: 0, y: 5 }, 0.5, newId)
    expect(r.chain).toBeNull()
    expect(r.transform).toBeNull()
    expect(r.notice).toMatch(/circle is closed/i)
  })

  it('empty first click is a quiet no-op', () => {
    const r = extendClick(null, doc([line('T', 0, 0, 5, 0)]), { x: 50, y: 50 }, 0.5, newId)
    expect(r.chain).toBeNull()
    expect(r.transform).toBeNull()
    expect(r.notice).toBeNull()
  })
})

describe('resolveExtend', () => {
  it('returns null when nothing is reachable', () => {
    const t = line('T', 0, 0, 5, 0) as SketchLineEntity
    expect(resolveExtend(doc([t]), t, { x: 7, y: 0 })).toBeNull()
  })
})
