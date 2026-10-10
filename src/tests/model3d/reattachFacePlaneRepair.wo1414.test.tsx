// @vitest-environment jsdom
//
// WO-1414: the Reattach face pick used to mutate the DAG (setConsumes/setRefs) BEFORE it knew the
// pick was any good (BUG-489: a non-planar pick silently committed and read as success because the
// click handler's success check read the SAME stale lastGoodFrame the mutation itself never touched;
// BUG-490: a cyclic pick threw DagCycleError uncaught out of the click handler). Drives the REAL
// Reattach pick handler (SolidsWorkbenchPage's handleCanvasClick) against the REAL occt-wasm kernel
// for all three acceptance scenarios: non-planar refusal, cyclic refusal, and a valid repair whose
// Undo/Redo round-trips refs+consumes+reprojection as ONE history step.

import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import { useCamStore } from '../../store'
import type { DatumPlanePayload } from '../../sketch3d'
import type { FeatureRef } from '../../doc'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  useCamStore.setState({ consoleEvents: [] })
})
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

function warnings(): string[] {
  return useCamStore.getState().consoleEvents.filter((e) => e.severity === 'warning').map((e) => e.message)
}

interface Scenario {
  runtime: () => FakeSceneRuntime
  datumId: string
  sketchId: string
  ownerId: string
  priorRefs: FeatureRef[]
  priorConsumes: string[]
  priorFrame: unknown
  priorSketchPayload: unknown
}

/**
 * Builds: SK1 -> F1 (box, x:[10,50] y:[0,20] z:[0,20]) -> F2 (F1 + a blind hole at (20,5), a real
 * cylindrical wall) -> a face-plane datum on F2's top ('datumId'), a face sketch on it that PROJECTS
 * the top boundary ('sketchId', so its externalRefs are non-empty -- exactly the case reattach's
 * reprojection loop must touch) -> F3 (extruded from that face sketch, so F3 transitively depends on
 * the datum being repaired -- the BUG-490 cyclic-pick target).
 *
 * Then CORRUPTS the datum's own ref to an id nothing can resolve (test-setup plumbing, not the
 * production path under test) and arms Reattach -- the SAME 'degraded' state a genuinely deleted
 * upstream face already produces (SolidsWorkbenchPage.sketchOnFaceDegrade.test.tsx), without
 * disturbing F2 or F3's live bodies (both stay pickable, which a RemoveNodeCommand-based degrade would
 * not: it would tear down whichever body it targeted).
 */
async function buildScenario(): Promise<Scenario> {
  let capturedRuntime: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    capturedRuntime = rt
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const runtime = () => capturedRuntime as unknown as FakeSceneRuntime

  // --- F1: box, x:[10,50] y:[0,20] z:[0,20] -------------------------------
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

  // --- F2: F1 + a blind hole at (20,5) diameter 6 depth 5 -- a real cylindrical wall, wall z:[15,20],
  // floor z=15, well clear of the (30,10) top-face pick and the (10,*) left wall used below.
  fireEvent.click(screen.getByTestId('workbench-hole'))
  runtime().rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  commitField('hole-diameter', '6')
  commitField('hole-blind-distance', '5')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

  // --- datum + face sketch on F2's top face -------------------------------
  runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('workbench-new-sketch'))
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
  const canvas = screen.getByTestId('solids-workbench-canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
  fireEvent.click(screen.getByTestId('workbench-package-tool-project'))
  fireEvent.pointerMove(canvas, { clientX: 400, clientY: 300 })
  fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300, button: 0 })
  fireEvent.pointerUp(canvas, { clientX: 400, clientY: 300, button: 0 })
  await waitFor(() => {
    const payload = hooks().dag.getNode('sketch3d:SK2')!.payload as { sketch?: { entities: unknown[] } }
    expect(payload.sketch?.entities.length).toBeGreaterThan(0)
  })
  fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
  expect(screen.queryByTestId('workbench-finish-package-sketch')).toBeNull()

  const datumId = 'datum:SK2'
  const sketchId = 'sketch3d:SK2'
  const priorConsumes = [...hooks().dag.getNode(datumId)!.consumes]
  expect(priorConsumes).toEqual(['F2'])

  // --- F3: extrude the face sketch's projected profile -- F3 -> sketch3d:SK2 -> datum:SK2, the
  // cyclic-pick target BUG-490 needs.
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sketchId } })
  commitField('extrude-distance', '5')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

  const priorFrame = structuredClone((hooks().dag.getNode(datumId)!.payload as DatumPlanePayload).lastGoodFrame)
  const priorSketchPayload = structuredClone(hooks().dag.getNode(sketchId)!.payload)

  // --- Corrupt the ref (test scaffolding, mirrors the existing SKC-5 degrade test's own
  // hooks().dag.setRefs/setPayload seams) -- degrades the datum WITHOUT touching F2 or F3.
  hooks().dag.setRefs(datumId, [{ id: 'wo1414:unresolvable-face', kind: 'single-face', role: 'supportFace', elementType: 'face' }])
  hooks().scheduler.markDirty(datumId)
  await hooks().fullResync([datumId])
  await waitFor(() => {
    const badge = within(screen.getByTestId(`feature-row-${datumId}`)).getByTestId('feature-status-badge')
    expect(badge.dataset.status).toBe('degraded')
  })
  const priorRefs = structuredClone(hooks().dag.getNode(datumId)!.refs)

  fireEvent.click(screen.getByTestId(`feature-row-${datumId}`))
  fireEvent.click(screen.getByTestId('workbench-reattach-face'))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-pick-hint')).toBeTruthy())

  return { runtime, datumId, sketchId, ownerId: 'F2', priorRefs, priorConsumes, priorFrame, priorSketchPayload }
}

