// WO SKC-14: ALL live sketch feedback painting -- rubber-band preview, snap markers/guides/badge
// previews, hover-woken alignment rings, and the tool overlay (removal spans, ghosts, dimension
// guides, warnings, staged markers).
//
// Extracted VERBATIM from CNCViewport.ts:2474-2822 (WO SKC-14, mechanical move: no behaviour
// edits in this cut -- plan R5's mitigation, since these 1,114 lines ARE Operator's quality bar).
// The only changes are structural: `this.scene` -> the host's overlayRoot, `this.getWorldPerPixel()`
// -> the injected worldPerPixel(), and the CNCViewport statics became module constants.
//
// Painting lives HERE and nowhere else. A mount that wanted to paint sketch geometry would have
// to write a second painter, which src/tests/sketch/oneSketchPointerOwner.test.ts forbids.
import * as THREE from 'three'
import { badgeMaterial, BADGE_TEXT, BADGE_PX, type SketchOffset } from './sketchLayer'
import type { Vec2 as SketchVec2 } from '../types'
import type { SnapResult, WokenRef } from '../snap'
import type { ToolOverlay } from '../tools/toolOverlay'
import { dimGuides } from '../tools/dimPlacement'
import { DIMENSION_TICK_PX, screenSizedChevron } from '../tools/dimensionGuideSizing'
import { asNumber } from '../../../theme/viewportColors'

const SKETCH_SNAP_Z = 0.5
const SKETCH_OVERLAY_Z = 0.46
const SNAP_MARKER_PX = 11
const WAKE_MARKER_PX = 14
const WARNING_MARKER_PX = 14
const STAGED_MARKER_PX = 12

const SNAP_MARKER_COLOR = asNumber('--vp-snap-marker')
const SNAP_GUIDE_COLOR = asNumber('--vp-snap-guide')
const SNAP_BADGE_COLOR = asNumber('--vp-snap-badge')
const OVERLAY_REMOVAL_COLOR = asNumber('--vp-overlay-removal')
const OVERLAY_GHOST_COLOR = asNumber('--vp-overlay-ghost')
const OVERLAY_WARNING_COLOR = asNumber('--vp-overlay-warning')
const OVERLAY_DIM_GUIDE_COLOR = asNumber('--sketch-dimension')
const OVERLAY_MARKER_COLOR = asNumber('--vp-select-amber')

// UI-BRAND-B2-7: was 0.55 (critic-C Surface 08: "the part on the canvas is
// muted blue while the tool glyph previews are bright cyan, making the
// user's own sketch feel secondary to the overlay"). Committed sketch
// geometry already renders fully opaque (SKETCH_COLORS in sketchLayer.ts);
// lowering only the in-progress rubber-band preview by ~18% is enough to
// read as clearly subordinate without touching the committed-entity
// renderer (out of this batch's CSS/overlay-chrome scope).
const TOOL_PREVIEW_OPACITY = 0.45

/** Dispose every geometry/material a rebuilt group owned (sprites keep cached badge materials). */
function clearGroup(group: THREE.Group, keepSprites = false): void {
  for (const child of [...group.children]) {
    group.remove(child)
    if (keepSprites && child instanceof THREE.Sprite) continue
    const obj = child as THREE.Line | THREE.Points | THREE.Mesh
    obj.geometry?.dispose()
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    mats.forEach((m) => m && (m as THREE.Material).dispose())
  }
}

export class SketchOverlayPainter {
  private readonly snapGroup = new THREE.Group()
  private readonly wakeGroup = new THREE.Group()
  private readonly overlayGroup = new THREE.Group()
  private previewLines: THREE.Line[] = []

  private offset: SketchOffset = { x: 0, y: 0, rotationDeg: 0 }
  private lastWakeRefs: readonly WokenRef[] | null = null
  private lastWakeWpps: number[] = []

  private readonly root: THREE.Object3D
  private readonly worldPerPixel: (at?: SketchVec2) => number

  constructor(root: THREE.Object3D, worldPerPixel: (at?: SketchVec2) => number) {
    this.root = root
    this.worldPerPixel = worldPerPixel
    this.snapGroup.position.z = SKETCH_SNAP_Z
    this.wakeGroup.position.z = SKETCH_SNAP_Z
    this.overlayGroup.position.z = SKETCH_OVERLAY_Z
    root.add(this.snapGroup)
    root.add(this.wakeGroup)
    root.add(this.overlayGroup)
  }

