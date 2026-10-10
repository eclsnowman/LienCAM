import { describe, it, expect } from 'vitest'
import { emitSetupSectionForCaller } from '../../lib/post/emit'
import { createModalState } from '../../lib/post/modal'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeTool, makeMachine, makeOp, makeWcs, move } from './helpers'
import type { PostInput, PostOperation } from '../../lib/post/types'

// --- local fixtures (mirrors emit.test.ts) -----------------------------------

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

/** A 2-move op: one rapid up to Z5, one feed-cut at Z5. Highest Z (safe) = 5. */
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

describe('emitSetupSection — reusable per-setup section body', () => {
  it('emits the WCS select line as the section header (no programStart/M30)', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const modal = createModalState()
    const { lines } = emitSetupSectionForCaller(makeInput([op]), UCCNC_CONFIG, modal, {})

    // (a) WCS select present, and it is the FIRST line (no preamble ahead of it).
    expect(lines).toContain('G54')
    expect(lines[0]).toBe('G54')

    // (b) does NOT emit the program preamble or the program end.
    const text = lines.join('\n')
    expect(text).not.toContain('G90 G94 G17 G21 G64') // UCCNC programStart
    expect(lines).not.toContain('M30')
    expect(lines).not.toContain('M5')
  })

  it('with trailingRetract:false appends NO trailing retract', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const modal = createModalState()
    const { lines, safeWorkZ } = emitSetupSectionForCaller(
      makeInput([op]),
      UCCNC_CONFIG,
      modal,
      { trailingRetract: false },
    )
    expect(safeWorkZ).toBe(5)
    // Last line is the final motion of the walk, not a bare retract to safe Z.
    expect(lines[lines.length - 1]).not.toBe(`G0 Z${safeWorkZ}`)
  })

  it('with trailingRetract:true appends a final G0 Z<safeWorkZ>', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const modal = createModalState()
    const { lines, safeWorkZ } = emitSetupSectionForCaller(
      makeInput([op]),
      UCCNC_CONFIG,
      modal,
      { trailingRetract: true },
    )
    expect(safeWorkZ).toBe(5)
    expect(lines[lines.length - 1]).toBe(`G0 Z${safeWorkZ}`)
  })

  it('with a sectionComment prepends one comment line ahead of the WCS select', () => {
    const op = postOp(twoMoveOp(), makeTool({ id: 't1', toolNumber: 1 }))
    const modal = createModalState()
    const { lines } = emitSetupSectionForCaller(makeInput([op]), UCCNC_CONFIG, modal, {
      sectionComment: 'Setup B',
    })
    expect(lines[0]).toBe('( Setup B )')
    expect(lines[1]).toBe('G54')
  })
})
