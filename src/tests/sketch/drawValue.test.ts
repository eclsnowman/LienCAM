// Heads-up "type a value mid-draw" (Tier 1b): the PURE commit function.
// Typing a scalar mid-draw must build the entity at EXACTLY that value and
// a DRIVING dimension whose value equals the shown scalar (preview ===
// commit). Headless: no store, no three.js, no DOM.

import { describe, it, expect } from 'vitest'
import {
  commitDrawValue, drawValueScalar,
} from '../../lib/sketch/tools/drawValue'
import { applyOrthoLock } from '../../lib/sketch/orthoLock'
import type { ToolState } from '../../lib/sketch/tools/toolMachine'
import type { Vec2 } from '../../lib/sketch/types'

// Deterministic id factory (matches the dimPlacement.test.ts convention).
const newIds = () => {
  let n = 0
  return () => `id${n++}`
}

function lineState(prev: Vec2, opts: Partial<{ start: Vec2; prevLineId: string | null; firstLineId: string | null }> = {}): ToolState {
  return {
    tool: 'line',
    chain: {
      kind: 'line',
      start: opts.start ?? { x: 0, y: 0 },
      firstLineId: opts.firstLineId ?? null,
      prev,
      prevLineId: opts.prevLineId ?? null,
    },
  }
}

function circleCenterState(center: Vec2): ToolState {
  return { tool: 'circle-center', chain: { kind: 'circle', mode: 'center', p1: center, p2: null } }
}

function arcCenterState(center: Vec2, start: Vec2): ToolState {
  return { tool: 'arc-center', chain: { kind: 'arc', mode: 'center', center, start } }
}

const SQRT1_2 = Math.SQRT1_2

// ---- LINE ------------------------------------------------------------------

describe('commitDrawValue - line', () => {
  it('places the endpoint at the exact typed length along the cursor direction (axis)', () => {
    const st = lineState({ x: 0, y: 0 })
    const r = commitDrawValue(st, { x: 50, y: 0 }, 10, newIds())
    expect(r).not.toBeNull()
    const line = r!.commit.entities[0]
    expect(line.kind).toBe('line')
    if (line.kind !== 'line') throw new Error('not a line')
    expect(line.start).toEqual({ x: 0, y: 0 })
    expect(line.end.x).toBeCloseTo(10, 9)
    expect(line.end.y).toBeCloseTo(0, 9)
  })

  it('creates a DRIVING distance dimension equal to the typed value', () => {
    const st = lineState({ x: 0, y: 0 })
    const r = commitDrawValue(st, { x: 50, y: 0 }, 10, newIds())!
    expect(r.commit.dimensions).toHaveLength(1)
    const d = r.commit.dimensions![0]
    expect(d.kind).toBe('distance')
    expect(d.driving).toBe(true)
    expect(d.value).toBe(10)
  })

  it('honors an arbitrary (SHIFT-locked) direction: 45deg ray', () => {
    // The caller passes the already-ortho-locked cursor; a 45deg cursor
    // yields an endpoint on that ray at the typed distance.
    const st = lineState({ x: 0, y: 0 })
    const r = commitDrawValue(st, { x: 100, y: 100 }, 10, newIds())!
    const line = r.commit.entities[0]
    if (line.kind !== 'line') throw new Error('not a line')
    expect(line.end.x).toBeCloseTo(10 * SQRT1_2, 9)
    expect(line.end.y).toBeCloseTo(10 * SQRT1_2, 9)
    expect(Math.hypot(line.end.x, line.end.y)).toBeCloseTo(10, 9)
  })

  it('advances the chain so the polyline continues from the typed endpoint', () => {
    const st = lineState({ x: 0, y: 0 }, { firstLineId: 'L0', prevLineId: 'L0' })
    const r = commitDrawValue(st, { x: 50, y: 0 }, 10, newIds())!
    expect(r.nextChain).not.toBeNull()
    expect(r.nextChain!.kind).toBe('line')
    if (r.nextChain!.kind !== 'line') throw new Error('chain kind')
    expect(r.nextChain!.prev.x).toBeCloseTo(10, 9)
    // A continued segment carries the auto coincident constraint joining it
    // to the previous segment's endpoint.
    expect(r.commit.constraints.some((c) => c.kind === 'coincident')).toBe(true)
  })

  it('returns null when the cursor sits on the anchor (no direction)', () => {
    const st = lineState({ x: 5, y: 5 })
    expect(commitDrawValue(st, { x: 5, y: 5 }, 10, newIds())).toBeNull()
  })
})

