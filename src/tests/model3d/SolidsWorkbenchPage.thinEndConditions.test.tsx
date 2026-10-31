// @vitest-environment jsdom
//
// WO-3235: Thin walls that end at a target, on the real Model page and the
// shipped kernel. A solid box F1 (40 x 20, 10 high) stands on the sketch plane;
// a Thin extrude of the same outline (t = 2, Inside) previews Up to next, Up to
// part and Through all against it, Applies the body the preview showed, undoes,
// and survives save and reopen with the same request.
//
// Measured against: wall section 40*20 - 36*16 = 224 mm2. Up to next / part to
// F1's top (z = 10) with offset -2: 224 * 8 = 1792 mm3. Through all F1:
// 224 * 10 = 2240 mm3 (plus the resolver's 1e-5 mm margin). Every volume is
// read from the body the kernel returned for that request. The background
// replay (no Model tab: headlessFeatureReplay.ts -> lib/cam builder) builds the
// same Up to next wall from the saved payload.

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
import { textFor } from '../../i18n'
import { resetDocumentHolder, stashLoadedDocument } from '../../doc/documentHolder'
import { BASE_PLANE_XY_NODE_ID } from '../../doc/genesis'
import { finalizeSeedArchive, newSeededModelDag } from '../../doc/seedModelArchive'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import {
  __setModelBodyHeadlessClientFactoryForTests,
  resolveModelReferencesHeadless,
} from '../../lib/cam/modelBodyHoleRecognition'

const GHOST_ID = '__extrude-preview__'
const THIN = { thickness: 2, side: 'inside' as const }
const thinEndsText = textFor('thin-extrude-ends.wo3235')

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

interface Built { req: ExtrudeRequest; volume: number | undefined; result: OpResult }

