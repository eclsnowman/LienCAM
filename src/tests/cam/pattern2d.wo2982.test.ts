// WO-2982 - scripted decorative pattern library, Phase A of WO-2962's PLAN.
// Acceptance A1-A4, negatives N1-N7 and checks C1-C8 (PLAN sections 6 and 8).
// The independent truth for A1/N4/N5 is the WO-2962 oracle's measured numbers
// (src/tests/evidence/WO-2962/first-example-metrics.json, numpy, outside the product).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PatternSpecError, buildPatternToolpath, chordDeviation, curvePoint, insideDistance, parsePatternSpec, sampleCurve,
} from '../../lib/cam/pattern2d'
import type { PatternWorkerPayload } from '../../lib/cam/pattern2d'
import type { HeightParams, Tool, ToolpathMove } from '../../types'

const oracle = JSON.parse(readFileSync('src/tests/evidence/WO-2962/first-example-metrics.json', 'utf8'))

function ball(diameter = 3, fluteLength = 10): Tool {
  return {
    id: 'b3', name: `D${diameter} ball`, type: 'ball_end_mill', diameter, fluteLength,
    shankDiameter: diameter, overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300, depthOfCut: 0.15, stepover: 1 } },
  } as Tool
}

const heights: HeightParams = {
  clearanceHeight: 5, clearanceHeightMode: 'absolute', retractHeight: 1, feedHeight: 0.5,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -0.15, bottomHeightMode: 'absolute',
}

function circle(r: number, n = 4096): Array<{ x: number; y: number }> {
  return Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((2 * Math.PI * i) / n), y: r * Math.sin((2 * Math.PI * i) / n) }))
}

const rect = (w: number, h: number) => [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]

const ROSE_R = '(r0 - pitch * t / 360) * (1 + amp * sin(lobes * t))'

function roseSpec(over: { r0?: number; pitch?: number } = {}) {
  return {
    version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.15, chordTol: 0.005,
    curves: [{
      kind: 'polar', r: ROSE_R, t: [0, 5400],
      params: [
        { name: 'r0', value: over.r0 ?? 27.5, length: true }, { name: 'pitch', value: over.pitch ?? 1.6, length: true },
        { name: 'amp', value: 0.02, length: false }, { name: 'lobes', value: 9, length: false },
      ],
    }],
  }
}

function payload(spec: unknown, over: Partial<PatternWorkerPayload> = {}): PatternWorkerPayload {
  return {
    spec, tool: ball(), heights, wcsOrigin: { x: 0, y: 0, z: 0 }, region: [circle(30)],
    spindleRpm: 18000, machine: { maxCuttingFeed: 5000, minSpindleRpm: 6000, maxSpindleRpm: 24000 }, ...over,
  }
}

/** Split the cut moves into passes: each starts at a plunge. */
function passes(moves: ToolpathMove[]): ToolpathMove[][] {
  const out: ToolpathMove[][] = []
  for (const m of moves) {
    if (m.role === 'plunge') out.push([m])
    else if (m.role === 'cut') out[out.length - 1].push(m)
  }
  return out
}

function refusal(fn: () => unknown): PatternSpecError {
  try {
    fn()
  } catch (err) {
    if (err instanceof PatternSpecError) return err
    throw err
  }
  throw new Error('expected a refusal')
}

