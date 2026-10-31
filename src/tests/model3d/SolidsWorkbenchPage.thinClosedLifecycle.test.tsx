// @vitest-environment jsdom
//
// WO-3234: the Thin lifecycle on the real Model page and the shipped kernel.
//
// Create a Thin extrude through the Extrude dialog, watch the preview follow
// thickness and side (a superseded evaluation never wins), Apply once, edit
// and Cancel (nothing changes), edit and Apply (one undo step), undo, then
// save and reopen the document and get the same Thin request back.
//
// Measured against: 40 x 20 rectangle, D = 8: t = 2 outside 2048 mm3,
// t = 2 inside 1792 mm3, t = 1 center (41*21 - 39*19) * 8 = 960 mm3.
// Every volume is read from the body the kernel returned for that request.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { ExtrudeRequest, OpResult } from '../../geom/geom-service'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import { buildExtrudeRequest, type ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'

const GHOST_ID = '__extrude-preview__'

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

interface Built { req: ExtrudeRequest; volume: number | undefined }

/** The shipped kernel, with every extrude request and the volume it produced recorded. */
function recordingKernel(log: Built[]): () => GeomClient {
  return () => {
    const client = createLocalGeomService()
    const makeExtrude = client.makeExtrude.bind(client)
    client.makeExtrude = async (req: ExtrudeRequest): Promise<OpResult> => {
      const r = await makeExtrude(req)
      const volume = r.ok && r.body !== undefined ? (await client.measure(r.body, 'volume')).value : undefined
      log.push({ req: structuredClone({ ...req, target: undefined }), volume })
      return r
    }
    return client
  }
}

async function boot(createClient: () => GeomClient): Promise<void> {
  const createRuntime: CreateSceneRuntime = () => createFakeSceneRuntime()
  render(<SolidsWorkbenchPage createClient={createClient} createSceneRuntime={createRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

const previewStatus = (): string | null => screen.queryByTestId('extrude-preview-status')?.getAttribute('data-status') ?? null

async function waitForReadyWith(log: Built[], thin: ExtrudeRequest['thin']): Promise<Built> {
  await waitFor(() => {
    expect(previewStatus()).toBe('ready')
    expect(log.at(-1)?.req.thin).toEqual(thin)
  }, { timeout: 20_000 })
  return log.at(-1)!
}

async function liveVolume(id: string): Promise<number> {
  const handle = hooks().getBodyHandle(id)
  if (handle === undefined) throw new Error(`${id} has no body`)
  return (await hooks().client.measure(handle, 'volume')).value
}

function openEdit(): void {
  const edit = hooks().editEntryFor('F1')
  if (edit === undefined || !('onEdit' in edit)) throw new Error('F1 must route to its Extrude edit dialog')
  edit.onEdit()
}

/** The request a payload builds, without live handles -- what the page, preview and headless replay all send. */
function comparable(req: ExtrudeRequest): Partial<ExtrudeRequest> {
  const { featureId, end, op, thin } = req
  return { featureId, end, op, thin }
}

describe('WO-3234 Thin extrude lifecycle on the Model page', () => {
  it('create, preview, apply, edit-cancel, edit-apply, undo, save and reopen', async () => {
    const log: Built[] = []
    await boot(recordingKernel(log))
    await mintRectangleSketch({ width: '40', height: '20', offset: '0' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    const historyBefore = hooks().history.size()

    // Create: Thin, 2 mm, the default side (Inside) first.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '8')
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    commitField('extrude-thin-thickness', '2')
    const inside = await waitForReadyWith(log, { thickness: 2, side: 'inside' })
    expect(inside.volume).toBeCloseTo(1792, 6)
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    expect(hooks().getBodyTopPoint(GHOST_ID)?.z).toBeCloseTo(8, 6)
    expect(hooks().dag.has('F1')).toBe(false)

    // Two quick changes: only the last evaluation is accepted.
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'center' } })
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'outside' } })
    const outside = await waitForReadyWith(log, { thickness: 2, side: 'outside' })
    expect(outside.volume).toBeCloseTo(2048, 6)
    expect(hooks().history.size()).toBe(historyBefore)

    // Apply: one feature, the request the preview accepted, the same body.
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F1')!.payload).toMatchObject({ wallMode: 'thin', wallThickness: 2, wallSide: 'outside', distance: 8, endCondition: 'blind' })
    const applied = [...log].reverse().find((b) => b.req.featureId === 'F1')!
    expect(comparable(applied.req)).toEqual(comparable(outside.req))
    expect(await liveVolume('F1')).toBeCloseTo(2048, 6)
    await waitFor(() => expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined())
    const afterCreate = hooks().history.size()
    expect(afterCreate).toBe(historyBefore + 1)

    // Edit, change thickness and side, Cancel: nothing changes.
    openEdit()
    await waitFor(() => expect((screen.getByTestId('extrude-thin-toggle') as HTMLInputElement).checked).toBe(true))
    expect((screen.getByTestId('extrude-thin-side') as HTMLSelectElement).value).toBe('outside')
    commitField('extrude-thin-thickness', '1')
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'center' } })
    const centerPreview = await waitForReadyWith(log, { thickness: 1, side: 'center' })
    expect(centerPreview.volume).toBeCloseTo(960, 6)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(hooks().getBodyPresentationVisible('F1')).toBe(true))
    expect(hooks().dag.getNode('F1')!.payload).toMatchObject({ wallThickness: 2, wallSide: 'outside' })
    expect(hooks().history.size()).toBe(afterCreate)
    expect(await liveVolume('F1')).toBeCloseTo(2048, 6)

    // Edit and Apply: one undo step.
    openEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-thin-thickness')).toBeTruthy())
    commitField('extrude-thin-thickness', '1')
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'center' } })
    await waitForReadyWith(log, { thickness: 1, side: 'center' })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F1')!.payload.wallSide).toBe('center'))
    expect(hooks().history.size()).toBe(afterCreate + 1)
    await waitFor(async () => expect(await liveVolume('F1')).toBeCloseTo(960, 6), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F1')!.payload).toMatchObject({ wallThickness: 2, wallSide: 'outside' }))
    await waitFor(async () => expect(await liveVolume('F1')).toBeCloseTo(2048, 6), { timeout: 20_000 })

    // Save and reopen: the same Thin payload, building the same request.
    const reopened = loadDocumentArchive(createDocumentArchive({ dag: hooks().dag, elementMapDeltas: [] }))
    const payload = reopened.dag.getNode('F1')!.payload
    expect(payload).toEqual(hooks().dag.getNode('F1')!.payload)
    expect(reopened.migrationsApplied).toEqual([])
    const lastF1 = [...log].reverse().find((b) => b.req.featureId === 'F1')!
    const rebuilt = buildExtrudeRequest({
      featureId: 'F1',
      payload: payload as ExtrudeParamsInput,
      profiles: lastF1.req.profiles!,
      distance: payload.distance as number,
      lookupTarget: () => undefined,
      modelItemId: lastF1.req.modelItemId,
    })
    expect(rebuilt.ok && comparable(rebuilt.req)).toEqual(comparable(lastF1.req))
  }, 120_000)
})
