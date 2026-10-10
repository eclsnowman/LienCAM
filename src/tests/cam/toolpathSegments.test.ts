// Toolpath render buffer regression (stage 5 gate finding 2).
//
// The viewport drew each role as one polyline and inserted NaN sentinel
// vertices to break discontinuities (a role resuming after other-role moves),
// which made THREE.computeBoundingSphere log "Computed radius is NaN" console
// errors on every toolpath render. buildToolpathRoleSegments replaces the
// sentinel scheme with explicit segment pairs: these tests pin that
//   (a) NO non-finite value ever appears in any produced vertex buffer,
//       INCLUDING the discontinuous-role case that used to get sentinels,
//   (b) the drawn segments are exactly move[i-1] -> move[i] in move[i]'s role,
//   (c) defensively, non-finite DATA (not expected from producers) is dropped
//       rather than forwarded to the GPU.

import { describe, it, expect } from 'vitest'
import {
  buildToolpathRoleSegments,
  buildToolpathRoleSegmentsIndexed,
  resolveSelectedMoveFacts,
  resolveMovePickFromSegment,
  buildEndCaps,
  type MoveOwner,
  type ToolpathPickPayload,
} from '../../lib/viewport/toolpathSegments'
import type { ToolpathMove } from '../../types'

const mv = (
  type: ToolpathMove['type'], x: number, y: number, z: number,
  role?: ToolpathMove['role'],
): ToolpathMove => ({ type, x, y, z, role })

function allFinite(buf: Float32Array): boolean {
  for (const v of buf) if (!Number.isFinite(v)) return false
  return true
}

describe('buildToolpathRoleSegments', () => {
  it('discontinuous role (the old NaN-sentinel case) yields finite buffers only', () => {
    // cut, then a rapid interruption, then cut resumes elsewhere — the old
    // builder pushed a NaN,NaN,NaN vertex into the cut polyline here.
    const moves = [
      mv('feed', 0, 0, -1, 'cut'),
      mv('feed', 10, 0, -1, 'cut'),
      mv('rapid', 10, 0, 5, 'rapid'),
      mv('rapid', 20, 20, 5, 'rapid'),
      mv('feed', 20, 20, -1, 'plunge'),
      mv('feed', 30, 20, -1, 'cut'),
    ]
    const groups = buildToolpathRoleSegments(moves)
    expect([...groups.keys()].sort()).toEqual(['cut', 'plunge', 'rapid'])
    for (const buf of groups.values()) {
      expect(buf.length % 6).toBe(0)
      expect(allFinite(buf)).toBe(true)
    }
    // cut: segments (0,0,-1)->(10,0,-1) and (20,20,-1)->(30,20,-1) — the
    // discontinuity is expressed by the pair layout, not a sentinel.
    expect(Array.from(groups.get('cut')!)).toEqual([
      0, 0, -1, 10, 0, -1,
      20, 20, -1, 30, 20, -1,
    ])
  })

  it('segments connect each move to its predecessor in the move own role', () => {
    const moves = [
      mv('rapid', 0, 0, 5),            // no role: rapid by type
      mv('feed', 1, 1, -2),            // no role: cut by type
      mv('feed', 2, 1, -2, 'lead_in'),
    ]
    const groups = buildToolpathRoleSegments(moves)
    expect(Array.from(groups.get('cut')!)).toEqual([0, 0, 5, 1, 1, -2])
    expect(Array.from(groups.get('lead_in')!)).toEqual([1, 1, -2, 2, 1, -2])
  })

  it('renders arc moves as sampled segments instead of endpoint chords', () => {
    const moves: ToolpathMove[] = [
      { type: 'feed', x: 3, y: 0, z: -1, role: 'finish' },
      { type: 'arc_cw', x: -3, y: 0, z: -1, cx: 0, cy: 0, role: 'finish', feed: 700 },
    ]
    const finish = buildToolpathRoleSegments(moves).get('finish')!
    expect(finish.length).toBeGreaterThan(6)
    for (let i = 0; i < finish.length; i += 6) {
      const len = Math.hypot(
        finish[i + 3] - finish[i],
        finish[i + 4] - finish[i + 1],
        finish[i + 5] - finish[i + 2],
      )
      expect(len).toBeLessThanOrEqual(0.37)
      expect(Math.hypot(finish[i], finish[i + 1])).toBeCloseTo(3, 4)
      expect(Math.hypot(finish[i + 3], finish[i + 4])).toBeCloseTo(3, 4)
    }
  })

  it('drops segments touching a non-finite move instead of forwarding NaN', () => {
    const moves = [
      mv('feed', 0, 0, -1, 'cut'),
      mv('feed', NaN, 0, -1, 'cut'),   // bad data: into-segment skipped
      mv('feed', 20, 0, -1, 'cut'),    // out-of-segment skipped too (unknown from)
      mv('feed', 30, 0, -1, 'cut'),    // resumes from the last finite move
    ]
    const groups = buildToolpathRoleSegments(moves)
    const cut = groups.get('cut')!
    expect(allFinite(cut)).toBe(true)
    expect(Array.from(cut)).toEqual([20, 0, -1, 30, 0, -1])
  })

  it('returns no group for fewer than 2 moves or all-degenerate input', () => {
    expect(buildToolpathRoleSegments([]).size).toBe(0)
    expect(buildToolpathRoleSegments([mv('rapid', 0, 0, 5)]).size).toBe(0)
    expect(buildToolpathRoleSegments([
      mv('rapid', NaN, 0, 5), mv('rapid', 1, 0, 5),
    ]).size).toBe(0)
  })
})

