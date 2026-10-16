// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, FeatureDag } from '../../doc'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import type { ExtrudeRequest, GeometrySnapshot, StableId } from '../../geom/geom-service'
import { createLocalGeomService, type GeomClient } from '../../geom'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { mintRectangleSketch } from './mintRectangleSketch'
import { stubCanvas2d } from './stubCanvas2d'
import { buildOffsetPlaneDatumNodeInput, isOffsetPlaneDatumPayload } from '../../sketch3d'
import { useCamStore } from '../../store'

let restoreCanvas: (() => void) | null = null

beforeEach(() => { restoreCanvas = stubCanvas2d() })
afterEach(() => {
  cleanup()
  restoreCanvas?.()
  restoreCanvas = null
})

function hooks(): SolidsWorkbenchHooks {
  if (window.__solidsWorkbenchHooks === undefined) throw new Error('workbench hooks unavailable')
  return window.__solidsWorkbenchHooks
}

async function boot(
  reqs: ExtrudeRequest[],
  createClient?: () => GeomClient,
): Promise<{ client: GeomClient; runtime: FakeSceneRuntime }> {
  const client = createClient?.() ?? createFakeGeomClient({
    makeExtrudeImpl: (req, mintHandle) => {
      reqs.push(req)
      const automaticTargets = req.end.kind === 'upToNext'
        ? req.end.candidates.slice(0, 1).map((candidate) => candidate.identity)
        : req.end.kind === 'throughAll'
          ? req.end.targets.map((target) => target.identity)
          : []
      return {
        ok: true,
        body: mintHandle(),
        diagnostics: [],
        ...(automaticTargets.length === 0 ? {} : {
          resolvedExtrudeEnd: {
            kind: req.end.kind,
            startDistance: 0,
            endDistance: 10,
            targets: automaticTargets,
          },
        }),
      }
    },
  })
  let runtime: FakeSceneRuntime | null = null
  const createRuntime: CreateSceneRuntime = () => {
    runtime = createFakeSceneRuntime()
    return runtime
  }
  render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={createRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  const canvas = screen.getByTestId('solids-workbench-canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect)
  return { client, runtime: runtime as unknown as FakeSceneRuntime }
}

function commitNumber(testId: string, raw: string): void {
  const root = screen.getByTestId(testId)
  const input = root instanceof HTMLInputElement ? root : root.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`${testId} has no numeric input`)
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function createFirstBody(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
}

function selectEndCondition(value: string): void {
  fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value } })
}

