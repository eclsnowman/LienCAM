import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { postProgram, GRBL_CONFIG, GRBLHAL_CONFIG, UCCNC_CONFIG, LINUXCNC_CONFIG, GENERIC_CONFIG } from '../../lib/post'
import { parseGcode } from '../../lib/gcode/parse'
import { toWork } from '../../lib/program/coords'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import { evidenceOutDir } from '../helpers/evidenceScratch'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'
import { instanceMoves } from '../../lib/cam/nesting/instanceToolpath'
import type { ToolpathMove, WCS } from '../../types'
import type { PostConfig, PostInput, PostResult } from '../../lib/post/types'

const evidence = 'src/tests/evidence/WO-3107'
const configs = [GRBL_CONFIG, GRBLHAL_CONFIG, UCCNC_CONFIG, LINUXCNC_CONFIG, GENERIC_CONFIG]
function input(moves: ToolpathMove[], wcs = makeWcs()): PostInput {
  const machine = makeMachine(), tool = makeTool(), op = makeOp({ toolpathMoves: moves })
  return { machine, setup: { wcs, operations: [{ op, tool, moves,
    feeds: resolveFeedrates(tool, undefined, machine.rapidRate), spindle: resolveSpindle(op, tool, machine), coolant: resolveCoolant(tool, machine) }] } }
}
function off(config: PostConfig): PostConfig {
  return { ...config, capabilities: { ...config.capabilities, arcs: false } }
}

// Independent analytic oracle: each written chord stays in the requested circle's
// tolerance tube, advances in the correct direction, and interpolates helix Z.
function checkArc(points: Array<{ x: number; y: number; z: number }>, center: { x: number; y: number }, radius: number,
  direction: number, sweep: number, z0: number, z1: number, tolerance: number, roundingMm = 0.0005) {
  let travel = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const da = Math.atan2(a.y - center.y, a.x - center.x), db = Math.atan2(b.y - center.y, b.x - center.x)
    const step = Math.atan2(Math.sin(db - da), Math.cos(db - da)) * direction
    expect(step).toBeGreaterThan(0)
    travel += step
    const dx = b.x - a.x, dy = b.y - a.y
    const closest = Math.max(0, Math.min(1, -((a.x - center.x) * dx + (a.y - center.y) * dy) / (dx * dx + dy * dy)))
    for (const t of [0, 0.25, 0.5, 0.75, 1, closest]) {
      const r = Math.hypot(a.x + (b.x - a.x) * t - center.x, a.y + (b.y - a.y) * t - center.y)
      expect(Math.abs(r - radius)).toBeLessThanOrEqual(tolerance)
    }
    expect(b.z).toBeCloseTo(z0 + (z1 - z0) * travel / sweep, 2)
  }
  // Each rounded XY endpoint can rotate by at most asin(sqrt(2)*rounding/r).
  expect(Math.abs(travel - sweep)).toBeLessThanOrEqual(2 * Math.asin(Math.SQRT2 * roundingMm / radius) + 1e-9)
}