/** The shipped kernel, with every extrude request and the volume it produced recorded. */
function recordingKernel(log: Built[]): () => GeomClient {
  return () => {
    const client = createLocalGeomService()
    const makeExtrude = client.makeExtrude.bind(client)
    client.makeExtrude = async (req: ExtrudeRequest): Promise<OpResult> => {
      const r = await makeExtrude(req)
      const volume = r.ok && r.body !== undefined ? (await client.measure(r.body, 'volume')).value : undefined
      log.push({ req: structuredClone({ ...req, target: undefined }), volume, result: structuredClone({ ...r, body: undefined }) })
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
  const root = screen.getByTestId(testId)
  const input = root instanceof HTMLInputElement ? root : root.querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

const previewStatus = (): string | null => screen.queryByTestId('extrude-preview-status')?.getAttribute('data-status') ?? null

async function waitForReadyWith(log: Built[], kind: ExtrudeRequest['end']['kind']): Promise<Built> {
  await waitFor(() => {
    expect(previewStatus()).toBe('ready')
    expect(log.at(-1)?.req.end.kind).toBe(kind)
    expect(log.at(-1)?.req.thin).toEqual(THIN)
    expect(log.at(-1)?.volume).not.toBeUndefined()
  }, { timeout: 20_000 })
  return log.at(-1)!
}

async function liveVolume(id: string): Promise<number> {
  const handle = hooks().getBodyHandle(id)
  if (handle === undefined) throw new Error(`${id} has no body`)
  return (await hooks().client.measure(handle, 'volume')).value
}

/** The request without live handles: what the preview, Apply and a reopen all send. */
function comparable(req: ExtrudeRequest): unknown {
  const { featureId, end, op, thin, modelItemId } = req
  const strip = (t: { identity: unknown }) => t.identity
  const e = end.kind === 'upToNext'
    ? { ...end, candidates: end.candidates.map(strip) }
    : end.kind === 'throughAll'
      ? { ...end, targets: end.targets.map(strip) }
      : end.kind === 'blind' || end.kind === 'symmetric'
        ? end
        : { ...end, target: strip(end.target) }
  return { featureId, end: e, op, thin, modelItemId }
}

describe('WO-3235 Thin walls end at a target on the Model page', () => {
  it('previews Up to next, Up to part and Through all on the wall section, applies the previewed body, undoes, saves and reopens', async () => {
    const log: Built[] = []
    await boot(recordingKernel(log))

    // The target: an ordinary solid 40 x 20 x 10 on the sketch plane.
    await mintRectangleSketch({ width: '40', height: '20', offset: '0' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    expect(await liveVolume('F1')).toBeCloseTo(8000, 6)

    await mintRectangleSketch({ width: '40', height: '20', offset: '0' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    const historyBefore = hooks().history.size()

    // Thin, Up to next, offset -2: the line that blocked these ends is gone,
    // the walls stop 2 mm under F1's top.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK2' } })
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    commitField('extrude-thin-thickness', '2')
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'upToNext' } })
    commitField('extrude-terminal-offset', '-2')
    expect(screen.queryByTestId('extrude-thin-end-unavailable')).toBeNull()
    expect(screen.getByTestId('extrude-thin-end-note').textContent).toBe(thinEndsText('wallsStopOnTheirOwnSection'))
    await waitFor(() => expect(log.at(-1)?.req.end).toMatchObject({ kind: 'upToNext', offset: -2 }), { timeout: 20_000 })
    const next = await waitForReadyWith(log, 'upToNext')
    expect(next.volume).toBeCloseTo(1792, 6)
    expect(next.result.resolvedExtrudeEnd).toMatchObject({ kind: 'upToNext', startDistance: 0, endDistance: 8, targets: [{ bodyFeatureId: 'F1' }] })
    expect(hooks().getBodyTopPoint(GHOST_ID)?.z).toBeCloseTo(8, 6)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    expect(hooks().dag.has('F2')).toBe(false)

    // Up to part F1, picked from the tree.
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'toPart' } })
    fireEvent.click(screen.getByTestId('extrude-pick-end-target'))
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    await waitFor(() => expect(log.at(-1)?.req.end).toMatchObject({ kind: 'toPart', target: { identity: { bodyFeatureId: 'F1' } } }), { timeout: 20_000 })
    const part = await waitForReadyWith(log, 'toPart')
    expect(part.volume).toBeCloseTo(224 * (10 + (part.req.end as { offset: number }).offset), 6)
    expect(screen.getByTestId('extrude-thin-end-note')).toBeTruthy()

    // Through all F1: the whole 10 mm, no note line (one plane for every wall).
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'throughAll' } })
    const through = await waitForReadyWith(log, 'throughAll')
    expect(through.volume).toBeCloseTo(2240, 2)
    expect(screen.queryByTestId('extrude-thin-end-note')).toBeNull()

    // Back to Up to next, and Apply: one feature, the previewed request and body.
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'upToNext' } })
    await waitFor(() => expect(log.at(-1)?.req.end).toMatchObject({ kind: 'upToNext' }), { timeout: 20_000 })
    const final = await waitForReadyWith(log, 'upToNext')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    const payload = hooks().dag.getNode('F2')!.payload
    expect(payload).toMatchObject({ wallMode: 'thin', wallThickness: 2, wallSide: 'inside', endCondition: 'upToNext', resolvedEndTargets: [{ bodyFeatureId: 'F1' }] })
    const applied = [...log].reverse().find((b) => b.req.featureId === 'F2' && b !== final)!
    expect(comparable(applied.req)).toEqual(comparable(final.req))
    expect(applied.volume).toBeCloseTo(final.volume!, 9)
    expect(await liveVolume('F2')).toBeCloseTo(final.volume!, 9)
    await waitFor(() => expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined())
    expect(hooks().history.size()).toBe(historyBefore + 1)

    // Save and reopen: the same Thin payload builds the same request.
    const reopened = loadDocumentArchive(createDocumentArchive({ dag: hooks().dag, elementMapDeltas: [] }))
    const saved = reopened.dag.getNode('F2')!.payload
    expect(saved).toEqual(payload)
    expect(reopened.migrationsApplied).toEqual([])
    const lastF2 = [...log].reverse().find((b) => b.req.featureId === 'F2')!
    if (lastF2.req.end.kind !== 'upToNext') throw new Error('F2 must be Up to next')
    const rebuilt = buildExtrudeRequest({
      featureId: 'F2',
      payload: saved as ExtrudeParamsInput,
      profiles: lastF2.req.profiles!,
      distance: saved.distance as number,
      lookupTarget: () => undefined,
      candidateTargets: lastF2.req.end.candidates,
      modelItemId: lastF2.req.modelItemId,
    })
    expect(rebuilt.ok && comparable(rebuilt.req)).toEqual(comparable(lastF2.req))

    // Undo removes the one feature and its body.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F2')).toBe(false))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).toBeUndefined())
    expect(hooks().history.size()).toBe(historyBefore)
    expect(await liveVolume('F1')).toBeCloseTo(8000, 6)
  }, 120_000)
})

