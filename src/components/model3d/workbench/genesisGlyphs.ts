// WO SKC-15 (S3), item 1: the viewport feedback for the genesis rows.
//
// "Selecting/hovering one shows it in the viewport (a bounded plane glyph / origin triad -- modest,
//  not a ground grid; A3 is a different WO)."
//
// Deliberately modest: a base plane draws a BOUNDED square outline with a faint fill, and the
// Origin draws a three-axis triad. Neither is an infinite grid. Genesis glyphs are excluded from
// ordinary body/entity selection, while base-plane fills remain intentionally available to
// mode-local raycasters.
//
// No arc tessellation lives here (squares and straight axes only), which keeps
// src/tests/sketch/oneArcTessellator.test.ts's scan of this directory tree honest without needing
// an allowlist entry.

import * as THREE from 'three'
import type { PlaneFrame } from '../../../sketch3d'
import { BASE_PLANE_BY_NODE_ID, BASE_PLANE_FRAMES, BASE_PLANE_LABELS } from './basePlanes'
import { ORIGIN_NODE_ID } from '../../../doc'
import { asNumber } from '../../../theme/viewportColors'

/** Half-extent of a base-plane glyph, in mm. Big enough to read as "a plane", small enough that it
 *  never pretends to be the ground. */
const PLANE_HALF_MM = 40
/** Origin triad arm length, mm. */
const AXIS_MM = 25

const PLANE_EDGE_COLOR = asNumber('--vp-construction-plane')
const PLANE_FILL_COLOR = asNumber('--vp-construction-plane')
// XYZ triad colours, read from the SAME app axis tokens the CAM viewport's WCS triad and the nav
// view-cube arrows use (--vp-axis-x/y/z), so the workbench orientation triad reads identically to
// the rest of the app instead of the old bespoke pastel palette. X red, Y green, Z blue.
const AXIS_COLORS = [asNumber('--vp-axis-x'), asNumber('--vp-axis-y'), asNumber('--vp-axis-z')] as const
const AXIS_LABELS = ['X', 'Y', 'Z'] as const

// XYZ orientation-triad tuning (Q-75). The always-on origin triad used to be three faint unlabelled
// lines (opacity 0.4, no arrowheads, no letters) -- easy to miss while orbiting, so Operator did not read
// it as an "xyz triad ... good reference of where they are viewing in 3D space." The ambient triad now
// presents as a proper gizmo: token-coloured arms a touch more present, a small cone arrowhead, and an
// X/Y/Z letter at each tip. Kept small and subtle (subtle-over-loud) -- it sits inside the 40mm datum
// planes. The hover/selection 'emphasis' variant stays fully opaque, exactly as before.
const TRIAD_AMBIENT_OPACITY = 0.7 // ambient arm/arrowhead opacity (was the shared 0.4)
const TRIAD_ARROW_LEN_MM = 4 // cone arrowhead length
const TRIAD_ARROW_RADIUS_MM = 1.4 // cone arrowhead base radius
const TRIAD_LETTER_MM = 7 // world size of the X/Y/Z letter sprite (matches the plane-label cap-height)
const TRIAD_LETTER_CANVAS = 64 // px, square

/** Local (u,v) on the frame -> world. Mirrors sketch3d/planeMath's localToWorld without importing a
 *  Vec2 type this file has no other use for. */
function toWorld(frame: PlaneFrame, u: number, v: number): THREE.Vector3 {
  const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize()
  const xDir = new THREE.Vector3(frame.xDir.x, frame.xDir.y, frame.xDir.z).normalize()
  const yDir = new THREE.Vector3().crossVectors(normal, xDir) // planeMath convention: localY = normal x xDir
  return new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)
    .addScaledVector(xDir, u)
    .addScaledVector(yDir, v)
}

/**
 * WO UI-17 (criterion 5, Operator answer "always on + tree toggle"): the two glyph intensities.
 * 'emphasis' is the SKC-15/15C hover/selection treatment, unchanged. 'ambient' is the new
 * always-on rendering -- same geometry, dimmer line + fainter fill, so the planes read as
 * subtle reference furniture at rest and the hover/selection emphasis still visibly pops
 * OVER them (Q-1: hover = feedback, always).
 */
