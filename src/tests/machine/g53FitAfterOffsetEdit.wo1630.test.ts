// WO-1630: an MDI G53 move is never reported off the table after a work-
// offset edit.
//
// On the board: MDI `G53 G0 Z128.` ran and finished; then G54 Z was edited
// from 66.57 to 110. The console painted "OUTSIDE - Program (after G54) lies
// entirely off the table on Z (Z: program 171.4..171.4 ...)". A G53 move is in
// MACHINE coordinates - no work offset applies to it - and 128 is inside the
// table. `fitProgramToEnvelope` was shifting it by the new offset:
// 128 - 66.57 (the offset baked in when the line was built) + 110 (the new
// offset) = 171.43, exactly the false reading Operator saw.
//
// This is the bounded-logic fix, pinned directly against the production fit
// check with no store, no React, no controller. `programPreviewEnvelopeFit
// .wo377.test.tsx` extends this through `ProgramPreview` itself (Tier 2
// desk); Tier 1 is the same sequence on the board.

import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveAxisEnvelopeFromHome,
  ENVELOPE_FIT_TOLERANCE_MM,
  fitProgramToEnvelope,
  type MachineAxisRanges,
  type MachineEnvelope,
} from '../../lib/machine/machineEnvelope'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'
import { interpretGcodeProgram } from '../../lib/gcode/interpret'
import { buildStraightLineProgram } from '../../lib/program/buildMachineProgram'
import {
  armPathFidelityFromMoves,
  clearPathFidelity,
  stagedGeometryProgramPath,
} from '../../lib/machine/machineSession'
import type { QueuedMove } from '../../lib/machine/controller'
import type { WCS } from '../../types'

/** A table with every axis homing to its MINIMUM end, machine zero there too -
 *  so the reachable range is plainly 0..travel on every axis, matching the
 *  positive Z table Operator's G53 Z128 landed on. */
function envelopeFixture(): MachineEnvelope {
  const axis = (travelMm: number) => deriveAxisEnvelopeFromHome({ travelMm, homesToward: 'min', homePositionMm: 0 })
  return { x: axis(600), y: axis(400), z: axis(200) }
}

