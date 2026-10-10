// @vitest-environment jsdom
//
// WO UI-56 (Operator finding, T-UI53 card step 2, verbatim: "if a solid is
// unchecked, it needs to stay unchecked unless the user rechecks it. The
// software should not change the checkbox state of the bodies unless there
// is an obvious reason for it to have done so.").
//
// Real in-process kernel (createLocalGeomService) + fakeSceneRuntime, same
// precedent as SolidsWorkbenchPage.bodyListPanel.test.tsx / .hole.test.tsx /
// .wiring.test.tsx.
//
// Deliverable coverage (WO UI-56's own acceptance list):
//  1. OPERATOR REPRO: uncheck a body, re-show its automatically-hidden source
//     sketch (the real fullResync trigger P1 names) -> body stays unchecked +
//     mesh invisible. Plus a second, independent fullResync trigger (suppress).
//  2. Boolean-undo regression guard: the ORIGINAL purpose of the :3178 reset
//     (a boolean-consumed body becomes visible again on undo) still holds.
//  3. Undo/redo of the checkbox toggle itself (SetHiddenCommand route).
//  4. Persistence round-trip: hide -> dag.serialize() -> FeatureDag.restore()
//     -> still hidden (doc-layer), plus the workbench debug-export contract
//     (SolidsWorkbenchPage.debugExport.test.tsx's own rewritten assertion).
//  5. STEP export excludes both persisted user-hidden bodies and structurally
//     hidden retained ancestors via the two-source effective visibility gate.
//  6. Carry-forward: a single-body-parent dress-up inherits its parent's
//     hidden flag (createFeatureCommand.ts Design 3); the ambiguous
//     multi-body-parent (boolean) case is left alone, not guessed.
//
// Deliverable 7 (the four P5 bookkeeping surfaces) is proven by the existing
// stateCensus/rawBodyConsumerCensus tests staying green with this WO's
// updated CLASSIFICATIONS entries. Deliverable 8 (mutation proof) lives under
// coordination/evidence/UI-56/. Deliverable 9 (render smoke) is added to
// SolidsWorkbenchPage.smoke.test.tsx directly.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { CommandHistory, FeatureDag } from '../../doc'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

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

/** Builds one independent box body from a fresh rectangle sketch + extrude
 *  (mirrors SolidsWorkbenchPage.debugExport.test.tsx's own sketchAndExtrude,
 *  duplicated per this suite's own small-helper convention -- see
 *  BodyListPanel.tsx's toHex/fromHex header note). */
async function buildBox(sketchId: string, bodyId: string, offset: string): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset, id: sketchId })
  await waitFor(() => expect(screen.getByTestId(`feature-row-${sketchId}`)).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sketchId } })
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle(bodyId)).not.toBeUndefined(), { timeout: 20_000 })
}

async function applyTopEdgeFillet(runtime: ReturnType<typeof createFakeSceneRuntime>, bodyId: string, rayX: number): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-fillet'))
  runtime.rayOverride = { origin: { x: rayX, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/))
  commitField('fillet-radius', '2')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle(bodyId)).not.toBeUndefined(), { timeout: 20_000 })
}

function meshFor(runtime: ReturnType<typeof createFakeSceneRuntime>, featureId: string): THREE.Mesh | undefined {
  return runtime.scene.children.find(
    (object): object is THREE.Mesh => object instanceof THREE.Mesh && object.userData.workbenchFeatureId === featureId,
  )
}