describe('WO-3235 Thin walls end at a target in the background replay', () => {
  const rectangle = (id: string): Sketch => ({
    id, layerId: 'L1', constraints: [], dimensions: [], solveStatus: null,
    entities: [
      { id: `${id}r0`, kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
      { id: `${id}r1`, kind: 'line', construction: false, start: { x: 40, y: 0 }, end: { x: 40, y: 20 } },
      { id: `${id}r2`, kind: 'line', construction: false, start: { x: 40, y: 20 }, end: { x: 0, y: 20 } },
      { id: `${id}r3`, kind: 'line', construction: false, start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
    ] as SketchEntity[],
  }) as Sketch

  afterEach(() => resetDocumentHolder())

  it('replays a saved Thin Up to next to the same request and the same wall as the Model tab builder', async () => {
    resetDocumentHolder()
    const builtReqs = new Map<string, { req: ExtrudeRequest; volume: number | undefined }>()
    __setModelBodyHeadlessClientFactoryForTests(() => {
      const client = createLocalGeomService()
      const makeExtrude = client.makeExtrude.bind(client)
      client.makeExtrude = async (req: ExtrudeRequest): Promise<OpResult> => {
        const r = await makeExtrude(req)
        builtReqs.set(req.featureId, {
          req: structuredClone({ ...req, target: undefined }),
          volume: r.ok && r.body !== undefined ? (await client.measure(r.body, 'volume')).value : undefined,
        })
        return r
      }
      return client
    })
    const dag = newSeededModelDag()
    for (const [sketchId, bodyId, extra] of [
      ['sketch3d:S0', 'F1', { distance: 10, endCondition: 'blind' }],
      ['sketch3d:S1', 'F2', { distance: 10, endCondition: 'upToNext', terminalOffset: -2, wallMode: 'thin', wallThickness: 2, wallSide: 'inside' }],
    ] as const) {
      dag.insertNode({
        id: sketchId, kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [],
        payload: { sketch: rectangle(sketchId.slice(-2)), planeNodeId: BASE_PLANE_XY_NODE_ID },
      })
      dag.insertNode({
        id: bodyId, kind: 'feature', consumes: [sketchId], refs: [],
        payload: { opType: 'extrude', sketchId, profileSelector: { kind: 'whole-sketch' }, direction: 'up', boolMode: 'newBody', name: `Extrude ${bodyId}`, ...extra },
      })
    }
    stashLoadedDocument(finalizeSeedArchive(dag))
    await resolveModelReferencesHeadless('legacy', new Map([['F2', []]]))
    const f2 = builtReqs.get('F2')
    expect(f2, 'F2 reached the kernel').toBeDefined()
    expect(f2!.req.thin).toEqual(THIN)
    expect(f2!.req.end).toMatchObject({ kind: 'upToNext', direction: 1, offset: -2 })
    expect(f2!.volume).toBeCloseTo(1792, 6)
    if (f2!.req.end.kind !== 'upToNext') throw new Error('F2 must be Up to next')
    expect(f2!.req.end.candidates.map((c) => c.identity.bodyFeatureId)).toEqual(['F1'])
    const payload = dag.getNode('F2')!.payload
    const modelTab = buildExtrudeRequest({
      featureId: 'F2',
      payload: payload as ExtrudeParamsInput,
      profiles: f2!.req.profiles!,
      distance: payload.distance as number,
      lookupTarget: () => undefined,
      candidateTargets: f2!.req.end.candidates,
      modelItemId: f2!.req.modelItemId,
    })
    expect(modelTab.ok && comparable(modelTab.req)).toEqual(comparable(f2!.req))
  }, 120_000)
})
