// Form - form mode inside the Model screen (Operator ruling 2026-09-27: "the modeling
// workspace is where modeling happens, regardless of style").
//
// "Form" on the Model rail opens form mode: the cage and its smooth skin are
// drawn in the Model screen's own scene, the rail shows the form tools, and
// the Form palette holds Finish / Cancel. Finish commits ONE Model-history
// feature (opType 'form', payload = the cage); editing that feature from the
// tree reopens form mode on its cage, and Finish then edits the same node.
// Form undo (whole-cage snapshots) lives only while form mode is open; the
// Model history gets one step per Finish.

import { useText } from '../../../i18n'
import { useCallback, useEffect, useRef } from 'react'
import { Box, Circle, Copy, Cylinder, Link, Dot, Donut, Magnet, Expand, Shrink, SquareDashedMousePointer, PenTool, SquarePlus, LocateFixed, Spline, Target, Grid3x3, Merge, Route, Eye, Import, Unlink, RectangleHorizontal, Ruler, Grip, ArrowUpFromLine, Rotate3d, FlipHorizontal2, FlipVertical2, FoldHorizontal, Grid2x2, Layers, Link2, Move, Redo2, Repeat2, RotateCw, Rows3, Rows4, Scaling, SeparatorHorizontal, Slash, Square, SquareDashed, Sun, Trash2, Undo2, Waves } from 'lucide-react'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { useFormStore } from '../../../form/formStore'
import { FormOverlay } from '../../../form/formOverlay'
import { isFormFeaturePayload, makeFormFeaturePayload } from '../../../form/formBody'
import { formFromBody, FORM_FROM_BODY_WORKER, type BodyMesh, type FormFromBodyResult } from '../../../form/fromMesh'
import { validateCage } from '../../../form/halfEdge'
import { defaultPipeRadius, joinPaths, pathLength, pipeCage, straightPath, tightestBend, type PlaneFrame, type SketchPath } from '../../../form/pipe'
import { longestEdgeChain } from '../../../form/edgePath'
import { extrudeProfileCage, planeMap, revolveAxis, revolveProfileCage, sketchProfile } from '../../../form/profile'
import { loftCage, railOf } from '../../../form/loft'
import type { SketchEntity } from '../../../lib/sketch/types'
import { EMPTY_SELECTION } from '../../../form/topology'
import { circularCount, isSymmetryMode, mirrorNormal } from '../../../form/symmetry'
import type { Vec3 } from '../../../form/cage'
import { setMeshCurvature, setZebra } from '../../../lib/viewport/lighting/zebra'
import type { SceneRuntime } from '../sceneRuntime'
import type { RailSection } from '../workbench/WorkbenchToolRail'
import { createFeatureCommand } from '../dialogs/createFeatureCommand'
import { EditFeaturePayloadCommand } from '../dialogs/EditFeaturePayloadCommand'
import { nextId } from '../dialogs/nextId'
import { FormInteraction } from './formInteraction'

// WO-2504: Operator ruling: hide Pull to body for the alpha. Restore this one rail entry after the alpha; keep its action.
const SHOW_PULL_TO_BODY = false

export interface FormSessionDeps {
  runtime: SceneRuntime | null
  canvasRef: { readonly current: HTMLCanvasElement | null }
  dag: FeatureDag
  history: CommandHistory
  /** the page's post-Apply hand-off (select, regen, console line) */
  onApplied(featureId: string): void
  /** show or hide a body's presentation (the form being edited hides its old body) */
  showBody(featureId: string, visible: boolean): void
  /** the body selected in the Model tree (or the only body) and its tessellation, for Form - From body */
  selectedBodyMesh?(): Promise<{ featureId: string; mesh: BodyMesh } | null>
  /** hide a body the way the Bodies list's eye does (Finish leaves a From-body source hidden) */
  hideBody?(featureId: string): void
  /** the longest curve of the sketch selected in the Model tree, for Form - Pipe */
  selectedSketchPath?(): { name: string; path: SketchPath } | null
  /** the body edge under a click in the view (page coordinates) and the picked spot on it, or null - Form -
   *  Pipe along picked body edges */
  bodyEdgeAt?(clientX: number, clientY: number): (BodyEdgePick & { point: Vec3 }) | null
  /** the picked body edges' polylines and a name for them ("3 edges of Block"), or null when none is drawn */
  bodyEdgePolylines?(picks: readonly BodyEdgePick[]): { name: string; polylines: Vec3[][] } | null
  /** show the picked body edges in the view (none: the highlight clears) */
  showBodyEdgePicks?(picks: readonly BodyEdgePick[]): void
  /** one line in the Model screen's console */
  log?(message: string): void
  /** the package sketch selected in the Model tree: its curves and its plane (Extrude / Revolve) */
  selectedSketch?(): { name: string; entities: readonly SketchEntity[]; frame: PlaneFrame } | null
  /** the construction or base plane selected in the Model tree (Face works on it), or null */
  selectedPlane?(): { name: string; frame: PlaneFrame } | null
  /** the Model screen's zebra display: the smooth skin shows the stripes too */
  zebra?: boolean
  /** the Model screen's curvature display: the smooth skin shows it too */
  curvature?: boolean
}

/** A body edge picked in the view: the (rendered) body it was picked on and the edge's id there. */
export interface BodyEdgePick { bodyId: string; edgeId: string }

