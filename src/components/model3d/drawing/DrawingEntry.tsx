// WO-2994 (WO-2750 Slice C): the Model workspace's way into technical drawings.
//
// docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 3: a "Create drawing"
// action on the selected Model body and a Drawings group that belongs to the
// Model Item. The drawings themselves live in the item's archive (Slice B,
// src/doc/documentHolder.ts get/setDrawingRecords), never in React state, so
// switching items, unmounting the workbench and saving all see the same
// records. This module also holds the small session state both halves of the
// UI share - which drawing is open in which item, and a change counter so the
// section and the editor re-read the records after a write - plus the body
// reading the entry and the editor both need.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight, FileText, Trash2 } from 'lucide-react'
import { useText } from '../../../i18n'
import { useUiPrefs } from '../../../store/uiPrefs'
import { useCamStore } from '../../../store'
import { getDrawingRecords, setDrawingRecords } from '../../../doc/documentHolder'
import type { BodyHandle, TessBuffers, TessQuality } from '../../../geom/geom-service'
import type { GeomClient } from '../../../geom'
import {
  createDrawingDocument,
  nextDrawingId,
  putDrawingDocument,
  restoreDrawingDocument,
  removeDrawingDocument,
  STANDARD_DRAWING_VIEWS,
  type DrawingDocument,
  type DrawingRecords,
  type DrawingSourceBox,
  type DrawingViewName,
} from '../../../lib/drawing/document'
import { MESH_OCCLUSION_PRODUCER, standardViewFrame } from '../../../lib/drawing/project'
import { contentFingerprint, MESH_DRAWING_PRODUCER, type MeshDrawingSource } from '../../../lib/drawing/meshSource'
import type { SourceRevision, ViewFrame } from '../../../lib/drawing/types'
import { drawingsModelPort, drawingsSignature, type DrawingsModel } from './drawingModePort'
import './drawing.css'

// ---------------------------------------------------------------------------
// Session state shared by the entry and the editor
// ---------------------------------------------------------------------------

const openDrawings = new Map<string, string>()
const recordVersions = new Map<string, number>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The drawing open in `modelItemId`'s editor, if any. Kept per item, so switching items and back reopens it. */
export function openDrawingId(modelItemId: string): string | null {
  return openDrawings.get(modelItemId) ?? null
}

export function setOpenDrawing(modelItemId: string, drawingId: string | null): void {
  if (drawingId === null) openDrawings.delete(modelItemId)
  else openDrawings.set(modelItemId, drawingId)
  emit()
}

export function useOpenDrawingId(modelItemId: string): string | null {
  return useSyncExternalStore(subscribe, () => openDrawingId(modelItemId), () => openDrawingId(modelItemId))
}

/** The item's drawings, re-read whenever this module writes them. */
export function useItemDrawings(modelItemId: string): DrawingRecords {
  const version = useSyncExternalStore(subscribe, () => recordVersions.get(modelItemId) ?? 0, () => recordVersions.get(modelItemId) ?? 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => getDrawingRecords(modelItemId), [modelItemId, version])
}

/**
 * The one write path: the holder keeps the records with the item's archive and
 * marks the document dirty for autosave (Slice B), and the store's own
 * per-item dirty action - the same call the workbench makes after a model edit
 * - records that the item has unsaved content.
 */
export function saveItemDrawings(modelItemId: string, records: DrawingRecords): void {
  setDrawingRecords(records, modelItemId)
  useCamStore.getState().markModelItemDocumentDirty(modelItemId)
  recordVersions.set(modelItemId, (recordVersions.get(modelItemId) ?? 0) + 1)
  emit()
}

/** Test/reset hook: forget which drawings are open (a new project, a fresh test). */
export function resetDrawingSession(): void {
  openDrawings.clear()
  recordVersions.clear()
  lastRemoved.clear()
  emit()
}

// ---------------------------------------------------------------------------
// Reading a body
// ---------------------------------------------------------------------------

