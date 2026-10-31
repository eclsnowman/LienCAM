import { EngraveVcarveFieldHelp } from '../modals/EngraveVcarveFieldHelp'
import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
const txDir = textFor('thread-direction.wo3193')
const txTabs = textFor('holding-tabs.wo3220')
const txRemoval = textFor('tab-removal.wo3221')
const shellText = textFor('app-shell-settings-menus')
import { create } from 'zustand'
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import { Sliders, Info, Move3d, Wrench, CheckCircle2, Ungroup, RefreshCw, AlertTriangle, Copy, Trash2, Eye, EyeOff, PenTool, Settings2, Pencil, X, Box, Combine, MousePointer2, Anchor } from 'lucide-react'
import type { ContourTabApplyOutcome, ContourTabSuggestion, ContourTabSuggestRefusal, ContourTabRemovalMaterial } from '../../store'
import type { ContourTabRemovalRefusal } from '../../lib/cam/contourTabRemoval'
import { readTabRemovalBinding } from '../../lib/cam/contourTabRemoval'
import type { ContourTabRemovalTarget } from '../../lib/cam/types'
import { holdingMethodLabel } from '../../lib/workholding/holdingMethods'
import { machineActionsOf, outdatedReasonText, resolveOpGeometrySources, setupProvenStockId, smartHeightModelTop, smartHeightStockBounds, useCamStore } from '../../store'
import { workholdingStopPark } from '../../lib/machine/macros/clampPauseMacro'
import { useUiPrefs } from '../../store/uiPrefs'
import { useCamShortcutHints } from '../settings/CamShortcutMap'
import { DisclosureSection } from '../ui/DisclosureSection'
import { GeometryColorSwatch } from './GeometryColorSwatch'
import { isMeshBooleanSourceRow, isBooleanResultRow, hasModelBooleanBody } from '../../lib/cam/booleanMeshModel'
import { describeMeshEdit } from '../../mesh/edit'
import { NumericInput, OptionalNumericInput } from '../ui/NumericInput'
import { useSelectAllOnClick } from '../ui/selectAllOnClick'
import { fmtDim, fmtMachineLength, unitLabel, feedLabel, fmtFeed } from '../../lib/ui/unitFormat'
import { lengthFieldValue } from '../../lib/format/lengthDisplay'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { collectOperationFolderTreeIds } from '../../lib/tree/operationFolders'
import type { AdaptiveRoughDiagnostics, AutoStockItem, BrepSelection, FeedrateOverride, FixedStockItem, GeometryFolder, HeightParams, HeightReference, ImportedGeometry, Layer2D, LinkingParams, MachineAction, NestRecord, Operation, OperationFolder, PassParams, SelectedMove, Tool, Units, Vec3 } from '../../types'
import { resolveFloorHopMm } from '../../lib/cam/moves'
import { callableMachineMacros, machineActionLabel } from '../../types'
import {
  CONTOUR_ROUGHING_STYLE_LABELS,
  ENGRAVE_STYLE_LABELS,
  contourPassParamsForMode,
  DEFAULT_CONTOUR_TABS,
  deriveContourMode,
  type ACParams,
  type BoreParams,
  type ChamferHeightReference,
  type ChamferParams,
  type ThreadMillParams,
  type VCarveParams,
  type ContourCuttingStrategy,
  type ContourParams,
  type ContourTabLocations,
  type ContourRoughingStyle,
  type EngraveParams,
  type EngraveStyle,
  type CornerReliefStyle,
  type DrillParams,
  type FaceParams,
  type PocketParams,
} from '../../lib/cam/types'
import { getPocketEntryPolicy, isPocketEntryAllowed, } from '../../lib/cam/pocketEntryPolicy'
import {
  CORNER_RELIEF_STYLES, gentleEngagementLimits, resolveGentleEngagement,
} from '../../lib/cam/cornerRelief2d'
import { resolveTrochoidalGeometry, trochoidalFieldLimits } from '../../lib/cam/trochoidal2d'
import { CLEARANCE_TRIM_OP_TYPES, clearanceAllowanceMmOf } from '../../lib/cam/holderClearanceGate'
import { deriveHeightPlaneOffsetUpdate, deriveHeightRefUpdate, heightRefGovernsTop, isHeightRefOpType, uiReferenceForIntentReference, type HeightRefOpType, type HeightRefParams } from '../../lib/cam/heightReference'
import { RefPlaneSelect } from '../ui/RefPlaneSelect'
import { type Parallel3dParams, DEFAULT_PARALLEL3D_PARAMS, faceScopeForSource, readFaceScope } from '../../cam3d/integration/parallel3dOperation'
import { type WaterlineParams, DEFAULT_WATERLINE_PARAMS } from '../../cam3d/integration/waterline3dOperation'
import { type SteepShallow3dParams, DEFAULT_STEEP_SHALLOW3D_PARAMS } from '../../cam3d/integration/steepShallow3dOperation'
import { type Scallop3dParams, DEFAULT_SCALLOP3D_PARAMS } from '../../cam3d/integration/scallop3dOperation'
import { type Pencil3dParams, DEFAULT_PENCIL3D_PARAMS } from '../../cam3d/integration/pencil3dOperation'
import { type Adaptive3dParams, DEFAULT_ADAPTIVE3D_PARAMS } from '../../cam3d/integration/adaptive3dOperation'
import { resolveTopZ, resolveModelBottomZ, OwningStockError, ReferencePlaneError, ModelOriginComputeError, resolveGeometryZToFrames, resolveGeometryZToFramesModelAwareSafe } from '../../store/dispatchGeo'
import { setupStockConsistency, resolveStockMembershipState, derivedStockMembers } from '../../store/stockAssignment'
import { resolveSetupWorkOffset } from '../../lib/post/workOffsets'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { formatDurationHMS, formatComputeMs, formatElapsedSeconds } from '../../lib/format'
import { estimateNestCutTimeMs } from '../../lib/cam/nesting/nestRuntime'
import { machineCutTimeMotion } from '../../lib/simulation/machineCutTimeMotion'
import {
  isExactChoice,
  mergeNestSettings,
  solverModeFor,
  solverStateFromMode,
  type SolverChoice,
} from '../modals/nestPicker'
import {
  FACE_PASS_ANGLE_BOUNDS, FACE_PASS_EXTENSION_BOUNDS, FACE_STOCK_OFFSET_BOUNDS,
  FACE_STEPOVER_BOUNDS, FACE_STEPDOWN_BOUNDS, FACE_RADIAL_STOCK_BOUNDS, faceToolDiameterCap,
} from '../modals/faceFieldBounds'
import { defaultFeedrateOverride, type FeedSeedMachine } from '../modals/newOperationModalDefaults'
import { useSeatInViseUi } from '../viewport/SeatInViseStrip'
import { MakeViseForm, ViseProperties, viseJawCandidates } from '../workholding/ViseEditor'
import { ClampPlacerPanel, ClampProperties, MakeClampButton, useClampUi } from '../workholding/ClampEditor'
import { clampInstance } from '../../lib/workholding/clamps'
import { viseMembershipOfInstance, workholdingComponentGeometryIds, workholdingOfGeometry } from '../../lib/workholding/vise'
import { SketchToolbox } from './sketch/SketchToolbox'
import { isValidReachShortfall, ReachShortfallNotice } from '../cam/ReachShortfallNotice'
import { RoughingScopeSelector } from './RoughingScopeSelector'
import { SetupHoldingEditor } from './SetupPanel'
import { deriveFaceLoops, getBrepPayload, readStep, setBrepPayload, removeBrepPayload } from '../../lib/cam/geometry/occt/model/modelClient'
import { toolTypeMeta } from '../../lib/tool/toolMeta'
import { spindleSignForTool } from '../../lib/tool/cutHand'
import { resolveThreadMotion, type ThreadAxialDirection } from '../../lib/cam/threadHelix'
import { evenTabFractions } from '../../lib/viewport/tabPlacement'
import { isModelOriginGeometry, resolveOwningModelItemId } from '../../lib/cam/modelOrigin'
import { resolveModelReferenceFrame } from '../../lib/cam/modelReferenceFrame'
import { chamferAngleNote, chamferStretchOf, modeledChamferRecordOf } from '../../lib/cam/chamferFromModel'
import {
  heightIntentAfterNumericEdit,
  operationSafetyHeightIntent,
  operationSafetyUserOverridePlanes,
  refreshSetupOwnedSmartHeightSafety,
  setupDefaultHeightIntent,
  smartHeightSafetyOwnership,
} from '../../lib/cam/heightIntent'
import {
  adaptive3dHeightDraftFromIntent,
  buildAdaptive3dSmartIntent,
  buildContourSmartHeightIntent,
  buildFaceSmartHeightIntent,
  buildParallel3dSmartIntent,
  buildSteepShallow3dSmartIntent,
  buildScallop3dSmartIntent,
  buildPencil3dSmartIntent,
  buildWaterline3dSmartIntent,
  buildPlanarRoughSmartHeightIntent,
  chamferSmartHeightDraftFromIntent,
  contourSmartHeightDraftFromIntent,
  drillBoreSmartHeightDraftFromIntent,
  engraveSmartHeightDraftFromIntent,
  vcarveSmartHeightDraftFromIntent,
  rebuildVCarveSmartHeightIntent,
  faceSmartHeightDraftFromIntent,
  parallel3dHeightDraftFromIntent,
  steepShallow3dHeightDraftFromIntent,
  scallop3dHeightDraftFromIntent,
  pencil3dHeightDraftFromIntent,
  waterline3dHeightDraftFromIntent,
  rebuildChamferSmartHeightFormulaIntent,
  rebuildChamferSmartHeightSafetyIntent,
  rebuildDrillBoreSmartHeightSafetyIntent,
  rebuildEngraveSmartHeightIntent,
  rebuildThreadMillSmartHeightSafetyIntent,
  SMART_HEIGHT_V2_REPAIR_MESSAGE,
  threadMillSmartHeightDraftFromIntent,
  validatePersistedSmartHeightState,
  type Adaptive3dHeightDraft,
  type Adaptive3dMaterialMode,
  type ChamferSmartHeightDraft,
  type ContourSmartHeightDraft,
  type DrillBoreSmartHeightDraft,
  type EngraveSmartHeightDraft,
  type VCarveSmartHeightDraft,
  type FaceSmartHeightDraft,
  type Parallel3dHeightDraft,
  type Waterline3dHeightDraft,
  type ResolvedHeightPlanV2,
  type ThreadMillSmartHeightDraft,
  rebuildPatternSmartHeightIntent,
} from '../../lib/cam/smartHeights'
import {
  DRILL_BREAK_THROUGH_DEFAULT_MM, drillBreakThroughDefault, drillPickedHolesThrough,
} from '../../lib/cam/smartHeights/drillBore'
import { LEGACY_MODEL_ITEM_ID } from '../../doc/documentHolder'
// PP-SELECTION-UTILITY Stage 1: the SAME underlying cache/store primitives
// DesignTree.tsx's handleDuplicateGeo/cleanupGeoResources call (DesignTree.tsx
// itself is a parallel lane tonight — NAV-MENUS — so this file cannot import
// its local closures; these are the shared lib functions those closures wrap,
// re-orchestrated here 1:1 so Duplicate/Delete in the Properties panel do the
// exact same work as the tree's buttons, not a lesser version).
import { assignStableLoopIds } from '../../lib/geometry/loopId'
import { removeCachedSTL, loadCachedSTL, cacheSTL } from '../../lib/stlCache'
import { removeCachedStep, loadCachedStep, cacheStep } from '../../lib/stepCache'
import { remove2DGeometry as removeCache2D, load2DGeometry, cache2DGeometry } from '../../lib/geometry2dCache'
import { removeCachedModelBodyDisplay } from '../../lib/modelBodyDisplayCache'
type ViewportBrepSelection = BrepSelection & { surfaceType?: number }

type VpHandle = {
  setPartTransform?: (id: string, pos: Vec3, rot: Vec3) => void
  setBrepPickMode?: (
    kind: 'face' | 'edge' | null,
    cb?: ((sel: ViewportBrepSelection, nowSelected: boolean) => void) | null,
    allowedGeoId?: string | null,
  ) => void
  setPickedBrepSelections?: (sels: BrepSelection[]) => void
  enterContourTabEditMode?: (callbacks: {
    onAdd: (loopId: string, fraction: number) => void
    onMove: (loopId: string, index: number, fraction: number) => void
    onRemove: (loopId: string, index: number) => void
    onExit: () => void
  }) => void
  exitContourTabEditMode?: (notify?: boolean) => void
  // PP-SELECTION-UTILITY Stage 1: Duplicate/Delete/Show-hide row actions —
  // the same viewport calls DesignTree.tsx's handleDuplicateGeo/removeGeo/
  // toggleGeoVisibility make (VpHandle there, same method names/signatures).
  addSTL?: (buffer: ArrayBuffer, id: string, name: string, pos: Vec3, rot: Vec3, color?: string) => Promise<void>
  addBrepModel?: (id: string, payload: unknown, name: string, pos: Vec3, rot: Vec3, color?: string) => void
  add2DGeometry?: (id: string, loops: ImportedGeometry['loops'], layers: ImportedGeometry['layers2d'], pos: Vec3, rot: Vec3) => void
  removeSTL?: (id: string) => void
  remove2DGeometry?: (id: string) => void
  setSTLVisible?: (id: string, visible: boolean) => void
  set2DLayerVisible?: (geoId: string, layerId: string, visible: boolean) => void
  setSelectedPart?: (id: string | null) => void
  // WO-1573: live-recolor a body when its Workholding toggle flips.
  setPartWorkholding?: (id: string, workholding: boolean, fallbackColor?: string) => void
  // WO-1846/1923: highlight the facets of one recognized feature, by triangle
  // index into the DISPLAYED mesh (use displayedFacetsOf to convert a
  // feature's WO-1845 source-facet ids; an edited part is renumbered).
  setHighlightedFacets?: (geoId: string, displayedFacetIds: number[] | null) => void
}

/** WO-2835: the operations whose travels between cuts use moves/ floorHop. */
const FLOOR_HOP_OPERATION_TYPES: ReadonlySet<Operation['type']> = new Set(['adaptive_clearing_2d', 'pocket_2d', 'contour_2d'])

/** The displayed-mesh triangle indices whose source-facet id is in `sourceIds`. */
export function displayedFacetsOf(
  snapshot: { sourceFacetIds: ArrayLike<number> } | null,
  sourceIds: readonly number[],
): number[] | null {
  if (!snapshot) return null
  const wanted = new Set(sourceIds)
  const facets: number[] = []
  for (let facet = 0; facet < snapshot.sourceFacetIds.length; facet++) {
    if (wanted.has(snapshot.sourceFacetIds[facet])) facets.push(facet)
  }
  return facets
}
const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

function adaptiveRoughDetail(diagnostics: AdaptiveRoughDiagnostics): string {
  const reasons = Object.entries(diagnostics.reasonCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ')
  const issues = diagnostics.issues.map((issue) => {
    const b = issue.bounds
    return `${issue.kind} z=${issue.z.toFixed(3)} level=${issue.levelIndex + 1} ` +
      `component=${issue.componentIndex + 1} bounds=[${b.minX.toFixed(3)}, ${b.minY.toFixed(3)}]..` +
      `[${b.maxX.toFixed(3)}, ${b.maxY.toFixed(3)}] reason=${issue.reason} passes=${issue.passCount}`
  })
  return [
    tx('PropertiesPanel.Adaptive_rough_regions_machined', { p1: diagnostics.machinedRegions, p2: diagnostics.plannedRegions }) +
      tx('PropertiesPanel.Census_skipped_partial', { p1: diagnostics.skippedRegions, p2: diagnostics.partialRegions }),
    reasons ? tx('PropertiesPanel.Census_Reasons', { p1: reasons }) : '',
    ...issues,
  ].filter(Boolean).join('\n')
}

function AdaptiveRoughDiagnosticRows({ diagnostics }: { diagnostics: AdaptiveRoughDiagnostics }) {
  useText('cam-operations-new-operation')
  const detail = adaptiveRoughDetail(diagnostics)
  return (
    <>
      <div className="props-group" data-testid="props-adaptive-rough-diagnostics">
        <div className="props-label">{tx('PropertiesPanel.Adaptive_regions')}</div>
        <div className="props-value" data-tooltip={detail} data-diagnostic-detail={detail}>{tx('PropertiesPanel.machined', { p1: diagnostics.machinedRegions, p2: diagnostics.plannedRegions })}</div>
      </div>
      {(diagnostics.skippedRegions > 0 || diagnostics.partialRegions > 0) && (
        <div className="props-group" data-testid="props-adaptive-rough-warning">
          <div className="props-label">{tx('PropertiesPanel.Skipped_partial')}</div>
          <div
            className="props-value"
            data-tooltip={detail}
            data-diagnostic-detail={detail}
            style={{ color: 'var(--accent-amber)', userSelect: 'text', cursor: 'text' }}
          >{tx('PropertiesPanel.skipped_partial', { p1: diagnostics.skippedRegions, p2: diagnostics.partialRegions })}</div>
        </div>
      )}
    </>
  )
}

// The COMMIT path for a typed transform edit (position/rotation axis input,
// Enter or blur): store action + live viewport group sync — the exact same
// pair the gizmo path ends in (Viewport.handlePartTransformChange syncs the
// store; the gizmo already moved the group). Exported so tests can drive the
// real user path (B11: a typed Z must move the ACTUAL part, not just the
// displayed value).
export function commitTransformAxis(
  geo: ImportedGeometry,
  kind: 'position' | 'rotation',
  axis: keyof Vec3,
  value: number,
): void {
  const pos = kind === 'position' ? { ...geo.position, [axis]: value } : geo.position
  const rot = kind === 'rotation' ? { ...geo.rotation, [axis]: value } : geo.rotation
  useCamStore.getState().updateGeometryTransform(geo.id, pos, rot)
  getVp()?.setPartTransform?.(geo.id, pos, rot)
}

/** WO INT-17C Stage C2: the commit path for a typed Model Item PLACEMENT
 *  edit (position/rotation axis input, Enter or blur) -- the Placement
 *  twin of `commitTransformAxis` above, landing in `updateModelItemPlacement`
 *  instead of `updateGeometryTransform` (the sanctioned action; see that
 *  store action's own doc comment for why). `geo` is the SELECTED CAM
 *  geometry row (how Operator picked this Model Item in the CAM tab), used only
 *  to resolve which item/body owns the edit -- the write itself never
 *  touches `geo` or any other geometry row.
 *
 *  Live-syncs EVERY geometry row belonging to the same Model Item (not just
 *  `geo`) so a multi-body item's siblings move together immediately on a
 *  typed edit, not just on the next full redraw. */
export function commitModelItemPlacementAxis(
  geo: ImportedGeometry,
  kind: 'position' | 'rotation',
  axis: keyof Vec3,
  value: number,
): void {
  const state = useCamStore.getState()
  const modelItemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const bodyId = geo.modelBody?.ref.bodyId
  let current: { position: Vec3; rotation: Vec3 }
  try {
    current = resolveModelReferenceFrame(state.project.modelItemPlacements ?? [], modelItemId, bodyId)
  } catch {
    // No record yet (should not happen in practice -- syncModelBodies seeds
    // one the moment an item's first body appears; a defensive default here
    // is display-only, never persisted as a silent identity substitution).
    current = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }
  }
  const pos = kind === 'position' ? { ...current.position, [axis]: value } : current.position
  const rot = kind === 'rotation' ? { ...current.rotation, [axis]: value } : current.rotation
  state.updateModelItemPlacement(modelItemId, bodyId, pos, rot)
  const vp = getVp()
  for (const sibling of state.project.geometry) {
    if (sibling.format === 'model' && (sibling.modelItemId ?? LEGACY_MODEL_ITEM_ID) === modelItemId) {
      vp?.setPartTransform?.(sibling.id, pos, rot)
    }
  }
}

// ---- PP-SELECTION-UTILITY Stage 1: geometry row actions ----
// The Properties panel's Duplicate/Show-hide/Delete buttons for an imported
// part (rows 5-9 of the recon matrix) call the exact SAME store actions +
// cache/viewport primitives the tree's own buttons call
// (DesignTree.tsx:handleDuplicateGeo/toggleGeoVisibility/removeGeo +
// cleanupGeoResources) — DesignTree.tsx itself is a parallel lane tonight, so
// this is a 1:1 re-orchestration of those primitives rather than a shared
// import, but every mutation is the SAME canonical store action ("one
// canonical action per behavior", docs/CONVENTIONS.md section 7).

/** Whole-part Show/Hide (STL/STEP/model). Mirrors DesignTree's
 *  toggleGeoVisibility exactly: patchGeometry({hidden}) + viewport sync. 2D
 *  formats (dxf/svg/sketch) show/hide per-layer instead — see
 *  toggleAllLayersVisibility below. */
export function toggleGeometryVisibility(geo: ImportedGeometry): void {
  if (geo.format !== 'stl' && geo.format !== 'step' && geo.format !== 'model') return
  const next = !geo.hidden
  useCamStore.getState().patchGeometry(geo.id, { hidden: next })
  getVp()?.setSTLVisible?.(geo.id, !next)
}

/** Single-layer show/hide. Mirrors DesignTree's handleToggleVisible. */
export function toggleLayerVisibility(geo: ImportedGeometry, layer: { id: string; visible?: boolean }): void {
  useCamStore.getState().toggleGeometryLayer(geo.id, layer.id)
  getVp()?.set2DLayerVisible?.(geo.id, layer.id, !layer.visible)
}

/** Part-level show/hide for 2D geometry: flips ALL of a part's layers at
 *  once. Byte-identical logic to DesignTree's handleToggleAllLayers. */
export function toggleAllLayersVisibility(geo: ImportedGeometry): void {
  const layers = geo.layers2d ?? []
  if (!layers.length) return
  const state = useCamStore.getState()
  const target = !layers.every((l) => l.visible)
  for (const l of layers) {
    if (l.visible !== target) {
      state.updateGeometryLayer(geo.id, l.id, { visible: target })
      getVp()?.set2DLayerVisible?.(geo.id, l.id, target)
    }
  }
}

/** Duplicate one imported part. Mirrors DesignTree's handleDuplicateGeo:
 *  remaps layer/loop ids so the copy is fully independent, re-caches the
 *  source bytes under the new id, and pushes the copy into the viewport.
 *  Model-origin rows are excluded by construction (same INT-17A backstop —
 *  a model body is a live mirror of a Model-workbench body, not
 *  independently duplicable from CAM). */
export async function duplicateGeometryRow(geo: ImportedGeometry): Promise<void> {
  if (geo.format === 'model') return
  const state = useCamStore.getState()
  const newId = crypto.randomUUID()
  const offset = { x: geo.position.x + 15, y: geo.position.y, z: geo.position.z }
  const idMap = new Map<string, string>()
  for (const l of geo.layers2d ?? []) idMap.set(l.id, crypto.randomUUID())
  const remap = (lid: string) => idMap.get(lid) ?? lid
  const newGeo: ImportedGeometry = {
    ...geo,
    id: newId,
    name: tx('PropertiesPanel.Census_copy', { p1: geo.name }),
    position: offset,
    layers2d: geo.layers2d?.map((l) => ({ ...l, id: remap(l.id) })),
    loops: geo.loops
      ? assignStableLoopIds(geo.loops.map((l) => ({ ...l, layerId: remap(l.layerId) })), newId)
      : undefined,
    sketches: geo.sketches?.map((sk) => ({ ...sk, layerId: remap(sk.layerId) })),
  }
  state.addGeometry(newGeo)
  const vp = getVp()
  if (geo.format === 'stl') {
    const buf = await loadCachedSTL(geo.id)
    if (buf) {
      await cacheSTL(newId, buf)
      await vp?.addSTL?.(buf, newId, newGeo.name, offset, geo.rotation, geo.color)
    }
  } else if (geo.format === 'step') {
    const buf = await loadCachedStep(geo.id)
    if (buf) {
      await cacheStep(newId, buf)
      try {
        const payload = await readStep(newId, buf, newGeo.filename)
        setBrepPayload(newId, payload)
        vp?.addBrepModel?.(newId, payload, newGeo.name, offset, geo.rotation, geo.color)
      } catch {
        // Same failure surface as the tree's own handler: the duplicate row
        // already exists in the store; only the 3D mesh push failed. A
        // console/brep-import error surface lives on the tree lane — this
        // path stays silent-but-non-crashing to match, not a regression
        // (the tree's own catch does the same: setBrepImportError, a
        // DesignTree-local state setter not reachable from here).
      }
    }
  } else if (geo.format === 'svg' || geo.format === 'dxf') {
    const cached = await load2DGeometry(geo.id)
    const srcLoops = cached?.loops ?? geo.loops ?? []
    const srcLayers = cached?.layers ?? geo.layers2d ?? []
    const loops = assignStableLoopIds(
      srcLoops.map((l) => ({ ...l, layerId: remap(l.layerId) })), newId)
    const layers = srcLayers.map((l) => ({ ...l, id: remap(l.id) }))
    if (loops.length && layers.length) {
      await cache2DGeometry(newId, loops, layers)
      vp?.add2DGeometry?.(newId, newGeo.loops, newGeo.layers2d, offset, geo.rotation)
    }
  }
}

/** The non-store part of removing one geometry row: tear down its viewport
 *  mesh and its IndexedDB/brep-payload caches. Mirrors DesignTree's
 *  cleanupGeoResources exactly. */
function cleanupGeometryRowResources(geo: ImportedGeometry): void {
  const vp = getVp()
  if (geo.format === 'stl') {
    vp?.removeSTL?.(geo.id)
    removeCachedSTL(geo.id).catch(() => {})
  } else if (geo.format === 'step') {
    vp?.removeSTL?.(geo.id)
    removeCachedStep(geo.id).catch(() => {})
    removeBrepPayload(geo.id)
  } else if (geo.format === 'model') {
    // A model body's mesh lives in partGroups (addModelBody), so it tears
    // down through removeSTL exactly like STL/STEP (mirrors DesignTree's
    // cleanupGeoResources). Only reached via removeModelItemRow's own
    // dependents loop below — a single-row Delete refuses model rows.
    vp?.removeSTL?.(geo.id)
    removeCachedModelBodyDisplay(useCamStore.getState().project.id, geo.id).catch(() => {})
  } else {
    vp?.remove2DGeometry?.(geo.id)
    removeCache2D(geo.id).catch(() => {})
  }
}

/** Delete one imported part. Model-origin rows refuse (same INT-17A
 *  backstop as DesignTree's removeGeo — a model body is deleted from the
 *  Model tab, never a bare CAM-row delete). Clears the panel's own
 *  selection when the deleted row was selected, mirroring the tree. */
export function removeGeometryRow(geo: ImportedGeometry): void {
  if (geo.format === 'model') return
  cleanupGeometryRowResources(geo)
  const state = useCamStore.getState()
  state.removeGeometry(geo.id)
  if (state.viewer.selectedGeometryId === geo.id) {
    state.setSelectedGeometry(null)
    getVp()?.setSelectedPart?.(null)
  }
}

/** Delete a whole Model Item (cascade: every CAM geometry row it owns).
 *  Mirrors DesignTree's handleDeleteModelItem exactly: confirm naming every
 *  dependent by name, per-row viewport/cache teardown, then the store's own
 *  single-undo-step removeModelItem cascade. */
export async function removeModelItemRow(modelItemId: string, itemName: string): Promise<void> {
  const state = useCamStore.getState()
  const dependents = state.project.geometry.filter((g) => resolveOwningModelItemId(g) === modelItemId)
  const n = dependents.length
  // WO-1268: themed dialog (mirrors DesignTree.handleDeleteModelItem). The
  // dependents' meshes and cached bytes are torn down before the store
  // snapshots (WO-1283), so Undo restores the records, not the parts.
  const ok = await state.requestConfirm({
    title: tx('PropertiesPanel.Delete_Model_Item', { p1: itemName }),
    body: n > 0
      ? tx('PropertiesPanel.Its_CAM', { p1: n, p2: n === 1 ? tx('PropertiesPanel.Census_part') : tx('PropertiesPanel.Census_parts'), p3: dependents.map((g) => g.name).join(', ') }) +
        tx('PropertiesPanel.go_with_it_Undo_restores_them')
      : tx('PropertiesPanel.It_is_empty'),
    get confirmLabel() { return tx('PropertiesPanel.Delete') },
    get cancelLabel() { return tx('PropertiesPanel.Cancel') },
    tone: 'danger',
  })
  if (!ok) return
  for (const dep of dependents) cleanupGeometryRowResources(dep)
  if (dependents.some((g) => g.id === state.viewer.selectedGeometryId)) {
    state.setSelectedGeometry(null)
    getVp()?.setSelectedPart?.(null)
  }
  state.removeModelItem(modelItemId)
}

// ---- PP-MOVE-PICK: toolpath move properties ----
// Shown when a toolpath segment/move is picked in the viewport (Toolpath view).
// Renders the RESOLVED facts captured at pick time (viewer.selectedMove) and
// resolves the effective feed rate + its SOURCE from the owning operation +
// machine, reusing the SAME two-tier resolver (resolveFeedrates) and by-role
// precedence the simulation frame builder uses (SimulationPanel.buildFrames), so
// this panel and playback never disagree. ADR-0002 height names / ADR-0004 feeds.
const MOVE_ROLE_LABELS: Record<string, string> = {
  get rapid() { return tx('PropertiesPanel.Rapid') }, get cut() { return tx('PropertiesPanel.Cut') }, get helix() { return tx('PropertiesPanel.Helix') }, get ramp() { return tx('PropertiesPanel.Ramp') }, get plunge() { return tx('PropertiesPanel.Plunge') },
  get stepover() { return tx('PropertiesPanel.Stepover') }, get fast_traverse() { return tx('PropertiesPanel.Fast_traverse') }, get lead_in() { return tx('PropertiesPanel.Lead_in') },
  get lead_out() { return tx('PropertiesPanel.Lead_out') }, get loop_back() { return tx('PropertiesPanel.Loop_back') }, get wall_follow() { return tx('PropertiesPanel.Wall_follow') },
  get finish() { return tx('PropertiesPanel.Finish') },
}

/** Resolve the effective feed rate for a picked move AND name its source (baked
 *  feed / by-role rate / rapid), mirroring SimulationPanel.buildFrames' precedence
 *  exactly. Returns null when a non-rapid cut carries no resolvable feed (bad
 *  data) — the panel then refuses BY NAME rather than inventing a number. */
export function resolveMoveFeed(
  move: SelectedMove,
  op: Operation | undefined,
  tool: Tool | undefined,
  rapidRate: number,
): { rate: number; source: string } | null {
  const rapid = Number.isFinite(rapidRate) && rapidRate > 0 ? rapidRate : 0
  if (move.moveType === 'rapid' || move.role === 'rapid') {
    return rapid > 0 ? { rate: rapid, get source() { return tx('PropertiesPanel.Rapid_machine_traverse') } } : null
  }
  const resolved = tool ? resolveFeedrates(tool, op?.feedrateOverride, rapid || undefined) : null
  if (move.role === 'fast_traverse') {
    const r = resolved?.fastTraverseRate ?? rapid
    return r > 0 ? { rate: r, get source() { return tx('PropertiesPanel.By_role_fast_traverse') } } : null
  }
  if (move.role === 'finish') {
    const r = resolved?.finishRate ?? rapid
    return r > 0 ? { rate: r, get source() { return tx('PropertiesPanel.By_role_finish') } } : null
  }
  if (move.feed != null && move.feed > 0) {
    return { rate: move.feed, get source() { return tx('PropertiesPanel.Baked_feed') } }
  }
  return null
}

function MoveProperties({ move }: { move: SelectedMove }) {
  useText('cam-operations-new-operation')
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const setups = useCamStore((s) => s.project.setups)
  const toolLibrary = useCamStore((s) => s.toolLibrary)
  const rapidRate = useCamStore((s) => s.project.machine.rapidRate)
  const setActiveOperation = useCamStore((s) => s.setActiveOperation)

  const op = useMemo(
    () => setups.flatMap((st) => st.operations).find((o) => o.id === move.operationId),
    [setups, move.operationId],
  )
  const tool = toolLibrary.find((t) => t.id === op?.toolId)
  const feed = resolveMoveFeed(move, op, tool, rapidRate)
  const roleLabel = MOVE_ROLE_LABELS[move.role] ?? move.role
  const arcSuffix = move.moveType === 'arc_cw' ? tx('PropertiesPanel.arc_CW') : move.moveType === 'arc_ccw' ? tx('PropertiesPanel.arc_CCW') : ''
  const durationMs = feed && feed.rate > 0 ? (move.lengthMm / feed.rate) * 60000 : null
  const fmtPt = (p: Vec3) =>
    `${fmtDim(p.x, displayUnits)}, ${fmtDim(p.y, displayUnits)}, ${fmtDim(p.z, displayUnits)}`

  return (
    <div className="props-section" data-testid="move-properties">
      <div className="props-group-header props-op-title" data-ui78-sanctioned="">{tx('PropertiesPanel.Move_of', { p1: move.moveIndex + 1, p2: move.moveCount })}</div>
      <CollapsibleGroup groupId="move-summary" title={tx('PropertiesPanel.Move')}>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Type')}</div>
          <div className="props-value" data-testid="move-role">{roleLabel}{arcSuffix}</div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Start')}</div>
          <div className="props-value" data-testid="move-start">{fmtPt(move.from)} {unitLabel(displayUnits)}</div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.End')}</div>
          <div className="props-value" data-testid="move-end">{fmtPt(move.to)} {unitLabel(displayUnits)}</div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Length')}</div>
          <div className="props-value" data-testid="move-length">{fmtDim(move.lengthMm, displayUnits)} {unitLabel(displayUnits)}</div>
        </div>
        <div className="props-group">
          <div
            className="props-label"
            data-tooltip={tx('PropertiesPanel.The_rate_this_move_runs_at_and_where_it')}
          >{tx('PropertiesPanel.Feed_rate')}</div>
          {feed ? (
            <div className="props-value" data-testid="move-feed">
              {fmtFeed(feed.rate, displayUnits)} {feedLabel(displayUnits)}{' '}
              <span style={{ opacity: 0.7 }}>{tx('PropertiesPanel.symbol')}{feed.source}{tx('PropertiesPanel.symbol_2')}</span>
            </div>
          ) : (
            <div className="props-value props-value-error" data-testid="move-feed" data-tooltip={tx('PropertiesPanel.This_move_carries_no_resolvable_feed_ADR_0003_refused')}>{tx('PropertiesPanel.Unresolved')}</div>
          )}
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Est_duration')}</div>
          <div className="props-value" data-testid="move-duration">
            {durationMs != null ? formatDurationHMS(durationMs) : '--'}
          </div>
        </div>
      </CollapsibleGroup>
      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.Operation')}</div>
        <div className="props-value" data-tooltip={op?.name}>{op?.name ?? tx('PropertiesPanel.Unknown_operation')}</div>
      </div>
      <div className="props-group props-btn-row" data-testid="move-action-row">
        <button
          type="button"
          className="props-btn"
          data-testid="move-goto-op-btn"
          disabled={!op}
          data-tooltip={tx('PropertiesPanel.Select_the_operation_this_move_belongs_to_clears_the')}
          onClick={() => { if (op) setActiveOperation(op.id) }}
        >
          <Settings2 size={13} />{tx('PropertiesPanel.Go_to_operation')}</button>
      </div>
    </div>
  )
}

// WO-2992: the project row at the top of the design tree. It is not a store
// selection kind (src/store is out of this order's reach); the click records the
// selection it happened over, and the notes show only while that selection is
// unchanged, so every other row click still wins (ADR 0025).
type ProjectRowViewState = Pick<ReturnType<typeof useCamStore.getState>, 'viewer' | 'project'>
function selectionSignature(s: ProjectRowViewState, clampId: string | null): string {
  const v = s.viewer
  return [
    s.project.id, v.mode, v.selectedGeometryId, v.selectedNestId, v.selectedStockId,
    v.selectedLayerId, v.selectedLayerGeoId, v.selectedFolderId, v.selectedFolderKind,
    v.selectedFolderSetupId, v.selectedMove ? 'move' : '', v.brepSelections.length,
    s.project.activeSetupId, s.project.activeOperationId, clampId,
  ].join('|')
}
const useProjectRowSelection = create<{ signature: string | null }>(() => ({ signature: null }))
export function selectProjectRow(): void {
  useProjectRowSelection.setState({
    signature: selectionSignature(useCamStore.getState(), useClampUi.getState().selectedClampId),
  })
}

export function clearProjectRow(): void {
  if (useProjectRowSelection.getState().signature !== null) useProjectRowSelection.setState({ signature: null })
}

export function ProjectNotesProperties() {
  useText('app-shell-settings-menus')
  const name = useCamStore((s) => s.project.name)
  const notes = useCamStore((s) => s.project.notes ?? '')
  const updateProjectMeta = useCamStore((s) => s.updateProjectMeta)
  return (
    <>
      <div className="props-group">
        <div className="props-label">{shellText('ProjectNotes.project')}</div>
        <div className="props-value" data-testid="project-notes-name">{name}</div>
      </div>
      <div className="props-group" style={{ alignItems: 'flex-start' }}>
        <div className="props-label">{shellText('ProjectNotes.notes')}</div>
        <div className="props-value">
          <textarea
            className="props-text-input"
            data-testid="project-notes"
            aria-label={shellText('ProjectNotes.notes')}
            placeholder={shellText('ProjectNotes.placeholder')}
            rows={8}
            value={notes}
            onChange={(e) => updateProjectMeta({ notes: e.currentTarget.value })}
          />
        </div>
      </div>
    </>
  )
}

export function PropertiesPanel() {
  useText('cam-operations-new-operation')
  // UI-PERF-PAIR: keep SelectionKey-stable until a field the panel cascade
  // actually reads changes. Subscribing to the whole `project` / `viewer`
  // objects re-rendered the panel on every toolpath/status tick (and on every
  // op-row click's companion store writes), even when the resolved cascade
  // target was unchanged. Narrow slices + explicit deps below preserve the
  // same rendered cascade while cutting idle re-renders off the select path.
  const viewerMode = useCamStore((s) => s.viewer.mode)
  const selectedGeometryId = useCamStore((s) => s.viewer.selectedGeometryId)
  const selectedNestId = useCamStore((s) => s.viewer.selectedNestId)
  const selectedStockId = useCamStore((s) => s.viewer.selectedStockId)
  const selectedLayerId = useCamStore((s) => s.viewer.selectedLayerId)
  const selectedLayerGeoId = useCamStore((s) => s.viewer.selectedLayerGeoId)
  const selectedFolderId = useCamStore((s) => s.viewer.selectedFolderId)
  const selectedFolderKind = useCamStore((s) => s.viewer.selectedFolderKind)
  const selectedFolderSetupId = useCamStore((s) => s.viewer.selectedFolderSetupId)
  const selectedMove = useCamStore((s) => s.viewer.selectedMove)
  const brepSelections = useCamStore((s) => s.viewer.brepSelections)
  const activeSetupId = useCamStore((s) => s.project.activeSetupId)
  const activeOperationId = useCamStore((s) => s.project.activeOperationId)
  const geometry = useCamStore((s) => s.project.geometry)
  const setups = useCamStore((s) => s.project.setups)
  const nests = useCamStore((s) => s.project.nests)
  const sceneStock = useCamStore((s) => s.project.sceneStock)
  const geometryFolders = useCamStore((s) => s.project.geometryFolders)
  const modelItems = useCamStore((s) => s.project.modelItems)
  // WO-2192: a placed clamp selected in the viewport or the tree.
  const selectedClampId = useClampUi((s) => s.selectedClampId)
  const workholding = useCamStore((s) => s.project.workholding)
  const selectedClamp = clampInstance(workholding, selectedClampId)
  // WO-2992: project-row notes show while the selection is still the one the row was clicked over.
  const projectRowSignature = useProjectRowSelection((s) => s.signature)
  const liveSignature = useCamStore((s) => selectionSignature(s, selectedClampId))
  const projectRowSelected = projectRowSignature !== null && projectRowSignature === liveSignature
  // Once the selection moves on, forget the click so returning to the old selection does not bring the notes back.
  useEffect(() => {
    if (projectRowSignature !== null && projectRowSignature !== liveSignature) clearProjectRow()
  }, [projectRowSignature, liveSignature])
  // WO-2198: a vise placed again from one definition is selected the same way.
  const selectedVise = selectedClamp ? null : viseMembershipOfInstance(workholding, selectedClampId)

  const selectedGeo = geometry.find((g) => g.id === selectedGeometryId)
  const activeSetup = setups.find((s) => s.id === activeSetupId)
  const activeOp = activeSetup?.operations.find((o) => o.id === activeOperationId)
  // WO-2437: a machine action selected in the operation list.
  const activeAction = activeSetup && !activeOp
    ? machineActionsOf(activeSetup).find((action) => action.id === activeOperationId)
    : undefined
  // A selected nest takes top priority in the returned cascade. setSelectedNest
  // clears geometry/op selection (mutually exclusive — ADR 0025), so a simple
  // high-priority branch is correct. Resolved here alongside the other consts
  // (NOT after any return) so no hook ordering can shift.
  const selectedNest = nests?.find((n) => n.id === selectedNestId)
  // A selected stock is mutually exclusive with geometry/nest/op (tri-exclusion,
  // ADR 0025): setSelectedStock clears all three. Resolve both kinds here (fixed
  // = editable W/H/D/position; auto = derived, read-only) with the other consts,
  // BEFORE any return, so no hook ordering can shift (render-gate rule).
  const selectedFixedStock = (sceneStock.fixedStocks ?? []).find(
    (fs) => fs.id === selectedStockId,
  )
  const selectedAutoStock = (sceneStock.autoStocks ?? []).find(
    (as) => as.id === selectedStockId,
  )
  // PP-UTILITY Stage 3: a selected tree LAYER row (mutually exclusive with
  // geometry/nest/stock/folder — setSelectedLayer clears the other four).
  // selectedLayerGeoId disambiguates which part owns the layer (layer ids can
  // collide across parts). Resolved here alongside the other consts, BEFORE
  // any return, so no hook ordering can shift (render-gate rule).
  const selectedLayerGeo = geometry.find((g) => g.id === selectedLayerGeoId)
  const selectedLayer = selectedLayerId != null
    ? selectedLayerGeo?.layers2d?.find((l) => l.id === selectedLayerId)
    : undefined
  // PP-UTILITY Stage 3: a selected tree FOLDER row — geometry folder OR
  // per-setup operation folder (selectedFolderKind disambiguates).
  const selectedFolderSetup = selectedFolderKind === 'operation'
    ? setups.find((s) => s.id === selectedFolderSetupId)
    : undefined
  const selectedGeometryFolder = selectedFolderKind === 'geometry'
    ? (geometryFolders ?? []).find((f) => f.id === selectedFolderId)
    : undefined
  const selectedOperationFolder = selectedFolderKind === 'operation'
    ? selectedFolderSetup?.operationFolders?.find((f) => f.id === selectedFolderId)
    : undefined
  const selectedGeometryFolderCount = selectedGeometryFolder
    ? geometry.filter((g) => g.folderId === selectedGeometryFolder.id).length +
      (modelItems ?? []).filter((item) =>
        item.folderId === selectedGeometryFolder.id &&
        !geometry.some((g) => resolveOwningModelItemId(g) === item.id)).length
    : 0
  const selectedOperationFolderCount = selectedOperationFolder && selectedFolderSetup
    ? (() => {
        const ids = collectOperationFolderTreeIds(
          selectedFolderSetup.operationFolders ?? [], selectedOperationFolder.id,
        )
        return selectedFolderSetup.operations.filter(
          (op) => op.folderId != null && ids.has(op.folderId),
        ).length
      })()
    : 0

  // Sketch mode takes top priority over the normal properties cascade
  if (viewerMode === 'sketch') {
    return <SketchToolbox />
  }

  return (
    <div className="panel properties-panel">
      <div className="panel-header">
        <span className="panel-title">
          <Sliders size={13} />{tx('PropertiesPanel.Properties')}</span>
      </div>

      <div className="panel-body">
        {/* WO-2192: placing clamps - the placer's controls sit above whatever is selected. */}
        <ClampPlacerPanel />
        {/* PP-MOVE-PICK: a picked toolpath move (Toolpath view) takes top
            priority — it is mutually exclusive with every tree selection (the
            store clears them) and does not coexist with B-rep picks (a different
            view). Rendered first so it dominates the cascade. */}
        {selectedMove ? (
          <MoveProperties move={selectedMove} />
        ) : projectRowSelected ? (
          <ProjectNotesProperties />
        ) : (
        <>
        {/* B-rep face/edge picks (Stage 2) — shown on top of the normal cascade */}
        {brepSelections.length > 0 && (
          <BrepSelectionInfo selections={brepSelections} geometry={geometry} />
        )}
        {/* A selected nest node takes top priority (mutually exclusive with
            geometry/op selection — ADR 0025): show its read-only settings. */}
        {selectedClamp ? (
          <ClampProperties instanceId={selectedClamp.instance.id} />
        ) : selectedVise ? (
          <ViseProperties membership={selectedVise} />
        ) : selectedFixedStock ? (
          <FixedStockProperties stock={selectedFixedStock} nests={nests ?? []} />
        ) : selectedAutoStock ? (
          <AutoStockProperties stock={selectedAutoStock} geometry={geometry} />
        ) : selectedNest ? (
          <NestProperties nest={selectedNest} geometry={geometry} />
        ) : selectedLayer && selectedLayerGeo ? (
          <LayerProperties geo={selectedLayerGeo} layer={selectedLayer} />
        ) : selectedGeometryFolder ? (
          <FolderProperties
            kind="geometry"
            folder={selectedGeometryFolder}
            memberCount={selectedGeometryFolderCount}
            setupId={null}
          />
        ) : selectedOperationFolder ? (
          <FolderProperties
            kind="operation"
            folder={selectedOperationFolder}
            memberCount={selectedOperationFolderCount}
            setupId={selectedFolderSetup?.id ?? null}
          />
        ) : selectedGeo && isModelOriginGeometry(selectedGeo) ? (
          // WO INT-17C Stage C2: a Model Item's outer PLACEMENT (position/
          // rotation), never its own geo row fields -- GeometryProperties'
          // TransformInput fields would commit through updateGeometryTransform,
          // which refuses model-origin rows by construction (C1 step 3b).
          <ModelItemPlacementProperties geo={selectedGeo} />
        ) : selectedGeo ? (
          <GeometryProperties geo={selectedGeo} />
        ) : activeOp ? (
          <OperationProperties op={activeOp} />
        ) : activeAction && activeSetup ? (
          <MachineActionProperties setupId={activeSetup.id} action={activeAction} />
        ) : activeSetup ? (
          <SetupProperties setup={activeSetup} />
        ) : (
          <div className="panel-empty">
            <Info size={22} />
            <p>{tx('PropertiesPanel.Select_a_geometry_setup_or_operation_to_view_its')}</p>
          </div>
        )}
        </>
        )}
      </div>
    </div>
  )
}

// WO-2437: a MACHINE ACTION selected in the operation list (an operator stop,
// ...): its name and its own fields, edited here as an operation's are.
function MachineActionProperties({ setupId, action }: { setupId: string; action: MachineAction }) {
  const updateMachineAction = useCamStore((s) => s.updateMachineAction)
  const removeMachineAction = useCamStore((s) => s.removeMachineAction)
  const machine = useCamStore((s) => s.project.machine)
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const textField = (
    label: string,
    testId: string,
    value: string,
    commit: (next: string) => void,
    allowEmpty: boolean,
  ) => (
    <div className="props-group">
      <div className="props-label">{label}</div>
      <div className="props-value">
        <input
          key={`${action.id}:${value}`}
          className="props-text-input"
          data-testid={testId}
          defaultValue={value}
          aria-label={label}
          onBlur={(e) => {
            const next = e.currentTarget.value.trim()
            if (next === value || (!allowEmpty && next.length === 0)) { e.currentTarget.value = value; return }
            commit(next)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              e.currentTarget.value = value
              e.currentTarget.blur()
            }
          }}
        />
      </div>
    </div>
  )
  const park = action.kind === 'operator_stop' ? workholdingStopPark(machine, undefined) : null
  const callableMacros = callableMachineMacros(machine)
  const parkLength = (mm: number) => `${fmtMachineLength(mm, displayUnits)} ${unitLabel(displayUnits)}`
  const parkAxes: Array<[string, number]> = park && Number.isFinite(park.x) && Number.isFinite(park.y)
    ? [['X', park.x], ['Y', park.y], ...(typeof park.z === 'number' && Number.isFinite(park.z) ? [['Z', park.z] as [string, number]] : [])]
    : []
  return (
    <div className="props-section" data-testid="machine-action-properties">
      <div className="props-group-header props-op-title" data-tooltip={action.name} data-ui78-sanctioned="">
        {action.name || machineActionLabel(action.kind)}
      </div>
      <div className="props-group">
        <div className="props-label">Type</div>
        <div className="props-value" data-testid="machine-action-type">{machineActionLabel(action.kind)}</div>
      </div>
      {textField('Name', 'machine-action-name-input', action.name,
        (name) => updateMachineAction(setupId, action.id, { name }), false)}
      {action.kind === 'run_macro' && (
        <>
        <div className="props-group">
          <label className="props-label" htmlFor="run-macro-select">Macro</label>
          <div className="props-value" style={{ flex: 1 }}>
          <select
            id="run-macro-select"
            className="props-text-input"
            data-testid="run-macro-select"
            value={action.macroId}
            onChange={(event) => updateMachineAction(setupId, action.id, { macroId: event.target.value })}
          >
            <option value="">Choose a macro</option>
            {action.macroId && !callableMacros.some((macro) => macro.id === action.macroId) && (
              <option value={action.macroId}>Selected macro is unavailable</option>
            )}
            {callableMacros.map((macro) => <option key={macro.id} value={macro.id}>{macro.name} (M{macro.mCode})</option>)}
          </select>
          </div>
        </div>
        <p className="mform-help" style={{ margin: '4px 12px 8px' }}>Only shown macros with program-callable M-codes are listed. M6 also changes tools.</p>
        </>
      )}
      {action.kind === 'operator_stop' && (
        <>
          {textField('Message', 'operator-stop-message-input', action.message,
            (message) => updateMachineAction(setupId, action.id, { message }), true)}
          <div className="props-group">
            <div className="props-label">Park</div>
            <div
              className="props-value"
              data-testid="operator-stop-park"
              data-tooltip="Where every operator stop parks: Operator stop park in All Settings (machine coordinates)"
            >
              {parkAxes.length > 0 ? park!.label : 'No park position on this machine - stops at safe height'}
            </div>
          </div>
          {parkAxes.map(([axis, mm]) => (
            <div className="props-group" key={axis}>
              <div className="props-label">Park {axis}</div>
              <div className="props-value" data-testid={`operator-stop-park-${axis.toLowerCase()}`}>
                {parkLength(mm)} (machine)
              </div>
            </div>
          ))}
        </>
      )}
      <div className="props-group props-btn-row">
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="machine-action-delete-btn"
          onClick={() => removeMachineAction(setupId, action.id)}
          data-tooltip="Delete operation"
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  )
}

function CollapsibleGroup({ groupId, title, icon, children }: {
  groupId: string
  title: React.ReactNode
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  useText('cam-operations-new-operation')
  const collapsed = useUiPrefs((s) => !!s.collapsedPropsGroups[groupId])
  const toggle = useUiPrefs((s) => s.togglePropsGroup)
  const anchorRef = useRef<{ header: HTMLElement; scroller: HTMLElement; top: number } | null>(null)
  const testId = `props-group-${groupId}`
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const delta = anchor.header.getBoundingClientRect().top - anchor.top
    if (Number.isFinite(delta) && delta !== 0) anchor.scroller.scrollTop += delta
    anchorRef.current = null
  }, [collapsed])
  const handleToggle = () => {
    const header = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    const scroller = header?.closest<HTMLElement>('.panel-body')
    if (header && scroller) anchorRef.current = { header, scroller, top: header.getBoundingClientRect().top }
    toggle(groupId)
  }
  return (
    <DisclosureSection
      className="props-disclosure"
      icon={icon} title={title}
      open={!collapsed}
      onToggle={handleToggle}
      dataGroup={groupId} testId={testId}
    >
      {children}
    </DisclosureSection>
  )
}

// ---- B-rep selection info (Stage 2 picking, ADR 0018 D3) ----
// GeomAbs_SurfaceType enum order (see BrepModelPayload.faceTypes).
const surfaceTypeNames = () => [
  tx('PropertiesPanel.Plane'), tx('PropertiesPanel.Cylinder'), tx('PropertiesPanel.Cone'), tx('PropertiesPanel.Sphere'), tx('PropertiesPanel.Torus'),
  tx('PropertiesPanel.Bezier'), 'BSpline', tx('PropertiesPanel.Revolution'), tx('PropertiesPanel.Extrusion'), tx('PropertiesPanel.Offset'), tx('PropertiesPanel.Other'),
]

// ---- PP-SELECTION-UTILITY Stage 2: quantitative B-rep pick info ----
// The kernel already ships a full triangulated mesh + edge polylines in
// BrepModelPayload (faceRanges/positions/indices for faces, edgeRanges/
// positions for edges) -- no NEW kernel query is needed, only a pure
// client-side reduction over data the panel already fetches via
// getBrepPayload. Units are mm (BrepModelPayload.bbox is documented "world
// mm"; mesh.positions share that frame).
function triangleAreaMm2(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const ux = bx - ax, uy = by - ay, uz = bz - az
  const vx = cx - ax, vy = cy - ay, vz = cz - az
  const crossX = uy * vz - uz * vy
  const crossY = uz * vx - ux * vz
  const crossZ = ux * vy - uy * vx
  return 0.5 * Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ)
}

/** Sum of triangle areas within a face's index range. Exported for tests. */
export function computeBrepFaceArea(
  payload: { mesh: { positions: Float32Array; indices: Uint32Array; faceRanges: Uint32Array } },
  faceIndex: number,
): number | undefined {
  const { faceRanges, positions, indices } = payload.mesh
  const off = faceRanges[2 * faceIndex]
  const count = faceRanges[2 * faceIndex + 1]
  if (off === undefined || count === undefined) return undefined
  let area = 0
  for (let i = off; i + 2 < off + count; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3
    area += triangleAreaMm2(
      positions[i0], positions[i0 + 1], positions[i0 + 2],
      positions[i1], positions[i1 + 1], positions[i1 + 2],
      positions[i2], positions[i2 + 1], positions[i2 + 2],
    )
  }
  return area
}

/** A planar face's averaged, normalized vertex normal (undefined for non-planar
 *  types, where a single normal would be misleading). Exported for tests. */
export function computeBrepFaceNormal(
  payload: { mesh: { normals: Float32Array; faceRanges: Uint32Array; indices: Uint32Array } },
  faceIndex: number,
): { x: number; y: number; z: number } | undefined {
  const { faceRanges, indices, normals } = payload.mesh
  const off = faceRanges[2 * faceIndex]
  const count = faceRanges[2 * faceIndex + 1]
  if (off === undefined || !count) return undefined
  let sx = 0, sy = 0, sz = 0
  const seen = new Set<number>()
  for (let i = off; i < off + count; i++) {
    const vi = indices[i]
    if (seen.has(vi)) continue
    seen.add(vi)
    sx += normals[vi * 3]; sy += normals[vi * 3 + 1]; sz += normals[vi * 3 + 2]
  }
  const len = Math.sqrt(sx * sx + sy * sy + sz * sz)
  if (len < 1e-9) return undefined
  return { x: sx / len, y: sy / len, z: sz / len }
}

/** Sum of polyline segment lengths within an edge's point range. Exported for tests. */
export function computeBrepEdgeLength(
  payload: { edges: { positions: Float32Array; edgeRanges: Uint32Array } },
  edgeIndex: number,
): number | undefined {
  const { edgeRanges, positions } = payload.edges
  const off = edgeRanges[2 * edgeIndex]
  const count = edgeRanges[2 * edgeIndex + 1]
  if (off === undefined || count === undefined || count < 2) return count === 1 ? 0 : undefined
  let length = 0
  for (let i = off; i < off + count - 1; i++) {
    const p0 = i * 3, p1 = (i + 1) * 3
    length += Math.hypot(
      positions[p1] - positions[p0],
      positions[p1 + 1] - positions[p0 + 1],
      positions[p1 + 2] - positions[p0 + 2],
    )
  }
  return length
}

function BrepSelectionInfo({
  selections,
  geometry,
}: {
  selections: BrepSelection[]
  geometry: ImportedGeometry[]
}) {
  useText('cam-operations-new-operation')
  // Clear (per-pick / all): the SAME store action + viewport sync pair the
  // reference-plane pick flow below already uses (setBrepSelections +
  // getVp()?.setPickedBrepSelections?.(...)) -- clearing a bad pick previously
  // had no PP affordance at all (recon Matrix 1 row 16).
  const clearOne = (sel: BrepSelection) => {
    const next = useCamStore.getState().viewer.brepSelections.filter(
      (b) => !(b.geoId === sel.geoId && b.kind === sel.kind && b.index === sel.index),
    )
    useCamStore.getState().setBrepSelections(next)
    getVp()?.setPickedBrepSelections?.(next)
  }
  const clearAll = () => {
    useCamStore.getState().setBrepSelections([])
    getVp()?.setPickedBrepSelections?.([])
  }

  return (
    <div className="props-section">
      <div className="props-group-header" data-testid="brep-selection-header">{tx('PropertiesPanel.B_rep_selection', { p1: selections.length })}</div>
      {selections.map((sel) => {
        const geoName = geometry.find((g) => g.id === sel.geoId)?.name ?? sel.geoId
        const payload = getBrepPayload(sel.geoId)
        let label: string
        let quantitative: string | null = null
        if (sel.kind === 'face') {
          const faceTypes = payload?.faceTypes
          const typeIdx = faceTypes?.[sel.index] ?? 10
          const typeName = surfaceTypeNames()[typeIdx] ?? tx('PropertiesPanel.Other')
          label = tx('PropertiesPanel.Face', { p1: sel.index, p2: typeName })
          const area = payload ? computeBrepFaceArea(payload, sel.index) : undefined
          const parts: string[] = []
          if (area !== undefined) parts.push(tx('PropertiesPanel.Census_area_mm_2', { p1: area.toFixed(2) }))
          if (typeIdx === 0 && payload) {
            const n = computeBrepFaceNormal(payload, sel.index)
            if (n) parts.push(tx('PropertiesPanel.Census_normal', { p1: n.x.toFixed(3), p2: n.y.toFixed(3), p3: n.z.toFixed(3) }))
          }
          if (parts.length) quantitative = parts.join(', ')
        } else {
          label = tx('PropertiesPanel.Edge', { p1: sel.index })
          const length = payload ? computeBrepEdgeLength(payload, sel.index) : undefined
          if (length !== undefined) quantitative = tx('PropertiesPanel.Census_length_mm', { p1: length.toFixed(2) })
        }
        return (
          <div className="props-group" key={`${sel.geoId}|${sel.kind}|${sel.index}`}>
            <div className="props-label" data-tooltip={geoName}>{geoName}</div>
            <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span data-tooltip={quantitative ?? undefined} data-testid="brep-selection-label">
                {label}{quantitative ? ` — ${quantitative}` : ''}
              </span>
              <button
                type="button"
                className="props-icon-btn"
                data-testid={`brep-selection-clear-${sel.geoId}-${sel.kind}-${sel.index}`}
                onClick={() => clearOne(sel)}
                data-tooltip={tx('PropertiesPanel.Clear_this_pick')}
                aria-label={tx('PropertiesPanel.Clear_this_pick')}
              >
                <X size={11} />
              </button>
            </div>
          </div>
        )
      })}
      {selections.length > 1 && (
        <div className="props-group props-btn-row" data-testid="brep-selection-action-row">
          <button
            type="button"
            className="props-btn"
            data-testid="brep-selection-clear-all-btn"
            onClick={clearAll}
            data-tooltip={tx('PropertiesPanel.Clear_all_picks')}
          >
            <X size={12} />{tx('PropertiesPanel.Clear_all')}</button>
        </div>
      )}
    </div>
  )
}

// ---- Fixed-stock properties (editable quick-action fields) ----
// Shown when a FIXED stock is selected (tree stock icon or viewport click set
// viewer.selectedStockId). Mirrors the editable W/H/D + position fields the tree's
// FixedStockNode renders; both surfaces write the SAME store action
// (updateFixedStock), which handles history + nest move-coupling ("many paths to
// same result"). The label/row/NumericInput styling matches the rest of the panel
// (props-group / props-label / props-value). All hooks sit before any return so
// the cascade can never shift the hooks order (render-gate rule).
function FixedStockProperties({ stock, nests }: { stock: FixedStockItem; nests: NestRecord[] }) {
  useText('cam-operations-new-operation')
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const updateFixedStock = useCamStore((s) => s.updateFixedStock)
  const removeFixedStock = useCamStore((s) => s.removeFixedStock)
  // A nest-bound stock's W/H are nest-driven (regenerate on re-pack); depth +
  // position persist. Fields stay editable for consistency with the tree, but a
  // hint flags the nest-driven dimensions. PP-SELECTION-UTILITY Stage 2 item:
  // name the bound nest (recon Matrix 1 row 1 — the generic hint text never
  // said WHICH nest owns this stock).
  const boundNest = nests.find((n) => n.boundStockId === stock.id)

  const row = (
    label: string, value: number, onChange: (v: number) => void, min: number,
  ) => (
    <div className="props-group">
      <div className="props-label">{label}</div>
      <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <NumericInput
          className="props-number-input"
          value={value}
          min={min}
          step={1}
          units={displayUnits}
          kind="dim"
          tooltip={tx('PropertiesPanel.Label_units', { p1: label, p2: unitLabel(displayUnits) })}
          onChange={(v) => { if (v >= min) onChange(v) }}
        />
        <span>{unitLabel(displayUnits)}</span>
      </div>
    </div>
  )

  return (
    <div className="props-section">
      {/* CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) --
          sticky panel chrome, PANEL-INTERNAL (docked in this panel). */}
      <div className="props-group-header props-op-title" data-tooltip={stock.name} data-ui78-sanctioned="">
        {stock.name}
      </div>

      {/* Rename/Remove reuse the SAME updateFixedStock/removeFixedStock the
          tree's TreeRenameLabel commit + Trash2 button call
          (DesignTree.tsx:handleUpdateFixedStock/handleRemoveFixedStock). A
          selected fixed stock previously had zero action buttons in this
          panel (recon Matrix 1 row 1 top gap). */}
      <div className="props-group props-btn-row" data-testid="stock-fixed-action-row">
        <button
          type="button"
          className="props-btn"
          data-testid="stock-fixed-rename-btn"
          onClick={() => {
            const next = window.prompt(tx('PropertiesPanel.Rename_stock'), stock.name)
            if (next && next.trim() && next.trim() !== stock.name) updateFixedStock(stock.id, { name: next.trim() })
          }}
          data-tooltip={tx('PropertiesPanel.Rename_stock')}
        >
          <Pencil size={12} />{tx('PropertiesPanel.Rename')}</button>
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="stock-fixed-remove-btn"
          onClick={() => removeFixedStock(stock.id)}
          data-tooltip={tx('PropertiesPanel.Remove_stock_block')}
        >
          <Trash2 size={12} />{tx('PropertiesPanel.Remove')}</button>
      </div>

      <CollapsibleGroup groupId="stock-size" title={tx('PropertiesPanel.Size')}>
        {row(tx('PropertiesPanel.Width_X'), stock.width, (v) => updateFixedStock(stock.id, { width: v }), 1)}
        {row(tx('PropertiesPanel.Height_Y'), stock.height, (v) => updateFixedStock(stock.id, { height: v }), 1)}
        {boundNest && (
          <div className="props-group props-nest-hint" style={{ alignItems: 'flex-start' }} data-testid="stock-fixed-nest-binding">
            {/* UI-BRAND: .props-value truncates to one ellipsized line by
                default (found + fixed live in the Stage 1 pass for the Size
                row) — this hint names a nest whose name can be long, so it
                must wrap rather than silently bury the name. */}
            <div className="props-value" style={{ opacity: 0.7, whiteSpace: 'normal', textAlign: 'left' }} data-tooltip={boundNest.name}>{tx('PropertiesPanel.Width_Height_are_nest_driven_by_and_regenerate_on', { p1: boundNest.name })}</div>
          </div>
        )}
        {row(tx('PropertiesPanel.Depth_Z'), stock.depth, (v) => updateFixedStock(stock.id, { depth: v }), 1)}
      </CollapsibleGroup>

      <CollapsibleGroup groupId="stock-position" title={tx('PropertiesPanel.Position', { p1: unitLabel(displayUnits) })}>
        {row(tx('PropertiesPanel.Pos_X'), stock.position.x, (v) => updateFixedStock(stock.id, { position: { ...stock.position, x: v } }), -9999)}
        {row(tx('PropertiesPanel.Pos_Y'), stock.position.y, (v) => updateFixedStock(stock.id, { position: { ...stock.position, y: v } }), -9999)}
        {row(tx('PropertiesPanel.Pos_Z'), stock.position.z, (v) => updateFixedStock(stock.id, { position: { ...stock.position, z: v } }), -9999)}
      </CollapsibleGroup>
    </div>
  )
}

// ---- Auto-stock properties ----
// An AUTO stock has no authoritative W/H/D/position — its box is DERIVED from the
// member geometry assigned to it, so Size stays a read-only summary. The two
// offsets it IS sized by, though, are a real editable value (updateAutoStock,
// the SAME action the tree's expanded-node fields commit through) — PP-
// SELECTION-UTILITY Stage 2 fix: recon Matrix 1 row 2 flagged the PP as
// STRICTLY BEHIND the tree here (tree editable, PP read-only-only).
function AutoStockProperties({ stock, geometry }: { stock: AutoStockItem; geometry: ImportedGeometry[] }) {
  useText('cam-operations-new-operation')
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const updateAutoStock = useCamStore((s) => s.updateAutoStock)
  const removeAutoStock = useCamStore((s) => s.removeAutoStock)
  const stocks = useCamStore((s) => s.project.stocks)
  // AUTOSTOCK-MODEL-FAIL: count members via the SAME shared resolver the rendered
  // box uses (derivedStockMembers), so an unassigned model part folded into the
  // catch-all auto stock shows up here too - the panel and the drawn box agree.
  // Falls back to the strict stockId filter when this auto stock has no derived
  // twin in project.stocks yet (never regressing to a WRONG count).
  const twin = (stocks ?? []).find((s) => s.id === stock.id && s.mode === 'derived')
  const members = twin
    ? derivedStockMembers(twin, geometry, stocks ?? [])
    : geometry.filter((g) => g.stockId === stock.id)

  const row = (
    label: string, value: number, onChange: (v: number) => void, min: number, testId: string,
  ) => (
    <div className="props-group">
      <div className="props-label">{label}</div>
      <div className="props-value" data-testid={testId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <NumericInput
          className="props-number-input"
          value={value}
          min={min}
          step={1}
          units={displayUnits}
          kind="dim"
          tooltip={tx('PropertiesPanel.Label_units', { p1: label, p2: unitLabel(displayUnits) })}
          onChange={(v) => { if (v >= min) onChange(v) }}
        />
        <span>{unitLabel(displayUnits)}</span>
      </div>
    </div>
  )

  return (
    <div className="props-section">
      {/* CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) --
          sticky panel chrome, PANEL-INTERNAL (docked in this panel). */}
      <div className="props-group-header props-op-title" data-tooltip={stock.name} data-ui78-sanctioned="">
        {stock.name}
      </div>

      {/* Rename/Remove reuse the SAME updateAutoStock/removeAutoStock the
          tree's TreeRenameLabel commit + Trash2 button call
          (DesignTree.tsx:handleUpdateAutoStock/handleRemoveAutoStock). */}
      <div className="props-group props-btn-row" data-testid="stock-auto-action-row">
        <button
          type="button"
          className="props-btn"
          data-testid="stock-auto-rename-btn"
          onClick={() => {
            const next = window.prompt(tx('PropertiesPanel.Rename_stock'), stock.name)
            if (next && next.trim() && next.trim() !== stock.name) updateAutoStock(stock.id, { name: next.trim() })
          }}
          data-tooltip={tx('PropertiesPanel.Rename_stock')}
        >
          <Pencil size={12} />{tx('PropertiesPanel.Rename')}</button>
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="stock-auto-remove-btn"
          onClick={() => removeAutoStock(stock.id)}
          data-tooltip={tx('PropertiesPanel.Remove_auto_stock')}
        >
          <Trash2 size={12} />{tx('PropertiesPanel.Remove')}</button>
      </div>

      <CollapsibleGroup groupId="auto-stock-summary" title={tx('PropertiesPanel.Auto_stock')}>
        {row(tx('PropertiesPanel.Offset_XY'), stock.autoOffsetXY, (v) => updateAutoStock(stock.id, { autoOffsetXY: v }), 0, 'stock-auto-offset-xy')}
        {row(tx('PropertiesPanel.Offset_Z_top'), stock.autoOffsetZTop, (v) => updateAutoStock(stock.id, { autoOffsetZTop: v }), 0, 'stock-auto-offset-z')}
        {row(tx('PropertiesPanel.Offset_Z_bottom'), stock.autoOffsetZBottom ?? 0, (v) => updateAutoStock(stock.id, { autoOffsetZBottom: v }), 0, 'stock-auto-offset-z-bottom')}
      </CollapsibleGroup>

      {/* Member part list (info): recon Matrix 1 row 2 — the tree already
          shows this on expand; PP showed nothing. Assignment itself happens
          via the per-part Stock select on GeometryProperties, not here. */}
      <CollapsibleGroup groupId="auto-stock-members" title={tx('PropertiesPanel.Member_parts', { p1: members.length })}>
        {members.map((geo) => (
          <div className="props-group" key={geo.id} data-testid={`stock-auto-member-${geo.id}`}>
            <div className="props-value" data-tooltip={geo.name}>{geo.name}</div>
          </div>
        ))}
      </CollapsibleGroup>
    </div>
  )
}

// ---- Nest properties (summary + first-class pack inputs) ----
// The modal remains the complete editor, while the pack inputs used most during
// iteration are editable here. Both surfaces share the same stored NestRecord.
function NestProperties({ nest, geometry }: { nest: NestRecord; geometry: ImportedGeometry[] }) {
  useText('cam-operations-new-operation')
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const explodeNest = useCamStore((s) => s.explodeNest)
  const recomputeNest = useCamStore((s) => s.recomputeNest)
  // PP-SELECTION-UTILITY Stage 2: Edit/Hide-show/Delete reuse the SAME
  // setNestEditTarget+openModal / setNestVisible / removeNest the tree row's
  // Pencil/Eye/Trash2 icon buttons call (DesignTree.tsx:2588-2629). Recon
  // Matrix 1 row 15 + NAV-EDIT-BUTTON-SWEEP flagged all three tree-only.
  const setNestEditTarget = useCamStore((s) => s.setNestEditTarget)
  const openModal = useCamStore((s) => s.openModal)
  const setNestVisible = useCamStore((s) => s.setNestVisible)
  const removeNest = useCamStore((s) => s.removeNest)
  const visible = nest.visible ?? true
  // N1d Item 5 ("many paths to same result"): first-class editable thickness.
  const setNestThickness = useCamStore((s) => s.setNestThickness)
  const defaultThickness = useCamStore((s) => s.appSettings.defaultStockThicknessMm)
  // P7 (ADR 0024 Amd 1): first-class editable multi-copy cut ordering.
  const setNestMachiningOrder = useCamStore((s) => s.setNestMachiningOrder)
  const machiningOrder = nest.machiningOrder ?? 'by-operation'
  // Owned-seed model: a seed edit marks the pack stale (needsRecompute). No
  // auto-repack — surface a Recompute button the user clicks.
  const stale = nest.needsRecompute === true
  const computing = nest.status === 'computing'
  // Live "Computing... Ns" readout (the timer Operator lost when packing from the
  // workspace — the modal has its own). Tick only while computing; clear on
  // cleanup / when computing ends (no leak). Hook lives with the other consts
  // BEFORE any return, so the hooks order never shifts (render-gate rule).
  const [elapsedMs, setElapsedMs] = useState(0)
  const startedAt = nest.computeStartedAt
  useEffect(() => {
    if (!computing || startedAt === undefined) { setElapsedMs(0); return }
    const tick = () => setElapsedMs(Date.now() - startedAt)
    tick()
    const handle = window.setInterval(tick, 300)
    return () => window.clearInterval(handle)
  }, [computing, startedAt])
  // P6 Item 3b — honest nest-level cut-time estimate. Select the setups slice
  // (stable ref unless ops change) and flatten to the Operation[] the pure
  // helper needs; memoize so a new array isn't built every render. This hook
  // sits with the others BEFORE any return so the hooks order never shifts
  // (render-gate rule).
  const setups = useCamStore((s) => s.project.setups)
  const allOps = useMemo<Operation[]>(
    () => setups.flatMap((st) => st.operations),
    [setups],
  )
  // Machine rapid rate feeds the inter-copy travel timing (ADR 0024 Amd 1):
  // estimateNestCutTimeMs now times the full expanded stream, so the rapids
  // linking copies use the machine rapidRate.
  const machine = useCamStore((s) => s.project.machine)
  const rapidRate = machine.rapidRate
  const cutTimeMotion = useMemo(() => machineCutTimeMotion(machine), [machine])
  const cutEstimate = useMemo(
    () => estimateNestCutTimeMs(
      nest, allOps, rapidRate, undefined, undefined, cutTimeMotion,
    ),
    [nest, allOps, rapidRate, cutTimeMotion],
  )
  // placed = one Placement per instance; requested = sum of source quantities.
  const placed = nest.placements.length
  const requested = nest.sources.reduce((sum, s) => sum + s.quantity, 0)
  const leftover = nest.unplaced.reduce((sum, u) => sum + u.count, 0)
  const utilPct = `${(nest.utilization * 100).toFixed(1)}%`
  // Reuse the modal's validator/defaults for records persisted before
  // rotationCount/windowGap existed. No record write occurs until commit.
  const validatedPackInputs = mergeNestSettings({
    style: nest.style,
    rotationCount: nest.rotationCount,
    spacing: nest.spacing,
  })
  const currentSolver = nest.solver ?? { kind: 'fixSheet' as const }
  // The modal represents fixQtyRatio as fixQty-none plus separate ratio fields.
  // Keep that state truthful here without adding a partial ratio editor.
  const solverChoice: SolverChoice | 'fixQtyRatio' =
    currentSolver.kind === 'fixQtyRatio'
      ? 'fixQtyRatio'
      : solverStateFromMode(currentSolver).solver
  // BUG-527 / WO-1524: EXACT vs FILL awareness for the persisted record. The
  // modal's NestResultSummary already branches on isExactChoice(lastCalcSolver);
  // the cold-reopen path here has no modal session state, so derive the same
  // distinction from the PERSISTED solver (solverStateFromMode maps a stored
  // fixQtyRatio onto its 'fixQty-none' + ratioLocked control form, exactly what
  // lastCalcSolver would have been). In fill mode (`fixSheet`) source.quantity is
  // a RATIO term, so `placed / requested` is a nonsensical shortfall.
  const exact = isExactChoice(solverStateFromMode(currentSolver).solver)

  const commitPackInputs = (update: (current: NestRecord) => NestRecord) => {
    const latest = useCamStore.getState()
    const current = latest.project.nests?.find((candidate) => candidate.id === nest.id)
    if (!current) return
    const next = update(current)
    if (next === current) return
    latest.pushHistory()
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        nests: (state.project.nests ?? []).map((candidate) =>
          candidate.id === nest.id ? next : candidate,
        ),
      },
    }))
  }

  const commitSpacing = (key: keyof NestRecord['spacing'], value: number) => {
    if (!Number.isFinite(value) || value < 0) return
    commitPackInputs((current) => {
      if (current.spacing[key] === value) return current
      return {
        ...current,
        spacing: { ...current.spacing, [key]: value },
        needsRecompute: true,
      }
    })
  }

  return (
    <div className="props-section">
      {/* CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) --
          sticky panel chrome, PANEL-INTERNAL (docked in this panel). */}
      <div className="props-group-header props-op-title" data-tooltip={nest.name} data-ui78-sanctioned="">
        {nest.name}
      </div>

      <CollapsibleGroup groupId="nest-summary" title={tx('PropertiesPanel.Summary')}>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Sheet')}</div>
          <div className="props-value">{tx('PropertiesPanel.x', { p1: fmtDim(nest.sheet.width, displayUnits), p2: fmtDim(nest.sheet.height, displayUnits), p3: unitLabel(displayUnits) })}</div>
        </div>
        <div className="props-group">
          <div className="props-label" data-tooltip={tx('PropertiesPanel.Material_thickness_Z_the_bound_stock_s_depth_Editing')}>{tx('PropertiesPanel.Thickness_Z')}</div>
          <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <NumericInput
              className="props-number-input"
              value={nest.thickness ?? defaultThickness}
              min={0.001}
              step={1}
              units={displayUnits}
              kind="dim"
              tooltip={tx('PropertiesPanel.Material_thickness_bound_stock_depth', { p1: unitLabel(displayUnits) })}
              onChange={(v) => setNestThickness(nest.id, v)}
            />
            <span>{unitLabel(displayUnits)}</span>
          </div>
        </div>
        <div className="props-group">
          <div
            className="props-label"
            data-tooltip={tx('PropertiesPanel.How_the_multi_copy_toolpath_is_ordered_By_operation')}
          >{tx('PropertiesPanel.Cut_order')}</div>
          <div className="props-value">
            <select
              className="props-number-input"
              data-testid="nest-machining-order"
              value={machiningOrder}
              data-tooltip={tx('PropertiesPanel.Multi_copy_cut_ordering')}
              onChange={(e) =>
                setNestMachiningOrder(nest.id, e.target.value as 'by-operation' | 'by-part')
              }
            >
              <option value="by-operation">{tx('PropertiesPanel.By_operation_default')}</option>
              <option value="by-part">{tx('PropertiesPanel.By_part')}</option>
            </select>
          </div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Style')}</div>
          <div className="props-value">
            <select
              className="props-number-input"
              data-testid="nest-style-props"
              value={nest.style}
              disabled={computing}
              onChange={(e) => {
                const style = e.target.value as NestRecord['style']
                commitPackInputs((current) => {
                  if (current.style === style) return current
                  return {
                    ...current,
                    style,
                    ...(style === 'arbitrary' && current.rotationCount === undefined
                      ? { rotationCount: validatedPackInputs.rotationCount }
                      : {}),
                    needsRecompute: true,
                  }
                })
              }}
            >
              <option value="ninety">{tx('PropertiesPanel.90_degree_steps_0_90_180_270')}</option>
              <option value="arbitrary">{tx('PropertiesPanel.Arbitrary_angle')}</option>
            </select>
          </div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Part_gap')}</div>
          <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <NumericInput
              className="props-number-input"
              value={validatedPackInputs.spacing.partGap}
              min={0}
              step={0.5}
              units={displayUnits}
              kind="dim"
              disabled={computing}
              ariaLabel={tx('PropertiesPanel.Nest_part_gap')}
              onChange={(value) => commitSpacing('partGap', value)}
            />
            <span>{unitLabel(displayUnits)}</span>
          </div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Sheet_margin')}</div>
          <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <NumericInput
              className="props-number-input"
              value={validatedPackInputs.spacing.sheetMargin}
              min={0}
              step={0.5}
              units={displayUnits}
              kind="dim"
              disabled={computing}
              ariaLabel={tx('PropertiesPanel.Nest_sheet_margin')}
              onChange={(value) => commitSpacing('sheetMargin', value)}
            />
            <span>{unitLabel(displayUnits)}</span>
          </div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Window_gap')}</div>
          <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <NumericInput
              className="props-number-input"
              value={validatedPackInputs.spacing.windowGap}
              min={0}
              step={0.5}
              units={displayUnits}
              kind="dim"
              disabled={computing}
              ariaLabel={tx('PropertiesPanel.Nest_window_gap')}
              onChange={(value) => commitSpacing('windowGap', value)}
            />
            <span>{unitLabel(displayUnits)}</span>
          </div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Solver')}</div>
          <div className="props-value">
            <select
              className="props-number-input"
              data-testid="nest-solver-props"
              value={solverChoice}
              disabled={computing}
              data-tooltip={solverChoice === 'fixQtyRatio'
                ? tx('PropertiesPanel.This_nest_uses_a_fixed_auto_size_ratio_Use')
                : tx('PropertiesPanel.Packing_objective_used_when_this_nest_is_recomputed')}
              onChange={(e) => {
                const choice = e.target.value as SolverChoice | 'fixQtyRatio'
                if (choice === 'fixQtyRatio') return
                const solver = solverModeFor(choice)
                commitPackInputs((current) => {
                  if (JSON.stringify(current.solver ?? { kind: 'fixSheet' }) === JSON.stringify(solver)) return current
                  return { ...current, solver, needsRecompute: true }
                })
              }}
            >
              {solverChoice === 'fixQtyRatio' && (
                <option value="fixQtyRatio" disabled>{tx('PropertiesPanel.Exact_quantity_fixed_ratio_Edit_to_change_ratio')}</option>
              )}
              <option value="fixSheet-exact">{tx('PropertiesPanel.Fixed_sheet_exact_quantity')}</option>
              <option value="fixSheet">{tx('PropertiesPanel.Fill_sheet_max_quantity_by_ratio')}</option>
              <option value="fixQty-none">{tx('PropertiesPanel.Exact_quantity_auto_size_sheet')}</option>
              <option value="fixQty-width">{tx('PropertiesPanel.Exact_quantity_lock_width_solve_height')}</option>
              <option value="fixQty-height">{tx('PropertiesPanel.Exact_quantity_lock_height_solve_width')}</option>
            </select>
          </div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Seed')}</div>
          <div className="props-value">
            <NumericInput
              className="props-number-input"
              value={nest.seed}
              min={0}
              max={0xffffffff}
              step={1}
              disabled={computing}
              ariaLabel={tx('PropertiesPanel.Nest_random_seed')}
              onChange={(value) => {
                const seed = Math.min(0xffffffff, Math.max(0, Math.round(value)))
                commitPackInputs((current) =>
                  current.seed === seed ? current : { ...current, seed, needsRecompute: true },
                )
              }}
            />
          </div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Placed')}</div>
          <div
            className="props-value"
            data-tooltip={exact
              ? tx('PropertiesPanel.Placed_instances_vs_requested_quantity')
              : tx('PropertiesPanel.Placed_instances_fill_mode_source_quantity_is_a_ratio')}
          >
            {placed}{exact ? ` / ${requested}` : ''}{exact && leftover > 0 ? tx('PropertiesPanel.Census_left', { p1: leftover }) : ''}
          </div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Utilization')}</div>
          <div className="props-value">{utilPct}</div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Est_cut_time')}</div>
          {cutEstimate.totalMsError ? (
            <div
              className="props-value props-value-error"
              data-testid="nest-cut-estimate"
              data-tooltip={cutEstimate.totalMsError}
            >{tx('PropertiesPanel.Unavailable_recompute_to_fix')}</div>
          ) : cutEstimate.totalMs > 0 && cutEstimate.instanceCount > 0 ? (
            <div
              className="props-value"
              data-testid="nest-cut-estimate"
              data-tooltip={tx('PropertiesPanel.Full_expanded_multi_copy_machine_time_every_copy_of')}
            >{tx('PropertiesPanel.copies_incl_inter_copy_travel', { p1: formatDurationHMS(cutEstimate.totalMs), p2: cutEstimate.instanceCount })}</div>
          ) : (
            <div
              className="props-value"
              data-testid="nest-cut-estimate"
              style={{ opacity: 0.7 }}
              data-tooltip={tx('PropertiesPanel.No_seed_op_toolpaths_are_computed_yet_Compute_the')}
            >{tx('PropertiesPanel.pending_seed_toolpaths')}</div>
          )}
        </div>
        {computing ? (
          <div className="props-group">
            <div className="props-label">{tx('PropertiesPanel.Computing')}</div>
            <div
              className="props-value"
              data-testid="nest-computing-props"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--accent-cyan)' }}
              data-tooltip={tx('PropertiesPanel.A_pack_is_in_flight_for_this_nest')}
            >
              <RefreshCw size={12} />{tx('PropertiesPanel.Computing_2', { p1: startedAt !== undefined ? ` ${formatElapsedSeconds(elapsedMs)}` : '' })}</div>
          </div>
        ) : nest.computeTimeMs !== undefined && (
          <div className="props-group">
            <div className="props-label">{tx('PropertiesPanel.Computed_in')}</div>
            <div className="props-value" data-tooltip={tx('PropertiesPanel.Wall_clock_time_to_pack_this_nest_diagnostic')}>
              {formatComputeMs(nest.computeTimeMs)}
            </div>
          </div>
        )}
      </CollapsibleGroup>

      <CollapsibleGroup groupId="nest-sources" title={tx('PropertiesPanel.Sources', { p1: nest.sources.length })}>
        {nest.sources.map((src) => {
          const name = geometry.find((g) => g.id === src.geometryId)?.name ?? src.geometryId
          return (
            <div className="props-group" key={src.geometryId}>
              <div className="props-label" data-tooltip={name}>{name}</div>
              <div className="props-value">{tx('PropertiesPanel.x_2', { p1: src.quantity, p2: src.locked ? tx('PropertiesPanel.Census_locked') : '' })}</div>
            </div>
          )
        })}
      </CollapsibleGroup>

      {stale && (
        <div className="props-group">
          <div
            className="props-value"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--accent-cyan)' }}
            data-tooltip={tx('PropertiesPanel.A_seed_part_changed_since_this_nest_was_packed')}
          >
            <AlertTriangle size={12} />{tx('PropertiesPanel.Needs_recompute_seed_changed')}</div>
        </div>
      )}

      {/* Action row: Edit/Hide-show/Recompute/Explode/Delete — the SAME five
          affordances the tree row's icon buttons offer (recon flagged Edit +
          Hide/show + Delete as tree-only; Recompute/Explode already existed
          here). Edit reopens the New Nest modal PREFILLED, exactly like the
          tree's Pencil button (setNestEditTarget + openModal('new-nest')). */}
      <div className="props-group props-btn-row" data-testid="nest-action-row">
        <button
          type="button"
          className="props-btn"
          data-testid="nest-visibility-props"
          onClick={() => setNestVisible(nest.id, !visible)}
          data-tooltip={visible ? tx('PropertiesPanel.Hide_nest') : tx('PropertiesPanel.Show_nest')}
        >
          {visible ? <EyeOff size={12} /> : <Eye size={12} />} {visible ? tx('PropertiesPanel.Hide') : tx('PropertiesPanel.Show')}
        </button>
        <button
          type="button"
          className="props-btn"
          data-testid="nest-edit-props"
          onClick={() => { setNestEditTarget(nest.id); openModal('new-nest') }}
          data-tooltip={tx('PropertiesPanel.Edit_nest')}
        >
          <Pencil size={12} />{tx('PropertiesPanel.Edit')}</button>
        {stale && (
          <button
            type="button"
            className="props-btn props-btn-accent"
            data-testid="nest-recompute-props"
            onClick={() => recomputeNest(nest.id)}
            data-tooltip={tx('PropertiesPanel.Recompute_nest_re_pack_from_the_current_seeds')}
          >
            <RefreshCw size={12} />{tx('PropertiesPanel.Recompute')}</button>
        )}
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="nest-explode-props"
          onClick={() => explodeNest(nest.id)}
          data-tooltip={tx('PropertiesPanel.Explode_nest_parts_become_independent')}
        >
          <Ungroup size={12} />{tx('PropertiesPanel.Explode')}</button>
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="nest-delete-props"
          onClick={() => removeNest(nest.id)}
          data-tooltip={tx('PropertiesPanel.Remove_nest')}
        >
          <Trash2 size={12} />{tx('PropertiesPanel.Delete_2')}</button>
      </div>
    </div>
  )
}

// ---- Geometry properties ----
export function GeometryProperties({ geo }: { geo: ImportedGeometry }) {
  useText('cam-operations-new-operation')
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const stocks = useCamStore((s) => s.project.stocks)
  const sceneStock = useCamStore((s) => s.project.sceneStock)
  const setStockMembership = useCamStore((s) => s.setStockMembership)
  const setGeometryNoStock = useCamStore((s) => s.setGeometryNoStock)
  const setGeometryWorkholding = useCamStore((s) => s.setGeometryWorkholding)
  const openSketchForLayer = useCamStore((s) => s.openSketchForLayer)
  const geometry = useCamStore((s) => s.project.geometry)
  const openBooleanMeshDialog = useCamStore((s) => s.openBooleanMeshDialog)
  // WO-1845 / ADR-0051 s2.3: this STL row's edit journal - names only, in
  // order, each removable. No banner and no modal (COHESION-STANDARD s13);
  // the list IS the surface, and removing an entry is one undo step.
  const removeMeshEdit = useCamStore((s) => s.removeMeshEdit)
  const meshEdits = geo.meshEdits ?? []
  // MSH-4-BOOLEAN-EDIT (nav path 3, select-then-invoke): the same shared
  // predicates the context menu + inline tree button gate on.
  const isBooleanResult = isBooleanResultRow(geo)
  const canBooleanSource = isMeshBooleanSourceRow(geo) && hasModelBooleanBody(geometry)
  const [busy, setBusy] = useState(false)
  const handlePos = (axis: keyof Vec3, v: number) => commitTransformAxis(geo, 'position', axis, v)
  const handleRot = (axis: keyof Vec3, v: number) => commitTransformAxis(geo, 'rotation', axis, v)
  // WO-2172: a body that is part of a vise is placed BY the vise (its
  // opening, its pose); the vise's own section leads and the row's
  // Position/Rotation fields step aside. A marked body not yet in a vise
  // offers "Make vise" when another workholding body can be its jaw.
  const workholdingModel = useCamStore((s) => s.project.workholding)
  const viseMembership = workholdingOfGeometry(workholdingModel, geo.id)
  const viseJawCount = geo.workholding && !viseMembership
    ? viseJawCandidates(geometry, workholdingComponentGeometryIds(workholdingModel), geo.id).length
    : 0
  const [makingVise, setMakingVise] = useState(false)

  // Show/hide is whole-part for 3D formats, all-layers for 2D formats.
  const has3dVisibility = geo.format === 'stl' || geo.format === 'step'
  const layers = geo.layers2d ?? []
  const allLayersVisible = layers.length > 0 && layers.every((l) => l.visible)
  const showHideLabel = has3dVisibility
    ? (geo.hidden ? tx('PropertiesPanel.Show') : tx('PropertiesPanel.Hide'))
    : (allLayersVisible ? tx('PropertiesPanel.Hide') : tx('PropertiesPanel.Show'))
  const canToggleVisibility = has3dVisibility || layers.length > 0

  // "Edit" (in its logical harness): a sketch-editable layer opens in the
  // sketch editor via the SAME openSketchForLayer the tree's per-layer
  // PenTool button and the layer list below both call. A part with exactly
  // ONE such layer gets a top-level shortcut; 2+ layers route through the
  // per-layer buttons in the list (which layer is unambiguous there).
  const sketchEditableLayers = (geo.format === 'dxf' || geo.format === 'svg' || geo.format === 'sketch')
    ? layers.filter((l) => !l.projectionPlane && !l.locked)
    : []

  // PP-SELECTION-UTILITY Stage 1 item 3 / main-task item 3: the part's own
  // dimensions (docs/UI-ARCHITECTURE.md:669 claimed this already existed —
  // it did not). geo.boundingBox is the part-local size computed at import
  // (and re-derived on layer delete); it does not re-derive on a rotation
  // edit, so it reads as "this part's own W x H x D", not a live world AABB
  // — exactly what a CNC user wants from "part dimensions".
  //
  // FULL-SUITE-DRIFT fix: every production BoundingBox constructor
  // (importGeometryFile.ts, dxfImporter.ts, svgImporter.ts, restoreScene.ts,
  // store/index.ts's makeSketchContainer/duplicateGeometryRow/STEP import)
  // always populates the full { min, max, size, center } shape, so this can
  // never crash from real app data. It CAN crash from a test double built
  // with a partial boundingBox (a real one, caught live: INT-15's fixture
  // supplies only { min, max } via an `as unknown as ImportedGeometry`
  // cast) — guard the shape, not just presence, so a malformed/partial
  // fixture degrades to "no Size row" instead of crashing the whole panel.
  const bb = geo.boundingBox && geo.boundingBox.size ? geo.boundingBox : undefined

  return (
    <div className="props-section">
      {viseMembership && <ViseProperties membership={viseMembership} />}
      <CollapsibleGroup
        groupId="geo-info"
        icon={<Move3d size={11} style={{ display: 'inline', marginRight: 5 }} />}
        title={<span data-tooltip={geo.name}>{geo.name}</span>}
      >
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.File')}</div>
          <div className="props-value" data-tooltip={geo.filename}>{geo.filename}</div>
        </div>
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Format')}</div>
          <div className="props-value">{geo.format.toUpperCase()}</div>
        </div>
        {meshEdits.length > 0 && (
          <div className="props-group" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div
              className="props-label"
              data-tooltip={tx('PropertiesPanel.Edits_replayed_over_this_part_s_imported_file_in')}
            >{tx('PropertiesPanel.Mesh_edits')}</div>
            {/* The list takes a full-width line of its own beneath the label.
                An edit's name is a sentence, not a number: squeezed into the
                narrow right-hand value column it wraps mid-phrase and is
                unreadable (measured in this WO's own capture). */}
            <div
              className="props-value"
              style={{
                padding: 0, flexBasis: '100%', textAlign: 'left',
                display: 'flex', flexDirection: 'column', gap: 3,
              }}
            >
              {meshEdits.map((edit, index) => (
                <div
                  key={edit.id}
                  data-testid="pp-mesh-edit"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'normal' }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>{index + 1}{tx('PropertiesPanel.symbol_3')}</span>
                  <span style={{ flex: 1 }}>{describeMeshEdit(edit)}</span>
                  <button
                    type="button"
                    data-testid="pp-mesh-edit-remove"
                    aria-label={tx('PropertiesPanel.Remove_mesh_edit', { p1: describeMeshEdit(edit) })}
                    title={tx('PropertiesPanel.Remove_this_edit')}
                    onClick={() => removeMeshEdit(geo.id, edit.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center',
                      background: 'transparent', color: 'var(--text-primary)',
                      border: '1px solid var(--border)', borderRadius: 5,
                      padding: '1px 4px', cursor: 'pointer',
                    }}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {(isBooleanResult || canBooleanSource) && (
          <div className="props-group">
            <div className="props-label" data-tooltip={tx('PropertiesPanel.Boolean_an_imported_mesh_against_a_Model_body_approximate')}>{tx('PropertiesPanel.Boolean')}</div>
            <div className="props-value" style={{ padding: 0 }}>
              <button
                type="button"
                data-testid={isBooleanResult ? 'pp-edit-boolean' : 'pp-boolean-with-model'}
                onClick={() => (isBooleanResult ? openBooleanMeshDialog(null, geo.id) : openBooleanMeshDialog(geo.id))}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: 'transparent', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 5,
                  padding: '3px 8px', fontSize: 'var(--font-size-sm)', cursor: 'pointer',
                }}
              >
                <Combine size={12} /> {isBooleanResult ? tx('PropertiesPanel.Edit_boolean') : tx('PropertiesPanel.Boolean_with_model_body')}
              </button>
            </div>
          </div>
        )}
        {bb && (() => {
          // A summary line for 3 numbers doesn't need mill-thousandths (that
          // precision stays available in the tooltip + the Position/Rotation
          // fields below); 2dp keeps it from overflowing the column at the
          // panel's normal width without truncating with an ellipsis
          // (UI-BRAND: never silently bury a value).
          const full = `${fmtDim(bb.size.x, displayUnits)} x ${fmtDim(bb.size.y, displayUnits)} x ${fmtDim(bb.size.z, displayUnits)} ${unitLabel(displayUnits)}`
          return (
            <div className="props-group" style={{ alignItems: 'flex-start' }}>
              <div className="props-label" data-tooltip={tx('PropertiesPanel.Part_dimensions_local_size_independent_of_position_rotation')}>{tx('PropertiesPanel.Size')}</div>
              <div className="props-value" data-testid="geo-bbox-size" data-tooltip={full} style={{ whiteSpace: 'normal' }}>{tx('PropertiesPanel.x_x', { p1: fmtDim(bb.size.x, displayUnits, 2), p2: fmtDim(bb.size.y, displayUnits, 2), p3: fmtDim(bb.size.z, displayUnits, 2), p4: unitLabel(displayUnits) })}</div>
            </div>
          )
        })()}
        {(stocks?.length ?? 0) > 0 && (() => {
          const state = resolveStockMembershipState(geo, stocks ?? [])
          const selected =
            state === 'none' ? '__none__'
            : state === 'named-stock' ? (geo.stockId as string)
            : DERIVED_STOCK_ID
          const named = [
            ...(sceneStock.autoStocks ?? []),
            ...(sceneStock.fixedStocks ?? []),
          ]
          return (
            <div className="props-group">
              <div className="props-label" data-tooltip={tx('PropertiesPanel.Owning_stock_Choose_None_to_exclude_this_part_from')}>{tx('PropertiesPanel.Stock')}</div>
              <div className="props-value">
                <select
                  className="props-number-input"
                  data-testid="geo-stock-select"
                  value={selected}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '__none__') setGeometryNoStock(geo.id)
                    else setStockMembership(geo.id, v)
                  }}
                >
                  <option value="__none__">{tx('PropertiesPanel.None')}</option>
                  {named.map((st) => (
                    <option key={st.id} value={st.id}>{st.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )
        })()}
        {/* WO-1573: mark/unmark this body as workholding (a vise, clamp or
            fixture) via the WO-1572 store action. Recolors the viewport body
            immediately (setPartWorkholding), same live-update pattern as the
            color swatch's updateGeometryColor + setPartColor pair below. */}
        <div className="props-group" data-testid="geo-workholding-toggle-row">
          <div
            className="props-label"
            data-tooltip={tx('PropertiesPanel.A_vise_clamp_or_fixture_never_stock_never_a')}
          >{tx('PropertiesPanel.Workholding')}</div>
          <label
            className="props-value"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              data-testid="geo-workholding-toggle"
              checked={!!geo.workholding}
              onChange={(event) => {
                const next = event.target.checked
                setGeometryWorkholding(geo.id, next)
                getVp()?.setPartWorkholding?.(geo.id, next, geo.color)
              }}
            />
            <span>{geo.workholding ? tx('PropertiesPanel.On') : tx('PropertiesPanel.Off')}</span>
            {geo.workholding && (
              <button
                type="button"
                className="props-btn"
                data-testid="geo-seat-in-vise-btn"
                data-tooltip={tx('PropertiesPanel.Seat_this_workholding_body_against_a_part_in_the')}
                onClick={() => useSeatInViseUi.getState().openSeatInVise(geo.id)}
              >
                <Anchor size={12} />{tx('PropertiesPanel.Seat_in_vise')}</button>
            )}
          </label>
        </div>
        {viseJawCount > 0 && !makingVise && (
          <div className="props-group props-btn-row">
            <button
              type="button"
              className="props-btn"
              data-testid="geo-make-vise-btn"
              data-tooltip={tx('PropertiesPanel.Make_a_vise_this_body_stays_fixed_another_workholding')}
              onClick={() => setMakingVise(true)}
            >
              <Anchor size={12} />{tx('PropertiesPanel.Make_vise')}</button>
          </div>
        )}
        {/* WO-2192: this body as a clamp's shape, placed along stock or part edges. */}
        {geo.workholding && !viseMembership && !makingVise && <MakeClampButton geo={geo} />}
        {makingVise && viseJawCount > 0 && (
          <MakeViseForm fixedGeo={geo} onDone={() => setMakingVise(false)} />
        )}
      </CollapsibleGroup>

      {/* Action row: Duplicate/Delete/Show-hide reuse the SAME store actions +
          cache/viewport primitives DesignTree.tsx's row buttons call
          (duplicateGeometryRow/removeGeometryRow/toggleGeometryVisibility -
          see their doc comments above for the exact tree handlers mirrored).
          Edit reuses the SAME openSketchForLayer the tree's per-layer PenTool
          button calls. PP-SWATCH: the color swatch is the SAME shared
          GeometryColorSwatch component the design tree's row mounts (same
          popup, same handlers - shared, not duplicated). */}
      <div className="props-group props-btn-row" data-testid="geo-action-row">
        <GeometryColorSwatch geo={geo} />
        {sketchEditableLayers.length === 1 && (
          <button
            type="button"
            className="props-btn"
            data-testid="geo-edit-sketch-btn"
            onClick={() => openSketchForLayer(sketchEditableLayers[0].id, geo.id)}
            data-tooltip={geo.sketches?.some((sk) => sk.layerId === sketchEditableLayers[0].id)
              ? tx('PropertiesPanel.Edit_sketch_parametric_re_edit')
              : tx('PropertiesPanel.Edit_in_Sketch_lift_imported_geometry')}
          >
            <PenTool size={12} />{tx('PropertiesPanel.Edit')}</button>
        )}
        {canToggleVisibility && (
          <button
            type="button"
            className="props-btn"
            data-testid="geo-visibility-btn"
            onClick={() => (has3dVisibility ? toggleGeometryVisibility(geo) : toggleAllLayersVisibility(geo))}
            data-tooltip={tx('PropertiesPanel.this_part', { p1: showHideLabel })}
          >
            {showHideLabel === 'Hide' ? <EyeOff size={12} /> : <Eye size={12} />} {showHideLabel}
          </button>
        )}
        <button
          type="button"
          className="props-btn"
          data-testid="geo-duplicate-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try { await duplicateGeometryRow(geo) } finally { setBusy(false) }
          }}
          data-tooltip={tx('PropertiesPanel.Duplicate_geometry')}
        >
          <Copy size={12} />{tx('PropertiesPanel.Duplicate')}</button>
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="geo-delete-btn"
          onClick={() => {
            // WO-1268: themed dialog; destructive in practice (WO-1283).
            void (async () => {
              const ok = await useCamStore.getState().requestConfirm({
                title: tx('PropertiesPanel.Delete_geometry_confirm_title', { p1: geo.name }),
                body: tx('PropertiesPanel.Delete_geometry_confirm_body'),
                confirmLabel: tx('PropertiesPanel.Delete'),
                cancelLabel: tx('PropertiesPanel.Cancel'),
                tone: 'danger',
              })
              if (ok) removeGeometryRow(geo)
            })()
          }}
          data-tooltip={tx('PropertiesPanel.Remove_geometry')}
        >
          <Trash2 size={12} />{tx('PropertiesPanel.Delete_2')}</button>
      </div>

      {!viseMembership && (
        <CollapsibleGroup groupId="geo-position" title={tx('PropertiesPanel.Position', { p1: unitLabel(displayUnits) })}>
          <div className="props-transform-row">
            <TransformInput axis="X" color="var(--x-axis)" value={geo.position.x} onChange={(v) => handlePos('x', v)} units={displayUnits} />
            <TransformInput axis="Y" color="var(--y-axis)" value={geo.position.y} onChange={(v) => handlePos('y', v)} units={displayUnits} />
            <TransformInput axis="Z" color="var(--z-axis)" value={geo.position.z} onChange={(v) => handlePos('z', v)} units={displayUnits} />
          </div>
        </CollapsibleGroup>
      )}

      {!viseMembership && (
        <CollapsibleGroup groupId="geo-rotation" title={tx('PropertiesPanel.Rotation_deg')}>
          <div className="props-transform-row">
            {/* Rotation is degrees - NOT a length, so no units prop (never converted). */}
            <TransformInput axis="X" color="var(--x-axis)" value={geo.rotation.x} onChange={(v) => handleRot('x', v)} />
            <TransformInput axis="Y" color="var(--y-axis)" value={geo.rotation.y} onChange={(v) => handleRot('y', v)} />
            <TransformInput axis="Z" color="var(--z-axis)" value={geo.rotation.z} onChange={(v) => handleRot('z', v)} />
          </div>
        </CollapsibleGroup>
      )}

      {layers.length > 0 && (
        <CollapsibleGroup groupId="geo-layers" title={tx('PropertiesPanel.Layers', { p1: layers.length })}>
          {layers.map((layer) => {
            const loopCount = geo.loops?.filter((l) => l.layerId === layer.id).length ?? 0
            const editable = (geo.format === 'dxf' || geo.format === 'svg' || geo.format === 'sketch')
              && !layer.projectionPlane && !layer.locked
            return (
              <div className="props-group" key={layer.id} data-testid={`geo-layer-row-${layer.id}`}>
                <div className="props-label" data-tooltip={layer.name}>
                  <span
                    style={{
                      display: 'inline-block', width: 8, height: 8, borderRadius: 2,
                      background: layer.color, marginRight: 5, verticalAlign: 'middle',
                    }}
                  />
                  {layer.name}
                </div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>{tx('PropertiesPanel.loop', { p1: loopCount, p2: loopCount === 1 ? '' : tx('PropertiesPanel.s') })}</span>
                  <button
                    type="button"
                    className="props-icon-btn"
                    data-testid={`geo-layer-visible-${layer.id}`}
                    onClick={() => toggleLayerVisibility(geo, layer)}
                    data-tooltip={layer.visible ? tx('PropertiesPanel.Hide_layer') : tx('PropertiesPanel.Show_layer')}
                    aria-label={layer.visible ? tx('PropertiesPanel.Hide_layer') : tx('PropertiesPanel.Show_layer')}
                  >
                    {layer.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                  </button>
                  {editable && (
                    <button
                      type="button"
                      className="props-icon-btn"
                      data-testid={`geo-layer-edit-${layer.id}`}
                      onClick={() => openSketchForLayer(layer.id, geo.id)}
                      data-tooltip={geo.sketches?.some((sk) => sk.layerId === layer.id)
                        ? tx('PropertiesPanel.Edit_sketch_parametric_re_edit')
                        : tx('PropertiesPanel.Edit_in_Sketch_lift_imported_geometry')}
                      aria-label={geo.sketches?.some((sk) => sk.layerId === layer.id) ? tx('PropertiesPanel.Edit_sketch') : tx('PropertiesPanel.Edit_in_Sketch')}
                    >
                      <PenTool size={11} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </CollapsibleGroup>
      )}
    </div>
  )
}

// ---- Layer properties (PP-UTILITY Stage 3) ----
// A tree LAYER row selected via setSelectedLayer (DesignTree.tsx row click).
// Identifying facts + actions per the shipped panel idiom, reusing EXISTING
// store actions only (same pattern FixedStockProperties/GeometryProperties
// establish): Edit sketch (openSketchForLayer), Rename (updateGeometryLayer,
// same field the tree's TreeRenameLabel commits through), Delete
// (deleteGeometryLayer, same as the tree's Trash2 button), and Convert to
// model... — GEO-UNIFY Stage 3's promote flow. The recon's own Stage 3 note
// flagged the tree as having TWO promote entry paths (inline button +
// context-menu item, `layer-convert-to-model`); this Properties-panel button
// is the THIRD path onto the exact same promoteSketchPreview/
// promoteSketchLayerToModel pair DesignTree.tsx's handleConvertLayerToModel
// calls, so the confirm text and eligibility gate are byte-identical across
// all three paths — never a lesser/duplicate implementation.
function LayerProperties({ geo, layer }: { geo: ImportedGeometry; layer: Layer2D }) {
  useText('cam-operations-new-operation')
  const openSketchForLayer = useCamStore((s) => s.openSketchForLayer)
  const updateGeometryLayer = useCamStore((s) => s.updateGeometryLayer)
  const deleteGeometryLayer = useCamStore((s) => s.deleteGeometryLayer)
  const promoteSketchPreview = useCamStore((s) => s.promoteSketchPreview)
  const promoteSketchLayerToModel = useCamStore((s) => s.promoteSketchLayerToModel)
  const [busy, setBusy] = useState(false)

  const loopCount = geo.loops?.filter((l) => l.layerId === layer.id).length ?? 0
  // Same predicate DesignTree.tsx's own layer row uses (P13 / GEO-UNIFY Stage 3).
  const sketchEditable =
    (geo.format === 'dxf' || geo.format === 'svg' || geo.format === 'sketch') &&
    !layer.projectionPlane && !layer.locked
  const kindLabel = layer.projectionPlane
    ? tx('PropertiesPanel.STL_projection')
    : geo.format === 'dxf' ? 'DXF'
    : geo.format === 'svg' ? 'SVG'
    : geo.format === 'sketch' ? tx('PropertiesPanel.Sketch')
    : geo.format.toUpperCase()

  const handleConvert = async () => {
    const preview = promoteSketchPreview(layer.id, geo.id)
    if (!preview.eligible) return  // button is only shown for eligible rows
    // PROMOTE-SKETCH-FAIL round 2: themed confirm (on-brand), same as the tree
    // path in DesignTree; replaces the off-theme native window.confirm.
    const ok = await useCamStore.getState().requestConfirm({
      get title() { return tx('PropertiesPanel.Convert_sketch_to_model') },
      body: preview.opNames.length > 0
        ? tx('PropertiesPanel.These_operations_use_this_sketch_After_converting_they_will', { p1: preview.opNames.join(', ') }) +
          tx('PropertiesPanel.marked_outdated_until_you_reselect_geometry_on_the_model') +
          tx('PropertiesPanel.base_sketch_and_moves_out_of_the_sketch_list')
        : tx('PropertiesPanel.It_becomes_the_new_model_s_base_sketch_and'),
      get confirmLabel() { return tx('PropertiesPanel.Convert_to_model') },
      get cancelLabel() { return tx('PropertiesPanel.Cancel') },
    })
    if (!ok) return
    setBusy(true)
    try { await promoteSketchLayerToModel(layer.id, geo.id) } finally { setBusy(false) }
  }

  return (
    <div className="props-section">
      {/* CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) --
          sticky panel chrome, PANEL-INTERNAL (docked in this panel). */}
      <div className="props-group-header props-op-title" data-tooltip={layer.name} data-ui78-sanctioned="">
        {layer.name}
      </div>

      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.Parent_geometry')}</div>
        <div className="props-value" data-tooltip={geo.name}>{geo.name}</div>
      </div>
      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.Kind')}</div>
        <div className="props-value" data-testid="layer-kind">{kindLabel}</div>
      </div>
      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.Loops')}</div>
        <div className="props-value" data-testid="layer-loop-count">{loopCount}</div>
      </div>
      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.Locked')}</div>
        <div className="props-value" data-testid="layer-locked">{layer.locked ? tx('PropertiesPanel.Yes') : tx('PropertiesPanel.No')}</div>
      </div>

      {/* Edit sketch / Rename / Convert to model / Delete — the SAME store
          actions the tree row's own icon buttons call (see doc comment
          above). Omit-not-disable: Edit sketch and Convert to model only
          appear when sketchEditable (locked/STL-projection layers refuse
          both, matching the tree's own self-guard). */}
      <div className="props-group props-btn-row" data-testid="layer-action-row">
        {sketchEditable && (
          <button
            type="button"
            className="props-btn"
            data-testid="layer-edit-sketch-btn"
            onClick={() => openSketchForLayer(layer.id, geo.id)}
            data-tooltip={geo.sketches?.some((sk) => sk.layerId === layer.id)
              ? tx('PropertiesPanel.Edit_sketch_parametric_re_edit')
              : tx('PropertiesPanel.Edit_in_Sketch_lift_imported_geometry')}
          >
            <PenTool size={12} />{tx('PropertiesPanel.Edit_sketch_2')}</button>
        )}
        <button
          type="button"
          className="props-btn"
          data-testid="layer-rename-btn"
          onClick={() => {
            const next = window.prompt(tx('PropertiesPanel.Rename_layer'), layer.name)
            if (next && next.trim() && next.trim() !== layer.name) {
              updateGeometryLayer(geo.id, layer.id, { name: next.trim() })
            }
          }}
          data-tooltip={tx('PropertiesPanel.Rename_layer')}
        >
          <Pencil size={12} />{tx('PropertiesPanel.Rename')}</button>
        {sketchEditable && (
          <button
            type="button"
            className="props-btn"
            data-testid="layer-convert-model-btn"
            disabled={busy}
            onClick={handleConvert}
            data-tooltip={tx('PropertiesPanel.Convert_to_model_move_this_sketch_into_a_new')}
          >
            <Box size={12} />{tx('PropertiesPanel.Convert_to_model_2')}</button>
        )}
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="layer-delete-btn"
          onClick={() => {
            // WO-1268: themed dialog. Layer deletion does not enter undo history.
            void (async () => {
              const ok = await useCamStore.getState().requestConfirm({
                title: tx('PropertiesPanel.Delete_layer_confirm_title', { p1: layer.name }),
                body: tx('PropertiesPanel.Delete_layer_confirm_body'),
                confirmLabel: tx('PropertiesPanel.Delete'),
                cancelLabel: tx('PropertiesPanel.Cancel'),
                tone: 'danger',
              })
              if (ok) deleteGeometryLayer(geo.id, layer.id)
            })()
          }}
          data-tooltip={tx('PropertiesPanel.Delete_layer_deletes_the_layer_s_geometry')}
        >
          <Trash2 size={12} />{tx('PropertiesPanel.Delete_2')}</button>
      </div>
    </div>
  )
}

// ---- Folder properties (PP-UTILITY Stage 3) ----
// A tree FOLDER row selected via setSelectedFolder — either a geometry-list
// organizational folder (the project's `geometryFolders` array) or a
// per-setup operation folder (`Setup.operationFolders`); `kind` disambiguates
// which. Rename/Delete reuse the SAME store actions the tree row's own
// Pencil/Trash2 buttons call.
function FolderProperties({
  kind, folder, memberCount, setupId,
}: {
  kind: 'geometry' | 'operation'
  folder: GeometryFolder | OperationFolder
  memberCount: number
  setupId: string | null
}) {
  useText('cam-operations-new-operation')
  const renameGeometryFolder = useCamStore((s) => s.renameGeometryFolder)
  const removeGeometryFolder = useCamStore((s) => s.removeGeometryFolder)
  const renameOperationFolder = useCamStore((s) => s.renameOperationFolder)
  const removeOperationFolder = useCamStore((s) => s.removeOperationFolder)

  const handleRename = () => {
    const next = window.prompt(tx('PropertiesPanel.Rename_folder'), folder.name)
    if (!next || !next.trim() || next.trim() === folder.name) return
    if (kind === 'geometry') renameGeometryFolder(folder.id, next.trim())
    else if (setupId) renameOperationFolder(setupId, folder.id, next.trim())
  }
  const handleDelete = () => {
    if (kind === 'geometry') removeGeometryFolder(folder.id)
    else if (setupId) removeOperationFolder(setupId, folder.id)
  }

  return (
    <div className="props-section">
      {/* CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) --
          sticky panel chrome, PANEL-INTERNAL (docked in this panel). */}
      <div className="props-group-header props-op-title" data-tooltip={folder.name} data-ui78-sanctioned="">
        {folder.name}
      </div>
      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.Type')}</div>
        <div className="props-value" data-testid="folder-type">
          {kind === 'geometry' ? tx('PropertiesPanel.Geometry_folder') : tx('PropertiesPanel.Operation_folder')}
        </div>
      </div>
      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.Members')}</div>
        <div className="props-value" data-testid="folder-member-count">{memberCount}</div>
      </div>

      <div className="props-group props-btn-row" data-testid="folder-action-row">
        <button
          type="button"
          className="props-btn"
          data-testid="folder-rename-btn"
          onClick={handleRename}
          data-tooltip={tx('PropertiesPanel.Rename_folder')}
        >
          <Pencil size={12} />{tx('PropertiesPanel.Rename')}</button>
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="folder-delete-btn"
          onClick={handleDelete}
          data-tooltip={tx('PropertiesPanel.Delete_folder')}
        >
          <Trash2 size={12} />{tx('PropertiesPanel.Delete_2')}</button>
      </div>
    </div>
  )
}

// ---- Model Item Placement properties (WO INT-17C Stage C2) ----
// PANEL SUPPLEMENT to the in-viewport move gizmo (in-workspace direct
// manipulation first, per standing UI rule): the SAME Placement value, typed
// X/Y/Z/rotation fields committing through the SAME store action the gizmo's
// drag-end commits through (commitModelItemPlacementAxis -> updateModelItemPlacement).
// `geo` is whichever of the item's CAM geometry rows Operator selected -- shown
// here is the ITEM's Placement (its name, its position/rotation), never
// `geo.position`/`geo.rotation` directly (those stay refused, C1 step 3b).
function ModelItemPlacementProperties({ geo }: { geo: ImportedGeometry }) {
  useText('cam-operations-new-operation')
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const modelItems = useCamStore((s) => s.project.modelItems)
  const modelItemPlacements = useCamStore((s) => s.project.modelItemPlacements)
  const geometry = useCamStore((s) => s.project.geometry)
  const openModelItem = useCamStore((s) => s.openModelItem)
  const renameModelItem = useCamStore((s) => s.renameModelItem)

  const modelItemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const itemName = modelItems?.find((m) => m.id === modelItemId)?.name
    ?? (modelItemId === LEGACY_MODEL_ITEM_ID ? tx('PropertiesPanel.Model') : modelItemId)

  // Stage 1 item 5: "which/how many CAM geometry rows belong to this item"
  // and "the item's folder" — both flagged in the recon as missing.
  const bodyCount = geometry.filter((g) => resolveOwningModelItemId(g) === modelItemId).length

  let placement: { position: Vec3; rotation: Vec3 } | null = null
  try {
    placement = resolveModelReferenceFrame(modelItemPlacements ?? [], modelItemId, geo.modelBody?.ref.bodyId)
  } catch {
    placement = null
  }

  const handlePos = (axis: keyof Vec3, v: number) => commitModelItemPlacementAxis(geo, 'position', axis, v)
  const handleRot = (axis: keyof Vec3, v: number) => commitModelItemPlacementAxis(geo, 'rotation', axis, v)

  return (
    <div className="props-section">
      <CollapsibleGroup
        groupId="model-item-info"
        icon={<Move3d size={11} style={{ display: 'inline', marginRight: 5 }} />}
        title={<span data-tooltip={itemName}>{itemName}</span>}
      >
        <div className="props-group">
          <div className="props-label">{tx('PropertiesPanel.Bodies')}</div>
          <div className="props-value" data-testid="model-item-body-count">{bodyCount}</div>
        </div>
      </CollapsibleGroup>

      {/* Edit/Rename/Delete reuse the SAME store actions the tree's model-row
          buttons call (openModelItem / renameModelItem / removeModelItem —
          see UI-EDIT-MODEL-FROM-BODY / GEO-UNIFY Stage 1 for the tree side).
          A selected model previously had zero action buttons in this panel
          (recon top finding). */}
      <div className="props-group props-btn-row" data-testid="model-item-action-row">
        <button
          type="button"
          className="props-btn"
          data-testid="model-item-edit-btn"
          onClick={() => openModelItem(modelItemId)}
          data-tooltip={tx('PropertiesPanel.Edit_model')}
        >
          <Settings2 size={12} />{tx('PropertiesPanel.Edit')}</button>
        <button
          type="button"
          className="props-btn"
          data-testid="model-item-rename-btn"
          onClick={() => {
            const next = window.prompt(tx('PropertiesPanel.Rename_model_item'), itemName)
            if (next && next.trim() && next.trim() !== itemName) renameModelItem(modelItemId, next.trim())
          }}
          data-tooltip={tx('PropertiesPanel.Rename_model')}
        >
          <Pencil size={12} />{tx('PropertiesPanel.Rename')}</button>
        <button
          type="button"
          className="props-btn props-btn-danger"
          data-testid="model-item-delete-btn"
          onClick={() => { void removeModelItemRow(modelItemId, itemName) }}
          data-tooltip={tx('PropertiesPanel.Delete_model')}
        >
          <Trash2 size={12} />{tx('PropertiesPanel.Delete_2')}</button>
      </div>

      {placement ? (
        <>
          <CollapsibleGroup groupId="model-item-position" title={tx('PropertiesPanel.Position', { p1: unitLabel(displayUnits) })}>
            <div className="props-transform-row">
              <TransformInput axis="X" color="var(--x-axis)" value={placement.position.x} onChange={(v) => handlePos('x', v)} units={displayUnits} />
              <TransformInput axis="Y" color="var(--y-axis)" value={placement.position.y} onChange={(v) => handlePos('y', v)} units={displayUnits} />
              <TransformInput axis="Z" color="var(--z-axis)" value={placement.position.z} onChange={(v) => handlePos('z', v)} units={displayUnits} />
            </div>
          </CollapsibleGroup>

          <CollapsibleGroup groupId="model-item-rotation" title={tx('PropertiesPanel.Rotation_deg')}>
            <div className="props-transform-row">
              {/* Rotation is degrees - NOT a length, so no units prop (never converted). */}
              <TransformInput axis="X" color="var(--x-axis)" value={placement.rotation.x} onChange={(v) => handleRot('x', v)} />
              <TransformInput axis="Y" color="var(--y-axis)" value={placement.rotation.y} onChange={(v) => handleRot('y', v)} />
              <TransformInput axis="Z" color="var(--z-axis)" value={placement.rotation.z} onChange={(v) => handleRot('z', v)} />
            </div>
          </CollapsibleGroup>
        </>
      ) : (
        // Fail-loud UI state (Placement Composition Contract invariant 4):
        // this should be unreachable in practice (syncModelBodies seeds a
        // resolvable record the moment an item's first body appears), so
        // surfacing it plainly rather than silently showing 0/0/0 is correct
        // if it is ever hit.
        <div className="props-group" data-testid="model-item-no-placement">
          <div className="props-value" style={{ color: 'var(--accent-amber)' }}>{tx('PropertiesPanel.No_Placement_recorded_yet_for', { p1: itemName })}</div>
        </div>
      )}
    </div>
  )
}

function fmt(n: number) { return parseFloat(n.toFixed(3)).toString() }

// Display an mm value in the active display unit (ADR-0022). mm/undefined keeps
// the original `fmt` path EXACTLY (byte-identical); inch shows 4-decimal inches
// with trailing zeros stripped. Used only for the position axes; rotation
// (degrees) passes no `units` and stays on the original `fmt` path.
function fmtAxis(valueMm: number, units?: Units): string {
  if (units === undefined || units === 'mm') return fmt(valueMm)
  return parseFloat((valueMm / 25.4).toFixed(4)).toString()
}

export function TransformInput({
  axis, color, value, onChange, units,
}: {
  axis: string
  color: string
  value: number
  onChange: (v: number) => void
  // When provided, `value`/`onChange` STILL speak mm; only display+parse convert
  // (ADR-0022). Omitted for rotation (degrees), which is never converted.
  units?: Units
}) {
  useText('cam-operations-new-operation')
  const [draft, setDraft] = useState(() => fmtAxis(value, units))
  const focused = useRef(false)
  // Armed by Escape, read by commit(). A ref (not state) so it stays visible
  // to a STALE commit closure: e.currentTarget.blur() fires the native blur
  // event synchronously, before React has flushed Escape's queued setDraft,
  // so the onBlur handler that actually runs is still the pre-Escape one and
  // would otherwise read the DOM's untouched (not-yet-reverted) value (BUG-376).
  const cancelledRef = useRef(false)
  // Shared click-selects-all contract (selectAllOnClick.ts). The old inline
  // e.target.select() on focus was a dead pattern twice over: select() is a
  // spec no-op on type="number", and even on text the mouseUp caret drop wins
  // without the one-shot re-select.
  const selectAll = useSelectAllOnClick()

  // Sync the displayed value when an external source (gizmo drag) or the active
  // display unit changes it, but only when the field is not being actively edited.
  useEffect(() => {
    if (!focused.current) setDraft(fmtAxis(value, units))
  }, [value, units])

  const commit = (str: string) => {
    if (cancelledRef.current) {
      // Escape cancelled this session: `str` (DOM/closure) may still be the
      // user's uncommitted typed text, so it must never be parsed/committed.
      cancelledRef.current = false
      return
    }
    const n = parseFloat(str)
    if (!isNaN(n)) {
      // Draft is in DISPLAY units; convert to mm before committing.
      const mm = units === 'inch' ? n * 25.4 : n
      // Only fire onChange when the resolved value actually differs (at
      // display precision) from what the field showed on focus -- an
      // untouched field (tabbed through, clicked away from) must not move
      // the geometry or push a phantom history step.
      if (fmtAxis(mm, units) !== fmtAxis(value, units)) onChange(mm)
      setDraft(fmtAxis(mm, units))
    } else {
      setDraft(fmtAxis(value, units))  // revert to last good value on invalid input
    }
  }

  // Preserve the number-input arrow-key stepping (0.1 per press, draft only —
  // commit still happens on blur/Enter, exactly like the native spinner did).
  const stepDraft = (dir: 1 | -1) => {
    const n = parseFloat(draft)
    const next = (isNaN(n) ? 0 : n) + dir * 0.1
    setDraft(String(parseFloat(next.toFixed(6))))  // kill float noise (0.30000000000000004)
  }

  return (
    <div className="props-transform-cell">
      <span className="props-axis-label" style={{ color }}>{axis}</span>
      <input
        // type="text" + inputMode="decimal" (not type="number") so the
        // select-all APIs actually apply (HTML spec) — the shared contract.
        type="text"
        inputMode="decimal"
        className="props-number-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => { focused.current = true; selectAll.onFocus(e) }}
        onMouseUp={selectAll.onMouseUp}
        onBlur={(e)  => { focused.current = false; commit(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur() }
          if (e.key === 'Escape') {
            cancelledRef.current = true
            setDraft(fmtAxis(value, units))
            e.currentTarget.blur()
          }
          if (e.key === 'ArrowUp')   { e.preventDefault(); stepDraft(1) }
          if (e.key === 'ArrowDown') { e.preventDefault(); stepDraft(-1) }
        }}
      />
    </div>
  )
}

// ---- Setup properties ----
function SetupProperties({ setup }: { setup: ReturnType<typeof useCamStore.getState>['project']['setups'][0] }) {
  useText('cam-operations-new-operation')
  // ADR 0026 one-stock-per-setup fail-loud surfacing. The pure checker
  // (setupStockConsistency) resolves every op's owning stock and flags a setup
  // whose ops span >1 distinct stock — there is no single WCS / clearance plane,
  // and the post already REFUSES such a setup (ADR 0003). Surface the same
  // failure here so the user sees it BEFORE trying to export. Read the slices the
  // checker needs from the store (geometry / stocks / nests) and run it in a
  // useMemo, BEFORE any return, so no hook ordering can shift (render-gate rule).
  const project = useCamStore((s) => s.project)
  const geometry = useCamStore((s) => s.project.geometry)
  const stocks = useCamStore((s) => s.project.stocks)
  const nests = useCamStore((s) => s.project.nests)
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const openEditSetup = useCamStore((s) => s.openEditSetup)
  const updateSetup = useCamStore((s) => s.updateSetup)
  const consistency = useMemo(
    () => setupStockConsistency(setup, geometry, stocks ?? [], nests ?? []),
    [setup, geometry, stocks, nests],
  )
  // WO-1389: post/simulation/program context all read the resolved offset
  // (resolveSetupWorkOffset), not setup.wcs.label as stored — a stock-bound
  // fixture override can leave the stored label stale (e.g. G56 stored,
  // program uses G55). Show what the program will actually use. Resolution
  // errors (malformed/dangling stock binding) fall back to the raw label;
  // the post path independently refuses export loud on the same error.
  const resolvedWcsLabel = useMemo(() => {
    try {
      return resolveSetupWorkOffset({ geometry, stocks: stocks ?? [], nests: nests ?? [] }, setup).setup.wcs.label
    } catch {
      return setup.wcs.label
    }
  }, [setup, geometry, stocks, nests])
  // Stage 1 item 4: the resolved stock's NAME, not just setup.stock.type —
  // only meaningful when every op agrees on one stock (consistency.ok with
  // exactly one id). Operations disagreeing (consistency.ok === false) keeps
  // the type-label fallback unchanged alongside the conflict message below.
  // WO-1421: when there are no operations to check at all (or none of them
  // resolve a stock), fall back to the setup's OWN bound stock — the same
  // resolver every other stock-binding consumer already reuses (SetupModal,
  // Viewport, store/index.ts) — before the generic type label.
  const resolvedStockName = consistency.ok && consistency.stockIds.length === 1
    ? stocks?.find((s) => s.id === consistency.stockIds[0])?.name
    : consistency.ok
      ? stocks?.find((s) => s.id === setupProvenStockId(setup, project))?.name
      : undefined
  // Defensive default: WCS.origin is typed non-optional, but a partial/
  // legacy setup (or a test fixture supplying only `label`) can still lack
  // it — fail soft to 0,0,0 rather than crash the whole panel (render-gate).
  const origin = setup.wcs.origin ?? { x: 0, y: 0, z: 0 }
  const originBinding = setup.wcs.originBinding
  // A missing unified binding can still be a legacy stock-corner or vertex
  // binding. Never let the inline coordinate fields silently sever either.
  const hasLegacyStockBinding = originBinding == null && setup.wcs.stockId != null
  const hasLegacyVertexBinding = originBinding == null && setup.wcs.snapGeoId != null
  const originIsManual = originBinding?.kind === 'manual'
    || (originBinding == null && !hasLegacyStockBinding && !hasLegacyVertexBinding)
  // Keep this predicate positive/manual-only: a future binding kind must stay
  // read-only until its own safe inline editing semantics are designed.
  const originIsBound = !originIsManual
  const originBindingLabel = originBinding?.kind === 'stock_corner' || hasLegacyStockBinding
    ? tx('PropertiesPanel.stock_corner')
    : tx('PropertiesPanel.model_vertex')

  const commitName = (input: HTMLInputElement) => {
    const nextName = input.value.trim()
    if (!nextName) {
      input.value = setup.name
      return
    }
    input.value = nextName
    if (nextName !== setup.name) updateSetup(setup.id, { name: nextName })
  }

  const commitOriginAxis = (axis: keyof Vec3, value: number) => {
    if (!originIsManual || Math.abs(value - origin[axis]) <= 0.0001) return
    updateSetup(setup.id, {
      wcs: {
        origin: { ...origin, [axis]: value },
        originBinding: { kind: 'manual' },
        stockId: undefined,
        cornerRow: undefined,
        cornerCol: undefined,
        cornerFace: undefined,
        snapGeoId: undefined,
        snapLocalPt: undefined,
      },
    })
  }
  return (
    <div className="props-section">
      {!consistency.ok && consistency.reason && (
        <div className="props-group props-error-msg" data-testid="setup-stock-conflict">
          <div className="props-label">{tx('PropertiesPanel.Stock_conflict')}</div>
          <div className="props-value props-value-error" data-tooltip={consistency.reason}>
            {consistency.reason}
          </div>
        </div>
      )}
      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.Setup_name')}</div>
        <div className="props-value">
          <input
            key={`${setup.id}:${setup.name}`}
            className="props-text-input"
            data-testid="setup-name-input"
            defaultValue={setup.name}
            aria-label={tx('PropertiesPanel.Setup_name')}
            onBlur={(e) => commitName(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.currentTarget.value = setup.name
                e.currentTarget.blur()
              }
            }}
          />
        </div>
      </div>
      <SetupHoldingEditor setup={setup} />
      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.WCS')}</div>
        <div className="props-value">{resolvedWcsLabel}</div>
      </div>
      {originIsBound ? (
        <div className="props-group" style={{ alignItems: 'flex-start' }}>
          <div className="props-label" data-tooltip={tx('PropertiesPanel.WCS_origin_relative_to_the_model')}>{tx('PropertiesPanel.Origin')}</div>
          <div
            className="props-value"
            data-testid="setup-wcs-origin-bound"
            style={{ whiteSpace: 'normal' }}
            data-tooltip={tx('PropertiesPanel.X_Y_Z_Bound_to_Use_Edit_setup_to', { p1: fmtDim(origin.x, displayUnits), p2: fmtDim(origin.y, displayUnits), p3: fmtDim(origin.z, displayUnits), p4: unitLabel(displayUnits), p5: originBindingLabel })}
          >{tx('PropertiesPanel.X_Y_Z', { p1: fmtDim(origin.x, displayUnits, 2), p2: fmtDim(origin.y, displayUnits, 2), p3: fmtDim(origin.z, displayUnits, 2), p4: unitLabel(displayUnits) })}</div>
        </div>
      ) : (
        <div data-testid="setup-wcs-origin-manual">
          {(['x', 'y', 'z'] as const).map((axis) => (
            <div className="props-group" key={axis}>
              <div className="props-label">{tx('PropertiesPanel.Origin_2', { p1: axis.toUpperCase() })}</div>
              <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <NumericInput
                  className="props-number-input"
                  value={origin[axis]}
                  step={1}
                  units={displayUnits}
                  kind="dim"
                  tooltip={tx('PropertiesPanel.WCS_origin_axis_units', { p1: axis.toUpperCase(), p2: unitLabel(displayUnits) })}
                  onChange={(value) => commitOriginAxis(axis, value)}
                />
                <span>{unitLabel(displayUnits)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="props-group">
        <div className="props-label">{tx('PropertiesPanel.Stock')}</div>
        <div className="props-value" data-testid="setup-stock-name">
          {resolvedStockName ?? setup.stock.type}
        </div>
      </div>

      {/* Edit reuses the SAME openEditSetup the tree's Settings2 button calls
          (DesignTree.tsx:3601). A selected setup previously had zero action
          buttons in this panel (recon top finding). */}
      <div className="props-group props-btn-row" data-testid="setup-action-row">
        <button
          type="button"
          className="props-btn"
          data-testid="setup-edit-btn"
          onClick={() => openEditSetup(setup.id)}
          data-tooltip={tx('PropertiesPanel.Edit_setup')}
        >
          <Settings2 size={12} />{tx('PropertiesPanel.Edit')}</button>
      </div>
    </div>
  )
}

// ---- P12 quick-edit helpers ----
// The effective cutting feed / plunge for an op. An enabled feedrateOverride
// is authoritative; otherwise the assigned tool's default feeds & speeds is the
// source (same fallback resolveFeedrates uses). Pure + exported so the 2-click
// retrievability claim is unit-testable without a DOM.
export function toolDefaultFeeds(tool: Tool | undefined): { feedRate: number; plungeRate: number } {
  const f = tool?.feedsAndSpeeds?.['default']
    ?? (tool?.feedsAndSpeeds ? Object.values(tool.feedsAndSpeeds)[0] : undefined)
  return { feedRate: f?.feedRate ?? 1000, plungeRate: f?.plungeRate ?? 300 }
}

export function resolveOpFeeds(
  op: Operation, tool: Tool | undefined,
): { feedRate: number; plungeRate: number } {
  const fo = op.feedrateOverride
  if (fo?.enabled) return { feedRate: fo.feedRate, plungeRate: fo.plungeRate }
  return toolDefaultFeeds(tool)
}

// Build the feedrateOverride to PERSIST when the user edits Feed or Plunge in
// the quick-edit card. Starts from the existing override (or a tool-seeded one),
// flips enabled true, and patches the one field — so a card edit never silently
// resets the other lead/ramp/finish feeds.
// WO-1642: the seed is the modal's own `defaultFeedrateOverride`, fed the
// project's machine - one seed, so the card and the modal cannot disagree.
export function patchFeedOverride(
  op: Operation, tool: Tool | undefined, field: 'feedRate' | 'plungeRate', value: number,
  machine?: FeedSeedMachine,
): FeedrateOverride {
  const base = op.feedrateOverride ?? defaultFeedrateOverride(tool, machine)
  return { ...base, enabled: true, [field]: value }
}

// P12 quick-edit card — pinned at the TOP of operation properties. Carries the
// 2 most-common edits (tool + feeds) so neither needs the 7-tab modal:
//  - current tool name + a "change" button that expands the SAME library list
//    the op modal uses (op-tool-row), committing on click -> tool change <= 2 clicks
//  - Feed + Plunge NumericInputs committing on blur/Enter -> feed change <= 2 clicks
// The single Regenerate stays in the Phase-5 sticky bottom row (no duplicate).
// Which tools are physically sane for each operation type, checked against what
// each engine actually accepts (see the audit on this WO: a tool-list grouping
// disagreed with the engines - it hid the flat/bull-nose end mills bore2d.ts
// requires and offered drills bore2d.ts refuses). Every OperationType is listed
// so nothing silently falls through to "show everything" - BUG-507 was exactly
// that: a Pocket quick-picker offering a drill, which cuts sideways at milling
// feed instead of drilling. `null` means the engine itself takes a broad set
// (engrave2d only uses the tip angle when the tool happens to have one), so the
// picker stays unfiltered rather than inventing a restriction the engine doesn't
// have.
function isMillingTool(t: Tool): boolean {
  return toolTypeMeta(t.type).group === 'milling'
}
// bore2d.ts:65-67,252 - the bore engine accepts only these two types and throws
// for everything else, including the rest of the 'holemaking' group.
function isBoreEligibleTool(t: Tool): boolean {
  return t.type === 'flat_end_mill' || t.type === 'bull_nose'
}
// drill2d.ts's buildDrillToolpath has no tool-type check at all, and the New
// Operation dialog offers end mills for Drill - plunging a hole with a
// centre-cutting flat or bull-nose end mill is ordinary practice, so the
// holemaking group alone is too narrow here (unlike bore, which the engine
// itself restricts).
function isDrillEligibleTool(t: Tool): boolean {
  return toolTypeMeta(t.type).group === 'holemaking' || isBoreEligibleTool(t)
}
// vcarve2d/index.ts:55-61 and chamfer2d.ts:77-83 both require angleFromAxisDeg
// on the tool and accept any tool type that carries one (V-bit, chamfer mill,
// countersink, spot drill, ...) - toolTypeMeta.hasAngle is that same fact.
function hasTipAngle(t: Tool): boolean {
  return toolTypeMeta(t.type).hasAngle
}

const TOOL_ELIGIBILITY_FOR_OP_TYPE: Record<Operation['type'], ((t: Tool) => boolean) | null> = {
  face: isMillingTool,
  contour_2d: isMillingTool,
  pocket_2d: isMillingTool,
  adaptive_clearing_2d: isMillingTool,
  drill: isDrillEligibleTool,
  bore: isBoreEligibleTool,
  thread_mill: (t) => toolTypeMeta(t.type).group === 'threading',
  engrave: null,
  vcarve: hasTipAngle,
  chamfer: hasTipAngle,
  // WO-3001: the pattern footprint is measured for ball, bull, flat and pointed
  // cutters (pattern2d/envelope.ts footprintHalfWidth), so a V-bit or any other
  // tool with a tip angle is offered beside the milling group.
  pattern: (t) => isMillingTool(t) || hasTipAngle(t),
  parallel_3d: isMillingTool,
  waterline_3d: isMillingTool,
  adaptive_3d: isMillingTool,
  scallop_3d: isMillingTool,
  steep_shallow_3d: isMillingTool,
  pencil_3d: isMillingTool,
}

function toolsEligibleForOpType(toolLibrary: Tool[], opType: Operation['type']): Tool[] {
  const predicate = TOOL_ELIGIBILITY_FOR_OP_TYPE[opType]
  return predicate ? toolLibrary.filter(predicate) : toolLibrary
}

function QuickEditCard({ op }: { op: Operation }) {
  useText('cam-operations-new-operation')
  const setupId = useCamStore((s) => s.project.activeSetupId)
  const toolLibrary = useCamStore((s) => s.toolLibrary)
  const updateOperation = useCamStore((s) => s.updateOperation)
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const [pickerOpen, setPickerOpen] = useState(false)

  const tool = toolLibrary.find((t) => t.id === op.toolId)
  const feeds = resolveOpFeeds(op, tool)
  const eligibleTools = toolsEligibleForOpType(toolLibrary, op.type)

  const chooseTool = (toolId: string) => {
    // Mark stale exactly like every other parameter edit in this panel (see
    // the STALE constant below): a new tool means the previous toolpath's
    // moves no longer match what the operator asked for.
    if (setupId) updateOperation(setupId, op.id, {
      toolId,
      status: 'pending',
      toolpathMoves: undefined,
      computeTimeMs: undefined,
      estimatedCutTimeMs: undefined,
      estimatedCutTimeMsError: undefined,
      errorMessage: undefined,
      diagnostics: undefined,
      resolvedHeights: undefined,
      resolvedHeightPlan: undefined,
      generationFingerprint: undefined,
    })
    setPickerOpen(false)
  }
  const setFeed = (field: 'feedRate' | 'plungeRate', value: number) => {
    if (setupId) updateOperation(setupId, op.id, {
      feedrateOverride: patchFeedOverride(op, tool, field, value, useCamStore.getState().project.machine),
    })
  }

  return (
    <div className="props-quickedit" data-testid="props-quickedit">
      <div className="props-quickedit-title">
        <Wrench size={11} />{tx('PropertiesPanel.Tool_Feeds')}</div>

      <div className="props-quickedit-tool">
        <span className="props-quickedit-toolname" data-tooltip={tool?.name ?? tx('PropertiesPanel.No_tool_assigned')}>
          {tool?.name ?? tx('PropertiesPanel.No_tool_assigned')}
        </span>
        <button
          type="button"
          className="props-quickedit-change"
          data-testid="quickedit-change-tool"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((v) => !v)}
        >
          {pickerOpen ? tx('PropertiesPanel.Census_close') : tx('PropertiesPanel.Census_change')}
        </button>
      </div>

      {pickerOpen && (
        toolLibrary.length === 0 ? (
          <div className="props-quickedit-empty">{tx('PropertiesPanel.No_tools_in_library_open_the_Tool_Library_from')}</div>
        ) : eligibleTools.length === 0 ? (
          <div className="props-quickedit-empty">{tx('PropertiesPanel.No_tools_in_the_library_match_this_operation_type')}</div>
        ) : (
          <div className="props-quickedit-toollist" data-testid="quickedit-tool-list">
            {eligibleTools.map((t) => (
              <div
                key={t.id}
                className={`op-tool-row${op.toolId === t.id ? ' op-tool-row-active' : ''}`}
                data-testid={`quickedit-tool-${t.id}`}
                onClick={() => chooseTool(t.id)}
              >
                <div className="op-tool-info">
                  <span className="op-tool-name">{t.name}</span>
                  <span className="op-tool-meta">
                    {'⌀'}{t.diameter !== undefined ? fmtDim(t.diameter, displayUnits) : '?'} {unitLabel(displayUnits)} &nbsp;{'·'}&nbsp; {(t.type ?? '').replace(/_/g, ' ')}
                  </span>
                </div>
                {op.toolId === t.id && (
                  <CheckCircle2 size={14} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />
                )}
              </div>
            ))}
          </div>
        )
      )}

      <div className="props-quickedit-feed" data-engrave-vcarve-field="cutFeed">
        <span className="props-quickedit-flabel">{tx('PropertiesPanel.Feed')}</span>
        <NumericInput
          className="props-quickedit-input"
          value={feeds.feedRate}
          min={1}
          step={50}
          units={displayUnits}
          kind="feed"
          tooltip={tx('PropertiesPanel.Cutting_feed_rate_override', { p1: feedLabel(displayUnits) })}
          onChange={(v) => setFeed('feedRate', v)}
        />
        <span className="props-quickedit-unit">{feedLabel(displayUnits)}</span>
      </div>
      <div className="props-quickedit-feed" data-engrave-vcarve-field="plunge">
        <span className="props-quickedit-flabel">{tx('PropertiesPanel.Plunge')}</span>
        <NumericInput
          className="props-quickedit-input"
          value={feeds.plungeRate}
          min={1}
          step={25}
          units={displayUnits}
          kind="feed"
          tooltip={tx('PropertiesPanel.Plunge_feed_rate_override', { p1: feedLabel(displayUnits) })}
          onChange={(v) => setFeed('plungeRate', v)}
        />
        <span className="props-quickedit-unit">{feedLabel(displayUnits)}</span>
      </div>
    </div>
  )
}

// ---- Operation properties ----
function OperationProperties({ op }: { op: ReturnType<typeof useCamStore.getState>['project']['setups'][0]['operations'][0] }) {
  useText('cam-operations-new-operation')
  const camHints = useCamShortcutHints()
  const activeSetupId = useCamStore((s) => s.project.activeSetupId)
  const project = useCamStore((s) => s.project)
  const ownerSetup = project.setups.find((s) => s.id === activeSetupId)
  const resolveIntentReferenceWcsZ = (reference: Exclude<HeightReference, 'clearance' | 'retract' | 'feed' | 'top' | 'bottom'>): number | undefined => {
    if (!ownerSetup) return undefined
    const params = op.params as {
      geometryId?: string
      loopIds?: string[]
      referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number }
    }
    const geometryId = params.geometryId ?? ''
    const loopIds = params.loopIds ?? []
    if (reference === 'selected_feature_top' || reference === 'selected_feature_bottom') {
      if (op.heights.selectedFaceZ === undefined || !geometryId || geometryId === '__all__') return undefined
      const geometry = project.geometry.find((candidate) => candidate.id === geometryId)
      if (!geometry) return undefined
      return resolveGeometryZToFramesModelAwareSafe(
        op.heights.selectedFaceZ, geometry, ownerSetup,
        project.geometry, project.sceneStock, project.stocks ?? [],
        project.modelItemPlacements ?? [],
      ).wcsZ
    }
    if (reference === 'model_bottom') {
      if (!geometryId || (geometryId !== '__all__' && !project.geometry.some((candidate) => candidate.id === geometryId))) return undefined
      try {
        return resolveModelBottomZ(project.geometry, geometryId, ownerSetup.wcs.origin.z, project.stocks ?? [], loopIds)
      } catch (err) {
        if (err instanceof OwningStockError || err instanceof ModelOriginComputeError) return undefined
        throw err
      }
    }
    const uiReference = uiReferenceForIntentReference(reference)
    if (!uiReference) return undefined
    if ((uiReference === 'stock_top' || uiReference === 'stock_bottom')
        && (project.stocks?.length ?? 0) === 0) return undefined
    if ((uiReference === 'geometry_face' || uiReference === 'model_top')
        && (!geometryId || (geometryId !== '__all__' && !project.geometry.some((candidate) => candidate.id === geometryId)))) return undefined
    if (uiReference === 'picked_plane' && !params.referencePlaneGeo) return undefined
    try {
      return resolveTopZ(
        uiReference, 0, ownerSetup, project.sceneStock, project.geometry,
        geometryId, project.stocks, loopIds, params.referencePlaneGeo,
        project.modelItemPlacements ?? [],
      )
    } catch (err) {
      if (err instanceof OwningStockError || err instanceof ReferencePlaneError
          || err instanceof ModelOriginComputeError) return undefined
      throw err
    }
  }
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const computeOperationToolpath = useCamStore((s) => s.computeOperationToolpath)
  const cancelParallel3dCompute = useCamStore((s) => s.cancelParallel3dCompute)
  const cancelAdaptive3dCompute = useCamStore((s) => s.cancelAdaptive3dCompute)
  const cancelWaterline3dCompute = useCamStore((s) => s.cancelWaterline3dCompute)
  const previewOperationSmartHeightPlan = useCamStore((s) => s.previewOperationSmartHeightPlan)
  const openEditOperation = useCamStore((s) => s.openEditOperation)
  const updateOperation = useCamStore((s) => s.updateOperation)
  const pushHistory = useCamStore((s) => s.pushHistory)
  const toolLibrary = useCamStore((s) => s.toolLibrary)
  const duplicateOperation = useCamStore((s) => s.duplicateOperation)
  const removeOperation = useCamStore((s) => s.removeOperation)
  const [datumPickActive, setDatumPickActive] = useState(false)
  const [datumPickError, setDatumPickError] = useState<string | null>(null)
  // WO-1223: is the viewport currently arming face picks for THIS operation's
  // face scope? (One session at a time; leaving the op disarms it below.)
  const [faceScopePickActive, setFaceScopePickActive] = useState(false)
  const [liveHeightPlanResult, setLiveHeightPlanResult] = useState<{
    key: string
    result: { ok: true; plan: ResolvedHeightPlanV2 } | { ok: false; message: string }
  }>()
  const datumPickGenerationRef = useRef(0)
  // Contour tab placement (Tabs v2): whether the viewport edit mode is active.
  const [tabEditActive, setTabEditActive] = useState(false)
  // WO-3220: the suggestion under review (nothing is written until Apply) and
  // the one line the last Suggest/Apply produced.
  const [tabSuggestion, setTabSuggestion] = useState<ContourTabSuggestion | null>(null)
  const [tabSuggestNote, setTabSuggestNote] = useState<string | null>(null)
  // WO-3221: Create tab removal contour - the review under way (every tab
  // starts selected), the remaining-stock line and the last one-line outcome.
  const [tabRemovalReview, setTabRemovalReview] = useState<{
    targets: ContourTabRemovalTarget[]; loopIds: string[]; holdingMethod?: string; notes: string; selected: string[]
  } | null>(null)
  const [tabRemovalMaterial, setTabRemovalMaterial] = useState<ContourTabRemovalMaterial | 'reading' | null>(null)
  const [tabRemovalNote, setTabRemovalNote] = useState<string | null>(null)
  // Switching ops / unmounting always leaves the viewport tab-edit mode (a
  // no-op when it was never entered).
  useEffect(() => {
    setTabEditActive(false)
    setTabSuggestion(null)
    setTabSuggestNote(null)
    setTabRemovalReview(null)
    setTabRemovalMaterial(null)
    setTabRemovalNote(null)
    return () => { getVp()?.exitContourTabEditMode?.(false) }
  }, [op.id])
  const regenerate = () => { if (activeSetupId) computeOperationToolpath(activeSetupId, op.id) }
  const currentOperationSafetyIntent = () => {
    const base = op.heights.heightIntent ?? (ownerSetup
      ? setupDefaultHeightIntent(ownerSetup)
      : undefined)
    return base
      ? operationSafetyHeightIntent(base, operationSafetyUserOverridePlanes(op))
      : undefined
  }
  // ---- WO-1223: which faces this finishing pass is aimed at ---------------
  //
  // The scope lives in op.params.faceScope (Cam3dFaceScope) and defaults to
  // ABSENT, which is the whole part. Face ids are BRep subshape indices -- the
  // very numbers the viewport face picker reports -- so picking a face here and
  // the containment the planner applies cannot disagree.
  const faceScopeSourceGeo = op.geometrySelections[0]
    ? project.geometry.find((g) => g.id === op.geometrySelections[0])
    : undefined
  // Only a STEP solid carries BRep faces. An STL is a triangle soup: the
  // control is disabled and reads "All faces", and the adapter says the same
  // thing once on the console if a scope somehow reaches it.
  const faceScopeSupported = faceScopeSourceGeo?.format === 'step'
  // Through the SAME one rule the operation form uses (faceScopeForSource): the
  // ids stored on the operation are live only against the solid the operation
  // is actually pointed at, and only while that solid is a STEP part.
  const faceScopeIds = faceScopeForSource(
    { partId: op.geometrySelections[0], faceIds: readFaceScope(op.params) ?? [] },
    { id: op.geometrySelections[0], format: faceScopeSourceGeo?.format },
  )
  const faceScopeSourceLabel = faceScopeSourceGeo?.name ?? tx('PropertiesPanel.the_source_solid')
  const writeFaceScope = (ids: readonly number[]) => {
    if (!activeSetupId) return
    const nextParams = { ...op.params } as Record<string, unknown>
    if (ids.length > 0) nextParams.faceScope = { faceIds: [...new Set(ids)].sort((a, b) => a - b) }
    else delete nextParams.faceScope
    updateOperation(activeSetupId, op.id, {
      params: nextParams,
      status: 'outdated',
      toolpathMoves: undefined,
      computeTimeMs: undefined,
      estimatedCutTimeMs: undefined,
      resolvedHeights: undefined,
      generationFingerprint: undefined,
      errorMessage: undefined,
    })
  }
  const endFaceScopePick = () => {
    const vp = getVp()
    vp?.setBrepPickMode?.(null)
    vp?.setPickedBrepSelections?.([])
    useCamStore.getState().setBrepSelections([])
    useCamStore.getState().endFacePickBodySelection(null, vp)
    setFaceScopePickActive(false)
  }
  const startFaceScopePick = () => {
    const geoId = faceScopeSourceGeo?.id
    const vp = getVp()
    if (!geoId || !faceScopeSupported || !vp?.setBrepPickMode) return
    setFaceScopePickActive(true)
    // Every click toggles one face in or out and rewrites the operation, so what
    // the viewport highlights and what the pass will cut can never drift apart
    // while picking.
    const seed = readFaceScope(useCamStore.getState().project.setups
      .find((setup) => setup.id === activeSetupId)?.operations
      .find((candidate) => candidate.id === op.id)?.params ?? {}) ?? []
    const picked = new Set<number>(seed)
    const syncHighlight = () => {
      const sels = [...picked].sort((a, b) => a - b)
        .map((index) => ({ geoId, kind: 'face' as const, index }))
      useCamStore.getState().setBrepSelections(sels)
      vp.setPickedBrepSelections?.(sels)
    }
    useCamStore.getState().beginFacePickBodySelection(vp)
    syncHighlight()
    vp.setBrepPickMode('face', (selection) => {
      if (selection.geoId !== geoId) return
      if (picked.has(selection.index)) picked.delete(selection.index)
      else picked.add(selection.index)
      syncHighlight()
      writeFaceScope([...picked])
    }, geoId)
  }
  // Leaving the operation (or unmounting the panel) always disarms the picker.
  useEffect(() => () => {
    getVp()?.setBrepPickMode?.(null)
    useCamStore.getState().endFacePickBodySelection(null, getVp())
  }, [op.id])
  // The panel column is narrow (every neighbouring row already ellipsises), so
  // a short list reads as the face ids themselves and a long one as a count.
  // Either way it FITS beside the buttons instead of being cut off mid-number;
  // the full list is always in the tooltip.
  const faceScopeReading = faceScopeIds.length === 0
    ? tx('PropertiesPanel.All_faces')
    : faceScopeIds.length <= 3
      ? faceScopeIds.join(', ')
      : tx('PropertiesPanel.Census_faces', { p1: faceScopeIds.length })
  const faceScopeRow = (
    <div className="props-group" data-testid="props-face-scope">
      <div className="props-label">{tx('PropertiesPanel.Faces')}</div>
      {/* The reading gives up width first (ellipsis + the full list in its
          tooltip); the buttons never shrink, so a long face list can never
          push Pick or the clear X off the panel edge. */}
      <div
        className="props-value"
        style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, minWidth: 0 }}
      >
        <span
          data-testid="props-face-scope-reading"
          style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          data-tooltip={!faceScopeSupported
            ? tx('PropertiesPanel.is_a_mesh_with_no_BRep_faces_so_this', { p1: faceScopeSourceLabel })
            : faceScopeIds.length === 0
              ? tx('PropertiesPanel.This_finishing_pass_may_cut_the_whole_part')
              : tx('PropertiesPanel.This_finishing_pass_may_cut_face_only', { p1: faceScopeIds.length === 1 ? '' : tx('PropertiesPanel.s'), p2: faceScopeIds.join(', ') })}
        >
          {faceScopeReading}
        </span>
        <button
          type="button"
          className="props-btn"
          // .props-btn is width:100% by default (it is normally a full-width
          // row action); here it sits inline beside the reading and must size
          // to its own label instead of eating the whole column.
          style={{ flex: '0 0 auto', width: 'auto', padding: '4px 10px' }}
          data-testid="props-face-scope-pick-btn"
          disabled={!faceScopeSupported}
          onClick={faceScopePickActive ? endFaceScopePick : startFaceScopePick}
          data-tooltip={faceScopePickActive
            ? tx('PropertiesPanel.Stop_picking_faces_in_the_viewport')
            : tx('PropertiesPanel.Click_faces_on_the_part_in_the_viewport_to')}
        >
          <MousePointer2 size={12} /> {faceScopePickActive ? tx('PropertiesPanel.Done') : tx('PropertiesPanel.Pick')}
        </button>
        {faceScopeIds.length > 0 && (
          <button
            type="button"
            className="props-icon-btn"
            style={{ flexShrink: 0 }}
            data-testid="props-face-scope-clear-btn"
            onClick={() => { if (faceScopePickActive) endFaceScopePick(); writeFaceScope([]) }}
            data-tooltip={tx('PropertiesPanel.Machine_the_whole_part')}
            aria-label={tx('PropertiesPanel.Machine_the_whole_part')}
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  )

  // parallel_3d live param edit: merge into op.params and mark the op outdated so
  // the sticky Regenerate button lights up (same recompute gate as other ops).
  const p3dParams = { ...DEFAULT_PARALLEL3D_PARAMS, ...(op.params as Partial<Parallel3dParams>) }
  const setP3d = (patch: Partial<Parallel3dParams>) => {
    if (!activeSetupId) return
    const nextParams = { ...p3dParams, ...patch }
    const editsFinishDepth = Object.prototype.hasOwnProperty.call(patch, 'finishDepth')
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...(editsFinishDepth && ownerSetup ? {
        smartHeight: {
          kind: 'smart_v2' as const,
          intent: buildParallel3dSmartIntent({
            setupId: ownerSetup.id,
            geometryIds: op.geometrySelections,
            safetyIntent: currentOperationSafetyIntent() ?? setupDefaultHeightIntent(ownerSetup),
            finishDepthMm: nextParams.finishDepth,
          }),
        },
      } : {}),
      status: 'outdated',
      toolpathMoves: undefined,
      computeTimeMs: undefined,
      estimatedCutTimeMs: undefined,
      resolvedHeights: undefined,
      generationFingerprint: undefined,
      errorMessage: undefined,
    })
  }
  // waterline_3d live param edit (WO-1176): same merge-into-params + mark-outdated
  // recompute gate as parallel_3d above; a finish-depth edit re-authors the
  // Smart Height authority under the waterline policy.
  const w3dParams = { ...DEFAULT_WATERLINE_PARAMS, ...(op.params as Partial<WaterlineParams>) }
  const setW3d = (patch: Partial<WaterlineParams>) => {
    if (!activeSetupId) return
    const nextParams = { ...w3dParams, ...patch }
    const editsFinishDepth = Object.prototype.hasOwnProperty.call(patch, 'finishDepth')
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...(editsFinishDepth && ownerSetup ? {
        smartHeight: {
          kind: 'smart_v2' as const,
          intent: buildWaterline3dSmartIntent({
            setupId: ownerSetup.id,
            geometryIds: op.geometrySelections,
            safetyIntent: currentOperationSafetyIntent() ?? setupDefaultHeightIntent(ownerSetup),
            finishDepthMm: nextParams.finishDepth,
          }),
        },
      } : {}),
      status: 'outdated',
      toolpathMoves: undefined,
      computeTimeMs: undefined,
      estimatedCutTimeMs: undefined,
      resolvedHeights: undefined,
      generationFingerprint: undefined,
      errorMessage: undefined,
    })
  }
  const ss3dParams = {
    ...DEFAULT_STEEP_SHALLOW3D_PARAMS,
    ...(op.params as Partial<SteepShallow3dParams>),
  }
  const setSs3d = (patch: Partial<SteepShallow3dParams>) => {
    if (!activeSetupId) return
    const nextParams = { ...ss3dParams, ...patch }
    const editsFinishDepth = Object.prototype.hasOwnProperty.call(patch, 'finishDepth')
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...(editsFinishDepth && ownerSetup ? {
        smartHeight: {
          kind: 'smart_v2' as const,
          intent: buildSteepShallow3dSmartIntent({
            setupId: ownerSetup.id,
            geometryIds: op.geometrySelections,
            safetyIntent: currentOperationSafetyIntent() ?? setupDefaultHeightIntent(ownerSetup),
            finishDepthMm: nextParams.finishDepth,
          }),
        },
      } : {}),
      status: 'outdated',
      toolpathMoves: undefined,
      computeTimeMs: undefined,
      estimatedCutTimeMs: undefined,
      resolvedHeights: undefined,
      generationFingerprint: undefined,
      errorMessage: undefined,
    })
  }
  const scallop3dParams = { ...DEFAULT_SCALLOP3D_PARAMS, ...(op.params as Partial<Scallop3dParams>) }
  const setScallop3d = (patch: Partial<Scallop3dParams>) => {
    if (!activeSetupId) return
    const nextParams = { ...scallop3dParams, ...patch }
    const editsFinishDepth = Object.prototype.hasOwnProperty.call(patch, 'finishDepth')
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...(editsFinishDepth && ownerSetup ? {
        smartHeight: {
          kind: 'smart_v2' as const,
          intent: buildScallop3dSmartIntent({
            setupId: ownerSetup.id,
            geometryIds: op.geometrySelections,
            safetyIntent: currentOperationSafetyIntent() ?? setupDefaultHeightIntent(ownerSetup),
            finishDepthMm: nextParams.finishDepth,
          }),
        },
      } : {}),
      status: 'outdated',
      toolpathMoves: undefined,
      computeTimeMs: undefined,
      estimatedCutTimeMs: undefined,
      resolvedHeights: undefined,
      generationFingerprint: undefined,
      errorMessage: undefined,
    })
  }
  const pencil3dParams = { ...DEFAULT_PENCIL3D_PARAMS, ...(op.params as Partial<Pencil3dParams>) }
  const setPencil3d = (patch: Partial<Pencil3dParams>) => {
    if (!activeSetupId) return
    const nextParams = { ...pencil3dParams, ...patch }
    const editsFinishDepth = Object.prototype.hasOwnProperty.call(patch, 'finishDepth')
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...(editsFinishDepth && ownerSetup ? {
        smartHeight: {
          kind: 'smart_v2' as const,
          intent: buildPencil3dSmartIntent({
            setupId: ownerSetup.id,
            geometryIds: op.geometrySelections,
            safetyIntent: currentOperationSafetyIntent() ?? setupDefaultHeightIntent(ownerSetup),
            finishDepthMm: nextParams.finishDepth,
          }),
        },
      } : {}),
      status: 'outdated', toolpathMoves: undefined, computeTimeMs: undefined,
      estimatedCutTimeMs: undefined, resolvedHeights: undefined,
      generationFingerprint: undefined, errorMessage: undefined,
    })
  }
  // adaptive_3d live param edit: same merge-into-params + mark-outdated recompute
  // gate as parallel_3d above.
  const a3dParams = { ...DEFAULT_ADAPTIVE3D_PARAMS, ...(op.params as Partial<Adaptive3dParams>) }
  const setA3d = (patch: Partial<Adaptive3dParams>) => {
    if (!activeSetupId) return
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      status: 'outdated',
      toolpathMoves: undefined,
      computeTimeMs: undefined,
      estimatedCutTimeMs: undefined,
      resolvedHeights: undefined,
      generationFingerprint: undefined,
      errorMessage: undefined,
      diagnostics: undefined,
    })
  }
  const computing = op.status === 'computing'

  // Inline Heights/Passes edits (P1). Every edit marks the op STALE exactly like
  // the operation modal (status:'pending' + cleared toolpath/timings/error) so the
  // sticky Regenerate button below lights up. Commit-on-blur/Enter is the shared
  // NumericInput contract. updateOperation replaces whole keys (shallow op merge),
  // so heights/passes/params are passed as FULL merged objects.
  const STALE = {
    status: 'pending' as const,
    toolpathMoves: undefined,
    computeTimeMs: undefined,
    estimatedCutTimeMs: undefined,
    estimatedCutTimeMsError: undefined,
    errorMessage: undefined,
    diagnostics: undefined,
    resolvedHeights: undefined,
    resolvedHeightPlan: undefined,
    generationFingerprint: undefined,
  }
  const heightSafetyOwnership = smartHeightSafetyOwnership(op)
  const adaptive3dSmartState = op.type === 'adaptive_3d' && op.smartHeight !== undefined
    ? validatePersistedSmartHeightState(op.smartHeight)
    : undefined
  const adaptive3dHeightDraft: Adaptive3dHeightDraft | undefined =
    adaptive3dSmartState?.ok && adaptive3dSmartState.state.kind === 'smart_v2'
      ? adaptive3dHeightDraftFromIntent(adaptive3dSmartState.state.intent)
      : undefined
  const parallel3dSmartPanelState = (() => {
    if (op.type !== 'parallel_3d' && op.type !== 'steep_shallow_3d' && op.type !== 'scallop_3d' && op.type !== 'pencil_3d') return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) return { kind: 'invalid' as const, message: validated.message }
    const intent = validated.state.intent
    if (intent.policy.operationType !== op.type) {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.operation_carries_a_Smart_Height_policy', { p1: op.type, p2: intent.policy.operationType }),
      }
    }
    try {
      const draft: Parallel3dHeightDraft = op.type === 'steep_shallow_3d'
        ? steepShallow3dHeightDraftFromIntent(intent)
        : op.type === 'scallop_3d' ? scallop3dHeightDraftFromIntent(intent)
        : op.type === 'pencil_3d' ? pencil3dHeightDraftFromIntent(intent) : parallel3dHeightDraftFromIntent(intent)
      const scope = intent.machining.scope.value
      if (scope.kind !== 'whole_target' ||
          scope.geometryIds.length !== op.geometrySelections.length ||
          scope.geometryIds.some((id, index) => id !== op.geometrySelections[index])) {
        throw new Error(tx('PropertiesPanel.Parallel_Smart_Height_has_lost_its_exact_target_geometry'))
      }
      return { kind: 'smart_v2' as const, intent, draft }
    } catch (error) {
      return {
        kind: 'invalid' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  const waterline3dSmartPanelState = (() => {
    if (op.type !== 'waterline_3d') return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) return { kind: 'invalid' as const, message: validated.message }
    const intent = validated.state.intent
    if (intent.policy.operationType !== 'waterline_3d') {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.Waterline_operation_carries_a_Smart_Height_policy', { p1: intent.policy.operationType }),
      }
    }
    try {
      const draft: Waterline3dHeightDraft = waterline3dHeightDraftFromIntent(intent)
      const scope = intent.machining.scope.value
      if (scope.kind !== 'whole_target' ||
          scope.geometryIds.length !== op.geometrySelections.length ||
          scope.geometryIds.some((id, index) => id !== op.geometrySelections[index])) {
        throw new Error(tx('PropertiesPanel.Waterline_Smart_Height_has_lost_its_exact_target_geometry'))
      }
      return { kind: 'smart_v2' as const, intent, draft }
    } catch (error) {
      return {
        kind: 'invalid' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  const faceSmartPanelState = (() => {
    if (op.type !== 'face') return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) {
      return { kind: 'invalid' as const, message: validated.message }
    }
    if (validated.state.intent.policy.operationType !== 'face') {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.Face_operation_carries_a_Smart_Height_policy', { p1: validated.state.intent.policy.operationType }),
      }
    }
    try {
      return {
        kind: 'smart_v2' as const,
        intent: validated.state.intent,
        draft: faceSmartHeightDraftFromIntent(validated.state.intent),
      }
    } catch (error) {
      return {
        kind: 'invalid' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  const contourSmartPanelState = (() => {
    if (op.type !== 'contour_2d') return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) return { kind: 'invalid' as const, message: validated.message }
    const intent = validated.state.intent
    if (intent.policy.operationType !== 'contour_2d') {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.Contour_operation_carries_a_Smart_Height_policy', { p1: intent.policy.operationType }),
      }
    }
    try {
      const draft = contourSmartHeightDraftFromIntent(intent)
      const scope = intent.machining.scope.value
      if (draft.mode === 'selected_feature' && scope.kind !== 'selected_features') {
        throw new Error(tx('PropertiesPanel.Contour_selected_feature_policy_has_lost_its_stable_feature'))
      }
      if (draft.mode !== 'selected_feature' && scope.kind !== 'selected_geometry') {
        throw new Error(tx('PropertiesPanel.Contour_policy_has_lost_its_selected_geometry_scope', { p1: draft.mode }))
      }
      return { kind: 'smart_v2' as const, intent, draft }
    } catch (error) {
      return {
        kind: 'invalid' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  const drillBoreOperationType = op.type === 'drill' || op.type === 'bore' ? op.type : undefined
  const isDrillBoreOperation = drillBoreOperationType !== undefined
  const drillBoreSmartPanelState = (() => {
    if (!isDrillBoreOperation) return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) return { kind: 'invalid' as const, message: validated.message }
    const intent = validated.state.intent
    if (intent.policy.operationType !== op.type) {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.operation_carries_a_Smart_Height_policy', { p1: op.type === 'drill' ? tx('PropertiesPanel.Drill') : tx('PropertiesPanel.Bore'), p2: intent.policy.operationType }),
      }
    }
    try {
      const draft: DrillBoreSmartHeightDraft = drillBoreSmartHeightDraftFromIntent(intent, drillBoreOperationType!)
      const scope = intent.machining.scope.value
      if (draft.mode === 'detected_features' && scope.kind !== 'selected_features') {
        throw new Error(tx('PropertiesPanel.detected_feature_policy_has_lost_its_stable_feature_scope', { p1: op.type === 'drill' ? tx('PropertiesPanel.Drill') : tx('PropertiesPanel.Bore') }))
      }
      if (draft.mode === 'explicit_depth' && scope.kind !== 'selected_geometry') {
        throw new Error(tx('PropertiesPanel.explicit_depth_policy_has_lost_its_selected_geometry_scope', { p1: op.type === 'drill' ? tx('PropertiesPanel.Drill') : tx('PropertiesPanel.Bore') }))
      }
      return { kind: 'smart_v2' as const, intent, draft }
    } catch (error) {
      return {
        kind: 'invalid' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  const threadMillSmartPanelState = (() => {
    if (op.type !== 'thread_mill') return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) return { kind: 'invalid' as const, message: validated.message }
    const intent = validated.state.intent
    if (intent.policy.operationType !== 'thread_mill') {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.Thread_Mill_operation_carries_a_Smart_Height_policy', { p1: intent.policy.operationType }),
      }
    }
    try {
      const draft: ThreadMillSmartHeightDraft = threadMillSmartHeightDraftFromIntent(intent)
      return { kind: 'smart_v2' as const, intent, draft }
    } catch (error) {
      return {
        kind: 'invalid' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  const chamferSmartPanelState = (() => {
    if (op.type !== 'chamfer') return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) return { kind: 'invalid' as const, message: validated.message }
    const intent = validated.state.intent
    if (intent.policy.operationType !== 'chamfer') {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.Chamfer_operation_carries_a_Smart_Height_policy', { p1: intent.policy.operationType }),
      }
    }
    try {
      const draft: ChamferSmartHeightDraft = chamferSmartHeightDraftFromIntent(intent)
      return { kind: 'smart_v2' as const, intent, draft }
    } catch (error) {
      return {
        kind: 'invalid' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  const engraveSmartPanelState = (() => {
    if (op.type !== 'engrave') return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) return { kind: 'invalid' as const, message: validated.message }
    const intent = validated.state.intent
    if (intent.policy.operationType !== 'engrave') {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.Engrave_operation_carries_a_Smart_Height_policy', { p1: intent.policy.operationType }),
      }
    }
    try {
      const draft: EngraveSmartHeightDraft = engraveSmartHeightDraftFromIntent(intent)
      if (intent.machining.scope.value.kind !== 'selected_paths') {
        throw new Error(tx('PropertiesPanel.Engrave_Smart_Height_has_lost_its_selected_path_scope'))
      }
      return { kind: 'smart_v2' as const, intent, draft }
    } catch (error) {
      return {
        kind: 'invalid' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  const vcarveSmartPanelState = (() => {
    if (op.type !== 'vcarve') return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) return { kind: 'invalid' as const, message: validated.message }
    const intent = validated.state.intent
    if (intent.policy.operationType !== 'vcarve') {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.V_carve_operation_carries_a_Smart_Height_policy', { p1: intent.policy.operationType }),
      }
    }
    try {
      const draft: VCarveSmartHeightDraft = vcarveSmartHeightDraftFromIntent(intent)
      return { kind: 'smart_v2' as const, intent, draft }
    } catch (error) {
      return {
        kind: 'invalid' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  const isPlanarRoughOperation = op.type === 'pocket_2d' || op.type === 'adaptive_clearing_2d'
  const planarRoughSmartPanelState = (() => {
    if (!isPlanarRoughOperation) return undefined
    if (op.smartHeight === undefined) return { kind: 'invalid' as const, message: SMART_HEIGHT_V2_REPAIR_MESSAGE }
    const validated = validatePersistedSmartHeightState(op.smartHeight)
    if (!validated.ok) {
      return { kind: 'invalid' as const, message: validated.message }
    }
    const intent = validated.state.intent
    if (intent.policy.operationType !== op.type) {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.operation_carries_a_Smart_Height_policy', { p1: op.type === 'pocket_2d' ? tx('PropertiesPanel.Pocket') : tx('PropertiesPanel.Adaptive_clearing'), p2: intent.policy.operationType }),
      }
    }
    if (intent.policy.variant !== 'stock_rough' && intent.policy.variant !== 'geometry_floor' &&
        intent.policy.variant !== 'through_stock' && intent.policy.variant !== 'explicit_depth') {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.Planar_Smart_Height_is_not_an_active_runtime_policy', { p1: intent.policy.variant }),
      }
    }
    const scope = intent.machining.scope.value
    if (intent.machining.start.value.kind !== 'current_material') {
      return {
        kind: 'invalid' as const,
        get message() { return tx('PropertiesPanel.Planar_rough_Smart_Height_has_lost_its_current_material') },
      }
    }
    if (intent.policy.variant === 'stock_rough') {
      if (scope.kind !== 'stock_footprint' || intent.machining.end.value.kind !== 'target_surface') {
        return {
          kind: 'invalid' as const,
          get message() { return tx('PropertiesPanel.Planar_stock_rough_Smart_Height_has_an_invalid_target') },
        }
      }
      return {
        kind: 'smart_v2' as const,
        variant: 'stock_rough' as const,
        intent,
        stockId: scope.stockId,
      }
    }
    if (scope.kind !== 'selected_geometry' || scope.geometryIds.length !== 1) {
      return {
        kind: 'invalid' as const,
        message: tx('PropertiesPanel.Planar_Smart_Height_requires_one_selected_geometry', { p1: intent.policy.variant }),
      }
    }
    const end = intent.machining.end.value
    if (intent.policy.variant === 'geometry_floor' && end.kind !== 'selected_plane') {
      return {
        kind: 'invalid' as const,
        get message() { return tx('PropertiesPanel.Planar_geometry_floor_Smart_Height_requires_the_selected_physical') },
      }
    }
    if (intent.policy.variant === 'through_stock' && end.kind !== 'through_stock') {
      return {
        kind: 'invalid' as const,
        get message() { return tx('PropertiesPanel.Planar_through_stock_Smart_Height_has_lost_its_breakthrough') },
      }
    }
    if (intent.policy.variant === 'explicit_depth' &&
        (end.kind !== 'bounded_plane' || end.plane.reference !== 'wcs_plane')) {
      return {
        kind: 'invalid' as const,
        get message() { return tx('PropertiesPanel.Planar_explicit_depth_Smart_Height_requires_one_exact_WCS') },
      }
    }
    return {
      kind: 'smart_v2' as const,
      variant: intent.policy.variant,
      intent,
      geometryIds: scope.geometryIds,
      throughAllowanceMm: end.kind === 'through_stock' ? end.allowanceMm : undefined,
      explicitTargetWcsMm: end.kind === 'bounded_plane' ? end.plane.offsetMm : undefined,
    }
  })()
  // WO-1612: a Top that follows the material earlier operations left (WO-1609)
  // depends on every operation before this one in the setup, not just this
  // operation's own fields - computing, editing, disabling, reordering or
  // deleting an earlier operation must refresh this row.
  const earlierOperationsKey = (() => {
    if (!ownerSetup) return undefined
    const index = ownerSetup.operations.findIndex(candidate => candidate.id === op.id)
    if (index <= 0) return []
    return ownerSetup.operations.slice(0, index).map(candidate => ({
      id: candidate.id,
      enabled: candidate.enabled,
      status: candidate.status,
      generationFingerprint: candidate.generationFingerprint,
    }))
  })()
  const liveHeightPlanKey = activeSetupId && op.smartHeight
    ? JSON.stringify({
        setupId: activeSetupId,
        operationId: op.id,
        type: op.type,
        smartHeight: op.smartHeight,
        geometrySelections: op.geometrySelections,
        toolId: op.toolId,
        params: op.params,
        passes: op.passes,
        earlierOperations: earlierOperationsKey,
      })
    : undefined
  useEffect(() => {
    if (!activeSetupId || !liveHeightPlanKey) {
      setLiveHeightPlanResult(undefined)
      return
    }
    let cancelled = false
    void previewOperationSmartHeightPlan(activeSetupId, op).then(
      plan => {
        if (!cancelled) setLiveHeightPlanResult({
          key: liveHeightPlanKey,
          result: { ok: true, plan },
        })
      },
      error => {
        if (!cancelled) setLiveHeightPlanResult({
          key: liveHeightPlanKey,
          result: { ok: false, message: error instanceof Error ? error.message : String(error) },
        })
      },
    )
    return () => { cancelled = true }
  }, [activeSetupId, liveHeightPlanKey, op, previewOperationSmartHeightPlan])
  const liveHeightPlan = liveHeightPlanKey !== undefined && liveHeightPlanResult?.key === liveHeightPlanKey
    ? liveHeightPlanResult.result
    : undefined
  const validatedSmartHeight = op.smartHeight === undefined
    ? undefined
    : validatePersistedSmartHeightState(op.smartHeight)
  // Same boundary compute enforces (ensureOperationSmartHeightAuthority): an
  // envelope authored for another family is not this operation's authority,
  // so the panel shows 'Repair required' instead of editing the wrong intent.
  const smartHeightIntent = validatedSmartHeight?.ok && validatedSmartHeight.state.kind === 'smart_v2'
    && validatedSmartHeight.state.intent.policy.operationType === op.type
    ? validatedSmartHeight.state.intent
    : undefined
  // Version-gate the persisted plan exactly the way generationFingerprint.ts
  // does (`resolvedHeightPlan?.version === 2`): a malformed-but-present value
  // from a loaded file (`{}`, a number, a string) must read as "no plan", not
  // throw at `resolvedHeightPlan?.machining.cutterCenterEnd` on first render
  // (CAM-12 census, same class as the resolvedHeights topZAbs fix).
  const resolvedHeightPlan = liveHeightPlan === undefined
    ? (op.resolvedHeightPlan?.version === 2 ? op.resolvedHeightPlan : undefined)
    : liveHeightPlan.ok ? liveHeightPlan.plan : undefined

  /** Rebuild only the editable Face fields while retaining the persisted
   * machining scope. Safety edits must not silently rebind an operation to a
   * newly inferred stock or geometry target. Runtime preflight remains
   * responsible for refusing stale bindings. */
  const buildFaceSmartHeightAuthority = (
    safetyIntent: NonNullable<HeightParams['heightIntent']>,
    draft: FaceSmartHeightDraft,
  ) => {
    if (!ownerSetup || faceSmartPanelState?.kind !== 'smart_v2') return undefined
    const scope = faceSmartPanelState.intent.machining.scope.value
    if (draft.mode === 'target_face' && scope.kind !== 'selected_geometry') {
      throw new Error(tx('PropertiesPanel.Face_target_face_policy_has_lost_its_selected_geometry'))
    }
    if (draft.mode !== 'target_face' && scope.kind !== 'stock_footprint') {
      throw new Error(tx('PropertiesPanel.Face_explicit_depth_policy_has_lost_its_owning_stock'))
    }
    return {
      kind: 'smart_v2' as const,
      intent: buildFaceSmartHeightIntent({
        setupId: ownerSetup.id,
        safetyIntent,
        mode: draft.mode,
        geometryIds: draft.mode === 'target_face' && scope.kind === 'selected_geometry'
          ? scope.geometryIds
          : undefined,
        stockId: draft.mode !== 'target_face' && scope.kind === 'stock_footprint'
          ? scope.stockId
          : undefined,
        explicitTargetWcsMm: draft.mode === 'explicit_depth'
          ? draft.explicitTargetWcsMm
          : undefined,
      }),
    }
  }
  /** Rebuild only Contour safety planes while preserving the exact persisted
   * feature or geometry scope and endpoint policy. */
  const buildContourSmartHeightAuthority = (
    safetyIntent: NonNullable<HeightParams['heightIntent']>,
    draft: ContourSmartHeightDraft,
  ) => {
    if (!ownerSetup || contourSmartPanelState?.kind !== 'smart_v2') return undefined
    const scope = contourSmartPanelState.intent.machining.scope.value
    return {
      kind: 'smart_v2' as const,
      intent: buildContourSmartHeightIntent({
        setupId: ownerSetup.id,
        safetyIntent,
        mode: draft.mode,
        features: draft.mode === 'selected_feature' && scope.kind === 'selected_features'
          ? scope.features
          : undefined,
        geometryIds: draft.mode !== 'selected_feature' && scope.kind === 'selected_geometry'
          ? scope.geometryIds
          : undefined,
        explicitTargetWcsMm: draft.mode === 'explicit_depth'
          ? draft.explicitTargetWcsMm
          : undefined,
        throughAllowanceMm: draft.mode === 'through_stock'
          ? draft.throughAllowanceMm
          : undefined,
      }),
    }
  }
  /** Preserve the exact stock or selected-geometry endpoint while rebuilding
   * only Setup-owned safety planes. */
  const buildPlanarRoughSmartHeightAuthority = (
    safetyIntent: NonNullable<HeightParams['heightIntent']>,
  ) => {
    if (!ownerSetup ||
        (op.type !== 'pocket_2d' && op.type !== 'adaptive_clearing_2d') ||
        planarRoughSmartPanelState?.kind !== 'smart_v2') {
      return undefined
    }
    return {
      kind: 'smart_v2' as const,
      intent: buildPlanarRoughSmartHeightIntent({
        setupId: ownerSetup.id,
        operationType: op.type,
        safetyIntent,
        mode: planarRoughSmartPanelState.variant,
        stockId: planarRoughSmartPanelState.variant === 'stock_rough'
          ? planarRoughSmartPanelState.stockId
          : undefined,
        geometryIds: planarRoughSmartPanelState.variant !== 'stock_rough'
          ? planarRoughSmartPanelState.geometryIds
          : undefined,
        throughAllowanceMm: planarRoughSmartPanelState.variant === 'through_stock'
          ? planarRoughSmartPanelState.throughAllowanceMm
          : undefined,
        explicitTargetWcsMm: planarRoughSmartPanelState.variant === 'explicit_depth'
          ? planarRoughSmartPanelState.explicitTargetWcsMm
          : undefined,
      }),
    }
  }
  /** Safety edits never rebind Drill/Bore topology. The stable detected-feature
   * scope and any exact per-feature endpoints remain persisted unchanged. */
  const buildDrillBoreSmartHeightAuthority = (
    safetyIntent: NonNullable<HeightParams['heightIntent']>,
  ) => {
    if (!ownerSetup || !drillBoreOperationType || drillBoreSmartPanelState?.kind !== 'smart_v2') {
      return undefined
    }
    return {
      kind: 'smart_v2' as const,
      intent: rebuildDrillBoreSmartHeightSafetyIntent({
        intent: drillBoreSmartPanelState.intent,
        operationType: drillBoreOperationType,
        setupId: ownerSetup.id,
        safetyIntent,
      }),
    }
  }
  /** Safety edits never reconstruct Thread Mill feature or datum authority from
   * mutable legacy params. The persisted semantic band remains the sole owner. */
  const buildThreadMillSmartHeightAuthority = (
    safetyIntent: NonNullable<HeightParams['heightIntent']>,
  ) => {
    if (!ownerSetup || threadMillSmartPanelState?.kind !== 'smart_v2') return undefined
    return {
      kind: 'smart_v2' as const,
      intent: rebuildThreadMillSmartHeightSafetyIntent({
        intent: threadMillSmartPanelState.intent,
        setupId: ownerSetup.id,
        safetyIntent,
      }),
    }
  }
  /** Safety edits preserve the selected Chamfer edges and the complete
   * width/tip/datum formula. Only Setup-owned approach planes are replaced. */
  const buildChamferSmartHeightAuthority = (
    safetyIntent: NonNullable<HeightParams['heightIntent']>,
  ) => {
    if (!ownerSetup || chamferSmartPanelState?.kind !== 'smart_v2') return undefined
    return {
      kind: 'smart_v2' as const,
      intent: rebuildChamferSmartHeightSafetyIntent({
        intent: chamferSmartPanelState.intent,
        setupId: ownerSetup.id,
        safetyIntent,
      }),
    }
  }
  /** Safety edits preserve the selected Engrave paths, semantic datum, axial
   * offset, and explicit/width-derived depth formula. */
  const buildEngraveSmartHeightAuthority = (
    safetyIntent: NonNullable<HeightParams['heightIntent']>,
  ) => {
    if (!ownerSetup || engraveSmartPanelState?.kind !== 'smart_v2') return undefined
    return {
      kind: 'smart_v2' as const,
      intent: rebuildEngraveSmartHeightIntent({
        intent: engraveSmartPanelState.intent,
        setupId: ownerSetup.id,
        safetyIntent,
      }),
    }
  }
  const setAdaptive3dHeightPolicy = (
    mode: Adaptive3dMaterialMode,
  ) => {
    if (!activeSetupId || !ownerSetup || op.type !== 'adaptive_3d' || op.geometrySelections.length === 0) return
    const fallback = {
      topWcsMm: op.resolvedHeights?.version === 1 ? op.resolvedHeights.wcs.top : op.heights.topHeight,
      bottomWcsMm: op.resolvedHeights?.version === 1 ? op.resolvedHeights.wcs.bottom : op.heights.bottomHeight,
    }
    const priorBand = adaptive3dHeightDraft?.mode === 'bounded_band'
      ? adaptive3dHeightDraft
      : fallback
    const draft = {
      mode,
      topWcsMm: Math.max(priorBand.topWcsMm, priorBand.bottomWcsMm),
      bottomWcsMm: Math.min(priorBand.topWcsMm, priorBand.bottomWcsMm),
    }
    const intent = buildAdaptive3dSmartIntent({
      setupId: ownerSetup.id,
      geometryIds: op.geometrySelections,
      safetyIntent: currentOperationSafetyIntent() ?? setupDefaultHeightIntent(ownerSetup),
      mode,
      boundedBand: mode === 'bounded_band' ? draft : undefined,
    })
    updateOperation(activeSetupId, op.id, {
      smartHeight: { kind: 'smart_v2', intent },
      ...STALE,
    })
  }
  const commitAdaptive3dBand = (patch: Partial<Pick<Adaptive3dHeightDraft, 'topWcsMm' | 'bottomWcsMm'>>) => {
    if (!activeSetupId || !ownerSetup || op.type !== 'adaptive_3d' ||
        adaptive3dHeightDraft?.mode !== 'bounded_band') return
    const next = { ...adaptive3dHeightDraft, ...patch }
    if (next.topWcsMm <= next.bottomWcsMm) return
    updateOperation(activeSetupId, op.id, {
      smartHeight: {
        kind: 'smart_v2',
        intent: buildAdaptive3dSmartIntent({
          setupId: ownerSetup.id,
          geometryIds: op.geometrySelections,
          safetyIntent: currentOperationSafetyIntent() ?? setupDefaultHeightIntent(ownerSetup),
          mode: 'bounded_band',
          boundedBand: next,
        }),
      },
      ...STALE,
    })
  }
  const commitHeights = (patch: Partial<HeightParams>) => {
    if (!activeSetupId) return
    const heights = { ...op.heights, ...patch }
    const edits = [
      ['clearanceHeight', 'clearance'],
      ['retractHeight', 'retract'],
      ['feedHeight', 'feed'],
      ['topHeight', 'top'],
      ['bottomHeight', 'bottom'],
    ] as const
    let heightIntent = heights.heightIntent
      ? operationSafetyHeightIntent(
          heights.heightIntent,
          operationSafetyUserOverridePlanes(op),
        )
      : undefined
    for (const [field, plane] of edits) {
      const edited = patch[field]
      if (edited === undefined) continue
      heightIntent = heightIntentAfterNumericEdit(
        { ...heights, heightIntent }, plane, edited, resolveIntentReferenceWcsZ,
      )
    }
    const smartHeight = op.type === 'adaptive_3d' && adaptive3dHeightDraft && ownerSetup
      ? {
          kind: 'smart_v2' as const,
          intent: buildAdaptive3dSmartIntent({
            setupId: ownerSetup.id,
            geometryIds: op.geometrySelections,
            safetyIntent: heightIntent
              ?? currentOperationSafetyIntent()
              ?? operationSafetyHeightIntent(setupDefaultHeightIntent(ownerSetup), new Set()),
            mode: adaptive3dHeightDraft.mode,
            boundedBand: adaptive3dHeightDraft.mode === 'bounded_band'
              ? adaptive3dHeightDraft
              : undefined,
          }),
        }
      : op.type === 'parallel_3d' && parallel3dSmartPanelState?.kind === 'smart_v2' && ownerSetup && heightIntent
        ? {
            kind: 'smart_v2' as const,
            intent: buildParallel3dSmartIntent({
              setupId: ownerSetup.id,
              geometryIds: op.geometrySelections,
              safetyIntent: heightIntent,
              finishDepthMm: parallel3dSmartPanelState.draft.finishDepthMm,
            }),
          }
      : op.type === 'steep_shallow_3d' && parallel3dSmartPanelState?.kind === 'smart_v2' && ownerSetup && heightIntent
        ? {
            kind: 'smart_v2' as const,
            intent: buildSteepShallow3dSmartIntent({
              setupId: ownerSetup.id,
              geometryIds: op.geometrySelections,
              safetyIntent: heightIntent,
              finishDepthMm: parallel3dSmartPanelState.draft.finishDepthMm,
            }),
          }
      : op.type === 'scallop_3d' && parallel3dSmartPanelState?.kind === 'smart_v2' && ownerSetup && heightIntent
        ? {
            kind: 'smart_v2' as const,
            intent: buildScallop3dSmartIntent({
              setupId: ownerSetup.id,
              geometryIds: op.geometrySelections,
              safetyIntent: heightIntent,
              finishDepthMm: parallel3dSmartPanelState.draft.finishDepthMm,
            }),
          }
      : op.type === 'pencil_3d' && parallel3dSmartPanelState?.kind === 'smart_v2' && ownerSetup && heightIntent
        ? {
            kind: 'smart_v2' as const,
            intent: buildPencil3dSmartIntent({
              setupId: ownerSetup.id,
              geometryIds: op.geometrySelections,
              safetyIntent: heightIntent,
              finishDepthMm: parallel3dSmartPanelState.draft.finishDepthMm,
            }),
          }
      : op.type === 'waterline_3d' && waterline3dSmartPanelState?.kind === 'smart_v2' && ownerSetup && heightIntent
        ? {
            kind: 'smart_v2' as const,
            intent: buildWaterline3dSmartIntent({
              setupId: ownerSetup.id,
              geometryIds: op.geometrySelections,
              safetyIntent: heightIntent,
              finishDepthMm: waterline3dSmartPanelState.draft.finishDepthMm,
            }),
          }
      : op.type === 'face' && faceSmartPanelState?.kind === 'smart_v2' && heightIntent
        ? buildFaceSmartHeightAuthority(heightIntent, faceSmartPanelState.draft)
        : op.type === 'contour_2d' && contourSmartPanelState?.kind === 'smart_v2' && heightIntent
          ? buildContourSmartHeightAuthority(heightIntent, contourSmartPanelState.draft)
        : isPlanarRoughOperation && planarRoughSmartPanelState?.kind === 'smart_v2' && heightIntent
          ? buildPlanarRoughSmartHeightAuthority(heightIntent)
        : isDrillBoreOperation && drillBoreSmartPanelState?.kind === 'smart_v2' && heightIntent
          ? buildDrillBoreSmartHeightAuthority(heightIntent)
        : op.type === 'thread_mill' && threadMillSmartPanelState?.kind === 'smart_v2' && heightIntent
          ? buildThreadMillSmartHeightAuthority(heightIntent)
        : op.type === 'chamfer' && chamferSmartPanelState?.kind === 'smart_v2' && heightIntent
          ? buildChamferSmartHeightAuthority(heightIntent)
        : op.type === 'engrave' && engraveSmartPanelState?.kind === 'smart_v2' && heightIntent
          ? buildEngraveSmartHeightAuthority(heightIntent)
        : op.type === 'pattern' && smartHeightIntent && ownerSetup && heightIntent
          ? {
              kind: 'smart_v2' as const,
              intent: rebuildPatternSmartHeightIntent({ intent: smartHeightIntent, setupId: ownerSetup.id, safetyIntent: heightIntent }),
            }
        : op.smartHeight
    updateOperation(activeSetupId, op.id, {
      heights: { ...heights, heightIntent },
      smartHeight,
      ...STALE,
    })
  }
  const commitPasses = (patch: Partial<PassParams>) => {
    if (activeSetupId) updateOperation(activeSetupId, op.id, { passes: { ...op.passes, ...patch }, ...STALE })
  }
  // WO-3193: the thread mill's Bottom-up / Top-down choice (orbit sense then
  // follows direction x hand x cutter; climb/conventional is shown as the result).
  const commitThreadAxialDirection = (axialDirection: ThreadAxialDirection) => {
    if (!activeSetupId || op.type !== 'thread_mill') return
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, axialDirection } as Record<string, unknown>,
      ...STALE,
    })
  }
  const adaptiveParams = op.params as unknown as ACParams
  const commitAdaptiveParams = (patch: Partial<ACParams>) => {
    if (!activeSetupId || op.type !== 'adaptive_clearing_2d') return
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...STALE,
    })
  }
  // WO-1566: the operator's shank/neck/holder clearance (WO-1565) rides
  // op.params and the compute seam reads it structurally - the same pattern as
  // the contour tab fields below. Shown for every operation whose toolpath
  // goes through the worker's clearance trim.
  const commitShankClearance = (clearanceAllowanceMm: number) => {
    if (!activeSetupId) return
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, clearanceAllowanceMm } as Record<string, unknown>,
      ...STALE,
    })
  }
  const commitFaceExplicitTarget = (explicitTargetWcsMm: number) => {
    if (!activeSetupId || faceSmartPanelState?.kind !== 'smart_v2' ||
        faceSmartPanelState.draft.mode === 'target_face') return
    const safetyIntent = currentOperationSafetyIntent()
    if (!safetyIntent) return
    // WO-2694: a typed plane replaces the smart Model top and is kept as typed.
    const draft = { mode: 'explicit_depth' as const, explicitTargetWcsMm }
    const mirroredIntent = heightIntentAfterNumericEdit(
      op.heights, 'bottom', explicitTargetWcsMm, resolveIntentReferenceWcsZ,
    )
    updateOperation(activeSetupId, op.id, {
      smartHeight: buildFaceSmartHeightAuthority(safetyIntent, draft),
      heights: {
        ...op.heights,
        bottomHeight: explicitTargetWcsMm,
        heightIntent: mirroredIntent,
      },
      ...STALE,
    })
  }
  // WO-2694: back from a typed plane to the smart Model top (offered only while
  // the Face's stock holds a model to resolve it from).
  const faceModelTopAvailable = (() => {
    if (faceSmartPanelState?.kind !== 'smart_v2') return false
    const scope = faceSmartPanelState.intent.machining.scope.value
    return scope.kind === 'stock_footprint' && smartHeightModelTop(project, scope.stockId) !== null
  })()
  const faceModelTopWcs = resolvedHeightPlan?.machining.physicalTarget?.wcsMm ?? op.resolvedHeights?.wcs.bottom
  const commitFaceModelTop = () => {
    if (!activeSetupId || faceSmartPanelState?.kind !== 'smart_v2' ||
        faceSmartPanelState.draft.mode !== 'explicit_depth') return
    const safetyIntent = currentOperationSafetyIntent()
    if (!safetyIntent) return
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      smartHeight: buildFaceSmartHeightAuthority(safetyIntent, { mode: 'model_top', explicitTargetWcsMm: 0 }),
      ...STALE,
    })
  }
  const pocketParams = op.params as unknown as PocketParams
  const pocketPolicy = getPocketEntryPolicy(pocketParams.fillStrategy)
  const pocketLinking: LinkingParams = op.linking ?? {
    entryType: 'plunge',
    rampAngle: 2,
    rampLength: 5,
    leadInRadius: 0,
    leadOutRadius: 0,
    retractType: 'full',
    transitionType: 'safe_height',
  }
  const pocketEntryValid = isPocketEntryAllowed(
    pocketParams.fillStrategy,
    pocketLinking.entryType,
  )
  const commitPocketLinking = (patch: Partial<LinkingParams>) => {
    if (!activeSetupId) return
    updateOperation(activeSetupId, op.id, {
      linking: { ...pocketLinking, ...patch },
      ...STALE,
    })
  }
  const commitFloorHop = (floorHopMm: number) => {
    if (!activeSetupId) return
    updateOperation(activeSetupId, op.id, {
      linking: { ...pocketLinking, floorHopMm: Math.max(0, floorHopMm) },
      ...STALE,
    })
  }
  const commitPocketParams = (patch: Partial<PocketParams>) => {
    if (!activeSetupId) return
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...STALE,
    })
  }
  const drillParams = op.params as unknown as DrillParams
  const commitDrillParams = (patch: Partial<DrillParams>) => {
    if (!activeSetupId) return
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...STALE,
    })
  }
  const boreParams = op.params as unknown as BoreParams
  const commitBoreParams = (patch: Partial<BoreParams>) => {
    if (!activeSetupId) return
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...STALE,
    })
  }
  const chamferParams = op.params as unknown as ChamferParams
  const commitChamferParams = (patch: Partial<ChamferParams>) => {
    if (!activeSetupId || op.type !== 'chamfer') return
    const smartHeight = chamferSmartPanelState?.kind === 'smart_v2'
      ? {
          kind: 'smart_v2' as const,
          intent: rebuildChamferSmartHeightFormulaIntent({
            intent: chamferSmartPanelState.intent,
            patch: {
              ...(patch.chamferWidth === undefined ? {} : { chamferWidthMm: patch.chamferWidth }),
              ...(patch.tipOffset === undefined ? {} : { tipOffsetMm: patch.tipOffset }),
            },
          }),
        }
      : op.smartHeight
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      smartHeight,
      ...STALE,
    })
  }
  const vcarveParams = op.params as unknown as VCarveParams
  /** V-carve edits: the depth fields re-author the V2 formula so the persisted
   *  authority and the params never disagree; the others ride params only. */
  const commitVCarveParams = (patch: Partial<VCarveParams>) => {
    if (!activeSetupId || op.type !== 'vcarve') return
    const touchesFormula = 'flatDepthMm' in patch || 'startDepthMm' in patch
    const smartHeight = touchesFormula && vcarveSmartPanelState?.kind === 'smart_v2'
      ? {
          kind: 'smart_v2' as const,
          intent: rebuildVCarveSmartHeightIntent({
            intent: vcarveSmartPanelState.intent,
            setupId: activeSetupId,
            patch: {
              ...('startDepthMm' in patch && patch.startDepthMm !== undefined ? { startDepthMm: patch.startDepthMm } : {}),
              ...('flatDepthMm' in patch
                ? { flatDepth: patch.flatDepthMm === undefined ? { kind: 'tool_limit' as const } : { kind: 'explicit' as const, depthMm: patch.flatDepthMm } }
                : {}),
            },
          }),
        }
      : op.smartHeight
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      smartHeight,
      ...STALE,
    })
  }
  const contourParams = op.params as unknown as ContourParams
  const contourCuttingStrategy = deriveContourMode(op.passes, contourParams.contourFinishMode)
  const commitContourCuttingStrategy = (mode: ContourCuttingStrategy) => {
    if (!activeSetupId || op.type !== 'contour_2d' || mode === contourCuttingStrategy) return
    const mapped = contourPassParamsForMode(mode, {
      stockToLeave: op.passes.stockToLeave,
      finishPasses: op.passes.finishPasses,
    })
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      passes: {
        ...op.passes,
        stockToLeave: mapped.stockToLeave,
        finishPasses: mapped.finishPasses,
      },
      params: {
        ...op.params,
        contourFinishMode: mapped.contourFinishMode,
      } as Record<string, unknown>,
      ...STALE,
    })
  }
  const commitContourParams = (patch: Partial<ContourParams>) => {
    if (!activeSetupId) return
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...STALE,
    })
  }
  // WO-2299: Engrave's Style and slot fields, the same stored params the dialog edits.
  const engraveParams = op.params as unknown as EngraveParams
  const commitEngraveParams = (patch: Partial<EngraveParams>) => {
    if (!activeSetupId) return
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...STALE,
    })
  }
  // Face (WO-020, rebuilt from the WO-015 branch after its audit fail): the
  // panel exposes exactly the implemented v1 FaceParams surface the modal edits
  // (strategy, pass angle / extension, stock offset, containment, per-level
  // toggles) through the SAME updateOperation merge path; deferred members
  // (chip thinning, lead arcs, avoidance) stay unexposed — the compute fails
  // loud on them (ADR 0003). Numeric bounds come from faceFieldBounds.ts, the
  // same module the modal reads, so a value the modal refuses cannot be
  // persisted here either (the WO-015 parity failure).
  const faceParams = op.params as unknown as FaceParams
  const commitFaceParams = (patch: Partial<FaceParams>) => {
    if (!activeSetupId || op.type !== 'face') return
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, ...patch } as Record<string, unknown>,
      ...STALE,
    })
  }
  // Strategy = the modal's pattern+direction buttons collapsed into one
  // select. Derivation mirrors the compute's bothWays rule (face2d/index.ts:
  // zigzag -> bidirectional, one_way -> single direction, legacy 'linear'
  // follows direction) so the shown value matches the cut that would be made.
  type FaceStrategy = 'zigzag' | 'one_way_climb' | 'one_way_conventional' | 'offset' | 'spiral'
  const faceStrategy: FaceStrategy =
    faceParams.pattern === 'spiral' ? 'spiral'
    : faceParams.pattern === 'offset' ? 'offset'
    : faceParams.pattern === 'zigzag'
      || (faceParams.pattern === 'linear' && faceParams.direction === 'both_ways') ? 'zigzag'
    : faceParams.direction === 'conventional' ? 'one_way_conventional'
    : 'one_way_climb'
  const commitFaceStrategy = (strategy: FaceStrategy) => {
    if (strategy === faceStrategy) return
    commitFaceParams(
      strategy === 'zigzag' ? { pattern: 'zigzag', direction: 'both_ways' }
      : strategy === 'one_way_climb' ? { pattern: 'one_way', direction: 'climb' }
      : strategy === 'one_way_conventional' ? { pattern: 'one_way', direction: 'conventional' }
      : strategy === 'offset' ? { pattern: 'offset', direction: 'climb' }
      : { pattern: 'spiral', direction: 'climb' },
    )
  }
  const commitContourTabsEnabled = (enabled: boolean) => {
    if (!activeSetupId) return
    if (!enabled) endTabEdit()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, tabs: enabled } as Record<string, unknown>,
      ...STALE,
    })
  }

  // ── Contour tab placement (Tabs v2): in-workspace edit mode ────────────────
  // The Properties panel owns the mode toggle; the viewport owns the direct
  // manipulation (click contour = add, drag marker = slide, double-click =
  // remove, Esc = leave). Every edit commits through the store immediately
  // (same STALE marking as any other param edit) — leaving the mode commits
  // nothing extra. Callbacks read FRESH store state (never the render closure)
  // because they fire from viewport events between renders.
  // CAM-12-R3 census fix: `.loops` must be checked as an actual array before
  // `.length` -- see the matching Viewport.tsx guard fix's own comment.
  const contourTabPreviewReady =
    op.contourTabPreview !== undefined &&
    Array.isArray(op.contourTabPreview.loops) &&
    op.contourTabPreview.loops.length > 0
  const contourTabLocations = (contourParams.tabLocations ?? {}) as { [loopId: string]: ContourTabLocations }
  const customTabCount = Object.values(contourTabLocations)
    .reduce((n, at) => n + (Array.isArray(at) ? at.length : 0), 0)
  // WO-3220: outlines an applied suggestion left without tabs ('none').
  const noTabOutlineCount = Object.values(contourTabLocations).filter((at) => at === 'none').length
  const freshContourOp = () =>
    useCamStore.getState().project.setups.find((s) => s.id === activeSetupId)
      ?.operations.find((o) => o.id === op.id)
  const commitTabLocations = (loopId: string, updater: (locs: number[]) => number[]) => {
    if (!activeSetupId) return
    const cur = freshContourOp()
    if (!cur) return
    const params = cur.params as unknown as ContourParams
    const existing = params.tabLocations?.[loopId]
    const next = updater(Array.isArray(existing) ? [...existing] : [])
      .filter((f) => Number.isFinite(f))
      // Wrap only out-of-range values: the mod dance perturbs in-range
      // fractions by one ulp, which would drift stored positions.
      .map((f) => (f >= 0 && f < 1 ? f : ((f % 1) + 1) % 1))
      .sort((a, b) => a - b)
    const map: { [id: string]: ContourTabLocations } = { ...(params.tabLocations ?? {}) }
    if (next.length === 0) delete map[loopId]
    else map[loopId] = next
    useCamStore.getState().updateOperation(activeSetupId, op.id, {
      params: {
        ...cur.params,
        tabLocations: Object.keys(map).length > 0 ? map : undefined,
      } as Record<string, unknown>,
      ...STALE,
    })
  }
  const endTabEdit = () => {
    getVp()?.exitContourTabEditMode?.(false)
    setTabEditActive(false)
  }
  const beginTabEdit = () => {
    const vp = getVp()
    if (!vp?.enterContourTabEditMode || !activeSetupId) return
    const cur = freshContourOp()
    // CAM-12-R3 census fix: same `.loops` array guard as contourTabPreviewReady
    // above -- beginTabEdit is user-event-gated (the button click), but
    // contourTabPreviewReady's own disabled-state check already relies on this
    // exact guard, so a malformed preview must be refused the same way here too.
    if (!cur?.contourTabPreview || !Array.isArray(cur.contourTabPreview.loops) || cur.contourTabPreview.loops.length === 0) return
    const params = cur.params as unknown as ContourParams
    // First entry with no custom locations SEEDS them from the evenly-spaced
    // centers currently shown, so hand editing starts from what the user sees.
    const count = Math.max(1, Math.round(params.tabCount ?? DEFAULT_CONTOUR_TABS.count))
    // A loop set to 'none' by an applied suggestion stays without tabs; a
    // click on it adds the first hand-placed one.
    const seeded: { [id: string]: ContourTabLocations } = { ...(params.tabLocations ?? {}) }
    let seededAny = false
    for (const l of cur.contourTabPreview.loops) {
      const at = seeded[l.loopId]
      if (at !== 'none' && (!at || at.length === 0)) {
        seeded[l.loopId] = evenTabFractions(count)
        seededAny = true
      }
    }
    if (seededAny) {
      useCamStore.getState().updateOperation(activeSetupId, op.id, {
        params: { ...cur.params, tabLocations: seeded } as Record<string, unknown>,
        ...STALE,
      })
    }
    vp.enterContourTabEditMode({
      onAdd: (loopId, fraction) =>
        commitTabLocations(loopId, (locs) => [...locs, fraction]),
      onMove: (loopId, index, fraction) =>
        commitTabLocations(loopId, (locs) => {
          if (index >= 0 && index < locs.length) locs[index] = fraction
          return locs
        }),
      onRemove: (loopId, index) =>
        commitTabLocations(loopId, (locs) => locs.filter((_, i) => i !== index)),
      onExit: () => setTabEditActive(false),
    })
    setTabEditActive(true)
  }
  // WO-3220: Suggest tab locations. The store reads the inputs the current
  // preview was derived from; a contour it cannot suggest for gets one line.
  const suggestRefusalText = (reason: ContourTabSuggestRefusal | 'changed' | 'nothing-found'): string => ({
    'missing': txTabs('refuseMissing'), 'not-contour': txTabs('refuseNotContour'), 'open': txTabs('refuseOpen'),
    'roughing': txTabs('refuseRoughing'), 'tabs-off': txTabs('refuseTabsOff'),
    'generate-first': txTabs('refuseGenerateFirst'), 'stale': txTabs('refuseStale'),
    'all-hand-placed': txTabs('refuseAllHandPlaced'), 'changed': txTabs('refuseChanged'),
    'nothing-found': txTabs('refuseNothingFound'),
  })[reason]
  const suggestTabLocations = () => {
    if (!activeSetupId) return
    endTabEdit()
    const outcome = useCamStore.getState().suggestContourTabLocations(activeSetupId, op.id)
    setTabSuggestion(outcome.ok ? outcome.suggestion : null)
    setTabSuggestNote(outcome.ok ? null : suggestRefusalText(outcome.reason))
  }
  const applyTabSuggestion = () => {
    if (!activeSetupId || !tabSuggestion) return
    const outcome: ContourTabApplyOutcome = useCamStore.getState().applyContourTabSuggestions(activeSetupId, op.id, tabSuggestion)
    if (outcome.ok) {
      setTabSuggestion(null)
      setTabSuggestNote(outcome.noneLoopIds.length > 0
        ? txTabs('appliedWithNone', { count: outcome.applied, none: outcome.noneLoopIds.length })
        : txTabs('applied', { count: outcome.applied }))
      return
    }
    setTabSuggestion(outcome.recomputed ?? null)
    setTabSuggestNote(suggestRefusalText(outcome.reason))
  }
  const cancelTabSuggestion = () => {
    setTabSuggestion(null)
    setTabSuggestNote(null)
  }
  // WO-3221: Create tab removal contour. Review first (all tabs, the setup's
  // holding method); Create makes a separate Contour and never edits this one.
  const tabRemovalRefusalText = (reason: ContourTabRemovalRefusal | 'rejected'): string => ({
    'missing': txRemoval('refuseMissing'), 'not-contour': txRemoval('refuseNotContour'),
    'is-cleanup': txRemoval('refuseIsCleanup'), 'open': txRemoval('refuseOpen'), 'tabs-off': txRemoval('refuseTabsOff'),
    'generate-first': txRemoval('refuseGenerateFirst'), 'stale': txRemoval('refuseStale'),
    'no-tabs': txRemoval('refuseNoTabs'), 'selective': txRemoval('refuseSelective'),
    'flipped': txRemoval('refuseFlipped'), 'rejected': txRemoval('refuseRejected'),
  })[reason]
  const beginTabRemoval = () => {
    if (!activeSetupId) return
    endTabEdit()
    const outcome = useCamStore.getState().reviewContourTabRemoval(activeSetupId, op.id)
    if (!outcome.ok) {
      setTabRemovalReview(null)
      setTabRemovalNote(tabRemovalRefusalText(outcome.reason))
      return
    }
    setTabRemovalNote(null)
    setTabRemovalReview({ targets: outcome.targets, loopIds: outcome.loopIds, holdingMethod: outcome.holdingMethod,
      notes: outcome.notes, selected: outcome.targets.map((target) => target.label) })
    setTabRemovalMaterial('reading')
    const setupId = activeSetupId, opId = op.id
    void useCamStore.getState().readContourTabRemovalMaterial(setupId, opId).then((material) => {
      if (useCamStore.getState().project.activeSetupId === setupId) setTabRemovalMaterial(material)
    })
  }
  const toggleTabRemovalTarget = (label: string, on: boolean) => {
    setTabRemovalReview((review) => review && {
      ...review, selected: on ? [...review.selected.filter((l) => l !== label), label] : review.selected.filter((l) => l !== label),
    })
    setTabRemovalNote(null)
  }
  const createTabRemoval = () => {
    if (!activeSetupId || !tabRemovalReview) return
    const outcome = useCamStore.getState().createContourTabRemoval(activeSetupId, op.id, tabRemovalReview.selected)
    if (!outcome.ok) {
      setTabRemovalNote(tabRemovalRefusalText(outcome.reason))
      return
    }
    setTabRemovalReview(null)
    setTabRemovalMaterial(null)
    setTabRemovalNote(txRemoval('created', { name: outcome.name }))
  }
  const cancelTabRemoval = () => {
    setTabRemovalReview(null)
    setTabRemovalMaterial(null)
    setTabRemovalNote(null)
  }
  const suggestionReasonText = (reasons: Record<string, number>): string => {
    const labels = new Set<string>()
    for (const reason of Object.keys(reasons)) {
      labels.add(reason === 'sharp-corner-or-short-span' ? txTabs('reasonCorner')
        : reason === 'entry-exit' ? txTabs('reasonEntry')
        : reason === 'opposite-wall' ? txTabs('reasonOppositeWall')
        : reason.startsWith('source-ring:') ? txTabs('reasonOtherOutline')
        : reason.startsWith('fixture:') ? txTabs('reasonFixture')
        : reason === 'material-connection-unresolved' || reason === 'no-local-material-span' ? txTabs('reasonMaterial')
        : txTabs('reasonOther'))
    }
    return [...labels].join(', ')
  }
  const resetTabLocations = () => {
    endTabEdit()
    if (!activeSetupId) return
    const cur = freshContourOp()
    if (!cur) return
    useCamStore.getState().updateOperation(activeSetupId, op.id, {
      params: { ...cur.params, tabLocations: undefined } as Record<string, unknown>,
      ...STALE,
    })
  }
  // Bottom of cut is reference-plane-derived for pocket and per-loop-derived for
  // contour/adaptive/face (ADR-0020). Only pocket may expose a direct Bottom
  // edit: it back-solves planeOffset below instead of writing the ignored legacy
  // heights.bottomHeight field. All other operation types remain read-only.
  // Ref-plane change routed through the SINGLE shared mapping (UI-STANDARD 11.6),
  // the same helper the modal calls — heights (bottomManual) + params
  // (heightReference) can never diverge between the two surfaces.
  // WO-1903: the shared height-ref mapping now takes the 2.5D HeightRefOpType
  // subset, not `| string`. This panel holds a plain OperationType; for any type
  // outside that subset the old loose signature fell through to the shared
  // mapping's bottom-governed default - exactly what 'contour_2d' (bottom-
  // governed, non-chamfer) yields - so this preserves the prior behaviour.
  const heightRefType: HeightRefOpType = isHeightRefOpType(op.type) ? op.type : 'contour_2d'
  const commitRefPlane = (ref: ChamferHeightReference) => {
    if (!activeSetupId) return
    if (ref === currentRef) return
    if (ref !== 'picked_plane' && datumPickActive) {
      datumPickGenerationRef.current += 1
      getVp()?.setBrepPickMode?.(null)
      setDatumPickActive(false)
      setDatumPickError(null)
    }
    const upd = deriveHeightRefUpdate(heightRefType, op.heights, op.params as unknown as HeightRefParams, ref)
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      heights: { ...op.heights, ...upd.heights },
      params: { ...op.params, ...upd.params },
      ...STALE,
    })
  }
  const commitPlaneOffset = (v: number) => {
    if (!activeSetupId) return
    if (v === currentOffset) return
    const heightUpdate = deriveHeightPlaneOffsetUpdate(
      heightRefType, op.heights, op.params as unknown as HeightRefParams, currentRef, v,
    )
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      params: { ...op.params, planeOffset: v },
      heights: { ...op.heights, ...heightUpdate },
      ...STALE,
    })
  }

  // Which op types expose an editable Ref plane + Plane offset: every op whose
  // modal shows the reference-plane DROPDOWN. thread_mill is excluded on purpose
  // (its modal uses a fixed picked-face datum, no dropdown) so the two surfaces
  // stay in parity.
  // V2 family panels own height authoring. The old generic reference/offset
  // editor must not create a second authority or offer a repair bypass.
  const showRefPlane = false
  // Stepdown/Stepover/Stock-to-leave are meaningful only for these ops; the rest
  // (drill/chamfer/engrave/thread_mill) keep the read-only display.
  const PASSES_EDITABLE_OP_TYPES = ['contour_2d', 'pocket_2d', 'bore', 'adaptive_clearing_2d', 'face']
  const passesEditable = PASSES_EDITABLE_OP_TYPES.includes(op.type)
  // Current reference + offset, defaulted the SAME way the modal defaults them
  // (pocket -> geometry_face, chamfer -> absolute, else top-governed ? stock_top
  // : wcs_plane) so the dropdown shows the true current value.
  const refParams = op.params as unknown as HeightRefParams
  const currentRef: ChamferHeightReference =
    (refParams.heightReference as ChamferHeightReference | undefined)
    ?? (op.type === 'pocket_2d' ? 'geometry_face'
      : op.type === 'chamfer' ? 'absolute'
      : isHeightRefOpType(op.type) && heightRefGovernsTop(op.type, refParams) ? 'stock_top' : 'wcs_plane')
  const currentOffset = refParams.planeOffset ?? 0
  // Q-92: the picked surface is an INDEPENDENT height reference — the datum it
  // writes carries its own geoId (referencePlaneGeo.geoId), so it never needed
  // the operation's own source body to be a STEP solid, nor preselected. The
  // pick is offered whenever the project holds a STEP solid to pick a face on,
  // and the click itself names the owning body.
  const datumPickableGeometries = project.geometry.filter((g) => g.format === 'step')
  const canPickReferenceFace = datumPickableGeometries.length > 0

  useEffect(() => () => {
    datumPickGenerationRef.current += 1
    getVp()?.setBrepPickMode?.(null)
    useCamStore.getState().endFacePickBodySelection(null, getVp())
  }, [op.id])

  const cancelDatumPick = () => {
    datumPickGenerationRef.current += 1
    getVp()?.setBrepPickMode?.(null)
    getVp()?.setPickedBrepSelections?.([])
    useCamStore.getState().setBrepSelections([])
    useCamStore.getState().endFacePickBodySelection(null, getVp())
    setDatumPickActive(false)
    setDatumPickError(null)
  }

  const startDatumPick = () => {
    if (!activeSetupId || !canPickReferenceFace) return
    const vp = getVp()
    if (!vp?.setBrepPickMode) {
      setDatumPickError(tx('PropertiesPanel.The_viewport_face_picker_is_unavailable'))
      return
    }
    datumPickGenerationRef.current += 1
    const generation = datumPickGenerationRef.current
    setDatumPickActive(true)
    setDatumPickError(null)
    vp.setPickedBrepSelections?.([])
    useCamStore.getState().setBrepSelections([])
    // Q-92: asking for a face turns whole-body selection off (store + the live
    // orange viewport highlight) so face hover/pick feedback is unmistakable.
    const suspensionToken = useCamStore.getState().beginFacePickBodySelection(vp)
    const endDatumPickMode = () => {
      vp.setBrepPickMode?.(null)
      useCamStore.getState().endFacePickBodySelection(suspensionToken, vp)
      setDatumPickActive(false)
    }
    // Q-92: no allowedGeoId — any loaded STEP solid's face may be the datum.
    vp.setBrepPickMode('face', (selection) => {
      if (datumPickGenerationRef.current !== generation) return
      // Fail loud instead of binding a datum to a body we cannot resolve, and
      // never fall back to the operation's own source geometry.
      const owner = selection.geoId
        ? datumPickableGeometries.find((g) => g.id === selection.geoId)
        : undefined
      if (!owner) {
        setDatumPickError(tx('PropertiesPanel.That_face_does_not_belong_to_a_loaded_STEP'))
        vp.setPickedBrepSelections?.([])
        useCamStore.getState().setBrepSelections([])
        return
      }
      if (selection.surfaceType !== 0) {
        setDatumPickError(tx('PropertiesPanel.That_surface_is_curved_Pick_a_flat_planar_face'))
        vp.setPickedBrepSelections?.([])
        useCamStore.getState().setBrepSelections([])
        return
      }
      void (async () => {
        try {
          const result = await deriveFaceLoops(selection.geoId, selection.index)
          if (datumPickGenerationRef.current !== generation) return
          const pickedDatum = { geoId: selection.geoId, faceIndex: selection.index, localZ: result.z }
          const latest = useCamStore.getState()
          const latestSetup = latest.project.setups.find((setup) => setup.id === activeSetupId)
          const latestOp = latestSetup?.operations.find((candidate) => candidate.id === op.id)
          if (latestOp === undefined) {
            setDatumPickError(tx('PropertiesPanel.The_operation_changed_before_the_picked_surface_could_be'))
            return
          }
          const latestParams = latestOp.params as unknown as HeightRefParams
          const sameDatum =
            latestParams.heightReference === 'picked_plane' &&
            latestParams.referencePlaneGeo?.geoId === pickedDatum.geoId &&
            latestParams.referencePlaneGeo.faceIndex === pickedDatum.faceIndex &&
            latestParams.referencePlaneGeo.localZ === pickedDatum.localZ
          if (!sameDatum) {
            const update = deriveHeightRefUpdate(
              isHeightRefOpType(latestOp.type) ? latestOp.type : 'contour_2d',
              latestOp.heights,
              latestParams,
              'picked_plane',
              pickedDatum,
            )
            latest.pushHistory()
            latest.updateOperation(activeSetupId, latestOp.id, {
              heights: { ...latestOp.heights, ...update.heights },
              params: { ...latestOp.params, ...update.params },
              ...STALE,
            })
          }
          const selectedSurface: BrepSelection = {
            geoId: selection.geoId,
            kind: 'face',
            index: selection.index,
          }
          latest.setBrepSelections([selectedSurface])
          vp.setPickedBrepSelections?.([selectedSurface])
          datumPickGenerationRef.current += 1
          endDatumPickMode()
          setDatumPickError(null)
        } catch (err) {
          if (datumPickGenerationRef.current !== generation) return
          setDatumPickError(err instanceof Error ? err.message : String(err))
        }
      })()
    }, null)
  }

  // Compact labeled numeric row matching the panel's props-group styling (mirrors
  // FixedStockProperties' row). Commits on blur/Enter via the shared NumericInput.
  const numRow = (
    label: string, value: number, onChange: (v: number) => void,
    opts?: { min?: number; max?: number; step?: number; title?: string; unit?: string },
  ) => (
    <div className="props-group">
      <div className="props-label">{label}</div>
      <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <NumericInput
          className="props-number-input"
          value={value}
          min={opts?.min}
          max={opts?.max}
          step={opts?.step ?? 0.5}
          units={opts?.unit === undefined ? displayUnits : undefined}
          kind="dim"
          tooltip={opts?.title ?? tx('PropertiesPanel.Label_units', { p1: label, p2: unitLabel(displayUnits) })}
          onChange={onChange}
        />
        {opts?.unit !== '' && <span>{opts?.unit ?? unitLabel(displayUnits)}</span>}
      </div>
    </div>
  )

  const referenceLabel = (reference: HeightReference): string => {
    switch (reference) {
      case 'wcs_plane': return tx('PropertiesPanel.WCS_zero')
      case 'machine_plane': return tx('PropertiesPanel.Machine_zero')
      case 'stock_top': return tx('PropertiesPanel.Stock_top')
      case 'stock_bottom': return tx('PropertiesPanel.Stock_bottom')
      case 'model_top': return tx('PropertiesPanel.Model_top')
      case 'model_bottom': return tx('PropertiesPanel.Model_bottom')
      case 'geometry_plane': return tx('PropertiesPanel.Geometry_plane')
      case 'picked_surface': return tx('PropertiesPanel.Picked_surface')
      case 'selected_feature_top': return tx('PropertiesPanel.Selected_feature_top')
      case 'selected_feature_bottom': return tx('PropertiesPanel.Selected_feature_bottom')
      case 'clearance': return tx('PropertiesPanel.Clearance')
      case 'retract': return tx('PropertiesPanel.Retract')
      case 'feed': return tx('PropertiesPanel.Feed')
      case 'top': return tx('PropertiesPanel.Top')
      case 'bottom': return tx('PropertiesPanel.Bottom')
      default: return reference
    }
  }
  const signedDim = (value: number): string =>
    `${value < 0 ? '-' : '+'} ${fmtDim(Math.abs(value), displayUnits)} ${unitLabel(displayUnits)}`
  const planeFormula = (reference: HeightReference, offsetMm: number): string =>
    `${referenceLabel(reference)} ${signedDim(offsetMm)}`
  // WO-1612: when the Top's material artifact is what earlier operations left
  // (WO-1609's resolution), the row says so. It does not name one operation:
  // the operation that set the height is decided by a per-region stock replay
  // in the store, and guessing it here named the wrong one (an unrelated Drill
  // for a Face's cut). The console line WO-1609 writes names it exactly.
  const earlierMaterialFormula = resolvedHeightPlan?.machining.materialArtifact?.representation === 'material-left-by-earlier-operations'
    ? tx('PropertiesPanel.Material_left_by_earlier_operations')
    : undefined
  const startFormula = (() => {
    const start = smartHeightIntent?.machining.start.value
    if (!start) return tx('PropertiesPanel.Repair_required')
    switch (start.kind) {
      case 'policy_default': return earlierMaterialFormula ?? tx('PropertiesPanel.Operation_policy_default')
      case 'current_material': return earlierMaterialFormula ?? tx('PropertiesPanel.Current_material')
      case 'initial_stock': return tx('PropertiesPanel.Initial_stock')
      case 'selected_feature_top': return tx('PropertiesPanel.Selected_feature_top')
      case 'target_model_top': return tx('PropertiesPanel.Target_model_top')
      case 'geometry_tool_formula': return tx('PropertiesPanel.Geometry_and_tool_formula')
      case 'explicit_plane': return planeFormula(start.plane.reference, start.plane.offsetMm)
    }
  })()
  const endFormula = (() => {
    const end = smartHeightIntent?.machining.end.value
    if (!end) return tx('PropertiesPanel.Repair_required')
    switch (end.kind) {
      case 'policy_default': return tx('PropertiesPanel.Operation_policy_default')
      case 'target_surface': return end.lowerLimit
        ? tx('PropertiesPanel.Target_surface_limited_by', { p1: planeFormula(end.lowerLimit.reference, end.lowerLimit.offsetMm) })
        : tx('PropertiesPanel.Target_surface')
      case 'selected_feature_floor': return tx('PropertiesPanel.Selected_feature_floor')
      case 'detected_feature_floors': return tx('PropertiesPanel.Detected_feature_floors')
      case 'selected_plane': return planeFormula(end.plane.reference, end.plane.offsetMm)
      case 'model_bottom': return tx('PropertiesPanel.Model_bottom_2', { p1: signedDim(end.allowanceMm) })
      case 'stock_bottom': return tx('PropertiesPanel.Stock_bottom_2', { p1: signedDim(end.allowanceMm) })
      case 'through_stock': return tx('PropertiesPanel.Stock_bottom_breakthrough', { p1: fmtDim(end.allowanceMm, displayUnits), p2: unitLabel(displayUnits) })
      case 'depth_from_start': return tx('PropertiesPanel.Top_depth', { p1: fmtDim(end.depthMm, displayUnits), p2: unitLabel(displayUnits) })
      case 'bounded_plane': return planeFormula(end.plane.reference, end.plane.offsetMm)
      case 'geometry_tool_formula': {
        const formula = end.formula
        if (formula.kind === 'thread_band') {
          const datum = formula.datum === 'feature_base' ? tx('PropertiesPanel.Feature_base')
            : formula.datum === 'feature_top' ? tx('PropertiesPanel.Feature_top') : tx('PropertiesPanel.Authored_datum')
          return tx('PropertiesPanel.thread_depth', { p1: datum, p2: signedDim(formula.datumOffsetMm), p3: formula.direction === 'down' ? '-' : '+', p4: fmtDim(formula.depthMm, displayUnits), p5: unitLabel(displayUnits) })
        }
        if (formula.kind === 'chamfer_edge') {
          return tx('PropertiesPanel.tool_formula', { p1: planeFormula(formula.datumPlane.reference, formula.datumPlane.offsetMm), p2: fmtDim(formula.chamferWidthMm + formula.tipOffsetMm, displayUnits), p3: unitLabel(displayUnits) })
        }
        if (formula.kind === 'vcarve_region') {
          const limit = formula.flatDepth.kind === 'explicit'
            ? tx('PropertiesPanel.flat_depth', { p1: fmtDim(formula.flatDepth.depthMm, displayUnits), p2: unitLabel(displayUnits) })
            : tx('PropertiesPanel.the_bit_s_own_depth_limit')
          return tx('PropertiesPanel.start_depth', { p1: planeFormula(formula.datumPlane.reference, formula.datumPlane.offsetMm), p2: fmtDim(formula.startDepthMm, displayUnits), p3: unitLabel(displayUnits), p4: limit })
        }
        const depth = formula.depth.kind === 'explicit'
          ? tx('PropertiesPanel.Census_depth', { p1: fmtDim(formula.depth.depthMm, displayUnits), p2: unitLabel(displayUnits) })
          : tx('PropertiesPanel.line_width', { p1: fmtDim(formula.depth.targetLineWidthMm, displayUnits), p2: unitLabel(displayUnits) })
        return `${planeFormula(formula.datumPlane.reference, formula.datumPlane.offsetMm)} ${signedDim(formula.axialOffsetMm)} - ${depth}`
      }
    }
  })()
  /** WO-2516: why this Drill's Break through starts on or off, from the same
   * facts New Operation reads: the picked holes, or the Target End against the
   * stock bottom. The saved value is never changed here. */
  const drillBreakThroughStart = (() => {
    if (op.type !== 'drill' || drillBoreSmartPanelState?.kind !== 'smart_v2') return undefined
    if (drillBoreSmartPanelState.draft.mode === 'detected_features') {
      const geometryId = drillParams.geometryId ?? ''
      const sources = geometryId === '__all__'
        ? resolveOpGeometrySources(project.geometry, '__all__', 'drill')
        : project.geometry.filter(candidate => candidate.id === geometryId)
      return drillBreakThroughDefault({
        mode: 'detected_features',
        holesThrough: drillPickedHolesThrough(sources, drillParams.loopIds ?? []),
      })
    }
    const stockId = ownerSetup ? setupProvenStockId(ownerSetup, project) : undefined
    const bounds = stockId ? smartHeightStockBounds(project, stockId) : null
    return drillBreakThroughDefault({
      mode: 'explicit_depth',
      bottomWcsMm: resolvedHeightPlan?.machining.physicalTarget?.wcsMm ?? drillBoreSmartPanelState.draft.explicitEndWcsMm,
      stockBottomWcsMm: bounds && ownerSetup ? bounds.min.z - ownerSetup.wcs.origin.z : undefined,
    })
  })()
  const drillBreakThroughReason = (() => {
    if (!drillBreakThroughStart) return undefined
    const p1 = fmtMachineLength(DRILL_BREAK_THROUGH_DEFAULT_MM, displayUnits)
    const p2 = unitLabel(displayUnits)
    switch (drillBreakThroughStart.reason) {
      case 'through_holes': return tx('PropertiesPanel.Break_through_default_through_hole', { p1, p2 })
      case 'blind_holes': return tx('PropertiesPanel.Break_through_default_hole_with_floor')
      case 'mixed_holes': return tx('PropertiesPanel.Break_through_default_mixed_holes', {
        p1: String(drillBreakThroughStart.throughHoles), p2: String(drillBreakThroughStart.holes),
      })
      case 'bottom_at_stock_bottom': return tx('PropertiesPanel.Break_through_default_bottom_at_stock_bottom', { p1, p2 })
      case 'bottom_above_stock_bottom': return tx('PropertiesPanel.Break_through_default_bottom_above_stock_bottom')
    }
  })()
  const resolvedBottomWcs = resolvedHeightPlan?.machining.cutterCenterEnd?.wcsMm
    ?? resolvedHeightPlan?.machining.featureEndpoints?.reduce<number | undefined>(
      (lowest, endpoint) => lowest === undefined
        ? endpoint.cutterCenterEnd.wcsMm
        : Math.min(lowest, endpoint.cutterCenterEnd.wcsMm),
      undefined,
    )
    ?? resolvedHeightPlan?.machining.physicalTarget?.wcsMm
  const safetyAuthority = (plane: 'clearance' | 'retract' | 'feed') => {
    const authored = smartHeightIntent?.safety[plane]
    if (!authored) return tx('PropertiesPanel.Repair_Required')
    return authored.owner.kind === 'user_override' ? tx('PropertiesPanel.User_Override') : tx('PropertiesPanel.Smart')
  }
  const topAuthority = smartHeightIntent?.machining.start.owner.kind === 'user_override'
    ? tx('PropertiesPanel.User_Override')
    : tx('PropertiesPanel.Smart')
  const bottomAuthority = smartHeightIntent?.featureOverrides?.some(
    endpoint => endpoint.cutterCenterEnd.owner.kind === 'user_override',
  ) || smartHeightIntent?.machining.end.owner.kind === 'user_override'
    ? tx('PropertiesPanel.User_Override')
    : tx('PropertiesPanel.Smart')
  const conventionalHeightRows = [
    {
      plane: 'clearance' as const,
      get label() { return tx('PropertiesPanel.Clearance_Height') },
      formula: smartHeightIntent
        ? planeFormula(smartHeightIntent.safety.clearance.reference, smartHeightIntent.safety.clearance.offsetMm)
        : tx('PropertiesPanel.Repair_required'),
      resolved: resolvedHeightPlan?.safety.clearance.wcsMm,
      legacy: op.heights.clearanceHeight,
      authority: safetyAuthority('clearance'),
      onChange: smartHeightIntent ? (value: number) => commitHeights({ clearanceHeight: value }) : undefined,
    },
    {
      plane: 'retract' as const,
      get label() { return tx('PropertiesPanel.Retract_Height') },
      formula: smartHeightIntent
        ? planeFormula(smartHeightIntent.safety.retract.reference, smartHeightIntent.safety.retract.offsetMm)
        : tx('PropertiesPanel.Repair_required'),
      resolved: resolvedHeightPlan?.safety.retract.wcsMm,
      legacy: op.heights.retractHeight,
      authority: safetyAuthority('retract'),
      onChange: smartHeightIntent ? (value: number) => commitHeights({ retractHeight: value }) : undefined,
    },
    {
      plane: 'feed' as const,
      get label() { return tx('PropertiesPanel.Feed_Height') },
      formula: smartHeightIntent
        ? planeFormula(smartHeightIntent.safety.feed.reference, smartHeightIntent.safety.feed.offsetMm)
        : tx('PropertiesPanel.Repair_required'),
      resolved: resolvedHeightPlan?.safety.feed.wcsMm,
      legacy: op.heights.feedHeight,
      authority: safetyAuthority('feed'),
      onChange: smartHeightIntent
        ? (value: number) => commitHeights({ feedHeight: value })
        : undefined,
    },
    {
      plane: 'top' as const,
      get label() { return tx('PropertiesPanel.Top_Height') },
      formula: startFormula,
      resolved: resolvedHeightPlan?.machining.materialStart.wcsMm,
      legacy: op.heights.topHeight,
      authority: topAuthority,
    },
    {
      plane: 'bottom' as const,
      get label() { return tx('PropertiesPanel.Bottom_Height') },
      formula: endFormula,
      resolved: resolvedBottomWcs,
      legacy: op.heights.bottomHeight,
      authority: bottomAuthority,
    },
  ]
  const safetyOwnershipLabel = heightSafetyOwnership === 'setup'
    ? tx('PropertiesPanel.Setup_owned')
    : heightSafetyOwnership === 'mixed'
      ? tx('PropertiesPanel.Mixed_ownership')
      : heightSafetyOwnership === 'operation'
        ? tx('PropertiesPanel.Operation_owned')
        : tx('PropertiesPanel.Repair_required')
  // WO-2007 (COHESION-STANDARD 21): a row is the value name and the value. How
  // the value was derived, and who owns the safety planes, is the value's
  // tooltip - never a second line, a disclosure or a chip in the panel.
  const heightRowTooltip = (row: typeof conventionalHeightRows[number]) =>
    row.plane === 'clearance' || row.plane === 'retract' || row.plane === 'feed'
      ? `${row.formula}. ${safetyOwnershipLabel}.`
      : row.formula
  const conventionalHeightRow = (row: typeof conventionalHeightRows[number]) => (
    <div className="props-group props-height-row" data-testid={`props-height-row-${row.plane}`} key={row.plane}>
      <div className="props-label">
        <span>{row.label}</span>
        <span
          data-testid={`props-height-authority-${row.plane}`}
          style={{
            display: 'block',
            color: row.authority === 'User Override' ? 'var(--accent)' : undefined,
            opacity: 0.76,
            fontSize: '0.86em',
          }}
        >
          {row.authority}
        </span>
      </div>
      <div
        className="props-value props-resolved-heights"
        data-testid={`props-height-value-${row.plane}`}
        data-tooltip={heightRowTooltip(row)}
        aria-describedby={`props-height-formula-${op.id}-${row.plane}`}
      >
        <div className="props-height-value-line">
          {row.onChange ? (
            <>
              <NumericInput
                className="props-number-input"
                value={lengthFieldValue(row.resolved ?? row.legacy, displayUnits)}
                step={0.5}
                units={displayUnits}
                kind="dim"
                tooltip={heightRowTooltip(row)}
                ariaLabel={tx('PropertiesPanel.Resolved_WCS_height', { p1: row.label })}
                onChange={row.onChange}
              />
              <span className="props-height-unit">{tx('PropertiesPanel.WCS_2', { p1: unitLabel(displayUnits) })}</span>
            </>
          ) : (
            <span className="props-height-unit">{row.resolved === undefined
              ? (liveHeightPlanKey ? tx('PropertiesPanel.Resolving_current_inputs') : tx('PropertiesPanel.Not_resolved'))
              : `${fmtDim(row.resolved, displayUnits)} ${unitLabel(displayUnits)} WCS`}</span>
          )}
        </div>
        {/* The derivation, as the value's accessible description: hidden, read
            by assistive tech alongside the hover tooltip above. */}
        <span
          hidden
          id={`props-height-formula-${op.id}-${row.plane}`}
          data-testid={`props-height-formula-${row.plane}`}
        >
          {row.formula}
        </span>
      </div>
    </div>
  )

  const resetHeightsToSetupDefault = () => {
    if (!activeSetupId || !ownerSetup) return
    const setupIntent = setupDefaultHeightIntent(ownerSetup)
    const reset = refreshSetupOwnedSmartHeightSafety(op, ownerSetup.id, setupIntent, true)
    if (!reset) return
    pushHistory()
    updateOperation(activeSetupId, op.id, {
      ...reset,
      ...STALE,
    })
  }
  const pickedDatum = refParams.referencePlaneGeo
  const pickedDatumGeometry = pickedDatum
    ? project.geometry.find((geometry) => geometry.id === pickedDatum.geoId)
    : undefined
  const pickedDatumWcsZ =
    ownerSetup && pickedDatum && pickedDatumGeometry
      ? resolveGeometryZToFrames(pickedDatum.localZ, pickedDatumGeometry, ownerSetup).wcsZ
      : undefined

  const tool = toolLibrary.find((t) => t.id === op.toolId)

  return (
    <EngraveVcarveFieldHelp operation={op.type}>
      {/* Scrolling body — the props-section sits inside the panel-body scroll. */}
      {/* WO-1960: the section is the containing box for its rows. Without it the
          rows' offset parent is the page, so every row scrolled below the fold
          reads as "escapes its parent" - a scroll position, not a fit defect. */}
      <div className="props-section props-section-op" style={{ position: 'relative' }}>
        {/* P12 quick-edit card: tool + feeds at the top, no modal hop. */}
        <QuickEditCard op={op} />

        {/* CVU-2 (the observed live-session warning): REGIME 2 ownership
            marker (see DisclosureSection.tsx) -- sticky panel chrome,
            PANEL-INTERNAL (docked in this panel, not a canvas overlay). */}
        <div className="props-group-header props-op-title" data-tooltip={op.name || op.type.replace(/_/g, ' ')} data-ui78-sanctioned="">
          {op.name || op.type.replace(/_/g, ' ')}
        </div>

        {/* Duplicate/Rename/Delete reuse the SAME duplicateOperation/
            updateOperation/removeOperation the context menu calls
            (treeContextMenu.ts op-duplicate/op-rename/op-delete,
            DesignTree.tsx:1361-1370) — the richest PP branch already, but
            it had zero row-management actions (recon finding). */}
        {activeSetupId && (
          <div className="props-group props-btn-row" data-testid="op-action-row">
            <button
              type="button"
              className="props-btn"
              data-testid="op-rename-btn"
              onClick={() => {
                const next = window.prompt(tx('PropertiesPanel.Rename_operation'), op.name || op.type.replace(/_/g, ' '))
                if (next && next.trim()) updateOperation(activeSetupId, op.id, { name: next.trim() })
              }}
              data-tooltip={tx('PropertiesPanel.Rename_operation')}
            >
              <Pencil size={12} />{tx('PropertiesPanel.Rename')}</button>
            <button
              type="button"
              className="props-btn"
              data-testid="op-duplicate-btn"
              onClick={() => duplicateOperation(activeSetupId, op.id)}
              data-tooltip={tx('PropertiesPanel.Duplicate_operation')}
            >
              <Copy size={12} />{tx('PropertiesPanel.Duplicate')}</button>
            <button
              type="button"
              className="props-btn props-btn-danger"
              data-testid="op-delete-btn"
              onClick={() => removeOperation(activeSetupId, op.id)}
              data-tooltip={tx('PropertiesPanel.Delete_operation')}
            >
              <Trash2 size={12} />{tx('PropertiesPanel.Delete_2')}</button>
          </div>
        )}

        <CollapsibleGroup groupId="op-summary" title={tx('PropertiesPanel.Summary')}>
          <div className="props-group">
            <div className="props-label">{tx('PropertiesPanel.Type')}</div>
            <div className="props-value">{op.type.replace(/_/g, ' ')}</div>
          </div>
          <div className="props-group">
            <div className="props-label">{tx('PropertiesPanel.Status')}</div>
            {/* WO-2663: an outdated operation says why, in the same row. */}
            {op.status === 'outdated' && op.outdatedReason && !op.modelReferenceNote ? (
              <div
                className={`props-value status-${op.status}`}
                style={{ whiteSpace: 'normal' }}
                data-tooltip={tx('PropertiesPanel.Outdated_because_regenerate', { reason: outdatedReasonText(op.outdatedReason) })}
              >
                {tx('PropertiesPanel.Status_outdated_because', { status: op.status, reason: outdatedReasonText(op.outdatedReason) })}
              </div>
            ) : (
              <div className={`props-value status-${op.status}`}>{op.status}</div>
            )}
          </div>
          {op.status === 'error' && op.errorMessage && (
            <div className="props-group props-error-msg">
              <div className="props-label">{tx('PropertiesPanel.Error')}</div>
              <div className="props-value props-value-error" data-tooltip={op.errorMessage}>{op.errorMessage}</div>
            </div>
          )}
          {/* CAM-BINDING Stage 1: a modeled-body source with no Stage 2 compute
              path yet. Deliberately NOT styled props-value-error - nothing is
              broken, the op is just waiting on Stage 2. */}
          {op.status === 'unsupported' && (
            <div className="props-group props-error-msg">
              <div className="props-label">{tx('PropertiesPanel.Model')}</div>
              <div className="props-value" data-tooltip={op.errorMessage}>
                {op.errorMessage ?? tx('PropertiesPanel.Modeled_body_source_compute_not_yet_supported')}
              </div>
            </div>
          )}
          {/* CAM-1: model-reference re-resolution note (which geometry moved or
              was lost). Shown for degraded (geometry gone) and for a stale op
              that carries a fallback note. */}
          {(op.status === 'degraded' || (op.status === 'outdated' && op.modelReferenceNote)) && op.modelReferenceNote && (
            <div className="props-group props-error-msg">
              <div className="props-label">{tx('PropertiesPanel.Model')}</div>
              <div
                className={`props-value ${op.status === 'degraded' ? 'props-value-error' : ''}`}
                data-tooltip={op.modelReferenceNote}
              >
                {op.modelReferenceNote}
              </div>
            </div>
          )}
          {op.status === 'ready' && !op.estimatedCutTimeMsError && op.estimatedCutTimeMs !== undefined && (
            <div className="props-group">
              <div className="props-label">{tx('PropertiesPanel.Cut_time')}</div>
              <div className="props-value" data-tooltip={tx('PropertiesPanel.Estimated_machine_run_time_for_this_operation')}>
                {formatDurationHMS(op.estimatedCutTimeMs)}
              </div>
            </div>
          )}
          {op.status === 'ready' && op.estimatedCutTimeMsError && (
            <div className="props-group">
              <div className="props-label">{tx('PropertiesPanel.Cut_time')}</div>
              <div className="props-value props-value-error" data-tooltip={op.estimatedCutTimeMsError}>{tx('PropertiesPanel.Unavailable_recompute_to_fix')}</div>
            </div>
          )}
          {op.status === 'ready' && op.computeTimeMs !== undefined && (
            <div className="props-group">
              <div className="props-label">{tx('PropertiesPanel.Computed_in')}</div>
              <div className="props-value" data-tooltip={tx('PropertiesPanel.Wall_clock_time_to_calculate_this_toolpath_diagnostic')}>
                {formatComputeMs(op.computeTimeMs)}
              </div>
            </div>
          )}
          {op.status === 'ready' && op.diagnostics?.adaptiveRough && (
            <AdaptiveRoughDiagnosticRows diagnostics={op.diagnostics.adaptiveRough} />
          )}
          {op.status === 'ready' && isValidReachShortfall(op.reachShortfall) && (
            <ReachShortfallNotice shortfall={op.reachShortfall} />
          )}
          <div className="props-group">
            <div className="props-label">{tx('PropertiesPanel.Geometry')}</div>
            <div
              className="props-value"
              data-tooltip={op.geometrySelections.length === 0
                ? tx('PropertiesPanel.No_explicit_selection_the_operation_machines_every_loop_of')
                : undefined}
            >
              {op.geometrySelections.length === 0
                ? tx('PropertiesPanel.All_loops_auto')
                : tx('PropertiesPanel.Census_selected', { p1: op.geometrySelections.length })}
            </div>
          </div>
        </CollapsibleGroup>

        <CollapsibleGroup groupId="op-heights" title={tx('PropertiesPanel.Heights')}>
          {/* WO-2007: ownership is the safety rows' tooltip; only the action
              that changes it earns a row, and only when there is something
              to reset. */}
          {heightSafetyOwnership !== 'invalid' && heightSafetyOwnership !== 'setup' && (
            <div className="props-group" data-testid="op-height-reset-row">
              <div className="props-label">{tx('PropertiesPanel.Safety')}</div>
              <div className="props-value" data-tooltip={safetyOwnershipLabel}>
                <button
                  type="button"
                  className="op-toggle-btn"
                  data-testid="op-reset-heights-to-setup"
                  onClick={resetHeightsToSetupDefault}
                >{tx('PropertiesPanel.Reset_safety_to_setup')}</button>
              </div>
            </div>
          )}
          {heightSafetyOwnership === 'invalid' && (
            <div className="props-group" data-testid="op-height-repair-required">
              <div className="props-label">{tx('PropertiesPanel.Required')}</div>
              <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                {SMART_HEIGHT_V2_REPAIR_MESSAGE}
              </div>
            </div>
          )}
          {/* WO-2007 (COHESION-STANDARD 21): the full resolved-plan breakdown
              lives in the operation editor's Heights tab. The panel keeps only
              a refusal - the operation cannot compute until it is fixed. */}
          {liveHeightPlan?.ok === false && (
            <div className="props-group" data-testid="props-height-refusal">
              <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
              <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                {liveHeightPlan.message}
              </div>
            </div>
          )}
          {op.type === 'adaptive_3d' && (
            <>
              <div className="props-group" data-testid="props-adaptive3d-height-policy">
                <div className="props-label">{tx('PropertiesPanel.Material')}</div>
                <div className="props-value">
                  <select
                    className="props-number-input"
                    aria-label={tx('PropertiesPanel.Adaptive_material_source')}
                    value={adaptive3dHeightDraft?.mode ?? 'repair_required'}
                    onChange={event => setAdaptive3dHeightPolicy(event.target.value as Adaptive3dMaterialMode)}
                  >
                    {!adaptive3dHeightDraft && <option value="repair_required" disabled>{tx('PropertiesPanel.Repair_required')}</option>}
                    <option value="current_material">{tx('PropertiesPanel.Current_material')}</option>
                    <option value="initial_stock">{tx('PropertiesPanel.Initial_stock')}</option>
                    <option value="bounded_band">{tx('PropertiesPanel.Explicit_WCS_band')}</option>
                  </select>
                </div>
              </div>
              {!adaptive3dHeightDraft && (
                <div className="props-group" data-testid="props-adaptive3d-repair-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Required')}</div>
                  <div className="props-value" style={{ whiteSpace: 'normal' }}>
                    {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                  </div>
                </div>
              )}
              {adaptive3dHeightDraft?.mode === 'bounded_band' && (
                <>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Band_top')}</div>
                    <div className="props-value">
                      <NumericInput
                        className="props-number-input"
                        value={lengthFieldValue(adaptive3dHeightDraft.topWcsMm, displayUnits)}
                        step={0.1}
                        units={displayUnits}
                        kind="dim"
                        onChange={topWcsMm => commitAdaptive3dBand({ topWcsMm })}
                      />
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Band_bottom')}</div>
                    <div className="props-value">
                      <NumericInput
                        className="props-number-input"
                        value={lengthFieldValue(adaptive3dHeightDraft.bottomWcsMm, displayUnits)}
                        step={0.1}
                        units={displayUnits}
                        kind="dim"
                        onChange={bottomWcsMm => commitAdaptive3dBand({ bottomWcsMm })}
                      />
                    </div>
                  </div>
                </>
              )}
            </>
          )}
          {op.type === 'waterline_3d' && (
            <>
              {waterline3dSmartPanelState?.kind === 'smart_v2' ? (
                <>
                  <div className="props-group" data-testid="props-waterline3d-height-policy">
                    <div className="props-label">{tx('PropertiesPanel.Target_policy')}</div>
                    <div className="props-value">
                      <select
                        className="props-number-input"
                        aria-label={tx('PropertiesPanel.Waterline_target_policy')}
                        value={waterline3dSmartPanelState.draft.mode}
                        onChange={event => setW3d({
                          finishDepth: event.target.value === 'target_surface'
                            ? undefined
                            : Math.max(0.1, waterline3dSmartPanelState.draft.finishDepthMm ?? 1),
                        })}
                      >
                        <option value="target_surface">{tx('PropertiesPanel.Full_target_surface')}</option>
                        <option value="bounded_surface">{tx('PropertiesPanel.Depth_limit_below_model_Top')}</option>
                      </select>
                    </div>
                  </div>
                  {waterline3dSmartPanelState.draft.mode === 'bounded_surface' && (
                    <div className="props-group" data-testid="props-waterline3d-depth-limit">
                      <div className="props-label">{tx('PropertiesPanel.Depth_limit')}</div>
                      <div className="props-value">
                        <NumericInput
                          className="props-number-input"
                          value={waterline3dSmartPanelState.draft.finishDepthMm ?? 1}
                          min={0.001}
                          step={0.1}
                          units={displayUnits}
                          kind="dim"
                          onChange={finishDepth => setW3d({ finishDepth })}
                        />
                      </div>
                    </div>
                  )}
                </>
              ) : waterline3dSmartPanelState?.kind === 'invalid' ? (
                <div className="props-group" data-testid="props-waterline3d-invalid-height-note">
                  <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                  <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                    {waterline3dSmartPanelState.message}
                  </div>
                </div>
              ) : null}
            </>
          )}
          {(op.type === 'parallel_3d' || op.type === 'steep_shallow_3d' || op.type === 'scallop_3d' || op.type === 'pencil_3d') && (
            <>
              {parallel3dSmartPanelState?.kind === 'smart_v2' ? (
                <>
                  <div className="props-group" data-testid="props-parallel3d-height-policy">
                    <div className="props-label">{tx('PropertiesPanel.Target_policy')}</div>
                    <div className="props-value">
                      <select
                        className="props-number-input"
                        aria-label={tx('PropertiesPanel.Parallel_target_policy')}
                        value={parallel3dSmartPanelState.draft.mode}
                        onChange={event => (op.type === 'steep_shallow_3d' ? setSs3d : op.type === 'scallop_3d' ? setScallop3d : op.type === 'pencil_3d' ? setPencil3d : setP3d)({
                          finishDepth: event.target.value === 'target_surface'
                            ? undefined
                            : Math.max(0.1, parallel3dSmartPanelState.draft.finishDepthMm ?? 1),
                        })}
                      >
                        <option value="target_surface">{tx('PropertiesPanel.Full_target_surface')}</option>
                        <option value="bounded_surface">{tx('PropertiesPanel.Depth_limit_below_model_Top')}</option>
                      </select>
                    </div>
                  </div>
                  {parallel3dSmartPanelState.draft.mode === 'bounded_surface' && (
                    <div className="props-group" data-testid="props-parallel3d-depth-limit">
                      <div className="props-label">{tx('PropertiesPanel.Depth_limit')}</div>
                      <div className="props-value">
                        <NumericInput
                          className="props-number-input"
                          value={parallel3dSmartPanelState.draft.finishDepthMm ?? 1}
                          min={0.001}
                          step={0.1}
                          units={displayUnits}
                          kind="dim"
                          onChange={finishDepth => (op.type === 'steep_shallow_3d' ? setSs3d : op.type === 'scallop_3d' ? setScallop3d : op.type === 'pencil_3d' ? setPencil3d : setP3d)({ finishDepth })}
                        />
                      </div>
                    </div>
                  )}
                </>
              ) : parallel3dSmartPanelState?.kind === 'invalid' ? (
                <>
                  <div className="props-group" data-testid="props-parallel3d-invalid-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                    <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                      {parallel3dSmartPanelState.message}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Repair')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-parallel3d-repair-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Open_operation_editor')}</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="props-group" data-testid="props-parallel3d-repair-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Required')}</div>
                  <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                    <span>{SMART_HEIGHT_V2_REPAIR_MESSAGE}</span>
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="props-parallel3d-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_and_repair')}</button>
                  </div>
                </div>
              )}
            </>
          )}
          {isDrillBoreOperation && (
            <>
              {drillBoreSmartPanelState?.kind === 'smart_v2' ? (
                <>
                  <div className="props-group" data-testid="props-drill-bore-height-policy">
                    <div className="props-label">{tx('PropertiesPanel.Depth_policy')}</div>
                    <div className="props-value">
                      {drillBoreSmartPanelState.draft.mode === 'detected_features'
                        ? tx('PropertiesPanel.Detected_physical_floors')
                        : tx('PropertiesPanel.Explicit_WCS_planes')}
                    </div>
                  </div>
                  {/* WO-2514: an explicit-depth Drill breaks through by the same setting. */}
                  {(drillBoreSmartPanelState.draft.mode === 'detected_features' || op.type === 'drill') && (
                      <div className="props-group" data-testid="props-drill-bore-breakthrough">
                        <div className="props-label">{tx('PropertiesPanel.Breakthrough')}</div>
                        <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <NumericInput
                            className="props-number-input"
                            value={op.type === 'drill'
                              ? (drillParams.breakthroughMm ?? 0)
                              : (boreParams.breakthroughMm ?? 0)}
                            min={0}
                            step={0.1}
                            units={displayUnits}
                            kind="dim"
                            tooltip={tx('PropertiesPanel.Additional_cutter_travel_past_each_proven_physical_floor_applied')}
                            onChange={value => op.type === 'drill'
                              ? commitDrillParams({ breakthroughMm: value })
                              : commitBoreParams({ breakthroughMm: value })}
                          />
                          <span>{unitLabel(displayUnits)}</span>
                        </div>
                      </div>
                  )}
                  {drillBreakThroughReason && (
                      <p className="op-hint" data-testid="props-drill-break-through-default-note">
                        {drillBreakThroughReason}
                      </p>
                  )}
                  {drillBoreSmartPanelState.draft.mode === 'explicit_depth' && op.type === 'drill' &&
                    (drillParams.breakthroughMm ?? 0) > 0 && resolvedBottomWcs !== undefined && (
                      <p className="op-hint" data-testid="props-drill-breakthrough-note">
                        {tx('PropertiesPanel.Break_through_tip', {
                          p1: fmtMachineLength(resolvedBottomWcs, displayUnits),
                          p2: unitLabel(displayUnits),
                          p3: fmtMachineLength(drillParams.breakthroughMm ?? 0, displayUnits),
                        })}
                      </p>
                  )}
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Edit_2')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-drill-bore-edit-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Edit_depth_policy')}</button>
                    </div>
                  </div>
                </>
              ) : drillBoreSmartPanelState?.kind === 'invalid' ? (
                <>
                  <div className="props-group" data-testid="props-drill-bore-invalid-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                    <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                      {drillBoreSmartPanelState.message}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Repair')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-drill-bore-repair-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Open_operation_editor')}</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="props-group" data-testid="props-drill-bore-repair-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Required')}</div>
                  <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                    <span>{SMART_HEIGHT_V2_REPAIR_MESSAGE}</span>
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="props-drill-bore-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_and_repair')}</button>
                  </div>
                </div>
              )}
            </>
          )}
          {op.type === 'thread_mill' && (() => {
            // An op whose kind/hand/cut cannot resolve shows no choice here
            // (its compute says why); the panel itself must still render.
            let threadMotion: ReturnType<typeof resolveThreadMotion>
            try {
              threadMotion = resolveThreadMotion(
                op.params as unknown as ThreadMillParams,
                tool ? spindleSignForTool(tool) : 1,
              )
            } catch {
              return null
            }
            return (
              <div className="props-group" data-testid="props-thread-mill-direction">
                <div className="props-label">{txDir('direction')}</div>
                <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                  <div className="op-toggle-row">
                    <button
                      type="button"
                      className={`op-toggle-btn ${threadMotion.axialDirection === 'bottom-up' ? 'op-toggle-active' : ''}`}
                      data-testid="props-thread-direction-bottom-up"
                      onClick={() => commitThreadAxialDirection('bottom-up')}
                    >{txDir('bottomUp')}</button>
                    <button
                      type="button"
                      className={`op-toggle-btn ${threadMotion.axialDirection === 'top-down' ? 'op-toggle-active' : ''}`}
                      data-testid="props-thread-direction-top-down"
                      onClick={() => commitThreadAxialDirection('top-down')}
                    >{txDir('topDown')}</button>
                  </div>
                  <span data-testid="props-thread-direction-result">
                    {threadMotion.cut === 'climb' ? txDir('resultClimb') : txDir('resultConventional')}
                  </span>
                </div>
              </div>
            )
          })()}
          {op.type === 'thread_mill' && (
            <>
              {threadMillSmartPanelState?.kind === 'smart_v2' ? (
                <>
                  <div className="props-group" data-testid="props-thread-mill-height-policy">
                    <div className="props-label">{tx('PropertiesPanel.Thread_band')}</div>
                    <div className="props-value" style={{ whiteSpace: 'normal' }}>
                      {threadMillSmartPanelState.draft.threadKind === 'internal'
                        ? tx('PropertiesPanel.Internal_down_from_bore_top')
                        : threadMillSmartPanelState.draft.externalReference === 'base'
                          ? tx('PropertiesPanel.External_up_from_boss_base')
                          : tx('PropertiesPanel.External_down_from_boss_top')}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Edit_2')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-thread-mill-edit-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Edit_thread_band')}</button>
                    </div>
                  </div>
                </>
              ) : threadMillSmartPanelState?.kind === 'invalid' ? (
                <>
                  <div className="props-group" data-testid="props-thread-mill-invalid-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                    <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                      {threadMillSmartPanelState.message}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Repair')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-thread-mill-repair-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Open_operation_editor')}</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="props-group" data-testid="props-thread-mill-repair-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Required')}</div>
                  <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                    <span>{SMART_HEIGHT_V2_REPAIR_MESSAGE}</span>
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="props-thread-mill-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_and_repair')}</button>
                  </div>
                </div>
              )}
            </>
          )}
          {op.type === 'chamfer' && (
            <>
              {chamferSmartPanelState?.kind === 'smart_v2' ? (
                <>
                  <div className="props-group" data-testid="props-chamfer-height-policy">
                    <div className="props-label">{tx('PropertiesPanel.Chamfer_datum')}</div>
                    <div className="props-value" style={{ whiteSpace: 'normal' }}>
                      {`${(uiReferenceForIntentReference(chamferSmartPanelState.draft.datumReference) ?? chamferSmartPanelState.draft.datumReference).replaceAll('_', ' ')} + ${fmtDim(chamferSmartPanelState.draft.datumOffsetMm, displayUnits)} ${unitLabel(displayUnits)}`}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Edit_2')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-chamfer-edit-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Edit_chamfer_formula')}</button>
                    </div>
                  </div>
                </>
              ) : chamferSmartPanelState?.kind === 'invalid' ? (
                <>
                  <div className="props-group" data-testid="props-chamfer-invalid-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                    <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                      {chamferSmartPanelState.message}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Repair')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-chamfer-repair-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Open_operation_editor')}</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="props-group" data-testid="props-chamfer-repair-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Required')}</div>
                  <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                    <span>{SMART_HEIGHT_V2_REPAIR_MESSAGE}</span>
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="props-chamfer-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_and_repair')}</button>
                  </div>
                </div>
              )}
            </>
          )}
          {op.type === 'contour_2d' && (
            <>
              {contourSmartPanelState?.kind === 'smart_v2' ? (
                <>
                  <div className="props-group" data-testid="props-contour-height-policy">
                    <div className="props-label">{tx('PropertiesPanel.End_policy')}</div>
                    <div className="props-value">
                      {contourSmartPanelState.draft.mode === 'selected_feature'
                        ? tx('PropertiesPanel.Detected_feature_floor')
                        : contourSmartPanelState.draft.mode === 'stock_bottom'
                          ? tx('PropertiesPanel.Stock_bottom')
                          : contourSmartPanelState.draft.mode === 'through_stock'
                            ? tx('PropertiesPanel.Through_stock')
                            : contourSmartPanelState.draft.mode === 'model_bottom'
                              ? tx('PropertiesPanel.Target_model_bottom')
                              : tx('PropertiesPanel.Explicit_WCS_plane')}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Edit_2')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-contour-edit-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Edit_Target_End')}</button>
                    </div>
                  </div>
                </>
              ) : contourSmartPanelState?.kind === 'invalid' ? (
                <>
                  <div className="props-group" data-testid="props-contour-invalid-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                    <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                      {contourSmartPanelState.message}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Repair')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-contour-repair-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Open_operation_editor')}</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="props-group" data-testid="props-contour-repair-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Required')}</div>
                  <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                    <span>{SMART_HEIGHT_V2_REPAIR_MESSAGE}</span>
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="props-contour-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_and_repair')}</button>
                  </div>
                </div>
              )}
            </>
          )}
          {isPlanarRoughOperation && (
            <>
              {planarRoughSmartPanelState?.kind === 'smart_v2' ? null : planarRoughSmartPanelState?.kind === 'invalid' ? (
                <>
                  <div className="props-group" data-testid="props-planar-rough-invalid-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                    <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                      {planarRoughSmartPanelState.message}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Repair')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-planar-rough-repair-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Open_operation_editor')}</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="props-group" data-testid="props-planar-rough-repair-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Required')}</div>
                  <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                    <span>{SMART_HEIGHT_V2_REPAIR_MESSAGE}</span>
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="props-planar-rough-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_and_repair')}</button>
                  </div>
                </div>
              )}
            </>
          )}
          {op.type === 'engrave' && (
            <>
              {engraveSmartPanelState?.kind === 'smart_v2' ? (
                <>
                  <div className="props-group" data-testid="props-engrave-height-policy">
                    <div className="props-label">{tx('PropertiesPanel.Depth_policy')}</div>
                    <div className="props-value" style={{ whiteSpace: 'normal' }}>
                      {engraveSmartPanelState.draft.followSurface
                        ? engraveSmartPanelState.draft.depth.kind === 'explicit'
                          ? tx('PropertiesPanel.Follows_the_part_surface')
                          : tx('PropertiesPanel.Follows_the_part_surface_width_from_tool_geometry')
                        : engraveSmartPanelState.draft.depth.kind === 'explicit'
                        ? tx('PropertiesPanel.Explicit_physical_depth')
                        : tx('PropertiesPanel.Width_derived_from_tool_geometry')}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Edit_2')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-engrave-edit-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Edit_engraving_intent')}</button>
                    </div>
                  </div>
                </>
              ) : engraveSmartPanelState?.kind === 'invalid' ? (
                <>
                  <div className="props-group" data-testid="props-engrave-invalid-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                    <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                      {engraveSmartPanelState.message}
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Repair')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-engrave-repair-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Open_operation_editor')}</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="props-group" data-testid="props-engrave-repair-height-note">
                    <div className="props-label">{tx('PropertiesPanel.Required')}</div>
                  <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                    <span>{SMART_HEIGHT_V2_REPAIR_MESSAGE}</span>
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="props-engrave-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_and_repair')}</button>
                  </div>
                </div>
              )}
            </>
          )}
          {op.type === 'vcarve' && (
            <>
              {vcarveSmartPanelState?.kind === 'smart_v2' ? (
                <>
                  <div className="props-group" data-testid="props-vcarve-start-depth">
                    <div className="props-label">{tx('PropertiesPanel.Start_depth')}</div>
                    <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <NumericInput
                        className="props-number-input"
                        value={vcarveParams.startDepthMm}
                        min={0}
                        max={50}
                        step={0.1}
                        units={displayUnits}
                        tooltip={tx('PropertiesPanel.Carving_starts_this_far_below_the_datum_surface')}
                        onChange={(startDepthMm) => commitVCarveParams({ startDepthMm })}
                      />
                      <span>{unitLabel(displayUnits)}</span>
                    </div>
                  </div>
                  <div className="props-group" data-testid="props-vcarve-flat-depth">
                    <div className="props-label">{tx('PropertiesPanel.Flat_depth')}</div>
                    <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'normal' }}>
                      {vcarveParams.flatDepthMm === undefined ? (
                        <>
                          <span>{tx('PropertiesPanel.Bit_s_own_limit')}</span>
                          {vcarveParams.role === 'carve' && (
                            <button
                              type="button"
                              className="op-toggle-btn"
                              data-testid="props-vcarve-set-flat-depth"
                              onClick={() => commitVCarveParams({ flatDepthMm: 2 })}
                            >{tx('PropertiesPanel.Set_a_flat_depth')}</button>
                          )}
                        </>
                      ) : (
                        <>
                          <NumericInput
                            className="props-number-input"
                            value={vcarveParams.flatDepthMm}
                            min={0.05}
                            max={50}
                            step={0.1}
                            units={displayUnits}
                            tooltip={tx('PropertiesPanel.Deepest_the_tip_goes_below_Material_Start_wider_areas')}
                            onChange={(flatDepthMm) => commitVCarveParams({ flatDepthMm })}
                          />
                          <span>{unitLabel(displayUnits)}</span>
                          {vcarveParams.role === 'carve' && (
                            <button
                              type="button"
                              className="op-toggle-btn"
                              data-testid="props-vcarve-clear-flat-depth"
                              onClick={() => commitVCarveParams({ flatDepthMm: undefined })}
                            >{tx('PropertiesPanel.Use_the_bit_s_limit')}</button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {vcarveParams.role === 'carve' && (
                      <div className="props-group" data-testid="props-vcarve-allowance">
                        <div className="props-label">{tx('PropertiesPanel.Allowance')}</div>
                        <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <NumericInput
                            className="props-number-input"
                            value={vcarveParams.allowanceMm}
                            min={-10}
                            max={10}
                            step={0.05}
                            units={displayUnits}
                            tooltip={tx('PropertiesPanel.Signed_offset_of_the_outlines_before_carving_positive_grows')}
                            onChange={(allowanceMm) => commitVCarveParams({ allowanceMm })}
                          />
                          <span>{unitLabel(displayUnits)}</span>
                        </div>
                      </div>
                  )}
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Edit_2')}</div>
                    <div className="props-value">
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="props-vcarve-edit-height"
                        onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                      >{tx('PropertiesPanel.Edit_carve_settings')}</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="props-group" data-testid="props-vcarve-invalid-height-note">
                  <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                  <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                    <span className="props-value-error">{vcarveSmartPanelState?.message ?? SMART_HEIGHT_V2_REPAIR_MESSAGE}</span>
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="props-vcarve-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_and_repair')}</button>
                  </div>
                </div>
              )}
            </>
          )}
          {op.type === 'face' && (
            <>
              {faceSmartPanelState?.kind === 'smart_v2' ? (
                <>
                  {faceSmartPanelState.draft.mode === 'target_face' ? (
                    <div className="props-group" data-testid="props-face-target-face">
                      <div className="props-label">{tx('PropertiesPanel.Finished_face')}</div>
                      <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5 }}>
                        <span style={{ whiteSpace: 'normal' }}>
                          {faceParams.targetPlaneGeo
                            ? tx('PropertiesPanel.Census_face', { p1: project.geometry.find(candidate => candidate.id === faceParams.targetPlaneGeo?.geoId)?.name ?? faceParams.targetPlaneGeo.geoId, p2: faceParams.targetPlaneGeo.faceIndex })
                            : tx('PropertiesPanel.Target_binding_is_missing_Regeneration_will_refuse_this_operation')}
                        </span>
                        <button
                          type="button"
                          className="op-toggle-btn"
                          data-testid="props-face-edit-target"
                          onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                        >{tx('PropertiesPanel.Re_pick_in_operation_editor')}</button>
                      </div>
                    </div>
                  ) : faceSmartPanelState.draft.mode === 'model_top' ? (
                    <div className="props-group props-height-row" data-testid="props-face-model-top">
                      <div className="props-label">
                        <span>{tx('PropertiesPanel.Physical_target')}</span>
                        <span
                          data-testid="props-face-model-top-source"
                          style={{ display: 'block', opacity: 0.76, fontSize: '0.86em' }}
                        >{tx('PropertiesPanel.Model_top')}</span>
                      </div>
                      <div className="props-value props-resolved-heights" data-testid="props-face-model-top-value">
                        <div className="props-height-value-line">
                          {faceModelTopWcs === undefined ? (
                            <span className="props-height-unit">{liveHeightPlanKey
                              ? tx('PropertiesPanel.Resolving_current_inputs')
                              : tx('PropertiesPanel.Not_resolved')}</span>
                          ) : (
                            <>
                              <NumericInput
                                className="props-number-input"
                                value={faceModelTopWcs}
                                step={0.5}
                                units={displayUnits}
                                kind="dim"
                                tooltip={tx('PropertiesPanel.Absolute_work_coordinate_Z_of_the_finished_face_not')}
                                ariaLabel={tx('PropertiesPanel.Physical_target')}
                                onChange={commitFaceExplicitTarget}
                              />
                              <span className="props-height-unit">{tx('PropertiesPanel.WCS_2', { p1: unitLabel(displayUnits) })}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="props-group" data-testid="props-face-explicit-target">
                      <div className="props-label">
                        <span>{tx('PropertiesPanel.Physical_target')}</span>
                        {faceModelTopAvailable && (
                          <button
                            type="button"
                            data-testid="props-face-use-model-top"
                            onClick={commitFaceModelTop}
                            style={{
                              display: 'block', background: 'none', border: 'none', padding: 0,
                              color: 'var(--accent)', cursor: 'pointer', fontSize: '0.86em', textAlign: 'left',
                            }}
                          >{tx('PropertiesPanel.Use_model_top')}</button>
                        )}
                      </div>
                      <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <NumericInput
                          className="props-number-input"
                          value={lengthFieldValue(faceSmartPanelState.draft.explicitTargetWcsMm, displayUnits)}
                          step={0.5}
                          units={displayUnits}
                          kind="dim"
                          tooltip={tx('PropertiesPanel.Absolute_work_coordinate_Z_of_the_finished_face_not')}
                          onChange={commitFaceExplicitTarget}
                        />
                        <span>{tx('PropertiesPanel.WCS_2', { p1: unitLabel(displayUnits) })}</span>
                      </div>
                    </div>
                  )}
                </>
              ) : faceSmartPanelState?.kind === 'invalid' ? (
                <div className="props-group" data-testid="props-face-invalid-height-note">
                  <div className="props-label">{tx('PropertiesPanel.Cannot_resolve')}</div>
                  <div className="props-value props-value-error" style={{ whiteSpace: 'normal' }}>
                    {faceSmartPanelState.message}
                  </div>
                </div>
              ) : (
              <div className="props-group" data-testid="props-face-repair-height-note">
                  <div className="props-label">{tx('PropertiesPanel.Required')}</div>
                  <div className="props-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5, whiteSpace: 'normal' }}>
                    <span>{SMART_HEIGHT_V2_REPAIR_MESSAGE}</span>
                    <button
                      type="button"
                      className="op-toggle-btn"
                    data-testid="props-face-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_and_repair')}</button>
                  </div>
                </div>
              )}
              {faceSmartPanelState?.kind === 'invalid' && (
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Repair')}</div>
                  <div className="props-value">
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="props-face-repair-height"
                      onClick={() => activeSetupId && openEditOperation(activeSetupId, op.id)}
                    >{tx('PropertiesPanel.Open_operation_editor')}</button>
                  </div>
                </div>
              )}
            </>
          )}
          {conventionalHeightRows.map(conventionalHeightRow)}
          <div className="props-group" data-testid="props-minimize-z-travel">
            <label className="props-label">
              <input type="checkbox" checked={op.heights.minimizeZTravel !== false}
                onChange={e => commitHeights({ minimizeZTravel: e.target.checked })} />
              {tx('PropertiesPanel.Minimize_Z_travel')}
            </label>
            <div className="props-value">{tx('PropertiesPanel.Unchecked_hops_at_Retract')}</div>
          </div>
          {showRefPlane && (
            <>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Ref_plane')}</div>
                <div className="props-value">
                  <RefPlaneSelect
                    className="props-number-input"
                    testId="op-ref-plane-select"
                    value={currentRef}
                    onChange={commitRefPlane}
                  />
                </div>
              </div>
              {currentRef === 'picked_plane' && (
                <div
                  className="props-group"
                  data-testid="properties-picked-surface"
                  style={{ alignItems: 'flex-start' }}
                >
                  <div className="props-label">{tx('PropertiesPanel.Surface')}</div>
                  <div
                    className="props-value"
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5 }}
                  >
                    <button
                      type="button"
                      className="op-toggle-btn"
                      data-testid="properties-pick-datum-face"
                      disabled={!canPickReferenceFace}
                      onClick={datumPickActive ? cancelDatumPick : startDatumPick}
                    >
                      {datumPickActive
                        ? tx('PropertiesPanel.Cancel_face_pick')
                        : pickedDatum
                          ? tx('PropertiesPanel.Re_pick_face_in_viewport')
                          : tx('PropertiesPanel.Pick_face_in_viewport')}
                    </button>
                    <span data-testid="properties-picked-datum-readout" style={{ whiteSpace: 'normal' }}>
                      {pickedDatum && pickedDatumWcsZ !== undefined
                        ? tx('PropertiesPanel.Face_WCS_Z', { p1: pickedDatum.faceIndex, p2: fmtDim(pickedDatumWcsZ, displayUnits), p3: unitLabel(displayUnits) })
                        : canPickReferenceFace
                          ? tx('PropertiesPanel.No_surface_picked')
                          : tx('PropertiesPanel.Picked_surfaces_require_a_loaded_STEP_solid_to_pick')}
                    </span>
                    {datumPickError !== null && (
                      <span
                        data-testid="properties-picked-datum-error"
                        className="props-value-error"
                        style={{ whiteSpace: 'normal' }}
                      >
                        {datumPickError}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {numRow(tx('PropertiesPanel.Plane_offset'), currentOffset, commitPlaneOffset,
                { min: -9999, step: 0.1, get title() { return tx('PropertiesPanel.Offset_from_the_reference_plane_mm_Positive_above_negative') } })}
            </>
          )}
          {/* WO-2835: one floor-hop setting, saved in the operation's linking, on every
              operation whose travels between cuts hop over a cleared floor. No maximum:
              the engine caps every hop at the clearance height itself. */}
          {FLOOR_HOP_OPERATION_TYPES.has(op.type) && (
            <div data-testid="props-floor-hop">
              {numRow(tx('PropertiesPanel.Floor_hop'), resolveFloorHopMm(op.linking), commitFloorHop,
                { min: 0, step: 0.1, get title() { return tx('PropertiesPanel.Lift_over_cleared_floors_on_travel_moves') } })}
            </div>
          )}
        </CollapsibleGroup>

        {op.type === 'pocket_2d' && (
          <CollapsibleGroup groupId="op-entry" title={tx('PropertiesPanel.Entry')}>
            <div className="props-group">
              <div className="props-label">{tx('PropertiesPanel.Entry_type')}</div>
              <div className="props-value">
                <select
                  className="props-number-input"
                  data-testid="props-pocket-entry-type"
                  value={pocketLinking.entryType}
                  onChange={(event) => commitPocketLinking({
                    entryType: event.target.value as LinkingParams['entryType'],
                  })}
                  data-tooltip={tx('PropertiesPanel.How_the_cutter_enters_each_pocket_depth')}
                >
                  {!pocketEntryValid && (
                    <option value={pocketLinking.entryType} disabled>
                      {tx('PropertiesPanel.Invalid', { p1: pocketLinking.entryType })}
                    </option>
                  )}
                  {pocketPolicy.allowed.map((entryType) => (
                    <option key={entryType} value={entryType}>
                      {tx(`choices.POCKET_ENTRY_LABELS.${entryType}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {!pocketEntryValid && (
              <div className="props-group props-error-msg" data-testid="props-pocket-entry-invalid">
                <div className="props-label">{tx('PropertiesPanel.Invalid_entry')}</div>
                <div className="props-value props-value-error">{tx('PropertiesPanel.Choose')}{pocketPolicy.allowed.map((entry) => tx(`choices.POCKET_ENTRY_LABELS.${entry}`)).join(tx('PropertiesPanel.Census_or'))}{tx('PropertiesPanel.symbol_3')}</div>
              </div>
            )}
            {pocketLinking.entryType === 'ramp_helical' && (
              <div className="props-group" data-testid="props-pocket-helix-diameter">
                <div className="props-label">{tx('PropertiesPanel.Helix_diameter')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <NumericInput
                    className="props-number-input"
                    value={pocketParams.helixDiameter ?? 90}
                    min={10}
                    max={95}
                    step={5}
                    tooltip={tx('PropertiesPanel.Helix_path_diameter_as_a_percentage_of_tool_diameter')}
                    onChange={(helixDiameter) => commitPocketParams({ helixDiameter })}
                  />
                  <span>{tx('PropertiesPanel.tool_dia')}</span>
                </div>
              </div>
            )}
            {(pocketLinking.entryType === 'ramp_linear'
              || pocketLinking.entryType === 'ramp_helical') && (
              <div className="props-group" data-testid="props-pocket-ramp-angle">
                <div className="props-label">{tx('PropertiesPanel.Ramp_angle')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <NumericInput
                    className="props-number-input"
                    value={pocketLinking.rampAngle}
                    min={0.5}
                    max={30}
                    step={0.5}
                    tooltip={tx('PropertiesPanel.Entry_descent_angle')}
                    onChange={(rampAngle) => commitPocketLinking({ rampAngle })}
                  />
                  <span>{tx('PropertiesPanel.deg')}</span>
                </div>
              </div>
            )}
            {pocketLinking.entryType === 'ramp_helical' && (
              <div className="props-group" data-testid="props-pocket-entry-clearance">
                <div className="props-label">{tx('PropertiesPanel.Helix_start_above_material')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <NumericInput
                    className="props-number-input"
                    value={pocketParams.entryClearance ?? 1}
                    min={0}
                    step={0.5}
                    tooltip={tx('PropertiesPanel.How_far_above_the_material_still_standing_the_helix')}
                    units={displayUnits}
                    onChange={(entryClearance) => commitPocketParams({ entryClearance })}
                  />
                  <span>{unitLabel(displayUnits)}</span>
                </div>
              </div>
            )}
          </CollapsibleGroup>
        )}

        <CollapsibleGroup groupId="op-passes" title={tx('PropertiesPanel.Passes')}>
          {op.type === 'adaptive_3d' ? (
            <div data-testid="props-adaptive3d-edit">
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Max_stepdown')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.maxStepdown}
                    min={0.1}
                    step={0.5}
                    units={displayUnits}
                    onChange={(v) => setA3d({ maxStepdown: v })}
                    tooltip={tx('PropertiesPanel.Max_axial_depth_of_cut_per_Z_level')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Stepover_fraction')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.stepover}
                    min={0.05}
                    max={1}
                    step={0.05}
                    onChange={(v) => setA3d({ stepover: v })}
                    tooltip={tx('PropertiesPanel.Radial_engagement_as_a_fraction_of_tool_diameter_0')}
                  />
                  <span className="props-quickedit-unit">{tx('PropertiesPanel.x_dia')}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Milling_direction')}</div>
                <div className="props-value">
                  <select
                    className="props-select"
                    value={a3dParams.millingDirection}
                    onChange={(event) => setA3d({
                      millingDirection: event.target.value as 'climb' | 'conventional',
                    })}
                    data-testid="props-adaptive3d-milling-direction"
                  >
                    <option value="climb">{tx('PropertiesPanel.Climb')}</option>
                    <option value="conventional">{tx('PropertiesPanel.Conventional')}</option>
                  </select>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Reduce_stair_steps')}</div>
                <label
                  className="props-value"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                  title={tx('PropertiesPanel.Adds_roughing_cuts_between_full_stepdowns_so_curved_and')}
                >
                  <input
                    type="checkbox"
                    data-testid="props-adaptive3d-reduce-stair-steps"
                    checked={a3dParams.intermediateStepdown}
                    onChange={(event) => setA3d({ intermediateStepdown: event.target.checked })}
                  />
                  <span>{a3dParams.intermediateStepdown ? tx('PropertiesPanel.On') : tx('PropertiesPanel.Off')}</span>
                </label>
              </div>
              <p className="op-hint">{tx('PropertiesPanel.Adds_roughing_cuts_between_full_stepdowns_so_curved_and')}</p>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Wall_lead_in_radius')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.wallLeadInRadius}
                    min={0}
                    step={0.5}
                    units={displayUnits}
                    onChange={(v) => setA3d({ wallLeadInRadius: v })}
                    tooltip={tx('PropertiesPanel.Tangent_arc_from_proven_cleared_stock_into_retained_wall')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Wall_lead_out_radius')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.wallLeadOutRadius}
                    min={0}
                    step={0.5}
                    units={displayUnits}
                    onChange={(v) => setA3d({ wallLeadOutRadius: v })}
                    tooltip={tx('PropertiesPanel.Tangent_arc_from_retained_wall_cleanup_into_proven_cleared')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Loopback_fillet')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.loopbackFilletPct}
                    min={5}
                    max={100}
                    step={5}
                    onChange={(v) => setA3d({ loopbackFilletPct: v })}
                    tooltip={tx('PropertiesPanel.Stay_down_turnaround_radius_as_a_percent_of_tool')}
                  />
                  <span className="props-quickedit-unit">{tx('PropertiesPanel.tool_R')}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Integral_wall_follow')}</div>
                <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={a3dParams.integralWallFollow}
                    onChange={(event) => setA3d({ integralWallFollow: event.target.checked })}
                  />
                  <span>{a3dParams.integralWallFollow ? tx('PropertiesPanel.Enabled') : tx('PropertiesPanel.Disabled')}</span>
                </label>
              </div>
              {a3dParams.integralWallFollow && (
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Maximum_direct_wall_ride')}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <NumericInput
                      className="props-quickedit-input"
                      value={a3dParams.integralWallFollowLengthFactor * 100}
                      min={10}
                      max={1000}
                      step={10}
                      onChange={(v) => setA3d({
                        integralWallFollowLengthFactor: Number.isFinite(v) && v > 0 ? v / 100 : 2,
                      })}
                      tooltip={tx('PropertiesPanel.Maximum_wall_follow_route_as_a_percent_of_straight')}
                    />
                    <span className="props-quickedit-unit">{tx('PropertiesPanel.symbol_4')}</span>
                  </div>
                </div>
              )}
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Entry_helix_dia')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.helixDiameter}
                    min={0.5}
                    step={0.5}
                    units={displayUnits}
                    onChange={(v) => setA3d({ helixDiameter: v })}
                    tooltip={tx('PropertiesPanel.Helix_diameter_for_closed_pockets_open_stock_regions_side')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Helix_angle')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.helixAngleDeg}
                    min={0.5}
                    max={30}
                    step={0.5}
                    onChange={(v) => setA3d({ helixAngleDeg: v })}
                    tooltip={tx('PropertiesPanel.Descent_angle_of_the_entry_helix')}
                  />
                  <span className="props-quickedit-unit">{tx('PropertiesPanel.deg')}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Radial_stock_to_leave')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.radialStockToLeave}
                    min={0}
                    step={0.1}
                    units={displayUnits}
                    onChange={(v) => setA3d({ radialStockToLeave: v })}
                    tooltip={tx('PropertiesPanel.Material_left_on_the_part_walls_for_finishing')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Axial_stock_to_leave')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.axialStockToLeave}
                    min={0}
                    step={0.1}
                    units={displayUnits}
                    onChange={(v) => setA3d({ axialStockToLeave: v })}
                    tooltip={tx('PropertiesPanel.Material_left_on_the_floor_raises_the_computed_floor')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Tolerance')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={a3dParams.tolerance}
                    min={0.001}
                    step={0.01}
                    units={displayUnits}
                    onChange={(v) => setA3d({ tolerance: v })}
                    tooltip={tx('PropertiesPanel.Max_chordal_deviation_from_the_surface')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Auto_grid')}</div>
                <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={a3dParams.cellSize <= 0}
                    onChange={(e) => setA3d({ cellSize: e.target.checked ? 0 : (a3dParams.cellSize > 0 ? a3dParams.cellSize : 0.3) })}
                  />
                  <span>{a3dParams.cellSize <= 0 ? tx('PropertiesPanel.Auto') : tx('PropertiesPanel.Manual')}</span>
                </label>
              </div>
              {a3dParams.cellSize > 0 && (
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Grid_cell_size')}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <NumericInput
                      className="props-quickedit-input"
                      value={a3dParams.cellSize}
                      min={0.1}
                      step={0.1}
                      units={displayUnits}
                      onChange={(v) => setA3d({ cellSize: v })}
                      tooltip={tx('PropertiesPanel.Stock_part_grid_resolution')}
                    />
                    <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                  </div>
                </div>
              )}
              <div className="props-group" style={{ display: 'block' }}>
                <RoughingScopeSelector
                  name={`properties-adaptive3d-roughing-scope-${op.id}`}
                  useStockBoundary={a3dParams.useStockBoundary}
                  onChange={(useStockBoundary) =>
                    setA3d({ useStockBoundary })
                  }
                  testId="props-adaptive3d-roughing-scope"
                />
              </div>
              {a3dParams.useStockBoundary && (
                <>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Edge_overshoot')}</div>
                    <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <OptionalNumericInput
                        className="props-quickedit-input"
                        value={a3dParams.stockEdgeOvershoot}
                        min={0}
                        step={0.1}
                        units={displayUnits}
                        placeholder={tx('PropertiesPanel.auto')}
                        onChange={(v) => setA3d({ stockEdgeOvershoot: v })}
                        tooltip={tx('PropertiesPanel.How_far_the_tool_may_cut_past_the_stock')}
                      />
                      <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                    </div>
                  </div>
                  <div className="props-group" data-testid="props-adaptive3d-overshoot-caution">
                    <div
                      className="props-value"
                      style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, color: 'var(--accent-amber)', whiteSpace: 'normal', lineHeight: 1.3 }}
                    >
                      <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>{tx('PropertiesPanel.Caution_the_tool_cuts_up_to_this_far_into')}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : op.type === 'waterline_3d' ? (
            <div data-testid="props-waterline3d-edit">
              {faceScopeRow}
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Stepdown')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={w3dParams.stepdown}
                    min={0.05}
                    step={0.1}
                    units={displayUnits}
                    onChange={(v) => setW3d({ stepdown: v })}
                    tooltip={tx('PropertiesPanel.Height_between_levels_the_last_step_may_be_shorter')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Tolerance')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={w3dParams.tolerance}
                    min={0.001}
                    step={0.01}
                    units={displayUnits}
                    onChange={(v) => setW3d({ tolerance: v })}
                    tooltip={tx('PropertiesPanel.How_closely_each_level_follows_the_surface')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Stock_to_leave')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={w3dParams.stockToLeave}
                    min={0}
                    step={0.05}
                    units={displayUnits}
                    onChange={(v) => setW3d({ stockToLeave: v })}
                    tooltip={tx('PropertiesPanel.Material_left_on_the_walls')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Steep_areas_only')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={w3dParams.minSlopeDeg}
                    min={0}
                    max={89}
                    step={1}
                    onChange={(v) => setW3d({ minSlopeDeg: v })}
                    tooltip={tx('PropertiesPanel.0_whole_part_else_only_walls_steeper_than_this')}
                  />
                  <span className="props-quickedit-unit">{tx('PropertiesPanel.symbol_5')}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Finish_depth_limit')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <OptionalNumericInput
                    className="props-quickedit-input"
                    value={waterline3dSmartPanelState?.kind === 'smart_v2'
                      ? waterline3dSmartPanelState.draft.finishDepthMm
                      : w3dParams.finishDepth}
                    min={0.01}
                    step={0.1}
                    units={displayUnits}
                    placeholder={tx('PropertiesPanel.full_surface')}
                    onChange={(v) => setW3d({ finishDepth: v })}
                    tooltip={tx('PropertiesPanel.Maximum_depth_below_model_top_blank_finishes_the_full')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Order')}</div>
                <div className="props-value">
                  <select
                    className="props-number-input"
                    aria-label={tx('PropertiesPanel.Waterline_order')}
                    value={w3dParams.order}
                    onChange={(e) => setW3d({ order: e.target.value === 'region' ? 'region' : 'level' })}
                  >
                    <option value="level">{tx('PropertiesPanel.Level_by_level')}</option>
                    <option value="region">{tx('PropertiesPanel.Region_by_region')}</option>
                  </select>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Direction')}</div>
                <div className="props-value">
                  <select
                    className="props-number-input"
                    aria-label={tx('PropertiesPanel.Waterline_direction')}
                    value={w3dParams.direction}
                    onChange={(e) => setW3d({ direction: e.target.value === 'conventional' ? 'conventional' : 'climb' })}
                  >
                    <option value="climb">{tx('PropertiesPanel.Climb')}</option>
                    <option value="conventional">{tx('PropertiesPanel.Conventional')}</option>
                  </select>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Flat_areas')}</div>
                <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={w3dParams.flatAreaDetection}
                    onChange={(e) => setW3d({ flatAreaDetection: e.target.checked })}
                  />
                  <span>{w3dParams.flatAreaDetection ? tx('PropertiesPanel.Level_at_every_flat_face') : tx('PropertiesPanel.Ladder_only')}</span>
                </label>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Clip_to_stock')}</div>
                <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={w3dParams.useStockBoundary}
                    onChange={(e) => setW3d({ useStockBoundary: e.target.checked })}
                  />
                  <span>{w3dParams.useStockBoundary ? tx('PropertiesPanel.Stock_outline') : tx('PropertiesPanel.Part_outline')}</span>
                </label>
              </div>
            </div>
          ) : op.type === 'steep_shallow_3d' ? (
            <div data-testid="props-steep-shallow3d-edit">
              {faceScopeRow}
              {([
                // Threshold carries the modal's own max=90 (NewOperationModalBody.tsx) so
                // an out-of-range typed value clamps and displays clamped, the same as
                // every other bounded quick-edit row (WO-1515 / BUG-422).
                [tx('PropertiesPanel.Threshold'), ss3dParams.thresholdDeg, (value: number) => setSs3d({ thresholdDeg: value }), 0, 1, false, 90],
                [tx('PropertiesPanel.Steep_stepdown'), ss3dParams.stepdown, (value: number) => setSs3d({ stepdown: value }), 0.05, 0.1, true, undefined],
                [tx('PropertiesPanel.Shallow_stepover'), ss3dParams.stepover, (value: number) => setSs3d({ stepover: value }), 0.05, 0.1, true, undefined],
                [tx('PropertiesPanel.Shallow_angle'), ss3dParams.angleDeg, (value: number) => setSs3d({ angleDeg: value }), 0, 5, false, undefined],
                [tx('PropertiesPanel.Tolerance'), ss3dParams.tolerance, (value: number) => setSs3d({ tolerance: value }), 0.001, 0.01, true, undefined],
                [tx('PropertiesPanel.Stock_to_leave'), ss3dParams.stockToLeave, (value: number) => setSs3d({ stockToLeave: value }), 0, 0.05, true, undefined],
              ] as const).map(([label, value, onChange, min, step, dimensional, max]) => (
                <div className="props-group" key={label}>
                  <div className="props-label">{label}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <NumericInput
                      className="props-quickedit-input"
                      value={value}
                      min={min}
                      max={max}
                      step={step}
                      units={dimensional ? displayUnits : undefined}
                      onChange={onChange}
                    />
                    <span className="props-quickedit-unit">
                      {dimensional ? unitLabel(displayUnits) : 'deg'}
                    </span>
                  </div>
                </div>
              ))}
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Finish_depth_limit')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <OptionalNumericInput
                    className="props-quickedit-input"
                    value={parallel3dSmartPanelState?.kind === 'smart_v2'
                      ? parallel3dSmartPanelState.draft.finishDepthMm
                      : ss3dParams.finishDepth}
                    min={0.01}
                    step={0.1}
                    units={displayUnits}
                    placeholder={tx('PropertiesPanel.full_surface')}
                    onChange={finishDepth => setSs3d({ finishDepth })}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Clip_to_stock')}</div>
                <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={ss3dParams.useStockBoundary}
                    onChange={event => setSs3d({ useStockBoundary: event.target.checked })}
                  />
                  <span>{ss3dParams.useStockBoundary ? tx('PropertiesPanel.Stock_outline') : tx('PropertiesPanel.Part_bounds')}</span>
                </label>
              </div>
            </div>
          ) : op.type === 'scallop_3d' ? (
            <div data-testid="props-scallop3d-edit">
              {faceScopeRow}
              {([
                [tx('PropertiesPanel.Scallop_height'), scallop3dParams.scallopHeight, (value: number) => setScallop3d({ scallopHeight: value }), 0.001, 0.005],
                [tx('PropertiesPanel.Tolerance'), scallop3dParams.tolerance, (value: number) => setScallop3d({ tolerance: value }), 0.001, 0.01],
                [tx('PropertiesPanel.Stock_to_leave'), scallop3dParams.stockToLeave, (value: number) => setScallop3d({ stockToLeave: value }), 0, 0.05],
              ] as const).map(([label, value, onChange, min, step]) => (
                <div className="props-group" key={label}>
                  <div className="props-label">{label}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <NumericInput className="props-quickedit-input" value={value} min={min} step={step}
                      units={displayUnits} onChange={onChange} />
                    <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                  </div>
                </div>
              ))}
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Finish_depth_limit')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <OptionalNumericInput className="props-quickedit-input"
                    value={parallel3dSmartPanelState?.kind === 'smart_v2'
                      ? parallel3dSmartPanelState.draft.finishDepthMm : scallop3dParams.finishDepth}
                    min={0.01} step={0.1} units={displayUnits} placeholder={tx('PropertiesPanel.full_surface')}
                    onChange={finishDepth => setScallop3d({ finishDepth })} />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Direction')}</div>
                <div className="props-value">
                  <select className="props-number-input" value={scallop3dParams.direction}
                    onChange={event => setScallop3d({ direction: event.target.value === 'conventional' ? 'conventional' : 'climb' })}>
                    <option value="climb">{tx('PropertiesPanel.Climb')}</option>
                    <option value="conventional">{tx('PropertiesPanel.Conventional')}</option>
                  </select>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Clip_to_stock')}</div>
                <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={scallop3dParams.useStockBoundary}
                    onChange={event => setScallop3d({ useStockBoundary: event.target.checked })} />
                  <span>{scallop3dParams.useStockBoundary ? tx('PropertiesPanel.Stock_outline') : tx('PropertiesPanel.Part_bounds')}</span>
                </label>
              </div>
            </div>
          ) : op.type === 'pencil_3d' ? (
            <div data-testid="props-pencil3d-edit">
              {faceScopeRow}
              {([
                [tx('PropertiesPanel.Tolerance'), pencil3dParams.tolerance, (value: number) => setPencil3d({ tolerance: value }), 0.001, 0.01],
                [tx('PropertiesPanel.Stock_to_leave'), pencil3dParams.stockToLeave, (value: number) => setPencil3d({ stockToLeave: value }), 0, 0.05],
              ] as const).map(([label, value, onChange, min, step]) => (
                <div className="props-group" key={label}>
                  <div className="props-label">{label}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <NumericInput className="props-quickedit-input" value={value} min={min} step={step}
                      units={displayUnits} onChange={onChange} />
                    <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                  </div>
                </div>
              ))}
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Finish_depth_limit')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <OptionalNumericInput className="props-quickedit-input"
                    value={parallel3dSmartPanelState?.kind === 'smart_v2'
                      ? parallel3dSmartPanelState.draft.finishDepthMm : pencil3dParams.finishDepth}
                    min={0.01} step={0.1} units={displayUnits} placeholder={tx('PropertiesPanel.full_surface')}
                    onChange={finishDepth => setPencil3d({ finishDepth })} />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Direction')}</div>
                <div className="props-value">
                  <select className="props-number-input" value={pencil3dParams.direction}
                    onChange={event => setPencil3d({ direction: event.target.value === 'conventional' ? 'conventional' : 'climb' })}>
                    <option value="climb">{tx('PropertiesPanel.Climb')}</option>
                    <option value="conventional">{tx('PropertiesPanel.Conventional')}</option>
                  </select>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Clip_to_stock')}</div>
                <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={pencil3dParams.useStockBoundary}
                    onChange={event => setPencil3d({ useStockBoundary: event.target.checked })} />
                  <span>{pencil3dParams.useStockBoundary ? tx('PropertiesPanel.Stock_outline') : tx('PropertiesPanel.Part_bounds')}</span>
                </label>
              </div>
            </div>
          ) : op.type === 'parallel_3d' ? (
            <div data-testid="props-parallel3d-edit">
              {faceScopeRow}
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Stepover')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={p3dParams.stepover}
                    min={0.05}
                    step={0.1}
                    units={displayUnits}
                    onChange={(v) => setP3d({ stepover: v })}
                    tooltip={tx('PropertiesPanel.Raster_pass_spacing')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Pass_angle')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={p3dParams.angleDeg}
                    min={0}
                    max={180}
                    step={5}
                    onChange={(v) => setP3d({ angleDeg: v })}
                    tooltip={tx('PropertiesPanel.Raster_direction_degrees_CCW_from_X')}
                  />
                  <span className="props-quickedit-unit">{tx('PropertiesPanel.symbol_5')}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Tolerance')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={p3dParams.tolerance}
                    min={0.001}
                    step={0.01}
                    units={displayUnits}
                    onChange={(v) => setP3d({ tolerance: v })}
                    tooltip={tx('PropertiesPanel.Max_chordal_deviation_from_the_surface')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Surface_normal_stock')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <NumericInput
                    className="props-quickedit-input"
                    value={p3dParams.surfaceStockToLeave ?? 0}
                    min={0}
                    step={0.05}
                    units={displayUnits}
                    onChange={(v) => setP3d({ surfaceStockToLeave: v })}
                    tooltip={tx('PropertiesPanel.Material_left_along_the_local_3D_surface_normal')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Finish_depth_limit')}</div>
                <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <OptionalNumericInput
                    className="props-quickedit-input"
                    value={parallel3dSmartPanelState?.kind === 'smart_v2'
                      ? parallel3dSmartPanelState.draft.finishDepthMm
                      : p3dParams.finishDepth}
                    min={0.01}
                    step={0.1}
                    units={displayUnits}
                    placeholder={tx('PropertiesPanel.full_surface')}
                    onChange={(v) => setP3d({ finishDepth: v })}
                    tooltip={tx('PropertiesPanel.Maximum_depth_below_model_top_blank_finishes_the_full')}
                  />
                  <span className="props-quickedit-unit">{unitLabel(displayUnits)}</span>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Clip_to_stock')}</div>
                <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={p3dParams.useStockBoundary}
                    onChange={(e) => setP3d({ useStockBoundary: e.target.checked })}
                  />
                  <span>{p3dParams.useStockBoundary ? tx('PropertiesPanel.Stock_outline') : tx('PropertiesPanel.Part_bounds')}</span>
                </label>
              </div>
            </div>
          ) : op.type === 'drill' ? (
            <div data-testid="props-drill-cycle-edit">
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Cycle')}</div>
                <div className="props-value">
                  <select
                    className="props-number-input"
                    data-testid="props-drill-cycle"
                    value={drillParams.cycleType}
                    onChange={(event) => commitDrillParams({
                      cycleType: event.target.value as DrillParams['cycleType'],
                    })}
                    data-tooltip={tx('PropertiesPanel.Drilling_canned_cycle_behavior')}
                  >
                    <option value="simple">{tx('PropertiesPanel.Simple_G81')}</option>
                    <option value="peck">{tx('PropertiesPanel.Peck_G83')}</option>
                    <option value="chip_break">{tx('PropertiesPanel.Chip_break_G73')}</option>
                    <option value="dwell">{tx('PropertiesPanel.Dwell_G82')}</option>
                  </select>
                </div>
              </div>
              {(drillParams.cycleType === 'peck' || drillParams.cycleType === 'chip_break') && (
                numRow(tx('PropertiesPanel.Peck_depth'), drillParams.peckDepth,
                  (peckDepth) => commitDrillParams({ peckDepth }),
                  { min: 0.1, step: 0.5, get title() { return tx('PropertiesPanel.Axial_distance_drilled_per_peck_increment') } })
              )}
              {(drillParams.cycleType === 'peck' || drillParams.cycleType === 'chip_break') && (
                <div className="props-group" data-testid="props-drill-peck-decrement">
                  <div className="props-label">{tx('PropertiesPanel.Peck_decrement')}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <OptionalNumericInput
                      className="props-number-input"
                      value={drillParams.peckDecrement}
                      min={0}
                      step={0.1}
                      units={displayUnits}
                      placeholder={tx('PropertiesPanel.constant')}
                      ariaLabel={tx('PropertiesPanel.Peck_decrement')}
                      tooltip={tx('PropertiesPanel.Shrink_each_successive_peck_by_this_amount_Blank_keeps')}
                      onChange={(peckDecrement) => commitDrillParams({ peckDecrement })}
                    />
                    <span>{unitLabel(displayUnits)}</span>
                  </div>
                </div>
              )}
              {(drillParams.cycleType === 'peck' || drillParams.cycleType === 'chip_break') && (
                <div className="props-group" data-testid="props-drill-min-peck-depth">
                  <div className="props-label">{tx('PropertiesPanel.Min_peck_depth')}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <OptionalNumericInput
                      className="props-number-input"
                      value={drillParams.minPeckDepth}
                      min={0.01}
                      step={0.1}
                      units={displayUnits}
                      placeholder={tx('PropertiesPanel.decrement')}
                      ariaLabel={tx('PropertiesPanel.Min_peck_depth')}
                      tooltip={tx('PropertiesPanel.Floor_for_a_shrinking_peck_Blank_floors_at_the')}
                      onChange={(minPeckDepth) => commitDrillParams({ minPeckDepth })}
                    />
                    <span>{unitLabel(displayUnits)}</span>
                  </div>
                </div>
              )}
              {drillParams.cycleType === 'chip_break' && (
                numRow(tx('PropertiesPanel.Chip_break_retract'), drillParams.chipBreakRetract,
                  (chipBreakRetract) => commitDrillParams({ chipBreakRetract }),
                  { min: 0.1, step: 0.25, get title() { return tx('PropertiesPanel.Partial_retract_distance_used_to_break_the_chip') } })
              )}
              {drillParams.cycleType === 'dwell' && (
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Dwell_time')}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <NumericInput
                      className="props-number-input"
                      value={drillParams.dwell}
                      min={0}
                      step={0.1}
                      tooltip={tx('PropertiesPanel.Pause_at_the_bottom_of_the_hole_in_seconds')}
                      onChange={(dwell) => commitDrillParams({ dwell })}
                    />
                    <span>{tx('PropertiesPanel.s')}</span>
                  </div>
                </div>
              )}
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Between_holes')}</div>
                <div className="props-value">
                  <select
                    className="props-number-input"
                    data-testid="props-drill-retract-mode"
                    value={drillParams.retractMode}
                    onChange={(event) => commitDrillParams({
                      retractMode: event.target.value as DrillParams['retractMode'],
                    })}
                    data-tooltip={tx('PropertiesPanel.Z_plane_used_for_rapid_moves_between_holes')}
                  >
                    <option value="clearance">{tx('PropertiesPanel.Clearance_height')}</option>
                    <option value="retract">{tx('PropertiesPanel.Retract_height')}</option>
                  </select>
                </div>
              </div>
              <div className="props-group">
                <div className="props-label">{tx('PropertiesPanel.Hole_ordering')}</div>
                <div className="props-value">
                  <select
                    className="props-number-input"
                    data-testid="props-drill-sort"
                    value={drillParams.sortStrategy}
                    onChange={(event) => commitDrillParams({
                      sortStrategy: event.target.value as DrillParams['sortStrategy'],
                    })}
                    data-tooltip={tx('PropertiesPanel.Order_used_to_visit_the_selected_holes')}
                  >
                    <option value="nearest_neighbor">{tx('PropertiesPanel.Nearest_neighbor')}</option>
                    <option value="by_x">{tx('PropertiesPanel.By_X')}</option>
                    <option value="by_y">{tx('PropertiesPanel.By_Y')}</option>
                    <option value="none">{tx('PropertiesPanel.As_selected')}</option>
                  </select>
                </div>
              </div>
              {drillParams.perHoleDepth !== undefined && (
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Model_depths')}</div>
                  <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={drillParams.perHoleDepth}
                      onChange={(event) => commitDrillParams({ perHoleDepth: event.target.checked })}
                    />
                    <span>{drillParams.perHoleDepth ? tx('PropertiesPanel.Per_hole') : tx('PropertiesPanel.Operation_bottom')}</span>
                  </label>
                </div>
              )}
            </div>
          ) : passesEditable ? (
            <>
              {op.type === 'bore' && (
                <div className="props-group" data-testid="props-bore-target-diameter">
                  <div className="props-label">{tx('PropertiesPanel.Target_diameter')}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <OptionalNumericInput
                      className="props-number-input"
                      value={boreParams.targetDiameter}
                      min={0.1}
                      step={0.1}
                      units={displayUnits}
                      placeholder={tx('PropertiesPanel.auto')}
                      ariaLabel={tx('PropertiesPanel.Target_diameter')}
                      tooltip={tx('PropertiesPanel.Optional_finished_bore_diameter_Blank_uses_the_selected_circle')}
                      onChange={(targetDiameter) => commitBoreParams({ targetDiameter })}
                    />
                    <span>{unitLabel(displayUnits)}</span>
                  </div>
                </div>
              )}
              {op.type === 'contour_2d' && (
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Cutting_strategy')}</div>
                  <div className="props-value">
                    <select
                      className="props-number-input"
                      data-testid="props-contour-cutting-strategy"
                      value={contourCuttingStrategy}
                      onChange={(event) => commitContourCuttingStrategy(
                        event.target.value as ContourCuttingStrategy,
                      )}
                      data-tooltip={tx('PropertiesPanel.Choose_whether_the_contour_cuts_at_geometry_roughs_only')}
                    >
                      <option value="cut_at_geometry">{tx('PropertiesPanel.Cut_at_geometry')}</option>
                      <option value="roughing_only">{tx('PropertiesPanel.Roughing_only')}</option>
                      <option value="rough_finish_each">{tx('PropertiesPanel.Rough_finish_each_depth')}</option>
                      <option value="rough_finish_final">{tx('PropertiesPanel.Rough_finish_final_depth')}</option>
                    </select>
                  </div>
                </div>
              )}
              {op.type === 'contour_2d' && (contourParams.pathType ?? 'closed') === 'closed'
                && contourCuttingStrategy !== 'cut_at_geometry' && (
                // WO-2289: the same stored field the New Operation dialog edits.
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Roughing_style')}</div>
                  <div className="props-value">
                    <select
                      className="props-number-input"
                      data-testid="props-contour-roughing-style"
                      value={contourParams.roughingStyle ?? 'offset'}
                      onChange={(event) => commitContourParams({
                        roughingStyle: event.target.value as ContourRoughingStyle,
                      })}
                      data-tooltip={tx('PropertiesPanel.Offset_cuts_one_loop_per_stepdown_Trochoidal_cuts_a')}
                    >
                      {(Object.keys(CONTOUR_ROUGHING_STYLE_LABELS) as ContourRoughingStyle[]).map((style) => (
                        <option key={style} value={style}>{tx(`choices.CONTOUR_ROUGHING_STYLE_LABELS.${style}`)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {op.type === 'contour_2d' && (contourParams.pathType ?? 'closed') === 'closed'
                && contourCuttingStrategy !== 'cut_at_geometry'
                && contourParams.roughingStyle === 'trochoidal' && tool && (() => {
                const troch = resolveTrochoidalGeometry(
                  tool.diameter, contourParams.trochoidalWidth, contourParams.trochoidalAdvance)
                const limits = trochoidalFieldLimits(tool.diameter)
                return (
                  <>
                    {numRow(tx('PropertiesPanel.Channel_width'), troch.width, (v) => commitContourParams({ trochoidalWidth: v }),
                      { ...limits.width, get title() { return tx('PropertiesPanel.Width_of_the_channel_the_orbits_cut_mm') } })}
                    {numRow(tx('PropertiesPanel.Advance_per_orbit'), troch.advance, (v) => commitContourParams({ trochoidalAdvance: v }),
                      { ...limits.advance, step: 0.1, get title() { return tx('PropertiesPanel.How_far_each_orbit_moves_along_the_contour_mm') } })}
                  </>
                )
              })()}
              {op.type === 'face' && (
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Strategy')}</div>
                  <div className="props-value">
                    <select
                      className="props-number-input"
                      data-testid="props-face-strategy"
                      aria-label={tx('PropertiesPanel.Strategy')}
                      value={faceStrategy}
                      onChange={(event) => commitFaceStrategy(
                        event.target.value as FaceStrategy,
                      )}
                      data-tooltip={tx('PropertiesPanel.Zigzag_cuts_both_directions_fastest_One_way_keeps_a')}
                    >
                      <option value="zigzag">{tx('PropertiesPanel.Zigzag')}</option>
                      <option value="one_way_climb">{tx('PropertiesPanel.One_way_climb')}</option>
                      <option value="one_way_conventional">{tx('PropertiesPanel.One_way_conventional')}</option>
                      <option value="offset">{tx('PropertiesPanel.Offset')}</option>
                      <option value="spiral">{tx('PropertiesPanel.Inward_spiral')}</option>
                    </select>
                  </div>
                </div>
              )}
              {/* Face carries the modal's PASS bounds (WO-027): stepdown
                  0.1..50, stepover/radial stock floor..tool diameter via the
                  SAME faceToolDiameterCap the modal derives its max from.
                  Other op types keep the generic panel floors. */}
              {numRow(tx('PropertiesPanel.Stepdown'), op.passes.stepdown, (v) => commitPasses({ stepdown: v }),
                op.type === 'face'
                  ? { ...FACE_STEPDOWN_BOUNDS, get title() { return tx('PropertiesPanel.Axial_depth_of_cut_per_pass_mm') } }
                  : { min: 0.01, get title() { return tx('PropertiesPanel.Axial_depth_of_cut_per_pass_mm') } })}
              {numRow(tx('PropertiesPanel.Stepover'), op.passes.stepover, (v) => commitPasses({ stepover: v }),
                op.type === 'face'
                  ? { ...FACE_STEPOVER_BOUNDS, max: faceToolDiameterCap(tool), get title() { return tx('PropertiesPanel.Radial_engagement_between_passes_mm') } }
                  : { min: 0.01, get title() { return tx('PropertiesPanel.Radial_engagement_between_passes_mm') } })}
              {numRow(tx('PropertiesPanel.Stock_to_leave'), op.passes.stockToLeave, (v) => commitPasses({ stockToLeave: v }),
                op.type === 'face'
                  ? { ...FACE_RADIAL_STOCK_BOUNDS, max: faceToolDiameterCap(tool), get title() { return tx('PropertiesPanel.Radial_material_left_for_a_finishing_pass_mm') } }
                  : { min: 0, get title() { return tx('PropertiesPanel.Radial_material_left_for_a_finishing_pass_mm') } })}
              {op.type === 'adaptive_clearing_2d' && (
                <div className="props-group" data-testid="props-adaptive-floor-finish">
                  <div className="props-label">{tx('PropertiesPanel.Floor_finish_pass')}</div>
                  <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={adaptiveParams.floorFinish === true}
                      onChange={(event) => commitAdaptiveParams({ floorFinish: event.target.checked })}
                    />
                    <span>{adaptiveParams.floorFinish ? tx('PropertiesPanel.On') : tx('PropertiesPanel.Off')}</span>
                  </label>
                </div>
              )}
              {op.type === 'face' && (
                <div data-testid="props-face-edit">
                  {numRow(tx('PropertiesPanel.Floor_stock'), op.passes.floorStockToLeave ?? 0,
                    (floorStockToLeave) => commitPasses({ floorStockToLeave }),
                    { min: 0, step: 0.05, get title() { return tx('PropertiesPanel.Axial_material_left_on_the_faced_floor_for_a') } })}
                  {numRow(tx('PropertiesPanel.Pass_angle'), faceParams.passAngle ?? 0,
                    (passAngle) => commitFaceParams({ passAngle }),
                    { ...FACE_PASS_ANGLE_BOUNDS, step: 5, unit: 'deg', get title() { return tx('PropertiesPanel.Direction_of_the_parallel_passes_0_along_X_90') } })}
                  {numRow(tx('PropertiesPanel.Pass_extension'), faceParams.passExtension ?? 0,
                    (passExtension) => commitFaceParams({ passExtension }),
                    { ...FACE_PASS_EXTENSION_BOUNDS, step: 0.5, get title() { return tx('PropertiesPanel.How_far_the_tool_overruns_each_end_of_a') } })}
                  {numRow(tx('PropertiesPanel.Stock_offset'), faceParams.stockOffset ?? 0,
                    (stockOffset) => commitFaceParams({ stockOffset }),
                    { ...FACE_STOCK_OFFSET_BOUNDS, step: 0.5, get title() { return tx('PropertiesPanel.Grow_or_shrink_the_faced_region_before_the_tool') } })}
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Containment')}</div>
                    <div className="props-value">
                      <select
                        className="props-number-input"
                        data-testid="props-face-containment"
                        value={faceParams.boundaryContainment ?? 'outside'}
                        onChange={(event) => commitFaceParams({
                          boundaryContainment: event.target.value as FaceParams['boundaryContainment'],
                        })}
                        data-tooltip={tx('PropertiesPanel.Outside_cutter_fully_overruns_the_edge_normal_facing_Inside')}
                      >
                        <option value="outside">{tx('PropertiesPanel.Outside')}</option>
                        <option value="center">{tx('PropertiesPanel.Centre')}</option>
                        <option value="inside">{tx('PropertiesPanel.Inside')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Alternate_levels')}</div>
                    <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        data-testid="props-face-both-sides"
                        checked={faceParams.bothSidesPerLevel === true}
                        onChange={(event) => commitFaceParams({ bothSidesPerLevel: event.target.checked })}
                      />
                      <span>{faceParams.bothSidesPerLevel ? tx('PropertiesPanel.Alternate_direction_each_level') : tx('PropertiesPanel.Same_direction_each_level')}</span>
                    </label>
                  </div>
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Finish_pass')}</div>
                    <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        data-testid="props-face-finish-pass"
                        checked={faceParams.finishPass === true}
                        onChange={(event) => commitFaceParams({ finishPass: event.target.checked })}
                      />
                      <span>{faceParams.finishPass ? tx('PropertiesPanel.Extra_pass_at_final_depth') : tx('PropertiesPanel.Disabled')}</span>
                    </label>
                  </div>
                </div>
              )}
              {op.type === 'pocket_2d' && (
                // WO-2291: the same stored field the New Operation dialog edits.
                <div className="props-group" data-testid="props-pocket-slot-feed">
                  <div className="props-label">{tx('PropertiesPanel.Slot_feed')}</div>
                  <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <NumericInput
                      className="props-number-input"
                      value={pocketParams.slotFeedPercent ?? 100}
                      min={1}
                      max={100}
                      step={5}
                      tooltip={tx('PropertiesPanel.Feed_where_the_cutter_cuts_full_width_as_a')}
                      onChange={(slotFeedPercent) => commitPocketParams({ slotFeedPercent })}
                    />
                    <span>{tx('PropertiesPanel.of_feed')}</span>
                  </div>
                </div>
              )}
              {op.type === 'pocket_2d' && (
                // WO-2296: the same stored field the New Operation dialog edits.
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Ring_corners')}</div>
                  <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      data-testid="props-pocket-round-ring-corners"
                      checked={pocketParams.roundRingCorners === true}
                      onChange={(event) => commitPocketParams({ roundRingCorners: event.target.checked })}
                    />
                    <span>{pocketParams.roundRingCorners ? tx('PropertiesPanel.Rounded') : tx('PropertiesPanel.Sharp')}</span>
                  </label>
                </div>
              )}
              {(op.type === 'pocket_2d'
                || (op.type === 'contour_2d' && (contourParams.pathType ?? 'closed') === 'closed')) && (
                // WO-2287: the same stored field the New Operation dialog edits.
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Corner_relief')}</div>
                  <div className="props-value">
                    <select
                      className="props-number-input"
                      data-testid="props-corner-relief"
                      value={(op.type === 'pocket_2d' ? pocketParams.cornerRelief : contourParams.cornerRelief) ?? 'none'}
                      onChange={(e) => {
                        const cornerRelief = e.target.value as CornerReliefStyle
                        if (op.type === 'pocket_2d') commitPocketParams({ cornerRelief })
                        else commitContourParams({ cornerRelief })
                      }}
                      data-tooltip={tx('PropertiesPanel.Cut_into_each_inside_corner_a_round_cutter_leaves')}
                    >
                      {CORNER_RELIEF_STYLES.map((style) => (
                        <option key={style} value={style}>{tx(`choices.CORNER_RELIEF_LABELS.${style}`)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {(op.type === 'pocket_2d'
                || (op.type === 'contour_2d' && (contourParams.pathType ?? 'closed') === 'closed')) && (() => {
                // WO-2317: Gentle corner, the same stored fields the New Operation dialog edits.
                const relief = op.type === 'pocket_2d' ? pocketParams : contourParams
                if ((relief.cornerRelief ?? 'none') === 'none') return null
                const commitRelief = (patch: { cornerReliefGentle?: boolean; cornerReliefEngagement?: number }) => {
                  if (op.type === 'pocket_2d') commitPocketParams(patch)
                  else commitContourParams(patch)
                }
                return (
                  <>
                    <div className="props-group">
                      <div className="props-label">{tx('PropertiesPanel.Gentle_corner')}</div>
                      <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          data-testid="props-corner-relief-gentle"
                          checked={relief.cornerReliefGentle === true}
                          onChange={(event) => commitRelief({ cornerReliefGentle: event.target.checked })}
                        />
                        <span>{relief.cornerReliefGentle ? tx('PropertiesPanel.Orbits') : tx('PropertiesPanel.Straight')}</span>
                      </label>
                    </div>
                    {relief.cornerReliefGentle === true && tool && numRow(tx('PropertiesPanel.Max_engagement'),
                      resolveGentleEngagement(tool.diameter, relief.cornerReliefEngagement),
                      (v) => commitRelief({ cornerReliefEngagement: v }),
                      { ...gentleEngagementLimits(tool.diameter), step: 0.1,
                        get title() { return tx('PropertiesPanel.Widest_cut_the_relief_orbits_may_take_mm') } })}
                  </>
                )
              })()}
              {op.type === 'contour_2d' && (contourParams.pathType ?? 'closed') === 'closed' && (
                <div data-testid="props-contour-tabs">
                  <div className="props-group">
                    <div className="props-label">{tx('PropertiesPanel.Holding_tabs')}</div>
                    <label className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={contourParams.tabs === true}
                        onChange={(e) => commitContourTabsEnabled(e.target.checked)}
                      />
                      <span>{contourParams.tabs ? tx('PropertiesPanel.Enabled') : tx('PropertiesPanel.Disabled')}</span>
                    </label>
                  </div>
                  {(() => {
                    const read = readTabRemovalBinding(op)
                    if (read.kind !== 'bound') return null
                    const source = ownerSetup?.operations.find((candidate) => candidate.id === read.binding.sourceOperationId)
                    return (
                      <p className="op-hint" data-testid="props-contour-tab-removal-linked" style={{ margin: 0, whiteSpace: 'normal' }}>
                        {txRemoval('linked', { name: source?.name ?? read.binding.sourceOperationId,
                          count: read.binding.targets.length, outlines: read.binding.loopIds.length })}
                      </p>
                    )
                  })()}
                  {contourParams.tabs && (
                    <>
                      {numRow(
                        tx('PropertiesPanel.Tab_width'),
                        contourParams.tabWidth ?? DEFAULT_CONTOUR_TABS.width,
                        (v) => commitContourParams({ tabWidth: v }),
                        { min: 0.1, get title() { return tx('PropertiesPanel.Holding_tab_width_along_the_contour') } },
                      )}
                      {numRow(
                        tx('PropertiesPanel.Tab_height'),
                        contourParams.tabHeight ?? DEFAULT_CONTOUR_TABS.height,
                        (v) => commitContourParams({ tabHeight: v }),
                        { min: 0.1, get title() { return tx('PropertiesPanel.Material_retained_above_the_stock_bottom') } },
                      )}
                      {numRow(
                        tx('PropertiesPanel.Tab_count'),
                        contourParams.tabCount ?? DEFAULT_CONTOUR_TABS.count,
                        (v) => commitContourParams({ tabCount: Math.max(1, Math.round(v)) }),
                        { min: 1, step: 1, unit: '', get title() { return tx('PropertiesPanel.Tabs_placed_evenly_around_each_contour') } },
                      )}
                      <div className="props-group">
                        <div className="props-label">{tx('PropertiesPanel.Tab_shape')}</div>
                        <div className="props-value">
                          <select
                            className="props-number-input"
                            data-testid="props-contour-tab-shape"
                            value={contourParams.tabShape ?? 'box'}
                            onChange={(e) => commitContourParams({
                              tabShape: e.target.value as 'box' | 'triangular',
                            })}
                            data-tooltip={tx('PropertiesPanel.Triangular_tabs_let_the_cutter_feed_up_and_over')}
                          >
                            <option value="box">{tx('PropertiesPanel.Box')}</option>
                            <option value="triangular">{tx('PropertiesPanel.Triangular_ramped')}</option>
                          </select>
                        </div>
                      </div>
                      <div className="props-group" style={{ alignItems: 'flex-start' }}>
                        <div className="props-label">{tx('PropertiesPanel.Tab_locations')}</div>
                        <div
                          className="props-value"
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5 }}
                        >
                          <button
                            type="button"
                            className="op-toggle-btn"
                            data-testid="props-contour-tab-edit"
                            disabled={!contourTabPreviewReady}
                            onClick={tabEditActive ? endTabEdit : beginTabEdit}
                            data-tooltip={tx('PropertiesPanel.Place_holding_tabs_by_hand_in_the_viewport_click')}
                          >
                            {tabEditActive ? tx('PropertiesPanel.Done_placing_tabs') : tx('PropertiesPanel.Edit_tab_locations')}
                          </button>
                          {customTabCount > 0 && (
                            <span
                              data-testid="props-contour-tab-custom-count"
                              style={{ whiteSpace: 'normal' }}
                            >{tx('PropertiesPanel.custom_tab_count_field_ignored', { p1: customTabCount, p2: customTabCount === 1 ? '' : tx('PropertiesPanel.s') })}</span>
                          )}
                          {noTabOutlineCount > 0 && (
                            <span
                              data-testid="props-contour-tab-none-count"
                              style={{ whiteSpace: 'normal' }}
                            >{txTabs('outlinesWithoutTabs', { count: noTabOutlineCount })}</span>
                          )}
                          {(customTabCount > 0 || noTabOutlineCount > 0) && (
                            <button
                              type="button"
                              className="op-toggle-btn"
                              data-testid="props-contour-tab-reset"
                              onClick={resetTabLocations}
                              data-tooltip={tx('PropertiesPanel.Discard_the_hand_placed_tab_locations_and_return_to')}
                            >{tx('PropertiesPanel.Reset_to_even_spacing')}</button>
                          )}
                          <button
                            type="button"
                            className="op-toggle-btn"
                            data-testid="props-contour-tab-suggest"
                            onClick={suggestTabLocations}
                            data-tooltip={txTabs('suggestTooltip')}
                          >{txTabs('suggest')}</button>
                          {tabSuggestNote && (
                            <span data-testid="props-contour-tab-suggest-note" style={{ whiteSpace: 'normal' }}>{tabSuggestNote}</span>
                          )}
                          {tabSuggestion && (() => {
                            const omitted = new Set<string>()
                            const diagnostics = new Set<string>()
                            for (const loop of tabSuggestion.loops) {
                              for (const item of loop.omissions) omitted.add(item.startsWith('holder:') ? txTabs('omittedHolder') : txTabs('omittedFixtures'))
                              for (const code of loop.diagnostics) diagnostics.add(code.startsWith('zero-central-web') ? txTabs('diagnosticThinWeb') : txTabs('diagnosticOther', { code }))
                            }
                            const partial = tabSuggestion.found < tabSuggestion.requested
                            return (
                              <div data-testid="props-contour-tab-suggestion" style={{ display: 'flex', flexDirection: 'column', gap: 3, whiteSpace: 'normal' }}>
                                <span data-testid="props-contour-tab-suggest-found">{txTabs('foundOf', { found: tabSuggestion.found, requested: tabSuggestion.requested })}</span>
                                {tabSuggestion.loops.map((loop, i) => (
                                  <span key={loop.loopId} data-testid="props-contour-tab-suggest-loop" className="op-hint">
                                    {loop.skipped ? txTabs('loopHandPlaced', { index: i + 1 })
                                      : loop.found === 0 ? txTabs('loopNone', { index: i + 1 })
                                      : txTabs('loopLine', { index: i + 1, found: loop.found, requested: loop.requested,
                                          positions: loop.distances.map((d) => d.toFixed(1)).join(', ') })}
                                    {!loop.skipped && Object.keys(loop.reasons).length > 0 && (
                                      <> {txTabs('avoided', { reasons: suggestionReasonText(loop.reasons) })}</>
                                    )}
                                  </span>
                                ))}
                                {[...diagnostics].map((line) => <span key={line} className="op-hint">{line}</span>)}
                                {omitted.size > 0 && (
                                  <span className="op-hint" data-testid="props-contour-tab-suggest-omitted">{txTabs('notChecked', { items: [...omitted].join(', ') })}</span>
                                )}
                                <div style={{ display: 'flex', gap: 5 }}>
                                  {tabSuggestion.found > 0 && (
                                    <button type="button" className="op-toggle-btn" data-testid="props-contour-tab-suggest-apply" onClick={applyTabSuggestion}>
                                      {partial ? txTabs('applyPartial', { count: tabSuggestion.found }) : txTabs('apply')}
                                    </button>
                                  )}
                                  <button type="button" className="op-toggle-btn" data-testid="props-contour-tab-suggest-cancel" onClick={cancelTabSuggestion}>{txTabs('cancel')}</button>
                                </div>
                              </div>
                            )
                          })()}
                          <button
                            type="button"
                            className="op-toggle-btn"
                            data-testid="props-contour-tab-removal"
                            onClick={beginTabRemoval}
                            data-tooltip={txRemoval('actionTooltip')}
                          >{txRemoval('action')}</button>
                          {tabRemovalNote && (
                            <span data-testid="props-contour-tab-removal-note" style={{ whiteSpace: 'normal' }}>{tabRemovalNote}</span>
                          )}
                          {tabRemovalReview && (
                            <div data-testid="props-contour-tab-removal-review" style={{ display: 'flex', flexDirection: 'column', gap: 3, whiteSpace: 'normal' }}>
                              <span data-testid="props-contour-tab-removal-all">{txRemoval('reviewAll', { count: tabRemovalReview.targets.length, outlines: tabRemovalReview.loopIds.length })}</span>
                              {tabRemovalReview.targets.map((target) => (
                                <label key={target.label} className="op-hint" data-testid="props-contour-tab-removal-tab" style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
                                  <input
                                    type="checkbox"
                                    checked={tabRemovalReview.selected.includes(target.label)}
                                    onChange={(e) => toggleTabRemovalTarget(target.label, e.target.checked)}
                                  />
                                  <span>{txRemoval('reviewTab', { label: target.label, x: target.center.x.toFixed(2), y: target.center.y.toFixed(2),
                                    width: target.width.toFixed(2), height: target.height.toFixed(2),
                                    shape: target.shape === 'triangular' ? txRemoval('shapeTriangular') : txRemoval('shapeBox') })}</span>
                                </label>
                              ))}
                              <span data-testid="props-contour-tab-removal-holding">
                                {tabRemovalReview.holdingMethod
                                  ? txRemoval('reviewHolding', { method: holdingMethodLabel(tabRemovalReview.holdingMethod as Parameters<typeof holdingMethodLabel>[0]) ?? tabRemovalReview.holdingMethod })
                                  : txRemoval('reviewHoldingNone')}
                              </span>
                              {tabRemovalReview.notes.split(/\r?\n/).filter((line) => line.trim() !== '').map((line, i) => (
                                <span key={i} className="op-hint">{txRemoval('reviewNotes', { note: line.trim() })}</span>
                              ))}
                              <span className="op-hint" data-testid="props-contour-tab-removal-material">
                                {tabRemovalMaterial === 'reading' ? txRemoval('materialReading')
                                  : tabRemovalMaterial?.status === 'ready' ? txRemoval('materialRetained', { retained: tabRemovalMaterial.retained, count: tabRemovalMaterial.count })
                                  : tabRemovalMaterial?.status === 'unavailable' ? txRemoval('materialUnavailable', { reason: tabRemovalMaterial.reason })
                                  : null}
                              </span>
                              <span className="op-hint">{txRemoval('reviewRetention')}</span>
                              <span className="op-hint">{txRemoval('reviewSameSetup')}</span>
                              <div style={{ display: 'flex', gap: 5 }}>
                                <button type="button" className="op-toggle-btn" data-testid="props-contour-tab-removal-create" onClick={createTabRemoval}>{txRemoval('create')}</button>
                                <button type="button" className="op-toggle-btn" data-testid="props-contour-tab-removal-cancel" onClick={cancelTabRemoval}>{txRemoval('cancel')}</button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {op.type === 'chamfer' && (
                <>
                  <div className="props-group" data-testid="props-chamfer-entry-policy" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 0 }}>
                    <div className="props-label" style={{ whiteSpace: 'normal', minWidth: 0 }}>{tx('NewOperationModalBody.Chamfer_entry_policy')}</div>
                    <select
                      className="props-number-input"
                      aria-label={tx('NewOperationModalBody.Chamfer_entry_policy')}
                      value={chamferParams.entryPolicy ?? 'authored'}
                      onChange={e => commitChamferParams({ entryPolicy: e.target.value as 'authored' | 'clear_space' })}
                    >
                      <option value="authored">{tx('NewOperationModalBody.Chamfer_authored_entry')}</option>
                      <option value="clear_space">{tx('NewOperationModalBody.Chamfer_clear_space_entry')}</option>
                    </select>
                    <p className="op-hint" style={{ margin: 0 }}>{tx('NewOperationModalBody.Chamfer_clear_space_description')}</p>
                  </div>
                  <div className="props-group" data-testid="props-chamfer-width">
                    <div className="props-label">{tx('PropertiesPanel.Chamfer_width')}</div>
                    <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <NumericInput
                        className="props-number-input"
                        value={chamferParams.chamferWidth}
                        min={0.05}
                        max={50}
                        step={0.1}
                        units={displayUnits}
                        tooltip={tx('PropertiesPanel.Reference_face_Z_depth_of_the_chamfer_cut_not')}
                        onChange={(chamferWidth) => commitChamferParams({ chamferWidth })}
                      />
                      <span>{unitLabel(displayUnits)}</span>
                    </div>
                  </div>
                  <div className="props-group" data-testid="props-chamfer-tip-offset">
                    <div className="props-label">{tx('PropertiesPanel.Tip_offset')}</div>
                    <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <NumericInput
                        className="props-number-input"
                        value={chamferParams.tipOffset}
                        min={0}
                        max={50}
                        step={0.05}
                        units={displayUnits}
                        tooltip={tx('PropertiesPanel.Adds_Z_depth_beyond_Chamfer_width_0_places_the')}
                        onChange={(tipOffset) => commitChamferParams({ tipOffset })}
                      />
                      <span>{unitLabel(displayUnits)}</span>
                    </div>
                  </div>
                  {/* WO-3021: which modeled chamfer the values came from, and the
                      one line owed when the bit's angle is not the chamfer's. */}
                  {(() => {
                    const record = modeledChamferRecordOf(op.params)
                    const stretch = chamferStretchOf(op.params)
                    if (!record && !stretch) return null
                    const mm = (v: number) => `${fmtDim(v, displayUnits)} ${unitLabel(displayUnits)}`
                    const deg = (d: number) => String(Number(d.toFixed(1)))
                    const note = record ? chamferAngleNote(record, tool?.angleFromAxisDeg) : null
                    return (
                      <div className="props-group" data-testid="props-chamfer-from-model" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 0 }}>
                        {record && <p className="op-hint" style={{ margin: 0 }}>{tx('PropertiesPanel.Modeled_chamfer_source', {
                          p1: mm(record.depthMm), p2: mm(record.topZ), p3: deg(record.angleFromAxisDeg * 2),
                        })}</p>}
                        {/* WO-3021: a chamfer modeled along part of a loop cuts only that stretch. */}
                        {stretch && <p className="op-hint" style={{ margin: 0 }} data-testid="props-chamfer-stretch">{tx('PropertiesPanel.Modeled_chamfer_stretch', {
                          p1: mm(stretch.stretchMm), p2: stretch.loops,
                        })}</p>}
                        {note && (
                          <p className="op-hint op-hint-warn" style={{ margin: 0 }} data-testid="props-chamfer-angle-note">{tx('PropertiesPanel.Modeled_chamfer_angle_note', {
                            p1: deg(note.bitIncludedDeg), p2: deg(note.chamferIncludedDeg), p3: mm(note.depthMm), p4: mm(note.cutWidthMm), p5: mm(note.modeledWidthMm),
                          })}</p>
                        )}
                      </div>
                    )
                  })()}
                </>
              )}
              {op.type === 'engrave' && engraveParams.mode === 'trace' && engraveParams.side === 'center' && (
                // WO-2299: the same stored field the New Operation dialog edits.
                <div className="props-group">
                  <div className="props-label">{tx('PropertiesPanel.Style')}</div>
                  <div className="props-value">
                    <select
                      className="props-number-input"
                      data-testid="props-engrave-style"
                      value={engraveParams.engraveStyle ?? 'plain'}
                      onChange={(event) => commitEngraveParams({
                        engraveStyle: event.target.value as EngraveStyle,
                      })}
                      data-tooltip={tx('PropertiesPanel.Plain_cuts_one_pass_along_the_line_Trochoidal_cuts')}
                    >
                      {(Object.keys(ENGRAVE_STYLE_LABELS) as EngraveStyle[]).map((style) => (
                        <option key={style} value={style}>{tx(`choices.ENGRAVE_STYLE_LABELS.${style}`)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {op.type === 'engrave' && engraveParams.mode === 'trace' && engraveParams.side === 'center'
                && engraveParams.engraveStyle === 'trochoidal' && tool && (() => {
                const troch = resolveTrochoidalGeometry(
                  tool.diameter, engraveParams.trochoidalWidth, engraveParams.trochoidalAdvance)
                const limits = trochoidalFieldLimits(tool.diameter)
                return (
                  <>
                    {numRow(tx('PropertiesPanel.Slot_width'), troch.width,
                      (v) => commitEngraveParams({ trochoidalWidth: v }),
                      { ...limits.width, get title() { return tx('PropertiesPanel.Width_of_the_slot_the_orbits_cut_1_15') } })}
                    {numRow(tx('PropertiesPanel.Advance_per_orbit'), troch.advance,
                      (v) => commitEngraveParams({ trochoidalAdvance: v }),
                      { ...limits.advance, step: 0.1, get title() { return tx('PropertiesPanel.How_far_each_orbit_moves_along_the_line_mm') } })}
                  </>
                )
              })()}
            </>
          )}
          {/* WO-1566: the shank clearance this operation's toolpath keeps
              between the neck, shank or holder and the part or remaining stock
              (WO-1565). The same field the New Operation dialog shows; the
              value rides op.params into the worker payload. */}
          {CLEARANCE_TRIM_OP_TYPES.has(op.type) && (
            <div className="props-group" data-testid="props-shank-clearance">
              <div className="props-label">{tx('PropertiesPanel.Shank_clearance')}</div>
              <div className="props-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <NumericInput
                  className="props-number-input"
                  value={clearanceAllowanceMmOf(op.params)}
                  min={0}
                  step={0.05}
                  units={displayUnits}
                  kind="dim"
                  tooltip={tx('PropertiesPanel.Clearance_kept_between_the_neck_shank_or_holder_and')}
                  ariaLabel={tx('PropertiesPanel.Shank_clearance')}
                  onChange={commitShankClearance}
                />
                <span>{unitLabel(displayUnits)}</span>
              </div>
            </div>
          )}
        </CollapsibleGroup>
      </div>

      {/* P9 sticky primary action row — pinned to the panel bottom so the
          per-op Generate never scrolls out of reach. */}
      {/* CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) --
          sticky panel chrome, PANEL-INTERNAL (docked in the right panel, not
          a canvas overlay). */}
      <div className="props-action-row" data-ui78-sanctioned="">
        <button
          type="button"
          className="props-primary-btn"
          onClick={regenerate}
          disabled={computing || !op.enabled}
          data-tooltip={!op.enabled
            ? tx('PropertiesPanel.Unsuppress_this_operation_before_generating_its_toolpath')
            : camHints.computeRegenerate}
        >
          {computing ? tx('PropertiesPanel.Computing_3') : op.status === 'ready' ? tx('PropertiesPanel.Regenerate') : tx('PropertiesPanel.Generate')}
        </button>
        {/* Cancel is only meaningful for the parallel_3d (3D finish) compute,
            which runs in the cam3d worker with a cooperative abort signal. The
            2.5D ops post to a one-shot worker with no cancel channel, so no
            button is offered there. */}
        {computing && (op.type === 'parallel_3d' || op.type === 'steep_shallow_3d' || op.type === 'scallop_3d' || op.type === 'pencil_3d') && (
          <button
            type="button"
            className="props-btn props-btn-danger"
            style={{ marginTop: 6 }}
            onClick={() => cancelParallel3dCompute(op.id)}
            data-tooltip={tx('PropertiesPanel.Cancel_this_3D_finish_compute')}
            data-testid="props-parallel3d-cancel"
          >{tx('PropertiesPanel.Cancel')}</button>
        )}
        {computing && op.type === 'waterline_3d' && (
          <button
            type="button"
            className="props-btn props-btn-danger"
            style={{ marginTop: 6 }}
            onClick={() => cancelWaterline3dCompute(op.id)}
            data-tooltip={tx('PropertiesPanel.Cancel_this_waterline_compute')}
            data-testid="props-waterline3d-cancel"
          >{tx('PropertiesPanel.Cancel')}</button>
        )}
        {computing && op.type === 'adaptive_3d' && (
          <button
            type="button"
            className="props-btn props-btn-danger"
            style={{ marginTop: 6 }}
            onClick={() => cancelAdaptive3dCompute(op.id)}
            data-tooltip={tx('PropertiesPanel.Cancel_this_3D_rough_compute')}
            data-testid="props-adaptive3d-cancel"
          >{tx('PropertiesPanel.Cancel')}</button>
        )}
      </div>
    </EngraveVcarveFieldHelp>
  )
}