describe('WO-2982 A1 rose spiral (PLAN sec. 6)', () => {
  const result = buildPatternToolpath(payload(roseSpec()))
  const { moves, metrics, notes } = result

  it('C3 chord error <= chordTol by a probe 8x finer than the sampler, and the moves are those samples', () => {
    const curve = parsePatternSpec(roseSpec()).curves[0]
    const samples = sampleCurve(curve, 0.005)
    const at = curvePoint(curve)
    let worst = 0
    for (let i = 0; i + 1 < samples.length; i++) worst = Math.max(worst, chordDeviation(at, samples[i].t, samples[i + 1].t, 128))
    expect(worst).toBeLessThanOrEqual(0.005)
    const cut = passes(moves)[0]
    expect(cut.length).toBe(samples.length)
    cut.forEach((m, i) => {
      expect(m.x).toBe(samples[i].x)
      expect(m.y).toBe(samples[i].y)
    })
    // Same sampler aim as the oracle: a sample count within 2 % of its 2764.
    expect(Math.abs(samples.length - oracle.samples) / oracle.samples).toBeLessThan(0.02)
  })

  it('C4 every cut move at -0.15; exactly one plunge and one retract', () => {
    const cuts = moves.filter(m => m.role === 'cut' || m.role === 'plunge')
    expect(new Set(cuts.map(m => m.z))).toEqual(new Set([-0.15]))
    expect(moves.filter(m => m.role === 'plunge')).toHaveLength(1)
    const retracts = moves.filter((m, i) => i > 0 && m.type === 'rapid' && moves[i - 1].z < 0 && m.z > moves[i - 1].z)
    expect(retracts).toHaveLength(1)
  })

  it('C5 no rapid below retract; C6/C7 inside the machine, so no limit note', () => {
    expect(Math.min(...moves.filter(m => m.type === 'rapid').map(m => m.z))).toBe(1)
    expect(Math.max(...moves.map(m => m.feed ?? 0))).toBe(1200)
    expect(notes.join('\n')).not.toMatch(/caps it|raises it/)
  })

  it('C1 margin and C2 turn gap match the oracle', () => {
    expect(metrics.containmentMargin as number).toBeCloseTo(1.341, 1)
    expect(Math.abs((metrics.containmentMargin as number) - oracle.metrics.containmentMargin)).toBeLessThan(0.01)
    expect(Math.abs((metrics.minTurnGap as number) - 1.549)).toBeLessThan(0.01)
    expect(metrics.minRidge as number).toBeGreaterThan(0)
    expect(metrics.grooveWidth).toBeCloseTo(oracle.metrics.grooveWidth, 9)
  })

  it('C8 length within 1.5 mm of 1472.9 and within 0.1 % of a dense reference', () => {
    expect(Math.abs(metrics.cutLengthMm - 1472.9)).toBeLessThan(1.5)
    const at = curvePoint(parsePatternSpec(roseSpec()).curves[0])
    let ref = 0
    let prev = at(0)
    for (let i = 1; i <= 400_000; i++) {
      const p = at((5400 * i) / 400_000)
      ref += Math.hypot(p.x - prev.x, p.y - prev.y)
      prev = p
    }
    expect(Math.abs(metrics.cutLengthMm - ref) / ref).toBeLessThan(0.001)
  })

  it('says what it made in one line, with the sample count', () => {
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`${metrics.samples} points on 1 pass`)
  })

  it('is deterministic', () => {
    expect(JSON.stringify(buildPatternToolpath(payload(roseSpec())))).toBe(JSON.stringify(result))
  })
})

/** Distance from p to the emitted polyline, written here independently of the library. */
function polylineDistance(p: { x: number; y: number }, line: Array<{ x: number; y: number }>): number {
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    best = Math.min(best, Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y))
  }
  return best
}

describe('WO-2982 the emitted path follows the true curve (audit fix round 1)', () => {
  it('a curve that reverses along its own line is cut in full: X0 -> X40 -> X30, 50 mm', () => {
    const spec = {
      version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.1, chordTol: 0.005,
      curves: [{ kind: 'xy', x: '10 * t * (4 - t)', y: '0', t: [0, 3] }],
    }
    const { moves, metrics } = buildPatternToolpath(payload(spec, { region: [] }))
    const cut = passes(moves)[0]
    expect(Math.max(...cut.map(m => m.x))).toBeGreaterThan(40 - 0.005)
    expect(cut[cut.length - 1].x).toBeCloseTo(30, 9)
    expect(Math.abs(metrics.cutLengthMm - 50)).toBeLessThan(0.01)
  })

  it('dense probes along the true curve each lie within chordTol of the emitted polyline', () => {
    const cases: Array<{ name: string; spec: unknown; region?: Array<Array<{ x: number; y: number }>>; at: (t: number) => { x: number; y: number }; t: [number, number] }> = [
      { name: 'reversal', spec: { version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.1, curves: [{ kind: 'xy', x: '10 * t * (4 - t)', y: '0', t: [0, 3] }] },
        at: t => ({ x: 10 * t * (4 - t), y: 0 }), t: [0, 3] },
      { name: 'cusp', spec: { version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.1, curves: [{ kind: 'xy', x: 't * t', y: 't * t * t', t: [-2, 2] }] },
        at: t => ({ x: t * t, y: t * t * t }), t: [-2, 2] },
      { name: 'rose', spec: roseSpec(), region: [circle(30)],
        at: t => { const r = (27.5 - (1.6 * t) / 360) * (1 + 0.02 * Math.sin((9 * t * Math.PI) / 180)); return { x: r * Math.cos((t * Math.PI) / 180), y: r * Math.sin((t * Math.PI) / 180) } },
        t: [0, 5400] },
    ]
    for (const c of cases) {
      const line = passes(buildPatternToolpath(payload(c.spec, { region: c.region ?? [] })).moves)[0]
      let worst = 0
      for (let i = 0; i <= 20_000; i++) worst = Math.max(worst, polylineDistance(c.at(c.t[0] + ((c.t[1] - c.t[0]) * i) / 20_000), line))
      expect(worst, c.name).toBeLessThanOrEqual(0.005)
    }
  })
})

