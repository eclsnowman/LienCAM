// CAM-1 (D2) — store hook integration for the re-resolution authority
// (useCamStore.reresolveModelReferences), driven through the REAL zustand store
// (autoStock.test.ts pattern). Proves:
//   (a) a regen that changes / orphans a referenced body flips EXACTLY the
//       referencing ops (and no others) to outdated / degraded;
//   (b) degraded is STICKY across a second clean regen, then clears on success;
//   (c) the async staleness guard: an out-of-order (older-seq) apply is IGNORED
//       so the NEWEST regen wins the last write -- settled by a CONSTRUCTED
//       interleave (post-await/post-mutation stale apply), never event-loop prose;
//   (d) a malformed resolver reply refuses BY NAME and mutates NOTHING.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type {
  Operation, Setup, WCS, HeightParams, PassParams, LinkingParams, ToolpathMove,
} from '../../types'
import type { ModelReference } from '../../lib/cam/types'
import type { BodyResolution, RawResolution } from '../../lib/cam/modelReferenceResolution'

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const MOVE = { type: 'rapid', x: 0, y: 0, z: 5 } as ToolpathMove

function makeWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
}
function op(id: string, refs: ModelReference[] | undefined, status: Operation['status'] = 'ready'): Operation {
  return {
    id, name: id, type: 'contour_2d', enabled: true, status,
    toolId: 'tool-1', geometrySelections: [],
    modelReferences: refs,
    heights, passes, linking, params: {},
    toolpathMoves: [MOVE],
  }
}
function makeSetup(ops: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations: ops, notes: '',
  }
}
function body(bodyId: string, changed: boolean, resolutions: RawResolution[]): BodyResolution {
  return { bodyId, changed, resolutions }
}

const store = () => useCamStore.getState()
const opById = (id: string): Operation =>
  store().project.setups[0].operations.find(o => o.id === id)!

function install(ops: Operation[]): void {
  useCamStore.setState(s => ({
    lastModelReresolveSeq: 0,
    project: { ...s.project, geometry: [], setups: [makeSetup(ops)] },
  }))
}

describe('store.reresolveModelReferences: flips exactly the referencing ops', () => {
  beforeEach(() => {
    install([
      op('op-A', [{ bodyId: 'B1', stableIds: ['f1'], role: 'machining-boundary' }]),
      op('op-B', [{ bodyId: 'B2', stableIds: ['g1'], role: 'avoid' }]),
      op('op-C', undefined), // references no model geometry
    ])
  })

  it('changed body -> stale (outdated); lost body -> degraded (toolpath retained); non-ref op untouched', () => {
    const changed = store().reresolveModelReferences([
      body('B1', true, [{ id: 'f1', status: 'exact' }]),   // moved -> stale
      body('B2', false, [{ id: 'g1', status: 'lost' }]),   // gone  -> degraded
    ])
    expect(new Set(changed)).toEqual(new Set(['op-A', 'op-B']))
    expect(opById('op-A').status).toBe('outdated')
    // S5 audit DEFECT 1 ruling 2026-07-22: amber (outdated) RETAINS the
    // pre-edit toolpath, same as degraded below.
    expect(opById('op-A').toolpathMoves).toEqual([MOVE])
    expect(opById('op-B').status).toBe('degraded')
    expect(opById('op-B').toolpathMoves).toEqual([MOVE]) // last-known toolpath retained
    expect(opById('op-C').status).toBe('ready')          // no reference -> untouched
  })

  it('all-exact unchanged -> nothing flips (op stays ready)', () => {
    const changed = store().reresolveModelReferences([
      body('B1', false, [{ id: 'f1', status: 'exact' }]),
      body('B2', false, [{ id: 'g1', status: 'exact' }]),
    ])
    expect(changed).toEqual([])
    expect(opById('op-A').status).toBe('ready')
    expect(opById('op-B').status).toBe('ready')
  })

  it('degraded is STICKY across a clean regen, then CLEARS on a fully-exact re-resolution', () => {
    // Regen 1: B1 lost -> op-A degraded.
    store().reresolveModelReferences([
      body('B1', false, [{ id: 'f1', status: 'lost' }]),
      body('B2', false, [{ id: 'g1', status: 'exact' }]),
    ])
    expect(opById('op-A').status).toBe('degraded')

    // Regen 2: B1 still lost -> STAYS degraded (sticky).
    store().reresolveModelReferences([
      body('B1', false, [{ id: 'f1', status: 'lost' }]),
      body('B2', false, [{ id: 'g1', status: 'exact' }]),
    ])
    expect(opById('op-A').status).toBe('degraded')

    // Regen 3: B1 comes back exact + unchanged -> stickiness lifts to outdated.
    store().reresolveModelReferences([
      body('B1', false, [{ id: 'f1', status: 'exact' }]),
      body('B2', false, [{ id: 'g1', status: 'exact' }]),
    ])
    expect(opById('op-A').status).toBe('outdated')
    expect(opById('op-A').modelReferenceNote).toBeUndefined()
  })
})

