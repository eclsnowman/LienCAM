// WO-3038 (alpha.3 A3-07): the kernel medial-axis service at parity with today's V-carve axis.
//
// Oracle: today's engine, untouched. A shadow on today's axis (src/lib/cam/vcarve2d/medialAxis.ts)
// records every call the V-carve routes make, with its input, options and output:
//   - production: the store's compute through the real toolpath worker (heightScenario.ts,
//     the WO-1604..1622 harness) on drawn sketches, and the ex05 name-sign V-carve step of the
//     alpha.3 stick (A.5 rows, default and declared parameters) through planChain;
//   - controls: today's V-carve fixtures (src/tests/cam/vcarve2d.test.ts and
//     vcarve2d.medialAxis.test.ts shapes) through the engine and the axis directly.
// Each recorded call is replayed through the kernel and must give today's chains exactly:
// every vertex, every edge (chain order) and every radius. Then every route runs again with
// the kernel's axis substituted for today's and must give today's program exactly.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { AxisPath, MedialAxisOptions, Region } from '../../lib/cam/vcarve2d/medialAxis'

interface AxisCall { route: string; region: Region; opts: MedialAxisOptions; out: AxisPath[] }
const rec = vi.hoisted(() => ({ route: '', substitute: false, calls: [] as AxisCall[], substituted: 0 }))

vi.mock('../../lib/cam/vcarve2d/medialAxis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/vcarve2d/medialAxis')>()
  const { createMedialService } = await import('../../kernel/medial')
  const service = createMedialService()
  return typedMock<typeof import('../../lib/cam/vcarve2d/medialAxis')>({
    ...actual,
    medialAxis: (region, opts) => {
      if (rec.substitute) { rec.substituted++; return service.axis(region, opts) }
      const input = structuredClone(region)
      const options = { ...opts }
      const out = actual.medialAxis(region, opts)
      rec.calls.push({ route: rec.route, region: input, opts: options, out: structuredClone(out) })
      return out
    },
  })
})

import { circleLoop, installRealToolpathWorker, rectLoop, runHeightScenario, type HeightScenario, type ScenarioLoop } from '../helpers/heightScenario'
import { planChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/registry'
import { buildVCarveToolpath, ensureVCarveClipperReady, buildRegions } from '../../lib/cam/vcarve2d'
import { medialAxis } from '../../lib/cam/vcarve2d/medialAxis'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { outlineTextToContours } from '../../lib/sketch/textOutline'
import type { VCarveParams, VCarveWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'
import * as kernel from '../../kernel/medial'

installRealToolpathWorker()

const EVIDENCE = 'src/tests/evidence/WO-3038/parity.json'

// ─── production: the store through the real worker ────────────────────────────

const RAISE = 50
const AUTO_STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 }
// A T: its stem's spur and the bar's corners give the filters work on the production route.
const T_LOOP: ScenarioLoop = { id: 'tee', points: [
  { x: 5, y: 30 }, { x: 21, y: 30 }, { x: 21, y: 5 }, { x: 29, y: 5 }, { x: 29, y: 30 },
  { x: 45, y: 30 }, { x: 45, y: 38 }, { x: 5, y: 38 },
] }
const sketch = (loops: ScenarioLoop[], picks: string[], extra: Partial<HeightScenario> = {}): HeightScenario => ({
  part: { kind: 'sketch_2d', loops, z: RAISE }, stock: AUTO_STOCK, operation: 'vcarve', loopIds: picks, ...extra,
})
const POCKET = rectLoop('pocket', 15, 10, 35, 30)
const FRAME = rectLoop('frame', 60, 0, 100, 30)
const FRAME_HOLE = circleLoop('frameHole', 80, 15, 6)
const DISC = circleLoop('disc', 120, 15, 4)
const SCENARIOS: Array<[string, HeightScenario]> = [
  ['rectangle, tool limit', sketch([POCKET], ['pocket'])],
  ['rectangle, flat depth 1', sketch([POCKET], ['pocket'], { datumFormula: { depthMm: 1 } })],
  ['tee', sketch([T_LOOP], ['tee'])],
  ['frame with a round island', sketch([FRAME, FRAME_HOLE], ['frame', 'frameHole'])],
  ['frame with a round island, flat depth 0.5', sketch([FRAME, FRAME_HOLE], ['frame', 'frameHole'], { datumFormula: { depthMm: 0.5 } })],
  ['lone disc', sketch([DISC], ['disc'])],
]

// ─── controls: today's V-carve fixtures through the engine ─────────────────────

function vbit(over: Partial<Tool> = {}): Tool {
  return {
    id: 'v90', name: '90 deg V-bit', type: 'v_bit',
    diameter: 12, fluteLength: 10, shankDiameter: 6, overallLength: 50,
    angleFromAxisDeg: 45, tipDiameter: 0,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300 } },
    ...over,
  } as unknown as Tool
}
const endMill = (diameter: number): Tool => ({
  id: `em${diameter}`, name: `${diameter} mm end mill`, type: 'flat_end_mill',
  diameter, fluteLength: 12, shankDiameter: diameter, overallLength: 40,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1500, plungeRate: 400 } },
}) as unknown as Tool
const heights = (top = 0, maxDepth = 6): HeightParams => ({
  clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 2,
  topHeight: top, topHeightMode: 'absolute', bottomHeight: top - maxDepth, bottomHeightMode: 'absolute',
}) as HeightParams
const passes = (stepdown = 0): PassParams => ({ stepdown, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }) as PassParams
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const params = (over: Partial<VCarveParams> = {}): VCarveParams => ({
  geometryId: 'g', loopIds: [], role: 'carve', flatDepthMm: undefined, startDepthMm: 0, allowanceMm: 0,
  flatClearing: { mode: 'vbit', stepoverMm: 0.5 }, tolerance: 0.01, ...over,
})
const loop = (id: string, points: Array<{ x: number; y: number }>): LoopData => ({ id, closed: true, type: 'closed', points })
const rect = (id: string, w: number, h: number, x0 = 0, y0 = 0): LoopData =>
  loop(id, [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }])