// ---- LINE: typed value KEEPS the ortho-locked direction (T1) ----------------
// The viewport feeds the already-ortho-locked cursor (getLastSketchCursor) to
// commitDrawValue. A line that LOOKS horizontal / 45deg must commit in that
// exact direction at the typed length, not along the raw cursor.

describe('commitDrawValue - keeps the ortho-locked direction at the typed length', () => {
  it('horizontal lock -> horizontal line of the typed length', () => {
    const anchor: Vec2 = { x: 3, y: 7 }
    // Raw cursor a few degrees off horizontal; the lock pulls it onto the ray.
    const locked = applyOrthoLock(anchor, { x: anchor.x + 40, y: anchor.y + 3 })
    const r = commitDrawValue(lineState(anchor, { start: anchor }), locked, 12, newIds())!
    const line = r.commit.entities[0]
    if (line.kind !== 'line') throw new Error('not a line')
    expect(line.end.y).toBeCloseTo(anchor.y, 9)        // stayed horizontal
    expect(line.end.x).toBeCloseTo(anchor.x + 12, 9)   // typed length, +x
    expect(Math.hypot(line.end.x - anchor.x, line.end.y - anchor.y)).toBeCloseTo(12, 9)
  })

  it('45deg lock -> 45deg line of the typed length', () => {
    const anchor: Vec2 = { x: 3, y: 7 }
    const locked = applyOrthoLock(anchor, { x: anchor.x + 30, y: anchor.y + 26 }) // ~41deg -> 45
    const r = commitDrawValue(lineState(anchor, { start: anchor }), locked, 10, newIds())!
    const line = r.commit.entities[0]
    if (line.kind !== 'line') throw new Error('not a line')
    const ex = line.end.x - anchor.x, ey = line.end.y - anchor.y
    expect(ex).toBeCloseTo(10 * Math.SQRT1_2, 9)
    expect(ey).toBeCloseTo(10 * Math.SQRT1_2, 9)
    expect(Math.hypot(ex, ey)).toBeCloseTo(10, 9)
  })

  it('vertical lock -> vertical line of the typed length', () => {
    const anchor: Vec2 = { x: -2, y: 1 }
    const locked = applyOrthoLock(anchor, { x: anchor.x - 2, y: anchor.y + 50 })
    const r = commitDrawValue(lineState(anchor, { start: anchor }), locked, 8, newIds())!
    const line = r.commit.entities[0]
    if (line.kind !== 'line') throw new Error('not a line')
    expect(line.end.x).toBeCloseTo(anchor.x, 9)        // stayed vertical
    expect(line.end.y).toBeCloseTo(anchor.y + 8, 9)    // typed length, +y
  })
})

// ---- CIRCLE ----------------------------------------------------------------

