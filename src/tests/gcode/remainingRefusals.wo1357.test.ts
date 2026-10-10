import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { interpretGcodeProgram, type GcodeInterpretOptions } from '../../lib/gcode/interpret'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { postProgram } from '../../lib/post'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import type { PostConfig, PostInput, PostOperation } from '../../lib/post/types'
import { LIENCNC_REFERENCE_POSITIONS } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move } from '../post/helpers'

// WO-1362: the active machine definition supplies its stored G30 points, as
// `machineSession.ts` passes `machineReferencePositions(...)`. The probe models
// the built-in machine's seed so `G30` is measured against what the app runs.
const OPTIONS: GcodeInterpretOptions = {
  dialect: 'uccnc',
  sessionWcs: 'G54',
  initialPosition: { x: 0, y: 0, z: 0 },
  machineUnits: 'mm',
  machineHome: { x: 0, y: 0, z: 0 },
  workOffsets: { G54: { x: 0, y: 0, z: 0 } },
  referencePositions: { ...LIENCNC_REFERENCE_POSITIONS },
}

function load(gcode: string) {
  const result = interpretGcodeProgram(gcode, OPTIONS)
  expect(result.ok, result.ok ? undefined : result.refusal.message).toBe(true)
  if (!result.ok) throw new Error(result.refusal.message)
  return result.program
}