describe('WO-2982 A2 sine raster clipped to a 40x30 rectangle', () => {
  const spec = {
    version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.15, clip: 'region',
    curves: [{ kind: 'preset', name: 'sine-raster', params: { width: 50, height: 24, spacing: 3, amplitude: 1, wavelength: 10 } }],
  }
  const region = [rect(40, 30)]
  const { moves, notes, metrics } = buildPatternToolpath(payload(spec, { region }))
  const hw = metrics.grooveWidth / 2

  it('no footprint point outside the rectangle, and the trimming is reported', () => {
    for (const m of moves.filter(mv => mv.role === 'cut' || mv.role === 'plunge')) {
      expect(insideDistance(m, region) - hw).toBeGreaterThanOrEqual(-1e-9)
    }
    expect(metrics.containmentMargin as number).toBeGreaterThanOrEqual(-1e-9)
    expect(notes.some(n => n.startsWith('Trimmed'))).toBe(true)
  })

  it('every line is trimmed only at its ends and keeps its amplitude', () => {
    const lines = passes(moves)
    expect(lines).toHaveLength(9)
    lines.forEach((line, i) => {
      const c = -12 + 3 * i
      const ys = line.map(m => m.y - c)
      expect(Math.max(...ys)).toBeCloseTo(1, 3)
      expect(Math.min(...ys)).toBeCloseTo(-1, 3)
      const xs = line.map(m => m.x)
      expect(Math.min(...xs)).toBeCloseTo(-20 + hw, 6)
      expect(Math.max(...xs)).toBeCloseTo(20 - hw, 6)
    })
    // Boustrophedon: consecutive lines run in opposite directions.
    expect(Math.sign(lines[0][1].x - lines[0][0].x)).toBe(-Math.sign(lines[1][1].x - lines[1][0].x))
  })
})

/** Smallest (inside distance - half-width) along every emitted cut move, probed 400x per move. */
function worstCutMargin(moves: ToolpathMove[], region: Array<Array<{ x: number; y: number }>>, hw: number): number {
  let worst = Infinity
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i]
    if (m.role !== 'cut') continue
    const p = moves[i - 1]
    for (let k = 0; k <= 400; k++) {
      const q = { x: p.x + ((m.x - p.x) * k) / 400, y: p.y + ((m.y - p.y) * k) / 400 }
      worst = Math.min(worst, insideDistance(q, region) - hw)
    }
  }
  return worst
}