export interface FormSession {
  active: boolean
  /** a click in the view on no cage point or edge: the body edge under it becomes the pick (additive: is added,
   *  or removed when picked already); a plain click on nothing (clearOnMiss) clears the picks. `visible` can
   *  refuse a hit the skin hides. True when a body edge was taken. Pipe runs along the picked edges. */
  bodyEdgeClick?(clientX: number, clientY: number, additive: boolean, opts?: { clearOnMiss?: boolean; visible?: (world: Vec3) => boolean }): boolean
  /** open form mode: a new form, or the cage of an existing form feature */
  open(featureId?: string): void
  finish(): void
  cancel(): void
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  /** the rail's tool sections while form mode is open */
  railSections: RailSection[]
}

/** Test/evidence hook, same convention as window.__camStore. */
declare global {
  interface Window { __formStore?: typeof useFormStore; __formOverlay?: FormOverlay | null; __formInteraction?: FormInteraction | null }
}

/**
 * WO-3022: From body in a worker, so a large body (13 s on PortalHandle.step) never holds the page. The mesh
 * is copied, never transferred (an STL body's buffers stay its own). Where there is no Worker (tests) or the
 * worker cannot start, it runs here as before.
 */
function formFromBodyOffPage(mesh: BodyMesh): Promise<FormFromBodyResult> {
  if (typeof Worker === 'undefined') return Promise.resolve(formFromBody(mesh))
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../../../form/fromMesh.ts', import.meta.url), { type: 'module', name: FORM_FROM_BODY_WORKER })
    } catch {
      resolve(formFromBody(mesh))
      return
    }
    worker.onmessage = (e: MessageEvent<FormFromBodyResult>) => { worker.terminate(); resolve(e.data) }
    worker.onerror = (e) => {
      e.preventDefault()
      worker.terminate()
      try { resolve(formFromBody(mesh)) } catch (err) { reject(err) }
    }
    worker.postMessage({ position: mesh.position, index: mesh.index, triFace: mesh.triFace })
  })
}

