// @vitest-environment jsdom
//
// WO SKC-5 acceptance criterion 3: "Parent face DELETED -> sketch degrades
// honestly (no silent rebind); minimal re-pick reattaches and regen
// recovers." Drives the degrade + "Reattach face" UI affordance through the
// REAL SolidsWorkbenchPage (real occt-wasm kernel): removing the extrude
// that owns the picked face removes its DAG node entirely, which the
// EXISTING RegenScheduler upstream-removed isolation (scheduler.ts's
// firstMissingUpstream, WO DOC-4-R1.1) degrades the datum from -- proving
// the badge + Reattach button surface it honestly, and that clicking
// Reattach + re-picking heals it.
//
// WO UI-16 (Q-14): sketch-on-face creation is now itself an undoable
// CompositeCommand (datum+sketch bundled), which sits ABOVE the extrude in
// history -- LIFO undo can no longer reach "extrude gone, datum still
// present" from a single workbench-undo click (it would remove the
// just-finished sketch+datum first). This test now removes/restores F1
// directly via the exposed `history`/`fullResync` test seams instead of the
// workbench-undo BUTTON, reproducing the identical DAG mutation Undo used to
// produce (dag.removeNode has no consumer guard) without depending on
// undo-stack order.

// WO SKC-15C (THE SEVERING) -- why `workbench-finish-package-sketch` and not `workbench-finish-sketch`:
// this file used to drive the INLINE sketch session, whose Finish button carried the latter testid.
// Sketch-on-face now enters THE Sketcher package session, whose Finish carries the former. The old id
// no longer exists in the page AT ALL, deliberately: a stale caller reaching for it goes red rather
// than silently driving a different sketcher. Nothing else in this file's assertions changed.
// WO SKC-15C: sketch-on-face now opens THE Sketcher package session, whose constraint badges need a
// 2D canvas context jsdom does not have. See stubCanvas2d.ts -- environment gap, nothing asserted on.
import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { RemoveNodeCommand } from '../../doc'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

