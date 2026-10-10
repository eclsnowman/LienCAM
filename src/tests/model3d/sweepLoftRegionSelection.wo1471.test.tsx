// @vitest-environment jsdom
//
// WO-1471 (BUG-398): in a sketch with multiple closed regions, Sweep's and
// Loft's "pick a profile" flow visibly highlighted the clicked region, but
// Apply always built the sketch's FIRST region -- SweepFeaturePayload and
// LoftFeaturePayload kept only sketchId (loft: sectionIds), discarding the
// ProfilePickResult's profileSelector, and the sweep/loft executors in
// SolidsWorkbenchPage.tsx hardcoded regions?.[0]. Extrude/Revolve already
// solved this with an optional profileSelector resolved through the shared
// resolveProfileSelector() helper; these tests prove sweep and loft are now
// wired the same way -- both at the dialog (payload capture) and at the
// executor (real occt-wasm geometry) level.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { SweepDialog } from '../../components/model3d/dialogs/SweepDialog'
import { LoftDialog } from '../../components/model3d/dialogs/LoftDialog'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { EditFeaturePayloadCommand } from '../../components/model3d/dialogs/EditFeaturePayloadCommand'
import { CommandHistory, FeatureDag } from '../../doc'
import { createLocalGeomService } from '../../geom'
import type { ProfileRegion } from '../../geom/geom-service'
import { rectangleProfile } from '../../components/model3d/workbench/profileGeometry'
import { regionProfileSelector } from '../../components/model3d/workbench/regionSelector'
import type { ProfilePickRequest, StartProfilePick } from '../../components/model3d/workbench/profileRegionPicker'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

function profileRequestCapture(): { start: StartProfilePick; request(): ProfilePickRequest } {
  let captured: ProfilePickRequest | undefined
  return {
    start: (request) => { captured = request },
    request: () => {
      if (captured === undefined) throw new Error('profile picker request was not captured')
      return captured
    },
  }
}

const regionC = { kind: 'region' as const, signature: ['c-edge-1', 'c-edge-2'] }
const regionD = { kind: 'region' as const, signature: ['d-edge-1', 'd-edge-2'] }

describe('WO-1471 Sweep/Loft dialogs capture the picked region', () => {
  it('Sweep Apply carries the viewport-picked region selector, not just sketchId', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch A' } })
    const history = new CommandHistory(dag)
    const picker = profileRequestCapture()
    let appliedId: string | undefined

    render(
      <SweepDialog
        dag={dag}
        history={history}
        sketchOptions={[{ id: 'SK1', label: 'Sketch A' }]}
        onStartProfilePick={picker.start}
        onApplied={(id) => { appliedId = id }}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('sweep-pick-profile'))
    act(() => { picker.request().onDone([{ sketchId: 'SK1', profileSelector: regionC }]) })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(appliedId).toBeDefined()
    expect(dag.getNode(appliedId!)?.payload).toMatchObject({ sketchId: 'SK1', profileSelector: regionC })
  })

  it('Loft Apply carries a picked region selector per section, not just sectionIds', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch A' } })
    dag.insertNode({ id: 'SK2', kind: 'sketch', payload: { name: 'Sketch B' } })
    const history = new CommandHistory(dag)
    const picker = profileRequestCapture()
    let appliedId: string | undefined

    render(
      <LoftDialog
        dag={dag}
        history={history}
        sketchOptions={[{ id: 'SK1', label: 'Sketch A' }, { id: 'SK2', label: 'Sketch B' }]}
        onStartProfilePick={picker.start}
        onApplied={(id) => { appliedId = id }}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('loft-pick-profiles'))
    act(() => {
      picker.request().onDone([
        { sketchId: 'SK1', profileSelector: regionC },
        { sketchId: 'SK2', profileSelector: regionD },
      ])
    })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expect(appliedId).toBeDefined()
    expect(dag.getNode(appliedId!)?.payload).toMatchObject({
      sectionIds: ['SK1', 'SK2'],
      sectionProfileSelectors: [regionC, regionD],
    })
  })
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

async function waitForReady(): Promise<void> {
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
    { timeout: 20_000 },
  )
}

