// WO-1029: the live program builder, the straight-line slice.
//
// The builder is PURE - no backend, no bridge, no store, no hardware - so
// everything this order claims is provable right here, by numbers.
//
// What has to be proved, and why each one is a defect somebody would otherwise
// ship:
//
// - The program is in WORK coordinates and is pre-shifted toward NOTHING. The
//   assertions below spell the arithmetic out (world minus a non-zero WCS
//   origin) instead of only comparing against a second call to `toWork`,
//   because a test that calls the same function twice agrees with the
//   implementation even when both are wrong. The bridge adds
//   `offsets[activeWcs]` at load; a builder that also shifted would
//   double-apply the offset and cut in the wrong place.
// - An arc is EMITTED NATIVELY since WO-1285, and since WO-1337 it may RAMP:
//   a helical arc is one `arc` step whose endpoint Z differs from its start,
//   which is a field the frozen wire contract has always carried. What still
//   REFUSES BY NAME is what no Z ramp can make sense of - a full circle and a
//   malformed one. Silently dropping an arc cuts air; silently linearising it
//   changes the shape. Arcs are a data change against the same frozen wire
//   contract, not a contract change.
// - No feed is ever invented. The wire contract requires `feedMmMin > 0`; a
//   move that cannot supply one refuses rather than borrowing a number.
// - The emitted objects match the FROZEN WIRE CONTRACT's field spellings
//   exactly (`src/tests/evidence/WO-1019/WIRE-CONTRACT.md`), asserted on whole
//   objects with `toEqual` so an extra or renamed key fails here rather than at
//   the bridge's parser.
// - The builder's output passes the validator the backend uses, so the builder
//   can never emit a program its own contract refuses.

import { describe, expect, it } from 'vitest'
import { buildStraightLineProgram } from '../../lib/program/buildMachineProgram'
import { toWork } from '../../lib/program/coords'
import { validateMachineProgram } from '../../lib/machine/controller'
import type { MachineProgram } from '../../lib/machine/controller'
import type { ToolpathMove, WCS } from '../../types'

// A NON-ZERO origin, deliberately: with a zero origin world == work and the
// transform step would be invisible to every assertion in this file.
const WCS_ORIGIN = { x: 10, y: 20, z: -5 }

function makeWcs(overrides: Partial<WCS> = {}): WCS {
  return {
    id: 'wcs-1',
    label: 'G54',
    fixtureOffset: 54,
    origin: { ...WCS_ORIGIN },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
    ...overrides,
  }
}

const TRACE = { opId: 'op-42', setupId: 'setup-7' }
const RAPID_FEED = 3000

/** One rapid to a start, then three feeds - the acceptance path. */
const STRAIGHT_LINE_MOVES: ToolpathMove[] = [
  { type: 'rapid', x: 10, y: 20, z: 5 },
  { type: 'feed', x: 30, y: 20, z: -3, feed: 800 },
  { type: 'feed', x: 30, y: 45, z: -3, feed: 800 },
  { type: 'feed', x: 10, y: 45, z: -3, feed: 1200 },
]

function buildOk(
  moves: readonly ToolpathMove[] = STRAIGHT_LINE_MOVES,
  rapidFeedMmMin = RAPID_FEED,
  wcs: WCS = makeWcs(),
): MachineProgram {
  const result = buildStraightLineProgram(moves, wcs, rapidFeedMmMin, TRACE)
  if (!result.ok) throw new Error(`expected a program, got refusal: ${result.reason}`)
  return result.program
}

// ---------------------------------------------------------------------------
// 1. The straight-line program - the acceptance path, asserted by number.
// ---------------------------------------------------------------------------

