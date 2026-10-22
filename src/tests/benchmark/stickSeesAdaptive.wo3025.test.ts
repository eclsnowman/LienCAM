// WO-3025: the alpha.3 measuring stick sees adaptive (WO-3019 item 9 a-e).
// Fast checks only: one real 2D plan through the production chain runner, scene and scoring
// checks, and the committed result of the long re-record (src/tests/evidence/WO-3025/).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ToolpathMove } from '../../types'
import type { PartMesh } from '../../cam3d/kernel/types'
import { SIDE_ENTRY_ENGAGEMENT_CAP } from '../../cam3d/strategies/adaptiveRough'
import { chainScene, planChain, scoreChain, type PlannedChain } from './chainRunner'
import { alpha3Chains, alpha3Parts } from './alpha3Registry'
import { toolById, type BenchmarkChain } from './registry'
import type { MetricValue } from './metricRegistry'

const chain = (id: string) => alpha3Chains().find(candidate => candidate.id === id)!
const isAdaptive = (type: string) => type === 'adaptive_clearing_2d' || type === 'adaptive_3d'
const reasonOf = (value: MetricValue | undefined) => typeof value === 'object' ? value.reason : ''

// A 20 x 20 x 10 mm box standing in for an OCCT Form body: only the scene's frames are under test.
function boxMesh(): PartMesh {
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(i => [i & 1 ? 20 : 0, i & 2 ? 20 : 0, i & 4 ? 10 : 0])
  const faces = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  return { positions: Float32Array.from(corners.flat()), indices: Uint32Array.from(faces.flat()),
    bounds: { min: [0, 0, 0], max: [20, 20, 10] }, source: 'model' } as PartMesh
}

