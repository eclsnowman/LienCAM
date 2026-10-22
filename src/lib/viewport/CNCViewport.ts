import { TOOLPATH_WINDOW_SIDE_LIMIT, type ToolpathWindowSegment } from '../simulation/toolpathWindow'
import type { ReferenceImageRuntime } from '../../referenceImage/runtime'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
// GEO-25b: Line2/LineGeometry are the STRIP-topology siblings of
// LineSegments2/LineSegmentsGeometry (a chain of connected points instead of
// independent segment pairs) -- used only for the fat B-rep edge SELECTION
// HIGHLIGHT overlay (buildBrepHighlight), which is built from one edge's
// polyline chain, same shape THREE.Line already consumed on 'classic'.
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import type { WCS, SceneStock, ToolpathMove, NavPresetId, ProjectionZAnchor, ShadingMode, SectionAxis, SelectedMove } from '../../types'
import {
  applyModeledBodyShadingToMaterial, applyShadingToMaterial, captureMaterialBaseline,
  edgesVisibleForMode, modeledBodyEdgesVisibleForMode,
  sectionPlaneParams, stockSimDisplayStyle, DEFAULT_SHADING_MODE, type MaterialBaseline,
} from './displayModes'
import { createNavPresetController, type NavPresetController } from './navPresetController'
import { createSectionCapController, type SectionCapController } from './sectionCaps'
// Shared fixed studio lighting. Model consumes this same environment,
// exposure, and world-space rig.
import { installViewportEnvironment, type ViewportEnvironment } from './lighting/buildEnvironment'
import {
  CAM_AMBIENT,
  CAM_ACCENT_LIGHTS,
  CAM_SIM_IBL_AMBIENT,
  MODELED_BODY_STUDIO_ENV_INTENSITY,
  MODELED_BODY_STUDIO_EXPOSURE,
  type CamAccentLightDescriptor,
} from './lighting/rigDescriptors'
import { buildModeledBodyStudioRig } from './lighting/workbenchRig'
// GEO-23 L4 (audit cure C2): per-vertex ambient occlusion baked into body geometry
// so bored holes read as recesses (darker-with-depth) from every orbit direction.
import { applyBodyAO } from './lighting/vertexAO'
import { isDepthExtentExempt, markDepthExtentExempt } from '../../viewport3d/depthExtent'
import type { BrepModelPayload } from '../cam/geometry/occt/model/types'
import type { ModelBodyDisplay } from '../../types'
import { projectSTLToLoops as runSTLProjection, sliceAtZ, buildLoops, type ProjectionOptions } from '../geometry/stlProjection'
import {
  Sketcher,
  type SketchViewState, type SketchOffset,
  type SketcherHost, type SketchDocumentPort, type SketchMenuPort,
  type SketchUndoSink,
} from '../sketch/sketcher'
import type { Sketch, Vec2 as SketchVec2 } from '../sketch/types'
import {
  buildToolpathRoleSegmentsIndexed, buildEndCaps, resolveMovePickFromSegment,
  type MoveOwner, type ToolpathPickPayload,
} from './toolpathSegments'
import { placementToScenePose, resolveLoopPickGeoId, type NestPose } from './nestRender'
import { rayPierceLoop, type V3 } from './loopPickInterior'
import {
  closestArcPosition, pointAtFraction, isTabFractionFree,
} from './tabPlacement'
import {
  buildStockSimTopology,
  updateStockSimMesh,
  STOCK_SIM_CLIFF_THRESHOLD_FACTOR,
  type StockSimLayout,
} from './stockSimMesh'
import { VoxelSimTexture } from './voxelSimTexture'
import {
  createVoxelSimMaterial,
  buildVoxelSimMesh,
  applyVoxelSimDisplayMode,
  updateVoxelSimUniforms,
} from './voxelSimMaterial'
import { markStockRemovalBody } from './stockRemovalDisplayAuthority'
import {
  BODY_EDGE_NDC_DEPTH_BIAS,
  applyBodyEdgeOverlayStyle,
  createBodyEdgeOverlay,
  disposeBodyPresentation,
  setBodyPresentationVisible,
  type BodyPresentationPair,
} from '../../viewport3d/bodyPresentation'
import {
  applySelectedBodyMaterialTint,
  createBodyInteractionOverlay,
  createEdgeInteractionOverlay,
  createFaceInteractionOverlay,
  disposeInteractionOverlay,
  faceTrianglePositions,
  interactionOverlayVisibleForMode,
  restoreSelectedBodyMaterialTint,
  syncInteractionClipping,
  syncInteractionColor,
  syncInteractionResolution,
  updateSelectedBodyMaterialTint,
  type InteractionVariant,
  type SelectedBodyMaterialState,
} from '../../viewport3d/interactionPresentation'
import { buildEdgeLineGeometry } from '../../viewport3d/tessGeometry'
import type { VoxelField } from '../simulation/voxel/VoxelField'
import { asNumber, asHex } from '../../theme/viewportColors'
import { useCamStore } from '../../store'
import { isWorkholdingGeometry } from '../../store/dispatchGeo'
// GEO-25 (Q-50 viewport display theme): ONE shared theme definition, also
// consumed by the Model workspace (SolidsWorkbenchPage.tsx). See that
// module's header for the sRGB-construction rule and why 'classic' is not a
// color override at all.
import {
  DEFAULT_VIEWPORT_THEME,
  isViewportThemeId,
  type ViewportThemeId,
} from './lighting/viewportThemes'
import {
  createModeledBodyMaterial,
  modeledBodyEdgeOverlayOptions,
  modeledBodyEdgeUsesFatLines,
  resolveModeledBodyEdgeModeStyle,
  resolveModeledBodyVisualStyle,
  type ModeledBodyVisualStyle,
} from './lighting/bodyVisualStyle'
import {
  DEFAULT_SELECTION_GLOW,
  isSelectionGlowCandidateId,
  resolveSelectionGlowColors,
  type SelectionGlowCandidateId,
} from './lighting/selectionGlowTokens'
import { buildToolProfile, buildHolderProfile, type ProfileVertex } from '../tool/toolProfile'
import type { Tool, ToolType } from '../../types'
import { fmtDim, parseDimToMm, unitLabel } from '../ui/unitFormat'
import { attachSelectAllOnClick } from '../../components/ui/selectAllOnClick'
import { observeRendererDpr, rendererDpr } from '../ui/zoomDpr'

// Tool-marker geometry config. Carries the fields buildToolProfile needs plus
// optional holder data so the 3D marker is a revolved profile + holder assembly.
type HolderSegmentCfg = { height: number; lowerDiameter: number; upperDiameter: number }
type ToolGeoCfg = {
  type: string
  diameter: number
  shankDiameter: number
  fluteLength: number
  shoulderLength: number
  overallLength: number
  cornerRadius: number
  angleFromAxisDeg: number
  tipDiameter?: number
  neckDiameter?: number
  holderSegments?: HolderSegmentCfg[]
  lengthBelowHolder?: number
}

export type PartMovePlaneAxis = 'XY' | 'XZ' | 'YZ' | 'XYZ'
export type PartMoveLockAxis = 'x' | 'y' | 'z'

const PART_MOVE_PLANE_AXES: Record<PartMovePlaneAxis, readonly [PartMoveLockAxis, PartMoveLockAxis]> = {
  XY: ['x', 'y'],
  XZ: ['x', 'z'],
  YZ: ['y', 'z'],
  // TransformControls' white center moves in the camera-facing plane. In CAM
  // Setup, Shift means orthogonal part placement on the setup plane; Z keeps
  // its dedicated axis handle and must not leak into the constrained gesture.
  XYZ: ['x', 'y'],
}

/** Resolve one Shift-constrained part-move sample in world coordinates.
 *  `lockedAxis` is latched by the caller for the rest of the Shift hold so a
 *  near-diagonal pointer does not flicker between axes. */
export function resolvePartMoveOrthoLock(
  start: Readonly<{ x: number; y: number; z: number }>,
  current: Readonly<{ x: number; y: number; z: number }>,
  plane: PartMovePlaneAxis,
  lockedAxis: PartMoveLockAxis | null,
): { position: { x: number; y: number; z: number }; lockedAxis: PartMoveLockAxis | null } {
  const [first, second] = PART_MOVE_PLANE_AXES[plane]
  const firstDelta = Math.abs(current[first] - start[first])
  const secondDelta = Math.abs(current[second] - start[second])
  const resolvedAxis = lockedAxis
    ?? (Math.max(firstDelta, secondDelta) > 1e-9
      ? (firstDelta >= secondDelta ? first : second)
      : null)
  if (resolvedAxis === null) return { position: { ...current }, lockedAxis: null }

  return {
    // This is an axis lock, not merely a two-coordinate cleanup. Pin every
    // non-dominant coordinate to drag start so the camera-facing XYZ handle
    // cannot leak Z while Shift is promising horizontal/vertical placement.
    position: { ...start, [resolvedAxis]: current[resolvedAxis] },
    lockedAxis: resolvedAxis,
  }
}

// ── B20 optimization-preview node markers ─────────────────────────────────────
// The structural nodes of a CLEANED loop are its segment endpoints (few), NOT
// the dense re-sampled display points. Return first point + each segment's `to`.
// Falls back to the raw points when the loop has no segments.
function optNodePoints(
  loop: { points: Array<{ x: number; y: number }>; segments?: Array<{ to: { x: number; y: number } }> }
): Array<{ x: number; y: number }> {
  if (!loop.segments || loop.segments.length === 0) return loop.points
  const nodes: Array<{ x: number; y: number }> = []
  if (loop.points.length > 0) nodes.push(loop.points[0])
  for (const s of loop.segments) nodes.push(s.to)
  return nodes
}

// Build a THREE.Points node-marker cloud (mirrors the snapCloud material).
function makeOptNodeMarkers(pts: THREE.Vector3[], color: number): THREE.Points {
  const geo = new THREE.BufferGeometry().setFromPoints(pts)
  const mat = new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false })
  const points = new THREE.Points(geo, mat)
  points.renderOrder = 999
  return points
}

// ── Viewport pick resolution (pure, geometry-wins) ────────────────────────────
// Given the ordered raycast intersections (already resolved to a part id and/or
// ancestor stock-userData per hit), decide what a click selects. GEOMETRY WINS:
// the FIRST hit that resolves to a part is selected even if a stock face sits
// nearer in the list. If no hit is a part, the first hit whose ancestor is a
// MOVABLE stock (userData.kind === 'stock' && movable, i.e. a FIXED stock) is
// selected. When allowNonMovableStockTarget is true, a rendered AUTO stock may
// also be selected as an owning-stock assignment target; ordinary auto-stock
// clicks remain inert. No qualifying hit -> null (caller treats as empty-click
// deselect). Pure + GL-free so it unit-tests without a renderer; the real
// raycast lives in handleClick.
export interface ViewportPickHit {
  /** Result of findPartId() on this hit's object, or null. */
  partId: string | null
  /** Ancestor stock userData on this hit, or null when no stock ancestor. */
  stock: { stockId: string; movable: boolean } | null
}

// WO-376: the setup-origin choice is a compact locator, not the WCS origin
// itself. Keep its visible pip deliberately smaller than the old 10 mm gold
// ball while retaining that old ball's forgiving pick diameter through a
// separate transparent hit mesh. The colors are UI identity/focus roles so
// Default and Amber both inherit their own established palette.
const ZERO_POINT_CHOICE_FILL_RADIUS = 2.2
const ZERO_POINT_CHOICE_OUTLINE_RADIUS = 3.15
const ZERO_POINT_CHOICE_HIT_RADIUS = 5
const ZERO_POINT_CHOICE_LABEL_POSITION_Y = 7
const ZERO_POINT_CHOICE_HOVER_SCALE = 1.12
const WCS_ORIGIN_RADIUS = 1.8
const BREP_EDGE_CLOSURE_TOLERANCE = 0.01
// WO-1503: same click-vs-drag threshold handleClick already uses (5px,
// squared) -- shared so a right-button pan is judged by the identical
// distance a left-button drag is.
const CLICK_DRAG_THRESHOLD_SQ_PX = 25

type ZeroPointChoiceAppearance = {
  fill: string
  outline: string
  labelBorder: string
  labelBackground: string
  labelText: string
}

/** B-rep input modes. Callbacks always report the concrete face or edge hit. */
export type BrepPickMode = 'face' | 'edge' | 'face-or-edge'

/** One labeled point the operator can confirm directly in the 3D workspace. */
export interface ZeroPointChoice {
  id: string
  label: string
  position: { x: number; y: number; z: number }
}
export type ViewportPickResult =
  | { kind: 'part'; id: string }
  | { kind: 'stock'; id: string }
  | { kind: null; id: null }

export function resolveViewportPick(
  hits: ViewportPickHit[],
  allowNonMovableStockTarget = false,
): ViewportPickResult {
  // Geometry wins: any part hit anywhere in the ordered list beats a nearer stock.
  for (const h of hits) {
    if (h.partId) return { kind: 'part', id: h.partId }
  }
  // No part: first movable fixed stock, or any rendered stock when an existing
  // selected part makes this click an owning-stock assignment.
  for (const h of hits) {
    if (h.stock && (h.stock.movable || allowNonMovableStockTarget)) {
      return { kind: 'stock', id: h.stock.stockId }
    }
  }
  return { kind: null, id: null }
}

// ── Contour holding-tab editor (Tabs v2) ────────────────────────────────────

/** One contour loop's tab-marker data. `path` is the FINISH-contour polyline
 *  (world XY, cut order, seam first) from Operation.contourTabPreview;
 *  `fractions` are the current tab CENTERS as fractions of its perimeter. */
export interface ContourTabMarkerLoop {
  loopId: string
  path: Array<{ x: number; y: number }>
  fractions: number[]
  /** Minimum circular separation between tab centers (tabWidth / perimeter):
   *  the edit mode refuses drags/adds closer than this, mirroring the
   *  engine's fail-loud overlap rule. */
  minSeparationFraction: number
}

export interface ContourTabMarkerData {
  loops: ContourTabMarkerLoop[]
  /** World Z the markers sit at (the retained tab tops). */
  z: number
}

export interface ContourTabEditCallbacks {
  onAdd: (loopId: string, fraction: number) => void
  onMove: (loopId: string, index: number, fraction: number) => void
  onRemove: (loopId: string, index: number) => void
  /** Fired when the mode exits from inside the viewport (Esc). */
  onExit: () => void
}

export interface StockCornerPick {
  stockId: string
  row: 0 | 1 | 2
  col: 0 | 1 | 2
  face: 'top' | 'bottom'
  pos: { x: number; y: number; z: number }
}

/** WO-1587: one face picked out of the viewport for "Seat in vise". `point`
 *  and `normal` are WORLD space: the exact centroid of the clicked triangle's
 *  planar region and that region's area-weighted OUTWARD normal - the same
 *  point+normal pair `lib/cam/workholdingSeat.ts`'s seating engine consumes,
 *  which is why a stepped jaw face (no bounding-box face anywhere near it)
 *  seats exactly like a flat one. */
export interface SeatFacePick {
  geoId: string
  point: { x: number; y: number; z: number }
  normal: { x: number; y: number; z: number }
}

/** Snap a hit anywhere on an axis-aligned rendered stock to its nearest 3x3
 * top/bottom WCS point. This is the viewport equivalent of SetupModal's legacy
 * grid, but the rendered stock supplies both the stock identity and geometry. */
export function resolveStockCornerPick(
  stockId: string,
  point: { x: number; y: number; z: number },
  bounds: {
    min: { x: number; y: number; z: number }
    max: { x: number; y: number; z: number }
  },
): StockCornerPick {
  const spanX = bounds.max.x - bounds.min.x
  const spanY = bounds.max.y - bounds.min.y
  const xFrac = spanX > 0 ? (point.x - bounds.min.x) / spanX : 0
  const yFrac = spanY > 0 ? (point.y - bounds.min.y) / spanY : 0
  const col = Math.max(0, Math.min(2, Math.round(xFrac * 2))) as 0 | 1 | 2
  const row = Math.max(0, Math.min(2, Math.round((1 - yFrac) * 2))) as 0 | 1 | 2
  const face = Math.abs(point.z - bounds.max.z) <= Math.abs(point.z - bounds.min.z)
    ? 'top'
    : 'bottom'
  return {
    stockId,
    row,
    col,
    face,
    pos: {
      x: bounds.min.x + (col / 2) * spanX,
      y: bounds.min.y + ((2 - row) / 2) * spanY,
      z: face === 'top' ? bounds.max.z : bounds.min.z,
    },
  }
}

// ============================================================
// CNC Viewport Engine
// ============================================================

/** WO-380: the stock block a directly-loaded setup was planned against, in
 *  PROGRAM (work) coordinates - the same frame the parsed toolpath and the live
 *  cutter live in, so the one programFrameGroup translation places it. A null
 *  clears it. `stale` paints the "setup/program changed since post" tint. */
export interface IntendedStockBox {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
  stale: boolean
}

export interface MachinePreviewCoordinateFrameInput {
  /** Machine coordinate of the active program's work origin. */
  programOriginMachine: { x: number; y: number; z: number } | null
  /** null means Off or unavailable: no authoritative grid/origin is drawn. */
  grid: {
    travel: { x: number; y: number }
    originMachine: { x: number; y: number; z: number }
    /** Authoritative signed machine-coordinate box. Older callers may omit
     *  it and retain the legacy GRBL [-travel, 0] fallback. */
    extentMachine?: {
      x: { min: number; max: number }
      y: { min: number; max: number }
    } | null
  } | null
}

export interface ResolvedMachinePreviewCoordinateFrame {
  programTranslation: { x: number; y: number; z: number }
  grid: {
    minX: number
    maxX: number
    minY: number
    maxY: number
    z: number
    originMachine: { x: number; y: number; z: number }
  } | null
}

function finitePoint(point: { x: number; y: number; z: number } | null) {
  return point !== null && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
}

/**
 * Machine-control previews use one canonical machine-coordinate frame. The
 * caller supplies the signed envelope when it knows it; legacy callers fall
 * back to GRBL's [-travel, 0] convention.
 */
export function resolveMachinePreviewCoordinateFrame(
  input: MachinePreviewCoordinateFrameInput,
): ResolvedMachinePreviewCoordinateFrame {
  const programTranslation = finitePoint(input.programOriginMachine)
    ? { ...input.programOriginMachine! }
    : { x: 0, y: 0, z: 0 }
  const grid = input.grid
  if (
    !grid
    || !finitePoint(grid.originMachine)
    || !Number.isFinite(grid.travel.x)
    || !Number.isFinite(grid.travel.y)
    || grid.travel.x <= 0
    || grid.travel.y <= 0
  ) {
    return { programTranslation, grid: null }
  }
  const extent = grid.extentMachine
  const validExtent = extent
    && Number.isFinite(extent.x.min) && Number.isFinite(extent.x.max)
    && Number.isFinite(extent.y.min) && Number.isFinite(extent.y.max)
    && extent.x.max > extent.x.min && extent.y.max > extent.y.min
  return {
    programTranslation,
    grid: {
      minX: validExtent ? extent.x.min : -grid.travel.x,
      maxX: validExtent ? extent.x.max : 0,
      minY: validExtent ? extent.y.min : -grid.travel.y,
      maxY: validExtent ? extent.y.max : 0,
      z: grid.originMachine.z,
      originMachine: { ...grid.originMachine },
    },
  }
}

export function machinePreviewGridAxisCoordinates(
  min: number,
  max: number,
  origin: number,
  spacing: number,
): Array<{ coordinate: number; accent: boolean }> {
  if (![min, max, origin, spacing].every(Number.isFinite) || spacing <= 0 || max < min) return []
  const firstIndex = Math.ceil((min - origin) / spacing)
  const lastIndex = Math.floor((max - origin) / spacing)
  const result: Array<{ coordinate: number; accent: boolean }> = []
  for (let index = firstIndex; index <= lastIndex; index++) {
    result.push({ coordinate: origin + index * spacing, accent: index % 5 === 0 })
  }
  return result
}

// Scene-furniture + geometry-state colors resolve from the shared design
// tokens (src/theme/tokens.css) via the viewport color bridge, so CSS and
// the 3D scene can never drift. WO-346: this used to be a module-scope
// object literal (`DARK_COLORS`), so every asNumber() call ran ONCE at
// import time and the resolved numbers were frozen forever after -- a live
// theme switch (or even a switch before the module's first import) could
// never reach it, and `private colors = DARK_COLORS` then pinned that stale
// snapshot to every instance forever. Every former DARK_COLORS field is now
// a direct asNumber() call inline at its one use site below, so each read
// re-resolves from the CURRENT theme's CSS custom properties -- the same
// live-read viewportColors.ts's own resolve() already does (see its cache,
// invalidated on data-theme change). No intermediate object to go stale.

const ROLE_COLORS: Record<string, number> = {
  rapid:    asNumber('--role-rapid'),
  cut:      asNumber('--role-cut'),
  helix:    asNumber('--role-helix'),
  ramp:     asNumber('--role-ramp'),
  plunge:   asNumber('--role-plunge'),
  stepover: asNumber('--role-stepover'),
  fast_traverse: asNumber('--role-fast-traverse'),
  wall_follow: asNumber('--role-wall-follow'),
  finish:   asNumber('--role-finish'),
  lead_in:  asNumber('--role-lead-in'),
  lead_out: asNumber('--role-lead-out'),
}
// V5 palette v3 (Operator directive 2026-06-12): dashes ONLY for rapids; every
// other role is SOLID. rapid keeps its dashes AND its solid END CAPS so a
// join never falls in a dash void and reads as a gap. stepover and
// fast_traverse, formerly dashed, are now solid (caps no longer needed).
const ROLE_DASHED = new Set(['rapid'])
const ROLE_END_CAPPED = new Set(['rapid'])
// World-space cap length (mm). Fixed length is the agreed simple approximation
// for a "~6-8 screen px" cap without per-frame zoom recompute (Phase 4 brief).
const TOOLPATH_CAP_LEN = 0.8

const DEFAULT_STOCK: SceneStock = {
  mode: 'auto',
  autoOffsetXY: 5,
  autoOffsetZTop: 5,
  fixedWidth: 100,
  fixedHeight: 100,
  fixedDepth: 50,
  fixedStocks: [],
}

// WO SKC-14: the mount contract moved into the sketcher component (src/lib/sketch/sketcher/
// ports.ts) -- it is the component's port, not the viewport's. Re-exported here so existing
// importers of the viewport module keep working. WO SKC-14B narrowed it to a pure
// document/commit/undo sink and renamed it `SketchDocumentPort` (there are no tool handlers left
// to hand over: the package owns the tool machine).
export type { SketchDocumentPort } from '../sketch/sketcher'

// ─────────────────────────────────────────────────────────────────────────────
// WO UI-74 (Operator finding N-36) -- CAMERA DEPTH POLICY: shared helpers
//
// Operator: "You have workspace clipping again. Look at the grid. This is getting
// disapointing. Fix this. It should NEVER, EVER happen again."
//
// The bug: this camera's near/far were CONSTRUCTION CONSTANTS (0.1 / 10000, the
// OrthographicCamera call below) and nothing ever re-fitted them, while the
// camera's POSITION is placed by a body-only fit (fitCameraToObject puts the eye
// at maxDim*5 from the WORKPIECE bounds). The grid is sized to the MACHINE
// (max(travelX, travelY)), not the part, so on any part small relative to the
// machine the grid reaches far behind the eye -- and everything nearer than
// `near` is cut in clip space. Head-on that is invisible (the grid plane sits at
// one constant camera depth); it appears the moment the camera TILTS, which is
// exactly what Operator's screenshot shows. Measured pre-fix on the real CAM
// workspace: grid corners at -184.80mm against a near plane of 0.1
// (coordination/evidence/UI-74/repro/).
//
// The rule this file now keeps: the slab is fitted, LIVE, to everything that
// actually renders -- not to the bodies, and not to a constant.
//
// Note on ORTHOGRAPHIC near: it may legitimately go NEGATIVE, and that is the
// core of the fix rather than a trick. An ortho slab is just a box in front of
// the eye plane; `near < 0` simply extends it BEHIND the eye, which is the only
// correct answer when scene content is behind the eye and must still be drawn.
// Two things make it safe here, both checked rather than assumed:
//   - Depth precision stays linear for an ortho projection, so a slab fitted to
//     the content keeps the same resolution it has today.
//   - Picking is untouched. THREE.Raycaster.setFromCamera puts the ortho ray
//     origin at NDC z = (near+far)/(near-far), which unprojects to camera depth
//     EXACTLY 0 for any near/far -- substitute and the near/far cancel. So the
//     ray this viewport casts is bit-for-bit the same before and after.
//     (src/tests/viewport/camDepthPolicy.ui74.test.ts pins both.)

/** What each geometry's cached boundingBox was measured FROM: the exact position
 *  attribute OBJECT, and that object's change counter at measure time.
 *
 *  WO UI-72-R1's lesson, imported deliberately: keying a bbox cache on PRESENCE
 *  (`boundingBox === null`) is itself a clip bug, because three.js never
 *  invalidates boundingBox when a vertex buffer is written IN PLACE. A root that
 *  moved would keep contributing its OLD extent and the "inclusive" slab would
 *  clip it -- this very defect, reintroduced through the cache. Keying on
 *  BufferAttribute.version covers EVERY in-place writer, present and future,
 *  rather than the ones we happen to know about today.
 *
 *  WO UI-74-R1 (audit MINOR 1) adds the attribute's IDENTITY to that key, because
 *  the version alone has an escape: version counting restarts at 0 for every new
 *  BufferAttribute, so `setAttribute('position', newAttribute)` -- three.js's own
 *  idiom for swapping a buffer rather than writing it -- can hand back a version
 *  the cache has already seen and the stale box survives the swap. The auditor
 *  built it: a geometry measured at camera depth 5, given a fresh version-0
 *  position buffer at depth 500, still reported the 4.99..5.01 slab. Identity
 *  moves on every swap and the version moves on every in-place write, so the pair
 *  covers both writers; neither alone does. WeakMap on the geometry so a disposed
 *  geometry drops out with no unregister call, and the attribute is held only as
 *  a comparison referent. */
interface CamDepthBoxStamp {
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
  version: number
}
const camDepthBoxStamp = new WeakMap<THREE.BufferGeometry, CamDepthBoxStamp>()

/** The position attribute and its change counter, or null when either cannot be
 *  read. null means RECOMPUTE -- never "assume unchanged": an unreadable signal
 *  is not evidence that nothing moved. */
function camPositionBufferStamp(geometry: THREE.BufferGeometry): CamDepthBoxStamp | null {
  const position = geometry.attributes?.position
  if (position === undefined || position === null) return null
  const version = (position as THREE.BufferAttribute).version
  if (typeof version !== 'number' || !Number.isFinite(version)) return null
  return { attribute: position, version }
}

/** `geometry.boundingBox`, recomputed whenever the position buffer has been
 *  written in place (version moved) OR replaced outright (attribute identity
 *  moved) since this module last measured it -- see camDepthBoxStamp. */
function camDepthBoundingBox(geometry: THREE.BufferGeometry): THREE.Box3 | null {
  const stamp = camPositionBufferStamp(geometry)
  if (stamp === null) {
    camDepthBoxStamp.delete(geometry)
    geometry.computeBoundingBox()
    return geometry.boundingBox
  }
  const measured = camDepthBoxStamp.get(geometry)
  const stale = measured === undefined
    || measured.attribute !== stamp.attribute
    || measured.version !== stamp.version
  if (geometry.boundingBox === null || stale) {
    geometry.computeBoundingBox()
    camDepthBoxStamp.set(geometry, stamp)
  }
  return geometry.boundingBox
}

/** Does `obj` put pixels on screen itself? Lights, cameras, bare Groups and
 *  Object3Ds do not; only these five draw. Kept explicit because a "root" with
 *  zero drawables must contribute NOTHING rather than an empty box -- an empty
 *  box silently reads as "inside the slab" and would make a check vacuous. */
function camIsDrawable(obj: THREE.Object3D): boolean {
  const o = obj as Partial<THREE.Mesh & THREE.Line & THREE.Points & THREE.Sprite> & {
    isLineSegments?: boolean
  }
  return o.isMesh === true || o.isLine === true || o.isLineSegments === true
    || o.isPoints === true || o.isSprite === true
}

type CamDepthExtentStatus = 'none' | 'some' | 'nonfinite'

/** Grow `union` (world space) by every drawable under `obj`, skipping invisible
 *  and depth-extent-exempt subtrees.
 *
 *  Hand-rolled rather than Box3.setFromObject for one reason: setFromObject has
 *  no way to skip an exempt subtree, and this scene contains a pseudo-infinite
 *  one (see markDepthExtentExempt at the TransformControls root).
 *
 *  'nonfinite' REFUSES the whole pass and must not degrade to "skip that one
 *  object": a root whose geometry went NaN still RENDERS, so quietly leaving it
 *  out of the extent would fit a slab that clips it -- the exact defect this
 *  policy exists to prevent, coming back through the error path. NaN also fails
 *  every comparison in BOTH directions, so a silent skip would look like a pass. */
export function camUnionDepthExtent(
  union: THREE.Box3,
  obj: THREE.Object3D,
  scratch: THREE.Vector3,
): CamDepthExtentStatus {
  if (!obj.visible || isDepthExtentExempt(obj)) return 'none'
  let status: CamDepthExtentStatus = 'none'
  if (camIsDrawable(obj)) {
    const geometry = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    if (geometry?.attributes?.position !== undefined) {
      const box = camDepthBoundingBox(geometry)
      if (box !== null && !box.isEmpty()) {
        for (let i = 0; i < 8; i += 1) {
          scratch.set(
            (i & 1) ? box.max.x : box.min.x,
            (i & 2) ? box.max.y : box.min.y,
            (i & 4) ? box.max.z : box.min.z,
          ).applyMatrix4(obj.matrixWorld)
          if (!Number.isFinite(scratch.x) || !Number.isFinite(scratch.y) || !Number.isFinite(scratch.z)) {
            return 'nonfinite'
          }
          union.expandByPoint(scratch)
        }
        status = 'some'
      }
    }
  }
  for (const child of obj.children) {
    const childStatus = camUnionDepthExtent(union, child, scratch)
    if (childStatus === 'nonfinite') return 'nonfinite'
    if (childStatus === 'some') status = 'some'
  }
  return status
}

export type CamDepthSlab =
  | { ok: true; near: number; far: number; minDepth: number; maxDepth: number }
  | { ok: true; near: null; far: null; minDepth: null; maxDepth: null } // nothing drawable
  | { ok: false; reason: 'camera-depth-refused-nonfinite-bounds' | 'camera-depth-refused-nonfinite-result' }

/** WO UI-74. The camera depth policy, as a pure function of (scene, camera).
 *
 *  Fits the near/far slab to the world extent of everything `scene` actually
 *  DRAWS -- every visible, non-exempt drawable -- rather than to bodies or to a
 *  constant. This is the whole of the fix; the class method around it only
 *  assigns the result.
 *
 *  Pure and exported so the policy can be tested on a real THREE scene without a
 *  WebGL context, which is how src/tests/viewport/camDepthPolicy.ui74.test.ts
 *  pins it. It reads the camera but never mutates it.
 *
 *  `near` may be NEGATIVE and that is correct, not a fallback: an ortho slab is
 *  a box about the eye plane, and content behind the eye must still be drawn.
 *  See the module note above for why that is safe for both depth precision and
 *  picking. */
export function computeCamDepthSlab(
  scene: THREE.Object3D,
  camera: THREE.Camera,
  union: THREE.Box3 = new THREE.Box3(),
  scratch: THREE.Vector3 = new THREE.Vector3(),
): CamDepthSlab {
  scene.updateWorldMatrix(true, true)
  union.makeEmpty()
  const status = camUnionDepthExtent(union, scene, scratch)
  if (status === 'nonfinite') return { ok: false, reason: 'camera-depth-refused-nonfinite-bounds' }
  // Nothing drawable: report "no opinion" so the caller keeps the camera's
  // construction defaults. Fitting a slab to an empty box would be degenerate.
  if (status === 'none') return { ok: true, near: null, far: null, minDepth: null, maxDepth: null }

  // Depth of the union's 8 corners in camera space. -z because three.js cameras
  // look down their local -Z.
  camera.updateMatrixWorld(true)
  const inv = camera.matrixWorldInverse
  let minDepth = Infinity
  let maxDepth = -Infinity
  for (let i = 0; i < 8; i += 1) {
    scratch.set(
      (i & 1) ? union.max.x : union.min.x,
      (i & 2) ? union.max.y : union.min.y,
      (i & 4) ? union.max.z : union.min.z,
    ).applyMatrix4(inv)
    const depth = -scratch.z
    if (depth < minDepth) minDepth = depth
    if (depth > maxDepth) maxDepth = depth
  }

  const diagonal = union.getSize(scratch).length()
  // Padding, so a surface sitting exactly ON the slab boundary is not decided by
  // float noise. Proportional to the scene, with a floor for degenerate (flat)
  // ones -- a scene with no depth span still needs a slab with a positive one.
  const padding = Math.max(1e-3, diagonal * 0.01, (maxDepth - minDepth) * 0.05)
  const near = minDepth - padding
  const far = maxDepth + padding

  // Validate BEFORE the caller mutates: a half-applied camera is worse than an
  // unfitted one. NaN compares false in BOTH directions, so this is an explicit
  // finite test rather than a range check a NaN could sail through.
  if (![minDepth, maxDepth, diagonal, near, far].every(Number.isFinite) || !(far > near)) {
    return { ok: false, reason: 'camera-depth-refused-nonfinite-result' }
  }
  return { ok: true, near, far, minDepth, maxDepth }
}

/** WO-2048: one toolpath role body and what setToolpathDoneBoundary needs to
 *  split it into done (dimmed) and remaining moves. */
interface ToolpathDoneSplit {
  body: THREE.LineSegments
  segRawIndex: Int32Array
  color: number
  dashed: boolean
  dimmed: THREE.LineSegments | null
}

/** WO-2048: buildEndCaps emits caps in run-walk order and does not say which
 *  segment each came from. Each cap starts at an endpoint of one segment and
 *  points along it, so recover that segment's owning move and return the caps
 *  sorted by owner - the done boundary then splits them like the role body. */
function endCapsByOwner(
  positions: Float32Array,
  segRawIndex: Int32Array,
  caps: Float32Array,
): { caps: Float32Array; owners: Int32Array } {
  const key = (a: ArrayLike<number>, o: number) =>
    `${Math.round(a[o] * 1e4)},${Math.round(a[o + 1] * 1e4)},${Math.round(a[o + 2] * 1e4)}`
  // endpoint -> [segment, offset of its other endpoint]
  const touch = new Map<string, number[]>()
  const add = (k: string, s: number, other: number) => {
    let list = touch.get(k)
    if (!list) touch.set(k, list = [])
    list.push(s, other)
  }
  for (let s = 0; s < segRawIndex.length; s++) {
    add(key(positions, s * 6), s, s * 6 + 3)
    add(key(positions, s * 6 + 3), s, s * 6)
  }
  const capCount = Math.floor(caps.length / 6)
  const capOwner = new Int32Array(capCount)
  for (let c = 0; c < capCount; c++) {
    const o = c * 6
    const dx = caps[o + 3] - caps[o], dy = caps[o + 4] - caps[o + 1], dz = caps[o + 5] - caps[o + 2]
    const list = touch.get(key(caps, o)) ?? []
    // No match cannot happen for caps built from these positions; if it did,
    // the cap stays bright until the last move.
    let owner = segRawIndex.length > 0 ? segRawIndex[segRawIndex.length - 1] : 0
    let best = -Infinity
    for (let i = 0; i < list.length; i += 2) {
      const p = list[i + 1]
      const ex = positions[p] - caps[o], ey = positions[p + 1] - caps[o + 1], ez = positions[p + 2] - caps[o + 2]
      const dot = (dx * ex + dy * ey + dz * ez) / ((Math.hypot(dx, dy, dz) * Math.hypot(ex, ey, ez)) || 1)
      if (dot > best) { best = dot; owner = segRawIndex[list[i]] }
    }
    capOwner[c] = owner
  }
  const order = Array.from({ length: capCount }, (_, c) => c).sort((a, b) => capOwner[a] - capOwner[b])
  const sorted = new Float32Array(capCount * 6)
  const owners = new Int32Array(capCount)
  order.forEach((c, i) => {
    sorted.set(caps.subarray(c * 6, c * 6 + 6), i * 6)
    owners[i] = capOwner[c]
  })
  return { caps: sorted, owners }
}

export class CNCViewport {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private sectionCaps: SectionCapController | null = null
  private camera: THREE.OrthographicCamera
  private frustumSize = 500
  private controls: OrbitControls
  // WO-1358: the Control preview can carry the operator's existing orbit pose
  // along with the live cutter. These vectors are reused because this path runs
  // every animation frame while follow mode is active.
  private orbitFocusWorld = new THREE.Vector3()
  private orbitFocusDelta = new THREE.Vector3()
  private orbitFocusActive = false
  // --- Camera-pose persistence (refresh-restore) ---
  // A debounced callback fired ~300ms after the camera stops moving so the React
  // bridge can save the pose (position+target+zoom) for the current project. The
  // raw OrbitControls 'change' event fires every damping frame, so we coalesce.
  private cameraChangeHandler: ((pose: ReturnType<CNCViewport['saveCameraState']>) => void) | null = null
  private cameraChangeTimer: ReturnType<typeof setTimeout> | null = null
  // PERSISTENT "the user has positioned the camera" flag (refresh-persist / T15).
  // When a refresh restores a persisted camera pose with geometry to load,
  // Viewport.tsx sets this true. While true EVERY auto-fit site (addSTL,
  // addBrepModel, add2DGeometry — all funnelled through maybeAutoFit) is
  // suppressed, so NO model-load fit can snap the view back to ISO — including a
  // SECOND/late fit from the async STEP load, which the old ONE-SHOT skipInitialFit
  // could not stop (it only guarded the FIRST add; real-GPU async timing then
  // landed an unguarded extra fit and reset the view). Cleared by an explicit user
  // view change (fitAll / setCameraView / focusOnLoop) and by clearScene, so a
  // fresh New/Open re-enables auto-fit for a brand-new model.
  private cameraUserPositioned = false
  // --- Navigation preset engine (BK-26 shared, see navPresetController.ts) ---
  // Mapping/remap/invert logic lives in the shared createNavPresetController
  // so the model3d sketch scene runtime (WO SKC-5-R1) applies the SAME
  // NAV_PRESETS table through the SAME code, never a forked mapping.
  private navController!: NavPresetController
  private container: HTMLElement
  private animFrameId: number = 0
  // WO-1200: last theme x color-mode identity observed by syncThemeIfChanged(), the
  // same undefined-is-never-observed / null-is-unset sentinel convention
  // viewportColors.ts's own resolve() cache uses (same attribute). Set from
  // real combined value at construction (see constructor) so the first animate()
  // frame does not treat "never observed" as a change and re-run a rebuild
  // that construction already did with the correct colours.
  private lastSeenThemeAttr: string | null | undefined
  // The static PMREM environment is built once and freed in dispose().
  private viewportEnvironment: ViewportEnvironment | null = null
  private stopObservingRendererDpr: () => void = () => undefined

  // Scene groups
  private gridGroup: THREE.Group
  private stockGroup: THREE.Group
  private workpieceGroup: THREE.Group   // container for all part groups
  private toolpathGroup: THREE.Group
  private simulationToolpathGroup: THREE.Group = new THREE.Group()
  private programFrameGroup: THREE.Group
  // WO-380: the intended-stock block rides INSIDE programFrameGroup (work frame).
  private intendedStockGroup: THREE.Group = new THREE.Group()
  private axesGroup: THREE.Group
  private machineGroup: THREE.Group
  private wcsGroup: THREE.Group

  // Multi-part tracking
  private partGroups = new Map<string, THREE.Group>()
  private partMaterials = new Map<string, THREE.MeshStandardMaterial>()
  private partInteractionOutlines = new Map<string, THREE.Object3D>()
  private partSelectedMaterialStates = new Map<string, SelectedBodyMaterialState>()
  private selectedPartId: string | null = null

  /** Legacy focused tests construct a method-only viewport with Object.create,
   * bypassing class field initializers. Keep that supported without changing
   * the fully constructed runtime path. */
  private getPartInteractionOutlines(): Map<string, THREE.Object3D> {
    return this.partInteractionOutlines
      ?? (this.partInteractionOutlines = new Map<string, THREE.Object3D>())
  }

  private getPartSelectedMaterialStates(): Map<string, SelectedBodyMaterialState> {
    return this.partSelectedMaterialStates
      ?? (this.partSelectedMaterialStates = new Map<string, SelectedBodyMaterialState>())
  }

  private getBrepHighlights(): Map<string, THREE.Object3D> {
    return this.brepHighlights
      ?? (this.brepHighlights = new Map<string, THREE.Object3D>())
  }

  // GEO-25 (Q-50 viewport display theme, shared with the Model workspace via
  // src/lib/viewport/lighting/viewportThemes.ts): true for a part whose body
  // color follows the theme default (no explicit per-part appearance
  // override) -- setViewportTheme only re-tints these, never a part the user
  // gave its own color. Original (pre-technique-conversion) edge polyline
  // positions per part, kept so a live theme switch can rebuild EITHER
  // technique on demand -- a fat LineSegments2's geometry is instanced
  // start/end attributes, not a plain 'position' buffer, so the source
  // positions cannot be recovered from the live edge object once converted.
  private partUsesThemeColor = new Map<string, boolean>()
  private partEdgePositions = new Map<string, Float32Array>()
  //
  // WO-286: the shipped theme comes straight from the constant. GEO-25 read
  // this from uiPrefs `viewportTheme` and subscribed to it; WO-270 removed the
  // Settings control and pinned that field to DEFAULT_VIEWPORT_THEME, so the
  // read and the subscription resolved one value and could never fire. The
  // import IS the pin now -- setViewportTheme() below stays public, because a
  // caller can still re-tint the scene deliberately (the Model workspace and
  // the GEO-25 tests drive it), it is just no longer driven by a preference.
  private viewportThemeId: ViewportThemeId = DEFAULT_VIEWPORT_THEME

  // GEO-26 Stage B: selection/hover glow candidate.
  // brepPickColor()/brepHoverColor() read this field fresh on every highlight
  // rebuild. WO-286: same story as viewportThemeId above -- was uiPrefs
  // `selectionGlow` + a subscription, now the shipped constant it always
  // resolved to. setSelectionGlow() stays public for the same reason.
  private selectionGlow: SelectionGlowCandidateId = DEFAULT_SELECTION_GLOW

  // Chunk C3: carved-stock preview groups per adaptive_3d op id (the removed-
  // material stock mesh). One group per op; placement lives on the group.
  private carvedStockGroups = new Map<string, THREE.Group>()
  /** User preference for the plain static stock. Replacement stock owns the
   *  scene while live, then this request is restored when it is disposed. */
  private stockVisibleRequested = true

  // Display (shading) modes + section view. currentShadingMode is the active mode;
  // materialBaselines snapshots each material's pristine display props (captured
  // lazily on first applyShadingMode) so any mode can RESTORE the original render —
  // making the default 'shaded-edges' a visual no-op. clipPlane is the single
  // section-clip plane reused by setSectionView. None of this touches emissive, so
  // selection highlighting composes independently.
  private currentShadingMode: ShadingMode = DEFAULT_SHADING_MODE
  private materialBaselines = new Map<THREE.MeshStandardMaterial, MaterialBaseline>()
  private clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)
  private currentStockConfig: SceneStock = { ...DEFAULT_STOCK }

  // Transform gizmo
  private transformControls!: TransformControls
  // Bounds-center gizmo proxy (UI-75; the `2d` in these names is historical).
  // A group's origin is the frame its content was authored in, NOT necessarily
  // the middle of what you see: 2D importers center their loops (centerLoops),
  // but sketch-baked loops keep the sketch document's own coordinates in a
  // container pinned at (0,0,0) (store/index.ts states the invariant and
  // excludes sketch layers from it), and 3D B-rep / model-workbench meshes
  // keep NATIVE shape coordinates (recentring them is forbidden -- OCCT
  // derives faces in shape space, the Model kernel's ElementMap is the
  // identity source). Attaching TransformControls straight to such a group
  // draws the handles at the group origin -- typically the WORKSPACE ORIGIN,
  // far from the geometry. So those groups attach a transient scene-root proxy
  // at their rendered pivot instead, and the proxy's world-space motion is
  // replayed onto the real group. Only addSTL groups keep DIRECT attachment:
  // addSTL recenters the mesh so the group origin IS the visible pivot, and
  // marks the group with userData.originIsVisiblePivot to say so.
  private geometry2dGizmoProxy: THREE.Object3D | null = null
  private geometry2dGizmoGroup: THREE.Group | null = null
  private geometry2dGizmoLastWorld = new THREE.Matrix4()
  private partMoveShiftHeld = false
  private partMovePlaneDrag: {
    object: THREE.Object3D
    plane: PartMovePlaneAxis
    startWorld: THREE.Vector3
    lockedAxis: PartMoveLockAxis | null
  } | null = null
  private handlePartMoveModifierKey = (event: KeyboardEvent) => {
    if (event.key !== 'Shift') return
    this.partMoveShiftHeld = event.type === 'keydown'
    if (!this.partMoveShiftHeld && this.partMovePlaneDrag) {
      this.partMovePlaneDrag.lockedAxis = null
    }
  }
  private clearPartMoveModifier = () => {
    this.partMoveShiftHeld = false
    if (this.partMovePlaneDrag) this.partMovePlaneDrag.lockedAxis = null
  }
  private onPartTransformChange?: (
    id: string,
    pos: { x: number; y: number; z: number },
    rot: { x: number; y: number; z: number }
  ) => void

  // Interaction mode (lay-on-face / project-plane / seat-face-pick)
  private interactionMode: 'normal' | 'lay-on-face' | 'project-plane' | 'seat-face-pick' = 'normal'
  private faceHighlightGroup = new THREE.Group()
  // Pre-computed face cluster overlays — built once when entering a face-selection mode
  private faceOverlays: Array<{
    normal: THREE.Vector3; mesh: THREE.Mesh; area: number
    centroid: THREE.Vector3   // exact world-space face centroid (no push-off)
    baseColor: number         // un-hovered color so stock vs STL faces restore correctly
    isStock?: boolean
    // WO-1587: which body this face belongs to. lay-on-face/project-plane
    // overlay exactly ONE body so they never needed it; the seat pick overlays
    // the workholding body and the part at once and must tell them apart.
    geoId?: string
  }> = []
  private hoveredOverlayMesh: THREE.Mesh | null = null
  private onLayOnFaceComplete?: () => void
  // WO-1587: "Seat in vise" face picking (see enterSeatFacePickMode).
  private seatFacePickCallback: ((pick: SeatFacePick) => void) | null = null
  private seatFacePickHoverCallback: ((pick: SeatFacePick | null) => void) | null = null
  // Project-plane mode callbacks
  private onProjectPlaneConfirm?: (normal: THREE.Vector3, centroid: THREE.Vector3, zAnchor?: ProjectionZAnchor) => void
  private onProjectPlaneCancel?: () => void
  private _projPlaneOverlay: HTMLElement | null = null
  // World-space loop groups from face-plane projections (keyed by geoId, live in scene root)
  private _worldPlaneLoopGroups = new Map<string, THREE.Group>()
  // Geometry-local derived-loop groups (Layer2D.frame === 'geometry_local',
  // B-rep derives): points are MODEL coords, so the group is parented under the
  // part's group and follows the gizmo live. Falls back to scene root when the
  // part mesh has not loaded yet; addBrepModel re-attaches it.
  private _geoLocalLoopGroups = new Map<string, THREE.Group>()
  // Latest stock bounding box (updated after every rebuildStock)
  private _stockBounds: { min: THREE.Vector3; max: THREE.Vector3 } | null = null
  private onPartSelect?: (id: string | null) => void
  private partPickCallback: ((id: string) => void) | null = null
  private partPickAllowedIds: Set<string> | null = null
  private partPickHoverId: string | null = null
  // MW-PICKS-2 (Q-68, contextual-feedback rule): OPTIONAL hover reporter for
  // an armed whole-part pick session -- callers (e.g. SketchEntryModal) use
  // this to post a plain-words console line on hover CHANGE, alongside the
  // hover HIGHLIGHT this class already painted before this WO (paintPartHighlight,
  // called from setPartPickHover below). null outside an active pick session.
  private partPickHoverCallback: ((id: string | null) => void) | null = null
  private stockCornerPickCallback: ((pick: StockCornerPick) => void) | null = null
  private stockCornerPickAllowedIds: Set<string> | null = null
  private stockCornerPickMarker: THREE.Mesh | null = null
  // WO-366: explicit Top/Bottom point choices shown after a cylindrical face
  // is selected. This is a separate interaction stage from B-rep picking.
  private zeroPointChoiceGroup: THREE.Group | null = null
  private zeroPointChoiceCallback: ((id: string) => void) | null = null
  private zeroPointChoiceHoverId: string | null = null

  // ── Contour holding-tab markers + edit mode (Tabs v2) ─────────────────────
  // Markers render whenever the SELECTED contour op has tabs enabled (display
  // only); the edit mode (entered from the Properties panel) additionally owns
  // clicks (add), marker drags (slide along the contour) and double-clicks
  // (remove). Fractions/paths come from Operation.contourTabPreview via
  // setContourTabMarkers — the viewport never derives contour geometry itself.
  private tabMarkerGroup: THREE.Group | null = null
  private tabMarkerData: ContourTabMarkerData | null = null
  private tabEditCallbacks: ContourTabEditCallbacks | null = null
  private tabEditDrag: {
    loopId: string; index: number; fraction: number
    marker: THREE.Mesh; moved: boolean
  } | null = null
  private tabEditJustDragged = false
  private tabEditMoveHandler: ((e: PointerEvent) => void) | null = null
  private tabEditUpHandler: ((e: PointerEvent) => void) | null = null
  private tabEditDblClickHandler: ((e: MouseEvent) => void) | null = null
  private tabEditKeyHandler: ((e: KeyboardEvent) => void) | null = null
  private partPickSelectedIds = new Set<string>()
  private partPickPresentation: 'standard' | 'nest-membership' = 'standard'
  private partPickGlowGroups = new Map<string, THREE.Group>()
  // Stock pick callback: id when a qualifying stock is clicked, null on empty
  // click, plus the part selected when the click began (owning-stock assignment
  // context). The gizmo attaches via selectedStockId in DesignTree, not here.
  private onStockSelect?: (id: string | null, assignmentPartId?: string | null) => void

  // WCS gizmo (separate sphere used when editing WCS origin)
  private wcsGizmoSphere: THREE.Mesh | null = null
  private wcsGizmoChangeListener: (() => void) | null = null
  private wcsFixed = false   // when true, rebuildStock won't auto-reset the WCS indicator

  // Per-stock group map for getStockBounds(stockId)
  private fixedStockBoxes = new Map<string, THREE.Group>()

  // Stock gizmo (cyan sphere on the stock min-corner, uses TransformControls)
  private stockGizmoSphere: THREE.Mesh | null = null
  private stockGizmoId: string | null = null
  private stockGizmoChangeListener: (() => void) | null = null
  private stockGizmoFinishListener: ((e: { value: unknown }) => void) | null = null

  // Vertex / geometry-point pick mode
  private vertexPickCallback: ((result: {
    pos: { x: number; y: number; z: number }
    geoId?: string
    localPt?: { x: number; y: number; z: number }
  }) => void) | null = null

  // Pre-computed snap candidates (built on enterVertexPickMode)
  private snapCandidates: Array<{
    worldPos: THREE.Vector3
    localPos: THREE.Vector3
    geoId: string
    type: 'vertex' | 'circle_center'
  }> = []
  private snapCloud: THREE.Points | null = null
  private snapHoveredIdx = -1
  private projectedLoopGroups = new Map<string, THREE.Group>()

  // ── Z-scrub mode (shared slice/section machinery) ───────────────────────────
  // One interaction, two backends: STL slice (synchronous mesh slice per frame)
  // and B-rep section (throttled async worker derive). See _enterZScrubMode.
  private slicePlaneGroup:    THREE.Group | null = null
  private slicePlaneZ         = 0
  private slicePlaneMinZ      = 0
  private slicePlaneMaxZ      = 0
  private slicePlaneWorldPos: Float32Array | null = null
  private slicePlaneKeyHandler:   ((e: KeyboardEvent) => void) | null = null
  private slicePlaneOverlay:  HTMLElement | null = null
  private slicePlanePreviewRaf: number | null = null
  // Per-mode preview hook, invoked rAF-collapsed whenever slicePlaneZ changes.
  private slicePreviewCallback: (() => void) | null = null
  // Drag handle for slice plane Z control
  private sliceDragHandle: THREE.Mesh | null = null
  private sliceDragActive = false
  private sliceDragLastY  = 0
  private sliceDragMoveHandler: ((e: PointerEvent) => void) | null = null
  private sliceDragUpHandler:   ((e: PointerEvent) => void) | null = null
  // B-rep section preview backend (enterBrepSectionMode)
  private brepSectionProvider:
    ((modelZ: number) => Promise<Array<{ points: Array<{ x: number; y: number }>; closed: boolean }>>) | null = null
  private brepSectionPartId:  string | null = null
  private brepSectionZOffset = 0            // world Z = model Z + part position.z
  private brepSectionSeq     = 0            // stale-response guard (render only the latest)
  private brepSectionThrottle: number | null = null   // trailing-edge throttle timer
  private brepSectionPreviewGroup: THREE.Group | null = null   // parented under the part group
  // B-rep WORLD-slice preview backend (enterBrepWorldSliceMode): like the brep
  // section preview but the loops come back already in WORLD XY and are drawn
  // world-baked into slicePlaneGroup (mirrors the STL slice preview path) at the
  // current world slice Z. Tilted parts allowed (no guard).
  private brepWorldSliceProvider:
    ((worldZ: number) => Promise<Array<{ points: Array<{ x: number; y: number }>; closed: boolean }>>) | null = null

  // ── Optimization preview ─────────────────────────────────────────────────
  private optimizationPreviewGroup:   THREE.Group | null = null
  private optimizationPreviewPartId:  string | null = null
  private optimizationPreviewInScene: boolean = false

  // ── Machine travel / grid ─────────────────────────────────────────────────
  private machineTravelBorderGroup: THREE.Group = new THREE.Group()
  private gridSpacing    = 25
  private machineTravelX = 800
  private machineTravelY = 600
  private machinePreviewFrame: ResolvedMachinePreviewCoordinateFrame['grid'] = null
  private setupSupportPlane = {
    origin: { x: 0, y: 0 },
    z: 0,
    label: 'Machine table | G54 Z+0',
  }

  // Drag detection (suppress deselect when dragging gizmo)
  private mouseDownPos = { x: 0, y: 0 }

  // Raycasting
  private raycaster = new THREE.Raycaster()
  private mouse = new THREE.Vector2()
  private selectableObjects: THREE.Object3D[] = []
  private onFaceSelect?: (faceId: string | null) => void

  // Toolpath role → scene object (for cheap visibility toggling without
  // re-render). For dashed+end-capped roles this is a Group holding the dashed
  // body line plus a solid-caps LineSegments; toggling the Group hides both.
  private toolpathRoleLines = new Map<string, THREE.Object3D>()
  private simulationToolpathRoleLines = new Map<string, THREE.Object3D>()
  private simulationToolpathPreviewActive = false
  private simulationWindowLines = new Map<string, THREE.LineSegments>()
  private simulationWindowActive = false
  private toolpathVisibleRequested = true
  private hiddenToolpathRoles = new Set<string>()

  /** Method-only legacy tests use Object.create(CNCViewport.prototype). */
  private getSimulationToolpathGroup(): THREE.Group {
    return this.simulationToolpathGroup
      ?? (this.simulationToolpathGroup = new THREE.Group())
  }

  private getSimulationToolpathRoleLines(): Map<string, THREE.Object3D> {
    return this.simulationToolpathRoleLines
      ?? (this.simulationToolpathRoleLines = new Map<string, THREE.Object3D>())
  }

  private isSimulationToolpathPreviewActive(): boolean {
    return this.simulationToolpathPreviewActive ?? false
  }

  private isToolpathVisibleRequested(): boolean {
    return this.toolpathVisibleRequested ?? true
  }

  private getHiddenToolpathRoles(): Set<string> {
    return this.hiddenToolpathRoles
      ?? (this.hiddenToolpathRoles = new Set<string>())
  }

  // WO-2048: per-role split of the static toolpath at the done/remaining
  // boundary. `dimmed` is created on first use and shares the body's position
  // buffer, so a boundary move is a draw-range change, never a rebuild.
  private toolpathDoneSplits = new Map<string, ToolpathDoneSplit>()
  private toolpathDoneBoundary: number | null = null

  private getToolpathDoneSplits(): Map<string, ToolpathDoneSplit> {
    return this.toolpathDoneSplits
      ?? (this.toolpathDoneSplits = new Map())
  }

  // PP-MOVE-PICK: the raycastable toolpath bodies (one THREE.LineSegments per
  // role), each carrying a ToolpathPickPayload in userData that maps a hit
  // segment back to its owning move. End-cap lines are deliberately NOT here
  // (they are cosmetic and do not correspond to moves).
  private toolpathPickBodies: THREE.LineSegments[] = []
  private moveSelectCallback?: (sel: SelectedMove | null) => void
  private moveHoverCallback?: (sel: SelectedMove | null, refused: boolean) => void
  private moveSelectOverlay: THREE.Object3D | null = null
  private moveHoverOverlay: THREE.Object3D | null = null
  private hoveredMoveKey: string | null = null
  private static readonly MOVE_PICK_TOLERANCE_PX = 8

  // Height planes and tool marker
  private heightPlanesGroup: THREE.Group = new THREE.Group()
  private toolMarkerGroup: THREE.Group | null = null
  /** Overlay line for the program move currently executing (Control tab). */
  private activeProgramSegment: THREE.Line | null = null

  // THE sketcher component (owns its own render layer, painting and pointer state).
  // Constructed in the ctor once renderer / camera / controls / container exist.
  private sketcher!: Sketcher

  // Stock removal simulation mesh
  private stockSimGroup:    THREE.Group | null = null
  private stockSimGeometry: THREE.BufferGeometry | null = null
  private stockSimSurfaceMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null
  private stockSimEdgeMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null
  /** User-requested Compare opacity. Display mode derives an effective alpha. */
  private stockSimOpacity = 1
  private stockSimNx = 0
  private stockSimNy = 0
  // Discontinuity-aware hybrid mesh state (see lib/viewport/stockSimMesh.ts).
  private stockSimLayout: StockSimLayout | null = null
  private stockSimThreshold = 0
  private stockSimTopVertCount = 0
  // Voxel stock-removal simulation (ADR-0028) — a PARALLEL render path to the
  // 2.5D heightmap stock sim above, selected behind SimulationPanel's engine flag.
  private voxelSimGroup:    THREE.Group | null = null
  private voxelSimTexture:  VoxelSimTexture | null = null
  private voxelSimMaterial: THREE.ShaderMaterial | null = null
  private voxelSimMesh:     THREE.Mesh | null = null
  private toolGeoConfig: ToolGeoCfg | null = null

  constructor(
    container: HTMLElement,
    onFaceSelect?: (faceId: string | null) => void,
    onPartTransformChange?: (
      id: string,
      pos: { x: number; y: number; z: number },
      rot: { x: number; y: number; z: number }
    ) => void,
    onPartSelect?: (id: string | null) => void,
    onStockSelect?: (id: string | null, assignmentPartId?: string | null) => void
  ) {
    this.container = container
    this.onFaceSelect = onFaceSelect
    this.onPartTransformChange = onPartTransformChange
    this.onPartSelect = onPartSelect
    this.onStockSelect = onStockSelect

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true })
    this.renderer.setPixelRatio(rendererDpr())
    this.renderer.shadowMap.enabled = true
    // PCFSoftShadowMap is deprecated in three r184: WebGLShadowMap warns and
    // coerces it to PCFShadowMap at render time. Set the replacement directly
    // (identical runtime behavior, no console warning). (B4)
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = MODELED_BODY_STUDIO_EXPOSURE
    this.renderer.setClearColor(asNumber('--vp-canvas'))
    container.appendChild(this.renderer.domElement)

    // Scene
    this.scene = new THREE.Scene()
    this.sectionCaps = createSectionCapController(this.scene)

    // Orthographic camera — Z-up CNC convention
    const initW = container.clientWidth || 800
    const initH = container.clientHeight || 600
    const initAspect = initW / initH
    this.camera = new THREE.OrthographicCamera(
      -this.frustumSize * initAspect / 2,
       this.frustumSize * initAspect / 2,
       this.frustumSize / 2,
      -this.frustumSize / 2,
      0.1,
      10000
    )
    this.camera.position.set(500, -400, 350)
    this.camera.up.set(0, 0, 1)

    // Orbit controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.06
    this.controls.rotateSpeed = 0.8
    this.controls.zoomSpeed = 1.2
    this.controls.panSpeed = 0.8
    this.controls.screenSpacePanning = true
    this.controls.minDistance = 5
    this.controls.maxDistance = 5000
    this.controls.target.set(0, 0, 0)
    this.navController = createNavPresetController(this.controls, this.renderer.domElement)
    // Apply the default navigation preset explicitly so the bare-button mapping
    // is the single source of truth from frame one. The React bridge re-applies
    // the persisted appSettings preset right after construction (Viewport.tsx).
    this.applyNavPreset('liencnc-default', false, false)

    // Persist the camera pose ~300ms after motion settles (refresh-restore). The
    // handler is null until the React bridge installs it, so the early default /
    // nav-preset 'change' fires during construction are ignored.
    this.controls.addEventListener('change', this.handleControlsChange)

    // Scene groups
    this.gridGroup = new THREE.Group()
    this.stockGroup = new THREE.Group()
    this.workpieceGroup = new THREE.Group()
    this.toolpathGroup = new THREE.Group()
    this.programFrameGroup = new THREE.Group()
    this.axesGroup = new THREE.Group()
    this.machineGroup = new THREE.Group()
    this.wcsGroup = new THREE.Group()
    this.programFrameGroup.add(this.toolpathGroup, this.simulationToolpathGroup, this.intendedStockGroup)

    this.scene.add(
      this.gridGroup,
      this.machineTravelBorderGroup,
      this.stockGroup,
      this.workpieceGroup,
      this.programFrameGroup,
      this.axesGroup,
      this.machineGroup,
      this.wcsGroup,
      this.faceHighlightGroup
    )
    this.scene.add(this.heightPlanesGroup)
    // Mount THE sketcher. It parents its own layer + overlay groups to the scene.
    this.sketcher = new Sketcher(this.createSketcherHost())

    this.setupLighting()
    this.buildGrid()
    this._buildMachineTravelBorder()
    this.buildWCSIndicator({ origin: { x: 0, y: 0, z: 0 }, label: 'G54' } as WCS)
    // WO-346: the colours above were just resolved against whatever theme is
    // active RIGHT NOW -- record it so syncThemeIfChanged()'s first tick sees
    // "unchanged" instead of re-running the same rebuild a second time.
    this.lastSeenThemeAttr = typeof document !== 'undefined' && document.documentElement
      ? `${document.documentElement.getAttribute('data-theme') ?? ''}|${document.documentElement.getAttribute('data-color-mode') ?? ''}`
      : null

    // Transform controls — handles for moving/rotating selected parts
    // In Three.js r184+ TransformControls extends Controls (not Object3D).
    // The renderable gizmo lives in _root; that's what must be added to the scene.
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement)
    this.transformControls.setSpace('world')
    // WO UI-74: the ONE named exclusion from the camera depth extent, marked at
    // the site that knows why (the shared seam from WO UI-72).
    //
    // three.js builds TransformControls out of pseudo-infinite helper geometry:
    // its X/Y/Z/AXIS guide lines measure a 1,000,000mm span and its picker plane
    // 100,000mm (measured on the live CAM scene -- see the census evidence).
    // Those are a rendering convenience, not content the user must see in full.
    // Feeding them to applyCameraDepthFit measures a ~1.8-million-mm slab, which
    // at 24-bit depth is ~0.1mm of z-resolution -- enough to bring back the
    // coplanar stock/part z-fight this viewport already fixed once (245da8c).
    //
    // This exempts the extent CONTRIBUTION only; the gizmo still renders and is
    // still clipped by the fitted slab exactly as it is clipped by today's
    // 0.1/10000 one, so its drawn handles -- which sit on the selected object,
    // and the selected object is IN the extent -- are unaffected.
    markDepthExtentExempt(this.tcRoot())
    this.scene.add(this.tcRoot())

    // Both listeners delegate to named methods so the transform behaviour is
    // reachable from tests without standing up a WebGL context.
    this.transformControls.addEventListener('change', () => {
      this.handleTransformControlsChange()
    })

    this.transformControls.addEventListener('dragging-changed', (event) => {
      this.handleTransformDraggingChanged(event as THREE.Event & { value: boolean })
    })
    window.addEventListener('keydown', this.handlePartMoveModifierKey)
    window.addEventListener('keyup', this.handlePartMoveModifierKey)
    window.addEventListener('blur', this.clearPartMoveModifier)

    const ro = new ResizeObserver(() => this.handleResize())
    ro.observe(container)
    this.stopObservingRendererDpr = observeRendererDpr(() => {
      this.renderer.setPixelRatio(rendererDpr())
      this.handleResize()
    })
    this.handleResize()

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown)
    this.renderer.domElement.addEventListener('click', this.handleClick)
    // PP-MOVE-PICK: always-on Toolpath-view move hover (see handleMoveHoverMove).
    this.renderer.domElement.addEventListener('mousemove', this.handleMoveHoverMove)

    // WO-286: the GEO-25 viewportTheme and GEO-26 selectionGlow uiPrefs
    // subscriptions used to sit here, waiting for a live Settings-modal
    // switch. WO-270 removed those controls, so nothing could ever change
    // either value and neither listener could fire. Both fields are now
    // initialized from their shipped constants at declaration.

    this.startRenderLoop()
  }

  private handleTransformControlsChange() {
    // Stock gizmo: the live box move is owned by setFixedStockPosition (driven
    // from the DesignTree onChange alongside the member-part sync), so the box,
    // its members and the gizmo handle all move in one place each frame. Just
    // skip the part-rebuild path here so a stock drag doesn't trigger it.
    if (this.stockGizmoSphere && this.stockGizmoId) return
    this.applyPartMoveOrthoLock()
    this.apply2DGizmoProxyDelta()
    // Part move: rebuild stock to track new bounds
    if (this.selectedPartId) this.rebuildStock()
  }

  private handleTransformDraggingChanged(event: THREE.Event & { value: boolean }) {
    // Disable orbit while dragging a handle so they don't fight
    const isDragging = event.value
    this.controls.enabled = !isDragging

    if (isDragging) {
      const axis = this.transformControls.axis
      const object = this.transformControls.object
      const isPlaneAxis = axis === 'XY' || axis === 'XZ' || axis === 'YZ' || axis === 'XYZ'
      if (
        this.selectedPartId
        && this.transformControls.mode === 'translate'
        && object
        && isPlaneAxis
      ) {
        object.updateWorldMatrix(true, false)
        this.partMovePlaneDrag = {
          object,
          plane: axis,
          startWorld: object.getWorldPosition(new THREE.Vector3()),
          lockedAxis: null,
        }
      } else {
        this.partMovePlaneDrag = null
      }
    }

    // Sync final position/rotation to the store when the drag ends (3D and 2D)
    if (!isDragging && this.selectedPartId) {
      // Apply the modifier once more before folding a proxy delta into the real
      // group. This covers a browser that coalesces the final change event.
      this.applyPartMoveOrthoLock()
      // The change event already applied every proxy delta. Apply once more
      // defensively so a browser that coalesces the final event cannot persist
      // the penultimate group transform. Idempotent: the delta cursor makes a
      // second call resolve to identity.
      this.apply2DGizmoProxyDelta()
      // Reads the REAL group, never the proxy -- all proxy motion has already
      // been folded into the group, so the store never sees a bounds-center
      // offset (this is what keeps the anchor fix from double-offsetting).
      const group = this.partGroups.get(this.selectedPartId)
        ?? this.geometry2dGroups.get(this.selectedPartId)
      if (group) {
        this.onPartTransformChange?.(
          this.selectedPartId,
          { x: group.position.x, y: group.position.y, z: group.position.z },
          {
            x: THREE.MathUtils.radToDeg(group.rotation.x),
            y: THREE.MathUtils.radToDeg(group.rotation.y),
            z: THREE.MathUtils.radToDeg(group.rotation.z),
          }
        )
      }
    }
    if (!isDragging) this.partMovePlaneDrag = null
  }

  /** Clamp only a selected PART's free/plane translation. Axis-handle moves,
   *  rotation, stock and WCS TransformControls ownership never create this
   *  drag state and therefore remain byte-for-byte on their existing paths. */
  private applyPartMoveOrthoLock() {
    const drag = this.partMovePlaneDrag
    if (!drag || !this.partMoveShiftHeld || this.transformControls.object !== drag.object) return

    drag.object.updateWorldMatrix(true, false)
    const currentWorld = drag.object.getWorldPosition(new THREE.Vector3())
    const resolved = resolvePartMoveOrthoLock(
      drag.startWorld,
      currentWorld,
      drag.plane,
      drag.lockedAxis,
    )
    drag.lockedAxis = resolved.lockedAxis
    if (resolved.lockedAxis === null) return

    const constrainedWorld = new THREE.Vector3(
      resolved.position.x,
      resolved.position.y,
      resolved.position.z,
    )
    if (drag.object.parent) {
      drag.object.parent.updateWorldMatrix(true, false)
      drag.object.position.copy(drag.object.parent.worldToLocal(constrainedWorld))
    } else {
      drag.object.position.copy(constrainedWorld)
    }
    drag.object.updateMatrixWorld(true)
  }

  private clear2DGizmoProxy() {
    const proxy = this.geometry2dGizmoProxy
    if (!proxy) return
    if (this.transformControls.object === proxy) this.transformControls.detach()
    this.scene.remove(proxy)
    this.geometry2dGizmoProxy = null
    this.geometry2dGizmoGroup = null
    this.geometry2dGizmoLastWorld.identity()
  }

  /** The modes that own `handleMouseMove` for face-overlay hovering and keep
   *  `faceOverlays` populated. Every site that used to spell the two out by
   *  hand now asks here, so WO-1587's seat pick is never accidentally left out
   *  of one of them (a missed site silently detaches the hover listener). */
  private inFaceOverlayMode() {
    return this.interactionMode === 'lay-on-face'
      || this.interactionMode === 'project-plane'
      || this.interactionMode === 'seat-face-pick'
  }

  /** TransformControls is exclusively owned: sketch, WCS and stock modes each
   *  take it outright, so a part gizmo must never acquire it behind their back. */
  private canAttachPartTransformGizmo() {
    return this.interactionMode === 'normal'
      && !this.inSketchView()
      && this.wcsGizmoSphere === null
      && this.stockGizmoSphere === null
  }

  /**
   * World-space center of a 2D group's EFFECTIVELY VISIBLE lines. Hidden layers
   * must not drag the anchor: set2DLayerVisible hides layers by MATERIAL
   * visibility, so both the ancestor `.visible` chain and the material flag are
   * checked. Falls back to the group's own world position when nothing is
   * visible, which degrades exactly to the pre-UI-75 behaviour.
   */
  private visible2DWorldCenter(group: THREE.Group) {
    group.updateWorldMatrix(true, true)
    const bounds = new THREE.Box3()
    group.traverse((child) => {
      if (!(child instanceof THREE.Line)) return
      let current: THREE.Object3D | null = child
      while (current) {
        if (!current.visible) return
        if (current === group) break
        current = current.parent
      }
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      if (!materials.some((material) => material.visible)) return
      child.geometry.computeBoundingBox()
      if (child.geometry.boundingBox) {
        bounds.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld))
      }
    })
    return bounds.isEmpty()
      ? group.getWorldPosition(new THREE.Vector3())
      : bounds.getCenter(new THREE.Vector3())
  }

  /**
   * World-space pivot of a 3D group's VISIBLE meshes: xy bounds centre at the
   * bounds' BOTTOM z -- the exact convention addSTL bakes into recentred
   * groups, so a proxied part and an STL part pivot identically. Hidden meshes
   * (setSTLVisible) must not drag the pivot. Falls back to the group's own
   * world position when nothing is visible, the same documented degrade as
   * visible2DWorldCenter (there is no computable pivot to prefer over it).
   */
  private visible3DWorldPivot(group: THREE.Group) {
    group.updateWorldMatrix(true, true)
    const bounds = new THREE.Box3()
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      let current: THREE.Object3D | null = child
      while (current) {
        if (!current.visible) return
        if (current === group) break
        current = current.parent
      }
      child.geometry.computeBoundingBox()
      if (child.geometry.boundingBox) {
        bounds.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld))
      }
    })
    if (bounds.isEmpty()) return group.getWorldPosition(new THREE.Vector3())
    const center = bounds.getCenter(new THREE.Vector3())
    return new THREE.Vector3(center.x, center.y, bounds.min.z)
  }

  /** Rendered pivot for the proxy: 3D part groups (registered in partGroups
   *  under their own name) use the mesh seat-point; 2D groups use the visible
   *  line centre. */
  private gizmoProxyPivot(group: THREE.Group) {
    return this.partGroups.get(group.name) === group
      ? this.visible3DWorldPivot(group)
      : this.visible2DWorldCenter(group)
  }

  /** Attach a transient scene-root object at the group's rendered pivot. */
  private attach2DGizmoProxy(group: THREE.Group) {
    this.clear2DGizmoProxy()
    const center = this.gizmoProxyPivot(group)
    const proxy = new THREE.Object3D()
    proxy.name = '__geometry_2d_gizmo_pivot__'
    proxy.position.copy(center)
    group.getWorldQuaternion(proxy.quaternion)
    this.scene.add(proxy)
    proxy.updateMatrixWorld(true)

    this.geometry2dGizmoProxy = proxy
    this.geometry2dGizmoGroup = group
    this.geometry2dGizmoLastWorld.copy(proxy.matrixWorld)
    this.transformControls.attach(proxy)
  }

  /**
   * Apply the proxy's world-space movement to the real 2D group. Pre-multiplying
   * by the proxy delta makes rotation occur around the visible bounds center.
   * The delta is measured against a cursor (geometry2dGizmoLastWorld) that is
   * re-seeded on every apply, so repeated calls are idempotent rather than
   * cumulative.
   */
  private apply2DGizmoProxyDelta() {
    const proxy = this.geometry2dGizmoProxy
    const group = this.geometry2dGizmoGroup
    if (!proxy || !group || this.transformControls.object !== proxy) return

    proxy.updateWorldMatrix(true, false)
    group.updateWorldMatrix(true, false)
    const delta = proxy.matrixWorld.clone().multiply(
      this.geometry2dGizmoLastWorld.clone().invert(),
    )
    const nextWorld = delta.multiply(group.matrixWorld.clone())
    const nextLocal = group.parent
      ? group.parent.matrixWorld.clone().invert().multiply(nextWorld)
      : nextWorld
    nextLocal.decompose(group.position, group.quaternion, group.scale)
    group.updateMatrixWorld(true)
    this.geometry2dGizmoLastWorld.copy(proxy.matrixWorld)
  }

  /** Re-center an already-attached proxy after a typed transform or a
   *  structural/visibility change to the geometry under it. */
  private sync2DGizmoProxyToGroup(group: THREE.Group) {
    if (this.geometry2dGizmoGroup !== group || !this.geometry2dGizmoProxy) return
    const proxy = this.geometry2dGizmoProxy
    proxy.position.copy(this.gizmoProxyPivot(group))
    group.getWorldQuaternion(proxy.quaternion)
    proxy.updateMatrixWorld(true)
    this.geometry2dGizmoLastWorld.copy(proxy.matrixWorld)
  }

  /** Drop the 2D proxy for a mode that owns TransformControls, KEEPING
   *  selectedPartId so the mode's exit can restore it. 3D direct attachment is
   *  deliberately left alone. */
  private suspend2DGizmoForExclusiveMode() {
    if (this.selectedPartId && this.geometry2dGroups.has(this.selectedPartId)) {
      this.transformControls.detach()
      this.clear2DGizmoProxy()
    }
  }

  private restore2DGizmoAfterExclusiveMode() {
    if (!this.selectedPartId || !this.canAttachPartTransformGizmo()) return
    const group = this.geometry2dGroups.get(this.selectedPartId)
    if (group) this.attach2DGizmoProxy(group)
  }

  /**
   * Restore a project selection after an async scene rebuild without stealing
   * TransformControls from an exclusive interaction that began while loading.
   * Returns whether the selection was actually restored -- callers must not
   * assume it was (an unnamed else is where fail-open lives).
   */
  restoreSelectedPartAfterSceneRestore(id: string | null): boolean {
    if (!id || !this.canAttachPartTransformGizmo()) return false
    if (!this.partGroups.has(id) && !this.geometry2dGroups.has(id)) return false
    this.setSelectedPart(id)
    return this.selectedPartId === id
  }

  // ---- Navigation preset ----
  /**
   * Apply a bare-button navigation preset to the live OrbitControls by setting
   * `.mouseButtons` and `.touches`. Safe to call any time (runtime remap, no
   * re-instantiation). Deliberately does NOT touch `controls.enableRotate` or
   * `controls.enabled`, so it composes with:
   *   - sketch mode (which independently sets enableRotate=false on enter and
   *     restores it on exit) — a re-apply here preserves that flag, and
   *     enableRotate=false still suppresses the rotate button regardless of
   *     which button maps to ROTATE;
   *   - TransformControls gizmo drags (which toggle controls.enabled during a
   *     drag) — untouched, so gizmo drags keep capturing the pointer;
   *   - LEFT-click selection raycasting (separate pointerdown/click listeners).
   *
   * invertZoom / invertPan flip the zoom/pan DIRECTION. Delegates to the
   * shared navPresetController.ts engine (BK-26) -- see that module for the
   * mapping/remap/invert mechanics, shared byte-for-byte with the model3d
   * sketch scene runtime.
   */
  applyNavPreset(
    presetId: NavPresetId,
    invertZoom: boolean,
    invertPan: boolean,
  ): void {
    this.navController.apply(presetId, invertZoom, invertPan)
  }

  // ---- Lighting ----
  private setupLighting() {
    // GEO-23 L1: image-based-lighting base. RoomEnvironment baked to a PMREM cube
    // becomes scene.environment, so every MeshStandardMaterial body/stock samples
    // real irradiance from EVERY direction -- orbit under the part and the bottom
    // face is lit "from the space" (Operator's ask), never the near-black an all-above
    // rig left it. scene.background (the dark --vp-canvas clear) is untouched.
    this.viewportEnvironment = installViewportEnvironment(
      this.renderer,
      this.scene,
      MODELED_BODY_STUDIO_ENV_INTENSITY,
    )

    // The studio rig stays fixed in world space. The camera moves through it,
    // so highlights travel across the part rather than following the view.
    const bodyStudioRig = buildModeledBodyStudioRig()
    this.scene.add(bodyStudioRig.hemisphere, ...bodyStudioRig.accents)
    for (let i = 0; i < bodyStudioRig.accents.length; i++) {
      const desc = CAM_ACCENT_LIGHTS[i]
      const light = bodyStudioRig.accents[i]
      // The key light keeps its shadow map (CAM renders stock and wants that
      // realism; unchanged from the pre-GEO-23 rig).
      if (desc.role === 'key') {
        light.castShadow = true
        light.shadow.mapSize.setScalar(2048)
        light.shadow.camera.near = 0.5
        light.shadow.camera.far = 3000
        light.shadow.camera.left = -600
        light.shadow.camera.right = 600
        light.shadow.camera.top = 600
        light.shadow.camera.bottom = -600
      }
    }
  }

  // ---- Grid ----
  private buildGrid() {
    this.gridGroup.clear()
    if (this.machinePreviewFrame) {
      this.gridGroup.position.set(0, 0, 0)
      const frame = this.machinePreviewFrame
      const minor: number[] = []
      const accent: number[] = []
      const append = (target: number[], ax: number, ay: number, bx: number, by: number) => {
        target.push(ax, ay, frame.z, bx, by, frame.z)
      }
      for (const line of machinePreviewGridAxisCoordinates(
        frame.minX,
        frame.maxX,
        frame.originMachine.x,
        this.gridSpacing,
      )) {
        append(line.accent ? accent : minor, line.coordinate, frame.minY, line.coordinate, frame.maxY)
      }
      for (const line of machinePreviewGridAxisCoordinates(
        frame.minY,
        frame.maxY,
        frame.originMachine.y,
        this.gridSpacing,
      )) {
        append(line.accent ? accent : minor, frame.minX, line.coordinate, frame.maxX, line.coordinate)
      }
      const addLines = (positions: number[], color: number) => {
        if (positions.length === 0) return
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        this.gridGroup.add(new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.72 }),
        ))
      }
      addLines(minor, asNumber('--vp-grid'))
      addLines(accent, asNumber('--vp-grid-accent'))
      return
    }
    const size = Math.max(this.machineTravelX, this.machineTravelY)
    // gridSpacing is canonical mm. The grid-spacing INPUT is unit-aware
    // (ADR-0022): in inch mode the user types inches, converted to mm before it
    // reaches the store, so honoring gridSpacing here works in both units and
    // the value drives the grid. (Supersedes the Phase-2d fixed-25.4 approach,
    // which ignored the user's value in inch mode.)
    const divisions = Math.max(2, Math.round(size / this.gridSpacing))
    const grid = new THREE.GridHelper(size, divisions, asNumber('--vp-grid-accent'), asNumber('--vp-grid'))
    grid.rotation.x = Math.PI / 2
    this.gridGroup.add(grid)
    const supportPlane = this.setupSupportPlane ?? {
      origin: { x: 0, y: 0 },
      z: 0,
      label: 'Machine table | G54 Z+0',
    }
    // WO-1949/WO-1955: the grid IS the machine table, centred like the travel
    // border. It never moves in X, Y or Z; the support plane is stored data only.
    this.gridGroup.position.set(0, 0, 0)
    this.gridGroup.userData.setupSupportPlane = { ...supportPlane }
  }

  /** Raise/lower only the CAM reference grid (X/Y stay on the table, WO-1949). Stock, parts, WCS, and toolpaths stay put. */
  setSetupSupportPlane(input: {
    origin: { x: number; y: number }
    z: number
    label: string
    resolved: boolean
  } | null) {
    // An unresolved named plane has no authoritative transform. Keep the last
    // valid grid position instead of fabricating machine-table Z plus offset.
    if (input && !input.resolved) return
    this.setupSupportPlane = input && Number.isFinite(input.origin.x)
      && Number.isFinite(input.origin.y) && Number.isFinite(input.z)
      ? { origin: { ...input.origin }, z: input.z, label: input.label }
      : { origin: { x: 0, y: 0 }, z: 0, label: 'Machine table | no active WCS' }
    if (!this.machinePreviewFrame) this.buildGrid()
  }

  setGridSpacing(spacing: number) {
    this.gridSpacing = Math.max(1, spacing)
    this.buildGrid()
  }

  setMachineTravel(travel: { x: number; y: number; z: number }) {
    this.machineTravelX = travel.x
    this.machineTravelY = travel.y
    this.buildGrid()
    this._buildMachineTravelBorder()
  }

  private _buildMachineTravelBorder() {
    this.machineTravelBorderGroup.clear()
    const frame = this.machinePreviewFrame
    const minX = frame?.minX ?? -this.machineTravelX / 2
    const maxX = frame?.maxX ?? this.machineTravelX / 2
    const minY = frame?.minY ?? -this.machineTravelY / 2
    const maxY = frame?.maxY ?? this.machineTravelY / 2
    const z = (frame?.z ?? 0) + 0.3
    const pts = [
      new THREE.Vector3(minX, minY, z),
      new THREE.Vector3(maxX, minY, z),
      new THREE.Vector3(maxX, maxY, z),
      new THREE.Vector3(minX, maxY, z),
      new THREE.Vector3(minX, minY, z),
    ]
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const mat = new THREE.LineDashedMaterial({ color: asNumber('--vp-machine-border'), dashSize: 12, gapSize: 6 })
    const line = new THREE.Line(geo, mat)
    line.computeLineDistances()
    this.machineTravelBorderGroup.add(line)
  }

  /**
   * Configure the Control-tab coordinate display without changing the generic
   * CAM viewport defaults. Program geometry, the live cutter, and its active
   * segment are children of programFrameGroup, so this is their one shared
   * work-to-machine transform. A null/invalid grid hides both grid and origin.
   */
  setMachinePreviewCoordinateFrame(input: MachinePreviewCoordinateFrameInput) {
    const resolved = resolveMachinePreviewCoordinateFrame(input)
    this.programFrameGroup.position.set(
      resolved.programTranslation.x,
      resolved.programTranslation.y,
      resolved.programTranslation.z,
    )
    this.programFrameGroup.updateMatrixWorld(true)
    this.machinePreviewFrame = resolved.grid
    if (!resolved.grid) {
      this.gridGroup.clear()
      this.machineTravelBorderGroup.clear()
      this.wcsGroup.clear()
      this.gridGroup.visible = false
      this.machineTravelBorderGroup.visible = false
      this.wcsGroup.visible = false
      return
    }
    this.machineTravelX = resolved.grid.maxX - resolved.grid.minX
    this.machineTravelY = resolved.grid.maxY - resolved.grid.minY
    this.buildGrid()
    this._buildMachineTravelBorder()
    this.buildWCSIndicator({ origin: resolved.grid.originMachine })
    this.gridGroup.visible = true
    this.machineTravelBorderGroup.visible = true
    this.wcsGroup.visible = true
  }

  /**
   * WO-380: draw (or clear) the stock block the loaded setup was planned
   * against. The box is a child of programFrameGroup, so it is expressed in the
   * program's own work coordinates and follows the active-WCS translation
   * exactly like the parsed path and the live cutter. Purely advisory scenery:
   * it is not pickable, casts no shadow, writes no depth (the toolpath stays
   * visible through it), and is never read back by anything.
   *
   * Styling is token-driven through viewportColors (the sanctioned CSS<->THREE
   * seam): current = --vp-stock fill / --vp-stock-edge solid edges (the app's
   * own stock language, theme-aware); stale = --accent-amber fill / DASHED
   * --accent-amber edges, so staleness is carried by line style as well as hue.
   */
  setIntendedStock(box: IntendedStockBox | null) {
    for (const child of this.intendedStockGroup.children) {
      const drawable = child as THREE.Mesh | THREE.LineSegments
      drawable.geometry?.dispose?.()
      const material = drawable.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose?.()
    }
    this.intendedStockGroup.clear()
    if (!box) return
    const sx = box.max.x - box.min.x
    const sy = box.max.y - box.min.y
    const sz = box.max.z - box.min.z
    if (!(sx > 0) || !(sy > 0) || !(sz > 0)) return
    const fillToken = box.stale ? '--accent-amber' : '--vp-stock'
    const edgeToken = box.stale ? '--accent-amber' : '--vp-stock-edge'
    const geo = new THREE.BoxGeometry(sx, sy, sz)
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: asNumber(fillToken),
        transparent: true,
        opacity: box.stale ? 0.14 : 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    mesh.position.set(box.min.x + sx / 2, box.min.y + sy / 2, box.min.z + sz / 2)
    mesh.renderOrder = -1 // behind the path and the live cutter
    mesh.name = 'intended-stock-fill'
    const edgeGeo = new THREE.EdgesGeometry(geo)
    const edgeMat = box.stale
      ? new THREE.LineDashedMaterial({ color: asNumber(edgeToken), dashSize: 4, gapSize: 3 })
      : new THREE.LineBasicMaterial({ color: asNumber(edgeToken) })
    const edges = new THREE.LineSegments(edgeGeo, edgeMat)
    edges.position.copy(mesh.position)
    if (box.stale) edges.computeLineDistances()
    edges.name = 'intended-stock-edges'
    this.intendedStockGroup.add(mesh, edges)
  }

  // ---- WCS Indicator ----
  buildWCSIndicator(wcs: Partial<WCS>) {
    this.wcsGroup.clear()
    const origin = wcs.origin ?? { x: 0, y: 0, z: 0 }
    const pos = new THREE.Vector3(origin.x, origin.y, origin.z)
    const len = 30

    const axes = [
      { dir: new THREE.Vector3(1, 0, 0), color: asNumber('--vp-axis-x') },
      { dir: new THREE.Vector3(0, 1, 0), color: asNumber('--vp-axis-y') },
      { dir: new THREE.Vector3(0, 0, 1), color: asNumber('--vp-axis-z') },
    ]

    axes.forEach(({ dir, color }) => {
      const arrow = new THREE.ArrowHelper(dir, pos, len, color, len * 0.2, len * 0.1)
      ;(arrow.line.material as THREE.LineBasicMaterial).depthTest = false
      ;(arrow.cone.material as THREE.MeshBasicMaterial).depthTest = false
      arrow.renderOrder = 999
      this.wcsGroup.add(arrow)
    })

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(WCS_ORIGIN_RADIUS, 12, 8),
      new THREE.MeshStandardMaterial({
        color: asNumber('--vp-wcs-origin'),
        emissive: asNumber('--vp-wcs-origin'),
        emissiveIntensity: 0.4,
        depthTest: false,
      })
    )
    sphere.renderOrder = 998
    sphere.position.copy(pos)
    this.wcsGroup.add(sphere)
  }

  // ---- Stock Box (private, driven by rebuildStock) ----
  // `stockId` + `movable` tag the group and its meshes via userData so the
  // viewport click handler can pick them. Only FIXED stocks are movable; auto
  // stocks pass movable=false and stay non-pickable (they have no position to
  // move). The group name is set to the stock id so findPartId-style ancestor
  // walks can be mirrored for stock.
  // Renderer drawing-buffer size in DEVICE pixels (clientW*dpr), used to size
  // the fat-line stock edges' LineMaterial.resolution. Defensive against
  // headless test mocks that build a partial viewport without a real renderer
  // or container — falls back to a sane non-zero default so buildStockBox never
  // throws (the stroke width is only meaningful when actually rendered).
  private drawingBufferResolution(): THREE.Vector2 {
    const dpr = this.renderer?.getPixelRatio?.() ?? 1
    const w = (this.container?.clientWidth || 1) * dpr
    const h = (this.container?.clientHeight || 1) * dpr
    return new THREE.Vector2(w, h)
  }

  private buildStockBox(
    stock: { width: number; height: number; depth: number },
    origin: THREE.Vector3,
    stockId: string,
    movable: boolean
  ): THREE.Group {
    const { width, height, depth } = stock

    const geo = new THREE.BoxGeometry(width, height, depth)

    // Stock edges are drawn as three's fat-line addon (LineSegments2) rather
    // than THREE.LineSegments. 1px LineBasicMaterial lines crawl/alias under
    // sub-pixel camera motion (a measured frame-diff isolated the shimmer to
    // these wireframe edges); fat lines render as camera-facing quads that MSAA
    // can anti-alias. LineMaterial sizes its stroke in SCREEN PIXELS, so its
    // `resolution` must track the renderer drawing-buffer size in DEVICE pixels
    // (clientW*dpr) — set here and kept in sync by handleResize.
    const edges = new THREE.EdgesGeometry(geo)
    const lineGeo = new LineSegmentsGeometry()
    lineGeo.setPositions(Array.from(edges.attributes.position.array as Float32Array))
    edges.dispose()
    const lineMat = new LineMaterial({
      color: asNumber('--vp-stock-edge'),
      // 2.0px (approved visually). A wider AA stroke keeps full-strength pixels
      // in its core so only the soft fringe shifts under sub-pixel motion, which
      // suppresses the perceived crawl far better than a 1px line — the opposite
      // of what the raw frame-diff metric suggests (that metric is coverage-
      // confounded: wider strokes touch more pixels and inflate the diff even as
      // they look more stable). Width chosen by eye, not by the scalar.
      linewidth: 2.0,            // in pixels (worldUnits:false)
      worldUnits: false,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    })
    const res = this.drawingBufferResolution()
    lineMat.resolution.set(res.x, res.y)
    const wireframe = new LineSegments2(lineGeo, lineMat)
    wireframe.userData.isDisplayEdge = true   // toggled by shading mode

    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: asNumber('--vp-stock'),
        transparent: true,
        opacity: 0.12,
        side: THREE.FrontSide,
        depthWrite: false,
        // A tight auto-stock's top face is COPLANAR (same Z) with the opaque
        // part's top face. The part writes depth; this translucent fill does
        // not -- so at the shared plane the depth test is ambiguous per pixel,
        // and because the part top is fan-tessellated into slivers the stock
        // tint resolves on/off along that fan = radial "shimmer" streaks on the
        // part (only when stock is visible; gone in translucent view because the
        // part stops writing depth). polygonOffset nudges the fill's tested depth
        // AWAY from the camera so it loses the tie over the part top and no
        // longer tints/fights it. Verified on real GPU (factor/units 1 suffice;
        // the box volume + crisp edges are visually unchanged).
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
    )

    const group = new THREE.Group()
    group.add(wireframe, fill)
    group.position.set(origin.x + width / 2, origin.y + height / 2, origin.z + depth / 2)
    group.name = stockId
    const tag = { kind: 'stock' as const, stockId, movable }
    group.userData = { ...group.userData, ...tag }
    wireframe.userData = { ...wireframe.userData, ...tag }
    fill.userData = { ...fill.userData, ...tag }
    this.stockGroup.add(group)
    return group
  }

  // ---- Rebuild stock from current parts + config ----
  rebuildStock(config?: SceneStock) {
    if (config) this.currentStockConfig = { ...config }

    this.stockGroup.clear()
    // fixedStockBoxes is the id->box map getStockBounds(id) resolves. Both the
    // fixed blocks AND the named auto stocks register here, so clear it once up
    // front (was previously cleared only inside the fixed branch).
    this.fixedStockBoxes.clear()

    const cfg = this.currentStockConfig

    // Multi-stock model: a project ALWAYS carries >=1 named auto stock (the
    // default, id === DERIVED_STOCK_ID) plus any user-added auto/fixed stocks.
    // The viewport renders ONLY those NAMED stocks; it no longer branches on
    // cfg.mode and no longer synthesizes a union box or an implicit fixed
    // default block (both produced a double-render now that the default auto
    // stock always exists). cfg.mode is still read by SetupModal /
    // reanchorProjectionLayers / dispatchGeo — only the viewport stopped
    // branching on it. The first rendered stock origin anchors the WCS marker.
    let wcsOrigin: { x: number; y: number; z: number } | null = null

    // Named AUTO stocks (member-derived). Each AutoStockItem has a twin
    // mode:'derived' PhysicalStock (id === auto id) in project.stocks whose
    // `bounds` the store has already sized to its member geometry
    // (geometry.stockId === auto id). We read those member-derived bounds rather
    // than re-deriving here because the viewport's partGroups don't carry stock
    // membership. A brand-new auto stock with no members has a ZERO-volume
    // bounds box (min === max) — skip it so we never draw a degenerate box.
    const autoStocks = cfg.autoStocks ?? []
    if (autoStocks.length > 0) {
      const physical = useCamStore.getState().project.stocks ?? []
      for (const auto of autoStocks) {
        const twin = physical.find((s) => s.id === auto.id)
        if (!twin) continue
        const { min, max } = twin.bounds
        const width  = max.x - min.x
        const height = max.y - min.y
        const depth  = max.z - min.z
        // Zero-volume (no members yet) -> don't draw a degenerate box.
        if (width <= 0 || height <= 0 || depth <= 0) continue
        const group = this.buildStockBox(
          { width, height, depth },
          new THREE.Vector3(min.x, min.y, min.z),
          auto.id,
          false,   // AUTO stock: not movable -> not pickable
        )
        this.fixedStockBoxes.set(auto.id, group)
        if (!wcsOrigin) wcsOrigin = { x: min.x, y: min.y, z: min.z }
      }
    }

    // Named FIXED stock blocks.
    const fixedStocks = cfg.fixedStocks ?? []
    for (const stock of fixedStocks) {
      const origin = new THREE.Vector3(stock.position.x, stock.position.y, stock.position.z)
      const group = this.buildStockBox(
        { width: stock.width, height: stock.height, depth: stock.depth },
        origin,
        stock.id,
        true,   // FIXED stock: movable -> pickable
      )
      this.fixedStockBoxes.set(stock.id, group)
      if (!wcsOrigin) wcsOrigin = { x: stock.position.x, y: stock.position.y, z: stock.position.z }
    }

    if (!this.wcsFixed && wcsOrigin) {
      this.buildWCSIndicator({ origin: wcsOrigin, label: 'G54' })
    }

    // Track stock bounding box for face-plane projection overlays
    const sb = new THREE.Box3().setFromObject(this.stockGroup)
    this._stockBounds = sb.isEmpty() ? null : { min: sb.min.clone(), max: sb.max.clone() }

    // Re-register selectable objects so FIXED stock boxes become pickable on
    // rebuild (auto boxes are tagged movable:false and stay out).
    this.updateSelectableObjects()

    // Re-apply the active shading mode so freshly built stock boxes AND parts adopt
    // it and capture their pristine baseline. addSTL / addBrepModel both call
    // rebuildStock at their tail, so this one call covers all three build paths.
    // Default mode = baseline restore = visual no-op, so this is safe by default.
    this.applyShadingMode()
  }

  // ---- GEO-25: viewport display theme (Q-50) ----
  //
  // Resolve the current theme through the one CAM/Model body style. Themes
  // choose body paint; display mode chooses the topology renderer.
  // WO-1573: a body marked workholding (a vise, clamp or fixture) always
  // paints this fixed muted steel-gray, regardless of the active viewport
  // display theme or any custom per-part color -- so it reads as fixture
  // hardware, distinct from any part or stock tint, in every theme. A literal
  // (not a CSS token/fallback pair): tokens.css and viewportColors.ts sit
  // outside this WO's owned paths.
  private static readonly WORKHOLDING_BODY_HEX = '#6e7480'

  private isPartWorkholding(id: string): boolean {
    return isWorkholdingGeometry(useCamStore.getState().project.geometry.find((g) => g.id === id))
  }

  // WO-1573: live-recolor an existing part when its workholding mark toggles
  // (Properties checkbox), without a full re-add. Mirrors setPartColor but
  // restores the correct non-workholding color (a custom color, else the
  // current theme default) when the mark comes off.
  setPartWorkholding(id: string, workholding: boolean, fallbackColor?: string) {
    const hex = workholding
      ? CNCViewport.WORKHOLDING_BODY_HEX
      : (fallbackColor ?? this.resolvePartTheme().bodyHex)
    this.setPartColor(id, hex)
    this.partUsesThemeColor.set(id, !workholding && fallbackColor === undefined)
  }

  private resolvePartTheme(): ModeledBodyVisualStyle {
    // Defensive fallback to classic: a couple of the lib/CNCViewport tests
    // build a bare harness via `Object.create(CNCViewport.prototype)` to
    // avoid running the real (DOM/WebGL-heavy) constructor, which means
    // `viewportThemeId`'s field initializer never runs and the field reads
    // `undefined` on those harnesses -- degrade to the exact pre-existing
    // classic behavior rather than throwing, the same way any other
    // uninitialized-field harness gap would (this is a test-scaffolding
    // affordance, never reachable via the real constructor).
    const id = this.viewportThemeId
    return resolveModeledBodyVisualStyle(isViewportThemeId(id) ? id : 'classic')
  }

  private applyCurrentSectionClipping(material: THREE.Material): void {
    const renderer = this.renderer as THREE.WebGLRenderer | undefined
    const clipPlane = this.clipPlane as THREE.Plane | undefined
    material.clippingPlanes = renderer?.localClippingEnabled === true && clipPlane !== undefined
      ? [clipPlane]
      : []
    material.clipShadows = true
    material.needsUpdate = true
  }

  private applyCurrentSectionClippingToObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      const material = (child as THREE.Object3D & {
        material?: THREE.Material | THREE.Material[]
      }).material
      if (Array.isArray(material)) {
        for (const item of material) this.applyCurrentSectionClipping(item)
      } else if (material !== undefined) {
        this.applyCurrentSectionClipping(material)
      }
    })
  }

  // Builds one part's resting topology from raw polyline positions using the
  // shared display-mode contract: native depth-tested lines for shaded and
  // translucent bodies, screen-space fat lines for topology-only wireframe.
  // B-rep Stage-2 picking retains its separate always-native pick twin.
  private buildPartEdgeOverlay(
    positions: Float32Array,
  ): THREE.LineSegments {
    const edgeGeometry = new THREE.BufferGeometry()
    edgeGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return this.buildPartEdgeOverlayFromGeometry(edgeGeometry)
  }

  private buildPartEdgeOverlayFromGeometry(
    edgeGeometry: THREE.BufferGeometry,
  ): THREE.LineSegments {
    const themeId = isViewportThemeId(this.viewportThemeId) ? this.viewportThemeId : 'classic'
    const useFat = modeledBodyEdgeUsesFatLines(this.currentShadingMode)
    let resolution: { width: number; height: number } | undefined
    if (useFat) {
      const rect = this.renderer.domElement.getBoundingClientRect()
      const dpr = this.renderer.getPixelRatio()
      resolution = {
        width: Math.max(1, rect.width) * dpr,
        height: Math.max(1, rect.height) * dpr,
      }
    }
    const edges = createBodyEdgeOverlay(edgeGeometry, {
      ...modeledBodyEdgeOverlayOptions(themeId, {
        resolution,
        ownsGeometry: true,
        userData: { isDisplayEdge: true },
      }, this.currentShadingMode),
      ownsGeometry: true,
    })
    this.applyCurrentSectionClippingToObject(edges)
    // Fat-line construction copies positions into LineSegmentsGeometry; the
    // temporary source geometry is not scene-owned in that branch.
    if (edges.geometry !== edgeGeometry) edgeGeometry.dispose()
    return edges
  }

  /** Locate only the closed modeled body inside a part transform root. CAM
   * overlays, toolpaths, stock simulation and 2D aids remain outside this
   * contract and must never become stencil-cap contributors. */
  private bodyMeshForGroup(group: THREE.Group): THREE.Mesh | null {
    const mesh = group.children.find(
      (child) => child instanceof THREE.Mesh
        && child.userData.isBodyEdgeOverlay !== true
        && (child.userData.isBodyPresentationMesh === true
          || child.userData.isBrepMesh === true
          || child.userData.isModelBodyMesh === true),
    ) as THREE.Mesh | undefined
    return mesh ?? null
  }

  /** Locate the closed modeled body plus its cosmetic edge presentation. */
  private bodyPresentationForGroup(group: THREE.Group): BodyPresentationPair | null {
    const mesh = this.bodyMeshForGroup(group)
    if (mesh === null) return null
    const edgeLines = mesh.children.find(
      (child) => child.userData.isDisplayEdge === true,
    ) as THREE.LineSegments | undefined
    return edgeLines === undefined ? null : { mesh, edgeLines }
  }

  private registerPartSectionCap(group: THREE.Group): void {
    const mesh = this.bodyMeshForGroup(group)
    if (mesh === null) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    this.sectionCaps?.register(mesh, materials)
    this.syncPartSectionCapVisibility(mesh)
  }

  private syncPartSectionCapVisibility(mesh: THREE.Mesh): void {
    const workpieceVisible = this.workpieceGroup?.visible ?? true
    this.sectionCaps?.setVisible(mesh, workpieceVisible && mesh.visible)
  }

  private syncAllPartSectionCapVisibility(): void {
    for (const group of this.partGroups.values()) {
      const mesh = this.bodyMeshForGroup(group)
      if (mesh !== null) this.syncPartSectionCapVisibility(mesh)
    }
  }

  /** Dispose only body-owned render resources. The STEP native pick twin is
   * retained while the body is live; the optional wireframe overlay is a
   * separate child with its own disposal path. */
  private disposePartBodyPresentation(group: THREE.Group): void {
    const mesh = this.bodyMeshForGroup(group)
    if (mesh === null) return
    this.sectionCaps?.unregister(mesh)
    const interactionOutlines = this.getPartInteractionOutlines()
    const interactionOutline = interactionOutlines.get(group.name)
    if (interactionOutline !== undefined) {
      disposeInteractionOverlay(interactionOutline)
      interactionOutlines.delete(group.name)
    }
    this.getPartSelectedMaterialStates().delete(group.name)

    const presentation = this.bodyPresentationForGroup(group)
    const displayEdge = presentation?.edgeLines
    for (const child of [...mesh.children]) {
      if (child === displayEdge) continue
      const renderable = child as THREE.Object3D & {
        geometry?: THREE.BufferGeometry
        material?: THREE.Material | THREE.Material[]
      }
      renderable.geometry?.dispose()
      const materials = renderable.material === undefined
        ? []
        : (Array.isArray(renderable.material) ? renderable.material : [renderable.material])
      for (const material of materials) material.dispose()
      child.removeFromParent()
    }

    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of meshMaterials) {
      if (material instanceof THREE.MeshStandardMaterial) this.materialBaselines?.delete(material)
    }
    if (presentation !== null) {
      disposeBodyPresentation(presentation, {
        disposeMeshGeometry: true,
        disposeMeshMaterial: true,
        disposeEdgeGeometry: true,
        disposeEdgeMaterial: true,
      })
      return
    }
    mesh.geometry.dispose()
    for (const material of meshMaterials) material.dispose()
    mesh.removeFromParent()
  }

  /** GEO-25: immediate-apply theme switch. Re-tints every part still on the
   *  theme default (never one with an explicit per-part appearance override).
   *  Renderer selection is display-mode driven, so a theme switch normally
   *  recolors the existing topology object in place. WO-286: the removed
   *  Settings control's uiPrefs subscription was this method's only caller in
   *  the app; it stays public for its direct callers (tests / non-store
   *  callers), which is why the re-tint path is still live code. */
  setViewportTheme(id: ViewportThemeId): void {
    if (this.viewportThemeId === id) return
    this.viewportThemeId = id
    const theme = this.resolvePartTheme()
    for (const [partId, group] of this.partGroups) {
      if (this.partUsesThemeColor.get(partId) !== true) continue
      const mesh = group.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh | undefined
      if (mesh === undefined) continue
      const material = mesh.material as THREE.MeshStandardMaterial
      const selectedState = this.getPartSelectedMaterialStates().get(partId)
      if (selectedState === undefined) material.color.set(theme.bodyHex)
      else selectedState.color.set(theme.bodyHex)

      if (mesh.userData.isBrepMesh === true) {
        // GEO-25b: B-rep bodies carry TWO edge objects (see addBrepModel) --
        // an always-present thin pick twin (Stage-2 edge picking depends on
        // it) plus an optional fat overlay in wireframe mode. That is a
        // different shape than the
        // single-child swap below, so route it through its own helper.
        this.applyBrepEdgeTheme(mesh, partId)
        continue
      }

      const oldEdge = mesh.children.find((c) => c.userData?.isDisplayEdge === true) as
        | (THREE.LineSegments | LineSegments2)
        | undefined
      if (oldEdge === undefined) continue
      const positions = this.partEdgePositions.get(partId)
      const wasFat = oldEdge instanceof LineSegments2
      const shouldBeFat = modeledBodyEdgeUsesFatLines(this.currentShadingMode)
      if (wasFat === shouldBeFat) {
        // Same technique -- recolor the existing material in place.
        if (wasFat) (oldEdge.material as LineMaterial).color = new THREE.Color(theme.edgeHex)
        else (oldEdge.material as THREE.LineBasicMaterial).color = new THREE.Color(theme.edgeHex)
        if (mesh.userData.isModelBodyMesh === true) {
          applyBodyEdgeOverlayStyle(
            oldEdge as unknown as THREE.LineSegments,
            resolveModeledBodyEdgeModeStyle(this.currentShadingMode),
          )
        }
        continue
      }
      if (positions === undefined) continue // defensive: no source positions to rebuild from
      mesh.remove(oldEdge)
      oldEdge.geometry.dispose()
      ;(Array.isArray(oldEdge.material) ? oldEdge.material : [oldEdge.material]).forEach((m) => m.dispose())
      const newEdge = this.buildPartEdgeOverlay(positions)
      newEdge.userData = { ...oldEdge.userData, isDisplayEdge: true }
      newEdge.visible = oldEdge.visible
      if (mesh.userData.isModelBodyMesh === true) {
        applyBodyEdgeOverlayStyle(newEdge, resolveModeledBodyEdgeModeStyle(this.currentShadingMode))
      }
      mesh.add(newEdge)
    }
    // No explicit render call needed -- startRenderLoop's rAF loop renders
    // continuously and picks up this frame's material/scene changes on the
    // very next frame (unlike sceneRuntime.ts's on-demand render() model).
  }

  /** GEO-26 Stage B: immediate-apply selection/hover glow switch. Unlike
   *  setViewportTheme, no material lives waiting to
   *  be re-tinted at rest -- brepPickColor()/brepHoverColor() already read
   *  this.selectionGlow fresh on every call, so the only work here is
   *  repainting whatever overlay objects ALREADY EXIST (the currently
   *  picked/hovered B-rep highlights) so the new colors show without waiting
   *  for the next pick/hover event, plus the CAM sketch layer's own
   *  selected/hover entities (its colors are getters too, but nothing forces
   *  a rebuild on a settings-only change -- see SketchLayer.refreshGlow's
   *  doc comment). WO-286: like setViewportTheme, its uiPrefs subscription is
   *  gone with the Settings control; it stays public for direct callers. */
  setSelectionGlow(candidate: SelectionGlowCandidateId): void {
    const resolved = isSelectionGlowCandidateId(candidate) ? candidate : this.selectionGlow
    if (this.selectionGlow === resolved) return
    this.selectionGlow = resolved
    this.rebuildBrepHighlights()
    for (const [key, overlay] of this.getBrepHighlights()) {
      // WO-351: route through the same resolver buildBrepHighlight uses,
      // not a blind brepPickColor() -- a picked overlay colliding with the
      // body's fill or selected-outline must keep resolving to the dark
      // on-selected token even across a live glow-candidate switch.
      syncInteractionColor(overlay, this.brepHighlightColorFor(key.split('|')[0], key.includes('|edge|') ? 'edge' : 'face', 'picked'))
    }
    this.refreshBrepHoverOverlay()
    for (const id of [...this.getPartInteractionOutlines().keys()]) {
      this.paintPartHighlight(id, this.partShouldBeHighlighted(id))
    }
    if (this.loopPickHoverId) this.refreshLoopColors()
    this.sketcher.refreshGlow()
  }

  /** GEO-25b display-mode handling for a B-rep part's DUAL edge objects (see
   *  addBrepModel for the construction-time twin of this logic). `pickTwin`
   *  is the thin THREE.LineSegments Stage-2 edge picking finds via
   *  `instanceof THREE.LineSegments && userData.isBrepEdges` -- it always
   *  exists and is NEVER removed, so the raycast path never has to change,
   *  only its `.visible` flag (raycasting ignores `.visible`; see the
   *  three.js `Raycaster.intersect()` source -- it tests `layers`, not
   *  visibility). `fatOverlay` (userData.isBrepFatEdge, a LineSegments2) is
   *  purely cosmetic and is built/recolored/torn down when entering or
   *  leaving topology-only wireframe. In shaded modes, the pick twin is also
   *  the visible depth-tested topology edge. */
  private applyBrepEdgeTheme(
    mesh: THREE.Mesh,
    partId: string,
  ): void {
    const useFat = modeledBodyEdgeUsesFatLines(this.currentShadingMode)
    const modeStyle = resolveModeledBodyEdgeModeStyle(this.currentShadingMode)
    const pickTwin = mesh.children.find(
      (c) => c instanceof THREE.LineSegments && c.userData.isBrepEdges === true
    ) as THREE.LineSegments | undefined
    if (pickTwin) {
      applyBodyEdgeOverlayStyle(pickTwin, modeStyle)
      pickTwin.visible = !useFat && modeledBodyEdgesVisibleForMode(this.currentShadingMode)
      if (useFat) delete (pickTwin.userData as { isDisplayEdge?: boolean }).isDisplayEdge
      else pickTwin.userData.isDisplayEdge = true
    }

    const existingFat = mesh.children.find(
      (c) => c.userData.isBrepFatEdge === true
    ) as THREE.LineSegments | undefined

    if (!useFat) {
      if (existingFat) {
        mesh.remove(existingFat)
        existingFat.geometry.dispose()
        ;(Array.isArray(existingFat.material) ? existingFat.material : [existingFat.material]).forEach((m) => m.dispose())
      }
      return
    }

    if (existingFat) {
      applyBodyEdgeOverlayStyle(existingFat, modeStyle)
      return
    }
    const positions = this.partEdgePositions.get(partId)
    if (positions === undefined) return // defensive: no source positions to rebuild from
    const fat = this.buildPartEdgeOverlay(positions)
    fat.userData = { isBrepFatEdge: true, isDisplayEdge: true, brepGeoId: partId }
    mesh.add(fat)
  }

  // ---- Add STL part ----
  // Returns the LOCAL (post-centering) bounding box so callers can persist it
  // on ImportedGeometry.boundingBox - the store-side auto-stock derivation and
  // model_top/model_bottom height modes read it (H1 commit B; STL imports
  // previously left the store boundingBox at zeros forever).
  async addSTL(
    buffer: ArrayBuffer,
    id: string,
    name: string,
    position = { x: 0, y: 0, z: 0 },
    rotation = { x: 0, y: 0, z: 0 },
    color?: string
  ): Promise<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }> {
    const loader = new STLLoader()
    const geometry = loader.parse(buffer)
    geometry.computeBoundingBox()
    geometry.computeVertexNormals()

    // Center geometry at origin with bottom on Z=0
    const bbox = geometry.boundingBox!
    const center = new THREE.Vector3()
    bbox.getCenter(center)
    geometry.translate(-center.x, -center.y, -bbox.min.z)
    geometry.computeBoundingBox()
    const localBB = geometry.boundingBox!

    const geoThemeSTL = this.resolvePartTheme()
    const workholdingSTL = this.isPartWorkholding(id)
    const material = createModeledBodyMaterial({
      color: workholdingSTL ? CNCViewport.WORKHOLDING_BODY_HEX : (color ?? geoThemeSTL.bodyHex),
    })

    const mesh = new THREE.Mesh(geometry, material)
    // No self-shadowing on part meshes: receiving the hard PCF shadow map on
    // flat faces produced diagonal hatching (shadow acne). castShadow off too
    // so parts don't project hard shadows onto themselves/the floor — matches
    // a glass-smooth, no-hard-self-shadow look.
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = name
    mesh.userData.isBodyPresentationMesh = true

    // Pure decoration (no picking dependency), so STL display edges follow
    // the same native-shaded / fat-wireframe mode policy as other bodies.
    const stlEdgePositions = (new THREE.EdgesGeometry(geometry, 25).getAttribute('position').array as Float32Array).slice()
    this.partEdgePositions.set(id, stlEdgePositions)
    this.partUsesThemeColor.set(id, !workholdingSTL && color === undefined)
    const edges = this.buildPartEdgeOverlay(stlEdgePositions)
    mesh.add(edges)

    // Wrap in a group so we can transform without affecting the centered geometry
    const group = new THREE.Group()
    group.name = id
    // The recentring above establishes "group origin == visible pivot"
    // (xy centre, bottom z). setSelectedPart keys DIRECT TransformControls
    // attachment off this marker; unmarked (native-frame) groups get the
    // bounds-derived pivot proxy instead.
    group.userData.originIsVisiblePivot = true
    group.add(mesh)
    group.position.set(position.x, position.y, position.z)
    group.rotation.set(
      THREE.MathUtils.degToRad(rotation.x),
      THREE.MathUtils.degToRad(rotation.y),
      THREE.MathUtils.degToRad(rotation.z)
    )

    // Replace if same id already exists
    if (this.partGroups.has(id)) {
      const old = this.partGroups.get(id)!
      this.workpieceGroup.remove(old)
      this.getStlFacetHighlights().delete(id)
      this.disposePartBodyPresentation(old)
    }

    this.partGroups.set(id, group)
    this.partMaterials.set(id, material)
    this.workpieceGroup.add(group)
    this.registerPartSectionCap(group)
    this.updateSelectableObjects()
    // A same-id replace orphans the previous group; if that group was the
    // current selection the gizmo is still attached to it with a stale pivot.
    // Re-select so the pivot is recomputed on the live group (the workplan
    // pivot bug: recompute whenever the geometry is edited).
    if (this.selectedPartId === id && this.canAttachPartTransformGizmo()) this.setSelectedPart(id)

    // Fit camera to all parts on first load (unless the user has positioned the
    // camera — a refresh-restore — in which case maybeAutoFit suppresses this so
    // the restored framing survives).
    this.maybeAutoFit(this.partGroups.size === 1, 'addSTL')

    this.rebuildStock()

    return {
      min: { x: localBB.min.x, y: localBB.min.y, z: localBB.min.z },
      max: { x: localBB.max.x, y: localBB.max.y, z: localBB.max.z },
    }
  }

  // ---- Add B-rep (STEP) part from a model-worker payload (ADR 0018) ----
  // ONE merged BufferGeometry for the whole model; faceRanges/edgeRanges kept in
  // userData for Stage 2 face/edge picking. Registered in partGroups under the
  // geometry id, so selection / visibility / transform / removal all flow through
  // the exact same paths as addSTL. Stage 1 = whole-model picking only.
  // Unlike addSTL, the geometry is NOT recentred: mesh coordinates must stay
  // identical to the B-rep shape coordinates in the worker (Stage 3 derivation).
  addBrepModel(
    id: string,
    payload: BrepModelPayload,
    name: string,
    position = { x: 0, y: 0, z: 0 },
    rotation = { x: 0, y: 0, z: 0 },
    color?: string
  ) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(payload.mesh.positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(payload.mesh.normals, 3))
    geometry.setIndex(new THREE.BufferAttribute(payload.mesh.indices, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    geometry.userData.faceRanges = payload.mesh.faceRanges   // Stage 2: triangle -> face id
    geometry.userData.faceTypes = payload.faceTypes          // Stage 2/3: planarity test

    const geoThemeBrep = this.resolvePartTheme()
    const workholdingBrep = this.isPartWorkholding(id)
    const material = createModeledBodyMaterial({
      color: workholdingBrep ? CNCViewport.WORKHOLDING_BODY_HEX : (color ?? geoThemeBrep.bodyHex),
    })

    const mesh = new THREE.Mesh(geometry, material)
    // GEO-23 L4: bake per-vertex AO into this body's geometry + patch its material
    // so bored cavities read as depth under the IBL base. One-time at import; the
    // BVH used to sample it is transient (freed when applyBodyAO returns).
    const aoBake = applyBodyAO(mesh, payload.mesh.ao)
    // The display payload is the render artifact cached after this call. Attach
    // the exact deterministic bake so refresh/cross-machine restore can install
    // it without rebuilding a BVH or casting hemisphere rays on the main thread.
    if (aoBake.ao) payload.mesh.ao = aoBake.ao
    // No self-shadowing on B-rep part meshes: receiving the hard PCF shadow map
    // on flat faces produced diagonal hatching (shadow acne). castShadow off too
    // so parts don't project hard shadows onto themselves/the floor — matches
    // a glass-smooth, no-hard-self-shadow look.
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = name
    mesh.userData.isBodyPresentationMesh = true
    mesh.userData.isBrepMesh = true                          // Stage 2 face picking marker
    mesh.userData.brepGeoId = id

    // True B-rep edge polylines -> line segment pairs (one LineSegments object).
    // NOTE: name stays empty so updateSelectableObjects does NOT make it pickable
    // in normal mode; Stage 2 edge-pick mode raycasts it directly via userData.
    const er = payload.edges.edgeRanges
    const ep = payload.edges.positions
    const edgeCount = er.length / 2
    const segCount = Math.max(0, ep.length / 3 - edgeCount) // points minus one per edge
    const segPositions = new Float32Array(segCount * 2 * 3)
    // Segment -> edge lookup: segments are written edge-by-edge, so edge i owns the
    // contiguous segment block [edgeSegStarts[i], edgeSegStarts[i+1]).
    const edgeSegStarts = new Uint32Array(edgeCount + 1)
    let w = 0
    let seg = 0
    for (let i = 0; i < edgeCount; i++) {
      edgeSegStarts[i] = seg
      const start = er[2 * i]
      const count = er[2 * i + 1]
      for (let k = 0; k < count - 1; k++) {
        const a = (start + k) * 3
        const b = (start + k + 1) * 3
        segPositions[w++] = ep[a];     segPositions[w++] = ep[a + 1]; segPositions[w++] = ep[a + 2]
        segPositions[w++] = ep[b];     segPositions[w++] = ep[b + 1]; segPositions[w++] = ep[b + 2]
        seg++
      }
    }
    edgeSegStarts[edgeCount] = seg
    const edgeGeo = new THREE.BufferGeometry()
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(segPositions.subarray(0, w), 3))
    edgeGeo.userData.edgeRanges = payload.edges.edgeRanges   // Stage 2: segment -> edge id
    edgeGeo.userData.edgeSegStarts = edgeSegStarts           // Stage 2: prefix sums (see above)
    edgeGeo.userData.edgePositions = payload.edges.positions // Stage 2: edge highlight polylines
    // B-rep Stage-2 picking requires an always-present, always-native
    // THREE.LineSegments twin. Shaded modes display that same object; the
    // topology-only wireframe mode hides it behind a cosmetic LineSegments2.
    // Stage 2 edge picking
    // (collectBrepObjects, ~line 4870) finds it by
    // `instanceof THREE.LineSegments && userData.isBrepEdges`, completely
    // unchanged, and it carries the Stage-2-only geometry userData
    // (edgeRanges/edgeSegStarts/edgePositions) buildPartEdgeOverlay does not
    // know how to preserve, so it is built directly rather than through that
    // helper. Raycasting ignores `.visible`, so wireframe can hide the twin
    // visually without weakening edge picking.
    const edgeLines = createBodyEdgeOverlay(edgeGeo, {
      ...modeledBodyEdgeOverlayOptions(
        isViewportThemeId(this.viewportThemeId) ? this.viewportThemeId : 'classic',
        { ownsGeometry: true },
      ),
      fat: false,
    })
    this.applyCurrentSectionClippingToObject(edgeLines)
    edgeLines.userData.isBrepEdges = true                    // Stage 2 edge picking marker
    edgeLines.userData.brepGeoId = id
    if (modeledBodyEdgeUsesFatLines(this.currentShadingMode)) {
      edgeLines.visible = false                               // invisible pick-only twin
    } else {
      edgeLines.userData.isDisplayEdge = true                 // toggled by shading mode
    }
    mesh.add(edgeLines)
    this.partEdgePositions.set(id, segPositions.subarray(0, w))
    this.partUsesThemeColor.set(id, !workholdingBrep && color === undefined)

    if (modeledBodyEdgeUsesFatLines(this.currentShadingMode)) {
      const fatEdges = this.buildPartEdgeOverlay(segPositions.subarray(0, w))
      fatEdges.userData = { isBrepFatEdge: true, isDisplayEdge: true, brepGeoId: id }
      mesh.add(fatEdges)
    }

    const group = new THREE.Group()
    group.name = id
    group.add(mesh)
    group.position.set(position.x, position.y, position.z)
    group.rotation.set(
      THREE.MathUtils.degToRad(rotation.x),
      THREE.MathUtils.degToRad(rotation.y),
      THREE.MathUtils.degToRad(rotation.z)
    )

    // Replace if same id already exists (re-import)
    if (this.partGroups.has(id)) {
      this.clearBrepStateFor(id)   // stale picks/overlays die with the old group
      const old = this.partGroups.get(id)!
      this.workpieceGroup.remove(old)
      this.disposePartBodyPresentation(old)
    }

    this.partGroups.set(id, group)
    this.partMaterials.set(id, material)
    this.workpieceGroup.add(group)
    this.registerPartSectionCap(group)
    // Re-attach any geometry-local derived-loop overlay created before this
    // (async) model load landed, or surviving a re-import of the same id —
    // add() moves it from its previous parent (scene root / the old group).
    const localLoops = this._geoLocalLoopGroups.get(id)
    if (localLoops) group.add(localLoops)
    this.updateSelectableObjects()
    // A same-id replace (re-import / re-tessellation) orphans the previous
    // group; re-select so the pivot proxy is recomputed on the live group.
    if (this.selectedPartId === id && this.canAttachPartTransformGizmo()) this.setSelectedPart(id)

    // Refresh-restore guard: skip the first-part auto-fit when the user has
    // positioned the camera (see markCameraUserPositioned). This is the STEP
    // (async) path — the persistent flag (not a one-shot) is what keeps THIS
    // late fit from resetting the restored view to ISO on a real GPU (T15).
    this.maybeAutoFit(this.partGroups.size === 1, 'addBrepModel')

    this.rebuildStock()
  }

  // ---- Model-workbench body (INT-17A Stage 1) ----
  // Draw a body modeled in the Model workbench as a CAM part mesh, from the
  // persisted tessellation carried on the geometry entry (ModelBodyDisplay). It
  // registers in `partGroups` under the geometry id so selection / visibility /
  // transform / removal all flow through the SAME paths as addSTL/addBrepModel.
  //
  // STILL INERT for the occt-model B-rep face/edge pick machinery (identity
  // law, DECISIONS 2026-07-18 ruling 1): this sets NO `isBrepMesh` userData, so
  // a model body is never raycast-resolved through THAT machinery - its
  // identity is the Model kernel's ElementMap exclusively.
  //
  // CAM-BINDING Stage 5: it DOES now optionally tag itself pickable through a
  // PARALLEL, model-specific path (`isModelPickMesh` + `modelTriFace`/
  // `modelFaceIds` geometry userData) when the display payload carries the new
  // per-face identity arrays (ModelBodyDisplay.faceIds/triFace - absent on a
  // pre-Stage-5-regen body, in which case this stays exactly as inert as
  // Stage 1 left it). resolveBrepHit below reads this SEPARATELY from the
  // occt-model `isBrepMesh` path - a raycast hit still never crosses into the
  // occt-model resolver for a model body, preserving the identity boundary;
  // it only ever resolves a (geoId, local face-array index) pair the CALLER
  // looks up against ITS OWN copy of `display.faceIds` to get the real
  // ElementMap stableId, never against occt-model state.
  addModelBody(
    id: string,
    display: ModelBodyDisplay,
    name: string,
    position = { x: 0, y: 0, z: 0 },
    rotation = { x: 0, y: 0, z: 0 },
    color?: string,
  ) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(display.positions), 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(display.normals), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(display.indices), 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    const geoThemeModelBody = this.resolvePartTheme()
    const workholdingModelBody = this.isPartWorkholding(id)
    const material = createModeledBodyMaterial({
      color: workholdingModelBody ? CNCViewport.WORKHOLDING_BODY_HEX : (color ?? geoThemeModelBody.bodyHex),
    })
    const mesh = new THREE.Mesh(geometry, material)
    // Same no-self-shadow treatment as addBrepModel (avoid shadow-acne hatching
    // on flat faces; the glass-smooth look).
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = name
    mesh.userData.isBodyPresentationMesh = true
    mesh.userData.isModelBodyMesh = true   // marker: a Model-workbench body, NOT an occt brep
    // CAM-BINDING Stage 5: opt into the model-specific pick path only when the
    // per-face identity arrays are present (see this method's header comment).
    if (display.faceIds && display.triFace && display.faceIds.length > 0 && display.triFace.length > 0) {
      mesh.userData.isModelPickMesh = true
      mesh.userData.modelPickGeoId = id
      geometry.userData.modelFaceIds = display.faceIds
      geometry.userData.modelTriFace = Uint32Array.from(display.triFace)
    }
    this.partUsesThemeColor.set(id, !workholdingModelBody && color === undefined)

    // Shared true-edge geometry from the persisted CSR edge polylines. Stable
    // edge ids are forwarded when present and never synthesized for legacy
    // project payloads; display construction needs only the CSR offsets.
    const edgeGeometry = buildEdgeLineGeometry({
      edgePositions: new Float32Array(display.edgePositions),
      edgeOffsets: new Uint32Array(display.edgeOffsets),
      edgeIds: display.edgeIds,
    })
    const edgePosition = edgeGeometry.getAttribute('position')
    if (edgePosition.count > 0) {
      // GEO-25: "DELIBERATELY INERT for B-rep picking" (see this method's own
      // header comment) -- no Stage-2 raycast-by-type-check depends on this
      // edge overlay, so it follows the shared native-shaded / fat-wireframe
      // mode policy without affecting Stage-2 picking.
      const segPositions = edgePosition.array as Float32Array
      this.partEdgePositions.set(id, segPositions)
      const edgeLines = this.buildPartEdgeOverlayFromGeometry(edgeGeometry)
      mesh.add(edgeLines)
    } else {
      edgeGeometry.dispose()
    }

    const group = new THREE.Group()
    group.name = id
    group.add(mesh)
    group.position.set(position.x, position.y, position.z)
    group.rotation.set(
      THREE.MathUtils.degToRad(rotation.x),
      THREE.MathUtils.degToRad(rotation.y),
      THREE.MathUtils.degToRad(rotation.z),
    )

    // Replace in place on re-derive (same id) - dispose the old GPU buffers first
    // so a body edited dozens of times never leaks (mirrors addBrepModel).
    if (this.partGroups.has(id)) {
      this.clearBrepStateFor(id)
      const old = this.partGroups.get(id)!
      this.workpieceGroup.remove(old)
      this.disposePartBodyPresentation(old)
    }

    this.partGroups.set(id, group)
    this.partMaterials.set(id, material)
    this.workpieceGroup.add(group)
    this.registerPartSectionCap(group)
    this.updateSelectableObjects()
    // A same-id replace (3D modeling workspace re-derive) orphans the previous group;
    // re-select so the pivot proxy is recomputed on the live group at the
    // body's NEW centre (the workplan pivot bug's "recompute on edit" half).
    if (this.selectedPartId === id && this.canAttachPartTransformGizmo()) this.setSelectedPart(id)
    this.maybeAutoFit(this.partGroups.size === 1, 'addModelBody')
    this.rebuildStock()
  }

  // ---- Remove a part ----
  removeSTL(id: string) {
    this.clearBrepStateFor(id)
    const group = this.partGroups.get(id)
    if (group) {
      this.workpieceGroup.remove(group)
      this.disposePartBodyPresentation(group)
    }
    this.partGroups.delete(id)
    this.partMaterials.delete(id)
    this.partUsesThemeColor.delete(id)
    this.partEdgePositions.delete(id)
    // Funnel through setSelectedPart so the proxy and highlights are cleaned up
    // too -- a bare `selectedPartId = null` used to leak both.
    if (this.selectedPartId === id) this.setSelectedPart(null)
    this.updateSelectableObjects()
    this.rebuildStock()
  }

  // ---- Update part transform (works for both 3D and 2D geometry) ----
  setPartTransform(
    id: string,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number }
  ) {
    const group = this.partGroups.get(id) ?? this.geometry2dGroups.get(id)
    if (!group) return
    // Z passes through for 2D geometry too (B11): the gizmo already moves 2D
    // groups in Z and H1 made deliberate Z placement meaningful (auto-stock
    // base follows min Z). Clamping here made a typed Z LOOK committed (store
    // said z=10) while the rendered part dropped to the table.
    group.position.set(position.x, position.y, position.z)
    group.rotation.set(
      THREE.MathUtils.degToRad(rotation.x),
      THREE.MathUtils.degToRad(rotation.y),
      THREE.MathUtils.degToRad(rotation.z)
    )
    // A typed transform moves the group under a live proxy; re-center it or
    // the gizmo would stay behind at the old center. Applies to any proxied
    // group (2D or native-frame 3D); no-ops when this group is not proxied.
    this.sync2DGizmoProxyToGroup(group)
    this.rebuildStock()
  }

  // ---- Live-move a single fixed-stock BOX during a gizmo drag ----
  // Mirrors setPartTransform for parts: reposition exactly ONE fixed-stock box
  // group to the live gizmo position without a full rebuildStock (heavy). The
  // gizmo sphere sits on the stock's world-space min corner (FixedStockItem.
  // position); buildStockBox centers its group at origin + dims/2, so we apply
  // the same +dims/2 here. Crucially we ALSO write the new position back into
  // currentStockConfig.fixedStocks: member-part sync (setPartTransform) calls
  // rebuildStock() per frame, which rebuilds every fixed box from
  // currentStockConfig — if that copy were stale the rebuild would stomp this
  // live box back to the old spot (the lag bug). Keeping the cached config in
  // lockstep makes the box track the gizmo every frame, matching the members.
  setFixedStockPosition(stockId: string, position: { x: number; y: number; z: number }) {
    const group = this.fixedStockBoxes.get(stockId)
    if (!group) return
    // Half-extents come from the box group's OWN geometry, not currentStockConfig:
    // updateFixedStock can change a stock's dims without the viewport's cached
    // config seeing it until the next rebuildStock(config) (which only fires on
    // release), so trusting cached width/height/depth here drifts the center by
    // (cachedDims - realDims)/2. The group's bounding box is the source of truth.
    const bb = new THREE.Box3().setFromObject(group)
    const half = bb.isEmpty()
      ? { x: 0, y: 0, z: 0 }
      : { x: (bb.max.x - bb.min.x) / 2, y: (bb.max.y - bb.min.y) / 2, z: (bb.max.z - bb.min.z) / 2 }
    group.position.set(position.x + half.x, position.y + half.y, position.z + half.z)
    group.updateMatrixWorld(true)
    // Keep the cached config in lockstep too: member-part sync (setPartTransform)
    // calls rebuildStock() per frame, which rebuilds every fixed box from
    // currentStockConfig. If that copy were stale it would stomp this live box —
    // a stale POSITION sends the box back to the old spot; stale DIMS (a stock
    // resized via updateFixedStock since the last rebuildStock(config)) rebuild
    // it at the wrong size AND wrong center. Sync both from the authoritative
    // geometry so any per-frame rebuild reproduces exactly what we drew here.
    const cached = this.currentStockConfig.fixedStocks?.find((fs) => fs.id === stockId)
    if (cached) {
      cached.position = { x: position.x, y: position.y, z: position.z }
      cached.width  = half.x * 2
      cached.height = half.y * 2
      cached.depth  = half.z * 2
    }
  }

  // ---- Change display color of an STL part ----
  setPartColor(id: string, hexColor: string) {
    const mat = this.partMaterials.get(id)
    if (!mat) return
    const selectedState = this.getPartSelectedMaterialStates().get(id)
    if (selectedState === undefined) mat.color.setStyle(hexColor)
    else selectedState.color.setStyle(hexColor)
    mat.needsUpdate = true
  }

  private partInteractionVariant(id: string): InteractionVariant | null {
    // A selected part stays selected while the pointer passes over it.
    if (id === this.selectedPartId || this.partPickSelectedIds.has(id)) return 'selected'
    return id === this.partPickHoverId ? 'hovered' : null
  }

  private partInteractionColor(
    variant: InteractionVariant,
    nestMembershipSelected: boolean,
  ): number {
    if (nestMembershipSelected) return asNumber('--vp-loop-default')
    const candidate = isSelectionGlowCandidateId(this.selectionGlow) ? this.selectionGlow : 'current'
    const theme = isViewportThemeId(this.viewportThemeId) ? this.viewportThemeId : DEFAULT_VIEWPORT_THEME
    const glow = resolveSelectionGlowColors(candidate, theme)
    if (glow !== null) return variant === 'selected' ? glow.selected : glow.hover
    return variant === 'selected' ? asNumber('--vp-select-part') : CNCViewport.BREP_HOVER_COLOR_BASE
  }

  /** Shared whole-part highlight painter for ordinary selection and temporary
   * viewport-pick sessions. Hover uses an outer silhouette; selection uses a
   * shaded whole-body fill. Nest membership keeps its explicit blue treatment. */
  private paintPartHighlight(id: string, on: boolean) {
    const nestMembershipSelected = this.partPickPresentation === 'nest-membership' &&
      this.partPickSelectedIds.has(id)
    const variant = on ? this.partInteractionVariant(id) : null
    const color = variant === null
      ? asNumber('--vp-select-part')
      : this.partInteractionColor(variant, nestMembershipSelected)
    const mat3d = this.partMaterials.get(id)
    if (mat3d) {
      const tintStates = this.getPartSelectedMaterialStates()
      const tintState = tintStates.get(id)
      if (variant === 'selected') {
        if (tintState === undefined) {
          tintStates.set(id, applySelectedBodyMaterialTint(mat3d, color))
        } else {
          updateSelectedBodyMaterialTint(mat3d, color)
        }
      } else if (tintState !== undefined) {
        restoreSelectedBodyMaterialTint(mat3d, tintState)
        tintStates.delete(id)
      }
      const interactionOutlines = this.getPartInteractionOutlines()
      const existing = interactionOutlines.get(id)
      if (variant === null) {
        if (existing !== undefined) {
          disposeInteractionOverlay(existing)
          interactionOutlines.delete(id)
        }
      } else {
        const group = this.partGroups.get(id)
        const presentation = group === undefined ? null : this.bodyPresentationForGroup(group)
        if (presentation !== null) {
          const renderer = this.renderer as THREE.WebGLRenderer | undefined
          const resolution = renderer?.getDrawingBufferSize?.(new THREE.Vector2())
            ?? new THREE.Vector2(1, 1)
          const existingGeometry = existing?.userData.interactionGeometry
            ?? (existing as THREE.Mesh | undefined)?.geometry
          const existingVariant = existing?.userData.interactionVariant
          if (
            existing === undefined ||
            existingGeometry !== presentation.mesh.geometry ||
            existingVariant !== variant
          ) {
            if (existing !== undefined) disposeInteractionOverlay(existing)
            const overlay = createBodyInteractionOverlay({
              geometry: presentation.mesh.geometry,
              outlineSegmentPositions: this.partEdgePositions?.get(id),
              variant,
              resolution,
              clippingPlanes: mat3d.clippingPlanes,
              color,
            })
            overlay.userData.interactionGeometry = presentation.mesh.geometry
            overlay.visible = interactionOverlayVisibleForMode('body', this.currentShadingMode)
            presentation.mesh.add(overlay)
            interactionOutlines.set(id, overlay)
          } else {
            syncInteractionResolution(existing, resolution)
            syncInteractionColor(existing, color)
            existing.visible = interactionOverlayVisibleForMode('body', this.currentShadingMode)
          }
        }
      }
    }
    const highlighted = variant !== null
    if (this.geometry2dGroups.has(id)) this.highlight2D(id, highlighted, color)
    this.highlightProjectedLoops(id, highlighted, color)
    this.setNestMembershipGlow(id, nestMembershipSelected)
    // WO-351: this body's fill-painted state just changed (or was
    // reconfirmed) above -- resync any B-rep edge/face overlay already
    // built for it so it can't keep drawing a colour resolved before the
    // fill changed under it.
    this.resyncBrepHighlightColorsFor(id)
  }

  private setNestMembershipGlow(id: string, on: boolean) {
    const glows = this.partPickGlowGroups
    const existing = glows.get(id)
    if (!on) {
      if (existing === undefined) return
      existing.removeFromParent()
      existing.traverse((child) => {
        if (!(child instanceof LineSegments2)) return
        child.geometry.dispose()
        const material = child.material
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material.dispose()
      })
      glows.delete(id)
      return
    }
    if (existing !== undefined) return

    const source = this.geometry2dGroups.get(id)
    if (source === undefined) return
    const glow = new THREE.Group()
    glow.name = '__nest-membership-glow__'
    source.traverse((child) => {
      if (!(child instanceof THREE.Line)) return
      const position = child.geometry.getAttribute('position')
      if (position === undefined || position.count < 2) return
      const segments: number[] = []
      for (let index = 0; index < position.count - 1; index++) {
        segments.push(
          position.getX(index), position.getY(index), position.getZ(index),
          position.getX(index + 1), position.getY(index + 1), position.getZ(index + 1),
        )
      }
      const addStroke = (linewidth: number, opacity: number, renderOrder: number) => {
        const geometry = new LineSegmentsGeometry()
        geometry.setPositions(segments)
        const material = new LineMaterial({
          color: asNumber('--vp-loop-default'),
          linewidth,
          transparent: opacity < 1,
          opacity,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        })
        material.resolution.copy(this.renderer.getDrawingBufferSize(new THREE.Vector2()))
        const stroke = new LineSegments2(geometry, material)
        stroke.position.copy(child.position)
        stroke.quaternion.copy(child.quaternion)
        stroke.scale.copy(child.scale)
        stroke.frustumCulled = false
        stroke.renderOrder = renderOrder
        glow.add(stroke)
      }
      addStroke(10, 0.22, 102)
      addStroke(3, 1, 103)
    })
    if (glow.children.length === 0) return
    source.add(glow)
    glows.set(id, glow)
  }

  private partShouldBeHighlighted(id: string): boolean {
    return this.partInteractionVariant(id) !== null
  }

  // ---- Highlight selected part + attach transform gizmo ----
  setSelectedPart(id: string | null) {
    // Clear previous highlight (3D or 2D)
    if (this.selectedPartId) {
      const previousId = this.selectedPartId
      this.selectedPartId = null
      this.paintPartHighlight(previousId, this.partShouldBeHighlighted(previousId))
    }
    this.transformControls.detach()
    this.clear2DGizmoProxy()

    const group3d = id ? this.partGroups.get(id) : undefined
    const group2d = id ? this.geometry2dGroups.get(id) : undefined
    // Never retain a selection for an object that is not in this scene. This
    // prevents an async restore from resurrecting deleted project geometry.
    this.selectedPartId = group3d || group2d ? id : null

    if (this.selectedPartId && this.canAttachPartTransformGizmo()) {
      this.paintPartHighlight(this.selectedPartId, true)

      // DIRECT attachment draws the gizmo at the group origin, which is
      // correct ONLY when that origin is the part's visible pivot -- an
      // invariant addSTL establishes by recentring its mesh (and marks with
      // userData.originIsVisiblePivot). B-rep (STEP) and model-workbench
      // meshes keep NATIVE authoring coordinates -- recentring them is
      // forbidden -- so a body whose sketch was drawn away from the origin
      // would land its gizmo at the WORKSPACE ORIGIN. Those, like all 2D
      // geometry, attach the bounds-derived pivot proxy instead (UI-75).
      if (group3d?.userData.originIsVisiblePivot) this.transformControls.attach(group3d)
      else if (group3d) this.attach2DGizmoProxy(group3d)
      else if (group2d) this.attach2DGizmoProxy(group2d)
    }
  }

  /**
   * Temporarily turns whole rendered parts into a click target for a modal or
   * in-workspace command. The caller owns finishing/cancelling the mode.
   */
  setPartPickMode(
    callback: ((id: string) => void) | null,
    allowedIds: readonly string[] = [],
    selectedIds: readonly string[] = [],
    presentation: 'standard' | 'nest-membership' = 'standard',
    // MW-PICKS-2: optional hover reporter, see partPickHoverCallback's own comment.
    onHover: ((id: string | null) => void) | null = null,
  ) {
    this.clearPartPickHover()
    this.setPartPickSelection([])
    this.partPickCallback = callback
    this.partPickHoverCallback = callback ? onHover : null
    this.partPickAllowedIds = callback && allowedIds.length > 0
      ? new Set(allowedIds)
      : null
    this.partPickPresentation = callback ? presentation : 'standard'
    if (callback) this.setPartPickSelection(selectedIds)
    if (callback) {
      this.renderer.domElement.style.cursor = 'crosshair'
      this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove)
    } else {
      this.renderer.domElement.style.cursor = ''
      if (!this.vertexPickCallback && !this.inFaceOverlayMode()) {
        this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove)
      }
    }
  }

  /** Updates the selected members of the active whole-part pick session.
   * Nest membership uses this for multi-select; single-pick callers simply
   * leave it empty. */
  setPartPickSelection(ids: readonly string[]) {
    const next = new Set(
      ids.filter((id) => this.partPickAllowedIds === null || this.partPickAllowedIds.has(id)),
    )
    const touched = new Set([...this.partPickSelectedIds, ...next])
    this.partPickSelectedIds = next
    for (const id of touched) this.paintPartHighlight(id, this.partShouldBeHighlighted(id))
  }

  private clearPartPickHover() {
    const id = this.partPickHoverId
    if (!id) return
    this.partPickHoverId = null
    this.paintPartHighlight(id, this.partShouldBeHighlighted(id))
  }

  private setPartPickHover(id: string | null) {
    if (id === this.partPickHoverId) return
    this.clearPartPickHover()
    this.partPickHoverId = id
    if (id) this.paintPartHighlight(id, true)
    // MW-PICKS-2: fires ONLY on an actual hover-target change (the equality
    // guard above), never once per pointermove frame -- callers get a
    // change-dedup'd stream for free, the same shape the extrude-target
    // pick's own hand-rolled dedup ref achieves for its separate raycast path.
    this.partPickHoverCallback?.(id)
  }

  enterStockCornerPickMode(
    callback: (pick: StockCornerPick) => void,
    allowedStockIds: readonly string[] = [],
  ) {
    this.exitStockCornerPickMode()
    this.stockCornerPickCallback = callback
    this.stockCornerPickAllowedIds = allowedStockIds.length > 0
      ? new Set(allowedStockIds)
      : null
    this.stockCornerPickMarker = new THREE.Mesh(
      new THREE.SphereGeometry(2.5, 16, 12),
      new THREE.MeshBasicMaterial({
        color: asNumber('--vp-wcs-origin'),
        depthTest: false,
        toneMapped: false,
      }),
    )
    this.stockCornerPickMarker.visible = false
    this.stockCornerPickMarker.renderOrder = 1001
    this.scene.add(this.stockCornerPickMarker)
    this.renderer.domElement.style.cursor = 'crosshair'
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove)
  }

  exitStockCornerPickMode() {
    this.stockCornerPickCallback = null
    this.stockCornerPickAllowedIds = null
    if (this.stockCornerPickMarker) {
      this.scene.remove(this.stockCornerPickMarker)
      this.stockCornerPickMarker.geometry.dispose()
      const material = this.stockCornerPickMarker.material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material.dispose()
      this.stockCornerPickMarker = null
    }
    this.renderer.domElement.style.cursor = ''
    if (!this.partPickCallback && !this.vertexPickCallback && !this.inFaceOverlayMode()) {
      this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove)
    }
  }

  // ── Contour holding-tab markers + edit mode (Tabs v2) ─────────────────────

  /** Render (or clear, with null) the holding-tab markers: one small square on
   *  the finish contour at every tab center. Display-only until
   *  enterContourTabEditMode is called. Safe to call on every store sync. */
  setContourTabMarkers(data: ContourTabMarkerData | null) {
    // A rebuild mid-drag would orphan the dragged marker mesh: cancel the drag.
    if (this.tabEditDrag) {
      this.tabEditDrag = null
      this.controls.enabled = true
    }
    if (this.tabMarkerGroup) {
      this.scene.remove(this.tabMarkerGroup)
      this.disposeGroup(this.tabMarkerGroup)
      this.tabMarkerGroup = null
    }
    this.tabMarkerData = data
    if (!data || data.loops.length === 0) return

    const group = new THREE.Group()
    group.name = '__contour_tab_markers__'
    const markerGeo = new THREE.BoxGeometry(2.4, 2.4, 0.8)
    for (const loop of data.loops) {
      loop.fractions.forEach((fraction, index) => {
        const mesh = new THREE.Mesh(
          markerGeo,
          new THREE.MeshBasicMaterial({
            color: asNumber('--vp-wcs-origin'),
            depthTest: false,
            toneMapped: false,
          }),
        )
        const p = pointAtFraction(loop.path, fraction)
        mesh.position.set(p.x, p.y, data.z)
        mesh.renderOrder = 1001
        mesh.userData.tabMarker = { loopId: loop.loopId, index }
        group.add(mesh)
      })
    }
    this.scene.add(group)
    this.tabMarkerGroup = group
  }

  /** Enter the explicit tab-placement mode: click the contour to add a tab,
   *  drag a marker to slide it along the contour, double-click a marker to
   *  remove it, Esc to leave. Every edit commits through the callbacks
   *  immediately; exiting commits nothing extra. */
  enterContourTabEditMode(callbacks: ContourTabEditCallbacks) {
    this.exitContourTabEditMode(false)
    this.tabEditCallbacks = callbacks
    this.renderer.domElement.style.cursor = 'crosshair'

    this.tabEditMoveHandler = (e: PointerEvent) => this.handleTabEditPointerMove(e)
    this.tabEditUpHandler = () => this.handleTabEditPointerUp()
    this.tabEditDblClickHandler = (e: MouseEvent) => {
      const marker = this.tabMarkerAtClient(e.clientX, e.clientY)
      const tag = marker?.userData.tabMarker as { loopId: string; index: number } | undefined
      if (tag) {
        e.stopPropagation()
        this.tabEditCallbacks?.onRemove(tag.loopId, tag.index)
      }
    }
    this.tabEditKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.exitContourTabEditMode(true)
    }
    this.renderer.domElement.addEventListener('pointermove', this.tabEditMoveHandler)
    this.renderer.domElement.addEventListener('pointerup', this.tabEditUpHandler)
    this.renderer.domElement.addEventListener('dblclick', this.tabEditDblClickHandler)
    window.addEventListener('keydown', this.tabEditKeyHandler)
  }

  /** Leave the tab-placement mode. `notify` fires onExit (used by the Esc path
   *  so the Properties panel toggle can follow); programmatic exits from the
   *  panel itself pass false. Markers stay rendered (display-only). */
  exitContourTabEditMode(notify = false) {
    const cb = this.tabEditCallbacks
    this.tabEditCallbacks = null
    if (this.tabEditDrag) {
      this.tabEditDrag = null
      this.controls.enabled = true
    }
    if (this.tabEditMoveHandler) {
      this.renderer.domElement.removeEventListener('pointermove', this.tabEditMoveHandler)
      this.tabEditMoveHandler = null
    }
    if (this.tabEditUpHandler) {
      this.renderer.domElement.removeEventListener('pointerup', this.tabEditUpHandler)
      this.tabEditUpHandler = null
    }
    if (this.tabEditDblClickHandler) {
      this.renderer.domElement.removeEventListener('dblclick', this.tabEditDblClickHandler)
      this.tabEditDblClickHandler = null
    }
    if (this.tabEditKeyHandler) {
      window.removeEventListener('keydown', this.tabEditKeyHandler)
      this.tabEditKeyHandler = null
    }
    if (cb) this.renderer.domElement.style.cursor = ''
    if (cb && notify) cb.onExit()
  }

  /** The tab marker under a client-coordinate point, if any. */
  private tabMarkerAtClient(clientX: number, clientY: number): THREE.Mesh | null {
    if (!this.tabMarkerGroup) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ), this.camera)
    const hit = ray.intersectObjects(this.tabMarkerGroup.children, false)[0]
    return hit && hit.object instanceof THREE.Mesh ? hit.object : null
  }

  /** Pointer position projected onto the tab-marker Z plane (world XY). */
  private tabPointerWorldXY(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.tabMarkerData) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ), this.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.tabMarkerData.z)
    const out = new THREE.Vector3()
    if (!ray.ray.intersectPlane(plane, out)) return null
    return { x: out.x, y: out.y }
  }

  private handleTabEditPointerMove(e: PointerEvent) {
    const drag = this.tabEditDrag
    if (!drag) {
      // Hover affordance: pointer over a marker reads as grabbable.
      const over = this.tabMarkerAtClient(e.clientX, e.clientY)
      this.renderer.domElement.style.cursor = over ? 'grab' : 'crosshair'
      return
    }
    const loop = this.tabMarkerData?.loops.find((l) => l.loopId === drag.loopId)
    const pt = this.tabPointerWorldXY(e.clientX, e.clientY)
    if (!loop || !pt) return
    const arc = closestArcPosition(loop.path, pt)
    if (!arc) return
    // Refuse positions the engine would fail loud on (overlapping tabs): the
    // marker simply stops at the last legal spot.
    if (!isTabFractionFree(loop.fractions, drag.index, arc.fraction, loop.minSeparationFraction)) return
    drag.fraction = arc.fraction
    drag.moved = true
    drag.marker.position.set(arc.point.x, arc.point.y, this.tabMarkerData!.z)
  }

  private handleTabEditPointerUp() {
    const drag = this.tabEditDrag
    if (!drag) return
    this.tabEditDrag = null
    this.controls.enabled = true
    this.tabEditJustDragged = true
    if (drag.moved) this.tabEditCallbacks?.onMove(drag.loopId, drag.index, drag.fraction)
  }

  /** Click in edit mode: clicking ON the contour adds a tab at that arc
   *  position (screen-gated so stray clicks do nothing); clicks on a marker or
   *  empty space are ignored (drags/double-clicks own markers). */
  private handleTabEditClick(event: MouseEvent) {
    // The click that ends a marker drag must not also add a tab.
    if (this.tabEditJustDragged) {
      this.tabEditJustDragged = false
      return
    }
    if (!this.tabMarkerData || !this.tabEditCallbacks) return
    if (this.tabMarkerAtClient(event.clientX, event.clientY)) return

    const pt = this.tabPointerWorldXY(event.clientX, event.clientY)
    if (!pt) return
    let best: { loop: ContourTabMarkerLoop; fraction: number; point: { x: number; y: number } } | null = null
    let bestEuclid = Infinity
    for (const loop of this.tabMarkerData.loops) {
      const arc = closestArcPosition(loop.path, pt)
      if (arc && arc.euclidean < bestEuclid) {
        bestEuclid = arc.euclidean
        best = { loop, fraction: arc.fraction, point: arc.point }
      }
    }
    if (!best) return

    // Screen-space gate: the click must land within ~14 px of the contour.
    const rect = this.renderer.domElement.getBoundingClientRect()
    const screen = new THREE.Vector3(best.point.x, best.point.y, this.tabMarkerData.z)
      .project(this.camera)
    const sx = rect.left + ((screen.x + 1) / 2) * rect.width
    const sy = rect.top + ((1 - screen.y) / 2) * rect.height
    if (Math.hypot(sx - event.clientX, sy - event.clientY) > 14) return

    if (!isTabFractionFree(
      best.loop.fractions, null, best.fraction, best.loop.minSeparationFraction,
    )) return
    this.tabEditCallbacks.onAdd(best.loop.loopId, best.fraction)
  }

  private stockCornerAtCurrentRay(): StockCornerPick | null {
    const hit = this.raycaster
      .intersectObject(this.stockGroup, true)
      .find((candidate) => {
        const tag = this.findStockTag(candidate.object)
        return tag != null &&
          (!this.stockCornerPickAllowedIds ||
            this.stockCornerPickAllowedIds.has(tag.stockId))
      })
    if (!hit) return null
    const tag = this.findStockTag(hit.object)
    if (!tag) return null
    const group = this.fixedStockBoxes.get(tag.stockId)
    if (!group) return null
    const bounds = new THREE.Box3().setFromObject(group)
    if (bounds.isEmpty()) return null
    return resolveStockCornerPick(tag.stockId, hit.point, {
      min: bounds.min,
      max: bounds.max,
    })
  }

  // ---- Switch gizmo between translate and rotate ----
  setTransformMode(mode: 'translate' | 'rotate') {
    this.transformControls.setMode(mode)
  }

  // ---- Snap selected part's bottom face to Z=0 (table surface) ----
  dropPartToFloor(id: string) {
    const group = this.partGroups.get(id)
    if (!group) return

    // Force full matrix propagation before any world-space reads
    group.updateMatrixWorld(true)

    // Bypass Box3.setFromObject's geometry.boundingBox cache — it can be stale
    // after a quaternion change. Iterate every mesh vertex in world space instead.
    let minZ = Infinity
    const _v = new THREE.Vector3()
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      const pos = child.geometry.attributes.position
      for (let i = 0; i < pos.count; i++) {
        const wz = _v.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld).z
        if (wz < minZ) minZ = wz
      }
    })

    if (!isFinite(minZ)) return

    group.position.z -= minZ
    group.updateMatrixWorld(true)  // propagate the position change before rebuildStock
    this.rebuildStock()
    this.onPartTransformChange?.(
      id,
      { x: group.position.x, y: group.position.y, z: group.position.z },
      {
        x: THREE.MathUtils.radToDeg(group.rotation.x),
        y: THREE.MathUtils.radToDeg(group.rotation.y),
        z: THREE.MathUtils.radToDeg(group.rotation.z),
      }
    )
  }

  // ---- Toolpath ----
  // PP-MOVE-PICK: `moveOwners` (optional, aligned 1:1 to the RAW `moves` array)
  // attributes each drawn segment to its owning operation + in-op index so a
  // viewport click can resolve to a specific move. Omitted -> drawn identically
  // but not move-pickable.
  renderToolpath(moves: ToolpathMove[], clear = true, moveOwners?: (MoveOwner | null)[]) {
    if (clear) {
      this.toolpathGroup.clear()
      this.toolpathRoleLines.clear()
      this.resetToolpathPickState()
      this.clearToolpathDoneSplits()
    }
    this.toolpathGroup.visible = this.isToolpathVisibleRequested() && !this.isSimulationToolpathPreviewActive()
    if (moves.length < 2) return
    this.buildToolpathRoleObjects(moves, {
      targetGroup: this.toolpathGroup,
      roleMap: this.toolpathRoleLines,
      moveOwners,
      doneSplits: this.getToolpathDoneSplits(),
    })
    // A rebuild of the same program keeps its done moves dimmed; a caller that
    // loads a different program sets the boundary back to null.
    this.applyToolpathDoneBoundary()
  }

  /**
   * WO-2048: draw the static toolpath's moves before `firstRemainingMove` (an
   * index into the moves last passed to renderToolpath) dimmed, in the same
   * role colour and line weight, and the rest unchanged. Null draws the whole
   * path unchanged. Each role keeps one position buffer: the body's draw range
   * starts at the boundary and a second line over the same buffer draws the
   * part before it. The dimmed part is not move-pickable (the Control viewport,
   * the only caller, renders its path without move owners).
   */
  setToolpathDoneBoundary(firstRemainingMove: number | null) {
    const next = firstRemainingMove === null || !Number.isFinite(firstRemainingMove)
      ? null
      : Math.max(0, Math.floor(firstRemainingMove))
    if (next === (this.toolpathDoneBoundary ?? null)) return
    this.toolpathDoneBoundary = next
    this.applyToolpathDoneBoundary()
  }

  private applyToolpathDoneBoundary() {
    const boundary = this.toolpathDoneBoundary ?? null
    for (const split of this.getToolpathDoneSplits().values()) {
      // Segment s is owned by its 'to' move segRawIndex[s] (ascending), so the
      // done segments are the leading run whose owner is before the boundary.
      let done = 0
      if (boundary !== null) {
        let lo = 0
        let hi = split.segRawIndex.length
        while (lo < hi) {
          const mid = (lo + hi) >>> 1
          if (split.segRawIndex[mid] < boundary) lo = mid + 1
          else hi = mid
        }
        done = lo
      }
      split.body.geometry.setDrawRange(done * 2, Infinity)
      if (done === 0) {
        if (split.dimmed) split.dimmed.visible = false
        continue
      }
      if (!split.dimmed) split.dimmed = this.buildToolpathDoneLine(split)
      split.dimmed.geometry.setDrawRange(0, done * 2)
      split.dimmed.visible = true
    }
  }

  private buildToolpathDoneLine(split: ToolpathDoneSplit): THREE.LineSegments {
    const source = split.body.geometry
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', source.getAttribute('position'))
    const distances = source.getAttribute('lineDistance')
    if (distances) geo.setAttribute('lineDistance', distances)
    // Dimmed = the same role colour taken most of the way to the canvas, so
    // done moves recede without changing hue or line weight.
    const color = new THREE.Color(split.color).lerp(new THREE.Color(asNumber('--vp-canvas')), 0.7)
    // A multi-depth op repeats its XY pattern per step-down, so from Top the
    // done upper layer sits in front of the upcoming lower one. Drawn first and
    // writing no depth, done moves never hide a move still to come.
    const mat = split.dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 3, gapSize: 2, linewidth: 1, depthWrite: false })
      : new THREE.LineBasicMaterial({ color, linewidth: 1, depthWrite: false })
    const line = new THREE.LineSegments(geo, mat)
    line.renderOrder = split.body.renderOrder - 1
    line.userData.toolpathDone = true
    // A child of the role body, so role filters and toolpath visibility hide
    // it with the body.
    split.body.add(line)
    return line
  }

  private clearToolpathDoneSplits() {
    const splits = this.getToolpathDoneSplits()
    for (const split of splits.values()) {
      if (!split.dimmed) continue
      split.dimmed.removeFromParent()
      split.dimmed.geometry.dispose()
      ;(split.dimmed.material as THREE.Material).dispose()
    }
    splits.clear()
  }

  setHiddenToolpathRoles(hidden: Set<string>) {
    this.hiddenToolpathRoles = new Set(hidden)
    for (const [role, obj] of this.toolpathRoleLines) {
      obj.visible = !hidden.has(role)
    }
    for (const [role, obj] of this.getSimulationToolpathRoleLines()) {
      obj.visible = !hidden.has(role)
    }
  }

  private clearSimulationToolpathObjects() {
    const group = this.getSimulationToolpathGroup()
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Line)) return
      obj.geometry.dispose()
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const material of materials) material.dispose()
    })
    group.clear()
    this.getSimulationToolpathRoleLines().clear()
    this.simulationWindowLines?.clear()
    this.simulationWindowActive = false
  }

  /**
   * Replace the full static toolpath with one complete current-layer preview.
   * The overlay intentionally ignores stock depth so uncut portions of the
   * active layer remain readable. Passing null restores the normal full path.
   */
  setSimulationToolpathPreview(moves: ToolpathMove[] | null) {
    this.clearSimulationToolpathObjects()
    this.simulationToolpathPreviewActive = Boolean(moves && moves.length >= 2)

    if (moves && moves.length >= 2) {
      this.buildToolpathRoleObjects(moves, {
        targetGroup: this.getSimulationToolpathGroup(),
        roleMap: this.getSimulationToolpathRoleLines(),
        overlay: true,
      })
    }

    const requested = this.isToolpathVisibleRequested()
    this.toolpathGroup.visible = requested && !this.simulationToolpathPreviewActive
    this.getSimulationToolpathGroup().visible = requested && this.simulationToolpathPreviewActive
  }

  /** Bounded render-only cursor overlay. Buffers survive every playback tick. */
  setSimulationToolpathWindow(segments: ToolpathWindowSegment[] | null) {
    if (segments === null) {
      this.setSimulationToolpathPreview(null)
      return
    }
    if (!this.simulationWindowActive) {
      this.clearSimulationToolpathObjects()
      this.simulationWindowActive = true
    }
    const lines = this.simulationWindowLines ??= new Map()
    for (const line of lines.values()) line.geometry.setDrawRange(0, 0)
    // Bound even callers outside the panel. No full path sampling or geometry
    // disposal happens here; each role/phase owns one fixed-capacity buffer.
    const capacity = TOOLPATH_WINDOW_SIDE_LIMIT * 2
    for (let i = 0; i < Math.min(segments.length, capacity); i++) {
      const segment = segments[i]
      const role = segment.frame.role
      const key = `${segment.phase}:${role}`
      let line = lines.get(key)
      if (!line) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 6), 3).setUsage(THREE.DynamicDrawUsage))
        geo.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(capacity * 2), 1).setUsage(THREE.DynamicDrawUsage))
        const options = {
          color: ROLE_COLORS[role] ?? asNumber('--role-unknown'),
          transparent: true, opacity: segment.phase === 'recent' ? 0.4 : 1,
          depthTest: false, depthWrite: false,
        }
        const material = ROLE_DASHED.has(role)
          ? new THREE.LineDashedMaterial({ ...options, dashSize: 3, gapSize: 2 })
          : new THREE.LineBasicMaterial(options)
        line = new THREE.LineSegments(geo, material)
        line.renderOrder = 3000
        line.frustumCulled = false
        line.userData.toolpathWindowPhase = segment.phase
        let roleGroup = this.getSimulationToolpathRoleLines().get(role)
        if (!roleGroup) {
          roleGroup = new THREE.Group()
          roleGroup.visible = !this.getHiddenToolpathRoles().has(role)
          this.getSimulationToolpathRoleLines().set(role, roleGroup)
          this.getSimulationToolpathGroup().add(roleGroup)
        }
        roleGroup.add(line)
        geo.setDrawRange(0, 0)
        lines.set(key, line)
      }
      const geo = line.geometry
      const count = geo.drawRange.count
      const position = geo.getAttribute('position') as THREE.BufferAttribute
      position.setXYZ(count, segment.fromX, segment.fromY, segment.fromZ)
      position.setXYZ(count + 1, segment.toX, segment.toY, segment.toZ)
      position.needsUpdate = true
      const distance = geo.getAttribute('lineDistance') as THREE.BufferAttribute
      distance.setX(count, 0)
      distance.setX(count + 1, Math.hypot(segment.toX - segment.fromX, segment.toY - segment.fromY, segment.toZ - segment.fromZ))
      distance.needsUpdate = true
      geo.setDrawRange(0, count + 2)
    }
    // An empty window still owns the display (never reveals an unrelated full path).
    this.simulationToolpathPreviewActive = true
    this.toolpathGroup.visible = false
    this.getSimulationToolpathGroup().visible = this.isToolpathVisibleRequested()
  }

  /**
   * Shared per-role toolpath construction for the static Toolpath surface
   * (renderToolpath) and the Simulation overlay (setSimulationToolpathPreview).
   * The three axes that varied between the former duplicates are explicit
   * options, so either surface can gain the other's capability by changing an
   * option instead of editing a second copy:
   *   - target:     which Group + role-line map receives the built objects.
   *   - overlay:    true ignores stock depth (depthTest/depthWrite false) and
   *                 renders on top (renderOrder 3000) so the path draws over
   *                 stock; false respects depth (Toolpath tab).
   *   - moveOwners: when supplied, each role body is tagged with a
   *                 ToolpathPickPayload and registered for move-pick raycasting;
   *                 omitted draws identically but is not move-pickable.
   * Hidden-role visibility is applied here so callers do not re-walk the map.
   */
  private buildToolpathRoleObjects(
    moves: ToolpathMove[],
    options: {
      targetGroup: THREE.Group
      roleMap: Map<string, THREE.Object3D>
      overlay?: boolean
      moveOwners?: (MoveOwner | null)[]
      /** WO-2048: receives each role body for setToolpathDoneBoundary. */
      doneSplits?: Map<string, ToolpathDoneSplit>
    },
  ): void {
    const { targetGroup, roleMap, overlay = false, moveOwners, doneSplits } = options
    const depthOpts = overlay ? { depthTest: false, depthWrite: false } : {}
    for (const [role, data] of buildToolpathRoleSegmentsIndexed(moves, moveOwners)) {
      const positions = data.positions
      const color = ROLE_COLORS[role] ?? asNumber('--role-unknown')
      const dashed = ROLE_DASHED.has(role)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 3, gapSize: 2, linewidth: 1, ...depthOpts })
        : new THREE.LineBasicMaterial({ color, linewidth: 1, ...depthOpts })
      const body = new THREE.LineSegments(geo, mat)
      if (overlay) body.renderOrder = 3000
      if (dashed) body.computeLineDistances()

      if (moveOwners) {
        const payload: ToolpathPickPayload = {
          role, segOwners: data.segOwners, segRawIndex: data.segRawIndex, rawMoves: moves,
        }
        body.userData.toolpathPick = payload
        this.toolpathPickBodies.push(body)
      }
      doneSplits?.set(role, { body, segRawIndex: data.segRawIndex, color, dashed, dimmed: null })

      let roleObject: THREE.Object3D = body
      if (ROLE_END_CAPPED.has(role)) {
        const caps = buildEndCaps(positions, TOOLPATH_CAP_LEN)
        if (caps) {
          // WO-2048: a done move's solid caps dim with its dashed body.
          const byOwner = doneSplits ? endCapsByOwner(positions, data.segRawIndex, caps) : null
          const capGeo = new THREE.BufferGeometry()
          capGeo.setAttribute('position', new THREE.BufferAttribute(byOwner?.caps ?? caps, 3))
          const capLine = new THREE.LineSegments(
            capGeo,
            new THREE.LineBasicMaterial({ color, linewidth: 1, ...depthOpts }),
          )
          capLine.userData.toolpathEndCaps = true
          if (overlay) capLine.renderOrder = 3000
          if (byOwner) {
            doneSplits?.set(`${role}:caps`, { body: capLine, segRawIndex: byOwner.owners, color, dashed: false, dimmed: null })
          }
          const grp = new THREE.Group()
          grp.add(body, capLine)
          roleObject = grp
        }
      }

      roleObject.visible = !this.getHiddenToolpathRoles().has(role)
      targetGroup.add(roleObject)
      roleMap.set(role, roleObject)
    }
  }

  // ---- PP-MOVE-PICK: toolpath move picking ----
  /** Install the move-pick callbacks (once, at mount). `onSelect` fires with the
   *  picked move (or null to clear); `onHover` fires with the hovered move (or
   *  null), the second arg `refused` true when a hit could not resolve (ADR-0003,
   *  so the shell logs a refusal BY NAME to the console). The viewport only fires
   *  these while the toolpath is visible (Toolpath view). */
  setMoveSelectCallback(
    onSelect: (sel: SelectedMove | null) => void,
    onHover?: (sel: SelectedMove | null, refused: boolean) => void,
  ) {
    this.moveSelectCallback = onSelect
    this.moveHoverCallback = onHover
  }

  /** Raycast the current ray against the toolpath bodies and resolve a picked
   *  move. Returns the facts, `{ refused: true }` when a segment is hit but is an
   *  un-owned synthetic link, or null on a miss. Caller sets the ray first. */
  private resolveMovePickAtRay(): SelectedMove | { refused: true } | null {
    if (this.toolpathPickBodies.length === 0) return null
    const tol = this.worldUnitsPerPixel() * CNCViewport.MOVE_PICK_TOLERANCE_PX
    const prev = this.raycaster.params.Line.threshold
    this.raycaster.params.Line.threshold = tol
    const hits = this.raycaster.intersectObjects(this.toolpathPickBodies, false)
    this.raycaster.params.Line.threshold = prev
    const hit = hits.find((h) => h.index != null && (h.object as THREE.Object3D).visible !== false)
    if (!hit) return null
    const body = hit.object as THREE.LineSegments
    const payload = body.userData.toolpathPick as ToolpathPickPayload | undefined
    if (!payload) return null
    const positions = (body.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    return resolveMovePickFromSegment(payload, positions, Math.floor(hit.index! / 2))
  }

  /** PP-MOVE-PICK: dedicated always-on pointermove listener (attached at
   *  construction, like the 'click' handler and mirroring `handleBrepHoverMove`)
   *  — the shared `handleMouseMove` is only attached during specific pick MODES,
   *  so normal Toolpath-view hover needs its own listener. Highlights the segment
   *  under the cursor (hover preview of exactly what a click would pick) and sets
   *  a pointer cursor. Inert unless in Toolpath view, normal interaction, with no
   *  other pick mode owning the pointer. */
  private handleMoveHoverMove = (event: MouseEvent) => {
    if (!this.moveSelectCallback || !this.toolpathGroup.visible || this.toolpathPickBodies.length === 0) return
    if (
      this.interactionMode !== 'normal' || this.brepPickKind || this.loopPickCallback ||
      this.partPickCallback || this.vertexPickCallback || this.tabEditCallbacks ||
      this.stockCornerPickCallback
    ) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.mouse, this.camera)
    const hover = this.resolveMovePickAtRay()
    if (hover && 'operationId' in hover) {
      const changed = this.applyMoveHover(hover)
      this.renderer.domElement.style.cursor = 'pointer'
      if (changed) this.moveHoverCallback?.(hover, false) // fire only on change
    } else {
      const had = this.hoveredMoveKey !== null
      this.clearMoveHover()
      if (had) { this.renderer.domElement.style.cursor = ''; this.moveHoverCallback?.(null, false) }
    }
  }

  /** Build a bright fat-line overlay for one picked/hovered segment, drawn on
   *  top (depthTest off) so it reads clearly over the base toolpath line. Reuses
   *  the shared selection-glow color the B-rep highlights use. */
  private buildMoveOverlay(sel: SelectedMove, variant: 'picked' | 'hover'): THREE.Object3D {
    const color = variant === 'picked' ? this.brepPickColor() : this.brepHoverColor()
    const pts = [sel.from.x, sel.from.y, sel.from.z, sel.to.x, sel.to.y, sel.to.z]
    const lineGeo = new LineGeometry()
    lineGeo.setPositions(pts)
    const mat = new LineMaterial({
      color,
      linewidth: variant === 'picked' ? 5 : 4,
      worldUnits: false,
      depthTest: false,
      transparent: variant === 'hover',
      opacity: variant === 'hover' ? 0.7 : 1,
      toneMapped: false,
    })
    const rect = this.renderer.domElement.getBoundingClientRect()
    const dpr = this.renderer.getPixelRatio()
    mat.resolution.set(Math.max(1, rect.width) * dpr, Math.max(1, rect.height) * dpr)
    const line = new Line2(lineGeo, mat)
    line.renderOrder = variant === 'picked' ? 101 : 100
    return line
  }

  private disposeMoveOverlay(obj: THREE.Object3D | null): null {
    if (!obj) return null
    this.scene.remove(obj)
    const line = obj as Line2
    line.geometry?.dispose?.()
    const mat = line.material as LineMaterial | undefined
    mat?.dispose?.()
    return null
  }

  /** Show the persistent selection highlight for the picked move. */
  private applyMoveHighlight(sel: SelectedMove) {
    this.moveSelectOverlay = this.disposeMoveOverlay(this.moveSelectOverlay)
    this.moveSelectOverlay = this.buildMoveOverlay(sel, 'picked')
    this.scene.add(this.moveSelectOverlay)
  }

  /** Show the transient hover highlight for the segment under the cursor.
   *  Returns true when the hovered move CHANGED (so the caller fires the hover
   *  callback only on change, not on every pointer pixel). */
  private applyMoveHover(sel: SelectedMove): boolean {
    const key = `${sel.operationId}|${sel.moveIndex}`
    if (this.hoveredMoveKey === key) return false
    this.hoveredMoveKey = key
    this.moveHoverOverlay = this.disposeMoveOverlay(this.moveHoverOverlay)
    this.moveHoverOverlay = this.buildMoveOverlay(sel, 'hover')
    this.scene.add(this.moveHoverOverlay)
    return true
  }

  private clearMoveHover() {
    if (this.moveHoverOverlay || this.hoveredMoveKey !== null) {
      this.moveHoverOverlay = this.disposeMoveOverlay(this.moveHoverOverlay)
      this.hoveredMoveKey = null
    }
  }

  /** Tear down all move-pick geometry + overlays (called when the toolpath is
   *  cleared/rebuilt; the stale segments the overlays referenced are gone). */
  private resetToolpathPickState() {
    this.toolpathPickBodies = []
    this.moveSelectOverlay = this.disposeMoveOverlay(this.moveSelectOverlay)
    this.moveHoverOverlay = this.disposeMoveOverlay(this.moveHoverOverlay)
    this.hoveredMoveKey = null
  }

  // ---- Carved-stock preview (Chunk C3) ----
  // Render the CARVED stock (the block with material removed) produced by the
  // 3D adaptive rougher (toMesh of the final ZDexelField), so the removal is
  // visible in the viewport alongside the toolpath. The mesh vertices are in the
  // part's DISPLAY-LOCAL frame; the GROUP carries the placement, reproducing the
  // store's world transform EXACTLY (world = position + Rz(local), Rz about the
  // local z-axis through the origin, then translate by position INCLUDING z) --
  // the same discipline addBrepModel uses. No per-vertex CPU transform.
  // NOTE: toMesh emits NO normals (computeVertexNormals here); the z-dexel walls
  // are cell-staircased -- exact for open-topped monotone pockets (e.g. the
  // Tray), true tri-dexel wall fidelity deferred (D-003).
  showCarvedStock(
    id: string,
    positions: Float32Array,
    indices: Uint32Array,
    position: { x: number; y: number; z: number },
    rotationZDeg: number,
  ) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    // Muted warm tan/gray, visually distinct from the part; flat-shaded so the
    // z-dexel facets read as machined stair-steps.
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xb8a888),
      roughness: 0.85,
      metalness: 0.1,
      flatShading: true,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = `carved-stock:${id}`

    const group = new THREE.Group()
    group.name = `carvedStock:${id}`
    markStockRemovalBody(group, 'adaptive-preview')
    group.add(mesh)
    group.position.set(position.x, position.y, position.z)
    group.rotation.z = (rotationZDeg * Math.PI) / 180

    // Replace an existing carved group for this id (recompute): same remove-old /
    // dispose / replace discipline as addBrepModel.
    const old = this.carvedStockGroups.get(id)
    if (old) {
      this.scene.remove(old)
      this.disposeGroup(old)
    }
    this.carvedStockGroups.set(id, group)
    this.scene.add(group)

    // Hide the plain rectangular stock block while a carved preview is shown,
    // exactly as the sim paths do.
    this.syncStaticStockVisibility()
  }

  clearCarvedStock(id?: string) {
    if (id !== undefined) {
      const g = this.carvedStockGroups.get(id)
      if (g) {
        this.scene.remove(g)
        this.disposeGroup(g)
        this.carvedStockGroups.delete(id)
      }
    } else {
      for (const g of this.carvedStockGroups.values()) {
        this.scene.remove(g)
        this.disposeGroup(g)
      }
      this.carvedStockGroups.clear()
    }
    // Restore the user's plain-stock preference once no replacement remains.
    this.syncStaticStockVisibility()
  }

  // ---- Visibility toggles ----
  private syncStaticStockVisibility(): void {
    const replacementStockExists =
      this.stockSimGroup != null
      || this.voxelSimGroup != null
      || (this.carvedStockGroups?.size ?? 0) > 0
    const requested = this.stockVisibleRequested ?? true
    this.stockGroup.visible = requested && !replacementStockExists
  }

  setStockVisible(v: boolean) {
    this.stockVisibleRequested = v
    this.syncStaticStockVisibility()
  }
  setWorkpieceVisible(v: boolean) {
    this.workpieceGroup.visible = v
    this.syncAllPartSectionCapVisibility()
    this._worldPlaneLoopGroups.forEach(g => { g.visible = v })
    // Parented local groups follow workpieceGroup; scene-root fallbacks need the flag
    this._geoLocalLoopGroups.forEach(g => { g.visible = v })
  }
  setToolpathVisible(v: boolean) {
    this.toolpathVisibleRequested = v
    this.toolpathGroup.visible = v && !this.simulationToolpathPreviewActive
    this.getSimulationToolpathGroup().visible = v && this.simulationToolpathPreviewActive
  }

  /** Feature B: set the user-requested Compare opacity for either sim engine.
   *  The shared display resolver composes it with Translucent without destroying
   *  the requested value, so leaving Translucent restores Compare exactly. */
  setStockSimOpacity(opacity: number) {
    this.stockSimOpacity = Number.isFinite(opacity)
      ? THREE.MathUtils.clamp(opacity, 0, 1)
      : 1
    this.applyStockSimDisplayMode()
  }
  setStockSimVisible(visible: boolean) {
    if (this.stockSimGroup) this.stockSimGroup.visible = visible
    if (this.voxelSimGroup) this.voxelSimGroup.visible = visible
  }
  setGridVisible(v: boolean) { this.gridGroup.visible = v }
  setAxesVisible(v: boolean) { this.wcsGroup.visible = v }

  /** Show/hide the violet seed-slot bounding-box outlines drawn by
   *  addNestInstances. Stores the state so compute-time-created outlines respect
   *  it (no flash), and toggles .visible on every existing 'seed-outline'
   *  descendant in the scene. Default ON (Operator is test-driving the marker). */
  setSeedOutlineVisible(visible: boolean) {
    this.seedOutlineVisible = visible
    this.scene.traverse((obj) => {
      if (obj.name === 'seed-outline') obj.visible = visible
    })
  }
  setMachineVisible(v: boolean) {
    this.machineGroup.visible = v
    this.machineTravelBorderGroup.visible = v
  }

  // ---- Display (shading) modes ----
  // Set the active CAD shading mode and re-apply across all part + stock materials.
  // No explicit render call needed — the continuous animation loop repaints (mirrors
  // the visibility setters above).
  setShadingMode(mode: ShadingMode) { this.currentShadingMode = mode; this.applyShadingMode() }

  /** Apply one display-mode contract to whichever stock-simulation engine is live. */
  private applyStockSimDisplayMode(): void {
    // Object.create(CNCViewport.prototype) test harnesses bypass field initializers.
    const mode = this.currentShadingMode ?? DEFAULT_SHADING_MODE
    const opacity = Number.isFinite(this.stockSimOpacity) ? this.stockSimOpacity : 1
    const style = stockSimDisplayStyle(mode, opacity)

    if (this.stockSimSurfaceMesh) {
      this.stockSimSurfaceMesh.visible = style.fillVisible
      const material = this.stockSimSurfaceMesh.material
      material.wireframe = false
      material.opacity = style.opacity
      material.transparent = style.transparent
      material.depthWrite = style.depthWrite
      material.needsUpdate = true
    }
    if (this.stockSimEdgeMesh) {
      this.stockSimEdgeMesh.visible = style.edgesVisible
      const material = this.stockSimEdgeMesh.material
      const edgeStyle = resolveModeledBodyEdgeModeStyle(mode)
      material.color.set(edgeStyle.color)
      material.opacity = style.opacity * edgeStyle.opacity
      material.transparent = style.transparent || material.opacity < 1
      // The surface owns depth. Edges test against it but never occlude later
      // scene objects or the target body during Compare/Translucent rendering.
      material.depthWrite = false
      material.needsUpdate = true
    }
    if (this.voxelSimMaterial) {
      applyVoxelSimDisplayMode(this.voxelSimMaterial, mode, opacity)
    }
  }

  /** Keep CAM on the same mode -> edge-renderer contract as Model. A display
   * mode transition can cross the native depth-tested <-> screen-space
   * wireframe boundary, which requires replacing the render object rather
   * than only mutating its material. */
  private syncPartEdgeTechniquesForMode(): void {
    const shouldBeFat = modeledBodyEdgeUsesFatLines(this.currentShadingMode)
    for (const [partId, group] of this.partGroups) {
      const mesh = group.children.find(
        (child) => child instanceof THREE.Mesh
          && child.userData.isBodyEdgeOverlay !== true
          && (child.userData.isBodyPresentationMesh === true
            || child.userData.isBrepMesh === true
            || child.userData.isModelBodyMesh === true),
      ) as THREE.Mesh | undefined
      if (mesh === undefined) continue
      if (mesh.userData.isBrepMesh === true) {
        this.applyBrepEdgeTheme(mesh, partId)
        continue
      }
      const oldEdge = mesh.children.find(
        (child) => child.userData.isDisplayEdge === true,
      ) as THREE.LineSegments | LineSegments2 | undefined
      const positions = this.partEdgePositions.get(partId)
      if (oldEdge === undefined || positions === undefined) continue
      const wasFat = oldEdge instanceof LineSegments2
      if (wasFat === shouldBeFat) {
        applyBodyEdgeOverlayStyle(oldEdge as THREE.LineSegments, resolveModeledBodyEdgeModeStyle(this.currentShadingMode))
        continue
      }
      mesh.remove(oldEdge)
      oldEdge.geometry.dispose()
      const oldMaterials = Array.isArray(oldEdge.material) ? oldEdge.material : [oldEdge.material]
      for (const material of oldMaterials) material.dispose()
      const newEdge = this.buildPartEdgeOverlay(positions)
      newEdge.userData = { ...oldEdge.userData, isDisplayEdge: true }
      newEdge.visible = modeledBodyEdgesVisibleForMode(this.currentShadingMode)
      mesh.add(newEdge)
    }
  }

  // Apply the current shading mode to every part + stock material, lazily capturing
  // each material's pristine baseline so any later mode change can restore it
  // (default mode = baseline restore = visual no-op). Also toggles the baked display
  // edges per the mode. Called on mode change AND at the tail of rebuildStock so
  // newly created geometry adopts the active mode + captures its baseline. Never
  // touches material.emissive, so part-selection highlighting composes.
  private applyShadingMode() {
    const mode = this.currentShadingMode
    this.syncPartEdgeTechniquesForMode()
    const applyMat = (mat: THREE.MeshStandardMaterial, modeledBody = false) => {
      let base = this.materialBaselines.get(mat)
      if (!base) { base = captureMaterialBaseline(mat); this.materialBaselines.set(mat, base) }
      if (modeledBody) applyModeledBodyShadingToMaterial(mat, base, mode)
      else applyShadingToMaterial(mat, base, mode)
    }
    // INT-17A modeled bodies are the only CAM meshes that use the B-rep
    // topology filter. Imported STEP/STL and stock keep their established
    // generic material behavior; STL facet semantics are a future UI choice.
    this.partGroups.forEach((group) => {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
          applyMat(o.material, o.userData.isModelBodyMesh === true)
        }
      })
    })
    this.stockGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = (o as THREE.Mesh).material
        if (m instanceof THREE.MeshStandardMaterial) applyMat(m)
      }
    })
    const show = edgesVisibleForMode(mode)
    const toggle = (root: THREE.Object3D) =>
      root.traverse((o) => {
        if (!o.userData?.isDisplayEdge) return
        const isModeledBodyEdge = o.parent?.userData.isModelBodyMesh === true
        if (isModeledBodyEdge) {
          applyBodyEdgeOverlayStyle(
            o as THREE.LineSegments,
            resolveModeledBodyEdgeModeStyle(mode),
          )
        }
        o.visible = isModeledBodyEdge ? modeledBodyEdgesVisibleForMode(mode) : show
      })
    this.partGroups.forEach((g) => toggle(g))
    toggle(this.stockGroup)
    for (const outline of this.getPartInteractionOutlines().values()) {
      outline.visible = interactionOverlayVisibleForMode('body', mode)
    }
    if (this.brepHoverObj != null) {
      this.brepHoverObj.visible = interactionOverlayVisibleForMode(
        this.brepHoverKey?.includes('|edge|') ? 'edge' : 'face',
        mode,
      )
      // WO-351: brepHighlightColorFor reads the LIVE material wireframe/
      // transparent state applyMat() just mutated above -- a mode switch can
      // flip whether an opaque fill sits behind an ALREADY-BUILT overlay
      // without any new pick/hover event, so re-resolve here or a stale
      // colour strands the same collision through a different door.
      const hoverGeoId = this.brepHoverKey?.split('|')[0]
      const hoverKind = this.brepHoverKey?.includes('|edge|') ? 'edge' : 'face'
      if (hoverGeoId) syncInteractionColor(this.brepHoverObj, this.brepHighlightColorFor(hoverGeoId, hoverKind, 'hover'))
    }
    for (const [key, overlay] of this.getBrepHighlights()) {
      const kind = key.includes('|edge|') ? 'edge' : 'face'
      overlay.visible = interactionOverlayVisibleForMode(kind, mode)
      syncInteractionColor(overlay, this.brepHighlightColorFor(key.split('|')[0], kind, 'picked'))
    }
    this.syncAllPartSectionCapVisibility()
    this.applyStockSimDisplayMode()
  }

  // ---- Section view ----
  // Enable/disable a single world-axis section clip plane across all part + stock
  // materials. The actual section-positioning UI lands in a later task; this is the
  // working state-plumbing setter. Disabled -> clears clippingPlanes (no clip).
  setSectionView(opts: { enabled: boolean; axis: SectionAxis; position: number; flip: boolean }) {
    this.renderer.localClippingEnabled = opts.enabled
    const { normal, constant } = sectionPlaneParams(opts.axis, opts.position, opts.flip)
    this.clipPlane.set(new THREE.Vector3(normal[0], normal[1], normal[2]), constant)
    const planes = opts.enabled ? [this.clipPlane] : []
    this.sectionCaps?.setPlanes(planes)
    this.partMaterials.forEach((material) => this.applyCurrentSectionClipping(material))
    for (const group of this.partGroups.values()) {
      group.traverse((object) => {
        if (
          object.userData.isBodyEdgeOverlay !== true
          && object.userData.isDisplayEdge !== true
          && object.userData.isBrepEdges !== true
          && object.userData.isBrepFatEdge !== true
        ) {
          return
        }
        this.applyCurrentSectionClippingToObject(object)
      })
    }
    for (const outline of this.getPartInteractionOutlines().values()) syncInteractionClipping(outline, planes)
    if (this.brepHoverObj != null) syncInteractionClipping(this.brepHoverObj, planes)
    for (const overlay of this.getBrepHighlights().values()) syncInteractionClipping(overlay, planes)
    this.stockGroup.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(m)) m.forEach((material) => this.applyCurrentSectionClipping(material))
      else if (m) this.applyCurrentSectionClipping(m)
    })
  }

  // ---- Height planes ----
  updateHeightPlanes(config: {
    clearance: number; retract: number; feed?: number; top: number; bottom: number
    hidden?: string[]
  } | null) {
    this.heightPlanesGroup.clear()
    if (!config) return

    // Plane size matches the large grid (visible context without extending to infinity)
    const planeSize = 800
    const planes: Array<{ z: number; color: number; label: string }> = [
      { z: config.clearance, color: asNumber('--vp-plane-clearance'), label: 'clearance' },
      { z: config.retract,   color: asNumber('--vp-plane-retract'),   label: 'retract'   },
      ...(config.feed !== undefined
        ? [{ z: config.feed, color: asNumber('--vp-plane-feed'), label: 'feed' }]
        : []),
      { z: config.top,       color: asNumber('--vp-plane-top'),       label: 'top'       },
      { z: config.bottom,    color: asNumber('--vp-plane-bottom'),    label: 'bottom'    },
    ]

    for (const { z, color, label } of planes) {
      if (config.hidden?.includes(label)) continue
      const geo = new THREE.PlaneGeometry(planeSize, planeSize)
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.07, side: THREE.DoubleSide,
        depthWrite: false, depthTest: false,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.renderOrder = -1
      // PlaneGeometry already lies in XY (normal = +Z), correct for Z-up CNC world
      mesh.position.z = z
      this.heightPlanesGroup.add(mesh)

      // V6 (manual-audit): the plane must read from ANY view direction. The old
      // marker was a SINGLE line spanning X only; from a side view looking down
      // +X that line is end-on and collapses to a point, so the plane vanished.
      // Keep the DASHED aesthetic (outline category, no endpoint-continuity
      // question) but give the marker structure in BOTH horizontal axes:
      //   - a dashed outline RECTANGLE around the plane perimeter, and
      //   - a dashed CENTER CROSS spanning X and Y through the middle,
      // so an edge-on view always shows dashed line work in the other axis. The
      // low-opacity (0.07) double-sided fill above also registers obliquely.
      const half = planeSize / 2
      const pts: THREE.Vector3[] = [
        // outline rectangle (4 edges as 4 segment pairs)
        new THREE.Vector3(-half, -half, z), new THREE.Vector3( half, -half, z),
        new THREE.Vector3( half, -half, z), new THREE.Vector3( half,  half, z),
        new THREE.Vector3( half,  half, z), new THREE.Vector3(-half,  half, z),
        new THREE.Vector3(-half,  half, z), new THREE.Vector3(-half, -half, z),
        // center cross: X axis line
        new THREE.Vector3(-half, 0, z), new THREE.Vector3( half, 0, z),
        // center cross: Y axis line (the axis that the old single line lacked)
        new THREE.Vector3(0, -half, z), new THREE.Vector3(0,  half, z),
      ]
      const edgeGeo = new THREE.BufferGeometry().setFromPoints(pts)
      const edgeMat = new THREE.LineDashedMaterial({
        color, transparent: true, opacity: 0.6, dashSize: 8, gapSize: 5,
      })
      const edgeLine = new THREE.LineSegments(edgeGeo, edgeMat)
      edgeLine.computeLineDistances()
      edgeLine.renderOrder = -1
      this.heightPlanesGroup.add(edgeLine)
    }
  }

  setHeightPlanesVisible(visible: boolean) {
    this.heightPlanesGroup.visible = visible
  }

  // ---- Tool marker ----
  updateToolGeometry(config: ToolGeoCfg) {
    this.toolGeoConfig = config
    // Rebuild if currently visible
    if (this.toolMarkerGroup) {
      const wasVisible = this.toolMarkerGroup.visible
      const pos = this.toolMarkerGroup.position.clone()
      this.toolMarkerGroup.parent?.remove(this.toolMarkerGroup)
      this.disposeGroup(this.toolMarkerGroup)
      this.toolMarkerGroup = null
      if (wasVisible) {
        this.showToolMarker(true)
        this.toolMarkerGroup!.position.copy(pos)
      }
    }
  }

  showToolMarker(visible: boolean) {
    if (visible && !this.toolMarkerGroup) {
      this.toolMarkerGroup = this.buildToolMesh(this.toolGeoConfig ?? {
        type: 'flat_end_mill', diameter: 6, shankDiameter: 6,
        fluteLength: 20, shoulderLength: 20, overallLength: 50,
        cornerRadius: 0, angleFromAxisDeg: 59,
      })
      this.programFrameGroup.add(this.toolMarkerGroup)
    }
    if (this.toolMarkerGroup) this.toolMarkerGroup.visible = visible
  }

  setToolMarkerPosition(x: number, y: number, z: number) {
    if (this.toolMarkerGroup) this.toolMarkerGroup.position.set(x, y, z)
  }

  /**
   * MACHINE-CONTROL: highlight the ONE move the machine is executing right now.
   *
   * renderToolpath batches by role into shared LineSegments buffers, so a
   * per-move recolor there would mean rebuilding the whole path every time the
   * program cursor advances. This keeps a single overlay line instead: cheap to
   * update at frame rate, drawn on top, and independent of role batching.
   * Pass null to clear it (no program running, or the cursor is off the path).
   */
  setActiveToolpathSegment(points: ReadonlyArray<{ x: number; y: number; z: number }> | null) {
    if (!points || points.length < 2) {
      if (this.activeProgramSegment) this.activeProgramSegment.visible = false
      return
    }
    const positions = new Float32Array(points.length * 3)
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x
      positions[i * 3 + 1] = points[i].y
      positions[i * 3 + 2] = points[i].z
    }
    if (!this.activeProgramSegment) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      // --accent-amber is the cursor colour the Control tab already used for
      // "the move happening now"; asNumber THROWS on an undefined token, so an
      // invented name here would kill the frame loop silently in the UI.
      const mat = new THREE.LineBasicMaterial({
        color: asNumber('--accent-amber'),
        linewidth: 2,
        depthTest: false,
      })
      const line = new THREE.Line(geo, mat)
      line.renderOrder = 999 // never buried inside the stock or the path
      this.activeProgramSegment = line
      this.programFrameGroup.add(line)
    } else {
      const geo = this.activeProgramSegment.geometry
      const attr = geo.getAttribute('position') as THREE.BufferAttribute | undefined
      if (attr && attr.count === points.length) {
        ;(attr.array as Float32Array).set(positions)
        attr.needsUpdate = true
      } else {
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      }
      geo.computeBoundingSphere()
    }
    this.activeProgramSegment.visible = true
  }

  // ── Stock removal simulation ────────────────────────────────────────────────

  initStockSim(cellSizeMm: number, stockId?: string): {
    x0: number; y0: number; nx: number; ny: number
    cellSize: number; stockTop: number; stockBot: number
  } | null {
    // Use the specific stock block for this setup if provided; fall back to full scene bounds
    let sb: { min: THREE.Vector3; max: THREE.Vector3 } | null = null
    if (stockId && this.fixedStockBoxes.has(stockId)) {
      const box = new THREE.Box3().setFromObject(this.fixedStockBoxes.get(stockId)!)
      sb = box.isEmpty() ? null : { min: box.min, max: box.max }
    } else {
      sb = this._stockBounds
    }
    if (!sb) return null
    // Symmetric with initVoxelSim: a live engine switch must never leave both
    // renderers in the scene. The voxel proxy is not valid heightmap geometry.
    this.disposeVoxelSim()
    this.disposeStockSim()

    const x0 = sb.min.x, y0 = sb.min.y
    const w  = sb.max.x - sb.min.x, h = sb.max.y - sb.min.y
    const stockTop = sb.max.z, stockBot = sb.min.z
    const nx = Math.max(2, Math.ceil(w / cellSizeMm))
    const ny = Math.max(2, Math.ceil(h / cellSizeMm))
    this.stockSimNx = nx; this.stockSimNy = ny

    // Discontinuity-aware hybrid mesh: 4 corner verts + 2 tris per cell (TOP),
    // plus a vertical wall quad per interior edge that opens only at cliffs (see
    // lib/viewport/stockSimMesh.ts). Cells derive from the exact grid spacing so
    // the surface tiles the stock bounds without gaps or overhang. The stock
    // bottom closes it: outer sides + bottom face (WO-2509), so stock left under
    // the deepest cut draws as a solid, not a floating sheet.
    const csx = w / nx
    const csy = h / ny
    const layout = buildStockSimTopology(nx, ny, csx, csy, x0, y0, stockBot)
    this.stockSimLayout = layout
    // Slope steeper than ~atan(factor) reads as a vertical wall. Single tunable.
    this.stockSimThreshold = STOCK_SIM_CLIFF_THRESHOLD_FACTOR * Math.min(csx, csy)

    // Seed every height at the uncut stock top so the first frame is flat.
    const seed = new Float32Array(nx * ny).fill(stockTop)
    updateStockSimMesh(seed, nx, ny, layout, this.stockSimThreshold)

    // Concatenate TOP then WALL verts into single position/normal/index buffers;
    // wall indices are offset by the top vert count. ONE BufferGeometry is
    // simpler than two child meshes and shares the material.
    const topVerts = nx * ny * 4
    this.stockSimTopVertCount = topVerts
    const wallVerts = layout.wallQuadCount * 4
    const totalVerts = topVerts + wallVerts

    const positions = new Float32Array(totalVerts * 3)
    positions.set(layout.topPositions, 0)
    positions.set(layout.wallPositions, topVerts * 3)
    const normals = new Float32Array(totalVerts * 3)
    normals.set(layout.topNormals, 0)
    normals.set(layout.wallNormals, topVerts * 3)

    const indices = new Uint32Array(layout.topIndices.length + layout.wallIndices.length)
    indices.set(layout.topIndices, 0)
    for (let i = 0; i < layout.wallIndices.length; i++) {
      indices[layout.topIndices.length + i] = layout.wallIndices[i] + topVerts
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    // Normals are authored by updateStockSimMesh -- do NOT computeVertexNormals
    // (it would average across the intentional cliff splits and re-round walls).
    this.stockSimGeometry = geo

    const mat = new THREE.MeshStandardMaterial({
      color: asNumber('--vp-sim-mesh'), roughness: 0.65, metalness: 0.1, side: THREE.DoubleSide,
      // The part stays visible during simulation and its top face is COPLANAR
      // (same Z) with this sim-stock mesh's uncut top -- both opaque, both write
      // depth, so the depth test is ambiguous per pixel = green speckle on the
      // flat top (same coplanar-z-fight family as the static stock fill fix). The
      // sim mesh must WIN that tie (it is the material being cut -- if the part
      // won, a removed region would still show the static part top floating over
      // the receded sim surface). NEGATIVE polygonOffset nudges this mesh's tested
      // depth TOWARD the camera so it consistently beats the coplanar part top.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
    const mesh = new THREE.Mesh(geo, mat)
    // No self-shadowing on the stock sim mesh: the hard PCF shadow map produced
    // diagonal hatching (shadow acne) on its flat top — same fix as part meshes.
    mesh.receiveShadow = false
    this.stockSimSurfaceMesh = mesh

    // Reuse the SAME dynamic geometry as an edge carrier. Position updates made
    // by updateStockSimHeights therefore reach fill and edges atomically with no
    // topology rebuild. MeshBasic wireframe renders the heightmap's real triangle
    // and cliff-wall topology; it is not a decorative stock AABB.
    const edgeMaterial = new THREE.MeshBasicMaterial({
      color: resolveModeledBodyEdgeModeStyle(this.currentShadingMode).color,
      wireframe: true,
      transparent: false,
      depthWrite: false,
    })
    // The filled simulation surface uses polygon offset to beat a coplanar
    // target face. Bias the edge carrier in clip space as well so it remains
    // visible over that fill while depth testing still occludes rear edges.
    const projectVertex = '#include <project_vertex>'
    edgeMaterial.userData.bodyEdgeNdcDepthBias = BODY_EDGE_NDC_DEPTH_BIAS
    edgeMaterial.onBeforeCompile = (shader): void => {
      if (!shader.vertexShader.includes(projectVertex)) {
        throw new Error('Stock-sim edge shader no longer exposes project_vertex')
      }
      shader.vertexShader = shader.vertexShader.replace(
        projectVertex,
        `${projectVertex}\ngl_Position.z -= ${BODY_EDGE_NDC_DEPTH_BIAS.toExponential()} * gl_Position.w;`,
      )
    }
    edgeMaterial.customProgramCacheKey = () => `stock-sim-edge-ndc-bias:${BODY_EDGE_NDC_DEPTH_BIAS}`
    const edgeMesh = new THREE.Mesh(geo, edgeMaterial)
    edgeMesh.renderOrder = mesh.renderOrder + 1
    this.stockSimEdgeMesh = edgeMesh

    this.stockSimGroup = new THREE.Group()
    markStockRemovalBody(this.stockSimGroup, 'heightmap')
    this.stockSimGroup.add(mesh, edgeMesh)
    this.scene.add(this.stockSimGroup)
    this.syncStaticStockVisibility()
    this.applyStockSimDisplayMode()

    return { x0, y0, nx, ny, cellSize: cellSizeMm, stockTop, stockBot }
  }

  updateStockSimHeights(heights: Float32Array): void {
    if (!this.stockSimGeometry || !this.stockSimLayout) return
    const layout = this.stockSimLayout
    const nx = this.stockSimNx, ny = this.stockSimNy

    // Re-mesh top Z + normals and the interior wall quads in place (fixed
    // topology -> no reallocation). Smooth where heights vary gently; true
    // vertical walls at cliffs.
    updateStockSimMesh(heights, nx, ny, layout, this.stockSimThreshold)

    const pos = this.stockSimGeometry.attributes.position as THREE.BufferAttribute
    const nrm = this.stockSimGeometry.attributes.normal as THREE.BufferAttribute
    const posArr = pos.array as Float32Array
    const nrmArr = nrm.array as Float32Array
    const topFloats = this.stockSimTopVertCount * 3
    posArr.set(layout.topPositions, 0)
    posArr.set(layout.wallPositions, topFloats)
    nrmArr.set(layout.topNormals, 0)
    nrmArr.set(layout.wallNormals, topFloats)

    pos.needsUpdate = true
    nrm.needsUpdate = true
    // Normals are authored manually -- no computeVertexNormals.
  }

  disposeStockSim(): void {
    if (this.stockSimGroup) {
      this.scene.remove(this.stockSimGroup)
      this.stockSimGroup.clear()
      this.stockSimGroup = null
    }
    // Fill and edge meshes intentionally share one geometry, so dispose it once.
    this.stockSimSurfaceMesh?.material.dispose()
    this.stockSimEdgeMesh?.material.dispose()
    this.stockSimGeometry?.dispose()
    this.stockSimSurfaceMesh = null
    this.stockSimEdgeMesh = null
    this.stockSimGeometry = null
    this.stockSimLayout = null
    this.stockSimThreshold = 0
    this.stockSimTopVertCount = 0
    this.syncStaticStockVisibility()
  }

  // ---- Voxel stock simulation (ADR-0028) ----
  // A PARALLEL render path to initStockSim/updateStockSimHeights/disposeStockSim
  // above. SimulationPanel selects between them via appSettings.simulationEngine; the
  // heightmap methods are left untouched. The voxel path raymarches a 3D SDF
  // texture (no surface mesh, no per-frame vertex re-upload).
  /** True if this GPU can run the 3D voxel sim (WebGL2 + float-3D-texture linear filtering). */
  supportsVoxelSim(): boolean {
    const caps = this.renderer.capabilities
    if (!caps.isWebGL2) return false
    const gl = this.renderer.getContext()
    return gl.getExtension('OES_texture_float_linear') != null
  }

  initVoxelSim(field: VoxelField): void {
    this.disposeVoxelSim()
    // The voxel and heightmap engines must never coexist: SimulationPanel calls
    // syncStockSimSurface() (-> initStockSim) to obtain the stock bounds, which
    // also builds the opaque heightmap sim mesh. In voxel mode that mesh is never
    // carved, so it would sit on top as a solid uncut block and fully MASK the
    // voxel volume. Tear it down here. (Root cause of the "block never cuts" bug.)
    this.disposeStockSim()

    const { x0, y0, z0, voxelSize, nx, ny, nz } = field.dims
    const fieldMin = new THREE.Vector3(x0, y0, z0)
    const fieldMax = new THREE.Vector3(
      x0 + nx * voxelSize,
      y0 + ny * voxelSize,
      z0 + nz * voxelSize,
    )

    // Match the lit heightmap stock-sim surface: same base colour token, and the
    // accent light colours with their scene intensities folded in so the
    // raymarched volume shades like the MeshStandard meshes around it (the shader
    // applies no intensity of its own — colour IS intensity here). GEO-23
    // AMENDMENT 1: the intensities + colour tokens now come from the ONE shared
    // CAM rig descriptor (rigDescriptors.ts CAM_ACCENT_LIGHTS / CAM_AMBIENT), the
    // same source setupLighting() and voxelSimMaterial.ts's baked directions read,
    // so a rig retune (L3) can never desync the sim surface from the bodies.
    const accent = (role: 'key' | 'fill' | 'rim'): CamAccentLightDescriptor => {
      const d = CAM_ACCENT_LIGHTS.find((l) => l.role === role)
      if (d === undefined) throw new Error(`GEO-23: CAM accent light '${role}' missing from rig descriptors`)
      return d
    }
    const baseColor = new THREE.Color(asNumber('--vp-sim-mesh'))
    // GEO-23 L1: the bodies get an IBL base this raymarch shader cannot sample;
    // fold a flat white stand-in (CAM_SIM_IBL_AMBIENT) into the sim's ambient so
    // the carved surface stays brightness-matched to the IBL-lit bodies.
    const ambient = new THREE.Color(asNumber(CAM_AMBIENT.token)).multiplyScalar(CAM_AMBIENT.intensity)
      .add(new THREE.Color(1, 1, 1).multiplyScalar(CAM_SIM_IBL_AMBIENT))
    const keyColor = new THREE.Color(asNumber(accent('key').token)).multiplyScalar(accent('key').intensity)
    const fillColor = new THREE.Color(asNumber(accent('fill').token)).multiplyScalar(accent('fill').intensity)
    const rimColor = new THREE.Color(asNumber(accent('rim').token)).multiplyScalar(accent('rim').intensity)

    this.voxelSimTexture = new VoxelSimTexture(field, this.renderer)
    this.voxelSimMaterial = createVoxelSimMaterial({
      texture: this.voxelSimTexture.texture,
      fieldMin,
      fieldMax,
      voxelSize,
      baseColor,
      ambient,
      keyColor,
      fillColor,
      rimColor,
      edgeColor: new THREE.Color(
        resolveModeledBodyEdgeModeStyle(this.currentShadingMode).color,
      ),
    })
    this.voxelSimMesh = buildVoxelSimMesh(this.voxelSimMaterial, fieldMin, fieldMax)

    this.voxelSimGroup = new THREE.Group()
    markStockRemovalBody(this.voxelSimGroup, 'voxel')
    this.voxelSimGroup.add(this.voxelSimMesh)
    this.scene.add(this.voxelSimGroup)
    this.syncStaticStockVisibility()
    this.applyStockSimDisplayMode()
  }

  /** Re-upload the carved field to the GPU (full re-upload when dirty). */
  syncVoxelSim(field: VoxelField): void {
    this.voxelSimTexture?.sync(field)
  }

  disposeVoxelSim(): void {
    if (this.voxelSimGroup) {
      this.scene.remove(this.voxelSimGroup)
      this.voxelSimGroup = null
    }
    if (this.voxelSimMesh) {
      this.voxelSimMesh.geometry.dispose()
      this.voxelSimMesh = null
    }
    if (this.voxelSimMaterial) {
      this.voxelSimMaterial.dispose()
      this.voxelSimMaterial = null
    }
    if (this.voxelSimTexture) {
      this.voxelSimTexture.dispose()
      this.voxelSimTexture = null
    }
    this.syncStaticStockVisibility()
  }

  private buildToolMesh(cfg: ToolGeoCfg): THREE.Group {
    const group = new THREE.Group()
    const RADIAL_SEGS = 48

    // Build a Tool-shaped object so the single source-of-truth profile builder
    // (../tool/toolProfile) drives the 3D mesh exactly like the 2D diagram + sim.
    const toolForProfile: Tool = {
      id: 'marker', name: 'marker',
      type: cfg.type as ToolType,
      diameter: Math.max(0.01, cfg.diameter),
      fluteLength: Math.max(0.01, cfg.fluteLength),
      shankDiameter: Math.max(cfg.diameter, cfg.shankDiameter),
      overallLength: Math.max(cfg.fluteLength + 1, cfg.overallLength),
      shoulderLength: cfg.shoulderLength || cfg.fluteLength,
      lengthBelowHolder: cfg.lengthBelowHolder,
      numberOfFlutes: 2,
      cornerRadius: cfg.cornerRadius,
      angleFromAxisDeg: cfg.angleFromAxisDeg,
      tipDiameter: cfg.tipDiameter,
      neckDiameter: cfg.neckDiameter,
      material: 'carbide', coating: 'none',
      notes: '', feedsAndSpeeds: {},
    }

    const profile = buildToolProfile(toolForProfile)
    const verts = profile.vertices
    const cutZ = profile.cuttingMaxZ

    // Revolve a {z,r} polyline about local +Y (LatheGeometry uses Vector2(x=r,y=z));
    // group.rotation.x = PI/2 then maps local +Y -> world +Z with the tip at the
    // origin. Returns null if fewer than 2 distinct points remain.
    const latheMesh = (pts: ProfileVertex[], color: number): THREE.Mesh | null => {
      if (pts.length < 2) return null
      const v2 = pts.map(p => new THREE.Vector2(Math.max(0, p.r), p.z))
      const geo = new THREE.LatheGeometry(v2, RADIAL_SEGS)
      const mat = new THREE.MeshPhongMaterial({
        color, transparent: true, opacity: 0.55, depthWrite: false, shininess: 60,
      })
      return new THREE.Mesh(geo, mat)
    }

    // END CAPS (fixes P2b top-view-invisibility): LatheGeometry emits ONLY the
    // revolved side wall, no end discs. Looking straight down the tool axis
    // (top view = world Z) every side-wall face is edge-on (~zero projected
    // area) and the open ends let you see through, so the marker vanishes. Add
    // a flat disc at each exposed band end with r>0 to give the Z view a solid
    // backstop. The disc lies in the local X-Z plane (perpendicular to the
    // revolve axis +Y), so from side views it is edge-on (~zero area) and the
    // silhouette is unchanged. Skip the internal cutZ boundary (where the
    // cutting + non-cutting bands meet) to avoid coincident z-fighting discs.
    const addCaps = (pts: ProfileVertex[], color: number) => {
      if (pts.length < 2) return
      for (const e of [pts[0], pts[pts.length - 1]]) {
        if (e.r <= 1e-6) continue
        if (Math.abs(e.z - cutZ) <= 1e-6) continue
        const disc = new THREE.CircleGeometry(Math.max(0, e.r), RADIAL_SEGS)
        disc.rotateX(-Math.PI / 2) // XY plane -> X-Z plane (perp to local +Y)
        disc.translate(0, e.z, 0)
        const mat = new THREE.MeshPhongMaterial({
          color, transparent: true, opacity: 0.55, depthWrite: false,
          shininess: 60, side: THREE.DoubleSide,
        })
        group.add(new THREE.Mesh(disc, mat))
      }
    }

    // Sample the profile radius at an arbitrary z (linear interp between verts) so
    // we can splice in an exact boundary point at cuttingMaxZ. Profile vertices are
    // monotonic-ish in z; walk and interpolate.
    const radiusAt = (z: number): number => {
      if (verts.length === 0) return 0
      for (let i = 0; i < verts.length - 1; i++) {
        const a = verts[i], b = verts[i + 1]
        const lo = Math.min(a.z, b.z), hi = Math.max(a.z, b.z)
        if (z >= lo && z <= hi) {
          if (b.z === a.z) return Math.max(a.r, b.r)
          const t = (z - a.z) / (b.z - a.z)
          return a.r + (b.r - a.r) * t
        }
      }
      return verts[verts.length - 1].r
    }

    // Split the profile into the CUTTING band (z <= cuttingMaxZ) and the
    // NON-CUTTING band (z >= cuttingMaxZ), both sharing an interpolated boundary
    // point at exactly cuttingMaxZ so the two lathes meet without a gap.
    const boundaryR = radiusAt(cutZ)
    const cutting: ProfileVertex[] = []
    const noncut: ProfileVertex[] = []
    for (const p of verts) {
      if (p.z <= cutZ + 1e-9) cutting.push(p)
      if (p.z >= cutZ - 1e-9) noncut.push(p)
    }
    // Ensure each band terminates/starts at the exact boundary radius.
    if (cutting.length === 0 || cutting[cutting.length - 1].z < cutZ - 1e-9) {
      cutting.push({ z: cutZ, r: boundaryR })
    }
    if (noncut.length === 0 || noncut[0].z > cutZ + 1e-9) {
      noncut.unshift({ z: cutZ, r: boundaryR })
    }

    const cutMesh = latheMesh(cutting, asNumber('--vp-tool-flutes'))
    if (cutMesh) group.add(cutMesh)
    addCaps(cutting, asNumber('--vp-tool-flutes'))
    const shankMesh = latheMesh(noncut, asNumber('--vp-tool-shank'))
    if (shankMesh) group.add(shankMesh)
    addCaps(noncut, asNumber('--vp-tool-shank'))

    // HOLDER: revolve the holder profile (built bottom-up from z=0) and lift its
    // bottom to local Y = lengthBelowHolder (fall back to overall length) so it
    // sits above the tool. Coloured with the shank/holder CSS var.
    if (cfg.holderSegments && cfg.holderSegments.length > 0) {
      const holderPts = buildHolderProfile({
        id: 'h', name: 'h', segments: cfg.holderSegments,
      })
      const holderBottomY = cfg.lengthBelowHolder ?? toolForProfile.overallLength
      const lifted = holderPts.map(p => ({ z: p.z + holderBottomY, r: p.r }))
      const holderMesh = latheMesh(lifted, asNumber('--vp-tool-shank'))
      if (holderMesh) group.add(holderMesh)
      addCaps(lifted, asNumber('--vp-tool-shank'))
    }

    // Rotate group so the tip is at the origin and the tool runs +Z (local +Y).
    group.rotation.x = Math.PI / 2
    return group
  }

  private disposeGroup(group: THREE.Group) {
    group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose())
        else obj.material.dispose()
      }
    })
  }

  // ---- Camera depth policy (WO UI-74, Operator N-36) ----

  private depthUnion = new THREE.Box3()
  private depthScratch = new THREE.Vector3()
  /** Reason the last depth pass refused, or null. A refusal leaves the previous
   *  slab in place rather than fitting a bad one. */
  private depthRefusal: string | null = null

  /** Why the last depth pass refused to refit, or null if it did not refuse.
   *
   *  STATE, not a verdict: this reports what the policy did, never whether
   *  anything is clipped. The acceptance gate measures clipping itself, off the
   *  live camera, so it cannot pass by agreeing with a copy of the code under
   *  test -- it reads this only to fail closed on a silent refusal (a refused
   *  pass leaves a STALE slab, which is a clip waiting to happen). */
  getDepthFitRefusal(): string | null { return this.depthRefusal }

  /** Fit near/far to EVERYTHING the camera actually draws, and do it now.
   *
   *  Called once per frame from the render loop rather than from a list of
   *  invalidation events. That is deliberate, and it is the UI-72 lesson stated
   *  the other way round: the scene here grows and mutates from many places
   *  (grid rebuilds on machine/spacing change, stock rebuilds on every part
   *  move, toolpaths stream in from a worker, nest previews, the voxel sim, the
   *  CAM sketcher), and an event list that must name all of them is an event
   *  list with a hole in it -- and a missed invalidation is a silently-returning
   *  clip bug of exactly the kind Operator said must NEVER, EVER happen again. The
   *  traversal is bounded by the drawable count and the per-geometry bounding
   *  boxes are version-cached, so the recurring cost is a short walk, measured
   *  and recorded in coordination/evidence/UI-74/perf/.
   *
   *  Returns true when the slab was refitted, false when it was left untouched
   *  (nothing drawable, or a refusal). */
  private applyCameraDepthFit(): boolean {
    const slab = computeCamDepthSlab(this.scene, this.camera, this.depthUnion, this.depthScratch)
    if (!slab.ok) {
      this.depthRefusal = slab.reason
      return false
    }
    this.depthRefusal = null
    if (slab.near === null) return false // nothing drawable: keep the defaults
    if (this.camera.near !== slab.near || this.camera.far !== slab.far) {
      this.camera.near = slab.near
      this.camera.far = slab.far
      this.camera.updateProjectionMatrix()
    }
    return true
  }

  /** Frame the TOOLPATH alone. fitAll() frames the whole scene - grid, machine
   *  envelope and all - which leaves a 30x40mm program as a speck at the
   *  origin. The Control tab wants the program filling the view. */
  fitToolpath(): boolean {
    if (this.toolpathGroup.children.length === 0) return false
    this.fitCameraToObject(this.toolpathGroup)
    return true
  }

  /** Frame the loaded program without changing the operator's current view
   *  angle. Used by the Control viewport's explicit Program extents button;
   *  the automatic program-load fit above intentionally retains its historic
   *  ISO reset. */
  fitToolpathPreservingView(): boolean {
    if (this.toolpathGroup.children.length === 0) return false
    const bbox = new THREE.Box3().setFromObject(this.toolpathGroup)
    return this.fitBoundsPreservingView({ min: bbox.min, max: bbox.max })
  }

  /** Recenter and scale the orthographic camera around explicit world bounds
   *  while preserving the current camera direction. The fit is measured after
   *  the eye is reseated on the new center, so angled views account for the
   *  projected width and height rather than relying on a world-axis maxDim. */
  fitBoundsPreservingView(bounds: {
    min: { x: number; y: number; z: number }
    max: { x: number; y: number; z: number }
  }): boolean {
    const values = [
      bounds.min.x, bounds.min.y, bounds.min.z,
      bounds.max.x, bounds.max.y, bounds.max.z,
    ]
    if (!values.every(Number.isFinite)) return false
    const bbox = new THREE.Box3(
      new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
      new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
    )
    if (bbox.isEmpty()) return false

    this.cameraUserPositioned = false
    const center = bbox.getCenter(new THREE.Vector3())
    const diagonal = bbox.getSize(new THREE.Vector3()).length()
    const viewDir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target)
    if (viewDir.lengthSq() < 1e-9) viewDir.set(0.7, -0.9, 0.6)
    viewDir.normalize()

    const damping = this.controls.enableDamping
    this.controls.enableDamping = false
    this.controls.update()
    const distance = Math.min(Math.max(diagonal * 5, 50), 5000)
    this.controls.target.copy(center)
    this.camera.position.copy(center).addScaledVector(viewDir, distance)
    this.camera.lookAt(center)
    this.camera.updateMatrixWorld(true)

    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const aspect = w / h
    let projectedHalfWidth = 0
    let projectedHalfHeight = 0
    const corner = new THREE.Vector3()
    for (let i = 0; i < 8; i += 1) {
      corner.set(
        (i & 1) ? bbox.max.x : bbox.min.x,
        (i & 2) ? bbox.max.y : bbox.min.y,
        (i & 4) ? bbox.max.z : bbox.min.z,
      ).applyMatrix4(this.camera.matrixWorldInverse)
      projectedHalfWidth = Math.max(projectedHalfWidth, Math.abs(corner.x))
      projectedHalfHeight = Math.max(projectedHalfHeight, Math.abs(corner.y))
    }

    const padding = 1.16
    this.frustumSize = Math.max(
      projectedHalfHeight * 2,
      (projectedHalfWidth * 2) / aspect,
      1,
    ) * padding
    this.camera.left = -this.frustumSize * aspect / 2
    this.camera.right = this.frustumSize * aspect / 2
    this.camera.top = this.frustumSize / 2
    this.camera.bottom = -this.frustumSize / 2
    this.camera.zoom = 1
    this.camera.updateProjectionMatrix()
    this.controls.update()
    this.controls.enableDamping = damping
    return true
  }

  // ---- Camera ----
  fitCameraToObject(object: THREE.Object3D) {
    const bbox = new THREE.Box3().setFromObject(object)
    if (bbox.isEmpty()) return
    const size = bbox.getSize(new THREE.Vector3())
    const center = bbox.getCenter(new THREE.Vector3())

    const maxDim = Math.max(size.x, size.y, size.z)
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const aspect = w / h

    this.frustumSize = maxDim * 2.5
    this.camera.left = -this.frustumSize * aspect / 2
    this.camera.right = this.frustumSize * aspect / 2
    this.camera.top = this.frustumSize / 2
    this.camera.bottom = -this.frustumSize / 2
    this.camera.zoom = 1
    this.camera.updateProjectionMatrix()

    const distance = maxDim * 5
    this.controls.target.copy(center)
    this.camera.position.set(
      center.x + distance * 0.7,
      center.y - distance * 0.9,
      center.z + distance * 0.6
    )
    this.camera.lookAt(center)
    this.controls.update()
  }

  fitAll() {
    // Explicit user reframe (DesignTree "fit" button): the user is re-taking
    // control of framing, so drop the refresh-restore auto-fit suppression.
    this.cameraUserPositioned = false
    if (this.partGroups.size > 0) {
      this.fitCameraToObject(this.workpieceGroup)
    }
  }

  setCameraView(view: 'top' | 'front' | 'right' | 'iso' | 'back' | 'left' | 'bottom') {
    // Explicit user view change (ViewCube / toolbar; also enterSketchView's
    // forced 'top'): the user is choosing framing, so drop the refresh-restore
    // auto-fit suppression. (Sketch mode restores its own saved pose on exit.)
    this.cameraUserPositioned = false
    // B15: with enableDamping on, the render loop's controls.update() keeps
    // applying the leftover orbit velocity (sphericalDelta / panOffset) from
    // a just-finished drag AFTER this programmatic set, dragging the camera
    // off the exact face pose (first click lands ~almost aligned, second
    // click snaps exact). One update() with damping disabled flushes and
    // zeroes those internal deltas, so the pose set below is final. Done
    // BEFORE reading the target so a pan residual cannot shift it afterwards.
    const damping = this.controls.enableDamping
    this.controls.enableDamping = false
    this.controls.update()

    const target = this.controls.target.clone()
    const dist = this.camera.position.distanceTo(target)
    const views = {
      top:    new THREE.Vector3(target.x, target.y, target.z + dist),
      front:  new THREE.Vector3(target.x, target.y - dist, target.z),
      right:  new THREE.Vector3(target.x + dist, target.y, target.z),
      iso:    new THREE.Vector3(target.x + dist * 0.7, target.y - dist * 0.7, target.z + dist * 0.5),
      back:   new THREE.Vector3(target.x, target.y + dist, target.z),
      left:   new THREE.Vector3(target.x - dist, target.y, target.z),
      bottom: new THREE.Vector3(target.x, target.y, target.z - dist),
    }
    this.camera.position.copy(views[view])
    this.camera.lookAt(target)
    this.controls.update() // damping still off: syncs controls, moves nothing
    this.controls.enableDamping = damping
  }

  /**
   * Carry the current camera pose with a point in the Control preview's program
   * frame. Both the OrbitControls target and camera move by the same delta, so
   * zoom, view angle, and an orbit made while following survive exactly.
   *
   * After the first focus, deltas are measured from the prior cutter point -
   * not from controls.target. That distinction lets an explicit pan become a
   * durable screen-space offset instead of being erased on the next frame.
   * Passing null only ends tracking; it deliberately leaves the camera where it
   * is. The next non-null point recenters from that retained pose.
   */
  setOrbitFocus(point: { x: number; y: number; z: number } | null): void {
    if (point === null) {
      this.orbitFocusActive = false
      return
    }

    // Object.create(CNCViewport.prototype) is an established headless-test seam,
    // so tolerate class fields that were not initialized by the constructor.
    const focusWorld = this.orbitFocusWorld
      ?? (this.orbitFocusWorld = new THREE.Vector3())
    const delta = this.orbitFocusDelta
      ?? (this.orbitFocusDelta = new THREE.Vector3())
    this.programFrameGroup.updateWorldMatrix(true, false)
    delta.set(point.x, point.y, point.z).applyMatrix4(this.programFrameGroup.matrixWorld)
    if (this.orbitFocusActive) delta.sub(focusWorld)
    else delta.sub(this.controls.target)

    this.controls.target.add(delta)
    this.camera.position.add(delta)
    focusWorld.set(point.x, point.y, point.z).applyMatrix4(this.programFrameGroup.matrixWorld)
    this.orbitFocusActive = true
    this.camera.updateMatrixWorld(true)
  }

  /** Typed scene ownership for the shared display-only reference-image tools. */
  referenceImageHost(): { runtime: ReferenceImageRuntime; canvas: HTMLCanvasElement } {
    const owner = this
    return {
      canvas: this.renderer.domElement,
      runtime: {
        get camera() { return owner.camera },
        addObject: (object) => { this.scene.add(object) },
        removeObject: (object) => { this.scene.remove(object) },
        // CAM renders continuously while active; scene edits paint on the next frame.
        requestRender: () => {},
        projectToCanvas: (point) => {
          const rect = this.renderer.domElement.getBoundingClientRect()
          const p = new THREE.Vector3(point.x, point.y, point.z).project(this.camera)
          return { x: (p.x + 1) * rect.width / 2, y: (1 - p.y) * rect.height / 2 }
        },
      },
    }
  }

  getCamera(): THREE.OrthographicCamera {
    return this.camera
  }

  saveCameraState() {
    return {
      position:    this.camera.position.clone(),
      target:      this.controls.target.clone(),
      zoom:        this.camera.zoom,
      // Ortho extent: without it a refresh restores position/target/zoom onto the
      // constructor-default frustumSize, so the apparent SCALE of the saved view is
      // wrong even when the angle is preserved. Round-tripped via cameraPersist.
      frustumSize: this.frustumSize,
    }
  }

  // Install (or clear with null) the debounced camera-persist callback. The React
  // bridge passes a callback that writes the pose to the persisted uiPrefs store,
  // keyed by the current project id (Viewport.tsx).
  setCameraChangeHandler(cb: ((pose: ReturnType<CNCViewport['saveCameraState']>) => void) | null) {
    this.cameraChangeHandler = cb
  }

  // Mark the camera as user-positioned (PERSISTENT). Called by Viewport.tsx right
  // after a refresh restores a persisted camera AND there is geometry to load, so
  // model-load auto-fit is suppressed and the restored framing survives. Unlike the
  // old ONE-SHOT skipNextInitialFit, this flag is NOT consumed by the first add: it
  // stays set and suppresses EVERY auto-fit (including a second/late async STEP-load
  // fit — the real-GPU T15 bug) until an explicit view change or New/Open clears it.
  // Armed ONLY when there is geometry to restore (gated in Viewport.tsx), so an
  // empty-scene refresh followed by a genuine first import still frames normally.
  markCameraUserPositioned() {
    this.cameraUserPositioned = true
  }

  // Single funnel for the three first-item auto-fit sites (addSTL / addBrepModel /
  // add2DGeometry). Fits the workpiece group on the FIRST item only, and only while
  // the user has NOT positioned the camera. Centralizing the flag check here means
  // no add site (sync or async) can bypass the refresh-restore suppression.
  private maybeAutoFit(isFirstItem: boolean, source = 'item') {
    if (!isFirstItem) return
    // Diagnostic (real-GPU refresh trace): on the FIRST item added, report whether
    // this auto-fit FIRED (snaps to ISO) or was SUPPRESSED by the refresh-restore
    // flag. One tidy line per first-item add so the reset path is visible in the
    // console without noise. See the matching '[camera-restore]' line at mount.
    if (this.cameraUserPositioned) {
      console.info(`[camera-restore] first-item fit SUPPRESSED (source=${source}, flag armed) — restored framing kept`)
    } else {
      console.info(`[camera-restore] first-item fit FIRED (source=${source}, flag NOT armed) — framing to ISO`)
      this.fitCameraToObject(this.workpieceGroup)
    }
  }

  // OrbitControls 'change' fires every damping frame and on programmatic
  // controls.update() (view buttons, fit, restore). Coalesce to one save ~300ms
  // after the last change so a save reflects where the camera came to rest.
  private handleControlsChange = () => {
    if (!this.cameraChangeHandler) return
    if (this.cameraChangeTimer) clearTimeout(this.cameraChangeTimer)
    this.cameraChangeTimer = setTimeout(() => {
      this.cameraChangeTimer = null
      this.cameraChangeHandler?.(this.saveCameraState())
    }, 300)
  }

  // Accepts a Vec3-LIKE pose ({x,y,z} is enough for .copy()) so both the live
  // saveCameraState() output (THREE.Vector3) and a deserialized persisted pose
  // (plain objects from cameraPersist) can be restored without a cast.
  restoreCameraState(state: {
    position: { x: number; y: number; z: number }
    target: { x: number; y: number; z: number }
    zoom: number
    frustumSize?: number
  }) {
    this.camera.position.copy(state.position)
    this.controls.target.copy(state.target)
    this.camera.zoom = state.zoom
    // Restore the orthographic extent (SCALE) when the persisted pose carries it,
    // recomputing the camera's left/right/top/bottom from frustumSize + the live
    // aspect exactly like fitCameraToObject / onResize. Old data lacks frustumSize
    // (or a value <= 0): keep the current extents and restore position/target/zoom
    // only — a graceful fallback, never a rejection.
    if (Number.isFinite(state.frustumSize) && (state.frustumSize as number) > 0) {
      this.frustumSize = state.frustumSize as number
      const w = this.container.clientWidth || 1
      const h = this.container.clientHeight || 1
      const aspect = w / h
      this.camera.left = -this.frustumSize * aspect / 2
      this.camera.right = this.frustumSize * aspect / 2
      this.camera.top = this.frustumSize / 2
      this.camera.bottom = -this.frustumSize / 2
    }
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  // ---- Sketch mode: THE SKETCHER, MOUNTED ------------------------------------
  //
  // WO SKC-14: the 1,114 lines of pointer handlers, feedback painting and camera juggling that
  // used to live here are GONE -- extracted into src/lib/sketch/sketcher/**, the one
  // self-contained sketcher component (plan Section 8.2). What remains is the MOUNT, and a
  // mount may contain only: a canvas/layer, a camera+controls handle, a plane frame, and a
  // commit sink. There is NO tool logic, NO painting and NO pointer state in this file any
  // more; src/tests/sketch/oneSketchPointerOwner.test.ts fails if any reappears.
  //
  // CAM's plane frame is world XY (the ortho camera looks down at it); the workbench's will be a
  // datum-plane frame (S3). That difference is the whole of `clientToPlaneWorld`.

  /** Host scene presentation, saved for the duration of a sketch session. */
  private sketchHostView: {
    stockVisible: boolean
    machineVisible: boolean
    toolpathVisible: boolean
  } | null = null

  /**
   * The DOM surface the component attaches its OVERLAY gesture listeners to: the element that
   * covers both the canvas and CAM's own DOM sketch overlays (dimension value labels, prompt bar).
   * React hands it over on mount (`Viewport.tsx`); until then the canvas container stands in, which
   * is correct for any host with no DOM overlays of its own.
   */
  private sketchOverlayHostEl: HTMLElement | null = null

  /** Hand the component the DOM surface covering the canvas AND this host's sketch overlays. A
   *  mount supplies an element; every gesture on it is decided inside the sketcher package. */
  setSketchOverlayHost(el: HTMLElement | null) {
    this.sketchOverlayHostEl = el
  }

  /** The mount: the surface primitives + the camera/controls handles, and nothing else. */
  private createSketcherHost(): SketcherHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return {
      domElement: this.renderer.domElement,
      container: this.container,
      // Resolved lazily: the component reads it when it attaches (session enter), by which time
      // React's mount effect has handed the real overlay root over.
      get overlayHost(): HTMLElement {
        return self.sketchOverlayHostEl ?? self.container
      },
      overlayRoot: this.scene,
      camera: this.camera,
      controls: this.controls,

      // Ortho unproject onto the sketch plane (world XY). The component then inverse-maps the
      // result through the layer's display pose to reach sketch-LOCAL coords.
      clientToPlaneWorld: (clientX: number, clientY: number) => {
        const rect = this.renderer.domElement.getBoundingClientRect()
        const v = new THREE.Vector3(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
          0,
        )
        v.unproject(this.camera)
        return { x: v.x, y: v.y }
      },
      worldPerPixel: () => this.getWorldPerPixel(),

      // Camera POLICY lives in the component; the host only knows HOW, never WHEN.
      saveCameraPose: () => this.saveCameraState(),
      restoreCameraPose: (pose) => {
        this.restoreCameraState(pose as ReturnType<CNCViewport['saveCameraState']>)
      },
      // CAM's sketch plane is world XY and the camera is already orthographic, so
      // normal-to-plane is exactly the top view.
      frameNormalToPlane: () => this.setCameraView('top'),

      // Hide stock / machine / toolpath for the session; grid and imported geometry stay
      // visible. Host scene presentation -- not tool logic, not painting.
      onSessionEnter: () => {
        this.sketchHostView = {
          stockVisible: this.stockGroup.visible,
          machineVisible: this.machineGroup.visible,
          toolpathVisible: this.toolpathGroup.visible,
        }
        this.stockGroup.visible = false
        this.machineGroup.visible = false
        this.toolpathGroup.visible = false
        // UI-75: sketch mode owns pointer interaction and TransformControls.
        // Retain the logical selection so Finish can restore it, but remove the
        // transform handle while editing. Rides the sketcher's own session
        // guard, so enter/exit stay balanced even on a repeated call.
        this.transformControls.detach()
        this.clear2DGizmoProxy()
      },
      onSessionExit: () => {
        const saved = this.sketchHostView
        this.sketchHostView = null
        // UI-75: re-attach to whatever is still selected. Runs BEFORE the
        // early return: the gizmo must come back even if there was no saved
        // host view to restore, and setSelectedPart re-checks the mode gate.
        //
        // ORDERING DEPENDENCY: this works only because Sketcher.exit() nulls
        // `this.session` BEFORE invoking onSessionExit (sketch/sketcher/index.ts
        // exit()), so inSketchView() is already false here and
        // canAttachPartTransformGizmo() lets the gizmo back. If exit() is ever
        // reordered to fire the hook first, the gizmo would silently never
        // return. Pinned by the "sketch exit re-attaches" case in
        // geometryMoveGizmoPivot.test.ts, which drives the REAL sketcher rather
        // than a stub for exactly this reason.
        if (this.selectedPartId) this.setSelectedPart(this.selectedPartId)
        if (!saved) return
        this.stockGroup.visible = saved.stockVisible
        this.machineGroup.visible = saved.machineVisible
        this.toolpathGroup.visible = saved.toolpathVisible
      },
    }
  }

  /**
   * Enter sketch mode. Idempotent — a second call while already in sketch view is a no-op, so
   * the saved pose is never overwritten by the sketch normal-to-plane pose.
   */
  enterSketchView() {
    this.sketcher.enter()
  }

  /** Exit sketch mode: the component restores the camera pose, the orbit flag and the host's
   *  own group visibility. */
  exitSketchView() {
    this.sketcher.exit()
  }

  /** True while a sketch session is live (sketch mode owns its own picking). */
  private inSketchView(): boolean {
    return this.sketcher.isActive()
  }

  // ---- Thin pass-throughs -----------------------------------------------------
  //
  // The React overlays (SketchDimensionOverlay, SketchDrawValueInput, SketchLiveDimsOverlay) and
  // the constraint browser talk to the VIEWPORT handle, so the mount forwards to the component
  // rather than making every caller reach through it. Forwarding is not tool logic.

  /** Re-render the active sketch (called reactively on store changes). */
  updateSketch(sketch: Sketch | null, view?: SketchViewState, offset?: SketchOffset) {
    this.sketcher.updateSketch(sketch, view, offset)
  }

  /** Hover highlight driven from panel UI (constraint-browser rows). */
  setSketchHover(id: string | null) {
    this.sketcher.setHover(id)
  }

  /** Current viewport-local sketch hover id (entity or constraint), or null. Exposed for the F9
   *  hover-treatment capture tooling. */
  getSketchHoverId(): string | null {
    return this.sketcher.getHover()
  }

  /** Last (ortho-locked) sketch cursor in world mm, or null when no sketch pointermove has
   *  happened. The "type a value mid-draw" box reads this each frame. */
  getLastSketchCursor(): SketchVec2 | null {
    return this.sketcher.getLastCursor()
  }

  /** THE mount wiring (WO SKC-14B): one document/commit/undo sink. Selection round-trips through
   *  it too -- the selection is document-scoped, not a separate port. */
  setSketchDocumentPort(port: SketchDocumentPort | null) {
    this.sketcher.setDocumentPort(port)
  }

  /** Undo ADAPTER (plan R3): CAM's sketchHistory implements the SINK; the component owns the
   *  SEMANTICS (one undoable step per gesture). Neither history type leaks across this seam,
   *  which is what lets the workbench mount its own CommandHistory at S3. */
  setSketchUndoSink(sink: SketchUndoSink | null) {
    this.sketcher.setUndoSink(sink)
  }

  /** Context-menu presentation sink: the component decides when/where, React renders the menu. */
  setSketchMenuPort(p: SketchMenuPort | null) {
    this.sketcher.setMenuPort(p)
  }

  /** World-space mm spanned by one screen pixel (orthographic camera). Public: the React
   *  dimension overlays scale their hit targets by it. */
  getWorldPerPixel(): number {
    const h = this.container.clientHeight || 1
    return (this.camera.top - this.camera.bottom) / (this.camera.zoom * h)
  }

  /** Project a world point to container-relative CSS pixels. */
  worldToScreen(x: number, y: number, z = 0): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.camera)
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h }
  }

  // ---- Clear scene ----
  clearScene() {
    // Fresh New/Open: a brand-new model the user has not positioned SHOULD
    // auto-fit, so drop any prior refresh-restore suppression.
    this.cameraUserPositioned = false
    this.exitLayOnFaceMode()
    this.exitSlicePlaneMode()
    this.transformControls.detach()
    this.clear2DGizmoProxy()
    this.pickedBrepKeys.clear()
    this.getBrepHighlights().clear()   // overlay objects die with their part groups below
    this.brepHoverKey = null
    this.brepHoverObj = null      // ditto - hover overlay is a child of the brep mesh
    this.partGroups.forEach((group) => {
      this.workpieceGroup.remove(group)
      this.disposePartBodyPresentation(group)
    })
    this.partGroups.clear()
    this.partMaterials.clear()
    this.partSelectedMaterialStates?.clear()
    // Some store-level reset/open harnesses intentionally exercise clearScene
    // through a prototype-backed viewport double. Keep the new presentation
    // caches compatible with those minimal hosts while clearing them whenever
    // the concrete viewport owns them.
    this.partUsesThemeColor?.clear()
    this.partEdgePositions?.clear()
    this.projectedLoopGroups.clear()
    // Also clear 2D geometry
    this.geometry2dGroups.forEach((_, id) => this.remove2DGeometry(id))
    this.geometry2dGroups.clear()
    this.geometry2dLayerMats.clear()
    // Also clear nests (instanced parts + seed-slot loops + seed toolpath).
    // Without this, New/Open (both route through clearScene) leave the prior
    // project's nest rendered in the scene until a full remount/refresh.
    this.nestGroups.forEach((_, id) => this.removeNestInstances(id))
    this.nestGroups.clear()
    this.selectedPartId = null
    this.selectableObjects = []
    this.stockGroup.clear()
    this.fixedStockBoxes.clear()
    this.setSimulationToolpathPreview(null)
    this.toolpathGroup.clear()
    this.resetToolpathPickState()
    this.wcsFixed = false
    this.exitWCSGizmoMode()
    this.exitStockGizmoMode()
    this.exitVertexPickMode()
    this.setZeroPointPreview(null)
    this.buildWCSIndicator({ origin: { x: 0, y: 0, z: 0 }, label: 'G54' })
  }

  // ---- Lay-on-face mode ----
  enterLayOnFaceMode(onComplete: () => void) {
    if (!this.selectedPartId) return
    this.interactionMode = 'lay-on-face'
    this.suspend2DGizmoForExclusiveMode()
    this.onLayOnFaceComplete = onComplete
    this.computeFaceOverlays(this.selectedPartId)  // build all cluster meshes once
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove)
  }

  exitLayOnFaceMode() {
    this.interactionMode = 'normal'
    this.onLayOnFaceComplete = undefined
    this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove)
    this.faceHighlightGroup.clear()
    this.faceOverlays = []
    this.hoveredOverlayMesh = null
    this.restore2DGizmoAfterExclusiveMode()
  }

  // ---- Seat-in-vise face pick mode (WO-1587) ----

  /** WO-1591: what a face pick walks for `id`. A geometry id resolves to its
   *  part group; a FIXED stock id resolves to the box `rebuildStock` drew for
   *  it, so the six faces of a stock block highlight and pick exactly like a
   *  body face. An AUTO stock is deliberately absent: it is drawn with
   *  `movable: false` because its bounds are derived from its members, so
   *  there is no position a seat could write (ASSEMBLY-MATING-REVIEW 4.2) -
   *  the strip offers "make it a fixed stock" rather than a dead highlight. */
  private faceOverlaySource(id: string): THREE.Group | null {
    const part = this.partGroups.get(id)
    if (part) return part
    // `?.`, not a bare read: several prototype test harnesses build a viewport
    // via Object.create(prototype) + Object.assign, which skips field
    // initializers entirely (the same reason `loopHighlightOverlays` is a lazy
    // getter). A harness that never set up stock has no stock faces to offer.
    const box = this.fixedStockBoxes?.get(id)
    if (box && box.userData?.movable === true) return box
    return null
  }

  /** True when this body has rendered mesh triangles the face picker can
   *  cluster. A body whose STL has not loaded (or a 2D-only geometry) has
   *  none, and the caller offers its fallback instead of arming a mode that
   *  could never highlight anything. */
  canPickFacesFor(geoId: string): boolean {
    const group = this.faceOverlaySource(geoId)
    if (!group) return false
    let hasTriangles = false
    group.traverse((child) => {
      if (hasTriangles) return
      if (child instanceof THREE.Mesh && child.geometry.attributes.position?.count >= 3) hasTriangles = true
    })
    return hasTriangles
  }

  /** Arm "Seat in vise" face picking over `geoIds` (the workholding body and
   *  the part). Hovering a face highlights it; clicking reports that face's
   *  world centroid + outward normal, tagged with the body it belongs to.
   *
   *  Unlike lay-on-face and project-plane this mode does NOT exit on a pick -
   *  the strip needs two picks per seat and up to two seats, so the CALLER
   *  owns the lifetime (exitSeatFacePickMode on close/cancel), the same
   *  contract setPartPickMode already uses for whole-part picking. */
  enterSeatFacePickMode(
    geoIds: readonly string[],
    onPick: (pick: SeatFacePick) => void,
    onHover: ((pick: SeatFacePick | null) => void) | null = null,
  ) {
    this.exitSeatFacePickMode()
    this.interactionMode = 'seat-face-pick'
    this.seatFacePickCallback = onPick
    this.seatFacePickHoverCallback = onHover
    this.suspend2DGizmoForExclusiveMode()
    this.faceHighlightGroup.clear()
    this.faceOverlays = []
    this.hoveredOverlayMesh = null
    for (const id of geoIds) this.computeFaceOverlays(id, true)
    this.renderer.domElement.style.cursor = 'crosshair'
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove)
  }

  exitSeatFacePickMode() {
    if (this.interactionMode !== 'seat-face-pick') return
    this.interactionMode = 'normal'
    this.seatFacePickCallback = null
    this.seatFacePickHoverCallback = null
    this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove)
    this.renderer.domElement.style.cursor = ''
    this.faceHighlightGroup.clear()
    this.faceOverlays = []
    this.hoveredOverlayMesh = null
    this.restore2DGizmoAfterExclusiveMode()
  }

  /** The click half of the seat pick, split out of `handleClick` for the same
   *  reason `updateFaceOverlayHover` is split out of `handleMouseMove`: the
   *  handlers are instance arrow properties, so a prototype test harness can
   *  only reach the product's real behaviour through a method. */
  private commitSeatFacePickAtHover() {
    const pick = this.seatFacePickAtHover()
    if (pick) this.seatFacePickCallback?.(pick)
  }

  /** The face cluster currently under the cursor, as a pick payload. */
  private seatFacePickAtHover(): SeatFacePick | null {
    if (!this.hoveredOverlayMesh) return null
    const cluster = this.faceOverlays.find((f) => f.mesh === this.hoveredOverlayMesh)
    if (!cluster || !cluster.geoId) return null
    return {
      geoId: cluster.geoId,
      point: { x: cluster.centroid.x, y: cluster.centroid.y, z: cluster.centroid.z },
      normal: { x: cluster.normal.x, y: cluster.normal.y, z: cluster.normal.z },
    }
  }

  // ---- Project-plane mode ----

  enterProjectPlaneMode(
    geoId: string,
    onConfirm: (normal: THREE.Vector3, centroid: THREE.Vector3, zAnchor?: ProjectionZAnchor) => void,
    onCancel: () => void
  ) {
    this.onProjectPlaneConfirm = onConfirm
    this.onProjectPlaneCancel  = onCancel
    this.interactionMode       = 'project-plane'
    this.suspend2DGizmoForExclusiveMode()
    this.renderer.domElement.style.cursor = 'crosshair'
    this.computeFaceOverlays(geoId)
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove)
    this._buildProjectPlanePicker()
  }

  private _buildProjectPlanePicker(
    title = 'Select Target Plane',
    hint  = 'Choose where to place the sliced geometry'
  ) {
    this._projPlaneOverlay?.remove()
    const overlay = document.createElement('div')
    overlay.className = 'project-plane-overlay'

    const sb = this._stockBounds
    const stockTopZ = sb ? sb.max.z : null
    const stockBotZ = sb ? sb.min.z : null

    const confirm = (normal: THREE.Vector3, centroid: THREE.Vector3, zAnchor?: ProjectionZAnchor) => {
      const cb = this.onProjectPlaneConfirm
      this.exitProjectPlaneMode()
      cb?.(normal, centroid, zAnchor)
    }

    // Presets thread a symbolic Z-anchor so stock-relative placements re-resolve
    // their Z live when the stock moves (Item 4). Face picks (mousedown handler)
    // pass NO anchor -> absolute, following the part frame as before.
    const makeBtn = (label: string, sub: string, colorHex: string, normal: THREE.Vector3, centroid: THREE.Vector3, zAnchor?: ProjectionZAnchor) => {
      const btn = document.createElement('button')
      btn.className = 'pp-opt-btn'
      btn.innerHTML = `<span class="pp-color-swatch" style="background:${colorHex}"></span>
        <span class="pp-opt-label">${label}</span>
        <span class="pp-opt-z">${sub}</span>`
      btn.addEventListener('click', () => confirm(normal, centroid, zAnchor))
      return btn
    }

    const titleEl = document.createElement('div')
    titleEl.className = 'pp-title'
    titleEl.textContent = title
    overlay.appendChild(titleEl)

    const hintEl = document.createElement('div')
    hintEl.className = 'pp-hint'
    hintEl.textContent = hint
    overlay.appendChild(hintEl)

    const opts = document.createElement('div')
    opts.className = 'pp-opts'

    // Reality's top-down hierarchy: stock top -> stock bottom -> floor.
    if (stockTopZ !== null)
      opts.appendChild(makeBtn('Stock top', `Z = ${stockTopZ.toFixed(2)} mm`, '#44cc88',
        new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,stockTopZ), { ref: 'stock-top', offset: 0 }))
    if (stockBotZ !== null)
      opts.appendChild(makeBtn('Stock bottom', `Z = ${stockBotZ.toFixed(2)} mm`, '#ccaa44',
        new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,stockBotZ), { ref: 'stock-bottom', offset: 0 }))
    opts.appendChild(makeBtn('Floor (Z = 0)', 'Workspace floor', '#999999',
      new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,0), { ref: 'floor', offset: 0 }))

    overlay.appendChild(opts)

    const sep = document.createElement('div')
    sep.className = 'pp-sep'
    sep.textContent = '— or click a highlighted face in the viewport —'
    overlay.appendChild(sep)

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'pp-cancel-btn'
    cancelBtn.textContent = 'Cancel (Esc)'
    cancelBtn.addEventListener('click', () => {
      const cancel = this.onProjectPlaneCancel
      this.exitProjectPlaneMode()
      cancel?.()
    })
    overlay.appendChild(cancelBtn)

    this.container.appendChild(overlay)
    this._projPlaneOverlay = overlay
  }

  // Step-2 entry point: user has already sliced; now pick WHERE to place the geometry.
  // Reuses the same face-overlay + panel machinery as enterProjectPlaneMode.
  enterTargetPlaneMode(
    geoId: string,
    onConfirm: (normal: THREE.Vector3, centroid: THREE.Vector3, zAnchor?: ProjectionZAnchor) => void,
    onCancel: () => void
  ) {
    this.onProjectPlaneConfirm = onConfirm
    this.onProjectPlaneCancel  = onCancel
    this.interactionMode       = 'project-plane'
    this.suspend2DGizmoForExclusiveMode()
    this.renderer.domElement.style.cursor = 'crosshair'
    this.computeFaceOverlays(geoId)
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove)
    this._buildProjectPlanePicker(
      'Select Target Plane',
      'Click a highlighted face in the viewport, or choose a surface below'
    )
  }

  exitTargetPlaneMode() {
    this.exitProjectPlaneMode()
  }

  exitProjectPlaneMode() {
    this.interactionMode = 'normal'
    this.onProjectPlaneConfirm = undefined
    this.onProjectPlaneCancel  = undefined
    this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove)
    this.renderer.domElement.style.cursor = ''
    this.faceHighlightGroup.clear()
    this.faceOverlays = []
    this.hoveredOverlayMesh = null
    this._projPlaneOverlay?.remove()
    this._projPlaneOverlay = null
    // Also the exit path for enterTargetPlaneMode, which sets interactionMode
    // to 'project-plane' and suspends through the same pair.
    this.restore2DGizmoAfterExclusiveMode()
  }

  // Collect all world-space triangle vertices for a part (non-indexed flat array).
  collectWorldPositions(geoId: string): Float32Array | null {
    const partGroup = this.partGroups.get(geoId)
    if (!partGroup) return null
    partGroup.updateMatrixWorld(true)

    const all: number[] = []
    partGroup.traverse(child => {
      if (!(child instanceof THREE.Mesh) || child.name.startsWith('__')) return
      const geo = child.geometry as THREE.BufferGeometry
      const pos = geo.attributes.position
      const idx = geo.index

      const pushTri = (i0: number, i1: number, i2: number) => {
        const a = new THREE.Vector3().fromBufferAttribute(pos, i0).applyMatrix4(child.matrixWorld)
        const b = new THREE.Vector3().fromBufferAttribute(pos, i1).applyMatrix4(child.matrixWorld)
        const c = new THREE.Vector3().fromBufferAttribute(pos, i2).applyMatrix4(child.matrixWorld)
        all.push(a.x,a.y,a.z, b.x,b.y,b.z, c.x,c.y,c.z)
      }

      if (idx) {
        for (let i = 0; i < idx.count; i += 3) pushTri(idx.getX(i), idx.getX(i+1), idx.getX(i+2))
      } else {
        for (let i = 0; i < pos.count; i += 3) pushTri(i, i+1, i+2)
      }
    })

    return all.length ? new Float32Array(all) : null
  }

  // Render 2-D loops placed on each layer's projectionPlane.
  // World-baked layers (STL projections, frame absent): (u,v) points are absolute
  // world XY; the group lives in scene root. Geometry-local layers (B-rep derives,
  // frame 'geometry_local'): points and plane Z are MODEL coords; the group is
  // parented under the part group so it follows the gizmo live (same convention
  // as setPartProjectedLoops). Geometry-local layers unflatten via the true
  // orthonormal inverse O + X*u + Y*v (correct for tilted brep sections);
  // world-baked layers cast a vertical Z-ray onto their target plane.
  setPartLoopsOnFacePlane(
    geoId: string,
    loops: Array<{ id: string; points: Array<{ x: number; y: number }>; closed: boolean; layerId: string }>,
    layers: Array<{ id: string; color: string; visible: boolean; frame?: 'geometry_local'; projectionPlane?: { origin:{x:number;y:number;z:number}; xAxis:{x:number;y:number;z:number}; yAxis:{x:number;y:number;z:number} } }>
  ) {
    this.clearPartLoopsOnFacePlane(geoId)
    if (!loops.length) return

    // Pre-compute per-layer 3D mapping
    type LayerMapFn = (u: number, v: number) => THREE.Vector3
    const layerMapFn = new Map<string, LayerMapFn>()
    const layerColor   = new Map(layers.map(l => [l.id, l.color]))
    const layerVisible = new Map(layers.map(l => [l.id, l.visible]))

    for (const layer of layers) {
      const fp = layer.projectionPlane
      if (!fp) continue
      const O = new THREE.Vector3(fp.origin.x, fp.origin.y, fp.origin.z)
      const X = new THREE.Vector3(fp.xAxis.x,  fp.xAxis.y,  fp.xAxis.z)
      const Y = new THREE.Vector3(fp.yAxis.x,  fp.yAxis.y,  fp.yAxis.z)
      const N = X.clone().cross(Y)   // plane normal = xAxis × yAxis
      if (layer.frame === 'geometry_local') {
        // Geometry-local layers (B-rep derives, incl. tilted brep sections) store
        // their points in the plane's ORTHONORMAL UV frame. Unflatten via the true
        // orthonormal inverse O + X*u + Y*v, mirroring derive's flattenToPlaneUV
        // inverse exactly. For a horizontal section (O=(0,0,z), X=[1,0,0],
        // Y=[0,1,0]) this gives (px,py,z) -- byte-identical to the legacy ray-cast
        // result, but it is also correct for an arbitrarily tilted cutting plane.
        layerMapFn.set(layer.id, (u, v) =>
          O.clone().addScaledVector(X, u).addScaledVector(Y, v))
      } else {
        // World-baked layers (STL projections, frame absent): (u,v) are world XY.
        layerMapFn.set(layer.id, (u, v) => {
          if (Math.abs(N.z) > 1e-6) {
            // Cast vertical Z-ray onto the plane: N·(P-O)=0, P=(u,v,t)
            const t = O.z - (N.x*(u - O.x) + N.y*(v - O.y)) / N.z
            return new THREE.Vector3(u, v, t)
          }
          return O.clone().addScaledVector(X, u).addScaledVector(Y, v)
        })
      }
    }

    const group = new THREE.Group()
    group.name = `__wplane_${geoId}`
    const localGroup = new THREE.Group()
    localGroup.name = `__wplane_local_${geoId}`
    const localLayerIds = new Set(layers.filter(l => l.frame === 'geometry_local').map(l => l.id))

    for (const loop of loops) {
      const mapFn  = layerMapFn.get(loop.layerId)
      if (!mapFn) continue   // skip loops whose layer has no projectionPlane
      const hexStr = layerColor.get(loop.layerId) ?? asHex('--role-cut')
      const color  = parseInt(hexStr.replace('#',''), 16)
      const vis    = layerVisible.get(loop.layerId) ?? true
      // depthTest off + renderOrder: these loops lie exactly ON model faces
      // (STL projection planes, B-rep derived planes), so depth-tested lines
      // z-fight into invisibility. Same overlay convention as the brep pick
      // highlight (renderOrder 101); 90 keeps pick highlights on top.
      const mat    = new THREE.LineBasicMaterial({ color, linewidth: 1, toneMapped: false, visible: vis, depthTest: false })
      mat.userData.origColor = color   // needed by refreshLoopColors for pick-highlight restore

      const pts = loop.points.map(p => mapFn(p.x, p.y))
      if (loop.closed && pts.length > 0) pts.push(pts[0].clone())

      const geo  = new THREE.BufferGeometry().setFromPoints(pts)
      const line = new THREE.Line(geo, mat)
      line.name  = loop.id
      line.renderOrder = 90
      line.userData.layerId = loop.layerId   // needed for set2DLayerVisible (B13)
      ;(localLayerIds.has(loop.layerId) ? localGroup : group).add(line)
    }

    if (group.children.length > 0) {
      this.scene.add(group)
      this._worldPlaneLoopGroups.set(geoId, group)
    }
    if (localGroup.children.length > 0) {
      // Parent under the part group (identity local transform — points are
      // model coords, the part transform places them). Scene-root fallback
      // when the async model load has not landed yet; addBrepModel re-attaches.
      const partGroup = this.partGroups.get(geoId)
      ;(partGroup ?? this.scene).add(localGroup)
      this._geoLocalLoopGroups.set(geoId, localGroup)
    }
    this.updateSelectableObjects()
  }

  clearPartLoopsOnFacePlane(geoId: string) {
    const disposeGroup = (old: THREE.Group | undefined) => {
      if (!old) return
      old.removeFromParent()   // parent is scene root OR the part group
      old.traverse(c => {
        if (c instanceof THREE.Line) {
          c.geometry.dispose()
          ;(c.material as THREE.Material).dispose()
        }
      })
    }
    const world = this._worldPlaneLoopGroups.get(geoId)
    const local = this._geoLocalLoopGroups.get(geoId)
    if (!world && !local) return
    disposeGroup(world)
    disposeGroup(local)
    this._worldPlaneLoopGroups.delete(geoId)
    this._geoLocalLoopGroups.delete(geoId)
    this.updateSelectableObjects()
  }

  // ---- Settle: find largest flat-area face and rest on it ----
  settleToFloor(id: string) {
    const group = this.partGroups.get(id)
    if (!group) return

    group.updateMatrixWorld(true)

    let bestNormal: THREE.Vector3 | null = null
    let bestArea = 0
    const clusters = new Map<string, { normal: THREE.Vector3; area: number }>()

    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      const geo = child.geometry as THREE.BufferGeometry
      const pos = geo.attributes.position
      const idx = geo.index

      const processTriangle = (i0: number, i1: number, i2: number) => {
        const a = new THREE.Vector3().fromBufferAttribute(pos, i0).applyMatrix4(child.matrixWorld)
        const b = new THREE.Vector3().fromBufferAttribute(pos, i1).applyMatrix4(child.matrixWorld)
        const c = new THREE.Vector3().fromBufferAttribute(pos, i2).applyMatrix4(child.matrixWorld)

        const cross = b.clone().sub(a).cross(c.clone().sub(a))
        const area = cross.length() / 2
        const n = cross.normalize()
        const key = `${Math.round(n.x * 10)},${Math.round(n.y * 10)},${Math.round(n.z * 10)}`

        if (!clusters.has(key)) clusters.set(key, { normal: n.clone(), area: 0 })
        clusters.get(key)!.area += area
      }

      if (idx) {
        for (let i = 0; i < idx.count; i += 3)
          processTriangle(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2))
      } else {
        for (let i = 0; i < pos.count; i += 3)
          processTriangle(i, i + 1, i + 2)
      }
    })

    clusters.forEach(({ normal, area }) => {
      if (area > bestArea) { bestArea = area; bestNormal = normal.clone() }
    })

    if (bestNormal) this.layOnFace(id, bestNormal)
  }

  // ---- Selection ----
  private handlePointerDown = (event: PointerEvent) => {
    this.mouseDownPos = { x: event.clientX, y: event.clientY }

    // Check if the slice-plane drag handle was hit
    if (this.sliceDragHandle) {
      const rect = this.renderer.domElement.getBoundingClientRect()
      const mx = ((event.clientX - rect.left) / rect.width)  * 2 - 1
      const my = -((event.clientY - rect.top)  / rect.height) * 2 + 1
      const ray = new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2(mx, my), this.camera)
      const hits = ray.intersectObject(this.sliceDragHandle, false)
      if (hits.length > 0) {
        this.sliceDragActive  = true
        this.sliceDragLastY   = event.clientY
        this.controls.enabled = false
        event.stopPropagation()
        return
      }
    }

    // Contour tab edit mode: pressing on a marker starts a drag that slides
    // it along its contour (sliceDragHandle pattern: orbit disabled while
    // dragging, commit on release via handleTabEditPointerUp).
    if (this.tabEditCallbacks && this.tabMarkerGroup) {
      const marker = this.tabMarkerAtClient(event.clientX, event.clientY)
      const tag = marker?.userData.tabMarker as { loopId: string; index: number } | undefined
      if (marker && tag) {
        const loop = this.tabMarkerData?.loops.find((l) => l.loopId === tag.loopId)
        if (loop) {
          this.tabEditDrag = {
            loopId: tag.loopId,
            index: tag.index,
            fraction: loop.fractions[tag.index],
            marker,
            moved: false,
          }
          this.controls.enabled = false
          event.stopPropagation()
          return
        }
      }
    }
  }

  /**
   * Resolve the ordinary part/stock target under a client-coordinate point
   * without mutating selection. Viewport context menus use this so right-click
   * acts on what is actually under the mouse instead of a stale tree selection.
   */
  pickAtClientPosition(
    clientX: number,
    clientY: number,
    allowNonMovableStockTarget = true,
  ): ViewportPickResult {
    if (this.inSketchView()) return { kind: null, id: null }
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { kind: null, id: null }
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.mouse, this.camera)
    const hits = this.raycaster.intersectObjects(this.selectableObjects, true)
    return resolveViewportPick(
      hits.map((hit) => ({
        partId: this.findPartId(hit.object),
        stock: this.findStockTag(hit.object),
      })),
      allowNonMovableStockTarget,
    )
  }

  /**
   * WO-1503, relocated to navPresetController.ts by WO-1595 (rule (e): only
   * navigation may discriminate the right button). Called from the native
   * 'contextmenu' handler with that event's own client coordinates (its
   * release point). True when the right-button gesture ending now moved past
   * the same click-drag threshold handleClick uses -- i.e. it was a pan/orbit
   * drag, not a plain right-click, and the menu should stay closed. A
   * keyboard-invoked contextmenu (no prior right-button pointerdown) reads
   * false, and a later, separate right-click is judged on its own gesture.
   */
  consumeRightButtonWasDrag(clientX: number, clientY: number): boolean {
    return this.navController.consumeRightButtonWasDrag(clientX, clientY, CLICK_DRAG_THRESHOLD_SQ_PX)
  }

  private handleClick = (event: MouseEvent) => {
    // Sketch mode owns its own picking — suppress part/face selection.
    if (this.inSketchView()) return
    // Ignore if this was actually a drag (gizmo interaction or orbit)
    const dx = event.clientX - this.mouseDownPos.x
    const dy = event.clientY - this.mouseDownPos.y
    if (dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_SQ_PX) return

    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.mouse, this.camera)

    // WO-366: after a cylinder is selected, the two labeled center points own
    // the next click. Empty space keeps the choice stage active.
    if (this.zeroPointChoiceCallback) {
      const choiceId = this.zeroPointChoiceAtCurrentRay()
      if (choiceId) this.zeroPointChoiceCallback(choiceId)
      return
    }

    if (this.stockCornerPickCallback) {
      const pick = this.stockCornerAtCurrentRay()
      if (pick) this.stockCornerPickCallback(pick)
      return
    }

    // Contour tab edit mode owns clicks: clicking the contour adds a tab at
    // that arc position; normal selection is suppressed while the mode is on.
    if (this.tabEditCallbacks) {
      this.handleTabEditClick(event)
      return
    }

    // Vertex-pick mode: use pre-computed snap candidates (2D), fall back to 3D raycast
    if (this.vertexPickCallback) {
      // If a 2D candidate is already highlighted by hover, pick it immediately
      if (this.snapHoveredIdx >= 0) {
        const sc = this.snapCandidates[this.snapHoveredIdx]
        this.vertexPickCallback({
          pos:     { x: sc.worldPos.x, y: sc.worldPos.y, z: sc.worldPos.z },
          geoId:   sc.geoId,
          localPt: { x: sc.localPos.x, y: sc.localPos.y, z: sc.localPos.z },
        })
        return
      }

      // 2D fallback: nearest pre-computed candidate within threshold (click without prior hover)
      if (this.snapCandidates.length > 0) {
        const SNAP_THRESHOLD = 0.08
        let bestDist = SNAP_THRESHOLD
        let bestIdx = -1
        for (let i = 0; i < this.snapCandidates.length; i++) {
          const screen = this.snapCandidates[i].worldPos.clone().project(this.camera)
          const d = Math.hypot(screen.x - this.mouse.x, screen.y - this.mouse.y)
          if (d < bestDist) { bestDist = d; bestIdx = i }
        }
        if (bestIdx >= 0) {
          const sc = this.snapCandidates[bestIdx]
          this.vertexPickCallback({
            pos:     { x: sc.worldPos.x, y: sc.worldPos.y, z: sc.worldPos.z },
            geoId:   sc.geoId,
            localPt: { x: sc.localPos.x, y: sc.localPos.y, z: sc.localPos.z },
          })
          return
        }
      }

      // 3D mesh fallback (STL): raycast then snap to nearest triangle vertex
      const meshes: THREE.Object3D[] = []
      this.workpieceGroup.traverse((c) => { if (c instanceof THREE.Mesh) meshes.push(c) })
      const hits = this.raycaster.intersectObjects(meshes, false)
      if (hits.length > 0) {
        const hit = hits[0]
        const face = hit.face
        if (face && hit.object instanceof THREE.Mesh) {
          const posAttr = hit.object.geometry.attributes.position
          let bestV: THREE.Vector3 | null = null
          let bestD = Infinity
          for (const vi of [face.a, face.b, face.c]) {
            const v = new THREE.Vector3(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi))
              .applyMatrix4(hit.object.matrixWorld)
            const screen = v.clone().project(this.camera)
            const d = Math.hypot(screen.x - this.mouse.x, screen.y - this.mouse.y)
            if (d < bestD) { bestD = d; bestV = v }
          }
          if (bestV) {
            this.vertexPickCallback({ pos: { x: bestV.x, y: bestV.y, z: bestV.z } })
          }
        }
      }
      return
    }

    // Lay-on-face mode: apply the currently-hovered face cluster's orientation
    if (this.interactionMode === 'lay-on-face') {
      if (this.hoveredOverlayMesh && this.selectedPartId) {
        const cluster = this.faceOverlays.find((f) => f.mesh === this.hoveredOverlayMesh)
        if (cluster) {
          this.layOnFace(this.selectedPartId, cluster.normal)
          this.exitLayOnFaceMode()
          this.onLayOnFaceComplete?.()
        }
      }
      // Clicking with no face hovered keeps the mode active
      return
    }

    // WO-1587 seat-in-vise face pick: report the hovered face and STAY in the
    // mode - the strip asks for two faces per seat and two seats per vise.
    // Clicking empty space picks nothing and changes nothing.
    if (this.interactionMode === 'seat-face-pick') {
      this.commitSeatFacePickAtHover()
      return
    }

    // Project-plane mode: confirm the hovered face as the projection plane
    if (this.interactionMode === 'project-plane') {
      if (this.hoveredOverlayMesh) {
        const cluster = this.faceOverlays.find((f) => f.mesh === this.hoveredOverlayMesh)
        if (cluster) {
          const cb = this.onProjectPlaneConfirm
          this.exitProjectPlaneMode()
          // Face pick = absolute placement (no zAnchor): the loops follow the
          // part frame, not the stock (Item 4).
          cb?.(cluster.normal, cluster.centroid)
        }
      }
      return
    }

    // Whole-part pick mode: a modal owns the click and decides what selecting
    // the part means. Invalid/empty clicks keep the mode active.
    if (this.partPickCallback) {
      const hits = this.raycaster.intersectObjects(this.selectableObjects, true)
      const partId = hits
        .map((hit) => this.findPartId(hit.object))
        .find((id): id is string =>
          id != null &&
          (!this.partPickAllowedIds || this.partPickAllowedIds.has(id)))
      if (partId) this.partPickCallback(partId)
      return
    }

    // WCS gizmo mode: suppress part selection so gizmo drag isn't interrupted
    if (this.wcsGizmoSphere) return

    // B-rep face/edge pick mode: toggle subshape selection, no part selection
    if (this.brepPickKind) {
      this.handleBrepPickClick()
      return
    }

    // Loop-pick mode: toggle loop selection, don't do normal part selection
    if (this.loopPickCallback) {
      const loopId = this.resolveLoopPickAtCurrentRay()
      if (loopId) {
        const nowSelected = !this.pickedLoopIds.has(loopId)
        if (nowSelected) this.pickedLoopIds.add(loopId)
        else this.pickedLoopIds.delete(loopId)
        this.refreshLoopColors()
        this.loopPickCallback(loopId, nowSelected)
      }
      return
    }

    // PP-MOVE-PICK: in Toolpath view, clicking a drawn toolpath segment selects
    // that MOVE. This slots into the ONE shared click handler (same ray) ahead of
    // the part/stock resolution: a segment hit wins and returns; a hit that can't
    // resolve refuses BY NAME (ADR-0003) and falls through; a miss falls through
    // to normal resolution, which then clears any prior move selection.
    if (this.moveSelectCallback && this.toolpathGroup.visible && this.toolpathPickBodies.length > 0) {
      const movePick = this.resolveMovePickAtRay()
      if (movePick && 'operationId' in movePick) {
        this.applyMoveHighlight(movePick)
        this.clearMoveHover()
        this.moveSelectCallback(movePick)
        return
      }
      if (movePick && 'refused' in movePick) {
        this.moveHoverCallback?.(null, true) // refuse by name; fall through
      }
    }

    // Normal mode: click to select/deselect parts OR a rendered stock box.
    // GEOMETRY WINS on overlap: a part hit anywhere in the ordered list beats a
    // nearer stock face (resolveViewportPick handles the precedence). Empty click
    // deselects both part and stock. A selected part admits non-movable auto
    // stocks as assignment targets for this click only.
    // PP-MOVE-PICK: reaching here means no toolpath move was picked, so any prior
    // move selection is cleared (a part/stock/empty click deselects the move too).
    if (this.moveSelectCallback && this.toolpathGroup.visible) {
      this.moveSelectOverlay = this.disposeMoveOverlay(this.moveSelectOverlay)
      this.moveSelectCallback(null)
    }
    const hits = this.raycaster.intersectObjects(this.selectableObjects, true)
    const pick = resolveViewportPick(
      hits.map((h) => ({
        partId: this.findPartId(h.object),
        stock: this.findStockTag(h.object),
      })),
      this.selectedPartId !== null,
    )
    if (pick.kind === 'part') {
      this.onPartSelect?.(pick.id)
      // Use the face of the actual selected part hit (geometry may sit behind a
      // nearer stock face in the ordered list).
      const partHit = hits.find((h) => this.findPartId(h.object) === pick.id)
      const faceIndex = partHit?.faceIndex
      this.onFaceSelect?.(faceIndex != null ? `face_${faceIndex}` : null)
    } else if (pick.kind === 'stock') {
      // Preserve the existing selected part as assignment context before the
      // ordinary tri-exclusive stock-selection sequence clears it.
      const assignmentPartId = this.selectedPartId
      this.onPartSelect?.(null)
      this.onFaceSelect?.(null)
      this.onStockSelect?.(pick.id, assignmentPartId)
    } else {
      // Empty click: deselect both.
      this.onPartSelect?.(null)
      this.onFaceSelect?.(null)
      this.onStockSelect?.(null)
    }
  }

  private handleMouseMove = (event: MouseEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const mx = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const my = -((event.clientY - rect.top) / rect.height) * 2 + 1

    if (this.stockCornerPickCallback) {
      this.mouse.x = mx
      this.mouse.y = my
      this.raycaster.setFromCamera(this.mouse, this.camera)
      const pick = this.stockCornerAtCurrentRay()
      if (this.stockCornerPickMarker) {
        this.stockCornerPickMarker.visible = pick != null
        if (pick) this.stockCornerPickMarker.position.set(pick.pos.x, pick.pos.y, pick.pos.z)
      }
      this.renderer.domElement.style.cursor = pick ? 'pointer' : 'crosshair'
      return
    }

    if (this.partPickCallback) {
      this.mouse.x = mx
      this.mouse.y = my
      this.raycaster.setFromCamera(this.mouse, this.camera)
      const partId = this.raycaster
        .intersectObjects(this.selectableObjects, true)
        .map((hit) => this.findPartId(hit.object))
        .find((id): id is string =>
          id != null &&
          (!this.partPickAllowedIds || this.partPickAllowedIds.has(id)))
      this.setPartPickHover(partId ?? null)
      this.renderer.domElement.style.cursor = partId ? 'pointer' : 'crosshair'
      return
    }

    // ── Vertex pick: hover-highlight nearest snap candidate by changing its color ──
    if (this.vertexPickCallback && this.snapCandidates.length > 0 && this.snapCloud) {
      let bestDist = Infinity
      let bestIdx = -1
      for (let i = 0; i < this.snapCandidates.length; i++) {
        const screen = this.snapCandidates[i].worldPos.clone().project(this.camera)
        const d = Math.hypot(screen.x - mx, screen.y - my)
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      const newHoveredIdx = (bestIdx >= 0 && bestDist < 0.08) ? bestIdx : -1
      if (newHoveredIdx !== this.snapHoveredIdx) {
        const colorAttr = this.snapCloud.geometry.attributes.color as THREE.BufferAttribute
        // Restore previous candidate's original color
        if (this.snapHoveredIdx >= 0) {
          const prev = this.snapCandidates[this.snapHoveredIdx]
          if (prev.type === 'circle_center') colorAttr.setXYZ(this.snapHoveredIdx, 1, 0.5, 0)  // orange
          else                               colorAttr.setXYZ(this.snapHoveredIdx, 1, 1,   0)  // yellow
        }
        // Highlight new candidate in bright red
        if (newHoveredIdx >= 0) colorAttr.setXYZ(newHoveredIdx, 1, 0, 0)
        colorAttr.needsUpdate = true
        this.snapHoveredIdx = newHoveredIdx
      }
    }

    if (!this.inFaceOverlayMode() || this.faceOverlays.length === 0) return
    this.updateFaceOverlayHover(mx, my)
  }

  /** Move the face-overlay highlight to whatever planar face the ray through
   *  (`mx`, `my`) in NDC hits, and report the change to a seat pick session.
   *  Split out of `handleMouseMove` (WO-1587) because that is an instance
   *  arrow property and so unreachable from a prototype test harness - this is
   *  the hover the product actually runs, not a re-implementation of it. */
  private updateFaceOverlayHover(mx: number, my: number) {
    this.mouse.x = mx
    this.mouse.y = my
    this.raycaster.setFromCamera(this.mouse, this.camera)

    const overlayMeshes = this.faceOverlays.map((f) => f.mesh)
    const hits = this.raycaster.intersectObjects(overlayMeshes, false)

    // Only accept hits where the cluster normal faces toward the camera.
    // This prevents selecting the inward-facing back side of a DoubleSide overlay,
    // which would produce an inverted rotation (wrong face on the floor).
    const rayDir = this.raycaster.ray.direction
    const frontHit = hits.find((h) => {
      const cluster = this.faceOverlays.find((f) => f.mesh === h.object)
      return cluster !== undefined && cluster.normal.dot(rayDir) < 0
    })
    const newHit = frontHit ? (frontHit.object as THREE.Mesh) : null

    if (newHit === this.hoveredOverlayMesh) return  // nothing changed

    // Un-hover the previous overlay (restore its base color)
    if (this.hoveredOverlayMesh) {
      const prev = this.faceOverlays.find(f => f.mesh === this.hoveredOverlayMesh)
      const mat = this.hoveredOverlayMesh.material as THREE.MeshBasicMaterial
      mat.color.setHex(prev?.baseColor ?? asNumber('--vp-face-overlay'))
      mat.opacity = 0.45
    }

    // Highlight the newly hovered overlay
    this.hoveredOverlayMesh = newHit
    if (newHit) {
      const mat = newHit.material as THREE.MeshBasicMaterial
      mat.color.setHex(asNumber('--vp-face-overlay-hover'))
      mat.opacity = 0.85
      this.renderer.domElement.style.cursor = 'pointer'
    } else {
      this.renderer.domElement.style.cursor = 'crosshair'
    }

    // WO-1587: report the hover CHANGE (the early return above makes this a
    // change-only stream) so the strip can name the face the click would take.
    if (this.interactionMode === 'seat-face-pick') {
      this.seatFacePickHoverCallback?.(this.seatFacePickAtHover())
    }
  }

  // Pre-compute one overlay mesh per logical planar face — called once on mode entry.
  //
  // Algorithm (matches PrusaSlicer / OrcaSlicer behaviour):
  //   1. Collect every triangle with its world-space normal.
  //   2. Group by normal direction (dot > 0.9998, ≈1° tolerance).
  //   3. Within each normal group, split into edge-adjacent connected components
  //      so two parallel faces on opposite sides of a part become separate overlays.
  //   4. Build one Three.js Mesh per component — persistent, easy to raycast.
  //
  // WO-1587: `append` lets a mode overlay MORE than one body (the seat pick
  // needs the workholding body and the part live at the same time). Every
  // overlay is tagged with the body it came from.
  private computeFaceOverlays(partId: string, append = false) {
    if (!append) {
      this.faceHighlightGroup.clear()
      this.faceOverlays = []
      this.hoveredOverlayMesh = null
    }

    const group = this.faceOverlaySource(partId)
    if (!group) return
    const isStock = !this.partGroups.has(partId)
    group.updateMatrixWorld(true)

    const NORMAL_DOT = 0.9998   // ≈1° — strict planar grouping
    const SURFACE_OFFSET = 0.4  // mm push-off along normal to avoid z-fighting
    const MIN_AREA = 0.5        // mm² — ignore degenerate slivers

    // Stable hash helpers (0.1 mm grid = tolerates matrix float noise)
    const pk = (v: THREE.Vector3) =>
      `${Math.round(v.x * 10)}_${Math.round(v.y * 10)}_${Math.round(v.z * 10)}`
    const ek = (a: THREE.Vector3, b: THREE.Vector3) => {
      const ka = pk(a), kb = pk(b)
      return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
    }

    // ── Step 1: collect all triangles ──────────────────────────────────────
    interface Tri {
      n:  THREE.Vector3   // world-space geometric normal
      wa: THREE.Vector3   // offset world verts (for overlay rendering)
      wb: THREE.Vector3
      wc: THREE.Vector3
      ra: THREE.Vector3   // exact world verts (for edge-adjacency keys)
      rb: THREE.Vector3
      rc: THREE.Vector3
      area: number
    }
    const allTris: Tri[] = []

    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      // WO-1591: a fat display edge (three's LineSegments2) EXTENDS THREE.Mesh,
      // and its `position` attribute is the shared quad template every segment
      // is instanced from - not a surface of the body. Clustering it invents a
      // face that exists nowhere in the scene, which the stock box (whose
      // wireframe is one) would have offered as a pickable seat face.
      if (child.userData?.isDisplayEdge === true || child.userData?.isBrepFatEdge === true) return
      const geo = child.geometry as THREE.BufferGeometry
      const pos = geo.attributes.position
      const idx = geo.index

      const addTri = (i0: number, i1: number, i2: number) => {
        const la = new THREE.Vector3().fromBufferAttribute(pos, i0)
        const lb = new THREE.Vector3().fromBufferAttribute(pos, i1)
        const lc = new THREE.Vector3().fromBufferAttribute(pos, i2)
        const cross = lb.clone().sub(la).cross(lc.clone().sub(la))
        const area = cross.length() / 2
        if (area < 1e-10) return

        const n = cross.normalize().transformDirection(child.matrixWorld).normalize()
        const ra = la.applyMatrix4(child.matrixWorld)
        const rb = lb.applyMatrix4(child.matrixWorld)
        const rc = lc.applyMatrix4(child.matrixWorld)
        allTris.push({
          n,
          wa: ra.clone().addScaledVector(n, SURFACE_OFFSET),
          wb: rb.clone().addScaledVector(n, SURFACE_OFFSET),
          wc: rc.clone().addScaledVector(n, SURFACE_OFFSET),
          ra: ra.clone(), rb: rb.clone(), rc: rc.clone(),
          area,
        })
      }

      if (idx) {
        for (let i = 0; i < idx.count; i += 3)
          addTri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2))
      } else {
        for (let i = 0; i < pos.count; i += 3)
          addTri(i, i + 1, i + 2)
      }
    })

    // ── Step 2: group triangles by normal direction ─────────────────────────
    const normalBuckets: Array<{ rep: THREE.Vector3; tris: Tri[] }> = []
    for (const tri of allTris) {
      const bi = normalBuckets.findIndex((b) => b.rep.dot(tri.n) > NORMAL_DOT)
      if (bi >= 0) {
        normalBuckets[bi].tris.push(tri)
      } else {
        normalBuckets.push({ rep: tri.n.clone(), tris: [tri] })
      }
    }

    // ── Step 3: per normal-bucket, find edge-adjacent connected components ──
    for (const { tris } of normalBuckets) {
      // Build edge → triangle-index map
      const edgeMap = new Map<string, number[]>()
      for (let i = 0; i < tris.length; i++) {
        const t = tris[i]
        for (const e of [ek(t.ra, t.rb), ek(t.rb, t.rc), ek(t.rc, t.ra)]) {
          const list = edgeMap.get(e)
          if (list) list.push(i)
          else edgeMap.set(e, [i])
        }
      }

      // BFS to label connected components
      const comp = new Int32Array(tris.length).fill(-1)
      let nextId = 0
      for (let start = 0; start < tris.length; start++) {
        if (comp[start] >= 0) continue
        const id = nextId++
        const queue = [start]
        comp[start] = id
        let head = 0
        while (head < queue.length) {
          const ti = queue[head++]
          const t = tris[ti]
          for (const e of [ek(t.ra, t.rb), ek(t.rb, t.rc), ek(t.rc, t.ra)]) {
            for (const adj of (edgeMap.get(e) ?? [])) {
              if (comp[adj] < 0) { comp[adj] = id; queue.push(adj) }
            }
          }
        }
      }

      // ── Step 4: build overlay mesh per component ────────────────────────
      const buckets = new Map<number, Tri[]>()
      for (let i = 0; i < tris.length; i++) {
        const id = comp[i]
        const b = buckets.get(id)
        if (b) b.push(tris[i]); else buckets.set(id, [tris[i]])
      }

      for (const compTris of buckets.values()) {
        let totalArea = 0
        const verts: number[] = []
        const avgNormal = new THREE.Vector3()
        let cx = 0, cy = 0, cz = 0   // accumulate exact centroid

        for (const t of compTris) {
          verts.push(t.wa.x, t.wa.y, t.wa.z, t.wb.x, t.wb.y, t.wb.z, t.wc.x, t.wc.y, t.wc.z)
          avgNormal.addScaledVector(t.n, t.area)
          totalArea += t.area
          cx += t.ra.x + t.rb.x + t.rc.x
          cy += t.ra.y + t.rb.y + t.rc.y
          cz += t.ra.z + t.rb.z + t.rc.z
        }
        if (totalArea < MIN_AREA) continue
        avgNormal.normalize()
        const centroid = new THREE.Vector3(cx/(compTris.length*3), cy/(compTris.length*3), cz/(compTris.length*3))

        const hlGeo = new THREE.BufferGeometry()
        hlGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))

        const mat = new THREE.MeshBasicMaterial({
          color: asNumber('--vp-face-overlay'),
          transparent: true,
          opacity: 0.45,
          side: THREE.DoubleSide,
          depthTest: false,
        })

        const mesh = new THREE.Mesh(hlGeo, mat)
        mesh.renderOrder = 100
        this.faceHighlightGroup.add(mesh)
        this.faceOverlays.push({ normal: avgNormal, mesh, area: totalArea, centroid, baseColor: asNumber('--vp-face-overlay'), isStock, geoId: partId })
      }
    }
  }

  // Rotate part so `worldNormal` faces down (-Z), then drop to floor
  private layOnFace(id: string, worldNormal: THREE.Vector3) {
    const group = this.partGroups.get(id)
    if (!group) return

    // Compute shortest-arc rotation: worldNormal → (0,0,-1)
    const q = new THREE.Quaternion().setFromUnitVectors(
      worldNormal.clone().normalize(),
      new THREE.Vector3(0, 0, -1)
    )
    // Apply as a world-space rotation on top of existing orientation
    group.quaternion.premultiply(q)
    group.quaternion.normalize()
    // Propagate to matrixWorld BEFORE dropPartToFloor reads the bounding box
    group.updateMatrixWorld(true)

    this.dropPartToFloor(id)
  }

  // ── Loop picking mode ──────────────────────────────────────────────────────
  // Activated by NewOperationModal geometry tab. While active, clicking a 2D
  // loop line calls the callback with (loopId, isNowSelected) instead of
  // triggering normal part selection.

  private loopPickCallback: ((loopId: string, nowSelected: boolean) => void) | null = null
  private loopPickAllowedGeoId: string | null = null
  private pickedLoopIds: Set<string> = new Set()
  private loopPickHoverId: string | null = null
  // WO-341: fat-line overlays (see buildLoopHighlightOverlay) for whichever
  // loop lines are currently hovered/picked, rebuilt from scratch on every
  // refreshLoopColors() call so a stale entry never outlives the THREE.Line
  // it decorates (e.g. setPartProjectedLoops replacing the group wholesale).
  // Lazily-initialized getter, not a field initializer: several existing
  // unit-test harnesses build a CNCViewport via Object.create(prototype) +
  // Object.assign rather than `new`, which skips field initializers entirely
  // (see e.g. src/tests/lib/CNCViewport.loopPickHover.test.ts) — a plain
  // `= new Map()` field would read as undefined there and throw.
  private _loopHighlightOverlays: Map<THREE.Line, THREE.Object3D> | undefined
  private get loopHighlightOverlays(): Map<THREE.Line, THREE.Object3D> {
    return this._loopHighlightOverlays ??= new Map()
  }

  private handleLoopPickHoverMove = (event: MouseEvent) => {
    this.updateLoopPickHover(event)
  }

  setLoopPickMode(
    callback: ((loopId: string, nowSelected: boolean) => void) | null,
    allowedGeoId: string | null = null
  ) {
    this.loopPickHoverId = null
    this.loopPickCallback = callback
    this.loopPickAllowedGeoId = allowedGeoId
    if (callback) {
      this.renderer.domElement.style.cursor = 'crosshair'
      this.renderer.domElement.addEventListener('mousemove', this.handleLoopPickHoverMove)
    } else {
      this.renderer.domElement.removeEventListener('mousemove', this.handleLoopPickHoverMove)
      this.renderer.domElement.style.cursor = ''
      this.pickedLoopIds.clear()
    }
    this.refreshLoopColors()
  }

  setPickedLoops(loopIds: string[]) {
    this.pickedLoopIds = new Set(loopIds)
    this.refreshLoopColors()
  }

  private loopPassesGeoGate(obj: THREE.Object3D): boolean {
    const restrictedGeoId = this.loopPickAllowedGeoId
    if (!restrictedGeoId || restrictedGeoId === '__all__') return true
    const effectiveGeoId = resolveLoopPickGeoId({
      userData: obj.userData,
      parentName: (obj.parent as THREE.Group | null)?.name ?? '',
      grandparentName: (obj.parent?.parent as THREE.Group | null)?.name ?? '',
    })
    return effectiveGeoId === restrictedGeoId
  }

  /** Resolve the loop a click or hover at the current ray would target. */
  private resolveLoopPickAtCurrentRay(): string | null {
    const hits = this.raycaster.intersectObjects(this.selectableObjects, true)

    // (1) Direct hit on a loop OUTLINE (the thin THREE.Line).
    const lineHit = hits.find(h =>
      h.object instanceof THREE.Line && !!h.object.name && this.loopPassesGeoGate(h.object))
    if (lineHit) return (lineHit.object as THREE.Line).name

    // (2) INTERIOR fallback: a small closed loop is naturally targeted at its
    // center. Pick the NEAREST pierced loop (matches every other pick path's
    // nearest-hit semantics); area only tie-breaks loops the ray reaches at
    // essentially the same distance - the original "innermost of several
    // nested loops on one plane" case (a hole inside a pocket, both at the
    // same Z). WO-350: comparing area ALONE, with no distance check, let a
    // small extreme-Z face (a chamfered part's top or bottom) a ray also
    // happens to cross further along its path steal the pick from a larger
    // intermediate chamfer contour that is the loop actually under the
    // cursor - reproduced in stlChamferContourPick.wo350.test.ts.
    const SAME_PLANE_EPS = 1e-3 // mm - matches this codebase's EDGE_Z_EPS scale
    let best: { id: string; area: number; t: number } | null = null
    for (const obj of this.selectableObjects) {
      if (!(obj instanceof THREE.Line) || !obj.name || !this.loopPassesGeoGate(obj)) continue
      const pts = this.worldPointsOfLine(obj)
      if (pts.length < 3) continue
      const hit = rayPierceLoop(pts, this.raycaster.ray.origin, this.raycaster.ray.direction)
      if (hit == null) continue
      const nearer = !best || hit.t < best.t - SAME_PLANE_EPS
      const samePlaneSmaller = best !== null && Math.abs(hit.t - best.t) <= SAME_PLANE_EPS && hit.area < best.area
      if (nearer || samePlaneSmaller) best = { id: obj.name, area: hit.area, t: hit.t }
    }
    return best?.id ?? null
  }

  private updateLoopPickHover(event: MouseEvent) {
    if (!this.loopPickCallback) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.mouse, this.camera)

    const loopId = this.resolveLoopPickAtCurrentRay()
    if (loopId !== this.loopPickHoverId) {
      this.loopPickHoverId = loopId
      this.refreshLoopColors()
    }
    this.renderer.domElement.style.cursor = loopId ? 'pointer' : 'crosshair'
  }

  /**
   * Frame the orthographic camera onto a single loop line by its `.name`
   * (loopId), keeping the CURRENT view direction (so the orbit orientation is
   * preserved) and centering the loop with surrounding part context. Used by
   * the Drill per-hole review banner to "zoom to hole" when a #N row is clicked.
   *
   * Returns false (no-op) when no line with that name exists in the four
   * loop-group maps setPickedLoops/refreshLoopColors traverse.
   *
   * The camera is orthographic, so apparent size is set by frustumSize + zoom
   * (NOT distance). We snap instantly (no tween) — the same proven mechanism
   * fitCameraToObject uses — which avoids hooking the render loop with a lerp.
   */
  focusOnLoop(loopId: string): boolean {
    // Locate the THREE.Line by name across the SAME four maps refreshLoopColors
    // walks. setFromObject below bakes in every parent transform/gizmo, so this
    // works for geometry-local AND world-space loop frames identically.
    let line: THREE.Line | null = null
    const findByName = (c: THREE.Object3D) => {
      if (line) return
      if (c instanceof THREE.Line && c.name === loopId) line = c
    }
    this.geometry2dGroups.forEach(g => g.traverse(findByName))
    if (!line) this.projectedLoopGroups.forEach(g => g.traverse(findByName))
    if (!line) this._worldPlaneLoopGroups.forEach(g => g.traverse(findByName))
    if (!line) this._geoLocalLoopGroups.forEach(g => g.traverse(findByName))
    if (!line) return false

    const bbox = new THREE.Box3().setFromObject(line)
    if (bbox.isEmpty()) return false
    // Committed to moving the camera (drill banner "zoom to hole"): this is an
    // explicit user framing, so drop the refresh-restore auto-fit suppression.
    this.cameraUserPositioned = false
    const center = bbox.getCenter(new THREE.Vector3())
    const size = bbox.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z, 1e-3)

    // Frame so the hole sits centered with neighbours visible (not filling the
    // whole screen): frustum spans ~K*maxDim, clamped to a sane mm window.
    const K = 8        // hole plus surrounding part context
    const MIN = 20     // never tighter than a 20mm window (tiny holes stay visible)
    const MAX = 400    // never zoom so far out the hole is lost
    const span = Math.min(Math.max(maxDim * K, MIN), MAX)

    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const aspect = w / h

    this.frustumSize = span
    this.camera.left = -this.frustumSize * aspect / 2
    this.camera.right = this.frustumSize * aspect / 2
    this.camera.top = this.frustumSize / 2
    this.camera.bottom = -this.frustumSize / 2
    this.camera.zoom = 1
    this.camera.updateProjectionMatrix()

    // Preserve the current orbit orientation: reuse the existing view direction
    // (camera -> target), just re-seated on the new center at a fixed distance
    // (distance is irrelevant for an ortho camera but keeps near/far sane).
    const viewDir = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
    if (viewDir.lengthSq() < 1e-9) viewDir.set(0.7, -0.9, 0.6) // degenerate guard
    viewDir.normalize()

    const dist = Math.min(Math.max(span * 5, 50), 5000)
    this.controls.target.copy(center)
    this.camera.position.copy(center).addScaledVector(viewDir, dist)
    this.camera.lookAt(center)
    this.controls.update()
    return true
  }

  // WO-257: a mesh edge chain and its sibling at another Z flatten onto the SAME
  // plane (setPartProjectedLoops draws every chain at Z2D), so two chains of one
  // hole are exactly coincident. At equal depth the LAST line drawn wins, which
  // meant a highlighted chain could be painted over by its blue neighbour and
  // the hover affordance was invisible on screen even though the material was
  // recoloured. Draw the one line that is hovered or picked last. Order only —
  // depth testing is untouched, so nothing shows through a solid that did not
  // show through before.
  private static readonly LOOP_HIGHLIGHT_RENDER_ORDER = 95

  /** WO-341: the benchmark he named ("not like our other edge selection
   *  tools") is the BREP/model edge hover (buildBrepHighlight ->
   *  createEdgeInteractionOverlay): a fat screen-space stroke — 4px hover /
   *  5px picked, worldUnits:false so the pixel width holds at any zoom — not
   *  a recolored 1px THREE.Line. A raw WebGL line's width is clamped to 1px
   *  on effectively every real browser regardless of the `linewidth`
   *  property, so matching that benchmark requires the SAME LineMaterial fat
   *  line technique other overlays here already use (buildMoveOverlay,
   *  buildBrepHighlight), added as a child of the base line rather than
   *  mutating it — the base line's geometry already carries this loop's
   *  points in the exact local frame `c` renders in, so the overlay inherits
   *  it for free with an identity transform. Colors reuse brepHoverColor()/
   *  brepPickColor() (the same GEO-26 selection-glow tokens buildBrepHighlight
   *  reads), not a new literal. depthTest stays false, matching the WO-318
   *  bypass above — this overlay is an added stroke, not a replacement for
   *  that mechanism. */
  private buildLoopHighlightOverlay(line: THREE.Line, variant: 'hover' | 'picked'): THREE.Object3D | null {
    const position = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!position || position.count < 2) return null
    const lineGeo = new LineGeometry()
    lineGeo.setPositions(Array.from(position.array as ArrayLike<number>))
    const mat = new LineMaterial({
      color: variant === 'picked' ? this.brepPickColor() : this.brepHoverColor(),
      linewidth: variant === 'picked' ? 5 : 4,
      worldUnits: false,
      depthTest: false,
      toneMapped: false,
    })
    const res = this.drawingBufferResolution()
    mat.resolution.set(res.x, res.y)
    const overlay = new Line2(lineGeo, mat)
    overlay.renderOrder = CNCViewport.LOOP_HIGHLIGHT_RENDER_ORDER + (variant === 'picked' ? 1 : 0)
    overlay.userData.isLoopHighlightOverlay = true
    return overlay
  }

  private disposeLoopHighlightOverlays() {
    for (const overlay of this.loopHighlightOverlays.values()) {
      overlay.removeFromParent()
      const line2 = overlay as Line2
      line2.geometry?.dispose?.()
      ;(line2.material as LineMaterial | undefined)?.dispose?.()
    }
    this.loopHighlightOverlays.clear()
  }

  private refreshLoopColors() {
    this.disposeLoopHighlightOverlays()
    const colorLine = (c: THREE.Object3D) => {
      if (!(c instanceof THREE.Line)) return
      const mat = c.material as THREE.LineBasicMaterial
      const orig = mat.userData.origColor as number | undefined
      const picked = this.pickedLoopIds.has(c.name)
      const hovered = c.name === this.loopPickHoverId
      const color = picked
        ? asNumber('--vp-select-amber')
        : hovered
          ? this.brepHoverColor()
          : (orig ?? asNumber('--vp-loop-default'))
      mat.color.setHex(color)
      if (mat.userData.origRenderOrder === undefined) mat.userData.origRenderOrder = c.renderOrder
      c.renderOrder = picked || hovered
        ? CNCViewport.LOOP_HIGHLIGHT_RENDER_ORDER
        : (mat.userData.origRenderOrder as number)
      // WO-318: a hovered/picked chain must read through an opaque STL/STEP
      // body — Operator's actual state, not a hidden part. setPartProjectedLoops
      // (STL/STEP local-space chains, :7256) draws WITH depth testing, unlike
      // the world-plane/geo-local overlay path (:5039) which is always
      // depthTest:false because it sits exactly on model faces. Bypass depth
      // testing only while highlighted, same lazy-capture/restore shape as
      // renderOrder above, so resting-loop appearance (and the always-off
      // world-plane/geo-local path) is unchanged.
      if (mat.userData.origDepthTest === undefined) mat.userData.origDepthTest = mat.depthTest
      mat.depthTest = picked || hovered ? false : (mat.userData.origDepthTest as boolean)
      // WO-341: layer the fat benchmark-matching stroke on top of the thin
      // recolored line above (kept as-is: several existing regression tests
      // read the base line's own material.color as their hover/pick proof).
      if (picked || hovered) {
        const overlay = this.buildLoopHighlightOverlay(c, picked ? 'picked' : 'hover')
        if (overlay) {
          c.add(overlay)
          this.loopHighlightOverlays.set(c, overlay)
        }
      }
    }
    this.geometry2dGroups.forEach(g => g.traverse(colorLine))
    this.projectedLoopGroups.forEach(g => g.traverse(colorLine))
    this._worldPlaneLoopGroups.forEach(g => g.traverse(colorLine))
    this._geoLocalLoopGroups.forEach(g => g.traverse(colorLine))
    // Picked-loop highlight also reflects on a nest SEED SLOT loop line (a seed
    // op picked it). Only the seed-placement loop lines — never the sheet
    // outline, copy lines, or the seed-outline marker (none carry seedPlacement),
    // so their per-layer colours are untouched.
    this.nestGroups.forEach(g => g.traverse(c => {
      if (c instanceof THREE.Line && c.userData?.seedPlacement === true) colorLine(c)
    }))
  }

  // ── B-rep face/edge picking mode (Stage 2, ADR 0018 D3) ───────────────────
  // Same shape as setLoopPickMode: while a kind is active, clicks toggle the
  // picked face/edge, update the orange highlight, and report via the callback.
  // kind=null exits the mode and clears highlights. Outside pick mode, clicking
  // a brep part keeps the house behavior: whole-part selection only (mirrors
  // 2D loops, which are also only individually pickable inside pick mode).

  private brepPickKind: BrepPickMode | null = null
  private brepPickCallback:
    | ((
        sel: { geoId: string; kind: 'face' | 'edge'; index: number; surfaceType?: number; isModelFace?: boolean },
        nowSelected: boolean
      ) => void)
    | null = null
  private brepPickAllowedGeoId: string | null = null
  // WO-337: OPTIONAL hover reporter for an armed brep pick session -- fires on
  // every hover-TARGET change (same cadence as the hover highlight itself),
  // with the resolved subshape or null when the cursor leaves every eligible
  // target. Callers (SetupModal's bore/boss zero-point pick) use this to
  // preview "the origin this click would produce" before the click happens.
  // Set via setBrepPickHoverCallback below -- deliberately NOT a 4th
  // positional argument on setBrepPickMode: the app's production CNCViewport
  // subclass (src/components/viewport/CNCViewport.ts) already overrides
  // setBrepPickMode and forwards a fixed 3 args to super, so any argument
  // added there would be silently dropped by that override (TypeScript
  // cannot catch a narrower override). A brand-new method has no override to
  // fall through -- it always reaches this class directly.
  private brepPickHoverCallback:
    | ((
        sel: { geoId: string; kind: 'face' | 'edge'; index: number; surfaceType?: number; isModelFace?: boolean } | null,
      ) => void)
    | null = null
  /** Picked selections, keyed `${geoId}|${kind}|${index}`. */
  private pickedBrepKeys = new Set<string>()
  /** Highlight overlay objects, same keys as pickedBrepKeys. */
  private brepHighlights = new Map<string, THREE.Object3D>()
  /** Subshape currently under the cursor in pick mode (same key format), and its preview overlay. */
  private brepHoverKey: string | null = null
  private brepHoverObj: THREE.Object3D | null = null

  setBrepPickMode(
    kind: BrepPickMode | null,
    callback?:
      | ((
          sel: { geoId: string; kind: 'face' | 'edge'; index: number; surfaceType?: number; isModelFace?: boolean },
          nowSelected: boolean
        ) => void)
      | null,
    allowedGeoId: string | null = null
  ) {
    this.brepPickKind = kind
    this.brepPickCallback = kind ? (callback ?? null) : null
    this.brepPickAllowedGeoId = kind ? allowedGeoId : null
    this.brepPickHoverCallback = null
    if (kind) {
      // Hover preview while picking (idempotent: same handler ref across re-entries).
      this.renderer.domElement.addEventListener('mousemove', this.handleBrepHoverMove)
    } else {
      this.renderer.domElement.removeEventListener('mousemove', this.handleBrepHoverMove)
      this.brepHoverKey = null
      this.refreshBrepHoverOverlay()
      this.renderer.domElement.style.cursor = ''
      this.pickedBrepKeys.clear()
      this.rebuildBrepHighlights()
    }
  }

  /**
   * WO-337: attach/clear the optional hover reporter for the CURRENTLY armed
   * pick session (a no-op, clearing to null, when no pick is armed). Call
   * AFTER setBrepPickMode(kind, ...) arms a session -- setBrepPickMode itself
   * always resets this to null so a stale callback from a previous session
   * can never leak into a new one.
   */
  setBrepPickHoverCallback(
    onHover:
      | ((
          sel: { geoId: string; kind: 'face' | 'edge'; index: number; surfaceType?: number; isModelFace?: boolean } | null,
        ) => void)
      | null,
  ) {
    this.brepPickHoverCallback = this.brepPickKind ? onHover : null
  }

  /** Sync the picked set from outside (store / wizard prefill), like setPickedLoops. */
  setPickedBrepSelections(sels: Array<{ geoId: string; kind: 'face' | 'edge'; index: number }>) {
    this.pickedBrepKeys = new Set(sels.map((s) => `${s.geoId}|${s.kind}|${s.index}`))
    this.rebuildBrepHighlights()
  }

  // World units per CSS pixel at the current ortho zoom (edge pick threshold).
  private worldUnitsPerPixel(): number {
    const h = this.renderer.domElement.clientHeight || 1
    return (this.camera.top - this.camera.bottom) / (this.camera.zoom * h)
  }

  private collectBrepObjects(allowedGeoId: string | null): {
    meshes: THREE.Mesh[]
    edgeLines: THREE.LineSegments[]
  } {
    const meshes: THREE.Mesh[] = []
    const edgeLines: THREE.LineSegments[] = []
    this.partGroups.forEach((group, geoId) => {
      if (allowedGeoId && allowedGeoId !== '__all__' && geoId !== allowedGeoId) return
      group.traverse((c) => {
        // CAM-BINDING Stage 5: a model-pick-eligible mesh (see addModelBody) is
        // collected into the SAME face-pick pool as an occt-model brep mesh -
        // resolveBrepHit below dispatches each HIT to the right resolver by its
        // own userData tag, so the two identity systems still never cross.
        if (c instanceof THREE.Mesh && (c.userData.isBrepMesh || c.userData.isModelPickMesh)) meshes.push(c)
        if (c instanceof THREE.LineSegments && c.userData.isBrepEdges) edgeLines.push(c)
      })
    })
    return { meshes, edgeLines }
  }

  // CAM-BINDING Stage 5: triangle index -> per-face LOCAL ARRAY INDEX for a
  // model-pick mesh, via the direct `modelTriFace` map (Model kernel
  // tessellations are not built face-by-face into contiguous ranges the way
  // occt-model's are, so unlike brepFaceIndexFromTriangle this is a plain O(1)
  // lookup, not a binary search). Returns -1 when the mesh carries no such
  // userData (should not happen for an isModelPickMesh-tagged mesh; defensive).
  private modelFaceIndexFromTriangle(mesh: THREE.Mesh, triIndex: number): number {
    const tf = mesh.geometry.userData.modelTriFace as Uint32Array | undefined
    if (!tf || triIndex < 0 || triIndex >= tf.length) return -1
    return tf[triIndex]
  }

  // triangle index -> B-rep face index via faceRanges (ranges are contiguous
  // and ascending, so binary search on the range starts).
  private brepFaceIndexFromTriangle(mesh: THREE.Mesh, triIndex: number): number {
    const fr = mesh.geometry.userData.faceRanges as Uint32Array | undefined
    if (!fr) return -1
    const offset = triIndex * 3
    let lo = 0
    let hi = fr.length / 2 - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const start = fr[2 * mid]
      const count = fr[2 * mid + 1]
      if (offset < start) hi = mid - 1
      else if (offset >= start + count) lo = mid + 1
      else return mid
    }
    return -1
  }

  // segment index -> B-rep edge index via the edgeSegStarts prefix sums.
  private brepEdgeIndexFromSegment(lines: THREE.LineSegments, segIndex: number): number {
    const starts = lines.geometry.userData.edgeSegStarts as Uint32Array | undefined
    if (!starts) return -1
    let lo = 0
    let hi = starts.length - 2
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (segIndex < starts[mid]) hi = mid - 1
      else if (segIndex >= starts[mid + 1]) lo = mid + 1
      else return mid
    }
    return -1
  }

  /**
   * The setup-origin picker accepts faces and closed circular edges in one
   * session. Cylinders also carry an open seam edge, and the ordinary generous
   * edge tolerance can hit that seam while the pointer is plainly on the side
   * face. Let open edges yield to a face under the same ray; a deliberate
   * closed rim remains an edge and is validated as circular by SetupModal.
   */
  private brepEdgeIsClosed(lines: THREE.LineSegments, edgeIndex: number): boolean {
    const ranges = lines.geometry.userData.edgeRanges as Uint32Array | undefined
    const positions = lines.geometry.userData.edgePositions as Float32Array | undefined
    if (!ranges || !positions || edgeIndex < 0 || edgeIndex * 2 + 1 >= ranges.length) return false
    const start = ranges[edgeIndex * 2]
    const count = ranges[edgeIndex * 2 + 1]
    if (count < 4) return false
    const first = start * 3
    const last = (start + count - 1) * 3
    return Math.hypot(
      positions[last] - positions[first],
      positions[last + 1] - positions[first + 1],
      positions[last + 2] - positions[first + 2],
    ) <= BREP_EDGE_CLOSURE_TOLERANCE
  }

  // GEO-25b: edge-pick screen-pixel tolerance multiplier -- see the doc
  // comment at its one use site in resolveBrepHit for the before/after and
  // the sketcher-parity calibration.
  private static readonly BREP_EDGE_PICK_TOLERANCE_PX = 10

  /**
   * Q-92: the owning geometry id a pick-eligible object carries, or null when
   * it carries none. Pick callers now derive the operation's body/source from
   * the HIT rather than from a preselected body, so an unresolvable owner must
   * fail loud (named console error, no selection reported) rather than travel
   * onward as an `undefined` masquerading as a string.
   */
  private resolveBrepPickOwnerGeoId(
    object: THREE.Object3D,
    key: 'brepGeoId' | 'modelPickGeoId',
  ): string | null {
    const geoId = object.userData?.[key]
    if (typeof geoId === 'string' && geoId.length > 0) return geoId
    console.error(
      `[CNCViewport] pick-eligible object "${object.name || object.uuid}" carries no ${key}; ` +
      'refusing the pick rather than reporting a face with no owning body.',
    )
    return null
  }

  // Resolve the subshape under the current raycaster ray for the active pick
  // kind. The CALLER positions the ray (click handler sets it from the click;
  // the hover handler sets it from the move). Shared so hover previews exactly
  // what a click would pick.
  private resolveBrepHit(): { geoId: string; kind: 'face' | 'edge'; index: number; surfaceType?: number; isModelFace?: boolean } | null {
    const kind = this.brepPickKind
    if (!kind) return null
    const { meshes, edgeLines } = this.collectBrepObjects(this.brepPickAllowedGeoId)
    let sel: { geoId: string; kind: 'face' | 'edge'; index: number; surfaceType?: number; isModelFace?: boolean } | null = null

    let faceSelection: {
      geoId: string
      kind: 'face' | 'edge'
      index: number
      surfaceType?: number
      isModelFace?: boolean
    } | null = null
    let faceDistance = Infinity
    if (kind === 'face' || kind === 'face-or-edge') {
      const hits = this.raycaster.intersectObjects(meshes, false)
      const hit = hits.find((h) => h.faceIndex != null)
      if (hit) {
        faceDistance = hit.distance
        const mesh = hit.object as THREE.Mesh
        // CAM-BINDING Stage 5: a model-pick mesh resolves through its OWN
        // direct triFace lookup, never occt-model's faceRanges/faceTypes -
        // the two identity systems stay separate all the way to this hit.
        if (mesh.userData.isModelPickMesh) {
          const faceIdx = this.modelFaceIndexFromTriangle(mesh, hit.faceIndex!)
          // Q-92: a face pick now reports the body it OWNS, and callers bind
          // that identity instead of a preselected one. A pick-eligible mesh
          // with no owning geoId is therefore a broken invariant, not a
          // cosmetic one - say so instead of handing back a bogus `undefined`
          // geoId that a caller could mistake for the current source.
          const geoId = this.resolveBrepPickOwnerGeoId(mesh, 'modelPickGeoId')
          if (faceIdx >= 0 && geoId !== null) {
            faceSelection = { geoId, kind: 'face', index: faceIdx, isModelFace: true }
          }
        } else {
          const faceIdx = this.brepFaceIndexFromTriangle(mesh, hit.faceIndex!)
          const geoId = this.resolveBrepPickOwnerGeoId(mesh, 'brepGeoId')
          if (faceIdx >= 0 && geoId !== null) {
            // OCCT GeomAbs surface type (Plane=0, Cylinder=1, Cone=2, ...) for smart routing.
            const surfaceType = (mesh.geometry.userData.faceTypes as Uint8Array | undefined)?.[faceIdx]
            faceSelection = { geoId, kind: 'face', index: faceIdx, surfaceType }
          }
        }
      }
      if (kind === 'face') return faceSelection
    }

    if (kind === 'edge' || kind === 'face-or-edge') {
      // Edge mode: generous, zoom-scaled threshold, then prefer the edge hit
      // over the face hit within a small depth tolerance (edges lie ON
      // faces, so the face hit is always at nearly the same distance).
      // GEO-25b (Operator's reopen): widened from *6 (~6px) to
      // *BREP_EDGE_PICK_TOLERANCE_PX (~10px) -- Operator's verbatim complaint was
      // "the selection zone around them had to be too exact". Calibrated
      // against the sketcher's own generous feel
      // (src/lib/sketch/sketcher/sketchInteraction.ts: SKETCH_PICK_PX = 8,
      // SKETCH_PICK_GENEROUS_PX = 16) but held a shade tighter than the
      // sketcher's "generous" tier -- a real STEP import commonly has
      // fillet/chamfer edges running close together, where too generous a
      // radius trades one kind of frustration (missed clicks) for another
      // (wrong-edge clicks).
      const tol = this.worldUnitsPerPixel() * CNCViewport.BREP_EDGE_PICK_TOLERANCE_PX
      const prevThreshold = this.raycaster.params.Line.threshold
      this.raycaster.params.Line.threshold = tol
      const edgeHits = this.raycaster.intersectObjects(edgeLines, false)
      this.raycaster.params.Line.threshold = prevThreshold
      if (!Number.isFinite(faceDistance)) {
        const faceHits = this.raycaster.intersectObjects(meshes, false)
        faceDistance = faceHits.length > 0 ? faceHits[0].distance : Infinity
      }
      const edgeHit = edgeHits.find((h) => h.index != null && h.distance <= faceDistance + tol * 2)
      if (edgeHit) {
        const lines = edgeHit.object as THREE.LineSegments
        const edgeIdx = this.brepEdgeIndexFromSegment(lines, Math.floor(edgeHit.index! / 2))
        const geoId = this.resolveBrepPickOwnerGeoId(lines, 'brepGeoId')
        const openEdgeOverFace = kind === 'face-or-edge' && faceSelection !== null &&
          !this.brepEdgeIsClosed(lines, edgeIdx)
        if (edgeIdx >= 0 && geoId !== null && !openEdgeOverFace) {
          sel = { geoId, kind: 'edge', index: edgeIdx }
        }
      }
    }

    return sel ?? faceSelection
  }

  // Click handler body for brep pick mode. Clicking empty space keeps the mode
  // active (same as loop pick mode).
  private handleBrepPickClick() {
    const sel = this.resolveBrepHit()
    if (!sel) return
    const key = `${sel.geoId}|${sel.kind}|${sel.index}`
    const nowSelected = !this.pickedBrepKeys.has(key)
    if (nowSelected) this.pickedBrepKeys.add(key)
    else this.pickedBrepKeys.delete(key)
    this.rebuildBrepHighlights()
    // The hovered subshape may have just been (un)picked - re-evaluate whether
    // the hover preview should show (it is skipped on picked subshapes).
    this.refreshBrepHoverOverlay()
    this.brepPickCallback?.(sel, nowSelected)
  }

  // Hover preview for brep pick mode: raycast per move (same approach as the
  // lay-on-face hover) and overlay the subshape a click would pick in a
  // lighter tint. Attached/detached by setBrepPickMode. The base mesh is never
  // recolored - hover is its own overlay object, like the picked highlights.
  private handleBrepHoverMove = (event: MouseEvent) => {
    if (!this.brepPickKind) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.mouse, this.camera)
    const sel = this.resolveBrepHit()
    const key = sel ? `${sel.geoId}|${sel.kind}|${sel.index}` : null
    this.renderer.domElement.style.cursor = key ? 'pointer' : ''
    if (key === this.brepHoverKey) return
    this.brepHoverKey = key
    this.refreshBrepHoverOverlay()
    this.brepPickHoverCallback?.(sel)
  }

  /**
   * (Re)build the hover preview overlay from brepHoverKey. Already-picked
   * subshapes get NO hover overlay so the picked orange stays visible
   * unchanged - hovering them just shows the pointer cursor (a click there
   * would deselect).
   */
  private refreshBrepHoverOverlay() {
    if (this.brepHoverObj != null) {
      this.disposeBrepHighlight(this.brepHoverObj)
      this.brepHoverObj = null
    }
    const key = this.brepHoverKey
    if (!key || this.pickedBrepKeys.has(key)) return
    const [geoId, kind, indexStr] = key.split('|')
    this.brepHoverObj = this.buildBrepHighlight(geoId, kind as 'face' | 'edge', parseInt(indexStr, 10), 'hover')
  }

  // ---- Highlight rendering ----
  // One small overlay object per picked face/edge, built from JUST that
  // subshape's triangle/polyline range (never a clone of the whole geometry).
  // Overlays are children of the brep mesh, so part transforms apply for free.

  private static readonly BREP_PICK_COLOR_BASE = asNumber('--vp-brep-pick')  // house picked-orange
  private static readonly BREP_HOVER_COLOR_BASE = asNumber('--vp-brep-hover') // lighter hover preview

  /** GEO-26 Stage B: resolves through the shared selectionGlowTokens token
   *  set, using this.selectionGlow -- the shipped DEFAULT_SELECTION_GLOW
   *  since WO-286 removed the last preference read, or whatever a direct
   *  setSelectionGlow() caller set. 'current' returns the exact pre-existing
   *  BREP_PICK_COLOR_BASE/BREP_HOVER_COLOR_BASE constants -- byte-identical
   *  to shipped, still reachable by explicitly picking 'Current' in Settings.
   *  Instance methods (not static readonly fields) because the resolved
   *  color depends on the LIVE viewportThemeId + selectionGlow, not just a
   *  CSS var read once at class-definition time. */
  private brepPickColor(): number {
    const glow = resolveSelectionGlowColors(this.selectionGlow, this.viewportThemeId)
    return glow === null ? CNCViewport.BREP_PICK_COLOR_BASE : glow.selected
  }

  private brepHoverColor(): number {
    const glow = resolveSelectionGlowColors(this.selectionGlow, this.viewportThemeId)
    return glow === null ? CNCViewport.BREP_HOVER_COLOR_BASE : glow.hover
  }

  /** WO-351 ("an orange highlight on an orange body is no highlight"):
   *  brepPickColor()/brepHoverColor() and partInteractionColor() (the whole-
   *  body 'selected' fill) both resolve through resolveSelectionGlowColors's
   *  SAME {hover, selected} pair, so a picked edge/face on a body whose fill
   *  is ALSO 'selected' is structurally guaranteed to draw the identical
   *  colour as that fill. This is the ONE place that resolves "is amber
   *  already being drawn where this highlight would land" + "which
   *  edge/face variant" into the final draw colour, so no future call site
   *  can reintroduce the collision by resolving its own colour independently.
   *
   *  Audit fix round 1: the first version gated on currentShadingMode
   *  ('shaded-edges'/'shaded-no-edges' = opaque, anything else = not) - a
   *  FALSE PROXY for "is an opaque fill drawn", fixed by reading the LIVE
   *  material (`wireframe === false && transparent === false`, the exact
   *  THREE contract for "an opaque triangle surface is being drawn") instead
   *  of guessing from the mode.
   *
   *  Audit fix round 2: that fill-opaque predicate is the right question for
   *  a FACE highlight, which sits on the fill itself - but the wrong one for
   *  an EDGE highlight. paintPartHighlight's createBodyInteractionOverlay
   *  paints a 5px amber topology-outline stroke along EVERY edge of a
   *  selected body, in every display mode, completely independent of
   *  whether the fill is opaque (interactionOverlayVisibleForMode returns
   *  true unconditionally). So an edge highlight collides with that outline
   *  whenever the body is selected, full stop - wireframe (Unshaded on an
   *  imported body) and transparent (Translucent) fills still sit under an
   *  opaque amber outline stroke on that same edge. Gating edges on the
   *  fill-opaque check left exactly those two cases uncovered: the fill
   *  predicate was false there, so the highlight fell back to the same
   *  {selected} token the outline itself draws - byte-identical amber on
   *  byte-identical amber, 1.00:1. A face highlight's collision surface is
   *  still the fill (a filled face overlay sits on the mesh surface, not
   *  primarily on the perimeter stroke), so faces keep the fill-opaque
   *  check.
   *
   *  Both applyShadingMode (mode changes) and paintPartHighlight (selection
   *  changes, via resyncBrepHighlightColorsFor) re-resolve every live
   *  overlay through this same function so neither side can strand a colour
   *  resolved under state that has since moved. */
  private brepHighlightColorFor(geoId: string, kind: 'face' | 'edge', variant: 'picked' | 'hover'): number {
    const mat3d = this.partMaterials.get(geoId)
    const bodySelected = this.partInteractionVariant(geoId) === 'selected'
      && this.getPartSelectedMaterialStates().has(geoId)
      && mat3d !== undefined
    // Edge: the body's own selected-outline stroke is drawn along this same
    // edge in every mode, so any selected body already means "amber here".
    // Face: only the fill itself is coincident, and only while it is
    // actually painting opaque pixels (not wireframe, not transparent).
    const collides = kind === 'edge'
      ? bodySelected
      : bodySelected && mat3d!.wireframe === false && mat3d!.transparent === false
    if (collides) {
      return variant === 'picked'
        ? asNumber('--vp-brep-pick-on-selected')
        : asNumber('--vp-brep-hover-on-selected')
    }
    return variant === 'picked' ? this.brepPickColor() : this.brepHoverColor()
  }

  /** Recompute every existing B-rep pick/hover overlay colour for `geoId`
   *  through brepHighlightColorFor. paintPartHighlight calls this after
   *  every selection/tint change to that body - an overlay built while the
   *  body was (not) fill-painted must not keep drawing the colour that
   *  state resolved to once the body's state moves out from under it. */
  private resyncBrepHighlightColorsFor(geoId: string): void {
    const prefix = `${geoId}|`
    for (const [key, overlay] of this.getBrepHighlights()) {
      if (key.startsWith(prefix)) {
        syncInteractionColor(overlay, this.brepHighlightColorFor(geoId, key.includes('|edge|') ? 'edge' : 'face', 'picked'))
      }
    }
    if (this.brepHoverObj != null && this.brepHoverKey?.startsWith(prefix)) {
      const hoverKind = this.brepHoverKey.includes('|edge|') ? 'edge' : 'face'
      syncInteractionColor(this.brepHoverObj, this.brepHighlightColorFor(geoId, hoverKind, 'hover'))
    }
  }

  private buildBrepHighlight(
    geoId: string,
    kind: 'face' | 'edge',
    index: number,
    variant: 'picked' | 'hover' = 'picked'
  ): THREE.Object3D | null {
    const { meshes, edgeLines } = this.collectBrepObjects(geoId)
    const mesh = meshes[0]
    if (!mesh) return null
    const color = this.brepHighlightColorFor(geoId, kind, variant)
    const resolution = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    const clippingPlanes = (mesh.material as THREE.Material).clippingPlanes

    if (kind === 'face') {
      const tf = mesh.geometry.userData.modelTriFace as Uint32Array | undefined
      const pos = faceTrianglePositions({
        geometry: mesh.geometry,
        faceIndex: index,
        triFace: tf,
        faceRanges: tf === undefined
          ? mesh.geometry.userData.faceRanges as Uint32Array | undefined
          : undefined,
      })
      if (pos === null) return null
      const highlight = createFaceInteractionOverlay({
        trianglePositions: pos,
        variant: variant === 'picked' ? 'selected' : 'hovered',
        resolution,
        clippingPlanes,
        color,
      })
      if (highlight === null) return null
      highlight.visible = interactionOverlayVisibleForMode('face', this.currentShadingMode)
      mesh.add(highlight)
      return highlight
    }

    const lines = edgeLines[0]
    if (!lines) return null
    const er = lines.geometry.userData.edgeRanges as Uint32Array | undefined
    const ep = lines.geometry.userData.edgePositions as Float32Array | undefined
    if (!er || !ep || index < 0 || 2 * index >= er.length) return null
    const start = er[2 * index]      // point offset
    const count = er[2 * index + 1]  // point count
    const pos = ep.slice(start * 3, (start + count) * 3)
    const highlight = createEdgeInteractionOverlay({
      polylinePositions: pos,
      variant: variant === 'picked' ? 'selected' : 'hovered',
      resolution,
      clippingPlanes,
      color,
    })
    if (highlight === null) return null
    highlight.visible = interactionOverlayVisibleForMode('edge', this.currentShadingMode)
    mesh.add(highlight)
    return highlight
  }

  // WO-1923: facet highlight for a recognised STL feature (hole / blend / flat
  // face) picked in the Properties panel. One overlay per part, composed with
  // (not replacing) the whole-part and B-rep overlays. Facet id = triangle
  // index into the DISPLAYED mesh; the caller converts source ids (an edited
  // part is renumbered).
  private stlFacetHighlights = new Map<string, THREE.Object3D>()
  private getStlFacetHighlights(): Map<string, THREE.Object3D> {
    return this.stlFacetHighlights
      ?? (this.stlFacetHighlights = new Map<string, THREE.Object3D>())
  }

  setHighlightedFacets(geoId: string, facetIds: number[] | null): void {
    const existing = this.getStlFacetHighlights().get(geoId)
    if (existing !== undefined) {
      this.disposeBrepHighlight(existing)
      this.getStlFacetHighlights().delete(geoId)
    }
    if (facetIds === null || facetIds.length === 0) return
    const group = this.partGroups.get(geoId)
    const presentation = group === undefined ? null : this.bodyPresentationForGroup(group)
    if (presentation === null) return
    const geometry = presentation.mesh.geometry
    const position = geometry.getAttribute('position')
    if (position === undefined) return
    const index = geometry.getIndex()
    const triangleCount = index !== null ? index.count / 3 : position.count / 3
    const valid = facetIds.filter((f) => Number.isInteger(f) && f >= 0 && f < triangleCount)
    if (valid.length === 0) return
    const pos = new Float32Array(valid.length * 9)
    let o = 0
    for (const f of valid) {
      for (let k = 0; k < 3; k++) {
        const v = index !== null ? index.getX(f * 3 + k) : f * 3 + k
        pos[o++] = position.getX(v)
        pos[o++] = position.getY(v)
        pos[o++] = position.getZ(v)
      }
    }
    const renderer = this.renderer as THREE.WebGLRenderer | undefined
    const resolution = renderer?.getDrawingBufferSize?.(new THREE.Vector2()) ?? new THREE.Vector2(1, 1)
    const overlay = createFaceInteractionOverlay({
      trianglePositions: pos,
      variant: 'selected',
      resolution,
      clippingPlanes: (presentation.mesh.material as THREE.Material).clippingPlanes,
      color: this.brepHighlightColorFor(geoId, 'face', 'picked'),
    })
    if (overlay === null) return
    overlay.visible = interactionOverlayVisibleForMode('face', this.currentShadingMode)
    presentation.mesh.add(overlay)
    this.getStlFacetHighlights().set(geoId, overlay)
  }

  private disposeBrepHighlight(obj: THREE.Object3D) {
    disposeInteractionOverlay(obj)
  }

  /** Diff the overlay map against pickedBrepKeys: add missing, drop stale. */
  private rebuildBrepHighlights() {
    const highlights = this.getBrepHighlights()
    for (const [key, obj] of highlights) {
      if (!this.pickedBrepKeys.has(key)) {
        this.disposeBrepHighlight(obj)
        highlights.delete(key)
      }
    }
    for (const key of this.pickedBrepKeys) {
      if (highlights.has(key)) continue
      const [geoId, kind, indexStr] = key.split('|')
      const obj = this.buildBrepHighlight(geoId, kind as 'face' | 'edge', parseInt(indexStr, 10))
      if (obj) highlights.set(key, obj)
    }
  }

  /** Drop picked state + overlays for one geometry (part removed / re-imported). */
  private clearBrepStateFor(geoId: string) {
    const prefix = `${geoId}|`
    for (const key of [...this.pickedBrepKeys]) {
      if (key.startsWith(prefix)) this.pickedBrepKeys.delete(key)
    }
    const highlights = this.getBrepHighlights()
    for (const [key, obj] of [...highlights]) {
      if (key.startsWith(prefix)) {
        this.disposeBrepHighlight(obj)
        highlights.delete(key)
      }
    }
    if (this.brepHoverKey?.startsWith(prefix)) {
      this.brepHoverKey = null
      this.refreshBrepHoverOverlay()
    }
  }

  // Dev/test helper (Stage 2 gate script): project a part-local point to page
  // (client) pixel coordinates so playwright can issue real synthetic clicks.
  partPointToScreen(geoId: string, p: { x: number; y: number; z: number }): { x: number; y: number } | null {
    const group = this.partGroups.get(geoId) ?? this.geometry2dGroups.get(geoId)
    if (!group) return null
    group.updateMatrixWorld(true)
    const world = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(group.matrixWorld)
    const ndc = world.project(this.camera)
    const rect = this.renderer.domElement.getBoundingClientRect()
    return {
      x: rect.left + ((ndc.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - ndc.y) / 2) * rect.height,
    }
  }

  /** Project a WORLD-space point (mm) to viewport client pixels. The world-space
   *  sibling of `partPointToScreen` (which projects a part-LOCAL point through a
   *  part group's matrix); used for overlays/labels anchored to world geometry
   *  such as a picked toolpath move, and by move-pick evidence tooling. */
  worldPointToScreen(p: { x: number; y: number; z: number }): { x: number; y: number } {
    const ndc = new THREE.Vector3(p.x, p.y, p.z).project(this.camera)
    const rect = this.renderer.domElement.getBoundingClientRect()
    return {
      x: rect.left + ((ndc.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - ndc.y) / 2) * rect.height,
    }
  }

  // ── 2D Geometry ────────────────────────────────────────────────────────────
  //
  // Each imported 2D file gets one THREE.Group (keyed by geometry id) that
  // holds one THREE.Line / THREE.LineLoop per loop.  The group is attached to
  // the workpieceGroup and supports the same TransformControls gizmo as 3D parts.

  private geometry2dGroups    = new Map<string, THREE.Group>()
  // layerId → THREE.LineBasicMaterial[]  (so we can re-colour / hide per layer)
  private geometry2dLayerMats = new Map<string, Map<string, THREE.LineBasicMaterial[]>>()
  // "geoId|layerId" → the layer's REQUESTED visibility (project state). The
  // material's effective visibility is requested && not-being-sketch-edited,
  // so the editing override can be lifted without losing the user's toggle.
  private layer2dRequestedVisible = new Map<string, boolean>()
  // Layer whose document is OPEN in sketch mode: its stale baked loops must
  // not render under the live sketch (re-edit delete ghost, 2026-06-11).
  // Consulted by add2DGeometry too, so scene rebuilds (undo / project reload)
  // during an open sketch keep the layer hidden.
  private sketchEditLayerId: string | null = null

  private static readonly Z2D = 0.3   // mm above table to avoid z-fighting

  add2DGeometry(
    id: string,
    loops: Array<{ id: string; points: Array<{ x: number; y: number }>; closed: boolean; layerId: string }>,
    layers: Array<{ id: string; color: string; visible: boolean }>,
    position = { x: 0, y: 0, z: 0 },
    rotation = { x: 0, y: 0, z: 0 }
  ) {
    // Remove existing instance if re-loading. remove2DGeometry deselects, so
    // capture the selection first and restore it below -- otherwise finishing a
    // sketch (which rebuilds this geometry) would silently drop the gizmo.
    const restoreSelection = this.selectedPartId === id
    this.remove2DGeometry(id)

    const group = new THREE.Group()
    group.name  = id
    // The stored Z is respected (B11): deliberate Z placement (typed in the
    // properties panel or gizmo-dragged) must survive scene rebuilds (undo,
    // project open). Loops still render at +Z2D inside the group.
    group.position.set(position.x, position.y, position.z)
    group.rotation.set(
      THREE.MathUtils.degToRad(rotation.x),
      THREE.MathUtils.degToRad(rotation.y),
      THREE.MathUtils.degToRad(rotation.z)
    )

    // Build color + visibility map from layers array
    const layerColor   = new Map<string, string>()
    const layerVisible = new Map<string, boolean>()
    for (const l of layers) {
      layerColor.set(l.id, l.color)
      layerVisible.set(l.id, l.visible)
      this.layer2dRequestedVisible.set(`${id}|${l.id}`, l.visible)
    }

    const geoLayerMats = new Map<string, THREE.LineBasicMaterial[]>()

    for (const loop of loops) {
      const hexStr = layerColor.get(loop.layerId) ?? asHex('--vp-loop-default')
      const color  = parseInt(hexStr.replace('#', ''), 16)
      const mat    = new THREE.LineBasicMaterial({ color, linewidth: 1 })
      mat.toneMapped = false            // render at true sRGB, not through ACES tone mapping
      mat.needsUpdate = true
      mat.visible  = (layerVisible.get(loop.layerId) ?? true) &&
                     loop.layerId !== this.sketchEditLayerId
      mat.userData.origColor = color   // saved for highlight restore

      // Register material so layer toggles can find it
      const mats = geoLayerMats.get(loop.layerId) ?? []
      mats.push(mat)
      geoLayerMats.set(loop.layerId, mats)

      // Build geometry — Z slightly above table
      const pts = loop.points.map(
        p => new THREE.Vector3(p.x, p.y, CNCViewport.Z2D)
      )
      if (loop.closed && pts.length > 0) pts.push(pts[0].clone())  // close the line

      const geo  = new THREE.BufferGeometry().setFromPoints(pts)
      const line = new THREE.Line(geo, mat)
      line.name  = loop.id
      group.add(line)
    }

    this.geometry2dGroups.set(id, group)
    this.geometry2dLayerMats.set(id, geoLayerMats)
    this.workpieceGroup.add(group)
    this.updateSelectableObjects()
    this.rebuildStock()

    // Fit camera to workpiece group on the first geometry item (3D or 2D),
    // unless the user has positioned the camera (refresh-restore preserves framing).
    const totalParts = this.partGroups.size + this.geometry2dGroups.size
    this.maybeAutoFit(totalParts === 1, 'add2DGeometry')
    // Re-attach at the NEW bounds center: an edited sketch may have grown or
    // moved, so the anchor must follow the geometry, not the old center.
    if (restoreSelection && this.canAttachPartTransformGizmo()) this.setSelectedPart(id)
  }

  remove2DGeometry(id: string) {
    const group = this.geometry2dGroups.get(id)
    if (group) {
      this.workpieceGroup.remove(group)
      group.traverse(c => {
        if (c instanceof THREE.Line) {
          c.geometry.dispose()
          ;(Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose())
        }
      })
    }
    this.geometry2dGroups.delete(id)
    this.geometry2dLayerMats.delete(id)
    for (const key of [...this.layer2dRequestedVisible.keys()]) {
      if (key.startsWith(`${id}|`)) this.layer2dRequestedVisible.delete(key)
    }
    if (this.selectedPartId === id) this.setSelectedPart(null)
    this.updateSelectableObjects()
    this.rebuildStock()
  }

  // ── Instanced nests (ADR 0024) ───────────────────────────────────────────────
  //
  // A nest is rendered WITHOUT duplicating geometry: one parent THREE.Group per
  // nest (keyed by nestId in nestGroups) holds a sheet-outline rectangle plus one
  // posed child Group per placement. Each child Group is positioned at the
  // placement's (x, y) on the sheet plane (Z2D) and Z-rotated by rotationDeg, and
  // contains one THREE.Line per loop of the SOURCE part. Loops within a single
  // placement SHARE one BufferGeometry per source loop (built once, reused across
  // the placement's own lines); the THREE.Line wrappers are per-placement (they
  // carry the per-group transform). Depth-1 (inside-window) copies are coloured
  // distinctly from depth-0 so they read against the host part. The caller resolves
  // and passes the source loops; CNCViewport never reaches into the store.

  private nestGroups = new Map<string, THREE.Group>()
  /** Current visibility of the seed-slot bounding-box outlines. Default ON;
   *  driven by the showSeedOutline view pref via setSeedOutlineVisible. Applied
   *  to outlines at creation time so newly-computed nests do not flash. */
  private seedOutlineVisible = true
  private static readonly NEST_Z2D = CNCViewport.Z2D

  addNestInstances(
    nestId: string,
    sheet: { width: number; height: number },
    placements: Array<NestPose & { partId: string; instanceId?: string; depth: number }>,
    sourceLoopsById: Map<string, Array<{ points: Array<{ x: number; y: number }> }>>,
    // Seed-slot rendering (ADR 0025 §2, refined seed model). The seed is the
    // LOWER-LEFT placement instance per source IN the nest (not a floating
    // external copy). For those instanceIds we render the slot with the SOURCE
    // geometry's REAL per-layer colors (the nest's stored loops may be stripped
    // of layerId) plus a --vp-seed outline box, and tag the meshes for future
    // feature-picking (P6). Both optional so test doubles / minimal bindings
    // stay valid; absent => every placement uses flat depth coloring.
    seedInstanceIds?: Set<string>,
    seedSourcesById?: Map<string, {
      loops: Array<{ id?: string; points: Array<{ x: number; y: number }>; layerId: string }>
      layers: Array<{ id: string; color: string; visible: boolean }>
    }>,
  ) {
    // Re-loading: drop the previous render of this nest first.
    this.removeNestInstances(nestId)

    const z = CNCViewport.NEST_Z2D
    const group = new THREE.Group()
    group.name = `nest:${nestId}`

    // Sheet outline rectangle (0,0)-(width,height) in world XY at the 2D plane.
    // A subtle stock-edge colour so it reads as the sheet, distinct from parts.
    const sheetMat = new THREE.LineBasicMaterial({ color: asNumber('--vp-stock-edge') })
    sheetMat.toneMapped = false
    const sheetPts = [
      new THREE.Vector3(0, 0, z),
      new THREE.Vector3(sheet.width, 0, z),
      new THREE.Vector3(sheet.width, sheet.height, z),
      new THREE.Vector3(0, sheet.height, z),
      new THREE.Vector3(0, 0, z),
    ]
    const sheetGeo = new THREE.BufferGeometry().setFromPoints(sheetPts)
    group.add(new THREE.Line(sheetGeo, sheetMat))

    // Part colours: depth-0 placed on the sheet vs depth-1 nested inside a window.
    const colorDepth0 = asNumber('--vp-loop-default')
    const colorDepth1 = asNumber('--role-stepover')   // distinct green for in-window copies

    for (const p of placements) {
      const isSeed = !!(p.instanceId && seedInstanceIds?.has(p.instanceId))
      const seedSrc = isSeed ? seedSourcesById?.get(p.partId) : undefined

      const child = new THREE.Group()
      const pose = placementToScenePose(p, z)
      child.position.set(pose.position.x, pose.position.y, pose.position.z)
      child.rotation.z = pose.rotationZ

      if (seedSrc && seedSrc.loops.length > 0) {
        // SEED SLOT: render the LIVE source loops with their REAL per-layer
        // colors (HARD constraint — never recolor seed loops; Operator selects
        // geometry by feature/color when authoring seed toolpaths). Tag each
        // mesh for future feature-picking and draw a violet outline marker.
        const lines = this.buildLayerColoredLines(seedSrc.loops, seedSrc.layers)
        for (const line of lines) {
          line.userData.geometryId = p.partId
          line.userData.seedPlacement = true
          child.add(line)
        }
        const outline = this.buildSeedSlotOutline(child)
        if (outline) {
          outline.visible = this.seedOutlineVisible
          child.add(outline)
        }
      } else {
        // COPY (or seed source unavailable): flat depth coloring, as before.
        const loops = sourceLoopsById.get(p.partId)
        if (!loops || loops.length === 0) continue   // missing source -> skip (caller logs)

        const mat = new THREE.LineBasicMaterial({
          color: (p.depth >= 1) ? colorDepth1 : colorDepth0,
        })
        mat.toneMapped = false

        for (const loop of loops) {
          if (loop.points.length < 2) continue
          // Source loops are in the part-LOCAL frame; the child-group transform
          // applies the placement pose. Lines sit at z=0 inside the child (the
          // child itself is already lifted to the Z2D plane).
          const pts = loop.points.map(pt => new THREE.Vector3(pt.x, pt.y, 0))
          pts.push(pts[0].clone())   // close the loop
          const geo = new THREE.BufferGeometry().setFromPoints(pts)
          child.add(new THREE.Line(geo, mat))
        }
      }
      group.add(child)
    }

    this.nestGroups.set(nestId, group)
    this.workpieceGroup.add(group)
    // Seed-slot loop lines are loop-pickable (authoring a seed op): refresh the
    // raycast set so they enter selectableObjects.
    this.updateSelectableObjects()
  }

  /** Build per-layer-coloured THREE.Line objects for a set of 2D loops, using
   *  the SAME layer-color resolution add2DGeometry applies (CSS layer color ->
   *  sRGB int, --vp-loop-default fallback). Lines sit at z=0 in the caller's
   *  local frame; the caller parents/transforms them. Shared so the seed slot
   *  renders identically to a standalone part without duplicating the logic. */
  private buildLayerColoredLines(
    loops: Array<{ id?: string; points: Array<{ x: number; y: number }>; layerId: string }>,
    layers: Array<{ id: string; color: string; visible: boolean }>,
  ): THREE.Line[] {
    const layerColor = new Map<string, string>()
    for (const l of layers) layerColor.set(l.id, l.color)

    const lines: THREE.Line[] = []
    for (const loop of loops) {
      if (loop.points.length < 2) continue
      const hexStr = layerColor.get(loop.layerId) ?? asHex('--vp-loop-default')
      const color  = parseInt(hexStr.replace('#', ''), 16)
      const mat    = new THREE.LineBasicMaterial({ color, linewidth: 1 })
      mat.toneMapped = false
      mat.userData.origColor = color   // saved for picked-loop highlight restore
      const pts = loop.points.map(pt => new THREE.Vector3(pt.x, pt.y, 0))
      pts.push(pts[0].clone())   // close the loop
      const geo  = new THREE.BufferGeometry().setFromPoints(pts)
      const line = new THREE.Line(geo, mat)
      // Loop id => line.name lets the seed slot be loop-picked exactly like a
      // standalone 2D loop (CNCViewport.add2DGeometry sets line.name = loop.id).
      if (loop.id) line.name = loop.id
      lines.push(line)
    }
    return lines
  }

  /** Build a --vp-seed bounding-box outline (XY rectangle) sized to the seed
   *  slot child group's current local extent, padded so it sits OUTSIDE the
   *  part outline. Default VISIBLE; named 'seed-outline' so a follow-up commit
   *  can toggle it. Returns null for an empty group. */
  private buildSeedSlotOutline(child: THREE.Group): THREE.Line | null {
    const box = new THREE.Box3()
    child.traverse((c) => {
      if (c === child) return
      const obj = c as THREE.Line
      const geom = obj.geometry as THREE.BufferGeometry | undefined
      if (geom) {
        geom.computeBoundingBox()
        const bb = geom.boundingBox
        if (bb) box.union(bb)
      }
    })
    if (box.isEmpty()) return null
    const pad = 0.5
    const minX = box.min.x - pad, minY = box.min.y - pad
    const maxX = box.max.x + pad, maxY = box.max.y + pad
    const pts = [
      new THREE.Vector3(minX, minY, 0),
      new THREE.Vector3(maxX, minY, 0),
      new THREE.Vector3(maxX, maxY, 0),
      new THREE.Vector3(minX, maxY, 0),
      new THREE.Vector3(minX, minY, 0),
    ]
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const mat = new THREE.LineBasicMaterial({ color: asNumber('--vp-seed') })
    mat.toneMapped = false
    const outline = new THREE.Line(geo, mat)
    outline.name = 'seed-outline'
    outline.renderOrder = 2
    return outline
  }

  removeNestInstances(nestId: string) {
    const group = this.nestGroups.get(nestId)
    if (!group) return
    this.workpieceGroup.remove(group)
    group.traverse(c => {
      if (c instanceof THREE.Line) {
        c.geometry.dispose()
        ;(Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose())
      }
    })
    this.nestGroups.delete(nestId)
    this.updateSelectableObjects()
  }

  setNestVisible(nestId: string, visible: boolean) {
    const group = this.nestGroups.get(nestId)
    if (group) group.visible = visible
  }

  /** Position the nest's render group at its world origin (XY). The sheet
   *  outline + every placement child are authored RELATIVE to this group (local
   *  frame), so a single group move rides the whole sheet + all parts + the seed
   *  slot together — used by the D3 "parts pinned to the sheet" move-coupling
   *  (NestRecord.origin). Z is left at 0 (the NEST_Z2D lift lives on the child
   *  meshes, not the group). No-op when the nest is not rendered. */
  setNestGroupPosition(nestId: string, x: number, y: number) {
    const group = this.nestGroups.get(nestId)
    if (group) group.position.set(x, y, group.position.z)
  }

  // Full rebuild after structural layer/loop changes (add/delete/move)
  rebuild2DGeometry(
    id: string,
    loops: Array<{ id: string; points: Array<{ x: number; y: number }>; closed: boolean; layerId: string }>,
    layers: Array<{ id: string; color: string; visible: boolean }>
  ) {
    const group = this.geometry2dGroups.get(id)
    const position = group ? { x: group.position.x, y: group.position.y, z: group.position.z } : { x: 0, y: 0, z: 0 }
    const rotation = group ? {
      x: THREE.MathUtils.radToDeg(group.rotation.x),
      y: THREE.MathUtils.radToDeg(group.rotation.y),
      z: THREE.MathUtils.radToDeg(group.rotation.z),
    } : { x: 0, y: 0, z: 0 }
    this.add2DGeometry(id, loops, layers, position, rotation)
  }

  set2DLayerVisible(geoId: string, layerId: string, visible: boolean) {
    // SVG / DXF geometry — materials map. The user's toggle is recorded as
    // the REQUESTED visibility; while the layer's document is open in sketch
    // mode the effective visibility stays false (live sketch is the truth).
    const mats = this.geometry2dLayerMats.get(geoId)?.get(layerId)
    if (mats) {
      this.layer2dRequestedVisible.set(`${geoId}|${layerId}`, visible)
      const effective = visible && layerId !== this.sketchEditLayerId
      for (const m of mats) m.visible = effective
    }

    // STL projected loops — lines tagged with userData.layerId
    const projGroup = this.projectedLoopGroups.get(geoId)
    if (projGroup) {
      projGroup.traverse(child => {
        if (child instanceof THREE.Line && child.userData.layerId === layerId) {
          ;(child.material as THREE.LineBasicMaterial).visible = visible
        }
      })
    }

    // Projection-plane loops (STL projection layers with a projectionPlane,
    // B-rep derived layers) render through setPartLoopsOnFacePlane into the
    // world-plane / geometry-local groups, NOT projectedLoopGroups — the eye
    // toggle never reached them (B13). Same userData.layerId tagging.
    for (const planeGroup of [this._worldPlaneLoopGroups.get(geoId), this._geoLocalLoopGroups.get(geoId)]) {
      if (!planeGroup) continue
      planeGroup.traverse(child => {
        if (child instanceof THREE.Line && child.userData.layerId === layerId) {
          ;(child.material as THREE.LineBasicMaterial).visible = visible
        }
      })
    }

    // UI-75: hiding or showing a layer changes which lines are visible, so the
    // anchor must re-center on what is left. visible2DWorldCenter reads MATERIAL
    // visibility, which is exactly what the mats loop above writes.
    const selected2d = this.geometry2dGroups.get(geoId)
    if (selected2d) this.sync2DGizmoProxyToGroup(selected2d)
  }

  /**
   * Hide the baked loop rendering of the layer whose sketch document is OPEN
   * (null = none). While editing, the live sketch entities are the truth for
   * that layer; its stale baked loops rendering underneath produced ghost
   * geometry (deleted lines stayed visible until the next Finish). Other
   * layers are untouched (reference geometry). The id is stored so scene
   * rebuilds during an open sketch (undo reload, bake refresh) re-apply it;
   * the layer's REQUESTED visibility survives and is restored on clear.
   */
  setSketchEditingLayer(layerId: string | null) {
    if (this.sketchEditLayerId === layerId) return
    const prev = this.sketchEditLayerId
    this.sketchEditLayerId = layerId
    for (const affected of [prev, layerId]) {
      if (!affected) continue
      for (const [geoId, layerMap] of this.geometry2dLayerMats) {
        const mats = layerMap.get(affected)
        if (!mats) continue
        const requested =
          this.layer2dRequestedVisible.get(`${geoId}|${affected}`) ?? true
        const effective = requested && affected !== this.sketchEditLayerId
        for (const m of mats) m.visible = effective
      }
    }
  }

  // Highlight 2D geometry (all lines → selection color, or restore originals)
  private highlight2D(id: string, on: boolean, selectedColor = asNumber('--vp-select-part')) {
    const group = this.geometry2dGroups.get(id)
    if (!group) return
    group.traverse(c => {
      if (c instanceof THREE.Line) {
        const mat = c.material as THREE.LineBasicMaterial
        if (on) {
          mat.color.setHex(selectedColor)
        } else {
          const orig = mat.userData.origColor as number | undefined
          if (orig !== undefined) mat.color.setHex(orig)
        }
      }
    })
  }

  // V4 (manual-audit): imported 2D loops + brep turn amber on part selection,
  // but 2D PROJECTED geometry (STL/STEP projection layers) did not — those
  // loops live in projectedLoopGroups / _worldPlaneLoopGroups /
  // _geoLocalLoopGroups (keyed by geoId), NOT geometry2dGroups, so highlight2D
  // never reached them. Apply the SAME amber selectedPart treatment here so a
  // selected projected part looks identical to a selected imported 2D part.
  // origColor is set on every projected-loop material (lines ~2456/3415), the
  // same restore key highlight2D and refreshLoopColors use.
  private highlightProjectedLoops(id: string, on: boolean, selectedColor = asNumber('--vp-select-part')) {
    const apply = (c: THREE.Object3D) => {
      if (!(c instanceof THREE.Line)) return
      const mat = c.material as THREE.LineBasicMaterial
      if (on) {
        mat.color.setHex(selectedColor)
      } else {
        const orig = mat.userData.origColor as number | undefined
        if (orig !== undefined) mat.color.setHex(orig)
      }
    }
    this.projectedLoopGroups.get(id)?.traverse(apply)
    this._worldPlaneLoopGroups.get(id)?.traverse(apply)
    this._geoLocalLoopGroups.get(id)?.traverse(apply)
  }

  private findPartId(object: THREE.Object3D): string | null {
    let current: THREE.Object3D | null = object
    while (current) {
      if (this.partGroups.has(current.name)) return current.name
      if (this.geometry2dGroups.has(current.name)) return current.name
      current = current.parent
    }
    return null
  }

  // Mirror of findPartId for stock: walk ancestors for the userData stock tag
  // applied in buildStockBox. Returns the tag (stockId + movable) or null.
  private findStockTag(object: THREE.Object3D): { stockId: string; movable: boolean } | null {
    let current: THREE.Object3D | null = object
    while (current) {
      const ud = current.userData
      if (ud && ud.kind === 'stock' && typeof ud.stockId === 'string') {
        return { stockId: ud.stockId, movable: ud.movable === true }
      }
      current = current.parent
    }
    return null
  }

  // World-space points of a loop LINE, for the interior hit-test (loop picking).
  // Bakes in every parent transform/gizmo so it is correct for geometry-local AND
  // world-frame loop groups identically.
  private worldPointsOfLine(line: THREE.Line): V3[] {
    const posAttr = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!posAttr) return []
    line.updateWorldMatrix(true, false)
    const m = line.matrixWorld
    const v = new THREE.Vector3()
    const out: V3[] = []
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(m)
      out.push({ x: v.x, y: v.y, z: v.z })
    }
    return out
  }

  private updateSelectableObjects() {
    this.selectableObjects = []
    this.partGroups.forEach((group) => {
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) this.selectableObjects.push(child)
        if (child instanceof THREE.Line && child.name) this.selectableObjects.push(child)
      })
    })
    this.geometry2dGroups.forEach((group) => {
      group.traverse((child) => {
        if (child instanceof THREE.Line) this.selectableObjects.push(child)
      })
    })
    // World-plane projected loops live in scene root — include them for loop picking
    this._worldPlaneLoopGroups.forEach((group) => {
      group.traverse((child) => {
        if (child instanceof THREE.Line && child.name) this.selectableObjects.push(child)
      })
    })
    // Geometry-local loop groups parented under a part group are already covered
    // by the partGroups traverse above; include only scene-root fallbacks
    // (part mesh not loaded yet) to avoid duplicates.
    this._geoLocalLoopGroups.forEach((group) => {
      if (group.parent !== this.scene) return
      group.traverse((child) => {
        if (child instanceof THREE.Line && child.name) this.selectableObjects.push(child)
      })
    })
    // Register every rendered stock's fill + wireframe. resolveViewportPick
    // admits movable fixed stocks during ordinary selection, and admits
    // non-movable auto stocks only while an existing selected part makes the
    // click an owning-stock assignment. Geometry still wins on overlap.
    this.fixedStockBoxes.forEach((group) => {
      group.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          this.selectableObjects.push(child)
        }
      })
    })
    // Nest SEED-SLOT loop lines are loop-pickable so a seed op can pick its
    // target loops in the viewport (the owned-seed source is suppressed from the
    // standalone 2D render, ADR 0025 §2). Only the seed-placement loop lines
    // (userData.seedPlacement, carrying a loop-id name + geometryId) — never the
    // seed-outline marker or copy-placement lines. Loop-pick gates on
    // userData.geometryId via resolveLoopPickGeoId so normal picking is unchanged.
    this.nestGroups.forEach((group) => {
      group.traverse((child) => {
        if (
          child instanceof THREE.Line &&
          child.name &&
          child.userData?.seedPlacement === true
        ) {
          this.selectableObjects.push(child)
        }
      })
    })
  }

  // ---- Render loop ----
  // ---- WCS helpers ----

  getStockBounds(stockId?: string): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
    let target: THREE.Object3D | null = null
    if (stockId && this.fixedStockBoxes.has(stockId)) {
      target = this.fixedStockBoxes.get(stockId)!
    }
    const box = target
      ? new THREE.Box3().setFromObject(target)
      : new THREE.Box3().setFromObject(this.stockGroup)
    if (box.isEmpty()) return null
    return {
      min: { x: box.min.x, y: box.min.y, z: box.min.z },
      max: { x: box.max.x, y: box.max.y, z: box.max.z },
    }
  }

  // ---- Vertex / geometry-point pick mode ----
  enterVertexPickMode(cb: (result: {
    pos: { x: number; y: number; z: number }
    geoId?: string
    localPt?: { x: number; y: number; z: number }
  }) => void) {
    this.vertexPickCallback = cb
    this.buildSnapCandidates()
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove)
  }

  exitVertexPickMode() {
    this.vertexPickCallback = null
    this.clearSnapCandidates()
    if (!this.inFaceOverlayMode()) {
      this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove)
    }
  }

  // ---- Snap candidate helpers ----

  private detectCircleCenter(worldPts: THREE.Vector3[], tolerance = 0.05): THREE.Vector3 | null {
    if (worldPts.length < 8) return null
    const centroid = new THREE.Vector3()
    for (const p of worldPts) centroid.add(p)
    centroid.divideScalar(worldPts.length)
    const dists = worldPts.map(p => p.distanceTo(centroid))
    const avgR = dists.reduce((a, b) => a + b, 0) / dists.length
    if (avgR < 0.001) return null
    const maxDev = Math.max(...dists.map(d => Math.abs(d - avgR)))
    return maxDev / avgR < tolerance ? centroid.clone() : null
  }

  private buildSnapCandidates() {
    this.clearSnapCandidates()

    for (const [geoId, group] of this.geometry2dGroups) {
      group.updateMatrixWorld(true)
      const groupInv = group.matrixWorld.clone().invert()

      group.traverse((c) => {
        if (!(c instanceof THREE.Line)) return
        const posAttr = c.geometry.attributes.position
        if (!posAttr || posAttr.count < 2) return

        // Collect world-space points. WO-1426: strip the render-only Z2D
        // anti-z-fighting lift (baked into this Line's LOCAL z by
        // add2DGeometry) before applying matrixWorld, not after — subtracting
        // post-transform would be wrong under any rotation, since the lift
        // direction itself gets rotated. Removing it pre-transform yields the
        // true canonical world point regardless of group orientation.
        const pts: THREE.Vector3[] = []
        for (let i = 0; i < posAttr.count; i++) {
          pts.push(
            new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i) - CNCViewport.Z2D)
              .applyMatrix4(c.matrixWorld)
          )
        }

        // Detect duplicate closing vertex added by add2DGeometry
        const isClosed = pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) < 0.01
        const uniquePts = isClosed ? pts.slice(0, -1) : pts

        // Closed loop with enough points → try circle detection
        if (isClosed && uniquePts.length >= 8) {
          const center = this.detectCircleCenter(uniquePts)
          if (center) {
            const localCenter = center.clone().applyMatrix4(groupInv)
            this.snapCandidates.push({ worldPos: center, localPos: localCenter, geoId, type: 'circle_center' })
            return  // use center only — skip per-vertex candidates
          }
        }

        // Add all unique vertices (deduplicate within 0.1 mm)
        for (const worldV of uniquePts) {
          const dup = this.snapCandidates.some(
            sc => sc.geoId === geoId && sc.worldPos.distanceTo(worldV) < 0.1
          )
          if (!dup) {
            this.snapCandidates.push({
              worldPos: worldV.clone(),
              localPos: worldV.clone().applyMatrix4(groupInv),
              geoId,
              type: 'vertex',
            })
          }
        }
      })
    }

    // Also scan projected loops (children of STL part groups)
    for (const [geoId, group] of this.projectedLoopGroups) {
      group.updateMatrixWorld(true)
      const groupInv = group.matrixWorld.clone().invert()

      group.traverse((c) => {
        if (!(c instanceof THREE.Line)) return
        const posAttr = c.geometry.attributes.position
        if (!posAttr || posAttr.count < 2) return

        // WO-1426: same render-only Z2D lift (here `chainZ + Z2D`, see
        // setPartProjectedLoops) — strip it pre-transform as above.
        const pts: THREE.Vector3[] = []
        for (let i = 0; i < posAttr.count; i++) {
          pts.push(
            new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i) - CNCViewport.Z2D)
              .applyMatrix4(c.matrixWorld)
          )
        }

        const isClosed = pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) < 0.01
        const uniquePts = isClosed ? pts.slice(0, -1) : pts

        if (isClosed && uniquePts.length >= 8) {
          const center = this.detectCircleCenter(uniquePts)
          if (center) {
            const localCenter = center.clone().applyMatrix4(groupInv)
            this.snapCandidates.push({ worldPos: center, localPos: localCenter, geoId, type: 'circle_center' })
            return
          }
        }

        for (const worldV of uniquePts) {
          const dup = this.snapCandidates.some(
            sc => sc.geoId === geoId && sc.worldPos.distanceTo(worldV) < 0.1
          )
          if (!dup) {
            this.snapCandidates.push({
              worldPos: worldV.clone(),
              localPos: worldV.clone().applyMatrix4(groupInv),
              geoId,
              type: 'vertex',
            })
          }
        }
      })
    }

    if (this.snapCandidates.length === 0) return

    // Build Points cloud (yellow = vertex, orange = circle center, red = hover)
    const positions = new Float32Array(this.snapCandidates.length * 3)
    const colors    = new Float32Array(this.snapCandidates.length * 3)
    this.snapCandidates.forEach((sc, i) => {
      positions[i * 3]     = sc.worldPos.x
      positions[i * 3 + 1] = sc.worldPos.y
      positions[i * 3 + 2] = sc.worldPos.z
      if (sc.type === 'circle_center') {
        colors[i * 3] = 1; colors[i * 3 + 1] = 0.5; colors[i * 3 + 2] = 0   // orange
      } else {
        colors[i * 3] = 1; colors[i * 3 + 1] = 1;   colors[i * 3 + 2] = 0   // yellow
      }
    })

    const cloudGeo = new THREE.BufferGeometry()
    cloudGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    cloudGeo.setAttribute('color',    new THREE.BufferAttribute(colors,    3))
    this.snapCloud = new THREE.Points(cloudGeo, new THREE.PointsMaterial({
      size: 10,
      sizeAttenuation: false,
      vertexColors: true,
      depthTest: false,
    }))
    this.snapCloud.renderOrder = 998
    this.scene.add(this.snapCloud)
  }

  private clearSnapCandidates() {
    if (this.snapCloud) {
      this.scene.remove(this.snapCloud)
      this.snapCloud.geometry.dispose()
      ;(this.snapCloud.material as THREE.Material).dispose()
      this.snapCloud = null
    }
    this.snapCandidates = []
    this.snapHoveredIdx = -1
  }

  setWCSOrigin(origin: { x: number; y: number; z: number }, label = 'G54') {
    this.wcsFixed = true
    this.buildWCSIndicator({ origin, label })
  }

  /** WO-366: show or clear labeled point choices that are confirmed by a
   *  workspace click. Used for a cylindrical face's Top/Bottom centers. */
  setZeroPointChoices(
    choices: readonly ZeroPointChoice[] | null,
    onSelect: ((id: string) => void) | null = null,
  ) {
    this.renderer.domElement.removeEventListener('mousemove', this.handleZeroPointChoiceMove)
    if (this.zeroPointChoiceGroup) {
      this.scene.remove(this.zeroPointChoiceGroup)
      this.zeroPointChoiceGroup.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose())
          else object.material.dispose()
        } else if (object instanceof THREE.Sprite) {
          object.material.map?.dispose()
          object.material.dispose()
        }
      })
      this.zeroPointChoiceGroup = null
    }
    this.zeroPointChoiceCallback = null
    this.zeroPointChoiceHoverId = null
    this.renderer.domElement.style.cursor = ''
    if (!choices || choices.length === 0 || !onSelect) return

    const root = new THREE.Group()
    root.name = '__zero_point_choices__'
    for (const choice of choices) {
      const target = new THREE.Group()
      target.name = `__zero_point_choice_${choice.id}__`
      target.userData.zeroPointChoiceId = choice.id
      target.userData.zeroPointChoiceLabel = choice.label
      target.position.set(choice.position.x, choice.position.y, choice.position.z)

      // Raycasting uses only this transparent sphere. The visible pip can be
      // reduced without making Top/Bottom harder to acquire.
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(ZERO_POINT_CHOICE_HIT_RADIUS, 18, 12),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthTest: false,
          depthWrite: false,
          colorWrite: false,
          toneMapped: false,
        }),
      )
      hit.name = '__zero_point_choice_hit__'
      hit.userData.zeroPointChoiceHit = true
      hit.renderOrder = 999
      const outline = new THREE.Mesh(
        new THREE.SphereGeometry(ZERO_POINT_CHOICE_OUTLINE_RADIUS, 18, 12),
        new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false }),
      )
      outline.name = '__zero_point_choice_outline__'
      outline.renderOrder = 1000
      const fill = new THREE.Mesh(
        new THREE.SphereGeometry(ZERO_POINT_CHOICE_FILL_RADIUS, 18, 12),
        new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false }),
      )
      fill.name = '__zero_point_choice_fill__'
      fill.renderOrder = 1001
      target.add(hit, outline, fill)

      const canvas = document.createElement('canvas')
      canvas.width = 192
      canvas.height = 64
      if (canvas.getContext('2d')) {
        const texture = new THREE.CanvasTexture(canvas)
        texture.colorSpace = THREE.SRGBColorSpace
        const label = new THREE.Sprite(new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        }))
        label.name = '__zero_point_choice_label__'
        label.position.set(0, ZERO_POINT_CHOICE_LABEL_POSITION_Y, 0)
        label.scale.set(16, 5.33, 1)
        label.renderOrder = 1002
        target.add(label)
      }
      root.add(target)
    }

    this.scene.add(root)
    this.zeroPointChoiceGroup = root
    this.zeroPointChoiceCallback = onSelect
    this.refreshZeroPointChoiceTheme()
    this.renderer.domElement.addEventListener('mousemove', this.handleZeroPointChoiceMove)
  }

  /** Resolve a semantic UI token while keeping the no-DOM/test fallback on a
   *  theme-aware viewport token. Production resolves the first token. */
  private zeroPointChoiceColor(token: string, fallbackToken: string): string {
    try {
      return asHex(token)
    } catch {
      return asHex(fallbackToken)
    }
  }

  private zeroPointChoiceAppearance(hovered: boolean): ZeroPointChoiceAppearance {
    return {
      fill: this.zeroPointChoiceColor(hovered ? '--accent' : '--accent-strong', '--vp-grid-accent'),
      outline: this.zeroPointChoiceColor(hovered ? '--text-active' : '--focus-ring', '--vp-stock-edge'),
      labelBorder: this.zeroPointChoiceColor(hovered ? '--text-active' : '--focus-ring', '--vp-stock-edge'),
      labelBackground: this.zeroPointChoiceColor('--surface-input', '--vp-canvas'),
      labelText: this.zeroPointChoiceColor('--text-primary', '--role-unknown'),
    }
  }

  private refreshZeroPointChoiceTheme() {
    if (!this.zeroPointChoiceGroup) return
    for (const target of this.zeroPointChoiceGroup.children) {
      const hovered = target.userData.zeroPointChoiceId === this.zeroPointChoiceHoverId
      const appearance = this.zeroPointChoiceAppearance(hovered)
      const outline = target.getObjectByName('__zero_point_choice_outline__') as THREE.Mesh | undefined
      const fill = target.getObjectByName('__zero_point_choice_fill__') as THREE.Mesh | undefined
      if (outline?.material instanceof THREE.MeshBasicMaterial) outline.material.color.set(appearance.outline)
      if (fill?.material instanceof THREE.MeshBasicMaterial) fill.material.color.set(appearance.fill)

      const label = target.getObjectByName('__zero_point_choice_label__') as THREE.Sprite | undefined
      const canvas = label?.material.map?.image
      const context = canvas instanceof HTMLCanvasElement ? canvas.getContext('2d') : null
      if (context && label) {
        context.clearRect(0, 0, 192, 64)
        context.fillStyle = appearance.labelBackground
        context.strokeStyle = appearance.labelBorder
        context.lineWidth = hovered ? 5 : 4
        context.beginPath()
        context.roundRect(3, 3, 186, 58, 10)
        context.fill()
        context.stroke()
        context.fillStyle = appearance.labelText
        context.font = 'bold 28px sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(String(target.userData.zeroPointChoiceLabel ?? ''), 96, 33)
        label.material.map!.needsUpdate = true
      }
      // Exposed as derived evidence for focused construction/theme tests.
      target.userData.zeroPointChoiceAppearance = appearance
      target.userData.zeroPointChoiceHovered = hovered
      target.scale.setScalar(hovered ? ZERO_POINT_CHOICE_HOVER_SCALE : 1)
    }
  }

  private zeroPointChoiceAtCurrentRay(): string | null {
    if (!this.zeroPointChoiceGroup) return null
    const hitTargets: THREE.Object3D[] = []
    for (const target of this.zeroPointChoiceGroup.children) {
      const hit = target.getObjectByName('__zero_point_choice_hit__')
      if (hit) hitTargets.push(hit)
    }
    const hits = this.raycaster.intersectObjects(hitTargets, false)
    for (const hit of hits) {
      let object: THREE.Object3D | null = hit.object
      while (object && object !== this.zeroPointChoiceGroup) {
        const id = object.userData.zeroPointChoiceId
        if (typeof id === 'string') return id
        object = object.parent
      }
    }
    return null
  }

  private handleZeroPointChoiceMove = (event: MouseEvent) => {
    if (!this.zeroPointChoiceGroup) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.mouse, this.camera)
    const hoverId = this.zeroPointChoiceAtCurrentRay()
    if (hoverId === this.zeroPointChoiceHoverId) return
    this.zeroPointChoiceHoverId = hoverId
    this.refreshZeroPointChoiceTheme()
    this.renderer.domElement.style.cursor = hoverId ? 'pointer' : ''
  }

  // WO-337: "show me where the zero will land, before I confirm it" -- a
  // small marker at the exact point a bore/boss zero-point pick would (or
  // does) produce, distinct from the existing face-highlight overlay (that
  // answers "what would I be picking"; this answers "where would zero end
  // up"). WO-318 lesson, applied here on purpose: two concentric,
  // depthTest:false, high-renderOrder spheres (a dark outline behind a gold
  // fill, `--vp-wcs-origin` -- the same token already named for exactly this
  // meaning) so it reads against a light face AND a dark one, and is never
  // hidden behind the body it is sitting on top of.
  private zeroPointPreviewGroup: THREE.Group | null = null
  private static readonly ZERO_PREVIEW_OUTLINE_RADIUS = 4
  private static readonly ZERO_PREVIEW_FILL_RADIUS = 2.6

  setZeroPointPreview(origin: { x: number; y: number; z: number } | null) {
    if (this.zeroPointPreviewGroup) {
      this.scene.remove(this.zeroPointPreviewGroup)
      this.zeroPointPreviewGroup.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          c.geometry.dispose()
          ;(c.material as THREE.Material).dispose()
        }
      })
      this.zeroPointPreviewGroup = null
    }
    if (!origin) return
    const group = new THREE.Group()
    group.name = '__zero_point_preview__'
    const outline = new THREE.Mesh(
      new THREE.SphereGeometry(CNCViewport.ZERO_PREVIEW_OUTLINE_RADIUS, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false, toneMapped: false }),
    )
    outline.renderOrder = 1000
    const fill = new THREE.Mesh(
      new THREE.SphereGeometry(CNCViewport.ZERO_PREVIEW_FILL_RADIUS, 16, 12),
      new THREE.MeshBasicMaterial({ color: asNumber('--vp-wcs-origin'), depthTest: false, toneMapped: false }),
    )
    fill.renderOrder = 1001
    group.add(outline, fill)
    group.position.set(origin.x, origin.y, origin.z)
    this.scene.add(group)
    this.zeroPointPreviewGroup = group
  }

  enterWCSGizmoMode(
    origin: { x: number; y: number; z: number },
    onChange: (p: { x: number; y: number; z: number }) => void
  ) {
    this.exitWCSGizmoMode()
    // Detach gizmo from any selected part so we can reuse TransformControls.
    // Funnelled through setSelectedPart so the 2D proxy is cleared too -- the
    // hand-rolled version left one attached to the scene.
    if (this.selectedPartId) this.setSelectedPart(null)

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(6, 16, 12),
      new THREE.MeshStandardMaterial({ color: asNumber('--vp-wcs-origin'), emissive: asNumber('--vp-wcs-origin'), emissiveIntensity: 0.5, toneMapped: false })
    )
    sphere.position.set(origin.x, origin.y, origin.z)
    sphere.name = '__wcs_gizmo__'
    this.scene.add(sphere)
    this.wcsGizmoSphere = sphere

    this.transformControls.attach(sphere)
    this.transformControls.setMode('translate')

    this.wcsGizmoChangeListener = () => {
      if (!this.wcsGizmoSphere) return
      const p = this.wcsGizmoSphere.position
      const pos = { x: p.x, y: p.y, z: p.z }
      onChange(pos)
      this.buildWCSIndicator({ origin: pos, label: 'WCS' })
    }
    this.transformControls.addEventListener('change', this.wcsGizmoChangeListener)
  }

  exitWCSGizmoMode() {
    if (this.wcsGizmoChangeListener) {
      this.transformControls.removeEventListener('change', this.wcsGizmoChangeListener)
      this.wcsGizmoChangeListener = null
    }
    if (this.wcsGizmoSphere) {
      this.transformControls.detach()
      this.scene.remove(this.wcsGizmoSphere)
      this.wcsGizmoSphere.geometry.dispose()
      ;(this.wcsGizmoSphere.material as THREE.Material).dispose()
      this.wcsGizmoSphere = null
    }
  }

  // ---- Stock position gizmo ----
  enterStockGizmoMode(
    stockId: string,
    position: { x: number; y: number; z: number },
    onChange: (stockId: string, pos: { x: number; y: number; z: number }) => void,
    onFinish: (stockId: string, pos: { x: number; y: number; z: number }) => void
  ) {
    this.exitStockGizmoMode()
    // Deselect any part so TC is free (same funnelling as enterWCSGizmoMode).
    if (this.selectedPartId) this.setSelectedPart(null)

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(5, 14, 10),
      new THREE.MeshStandardMaterial({ color: asNumber('--vp-stock-gizmo'), emissive: asNumber('--vp-stock-gizmo'), emissiveIntensity: 0.6, toneMapped: false })
    )
    sphere.position.set(position.x, position.y, position.z)
    sphere.name = '__stock_gizmo__'
    this.scene.add(sphere)
    this.stockGizmoSphere = sphere
    this.stockGizmoId = stockId
    this.transformControls.attach(sphere)
    this.transformControls.setMode('translate')

    this.stockGizmoChangeListener = () => {
      if (!this.stockGizmoSphere || !this.stockGizmoId) return
      const p = this.stockGizmoSphere.position
      onChange(this.stockGizmoId, { x: p.x, y: p.y, z: p.z })
    }
    this.transformControls.addEventListener('change', this.stockGizmoChangeListener)

    this.stockGizmoFinishListener = (e: { value: unknown }) => {
      if (e.value || !this.stockGizmoSphere || !this.stockGizmoId) return
      const p = this.stockGizmoSphere.position
      onFinish(this.stockGizmoId, { x: p.x, y: p.y, z: p.z })
    }
    this.transformControls.addEventListener('dragging-changed', this.stockGizmoFinishListener)
  }

  /**
   * Reposition the ACTIVE stock gizmo sphere (the attached TransformControls
   * handle follows automatically). Used when the user TYPES a new position in
   * the Properties panel while the gizmo is active: the store already holds the
   * typed value, this keeps the on-screen handle tracking it instead of staying
   * stale at the drop point. No-op if no gizmo is active. Does NOT fire the
   * onChange/onFinish callbacks (no store write, no history push) — purely
   * visual sync of the handle to an already-committed typed edit.
   */
  setStockGizmoPosition(x: number, y: number, z: number) {
    if (!this.stockGizmoSphere) return
    this.stockGizmoSphere.position.set(x, y, z)
    // Force the sphere's world matrix now so the attached TransformControls,
    // which mirrors the object on its own update tick, reads the new position
    // (otherwise the handle lags until the next interaction).
    this.stockGizmoSphere.updateMatrixWorld(true)
  }

  exitStockGizmoMode() {
    if (this.stockGizmoChangeListener) {
      this.transformControls.removeEventListener('change', this.stockGizmoChangeListener)
      this.stockGizmoChangeListener = null
    }
    if (this.stockGizmoFinishListener) {
      this.transformControls.removeEventListener('dragging-changed', this.stockGizmoFinishListener)
      this.stockGizmoFinishListener = null
    }
    if (this.stockGizmoSphere) {
      this.transformControls.detach()
      this.scene.remove(this.stockGizmoSphere)
      this.stockGizmoSphere.geometry.dispose()
      ;(this.stockGizmoSphere.material as THREE.Material).dispose()
      this.stockGizmoSphere = null
    }
    this.stockGizmoId = null
  }

  // ---- STL Projected Loops ----

  setSTLVisible(id: string, visible: boolean) {
    const partGroup = this.partGroups.get(id)
    if (!partGroup) return
    const presentation = this.bodyPresentationForGroup(partGroup)
    if (presentation !== null) {
      setBodyPresentationVisible(presentation, visible)
      this.syncPartSectionCapVisibility(presentation.mesh)
      return
    }
    const mesh = this.bodyMeshForGroup(partGroup)
    if (mesh !== null) {
      mesh.visible = visible
      this.syncPartSectionCapVisibility(mesh)
    }
  }

  // WO-340: a mesh edge chain's real local-frame height rides in its display
  // name ("STL edge chain N (Z <local Z>)", stamped by meshContourLoops in
  // store/index.ts - <local Z> is already relative to the mesh's own bottom,
  // the same reference minZ resolves below). points stay 2D (the genuinely
  // planar DXF/SVG/derived-loop callers never carry this suffix, so they fall
  // through to the pre-existing flat behaviour untouched). A loop the user has
  // renamed away from that convention also falls through - see the WO-340
  // result log for why that fallback, not a data-model change, is in scope.
  private static chainZFromName(name: string | undefined): number | null {
    if (!name) return null
    const match = /\(Z\s*(-?\d+(?:\.\d+)?)\)\s*$/.exec(name)
    return match ? Number(match[1]) : null
  }

  setPartProjectedLoops(
    partId: string,
    loops: Array<{ id: string; name?: string; points: Array<{ x: number; y: number }>; closed: boolean; layerId: string }>,
    layers: Array<{ id: string; color: string; visible: boolean }>
  ) {
    const partGroup = this.partGroups.get(partId)
    if (!partGroup) return

    // Remove existing projected overlay
    const old = this.projectedLoopGroups.get(partId)
    if (old) { partGroup.remove(old); this.projectedLoopGroups.delete(partId) }
    if (!loops.length) return

    // Find the bottom of the STL mesh in local space (skip overlay/slice-plane meshes)
    let minZ = Infinity
    partGroup.traverse(child => {
      if (!(child instanceof THREE.Mesh) || child.name.startsWith('__')) return
      const posArr = child.geometry.attributes.position.array as Float32Array
      for (let i = 2; i < posArr.length; i += 3) {
        if (posArr[i] < minZ) minZ = posArr[i]
      }
    })
    if (!isFinite(minZ)) minZ = 0

    const layerColor   = new Map(layers.map(l => [l.id, l.color]))
    const layerVisible = new Map(layers.map(l => [l.id, l.visible]))
    const projGroup = new THREE.Group()
    projGroup.name = '__proj__'
    projGroup.position.z = minZ   // sit at the bottom face of the model in local space

    for (const loop of loops) {
      const hexStr = layerColor.get(loop.layerId) ?? asHex('--role-cut')
      const color  = parseInt(hexStr.replace('#',''), 16)
      const vis    = layerVisible.get(loop.layerId) ?? true
      const mat    = new THREE.LineBasicMaterial({ color, linewidth: 1, toneMapped: false, visible: vis })
      mat.userData.origColor = color

      // WO-340: draw at the chain's OWN height, not the shared Z2D plane -
      // an un-named/un-suffixed loop (2D geometry) keeps the original flat
      // Z2D height exactly (chainZ ?? 0 === 0 reproduces prior behaviour bit
      // for bit).
      const chainZ = CNCViewport.chainZFromName(loop.name) ?? 0
      const pts = loop.points.map(p => new THREE.Vector3(p.x, p.y, chainZ + CNCViewport.Z2D))
      if (loop.closed && pts.length > 0) pts.push(pts[0].clone())

      const geo  = new THREE.BufferGeometry().setFromPoints(pts)
      const line = new THREE.Line(geo, mat)
      line.name  = loop.id
      line.userData.layerId = loop.layerId   // needed for set2DLayerVisible
      projGroup.add(line)
    }

    partGroup.add(projGroup)
    this.projectedLoopGroups.set(partId, projGroup)
    this.updateSelectableObjects()
  }

  // ── Optimization preview ──────────────────────────────────────────────────────

  showOptimizationPreview(
    partId: string,
    before: Array<{ id: string; points: Array<{ x: number; y: number }>; closed: boolean; segments?: Array<{ to: { x: number; y: number } }> }>,
    after:  Array<{ id: string; points: Array<{ x: number; y: number }>; closed: boolean; segments?: Array<{ to: { x: number; y: number } }> }>,
    frame?: { origin:{x:number;y:number;z:number}; xAxis:{x:number;y:number;z:number}; yAxis:{x:number;y:number;z:number} }
  ) {
    this.hideOptimizationPreview()

    const group = new THREE.Group()
    group.name = '__opt_preview__'

    if (frame) {
      // World-plane projection: (u,v) are world XY — cast a Z-ray onto the target plane
      const O = new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)
      const X = new THREE.Vector3(frame.xAxis.x, frame.xAxis.y, frame.xAxis.z)
      const Y = new THREE.Vector3(frame.yAxis.x, frame.yAxis.y, frame.yAxis.z)
      const N = X.clone().cross(Y)

      const mapTo3D = (u: number, v: number, zBias: number): THREE.Vector3 => {
        if (Math.abs(N.z) > 1e-6) {
          const t = O.z - (N.x*(u - O.x) + N.y*(v - O.y)) / N.z
          return new THREE.Vector3(u, v, t + zBias)
        }
        return O.clone().addScaledVector(X, u).addScaledVector(Y, v)
      }

      // B20: render the loop polyline AND node-point markers. 'before' marks
      // every raw vertex (dense cloud); 'after' marks only the structural nodes
      // (segment endpoints + first point) so the cleanup is visible. zBias is 0
      // for both sets now (only one set shows at a time, so no z-fighting).
      const drawLoops = (loops: typeof before, color: number, mode: 'before' | 'after') => {
        for (const loop of loops) {
          const pts = loop.points.map(p => mapTo3D(p.x, p.y, 0))
          if (loop.closed && pts.length > 0) pts.push(pts[0].clone())
          const geo = new THREE.BufferGeometry().setFromPoints(pts)
          const mat = new THREE.LineBasicMaterial({ color, linewidth: 1, toneMapped: false })
          group.add(new THREE.Line(geo, mat))

          // Node markers: structural nodes for 'after', raw points for 'before'.
          const nodes2d = mode === 'after' ? optNodePoints(loop) : loop.points
          const nodePts = nodes2d.map(p => mapTo3D(p.x, p.y, 0))
          group.add(makeOptNodeMarkers(nodePts, color))
        }
      }

      drawLoops(before, asNumber('--vp-opt-before'), 'before')
      drawLoops(after,  asNumber('--vp-opt-after'), 'after')

      this.scene.add(group)
      this.optimizationPreviewInScene = true
    } else {
      // Local 2D geometry: render in part-local space at Z2D height
      const partGroup = this.partGroups.get(partId)
      if (!partGroup) return

      const projGroup = this.projectedLoopGroups.get(partId)
      const z = projGroup ? projGroup.position.z : 0
      group.position.z = z

      // B20: see frame branch above — line + node markers, no Z offset.
      const drawLoops = (loops: typeof before, color: number, mode: 'before' | 'after') => {
        for (const loop of loops) {
          const pts = loop.points.map(p => new THREE.Vector3(p.x, p.y, CNCViewport.Z2D))
          if (loop.closed && pts.length > 0) pts.push(pts[0].clone())
          const geo = new THREE.BufferGeometry().setFromPoints(pts)
          const mat = new THREE.LineBasicMaterial({ color, linewidth: 1, toneMapped: false })
          group.add(new THREE.Line(geo, mat))

          const nodes2d = mode === 'after' ? optNodePoints(loop) : loop.points
          const nodePts = nodes2d.map(p => new THREE.Vector3(p.x, p.y, CNCViewport.Z2D))
          group.add(makeOptNodeMarkers(nodePts, color))
        }
      }

      drawLoops(before, asNumber('--vp-opt-before'), 'before')
      drawLoops(after,  asNumber('--vp-opt-after'), 'after')

      partGroup.add(group)
      this.optimizationPreviewInScene = false
    }

    this.optimizationPreviewGroup  = group
    this.optimizationPreviewPartId = partId
  }

  hideOptimizationPreview() {
    if (this.optimizationPreviewGroup) {
      if (this.optimizationPreviewInScene) {
        this.scene.remove(this.optimizationPreviewGroup)
      } else if (this.optimizationPreviewPartId) {
        const pg = this.partGroups.get(this.optimizationPreviewPartId)
        if (pg) pg.remove(this.optimizationPreviewGroup)
      }
      // B20: dispose Lines AND the node-marker Points so toggling Before<->After
      // and closing the preview never leaks geometry or leaves stale objects.
      this.optimizationPreviewGroup.traverse(c => {
        if (c instanceof THREE.Line || c instanceof THREE.Points) {
          c.geometry.dispose()
          ;(c.material as THREE.Material).dispose()
        }
      })
    }
    this.optimizationPreviewGroup   = null
    this.optimizationPreviewPartId  = null
    this.optimizationPreviewInScene = false
  }

  // ── Interactive Z-scrub modes (shared slice/section machinery) ──────────────
  //
  // ONE interaction, two backends (UI-ARCHITECTURE §6.8): a horizontal plane
  // with an orange drag handle plus a DOM overlay where the Z can also be
  // TYPED; Enter confirms, Esc cancels. The STL slice mode previews by slicing
  // the cached world-space triangles synchronously every frame; the B-rep
  // section mode previews by asking the model worker for the exact solid
  // cross-section (trailing-edge throttled, stale responses dropped).

  enterSlicePlaneMode(
    partId: string,
    onConfirm: (sliceZ: number) => void,
    onCancel:  () => void,
  ) {
    const entered = this._enterZScrubMode({
      partId,
      title: 'Slice Plane',
      onZChanged: () => this._doUpdateSlicePlanePreview(),
      onConfirm,
      onCancel,
    })
    if (!entered) onCancel()
  }

  /**
   * B-rep Section-at-Z scrub: same handle/overlay/keys UX as the STL slice
   * mode, but the preview loops come from `previewProvider` (an async model
   * worker section derive in MODEL coordinates). The Z shown/typed in the
   * overlay and passed to onConfirm is MODEL Z (worldZ - part position.z);
   * preview loops are drawn parented under the part group so they stay
   * transform-correct for moved / Z-rotated geometry.
   *
   * Returns false (mode not entered) when the part is missing or tilted about
   * X/Y — section loops are Z-plane data (same rule as the ADR 0003 dispatch
   * tilt guard); the CALLER surfaces the loud message.
   */
  enterBrepSectionMode(
    geoId: string,
    initialModelZ: number,
    previewProvider: (modelZ: number) => Promise<Array<{ points: Array<{ x: number; y: number }>; closed: boolean }>>,
    onConfirm: (modelZ: number) => void,
    onCancel:  () => void,
  ): boolean {
    const partGroup = this.partGroups.get(geoId)
    if (!partGroup) return false
    if (Math.abs(partGroup.rotation.x) > 1e-9 || Math.abs(partGroup.rotation.y) > 1e-9) return false

    const zOffset = partGroup.position.z   // Z rotation never changes a point's world Z
    const entered = this._enterZScrubMode({
      partId: geoId,
      // Same title as the STL slice popup so the two flows read identically;
      // rangeNote keeps the model-coords clarification specific to brep.
      title: 'Slice Plane',
      rangeNote: 'model coords',
      zToDisplay: w => w - zOffset,
      displayToZ: d => d + zOffset,
      initialWorldZ: initialModelZ + zOffset,
      onZChanged: () => this._requestBrepSectionPreview(),
      onConfirm: w => onConfirm(parseFloat((w - zOffset).toFixed(3))),
      onCancel,
    })
    if (!entered) return false

    this.brepSectionPartId   = geoId
    this.brepSectionZOffset  = zOffset
    this.brepSectionProvider = previewProvider
    this._updateSlicePlanePreview()   // kick the first async preview
    return true
  }

  /**
   * Build the MODEL-space section frame that makes sectionAtPlane cut a
   * WORLD-HORIZONTAL plane at `worldZ` and flatten the resulting loops directly
   * into WORLD XY. This is how a TILTED part slices exactly like an STL: instead
   * of cutting the model solid with a model-Z plane (which a gizmo tilt would
   * skew), we transform the world-horizontal frame {O:(0,0,worldZ), X:(1,0,0),
   * Y:(0,1,0), N:(0,0,1)} into model space via the part group's inverse matrix.
   *
   * The UV axes are the model images of world +X / +Y. Because the inverse
   * rotation R is orthonormal it preserves dot products, so for any model point
   * P_model that is the image of a world point P_world:
   *   u = (P_model - O_model) . Xmodel == world X of P_world
   *   v = (P_model - O_model) . Ymodel == world Y of P_world
   * i.e. sectionAtPlane returns loops already in WORLD XY -> no post-transform.
   *
   * Assumes unit scale on the part (STEP imports); non-unit scale is out of
   * scope (the re-orthonormalized axes would no longer match the cut geometry).
   * Returns null if the part group is missing.
   */
  worldHorizontalSectionPlane(
    geoId: string,
    worldZ: number,
  ): { origin: [number, number, number]; xAxis: [number, number, number]; yAxis: [number, number, number]; normal: [number, number, number] } | null {
    const partGroup = this.partGroups.get(geoId)
    if (!partGroup) return null
    partGroup.updateMatrixWorld(true)
    const invM = new THREE.Matrix4().copy(partGroup.matrixWorld).invert()
    const rot3 = new THREE.Matrix3().setFromMatrix4(invM)
    const origin = new THREE.Vector3(0, 0, worldZ).applyMatrix4(invM)            // point
    const xAxis  = new THREE.Vector3(1, 0, 0).applyMatrix3(rot3).normalize()     // direction
    const yAxis  = new THREE.Vector3(0, 1, 0).applyMatrix3(rot3).normalize()     // direction
    const normal = xAxis.clone().cross(yAxis).normalize()                        // model image of world +Z
    return {
      origin: [origin.x, origin.y, origin.z],
      xAxis:  [xAxis.x,  xAxis.y,  xAxis.z],
      yAxis:  [yAxis.x,  yAxis.y,  yAxis.z],
      normal: [normal.x, normal.y, normal.z],
    }
  }

  /**
   * B-rep WORLD-horizontal slice scrub. Same handle/overlay/keys UX as the STL
   * slice mode, but the live preview is the exact OCCT section (via
   * `previewProvider`, which returns loops already in WORLD XY). The Z shown /
   * typed / passed to onConfirm is WORLD Z (identity display mapping, like the
   * STL slice). NO tilt guard: any part orientation is allowed because the cut
   * plane is world-horizontal (see worldHorizontalSectionPlane). Returns false
   * (mode not entered) only when the part is missing.
   */
  enterBrepWorldSliceMode(
    geoId: string,
    previewProvider: (worldZ: number) => Promise<Array<{ points: Array<{ x: number; y: number }>; closed: boolean; type: string; area: number }>>,
    onConfirm: (worldZ: number) => void,
    onCancel:  () => void,
  ): boolean {
    const partGroup = this.partGroups.get(geoId)
    if (!partGroup) return false

    const entered = this._enterZScrubMode({
      partId: geoId,
      // Reads identically to the STL slice popup; this is world Z so no rangeNote.
      title: 'Slice Plane',
      // World Z throughout -> identity display mapping.
      onZChanged: () => this._requestBrepWorldSlicePreview(),
      onConfirm,
      onCancel,
    })
    if (!entered) return false

    this.brepWorldSliceProvider = previewProvider
    this._updateSlicePlanePreview()   // kick the first async preview
    return true
  }

  /** Shared plane + drag handle + overlay (typed Z input) + Enter/Esc keys. */
  private _enterZScrubMode(opts: {
    partId: string
    title: string
    rangeNote?: string
    /** world Z -> overlay display Z (default identity; brep mode shows MODEL Z) */
    zToDisplay?: (worldZ: number) => number
    displayToZ?: (displayZ: number) => number
    initialWorldZ?: number
    /** rAF-collapsed preview hook, invoked whenever slicePlaneZ changes */
    onZChanged: () => void
    onConfirm: (worldZ: number) => void
    onCancel:  () => void
  }): boolean {
    this.exitSlicePlaneMode()

    const partGroup = this.partGroups.get(opts.partId)
    if (!partGroup) return false

    // Collect world-space triangle positions so the scrub plane and preview
    // are always relative to the workspace XY plane, not the rotated part.
    const worldPos = this.collectWorldPositions(opts.partId)
    if (!worldPos) return false

    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity
    for (let i = 0; i < worldPos.length; i += 3) {
      if (worldPos[i]   < minX) minX = worldPos[i]
      if (worldPos[i]   > maxX) maxX = worldPos[i]
      if (worldPos[i+1] < minY) minY = worldPos[i+1]
      if (worldPos[i+1] > maxY) maxY = worldPos[i+1]
      if (worldPos[i+2] < minZ) minZ = worldPos[i+2]
      if (worldPos[i+2] > maxZ) maxZ = worldPos[i+2]
    }

    if (!isFinite(minZ)) return false

    const toDisplay   = opts.zToDisplay ?? ((z: number) => z)
    const fromDisplay = opts.displayToZ ?? ((z: number) => z)
    // Unit shim (ADR-0022): the slice plane stays mm/model-coords canonical.
    // toDisplay/fromDisplay above only map world<->model Z. We layer the
    // mm<->inch presentation on top, at this overlay's display+input edge only.
    const units = useCamStore.getState().appSettings.displayUnits
    // model-coord mm (from toDisplay) -> display-unit string (no suffix)
    const fmtZ = (modelZ: number) => fmtDim(modelZ, units)
    const clampZ = (z: number) =>
      Math.max(minZ + 1e-4, Math.min(maxZ - 1e-4, z))

    this.slicePlaneMinZ       = minZ
    this.slicePlaneMaxZ       = maxZ
    this.slicePlaneZ          = clampZ(opts.initialWorldZ ?? minZ + (maxZ - minZ) * 0.5)
    this.slicePlaneWorldPos   = worldPos   // world-space flat array for live preview
    this.slicePreviewCallback = opts.onZChanged

    // Build plane mesh in world space (horizontal, covers XY extent of the part)
    const margin = Math.max(maxX - minX, maxY - minY) * 0.1
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const pw = (maxX - minX) + margin * 2
    const ph = (maxY - minY) + margin * 2

    const planeMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(pw, ph),
      new THREE.MeshBasicMaterial({
        color: asNumber('--vp-slice-plane'), transparent: true, opacity: 0.25,
        side: THREE.DoubleSide, depthWrite: false,
      })
    )
    planeMesh.name = '__slice_plane_mesh__'
    planeMesh.position.set(cx, cy, this.slicePlaneZ)

    // Drag handle: orange sphere centered on the plane
    const handleGeo = new THREE.SphereGeometry(6, 12, 8)
    const handleMat = new THREE.MeshStandardMaterial({
      color: asNumber('--vp-slice-handle'), emissive: asNumber('--vp-slice-handle'), emissiveIntensity: 0.6, depthTest: false,
    })
    const handle = new THREE.Mesh(handleGeo, handleMat)
    handle.name = '__slice_drag_handle__'
    handle.renderOrder = 999
    handle.position.set(cx, cy, this.slicePlaneZ)
    this.sliceDragHandle = handle

    const group = new THREE.Group()
    group.name = '__sliceplane__'
    group.add(planeMesh, handle)
    this.scene.add(group)   // world space — not parented to the part
    this.slicePlaneGroup = group

    this._updateSlicePlanePreview()

    // DOM overlay — the Z is draggable AND typeable ("move or type the value")
    const overlay = document.createElement('div')
    overlay.className = 'slice-plane-overlay'
    overlay.innerHTML = `
      <div class="sp-title">${opts.title}</div>
      <div class="sp-z">Z = <input id="sp-z-input" type="text" inputmode="decimal"
        value="${fmtZ(toDisplay(this.slicePlaneZ))}"> ${unitLabel(units)}</div>
      <div class="sp-range">Range: ${fmtZ(toDisplay(minZ))} – ${fmtZ(toDisplay(maxZ))} ${unitLabel(units)}${opts.rangeNote ? ` (${opts.rangeNote})` : ''}</div>
      <div class="sp-hint">Drag orange handle or type Z &nbsp;·&nbsp; Enter to confirm &nbsp;·&nbsp; Esc to cancel</div>
      <div class="sp-btns">
        <button id="sp-confirm" class="sp-btn-confirm">Confirm</button>
        <button id="sp-cancel"  class="sp-btn-cancel">Cancel</button>
      </div>
    `
    this.container.appendChild(overlay)
    this.slicePlaneOverlay = overlay
    const zInput = overlay.querySelector('#sp-z-input') as HTMLInputElement
    // Shared click-selects-all contract (plain-DOM flavor): first click into
    // the field selects the whole value, second click places the caret. The
    // input is type="text" (not "number") because the selection APIs are a
    // spec no-op on number inputs. Listeners die with the overlay element.
    attachSelectAllOnClick(zInput)

    // Single Z setter shared by drag + typing: clamp, move handle, redraw.
    const applyZ = (worldZ: number, syncInput: boolean) => {
      this.slicePlaneZ = clampZ(worldZ)
      if (this.sliceDragHandle) this.sliceDragHandle.position.z = this.slicePlaneZ
      if (syncInput && document.activeElement !== zInput) {
        zInput.value = fmtZ(toDisplay(this.slicePlaneZ))
      }
      this._updateSlicePlanePreview()
    }

    const confirm = () => {
      const z = this.slicePlaneZ
      this.exitSlicePlaneMode()
      opts.onConfirm(z)
    }
    const cancel = () => {
      this.exitSlicePlaneMode()
      opts.onCancel()
    }

    overlay.querySelector('#sp-confirm')!.addEventListener('click', confirm)
    overlay.querySelector('#sp-cancel')!.addEventListener('click', cancel)

    // Typed Z: live preview on every keystroke; Enter/Esc in the field only
    // commit/leave the field (stopPropagation keeps them from the global
    // handler) — a second Enter outside the field confirms the mode.
    zInput.addEventListener('input', () => {
      // Typed value is in display units -> model-coord mm -> world Z.
      const modelZ = parseDimToMm(zInput.value, units)
      if (Number.isFinite(modelZ)) applyZ(fromDisplay(modelZ), false)
    })
    zInput.addEventListener('change', () => {
      const modelZ = parseDimToMm(zInput.value, units)
      if (Number.isFinite(modelZ)) applyZ(fromDisplay(modelZ), false)
      zInput.value = fmtZ(toDisplay(this.slicePlaneZ))
    })
    zInput.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Enter' || e.key === 'Escape') zInput.blur()
      // Preserve the old number-input arrow stepping (0.5 display units per
      // press) now that the field is type="text"; same live-preview path as
      // typing (clamped by applyZ, input re-synced to the clamped Z).
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const cur = parseDimToMm(zInput.value, units)
        const baseModelZ = Number.isFinite(cur) ? cur : toDisplay(this.slicePlaneZ)
        const stepMm = units === 'inch' ? 0.5 * 25.4 : 0.5
        const nextModelZ = baseModelZ + (e.key === 'ArrowUp' ? stepMm : -stepMm)
        applyZ(fromDisplay(nextModelZ), false)
        zInput.value = fmtZ(toDisplay(this.slicePlaneZ))
      }
    })

    // Drag move/up handlers (drag is armed by handlePointerDown's handle hit)
    this.sliceDragMoveHandler = (e: PointerEvent) => {
      if (!this.sliceDragActive) return
      const deltaY = e.clientY - this.sliceDragLastY
      this.sliceDragLastY = e.clientY
      const range = this.slicePlaneMaxZ - this.slicePlaneMinZ
      const step = -deltaY * range / 500
      applyZ(this.slicePlaneZ + step, true)
    }
    this.sliceDragUpHandler = () => {
      if (this.sliceDragActive) {
        this.sliceDragActive = false
        this.controls.enabled = true
      }
    }
    this.renderer.domElement.addEventListener('pointermove', this.sliceDragMoveHandler)
    this.renderer.domElement.addEventListener('pointerup',   this.sliceDragUpHandler)

    this.slicePlaneKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') confirm()
      else if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', this.slicePlaneKeyHandler)
    return true
  }

  exitSlicePlaneMode() {
    if (this.slicePlaneGroup) {
      this.scene.remove(this.slicePlaneGroup)
      this.slicePlaneGroup.traverse(c => {
        if ((c instanceof THREE.Mesh || c instanceof THREE.Line) && c.geometry) {
          c.geometry.dispose()
          const m = (c as THREE.Mesh).material
          if (Array.isArray(m)) m.forEach(x => x.dispose()); else (m as THREE.Material).dispose()
        }
      })
      this.slicePlaneGroup = null
    }
    this.slicePlaneOverlay?.remove()
    this.slicePlaneOverlay = null
    if (this.slicePlanePreviewRaf !== null) {
      cancelAnimationFrame(this.slicePlanePreviewRaf)
      this.slicePlanePreviewRaf = null
    }
    if (this.sliceDragMoveHandler) {
      this.renderer.domElement.removeEventListener('pointermove', this.sliceDragMoveHandler)
      this.sliceDragMoveHandler = null
    }
    if (this.sliceDragUpHandler) {
      this.renderer.domElement.removeEventListener('pointerup', this.sliceDragUpHandler)
      this.sliceDragUpHandler = null
    }
    if (this.slicePlaneKeyHandler) {
      window.removeEventListener('keydown', this.slicePlaneKeyHandler)
      this.slicePlaneKeyHandler = null
    }
    this.sliceDragHandle  = null
    this.sliceDragActive  = false
    this.controls.enabled = true
    this.slicePlaneWorldPos   = null
    this.slicePreviewCallback = null

    // B-rep section preview teardown: stale-guard any in-flight worker
    // response, cancel the pending throttle tick, dispose the preview lines.
    if (this.brepSectionThrottle !== null) {
      clearTimeout(this.brepSectionThrottle)
      this.brepSectionThrottle = null
    }
    this.brepSectionSeq++
    this.brepSectionProvider = null
    this.brepWorldSliceProvider = null
    if (this.brepSectionPreviewGroup) {
      this.brepSectionPreviewGroup.parent?.remove(this.brepSectionPreviewGroup)
      this.brepSectionPreviewGroup.traverse(c => {
        if (c instanceof THREE.Line) {
          c.geometry.dispose()
          ;(c.material as THREE.Material).dispose()
        }
      })
      this.brepSectionPreviewGroup = null
    }
    this.brepSectionPartId = null
  }

  private _updateSlicePlanePreview() {
    // Throttle: only rebuild once per animation frame even if wheel fires many events
    if (this.slicePlanePreviewRaf !== null) return
    this.slicePlanePreviewRaf = requestAnimationFrame(() => {
      this.slicePlanePreviewRaf = null
      // Common per-frame work: track the translucent plane to the current Z,
      // then hand off to the active mode's preview backend.
      const planeMesh = this.slicePlaneGroup?.getObjectByName('__slice_plane_mesh__') as THREE.Mesh | undefined
      if (planeMesh) planeMesh.position.z = this.slicePlaneZ
      this.slicePreviewCallback?.()
    })
  }

  // Trailing-edge throttle (~80ms) for the async B-rep section preview: while
  // a tick is pending, scrub updates are absorbed; the tick reads slicePlaneZ
  // at FIRE time so the latest position always wins, and a monotonically
  // increasing seq drops any response that is no longer the newest request.
  private _requestBrepSectionPreview() {
    if (this.brepSectionThrottle !== null) return
    this.brepSectionThrottle = window.setTimeout(() => {
      this.brepSectionThrottle = null
      const provider = this.brepSectionProvider
      if (!provider) return
      const modelZ = this.slicePlaneZ - this.brepSectionZOffset
      const seq = ++this.brepSectionSeq
      provider(modelZ)
        .then(loops => {
          if (seq !== this.brepSectionSeq || !this.brepSectionProvider) return // stale
          this._drawBrepSectionPreview(loops, modelZ)
        })
        .catch(() => {
          // Z momentarily outside the solid (or a worker hiccup): clear the
          // preview but keep the mode alive — the next scrub position retries.
          if (seq !== this.brepSectionSeq || !this.brepSectionProvider) return
          this._drawBrepSectionPreview([], modelZ)
        })
    }, 80)
  }

  // World-slice variant of _requestBrepSectionPreview: trailing-edge throttled,
  // stale-dropped (shares brepSectionSeq -- only one scrub mode is ever active).
  // The provider returns loops already in WORLD XY; we draw them world-baked.
  private _requestBrepWorldSlicePreview() {
    if (this.brepSectionThrottle !== null) return
    this.brepSectionThrottle = window.setTimeout(() => {
      this.brepSectionThrottle = null
      const provider = this.brepWorldSliceProvider
      if (!provider) return
      const worldZ = this.slicePlaneZ
      const seq = ++this.brepSectionSeq
      provider(worldZ)
        .then(loops => {
          if (seq !== this.brepSectionSeq || !this.brepWorldSliceProvider) return // stale
          this._drawWorldSlicePreview(loops)
        })
        .catch(() => {
          // Z momentarily outside the solid (or a worker hiccup): clear the
          // preview but keep the mode alive -- the next scrub position retries.
          if (seq !== this.brepSectionSeq || !this.brepWorldSliceProvider) return
          this._drawWorldSlicePreview([])
        })
    }, 80)
  }

  // Draw WORLD-XY loops world-baked into slicePlaneGroup at the current slice Z,
  // mirroring the STL slice preview (_doUpdateSlicePlanePreview) exactly: same
  // group, same line name/material, same float-above-plane offset.
  private _drawWorldSlicePreview(
    loops: Array<{ points: Array<{ x: number; y: number }>; closed: boolean }>,
  ) {
    if (!this.slicePlaneGroup) return

    // Remove old preview lines (same convention as the STL path).
    const old = this.slicePlaneGroup.children.filter(c => c.name === '__sp_preview__')
    old.forEach(c => {
      this.slicePlaneGroup!.remove(c)
      if (c instanceof THREE.Line) {
        c.geometry.dispose()
        ;(c.material as THREE.Material).dispose()
      }
    })

    const z = this.slicePlaneZ + 0.1   // float above plane so it's visible
    for (const loop of loops) {
      if (loop.points.length < 2) continue
      const pts = loop.points.map(p => new THREE.Vector3(p.x, p.y, z))
      if (loop.closed) pts.push(pts[0].clone())
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts)
      const lineMat = new THREE.LineBasicMaterial({ color: asNumber('--vp-slice-preview'), depthTest: false })
      const line    = new THREE.Line(lineGeo, lineMat)
      line.name        = '__sp_preview__'
      line.renderOrder = 999
      this.slicePlaneGroup.add(line)
    }
  }

  // Preview loops are MODEL coords; parenting under the part group keeps them
  // transform-correct for moved / Z-rotated geometry (same geometry_local
  // convention as the derived-layer overlays, a6b913c).
  private _drawBrepSectionPreview(
    loops: Array<{ points: Array<{ x: number; y: number }>; closed: boolean }>,
    modelZ: number,
  ) {
    if (!this.brepSectionPartId) return
    const partGroup = this.partGroups.get(this.brepSectionPartId)
    if (!partGroup) return

    if (this.brepSectionPreviewGroup) {
      this.brepSectionPreviewGroup.parent?.remove(this.brepSectionPreviewGroup)
      this.brepSectionPreviewGroup.traverse(c => {
        if (c instanceof THREE.Line) {
          c.geometry.dispose()
          ;(c.material as THREE.Material).dispose()
        }
      })
      this.brepSectionPreviewGroup = null
    }

    const group = new THREE.Group()
    group.name = '__brep_section_preview__'
    const z = modelZ + 0.1   // float above the section plane so it's visible

    for (const loop of loops) {
      if (loop.points.length < 2) continue
      const pts = loop.points.map(p => new THREE.Vector3(p.x, p.y, z))
      if (loop.closed) pts.push(pts[0].clone())
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts)
      const lineMat = new THREE.LineBasicMaterial({ color: asNumber('--vp-slice-preview'), depthTest: false })
      const line    = new THREE.Line(lineGeo, lineMat)
      line.name        = '__sp_preview__'
      line.renderOrder = 999
      group.add(line)
    }

    partGroup.add(group)
    this.brepSectionPreviewGroup = group
  }

  private _doUpdateSlicePlanePreview() {
    if (!this.slicePlaneGroup || !this.slicePlaneWorldPos) return

    // Remove old preview lines
    const old = this.slicePlaneGroup.children.filter(c => c.name === '__sp_preview__')
    old.forEach(c => {
      this.slicePlaneGroup!.remove(c)
      if (c instanceof THREE.Line) {
        c.geometry.dispose()
        ;(c.material as THREE.Material).dispose()
      }
    })

    // World-space flat array: sliceAtZ(pos, null, Z) works directly
    const segs     = sliceAtZ(this.slicePlaneWorldPos, null, this.slicePlaneZ)
    const rawLoops = buildLoops(segs)
    const z        = this.slicePlaneZ + 0.1   // float above plane so it's visible

    for (const loop of rawLoops) {
      if (loop.length < 2) continue
      const pts = [...loop, loop[0]].map(p => new THREE.Vector3(p.x, p.y, z))
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts)
      const lineMat = new THREE.LineBasicMaterial({ color: asNumber('--vp-slice-preview'), depthTest: false })
      const line    = new THREE.Line(lineGeo, lineMat)
      line.name        = '__sp_preview__'
      line.renderOrder = 999
      this.slicePlaneGroup.add(line)
    }
  }

  projectSTLToLoops(
    partId: string,
    options: ProjectionOptions
  ): { loops: import('../../types').Loop2D[]; layers: import('../../types').Layer2D[] } | null {
    const partGroup = this.partGroups.get(partId)
    if (!partGroup) return null

    let geometry: THREE.BufferGeometry | null = null
    partGroup.traverse(child => {
      if (!geometry && child instanceof THREE.Mesh) geometry = child.geometry
    })
    if (!geometry) return null

    const pos = (geometry as THREE.BufferGeometry).attributes.position.array as Float32Array
    const idxAttr = (geometry as THREE.BufferGeometry).index
    const idx = idxAttr ? (idxAttr.array as Uint32Array | Uint16Array) : null

    return runSTLProjection(pos, idx, options)
  }

  /** WO-346/WO-1200: the theme x color-mode DOM identity is a plain DOM
   *  attribute this class does not otherwise observe. Checked once per frame
   *  from the already-running rAF loop below rather than a MutationObserver
   *  -- cheap (one getAttribute + string compare), and matches this file's
   *  existing "no explicit render call needed, the continuous animation loop
   *  repaints" idiom (see setViewportTheme's own comment) instead of adding a
   *  second listener lifecycle for dispose() to track. */
  private syncThemeIfChanged() {
    if (typeof document === 'undefined' || !document.documentElement) return
    const attr = `${document.documentElement.getAttribute('data-theme') ?? ''}|${document.documentElement.getAttribute('data-color-mode') ?? ''}`
    if (attr === this.lastSeenThemeAttr) return
    this.lastSeenThemeAttr = attr
    this.refreshThemeColors()
  }

  /** Re-paints every scene colour this class owns that is allowed to follow
   *  the theme (WO-346): canvas clear colour, grid lines, stock/workpiece.
   *  buildGrid() and rebuildStock() both resolve their colours via asNumber()
   *  at call time (no more frozen DARK_COLORS snapshot -- see this WO), so
   *  simply re-running them repaints against whatever theme is active now.
   *  rebuildStock() also rebuilds the WCS indicator (axes + origin) when a
   *  stock is present; those tokens resolve to the SAME value under every
   *  theme on purpose (tokens.css keeps them invariant), so re-running that
   *  path is harmless -- it cannot make a rapid look like a cut or move the
   *  axis convention, it just happens to run again. */
  private refreshThemeColors() {
    this.renderer.setClearColor(asNumber('--vp-canvas'))
    this.buildGrid()
    this.rebuildStock()
    this.refreshZeroPointChoiceTheme()
  }

  private startRenderLoop() {
    const animate = () => {
      this.animFrameId = requestAnimationFrame(animate)
      this.syncThemeIfChanged()
      this.controls.update()
      {
        const dpr = this.renderer.getPixelRatio()
        this.sketcher.onFrame(
          this.getWorldPerPixel(),
          (this.container.clientWidth || 1) * dpr,
          (this.container.clientHeight || 1) * dpr,
        )
      }
      // Voxel stock sim (ADR-0028): refresh the per-frame ray direction so the
      // raymarched volume tracks the orbiting ortho camera.
      if (this.voxelSimMaterial) updateVoxelSimUniforms(this.voxelSimMaterial, this.camera)
      // WO UI-74 (Operator N-36): fit near/far to what is actually drawn, LAST --
      // after every other per-frame writer has moved its geometry, and
      // immediately before the draw it applies to. Fitting earlier would fit the
      // PREVIOUS frame's scene and let a surface that moved this frame render
      // clipped for one frame.
      this.applyCameraDepthFit()
      this.renderer.render(this.scene, this.camera)
    }
    animate()
  }

  /** WO INT-13B (spec 3.2 step 5): true while this host is the SUSPENDED
   *  workspace. Guards both methods below into idempotence, and -- critically --
   *  stops resumeRender() from starting a SECOND rAF loop: startRenderLoop's
   *  `animate` re-arms itself every frame, so two live loops would double every
   *  render for the rest of the session and could never be cancelled by the
   *  single `animFrameId` handle. */
  private renderSuspended = false

  /** WO INT-13B (spec 3.2 steps 4-5): quiesce this workspace WITHOUT destroying
   *  it. No dispose, no unmount, no camera or selection change -- D1 retention
   *  means the pose survives by not being disturbed (D3.1), so re-entry is
   *  instant. Idempotent.
   *
   *  PREMISE CORRECTION (verified against source, reported to the Architect):
   *  the WO/spec describe BOTH hosts as render-on-demand and name the controls
   *  'change' listener at :487 as the render trigger to detach. That is NOT true
   *  of this host. CNCViewport renders from an UNCONDITIONAL rAF loop
   *  (startRenderLoop above, started at :564 in the constructor) that re-arms and
   *  calls renderer.render EVERY frame regardless of camera motion; :487's
   *  handleControlsChange only debounce-saves the camera POSE (:2104) and renders
   *  nothing. Detaching :487 alone would therefore have left this host rendering
   *  at full frame rate while suspended -- the exact cost the stage exists to
   *  remove, and a gate spying only on the listener would have passed anyway.
   *  So: the rAF loop is what is actually stopped here; :487 is detached too (the
   *  WO's named mechanism, and correct on its own terms -- a suspended host should
   *  schedule no new pose saves).
   *
   *  Cleanup tail (charter rule 5): an ALREADY-QUEUED cameraChangeTimer is left to
   *  fire on purpose. It is a macrotask holding the last real pose the user
   *  produced while this workspace was live; cancelling it would silently drop a
   *  legitimate save that the pre-INT-13 app would have made. It writes pose
   *  state only -- it cannot render, and dispose() clears it. */
  suspendRender(): void {
    if (this.renderSuspended) return
    this.renderSuspended = true
    cancelAnimationFrame(this.animFrameId)
    this.controls.removeEventListener('change', this.handleControlsChange)
    // WO INT-15 (F-3): DISARM the slice-plane Z-edit's window keydown listener while this host is
    // suspended. It survives a workspace switch on `window` (outside the host's display:none
    // subtree), so a slice-plane edit left open across a switch would answer Enter/Escape from the
    // Model workspace. CLOSE-on-suspend (detach + null), not suspend-and-restore: re-arming on
    // resume would need a SECOND window keydown registration site, which the key-listener census
    // (an INT-13B/C artifact OUTSIDE this WO's manifest) counts as a new, unlisted listener --
    // restoring it would force an out-of-manifest census edit. The slice-plane
    // Z edit is a transient gesture (INT-13C rates F-3 TRIVIAL), so ending it on a workspace switch
    // is acceptable; the operator re-enters it via the project-plane toolbar button on return. The
    // detach is idempotent (removeEventListener is a no-op when absent).
    if (this.slicePlaneKeyHandler) {
      window.removeEventListener('keydown', this.slicePlaneKeyHandler)
      this.slicePlaneKeyHandler = null
    }
    // Spec 3.2 step 4: unsubscribe the shared Sketcher's tool-overlay
    // subscription WITHOUT exiting the session (D3.2 keeps the sketch open).
    // No-op when no session is entered. The rAF stop above already ends this
    // host's per-frame sketcher.onFrame calls.
    this.sketcher.suspend()
  }

  /** WO INT-13B (spec 3.2): the exact inverse of suspendRender, in reverse
   *  order. Idempotent; only ever revives what suspendRender stopped. */
  resumeRender(): void {
    if (!this.renderSuspended) return
    this.renderSuspended = false
    this.sketcher.resume()
    // WO INT-15 (F-3): nothing to re-arm -- suspendRender CLOSES the slice-plane edit (detach +
    // null), so there is no stranded handler to restore here.
    this.controls.addEventListener('change', this.handleControlsChange)
    this.startRenderLoop()
  }

  /** WO INT-13B: test/gate seam for the B2b render-trigger assertion. */
  isRenderSuspended(): boolean {
    return this.renderSuspended
  }

  private handleResize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    const aspect = w / h
    this.camera.left = -this.frustumSize * aspect / 2
    this.camera.right = this.frustumSize * aspect / 2
    this.camera.top = this.frustumSize / 2
    this.camera.bottom = -this.frustumSize / 2
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    // Stock edges use the fat-line addon (LineSegments2 + LineMaterial), whose
    // stroke is sized in SCREEN PIXELS against material.resolution. That must
    // track the renderer drawing-buffer size in DEVICE pixels or the lines
    // render at the wrong width after a window/zoom resize.
    const dpr = this.renderer.getPixelRatio()
    const resX = w * dpr
    const resY = h * dpr
    this.stockGroup.traverse((o) => {
      const mat = (o as Partial<LineSegments2>).material
      if (mat instanceof LineMaterial) mat.resolution.set(resX, resY)
    })
    // GEO-25: same fix, part bodies -- fat-line edge overlays (non-classic
    // themes) live inside workpieceGroup, not stockGroup.
    this.workpieceGroup.traverse((o) => {
      const mat = (o as Partial<LineSegments2>).material
      if (mat instanceof LineMaterial) mat.resolution.set(resX, resY)
    })
    const resolution = { width: resX, height: resY }
    for (const outline of this.getPartInteractionOutlines().values()) {
      syncInteractionResolution(outline, resolution)
    }
    if (this.brepHoverObj != null) syncInteractionResolution(this.brepHoverObj, resolution)
    for (const overlay of this.getBrepHighlights().values()) syncInteractionResolution(overlay, resolution)
    for (const overlay of this.loopHighlightOverlays.values()) {
      const mat = (overlay as Line2).material as LineMaterial | undefined
      mat?.resolution?.set(resX, resY)
    }
  }

  dispose() {
    cancelAnimationFrame(this.animFrameId)
    this.stopObservingRendererDpr()
    window.removeEventListener('keydown', this.handlePartMoveModifierKey)
    window.removeEventListener('keyup', this.handlePartMoveModifierKey)
    window.removeEventListener('blur', this.clearPartMoveModifier)
    this.disposeLoopHighlightOverlays()
    this.exitStockCornerPickMode()
    this.setZeroPointChoices(null)
    this.exitContourTabEditMode(false)
    this.setContourTabMarkers(null)
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown)
    this.renderer.domElement.removeEventListener('click', this.handleClick)
    this.renderer.domElement.removeEventListener('mousemove', this.handleMoveHoverMove)
    this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove)
    this.clearSimulationToolpathObjects()
    this.sketcher.dispose()
    this.clear2DGizmoProxy()
    this.transformControls.dispose()
    this.scene.remove(this.tcRoot())
    // Remove nav interceptors (modifier pointerdown remapper + invert wheel
    // listener + _pan patch) before disposing controls so nothing dangles on
    // the detached canvas.
    this.navController.dispose()
    if (this.cameraChangeTimer) { clearTimeout(this.cameraChangeTimer); this.cameraChangeTimer = null }
    this.cameraChangeHandler = null
    this.controls.removeEventListener('change', this.handleControlsChange)
    this.controls.dispose()
    this.heightPlanesGroup.clear()
    if (this.toolMarkerGroup) {
      this.disposeGroup(this.toolMarkerGroup)
      this.toolMarkerGroup.parent?.remove(this.toolMarkerGroup)
    }
    // Chunk C3: free carved-stock preview groups on teardown.
    this.clearCarvedStock()
    // WO INT-13B (D1.1 / risk R1) -- DISCLOSED EDIT BEYOND THE "ADD ONLY" MANIFEST
    // (see coordination/reports/INT-13B.report.json; two lines, no behavior change
    // for any pre-INT-13 caller).
    //
    // renderer.dispose() does NOT release the WebGL context -- it frees three's
    // GPU resources, but the context lives until the browser GCs the canvas.
    // The class was proven on hardware by the ViewCube cleanup (the B1-gated
    // sibling fix: without it, live contexts climb 6/7/8/9 across a round
    // trip). THIS hunk's own path is different: the matched mutation/control
    // pair (coordination/evidence/INT-13B/mutation-B1-cncviewport-dispose/)
    // proved CNCViewport is constructed ONCE and never disposed on workspace
    // switches, so B1 cannot gate this line. It is kept because it is correct
    // where dispose() IS reached -- page teardown, and any future code that
    // rebuilds a viewport -- where a retained context would count toward the
    // browser cap (that failure presents as the CAM viewport going black, not
    // as an exception).
    //
    // Order matters: forceContextLoss() BEFORE dispose(), or dispose() tears down
    // the WebGLExtensions bookkeeping the release needs and it silently no-ops
    // (measured -- same trap as ViewCube's cleanup).
    this.sectionCaps?.dispose()
    this.sectionCaps = null
    // GEO-23 L1: free the PMREM environment texture (detaches scene.environment).
    this.viewportEnvironment?.dispose()
    this.viewportEnvironment = null
    this.renderer.forceContextLoss?.()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement)
    }
  }

  // _root is the renderable Object3D inside TransformControls (r184+ API change)
  private tcRoot(): THREE.Object3D {
    return (this.transformControls as unknown as { _root: THREE.Object3D })._root
  }
}