describe('WO-2982 clip and C1 judge the cut segments, not just the samples (pre-audit round 1)', () => {
  const holed = [rect(60, 60), rect(10, 10)]
  const hw = Math.sqrt(0.15 * (3 - 0.15))

  it('a clipped moire never cuts into a hole in the region', () => {
    const spec = {
      version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.15, clip: 'region',
      curves: [{ kind: 'preset', name: 'line-moire', params: { width: 70, height: 56, spacing: 2, angle: 5 } }],
    }
    const { moves, metrics } = buildPatternToolpath(payload(spec, { region: holed }))
    expect(worstCutMargin(moves, holed, hw)).toBeGreaterThanOrEqual(-1e-9)
    expect(metrics.containmentMargin as number).toBeGreaterThanOrEqual(-1e-9)
    // The line through y = 0 is split around the hole, not dropped.
    const zeroLine = passes(moves).filter(p => p.every(m => Math.abs(m.y) < 1e-9))
    expect(zeroLine).toHaveLength(2)
  })

  it('an unclipped straight line through the hole reports its true overshoot', () => {
    const spec = { version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.15, curves: [{ kind: 'xy', x: 't', y: '0', t: [-25, 25] }] }
    const { notes, metrics } = buildPatternToolpath(payload(spec, { region: holed }))
    expect(metrics.containmentMargin as number).toBeCloseTo(-(5 + hw), 2)
    expect(notes).toContain(`The cut reaches ${(5 + hw).toFixed(3)} mm past the region edge; made as written.`)
  })

  it('a concave (L-shaped) region keeps every line part that fits', () => {
    const L = [[{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 40 }, { x: 0, y: 40 }]]
    const spec = {
      version: 1, units: 'mm', anchor: { x: 20, y: 20 }, depth: 0.15, clip: 'region',
      curves: [{ kind: 'preset', name: 'sine-raster', params: { width: 200, height: 36, spacing: 3, amplitude: 0 } }],
    }
    const { moves } = buildPatternToolpath(payload(spec, { region: L }))
    expect(worstCutMargin(moves, L, hw)).toBeGreaterThanOrEqual(-1e-9)
    const lines = passes(moves)
    expect(lines.map(l => l[0].y).sort((a, b) => a - b)).toEqual([2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38])
    for (const line of lines) {
      const xs = line.map(m => m.x)
      expect(Math.min(...xs)).toBeCloseTo(hw, 6)
      expect(Math.max(...xs)).toBeCloseTo(line[0].y < 10 ? 40 - hw : 10 - hw, 6)
      // The whole pass is kept, not only its ends: one unbroken straight cut at its own y.
      expect(line.every(m => m.y === line[0].y)).toBe(true)
      let len = 0
      for (let i = 1; i < line.length; i++) len += Math.abs(line[i].x - line[i - 1].x)
      expect(len).toBeCloseTo(Math.max(...xs) - Math.min(...xs), 6)
    }
  })
})

describe('WO-2982 A3 polar array', () => {
  it('6 copies of a petal; copy k equals copy 0 rotated k*60 deg to 1e-9', () => {
    const spec = {
      version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.1,
      curves: [{ kind: 'polar', r: '12 * sin(3 * t)', t: [0, 60], transforms: [{ kind: 'polar-array', count: 6 }] }],
    }
    const copies = passes(buildPatternToolpath(payload(spec)).moves)
    expect(copies).toHaveLength(6)
    copies.forEach((copy, k) => {
      expect(copy.length).toBe(copies[0].length)
      const a = (k * 60 * Math.PI) / 180
      copy.forEach((m, i) => {
        const p = copies[0][i]
        expect(Math.abs(m.x - (p.x * Math.cos(a) - p.y * Math.sin(a)))).toBeLessThan(1e-9)
        expect(Math.abs(m.y - (p.x * Math.sin(a) + p.y * Math.cos(a)))).toBeLessThan(1e-9)
      })
    })
  })

  it('transforms apply in listed order and a scale keeps the chord tolerance', () => {
    const base = { version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.1, chordTol: 0.01 }
    const curve = { kind: 'polar', r: '5', t: [0, 90] }
    const tr = (transforms: unknown[]) => passes(buildPatternToolpath(payload({ ...base, curves: [{ ...curve, transforms }] })).moves)[0]
    const rt = tr([{ kind: 'rotate', deg: 90 }, { kind: 'translate', dx: 10, dy: 0 }])
    const trr = tr([{ kind: 'translate', dx: 10, dy: 0 }, { kind: 'rotate', deg: 90 }])
    expect(rt[0].x).toBeCloseTo(10, 9)
    expect(rt[0].y).toBeCloseTo(5, 9)
    expect(trr[0].x).toBeCloseTo(0, 9)
    expect(trr[0].y).toBeCloseTo(15, 9)
    const scaled = tr([{ kind: 'scale', s: 4 }])
    for (let i = 1; i < scaled.length; i++) {
      const chordMid = Math.hypot((scaled[i - 1].x + scaled[i].x) / 2, (scaled[i - 1].y + scaled[i].y) / 2)
      expect(20 - chordMid).toBeLessThanOrEqual(0.01)
    }
    const mirrored = tr([{ kind: 'mirror', axis: 'x' }])
    expect(mirrored[mirrored.length - 1].y).toBeCloseTo(-5, 9)
  })
})

