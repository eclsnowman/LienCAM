// @vitest-environment jsdom
//
// WO UI-51A-R3 (audit MAJOR 1, over-filtering regression --
// coordination/reports/UI-51A-R2.audit.json / UI-51A-R3.md): the shared
// lookupLiveBody gate (SolidsWorkbenchPage.tsx, defined once above
// isWorkbenchBodyOpType's check) computed eligibility from the GLOBAL raw
// leaf set every single call -- including a downstream node that is itself
// part of the SAME dirty closure (RegenScheduler.markDirty expands an edit to
// its whole downstream reachability set, regen/scheduler.ts) but has not
// replayed yet this pass. That node's STALE prior handle (disposePriorReplayHandle
// only deletes it once THAT node's own branch starts, which topo order places
// AFTER the node currently executing) still counted as "has body", so its
// stale `consumes` edge walked straight through the node being replayed right
// now and wrongly declared ITS legitimate upstream owner superseded before
// the intermediate executor ever got a chance to resolve it.
//
// Shape (verbatim from the WO's adopted fix): F1 -> body-op F2 -> body-op F3.
// F2 is built once (live, consumes F1), F3 is built once on top of it (live,
// consumes F2) -- both fully settled. Then F2 alone is marked dirty and
// replayed: RegenScheduler.markDirty(F2) expands to F2's own downstream
// closure, which INCLUDES F3 (F3 consumes F2), so F3 goes dirty too in the
// SAME pass even though nothing about F3 changed. Topo order runs F2 first,
// while F3's ALREADY-BUILT handle still sits in bodyHandlesRef untouched
// (F3's own disposePriorReplayHandle has not run yet) -- exactly the
// "already-built downstream consumer" the audit finding describes. F2 must
// still resolve F1 as its live target.
//
// FAILS-IF: lookupLiveBody's hasBody predicate reverts to a bare
// `bodyHandlesRef.current.has(bid)` (the pre-fix global-leaf-set form,
// dropping the `&& scheduler.statusOf(bid) !== 'dirty'` term) -- every case
// below's F2 replay assertion breaks (status 'failed', diagnostics '... has
// no live body (missing or already consumed)' naming F1's id), proving the
// gate is a real, mutation-sensitive probe (charter rule 1/6). This is a
// SEPARATE dimension from the existing consumed-target REFUSAL coverage in
// SolidsWorkbenchPage.extrudeBoolean.test.tsx (a genuinely superseded
// ancestor must still refuse) -- both directions are proven, in different
// files, and must both stay green.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient, type FakeGeomClientOptions } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

async function newRectangleSketch(): Promise<void> {
  await mintRectangleSketch()
}

/** Forces `id` into the dag with the given payload/consumes edges (bypassing
 *  every dialog, same "defense in depth" precedent every consumed-target
 *  refusal test in extrudeBoolean.test.tsx already relies on) and drives it
 *  once through the REAL page executor. */
async function forceInsertAndBuild(id: string, consumes: string[], payload: Record<string, unknown>): Promise<void> {
  hooks().history.execute(createFeatureCommand(hooks().dag, { id, kind: 'feature', consumes, payload }))
  await hooks().fullResync([id])
}

interface OwnerCase {
  /** opType exercised -- every branch that resolves ITS SINGLE upstream
   *  owner through the shared lookupLiveBody gate (boolean's target/tool
   *  duo gets its own dedicated test below instead of this table, since its
   *  shape genuinely needs two independent bodies). */
  opType: string
  payload: (ownerId: string, name: string) => Record<string, unknown>
  clientOptions: FakeGeomClientOptions
}