describe('WO-1357 removes ordinary read-path refusals', () => {
  it('accepts path-control tolerances and end-of-text termination', () => {
    const program = load('G21 G90 G64 P0.01 Q0.02\nG0 X1 Y2 Z3')
    expect(program.moveCount).toBe(1)
    expect(program.accepted.find((entry) => entry.word === 'EOF')?.note).toContain('end of program')
  })

  it('uses UCCNC reset G0 for a coordinate on the opening G43 block', () => {
    const program = load('G21 G90\nG43 Z0.6 H3\nM30')
    expect(program.stages[0].moves[0]).toMatchObject({ type: 'rapid', z: 0.6 })
  })

  it('accepts incremental and absolute arc-centre modes', () => {
    const incremental = load('G21 G90 G91.1\nG0 X10 Y0 Z0\nG3 X20 Y0 I5 J0 F100\nM30')
    expect(incremental.stages[0].moves[1]).toMatchObject({ cx: 15, cy: 0 })
    const absolute = load('G21 G90 G90.1\nG0 X10 Y0 Z0\nG3 X20 Y0 I15 J0 F100\nM30')
    expect(absolute.stages[0].moves[1]).toMatchObject({ cx: 15, cy: 0 })
  })

  it('converts inverse-time feeds from line and arc distance', () => {
    const line = load('G21 G90 G93\nG1 X10 F2\nM30')
    expect(line.stages[0].moves[0].feed).toBeCloseTo(20)
    const arc = load('G21 G90 G93\nG0 X0 Y0\nG3 X10 Y0 I5 J0 F2\nM30')
    expect(arc.stages[0].moves[1].feed).toBeCloseTo(Math.PI * 10)
  })

  it('takes the time inverse time commands on an arc that is linearised', () => {
    // G93 commands the block's DURATION, not its speed: F2 is one half of a
    // minute, so each of these G18 semicircles has to take 30 s however many
    // chords it is staged as. Feeding the chords at the true arc length's rate
    // ran the block early - worst on a radius at or under the sagitta
    // tolerance, where a semicircle is two chords and 30 s became 27.009 s.
    const seconds = (gcode: string) => {
      const cuts = load(gcode).stages[0].moves.filter((entry) => entry.type === 'feed')
      expect(cuts.length).toBeGreaterThan(1)
      let previous = { x: 0, y: 0, z: 0 }
      let minutes = 0
      for (const cut of cuts) {
        minutes += Math.hypot(cut.x - previous.x, cut.y - previous.y, cut.z - previous.z) / (cut.feed ?? 0)
        previous = { x: cut.x, y: cut.y, z: cut.z }
      }
      return minutes * 60
    }
    expect(seconds('G21 G90 G18 G93\nG0 X0 Y0 Z0\nG2 X0 Z10 I0 K5 F2\nM30')).toBeCloseTo(30, 6)
    expect(seconds('G21 G90 G18 G93\nG0 X0 Y0 Z0\nG2 X0 Z0.08 I0 K0.04 F2\nM30')).toBeCloseTo(30, 6)
    expect(seconds('G21 G90 G19 G93\nG0 X0 Y0 Z0\nG3 Y0 Z10 J0 K5 F2\nM30')).toBeCloseTo(30, 6)
  })

  it("round-trips LienCAM's own inch export through the geometry route", () => {
    const machine = makeMachine()
    const tool = makeTool()
    const op = makeOp({
      toolpathMoves: [
        move({ type: 'rapid', role: 'rapid', x: 25.4, y: 50.8, z: 12.7 }),
        move({ type: 'feed', role: 'cut', x: 50.8, y: 50.8, z: -12.7, feed: 1500 }),
      ],
    })
    const postedOp: PostOperation = {
      op,
      tool,
      feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
      spindle: resolveSpindle(op, tool, machine),
      coolant: resolveCoolant(tool, machine),
      moves: op.toolpathMoves ?? [],
    }
    const input: PostInput = { machine, setup: { wcs: makeWcs(), operations: [postedOp] } }
    const inchConfig: PostConfig = {
      ...UCCNC_CONFIG,
      format: { ...UCCNC_CONFIG.format, units: 'inch', xyzDecimals: 4, feedDecimals: 1 },
    }
    const posted = postProgram(input, inchConfig)
    expect(posted.ok).toBe(true)
    expect(posted.gcode).toContain('G20')
    const loaded = load(posted.gcode)
    const moves = loaded.stages.flatMap((stage) => stage.moves)
    expect(moves).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 25.4, y: 50.8, z: 12.7 }),
      expect.objectContaining({ x: 50.8, y: 50.8, z: -12.7 }),
    ]))
  })

  it('linearises G18 and G19 arcs while preserving the orthogonal axis', () => {
    const xz = load('G21 G18 G90\nG0 X0 Y7 Z0\nG2 X10 Z0 I5 K0 F100\nM30')
    expect(xz.moveCount).toBeGreaterThan(2)
    expect(xz.stages[0].moves.every((move) => move.y === 7)).toBe(true)
    const yz = load('G21 G19 G90\nG0 X8 Y0 Z0\nG3 Y10 Z0 J5 K0 F100\nM30')
    expect(yz.moveCount).toBeGreaterThan(2)
    expect(yz.stages[0].moves.every((move) => move.x === 8)).toBe(true)
  })

  it('keeps dwells on their side of no-motion state boundaries', () => {
    const spindle = load([
      'G21 G90 G54', 'M3 S12000', 'G1 X10 F300', 'M5', 'G4 P500',
      'M3 S12000', 'G1 X20', 'M30',
    ].join('\n'))
    expect(spindle.stages).toMatchObject([
      { moves: [{ x: 10 }], dwells: [], spindleOn: true, ends: { kind: 'spindle', on: false } },
      { moves: [], dwells: [{ seconds: 0.5, afterMove: 0 }], spindleOn: false,
        ends: { kind: 'spindle', on: true } },
      { moves: [{ x: 20 }], dwells: [], spindleOn: true, ends: { kind: 'end' } },
    ])

    const coolant = load([
      'G21 G90 G54', 'M8', 'G1 X10 F300', 'M9', 'G4 P500', 'M8', 'G1 X20', 'M30',
    ].join('\n'))
    expect(coolant.stages[1]).toMatchObject({
      moves: [],
      dwells: [{ seconds: 0.5, afterMove: 0 }],
      coolant: { flood: false, mist: false },
      ends: { kind: 'coolant', flood: true, mist: false },
    })

    const frame = load([
      'G21 G90 G54', 'G1 X10 F300', 'M0', 'G4 P500', 'G55', 'G1 X20 Y0 Z0', 'M30',
    ].join('\n'))
    expect(frame.stages[1]).toMatchObject({
      wcs: 'G54',
      moves: [],
      dwells: [{ seconds: 0.5, afterMove: 0 }],
      ends: { kind: 'frame', next: 'G55' },
    })
    expect(frame.stages[2]).toMatchObject({ wcs: 'G55', moves: [{ x: 20 }] })

    const hold = load([
      'G21 G90 G54', 'G1 X10 F300', 'G55', 'G4 P500', 'M0', 'G1 X20 Y0 Z0', 'M30',
    ].join('\n'))
    expect(hold.stages[1]).toMatchObject({
      wcs: 'G55',
      moves: [],
      dwells: [{ seconds: 0.5, afterMove: 0 }],
      ends: { kind: 'hold' },
    })
    expect(hold.stages[2]).toMatchObject({ wcs: 'G55', moves: [{ x: 20 }] })
  })

  it('loads the two formerly refused Fusion corpus files', () => {
    for (const file of ['fusion360-issue395-xy.nc', 'fusion360-drilling-excerpt.nc']) {
      const program = load(readFileSync(`src/tests/fixtures/foreign-gcode/${file}`, 'utf8'))
      expect(program.moveCount).toBeGreaterThan(0)
      console.log(`WO-1357 corpus ${file}: ${program.moveCount} moves, ${program.stages.length} stages`)
    }
  })
})

