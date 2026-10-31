import { useText } from '../../../i18n'
import { fileDataUrl } from '../../../referenceImage/imageData'
// Relief - relief mode inside the Model screen (WO-2171, image relief stage 1b;
// docs/design/IMAGE-RELIEF-PLAN.md section 4, the Form pattern).
//
// "Relief" on the Model rail opens relief mode: the rail shows the relief
// tools, the Relief palette docks at the viewport's top-left and the height
// map at its top-right. The operator picks a flat face, opens a picture and
// gets the standard's defaults with no other click (Auto runs on open). The
// 3D preview on the part and the 2D map follow every control live. Apply
// commits ONE Model-history feature (opType 'relief', consuming the body);
// editing that feature from the tree reopens relief mode on its picture and
// values, and Apply then edits the same node. Cancel leaves no trace.

import { useCallback, useEffect, useRef, useState } from 'react'
import type * as THREE from 'three'
import { ArrowDownToLine, ArrowUpFromLine, Contrast, ImagePlus, Layers, Map as MapIcon, MousePointerClick, Scan, WandSparkles } from 'lucide-react'
import type { CommandHistory, FeatureDag } from '../../../doc'
import type { SceneRuntime } from '../sceneRuntime'
import type { RailSection } from '../workbench/WorkbenchToolRail'
import { createFeatureCommand } from '../dialogs/createFeatureCommand'
import { EditFeaturePayloadCommand } from '../dialogs/EditFeaturePayloadCommand'
import { nextId } from '../dialogs/nextId'
import { setZebra } from '../../../lib/viewport/lighting/zebra'
import { adjustSmoothPx, autoAdjust, describeAuto, MANUAL_ADJUST, smoothSigmaPx, type AutoParams } from '../../../relief/adjust'
import type { Picture } from '../../../relief/picture'
import { createReliefCompute, type ReliefCompute } from '../../../relief/reliefCompute'
import {
  adjustParamsFor, isMeshRelief, picturePitchMm, previewHeightsFromPicture, previewHeightsFromPoles, reliefFrame, reliefStats, reliefStyleOf, reliefStyleSettings, reliefSurface, statusLine,
  type FaceFrame, type ReliefFrame, type ReliefSettings, type ReliefStats,
} from '../../../relief/reliefHeights'
import {
  isReliefFeaturePayload, pictureOf, reliefBaseName, reliefRowName, type ReliefFeaturePayload, type ReliefImage, type ReliefKernelFields,
} from '../../../relief/reliefFeature'
import type { ReliefPoles } from '../../../relief/reliefStep'
import { ReliefPreview, RELIEF_PREVIEW_CELLS } from './reliefPreview'
import { useReliefStore, type ReliefFaceTarget } from './reliefStore'
import { reliefModePort } from './reliefModePort'
import { railSignature } from '../form/modePort'

export type ReliefFaceLookup =
  | { flat: true; face: FaceFrame; bodyName: string }
  | { flat: false; surfaceType: string }

export interface ReliefSessionDeps {
  runtime: SceneRuntime | null
  canvasRef: { readonly current: HTMLCanvasElement | null }
  dag: FeatureDag
  history: CommandHistory
  /** the page's post-Apply hand-off (select, regen, console line) */
  onApplied(featureId: string): void
  /** show or hide a body's presentation (editing shows the body under the relief) */
  showBody(featureId: string, visible: boolean): void
  /** the face last clicked in the Model screen, if any */
  selectedFace(): { ownerId: string; faceId: string } | null
  /** the face of a live body under a canvas click */
  faceAt(clientX: number, clientY: number): { ownerId: string; faceId: string } | null
  /** a face of a live body: its frame when it is flat */
  faceTarget(ownerId: string, faceId: string): Promise<ReliefFaceLookup | null>
  /** the displayed mesh of a body (its face is clipped where the preview shows) */
  ownerMesh(ownerId: string): THREE.Mesh | undefined
  /** build the relief in the kernel without committing anything: null when it builds, else the reason it does not */
  tryRelief(ownerId: string, faceId: string, fields: ReliefKernelFields): Promise<string | null>
  /** one console line (COHESION-STANDARD s13) */
  log(severity: 'info' | 'success' | 'warning' | 'error', message: string): void
  /** the Model screen's zebra display reaches the preview too */
  zebra?: boolean
}

