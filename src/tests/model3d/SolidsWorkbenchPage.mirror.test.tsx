// @vitest-environment jsdom
//
// WO-3244: Model > Modify > Mirror on the mounted Model screen with the REAL
// geometry kernel. The route under test is the application's own: the rail
// button -> MirrorDialog -> createFeatureCommand / EditFeaturePayloadCommand
// -> handleDialogApplied's regen -> makeReplayExecutor's bodyTransform branch
// -> the shared src/doc/features/bodyTransform.ts adapter -> transformBody.
//
// The body: the rectangle sketch [10,50]x[0,20] on XY extruded 5 mm. Mirrored
// in YZ (x=0) it spans x -50..-10; in an Offset Plane 20 mm off YZ (x=20) it
// spans x -10..30. Coordinates are read from the result body's own face
// snapshots (exact kernel doubles), never from triangle counts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { OpResult, TransformBodyRequest } from '../../geom/geom-service'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { DagCycleError, InsertNodeCommand, SetRollbackMarkerCommand, SetSuppressedCommand } from '../../doc'
import { EditFeaturePayloadCommand } from '../../components/model3d/dialogs/EditFeaturePayloadCommand'
import { buildConstructionPlaneDatumNodeInput, buildFacePlaneDatumNodeInput, buildOffsetPlaneDatumNodeInput } from '../../sketch3d/datumPlane'
import { BASE_PLANE_YZ_NODE_ID } from '../../doc/genesis'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'
import { bodyTransformConsumes, mirrorReplacePayload, mirroredStableId } from '../../doc/features/bodyTransform'

afterEach(cleanup)
let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

const transformCalls: TransformBodyRequest[] = []
function realClient(): GeomClient {
  const client = createLocalGeomService()
  const transformBody = client.transformBody!.bind(client)
  client.transformBody = async (req: TransformBodyRequest): Promise<OpResult> => {
    transformCalls.push(req)
    return transformBody(req)
  }
  return client
}

async function bootWithBox(): Promise<void> {
  transformCalls.length = 0
  render(<SolidsWorkbenchPage createClient={realClient} createSceneRuntime={createFakeSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  await mintRectangleSketch()
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id: 'F1', kind: 'feature', consumes: ['SK1'],
    payload: { opType: 'extrude', sketchId: 'SK1', distance: 5, direction: 'up', boolMode: 'newBody', name: 'Block' },
  }))
  await hooks().fullResync(['F1'])
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })
}

/** x extent of a body from its planar faces' exact centroids. */
async function xExtent(featureId: string): Promise<[number, number]> {
  const handle = hooks().getBodyHandle(featureId)
  expect(handle, `${featureId} has a body`).not.toBeUndefined()
  const snaps = await hooks().client.snapshotsFor(handle!)
  const xs = Object.values(snaps).filter((s) => s.type === 'plane').map((s) => s.centroid[0])
  return [Math.min(...xs), Math.max(...xs)]
}

function selectValue(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}

