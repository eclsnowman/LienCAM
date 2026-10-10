// ============================================================
// WO-285: a program bigger than the machine should say so
// ============================================================
// The offline half of "does it fit". Placement is decided at touch-off and the
// app cannot know it, but the SIZE question needs no work offset: if the
// program's extent in an axis is larger than that axis's travel, it does not
// fit anywhere on that machine, wherever you set your zero.
//
// These tests drive the validator directly AND through the two real post
// entries (postProgram = separate files, postCombined = the dialog's default
// combined mode), so the warning is proven to reach the diagnostics list the
// machinist actually reads — and proven NOT to block the post.

import { describe, expect, it } from 'vitest'
import {
  postCombined,
  postProgram,
  UCCNC_CONFIG,
  validateProgramFitsMachine,
} from '../../lib/post'
import type { PostDiagnostic, PostInput, PostOperation } from '../../lib/post/types'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import type { MachineConfig, ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move } from '../post/helpers'

/** The machine every case is measured against: 600 x 400 x 100 mm of travel. */
const TRAVEL = { x: 600, y: 400, z: 100 }
const smallRouter = (overrides: Partial<MachineConfig> = {}): MachineConfig =>
  makeMachine({ name: 'Small Router', travel: { ...TRAVEL }, ...overrides })

/**
 * One operation whose moves span EXACTLY `size` mm in each axis, parked at an
 * arbitrary corner. Two moves are enough: the extent is max - min, so the corner
 * is irrelevant — which is the whole point of the check.
 */
function programOfExtent(
  size: { x: number; y: number; z: number },
  corner = { x: -37.5, y: 12.25, z: -8 },
): PostOperation[] {
  const tool = makeTool({ id: 't1', name: '6 mm Flat End Mill', toolNumber: 1 })
  const moves: ToolpathMove[] = [
    move({ type: 'rapid', x: corner.x, y: corner.y, z: corner.z + size.z, role: 'rapid' }),
    move({
      type: 'feed',
      x: corner.x + size.x,
      y: corner.y + size.y,
      z: corner.z,
      feed: 1200,
      role: 'cut',
    }),
  ]
  const op = makeOp({ id: 'op1', name: 'Long rail pocket', toolId: 't1', toolpathMoves: moves })
  const machine = smallRouter()
  return [{
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves,
  }]
}

function inputOfExtent(
  size: { x: number; y: number; z: number },
  machine: MachineConfig = smallRouter(),
): PostInput {
  return { machine, setup: { wcs: makeWcs(), operations: programOfExtent(size) } }
}

const only = (diags: PostDiagnostic[], code: string) => diags.filter((d) => d.code === code)

describe('WO-285 program extent vs machine travel — the overrun is named in numbers', () => {
  it('flags a program 20 mm wider than the X travel with axis, extent, travel and overrun', () => {
    const diags = validateProgramFitsMachine(smallRouter(), programOfExtent({ x: 620, y: 100, z: 50 }))

    expect(diags).toHaveLength(1)
    expect(diags[0].level).toBe('warning')
    expect(diags[0].code).toBe('MACHINE_TRAVEL_EXCEEDED')
    // Each number is asserted with its own label so a coincidental substring
    // (620 mm contains "20 mm") cannot pass for the overrun.
    expect(diags[0].message).toContain('Program X extent 620 mm')
    expect(diags[0].message).toContain('X travel 600 mm')
    expect(diags[0].message).toContain('by 20 mm')
    expect(diags[0].message).toContain('"Small Router"')
    expect(diags[0].message).toMatch(/does not fit anywhere on this machine, wherever you set your zero/)
    // The honest limit is stated every time: this is a size fact, not placement.
    expect(diags[0].message).toMatch(/cannot know where the job sits on the table/)
  })

  it('is silent for that same program on a machine big enough to hold it', () => {
    const bigMill = makeMachine({ name: 'Big Mill', travel: { x: 1200, y: 900, z: 300 } })

    expect(validateProgramFitsMachine(bigMill, programOfExtent({ x: 620, y: 100, z: 50 }))).toEqual([])
  })

  it('does not care where the job sits: the same extent flags from any corner', () => {
    const here = validateProgramFitsMachine(
      smallRouter(),
      programOfExtent({ x: 620, y: 100, z: 50 }, { x: 0, y: 0, z: 0 }),
    )
    const wayOverThere = validateProgramFitsMachine(
      smallRouter(),
      programOfExtent({ x: 620, y: 100, z: 50 }, { x: -4000, y: 2500, z: -900 }),
    )

    expect(here).toEqual(wayOverThere)
    expect(here).toHaveLength(1)
  })
})