describe('WO-2982 A4 inch spec', () => {
  it('A1 written in inches equals the mm result to 1e-9', () => {
    const inch = roseSpec({ r0: 27.5 / 25.4, pitch: 1.6 / 25.4 })
    const spec = { ...inch, units: 'in', depth: 0.15 / 25.4, chordTol: 0.005 / 25.4 }
    const a = buildPatternToolpath(payload(roseSpec())).moves
    const b = buildPatternToolpath(payload(spec)).moves
    expect(b.length).toBe(a.length)
    a.forEach((m, i) => {
      expect(Math.abs(b[i].x - m.x)).toBeLessThan(1e-9)
      expect(Math.abs(b[i].y - m.y)).toBeLessThan(1e-9)
      expect(Math.abs(b[i].z - m.z)).toBeLessThan(1e-9)
    })
  })

  it('ratios never scale; an anchor and translate in inches do', () => {
    const spec = {
      version: 1, units: 'in', anchor: { x: 1, y: 0 }, depth: 0.004,
      curves: [{ kind: 'xy', x: 't', y: 'k * t', t: [0, 10], params: [{ name: 'k', value: 2, length: false }],
        transforms: [{ kind: 'translate', dx: 0, dy: 1 }] }],
    }
    const cut = passes(buildPatternToolpath(payload(spec, { region: [] })).moves)[0]
    expect(cut[0].x).toBeCloseTo(25.4, 9)
    expect(cut[0].y).toBeCloseTo(25.4, 9)
    const last = cut[cut.length - 1]
    expect(last.y - 25.4).toBeCloseTo(2 * (last.x - 25.4), 9)
  })
})