const circle = (id: string, r: number, n = 180, cx = 0, cy = 0): LoopData =>
  loop(id, Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) })))
const text = (s: string, height: number): LoopData[] => outlineTextToContours(s, height).map((c, i) => loop(`t${i}`, c.points))
const payload = (over: Partial<VCarveWorkerPayload> = {}): VCarveWorkerPayload => ({
  opId: 'op', setupId: 'setup', params: params(), heights: heights(), passes: passes(), linking,
  tool: vbit(), loops: [rect('r', 40, 10)], wcsOrigin: { x: 0, y: 0, z: 0 }, ...over,
})
const FIXTURES: Array<[string, () => VCarveWorkerPayload]> = [
  ['rectangle 40 x 10', () => payload()],
  ['60 deg bit', () => payload({ tool: vbit({ angleFromAxisDeg: 30 }) })],
  ['tip flat 0.5', () => payload({ tool: vbit({ tipDiameter: 0.5 }) })],
  ['flat depth 2, V-bit clears', () => payload({ params: params({ flatDepthMm: 2 }), heights: heights(0, 2) })],
  ['flat depth 2, no clearing', () => payload({ params: params({ flatDepthMm: 2, flatClearing: { mode: 'none', stepoverMm: 0.5 } }), heights: heights(0, 2) })],
  ['flat depth 2, clearing tool 4', () => payload({ params: params({ flatDepthMm: 2, flatClearing: { mode: 'tool', clearingToolDiameter: 4, stepoverMm: 0.5 } }), heights: heights(0, 2) })],
  ['flat-clearing role', () => payload({ tool: endMill(4), params: params({ role: 'flat_clearing', vbit: { angleFromAxisDeg: 45, tipDiameter: 0 } }), heights: heights(0, 2) })],
  ['8 mm bit at its limit', () => payload({ tool: vbit({ diameter: 8 }), heights: heights(0, 4) })],
  ['stepdown 1, flat depth 3', () => payload({ params: params({ flatDepthMm: 3 }), heights: heights(0, 3), passes: passes(1) })],
  ['word LienCAM', () => payload({ loops: text('LienCAM', 25), heights: heights(0, 6) })],
  ['letter O', () => payload({ loops: text('O', 20), heights: heights(0, 6) })],
  ['overlapping outlines welded', () => payload({ loops: [rect('a', 20, 10), rect('b', 10, 20, 15, -5)] })],
  ['allowance 0.3', () => payload({ params: params({ allowanceMm: 0.3 }) })],
  ['thin strip under the tip flat', () => payload({ tool: vbit({ tipDiameter: 1 }), loops: [rect('thin', 40, 0.4)] })],
  ['lone small circle under the tip flat', () => payload({ tool: vbit({ tipDiameter: 1 }), loops: [circle('dot', 0.3, 48, 5, 5)] })],
]
// The axis fixtures of vcarve2d.medialAxis.test.ts, called directly.
const asRegion = (l: LoopData, holes: LoopData[] = []): Region => ({ outer: l.points, holes: holes.map(h => [...h.points].reverse()) })
const AXIS_FIXTURES: Array<[string, () => { region: Region; opts: MedialAxisOptions }]> = [
  ['rectangle 40 x 10 at 0.1', () => ({ region: asRegion(rect('r', 40, 10)), opts: { spacing: 0.1 } })],
  ['disc r 10', () => ({ region: asRegion(circle('c', 10)), opts: { spacing: 0.1 } })],
  ['annulus 10 / 5', () => ({ region: asRegion(circle('o', 10), [circle('i', 5)]), opts: { spacing: 0.1 } })],
  ['font O', () => ({ region: buildRegions(text('O', 20).map(l => l.points))[0], opts: { spacing: 0.1 } })],
  ['font A', () => ({ region: buildRegions(text('A', 20).map(l => l.points))[0], opts: { spacing: 0.1 } })],
  ['rectangle, explicit options', () => ({ region: asRegion(rect('r', 30, 12)), opts: { spacing: 0.2, pruneLength: 1, simplifyTolerance: 0, cornerAngleDeg: 60 } })],
]