// PP-MOVE-PICK: the indexed builder draws identical geometry AND records which
// move (and owner) produced each drawn segment, so a raycast hit resolves to a
// specific (operationId, moveIndex) pick.
describe('buildToolpathRoleSegmentsIndexed (PP-MOVE-PICK attribution)', () => {
  const owner = (operationId: string, indexInOp: number, moveCount: number): MoveOwner =>
    ({ operationId, indexInOp, moveCount })

  it('draws byte-identical geometry to the plain builder', () => {
    const moves = [
      mv('rapid', 0, 0, 5),
      mv('feed', 1, 1, -2),
      mv('feed', 2, 1, -2, 'lead_in'),
    ]
    const plain = buildToolpathRoleSegments(moves)
    const indexed = buildToolpathRoleSegmentsIndexed(moves)
    expect([...indexed.keys()].sort()).toEqual([...plain.keys()].sort())
    for (const [role, data] of indexed) {
      expect(Array.from(data.positions)).toEqual(Array.from(plain.get(role)!))
    }
  })

  it('attributes each segment to its owner and raw index (owners raw-aligned)', () => {
    // 3 raw moves -> 2 segments. owners aligned to RAW moves.
    const moves = [
      mv('feed', 0, 0, -1, 'cut'),   // raw 0
      mv('feed', 10, 0, -1, 'cut'),  // raw 1 -> segment (0)->(10) owned here
      mv('feed', 20, 0, -1, 'cut'),  // raw 2 -> segment (10)->(20) owned here
    ]
    const owners = [owner('op-A', 0, 3), owner('op-A', 1, 3), owner('op-A', 2, 3)]
    const cut = buildToolpathRoleSegmentsIndexed(moves, owners).get('cut')!
    expect(cut.segOwners).toHaveLength(2)
    expect(cut.segOwners[0]).toEqual(owner('op-A', 1, 3)) // seg owned by its 'to' move
    expect(cut.segOwners[1]).toEqual(owner('op-A', 2, 3))
    expect(Array.from(cut.segRawIndex)).toEqual([1, 2])
  })

  it('carries a null owner (un-pickable) for a synthetic un-owned move', () => {
    const moves = [
      mv('feed', 0, 0, -1, 'cut'),    // raw 0
      mv('rapid', 5, 0, 5, 'rapid'),  // raw 1 = inter-section link, no owner
      mv('feed', 5, 0, -1, 'cut'),    // raw 2
    ]
    const owners = [owner('op-A', 0, 1), null, owner('op-B', 0, 1)]
    const indexed = buildToolpathRoleSegmentsIndexed(moves, owners)
    // rapid segment (0)->(5,5) is owned by raw 1 == null
    expect(indexed.get('rapid')!.segOwners[0]).toBeNull()
    // the cut segment into raw 2 belongs to op-B
    expect(indexed.get('cut')!.segOwners[0]).toEqual(owner('op-B', 0, 1))
  })

  it('maps every sampled point of an arc back to the SAME owning move', () => {
    const moves: ToolpathMove[] = [
      { type: 'feed', x: 3, y: 0, z: -1, role: 'finish' },                              // raw 0
      { type: 'arc_cw', x: -3, y: 0, z: -1, cx: 0, cy: 0, role: 'finish', feed: 700 },  // raw 1
    ]
    const owners = [owner('op-A', 0, 2), owner('op-A', 1, 2)]
    const finish = buildToolpathRoleSegmentsIndexed(moves, owners).get('finish')!
    expect(finish.segOwners.length).toBeGreaterThan(1) // arc expanded into many
    for (const o of finish.segOwners) expect(o).toEqual(owner('op-A', 1, 2))
    for (const r of finish.segRawIndex) expect(r).toBe(1)
  })

  it('resolveSelectedMoveFacts builds panel-ready facts (role, length, feed)', () => {
    const raw: ToolpathMove = { type: 'arc_cw', x: -3, y: 0, z: -1, cx: 0, cy: 0, role: 'finish', feed: 700 }
    const facts = resolveSelectedMoveFacts(
      raw, owner('op-A', 4, 12), { x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })
    expect(facts).toMatchObject({
      operationId: 'op-A', moveIndex: 4, moveCount: 12,
      moveType: 'arc_cw', role: 'finish', feed: 700, lengthMm: 5,
    })
    expect(facts.from).toEqual({ x: 0, y: 0, z: 0 })
    expect(facts.to).toEqual({ x: 3, y: 4, z: 0 })
  })

  it('resolveMovePickFromSegment maps a segment hit to facts, refuses un-owned', () => {
    const rawMoves: ToolpathMove[] = [
      { type: 'feed', x: 0, y: 0, z: -1 },              // raw 0
      { type: 'feed', x: 10, y: 0, z: -1, feed: 500 },  // raw 1
      { type: 'rapid', x: 10, y: 5, z: 5 },             // raw 2 (link)
    ]
    const positions = new Float32Array([
      0, 0, -1, 10, 0, -1,   // segment 0: from raw0 -> raw1
      10, 0, -1, 10, 5, 5,   // segment 1: link (un-owned)
    ])
    const payload: ToolpathPickPayload = {
      role: 'cut',
      segOwners: [{ operationId: 'op-A', indexInOp: 1, moveCount: 3 }, null],
      segRawIndex: Int32Array.from([1, 2]),
      rawMoves,
    }
    const hit = resolveMovePickFromSegment(payload, positions, 0)
    expect(hit).toMatchObject({
      operationId: 'op-A', moveIndex: 1, role: 'cut', feed: 500, lengthMm: 10,
    })
    expect((hit as { from: { x: number } }).from.x).toBe(0)
    // un-owned synthetic link segment -> refused (ADR-0003, refuse by name)
    expect(resolveMovePickFromSegment(payload, positions, 1)).toEqual({ refused: true })
    // out of range -> null
    expect(resolveMovePickFromSegment(payload, positions, 9)).toBeNull()
  })

  it('resolveSelectedMoveFacts defaults role like playback (untyped rapid/cut)', () => {
    const rapid = resolveSelectedMoveFacts(
      { type: 'rapid', x: 1, y: 0, z: 0 }, owner('op', 0, 1), { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })
    expect(rapid.role).toBe('rapid')
    expect(rapid.feed).toBeUndefined()
    const cut = resolveSelectedMoveFacts(
      { type: 'feed', x: 1, y: 0, z: 0 }, owner('op', 0, 1), { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })
    expect(cut.role).toBe('cut')
  })
})

