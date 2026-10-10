// cam3d L6 boundary: ToolpathIR -> app ToolpathMove[] converter.
//
// This is the ONE place cam3d's internal IR (ir/types.ts) is translated into
// the app-wide ToolpathMove shape (src/types/index.ts). Importing src/types
// here is the sanctioned L6 crossing; strategy/kernel layers never do it.
//
// Pure, deterministic, no side effects: same IR in -> byte-identical move
// array out, on every run (D-006). Move order is preserved exactly.
//
// The one non-verbatim mapping is the arc center. IrMove i/j are the center
// offset FROM THE ARC START (G2/G3 convention), while ToolpathMove cx/cy are
// ABSOLUTE. The arc start is the previous move's endpoint, so we carry a
// running point and compute cx = prevX + i, cy = prevY + j (per D-012/D-018).

import type { IrMove, IrMoveRole, ToolpathIR } from './types';
import type { MoveRole, ToolpathMove } from '../../types';

/**
 * Operation-resolved rates accepted by the L6 IR conversion boundary.
 * Kept structural so cam3d/ir does not depend on the app feedrate resolver.
 */
export interface ResolvedIrFeedrates {
  feedRate: number;
  plungeRate: number;
  rampRate: number;
  leadInRate: number;
  leadOutRate: number;
  finishRate: number;
}

// Compile-time proof that EVERY IrMoveRole is a valid MoveRole. If a role is
// ever added to IrMoveRole that MoveRole does not have, this object literal
// fails to type-check (a missing key or a non-assignable value), stopping the
// build -- we widen MoveRole or the mapping rather than silently drop a role.
// The `move.role = m.role` assignment below is the runtime pass-through; this
// table is the loud, exhaustive guard the brief asks for.
const IR_ROLE_TO_MOVE_ROLE: Record<IrMoveRole, MoveRole> = {
  rapid: 'rapid',
  cut: 'cut',
  plunge: 'plunge',
  ramp: 'ramp',
  lead_in: 'lead_in',
  lead_out: 'lead_out',
  stepover: 'stepover',
  finish: 'finish',
};

const IR_ROLE_TO_RATE: Record<Exclude<IrMoveRole, 'rapid'>, keyof ResolvedIrFeedrates> = {
  cut: 'feedRate',
  plunge: 'plungeRate',
  ramp: 'rampRate',
  lead_in: 'leadInRate',
  lead_out: 'leadOutRate',
  stepover: 'feedRate',
  finish: 'finishRate',
};

function resolvedFeedForMove(
  move: IrMove,
  moveIndex: number,
  feeds: ResolvedIrFeedrates,
): number | undefined {
  if (move.t === 'rapid') {
    if (move.role !== undefined && move.role !== 'rapid') {
      throw new Error(
        `irToToolpathMoves: rapid move ${moveIndex} has non-rapid role "${move.role}".`,
      );
    }
    return undefined;
  }

  if (move.f !== undefined) {
    if (!Number.isFinite(move.f) || move.f <= 0) {
      throw new Error(
        `irToToolpathMoves: move ${moveIndex} has invalid explicit feed ${String(move.f)}; ` +
          'expected a finite positive mm/min value.',
      );
    }
    return move.f;
  }

  if (move.role === undefined) {
    throw new Error(
      `irToToolpathMoves: non-rapid move ${moveIndex} has no role and no explicit feed; ` +
        'the operation boundary cannot resolve its commanded rate.',
    );
  }
  if (move.role === 'rapid') {
    throw new Error(
      `irToToolpathMoves: non-rapid move ${moveIndex} has rapid role and no explicit feed.`,
    );
  }

  const rateKey = IR_ROLE_TO_RATE[move.role];
  const feed = feeds[rateKey];
  if (!Number.isFinite(feed) || feed <= 0) {
    throw new Error(
      `irToToolpathMoves: move ${moveIndex} role "${move.role}" resolved ${rateKey} ` +
        `to ${String(feed)}; expected a finite positive mm/min value.`,
    );
  }
  return feed;
}

/**
 * Convert a ToolpathIR to the app's ToolpathMove[]. Deterministic and pure.
 * Throws (never silently guesses) if an arc lacks a preceding move or i/j.
 */
export function irToToolpathMoves(
  ir: ToolpathIR,
  resolvedFeeds?: ResolvedIrFeedrates,
): ToolpathMove[] {
  const out: ToolpathMove[] = new Array<ToolpathMove>(ir.moves.length);
  let prevX = 0;
  let prevY = 0;
  let haveStart = false;

  for (let k = 0; k < ir.moves.length; k++) {
    const m: IrMove = ir.moves[k];
    let move: ToolpathMove;

    if (m.t === 'arc') {
      if (!haveStart) {
        throw new Error(
          `irToToolpathMoves: move ${k} is an arc with no preceding move; its ` +
            `center (i/j) is relative to the arc start, which is undefined.`,
        );
      }
      if (m.i === undefined || m.j === undefined) {
        throw new Error(
          `irToToolpathMoves: arc move ${k} is missing its i/j center offset.`,
        );
      }
      move = {
        type: m.cw === true ? 'arc_cw' : 'arc_ccw',
        x: m.x,
        y: m.y,
        z: m.z,
        // Start-relative i/j -> absolute center (arc start = previous endpoint).
        cx: prevX + m.i,
        cy: prevY + m.j,
      };
    } else {
      // 'rapid' | 'feed' -> type verbatim.
      move = { type: m.t, x: m.x, y: m.y, z: m.z };
    }

    if (resolvedFeeds !== undefined) {
      const feed = resolvedFeedForMove(m, k, resolvedFeeds);
      if (feed !== undefined) move.feed = feed;
    } else if (m.f !== undefined) {
      move.feed = m.f;
    }
    // Pass-through: IrMoveRole is a subset of MoveRole (proved by the table
    // above and enforced by this very assignment at compile time).
    if (m.role !== undefined) move.role = IR_ROLE_TO_MOVE_ROLE[m.role];

    out[k] = move;
    prevX = m.x;
    prevY = m.y;
    haveStart = true;
  }

  return out;
}