describe('WO UI-56: body visibility survives resyncs (Operator repro + regression guards)', () => {
  it('OPERATOR REPRO: unchecking a body survives re-showing an automatically-hidden consumed sketch', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox('SK1', 'F1', '10')
    await buildBox('SK2', 'F2', '100')

    // A successful consuming feature owns the initial presentation: its
    // source sketch is hidden until the user explicitly elects to show it.
    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(true))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(false))

    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))
    expect(meshFor(runtime, 'F1')!.visible).toBe(false)

    // The exact repro path P1 names: the ordinary eye control re-shows the
    // consumed sketch -> history.execute(SetHiddenCommand) -> fullResync([]).
    // This is the same display-resync path every body-producing regen uses.
    fireEvent.click(screen.getByTestId('feature-row-hide-SK1'))
    await waitFor(() => expect(hooks().dag.getNode('SK1')?.hidden).toBe(false))
    await waitFor(() => expect(hooks().hasSketchOutline('SK1')).toBe(true))

    // F1 must STILL be unchecked and its mesh still invisible -- Operator's
    // exact complaint, now fixed.
    expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false)
    expect(meshFor(runtime, 'F1')!.visible).toBe(false)
    // F2 (never user-hidden) is unaffected by the reset either way.
    expect((screen.getByTestId('body-visible-F2') as HTMLInputElement).checked).toBe(true)
  }, 60_000)

  it('a second, independent fullResync trigger (suppress) also preserves the unchecked body', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox('SK1', 'F1', '10')
    await buildBox('SK2', 'F2', '100')

    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))

    fireEvent.click(screen.getByTestId('feature-row-suppress-F2'))
    await waitFor(() => expect(hooks().dag.getNode('F2')!.suppressed).toBe(true))

    expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false)
    expect(meshFor(runtime, 'F1')!.visible).toBe(false)
  }, 60_000)

  it('undo/redo of the checkbox toggle itself round-trips through CommandHistory', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox('SK1', 'F1', '10')

    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))
    expect(hooks().dag.getNode('F1')?.hidden).toBe(true)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true))
    expect(hooks().dag.getNode('F1')?.hidden).toBe(false)

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))
    expect(hooks().dag.getNode('F1')?.hidden).toBe(true)
  }, 60_000)

  it('boolean-undo regression guard: a boolean-consumed body becomes visible again on undo (the ORIGINAL purpose of the reset, preserved)', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // Same overlapping extrude+revolve recipe as SolidsWorkbenchPage.wiring.test.tsx
    // (a plain box, offset differently, does not reliably overlap another box).
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10', plane: 'xz' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-revolve'))
    fireEvent.change(screen.getByTestId('revolve-profile-select'), { target: { value: 'SK2' } })
    commitField('revolve-angle', '360')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-boolean'))
    fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'F1' } })
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'F2' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    // Neither F1 nor F2 was ever user-hidden -- node.hidden stays false for
    // both, so the WO UI-56 reset formula (`!hidden`) still resolves to
    // `true` here, byte-identical to the pre-WO hardcoded `true`.
    expect(hooks().dag.getNode('F1')?.hidden).toBe(false)
    expect(hooks().dag.getNode('F2')?.hidden).toBe(false)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F3')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => {
      expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('body-visible-F2') as HTMLInputElement).checked).toBe(true)
    })
  }, 60_000)

  it('STEP export honors persisted hidden and structural supersession visibility', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox('SK1', 'F1', '10')
    await buildBox('SK2', 'F2', '100')

    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))

    // Dress up the still-visible independent body. A successful fillet keeps
    // F2's handle for fast undo but hides its mesh through visibleRef only;
    // node.hidden remains false because the user never hid F2. This is the
    // source split that the original independent-leaf test could not cover.
    await applyTopEdgeFillet(runtime, 'F3', 120)
    expect(hooks().dag.getNode('F1')?.hidden).toBe(true)
    expect(hooks().dag.getNode('F2')?.hidden).toBe(false)
    expect(meshFor(runtime, 'F2')?.visible).toBe(false)
    expect(meshFor(runtime, 'F3')?.visible).toBe(true)

    // Intercept at the real client.exportStep boundary (the same one
    // handleExportStepClick calls) and THROW before the Blob/anchor download
    // plumbing runs -- avoids stubbing global URL/Blob (which would break
    // occt-wasm's own `new URL(...)` binary-locator for any page still
    // booting) while still capturing the exact handle list the click
    // produced.
    let capturedHandles: unknown[] | undefined
    const exportSpy = vi.spyOn(hooks().client, 'exportStep').mockImplementation(async (handles) => {
      capturedHandles = handles
      throw new Error('UI-56 test: stop before Blob/anchor download plumbing')
    })
    try {
      fireEvent.click(screen.getByTestId('workbench-export-step'))
      await waitFor(() => expect(exportSpy).toHaveBeenCalled())
      expect(capturedHandles).toEqual([hooks().getBodyHandle('F3')])
    } finally {
      exportSpy.mockRestore()
    }
  }, 60_000)
})

