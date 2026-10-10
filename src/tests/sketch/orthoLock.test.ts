// Ortho-lock (Shift while drawing) — headless coverage.
//
// Pins the 8-sector mapping, the 22.5 deg sector boundaries, the
// projected-length invariant (the locked point lies on the ray at the
// projection distance), the degenerate anchor==cursor case, and the
// chain-anchor helpers (line tool only).

import { describe, it, expect } from 'vitest'
import {
  applyOrthoLock,
  orthoAnchor,
  orthoLockCursor,
} from '../../lib/sketch/orthoLock'
import type { Vec2 } from '../../lib/sketch/types'
import type { ToolChainState } from '../../lib/sketch/tools/toolMachine'

const A: Vec2 = { x: 10, y: 20 } // a non-origin anchor to catch offset bugs

/** Angle (deg, 0..360) of p relative to anchor A. */
function angDeg(a: Vec2, p: Vec2): number {
  const d = Math.atan2(p.y - a.y, p.x - a.x) * 180 / Math.PI
  return (d + 360) % 360
}

function dist(a: Vec2, p: Vec2): number {
  return Math.hypot(p.x - a.x, p.y - a.y)
}

describe('applyOrthoLock — 8 sectors map to the right axis', () => {
  // Each cursor is placed clearly inside one sector; the locked point must
  // land on that sector's exact ray angle.
  const cases: Array<{ name: string; cursor: Vec2; deg: number }> = [
    { name: '0 (E)',   cursor: { x: A.x + 10, y: A.y + 1 },   deg: 0 },
    { name: '45 (NE)', cursor: { x: A.x + 10, y: A.y + 9 },   deg: 45 },
    { name: '90 (N)',  cursor: { x: A.x + 1,  y: A.y + 10 },  deg: 90 },
    { name: '135 (NW)',cursor: { x: A.x - 9,  y: A.y + 10 },  deg: 135 },
    { name: '180 (W)', cursor: { x: A.x - 10, y: A.y + 1 },   deg: 180 },
    { name: '225 (SW)',cursor: { x: A.x - 10, y: A.y - 9 },   deg: 225 },
    { name: '270 (S)', cursor: { x: A.x - 1,  y: A.y - 10 },  deg: 270 },
    { name: '315 (SE)',cursor: { x: A.x + 9,  y: A.y - 10 },  deg: 315 },
  ]
  for (const c of cases) {
    it(`sector ${c.name}`, () => {
      const locked = applyOrthoLock(A, c.cursor)
      expect(angDeg(A, locked)).toBeCloseTo(c.deg, 6)
    })
  }
})

describe('applyOrthoLock — axis cases land EXACTLY on the axis', () => {
  it('horizontal: y == anchor.y, x == cursor.x', () => {
    const locked = applyOrthoLock(A, { x: A.x + 7, y: A.y + 2 })
    expect(locked.y).toBe(A.y)        // exact, no trig round-off on axes
    expect(locked.x).toBeCloseTo(A.x + 7, 9)
  })
  it('vertical: x == anchor.x, y == cursor.y', () => {
    const locked = applyOrthoLock(A, { x: A.x - 2, y: A.y + 7 })
    expect(locked.x).toBe(A.x)
    expect(locked.y).toBeCloseTo(A.y + 7, 9)
  })
})

describe('applyOrthoLock — sector boundaries (22.5 deg edges)', () => {
  // Just below 22.5 deg snaps to 0; just above snaps to 45. The boundary
  // itself (exactly 22.5) is allowed to land on either adjacent ray.
  it('22 deg -> 0', () => {
    const r = 10
    const t = 22 * Math.PI / 180
    const locked = applyOrthoLock(A, { x: A.x + r * Math.cos(t), y: A.y + r * Math.sin(t) })
    expect(angDeg(A, locked)).toBeCloseTo(0, 6)
  })
  it('23 deg -> 45', () => {
    const r = 10
    const t = 23 * Math.PI / 180
    const locked = applyOrthoLock(A, { x: A.x + r * Math.cos(t), y: A.y + r * Math.sin(t) })
    expect(angDeg(A, locked)).toBeCloseTo(45, 6)
  })
  it('67 deg -> 45', () => {
    const r = 10
    const t = 67 * Math.PI / 180
    const locked = applyOrthoLock(A, { x: A.x + r * Math.cos(t), y: A.y + r * Math.sin(t) })
    expect(angDeg(A, locked)).toBeCloseTo(45, 6)
  })
  it('68 deg -> 90', () => {
    const r = 10
    const t = 68 * Math.PI / 180
    const locked = applyOrthoLock(A, { x: A.x + r * Math.cos(t), y: A.y + r * Math.sin(t) })
    expect(angDeg(A, locked)).toBeCloseTo(90, 6)
  })
})