async function applyMirror(planeNodeId: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-mirror'))
  await waitFor(() => expect(screen.getByTestId('mirror-dialog')).toBeTruthy())
  expect(screen.getByTestId('mirror-result').textContent).toBe('Replace original')
  selectValue('mirror-body-select', 'F1')
  selectValue('mirror-plane-select', planeNodeId)
  await waitFor(() => expect(screen.getByTestId('mirror-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 30_000 })
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
}

describe('WO-3244: Mirror (replace original) on the Model screen', () => {
  it('previews, applies as one history step and replaces the body with its exact reflection', async () => {
    await bootWithBox()
    expect(await xExtent('F1')).toEqual([10, 50])
    const before = hooks().history.size()

    fireEvent.click(screen.getByTestId('workbench-mirror'))
    await waitFor(() => expect(screen.getByTestId('mirror-dialog')).toBeTruthy())
    selectValue('mirror-body-select', 'F1')
    selectValue('mirror-plane-select', BASE_PLANE_YZ_NODE_ID)
    await waitFor(() => expect(screen.getByTestId('mirror-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 30_000 })
    // the preview wrote nothing and hid nothing
    expect(hooks().history.size()).toBe(before)
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F1')).not.toBe(false)
    expect(transformCalls.at(-1)?.transform).toEqual({ kind: 'mirror', plane: expect.objectContaining({ origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }) })

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().history.size()).toBe(before + 1)
    expect(hooks().scheduler.statusOf('F2')).toBe('ok')
    const node = hooks().dag.getNode('F2')!
    expect(node.payload).toMatchObject({ opType: 'bodyTransform', version: 1, sourceBodyId: 'F1', transform: { kind: 'mirror', planeNodeId: BASE_PLANE_YZ_NODE_ID }, result: 'replace' })
    expect([...node.consumes].sort()).toEqual(['F1', BASE_PLANE_YZ_NODE_ID].sort())

    // the reflection, exactly: x 10..50 -> -50..-10
    expect(await xExtent('F2')).toEqual([-50, -10])
    const volume = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    expect(Math.abs(volume.value - 40 * 20 * 5) / 4000).toBeLessThan(1e-6)
    // it replaced the source: one body to export, the mirror
    const exported = hooks().getExportBodies?.().map((b) => b.id)
    expect(exported).toContain('F2')
    expect(exported).not.toContain('F1')
    // every face is named from the source face it reflects
    const ids = Object.keys(await hooks().client.snapshotsFor(hooks().getBodyHandle('F2')!))
    expect(ids.every((id) => id.startsWith('F2:PAT:i1:F1:'))).toBe(true)

    // undo restores the source; redo regenerates the same ids
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')).toBeUndefined())
    expect(hooks().getExportBodies?.().map((b) => b.id)).toContain('F1')
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
    expect(Object.keys(await hooks().client.snapshotsFor(hooks().getBodyHandle('F2')!)).sort()).toEqual([...ids].sort())
  }, 120_000)

  it('Edit reopens the plane choice, keeps the id and timeline slot, and follows a moved plane', async () => {
    await bootWithBox()
    const { nodeId: planeId, input } = buildOffsetPlaneDatumNodeInput({ id: 'OP1', parentPlaneNodeId: BASE_PLANE_YZ_NODE_ID, distance: 20 })
    hooks().history.execute(new InsertNodeCommand(input))
    await hooks().fullResync([planeId])
    await applyMirror(BASE_PLANE_YZ_NODE_ID)
    const slot = hooks().dag.featureOrder().indexOf('F2')

    const entry = hooks().editEntryFor('F2')
    expect(entry !== undefined && 'onEdit' in entry).toBe(true)
    if (entry !== undefined && 'onEdit' in entry) entry.onEdit()
    await waitFor(() => expect(screen.getByTestId('mirror-dialog')).toBeTruthy())
    expect((screen.getByTestId('mirror-plane-select') as HTMLSelectElement).value).toBe(BASE_PLANE_YZ_NODE_ID)
    selectValue('mirror-plane-select', planeId)
    await waitFor(() => expect(screen.getByTestId('mirror-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(async () => expect(await xExtent('F2')).toEqual([-10, 30]), { timeout: 30_000 })
    expect(hooks().dag.featureOrder().indexOf('F2')).toBe(slot)
    expect([...hooks().dag.getNode('F2')!.consumes].sort()).toEqual(['F1', planeId].sort())

    // moving the plane 2 mm moves the reflection 4 mm: x = 44 - x -> -6..34
    const plane = hooks().dag.getNode(planeId)!
    hooks().dag.setPayload(planeId, { ...plane.payload, definition: { kind: 'offset', distance: 22, flipNormal: false } })
    await hooks().fullResync([planeId])
    await waitFor(async () => expect(await xExtent('F2')).toEqual([-6, 34]), { timeout: 30_000 })

    // suppressing the mirror exposes the source again
    hooks().history.execute(new SetSuppressedCommand('F2', true))
    await hooks().fullResync(['F2'])
    await waitFor(() => expect(hooks().getExportBodies?.().map((b) => b.id)).toContain('F1'))
    expect(hooks().getExportBodies?.().map((b) => b.id)).not.toContain('F2')
  }, 120_000)

  it('a plane that cannot be placed refuses by name, records nothing and leaves the source', async () => {
    await bootWithBox()
    fireEvent.click(screen.getByTestId('workbench-mirror'))
    await waitFor(() => expect(screen.getByTestId('mirror-dialog')).toBeTruthy())
    // a forced payload naming a non-plane, replayed through the same route
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F9', kind: 'feature', consumes: ['F1', 'SK1'],
      payload: { opType: 'bodyTransform', version: 1, sourceBodyId: 'F1', transform: { kind: 'mirror', planeNodeId: 'SK1' }, result: 'replace', name: 'Mirror F9' },
    }))
    await hooks().fullResync(['F9'])
    expect(hooks().scheduler.statusOf('F9')).toBe('failed')
    expect(hooks().getBodyHandle('F9')).toBeUndefined()
    expect(String(hooks().scheduler.diagnosticsOf('F9')[0]?.params?.reason)).toMatch(/could not be placed, so the body was not mirrored/)
    expect(hooks().getExportBodies?.().map((b) => b.id)).toContain('F1')
  }, 120_000)

  // Audit fix round, finding 1: a Mirror applied at a rolled-back marker
  // replaces its source THERE, so the rolled-back feature below that worked on
  // the source (an Add extrude targeting F1) must work on the Mirror after it.
  it('Mirror applied at the rollback marker moves the later feature on that body onto the mirror, and it still applies', async () => {
    await bootWithBox()
    // F3 adds a 30x20x5 block at x -15..15 to F1 (x 10..50): x -15..50
    await mintRectangleSketch({ id: 'SK2', offset: -15, width: 30, height: 20 })
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F3', kind: 'feature', consumes: ['SK2', 'F1'],
      payload: { opType: 'extrude', sketchId: 'SK2', distance: 5, direction: 'up', boolMode: 'add', targetFeatureId: 'F1', name: 'Add F3' },
    }))
    await hooks().fullResync(['F3'])
    await waitFor(async () => expect(await xExtent('F3')).toEqual([-15, 50]), { timeout: 30_000 })

    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'after', nodeId: 'SK2' }))
    await hooks().fullResync(['F3'])
    expect(hooks().dag.isRolledBack('F3')).toBe(true)
    const before = hooks().history.size()
    await applyMirror(BASE_PLANE_YZ_NODE_ID)
    expect(hooks().history.size()).toBe(before + 1)
    expect(hooks().dag.featureOrder().indexOf('F2')).toBeLessThan(hooks().dag.featureOrder().indexOf('F3'))
    const later = hooks().dag.getNode('F3')!
    expect(later.payload.targetFeatureId).toBe('F2')
    expect([...later.consumes].sort()).toEqual(['F2', 'SK2'])

    // roll forward: F3 now adds to the reflection (x -50..-10) -> x -50..15
    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'end' }))
    await hooks().fullResync(hooks().dag.featureOrder())
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).toBe('ok'), { timeout: 30_000 })
    expect(await xExtent('F3')).toEqual([-50, 15])
    const exported = hooks().getExportBodies?.().map((b) => b.id)
    expect(exported).toContain('F3')
    expect(exported).not.toContain('F1')
    expect(exported).not.toContain('F2')
    // replay is stable: a second full regen gives the same body
    await hooks().fullResync(hooks().dag.featureOrder())
    expect(hooks().scheduler.statusOf('F3')).toBe('ok')
    expect(await xExtent('F3')).toEqual([-50, 15])

    // undo the roll-forward, then the Mirror: F3 is back on F1
    hooks().history.undo()
    hooks().history.undo()
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(hooks().dag.getNode('F3')!.payload.targetFeatureId).toBe('F1')
    expect([...hooks().dag.getNode('F3')!.consumes].sort()).toEqual(['F1', 'SK2'])
  }, 120_000)

  // Audit round 2 (astra, geom-engine.ts:4304): the later feature names one of
  // the source's EDGES. Inserting the Mirror at the marker moves the fillet onto
  // the Mirror; the fillet keeps its own edge, and the Model tab's own replay
  // resolves it through the Mirror onto the reflection - the same solid as
  // mirroring the filleted block.
  it('Mirror applied at the rollback marker carries a later fillet\'s edge onto the mirrored body', async () => {
    await bootWithBox()
    const block = hooks().getBodyHandle('F1')!
    const edges = (await hooks().client.tessellate(block, { deflection: 0.1, angularDeflection: 0.5 })).edgeIds
    const edge = edges.filter((id) => !id.includes('cap')).sort()[0]
    expect(edge, 'a vertical edge between two side faces').toBeDefined()
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F3', kind: 'feature', consumes: ['F1'],
      payload: { opType: 'fillet', ownerId: 'F1', edges: [edge], radius: 2, propagateTangent: true, name: 'Fillet F3' },
    }))
    await hooks().fullResync(['F3'])
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).toBe('ok'), { timeout: 30_000 })
    const filleted = hooks().getBodyHandle('F3')!
    const volume = (await hooks().client.measure(filleted, 'volume')).value
    const bandBefore = (await hooks().client.snapshotsFor(filleted))[`F3:FIL:${edge}`]
    expect(bandBefore, 'the fillet band before the mirror').toBeDefined()

    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'after', nodeId: 'F1' }))
    await hooks().fullResync(['F3'])
    expect(hooks().dag.isRolledBack('F3')).toBe(true)
    await applyMirror(BASE_PLANE_YZ_NODE_ID)
    // stored: its own edge, never rewritten; resolved at replay by name
    expect(hooks().dag.getNode('F3')!.payload.edges).toEqual([edge])
    expect(hooks().dag.getNode('F3')!.payload.ownerId).toBe('F2')
    const mapped = mirroredStableId('F2', edge)!
    expect(mapped.startsWith('(F2:PAT:i1:')).toBe(true)

    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'end' }))
    await hooks().fullResync(hooks().dag.featureOrder())
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).toBe('ok'), { timeout: 30_000 })
    expect(await xExtent('F3')).toEqual([-50, -10])
    const after = hooks().getBodyHandle('F3')!
    expect(Math.abs((await hooks().client.measure(after, 'volume')).value - volume)).toBeLessThan(1e-6 * volume)
    const band = (await hooks().client.snapshotsFor(after))[`F3:FIL:${mapped}`]
    expect(band, 'the fillet band on the mirrored edge').toBeDefined()
    expect(band.centroid[0]).toBeCloseTo(-bandBefore.centroid[0], 6)
    expect(band.centroid[1]).toBeCloseTo(bandBefore.centroid[1], 6)
    expect(band.centroid[2]).toBeCloseTo(bandBefore.centroid[2], 6)

    // Edit seeds the fillet's pick with its edge resolved onto the body on
    // screen, so its preview builds on the reflection
    const entry = hooks().editEntryFor('F3')
    expect(entry !== undefined && 'onEdit' in entry).toBe(true)
    if (entry !== undefined && 'onEdit' in entry) entry.onEdit()
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect(hooks().dag.getNode('F3')!.payload.edges).toEqual([edge])

    // undo the roll-forward, then the Mirror: F3 is back on F1's own edge
    hooks().history.undo()
    hooks().history.undo()
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(hooks().dag.getNode('F3')!.payload.edges).toEqual([edge])
    expect(hooks().dag.getNode('F3')!.payload.ownerId).toBe('F1')
  }, 120_000)

  // Audit round 3 (astra, bodyTransform.ts:234), on the Model tab's own route:
  // a hole on the block, a Mirror inserted before it in an Offset Plane, then
  // the plane moved. The hole keeps its own point; each replay resolves it
  // through the plane where it is then, so it lands on the reflection both
  // times instead of failing outside the moved face.
  it('a hole after a Mirror inserted at the marker follows the Mirror plane when the plane moves', async () => {
    await bootWithBox()
    const { nodeId: planeId, input } = buildOffsetPlaneDatumNodeInput({ id: 'OP1', parentPlaneNodeId: BASE_PLANE_YZ_NODE_ID, distance: 0 })
    hooks().history.execute(new InsertNodeCommand(input))
    await hooks().fullResync([planeId])
    const snaps = await hooks().client.snapshotsFor(hooks().getBodyHandle('F1')!)
    const top = Object.entries(snaps).find(([, s]) => s.type === 'plane' && Math.abs(s.centroid[2] - 5) < 1e-9)?.[0]
    expect(top, 'the block top face').toBeDefined()
    const hole = { opType: 'hole', ownerId: 'F1', faceId: top!, points: [{ x: 20, y: 10, z: 5 }], style: { kind: 'simple', diameter: 2 }, depth: { kind: 'blind', distance: 2 }, name: 'Hole F3' }
    hooks().history.execute(createFeatureCommand(hooks().dag, { id: 'F3', kind: 'feature', consumes: ['F1'], refs: [{ id: top!, kind: 'single-face' }], payload: hole }))
    await hooks().fullResync(['F3'])
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).toBe('ok'), { timeout: 30_000 })
    const volume = (await hooks().client.measure(hooks().getBodyHandle('F3')!, 'volume')).value
    expect(Math.abs(volume - (4000 - Math.PI * 2))).toBeLessThan(1e-6 * 4000)

    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'after', nodeId: planeId }))
    await hooks().fullResync(['F3'])
    await applyMirror(planeId)
    expect(hooks().dag.getNode('F3')!.payload.ownerId).toBe('F2')
    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'end' }))
    await hooks().fullResync(hooks().dag.featureOrder())
    // the hole wall's axis is where the reflected point is: x = 2*d - 20
    const holeAxisX = async (): Promise<number> => {
      const wall = Object.values(await hooks().client.snapshotsFor(hooks().getBodyHandle('F3')!)).find((s) => s.type === 'cylinder')
      expect(wall, 'the hole wall').toBeDefined()
      return wall!.centroid[0]
    }
    for (const [distance, extent, axisX] of [[0, [-50, -10], -20], [22, [-6, 34], 24]] as const) {
      if (distance !== 0) {
        const plane = hooks().dag.getNode(planeId)!
        hooks().dag.setPayload(planeId, { ...plane.payload, definition: { kind: 'offset', distance, flipNormal: false } })
        await hooks().fullResync([planeId])
      }
      await waitFor(async () => expect(await xExtent('F2')).toEqual(extent), { timeout: 30_000 })
      await waitFor(() => expect(hooks().scheduler.statusOf('F3'), JSON.stringify(hooks().scheduler.diagnosticsOf('F3'))).toBe('ok'), { timeout: 30_000 })
      expect(await xExtent('F3')).toEqual(extent)
      expect(Math.abs((await hooks().client.measure(hooks().getBodyHandle('F3')!, 'volume')).value - volume)).toBeLessThan(1e-6 * volume)
      expect(await holeAxisX()).toBeCloseTo(axisX, 6)
    }
    // the stored hole never changed: its own face and point, on the Mirror
    expect(hooks().dag.getNode('F3')!.payload).toEqual({ ...hole, ownerId: 'F2' })
  }, 120_000)

  // Audit round 2: a later feature whose reference has no mirrored form (a
  // recognized-hole key) refuses the Apply by feature and reference; nothing
  // is written and the later feature keeps its body.
  it('Apply refuses by name when a later feature on the body keeps a reference the mirror cannot carry', async () => {
    await bootWithBox()
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F3', kind: 'feature', consumes: ['F1'],
      payload: { opType: 'resizeHole', ownerId: 'F1', featureKey: 'hole@F1:1', currentDiameter: 6, newDiameter: 8, delta: 1, name: 'Resize hole F3' },
    }))
    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'after', nodeId: 'F1' }))
    const before = hooks().history.size()
    fireEvent.click(screen.getByTestId('workbench-mirror'))
    await waitFor(() => expect(screen.getByTestId('mirror-dialog')).toBeTruthy())
    selectValue('mirror-body-select', 'F1')
    selectValue('mirror-plane-select', BASE_PLANE_YZ_NODE_ID)
    await waitFor(() => expect(screen.getByTestId('mirror-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.getByTestId('mirror-apply-error').textContent).toMatch(/Resize hole F3 comes later on this body and keeps a reference \(hole@F1:1\) the mirror cannot carry/))
    expect(hooks().history.size()).toBe(before)
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(hooks().dag.getNode('F3')!.payload.ownerId).toBe('F1')
    expect(hooks().dag.getNode('F3')!.consumes).toEqual(['F1'])
  }, 120_000)

  // Audit round 3, finding 2 (PROOF-MISSING after it): a draft pulled along +z,
  // then a Mirror inserted before it at the marker, in a plane at 30 deg to XY
  // (hinge x, normal (0,-1/2,sqrt3/2)). The reflected pull is oblique - not a
  // principal axis - and is still a direction the kernel drafts along, so Apply
  // carries the draft onto the Mirror and it replays on the reflection.
  it('a draft after a Mirror inserted at the marker in an oblique plane carries onto the mirror and replays', async () => {
    await bootWithBox()
    const { nodeId: planeId, input } = buildConstructionPlaneDatumNodeInput({
      id: 'RP1', parentPlaneNodeIds: ['datum:XY'], definition: { kind: 'angle', angleDeg: 30, hinge: 'x', flipNormal: false }, name: 'Plane at 30',
    })
    hooks().history.execute(new InsertNodeCommand(input))
    await hooks().fullResync([planeId])
    await waitFor(() => expect(hooks().dag.getNode(planeId)!.payload.lastGoodFrame).not.toBeUndefined(), { timeout: 30_000 })
    const frame = hooks().dag.getNode(planeId)!.payload.lastGoodFrame as { normal: { x: number; y: number; z: number } }
    expect(Math.abs(frame.normal.z)).toBeGreaterThan(1e-3)
    expect(Math.abs(Math.abs(frame.normal.z) - 1)).toBeGreaterThan(1e-3)
    const snaps = await hooks().client.snapshotsFor(hooks().getBodyHandle('F1')!)
    const planar = Object.entries(snaps).filter(([, s]) => s.type === 'plane')
    const yMax = Math.max(...planar.map(([, s]) => s.centroid[1]))
    const side = planar.find(([, s]) => Math.abs(s.centroid[1] - yMax) < 1e-9)?.[0]
    expect(side, 'the block +y side face').toBeDefined()
    const draft = { opType: 'draft', ownerId: 'F1', faces: [side!], angleDeg: 3, pullAxis: 'z', pullFlip: false, pullMode: 'axis', offset: 0, name: 'Draft F3' }
    hooks().history.execute(createFeatureCommand(hooks().dag, { id: 'F3', kind: 'feature', consumes: ['F1'], payload: draft }))
    await hooks().fullResync(['F3'])
    await waitFor(() => expect(hooks().scheduler.statusOf('F3'), JSON.stringify(hooks().scheduler.diagnosticsOf('F3'))).toBe('ok'), { timeout: 30_000 })
    const volume = (await hooks().client.measure(hooks().getBodyHandle('F3')!, 'volume')).value

    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'after', nodeId: planeId }))
    await hooks().fullResync(['F3'])
    const before = hooks().history.size()
    fireEvent.click(screen.getByTestId('workbench-mirror'))
    await waitFor(() => expect(screen.getByTestId('mirror-dialog')).toBeTruthy())
    selectValue('mirror-body-select', 'F1')
    selectValue('mirror-plane-select', planeId)
    await waitFor(() => expect(screen.getByTestId('mirror-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 30_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(screen.queryByTestId('mirror-apply-error')?.textContent ?? null).toBeNull()
    expect(hooks().history.size()).toBe(before + 1)
    expect(hooks().dag.getNode('F3')!.payload.ownerId).toBe('F2')
    expect(hooks().dag.getNode('F3')!.consumes).toEqual(['F2'])

    hooks().history.execute(new SetRollbackMarkerCommand({ kind: 'end' }))
    await hooks().fullResync(hooks().dag.featureOrder())
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('F3'), JSON.stringify(hooks().scheduler.diagnosticsOf('F3'))).toBe('ok'), { timeout: 30_000 })
    // a reflection keeps the volume; the drafted reflection keeps the draft's
    expect(Math.abs((await hooks().client.measure(hooks().getBodyHandle('F3')!, 'volume')).value - volume)).toBeLessThan(1e-6 * volume)
    // the stored draft never changed: its own face, pull and offset, on the Mirror
    expect(hooks().dag.getNode('F3')!.payload).toEqual({ ...draft, ownerId: 'F2' })
  }, 120_000)

  // Audit finding 2: a plane built from the Mirror's own result cannot place
  // that Mirror. Edit leaves it out of the plane list (architect 10-29 3:25 AM),
  // and the shared edit command refuses the edge on any route; the feature
  // graph stays acyclic and nothing is written.
  it('Edit leaves out a plane built from the mirror result; the edit command refuses it and the graph is unchanged', async () => {
    await bootWithBox()
    await applyMirror(BASE_PLANE_YZ_NODE_ID)
    // a plane on the mirror's +x face (x = -10), then an Offset Plane from it
    const snaps = await hooks().client.snapshotsFor(hooks().getBodyHandle('F2')!)
    const faceId = Object.entries(snaps).find(([, s]) => s.type === 'plane' && Math.abs(s.centroid[0] + 10) < 1e-6)?.[0]
    expect(faceId, 'the mirror has its x=-10 face').not.toBeUndefined()
    const face = buildFacePlaneDatumNodeInput({ id: 'FP1', ownerId: 'F2', faceId: faceId! })
    hooks().history.execute(new InsertNodeCommand(face.input))
    const offset = buildOffsetPlaneDatumNodeInput({ id: 'OP9', parentPlaneNodeId: face.nodeId, distance: 0, name: 'Plane on mirror' })
    hooks().history.execute(new InsertNodeCommand(offset.input))
    await hooks().fullResync([face.nodeId, offset.nodeId])
    await waitFor(() => expect(hooks().dag.getNode(offset.nodeId)!.payload.lastGoodFrame).not.toBeUndefined(), { timeout: 30_000 })
    const consumesBefore = [...hooks().dag.getNode('F2')!.consumes].sort()
    const historyBefore = hooks().history.size()

    const entry = hooks().editEntryFor('F2')
    if (entry !== undefined && 'onEdit' in entry) entry.onEdit()
    await waitFor(() => expect(screen.getByTestId('mirror-dialog')).toBeTruthy())
    const offered = Array.from((screen.getByTestId('mirror-plane-select') as HTMLSelectElement).options).map((o) => o.value)
    expect(offered).toContain(BASE_PLANE_YZ_NODE_ID)
    expect(offered).not.toContain(offset.nodeId)
    expect(offered).not.toContain(face.nodeId)
    expect(screen.queryByTestId('mirror-cycle-error')).toBeNull()
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    // the same edit through the shared command (any route): refused by name, nothing written
    const next = mirrorReplacePayload({ sourceBodyId: 'F1', planeNodeId: offset.nodeId, name: 'Mirror F2' })
    expect(() => hooks().history.execute(new EditFeaturePayloadCommand('F2', { ...next }, bodyTransformConsumes(next)))).toThrow(DagCycleError)
    expect([...hooks().dag.getNode('F2')!.consumes].sort()).toEqual(consumesBefore)
    expect(hooks().dag.getNode('F2')!.payload.transform).toEqual({ kind: 'mirror', planeNodeId: BASE_PLANE_YZ_NODE_ID })
    expect(hooks().history.size()).toBe(historyBefore)
    expect(() => hooks().dag.topoOrder()).not.toThrow()
  }, 120_000)
})
