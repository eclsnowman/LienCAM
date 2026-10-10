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

import { useCallback, useEffect, useRef } from 'react'
import { Box, Circle, Copy, Cylinder, Link, Dot, Donut, Magnet, Expand, Shrink, SquareDashedMousePointer, PenTool, SquarePlus, LocateFixed, Spline, Target, Grid3x3, Merge, Route, Eye, Import, Unlink, RectangleHorizontal, Ruler, Grip, ArrowUpFromLine, Rotate3d, FlipHorizontal2, FlipVertical2, FoldHorizontal, Grid2x2, Layers, Link2, Move, Redo2, Repeat2, RotateCw, Rows3, Rows4, Scaling, SeparatorHorizontal, Slash, Square, SquareDashed, Sun, Trash2, Undo2, Waves } from 'lucide-react'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { useFormStore } from '../../../form/formStore'
import { FormOverlay } from '../../../form/formOverlay'
import { isFormFeaturePayload, makeFormFeaturePayload } from '../../../form/formBody'
import { formFromBody, type BodyMesh } from '../../../form/fromMesh'
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

export function useFormSession(deps: FormSessionDeps): FormSession {
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
    if (n > 0) useFormStore.getState().setNotice(`${n} body edge${n === 1 ? '' : 's'} picked: Pipe runs along ${n === 1 ? 'it' : 'them'}. Shift+click adds or removes an edge; a click off the body clears them.`)
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
    useFormStore.getState().openSession({ featureId: null, name: `Form ${id.slice(3)}` })
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
    const st = useFormStore.getState()
    if (!source) { st.setNotice('Select a body in the Model tree first, then From body turns it into a form'); return }
    const r = formFromBody(source.mesh)
    if (!st.applyCage(r.cage, {
      topology: true, record: true, startFrom: true,
      notice: `From body: ${[
        r.flatFaces > 0 ? `${r.flatFaces} flat face${r.flatFaces === 1 ? '' : 's'} kept whole` : '',
        r.gridFaces > 0 ? `${r.gridFaces} face${r.gridFaces === 1 ? '' : 's'} remeshed into quads` : '',
        r.curvedTriangles > 0 ? `${r.curvedTriangles} triangles of curved faces smoothed` : '',
      ].filter(Boolean).join(', ')}; ${r.cage.creases.length} sharp edges creased. The body is hidden while you shape it and stays in the tree.`,
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
      const size = st.pipeRadius > 0 ? `radius ${+radius.toFixed(3)} mm${radius > bend ? ` (wider than the tightest bend, ${+bend.toFixed(2)} mm: the tube folds there)` : ''}` : `radius ${radius} mm (automatic; the Form palette's Pipe row sets it)`
      const name = chain.edges === chain.total ? edgePicks.name : `${chain.edges} of ${edgePicks.name}`
      const source = st.sourceBodyId
      if (!st.applyCage(pipeCage(path, { radius }), { topology: true, record: true, startFrom: true, notice: `Pipe along ${name}: ${pathLength(path).toFixed(1)} mm${path.closed ? ', closed' : ''}, ${size}` })) return
      if (chain.edges < chain.total) depsRef.current.log?.(`Pipe: the ${chain.total} picked edges do not all connect - built along the longest connected chain, ${chain.edges} of them (${pathLength(path).toFixed(1)} mm)`)
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
    const size = st.pipeRadius > 0 ? `radius ${+radius.toFixed(3)} mm${radius > bend ? ` (wider than the tightest bend, ${+bend.toFixed(2)} mm: the tube folds there)` : ''}` : `radius ${radius} mm (automatic; the Form palette's Pipe row sets it)`
    const notice = picked !== null
      ? `Pipe along ${picked.name}: ${pathLength(path).toFixed(1)} mm${path.closed ? ', closed' : ''}, ${size}`
      : `Pipe: a straight ${pathLength(path).toFixed(0)} mm pipe, ${size}. With a sketch selected in the Model tree, Pipe follows its curve; a next sketch whose curve starts where it ends, clicked the same way, carries it on.`
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
        ? `Extruded ${from}${path.closed ? '' : ' (an open curve: an open sheet)'} ${Math.abs(st.profileHeight)} mm: ${r.around} points round, ${r.corners} corner${r.corners === 1 ? '' : 's'} creased`
        : `Extrude: a 40 mm circle ${Math.abs(st.profileHeight)} mm tall. With a sketch selected in the Model tree, Extrude takes its profile.`
    } else {
      const axis = revolveAxis(picked?.entities ?? [], path)
      const r = revolveProfileCage(path, frame, axis, st.revolveSegments, 48, st.revolveAngle)
      cage = r.cage
      const turn = st.revolveAngle >= 360 ? '' : ` ${+st.revolveAngle.toFixed(2)} degrees${path.closed ? ', its ends capped flat' : ''}`
      notice = from !== null
        ? `Revolved ${from} round ${axis.label}${turn}: ${r.around} points along the profile, ${st.revolveSegments} round${r.poles > 0 ? `, ${r.poles} pole${r.poles === 1 ? '' : 's'} on the axis` : ''}`
        : `Revolve: a 10 x 10 mm square turned round Z${turn || ' into a ring'}. With a sketch selected in the Model tree, Revolve turns its profile.`
    }
    if (!st.applyCage(cage, { topology: true, record: true, startFrom: true, notice })) return
    useFormStore.setState({ sourceBodyId: null, selection: EMPTY_SELECTION, startedFrom: how })
    if (source !== null) depsRef.current.showBody(source, true)
  }, [])

  /** Pull onto the body selected in the Model tree (else the only body): the form's surface onto it. */
  const pullToBody = useCallback(async () => {
    const target = await depsRef.current.selectedBodyMesh?.()
    const st = useFormStore.getState()
    if (target === undefined || target === null) { st.setNotice('Pull to body: select the body to pull onto in the Model tree, then click Pull to body'); return }
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
    if (picked === null || profile === null) { st.setNotice('Loft: select a sketch in the Model tree, then click Loft; each click adds its profile'); return }
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
      st.setNotice(`Loft: ${picked.name} is profile 1; select the next sketch in the Model tree and click Loft again`)
      return
    }
    const r = loftCage(list, 32, rails)
    if ('reason' in r) { st.setNotice(`${r.reason} (${list.length - 1} profile${list.length === 2 ? '' : 's'} kept)`); return }
    loftRef.current = list
    loftRailsRef.current = rails
    overlayRef.current?.setProfileOutlines([])
    const source = st.sourceBodyId
    const railWords = rails.length === 0 ? '' : ` along ${rails.map((p) => p.name).join(', ')}`
    if (!st.applyCage(r.cage, { topology: true, record: true, startFrom: true, notice: `Lofted through ${list.map((p) => p.name).join(', ')}${railWords}: ${r.rings} rings, the skin pulled through every profile${rails.length === 0 ? '' : ' and rail'}; select another sketch and click Loft to add it (an open curve from the first profile to the last is a rail)` })) return
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
    st.startFaceTool({ replace, chain, plane: { origin: [f.origin.x, f.origin.y, f.origin.z], normal: [f.normal.x, f.normal.y, f.normal.z] }, planeWords: `the plane of ${picked.name}` })
  }, [])

  const undo = useCallback(() => useFormStore.getState().undo(), [])
  const redo = useCallback(() => useFormStore.getState().redo(), [])

  const store = useFormStore.getState
  const railSections: RailSection[] = [
    {
      id: 'form-create',
      title: 'Form - start from',
      tools: [...([
        ['box', 'Box', Box],
        ['cylinder', 'Cylinder', Cylinder],
        ['sphere', 'Sphere', Circle],
        ['torus', 'Torus', Donut],
        ['plane', 'Plane', Square],
      ] as const).map(([kind, label, icon]) => ({
        testId: `form-starter-${kind}`,
        label,
        icon,
        active: startedFrom === kind && !faceReplacing,
        title: `Start again from a ${label.toLowerCase()} cage (segment counts in the Form palette)`,
        onClick: () => {
          // WO-2125 audit: a starter replaces a From-body cage, so its source body is no longer hidden - repaint it.
          const source = store().sourceBodyId
          store().newFromStarter(kind)
          if (source !== null) depsRef.current.showBody(source, true)
        },
      })),
      {
        testId: 'form-starter-pipe',
        label: 'Pipe',
        icon: Route,
        active: startedFrom === 'pipe' && !faceReplacing,
        title: 'A tube along the curve of the sketch selected in the Model tree (a straight pipe when none is selected); its radius from the Form palette\'s Pipe row, else automatic. Select a next sketch whose curve starts where the pipe ends and click Pipe again to carry it on, onto other planes too. Edges of a body clicked in the view (Shift+click adds more) come first: the tube runs along them',
        onClick: startPipe,
      },
      {
        testId: 'form-starter-extrude',
        label: 'Extrude',
        icon: ArrowUpFromLine,
        active: startedFrom === 'extrude' && !faceReplacing,
        title: 'A form from the profile of the sketch selected in the Model tree, taken along its plane\'s normal (height in the Form palette)',
        onClick: () => startFromProfile('extrude'),
      },
      {
        testId: 'form-starter-revolve',
        label: 'Revolve',
        icon: Rotate3d,
        active: startedFrom === 'revolve' && !faceReplacing,
        title: 'A form from the profile of the sketch selected in the Model tree, turned round its construction line (else a sketch axis it does not cross) by the Form palette\'s Revolve angle and segments',
        onClick: () => startFromProfile('revolve'),
      },
      {
        testId: 'form-starter-loft',
        label: 'Loft',
        icon: Spline,
        active: startedFrom === 'loft' && !faceReplacing,
        title: 'A form through sketch profiles: select a sketch in the Model tree and click Loft, then the next sketch and Loft again (a third adds a third); the skin passes through each profile. An open curve drawn from the first profile to the last, added the same way, is a rail the sides follow',
        onClick: startLoft,
      },
      {
        testId: 'form-starter-face',
        label: 'Face',
        icon: PenTool,
        active: startedFrom === 'face' || faceReplacing,
        title: 'A new form from faces you click: 4 corners on the plane of the sketch or construction plane selected in the Model tree (else XY at Z = 0) make a face, each next face can share the points of the last; Alt+click a face of the form to work on its plane; Enter makes a triangle of 3, Esc stops',
        onClick: () => startFace(true),
      },
      {
        testId: 'form-starter-body',
        label: 'From body',
        icon: Import,
        active: startedFrom === 'body' && !faceReplacing,
        title: 'Start from the body selected in the Model tree: its flat faces and sharp edges kept, curved faces smoothed (the body itself stays)',
        onClick: () => { void startFromBody() },
      },
      ],
    },
    {
      id: 'form-edit',
      title: 'Edit form',
      tools: [...([
        ['translate', 'Move', Move, 'Move the selection (Alt-drag a face arrow to extrude)'],
        ['rotate', 'Rotate', RotateCw, 'Rotate the selection about its centre'],
        ['scale', 'Scale', Scaling, 'Scale the selection about its centre'],
      ] as const).map(([mode, label, icon, title]) => ({
        testId: `form-transform-${mode}`,
        label,
        icon,
        active: transformMode === mode,
        title,
        onClick: () => store().setTransformMode(mode),
      })),
        { testId: 'form-flatten', label: 'Flatten', icon: RectangleHorizontal, title: 'Put the selected points (or the corners of the selected faces or edges) on a plane: their best fit, or the one chosen in the Form palette (an X, Y or Z plane, the selected face\'s, the mirror\'s)', onClick: () => store().flattenSelection() },
        { testId: 'form-straighten', label: 'Straighten', icon: Ruler, title: 'Put each selected edge chain on the line between its ends (selected points on their best-fit line)', onClick: () => store().straightenSelection() },
        { testId: 'form-make-uniform', label: 'Uniform', icon: Grip, title: 'Even out the spacing of the selected points over the surface (the whole form when nothing is selected); points on the open border or on creases stay', onClick: () => store().makeUniformSelection() },
        ...(SHOW_PULL_TO_BODY ? [{ testId: 'form-pull-body', label: 'Pull to body', icon: Target, title: 'Pull the surface at the selected points (all when nothing is selected) onto the body selected in the Model tree (else the only body), to within its display mesh', onClick: () => { void pullToBody() } }] : []),
        { testId: 'form-pull', label: 'Pull', icon: LocateFixed, title: 'Move the cage so the smooth surface passes through the selected points where they are now (all points when nothing is selected); creases and corners follow their own rules', onClick: () => store().pullSelection() },
      ],
    },
    {
      id: 'form-topology',
      title: 'Topology',
      tools: [
        { testId: 'form-insert-loop', label: 'Insert loop', icon: Rows3, title: 'Insert an edge loop across the ring of the selected edge', onClick: () => store().insertLoop() },
        { testId: 'form-crease', label: 'Crease', icon: Slash, title: 'Crease the selected edges (and the edges of selected faces)', onClick: () => store().crease(true) },
        { testId: 'form-uncrease', label: 'Uncrease', icon: Waves, title: 'Make the selected edges smooth again', onClick: () => store().crease(false) },
        { testId: 'form-insert-point', label: 'Insert point', icon: Dot, title: 'Insert a point in the middle of each selected edge', onClick: () => store().insertPointOnSelection() },
        { testId: 'form-add-face', label: 'Add face', icon: SquarePlus, active: faceTool?.replace === false, title: 'Add faces to this form by clicking 4 corners each: on the work plane, or on the form\'s own points to join them (Enter: a triangle of 3; Esc stops)', onClick: () => startFace(false) },
        { testId: 'form-face-chain', label: 'Chain', icon: Link, active: faceTool?.chain === true, title: 'Chain faces: each face starts the next on its last edge, so a strip takes 2 clicks a face (starts Add face when the Face tool is off; click again to stop chaining)', onClick: () => store().toggleFaceChain() },
        { testId: 'form-subdivide', label: 'Subdivide', icon: Grid3x3, title: 'Split the selected faces into quads round their centres', onClick: () => store().subdivideSelection() },
        { testId: 'form-weld', label: 'Weld', icon: Merge, title: 'Merge the selected points (or the ends of a selected edge) into one', onClick: () => store().weldSelection() },
        { testId: 'form-weld-close', label: 'Weld close', icon: Magnet, title: 'Weld points closer than the Form palette\'s Weld distance - among the selection, or across the form when nothing is selected', onClick: () => store().weldCloseSelection() },
        { testId: 'form-unweld', label: 'Unweld', icon: Unlink, title: 'Cut the form open along the selected edges, or round the selected faces (the points stay where they are, one copy per side)', onClick: () => store().unweldSelection() },
      ],
    },
    {
      id: 'form-select',
      title: 'Select',
      tools: [
        { testId: 'form-select-loop', label: 'Loop', icon: Repeat2, title: 'Add the edge loop of each selected edge (straight on through the points around it)', onClick: () => store().selectLoop() },
        { testId: 'form-select-ring', label: 'Ring', icon: Rows4, title: 'Add the edge ring of each selected edge (across the faces beside it)', onClick: () => store().selectRing() },
        { testId: 'form-select-grow', label: 'Grow', icon: Expand, title: 'Widen the selection by one ring (faces by shared corners, points and edges by their neighbours)', onClick: () => store().growSelection() },
        { testId: 'form-select-shrink', label: 'Shrink', icon: Shrink, title: 'Narrow the selection by one ring from its edge', onClick: () => store().shrinkSelection() },
        { testId: 'form-select-all', label: 'All', icon: SquareDashedMousePointer, title: 'Select every face (or every edge / point when edges / points are selected)', onClick: () => store().selectAll() },
      ],
    },
    {
      id: 'form-openings',
      title: 'Openings',
      tools: [
        { testId: 'form-delete-faces', label: 'Delete', icon: Trash2, title: 'Delete the selected faces (the form is open there); with only edges selected, those edges (the faces either side merge; an edge loop goes whole); with only points selected, those points (the faces round each merge into one)', onClick: () => store().deleteSelection() },
        { testId: 'form-fill-hole', label: 'Fill hole', icon: SquareDashed, title: 'Cap the opening through the selected rim edge with one face', onClick: () => store().fillHoleAtSelection() },
        { testId: 'form-bridge', label: 'Bridge', icon: Link2, title: 'Join two selected faces or face sets, or the edges of two openings or open borders, with a band of faces (segments in the Form palette): a handle, a hole through, or two pieces joined', onClick: () => store().bridgeSelection() },
        { testId: 'form-thicken', label: 'Thicken', icon: Layers, title: 'Close an open form with an inner skin (wall thickness in the Form palette)', onClick: () => store().thickenForm() },
      ],
    },
    {
      id: 'form-symmetry',
      title: 'Symmetry',
      tools: [...([
        ['x', 'Mirror X', FlipHorizontal2, 'Mirror across the YZ plane (X = 0): paired points move together, seam points stay on the plane'],
        ['y', 'Mirror Y', FlipVertical2, 'Mirror across the XZ plane (Y = 0): paired points move together, seam points stay on the plane'],
        ['z', 'Mirror Z', SeparatorHorizontal, 'Mirror across the level plane through the form\'s mid-height: paired points move together, seam points stay on the plane'],
      ] as const).map(([axis, label, icon, title]) => ({
        testId: `form-mirror-${axis}`,
        label,
        icon,
        active: symmetry === axis,
        title,
        onClick: () => store().setSymmetry(symmetry === axis ? null : axis),
      })), {
        testId: 'form-circular',
        label: 'Circular',
        icon: Sun,
        active: symmetry !== null && circularCount(symmetry) !== null,
        title: 'Circular symmetry round the Z axis - as many copies as the form fits, or the Form palette\'s count: each point moves with its rotated copies',
        onClick: () => store().toggleCircular(),
      }, {
        testId: 'form-mirror-selection',
        label: 'Between',
        icon: FoldHorizontal,
        active: symmetry === 'p',
        title: 'Mirror across a plane you place: select two points to mirror onto each other (the plane goes halfway between them), or three or more on the plane you want. The Form palette moves it along its normal',
        onClick: () => store().mirrorFromSelection(),
      }, {
        testId: 'form-mirror-duplicate',
        label: 'Duplicate',
        icon: Copy,
        title: 'Mirror a copy of the form across the mirror plane (X = 0 when no mirror is on) and join the two halves along it: model half, get the whole. The mirror stays on',
        onClick: () => store().mirrorDuplicateForm(),
      }],
    },
    {
      id: 'form-display',
      title: 'Display',
      tools: ([
        ['cage', 'Cage', Grid2x2],
        ['both', 'Both', Eye],
        ['smooth', 'Smooth', Circle],
      ] as const).map(([mode, label, icon]) => ({
        testId: `form-display-${mode}`,
        label,
        icon,
        title: mode === 'both' ? 'Cage over the smooth skin' : mode === 'cage' ? 'The control cage only' : 'The smooth skin only',
        active: displayMode === mode,
        onClick: () => store().setDisplayMode(mode),
      })),
    },
    {
      id: 'form-history',
      title: 'Form history',
      tools: [
        ...(canUndo ? [{ testId: 'form-undo', label: 'Undo', icon: Undo2, title: 'Undo in the form (Ctrl+Z)', onClick: undo }] : []),
        ...(canRedo ? [{ testId: 'form-redo', label: 'Redo', icon: Redo2, title: 'Redo in the form (Ctrl+Shift+Z)', onClick: redo }] : []),
      ],
    },
  ].filter((section) => section.tools.length > 0)

  return { active, bodyEdgeClick, open, finish, cancel: leave, undo, redo, canUndo, canRedo, railSections }
}