  /** Pose the scene-level sketch overlay carriers (snap / wake / tool-overlay
   *  groups + the preview line) with the active display offset so they render
   *  aligned with the posed sketch entities. Z positions are preserved (the
   *  offset never carries Z). Their content is built in sketch-LOCAL coords
   *  (tool handlers consume the inverse-mapped cursor), so posing the carriers
   *  is the forward half of the same display transform. */
  setOffset(offset: SketchOffset): void {
    this.offset = offset
    const rad = (offset.rotationDeg * Math.PI) / 180
    for (const g of [this.snapGroup, this.wakeGroup, this.overlayGroup]) {
      g.position.x = offset.x
      g.position.y = offset.y
      g.rotation.z = rad
    }
    for (const line of this.previewLines) {
      line.position.x = offset.x
      line.position.y = offset.y
      line.rotation.z = rad
    }
  }

  // ---- Rubber-band preview (line/rect/circle/arc tools) ----------------------

  /** Show one connected path or a disconnected path group. Paths never share connector segments. */
  setToolPreview(points: SketchVec2[] | readonly SketchVec2[][] | null): void {
    const paths: readonly SketchVec2[][] = points === null || points.length === 0
      ? []
      : Array.isArray(points[0])
        ? points as readonly SketchVec2[][]
        : [points as SketchVec2[]]
    const drawable = paths.filter((path) => path.length >= 2)

    while (this.previewLines.length > drawable.length) {
      const line = this.previewLines.pop()!
      this.root.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }

    for (let pathIndex = 0; pathIndex < drawable.length; pathIndex++) {
      const path = drawable[pathIndex]
      const pts = path.map((p) => new THREE.Vector3(p.x, p.y, 0.45))
      let line = this.previewLines[pathIndex]
      if (!line) {
        const mat = new THREE.LineBasicMaterial({
          color: asNumber('--vp-snap-badge'),
          transparent: true,
          opacity: TOOL_PREVIEW_OPACITY,
          toneMapped: false,
        })
        line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat)
        line.renderOrder = 9
        this.previewLines.push(line)
        this.root.add(line)
      } else if (line.geometry.getAttribute('position')?.count !== pts.length) {
        line.geometry.dispose()
        line.geometry = new THREE.BufferGeometry().setFromPoints(pts)
      } else {
        line.geometry.setFromPoints(pts)
      }
    }