describe('commitDrawValue - circle (center mode)', () => {
  it('builds a circle of exactly the typed radius', () => {
    const st = circleCenterState({ x: 3, y: 4 })
    const r = commitDrawValue(st, { x: 30, y: 4 }, 7, newIds())!
    const c = r.commit.entities[0]
    expect(c.kind).toBe('circle')
    if (c.kind !== 'circle') throw new Error('not a circle')
    expect(c.center).toEqual({ x: 3, y: 4 })
    expect(c.radius).toBeCloseTo(7, 9)
    expect(r.nextChain).toBeNull() // a circle ends the chain
  })

  it('creates a DRIVING radius dimension equal to the typed value', () => {
    const st = circleCenterState({ x: 0, y: 0 })
    const r = commitDrawValue(st, { x: 10, y: 0 }, 7, newIds())!
    expect(r.commit.dimensions).toHaveLength(1)
    const d = r.commit.dimensions![0]
    expect(d.kind).toBe('radius')
    expect(d.driving).toBe(true)
    expect(d.value).toBe(7)
  })

  it('radius is rotation-invariant: works even with cursor on the center', () => {
    const st = circleCenterState({ x: 0, y: 0 })
    const r = commitDrawValue(st, { x: 0, y: 0 }, 5, newIds())!
    const c = r.commit.entities[0]
    if (c.kind !== 'circle') throw new Error('not a circle')
    expect(c.radius).toBeCloseTo(5, 9)
  })
})

// ---- ARC (pure-only radius override) ---------------------------------------

describe('commitDrawValue - arc (center mode, radius override)', () => {
  it('builds an arc at the typed radius keeping center + start/end angles', () => {
    const st = arcCenterState({ x: 0, y: 0 }, { x: 1, y: 0 }) // startAngle 0
    const r = commitDrawValue(st, { x: 0, y: 1 }, 8, newIds())! // endAngle pi/2
    const a = r.commit.entities[0]
    expect(a.kind).toBe('arc')
    if (a.kind !== 'arc') throw new Error('not an arc')
    expect(a.radius).toBeCloseTo(8, 9)
    expect(a.startAngle).toBeCloseTo(0, 9)
    expect(a.endAngle).toBeCloseTo(Math.PI / 2, 9)
  })

  it('creates a DRIVING radius dimension equal to the typed value', () => {
    const st = arcCenterState({ x: 0, y: 0 }, { x: 1, y: 0 })
    const r = commitDrawValue(st, { x: 0, y: 1 }, 8, newIds())!
    const d = r.commit.dimensions![0]
    expect(d.kind).toBe('radius')
    expect(d.driving).toBe(true)
    expect(d.value).toBe(8)
  })

  it('returns null for a zero-sweep arc (cursor on the start ray)', () => {
    const st = arcCenterState({ x: 0, y: 0 }, { x: 1, y: 0 })
    expect(commitDrawValue(st, { x: 5, y: 0 }, 8, newIds())).toBeNull()
  })
})

// ---- Invalid values + unsupported states -----------------------------------

describe('commitDrawValue - rejection', () => {
  it('rejects value <= 0', () => {
    expect(commitDrawValue(lineState({ x: 0, y: 0 }), { x: 1, y: 0 }, 0, newIds())).toBeNull()
    expect(commitDrawValue(lineState({ x: 0, y: 0 }), { x: 1, y: 0 }, -3, newIds())).toBeNull()
  })

  it('rejects NaN / non-finite value', () => {
    expect(commitDrawValue(lineState({ x: 0, y: 0 }), { x: 1, y: 0 }, NaN, newIds())).toBeNull()
    expect(commitDrawValue(lineState({ x: 0, y: 0 }), { x: 1, y: 0 }, Infinity, newIds())).toBeNull()
  })

  it('returns null for circle-3pt and unsupported tools', () => {
    const c3: ToolState = { tool: 'circle-3pt', chain: { kind: 'circle', mode: '3pt', p1: { x: 0, y: 0 }, p2: null } }
    expect(commitDrawValue(c3, { x: 5, y: 0 }, 4, newIds())).toBeNull()
    const rect: ToolState = { tool: 'rect-corner', chain: null }
    expect(commitDrawValue(rect, { x: 5, y: 0 }, 4, newIds())).toBeNull()
  })

  it('returns null when no chain is in progress', () => {
    expect(commitDrawValue({ tool: 'line', chain: null }, { x: 5, y: 0 }, 4, newIds())).toBeNull()
  })
})

// ---- Live scalar (what the box shows) --------------------------------------

