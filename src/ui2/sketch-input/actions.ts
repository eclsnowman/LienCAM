// WO-3305 (UI M2 W2-12): what the New UI does with a sketch as a toolpath input, as plain
// functions over the store, so the window's buttons and the tests run the same code.
//
// "Use" adds the sketch's own sketch part (one undo step, the store's addGeometry); its loops are
// then in the view beside model faces and edges, and an operation's geometry pick takes them like
// any 2D layer. The sync follows the sketch: a changed sketch or placement is written through the
// store's setGeometryLoops, which outdates every operation on those loops, and each operation's
// picked loops follow their replacements so the next compute cuts the edited shape.

import { useCamStore } from '../../store'
import { getModelSession, LEGACY_MODEL_ITEM_ID } from '../../doc/documentHolder'
import {
  bakeSketchInput, planSketchInputUpdate, readModelSketchSources, sketchInputLink, sketchInputPart,
  sketchInputPose,
  type ModelSketchSource, type SketchInputDag, type SketchInputRefusal,
} from '../../store/dispatchGeo'
import type { MessageKey, MessageParams } from '../../notices/types'
import type { Loop2D, Operation } from '../../types'

type CamState = ReturnType<typeof useCamStore.getState>

/** The live document of a model item, when its workbench holds one. */
export type ModelDocumentOf = (modelItemId: string) => SketchInputDag | undefined

export const liveModelDocument: ModelDocumentOf = (modelItemId) => getModelSession(modelItemId)?.dag

export type SketchInputStatus = 'available' | 'in-use' | 'refused'

export interface SketchInputEntry {
  key: string
  modelItemId: string
  nodeId: string
  name: string
  status: SketchInputStatus
  /** The sketch part that carries it, once used. */
  geoId?: string
  /** Why it cannot be machined (an existing catalogue reason). */
  reason?: { key: MessageKey; params: MessageParams }
}

/** Every model item a sketch may come from: the project's items, and the legacy single model. */
export function sketchInputModelItemIds(state: CamState): string[] {
  const ids = [LEGACY_MODEL_ITEM_ID, ...(state.project.modelItems ?? []).map((item) => item.id)]
  return [...new Set(ids)]
}

function sourcesOf(state: CamState, documentOf: ModelDocumentOf): ModelSketchSource[] {
  return sketchInputModelItemIds(state).flatMap((id) => {
    const dag = documentOf(id)
    return dag ? readModelSketchSources(dag, id) : []
  })
}

function partFor(state: CamState, source: Pick<ModelSketchSource, 'modelItemId' | 'nodeId'>) {
  return state.project.geometry.find((geo) => {
    const link = sketchInputLink(geo)
    return link !== null && link.modelItemId === source.modelItemId && link.nodeId === source.nodeId
  })
}

const poseOf = (state: CamState, modelItemId: string) =>
  sketchInputPose(state.project.modelItemPlacements ?? [], modelItemId)

function refusalReason(r: SketchInputRefusal): { key: MessageKey; params: MessageParams } {
  return { key: r.key, params: r.params }
}

/** The sketches the Sketch input window lists, in model and document order. A sketch with no
 *  curve to cut is not listed. */
export function listSketchInputs(state: CamState = useCamStore.getState(), documentOf: ModelDocumentOf = liveModelDocument): SketchInputEntry[] {
  const out: SketchInputEntry[] = []
  for (const source of sourcesOf(state, documentOf)) {
    const bake = bakeSketchInput(source, poseOf(state, source.modelItemId))
    const key = `${source.modelItemId}:${source.nodeId}`
    const base = { key, modelItemId: source.modelItemId, nodeId: source.nodeId, name: source.name }
    if (!bake.ok) { out.push({ ...base, status: 'refused', reason: refusalReason(bake) }); continue }
    if (bake.loops.length === 0) continue
    const part = partFor(state, source)
    out.push(part ? { ...base, status: 'in-use', geoId: part.id } : { ...base, status: 'available' })
  }
  return out
}

export type UseSketchResult =
  | { ok: true; geoId: string }
  | { ok: false; reason: { key: MessageKey; params: MessageParams } }