describe('store.reresolveModelReferences: async staleness guard (constructed interleave)', () => {
  beforeEach(() => {
    install([op('op-A', [{ bodyId: 'B1', stableIds: ['f1'], role: 'machining-boundary' }])])
  })

  it('an out-of-order OLDER-seq apply is ignored -> newest regen wins the last write', () => {
    // Two overlapping regens race. resolve() for regen#2 (seq=2, B1 LOST) lands
    // and applies FIRST; then regen#1's stale resolve (seq=1, B1 merely changed)
    // lands LAST. Without the guard the stale write would DOWNGRADE degraded to
    // outdated. With it, seq=1 <= lastSeq(2) is dropped.
    const applied2 = store().reresolveModelReferences([body('B1', false, [{ id: 'f1', status: 'lost' }])], 2)
    expect(applied2).toEqual(['op-A'])
    expect(opById('op-A').status).toBe('degraded')

    const applied1 = store().reresolveModelReferences([body('B1', true, [{ id: 'f1', status: 'exact' }])], 1)
    expect(applied1).toEqual([]) // ignored as stale
    expect(opById('op-A').status).toBe('degraded') // NEWEST regen (#2) still wins
  })

  it('a stale apply after a POST-AWAIT user mutation does not clobber the fresh state', () => {
    // regen#5 marks op-A outdated (seq=5). During the async gap the user recomputes
    // op-A back to ready. Then an older regen#3 resolve lands late (seq=3) -> ignored.
    store().reresolveModelReferences([body('B1', true, [{ id: 'f1', status: 'exact' }])], 5)
    expect(opById('op-A').status).toBe('outdated')

    // User recompute (post-await store mutation).
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        setups: s.project.setups.map(su => ({
          ...su,
          operations: su.operations.map(o => o.id === 'op-A' ? { ...o, status: 'ready' as const, toolpathMoves: [MOVE] } : o),
        })),
      },
    }))
    expect(opById('op-A').status).toBe('ready')

    // A late older-regen result must NOT re-flag the freshly-recomputed op.
    const applied3 = store().reresolveModelReferences([body('B1', true, [{ id: 'f1', status: 'exact' }])], 3)
    expect(applied3).toEqual([])
    expect(opById('op-A').status).toBe('ready')
  })

  it('the guard advances the high-water mark even when no op changed', () => {
    // seq=4 all-exact-unchanged: nothing flips, but lastSeq must still advance so
    // a later seq=4 (or lower) apply is rejected.
    store().reresolveModelReferences([body('B1', false, [{ id: 'f1', status: 'exact' }])], 4)
    expect(store().lastModelReresolveSeq).toBe(4)
    const applied = store().reresolveModelReferences([body('B1', false, [{ id: 'f1', status: 'lost' }])], 4)
    expect(applied).toEqual([]) // seq 4 <= 4 rejected
    expect(opById('op-A').status).toBe('ready')
  })
})