describe('drawValueScalar', () => {
  it('line -> length from the previous chain point', () => {
    const s = drawValueScalar(lineState({ x: 0, y: 0 }), { x: 3, y: 4 })
    expect(s).toEqual({ kind: 'length', value: 5, anchor: { x: 0, y: 0 } })
  })

  it('circle-center -> radius from the center', () => {
    const s = drawValueScalar(circleCenterState({ x: 0, y: 0 }), { x: 6, y: 8 })
    expect(s).toEqual({ kind: 'radius', value: 10, anchor: { x: 0, y: 0 } })
  })

  it('returns null for arc-center (not surfaced as a live box) and unanchored states', () => {
    expect(drawValueScalar(arcCenterState({ x: 0, y: 0 }, { x: 1, y: 0 }), { x: 0, y: 1 })).toBeNull()
    expect(drawValueScalar({ tool: 'line', chain: null }, { x: 1, y: 1 })).toBeNull()
  })

  it('shown line length equals the baked dimension value (preview === commit)', () => {
    const st = lineState({ x: 0, y: 0 })
    const cursor = { x: 7, y: 0 }
    const shown = drawValueScalar(st, cursor)!.value // 7
    // Baking that exact shown value reproduces it on the driving dim.
    const r = commitDrawValue(st, cursor, shown, newIds())!
    expect(r.commit.dimensions![0].value).toBe(shown)
  })

  // ---- FILLET: radius surfaced near the cursor -----------------------------
  it('fillet (armed) -> the current fillet radius, anchored at the cursor', () => {
    // Armed is enough: chain may still be null before the first corner.
    const s = drawValueScalar(
      { tool: 'fillet', chain: null }, { x: 12, y: 34 }, { filletRadius: 5 },
    )
    expect(s).toEqual({ kind: 'radius', value: 5, anchor: { x: 12, y: 34 } })
  })

  it('fillet also surfaces once a corner chain exists', () => {
    const chain = { kind: 'fillet' as const, corners: [], pendingLineId: null, pendingClick: null }
    const s = drawValueScalar({ tool: 'fillet', chain }, { x: 1, y: 2 }, { filletRadius: 3 })
    expect(s).toEqual({ kind: 'radius', value: 3, anchor: { x: 1, y: 2 } })
  })

  it('fillet -> null when no radius is supplied or it is non-positive', () => {
    expect(drawValueScalar({ tool: 'fillet', chain: null }, { x: 0, y: 0 })).toBeNull()
    expect(
      drawValueScalar({ tool: 'fillet', chain: null }, { x: 0, y: 0 }, { filletRadius: 0 }),
    ).toBeNull()
    expect(
      drawValueScalar({ tool: 'fillet', chain: null }, { x: 0, y: 0 }, { filletRadius: -4 }),
    ).toBeNull()
  })

  it('a non-fillet tool ignores the fillet radius context (line still needs its chain)', () => {
    expect(
      drawValueScalar({ tool: 'line', chain: null }, { x: 1, y: 1 }, { filletRadius: 9 }),
    ).toBeNull()
  })

  // ---- CHAMFER: setback surfaced through the same size box ---------------
  it('SKC-45 chamfer (armed) -> the current setback, anchored at the cursor', () => {
    const s = drawValueScalar(
      { tool: 'chamfer', chain: null }, { x: 12, y: 34 }, { chamferSetback: 5 },
    )
    expect(s).toEqual({ kind: 'length', value: 5, anchor: { x: 12, y: 34 } })
  })

  it('SKC-45 chamfer rejects missing, non-finite, and non-positive setbacks', () => {
    const state: ToolState = { tool: 'chamfer', chain: null }
    const cursor = { x: 0, y: 0 }
    expect(drawValueScalar(state, cursor)).toBeNull()
    expect(drawValueScalar(state, cursor, { chamferSetback: Number.NaN })).toBeNull()
    expect(drawValueScalar(state, cursor, { chamferSetback: Number.POSITIVE_INFINITY })).toBeNull()
    expect(drawValueScalar(state, cursor, { chamferSetback: 0 })).toBeNull()
  })
})