export interface DrawingBody {
  bodyId: string
  lineageId?: string
  name: string
  /**
   * WO-3092: a body that is a mesh (an STL kept as an STL) reads its own
   * triangles - its bytes with its edit journal replayed - instead of being
   * tessellated through a kernel handle. Absent for a kernel body.
   */
  mesh?: MeshBodyReader
}

/** WO-3092: how a mesh body is read for a drawing. */
export interface MeshBodyReader {
  /** changes whenever what the read returns changes (the row, its edit journal) */
  key: string
  read(): Promise<BodyMesh>
}

/** What the Model page knows about a drawing's source right now. */
/** WO-3092: 'closed' - a mesh part whose STL is not open in the Model screen. */
export type DrawingSourceStatus = 'present' | 'deleted' | 'off' | 'failed' | 'closed'

export interface BodyMesh {
  mesh: { positions: Float32Array; indices: Uint32Array }
  box: DrawingSourceBox | null
  revision: SourceRevision
}

/** Body-local views: a rigid move of the part in the project does not redraw them (plan section 4.1). */
export const BODY_LOCAL_FRAME = 'body-local'

export function bodyLineage(body: DrawingBody): string {
  return body.lineageId ?? body.bodyId
}

export function meshBox(positions: Float32Array): DrawingSourceBox | null {
  if (positions.length < 3) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  return { min, max }
}

/**
 * The drawing's own tessellation tier: tighter than the viewport's display tier
 * (0.08 mm) so a curved edge stays inside the plan's 0.05 mm sheet budget at
 * 1:1. Its own object, so the drawing's reads are told apart from the
 * viewport's paints.
 */
export const DRAWING_TESS_QUALITY: TessQuality = Object.freeze({ deflection: 0.05, angularDeflection: 0.25 })

/** The body's current tessellation at the drawing tier, its box and the revision it is. */
export async function readBodyMesh(client: GeomClient, handle: BodyHandle): Promise<BodyMesh> {
  const tess: TessBuffers = await client.tessellate(handle, DRAWING_TESS_QUALITY)
  return {
    mesh: { positions: tess.position, indices: tess.index },
    box: meshBox(tess.position),
    revision: {
      geometryFingerprint: `${contentFingerprint(tess.position)}/${contentFingerprint(tess.index)}`,
      frameFingerprint: BODY_LOCAL_FRAME,
      producerVersion: MESH_OCCLUSION_PRODUCER,
    },
  }
}

/**
 * WO-3092: a mesh body's read, from the WO-2988 adapter's source (the row's
 * bytes with its journal replayed). An absent source throws the reason, so
 * the entry and the editor say it like any other failed read.
 */
export function meshBodyRead(src: MeshDrawingSource): BodyMesh {
  if (src.mesh === undefined || src.state.kind !== 'mesh') {
    throw new Error(src.problem === 'unreadable' ? 'its STL could not be read' : 'its STL file is not in this project any more')
  }
  return {
    mesh: { positions: src.mesh.positions, indices: src.mesh.indices },
    box: meshBox(src.mesh.positions),
    revision: src.state.revision,
  }
}

/** The body as a drawing reads it: a mesh body reads itself, a kernel body is tessellated. */
export async function readDrawingBody(body: DrawingBody, client: GeomClient | null, handle: BodyHandle | undefined): Promise<BodyMesh> {
  if (body.mesh !== undefined) return body.mesh.read()
  if (client === null || handle === undefined) throw new Error('geometry engine not ready')
  return readBodyMesh(client, handle)
}

export function standardFrames(box: DrawingSourceBox | null): Record<DrawingViewName, ViewFrame> {
  const centre: [number, number, number] = box === null
    ? [0, 0, 0]
    : [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]
  return Object.fromEntries(STANDARD_DRAWING_VIEWS.map((name) => [name, standardViewFrame(name, centre)])) as Record<DrawingViewName, ViewFrame>
}

/** The drawing each item's deletion notice can still bring back with Undo. */
const lastRemoved = new Map<string, DrawingDocument>()

/** Ids a new drawing of the item must not take: the one Undo can still restore. */
function reservedDrawingIds(modelItemId: string): string[] {
  const removed = lastRemoved.get(modelItemId)
  return removed === undefined ? [] : [removed.id]
}