describe('SolidsWorkbenchPage: face-plane degrade + reattach (WO SKC-5 AC #3, real occt-wasm kernel)', () => {
  it('undoing the owning feature degrades the datum (badge + Reattach affordance); reattach + regen heals it', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }

    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const runtime = capturedRuntime as unknown as FakeSceneRuntime
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))

    // Healthy: no reattach affordance yet.
    fireEvent.click(screen.getByTestId('feature-row-datum:SK2'))
    expect(screen.queryByTestId('workbench-reattach-face')).toBeNull()
    expect(within(screen.getByTestId('feature-row-datum:SK2')).getByTestId('feature-status-badge').dataset.status).toBe('ok')

    // --- Remove the extrude that owns the picked face: F1's DAG node is
    // removed entirely -- the datum's `consumes: ['F1']` now points at a
    // producer that no longer exists, which RegenScheduler's EXISTING
    // firstMissingUpstream isolation (DOC-4-R1.1) degrades it from, with no
    // SKC-5-specific plumbing needed for this half of the story.
    //
    // WO UI-16 (Q-14): sketch-on-face creation is now ITSELF an undoable
    // CompositeCommand (datum+sketch, bundled -- see Q-14's report), which
    // sits ABOVE F1's own extrude in history. A single workbench-undo click
    // would now remove the JUST-FINISHED sketch+datum (LIFO), never reaching
    // the extrude at all -- so this test no longer uses Undo to remove F1.
    // It instead drives the SAME RemoveNodeCommand class Undo-of-an-insert
    // would have used, directly through the exposed `history`/`fullResync`
    // seams, reproducing the IDENTICAL DAG mutation (dag.removeNode has no
    // consumer guard -- see FeatureDag.removeNode) and the same post-mutation
    // resync every UI-triggered command already goes through. The later
    // "redo" step below is now an UNDO of this fresh RemoveNodeCommand.
    hooks().history.execute(new RemoveNodeCommand('F1'))
    await hooks().fullResync(['datum:SK2'])
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())
    await waitFor(() => {
      const badge = within(screen.getByTestId('feature-row-datum:SK2')).getByTestId('feature-status-badge')
      expect(badge.dataset.status).toBe('degraded')
    })

    fireEvent.click(screen.getByTestId('feature-row-datum:SK2'))
    expect(screen.getByTestId('workbench-reattach-face')).toBeTruthy()

    // Never silently rebound: the ref still names the SAME (now-missing) TOP
    // face id -- nothing here guessed a replacement.
    const degradedNode = hooks().dag.getNode('datum:SK2')!
    expect(degradedNode.refs.length).toBe(1)

    // --- Clicking "Reattach face" arms pick mode -- with F1 still gone,
    // nothing is under the ray, so the click is a safe no-op (never crashes,
    // never guesses): still degraded, still in pick mode, no phantom bind.
    fireEvent.click(screen.getByTestId('workbench-reattach-face'))
    expect(screen.getByTestId('solids-workbench-pick-hint').textContent).toMatch(/reattach/i)
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    expect(screen.getByTestId('solids-workbench-pick-hint')).toBeTruthy() // still armed, no false bind
    expect(within(screen.getByTestId('feature-row-datum:SK2')).getByTestId('feature-status-badge').dataset.status).toBe('degraded')

    // --- Undo the manual RemoveNodeCommand above -- restores F1 (a real
    // live body + a real live top face again) WHILE reattach pick mode is
    // still armed -- the SAME click-to-pick path now resolves against the
    // restored face and heals the datum, proving the reattach affordance's
    // SUCCESS path (not just automatic regen healing) actually re-points
    // refs/consumes and re-resolves. Driven via `history.undo()` directly
    // (not the workbench-undo BUTTON): the button's handler reconciles its
    // own `touchedPastRef` bookkeeping against button-driven commands only,
    // and this test's F1 removal above deliberately bypassed that bookkeeping
    // (see the comment above) -- so the restore does too, for the same
    // command, staying self-consistent rather than reading a stale entry.
    hooks().history.undo()
    await hooks().fullResync(['F1'])
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const sketchPayloadBeforeReattach = structuredClone(
      hooks().dag.getNode('sketch3d:SK2')!.payload as {
        sketch?: unknown
        externalRefs?: unknown[]
      },
    )
    expect(sketchPayloadBeforeReattach.externalRefs ?? []).toEqual([])
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => {
      const badge = within(screen.getByTestId('feature-row-datum:SK2')).getByTestId('feature-status-badge')
      expect(badge.dataset.status).toBe('ok')
      // In the same waitFor as the badge, not after it. The pick hint clears on
      // the same settle but not necessarily the same render tick, and asserting
      // it outside raced under fleet load and failed WO-1299's lane on
      // 2026-09-09. Reattach must still both heal the datum AND drop the hint.
      expect(screen.queryByTestId('solids-workbench-pick-hint')).toBeNull()
    })
    expect(hooks().dag.getNode('datum:SK2')!.consumes).toEqual(['F1'])
    const sketchPayloadAfterReattach = hooks().dag.getNode('sketch3d:SK2')!.payload as {
      sketch?: unknown
      externalRefs?: unknown[]
    }
    // SKC-26B: an empty-ref/static-copy sketch reattaches only its datum. It
    // must skip boundary extraction and preserve the CAM payload byte-shape.
    expect(sketchPayloadAfterReattach.sketch).toEqual(sketchPayloadBeforeReattach.sketch)
    expect(sketchPayloadAfterReattach.externalRefs ?? []).toEqual([])
  }, 40_000)

  it('archive-loaded CAM legacy refs reopen byte-for-byte, then reattach by replacing only .extN geometry', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const runtime = capturedRuntime as unknown as FakeSceneRuntime
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))

    const datum = hooks().dag.getNode('datum:SK2')!
    const sourceFaceId = datum.refs[0].id
    const currentPayload = hooks().dag.getNode('sketch3d:SK2')!.payload
    const currentSketch = (currentPayload as { sketch: Record<string, unknown> }).sketch
    const legacyPayload = {
      ...currentPayload,
      sketch: {
        ...currentSketch,
        entities: [
          { id: 'SK2.ext0', kind: 'line', construction: false, start: { x: 900, y: 900 }, end: { x: 901, y: 900 } },
          { id: 'user.line', kind: 'line', construction: false, start: { x: 2, y: 2 }, end: { x: 7, y: 2 } },
        ],
        constraints: [
          { id: 'SK2.ext0.fix', kind: 'fix', entityId: 'SK2.ext0' },
          { id: 'user.line.fix', kind: 'fix', entityId: 'user.line' },
        ],
      },
      externalRefs: [{ sourceFaceId, entityIds: ['SK2.ext0'] }],
    }
    hooks().dag.setPayload('sketch3d:SK2', legacyPayload)

    // Exercise the real document archive codec with the CURRENT workbench payload.sketch shape.
    const loaded = loadDocumentArchive(createDocumentArchive({ dag: hooks().dag, elementMapDeltas: [] }))
    const loadedPayload = loaded.dag.getNode('sketch3d:SK2')!.payload
    expect(loadedPayload).toEqual(legacyPayload)
    hooks().dag.setPayload('sketch3d:SK2', structuredClone(loadedPayload))

    // Reopening a saved legacy sketch is not a migration or reprojection trigger. The package must
    // read and close the current CAM payload byte-for-byte; only explicit datum reattach may replace
    // the entities named by nonempty externalRefs.
    const beforeReopen = structuredClone(hooks().dag.getNode('sketch3d:SK2')!.payload)
    fireEvent.click(screen.getByTestId('feature-row-sketch3d:SK2'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    await waitFor(() => expect(screen.getByTestId('workbench-finish-package-sketch')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-finish-package-sketch')).toBeNull())
    expect(hooks().dag.getNode('sketch3d:SK2')!.payload).toEqual(beforeReopen)

    hooks().history.execute(new RemoveNodeCommand('F1'))
    await hooks().fullResync(['datum:SK2'])
    await waitFor(() => expect(within(screen.getByTestId('feature-row-datum:SK2')).getByTestId('feature-status-badge').dataset.status).toBe('degraded'))
    fireEvent.click(screen.getByTestId('feature-row-datum:SK2'))
    fireEvent.click(screen.getByTestId('workbench-reattach-face'))
    hooks().history.undo()
    await hooks().fullResync(['F1'])
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-pick-hint')).toBeNull())

    const repaired = hooks().dag.getNode('sketch3d:SK2')!.payload as {
      sketch: {
        entities: Array<{ id: string; start?: { x: number; y: number } }>
        constraints: Array<{ id: string; entityId?: string }>
      }
      externalRefs: Array<{ sourceFaceId: string; entityIds: string[] }>
    }
    expect(repaired.sketch.entities.find((entity) => entity.id === 'user.line')).toEqual(
      legacyPayload.sketch.entities[1],
    )
    expect(repaired.sketch.constraints.find((constraint) => constraint.id === 'user.line.fix')).toEqual(
      legacyPayload.sketch.constraints[1],
    )
    expect(repaired.sketch.entities.some((entity) => entity.id === 'SK2.ext0' && entity.start?.x === 900)).toBe(false)
    expect(repaired.externalRefs).toHaveLength(1)
    expect(repaired.externalRefs[0].sourceFaceId).toBe(sourceFaceId)
    expect(repaired.externalRefs[0].entityIds.length).toBeGreaterThan(1)
    expect(repaired.externalRefs[0].entityIds.every((id) => repaired.sketch.entities.some((entity) => entity.id === id))).toBe(true)
  }, 40_000)
})
