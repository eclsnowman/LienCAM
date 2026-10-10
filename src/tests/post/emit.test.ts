import { describe, it, expect } from 'vitest'
import { emitProgram } from '../../lib/post/emit'
import { postProgram } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { LINUXCNC_CONFIG } from '../../lib/post/dialects/linuxcnc'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeTool, makeMachine, makeOp, makeOverride, makeWcs, move } from './helpers'
import type { PostConfig, PostInput, PostOperation } from '../../lib/post/types'

// --- local fixtures ----------------------------------------------------------

function postOp(op = makeOp(), tool = makeTool(), machine = makeMachine()): PostOperation {
  return {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves: op.toolpathMoves ?? [],
  }
}

function makeInput(ops: PostOperation[], wcs = makeWcs()): PostInput {
  return { machine: makeMachine(), setup: { wcs, operations: ops } }
}

/** A 2-move op: one rapid, one feed-cut. */
function twoMoveOp(): ReturnType<typeof makeOp> {
  return makeOp({
    id: 'op1',
    name: 'Profile',
    toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}

// Deep-clone a config and patch options so tests can flip knobs safely.
function withOptions(base: PostConfig, options: Partial<PostConfig['options']>): PostConfig {
  return { ...base, options: { ...base.options, ...options } }
}

// Deep-clone a config and patch capabilities (e.g. flip arcs on/off).
function withCaps(base: PostConfig, caps: Partial<PostConfig['capabilities']>): PostConfig {
  return { ...base, capabilities: { ...base.capabilities, ...caps } }
}

// An arcs-DISABLED clone of UCCNC, to assert the unchanged fail-loud behavior.
const UCCNC_NO_ARCS = withCaps(UCCNC_CONFIG, { arcs: false })

// --- UCCNC golden tests ------------------------------------------------------

describe('emitProgram — UCCNC', () => {
  it('emits the exact preamble + WCS select', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    expect(lines[0]).toBe('G90 G94 G17 G21 G64')
    expect(lines[1]).toBe('G54')
  })

  it('sanitizes parens in an op name to avoid nested-paren comments', () => {
    const op = postOp(
      makeOp({ id: 'op1', name: 'Pocket (rough)', toolId: 't1', toolpathMoves: [move({ type: 'feed', x: 1, y: 1, z: 0, feed: 2000 })] }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    const commentLine = lines.find((l) => l.includes('Pocket'))
    expect(commentLine).toBe('( Pocket [rough] )')
    // No nested parens inside the comment body.
    expect(commentLine!.slice(1, -1)).not.toContain('(')
  })

  it('rapid -> G0, feed -> G1 with F', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    const text = lines.join('\n')
    expect(text).toContain('G0 X10 Y20 Z5')
    expect(text).toMatch(/G1 X30 F2000/)
  })

  it('fast_traverse emits G1 (never G0) at its move feed', () => {
    // Start with a rapid so the modal motion mode is G0 going into the
    // fast_traverse; the fast_traverse must FLIP it to G1 (not stay G0).
    const op = postOp(
      makeOp({
        id: 'op1',
        name: 'FT',
        toolId: 't1',
        toolpathMoves: [
          move({ type: 'rapid', x: 0, y: 0, z: 0, role: 'rapid' }),
          move({ type: 'feed', x: 50, y: 0, z: 0, feed: 3500, role: 'fast_traverse' }),
        ],
      }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    const ftLine = lines.find((l) => l.includes('X50'))
    expect(ftLine).toBeDefined()
    // fast_traverse is a feed role -> G1 at its own feed, NEVER a rapid.
    expect(ftLine).toBe('G1 X50 F3500')
    expect(ftLine).not.toContain('G0')
  })

  it('modal suppression: the second move omits unchanged axes', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    // Move 2 only changes X (Y, Z unchanged from move 1).
    const cutLine = lines.find((l) => l.startsWith('G1'))
    expect(cutLine).toBe('G1 X30 F2000')
    expect(cutLine).not.toContain('Y')
    expect(cutLine).not.toContain('Z')
  })

  it('emits spindle M3 S and coolant M8', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    const text = lines.join('\n')
    expect(text).toContain('M3 S12000')
    expect(text).toContain('M8')
  })

  it('commands a changed spindle speed between same-tool operations before the second cut', () => {
    const tool = makeTool({ id: 't1', toolNumber: 1 })
    const rough = postOp(
      makeOp({
        id: 'rough', name: 'Rough', toolId: 't1',
        toolpathMoves: [move({ type: 'feed', x: 1, y: 0, z: 0, feed: 2000 })],
      }),
      tool,
    )
    const finish = postOp(
      makeOp({
        id: 'finish', name: 'Finish', toolId: 't1',
        feedrateOverride: makeOverride({ rpm: 8000 }),
        toolpathMoves: [move({ type: 'feed', x: 2, y: 0, z: 0, feed: 2000 })],
      }),
      tool,
    )
    const cfg = withOptions(UCCNC_CONFIG, { dwellMs: 1500 })
    const { lines } = emitProgram(makeInput([rough, finish]), cfg)

    const firstSpeed = lines.indexOf('M3 S12000')
    const secondSpeed = lines.indexOf('M3 S8000')
    const finishCut = lines.findIndex((line, index) => index > secondSpeed && line.includes('X2'))
    expect(firstSpeed).toBeGreaterThanOrEqual(0)
    expect(secondSpeed).toBeGreaterThan(firstSpeed)
    expect(lines[secondSpeed + 1]).toBe('G4 P1500')
    expect(finishCut).toBeGreaterThan(secondSpeed)
  })

  it('does not re-emit spindle state between same-tool operations at the same speed', () => {
    const tool = makeTool({ id: 't1', toolNumber: 1 })
    const first = postOp(makeOp({
      id: 'first', name: 'First', toolId: 't1',
      toolpathMoves: [move({ type: 'feed', x: 1, y: 0, z: 0, feed: 2000 })],
    }), tool)
    const second = postOp(makeOp({
      id: 'second', name: 'Second', toolId: 't1',
      toolpathMoves: [move({ type: 'feed', x: 2, y: 0, z: 0, feed: 2000 })],
    }), tool)
    const { lines } = emitProgram(makeInput([first, second]), UCCNC_CONFIG)

    expect(lines.filter((line) => line === 'M3 S12000')).toHaveLength(1)
  })

  it('a 2-tool program emits the M5/M9/retract/T# M6 change sequence, no redundant M0 (no G53)', () => {
    const opA = postOp(
      makeOp({ id: 'a', name: 'Rough', toolId: 't1', toolpathMoves: [move({ type: 'rapid', x: 1, y: 1, z: 5 }), move({ type: 'feed', x: 1, y: 1, z: 0, feed: 2000 })] }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const opB = postOp(
      makeOp({ id: 'b', name: 'Finish', toolId: 't2', toolpathMoves: [move({ type: 'feed', x: 2, y: 2, z: 0, feed: 2000 })] }),
      makeTool({ id: 't2', toolNumber: 2 }),
    )
    const { lines } = emitProgram(makeInput([opA, opB]), UCCNC_CONFIG)
    const text = lines.join('\n')
    // The change block, in order: spindle/coolant off, retract UP in WORK Z, change, pause.
    const idxM5 = lines.indexOf('M5')
    const idxM9 = lines.indexOf('M9', idxM5)
    const idxRetract = lines.findIndex((l, i) => i > idxM9 && /^G0 Z/.test(l))
    const idxT6 = lines.indexOf('T2 M6')
    const idxM0 = lines.indexOf('M0')
    expect(idxM9).toBeGreaterThan(idxM5)
    expect(idxRetract).toBeGreaterThan(idxM9)
    expect(idxT6).toBeGreaterThan(idxRetract)
    expect(idxM0).toBe(-1) // owner ruling 10-04: an M0 after M6 is redundant, never written
    expect(text).toContain('T2 M6')
    // No machine-zero plunge anywhere in the program.
    expect(text).not.toContain('G53')
  })

  it('re-asserts G54 after the tool change, before the next work move (no G53 plunge)', () => {
    const opA = postOp(
      makeOp({ id: 'a', name: 'Rough', toolId: 't1', toolpathMoves: [move({ type: 'rapid', x: 1, y: 1, z: 5 }), move({ type: 'feed', x: 1, y: 1, z: 0, feed: 2000 })] }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const opB = postOp(
      makeOp({ id: 'b', name: 'Finish', toolId: 't2', toolpathMoves: [move({ type: 'rapid', x: 2, y: 2, z: 5 })] }),
      makeTool({ id: 't2', toolNumber: 2 }),
    )
    const { lines } = emitProgram(makeInput([opA, opB]), UCCNC_CONFIG)
    expect(lines.some((l) => l.includes('G53'))).toBe(false)
    const idxToolChange = lines.indexOf('T2 M6')
    const idxReassert = lines.findIndex((l, i) => i > idxToolChange && l === 'G54')
    const idxReturnMove = lines.findIndex((l, i) => i > idxReassert && /^G0\b.*X2/.test(l))
    expect(idxReassert).toBeGreaterThan(idxToolChange)
    expect(idxReturnMove).toBeGreaterThan(idxReassert)
  })

  it('an arc move with arcs DISABLED -> ok:false + ARC_UNSUPPORTED via postProgram', () => {
    const op = postOp(
      makeOp({
        id: 'op1',
        name: 'Arc',
        toolId: 't1',
        toolpathMoves: [
          move({ type: 'feed', x: 0, y: 0, z: 0, feed: 2000 }),
          move({ type: 'arc_cw', x: 10, y: 10, z: 0, cx: 10, cy: 0, feed: 2000 }),
        ],
      }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const res = postProgram(makeInput([op]), UCCNC_NO_ARCS)
    expect(res.ok).toBe(false)
    expect(res.gcode).toBe('')
    expect(res.diagnostics.some((d) => d.code === 'ARC_UNSUPPORTED')).toBe(true)
  })

  it('programEndMode safe_z_only retracts UP in work Z + M30 (no G53 plunge, no end XY)', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    const idxM30 = lines.indexOf('M30')
    expect(idxM30).toBe(lines.length - 1)
    // The program-end retract is a work-coord Z-only move (G0 Z, never G53 Z0).
    const endRetract = lines[idxM30 - 1]
    expect(endRetract).toMatch(/^G0 Z/)
    expect(endRetract).not.toContain('G53')
    expect(endRetract).not.toContain('X')
    expect(endRetract).not.toContain('Y')
    expect(lines.some((l) => l.includes('G53'))).toBe(false)
  })

  it('writeWorkOffsets true emits a G10 L2 line', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const cfg = withOptions(UCCNC_CONFIG, { writeWorkOffsets: true })
    const wcs = makeWcs({ origin: { x: 1, y: 2, z: 3 } })
    const { lines } = emitProgram(makeInput([op], wcs), cfg)
    expect(lines.some((l) => l.startsWith('G10 L2 P1'))).toBe(true)
  })

  it('postProgram joins lines with a trailing newline and counts them', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const res = postProgram(makeInput([op]), UCCNC_CONFIG)
    expect(res.ok).toBe(true)
    expect(res.gcode.endsWith('\n')).toBe(true)
    expect(res.meta?.lineCount).toBeGreaterThan(0)
    expect(res.gcode.split('\n').filter((l) => l.length > 0).length).toBe(res.meta?.lineCount)
  })

  it('spindle-on dwell uses milliseconds when dwellMs > 0', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const cfg = withOptions(UCCNC_CONFIG, { dwellMs: 1500 })
    const { lines } = emitProgram(makeInput([op]), cfg)
    expect(lines).toContain('G4 P1500')
  })
})

// --- arc emission tests ------------------------------------------------------

describe('emitProgram — arcs', () => {
  it('a single arc_cw move emits G2 X.. Y.. I.. J.. F.. with frame-invariant I/J', () => {
    // Non-zero WCS origin so we can prove the endpoint is toWork-transformed
    // but I/J are NOT (world-difference, frame-invariant).
    const wcs = makeWcs({ origin: { x: 100, y: 200, z: 0 } })
    const prev = { x: 10, y: 0 }
    const arc = { x: 10, y: 10, cx: 0, cy: 0 } // world center (0,0)
    const op = postOp(
      makeOp({
        id: 'op1',
        name: 'Arc',
        toolId: 't1',
        toolpathMoves: [
          move({ type: 'feed', x: prev.x, y: prev.y, z: 0, feed: 2000, role: 'cut' }),
          move({ type: 'arc_cw', x: arc.x, y: arc.y, z: 0, cx: arc.cx, cy: arc.cy, feed: 2000, role: 'cut' }),
        ],
      }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const { lines } = emitProgram(makeInput([op], wcs), UCCNC_CONFIG)
    const g2 = lines.find((l) => l.startsWith('G2'))
    expect(g2).toBeDefined()
    // Endpoint X/Y are toWork-transformed: arc.x - origin.x, arc.y - origin.y.
    // Here arc world X (10) == prev world X (10) -> work X unchanged (-90) and
    // modal-suppressed; only Y is re-emitted. F is modal too: the anchor feed
    // already emitted F2000, so it is suppressed on the arc block.
    // I = cx - xPrevWorld, J = cy - yPrevWorld (world difference, NO toWork).
    expect(g2).toBe('G2 Y-190 I-10 J0')
    // Sanity: assert the I/J formula explicitly.
    expect(arc.cx - prev.x).toBe(-10) // I
    expect(arc.cy - prev.y).toBe(0) // J
    // The toWork-transformed endpoint Y is present; X (unchanged) is suppressed.
    expect(g2).toContain('Y-190')
    expect(g2).not.toContain('X')
  })

  it('a single arc_ccw move emits G3', () => {
    const op = postOp(
      makeOp({
        id: 'op1',
        name: 'ArcCCW',
        toolId: 't1',
        toolpathMoves: [
          move({ type: 'feed', x: 10, y: 0, z: 0, feed: 2000, role: 'cut' }),
          move({ type: 'arc_ccw', x: 0, y: 10, z: 0, cx: 0, cy: 0, feed: 2000, role: 'cut' }),
        ],
      }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    const arcLine = lines.find((l) => l.startsWith('G3'))
    expect(arcLine).toBeDefined()
    // X (10->0) and Y (0->10) both change; Z unchanged + F modal-suppressed
    // (anchor already emitted F2000).
    expect(arcLine).toBe('G3 X0 Y10 I-10 J0')
  })

  it('an arc move with arcs ENABLED but missing cx/cy fails loud ARC_MALFORMED', () => {
    const op = postOp(
      makeOp({
        id: 'op1',
        name: 'BadArc',
        toolId: 't1',
        toolpathMoves: [
          move({ type: 'feed', x: 10, y: 0, z: 0, feed: 2000, role: 'cut' }),
          // arc_cw with no cx/cy -> malformed.
          move({ type: 'arc_cw', x: 0, y: 10, z: 0, feed: 2000, role: 'cut' }),
        ],
      }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const res = postProgram(makeInput([op]), UCCNC_CONFIG)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => d.code === 'ARC_MALFORMED')).toBe(true)
  })

  it('a dense sampled quarter-circle of feed moves collapses to >= 1 G2/G3 block end-to-end', () => {
    // Sample a quarter circle radius 20 centered at origin, from (20,0) to (0,20),
    // CCW, finely enough that the collapse must fit an arc (well within 0.05 tol).
    const r = 20
    const N = 60
    const moves = []
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * (Math.PI / 2)
      moves.push(move({ type: 'feed', x: r * Math.cos(t), y: r * Math.sin(t), z: 0, feed: 2000, role: 'cut' }))
    }
    const op = postOp(
      makeOp({ id: 'op1', name: 'QC', toolId: 't1', toolpathMoves: moves }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    const arcBlocks = lines.filter((l) => l.startsWith('G2') || l.startsWith('G3'))
    expect(arcBlocks.length).toBeGreaterThanOrEqual(1)
  })

  it('a linear-only job with arcs ENABLED still emits identical G0/G1 (no spurious arcs)', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const { lines } = emitProgram(makeInput([op]), UCCNC_CONFIG)
    const text = lines.join('\n')
    expect(text).toContain('G0 X10 Y20 Z5')
    expect(text).toMatch(/G1 X30 F2000/)
    // No arc blocks for a straight job.
    expect(lines.some((l) => l.startsWith('G2') || l.startsWith('G3'))).toBe(false)
  })
})

// --- GRBL golden tests -------------------------------------------------------

describe('emitProgram — GRBL', () => {
  it('preamble has NO G64', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const { lines } = emitProgram(makeInput([op]), GRBL_CONFIG)
    expect(lines[0]).toBe('G90 G94 G17 G21')
    expect(lines[0]).not.toContain('G64')
  })

  it('tool change emits M0 + a ( change tool ) comment and NO M6', () => {
    const opA = postOp(
      makeOp({ id: 'a', name: 'Rough', toolId: 't1', toolpathMoves: [move({ type: 'feed', x: 1, y: 1, z: 0, feed: 2000 })] }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const opB = postOp(
      makeOp({ id: 'b', name: 'Finish', toolId: 't2', toolpathMoves: [move({ type: 'feed', x: 2, y: 2, z: 0, feed: 2000 })] }),
      makeTool({ id: 't2', toolNumber: 2 }),
    )
    const { lines } = emitProgram(makeInput([opA, opB]), GRBL_CONFIG)
    const text = lines.join('\n')
    expect(text).not.toContain('M6')
    expect(text).toContain('( change tool to T2 )')
    expect(lines).toContain('M0')
  })

  it('dwell uses seconds when dwellMs > 0', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const cfg: PostConfig = { ...GRBL_CONFIG, options: { ...GRBL_CONFIG.options, dwellMs: 1500 } }
    const { lines } = emitProgram(makeInput([op]), cfg)
    // 1500 ms -> 1.5 s.
    expect(lines).toContain('G4 P1.5')
  })
})

// --- LinuxCNC golden tests ---------------------------------------------------

describe('emitProgram — LinuxCNC', () => {
  it('preamble includes G21 + G64 and the WCS select', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const { lines } = emitProgram(makeInput([op]), LINUXCNC_CONFIG)
    expect(lines[0]).toBe('G90 G94 G17 G21 G64')
    expect(lines[1]).toBe('G54')
  })

  it('section comments use ; semicolon style, not parentheses', () => {
    const op = postOp(
      makeOp({ id: 'op1', name: 'Profile', toolId: 't1', toolpathMoves: [move({ type: 'feed', x: 1, y: 1, z: 0, feed: 2000 })] }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const { lines } = emitProgram(makeInput([op]), LINUXCNC_CONFIG)
    const commentLine = lines.find((l) => l.includes('Profile'))
    expect(commentLine).toBe('; Profile')
    expect(commentLine).not.toContain('(')
  })

  it('a native M6 tool change emits T2 M6 (LinuxCNC has M6, unlike GRBL)', () => {
    const opA = postOp(
      makeOp({ id: 'a', name: 'Rough', toolId: 't1', toolpathMoves: [move({ type: 'feed', x: 1, y: 1, z: 0, feed: 2000 })] }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const opB = postOp(
      makeOp({ id: 'b', name: 'Finish', toolId: 't2', toolpathMoves: [move({ type: 'feed', x: 2, y: 2, z: 0, feed: 2000 })] }),
      makeTool({ id: 't2', toolNumber: 2 }),
    )
    const { lines } = emitProgram(makeInput([opA, opB]), LINUXCNC_CONFIG)
    expect(lines).toContain('T2 M6')
    expect(lines).not.toContain('M0') // the M6 is the stop (owner ruling 10-04)
  })

  it('an arc move emits G2/G3 with I and J words', () => {
    const op = postOp(
      makeOp({
        id: 'op1',
        name: 'Arc',
        toolId: 't1',
        toolpathMoves: [
          move({ type: 'feed', x: 10, y: 0, z: 0, feed: 2000, role: 'cut' }),
          move({ type: 'arc_ccw', x: 0, y: 10, z: 0, cx: 0, cy: 0, feed: 2000, role: 'cut' }),
        ],
      }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const { lines } = emitProgram(makeInput([op]), LINUXCNC_CONFIG)
    const arcLine = lines.find((l) => l.startsWith('G2') || l.startsWith('G3'))
    expect(arcLine).toBeDefined()
    expect(arcLine).toContain('I')
    expect(arcLine).toContain('J')
  })

  it('dwell uses seconds when dwellMs > 0', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const cfg: PostConfig = { ...LINUXCNC_CONFIG, options: { ...LINUXCNC_CONFIG.options, dwellMs: 1500 } }
    const { lines } = emitProgram(makeInput([op]), cfg)
    // 1500 ms -> 1.5 s.
    expect(lines).toContain('G4 P1.5')
  })
})

// --- custom program-end + custom tool-change (Phase B) -----------------------

describe('emitProgram — custom program-end (verbatim)', () => {
  it('programEndMode custom replaces the auto end block (no duplicate M5/M30)', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const cfg = withOptions(UCCNC_CONFIG, {
      programEndMode: 'custom',
      programEndCustom: 'M5\nG53 G0 Z0\nM30 ; my end',
    })
    const { lines, diagnostics } = emitProgram(makeInput([op]), cfg)
    expect(diagnostics.some((d) => d.code === 'PROGRAM_END_CUSTOM_MISSING')).toBe(false)
    // The custom block OWNS the entire end of program: its three lines appear in
    // order at the tail.
    const iM5 = lines.indexOf('M5')
    const iG53 = lines.indexOf('G53 G0 Z0')
    const iCustomM30 = lines.indexOf('M30 ; my end')
    expect(iM5).toBeGreaterThan(0)
    expect(iG53).toBe(iM5 + 1)
    expect(iCustomM30).toBe(iG53 + 1)
    // The auto M5/M30 tail is SUPPRESSED (Phase B P1b "Replace"): exactly one M5,
    // no bare auto 'M30', and the program ends on the user's last verbatim line.
    expect(lines.filter((l) => l === 'M5')).toHaveLength(1)
    expect(lines).not.toContain('M30')
    expect(lines[lines.length - 1]).toBe('M30 ; my end')
  })

  it('programEndMode custom with empty programEndCustom -> fail loud + whole end block suppressed', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const cfg = withOptions(UCCNC_CONFIG, {
      programEndMode: 'custom',
      programEndCustom: '   ',
    })
    const res = postProgram(makeInput([op]), cfg)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => d.code === 'PROGRAM_END_CUSTOM_MISSING')).toBe(true)
    // No custom lines emitted AND the auto M5/M30 tail is suppressed (custom owns
    // the end). res.ok=false blocks export, so the spindle-still-on tail never ships.
    const { lines } = emitProgram(makeInput([op]), cfg)
    expect(lines).not.toContain('M30')
    expect(lines).not.toContain('   ')
  })

  it('programEndMode custom with missing programEndCustom -> PROGRAM_END_CUSTOM_MISSING', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const cfg = withOptions(UCCNC_CONFIG, { programEndMode: 'custom' })
    const { diagnostics } = emitProgram(makeInput([op]), cfg)
    expect(diagnostics.some((d) => d.code === 'PROGRAM_END_CUSTOM_MISSING')).toBe(true)
  })
})

describe('emitProgram — custom tool-change (macro) fail-loud', () => {
  // A macro-mode clone of UCCNC with NO macro authored.
  const UCCNC_MACRO_EMPTY = withOptions(
    withCaps(UCCNC_CONFIG, { toolChange: 'macro' }),
    { toolChangeMacro: '' },
  )

  it('toolChange macro with empty toolChangeMacro -> TOOL_CHANGE_MACRO_MISSING + no bare T#', () => {
    const opA = postOp(
      makeOp({ id: 'a', name: 'Rough', toolId: 't1', toolpathMoves: [move({ type: 'feed', x: 1, y: 1, z: 0, feed: 2000 })] }),
      makeTool({ id: 't1', toolNumber: 1 }),
    )
    const opB = postOp(
      makeOp({ id: 'b', name: 'Finish', toolId: 't2', toolpathMoves: [move({ type: 'feed', x: 2, y: 2, z: 0, feed: 2000 })] }),
      makeTool({ id: 't2', toolNumber: 2 }),
    )
    const { lines, diagnostics } = emitProgram(makeInput([opA, opB]), UCCNC_MACRO_EMPTY)
    expect(diagnostics.some((d) => d.code === 'TOOL_CHANGE_MACRO_MISSING')).toBe(true)
    // No bare tool-select for the CHANGE (T2). The first-tool T1 select is fine.
    expect(lines).not.toContain('T2')
    expect(lines).not.toContain('T2 M6')
  })
})