/** What the preview settled on: the applied surface, drawn by the 3D preview and the 2D map. */
export interface ReliefSettled {
  /** the settings it was made from */
  settings: ReliefSettings
  frame: ReliefFrame
  heights: Float32Array
  n: number
  poles: ReliefPoles
  stats: ReliefStats
  /** WO-2174: the adjusted picture it was made from (the 2D map's After view) */
  adjusted: Float32Array
}

export interface ReliefSession {
  active: boolean
  /** open relief mode: a new relief, or the values of an existing relief feature */
  open(featureId?: string): void
  apply(): void
  cancel(): void
  /** a picture file chosen by the operator */
  openFile(file: File): Promise<void>
  /** the palette's hidden file input, so the rail's Open image reaches it */
  fileInputRef: { current: HTMLInputElement | null }
  /** a canvas click while relief mode is open: pick the face under it */
  pickAt(clientX: number, clientY: number): void
  settled(): ReliefSettled | null
  railSections: RailSection[]
}

/** Test/evidence hook, same convention as window.__formStore. */
declare global {
  interface Window {
    __reliefStore?: typeof useReliefStore
    /** settleMs: page-thread time of each refine; refineMs: from its start to the settled preview (worker time included); liveMs: each live update */
    __reliefTimings?: { settleMs: number[]; liveMs: number[]; refineMs: number[] }
    __reliefSettled?: () => ReliefSettled | null
  }
}

const SETTLE_DELAY_MS = 60

