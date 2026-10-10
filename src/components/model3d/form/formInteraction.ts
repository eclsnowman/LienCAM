// Form - pointer and gizmo interaction inside the Model screen's viewport.
//
// Click picks a cage point / edge / face (Shift or Ctrl adds or toggles);
// hovering lights what a click would take; the selection gets the Model
// screen's transform gizmo (TransformControlsAdapter) at its centroid, in
// move / rotate / scale. Holding Alt when a move drag starts extrudes the
// selected faces first, so the drag pulls the new faces out. With mirror
// symmetry on, the store mirrors the move (formStore beginMove / moveBy).
//
// With a mirror on, a press on the mirror plane (not on the cage or the
// gizmo) grabs it: dragging slides it along its normal (form/mirrorDrag.ts),
// the seam and the pairs following live; orbit is held off meanwhile.
//
// With the Face tool on (formStore faceTool) a click is a corner instead: an
// existing cage point under the pointer, else where the ray meets the work
// plane; the corners so far are drawn with a line to the pointer, Enter makes
// a triangle of three, Esc stops. Alt+click on a face of the form makes its
// plane the work plane. So the next click is seen before it is made, a marker
// sits where the next corner would land and, once corners are clicked, a
// translucent ghost of the face (the corners plus the pointer) follows the
// pointer. Draft, marker and ghost are display only: never in the store.
//
// A drag that starts on empty space (no cage point, edge or face, no move arrow,
// no mirror plane; Face tool off, Alt up) draws a box instead of orbiting: on
// release every cage point inside it the skin does not hide is selected; Shift
// adds them, Ctrl takes them out. A press there that does not move is still a
// click, and clears the selection as before. Esc drops the box.
//
// A click that is not on a cage point or cage edge goes on to the host too: the
// Model screen picks the body edge under it (one the smooth skin does not hide
// wins over a cage face there), and Pipe runs along the picked body edges.
//
// After a tool runs, what it changed flashes in its own colour (formStore resultFlash) with the gizmo held
// back; any press on the canvas ends the flash at once, so it never blocks a click, drag or orbit.
//
// Listeners are attached to the host canvas only while form mode is open; the
// page's own click / hover handlers step aside while it is (one early return).

import * as THREE from 'three'
import { useFormStore, type BoxSelectMode } from '../../../form/formStore'
import type { FormOverlay } from '../../../form/formOverlay'
import { pointerRay, type CagePick } from '../../../form/pick'
import { rayOnPlane, type FaceClick } from '../../../form/faceByClicks'
import type { Vec3 } from '../../../form/cage'
import { asNumber } from '../../../theme/viewportColors'
import { centroidOf, isSelectionEmpty, selectionPoints } from '../../../form/topology'
import { circularCount, mirrorNormal } from '../../../form/symmetry'
import { slideAlongNormal, slidMirrorAt } from '../../../form/mirrorDrag'
import {
  createDefaultTransformControlsAdapter,
  type CreateTransformControlsAdapter,
  type TransformControlsAdapter,
} from '../gizmos/TransformControlsAdapter'

export interface FormInteractionHost {
  canvas: HTMLCanvasElement
  camera(): THREE.Camera
  addObject(obj: THREE.Object3D): void
  removeObject(obj: THREE.Object3D): void
  requestRender(): void
  setOrbitEnabled(enabled: boolean): void
  /**
   * A click on no cage point or edge (Face tool off): the host picks the body edge there, if `visible` says
   * the skin does not hide it; true when it took one. `clearOnMiss`: no edge there clears the body-edge picks.
   */
  bodyEdgeClick?(clientX: number, clientY: number, additive: boolean, opts: { clearOnMiss: boolean; visible: (world: Vec3) => boolean }): boolean
}

/** A press that moves less than this (CSS px) before release is a click, not an orbit. */
const CLICK_SLOP_PX = 4