export type GenesisGlyphVariant = 'emphasis' | 'ambient'

const AMBIENT_LINE_OPACITY = 0.4
const AMBIENT_FILL_OPACITY = 0.045
// The active sketch grid is coplanar with its base datum and is added later to
// the scene. Keep depth testing ON (solids must still occlude datums), but sort
// genesis groups after the default-order grid so equal-depth transparent lines
// cannot erase the visible Origin/active-plane glyph. Emphasis remains above
// ambient, preserving the existing hover/selection hierarchy.
const AMBIENT_RENDER_ORDER = 1
const EMPHASIS_RENDER_ORDER = 2

/**
 * WO PLANE-LABEL-INPLANE (Operator ruling 2026-07-25, supersedes the SKETCH-PLANE-INWORKSPACE billboard
 * sprites): the XY/YZ/XZ initials are rendered IN the plane -- a small textured quad lying flat in
 * the plane's own surface, pinned at the top-right corner where its two axes meet (an in-plane
 * badge). Because it is a real coplanar Mesh (not a camera-facing Sprite), it transforms WITH
 * the plane: it foreshortens as the plane turns edge-on. That is the intended behaviour, not a bug --
 * the label reads as part of the scene, and the console hover-name (armed-for-selection line) carries
 * readability at any angle when the plane itself is nearly edge-on.
 *
 * Styling matches the plane's halo-blue perimeter: the initials are drawn in the SAME
 * `--vp-construction-plane` blue the outline/fill use (passed in as `color`), with a subtle glow of
 * that same blue (canvas shadowBlur) so label + plane read as ONE object. Deliberately NOT bold white.
 * Roughly half the previous billboard's visual size (7mm cap-height vs the old 16mm).
 *
 * Drawn into a 2D canvas carried as a CanvasTexture, so `disposeGenesisGlyph` frees BOTH the
 * material and its `.map` (material.dispose() does not release the texture).
 */
const LABEL_CANVAS_W = 128
const LABEL_CANVAS_H = 64
/** World cap-height of a label, mm. Half the old 16mm billboard so it stays subtle next to a 40mm
 *  half-extent plane -- part of the scene, not a sticker. */
const LABEL_HEIGHT_MM = 7
/** Inset of the label's outer edge from the plane's corner, mm -- pins it just inside the corner. */
const LABEL_CORNER_INSET_MM = 3
// Q-75 (Operator verbatim: "I like the newer smaller Halo but ... it could be even more muted or fainter
// so that way it's not visually distracting but is present for the user's reference while orbiting").
// The label is dialled down: lower quad opacity, a lighter font weight, and a softer halo-blue glow
// (smaller shadowBlur). Still drawn in --vp-construction-plane blue and still legible at typical zoom
// -- just quieter. Named so a render-gate pin can assert the reduced weight.
const LABEL_OPACITY = 0.5 // was 0.9
const LABEL_FONT_WEIGHT = 500 // was 600
const LABEL_GLOW_BLUR = 6 // outer halo pass, was 10
const LABEL_GLOW_BLUR_CORE = 2 // tighter core pass, was 4