/** Directly constructs a two-region sketch node (the sketching UI has no
 *  affordance for a multi-region sketch -- see mintRectangleSketch.ts's own
 *  header for this "construct the DAG node directly" convention). `decoy`
 *  is deliberately the sketch's FIRST region: a test that still passes when
 *  the executor hardcodes regions?.[0] is not exercising this WO's fix. */
async function insertTwoRegionSketch(
  sketchId: string,
  decoy: { width: number; height: number },
  target: { width: number; height: number },
): Promise<{ decoyRegion: ProfileRegion; targetRegion: ProfileRegion }> {
  const decoyRegion: ProfileRegion = {
    ...rectangleProfile({ sketchId: `${sketchId}-decoy`, plane: 'xy', width: decoy.width, height: decoy.height, offset: 0 }),
    sketchId,
  }
  const targetRegion: ProfileRegion = {
    ...rectangleProfile({ sketchId: `${sketchId}-target`, plane: 'xy', width: target.width, height: target.height, offset: decoy.width + 20 }),
    sketchId,
  }
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id: sketchId,
    kind: 'sketch',
    payload: { name: `Sketch ${sketchId}`, plane: 'xy', width: decoy.width, height: decoy.height, offset: 0, profile: decoyRegion, regions: [decoyRegion, targetRegion] },
  }))
  await hooks().fullResync([sketchId])
  return { decoyRegion, targetRegion }
}

async function volumeOf(featureId: string): Promise<number> {
  const handle = hooks().getBodyHandle(featureId)
  if (handle === undefined) throw new Error(`${featureId} has no body handle`)
  return (await hooks().client.measure(handle, 'volume')).value
}

