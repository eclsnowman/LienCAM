import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FeatureDag } from '../../../doc/dag'
import { ElementMap } from '../../../doc/element-map'
import { RegenScheduler } from '../../../doc/regen'
import { genDelta, makeExecutor } from './_helpers'

// WO DOC-5 AC #5: two runs of the same edit script produce identical status
// transition logs and identical final ID sets; and the negative invariant --
// NO wall-clock read (Date.now / performance.now) anywhere in any scheduling
// decision -- is grep-proven against the regen module (the INT-H1 lesson).

// ---------------------------------------------------------------------------
// The negative invariant: no wall-clock read in the regen module source.
// ---------------------------------------------------------------------------

describe('AC #5 (negative invariant): the regen module reads no wall clock', () => {
  const read = (file: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../doc/regen/${file}`, import.meta.url)), 'utf8')

  for (const file of ['scheduler.ts', 'status.ts', 'index.ts']) {
    it(`${file} contains no Date.now / performance.now`, () => {
      const src = read(file)
      expect(src).not.toMatch(/Date\.now/)
      expect(src).not.toMatch(/performance\.now/)
    })
  }
})

// ---------------------------------------------------------------------------
// Determinism: the same edit script twice -> identical logs + final ID sets.
// ---------------------------------------------------------------------------

describe('AC #5: identical edit scripts produce identical transition logs and final ID sets', () => {
  function buildDag(): FeatureDag {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F4', kind: 'feature', consumes: ['F2', 'F3'] })
    dag.insertNode({ id: 'F5', kind: 'feature', consumes: ['F4'] })
    return dag
  }
  const ops = Object.fromEntries(
    ['F1', 'F2', 'F3', 'F4', 'F5'].map((id) => [id, { delta: genDelta(id, [`${id}:F`]) }]),
  )

  async function runScript(): Promise<{
    transitions: unknown
    statuses: unknown
    ids: string
  }> {
    const dag = buildDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)

    scheduler.markDirty('F1') // full build
    await scheduler.run(makeExecutor(ops).executor)
    scheduler.markDirty('F2') // edit an interior branch
    await scheduler.run(makeExecutor(ops).executor)
    scheduler.markDirty('F1') // re-edit the root
    await scheduler.run(makeExecutor(ops).executor)

    return {
      transitions: scheduler.transitions(),
      statuses: scheduler.statuses(),
      ids: map.serializeIds(),
    }
  }

  it('two runs match byte-for-byte on transitions, statuses, and serialized ids', async () => {
    const a = await runScript()
    const b = await runScript()
    expect(a.transitions).toEqual(b.transitions)
    expect(a.statuses).toEqual(b.statuses)
    expect(a.ids).toBe(b.ids)
    // Sanity: the script actually produced transitions (not a vacuous match).
    expect((a.transitions as unknown[]).length).toBeGreaterThan(0)
  })
})
