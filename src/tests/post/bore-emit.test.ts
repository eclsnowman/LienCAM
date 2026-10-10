import { describe, expect, it } from 'vitest'
import { buildBoreToolpath } from '../../lib/cam/bore2d'
import { lintGcode } from '../../lib/gcode/lint'
import { postProgram } from '../../lib/post'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import { makeMachine, makeOp, makeTool, makeWcs } from './helpers'
import type { BoreParams, BoreWorkerPayload } from '../../lib/cam/types'
import type { PostInput, PostOperation } from '../../lib/post/types'

describe('Bore exact-arc post path', () => {
  it('keeps G2/G3 interpolation through post and passes G-code lint', () => {
    const tool = makeTool({ diameter: 6, shankDiameter: 6 })
    const params: BoreParams = {
      geometryId: 'g1',
      loopIds: [],
      direction: 'climb',
      sortStrategy: 'none',
      geometrySource: 'loop',
    }
    const points = Array.from({ length: 64 }, (_, i) => {
      const a = i / 64 * Math.PI * 2
      return { x: 6 * Math.cos(a), y: 6 * Math.sin(a) }
    })
    const payload: BoreWorkerPayload = {
      opId: 'bore-op',
      setupId: 'setup',
      params,
      heights: {
        clearanceHeight: 10, clearanceHeightMode: 'absolute',
        retractHeight: 5, feedHeight: 1,
        topHeight: 0, topHeightMode: 'absolute',
        bottomHeight: -2, bottomHeightMode: 'absolute',
      },
      passes: {
        stepdown: 2, stepover: 1.5, stockToLeave: 0.1,
        finishPasses: 1, springPasses: 0,
      },
      linking: {
        entryType: 'ramp_helical', rampAngle: 3, rampLength: 0,
        leadInRadius: 0, leadOutRadius: 0,
        retractType: 'full', transitionType: 'safe_height',
      },
      tool,
      loops: [{ id: 'circle', points, closed: true, type: 'contour' }],
      wcsOrigin: { x: 0, y: 0, z: 0 },
    }
    const moves = buildBoreToolpath(payload)
    const machine = makeMachine()
    const op = makeOp({
      id: 'bore-op',
      name: 'Bore',
      type: 'bore',
      toolId: tool.id,
      params: params as unknown as Record<string, unknown>,
      toolpathMoves: moves,
    })
    const postOp: PostOperation = {
      op,
      tool,
      feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
      spindle: resolveSpindle(op, tool, machine),
      coolant: resolveCoolant(tool, machine),
      moves,
    }
    const input: PostInput = { machine, setup: { wcs: makeWcs(), operations: [postOp] } }

    const result = postProgram(input, UCCNC_CONFIG)
    expect(result.ok).toBe(true)
    // WO-1896: a climb bore orbits CCW (wall material on the cutter's right) -> G3.
    expect(result.gcode).toMatch(/\bG3\b/)
    expect(result.gcode).toMatch(/\bI-?[\d.]+/)
    expect(result.gcode).toMatch(/\bJ-?[\d.]+/)
    expect(lintGcode(result.gcode, { commentStyle: 'paren' }).filter(f => f.level === 'error')).toEqual([])
  })
})
