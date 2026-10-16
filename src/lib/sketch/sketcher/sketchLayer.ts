import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import type {
  Sketch,
  SketchEntity,
  SketchArcEntity,
  SketchCircleEntity,
  SketchEllipseEntity,
  SketchEllipticalArcEntity,
  SketchSplineEntity,
  SketchConstraint,
  SketchDimension,
  PointRef,
  Vec2,
  SolveStatus,
} from '../types'
import {
  tessellateEllipse as ellipsePolyline,
  tessellateEllipticalArc as ellipticalArcPolyline,
  ellipsePointAt, nearestPointOnEllipse, distanceToEllipticalArc,
  ellipseAxisDimLeader, ellipseFoci, ellipseFocusSite,
} from '../ellipse'
import {
  tessellateSpline as splinePolyline, nearestPointOnSpline, splineControlMarkers,
  splineHandleLegs, splineHasControlSites, splinePointAt, SPLINE_TESS_STEP_MM,
} from '../spline'
import { blockMemberWorldEntities, materializeInstancesForView } from '../blocks'
import { markDepthExtentExempt } from '../../../viewport3d/depthExtent'
import { textToWorldPolylines, distanceToTextBBox } from '../text'
import { outlineTextToWorldContours, distanceToOutlineTextBBox } from '../textOutline'
import {
  resolveTextPath, textOnPathToWorldPolylines, outlineTextOnPathToWorldContours,
  textOnPathPickDistance, textAttachMarkerWorld, textCaretWorldSegment,
} from '../textOnPath'
import {
  arcSamplePoints,
  circleSamplePoints,
  arcSegmentCount as arcSegmentCountFor,
  RENDER_ARC_DENSITY,
} from './geometry/arcTessellation'
import {
  formatDimensionValue, formatChamferSetbackValue, positiveArcSweep, type PlannedDimension,
} from '../tools/dimTool'
import { dimGuides, ordinateStackAnchor } from '../tools/dimPlacement'
import { chevronTip, screenSizedChevron } from '../tools/dimensionGuideSizing'
import type { Units } from '../../ui/unitFormat'
import { asNumber } from '../../../theme/viewportColors'
import { resolveSelectionGlowColors } from '../../viewport/lighting/selectionGlowTokens'
import { getSelectionGlow } from '../../../store/uiPrefs'
import {
  centerPointForEntity,
  centerSelectionIdForEntity,
  decodeCenterSelectionRef,
  decodeEndpointSelectionRef,
  encodeEndpointSelectionRef,
} from '../centerReferences'

// ============================================================
// Sketch render layer (Stage 2)
// ============================================================
//
// A single THREE.Group owned by CNCViewport that renders the ACTIVE sketch
// document. It is data-driven and reactive: the owning React effect calls
// update() with the current Sketch whenever the store's activeSketch
// reference changes, and the layer rebuilds its scene objects from scratch.
// Sketches are small documents (tens of entities), so a full rebuild per
// edit is cheap and keeps the layer stateless with respect to diffing.
//
// Layering contract:
// - geometry remains only microscopically offset from the support plane, so an
//   oblique view does not show a detached duplicate around the model boundary;
// - sketch curves draw without depth testing at ACTIVE_SKETCH_RENDER_ORDER, so
//   coplanar geometry remains legible over the support face;
// - transient tool/snap overlays still paint later at renderOrder >= 998.

// WO SKC-55: exported so the host's pointer-to-plane raycast (clientToPlaneWorld) can intersect
// the SAME lifted plane the layer renders on -- the draw/pick parallax mismatch this WO fixes.
export const SKETCH_Z = 0.02
export const ACTIVE_SKETCH_RENDER_ORDER = 30

// View-state passed alongside the document. Selection lives in the sketch
// slice; hover is viewport-local, high-frequency, and set via setHover()
// (it deliberately survives document/selection updates from React).
export interface SketchViewState {
  selectedIds: ReadonlySet<string>
  glyphsVisible: boolean
  /** Optional host-owned, session-only origin anchor. When present, the point
   *  keeps normal analytic click/hover picking but is excluded from marquee
   *  collection and receives the dedicated origin marker treatment below.
   *  WO SKC-49: BOTH hosts now set this (workbench directly; CAM's own
   *  injection seam in src/store/index.ts mirrors it into activeSketch). */
  originAnchorId?: string
  /** Host-owned fix constraint for the synthetic origin. The origin marker
   *  already communicates the fixed state, so its coincident badge is omitted
   *  to keep the point itself hoverable/clickable for dimensions. */
  originAnchorFixId?: string
  /** Synthetic point supplied by a host whose persisted/raw sketch deliberately
   *  omits the origin anchor. update() augments only its private sketch view so
   *  first paint and analytic picking see the point without mutating the caller. */
  originAnchorEntity?: Extract<SketchEntity, { kind: 'point' }>
  /** WO SKC-49: host-owned, session-only X/Y axis LINE ids (origin's axis siblings).
   *  Members keep normal analytic click/hover/pick/snap-BODY behavior (they are ordinary
   *  fixed construction lines -- see sketchAnchors.ts) but paint with the dedicated,
   *  extra-muted axis treatment below instead of ordinary construction dimming, and are
   *  excluded from marquee collection exactly like the origin. Endpoint/midpoint SNAP
   *  SPOTS are suppressed independently, at the snap engine (snap.ts), not gated by this
   *  field -- an axis's synthetic endpoints are arbitrary (WO SKC-49 scope item 5). */
  axisEntityIds?: ReadonlySet<string>
  /** Host-owned fix constraint ids for the injected axes -- badge suppression companion
   *  to axisEntityIds, mirrors originAnchorFixId. */
  axisFixIds?: ReadonlySet<string>
  /** Id of the text entity currently in the WYSIWYG in-canvas editor
   *  (store.sketchTextEditId), or null. That entity is drawn in the active-edit
   *  cyan tint + glow so the user sees typing is live -- the in-canvas input is
   *  visually invisible (SketchTextInput), so this IS the edit indicator. */
  editingId?: string | null
  /** Insertion-caret index of the open text edit
   *  (store.sketchTextCaretIndex): the layer draws the in-canvas caret (M1b)
   *  at this string index through textCaretWorldSegment -- the SAME layout
   *  pipeline as the glyphs. null/absent falls back to end-of-string. */
  caretIndex?: number | null
  /** SKC-BLOCKS Stage 4: the OUTER entities of a live block edit-in-place
   *  session (everything NOT a member of the block being edited) -- excludes
   *  the injected origin/axis anchors. While set, these entities render as a
   *  dim, non-interactive ghost backdrop: they never take hover/selection
   *  accent and are excluded from pick/marquee, so the user's attention and
   *  clicks stay on the block's own (now loose, editable) members. Undefined/
   *  empty leaves rendering and picking completely unchanged. */
  blockEditGhostIds?: ReadonlySet<string>
}

const EMPTY_VIEW: SketchViewState = {
  selectedIds: new Set(),
  glyphsVisible: true,
  editingId: null,
  caretIndex: null,
}

// ---- Colors --------------------------------------------------------------
//
// Definition-state palette: blue = under-defined, red =
// conflicting. Pure black for fully defined is unreadable on our
// dark theme, so we use a near-white neutral (#e2e8f0 = --text-primary)
// that reads as "locked solid" against the dark background while staying
// clearly distinct from the active blue.
const SKETCH_COLORS_BASE = {
  underDefined: asNumber('--sketch-under-defined'),
  fullyDefined: asNumber('--sketch-fully-defined'),
  conflict:     asNumber('--sketch-conflict'),
  // Project/Use reference geometry is neither native definition-state blue nor
  // selection orange. The violet remains readable on the default blue body and
  // dark canvas while making the static-copy semantics immediately visible.
  reference:    0xd58cff,
  // Selection accent matches the existing loop-pick highlight (0xffaa00).
  selected:     asNumber('--sketch-selected'),
  // Hover halo: signature cyan (#00e5ff). Distinct from every definition
  // state (amber=selected, red=conflict, blue=under-defined), so no collision.
  hover:        asNumber('--sketch-hover'),
  background:   asNumber('--vp-canvas'),
} as const

/** GEO-26 Stage B: `selected`/`hover` resolve through the shared
 *  selectionGlowTokens token set, using the LIVE persisted Settings >
 *  Display preference (getSelectionGlow(), src/store/uiPrefs.ts). Getters,
 *  not a computed-once object, because the active candidate can change
 *  between renders (a live Settings switch) without reloading this module --
 *  refreshGlow()/rebuild() re-read them on every entity repaint. Default
 *  ('current') returns exactly SKETCH_COLORS_BASE's values -- byte-identical
 *  to the pre-GEO-26 shipped colors, still reachable by explicitly picking
 *  'Current' in Settings.
 *
 *  Resolved against the 'classic' theme id: the sketch canvas itself is not
 *  wired into the per-theme viewport system today (no viewportTheme read
 *  anywhere under src/lib/sketch/**, confirmed by grep) -- candidates
 *  'signature' and 'brightness-halo' are theme-invariant by design so this
 *  has no effect on them either way; 'complementary' (the one per-theme-
 *  tuned candidate) resolves to its classic-theme pair here regardless of
 *  the Model/CAM viewport's active theme. Documented Stage-A scope note,
 *  carried into Stage B unchanged (a follow-on WO would thread the real
 *  active theme into the sketch layer if a per-theme sketch candidate turns
 *  out to matter), not a defect. */
export const SKETCH_COLORS = {
  underDefined: SKETCH_COLORS_BASE.underDefined,
  fullyDefined: SKETCH_COLORS_BASE.fullyDefined,
  conflict: SKETCH_COLORS_BASE.conflict,
  reference: SKETCH_COLORS_BASE.reference,
  background: SKETCH_COLORS_BASE.background,
  get selected(): number {
    const glow = resolveSelectionGlowColors(getSelectionGlow(), 'classic')
    return glow === null ? SKETCH_COLORS_BASE.selected : glow.selected
  },
  get hover(): number {
    const glow = resolveSelectionGlowColors(getSelectionGlow(), 'classic')
    return glow === null ? SKETCH_COLORS_BASE.hover : glow.hover
  },
}

// Construction entities render dimmer: lerp toward the viewport background.
const CONSTRUCTION_DIM = 0.45

function dimColor(hex: number): number {
  const c = new THREE.Color(hex)
  c.lerp(new THREE.Color(SKETCH_COLORS.background), CONSTRUCTION_DIM)
  return c.getHex()
}

// SKC-BLOCKS Stage 4: the block-edit-in-place ghost backdrop dims heavier than
// ordinary construction (CONSTRUCTION_DIM above) -- these entities are not
// just de-emphasized styling, they are OUT OF SCOPE for the live edit session
// entirely, and the stronger lerp reads that unambiguously against a merely-
// construction line.
const BLOCK_EDIT_GHOST_DIM = 0.72

function ghostDimColor(hex: number): number {
  const c = new THREE.Color(hex)
  c.lerp(new THREE.Color(SKETCH_COLORS.background), BLOCK_EDIT_GHOST_DIM)
  return c.getHex()
}

function hoverColor(hex: number): number {
  const c = new THREE.Color(hex)
  c.lerp(new THREE.Color(0xffffff), 0.5)
  return c.getHex()
}

// ---- Hover treatment (F9, shipped: variant B, Operator 2026-06-13) -----------
//
// Hover draws a soft cyan halo UNDER the hovered entity; the entity's own
// definition-state color is left untouched on top. The halo color is the app
// signature cyan (--sketch-hover -> --cyan-400 #00e5ff); it is NOT used for any
// sketch definition state (amber=selected, red=conflict, blue=under-defined),
// so there is no semantic collision on hover.
//
// Width is expressed in SCREEN PIXELS (LineMaterial, worldUnits:false) so the
// halo reads identically at any zoom. Three's plain Line.linewidth is ignored
// on most WebGL platforms, so the fat-line addon (Line2) is what gives a
// reliably wide stroke; it sits slightly behind the entity in Z at a low
// renderOrder so the entity's colored stroke always draws on top unchanged.
const HALO_WIDTH_PX = 8
const HALO_OPACITY = 0.32

/** Resample a polyline to `segments` equal-length segments (>= 1). Used to
 *  give the fat-line underlay enough segments to render reliably. */
function densifyPolyline(pts: THREE.Vector3[], segments: number): THREE.Vector3[] {
  if (pts.length < 2) return pts
  // Cumulative arc length.
  const acc = [0]
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + pts[i].distanceTo(pts[i - 1]))
  const total = acc[acc.length - 1]
  if (total <= 1e-9) return pts
  const out: THREE.Vector3[] = []
  let seg = 0
  for (let k = 0; k <= segments; k++) {
    const target = (total * k) / segments
    while (seg < pts.length - 2 && acc[seg + 1] < target) seg++
    const span = acc[seg + 1] - acc[seg] || 1
    const t = Math.min(1, Math.max(0, (target - acc[seg]) / span))
    out.push(pts[seg].clone().lerp(pts[seg + 1], t))
  }
  return out
}

// Per-entity definition-state color (definition-state semantics, PLAN 3.4).
//
// EXACT path (Stage 4): solveStatus.fullyDefinedEntities carries the
// solver's fix-probe diagnosis — an entity is in the set iff ALL of its
// parameters are determined. `sets.defined` is that list as a Set, or
// null when the status predates the diagnosis (legacy persisted docs).
// Drag solves CARRY the pre-drag list (gcsMapping), so entities keep
// their true colors mid-drag instead of flashing white when temporary
// pins consume the global dof.
//
// Rules, in precedence order:
//   - conflicts present -> entities referenced by the conflicting
//     constraint/dimension ids render red
//   - exact list available -> in-list = fully-defined, else blue
//   - LEGACY FALLBACK (no list): dof == 0 -> all fully-defined; else
//     blue, except entities grounded by a fix constraint (genuinely
//     immovable) which render fully-defined — the documented v1
//     whole-sketch approximation, kept ONLY for statuses persisted
//     before the diagnosis existed
//   - solveStatus null (never solved, e.g. a fresh lift) -> definition
//     state UNKNOWN: render under-defined blue (never white) until the
//     open-solve returns with the real status
export function entityDefinitionColor(
  st: SolveStatus | null,
  entityId: string,
  sets: {
    conflict: ReadonlySet<string>
    defined: ReadonlySet<string> | null
    fixed: ReadonlySet<string>
  },
): number {
  if (st !== null && st.conflicting.length > 0 && sets.conflict.has(entityId)) {
    return SKETCH_COLORS.conflict
  }
  if (st !== null && sets.defined !== null) {
    return sets.defined.has(entityId)
      ? SKETCH_COLORS.fullyDefined
      : SKETCH_COLORS.underDefined
  }
  // solveFailed (ADR 0003): a FAILED solve's dof is a placeholder, not a
  // definition verdict. When the failed status carried the previous
  // solve's fullyDefinedEntities, the exact-list branch above already kept
  // the previous coloring; with no list, fall through to neutral
  // under-defined blue rather than painting everything "defined".
  if (st !== null && !st.solveFailed && st.conflicting.length === 0 && st.dof === 0) {
    return SKETCH_COLORS.fullyDefined
  }
  if (sets.fixed.has(entityId)) return SKETCH_COLORS.fullyDefined
  return SKETCH_COLORS.underDefined
}

