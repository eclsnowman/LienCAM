import { describe, it, expect } from 'vitest'
import { postProgram } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeTool, makeMachine, makeOp, makeWcs } from './helpers'
import type { PostConfig, PostInput, PostOperation } from '../../lib/post/types'
import type { ToolpathMove } from '../../types'

// ============================================================
// End-to-end proof for the two newly UI-exposed arc-fit knobs:
//   - maxArcRadius (arcs LARGER than this stay as lines)
//   - minSweepDeg  (arcs SWEEPING LESS than this stay as lines)
// These post a dense circular-arc polyline through the REAL post pipeline
// (postProgram, the same entry the app uses) and assert the emitted g-code
// changes when each knob is moved. arcTolerance/minArcRadius are already
// covered by arcfit-collapse + arcfit-synthetic; this file targets the two
// knobs that previously had NO UI editor.
// ============================================================

// Deep-clone a config and patch capabilities (flip individual arc knobs).
function withCaps(base: PostConfig, caps: Partial<PostConfig['capabilities']>): PostConfig {
  return { ...base, capabilities: { ...base.capabilities, ...caps } }
}

/**
 * Build a single-op PostInput whose only cutting motion is a densely-sampled
 * 90deg circular arc (sweep < 180 so it collapses to exactly ONE arc by
 * default). Radius and sample count are parameterized so individual tests can
 * stress a specific knob.
 */
function arcInput(radius = 10, samples = 24): PostInput {
  const cx = 0
  const cy = 0
  const z = -1
  const sweep = Math.PI / 2 // 90 deg
  const start = { x: cx + radius, y: cy } // angle 0, +X point
  const moves: ToolpathMove[] = [
    { type: 'rapid', x: start.x, y: start.y, z: 5, role: 'rapid' },
    { type: 'feed', x: start.x, y: start.y, z, role: 'plunge', feed: 400 },
  ]
  for (let k = 1; k <= samples; k++) {
    const a = (sweep * k) / samples
    moves.push({
      type: 'feed',
      x: cx + radius * Math.cos(a),
      y: cy + radius * Math.sin(a),
      z,
      role: 'cut',
      feed: 2000,
    })
  }
  moves.push({ type: 'rapid', x: cx, y: cy + radius, z: 5, role: 'rapid' })

  const machine = makeMachine()
  const tool = makeTool({ id: 't1', toolNumber: 1 })
  const op = makeOp({ id: 'op1', name: 'Arc', toolId: 't1', toolpathMoves: moves })
  const postOp: PostOperation = {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves,
  }
  return { machine, setup: { wcs: makeWcs(), operations: [postOp] } }
}

function hasArc(gcode: string): boolean {
  return /\bG2\b/.test(gcode) || /\bG3\b/.test(gcode)
}

describe('arc-fit UI knobs — end-to-end through postProgram (UCCNC)', () => {
  // (a) Default caps: the dense arc collapses to G2/G3.
  it('(a) with default caps, a dense arc emits G2/G3', () => {
    const result = postProgram(arcInput(), UCCNC_CONFIG)
    expect(result.ok).toBe(true)
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([])
    expect(hasArc(result.gcode)).toBe(true)
  })

  // (b) minSweepDeg cranked high: the SAME geometry stays all G1, no arcs.
  it('(b) with minSweepDeg=180, the same arc stays G1 (no G2/G3)', () => {
    const cfg = withCaps(UCCNC_CONFIG, { minSweepDeg: 180 })
    const result = postProgram(arcInput(), cfg)
    expect(result.ok).toBe(true)
    expect(hasArc(result.gcode)).toBe(false)
    expect(/\bG1\b/.test(result.gcode)).toBe(true)
  })

  // (c) maxArcRadius shrunk below the arc radius: the large-radius arc stays G1.
  it('(c) with maxArcRadius=0.1, a radius-10 arc stays G1 (not collapsed)', () => {
    const cfg = withCaps(UCCNC_CONFIG, { maxArcRadius: 0.1 })
    const result = postProgram(arcInput(10), cfg)
    expect(result.ok).toBe(true)
    expect(hasArc(result.gcode)).toBe(false)
    expect(/\bG1\b/.test(result.gcode)).toBe(true)
  })

  // Sanity: the default-caps arc and the knobbed runs share IDENTICAL geometry,
  // so the ONLY reason (b)/(c) differ is the knob — prove the baseline arcs.
  it('baseline control: default caps DO arc the radius-10 geometry used in (c)', () => {
    const result = postProgram(arcInput(10), UCCNC_CONFIG)
    expect(hasArc(result.gcode)).toBe(true)
  })
})
