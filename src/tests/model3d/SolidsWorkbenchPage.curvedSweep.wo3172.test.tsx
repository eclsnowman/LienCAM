// @vitest-environment jsdom
//
// WO-3230 (WO-3172 Draft C): sweep along a sketch path through the REAL
// workbench and the in-process OCCT kernel. The operator's route is the
// toolbar Sweep button -> SweepDialog (Sketch path) -> createFeatureCommand /
// EditFeaturePayloadCommand -> regen -> the WO-3228 resolver -> makeSweep's
// right-corner chain sweep (WO-3229).
//
// Independent truth (closed forms, not kernel output):
//   quarter-arc tube, profile r=2 on a path of radius R=20:
//     V = pi r^2 * R * pi/2 = 394.7841760435743 mm3
//   L path of two 20 mm legs, mitred corner: V = pi r^2 * 40 = 502.6548245743669 mm3
//   (a mitre on the bisector plane moves volume from one leg to the other, never adds any)

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { EditFeaturePayloadCommand } from '../../components/model3d/dialogs/EditFeaturePayloadCommand'
import { SetRollbackMarkerCommand } from '../../doc'
import { NODE_ID_BY_BASE_PLANE } from '../../components/model3d/workbench/basePlanes'
import { buildOffsetPlaneDatumNodeInput } from '../../sketch3d/datumPlane'
import { createLocalGeomService } from '../../geom'
import type { BodyHandle } from '../../geom/geom-service'
import { collectDocumentArchive, resetDocumentHolder, stashLoadedDocument } from '../../doc/documentHolder'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import type { Sketch } from '../../lib/sketch/types'

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  resetDocumentHolder()
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  resetDocumentHolder()
})

const PROF = 'sketch3d:PROF'
const ARC = 'sketch3d:ARC'
const ELL = 'sketch3d:ELL'
const XY = NODE_ID_BY_BASE_PLANE.xy
const XZ = NODE_ID_BY_BASE_PLANE.xz
const ARC_TUBE = Math.PI * 4 * 20 * (Math.PI / 2)
const L_TUBE = Math.PI * 4 * 40
const ARC_STEPS = [{ entityId: 'a1', forward: true }]
const L_STEPS = [{ entityId: 'l1', forward: true }, { entityId: 'l2', forward: true }]

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

async function boot(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => { captured = createFakeSceneRuntime(); return captured }} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const runtime = captured as unknown as FakeSceneRuntime
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  camera.position.set(0, 0, 100); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  runtime.camera = camera
  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  const canvas = screen.getByTestId('solids-workbench-canvas')
  canvas.getBoundingClientRect = () => rect
  ;(canvas.parentElement as HTMLElement).getBoundingClientRect = () => rect
  return runtime
}

function sketchOf(entities: Sketch['entities']): Sketch {
  return { id: 'S', layerId: 'plane', entities, constraints: [], dimensions: [], solveStatus: null }
}
const circle = (r: number): Sketch['entities'] => [{ id: 'c1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: r }]
const quarterArc = (radius: number): Sketch['entities'] => [{ id: 'a1', kind: 'arc', construction: false, center: { x: 0, y: 0 }, radius, startAngle: 0, endAngle: Math.PI / 2 }]
const lPath: Sketch['entities'] = [
  { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
  { id: 'l2', kind: 'line', construction: false, start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
]

/** A package sketch node exactly as a finished Model sketch stores it: curves + its plane. */
async function mintSketch(id: string, planeNodeId: string, entities: Sketch['entities']): Promise<void> {
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id, kind: 'sketch', consumes: [planeNodeId], refs: [],
    payload: { name: id.replace('sketch3d:', ''), planeNodeId, sketch: sketchOf(entities), externalRefs: [], dimensionDiagnostics: [] },
  }))
  await hooks().fullResync([id])
  await waitFor(() => expect(screen.getByTestId(`feature-row-${id}`)).toBeTruthy())
  await waitFor(() => expect((screen.getByTestId('workbench-sweep') as HTMLButtonElement).disabled).toBe(false))
}

async function freshBody(featureId: string, prior?: BodyHandle): Promise<BodyHandle> {
  let current: BodyHandle | undefined
  await waitFor(() => {
    current = hooks().getBodyHandle(featureId)
    expect(current, `${featureId} has a body`).not.toBeUndefined()
    if (prior !== undefined) expect(current).not.toBe(prior)
  }, { timeout: 30_000 })
  return current as BodyHandle
}

async function volumeOf(handle: BodyHandle): Promise<number> {
  return (await hooks().client.measure(handle, 'volume')).value
}

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-6)
}