export class FormInteraction {
  private readonly host: FormInteractionHost
  private readonly overlay: FormOverlay
  private readonly gizmo: TransformControlsAdapter
  private readonly pivot = new THREE.Object3D()
  private hover: CagePick | null = null
  private down: { x: number; y: number; alt: boolean; additive: boolean; onGizmo: boolean } | null = null
  private drag: { start: THREE.Matrix4 } | null = null
  /** a mirror plane being dragged: where it was grabbed, its normal, and where it was then */
  private mirrorDrag: { grab: Vec3; normal: Vec3; at: number; pointerId: number } | null = null
  /** a box drag from empty space: where it started and where the pointer is now (CSS px, canvas-relative) */
  private box: { x: number; y: number; toX: number; toY: number; mode: BoxSelectMode; pointerId: number; moved: boolean; dropped: boolean } | null = null
  /** the box as drawn over the view while it is dragged */
  private boxShape: HTMLDivElement | null = null
  /** fingers on the view now: a second one makes the press a pinch or pan for the orbit controls, not a box */
  private readonly touches = new Set<number>()
  private hoverFrame = 0
  private pendingHover: { x: number; y: number } | null = null
  private disposed = false
  private readonly unsubscribe: () => void
  /** the Face tool's corners so far, and a line from the last to the pointer */
  private readonly draft: THREE.LineSegments
  private readonly draftPoints: THREE.Points
  /** where the next corner would land, and the face the corners so far and the pointer make */
  private readonly marker: THREE.Points
  private readonly ghost: THREE.Mesh
  private cursor: Vec3 | null = null