describe('WO UI-56 Design 3: carry-forward hidden flag on single-body-parent dress-up (doc layer)', () => {
  it('a dress-up superseding a hidden body inherits the hidden flag, wrapped in one undo step', () => {
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    history.execute(createFeatureCommand(dag, { id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Extrude F1' } }))
    dag.setHidden('F1', true)

    history.execute(
      createFeatureCommand(dag, { id: 'F2', kind: 'feature', consumes: ['F1'], payload: { opType: 'fillet', ownerId: 'F1', name: 'Fillet F2' } }),
    )

    expect(dag.getNode('F2')?.hidden).toBe(true)

    // Undo is ONE step (CompositeCommand) and removes F2 entirely -- no
    // dangling partial state, F1's own hidden flag is untouched. F1's OWN
    // insert command is a separate, still-undoable history entry.
    expect(history.undo()).toBe(true)
    expect(dag.getNode('F2')).toBeUndefined()
    expect(dag.getNode('F1')?.hidden).toBe(true)
    expect(history.canUndo()).toBe(true)
  })

  it('a body parent that is NOT hidden leaves the new leaf visible via the plain (non-composite) command -- common case unchanged', () => {
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    history.execute(createFeatureCommand(dag, { id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Extrude F1' } }))

    const cmd = createFeatureCommand(dag, {
      id: 'F2',
      kind: 'feature',
      consumes: ['F1'],
      payload: { opType: 'fillet', ownerId: 'F1', name: 'Fillet F2' },
    })
    // Byte-identical serialize() shape to every pre-WO-UI-56 caller -- proves
    // the common (not-hidden) case takes no new code path.
    expect(cmd.serialize()).toEqual({
      type: 'insertNode',
      input: { id: 'F2', kind: 'feature', consumes: ['F1'], payload: { opType: 'fillet', ownerId: 'F1', name: 'Fillet F2' } },
    })
    history.execute(cmd)
    expect(dag.getNode('F2')?.hidden).toBe(false)
  })

  it('the ambiguous multi-body-parent case (boolean) is left alone -- PARTIAL, not guessed', () => {
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    history.execute(createFeatureCommand(dag, { id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Extrude F1' } }))
    history.execute(createFeatureCommand(dag, { id: 'F2', kind: 'feature', payload: { opType: 'extrude', name: 'Extrude F2' } }))
    dag.setHidden('F1', true)
    dag.setHidden('F2', true)

    history.execute(
      createFeatureCommand(dag, {
        id: 'F3',
        kind: 'feature',
        consumes: ['F1', 'F2'],
        payload: { opType: 'boolean', targetFeatureId: 'F1', name: 'Cut F3' },
      }),
    )

    // Two body parents -- no valid single-identity carrier for hidden
    // inheritance (WO's own PARTIAL allowance); the new leaf keeps
    // freshNode's plain default rather than guessing which parent wins.
    expect(dag.getNode('F3')?.hidden).toBe(false)
  })

  it('a non-body consumed parent (a sketch, for a create-mode extrude) never seeds hidden -- nothing to carry forward', () => {
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    history.execute(createFeatureCommand(dag, { id: 'SK1', kind: 'sketch', payload: {} }))
    dag.setHidden('SK1', true)

    history.execute(createFeatureCommand(dag, { id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', name: 'Extrude F1' } }))

    expect(dag.getNode('F1')?.hidden).toBe(false)
  })
})

describe('WO UI-56 deliverable 4: persistence round-trip (doc layer)', () => {
  it('hide a body -> serialize -> restore -> still hidden', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Extrude F1' } })
    dag.setHidden('F1', true)

    const json = dag.serialize()
    const restored = FeatureDag.restore(json)

    expect(restored.getNode('F1')?.hidden).toBe(true)
  })
})