describe('WO-1630: fitProgramToEnvelope judges a G53 target in machine coordinates', () => {
  const envelope = envelopeFixture()

  it('a G53 Z128 target stays INSIDE across the exact G54 Z edit from the finding (66.57 -> 110)', () => {
    const machineAxisRanges: MachineAxisRanges = { z: { min: 128, max: 128 } }

    const before = fitProgramToEnvelope(null, { z: 66.57 }, envelope, ENVELOPE_FIT_TOLERANCE_MM, machineAxisRanges)
    expect(before?.state).toBe('inside')

    const after = fitProgramToEnvelope(null, { z: 110 }, envelope, ENVELOPE_FIT_TOLERANCE_MM, machineAxisRanges)
    expect(after?.state).toBe('inside')

    // Not just "still inside" - the verdict does not move AT ALL when the
    // offset moves, because a machine coordinate is not shifted by one.
    expect(after?.axes).toEqual(before?.axes)
    expect(after?.axes.find((a) => a.axis === 'z')?.programMin).toBe(128)
    expect(after?.axes.find((a) => a.axis === 'z')?.programMax).toBe(128)
  })

  it('a real work-coordinate program that leaves the table is still OUTSIDE, offset and all', () => {
    const programBounds = { min: { x: 0, y: 0, z: -16 }, max: { x: 80, y: 60, z: 5 } }
    // The work offset carries this program's Z entirely below the table (0..200).
    const fit = fitProgramToEnvelope(programBounds, { x: 0, y: 0, z: -300 }, envelope, ENVELOPE_FIT_TOLERANCE_MM, null)
    expect(fit?.state).toBe('outside')
    expect(fit?.offending.map((a) => a.axis)).toContain('z')
  })

  it('a work-offset edit re-judges only the WORK-frame axis it actually moves (X), never the G53 axis (Z)', () => {
    // X is a plain work-coordinate axis here (no G53 target addresses it);
    // Z carries only the G53 target, with no competing work-frame Z move -
    // this isolates "does an offset edit on an unrelated axis leave the G53
    // axis alone" from the UNION behaviour the mixed tests below cover.
    const programBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 0, z: 0 } }
    const machineAxisRanges: MachineAxisRanges = { z: { min: 128, max: 128 } }

    const inside = fitProgramToEnvelope(
      programBounds, { x: 0, y: 0 }, envelope, ENVELOPE_FIT_TOLERANCE_MM, machineAxisRanges,
    )
    expect(inside?.state).toBe('inside')

    // Move the WORK-frame axis (X) off the table: only X changes verdict.
    const xMoved = fitProgramToEnvelope(
      programBounds, { x: -700, y: 0 }, envelope, ENVELOPE_FIT_TOLERANCE_MM, machineAxisRanges,
    )
    expect(xMoved?.state).toBe('outside')
    const zAfterXMove = xMoved?.axes.find((a) => a.axis === 'z')
    expect(zAfterXMove?.state).toBe('inside')
    expect(zAfterXMove?.programMin).toBe(128)

    // No workOriginMachine.z at all (this program never moves Z in work
    // coordinates) - the G53 Z target is unaffected regardless of what the
    // work offset does, exactly as the union requires when there is nothing
    // to union it with.
    const zOffsetMoved = fitProgramToEnvelope(
      programBounds, { x: 0, y: 0 }, envelope, ENVELOPE_FIT_TOLERANCE_MM, machineAxisRanges,
    )
    expect(zOffsetMoved?.axes.find((a) => a.axis === 'z')?.programMin).toBe(128)
    expect(zOffsetMoved?.state).toBe('inside')
  })

  it('with no machine-absolute range at all, behaves exactly as before (regression)', () => {
    const programBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 60, z: 5 } }
    const fit = fitProgramToEnvelope(programBounds, { x: 0, y: 0, z: 0 }, envelope, ENVELOPE_FIT_TOLERANCE_MM)
    expect(fit?.state).toBe('inside')
    expect(fitProgramToEnvelope(null, null, envelope)).toBeNull()
    expect(fitProgramToEnvelope(null, null, envelope, ENVELOPE_FIT_TOLERANCE_MM, null)).toBeNull()
  })

  // -------------------------------------------------------------------------
  // AUDIT (architect, 2026-09-17): AUDIT: FAIL. `fitProgramToEnvelope` was
  // REPLACING an axis's verdict with only its G53 targets whenever that axis
  // appeared in `machineAxisRanges` - a real work-coordinate move on the SAME
  // axis was silently dropped. Reproduce: `G53 G0 Z128` then `G54 G1 Z-500` -
  // Z was judged 128..128 (INSIDE) with the -500 move never considered, so
  // the OUTSIDE gate that blocks CYCLE START never fired. The fix: an axis's
  // verdict is the UNION of its G53 targets (never shifted) and its
  // work-coordinate moves (shifted by the active offset).
  // -------------------------------------------------------------------------
  it('MIXED, bounded logic: a G53 Z128 target plus a G54 Z move that leaves the table -> OUTSIDE (fails before the fix)', () => {
    // Before the fix this returned 'inside': machineAxisRanges.z REPLACED
    // programBounds.z entirely, so the -500 work move never reached the
    // verdict at all.
    const programBounds = { min: { x: 0, y: 0, z: -500 }, max: { x: 0, y: 0, z: -500 } }
    const machineAxisRanges: MachineAxisRanges = { z: { min: 128, max: 128 } }
    const fit = fitProgramToEnvelope(
      programBounds, { x: 0, y: 0, z: 66.57 }, envelope, ENVELOPE_FIT_TOLERANCE_MM, machineAxisRanges,
    )
    expect(fit?.state).toBe('outside')
    expect(fit?.offending.map((a) => a.axis)).toContain('z')
    const z = fit?.axes.find((a) => a.axis === 'z')
    // The union: min(128, -500 + 66.57) .. max(128, -500 + 66.57).
    expect(z?.programMin).toBeCloseTo(-433.43, 6)
    expect(z?.programMax).toBe(128)
  })

  it('MIXED, bounded logic: a G53 Z128 target plus a G54 Z move that ALSO stays on the table -> INSIDE', () => {
    const programBounds = { min: { x: 0, y: 0, z: 50 }, max: { x: 0, y: 0, z: 50 } }
    const machineAxisRanges: MachineAxisRanges = { z: { min: 128, max: 128 } }
    const fit = fitProgramToEnvelope(
      programBounds, { x: 0, y: 0, z: 66.57 }, envelope, ENVELOPE_FIT_TOLERANCE_MM, machineAxisRanges,
    )
    expect(fit?.state).toBe('inside')
    const z = fit?.axes.find((a) => a.axis === 'z')
    expect(z?.programMin).toBeCloseTo(116.57, 6)
    expect(z?.programMax).toBe(128)
  })
})

