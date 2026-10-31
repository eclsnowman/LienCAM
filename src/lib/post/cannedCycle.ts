// ============================================================
// Native canned-cycle reconstruction (Phase C, Item 1)
// ============================================================
// PURE module: given a drill operation and its emitted ToolpathMove[] stream,
// reconstruct the native drilling canned-cycle descriptor (G81/G82/G83) the
// emitter can render in one block per hole. The op itself emits a fully
// expanded plunge/retract stream (ADR-0001 — operations never emit G-code);
// this module re-derives the higher-level cycle intent for dialects that
// support canned cycles.
//
// Contract:
//  - NO throw, NO silent partial. Every failure surfaces as a typed
//    { ok: false, code, message } variant (ADR-0003). The caller decides
//    whether to fall back to expanded linear emission.
//  - Deterministic, no I/O, no globals.
//  - chip_break is intentionally NOT reconstructed: native G73 cannot carry the
//    exact chipBreakRetract distance, so it returns the EXPECTED signal
//    DRILL_CHIP_BREAK_EXPANDED and the caller keeps the expanded stream.

import type { Operation, ToolpathMove } from '../../types'
import type { DrillParams } from '../cam/types'

/** A single hole position with its (possibly per-hole) bottom depth. WORLD coords. */
export interface DrillHole {
  x: number
  y: number
  bottomZ: number
  /** WORLD. Present when the stream lifts the hop INTO this hole above the plane the other
   *  hops cross at - the workholding raise (holderClearance raiseTraverses). A canned cycle
   *  hops at its return plane, so the post ends the cycle, crosses at this Z and restarts it
   *  (WO-3083). */
  liftZ?: number
}

export interface DrillCycleProgram {
  /** simple -> G81, dwell -> G82, peck -> G83. */
  gWord: 'G81' | 'G82' | 'G83'
  /** retractMode 'clearance' -> G98 (return to initial Z), 'retract' -> G99 (return to R). */
  returnMode: 'G98' | 'G99'
  /** WORLD; the plane the cycle starts from. G98 returns here between holes, so it is the
   *  plane the stream hops at (WO-3083: Retract, was Clearance); G99 keeps the clearance plane. */
  initialZ: number
  /** WORLD; the highest Z of the stream (the op's first entry and final exit). */
  clearanceZ: number
  /** Unchecked operation exits at Clearance, including native G99. */
  restoreClearance?: boolean
  /** WORLD; the feed-approach plane R — the feedZ each hole feeds to before plunging. */
  rPlaneZ: number
  /** In program order (the order holes appear in the move stream). */
  holes: DrillHole[]
  /** Plunge feed (mm/min) read from the plunge moves. */
  feed: number
  /** Present for G83 only (= params.peckDepth). */
  peckQ?: number
  /** Present for G82 only, SECONDS: the per-hole ToolpathMove.dwellMs / 1000 read from the
   *  move stream (the same canonical field the runtime estimate adds). WO-1516. */
  dwellSec?: number
}

export type ReconstructResult =
  | { ok: true; program: DrillCycleProgram }
  | { ok: false; code: string; message: string }

const EPS = 1e-6

/** Tolerant XY equality for grouping a contiguous hole run. */
function sameXY(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS
}

/**
 * Reconstruct a native drilling canned-cycle descriptor from a drill op's
 * expanded ToolpathMove[] stream.
 *
 * Expected per-hole shape emitted by buildDrillToolpath:
 *   rapid -> clearanceZ (first hole) | betweenZ (others)
 *   feed  -> feedZ        (type 'feed', role 'rapid')  == the R approach plane
 *   plunge sequence       (type 'feed', role 'plunge') -> per-hole bottom
 *   rapid -> betweenZ
 * Final: rapid -> clearanceZ.
 * A hop the reach trim raised over workholding arrives as extra rapids above betweenZ.
 */