describe("WO-1471 Sweep/Loft build the picked region, not the sketch's first region (real kernel)", () => {
  it('Sweep: a profileSelector for the second region builds that region; omitted, it still falls back to the first', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    const { decoyRegion, targetRegion } = await insertTwoRegionSketch('SK1', { width: 50, height: 50 }, { width: 10, height: 10 })
    const targetSelector = regionProfileSelector(targetRegion, [decoyRegion, targetRegion])
    const decoySelector = regionProfileSelector(decoyRegion, [decoyRegion, targetRegion])

    // No selector recorded at all (legacy payload / whole-sketch default):
    // resolution must still fall back to the sketch's first region exactly
    // as before this fix -- nothing already saved regresses.
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: { opType: 'sweep', sketchId: 'SK1', axis: 'z', length: 30, orientation: 'fixed', name: 'Sweep F1' },
    }))
    await hooks().fullResync(['F1'])
    // Straight sweep: analytic = profile area * path length = decoy (50*50) * 30.
    expect(Math.abs((await volumeOf('F1')) - 75_000) / 75_000).toBeLessThan(1e-6)

    // An explicit selector for the SECOND (picked, non-first) region builds
    // that region -- the bug this WO fixes: Apply must not silently keep
    // building the sketch's first region.
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F2',
      kind: 'feature',
      consumes: ['SK1'],
      payload: { opType: 'sweep', sketchId: 'SK1', profileSelector: targetSelector, axis: 'z', length: 30, orientation: 'fixed', name: 'Sweep F2' },
    }))
    await hooks().fullResync(['F2'])
    // target (10*10) * 30.
    expect(Math.abs((await volumeOf('F2')) - 3_000) / 3_000).toBeLessThan(1e-6)

    // The selector persists correctly across history: editing F2 to the
    // decoy region rebuilds the decoy's geometry, and undoing that edit
    // restores the originally picked region -- a re-pick after undo reflects
    // the newly picked region, not a stale one.
    hooks().history.execute(new EditFeaturePayloadCommand(
      'F2',
      { ...hooks().dag.getNode('F2')!.payload, profileSelector: decoySelector },
      ['SK1'],
    ))
    await hooks().fullResync(['F2'])
    expect(Math.abs((await volumeOf('F2')) - 75_000) / 75_000).toBeLessThan(1e-6)

    hooks().history.undo()
    await hooks().fullResync(['F2'])
    expect(Math.abs((await volumeOf('F2')) - 3_000) / 3_000).toBeLessThan(1e-6)
  }, 60_000)

  it("Loft: a profileSelector per section builds each picked region, not each sketch's first", async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    const sk1 = await insertTwoRegionSketch('SK1', { width: 50, height: 50 }, { width: 20, height: 10 })
    const sk2 = await insertTwoRegionSketch('SK2', { width: 50, height: 50 }, { width: 10, height: 6 })
    const selector1 = regionProfileSelector(sk1.targetRegion, [sk1.decoyRegion, sk1.targetRegion])
    const selector2 = regionProfileSelector(sk2.targetRegion, [sk2.decoyRegion, sk2.targetRegion])

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1', 'SK2'],
      payload: {
        opType: 'loft',
        sectionIds: ['SK1', 'SK2'],
        sectionProfileSelectors: [selector1, selector2],
        spacing: 12,
        ruled: true,
        name: 'Loft F1',
      },
    }))
    await hooks().fullResync(['F1'])

    // Prismatoid: h/6*(A1 + 4*Am + A2). A1=200 (20x10), A2=60 (10x6),
    // Am=15*8=120, h=12 -- the SAME analytic shape
    // SolidsWorkbenchPage.sweepLoft.test.tsx proves for a single-region
    // fixture. Each sketch's decoy region (50x50) is deliberately its FIRST
    // region: matching this expected volume instead of the decoys' (h/6*6*2500
    // = 30000) proves both sections resolved their picked region, not the
    // sketch's first.
    const expected = (12 / 6) * (200 + 4 * 120 + 60)
    expect(Math.abs((await volumeOf('F1')) - expected) / expected).toBeLessThan(1e-6)
  }, 60_000)

  it('Loft: a sparse sectionProfileSelectors array (one slot never set) survives a real serialize/restore round trip and still builds fresh -- not a null crash', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    const sk1 = await insertTwoRegionSketch('SK1', { width: 50, height: 50 }, { width: 20, height: 10 })
    // SK2's target region is unused here -- this test's section 2 exercises
    // the null-selector fallback path, which resolves to SK2's first/decoy
    // region, not an explicit pick.
    await insertTwoRegionSketch('SK2', { width: 50, height: 50 }, { width: 10, height: 6 })
    const selector1 = regionProfileSelector(sk1.targetRegion, [sk1.decoyRegion, sk1.targetRegion])

    // Exactly the shape LoftDialog produces when only ONE section's picker
    // ever ran (a single viewport pick, a lone dropdown change, or a tree
    // pick of section 1 alone): section 2's slot is never set, so the array
    // is sparse -- index 1 is JS `undefined`, not an explicit whole-sketch
    // selector. Derive the persisted shape through a THROWAWAY scratch dag
    // (not F1 itself) via the SAME serialize()/restore() a save-and-reopen
    // uses (dag.ts:865/903, reached via persist/format.ts): JSON turns the
    // sparse array's unset slot into `null`. F1 below is then built for the
    // FIRST time straight from that null-bearing payload -- exactly a reopened
    // document, with no prior successful build's body handle around to mask a
    // silent rebuild failure.
    const scratch = new FeatureDag()
    scratch.insertNode({ id: 'TMP', kind: 'feature', payload: { sectionProfileSelectors: [selector1, undefined] } })
    const restoredSelectors = (FeatureDag.restore(scratch.serialize()).getNode('TMP')?.payload as { sectionProfileSelectors: unknown[] }).sectionProfileSelectors
    expect(restoredSelectors).toEqual([selector1, null])

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1', 'SK2'],
      payload: {
        opType: 'loft',
        sectionIds: ['SK1', 'SK2'],
        sectionProfileSelectors: restoredSelectors,
        spacing: 12,
        ruled: true,
        name: 'Loft F1',
      },
    }))
    await hooks().fullResync(['F1'])

    // Before the fix, resolveProfileSelector read `null.kind` for section 2
    // and the feature built no body at all.
    expect(hooks().getBodyHandle('F1')).toBeDefined()
    // Section 1 resolves its explicit pick (target, 20x10 = 200); section 2's
    // null slot falls back to whole-sketch, i.e. its first/decoy region
    // (50x50 = 2500) -- exactly the untouched legacy behavior, not a crash.
    // midWidth=(20+50)/2=35, midHeight=(10+50)/2=30, Am=35*30=1050, h=12.
    const expected = (12 / 6) * (200 + 4 * 1050 + 2500)
    expect(Math.abs((await volumeOf('F1')) - expected) / expected).toBeLessThan(1e-6)
  }, 60_000)
})