describe('WO-1029 buildStraightLineProgram - the straight-line program', () => {
  it('declares work coordinates and millimetres', () => {
    const program = buildOk()
    expect(program.frame).toBe('work')
    expect(program.units).toBe('mm')
  })

  it('mints ids from 1, sequential and unique, never the reserved 0', () => {
    const program = buildOk()
    expect(program.steps.map((s) => s.id)).toEqual([1, 2, 3, 4])
  })

  it('emits WORK coordinates - world minus the WCS origin - and pre-shifts toward the machine frame NOT AT ALL', () => {
    const program = buildOk()
    // Spelled out, not re-derived: the WCS origin is (10, 20, -5), so a world
    // point (30, 45, -3) is work (20, 25, 2). If the builder ever pre-shifted
    // toward machine coordinates (adding the offset the BRIDGE applies at
    // load), these numbers would come back as the world ones.
    expect(program.steps.map((s) => (s.kind === 'line' ? s.to : null))).toEqual([
      { x: 0, y: 0, z: 10 },
      { x: 20, y: 0, z: 2 },
      { x: 20, y: 25, z: 2 },
      { x: 0, y: 25, z: 2 },
    ])
  })

  it('puts each endpoint exactly where the shared toWork transform puts it', () => {
    const wcs = makeWcs()
    const program = buildOk(STRAIGHT_LINE_MOVES, RAPID_FEED, wcs)
    program.steps.forEach((step, i) => {
      if (step.kind !== 'line') throw new Error(`step ${step.id} is not a line`)
      expect(step.to).toEqual(toWork(STRAIGHT_LINE_MOVES[i], wcs))
    })
  })

  it('carries the resolved rapid rate on the rapid, and its own feed on each feed move', () => {
    const program = buildOk()
    expect(program.steps.map((s) => (s.kind === 'line' ? s.feedMmMin : null))).toEqual([
      RAPID_FEED,
      800,
      800,
      1200,
    ])
  })

  it('marks the rapid `rapid: true` and leaves the feed moves unmarked', () => {
    const program = buildOk()
    // `true`-only by design: an unmarked line IS a feed move. Asserting
    // `undefined` rather than `false` pins that there is no third state.
    expect(program.steps.map((s) => (s.kind === 'line' ? s.rapid : null))).toEqual([
      true,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('emits exactly the frozen wire contract fields, and no others', () => {
    // Whole-object equality against the contract's spelling
    // (`WIRE-CONTRACT.md`): `id`, `kind`, `to` with per-axis numbers,
    // `feedMmMin`, plus our additive `rapid`. A renamed or extra key fails
    // here, not at the bridge's parser.
    const program = buildOk()
    expect(program.steps[0]).toEqual({
      id: 1,
      kind: 'line',
      to: { x: 0, y: 0, z: 10 },
      feedMmMin: RAPID_FEED,
      rapid: true,
    })
    expect(program.steps[1]).toEqual({
      id: 2,
      kind: 'line',
      to: { x: 20, y: 0, z: 2 },
      feedMmMin: 800,
    })
    expect(Object.keys(program.steps[1]).sort()).toEqual(['feedMmMin', 'id', 'kind', 'to'])
  })

  it('indexes every id back to its operation, setup and move ordinal', () => {
    const program = buildOk()
    expect(program.index).toEqual({
      1: { opId: 'op-42', setupId: 'setup-7', moveOrdinal: 0 },
      2: { opId: 'op-42', setupId: 'setup-7', moveOrdinal: 1 },
      3: { opId: 'op-42', setupId: 'setup-7', moveOrdinal: 2 },
      4: { opId: 'op-42', setupId: 'setup-7', moveOrdinal: 3 },
    })
    // Every step is reachable through the index - the property run-from-line,
    // step-back and the operator readout all depend on.
    for (const step of program.steps) {
      expect(Object.hasOwn(program.index, step.id)).toBe(true)
    }
  })

  it('emits a program its own validator accepts', () => {
    expect(validateMachineProgram(buildOk())).toEqual({ ok: true })
  })

  it('builds an empty program from no moves, and that program still validates', () => {
    const program = buildOk([])
    expect(program.steps).toEqual([])
    expect(program.index).toEqual({})
    expect(validateMachineProgram(program)).toEqual({ ok: true })
  })

  it('un-rotates by a non-identity WCS basis rather than only subtracting', () => {
    // 90deg about Z: xAxis = (0,-1,0), yAxis = (1,0,0). A world point 100 along
    // the part's local +X from the origin corner lands at work (0, 100, 0).
    const wcs = makeWcs({ xAxis: { x: 0, y: -1, z: 0 }, yAxis: { x: 1, y: 0, z: 0 } })
    const program = buildOk([{ type: 'feed', x: 110, y: 20, z: -5, feed: 500 }], RAPID_FEED, wcs)
    const step = program.steps[0]
    if (step.kind !== 'line') throw new Error('expected a line step')
    expect(step.to).toEqual({ x: 0, y: 100, z: 0 })
  })
})

describe('WO-1264 buildStraightLineProgram - spindle intent is not motion', () => {
  it('wraps motion with the resolved spindle start and unconditional stop', () => {
    const result = buildStraightLineProgram(
      STRAIGHT_LINE_MOVES,
      makeWcs(),
      RAPID_FEED,
      TRACE,
      { rpm: 18_000, direction: 'ccw' },
    )
    if (!result.ok) throw new Error(result.reason)

    expect(result.program.steps[0]).toEqual({
      id: 1,
      kind: 'spindle',
      direction: 'ccw',
      rpm: 18_000,
    })
    expect(result.program.steps.slice(1, -1).map((step) => step.id)).toEqual([2, 3, 4, 5])
    expect(result.program.steps.at(-1)).toEqual({ id: 6, kind: 'spindle', direction: 'off' })
    expect(result.program.index[1]).toEqual({ action: true })
    expect(result.program.index[6]).toEqual({ action: true })
    expect(result.motionCount).toBe(4)
    expect(validateMachineProgram(result.program)).toEqual({ ok: true })
  })

  it('keeps an empty program empty instead of starting an unfinishable spindle run', () => {
    const result = buildStraightLineProgram(
      [],
      makeWcs(),
      RAPID_FEED,
      TRACE,
      { rpm: 18_000, direction: 'cw' },
    )
    if (!result.ok) throw new Error(result.reason)

    expect(result.program.steps).toEqual([])
    expect(result.program.index).toEqual({})
    expect(result.motionCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. What it refuses - by name, emitting nothing.
// ---------------------------------------------------------------------------

describe('WO-1029 buildStraightLineProgram - refuses rather than repairs', () => {
  function expectRefusal(
    result: ReturnType<typeof buildStraightLineProgram>,
    ...fragments: string[]
  ): string {
    if (result.ok) throw new Error('expected a refusal, got a program')
    // A refusal carries NO program - nothing partial escapes the builder.
    expect(Object.hasOwn(result, 'program')).toBe(false)
    for (const fragment of fragments) expect(result.reason).toContain(fragment)
    return result.reason
  }

  it('emits a clockwise arc natively (WO-1285), with its centre through the same transform as its end', () => {
    const result = buildStraightLineProgram(
      [
        { type: 'rapid', x: 40, y: 20, z: -3 },
        { type: 'arc_cw', x: 20, y: 20, z: -3, feed: 800, cx: 30, cy: 20 },
      ],
      makeWcs(),
      RAPID_FEED,
      TRACE,
    )
    if (!result.ok) throw new Error(result.reason)
    const arc = result.program.steps[1]
    expect(arc.kind).toBe('arc')
    if (arc.kind !== 'arc') return
    expect(arc.to).toEqual({ x: 20 - WCS_ORIGIN.x, y: 20 - WCS_ORIGIN.y, z: -3 - WCS_ORIGIN.z })
    expect(arc.centre).toEqual({ x: 30 - WCS_ORIGIN.x, y: 20 - WCS_ORIGIN.y, z: -3 - WCS_ORIGIN.z })
    expect(arc.clockwise).toBe(true)
    expect(arc.plane).toBe('xy')
  })

  it('emits a HELICAL arc natively too (WO-1337), carrying the endpoint Z it ramps to', () => {
    // WO-1337 REVERSES THE REFUSAL THIS TEST USED TO PIN. A ramping arc is one
    // `arc` step whose endpoint Z differs from where it started: the wire has
    // always carried that field (`AddCircularMoveP(X, Y, Z, CX, CY, CZ, ...)`),
    // so the endpoint Z is asserted by number here rather than assumed equal.
    const result = buildStraightLineProgram(
      [
        { type: 'rapid', x: 40, y: 20, z: 5 },
        { type: 'arc_ccw', x: 20, y: 20, z: -3, feed: 800, cx: 30, cy: 20 },
      ],
      makeWcs(),
      RAPID_FEED,
      TRACE,
    )
    if (!result.ok) throw new Error(result.reason)
    const arc = result.program.steps[1]
    expect(arc.kind).toBe('arc')
    if (arc.kind !== 'arc') return
    // It RAMPS: the end is 8 mm below the start, and the step says so.
    expect(arc.to).toEqual({ x: 20 - WCS_ORIGIN.x, y: 20 - WCS_ORIGIN.y, z: -3 - WCS_ORIGIN.z })
    expect(arc.to.z).not.toBe(5 - WCS_ORIGIN.z)
    // The centre's Z is the END's Z, not a second opinion about where it ends:
    // an XY arc turns about an axis parallel to Z, so no point on that axis is
    // more the centre than any other.
    expect(arc.centre).toEqual({ x: 30 - WCS_ORIGIN.x, y: 20 - WCS_ORIGIN.y, z: -3 - WCS_ORIGIN.z })
    expect(arc.clockwise).toBe(false)
    expect(arc.plane).toBe('xy')
  })

  it('and what is STILL refused by name is what a Z ramp cannot make sense of (WO-1337)', () => {
    // The refusals this builder keeps are XY facts, and a helix does not
    // rescue one. A full turn is ambiguous about which way and how far in XY
    // whether or not it descends...
    expectRefusal(
      buildStraightLineProgram(
        [
          { type: 'rapid', x: 40, y: 20, z: 5 },
          { type: 'arc_ccw', x: 40, y: 20, z: -3, feed: 800, cx: 30, cy: 20 },
        ],
        makeWcs(),
        RAPID_FEED,
        TRACE,
      ),
      'Move 1',
      'arc_ccw',
      'full circle',
    )
    // ...and ends that are not on one circle are still not on one circle.
    expectRefusal(
      buildStraightLineProgram(
        [
          { type: 'rapid', x: 40, y: 20, z: 5 },
          { type: 'arc_ccw', x: 25, y: 20, z: -3, feed: 800, cx: 30, cy: 20 },
        ],
        makeWcs(),
        RAPID_FEED,
        TRACE,
      ),
      'Move 1',
      'not on one circle',
    )
  })

  it('refuses a feed move with no feed rate rather than inventing one', () => {
    expectRefusal(
      buildStraightLineProgram(
        [{ type: 'feed', x: 30, y: 20, z: -3 }],
        makeWcs(),
        RAPID_FEED,
        TRACE,
      ),
      'Move 0',
      'no feed rate',
      'nothing',
      'never from here',
    )
  })

  it('refuses a feed move whose feed is zero', () => {
    expectRefusal(
      buildStraightLineProgram(
        [{ type: 'feed', x: 30, y: 20, z: -3, feed: 0 }],
        makeWcs(),
        RAPID_FEED,
        TRACE,
      ),
      'Move 0',
      'no feed rate',
      '0',
    )
  })

  it('refuses a rapid when the machine rapid rate was not resolved', () => {
    expectRefusal(
      buildStraightLineProgram([{ type: 'rapid', x: 30, y: 20, z: 5 }], makeWcs(), 0, TRACE),
      'Move 0',
      'rapid rate was not resolved',
      'never from here',
    )
  })

  it('does not refuse a rapid-less program for having no rapid rate', () => {
    // The rapid rate is a machine fact only the RAPIDS need. A program of pure
    // feed moves must not be held hostage to a number it never uses.
    const program = buildOk([{ type: 'feed', x: 30, y: 20, z: -3, feed: 800 }], 0)
    expect(program.steps).toHaveLength(1)
  })

  it('names the offending move ordinal, not just "the program"', () => {
    const reason = expectRefusal(
      buildStraightLineProgram(
        [
          { type: 'feed', x: 30, y: 20, z: -3, feed: 800 },
          { type: 'feed', x: 30, y: 45, z: -3, feed: 800 },
          { type: 'feed', x: 10, y: 45, z: -3 },
        ],
        makeWcs(),
        RAPID_FEED,
        TRACE,
      ),
      'Move 2',
    )
    expect(reason).not.toContain('Move 0')
    expect(reason).not.toContain('Move 1')
  })
})