describe('WO-1630 audit follow-up: TEXT route (buildPreviewModel) through the same union', () => {
  const envelope = envelopeFixture()
  const G53_ONLY = 'G21 G90 G54\nG53 G0 Z128\nM30\n'
  const MIXED_OUTSIDE = 'G21 G90 G54\nG53 G0 Z128\nG1 Z-500 F500\nM30\n'
  const MIXED_INSIDE = 'G21 G90 G54\nG53 G0 Z128\nG1 Z50 F500\nM30\n'

  function fitFor(programText: string, offsetZ: number) {
    const model = buildPreviewModel(programText)
    return fitProgramToEnvelope(
      model.workBounds, { x: 0, y: 0, z: offsetZ }, envelope, ENVELOPE_FIT_TOLERANCE_MM,
      model.machineCoordinateRanges,
    )
  }

  it('(1) original case: a bare G53 Z128 stays INSIDE across the exact G54 edit from the finding', () => {
    expect(fitFor(G53_ONLY, 66.57)?.state).toBe('inside')
    expect(fitFor(G53_ONLY, 110)?.state).toBe('inside')
  })

  it('(2) mixed: G53 Z128 plus a G54 move that leaves the table in Z -> OUTSIDE', () => {
    // `buildPreviewModel` (unowned, previewGeometry.ts) always models a text
    // program as starting from work (0,0,0) - it has no live position to read
    // - so a program's FIRST included work-frame point always carries work
    // Z=0 into `workBounds`, whatever line precedes it. A G54 offset near
    // Operator's own value (66.57) puts work Z=0 ON the table, which would blend
    // with a Z-500 excursion into a range that merely STRADDLES the table
    // (a real 'partial', not this test's concern). -300 keeps BOTH work Z=0
    // and work Z=-500 on the same, entirely-off-table side, isolating the
    // fact this test exists to prove: the G53 Z128 target (unaffected, still
    // 'inside') no longer hides the real work-coordinate excursion.
    const fit = fitFor(MIXED_OUTSIDE, -300)
    expect(fit?.state).toBe('outside')
    expect(fit?.offending.map((a) => a.axis)).toContain('z')
  })

  it('(3) mixed, both inside -> INSIDE', () => {
    // Symmetric reasoning: +100 keeps both work Z=0 (the same always-included
    // start point) and work Z=50 safely on the table, alongside the G53
    // Z128 target.
    expect(fitFor(MIXED_INSIDE, 100)?.state).toBe('inside')
  })
})

