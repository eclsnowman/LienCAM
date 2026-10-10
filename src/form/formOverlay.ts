// Form - the cage and its smooth skin, drawn INTO the Model screen's scene.
//
// Form lives inside the Model screen (Operator, 2026-09-27): this overlay owns no
// renderer, camera or controls. It adds its objects to the host scene, reads
// the host camera for picking, and asks the host for a frame. It keeps one
// compiled skin per level and re-evaluates stencils when points move,
// recompiling only when the topology version changes.

import * as THREE from 'three'
import type { Cage, Vec3 } from './cage'
import { cageBounds, cageEdgeFaceCounts, parseEdgeKey } from './cage'
import { cagePositionArray } from './subdivide'
import { compileSkin, evaluateSkin, type CompiledSkin, type SkinBuffers } from './surface'
import type { FormDisplayMode, ResultFlash } from './formStore'
import type { CageSelection } from './topology'
import { selectionPoints } from './topology'
import { hiddenBySkin, pickCage, pointerRay, pointsInRect, skinTolerance, type CagePick } from './pick'
import { asNumber } from '../theme/viewportColors'
import { createModeledBodyMaterial, resolveModeledBodyVisualStyle } from '../lib/viewport/lighting/bodyVisualStyle'
import { curvatureOn } from '../lib/viewport/lighting/zebra'
import { ensureCurvatureAttribute } from '../lib/viewport/lighting/curvature'
import { DEFAULT_VIEWPORT_THEME } from '../lib/viewport/lighting/viewportThemes'

/** Quads the resting skin may use; the drag level is one below the rest level. */
export const SKIN_QUAD_BUDGET = 40_000
export const MAX_REST_LEVEL = 4

/** The highest level the operator may ask for (and never past 4x the automatic budget). */
export const MAX_SKIN_LEVEL = 5

/**
 * The skin levels for a cage: at rest the finest level within budget (or the
 * level the operator asked for, 1..MAX_SKIN_LEVEL, as long as it stays within
 * 4x that budget), one coarser while dragging. `requested` 0 = automatic.
 */
export function skinLevels(cage: Cage, requested = 0): { rest: number; drag: number } {
  // every face becomes (its corner count) quads at level 1, then 4x per level
  const level1 = cage.faces.reduce((n, f) => n + f.length, 0)
  let rest = 1
  if (requested > 0) {
    rest = Math.max(1, Math.min(MAX_SKIN_LEVEL, Math.round(requested)))
    while (rest > 1 && level1 * 4 ** (rest - 1) > 4 * SKIN_QUAD_BUDGET) rest--
  } else {
    while (rest < MAX_REST_LEVEL && level1 * 4 ** rest <= SKIN_QUAD_BUDGET) rest++
  }
  return { rest, drag: Math.max(1, rest - 1) }
}

export interface FormSceneState {
  cage: Cage
  topologyVersion: number
  displayMode: FormDisplayMode
  dragging: boolean
  /** the smooth skin's level at rest, 0 = automatic */
  skinLevel?: number
  /** the mirror plane n . p = at while a mirror is on, drawn as a faint square round the form */
  mirror?: { normal: Vec3; at: number } | null
  /** Display-only sectors round the world Z axis; independent of mirror picking. */
  circular?: { copies: number } | null
}

/** What the overlay needs from the screen it draws into. */
export interface FormOverlayHost {
  addObject(obj: THREE.Object3D): void
  removeObject(obj: THREE.Object3D): void
  requestRender(): void
  /** the host's CURRENT camera (a projection switch may replace it) */
  camera(): THREE.Camera
  canvas: HTMLCanvasElement
}

export class FormOverlay {
  readonly root = new THREE.Group()
  private readonly skinGeometry = new THREE.BufferGeometry()
  readonly skinMesh: THREE.Mesh
  private readonly cageLines: THREE.LineSegments
  private readonly creaseLines: THREE.LineSegments
  private readonly borderLines: THREE.LineSegments
  private wireTopology = -1
  private wireEdges: { plain: Array<[number, number]>; sharp: Array<[number, number]>; border: Array<[number, number]> } = { plain: [], sharp: [], border: [] }
  private readonly cagePoints: THREE.Points
  private readonly mirrorPlane: THREE.Mesh
  private readonly mirrorOutline: THREE.LineLoop
  private readonly circularAxis: THREE.LineSegments
  private readonly circularBoundaries: THREE.LineSegments
  /** Loft's profiles picked so far, outlined and (closed ones) filled translucent - the sketch's own line sits on
   *  the outline, so the fill is what shows the pick (display only; the session sets and clears them) */
  private readonly profileLines: THREE.LineSegments
  private readonly profileFill: THREE.Mesh
  private readonly selected: HighlightLayer
  private readonly hovered: HighlightLayer
  /** what the last tool changed, in the change colour (WO-2497): its own layer, over the selection */
  private readonly flash: HighlightLayer
  private readonly flashGroup = new THREE.Group()
  private lastState: FormSceneState | null = null
  private compiled = new Map<number, CompiledSkin>()
  private compiledTopology = -1
  private buffers: SkinBuffers | null = null
  private buffersLevel = -1
  /** the level the skin currently shows (tests and the status line read it) */
  shownLevel = 0
  private disposed = false
  private readonly host: FormOverlayHost