const OWNER_CASES: OwnerCase[] = [
  {
    opType: 'extrude (Remove, consumed target)',
    payload: (ownerId, name) => ({ opType: 'extrude', sketchId: 'SK1', distance: 5, direction: 'down', boolMode: 'remove', targetFeatureId: ownerId, name }),
    clientOptions: {},
  },
  {
    opType: 'fillet',
    payload: (ownerId, name) => ({ opType: 'fillet', ownerId, edges: ['e1'], radius: 2, propagateTangent: true, name }),
    clientOptions: { applyFilletImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }) },
  },
  {
    opType: 'chamfer',
    payload: (ownerId, name) => ({ opType: 'chamfer', ownerId, edges: ['e1'], distance: 1, propagateTangent: true, name }),
    clientOptions: { applyChamferImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }) },
  },
  {
    opType: 'shell',
    payload: (ownerId, name) => ({ opType: 'shell', ownerId, removeFaces: ['f1'], thickness: 1, name }),
    clientOptions: { applyShellImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }) },
  },
  {
    opType: 'draft',
    payload: (ownerId, name) => ({ opType: 'draft', ownerId, faces: ['f1'], angleDeg: 3, pullAxis: 'z', pullFlip: false, offset: 0, name }),
    clientOptions: { applyDraftImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }) },
  },
  {
    opType: 'hole',
    payload: (ownerId, name) => ({
      opType: 'hole', ownerId, faceId: 'f1', points: [{ x: 0, y: 0, z: 0 }],
      style: { kind: 'simple', diameter: 5 }, depth: { kind: 'blind', distance: 5 }, name,
    }),
    clientOptions: { makeHoleImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }) },
  },
  // 'defeature' is DELIBERATELY excluded from this table: unlike every op
  // above (which only setFeatureVisible(false)s its owner -- the handle
  // stays retained-for-undo in bodyHandlesRef, exactly what makes the
  // MAJOR-1 shape possible to reproduce on a second replay), a SUCCESSFUL
  // defeature branch really deletes its owner's bodyHandlesRef entry and
  // disposes the kernel body (SolidsWorkbenchPage.tsx's defeature branch,
  // "mints a new handle and does not consume its input... disposes the
  // now-superseded input after the new body has been finalized"). So a
  // second replay of a defeature node can never legitimately re-resolve its
  // ORIGINAL owner through lookupLiveBody -- the handle is genuinely gone,
  // not merely hidden -- and this table's "F1 must still resolve on F2's
  // replay" shape does not apply to it. Verified directly: forcing
  // 'defeature' through this exact harness fails with "... has no live
  // body" EVEN WITH the MAJOR-1 fix in place, for this unrelated, correct
  // reason -- confirming the exclusion is deliberate, not an evasion.
]

