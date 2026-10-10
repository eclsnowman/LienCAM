// WO UI-3-R2 regression test: editing a feature's payload must NOT erase its
// regen-derived metadata (degraded / diagnostics / lastGoodBoundTo). The
// prior implementation reinserted a FRESH node (insertNode with only
// id/kind/consumes/refs/payload), silently resetting degraded=false,
// diagnostics=[], lastGoodBoundTo={} on every edit -- exactly the metadata
// docs/stable-id-spec.md:45 says must survive so repair flows and
// re-resolution keep working. This test seeds a node that already has that
// metadata populated (via FeatureDag.restore, the same structural-identity
// surface serialize() round-trips through) and asserts it SURVIVES the edit.

import { describe, it, expect } from 'vitest'
import { FeatureDag, type DagNodeSnapshot } from '../../doc'
import { EditFeaturePayloadCommand } from '../../components/model3d/dialogs'

function seedDegradedDag(): FeatureDag {
  const node: DagNodeSnapshot = {
    id: 'F1',
    kind: 'feature',
    consumes: [],
    refs: [{ id: 'E1', kind: 'single-face' }],
    payload: { name: 'Box', size: { x: 10, y: 20, z: 5 } },
    degraded: true,
    diagnostics: [{ code: 'REFERENCE_UNRESOLVED', severity: 'warning', params: { id: 'E1' } }],
    lastGoodBoundTo: { E1: ['E1#v0'] },
    suppressed: false,
    hidden: false,
  }
  return FeatureDag.restore(JSON.stringify({ nodes: [node] }))
}

describe('EditFeaturePayloadCommand (WO UI-3-R2 regression)', () => {
  it('preserves degraded/diagnostics/lastGoodBoundTo across a payload edit', () => {
    const dag = seedDegradedDag()
    const before = dag.getNode('F1') as DagNodeSnapshot
    expect(before.degraded).toBe(true)
    expect(before.diagnostics).toHaveLength(1)
    expect(before.lastGoodBoundTo).toEqual({ E1: ['E1#v0'] })

    const cmd = new EditFeaturePayloadCommand('F1', { name: 'Box', size: { x: 99, y: 20, z: 5 } })
    cmd.do(dag)

    const after = dag.getNode('F1') as DagNodeSnapshot
    expect(after.payload.size).toEqual({ x: 99, y: 20, z: 5 })
    expect(after.degraded).toBe(true)
    expect(after.diagnostics).toEqual(before.diagnostics)
    expect(after.lastGoodBoundTo).toEqual({ E1: ['E1#v0'] })
    // consumes/refs (structural edges) also survive untouched.
    expect(after.refs).toEqual(before.refs)
  })

  it('undo restores the original payload AND the original degraded metadata', () => {
    const dag = seedDegradedDag()
    const cmd = new EditFeaturePayloadCommand('F1', { name: 'Box', size: { x: 99, y: 20, z: 5 } })
    cmd.do(dag)
    cmd.undo(dag)

    const restored = dag.getNode('F1') as DagNodeSnapshot
    expect(restored.payload.size).toEqual({ x: 10, y: 20, z: 5 })
    expect(restored.degraded).toBe(true)
    expect(restored.diagnostics).toHaveLength(1)
    expect(restored.lastGoodBoundTo).toEqual({ E1: ['E1#v0'] })
  })

  it('optionally rewrites refs in the same undo-safe edit step', () => {
    const dag = seedDegradedDag()
    const cmd = new EditFeaturePayloadCommand(
      'F1',
      { name: 'Fillet F1', edges: ['E1'] },
      [],
      [],
    )

    cmd.do(dag)
    expect(dag.getNode('F1')?.refs).toEqual([])
    expect(dag.getNode('F1')?.payload).toEqual({ name: 'Fillet F1', edges: ['E1'] })

    cmd.undo(dag)
    expect(dag.getNode('F1')?.refs).toEqual([{ id: 'E1', kind: 'single-face' }])
    expect(dag.getNode('F1')?.payload).toEqual({ name: 'Box', size: { x: 10, y: 20, z: 5 } })
  })
})