describe('WO-1357 twenty-case probe', () => {
  const cases = [
    ['G20 coordinates', 'G20 G90\nG0 X1\nM30'],
    ['G20 feed', 'G20 G90\nG1 X1 F10\nM30'],
    ['G4 UCCNC dwell', 'G21\nG4 P500\nG0 X1\nM30'],
    ['G4 LinuxCNC dwell', 'G21\nG4 P0.5\nG0 X1\nM30'],
    ['G64 P', 'G21 G64 P0.01\nG0 X1\nM30'],
    ['G64 P Q', 'G21 G64 P0.01 Q0.02\nG0 X1\nM30'],
    ['G61', 'G21 G61\nG0 X1\nM30'],
    ['missing M2 M30', 'G21\nG0 X1'],
    ['G91.1', 'G21 G91.1\nG0 X0 Y0\nG2 X10 I5 F100\nM30'],
    ['G90.1', 'G21 G90.1\nG0 X0 Y0\nG2 X10 I5 F100\nM30'],
    ['G93 line', 'G21 G93\nG1 X10 F2\nM30'],
    ['G93 arc', 'G21 G93\nG0 X0 Y0\nG2 X10 I5 F2\nM30'],
    ['G18 centre arc', 'G21 G18\nG0 X0 Z0\nG2 X10 I5 F100\nM30'],
    ['G18 radius arc', 'G21 G18\nG0 X0 Z0\nG2 X10 R5 F100\nM30'],
    ['G19 centre arc', 'G21 G19\nG0 Y0 Z0\nG3 Y10 J5 F100\nM30'],
    ['G19 radius arc', 'G21 G19\nG0 Y0 Z0\nG3 Y10 R5 F100\nM30'],
    ['G43 opening Z', 'G21 G90\nG43 Z0.6 H3\nM30'],
    ['bare opening coordinate', 'G21 G90\nZ0.6\nM30'],
    ['G30 stored point', 'G21\nG30\nM30'],
    ['LinuxCNC O word', 'G21\nO100 repeat [2]\nG0 X1\nO100 endrepeat\nM30'],
  ] as const

  it.each(cases)('%s', (_name, gcode) => {
    const result = interpretGcodeProgram(gcode, OPTIONS)
    if (_name === 'LinuxCNC O word') {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toContain('address O')
      return
    }
    expect(result.ok, result.ok ? undefined : result.refusal.message).toBe(true)
  })

  it('writes the measured probe evidence when requested', () => {
    if (process.env.WRITE_EVIDENCE !== '1') return
    const rows = cases.map(([name, gcode]) => {
      const result = interpretGcodeProgram(gcode, OPTIONS)
      return result.ok
        ? `| ${name} | LOADS | ${result.program.moveCount} move(s) |`
        : `| ${name} | REFUSED | ${result.refusal.message.replace(/\|/g, '\\|')} |`
    })
    mkdirSync('src/tests/evidence/WO-1357', { recursive: true })
    writeFileSync(
      'src/tests/evidence/WO-1357/twenty-case-probe.md',
      '# WO-1357 twenty-case geometry-route probe\n\n'
      + 'Generated by `remainingRefusals.wo1357.test.ts` with `WRITE_EVIDENCE=1`.\n\n'
      + '| Case | Verdict | Detail |\n| --- | --- | --- |\n'
      + `${rows.join('\n')}\n`,
    )
  })
})
