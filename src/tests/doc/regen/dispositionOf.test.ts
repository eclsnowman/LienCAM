import { describe, it, expect } from 'vitest'
import { FeatureDag } from '../../../doc/dag'
import { ElementMap } from '../../../doc/element-map'
import { PASS_DISPOSITIONS, RegenScheduler, type PassDisposition } from '../../../doc/regen'
import { makeExecutor } from './_helpers'

// WO UI-51A-R5 (audit MAJOR 2, seam contract): the table-driven drift lock.
// Iterates PASS_DISPOSITIONS ITSELF -- the runtime const dispositionOf's
// return type is derived from (doc/regen/scheduler.ts, the SAME house
// pattern as DAG_NODE_KINDS/DEFEATURE_CLASS_DISPOSITIONS) -- rather than a
// hand-copied list in this test file. A hand list re-labeled "derived" would
// NOT satisfy the WO's derivation rule; iterating the const itself means a
// genuinely new disposition value added there is picked up here AUTOMATICALLY
// (via describe.each below) and fails BY NAME (the "no scenario registered"
// throw in the shared test body) until a scenario is added for it -- it can
// never silently pass 5-of-6.
//
// Each scenario constructs the smallest dag that puts one node into exactly
// the disposition under test, then asserts scheduler.dispositionOf(id).kind
// matches -- calling dispositionOf DIRECTLY, never through scheduler.run(),
// so this is a pure classification probe. That pass() itself ALSO routes
// every one of its four skip branches through this SAME method (rather than
// a parallel copy) is proven separately by the frozen scheduler suites
// (scheduler.test.ts, suppress.test.ts, rollback.test.ts) staying green
// after the refactor, plus the mutation proof in this WO's evidence
// (misclassifying 'suppressed' inside dispositionOf fails suppress.test.ts
// BY NAME in the same run -- see coordination/evidence/UI-51A-R5/mutations).

interface Scenario {
  build(): Promise<{ scheduler: RegenScheduler; id: string }>
  /** set when the disposition carries an upstreamId (the deterministic
   *  smallest-id upstream selection dispositionOf's doc comment describes). */
  expectedUpstreamId?: string
}

const SCENARIOS: Record<PassDisposition, Scenario> = {
  suppressed: {
    build: async () => {
      const dag = new FeatureDag()
      dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
      dag.setSuppressed('F1', true)
      const scheduler = new RegenScheduler(dag, new ElementMap())
      scheduler.markDirty('F1')
      return { scheduler, id: 'F1' }
    },
  },
  rolledBack: {
    build: async () => {
      const dag = new FeatureDag()
      dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
      dag.setRollbackMarker({ kind: 'start' })
      const scheduler = new RegenScheduler(dag, new ElementMap())
      scheduler.markDirty('F1')
      return { scheduler, id: 'F1' }
    },
  },
  failedUpstream: {
    expectedUpstreamId: 'F1',
    build: async () => {
      const dag = new FeatureDag()
      dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
      dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
      const scheduler = new RegenScheduler(dag, new ElementMap())
      // Settle F1 as 'failed' FIRST (through a real pass -- the only way a
      // status genuinely becomes 'failed'), THEN mark F2 dirty and query its
      // disposition directly, without ever running F2 through the executor.
      scheduler.markDirty('F1')
      await scheduler.run(makeExecutor({ F1: { ok: false } }).executor)
      scheduler.markDirty('F2')
      return { scheduler, id: 'F2' }
    },
  },
  missingUpstream: {
    expectedUpstreamId: 'GHOST',
    build: async () => {
      const dag = new FeatureDag()
      // 'GHOST' is never inserted -- insertNode only rejects a consumed id
      // that exists and is rolled back (dag.ts), so a dangling reference to
      // an id that never existed at all is accepted, exactly like a
      // parameter's genesis node removed by undo (WO DOC-4-R1.1's own case).
      dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['GHOST'] })
      const scheduler = new RegenScheduler(dag, new ElementMap())
      scheduler.markDirty('F2')
      return { scheduler, id: 'F2' }
    },
  },
  unsettledUpstream: {
    expectedUpstreamId: 'F1',
    build: async () => {
      const dag = new FeatureDag()
      // F1 is never touched -- FeatureStatusStore's DEFAULT_STATUS is
      // 'dirty' for any id it has never recorded a transition for, exactly
      // like a real upstream that has not yet taken its own turn this pass.
      dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
      dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
      const scheduler = new RegenScheduler(dag, new ElementMap())
      scheduler.markDirty('F2')
      return { scheduler, id: 'F2' }
    },
  },
  executable: {
    build: async () => {
      const dag = new FeatureDag()
      dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
      dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
      const scheduler = new RegenScheduler(dag, new ElementMap())
      // Settle F1 as 'ok' first, so F2's own upstream is fully settled and
      // clean -- nothing left to block or unsettle F2's disposition.
      scheduler.markDirty('F1')
      await scheduler.run(makeExecutor({ F1: { ok: true } }).executor)
      scheduler.markDirty('F2')
      return { scheduler, id: 'F2' }
    },
  },
}

describe.each(PASS_DISPOSITIONS)("RegenScheduler.dispositionOf drift table (WO UI-51A-R5, audit MAJOR 2): '%s'", (kind) => {
  it(`classifies a currently-dirty node as '${kind}'`, async () => {
    const scenario = SCENARIOS[kind]
    if (scenario === undefined) {
      throw new Error(
        `No drift-test scenario registered for PASS_DISPOSITIONS entry '${kind}' -- ` +
          'a new scheduler disposition value must be classified here before it ships.',
      )
    }
    const { scheduler, id } = await scenario.build()
    const result = scheduler.dispositionOf(id)
    expect(result.kind).toBe(kind)
    if (scenario.expectedUpstreamId !== undefined) expect(result.upstreamId).toBe(scenario.expectedUpstreamId)
  })
})

// Completeness sentinel: every PASS_DISPOSITIONS entry must have a scenario.
// If this ever fails, describe.each above silently ran fewer cases than the
// const declares (e.g. a duplicate/malformed entry) -- this makes that a
// single, obviously-named failure instead of a quiet undercount.
describe('RegenScheduler.dispositionOf drift table completeness', () => {
  it('registers exactly one scenario per PASS_DISPOSITIONS entry, no more, no fewer', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...PASS_DISPOSITIONS].sort())
  })
})