/**
 * Make a drawing of `body` and write it into the item. When the body cannot be
 * read the drawing is still made (with views laid out at 1:1) and the reason
 * is returned, so the operator learns why and the editor tries again.
 */
export async function createDrawingOfBody(input: {
  modelItemId: string
  documentId: string
  body: DrawingBody
  name: string
  client: GeomClient | null
  handle: BodyHandle | undefined
  now?: string
}): Promise<{ drawing: DrawingDocument; problem?: string }> {
  let read: BodyMesh | null = null
  let problem: string | undefined
  try {
    read = await readDrawingBody(input.body, input.client, input.handle)
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
  }
  const records = getDrawingRecords(input.modelItemId)
  const isMesh = input.body.mesh !== undefined
  const revision: SourceRevision = read?.revision ?? { geometryFingerprint: '', frameFingerprint: BODY_LOCAL_FRAME, producerVersion: isMesh ? MESH_DRAWING_PRODUCER : MESH_OCCLUSION_PRODUCER }
  const drawing = createDrawingDocument({
    id: nextDrawingId(records, reservedDrawingIds(input.modelItemId)),
    name: input.name,
    source: {
      modelItemId: input.modelItemId,
      documentId: input.documentId,
      lineageId: bodyLineage(input.body),
      // WO-3092: an STL kept as an STL is a mesh source (WO-2988).
      kind: isMesh ? 'mesh' : 'model-brep',
      observedRevision: revision,
    },
    frames: standardFrames(read?.box ?? null),
    box: read?.box ?? null,
    now: input.now ?? new Date().toISOString(),
  })
  if (read === null) delete drawing.lastGoodRevision
  saveItemDrawings(input.modelItemId, putDrawingDocument(records, drawing))
  return { drawing, problem }
}

// ---------------------------------------------------------------------------
// The Drawings section
// ---------------------------------------------------------------------------


export interface DrawingEntryProps {
  modelItemId: string
  documentId: string
  bodies: DrawingBody[]
  /** the body (or feature) the Model selection points at */
  selectedId: string | null
  getClient(): GeomClient | null
  getBodyHandle(bodyId: string): BodyHandle | undefined
  sourceStatus(lineageId: string): DrawingSourceStatus
}

/** Which body "Create drawing" uses: the selected one, or the only one there is. */
export function drawingTargetBody(bodies: DrawingBody[], selectedId: string | null): DrawingBody | null {
  if (selectedId !== null) {
    const hit = bodies.find((b) => b.bodyId === selectedId || b.lineageId === selectedId)
    if (hit !== undefined) return hit
  }
  return bodies.length === 1 ? bodies[0] : null
}