describe('WO-1630 audit follow-up: GEOMETRY (staged) route through the same union', () => {
  function textFrame(): WCS {
    return {
      id: 'wo1630-geometry-work-frame',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    }
  }

  // Builds the SAME staged-move shape `loadGcodeTextToolpathProgram` builds
  // for a bridge (UCCNC) machine with no g-code text route - `interpret` then
  // `buildStraightLineProgram`, the two real production steps - then arms the
  // geometry check exactly the way the product does, through the exported
  // door (`armPathFidelityFromMoves`).
  function armGeometry(programText: string, offsetZ: number): void {
    const interpreted = interpretGcodeProgram(programText, {
      dialect: 'uccnc',
      sessionWcs: 'G54',
      initialPosition: { x: 0, y: 0, z: 0 },
      machineUnits: 'mm',
      workOffsets: { G54: { x: 0, y: 0, z: offsetZ } },
    })
    if (!interpreted.ok) throw new Error(interpreted.refusal.message)
    const moves = interpreted.program.stages.flatMap((stage) => stage.moves)
    const built = buildStraightLineProgram(moves, textFrame(), 3000, { opId: 'wo1630-geometry', setupId: 'wo1630' })
    if (!built.ok) throw new Error(built.reason)
    const steps = built.program.steps.filter(
      (step): step is QueuedMove => step.kind === 'line' || step.kind === 'arc',
    )
    armPathFidelityFromMoves(steps, 'work', { x: 0, y: 0, z: 0 })
  }

  afterEach(() => { clearPathFidelity() })

  const envelope = envelopeFixture()

  function fitForStaged(offsetZ: number) {
    const staged = stagedGeometryProgramPath()
    expect(staged).not.toBeNull()
    return fitProgramToEnvelope(
      staged!.workBounds, { x: 0, y: 0, z: offsetZ }, envelope, ENVELOPE_FIT_TOLERANCE_MM,
      staged!.machineAxisRanges,
    )
  }

  it('(1) original case: a staged G53 Z128 stays INSIDE across the exact G54 edit, workBounds excludes the baked point', () => {
    armGeometry('G21 G90 G54\nG53 G0 Z128\nM30\n', 66.57)
    const staged = stagedGeometryProgramPath()
    // The only staged point is the machineAbsolute line - workBounds must be
    // null, never the false-bake ((128 - 66.57) re-shifted) that produced
    // Operator's "Z: program 171.4..171.4".
    expect(staged?.workBounds).toBeNull()
    expect(staged?.machineAxisRanges.z).toEqual({ min: 128, max: 128 })
    expect(staged?.moves).toHaveLength(1)
    expect(staged?.moves[0]).toMatchObject({ type: 'rapid', x: 0, y: 0 })
    expect(staged?.moves[0].z).toBeCloseTo(128 - 66.57, 6)

    expect(fitForStaged(66.57)?.state).toBe('inside')
    // The exact gesture from the finding: only the work offset moves.
    expect(fitForStaged(110)?.state).toBe('inside')
  })

  it('(2) mixed: a staged G53 Z128 plus a G54 move that leaves the table in Z -> OUTSIDE', () => {
    armGeometry('G21 G90 G54\nG53 G0 Z128\nG1 Z-500 F500\nM30\n', 66.57)
    const staged = stagedGeometryProgramPath()
    // The G1 Z-500 is a real work-frame move and must show up in workBounds.
    expect(staged?.workBounds?.min.z).toBeCloseTo(-500, 6)
    expect(staged?.workBounds?.max.z).toBeCloseTo(-500, 6)
    expect(staged?.moves.map((move) => move.z)).toEqual([128 - 66.57, -500])

    const fit = fitForStaged(66.57)
    expect(fit?.state).toBe('outside')
    expect(fit?.offending.map((a) => a.axis)).toContain('z')
  })

  it('(3) mixed, both inside -> INSIDE', () => {
    armGeometry('G21 G90 G54\nG53 G0 Z128\nG1 Z50 F500\nM30\n', 66.57)
    expect(fitForStaged(66.57)?.state).toBe('inside')
  })
})