describe('SolidsWorkbenchPage lookupLiveBody replay eligibility (WO UI-51A-R3, audit MAJOR 1)', () => {
  it.each(OWNER_CASES)('opType=$opType: F2 replays successfully under already-built downstream F3 (all shared-gate branches)', async ({ payload, clientOptions }) => {
    const client = createFakeGeomClient(clientOptions)
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    // F1: root new-body extrude (the eventual legitimate target).
    await forceInsertAndBuild('F1', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude F1' })
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // F2: consumes F1 through the opType under test.
    const f2Consumes = payload('F1', 'Op F2').opType === 'extrude' ? ['SK1', 'F1'] : ['F1']
    await forceInsertAndBuild('F2', f2Consumes, payload('F1', 'Op F2'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    expect(hooks().scheduler.statusOf('F2')).toBe('ok')

    // F3: consumes F2, same opType -- the "already-built downstream consumer".
    const f3Consumes = payload('F2', 'Op F3').opType === 'extrude' ? ['SK1', 'F2'] : ['F2']
    await forceInsertAndBuild('F3', f3Consumes, payload('F2', 'Op F3'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined())
    expect(hooks().scheduler.statusOf('F3')).toBe('ok')

    // THE REPLAY: mark F2 alone dirty. RegenScheduler.markDirty expands this
    // to F2's downstream closure, so F3 goes dirty too even though nothing
    // about F3 changed -- F3's already-built handle is still sitting in
    // bodyHandlesRef, untouched, when F2's own branch runs first (topo
    // order). F2 must still resolve F1 as its live target.
    await hooks().fullResync(['F2'])

    expect(hooks().scheduler.statusOf('F2'), JSON.stringify(hooks().scheduler.diagnosticsOf('F2'))).toBe('ok')
    expect(hooks().getBodyHandle('F2')).not.toBeUndefined()
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('F2'))).not.toMatch(/no live body/)

    // Whole-chain proof (both directions in the SAME pass): F3 replays right
    // after F2 in this same pass and must ALSO resolve F2 (its own live
    // target) correctly -- proving the fix does not just relax the gate
    // permanently, only for the transient in-pass window.
    expect(hooks().scheduler.statusOf('F3'), JSON.stringify(hooks().scheduler.diagnosticsOf('F3'))).toBe('ok')
    expect(hooks().getBodyHandle('F3')).not.toBeUndefined()
  })

  // Boolean's target/tool duo is structurally distinct (TWO independent
  // upstream owners resolved through the SAME lookupLiveBody call, not one) --
  // its own dedicated case, same F1 -> F2(boolean) -> F3(boolean) shape.
  it('opType=boolean: F2 replays successfully (both target AND tool) under already-built downstream F3', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    // F1 (target) and TOOL1 (tool): two independent root new-body extrudes.
    await forceInsertAndBuild('F1', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude F1' })
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    await forceInsertAndBuild('TOOL1', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 6, direction: 'up', boolMode: 'newBody', name: 'Extrude TOOL1' })
    await waitFor(() => expect(hooks().getBodyHandle('TOOL1')).not.toBeUndefined())

    // F2: boolean cut, target=F1, tool=TOOL1 -- consumes both.
    await forceInsertAndBuild('F2', ['F1', 'TOOL1'], { opType: 'boolean', targetFeatureId: 'F1', toolFeatureId: 'TOOL1', boolOp: 'cut', name: 'Boolean F2' })
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    expect(hooks().scheduler.statusOf('F2')).toBe('ok')

    // TOOL2: a second independent root body for F3's tool role.
    await forceInsertAndBuild('TOOL2', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 4, direction: 'up', boolMode: 'newBody', name: 'Extrude TOOL2' })
    await waitFor(() => expect(hooks().getBodyHandle('TOOL2')).not.toBeUndefined())

    // F3: boolean cut, target=F2, tool=TOOL2 -- the already-built downstream consumer of F2.
    await forceInsertAndBuild('F3', ['F2', 'TOOL2'], { opType: 'boolean', targetFeatureId: 'F2', toolFeatureId: 'TOOL2', boolOp: 'cut', name: 'Boolean F3' })
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined())
    expect(hooks().scheduler.statusOf('F3')).toBe('ok')

    // THE REPLAY: F2 alone marked dirty; F3 (downstream) rides along dirty too.
    await hooks().fullResync(['F2'])

    expect(hooks().scheduler.statusOf('F2'), JSON.stringify(hooks().scheduler.diagnosticsOf('F2'))).toBe('ok')
    expect(hooks().getBodyHandle('F2')).not.toBeUndefined()
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('F2'))).not.toMatch(/no live body/)
    expect(hooks().scheduler.statusOf('F3'), JSON.stringify(hooks().scheduler.diagnosticsOf('F3'))).toBe('ok')
    expect(hooks().getBodyHandle('F3')).not.toBeUndefined()
  })

  // WO UI-51A-R3 (audit MAJOR 1) claimed "8 cases/all branches" but excluded
  // 'defeature' entirely from OWNER_CASES above -- a real coverage gap, since
  // 'defeature' behaves DIFFERENTLY from every other shared-gate op when it
  // sits DOWNSTREAM (as F3): unlike fillet/chamfer/shell/draft/hole (which
  // only setFeatureVisible(false) their owner, retaining the handle), a
  // SUCCESSFUL defeature genuinely DELETES its owner's bodyHandlesRef entry
  // (SolidsWorkbenchPage.tsx's defeature branch). WO UI-51A-R4 (audit MINOR 1,
  // adopted fix): commit this exact downstream-defeature variant -- retained-
  // handle fillet for F2, defeature for F3, replay F2, both settle 'ok'.
  it('opType=defeature (downstream only): F2(fillet) replays successfully under already-built downstream F3(defeature)', async () => {
    const client = createFakeGeomClient({
      applyFilletImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }),
      defeatureBatchImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [], report: { requested: 0, healed: 0, failed: 0, refused: 0, totalVolumeDelta: 0, items: [] } }),
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    // F1: root new-body extrude (the eventual legitimate target).
    await forceInsertAndBuild('F1', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude F1' })
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // F2: fillet consuming F1 -- retained-handle op (F2 keeps its own handle).
    await forceInsertAndBuild('F2', ['F1'], { opType: 'fillet', ownerId: 'F1', edges: ['e1'], radius: 2, propagateTangent: true, name: 'Fillet F2' })
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    expect(hooks().scheduler.statusOf('F2')).toBe('ok')

    // F3: defeature consuming F2 -- genuinely DELETES F2's bodyHandlesRef entry on success.
    await forceInsertAndBuild('F3', ['F2'], { opType: 'defeature', ownerId: 'F2', featureKeys: [], name: 'Defeature F3' })
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined())
    expect(hooks().scheduler.statusOf('F3')).toBe('ok')
    expect(hooks().getBodyHandle('F2')).toBeUndefined() // consumed for real, not merely hidden

    // THE REPLAY: mark F2 alone dirty. RegenScheduler.markDirty expands this
    // to F2's downstream closure, so F3 goes dirty too. F2 must still resolve
    // F1 as its live target; F3 must then re-resolve F2's freshly rebuilt
    // handle and re-consume it, both settling 'ok'.
    await hooks().fullResync(['F2'])

    expect(hooks().scheduler.statusOf('F2'), JSON.stringify(hooks().scheduler.diagnosticsOf('F2'))).toBe('ok')
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('F2'))).not.toMatch(/no live body/)
    expect(hooks().scheduler.statusOf('F3'), JSON.stringify(hooks().scheduler.diagnosticsOf('F3'))).toBe('ok')
    expect(hooks().getBodyHandle('F2')).toBeUndefined() // re-consumed by F3's replay, same as the first pass
  })
})

