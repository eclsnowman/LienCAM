// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'

const { stepStore } = vi.hoisted(() => ({ stepStore: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepStore.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepStore.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepStore.delete(id) }),
}))
vi.mock('../../lib/import/stepAttributes', () => typedMock<typeof import('../../lib/import/stepAttributes')>({
  readStepDisplayAttributes: vi.fn(async () => ({ name: 'Imported fixture', partCount: 1 })),
}))

import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { FeatureDag } from '../../doc'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { currentBodyOwnerForRenderedHit } from '../../components/model3d/SolidsWorkbenchPage'
import { createFakeGeomClient } from './fakeGeomClient'
import { createLocalGeomService, type GeomClient } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { buildOffsetPlaneDatumNodeInput, isOffsetPlaneDatumPayload } from '../../sketch3d'
import { mintRectangleSketch } from './mintRectangleSketch'
import { useCamStore } from '../../store'

let restoreCanvas: (() => void) | null = null

beforeEach(() => {
  restoreCanvas = stubCanvas2d()
  stepStore.clear()
  useCamStore.setState({ consoleEvents: [] })
})
afterEach(() => {
  cleanup()
  restoreCanvas?.()
  restoreCanvas = null
})

function hooks(): SolidsWorkbenchHooks {
  if (window.__solidsWorkbenchHooks === undefined) throw new Error('workbench hooks unavailable')
  return window.__solidsWorkbenchHooks
}

async function boot(createClient: () => GeomClient = createFakeGeomClient): Promise<FakeSceneRuntime> {
  let runtime: FakeSceneRuntime | null = null
  const createRuntime: CreateSceneRuntime = () => {
    runtime = createFakeSceneRuntime()
    return runtime
  }
  render(<SolidsWorkbenchPage createClient={createClient} createSceneRuntime={createRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  const canvas = screen.getByTestId('solids-workbench-canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect)
  return runtime as unknown as FakeSceneRuntime
}

function setDialogNumber(testId: string, value: string): void {
  const root = screen.getByTestId(testId)
  const input = root instanceof HTMLInputElement ? root : root.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`${testId} has no input`)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

function liveReferenceGlyphs(runtime: FakeSceneRuntime): THREE.Object3D[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects.filter((object) => !removed.has(object) && object.userData.referencePlaneVariant === 'ambient')
}

// WO-030: the preview session's live plane ghost (a session-owned emphasis
// sheet stamped with the sentinel ghost id, never a real dag node id).
function liveGhostGlyphs(runtime: FakeSceneRuntime): THREE.Object3D[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects.filter((object) =>
    !removed.has(object) && object.userData.referencePlaneNodeId === 'offset-plane-preview-ghost')
}

// WO-034: every live glyph stamped with the plane's REAL node id, whatever the
// variant (ambient sheet, hover/selection emphasis). The preview ghost carries
// the sentinel id, never a node id, so it is excluded by construction. The
// ambient-only helper above misses a lingering selected/emphasis glyph.
function livePlaneGlyphsFor(runtime: FakeSceneRuntime, nodeId: string): THREE.Object3D[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects.filter((object) =>
    !removed.has(object) && object.userData.referencePlaneNodeId === nodeId)
}

// WO-030: the highlighted saved-reference glyph mounted while the dialog is open.
function liveReferenceHighlights(runtime: FakeSceneRuntime): THREE.Object3D[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects.filter((object) =>
    !removed.has(object) && object.userData.offsetPlanePreviewReference === true)
}

/** World-space Z of each corner of a plane glyph's outline LineLoop. */
function glyphCornerZs(glyph: THREE.Object3D): number[] {
  const outline = glyph.children[0] as THREE.LineLoop
  const position = outline.geometry.getAttribute('position')
  return [0, 1, 2, 3].map((index) => position.getZ(index))
}

function glyphCenter(glyph: THREE.Object3D): { x: number; y: number; z: number } {
  const outline = glyph.children[0] as THREE.LineLoop
  const position = outline.geometry.getAttribute('position')
  const points = [0, 1, 2, 3].map((index) => ({
    x: position.getX(index),
    y: position.getY(index),
    z: position.getZ(index),
  }))
  return points.reduce((sum, point) => ({
    x: sum.x + point.x / points.length,
    y: sum.y + point.y / points.length,
    z: sum.z + point.z / points.length,
  }), { x: 0, y: 0, z: 0 })
}

function glyphNormal(glyph: THREE.Object3D): { x: number; y: number; z: number } {
  const outline = glyph.children[0] as THREE.LineLoop
  const position = outline.geometry.getAttribute('position')
  const a = { x: position.getX(0), y: position.getY(0), z: position.getZ(0) }
  const b = { x: position.getX(1), y: position.getY(1), z: position.getZ(1) }
  const c = { x: position.getX(2), y: position.getY(2), z: position.getZ(2) }
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
  const cross = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  }
  const length = Math.hypot(cross.x, cross.y, cross.z)
  return { x: cross.x / length, y: cross.y / length, z: cross.z / length }
}

async function createExtrudedFixture(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '0' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  setDialogNumber('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeDefined(), { timeout: 20_000 })
}

async function createChainedHoleFixture(runtime: FakeSceneRuntime): Promise<void> {
  await createExtrudedFixture()
  fireEvent.click(screen.getByTestId('workbench-hole'))
  runtime.rayOverride = { origin: { x: 15, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  setDialogNumber('hole-diameter', '4')
  setDialogNumber('hole-blind-distance', '2')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).toBeDefined(), { timeout: 20_000 })
}

async function importStepFixture(): Promise<void> {
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  const bytes = readFileSync(resolve(process.cwd(), 'src/tests/geom/fixtures/tray.step'))
  const file = new File([new Uint8Array(bytes)], 'fixture.step', { type: 'application/octet-stream' })
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(screen.getByTestId('feature-row-IMP1')).toBeTruthy())
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).toBeDefined())
}