// ─── the runs ─────────────────────────────────────────────────────────────────

type Program = { moves?: string; error?: string; summary: string }
const today = new Map<string, Program>()
const substituted = new Map<string, Program>()

async function runAll(into: Map<string, Program>): Promise<void> {
  for (const [label, scenario] of SCENARIOS) {
    rec.route = `scenario: ${label}`
    const reading = await runHeightScenario(scenario)
    const error = reading.errorMessage ?? reading.authoringError
    into.set(rec.route, { moves: JSON.stringify(reading.moves), error, summary: `${reading.status}, ${reading.moves.length} moves${error ? `: ${error}` : ''}` })
  }
  for (const chain of alpha3Chains().filter(c => c.id.startsWith('ex05-name-sign'))) {
    const carve = { ...chain, steps: chain.steps.filter(step => step.type === 'vcarve') }
    rec.route = `stick: ${chain.id}`
    const planned = await planChain(carve)
    into.set(rec.route, { moves: JSON.stringify(planned.steps.map(s => [s.stepId, s.status, s.moves])),
      summary: planned.steps.map(s => `${s.stepId} ${s.status}, ${s.moves.length} moves`).join('; ') })
  }
  for (const [label, make] of FIXTURES) {
    rec.route = `fixture: ${label}`
    try {
      const moves = buildVCarveToolpath(make())
      into.set(rec.route, { moves: JSON.stringify(moves), summary: `${moves.length} moves` })
    } catch (error) { into.set(rec.route, { error: (error as Error).message, summary: `refused: ${(error as Error).message}` }) }
  }
  for (const [label, make] of AXIS_FIXTURES) {
    rec.route = `axis: ${label}`
    const { region, opts } = make()
    const paths = medialAxis(region, opts)
    into.set(rec.route, { moves: JSON.stringify(paths), summary: `${paths.length} chains` })
  }
}

beforeAll(async () => { await Promise.all([ensureVCarveClipperReady(), ensureClipperReady()]) })

const service = kernel.createMedialService()

