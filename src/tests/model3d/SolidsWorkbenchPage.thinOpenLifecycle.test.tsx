// @vitest-environment jsdom
//
// WO-3237: Thin walls from an explicitly chosen open chain, on the real Model
// page and the shipped kernel.
//
// Choose Thin, pick the U chain under "Wall along", watch the preview follow
// side and Reverse, Cut the wall into a block, edit and Cancel (nothing
// changes), edit and Apply (one undo step), undo, switch Thin off (one line,
// Apply off), lose a chain curve (refused by name, nothing substituted), then
// save and reopen the document and get the same request back.
//
// Measured against (D = 8, t = 2, U (0,30)->(0,0)->(36,0)->(36,30), left of
// travel is its inside):
//   wall alone: left 1472, right 1600, center 1536 mm3
//   block x -5..41, y -5..10, z 0..8 = 5520 mm3
//   cut by the center wall: overlap 38*2 + 2*(2*9) = 112 mm2 -> 5520 - 896 = 4624
//   cut by the left wall:   overlap 36*2 + 2*(2*8) = 104 mm2 -> 5520 - 832 = 4688

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { EditFeaturePayloadCommand } from '../../components/model3d/dialogs/EditFeaturePayloadCommand'
import { NODE_ID_BY_BASE_PLANE } from '../../components/model3d/workbench/basePlanes'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { ExtrudeRequest, OpResult } from '../../geom/geom-service'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import { CURRENT_SCHEMA_VERSION } from '../../doc/persist/versioning'
import { buildExtrudeRequest, type ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'
import { resolveExtrudeSelection, type ProfileSelector } from '../../components/model3d/workbench/regionSelector'
import type { Sketch } from '../../lib/sketch/types'

const GHOST_ID = '__extrude-preview__'
const XY = NODE_ID_BY_BASE_PLANE.xy
const U = 'sketch3d:U'
const BLK = 'sketch3d:BLK'

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

interface Built { req: ExtrudeRequest; volume: number | undefined; ok: boolean; reason: string }

function recordingKernel(log: Built[]): () => GeomClient {
  return () => {
    const client = createLocalGeomService()
    const makeExtrude = client.makeExtrude.bind(client)
    client.makeExtrude = async (req: ExtrudeRequest): Promise<OpResult> => {
      const r = await makeExtrude(req)
      const volume = r.ok && r.body !== undefined ? (await client.measure(r.body, 'volume')).value : undefined
      log.push({ req: structuredClone({ ...req, target: undefined }), volume, ok: r.ok, reason: JSON.stringify(r.diagnostics) })
      return r
    }
    return client
  }
}

async function boot(createClient: () => GeomClient): Promise<void> {
  render(<SolidsWorkbenchPage createClient={createClient} createSceneRuntime={() => createFakeSceneRuntime()} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
}

const lineE = (id: string, x: number, y: number, xx: number, yy: number): Sketch['entities'][number] =>
  ({ id, kind: 'line', construction: false, start: { x, y }, end: { x: xx, y: yy } })
const uEntities = (): Sketch['entities'] => [lineE('a', 0, 30, 0, 0), lineE('b', 0, 0, 36, 0), lineE('c', 36, 0, 36, 30)]
const blockEntities = (): Sketch['entities'] => [
  lineE('r0', -5, -5, 41, -5), lineE('r1', 41, -5, 41, 10), lineE('r2', 41, 10, -5, 10), lineE('r3', -5, 10, -5, -5),
]
function sketchOf(entities: Sketch['entities']): Sketch {
  return { id: 'S', layerId: 'plane', entities, constraints: [], dimensions: [], solveStatus: null }
}

async function mintSketch(id: string, entities: Sketch['entities']): Promise<void> {
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id, kind: 'sketch', consumes: [XY], refs: [],
    payload: { name: id.replace('sketch3d:', ''), planeNodeId: XY, sketch: sketchOf(entities), externalRefs: [], dimensionDiagnostics: [] },
  }))
  await hooks().fullResync([id])
  await waitFor(() => expect(screen.getByTestId(`feature-row-${id}`)).toBeTruthy())
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function chooseOption(testId: string, text: RegExp): void {
  const select = screen.getByTestId(testId) as HTMLSelectElement
  const option = Array.from(select.options).find((o) => text.test(o.textContent ?? '') || text.test(o.value))
  expect(option, `${testId} offers ${text}`).toBeDefined()
  fireEvent.change(select, { target: { value: option!.value } })
}

