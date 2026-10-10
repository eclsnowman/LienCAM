// Pure toolpath-move -> per-role GPU vertex buffer builder.
//
// The viewport used to draw each role as ONE polyline (THREE.Line) and break
// discontinuities (a role resuming after other-role moves in between) by
// inserting NaN sentinel vertices. Three.js renders the breaks, but
// computeBoundingSphere() sees the NaN positions and logs a console error
// per geometry ("Computed radius is NaN") on every toolpath render.
//
// This builder produces explicit SEGMENT PAIRS instead — two vertices per
// drawn segment, consumed with THREE.LineSegments — so discontinuities need
// no sentinel and NO non-finite value ever reaches a GPU buffer. The drawn
// picture is identical: every move i renders the straight segment
// from move[i-1]'s position to move[i]'s position in move[i]'s role group.
//
// Belt-and-braces: segments with any non-finite endpoint coordinate are
// dropped (warned once per call) rather than corrupting the buffer —
// toolpath data is expected to be finite (producers are the place to fix),
// but the renderer must never forward NaN to the GPU regardless.

import type { SelectedMove, ToolpathMove, Vec3 } from '../../types'
import { sampleArcMovesForLinearConsumers } from '../cam/toolpathArcSampling'
import { effectiveMoveRole } from '../cam/stockCuttingRoles'

export function moveRole(m: ToolpathMove): string {
  return m.role ?? (m.type === 'rapid' ? 'rapid' : 'cut')
}

/** PP-MOVE-PICK: which operation + in-op index a drawn move belongs to. Built by
 *  the viewport render pipeline (Viewport.tsx), aligned 1:1 to the RAW (pre arc
 *  sampling) flat moves array. `null` marks a synthetic move with no owner (the
 *  inter-section rapid link the renderer inserts between operations), which is
 *  intentionally NOT pickable. */
export interface MoveOwner {
  operationId: string
  /** Index of this move within its operation's drawn section (0-based). */
  indexInOp: number
  /** Total moves in that operation's drawn section. */
  moveCount: number
}

/** PP-MOVE-PICK: one role bucket's GPU buffer PLUS the per-segment attribution
 *  needed to resolve a raycast hit back to a specific move. `segOwners[s]` and
 *  `segRawIndex[s]` describe the s-th drawn segment (vertices 2s, 2s+1). */
export interface RoleSegmentData {
  positions: Float32Array
  /** Owner of each segment (its RAW 'to' move's owner), or null for un-owned
   *  synthetic links. Length = positions.length / 6. */
  segOwners: (MoveOwner | null)[]
  /** Index into the RAW flat moves array of each segment's 'to' move — used to
   *  recover the original move type/feed for the picked segment. */
  segRawIndex: Int32Array
}

/** Per-role flat xyz vertex arrays (segment pairs, LineSegments layout). */
export function buildToolpathRoleSegments(
  moves: ToolpathMove[],
): Map<string, Float32Array> {
  const indexed = buildToolpathRoleSegmentsIndexed(moves)
  const out = new Map<string, Float32Array>()
  for (const [role, data] of indexed) out.set(role, data.positions)
  return out
}

/** PP-MOVE-PICK: the drawing buffers AND per-segment move attribution. The
 *  drawn geometry is byte-identical to `buildToolpathRoleSegments`; this variant
 *  additionally records, per segment, which move (and owner) produced it so the
 *  viewport can raycast a segment back to a `(operationId, moveIndex)` pick.
 *  `owners`, when supplied, is aligned 1:1 to the RAW `moves` array. */