describe('WO-2982 negatives', () => {
  it('N1 exp2(t) is refused with its position', () => {
    const spec = { ...roseSpec(), curves: [{ kind: 'polar', r: '10 + exp2(t)', t: [0, 360] }] }
    const err = refusal(() => buildPatternToolpath(payload(spec)))
    expect(err.diagnostic).toMatchObject({ code: 'PATTERN_UNKNOWN_FUNCTION', path: 'curves[0].r', pos: 5, snippet: 'exp2' })
    expect(err.message).toContain('position 5')
  })

  it('N1b unknown names are refused with their position (only t and the curve params resolve)', () => {
    for (const [r, name, pos] of [['r0 + foo', 'foo', 5], ['process', 'process', 0], ['t * x', 'x', 4]] as const) {
      const spec = { ...roseSpec(), curves: [{ kind: 'polar', r, t: [0, 360], params: [{ name: 'r0', value: 1, length: true }] }] }
      const err = refusal(() => parsePatternSpec(spec))
      expect(err.diagnostic).toMatchObject({ code: 'PATTERN_UNKNOWN_NAME', pos, snippet: name })
    }
    const syntax = refusal(() => parsePatternSpec({ ...roseSpec(), curves: [{ kind: 'polar', r: '1 +', t: [0, 1] }] }))
    expect(syntax.diagnostic.code).toBe('PATTERN_SYNTAX_ERROR')
  })

  it('N2 a 1000-turn spiral is made (no size refusal) and its note states the sample count', () => {
    const spec = {
      version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.02, chordTol: 0.05,
      curves: [{ kind: 'polar', r: '2 + 0.05 * t / 360', t: [0, 360_000] }],
    }
    const vbit = { ...ball(), type: 'v_bit', angleFromAxisDeg: 45 } as Tool
    const { moves, notes, metrics } = buildPatternToolpath(payload(spec, { tool: vbit, region: [] }))
    expect(metrics.samples).toBeGreaterThan(50_000)
    expect(moves.filter(m => m.role === 'cut')).toHaveLength(metrics.samples - 1)
    expect(notes[0]).toContain(`${metrics.samples} points`)
  }, 120_000)

  it('N3 sqrt of a negative is refused naming the t', () => {
    const spec = { ...roseSpec(), curves: [{ kind: 'polar', r: 'sqrt(90 - t)', t: [0, 180] }] }
    const err = refusal(() => buildPatternToolpath(payload(spec)))
    expect(err.diagnostic).toMatchObject({ code: 'PATTERN_NON_FINITE', path: 'curves[0].r' })
    const t = Number(/at t = ([0-9.]+)/.exec(err.message)?.[1])
    expect(t).toBeGreaterThan(90)
    expect(t).toBeLessThanOrEqual(180)
  })

  it('N4 pitch 1.2 makes the path and reports ridge -0.139', () => {
    const { moves, notes, metrics } = buildPatternToolpath(payload(roseSpec({ pitch: 1.2 })))
    expect(moves.length).toBeGreaterThan(1000)
    expect(Math.abs((metrics.minRidge as number) - oracle.negativeControls['pitch 1.2 (grooves merge)'].minRidge)).toBeLessThan(0.01)
    expect(notes.some(n => /ridge -0\.1[34]\d mm/.test(n) && n.includes('made as written'))).toBe(true)
    expect(notes.some(n => n.includes('past the region edge'))).toBe(false)
  })

  it('N5 r0 29 makes the path and reports the 0.189 mm overshoot', () => {
    const { moves, notes, metrics } = buildPatternToolpath(payload(roseSpec({ r0: 29 })))
    expect(moves.length).toBeGreaterThan(1000)
    expect(Math.abs((metrics.containmentMargin as number) - oracle.negativeControls['r0 29 (cutter leaves region)'].containmentMargin)).toBeLessThan(0.01)
    expect(notes.some(n => /reaches 0\.1[89]\d mm past the region edge; made as written/.test(n))).toBe(true)
    expect(notes.some(n => n.includes('ridge'))).toBe(false)
  })

  it('N6 depth past flute reach is refused by the existing check', () => {
    expect(() => buildPatternToolpath(payload(roseSpec(), { tool: ball(3, 0.1) }))).toThrow(/Pattern: requested axial depth 0\.150 mm exceeds available flute length 0\.100 mm/)
  })

  it('N7 a gcode key is refused as an unknown key, at any level', () => {
    const top = refusal(() => parsePatternSpec({ ...roseSpec(), gcode: 'M3 S1000' }))
    expect(top.diagnostic).toMatchObject({ code: 'PATTERN_UNKNOWN_KEY', path: 'gcode' })
    const inner = refusal(() => parsePatternSpec({ ...roseSpec(), curves: [{ ...roseSpec().curves[0], mcode: 'M8' }] }))
    expect(inner.diagnostic).toMatchObject({ code: 'PATTERN_UNKNOWN_KEY', path: 'curves[0].mcode' })
    const tr = refusal(() => parsePatternSpec({ ...roseSpec(), curves: [{ ...roseSpec().curves[0], transforms: [{ kind: 'rotate', deg: 1, file: 'x' }] }] }))
    expect(tr.diagnostic.path).toBe('curves[0].transforms[0].file')
  })
})

describe('WO-2982 C6/C7 machine limits are reported, never refused', () => {
  it('F6000 over a 5000 machine: made at F6000 and reported', () => {
    const { moves, notes } = buildPatternToolpath(payload(roseSpec(), {
      feedrateOverride: { enabled: true, feedRate: 6000, plungeRate: 300 } as PatternWorkerPayload['feedrateOverride'],
    }))
    expect(Math.max(...moves.map(m => m.feed ?? 0))).toBe(6000)
    expect(notes).toContain("Cutting feed F6000 is above this machine's 5000 mm/min; the controller caps it.")
  })

  it('30 000 rpm over a 24 000 machine is reported; no stated limit, nothing measured', () => {
    expect(buildPatternToolpath(payload(roseSpec(), { spindleRpm: 30000 })).notes)
      .toContain("Spindle 30000 rpm is above this machine's 24000 rpm; the controller caps it.")
    expect(buildPatternToolpath(payload(roseSpec(), { spindleRpm: 30000, machine: {} })).notes).toHaveLength(1)
  })
})

