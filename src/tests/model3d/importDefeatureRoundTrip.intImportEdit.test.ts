// @vitest-environment jsdom
//
// INT-IMPORT-EDIT stage 2 -- a workbench body edit on a body that came from an
// 'import' node (a wrapped imported STEP), proven end-to-end at the workbench
// level, with the CAM geometry row re-surfacing the edited body afterward.
//
// This closes the coverage gap: every existing defeature/resize-hole suite
// edits an AUTHORED body (mintRectangleSketch -> extrude). None proves the same
// dress-up path works when the upstream body producer is an 'import' node whose
// live kernel handle only exists after its STEP bytes replay. Stage 2's whole
// point is that defeature/resize operate on ANY upstream body producer
// (feature/import/meshImport) with no provenance inspection -- this is the
// import case, on the REAL occt-wasm kernel.
//
// EDIT MECHANISM: resize-hole (not defeature). The DefeatureDialog only offers
// fillet/chamfer classes -- a hole is a DECLINED class there
// (DEFEATURE_CLASS_DISPOSITIONS) -- so "remove/shrink a hole" is the resize-hole
// op, which IS fully wired in-viewport and is the natural edit for the
// hole-bearing fixture. Driven through the REAL supplement-list surface (arm ->
// List -> row -> anchored value entry -> apply), which enumerates the recognized
// holes without needing viewport ray coordinates for an imported body whose
// hole positions the test does not hard-code.
//
// FIXTURE: test_fixtures/brep/fix_single_hole_block.step -- a single 40x20x20
// box with ONE blind hole (d=6, depth 8), minted deterministically through the
// kernel (makeBox -> makeHole -> exportStep) and re-imported here. importStep
// returns bodies.length === 1 with one recognized blindHole:6, and that hole
// resize-heals cleanly on the re-imported body (both grow and shrink) -- unlike
// the tightly-spaced holes in fix_plate_holes.step, whose slab heal degenerates
// in the kernel for EVERY hole (so that fixture cannot prove a resize round-trip).
// A shrink is used so the edit never grows past the block's edge.
//
// Mount idiom mirrors SolidsWorkbenchPage.pushPullMigrationRegen.test.tsx (stash
// a seed -> render with createLocalGeomService -> fullResync) + the resize-hole
// pick harness from SolidsWorkbenchPage.resizeHole.test.tsx (a fake scene
// runtime pre-arming projectToCanvas so the anchored entry mounts in jsdom).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'

// The one seam with no node equivalent: the IndexedDB STEP byte cache. Return
// the real plate fixture bytes for the seed's cacheKey.
const plateBytes = readFileSync(resolve(process.cwd(), 'test_fixtures/brep/fix_single_hole_block.step'))
function plateArrayBuffer(): ArrayBuffer {
  return plateBytes.buffer.slice(plateBytes.byteOffset, plateBytes.byteOffset + plateBytes.byteLength)
}
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async () => {},
  loadCachedStep: async (_id: string) => plateArrayBuffer(),
  removeCachedStep: async () => {},
}))

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { buildImportedStepModelArchive } = await import('../../doc/promoteImportedStepModel')
const { stashLoadedDocument, resetDocumentHolder } = await import('../../doc/documentHolder')
const { useCamStore } = await import('../../store')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { stubCanvas2d } = await import('./stubCanvas2d')

import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { FakeSceneRuntime } from './fakeSceneRuntime'

const HOLE_CLASSES = ['throughHole', 'blindHole', 'counterboreStack']

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

/** A fake scene runtime that projects to a fixed on-screen point, so the
 *  anchored value entry (which renders nothing while its anchor is off-screen)
 *  mounts in jsdom -- SolidsWorkbenchPage.resizeHole.test.tsx's own harness. */
function harness(): { createSceneRuntime: () => FakeSceneRuntime; runtime: () => FakeSceneRuntime } {
  let runtime: FakeSceneRuntime | null = null
  const createSceneRuntime = (): FakeSceneRuntime => {
    const rt = createFakeSceneRuntime()
    rt.projectToCanvasResult = { x: 200, y: 200 }
    runtime = rt
    return rt
  }
  return { createSceneRuntime, runtime: () => runtime as FakeSceneRuntime }
}

/** The one format:'model' CAM row for the legacy-scope item (there is exactly
 *  one solid in this fixture). */
function modelRows() {
  return useCamStore.getState().project.geometry.filter((g) => g.format === 'model')
}

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  resetDocumentHolder()
  useCamStore.getState().newProject()
  restoreCanvas2d = stubCanvas2d()
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
})