// WO UI-51A-R4 (audit MAJOR, dirty-window correctness -- coordination/reports/
// UI-51A-R3.audit.json / UI-51A-R4.md): R3's fix excluded EVERY 'dirty' node
// uniformly from lookupLiveBody's superseding-source set. But a dirty node can
// also be SKIPPED this pass (RegenScheduler.pass()'s suppressed/rolledBack/
// failed-upstream/missing-upstream branches, regen/scheduler.ts) rather than
// actually replay -- it never reaches its own kernel op, so its existing
// `consumes` edge and retained last-good handle stay authoritative exactly as
// if it were not dirty at all. Excluding it the SAME way as a
// guaranteed-to-replay node left its established target wrongly unsuperseded
// for the remainder of the pass: an earlier (deterministic topo order)
// sibling could then resolve the SAME target as live and consume it too.
//
// Shape (verbatim from the WO's adopted fix): a failed-upstream plus
// earlier-sibling-ordering window. F1 is the shared target. M1PROD is an
// independent producer M3OWNER also structurally depends on. M2SIB is an
// EARLIER sibling that also targets F1 and FAILED its first build. M3OWNER is
// the ESTABLISHED, successful consumer of F1 (and, structurally, of M1PROD).
//
// On replay, M1PROD's OWN kernel call fails this pass -- M3OWNER (which
// depends on it) is therefore guaranteed to be SKIPPED (degraded), never
// reaching its own kernel op, so its consumes edge to F1 must stay
// authoritative. M2SIB is retried in the SAME pass. Deterministic topo order
// (ties break on the node's own stable id, dag.ts's compareIds -- never
// insertion order) runs M1PROD, then M2SIB, then M3OWNER: id prefixes below
// (F1 < M1PROD < M2SIB < M3OWNER) pin this order structurally AND
// lexically, so the test does not depend on an incidental tie-break.
//
// FAILS-IF: lookupLiveBody's hasBody predicate reverts to R3's dirty-alone
// form (`scheduler.statusOf(bid) !== 'dirty'`, dropping willBeSkippedThisPass)
// -- M2SIB's retry wrongly resolves F1 as live and SUCCEEDS where it must
// refuse, because M3OWNER (guaranteed to be skipped, still 'dirty' at the
// moment M2SIB's turn comes) is wrongly excluded from the superseding walk.
describe('SolidsWorkbenchPage lookupLiveBody replay eligibility -- failed-upstream + earlier-sibling ordering (WO UI-51A-R4, audit MAJOR)', () => {
  it('a guaranteed-to-be-skipped (degraded) established consumer keeps superseding its target; an earlier retrying sibling cannot resurrect it', async () => {
    let prodCalls = 0
    let sibCalls = 0
    const client = createFakeGeomClient({
      makeExtrudeImpl: (req, mintHandle) => {
        if (req.featureId !== 'M1PROD') return { ok: true, body: mintHandle(), diagnostics: [] }
        prodCalls++
        if (prodCalls === 1) return { ok: true, body: mintHandle(), diagnostics: [] }
        return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { reason: 'forced M1PROD replay failure' } }] }
      },
      applyChamferImpl: (_req, mintHandle) => {
        sibCalls++
        if (sibCalls === 1) return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { reason: 'forced M2SIB initial failure' } }] }
        // Reached only if the gate is buggy (wrongly lets M2SIB resurrect F1) --
        // succeeding here is what makes the bug's symptom observable.
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    // F1: the shared target both M2SIB and M3OWNER want.
    await forceInsertAndBuild('F1', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude F1' })
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // M1PROD: an independent root body M3OWNER will structurally depend on
    // (its ONLY purpose is to fail on replay, forcing M3OWNER to degrade).
    await forceInsertAndBuild('M1PROD', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 4, direction: 'up', boolMode: 'newBody', name: 'Extrude PROD' })
    await waitFor(() => expect(hooks().getBodyHandle('M1PROD')).not.toBeUndefined())
    expect(prodCalls).toBe(1)

    // M2SIB: an EARLIER sibling targeting F1 -- FAILS its first build (the
    // "previously failed sibling" the audit names).
    await forceInsertAndBuild('M2SIB', ['F1'], { opType: 'chamfer', ownerId: 'F1', edges: ['e1'], distance: 1, propagateTangent: true, name: 'Chamfer SIB' })
    expect(hooks().scheduler.statusOf('M2SIB')).toBe('failed')
    expect(hooks().getBodyHandle('M2SIB')).toBeUndefined()
    expect(sibCalls).toBe(1)

    // M3OWNER: the ESTABLISHED consumer -- a boolean (target=F1, tool=M1PROD)
    // legitimately supersedes BOTH F1 and M1PROD via real consumes edges
    // (bodyLineage.ts's multi-body-parent rule only recognizes 'boolean' +
    // targetFeatureId as a valid identity carrier, so this is also the only
    // dual-parent op shape the real page accepts). M1PROD's later failure
    // routes M3OWNER into the degraded/skip path, not a genuine replay.
    await forceInsertAndBuild('M3OWNER', ['F1', 'M1PROD'], { opType: 'boolean', targetFeatureId: 'F1', toolFeatureId: 'M1PROD', boolOp: 'cut', name: 'Boolean OWNER' })
    await waitFor(() => expect(hooks().getBodyHandle('M3OWNER')).not.toBeUndefined())
    expect(hooks().scheduler.statusOf('M3OWNER')).toBe('ok')
    const ownerHandleBeforeReplay = hooks().getBodyHandle('M3OWNER')

    // THE REPLAY: M1PROD dirty (its 2nd kernel call fails) -- markDirty
    // expands this to M1PROD's downstream closure, pulling M3OWNER dirty too.
    // M2SIB is ALSO marked dirty (the sibling's retry), in the SAME pass.
    await hooks().fullResync(['M1PROD', 'M2SIB'])

    expect(hooks().scheduler.statusOf('M1PROD'), JSON.stringify(hooks().scheduler.diagnosticsOf('M1PROD'))).toBe('failed')

    // M3OWNER is guaranteed-skipped (degraded by its own failed upstream,
    // never reaching its kernel op) -- its last-good handle is RETAINED,
    // never rebuilt, and its consumes edge to F1 stays authoritative.
    expect(hooks().scheduler.statusOf('M3OWNER'), JSON.stringify(hooks().scheduler.diagnosticsOf('M3OWNER'))).toBe('degraded')
    expect(hooks().getBodyHandle('M3OWNER')).toBe(ownerHandleBeforeReplay)

    // THE GATE: M2SIB's retry must be REFUSED -- F1 is still legitimately
    // M3OWNER's, even though M3OWNER is 'dirty' (not yet resolved) at the
    // moment M2SIB's own turn runs. Mutation (revert to dirty-alone
    // eligibility) makes M2SIB wrongly resolve F1 and SUCCEED instead.
    expect(hooks().scheduler.statusOf('M2SIB'), JSON.stringify(hooks().scheduler.diagnosticsOf('M2SIB'))).toBe('failed')
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('M2SIB'))).toMatch(/no live body/)
    expect(hooks().getBodyHandle('M2SIB')).toBeUndefined()
    expect(sibCalls).toBe(1) // the kernel op must never even be reached on the refused retry
  })
})

