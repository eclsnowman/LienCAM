// WO-202 recovery of WO-091: a failed or timed-out planegcs load must not
// remain memoized for the life of the tab. These tests mock only the module
// initializer so the observable is the loader memo's real lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initPlanegcsModule = vi.fn()

// WO-1052 FINDING: not converted to typedMock. The real `GcsWrapper`
// (@salusoft89/planegcs) has private instance fields (sketch_param_index,
// nondriving_constraint_params_order, enable_equal_optimization) and a
// constructor that takes a real `GcsSystem`, not `unknown`; its public shape
// is also different (gcs/p_param_index/sketch_index, not this fixture's
// `system`). This suite only proves createGcsWrapper's memo lifecycle -
// planegcsLoader.ts:102 constructs `new GcsWrapper(new mod.GcsSystem())` and
// awaits the result without ever touching a GCS member, so a same-shaped
// stand-in is unnecessary for what is under test, but typing this class
// through `typedMock` would need either a cast (forbidden by this sweep) or a
// fixture that reimplements GcsWrapper's private internals for no behavioral
// reason. Left untyped; its one baseline entry stays.
vi.mock('@salusoft89/planegcs', () => ({
  init_planegcs_module: (...args: unknown[]) => initPlanegcsModule(...args) as unknown,
  GcsWrapper: class {
    readonly system: unknown
    constructor(system: unknown) { this.system = system }
  },
}))

const {
  createGcsWrapper,
  createSketch3dGcsWrapper,
  planegcsLoadAttemptCountForTest,
  resetPlanegcsLoadDeadlineForTest,
  resetPlanegcsModuleForTest,
  setPlanegcsLoadDeadlineMsForTest,
} = await import('../../lib/planegcs/planegcsLoader')

function fakeModule() {
  return { GcsSystem: class {} }
}

beforeEach(() => {
  resetPlanegcsModuleForTest()
  resetPlanegcsLoadDeadlineForTest()
  initPlanegcsModule.mockReset()
})

afterEach(() => {
  resetPlanegcsModuleForTest()
  resetPlanegcsLoadDeadlineForTest()
})

describe('WO-202 planegcs loader memo recovery', () => {
  it('clears a rejected load so the next call starts a genuine attempt without a reload', async () => {
    initPlanegcsModule
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module: planegcs.wasm'))
      .mockResolvedValueOnce(fakeModule())

    await expect(createGcsWrapper()).rejects.toThrow(/Failed to fetch dynamically imported module/)
    expect(planegcsLoadAttemptCountForTest()).toBe(1)

    await expect(createGcsWrapper()).resolves.toBeTruthy()
    expect(planegcsLoadAttemptCountForTest()).toBe(2)
  })

  it('clears a timed-out load so the next call starts a genuine attempt', async () => {
    setPlanegcsLoadDeadlineMsForTest(25)
    initPlanegcsModule
      .mockImplementationOnce(() => new Promise(() => { /* real hang shape */ }))
      .mockImplementationOnce(async () => fakeModule())

    await expect(createSketch3dGcsWrapper())
      .rejects.toThrow('planegcs wasm module load timed out after 25ms')
    expect(planegcsLoadAttemptCountForTest()).toBe(1)

    await expect(createSketch3dGcsWrapper()).resolves.toBeTruthy()
    expect(planegcsLoadAttemptCountForTest()).toBe(2)
  })

  it('keeps the successful path memoized across concurrent callers', async () => {
    initPlanegcsModule.mockResolvedValue(fakeModule())

    await Promise.all([createGcsWrapper(), createGcsWrapper(), createSketch3dGcsWrapper()])

    expect(planegcsLoadAttemptCountForTest()).toBe(1)
    expect(initPlanegcsModule).toHaveBeenCalledTimes(1)
  })

  it('does not let an abandoned load evict a newer successful memo', async () => {
    setPlanegcsLoadDeadlineMsForTest(25)
    let failAbandoned!: (err: Error) => void
    initPlanegcsModule
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failAbandoned = reject }))
      .mockImplementationOnce(async () => fakeModule())

    await expect(createGcsWrapper()).rejects.toThrow(/timed out after 25ms/)
    await expect(createGcsWrapper()).resolves.toBeTruthy()
    expect(planegcsLoadAttemptCountForTest()).toBe(2)

    failAbandoned(new Error('late failure from abandoned load'))
    await Promise.resolve()
    await Promise.resolve()

    await expect(createGcsWrapper()).resolves.toBeTruthy()
    expect(planegcsLoadAttemptCountForTest()).toBe(2)
  })
})