describe('WO-2982 depth expressions and presets', () => {
  it('a depth expression in x, y, t sets each cut Z below the top', () => {
    const spec = {
      version: 1, units: 'mm', anchor: { x: 2, y: 0 }, depth: { expr: '0.1 + 0.01 * x' },
      curves: [{ kind: 'xy', x: 't', y: '0', t: [0, 10] }],
    }
    const cut = buildPatternToolpath(payload(spec, { wcsOrigin: { x: 100, y: 0, z: 3 } })).moves
      .filter(m => m.role === 'cut' || m.role === 'plunge')
    for (const m of cut) expect(m.z).toBeCloseTo(3 - (0.1 + 0.01 * (m.x - 100)), 9)
  })

  it('every preset builds, and unknown preset params are refused', () => {
    for (const name of ['rose-spiral', 'sine-raster', 'epitrochoid', 'line-moire']) {
      const spec = { version: 1, units: 'mm', anchor: 'region-centroid', depth: 0.1, clip: 'region', curves: [{ kind: 'preset', name, params: {} }] }
      const { moves } = buildPatternToolpath(payload(spec, { region: [circle(40, 512)] }))
      expect(moves.length, name).toBeGreaterThan(10)
    }
    const err = refusal(() => parsePatternSpec({ ...roseSpec(), curves: [{ kind: 'preset', name: 'rose-spiral', params: { gcode: 1 } }] }))
    expect(err.diagnostic).toMatchObject({ code: 'PATTERN_UNKNOWN_KEY', path: 'curves[0].params.gcode' })
  })

  it('region-centroid or clip without a region is refused (nothing to measure against)', () => {
    const spec = { ...roseSpec(), anchor: 'region-centroid' }
    expect(refusal(() => buildPatternToolpath(payload(spec, { region: [] }))).diagnostic.code).toBe('PATTERN_NO_REGION')
    const clip = { ...roseSpec(), clip: 'region' }
    expect(refusal(() => buildPatternToolpath(payload(clip, { region: [] }))).diagnostic).toMatchObject({ code: 'PATTERN_NO_REGION', path: 'clip' })
  })

  it('zero or negative preset turns are made, not refused (Rule 11)', () => {
    const turns = (n: number) => buildPatternToolpath(payload({ ...roseSpec(), curves: [{ kind: 'preset', name: 'rose-spiral', params: { turns: n } }] }))
    expect(turns(0).notes[0]).toContain('nothing to cut')
    expect(turns(-2).moves.length).toBeGreaterThan(10)
  })

  it('an inherited name is not a preset', () => {
    for (const name of ['toString', 'constructor', '__proto__']) {
      expect(refusal(() => parsePatternSpec({ ...roseSpec(), curves: [{ kind: 'preset', name, params: {} }] })).diagnostic.path).toBe('curves[0].name')
    }
  })
})

describe('WO-3001 sine raster with no amplitude (WO-2982 audit carry-over)', () => {
  const raster = (params: Record<string, number>) => ({
    version: 1, units: 'mm', anchor: 'wcs-origin', depth: 0.15,
    curves: [{ kind: 'preset', name: 'sine-raster', params: { width: 40, height: 12, spacing: 3, ...params } }],
  })

  it('amplitude 0 with wavelength 0 is the straight raster, the same as amplitude 0 at any wavelength', () => {
    const flat = buildPatternToolpath(payload(raster({ amplitude: 0, wavelength: 0 })))
    const reference = buildPatternToolpath(payload(raster({ amplitude: 0, wavelength: 10 })))
    expect(flat.moves).toEqual(reference.moves)
    const lines = passes(flat.moves)
    expect(lines.map(l => l[0].y)).toEqual([-6, -3, 0, 3, 6])
    for (const line of lines) expect(line.every(m => m.y === line[0].y)).toBe(true)
  })

  it('a wave with zero wavelength is still refused, naming the field', () => {
    expect(refusal(() => parsePatternSpec(raster({ amplitude: 1, wavelength: 0 }))).diagnostic.path)
      .toBe('curves[0].params.wavelength')
  })
})