function chooseChain(text: RegExp): void {
  const select = screen.getByTestId('sweep-path-chain-select') as HTMLSelectElement
  const option = Array.from(select.options).find((o) => text.test(o.textContent ?? ''))
  expect(option, `a chain option matching ${text}`).toBeDefined()
  fireEvent.change(select, { target: { value: option!.value } })
}

/** Toolbar Sweep -> profile -> Sketch path -> the chain -> Apply. */
async function sweepAlong(chain: RegExp): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-sweep'))
  fireEvent.change(screen.getByTestId('sweep-profile-select'), { target: { value: PROF } })
  const sketchMode = screen.queryByTestId('sweep-path-mode-sketch')
  expect(sketchMode, 'the Sweep dialog offers Sketch path').not.toBeNull()
  fireEvent.click(sketchMode!)
  chooseChain(chain)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
}

function openEdit(featureId: string): void {
  fireEvent.click(screen.getByTestId(`feature-row-${featureId}`))
  fireEvent.click(screen.getByTestId('workbench-edit-feature'))
}

describe('WO-3230 sweep along a sketch path (real workbench, real OCCT kernel)', () => {
  it('creates a curved sweep from visible profile and open chain selection', async () => {
    await boot()
    await mintSketch(PROF, XZ, circle(2))
    await mintSketch(ARC, XY, quarterArc(20))

    fireEvent.click(screen.getByTestId('workbench-sweep'))
    fireEvent.change(screen.getByTestId('sweep-profile-select'), { target: { value: PROF } })
    const sketchMode = screen.queryByTestId('sweep-path-mode-sketch')
    expect(sketchMode, 'the Sweep dialog offers Sketch path').not.toBeNull()
    fireEvent.click(sketchMode!)
    chooseChain(/arc a1/)
    // Where it starts and which way it goes, before anything is built.
    expect(screen.getByTestId('sweep-path-start').textContent).toBe('Starts at (20, 0, 0) mm, heading (0, 1, 0)')
    // A new sweep along a curve follows the path.
    expect((screen.getByTestId('sweep-orientation-select') as HTMLSelectElement).value).toBe('frenet')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    expectClose(await volumeOf(await freshBody('F1')), ARC_TUBE)
    const node = hooks().dag.getNode('F1')!
    expect(node.payload.path).toEqual({ kind: 'sketch-chain', sketchId: ARC, steps: ARC_STEPS })
    expect(node.consumes).toEqual([PROF, ARC])
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')

    // One undo removes exactly the sweep.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined(), { timeout: 20_000 })
    expect(hooks().dag.has('F1')).toBe(false)
    expect(hooks().dag.has(ARC)).toBe(true)
  }, 120_000)

  it('edits the same node and atomically rewires both producers through undo redo', async () => {
    await boot()
    await mintSketch(PROF, XZ, circle(2))
    await mintSketch(ARC, XY, quarterArc(20))
    await mintSketch(ELL, XY, lPath)
    await sweepAlong(/arc a1/)
    const arcBody = await freshBody('F1')
    expectClose(await volumeOf(arcBody), ARC_TUBE)
    const order = hooks().dag.featureOrder()
    const historySize = hooks().history.size()

    openEdit('F1')
    expect((screen.getByTestId('sweep-path-mode-sketch') as HTMLInputElement).checked).toBe(true)
    chooseChain(/line l1.*line l2/)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    const lBody = await freshBody('F1', arcBody)
    expectClose(await volumeOf(lBody), L_TUBE)
    expect(hooks().dag.has('F2')).toBe(false)
    expect(hooks().dag.featureOrder()).toEqual(order)
    expect(hooks().history.size()).toBe(historySize + 1)
    expect(hooks().dag.getNode('F1')!.consumes).toEqual([PROF, ELL])
    expect(hooks().dag.getNode('F1')!.payload.path).toEqual({ kind: 'sketch-chain', sketchId: ELL, steps: L_STEPS })

    fireEvent.click(screen.getByTestId('workbench-undo'))
    const undone = await freshBody('F1', lBody)
    expectClose(await volumeOf(undone), ARC_TUBE)
    expect(hooks().dag.getNode('F1')!.consumes).toEqual([PROF, ARC])
    expect(hooks().dag.getNode('F1')!.payload.path).toEqual({ kind: 'sketch-chain', sketchId: ARC, steps: ARC_STEPS })

    fireEvent.click(screen.getByTestId('workbench-redo'))
    const redone = await freshBody('F1', undone)
    expectClose(await volumeOf(redone), L_TUBE)
    expect(hooks().dag.getNode('F1')!.consumes).toEqual([PROF, ELL])
    expect(hooks().dag.featureOrder()).toEqual(order)
  }, 180_000)

  it('path-only sketch remains usable after finish edit and datum motion', async () => {
    await boot()
    await mintSketch(PROF, XZ, circle(2))
    const { nodeId: plane, input } = buildOffsetPlaneDatumNodeInput({ id: 'P5', parentPlaneNodeId: XY, distance: 5 })
    hooks().history.execute(createFeatureCommand(hooks().dag, input))
    await hooks().fullResync([plane])
    await mintSketch(ARC, plane, quarterArc(20))

    // Finish: reopen the path sketch in the sketcher and press Finish.
    const entry = hooks().editEntryFor(ARC)
    if (entry === undefined || !('onEdit' in entry)) throw new Error('the path sketch must reopen in the sketcher')
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
    entry.onEdit()
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull(), { timeout: 20_000 })
    await hooks().fullResync([ARC])
    // A path sketch has no profile and is not a problem: no "saved without a profile" warning,
    // no warning on its tree row, and it is still offered as a path.
    const warnings = useCamStore.getState().consoleEvents.filter((e) => e.severity === 'warning' && /without a profile/i.test(e.message))
    expect(warnings.map((e) => e.message)).toEqual([])
    expect(hooks().dag.getNode(ARC)!.payload.regions).toBeUndefined()
    expect(hooks().scheduler.diagnosticsOf(ARC)).toEqual([])

    await sweepAlong(/arc a1/)
    const first = await freshBody('F1')
    expectClose(await volumeOf(first), ARC_TUBE)
    expect(hooks().getBodyTopPoint('F1')!.z).toBeCloseTo(7, 6)

    // Datum motion: the plane moves 10 mm; the path and the solid follow it.
    const planePayload = hooks().dag.getNode(plane)!.payload
    hooks().history.execute(new EditFeaturePayloadCommand(plane, { ...planePayload, definition: { kind: 'offset', distance: 15, flipNormal: false } }))
    await hooks().fullResync([plane])
    const moved = await freshBody('F1', first)
    expectClose(await volumeOf(moved), ARC_TUBE)
    expect(hooks().getBodyTopPoint('F1')!.z).toBeCloseTo(17, 6)
    expect(hooks().scheduler.diagnosticsOf(ARC)).toEqual([])
  }, 180_000)

  it('missing or future producer reports unresolved path without axis fallback', async () => {
    await boot()
    await mintSketch(PROF, XZ, circle(2))
    await mintSketch(ARC, XY, quarterArc(20))
    const sweepNode = (id: string, consumes: string[], path: unknown) => createFeatureCommand(hooks().dag, {
      id, kind: 'feature', consumes,
      payload: { opType: 'sweep', sketchId: PROF, axis: 'z', length: 30, orientation: 'frenet', name: id, path },
    })

    // The path's curve was deleted: named, no body, and never the dormant 30 mm Z axis.
    hooks().history.execute(sweepNode('GONE', [PROF, ARC], { kind: 'sketch-chain', sketchId: ARC, steps: [{ entityId: 'a-deleted', forward: true }] }))
    await hooks().fullResync(['GONE'])
    expect(hooks().getBodyHandle('GONE')).toBeUndefined()
    expect(hooks().scheduler.statusOf('GONE')).toBe('failed')
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('GONE'))).toMatch(/missing-entity/)

    // The path sketch is drawn after the sweep and then rolled back past: it does not exist at the
    // sweep's build, so the sweep names it and builds nothing.
    hooks().history.execute(sweepNode('EARLY', [PROF, 'sketch3d:LATER'], { kind: 'sketch-chain', sketchId: 'sketch3d:LATER', steps: ARC_STEPS }))
    await mintSketch('sketch3d:LATER', XY, quarterArc(20))
    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'after', nodeId: 'EARLY' }))
    await hooks().fullResync(['EARLY'])
    expect(hooks().getBodyHandle('EARLY')).toBeUndefined()
    expect(hooks().scheduler.statusOf('EARLY')).toBe('failed')
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('EARLY'))).toMatch(/path sketch sketch3d:LATER does not exist at this point in the model/)
    hooks().history.undo()
    await hooks().fullResync(['EARLY'])

    // The path sketch itself is gone: the sweep is degraded by name, never an axis body.
    hooks().history.execute(sweepNode('MISSING', [PROF, 'sketch3d:NOPE'], { kind: 'sketch-chain', sketchId: 'sketch3d:NOPE', steps: ARC_STEPS }))
    await hooks().fullResync(['MISSING'])
    expect(hooks().getBodyHandle('MISSING')).toBeUndefined()
    expect(hooks().scheduler.statusOf('MISSING')).not.toBe('ok')
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('MISSING'))).toMatch(/sketch3d:NOPE/)

    // The edit dialog names the unresolved path and will not apply it.
    const entry = hooks().editEntryFor('GONE')
    if (entry === undefined || !('onEdit' in entry)) throw new Error('GONE must open its edit dialog')
    entry.onEdit()
    await waitFor(() => expect(screen.getByTestId('sweep-path-error').textContent).toMatch(/curve a-deleted no longer exists/))
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
  }, 120_000)

  it('a path sketch drawn after the sweep is picked and builds, and reopens to the same body', async () => {
    await boot()
    await mintSketch(PROF, XZ, circle(2))
    // An axis sweep first, through the toolbar and the dialog.
    fireEvent.click(screen.getByTestId('workbench-sweep'))
    fireEvent.change(screen.getByTestId('sweep-profile-select'), { target: { value: PROF } })
    fireEvent.change(screen.getByTestId('sweep-path-axis-select'), { target: { value: 'y' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    const axisBody = await freshBody('F1')

    // The path sketch is drawn AFTER the sweep, then picked in the sweep's own edit.
    await mintSketch(ARC, XY, quarterArc(20))
    const order = hooks().dag.featureOrder()
    expect(order.indexOf(ARC)).toBeGreaterThan(order.indexOf('F1'))
    openEdit('F1')
    fireEvent.click(screen.getByTestId('sweep-path-mode-sketch'))
    chooseChain(/arc a1/)
    fireEvent.change(screen.getByTestId('sweep-orientation-select'), { target: { value: 'frenet' } })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    const built = await freshBody('F1', axisBody)
    expectClose(await volumeOf(built), ARC_TUBE)
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
    expect(hooks().dag.getNode('F1')!.consumes).toEqual([PROF, ARC])
    const dagBefore = hooks().dag.serialize()
    const hashBefore = hooks().getBodyGeometryHash('F1')
    expect(hashBefore).not.toBeUndefined()

    // Reload and regenerate: the same body.
    const archive = collectDocumentArchive()
    expect(archive).not.toBeUndefined()
    cleanup()
    stashLoadedDocument(archive!)
    await boot()
    await waitFor(() => expect(screen.getByTestId('workbench-document-load-status').textContent).toContain('ok'), { timeout: 20_000 })
    const reopened = await freshBody('F1')
    expect(hooks().dag.serialize()).toBe(dagBefore)
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
    expectClose(await volumeOf(reopened), ARC_TUBE)
    expect(hooks().getBodyGeometryHash('F1')).toBe(hashBefore)
  }, 180_000)

  it('upstream path edit reaches the sweep downstream closure and invalidates its body', async () => {
    await boot()
    await mintSketch(PROF, XZ, circle(2))
    await mintSketch(ARC, XY, quarterArc(20))
    await sweepAlong(/arc a1/)
    const before = await freshBody('F1')
    expectClose(await volumeOf(before), ARC_TUBE)

    const payload = hooks().dag.getNode(ARC)!.payload
    hooks().history.execute(new EditFeaturePayloadCommand(ARC, { ...payload, sketch: sketchOf(quarterArc(30)) }))
    const pass = await hooks().fullResync([ARC])
    expect(pass.executed).toContain('F1')
    const after = await freshBody('F1', before)
    expect(after).not.toBe(before)
    expectClose(await volumeOf(after), Math.PI * 4 * 30 * (Math.PI / 2))
    expect(hooks().dag.getNode('F1')!.payload.path).toEqual({ kind: 'sketch-chain', sketchId: ARC, steps: ARC_STEPS })
  }, 120_000)

  it('save reopen and no-op edit preserve both selectors and exact geometry', async () => {
    await boot()
    await mintSketch(PROF, XZ, circle(2))
    await mintSketch(ELL, XY, lPath)
    await sweepAlong(/line l1.*line l2/)
    const built = await freshBody('F1')
    expectClose(await volumeOf(built), L_TUBE)
    const dagBefore = hooks().dag.serialize()
    const hashBefore = hooks().getBodyGeometryHash('F1')
    expect(hashBefore).not.toBeUndefined()

    const archive = collectDocumentArchive()
    expect(archive).not.toBeUndefined()
    cleanup()
    stashLoadedDocument(archive!)
    await boot()
    await waitFor(() => expect(screen.getByTestId('workbench-document-load-status').textContent).toContain('ok'), { timeout: 20_000 })
    const reopened = await freshBody('F1')
    expect(hooks().dag.serialize()).toBe(dagBefore)
    const node = hooks().dag.getNode('F1')!
    expect(node.payload.path).toEqual({ kind: 'sketch-chain', sketchId: ELL, steps: L_STEPS })
    expect(node.payload.profileSelector).toEqual(JSON.parse(dagBefore).nodes.find((n: { id: string }) => n.id === 'F1').payload.profileSelector)
    expectClose(await volumeOf(reopened), L_TUBE)
    expect(hooks().getBodyGeometryHash('F1')).toBe(hashBefore)

    // A no-op edit: same node, same payload, same geometry.
    openEdit('F1')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await hooks().fullResync(['F1'])
    const edited = await freshBody('F1')
    expect(hooks().dag.serialize()).toBe(dagBefore)
    expectClose(await volumeOf(edited), L_TUBE)
    expect(hooks().getBodyGeometryHash('F1')).toBe(hashBefore)
  }, 180_000)
})