// ---- Tessellation ----------------------------------------------------------
//
// WO SKC-14 (BK-88): the arc/circle SWEEP WALK lives in exactly one module,
// sketcher/geometry/arcTessellation.ts. Everything below is a lift into
// THREE.Vector3 under this layer's render density policy (chord error <= 0.02mm,
// 12..256 segments) -- the same policy the private loops here used before.

/** Render-density segment count for an arc of this radius and sweep. */
export function arcSegmentCount(radius: number, sweep: number): number {
  return arcSegmentCountFor(radius, sweep, RENDER_ARC_DENSITY)
}

const toVec3 = (p: { x: number; y: number }) => new THREE.Vector3(p.x, p.y, 0)

export function tessellateArc(e: SketchArcEntity): THREE.Vector3[] {
  // Arcs sweep CCW from startAngle to endAngle (planegcs convention).
  return arcSamplePoints(e, RENDER_ARC_DENSITY).map(toVec3)
}

export function tessellateCircle(e: SketchCircleEntity): THREE.Vector3[] {
  return circleSamplePoints(e.center, e.radius, RENDER_ARC_DENSITY).map(toVec3)
}

export function tessellateEllipse(e: SketchEllipseEntity): THREE.Vector3[] {
  return ellipsePolyline(e).map((p) => new THREE.Vector3(p.x, p.y, 0))
}

export function tessellateEllipticalArc(e: SketchEllipticalArcEntity): THREE.Vector3[] {
  return ellipticalArcPolyline(e, e.startParam, e.endParam).map(
    (p) => new THREE.Vector3(p.x, p.y, 0),
  )
}

export function tessellateSpline(e: SketchSplineEntity): THREE.Vector3[] {
  return splinePolyline(e.points, e.closed, SPLINE_TESS_STEP_MM, e.form)
    .map((p) => new THREE.Vector3(p.x, p.y, 0))
}

// ---- Constraint / dimension entity references ------------------------------

/** Entity ids referenced by a constraint or dimension (for conflict
 *  coloring and glyph anchoring). Mirrors the store's ref-id helpers. */
export function referencedEntityIds(c: SketchConstraint | SketchDimension): string[] {
  const ids: string[] = []
  switch (c.kind) {
    case 'coincident':
    case 'symmetric':
      ids.push(c.a.entityId, c.b.entityId)
      if (c.kind === 'symmetric') ids.push(c.axis)
      break
    case 'concentric':
    case 'parallel':
    case 'perpendicular':
    case 'tangent':
    case 'equal':
    case 'angle':
      ids.push(c.a, c.b)
      break
    case 'horizontal':
    case 'vertical':
      if (c.line) ids.push(c.line)
      if (c.points) ids.push(c.points[0].entityId, c.points[1].entityId)
      break
    case 'midpoint':
      ids.push(c.point.entityId, c.line)
      break
    case 'fix':
      if (c.point) ids.push(c.point.entityId)
      if (c.entityId) ids.push(c.entityId)
      break
    case 'point_on_object':
      ids.push(c.point.entityId, c.object)
      break
    case 'continuity_g1':
    case 'continuity_g2':
      ids.push(c.a.entityId, c.b.entityId)
      break
    case 'distance':
    case 'distanceX':
    case 'distanceY':
      ids.push(c.a.entityId, c.b.entityId)
      break
    // WO-1867: an ordinate binds its stack's DATUM as well as the measured
    // point, so hovering it highlights both ends of what it measures.
    case 'ordinate':
      ids.push(c.origin.entityId, c.point.entityId)
      break
    // WO-1868: a three-point angle highlights its vertex and both legs' owners.
    case 'angle3':
      ids.push(c.vertex.entityId, c.a.entityId, c.b.entityId)
      break
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
      ids.push(c.entityId)
      break
  }
  return [...new Set(ids)]
}

// ---- Geometry resolution ----------------------------------------------------

/** Resolve a constraint point site to current sketch-plane coordinates. */
export function resolvePointRef(sketch: Sketch, ref: PointRef): Vec2 | null {
  const e = sketch.entities.find((x) => x.id === ref.entityId)
  if (!e) return null
  switch (e.kind) {
    case 'point':
      return ref.site === 'self' ? e.at : null
    case 'line':
      if (ref.site === 'start') return e.start
      if (ref.site === 'end') return e.end
      if (ref.site === 'center') {
        return { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 }
      }
      return null
    case 'circle':
      return ref.site === 'center' ? e.center : null
    case 'arc':
      if (ref.site === 'center') return e.center
      if (ref.site === 'start') {
        return { x: e.center.x + e.radius * Math.cos(e.startAngle),
                 y: e.center.y + e.radius * Math.sin(e.startAngle) }
      }
      if (ref.site === 'end') {
        return { x: e.center.x + e.radius * Math.cos(e.endAngle),
                 y: e.center.y + e.radius * Math.sin(e.endAngle) }
      }
      return null
    case 'ellipse':
    case 'elliptical-arc':
      // Shape params are solver-inert; center is a real solver point and the
      // foci DERIVE from center + shape (collapsed onto the center for a
      // circle-degenerate ellipse — ellipseFocusSite handles that).
      if (ref.site === 'center') return e.center
      if (ref.site === 'focus1' || ref.site === 'focus2') return ellipseFocusSite(e, ref.site)
      return null
    case 'spline':
      // Solver-inert: only the first through-point (anchor) site exists.
      return ref.site === 'start' ? e.points[0] : null
    case 'text':
      // Solver-inert: only the baseline-left anchor site exists.
      return ref.site === 'start' ? e.at : null
    case 'block':
      // Solver-inert block: only the origin anchor site exists (SKC-BLOCKS).
      return ref.site === 'origin' ? e.origin : null
  }
}

/** Representative anchor point on an entity for badge placement. */
export function entityBadgeAnchor(e: SketchEntity): Vec2 {
  switch (e.kind) {
    case 'point':
      return e.at
    case 'line':
      return { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 }
    case 'circle':
      // On the curve at 45 deg so the badge does not bury the center mark.
      return { x: e.center.x + e.radius * Math.SQRT1_2,
               y: e.center.y + e.radius * Math.SQRT1_2 }
    case 'arc': {
      let sweep = e.endAngle - e.startAngle
      while (sweep <= 0) sweep += Math.PI * 2
      const mid = e.startAngle + sweep / 2
      return { x: e.center.x + e.radius * Math.cos(mid),
               y: e.center.y + e.radius * Math.sin(mid) }
    }
    case 'ellipse':
      // On the curve at the +major/+minor diagonal so it clears the center.
      return ellipsePointAt(e, Math.PI / 4)
    case 'elliptical-arc':
      return ellipsePointAt(e, (e.startParam + e.endParam) / 2)
    case 'spline':
      // A representative through-point near the middle of the run. A control
      // point or bezier handle can sit off the curve, so those forms take the
      // curve's own mid-parameter point instead (WO-1862).
      if (splineHasControlSites(e.form)) {
        const n = e.points.length
        return splinePointAt(e.points, e.closed, (e.closed ? n : n - 1) / 2, e.form)
      }
      return e.points[Math.floor(e.points.length / 2)]
    case 'text':
      // The baseline-left anchor (badge rides the start of the text).
      return e.at
    case 'block':
      // The block's origin anchor (badges ride the drag handle).
      return e.origin
  }
}

// Badge text per constraint kind — simple consistent text badges for v1
// (icon set is a later polish item). Exported so the snap
// inference preview (CNCViewport) shows the SAME iconography for pending
// constraints that the committed badges use.
export const BADGE_TEXT: Record<SketchConstraint['kind'], string> = {
  coincident: '+',
  concentric: '@',
  parallel: '//',
  perpendicular: '-|',
  collinear: '--',
  horizontal: 'H',
  vertical: 'V',
  tangent: 'T',
  equal: '=',
  midpoint: 'M',
  symmetric: 'S',
  fix: 'F',
  point_on_object: 'P',
  // WO-1866: tangent / curvature continuity at a spline joint.
  continuity_g1: 'G1',
  continuity_g2: 'G2',
  // WO-1865: a point pierced by a model edge.
  pierce: 'Pc',
}

/** World anchor points where a constraint's badge(s) should appear. */
export function constraintBadgeAnchors(sketch: Sketch, c: SketchConstraint): Vec2[] {
  const ent = (id: string) => sketch.entities.find((e) => e.id === id)
  const anchorOf = (id: string): Vec2[] => {
    const e = ent(id)
    return e ? [entityBadgeAnchor(e)] : []
  }
  switch (c.kind) {
    case 'coincident': {
      const p = resolvePointRef(sketch, c.a)
      return p ? [p] : []
    }
    case 'continuity_g1':
    case 'continuity_g2': {
      // WO-1866: the badge rides the joint. A spline's 'end' site does not
      // resolve here (resolvePointRef keeps the anchor-only spline rule), so
      // read the joint from whichever side names it.
      const splineEnd = (r: PointRef): Vec2 | null => {
        const e = ent(r.entityId)
        return e?.kind === 'spline' && r.site === 'end' ? e.points[e.points.length - 1] ?? null : null
      }
      const p = resolvePointRef(sketch, c.b) ?? resolvePointRef(sketch, c.a) ?? splineEnd(c.a)
      return p ? [p] : []
    }
    case 'concentric':
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'tangent':
    case 'equal':
      return [...anchorOf(c.a), ...anchorOf(c.b)]
    case 'horizontal':
    case 'vertical': {
      if (c.line) return anchorOf(c.line)
      if (c.points) {
        const a = resolvePointRef(sketch, c.points[0])
        const b = resolvePointRef(sketch, c.points[1])
        if (a && b) return [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]
      }
      return []
    }
    case 'midpoint': {
      const p = resolvePointRef(sketch, c.point)
      return p ? [p] : []
    }
    case 'symmetric': {
      const a = resolvePointRef(sketch, c.a)
      const b = resolvePointRef(sketch, c.b)
      return [a, b].filter((p): p is Vec2 => !!p)
    }
    case 'fix': {
      if (c.point) {
        const p = resolvePointRef(sketch, c.point)
        return p ? [p] : []
      }
      if (c.entityId) return anchorOf(c.entityId)
      return []
    }
    case 'point_on_object':
    case 'pierce': {
      const p = resolvePointRef(sketch, c.point)
      return p ? [p] : []
    }
  }
}

// ---- Dimension display ------------------------------------------------------

// Default label offset from the measured geometry, in sketch mm. Used only
// when the dimension has no user-placed labelAnchor.
const DIM_OFFSET_MM = 7

/** Centroid of every entity's representative anchor, used to push a default
 *  dim label AWAY from the bulk of the sketch (outside) instead of onto or
 *  inside the measured geometry. */
function sketchCentroid(sk: Sketch): Vec2 {
  let sx = 0, sy = 0, n = 0
  for (const e of sk.entities) {
    const p = entityBadgeAnchor(e)
    sx += p.x; sy += p.y; n++
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 }
}

/** Unit OUTWARD direction (from the sketch centroid toward `from`) used to
 *  offset a default dim label clear of the geometry. Falls back to +Y when
 *  `from` coincides with the centroid. */
function outwardDir(sk: Sketch, from: Vec2): Vec2 {
  const c = sketchCentroid(sk)
  const dx = from.x - c.x, dy = from.y - c.y
  const len = Math.hypot(dx, dy)
  return len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 0, y: 1 }
}

export interface DimensionDisplay {
  /** Label position on the sketch plane (labelAnchor or computed default). */
  anchor: Vec2
  /** Formatted value text, parenthesized for reference (driven) dims. */
  text: string
}

/** Label anchor + display text for a dimension. Shared by the Three.js
 *  leader renderer and the HTML label overlay so both stay in lockstep.
 *  Text formatting is shared with the smart-dim cursor preview
 *  (formatDimensionValue) for the same reason. `units` controls the
 *  display-edge conversion (mm = identity); defaults to mm so callers that
 *  do not care about units (e.g. the leader-graphics rebuild) are
 *  unchanged. Linear dims convert; angles stay in degrees. */