// WO UI-51A-R5 (audit MAJOR 1, "second bounce" -- governing ruling): R4's own
// willBeSkippedThisPass fixed the ABOVE ordering (M1PROD fails BEFORE M2SIB's
// retry, so M1PROD is already 'failed' -- settled -- by the time M2SIB's own
// turn checks M3OWNER's disposition) but still over-trusted a currently-dirty
// upstream as "not failed, so this consumer will execute": that upstream may
// simply not have taken ITS OWN turn yet this pass. This describe block pins
// the REVERSE order -- the earlier sibling's retry runs BEFORE its target's
// owner's own failing upstream has settled -- which is exactly the window
// R4's fix missed.
//
// Shape: F1 is the shared target. M3PROD is an independent producer M4OWNER
// structurally depends on (fails its SECOND kernel call, i.e. on THIS
// replay). M2SIB is an earlier sibling targeting F1 that failed its first
// build (retried in the SAME pass). M4OWNER is the established, successful
// consumer of F1 (and, structurally, of M3PROD). Deterministic topo order
// (ties break on the node's own stable id, dag.ts's compareIds -- M2SIB and
// M3PROD have no structural relation to each other, so lexical order alone
// decides) runs M2SIB BEFORE M3PROD, then M4OWNER last (structurally after
// both): id prefixes below (F1 < M2SIB < M3PROD < M4OWNER) pin this order
// structurally AND lexically, matching the WO's own governing-ruling naming.
//
// FAILS-IF: lookupLiveBody's hasBody predicate reverts to R4's
// willBeSkippedThisPass form (hasFailedUpstream checking ONLY currently-
// 'failed' status, with no unsettled-upstream branch) -- M2SIB's retry
// wrongly resolves F1 as live and SUCCEEDS where it must refuse, because
// M4OWNER's disposition looks like "will execute" (its upstream M3PROD is
// merely 'dirty', not yet 'failed', at the moment M2SIB's own turn runs).
describe('SolidsWorkbenchPage lookupLiveBody replay eligibility -- unsettled-upstream ordering (WO UI-51A-R5, audit MAJOR 1, "second bounce")', () => {
  it('an earlier sibling retry is refused while its target\'s later-failing owner is still unsettled (not yet failed) at the sibling\'s own turn', async () => {
    let prodCalls = 0
    let sibCalls = 0
    const client = createFakeGeomClient({
      makeExtrudeImpl: (req, mintHandle) => {
        if (req.featureId !== 'M3PROD') return { ok: true, body: mintHandle(), diagnostics: [] }
        prodCalls++
        if (prodCalls === 1) return { ok: true, body: mintHandle(), diagnostics: [] }
        return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { reason: 'forced M3PROD replay failure' } }] }
      },
      applyChamferImpl: (_req, mintHandle) => {
        sibCalls++
        if (sibCalls === 1) return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { reason: 'forced M2SIB initial failure' } }] }
        // Reached only if the gate is buggy (wrongly lets M2SIB resurrect F1) --
        // succeeding here is what makes the bug's symptom observable.
        return { ok: true, body: mintHandle(), diagnostics: [] }
      },
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    // F1: the shared target both M2SIB and M4OWNER want.
    await forceInsertAndBuild('F1', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude F1' })
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // M3PROD: an independent root body M4OWNER will structurally depend on
    // (its ONLY purpose is to fail on THIS replay, forcing M4OWNER to degrade
    // -- but only AFTER M2SIB's own turn has already run, per topo order).
    await forceInsertAndBuild('M3PROD', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 4, direction: 'up', boolMode: 'newBody', name: 'Extrude PROD' })
    await waitFor(() => expect(hooks().getBodyHandle('M3PROD')).not.toBeUndefined())
    expect(prodCalls).toBe(1)

    // M2SIB: an EARLIER (lexically + topologically) sibling targeting F1 --
    // FAILS its first build (the "previously failed sibling" retried below).
    await forceInsertAndBuild('M2SIB', ['F1'], { opType: 'chamfer', ownerId: 'F1', edges: ['e1'], distance: 1, propagateTangent: true, name: 'Chamfer SIB' })
    expect(hooks().scheduler.statusOf('M2SIB')).toBe('failed')
    expect(hooks().getBodyHandle('M2SIB')).toBeUndefined()
    expect(sibCalls).toBe(1)

    // M4OWNER: the ESTABLISHED consumer -- boolean(target=F1, tool=M3PROD)
    // legitimately supersedes BOTH F1 and M3PROD via real consumes edges.
    await forceInsertAndBuild('M4OWNER', ['F1', 'M3PROD'], { opType: 'boolean', targetFeatureId: 'F1', toolFeatureId: 'M3PROD', boolOp: 'cut', name: 'Boolean OWNER' })
    await waitFor(() => expect(hooks().getBodyHandle('M4OWNER')).not.toBeUndefined())
    expect(hooks().scheduler.statusOf('M4OWNER')).toBe('ok')
    const ownerHandleBeforeReplay = hooks().getBodyHandle('M4OWNER')

    // THE REPLAY, ORDER REVERSED FROM THE PRECEDING DESCRIBE BLOCK's test:
    // M3PROD dirty (its 2nd kernel call fails) -- markDirty expands this to
    // M3PROD's downstream closure, pulling M4OWNER dirty too. M2SIB is ALSO
    // marked dirty (the sibling's retry), in the SAME pass. Deterministic
    // topo order runs M2SIB's own turn BEFORE M3PROD's (no structural edge
    // between them, so the lexical tie-break 'M2SIB' < 'M3PROD' decides) --
    // at that moment M3PROD is still 'dirty', NOT YET 'failed'.
    await hooks().fullResync(['M3PROD', 'M2SIB'])

    expect(hooks().scheduler.statusOf('M3PROD'), JSON.stringify(hooks().scheduler.diagnosticsOf('M3PROD'))).toBe('failed')

    // M4OWNER is guaranteed-skipped (degraded by its own failed upstream,
    // never reaching its kernel op) -- its last-good handle is RETAINED,
    // never rebuilt, and its consumes edge to F1 stays authoritative --
    // EVEN THOUGH M4OWNER was still 'dirty' (undecided) at the moment
    // M2SIB's own turn ran, earlier in this SAME pass.
    expect(hooks().scheduler.statusOf('M4OWNER'), JSON.stringify(hooks().scheduler.diagnosticsOf('M4OWNER'))).toBe('degraded')
    expect(hooks().getBodyHandle('M4OWNER')).toBe(ownerHandleBeforeReplay)

    // THE GATE: M2SIB's retry must be REFUSED -- F1 is still legitimately
    // M4OWNER's, even though at the moment M2SIB's own turn ran, M4OWNER's
    // failing upstream (M3PROD) had not settled yet. Mutation (revert to
    // R4's willBeSkippedThisPass form) makes M2SIB wrongly resolve F1 and
    // SUCCEED instead.
    expect(hooks().scheduler.statusOf('M2SIB'), JSON.stringify(hooks().scheduler.diagnosticsOf('M2SIB'))).toBe('failed')
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('M2SIB'))).toMatch(/no live body/)
    expect(hooks().getBodyHandle('M2SIB')).toBeUndefined()
    expect(sibCalls).toBe(1) // the kernel op must never even be reached on the refused retry
  })
})

