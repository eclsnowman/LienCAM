// WO-3018: the adaptive shadow route, like WO-2944's Face. With the engine selector at
// `both` the application computes current AND kernel and records their equality; what the
// operator sees (the published moves, status and notices) is the current engine's output,
// equal to the starter record (outputs only on the record's capture host: float bits are
// host-bound; elsewhere the in-process shadow comparison carries move equality).
// Actual store entry (benchmark chain runner: real toolpath worker, real cam3d
// dispatcher), no builder mocks.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { engineByType, kernelPlanners } from '../../kernel/planning'

const { planChain } = await import('../benchmark/chainRunner')
const { alpha3Chains } = await import('../benchmark/registry')

const before = JSON.parse(readFileSync('src/tests/evidence/WO-3018/before-record.json', 'utf8')) as {
  host: { platform: string; arch: string; nodeMajor: number }
  chains: Record<string, { stepId: string; moves: string; status?: string; operatorText?: string; moveCount: number }[]>
}
const onCaptureHost = JSON.stringify(before.host) === JSON.stringify({ platform: process.platform, arch: process.arch,
  nodeMajor: Number(process.versions.node.split('.')[0]) })
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
interface StepView { stepId: string; moves: string; status?: string; operatorText?: string; moveCount: number }
// What a published step is compared on: everything on the record's capture host; elsewhere
// the host-independent fields only.
const recordView = ({ stepId, moves, status, operatorText, moveCount }: StepView, onHost = onCaptureHost) =>
  (onHost ? { stepId, moves, status, operatorText, moveCount } : { stepId, status, operatorText })
const ADAPTIVE = new Set(['adaptive_clearing_2d', 'adaptive_3d'])

async function planAdaptive(id: string) {
  const chain = alpha3Chains().find(candidate => candidate.id === id)!
  // Only the steps the starter record holds: steps added to the stick later (WO-3025's second
  // tool) are measured by the stick's own tests, not by this parity record.
  const recorded = before.chains[id]?.map(step => step.stepId)
  const steps = chain.steps.filter(step => ADAPTIVE.has(step.type) && !step.unavailableReason
    && (!recorded || recorded.includes(step.id)))
  return planChain({ ...chain, steps })
}
function comparisons(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter(call => call[0] === 'LIENCAM_ENGINE comparison').map(call => call[2] as Record<string, unknown>)
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('WO-3018 adaptive shadow route', () => {
  it('the starter record names its capture host', () => {
    expect(Object.keys(before.host ?? {}).sort()).toEqual(['arch', 'nodeMajor', 'platform'])
  })

  it('off the capture host compares the record on host-independent fields only', () => {
    const step = { stepId: 's', moves: 'm', status: 'ready', operatorText: '', moveCount: 1 }
    expect(Object.keys(recordView(step, false)).sort()).toEqual(['operatorText', 'status', 'stepId'])
    expect(Object.keys(recordView(step, true)).sort()).toEqual(['moveCount', 'moves', 'operatorText', 'status', 'stepId'])
  })

  it('keeps production registrations empty: the switch stays current', () => {
    expect(Object.keys(kernelPlanners)).toEqual([])
    expect(Object.keys(engineByType)).toEqual([])
  })

  it.each([
    // WO-3059: since 06c2a03b69 (WO-3024) the declared 2D pocket cuts nothing and ends as a
    // TOOLPATH_ERROR, which records no shadow comparison; the 2D exemplar is the default
    // pocket, which cuts (its rows are in the same starter record).
    ['engagement-pocket-adaptive_clearing_2d-default', 'adaptive_clearing_2d'],
    ['stepped-boss-rough-finish-declared', 'adaptive_3d'],
  ])('%s at both: publishes the current moves and records equal kernel moves', { timeout: 1_800_000 }, async (id, type) => {
    vi.stubEnv('LIENCAM_ENGINE', 'both')
    const info = vi.spyOn(console, 'info')
    const planned = await planAdaptive(id)
    const published = planned.steps.map(step => recordView({ stepId: step.stepId, moves: sha(JSON.stringify(step.moves)),
      status: step.status, operatorText: step.operatorText, moveCount: step.moves.length }))
    const record = before.chains[id].filter(step => planned.steps.some(candidate => candidate.stepId === step.stepId))
    expect(published).toEqual(record.map(step => recordView(step)))
    const shadows = comparisons(info)
    expect(shadows).toHaveLength(planned.steps.length)
    for (const [index, shadow] of shadows.entries()) {
      expect(shadow).toMatchObject({ engine: 'both', type, policyVersion: 'adaptive-policy/1', equal: true,
        moveCount: planned.steps[index].moves.length })
    }
  })

  it('records a rest start as not run at both, and still publishes the current rest moves', { timeout: 1_800_000 }, async () => {
    const id = 'engagement-pocket-rest-pencil-declared'
    vi.stubEnv('LIENCAM_ENGINE', 'both')
    const info = vi.spyOn(console, 'info')
    const planned = await planAdaptive(id)
    const record = before.chains[id].filter(step => planned.steps.some(p => p.stepId === step.stepId))
    expect(planned.steps.map(step => recordView({ stepId: step.stepId, moves: sha(JSON.stringify(step.moves)),
      status: step.status, operatorText: step.operatorText, moveCount: step.moves.length })))
      .toEqual(record.map(step => recordView(step)))
    const shadows = comparisons(info)
    // The first rough plans from the block (compared); the rest rough starts from the
    // carved field the worker retains for one run (not run twice).
    expect(shadows).toEqual([
      expect.objectContaining({ engine: 'both', type: 'adaptive_3d', equal: true }),
      { engine: 'both', type: 'adaptive_3d', notRun: 'rest start: the retained carved field serves one run' },
    ])
  })

  it('records nothing on the current engine', { timeout: 1_800_000 }, async () => {
    vi.stubEnv('LIENCAM_ENGINE', 'current')
    const info = vi.spyOn(console, 'info')
    const planned = await planAdaptive('engagement-pocket-adaptive_clearing_2d-default')
    expect(planned.steps.every(step => step.moves.length > 0)).toBe(true)
    expect(comparisons(info)).toEqual([])
  })
})