const previewStatus = (): string | null => screen.queryByTestId('extrude-preview-status')?.getAttribute('data-status') ?? null

async function waitForReadyWith(log: Built[], thin: ExtrudeRequest['thin'], featureId?: string): Promise<Built> {
  await waitFor(() => {
    expect(previewStatus()).toBe('ready')
    const last = [...log].reverse().find((b) => featureId === undefined || b.req.featureId !== featureId)
    expect(last?.req.thin).toEqual(thin)
  }, { timeout: 20_000 })
  return [...log].reverse().find((b) => featureId === undefined || b.req.featureId !== featureId)!
}

async function liveVolume(id: string): Promise<number> {
  const handle = hooks().getBodyHandle(id)
  if (handle === undefined) throw new Error(`${id} has no body`)
  return (await hooks().client.measure(handle, 'volume')).value
}

function openEdit(id: string): void {
  const edit = hooks().editEntryFor(id)
  if (edit === undefined || !('onEdit' in edit)) throw new Error(`${id} must route to its Extrude edit dialog`)
  edit.onEdit()
}

function comparable(req: ExtrudeRequest): Partial<ExtrudeRequest> {
  const { featureId, end, op, thin, profiles } = req
  return { featureId, end, op, thin, profiles }
}

const rel = (a: number, e: number): number => Math.abs(a - e) / e

