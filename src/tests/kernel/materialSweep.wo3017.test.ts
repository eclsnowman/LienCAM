// WO-3017: sweeps on the kernel z-dexel field from the one tool-shape source.
// - flat and ball: column heights byte-equal to today's removeSweep on the same
//   ZDexelField grid and moves (horizontal, ramps, plunges, off-field, below the
//   bottom, seeded random moves, several cell sizes);
// - bull-nose and V-bit: straight moves against the analytic profile, within
//   one cell (today's sweepProfile throws for both);
// - degrade: a shape with no analytic family never removes material the real
//   tool (real radiusAtZ of the real profile) does not occupy, and says so in
//   one line;
// - two runs identical.
import { describe, expect, it } from 'vitest'
import type { Tool } from '../../types'
import { toolTypeMeta } from '../../lib/tool/toolMeta'
import { buildToolProfile, radiusAtZ } from '../../lib/tool/toolProfile'
import { toolToCutterSpec } from '../../cam3d/integration/cutterSpec'
import { ZDexelField, removeSweep, type LinearMove } from '../../cam3d/stock'
import { DexelField, sweepMove, sweepShape, sweepHeight, type SweepShape, type ToolShapeSource } from '../../kernel/material'
import { makeTool } from '../post/helpers'

const BOX = { minX: -20, minY: -15, minZ: 0, maxX: 30, maxY: 25, maxZ: 20 }

function source(tool: Tool): ToolShapeSource {
  return { tool, profileKind: toolTypeMeta(tool.type).profileKind, profile: buildToolProfile(tool) }
}

function shapeOf(tool: Tool): SweepShape {
  const shape = sweepShape(source(tool))
  if (!shape.ok) throw new Error(shape.reason)
  return shape.value
}

/** Deterministic LCG so the random fixture is the same on every run. */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

function fixtureMoves(): LinearMove[] {
  const moves: LinearMove[] = [
    { x0: -5, y0: 0, z0: 15, x1: 12, y1: 0, z1: 15 },          // axis-aligned horizontal
    { x0: -10, y0: -8, z0: 12, x1: 20, y1: 17, z1: 12 },      // diagonal horizontal
    { x0: 0, y0: 5, z0: 18, x1: 15, y1: 9, z1: 10 },          // ramp down
    { x0: 15, y0: 9, z0: 10, x1: 2, y1: 14, z1: 16.5 },       // ramp up
    { x0: 4, y0: 4, z0: 25, x1: 4, y1: 4, z1: 8 },            // plunge
    { x0: 7.3, y0: -2.1, z0: 14, x1: 7.3, y1: -2.1, z1: 14 }, // zero length
    { x0: -30, y0: 10, z0: 11, x1: 0, y1: 30, z1: 11 },       // partly off the field
    { x0: 10, y0: -10, z0: -5, x1: 20, y1: -10, z1: -5 },     // below the bottom: clamps empty
    { x0: 1, y0: 1, z0: 13, x1: 1.0004, y1: 1.0003, z1: 13 }, // shorter than a cell
  ]
  const rnd = lcg(3017)
  for (let k = 0; k < 40; k++) {
    const p = () => ({ x: -18 + 46 * rnd(), y: -13 + 36 * rnd(), z: 4 + 18 * rnd() })
    const a = p(), b = p()
    const flatZ = rnd() < 0.5
    moves.push({ x0: a.x, y0: a.y, z0: a.z, x1: b.x, y1: b.y, z1: flatZ ? a.z : b.z })
  }
  return moves
}

const bytes = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)