function buildPlaneLabel(label: string, frame: PlaneFrame, color: number): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = LABEL_CANVAS_W
  canvas.height = LABEL_CANVAS_H
  const ctx = canvas.getContext('2d')
  const hex = `#${color.toString(16).padStart(6, '0')}`
  if (ctx !== null) {
    ctx.clearRect(0, 0, LABEL_CANVAS_W, LABEL_CANVAS_H)
    // Medium weight (not heavy bold) in the plane's own blue, with a soft glow of the same blue so
    // the label reads as an extension of the halo-blue perimeter rather than a stuck-on white sticker.
    ctx.font = `${LABEL_FONT_WEIGHT} 40px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = hex
    ctx.shadowBlur = LABEL_GLOW_BLUR
    ctx.fillStyle = hex
    ctx.fillText(label, LABEL_CANVAS_W / 2, LABEL_CANVAS_H / 2)
    // A tighter second pass firms up the core without adding a second colour.
    ctx.shadowBlur = LABEL_GLOW_BLUR_CORE
    ctx.fillText(label, LABEL_CANVAS_W / 2, LABEL_CANVAS_H / 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true

  // A coplanar quad in the plane's own (u,v): the label lies FLAT in the plane and foreshortens with
  // it. Pinned at the +u/+v (top-right) corner, its outer edge inset from the corner by a small margin.
  const h = PLANE_HALF_MM
  const labelH = LABEL_HEIGHT_MM
  const labelW = labelH * (LABEL_CANVAS_W / LABEL_CANVAS_H)
  const uMax = h - LABEL_CORNER_INSET_MM
  const uMin = uMax - labelW
  const vMax = h - LABEL_CORNER_INSET_MM
  const vMin = vMax - labelH
  const p00 = toWorld(frame, uMin, vMin)
  const p10 = toWorld(frame, uMax, vMin)
  const p11 = toWorld(frame, uMax, vMax)
  const p01 = toWorld(frame, uMin, vMax)
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z,
    p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z,
  ], 3))
  // UV origin bottom-left; local +u -> texture +u, local +v -> texture +v keeps the initials upright.
  geom.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2))

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: LABEL_OPACITY,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide, // readable from either face, like the plane fill it sits on
  })
  const mesh = new THREE.Mesh(geom, material)
  // The label is decorative furniture: it must NEVER be a pick target. Unlike the old Sprite, a Mesh
  // DOES carry a `face`, so the downstream `hit.face != null` filter in resolveBasePlanePick would
  // otherwise let the label be picked INSTEAD of the plane it names. A no-op raycast is now the sole
  // guard that keeps it out of every ray, in the browser and in DOM-less harnesses alike.
  mesh.raycast = () => {}
  // Above the fills so the initials always read; still after the ambient plane it labels.
  mesh.renderOrder = AMBIENT_RENDER_ORDER + 0.5
  // Identity tag so a render-gate test can assert WHICH plane a coplanar label names (there are no
  // Sprites in the scene any more -- the test keys off this instead of an instanceof Sprite check).
  mesh.userData.planeLabel = label
  return mesh
}

/** A bounded plane: outline + faint double-sided fill. `depthTest:false` is NOT used -- the root's
 *  render order only resolves the coplanar sketch-grid tie, while the glyph remains real geometry
 *  in the scene and occludes correctly behind solids. `label` (the plane's XY/YZ/XZ initials) is
 *  drawn as a coplanar corner quad on the ambient (always-on) layer only, so the hover/selection
 *  emphasis glyph does not stack a second label over the ambient one it pops over. */
function buildPlaneGlyph(frame: PlaneFrame, variant: GenesisGlyphVariant, label?: string): THREE.Object3D {
  const group = new THREE.Group()
  const h = PLANE_HALF_MM
  const corners = [toWorld(frame, -h, -h), toWorld(frame, h, -h), toWorld(frame, h, h), toWorld(frame, -h, h)]

  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(corners),
    variant === 'ambient'
      ? new THREE.LineBasicMaterial({ color: PLANE_EDGE_COLOR, transparent: true, opacity: AMBIENT_LINE_OPACITY })
      : new THREE.LineBasicMaterial({ color: PLANE_EDGE_COLOR }),
  )

  // Two triangles over the same four corners.
  const fillGeom = new THREE.BufferGeometry().setFromPoints([
    corners[0], corners[1], corners[2],
    corners[0], corners[2], corners[3],
  ])
  fillGeom.computeVertexNormals()
  const fill = new THREE.Mesh(
    fillGeom,
    new THREE.MeshBasicMaterial({
      color: PLANE_FILL_COLOR,
      transparent: true,
      opacity: variant === 'ambient' ? AMBIENT_FILL_OPACITY : 0.09,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )

  group.add(outline, fill)
  // The corner label is a canvas-textured coplanar quad; it needs a DOM. `resolveBasePlanePick` and
  // its pure-math unit tests build these glyphs in a DOM-less Node environment where there is no
  // viewport to label at all -- guarding on `document` keeps the label a browser/jsdom-only decoration
  // without coupling the pure resolver to a DOM. This is an environment-capability guard (no canvas
  // exists), not a product behavior fallback: every rendering context has a document and shows the label.
  if (label !== undefined && variant === 'ambient' && typeof document !== 'undefined') {
    group.add(buildPlaneLabel(label, frame, PLANE_EDGE_COLOR))
  }
  return group
}

/** A small camera-facing X/Y/Z letter for an axis tip. A Sprite (not a coplanar quad like the plane
 *  label) so the axis name stays readable from EVERY orbit angle -- the orientation triad's whole job
 *  is to answer "which way is X" at any camera. Drawn in the axis colour; a no-op raycast keeps it out
 *  of every pick, exactly like the plane label. Carried on a CanvasTexture that disposeGenesisGlyph
 *  frees explicitly. */
function buildAxisLetter(letter: string, tip: THREE.Vector3, dir: THREE.Vector3, color: number, ambient: boolean): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = TRIAD_LETTER_CANVAS
  canvas.height = TRIAD_LETTER_CANVAS
  const ctx = canvas.getContext('2d')
  const hex = `#${color.toString(16).padStart(6, '0')}`
  if (ctx !== null) {
    ctx.clearRect(0, 0, TRIAD_LETTER_CANVAS, TRIAD_LETTER_CANVAS)
    ctx.font = '700 44px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = hex
    ctx.fillText(letter, TRIAD_LETTER_CANVAS / 2, TRIAD_LETTER_CANVAS / 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: ambient ? 0.85 : 1, depthTest: true, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  // Just beyond the arrowhead apex so the letter never overlaps the cone.
  sprite.position.copy(tip).addScaledVector(dir, TRIAD_ARROW_LEN_MM + TRIAD_LETTER_MM * 0.55)
  sprite.scale.set(TRIAD_LETTER_MM, TRIAD_LETTER_MM, 1)
  sprite.raycast = () => {} // decorative furniture, never a pick target
  sprite.userData.axisLabel = letter
  return sprite
}

/** The Origin: a proper XYZ orientation triad -- three token-coloured arms (X red / Y green / Z blue)
 *  from the world origin, each capped with a cone arrowhead and an X/Y/Z letter at the tip. The
 *  'ambient' (always-on) variant renders it subtly (TRIAD_AMBIENT_OPACITY) as the orbit reference; the
 *  'emphasis' hover/selection variant stays fully opaque. Colours come from --vp-axis-x/y/z, matching
 *  the CAM viewport's WCS triad and the nav view-cube arrows. */
function buildOriginGlyph(variant: GenesisGlyphVariant): THREE.Object3D {
  const group = new THREE.Group()
  const ambient = variant === 'ambient'
  const dirs: Array<[number, number, number]> = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  dirs.forEach(([x, y, z], i) => {
    const color = AXIS_COLORS[i]
    const dir = new THREE.Vector3(x, y, z)
    const tip = dir.clone().multiplyScalar(AXIS_MM)
    // Arm line: origin -> tip.
    const lineMat = ambient
      ? new THREE.LineBasicMaterial({ color, transparent: true, opacity: TRIAD_AMBIENT_OPACITY })
      : new THREE.LineBasicMaterial({ color })
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), tip]), lineMat))
    // Cone arrowhead: default cone points +Y, so rotate +Y -> the axis direction and seat its base at
    // the arm tip (apex extends one length beyond).
    const coneMat = ambient
      ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: TRIAD_AMBIENT_OPACITY, depthWrite: false })
      : new THREE.MeshBasicMaterial({ color, depthWrite: false })
    const cone = new THREE.Mesh(new THREE.ConeGeometry(TRIAD_ARROW_RADIUS_MM, TRIAD_ARROW_LEN_MM, 12), coneMat)
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    cone.position.copy(tip).addScaledVector(dir, TRIAD_ARROW_LEN_MM / 2)
    cone.raycast = () => {} // decorative furniture, never a pick target
    group.add(cone)
    // X/Y/Z letter at the tip -- browser/jsdom only (DOM-less pure-math harnesses skip it, like the
    // plane label). The typeof-document guard keeps the pure resolver DOM-free.
    if (typeof document !== 'undefined') group.add(buildAxisLetter(AXIS_LABELS[i], tip, dir, color, ambient))
  })
  return group
}