export function reconstructDrillCycles(op: Operation, moves: ToolpathMove[], wcsOriginZ = 0): ReconstructResult {
  // Read cycleType the way the worker does — params is a generic record; the
  // drill op stores a DrillParams shape under it.
  const params = op.params as unknown as DrillParams
  const cycleType = params?.cycleType

  if (cycleType === 'chip_break') {
    // EXPECTED signal, not an error: native G73 cannot carry the exact
    // chipBreakRetract distance (Q2 decision (b)). Caller falls back to the
    // expanded linear stream the op already emitted.
    return {
      ok: false,
      code: 'DRILL_CHIP_BREAK_EXPANDED',
      message:
        'Chip-break drilling stays expanded: native G73 cannot carry the exact ' +
        'chipBreakRetract distance. Emit the linear plunge/retract stream instead.',
    }
  }

  if (cycleType !== 'simple' && cycleType !== 'peck' && cycleType !== 'dwell') {
    return {
      ok: false,
      code: 'DRILL_CYCLE_MALFORMED',
      message:
        `Drill canned-cycle reconstruction: unrecognized cycleType ` +
        `"${String(cycleType)}" on op ${op.id}.`,
    }
  }

  // WO-1926: a shrinking peck sequence (peckDecrement > 0) has a different Q for
  // every peck, which one native G83 block cannot carry. Refuse BY NAME and let
  // the caller fall back to the already-correct expanded linear stream — never
  // silently post a constant-Q G83 that does not match the toolpath it was built
  // from (rule 11). A constant-peck sequence (decrement unset/0) reconstructs as
  // native G83 exactly as before.
  const peckDecrement = params.peckDecrement
  if (cycleType === 'peck' && typeof peckDecrement === 'number'
      && Number.isFinite(peckDecrement) && peckDecrement > 0) {
    return {
      ok: false,
      code: 'DRILL_PECK_DECREMENT_EXPANDED',
      message:
        'Peck depths shrink by peckDecrement, which a single native G83 Q cannot ' +
        'express. Emit the expanded linear plunge/retract stream instead.',
    }
  }

  const gWord: 'G81' | 'G82' | 'G83' =
    cycleType === 'simple' ? 'G81' : cycleType === 'dwell' ? 'G82' : 'G83'

  const returnMode: 'G98' | 'G99' =
    params.retractMode === 'retract' ? 'G99' : 'G98'

  // initialZ = clearance plane = the max Z across all drill moves.
  if (moves.length === 0) {
    return {
      ok: false,
      code: 'DRILL_CYCLE_MALFORMED',
      message: `Drill canned-cycle reconstruction: empty move stream on op ${op.id}.`,
    }
  }
  const clearanceZ = Math.max(...moves.map(m => m.z))

  // Group moves into per-hole cycles. A hole is a contiguous run sharing one
  // XY that contains at least one plunge (role 'plunge') move. We walk the
  // stream, and each time we encounter a plunge move at a new XY (or the first
  // plunge), we open a hole; plunges sharing that XY accumulate into it.
  const holes: DrillHole[] = []
  // Per hole: the index of its approach move and of its last plunge (the hop to the next hole
  // is everything between the two).
  const approachAt: number[] = []
  const lastPlungeAt: number[] = []
  let rPlaneZ: number | undefined
  let feed: number | undefined

  // Per-hole accumulation state.
  let curXY: { x: number; y: number } | null = null
  let curMinZ = Infinity
  let curApproachZ: number | undefined // feedZ for this hole (the role 'rapid' feed move)
  // Dwell (ms) summed over this hole's plunges. G82's P is modal, so every hole
  // must carry the same pause; a stream that differs cannot be one canned cycle.
  let curDwellMs = 0
  let holeDwellMs: number | undefined
  let curApproachAt = -1
  let curLastPlungeAt = -1

  const flush = (): string | null => {
    if (curXY && curMinZ !== Infinity) {
      holes.push({ x: curXY.x, y: curXY.y, bottomZ: curMinZ })
      approachAt.push(curApproachAt)
      lastPlungeAt.push(curLastPlungeAt)
      if (holeDwellMs === undefined) holeDwellMs = curDwellMs
      else if (Math.abs(holeDwellMs - curDwellMs) > EPS) {
        return `hole dwell varies between holes (${holeDwellMs} ms vs ${curDwellMs} ms); ` +
          `a single G82 cycle carries one modal P.`
      }
    }
    curXY = null
    curMinZ = Infinity
    curApproachZ = undefined
    curDwellMs = 0
    return null
  }
  const malformed = (detail: string): ReconstructResult => ({
    ok: false,
    code: 'DRILL_CYCLE_MALFORMED',
    message: `Drill canned-cycle reconstruction: ${detail} (op ${op.id}).`,
  })

  for (let idx = 0; idx < moves.length; idx++) {
    const m = moves[idx]
    if (m.dwellMs !== undefined && m.dwellMs !== 0) {
      if (!Number.isFinite(m.dwellMs) || m.dwellMs < 0) {
        return malformed(`a move carries an invalid dwell ${String(m.dwellMs)}`)
      }
      if (m.role !== 'plunge') {
        return malformed(`a ${m.role ?? m.type} move carries a dwell; only a hole-bottom pause fits a canned cycle`)
      }
      if (cycleType !== 'dwell') {
        return malformed(`a ${cycleType} cycle's plunge carries a dwell that ${gWord} cannot express`)
      }
    }

    if (m.role === 'rapid' && (m.type === 'feed'
        || (op.heights?.minimizeZTravel === false && m.type === 'rapid' && m.feed !== undefined))) {
      // Approach-to-feedZ move: marks the R plane for the hole about to start.
      // It also marks the boundary of a new hole.
      const dwellMismatch = flush()
      if (dwellMismatch) return malformed(dwellMismatch)
      curApproachZ = m.z
      curApproachAt = idx
      curXY = { x: m.x, y: m.y }
      // R plane must be consistent across all holes.
      if (rPlaneZ === undefined) {
        rPlaneZ = m.z
      } else if (Math.abs(rPlaneZ - m.z) > EPS) {
        return {
          ok: false,
          code: 'DRILL_CYCLE_MALFORMED',
          message:
            `Drill canned-cycle reconstruction: R approach plane varies between ` +
            `holes (${rPlaneZ} vs ${m.z}) on op ${op.id}. A single canned cycle ` +
            `requires one constant R plane.`,
        }
      }
      continue
    }

    if (m.role === 'plunge') {
      if (curXY === null) {
        // A plunge with no preceding approach-to-feedZ move — malformed shape.
        return {
          ok: false,
          code: 'DRILL_CYCLE_MALFORMED',
          message:
            `Drill canned-cycle reconstruction: a plunge move at ` +
            `(${m.x}, ${m.y}) has no preceding feed-to-R approach on op ${op.id}.`,
        }
      }
      if (!sameXY(curXY, m)) {
        // A plunge at a different XY than the open hole — the stream does not
        // match the expected approach-then-plunge grouping.
        return {
          ok: false,
          code: 'DRILL_CYCLE_MALFORMED',
          message:
            `Drill canned-cycle reconstruction: plunge XY (${m.x}, ${m.y}) ` +
            `differs from the hole's approach XY (${curXY.x}, ${curXY.y}) on op ${op.id}.`,
        }
      }
      curMinZ = Math.min(curMinZ, m.z)
      curLastPlungeAt = idx
      curDwellMs += m.dwellMs ?? 0
      if (m.feed !== undefined) {
        if (feed === undefined) feed = m.feed
      }
      // Track the approach plane just to assert it was set (ADR-0003 clarity).
      void curApproachZ
    }
    // rapid moves (retracts / repositions) are ignored for grouping.
  }
  const lastDwellMismatch = flush()
  if (lastDwellMismatch) return malformed(lastDwellMismatch)

  if (holes.length === 0) {
    return {
      ok: false,
      code: 'DRILL_CYCLE_MALFORMED',
      message:
        `Drill canned-cycle reconstruction: no plunge moves found on op ${op.id}; ` +
        `the move stream does not contain any drillable holes.`,
    }
  }

  if (rPlaneZ === undefined) {
    return {
      ok: false,
      code: 'DRILL_CYCLE_MALFORMED',
      message:
        `Drill canned-cycle reconstruction: no feed-to-R approach move found on ` +
        `op ${op.id}; cannot determine the R plane.`,
    }
  }

  if (feed === undefined) {
    return {
      ok: false,
      code: 'DRILL_CYCLE_MALFORMED',
      message:
        `Drill canned-cycle reconstruction: no plunge feed rate found on op ${op.id}.`,
    }
  }

  // WO-3083 (owner 2026-10-23: "We don't need to go that high unless a reposition move would go
  // over a clamp"). The plane the stream hops at is the one it rises to straight out of each
  // hole (the move after the hole's last plunge). The Z a hop crosses at is the highest move
  // from one hole's last plunge to the next hole's approach; a hop above the plane is one the
  // reach trim raised over workholding, and that hole carries its liftZ so the post never lets
  // the cycle's own return plane cross the clamp.
  // WO-3104: R is Feed, not a generic travel floor. G99 returns to R even
  // when Feed differs from Retract; its explicit between-feature lift must
  // still reproduce the stream (and retain any higher clamp detour).
  const unchecked = op.heights?.minimizeZTravel === false
  const floor = unchecked
    ? (op.resolvedHeights?.wcs.retract ?? op.heights.retractHeight) + wcsOriginZ : -Infinity
  if (unchecked) rPlaneZ = (op.resolvedHeights?.wcs.feed ?? op.heights.feedHeight) + wcsOriginZ
  const hopPlaneZ = Math.min(...lastPlungeAt.map(j => moves[j + 1]?.z ?? clearanceZ))
  const returnZ = unchecked && returnMode === 'G99' ? rPlaneZ : hopPlaneZ
  for (let k = 1; k < holes.length; k++) {
    let z = -Infinity
    for (let j = lastPlungeAt[k - 1] + 1; j < approachAt[k]; j++) z = Math.max(z, moves[j].z)
    if (z > returnZ + EPS) holes[k].liftZ = z
  }
  // G98's initial plane is its return plane; G99's R is its return plane.
  const initialZ = returnMode === 'G98' ? Math.max(hopPlaneZ, rPlaneZ, floor) : Math.max(clearanceZ, floor)

  const program: DrillCycleProgram = {
    gWord,
    returnMode,
    initialZ,
    clearanceZ,
    ...(unchecked ? { restoreClearance: true } : {}),
    rPlaneZ,
    holes,
    feed,
  }

  if (cycleType === 'peck') {
    program.peckQ = params.peckDepth
  } else if (cycleType === 'dwell') {
    program.dwellSec = (holeDwellMs ?? 0) / 1000
  }

  return { ok: true, program }
}
