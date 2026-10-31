import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Project, ToolpathMove } from '../../types'
import { defaultACParams, defaultHeights, defaultPasses, defaultLinking } from '../../kernel/parameterDefaults'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { alpha3Chains } from './alpha3Registry'
import { chainScene, planChain } from './chainRunner'
import { adaptiveQualityOracle, polygonArea, type Region, type QualityLevel } from './adaptiveQualityOracle.wo3226'

const evidence = 'src/tests/evidence/WO-3226'
const box = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
const round = Array.from({ length: 128 }, (_, i) => ({ x: 20 + 5 * Math.cos(i * Math.PI / 64), y: 20 + 5 * Math.sin(i * Math.PI / 64) }))
const fixtures: { id: string; region: Region; analyticArea: number }[] = [
  { id: 'rectangle', region: { outer: box(0, 0, 60, 40), islands: [] }, analyticArea: 2400 },
  { id: 'inside-corner', region: { outer: [[0, 0], [60, 0], [60, 20], [30, 20], [30, 40], [0, 40]].map(([x, y]) => ({ x, y })), islands: [] }, analyticArea: 1800 },
  { id: 'islands', region: { outer: box(0, 0, 60, 40), islands: [round, box(38, 15, 10, 10)] }, analyticArea: 2300 - Math.PI * 25 },
  { id: 'neck', region: { outer: [[0, 0], [25, 0], [25, 15.8], [35, 15.8], [35, 0], [60, 0], [60, 40], [35, 40], [35, 24.2], [25, 24.2], [25, 40], [0, 40]].map(([x, y]) => ({ x, y })), islands: [] }, analyticArea: 2084 },
]
// Numeric targets and their exact pinned-source origins are captured together.
// The fork's native width/reachable-area definitions differ from our arc/full-area
// diagnostics. See acceptance-provenance.json before interpreting a miss.
const acceptance = JSON.parse(readFileSync(`${evidence}/acceptance-provenance.json`, 'utf8')) as {
  revision: string; limits: Record<keyof Omit<QualityLevel, 'z' | 'sampledAreaMm2'>, { value: number }>
}
const metrics = {
  maximumEngagementRatio: acceptance.limits.maximumEngagementRatio.value,
  p99EngagementRatio: acceptance.limits.p99EngagementRatio.value,
  residualAreaMm2: acceptance.limits.residualAreaMm2.value,
  maximumWallExcursionMm: acceptance.limits.maximumWallExcursionMm.value,
}
type Metric = keyof typeof metrics
type Row = { fixture: string; levels: QualityLevel[]; fineLevels: QualityLevel[]; computeMs: number; moves: number; analyticArea: number; polygonArea: number }
const rows: Row[] = []
const recording = process.env.WO3226_RECORD === '1'
const baseline = recording ? undefined : JSON.parse(readFileSync(`${evidence}/baseline.json`, 'utf8')) as { rows: Row[] }
type ForkMove = { type: 'rapid' | 'feed' | 'arc' | 'dwell'; to?: [number, number, number]; center?: [number, number]; ccw?: boolean; feed?: number }
const forkBytes = readFileSync(`${evidence}/fork-published-moves.json`)
const fork = JSON.parse(forkBytes.toString('utf8')) as {
  revision: string; toolDiameterMm: number; params: { stepover: number; stock_to_leave: number }
  cut: { stepdown: number; heights: { top: number; bottom: number } }
  rows: { fixture: string; region: Region; computeMs: number; moves: ForkMove[] }[]
}
const comparison: { fixture: string; liencam: Row; fork: Row }[] = []

// Preserve native circular moves for the SAME samplePath/oracle used on LienCAM.
// Dwell has no swept path. All native feed/arc moves (including lifted links)
// remain cuts; the oracle's plane intersection decides whether they remove stock.
function forkMoves(moves: ForkMove[]): ToolpathMove[] {
  return moves.filter(m => m.type !== 'dwell').map(m => {
    if (!m.to || (m.type === 'arc' && !m.center)) throw new Error('Malformed fork move')
    return { type: m.type === 'arc' ? (m.ccw ? 'arc_ccw' : 'arc_cw') : m.type as 'feed' | 'rapid',
      x: m.to[0], y: m.to[1], z: m.to[2], feed: m.feed,
      ...(m.center ? { cx: m.center[0], cy: m.center[1] } : {}) }
  })
}