export function dimensionDisplay(
  sketch: Sketch, d: SketchDimension, units: Units = 'mm',
): DimensionDisplay | null {
  const ent = (id: string) => sketch.entities.find((e) => e.id === id)
  let anchor: Vec2 | null = d.labelAnchor ?? null

  switch (d.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY': {
      const a = resolvePointRef(sketch, d.a)
      const b = resolvePointRef(sketch, d.b)
      if (!a || !b) return null
      if (!anchor) {
        if (d.kind === 'distanceX') {
          anchor = { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) + DIM_OFFSET_MM }
        } else if (d.kind === 'distanceY') {
          anchor = { x: Math.max(a.x, b.x) + DIM_OFFSET_MM, y: (a.y + b.y) / 2 }
        } else {
          // Push the default label to the OUTWARD side (away from the sketch
          // bulk) along the segment's perpendicular, so it never lands inside
          // the geometry.
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
          const dx = b.x - a.x, dy = b.y - a.y
          const len = Math.hypot(dx, dy) || 1
          let n = { x: -dy / len, y: dx / len } // left perpendicular
          const out = outwardDir(sketch, mid)
          if (n.x * out.x + n.y * out.y < 0) n = { x: -n.x, y: -n.y } // flip outward
          anchor = { x: mid.x + n.x * DIM_OFFSET_MM, y: mid.y + n.y * DIM_OFFSET_MM }
        }
      }
      break
    }
    // WO-1867: an ordinate with no stored label anchor falls on its stack's
    // COMMON witness line -- the same line ordinateStackAnchor drops it on at
    // placement time, derived from the datum alone -- so a stack reloaded from
    // a file that predates label anchors still reads as a stack, not a fan.
    case 'ordinate': {
      const o = resolvePointRef(sketch, d.origin)
      const p = resolvePointRef(sketch, d.point)
      if (!o || !p) return null
      if (!anchor) anchor = ordinateStackAnchor(o, p, d.axis)
      break
    }
    case 'distancePL': {
      const p = resolvePointRef(sketch, d.point)
      const l = ent(d.line)
      if (!p || !l || l.kind !== 'line') return null
      if (!anchor) {
        // Foot of the perpendicular from the point to the line; push the label
        // OUTWARD from the geometry (past the point, away from the sketch
        // bulk) instead of leaving it ON the measured span.
        const dx = l.end.x - l.start.x, dy = l.end.y - l.start.y
        const len2 = dx * dx + dy * dy
        const t = len2 > 0
          ? ((p.x - l.start.x) * dx + (p.y - l.start.y) * dy) / len2 : 0
        const foot = { x: l.start.x + t * dx, y: l.start.y + t * dy }
        const mid = { x: (p.x + foot.x) / 2, y: (p.y + foot.y) / 2 }
        const out = outwardDir(sketch, mid)
        const span = Math.hypot(p.x - foot.x, p.y - foot.y) / 2
        anchor = { x: mid.x + out.x * (span + DIM_OFFSET_MM),
                   y: mid.y + out.y * (span + DIM_OFFSET_MM) }
      }
      break
    }
    case 'radius':
    case 'diameter': {
      const e = ent(d.entityId)
      if (!e || (e.kind !== 'circle' && e.kind !== 'arc')) return null
      if (!anchor) {
        let ang = Math.PI / 4
        if (e.kind === 'arc') {
          let sweep = e.endAngle - e.startAngle
          while (sweep <= 0) sweep += Math.PI * 2
          ang = e.startAngle + sweep / 2
        }
        const rOut = e.radius + DIM_OFFSET_MM
        anchor = { x: e.center.x + rOut * Math.cos(ang), y: e.center.y + rOut * Math.sin(ang) }
      }
      break
    }
    case 'arcLength': {
      const e = ent(d.entityId)
      if (!e || e.kind !== 'arc') return null
      if (!anchor) {
        const mid = e.startAngle + positiveArcSweep(e.startAngle, e.endAngle) / 2
        const rOut = e.radius + DIM_OFFSET_MM
        anchor = {
          x: e.center.x + rOut * Math.cos(mid),
          y: e.center.y + rOut * Math.sin(mid),
        }
      }
      break
    }
    case 'majorRadius':
    case 'minorRadius': {
      const e = ent(d.entityId)
      if (!e || (e.kind !== 'ellipse' && e.kind !== 'elliptical-arc')) return null
      // Snap the label onto the chosen axis line (respecting rotation) so the
      // leader always lies ON the major/minor axis, never at an odd angle. A
      // dropped/dragged anchor is PROJECTED onto the axis; with no anchor yet
      // the default rides just past the +axis vertex. SAME helper the leader
      // render uses -> label and leader agree.
      const axis = d.kind === 'majorRadius' ? 'major' : 'minor'
      const raw = anchor ?? ellipsePointAt(e, d.kind === 'majorRadius' ? 0 : Math.PI / 2)
      anchor = ellipseAxisDimLeader(e, axis, raw).label
      break
    }
    case 'focusDistance': {
      const e = ent(d.entityId)
      if (!e || (e.kind !== 'ellipse' && e.kind !== 'elliptical-arc')) return null
      if (!anchor) {
        // Default label: push OUTWARD from the foci midpoint (the center) along
        // the perpendicular to the focal axis, so it clears the ellipse bulk.
        const f1 = ellipseFocusSite(e, 'focus1')
        const f2 = ellipseFocusSite(e, 'focus2')
        const mid = { x: (f1.x + f2.x) / 2, y: (f1.y + f2.y) / 2 }
        const dx = f2.x - f1.x, dy = f2.y - f1.y
        const len = Math.hypot(dx, dy) || 1
        let n = { x: -dy / len, y: dx / len }
        const out = outwardDir(sketch, mid)
        if (n.x * out.x + n.y * out.y < 0) n = { x: -n.x, y: -n.y }
        anchor = { x: mid.x + n.x * DIM_OFFSET_MM, y: mid.y + n.y * DIM_OFFSET_MM }
      }
      break
    }
    case 'angle': {
      const a = ent(d.a), b = ent(d.b)
      if (!a || !b || a.kind !== 'line' || b.kind !== 'line') return null
      const inter = lineIntersection(a.start, a.end, b.start, b.end)
        ?? { x: (a.start.x + b.start.x) / 2, y: (a.start.y + b.start.y) / 2 }
      if (!anchor) {
        const ta = Math.atan2(a.end.y - a.start.y, a.end.x - a.start.x)
        const tb = Math.atan2(b.end.y - b.start.y, b.end.x - b.start.x)
        const bis = (ta + tb) / 2
        anchor = { x: inter.x + (DIM_OFFSET_MM + 5) * Math.cos(bis),
                   y: inter.y + (DIM_OFFSET_MM + 5) * Math.sin(bis) }
      }
      break
    }
    // WO-1868: the default label of a three-point angle sits on the bisector of
    // its two legs, off the vertex -- the same place a two-line angle puts it.
    case 'angle3': {
      const v = resolvePointRef(sketch, d.vertex)
      const pa = resolvePointRef(sketch, d.a)
      const pb = resolvePointRef(sketch, d.b)
      if (!v || !pa || !pb) return null
      if (!anchor) {
        const ta = Math.atan2(pa.y - v.y, pa.x - v.x)
        const tb = Math.atan2(pb.y - v.y, pb.x - v.x)
        const bis = ta + Math.atan2(Math.sin(tb - ta), Math.cos(tb - ta)) / 2
        anchor = { x: v.x + (DIM_OFFSET_MM + 5) * Math.cos(bis),
                   y: v.y + (DIM_OFFSET_MM + 5) * Math.sin(bis) }
      }
      break
    }
    case 'd1xd2': {
      // REFERENCE-ONLY chamfer setback pair (UI-50C): default label pushed
      // OUTWARD from the chamfer line's own midpoint, away from the sketch
      // bulk (mirrors the two-point 'distance' default).
      const e = ent(d.entityId)
      if (!e || e.kind !== 'line') return null
      if (!anchor) {
        const mid = { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 }
        const out = outwardDir(sketch, mid)
        anchor = { x: mid.x + out.x * DIM_OFFSET_MM, y: mid.y + out.y * DIM_OFFSET_MM }
      }
      break
    }
  }
  if (!anchor) return null
  // 'd1xd2' is TWO-valued (d1 + d2); formatDimensionValue refuses it by name
  // (TwoValueDimensionKindError) rather than silently printing d1 alone.
  const text = d.kind === 'd1xd2'
    ? formatChamferSetbackValue(d.value, d.d2, d.driving, units)
    : formatDimensionValue(d.kind, d.value, d.driving, units)
  return { anchor, text }
}

function lineIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-9) return null
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom
  return { x: a1.x + t * d1x, y: a1.y + t * d1y }
}

// ---- Picking helpers ----------------------------------------------------------

export interface SketchPickHit {
  id: string
  type: 'entity' | 'constraint' | 'dimension'
}

/** Shortest world distance from (wx, wy) to a dimension's drawn leader /
 *  extension / tick geometry (and its label anchor), or null when the
 *  dimension cannot resolve. Reuses dimGuides -- the SAME polylines the
 *  placement preview and the committed renderer build -- so the hit target
 *  matches exactly what is drawn. A SketchDimension is structurally a
 *  PlannedDimension plus id/value/driving/labelAnchor, which dimGuides
 *  ignores. */
export function dimensionHitDistance(
  sk: Sketch, d: SketchDimension, wx: number, wy: number, worldPerPixel: number,
): number | null {
  const disp = dimensionDisplay(sk, d)
  if (!disp) return null
  const tick = 5 * Math.max(worldPerPixel, 1e-9)
  const guides = dimGuides(sk.entities, d as unknown as PlannedDimension, disp.anchor, tick)
  let best: number | null = null
  for (const poly of guides) {
    for (let i = 0; i + 1 < poly.length; i++) {
      const dd = pointSegDistance(wx, wy, poly[i], poly[i + 1])
      if (best === null || dd < best) best = dd
    }
  }
  // Accept a click right at the label anchor (leader endpoint / value text).
  const da = Math.hypot(wx - disp.anchor.x, wy - disp.anchor.y)
  if (best === null || da < best) best = da
  return best
}

