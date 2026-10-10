import { describe, it, expect } from 'vitest'
import { postProgram } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { LINUXCNC_CONFIG } from '../../lib/post/dialects/linuxcnc'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { lintGcode } from '../../lib/gcode/lint'
import { makeTool, makeMachine, makeOp, makeWcs, move } from './helpers'
import type { PostConfig, PostInput, PostOperation } from '../../lib/post/types'

// Export-unit boundary (ADR-0022). The post emits G20 + converts every
// dimensioned value (mm/25.4) when format.units==='inch', with xyz 4 / feed 1
// decimals. mm output stays byte-identical (proven elsewhere); these tests pin
// the inch path: framing word, value conversion, feed (IPM), and lint clean.

// Build an inch variant the same way PostProcessModal does from exportUnits:
// override format.units + per-unit decimals only.
function asInch(c: PostConfig): PostConfig {
  return { ...c, format: { ...c.format, units: 'inch', xyzDecimals: 4, feedDecimals: 1 } }
}

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

// Coordinates are exact inch multiples in mm so the converted values are clean:
// 25.4 -> 1, 50.8 -> 2, 12.7 -> 0.5. Feed 1500 mm/min -> 59.1 IPM (1 decimal).
function inchFriendlyOp() {
  return makeOp({
    id: 'op1',
    name: 'Inch test',
    toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 25.4, y: 50.8, z: 12.7, role: 'rapid' }),
      move({ type: 'feed', x: 50.8, y: 50.8, z: -12.7, feed: 1500, role: 'cut' }),
    ],
  })
}

function postWith(c: PostConfig): string {
  const result = postProgram(makeInput([postOp(inchFriendlyOp())]), c)
  expect(result.ok).toBe(true)
  return result.gcode
}

describe('inch export boundary (ADR-0022)', () => {
  it('UCCNC: emits G20 (not G21) in the program frame', () => {
    const g = postWith(asInch(UCCNC_CONFIG))
    expect(g.split('\n')[0]).toBe('G90 G94 G17 G20 G64')
    expect(/\bG21\b/.test(g)).toBe(false)
  })

  it('converts coordinates mm -> inch (25.4 -> 1.0000) at the formatting seam', () => {
    const g = postWith(asInch(UCCNC_CONFIG))
    // 25.4mm X -> X1, 50.8mm Y -> Y2, 12.7mm Z -> Z0.5 (trailing zeros trimmed).
    expect(g).toContain('X1')
    expect(g).toContain('Y2')
    expect(g).toContain('Z0.5')
    // The raw mm magnitudes must NOT survive as coordinate words.
    expect(/\bX25\.4\b/.test(g)).toBe(false)
    expect(/\bZ12\.7\b/.test(g)).toBe(false)
  })

  it('converts the feed mm/min -> IPM (1500 -> F59.1)', () => {
    const g = postWith(asInch(UCCNC_CONFIG))
    expect(g).toContain('F59.1')
    expect(/\bF1500\b/.test(g)).toBe(false)
  })

  it('GRBL + LinuxCNC also emit G20 and lint clean', () => {
    const grbl = postWith(asInch(GRBL_CONFIG))
    expect(grbl.split('\n')[0]).toBe('G90 G94 G17 G20')
    expect(lintGcode(grbl, { commentStyle: 'paren' }).filter((f) => f.level === 'error')).toEqual([])

    const lcnc = postWith(asInch(LINUXCNC_CONFIG))
    expect(lcnc.split('\n')[0]).toBe('G90 G94 G17 G20 G64')
    expect(
      lintGcode(lcnc, { commentStyle: 'semicolon' }).filter((f) => f.level === 'error'),
    ).toEqual([])
  })

  it('mm path still emits G21 in the exact same frame (byte-identity guard)', () => {
    const g = postWith(UCCNC_CONFIG) // unmodified = mm
    expect(g.split('\n')[0]).toBe('G90 G94 G17 G21 G64')
  })
})