describe('applyOrthoLock — projected length is the ray projection', () => {
  it('45 deg: distance = |offset| * cos(angle from ray)', () => {
    // Cursor at 30 deg, radius 10 -> nearest ray 45, projection = 10*cos(15deg).
    const r = 10
    const t = 30 * Math.PI / 180
    const cursor = { x: A.x + r * Math.cos(t), y: A.y + r * Math.sin(t) }
    const locked = applyOrthoLock(A, cursor)
    expect(angDeg(A, locked)).toBeCloseTo(45, 6)
    expect(dist(A, locked)).toBeCloseTo(r * Math.cos(15 * Math.PI / 180), 9)
  })
  it('on-axis cursor keeps its full length (idempotent on the ray)', () => {
    const cursor = { x: A.x + 12, y: A.y } // already on the 0 deg ray
    const locked = applyOrthoLock(A, cursor)
    expect(locked.x).toBeCloseTo(A.x + 12, 9)
    expect(locked.y).toBe(A.y)
    // Re-locking a point already on the ray returns the same point.
    const again = applyOrthoLock(A, locked)
    expect(again.x).toBeCloseTo(locked.x, 9)
    expect(again.y).toBeCloseTo(locked.y, 9)
  })
})

describe('applyOrthoLock — degenerate anchor==cursor', () => {
  it('returns the anchor (no direction to lock)', () => {
    const locked = applyOrthoLock(A, { x: A.x, y: A.y })
    expect(locked).toEqual({ x: A.x, y: A.y })
  })
})

describe('chain anchor helpers', () => {
  it('orthoAnchor returns the line chain prev point', () => {
    const chain: ToolChainState = {
      kind: 'line', start: { x: 0, y: 0 }, firstLineId: null,
      prev: { x: 3, y: 4 }, prevLineId: null,
    }
    expect(orthoAnchor(chain)).toEqual({ x: 3, y: 4 })
  })
  it('orthoAnchor returns the rectangle anchor (the first click -> Shift square)', () => {
    const chain: ToolChainState = { kind: 'rect', mode: 'corner', anchor: { x: 1, y: 2 } }
    expect(orthoAnchor(chain)).toEqual({ x: 1, y: 2 })
  })
  it('orthoAnchor returns the polygon center', () => {
    const chain: ToolChainState = { kind: 'polygon', center: { x: 5, y: 6 } }
    expect(orthoAnchor(chain)).toEqual({ x: 5, y: 6 })
  })
  it('orthoAnchor returns the ellipse center for the major-axis step, null after', () => {
    const major: ToolChainState = { kind: 'ellipse', center: { x: 5, y: 6 }, major: null }
    expect(orthoAnchor(major)).toEqual({ x: 5, y: 6 })
    // After the major axis is placed, the next step is the MINOR DISTANCE
    // (perpendicular) -> not a direction step, ortho skipped.
    const minor: ToolChainState = { kind: 'ellipse', center: { x: 5, y: 6 }, major: { x: 9, y: 6 } }
    expect(orthoAnchor(minor)).toBeNull()
  })
  it('orthoAnchor returns the elliptical-arc center for the major-axis step, null after', () => {
    const major: ToolChainState = {
      kind: 'ellipse-arc', center: { x: 5, y: 6 }, major: null, minor: null, start: null,
    }
    expect(orthoAnchor(major)).toEqual({ x: 5, y: 6 })
    // Minor-distance and start/end PARAM picks are not direction steps.
    const minor: ToolChainState = {
      kind: 'ellipse-arc', center: { x: 5, y: 6 }, major: { x: 9, y: 6 }, minor: null, start: null,
    }
    expect(orthoAnchor(minor)).toBeNull()
  })
  it('orthoAnchor returns cap A for the slot axis step, null for the width step', () => {
    const axis: ToolChainState = { kind: 'slot', a: { x: 1, y: 1 }, b: null }
    expect(orthoAnchor(axis)).toEqual({ x: 1, y: 1 })
    const width: ToolChainState = { kind: 'slot', a: { x: 1, y: 1 }, b: { x: 4, y: 1 } }
    expect(orthoAnchor(width)).toBeNull()
  })
  it('orthoAnchor returns the centerline start for the arc-slot first step, null after', () => {
    const first: ToolChainState = { kind: 'slotArc', start: { x: 2, y: 3 }, end: null, thru: null }
    expect(orthoAnchor(first)).toEqual({ x: 2, y: 3 })
    // Through-point (bends the arc) and width steps are not direction steps.
    const thru: ToolChainState = { kind: 'slotArc', start: { x: 2, y: 3 }, end: { x: 8, y: 3 }, thru: null }
    expect(orthoAnchor(thru)).toBeNull()
  })
  it('orthoAnchor returns null for a circle (radius step) and arc', () => {
    const circ: ToolChainState = { kind: 'circle', mode: 'center', p1: { x: 0, y: 0 }, p2: null }
    expect(orthoAnchor(circ)).toBeNull()
  })
  it('orthoAnchor returns null with no chain', () => {
    expect(orthoAnchor(null)).toBeNull()
  })
  it('orthoLockCursor locks against the line anchor', () => {
    const chain: ToolChainState = {
      kind: 'line', start: { x: 0, y: 0 }, firstLineId: null,
      prev: { x: 0, y: 0 }, prevLineId: null,
    }
    // Cursor near-horizontal from (0,0) -> locks to the 0 deg ray.
    const locked = orthoLockCursor(chain, { x: 10, y: 1 })
    expect(locked.y).toBe(0)
    expect(locked.x).toBeCloseTo(10, 9)
  })
  it('orthoLockCursor passes the cursor through with no anchor', () => {
    const cursor = { x: 7, y: 3 }
    expect(orthoLockCursor(null, cursor)).toEqual(cursor)
  })
})
