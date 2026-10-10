// ============================================================
// Synthetic all-roles post fixture (C-P1c)
// ============================================================
// A hand-built PostInput that exercises EVERY MoveRole and BOTH linear
// ToolpathMove types ('rapid' and 'feed') across TWO operations with DIFFERENT
// tools (so a tool change is emitted). NO arc moves — this is the linear phase;
// C-P2 reuses this exact fixture with arcs enabled, so it is cleanly exported.
//
// Coordinate discipline:
//   - All move coordinates are WORLD coordinates (the post transforms
//     world -> work at emission time).
//   - The WCS origin is deliberately non-trivial ({x:100,y:50,z:25}) so the
//     world->work subtraction is visibly exercised in the output.
//
// Role discipline (matches docs/ARCHITECTURE move vocabulary):
//   - type:'rapid'  -> ONLY repositioning ABOVE the stock (role 'rapid').
//   - type:'feed'   -> every cutting / linking role, INCLUDING 'fast_traverse'
//     (a keep-down reposition through cleared stock, fed at traverse rate).
//
// Op 1 (pocket-like, tool #1) covers: rapid, plunge, ramp, helix, cut,
//   stepover, fast_traverse, wall_follow, loop_back.
// Op 2 (contour-like, tool #2) covers: rapid, lead_in, cut, finish, lead_out.
// Together the twelve MoveRole values are all present at least once.

import type { Operation, ToolpathMove, Tool } from '../../../types'
import { resolveFeedrates } from '../../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../../lib/post/resolve'
import type { PostInput, PostOperation } from '../../../lib/post/types'
import { makeTool, makeMachine, makeOp, makeWcs } from '../helpers'

// Feedrates by role (mm/min) — distinct so they read in the F-word stream.
const F_CUT = 2000
const F_PLUNGE = 400
const F_RAMP = 600
const F_HELIX = 500
const F_STEPOVER = 1500
const F_TRAVERSE = 3500
const F_LEAD = 1800
const F_FINISH = 1200
const F_WALL = 1600
const F_LOOPBACK = 1700

function m(
  type: ToolpathMove['type'],
  x: number,
  y: number,
  z: number,
  role: ToolpathMove['role'],
  feed?: number,
): ToolpathMove {
  const mv: ToolpathMove = { type, x, y, z, role }
  if (feed !== undefined) mv.feed = feed
  return mv
}

// --- Densification helpers ---------------------------------------------------
// Real toolpaths are DENSE polylines, not corner-only sketches: a straight edge
// carries many COLLINEAR sample points (which fitCircle rejects -> they collapse
// back to a single LINE), and a true curve carries many points ON a circle
// (which fit an ARC). The arc-collapse contract is exercised honestly only when
// the fixture is sampled this way (the old corner-only box was concyclic and
// produced a SPURIOUS arc). These helpers build that representative density.

/**
 * Sample a straight segment A->B into `segments` equal pieces, emitting the
 * INTERMEDIATE + END points as 'feed' moves with a fixed role+feed (z constant).
 * The start point A is assumed already present as the previous move's endpoint,
 * so it is NOT emitted. All emitted points are exactly collinear, so under
 * arcs-ON the whole edge collapses to one clean G1 line (fitCircle -> null on
 * collinear points; never an arc).
 */
function densifyEdge(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  z: number,
  role: ToolpathMove['role'],
  feed: number,
  segments = 8,
): ToolpathMove[] {
  const out: ToolpathMove[] = []
  for (let k = 1; k <= segments; k++) {
    const t = k / segments
    out.push(m('feed', ax + (bx - ax) * t, ay + (by - ay) * t, z, role, feed))
  }
  return out
}

// --- Curved feature constants (the arc-collapse TARGET) ----------------------
// A densely-sampled circular ARC in the pocket region. We sweep 270deg (NOT a
// full closed circle): a closed loop whose first point equals its last is a
// degenerate input for the DP/circle-fit (zero-length first->last chord), which
// collapses to a single half-arc. A 270deg open arc has distinct endpoints, so
// it collapses cleanly to TWO <=180deg arcs (the 180-cap forces the split) under
// arcs-ON, while staying a dense G1 polyline under arcs-OFF. Exported so the
// arcs-ON test can assert against the exact geometry it expects collapsed.
export const ARC_CIRCLE_CENTER = { x: 129, y: 77 } // world coords (in pocket)
export const ARC_CIRCLE_RADIUS = 10 // mm
export const ARC_CIRCLE_Z = 22 - 0.5 // same plane as the pocket cut ring
export const ARC_CIRCLE_SWEEP_DEG = 270 // open arc, NOT a full circle
export const ARC_CIRCLE_SAMPLES = 54 // points across the 270deg sweep