  constructor(host: FormOverlayHost) {
    this.host = host
    this.root.name = 'form-overlay'
    this.skinMesh = new THREE.Mesh(this.skinGeometry, createModeledBodyMaterial({
      color: resolveModeledBodyVisualStyle(DEFAULT_VIEWPORT_THEME).bodyHex,
    }))
    this.skinMesh.name = 'form-skin'
    // normals from the start: a program compiled for a geometry without them shades every triangle
    // flat (from screen-space derivatives) and is kept once the normals arrive - the smooth skin lit
    // faceted, which the zebra display showed as blocks (Form stage 11)
    this.skinGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    this.skinGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(0), 3))
    this.cageLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: asNumber('--vp-loop-default'), depthTest: false, transparent: true, opacity: 0.85,
    }))
    this.cageLines.name = 'form-cage-edges'
    this.cageLines.renderOrder = 2
    this.creaseLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: asNumber('--vp-seed'), depthTest: false, transparent: true,
    }))
    this.creaseLines.name = 'form-crease-edges'
    // above the amber/hover edge strokes like the open borders: a selected creased edge stays violet (its
    // corner dots still mark the pick), so it is told apart from a plain selected edge
    this.creaseLines.renderOrder = 9
    this.borderLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: asNumber('--vp-plane-feed'), depthTest: false, transparent: true,
    }))
    this.borderLines.name = 'form-open-borders'
    // Unweld selects both coincident sides of its cut. Keep the border visible
    // above the amber/hover edge strokes; their corner dots still mark the pick.
    this.borderLines.renderOrder = 9
    this.cagePoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      color: asNumber('--vp-loop-default'), size: 7, sizeAttenuation: false, depthTest: false, transparent: true,
    }))
    this.cagePoints.name = 'form-cage-points'
    this.cagePoints.renderOrder = 4
    this.mirrorPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      color: asNumber('--vp-seed'), transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
    }))
    this.mirrorPlane.name = 'form-mirror-plane'
    this.mirrorPlane.renderOrder = 1
    this.mirrorOutline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => new THREE.Vector3(x, y, 0))), new THREE.LineBasicMaterial({
      color: asNumber('--vp-seed'), transparent: true, opacity: 0.6,
    }))
    this.mirrorOutline.name = 'form-mirror-outline'
    this.mirrorPlane.add(this.mirrorOutline)
    this.mirrorPlane.visible = false
    this.circularAxis = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({
      color: asNumber('--vp-seed'), depthTest: false, depthWrite: false, transparent: true, opacity: 0.85, dashSize: 3, gapSize: 2,
    }))
    this.circularAxis.name = 'form-circular-axis'
    this.circularBoundaries = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: asNumber('--vp-seed'), depthTest: false, depthWrite: false, transparent: true, opacity: 0.5,
    }))
    this.circularBoundaries.name = 'form-circular-boundaries'
    for (const guide of [this.circularAxis, this.circularBoundaries]) {
      guide.visible = false
      guide.renderOrder = 1
      guide.raycast = () => {} // Guides can never become a scene pick target.
    }
    // In the default isometric view a cage edge can project onto the axis.
    this.circularAxis.renderOrder = 5
    this.profileLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: asNumber('--vp-select-amber'), depthTest: false, transparent: true,
    }))
    this.profileLines.name = 'form-loft-profiles'
    this.profileLines.renderOrder = 8
    this.profileLines.visible = false
    this.profileFill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: asNumber('--vp-select-amber'), transparent: true, opacity: 0.25, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }))
    this.profileFill.name = 'form-loft-profile-fill'
    // above the skin, under the cage's lines and points
    this.profileFill.renderOrder = 1
    this.profileFill.visible = false
    this.root.add(this.skinMesh, this.cageLines, this.creaseLines, this.borderLines, this.cagePoints, this.mirrorPlane, this.profileLines, this.profileFill)
    this.root.add(this.circularAxis, this.circularBoundaries)
    this.hovered = new HighlightLayer(asNumber('--vp-brep-hover'), 10, 0.22, 5)
    this.selected = new HighlightLayer(asNumber('--vp-select-amber'), 11, 0.35, 6)
    this.root.add(this.hovered.group, this.selected.group)
    this.flash = new HighlightLayer(asNumber('--vp-overlay-removal'), 13, 0.45, 12)
    this.flashGroup.name = 'form-result-flash'
    this.flashGroup.add(this.flash.group)
    this.flashGroup.visible = false
    this.root.add(this.flashGroup)
    host.addObject(this.root)
  }

  private skinFor(cage: Cage, topologyVersion: number, level: number): CompiledSkin {
    if (topologyVersion !== this.compiledTopology) {
      this.compiled.clear()
      this.compiledTopology = topologyVersion
    }
    let skin = this.compiled.get(level)
    if (!skin) {
      skin = compileSkin(cage, level)
      this.compiled.set(level, skin)
    }
    return skin
  }

  /** Push the store state into the scene and draw a frame. */
  update(state: FormSceneState): void {
    if (this.disposed) return
    const { cage, topologyVersion, displayMode, dragging } = state
    this.lastState = state
    const levels = skinLevels(cage, state.skinLevel ?? 0)
    const level = dragging ? levels.drag : levels.rest
    const skin = this.skinFor(cage, topologyVersion, level)
    const points = cagePositionArray(cage)
    const reuse = this.buffersLevel === level && this.buffers && this.buffers.positions.length === skin.renderSource.length * 3 ? this.buffers : undefined
    this.buffers = evaluateSkin(skin, points, reuse)
    const geometryChanged = !reuse
    this.buffersLevel = level
    this.shownLevel = level
    if (geometryChanged) {
      this.skinGeometry.setAttribute('position', new THREE.BufferAttribute(this.buffers.positions, 3))
      this.skinGeometry.setAttribute('normal', new THREE.BufferAttribute(this.buffers.normals, 3))
      this.skinGeometry.setIndex(new THREE.BufferAttribute(skin.indices, 1))
    } else {
      this.skinGeometry.getAttribute('position').needsUpdate = true
      this.skinGeometry.getAttribute('normal').needsUpdate = true
    }
    this.skinGeometry.computeBoundingSphere()
    this.skinGeometry.computeBoundingBox()
    // curvature display: per-vertex values for the new skin (at rest; a drag shows the last ones)
    if (!dragging && curvatureOn(this.skinMesh.material as THREE.Material)) ensureCurvatureAttribute(this.skinGeometry)

    // Membership changes with topology (including creases), never on point drags.
    if (this.wireTopology !== topologyVersion) {
      const creases = new Set(cage.creases)
      this.wireEdges = { plain: [], sharp: [], border: [] }
      for (const [key, count] of cageEdgeFaceCounts(cage)) {
        const bucket = count === 1 ? this.wireEdges.border : creases.has(key) ? this.wireEdges.sharp : this.wireEdges.plain
        bucket.push(parseEdgeKey(key))
      }
      this.wireTopology = topologyVersion
    }
    for (const [lines, edges] of [
      [this.cageLines, this.wireEdges.plain],
      [this.creaseLines, this.wireEdges.sharp],
      [this.borderLines, this.wireEdges.border],
    ] as const) {
      let position = lines.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
      if (!position || position.count !== edges.length * 2) {
        position = new THREE.Float32BufferAttribute(new Float32Array(edges.length * 6), 3)
        lines.geometry.setAttribute('position', position)
      }
      edges.forEach(([a, b], i) => {
        position.setXYZ(i * 2, ...cage.positions[a])
        position.setXYZ(i * 2 + 1, ...cage.positions[b])
      })
      position.needsUpdate = true
      lines.geometry.computeBoundingSphere()
    }
    // Read the existing green token again so a live colour-mode switch is reflected.
    ;(this.borderLines.material as THREE.LineBasicMaterial).color.setHex(asNumber('--vp-plane-feed'))
    ;(this.creaseLines.material as THREE.LineBasicMaterial).color.setHex(asNumber('--vp-seed'))
    this.cagePoints.geometry.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(points), 3))
    this.cagePoints.geometry.computeBoundingSphere()

    this.placeMirror(cage, state.mirror ?? null)
    this.placeCircular(cage, state.circular ?? null)

    const showCage = displayMode !== 'smooth'
    this.skinMesh.visible = displayMode !== 'cage'
    this.cageLines.visible = showCage
    // creased edges keep their colour in every display, so a sharp rim reads in Smooth too (WO-2497)
    this.creaseLines.visible = true
    this.borderLines.visible = showCage
    this.cagePoints.visible = showCage
    this.host.requestRender()
  }

  /** the mirror plane as a square a little larger than the form, centred on the form's centre dropped onto the plane */
  private placeMirror(cage: Cage, mirror: { normal: Vec3; at: number } | null): void {
    this.mirrorPlane.visible = mirror !== null
    if (mirror === null) return
    const { min, max } = cageBounds(cage)
    const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
    const n = new THREE.Vector3(...mirror.normal).normalize()
    c.addScaledVector(n, mirror.at - c.dot(n))
    const size = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])) * 0.8
    this.mirrorPlane.position.copy(c)
    this.mirrorPlane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n)
    this.mirrorPlane.scale.set(size, size, 1)
  }

  /** Outline one radial half-plane per copy, with a single dashed axis shared by all sectors. */
  private placeCircular(cage: Cage, circular: { copies: number } | null): void {
    for (const guide of [this.circularAxis, this.circularBoundaries]) guide.visible = circular !== null
    if (circular === null) return
    const { min, max } = cageBounds(cage)
    const radius = cage.positions.reduce((r, p) => Math.max(r, Math.hypot(p[0], p[1])), 1) * 1.2
    const pad = Math.max(1, max[2] - min[2], radius) * 0.12
    const bottom = min[2] - pad, top = max[2] + pad
    this.circularAxis.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, bottom, 0, 0, top], 3))
    this.circularAxis.computeLineDistances()
    const lines: number[] = []
    for (let i = 0; i < circular.copies; i++) {
      const angle = 2 * Math.PI * i / circular.copies
      const x = radius * Math.cos(angle), y = radius * Math.sin(angle)
      lines.push(0, 0, bottom, x, y, bottom, x, y, bottom, x, y, top, x, y, top, 0, 0, top)
    }
    this.circularBoundaries.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))
    for (const guide of [this.circularAxis, this.circularBoundaries]) {
      guide.geometry.computeBoundingSphere()
      ;(guide.material as THREE.LineBasicMaterial).color.setHex(asNumber('--vp-seed'))
    }
  }

  /** Where the pointer at CSS pixel (x, y) meets the drawn mirror plane, or null (hidden, or missed). */
  mirrorHitAt(x: number, y: number): { point: Vec3; ray: { origin: Vec3; dir: Vec3 } } | null {
    if (!this.mirrorPlane.visible) return null
    const rect = this.host.canvas.getBoundingClientRect()
    const raycaster = pointerRay(this.host.camera(), rect.width, rect.height, x, y)
    this.mirrorPlane.updateMatrixWorld(true)
    const hit = raycaster.intersectObject(this.mirrorPlane, false)[0]
    const { origin, direction } = raycaster.ray
    const ray = { origin: [origin.x, origin.y, origin.z] as Vec3, dir: [direction.x, direction.y, direction.z] as Vec3 }
    return hit === undefined ? null : { point: [hit.point.x, hit.point.y, hit.point.z], ray }
  }

  /** The pointer's ray at CSS pixel (x, y). */
  rayAt(x: number, y: number): { origin: Vec3; dir: Vec3 } {
    const rect = this.host.canvas.getBoundingClientRect()
    const { origin, direction } = pointerRay(this.host.camera(), rect.width, rect.height, x, y).ray
    return { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] }
  }

  /** where the mirror plane is drawn, or null when it is hidden (tests and the evidence read it) */
  mirrorShown(): { centre: Vec3; normal: Vec3; size: number } | null {
    if (!this.mirrorPlane.visible) return null
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mirrorPlane.quaternion)
    const p = this.mirrorPlane.position
    return { centre: [p.x, p.y, p.z], normal: [n.x, n.y, n.z], size: this.mirrorPlane.scale.x }
  }

  /** Draw the selection and the hover over the cage; while a tool's result flashes, it alone (the selection waits). */
  setHighlight(cage: Cage, selection: CageSelection, hover: CagePick | null, flash: ResultFlash | null = null): void {
    this.selected.set(cage, selection)
    this.selected.group.visible = flash === null
    this.flashGroup.visible = flash !== null
    this.flash.setColor(asNumber('--vp-overlay-removal'))
    this.flash.set(cage, flash)
    this.hovered.set(cage, hover === null ? null : {
      points: hover.kind === 'point' ? [hover.index] : [],
      edges: hover.kind === 'edge' ? [hover.key] : [],
      faces: hover.kind === 'face' ? [hover.index] : [],
    })
    this.host.requestRender()
  }

  /** What the pointer is over, at CSS pixel (x, y) of the canvas. */
  pickAt(x: number, y: number): CagePick | null {
    const state = this.lastState
    if (!state) return null
    const rect = this.host.canvas.getBoundingClientRect()
    const skin = this.compiled.get(this.shownLevel)
    return pickCage({
      cage: state.cage,
      camera: this.host.camera(),
      width: rect.width,
      height: rect.height,
      x,
      y,
      skin: state.displayMode !== 'cage' && skin
        ? { mesh: this.skinMesh, cageFaceOfTriangle: (t) => skin.cageFaceOfSkinFace[skin.skinFaceOfTriangle[t]] }
        : null,
    })
  }

  /** True when the smooth skin, as shown, hides `world` from the pointer at (x, y) (CSS px, canvas-relative). */
  hidesPoint(x: number, y: number, world: readonly [number, number, number]): boolean {
    const state = this.lastState
    if (!state || state.displayMode === 'cage') return false
    const rect = this.host.canvas.getBoundingClientRect()
    const { box } = FormOverlay.frameOf(state.cage)
    return hiddenBySkin(this.host.camera(), rect.width, rect.height, x, y, this.skinMesh, world, skinTolerance(box.getSize(new THREE.Vector3()).length()))
  }

  /** The cage points inside the box between (x0, y0) and (x1, y1) (CSS px, canvas-relative) the shown skin does not hide. */
  pointsInBox(x0: number, y0: number, x1: number, y1: number): number[] {
    const state = this.lastState
    if (!state) return []
    const rect = this.host.canvas.getBoundingClientRect()
    return pointsInRect(state.cage, this.host.camera(), rect.width, rect.height, x0, y0, x1, y1, (x, y, w) => this.hidesPoint(x, y, w))
  }

  /** Screen position (CSS px, canvas-relative) of a world point - evidence scripts aim the mouse with it. */
  screenOf(p: readonly [number, number, number]): { x: number; y: number } {
    const rect = this.host.canvas.getBoundingClientRect()
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.host.camera())
    return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height }
  }

  /** The cage's bounding box centre and radius (the host frames the view with it). */
  static frameOf(cage: Cage): { centre: THREE.Vector3; radius: number; box: THREE.Box3 } {
    const { min, max } = cageBounds(cage)
    const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))
    return { centre: box.getCenter(new THREE.Vector3()), radius: Math.max(1, box.getSize(new THREE.Vector3()).length() / 2), box }
  }

  /** What the result flash draws now (null: none) - tests and the evidence read it. */
  flashShown(): { points: number; edges: number; faces: number; color: number } | null {
    return this.flashGroup.visible ? { ...this.flash.counts(), color: this.flash.color() } : null
  }

  /** Skin stats for the status line. */
  stats(): { level: number; quads: number } {
    const skin = this.compiled.get(this.shownLevel)
    return { level: this.shownLevel, quads: skin ? skin.topology.faces.length : 0 }
  }

  /** Outline these model-space polylines (Loft's profiles picked so far); none clears the outline. */
  setProfileOutlines(lines: ReadonlyArray<{ points: readonly Vec3[]; closed: boolean }>): void {
    if (this.disposed) return
    const segs: number[] = []
    const tris: number[] = []
    for (const { points, closed } of lines) {
      const last = closed ? points.length : points.length - 1
      for (let i = 0; i < last; i++) segs.push(...points[i], ...points[(i + 1) % points.length])
      if (!closed || points.length < 3) continue
      // a fan from the profile's centre: display only, so a non-convex profile's overlap does not matter
      const c = [0, 1, 2].map((k) => points.reduce((a, p) => a + p[k], 0) / points.length) as Vec3
      for (let i = 0; i < points.length; i++) tris.push(...c, ...points[i], ...points[(i + 1) % points.length])
    }
    this.profileLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
    this.profileLines.geometry.computeBoundingSphere()
    this.profileFill.geometry.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3))
    this.profileFill.geometry.computeBoundingSphere()
    for (const o of [this.profileLines, this.profileFill]) (o.material as THREE.LineBasicMaterial).color.setHex(asNumber('--vp-select-amber'))
    this.profileLines.visible = segs.length > 0
    this.profileFill.visible = tris.length > 0
    this.host.requestRender()
  }

  /** How many triangles fill the closed profiles (tests and evidence scripts read it). */
  profileFillTriangles(): number {
    return this.profileFill.visible ? (this.profileFill.geometry.getAttribute('position')?.count ?? 0) / 3 : 0
  }

  /** How many profile outlines' segments are drawn (tests and evidence scripts read it). */
  profileOutlineSegments(): number {
    return this.profileLines.visible ? (this.profileLines.geometry.getAttribute('position')?.count ?? 0) / 2 : 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.host.removeObject(this.root)
    this.skinGeometry.dispose()
    this.cageLines.geometry.dispose()
    this.creaseLines.geometry.dispose()
    this.borderLines.geometry.dispose()
    ;(this.borderLines.material as THREE.Material).dispose()
    this.cagePoints.geometry.dispose()
    this.mirrorPlane.geometry.dispose()
    this.mirrorOutline.geometry.dispose()
    for (const guide of [this.circularAxis, this.circularBoundaries]) { guide.geometry.dispose(); (guide.material as THREE.Material).dispose() }
    for (const o of [this.profileLines, this.profileFill]) { o.geometry.dispose(); (o.material as THREE.Material).dispose() }
    this.selected.dispose()
    this.hovered.dispose()
    this.flash.dispose()
    this.host.requestRender()
  }
}