describe('WO-3038 kernel medial axis at parity with today', () => {
  // The worker shim is installed per test (heightScenario.ts), so the runs are a test of their own.
  it('runs every route on today\'s axis, then again with the kernel axis substituted', async () => {
    rec.substitute = false
    await runAll(today)
    rec.substitute = true
    try { await runAll(substituted) } finally { rec.substitute = false }
    expect(substituted.size).toBe(today.size)
  }, 1_200_000)

  it('every route made recorded calls to today\'s axis', () => {
    const routes = [...today.keys()]
    const silent = routes.filter(route => !route.endsWith('under the tip flat') && !route.startsWith('fixture: flat-clearing role') &&
      !rec.calls.some(call => call.route === route))
    expect(silent).toEqual([])
    expect(routes.filter(r => r.startsWith('stick: '))).toEqual(['stick: ex05-name-sign-default', 'stick: ex05-name-sign-declared'])
    // The A.5 rows and the sketch scenarios did carve: every production V-carve is ready with moves.
    for (const route of routes.filter(r => r.startsWith('stick: '))) {
      expect(rec.calls.filter(c => c.route === route).length, route).toBeGreaterThan(10)
      expect(today.get(route)!.summary, route).toMatch(/^[^;]*vcarve ready, [1-9]\d* moves$/)
    }
    for (const route of routes.filter(r => r.startsWith('scenario: '))) expect(today.get(route)!.summary, route).toMatch(/^ready, [1-9]\d* moves$/)
  })

  it('kernel axis equals today\'s on every recorded call: every vertex, edge and radius', () => {
    const mismatches: string[] = []
    let vertices = 0
    for (const [index, call] of rec.calls.entries()) {
      const out = service.axis(call.region, call.opts)
      vertices += call.out.reduce((n, p) => n + p.points.length, 0)
      if (JSON.stringify(out) !== JSON.stringify(call.out)) {
        const got = out.reduce((n, p) => n + p.points.length, 0), want = call.out.reduce((n, p) => n + p.points.length, 0)
        mismatches.push(`${index} ${call.route}: ${out.length}/${call.out.length} chains, ${got}/${want} vertices`)
      }
    }
    if (process.env.WO3038_WRITE_EVIDENCE) writeFileSync(EVIDENCE, JSON.stringify({
      order: 'WO-3038', kind: 'parity', recordedCalls: rec.calls.length, vertices,
      routes: [...today.keys()].map(route => ({ route, calls: rec.calls.filter(c => c.route === route).length,
        chains: rec.calls.filter(c => c.route === route).reduce((n, c) => n + c.out.length, 0),
        program: today.get(route)!.summary })),
    }, null, 1) + '\n')
    expect(rec.calls.length).toBeGreaterThan(50)
    expect(vertices).toBeGreaterThan(1000)
    expect(mismatches.slice(0, 20)).toEqual([])
  })

  it('every V-carve program is unchanged with the kernel axis substituted for today\'s', () => {
    expect(rec.substituted).toBe(rec.calls.length)
    const changed = [...today.entries()].filter(([route, program]) => JSON.stringify(substituted.get(route)) !== JSON.stringify(program)).map(([route]) => route)
    expect(changed).toEqual([])
  })

  it('a lone small circle gives today\'s result at parity: refused with nothing cut, MD-112 off', () => {
    const route = 'fixture: lone small circle under the tip flat'
    expect(today.get(route)).toEqual({ error: expect.stringMatching(/cannot enter/), summary: expect.stringMatching(/^refused: /) })
    expect(substituted.get(route)).toEqual(today.get(route))
    const dot = rec.calls.filter(c => c.route === route)
    expect(dot).toHaveLength(1)
    // Today's axis of the dot is one point; the kernel reads it as one point site and attaches no motion.
    expect(dot[0].out).toHaveLength(1)
    expect(dot[0].out[0].points).toHaveLength(1)
    const analysed = service.analyse(dot[0].region, dot[0].opts)
    expect(analysed.paths).toEqual(dot[0].out)
    expect(analysed.pointSites).toEqual([dot[0].out[0].points[0]])
    expect(service.policy).toEqual(kernel.PARITY_MEDIAL_POLICY)
  })
})

describe('WO-3038 parameter table cites today\'s numbers', () => {
  // The literal each cited line holds today; the value must be that literal's number.
  const LITERALS: Record<kernel.MedialParameterName, string> = {
    minSpacing: 'Math.max(1e-3, opts.spacing)', normalizeEps: 'eps = 1e-9', minContourVertices: 'out.length >= 3',
    convexCrossEps: 'cross > 1e-12', circumcircleDegenerate: '< 1e-14', gridCellPerSpacing: 'spacing * 8',
    gridCellMin: 'spacing * 8, 0.5', onBoundaryPerSpacing: 'spacing * 1e-3', cornerAngleDeg: '?? 40',
    pruneLengthPerSpacing: '3 * spacing', peelGuard: '100_000', pruneGuard: '10_000', simplifyPerSpacing: 'spacing / 4',
    dedupeEps: '< 1e-9', carveSpacingMin: 'Math.max(0.05,', carveSpacingMax: 'Math.min(0.5,', carveSpacingPerTolerance: 'tol * 8',
    sampleBudget: '/ 60_000', floorCoreSpacingPerStepover: 'stepover / 4',
  }
  const NUMBERS: Record<string, number> = { '/ 4': 0.25 }
  it.each(Object.entries(LITERALS))('%s', (name, literal) => {
    const row = kernel.MEDIAL_PARAMETERS[name as kernel.MedialParameterName]
    const [file, lines] = row.source.split(':')
    const text = readFileSync(file, 'utf8').split('\n')
    const line = text[Number(lines.split(',')[0]) - 1]
    expect(line, `${row.source}`).toContain(literal)
    const quoted = Object.entries(NUMBERS).find(([k]) => literal.endsWith(k))?.[1]
      ?? Number(/(\d[\d_.e-]*)(?!.*\d)/.exec(literal)![1].replace(/_/g, ''))
    expect(row.value).toBe(quoted)
  })
})

describe('WO-3038 nothing in the app calls the service yet', () => {
  it('no app source outside src/kernel/medial imports it', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) return path === 'src/tests' || path === 'src/kernel/medial' ? [] : walk(path)
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
    })
    const sources = walk('src')
    expect(sources.length).toBeGreaterThan(500)
    expect(sources.filter(path => /kernel\/medial|['"]\.\/medial['"/]|['"]\.\.\/medial['"/]/.test(readFileSync(path, 'utf8')))).toEqual([])
  })
})