// WO-1967: solveStatus.fullyDefinedEntities is a SET of ids; the WO-1864 relink solve emits the
// three workbench anchors last instead of first. Order carries no meaning, so compare sorted.
function orderFreeSolveStatus(payload: unknown): unknown {
  const p = payload as { sketch: { solveStatus?: { fullyDefinedEntities?: string[] } } }
  const fde = p.sketch.solveStatus?.fullyDefinedEntities
  if (!fde) return payload
  return { ...p, sketch: { ...p.sketch, solveStatus: { ...p.sketch.solveStatus, fullyDefinedEntities: [...fde].sort() } } }
}

describe('SolidsWorkbenchPage: Reattach face validates before mutating (WO-1414, real occt-wasm kernel)', () => {
  it('BUG-489: clicking a curved (cylindrical) face leaves refs/consumes/frame untouched, stays armed, and names the refusal', async () => {
    const s = await buildScenario()

    // A point just inside the hole's void at its axis, aimed at the wall -- the front (air-facing)
    // side of a concave face must be approached from inside the void, never from outside the solid.
    s.runtime().rayOverride = { origin: { x: 20, y: 5, z: 17.5 }, direction: { x: 1, y: 0, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(warnings().some((m) => /not planar/i.test(m))).toBe(true))
    expect(hooks().dag.getNode(s.datumId)!.refs).toEqual(s.priorRefs)
    expect(hooks().dag.getNode(s.datumId)!.consumes).toEqual(s.priorConsumes)
    expect((hooks().dag.getNode(s.datumId)!.payload as DatumPlanePayload).lastGoodFrame).toEqual(s.priorFrame)
    expect(screen.getByTestId('solids-workbench-pick-hint')).toBeTruthy()
    expect(within(screen.getByTestId(`feature-row-${s.datumId}`)).getByTestId('feature-status-badge').dataset.status).toBe('degraded')
  }, 40_000)

  it('BUG-490: clicking a face whose body depends on the sketch being repaired refuses by name, no uncaught exception', async () => {
    const s = await buildScenario()

    const topPoint = hooks().getBodyTopPoint('F3')
    if (topPoint === undefined) throw new Error('F3 has no top point')
    s.runtime().rayOverride = { origin: { x: topPoint.x, y: topPoint.y, z: topPoint.z + 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(warnings().some((m) => /depends on this plane|loop/i.test(m))).toBe(true))
    expect(hooks().dag.getNode(s.datumId)!.refs).toEqual(s.priorRefs)
    expect(hooks().dag.getNode(s.datumId)!.consumes).toEqual(s.priorConsumes)
    expect(screen.getByTestId('solids-workbench-pick-hint')).toBeTruthy()
    expect(within(screen.getByTestId(`feature-row-${s.datumId}`)).getByTestId('feature-status-badge').dataset.status).toBe('degraded')
  }, 40_000)

  it('a valid planar pick repoints the datum, reprojects the sketch, and Undo/Redo round-trip the WHOLE repair in one step', async () => {
    const s = await buildScenario()

    // F2's left wall (x=10, y:[0,20], z:[0,20]) -- a genuinely different, independent, planar face on
    // the SAME body the datum already (still) consumes, so this exercises repoint+reprojection without
    // any cycle risk.
    s.runtime().rayOverride = { origin: { x: -90, y: 10, z: 10 }, direction: { x: 1, y: 0, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(screen.queryByTestId('solids-workbench-pick-hint')).toBeNull())
    await waitFor(() => expect(within(screen.getByTestId(`feature-row-${s.datumId}`)).getByTestId('feature-status-badge').dataset.status).toBe('ok'))

    const reattachedRefs = hooks().dag.getNode(s.datumId)!.refs
    expect(reattachedRefs).not.toEqual(s.priorRefs)
    expect(hooks().dag.getNode(s.datumId)!.consumes).toEqual(['F2'])
    const reattachedFrame = (hooks().dag.getNode(s.datumId)!.payload as DatumPlanePayload).lastGoodFrame
    expect(reattachedFrame).not.toEqual(s.priorFrame)
    const reattachedSketchPayload = hooks().dag.getNode(s.sketchId)!.payload
    expect(reattachedSketchPayload).not.toEqual(s.priorSketchPayload)

    // --- Undo: ONE click reverts refs, consumes and the reprojected sketch together.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode(s.datumId)!.refs).toEqual(s.priorRefs))
    expect(hooks().dag.getNode(s.datumId)!.consumes).toEqual(s.priorConsumes)
    expect(orderFreeSolveStatus(hooks().dag.getNode(s.sketchId)!.payload)).toEqual(orderFreeSolveStatus(s.priorSketchPayload))

    // --- Redo: ONE click re-applies the same repoint + reprojection together.
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode(s.datumId)!.refs).toEqual(reattachedRefs))
    expect(hooks().dag.getNode(s.datumId)!.consumes).toEqual(['F2'])
    expect(orderFreeSolveStatus(hooks().dag.getNode(s.sketchId)!.payload)).toEqual(orderFreeSolveStatus(reattachedSketchPayload))
  }, 40_000)
})