/**
 * The glyph for a genesis node id, or null when `nodeId` is not one. Caller owns adding it to the
 * scene and calling `disposeGenesisGlyph` when the selection changes.
 *
 * WO UI-17 (criterion 5): `variant` defaults to 'emphasis' -- the pre-existing hover/selection
 * call sites are byte-identical in behavior; the page's new always-on layer passes 'ambient'.
 */
export function buildGenesisGlyph(nodeId: string | null, variant: GenesisGlyphVariant = 'emphasis'): THREE.Object3D | null {
  if (nodeId === null) return null
  let glyph: THREE.Object3D | null = null
  if (nodeId === ORIGIN_NODE_ID) glyph = buildOriginGlyph(variant)
  else {
    const plane = BASE_PLANE_BY_NODE_ID[nodeId]
    glyph = plane === undefined ? null : buildPlaneGlyph(BASE_PLANE_FRAMES[plane], variant, BASE_PLANE_LABELS[plane])
  }
  // WO SKC-15C (audit major #1): stamp the source node id so a render-gate test can assert WHICH
  // genesis glyph the viewport drew (hover-preview vs sticky-selection), not merely that "a glyph"
  // appeared. Not read by any rendering path -- purely an identity tag on scene metadata.
  // WO UI-17: the variant is stamped too, so the planes-visible test can tell the always-on
  // ambient layer apart from a hover/selection emphasis glyph over the same node.
  if (glyph !== null) {
    glyph.renderOrder = variant === 'ambient' ? AMBIENT_RENDER_ORDER : EMPHASIS_RENDER_ORDER
    glyph.userData.genesisNodeId = nodeId
    glyph.userData.genesisVariant = variant
  }
  return glyph
}