beforeAll(async () => {
  const base = alpha3Chains().find(c => c.id === 'engagement-pocket-adaptive_clearing_2d-default')!
  for (const fixture of fixtures) {
    const scene = await chainScene({ ...base, steps: base.steps.slice(0, 1) })
    const setup = scene.setups[0]
    const loops = [fixture.region.outer, ...fixture.region.islands].map((points, i) => ({
      id: `${scene.geometryId}~${i}`, type: i ? 'hole' as const : 'contour' as const,
      closed: true, points, area: polygonArea(points), layerId: 'benchmark',
    }))
    const geometry = { ...scene.geometry, loops, boundingBox: {
      min: { x: 0, y: 0, z: -6 }, max: { x: 60, y: 40, z: 0 },
      size: { x: 60, y: 40, z: 6 }, center: { x: 30, y: 20, z: -3 },
    } }
    const stock = { ...scene.physicalStock, position: { x: 0, y: 0, z: -6 }, bounds: geometry.boundingBox }
    const params = { ...defaultACParams, geometryId: geometry.id, loopIds: loops.map(l => l.id), planeOffset: -6 }
    const heights = { ...defaultHeights, topHeight: 0, bottomHeight: -6 }
    const op = { ...setup.operations[0], params, heights, passes: { ...defaultPasses }, linking: { ...defaultLinking },
      geometrySelections: loops.map(l => l.id),
      smartHeight: smartHeightAuthorityFixture('adaptive_clearing_2d', { setupId: setup.id, heights, params, geometryIds: [geometry.id], explicitDepthMm: 6 }),
    }
    setup.operations = [op]
    const tool = scene.tools[0]
    expect(tool.diameter).toBe(6)
    const project = { geometry: [geometry], stocks: [stock], setups: [setup], toolLibrary: [tool],
      sceneStock: { ...scene.sceneStock, fixedWidth: 60, fixedHeight: 40, fixedDepth: 6,
        fixedStocks: [{ ...scene.stock, width: 60, height: 40, depth: 6, position: stock.position }] },
    } as Project
    const planned = await planChain({ ...base, alpha3: { material: 'aluminum', project }, steps: [{
      ...base.steps[0], authoredSetupId: setup.id, setupLabel: 'setup1-declared', parameterMode: 'declared',
      authoredOperation: op, params,
    }] })
    const result = planned.steps[0]
    expect(result.status, result.operatorText).toBe('ready')
    expect(result.moves.length).toBeGreaterThan(0)
    if (recording) writeFileSync(`${evidence}/${fixture.id}-move-summary.json`, JSON.stringify({
      settings: result.settings,
      intermediate: result.moves.filter(m => m.z === -1 || m.z === -3).slice(0, 20),
    }, null, 2))
    // Target angular engagement for radial immersion ae: acos(1 - ae/r).
    // The default targetEngagement field is legacy/ignored by the engine; the
    // app's actual D6, ae=3 mm default corresponds to pi/2 radians.
    const input = { moves: result.moves, radius: tool.diameter / 2, region: fixture.region,
      targetEngagement: Math.acos(1 - defaultPasses.stepover / (tool.diameter / 2)) }
    const levels = adaptiveQualityOracle(input)
    const fineLevels = adaptiveQualityOracle({ ...input, cellMm: 0.05, spacingMm: 0.1, angularSamples: 720 })
    expect(levels.map(l => l.z)).toEqual([-2, -4, -6])
    expect(fineLevels.map(l => l.z)).toEqual([-2, -4, -6])
    for (const level of [...levels, ...fineLevels]) for (const value of Object.values(level)) expect(Number.isFinite(value)).toBe(true)
    const row = { fixture: fixture.id, levels, fineLevels, computeMs: result.planMs, moves: result.moves.length,
      analyticArea: fixture.analyticArea, polygonArea: polygonArea(fixture.region.outer) - fixture.region.islands.reduce((a, l) => a + polygonArea(l), 0) }
    rows.push(row)
    const control = fork.rows.find(r => r.fixture === fixture.id)!
    expect(control.region).toEqual(fixture.region)
    const controlMoves = forkMoves(control.moves)
    // Check actual published floors before selecting the authored schedule: a
    // missing floor must fail setup, never become a named expected quality miss.
    for (const z of [-2, -4, -6]) expect(controlMoves.some((m, i) => i > 0 && m.type !== 'rapid' &&
      m.z === z && controlMoves[i - 1].z === z && Math.hypot(m.x - controlMoves[i - 1].x, m.y - controlMoves[i - 1].y) > 1e-8)).toBe(true)
    const forkInput = { ...input, moves: controlMoves, levels: [-2, -4, -6] }
    comparison.push({ fixture: fixture.id, liencam: row, fork: { ...row,
      computeMs: control.computeMs, moves: control.moves.length,
      levels: adaptiveQualityOracle(forkInput),
      fineLevels: adaptiveQualityOracle({ ...forkInput, cellMm: 0.05, spacingMm: 0.1, angularSamples: 720 }),
    } })
  }
  if (recording) {
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const findings = rows.flatMap(row => row.fineLevels.flatMap(level => (Object.keys(metrics) as Metric[])
      .filter(metric => metric === 'residualAreaMm2' ? level[metric] >= metrics[metric] : level[metric] > metrics[metric])
      .map(metric => ({ fixture: row.fixture, z: level.z, metric, value: level[metric], threshold: metrics[metric], sourceCommit: source }))))
    writeFileSync(`${evidence}/baseline.json`, JSON.stringify({ sourceCommit: source, resolutions: { coarseCellMm: 0.1, fineCellMm: 0.05,
      coarseSpacingMm: 0.2, fineSpacingMm: 0.1, arcSpacingMm: 0.25, coarseAngles: 360, fineAngles: 720 }, fixtures, rows, findings }, null, 2) + '\n')
  }
  if (process.env.WO3226_COMPARE === '1') {
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    writeFileSync(`${evidence}/comparison.json`, JSON.stringify({ sourceCommit: source, forkRevision: fork.revision,
      forkMovesSha256: createHash('sha256').update(forkBytes).digest('hex'), acceptance: 'acceptance-provenance.json',
      command: 'WO3226_COMPARE=1 npx vitest run src/tests/benchmark/adaptiveQualityOracle.wo3226.test.ts',
      timingScope: { liencam: 'Production planChain wall time, including store/worker publication.', fork: 'Release native adaptive() wall time, excluding build and JSON/IO; not a speedup benchmark.' },
      resolutions: { coarseCellMm: 0.1, fineCellMm: 0.05, coarseSpacingMm: 0.2, fineSpacingMm: 0.1, arcSpacingMm: 0.25, coarseAngles: 360, fineAngles: 720 },
      rows: comparison,
    }, null, 2) + '\n')
  }
}, 240_000)