// ── finding 2: the POST-AWAIT USER-MUTATION race, settled by a DEFERRED-PROMISE
//    interleave (a real async gap, not event-loop prose) ───────────────────────
describe('store.reresolveModelReferences: deferred-promise post-await user-mutation guard', () => {
  const NEW_MOVE = { type: 'feed', x: 5, y: 5, z: -1 } as ToolpathMove

  beforeEach(() => {
    install([op('op-A', [{ bodyId: 'B1', stableIds: ['f1'], role: 'machining-boundary' }])])
  })

  // Faithfully models SolidsWorkbenchPage.reresolveCamModelRefs: CAPTURE the
  // per-op fingerprint BEFORE the async resolve(), await the gate (the resolve()
  // gap), THEN apply through the real store action with that fingerprint.
  async function drivenReresolve(bodies: BodyResolution[], seq: number, gate: Promise<void>): Promise<string[]> {
    const expectedOps = new Map<string, Operation>()
    for (const setup of store().project.setups)
      for (const o of setup.operations)
        if ((o.modelReferences?.length ?? 0) > 0) expectedOps.set(o.id, o)
    await gate // <-- the resolve() await gap; a user mutation can land here
    return store().reresolveModelReferences(bodies, seq, expectedOps)
  }

  function userRecompute(moves: ToolpathMove[]): void {
    // A plain user recompute -- NOT routed through reresolve -- so the seq
    // high-water is untouched (this is exactly why the seq guard alone cannot
    // catch it: seq=1 still passes against high-water 0).
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        setups: s.project.setups.map(su => ({
          ...su,
          operations: su.operations.map(o => o.id === 'op-A' ? { ...o, status: 'ready' as const, toolpathMoves: moves } : o),
        })),
      },
    }))
  }

  it('THE reproduced defect: regen 1 starts, user recomputes after suspension, regen 1 releases LAST -> refused (not clobbered)', async () => {
    // seq=1 against high-water 0: the seq guard PASSES it, so ONLY the fingerprint
    // guard can save the freshly-recomputed op. Without the fix this apply flips
    // op-A ready->outdated and drops NEW_MOVE (the auditor's exact reproduction).
    let release1!: () => void
    const gate1 = new Promise<void>(r => { release1 = r })
    const regen1 = drivenReresolve([body('B1', true, [{ id: 'f1', status: 'exact' }])], 1, gate1)

    // User recompute DURING regen 1's suspension: a NEW op reference + toolpath.
    userRecompute([NEW_MOVE])
    expect(opById('op-A').status).toBe('ready')

    // Release regen 1 last; its outcome was computed against pre-mutation state.
    release1()
    const applied1 = await regen1

    expect(applied1).toEqual([])                        // refused (fingerprint mismatch)
    expect(opById('op-A').status).toBe('ready')          // NOT clobbered
    expect(opById('op-A').toolpathMoves).toEqual([NEW_MOVE]) // fresh toolpath intact

    // A FRESH regen (captures the current op) DOES re-flag it -> the guard is not
    // a blanket freeze, only a stale-apply refusal.
    const applied2 = await drivenReresolve([body('B1', true, [{ id: 'f1', status: 'exact' }])], 2, Promise.resolve())
    expect(applied2).toEqual(['op-A'])
    expect(opById('op-A').status).toBe('outdated')
  })

  it('adversarial release order: regen 1 + regen 2 both suspended, user mutation between, released newest-first then oldest', async () => {
    // regen 1 captures R0 and suspends. User recompute -> R1. regen 2 captures R1
    // and suspends (B1 now LOST). Release regen 2 (seq=2) FIRST -> applies degraded.
    // Release regen 1 (seq=1) LAST -> BOTH guards refuse it: seq 1 <= high-water 2
    // AND its fingerprint R0 != current. Newest regen wins the last write.
    let release1!: () => void, release2!: () => void
    const gate1 = new Promise<void>(r => { release1 = r })
    const gate2 = new Promise<void>(r => { release2 = r })

    const regen1 = drivenReresolve([body('B1', true, [{ id: 'f1', status: 'exact' }])], 1, gate1)
    userRecompute([NEW_MOVE])
    const regen2 = drivenReresolve([body('B1', false, [{ id: 'f1', status: 'lost' }])], 2, gate2)

    release2()
    const applied2 = await regen2
    expect(applied2).toEqual(['op-A'])
    expect(opById('op-A').status).toBe('degraded')       // regen 2 landed
    expect(opById('op-A').toolpathMoves).toEqual([NEW_MOVE]) // degraded retains toolpath

    release1()
    const applied1 = await regen1
    expect(applied1).toEqual([])                          // stale regen 1 refused
    expect(opById('op-A').status).toBe('degraded')        // newest (regen 2) still wins
  })
})

describe('store.reresolveModelReferences: fail-loud, mutates nothing on bad data', () => {
  beforeEach(() => {
    install([op('op-A', [{ bodyId: 'B1', stableIds: ['f1'], role: 'machining-boundary' }])])
  })

  it('throws on an unknown status and leaves every op status unchanged', () => {
    expect(() => store().reresolveModelReferences([body('B1', false, [{ id: 'f1', status: 'moved' }])]))
      .toThrow(/unknown resolver status/)
    expect(opById('op-A').status).toBe('ready') // nothing mutated
  })
})