/** A first-class construction-plane sheet. It deliberately reuses the same
 * bounded plane geometry, token colors, in-plane label, and emphasis levels
 * as the permanent XY/XZ/YZ furniture; only its identity metadata differs. */
export function buildReferencePlaneGlyph(
  nodeId: string,
  frame: PlaneFrame,
  label: string,
  variant: GenesisGlyphVariant = 'ambient',
): THREE.Object3D {
  const glyph = buildPlaneGlyph(frame, variant, label)
  glyph.renderOrder = variant === 'ambient' ? AMBIENT_RENDER_ORDER : EMPHASIS_RENDER_ORDER
  glyph.userData.referencePlaneNodeId = nodeId
  glyph.userData.referencePlaneVariant = variant
  return glyph
}

/** Frees every geometry/material the glyph owns (it owns all of them -- nothing is shared). The
 *  coplanar plane-label Mesh owns its own BufferGeometry AND a CanvasTexture on its material that
 *  material.dispose() does not release, so its `.map` is freed explicitly. */
export function disposeGenesisGlyph(glyph: THREE.Object3D): void {
  const disposeMaterial = (material: THREE.Material): void => {
    const map = (material as Partial<THREE.MeshBasicMaterial>).map
    map?.dispose()
    material.dispose()
  }
  glyph.traverse((obj) => {
    const withGeom = obj as Partial<THREE.Mesh>
    // Sprites (the X/Y/Z axis letters) share a single module-level BufferGeometry in three.js; disposing
    // it would corrupt every other Sprite in the app. Only Meshes/Lines own their geometry here. The
    // Sprite's per-instance SpriteMaterial and its CanvasTexture map ARE freed below.
    if (obj.type !== 'Sprite') withGeom.geometry?.dispose()
    const material = withGeom.material
    if (Array.isArray(material)) material.forEach(disposeMaterial)
    else if (material != null) disposeMaterial(material)
  })
}