describe('pinned fork control evidence', () => {
  it('keeps the declared targets, exact pin, common tool and authored cutting schedule', () => {
    expect(metrics).toEqual({ maximumEngagementRatio: 1.15, p99EngagementRatio: 1.15, residualAreaMm2: 2, maximumWallExcursionMm: 0 })
    expect(fork.revision).toBe('f0bfc53049d3c6251a51b6445532de7a45bcce42')
    expect(acceptance.revision).toBe(fork.revision)
    expect(fork.toolDiameterMm).toBe(6)
    expect(fork.params.stepover * fork.toolDiameterMm).toBe(defaultPasses.stepover)
    expect(fork.params.stock_to_leave).toBe(defaultPasses.stockToLeave)
    expect(fork.cut.stepdown).toBe(defaultPasses.stepdown)
    expect(fork.cut.heights.top).toBe(0)
    expect(fork.cut.heights.bottom).toBe(-6)
    const receipt = JSON.parse(readFileSync(`${evidence}/fork-build-receipt.json`, 'utf8'))
    expect(receipt.unmodifiedLibrarySource).toBe(true)
    expect(receipt.commands.every((c: { exitCode: number }) => c.exitCode === 0)).toBe(true)
    expect(createHash('sha256').update(forkBytes).digest('hex')).toBe(receipt.movesSha256)
    expect(fork.rows.map(r => r.fixture)).toEqual(fixtures.map(f => f.id))
  })
  for (const fixture of fixtures) it(`${fixture.id}: measures both implementations at all three levels with the same oracle`, () => {
    const row = comparison.find(r => r.fixture === fixture.id)!
    for (const result of [row.liencam, row.fork]) {
      expect(result.computeMs).toBeGreaterThan(0)
      for (const levels of [result.levels, result.fineLevels]) {
        expect(levels.map(l => l.z)).toEqual([-2, -4, -6])
        for (const level of levels) for (const value of Object.values(level)) expect(Number.isFinite(value)).toBe(true)
      }
    }
  })
})