describe('WO-3017 kernel z-dexel sweeps', () => {
  it('flat and ball: column heights byte-equal to today\'s removeSweep on the same moves', () => {
    const tools = [
      makeTool({ type: 'flat_end_mill', diameter: 6 }), makeTool({ type: 'flat_end_mill', diameter: 3.175 }),
      makeTool({ type: 'ball_end_mill', diameter: 6 }), makeTool({ type: 'ball_end_mill', diameter: 2 }),
      makeTool({ type: 'ball_end_mill', diameter: 12.7, fluteLength: 2 }),
    ]
    const rows: string[] = []
    let compared = 0
    for (const tool of tools) {
      const cutter = toolToCutterSpec(tool)
      const shape = shapeOf(tool)
      for (const cell of [0.2, 0.5, 0.37]) {
        const today = ZDexelField.fromBox(BOX, cell)
        const kernel = DexelField.fromBox(BOX, cell)
        expect([kernel.nx, kernel.ny, kernel.cell]).toEqual([today.nx, today.ny, today.cell])
        for (const move of fixtureMoves()) {
          const a = removeSweep(today, move, cutter)
          const b = sweepMove(kernel, move, shape)
          compared++
          if (!bytes(kernel.top).equals(bytes(today.top)) || a.removedVolumeMm3 !== b.removedVolumeMm3 || a.columnsChanged !== b.columnsChanged) {
            rows.push(`${tool.type} D${tool.diameter} cell ${cell} move ${JSON.stringify(move)}`)
          }
        }
      }
    }
    expect(rows).toEqual([])
    expect(compared).toBe(5 * 3 * fixtureMoves().length)
  })

  it('bull-nose and V-bit: straight moves equal the analytic profile within one cell (today\'s sweep throws for both)', () => {
    const tools = [
      makeTool({ type: 'bull_nose', diameter: 6, cornerRadius: 1 }),
      makeTool({ type: 'bull_nose', diameter: 10, cornerRadius: 2.5 }),
      makeTool({ type: 'v_bit', diameter: 6, angleFromAxisDeg: 45 }),
      makeTool({ type: 'v_bit', diameter: 12.7, angleFromAxisDeg: 30, tipDiameter: 0.5 }),
    ]
    const cell = 0.25
    const rows: string[] = []
    for (const tool of tools) {
      const spec = toolToCutterSpec(tool)
      expect(() => removeSweep(ZDexelField.fromBox(BOX, cell), fixtureMoves()[0], spec)).toThrow(/not supported yet/)
      const R = spec.diameter / 2
      // Analytic height from the tool record, independent of the profile.
      const h = (r: number): number => {
        if (r > R) return Infinity
        if (spec.kind === 'bull') {
          const c = spec.cornerRadius
          return r <= R - c ? 0 : c - Math.sqrt(Math.max(0, c * c - (r - (R - c)) ** 2))
        }
        if (spec.kind !== 'vbit') throw new Error('fixture')
        const rt = (spec.tipDiameter ?? 0) / 2
        return r <= rt ? 0 : (r - rt) / Math.tan(spec.angleFromAxisDeg * Math.PI / 180)
      }
      const shape = shapeOf(tool)
      for (const move of [
        { x0: -8, y0: 2, z0: 14, x1: 16, y1: 9, z1: 14 },  // straight horizontal
        { x0: -8, y0: 12, z0: 17, x1: 16, y1: 4, z1: 11 }, // straight ramp
        { x0: 5, y0: -6, z0: 30, x1: 5, y1: -6, z1: 12 },  // plunge
      ]) {
        const field = DexelField.fromBox(BOX, cell)
        sweepMove(field, move, shape)
        const len = Math.hypot(move.x1 - move.x0, move.y1 - move.y0)
        const slope = len > 0 ? Math.abs(move.z1 - move.z0) / Math.hypot(len, move.z1 - move.z0) : 0
        const abx = move.x1 - move.x0, aby = move.y1 - move.y0, ab2 = abx * abx + aby * aby
        const hc = (r: number) => h(Math.min(R, Math.max(0, r)))
        for (let j = 0; j < field.ny; j++) for (let i = 0; i < field.nx; i++) {
          const cx = field.originX + (i + 0.5) * cell, cy = field.originY + (j + 0.5) * cell
          const tc = ab2 > 0 ? Math.max(0, Math.min(1, ((cx - move.x0) * abx + (cy - move.y0) * aby) / ab2)) : 0
          const d0 = Math.hypot(cx - move.x0 - tc * abx, cy - move.y0 - tc * aby)
          const got = field.top[j * field.nx + i]
          if (d0 > R + cell) { if (got !== Math.fround(BOX.maxZ)) rows.push(`${tool.type} col ${i},${j}: cut outside the reach`); continue }
          // Truth: min over the move of tip z + h(distance); closed form when level, finely sampled otherwise.
          let truth = Infinity
          const samples = move.z0 === move.z1 ? 0 : 2000
          if (samples === 0) truth = move.z0 + h(d0)
          for (let k = 0; samples > 0 && k <= samples; k++) {
            const t = k / samples
            const d = Math.hypot(cx - (move.x0 + t * abx), cy - (move.y0 + t * aby))
            truth = Math.min(truth, move.z0 + t * (move.z1 - move.z0) + h(d))
          }
          truth = Math.min(BOX.maxZ, Math.max(BOX.minZ, truth))
          // One cell: the profile's rise across one cell laterally plus the ramp's drop along one cell.
          const oneCell = hc(d0 + cell) - hc(d0 - cell) + slope * cell + 1e-4
          if (!(got === truth || Math.abs(got - truth) <= oneCell)) rows.push(`${tool.type} ${JSON.stringify(move)} col ${i},${j}: ${got} vs ${truth}`)
        }
      }
    }
    expect(rows.slice(0, 10)).toEqual([])
  })

  it('degrade: a shape with no analytic family removes no more than the real tool, says so in one line, and removes something', () => {
    const tools = [
      makeTool({ type: 'lollipop_mill', diameter: 6, fluteLength: 5, shankDiameter: 6, neckDiameter: 3, shoulderLength: 12, overallLength: 80 }),
      makeTool({ type: 'dovetail_mill', diameter: 10, fluteLength: 4, shankDiameter: 6, angleFromAxisDeg: 30, overallLength: 80 }),
      makeTool({ type: 'slitting_saw', diameter: 20, fluteLength: 1.5, shankDiameter: 6, neckDiameter: 8, overallLength: 80 }),
      makeTool({ type: 'thread_mill', diameter: 5, fluteLength: 8, shankDiameter: 6, neckDiameter: 3.5, threadPitch: 1, threadTeethCount: 4, overallLength: 80 }),
      makeTool({ type: 'drill', diameter: 5, fluteLength: 30, angleFromAxisDeg: 59, overallLength: 80 }),
    ]
    const cell = 0.25
    const rows: string[] = []
    for (const tool of tools) {
      const shape = shapeOf(tool)
      expect(shape.kind).toBe('inscribed')
      if (shape.kind === 'inscribed') expect(shape.note.split('\n')).toHaveLength(1)
      const profile = buildToolProfile(tool)
      for (const move of [
        { x0: -8, y0: 2, z0: 12, x1: 16, y1: 9, z1: 12 },
        { x0: 5, y0: -6, z0: 30, x1: 5, y1: -6, z1: 8 },
      ]) {
        const field = DexelField.fromBox(BOX, cell)
        const result = sweepMove(field, move, shape)
        if (!(result.removedVolumeMm3 > 0)) rows.push(`${tool.type}: removed nothing`)
        const zt = Math.min(move.z0, move.z1)
        const abx = move.x1 - move.x0, aby = move.y1 - move.y0, ab2 = abx * abx + aby * aby
        for (let j = 0; j < field.ny; j++) for (let i = 0; i < field.nx; i++) {
          const top = field.top[j * field.nx + i]
          if (top >= BOX.maxZ) continue
          const cx = field.originX + (i + 0.5) * cell, cy = field.originY + (j + 0.5) * cell
          const t = ab2 > 0 ? Math.max(0, Math.min(1, ((cx - move.x0) * abx + (cy - move.y0) * aby) / ab2)) : 0
          const d = Math.hypot(cx - move.x0 - t * abx, cy - move.y0 - t * aby)
          // Every removed height in this column lies inside the real tool body at the tip's height.
          for (let k = 0; k <= 100; k++) {
            const z = top + 1e-4 + (BOX.maxZ - top - 1e-4) * (k / 100)
            if (d > radiusAtZ(profile, z - zt) + 1e-9) { rows.push(`${tool.type} col ${i},${j} z ${z}: d ${d} outside r ${radiusAtZ(profile, z - zt)}`); break }
          }
        }
      }
      // And the inscribed height is never below the tool's own lower surface.
      for (let r = 0; r <= shape.radius; r += shape.radius / 200) {
        if (radiusAtZ(profile, sweepHeight(shape, r)) < r - 1e-9) rows.push(`${tool.type} r ${r}`)
      }
    }
    expect(rows.slice(0, 10)).toEqual([])
  })

  it('is deterministic: two runs over every fixture give identical arrays', () => {
    const run = () => {
      const out: Buffer[] = []
      for (const tool of [makeTool({ type: 'bull_nose', diameter: 6, cornerRadius: 1 }), makeTool({ type: 'v_bit', diameter: 6, angleFromAxisDeg: 45 }),
        makeTool({ type: 'lollipop_mill', diameter: 6, fluteLength: 5, neckDiameter: 3, shoulderLength: 12 }), makeTool({ type: 'ball_end_mill', diameter: 4 })]) {
        const field = DexelField.fromBox(BOX, 0.3)
        for (const move of fixtureMoves()) sweepMove(field, move, shapeOf(tool))
        out.push(Buffer.from(bytes(field.top)))
      }
      return Buffer.concat(out)
    }
    expect(run().equals(run())).toBe(true)
  })
})
