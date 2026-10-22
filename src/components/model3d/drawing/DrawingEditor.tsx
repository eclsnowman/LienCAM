// WO-2994 (WO-2750 Slice C): the sheet editor that replaces the Model canvas
// while a drawing is open (docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md
// section 3).
//
// What it keeps true (plan sections 3 and 4.2 step 7):
//  - The drawing is read from and written to the item's archive through the
//    holder (DrawingEntry saveItemDrawings), never kept in component state.
//  - Views follow the part. Every projection is tagged with the item, the
//    drawing, the body handle it read and a token; only the newest request
//    for that drawing may publish, so a slow edit A finishing after edit B
//    never paints A's geometry over B, and a result for another drawing or
//    item lands only in that drawing's own slot. An unmounted editor (the
//    operator switched items) publishes nothing.
//  - When the part is gone (deleted, suppressed/rolled back, failed) the
//    drawing stays, keeps its last views in this session and says in one
//    sentence what happened and what to do (LIENCAM.md rule 11). Undo of the
//    delete brings the part back and the views update again.
//
// Views are drawn from the body's tessellation (DRAWING_TESS_QUALITY) with Slice A's mesh
// producer (projectMesh): the geometry client has no hidden-line call on this
// route, so the editor says the views are approximate. Exact OCCT HLR
// (projectBrepHlr) is a later step.
//
// WO-3006 (WO-2750 Slice E) adds, through src/lib/drawing/annotations.ts and
// template.ts:
//  - linear / angle / radius / diameter dimensions picked on the part's faces
//    in a view, each resolved against the body as it is NOW (the same read
//    that draws the views, so a label and its witnesses never mix revisions);
//    a dimension whose face is gone shows its last-good value and one
//    sentence, and is repaired by picking one new face (Accept is one Undo
//    step, Cancel changes nothing);
//  - round detail views, manual numbered balloons, an editable title block
//    and general tolerance table, sheet unit and precision;
//  - one drawing Undo/Redo for every drawing edit (dimensions, tolerances,
//    detail views, balloons, template, sheet size, repair). The part's own
//    Undo stays the Model's.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useText } from '../../../i18n'
import type { BodyHandle, TessBuffers } from '../../../geom/geom-service'
import type { GeomClient } from '../../../geom'
import { projectMesh, toSheet } from '../../../lib/drawing/project'
import { buildSheetScene, type AnnotationRender, type SceneInputs } from '../../../lib/drawing/scene'
import { exportDrawingPdf } from '../../../lib/drawing/exportPdf'
import { exportDrawingDxf } from '../../../lib/drawing/exportDxf'
import { safeFilenameComponent, saveFile } from '../../../lib/saveFile'
import {
  DRAWING_TITLE_BAND_MM,
  putDrawingDocument,
  resizeDrawingSheet,
  sheetSizeName,
  type DrawingDimension,
  type DrawingDocument,
  type DrawingMeasurementKind,
  type DrawingSheet,
  type DrawingSheetSizeName,
  type DrawingSourceBox,
  type DrawingToleranceIntent,
  type DrawingView,
} from '../../../lib/drawing/document'
import {
  addBalloon,
  addDetailView,
  addDimension,
  bodyFacesFromTess,
  brepSourceForBody,
  defaultDimensionLabel,
  detailCircle,
  detailCircleOnParent,
  dimensionGraphic,
  faceFacts,
  faceOnSheet,
  facesNeeded,
  formatDimensionText,
  generalToleranceFor,
  generalToleranceUpdate,
  lastGoodDiffers,
  makeFaceReference,
  measureFaces,
  moveDetailView,
  nextDrawingItemId,
  pickFace,
  reassociateDimension,
  removeAnnotations,
  removeDetailView,
  resolveDimension,
  restoreDrawingEdit,
  setDetailMagnification,
  setSheetUnits,
  updateAnnotation,
  viewAtPoint,
  withLastGood,
  type BodyFaces,
  type DimensionReason,
  type DimensionStatus,
  type FaceFacts,
  type MeasureProblem,
  type Pt,
} from '../../../lib/drawing/annotations'
import {
  BOUND_TITLE_FIELDS,
  LITERAL_TITLE_FIELDS,
  effectiveTemplate,
  formatDrawingDate,
  generalToleranceValue,
  setGeneralTolerances,
  setTemplateField,
  setTemplateOverride,
  titleBlockRect,
  titleBlockValues,
  toleranceBlockRect,
  type TitleFieldKey,
} from '../../../lib/drawing/template'
import type { CurrentSourceState } from '../../../lib/drawing/resolve'
import type { SheetLine, SourceRevision } from '../../../lib/drawing/types'
import { getDrawingRecords, getModelSession } from '../../../doc/documentHolder'
import {
  bodyLineage,
  readBodyMesh,
  saveItemDrawings,
  setOpenDrawing,
  useItemDrawings,
  useOpenDrawingId,
  type DrawingBody,
  type DrawingSourceStatus,
} from './DrawingEntry'

// ---------------------------------------------------------------------------
// Views drawn this session, per item and drawing
// ---------------------------------------------------------------------------

interface DrawnViews {
  /** item | drawing | body handle | view layout the lines were made for */
  key: string
  geometryFingerprint: string
  box: DrawingSourceBox | null
  /** view id -> its lines in view mm (scale is applied at paint time) */
  scenes: Map<string, ReturnType<typeof projectMesh>>
  /** WO-3006: the same read's faces, for picking and measuring */
  faces: BodyFaces
  revision: SourceRevision
}

const drawn = new Map<string, DrawnViews>()
const latestRequest = new Map<string, number>()
let requestCounter = 0
const drawnListeners = new Set<() => void>()
const drawnVersion = { value: 0 }

/** WO-3006: drawing-edit Undo/Redo, per item and drawing (session only, like the Model's history). */
const editHistory = new Map<string, { past: DrawingDocument[]; future: DrawingDocument[] }>()
const HISTORY_LIMIT = 100

function bumpDrawn(): void {
  drawnVersion.value += 1
  for (const l of [...drawnListeners]) l()
}

function slotKey(modelItemId: string, drawingId: string): string {
  return `${modelItemId}\u0000${drawingId}`
}

function historyFor(slot: string): { past: DrawingDocument[]; future: DrawingDocument[] } {
  let h = editHistory.get(slot)
  if (h === undefined) { h = { past: [], future: [] }; editHistory.set(slot, h) }
  return h
}

/** Forget every drawn view (a new project, a fresh test). */
export function resetDrawnViews(): void {
  drawn.clear()
  latestRequest.clear()
  editHistory.clear()
  bumpDrawn()
}

/** Test seam: the views drawn for a drawing this session. */
export function drawnViewsFor(modelItemId: string, drawingId: string): { geometryFingerprint: string; lineCount: number } | undefined {
  const d = drawn.get(slotKey(modelItemId, drawingId))
  if (d === undefined) return undefined
  let lineCount = 0
  for (const s of d.scenes.values()) lineCount += s.lines.length
  return { geometryFingerprint: d.geometryFingerprint, lineCount }
}