describe('WO-3107 Emit arcs off', () => {
  it('03 soft jaws exports through Open/stage/postProject with arcs off', { timeout: 600000 }, () => {
    const out = evidenceOutDir(evidence)
    execFileSync(process.execPath, [join(evidence, 'production.mjs'), out], { timeout: 540000, stdio: 'pipe' })
    const data = JSON.parse(readFileSync(join(out, 'production.json'), 'utf8')) as {
      inputs: PostInput[]; runs: Array<{ dialect: string; arcs: boolean; mode: string; ok: boolean; diagnostics: unknown; programs: PostResult[] }>
    }
    expect(data.inputs.flatMap(i => i.setup.operations).some(o => o.op.name === 'Bore 4' && o.moves.some(m => m.type === 'arc_ccw' || m.type === 'arc_cw'))).toBe(true)
    for (const run of data.runs) {
      expect(run.ok, `${run.dialect}/${run.mode}/arcs=${run.arcs}: ${JSON.stringify(run.diagnostics)}`).toBe(true)
      for (const program of run.programs) {
        expect(program.gcode).toContain('M30')
        if (!run.arcs) expect(program.gcode).not.toMatch(/\bG[23]\b/)
      }
      if (!run.arcs && run.mode === 'separate') {
        let checkedArcs = 0, checkedChords = 0
        for (const [setupIndex, program] of run.programs.entries()) {
          const source = data.inputs[setupIndex]
          const segments = parseGcode(program.gcode).segments
          for (const op of source.setup.operations) {
            const span = program.operationSpans!.find(s => s.opId === op.op.id)!
            const cut = segments.filter(s => s.line >= span.startLine && s.line <= span.endLine && s.kind === 'feed')
            let cursor = 0
            for (let m = 1; m < op.moves.length; m++) {
              const arc = op.moves[m]
              if (arc.type !== 'arc_cw' && arc.type !== 'arc_ccw') continue
              const start = toWork(op.moves[m - 1], source.setup.wcs), end = toWork(arc, source.setup.wcs)
              const near = (a: typeof start, b: typeof start) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.002
              while (cursor < cut.length && !near(cut[cursor].from, start)) cursor++
              expect(cursor, `${run.dialect}: missing arc start ${op.op.name}/${m}`).toBeLessThan(cut.length)
              const points = [cut[cursor].from]
              do {
                expect(cut[cursor].feed).toBe(arc.feed)
                const point = cut[cursor++].to
                const last = points.at(-1)!
                // Modal coordinate rounding can repeat an identical endpoint.
                // Count/check its feed, but it contributes no path or angle.
                if (point.x !== last.x || point.y !== last.y || point.z !== last.z) points.push(point)
              } while (cursor < cut.length && !near(points.at(-1)!, end))
              expect(near(points.at(-1)!, end)).toBe(true)
              const center = toWork({ x: arc.cx!, y: arc.cy!, z: arc.z }, source.setup.wcs)
              const radius = Math.hypot(start.x - center.x, start.y - center.y)
              const direction = arc.type === 'arc_cw' ? -1 : 1
              const raw = direction * (Math.atan2(end.y - center.y, end.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x))
              const sweep = ((raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI
              checkArc(points, center, radius, direction, sweep, start.z, end.z, 0.05)
              checkedArcs++; checkedChords += points.length - 1
            }
          }
        }
        expect(checkedArcs).toBeGreaterThan(0)
        writeFileSync(join(out, `${run.dialect}-geometry.json`), JSON.stringify({ checkedArcs, checkedChords, toleranceMm: 0.05 }))
      }
      if (run.arcs && run.mode === 'combined') {
        expect(run.programs[0].gcode).toBe(readFileSync(`examples/gcode/03-soft-jaws-${run.dialect}.nc`, 'utf8'))
      }
    }
  })

  for (const config of configs) for (const units of ['mm', 'inch'] as const) {
    it(`${config.id} ${units}: CW/CCW, short/long/full circles, helices, yaw/translation, feed/dwell/continuation`, () => {
      for (const direction of [-1, 1]) for (const sweep of [Math.PI / 2, Math.PI, 1.5 * Math.PI, 2 * Math.PI]) for (const dz of [0, -3, 3]) {
        const yaw = 0.37
        const wcs: WCS = makeWcs({ origin: { x: 31, y: -17, z: 9 },
          xAxis: { x: Math.cos(yaw), y: Math.sin(yaw), z: 0 }, yAxis: { x: -Math.sin(yaw), y: Math.cos(yaw), z: 0 } })
        const start = move({ x: 18, y: 4, z: 2, feed: 2000 })
        const arc = move({ type: direction === 1 ? 'arc_ccw' : 'arc_cw', x: 8 + 10 * Math.cos(sweep), y: 4 + 10 * Math.sin(direction * sweep),
          z: 2 + dz, cx: 8, cy: 4, feed: 2000, dwellMs: 250 })
        const tail = move({ x: arc.x + 2, y: arc.y, z: arc.z, feed: 2000 })
        const cfg = { ...off(config), format: { ...config.format, units, xyzDecimals: units === 'inch' ? 5 : 4 } }
        const result = postProgram(input([move({ ...start, type: 'rapid' }), start, arc, tail], wcs), cfg)
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
        expect(result.gcode).not.toMatch(/\bG[23]\b/)
        expect(result.gcode.match(/\bG4\b/g)).toHaveLength(1)
        const scale = units === 'inch' ? 25.4 : 1
        const segments = parseGcode(result.gcode).segments.filter(s => s.kind === 'feed')
          .map(s => ({ ...s, to: { x: s.to.x * scale, y: s.to.y * scale, z: s.to.z * scale } }))
        const startWork = toWork(start, wcs), center = toWork({ x: 8, y: 4, z: 2 }, wcs)
        // The initial feed with no displacement may be emitted as a bare mode/F.
        const points = segments.map(s => s.to)
        while (points.length && Math.hypot(points[0].x - startWork.x, points[0].y - startWork.y, points[0].z - startWork.z) < 0.001) points.shift()
        points.pop() // continuation after the arc
        expect(points.length).toBeGreaterThan(5)
        checkArc([startWork, ...points], center, 10, direction, sweep, startWork.z, startWork.z + dz, 0.05, 0.5 * 10 ** -cfg.format.xyzDecimals * scale)
        for (const s of segments) expect(s.feed).toBe(Number((2000 / scale).toFixed(cfg.format.feedDecimals)))
        const end = toWork(tail, wcs)
        expect(segments.at(-1)!.to.x).toBeCloseTo(end.x, 3)
        expect(segments.at(-1)!.to.y).toBeCloseTo(end.y, 3)
        expect(segments.at(-1)!.to.z).toBeCloseTo(end.z, 3)
      }
    })
  }
  it('uses the existing user arc tolerance to bound every chord', () => {
    let priorCount = Infinity
    for (const tolerance of [0.005, 0.05, 0.2]) {
      const cfg = off(GRBL_CONFIG)
      const result = postProgram(input([move({ type: 'rapid', x: 10, z: 0 }),
        move({ type: 'arc_ccw', x: 10, cx: 0, cy: 0, z: -2, feed: 2000 })]),
      { ...cfg, options: { ...cfg.options, arcTolerance: tolerance } })
      expect(result.ok).toBe(true)
      const segments = parseGcode(result.gcode).segments.filter(s => s.kind === 'feed')
      expect(segments.length).toBeLessThan(priorCount)
      priorCount = segments.length
      checkArc([segments[0].from, ...segments.map(s => s.to)], { x: 0, y: 0 }, 10, 1, 2 * Math.PI, 0, -2, tolerance)
    }
  })
  it('vendor lines-only posts use the same sampler and pause once after the arc', () => {
    const moves = [move({ x: 10, feed: 2000 }), move({ type: 'arc_ccw', x: 10, cx: 0, cy: 0, z: -2, feed: 2000, dwellMs: 100 })]
    const cfg = off(GRBL_CONFIG)
    const ordinary = postProgram(input(moves), cfg)
    const vendor = postProgram(input(moves), { ...cfg, options: { ...cfg.options, vendorPost: 'fixture' } })
    expect(vendor.ok).toBe(true)
    expect(vendor.gcode).toBe(ordinary.gcode)
    expect(vendor.gcode.match(/\bG4\b/g)).toHaveLength(1)
  })
  it('nest instances retain rotated centers, inter-copy rapids and deferred finish feed', () => {
    const local = [move({ type: 'rapid', x: 10, z: 5 }), move({ x: 10, z: -1, feed: 2000 }),
      move({ type: 'arc_ccw', x: 10, z: -2, cx: 0, cy: 0, role: 'finish' }), move({ type: 'rapid', x: 10, z: 5 })]
    const moves = [0, 1].flatMap(i => instanceMoves(local, { partId: 'p', instanceId: String(i), x: i * 50, y: i * 40, rotationDeg: i * 90, depth: 0 }, { x: 5, y: 7 }))
    const source = input(moves)
    source.setup.operations[0].nestExpanded = true
    const result = postProgram(source, off(GRBL_CONFIG))
    expect(result.ok).toBe(true)
    const parsed = parseGcode(result.gcode)
    expect(parsed.segments.filter(s => s.kind === 'rapid').some(s => s.to.x === 55 && s.to.y === 57 && s.to.z === 5)).toBe(true)
    for (const [x, y] of [[5, 7], [55, 47]]) {
      const cut = parsed.segments.filter(s => s.kind === 'feed' && s.to.z < -1 && Math.hypot(s.to.x - x, s.to.y - y) < 11)
      expect(cut.length).toBeGreaterThan(10)
      for (const s of cut) {
        expect(s.feed).toBe(source.setup.operations[0].feeds.finishRate)
        expect(Math.abs(Math.hypot(s.to.x - x, s.to.y - y) - 10)).toBeLessThan(0.001)
      }
    }
  })
  it('non-finite and inconsistent circles refuse without throwing or exporting a shortcut', () => {
    for (const arc of [move({ type: 'arc_ccw', x: 10, cx: NaN, cy: 0 }),
      move({ type: 'arc_ccw', x: Infinity, cx: 0, cy: 0 }),
      move({ type: 'arc_ccw', x: 10, cx: 10, cy: 0 }),
      move({ type: 'arc_ccw', x: 0, y: 20, cx: 0, cy: 0 })]) {
      const result = postProgram(input([move({ x: 10 }), arc]), off(GRBL_CONFIG))
      expect(result.ok).toBe(false)
      expect(result.gcode).toBe('')
      expect(result.diagnostics.some(d => d.code === 'ARC_MALFORMED')).toBe(true)
    }
  })
  it('missing center or predecessor still refuses malformed geometry', () => {
    for (const moves of [[move({ type: 'arc_cw', x: 10, cx: 0, cy: 0 })], [move({ x: 10 }), move({ type: 'arc_cw', y: 10 })]]) {
      const result = postProgram(input(moves), off(GRBL_CONFIG))
      expect(result.ok).toBe(false)
      expect(result.gcode).toBe('')
      expect(result.diagnostics.some(d => d.code === 'ARC_MALFORMED')).toBe(true)
    }
  })
})