export function DrawingEntry({ modelItemId, documentId, bodies, selectedId, getClient, getBodyHandle, sourceStatus }: DrawingEntryProps) {
  const t = useText('technical-drawings')
  const records = useItemDrawings(modelItemId)
  const openId = useOpenDrawingId(modelItemId)
  const collapsed = useUiPrefs((s) => s.workbenchCollapsedSections.includes('drawings'))
  const toggle = useUiPrefs((s) => s.toggleWorkbenchSectionCollapsed)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [removedName, setRemovedName] = useState<string | null>(lastRemoved.get(modelItemId)?.name ?? null)
  const target = drawingTargetBody(bodies, selectedId)

  const create = async (): Promise<void> => {
    if (target === null || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const { drawing, problem } = await createDrawingOfBody({
        modelItemId,
        documentId,
        body: target,
        name: t('entry.defaultName', { part: target.name }),
        client: getClient(),
        handle: getBodyHandle(target.bodyId),
      })
      if (problem !== undefined) setNotice(t('entry.createFailed', { reason: problem }))
      setOpenDrawing(modelItemId, drawing.id)
    } finally {
      setBusy(false)
    }
  }

  const remove = (drawing: DrawingDocument): void => {
    lastRemoved.set(modelItemId, drawing)
    setRemovedName(drawing.name)
    if (openId === drawing.id) setOpenDrawing(modelItemId, null)
    saveItemDrawings(modelItemId, removeDrawingDocument(getDrawingRecords(modelItemId), drawing.id))
  }

  const undoRemove = (): void => {
    const drawing = lastRemoved.get(modelItemId)
    if (drawing === undefined) return
    lastRemoved.delete(modelItemId)
    setRemovedName(null)
    saveItemDrawings(modelItemId, restoreDrawingDocument(getDrawingRecords(modelItemId), drawing).records)
  }

  // WO-3301: the New UI's Drawings section and Drawing mode read this same list and the same actions
  const model: DrawingsModel = {
    modelItemId,
    drawings: records.documents.map((d) => ({ id: d.id, name: d.name, sourceGone: sourceStatus(d.source.lineageId) === 'deleted' })),
    openId,
    canCreate: target !== null && !busy,
    creating: busy,
    bodyCount: bodies.length,
    removedName,
    notice,
    create: () => { void create() },
    open: (drawingId) => setOpenDrawing(modelItemId, drawingId),
    close: () => setOpenDrawing(modelItemId, null),
    remove: (drawingId) => {
      const drawing = records.documents.find((d) => d.id === drawingId)
      if (drawing !== undefined) remove(drawing)
    },
    undoRemove,
  }
  const signature = drawingsSignature(model)
  const [owner] = useState(() => ({}))
  useEffect(() => { drawingsModelPort.update(model, signature, owner) })
  useEffect(() => () => drawingsModelPort.release(owner), [owner])

  return (
    <div className="tree-section" data-testid="workbench-section-drawings">
      <div
        className="tree-section-header tree-section-header-btn"
        data-testid="workbench-section-drawings-header"
        data-ui78-sanctioned=""
        onClick={() => toggle('drawings')}
      >
        {t('entry.section')}<span className="tree-count">{records.documents.length}</span>
        <span className="tree-section-header-chevron">
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </span>
      </div>
      {!collapsed && (
        <div className="drawing-entry">
          <button
            type="button"
            className="drawing-entry-create"
            data-testid="drawing-create"
            disabled={target === null || busy}
            // WO-3092: with bodies listed, the reason is which one - never "select a body" as if there were none.
            title={target !== null ? t('entry.createTip') : bodies.length > 1 ? t('entry.createPickOne', { count: bodies.length }) : t('entry.createNeedsBody')}
            onClick={() => { void create() }}
          >
            <FileText size={12} /> {busy ? t('entry.creating') : t('entry.create')}
          </button>
          {notice !== null && <div className="drawing-entry-notice" data-testid="drawing-create-notice" role="status">{notice}</div>}
          {removedName !== null && (
            <div className="drawing-entry-notice" data-testid="drawing-removed-notice" role="status">
              {t('entry.removed', { name: removedName })}{' '}
              <button type="button" className="drawing-entry-link" data-testid="drawing-undo-remove" onClick={undoRemove}>{t('entry.undoRemove')}</button>
            </div>
          )}
          {records.documents.length === 0 && <div className="drawing-entry-empty">{t('entry.empty')}</div>}
          {records.documents.map((drawing) => {
            const gone = sourceStatus(drawing.source.lineageId) === 'deleted'
            return (
              <div
                key={drawing.id}
                className={`drawing-entry-row${openId === drawing.id ? ' is-open' : ''}`}
                data-testid={`drawing-row-${drawing.id}`}
                data-source={gone ? 'deleted' : 'linked'}
              >
                <button
                  type="button"
                  className="drawing-entry-open"
                  data-testid={`drawing-open-${drawing.id}`}
                  title={t('entry.openTip', { name: drawing.name })}
                  onClick={() => setOpenDrawing(modelItemId, drawing.id)}
                >
                  <FileText size={12} /> <span className="drawing-entry-name">{drawing.name}</span>
                  {gone && <span className="drawing-entry-tag">{t('entry.sourceGone')}</span>}
                </button>
                <button
                  type="button"
                  className="drawing-entry-remove"
                  data-testid={`drawing-remove-${drawing.id}`}
                  aria-label={t('entry.removeTip', { name: drawing.name })}
                  title={t('entry.removeTip', { name: drawing.name })}
                  onClick={() => remove(drawing)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