describe('WO-3025 the measuring stick sees adaptive', () => {
  it('the H-pocket island is a hole', () => {
    for (const type of ['adaptive_clearing_2d', 'pocket_2d']) {
      const picks = chain(`engagement-pocket-${type}-default`).alpha3!.planarPicks!
      expect(picks.map(loop => [loop.id, loop.type])).toEqual([
        ['geo-engagement-pocket~pocket', 'contour'], ['geo-engagement-pocket~island', 'hole']])
    }
  })

  it('engagement is measured on the adaptive rows', async () => {
    const full = chain('engagement-pocket-adaptive_clearing_2d-default')
    const first: BenchmarkChain = { ...full, steps: full.steps.slice(0, 1) }
    const scored = await scoreChain(first, await planChain(first))
    const metrics = scored.rows[0].metrics
    expect(scored.rows[0].status).toBe('ready')
    expect(reasonOf(metrics.peakEngagementFraction)).toBe('')
    expect(metrics.engagementCapFraction).toBe(SIDE_ENTRY_ENGAGEMENT_CAP)
    expect(full.steps[0].engagementCapFraction).toBe(SIDE_ENTRY_ENGAGEMENT_CAP)
    expect(metrics.peakEngagementFraction).toBeGreaterThan(0)
    expect(metrics.p95EngagementFraction).toBeGreaterThan(0)
    expect(metrics.measuredCuttingLengthMm).toBeGreaterThan(100)
  }, 240_000)

  it('declares the cap on every first adaptive step and on no later one', () => {
    const fixtures = alpha3Chains().filter(c => /^(form-|engagement-pocket-adaptive|ex06-)/.test(c.id))
    expect(fixtures).toHaveLength(12)
    for (const c of fixtures) {
      const adaptive = c.steps.filter(step => isAdaptive(step.type))
      expect(adaptive[0].engagementCapFraction, c.id).toBe(SIDE_ENTRY_ENGAGEMENT_CAP)
      for (const later of adaptive.slice(1)) expect(later.engagementCapFraction, `${c.id}/${later.id}`).toBeUndefined()
    }
  })

  it('declared Form rows write their heights in the WCS the fields mean', async () => {
    const part = alpha3Parts().find(candidate => candidate.id === 'form-box')!
    const real = part.mesh
    part.mesh = async () => boxMesh()
    try {
      const scene = await chainScene(chain('form-box-declared'))
      const { wcs, operations } = scene.setups[0]
      // Stock top is the WCS origin (Z 0 in the WCS); the declared fields are stock top + 10 / + 2 / + 1.
      expect(wcs.origin.z).toBe(scene.box.maxZ)
      expect(operations[0].heights).toMatchObject({ clearanceHeight: 10, retractHeight: 2, feedHeight: 1 })
    } finally { part.mesh = real }
  })

  it('every adaptive row has a real library tool, and ex12 says exactly why it plans nothing', () => {
    for (const c of alpha3Chains()) for (const step of c.steps.filter(s => isAdaptive(s.type))) {
      expect(toolById(step.toolId).libraryTool, `${c.id}/${step.id}`).toBeDefined()
      if (c.partId === 'ex12-tray') expect(step.unavailableReason).toMatch(/ships Tray\.step and no project/)
      else expect(step.unavailableReason, `${c.id}/${step.id}`).toBeUndefined()
    }
  })

  it('project adaptive rows replay their stock in world space, and stop at a cutter it cannot model', async () => {
    const at = (x: number, y: number, z: number, type: ToolpathMove['type'] = 'feed', feed = 800): ToolpathMove =>
      ({ type, x, y, z, ...(type === 'rapid' ? {} : { feed }) })
    // ex06's stock is X/Y +-25.7, Z -10..22.6 (world); this pass cuts its top, feeds 50 mm through air (up 10, across 40), then
    // rapids through the stock at Z 15.
    const moves = [at(-40, 0, 30, 'rapid'), at(-40, 0, 20, 'rapid'), at(40, 0, 20), at(40, 0, 30), at(40, 40, 30), at(40, 40, 15, 'rapid'), at(-40, 10, 15, 'rapid')]
    const cutTimeMs = (80 + 10 + 40) / 800 * 60_000
    const synthetic = (c: BenchmarkChain, ready: string): PlannedChain => ({ chainId: c.id, steps: c.steps.map(step => step.id === ready
      ? { stepId: step.id, setupId: 'unit', moves, planMs: 0, cutTimeMs, status: 'ready' as const, operatorText: '' }
      : { stepId: step.id, setupId: 'unit', moves: [], planMs: 0, status: 'n/a' as const, operatorText: 'not planned in this check' }) })
    const ex06 = chain('ex06-knob-handwheel-default')
    const row = (await scoreChain(ex06, synthetic(ex06, 'setup1-step1-adaptive_3d'))).rows[0]
    expect(row.metrics['M-AIR-2']).toBeCloseTo(50 / 130 * 100, 3)
    expect(row.metrics['M-SAFE-2']).toBeGreaterThan(7)
    expect(row.metrics.peakEngagementFraction).toBeGreaterThan(0)

    const ex07 = chain('ex07-relief-medallion-default')
    const plan = synthetic(ex07, 'setup1-step1-drill')
    const drill = plan.steps[0]
    drill.moves = [at(35, 35, 15, 'rapid'), at(35, 35, 2, 'rapid'), at(35, 35, -3, 'feed', 100), at(35, 35, 15, 'rapid')]
    drill.cutTimeMs = 5 / 100 * 60_000
    Object.assign(plan.steps[1], { moves, cutTimeMs, status: 'ready', operatorText: '' })
    const adaptive = (await scoreChain(ex07, plan)).rows[1]
    expect(reasonOf(adaptive.metrics['M-AIR-2'])).toMatch(/stock replay stops at setup1-step1-drill: its drill is not a cutter/)
  })

  it('the committed baseline carries the re-recorded adaptive rows', () => {
    const baseline = JSON.parse(readFileSync('src/tests/benchmark/baseline.alpha3.json', 'utf8')) as {
      sourceCommit: string; reason: string; rows: { key: string; opType: string; status?: string; metrics: Record<string, { value: number | null }> }[] }
    expect(baseline.reason).toMatch(/^WO-3025: /)
    const recorded = JSON.parse(readFileSync('src/tests/evidence/WO-3025/recorded-rows.json', 'utf8')) as {
      source: string; rows: { key: string; nonTimingSha256: string }[] }
    expect(baseline.sourceCommit).toBe(recorded.source)
    expect(baseline.rows.map(row => row.key)).toEqual(alpha3Chains().flatMap(c => c.steps.map(step =>
      [c.partId, step.setupLabel ?? c.setupLabel, step.id, step.toolId, step.scope.id].join('/'))))
    const byKey = new Map(baseline.rows.map(row => [row.key, row]))
    for (const { key } of recorded.rows) expect(byKey.has(key), key).toBe(true)
    // WO-3019 item 9e: the cylinder and torus rows generate on today's engine.
    for (const kind of ['cylinder', 'torus']) for (const mode of ['default', 'declared']) {
      expect(byKey.get(`form-${kind}/top-${mode}/adaptive_3d/starter-metric-2/whole`)?.status).toBe('ready')
    }
    // Item 9a: every first adaptive row with moves carries a measured engagement. (The declared
    // H-pocket reads ready with no moves: WO-3019 item 2, an engine finding, not a stick gap.)
    for (const c of alpha3Chains().filter(c => /^(form-|engagement-pocket-adaptive|ex06-)/.test(c.id))) {
      const step = c.steps[0]
      const row = byKey.get([c.partId, step.setupLabel ?? c.setupLabel, step.id, step.toolId, step.scope.id].join('/'))!
      if (row.status === 'ready' && row.metrics.moves.value !== null) expect(row.metrics.peakEngagementFraction.value, row.key).toBeGreaterThan(0)
    }
  })
})
