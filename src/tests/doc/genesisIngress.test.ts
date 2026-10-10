// WO SKC-15C (audit major #2, verbatim): "Reserved genesis IDs are not protected at DAG ingress.
// Generic insertNode, restoreNode, and FeatureDag.restore accept those IDs with arbitrary kinds and
// payloads, while seedGenesisNodes skips any ID that already exists and does not repair order. This
// can create an immortal ordinary feature/body masquerading [as a genesis node]."
//
// Each masquerade the auditor's probe built is reproduced here and asserted to be REFUSED BY NAME.
// The word "immortal" is the point: a fake genesis node, once created, could never be removed --
// removeNode/setSuppressed refuse reserved ids by name -- so the ingress guard is the ONLY line of
// defence, and it must be fail-closed at every accept point, not just at the obvious one.
//
// These are the accept points, each with its own refusal:
//   insertNode         GenesisIngressError -- the generic insert path refuses reserved ids outright.
//   restoreNode        GenesisIngressError -- the undo-restore path, same.
//   installGenesisNode GenesisShapeError   -- even the ONE sanctioned path refuses a non-canonical shape.
//   FeatureDag.restore drops a non-canonical genesis node from an untrusted archive (fail-closed).
//   seedGenesisNodes   REPAIRS a malformed/partial/scrambled seed to the canonical front, in shape.
import { describe, it, expect } from 'vitest'
import {
  BASE_PLANE_XY_NODE_ID,
  BASE_PLANE_YZ_NODE_ID,
  FeatureDag,
  GENESIS_NODE_IDS,
  GenesisIngressError,
  GenesisShapeError,
  ORIGIN_NODE_ID,
  isCanonicalGenesisShape,
} from '../../doc'
import { seedGenesisNodes, BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'

const FEATURE_A = 'F1'

function seeded(): FeatureDag {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  return dag
}

/** The canonical payloads, rebuilt here so the tests do not depend on basePlanes' private builders. */
const CANON_ORIGIN = { datumType: 'origin', name: 'Origin' }
const canonPlane = (basePlane: 'xy' | 'xz' | 'yz') => ({
  datumType: 'plane', planeKind: 'base-plane', basePlane, lastGoodFrame: BASE_PLANE_FRAMES[basePlane], name: basePlane.toUpperCase(),
})

describe('WO SKC-15C: the canonical-shape predicate judges reserved ids only', () => {
  it('accepts the true shapes and rejects every masquerade', () => {
    expect(isCanonicalGenesisShape(ORIGIN_NODE_ID, 'datum', CANON_ORIGIN)).toBe(true)
    expect(isCanonicalGenesisShape(BASE_PLANE_XY_NODE_ID, 'datum', canonPlane('xy'))).toBe(true)

    // Wrong kind.
    expect(isCanonicalGenesisShape(ORIGIN_NODE_ID, 'feature', CANON_ORIGIN)).toBe(false)
    expect(isCanonicalGenesisShape(BASE_PLANE_XY_NODE_ID, 'body', canonPlane('xy'))).toBe(false)
    // Right kind, wrong payload discriminant.
    expect(isCanonicalGenesisShape(ORIGIN_NODE_ID, 'datum', {})).toBe(false)
    expect(isCanonicalGenesisShape(ORIGIN_NODE_ID, 'datum', canonPlane('xy'))).toBe(false) // a plane on the Origin id
    // Right kind + type, wrong plane identity (XY's id carrying YZ's payload).
    expect(isCanonicalGenesisShape(BASE_PLANE_XY_NODE_ID, 'datum', canonPlane('yz'))).toBe(false)
    // A non-genesis id is never "canonical genesis" -- this predicate judges reserved ids only.
    expect(isCanonicalGenesisShape(FEATURE_A, 'datum', CANON_ORIGIN)).toBe(false)
  })
})

describe('WO SKC-15C: insertNode refuses reserved genesis ids by name', () => {
  it('rejects the exact probe the auditor ran: insertNode({id:origin, kind:feature})', () => {
    const dag = new FeatureDag() // not yet seeded, so this is not an already-exists throw
    // FAILS-IF the pre-SKC-15C behavior returns: this call SUCCEEDED and seeded an immortal fake Origin.
    expect(() => dag.insertNode({ id: ORIGIN_NODE_ID, kind: 'feature', consumes: [], refs: [], payload: {} }))
      .toThrow(GenesisIngressError)
    expect(dag.has(ORIGIN_NODE_ID)).toBe(false)
  })

  it('rejects a reserved id EVEN in its canonical shape -- generic insert is not the construction path', () => {
    const dag = new FeatureDag()
    // The generic path refuses reserved ids unconditionally; canonical genesis comes ONLY through
    // installGenesisNode. This is what makes "reject in generic paths, one controlled path" true.
    expect(() => dag.insertNode({ id: BASE_PLANE_XY_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: canonPlane('xy') }))
      .toThrow(GenesisIngressError)
  })

  it('reports the reservation BEFORE the already-exists error on a seeded dag', () => {
    const dag = seeded()
    let err: unknown
    try { dag.insertNode({ id: BASE_PLANE_XY_NODE_ID, kind: 'body', consumes: [], refs: [], payload: {} }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(GenesisIngressError)
    // ...and the real XY node is untouched.
    expect(dag.getNode(BASE_PLANE_XY_NODE_ID)!.kind).toBe('datum')
  })
})

describe('WO SKC-15C: restoreNode refuses reserved genesis ids by name', () => {
  it('rejects restoreNode(datum:XY as kind feature) -- the auditor built this one directly', () => {
    const dag = new FeatureDag()
    const fakeSnapshot = {
      id: BASE_PLANE_XY_NODE_ID, kind: 'feature' as const, consumes: [], refs: [], payload: {},
      degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false, hidden: false,
    }
    expect(() => dag.restoreNode(fakeSnapshot)).toThrow(GenesisIngressError)
    expect(dag.has(BASE_PLANE_XY_NODE_ID)).toBe(false)
  })
})

describe('WO SKC-15C: installGenesisNode is the one construction path, and it validates its own input', () => {
  it('refuses a non-canonical shape even though it is the sanctioned path', () => {
    const dag = new FeatureDag()
    // FAILS-IF installGenesisNode blindly trusts its caller: a fake could then be minted through the
    // one door that is supposed to be safe.
    expect(() => dag.installGenesisNode({ id: ORIGIN_NODE_ID, kind: 'feature', consumes: [], refs: [], payload: {} }))
      .toThrow(GenesisShapeError)
    expect(() => dag.installGenesisNode({ id: BASE_PLANE_XY_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: canonPlane('yz') }))
      .toThrow(GenesisShapeError)
    expect(dag.has(ORIGIN_NODE_ID)).toBe(false)
  })

  it('installs the canonical shape, and re-installing is an idempotent replace', () => {
    const dag = new FeatureDag()
    dag.installGenesisNode({ id: ORIGIN_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: CANON_ORIGIN })
    expect(dag.getNode(ORIGIN_NODE_ID)!.kind).toBe('datum')
    // Re-install: still exactly one node, still at one timeline slot.
    dag.installGenesisNode({ id: ORIGIN_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: CANON_ORIGIN })
    expect(dag.featureOrder().filter((id) => id === ORIGIN_NODE_ID)).toEqual([ORIGIN_NODE_ID])
  })
})

describe('WO SKC-15C: FeatureDag.restore drops a non-canonical genesis node from an untrusted archive', () => {
  it('a hand-edited archive with origin as kind feature and datum:XY as kind body loses BOTH fakes', () => {
    // Build a serialized document by hand: two corrupt genesis nodes + one real feature.
    const corrupt = JSON.stringify({
      nodes: [
        { id: ORIGIN_NODE_ID, kind: 'feature', consumes: [], refs: [], payload: { opType: 'extrude' }, degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false },
        { id: BASE_PLANE_XY_NODE_ID, kind: 'body', consumes: [], refs: [], payload: {}, degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false },
        { id: FEATURE_A, kind: 'feature', consumes: [], refs: [], payload: { opType: 'extrude' }, degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false },
      ],
      order: [ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, FEATURE_A],
    })
    const dag = FeatureDag.restore(corrupt)
    // FAILS-IF restore materializes them: an immortal fake Origin/plane, undeletable forever.
    expect(dag.has(ORIGIN_NODE_ID)).toBe(false)
    expect(dag.has(BASE_PLANE_XY_NODE_ID)).toBe(false)
    // The ordinary feature survives untouched.
    expect(dag.has(FEATURE_A)).toBe(true)
    expect(dag.restoredDroppedGenesisIds().sort()).toEqual([BASE_PLANE_XY_NODE_ID, ORIGIN_NODE_ID].sort())

    // ...and the following seed rebuilds the canonical genesis in its true shape, at the front.
    seedGenesisNodes(dag)
    dag.restoreRollbackState({ featureOrder: [FEATURE_A], marker: { kind: 'end' } })
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS, FEATURE_A])
    expect(dag.getNode(ORIGIN_NODE_ID)!.kind).toBe('datum')
    expect(dag.getNode(BASE_PLANE_XY_NODE_ID)!.payload.lastGoodFrame).toEqual(BASE_PLANE_FRAMES.xy)
  })

  it('a CANONICAL genesis node in the archive is kept, and the following seed leaves it canonical', () => {
    const clean = seeded()
    const dag = FeatureDag.restore(clean.serialize())
    expect(dag.restoredDroppedGenesisIds()).toEqual([])
    expect(dag.has(ORIGIN_NODE_ID)).toBe(true)
    seedGenesisNodes(dag)
    expect(dag.getNode(BASE_PLANE_YZ_NODE_ID)!.payload.basePlane).toBe('yz')
  })
})

describe('WO SKC-15C: seedGenesisNodes REPAIRS a partial or scrambled seed (the auditor case)', () => {
  it('a timeline seeded with only two planes, in the wrong order, becomes the canonical prefix', () => {
    // The auditor's exact case: an existing [datum:YZ, datum:XY, F1] timeline, then seed.
    const dag = new FeatureDag()
    dag.installGenesisNode({ id: BASE_PLANE_YZ_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: canonPlane('yz') })
    dag.installGenesisNode({ id: BASE_PLANE_XY_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: canonPlane('xy') })
    dag.insertNode({ id: FEATURE_A, kind: 'feature', consumes: [], refs: [], payload: {} })
    expect(dag.featureOrder()).toEqual([BASE_PLANE_YZ_NODE_ID, BASE_PLANE_XY_NODE_ID, FEATURE_A])

    seedGenesisNodes(dag)
    // FAILS-IF seedGenesisNodes still inserts at fixed indices without reseating: the auditor got
    // [origin, datum:YZ, datum:XZ, datum:XY, F1], NOT the canonical prefix.
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS, FEATURE_A])
  })

  it('seeding an already-canonical document is idempotent (no duplication, no reorder)', () => {
    const dag = seeded()
    dag.insertNode({ id: FEATURE_A, kind: 'feature', consumes: [], refs: [], payload: {} })
    const before = dag.featureOrder()
    seedGenesisNodes(dag)
    expect(dag.featureOrder()).toEqual(before)
  })
})