export function buildToolpathRoleSegmentsIndexed(
  moves: ToolpathMove[],
  owners?: (MoveOwner | null)[],
): Map<string, RoleSegmentData> {
  const originIndices: number[] = []
  const linearMoves = sampleArcMovesForLinearConsumers(moves, {}, originIndices)
  type Acc = { pos: number[]; owners: (MoveOwner | null)[]; raw: number[] }
  const acc = new Map<string, Acc>()
  if (linearMoves.length >= 2) {
    let warned = false
    let prevX = linearMoves[0].x, prevY = linearMoves[0].y, prevZ = linearMoves[0].z
    let prevOk =
      Number.isFinite(prevX) && Number.isFinite(prevY) && Number.isFinite(prevZ)
    for (let i = 1; i < linearMoves.length; i++) {
      const m = linearMoves[i]
      const ok =
        Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z)
      if (prevOk && ok) {
        const role = moveRole(m)
        let a = acc.get(role)
        if (!a) { a = { pos: [], owners: [], raw: [] }; acc.set(role, a) }
        a.pos.push(prevX, prevY, prevZ, m.x, m.y, m.z)
        // The segment is owned by its 'to' move (linear index i), whose RAW
        // source index is originIndices[i]; the owner tag comes from the caller's
        // raw-aligned array (null when un-owned or no owners supplied).
        const rawIdx = originIndices[i] ?? i
        a.raw.push(rawIdx)
        a.owners.push(owners ? (owners[rawIdx] ?? null) : null)
      } else if (!warned) {
        warned = true
        console.warn(
          `[toolpathSegments] non-finite coordinate in toolpath move ${i}; ` +
          'segment skipped (fix the producing operation)'
        )
      }
      // A bad move's position is unknowable, so the NEXT segment (which
      // starts there) is skipped too rather than bridged across.
      if (ok) { prevX = m.x; prevY = m.y; prevZ = m.z }
      prevOk = ok
    }
  }
  const out = new Map<string, RoleSegmentData>()
  for (const [role, a] of acc) {
    if (a.pos.length >= 6) {
      out.set(role, {
        positions: new Float32Array(a.pos),
        segOwners: a.owners,
        segRawIndex: Int32Array.from(a.raw),
      })
    }
  }
  return out
}

/** PP-MOVE-PICK: the per-body attribution the viewport stows on each toolpath
 *  role LineSegments' `userData` so a raycast hit resolves to a move. `rawMoves`
 *  is the (shared) flat raw moves array the buffer was built from. */
export interface ToolpathPickPayload {
  role: string
  segOwners: (MoveOwner | null)[]
  segRawIndex: Int32Array
  rawMoves: ToolpathMove[]
}

/** PP-MOVE-PICK: resolve a raycast segment hit to a picked move. Pure (no GL) so
 *  the segment->facts mapping unit-tests without a renderer. `positions` is the
 *  body's vertex buffer; `segIndex` is the hit segment (raycaster index / 2).
 *  Returns the resolved facts, or `{ refused: true }` when the segment is an
 *  un-owned synthetic link (ADR-0003: the caller refuses BY NAME in the console,
 *  never silently), or `null` when the index is out of range. */
export function resolveMovePickFromSegment(
  payload: ToolpathPickPayload,
  positions: Float32Array,
  segIndex: number,
): SelectedMove | { refused: true } | null {
  if (segIndex < 0 || segIndex >= payload.segOwners.length) return null
  const owner = payload.segOwners[segIndex]
  const rawIdx = payload.segRawIndex[segIndex]
  const raw = payload.rawMoves[rawIdx]
  if (owner == null || raw == null) return { refused: true }
  const o = segIndex * 6
  const from = { x: positions[o], y: positions[o + 1], z: positions[o + 2] }
  const to = { x: positions[o + 3], y: positions[o + 4], z: positions[o + 5] }
  return resolveSelectedMoveFacts(raw, owner, from, to)
}

/** PP-MOVE-PICK: assemble the panel-ready facts for one picked segment from its
 *  raw owning move, owner, and world endpoints. Pure so it unit-tests without a
 *  renderer. `role` uses the canonical `effectiveMoveRole` (same authority the
 *  simulation frame builder uses), so the panel's role label matches playback. */
export function resolveSelectedMoveFacts(
  raw: ToolpathMove,
  owner: MoveOwner,
  from: Vec3,
  to: Vec3,
): SelectedMove {
  return {
    operationId: owner.operationId,
    moveIndex: owner.indexInOp,
    moveCount: owner.moveCount,
    moveType: raw.type,
    role: effectiveMoveRole(raw),
    from: { ...from },
    to: { ...to },
    lengthMm: Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z),
    feed: raw.feed,
  }
}

// ---------------------------------------------------------------------------
// Solid end caps for dashed roles (P5 dash policy, board v2).
//
// A dashed role's polyline can end mid-void, making a join with another path
// read as a gap. Operator's verdict: dashed motion roles (rapid, fast_traverse,
// stepover) keep their dashes BUT terminate SOLID — a short solid segment at
// each end of every contiguous run so junctions always read connected.
//
// The role buffer is an UNORDERED set of segment pairs (LineSegments layout).
// We first chain the pairs into contiguous runs (a run end where one segment's
// endpoint coincides with the next segment's start point), then emit one short
// solid cap at each run terminus, oriented along the run's terminal segment.
//
// `capLen` is a small WORLD-space length (mm). Screen-space px would require
// per-frame recompute on zoom; a fixed world length is the agreed simple
// approximation (see Phase 4 brief). The cap never exceeds half the terminal
// segment length so a very short terminal segment is simply drawn fully solid.