export function useFormSession(deps: FormSessionDeps): FormSession {
  const workbenchText = useText('sketch-and-model-workbench')
  const active = useFormStore((s) => s.active)
  const canUndo = useFormStore((s) => s.history.past.length > 0)
  const canRedo = useFormStore((s) => s.history.future.length > 0)
  const displayMode = useFormStore((s) => s.displayMode)
  const transformMode = useFormStore((s) => s.transformMode)
  const startedFrom = useFormStore((s) => s.startedFrom)
  const symmetry = useFormStore((s) => s.symmetry)
  const faceTool = useFormStore((s) => s.faceTool)
  // while a replace Face tool is running (before its first face commits), only Face lights - not the starter it is about to replace
  const faceReplacing = faceTool?.replace === true
  const depsRef = useRef(deps)
  useEffect(() => { depsRef.current = deps })
  const overlayRef = useRef<FormOverlay | null>(null)
  // the zebra display reaches the smooth skin while form mode is open
  const zebra = deps.zebra === true
  const curvature = deps.curvature === true
  useEffect(() => {
    const overlay = overlayRef.current
    if (overlay === null) return
    setZebra(overlay.skinMesh.material as import('three').Material, zebra)
    setMeshCurvature(overlay.skinMesh, curvature)
    deps.runtime?.requestRender()
  }, [zebra, curvature, active, deps.runtime])

  // body edges picked in the view (a click off the cage), for Pipe; they last while form mode is open
  const edgePicksRef = useRef<BodyEdgePick[]>([])
  const setEdgePicks = useCallback((next: BodyEdgePick[]) => {
    const before = edgePicksRef.current
    edgePicksRef.current = next
    if (before.length > 0 || next.length > 0) depsRef.current.showBodyEdgePicks?.(next)
  }, [])
  const bodyEdgeClick = useCallback((clientX: number, clientY: number, additive: boolean, opts: { clearOnMiss?: boolean; visible?: (world: Vec3) => boolean } = {}): boolean => {
    const find = depsRef.current.bodyEdgeAt
    if (find === undefined) return false
    const found = find(clientX, clientY)
    const hit = found === null || (opts.visible !== undefined && !opts.visible(found.point)) ? null : { bodyId: found.bodyId, edgeId: found.edgeId }
    const picks = edgePicksRef.current
    if (hit === null) {
      if (!additive && opts.clearOnMiss !== false && picks.length > 0) setEdgePicks([])
      return false
    }
    const at = picks.findIndex((p) => p.bodyId === hit.bodyId && p.edgeId === hit.edgeId)
    const next = !additive ? [hit] : at >= 0 ? picks.filter((_, i) => i !== at) : [...picks, hit]
    setEdgePicks(next)
    const n = next.length
    if (n > 0) useFormStore.getState().setNotice(workbenchText('useFormSession.bodyEdgePickedPipeRunsAlongShiftClickAdds', { n: String(n), value2: String(n === 1 ? '' : 's'), value3: String(n === 1 ? 'it' : 'them') }))
    return true
  }, [setEdgePicks])

  // the overlay + interaction live exactly while form mode is open and the viewport exists
  const { runtime, canvasRef } = deps
  useEffect(() => {
    const canvas = canvasRef.current
    if (!active || runtime === null || canvas === null) return
    const host = {
      addObject: (o: import('three').Object3D) => runtime.addObject(o),
      removeObject: (o: import('three').Object3D) => runtime.removeObject(o),
      requestRender: () => runtime.requestRender(),
      camera: () => runtime.camera,
      canvas,
      setOrbitEnabled: (enabled: boolean) => runtime.setOrbitEnabled(enabled),
      bodyEdgeClick,
    }
    const overlay = new FormOverlay(host)
    overlayRef.current = overlay
    setZebra(overlay.skinMesh.material as import('three').Material, depsRef.current.zebra === true)
    setMeshCurvature(overlay.skinMesh, depsRef.current.curvature === true)
    const push = () => {
      const s = useFormStore.getState()
      const normal = s.symmetry === null ? null : mirrorNormal(s.symmetry, s.symmetryNormal)
      const copies = s.symmetry === null ? null : circularCount(s.symmetry)
      overlay.update({ cage: s.cage, topologyVersion: s.topologyVersion, displayMode: s.displayMode, dragging: s.dragging, skinLevel: s.skinLevel, mirror: normal === null ? null : { normal, at: s.symmetryAt }, circular: copies === null ? null : { copies } })
    }
    push()
    const interaction = new FormInteraction(host, overlay)
    const unsubscribe = useFormStore.subscribe((s, prev) => {
      // a new topology (the loft itself, Undo, a starter ...): Loft's profile outlines go, as the face draft does
      if (s.topologyVersion !== prev.topologyVersion) overlay.setProfileOutlines([])
      if (s.cage !== prev.cage || s.topologyVersion !== prev.topologyVersion || s.displayMode !== prev.displayMode || s.dragging !== prev.dragging || s.skinLevel !== prev.skinLevel || s.symmetry !== prev.symmetry || s.symmetryAt !== prev.symmetryAt || s.symmetryNormal !== prev.symmetryNormal) push()
    })
    const { box } = FormOverlay.frameOf(useFormStore.getState().cage)
    runtime.frameBox(box.min, box.max)
    if (import.meta.env.DEV) { window.__formStore = useFormStore; window.__formOverlay = overlay; window.__formInteraction = interaction }
    return () => {
      unsubscribe()
      interaction.dispose()
      overlay.dispose()
      overlayRef.current = null
      if (import.meta.env.DEV) { window.__formOverlay = null; window.__formInteraction = null }
    }
  }, [active, runtime, canvasRef, bodyEdgeClick])

  // Loft's profiles so far (one per click, from the sketch selected in the tree); a new session starts none
  const loftRef = useRef<Array<{ name: string; path: SketchPath; frame: PlaneFrame }>>([])
  // Pipe's path so far: sketch curves joined end to end (one click each), which may cross sketch planes
  const pipeRef = useRef<{ names: string[]; path: SketchPath } | null>(null)
  // and Loft's rails: open curves from the first profile to the last (loft.ts railOf)
  const loftRailsRef = useRef<Array<{ name: string; path: SketchPath; frame: PlaneFrame }>>([])

  const open = useCallback((featureId?: string) => {
    loftRef.current = []
    loftRailsRef.current = []
    overlayRef.current?.setProfileOutlines([])
    pipeRef.current = null
    setEdgePicks([])
    const { dag, showBody } = depsRef.current
    if (featureId !== undefined) {
      const node = dag.getNode(featureId)
      if (node === undefined || node.kind !== 'feature' || !isFormFeaturePayload(node.payload)) return
      showBody(featureId, false)
      useFormStore.getState().openSession({ featureId, name: node.payload.name, cage: node.payload.cage, tolerance: node.payload.tolerance, symmetry: isSymmetryMode(node.payload.symmetry) ? node.payload.symmetry : null, symmetryAt: typeof node.payload.symmetryAt === 'number' ? node.payload.symmetryAt : 0, symmetryNormal: Array.isArray(node.payload.symmetryNormal) && node.payload.symmetryNormal.length === 3 && node.payload.symmetryNormal.every(Number.isFinite) ? node.payload.symmetryNormal as Vec3 : null })
      return
    }
    const id = nextId(dag, 'FRM')
    useFormStore.getState().openSession({ featureId: null, name: workbenchText('useFormSession.form', { value1: String(id.slice(3)) }) })
  }, [setEdgePicks])

  const leave = useCallback(() => {
    const s = useFormStore.getState()
    if (s.featureId !== null) depsRef.current.showBody(s.featureId, true)
    // WO-2125 audit: From body hides its source body for the session; leaving (Cancel or Finish) repaints it.
    if (s.sourceBodyId !== null) depsRef.current.showBody(s.sourceBodyId, true)
    setEdgePicks([])
    s.closeSession()
  }, [setEdgePicks])

  const finish = useCallback(() => {
    const s = useFormStore.getState()
    const { dag, history, onApplied } = depsRef.current
    const payload = makeFormFeaturePayload(s.name, s.cage, s.tolerance, s.symmetry, s.symmetryAt, s.symmetryNormal)
    let id = s.featureId
    if (id !== null && dag.getNode(id)?.kind === 'feature') {
      const merged: Record<string, unknown> = { ...dag.getNode(id)!.payload, ...payload }
      // a mirror switched off since the last Finish is dropped, not left over from the old payload
      if (payload.symmetry === undefined) delete merged.symmetry
      if (payload.symmetryAt === undefined) delete merged.symmetryAt
      if (payload.symmetryNormal === undefined) delete merged.symmetryNormal
      history.execute(new EditFeaturePayloadCommand(id, merged))
    } else {
      id = nextId(dag, 'FRM')
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [], payload: { ...payload } }))
    }
    const source = s.sourceBodyId
    leave()
    if (source !== null) depsRef.current.hideBody?.(source)
    onApplied(id)
  }, [leave])

  const startFromBody = useCallback(async () => {
    const source = await depsRef.current.selectedBodyMesh?.()
    if (!source) { useFormStore.getState().setNotice(workbenchText('useFormSession.selectABodyInTheModelTreeFirstThen')); return }
    const r = await formFromBodyOffPage(source.mesh)
    // WO-3022: the conversion runs off the page now, and form mode may have been left while it ran
    if (!useFormStore.getState().active) return
    const st = useFormStore.getState()
    // WO-2865: applyCage's own refusal names a cage face index ("face 2106
    // repeats a point") with no next step. Check first and say it in shop words;
    // the index stays in the debug log for whoever traces the conversion.
    const check = validateCage(r.cage)
    if (!check.ok) {
      console.info(`Form - From body: cage check failed: ${check.problems.join('; ')}`)
      st.setNotice(workbenchText('useFormSession.fromBodyCouldNotShapeThisBody'))
      return
    }
    if (!st.applyCage(r.cage, {
      topology: true, record: true, startFrom: true,
      notice: workbenchText('useFormSession.fromBodySharpEdgesCreasedTheBodyIsHidden', { value1: String([
        r.flatFaces > 0 ? workbenchText('useFormSession.flatFaceKeptWhole', { value1: String(r.flatFaces), value2: String(r.flatFaces === 1 ? '' : 's') }) : '',
        r.gridFaces > 0 ? workbenchText('useFormSession.faceRemeshedIntoQuads', { value1: String(r.gridFaces), value2: String(r.gridFaces === 1 ? '' : 's') }) : '',
        r.curvedTriangles > 0 ? workbenchText('useFormSession.trianglesOfCurvedFacesSmoothed', { value1: String(r.curvedTriangles) }) : '',
      ].filter(Boolean).join(', ')), length: String(r.cage.creases.length) }),
    })) return
    st.setSourceBodyId(source.featureId)
    useFormStore.setState({ startedFrom: 'body' })
    depsRef.current.showBody(source.featureId, false)
  }, [])

  const startPipe = useCallback(() => {
    // body edges picked in the view come first: one path along the longest connected chain of them
    const edgePicks = edgePicksRef.current.length === 0 ? null : depsRef.current.bodyEdgePolylines?.(edgePicksRef.current) ?? null
    const chain = edgePicks === null ? null : longestEdgeChain(edgePicks.polylines)
    if (edgePicks !== null && chain !== null) {
      const st = useFormStore.getState()
      const path = chain.path
      const radius = st.pipeRadius > 0 ? st.pipeRadius : defaultPipeRadius(path)
      const bend = tightestBend(path)
      const size = st.pipeRadius > 0 ? workbenchText('useFormSession.radiusMm', { value1: String(+radius.toFixed(3)), value2: String(radius > bend ? workbenchText('useFormSession.widerThanTheTightestBendMmTheTubeFolds', { value1: String(+bend.toFixed(2)) }) : '') }) : workbenchText('useFormSession.radiusMmAutomaticTheFormPaletteSPipeRow', { radius: String(radius) })
      const name = chain.edges === chain.total ? edgePicks.name : workbenchText('useFormSession.of', { value1: String(chain.edges), value2: String(edgePicks.name) })
      const source = st.sourceBodyId
      if (!st.applyCage(pipeCage(path, { radius }), { topology: true, record: true, startFrom: true, notice: workbenchText('useFormSession.pipeAlongMm', { name: String(name), value2: String(pathLength(path).toFixed(1)), value3: String(path.closed ? workbenchText('useFormSession.closed') : ''), size: String(size) }) })) return
      if (chain.edges < chain.total) depsRef.current.log?.(workbenchText('useFormSession.pipeThePickedEdgesDoNotAllConnectBuilt', { total: String(chain.total), edges: String(chain.edges), value3: String(pathLength(path).toFixed(1)) }))
      // a next sketch whose curve starts where these edges end carries the pipe on, as after a sketch
      pipeRef.current = { names: [edgePicks.name], path }
      useFormStore.setState({ sourceBodyId: null, selection: EMPTY_SELECTION, startedFrom: 'pipe' })
      if (source !== null) depsRef.current.showBody(source, true)
      return
    }
    const selected = depsRef.current.selectedSketchPath?.() ?? null
    // a curve that starts where the last Pipe's path ends (or ends where it starts) extends that path, across
    // sketch planes too: one 3D path; any other curve starts a new pipe
    const prior = pipeRef.current
    const joined = selected === null || prior === null || prior.names.includes(selected.name) ? null : joinPaths(prior.path, selected.path, Math.max(0.01, 1e-4 * pathLength(prior.path)))
    const picked = selected === null ? null : joined !== null && prior !== null
      ? { name: [...prior.names, selected.name].join(' + '), path: joined }
      : selected
    pipeRef.current = selected === null ? null : { names: joined !== null && prior !== null ? [...prior.names, selected.name] : [selected.name], path: picked!.path }
    const path = picked?.path ?? straightPath()
    const st = useFormStore.getState()
    const auto = defaultPipeRadius(path)
    const radius = st.pipeRadius > 0 ? st.pipeRadius : auto
    const source = st.sourceBodyId
    // a tube wider than the path's tightest bend folds on itself there (a straight path has none)
    const bend = tightestBend(path)
    const size = st.pipeRadius > 0 ? workbenchText('useFormSession.radiusMm', { value1: String(+radius.toFixed(3)), value2: String(radius > bend ? workbenchText('useFormSession.widerThanTheTightestBendMmTheTubeFolds', { value1: String(+bend.toFixed(2)) }) : '') }) : workbenchText('useFormSession.radiusMmAutomaticTheFormPaletteSPipeRow', { radius: String(radius) })
    const notice = picked !== null
      ? workbenchText('useFormSession.pipeAlongMm', { name: String(picked.name), value2: String(pathLength(path).toFixed(1)), value3: String(path.closed ? workbenchText('useFormSession.closed') : ''), size: String(size) })
      : workbenchText('useFormSession.pipeAStraightMmPipeWithASketchSelected', { value1: String(pathLength(path).toFixed(0)), size: String(size) })
    if (!st.applyCage(pipeCage(path, { radius }), { topology: true, record: true, startFrom: true, notice })) return
    useFormStore.setState({ sourceBodyId: null, selection: EMPTY_SELECTION, startedFrom: 'pipe' })
    if (source !== null) depsRef.current.showBody(source, true)
  }, [])

  /** Extrude / Revolve the selected sketch's profile; with none, a default profile, and the notice says so. */
  const startFromProfile = useCallback((how: 'extrude' | 'revolve') => {
    const picked = depsRef.current.selectedSketch?.() ?? null
    const profile = picked === null ? null : sketchProfile(picked.entities)
    const st = useFormStore.getState()
    const source = st.sourceBodyId
    const XY: PlaneFrame = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
    const frame = profile !== null && picked !== null ? picked.frame : how === 'extrude' ? XY : { ...XY, normal: { x: 0, y: -1, z: 0 } }
    const fallback: SketchPath = how === 'extrude'
      ? { points: Array.from({ length: 48 }, (_, i) => [20 * Math.cos((i * Math.PI) / 24), 20 * Math.sin((i * Math.PI) / 24), 0]), closed: true }
      : { points: [[10, 0, 0], [20, 0, 0], [20, 10, 0], [10, 10, 0]], closed: true }
    const path = profile ?? fallback
    const from = profile !== null && picked !== null ? picked.name : null
    let cage, notice
    if (how === 'extrude') {
      const r = extrudeProfileCage(path, frame, st.profileHeight)
      cage = r.cage
      notice = from !== null
        ? workbenchText('useFormSession.extrudedMmPointsRoundCornerCreased', { from: String(from), value2: String(path.closed ? '' : workbenchText('useFormSession.anOpenCurveAnOpenSheet')), value3: String(Math.abs(st.profileHeight)), around: String(r.around), corners: String(r.corners), value6: String(r.corners === 1 ? '' : 's') })
        : workbenchText('useFormSession.extrudeA40MmCircleMmTallWithA', { value1: String(Math.abs(st.profileHeight)) })
    } else {
      const axis = revolveAxis(picked?.entities ?? [], path)
      const r = revolveProfileCage(path, frame, axis, st.revolveSegments, 48, st.revolveAngle)
      cage = r.cage
      const turn = st.revolveAngle >= 360 ? '' : workbenchText('useFormSession.degrees', { value1: String(+st.revolveAngle.toFixed(2)), value2: String(path.closed ? workbenchText('useFormSession.itsEndsCappedFlat') : '') })
      notice = from !== null
        ? workbenchText('useFormSession.revolvedRoundPointsAlongTheProfileRound', { from: String(from), label: String(axis.label), turn: String(turn), around: String(r.around), revolveSegments: String(st.revolveSegments), value6: String(r.poles > 0 ? workbenchText('useFormSession.poleOnTheAxis', { value1: String(r.poles), value2: String(r.poles === 1 ? '' : 's') }) : '') })
        : workbenchText('useFormSession.revolveA10X10MmSquareTurnedRound', { value1: String(turn || workbenchText('useFormSession.intoARing')) })
    }
    if (!st.applyCage(cage, { topology: true, record: true, startFrom: true, notice })) return
    useFormStore.setState({ sourceBodyId: null, selection: EMPTY_SELECTION, startedFrom: how })
    if (source !== null) depsRef.current.showBody(source, true)
  }, [])

  /** Pull onto the body selected in the Model tree (else the only body): the form's surface onto it. */
  const pullToBody = useCallback(async () => {
    const target = await depsRef.current.selectedBodyMesh?.()
    const st = useFormStore.getState()
    if (target === undefined || target === null) { st.setNotice(workbenchText('useFormSession.pullToBodySelectTheBodyToPullOnto')); return }
    const name = String(depsRef.current.dag.getNode(target.featureId)?.payload?.name ?? target.featureId)
    st.pullOntoBody(target.mesh, name)
  }, [])

  /**
   * Loft: each click adds the profile of the sketch selected in the tree; from
   * the second on, the form is lofted through them all (and rebuilt as more are
   * added). A sketch already in the loft starts a new one from it.
   */
  const startLoft = useCallback(() => {
    const picked = depsRef.current.selectedSketch?.() ?? null
    const st = useFormStore.getState()
    const profile = picked === null ? null : sketchProfile(picked.entities)
    if (picked === null || profile === null) { st.setNotice(workbenchText('useFormSession.loftSelectASketchInTheModelTreeThen')); return }
    const picks = { name: picked.name, path: profile, frame: picked.frame }
    // an open curve from the first profile to the last is a rail; anything else is the next profile
    const asRail = !loftRailsRef.current.some((p) => p.name === picked.name) && railOf(loftRef.current, picks)
    if (!asRail && (loftRef.current.some((p) => p.name === picked.name) || loftRailsRef.current.some((p) => p.name === picked.name))) {
      loftRef.current = []
      loftRailsRef.current = []
    }
    const list = asRail ? loftRef.current : [...loftRef.current, picks]
    // a rail that no longer reaches the last profile (one added past its end) stops shaping the loft
    const rails = (asRail ? [...loftRailsRef.current, picks] : loftRailsRef.current).filter((p) => railOf(list, p))
    if (list.length === 1) {
      loftRef.current = list
      // the first click shows in the view: profile 1 outlined where it lies until the loft appears
      overlayRef.current?.setProfileOutlines(list.map((p) => { const m = planeMap(p.frame); return { points: p.path.points.map((q) => m.at([q[0], q[1]])), closed: p.path.closed } }))
      st.setNotice(workbenchText('useFormSession.loftIsProfile1SelectTheNextSketchIn', { name: String(picked.name) }))
      return
    }
    const r = loftCage(list, 32, rails)
    if ('reason' in r) { st.setNotice(workbenchText('useFormSession.profileKept', { reason: String(r.reason), value2: String(list.length - 1), value3: String(list.length === 2 ? '' : 's') })); return }
    loftRef.current = list
    loftRailsRef.current = rails
    overlayRef.current?.setProfileOutlines([])
    const source = st.sourceBodyId
    const railWords = rails.length === 0 ? '' : workbenchText('useFormSession.along', { value1: String(rails.map((p) => p.name).join(', ')) })
    if (!st.applyCage(r.cage, { topology: true, record: true, startFrom: true, notice: workbenchText('useFormSession.loftedThroughRingsTheSkinPulledThroughEveryProfile', { value1: String(list.map((p) => p.name).join(', ')), railWords: String(railWords), rings: String(r.rings), value4: String(rails.length === 0 ? '' : workbenchText('useFormSession.andRail')) }) })) return
    useFormStore.setState({ sourceBodyId: null, selection: EMPTY_SELECTION, startedFrom: 'loft' })
    if (source !== null) depsRef.current.showBody(source, true)
  }, [])

  /**
   * Face by clicks, on the selected sketch's plane, else the construction or base plane selected in the tree
   * (Offset plane, Midplane, At angle, XY ...), else XY at Z = 0; `replace`: the first face starts a new form.
   * A chained tool keeps its chain.
   */
  const startFace = useCallback((replace: boolean) => {
    const picked = depsRef.current.selectedSketch?.() ?? depsRef.current.selectedPlane?.() ?? null
    const st = useFormStore.getState()
    if (st.faceTool !== null && st.faceTool.replace === replace) { st.stopFaceTool(); return }
    const chain = st.faceTool?.chain === true
    if (picked === null) { st.startFaceTool({ replace, chain }); return }
    const f = picked.frame
    st.startFaceTool({ replace, chain, plane: { origin: [f.origin.x, f.origin.y, f.origin.z], normal: [f.normal.x, f.normal.y, f.normal.z] }, planeWords: workbenchText('useFormSession.thePlaneOf', { name: String(picked.name) }) })
  }, [])

  const undo = useCallback(() => useFormStore.getState().undo(), [])
  const redo = useCallback(() => useFormStore.getState().redo(), [])

  const store = useFormStore.getState
  const railSections: RailSection[] = [
    {
      id: 'form-create',
      title: workbenchText('useFormSession.formStartFrom'),
      tools: [...([
        ['box', workbenchText('useFormSession.box'), Box],
        ['cylinder', workbenchText('useFormSession.cylinder'), Cylinder],
        ['sphere', workbenchText('useFormSession.sphere'), Circle],
        ['torus', workbenchText('useFormSession.torus'), Donut],
        ['plane', workbenchText('useFormSession.plane'), Square],
      ] as const).map(([kind, label, icon]) => ({
        testId: `form-starter-${kind}`,
        label,
        icon,
        active: startedFrom === kind && !faceReplacing,
        title: workbenchText('useFormSession.startAgainFromACageSegmentCountsInThe', { value1: String(label.toLowerCase()) }),
        onClick: () => {
          // WO-2125 audit: a starter replaces a From-body cage, so its source body is no longer hidden - repaint it.
          const source = store().sourceBodyId
          store().newFromStarter(kind)
          if (source !== null) depsRef.current.showBody(source, true)
        },
      })),
      {
        testId: 'form-starter-pipe',
        label: workbenchText('useFormSession.pipe'),
        icon: Route,
        active: startedFrom === 'pipe' && !faceReplacing,
        title: workbenchText('useFormSession.aTubeAlongTheCurveOfTheSketchSelected'),
        onClick: startPipe,
      },
      {
        testId: 'form-starter-extrude',
        label: workbenchText('useFormSession.extrude'),
        icon: ArrowUpFromLine,
        active: startedFrom === 'extrude' && !faceReplacing,
        title: workbenchText('useFormSession.aFormFromTheProfileOfTheSketchSelected'),
        onClick: () => startFromProfile('extrude'),
      },
      {
        testId: 'form-starter-revolve',
        label: workbenchText('useFormSession.revolve'),
        icon: Rotate3d,
        active: startedFrom === 'revolve' && !faceReplacing,
        title: workbenchText('useFormSession.aFormFromTheProfileOfTheSketchSelected2'),
        onClick: () => startFromProfile('revolve'),
      },
      {
        testId: 'form-starter-loft',
        label: workbenchText('useFormSession.loft'),
        icon: Spline,
        active: startedFrom === 'loft' && !faceReplacing,
        title: workbenchText('useFormSession.aFormThroughSketchProfilesSelectASketchIn'),
        onClick: startLoft,
      },
      {
        testId: 'form-starter-face',
        label: workbenchText('useFormSession.face'),
        icon: PenTool,
        active: startedFrom === 'face' || faceReplacing,
        title: workbenchText('useFormSession.aNewFormFromFacesYouClick4Corners'),
        onClick: () => startFace(true),
      },
      {
        testId: 'form-starter-body',
        label: workbenchText('useFormSession.fromBody'),
        icon: Import,
        active: startedFrom === 'body' && !faceReplacing,
        title: workbenchText('useFormSession.startFromTheBodySelectedInTheModelTree'),
        onClick: () => { void startFromBody() },
      },
      ],
    },
    {
      id: 'form-edit',
      title: workbenchText('useFormSession.editForm'),
      tools: [...([
        ['translate', workbenchText('useFormSession.move'), Move, workbenchText('useFormSession.moveTheSelectionAltDragAFaceArrowTo')],
        ['rotate', workbenchText('useFormSession.rotate'), RotateCw, workbenchText('useFormSession.rotateTheSelectionAboutItsCentre')],
        ['scale', workbenchText('useFormSession.scale'), Scaling, workbenchText('useFormSession.scaleTheSelectionAboutItsCentre')],
      ] as const).map(([mode, label, icon, title]) => ({
        testId: `form-transform-${mode}`,
        label,
        icon,
        active: transformMode === mode,
        title,
        onClick: () => store().setTransformMode(mode),
      })),
        { testId: 'form-flatten', label: workbenchText('useFormSession.flatten'), icon: RectangleHorizontal, title: workbenchText('useFormSession.putTheSelectedPointsOrTheCornersOfThe'), onClick: () => store().flattenSelection() },
        { testId: 'form-straighten', label: workbenchText('useFormSession.straighten'), icon: Ruler, title: workbenchText('useFormSession.putEachSelectedEdgeChainOnTheLineBetween'), onClick: () => store().straightenSelection() },
        { testId: 'form-make-uniform', label: workbenchText('useFormSession.uniform'), icon: Grip, title: workbenchText('useFormSession.evenOutTheSpacingOfTheSelectedPointsOver'), onClick: () => store().makeUniformSelection() },
        ...(SHOW_PULL_TO_BODY ? [{ testId: 'form-pull-body', label: workbenchText('useFormSession.pullToBody'), icon: Target, title: workbenchText('useFormSession.pullTheSurfaceAtTheSelectedPointsAllWhen'), onClick: () => { void pullToBody() } }] : []),
        { testId: 'form-pull', label: workbenchText('useFormSession.pull'), icon: LocateFixed, title: workbenchText('useFormSession.moveTheCageSoTheSmoothSurfacePassesThrough'), onClick: () => store().pullSelection() },
      ],
    },
    {
      id: 'form-topology',
      title: workbenchText('useFormSession.topology'),
      tools: [
        { testId: 'form-insert-loop', label: workbenchText('useFormSession.insertLoop'), icon: Rows3, title: workbenchText('useFormSession.insertAnEdgeLoopAcrossTheRingOfThe'), onClick: () => store().insertLoop() },
        { testId: 'form-crease', label: workbenchText('useFormSession.crease'), icon: Slash, title: workbenchText('useFormSession.creaseTheSelectedEdgesAndTheEdgesOfSelected'), onClick: () => store().crease(true) },
        { testId: 'form-uncrease', label: workbenchText('useFormSession.uncrease'), icon: Waves, title: workbenchText('useFormSession.makeTheSelectedEdgesSmoothAgain'), onClick: () => store().crease(false) },
        { testId: 'form-insert-point', label: workbenchText('useFormSession.insertPoint'), icon: Dot, title: workbenchText('useFormSession.insertAPointInTheMiddleOfEachSelected'), onClick: () => store().insertPointOnSelection() },
        { testId: 'form-add-face', label: workbenchText('useFormSession.addFace'), icon: SquarePlus, active: faceTool?.replace === false, title: workbenchText('useFormSession.addFacesToThisFormByClicking4Corners'), onClick: () => startFace(false) },
        { testId: 'form-face-chain', label: workbenchText('useFormSession.chain'), icon: Link, active: faceTool?.chain === true, title: workbenchText('useFormSession.chainFacesEachFaceStartsTheNextOnIts'), onClick: () => store().toggleFaceChain() },
        { testId: 'form-subdivide', label: workbenchText('useFormSession.subdivide'), icon: Grid3x3, title: workbenchText('useFormSession.splitTheSelectedFacesIntoQuadsRoundTheirCentres'), onClick: () => store().subdivideSelection() },
        { testId: 'form-weld', label: workbenchText('useFormSession.weld'), icon: Merge, title: workbenchText('useFormSession.mergeTheSelectedPointsOrTheEndsOfA'), onClick: () => store().weldSelection() },
        { testId: 'form-weld-close', label: workbenchText('useFormSession.weldClose'), icon: Magnet, title: workbenchText('useFormSession.weldPointsCloserThanTheFormPaletteSWeld'), onClick: () => store().weldCloseSelection() },
        { testId: 'form-unweld', label: workbenchText('useFormSession.unweld'), icon: Unlink, title: workbenchText('useFormSession.cutTheFormOpenAlongTheSelectedEdgesOr'), onClick: () => store().unweldSelection() },
      ],
    },
    {
      id: 'form-select',
      title: workbenchText('useFormSession.select'),
      tools: [
        { testId: 'form-select-loop', label: workbenchText('useFormSession.loop'), icon: Repeat2, title: workbenchText('useFormSession.addTheEdgeLoopOfEachSelectedEdgeStraight'), onClick: () => store().selectLoop() },
        { testId: 'form-select-ring', label: workbenchText('useFormSession.ring'), icon: Rows4, title: workbenchText('useFormSession.addTheEdgeRingOfEachSelectedEdgeAcross'), onClick: () => store().selectRing() },
        { testId: 'form-select-grow', label: workbenchText('useFormSession.grow'), icon: Expand, title: workbenchText('useFormSession.widenTheSelectionByOneRingFacesByShared'), onClick: () => store().growSelection() },
        { testId: 'form-select-shrink', label: workbenchText('useFormSession.shrink'), icon: Shrink, title: workbenchText('useFormSession.narrowTheSelectionByOneRingFromItsEdge'), onClick: () => store().shrinkSelection() },
        { testId: 'form-select-all', label: workbenchText('useFormSession.all'), icon: SquareDashedMousePointer, title: workbenchText('useFormSession.selectEveryFaceOrEveryEdgePointWhenEdges'), onClick: () => store().selectAll() },
      ],
    },
    {
      id: 'form-openings',
      title: workbenchText('useFormSession.openings'),
      tools: [
        { testId: 'form-delete-faces', label: workbenchText('useFormSession.delete'), icon: Trash2, title: workbenchText('useFormSession.deleteTheSelectedFacesTheFormIsOpenThere'), onClick: () => store().deleteSelection() },
        { testId: 'form-fill-hole', label: workbenchText('useFormSession.fillHole'), icon: SquareDashed, title: workbenchText('useFormSession.capTheOpeningThroughTheSelectedRimEdgeWith'), onClick: () => store().fillHoleAtSelection() },
        { testId: 'form-bridge', label: workbenchText('useFormSession.bridge'), icon: Link2, title: workbenchText('useFormSession.joinTwoSelectedFacesOrFaceSetsOrThe'), onClick: () => store().bridgeSelection() },
        { testId: 'form-thicken', label: workbenchText('useFormSession.thicken'), icon: Layers, title: workbenchText('useFormSession.closeAnOpenFormWithAnInnerSkinWall'), onClick: () => store().thickenForm() },
      ],
    },
    {
      id: 'form-symmetry',
      title: workbenchText('useFormSession.symmetry'),
      tools: [...([
        ['x', workbenchText('useFormSession.mirrorX'), FlipHorizontal2, workbenchText('useFormSession.mirrorAcrossTheYZPlaneX0PairedPoints')],
        ['y', workbenchText('useFormSession.mirrorY'), FlipVertical2, workbenchText('useFormSession.mirrorAcrossTheXZPlaneY0PairedPoints')],
        ['z', workbenchText('useFormSession.mirrorZ'), SeparatorHorizontal, workbenchText('useFormSession.mirrorAcrossTheLevelPlaneThroughTheFormS')],
      ] as const).map(([axis, label, icon, title]) => ({
        testId: `form-mirror-${axis}`,
        label,
        icon,
        active: symmetry === axis,
        title,
        onClick: () => store().setSymmetry(symmetry === axis ? null : axis),
      })), {
        testId: 'form-circular',
        label: workbenchText('useFormSession.circular'),
        icon: Sun,
        active: symmetry !== null && circularCount(symmetry) !== null,
        title: workbenchText('useFormSession.circularSymmetryRoundTheZAxisAsManyCopies'),
        onClick: () => store().toggleCircular(),
      }, {
        testId: 'form-mirror-selection',
        label: workbenchText('useFormSession.between'),
        icon: FoldHorizontal,
        active: symmetry === 'p',
        title: workbenchText('useFormSession.mirrorAcrossAPlaneYouPlaceSelectTwoPoints'),
        onClick: () => store().mirrorFromSelection(),
      }, {
        testId: 'form-mirror-duplicate',
        label: workbenchText('useFormSession.duplicate'),
        icon: Copy,
        title: workbenchText('useFormSession.mirrorACopyOfTheFormAcrossTheMirror'),
        onClick: () => store().mirrorDuplicateForm(),
      }],
    },
    {
      id: 'form-display',
      title: workbenchText('useFormSession.display'),
      tools: ([
        ['cage', workbenchText('useFormSession.cage'), Grid2x2],
        ['both', workbenchText('useFormSession.both'), Eye],
        ['smooth', workbenchText('useFormSession.smooth'), Circle],
      ] as const).map(([mode, label, icon]) => ({
        testId: `form-display-${mode}`,
        label,
        icon,
        title: mode === 'both' ? workbenchText('useFormSession.cageOverTheSmoothSkin') : mode === 'cage' ? workbenchText('useFormSession.theControlCageOnly') : workbenchText('useFormSession.theSmoothSkinOnly'),
        active: displayMode === mode,
        onClick: () => store().setDisplayMode(mode),
      })),
    },
    {
      id: 'form-history',
      title: workbenchText('useFormSession.formHistory'),
      tools: [
        ...(canUndo ? [{ testId: 'form-undo', label: workbenchText('useFormSession.undo'), icon: Undo2, title: workbenchText('useFormSession.undoInTheFormCtrlZ'), onClick: undo }] : []),
        ...(canRedo ? [{ testId: 'form-redo', label: workbenchText('useFormSession.redo'), icon: Redo2, title: workbenchText('useFormSession.redoInTheFormCtrlShiftZ'), onClick: redo }] : []),
      ],
    },
  ].filter((section) => section.tools.length > 0)

  return { active, bodyEdgeClick, open, finish, cancel: leave, undo, redo, canUndo, canRedo, railSections }
}
