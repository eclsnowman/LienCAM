// WO UI-24-R2 (root-cause ruling: "completeness must be DERIVED, not listed"). This file is the
// closure PROOF criterion 1 asks for: two independent checks that a FUTURE node kind, ref kind, or
// serialized field lands as a build/test failure pointing at debugScene.ts's validator, never as a
// silent gap the loader accepts-by-default.
//
//  A. TYPE-LEVEL exhaustiveness (assertNever below): a switch over every DAG_NODE_KINDS/
//     REFERENCE_KINDS member with no `default` case. vitest strips types (WORKER-CHARTER item 11),
//     so this block proves nothing when run under vitest -- it exists to make `npm run build`
//     (the charter's actual typecheck gate, tsc -b) refuse to compile the moment a new member is
//     added to either union without a matching case here.
//  B. RUNTIME behavioral closure: NODE_RECORD_FIELDS/REF_RECORD_FIELDS (debugScene.ts's own
//     allowlists, derived from `Record<keyof DagNodeSnapshot, true>` / `Record<keyof FeatureRef,
//     true>`) are asserted against the fields a REAL FeatureDag.serialize() call actually produces.
//     debugScene.ts's own type-level proof only ties the allowlist to the DagNodeSnapshot
//     *interface* -- dag.ts's serialize() builds its node objects via a separate, hand-written
//     object literal (dag.ts's own `nodes = this.nodeIds().map(...)`) that TypeScript does not
//     structurally check against DagNodeSnapshot. A field added to the interface but forgotten in
//     that literal (or vice versa) would make the validator demand a field the real serializer
//     never emits (or silently accept one it does emit, unlisted) -- exactly the drift this test
//     exists to catch, executing against the REAL kernel-free FeatureDag/ElementMap, not a fixture.

import { describe, it, expect } from 'vitest'
import { FeatureDag, DAG_NODE_KINDS, REFERENCE_KINDS, type DagNodeKind, type ReferenceKind } from '../../doc'
import { NODE_RECORD_FIELDS, REF_RECORD_FIELDS } from '../../components/model3d/debugScene'

function assertNever(x: never): never {
  throw new Error(`debugSceneSchemaClosure: unhandled union member ${JSON.stringify(x)}`)
}

/** Type-level only (see file header, proof A) -- exercised at runtime just so the function is not
 *  dead code the bundler could drop before tsc ever sees it; the value asserted is meaningless. */
function exhaustiveNodeKindCheck(kind: DagNodeKind): string {
  switch (kind) {
    case 'sketch':
      return kind
    case 'datum':
      return kind
    case 'feature':
      return kind
    case 'body':
      return kind
    case 'import':
      return kind
    case 'meshImport':
      return kind
    case 'parameter':
      return kind
    default:
      return assertNever(kind)
  }
}

function exhaustiveRefKindCheck(kind: ReferenceKind): string {
  switch (kind) {
    case 'single-face':
      return kind
    case 'face-set':
      return kind
    case 'single-edge':
      return kind
    case 'single-vertex':
      return kind
    default:
      return assertNever(kind)
  }
}

describe('WO UI-24-R2: debug-scene schema closure', () => {
  it('proof A: every DAG_NODE_KINDS/REFERENCE_KINDS member is handled by the exhaustive switches', () => {
    for (const kind of DAG_NODE_KINDS) expect(exhaustiveNodeKindCheck(kind)).toBe(kind)
    for (const kind of REFERENCE_KINDS) expect(exhaustiveRefKindCheck(kind)).toBe(kind)
  })

  it('proof B: NODE_RECORD_FIELDS matches the fields a REAL FeatureDag.serialize() node actually has', () => {
    const dag = new FeatureDag()
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: [],
      refs: [
        { id: 'face:1', kind: 'single-face' },
        { id: 'face:2', kind: 'face-set' },
      ],
      payload: { opType: 'extrude' },
    })
    const parsed = JSON.parse(dag.serialize()) as { nodes: Array<Record<string, unknown>> }
    expect(parsed.nodes).toHaveLength(1)
    expect(Object.keys(parsed.nodes[0]).sort()).toEqual([...NODE_RECORD_FIELDS].sort())
  })

  it('proof B: REF_RECORD_FIELDS matches the fields a REAL FeatureDag.serialize() ref actually has', () => {
    const dag = new FeatureDag()
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: [],
      refs: [{ id: 'face:1', kind: 'single-face', role: 'supportFace', elementType: 'face' }],
      payload: {},
    })
    const parsed = JSON.parse(dag.serialize()) as { nodes: Array<{ refs: Array<Record<string, unknown>> }> }
    expect(parsed.nodes[0].refs).toHaveLength(1)
    expect(Object.keys(parsed.nodes[0].refs[0]).sort()).toEqual([...REF_RECORD_FIELDS].sort())
  })
})