// Float32 round-trip loses precision; compare component-wise with tolerance.
function expectVec(buf: Float32Array, off: number, exp: number[]) {
  for (let i = 0; i < exp.length; i++) {
    expect(buf[off + i]).toBeCloseTo(exp[i], 4)
  }
}

describe('buildEndCaps (P5 solid end caps on dashed runs)', () => {
  it('caps both ends of a single open run, oriented inward, length-clamped', () => {
    // One run: (0,0,0)->(10,0,0)->(20,0,0). Two segment pairs.
    const buf = new Float32Array([
      0, 0, 0, 10, 0, 0,
      10, 0, 0, 20, 0, 0,
    ])
    const caps = buildEndCaps(buf, 0.8)!
    expect(caps).not.toBeNull()
    expect(caps.length).toBe(12) // two caps, two vertices each
    // start cap: from (0,0,0) inward +x by 0.8
    expectVec(caps, 0, [0, 0, 0, 0.8, 0, 0])
    // end cap: from (20,0,0) inward -x by 0.8
    expectVec(caps, 6, [20, 0, 0, 19.2, 0, 0])
  })

  it('caps each disjoint run independently', () => {
    // Two separate single-segment runs.
    const buf = new Float32Array([
      0, 0, 0, 5, 0, 0,
      100, 0, 0, 105, 0, 0,
    ])
    const caps = buildEndCaps(buf, 1)!
    // 2 runs x 2 ends = 4 caps
    expect(caps.length).toBe(24)
  })

  it('clamps cap to half a short terminal segment', () => {
    const buf = new Float32Array([0, 0, 0, 1, 0, 0]) // length 1, capLen 0.8
    const caps = buildEndCaps(buf, 0.8)!
    // cap clamped to 0.5 (half of 1) at each end
    expectVec(caps, 0, [0, 0, 0, 0.5, 0, 0])
    expectVec(caps, 6, [1, 0, 0, 0.5, 0, 0])
  })

  it('returns null for empty input', () => {
    expect(buildEndCaps(new Float32Array([]), 0.8)).toBeNull()
  })
})