/**
 * Sample a 270deg circular arc (CCW) as MANY 'cut' feed moves on a constant z
 * plane. Starts at angle 0 (the +X point) and sweeps CCW to 270deg, so the run
 * has DISTINCT endpoints. The caller positions the tool at the start point
 * (angle 0) before this run.
 */
function circleMoves(): ToolpathMove[] {
  const { x: cx, y: cy } = ARC_CIRCLE_CENTER
  const r = ARC_CIRCLE_RADIUS
  const sweep = (ARC_CIRCLE_SWEEP_DEG * Math.PI) / 180
  const out: ToolpathMove[] = []
  // k from 1..SAMPLES: the start point (k=0, angle 0) is the prior position.
  for (let k = 1; k <= ARC_CIRCLE_SAMPLES; k++) {
    const a = (sweep * k) / ARC_CIRCLE_SAMPLES
    out.push(
      m('feed', cx + r * Math.cos(a), cy + r * Math.sin(a), ARC_CIRCLE_Z, 'cut', F_CUT),
    )
  }
  return out
}

// --- Op 1: a square pocket cleared with a ramp entry + a couple of rings ------
// Stock top sits at world Z=25 (matching the WCS origin Z); we cut down to ~22.
function pocketMoves(): ToolpathMove[] {
  const top = 27 // a little above the work zero plane (work Z = +2)
  const cut = 22 // pocket floor (work Z = -3)
  const cz = cut - 0.5 // the cut/ring plane (constant Z for XY collapse)
  return [
    // Rapid above the start corner (above stock).
    m('rapid', 110, 60, 30, 'rapid'),
    // Plunge to feed height, then ramp down into the corner.
    m('feed', 110, 60, top, 'plunge', F_PLUNGE),
    m('feed', 118, 60, cut, 'ramp', F_RAMP),
    // A short helical-style descent step (kept linear in this phase).
    m('feed', 118, 64, cz, 'helix', F_HELIX),
    // Outer ring of the pocket (cut role) — DENSIFIED straight edges. Each edge
    // is many collinear 'cut' feed points sharing role+feed, so under arcs-ON it
    // collapses back to ONE G1 line (collinear -> fitCircle null -> never arc).
    // Corner coordinates, roles, and feeds are UNCHANGED from the corner-only
    // version (start corner 118,64 carried from the helix endpoint above).
    ...densifyEdge(118, 64, 140, 64, cz, 'cut', F_CUT),
    ...densifyEdge(140, 64, 140, 90, cz, 'cut', F_CUT),
    ...densifyEdge(140, 90, 118, 90, cz, 'cut', F_CUT),
    ...densifyEdge(118, 90, 118, 66, cz, 'cut', F_CUT),
    // Stepover inward to the next ring.
    m('feed', 122, 68, cz, 'stepover', F_STEPOVER),
    // Keep-down reposition through cleared stock at traverse rate (type:'feed').
    m('feed', 124, 68, cz, 'fast_traverse', F_TRAVERSE),
    // Inner ring (cut) — densified straight edges (start corner 124,68 carried
    // from the fast_traverse endpoint above), then a wall-follow skim.
    ...densifyEdge(124, 68, 136, 70, cz, 'cut', F_CUT),
    ...densifyEdge(136, 70, 136, 86, cz, 'cut', F_CUT),
    m('feed', 124, 86, cz, 'wall_follow', F_WALL),
    // Loop back to rejoin the start of the inner ring.
    m('feed', 124, 70, cz, 'loop_back', F_LOOPBACK),
    // Retract above stock (rapid) before relocating to the curved feature.
    m('rapid', 124, 70, 30, 'rapid'),

    // --- Arc-collapse TARGET: a densely-sampled circular pocket -------------
    // Rapid over the circle start (angle 0 -> +X point), plunge, then run the
    // dense circle as contiguous 'cut' feed moves. A rapid before/after keeps
    // this run isolated from the box 'cut' edges so the collapser sees one clean
    // circular run. Under arcs-ON this becomes a few G2/G3 arcs (each <=180deg).
    m('rapid', ARC_CIRCLE_CENTER.x + ARC_CIRCLE_RADIUS, ARC_CIRCLE_CENTER.y, 30, 'rapid'),
    m('feed', ARC_CIRCLE_CENTER.x + ARC_CIRCLE_RADIUS, ARC_CIRCLE_CENTER.y, top, 'plunge', F_PLUNGE),
    m('feed', ARC_CIRCLE_CENTER.x + ARC_CIRCLE_RADIUS, ARC_CIRCLE_CENTER.y, ARC_CIRCLE_Z, 'plunge', F_PLUNGE),
    ...circleMoves(),
    // Retract above stock (rapid).
    m('rapid', ARC_CIRCLE_CENTER.x + ARC_CIRCLE_RADIUS, ARC_CIRCLE_CENTER.y, 30, 'rapid'),
  ]
}