export function useReliefSession(deps: ReliefSessionDeps): ReliefSession {
  const workbenchText = useText('sketch-and-model-workbench')
  const active = useReliefStore((s) => s.active)
  // the rail reads only what its buttons show - a slider drag re-renders the palette, never the Model page (S9)
  const ready = useReliefStore((s) => s.settings !== null)
  const style = useReliefStore((s) => (s.settings === null ? null : reliefStyleOf(s.settings)))
  const inverted = useReliefStore((s) => s.settings?.invert === true)
  const autoOn = useReliefStore((s) => s.settings?.auto === true)
  const hasPicture = useReliefStore((s) => s.picture !== null)
  const mapShown = useReliefStore((s) => s.mapView)
  const depsRef = useRef(deps)
  useEffect(() => { depsRef.current = deps })
  const previewRef = useRef<ReliefPreview | null>(null)
  const settledRef = useRef<ReliefSettled | null>(null)
  const adjustedRef = useRef<{ picture: Picture; key: string; adjusted: Float32Array } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const editRef = useRef<{ featureId: string; ownerId: string } | null>(null)

  // the picture work (decode, Auto, filters) runs in the relief worker (S9)
  const computeRef = useRef<ReliefCompute | null>(null)
  const compute = useCallback((): ReliefCompute => (computeRef.current ??= createReliefCompute()), [])
  useEffect(() => () => { computeRef.current?.dispose(); computeRef.current = null }, [])

  /** The adjusted picture for the current settings, filtered once per picture / Auto / smoothing size (in the worker). */
  const adjustedFor = useCallback(async (picture: Picture, auto: AutoParams, s: ReliefSettings): Promise<Float32Array> => {
    const params = adjustParamsFor(auto, MANUAL_ADJUST, s)
    const pitch = picturePitchMm(picture, s)
    // WO-2174: filtered again when an adjustment value or a size it is set in mm for changes
    const key = 'channel' in params
      ? `${JSON.stringify({ ...params, smoothMm: 0, smoothPx: 0, edgeSmoothMm: 0 })}|${adjustSmoothPx(params, pitch).toFixed(3)}|${(params.edgeSmoothMm / pitch).toFixed(3)}`
      : `${s.auto}|${smoothSigmaPx(params, pitch).toFixed(3)}`
    const c = adjustedRef.current
    if (c !== null && c.picture === picture && c.key === key) return c.adjusted
    const adjusted = await compute().adjust(picture, params, pitch)
    adjustedRef.current = { picture, key, adjusted }
    return adjusted
  }, [compute])

  // the zebra display reaches the preview while relief mode is open
  const zebra = deps.zebra === true
  useEffect(() => {
    const p = previewRef.current
    if (p === null) return
    setZebra(p.material, zebra)
    deps.runtime?.requestRender()
  }, [zebra, active, deps.runtime])

  // the preview lives exactly while relief mode is open and the viewport exists
  const { runtime } = deps
  useEffect(() => {
    if (!active || runtime === null) return
    const preview = new ReliefPreview({
      addObject: (o) => runtime.addObject(o),
      removeObject: (o) => runtime.removeObject(o),
      requestRender: () => runtime.requestRender(),
    })
    previewRef.current = preview
    setZebra(preview.material, depsRef.current.zebra === true)
    if (import.meta.env.DEV) {
      window.__reliefStore = useReliefStore
      window.__reliefTimings = { settleMs: [], liveMs: [], refineMs: [] }
      window.__reliefSettled = () => settledRef.current
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    let token = 0
    let alive = true
    /** Let the page draw between slices, so no piece of the refine holds it for long (S9). */
    const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    const settle = async () => {
      timer = null
      const mine = ++token
      const stale = () => !alive || mine !== token
      const { settings: s, picture, target, autoParams: auto } = useReliefStore.getState()
      if (s === null || picture === null || target === null || auto === null) return
      const started = performance.now()
      let adjusted: Float32Array
      try {
        adjusted = await adjustedFor(picture, auto, s)
      } catch (e) {
        if (!stale()) useReliefStore.getState().setNotice(workbenchText('useReliefSession.thePictureCouldNotBeAdjusted', { value1: String(e instanceof Error ? e.message : String(e)) }))
        return
      }
      if (stale()) return
      let pageMs = 0
      let t = performance.now()
      preview.setLive(adjusted, picture.cols, picture.rows, s)
      const { grid, poles } = reliefSurface(adjusted, picture, s)
      pageMs += performance.now() - t
      await yieldToPage()
      if (stale()) return
      t = performance.now()
      const n = RELIEF_PREVIEW_CELLS
      // WO-2200: a mesh relief is built from the working grid, so the preview draws that; an exact one its poles
      const mesh = isMeshRelief(grid)
      const heights = mesh ? previewHeightsFromPicture(adjusted, picture, s, n) : previewHeightsFromPoles(poles, n)
      pageMs += performance.now() - t
      await yieldToPage()
      if (stale()) return
      t = performance.now()
      const stats = reliefStats(grid, poles, undefined, mesh ? { heights, n } : undefined)
      const frame = reliefFrame(target.face, s)
      settledRef.current = { settings: s, frame, heights, n, poles, stats, adjusted }
      preview.setSettled(heights, n)
      const st = useReliefStore.getState()
      st.setStatus(statusLine(stats, s.direction, s))
      st.bumpSettled()
      pageMs += performance.now() - t
      window.__reliefTimings?.settleMs.push(pageMs)
      window.__reliefTimings?.refineMs.push(performance.now() - started)
    }
    const update = () => {
      const st = useReliefStore.getState()
      const { settings: s, picture, target, autoParams: auto } = st
      if (s === null || picture === null || target === null || auto === null) {
        preview.hide()
        settledRef.current = null
        return
      }
      const t0 = performance.now()
      const frame = reliefFrame(target.face, s)
      preview.setPlacement(frame)
      preview.clipOwner(depsRef.current.ownerMesh(target.ownerId), frame)
      // live: the last adjusted picture (a new smoothing size is filtered when the drag settles;
      // until the first one arrives, the picture as it is)
      const c = adjustedRef.current
      preview.setLive(c !== null && c.picture === picture ? c.adjusted : picture.grey, picture.cols, picture.rows, s)
      window.__reliefTimings?.liveMs.push(performance.now() - t0)
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { void settle() }, SETTLE_DELAY_MS)
    }
    update()
    const unsubscribe = useReliefStore.subscribe((s, prev) => {
      if (s.settings !== prev.settings || s.picture !== prev.picture || s.target !== prev.target || s.autoParams !== prev.autoParams) update()
    })
    return () => {
      alive = false
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
      preview.dispose()
      previewRef.current = null
      settledRef.current = null
      if (import.meta.env.DEV) window.__reliefSettled = () => null
    }
  }, [active, runtime, adjustedFor])

  const lookUpFace = useCallback(async (ownerId: string, faceId: string): Promise<void> => {
    const st = useReliefStore.getState()
    const found = await depsRef.current.faceTarget(ownerId, faceId)
    if (!useReliefStore.getState().active) return
    if (found === null) { st.setNotice(workbenchText('useReliefSession.clickAFlatFaceOnThePartToLay')); return }
    if (!found.flat) {
      st.setNotice(workbenchText('useReliefSession.thatFaceIsCurvedFacesComeInALater', { value1: String(found.surfaceType === 'cylinder' ? 'round' : 'curved') }))
      return
    }
    const target: ReliefFaceTarget = { ownerId, faceId, face: found.face, bodyName: found.bodyName }
    st.setTarget(target)
  }, [])

  const open = useCallback((featureId?: string) => {
    const { dag } = depsRef.current
    const st = useReliefStore.getState()
    if (featureId !== undefined) {
      const node = dag.getNode(featureId)
      if (node === undefined || node.kind !== 'feature' || !isReliefFeaturePayload(node.payload)) return
      const p = node.payload
      const faceId = node.refs.find((r) => r.kind === 'single-face')?.id ?? ''
      st.openSession({
        featureId,
        name: reliefBaseName(p.name),
        target: { ownerId: p.ownerId, faceId, face: p.face, bodyName: p.ownerId },
        image: p.image,
        autoParams: p.autoParams,
        settings: p.settings,
      })
      // edit on the body under the relief: the relief's own body hides while it is open
      editRef.current = { featureId, ownerId: p.ownerId }
      depsRef.current.showBody(featureId, false)
      depsRef.current.showBody(p.ownerId, true)
      void pictureOf(p.image).then((picture) => {
        const now = useReliefStore.getState()
        if (now.active && now.featureId === featureId) useReliefStore.setState(p.settings.adjust === undefined ? { picture, autoAdjust: autoAdjust(picture, p.autoParams) } : { picture })
      }).catch((e) => useReliefStore.getState().setNotice(workbenchText('useReliefSession.theStoredPictureCouldNotBeRead', { value1: String(e instanceof Error ? e.message : String(e)) })))
      return
    }
    editRef.current = null
    const id = nextId(dag, 'REL')
    st.openSession({ featureId: null, name: workbenchText('useReliefSession.relief', { value1: String(id.slice(3)) }) })
    const picked = depsRef.current.selectedFace()
    if (picked !== null) void lookUpFace(picked.ownerId, picked.faceId)
    else st.setNotice(workbenchText('useReliefSession.clickAFlatFaceOnThePartThenOpen'))
  }, [lookUpFace])

  const leave = useCallback(() => {
    const edit = editRef.current
    editRef.current = null
    previewRef.current?.hide()
    if (edit !== null) {
      depsRef.current.showBody(edit.ownerId, false)
      depsRef.current.showBody(edit.featureId, true)
    }
    useReliefStore.getState().closeSession()
  }, [])

  const openFile = useCallback(async (file: File) => {
    const st = useReliefStore.getState()
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const mime = file.type || (file.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
      const { picture, auto, autoAdjust: autoValues, sourceCols, sourceRows } = await compute().open(bytes, mime)
      const image: ReliefImage = { dataUrl: await fileDataUrl(file, bytes, mime), fileName: file.name, cols: sourceCols, rows: sourceRows, bitDepth: picture.bitDepth }
      const decoded = { cols: sourceCols, rows: sourceRows, bitDepth: picture.bitDepth }
      if (!useReliefStore.getState().active) return
      st.setPicture(image, picture, auto, autoValues)
      const s = useReliefStore.getState().settings
      const line = describeAuto(auto, s === null ? 0.1 : picturePitchMm(picture, s))
      useReliefStore.getState().setStatus(useReliefStore.getState().status, line)
      depsRef.current.log('info', workbenchText('useReliefSession.xBit', { value1: String(useReliefStore.getState().name), name: String(file.name), cols: String(decoded.cols), rows: String(decoded.rows), bitDepth: String(decoded.bitDepth), line: String(line) }))
      if (useReliefStore.getState().target === null) useReliefStore.getState().setNotice(workbenchText('useReliefSession.nowClickAFlatFaceOnThePartTo'))
    } catch (e) {
      st.setNotice(workbenchText('useReliefSession.couldNotBeOpenedAsAPicture', { name: String(file.name), value2: String(e instanceof Error ? e.message : String(e)) }))
    }
  }, [compute])

  const pickAt = useCallback((clientX: number, clientY: number) => {
    const st = useReliefStore.getState()
    if (!st.active || st.featureId !== null) return // an edited relief stays on its face
    const hit = depsRef.current.faceAt(clientX, clientY)
    if (hit === null) return
    void lookUpFace(hit.ownerId, hit.faceId)
  }, [lookUpFace])

  const apply = useCallback(() => {
    void (async () => {
      const st = useReliefStore.getState()
      const { settings: s, picture, target, image, autoParams: auto } = st
      if (st.applying || s === null || picture === null || target === null || image === null || auto === null) return
      st.setApplying(true)
      try {
        // the poles the preview settled on, unless a control moved since
        const settled = settledRef.current
        const poles = settled !== null && settled.settings === s ? settled.poles : reliefSurface(await adjustedFor(picture, auto, s), picture, s).poles
        const fields: ReliefKernelFields = { frame: reliefFrame(target.face, s), poles }
        const why = await depsRef.current.tryRelief(target.ownerId, target.faceId, fields)
        const now = useReliefStore.getState()
        if (!now.active) return
        if (why !== null) {
          now.setNotice(workbenchText('useReliefSession.applyDidNotBuild', { why: String(why) }))
          depsRef.current.log('error', workbenchText('useReliefSession.refused', { value1: String(now.name), value2: String(why) }))
          return
        }
        const { dag, history, onApplied } = depsRef.current
        // WO-2200: the tree row says "mesh relief" when the working grid is finer than an exact face may be
        const payload: ReliefFeaturePayload = {
          opType: 'relief', name: reliefRowName(now.name, s), ownerId: target.ownerId, image, face: target.face, settings: { ...s }, autoParams: auto,
        }
        let id = now.featureId
        if (id !== null && dag.getNode(id)?.kind === 'feature') {
          history.execute(new EditFeaturePayloadCommand(id, { ...dag.getNode(id)!.payload, ...payload }))
        } else {
          id = nextId(dag, 'REL')
          history.execute(createFeatureCommand(dag, {
            id, kind: 'feature', consumes: [target.ownerId], refs: [{ id: target.faceId, kind: 'single-face' }], payload: { ...payload },
          }))
        }
        editRef.current = null
        previewRef.current?.hide()
        const status = useReliefStore.getState().status
        useReliefStore.getState().closeSession()
        onApplied(id)
        // a mesh relief says once, in the console, what it is and where its full detail goes
        if (payload.name !== now.name && status !== null) depsRef.current.log('info', `${payload.name}: ${status}`)
      } finally {
        useReliefStore.getState().setApplying(false)
      }
    })()
  }, [adjustedFor])

  const store = useReliefStore.getState
  const railSections: RailSection[] = [
    {
      id: 'relief-image',
      title: workbenchText('useReliefSession.reliefImage'),
      tools: [
        { testId: 'relief-open-image', label: workbenchText('useReliefSession.openImage'), icon: ImagePlus, title: workbenchText('useReliefSession.openAPNGOrJPG8Or16Bit'), onClick: () => fileInputRef.current?.click() },
      ],
    },
    {
      id: 'relief-place',
      title: workbenchText('useReliefSession.place'),
      tools: [
        { testId: 'relief-pick-face', label: workbenchText('useReliefSession.pickFace'), icon: MousePointerClick, title: workbenchText('useReliefSession.clickAFlatFaceOnThePartToLay2'), onClick: () => store().setNotice(workbenchText('useReliefSession.clickAFlatFaceOnThePartToLay')) },
        { testId: 'relief-fit', label: workbenchText('useReliefSession.fitToFace'), icon: Scan, disabled: !ready, title: workbenchText('useReliefSession.fitThePictureInsideTheFaceAgainCentredProportions'), onClick: () => store().fitToFace() },
      ],
    },
    {
      id: 'relief-height',
      title: workbenchText('useReliefSession.height'),
      tools: [
        { testId: 'relief-raise', label: workbenchText('useReliefSession.raise'), icon: ArrowUpFromLine, disabled: !ready, active: style === 'raise', title: workbenchText('useReliefSession.theSubjectStandsProudOfTheFace'), onClick: () => store().setSettings(reliefStyleSettings('raise')) },
        { testId: 'relief-emboss', label: workbenchText('useReliefSession.emboss'), icon: Layers, disabled: !ready, active: style === 'emboss', title: workbenchText('useReliefSession.theSubjectStaysAtTheFaceEverythingAroundIt'), onClick: () => store().setSettings(reliefStyleSettings('emboss')) },
        { testId: 'relief-engrave', label: workbenchText('useReliefSession.engrave'), icon: ArrowDownToLine, disabled: !ready, active: style === 'engrave', title: workbenchText('useReliefSession.theSubjectCutsIntoTheFaceToTheDepth'), onClick: () => store().setSettings(reliefStyleSettings('engrave')) },
        { testId: 'relief-invert', label: workbenchText('useReliefSession.invert'), icon: Contrast, disabled: !ready, active: inverted, title: workbenchText('useReliefSession.darkIsHighInsteadOfLight'), onClick: () => store().setSettings({ invert: !(store().settings?.invert ?? false) }) },
      ],
    },
    {
      id: 'relief-adjust',
      title: workbenchText('useReliefSession.adjust'),
      tools: [
        { testId: 'relief-auto', label: workbenchText('useReliefSession.auto'), icon: WandSparkles, disabled: !hasPicture || !ready, active: autoOn, title: workbenchText('useReliefSession.autoAdjustsThePictureForACleanReliefRuns'), onClick: () => store().setAuto(!(store().settings?.auto ?? true)) },
      ],
    },
    {
      id: 'relief-preview',
      title: workbenchText('useReliefSession.preview'),
      tools: [
        { testId: 'relief-map-height', label: workbenchText('useReliefSession.heightMap'), icon: MapIcon, active: mapShown === 'height', title: workbenchText('useReliefSession.the2DMapShowsTheHeightsLightHigh'), onClick: () => store().setMapView('height') },
        { testId: 'relief-map-shaded', label: workbenchText('useReliefSession.shaded'), icon: MapIcon, active: mapShown === 'shaded', title: workbenchText('useReliefSession.the2DMapShowsTheReliefLitFromThe'), onClick: () => store().setMapView('shaded') },
      ],
    },
  ]

  const settled = useCallback(() => settledRef.current, [])

  const session: ReliefSession = { active, open, apply, cancel: leave, openFile, fileInputRef, pickAt, settled, railSections }
  // WO-3301: the New UI ribbon reaches this session through the port; the page's own rail still reads the return value
  const [owner] = useState(() => ({}))
  useEffect(() => { reliefModePort.update(session, railSignature(active, railSections), owner) })
  useEffect(() => () => reliefModePort.release(owner), [owner])
  return session
}
