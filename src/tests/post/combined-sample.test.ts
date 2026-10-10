// ============================================================
// Combined multi-setup sample structure gate (Phase E2)
// ============================================================
// Locks the structural invariants of a combined multi-setup program emitted by
// the SAME postCombined pipeline that scripts/post/generate-samples.ts uses to
// produce docs/planning/post-samples/synthetic-uccnc-combined.nc: ONE program
// over TWO setups. This test does NOT import the generator (which has Playwright
// side effects); it composes two PostInputs from the public test helpers — one
// per setup on a distinct work offset with a distinct first tool — and asserts
// the composed program is well-formed:
//   - exactly ONE preamble block (one programStart line)
//   - exactly ONE M30
//   - both the G54 (Setup A) and G55 (Setup B) work-offset selects
//   - a cross-setup TOOL CHANGE (Setup A's last tool -> Setup B's first tool)
//   - lint reports zero errors
//   - byte-identical on re-post (determinism)

import { describe, it, expect } from 'vitest'
import { postCombined } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { lintGcode } from '../../lib/gcode/lint'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import type { PostInput, PostOperation } from '../../lib/post/types'
import type { Operation, Tool, ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'

/** Compose a single-op PostInput on a given work offset + tool, mirroring the
 *  buildPostInput resolution path (feeds/spindle/coolant) on hand-built moves. */
function makeSetupInput(
  fixtureOffset: number,
  opId: string,
  opName: string,
  tool: Tool,
  moves: ToolpathMove[],
): PostInput {
  const machine = makeMachine({ coolant: true })
  const op: Operation = makeOp({ id: opId, name: opName, toolId: tool.id, toolpathMoves: moves })
  const postOp: PostOperation = {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves,
  }
  const wcs = makeWcs({ label: `G${fixtureOffset}`, fixtureOffset })
  return { machine, setup: { wcs, operations: [postOp] } }
}

function buildCombinedGcode(): string {
  // Setup A "Roughing" — G54, tool T1.
  const setupA = makeSetupInput(54, 'op-rough', 'Roughing pass', makeTool({ id: 'tA', toolNumber: 1 }), [
    move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
    move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
  ])
  // Setup B "Drilling" — G55, tool T2 (distinct -> cross-setup tool change).
  const setupB = makeSetupInput(55, 'op-drill', 'Drilling pass', makeTool({ id: 'tB', toolNumber: 2 }), [
    move({ type: 'rapid', x: 40, y: 60, z: 5, role: 'rapid' }),
    move({ type: 'feed', x: 40, y: 60, z: -3, feed: 400, role: 'plunge' }),
  ])
  const result = postCombined([setupA, setupB], UCCNC_CONFIG, {
    pauseBetweenSetups: false,
    sectionComments: ['Roughing', 'Drilling'],
  })
  expect(result.ok).toBe(true)
  return result.gcode
}

describe('combined multi-setup sample (Phase E2)', () => {
  it('has exactly one preamble block', () => {
    const lines = buildCombinedGcode().split('\n')
    // The framing carries a {units} token (ADR-0022); the emitted mm preamble
    // substitutes G21 in place. Assert the SUBSTITUTED line, not the template.
    const preambleFirst = 'G90 G94 G17 G21 G64'
    expect(lines.filter((l) => l === preambleFirst).length).toBe(1)
  })

  it('has exactly one M30', () => {
    const lines = buildCombinedGcode().split('\n')
    expect(lines.filter((l) => l.trim() === 'M30').length).toBe(1)
  })

  it('selects both G54 (setup A) and G55 (setup B)', () => {
    const lines = buildCombinedGcode().split('\n')
    expect(lines.some((l) => l.trim() === 'G54')).toBe(true)
    expect(lines.some((l) => l.trim() === 'G55')).toBe(true)
  })

  it('emits a cross-setup tool change between the two setups', () => {
    const lines = buildCombinedGcode().split('\n')
    const g55Idx = lines.findIndex((l) => l.trim() === 'G55')
    expect(g55Idx).toBeGreaterThan(0)
    // UCCNC toolChange mode 'm6': Setup A loads T1, the boundary changes to T2.
    expect(lines.some((l) => l.trim() === 'T1')).toBe(true)
    expect(lines.some((l) => l.trim() === 'T2 M6')).toBe(true)
  })

  it('lints with zero errors (UCCNC paren comments)', () => {
    const findings = lintGcode(buildCombinedGcode(), { commentStyle: 'paren' })
    expect(findings.filter((f) => f.level === 'error')).toEqual([])
  })

  it('is deterministic (byte-identical re-post)', () => {
    expect(buildCombinedGcode()).toBe(buildCombinedGcode())
  })
})