/** Points, edges and faces of a selection (or the hover) drawn over the cage. */
class HighlightLayer {
  readonly group = new THREE.Group()
  private readonly points: THREE.Points
  private readonly edges: THREE.LineSegments
  private readonly faces: THREE.Mesh

  constructor(color: number, pointSize: number, faceOpacity: number, order: number) {
    this.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      color, size: pointSize, sizeAttenuation: false, depthTest: false, transparent: true,
    }))
    this.edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color, depthTest: false, transparent: true,
    }))
    this.faces = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: faceOpacity, depthTest: false, side: THREE.DoubleSide,
    }))
    this.points.renderOrder = order + 2
    this.edges.renderOrder = order + 1
    this.faces.renderOrder = order
    this.group.add(this.faces, this.edges, this.points)
  }

  setColor(color: number): void {
    for (const o of [this.points, this.edges, this.faces]) (o.material as THREE.PointsMaterial | THREE.LineBasicMaterial | THREE.MeshBasicMaterial).color.setHex(color)
  }

  color(): number {
    return (this.edges.material as THREE.LineBasicMaterial).color.getHex()
  }

  /** points, edge segments and triangles drawn */
  counts(): { points: number; edges: number; faces: number } {
    const n = (o: THREE.Object3D & { geometry: THREE.BufferGeometry }) => o.geometry.getAttribute('position')?.count ?? 0
    return { points: n(this.points), edges: n(this.edges) / 2, faces: n(this.faces) / 3 }
  }

  set(cage: Cage, s: CageSelection | null): void {
    const pts: number[] = []
    const lines: number[] = []
    const tris: number[] = []
    if (s) {
      const P = cage.positions
      for (const p of s.points) if (P[p]) pts.push(...P[p])
      for (const key of s.edges) {
        const [a, b] = key.split(':').map(Number)
        if (P[a] && P[b]) lines.push(...P[a], ...P[b])
      }
      for (const f of s.faces) {
        const loop = cage.faces[f]
        if (!loop) continue
        for (let i = 1; i + 1 < loop.length; i++) tris.push(...P[loop[0]], ...P[loop[i]], ...P[loop[i + 1]])
        for (let i = 0; i < loop.length; i++) lines.push(...P[loop[i]], ...P[loop[(i + 1) % loop.length]])
      }
      // corners of selected edges/faces read as selected too
      if (s.faces.length > 0 || s.edges.length > 0) {
        for (const p of selectionPoints(cage, { points: [], edges: s.edges, faces: s.faces })) pts.push(...P[p])
      }
    }
    this.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    this.edges.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))
    this.faces.geometry.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3))
    for (const o of [this.points, this.edges, this.faces]) o.geometry.computeBoundingSphere()
  }

  dispose(): void {
    for (const o of [this.points, this.edges, this.faces]) o.geometry.dispose()
  }
}