function pointSegDistance(px: number, py: number, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

/** Shortest world distance from (wx, wy) to an entity's PICK target (null for
 *  point entities, which are handled separately with a wider tolerance).
 *  `entities` resolves a text entity's bound path. Text uses its full
 *  bounding BOX (rotated bbox for free text, warped band for on-path text),
 *  not the glyph strokes -- the stroke metric made the hover/select/
 *  double-click target impossibly narrow (missed inside an 'O' counter and
 *  between glyphs). Snapping (snap.ts) keeps the stroke metric. */
function entityDistance(
  e: SketchEntity, wx: number, wy: number, entities: readonly SketchEntity[],
): number | null {
  switch (e.kind) {
    case 'point':
      return null
    case 'line':
      return pointSegDistance(wx, wy, e.start, e.end)
    case 'circle':
      return Math.abs(Math.hypot(wx - e.center.x, wy - e.center.y) - e.radius)
    case 'arc': {
      const ang = Math.atan2(wy - e.center.y, wx - e.center.x)
      let sweep = e.endAngle - e.startAngle
      while (sweep <= 0) sweep += Math.PI * 2
      let rel = ang - e.startAngle
      while (rel < 0) rel += Math.PI * 2
      if (rel <= sweep) {
        return Math.abs(Math.hypot(wx - e.center.x, wy - e.center.y) - e.radius)
      }
      // Off the sweep: distance to the nearer endpoint.
      const sx = e.center.x + e.radius * Math.cos(e.startAngle)
      const sy = e.center.y + e.radius * Math.sin(e.startAngle)
      const ex = e.center.x + e.radius * Math.cos(e.endAngle)
      const ey = e.center.y + e.radius * Math.sin(e.endAngle)
      return Math.min(Math.hypot(wx - sx, wy - sy), Math.hypot(wx - ex, wy - ey))
    }
    case 'ellipse':
      return nearestPointOnEllipse(e, { x: wx, y: wy }).dist
    case 'elliptical-arc':
      return distanceToEllipticalArc(e, e.startParam, e.endParam, { x: wx, y: wy })
    case 'spline': {
      const curve = nearestPointOnSpline(e.points, e.closed, { x: wx, y: wy }, e.form).dist
      if (!splineHasControlSites(e.form)) return curve
      // WO-1861: each control point is a pickable site even where it sits off
      // the curve -- grabbing it is how the operator reshapes the spline.
      // WO-1862: the same for every bezier anchor and handle tip.
      return e.points.reduce((d, q) => Math.min(d, Math.hypot(q.x - wx, q.y - wy)), curve)
    }
    case 'text': {
      const p = { x: wx, y: wy }
      // On-path text renders warped along its path -- pick where it is DRAWN
      // (the warped band), never at the ignored free anchor. resolveTextPath
      // is quiet for free text and warns once (deduped) for a dangling pathId.
      const path = resolveTextPath(e, entities)
      if (path) return textOnPathPickDistance(e, path, p)
      return e.fontStyle === 'outline'
        ? distanceToOutlineTextBBox(
            e.text, e.height, e.at, e.rotation ?? 0, p,
            e.fontFamily, e.mirrored, e.letterSpacingMm,
          )
        : distanceToTextBBox(
            e.text, e.height, e.at, e.rotation ?? 0, p,
            { mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm },
          )
    }
    case 'block': {
      // A block is ONE pickable rigid object: distance = the nearest of its
      // world members (SKC-BLOCKS). A hit on any member selects the block.
      const world = blockMemberWorldEntities(e)
      let best: number | null = null
      for (const m of world) {
        const d = entityDistance(m, wx, wy, world)
        if (d !== null && (best === null || d < best)) best = d
      }
      return best
    }
  }
}

/** Distance-tie epsilon (world mm) for pickNearestEntity's text tie-break.
 *  Small enough that only "effectively the same distance" ties (a click
 *  inside a text band scores exactly 0; a curve stroke hugging that band --
 *  e.g. the text's own path under a baseline glyph -- scores ~0 too). */
export const PICK_TIE_EPS = 1e-6

/**
 * Nearest pickable entity id within `tol` of (wx, wy), or null. TIE-BREAK
 * RULE: strictly nearest wins, EXCEPT when two candidates tie within
 * PICK_TIE_EPS (both effectively the same distance -- in practice both 0),
 * in which case a TEXT entity beats a non-text one. Text is a container:
 * a double-click on a glyph stroke that lies ON its bound path must open
 * the text editor, not select the curve, and with the old strict '<' the
 * curve won on iteration order. A genuinely nearer curve (outside the text
 * box by more than the epsilon) still wins exactly as before.
 */
export function pickNearestEntity(
  entities: readonly SketchEntity[], wx: number, wy: number, tol: number,
): string | null {
  let best: { id: string; d: number; isText: boolean } | null = null
  for (const e of entities) {
    const d = entityDistance(e, wx, wy, entities)
    if (d === null || d > tol) continue
    const isText = e.kind === 'text'
    if (!best) {
      best = { id: e.id, d, isText }
    } else if (Math.abs(d - best.d) <= PICK_TIE_EPS) {
      // Tie: text steals from non-text; otherwise the earlier entity keeps.
      if (isText && !best.isText) best = { id: e.id, d, isText }
    } else if (d < best.d) {
      best = { id: e.id, d, isText }
    }
  }
  return best?.id ?? null
}

/** WO SKC-76: every profile corner (rectangle, chained polyline, chamfer/
 *  fillet trim site, ...) is TWO OR MORE distinct line/arc endpoints joined
 *  by a `coincident` constraint, never a shared vertex (types.ts's
 *  independent-endpoint doctrine). Endpoint picking below finds every site
 *  within tolerance and, when more than one ties for nearest, must tell
 *  "these are literally the same solved point" (a joined corner -- pick
 *  either, they agree by construction) apart from "two unrelated points
 *  happen to overlap right now" (a genuine ambiguity worth refusing). This
 *  builds a union-find over every `coincident` edge once per pick call and
 *  returns a resolver from PointRef -> group id; candidates sharing a group
 *  id are the SAME node. */
export function coincidentGroupResolver(
  constraints: readonly SketchConstraint[],
): (ref: PointRef) => string {
  const parent = new Map<string, string>()
  const keyOf = (ref: PointRef): string => `${ref.entityId}|${ref.site}`
  const find = (k: string): string => {
    const p = parent.get(k)
    if (p === undefined) {
      parent.set(k, k)
      return k
    }
    if (p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  for (const c of constraints) {
    if (c.kind !== 'coincident') continue
    const ra = find(keyOf(c.a))
    const rb = find(keyOf(c.b))
    if (ra !== rb) parent.set(ra, rb)
  }
  return (ref: PointRef) => find(keyOf(ref))
}

/** Given endpoint pick candidates already sorted nearest-first, resolve the
 *  winner: a lone nearest candidate wins outright; several tied within
 *  PICK_TIE_EPS win too PROVIDED they all belong to the same coincident
 *  group (an ordinary joined corner -- deterministic tie-break by encoded
 *  id so repeated picks at the same spot never flicker between sites); a
 *  tie spanning more than one group is a genuine ambiguity and still
 *  refuses, exactly as before SKC-76. */
export function resolveTiedEndpointPick(
  candidates: ReadonlyArray<{ id: string; d: number; ref: PointRef }>,
  constraints: readonly SketchConstraint[],
): string | null {
  if (candidates.length === 0) return null
  const bestD = candidates[0].d
  const tied = candidates.filter((c) => c.d - bestD <= PICK_TIE_EPS)
  if (tied.length === 1) return tied[0].id
  const groupOf = coincidentGroupResolver(constraints)
  const groups = new Set(tied.map((c) => groupOf(c.ref)))
  if (groups.size > 1) return null
  return tied.reduce((winner, c) => (c.id < winner.id ? c : winner)).id
}

/** Sample an entity as a polyline for marquee containment/intersection. */
// Exported for marquee-sampling regression coverage (on-path text must be
// sampled from its WARPED layout, not the free anchor -- see entitiesInRect).
export function entitySamples(e: SketchEntity, entities: readonly SketchEntity[]): Vec2[] {
  switch (e.kind) {
    case 'point':
      return [e.at]
    case 'line':
      return [e.start, e.end]
    case 'circle':
      return tessellateCircle(e).map((v) => ({ x: v.x, y: v.y }))
    case 'arc':
      return tessellateArc(e).map((v) => ({ x: v.x, y: v.y }))
    case 'ellipse':
      return tessellateEllipse(e).map((v) => ({ x: v.x, y: v.y }))
    case 'elliptical-arc':
      return tessellateEllipticalArc(e).map((v) => ({ x: v.x, y: v.y }))
    case 'spline':
      return tessellateSpline(e).map((v) => ({ x: v.x, y: v.y }))
    case 'text': {
      // Flatten all stroke/contour vertices (marquee-selection sample points).
      // On-path text must sample the WARPED render layout, not the free
      // layout at the ignored anchor -- otherwise marquee-selects where the
      // text is NOT drawn (same wrong-place class as the pick fix 8e2f834).
      const path = resolveTextPath(e, entities)
      if (e.fontStyle === 'outline') {
        return (path
          ? outlineTextOnPathToWorldContours(e, path)
          : outlineTextToWorldContours(e.text, e.height, e.at, e.rotation ?? 0,
              { fontFamily: e.fontFamily, mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm })
        ).flatMap((c) => c.points)
      }
      return (path
        ? textOnPathToWorldPolylines(e, path)
        : textToWorldPolylines(e.text, e.height, e.at, e.rotation ?? 0,
            { mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm })
      ).flat()
    }
    case 'block': {
      // Marquee samples: flatten every world member's samples (SKC-BLOCKS).
      const world = blockMemberWorldEntities(e)
      return world.flatMap((m) => entitySamples(m, world))
    }
  }
}

function segmentIntersectsRect(
  a: Vec2, b: Vec2, minX: number, minY: number, maxX: number, maxY: number
): boolean {
  // Either endpoint inside?
  const inside = (p: Vec2) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
  if (inside(a) || inside(b)) return true
  // Test against the four rectangle edges.
  const edges: Array<[Vec2, Vec2]> = [
    [{ x: minX, y: minY }, { x: maxX, y: minY }],
    [{ x: maxX, y: minY }, { x: maxX, y: maxY }],
    [{ x: maxX, y: maxY }, { x: minX, y: maxY }],
    [{ x: minX, y: maxY }, { x: minX, y: minY }],
  ]
  for (const [c, d] of edges) {
    if (segmentsIntersect(a, b, c, d)) return true
  }
  return false
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cross = (o: Vec2, p: Vec2, q: Vec2) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
}

// ---- Badge sprites ----------------------------------------------------------

// Badge size on screen (pixels). Sprites are rescaled every frame from
// worldPerPixel so they stay this size at any zoom.
export const BADGE_PX = 18

// Texture/material cache shared across rebuilds — keyed by text + color.
// The badge alphabet is tiny, so this never grows past a few dozen entries
// and is intentionally never disposed.
const badgeMaterialCache = new Map<string, THREE.SpriteMaterial>()

export function badgeMaterial(text: string, colorHex: number): THREE.SpriteMaterial {
  const key = `${text}|${colorHex}`
  const cached = badgeMaterialCache.get(key)
  if (cached) return cached

  const px = 96 // backing resolution; rendered at BADGE_PX on screen
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    // NAMED fallback (ADR-0003): an environment without a 2D canvas (jsdom
    // test runs) cannot rasterize badge glyphs at all - return an untextured
    // material instead of crashing the pointermove path that asked for a
    // cosmetic badge. Logged once; impossible in a real browser.
    if (!badgeMaterialCache.has('__no2d_warned__')) {
      badgeMaterialCache.set('__no2d_warned__', new THREE.SpriteMaterial())
      console.warn('[sketchLayer] badgeMaterial: no 2D canvas context - badges render blank (test env)')
    }
    const blank = new THREE.SpriteMaterial({ transparent: true, opacity: 0 })
    badgeMaterialCache.set(key, blank)
    return blank
  }
  const color = `#${colorHex.toString(16).padStart(6, '0')}`

  // Rounded dark chip with a colored border + colored glyph text.
  const r = px * 0.22
  ctx.beginPath()
  ctx.roundRect(4, 4, px - 8, px - 8, r)
  ctx.fillStyle = 'rgba(22, 27, 34, 0.92)'
  ctx.fill()
  ctx.lineWidth = 5
  ctx.strokeStyle = color
  ctx.stroke()
  ctx.fillStyle = color
  ctx.font = `600 ${Math.round(px * 0.5)}px "JetBrains Mono", monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, px / 2, px / 2 + px * 0.03)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({
    map: tex,
    depthTest: false,
    toneMapped: false,
    transparent: true,
  })
  badgeMaterialCache.set(key, mat)
  return mat
}

// ---- Ellipse focus markers ---------------------------------------------------
//
// Hollow-ring point sprite for the two FOCUS nodes a selected ellipse /
// elliptical-arc reveals. A ring (not a solid dot) keeps them visually
// distinct from endpoint/point-entity nodes; the muted handle color (same
// family as the spline through-point handles) keeps them quiet. Texture is
// cached module-wide (tiny, never disposed — same doctrine as the badge
// material cache). Headless (node) fallback: no `document` -> null map, the
// cloud renders as a plain point; the real app always has a document.
let fociRingTex: THREE.CanvasTexture | null = null

function fociRingTexture(): THREE.CanvasTexture | null {
  if (fociRingTex) return fociRingTex
  if (typeof document === 'undefined') return null
  const px = 32
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.strokeStyle = '#ffffff' // tinted by the material color
  ctx.lineWidth = 3.5
  ctx.beginPath()
  ctx.arc(px / 2, px / 2, px / 2 - 3, 0, Math.PI * 2)
  ctx.stroke()
  fociRingTex = new THREE.CanvasTexture(canvas)
  return fociRingTex
}

// Dedicated sketch-origin glyph: a ring plus crosshair, screen-sized by a
// PointsMaterial. The shape distinguishes the fixed anchor from ordinary
// point entities without adding a schema-level entity kind. As with the focus
// texture, headless tests fall back to an untextured point while retaining the
// named object, screen-stable size, and state colors.
let originAnchorTex: THREE.CanvasTexture | null = null

function originAnchorTexture(): THREE.CanvasTexture | null {
  if (originAnchorTex) return originAnchorTex
  if (typeof document === 'undefined') return null
  const px = 32
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.strokeStyle = '#ffffff' // tinted by the material color
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(px / 2, px / 2, px * 0.28, 0, Math.PI * 2)
  ctx.moveTo(px / 2, 2)
  ctx.lineTo(px / 2, px - 2)
  ctx.moveTo(2, px / 2)
  ctx.lineTo(px - 2, px / 2)
  ctx.stroke()
  originAnchorTex = new THREE.CanvasTexture(canvas)
  return originAnchorTex
}

/** A rendered constraint badge: world anchor plus the screen-space slot
 *  offset baked into the sprite's `center` (used again by picking). */
export interface BadgeRecord {
  constraintId: string
  world: THREE.Vector3
  /** sprite.center value — (0.5, 0.5) is centered on the anchor; offsets
   *  are in units of the badge's own screen size. */
  center: { x: number; y: number }
}

// ---- Layer ----------------------------------------------------------------

/** Display pose of the edited part on the sketch plane: a 2D rigid transform
 *  translate(x, y) . rotateZ(rotationDeg) applied to the sketch-LOCAL entity
 *  coordinates. For a normal workspace geometry this is the identity (position
 *  0 / rotation 0) so nothing moves; for a nest's owned seed it is the seed's
 *  lower-left slot pose (ADR 0024 instance transform) so the seed edits AT its
 *  visible slot. Display-only: the sketch document's solver coordinates never
 *  change — the group is posed for rendering and the inverse is applied to
 *  screen->sketch picking so clicks still land on the right LOCAL coords. */
export interface SketchOffset {
  x: number
  y: number
  rotationDeg: number
}

const IDENTITY_OFFSET: SketchOffset = { x: 0, y: 0, rotationDeg: 0 }

export class SketchLayer {
  readonly group = new THREE.Group()

  private sketch: Sketch | null = null
  private view: SketchViewState = EMPTY_VIEW
  private hoverId: string | null = null
  // Display pose of the edited part (identity for a normal geo at position 0).
  private offset: SketchOffset = IDENTITY_OFFSET

  // Dashed materials need a screen-space dash pattern: the shader pattern is
  // (lineDistance * scale) mod (dash + gap), with lineDistance in world mm.
  // Setting scale = 1 / worldPerPixel each frame keeps dashSize/gapSize in
  // PIXELS, so construction dashes stay readable at any zoom.
  private dashedMats: THREE.LineDashedMaterial[] = []
  // Fat-line materials for the F9 hover underlay (halo / same-color bump).
  // LineMaterial sizes its stroke in SCREEN PIXELS and needs the renderer
  // resolution kept current, so they are tracked for per-frame resolution
  // updates and disposed on rebuild.
  private hoverUnderlayMats: LineMaterial[] = []
  private resolution = new THREE.Vector2(1, 1)
  private lastWorldPerPixel = 1

  private badgeSprites: THREE.Sprite[] = []
  private badgeRecords: BadgeRecord[] = []
  private readonly pointWorldPerPixel?: (at: Vec2, localZ?: number) => number
  private readonly projectToScreen?: (at: Vec2, localZ?: number) => Vec2 | null
  /** Reverse of the forward projection: screen client px -> sketch-LOCAL doc coords, already
   *  through BOTH conversions (host.clientToPlaneWorld's plane raycast, then this layer's own
   *  offset-reverse) -- see pick()'s doc comment for why a second worldToLocal must never run on
   *  its result. Optional: bare `new SketchLayer()` construction (existing unit-test harnesses)
   *  has none, and pick() falls back to the legacy raw NDC unprojection in that case. */
  private readonly clientToPlaneLocal?: (clientX: number, clientY: number) => Vec2 | null
  private dimensionRecords: Array<{
    lines: THREE.LineSegments
    dimension: SketchDimension
    anchor: Vec2
    worldPerPixel: number
    projectionSignatures: Array<{
      tip: Vec2
      scale: [number, number, number, number] | null
    }>
  }> = []

  constructor(
    pointWorldPerPixel?: (at: Vec2, localZ?: number) => number,
    projectToScreen?: (at: Vec2, localZ?: number) => Vec2 | null,
    clientToPlaneLocal?: (clientX: number, clientY: number) => Vec2 | null,
  ) {
    this.pointWorldPerPixel = pointWorldPerPixel
    this.projectToScreen = projectToScreen
    this.clientToPlaneLocal = clientToPlaneLocal
    this.group.name = '__sketch_layer__'
    this.group.position.z = SKETCH_Z
    this.group.renderOrder = ACTIVE_SKETCH_RENDER_ORDER
    this.group.visible = false
  }

  /** Resolve screen scale at one rendered anchor. CAM deliberately supplies a
   *  constant; the perspective workbench supplies camera-depth-aware values.
   *  Public (WO SKC-55): pick()'s own tolerance and SketchInteraction's
   *  wpp()/tolWorld() both call this now instead of the frame-global
   *  `lastWorldPerPixel` fallback, so click/hover/drag/snap tolerance is
   *  position- AND depth-aware at the gesture point, matching the badge
   *  scaling this method already did. */
  worldPerPixelAt(at: Vec2): number {
    const rendered = this.localToWorld(at.x, at.y)
    const pointScale = this.pointWorldPerPixel?.(rendered, SKETCH_Z)
    if (Number.isFinite(pointScale) && pointScale! > 0) return pointScale!
    return Math.max(this.lastWorldPerPixel, 1e-9)
  }

  /** Project the point where the layer actually renders it: after the display
   *  offset/rotation and at the layer's local Z lift above the datum plane. */
  private projectRenderedPoint(at: Vec2): Vec2 | null {
    if (!this.projectToScreen) return null
    const rendered = this.localToWorld(at.x, at.y)
    return this.projectToScreen(rendered, SKETCH_Z)
  }

  /** Rebuild all scene objects from the document + view state. `offset` poses
   *  the layer at the edited part's home (identity => no change for a normal
   *  geometry at position 0; the seed slot for a nest's owned seed). */
  update(sketch: Sketch | null, view?: SketchViewState, offset?: SketchOffset) {
    if (view) this.view = view
    // SKC-BLOCKS Stage 5: flatten def-backed instances into equivalent inline
    // blocks so all render/hit-test code below stays definition-agnostic (the
    // pick still returns each instance's own id; the store keeps defId).
    const materialized = sketch !== null ? materializeInstancesForView(sketch) : null
    const originAnchorId = this.view.originAnchorId
    const originAnchorEntity = this.view.originAnchorEntity
    this.sketch = materialized !== null
      && originAnchorId !== undefined
      && originAnchorEntity?.id === originAnchorId
      && !materialized.entities.some((entity) => entity.id === originAnchorId)
      ? { ...materialized, entities: [...materialized.entities, originAnchorEntity] }
      : materialized
    this.offset = offset ?? IDENTITY_OFFSET
    this.applyOffsetToGroup()
    this.rebuild()
  }

  /** Pose the group on the sketch plane: translate(x, y) at SKETCH_Z plus a
   *  Z rotation. SKETCH_Z is preserved additively (the offset never carries a
   *  Z translation). Display-only — entity coords stay LOCAL. */
  private applyOffsetToGroup() {
    this.group.position.set(this.offset.x, this.offset.y, SKETCH_Z)
    this.group.rotation.z = (this.offset.rotationDeg * Math.PI) / 180
  }

  /** Map a WORLD point on the sketch plane to sketch-LOCAL coords (inverse of
   *  the display pose). Picking/snapping/new-entity placement unproject to
   *  world; the document lives in local coords, so every screen->sketch path
   *  routes through this so clicks land correctly at the offset location. */
  worldToLocal(wx: number, wy: number): { x: number; y: number } {
    const dx = wx - this.offset.x
    const dy = wy - this.offset.y
    const a = (-this.offset.rotationDeg * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    return { x: dx * c - dy * s, y: dx * s + dy * c }
  }

  /** Forward map a sketch-LOCAL point to WORLD coords (the display pose).
   *  Used by badge picking, which projects a local anchor through the camera
   *  and must account for the posed group. */
  private localToWorld(lx: number, ly: number): { x: number; y: number } {
    const a = (this.offset.rotationDeg * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    return {
      x: lx * c - ly * s + this.offset.x,
      y: lx * s + ly * c + this.offset.y,
    }
  }

  /** Hover is high-frequency and viewport-local; it re-tints without
   *  the React store round-trip. */
  setHover(id: string | null) {
    if (this.hoverId === id) return
    this.hoverId = id
    this.rebuild()
  }

  getHover(): string | null {
    return this.hoverId
  }

  /** GEO-26 Stage B: SKETCH_COLORS.selected/hover are GETTERS that already
   *  resolve the LIVE selectionGlow preference on every read (see that
   *  object's doc comment) -- but they are only READ during rebuild(), which
   *  otherwise only runs on a document/selection/hover change. A Settings >
   *  Display switch with no other sketch activity would leave already-built
   *  entity materials showing their OLD color until the next unrelated edit.
   *  Mirrors setHover's own "just rebuild" shape -- rebuild() is documented
   *  as cheap (small documents, full rebuild per edit) and is a no-op when no
   *  sketch is open (this.sketch === null). */
  refreshGlow() {
    this.rebuild()
  }

  /** Called once per render-loop frame by CNCViewport. resPxW/resPxH are the
   *  renderer drawing-buffer size in device pixels — LineMaterial (the fat
   *  hover underlay) needs it to size its screen-space stroke. */
  onFrame(worldPerPixel: number, resPxW?: number, resPxH?: number) {
    if (!this.group.visible) return
    if (resPxW !== undefined && resPxH !== undefined &&
        (resPxW !== this.resolution.x || resPxH !== this.resolution.y)) {
      this.resolution.set(resPxW, resPxH)
      for (const m of this.hoverUnderlayMats) m.resolution.copy(this.resolution)
    }
    if (worldPerPixel !== this.lastWorldPerPixel) {
      this.lastWorldPerPixel = worldPerPixel
      const scale = 1 / Math.max(worldPerPixel, 1e-9)
      for (const m of this.dashedMats) m.scale = scale
    }

    // The origin scale can stay constant while an oblique perspective camera
    // changes depth elsewhere on the plane, so point-sized details must update
    // even when `worldPerPixel === lastWorldPerPixel`.
    for (let i = 0; i < this.badgeSprites.length; i++) {
      const record = this.badgeRecords[i]
      const s = BADGE_PX * this.worldPerPixelAt(record.world)
      this.badgeSprites[i].scale.set(s, s, 1)
    }
    for (const record of this.dimensionRecords) {
      const nextWpp = this.worldPerPixelAt(record.anchor)
      const nextProjectionSignatures = record.projectionSignatures.map(({ tip }) => ({
        tip,
        scale: this.projectionScaleAt(tip),
      }))
      if (!this.scaleChanged(record.worldPerPixel, nextWpp) &&
          !this.projectionSignaturesChanged(
            record.projectionSignatures,
            nextProjectionSignatures,
          )) continue
      const segs = this.dimensionSegments(record.dimension, record.anchor, nextWpp)
      this.updateDimensionGeometry(record.lines, segs)
      record.worldPerPixel = nextWpp
      record.projectionSignatures = this.dimensionProjectionSignatures(
        record.dimension,
        record.anchor,
        nextWpp,
      )
    }
  }

  /** Current badge records (world anchor + screen slot), for picking. */
  getBadges(): readonly BadgeRecord[] {
    return this.badgeRecords
  }

  // ---- Picking ---------------------------------------------------------------
  //
  // Analytic picking on the sketch plane instead of THREE.Raycaster line
  // intersection: the tolerance is specified in SCREEN PIXELS (converted to
  // world mm via worldPerPixel), which raycaster thresholds (world units)
  // cannot express across zoom levels. Priority: constraint badges (small
  // screen-space targets) > point entities > center refs > curves.

  /** Badge screen slot when no forward projection callback is available (CAM: no
   *  projectToScreen, and its plane is world XY at the group's own Z, so this raw
   *  camera-space math is exact there). b.world is a sketch-LOCAL anchor; forward-map
   *  it through the display pose so it projects from where the group actually renders. */
  private legacyBadgeScreenPoint(
    world: { x: number; y: number }, camera: THREE.Camera, viewW: number, viewH: number,
  ): { x: number; y: number } {
    const bw = this.localToWorld(world.x, world.y)
    const v = new THREE.Vector3(bw.x, bw.y, this.group.position.z)
    v.project(camera)
    return { x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH }
  }

  // WO SKC-57: `generousPx` is the caller's explicit opt-in to a second, wider
  // pass when the tight pass (below) finds nothing -- Operator's ask that an
  // unambiguous click near a lone entity should not have to be pixel-exact,
  // while a click that could mean two things must still refuse and make the
  // user be precise. Undefined (the default) keeps every unaudited caller's
  // behavior bit-identical to pre-SKC-57.
  pick(
    pxX: number,
    pxY: number,
    camera: THREE.Camera,
    viewW: number,
    viewH: number,
    pickPx = 8,
    clientX?: number,
    clientY?: number,
    generousPx?: number,
  ): SketchPickHit | null {
    if (!this.sketch || !this.group.visible) return null

    // Badges: compare in screen space (their slot offsets are screen-sized). Project through
    // the injected forward callback (frame- and pose-correct at any camera pose); only CAM (no
    // projectToScreen) falls back to the raw camera-space math above.
    for (const b of this.badgeRecords) {
      const screen = this.projectRenderedPoint(b.world) ?? this.legacyBadgeScreenPoint(b.world, camera, viewW, viewH)
      const sx = screen.x - (b.center.x - 0.5) * BADGE_PX
      const sy = screen.y + (b.center.y - 0.5) * BADGE_PX
      const half = BADGE_PX / 2 + 2
      if (Math.abs(pxX - sx) <= half && Math.abs(pxY - sy) <= half) {
        return { id: b.constraintId, type: 'constraint' }
      }
    }

    // Entities: distances in world mm against a pixel-derived tolerance. The reverse callback
    // (when the host supplies one, i.e. any real mount) raycasts the click onto the REAL session
    // PlaneFrame and reverses the display offset in one composed step (see index.ts) -- its result
    // is ALREADY sketch-LOCAL, so it must NOT be run through worldToLocal a second time here (that
    // would double-apply the offset reverse). Absent a callback -- or the caller not supplying raw
    // client coords, which today only bare `new SketchLayer()` unit-test construction does -- fall
    // back to the legacy raw NDC unprojection: correct only when the camera looks squarely down an
    // identity-offset XY plane's normal, which is exactly what those bare-layer tests set up.
    const converted = clientX !== undefined && clientY !== undefined
      ? this.clientToPlaneLocal?.(clientX, clientY)
      : undefined
    let wx: number, wy: number
    if (converted) {
      wx = converted.x
      wy = converted.y
    } else {
      const ndc = new THREE.Vector3((pxX / viewW) * 2 - 1, -(pxY / viewH) * 2 + 1, 0)
      ndc.unproject(camera)
      const legacy = this.worldToLocal(ndc.x, ndc.y)
      wx = legacy.x
      wy = legacy.y
    }
    // WO SKC-55: position/depth-aware, not the frame-global origin-anchored scalar -- at a
    // steep pose the acceptance radius must be sized at the CLICK's own depth (worldPerPixelAt
    // passes SKETCH_Z, matching where the entity actually renders), same pattern badge picking
    // already used above.
    const tol = pickPx * this.worldPerPixelAt({ x: wx, y: wy })
    // SKC-BLOCKS Stage 4: a live block-edit ghost backdrop is out of scope for
    // picking -- computed once and reused by every candidate loop below.
    const pickable = this.pickableEntities()

    // Point entities first (small targets, slightly widened tolerance).
    for (const e of pickable) {
      if (e.kind !== 'point') continue
      if (Math.hypot(wx - e.at.x, wy - e.at.y) <= tol * 1.5) {
        return { id: e.id, type: 'entity' }
      }
    }

    // Line and arc endpoints are first-class point sites. They win over the
    // owning curve inside the same point-sized target used by ordinary points.
    const endpointCandidates: Array<{ id: string; d: number; ref: PointRef }> = []
    for (const e of pickable) {
      if (e.kind !== 'line' && e.kind !== 'arc') continue
      const points = e.kind === 'line'
        ? { start: e.start, end: e.end }
        : {
            start: {
              x: e.center.x + e.radius * Math.cos(e.startAngle),
              y: e.center.y + e.radius * Math.sin(e.startAngle),
            },
            end: {
              x: e.center.x + e.radius * Math.cos(e.endAngle),
              y: e.center.y + e.radius * Math.sin(e.endAngle),
            },
          }
      for (const site of ['start', 'end'] as const) {
        const d = Math.hypot(wx - points[site].x, wy - points[site].y)
        if (d <= tol * 1.5) {
          const ref: PointRef = { entityId: e.id, site }
          endpointCandidates.push({ id: encodeEndpointSelectionRef(ref), d, ref })
        }
      }
    }
    endpointCandidates.sort((a, b) => a.d - b.d)
    if (endpointCandidates.length > 0) {
      // WO SKC-76: a tie between endpoints joined by a `coincident` constraint
      // (every ordinary profile corner -- rectangle, chained polyline, ...) is
      // NOT an ambiguity, it is one solved point reached from two owners.
      // resolveTiedEndpointPick only refuses when the tied candidates span
      // more than one coincident group (a real overlap-by-chance).
      const winner = resolveTiedEndpointPick(endpointCandidates, this.sketch.constraints)
      if (winner !== null) return { id: winner, type: 'entity' }
      return null
    }

    // Canonical center references use the same point-tier tolerance as
    // ordinary points. A coincident ordinary point wins above; overlapping
    // center refs follow the documented ambiguity rule in BOTH tight and
    // generous passes: exactly one candidate wins, otherwise refuse without
    // falling through to a document-order-dependent curve pick.
    const centerCandidates: string[] = []
    for (const e of pickable) {
      const center = centerPointForEntity(e)
      const selectionId = centerSelectionIdForEntity(e)
      if (!center || !selectionId) continue
      if (Math.hypot(wx - center.x, wy - center.y) <= tol * 1.5) {
        centerCandidates.push(selectionId)
      }
    }
    if (centerCandidates.length === 1) {
      return { id: centerCandidates[0], type: 'entity' }
    }
    if (centerCandidates.length > 1) return null

    // Curves + text, nearest-with-text-tie-break (see pickNearestEntity).
    const bestId = pickNearestEntity(pickable, wx, wy, tol)
    if (bestId) return { id: bestId, type: 'entity' }

    // Dimensions LAST (lowest priority): their leaders sit clear of the
    // geometry, so a dim only wins where no entity/point/badge does. This is
    // what lets a click on a dimension's LEADER select it (matching the DOM
    // value-label click) so Delete can remove it.
    let bestDim: { id: string; d: number } | null = null
    for (const dim of this.sketch.dimensions) {
      const dd = dimensionHitDistance(this.sketch, dim, wx, wy, this.lastWorldPerPixel)
      if (dd !== null && dd <= tol && (!bestDim || dd < bestDim.d)) bestDim = { id: dim.id, d: dd }
    }
    if (bestDim) return { id: bestDim.id, type: 'dimension' }

    // WO SKC-57 PASS 2 (GENEROUS): the tight pass above found nothing. Only
    // runs when the caller opted in; badges and dimensions never participate
    // (badges are screen-space chrome, and a surprise dimension grab from
    // outside the tight radius is worse UX than no grab).
    return generousPx !== undefined ? this.pickGenerous(wx, wy, generousPx) : null
  }

  /** PASS 2 of `pick()` (SKC-57): widen the radius, but REFUSE instead of
   *  guessing whenever more than one candidate qualifies -- precision still
   *  wins whenever the click is genuinely ambiguous, only a LONE candidate
   *  benefits from the wider radius. Points are checked first with the same
   *  1.5x widening the tight pass uses (P10: only real `kind:'point'`
   *  entities reach this tier -- ordinary line/arc endpoints score null from
   *  entityDistance and never appear here), so a single point coincident
   *  with a curve still resolves to the point, unchanged tier priority.
   *  WO SKC-76: endpoint candidates that are ALL the same coincident-joined
   *  corner are exempted from the refuse-on-multiple rule -- see the tight
   *  pass's identical exemption below. */
  private pickGenerous(wx: number, wy: number, generousPx: number): SketchPickHit | null {
    if (!this.sketch) return null
    const gtol = generousPx * this.worldPerPixelAt({ x: wx, y: wy })
    // SKC-BLOCKS Stage 4: same ghost exclusion as the tight pass above.
    const pickable = this.pickableEntities()

    const pointCandidates: string[] = []
    for (const e of pickable) {
      if (e.kind !== 'point') continue
      if (Math.hypot(wx - e.at.x, wy - e.at.y) <= gtol * 1.5) pointCandidates.push(e.id)
    }
    if (pointCandidates.length === 1) return { id: pointCandidates[0], type: 'entity' }
    if (pointCandidates.length > 1) return null // ambiguous: refuse, do not fall through

    const endpointCandidates: Array<{ id: string; ref: PointRef }> = []
    for (const e of pickable) {
      if (e.kind !== 'line' && e.kind !== 'arc') continue
      const start = e.kind === 'line'
        ? e.start
        : { x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle) }
      const end = e.kind === 'line'
        ? e.end
        : { x: e.center.x + e.radius * Math.cos(e.endAngle), y: e.center.y + e.radius * Math.sin(e.endAngle) }
      if (Math.hypot(wx - start.x, wy - start.y) <= gtol * 1.5) {
        const ref: PointRef = { entityId: e.id, site: 'start' }
        endpointCandidates.push({ id: encodeEndpointSelectionRef(ref), ref })
      }
      if (Math.hypot(wx - end.x, wy - end.y) <= gtol * 1.5) {
        const ref: PointRef = { entityId: e.id, site: 'end' }
        endpointCandidates.push({ id: encodeEndpointSelectionRef(ref), ref })
      }
    }
    if (endpointCandidates.length === 1) return { id: endpointCandidates[0].id, type: 'entity' }
    if (endpointCandidates.length > 1) {
      // WO SKC-76: same coincident-group exemption as the tight pass -- a
      // joined profile corner within the generous radius is still ONE node,
      // not an ambiguous pick.
      const groupOf = coincidentGroupResolver(this.sketch.constraints)
      const groups = new Set(endpointCandidates.map((c) => groupOf(c.ref)))
      if (groups.size === 1) {
        const winner = endpointCandidates.reduce((w, c) => (c.id < w.id ? c : w))
        return { id: winner.id, type: 'entity' }
      }
      return null
    }

    const centerCandidates: string[] = []
    for (const e of pickable) {
      const center = centerPointForEntity(e)
      const selectionId = centerSelectionIdForEntity(e)
      if (!center || !selectionId) continue
      if (Math.hypot(wx - center.x, wy - center.y) <= gtol * 1.5) {
        centerCandidates.push(selectionId)
      }
    }
    if (centerCandidates.length === 1) return { id: centerCandidates[0], type: 'entity' }
    if (centerCandidates.length > 1) return null

    const curveCandidates: string[] = []
    for (const e of pickable) {
      const d = entityDistance(e, wx, wy, this.sketch.entities)
      if (d !== null && d <= gtol) curveCandidates.push(e.id)
    }
    return curveCandidates.length === 1 ? { id: curveCandidates[0], type: 'entity' } : null
  }

  /** SKC-BLOCKS Stage 4: entities eligible for picking, excluding any live
   *  block-edit ghost backdrop (view.blockEditGhostIds) -- ghosted entities are
   *  out of scope for the session and must never win a click/marquee. Absent/
   *  empty ghost set returns `this.sketch.entities` unchanged (every existing
   *  pick path stays byte-identical when no session is open). */
  private pickableEntities(): readonly SketchEntity[] {
    const ghost = this.view.blockEditGhostIds
    if (!ghost || ghost.size === 0) return this.sketch!.entities
    return this.sketch!.entities.filter((e) => !ghost.has(e.id))
  }

  /**
   * Entity ids inside a world-space rectangle.
   * window=true  -> entity must be FULLY contained (left-to-right marquee).
   * window=false -> any intersection counts (right-to-left crossing marquee).
   */
  entitiesInRect(
    minX: number, minY: number, maxX: number, maxY: number, window: boolean
  ): string[] {
    if (!this.sketch) return []
    const ids: string[] = []
    for (const e of this.sketch.entities) {
      if (e.id === this.view.originAnchorId) continue
      if (this.view.axisEntityIds?.has(e.id)) continue
      if (this.view.blockEditGhostIds?.has(e.id)) continue
      const samples = entitySamples(e, this.sketch.entities)
      if (samples.length === 0) continue
      let entityHit = false
      if (window) {
        const inside = samples.every(
          (p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
        )
        if (inside) {
          ids.push(e.id)
          entityHit = true
        }
      } else {
        let hit = samples.some(
          (p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
        )
        if (!hit) {
          for (let i = 0; i + 1 < samples.length && !hit; i++) {
            hit = segmentIntersectsRect(samples[i], samples[i + 1], minX, minY, maxX, maxY)
          }
        }
        if (hit) {
          ids.push(e.id)
          entityHit = true
        }
      }
      // A small marquee around the point node selects the sub-entity ref.
      // When the parent geometry itself qualifies, prefer its owner id so a
      // large window never produces duplicate operands for one entity.
      if (!entityHit) {
        const center = centerPointForEntity(e)
        const selectionId = centerSelectionIdForEntity(e)
        if (center && selectionId &&
            center.x >= minX && center.x <= maxX &&
            center.y >= minY && center.y <= maxY) {
          ids.push(selectionId)
        }
      }
    }
    return ids
  }

  // ---- Rebuild -------------------------------------------------------------

  // Definition-state bookkeeping, recomputed per rebuild.
  private conflictEntityIds = new Set<string>()
  private fixedEntityIds = new Set<string>()
  // EXACT per-entity definition states from the solver's fix-probe
  // diagnosis (solveStatus.fullyDefinedEntities). null = the status
  // predates the diagnosis (legacy persisted doc) -> approximation
  // fallback in entityDefinitionColor.
  private definedEntityIds: ReadonlySet<string> | null = null
  // Entities bound by the hovered constraint/dimension (PLAN 3.4: hover
  // highlights all entities it binds). Hover sources: viewport badge
  // pick AND the toolbox constraint-browser rows (setSketchHover).
  private hoverBoundEntityIds: ReadonlySet<string> = new Set()

  private computeDefinitionSets() {
    this.conflictEntityIds.clear()
    this.fixedEntityIds.clear()
    this.definedEntityIds = null
    const sk = this.sketch
    if (!sk) return
    if (sk.solveStatus?.fullyDefinedEntities !== undefined) {
      this.definedEntityIds = new Set(sk.solveStatus.fullyDefinedEntities)
    }
    // solveStatus.conflicting carries DOCUMENT constraint/dimension ids
    // (gcsMapping normalizes the pushed gcs ids back via ownerId).
    // null solveStatus = never solved: no conflict info yet.
    const conflicting = new Set(sk.solveStatus?.conflicting ?? [])
    for (const c of sk.constraints) {
      if (c.kind === 'fix') {
        if (c.point) this.fixedEntityIds.add(c.point.entityId)
        if (c.entityId) this.fixedEntityIds.add(c.entityId)
      }
      if (conflicting.has(c.id)) {
        for (const id of referencedEntityIds(c)) this.conflictEntityIds.add(id)
      }
    }
    for (const d of sk.dimensions) {
      if (conflicting.has(d.id)) {
        for (const id of referencedEntityIds(d)) this.conflictEntityIds.add(id)
      }
    }
  }

  private computeHoverBoundSet() {
    if (!this.sketch || this.hoverId === null) {
      this.hoverBoundEntityIds = new Set()
      return
    }
    const item =
      this.sketch.constraints.find((c) => c.id === this.hoverId) ??
      this.sketch.dimensions.find((d) => d.id === this.hoverId)
    this.hoverBoundEntityIds = item
      ? new Set(referencedEntityIds(item))
      : new Set()
  }

  private rebuild() {
    this.disposeChildren()
    if (!this.sketch) return
    this.computeDefinitionSets()
    this.computeHoverBoundSet()

    const pointEntities: Array<{ e: SketchEntity & { kind: 'point' }; color: number }> = []
    let originAnchor: (SketchEntity & { kind: 'point' }) | null = null
    // Line / circular-arc endpoint nodes: display-only geometry collected into
    // ONE screen-sized cloud. Picking remains analytic (pick()), so adding the
    // cloud cannot change which entity or point site a pointer gesture targets.
    const endpointMarkers: Array<{ at: THREE.Vector3; color: number }> = []
    // Canonical atomic centers: one hollow, screen-stable cloud. Each node is
    // backed by an encoded PointRef selection id; no display point is added to
    // the persisted sketch.
    const centerMarkers: Array<{ at: Vec2; color: number }> = []
    // Spline control-point (through-point) handles, drawn as small persistent
    // markers when the points/constraint display flag (glyphsVisible) is on.
    // Collected here, rendered as ONE cloud after the loop (mirrors the point
    // cloud). Non-interactive in v1 -- purely a visibility aid.
    const splineHandles: Vec2[] = []
    const splinePolygons: Vec2[][] = []
    // FOCUS points of EVERY ellipse / elliptical-arc — always displayed
    // (Operator 2026-07-02: "foci nodes should always be displayed"), including
    // construction owners. Rendered as ONE hollow-ring cloud after the loop —
    // hollow + muted so they read quieter than endpoint nodes; per-vertex
    // color dims them further when the owner is UNSELECTED. They are
    // addressable point sites ('focus1'/'focus2') picked via the SNAP engine
    // (exactly like the center site), not via this cloud — the cloud stays
    // non-raycast display geometry.
    const fociMarkers: Array<{ at: Vec2; selected: boolean }> = []
    // Text ATTACHMENT-POINT markers (one per SELECTED or EDITING text
    // entity): a ring at the point the text hangs from -- the free anchor,
    // or the align reference point on its bound path (textAttachMarkerWorld).
    // Collected here, rendered as ONE hollow-ring cloud after the loop (the
    // foci pattern). Purely visual: never raycast, never a pick/snap target.
    const textAttachMarkers: Array<{ at: Vec2; color: number }> = []
    // WO SKC-49: injected X/Y axis lines. Collected here, painted in their OWN dedicated block
    // after the loop -- exactly the origin marker's precedent (a specialized paint treatment for
    // a synthetic session-only anchor) -- rather than through the generic 'line' case below, so
    // their restraint (dimmer than ordinary construction) is independently tunable from
    // addPolyline's construction dimColor() and never double-dims. They remain ORDINARY entities
    // for analytic pick/hover (pickNearestEntity reads `this.sketch.entities` directly, unaffected
    // by which paint path drew them) -- only PAINT is specialized, matching the origin's own
    // "paint alone is specialized" contract.
    const axisLines: Array<SketchEntity & { kind: 'line' }> = []

    for (const e of this.sketch.entities) {
      if (e.kind === 'line' && this.view.axisEntityIds?.has(e.id)) {
        axisLines.push(e)
        continue
      }
      const color = this.resolveColor(e)
      const center = centerPointForEntity(e)
      const centerSelectionId = centerSelectionIdForEntity(e)
      if (center && centerSelectionId) {
        centerMarkers.push({
          at: center,
          color: this.centerMarkerColor(e, centerSelectionId, color),
        })
      }
      let curvePts: THREE.Vector3[] | null = null
      switch (e.kind) {
        case 'line':
          curvePts = [
            new THREE.Vector3(e.start.x, e.start.y, 0),
            new THREE.Vector3(e.end.x, e.end.y, 0),
          ]
          this.addPolyline(e.id, curvePts, color, e.construction)
          endpointMarkers.push(
            { at: curvePts[0], color: this.endpointMarkerColor(e, 'start', color) },
            { at: curvePts[curvePts.length - 1], color: this.endpointMarkerColor(e, 'end', color) },
          )
          break
        case 'arc':
          curvePts = tessellateArc(e)
          this.addPolyline(e.id, curvePts, color, e.construction)
          endpointMarkers.push(
            { at: curvePts[0], color: this.endpointMarkerColor(e, 'start', color) },
            { at: curvePts[curvePts.length - 1], color: this.endpointMarkerColor(e, 'end', color) },
          )
          break
        case 'circle':
          curvePts = tessellateCircle(e)
          this.addPolyline(e.id, curvePts, color, e.construction)
          break
        case 'ellipse': {
          curvePts = tessellateEllipse(e)
          this.addPolyline(e.id, curvePts, color, e.construction)
          // Foci coincident with the canonical center are omitted so the
          // center node remains a single unambiguous glyph.
          const sel = this.view.selectedIds.has(e.id)
          fociMarkers.push(...ellipseFoci(e)
            .filter((at) => Math.hypot(at.x - e.center.x, at.y - e.center.y) > 1e-9)
            .map((at) => ({ at, selected: sel })))
          break
        }
        case 'elliptical-arc': {
          curvePts = tessellateEllipticalArc(e)
          this.addPolyline(e.id, curvePts, color, e.construction)
          const sel = this.view.selectedIds.has(e.id)
          fociMarkers.push(...ellipseFoci(e)
            .filter((at) => Math.hypot(at.x - e.center.x, at.y - e.center.y) > 1e-9)
            .map((at) => ({ at, selected: sel })))
          break
        }
        case 'spline':
          curvePts = tessellateSpline(e)
          this.addPolyline(e.id, curvePts, color, e.construction)
          // Persistent control-point handles (gated on glyphsVisible below).
          // WO-1861: a control-point spline always shows its control polygon
          // and its control points -- they are the drag handles that shape it,
          // not a display aid.
          // WO-1862: a bezier chain always shows each anchor's handle legs and
          // the handle tips, for the same reason.
          if (splineHasControlSites(e.form)) {
            splineHandles.push(...splineControlMarkers(e.points, true))
            splinePolygons.push(...splineHandleLegs(e.points, e.closed, e.form))
          } else {
            splineHandles.push(...splineControlMarkers(e.points, this.view.glyphsVisible))
          }
          break
        case 'text': {
          // Single-line: each glyph stroke is its OWN open polyline. Outline:
          // each glyph contour/hole is its OWN closed polyline (first point
          // repeated to close it). A single THREE.Line per stroke/ring so
          // disjoint pieces never connect; all share the entity id for picking.
          // Hover halo is added per piece; curvePts stays null so the shared
          // hover block below is skipped.
          // TEXT-ON-PATH: a resolvable pathId warps the layout onto the live
          // curve (so it tracks path edits); missing/free -> the anchor layout.
          const textPath = resolveTextPath(e, this.sketch!.entities)
          const polys = e.fontStyle === 'outline'
            ? (textPath
                ? outlineTextOnPathToWorldContours(e, textPath)
                : outlineTextToWorldContours(e.text, e.height, e.at, e.rotation ?? 0,
                    { fontFamily: e.fontFamily, mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm }))
                .map((c) => (c.points.length > 0 ? [...c.points, c.points[0]] : c.points))
            : (textPath
                ? textOnPathToWorldPolylines(e, textPath)
                : textToWorldPolylines(e.text, e.height, e.at, e.rotation ?? 0,
                    { mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm }))
          const hovered = this.hoverId === e.id || this.hoverBoundEntityIds.has(e.id)
            || e.id === this.view.editingId
          for (const poly of polys) {
            const v3 = poly.map((p) => new THREE.Vector3(p.x, p.y, 0))
            this.addPolyline(e.id, v3, color, e.construction)
            if (hovered) this.addHoverUnderlay(v3)
          }
          // Attachment-point marker (M1d): shown ONLY while the text is
          // selected or in the live editor -- a persistent marker on every
          // text would read as stray geometry. Colored to match the entity's
          // own resolveColor outcome (editing cyan wins over selected amber).
          const editing = e.id === this.view.editingId
          if (editing || this.view.selectedIds.has(e.id)) {
            const markerAt = textAttachMarkerWorld(e, this.sketch!.entities)
            if (markerAt) {
              textAttachMarkers.push({
                at: markerAt,
                color: editing ? SKETCH_COLORS.hover : SKETCH_COLORS.selected,
              })
            }
          }
          // In-canvas insertion CARET (M1b): the WYSIWYG input is invisible,
          // so while THIS entity is being edited the layer draws the caret --
          // computed through the SAME layout pipeline as the glyphs
          // (textCaretWorldSegment: on-path warp incl. pathAlign/flip/mirror,
          // or the free anchor+rotation transform), so it can never disagree
          // with where typing emits. WHITE for contrast against the cyan
          // editing tint; ~2px like a normal stroke; drawn on top
          // (renderOrder above the glyphs). Display-only: never raycast, no
          // bake/pick change. Shown even for EMPTY text (fresh placement:
          // the user must see where text will land before typing).
          if (editing) {
            const caret = textCaretWorldSegment(
              e, this.sketch!.entities, this.view.caretIndex ?? e.text.length,
            )
            if (caret) {
              this.addFatLine(
                [
                  new THREE.Vector3(caret[0].x, caret[0].y, 0),
                  new THREE.Vector3(caret[1].x, caret[1].y, 0),
                ],
                0xffffff, 2, 1, 0.05, 2, '__sketch_text_caret__',
              )
            }
          }
          break
        }
        case 'block': {
          // A rigid block (SKC-BLOCKS): draw every WORLD member curve, ALL
          // tagged with the BLOCK id so a pick on any member selects the whole
          // block (one pickable rigid object). Color is the block's own resolved
          // color, so selecting/hovering the block lights up every member.
          const worldMembers = blockMemberWorldEntities(e)
          const hovered = this.hoverId === e.id || this.hoverBoundEntityIds.has(e.id)
          for (const m of worldMembers) {
            let mPts: THREE.Vector3[] | null = null
            switch (m.kind) {
              case 'line':
                mPts = [new THREE.Vector3(m.start.x, m.start.y, 0), new THREE.Vector3(m.end.x, m.end.y, 0)]
                break
              case 'arc':            mPts = tessellateArc(m); break
              case 'circle':         mPts = tessellateCircle(m); break
              case 'ellipse':        mPts = tessellateEllipse(m); break
              case 'elliptical-arc': mPts = tessellateEllipticalArc(m); break
              case 'spline':         mPts = tessellateSpline(m); break
              case 'text': {
                const polys = m.fontStyle === 'outline'
                  ? outlineTextToWorldContours(m.text, m.height, m.at, m.rotation ?? 0,
                      { fontFamily: m.fontFamily, mirrored: m.mirrored, letterSpacingMm: m.letterSpacingMm })
                      .map((c) => (c.points.length > 0 ? [...c.points, c.points[0]] : c.points))
                  : textToWorldPolylines(m.text, m.height, m.at, m.rotation ?? 0,
                      { mirrored: m.mirrored, letterSpacingMm: m.letterSpacingMm })
                for (const poly of polys) {
                  const v3 = poly.map((p) => new THREE.Vector3(p.x, p.y, 0))
                  this.addPolyline(e.id, v3, color, m.construction)
                  if (hovered) this.addHoverUnderlay(v3)
                }
                break
              }
              case 'point':
              case 'block':
                break
            }
            if (mPts) {
              this.addPolyline(e.id, mPts, color, m.construction)
              if (hovered) this.addHoverUnderlay(mPts)
            }
          }
          // Origin node (the block's drag/anchor handle).
          endpointMarkers.push({ at: new THREE.Vector3(e.origin.x, e.origin.y, 0), color })
          break
        }
        case 'point':
          if (e.id === this.view.originAnchorId) originAnchor = e
          else pointEntities.push({ e, color })
          break
      }
      // F9 cyan-halo hover underlay: directly hovered curve OR a curve bound
      // by the hovered constraint/dimension (both get the same treatment).
      if (curvePts && (this.hoverId === e.id || this.hoverBoundEntityIds.has(e.id))) {
        this.addHoverUnderlay(curvePts)
      }
    }

    // Line / circular-arc endpoints: one batched, screen-stable point cloud.
    // Resting nodes are subdued; direct hover lights cyan; selected owners stay
    // amber even while hovered, matching resolveColor's selection precedence.
    if (endpointMarkers.length > 0) {
      const positions = new Float32Array(endpointMarkers.length * 3)
      const colors = new Float32Array(endpointMarkers.length * 3)
      endpointMarkers.forEach(({ at, color }, i) => {
        positions[i * 3] = at.x
        positions[i * 3 + 1] = at.y
        positions[i * 3 + 2] = at.z
        const c = new THREE.Color(color)
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const mat = new THREE.PointsMaterial({
        size: 8,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
        toneMapped: false,
      })
      const cloud = new THREE.Points(geo, mat)
      cloud.name = '__sketch_endpoints__'
      cloud.renderOrder = 1
      this.group.add(cloud)
    }

    // Center nodes: hollow rings distinguish derived owner references from
    // persisted free points while retaining the endpoint hover/selection
    // palette. Slightly larger than the 8px endpoint dots for legibility.
    if (centerMarkers.length > 0) {
      const positions = new Float32Array(centerMarkers.length * 3)
      const colors = new Float32Array(centerMarkers.length * 3)
      centerMarkers.forEach(({ at, color }, i) => {
        positions[i * 3] = at.x
        positions[i * 3 + 1] = at.y
        positions[i * 3 + 2] = 0
        const c = new THREE.Color(color)
        colors[i * 3] = c.r
        colors[i * 3 + 1] = c.g
        colors[i * 3 + 2] = c.b
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const tex = fociRingTexture()
      const mat = new THREE.PointsMaterial({
        size: 10,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
        toneMapped: false,
        ...(tex ? { map: tex, transparent: true, alphaTest: 0.1 } : {}),
      })
      const cloud = new THREE.Points(geo, mat)
      cloud.name = '__sketch_centers__'
      cloud.renderOrder = 2
      this.group.add(cloud)
    }

    // Point entities: one Points cloud, screen-space sized (pixels, not
    // world units) via sizeAttenuation:false — same pattern as the
    // vertex-pick snap cloud.
    if (pointEntities.length > 0) {
      const positions = new Float32Array(pointEntities.length * 3)
      const colors = new Float32Array(pointEntities.length * 3)
      pointEntities.forEach(({ e, color }, i) => {
        positions[i * 3] = e.at.x
        positions[i * 3 + 1] = e.at.y
        positions[i * 3 + 2] = 0
        const c = new THREE.Color(color)
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const mat = new THREE.PointsMaterial({
        size: 7,
        sizeAttenuation: false,
        vertexColors: true,
        toneMapped: false,
      })
      const cloud = new THREE.Points(geo, mat)
      cloud.name = '__sketch_points__'
      this.group.add(cloud)
    }

    // Workbench-only projected world-origin anchor. It remains an ordinary
    // point entity for analytic pick/snap/dimension behavior; only its paint
    // is specialized. One named Points object keeps the marker screen-stable
    // and prevents it from being visually doubled in __sketch_points__.
    if (originAnchor !== null) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute([
        originAnchor.at.x, originAnchor.at.y, 0,
      ], 3))
      const tex = originAnchorTexture()
      const mat = new THREE.PointsMaterial({
        size: 15,
        sizeAttenuation: false,
        color: this.originAnchorColor(originAnchor.id),
        depthTest: false,
        toneMapped: false,
        ...(tex ? { map: tex, transparent: true, alphaTest: 0.1 } : {}),
      })
      const marker = new THREE.Points(geo, mat)
      marker.name = '__sketch_origin_anchor__'
      marker.renderOrder = 2
      this.group.add(marker)
    }

    // WO SKC-49: injected X/Y axis lines. Dedicated dashed THREE.Line per axis, deliberately
    // NOT routed through addPolyline (which would apply its own construction dimColor() lerp on
    // top of axisLineColor()'s already-muted result -- double-dimming). "Infinite-style": no
    // endpoint markers, no length label, reads as a reference line rather than drawn geometry --
    // while the underlying entity is a concrete finite length (sketchAnchors.ts), so paint extent
    // and pick extent are the SAME two points by construction.
    for (const axis of axisLines) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(axis.start.x, axis.start.y, 0),
        new THREE.Vector3(axis.end.x, axis.end.y, 0),
      ])
      const mat = new THREE.LineDashedMaterial({
        color: this.axisLineColor(axis.id),
        dashSize: 10,
        gapSize: 6,
        scale: 1 / Math.max(this.lastWorldPerPixel, 1e-9),
        toneMapped: false,
      })
      const line = new THREE.Line(geo, mat)
      line.computeLineDistances()
      line.name = axis.id
      // WO UI-72: these are SKETCH_AXIS_HALF_LENGTH_MM (100 m) long on purpose
      // and are meant to run off-screen, so the camera-depth policy must never
      // try to fit its near/far slab around them (that measured a runaway
      // camera retreat -- see markDepthExtentExempt's own note). Everything else
      // in this layer IS real drawn geometry and stays in the extent.
      markDepthExtentExempt(line)
      this.dashedMats.push(mat)
      this.group.add(line)
    }

    // Spline control-point handles: one screen-sized cloud, drawn a touch
    // larger than snap points and in a muted handle color so they read as
    // "the spline's editable through-points" without competing with the
    // definition-colored geometry. Only populated when glyphsVisible (the
    // splineControlMarkers gate above returned points only in that case).
    // WO-1861: control polygons of control-point splines -- thin dashed legs in
    // the handle color joining the control points, drawn under the handles.
    // Not routed through addPolyline: the polygon is not the entity's outline
    // and must never pick or halo as one.
    for (const poly of splinePolygons) {
      if (poly.length < 2) continue
      const geo = new THREE.BufferGeometry().setFromPoints(
        poly.map((q) => new THREE.Vector3(q.x, q.y, 0)))
      const mat = new THREE.LineDashedMaterial({
        color: 0x8aa2c8,
        dashSize: 5,
        gapSize: 4,
        scale: 1 / Math.max(this.lastWorldPerPixel, 1e-9),
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
      })
      const line = new THREE.Line(geo, mat)
      line.computeLineDistances()
      line.name = '__sketch_spline_control_polygon__'
      this.dashedMats.push(mat)
      this.group.add(line)
    }

    if (splineHandles.length > 0) {
      const positions = new Float32Array(splineHandles.length * 3)
      splineHandles.forEach((p, i) => {
        positions[i * 3] = p.x
        positions[i * 3 + 1] = p.y
        positions[i * 3 + 2] = 0
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const mat = new THREE.PointsMaterial({
        size: 8,
        sizeAttenuation: false,
        color: 0x8aa2c8,
        toneMapped: false,
      })
      const cloud = new THREE.Points(geo, mat)
      cloud.name = '__sketch_spline_handles__'
      this.group.add(cloud)
    }

    // Ellipse FOCUS nodes (every ellipse / elliptical-arc, always shown): one
    // hollow-ring cloud, screen-sized like the other node clouds. Slightly
    // larger than the solid nodes so the ring stroke stays legible; muted
    // spline-handle color so it reads dimmer than endpoint nodes, and a
    // further-dimmed per-vertex color when the owner is UNSELECTED (selection
    // still "lights up" its foci without hiding anyone else's).
    if (fociMarkers.length > 0) {
      const positions = new Float32Array(fociMarkers.length * 3)
      const colors = new Float32Array(fociMarkers.length * 3)
      const litColor = new THREE.Color(0x8aa2c8)   // selected owner (legacy tone)
      const dimColor = new THREE.Color(0x536178)   // unselected owner (~62% of lit)
      fociMarkers.forEach(({ at, selected }, i) => {
        positions[i * 3] = at.x
        positions[i * 3 + 1] = at.y
        positions[i * 3 + 2] = 0
        const c = selected ? litColor : dimColor
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const tex = fociRingTexture()
      const mat = new THREE.PointsMaterial({
        size: 11,
        sizeAttenuation: false,
        vertexColors: true,
        toneMapped: false,
        ...(tex ? { map: tex, transparent: true, alphaTest: 0.1 } : {}),
      })
      const cloud = new THREE.Points(geo, mat)
      cloud.name = '__sketch_ellipse_foci__'
      this.group.add(cloud)
    }

    // Text attachment-point markers: a hollow ring like the foci cloud but a
    // touch larger, in the owning text's selection-state color (amber when
    // selected, cyan when editing). Display-only geometry, never raycast.
    if (textAttachMarkers.length > 0) {
      const positions = new Float32Array(textAttachMarkers.length * 3)
      const colors = new Float32Array(textAttachMarkers.length * 3)
      textAttachMarkers.forEach(({ at, color }, i) => {
        positions[i * 3] = at.x
        positions[i * 3 + 1] = at.y
        positions[i * 3 + 2] = 0
        const c = new THREE.Color(color)
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
      })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const tex = fociRingTexture()
      const mat = new THREE.PointsMaterial({
        size: 13,
        sizeAttenuation: false,
        vertexColors: true,
        toneMapped: false,
        ...(tex ? { map: tex, transparent: true, alphaTest: 0.1 } : {}),
      })
      const cloud = new THREE.Points(geo, mat)
      cloud.name = '__sketch_text_attach__'
      this.group.add(cloud)
    }

    if (this.view.glyphsVisible) this.buildBadges()
    this.buildDimensionGraphics()
  }

  // ---- Constraint glyph badges ---------------------------------------------

  private buildBadges() {
    const sk = this.sketch!
    const conflicting = new Set(sk.solveStatus?.conflicting ?? [])

    // Cluster badges sharing an anchor (e.g. coincident + fix on the same
    // corner) so they lay out in a row instead of stacking.
    interface Pending { constraintId: string; text: string; color: number }
    const clusters = new Map<string, { world: Vec2; items: Pending[] }>()

    for (const c of sk.constraints) {
      if (c.id === this.view.originAnchorFixId) continue
      if (this.view.axisFixIds?.has(c.id)) continue
      const text = BADGE_TEXT[c.kind]
      let color: number = asNumber('--sketch-badge')
      if (conflicting.has(c.id)) color = SKETCH_COLORS.conflict
      if (this.hoverId === c.id) color = hoverColor(color)
      if (this.view.selectedIds.has(c.id)) color = SKETCH_COLORS.selected
      for (const anchor of constraintBadgeAnchors(sk, c)) {
        const key = `${Math.round(anchor.x * 10)},${Math.round(anchor.y * 10)}`
        const cluster = clusters.get(key) ?? { world: anchor, items: [] }
        cluster.items.push({ constraintId: c.id, text, color })
        clusters.set(key, cluster)
      }
    }

    for (const { world, items } of clusters.values()) {
      items.forEach((item, i) => {
        const sprite = new THREE.Sprite(badgeMaterial(item.text, item.color))
        sprite.position.set(world.x, world.y, 0)
        // Slot offsets are screen-space via sprite.center (units of the
        // badge's own size): row centered above the anchor point.
        const cx = 0.5 - (i - (items.length - 1) / 2) * 1.15
        const cy = -0.45
        sprite.center.set(cx, cy)
        const s = BADGE_PX * this.worldPerPixelAt(world)
        sprite.scale.set(s, s, 1)
        sprite.renderOrder = 10
        sprite.name = item.constraintId
        this.group.add(sprite)
        this.badgeSprites.push(sprite)
        this.badgeRecords.push({
          constraintId: item.constraintId,
          world: new THREE.Vector3(world.x, world.y, 0),
          center: { x: cx, y: cy },
        })
      })
    }
  }

  // ---- Dimension leader / extension graphics --------------------------------
  //
  // Leader styles: linear dims = extension lines + offset bar + arrowheads;
  // radius/diameter = SHORT gapped leader from the arc to the
  // label with the arrowhead at the arc (diameter keeps the rim-to-rim
  // through-line only when the label sits inside the circle); angle = arc
  // between the two lines. The value text itself is an HTML overlay
  // (SketchDimensionOverlay) so it stays crisp and screen-sized while
  // panning/zooming.

  private buildDimensionGraphics() {
    const sk = this.sketch!
    const conflicting = new Set(sk.solveStatus?.conflicting ?? [])

    for (const d of sk.dimensions) {
      const disp = dimensionDisplay(sk, d)
      if (!disp) continue
      let color = asNumber('--sketch-dimension')
      if (conflicting.has(d.id)) color = SKETCH_COLORS.conflict
      if (this.hoverId === d.id) color = hoverColor(color)
      if (this.view.selectedIds.has(d.id)) color = SKETCH_COLORS.selected

      // Tick/arrowhead unit: ~5 px expressed in world units at rebuild-time
      // zoom, so terminators keep a constant on-screen size.
      const anchor = disp.anchor
      const wpp = this.worldPerPixelAt(anchor)
      const segs = this.dimensionSegments(d, anchor, wpp)

      if (segs.length === 0) continue
      const geo = new THREE.BufferGeometry().setFromPoints(segs)
      const mat = new THREE.LineBasicMaterial({
        color, toneMapped: false, transparent: true, opacity: 0.85,
      })
      const lines = new THREE.LineSegments(geo, mat)
      lines.name = `__dim_${d.id}`
      this.group.add(lines)
      this.dimensionRecords.push({
        lines, dimension: d, anchor, worldPerPixel: wpp,
        projectionSignatures: this.dimensionProjectionSignatures(d, anchor, wpp),
      })
    }
  }

  /** Build committed leader geometry from the same pure guide source used by
   *  preview and picking, but with the rendered anchor's live screen scale. */
  private dimensionSegments(d: SketchDimension, anchor: Vec2, worldPerPixel: number): THREE.Vector3[] {
    const segs: THREE.Vector3[] = []
    const tick = 5 * Math.max(worldPerPixel, 1e-9)
    const guides = dimGuides(
      this.sketch!.entities, d as unknown as PlannedDimension, anchor, tick,
    )
    for (const rawPoly of guides) {
      const poly = this.screenSizedChevron(rawPoly, worldPerPixel)
      for (let i = 0; i + 1 < poly.length; i++) {
        segs.push(
          new THREE.Vector3(poly[i].x, poly[i].y, 0),
          new THREE.Vector3(poly[i + 1].x, poly[i + 1].y, 0),
        )
      }
    }
    return segs
  }

  /** Local projection Jacobian at an anchor, with translation removed. It
   *  detects directional foreshortening changes even when origin WPP is fixed. */
  private projectionScaleAt(anchor: Vec2): [number, number, number, number] | null {
    if (!this.projectToScreen) return null
    const o = this.projectRenderedPoint(anchor)
    const x = this.projectRenderedPoint({ x: anchor.x + 1, y: anchor.y })
    const y = this.projectRenderedPoint({ x: anchor.x, y: anchor.y + 1 })
    if (!o || !x || !y) return null
    const values: [number, number, number, number] = [
      x.x - o.x, x.y - o.y, y.x - o.x, y.y - o.y,
    ]
    return values.every(Number.isFinite) ? values : null
  }

  private scaleChanged(prior: number, current: number): boolean {
    return Math.abs(current - prior) > Math.max(prior, 1e-9) * 0.01
  }

  private projectionScaleChanged(
    prior: [number, number, number, number] | null,
    current: [number, number, number, number] | null,
  ): boolean {
    if (prior === null || current === null) return prior !== current
    let delta2 = 0
    let prior2 = 0
    for (let i = 0; i < prior.length; i++) {
      delta2 += (current[i] - prior[i]) ** 2
      prior2 += prior[i] ** 2
    }
    return Math.sqrt(delta2) > Math.max(Math.sqrt(prior2), 1e-9) * 0.01
  }

  private projectionSignaturesChanged(
    prior: Array<{ tip: Vec2; scale: [number, number, number, number] | null }>,
    current: Array<{ tip: Vec2; scale: [number, number, number, number] | null }>,
  ): boolean {
    if (prior.length !== current.length) return true
    return prior.some((signature, index) =>
      this.projectionScaleChanged(signature.scale, current[index].scale),
    )
  }

  /** Capture every arrowhead's rendered projection scale. A dimension label can
   *  be far from its arrows on an oblique plane, so the label anchor cannot act
   *  as a proxy for whether all terminators still have the intended pixel size. */
  private dimensionProjectionSignatures(
    d: SketchDimension,
    anchor: Vec2,
    worldPerPixel: number,
  ): Array<{ tip: Vec2; scale: [number, number, number, number] | null }> {
    const tick = 5 * Math.max(worldPerPixel, 1e-9)
    const guides = dimGuides(
      this.sketch!.entities, d as unknown as PlannedDimension, anchor, tick,
    )
    const signatures: Array<{
      tip: Vec2
      scale: [number, number, number, number] | null
    }> = []
    for (const poly of guides) {
      const tip = this.chevronTip(poly)
      if (tip) signatures.push({ tip, scale: this.projectionScaleAt(tip) })
    }
    return signatures
  }

  /** Update the existing GPU attribute when topology is unchanged. Camera
   *  motion changes coordinates, not segment count, so this avoids per-frame
   *  BufferGeometry allocation churn while orbiting. */
  private updateDimensionGeometry(lines: THREE.LineSegments, segs: THREE.Vector3[]): void {
    const positions = lines.geometry.getAttribute('position') as THREE.BufferAttribute
    if (positions.count !== segs.length) {
      lines.geometry.dispose()
      lines.geometry = new THREE.BufferGeometry().setFromPoints(segs)
      return
    }
    for (let i = 0; i < segs.length; i++) {
      positions.setXYZ(i, segs[i].x, segs[i].y, segs[i].z)
    }
    positions.needsUpdate = true
    lines.geometry.computeBoundingSphere()
  }

  /** dimGuides identifies chevron arrowheads as symmetric three-point
   *  polylines [barb, tip, barb]. The shared guide geometry determines the
   *  intended pixel length; projection then solves each plane-aligned barb
   *  independently so camera foreshortening cannot enlarge or shrink it. */
  private screenSizedChevron(poly: Vec2[], worldPerPixel: number): Vec2[] {
    return screenSizedChevron(poly, worldPerPixel,
      this.projectToScreen ? (at) => this.projectRenderedPoint(at) : undefined)
  }

  private chevronTip(poly: Vec2[]): Vec2 | null {
    return chevronTip(poly)
  }
  // ---- F9 hover-treatment underlay (variant B, shipped) ---------------------
  //
  // Builds the cyan-halo hover affordance UNDER the hovered curve, entity color
  // untouched on top. Width is in screen pixels (LineMaterial), so it reads the
  // same at any zoom. The halo sits slightly behind the entity in Z and at a
  // low renderOrder so the entity's own colored stroke always draws on top.
  // Used for BOTH direct entity hover and constraint-driven hover-binding
  // (hovering a constraint badge/row halos the entities it binds).
  private addHoverUnderlay(curvePts: THREE.Vector3[]) {
    // GEO-26 Stage B: the 'brightness-halo' candidate differentiates via a
    // wider/more-opaque glow rather than a new hue (see selectionGlowTokens.ts
    // header) -- apply its haloWidthMul/haloOpacityMul on top of the shipped
    // constants when active; 'current' and every other candidate leave the
    // shipped HALO_WIDTH_PX/HALO_OPACITY untouched (mul defaults to 1).
    const glow = resolveSelectionGlowColors(getSelectionGlow(), 'classic')
    const widthPx = HALO_WIDTH_PX * (glow?.haloWidthMul ?? 1)
    const opacity = Math.min(1, HALO_OPACITY * (glow?.haloOpacityMul ?? 1))
    this.addFatLine(curvePts, SKETCH_COLORS.hover, widthPx, opacity, -0.04, -1)
  }

  /** A screen-pixel-width line (three's fat-line addon) used by the hover
   *  underlay and the in-canvas text caret. zOffset nudges it behind (or, for
   *  the caret, in front of) the entity; renderOrder keeps draw order
   *  deterministic against the entity (renderOrder 0). `name` tags the scene
   *  object (default: the hover-underlay tag); every fat line is display-only
   *  and never raycast/picked. */
  private addFatLine(
    curvePts: THREE.Vector3[],
    color: number,
    widthPx: number,
    opacity: number,
    zOffset: number,
    renderOrder: number,
    name = '__sketch_hover_underlay__',
  ) {
    // three's fat-line (LineSegments2) has a single-segment rendering quirk:
    // a 2-point line (one segment) can fail to draw. Densify short polylines
    // so every underlay carries >= 2 segments, which renders reliably.
    const src = curvePts.length >= 3 ? curvePts : densifyPolyline(curvePts, 8)
    const positions: number[] = []
    for (const p of src) positions.push(p.x, p.y, p.z + zOffset)
    const geo = new LineGeometry()
    geo.setPositions(positions)
    const mat = new LineMaterial({
      color,
      linewidth: widthPx,          // in pixels (worldUnits:false)
      worldUnits: false,
      transparent: opacity < 1,
      opacity,
      depthTest: false,
      toneMapped: false,
    })
    mat.resolution.copy(this.resolution)
    const line = new Line2(geo, mat)
    line.computeLineDistances()
    // Single-segment fat lines (a 2-point sketch line) can be dropped by the
    // bounding-sphere frustum cull; the underlay is one transient object, so
    // skip culling entirely rather than chase a correct bound.
    line.frustumCulled = false
    line.renderOrder = renderOrder
    line.name = name
    this.hoverUnderlayMats.push(mat)
    this.group.add(line)
  }

  private addPolyline(
    entityId: string,
    pts: THREE.Vector3[],
    color: number,
    construction: boolean
  ) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    let line: THREE.Line
    if (construction) {
      const mat = new THREE.LineDashedMaterial({
        color: dimColor(color),
        dashSize: 6,
        gapSize: 4,
        scale: 1 / Math.max(this.lastWorldPerPixel, 1e-9),
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
      })
      line = new THREE.Line(geo, mat)
      line.computeLineDistances()
      this.dashedMats.push(mat)
    } else {
      const mat = new THREE.LineBasicMaterial({
        color,
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
      })
      line = new THREE.Line(geo, mat)
    }
    line.name = entityId
    this.group.add(line)
  }

  private resolveColor(e: SketchEntity): number {
    // SKC-BLOCKS Stage 4: a block-edit ghost wins over EVERYTHING else -- these
    // entities are outside the live session's scope, so they never take the
    // active-edit/selection/hover accent, only the heavier ghost dim.
    if (this.view.blockEditGhostIds?.has(e.id)) {
      return ghostDimColor(entityDefinitionColor(this.sketch!.solveStatus, e.id, {
        conflict: this.conflictEntityIds,
        defined: this.definedEntityIds,
        fixed: this.fixedEntityIds,
      }))
    }
    // Active-edit tint wins: the text in the in-canvas editor glows cyan so the
    // user sees typing is live (the input itself is visually invisible).
    if (this.view.editingId && e.id === this.view.editingId) return SKETCH_COLORS.hover
    if (this.view.selectedIds.has(e.id)) return SKETCH_COLORS.selected
    if (e.provenance === 'projected') return SKETCH_COLORS.reference
    const base = entityDefinitionColor(this.sketch!.solveStatus, e.id, {
      conflict: this.conflictEntityIds,
      defined: this.definedEntityIds,
      fixed: this.fixedEntityIds,
    })
    // Hover (direct, or bound by a hovered constraint/dimension): the
    // affordance is a separate cyan halo underlay added in rebuild(), so the
    // entity keeps its own definition-state color here. No white-lerp.
    return base
  }

  private endpointMarkerColor(
    e: SketchEntity,
    site: 'start' | 'end',
    ownerColor: number,
  ): number {
    const selectionId = encodeEndpointSelectionRef({ entityId: e.id, site })
    if (this.view.selectedIds.has(selectionId)) return SKETCH_COLORS.selected
    const hovered = this.hoverId !== null ? decodeEndpointSelectionRef(this.hoverId) : null
    if (hovered?.entityId === e.id && hovered.site === site) return SKETCH_COLORS.hover
    if (this.view.selectedIds.has(e.id)) return SKETCH_COLORS.selected
    if (this.hoverId === e.id) return SKETCH_COLORS.hover
    return dimColor(ownerColor)
  }

  private centerMarkerColor(
    e: SketchEntity,
    selectionId: string,
    ownerColor: number,
  ): number {
    if (this.view.selectedIds.has(selectionId) || this.view.selectedIds.has(e.id)) {
      return SKETCH_COLORS.selected
    }
    const hoveredCenter = this.hoverId !== null &&
      decodeCenterSelectionRef(this.hoverId)?.entityId === e.id
    if (hoveredCenter || this.hoverId === e.id) return SKETCH_COLORS.hover
    return dimColor(ownerColor)
  }

  private originAnchorColor(id: string): number {
    if (this.view.selectedIds.has(id)) return SKETCH_COLORS.selected
    if (this.hoverId === id) return SKETCH_COLORS.hover
    return SKETCH_COLORS.fullyDefined
  }

  /** WO SKC-49: axis lines paint dimmer than ordinary construction geometry (which itself is
   *  already dimColor()'d once by addPolyline) -- two dim passes toward the viewport background,
   *  computed here rather than by routing through addPolyline so the exact muting is explicit and
   *  never compounds with a THIRD pass. Selected/hover states behave exactly like every other
   *  entity and like the origin marker: full-strength accent colors override the muting. */
  private axisLineColor(id: string): number {
    if (this.view.selectedIds.has(id)) return SKETCH_COLORS.selected
    if (this.hoverId === id) return SKETCH_COLORS.hover
    return dimColor(dimColor(SKETCH_COLORS.fullyDefined))
  }

  private disposeChildren() {
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      // Badge sprites share cached materials and three's singleton sprite
      // geometry — never dispose either.
      if (child instanceof THREE.Sprite) continue
      const obj = child as THREE.Line | THREE.Points | Line2
      if (obj.geometry) obj.geometry.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      mats.forEach((m) => m && (m as THREE.Material).dispose())
    }
    this.dashedMats = []
    this.hoverUnderlayMats = []
    this.badgeSprites = []
    this.badgeRecords = []
    this.dimensionRecords = []
  }

  dispose() {
    this.disposeChildren()
  }
}