describe('independent swept-disk controls', () => {
  it('selects authored floors while still sweeping lifted feeds through shallower stock', () => {
    const moves: ToolpathMove[] = [{ type: 'rapid', x: 2, y: 5, z: 2 },
      { type: 'feed', x: 2, y: 5, z: -2, feed: 100 }, { type: 'feed', x: 3, y: 5, z: -2, feed: 100 },
      { type: 'rapid', x: 6, y: 5, z: -1.5 }, { type: 'feed', x: 8, y: 5, z: -1.5, feed: 100 }]
    const input = { moves, radius: 1, region: { outer: box(0, 0, 10, 10), islands: [] }, targetEngagement: Math.PI }
    expect(adaptiveQualityOracle(input).map(l => l.z)).toEqual([-1.5, -2])
    const measured = adaptiveQualityOracle({ ...input, levels: [-1, -2] })
    expect(measured.map(l => l.z)).toEqual([-1, -2])
    expect(measured[0].residualAreaMm2).toBeLessThan(measured[1].residualAreaMm2 - 3)
  })
  it('measures an analytic disk, fresh engagement, exact wall crossing, and independent levels', () => {
    const moves: ToolpathMove[] = [{ type: 'rapid', x: 5, y: 5, z: 2 },
      { type: 'feed', role: 'plunge', x: 5, y: 5, z: -2, feed: 100 }, { type: 'feed', x: 5.001, y: 5, z: -2, feed: 100 },
      { type: 'rapid', x: 0.5, y: 5, z: 2 }, { type: 'feed', role: 'plunge', x: 0.5, y: 5, z: -4, feed: 100 },
      { type: 'feed', x: 0.501, y: 5, z: -4, feed: 100 }]
    const measured = adaptiveQualityOracle({ moves, radius: 1, region: { outer: box(0, 0, 10, 10), islands: [] }, targetEngagement: Math.PI, cellMm: 0.025 })
    expect(measured.map(l => l.z)).toEqual([-2, -4])
    expect(measured[1].maximumWallExcursionMm).toBe(0.5)
    expect(measured[1].maximumEngagementRatio).toBeGreaterThan(1)
    const diskOnly = adaptiveQualityOracle({ moves: moves.slice(0, 3), radius: 1, region: { outer: box(0, 0, 10, 10), islands: [] }, targetEngagement: Math.PI, cellMm: 0.025 })[0]
    expect(diskOnly.residualAreaMm2).toBeCloseTo(100 - Math.PI, 1)
    expect(diskOnly.maximumEngagementRatio).toBe(2)
    expect(diskOnly.maximumWallExcursionMm).toBe(0)
  })
  it('preserves authored islands and polygon area independently of winding', () => {
    expect(polygonArea(box(0, 0, 60, 40).reverse())).toBe(2400)
    const result = adaptiveQualityOracle({ moves: [{ type: 'rapid', x: 5, y: 5, z: 2 },
      { type: 'feed', role: 'plunge', x: 5, y: 5, z: -2, feed: 100 }, { type: 'feed', x: 5.001, y: 5, z: -2, feed: 100 }],
    radius: 1, region: { outer: box(0, 0, 10, 10), islands: [box(4, 4, 2, 2)] }, targetEngagement: Math.PI })[0]
    expect(result.sampledAreaMm2).toBeCloseTo(96, 8)
    expect(result.residualAreaMm2).toBeCloseTo(96, 8)
    expect(result.maximumWallExcursionMm).toBe(2)
  })
})

for (const fixture of fixtures) for (const z of [-2, -4, -6]) for (const metric of Object.keys(metrics) as Metric[]) {
  const previous = baseline?.rows.find(r => r.fixture === fixture.id)
  const worst = previous?.fineLevels.find(l => l.z === z)?.[metric]
  const missed = worst !== undefined && (metric === 'residualAreaMm2' ? worst >= metrics[metric] : worst > metrics[metric])
  // Expected failures contain only the threshold assertion. Setup failures cannot
  // masquerade as known quality findings because generation lives in beforeAll.
  const test = missed ? it.fails : it
  test(`${fixture.id} Z${z}: ${metric} ${metric === 'residualAreaMm2' ? '<' : '<='} ${metrics[metric]}${missed ? ` (baseline ${worst})` : ''}`, () => {
    if (recording) return
    const row = rows.find(r => r.fixture === fixture.id)!
    for (const level of row.fineLevels.filter(l => l.z === z)) {
      if (metric === 'residualAreaMm2') expect(level[metric]).toBeLessThan(metrics[metric])
      else expect(level[metric]).toBeLessThanOrEqual(metrics[metric])
    }
  })
}