/** Standard views only: a detail view reuses its parent's lines, so adding one never re-reads the part. */
function viewLayoutKey(doc: DrawingDocument): string {
  return doc.sheets.map((s) => s.views.filter((v) => v.detail === undefined).map((v) => `${v.id}:${v.frame.origin.join(',')}:${v.frame.towardViewer.join(',')}:${v.frame.xAxis.join(',')}`).join(';')).join('|')
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** The scene a view paints: its own, or its parent's for a detail view (same frame). */
function sceneFor(views: DrawnViews | undefined, view: DrawingView) {
  return views?.scenes.get(view.detail?.parentViewId ?? view.id)
}

/**
 * What the export engine needs from the editor: the projection of each view and, for each dimension, what the
 * resolver proved and the lines and arrows the sheet draws for it (the same dimensionGraphic call the screen
 * makes, at the dimension's saved label place), so the file shows what the operator sees.
 */
export function drawingExportInputs(
  doc: DrawingDocument,
  sheet: DrawingSheet,
  scenes: ReadonlyMap<string, ReturnType<typeof projectMesh>> | undefined,
  statuses: ReadonlyMap<string, DimensionStatus>,
  partName: string,
): SceneInputs {
  const projections: SceneInputs['projections'] = {}
  for (const view of sheet.views) {
    const own = scenes?.get(view.detail?.parentViewId ?? view.id)
    if (own !== undefined) projections[view.id] = own
  }
  const annotations: Record<string, AnnotationRender> = {}
  for (const a of doc.annotations) {
    if (a.kind !== 'dimension') continue
    const st = statuses.get(a.id)
    // an unresolved dimension is left out so the sheet says it was not checked; anything else carries its state
    if (st === undefined) continue
    const render: AnnotationRender = { state: st.state, ...(st.reason !== undefined ? { reason: st.reason as AnnotationRender['reason'] } : {}) }
    if (st.state === 'current' && st.value !== undefined) render.valueMm = st.value
    const view = sheet.views.find((v) => v.id === a.viewId)
    if (st.state === 'current' && st.faces !== undefined && view !== undefined) {
      const graphic = dimensionGraphic(a.measurement, view, st.faces, a.labelSheetMm ?? view.sheetOriginMm)
      if (!('problem' in graphic)) render.graphic = { lines: graphic.lines, arrows: graphic.arrows, label: graphic.label }
    }
    annotations[a.id] = render
  }
  return { projections, annotations, partName, sheetId: sheet.id }
}

type ExportKind = 'pdf' | 'dxf' | 'dxf-logo'

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

export interface DrawingEditorProps {
  modelItemId: string
  bodies: DrawingBody[]
  getClient(): GeomClient | null
  getBodyHandle(bodyId: string): BodyHandle | undefined
  sourceStatus(lineageId: string): DrawingSourceStatus
  /** the part's name in the Model tree, for the breadcrumb */
  partName(lineageId: string): string
}

type Phase = 'current' | 'updating' | 'waiting' | 'error'

type Tool = DrawingMeasurementKind | 'detail' | 'balloon'

const VIEW_LABEL_KEYS = {
  front: 'editor.viewFront',
  top: 'editor.viewTop',
  right: 'editor.viewRight',
  iso: 'editor.viewIso',
} as const

/** Each tool's [name, tip] catalog keys. */
const TOOL_TEXT = {
  linear: ['annotate.toolLinear', 'annotate.toolLinearTip'],
  angle: ['annotate.toolAngle', 'annotate.toolAngleTip'],
  radius: ['annotate.toolRadius', 'annotate.toolRadiusTip'],
  diameter: ['annotate.toolDiameter', 'annotate.toolDiameterTip'],
  detail: ['annotate.toolDetail', 'annotate.toolDetailTip'],
  balloon: ['annotate.toolBalloon', 'annotate.toolBalloonTip'],
} as const

const PROBLEM_KEYS: Record<MeasureProblem | 'faces-face-viewer', `annotate.${string}`> = {
  'needs-plane': 'annotate.problemNeedsPlane',
  'needs-round': 'annotate.problemNeedsRound',
  'not-parallel': 'annotate.problemNotParallel',
  parallel: 'annotate.problemParallel',
  'same-face': 'annotate.problemSameFace',
  coplanar: 'annotate.problemCoplanar',
  'not-round': 'annotate.problemNotRound',
  'no-geometry': 'annotate.problemNoGeometry',
  'faces-face-viewer': 'annotate.problemFacesFaceViewer',
}

/** The one sentence a dimension's state shows (rule 11: what happened and what to do). */
function statusKey(state: DimensionStatus['state'], reason: DimensionReason | undefined) {
  if (state === 'current') return 'annotate.dimCurrent' as const
  if (state === 'updating') return 'annotate.dimUpdating' as const
  switch (reason) {
    case 'source-missing':
    case 'scope-mismatch':
      return 'annotate.dimSourceGone' as const
    case 'deleted':
    case 'not-found':
    case 'edge-gone':
    case 'reference-record-missing':
      return 'annotate.dimFaceGone' as const
    case 'split':
      return 'annotate.dimSplit' as const
    case 'geometric-candidate-only':
      return 'annotate.dimLookAlike' as const
    case 'not-parallel':
      return 'annotate.dimNotParallel' as const
    case 'parallel':
      return 'annotate.dimNowParallel' as const
    case 'coplanar':
      return 'annotate.dimCoplanar' as const
    case 'not-round':
      return 'annotate.dimNotRound' as const
    case 'witness-role-mismatch':
    case 'witness-orientation-changed':
    case 'endpoints-collapsed':
    case 'needs-plane':
    case 'needs-round':
      return 'annotate.dimChanged' as const
    default:
      return 'annotate.dimCannotMeasure' as const
  }
}

const MAGNIFICATIONS: Array<[number, number]> = [[2, 1], [3, 1], [4, 1], [5, 1], [10, 1]]

export function DrawingEditor(props: DrawingEditorProps) {
  const openId = useOpenDrawingId(props.modelItemId)
  const records = useItemDrawings(props.modelItemId)
  const doc = openId === null ? undefined : records.documents.find((d) => d.id === openId)
  if (doc === undefined) return null
  return <DrawingSheetEditor key={doc.id} {...props} doc={doc} />
}

interface RepairState {
  dimId: string
  index: number
  pick?: { viewId: string; faceId: string }
}

interface DragState {
  kind: 'dimension' | 'balloon' | 'detail'
  id: string
  from: Pt
  at: Pt
  orig: Pt
}

/** A sheet point under a pointer: the SVG letterboxes its viewBox (preserveAspectRatio meet). */
function sheetPointOf(svg: SVGSVGElement, sizeMm: [number, number], clientX: number, clientY: number): Pt | null {
  const rect = svg.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  const k = Math.min(rect.width / sizeMm[0], rect.height / sizeMm[1])
  const ox = (rect.width - sizeMm[0] * k) / 2
  const oy = (rect.height - sizeMm[1] * k) / 2
  return [(clientX - rect.left - ox) / k, (clientY - rect.top - oy) / k]
}

function DrawingSheetEditor({ modelItemId, bodies, getClient, getBodyHandle, sourceStatus, partName, doc }: DrawingEditorProps & { doc: DrawingDocument }) {
  const t = useText('technical-drawings')
  useSyncExternalStore(
    (l) => { drawnListeners.add(l); return () => { drawnListeners.delete(l) } },
    () => drawnVersion.value,
    () => drawnVersion.value,
  )
  const [phase, setPhase] = useState<Phase>('waiting')
  const [problem, setProblem] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool | null>(null)
  const [picks, setPicks] = useState<Array<{ viewId: string; faceId: string }>>([])
  const [detailClicks, setDetailClicks] = useState<Array<{ viewId: string; at: Pt }>>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [repair, setRepair] = useState<RepairState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const slot = slotKey(modelItemId, doc.id)
  const lineage = doc.source.lineageId
  const status = sourceStatus(lineage)
  const body = bodies.find((b) => bodyLineage(b) === lineage)
  const handle = body === undefined ? undefined : getBodyHandle(body.bodyId)
  const layout = viewLayoutKey(doc)
  const currentKey = `${slot}\u0000${handle}\u0000${layout}`

  useEffect(() => {
    if (status !== 'present') return
    const client = getClient()
    if (body === undefined || handle === undefined || client === null) {
      setPhase('waiting')
      return
    }
    const key = currentKey
    if (drawn.get(slot)?.key === key) {
      setPhase('current')
      return
    }
    const token = ++requestCounter
    latestRequest.set(slot, token)
    setPhase('updating')
    setProblem(null)
    void (async () => {
      try {
        // One read serves the views, the picks and the dimensions: the
        // tessellation readBodyMesh asks for is kept for its face ids.
        let tess: TessBuffers | undefined
        const capturing = { tessellate: async (...args: Parameters<GeomClient['tessellate']>) => (tess = await client.tessellate(...args)) } as unknown as GeomClient
        const read = await readBodyMesh(capturing, handle)
        const scenes = new Map<string, ReturnType<typeof projectMesh>>()
        const views = getDrawingRecords(modelItemId).documents.find((d) => d.id === doc.id)?.sheets.flatMap((s) => s.views).filter((v) => v.detail === undefined) ?? []
        for (const view of views) {
          if (latestRequest.get(slot) !== token || !mounted.current) return
          scenes.set(view.id, projectMesh(read.mesh, view.frame))
          await yieldToBrowser()
        }
        // Publish only the newest request, into this drawing's own slot, from a
        // live editor. Anything else is a late result for a revision that no
        // longer exists here.
        if (latestRequest.get(slot) !== token || !mounted.current) return
        const faces = tess === undefined ? { triangles: new Map(), bboxDiagMm: 0 } : bodyFacesFromTess(tess)
        drawn.set(slot, { key, geometryFingerprint: read.revision.geometryFingerprint, box: read.box, scenes, faces, revision: read.revision })
        const fresh = getDrawingRecords(modelItemId)
        const current = fresh.documents.find((d) => d.id === doc.id)
        if (current !== undefined && current.lastGoodRevision?.geometryFingerprint !== read.revision.geometryFingerprint) {
          // A real geometry change: the drawing records the revision it now
          // shows (plan section 4.2 step 7, last-good with provenance), and
          // WO-3006: the title block's "model edited" date. A drawing that had
          // no revision yet (made while the part could not be read) is seeing
          // the part for the first time, not an edit.
          saveItemDrawings(modelItemId, putDrawingDocument(fresh, {
            ...current,
            source: { ...current.source, observedRevision: read.revision },
            lastGoodRevision: read.revision,
            ...(current.lastGoodRevision !== undefined ? { sourceEditedAt: new Date().toISOString() } : {}),
          }))
        }
        setPhase('current')
        bumpDrawn()
      } catch (err) {
        if (latestRequest.get(slot) !== token || !mounted.current) return
        setProblem(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()
    // `doc` changes on every write; the layout key and handle are what the lines depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, status, body?.bodyId, handle, layout, modelItemId])

  const views = drawn.get(slot)
  const sheet = doc.sheets[0]
  const size = sheet === undefined ? null : sheetSizeName(sheet.sizeMm)
  // The read the views show is the part as it is now only when it was made
  // for this handle and layout; until then dimensions say "updating".
  const upToDate = status === 'present' && phase === 'current' && views?.key === currentKey
  const session = getModelSession(modelItemId)

  // ---- dimension resolution (one revision: the read that drew the views) ----
  const resolution = useMemo(() => {
    const out = new Map<string, DimensionStatus>()
    const factsCache = new Map<string, FaceFacts | undefined>()
    let source: CurrentSourceState | null = null
    if (status !== 'present') source = { kind: 'absent' }
    else if (upToDate && views !== undefined && session !== undefined) source = brepSourceForBody(doc, views.revision, session.map, views.faces)
    const facts = (id: string): FaceFacts | undefined => {
      if (views === undefined || session === undefined) return undefined
      if (!factsCache.has(id)) factsCache.set(id, faceFacts(session.map, views.faces, id))
      return factsCache.get(id)
    }
    for (const a of doc.annotations) {
      if (a.kind !== 'dimension') continue
      out.set(a.id, source === null
        ? { state: 'updating', unit: a.measurement === 'angle' ? 'deg' : 'mm', references: [], candidates: [] }
        : resolveDimension(a, doc, { source, facts }))
    }
    return { statuses: out, facts }
  }, [doc, status, upToDate, views, session])

  // Proved values become the dimensions' last-good cache (not a drawing edit).
  useEffect(() => {
    const updates: Array<{ id: string; value: number; unit: 'mm' | 'deg'; measuredAt: SourceRevision }> = []
    for (const a of doc.annotations) {
      if (a.kind !== 'dimension') continue
      const st = resolution.statuses.get(a.id)
      if (st?.state === 'current' && st.value !== undefined && st.measuredAt !== undefined && lastGoodDiffers(a, st.value, st.measuredAt)) {
        updates.push({ id: a.id, value: st.value, unit: st.unit, measuredAt: st.measuredAt })
      }
    }
    if (updates.length === 0) return
    const fresh = getDrawingRecords(modelItemId)
    const current = fresh.documents.find((d) => d.id === doc.id)
    if (current === undefined) return
    saveItemDrawings(modelItemId, putDrawingDocument(fresh, withLastGood(current, updates)))
  }, [resolution, doc, modelItemId])

  // ---- export (WO-3016): the sheet on screen, through the WO-3012 writers and the app's one save route ----
  const exportSheet = async (kind: ExportKind): Promise<void> => {
    if (sheet === undefined) return
    const label = kind === 'pdf' ? 'PDF' : 'DXF'
    try {
      const scene = buildSheetScene(doc, drawingExportInputs(doc, sheet, views?.scenes, resolution.statuses, partLabel))
      const stem = `${safeFilenameComponent(doc.name, 'drawing')}-sheet${doc.sheets.indexOf(sheet) + 1}`
      let saved: Array<string | null>
      let assetsFolder = `${stem}-assets`
      if (kind === 'pdf') {
        saved = [await saveFile(`${stem}.pdf`, new Blob([exportDrawingPdf(scene).bytes as BlobPart], { type: 'application/pdf' }), 'application/pdf')]
      } else {
        const out = exportDrawingDxf(scene, { branding: kind === 'dxf-logo' ? 'companion' : 'vector-only', fileStem: stem })
        // the writer cleans the stem for the IMAGE path it writes into the DXF; the file name and the folder the notice names
        // use that same cleaned stem, so the DXF, its IMAGE reference and the folder the operator is told all match
        const folder = out.companions[0]?.path.split('/')[0]
        if (folder !== undefined) assetsFolder = folder
        const dxfStem = folder !== undefined ? folder.replace(/-assets$/, '') : stem
        saved = [await saveFile(`${dxfStem}.dxf`, out.dxf, 'application/dxf')]
        if (saved[0] !== null && out.companions.length > 0) {
          // the DXF is already on disk: each logo image is its own save, and a cancelled or failed one is said as such
          let done = 0
          let reason = ''
          for (const c of out.companions) {
            try {
              if (await saveFile(c.path.split('/').pop() ?? c.path, new Blob([c.bytes as BlobPart], { type: c.contentType }), c.contentType) !== null) done++
            } catch (err) {
              reason = err instanceof Error ? err.message : String(err)
            }
          }
          if (mounted.current) {
            setNotice(done === out.companions.length
              ? t('export.savedLogo', { kind: label, count: done, folder: assetsFolder })
              : t('export.savedLogoMissing', { kind: label, missing: out.companions.length - done, folder: assetsFolder, reason: reason === '' ? '' : ` (${reason})` }))
          }
          return
        }
      }
      if (mounted.current && saved[0] !== null) setNotice(t('export.saved', { kind: label }))
    } catch (err) {
      if (mounted.current) setNotice(t('export.failed', { kind: label, reason: err instanceof Error ? err.message : String(err) }))
    }
  }
  const hasLogo = doc.template.assetIds.some((id) => doc.assets.some((a) => a.id === id))

  // ---- edits ----
  const history = historyFor(slot)
  const commit = (make: (current: DrawingDocument, now: string) => DrawingDocument): DrawingDocument | undefined => {
    const fresh = getDrawingRecords(modelItemId)
    const current = fresh.documents.find((d) => d.id === doc.id)
    if (current === undefined) return undefined
    const next = make(current, new Date().toISOString())
    if (next === current) return current
    history.past.push(current)
    if (history.past.length > HISTORY_LIMIT) history.past.shift()
    history.future = []
    saveItemDrawings(modelItemId, putDrawingDocument(fresh, next))
    return next
  }
  const step = (from: DrawingDocument[], to: DrawingDocument[]): void => {
    const fresh = getDrawingRecords(modelItemId)
    const current = fresh.documents.find((d) => d.id === doc.id)
    const target = from.pop()
    if (current === undefined || target === undefined) return
    to.push(current)
    setRepair(null)
    setSelected(null)
    saveItemDrawings(modelItemId, putDrawingDocument(fresh, { ...restoreDrawingEdit(target, current), editedAt: new Date().toISOString() }))
  }
  const undo = (): void => step(history.past, history.future)
  const redo = (): void => step(history.future, history.past)

  const changeSize = (next: DrawingSheetSizeName): void => {
    if (sheet === undefined) return
    commit((current, now) => resizeDrawingSheet(current, sheet.id, next, views?.box ?? null, now))
  }

  const chooseTool = (next: Tool): void => {
    setTool((cur) => (cur === next ? null : next))
    setPicks([])
    setDetailClicks([])
    setRepair(null)
    setNotice(null)
  }

  const cancelAll = (): void => {
    setTool(null)
    setPicks([])
    setDetailClicks([])
    setRepair(null)
    setNotice(null)
  }

  const problemText = (p: MeasureProblem | 'faces-face-viewer', kind: DrawingMeasurementKind): string =>
    t(PROBLEM_KEYS[p] as 'annotate.problemNeedsPlane', { kind: t(TOOL_TEXT[kind][0]) })

  /** The face under a sheet point, or a sentence saying why there is none. */
  const pickAt = (at: Pt): { view: DrawingView; faceId: string } | string => {
    if (sheet === undefined) return t('annotate.pickOnView')
    if (!upToDate || views === undefined) return t('annotate.notCurrent')
    const view = viewAtPoint(sheet, views.faces, at)
    if (view === undefined) return t('annotate.pickOnView')
    const faceId = pickFace(view, views.faces, at)
    return faceId === null ? t('annotate.noFaceHere') : { view, faceId }
  }

  const onSheetClick = (e: ReactMouseEvent<SVGSVGElement>): void => {
    if (sheet === undefined) return
    const at = sheetPointOf(e.currentTarget, sheet.sizeMm, e.clientX, e.clientY)
    if (at === null) return
    if (repair !== null) {
      const hit = pickAt(at)
      if (typeof hit === 'string') { setNotice(hit); return }
      const dim = doc.annotations.find((a): a is DrawingDimension => a.kind === 'dimension' && a.id === repair.dimId)
      const f = resolution.facts(hit.faceId)
      if (dim === undefined) return
      const wanted = dim.measurement === 'radius' || dim.measurement === 'diameter' ? 'cylinder' : 'plane'
      if (f === undefined || f.surfaceType !== wanted) {
        setNotice(problemText(wanted === 'cylinder' ? 'needs-round' : 'needs-plane', dim.measurement))
        return
      }
      setNotice(null)
      setRepair({ ...repair, pick: { viewId: hit.view.id, faceId: hit.faceId } })
      return
    }
    if (tool === null) { setSelected(null); return }
    if (tool === 'balloon') {
      const viewId = views === undefined ? undefined : viewAtPoint(sheet, views.faces, at)?.id
      let id = ''
      commit((current, now) => {
        const made = addBalloon(current, { anchorSheetMm: at, labelSheetMm: [at[0] + 10, at[1] - 10], ...(viewId !== undefined ? { viewId } : {}) }, now)
        id = made.id
        return made.doc
      })
      setSelected(id)
      setNotice(null)
      return
    }
    if (tool === 'detail') {
      if (detailClicks.length === 0) {
        const view = views === undefined ? undefined : viewAtPoint(sheet, views.faces, at)
        if (view === undefined || view.detail !== undefined) { setNotice(t('annotate.detailOnView')); return }
        setDetailClicks([{ viewId: view.id, at }])
        setNotice(null)
        return
      }
      if (detailClicks.length === 1) {
        const c = detailClicks[0].at
        if (Math.hypot(at[0] - c[0], at[1] - c[1]) === 0) { setNotice(t('annotate.detailTooSmall')); return }
        setDetailClicks([...detailClicks, { viewId: detailClicks[0].viewId, at }])
        setNotice(null)
        return
      }
      const [centre, edge] = detailClicks
      let id = ''
      let label = ''
      commit((current, now) => {
        const made = addDetailView(current, sheet.id, {
          parentViewId: centre.viewId,
          centerSheetMm: centre.at,
          radiusSheetMm: Math.hypot(edge.at[0] - centre.at[0], edge.at[1] - centre.at[1]),
          placeSheetMm: at,
          magnification: { numerator: 2, denominator: 1 },
        }, now)
        id = made.id
        label = made.doc.sheets.flatMap((sh) => sh.views).find((v) => v.id === made.id)?.label ?? ''
        return made.doc
      })
      setDetailClicks([])
      setTool(null)
      setSelected(id)
      setNotice(t('annotate.detailMade', { label, numerator: '2', denominator: '1' }))
      return
    }
    // A dimension tool.
    const hit = pickAt(at)
    if (typeof hit === 'string') { setNotice(hit); return }
    if (picks.length > 0 && picks[0].viewId !== hit.view.id) { setNotice(t('annotate.differentViews')); return }
    const next = [...picks, { viewId: hit.view.id, faceId: hit.faceId }]
    if (next.length < facesNeeded(tool)) { setPicks(next); setNotice(null); return }
    const faces = next.map((p) => resolution.facts(p.faceId))
    const measured = measureFaces(tool, faces)
    if (!measured.ok) { setPicks([]); setNotice(problemText(measured.problem, tool)); return }
    const graphic = dimensionGraphic(tool, hit.view, faces as FaceFacts[], defaultDimensionLabel(tool, hit.view, faces as FaceFacts[]))
    if ('problem' in graphic) { setPicks([]); setNotice(problemText(graphic.problem, tool)); return }
    const revision = views?.revision
    if (revision === undefined) return
    let id = ''
    commit((current, now) => {
      let scratch = current
      const refs = (faces as FaceFacts[]).map((f) => {
        const ref = makeFaceReference(nextDrawingItemId(scratch, 'ref'), current, revision, f)
        scratch = { ...scratch, references: [...scratch.references, ref] }
        return ref
      })
      const made = addDimension(current, { kind: tool, viewId: hit.view.id, references: refs, labelSheetMm: graphic.label, value: measured.value, revision }, now)
      id = made.id
      return made.doc
    })
    setPicks([])
    setNotice(null)
    setSelected(id)
  }

  // ---- dragging labels, balloons and detail views ----
  const startDrag = (e: ReactPointerEvent, kind: DragState['kind'], id: string, orig: Pt): void => {
    if (sheet === undefined || tool !== null || repair !== null) return
    const svg = (e.currentTarget as SVGElement).ownerSVGElement
    if (svg === null) return
    const at = sheetPointOf(svg, sheet.sizeMm, e.clientX, e.clientY)
    if (at === null) return
    e.stopPropagation()
    setDrag({ kind, id, from: at, at, orig })
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (drag === null || sheet === undefined) return
    const at = sheetPointOf(e.currentTarget, sheet.sizeMm, e.clientX, e.clientY)
    if (at !== null) setDrag({ ...drag, at })
  }
  const onPointerUp = (): void => {
    if (drag === null) return
    const d = drag
    setDrag(null)
    const delta: Pt = [d.at[0] - d.from[0], d.at[1] - d.from[1]]
    if (Math.hypot(delta[0], delta[1]) < 0.2) return
    const to: Pt = [d.orig[0] + delta[0], d.orig[1] + delta[1]]
    commit((current, now) => d.kind === 'detail'
      ? moveDetailView(current, d.id, to, now)
      : updateAnnotation(current, d.id, { labelSheetMm: to }, now))
  }
  const dragOffset = (kind: DragState['kind'], id: string): Pt =>
    drag !== null && drag.kind === kind && drag.id === id ? [drag.at[0] - drag.from[0], drag.at[1] - drag.from[1]] : [0, 0]

  // ---- text ----
  const sentence =
    status === 'deleted' ? t('editor.sourceDeleted')
      : status === 'off' ? t('editor.sourceOff')
        : status === 'failed' ? t('editor.sourceFailed')
          : null
  const state = sentence !== null ? (views === undefined ? 'missing' : 'last-known') : phase
  const partLabel = status === 'deleted' ? t('editor.partDeleted') : partName(lineage)
  const unit = sheet?.unit ?? 'mm'

  const dimText = (dim: DrawingDimension, st: DimensionStatus | undefined) => {
    const value = st?.state === 'current' ? st.value : dim.lastGood?.value
    if (value === undefined) return { main: '?' }
    const places = dim.precision ?? sheet?.precision ?? 2
    const table = dim.tolerance.kind === 'general' && doc !== undefined ? generalToleranceValue(effectiveTemplate(doc.template).generalTolerances, dim.measurement, places) : undefined
    return formatDimensionText(dim.measurement, value, unit, places, dim.tolerance, dim.prefix, dim.suffix, table)
  }
  const dimLine = (dim: DrawingDimension, st: DimensionStatus | undefined): string => {
    const text = dimText(dim, st)
    return [text.main, text.upper, text.lower].filter((s) => s !== undefined && s !== '').join(' ')
  }

  const hint = repair !== null
    ? (repair.pick === undefined ? t('annotate.hintRepair', { n: String(repair.index + 1) }) : t('annotate.hintRepairPicked'))
    : tool === null ? null
      : tool === 'balloon' ? t('annotate.hintBalloon')
        : tool === 'detail' ? t(detailClicks.length === 0 ? 'annotate.hintDetail1' : detailClicks.length === 1 ? 'annotate.hintDetail2' : 'annotate.hintDetail3')
          : facesNeeded(tool) === 1 ? t('annotate.hintRound')
            : t(picks.length === 0 ? 'annotate.hintPick1' : 'annotate.hintPick2')

  const highlightFaces: Array<{ viewId: string; faceId: string }> = [...picks, ...(repair?.pick ? [repair.pick] : [])]
  const selectedDim = doc.annotations.find((a): a is DrawingDimension => a.kind === 'dimension' && a.id === selected)
  const selectedBalloon = doc.annotations.find((a) => a.kind === 'balloon' && a.id === selected)
  const selectedDetail = sheet?.views.find((v) => v.id === selected && v.detail !== undefined)
  const dims = doc.annotations.filter((a): a is DrawingDimension => a.kind === 'dimension')

  return (
    <div className="drawing-editor" data-testid="drawing-editor" data-drawing-id={doc.id} data-model-item={modelItemId} role="region" aria-label={t('editor.label')}>
      <div className="drawing-editor-bar">
        <div className="drawing-editor-switch" role="group">
          <button type="button" data-testid="drawing-switch-model" title={t('editor.backToModel')} onClick={() => setOpenDrawing(modelItemId, null)}>{t('editor.model')}</button>
          <button type="button" className="is-active" aria-pressed="true" data-testid="drawing-switch-drawing">{t('editor.drawing')}</button>
        </div>
        <nav className="drawing-editor-crumbs" data-testid="drawing-breadcrumb">
          <button type="button" className="drawing-editor-link" title={t('editor.breadcrumbTip')} onClick={() => setOpenDrawing(modelItemId, null)}>{partLabel}</button>
          <span aria-hidden="true">{' > '}</span>
          <span className="drawing-editor-name">{doc.name}</span>
        </nav>
        {sheet !== undefined && (
          <label className="drawing-editor-size">
            {t('editor.sheetSize')}{' '}
            <select
              data-testid="drawing-sheet-size"
              value={size ?? ''}
              onChange={(e) => changeSize(e.target.value as DrawingSheetSizeName)}
            >
              {size === null && <option value="">{t('editor.otherSize', { width: String(sheet.sizeMm[0]), height: String(sheet.sizeMm[1]) })}</option>}
              <option value="letter">{t('editor.letter')}</option>
              <option value="a4">{t('editor.a4')}</option>
            </select>
          </label>
        )}
      </div>
      <div className="drawing-editor-tools" role="toolbar" aria-label={t('annotate.toolbar')}>
        {(Object.keys(TOOL_TEXT) as Tool[]).map((k) => (
          <button
            key={k}
            type="button"
            className={tool === k ? 'is-active' : undefined}
            aria-pressed={tool === k}
            data-testid={`drawing-tool-${k}`}
            title={t(TOOL_TEXT[k][1])}
            onClick={() => chooseTool(k)}
          >
            {t(TOOL_TEXT[k][0])}
          </button>
        ))}
        <span className="drawing-editor-tools-gap" />
        <button type="button" data-testid="drawing-export-pdf" disabled={sheet === undefined} title={t('export.pdfTip')} onClick={() => { void exportSheet('pdf') }}>{t('export.pdf')}</button>
        <button type="button" data-testid="drawing-export-dxf" disabled={sheet === undefined} title={t('export.dxfTip')} onClick={() => { void exportSheet('dxf') }}>{t('export.dxf')}</button>
        {hasLogo && <button type="button" data-testid="drawing-export-dxf-logo" disabled={sheet === undefined} title={t('export.dxfLogoTip')} onClick={() => { void exportSheet('dxf-logo') }}>{t('export.dxfLogo')}</button>}
        <button type="button" data-testid="drawing-undo" disabled={history.past.length === 0} title={t('annotate.undoTip')} onClick={undo}>{t('annotate.undo')}</button>
        <button type="button" data-testid="drawing-redo" disabled={history.future.length === 0} title={t('annotate.redoTip')} onClick={redo}>{t('annotate.redo')}</button>
      </div>
      <div className="drawing-editor-status" data-testid="drawing-status" data-state={state} role="status">
        {sentence !== null
          ? <>{sentence} {views === undefined ? t('editor.noViewsYet') : t('editor.lastKnown')}</>
          : phase === 'error'
            ? <>{t('editor.projectionFailed', { reason: problem ?? '' })} {views !== undefined ? t('editor.lastKnown') : ''}</>
            : phase === 'updating' ? t('editor.updating')
              : phase === 'waiting' ? t('editor.waiting')
                : <>{t('editor.current')}. {t('editor.approximate')}</>}
      </div>
      {(hint !== null || notice !== null) && (
        <div className="drawing-editor-hint" data-testid="drawing-hint" role="status">
          {notice !== null ? <span className="drawing-editor-notice" data-testid="drawing-notice">{notice}</span> : hint}
          {(tool !== null || repair !== null) && (
            <button type="button" className="drawing-editor-link" data-testid="drawing-tool-cancel" onClick={cancelAll}>{t('annotate.stop')}</button>
          )}
        </div>
      )}
      <div className="drawing-editor-body">
        <div className="drawing-editor-paper">
          {sheet !== undefined && (
            <svg
              className={`drawing-sheet${state === 'missing' || state === 'last-known' ? ' is-stale' : ''}${tool !== null || repair !== null ? ' is-picking' : ''}`}
              data-testid="drawing-sheet"
              data-sheet-size={size ?? 'other'}
              data-geometry={views?.geometryFingerprint ?? ''}
              viewBox={`0 0 ${sheet.sizeMm[0]} ${sheet.sizeMm[1]}`}
              preserveAspectRatio="xMidYMid meet"
              onClick={onSheetClick}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              <rect className="drawing-sheet-paper" x={0} y={0} width={sheet.sizeMm[0]} height={sheet.sizeMm[1]} />
              <rect className="drawing-sheet-frame" x={sheet.marginsMm} y={sheet.marginsMm} width={sheet.sizeMm[0] - 2 * sheet.marginsMm} height={sheet.sizeMm[1] - 2 * sheet.marginsMm} />
              {sheet.views.map((view) => (
                <SheetView
                  key={view.id}
                  view={view}
                  sheet={sheet}
                  lines={(() => { const s = sceneFor(views, view); return s === undefined ? [] : toSheet(s, view.scale, view.sheetOriginMm) })()}
                  offset={dragOffset('detail', view.id)}
                  selected={selected === view.id}
                  label={view.frame.name !== undefined && view.detail === undefined ? t(VIEW_LABEL_KEYS[view.frame.name]) : t('annotate.detailLabel', { label: view.label ?? '', numerator: String(view.detail?.magnification.numerator ?? 1), denominator: String(view.detail?.magnification.denominator ?? 1) })}
                  onSelect={() => { if (tool === null && repair === null) setSelected(view.id) }}
                  onDragStart={(e) => { const c = detailCircle(view); if (c !== undefined) startDrag(e, 'detail', view.id, c.center) }}
                />
              ))}
              {sheet.views.filter((v) => v.detail !== undefined).map((v) => {
                const parent = sheet.views.find((p) => p.id === v.detail?.parentViewId)
                const c = parent === undefined ? undefined : detailCircleOnParent(v, parent)
                if (c === undefined) return null
                return (
                  <g key={`crop-${v.id}`} data-testid={`drawing-detail-crop-${v.id}`}>
                    <circle className="drawing-detail-crop" cx={c.center[0]} cy={c.center[1]} r={c.radius} />
                    <text className="drawing-detail-letter" x={c.center[0] + c.radius * 0.72 + 1} y={c.center[1] - c.radius * 0.72 - 1}>{v.label}</text>
                  </g>
                )
              })}
              {views !== undefined && highlightFaces.map((p, i) => {
                const view = sheet.views.find((v) => v.id === p.viewId)
                if (view === undefined) return null
                return (
                  <g key={`pick-${i}`} className="drawing-pick" data-testid={`drawing-pick-${i}`} data-face={p.faceId}>
                    {faceOnSheet(view, views.faces, p.faceId).map((tri, j) => (
                      <polygon key={j} points={tri.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ')} />
                    ))}
                  </g>
                )
              })}
              {dims.map((dim) => {
                const st = resolution.statuses.get(dim.id)
                const view = sheet.views.find((v) => v.id === dim.viewId)
                if (view === undefined) return null
                const off = dragOffset('dimension', dim.id)
                const base = dim.labelSheetMm ?? view.sheetOriginMm
                const label: Pt = [base[0] + off[0], base[1] + off[1]]
                const graphic = st?.state === 'current' && st.faces !== undefined ? dimensionGraphic(dim.measurement, view, st.faces, label) : null
                const text = dimText(dim, st)
                return (
                  <g
                    key={dim.id}
                    className={`drawing-dim${st?.state === 'current' ? '' : ' is-broken'}${selected === dim.id ? ' is-selected' : ''}`}
                    data-testid={`drawing-dim-${dim.id}`}
                    data-state={st?.state ?? 'updating'}
                    data-value={st?.state === 'current' && st.value !== undefined ? String(st.value) : ''}
                    data-text={dimLine(dim, st)}
                  >
                    {graphic !== null && !('problem' in graphic) && (
                      <>
                        {graphic.lines.map(([a, b], i) => <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />)}
                        {graphic.arrows.map((ar, i) => <Arrow key={`a${i}`} tip={ar.tip} dir={ar.dir} />)}
                      </>
                    )}
                    <text
                      className="drawing-dim-text"
                      data-testid={`drawing-dim-label-${dim.id}`}
                      x={label[0]}
                      y={label[1] - 0.8}
                      textAnchor="middle"
                      onPointerDown={(e) => startDrag(e, 'dimension', dim.id, base)}
                      onClick={(e) => { if (tool === null && repair === null) { e.stopPropagation(); setSelected(dim.id) } }}
                    >
                      {st?.state !== 'current' && <tspan className="drawing-dim-flag">{'! '}</tspan>}
                      {text.main}
                      {text.upper !== undefined && <tspan className="drawing-dim-tol" dx={0.8} dy={-1.3}>{text.upper}</tspan>}
                      {text.lower !== undefined && <tspan className="drawing-dim-tol" dx={-(text.upper?.length ?? 0) * 1.2} dy={2.6}>{text.lower}</tspan>}
                    </text>
                  </g>
                )
              })}
              {doc.annotations.map((a) => {
                if (a.kind !== 'balloon') return null
                const off = dragOffset('balloon', a.id)
                const base = a.labelSheetMm ?? [a.anchorSheetMm[0] + 10, a.anchorSheetMm[1] - 10]
                const c: Pt = [base[0] + off[0], base[1] + off[1]]
                const r = 3.5
                const dir: Pt = [a.anchorSheetMm[0] - c[0], a.anchorSheetMm[1] - c[1]]
                const len = Math.hypot(dir[0], dir[1]) || 1
                const edge: Pt = [c[0] + (dir[0] / len) * r, c[1] + (dir[1] / len) * r]
                return (
                  <g key={a.id} className={`drawing-balloon${selected === a.id ? ' is-selected' : ''}`} data-testid={`drawing-balloon-${a.id}`} data-number={a.number}>
                    {len > r && <line x1={edge[0]} y1={edge[1]} x2={a.anchorSheetMm[0]} y2={a.anchorSheetMm[1]} />}
                    <circle className="drawing-balloon-dot" cx={a.anchorSheetMm[0]} cy={a.anchorSheetMm[1]} r={0.5} />
                    <circle
                      className="drawing-balloon-ring"
                      cx={c[0]}
                      cy={c[1]}
                      r={r}
                      onPointerDown={(e) => startDrag(e, 'balloon', a.id, base)}
                      onClick={(e) => { if (tool === null && repair === null) { e.stopPropagation(); setSelected(a.id) } }}
                    />
                    <text className="drawing-balloon-text" x={c[0]} y={c[1] + 1.1} textAnchor="middle">{a.number}</text>
                  </g>
                )
              })}
              <TitleBlock doc={doc} sheet={sheet} partName={partLabel} />
            </svg>
          )}
        </div>
        <aside className="drawing-editor-panel" data-testid="drawing-panel" aria-label={t('annotate.panel')}>
          {repair !== null && (
            <RepairBox
              doc={doc}
              repair={repair}
              status={resolution.statuses.get(repair.dimId)}
              facts={resolution.facts}
              unit={unit}
              precision={sheet?.precision ?? 2}
              revision={views?.revision}
              onCancel={() => { setRepair(null); setNotice(null) }}
              onAccept={(dimId, index, ref) => {
                commit((current, now) => reassociateDimension(current, dimId, index, ref, now))
                setRepair(null)
                setNotice(null)
              }}
            />
          )}
          <section className="drawing-panel-section" data-testid="drawing-dim-list">
            <h3>{t('annotate.dimensions')}</h3>
            {dims.length === 0 && <div className="drawing-panel-empty">{t('annotate.noDimensions')}</div>}
            {dims.map((dim) => {
              const st = resolution.statuses.get(dim.id)
              return (
                <button
                  key={dim.id}
                  type="button"
                  className={`drawing-dim-row${selected === dim.id ? ' is-selected' : ''}`}
                  data-testid={`drawing-dim-row-${dim.id}`}
                  data-state={st?.state ?? 'updating'}
                  onClick={() => setSelected(dim.id)}
                >
                  <span className="drawing-dim-row-text">{dimLine(dim, st)}</span>
                  <span className={`drawing-dim-chip is-${st?.state ?? 'updating'}`}>{t(`annotate.state_${st?.state ?? 'updating'}` as 'annotate.state_current')}</span>
                </button>
              )
            })}
          </section>
          {selectedDim !== undefined && sheet !== undefined && (
            <DimensionPanel
              key={selectedDim.id}
              doc={doc}
              dim={selectedDim}
              sheet={sheet}
              status={resolution.statuses.get(selectedDim.id)}
              text={dimLine(selectedDim, resolution.statuses.get(selectedDim.id))}
              commit={commit}
              onRepair={(index) => { setTool(null); setPicks([]); setNotice(null); setRepair({ dimId: selectedDim.id, index }) }}
              onDeleted={() => setSelected(null)}
            />
          )}
          {selectedBalloon !== undefined && selectedBalloon.kind === 'balloon' && (
            <section className="drawing-panel-section" data-testid="drawing-balloon-panel">
              <h3>{t('annotate.balloon')}</h3>
              <label className="drawing-panel-field">
                {t('annotate.balloonNumber')}
                <CommitInput
                  testId="drawing-balloon-number"
                  value={String(selectedBalloon.number)}
                  type="number"
                  onCommit={(v) => {
                    const n = Number.parseInt(v, 10)
                    if (Number.isInteger(n) && n > 0 && n !== selectedBalloon.number) commit((current, now) => updateAnnotation(current, selectedBalloon.id, { number: n }, now))
                  }}
                />
              </label>
              <button type="button" data-testid="drawing-balloon-delete" onClick={() => { commit((current, now) => removeAnnotations(current, [selectedBalloon.id], now)); setSelected(null) }}>{t('annotate.delete')}</button>
            </section>
          )}
          {selectedDetail?.detail !== undefined && (
            <section className="drawing-panel-section" data-testid="drawing-detail-panel">
              <h3>{t('annotate.detailTitle', { label: selectedDetail.label ?? '' })}</h3>
              <label className="drawing-panel-field">
                {t('annotate.magnification')}
                <select
                  data-testid="drawing-detail-mag"
                  value={`${selectedDetail.detail.magnification.numerator}:${selectedDetail.detail.magnification.denominator}`}
                  onChange={(e) => {
                    const [n, d] = e.target.value.split(':').map(Number)
                    commit((current, now) => setDetailMagnification(current, selectedDetail.id, { numerator: n, denominator: d }, now))
                  }}
                >
                  {MAGNIFICATIONS.map(([n, d]) => <option key={`${n}:${d}`} value={`${n}:${d}`}>{`${n}:${d}`}</option>)}
                </select>
              </label>
              <div className="drawing-panel-note">{t('annotate.detailNote')}</div>
              <button
                type="button"
                data-testid="drawing-detail-delete"
                title={t('annotate.detailDeleteTip', { count: doc.annotations.filter((a) => (a.kind === 'dimension' || a.kind === 'balloon') && a.viewId === selectedDetail.id).length })}
                onClick={() => { commit((current, now) => removeDetailView(current, selectedDetail.id, now)); setSelected(null) }}
              >
                {t('annotate.delete')}
              </button>
            </section>
          )}
          {sheet !== undefined && <TemplatePanel doc={doc} sheet={sheet} partName={partLabel} commit={commit} />}
        </aside>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sheet pieces
// ---------------------------------------------------------------------------

function Arrow({ tip, dir }: { tip: Pt; dir: Pt }) {
  const len = 2.5, half = 0.7
  const back: Pt = [tip[0] - dir[0] * len, tip[1] - dir[1] * len]
  const n: Pt = [-dir[1] * half, dir[0] * half]
  return <polygon className="drawing-dim-arrow" points={`${tip[0]},${tip[1]} ${back[0] + n[0]},${back[1] + n[1]} ${back[0] - n[0]},${back[1] - n[1]}`} />
}

function SheetView({ view, sheet, lines, offset, selected, label, onSelect, onDragStart }: {
  view: DrawingView
  sheet: DrawingSheet
  lines: SheetLine[]
  offset: Pt
  selected: boolean
  label: string
  onSelect(): void
  onDragStart(e: ReactPointerEvent): void
}) {
  const crop = detailCircle(view)
  const name = view.frame.name
  // The label sits just under the view's own lines (Slice C's fixed offset put
  // Front and Right low, Right touching the title block).
  let bottom = -Infinity
  for (const l of lines) for (const [, y] of l.points) bottom = Math.max(bottom, y)
  const fallback = view.sheetOriginMm[1] + (sheet.sizeMm[1] - 2 * sheet.marginsMm - DRAWING_TITLE_BAND_MM) / 4 - 1
  const transform = offset[0] !== 0 || offset[1] !== 0 ? `translate(${offset[0]} ${offset[1]})` : undefined
  if (crop !== undefined) {
    const clipId = `drawing-clip-${sheet.id}-${view.id}`
    return (
      <g data-testid={`drawing-view-${view.id}`} data-lines={lines.length} className={selected ? 'is-selected' : undefined} transform={transform}>
        <clipPath id={clipId}><circle cx={crop.center[0]} cy={crop.center[1]} r={crop.radius} /></clipPath>
        <g clipPath={`url(#${clipId})`}>
          {lines.map((line, i) => <polyline key={i} className={line.visibility === 'visible' ? 'drawing-line-visible' : 'drawing-line-hidden'} points={line.points.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ')} />)}
        </g>
        <circle className="drawing-detail-border" cx={crop.center[0]} cy={crop.center[1]} r={crop.radius} onPointerDown={onDragStart} onClick={(e) => { e.stopPropagation(); onSelect() }} />
        <text className="drawing-view-label" data-testid={`drawing-detail-label-${view.id}`} x={crop.center[0]} y={crop.center[1] + crop.radius + 4} textAnchor="middle" onPointerDown={onDragStart} onClick={(e) => { e.stopPropagation(); onSelect() }}>{label}</text>
      </g>
    )
  }
  const labelY = Number.isFinite(bottom) ? Math.min(bottom + 5, sheet.sizeMm[1] - sheet.marginsMm - DRAWING_TITLE_BAND_MM - 1) : fallback
  return (
    <g data-testid={`drawing-view-${name ?? view.id}`} data-lines={lines.length}>
      {lines.map((line, i) => (
        <polyline
          key={i}
          className={line.visibility === 'visible' ? 'drawing-line-visible' : 'drawing-line-hidden'}
          points={line.points.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ')}
        />
      ))}
      {name !== undefined && (
        <text className="drawing-view-label" x={view.sheetOriginMm[0]} y={labelY} textAnchor="middle">{label}</text>
      )}
    </g>
  )
}

function TitleBlock({ doc, sheet, partName }: { doc: DrawingDocument; sheet: DrawingSheet; partName: string }) {
  const t = useText('technical-drawings')
  const [x, y, w, h] = titleBlockRect(sheet.sizeMm, sheet.marginsMm)
  const [tx, ty, tw, th] = toleranceBlockRect(sheet.sizeMm, sheet.marginsMm)
  const template = effectiveTemplate(doc.template)
  const values = titleBlockValues(doc, partName)
  const gt = template.generalTolerances
  const rows = Object.entries(gt.linearByDecimalPlaces).sort((a, b) => Number(a[0]) - Number(b[0]))
  const fmt = (v: number): string => (sheet.unit === 'inch' ? (v / 25.4).toFixed(4) : String(v))
  return (
    <>
      <g className="drawing-title" data-testid="drawing-title-block">
        <rect className="drawing-sheet-frame" x={x} y={y} width={w} height={h} />
        {values.map((f) => (
          <g key={f.key} data-testid={`drawing-title-${f.key}`} data-text={f.text} data-overridden={f.overridden ? 'true' : 'false'}>
            <rect className="drawing-title-cell" x={x + f.rectMm[0]} y={y + f.rectMm[1]} width={f.rectMm[2]} height={f.rectMm[3]} />
            <text className="drawing-title-caption" x={x + f.rectMm[0] + 0.6} y={y + f.rectMm[1] + 1.6}>{t(`template.field_${f.key}` as 'template.field_title')}{f.overridden ? ' *' : ''}</text>
            <text className={f.key === 'title' ? 'drawing-title-name' : 'drawing-title-text'} x={x + f.rectMm[0] + 0.8} y={y + f.rectMm[1] + f.rectMm[3] - 0.9}>{f.text}</text>
          </g>
        ))}
        <text className="drawing-title-caption" x={x + 56} y={y + 32.6}>{t('editor.projection')}{sheet.unit === 'inch' ? ` (${t('template.inch')})` : ''}</text>
      </g>
      <g className="drawing-tolerance-block" data-testid="drawing-tolerance-block">
        <rect className="drawing-sheet-frame" x={tx} y={ty} width={tw} height={th} />
        <text className="drawing-title-text" x={tx + 2} y={ty + 5}>{t('template.generalLabel', { unit: sheet.unit === 'inch' ? t('annotate.unitInch') : t('annotate.unitMm') })}</text>
        {rows.map(([places, v], i) => (
          <text key={places} className="drawing-title-text" data-testid={`drawing-tolerance-row-${places}`} x={tx + 2 + (i % 2) * 68} y={ty + 11 + Math.floor(i / 2) * 6}>
            {t('template.rowLinear', { example: places === '0' ? 'X' : `X.${'X'.repeat(Number(places))}`, value: fmt(v) })}
          </text>
        ))}
        <text className="drawing-title-text" data-testid="drawing-tolerance-row-angle" x={tx + 2} y={ty + 11 + Math.ceil(rows.length / 2) * 6}>
          {t('template.rowAngle', { value: String(gt.angularDegrees) })}
        </text>
      </g>
    </>
  )
}

// ---------------------------------------------------------------------------
// Panel pieces
// ---------------------------------------------------------------------------

/** A text field that commits once, on blur or Enter (one Undo step per change, not per key). */
function CommitInput({ value, onCommit, testId, type = 'text', placeholder }: { value: string; onCommit(v: string): void; testId: string; type?: 'text' | 'number'; placeholder?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      data-testid={testId}
      type={type}
      step={type === 'number' ? 'any' : undefined}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onCommit(draft) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
    />
  )
}

type Commit = (make: (current: DrawingDocument, now: string) => DrawingDocument) => DrawingDocument | undefined

function DimensionPanel({ doc, dim, sheet, status, text, commit, onRepair, onDeleted }: {
  doc: DrawingDocument
  dim: DrawingDimension
  sheet: DrawingSheet
  status: DimensionStatus | undefined
  text: string
  commit: Commit
  onRepair(index: number): void
  onDeleted(): void
}) {
  const t = useText('technical-drawings')
  const isAngle = dim.measurement === 'angle'
  const toDisplay = (v: number): number => (isAngle || sheet.unit === 'mm' ? v : v / 25.4)
  const fromDisplay = (v: number): number => (isAngle || sheet.unit === 'mm' ? v : v * 25.4)
  const unitWord = isAngle ? t('annotate.unitDeg') : sheet.unit === 'inch' ? t('annotate.unitInch') : t('annotate.unitMm')
  const value = status?.state === 'current' ? status.value : dim.lastGood?.value
  const tol = dim.tolerance
  const setTol = (next: DrawingToleranceIntent): void => { commit((current, now) => updateAnnotation(current, dim.id, { tolerance: next }, now)) }
  const changeKind = (kind: DrawingToleranceIntent['kind']): void => {
    if (kind === tol.kind) return
    const step = isAngle ? 0.5 : 0.1
    if (kind === 'none' || kind === 'reference') setTol({ kind })
    else if (kind === 'bilateral') setTol({ kind, upper: step, lower: -step })
    else if (kind === 'limits') setTol({ kind, lower: (value ?? 0) - step, upper: (value ?? 0) + step })
    else setTol(generalToleranceFor(doc, dim, sheet.precision))
  }
  const num = (raw: string): number | null => { const v = Number(raw); return raw.trim() !== '' && Number.isFinite(v) ? v : null }
  const update = generalToleranceUpdate(doc, dim, sheet.precision)
  const sentenceKey = statusKey(status?.state ?? 'updating', status?.reason)
  const refCount = dim.referenceIds.length
  return (
    <section className="drawing-panel-section" data-testid="drawing-dim-panel" data-dimension={dim.id}>
      <h3>{t(`annotate.kind_${dim.measurement}` as 'annotate.kind_linear')}</h3>
      <div className="drawing-panel-value" data-testid="drawing-dim-value">{text}</div>
      <div className={`drawing-panel-status is-${status?.state ?? 'updating'}`} data-testid="drawing-dim-status" data-state={status?.state ?? 'updating'}>
        {t(sentenceKey)}
        {status?.state !== 'current' && dim.lastGood !== undefined && (
          <> {t('annotate.lastGood', { value: `${toDisplay(dim.lastGood.value).toFixed(dim.precision ?? sheet.precision)} ${unitWord}` })}</>
        )}
      </div>
      <label className="drawing-panel-field">
        {t('annotate.tolerance')}
        <select data-testid="drawing-tol-kind" value={tol.kind} onChange={(e) => changeKind(e.target.value as DrawingToleranceIntent['kind'])}>
          <option value="none">{t('annotate.tolNone')}</option>
          <option value="general">{t('annotate.tolGeneral')}</option>
          <option value="bilateral">{t('annotate.tolBilateral')}</option>
          <option value="limits">{t('annotate.tolLimits')}</option>
          <option value="reference">{t('annotate.tolReference')}</option>
        </select>
      </label>
      {tol.kind === 'bilateral' && (
        <div className="drawing-panel-row">
          <label className="drawing-panel-field">{t('annotate.tolUpper', { unit: unitWord })}
            <CommitInput testId="drawing-tol-upper" type="number" value={String(Number(toDisplay(tol.upper).toFixed(6)))} onCommit={(v) => { const n = num(v); if (n !== null) setTol({ ...tol, upper: fromDisplay(n) }) }} />
          </label>
          <label className="drawing-panel-field">{t('annotate.tolLower', { unit: unitWord })}
            <CommitInput testId="drawing-tol-lower" type="number" value={String(Number(toDisplay(tol.lower).toFixed(6)))} onCommit={(v) => { const n = num(v); if (n !== null) setTol({ ...tol, lower: fromDisplay(n) }) }} />
          </label>
        </div>
      )}
      {tol.kind === 'limits' && (
        <div className="drawing-panel-row">
          <label className="drawing-panel-field">{t('annotate.limitUpper', { unit: unitWord })}
            <CommitInput testId="drawing-tol-upper" type="number" value={String(Number(toDisplay(tol.upper).toFixed(6)))} onCommit={(v) => { const n = num(v); if (n !== null) setTol({ ...tol, upper: fromDisplay(n) }) }} />
          </label>
          <label className="drawing-panel-field">{t('annotate.limitLower', { unit: unitWord })}
            <CommitInput testId="drawing-tol-lower" type="number" value={String(Number(toDisplay(tol.lower).toFixed(6)))} onCommit={(v) => { const n = num(v); if (n !== null) setTol({ ...tol, lower: fromDisplay(n) }) }} />
          </label>
        </div>
      )}
      {tol.kind === 'general' && (
        <div className="drawing-panel-note" data-testid="drawing-tol-general">
          {tol.value !== undefined ? t('annotate.generalPinned', { value: `${toDisplay(tol.value)} ${unitWord}`, revision: tol.templateRevision }) : t('annotate.generalNoRow')}
          {update !== null && (
            <button type="button" className="drawing-editor-link" data-testid="drawing-tol-update" onClick={() => setTol(update)}>
              {t('annotate.generalUpdate', { value: update.kind === 'general' && update.value !== undefined ? `${toDisplay(update.value)} ${unitWord}` : '-' })}
            </button>
          )}
        </div>
      )}
      <label className="drawing-panel-field">
        {t('annotate.precision')}
        <select
          data-testid="drawing-dim-precision"
          value={dim.precision === undefined ? '' : String(dim.precision)}
          onChange={(e) => commit((current, now) => updateAnnotation(current, dim.id, { precision: e.target.value === '' ? undefined : Number(e.target.value) }, now))}
        >
          <option value="">{t('annotate.precisionSheet', { places: String(sheet.precision) })}</option>
          {[0, 1, 2, 3, 4].map((p) => <option key={p} value={String(p)}>{t('annotate.precisionPlaces', { places: String(p) })}</option>)}
        </select>
      </label>
      <div className="drawing-panel-row">
        {Array.from({ length: refCount }, (_, i) => (
          <button key={i} type="button" data-testid={`drawing-repair-${i}`} title={t('annotate.repairTip')} onClick={() => onRepair(i)}>
            {refCount === 1 ? t('annotate.repairOne') : t('annotate.repairEnd', { n: String(i + 1) })}
          </button>
        ))}
        <button type="button" data-testid="drawing-dim-delete" onClick={() => { commit((current, now) => removeAnnotations(current, [dim.id], now)); onDeleted() }}>{t('annotate.delete')}</button>
      </div>
      {(dim.repairs?.length ?? 0) > 0 && <div className="drawing-panel-note" data-testid="drawing-dim-repairs">{t('annotate.repaired', { count: dim.repairs?.length ?? 0 })}</div>}
    </section>
  )
}

function RepairBox({ doc, repair, status, facts, unit, precision, revision, onCancel, onAccept }: {
  doc: DrawingDocument
  repair: RepairState
  status: DimensionStatus | undefined
  facts(id: string): FaceFacts | undefined
  unit: 'mm' | 'inch'
  precision: number
  revision: SourceRevision | undefined
  onCancel(): void
  onAccept(dimId: string, index: number, ref: ReturnType<typeof makeFaceReference>): void
}) {
  const t = useText('technical-drawings')
  const dim = doc.annotations.find((a): a is DrawingDimension => a.kind === 'dimension' && a.id === repair.dimId)
  if (dim === undefined) return null
  const p = dim.precision ?? precision
  const show = (v: number | undefined): string => (v === undefined ? '-' : formatDimensionText(dim.measurement, v, unit, p, { kind: 'none' }).main)
  const oldValue = status?.state === 'current' ? status.value : dim.lastGood?.value
  // The new value: the picked face with every other end as it resolves now. When
  // another end has no face either, this end is still saved on its own (the
  // dimension stays missing until every end is good); only a face of the wrong
  // shape for this kind is refused.
  let newValue: number | undefined
  let blocked: string | null = null
  let otherEndOpen = false
  if (repair.pick !== undefined) {
    const picked = facts(repair.pick.faceId)
    const ends = dim.referenceIds.map((_, i) => {
      if (i === repair.index) return picked
      const r = status?.references[i]
      return r?.state === 'current' ? facts(r.resolvedIds[0]) : undefined
    })
    const round = dim.measurement === 'radius' || dim.measurement === 'diameter'
    const m = measureFaces(dim.measurement, ends)
    const problem = m.ok ? null
      : m.problem !== 'no-geometry' ? m.problem
        : picked === undefined ? 'no-geometry'
          : round ? null
            : picked.surfaceType !== 'plane' || picked.normal === undefined ? 'needs-plane' : null
    if (m.ok) newValue = m.value
    else if (problem === null) otherEndOpen = true
    else blocked = t(PROBLEM_KEYS[problem] as 'annotate.problemNeedsPlane', { kind: t(TOOL_TEXT[dim.measurement][0]) })
  }
  const accept = (): void => {
    if (repair.pick === undefined || revision === undefined || (newValue === undefined && !otherEndOpen)) return
    const f = facts(repair.pick.faceId)
    if (f === undefined) return
    onAccept(dim.id, repair.index, makeFaceReference(nextDrawingItemId(doc, 'ref'), doc, revision, f))
  }
  return (
    <section className="drawing-panel-section drawing-repair" data-testid="drawing-repair">
      <h3>{t('annotate.repairTitle', { n: String(repair.index + 1) })}</h3>
      <div className="drawing-repair-compare">
        <div><span>{t('annotate.repairWas')}</span> <strong data-testid="drawing-repair-old">{show(oldValue)}</strong></div>
        <div><span>{t('annotate.repairNew')}</span> <strong data-testid="drawing-repair-new">{repair.pick === undefined ? t('annotate.repairPickFirst') : show(newValue)}</strong></div>
      </div>
      {blocked !== null && <div className="drawing-editor-notice" data-testid="drawing-repair-problem">{blocked}</div>}
      {otherEndOpen && <div className="drawing-panel-note" data-testid="drawing-repair-other-end">{t('annotate.repairOtherEnd')}</div>}
      <div className="drawing-panel-row">
        <button type="button" data-testid="drawing-repair-accept" disabled={newValue === undefined && !otherEndOpen} onClick={accept}>{t('annotate.repairAccept')}</button>
        <button type="button" data-testid="drawing-repair-cancel" onClick={onCancel}>{t('annotate.repairCancel')}</button>
      </div>
    </section>
  )
}

function TemplatePanel({ doc, sheet, partName, commit }: { doc: DrawingDocument; sheet: DrawingSheet; partName: string; commit: Commit }) {
  const t = useText('technical-drawings')
  const template = effectiveTemplate(doc.template)
  const values = titleBlockValues(doc, partName)
  const zone = template.dateDisplayZone
  const gt = template.generalTolerances
  const field = (key: TitleFieldKey): ReactNode => (
    <label key={key} className="drawing-panel-field">
      {t(`template.field_${key}` as 'template.field_title')}
      <CommitInput testId={`drawing-field-${key}`} value={template.fields[key] ?? ''} onCommit={(v) => commit((current, now) => setTemplateField(current, key, v, now))} />
    </label>
  )
  const bound = (key: TitleFieldKey): ReactNode => {
    const v = values.find((x) => x.key === key)
    const autoText = key === 'title' ? partName
      : key === 'created' ? formatDrawingDate(doc.createdAt, zone)
        : key === 'drawingEdited' ? formatDrawingDate(doc.editedAt, zone)
          : formatDrawingDate(doc.sourceEditedAt, zone)
    return (
      <label key={key} className="drawing-panel-field">
        {t(`template.field_${key}` as 'template.field_title')}{v?.overridden ? ` (${t('template.overridden')})` : ''}
        <CommitInput
          testId={`drawing-override-${key}`}
          value={template.overrides[key] ?? ''}
          placeholder={autoText === '' ? t('template.notYet') : autoText}
          onCommit={(text) => commit((current, now) => setTemplateOverride(current, key, text === '' ? null : text, now))}
        />
      </label>
    )
  }
  const setRow = (places: string, raw: string): void => {
    const v = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(v) || v < 0) return
    commit((current, now) => setGeneralTolerances(current, { ...gt, linearByDecimalPlaces: { ...gt.linearByDecimalPlaces, [places]: v } }, now))
  }
  return (
    <section className="drawing-panel-section" data-testid="drawing-title-panel">
      <h3>{t('template.title')}</h3>
      {LITERAL_TITLE_FIELDS.map(field)}
      {BOUND_TITLE_FIELDS.map(bound)}
      <div className="drawing-panel-note">{t('template.overrideNote')}</div>
      <h3>{t('template.generalTitle')}</h3>
      <div className="drawing-panel-grid">
        {Object.keys(gt.linearByDecimalPlaces).sort().map((places) => (
          <label key={places} className="drawing-panel-field">
            {t('template.rowField', { places })}
            <CommitInput testId={`drawing-gt-${places}`} type="number" value={String(gt.linearByDecimalPlaces[places])} onCommit={(v) => setRow(places, v)} />
          </label>
        ))}
        <label className="drawing-panel-field">
          {t('template.angleField')}
          <CommitInput
            testId="drawing-gt-angle"
            type="number"
            value={String(gt.angularDegrees)}
            onCommit={(raw) => { const v = Number(raw); if (raw.trim() !== '' && Number.isFinite(v) && v >= 0) commit((current, now) => setGeneralTolerances(current, { ...gt, angularDegrees: v }, now)) }}
          />
        </label>
      </div>
      <div className="drawing-panel-note">{t('template.generalNote')}</div>
      <h3>{t('template.sheetTitle')}</h3>
      <div className="drawing-panel-row">
        <label className="drawing-panel-field">
          {t('template.unit')}
          <select data-testid="drawing-sheet-unit" value={sheet.unit} onChange={(e) => commit((current, now) => setSheetUnits(current, sheet.id, e.target.value as 'mm' | 'inch', sheet.precision, now))}>
            <option value="mm">{t('annotate.unitMm')}</option>
            <option value="inch">{t('annotate.unitInch')}</option>
          </select>
        </label>
        <label className="drawing-panel-field">
          {t('template.precision')}
          <select data-testid="drawing-sheet-precision" value={String(sheet.precision)} onChange={(e) => commit((current, now) => setSheetUnits(current, sheet.id, sheet.unit, Number(e.target.value), now))}>
            {[0, 1, 2, 3, 4].map((p) => <option key={p} value={String(p)}>{t('annotate.precisionPlaces', { places: String(p) })}</option>)}
          </select>
        </label>
      </div>
    </section>
  )
}