async function waitForApplyEnabled(): Promise<void> {
  await waitFor(() => expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false))
}

describe('Offset Plane workbench product seam', () => {
  it('refuses an ambiguous rendered-body lineage instead of guessing a current owner', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], refs: [], payload: { opType: 'extrude' } })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'], refs: [], payload: { opType: 'hole' } })
    dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F1'], refs: [], payload: { opType: 'chamfer' } })
    expect(currentBodyOwnerForRenderedHit(dag, 'F1', ['F2', 'F3'])).toBeNull()
  })

  it('stays unbacked and retargets the source from tree and viewport plane clicks while open', async () => {
    const runtime = await boot()
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))

    expect(screen.getByTestId('dialog-shell').getAttribute('data-presentation')).toBe('floating-palette')
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XY')

    fireEvent.click(screen.getByTestId('feature-row-datum:YZ'))
    await waitFor(() => expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:YZ'))
    await waitFor(() => expect(liveReferenceHighlights(runtime).map((glyph) => glyph.userData.genesisNodeId)).toEqual(['datum:YZ']))

    // A ray normal to XZ at (20, 0, 20) intersects no other base plane, so
    // this is an unambiguous real viewport selection while the panel is open.
    runtime.rayOverride = { origin: { x: 20, y: -100, z: 20 }, direction: { x: 0, y: 1, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XZ'))
    await waitFor(() => expect(liveReferenceHighlights(runtime).map((glyph) => glyph.userData.genesisNodeId)).toEqual(['datum:XZ']))

    fireEvent.change(screen.getByTestId('offset-plane-name'), { target: { value: 'Viewport-picked source' } })
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '6' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined())
    expect(hooks().dag.getNode('datum:RP1')?.consumes).toEqual(['datum:XZ'])
  })

  it('creates, renders, viewport-selects, edits, cancels honestly, and structurally reloads a signed offset', async () => {
    const runtime = await boot()
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XY')
    fireEvent.change(screen.getByTestId('offset-plane-name'), { target: { value: 'Fixture clearance' } })
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '12.5' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined())
    const created = hooks().dag.getNode('datum:RP1')
    if (created === undefined) throw new Error('offset plane was not created')
    expect(created?.consumes).toEqual(['datum:XY'])
    expect(isOffsetPlaneDatumPayload(created.payload)).toBe(true)
    if (!isOffsetPlaneDatumPayload(created.payload)) throw new Error('wrong payload')
    expect(created.payload.definition.distance).toBe(12.5)
    expect(created.payload.lastGoodFrame?.origin.z).toBe(12.5)
    await waitFor(() => expect(liveReferenceGlyphs(runtime).map((glyph) => glyph.userData.referencePlaneNodeId)).toContain('datum:RP1'))

    // The sheet is a real viewport pick target. With no body in front, a ray
    // through the bounded sheet selects the same node that drives tree Edit.
    runtime.rayOverride = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '-7' } })
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect((hooks().dag.getNode('datum:RP1')!.payload as { definition: { distance: number } }).definition.distance).toBe(12.5)

    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '-7' } })
    fireEvent.change(screen.getByTestId('offset-plane-name'), { target: { value: 'Fixture underside' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect((hooks().dag.getNode('datum:RP1')!.payload as { definition: { distance: number } }).definition.distance).toBe(-7))
    const edited = hooks().dag.getNode('datum:RP1')!
    expect((edited.payload as { lastGoodFrame?: { origin: { z: number } } }).lastGoodFrame?.origin.z).toBe(-7)

    const restored = FeatureDag.restore(hooks().dag.serialize())
    const reloaded = restored.getNode('datum:RP1')
    expect(reloaded?.consumes).toEqual(['datum:XY'])
    expect((reloaded?.payload as { name?: string }).name).toBe('Fixture underside')
    expect((reloaded?.payload as { definition?: { distance: number } }).definition?.distance).toBe(-7)
  })

  it('fails loud and disables Apply for a non-finite signed distance', async () => {
    await boot()
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '' } })
    expect(screen.getByTestId('offset-plane-error').textContent).toMatch(/finite signed distance/i)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().dag.getNode('datum:RP1')).toBeUndefined()
  })

  it('opens first, live-selects and retargets generated planar faces, then applies the support and offset in one undo step', async () => {
    const runtime = await boot(createLocalGeomService)
    await createExtrudedFixture()
    const historySizeBefore = hooks().history.size()
    const faceIds = hooks().getBodyFaceIds('F1') ?? []
    const positiveXFaceId = faceIds.find((id) => (hooks().map.snapshotOf(id)?.normal?.x ?? 0) > 0.9)
    const negativeXFaceId = faceIds.find((id) => (hooks().map.snapshotOf(id)?.normal?.x ?? 0) < -0.9)
    expect(positiveXFaceId).toBeDefined()
    expect(negativeXFaceId).toBeDefined()
    if (positiveXFaceId === undefined || negativeXFaceId === undefined) throw new Error('side-face snapshots missing')

    // The palette opens with no face preselected. The face click that follows
    // must remain a live source target while this backdropless surface is open.
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XY')
    runtime.rayOverride = { origin: { x: 100, y: 0, z: 5 }, direction: { x: -1, y: 0, z: 0 } }
    const canvas = screen.getByTestId('solids-workbench-canvas')
    fireEvent.pointerMove(canvas)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout').textContent).toContain(positiveXFaceId))
    expect(canvas.style.cursor).toBe('crosshair')
    expect(hooks().getPickHighlightState(positiveXFaceId)).toBe('hovered')

    fireEvent.click(canvas)
    await waitFor(() => expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:RP1-support'))
    expect(screen.getByTestId('offset-plane-source').textContent).toContain(`Face ${positiveXFaceId} of`)
    expect(hooks().getPickHighlightState(positiveXFaceId)).toBe('selected')
    expect(hooks().dag.getNode('datum:RP1-support')).toBeUndefined()
    expect(hooks().history.size()).toBe(historySizeBefore)

    // Retarget to the opposite side while the palette stays open. A distinct
    // source identity forces the preview session to capture this second face.
    runtime.rayOverride = { origin: { x: -100, y: 0, z: 5 }, direction: { x: 1, y: 0, z: 0 } }
    fireEvent.pointerMove(canvas)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout').textContent).toContain(negativeXFaceId))
    expect(hooks().getPickHighlightState(negativeXFaceId)).toBe('hovered')
    fireEvent.click(canvas)
    const supportId = 'datum:RP1-support-2'
    await waitFor(() => expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe(supportId))
    expect(screen.getByTestId('offset-plane-source').textContent).toContain(`Face ${negativeXFaceId} of`)
    expect(hooks().getPickHighlightState(negativeXFaceId)).toBe('selected')
    expect(hooks().dag.getNode(supportId)).toBeUndefined()
    expect(hooks().history.size()).toBe(historySizeBefore)

    setDialogNumber('offset-plane-distance', '3')
    const sourceSnapshot = hooks().map.snapshotOf(negativeXFaceId)
    expect(sourceSnapshot?.normal).toBeDefined()
    await waitFor(() => {
      const ghosts = liveGhostGlyphs(runtime)
      expect(ghosts).toHaveLength(1)
      const center = glyphCenter(ghosts[0])
      const normal = sourceSnapshot!.normal!
      const delta = {
        x: center.x - sourceSnapshot!.centroid.x,
        y: center.y - sourceSnapshot!.centroid.y,
        z: center.z - sourceSnapshot!.centroid.z,
      }
      expect(delta.x * normal.x + delta.y * normal.y + delta.z * normal.z).toBeCloseTo(3, 5)
    })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getPickHighlightState(negativeXFaceId)).toBe('none'))

    const support = hooks().dag.getNode(supportId)
    const offset = hooks().dag.getNode('datum:RP1')
    expect(support?.consumes).toEqual(['F1'])
    expect(support?.refs).toEqual([expect.objectContaining({ id: negativeXFaceId, kind: 'single-face', role: 'supportFace' })])
    expect(offset?.consumes).toEqual([supportId])
    const a = (support?.payload as { lastGoodFrame?: { origin: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } }).lastGoodFrame
    const b = (offset?.payload as { lastGoodFrame?: { origin: { x: number; y: number; z: number } } }).lastGoodFrame
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    if (a === undefined || b === undefined) throw new Error('face support or offset frame missing')
    const delta = { x: b.origin.x - a.origin.x, y: b.origin.y - a.origin.y, z: b.origin.z - a.origin.z }
    expect(delta.x * a.normal.x + delta.y * a.normal.y + delta.z * a.normal.z).toBeCloseTo(3, 6)
    expect(Math.abs(delta.z)).toBeLessThan(1e-6)
    expect(hooks().history.size()).toBe(historySizeBefore + 1)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => {
      expect(hooks().dag.getNode('datum:RP1')).toBeUndefined()
      expect(hooks().dag.getNode(supportId)).toBeUndefined()
    })
    expect(hooks().getBodyHandle('F1')).toBeDefined()
  }, 30_000)

  it('picks a live planar face after a topology-changing feature and flips both preview side and normal', async () => {
    const runtime = await boot(createLocalGeomService)
    await createChainedHoleFixture(runtime)
    const historySizeBefore = hooks().history.size()
    const faceIds = hooks().getBodyFaceIds('F2') ?? []
    const faceId = faceIds.find((id) => (hooks().map.snapshotOf(id)?.normal?.x ?? 0) > 0.9)
    expect(faceId).toBeDefined()
    if (faceId === undefined) throw new Error('live chained-body side face missing')
    const source = hooks().map.snapshotOf(faceId)
    expect(source?.normal).toBeDefined()
    if (source?.normal === undefined) throw new Error('live chained-body face frame missing')

    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    expect(screen.getByTestId('offset-plane-viewport-pick-hint').textContent).toMatch(/click a planar model face/i)
    runtime.rayOverride = { origin: { x: 100, y: 0, z: 5 }, direction: { x: -1, y: 0, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    const supportId = 'datum:RP1-support'
    await waitFor(() => expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe(supportId))
    expect(screen.getByTestId('offset-plane-source').textContent).toContain(`Face ${faceId} of Hole F2`)
    expect(hooks().dag.getNode(supportId)).toBeUndefined()
    expect(hooks().history.size()).toBe(historySizeBefore)

    setDialogNumber('offset-plane-distance', '4')
    await waitFor(() => {
      const ghost = liveGhostGlyphs(runtime)[0]
      expect(ghost).toBeDefined()
      const center = glyphCenter(ghost)
      const normal = glyphNormal(ghost)
      const delta = {
        x: center.x - source.centroid.x,
        y: center.y - source.centroid.y,
        z: center.z - source.centroid.z,
      }
      expect(delta.x * source.normal!.x + delta.y * source.normal!.y + delta.z * source.normal!.z).toBeCloseTo(4, 5)
      expect(normal.x * source.normal!.x + normal.y * source.normal!.y + normal.z * source.normal!.z).toBeCloseTo(1, 5)
    })

    fireEvent.click(screen.getByTestId('offset-plane-flip-normal'))
    await waitFor(() => {
      const ghost = liveGhostGlyphs(runtime)[0]
      expect(ghost).toBeDefined()
      const center = glyphCenter(ghost)
      const normal = glyphNormal(ghost)
      const delta = {
        x: center.x - source.centroid.x,
        y: center.y - source.centroid.y,
        z: center.z - source.centroid.z,
      }
      expect(delta.x * source.normal!.x + delta.y * source.normal!.y + delta.z * source.normal!.z).toBeCloseTo(-4, 5)
      expect(normal.x * source.normal!.x + normal.y * source.normal!.y + normal.z * source.normal!.z).toBeCloseTo(-1, 5)
    })

    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined(), { timeout: 20_000 })
    const support = hooks().dag.getNode(supportId)
    const offset = hooks().dag.getNode('datum:RP1')
    if (offset === undefined) throw new Error('committed chained-body offset missing')
    const offsetPayload = offset.payload
    expect(support?.consumes).toEqual(['F2'])
    expect(support?.refs).toEqual([expect.objectContaining({ id: faceId, kind: 'single-face', role: 'supportFace' })])
    expect(isOffsetPlaneDatumPayload(offsetPayload)).toBe(true)
    if (!isOffsetPlaneDatumPayload(offsetPayload)) throw new Error('committed chained-body offset frame missing')
    const committedDelta = {
      x: offsetPayload.lastGoodFrame!.origin.x - source.centroid.x,
      y: offsetPayload.lastGoodFrame!.origin.y - source.centroid.y,
      z: offsetPayload.lastGoodFrame!.origin.z - source.centroid.z,
    }
    expect(committedDelta.x * source.normal.x + committedDelta.y * source.normal.y + committedDelta.z * source.normal.z).toBeCloseTo(-4, 5)
    expect(
      offsetPayload.lastGoodFrame!.normal.x * source.normal.x +
      offsetPayload.lastGoodFrame!.normal.y * source.normal.y +
      offsetPayload.lastGoodFrame!.normal.z * source.normal.z,
    ).toBeCloseTo(-1, 5)
    expect(hooks().history.size()).toBe(historySizeBefore + 1)

    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    expect((screen.getByTestId('offset-plane-distance') as HTMLInputElement).value).toBe('4')
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect(hooks().history.size()).toBe(historySizeBefore + 1)
  }, 60_000)

  it('live-selects an imported model face through the workbench geometry seam and persists its stable owner/face reference', async () => {
    const runtime = await boot(createLocalGeomService)
    await importStepFixture()
    const historySizeBefore = hooks().history.size()
    const faceIds = hooks().getBodyFaceIds('IMP1') ?? []
    const pickFace = faceIds
      .map((id) => ({ id, snapshot: hooks().map.snapshotOf(id) }))
      .filter((entry) => entry.snapshot?.surfaceType === 'plane' && entry.snapshot.normal !== undefined)
      .sort((a, b) => b.snapshot!.area - a.snapshot!.area)[0]
    expect(pickFace).toBeDefined()
    if (pickFace?.snapshot?.normal === undefined) throw new Error('imported planar-face snapshot missing')
    const pickNormal = pickFace.snapshot.normal
    const pickPoint = pickFace.snapshot.centroid

    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XY')
    runtime.rayOverride = {
      origin: {
        x: pickPoint.x + pickNormal.x * 100,
        y: pickPoint.y + pickNormal.y * 100,
        z: pickPoint.z + pickNormal.z * 100,
      },
      direction: { x: -pickNormal.x, y: -pickNormal.y, z: -pickNormal.z },
    }
    const canvas = screen.getByTestId('solids-workbench-canvas')
    fireEvent.pointerMove(canvas)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout').textContent).toContain(pickFace.id))
    expect(hooks().getPickHighlightState(pickFace.id)).toBe('hovered')
    fireEvent.click(canvas)
    const supportId = 'datum:RP1-support'
    await waitFor(() => expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe(supportId))
    expect(screen.getByTestId('offset-plane-source').textContent).toMatch(/Face .+ of Imported fixture/)
    expect(hooks().dag.getNode(supportId)).toBeUndefined()
    expect(hooks().history.size()).toBe(historySizeBefore)

    setDialogNumber('offset-plane-distance', '4')
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined())
    const support = hooks().dag.getNode(supportId)
    const selectedFaceId = support?.refs[0]?.id
    expect(selectedFaceId).toBeDefined()
    expect(faceIds).toContain(selectedFaceId)
    expect(hooks().map.snapshotOf(selectedFaceId!)?.surfaceType).toBe('plane')
    expect(support?.consumes).toEqual(['IMP1'])
    expect(support?.refs).toEqual([expect.objectContaining({ id: selectedFaceId, kind: 'single-face', role: 'supportFace' })])
    expect(hooks().dag.getNode('datum:RP1')?.consumes).toEqual([supportId])
    expect(hooks().history.size()).toBe(historySizeBefore + 1)
  }, 30_000)

  it('cancel and a named non-planar refusal leave no face-support node, preview ghost, or history entry', async () => {
    const runtime = await boot(createLocalGeomService)
    await createExtrudedFixture()
    const historySizeBefore = hooks().history.size()
    const faceIds = hooks().getBodyFaceIds('F1') ?? []
    const positiveXFaceId = faceIds.find((id) => (hooks().map.snapshotOf(id)?.normal?.x ?? 0) > 0.9)
    const negativeXFaceId = faceIds.find((id) => (hooks().map.snapshotOf(id)?.normal?.x ?? 0) < -0.9)
    expect(positiveXFaceId).toBeDefined()
    expect(negativeXFaceId).toBeDefined()
    if (positiveXFaceId === undefined || negativeXFaceId === undefined) throw new Error('side-face snapshots missing')

    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    const canvas = screen.getByTestId('solids-workbench-canvas')
    runtime.rayOverride = { origin: { x: 100, y: 100, z: 100 }, direction: { x: 0, y: 0, z: 1 } }
    fireEvent.pointerMove(canvas)
    expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull()
    expect(canvas.style.cursor).toBe('default')
    fireEvent.click(canvas)
    expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XY')
    expect(hooks().dag.nodeIds().filter((id) => id.includes('support'))).toEqual([])
    expect(hooks().history.size()).toBe(historySizeBefore)

    runtime.rayOverride = { origin: { x: 100, y: 0, z: 5 }, direction: { x: -1, y: 0, z: 0 } }
    fireEvent.pointerMove(canvas)
    await waitFor(() => expect(hooks().getPickHighlightState(positiveXFaceId)).toBe('hovered'))
    runtime.rayOverride = { origin: { x: 100, y: 100, z: 100 }, direction: { x: 0, y: 0, z: 1 } }
    fireEvent.pointerMove(canvas)
    await waitFor(() => expect(hooks().getPickHighlightState(positiveXFaceId)).toBe('none'))
    expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull()
    runtime.rayOverride = { origin: { x: 100, y: 0, z: 5 }, direction: { x: -1, y: 0, z: 0 } }
    fireEvent.pointerMove(canvas)
    await waitFor(() => expect(hooks().getPickHighlightState(positiveXFaceId)).toBe('hovered'))
    fireEvent.click(canvas)
    await waitFor(() => expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:RP1-support'))
    expect(hooks().getPickHighlightState(positiveXFaceId)).toBe('selected')
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(liveGhostGlyphs(runtime)).toHaveLength(0))
    await waitFor(() => expect(hooks().getPickHighlightState(positiveXFaceId)).toBe('none'))
    expect(hooks().dag.getNode('datum:RP1-support')).toBeUndefined()
    expect(hooks().dag.getNode('datum:RP1')).toBeUndefined()
    expect(hooks().history.size()).toBe(historySizeBefore)

    // Clear selection-first memory, reopen on XY, then make the opposite face
    // non-planar in the real ElementMap used by datum replay.
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    const prior = hooks().map.snapshotOf(negativeXFaceId)
    expect(prior).toBeDefined()
    hooks().map.applyDelta({
      featureId: 'test-non-planar-face',
      generated: [negativeXFaceId],
      modified: {},
      deleted: [],
      geometry: {
        [negativeXFaceId]: { ...prior!, surfaceType: 'cylinder', normal: undefined, axis: { x: 0, y: 0, z: 1 } },
      },
    })
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XY')
    const ghostBefore = liveGhostGlyphs(runtime).map(glyphCenter)
    runtime.rayOverride = { origin: { x: -100, y: 0, z: 5 }, direction: { x: 1, y: 0, z: 0 } }
    fireEvent.pointerMove(canvas)
    expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull()
    expect(canvas.style.cursor).toBe('default')
    expect(hooks().getPickHighlightState(negativeXFaceId)).toBe('none')
    fireEvent.click(canvas)
    await waitFor(() => {
      const refusal = useCamStore.getState().consoleEvents.find((event) => event.message.includes(negativeXFaceId))
      expect(refusal?.message).toMatch(/not planar/i)
    })
    expect((screen.getByTestId('offset-plane-source') as HTMLSelectElement).value).toBe('datum:XY')
    expect(hooks().dag.nodeIds().filter((id) => id.includes('support'))).toEqual([])
    expect(hooks().history.size()).toBe(historySizeBefore)
    expect(liveGhostGlyphs(runtime).map(glyphCenter)).toEqual(ghostBefore)
  })
})