describe('WO-285 each axis is measured independently', () => {
  const cases = [
    { axis: 'X', size: { x: 620, y: 100, z: 50 }, travel: 600 },
    { axis: 'Y', size: { x: 100, y: 420, z: 50 }, travel: 400 },
    { axis: 'Z', size: { x: 100, y: 100, z: 120 }, travel: 100 },
  ]

  for (const { axis, size, travel } of cases) {
    it(`flags a 20 mm ${axis} overrun and names only ${axis}`, () => {
      const diags = validateProgramFitsMachine(smallRouter(), programOfExtent(size))

      expect(diags).toHaveLength(1)
      expect(diags[0].code).toBe('MACHINE_TRAVEL_EXCEEDED')
      expect(diags[0].message).toContain(`Program ${axis} extent ${travel + 20} mm`)
      expect(diags[0].message).toContain(`${axis} travel ${travel} mm`)
      expect(diags[0].message).toContain('by 20 mm')
    })
  }

  it('reports every offending axis when a program overruns more than one', () => {
    const diags = validateProgramFitsMachine(
      smallRouter(),
      programOfExtent({ x: 620, y: 450, z: 130 }),
    )

    expect(diags).toHaveLength(3)
    expect(diags.map((d) => d.code)).toEqual([
      'MACHINE_TRAVEL_EXCEEDED', 'MACHINE_TRAVEL_EXCEEDED', 'MACHINE_TRAVEL_EXCEEDED',
    ])
    expect(diags[0].message).toContain('by 20 mm')
    expect(diags[1].message).toContain('by 50 mm')
    expect(diags[2].message).toContain('by 30 mm')
  })
})

describe('WO-285 equality is a fit, not an overrun', () => {
  it('says nothing about a program sized exactly at every travel limit', () => {
    expect(validateProgramFitsMachine(smallRouter(), programOfExtent({ ...TRAVEL }))).toEqual([])
  })

  it('still flags the very next tenth of a millimetre past the limit', () => {
    const diags = validateProgramFitsMachine(smallRouter(), programOfExtent({ x: 600.1, y: 100, z: 50 }))

    expect(diags).toHaveLength(1)
    expect(diags[0].message).toContain('by 0.1 mm')
  })
})

