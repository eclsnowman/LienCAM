import type { MoveRole } from '../../types'

// ---------------------------------------------------------------------------
// ONE shared authority for "does this move remove stock?" — used by BOTH the
// simulation pre-carve baseline and the live-playback carve, so the simulator
// speaks with a single voice. Previously the live carve used a private
// CUTTING_ROLES set while pre-carve used a looser `type !== 'rapid'` test, which
// wrongly carved the non-cutting link moves (fast_traverse, loop_back) into the
// rest-machining baseline, and — just as important — must keep the genuinely
// cutting roles (including stepover and the finish pass) carving in BOTH lanes.
//
// The table below is typed as Record<MoveRole, boolean>, so adding a role to
// the MoveRole union without classifying it here is a COMPILE ERROR
// (npm run build) — a new role cannot ship until its cutting meaning is
// declared. This mirrors the live carve authority EXACTLY.
// ---------------------------------------------------------------------------
export const STOCK_CUTTING_BY_ROLE = {
  // Cutting: the tool is engaged and removing material. Ported VERBATIM from the
  // validated Codex-branch stock-cutting policy (source 30682b8) — the reference
  // implementation whose simulation behaves correctly. Do not re-derive from any
  // looser gate.
  cut: true,
  helix: true,
  ramp: true,
  plunge: true,
  stepover: true, // a stepover advances the cutter into fresh stock — it cuts
  wall_follow: true,
  lead_in: true,
  lead_out: true,
  finish: true, // a finish pass shaves a thin wall skim — it removes material and MUST show in the sim
  // Non-cutting: rapids and repositioning that only travels already-cleared air.
  rapid: false,
  fast_traverse: false,
  loop_back: false,
} as const satisfies Record<MoveRole, boolean>

/**
 * Whether a move with the given role removes stock in the simulation.
 * FAILS LOUD on an unrecognized role string so a mis-typed / stale role can
 * never silently fall through to "not cutting" (which would hide material).
 */
export function isStockCuttingRole(role: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(STOCK_CUTTING_BY_ROLE, role)) {
    throw new Error(`isStockCuttingRole: unknown move role '${role}'`)
  }
  return STOCK_CUTTING_BY_ROLE[role as MoveRole]
}

// ---------------------------------------------------------------------------
// ONE shared authority for "how does this move TRAVEL?" — a separate question
// from whether it removes stock, and the second half of what a MoveRole means.
// Declared here, beside STOCK_CUTTING_BY_ROLE, because the two tables constrain
// each other (see the coherence check below) and because a consumer that counts
// links, rides, retracts or repositions must not answer this for itself: a
// private motion table is how a report ends up defending a link advantage the
// application never claimed. WO-1217 moved this out of the benchmark harness.
//
//   - 'pass': the tool driving along a programmed pass.
//   - 'link': FEED-RATE motion carrying the tool from one pass to the next. A
//     rapid count cannot see it. 'stepover' is a link AND it cuts; both are
//     true and both must stay countable.
//   - 'air': traverse-rate motion through cleared space.
//
// Typed as Record<MoveRole, MoveMotion>, so adding a role to the MoveRole union
// without classifying it here is a COMPILE ERROR — exactly as the cutting table
// above behaves.
// ---------------------------------------------------------------------------
export type MoveMotion = 'pass' | 'link' | 'air'

export const MOVE_MOTION_BY_ROLE = {
  cut: 'pass',
  finish: 'pass',
  wall_follow: 'pass',
  lead_in: 'pass',
  lead_out: 'pass',
  helix: 'pass',
  ramp: 'pass',
  plunge: 'pass',
  // A stepover carries the cutter sideways into the next pass. It is a
  // feed-rate link a rapid count cannot see, and it removes stock on the way.
  stepover: 'link',
  loop_back: 'link',
  rapid: 'air',
  fast_traverse: 'air',
} as const satisfies Record<MoveRole, MoveMotion>

// The two tables have to agree where they overlap: traverse motion never cuts,
// and a programmed pass always does. Only the 'link' class is allowed to be
// either. Checked once, at load, for every consumer — so the pair cannot
// silently drift apart as roles are added.
for (const [role, motion] of Object.entries(MOVE_MOTION_BY_ROLE) as [MoveRole, MoveMotion][]) {
  const cuts = STOCK_CUTTING_BY_ROLE[role]
  if (motion === 'air' && cuts) {
    throw new Error(`MOVE_MOTION_BY_ROLE: role '${role}' is traverse motion but STOCK_CUTTING_BY_ROLE says it cuts.`)
  }
  if (motion === 'pass' && !cuts) {
    throw new Error(`MOVE_MOTION_BY_ROLE: role '${role}' is a programmed pass but STOCK_CUTTING_BY_ROLE says it does not cut.`)
  }
}

/**
 * How a move with the given role travels. FAILS LOUD on an unrecognized role
 * string for the same reason isStockCuttingRole does: a stale role must never
 * fall through to a default that hides motion.
 */
export function moveMotionForRole(role: string): MoveMotion {
  if (!Object.prototype.hasOwnProperty.call(MOVE_MOTION_BY_ROLE, role)) {
    throw new Error(`moveMotionForRole: unknown move role '${role}'`)
  }
  return MOVE_MOTION_BY_ROLE[role as MoveRole]
}

/** How a raw toolpath move travels, defaulting its role exactly as carve does. */
export function effectiveMoveMotion(m: { type: string; role?: string }): MoveMotion {
  return moveMotionForRole(effectiveMoveRole(m))
}

/**
 * Resolve the EFFECTIVE role of a raw toolpath move for carve decisions,
 * defaulting exactly as live playback does: an untyped rapid is 'rapid', any
 * other untyped move is 'cut'. Keeping this in one place means pre-carve and
 * live-carve default identically and cannot drift apart.
 */
export function effectiveMoveRole(m: { type: string; role?: string }): MoveRole {
  if (m.role) return m.role as MoveRole
  return m.type === 'rapid' ? 'rapid' : 'cut'
}