describe('WO-3237 Thin walls from an open chain on the Model page', () => {
  it('choose the chain, preview side and Reverse, cut a block, edit, cancel, undo, refuse, save and reopen', async () => {
    const log: Built[] = []
    await boot(recordingKernel(log))
    await mintSketch(BLK, blockEntities())
    await mintSketch(U, uEntities())
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F1', kind: 'feature', consumes: [BLK],
      payload: { opType: 'extrude', sketchId: BLK, distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody', name: 'Block' },
    }))
    await hooks().fullResync(['F1'])
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    expect(rel(await liveVolume('F1'), 5520)).toBeLessThan(1e-9)
    const historyBefore = hooks().history.size()

    // Create: the U sketch, Thin 2 mm, the chain under "Wall along".
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: U } })
    commitField('extrude-distance', '8')
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    commitField('extrude-thin-thickness', '2')
    chooseOption('extrude-thin-open-chain-select', /a → b → c|c → b → a/)
    const chosen = (screen.getByTestId('extrude-thin-open-chain-select') as HTMLSelectElement).value
    expect(chosen).not.toBe('')
    // The chain lists the way it travels; make it start at 'a' so left is the U's inside.
    if (!/a → b → c/.test(screen.getByTestId('extrude-thin-open-direction').textContent ?? '')
      && /starts at c/.test(screen.getByTestId('extrude-thin-open-direction').textContent ?? '')) {
      fireEvent.click(screen.getByTestId('extrude-thin-open-reverse'))
    }
    await waitFor(() => expect(screen.getByTestId('extrude-thin-open-direction').textContent).toMatch(/starts at a and runs to c/))
    // Side choices are Left / Right / Center of travel; the default is Left.
    const sides = Array.from((screen.getByTestId('extrude-thin-side') as HTMLSelectElement).options).map((o) => o.value)
    expect(sides).toEqual(['left', 'right', 'center'])
    expect(screen.getByTestId('extrude-thin-summary').getAttribute('data-side')).toBe('left')
    const left = await waitForReadyWith(log, { thickness: 2, side: 'left', open: true })
    expect(rel(left.volume!, 1472)).toBeLessThan(1e-6)
    expect(left.req.profiles![0].loops[0].map((s) => s.srcId)).toEqual(['a', 'b', 'c'])
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    expect(hooks().dag.has('F2')).toBe(false)

    // Reverse: same chain, other direction - Left is now the U's outside.
    fireEvent.click(screen.getByTestId('extrude-thin-open-reverse'))
    await waitFor(() => expect(screen.getByTestId('extrude-thin-open-direction').textContent).toMatch(/starts at c and runs to a/))
    const reversed = await waitForReadyWith(log, { thickness: 2, side: 'left', open: true })
    await waitFor(() => expect(log.at(-1)!.req.profiles![0].loops[0].map((s) => s.srcId)).toEqual(['c', 'b', 'a']), { timeout: 20_000 })
    expect(rel(log.at(-1)!.volume!, 1600)).toBeLessThan(1e-6)
    expect(reversed.ok).toBe(true)
    fireEvent.click(screen.getByTestId('extrude-thin-open-reverse'))
    await waitFor(() => expect(screen.getByTestId('extrude-thin-open-direction').textContent).toMatch(/starts at a and runs to c/))

    // Two quick side changes: only the last evaluation is accepted.
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'right' } })
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'center' } })
    const center = await waitForReadyWith(log, { thickness: 2, side: 'center', open: true })
    await waitFor(() => expect(log.at(-1)!.req.profiles![0].loops[0].map((s) => s.srcId)).toEqual(['a', 'b', 'c']), { timeout: 20_000 })
    expect(rel(log.at(-1)!.volume!, 1536)).toBeLessThan(1e-6)
    expect(center.ok).toBe(true)

    // Cut into the block, then Apply: one feature, the accepted request, the analytic body.
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    fireEvent.change(screen.getByTestId('extrude-target-select'), { target: { value: 'F1' } })
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(log.at(-1)!.req.op).toBe('cut')
    }, { timeout: 20_000 })
    expect(rel(log.at(-1)!.volume!, 4624)).toBeLessThan(1e-6)
    expect(hooks().history.size()).toBe(historyBefore)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    const savedSelector = hooks().dag.getNode('F2')!.payload.profileSelector
    expect(savedSelector).toEqual({ kind: 'sketch-chain', sketchId: U, steps: [
      { entityId: 'a', forward: true }, { entityId: 'b', forward: true }, { entityId: 'c', forward: true },
    ] })
    expect(hooks().dag.getNode('F2')!.payload).toMatchObject({ wallMode: 'thin', wallThickness: 2, wallSide: 'center', boolMode: 'remove', targetFeatureId: 'F1' })
    await waitFor(async () => expect(rel(await liveVolume('F2'), 4624)).toBeLessThan(1e-6), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined())
    const afterCreate = hooks().history.size()
    expect(afterCreate).toBe(historyBefore + 1)

    // Edit: the chain and side come back; change to Left and Cancel - nothing changes.
    openEdit('F2')
    await waitFor(() => expect((screen.getByTestId('extrude-thin-toggle') as HTMLInputElement).checked).toBe(true))
    expect((screen.getByTestId('extrude-thin-side') as HTMLSelectElement).value).toBe('center')
    expect((screen.getByTestId('extrude-thin-open-chain-select') as HTMLSelectElement).value).not.toBe('')
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'left' } })
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(log.at(-1)!.req.thin).toEqual({ thickness: 2, side: 'left', open: true })
    }, { timeout: 20_000 })
    expect(rel(log.at(-1)!.volume!, 4688)).toBeLessThan(1e-6)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(hooks().getBodyPresentationVisible('F2')).toBe(true))
    expect(hooks().dag.getNode('F2')!.payload.wallSide).toBe('center')
    expect(hooks().history.size()).toBe(afterCreate)
    expect(rel(await liveVolume('F2'), 4624)).toBeLessThan(1e-6)

    // Edit and Apply Left: one undo step, the inside wall cut.
    openEdit('F2')
    await waitFor(() => expect(screen.getByTestId('extrude-thin-side')).toBeTruthy())
    fireEvent.change(screen.getByTestId('extrude-thin-side'), { target: { value: 'left' } })
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(log.at(-1)!.req.thin).toEqual({ thickness: 2, side: 'left', open: true })
    }, { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F2')!.payload.wallSide).toBe('left'))
    expect(hooks().history.size()).toBe(afterCreate + 1)
    await waitFor(async () => expect(rel(await liveVolume('F2'), 4688)).toBeLessThan(1e-6), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')!.payload.wallSide).toBe('center'))
    await waitFor(async () => expect(rel(await liveVolume('F2'), 4624)).toBeLessThan(1e-6), { timeout: 20_000 })

    // Thin off with the chain chosen: one line, no preview, Apply off - never a solid.
    openEdit('F2')
    await waitFor(() => expect(screen.getByTestId('extrude-thin-toggle')).toBeTruthy())
    fireEvent.click(screen.getByTestId('extrude-thin-toggle'))
    expect(screen.getByTestId('extrude-thin-open-needs-thin').textContent).toMatch(/only as a Thin wall/)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(hooks().getBodyPresentationVisible('F2')).toBe(true))
    expect(hooks().dag.getNode('F2')!.payload.wallMode).toBe('thin')
    expect(hooks().history.size()).toBe(afterCreate)

    // Save and reopen: the same payload at the new schema, building the same request.
    const reopened = loadDocumentArchive(createDocumentArchive({ dag: hooks().dag, elementMapDeltas: [] }))
    expect(reopened.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)  // WO-3324: pinned to the current schema (was a literal 8, stale after the bump to 9)
    expect(reopened.migrationsApplied).toEqual([])
    const payload = reopened.dag.getNode('F2')!.payload
    expect(payload).toEqual(hooks().dag.getNode('F2')!.payload)
    const lastF2 = [...log].reverse().find((b) => b.req.featureId === 'F2')!
    const selection = resolveExtrudeSelection(U, undefined, payload.profileSelector as ProfileSelector, (id) => reopened.dag.getNode(id))
    expect(selection.ok && selection.openChain).toBe(true)
    if (!selection.ok) return
    const rebuilt = buildExtrudeRequest({
      featureId: 'F2',
      payload: payload as ExtrudeParamsInput,
      profiles: selection.profiles,
      openChain: selection.openChain,
      distance: payload.distance as number,
      lookupTarget: () => ({}) as never,
      modelItemId: lastF2.req.modelItemId,
    })
    expect(rebuilt.ok && comparable(rebuilt.req)).toEqual(comparable(lastF2.req))

    // A chain curve deleted from the sketch: refused by name, no region or whole sketch built instead.
    const sketchPayload = hooks().dag.getNode(U)!.payload
    const withoutB = { ...sketchPayload, sketch: { ...(sketchPayload.sketch as Sketch), entities: uEntities().filter((e) => e.id !== 'b') } }
    const builtBefore = log.length
    hooks().history.execute(new EditFeaturePayloadCommand(U, withoutB, [XY]))
    await hooks().fullResync([U])
    await waitFor(() => {
      const diags = JSON.stringify(hooks().scheduler.diagnosticsOf('F2'))
      expect(diags).toMatch(/missing-entity|no longer exist/)
    }, { timeout: 20_000 })
    expect(log.slice(builtBefore).filter((b) => b.req.featureId === 'F2')).toEqual([])
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(async () => expect(rel(await liveVolume('F2'), 4624)).toBeLessThan(1e-6), { timeout: 30_000 })
  }, 180_000)
})