describe('WO-285 not checked is never "it fits"', () => {
  const saysNothingAboutFitting = (message: string) => {
    expect(message).toContain('was not checked')
    expect(message).not.toMatch(/\bfits?\b/i)
  }

  it('warns NOT CHECKED when no machine is selected', () => {
    const diags = validateProgramFitsMachine(null, programOfExtent({ x: 9999, y: 9999, z: 9999 }))

    expect(diags).toHaveLength(1)
    expect(diags[0].level).toBe('warning')
    expect(diags[0].code).toBe('MACHINE_TRAVEL_NOT_CHECKED')
    expect(diags[0].message).toContain('no machine is selected')
    saysNothingAboutFitting(diags[0].message)
  })

  it('warns NOT CHECKED when the selected machine has no travels recorded', () => {
    const untyped = makeMachine({ name: 'Shop Router', travel: { x: 0, y: 0, z: 0 } })
    const diags = validateProgramFitsMachine(untyped, programOfExtent({ x: 9999, y: 9999, z: 9999 }))

    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('MACHINE_TRAVEL_NOT_CHECKED')
    expect(diags[0].message).toContain('X/Y/Z travel')
    expect(diags[0].message).toContain('"Shop Router"')
    saysNothingAboutFitting(diags[0].message)
  })

  it('warns NOT CHECKED for a machine record with no travel field at all', () => {
    const legacy = { ...makeMachine(), travel: undefined } as unknown as MachineConfig
    const diags = validateProgramFitsMachine(legacy, programOfExtent({ x: 9999, y: 9999, z: 9999 }))

    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('MACHINE_TRAVEL_NOT_CHECKED')
    saysNothingAboutFitting(diags[0].message)
  })

  it('still checks the axes that DO carry a travel', () => {
    const halfTyped = makeMachine({ name: 'Half Typed', travel: { x: 600, y: 0, z: 100 } })
    const diags = validateProgramFitsMachine(halfTyped, programOfExtent({ x: 620, y: 9999, z: 50 }))

    expect(only(diags, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(1)
    expect(only(diags, 'MACHINE_TRAVEL_EXCEEDED')[0].message).toContain('Program X extent 620 mm')
    expect(only(diags, 'MACHINE_TRAVEL_NOT_CHECKED')).toHaveLength(1)
    expect(only(diags, 'MACHINE_TRAVEL_NOT_CHECKED')[0].message).toContain('Y travel')
  })

  it('says nothing when there are no moves to measure', () => {
    // OP_NO_TOOLPATH owns that anomaly; there is no extent to compare here.
    const ops = programOfExtent({ x: 620, y: 100, z: 50 })
    expect(validateProgramFitsMachine(smallRouter(), [{ ...ops[0], moves: [] }])).toEqual([])
  })
})

describe('WO-285 an arc is measured by the path it sweeps, not by where it stops', () => {
  /** One op built from an explicit move list, so a case can hand-place arcs. */
  function programOfMoves(moves: ToolpathMove[]): PostOperation[] {
    const tool = makeTool({ id: 't1', name: '6 mm Flat End Mill', toolNumber: 1 })
    const op = makeOp({ id: 'op1', name: 'Bore', toolId: 't1', toolpathMoves: moves })
    const machine = smallRouter()
    return [{
      op,
      tool,
      feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
      spindle: resolveSpindle(op, tool, machine),
      coolant: resolveCoolant(tool, machine),
      moves,
    }]
  }

  const arc = (o: Partial<ToolpathMove>): ToolpathMove =>
    move({ type: 'arc_ccw', z: 0, cx: 0, cy: 0, feed: 800, ...o })

  /** A 200 mm bore cut as two half sweeps. EVERY endpoint sits on y = 0, so the
   *  endpoint-only extent in Y is zero — yet the tool really reaches y = +/-100. */
  const twoSweepCircle: ToolpathMove[] = [
    move({ type: 'rapid', x: 100, y: 0, z: 5, role: 'rapid' }),
    move({ type: 'feed', x: 100, y: 0, z: 0 }),
    arc({ x: -100, y: 0 }),
    arc({ x: 100, y: 0 }),
  ]

  it('flags the Y sweep of a bore whose endpoints all sit on one line', () => {
    // The whole defect in one case: 200 mm of Y needed, 60 mm of Y available.
    const narrowY = makeMachine({ name: 'Narrow Router', travel: { x: 600, y: 60, z: 100 } })
    const diags = validateProgramFitsMachine(narrowY, programOfMoves(twoSweepCircle))

    expect(only(diags, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(1)
    expect(diags[0].message).toContain('Program Y extent 200 mm')
    expect(diags[0].message).toContain('Y travel 60 mm')
    expect(diags[0].message).toContain('by 140 mm')
  })

  it('measures the full circle of a single closed arc move', () => {
    // Endpoint equals start with a valid centre: a full circle, not a no-op.
    const closed = [
      move({ type: 'rapid', x: 100, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 100, y: 0, z: 0 }),
      arc({ x: 100, y: 0 }),
    ]
    const narrowY = makeMachine({ name: 'Narrow Router', travel: { x: 600, y: 60, z: 100 } })
    const diags = validateProgramFitsMachine(narrowY, programOfMoves(closed))

    expect(only(diags, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(1)
    expect(diags[0].message).toContain('Program Y extent 200 mm')
  })

  it('follows the direction the arc is actually cut', () => {
    // Same endpoints, same centre, opposite directions: one sweeps the +Y half,
    // the other the -Y half. Direction decides which extreme is on the path.
    const start = [
      move({ type: 'rapid', x: 100, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 100, y: 0, z: 0 }),
    ]
    const overY = makeMachine({ name: 'Thin', travel: { x: 600, y: 60, z: 100 } })
    const ccwHalf = validateProgramFitsMachine(
      overY, programOfMoves([...start, arc({ type: 'arc_ccw', x: -100, y: 0 })]),
    )
    const cwHalf = validateProgramFitsMachine(
      overY, programOfMoves([...start, arc({ type: 'arc_cw', x: -100, y: 0 })]),
    )

    // Both bulge 100 mm into Y, in opposite directions — same extent, both flagged.
    expect(only(ccwHalf, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(1)
    expect(ccwHalf[0].message).toContain('Program Y extent 100 mm')
    expect(only(cwHalf, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(1)
    expect(cwHalf[0].message).toContain('Program Y extent 100 mm')

    // ...and the halves really are on opposite sides: a machine with the Y travel
    // to hold one bulge holds either, but the swept extent is never the 0 mm the
    // endpoints alone would report.
    const roomy = makeMachine({ name: 'Roomy', travel: { x: 600, y: 400, z: 100 } })
    expect(validateProgramFitsMachine(
      roomy, programOfMoves([...start, arc({ type: 'arc_cw', x: -100, y: 0 })]),
    )).toEqual([])
  })

  it('does not invent an overrun: an arc inside the travel stays silent', () => {
    // A 200 mm circle on the 600 x 400 machine fits; the bulge must not be
    // double-counted or rounded into a false warning.
    expect(validateProgramFitsMachine(smallRouter(), programOfMoves(twoSweepCircle))).toEqual([])
  })

  it('only counts the extremes the sweep actually crosses', () => {
    // A quarter arc from (100,0) to (0,100) crosses NO cardinal but its ends, so
    // the extent is exactly the endpoint box: 100 x 100, not the full 200 circle.
    const quarter = [
      move({ type: 'rapid', x: 100, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 100, y: 0, z: 0 }),
      arc({ x: 0, y: 100 }),
    ]
    const tight = makeMachine({ name: 'Tight', travel: { x: 90, y: 90, z: 100 } })
    const diags = validateProgramFitsMachine(tight, programOfMoves(quarter))

    expect(only(diags, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(2)
    expect(diags[0].message).toContain('Program X extent 100 mm')
    expect(diags[1].message).toContain('Program Y extent 100 mm')
  })

  /** The extent the app's own arc sampler draws for these moves, per axis. That
   *  sampler is what the viewport and the simulation walk, so it is the
   *  independent second opinion on where the tool really goes. */
  function sampledExtent(moves: ToolpathMove[], axis: 'x' | 'y'): number {
    const values = sampleArcMovesForLinearConsumers(moves).map((m) => m[axis])
    return Math.max(...values) - Math.min(...values)
  }

  /** The extent the validator measured, read back out of its own message. */
  function measuredExtent(moves: ToolpathMove[], axis: 'x' | 'y'): number {
    // Probe with a zero travel on the axis under test... except zero reads as
    // "not recorded", so use the smallest travel that is still a real number and
    // add the overrun back on. 1 mm is smaller than every extent here.
    const travel = { x: 9999, y: 9999, z: 9999, [axis]: 1 }
    const diags = validateProgramFitsMachine(
      makeMachine({ name: 'Probe', travel }), programOfMoves(moves),
    )
    const over = only(diags, 'MACHINE_TRAVEL_EXCEEDED')
    expect(over).toHaveLength(1)
    return Number(/extent ([\d.]+) mm/.exec(over[0].message)?.[1])
  }

  it('measures the same envelope the rest of the app draws for the same arcs', () => {
    // The sampler owns the arc convention for every linear consumer in the app.
    // This validator mirrors it rather than importing a module-private helper, so
    // this case proves the two do not drift, in both directions: never smaller
    // than the drawn path (that direction is the silent "it fits" this order
    // exists to prevent), and never so much larger that it invents an overrun.
    const cases: ToolpathMove[][] = [
      twoSweepCircle,
      [move({ type: 'feed', x: 100, y: 0, z: 0 }), arc({ x: 0, y: 100 })],
      [move({ type: 'feed', x: 100, y: 0, z: 0 }), arc({ type: 'arc_cw', x: 0, y: 100 })],
      [move({ type: 'feed', x: 100, y: 0, z: 0 }), arc({ x: 100, y: 0 })],
      [move({ type: 'feed', x: 30, y: 40, z: 0 }), arc({ x: -40, y: 30, cx: 0, cy: 0 })],
      [move({ type: 'feed', x: -7, y: 24, z: 0 }), arc({ type: 'arc_cw', x: 25, y: 0, cx: 0, cy: 0 })],
    ]

    for (const moves of cases) {
      for (const axis of ['x', 'y'] as const) {
        const drawn = sampledExtent(moves, axis)
        const measured = measuredExtent(moves, axis)

        // Chords cut the corners off a curve, so the sampled extent sits a
        // sagitta UNDER the true one. The validator is exact: at or above the
        // drawn extent, by less than a thousandth of a millimetre.
        expect(measured).toBeGreaterThanOrEqual(drawn)
        expect(measured - drawn).toBeLessThan(0.001)
      }
    }
  })

  it('bounds a malformed arc generously rather than under-reporting it', () => {
    // Endpoints that disagree on the radius are not a circle at all — the sampler
    // spirals between them, and a spiral's extremes need not sit where a circle's
    // do. The validator falls back to the box of the larger circle: bigger than
    // the drawn path, never smaller. Over-warning on a broken move is the safe
    // side; silently reporting a fit is the failure this check exists to prevent.
    const spiral = [
      move({ type: 'feed', x: 12, y: -5, z: 0 }),
      arc({ type: 'arc_cw', x: 4, y: 9, cx: 2, cy: 3 }),
    ]

    for (const axis of ['x', 'y'] as const) {
      expect(measuredExtent(spiral, axis)).toBeGreaterThan(sampledExtent(spiral, axis))
    }
    // The bound is the larger circle around the centre: r = hypot(10, -8). The
    // message states millimetres to 3 decimals, so compare at that resolution.
    expect(measuredExtent(spiral, 'x')).toBe(Number((2 * Math.hypot(10, 8)).toFixed(3)))
  })

  it('falls back to endpoints for a malformed arc instead of throwing', () => {
    // An arc with no centre, and one whose centre is the start point (zero radius)
    // carry nothing to sweep. Measure the endpoints, say nothing extra, never throw.
    const noCentre = [
      move({ type: 'feed', x: 0, y: 0, z: 0 }),
      move({ type: 'arc_ccw', x: 620, y: 0, z: 0, feed: 800 }),
    ]
    const diags = validateProgramFitsMachine(smallRouter(), programOfMoves(noCentre))

    expect(only(diags, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(1)
    expect(diags[0].message).toContain('Program X extent 620 mm')

    const zeroRadius = [
      move({ type: 'feed', x: 0, y: 0, z: 0 }),
      arc({ x: 0, y: 0, cx: 0, cy: 0 }),
    ]
    expect(validateProgramFitsMachine(smallRouter(), programOfMoves(zeroRadius))).toEqual([])
  })

  it('carries the arc overrun through the real post entry to the dialog', () => {
    const narrowY = makeMachine({ name: 'Narrow Router', travel: { x: 600, y: 60, z: 100 } })
    const input: PostInput = {
      machine: narrowY,
      setup: { wcs: makeWcs(), operations: programOfMoves(twoSweepCircle) },
    }
    const result = postCombined([input], UCCNC_CONFIG, { pauseBetweenSetups: false })

    expect(only(result.diagnostics, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(1)
    expect(result.diagnostics[0].message).toContain('Program Y extent 200 mm')
    // Still a warning, still posts: the arc case takes the same path as the rest.
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.gcode.length).toBeGreaterThan(0)
  })
})

describe('WO-285 the warning reaches the post dialog and never blocks posting', () => {
  it('rides postProgram diagnostics (separate-file mode) without failing the post', () => {
    const result = postProgram(inputOfExtent({ x: 620, y: 100, z: 50 }), UCCNC_CONFIG)

    expect(only(result.diagnostics, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(1)
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.gcode.length).toBeGreaterThan(0)
  })

  it('rides postCombined diagnostics (the dialog default) without failing the post', () => {
    const result = postCombined([inputOfExtent({ x: 620, y: 100, z: 50 })], UCCNC_CONFIG, {
      pauseBetweenSetups: false,
    })

    expect(only(result.diagnostics, 'MACHINE_TRAVEL_EXCEEDED')).toHaveLength(1)
    expect(result.ok).toBe(true)
    expect(result.gcode.length).toBeGreaterThan(0)
  })

  it('stays quiet through both entries for a program that fits', () => {
    const fits = inputOfExtent({ x: 300, y: 200, z: 40 })

    expect(only(postProgram(fits, UCCNC_CONFIG).diagnostics, 'MACHINE_TRAVEL_EXCEEDED')).toEqual([])
    expect(only(
      postCombined([fits], UCCNC_CONFIG, { pauseBetweenSetups: false }).diagnostics,
      'MACHINE_TRAVEL_EXCEEDED',
    )).toEqual([])
  })
})
