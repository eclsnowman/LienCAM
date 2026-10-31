// @vitest-environment jsdom
//
// WO UI-18-R2 (Item 1, audit major): editEntryFor must be TOTAL over its
// input domain (nodeId: string) with exactly three outcome classes --
// genesis id -> explicit omission (undefined), checked FIRST, before any dag
// lookup; missing non-genesis id -> invariant failure (throw), never a bare
// `undefined` masquerading as genesis omission; known DagNodeKind -> an
// entry (onEdit) or a named disabled reason via the exhaustive switch. R1's
// bug was exactly that the second class collapsed into the first (a stale
// selected id and a genesis id were indistinguishable to a caller -- both
// silently `undefined`). This file is the domain-path census the audit
// asked for: one test per outcome class, calling the resolver DIRECTLY via
// the `editEntryFor` test seam (SolidsWorkbenchHooks) rather than only
// through a UI affordance, so the full DagNodeKind space (including 'body'
// and 'import', which no UI-driven test reaches) is covered in one place. A
// dag change (new DagNodeKind, new opType) that isn't reflected here is
// exactly what this census exists to catch.
//
// Fake kernel/scene-runtime (createFakeGeomClient/fakeCreateSceneRuntime,
// SolidsWorkbenchPage.delete.test.tsx's own precedent): editEntryFor is a
// pure function of node.kind/payload plus isGenesisNodeId -- it never calls
// the kernel, so a real occt-wasm boot buys nothing here but ~20s/test.
// Nodes for kinds no ordinary UI action can produce standalone (body,
// import, an arbitrary non-genesis datum) are seeded directly via
// InsertNodeCommand through the exposed `history` seam, the same idiom
// SolidsWorkbenchPage.sketchOnFaceDegrade.test.tsx already uses for
// RemoveNodeCommand.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { InsertNodeCommand, RemoveNodeCommand, ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID } from '../../doc'
import { WORKBENCH_BODY_OP_TYPES } from '../../components/model3d/bodyLineage'

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

async function boot(): Promise<void> {
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
}

