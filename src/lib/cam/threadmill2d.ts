// Thread-milling toolpath builder (v1). See ADR-0031 (thread_mill operation
// contract).
//
// v1 SCOPE: INTERNAL + EXTERNAL threads, single-point cutter model (one tool
// revolution per pitch), top-to-bottom OR bottom-to-top helix (the operator's
// axialDirection, WO-3193; derived when unset), radial
// roughing + spring passes, tangent (or none) lead-in/out, computer
// compensation only. internal/external is a MECHANICAL MIRROR: it changes the
// orbit RADIUS only (internal subtracts the tool radius, external adds it). With
// a chosen axialDirection the orbit SENSE is direction x hand; unset, it is set by
// climb/conventional x kind x spindle (threadOrbitSense) and the hand couples it
// to the axial travel direction (threadTravelUp) -- see resolveThreadMotion and
// ADR-0031 sec 5.
//
// INTERNAL -- PRE-DRILLED HOLE ASSUMPTION: the hole has already been
// bored/drilled below bottomZ and is LARGER than the tool, by a SEPARATE drill
// operation that is the user's responsibility. This builder does NOT inspect
// hole depth -- it plunges straight down the open, pre-cleared hole to bottomZ
// and orbits up. The selected loops are the pre-cleared hole loops (drill-style
// centroid selection); their XY bounding box only constrains the conservative
// hole-diameter fit check.
//
// EXTERNAL -- BOSS ASSUMPTION: the selected loop is the boss OUTER profile and
// the boss is SOLID at its center. There is no pre-drilled hole, so the cutter
// must NEVER pass through or plunge at the boss center. The tool plunges in AIR
// beside the boss (at the orbit start point, outside the boss) and orbits up.
//
// Fail-loud per ADR-0003: orphaned selections, out-of-scope params, and
// degraded geometry throw with a 'Thread mill:' prefix rather than silently
// emitting nothing.

import type { ThreadMillWorkerPayload } from './types'
import type { ToolpathMove } from '../../types'
import { resolveHeights } from './heights'
import { entryMaterialOf, entryStartZ, hopTo, liftTo } from './moves'
import { resolveFeedrates } from './feedrates'
import { fitCircle } from './geometry'
// WO-3168: constant-radius cutting passes share Bore's native helical arcs.
// Lead geometry, pass scheduling and dense/adaptive entry generators stay independent.
import { generateHelixArcs, generateLeadArc, resolveThreadMotion, threadEdgeFeed } from './threadHelix'
import { spindleSignForTool } from '../tool/cutHand'