// --- Op 2: a profile contour around the pocket with lead-in/out + finish ------
function contourMoves(): ToolpathMove[] {
  const top = 27
  const cut = 21 // profile goes a touch deeper than the pocket floor
  return [
    // Rapid to the lead-in start (above stock).
    m('rapid', 105, 55, 30, 'rapid'),
    m('feed', 105, 55, top, 'plunge', F_PLUNGE),
    // Tangential lead-in onto the contour.
    m('feed', 108, 58, cut, 'lead_in', F_LEAD),
    // The contour itself (cut) — DENSIFIED closed rectangle around the pocket.
    // Same corners/role/feed; collinear density -> each edge collapses to a G1.
    ...densifyEdge(108, 58, 145, 58, cut, 'cut', F_CUT),
    ...densifyEdge(145, 58, 145, 95, cut, 'cut', F_CUT),
    ...densifyEdge(145, 95, 108, 95, cut, 'cut', F_CUT),
    ...densifyEdge(108, 95, 108, 58, cut, 'cut', F_CUT),
    // A dedicated finishing pass skimming the wall — DENSIFIED likewise.
    ...densifyEdge(108, 58, 145, 58, cut, 'finish', F_FINISH),
    ...densifyEdge(145, 58, 145, 95, cut, 'finish', F_FINISH),
    ...densifyEdge(145, 95, 108, 95, cut, 'finish', F_FINISH),
    ...densifyEdge(108, 95, 108, 58, cut, 'finish', F_FINISH),
    // Tangential lead-out off the contour, then rapid clear.
    m('feed', 105, 55, cut, 'lead_out', F_LEAD),
    m('rapid', 105, 55, 30, 'rapid'),
  ]
}

/** Assemble a PostOperation: resolve feeds/spindle/coolant just like the real
 *  buildPostInput path, but from hand-built moves. */
function makePostOp(op: Operation, tool: Tool): PostOperation {
  const machine = makeMachine()
  return {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves: op.toolpathMoves ?? [],
  }
}

/** Build the synthetic all-roles PostInput. Deterministic and pure. */
export function buildSyntheticInput(): PostInput {
  const machine = makeMachine({ coolant: true })

  const tool1 = makeTool({ id: 'tool-a', name: 'Pocket EM 6mm', toolNumber: 1 })
  const tool2 = makeTool({
    id: 'tool-b',
    name: 'Finish EM 3mm',
    toolNumber: 2,
    diameter: 3,
  })

  // NOTE: op names must NOT contain parentheses — they become comment text and
  // nested parens are invalid g-code on most controllers (the linter flags it).
  const op1 = makeOp({
    id: 'op-pocket',
    name: 'Pocket rough',
    type: 'pocket_2d',
    toolId: 'tool-a',
    toolpathMoves: pocketMoves(),
  })

  const op2 = makeOp({
    id: 'op-contour',
    name: 'Contour finish',
    type: 'contour_2d',
    toolId: 'tool-b',
    toolpathMoves: contourMoves(),
  })

  // Non-trivial WCS origin so the world->work transform is visibly exercised.
  const wcs = makeWcs({ origin: { x: 100, y: 50, z: 25 } })

  return {
    machine,
    setup: {
      wcs,
      operations: [makePostOp(op1, tool1), makePostOp(op2, tool2)],
    },
  }
}
