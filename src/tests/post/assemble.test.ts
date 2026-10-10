import { describe, it, expect } from 'vitest'
import { assembleSections } from '../../lib/post/assemble'
import { postProgram } from '../../lib/post/index'
import { GENERIC_CONFIG } from '../../lib/post/dialects/base'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeTool, makeMachine, makeOp, makeWcs } from './helpers'
import type { PostInput, PostOperation } from '../../lib/post/types'

function postOp(op = makeOp(), tool = makeTool()): PostOperation {
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

function makeInput(ops: PostOperation[], wcs = makeWcs()): PostInput {
  return { machine: makeMachine(), setup: { wcs, operations: ops } }
}

describe('assembleSections', () => {
  it('wraps enabled ops in order between preamble and postamble', () => {
    const a = postOp(makeOp({ id: 'a', toolId: 't1' }), makeTool({ id: 't1', toolNumber: 1 }))
    const b = postOp(makeOp({ id: 'b', toolId: 't2' }), makeTool({ id: 't2', toolNumber: 2 }))
    const sections = assembleSections(makeInput([a, b]))
    expect(sections.map((s) => s.kind)).toEqual(['preamble', 'operation', 'operation', 'postamble'])
    const opSections = sections.filter((s) => s.kind === 'operation') as Extract<typeof sections[number], { kind: 'operation' }>[]
    expect(opSections.map((s) => s.op.op.id)).toEqual(['a', 'b'])
    expect(opSections.map((s) => s.index)).toEqual([0, 1])
  })
})

describe('postProgram', () => {
  it('clean input returns ok:true with emitted gcode and correct meta', () => {
    const a = postOp(makeOp({ id: 'a', toolId: 't1' }), makeTool({ id: 't1', toolNumber: 1 }))
    const b = postOp(makeOp({ id: 'b', toolId: 't2' }), makeTool({ id: 't2', toolNumber: 2 }))
    const res = postProgram(makeInput([a, b]), GENERIC_CONFIG)
    expect(res.ok).toBe(true)
    // Emission is wired (C-P1a): clean input now produces real g-code.
    expect(res.gcode.length).toBeGreaterThan(0)
    expect(res.gcode.endsWith('\n')).toBe(true)
    expect(res.meta?.opCount).toBe(2)
    expect(res.meta?.lineCount).toBeGreaterThan(0)
  })

  it('an error diagnostic (missing tool number) short-circuits to ok:false + empty gcode', () => {
    const a = postOp(makeOp({ id: 'a' }), makeTool({ toolNumber: undefined }))
    const res = postProgram(makeInput([a]), GENERIC_CONFIG)
    expect(res.ok).toBe(false)
    expect(res.gcode).toBe('')
    expect(res.diagnostics.some((d) => d.code === 'TOOL_NUMBER_MISSING')).toBe(true)
    expect(res.meta).toBeUndefined()
  })

  it('a tilted WCS short-circuits to ok:false', () => {
    // WO-299 (1e68fcae) narrowed detectRotatedWcs from "any rotation refuses"
    // to "a pure rotation about Z is accepted; a tilt is not" - the fixture
    // this test used (xAxis (0,1,0), yAxis (-1,0,0), zAxis vertical) is a
    // well-formed 90deg yaw and is now accepted (rotatedWcs.wo299.test.ts and
    // validate.test.ts cover that acceptance directly). Swapped for a real
    // tilt (zAxis no longer vertical), which still refuses.
    const a = postOp(makeOp({ id: 'a', toolId: 't1' }), makeTool({ id: 't1', toolNumber: 1 }))
    const tilted = makeWcs({
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: Math.cos(0.1), z: Math.sin(0.1) },
      zAxis: { x: 0, y: -Math.sin(0.1), z: Math.cos(0.1) },
    })
    const res = postProgram(makeInput([a], tilted), GENERIC_CONFIG)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => d.code === 'WCS_ROTATED')).toBe(true)
  })
})