    // Sits just above the sketch layer (Z 0.4) so it never z-fights
    // committed segments.
    // Pose freshly-created paths at the active display offset. Existing paths receive the same
    // idempotent pose, which also pins offset updates across path-count rebuilds.
    this.setOffset(this.offset)
  }

  hasPreview(): boolean {
    return this.previewLines.length > 0
  }

  previewPathCount(): number {
    return this.previewLines.length
  }

  // ---- Snap feedback (PLAN 3.4) ---------------------------------------------
  //
  // Distinct marker icons at the snapped point (endpoint square, midpoint
  // triangle, center circle, intersection X, grid dot), dashed alignment
  // guides for h/v-align, and a constraint badge preview at the cursor
  // showing what the click WILL create (same iconography as the committed
  // badges). Rebuilt per pointermove while a tool is armed; onFrame clears it
  // the moment no tool is armed, so no overlay artifact can outlive disarming.

  setSnapDisplay(snap: SnapResult | null): void {
    clearGroup(this.snapGroup, true)
    if (!snap) return

    const wpp = Math.max(this.worldPerPixel(snap.point), 1e-9)
    const s = SNAP_MARKER_PX * wpp
    const h = s / 2
    const p = snap.point

    const addLines = (pts: THREE.Vector3[], loop: boolean) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts)
      const mat = new THREE.LineBasicMaterial({
        color: SNAP_MARKER_COLOR, depthTest: false, toneMapped: false,
      })
      const line = loop ? new THREE.LineLoop(geo, mat) : new THREE.LineSegments(geo, mat)
      line.renderOrder = 11
      this.snapGroup.add(line)
    }
    const addDot = () => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x, p.y, 0)])
      const mat = new THREE.PointsMaterial({
        color: SNAP_MARKER_COLOR, size: 6, sizeAttenuation: false,
        depthTest: false, toneMapped: false,
      })
      const dot = new THREE.Points(geo, mat)
      dot.renderOrder = 11
      this.snapGroup.add(dot)
    }
    const v = (x: number, y: number) => new THREE.Vector3(x, y, 0)

    switch (snap.kind) {
      case 'endpoint': // square
        addLines([v(p.x - h, p.y - h), v(p.x + h, p.y - h),
                  v(p.x + h, p.y + h), v(p.x - h, p.y + h)], true)
        break
      case 'midpoint': // triangle
        addLines([v(p.x, p.y + h), v(p.x + h, p.y - h), v(p.x - h, p.y - h)], true)
        break
      case 'center': { // circle
        const pts: THREE.Vector3[] = []
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2
          pts.push(v(p.x + h * Math.cos(a), p.y + h * Math.sin(a)))
        }
        addLines(pts, true)
        break
      }
      case 'quadrant': // diamond (ellipse vertex / co-vertex)
        addLines([v(p.x, p.y + h), v(p.x + h, p.y),
                  v(p.x, p.y - h), v(p.x - h, p.y)], true)
        break
      case 'intersection': // X
        addLines([v(p.x - h, p.y - h), v(p.x + h, p.y + h),
                  v(p.x - h, p.y + h), v(p.x + h, p.y - h)], false)
        break
      case 'grid': // dot
        addDot()
        break
      case 'h-align':
      case 'v-align': {
        addDot()
        // Dashed guide(s) from the alignment source point(s) to the
        // cursor (screen-space dash pattern, same trick as construction
        // lines). alignFrom2 is the dual H+V intersection's second source
        // (e.g. hover-woken point + chain point).
        const addGuide = (from: { x: number; y: number }) => {
          const geo = new THREE.BufferGeometry().setFromPoints([
            v(from.x, from.y), v(p.x, p.y),
          ])
          const mat = new THREE.LineDashedMaterial({
            color: SNAP_GUIDE_COLOR, dashSize: 6, gapSize: 5,
            scale: 1 / wpp, depthTest: false, toneMapped: false,
            transparent: true, opacity: 0.75,
          })
          const guide = new THREE.Line(geo, mat)
          guide.computeLineDistances()
          guide.renderOrder = 11
          this.snapGroup.add(guide)
        }
        if (snap.alignFrom) addGuide(snap.alignFrom)
        if (snap.alignFrom2) addGuide(snap.alignFrom2)
        break
      }
    }

    // Constraint badge preview: the constraint(s) the click WILL create,
    // rendered with the committed-badge iconography, offset right-below
    // the snapped point (sprite.center offsets are screen-space).
    const kinds = [...new Set(snap.inferences.map((i) => i.kind).filter((k): k is Exclude<typeof k, 'grid'> => k !== 'grid'))]
    kinds.forEach((kind, i) => {
      const sprite = new THREE.Sprite(badgeMaterial(BADGE_TEXT[kind], SNAP_BADGE_COLOR))
      sprite.position.set(p.x, p.y, 0)
      sprite.center.set(-0.45 - i * 1.15, 1.4)
      const bs = BADGE_PX * wpp
      sprite.scale.set(bs, bs, 1)
      sprite.renderOrder = 12
      this.snapGroup.add(sprite)
    })
  }

  snapChildCount(): number {
    return this.snapGroup.children.length
  }

  // ---- Hover-woken alignment references --------------------------------------
  //
  // A woken ref renders a small persistent DIMMED RING (distinct from the
  // live snap marker) while it stays woken, so the user can see which
  // points will offer remote H/V alignment as the cursor moves away.

  setWakeDisplay(refs: readonly WokenRef[] | null): void {
    this.lastWakeRefs = refs
    this.lastWakeWpps = refs?.map((ref) => this.worldPerPixel(ref.point)) ?? []
    clearGroup(this.wakeGroup)
    if (!refs || refs.length === 0) return

    for (const w of refs) {
      const r = (WAKE_MARKER_PX * Math.max(this.worldPerPixel(w.point), 1e-9)) / 2
      const pts: THREE.Vector3[] = []
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2
        pts.push(new THREE.Vector3(
          w.point.x + r * Math.cos(a), w.point.y + r * Math.sin(a), 0,
        ))
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts)
      const mat = new THREE.LineBasicMaterial({
        color: SNAP_MARKER_COLOR, depthTest: false,
        toneMapped: false, transparent: true, opacity: 0.4,
      })
      const ring = new THREE.LineLoop(geo, mat)
      ring.renderOrder = 10 // under the live snap marker
      this.wakeGroup.add(ring)
    }
  }

  wakeChildCount(): number {
    return this.wakeGroup.children.length
  }

  /** Armed: a store-side wake CLEAR without a pointermove (Esc cancels the chain, a
   *  commit lands) must drop the rings on the next frame; a zoom rescales them.
   *  Reference equality keeps the common no-change frame free of rebuild churn. */
  wakeNeedsRebuild(refs: readonly WokenRef[] | null): boolean {
    if (refs !== this.lastWakeRefs || (refs?.length ?? 0) !== this.lastWakeWpps.length) return true
    if (!refs) return false
    return refs.some((ref, index) => {
      const prior = this.lastWakeWpps[index]
      const current = this.worldPerPixel(ref.point)
      return Math.abs(current - prior) > Math.max(prior, 1e-9) * 0.01
    })
  }

  // ---- Tool overlay (removal highlights / ghosts / warnings) ------------------

  setToolOverlayDisplay(overlay: ToolOverlay | null): void {
    clearGroup(this.overlayGroup)
    if (!overlay) return
    for (const span of overlay.removal ?? []) {
      if (span.length < 2) continue
      const pts = span.map((p) => new THREE.Vector3(p.x, p.y, 0))
      const mat = new THREE.LineBasicMaterial({
        color: OVERLAY_REMOVAL_COLOR, transparent: true,
        opacity: 0.95, depthTest: false, toneMapped: false,
      })
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat)
      line.renderOrder = 10
      this.overlayGroup.add(line)
    }

    for (const ghost of overlay.ghosts ?? []) {
      if (ghost.length < 2) continue
      const wpp = Math.max(this.worldPerPixel(ghost[0]), 1e-9)
      const pts = ghost.map((p) => new THREE.Vector3(p.x, p.y, 0))
      const mat = new THREE.LineDashedMaterial({
        color: OVERLAY_GHOST_COLOR, dashSize: 5, gapSize: 4,
        scale: 1 / wpp, transparent: true, opacity: 0.55,
        depthTest: false, toneMapped: false,
      })
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat)
      line.computeLineDistances()
      line.renderOrder = 10
      this.overlayGroup.add(line)
    }

    // Dimension guides: solid, dimension-colored leader/arc — the live
    // angle-arc preview while a two-line angle dimension is placed.
    const placement = overlay.dimPlacement
    const scaleAtAnchor = () => {
      const at = placement!.placement.labelAnchor
      const rad = this.offset.rotationDeg * Math.PI / 180
      const world = { x: this.offset.x + at.x * Math.cos(rad) - at.y * Math.sin(rad),
        y: this.offset.y + at.x * Math.sin(rad) + at.y * Math.cos(rad) }
      return Math.max(this.worldPerPixel(world), 1e-9)
    }
    const sizedGuides = (wpp: number) => dimGuides(placement!.entities, placement!.placement.plan,
      placement!.placement.labelAnchor, DIMENSION_TICK_PX * wpp)
    const guideLines: THREE.Line[] = []
    for (const guide of placement ? sizedGuides(scaleAtAnchor()) : overlay.dimGuides ?? []) {
      if (guide.length < 2) continue
      const pts = guide.map((p) => new THREE.Vector3(p.x, p.y, 0))
      const mat = new THREE.LineBasicMaterial({
        color: OVERLAY_DIM_GUIDE_COLOR, transparent: true,
        opacity: 0.9, depthTest: false, toneMapped: false,
      })
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat)
      line.renderOrder = 11
      this.overlayGroup.add(line)
      guideLines.push(line)
    }
    if (placement) {
      // Render-time sizing covers camera motion WITHOUT a new pointer event.
      // The render callback supplies the actual camera, including perspective
      // hosts, without coupling the pure tool resolver to a viewport or store.
      let lastWpp = Number.NaN
      const lastProjection = new THREE.Matrix4()
      const lastCamera = new THREE.Matrix4()
      const lastPose = new THREE.Matrix4()
      const lastSize = new THREE.Vector2()
      const size = new THREE.Vector2()
      for (const line of guideLines) line.onBeforeRender = (renderer, _scene, camera) => {
        const wpp = scaleAtAnchor()
        renderer.getSize(size)
        if (wpp === lastWpp && lastProjection.equals(camera.projectionMatrix) &&
            lastCamera.equals(camera.matrixWorld) && lastPose.equals(line.matrixWorld) &&
            lastSize.equals(size)) return
        const project = (p: SketchVec2): SketchVec2 | null => {
          const q = new THREE.Vector3(p.x, p.y, 0).applyMatrix4(line.matrixWorld).project(camera)
          return Number.isFinite(q.x) && Number.isFinite(q.y)
            ? { x: q.x * size.x / 2, y: q.y * size.y / 2 } : null
        }
        const guides = sizedGuides(wpp)
        for (let index = 0; index < guideLines.length; index++) {
          const poly = screenSizedChevron(guides[index], wpp, project)
          const geometry = guideLines[index].geometry
          const positions = geometry.getAttribute('position') as THREE.BufferAttribute
          for (let i = 0; i < poly.length; i++) positions.setXYZ(i, poly[i].x, poly[i].y, 0)
          positions.needsUpdate = true
          geometry.computeBoundingSphere()
        }
        lastWpp = wpp
        lastProjection.copy(camera.projectionMatrix)
        lastCamera.copy(camera.matrixWorld)
        lastPose.copy(line.matrixWorld)
        lastSize.copy(size)
      }
    }

    for (const w of overlay.warnings ?? []) {
      const h = (WARNING_MARKER_PX * Math.max(this.worldPerPixel(w), 1e-9)) / 2
      const pts = [
        new THREE.Vector3(w.x, w.y + h, 0),
        new THREE.Vector3(w.x + h, w.y - h, 0),
        new THREE.Vector3(w.x - h, w.y - h, 0),
      ]
      const mat = new THREE.LineBasicMaterial({
        color: OVERLAY_WARNING_COLOR, depthTest: false, toneMapped: false,
      })
      const tri = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat)
      tri.renderOrder = 11
      this.overlayGroup.add(tri)
    }

    // Staged-point markers (fillet's and chamfer's accumulated corners): a
    // filled amber dot + ring at each staged corner, screen-constant size,
    // so the selected set is unmistakable (Operator's verdict on 3dac35e for
    // fillet; SKC-50 extended the same treatment to chamfer). Amber = the
    // house selection color (--vp-select-amber).
    for (const m of overlay.markers ?? []) {
      const mr = (STAGED_MARKER_PX * Math.max(this.worldPerPixel(m), 1e-9)) / 2
      const fill = new THREE.Mesh(
        new THREE.CircleGeometry(mr, 20),
        new THREE.MeshBasicMaterial({
          color: OVERLAY_MARKER_COLOR, transparent: true,
          opacity: 0.35, depthTest: false, toneMapped: false,
        }),
      )
      fill.position.set(m.x, m.y, 0)
      fill.renderOrder = 11
      this.overlayGroup.add(fill)
      const ringPts: THREE.Vector3[] = []
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2
        ringPts.push(new THREE.Vector3(m.x + mr * Math.cos(a), m.y + mr * Math.sin(a), 0))
      }
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(ringPts),
        new THREE.LineBasicMaterial({
          color: OVERLAY_MARKER_COLOR, transparent: true,
          opacity: 0.95, depthTest: false, toneMapped: false,
        }),
      )
      ring.renderOrder = 12
      this.overlayGroup.add(ring)
    }
  }

  overlayChildCount(): number {
    return this.overlayGroup.children.length
  }

  /** Clear every feedback channel (mode exit, disarm). */
  clearAll(): void {
    this.setToolPreview(null)
    this.setSnapDisplay(null)
    this.setWakeDisplay(null)
    this.setToolOverlayDisplay(null)
  }

  dispose(): void {
    this.clearAll()
    this.root.remove(this.snapGroup)
    this.root.remove(this.wakeGroup)
    this.root.remove(this.overlayGroup)
  }
}