export function buildThreadMillToolpath(
  payload: ThreadMillWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
): ToolpathMove[] {
  const { params, heights, tool, loops, wcsOrigin, feedrateOverride } = payload

  const { clearanceZ, retractZ, feedZ, topZ, bottomZ } = resolveHeights(heights, wcsOrigin)
  const { feedRate, plungeRate, leadInRate, leadOutRate } = resolveFeedrates(tool, feedrateOverride)

  // Pitch resolution: tpi (when > 0) wins, else the explicit pitch.
  const pitch = (params.tpi && params.tpi > 0) ? 25.4 / params.tpi : params.pitch

  // ── Fail-loud guards (ADR-0003) ───────────────────────────────────────────
  if (!(pitch > 0)) {
    throw new Error('Thread mill: pitch must be > 0 (set pitch, or tpi).')
  }
  if (!(params.majorDiameter > 0)) {
    throw new Error('Thread mill: majorDiameter must be > 0.')
  }
  if (topZ <= bottomZ) {
    throw new Error('Thread mill: thread top must be above thread bottom (check top/bottom heights).')
  }
  if (params.roughingPasses < 1) {
    throw new Error('Thread mill: roughingPasses must be >= 1.')
  }
  if (params.springPasses < 0) {
    throw new Error('Thread mill: springPasses must be >= 0.')
  }
  if ((params.compensation as string) !== 'computer') {
    throw new Error('Thread mill: only computer compensation is implemented in v1.')
  }

  // ── Selection (drill-style orphan fail-loud) ──────────────────────────────
  // Filter to selected ids, THEN require closed: an open loop (e.g. a
  // partial-ellipse region baked as two disconnected open loops, SKC-47-R2) has
  // no well-defined hole/boss profile to orbit — mirrors drill2d.ts's fix (ADR 0003).
  const matchedLoops = params.loopIds.length === 0
    ? loops
    : loops.filter(l => params.loopIds.includes(l.id))
  const selectedLoops = matchedLoops.filter(l => l.closed)

  if (selectedLoops.length === 0) {
    if (params.loopIds.length > 0 && matchedLoops.some(l => !l.closed)) {
      throw new Error(
        'Thread mill: the selected hole(s) are open loops (no closed boundary) - a partial ' +
        'curve or unclosed sketch region cannot define a hole/boss profile. Re-select closed ' +
        'hole loops in the Geometry tab.'
      )
    }
    if (params.loopIds.length > 0 && loops.length > 0) {
      throw new Error(
        'Thread mill: the selected hole(s) no longer exist - the geometry was re-derived ' +
        '(re-import / sketch edit / projection-tolerance change regenerates loop ids). ' +
        'Open the operation, re-select the holes in the Geometry tab, and recompute.'
      )
    }
    throw new Error('Thread mill: no hole loop found. Select pre-cleared hole loops in the Geometry tab.')
  }

  // ── Per-hole prep ─────────────────────────────────────────────────────────
  // Conservative hole diameter = MIN of the loop XY bounding-box width/height
  // (the binding fit constraint). The circle fit's center is the orbit center
  // (WO-1512: not centroid() - a vertex mean is biased by sample density,
  // not the loop's actual geometric center). No roundness refusal: the thread
  // orbit is a circle about that center whatever the loop's shape, so the
  // software can always cut it (LIENCAM rule 11). fitCircle returns a finite
  // center for any loop with points, degenerate ones included.
  const records = selectedLoops.map(l => {
    const fit = fitCircle(l.points)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of l.points) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const holeDia = Math.min(maxX - minX, maxY - minY)
    return { x: fit.center.x, y: fit.center.y, loopId: l.id, holeDia }
  })
  // Deterministic order: by x then y.
  records.sort((a, b) => (a.x - b.x) || (a.y - b.y))

  // ── Radii ─────────────────────────────────────────────────────────────────
  const toolCutDia = tool.diameter
  const toolR = toolCutDia / 2
  // MECHANICAL MIRROR: internal orbits INSIDE the major circle (subtract toolR);
  // external orbits OUTSIDE the boss but must reach the thread ROOT, not stop at
  // the crest. The 60deg thread-depth approximation extSpan = 0.6*pitch (the SAME
  // value the external holeSchedules branch uses as `span`) sets root vs crest:
  //   crest orbit radius = majorDiameter/2 + toolR  (tool inner edge at boss OD)
  //   root  orbit radius = majorDiameter/2 + toolR - extSpan  (R_final)
  // With this R_final, holeSchedules' R_start = R_final + span lands at the crest
  // and the passes step inward crest->root (so do NOT change holeSchedules).
  const extSpan = 0.6 * pitch
  const R_final = params.threadKind === 'internal'
    ? params.majorDiameter / 2 - toolR
    : params.majorDiameter / 2 + toolR - extSpan
  if (!(R_final > 0)) {
    throw new Error('Thread mill: computed orbit radius <= 0 - the tool is too large for this major diameter.')
  }

  // SAFETY (ADR-0003): the tool must physically fit the pre-cleared hole before
  // it can plunge straight down and orbit. holeDia is the conservative min-bbox
  // diameter of each selected hole loop (the binding fit constraint). This is a
  // DISTINCT check from the R_final guard above: a tool can satisfy the
  // major-diameter math yet still be wider than the actual drilled hole.
  //
  // INTERNAL-ONLY: both checks are meaningless for external -- there is no
  // pre-drilled hole; the selected loop is the boss OUTER profile, so holeDia is
  // the boss OD (the cutter orbits AROUND it, it never enters a hole).
  if (params.threadKind === 'internal') {
    for (const h of records) {
      if (toolCutDia >= h.holeDia) {
        throw new Error(
          `Thread mill: the tool cutting diameter (${toolCutDia}mm) does not fit the ` +
          `pre-cleared hole (~${h.holeDia.toFixed(3)}mm diameter) for the selected loop. ` +
          `Use a smaller thread mill, or select the correct (larger, pre-drilled) hole.`
        )
      }
      // FAIL-LOUD (ADR-0003): the pre-drilled hole must be SMALLER than the thread
      // major diameter -- otherwise the radial span is <= 0 (nothing to cut, or the
      // wrong/oversized hole was picked). No silent fallback.
      if (!(params.majorDiameter > h.holeDia)) {
        throw new Error(
          `Thread mill: the pre-cleared hole (~${h.holeDia.toFixed(3)}mm diameter) is already ` +
          `at or larger than the thread major diameter (${params.majorDiameter}mm) - there is no ` +
          `material to thread. Select the correct (smaller) pre-drilled hole, or check the major diameter.`
        )
      }
    }
  }

  // Radial infeed schedule, derived PER HOLE from REAL geometry: the roughing
  // span runs from the tool just touching the pre-drilled hole wall
  // (R_start = holeDia/2 - toolR) out to the thread radius
  // (R_final = majorDiameter/2 - toolR), so spanReal = (majorDiameter - holeDia)/2.
  // When a radialStepover (max radial bite per pass) is given it drives the
  // count, with bites distributed EVENLY so each is <= the stepover (mirrors the
  // axial-stepdown convention). Falls back to the legacy explicit roughingPasses
  // count when no stepover is set. springPasses are appended at R_final.
  const stepover = params.radialStepover
  const holeSchedules = records.map(h => {
    let span: number
    let R_start: number
    let stepSign: 1 | -1
    if (params.threadKind === 'internal') {
      // INTERNAL: REAL geometry span = (majorDiameter - holeDia)/2, approach
      // R_final from the INSIDE (R_start = R_final - span), stepping OUTWARD.
      span = (params.majorDiameter - h.holeDia) / 2  // > 0, guarded above
      R_start = R_final - span
      stepSign = 1
    } else {
      // EXTERNAL: there is no pre-drilled hole to derive a real span from, so v1
      // uses the thread-height APPROXIMATION span = 0.6*pitch and approaches
      // R_final from the OUTSIDE (R_start = R_final + span), stepping INWARD so
      // each successive roughing radius DECREASES to R_final (mirror of internal).
      // FUTURE WORK: derive the real external span from a boss/root diameter;
      // 0.6*pitch is the v1 approximation only.
      span = 0.6 * pitch
      R_start = R_final + span
      stepSign = -1
    }
    const nRough = (stepover != null && stepover > 0)
      ? Math.max(1, Math.ceil(span / stepover))
      : Math.max(1, params.roughingPasses)
    const roughingRadii: number[] = []
    if (nRough === 1) {
      roughingRadii.push(R_final)
    } else {
      // Even bites ending exactly at R_final; the first pass starts one bite in
      // from R_start (no zero-engagement pass at R_start).
      for (let i = 0; i < nRough; i++) {
        roughingRadii.push(R_start + stepSign * ((i + 1) / nRough) * span)
      }
    }
    return [...roughingRadii, ...Array(params.springPasses).fill(R_final)]
  })

  // ── Orbit sense + axial travel + lead mode ────────────────────────────────
  // WO-3193: the operator's axialDirection, when set, is followed by every pass
  // and the orbit sense follows direction x hand x spindle (climb/conventional is
  // what results). Unset (ops saved before WO-3193) derives it as before: orbit
  // sense from climb/conventional x kind x spindle like 2D contouring, then hand
  // couples it to the axial travel direction along the fixed groove.
  const spindleSign = spindleSignForTool(tool)
  const { orbitSense: dir, travelUp } = resolveThreadMotion(params, spindleSign)  // dir +1 CCW
  const useArc = params.leadInOut === 'arc'
  const phi0 = 0  // helix + leads all reference orbit angle 0 at the start.

  const moves: ToolpathMove[] = []
  // WO-3083: every pass comes down to ENTRY_CLEARANCE_MM above the material under the tool (was
  // the Feed plane, Top + 5) - the first through Clearance, the rest hopping at Retract - and
  // leaves straight up to Retract; the operation's final exit is to Clearance.
  const material = entryMaterialOf(payload, topZ, feedZ)
  const enter = (x: number, y: number, floorZ: number) => {
    hopTo(moves, { x, y }, entryStartZ(material, { x, y }, toolR, floorZ), retractZ, clearanceZ)
  }
  const totalPasses = holeSchedules.reduce((sum, s) => sum + s.length, 0)
  let passesDone = 0

  for (let hi = 0; hi < records.length; hi++) {
    const h = records[hi]
    const passRadii = holeSchedules[hi]
    for (let pi = 0; pi < passRadii.length; pi++) {
      const R = passRadii[pi]
      // WO-3194: the cutting helix is fed so the EDGE (not the centre) runs at the
      // set feed; leads, plunge and exit keep their own rates. The helix's first move
      // (to the start point, constant Z) completes the arc lead-in, which stops just
      // short of it, so it keeps the uncompensated feed it always had (entryFeed).
      const helixFeed = threadEdgeFeed(feedRate, R, toolR, params.threadKind)

      if (params.threadKind === 'internal') {
        if (travelUp) {
        // ── INTERNAL: plunge straight down the open hole, thread up to the
        // thread top, lead out to the centre and retract up the open hole.
        // Per-pass ENTRY down the open, pre-cleared hole.
        enter(h.x, h.y, bottomZ)
        moves.push({ type: 'feed', x: h.x, y: h.y, z: bottomZ, feed: plungeRate, role: 'plunge' })

        // LEAD-IN at bottomZ.
        if (useArc) {
          moves.push(...generateLeadArc({
            cx: h.x, cy: h.y, radius: R, angle: phi0, dir,
            z: bottomZ, feed: leadInRate, kindRole: 'lead_in',
          }))
        } else {
          // Straight feed from center to Q = (h.x + R, h.y) at bottomZ.
          moves.push({ type: 'feed', x: h.x + R, y: h.y, z: bottomZ, feed: leadInRate, role: 'lead_in' })
        }

        // HELIX (the thread): climb bottom-to-top, exactly one pitch per rev.
        moves.push(...generateHelixArcs({
          cx: h.x, cy: h.y, radius: R, pitch, bottomZ, topZ, dir,
          feed: helixFeed, entryFeed: feedRate, startAngle: phi0, role: 'helix',
        }))

        // The helix ENDS at the thread top (WO-3080, ADR-0031 Amendment 10: the
        // A2.1 exit climb to the feed plane cut ~5 air turns per hole). Lead out
        // at topZ back to the open hole centre, then rapid straight up it - the
        // same exit as the internal descending branch below.
        const exitZ = topZ
        const endAng = phi0 + dir * ((topZ - bottomZ) / pitch) * 2 * Math.PI

        // LEAD-OUT at the thread top.
        if (useArc) {
          // FLIP dir for the internal lead-out (real hole-center arc): the smooth
          // return to center is the OTHER half-circle from the lead-in one.
          // generateLeadArc reverses point order for 'lead_out', so the
          // tangent-continuous E->O exit needs the flipped sense (the same flip
          // idiom the external lead-IN uses); with the real dir the arc leaves E
          // in the -orbit direction and cusps (~172deg) at the helix join.
          moves.push(...generateLeadArc({
            cx: h.x, cy: h.y, radius: R, angle: endAng, dir: (dir === 1 ? -1 : 1),
            z: exitZ, feed: leadOutRate, kindRole: 'lead_out',
          }))
        } else {
          // Straight feed from E (helix end) to center at the thread top. Single
          // move; E is already at the cutter from the helix, so we only emit the
          // destination.
          moves.push({ type: 'feed', x: h.x, y: h.y, z: exitZ, feed: leadOutRate, role: 'lead_out' })
        }

        // Per-pass EXIT: retract straight up the open hole centre.
        liftTo(moves, retractZ)
        } else {
          // ── INTERNAL DESCENDING (travelUp false): the tool enters from the
          // TOP through the open hole, threads DOWN to the bottom, then exits
          // straight up the open center. Mirror of internal ascending.
          // WO-3083: down to just above the material, plunge to the thread top and start the
          // thread there (the air "entry climb" orbit from the Feed plane is gone).
          enter(h.x, h.y, topZ)
          moves.push({ type: 'feed', x: h.x, y: h.y, z: topZ, feed: plungeRate, role: 'plunge' })
          // LEAD-IN at the thread top.
          if (useArc) {
            moves.push(...generateLeadArc({
              cx: h.x, cy: h.y, radius: R, angle: phi0, dir,
              z: topZ, feed: leadInRate, kindRole: 'lead_in',
            }))
          } else {
            moves.push({ type: 'feed', x: h.x + R, y: h.y, z: topZ, feed: leadInRate, role: 'lead_in' })
          }
          const mainStartAngle = phi0
          // MAIN helix topZ -> bottomZ descending.
          moves.push(...generateHelixArcs({
            cx: h.x, cy: h.y, radius: R, pitch, bottomZ, topZ, dir,
            descend: true, feed: helixFeed, entryFeed: feedRate, startAngle: mainStartAngle, role: 'helix',
          }))

          // LEAD-OUT at bottomZ.
          const endAng = mainStartAngle + dir * ((topZ - bottomZ) / pitch) * 2 * Math.PI
          if (useArc) {
            // FLIP dir (same reasoning as the internal ascending lead-out): the
            // tangent-continuous return to center is the opposite half-circle.
            moves.push(...generateLeadArc({
              cx: h.x, cy: h.y, radius: R, angle: endAng, dir: (dir === 1 ? -1 : 1),
              z: bottomZ, feed: leadOutRate, kindRole: 'lead_out',
            }))
          } else {
            // Straight feed from E (helix end) to center at bottomZ; emit only the
            // destination (E is already at the cutter from the helix).
            moves.push({ type: 'feed', x: h.x, y: h.y, z: bottomZ, feed: leadOutRate, role: 'lead_out' })
          }

          // Per-pass EXIT: retract straight up the open hole.
          liftTo(moves, retractZ)
        }
      } else {
        if (travelUp) {
        // ── EXTERNAL (mechanical mirror): the boss is SOLID at center, so the
        // cutter NEVER touches the center. It plunges in AIR beside the boss at
        // the orbit start point Q = (h.x + R, h.y) (outside the boss), threads up,
        // and leads OUT away from the boss. No exit climb -- the tool is already
        // radially clear of the boss, so it retracts straight up after lead-out.
        const cosP = Math.cos(phi0), sinP = Math.sin(phi0)
        const qx = h.x + R * cosP, qy = h.y + R * sinP            // orbit start Q

        // Helix end angle/point E (one pitch per rev, bottom->top).
        const endAng = phi0 + dir * ((topZ - bottomZ) / pitch) * 2 * Math.PI
        const cosE = Math.cos(endAng), sinE = Math.sin(endAng)

        if (useArc) {
          // Tangent lead-in arc that curves on the OUTSIDE of the boss. Reuse
          // generateLeadArc with a VIRTUAL orbit center O_v = O + 2R*u placed
          // OUTSIDE Q and the angle/dir flipped, so the arc runs from O_v inward
          // to Q while staying tangent to the real orbit at Q. Every arc point is
          // at radius [R, 2R] from the boss center -- it never dips toward center.
          const ovx = h.x + 2 * R * cosP, ovy = h.y + 2 * R * sinP
          // ENTRY: plunge in AIR at the arc start O_v (outside the boss).
          enter(ovx, ovy, bottomZ)
          moves.push({ type: 'feed', x: ovx, y: ovy, z: bottomZ, feed: plungeRate, role: 'plunge' })
          moves.push(...generateLeadArc({
            cx: ovx, cy: ovy, radius: R, angle: phi0 + Math.PI, dir: (dir === 1 ? -1 : 1),
            z: bottomZ, feed: leadInRate, kindRole: 'lead_in',
          }))
        } else {
          // ENTRY (straight lead): the pass orbit radius R reaches the thread ROOT,
          // so plunging straight down at Q would gouge the SOLID boss on deep
          // passes. Plunge instead at the SAFE crest orbit radius Psafe
          // (majorDiameter/2 + toolR; the tool inner edge there is tangent to the
          // boss OD = grazing in air), then feed radially in to Q at bottomZ before
          // the helix. (The arc branch is already safe -- it plunges at O_v.)
          const rSafe = params.majorDiameter / 2 + toolR
          const psx = h.x + rSafe * cosP, psy = h.y + rSafe * sinP
          enter(psx, psy, bottomZ)
          moves.push({ type: 'feed', x: psx, y: psy, z: bottomZ, feed: plungeRate, role: 'plunge' })
          moves.push({ type: 'feed', x: qx, y: qy, z: bottomZ, feed: leadInRate, role: 'lead_in' })
        }

        // HELIX (the thread): climb bottom-to-top, exactly one pitch per rev.
        moves.push(...generateHelixArcs({
          cx: h.x, cy: h.y, radius: R, pitch, bottomZ, topZ, dir,
          feed: helixFeed, entryFeed: feedRate, startAngle: phi0, role: 'helix',
        }))

        // NO EXIT CLIMB for external: the tool is already radially clear of the
        // boss, so the lead-out happens at the thread top (topZ).
        if (useArc) {
          // Tangent lead-out arc that curves OUTWARD/away from the boss (same
          // virtual-outside-center trick, mirrored about E). Ends at O_v_end,
          // outside the boss; never returns toward center.
          const ovex = h.x + 2 * R * cosE, ovey = h.y + 2 * R * sinE
          // Use the REAL dir here (NOT the flipped one the lead-in uses):
          // generateLeadArc already reverses the point order for 'lead_out', so
          // flipping dir on top of that would double-reverse and cusp (~169deg)
          // at the helix-top -> lead-out join. The lead-in keeps the flip because
          // it emits front-to-back without that reversal.
          moves.push(...generateLeadArc({
            cx: ovex, cy: ovey, radius: R, angle: endAng + Math.PI, dir: dir,
            z: topZ, feed: leadOutRate, kindRole: 'lead_out',
          }))
        } else {
          // Straight short radial feed OUTWARD from E to radius R + toolR (away
          // from the boss, NEVER toward center). E is already at the cutter.
          const rOut = R + toolR
          moves.push({ type: 'feed', x: h.x + rOut * cosE, y: h.y + rOut * sinE, z: topZ, feed: leadOutRate, role: 'lead_out' })
        }

        // Per-pass EXIT: retract straight up from the (outside) lead-out end.
        liftTo(moves, retractZ)
        } else {
          // ── EXTERNAL DESCENDING (travelUp false): plunge in AIR beside the
          // boss down to the TOP, thread DOWN, then lead out at the base. Mirror
          // of external ascending (same Q / O_v outside geometry), but the plunge
          // lands at topZ and the lead-out happens at bottomZ. No top/bottom
          // air-climb in this task (that is a separate task) -- mirrors today's
          // external which has no air-climb.
          const cosP = Math.cos(phi0), sinP = Math.sin(phi0)
          const qx = h.x + R * cosP, qy = h.y + R * sinP            // orbit start Q

          // Helix end angle/point E (one pitch per rev, top->bottom).
          const endAng = phi0 + dir * ((topZ - bottomZ) / pitch) * 2 * Math.PI
          const cosE = Math.cos(endAng), sinE = Math.sin(endAng)

          if (useArc) {
            // Tangent lead-in arc on the OUTSIDE of the boss (virtual-outside
            // center trick, same as ascending), but at the thread TOP.
            const ovx = h.x + 2 * R * cosP, ovy = h.y + 2 * R * sinP
            enter(ovx, ovy, topZ)
            moves.push({ type: 'feed', x: ovx, y: ovy, z: topZ, feed: plungeRate, role: 'plunge' })
            moves.push(...generateLeadArc({
              cx: ovx, cy: ovy, radius: R, angle: phi0 + Math.PI, dir: (dir === 1 ? -1 : 1),
              z: topZ, feed: leadInRate, kindRole: 'lead_in',
            }))
          } else {
            // ENTRY (straight lead): plunge at the SAFE crest orbit radius Psafe
            // (majorDiameter/2 + toolR; grazing in air at the boss OD), then feed
            // radially in to Q at the thread top -- the root-reaching pass radius R
            // can place the tool body inside the SOLID boss, so plunging at Q would
            // gouge. (The arc branch is already safe -- it plunges at O_v.)
            const rSafe = params.majorDiameter / 2 + toolR
            const psx = h.x + rSafe * cosP, psy = h.y + rSafe * sinP
            enter(psx, psy, topZ)
            moves.push({ type: 'feed', x: psx, y: psy, z: topZ, feed: plungeRate, role: 'plunge' })
            moves.push({ type: 'feed', x: qx, y: qy, z: topZ, feed: leadInRate, role: 'lead_in' })
          }

          // MAIN helix topZ -> bottomZ descending, exactly one pitch per rev.
          moves.push(...generateHelixArcs({
            cx: h.x, cy: h.y, radius: R, pitch, bottomZ, topZ, dir,
            descend: true, feed: helixFeed, entryFeed: feedRate, startAngle: phi0, role: 'helix',
          }))

          // LEAD-OUT at bottomZ (away from the boss, never toward center).
          if (useArc) {
            const ovex = h.x + 2 * R * cosE, ovey = h.y + 2 * R * sinE
            // REAL dir here (NOT flipped) -- same reasoning as the 961b202 fix:
            // generateLeadArc already reverses for 'lead_out', so flipping dir on
            // top of that would double-reverse and cusp at the helix-bottom join.
            moves.push(...generateLeadArc({
              cx: ovex, cy: ovey, radius: R, angle: endAng + Math.PI, dir: dir,
              z: bottomZ, feed: leadOutRate, kindRole: 'lead_out',
            }))
          } else {
            // Straight short radial feed OUTWARD from E to radius R + toolR.
            const rOut = R + toolR
            moves.push({ type: 'feed', x: h.x + rOut * cosE, y: h.y + rOut * sinE, z: bottomZ, feed: leadOutRate, role: 'lead_out' })
          }

          // Per-pass EXIT: retract straight up from the (outside) lead-out end.
          liftTo(moves, retractZ)
        }
      }

      onProgress?.(
        (passesDone + pi + 1) / totalPasses,
        `Hole ${hi + 1}/${selectedLoops.length}`,
      )
    }
    passesDone += passRadii.length
  }
  liftTo(moves, clearanceZ)

  return moves
}