const EPS = 1e-4

function keyOf(x: number, y: number, z: number): string {
  // Quantize to EPS grid so floating coincident endpoints chain together.
  const q = (n: number) => Math.round(n / EPS)
  return `${q(x)},${q(y)},${q(z)}`
}

/**
 * Given a role's segment-pair buffer, return a segment-pair buffer of short
 * solid caps at each end of each contiguous polyline run. Returns null when
 * there is nothing to cap.
 */
export function buildEndCaps(
  positions: Float32Array,
  capLen: number,
): Float32Array | null {
  const segCount = Math.floor(positions.length / 6)
  if (segCount === 0) return null

  // Build adjacency: map quantized point -> list of {seg, end} touching it.
  // Then walk runs greedily. Each segment is used once.
  type Pt = { x: number; y: number; z: number }
  const segA: Pt[] = []
  const segB: Pt[] = []
  for (let s = 0; s < segCount; s++) {
    const o = s * 6
    segA.push({ x: positions[o], y: positions[o + 1], z: positions[o + 2] })
    segB.push({ x: positions[o + 3], y: positions[o + 4], z: positions[o + 5] })
  }

  // point key -> segment indices touching it
  const touch = new Map<string, number[]>()
  const add = (k: string, s: number) => {
    let l = touch.get(k); if (!l) { l = []; touch.set(k, l) }; l.push(s)
  }
  for (let s = 0; s < segCount; s++) {
    add(keyOf(segA[s].x, segA[s].y, segA[s].z), s)
    add(keyOf(segB[s].x, segB[s].y, segB[s].z), s)
  }

  const used = new Array<boolean>(segCount).fill(false)
  const caps: number[] = []

  // A run terminus: emit a solid cap from the terminus point inward along the
  // terminal segment.
  const emitCap = (from: Pt, to: Pt) => {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
    const len = Math.hypot(dx, dy, dz)
    if (len < EPS) return
    const t = Math.min(capLen, len * 0.5) / len
    caps.push(from.x, from.y, from.z,
              from.x + dx * t, from.y + dy * t, from.z + dz * t)
  }

  // Walk: start runs from endpoints with degree 1 (true termini), then mop up
  // any remaining segments (closed loops have no degree-1 endpoint).
  const degree = (p: Pt) => (touch.get(keyOf(p.x, p.y, p.z))?.length ?? 0)

  const walkFrom = (startSeg: number, startAtA: boolean) => {
    // Walk the chain, marking segments used; cap both true ends.
    let curSeg = startSeg
    let entryPt = startAtA ? segA[curSeg] : segB[curSeg]
    // cap at the entry terminus
    const otherOfEntry = startAtA ? segB[curSeg] : segA[curSeg]
    emitCap(entryPt, otherOfEntry)
    // advance until no unused continuation
    let frontPt = otherOfEntry
    used[curSeg] = true
    for (;;) {
      const cand = touch.get(keyOf(frontPt.x, frontPt.y, frontPt.z)) ?? []
      let next = -1
      for (const c of cand) { if (!used[c]) { next = c; break } }
      if (next === -1) break
      const aMatch =
        keyOf(segA[next].x, segA[next].y, segA[next].z) ===
        keyOf(frontPt.x, frontPt.y, frontPt.z)
      used[next] = true
      frontPt = aMatch ? segB[next] : segA[next]
      curSeg = next
    }
    // cap at the far terminus (frontPt is the last front; come from its other end)
    // recover the segment we ended on to orient the far cap
    const endSeg = curSeg
    const endInward =
      keyOf(segB[endSeg].x, segB[endSeg].y, segB[endSeg].z) ===
      keyOf(frontPt.x, frontPt.y, frontPt.z)
        ? segA[endSeg] : segB[endSeg]
    emitCap(frontPt, endInward)
  }

  // 1) open-run termini (degree-1 endpoints)
  for (let s = 0; s < segCount; s++) {
    if (used[s]) continue
    if (degree(segA[s]) === 1) walkFrom(s, true)
    else if (degree(segB[s]) === 1) walkFrom(s, false)
  }
  // 2) leftover (closed loops / tangled) - cap each remaining segment's own ends
  for (let s = 0; s < segCount; s++) {
    if (used[s]) continue
    used[s] = true
    emitCap(segA[s], segB[s])
    emitCap(segB[s], segA[s])
  }

  return caps.length >= 6 ? new Float32Array(caps) : null
}
