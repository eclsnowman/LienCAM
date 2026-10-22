import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEngineRouter, kernelPlanners, type KernelPlan, type PlanningInput } from '../../kernel/planning'
import { generationFingerprint, setGenerationEngineResolver } from '../../lib/cam/generationFingerprint'
import type { GenerationFingerprintInput } from '../../lib/cam/generationFingerprint'
import type { Operation } from '../../types'

const input = { operation: { type: 'pocket_2d' } } as PlanningInput
const plan = { moves: [], computeTimeMs: 1 } as unknown as KernelPlan
const fixture = {
  operation: { type: 'pocket_2d', params: {}, heights: {}, passes: {}, linking: {} },
  setup: { id: 'setup', wcs: {}, stock: {} }, geometry: [], stocks: [], machine: {},
} as unknown as GenerationFingerprintInput

afterEach(() => setGenerationEngineResolver(() => 'current'))

describe('WO-2904 engine selection', () => {
  it.each([undefined, 'unknown', '', 'CURRENT'])('defaults %s to current without preparing kernel inputs', async setting => {
    const kernel = vi.fn(async () => plan)
    const router = createEngineRouter({ pocket_2d: kernel }, () => setting)
    const current = vi.fn(async () => {})
    await router.plan(input, current, vi.fn(), vi.fn())
    expect(router.engineId('pocket_2d')).toBe('current')
    expect(current).toHaveBeenCalledOnce()
    expect(kernel).not.toHaveBeenCalled()
  })
  it.each(['kernel', 'both'])('cannot switch an unregistered type to %s', async setting => {
    const router = createEngineRouter(kernelPlanners, () => setting)
    const current = vi.fn(async () => {})
    await router.plan(input, current, vi.fn(), vi.fn())
    expect(router.engineId('pocket_2d')).toBe('current')
    expect(current).toHaveBeenCalledOnce()
  })
  it('prepares and plans only the selected kernel path once', async () => {
    const kernel = vi.fn(async () => plan)
    const current = vi.fn(async () => {})
    const publish = vi.fn()
    const router = createEngineRouter({ pocket_2d: kernel }, () => 'current', { pocket_2d: 'kernel' })
    await router.plan(input, current, publish, vi.fn())
    expect(kernel).toHaveBeenCalledExactlyOnceWith(input)
    expect(current).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledExactlyOnceWith(plan)
  })
  it('both compares once and retains the current result without publishing kernel moves', async () => {
    const kernel = vi.fn(async () => plan)
    const current = vi.fn(async () => {})
    const publish = vi.fn(), compare = vi.fn()
    await createEngineRouter({ pocket_2d: kernel }, () => 'both').plan(input, current, publish, compare)
    expect(kernel).toHaveBeenCalledOnce()
    expect(current).toHaveBeenCalledOnce()
    expect(publish).not.toHaveBeenCalled()
    expect(compare).toHaveBeenCalledExactlyOnceWith(plan)
  })
  it('changes the canonical fingerprint when a registered engine flips and restores on rollback', () => {
    let setting = 'current'
    const router = createEngineRouter({ pocket_2d: async () => plan }, () => setting)
    setGenerationEngineResolver(router.engineId)
    const before = generationFingerprint(fixture)
    setting = 'kernel'
    expect(generationFingerprint(fixture)).not.toBe(before)
    setting = 'both'
    expect(generationFingerprint(fixture)).not.toBe(before)
    setting = 'current'
    expect(generationFingerprint(fixture)).toBe(before)
    expect(router.engineId('drill' as Operation['type'])).toBe('current')
  })
})