describe('SolidsWorkbenchPage editEntryFor domain census (WO UI-18-R2, Item 1)', () => {
  it('genesis id (Origin, XY base plane): explicit omission (undefined) -- the ONLY silent-undefined path left', async () => {
    await boot()
    expect(hooks().editEntryFor(ORIGIN_NODE_ID)).toBeUndefined()
    expect(hooks().editEntryFor(BASE_PLANE_XY_NODE_ID)).toBeUndefined()
  })

  it('a stale non-genesis id (node removed AFTER selection, selectedId left stale): invariant failure, never silent undefined', async () => {
    await boot()
    hooks().history.execute(new InsertNodeCommand({ id: 'F1', kind: 'feature', payload: { opType: 'extrude' } }))
    expect(hooks().editEntryFor('F1')).toBeDefined()
    // Removed via the SAME RemoveNodeCommand class the tree's Delete key/undo
    // stack uses, through the raw `history` seam -- bypassing deleteFeature's
    // own selectedId-clearing (SolidsWorkbenchPage.tsx's handleDeleteFeature),
    // exactly reproducing "another caller or stale selected ID" (the audit's
    // own words) reaching editEntryFor after its node is gone.
    hooks().history.execute(new RemoveNodeCommand('F1'))
    expect(hooks().dag.getNode('F1')).toBeUndefined()
    expect(() => hooks().editEntryFor('F1')).toThrow(/not found in dag/)
  })

  it('feature kind, dialog-backed opType (extrude, revolve, boolean, pushPull, fillet, chamfer, shell, draft, hole, sweep, loft, defeature, resizeHole): editable entry (onEdit)', async () => {
    await boot()
    hooks().history.execute(new InsertNodeCommand({ id: 'F1', kind: 'feature', payload: { opType: 'extrude' } }))
    hooks().history.execute(new InsertNodeCommand({ id: 'F2', kind: 'feature', payload: { opType: 'revolve' } }))
    // WO UI-80: push/pull is now editable-after-the-fact (a distance/direction dialog).
    hooks().history.execute(new InsertNodeCommand({ id: 'F3', kind: 'feature', consumes: ['F1'], refs: [{ id: 'FACE', kind: 'single-face' }], payload: { opType: 'pushPull', ownerId: 'F1', delta: 3, normal: { x: 0, y: 0, z: 1 } } }))
    for (const [id, opType] of [['F4', 'fillet'], ['F5', 'chamfer'], ['F6', 'shell'], ['F7', 'draft'], ['F8', 'boolean'], ['F9', 'hole'], ['F10', 'sweep'], ['F11', 'loft'], ['F12', 'defeature'], ['F13', 'resizeHole']] as const) {
      hooks().history.execute(new InsertNodeCommand({ id, kind: 'feature', payload: { opType, ownerId: 'F1', featureKey: 'hole:0:0:0:0:0:1:1', currentDiameter: 2, newDiameter: 3 } }))
    }
    const extrudeEntry = hooks().editEntryFor('F1')
    const revolveEntry = hooks().editEntryFor('F2')
    const pushPullEntry = hooks().editEntryFor('F3')
    expect(extrudeEntry !== undefined && 'onEdit' in extrudeEntry).toBe(true)
    expect(revolveEntry !== undefined && 'onEdit' in revolveEntry).toBe(true)
    expect(pushPullEntry !== undefined && 'onEdit' in pushPullEntry).toBe(true)
    for (const id of ['F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13']) {
      const entry = hooks().editEntryFor(id)
      expect(entry !== undefined && 'onEdit' in entry).toBe(true)
    }
  })

  // BK-174 closed-domain census: editEntryFor must be TOTAL over the
  // WORKBENCH_BODY_OP_TYPES registry (the schema source, not a hand list) -- a
  // future opType added to the registry with no editEntryFor case (neither an
  // onEdit dialog nor a named disabled reason) fails HERE. Can-fail: deleting the
  // 'pushPull' editEntryFor branch drops it from the onEdit set and trips the
  // dialog-backed expectation below.
  it('every WORKBENCH_BODY_OP_TYPES op resolves to onEdit or a named reason (no silent gap)', async () => {
    await boot()
    // BK-174: sweep and loft joined the dialog-backed set (SweepDialog/
    // LoftDialog reopen in edit mode); defeature and resizeHole also resolve
    // to onEdit (handleEditDefeature/handleEditResizeHole), though their own
    // dedicated tests elsewhere cover the ACTUAL reopen (they need a real
    // recognized body, which this closed-domain InsertNodeCommand shape
    // can't seed -- this loop only checks that the resolver routes to
    // onEdit, not that the callback succeeds).
    const dialogBacked = new Set(['extrude', 'revolve', 'boolean', 'pushPull', 'fillet', 'chamfer', 'shell', 'draft', 'hole', 'sweep', 'loft', 'defeature', 'resizeHole', 'form', 'relief', 'bodyTransform'])
    WORKBENCH_BODY_OP_TYPES.forEach((opType, i) => {
      const id = `F${i}`
      hooks().history.execute(new InsertNodeCommand({ id, kind: 'feature', payload: { opType, ownerId: 'F0' } }))
      const entry = hooks().editEntryFor(id)
      expect(entry).toBeDefined()
      const hasOnEdit = entry !== undefined && 'onEdit' in entry
      const hasReason = entry !== undefined && 'reason' in entry
      expect(hasOnEdit || hasReason).toBe(true)
      expect(hasOnEdit).toBe(dialogBacked.has(opType))
    })
  })

  it('sketch kind, a package sketch (payload.sketch is a Sketch object): editable entry (onEdit)', async () => {
    await boot()
    hooks().history.execute(new InsertNodeCommand({ id: 'SK1', kind: 'sketch', payload: { sketch: { entities: [] } } }))
    const entry = hooks().editEntryFor('SK1')
    expect(entry !== undefined && 'onEdit' in entry).toBe(true)
  })

  it('sketch kind, a rectangle-payload sketch (no payload.sketch): disabled with a named reason -- RECT-DIALOG-REMOVAL', async () => {
    await boot()
    hooks().history.execute(new InsertNodeCommand({ id: 'SK1', kind: 'sketch', payload: { width: 40, height: 20 } }))
    const entry = hooks().editEntryFor('SK1')
    expect(entry !== undefined && 'reason' in entry).toBe(true)
    expect((entry as { reason: string }).reason).toMatch(/legacy rectangle sketch/i)
  })

  it('datum kind, non-genesis (an auto-created face-plane datum): disabled with a named reason', async () => {
    await boot()
    hooks().history.execute(new InsertNodeCommand({ id: 'datum:SK2', kind: 'datum', payload: {} }))
    const entry = hooks().editEntryFor('datum:SK2')
    expect(entry !== undefined && 'reason' in entry).toBe(true)
    expect((entry as { reason: string }).reason).toMatch(/support datum is managed by its consuming feature/i)
  })

  it('parameter kind: disabled with a named reason', async () => {
    await boot()
    hooks().history.execute(new InsertNodeCommand({ id: 'param:len', kind: 'parameter', payload: { expression: '20' } }))
    const entry = hooks().editEntryFor('param:len')
    expect(entry !== undefined && 'reason' in entry).toBe(true)
    expect((entry as { reason: string }).reason).toMatch(/parameters have no edit dialog/i)
  })

  it('body kind: disabled with a named reason (no UI-driven test reaches this kind directly)', async () => {
    await boot()
    hooks().history.execute(new InsertNodeCommand({ id: 'body:B1', kind: 'body', payload: {} }))
    const entry = hooks().editEntryFor('body:B1')
    expect(entry !== undefined && 'reason' in entry).toBe(true)
    expect((entry as { reason: string }).reason).toMatch(/bodies have no edit dialog/i)
  })

  it('import kind: disabled with a named reason (no UI-driven test reaches this kind directly)', async () => {
    await boot()
    hooks().history.execute(new InsertNodeCommand({ id: 'import:IMP1', kind: 'import', payload: {} }))
    const entry = hooks().editEntryFor('import:IMP1')
    expect(entry !== undefined && 'reason' in entry).toBe(true)
    expect((entry as { reason: string }).reason).toMatch(/imported geometry has no edit dialog/i)
  })
})