function seedDisplayedFaceSnapshots(bodyId: string): StableId[] {
  const faceIds = hooks().getBodyFaceIds(bodyId) ?? []
  const geometry: Record<StableId, GeometrySnapshot> = {}
  for (const id of faceIds) {
    const index = Number(id.match(/#(\d+)$/)?.[1] ?? -1)
    const axis = Math.floor(index / 2)
    const sign = index % 2 === 0 ? -1 : 1
    const normal = { x: axis === 0 ? sign : 0, y: axis === 1 ? sign : 0, z: axis === 2 ? sign : 0 }
    geometry[id] = { surfaceType: 'plane', centroid: { x: 0, y: 0, z: axis === 2 ? sign * 5 : 0 }, normal, area: 1 }
  }
  hooks().map.applyDelta({ featureId: `test-snapshots-${bodyId}`, modified: {}, generated: faceIds, deleted: [], geometry })
  return faceIds
}

describe('WO-216 extrude end conditions', () => {
  it('exposes all seven conditions and sends Up to next / Through all through the mounted preview without authoring transient changes', async () => {
    const reqs: ExtrudeRequest[] = []
    await boot(reqs)
    await createFirstBody()
    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    reqs.length = 0

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK2' } })
    const options = [...(screen.getByTestId('extrude-end-condition-select') as HTMLSelectElement).options]
      .map((option) => [option.value, option.textContent])
    expect(options).toEqual([
      ['blind', 'Blind'],
      ['symmetric', 'Symmetric'],
      ['upToNext', 'Up to next'],
      ['toFace', 'Up to face / plane'],
      ['toPart', 'Up to part / body'],
      ['toVertex', 'Up to vertex / point'],
      ['throughAll', 'Through all'],
    ])

    selectEndCondition('upToNext')
    commitNumber('extrude-terminal-offset', '-2')
    await waitFor(() => expect(reqs.at(-1)?.end).toMatchObject({ kind: 'upToNext', offset: -2 }))
    expect((reqs.at(-1)?.end as { candidates?: Array<{ identity: { bodyFeatureId: string } }> }).candidates?.map((c) => c.identity.bodyFeatureId)).toContain('F1')
    expect(hooks().dag.has('F2')).toBe(false)

    selectEndCondition('throughAll')
    fireEvent.change(screen.getByTestId('extrude-direction-select'), { target: { value: 'midplane' } })
    await waitFor(() => expect(reqs.at(-1)?.end).toMatchObject({ kind: 'throughAll', symmetric: true }))
    expect(screen.queryByTestId('extrude-terminal-offset')).toBeNull()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.resolvedEndTargets).toEqual([
      { modelItemId: expect.any(String), bodyFeatureId: 'F1' },
    ]))
    expect(hooks().dag.getNode('F2')?.consumes).toContain('SK2')
    expect(hooks().dag.getNode('F2')?.consumes).not.toContain('F1')
    expect(hooks().dag.has('F1')).toBe(true)
    expect(FeatureDag.restore(hooks().dag.serialize()).getNode('F2')?.payload.resolvedEndTargets).toEqual([
      { modelItemId: expect.any(String), bodyFeatureId: 'F1' },
    ])
    const upstreamReplay = await hooks().fullResync(['SK1'])
    expect(upstreamReplay.executed).toContain('F1')
    expect(upstreamReplay.executed).toContain('F2')
  })

  it('rebuilds transitive terminal-reference dependents after an upstream sketch changes', async () => {
    const reqs: ExtrudeRequest[] = []
    await boot(reqs)
    await createFirstBody()

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F2',
      kind: 'feature',
      consumes: ['SK2'],
      payload: {
        opType: 'extrude', sketchId: 'SK2', distance: 10, direction: 'up', boolMode: 'newBody',
        endCondition: 'toPart', terminalOffset: 0,
        endTarget: { modelItemId: 'legacy', bodyFeatureId: 'F1' },
        name: 'Second body',
      },
    }))
    await hooks().fullResync(['F2'])
    expect(hooks().getBodyHandle('F2')).not.toBeUndefined()

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK3')).toBeTruthy())
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F3',
      kind: 'feature',
      consumes: ['SK3'],
      payload: {
        opType: 'extrude', sketchId: 'SK3', distance: 10, direction: 'up', boolMode: 'newBody',
        endCondition: 'toPart', terminalOffset: 0,
        endTarget: { modelItemId: 'legacy', bodyFeatureId: 'F2' },
        name: 'Third body',
      },
    }))
    await hooks().fullResync(['F3'])
    expect(hooks().getBodyHandle('F3')).not.toBeUndefined()

    const upstreamReplay = await hooks().fullResync(['SK1'])
    expect(upstreamReplay.executed).toEqual(expect.arrayContaining(['F1', 'F2', 'F3']))
  })

  it('re-resolves automatic targets when editing Up to next to Through all', async () => {
    const reqs: ExtrudeRequest[] = []
    await boot(reqs)
    await createFirstBody()

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK2' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK3')).toBeTruthy())
    reqs.length = 0
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK3' } })
    selectEndCondition('upToNext')
    await waitFor(() => expect(reqs.at(-1)?.end.kind).toBe('upToNext'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F3')?.payload.resolvedEndTargets).toEqual([
      { modelItemId: expect.any(String), bodyFeatureId: 'F1' },
    ]))

    const edit = hooks().editEntryFor('F3')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F3 edit entry unavailable')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-end-condition-select')).toBeTruthy())
    reqs.length = 0
    selectEndCondition('throughAll')
    await waitFor(() => expect(reqs.at(-1)?.end.kind).toBe('throughAll'))
    const previewEnd = reqs.at(-1)?.end
    if (previewEnd?.kind !== 'throughAll') throw new Error('Through all preview unavailable')
    expect(previewEnd.targets.map((target) => target.identity.bodyFeatureId)).toEqual(['F1', 'F2'])

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F3')?.payload).toMatchObject({
      endCondition: 'throughAll',
      resolvedEndTargets: [
        { modelItemId: expect.any(String), bodyFeatureId: 'F1' },
        { modelItemId: expect.any(String), bodyFeatureId: 'F2' },
      ],
    }))
  })

  it('picks an eligible planar face and stable vertex in the viewport, shows their stable names, and clears the picker on condition change', async () => {
    const reqs: ExtrudeRequest[] = []
    const { runtime } = await boot(reqs)
    await createFirstBody()
    const faceIds = seedDisplayedFaceSnapshots('F1')
    const topFaceId = faceIds.find((id) => id.endsWith('#5'))
    expect(topFaceId).toBeDefined()
    reqs.length = 0

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    selectEndCondition('toFace')
    fireEvent.click(screen.getByTestId('extrude-pick-end-target'))
    const canvas = screen.getByTestId('solids-workbench-canvas')
    fireEvent.pointerMove(canvas)
    await waitFor(() => expect(canvas.style.cursor).toBe('crosshair'))
    expect(hooks().getPickHighlightState(topFaceId!)).toBe('hovered')
    fireEvent.click(canvas)
    // WO-2858: the target reads as the face's shape and body; its stable key stays in the request.
    await waitFor(() => expect(screen.getByTestId('extrude-end-target-name').textContent).toBe('Flat face facing up at Z 5.00 mm on Extrude F1'))
    expect(reqs.at(-1)?.end).toMatchObject({ kind: 'toFace', target: { identity: { bodyFeatureId: 'F1', subshape: { kind: 'face', stableId: topFaceId } } } })

    selectEndCondition('toVertex')
    expect(screen.queryByTestId('solids-workbench-extrude-end-target-pick-hint')).toBeNull()
    fireEvent.click(screen.getByTestId('extrude-pick-end-target'))
    runtime.rayOverride = { origin: { x: 50, y: 40, z: 5 }, direction: { x: -1, y: -1, z: 0 } }
    fireEvent.pointerMove(canvas)
    await waitFor(() => expect(canvas.style.cursor).toBe('crosshair'))
    fireEvent.click(canvas)
    await waitFor(() => expect(screen.getByTestId('extrude-end-target-name').textContent).toBe('Extrude F1 / vertex'))
    const vertexEnd = reqs.at(-1)?.end
    expect(vertexEnd?.kind).toBe('toVertex')
    if (vertexEnd?.kind !== 'toVertex' || !('body' in vertexEnd.target)) throw new Error('vertex request missing')
    expect(vertexEnd.target.identity.subshape).toMatchObject({ kind: 'vertex', stableId: expect.stringMatching(/^\(.+\)$/) })
    expect(screen.getByTestId('extrude-end-target-name').textContent).not.toContain(vertexEnd.target.identity.subshape?.stableId ?? '(')
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    expect(hooks().getPickHighlightState(topFaceId!)).toBe('none')
  })

  it('refuses a later independent body as a terminal target while editing an earlier extrude', async () => {
    const reqs: ExtrudeRequest[] = []
    await boot(reqs)
    await createFirstBody()

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK2' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    const edit = hooks().editEntryFor('F1')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F1 edit entry unavailable')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-end-condition-select')).toBeTruthy())
    selectEndCondition('toPart')
    fireEvent.click(screen.getByTestId('extrude-pick-end-target'))
    fireEvent.click(screen.getByTestId('feature-row-F2'))

    expect(screen.getByTestId('extrude-end-target-name').textContent).toContain('none')
    expect(screen.getByTestId('solids-workbench-extrude-end-target-pick-hint')).toBeTruthy()
    expect(useCamStore.getState().consoleEvents.some((event) =>
      /Extrude end target set to Extrude F2/i.test(event.message),
    )).toBe(false)
  })

  it('refuses a later datum plane as a terminal target while editing an earlier extrude', async () => {
    const reqs: ExtrudeRequest[] = []
    await boot(reqs)
    await createFirstBody()

    const built = buildOffsetPlaneDatumNodeInput({
      id: 'RP1',
      parentPlaneNodeId: BASE_PLANE_XZ_NODE_ID,
      distance: 12.5,
      name: 'Later terminal plane',
    })
    hooks().history.execute(createFeatureCommand(hooks().dag, built.input))
    await hooks().fullResync([built.nodeId])
    expect(hooks().scheduler.statusOf(built.nodeId)).toBe('ok')

    const edit = hooks().editEntryFor('F1')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F1 edit entry unavailable')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-end-condition-select')).toBeTruthy())
    selectEndCondition('toFace')
    fireEvent.click(screen.getByTestId('extrude-pick-end-target'))
    fireEvent.click(screen.getByTestId(`feature-row-${built.nodeId}`))

    expect(screen.getByTestId('extrude-end-target-name').textContent).toContain('none')
    expect(screen.getByTestId('solids-workbench-extrude-end-target-pick-hint')).toBeTruthy()
    expect(useCamStore.getState().consoleEvents.some((event) =>
      /Later terminal plane is not upstream of Extrude F1/i.test(event.message),
    )).toBe(true)
    expect(useCamStore.getState().consoleEvents.some((event) =>
      /Extrude end target set to Later terminal plane/i.test(event.message),
    )).toBe(false)
  })

  it('picks a datum plane from the tree, persists direction/offset/identity through edit, undo/redo, and serialization', async () => {
    const reqs: ExtrudeRequest[] = []
    await boot(reqs)
    await createFirstBody()
    reqs.length = 0

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    selectEndCondition('toFace')
    fireEvent.change(screen.getByTestId('extrude-direction-select'), { target: { value: 'down' } })
    commitNumber('extrude-terminal-offset', '3')
    fireEvent.click(screen.getByTestId('extrude-pick-end-target'))
    fireEvent.click(screen.getByTestId(`feature-row-${BASE_PLANE_XY_NODE_ID}`))
    await waitFor(() => expect(screen.getByTestId('extrude-end-target-name').textContent).toMatch(/XY plane/i))
    expect(reqs.at(-1)?.end).toMatchObject({ kind: 'toFace', direction: -1, offset: 3, target: { identity: { planeFeatureId: BASE_PLANE_XY_NODE_ID } } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.endCondition).toBe('toFace'))

    const savedPayload = hooks().dag.getNode('F2')!.payload
    expect(savedPayload).toMatchObject({
      direction: 'down',
      endCondition: 'toFace',
      terminalOffset: 3,
      endTarget: { modelItemId: expect.any(String), planeFeatureId: BASE_PLANE_XY_NODE_ID },
    })
    expect(hooks().dag.getNode('F2')?.consumes).toContain(BASE_PLANE_XY_NODE_ID)
    const reloaded = FeatureDag.restore(hooks().dag.serialize()).getNode('F2')
    expect(reloaded?.payload).toMatchObject(savedPayload)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F2')).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.endCondition).toBe('toFace'))
    // Edit below opens a preview session that fingerprints the model as it
    // finds it, so it must not start while the redo's rebuild is still
    // running. The dag payload above is not that signal -- the rebuilt body
    // is. Measured already-settled here on an idle and a fully loaded box, so
    // this states the precondition rather than papering over a known lag.
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 edit entry unavailable')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-end-target-name').textContent).toMatch(/XY plane/i))
    commitNumber('extrude-terminal-offset', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => {
      // Apply's commit-time guard can refuse instead of committing, and a
      // refusal writes only this line -- the payload simply never changes. Read
      // it here so a refusal fails by NAME rather than as a bare timeout.
      expect(screen.queryByTestId('extrude-apply-error')?.textContent ?? '').toBe('')
      expect(hooks().dag.getNode('F2')?.payload.terminalOffset).toBe(5)
    })
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.terminalOffset).toBe(3))
  })

  it('refuses a failed offset plane with a retained frame in tree picking, live replay, and edit preview', async () => {
    const reqs: ExtrudeRequest[] = []
    await boot(reqs)
    const built = buildOffsetPlaneDatumNodeInput({
      id: 'RP1',
      parentPlaneNodeId: BASE_PLANE_XZ_NODE_ID,
      distance: 12.5,
      name: 'Failed terminal plane',
    })
    hooks().history.execute(createFeatureCommand(hooks().dag, built.input))
    await hooks().fullResync([built.nodeId])
    const planeBeforeFailure = hooks().dag.getNode(built.nodeId)
    const parent = hooks().dag.getNode(BASE_PLANE_XZ_NODE_ID)
    if (
      planeBeforeFailure === undefined ||
      !isOffsetPlaneDatumPayload(planeBeforeFailure.payload) ||
      parent === undefined
    ) throw new Error('offset plane failure fixture missing')
    const retainedFrame = planeBeforeFailure.payload.lastGoodFrame

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    reqs.length = 0
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1', built.nodeId],
      payload: {
        opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody',
        endCondition: 'toFace', terminalOffset: 0,
        endTarget: { modelItemId: 'legacy', planeFeatureId: built.nodeId },
        name: 'Failed-plane extrude',
      },
    }))
    await hooks().fullResync(['F1'])
    expect(hooks().scheduler.statusOf('F1')).toBe('ok')
    expect(reqs.some((req) => req.featureId === 'F1' && req.end.kind === 'toFace')).toBe(true)

    hooks().dag.setPayload(parent.id, {
      ...parent.payload,
      lastGoodFrame: {
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 0 },
        xDir: { x: 1, y: 0, z: 0 },
      },
    })
    await hooks().fullResync([built.nodeId])
    expect(hooks().scheduler.statusOf(built.nodeId)).toBe('failed')
    expect(hooks().dag.getNode(built.nodeId)?.payload.lastGoodFrame).toEqual(retainedFrame)
    expect(hooks().scheduler.statusOf('F1')).toBe('degraded')
    reqs.length = 0

    const edit = hooks().editEntryFor('F1')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F1 edit entry unavailable')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-preview-status').getAttribute('data-status')).toBe('refused'))
    expect(screen.getByTestId('extrude-preview-status').textContent).toMatch(/lost|no live plane definition/i)
    expect(reqs.some((req) => req.featureId === 'F1' && req.end.kind === 'toFace')).toBe(false)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    reqs.length = 0
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    selectEndCondition('toFace')
    fireEvent.click(screen.getByTestId('extrude-pick-end-target'))
    fireEvent.click(screen.getByTestId(`feature-row-${built.nodeId}`))
    expect(screen.getByTestId('extrude-end-target-name').textContent).toContain('none')
    expect(useCamStore.getState().consoleEvents.some((event) =>
      /Failed terminal plane is unresolved and cannot be used as an extrude end target/i.test(event.message),
    )).toBe(true)
    expect(reqs.some((req) => req.end.kind === 'toFace')).toBe(false)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))

    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F2',
      kind: 'feature',
      // Deliberately bypass the dependency edge so the live executor's own
      // plane-status guard is proven independently of scheduler propagation.
      consumes: ['SK1'],
      payload: {
        opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody',
        endCondition: 'toFace', terminalOffset: 0,
        endTarget: { modelItemId: 'legacy', planeFeatureId: built.nodeId },
        name: 'Failed-plane direct replay',
      },
    }))
    await hooks().fullResync(['F2'])
    expect(hooks().scheduler.statusOf('F2')).toBe('failed')
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('F2'))).toMatch(/lost|no live plane definition/i)
    expect(reqs.some((req) => req.featureId === 'F2' && req.end.kind === 'toFace')).toBe(false)
  }, 20_000)

  it('fails visibly for a lost persisted target instead of switching to Blind or reaching the kernel', async () => {
    const reqs: ExtrudeRequest[] = []
    await boot(reqs)
    await mintRectangleSketch()
    reqs.length = 0
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F1',
      kind: 'feature',
      // Deliberately bypass the dialog's consumes edge so this exercises the
      // executor's own durable-target refusal rather than scheduler skipping.
      consumes: ['SK1'],
      payload: {
        opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody',
        endCondition: 'toPart', terminalOffset: 0,
        endTarget: { modelItemId: 'legacy', bodyFeatureId: 'GHOST' },
        name: 'Lost target extrude',
      },
    }))
    await hooks().fullResync(['F1'])
    expect(hooks().scheduler.statusOf('F1')).toBe('failed')
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf('F1'))).toMatch(/lost|no live body/i)
    expect(reqs.some((req) => req.featureId === 'F1')).toBe(false)
  })

  it('cuts 1 mm past a picked face when Remove uses a +1 mm terminal offset', async () => {
    const { client } = await boot([], createLocalGeomService)
    await mintRectangleSketch({ width: 40, height: 20, offset: 10 })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitNumber('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const plane = buildOffsetPlaneDatumNodeInput({
      id: 'RP1',
      parentPlaneNodeId: BASE_PLANE_XY_NODE_ID,
      distance: 10,
      name: 'Cut terminal plane',
    })
    hooks().history.execute(createFeatureCommand(hooks().dag, plane.input))
    await hooks().fullResync([plane.nodeId])
    expect(hooks().scheduler.statusOf(plane.nodeId)).toBe('ok')

    await mintRectangleSketch({ width: 20, height: 10, offset: 20 })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK2' } })
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    selectEndCondition('toFace')
    commitNumber('extrude-terminal-offset', '1')
    fireEvent.click(screen.getByTestId('extrude-pick-end-target'))
    fireEvent.click(screen.getByTestId(`feature-row-${plane.nodeId}`))
    await waitFor(() => expect(screen.getByTestId('extrude-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')?.payload).toMatchObject({
      boolMode: 'remove',
      targetFeatureId: 'F1',
      endCondition: 'toFace',
      terminalOffset: 1,
      endTarget: { planeFeatureId: plane.nodeId },
    })
    const committed = hooks().getBodyHandle('F2')
    if (committed === undefined) throw new Error('real-kernel Remove result unavailable')
    const measured = await client.measure(committed, 'volume')
    expect(measured.kind).toBe('volume')
    // Target: 40 x 20 x 20 = 16000 mm3. Cutter: 20 x 10 x (10 + 1)
    // = 2200 mm3, leaving 13800. If the UI drops the offset, this is 14000.
    expect(measured.value).toBeCloseTo(13_800, 5)
  }, 60_000)
})