/** Make one model sketch operation geometry. Already in use: returns its part, adds nothing. */
export function addSketchInput(
  modelItemId: string,
  nodeId: string,
  documentOf: ModelDocumentOf = liveModelDocument,
  newId: () => string = () => crypto.randomUUID(),
): UseSketchResult | null {
  const state = useCamStore.getState()
  const source = sourcesOf(state, documentOf).find((s) => s.modelItemId === modelItemId && s.nodeId === nodeId)
  if (!source) return null
  const existing = partFor(state, source)
  if (existing) return { ok: true, geoId: existing.id }
  const pose = poseOf(state, modelItemId)
  const bake = bakeSketchInput(source, pose)
  if (!bake.ok) return { ok: false, reason: refusalReason(bake) }
  const id = newId()
  state.addGeometry(sketchInputPart(id, bake))
  remember(id, source)
  return { ok: true, geoId: id }
}

// The sketch each linked part was last written from, with the loops it holds. Loops do not carry
// sketch entity ids, so this is how an edit tells a resized loop from an unrelated new one: only
// loops that share sketch entities with a deleted loop take its pick. After a reload the first
// sync records the saved state; an edit seen before that has no identity, so no pick moves.
const lastBaked = new Map<string, { sketch: ModelSketchSource['sketch']; loops: Loop2D[] }>()

function remember(geoId: string, source: ModelSketchSource): void {
  const part = useCamStore.getState().project.geometry.find((g) => g.id === geoId)
  const link = part && sketchInputLink(part)
  if (!part || !link) return
  lastBaked.set(geoId, { sketch: source.sketch, loops: (part.loops ?? []).filter((l) => l.layerId === link.layer.id) })
}

function remapOperation(op: Operation, geoId: string, map: Record<string, string | null>): Partial<Operation> | null {
  const params = op.params as { geometryId?: string; loopIds?: string[] }
  // An operation on every part ('__all__') picks loops across parts; the ids are namespaced by
  // their part, so only this part's ids are in the map either way.
  if ((params.geometryId !== geoId && params.geometryId !== '__all__') || !Array.isArray(params.loopIds) || params.loopIds.length === 0) return null
  if (!params.loopIds.some((id) => map[id] !== undefined && map[id] !== null)) return null
  // A pick whose loop is gone keeps its old id: an empty list would mean every loop. The
  // operation then shows the existing missing-selection state instead of cutting other curves.
  const remap = (ids: readonly string[]) => ids.map((id) => map[id] ?? id)
  return {
    params: { ...op.params, loopIds: remap(params.loopIds) },
    ...(op.geometrySelections?.length ? { geometrySelections: remap(op.geometrySelections) } : {}),
  }
}

/** Bring every linked sketch part up to its sketch as it is now. A model whose document is not
 *  open keeps its parts as saved; a sketch whose plane no longer can be cut keeps its last shape
 *  (the window shows why). Returns how many parts changed. */
export function syncSketchInputs(documentOf: ModelDocumentOf = liveModelDocument): number {
  const state = useCamStore.getState()
  const sources = sourcesOf(state, documentOf)
  let changed = 0
  for (const geo of state.project.geometry) {
    const link = sketchInputLink(geo)
    if (!link) continue
    const source = sources.find((s) => s.modelItemId === link.modelItemId && s.nodeId === link.nodeId)
    if (!source) continue
    const pose = poseOf(useCamStore.getState(), source.modelItemId)
    const bake = bakeSketchInput(source, pose)
    if (!bake.ok) continue
    const current = useCamStore.getState().project.geometry.find((g) => g.id === geo.id)
    const previous = lastBaked.get(geo.id)
    const update = current && planSketchInputUpdate(current, bake, previous && { previous, next: source.sketch })
    if (!update) { remember(geo.id, source); continue }
    const store = useCamStore.getState()
    if (update.poseChanged) store.updateGeometryTransform(update.geoId, update.pose.position, update.pose.rotation)
    store.setGeometryLoops(update.geoId, update.loops, update.layers)
    for (const setup of useCamStore.getState().project.setups) {
      for (const op of setup.operations) {
        const patch = remapOperation(op, update.geoId, update.loopIdMap)
        if (patch) useCamStore.getState().updateOperation(setup.id, op.id, patch)
      }
    }
    remember(update.geoId, source)
    changed++
  }
  return changed
}