  constructor(host: FormInteractionHost, overlay: FormOverlay, createAdapter: CreateTransformControlsAdapter = createDefaultTransformControlsAdapter) {
    this.host = host
    this.overlay = overlay
    this.pivot.name = 'form-gizmo-pivot'
    host.addObject(this.pivot)
    this.gizmo = createAdapter(host.camera(), host.canvas)
    this.gizmo.setSpace('world')
    this.gizmo.setMode(useFormStore.getState().transformMode)
    host.addObject(this.gizmo.getHelper())
    this.gizmo.addEventListener('change', this.onGizmoChange)
    this.gizmo.addEventListener('dragging-changed', this.onDraggingChanged)
    this.gizmo.addEventListener('objectChange', this.onObjectChange)
    // capture: runs before the gizmo's own pointerdown, so Alt and "on the gizmo" are read first
    host.canvas.addEventListener('pointerdown', this.onPointerDown, true)
    host.canvas.addEventListener('pointermove', this.onPointerMove)
    host.canvas.addEventListener('pointerup', this.onPointerUp)
    host.canvas.addEventListener('pointerleave', this.onPointerLeave)
    host.canvas.addEventListener('pointercancel', this.onPointerCancel)
    host.canvas.addEventListener('dblclick', this.onDoubleClick)
    // a finger lifted off the view (a pinch that ends outside it) is forgotten too, so the next lone finger boxes
    window.addEventListener('pointerup', this.onFingerGone, true)
    window.addEventListener('pointercancel', this.onFingerGone, true)
    window.addEventListener('keydown', this.onKeyDown)
    this.unsubscribe = useFormStore.subscribe((s, prev) => {
      if (s.transformMode !== prev.transformMode) this.gizmo.setMode(s.transformMode)
      const flashed = s.resultFlash !== prev.resultFlash
      if (!this.drag && (s.selection !== prev.selection || s.cage !== prev.cage || flashed)) this.placeGizmo()
      if (s.selection !== prev.selection || s.cage !== prev.cage || flashed) this.paintHighlight()
      if (s.faceTool !== prev.faceTool) { if (s.faceTool === null) this.cursor = null; this.paintDraft() }
    })
    this.draft = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: asNumber('--vp-select-amber'), depthTest: false, transparent: true }))
    this.draft.name = 'form-face-draft'
    this.draft.renderOrder = 7
    this.draftPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: asNumber('--vp-select-amber'), size: 9, sizeAttenuation: false, depthTest: false, transparent: true }))
    this.draftPoints.name = 'form-face-draft-points'
    this.draftPoints.renderOrder = 8
    this.marker = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: asNumber('--vp-select-amber'), size: 14, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.75 }))
    this.marker.name = 'form-face-marker'
    this.marker.renderOrder = 8
    // above the skin, under the cage's lines and points (renderOrder 2+), so it never hides the cage
    this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: asNumber('--vp-select-amber'), transparent: true, opacity: 0.25, depthTest: false, depthWrite: false, side: THREE.DoubleSide }))
    this.ghost.name = 'form-face-ghost'
    this.ghost.renderOrder = 1
    host.addObject(this.draft)
    host.addObject(this.draftPoints)
    host.addObject(this.marker)
    host.addObject(this.ghost)
    this.placeGizmo()
    this.paintHighlight()
    this.paintDraft()
  }

  /** The corner a click at (x, y) makes: a cage point under the pointer, else the ray on the work plane. */
  faceClickAt(x: number, y: number): FaceClick | null {
    const s = useFormStore.getState()
    if (s.faceTool === null) return null
    const pick = this.overlay.pickAt(x, y)
    if (pick?.kind === 'point') return { point: pick.index }
    const r = this.host.canvas.getBoundingClientRect()
    const camera = this.host.camera()
    const ray = pointerRay(camera, r.width, r.height, x, y).ray
    // an orthographic view has no "behind": its rays start on the camera's own plane, so a part of the work
    // plane the pointer is over may lie behind that start - start the ray well back along itself instead
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera === true) ray.origin.addScaledVector(ray.direction, -1e6)
    const at = rayOnPlane([ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z], s.faceTool.plane)
    return at === null ? null : { at }
  }

  private paintDraft(): void {
    const s = useFormStore.getState()
    const clicks = s.faceTool?.clicks ?? []
    const pts = clicks.map((c) => ('point' in c ? s.cage.positions[c.point] : c.at))
    const segs: number[] = []
    for (let i = 0; i + 1 < pts.length; i++) segs.push(...pts[i], ...pts[i + 1])
    if (pts.length > 0 && this.cursor !== null) segs.push(...pts[pts.length - 1], ...this.cursor)
    this.draft.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
    this.draftPoints.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3))
    this.draft.visible = this.draftPoints.visible = s.faceTool !== null
    // the marker: where the next click lands; the ghost: the face the corners so far and the pointer make
    this.marker.geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.cursor ?? [], 3))
    const ring = this.cursor === null ? [] : [...pts, this.cursor]
    const tris: number[] = []
    for (let i = 1; i + 1 < ring.length; i++) tris.push(...ring[0], ...ring[i], ...ring[i + 1])
    this.ghost.geometry.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3))
    this.marker.visible = s.faceTool !== null && this.cursor !== null
    this.ghost.visible = s.faceTool !== null && tris.length > 0
    for (const o of [this.draft, this.draftPoints, this.marker, this.ghost]) {
      // bounds follow the new points: a stale sphere left where they were culls them once a pan moves it off view
      o.geometry.computeBoundingSphere()
      // the token read again, so a colour-mode switch shows on the next paint
      ;(o.material as THREE.LineBasicMaterial).color.setHex(asNumber('--vp-select-amber'))
    }
    this.host.requestRender()
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.host.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  /** The gizmo sits at the centroid of everything the selection moves; hidden when nothing is selected, and while a tool's result flashes. */
  placeGizmo(): void {
    const s = useFormStore.getState()
    if (isSelectionEmpty(s.selection) || s.resultFlash !== null) {
      this.gizmo.detach()
      this.host.requestRender()
      return
    }
    const c = centroidOf(s.cage, selectionPoints(s.cage, s.selection))
    this.pivot.position.set(c[0], c[1], c[2])
    this.pivot.rotation.set(0, 0, 0)
    this.pivot.scale.set(1, 1, 1)
    this.pivot.updateMatrixWorld(true)
    this.gizmo.attach(this.pivot)
    this.host.requestRender()
  }

  private paintHighlight(): void {
    const s = useFormStore.getState()
    this.overlay.setHighlight(s.cage, s.selection, this.hover, s.resultFlash)
  }

  private readonly onGizmoChange = (): void => {
    this.host.requestRender()
  }

  private readonly onDraggingChanged = (event: { value?: boolean }): void => {
    const dragging = event.value === true
    this.host.setOrbitEnabled(!dragging)
    const store = useFormStore.getState()
    if (dragging) {
      // the store owns the move: extrude first on Alt, mirror when symmetry is on
      store.beginMove({ extrude: this.down?.alt === true && store.transformMode === 'translate' && store.selection.faces.length > 0 })
      this.pivot.updateMatrixWorld(true)
      this.drag = { start: this.pivot.matrixWorld.clone() }
    } else if (this.drag) {
      this.drag = null
      store.endDrag()
      this.placeGizmo()
    }
  }

  private readonly onObjectChange = (): void => {
    const drag = this.drag
    if (!drag) return
    this.pivot.updateMatrixWorld(true)
    const delta = this.pivot.matrixWorld.clone().multiply(drag.start.clone().invert())
    useFormStore.getState().moveBy(delta.elements)
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    // a press of any kind (a pick, a drag, an orbit) ends a result flash; the arrows come back under it
    if (useFormStore.getState().resultFlash !== null) useFormStore.getState().clearResultFlash()
    if (e.button !== 0) return
    // the browser marks the first finger of a fresh touch as primary: no other finger is down then
    if (e.pointerType === 'touch' && e.isPrimary === true) this.touches.clear()
    const fingers = this.touches.size
    if (e.pointerType === 'touch') this.touches.add(e.pointerId)
    const p = this.local(e)
    // the adapter exposes the hovered handle as `axis` on the real TransformControls
    const axis = (this.gizmo as unknown as { axis?: string | null }).axis
    this.down = { ...p, alt: e.altKey, additive: e.shiftKey || e.ctrlKey || e.metaKey, onGizmo: axis !== null && axis !== undefined }
    if (!this.down.onGizmo && this.grabMirrorAt(p.x, p.y, e.pointerId)) {
      this.host.setOrbitEnabled(false)
      this.host.canvas.setPointerCapture?.(e.pointerId)
    } else if (e.pointerType === 'touch' && fingers > 0) {
      // a second finger: two-finger navigation. The box is dropped without selecting and the moves reach orbit
      this.endBox()
    } else if (!this.down.onGizmo && !e.altKey && useFormStore.getState().faceTool === null && this.overlay.pickAt(p.x, p.y) === null) {
      // empty space: a drag draws a box; no move stays a click. Orbit never sees the box's moves (onPointerMove
      // stops them here, before the orbit controls' own listeners on the document), so the view stays put
      const mode: BoxSelectMode = e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'remove' : 'replace'
      this.box = { x: p.x, y: p.y, toX: p.x, toY: p.y, mode, pointerId: e.pointerId, moved: false, dropped: false }
      this.host.canvas.setPointerCapture?.(e.pointerId)
    }
  }

  /** Follow the pointer with the box; it shows once the press has moved past a click. */
  private dragBoxTo(x: number, y: number): void {
    const b = this.box
    if (b === null || b.dropped) return
    b.toX = x
    b.toY = y
    if (!b.moved && Math.hypot(x - b.x, y - b.y) > CLICK_SLOP_PX) b.moved = true
    if (!b.moved) return
    const r = this.host.canvas.getBoundingClientRect()
    let shape = this.boxShape
    if (shape === null) {
      shape = this.boxShape = document.createElement('div')
      shape.dataset.testid = 'form-box-select'
      const amber = `#${asNumber('--vp-select-amber').toString(16).padStart(6, '0')}`
      Object.assign(shape.style, { position: 'fixed', pointerEvents: 'none', zIndex: '5', border: `1px dashed ${amber}`, background: `${amber}1f`, boxSizing: 'border-box' })
      document.body.appendChild(shape)
    }
    Object.assign(shape.style, {
      left: `${r.left + Math.min(b.x, x)}px`, top: `${r.top + Math.min(b.y, y)}px`,
      width: `${Math.abs(x - b.x)}px`, height: `${Math.abs(y - b.y)}px`,
    })
  }

  /** Drop the box (drawn shape, pointer capture); returns it as it was. */
  private endBox(): FormInteraction['box'] {
    const b = this.box
    if (b === null) return null
    this.box = null
    this.boxShape?.remove()
    this.boxShape = null
    this.host.canvas.releasePointerCapture?.(b.pointerId)
    return b
  }

  /** The mirror plane under (x, y), when nothing of the cage is there and the Face tool is off: grab it. */
  private grabMirrorAt(x: number, y: number, pointerId: number): boolean {
    const s = useFormStore.getState()
    if (s.symmetry === null || circularCount(s.symmetry) !== null || s.faceTool !== null) return false
    if (this.overlay.pickAt(x, y) !== null) return false
    const hit = this.overlay.mirrorHitAt(x, y)
    const normal = mirrorNormal(s.symmetry, s.symmetryNormal)
    if (hit === null || normal === null) return false
    this.mirrorDrag = { grab: hit.point, normal, at: s.symmetryAt, pointerId }
    return true
  }

  /** Slide the grabbed mirror plane to follow the pointer at (x, y). */
  private slideMirrorTo(x: number, y: number): void {
    const m = this.mirrorDrag
    if (m === null) return
    const ray = this.overlay.rayAt(x, y)
    const t = slideAlongNormal(ray.origin, ray.dir, m.grab, m.normal)
    if (t === null) return
    const at = slidMirrorAt(m.at, t)
    if (at !== useFormStore.getState().symmetryAt) useFormStore.getState().setSymmetryAt(at)
  }

  private endMirrorDrag(): void {
    const m = this.mirrorDrag
    if (m === null) return
    this.mirrorDrag = null
    this.host.canvas.releasePointerCapture?.(m.pointerId)
    this.host.setOrbitEnabled(true)
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.mirrorDrag !== null) {
      const p = this.local(e)
      this.slideMirrorTo(p.x, p.y)
      return
    }
    if (this.box !== null) {
      e.stopPropagation()
      const p = this.local(e)
      this.dragBoxTo(p.x, p.y)
      return
    }
    if (this.drag || (e.buttons & 1) !== 0) return
    this.pendingHover = this.local(e)
    if (this.hoverFrame !== 0) return
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0
      const at = this.pendingHover
      if (!at || this.disposed) return
      const next = this.overlay.pickAt(at.x, at.y)
      if (useFormStore.getState().faceTool !== null) {
        // the line from the last corner follows the pointer (to a point it would snap to)
        const c = this.faceClickAt(at.x, at.y)
        this.cursor = c === null ? null : 'point' in c ? useFormStore.getState().cage.positions[c.point] : c.at
        this.paintDraft()
      }
      // over the bare mirror plane: it can be dragged
      const s = useFormStore.getState()
      const onMirror = next === null && s.faceTool === null && s.symmetry !== null && circularCount(s.symmetry) === null && this.overlay.mirrorHitAt(at.x, at.y) !== null
      this.host.canvas.style.cursor = onMirror ? 'grab' : ''
      if (JSON.stringify(next) === JSON.stringify(this.hover)) return
      this.hover = next
      this.paintHighlight()
    })
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId)
    const down = this.down
    this.down = null
    if (this.mirrorDrag !== null) {
      const p = this.local(e)
      this.slideMirrorTo(p.x, p.y)
      this.endMirrorDrag()
      return
    }
    if (this.box !== null && e.button === 0) {
      const at = this.local(e)
      this.dragBoxTo(at.x, at.y)
      const b = this.endBox()!
      // dropped with Esc: the release is neither a box nor a click
      if (b.dropped) return
      if (b.moved) {
        useFormStore.getState().selectPoints(this.overlay.pointsInBox(b.x, b.y, b.toX, b.toY), b.mode)
        return
      }
      // it did not move: a click, below
    }
    if (!down || e.button !== 0 || down.onGizmo) return
    const p = this.local(e)
    if (Math.hypot(p.x - down.x, p.y - down.y) > CLICK_SLOP_PX) return
    if (useFormStore.getState().faceTool !== null) {
      // Alt+click a face of the form: work on its plane
      const onFace = down.alt ? this.overlay.pickAt(p.x, p.y) : null
      if (onFace?.kind === 'face') { useFormStore.getState().setFacePlaneFromFace(onFace.index); return }
      const c = this.faceClickAt(p.x, p.y)
      if (c !== null) useFormStore.getState().addFaceClick(c)
      return
    }
    const pick = this.overlay.pickAt(p.x, p.y)
    // a body edge wins over a cage face (not over the finer cage points and edges); off the cage the click
    // still clears the cage selection as before
    if (pick === null || pick.kind === 'face') {
      const took = this.host.bodyEdgeClick?.(e.clientX, e.clientY, down.additive, { clearOnMiss: pick === null, visible: (w) => !this.overlay.hidesPoint(p.x, p.y, w) }) === true
      if (took && pick !== null) return
    }
    useFormStore.getState().select(pick, down.additive)
  }

  /** Double-click an edge: its whole edge loop (Shift adds to the selection). */
  private readonly onDoubleClick = (e: MouseEvent): void => {
    const p = this.local(e)
    const pick = this.overlay.pickAt(p.x, p.y)
    if (pick?.kind !== 'edge') return
    const st = useFormStore.getState()
    if (!st.selection.edges.includes(pick.key)) st.select(pick, e.shiftKey)
    useFormStore.getState().selectLoop()
  }

  /** The browser took the pointer away mid-press: no box, no click. */
  private readonly onPointerCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId)
    this.endBox()
    this.down = null
  }

  private readonly onFingerGone = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId)
  }

  private readonly onPointerLeave = (): void => {
    // off the view the next corner has nowhere to land: no marker, no ghost
    if (this.cursor !== null) { this.cursor = null; this.paintDraft() }
    if (this.hover === null) return
    this.hover = null
    this.paintHighlight()
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    if (e.key === 'Escape' && this.box !== null && !this.box.dropped) {
      // the box is dropped (the rest of the drag still never reaches orbit); the release selects nothing
      this.box.dropped = true
      this.boxShape?.remove()
      this.boxShape = null
      e.stopPropagation()
      return
    }
    const st = useFormStore.getState()
    if (st.faceTool !== null && (e.key === 'Escape' || e.key === 'Enter')) {
      if (e.key === 'Enter') st.finishFaceDraft()
      else st.stopFaceTool()
      e.stopPropagation()
      return
    }
    if (e.key === 'Escape' && !isSelectionEmpty(useFormStore.getState().selection)) {
      useFormStore.getState().select(null, false)
      e.stopPropagation()
    }
  }

  /** The gizmo handle under the pointer ('X', 'Y', 'Z', 'XY', ... or null) - evidence scripts aim with it. */
  gizmoAxis(): string | null {
    return (this.gizmo as unknown as { axis?: string | null }).axis ?? null
  }

  /** True while a box is being dragged - evidence scripts read it. */
  draggingBox(): boolean {
    return this.box !== null && this.box.moved && !this.box.dropped
  }

  /** True while the mirror plane is being dragged - evidence scripts read it. */
  draggingMirror(): boolean {
    return this.mirrorDrag !== null
  }

  dispose(): void {
    if (this.disposed) return
    this.endMirrorDrag()
    this.endBox()
    this.disposed = true
    if (this.hoverFrame !== 0) cancelAnimationFrame(this.hoverFrame)
    this.unsubscribe()
    this.host.canvas.removeEventListener('pointerdown', this.onPointerDown, true)
    this.host.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.host.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.host.canvas.removeEventListener('dblclick', this.onDoubleClick)
    this.host.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.host.canvas.removeEventListener('pointercancel', this.onPointerCancel)
    window.removeEventListener('pointerup', this.onFingerGone, true)
    window.removeEventListener('pointercancel', this.onFingerGone, true)
    window.removeEventListener('keydown', this.onKeyDown)
    this.gizmo.removeEventListener('change', this.onGizmoChange)
    this.gizmo.removeEventListener('dragging-changed', this.onDraggingChanged)
    this.gizmo.removeEventListener('objectChange', this.onObjectChange)
    this.gizmo.detach()
    this.host.removeObject(this.gizmo.getHelper())
    this.gizmo.dispose()
    this.host.removeObject(this.pivot)
    this.host.removeObject(this.draft)
    this.host.removeObject(this.draftPoints)
    this.host.removeObject(this.marker)
    this.host.removeObject(this.ghost)
    for (const o of [this.draft, this.draftPoints, this.marker, this.ghost]) { o.geometry.dispose(); (o.material as THREE.Material).dispose() }
    this.host.setOrbitEnabled(true)
    this.host.requestRender()
  }
}