// WO UI-51A-R5 (ruling's REQUIRED discriminator, "alongside the M2SIB test"):
// proves the fix above is not OVER-conservative. A naive "any dirty upstream
// anywhere in the chain is unsettled" reading (without the downstream-of-the-
// currently-executing-node exemption, RegenScheduler.supersedesDuringPass's
// exemption (a)) would ALSO pass every test above, but breaks the single most
// ordinary case there is: replaying one link of a deep retained-handle chain.
//
// Shape: F1 <- F2(fillet) <- F3(fillet) <- F4(fillet), all four already built
// and 'ok'. Replay F2 alone: RegenScheduler.markDirty expands this to F2's
// WHOLE downstream closure {F2, F3, F4} (neither F3 nor F4 changed at all).
// At F2's own turn, F3 and F4 are both still 'dirty' (unsettled) -- under the
// naive reading, F4's transitive upstream F3 being 'dirty' would make F4
// "unsettled", so F4 would keep superseding its own consumes chain --
// F4->F3->F2->F1 -- and wrongly mark F1 superseded too, refusing F2's own
// legitimate target. The correct rule exempts F3 and F4 here because BOTH are
// transitively DOWNSTREAM of F2 (the node currently executing): whatever they
// eventually do, their own retention would supersede F2's freshly-built
// result too, so F1 staying resolvable to F2 can never create two live
// consumers of the same target.
//
// FAILS-IF: RegenScheduler.supersedesDuringPass's isDownstreamOf exemption is
// removed (leaving only the disposition check) -- F2's replay wrongly fails
// with "F1 ... has no live body", and F3/F4 (which never even reach their own
// kernel ops once F2 fails) stay 'ok' from their PRIOR pass, an inconsistent
// mixed result that never happens with the exemption in place.
describe('SolidsWorkbenchPage lookupLiveBody replay eligibility -- deep chain replay stays superseded-safe (WO UI-51A-R5 discriminator)', () => {
  it('a 4-deep retained-handle chain (F1<-F2<-F3<-F4) replaying F2 alone settles ALL FOUR ok', async () => {
    const client = createFakeGeomClient({
      applyFilletImpl: (_req, mintHandle) => ({ ok: true, body: mintHandle(), diagnostics: [] }),
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await newRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    await forceInsertAndBuild('F1', ['SK1'], { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude F1' })
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    await forceInsertAndBuild('F2', ['F1'], { opType: 'fillet', ownerId: 'F1', edges: ['e1'], radius: 1, propagateTangent: true, name: 'Fillet F2' })
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    await forceInsertAndBuild('F3', ['F2'], { opType: 'fillet', ownerId: 'F2', edges: ['e1'], radius: 1, propagateTangent: true, name: 'Fillet F3' })
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined())

    await forceInsertAndBuild('F4', ['F3'], { opType: 'fillet', ownerId: 'F3', edges: ['e1'], radius: 1, propagateTangent: true, name: 'Fillet F4' })
    await waitFor(() => expect(hooks().getBodyHandle('F4')).not.toBeUndefined())

    for (const id of ['F1', 'F2', 'F3', 'F4']) expect(hooks().scheduler.statusOf(id)).toBe('ok')

    // THE REPLAY: F2 alone marked dirty; F3 and F4 ride along dirty (F2's
    // downstream closure) even though neither changed, their already-built
    // handles still sitting in bodyHandlesRef untouched when F2's own turn
    // runs first (topo order).
    await hooks().fullResync(['F2'])

    for (const id of ['F1', 'F2', 'F3', 'F4']) {
      expect(hooks().scheduler.statusOf(id), `${id}: ${JSON.stringify(hooks().scheduler.diagnosticsOf(id))}`).toBe('ok')
    }
    for (const id of ['F2', 'F3', 'F4']) {
      expect(JSON.stringify(hooks().scheduler.diagnosticsOf(id))).not.toMatch(/no live body/)
    }
  })
})