describe('INT-IMPORT-EDIT stage 2: resize-hole on an IMPORTED base body, CAM row re-surfaces the edit', () => {
  it('seeds an imported STEP base body, shrinks one of its holes through the real workbench, and the CAM model row re-derives on the edited body', async () => {
    const h = harness()
    // Seed a Model Item whose base body is the imported plate (one import node,
    // no bodyIndex -> single-body import). The step cache mock hands it the real
    // fixture bytes on replay.
    const archive = buildImportedStepModelArchive({ fileName: 'fix_single_hole_block.step', cacheKey: 'block', name: 'Block' })
    stashLoadedDocument(archive)
    render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: h.createSceneRuntime }))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await waitFor(() => expect(window.__solidsWorkbenchHooks).not.toBeUndefined(), { timeout: 20_000 })

    // Let one full regen complete so the import node's kernel handle is adopted.
    await hooks().fullResync(['IMP1'])
    await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().scheduler.statusOf('IMP1')).toBe('ok')

    // The imported body surfaced to CAM as ONE model row, keyed on the import
    // node's own body id (proves the import node -- not an authored feature --
    // is the surfaced body producer).
    await waitFor(() => expect(modelRows()).toHaveLength(1), { timeout: 30_000 })
    const before = modelRows()[0]
    expect(before.modelBody!.ref.bodyId).toBe('IMP1')
    expect(before.name).toBe('Block')

    // The imported body has recognizable resize-eligible holes.
    const verdictsBefore = await hooks().client.recognizeFeatures!(hooks().getBodyHandle('IMP1')!)
    const holesBefore = verdictsBefore.filter((v) => HOLE_CLASSES.includes(v.featureClass))
    expect(holesBefore.length).toBeGreaterThan(0)

    // Arm resize-hole; wait for recognition to settle and the rail to enable.
    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i),
      { timeout: 20_000 },
    )

    // Open the supplement list -- it enumerates the recognized holes (no viewport
    // ray coordinates needed for an imported body whose holes the test never
    // places). Collect the candidate holes largest-diameter first: the kernel's
    // heal-then-recut refuses a few tight geometries (e.g. the tiny d=3 hole
    // whose slab heal degenerates), so the test SHRINKS the first hole that
    // resizes cleanly rather than hard-coding one -- the claim under test is
    // "an edit on the imported body re-surfaces to CAM", not any one hole.
    async function openList(): Promise<void> {
      fireEvent.click(screen.getByTestId('workbench-resizehole-list'))
      await waitFor(() => expect(screen.getByTestId('resize-hole-picker')).toBeTruthy(), { timeout: 20_000 })
    }
    await openList()
    const candidates = (screen.getAllByRole('radio') as HTMLButtonElement[])
      .map((el) => ({ featureKey: el.getAttribute('data-feature-key')!, diameter: Number(el.getAttribute('data-current-diameter')) }))
      .filter((c) => Number.isFinite(c.diameter))
      .sort((a, b) => b.diameter - a.diameter)
    expect(candidates.length).toBeGreaterThan(0)

    let appliedNewDiameter: number | null = null
    for (const cand of candidates) {
      if (screen.queryByTestId('resize-hole-picker') === null) await openList()
      const row = screen.getByTestId('resize-hole-picker').querySelector(`[data-feature-key="${cand.featureKey}"]`) as HTMLButtonElement
      fireEvent.click(row)
      await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
      const newDiameter = Math.max(1, cand.diameter - 2)
      fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: String(newDiameter) } })
      fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
      // Wait for a definite outcome: the entry closes (success) OR a named
      // engine refusal renders (this hole's heal degenerated -- try the next).
      await waitFor(() => {
        const closed = screen.queryByTestId('resize-hole-anchor-entry') === null
        const errored = screen.queryByTestId('resize-hole-anchor-entry-apply-error') !== null
        if (!closed && !errored) throw new Error('resize-hole apply still pending')
      }, { timeout: 20_000 })
      if (screen.queryByTestId('resize-hole-anchor-entry') === null) {
        appliedNewDiameter = newDiameter
        break
      }
      // Refused: dismiss the entry (stays armed) and try the next hole.
      fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-cancel'))
      await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull())
    }
    expect(appliedNewDiameter, 'at least one recognized hole must resize cleanly on the imported block').not.toBeNull()
    const newDiameter = appliedNewDiameter!

    // A visible, undoable resizeHole feature node landed, consuming the imported
    // body IMP1 (direct-edit: it supersedes IMP1 with a new live leaf).
    const resizeId = hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    expect(resizeId).toBeDefined()
    expect(hooks().dag.getNode(resizeId!)?.consumes).toContain('IMP1')
    await waitFor(() => expect(hooks().getBodyHandle(resizeId!)).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().scheduler.statusOf(resizeId!)).toBe('ok')

    // THE EDIT APPLIED TO THE IMPORTED BODY: the live leaf now recognizes the
    // shrunk diameter that the pre-edit body did not.
    const verdictsAfter = await hooks().client.recognizeFeatures!(hooks().getBodyHandle(resizeId!)!)
    const diametersAfter = verdictsAfter
      .filter((v) => HOLE_CLASSES.includes(v.featureClass))
      .map((v) => v.params.diameter as number)
    expect(diametersAfter.some((d) => Math.abs(d - newDiameter) <= 1e-4)).toBe(true)

    // THE CAM ROW RE-SURFACED THE EDIT (syncModelBodies ran on the edited
    // imported body): still exactly one model row for this item, its lineage
    // label unchanged ('Plate'), but now keyed on the edited leaf -- NOT the
    // stale pre-edit IMP1 -- and carrying a real derived version. This is the
    // assertion the mutation proof (skip syncCamModelBodies) turns RED.
    await waitFor(() => {
      const rowsNow = modelRows()
      expect(rowsNow).toHaveLength(1)
      expect(rowsNow[0].modelBody!.ref.bodyId).toBe(resizeId)
    }, { timeout: 30_000 })
    const after = modelRows()[0]
    expect(after.name).toBe('Block')
    expect(after.modelBody!.ref.bodyId).not.toBe('IMP1')
    expect(after.modelBody!.ref.version).toBeGreaterThanOrEqual(1)
  }, 120_000)
})