// WO-030 (UI-107 slice 1): Offset plane create/edit on the shared
// FeaturePreviewSession contract -- live ghost without history append, Apply =
// one undo step, Cancel/refusal restore the original presentation, edit
// highlights the saved reference.
describe('Offset Plane shared preview session (WO-030)', () => {
  async function createPlaneAt(distance: string, name = 'Fixture clearance'): Promise<void> {
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-name'), { target: { value: name } })
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: distance } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined())
  }

  async function openEditViaViewport(runtime: FakeSceneRuntime): Promise<void> {
    runtime.rayOverride = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    await waitFor(() => expect(screen.getByTestId('offset-plane-distance')).toBeTruthy())
  }

  it('WO-215: the tree eye removes the whole offset-plane pick presentation and round-trips through history and persistence', async () => {
    const runtime = await boot()
    await createPlaneAt('12.5', 'Fixture clearance')
    const eye = screen.getByTestId('feature-row-hide-datum:RP1')
    expect(eye.getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => expect(livePlaneGlyphsFor(runtime, 'datum:RP1').length).toBeGreaterThan(0))

    fireEvent.click(eye)
    await waitFor(() => {
      expect(hooks().dag.getNode('datum:RP1')?.hidden).toBe(true)
      expect(livePlaneGlyphsFor(runtime, 'datum:RP1')).toHaveLength(0)
    })
    expect(screen.getByTestId('feature-row-hide-datum:RP1').getAttribute('aria-pressed')).toBe('true')

    // A ray through both planes now reaches XY: the nearer hidden offset has
    // no sheet, label, depth contribution, or pick target left in the scene map.
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    runtime.rayOverride = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-plane-hover-readout').textContent).toContain('XY plane'))
    expect(screen.getByTestId('solids-workbench-plane-hover-readout').textContent).not.toContain('Fixture clearance')
    fireEvent.click(screen.getByTestId('workbench-cancel-plane-pick'))

    const restoredHidden = FeatureDag.restore(hooks().dag.serialize()).getNode('datum:RP1')
    expect(restoredHidden?.hidden).toBe(true)
    expect((restoredHidden?.payload as { lastGoodFrame?: { origin: { z: number } } }).lastGoodFrame?.origin.z).toBe(12.5)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => {
      expect(hooks().dag.getNode('datum:RP1')?.hidden).toBe(false)
      expect(livePlaneGlyphsFor(runtime, 'datum:RP1').length).toBeGreaterThan(0)
    })
    for (const glyph of livePlaneGlyphsFor(runtime, 'datum:RP1')) {
      for (const z of glyphCornerZs(glyph)) expect(z).toBeCloseTo(12.5, 6)
    }

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => {
      expect(hooks().dag.getNode('datum:RP1')?.hidden).toBe(true)
      expect(livePlaneGlyphsFor(runtime, 'datum:RP1')).toHaveLength(0)
    })

    // The context action uses the same command surface and Show restores the
    // exact persisted frame rather than constructing a replacement plane.
    fireEvent.contextMenu(screen.getByTestId('feature-row-datum:RP1'))
    expect(screen.getByTestId('tree-context-menu-hide').textContent).toContain('Show')
    fireEvent.click(screen.getByTestId('tree-context-menu-hide'))
    await waitFor(() => expect(livePlaneGlyphsFor(runtime, 'datum:RP1').length).toBeGreaterThan(0))
    for (const glyph of livePlaneGlyphsFor(runtime, 'datum:RP1')) {
      for (const z of glyphCornerZs(glyph)) expect(z).toBeCloseTo(12.5, 6)
    }

    // Editing may deliberately present a ghost, but Cancel must honor the
    // user's persisted hidden choice instead of restoring the committed sheet.
    fireEvent.click(screen.getByTestId('feature-row-hide-datum:RP1'))
    await waitFor(() => expect(livePlaneGlyphsFor(runtime, 'datum:RP1')).toHaveLength(0))
    fireEvent.contextMenu(screen.getByTestId('feature-row-datum:RP1'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(liveGhostGlyphs(runtime)).toHaveLength(1))
    expect(livePlaneGlyphsFor(runtime, 'datum:RP1')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => {
      expect(liveGhostGlyphs(runtime)).toHaveLength(0)
      expect(livePlaneGlyphsFor(runtime, 'datum:RP1')).toHaveLength(0)
    })
    expect(hooks().dag.getNode('datum:RP1')?.hidden).toBe(true)
  })

  it('starts a blank sketch on the picked offset sheet and preserves its dependency through undo, redo, and plane replay', async () => {
    const runtime = await boot()
    await createPlaneAt('12.5', 'Fixture clearance')
    const historySizeBeforeSketch = hooks().history.size()

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    runtime.rayOverride = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-plane-hover-readout').textContent).toContain('Fixture clearance'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    const sketchNodeId = hooks().dag.nodeIds().find((id) => id.startsWith('sketch3d:'))
    expect(sketchNodeId).toBeDefined()
    expect(hooks().dag.getNode(sketchNodeId!)?.consumes).toEqual(['datum:RP1'])
    expect((hooks().dag.getNode(sketchNodeId!)?.payload as { planeNodeId?: string }).planeNodeId).toBe('datum:RP1')
    expect(runtime.sketchGridCalls.at(-1)?.frame?.origin.z).toBeCloseTo(12.5, 6)

    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
    expect(hooks().dag.nodeIds().filter((id) => id.startsWith('sketch3d:'))).toEqual([sketchNodeId])
    expect(hooks().history.size()).toBe(historySizeBeforeSketch + 1)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    // Both halves of the undo inside ONE waitFor: the sketch goes and the datum
    // it depended on stays. Asserting the datum after the waitFor read whichever
    // tick the DAG happened to be in and failed WO-1299's lane on 2026-09-09
    // with "expected undefined to be defined".
    await waitFor(() => {
      expect(hooks().dag.getNode(sketchNodeId!)).toBeUndefined()
      expect(hooks().dag.getNode('datum:RP1')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode(sketchNodeId!)).toBeDefined())
    expect(hooks().dag.getNode(sketchNodeId!)?.consumes).toEqual(['datum:RP1'])

    await openEditViaViewport(runtime)
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '25' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect((hooks().dag.getNode('datum:RP1')?.payload as { lastGoodFrame?: { origin: { z: number } } }).lastGoodFrame?.origin.z).toBe(25))

    fireEvent.click(screen.getByTestId(`feature-row-${sketchNodeId}`))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    expect(runtime.sketchGridCalls.at(-1)?.frame?.origin.z).toBeCloseTo(25, 6)
  })

  it('keeps a nearer base plane pick valid when two farther offset sheets are coplanar', async () => {
    const runtime = await boot()
    await createPlaneAt('12.5', 'First offset')
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-name'), { target: { value: 'Second offset' } })
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '12.5' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP2')).toBeDefined())

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    runtime.rayOverride = { origin: { x: 10, y: 10, z: -100 }, direction: { x: 0, y: 0, z: 1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-plane-hover-readout').textContent).toContain('XY plane'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    const sketchNodeId = hooks().dag.nodeIds().find((id) => id.startsWith('sketch3d:'))
    expect(sketchNodeId).toBeDefined()
    expect(hooks().dag.getNode(sketchNodeId!)?.consumes).toEqual(['datum:XY'])
  })

  it('refuses a stale unresolved offset sheet by name without creating a sketch or history entry', async () => {
    const runtime = await boot()
    await createPlaneAt('12.5', 'Fixture clearance')
    const plane = hooks().dag.getNode('datum:RP1')
    if (plane === undefined || !isOffsetPlaneDatumPayload(plane.payload)) throw new Error('offset plane fixture missing')
    const unresolved = { ...plane.payload }
    delete unresolved.lastGoodFrame
    hooks().dag.setPayload('datum:RP1', unresolved)
    const historySizeBefore = hooks().history.size()

    // The already-painted sheet deliberately remains for this queued-click race. The accept point
    // must re-read the datum, reject its now-unresolved frame, and keep the picker armed.
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    runtime.rayOverride = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(screen.getByTestId('solids-workbench-plane-hover-readout').textContent).toMatch(/Fixture clearance is unresolved/i))
    expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull()
    expect(hooks().dag.nodeIds().some((id) => id.startsWith('sketch3d:'))).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)
    expect(useCamStore.getState().consoleEvents.some((event) => /Fixture clearance is unresolved/i.test(event.message))).toBe(true)
  })

  it('refuses a retained last-good offset frame when the current datum replay failed', async () => {
    const runtime = await boot()
    await createPlaneAt('12.5', 'Fixture clearance')
    const planeBeforeFailure = hooks().dag.getNode('datum:RP1')
    const parent = hooks().dag.getNode('datum:XY')
    if (
      planeBeforeFailure === undefined || !isOffsetPlaneDatumPayload(planeBeforeFailure.payload) ||
      parent === undefined
    ) throw new Error('offset plane failure fixture missing')
    const retainedFrame = planeBeforeFailure.payload.lastGoodFrame
    expect(retainedFrame?.origin.z).toBe(12.5)

    hooks().dag.setPayload(parent.id, {
      ...parent.payload,
      lastGoodFrame: {
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 0 },
        xDir: { x: 1, y: 0, z: 0 },
      },
    })
    await hooks().fullResync(['datum:RP1'])
    expect(hooks().scheduler.statusOf('datum:RP1')).toBe('failed')
    const failedPlane = hooks().dag.getNode('datum:RP1')
    expect(failedPlane?.payload.lastGoodFrame).toEqual(retainedFrame)
    const historySizeBefore = hooks().history.size()

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    runtime.rayOverride = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(screen.getByTestId('solids-workbench-plane-hover-readout').textContent).toMatch(/Fixture clearance is unresolved/i))
    expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull()
    expect(hooks().dag.nodeIds().some((id) => id.startsWith('sketch3d:'))).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)
  })

  it('create: live ghost tracks the typed offset without appending history; Apply commits one undo step', async () => {
    const runtime = await boot()
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-name'), { target: { value: 'Ghost check' } })
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '25' } })

    await waitFor(() => {
      const ghosts = liveGhostGlyphs(runtime)
      expect(ghosts).toHaveLength(1)
      for (const z of glyphCornerZs(ghosts[0])) expect(z).toBeCloseTo(25, 6)
    })
    // The ghost previews WITHOUT authoring: no dag node, no undoable command.
    expect(hooks().dag.getNode('datum:RP1')).toBeUndefined()
    expect(hooks().history.canUndo()).toBe(false)

    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '40' } })
    await waitFor(() => {
      const ghosts = liveGhostGlyphs(runtime)
      expect(ghosts).toHaveLength(1)
      for (const z of glyphCornerZs(ghosts[0])) expect(z).toBeCloseTo(40, 6)
    })

    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined())
    const payload = hooks().dag.getNode('datum:RP1')!.payload
    if (!isOffsetPlaneDatumPayload(payload)) throw new Error('wrong payload')
    expect(payload.definition.distance).toBe(40)
    // Session closed with the dialog: ghost and reference highlight are gone.
    await waitFor(() => {
      expect(liveGhostGlyphs(runtime)).toHaveLength(0)
      expect(liveReferenceHighlights(runtime)).toHaveLength(0)
    })

    // ONE undo step covers the whole Apply.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeUndefined())
    expect(hooks().history.canUndo()).toBe(false)
  })

  it('edit: highlights the saved reference, hides the committed sheet behind the ghost, and restores on Cancel; Apply is one undo step', async () => {
    const runtime = await boot()
    await createPlaneAt('12.5')
    await openEditViaViewport(runtime)

    // Initial preview at the saved offset: ghost up, committed sheet down,
    // saved XY reference visibly highlighted.
    await waitFor(() => {
      const ghosts = liveGhostGlyphs(runtime)
      expect(ghosts).toHaveLength(1)
      for (const z of glyphCornerZs(ghosts[0])) expect(z).toBeCloseTo(12.5, 6)
      // WO-034 (finding 4): NO live non-ghost glyph for the edited plane may
      // remain -- not just no ambient sheet. The plane was viewport-SELECTED
      // to reach Edit, so a lingering selected/emphasis glyph would repaint
      // the OLD frame over the ghost and pass the ambient-only check.
      expect(livePlaneGlyphsFor(runtime, 'datum:RP1')).toHaveLength(0)
      const highlights = liveReferenceHighlights(runtime)
      expect(highlights).toHaveLength(1)
      expect(highlights[0].userData.genesisNodeId).toBe('datum:XY')
    })

    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '-7' } })
    await waitFor(() => {
      const ghosts = liveGhostGlyphs(runtime)
      expect(ghosts).toHaveLength(1)
      for (const z of glyphCornerZs(ghosts[0])) expect(z).toBeCloseTo(-7, 6)
    })
    // Still preview-only: the committed definition is untouched.
    expect((hooks().dag.getNode('datum:RP1')!.payload as { definition: { distance: number } }).definition.distance).toBe(12.5)

    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => {
      expect(liveGhostGlyphs(runtime)).toHaveLength(0)
      expect(liveReferenceHighlights(runtime)).toHaveLength(0)
      expect(liveReferenceGlyphs(runtime).map((glyph) => glyph.userData.referencePlaneNodeId)).toContain('datum:RP1')
    })
    expect((hooks().dag.getNode('datum:RP1')!.payload as { definition: { distance: number } }).definition.distance).toBe(12.5)

    // Apply an edit and undo it in ONE step.
    await openEditViaViewport(runtime)
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '-7' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect((hooks().dag.getNode('datum:RP1')!.payload as { definition: { distance: number } }).definition.distance).toBe(-7))
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect((hooks().dag.getNode('datum:RP1')!.payload as { definition: { distance: number } }).definition.distance).toBe(12.5))
  })

  it('refusal: a model change under a live edit session refuses the preview, restores the original presentation, and disables Apply', async () => {
    const runtime = await boot()
    await createPlaneAt('12.5')
    await openEditViaViewport(runtime)
    await waitFor(() => expect(liveGhostGlyphs(runtime)).toHaveLength(1))

    // Another actor mutates the document while the session is live.
    const { input } = buildOffsetPlaneDatumNodeInput({ id: 'ZZ', parentPlaneNodeId: 'datum:XY', distance: 1 })
    hooks().dag.insertNode(input)

    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '5' } })
    await waitFor(() => {
      expect(screen.getByTestId('offset-plane-preview-refusal').textContent).toMatch(/model changed/i)
      expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
      // Refusal restores the pre-session presentation: ghost gone, sheet back.
      expect(liveGhostGlyphs(runtime)).toHaveLength(0)
      expect(liveReferenceGlyphs(runtime).map((glyph) => glyph.userData.referencePlaneNodeId)).toContain('datum:RP1')
    })

    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect((hooks().dag.getNode('datum:RP1')!.payload as { definition: { distance: number } }).definition.distance).toBe(12.5)
  })

  // WO-034 (finding 2): the existing drift test changes the distance first,
  // which re-evaluates the preview and masks the commit-time hole. Here the
  // model mutates AFTER the ready preview and Apply fires with UNCHANGED
  // dialog values, so no re-evaluation intervenes -- the commit itself must
  // refuse against the stale session baseline.
  it('apply guard: a model change after a ready preview refuses an immediate Apply with unchanged values', async () => {
    const runtime = await boot()
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-name'), { target: { value: 'Guarded' } })
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '25' } })
    await waitFor(() => expect(liveGhostGlyphs(runtime)).toHaveLength(1))
    await waitForApplyEnabled()

    // Another actor mutates the document. Nothing touches the dialog, so no
    // preview re-request runs and the session still reports 'ready'.
    const { input } = buildOffsetPlaneDatumNodeInput({ id: 'ZZ', parentPlaneNodeId: 'datum:XY', distance: 1 })
    hooks().dag.insertNode(input)
    const historySizeBefore = hooks().history.size()

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.getByTestId('offset-plane-error').textContent).toMatch(/model changed/i))
    // REFUSED: no committed node, no history entry, session torn down.
    expect(hooks().dag.getNode('datum:RP1')).toBeUndefined()
    expect(hooks().history.size()).toBe(historySizeBefore)
    expect(hooks().history.canUndo()).toBe(false)
    expect(liveGhostGlyphs(runtime)).toHaveLength(0)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
  })

  // WO-034 (finding 3): drive the adapter through the session's TERMINAL
  // 'error' result -- distinct from Cancel and from an evaluate 'refused'. A
  // throwing presentCandidate (ghost paint fails) must land the same honest
  // teardown: ghost gone, committed sheet restored, history untouched.
  it('error: a ghost presentation failure takes the terminal error path and restores the committed presentation', async () => {
    const runtime = await boot()
    await createPlaneAt('12.5')
    await openEditViaViewport(runtime)
    await waitFor(() => expect(liveGhostGlyphs(runtime)).toHaveLength(1))
    const historySizeBefore = hooks().history.size()

    // Detonate the NEXT ghost paint only: the sentinel-id check leaves every
    // other addObject (sheet rebuilds, emphasis glyphs) untouched.
    const realAddObject = runtime.addObject
    let armed = true
    runtime.addObject = (object) => {
      if (armed && object.userData.referencePlaneNodeId === 'offset-plane-preview-ghost') {
        armed = false
        throw new Error('ghost presentation exploded')
      }
      realAddObject(object)
    }

    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '5' } })
    await waitFor(() => {
      expect(screen.getByTestId('offset-plane-preview-refusal').textContent).toMatch(/ghost presentation exploded/i)
      expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
      expect(liveGhostGlyphs(runtime)).toHaveLength(0)
      expect(liveReferenceGlyphs(runtime).map((glyph) => glyph.userData.referencePlaneNodeId)).toContain('datum:RP1')
    })
    expect((hooks().dag.getNode('datum:RP1')!.payload as { definition: { distance: number } }).definition.distance).toBe(12.5)
    expect(hooks().history.size()).toBe(historySizeBefore)
  })
})
